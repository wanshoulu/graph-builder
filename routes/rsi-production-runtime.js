'use strict';
// Production evidence adapter. The legacy import/authoring tools remain intact;
// they must never supply sandbox scores to this loop or its promotion gates.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { engineRevision } = require('./rsi-engine-revision');
const { TARGETS, METHODS, normalizeOptimizationConfig, makeBundle, assertBundle, assetHash, mutateRuntime,
  parameterMutations, searchMemory, methodRecord, performanceSummary } = require('./rsi-optimization');
const { atomicWrite, diffAssets, caseChanges, usageSummary } = require('./rsi-run-evidence');
const learning = require('./rsi-learning');
const { snapshotBranches, createStageTimer } = require('./rsi-evolution-trace');
const reasoning = require('./rsi-reasoning');
const goalLib = require('./rsi-goal');
const strategyLib = require('./rsi-strategy');
const measurementPolicyLib = require('./rsi-measurement-policy');
const clone = x => x == null ? x : JSON.parse(JSON.stringify(x));
// 策略记忆：幂等折叠（从 evolveRuns/archive 重算），任何时刻都能回答「哪些动作已被证否」。
// 降级时保留上一次成功的摘要（如有），避免丢失 dead-arm 信息导致重复尝试已证否动作。
let lastStrategy = null;
const strategyOf = state => {
  try { lastStrategy = strategyLib.summarize(state); return lastStrategy; }
  catch (e) { console.error('[rsi] 策略折叠失败，降级到上一次已知状态:', e.message); return lastStrategy || strategyLib.summarize({}); }
};
const goalWithRates = (goal, scores, rows, cases, state) => {
  const st = strategyOf(state);
  return goalLib.goalProgress(goal, scores, rows, cases, { rates: st.rates, strategy: st });
};
const summaryProbe = probe => {
  if (!probe) return probe;
  const { results, ...view } = probe;
  return view;
};
const summaryBranch = branch => {
  if (!branch || typeof branch === 'string') return branch;
  const { trainingFeedback, ...view } = branch;
  return { ...view, ...(branch.probe ? { probe: summaryProbe(branch.probe) } : {}) };
};
function summaryRun(run) {
  return { ...run,
    branches: Object.fromEntries(Object.entries(run.branches || {}).map(([id, branch]) => [id, summaryBranch(branch)])),
    rounds: (run.rounds || []).map(round => {
      let reasoning = round.reasoning;
      if (reasoning) {
        const { input, planAttempts, feedback, ...view } = reasoning;
        // 分层指标随摘要返回：界面「本轮策略依据」卡要读它，但 input 里的完整训练证据不能进摘要。
        // 只透传聚合结果（约 2KB/代），没有它前端只能显示"尚无精度对比"。
        const stageMetrics = input?.stageMetrics ? {
          generation: input.generation ?? null,
          overall: input.stageMetrics.overall || null,
          byShape: (input.stageMetrics.byShape || []).slice(0, 4),
          channels: input.stageMetrics.channels || null,
          clarification: input.stageMetrics.clarification || null,
          judge: input.stageMetrics.judge || null,
          summary: input.stageMetrics.summary || null,
          priority: (input.priority || []).slice(0, 3),
        } : null;
        reasoning = { ...view, traceDetailAvailable: !!input, ...(stageMetrics ? { stageMetrics } : {}),
          trials: (view.trials || []).map(trial => ({ ...trial, ...(trial.probe ? { probe: summaryProbe(trial.probe) } : {}) })) };
      }
      return { ...round, ...(reasoning ? { reasoning } : {}), ...(round.candidates ? { candidates: round.candidates.map(summaryBranch) } : {}) };
    }),
  };
}
const same = (a, b) => !!a && !!b && a.engineSha === b.engineSha && a.protoRev === b.protoRev && a.engineMode === b.engineMode;
const hash = x => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
// A6+A2 组合升级（审计 9.4/9.6 首条）：A6 簇扩展把「该澄清没触发」搬成「选项过多」，
// strict 还差最后一公里——必须对抢答/多余选项的竞争意图做 A2 scope_out 收边。
// 模型从不主动提配套 A2，这里依据证据坏例的实测引擎输出自动派生收边部分，
// 与 A6 打包成一个 combo 候选（评测/采纳都按单资产走，不需要模型配合）。
function expandA6Combo(proposal, evidenceRows) {
  if (!proposal || proposal.type !== 'A6_ambiguity_cluster_expand') return proposal;
  const anchor = (proposal.add_utterances || []).find(u => typeof u === 'string' && u.trim());
  if (!anchor) return proposal;
  const byId = new Map((evidenceRows || []).map(r => [r.case_id, r]));
  const expected = new Set();
  const extras = [];
  for (const cid of proposal.evidence_cases || []) {
    const row = byId.get(cid);
    if (!row) continue;
    for (const e of row.expected || []) expected.add(e);
    if (!['clarify_extra_options', 'clarify_not_triggered'].includes(row.resultType)) continue;
    // clarifying 是布尔值，`clarifying || candidates` 会取到 true 导致 .map 崩溃；候选只取 candidates。
    const optSource = (row.predicted && Array.isArray(row.predicted.candidates)) ? row.predicted.candidates : [];
    const options = optSource.map(o => (typeof o === 'string' ? o : o && o.intent_id)).filter(Boolean);
    if (row.resultType === 'clarify_not_triggered' && row.predicted && row.predicted.top1) options.push(row.predicted.top1);
    for (const opt of options) if (!expected.has(opt) && !extras.includes(opt)) extras.push(opt);
  }
  if (!extras.length) return proposal;
  // 收边词必须用核心词（剥掉动作前缀/泛化后缀），不能用整句：
  // 整句『查单子』会被 negativePenalty 通道过宽匹配，把合法多意图题牵连出界
  // （rsi_t101『先查工资单再看看信用卡账单』实测被误伤）。核心词『单子』只命中
  // scope_out 等值排除判据（stripAction(o)===core），窄而准。
  // 循环剥离：『支付的事怎么弄』要剥到『支付』，一次替换只能去一层后缀
  const coreWord = (() => {
    let w = String(anchor || '');
    const head = /^(帮我|请|麻烦|我要|我想|给我)+/;
    const tail = /(一下|下子|的事|怎么弄|怎么弄的|怎么办)$/;
    for (let i = 0; i < 4; i++) {
      const before = w;
      w = w.replace(head, '').replace(tail, '').trim();
      if (w === before) break;
    }
    const mid = /^(查一下|查下|看看|看一下|查查看|查询|查|看|办理|办一下|办|弄一下|弄)+/;
    w = w.replace(mid, '').replace(tail, '').trim();
    return w;
  })();
  const scopeTerm = coreWord.length >= 2 ? coreWord : anchor;
  const parts = [proposal];
  for (const extra of extras.slice(0, 3)) {
    parts.push({ type: 'A2_disambiguation', target: extra, add_scope_out: [scopeTerm],
      motivation: `组合收边：竞争意图对「${scopeTerm}」让位（scope_out 压制多余选项）`,
      evidence_cases: (proposal.evidence_cases || []).slice(0, 4) });
  }
  return { type: 'combo', parts, motivation: proposal.motivation || 'A6 簇扩展 + A2 竞争收边组合', evidence_cases: proposal.evidence_cases };
}
// ===== 焦点分工与提案指纹 =====
// 用户要求：变异/分支要有分工、各有侧重，且单/多/模糊意图同步优化。图谱提案按
// 失败形状分槽：模糊意图走簇声明/澄清/收边，单意图走说法召回与语义描述，多意图
// 走组合覆盖与竞争收边，负例走排除边界——各槽限定算子子集与对应反馈子集。
const GRAPH_FOCUS_SLOTS = [
  { focus: 'ambiguous_cluster', label: '模糊意图：簇声明与澄清边界', ops: ['A6_ambiguity_cluster_expand', 'combo', 'A5_clarify', 'A2_disambiguation'], shapes: ['ambiguous_intent'], families: ['clarification_precision', 'clarification_trigger', 'clarification_coverage', 'clarification_question', 'unnecessary_clarification'] },
  { focus: 'single_intent_recall', label: '单意图：说法召回与语义描述', ops: ['A1_utterance_expand', 'A3_clause_expansion', 'A4_description_rewrite', 'A2_disambiguation'], shapes: ['single_intent'], families: ['recall', 'ranking', 'wrong_label'] },
  { focus: 'multi_intent_compose', label: '多意图：组合覆盖与竞争收边', ops: ['A1_utterance_expand', 'A3_clause_expansion', 'A2_disambiguation', 'A4_description_rewrite'], shapes: ['multi_intent'], families: ['multi_missing', 'multi_extra', 'multi_task_constraints'] },
  { focus: 'negative_boundary', label: '负例边界：排除声明', ops: ['A2_disambiguation', 'A4_description_rewrite'], shapes: ['negative_intent'], families: ['negative_boundary'] },
];
const PROPOSAL_PAYLOAD_KEYS = ['add_utterances', 'add_hints', 'add_scope_out', 'confusable', 'new_description', 'add_clause_views', 'add_clarify_question'];
function proposalPayload(p) {
  const out = {};
  for (const key of PROPOSAL_PAYLOAD_KEYS) {
    const v = p?.[key];
    if (v == null) continue;
    out[key] = Array.isArray(v) ? [...v].sort() : v;
  }
  return out;
}
// 指纹=算子+目标+内容本体。完整资产 hash 会因父代图变化而不同，挡不住「同一提案
// 每代换皮重提」（v5 两轮 8 个候选全是重复 A6 即此因），必须在提案层面去重。
function graphProposalFingerprint(p) {
  if (!p || typeof p !== 'object' || !p.type) return null;
  if (p.type === 'combo') return hash({ op: 'combo', parts: (p.parts || []).map(x => ({ t: x?.type, tg: x?.targets || (x?.target ? [x.target] : []), p: proposalPayload(x || {}) })) });
  return hash({ op: p.type, tg: p.targets || (p.target ? [p.target] : []), p: proposalPayload(p) });
}
function seedProposalFingerprints(state) {
  const set = new Set();
  const add = p => { const fp = graphProposalFingerprint(p); if (fp) set.add(fp); };
  for (const round of state.activeEvolution?.rounds || []) for (const b of round.candidates || []) if (b.proposal?.type) add(b.proposal);
  for (const entry of state.archive || []) if (entry.proposal?.type) add(entry.proposal);
  return set;
}
// 提案字段归一化：模型常把 target 写成 intent_id/意图，把算子写成 A1 或中文名。
// 审计中 agent 发 op:'A1' 被当成非法算子、规则模式提案因空 target 全灭，都是这一类。
const OP_ALIASES = {
  A1: 'A1_utterance_expand', A1_UTTERANCE_EXPAND: 'A1_utterance_expand', UTTERANCE_EXPAND: 'A1_utterance_expand', 补充说法: 'A1_utterance_expand', 说法扩展: 'A1_utterance_expand',
  A2: 'A2_disambiguation', A2_DISAMBIGUATION: 'A2_disambiguation', DISAMBIGUATION: 'A2_disambiguation', 区分线索: 'A2_disambiguation',
  A3: 'A3_clause_expansion', A3_CLAUSE_EXPANSION: 'A3_clause_expansion', CLAUSE_EXPANSION: 'A3_clause_expansion', 子句表达: 'A3_clause_expansion',
  A4: 'A4_description_rewrite', A4_DESCRIPTION_REWRITE: 'A4_description_rewrite', DESCRIPTION_REWRITE: 'A4_description_rewrite', 意图描述: 'A4_description_rewrite', 描述改写: 'A4_description_rewrite',
  A5: 'A5_clarify', A5_CLARIFY: 'A5_clarify', CLARIFY: 'A5_clarify', 澄清问题: 'A5_clarify', 澄清文案: 'A5_clarify',
  A6: 'A6_ambiguity_cluster_expand', A6_AMBIGUITY_CLUSTER_EXPAND: 'A6_ambiguity_cluster_expand', 歧义簇: 'A6_ambiguity_cluster_expand', 歧义簇扩展: 'A6_ambiguity_cluster_expand',
};
function normalizeGraphProposal(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return p;
  const out = { ...p };
  const pick = (...keys) => { for (const k of keys) { const v = out[k]; if (v != null && v !== '' && !(Array.isArray(v) && !v.length)) return v; } return undefined; };
  const rawType = pick('type', 'op', 'operator', 'action', 'operator_type');
  out.type = OP_ALIASES[String(rawType || '').trim().toUpperCase()] || OP_ALIASES[String(rawType || '').trim()] || rawType;
  let target = pick('target', 'intent_id', 'intentId', 'intent', 'target_intent', 'targetIntent', 'node_id', '意图');
  if (target && typeof target === 'object') target = target.intent_id || target.value || target.id;
  // 最后兜底：对象里任意字段出现合法 intent_id 形态，视为目标（模型偶尔把 ID 塞进说明里）
  if (!target || typeof target !== 'string') target = Object.values(out).find(v => typeof v === 'string' && /^intent_[a-z0-9_]{4,}$/.test(v));
  if (typeof target === 'string') out.target = target.trim();
  const ev = pick('evidence_cases', 'evidenceCases', 'cases', 'evidence', 'evidence_case');
  if (ev !== undefined) out.evidence_cases = Array.isArray(ev) ? ev.map(x => typeof x === 'string' ? x : x?.case_id).filter(Boolean) : [ev];
  const map = { add_utterances: ['add_utterances', 'utterances', 'addUtterances', 'scope_in'], add_clause_views: ['add_clause_views', 'clause_views', 'clauseViews'],
    add_hints: ['add_hints', 'hints', 'disambiguation_hints', 'disambiguationHints'], new_description: ['new_description', 'description', 'newDescription'],
    add_clarify_question: ['add_clarify_question', 'clarify_question', 'clarifyQuestion'] };
  // A6 的 targets 数组：兼容 targets/targets_intents/intent_ids 等写法；兜底收集对象里全部 intent_id 形态的字符串。
  if (out.type === 'A6_ambiguity_cluster_expand' && !Array.isArray(out.targets)) {
    let ids = pick('targets', 'targets_intents', 'intent_ids', 'intents', 'cluster');
    if (!Array.isArray(ids)) ids = [];
    ids = ids.map(x => typeof x === 'string' ? x : x?.intent_id || x?.value).filter(Boolean);
    if (!ids.length) ids = Object.values(out).flatMap(v => Array.isArray(v) ? v : [v]).filter(v => typeof v === 'string' && /^intent_[a-z0-9_]{4,}$/.test(v) && v !== out.target);
    out.targets = [...new Set(ids)];
  }
  for (const [key, keys] of Object.entries(map)) {
    const v = pick(...keys);
    if (v !== undefined && out[key] === undefined) out[key] = Array.isArray(v) ? v : key === 'new_description' || key === 'add_clarify_question' ? v : [v];
  }
  // 12-04 多目标 A2 自动展开：计划层常说「对 A、B、C 几个意图执行 A2_disambiguation」，
  // 提案层就写 targets:[...]，而 A2 只认单 target，直接判无效会整代报废（实测 gen1/gen2
  // 连续 propose_fail）。把多目标 A2 展开成 2-3 个不同意图的 A2 子提案组合，既保留模型
  // 意图，也正好走纯 A2 叠加通道去凑够「净修复≥2」门禁。
  if (!out.target && out.type === 'A2_disambiguation') {
    const rawArr = pick('targets', 'targets_intents', 'intent_ids', 'intents') || out.targets;
    const ids = (Array.isArray(rawArr) ? rawArr : []).map(x => typeof x === 'string' ? x : x?.intent_id || x?.value || x?.id).filter(Boolean);
    const distinct = [...new Set(ids)];
    if (distinct.length >= 2) {
      const payload = {};
      for (const k of ['add_hints','add_scope_out','confusable','add_utterances','add_clause_views','new_description','add_clarify_question']) if (out[k] !== undefined) payload[k] = out[k];
      const parts = distinct.slice(0, 3).map(id => ({ type: 'A2_disambiguation', target: id, ...payload,
        motivation: out.motivation, evidence_cases: out.evidence_cases }));
      return { type: 'combo', parts, motivation: out.motivation || '多目标 A2 叠加（单目标算子收到多目标数组后自动展开）', evidence_cases: out.evidence_cases };
    }
  }
  return out;
}
// 从自由文本里抠出第一个括号平衡的 JSON 对象（跳过单引号散文数组）。
function firstJsonObject(text) {
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < s.length; j++) {
      const ch = s[j];
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') { inStr = true; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (!depth) { try { return JSON.parse(s.slice(i, j + 1)); } catch (_) { break; } } }
    }
  }
  return null;
}
// 12-04 结构化指令直采：规划层常把算子参数直接写进 experiment.instruction
//（如 combo: {"parts":[{"operator":"A2_disambiguation","intent_id":...}]}），却把
// experiment.operator 留空。再让变异模型从散文重推一遍，整代都会因契约缺字段报废
//（实测连续两代 propose_fail、0 metricCalls）。能直接从指令解析出结构化提案时，
// 把它作为首个提案交给下游校验，再让变异模型的输出兜底。
function harvestPlanProposal(exp) {
  if (!exp || exp.target !== 'graph') return null;
  const obj = firstJsonObject(exp.instruction);
  if (!obj || typeof obj !== 'object') return null;
  const inner = obj.combo || obj.proposal || obj;
  if (!inner || typeof inner !== 'object') return null;
  const isCombo = Boolean(inner.parts);
  if (!isCombo && !inner.operator && !inner.type && !inner.op) return null;
  const ev = Array.isArray(exp.caseIds) && exp.caseIds.length ? exp.caseIds.slice() : undefined;
  const motivation = String(exp.hypothesis || '').slice(0, 200) || ('按计划' + (exp.id ? ' ' + exp.id : '') + '的结构化指令执行');
  if (isCombo) {
    const parts = inner.parts.map(x => {
      const n = { ...x };
      if (!n.type && x.operator) n.type = x.operator;
      if (!n.target && x.intent_id) n.target = x.intent_id;
      if (!n.motivation) n.motivation = motivation;
      if (!n.evidence_cases && ev) n.evidence_cases = ev;
      return n;
    });
    return { type: 'combo', parts, motivation: inner.motivation || motivation, evidence_cases: inner.evidence_cases || ev };
  }
  const out = { ...inner };
  if (!out.type && inner.operator) out.type = inner.operator;
  if (!out.target && inner.intent_id) out.target = inner.intent_id;
  if (!out.motivation) out.motivation = motivation;
  if (!out.evidence_cases && ev) out.evidence_cases = ev;
  return out;
}
// 12-04 散文 A2 直采：规划层常用「对意图 intent_x 执行 A2_disambiguation：
// add_hints=['...']，add_scope_out=['...']；对意图 intent_y …」这种半结构化散文，
// 变异模型重推时经常把 target 丢掉（实测整代 0 候选）。指令里已经点名了意图 ID 与线索
// 数组时，按「最近一段」切分直接组装纯 A2 组合，仍然要过下游校验。
function harvestProseA2(exp) {
  const instr = typeof exp.instruction === 'string' ? exp.instruction : '';
  if (!instr || !/A2_disambiguation|A2/.test(instr)) return null;
  const idRe = /intent_[a-z0-9_]{4,}/gi;
  const hits = [];
  let m;
  while ((m = idRe.exec(instr))) hits.push({ id: m[0], idx: m.index, end: m.index + m[0].length });
  const uniq = [], seen = new Set();
  for (const h of hits) if (!seen.has(h.id)) { seen.add(h.id); uniq.push(h); }
  if (uniq.length < 2) return null;
  const parts = [];
  for (let i = 0; i < uniq.length; i++) {
    const seg = instr.slice(uniq[i].end, i + 1 < uniq.length ? uniq[i + 1].idx : instr.length);
    const payload = {};
    for (const field of ['add_hints', 'add_scope_out']) {
      const arr = seg.match(new RegExp(field + '\\s*=\\s*\\[([^\\]]*)\\]'));
      if (!arr) continue;
      const vals = arr[1].match(/['"]([^'"]+)['"]/g) || [];
      const list = vals.map(v => v.slice(1, -1).trim()).filter(Boolean);
      if (list.length) payload[field] = list;
    }
    const cm = seg.match(/confusable\s*=\s*['"]?(intent_[a-z0-9_]{4,})/i);
    if (cm) payload.confusable = cm[1];
    if (!payload.add_hints && !payload.add_scope_out && !payload.confusable) continue;
    parts.push({ type: 'A2_disambiguation', target: uniq[i].id, ...payload });
  }
  if (parts.length < 2) return null;
  const ev = Array.isArray(exp.caseIds) && exp.caseIds.length ? exp.caseIds.slice() : undefined;
  const motivation = String(exp.hypothesis || '').slice(0, 200) || ('按计划' + (exp.id ? ' ' + exp.id : '') + '的散文指令执行');
  return { type: 'combo', parts: parts.slice(0, 3).map(p => ({ ...p, motivation, evidence_cases: ev })), motivation, evidence_cases: ev };
}
// 主指标优先；其余维度只做「有界回退」检查，不再要求 20 维全不退（审计 P0-2）。
function trainingBetter(before, after) {
  if (!before?.train || !after?.train || !Number.isFinite(before.train.strict_pct) || !Number.isFinite(after.train.strict_pct)) return false;
  const d = after.train.strict_pct - before.train.strict_pct;
  if (!(d > 0)) return false;
  if (!(after.heldout?.total > 0)) return false;
  const dHeld = after.heldout.strict_pct - before.heldout.strict_pct;
  if (dHeld < -goalLib.toleranceFor(before.heldout.total)) return false;
  for (const shape of ['single_intent', 'multi_intent', 'ambiguous_intent', 'negative_intent']) {
    const b = before.train[shape];
    if (!(b?.total > 0)) continue;
    const a = after.train[shape];
    if (!a || a.total !== b.total) return false;
    if (!Number.isFinite(a.strict_pct) || !Number.isFinite(a.relaxed_pct)) return false;
    if (a.strict_pct < b.strict_pct - goalLib.shapeTolerance(b.total)) return false;
    if (a.relaxed_pct < b.relaxed_pct - goalLib.shapeTolerance(b.total)) return false;
  }
  if (after.train.relaxed_pct < before.train.relaxed_pct - 2) return false;
  return true;
}
function gateCandidate(before, after, rows, regression, opts = {}) {
  return goalLib.gateReport({
    before, after, regression,
    beforeRows: opts.beforeRows || [],
    afterRows: rows || [],
    goal: opts.goal,
    cases: opts.cases || [],
    trainIds: opts.trainIds || [],
  });
}

function recordAdoption(run, entry, version) {
  if (!run) return;
  run.totalAdopted = (run.totalAdopted || 0) + 1;
  run.finalVersion = version; run.adoptedBranch = entry.branchId;
  if (run.branches?.[entry.branchId]) run.branches[entry.branchId].adoptedAs = version;
  const round = run.rounds?.find(r => r.branchIds?.includes(entry.branchId) || r.candidates?.some(b => (typeof b === 'string' ? b : b.id) === entry.branchId));
  if (round) { round.adopted = (round.adopted || 0) + 1; round.adoptedVersions = [...new Set([...(round.adoptedVersions || []), version])]; }
  if (run.status !== 'running') run.status = 'done';
}

function createProductionRuntime(deps) {
  const dir = deps.rsiDir, root = deps.root, artifacts = path.join(dir, 'artifacts');
  const lineageMetadata = new Map();
  let running = false, stopped = false, locked = false, activeTaskId = null, proposerRequests = 0, proposalFingerprints = new Set();
  const activeControllers = new Set(), activeOperations = new Set();
  let deadlineError = null;
  // 状态写入互斥锁（H3）：worker 池并发执行 absorbCandidate 时，load-modify-save 交错会覆盖
  // archive/stats/methodHistory/strategy。用 Promise 链串行化状态写入，保证每次 load→save 原子。
  let stateWriteChain = Promise.resolve();
  const withStateWrite = (fn) => {
    const next = stateWriteChain.then(fn, fn); // 无论上一次成功/失败都继续
    stateWriteChain = next.then(() => undefined, () => undefined);
    return next;
  };
  const abortAll = reason => { for (const controller of activeControllers) controller.abort(reason); };
  function controlled(options, operation) {
    const controller = new AbortController(), parent = options.signal;
    const relay = () => controller.abort(parent.reason || new Error('评测已取消'));
    activeControllers.add(controller);
    parent?.addEventListener('abort', relay, { once: true });
    if (parent?.aborted) relay();
    if (running && (stopped || deadlineError)) controller.abort(deadlineError || new Error('运行已停止'));
    const timeout = Number.isFinite(options.timeoutMs) ? setTimeout(() => controller.abort(new Error(options.timeoutMessage || '生产引擎评测超时')), Math.max(1, options.timeoutMs)) : null;
    const work = (async () => {
      try {
        controller.signal.throwIfAborted();
        const result = await operation(controller.signal);
        controller.signal.throwIfAborted();
        return result;
      } finally {
        clearTimeout(timeout); parent?.removeEventListener('abort', relay); activeControllers.delete(controller);
      }
    })();
    // 硬超时必须能真正结束等待（10-30 审计 P1）：abort 只发信号，底层调用若不监听 signal
    // 就永远不返回，主循环会挂在 await 上；finally 里 Promise.allSettled(activeOperations)
    // 又会等这些挂住的 Promise，导致「时间到」之后仍然无法收尾（实测有一次 maxMinutes=32
    // 却跑了 85 分钟）。这里让「abort」与「实际结果」竞速，超时立刻把异常抛给调用方，
    // 挂住的请求留在后台自行结束，不再阻塞预算与停机判定。
    work.catch(() => {});
    const aborted = new Promise((_, reject) => {
      const fail = () => reject(controller.signal.reason instanceof Error ? controller.signal.reason : new Error(options.timeoutMessage || '生产引擎评测超时'));
      if (controller.signal.aborted) return fail();
      controller.signal.addEventListener('abort', fail, { once: true });
    });
    const pending = Promise.race([work, aborted]);
    // 停机收尾要等「底层调用的清理」完成（评分子进程退出、临时文件删除）：
    // 若登记 race 结果，abort 一触发它就落定，finally 的 allSettled 不再等
    // 底层 work 的收尾（测试实测 cleaned 计数丢失）。登记 work 本体——
    // score 通道外层 controlled 自带硬超时，work 必然在有限时间内落定。
    activeOperations.add(work);
    const cleanup = () => activeOperations.delete(work);
    work.then(cleanup, cleanup);
    return pending;
  }
  let activeAgentTool = null; // Agent 调研工具桥：仅在对应任务 generation 期间开放（/agent/* 端点回调）
  const revision = () => deps.revision ? deps.revision() : engineRevision(childEnv(), root);
  const childEnv = () => ({ ...(deps.childEnv ? deps.childEnv() : process.env), INTENT_ENGINE_CONSUME_DECLARATIONS: '1', RSI_SCORING_MODE: '1' });
  const write = atomicWrite;
  const checkpointFile = (s, id) => {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id || '')) throw new Error('运行 ID 无效');
    const taskId = s.taskId || 'legacy';
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(taskId)) throw new Error('任务 ID 无效');
    return path.join(dir, 'checkpoints', taskId, id + '.json');
  };
  const stop = () => { stopped = true; abortAll(new Error('运行已请求停止')); };
  const freeze = (graph, base, parents = []) => {
    const b = makeBundle(graph, base, parents), file = path.join(artifacts, b.hash + '.json');
    if (fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file));
      if (saved.hash !== b.hash) throw new Error('候选文件与资产指纹不符');
      assertBundle(saved);
    } else write(file, b);
    return b.hash;
  };
  const readAsset = id => {
    if (!/^[a-f0-9]{64}$/.test(id || '')) throw new Error('候选资产指纹无效，需重新评测');
    const bundle = JSON.parse(fs.readFileSync(path.join(artifacts, id + '.json')));
    if (bundle.hash !== id) throw new Error('候选文件与资产指纹不符');
    return assertBundle(bundle);
  };
  const context = (s, engineRev = revision()) => ({ taskId: s.taskId || null, casesSha256: hash(deps.readCases(s)), splitSha256: hash(s.split), engineRev });
  const contextEqual = (a, b) => (a?.taskId || null) === (b?.taskId || null) && a?.casesSha256 === b?.casesSha256 && a?.splitSha256 === b?.splitSha256 && same(a?.engineRev, b?.engineRev);
  const graphOf = s => deps.loadGraph(s.currentVersion, s);
  const fresh = s => s.baseline?.measurement?.confidence === 'stable'
    && s.baseline?.version === s.currentVersion
    && s.baseline?.assetHash === assetHash(graphOf(s))
    && contextEqual(s.baseline.context, context(s));
  const aggregate = rows => {
    const result = deps.aggregate ? deps.aggregate(rows) : { total: rows.length,
      strict_pct: rows.length ? 100 * rows.filter(r => r.strict).length / rows.length : 0,
      relaxed_pct: rows.length ? 100 * rows.reduce((n, r) => n + (r.relaxed || 0), 0) / rows.length : 0 };
    result.performance = performanceSummary(rows);
    return result;
  };
  // 降级判据抽成独立函数：既用于整批作废判断，也用于「只重测降级行」的局部重试。
  const degradedEvidence = evidence => !!(evidence && (evidence.decision?.mode==='degraded_fusion'
    || Object.values(evidence.routes||{}).some(route=>route.status==='error')
    || (evidence.stages||[]).some(stage=>stage.data?.degraded===true)
    || (evidence.segments||[]).some(segment=>degradedEvidence(segment.evidence))));
  const assertComparableEvidence = rows => {
    if ((rows||[]).some(row=>degradedEvidence(row.evidence))) throw new Error('模型或召回通道调用失败/降级，本次测量不作为方案收益或无收益的证据');
  };
  // LLM judge 有温度：同一题两次评测可能翻转（rsi_t014 实测基线自身 3/5 翻转）。
  // repeatVote：对同一图谱评 R 次逐题多数投票，票数平局按「对」计（保守：不给候选白送破坏票）。
  async function scoreRepeat(graph, s, options = {}) {
    const repeats = Math.max(1, Math.min(5, Math.floor(options.repeat || 1)));
    if (repeats === 1) return score(graph, s, options);
    // 投票票间并行：单票墙钟 ≈ 100s（71题/并发4），串行 3 票要 5 分钟，并行只需 1 票时间。
    // 共享同一个 abort 信号，任一票失败即整体失败（成绩无效），符合「投票必须完整」的语义。
    const group = new AbortController();
    const votes = Array.from({ length: repeats }, () => score(graph, s, { ...options, repeat: undefined, signal: group.signal })
      .catch(error => { group.abort(error); throw error; }));
    const settled = await Promise.allSettled(votes);
    const failure = settled.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
    const runs = settled.map(result => result.value);
    const byCase = new Map();
    for (const run of runs) for (const row of run.results) {
      const list = byCase.get(row.case_id) || [];
      list.push(row); byCase.set(row.case_id, list);
    }
    const results = [...byCase.values()].map(list => {
      if (list.length === 1) return list[0];
      const yes = list.filter(r => r.strict).length;
      const win = list.reduce((best, r) => (r.strict === (yes * 2 >= list.length) ? r : best), list[0]);
      const merged = { ...win, strict: yes * 2 >= list.length };
      merged.relaxed = list.reduce((sum, r) => sum + (r.relaxed || 0), 0) / list.length;
      merged.vote = { strictVotes: yes, total: list.length };
      return merged;
    });
    const agg = runs[0].scores; // 结构模板
    const setOf = side => (side === 'train' ? trainSetOf(s) : heldSetOf(s));
    const aggRows = rows => {
      const strict = rows.filter(r => r.strict).length;
      const relaxed = rows.reduce((sum, r) => sum + (r.relaxed || 0), 0);
      const n = rows.length || 1;
      return { total: rows.length, strict_pct: +(100 * strict / n).toFixed(2), relaxed_pct: +(100 * relaxed / n).toFixed(2) };
    };
    const recount = side => {
      const rows = side === 'all' ? results : results.filter(r => setOf(side).has(r.case_id));
      const base = aggRows(rows);
      // 题型分桶必须重建，否则门禁的「题数一致性」检查会把投票结果全部拦下
      for (const shape of ['single_intent', 'multi_intent', 'ambiguous_intent', 'negative_intent']) {
        const sub = rows.filter(r => (r.shape || '') === shape);
        if (sub.length) base[shape] = aggRows(sub);
      }
      return base;
    };
    const scores = { ...agg, all: recount('all'), train: recount('train'), heldout: recount('heldout'),
      engineRev: runs[0].scores.engineRev, performance: runs.at(-1).scores.performance, repeatVotes: repeats };
    return { scores, results, context: runs[0].context };
  }
  const trainSetOf = s => new Set(s.split.train);
  const heldSetOf = s => new Set(s.split.heldout);
  async function score(graph, s, options = {}) {
    return controlled({ ...options, timeoutMs: options.timeoutMs ?? 1800000 }, signal => scoreWithSignal(graph, s, { ...options, signal }));
  }
  async function scoreWithSignal(graph, s, options) {
    const ctx = context(s);
    if (options.context && !contextEqual(ctx, options.context)) throw new Error('题库切分或评测器在运行中发生变化，请重新启动');
    const ids = options.idSubset || options.probeIds || (options.test ? s.split.test : [...s.split.train, ...s.split.heldout]);
    if (options.idSubset && (options.probeIds || options.test)) throw new Error('内部重测不能与其他切分方式同时指定');
    if (options.probeIds && (options.test || ids.length > 8 || ids.some(id => !s.split.train.includes(id)))) throw new Error('探针只能评测最多8道训练题');
    if (!ids?.length || new Set(ids).size !== ids.length) throw new Error('评测切分为空或重叠');
    const caseMap = new Map(deps.readCases(s).map(c => [c.case_id, c]));
    if (ids.some(id => !caseMap.has(id))) throw new Error('题库缺少切分指定的题目');
    if (deps.scoreGraph) {
      const result = await deps.scoreGraph(graph, { ...options, ids, cases: ids.map(id => caseMap.get(id)) });
      if (!same(result.scores?.engineRev, ctx.engineRev)) throw new Error('评分指纹与任务不一致');
      if (!options.allowDegraded) assertComparableEvidence(result.results);
      return { ...result, context: ctx };
    }
    const tag = crypto.randomBytes(10).toString('hex'), tmp = path.join(dir, 'drafts', 'production-' + tag);
    const graphFile = tmp + '-graph.json', casesFile = tmp + '-cases.json', out = tmp + '-out.json';
    write(graphFile, graph); write(casesFile, { version: 2, cases: ids.map(id => caseMap.get(id)) });
    // 评分子进程输出落盘：原来 stdio:'ignore'，长跑时看不到进度与报错，无法诊断
    const scoreLogDir = path.join(dir, 'logs');
    try { fs.mkdirSync(scoreLogDir, { recursive: true }); } catch (_) {}
    const scoreLogFd = fs.openSync(path.join(scoreLogDir, 'score-' + tag + '.log'), 'a');
    try {
      const attempt = () => new Promise((resolve, reject) => {
        const cp = spawn(process.execPath, [path.join(root, 'scripts/rsi-engine-score.js'), `--graph=${graphFile}`,
          `--cases=${path.relative(path.join(root, 'data/rsi'), casesFile)}`, `--out=${out}`,
          `--concurrency=${options.concurrency || 1}`], { cwd: root, env: { ...childEnv(), INTENT_RSI_RUNTIME_GRAPH: graphFile }, stdio: ['ignore', scoreLogFd, scoreLogFd] });
        const abort = () => { cp.kill(); setTimeout(() => { try { cp.kill('SIGKILL'); } catch (_) {} }, 5000); };
        options.signal.addEventListener('abort', abort, { once: true });
        cp.once('error', e => { options.signal.removeEventListener('abort', abort); reject(e); });
        // Wait for stdio/process cleanup before removing the score's temporary files.
        cp.once('close', code => { try { fs.closeSync(scoreLogFd); } catch (_) {}
          try {
          options.signal.removeEventListener('abort', abort);
          options.signal.throwIfAborted();
          const r = JSON.parse(fs.readFileSync(out));
          if (code || r.status !== 'ok') throw new Error('生产引擎未成功完成');
          resolve(r);
        } catch (e) { reject(e); } });
        if (options.signal.aborted) abort();
      });
      const report = await attempt();
      if (!same(report.engineRev, ctx.engineRev) || !same(revision(), ctx.engineRev)) throw new Error('评分期间引擎发生变化');
      const rows = report.rows;
      if (!Array.isArray(rows) || rows.length !== ids.length || new Set(rows.map(r => r.case_id)).size !== ids.length || rows.some(r => !ids.includes(r.case_id) || r.resultType === 'engine_error') || report.engineErrors > 0) throw new Error('生产评测缺题、重复或包含引擎错误');
      let results = rows.map(r => ({ ...r, shape: r.shape, expected: r.expected, predicted: { top1: r.engine_top1,
        clarifying: r.engine_clarifying, candidates: r.engine_candidates, topk: Array.isArray(r.engine_topk) ? r.engine_topk : [] }, predictedSet: r.engine_pred_set }));
      // 局部重测：整批里只有少数行降级时，只重测这几行，不再把整场完整评测作废。
      // 10-30 实跑：754s 的完整评测因个别行降级被整体丢弃，用户只看到「未测量」。
      if (!options.allowDegraded) {
        const bad = results.filter(r => degradedEvidence(r.evidence));
        if (bad.length && bad.length < results.length) {
          const retry = await scoreWithSignal(graph, s, { ...options, idSubset: bad.map(r => r.case_id),
            probeIds: undefined, allowDegraded: true, degradedRetry: 0 });
          const byId = new Map(results.map(r => [r.case_id, r]));
          for (const r of retry.results) byId.set(r.case_id, r);
          results = results.map(r => byId.get(r.case_id));
          const still = results.filter(r => degradedEvidence(r.evidence));
          if (still.length) throw new Error(`模型或召回通道降级：${still.length}/${results.length} 题重测后仍降级（${still.slice(0,3).map(r=>r.case_id).join('、')}），本次测量不作为收益或无收益的证据`);
        } else if (bad.length) {
          throw new Error('模型或召回通道调用失败/降级，本次测量不作为方案收益或无收益的证据');
        }
      }
      const train = new Set(s.split.train), held = new Set(s.split.heldout);
      return { context: ctx, results, execution: report.execution,
        scores: { engineRev: ctx.engineRev, train: aggregate(results.filter(r => train.has(r.case_id))),
          heldout: aggregate(results.filter(r => held.has(r.case_id))), all: aggregate(results) } };
    } finally {
      for (const file of [graphFile, casesFile, out]) { try { fs.unlinkSync(file); } catch (_) {} }
    }
  }
  function addHistory(s, version, reading, ctx = null) {
    s.scoreHistory ||= [];
    s.scoreHistory.push({ version, at: new Date().toISOString(), engineRev: reading.scores.engineRev, scores: clone(reading.scores),
      measurement: clone(reading.measurement), context: reading.context,
      ctx: { ...ctx, casesSha256: reading.context.casesSha256, splitSha256: reading.context.splitSha256 } });
  }
  async function baseline(options = {}) {
    const s = deps.loadState(), graph = graphOf(s), base = s.currentVersion, asset = freeze(graph, base);
    const mode = options.mode || 'stable';
    const repeat = options.repeat ?? measurementPolicyLib.votesFor(mode, options.measurementPolicy);
    // 基线是后续所有门禁比较的锚点，默认三票逐题多数表决；显式 screening
    // 仅供诊断调用，不能成为正式采纳锚点。
    const reading = repeat > 1
      ? await scoreRepeat(graph, s, { ...options, repeat })
      : await score(graph, s, options);
    reading.measurement = measurementPolicyLib.measurementMeta(mode, repeat, repeat);
    const current = deps.loadState();
    if (current.currentVersion !== base || assetHash(graphOf(current)) !== asset || !contextEqual(context(current), reading.context)) throw new Error('评测期间父版本/题库发生变化，未保存成绩');
    // 多路召回精度 + 模型裁决指标：纯离线推导（不调 LLM、不重跑引擎）
    const recallMetrics = deps.computeRecallMetrics ? deps.computeRecallMetrics(reading.results) : null;
    const adjudicationMetrics = deps.computeAdjudicationMetrics ? deps.computeAdjudicationMetrics(reading.results, s.engineParams) : null;
    current.baseline = { version: base, assetHash: asset, context: reading.context, engineRev: reading.scores.engineRev,
      measurement: clone(reading.measurement), scores: reading.scores, results: reading.results, recallMetrics, adjudicationMetrics,
      attributions: deps.attributeResults ? deps.attributeResults(reading.results.filter(r => s.split.train.includes(r.case_id))) : [], at: new Date().toISOString() };
    // 回归保护分账：基线通过的题才真正「保护」，基线即失败的题 quarantine（否则门禁永远过不了）。
    const regIds = Object.keys(current.regression || {}), byCase = new Map(reading.results.map(r => [r.case_id, r]));
    current.regressionStatus = {
      enforced: regIds.filter(id => byCase.get(id)?.strict === true),
      quarantined: regIds.filter(id => byCase.get(id) && !byCase.get(id).strict),
      missing: regIds.filter(id => !byCase.has(id)),
      at: new Date().toISOString(),
    };
    current.baseline.goal = goalWithRates(goalLib.safeGoal(current.goal), reading.scores, reading.results, deps.readCases(current), current);
    addHistory(current, base, reading, { assetHash: asset }); deps.saveState(current);
    return { baseline: current.baseline, split: current.split };
  }
  function adoption(s, e, snapshot) {
    if (e?.status !== 'passed') return { ok: false, reason: '尚未通过有效生产评测' };
    if (s.baseline?.measurement?.confidence !== 'stable') return { ok: false, reason: '当前正式基线不是稳定基线，请先完成三票稳定复测' };
    if (e.measurement?.confidence !== 'stable') return { ok: false, reason: '候选尚未完成稳定重复评测' };
    if (e.confirmation?.confidence !== 'stable' || e.confirmationGate?.passed !== true) return { ok: false, reason: '候选尚未通过独立确认评测' };
    if (e.candidateBaseVersion !== s.currentVersion || e.baseAssetHash !== (snapshot?.assetHash || assetHash(graphOf(s)))) return { ok: false, reason: '父版本或父资产已经变化，请基于当前版本重新评测' };
    if (!contextEqual(e.evaluationContext, snapshot?.ctx || context(s))) return { ok: false, reason: '题库/切分/评测器不同或缺失，旧证据不可采纳' };
    if (!e.engineCheck?.ok || !same(e.engineCheck.engineRev, snapshot?.engineRev || revision())) return { ok: false, reason: '需生产引擎完整资产复核' };
    if (!(snapshot ? snapshot.valid : fresh(s))) return { ok: false, reason: '当前生产基线已过期，请重新测量' };
    if (!trainingBetter(s.baseline?.scores, e.fullScores)) return { ok: false, reason: '未证实训练质量非退化改善，不能仅凭验证涨分或一次延迟波动采纳' };
    try { readAsset(e.candidateHash); } catch (error) { return { ok: false, reason: error.message }; }
    return { ok: true, reason: '同口径完整候选可采纳' };
  }
  async function adopt(id) {
    const s = deps.loadState(), entry = s.archive.find(e => e.id === id), permit = adoption(s, entry);
    if (!permit.ok) throw new Error(permit.reason);
    const graph = readAsset(entry.candidateHash);
    let i = Math.max(0, ...s.versions.map(v => Number(v.version.slice(1)) || 0)) + 1;
    const versionDir = s.taskId ? path.join(dir, 'tasks', s.taskId) : path.join(dir, 'versions');
    while (fs.existsSync(path.join(versionDir, `rsi-graph.v${i}.json`))) i++;
    const version = `v${i}`;
    deps.saveVersion(version, graph, s);
    s.versions.push({ version, parentVersion: s.currentVersion, applied: [id], assetHash: entry.candidateHash,
      changelog: entry.proposal?.motivation || entry.opLabel || '完整候选采纳', at: new Date().toISOString() });
    entry.status = 'adopted'; entry.adoptedAs = version;
    const origin = (s.evolveRuns || []).find(r => r.id === entry.runId) || (s.activeEvolution?.id === entry.runId ? s.activeEvolution : null);
    recordAdoption(origin, entry, version);
    for (const cid of entry.fixedCases || []) (s.regression ||= {})[cid] = { by: id, fixedIn: version };
    s.currentVersion = version; s.baseline = null; s.stats ||= {}; s.stats.adopted = (s.stats.adopted || 0) + 1;
    deps.saveState(s);
    return { entry, currentVersion: version };
  }
  async function mutations(graph, rows, config, s, gen, onError = () => {}) {
    const train = new Set(s.split.train), failures = rows.filter(r => train.has(r.case_id) && !r.strict);
    // A6/combo 的歧义簇成员缺失时，用提案自己引用的训练证据题的期望意图补齐。
    // 只补空值，不覆盖模型给出的 targets；补齐动作作为「调整」留痕，不伪装成模型决策。
    const fillClusterTargets = (p, byId, g, ctxExtra = {}) => {
      const notes = [];
      const nodeIds = new Set((g.intent_nodes || []).map(n => n.identity?.intent_id).filter(Boolean));
      const listFrom = v => (Array.isArray(v) ? v : []);
      // 证据题可能不在本次训练切分里（计划引用了历史坏例），也可能只有一条期望意图。
      // 三种证据源依次补：训练题库 → 全量题库 → 父代实测行的 predicted/澄清选项。
      const caseOf = cid => byId.get(cid) || ctxExtra.allCases?.get(cid) || null;
      const rowOf = cid => ctxExtra.rows?.get(cid) || null;
      const parts = p.type === 'combo' ? (p.parts || []) : [p];
      for (const part of parts) {
        if (!part || part.type !== 'A6_ambiguity_cluster_expand') continue;
        const given = Array.isArray(part.targets) ? part.targets.map(t => String(t || '').trim()).filter(Boolean) : [];
        if (given.length >= 2) continue;
        const ids = [...given];
        const evidenceIds = part.evidence_cases?.length ? part.evidence_cases : (p.evidence_cases || []);
        for (const cid of evidenceIds) {
          const c = caseOf(cid); if (!c) continue;
          for (const raw of (Array.isArray(c.expected) ? c.expected : [])) {
            const id = typeof raw === 'string' ? raw : (raw?.id || raw?.intent_id);
            if (id && nodeIds.has(id) && !ids.includes(id)) ids.push(id);
          }
        }
        // 单条坏例通常只召回一个期望意图，簇成员凑不满 2 个——依次用图谱已声明的
        // confusable_intents、以及引擎实际给出的竞争候选（predicted / 澄清选项）补足。
        // 两者都来自本体声明或引擎实测输出，不是金标反推。
        if (ids.length < 2) {
          for (const id of [...ids]) {
            const node = (g.intent_nodes || []).find(n => n.identity?.intent_id === id);
            for (const other of (node?.semantic_definition?.confusable_intents || [])) {
              const oid = typeof other === 'string' ? other : (other?.intent_id || other?.id);
              if (oid && nodeIds.has(oid) && !ids.includes(oid)) ids.push(oid);
            }
          }
        }
        if (ids.length < 2) {
          for (const cid of evidenceIds) {
            const c = caseOf(cid), row = rowOf(cid);
            const competitors = [
              ...(Array.isArray(c?.predicted) ? c.predicted : []),
              ...listFrom(c?.observations?.clarification?.optionIds),
              ...(Array.isArray(row?.predicted) ? row.predicted : []),
              ...listFrom(row?.observations?.clarification?.optionIds),
            ];
            for (const raw of competitors) {
              const id = typeof raw === 'string' ? raw : (raw?.id || raw?.intent_id);
              if (id && nodeIds.has(id) && !ids.includes(id)) ids.push(id);
            }
          }
        }
        if (ids.length >= 2) { part.targets = ids.slice(0, 6); notes.push(`A6 未给出歧义簇成员，已按证据题的期望意图补齐为 ${part.targets.join('、')}`); }
      }
      return notes;
    };
    // Historical claims of a repair may no longer hold under the current
    // evaluator. Keep their protection, but actually ask search to repair them.
    const protectedFailures = failures.filter(r => Object.hasOwn(s.regression || {}, r.case_id));
    const priorityIds = new Set(protectedFailures.map(r => r.case_id));
    const remaining = failures.filter(r => !priorityIds.has(r.case_id));
    // 反馈席位按「缺口 × 实测可修率」分配：有杠杆的失败族拿更多坏例，已证否的族少占预算。
    const strat = strategyOf(s);
    const weights = Object.fromEntries(strategyLib.allocate(strat, 16).map(q => [q.family, q.seats]));
    const priority = learning.selectTrainingFeedback(protectedFailures, 16, gen, weights)
      .map(r => ({ ...r, repairPriority: 'historical_protection_failed' }));
    const feedback = [...priority, ...learning.selectTrainingFeedback(remaining, 16 - priority.length, gen, weights)]
      .map(r=>({...r,observations:reasoning.observeTrainingRow(r)}));
    if (deps.propose) return deps.propose({ graph: clone(graph), feedback: clone(feedback), config, gen });
    const candidates = [], profile = graph.meta?.rsi_runtime;
    for (const route of config.routes) {
      if (stopped || Date.now() >= (config.deadline || Infinity)) break;
      try {
      if (route.target === 'engine') {
        if (route.experiment) {
          const m={target:'engine',parameters:route.experiment.parameters,motivation:route.experiment.instruction};
          candidates.push({graph:mutateRuntime(graph,m),target:'engine',summary:m.motivation,runtimeMutation:m,method:route.method});
          continue;
        }
        // 澄清类失败占多数时，参数搜索需要一次试多组（二维组合），否则永远走不到
        // graphClusterFirst × clarificationLimit 的联合最优（审计 P0-3）。
        const perGen = Math.max(1, Math.min(8, Number(config.candidatesPerGeneration) || (failures.some(r => r.shape === 'ambiguous_intent') ? 4 : 2)));
        // 用本任务的实测策略记忆排序：被证否的组合不再占用候选位。
        const policy = strategyLib.policyFor(strategyOf(s));
        for (const m of parameterMutations(graph, s.methodHistory || [], gen, feedback, policy).slice(0, perGen)) candidates.push({ graph: mutateRuntime(graph, m), target: 'engine', summary: m.motivation, runtimeMutation: m, method: route.method, armKey: m.armKey });
        continue;
      }
      if (!deps.callLLM) throw new Error('未配置变异提案模型');
      const perGen = Math.max(1, Math.min(8, Number(config.candidatesPerGeneration) || 4));
      const system = `你是训练反馈驱动的意图优化器。只输出JSON数组，最多${perGen}个候选。不准使用验证/最终测试数据。repairPriority=historical_protection_failed的训练坏例是当前门禁仍要求修复的历史保护题，应优先提出可执行修复。输出必须是实际修改内容，禁止返回字段说明、占位文字或与历史重复的方案。优先提出能同时改善多个训练错误的全局性修改（如影响多case的排序规则、多参数联合调优、覆盖多意图的结构调整），而非仅修复单个case的局部规则。如果多个错误共享同一根因，应提出一条覆盖所有同类错误的全局修复。历史提案按「算子+目标+内容」指纹去重，换措辞、拆分或父代图变化都不会绕过指纹拒绝。${config.optimizerInstruction || profile?.optimizerPrompt || ''}${config.userInstruction ? ` 用户本轮优化要求：${config.userInstruction}` : ''}`;
      const instruction = route.target === 'graph'
        ? '按graphOperators描述的真实消费机制，输出完整图谱提案数组。每条包含type、motivation和非空evidence_cases，证据只能引用feedback里的训练题。A1至A5含单个target；A6含targets数组（2至6个现有意图ID），add_utterances写这些意图共享的完整模糊说法。先看errorPatterns中的错误模式聚合：识别哪些错误模式占主导，优先提出能改善多个同类错误的结构性修改。再看observations和evidence：召回榜已有期望意图时，不得把最终选项缺失或过多直接断言成召回不足；区分裁决被跳过、错误排序、歧义未触发、选项缺失、多余选项与问题文案。A5只改文案，不修触发或范围。每次提案只验证一个具体机制，说明预期改变哪个阶段并保护相关明确单意图/复合句。参考recentExperiments已执行的改动与训练变化，禁止换措辞重复无效资产，不编造验证结果；若授权动作无法改变该机制，返回空数组。字段必须是实际修改内容，不能抄写能力说明或占位文本。'
        : route.target === 'optimizer_prompt'
          ? '每条输出text和motivation字符串。text必须是至少40字的、可直接替换优化器系统指令的完整内容，指导下一轮如何定位训练错误、生成实际有效且不重复的候选。结合feedback和methods的失败经验给出具体规则，不是识别器的指令。motivation解释改变了什么搜索策略。不输出component字段，不使用占位说明。'
          : '每条输出component、text和motivation。component必须且只能是judge、shape或boundary之一。text必须是至少40字的、可直接用于该识别阶段的完整指令，分析errorPatterns中的错误模式聚合，优先提出能覆盖多个同类错误的全局判别和排序规则，而非仅修复单个case的局部规则。规则应描述通用判别逻辑（如action_type匹配优先于lexical相似度），不要硬编码特定intent_id或特定query文案。保留其他正确行为。motivation说明对应训练错误与作用机制。不输出字段说明或占位文字。';
      const rejected = (s.activeEvolution?.rounds || []).flatMap(r => r.mutationErrors || [])
        .filter(e => e.target === route.target).slice(-6).map(e => ({ target: e.target, reason: e.reason }));
      const chosen=route.experiment?new Set([...route.experiment.caseIds,...route.experiment.controlCaseIds]):null;
      // 焦点分槽：按失败形状（单意图/多意图/模糊/负例）把反馈分给不同槽位，各槽限定算子子集，
      // 强制单轮内覆盖多种题型与算子类别（属性类/结构边类/歧义簇/引擎参数），而不是全部押在模糊意图+A6上。
      const enriched = failures.map(r => ({ ...r, ...learning.diagnoseError(r), observations: reasoning.observeTrainingRow(r) }));
      // 错误模式聚合统计：让LLM看到全局错误分布，而非只看个别case
      const errorPatternCounts = {};
      enriched.forEach(r => { (r.errorFamilies || (r.errorFamily ? [r.errorFamily] : [])).forEach(f => { errorPatternCounts[f] = (errorPatternCounts[f] || 0) + 1; }); });
      const errorPatternTotal = enriched.length || 1;
      const errorPatternSummary = Object.entries(errorPatternCounts).sort((a, b) => b[1] - a[1]).map(([f, n]) => f + ':' + n + '(' + (100 * n / errorPatternTotal).toFixed(0) + '%)').join(', ');

      const enrichedById = new Map(enriched.map(r => [r.case_id, r]));
      const slotMatch = (slot, r) => slot.shapes.includes(r.shape) || (r.errorFamilies || []).some(f => slot.families.includes(f));
      const focusSlots = route.experiment
        ? [{ focus: 'experiment', label: '模型计划实验', ops: route.experiment.operator ? [route.experiment.operator] : null, shapes: [], families: [], rows: enriched.filter(r => chosen.has(r.case_id)) }]
        : route.target === 'graph'
          ? GRAPH_FOCUS_SLOTS.map(slot => {
              const matched = feedback.filter(r => slotMatch(slot, enrichedById.get(r.case_id) || r));
              const extra = enriched.filter(r => !matched.some(m => m.case_id === r.case_id) && slotMatch(slot, r));
              return { ...slot, rows: [...matched, ...extra].slice(0, 8) };
            }).filter(slot => slot.rows.length).sort((a, b) => b.rows.length - a.rows.length)
          : [{ focus: 'general', label: '全量训练反馈', ops: null, shapes: [], families: [], rows: feedback }];
      if (!focusSlots.length) focusSlots.push({ focus: 'general', label: '全量训练反馈', ops: null, shapes: [], families: [], rows: feedback });
      const duplicateWatch = (s.activeEvolution?.rounds || []).flatMap(r => r.candidates || []).filter(b => b.proposal?.type).slice(-10)
        .map(b => ({ op: b.proposal.type, targets: b.proposal.targets || b.proposal.target, motivation: (b.proposal.motivation || '').slice(0, 80) }));
      // 已证否算子禁区：跨 run 探针≥2次零晋级的算子不再占用执行候选位。
      // 否则 plan 层换机制的意图会被执行层自由选回同一算子——统计反馈在执行层断链（P2-5）。
      const probeStats = {};
      for (const l of (s.probeLedger || [])) if (l.op) { (probeStats[l.op] || (probeStats[l.op] = { probed: 0, promoted: 0 })); probeStats[l.op].probed++; if (l.promoted) probeStats[l.op].promoted++; }
      const deadOps = new Set(Object.entries(probeStats).filter(([, v]) => v.probed >= 2 && !v.promoted).map(([op]) => op));
      // 计划明确指定的算子不受统计禁区否决：模型的实验计划是「本轮要验证什么」的决策，
      // 统计禁区只用于自由选算子时避坑。10-30 实跑中 A6 因历史上全是「缺 targets」这类
      // 配置错误被记入禁区，导致计划里的 4 个 A6 实验全部被静默跳过（0 提案、0 报错），
      // 用户只看到一句「未生成有效实验资产」——图谱通道被永久堵死。
      const plannedOp = route.experiment?.operator || null;
      const bannedOps = new Set([...deadOps].filter(op => op !== plannedOp));
      const slotCap = route.target === 'graph' && !route.experiment ? Math.max(1, Math.min(3, perGen)) : 1;
      let routeCandidates = 0;
      for (const slot of focusSlots.slice(0, slotCap)) {
        if (stopped || Date.now() >= (config.deadline || Infinity) || routeCandidates >= perGen) break;
      const opKeys = Object.keys(reasoning.GRAPH_OPERATORS).filter(op => (!config.ops?.length || config.ops.includes(op)) && (!slot.ops || slot.ops.includes(op)) && !bannedOps.has(op));
      if (route.target === 'graph' && !opKeys.length) {
        // 静默 continue 换成显式留痕：否则「实验没跑」和「模型没提案」在记录里长得一模一样。
        onError({ target: route.target, method: route.method, slot: slot.focus,
          reason: `本轮焦点「${slot.label}」没有可用算子（授权算子为空，或全部被探针统计禁用${bannedOps.size ? `：${[...bannedOps].join('、')}` : ''}），该实验未产出候选` });
        continue;
      }
      const focusNote = route.target === 'graph' ? `本轮焦点：「${slot.label}」，只允许使用算子 ${opKeys.join('、')}。${plannedOp && deadOps.has(plannedOp) ? `${plannedOp} 历史上探针零晋级，但本轮计划要检验新机制，允许使用一次；必须说明与历史失败尝试的机制差异。` : bannedOps.size ? `已证否禁用算子：${[...bannedOps].join('、')}（近期探针多次零收益，不得以任何变体重提）。` : ''}duplicateWatch是近期已提出方案，同算子+同目标+同内容即重复，换措辞或父代图变化都会被指纹拒绝，不得再提；必须换机制或换目标。` : '';
      const slotRows = chosen ? rows.filter(r=>train.has(r.case_id)&&chosen.has(r.case_id)).map(r=>({...r,observations:reasoning.observeTrainingRow(r)})) : slot.rows;
      const messages=[{role:'system',content:system},{role:'user',content:JSON.stringify({instruction:instruction+(focusNote?` ${focusNote}`:''),experiment:route.experiment||null,
        graph:reasoning.compactTrainingGraph(graph,chosen?slotRows:slot.rows),
        graphIdentityIndex:(graph.intent_nodes||[]).map(n=>({intent_id:n.identity?.intent_id,intent_name:n.identity?.intent_name})),
        runtime:profile||{},feedback:slotRows,
        errorPatterns: errorPatternSummary,
        graphOperators:Object.fromEntries(Object.entries(reasoning.GRAPH_OPERATORS).filter(([op])=>opKeys.includes(op))),
        graphProposalFields:Object.fromEntries(Object.entries(reasoning.GRAPH_PROPOSAL_FIELDS).filter(([op])=>opKeys.includes(op))),
        recentExperiments:(s.activeEvolution?.rounds||[]).flatMap(r=>r.candidates||[]).filter(b=>b.target===route.target).slice(-8).map(b=>({id:b.id,status:b.status,proposal:b.proposal,mutation:b.runtimeMutation,trainingChanges:b.trainingFeedback||[],fixes:(b.armFixes||[]).filter(id=>train.has(id)),regressions:(b.armBroken||[]).filter(id=>train.has(id))})),
        duplicateWatch:route.target==='graph'?duplicateWatch:undefined,
        // 传「知识」而非原始记录：哪些算子在本任务有效、哪些已证否、哪些还没试。
        strategy: strategyLib.digest(strategyOf(s)), methods: searchMemory(s.methodHistory||[],route.target),rejected})}];
      let text;
      if(config.modelInvoke) text=await config.modelInvoke('mutation',messages);
      else {proposerRequests++;
        const timeoutMs=Math.max(1,Math.min(120000,(config.deadline||Infinity)-Date.now()));
        text=await controlled({timeoutMs,timeoutMessage:'模型请求超时'},signal=>deps.callLLM(messages,timeoutMs,4000,signal));}
      let proposals;
      try { proposals = deps.extractJsonArray(text); } catch (e) { onError({ target: route.target, method: route.method, slot: slot.focus, reason: `提案解析失败：${e.message}` }); continue; }
      const harvested = route.experiment ? (harvestPlanProposal(route.experiment) || harvestProseA2(route.experiment)) : null;
      if (harvested) proposals = [harvested, ...proposals];
      // 空提案返回必须留痕：10-30 实跑图谱通道连续 3 代「模型主动返回空数组」，执行层只报
      // 「未生成有效实验资产」，规划与用户都看不到真正的失败模式（模型弃权）。
      if(Array.isArray(proposals)&&!proposals.length) onError({ target: route.target, method: route.method, slot: slot.focus,
        reason: route.experiment ? `模型对实验「${route.experiment.id||''}」主动返回空提案数组（判断授权算子无法产生有效改动），未产出任何候选`
          : '模型返回空提案数组（判断授权算子无法产生有效改动）' });
      for (const raw of proposals.slice(0, Math.min(perGen - routeCandidates, route.experiment?.maxCandidates || 3))) {
        try {
        const p = route.target === 'graph' ? normalizeGraphProposal(raw) : raw;
        if (route.target === 'graph') {
          if (!Object.hasOwn(reasoning.GRAPH_OPERATORS,p.type)) throw new Error('模型返回未授权图谱算子');
          if (config.ops?.length && !config.ops.includes(p.type)) throw new Error(`算子 ${p.type} 不在本任务授权算子内`);
          // 纯 A2 叠加是对计划中 A2 实验的合法执行方式（多目标自动展开），不算换算子。
          const pureA2Combo = p.type === 'combo' && Array.isArray(p.parts) && p.parts.length >= 2 && p.parts.every(x => x && x.type === 'A2_disambiguation');
          if (route.experiment?.operator && p.type!==route.experiment.operator && !(route.experiment.operator === 'A2_disambiguation' && pureA2Combo)) throw new Error('提案未执行模型计划中的图谱算子');
          if (slot.ops && !slot.ops.includes(p.type) && !(pureA2Combo && slot.ops.includes('A2_disambiguation'))) throw new Error(`提案算子 ${p.type} 不属于本轮焦点「${slot.label}」`);
          if (!p.evidence_cases?.length || p.evidence_cases.some(id => !(chosen?chosen.has(id):slot.rows.some(r => r.case_id === id)))) throw new Error('提案必须引用本轮提供的训练反馈case_id');
          // Validate the model's actual experiment. Do not silently rewrite its
          // chosen targets from gold labels; the measured experiment must match the plan.
          const byId = new Map(deps.readCases(s).filter(c => train.has(c.case_id)).map(c => [c.case_id, c]));
          const allCasesById = new Map(deps.readCases(s).map(c => [c.case_id, c]));
          const rowById = new Map((rows || []).map(r => [r.case_id, r]));
          // A6 的歧义簇成员只补「完全没给」的情况：模型常只写 add_utterances 而漏 targets，
          // 于是每个簇级提案都被判「缺 targets」——10-30 实跑两代共 4 个 A6 实验全部这样报废。
          // 补齐来源仅限提案自己引用的证据题（期望意图 → 本体 confusable → 实测竞争候选），并留痕，
          // 不改写模型已给出的目标。
          for (const note of fillClusterTargets(p, byId, graph, { allCases: allCasesById, rows: rowById })) onError({ target: route.target, method: route.method, slot: slot.focus, reason: `调整：${note}`, proposal: clone(raw) });
          const error = deps.validateProposal(p, graph, byId);
          if (error) throw new Error(error);
          // 指纹级去重：同算子+同目标+同内容即拒绝，挡住「换措辞重提」的重复循环。
          const fp = graphProposalFingerprint(p);
          if (fp && proposalFingerprints.has(fp)) throw new Error('提案与已提出方案指纹重复（同算子+同目标+同内容）');
          if (fp) proposalFingerprints.add(fp);
          candidates.push({ graph: deps.applyProposal(graph, p).graph, target: 'graph', summary: p.motivation, proposal: p, method: route.method, focus: slot.focus });
          routeCandidates++;
        } else {
          if (typeof p.text !== 'string' || p.text.trim().length < 40 || /^(完整识别指令|完整指令|改动假设|指令内容|your prompt|prompt text|placeholder|todo)[。.!！\s]*$/i.test(p.text.trim())) throw new Error('提示词是占位或缺少有效指令正文，未进入候选评测');
          if (typeof p.motivation !== 'string' || !p.motivation.trim() || p.motivation.trim() === '改动假设') throw new Error('提示词缺少针对训练反馈的具体修复假设');
          if (route.target === 'recognition_prompt' && !['judge','shape','boundary'].includes(p.component)) throw new Error('识别指令必须指定judge、shape或boundary中的一个组件');
          // 组件与计划不一致不再丢弃提案：计划里的 component 只是模型的建议，
          // 提案正文才是被测量的对象。丢弃等于「跑了一个提示词却记成没提案」（10-30 实跑 gen3 E2）。
          if (route.experiment?.component && p.component!==route.experiment.component) onError({ target: route.target, method: route.method, slot: slot.focus,
            reason: `调整：提案组件 ${p.component} 与计划的 ${route.experiment.component} 不一致，按提案实测`, proposal: clone(raw) });
          const m = { ...p, target: route.target };
          candidates.push({ graph: mutateRuntime(graph, m), target: route.target, summary: p.motivation, runtimeMutation: m, method: route.method });
          routeCandidates++;
        }
        } catch (e) { onError({ target: route.target, method: route.method, slot: slot.focus, reason: e.message,proposal:clone(raw) }); }
      }
      }
      } catch (e) { onError({ target: route.target, method: route.method, reason: e.message }); }
    }
    return candidates;
  }
  // ── 运行结论：停机时给用户的「发生了什么 / 为什么 / 下一步做什么」结构化总结 ──
  // 反馈设计问题（10-30 用户反馈）：此前只显示「本轮尚未形成完整精度对比」，既不说清停机原因，
  // 也不指明改进方向是否失效、用户该做什么。结论基于实测记录（branches/trials/mutationErrors），
  // 不引入新的打分口径。
  function buildRunConclusion(run) {
    const branches = Object.values(run.branches || {}).filter(b => b.id !== 'b0' && b.op !== 'root');
    const byTarget = {};
    for (const b of branches) {
      const key = b.target || 'graph';
      const t = byTarget[key] || (byTarget[key] = { target: key, label: TARGETS[key]?.label || key, proposed: 0, probeRejected: 0, diagnostic: 0, measured: 0, alive: 0, gated: 0, adopted: 0, duplicate: 0 });
      t.proposed++;
      if (b.status === 'probe_rejected') t.probeRejected++;
      else if (b.status === 'diagnostic_complete') t.diagnostic++;
      else if (b.status === 'duplicate') t.duplicate++;
      if (b.fullScores) t.measured++;
      if (b.status === 'alive') t.alive++;
      if (b.status === 'gated') t.gated++;
      if (b.status === 'adopted') t.adopted++;
    }
    const attempts = Object.values(byTarget);
    // 探针效果画像：improved=至少一道目标题改善；regressed=出现退化；noEffect=全部无变化（改法未触达机制）
    const probed = branches.filter(b => b.probe);
    const probeStats = { total: probed.length, improved: 0, regressed: 0, noEffect: 0 };
    for (const b of probed) {
      const ch = b.probe.changes || [];
      if (ch.some(c => c.change === 'improved')) probeStats.improved++;
      else if (ch.some(c => c.change === 'regressed')) probeStats.regressed++;
      else probeStats.noEffect++;
    }
    const trials = run.rounds.flatMap(r => (r.reasoning && r.reasoning.trials) || []);
    const generation = {
      failedTrials: trials.filter(t => t.status === 'generation_error').length,
      modelDeclined: trials.filter(t => t.status === 'generation_error' && /空提案数组/.test(t.error || '')).length,
      planErrors: run.rounds.filter(r => r.reasoning && r.reasoning.status === 'error').length,
    };
    // 停机解释：no_improvement 按「改法为什么全部无效」细分，不笼统说“无提升”
    let stopExplanation;
    switch (run.stopReason) {
      case 'goal_reached': stopExplanation = '已达到任务目标精度，按配置正常收工。'; break;
      case 'no_remaining_leverage': stopExplanation = '已实测算子在当前失败题上均无改进杠杆，继续迭代预期收益为零。'; break;
      case 'user_stop': stopExplanation = '用户手动停止，未完成的部分以已完成的实测为准。'; break;
      case 'model_decision': stopExplanation = '模型复盘后判断继续实验无益而主动停止。'; break;
      case 'model_budget': stopExplanation = '模型请求预算耗尽而停止，属预算约束而非方向失败。'; break;
      case 'probe_budget': stopExplanation = '训练探针预算耗尽而停止。'; break;
      case 'metric_budget': stopExplanation = '完整评测预算耗尽而停止。'; break;
      case 'time_budget': stopExplanation = '运行时间预算耗尽而停止。'; break;
      case 'max_generations': stopExplanation = '达到最大代数上限而停止。'; break;
      case 'no_improvement':
        if (probeStats.total > 0 && probeStats.improved === 0 && probeStats.noEffect === probeStats.total)
          stopExplanation = `连续 ${run.noImproveLimit} 代无收益，且全部 ${probeStats.total} 个改法在训练探针上零效果——改动没有触达失败机制，当前改进方向大概率不对，继续同方向变异意义不大。`;
        else if (probeStats.regressed > 0 && probeStats.improved === 0)
          stopExplanation = `连续 ${run.noImproveLimit} 代无收益，${probeStats.regressed} 个改法在探针中把既有正确行为改坏（退化）——当前方向对现有能力有害而非无效。`;
        else
          stopExplanation = `连续 ${run.noImproveLimit} 代无收益：改法有局部变化但均未达到保留标准（改善且零退化）。`;
        break;
      default: stopExplanation = `停止原因：${run.stopReason || '未记录'}。`;
    }
    const adoptedCount = branches.filter(b => b.status === 'adopted').length || run.totalAdopted || 0;
    const headline = `本次运行尝试 ${branches.length} 个改法（${attempts.map(t => `${t.label} ${t.proposed}`).join(' / ') || '无候选'}），` +
      `${probed.length} 个进入训练探针、${attempts.reduce((n, t) => n + t.measured, 0)} 个完成完整评测、${adoptedCount} 个被采纳；` +
      `${run.rounds.length} 代，停机原因：${run.stopReason || '未记录'}。`;
    const directionAssessment = [];
    for (const t of attempts) if (t.proposed > 0 && t.measured === 0)
      directionAssessment.push(`${t.label}通道提出了 ${t.proposed} 个候选但 0 个进入完整评测——该通道本轮未获得任何实测证据。`);
    if (generation.modelDeclined > 0)
      directionAssessment.push(`${generation.modelDeclined} 次实验模型主动放弃提案（返回空数组）——模型认为授权算子无法改变失败机制，可能是授权路径与问题根因不匹配。`);
    if (generation.planErrors > 0)
      directionAssessment.push(`${generation.planErrors} 代模型计划整体校验失败，未产出任何实验——属提案产出故障，不是改进方向被证伪。`);
    if (run.gateEscalationUsed)
      directionAssessment.push('本轮已对 1 个候选强制完整评测（探针连续零变化，样本无区分度）——该成绩是真实测量，可用于判断改动是否真的无效。');
    if (probeStats.total > 0 && probeStats.improved === 0 && probeStats.noEffect === probeStats.total)
      directionAssessment.push('所有改法探针零效果：要么改动未触达失败机制（方向不对），要么探针样本无区分度（门禁失明）——两者需区分后才能决定换方向还是换验证方式。');
    const userActions = [];
    if (attempts.some(t => t.target === 'graph' && t.measured === 0))
      userActions.push('图谱通道从未产出进入评测的候选：检查图谱算子授权与提案提示词是否匹配失败根因，或单独以 targets=["graph"] 重跑一轮验证该通道。');
    if (probeStats.total >= 2 && probeStats.improved === 0 && probeStats.noEffect + probeStats.regressed === probeStats.total)
      userActions.push('训练探针连续无区分：建议扩大探针样本（把同类失败题按题型分层纳入），或在门禁连续零效果时放宽为直接完整评测。');
    if (probeStats.regressed > 0)
      userActions.push('参数/指令类改法导致既有能力退化：建议人工核对当前引擎参数（如 clarificationLimit、graphClusterFirst）是否已被实验偏离默认值。');
    if (generation.planErrors > 0)
      userActions.push(`有 ${generation.planErrors} 代因模型计划格式不合法而整代报废：若反复出现，检查规划提示词与输出契约的匹配度。`);
    if (adoptedCount === 0)
      userActions.push('本轮未采纳任何方案：可调整任务配置（targets、算子授权、预算、无改进轮数上限）后重试，或先人工复核失败题根因再定向实验。');
    return { schema: 1, outcome: run.status, headline, stopReason: run.stopReason || null, stopExplanation,
      attempts, probeStats, generation, directionAssessment, userActions, at: new Date().toISOString() };
  }
  function configOf(opts = {}) {
    if(opts.userInstruction!==undefined&&(typeof opts.userInstruction!=="string"||opts.userInstruction.length>2000))throw new Error("本轮优化要求必须是2000字以内的文本");
    const userInstruction=(opts.userInstruction||"").trim();
    const requested = opts.optimization || { targets: ['graph'] };
    // 预算键校验：未知键直接报错而非静默忽略（曾导致 maxLlmCalls 传参被丢弃仍用默认值跑满预算）。
    // maxLlmCalls 作为 maxModelCalls 的别名兼容（正式键优先）。
    if (requested.budget && typeof requested.budget === 'object') {
      const known = ['maxMetricCalls', 'maxMinutes', 'maxModelCalls', 'maxProbeCalls', 'maxLlmCalls'];
      const unknown = Object.keys(requested.budget).filter(k => !known.includes(k));
      if (unknown.length) throw Object.assign(new Error(`budget 含未知参数：${unknown.join('、')}（合法键：${known.join('、')}，其中 maxLlmCalls 等价于 maxModelCalls）`), { statusCode: 400 });
    }
    const modelCalls = requested.budget?.maxModelCalls ?? requested.maxModelCalls ?? requested.budget?.maxLlmCalls ?? requested.maxLlmCalls;
    const config = normalizeOptimizationConfig({ ...requested, maxMetricCalls: requested.budget?.maxMetricCalls ?? requested.maxMetricCalls,
      maxMinutes: requested.budget?.maxMinutes ?? requested.maxMinutes });
    if (opts.optimization?.allowMerge === true) throw new Error('跨候选融合尚未接入完整验证，本轮请关闭融合');
    config.allowMerge = false;
    config.decisionMode=requested.decisionMode || opts.decisionMode || deps.defaultDecisionMode || (deps.propose?'rules':'model');
    if(!['model','rules','agent'].includes(config.decisionMode)) throw new Error('决策模式必须为model、rules或agent');
    // rules 模式必须有 propose 注入（M1）：否则 line 585 `if(deps.propose)` 恒 false，静默回退 LLM 路径，
    // 提案格式与 rules 契约不符，进化全部 no_adopt。早期报错优于静默失败。
    if (config.decisionMode === 'rules' && typeof deps.propose !== 'function') throw Object.assign(new Error('rules 决策模式需要注入 propose 服务，当前未注入——请检查 createProductionRuntime 调用是否传入 propose'), { statusCode: 400 });
    for(const [key,fallback] of [['maxModelCalls',32],['maxProbeCalls',20]]){
      const n=(key==='maxModelCalls'?modelCalls:(requested.budget?.[key]??requested[key]))??fallback;
      if(!Number.isInteger(n)||n<1||n>1000) throw new Error(`${key}须为1至1000的整数`);
      config.budget[key]=n;
    }
    if (config.branching !== 'path') throw new Error('按错误族划分分支尚未接入，此轮请选择按优化路径分支');
    if (config.routes.some(r => r.target === 'engine' && r.method !== 'parameter_search')) throw new Error('意图引擎目前仅支持参数候选搜索，请选择 parameter_search');
    const measurementPolicy = measurementPolicyLib.normalizePolicy(opts.measurementPolicy || {
      screeningVotes: opts.repeatVotes,
      stableVotes: opts.repeatVotes,
      confirmationVotes: opts.repeatVotes,
    });
    return { ...config, userInstruction, measurementPolicy, repeatVotes: measurementPolicy.stableVotes, ops: opts.ops || [], maxRounds: Math.max(1, Math.min(20, Math.floor(Number(opts.maxRounds)) || 3)),
      noImproveRounds: Math.max(1, Math.min(5, Math.floor(Number(opts.noImproveRounds)) || 2)),
      candidatesPerGeneration: Math.max(1, Math.min(8, Math.floor(Number(opts.candidatesPerGeneration)) || 4)),
      stopOnGoal: opts.stopOnGoal !== false,
      // 探针无区分度时是否允许一次强制完整评测（每轮最多 1 次，用于区分「改动无效」与「探针测不出」）
      // 默认阈值 2：一次运行通常只有 2-4 个候选，阈值 4 等于永不触发——10-30 连续三次运行
      // 以「metricCalls=0」收尾，用户拿不到任何分环节精度对比。第 2 个零变化探针即升级。
      probeEscalation: opts.probeEscalation !== false,
      probeEscalationAfter: Math.max(2, Math.min(12, Math.floor(Number(opts.probeEscalationAfter)) || 2)),
      concurrency: Math.max(1, Math.min(Math.max(1, Math.floor(Number(process.env.RSI_SCORING_MAX_CONCURRENCY)) || 8), Math.floor(Number(opts.scoringConcurrency)) || 1)), strategy: opts.strategy || 'manual' };
  }
  async function evolve(opts = {}, onProgress = () => {}) {
    if (running || locked) throw new Error('已有任务运行中');
    let initial = deps.loadState();
    const savedCheckpoint = opts.resumeRunId ? JSON.parse(fs.readFileSync(checkpointFile(initial, opts.resumeRunId))) : null;
    const config = savedCheckpoint ? {...savedCheckpoint.config,decisionMode:savedCheckpoint.config.decisionMode||'rules'} : configOf(opts);
    if (!['manual', 'best'].includes(config.strategy)) throw new Error('仅支持手动采纳或最终单冠军采纳');
    const fingerprint = hash(config);
    if (opts.commandId && !savedCheckpoint) {
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(opts.commandId)) throw new Error('commandId 无效');
      const existing = [...(initial.evolveRuns || []), initial.activeEvolution].find(r => r?.commandId === opts.commandId);
      if (existing) {
        if (existing.commandFingerprint !== fingerprint) throw new Error('同一 commandId 的配置不同');
        return clone(existing);
      }
    }
    if (savedCheckpoint && (!savedCheckpoint.run.checkpoint?.available || !contextEqual(savedCheckpoint.run.context, context(initial))
      || savedCheckpoint.run.baseVersion !== initial.currentVersion || !fresh(initial))) throw new Error('检查点上下文或父版本已变化/过期，不能续跑');
    running = true; stopped = false; deadlineError = null; activeTaskId = initial.taskId || null;
    proposalFingerprints = seedProposalFingerprints(deps.loadState());
    const segmentStart = Date.now(), clock = createStageTimer();
    let run, pending = null, noGain = 0, calls = 0, readings = new Map(), seen = new Set(), population = ['b0'], count = 0, forcedStage = null;
    let modelStopped=false,modelBudgetReached=false,metricBudgetReached=false,probeBudgetReached=false,probeReadings=[],modelCalls=0,probeCalls=0,goalHit=false,noLeverageStop=null;
    // Reserve synchronously before starting any member of a repeat group. Parallel
    // workers cannot consume a partial group or overbook the remaining budget.
    const reserveMetrics = count => {
      if (stopped || deadlineError || calls + count > config.budget.maxMetricCalls) {
        if (!stopped && !deadlineError) metricBudgetReached = true;
        return false;
      }
      calls += count; return true;
    };
    const assessCandidate = async ({ graph, current, ctx, parentReading, rootReading }) => {
      const gateOptions = { beforeRows: parentReading.results, goal: current.goal,
        cases: deps.readCases(current), trainIds: current.split.train };
      const measure = async mode => {
        const repeat = measurementPolicyLib.votesFor(mode, config.measurementPolicy);
        if (!reserveMetrics(repeat)) return null;
        const reading = await scoreRepeat(graph, deps.loadState(), {
          context: ctx, concurrency: config.concurrency,
          timeoutMs: Math.max(30000, config.deadline - Date.now()), repeat,
        });
        reading.measurement = measurementPolicyLib.measurementMeta(mode, repeat, repeat);
        return reading;
      };
      const judge = reading => {
        const gate = gateCandidate(parentReading.scores, reading.scores, reading.results,
          current.regression, gateOptions);
        const rootGate = gateCandidate(rootReading.scores, reading.scores, reading.results,
          current.regression, { ...gateOptions, beforeRows: rootReading.results });
        return { gate, rootGate, passed: gate.passed && rootGate.passed };
      };

      const screening = await measure('screening');
      if (!screening) return { budgetSkipped: true, reason: '初筛评测预算不足，未启动测量' };
      const screeningDecision = judge(screening);
      if (!screeningDecision.passed) return { reading: screening, measurement: screening.measurement,
        ...screeningDecision, passed: false };

      const stable = await measure('stable');
      if (!stable) return { budgetSkipped: true, reading: screening,
        reason: '稳定重复评测预算不足，未启动测量' };
      const stableDecision = judge(stable);
      if (!stableDecision.passed) return { reading: stable, measurement: stable.measurement,
        ...stableDecision, passed: false };

      const confirmation = await measure('confirmation');
      if (!confirmation) return { budgetSkipped: true, reading: stable, measurement: stable.measurement,
        reason: '采纳确认评测预算不足，候选保持不可采纳' };
      const confirmationDecision = judge(confirmation);
      return {
        reading: stable,
        measurement: stable.measurement,
        confirmation,
        confirmationGate: confirmationDecision.rootGate.passed
          ? confirmationDecision.gate : confirmationDecision.rootGate,
        gate: stableDecision.gate,
        rootGate: stableDecision.rootGate,
        passed: stableDecision.passed && confirmationDecision.passed,
        adoptability: confirmationDecision.passed
          ? { ok: true, reason: '稳定评测与独立确认均通过' }
          : { ok: false, reason: `独立确认未通过：${confirmationDecision.gate.passed ? confirmationDecision.rootGate.reason : confirmationDecision.gate.reason}` },
      };
    };
    let activeElapsedMs = savedCheckpoint?.run.activeElapsedMs || 0;
    proposerRequests = savedCheckpoint?.run.usage?.proposerRequests || 0;
    config.deadline = Date.now() + Math.max(1, config.budget.maxMinutes * 60000 - activeElapsedMs);
    const deadlineTimer=setTimeout(()=>{deadlineError=new Error('运行时间预算耗尽');abortAll(deadlineError);},Math.max(1,config.deadline-Date.now()));
    const send = (step, round, detail) => { clock.mark(step); onProgress({ step, round, detail, runId: run?.id, taskId: activeTaskId, timings: clock.snapshot() }); };
    const publish = () => {
      const current = deps.loadState();
      if ((current.taskId || null) !== activeTaskId) throw new Error('运行任务身份变化，拒绝保存');
      run.timings = clock.snapshot(); run.metricCalls = calls;
      run.activeElapsedMs = activeElapsedMs + Date.now() - segmentStart;
      const newReadings=[...readings].filter(([id])=>id!=='b0'||run.baselineMeasured===true).map(([,value])=>value);
      run.modelCalls=modelCalls;run.probeCalls=probeCalls;
      const usage=usageSummary([...newReadings,...probeReadings],proposerRequests);
      run.usage = { ...usage, ...(!newReadings.length&&!probeReadings.length?{recognizerRequests:0,recognizerTokens:0}:{}),metricCalls:calls,probeCalls,modelCalls,reusedBaseline:run.baselineMeasured===false };
      run.checkpoint = { schema: 1, available: !!run.context && readings.has('b0') && ['running','stopped','error','interrupted'].includes(run.status)
        && (pending || run.rounds.length < config.maxRounds) && calls < config.budget.maxMetricCalls,
        at: new Date().toISOString(), completedGenerations: run.rounds.length };
      write(checkpointFile(current, run.id), { schema: 1, run, pending, config: { ...config }, readings: [...readings], seen: [...seen], population, count, noGain, calls,probeReadings,modelCalls,probeCalls });
      current.activeEvolution = clone({ ...run, rounds: pending ? [...run.rounds, pending] : run.rounds });
      deps.saveState(current);
    };
    const selectRound = (ctx, recovered = false) => {
      const children = pending.branchIds, input = pending.inputBranch, inputReading = readings.get(input), gen = pending.gen;
      for (const c of children) if (run.branches[c].status === 'evaluating') { run.branches[c].status = 'eval_error'; run.branches[c].gateReason = '运行中断，未取得完整评测'; }
      const eligible = children.filter(c => run.branches[c].status === 'alive' && readings.has(c));
      const winners = eligible.filter(c => trainingBetter(inputReading.scores, readings.get(c).scores));
      // 同训练分时以验证集决胜：泛化证据是同分候选的唯一区分信号
      winners.sort((a,b) => readings.get(b).scores.train.strict_pct - readings.get(a).scores.train.strict_pct || readings.get(b).scores.train.relaxed_pct - readings.get(a).scores.train.relaxed_pct || (readings.get(b).scores.heldout?.strict_pct||0) - (readings.get(a).scores.heldout?.strict_pct||0) || (readings.get(b).scores.heldout?.relaxed_pct||0) - (readings.get(a).scores.heldout?.relaxed_pct||0));
      // optimizer_prompt 候选被标记 search_only（不进 alive/eligible），此查找恒 undefined——已移除（L1 死代码）
      const winner = winners[0] || input, improved = winners.length > 0;
      run.champion = winner;
      const pool = [...new Set([...population,...eligible])].filter(c => ![...population,...eligible].some(other => other !== c && trainingBetter(readings.get(c).scores,readings.get(other).scores)));
      population = [winner,...pool.filter(c => c !== winner)].slice(0,3); run.population = [...population];
      for (const c of eligible) if (!population.includes(c)) { run.branches[c].status='pruned'; run.branches[c].gateReason='训练指标未优于本代保留候选'; }
      const searchOnly=children.some(c=>run.branches[c].status==='search_only');
      const output = (children.some(c => readings.has(c)) || searchOnly) ? readings.get(winner)?.scores || null : null;
      const modelResult=pending.reasoning?.status==='error'?'decision_error':searchOnly?'search_updated':children.some(c=>run.branches[c].probe)?'probe_only':null;
      run.rounds.push({ ...pending, phase:'done', recovered, population:[...population], result: stopped ? 'stopped' : improved ? 'improved' : searchOnly ? 'search_updated' : output ? 'no_improve' : modelResult || (children.length ? 'no_evaluations' : pending.mutationErrors.length ? 'propose_fail' : 'no_mutations'),
        proposed:children.length,accepted:children.length,passed:eligible.length,evaluated:children.filter(c=>readings.has(c)).length,
        adopted:0,adoptedVersions:[],champion:winner,outputScores:clone(output),retainedParent:winner===input,
        allStrict:output?.all.strict_pct??null,trainStrict:output?.train.strict_pct??null,heldoutStrict:output?.heldout.strict_pct??null,
        engineRev:ctx.engineRev,improved,candidates:children.map(c=>clone(run.branches[c])) });
      const measured=children.some(c=>run.branches[c].fullScores||run.branches[c].probe);
      pending=null; noGain=improved?0:measured?noGain+1:noGain; publish();
      send('gen_done',gen,improved?`第${gen}代选出 ${winner}，训练完全正确率 ${readings.get(winner).scores.train.strict_pct}%`:`第${gen}代未发现可靠训练改善，保留父代`);
    };
    // 跨代算子漏斗统计：本 run 从 branches 精确统计，历史 run 从持久化 probeLedger 合并
    //（maxRounds=1 的单轮运行也能看到既往算子有效率），注入规划上下文阻止重复押注已被证伪的算子。
    // 10-31 修复两个污染源：
    // ① probeLedger 只在探针「无区分度升级强制完整评测」路径写入（998 行），常规探针从不落账——
    //    63 条历史台账全是 16:00 以后那批强制评测，A2 4 次/engine 13 次「全零」的统计与真实探针记录无关。
    // ② 单题探针时代的零晋级是抽样噪声（每实验只打 1 题），不是机制证否；混合进打包时代的统计
    //    会把图谱/引擎通道整体禁掉（probed≥2 且 promoted=0 → 提示词禁止再提）。历史记录按
    //    提案打包规模分层：单题（caseIds=1）的不计入「证否」统计。
    // 12-04 口径分离：探针晋级（probePromoted）只是训练坏例上的弱信号，不等于通过门禁
    //（fullPassed）。历史台账把 probePromote 记成 promoted，规划模型据此把「探针能提升、
    // 完整评测全被拒」的算子当成高收益继续押注（实测 A2：probed=26/probePromoted=5/
    // 完整评测 0 通过）。探针档与门禁档必须分开喂给规划层，否则统计反馈会自相矛盾。
    const aggregateOperatorStats=()=>{
      const empty=()=>({probed:0,probePromoted:0,fullEvaluated:0,fullPassed:0,gated:0,rejected:0});
      const stats={};
      const bump=(op,key)=>{(stats[op]||(stats[op]=empty()))[key]++;};
      for(const l of (deps.loadState().probeLedger||[])){
        if(l.runId===run.id||!l.op)continue;
        const bundled=(l.caseIds||[]).length>=3;
        if(!bundled)continue; // 1-2 题的旧探针无区分度，不能作为「算子无效」的证据
        bump(l.op,'probed');if(l.promoted)bump(l.op,'probePromoted');else bump(l.op,'rejected');
      }
      // 历史运行的完整评测档：probeLedger 只有探针记录，跨 run 的「过没过门禁」必须
      // 从持久化 branches（op/status/fullScores 都在）里取。否则规划层只看得到本轮门禁战绩，
      // 长程上会被同一批「探针能提升、门禁全拒」的算子反复带偏。
      for(const r of (deps.loadState().evolveRuns||[])){
        if(r.id===run.id)continue;
        for(const b of Object.values(r.branches||{})){
          if(b.method!=='model_experiment'||!b.op||!b.fullScores)continue;
          stats[b.op]||(stats[b.op]=empty());
          bump(b.op,'fullEvaluated');if(b.status==='alive')bump(b.op,'fullPassed');else if(b.status==='gated')bump(b.op,'gated');
        }
      }
      for(const b of Object.values(run.branches)){
        if(b.method!=='model_experiment'||!b.op)continue;
        stats[b.op]||(stats[b.op]=empty());
        if(b.probe){bump(b.op,'probed');if(b.probe.promote)bump(b.op,'probePromoted');}
        if(b.fullScores){bump(b.op,'fullEvaluated');if(b.status==='alive')bump(b.op,'fullPassed');}
        if(b.status==='gated')bump(b.op,'gated');else if(b.status==='probe_rejected'||b.status==='diagnostic_complete')bump(b.op,'rejected');
      }
      return stats;
    };
    // 题目维度的探针历史：模型持续在同一批失败题上相似提案，需要看到被探次数再决策（P2-6）
    const aggregateCaseStats=()=>{
      const stats={};
      for(const l of (deps.loadState().probeLedger||[]))for(const id of (l.caseIds||[])){
        const e=(stats[id]||(stats[id]={probed:0,probePromoted:0}));e.probed++;if(l.promoted)e.probePromoted++;
      }
      return stats;
    };
    const modelInvoke=async(phase,messages)=>{
      if(stopped) throw new Error('运行已停止');
      if(modelCalls>=config.budget.maxModelCalls){modelBudgetReached=true;throw new Error('模型请求预算耗尽');}
      if(Date.now()>=config.deadline) throw new Error('运行时间预算耗尽');
      if(!deps.callLLM) throw new Error('模型决策服务未配置');
      modelCalls++;proposerRequests++;
      run.modelCallsByPhase||={};run.modelCallsByPhase[phase]=(run.modelCallsByPhase[phase]||0)+1;
      publish();
      const timeoutMs=Math.max(1,Math.min(90000,config.deadline-Date.now()));
      return controlled({timeoutMs,timeoutMessage:'模型请求超时'},signal=>deps.callLLM(messages,timeoutMs,phase==='plan'||phase==='plan-repair'?5000:4000,signal));
    };
    const modelGeneration=async(current,ctx,gen,parentIds)=>{
      const state=pending.reasoning={schema:1,mode:'model',status:'planning',contract:'rsi-reasoning-v1',trials:[]};
      const trainIds=current.split.train;
      const input=reasoning.buildReasoningContext({generation:gen,trainIds,targets:config.targets,ops:config.ops,operatorStats:aggregateOperatorStats(),caseStats:aggregateCaseStats(),
        goalTarget:goalLib.safeGoal(current.goal).target,
        parents:parentIds.map(id=>({id,graph:readAsset(run.branches[id].artifactHash),assetHash:run.branches[id].artifactHash,rows:readings.get(id).results})),
        remaining:{modelCalls:config.budget.maxModelCalls-modelCalls,probeCalls:config.budget.maxProbeCalls-probeCalls,metricCalls:config.budget.maxMetricCalls-calls},
        protectedIds:Object.keys(current.regression||{}),
        // 12-04 部分增益台账：净修复>0、零破坏、仅因「净修复≥2」门禁被拒的候选，
        // 它们代表已被实测证明有效的改动，规划层必须优先叠加而不是丢掉。
        partialGains:[...(deps.loadState().evolveRuns||[]).slice(-5).flatMap(r=>r.rounds||[]),...(run.rounds||[])].flatMap(r=>r.candidates||[])
          .filter(b=>{const ap=b.gate&&b.gate.metrics&&b.gate.metrics.allPaired;return b.status==='gated'&&b.gate&&b.gate.verdict==='evidence_insufficient'&&ap&&ap.deltaCases>0&&ap.broken===0;})
          .slice(-4).map(b=>({id:b.id,op:b.op,target:b.target,fixes:((b.probe&&b.probe.changes)||[]).filter(c=>c.change==='improved').map(c=>c.case_id).slice(0,6),broken:0,net:b.gate.metrics.allPaired.deltaCases,proposal:b.proposal})),
        previous:run.rounds.filter(r=>r.reasoning).map(r=>({generation:r.gen,summary:r.reasoning.plan?.summary,...r.reasoning.reflection,error:r.reasoning.error,
          experiments:r.reasoning.plan?.experiments,trials:r.reasoning.feedback?.trials||r.reasoning.trials}))});
      if(config.userInstruction)input.userInstruction=config.userInstruction;
      // 换方向续跑：把强制主攻环节提到 priority 第一位，用后清零（不永久锁定）
      if(forcedStage){const hit=(input.priority||[]).find(p=>p.stage===forcedStage);
        if(hit)input.priority=[hit,...(input.priority||[]).filter(p=>p.stage!==forcedStage)];
        input.forcedStage={stage:forcedStage,reason:`上一环节连续 ${config.noImproveRounds} 代无收益，本轮主攻此环节`};
        forcedStage=null;}
      if(run.searchStrategy) input.searchStrategy={id:run.searchStrategy.id,instruction:run.searchStrategy.text};
      state.input=input;state.inputDigest=hash(input);send('plan',gen,'模型正在依据训练证据诊断并设计实验');publish();
      state.planAttempts=[];
      try{
        const rawPlan=await modelInvoke('plan',[{role:'system',content:reasoning.PLAN_SYSTEM},{role:'user',content:JSON.stringify(input)}]);
        let plan;
        try{plan=reasoning.validatePlan(reasoning.parseObject(rawPlan),input);}
        catch(firstError){
          state.planAttempts.push({output:typeof rawPlan==='string'?rawPlan.slice(0,20000):'',error:firstError.message});
          // 计划自修复轮：把确切校验错误与原始计划发回模型改一次（模型驱动、计入预算、
          // 两次尝试都留痕——不伪造决策，修不好就如实记 error 回退规则搜索）
          send('plan',gen,`模型计划未通过校验（${firstError.message}），正在自修复一次`);publish();
          const repaired=await modelInvoke('plan-repair',[
            {role:'system',content:reasoning.PLAN_REPAIR_SYSTEM},
            {role:'user',content:JSON.stringify({context:input,previousPlan:typeof rawPlan==='string'?rawPlan.slice(0,20000):'',error:firstError.message})}]);
          try{plan=reasoning.validatePlan(reasoning.parseObject(repaired),input);}
          catch(repairError){state.planAttempts.push({output:typeof repaired==='string'?repaired.slice(0,20000):'',error:repairError.message});throw new Error(`${firstError.message}；自修复后仍不合法：${repairError.message}`);}
          state.repair={used:true,firstError:firstError.message};
        }
        state.plan=plan;state.status='planned';publish();
      }catch(e){state.status='error';state.error=e.message;pending.mutationErrors.push({target:'decision',reason:e.message});publish();return;}
      if(state.plan.decision.action==='stop'){modelStopped=true;state.status='stopped';publish();return;}
      for(const experiment of state.plan.experiments){
        if(stopped||Date.now()>=config.deadline||modelBudgetReached)break;
        const parent=experiment.parentId,parentReading=readings.get(parent),route=config.routes.find(r=>r.target===experiment.target);
        const trial={experimentId:experiment.id,hypothesisId:experiment.hypothesisId,parentId:parent,target:experiment.target,status:'generating'};state.trials.push(trial);publish();
        const errors=[];
        const proposed=await mutations(readAsset(run.branches[parent].artifactHash),parentReading.results,
          {...config,routes:[{...route,experiment}],modelInvoke,optimizerInstruction:run.searchStrategy?.text},deps.loadState(),gen,error=>{errors.push(error);pending.mutationErrors.push({...error,parent,experimentId:experiment.id});});
        if(errors.length)trial.generationErrors=errors.map(e=>e.reason);
        if(!proposed.length){trial.status='generation_error';trial.error=errors.map(e=>e.reason).join('；')||'未生成有效实验资产';publish();continue;}
        for(const m of proposed){
          if(stopped)break;
          const cid='b'+(++count),candidateHash=freeze(m.graph,run.baseVersion,[run.branches[parent].artifactHash]);
          const branch={id:cid,parent,parents:[parent],gen,depth:(run.branches[parent].depth||0)+1,op:m.proposal?.type||m.target,target:m.target,method:'model_experiment',summary:m.summary,artifactHash:candidateHash,proposal:clone(m.proposal),runtimeMutation:clone(m.runtimeMutation),status:'evaluating',baseVersion:run.baseVersion,proposalId:run.id+'_'+cid,createdAt:new Date().toISOString(),experimentId:experiment.id,hypothesisId:experiment.hypothesisId};
          run.branches[cid]=branch;pending.branchIds.push(cid);trial.branchIds||=[];trial.branchIds.push(cid);
          if(seen.has(candidateHash)){branch.status='duplicate';branch.gateReason='相同完整资产，未重复测量';trial.status='duplicate';publish();continue;}
          seen.add(candidateHash);
          if(m.target==='optimizer_prompt'){
            branch.status='search_only';branch.searchOnly=true;branch.gateReason='只更新后续搜索指令，未进行识别评测';
            run.searchStrategy={id:cid,text:m.runtimeMutation.text,artifactHash:candidateHash,parentId:parent,gen};trial.status='search_only';publish();continue;
          }
          if(probeCalls>=config.budget.maxProbeCalls){probeBudgetReached=true;branch.status='budget_skipped';trial.status='budget_skipped';publish();break;}
          try{
            const ids=[...new Set([...experiment.caseIds,...experiment.controlCaseIds])];probeCalls++;
            const probeVotes=measurementPolicyLib.votesFor('stable',config.measurementPolicy);
            if(!reserveMetrics(probeVotes)){branch.status='budget_skipped';branch.gateReason='探针投票预算不足';trial.status='budget_skipped';publish();continue;}
            send('probe',gen,`训练探针 ${cid}：${ids.length}题，${probeVotes}票投票，不读取隐藏集`);publish();
            const probe=await scoreRepeat(m.graph,deps.loadState(),{context:ctx,probeIds:ids,concurrency:config.concurrency,timeoutMs:config.deadline-Date.now(),repeat:probeVotes});probeReadings.push(probe);
            branch.probe=reasoning.evaluateProbe(experiment,parentReading.results,probe.results);
            // 探针结果持久化：跨 run 算子有效率统计的数据源（串行化防并发覆盖）
            await withStateWrite(() => {
            const ledgerState=deps.loadState();ledgerState.probeLedger||(ledgerState.probeLedger=[]);ledgerState.probeLedger.push({runId:run.id,branchId:cid,op:branch.op,caseIds:[...experiment.caseIds],promoted:!!branch.probe.promote,at:branch.createdAt});
            if(ledgerState.probeLedger.length>500)ledgerState.probeLedger=ledgerState.probeLedger.slice(-400);
            deps.saveState(ledgerState);
            });
            // trial.probe 只保留最优分支探针：同实验多分支先后评估，后评估不得覆盖已晋级的记录
            if(!trial.probe||(!trial.probe.promote&&branch.probe.promote))trial.probe=clone(branch.probe);
            // 诊断实验探针达标时自动升级为改进实验，留下审计痕迹而非结构性否决
            if(branch.probe.promote&&experiment.kind==='diagnostic'){experiment.kind='improvement';branch.kindUpgrade={from:'diagnostic',to:'improvement',reason:branch.probe.reason};trial.kindUpgrade=clone(branch.kindUpgrade);}
            if(!branch.probe.promote){
              // 探针无区分度升级：连续多个改法在探针上「全部零变化」时，继续用同一批题否决候选
              // 只会把 noImproveLimit 耗尽（10-30 连续 3 次运行 metricCalls=0）。此时允许一次
              // 强制完整评测，把「改动无效」与「探针测不出差异」分开——否则永远没有真实成绩。
              const zeroEffect=(branch.probe.changes||[]).every(c=>c.change==='unchanged');
              run.zeroEffectProbes=zeroEffect?(run.zeroEffectProbes||0)+1:0;
              const escalate=zeroEffect&&experiment.kind!=='diagnostic'&&config.probeEscalation!==false&&!run.gateEscalationUsed&&(run.zeroEffectProbes||0)>=config.probeEscalationAfter;
              if(!escalate){
                branch.status=experiment.kind==='diagnostic'?'diagnostic_complete':'probe_rejected';
                branch.gateReason=branch.probe.reason;
                // trial 已取得更优结果（完整评测/执行错误）时，不被后评估的拒绝分支降级
                if(!['measured','execution_error'].includes(trial.status))trial.status=branch.status;
                publish();continue;
              }
              run.gateEscalationUsed=true;
              branch.gateEscalation={reason:`探针连续 ${run.zeroEffectProbes} 次零变化（样本无区分度），强制进入完整评测以取得真实成绩`,at:new Date().toISOString(),probeReason:branch.probe.reason};
              trial.gateEscalation=clone(branch.gateEscalation);
              send('evaluate',gen,`探针无区分度升级：完整评测 ${cid}（探针连续 ${run.zeroEffectProbes} 次零变化）`);publish();
            }
            if(branch.probe.promote)send('evaluate',gen,`探针通过，完整生产评测 ${cid}`);publish();
            const assessment=await assessCandidate({graph:m.graph,current,ctx,parentReading,rootReading:{scores:current.baseline.scores,results:current.baseline.results}});
            if(assessment.budgetSkipped){branch.status='budget_skipped';branch.gateReason=assessment.reason;trial.status='budget_skipped';publish();continue;}
            const result=assessment.reading,gate=assessment.gate,rootGate=assessment.rootGate;readings.set(cid,result);
            branch.fullScores=result.scores;branch.measurement=clone(assessment.measurement);branch.confirmation=clone(assessment.confirmation?.measurement);branch.confirmationGate=clone(assessment.confirmationGate);branch.gate=clone(gate);branch.adoptability=clone(assessment.adoptability||{ok:false,reason:gate.passed?rootGate.reason:gate.reason});branch.evaluatedAt=new Date().toISOString();branch.engineRev=result.scores.engineRev;branch.scores={trainStrict:result.scores.train.strict_pct,heldoutStrict:result.scores.heldout.strict_pct,allStrict:result.scores.all.strict_pct};
            branch.status=assessment.passed?'alive':'gated';branch.gateReason=assessment.passed?assessment.adoptability.reason:(gate.passed?rootGate.reason:gate.reason);trial.status='measured';
            const latest=deps.loadState(),entry={id:branch.proposalId,taskId:activeTaskId,branchId:cid,runId:run.id,gen,parentBranch:parent,parents:[parent],proposal:clone(m.proposal)||{type:'bundle',target:'',motivation:m.summary},runtimeMutation:clone(m.runtimeMutation),opLabel:TARGETS[m.target]?.label||m.target,createdAt:branch.createdAt,status:branch.status==='alive'?'passed':'gated',candidateHash,candidateBaseVersion:run.baseVersion,baseAssetHash:run.rootAssetHash,evaluationContext:ctx,measurement:clone(assessment.measurement),confirmation:clone(assessment.confirmation?.measurement),confirmationGate:clone(assessment.confirmationGate),adoptability:clone(branch.adoptability),trainScores:result.scores.train,heldoutScores:result.scores.heldout,fullScores:result.scores,baselineAtEval:{version:run.baseVersion,train:current.baseline.scores.train,heldout:current.baseline.scores.heldout},engineCheck:{ok:assessment.passed,engineRev:ctx.engineRev,candidateHash},gate:{...clone(gate),stage:branch.status==='alive'?'passed':'regression',reason:branch.gateReason},fixedCases:result.results.filter(r=>trainIds.includes(r.case_id)&&r.strict&&!current.baseline.results.find(b=>b.case_id===r.case_id)?.strict).map(r=>r.case_id),experimentId:experiment.id,hypothesisId:experiment.hypothesisId};
            latest.archive.unshift(entry);latest.stats||={};latest.stats.evaluated=(latest.stats.evaluated||0)+1;if(entry.status==='passed')latest.stats.passed=(latest.stats.passed||0)+1;
            latest.methodHistory||=[];latest.methodHistory.push(methodRecord({...branch,scores:result.scores,gatePassed:assessment.passed},parentReading.scores,run.id,gen));addHistory(latest,cid,result,{runId:run.id,gen,assetHash:candidateHash});deps.saveState(latest);
          }catch(e){branch.status='eval_error';branch.gateReason=e.message;trial.status='execution_error';trial.error=e.message;}
          pending.candidates=pending.branchIds.map(id=>clone(run.branches[id]));publish();
        }
      }
      state.status='experiments_complete';pending.candidates=pending.branchIds.map(id=>clone(run.branches[id]));publish();
    };
    const reflectGeneration=async(round,current)=>{
      const state=round.reasoning;if(!state?.plan||modelStopped||stopped)return;
      // 每个分支作为独立 trial 进入反射，带变体标注与升级痕迹，避免同实验分支被混叙
      const trials=round.branchIds.map(id=>{const b=run.branches[id];return {id,target:b.target,experimentId:b.experimentId,measurement:b.fullScores?'full_training':b.probe?'training_probe':b.searchOnly?'search_strategy':'unmeasured',executionError:b.status==='eval_error',variant:b.summary?`${b.op||b.target}:${String(b.summary).slice(0,120)}`:null,kindUpgrade:b.kindUpgrade||null,before:readings.get(b.parent)?.results||[],after:readings.get(id)?.results||b.probe?.results||[]};});
      // Generation failures have no branch, but must reach reflection and the
      // next planner so malformed proposals are repaired rather than repeated.
      trials.push(...state.trials.filter(t=>t.status==='generation_error'||t.generationErrors?.length).map(t=>({target:t.target,experimentId:t.experimentId,measurement:'unmeasured',executionError:t.generationErrors?.join('；')||t.error})));
      const input=reasoning.reflectionContext({plan:state.plan,trainIds:current.split.train,trials});
      state.feedback=input;
      state.status='reflecting';send('reflect',round.gen,'模型根据训练实验变化复盘并决定下一步');publish();
      try{
        state.reflection=reasoning.validateReflection(reasoning.parseObject(await modelInvoke('reflection',[{role:'system',content:reasoning.REFLECT_SYSTEM},{role:'user',content:JSON.stringify(input)}])),
          {...state.input,parents:[{cases:current.split.train.map(case_id=>({case_id}))}]},state.plan);
        state.status='complete';if(state.reflection.decision==='stop')modelStopped=true;
      }catch(e){state.status='reflection_error';state.error=e.message;}
      publish();
    };
    try {
      if (savedCheckpoint) {
        run=clone(savedCheckpoint.run); run.status='running'; run.resumeCount=(run.resumeCount||0)+1; run.resumedAt=new Date().toISOString();
        readings=new Map(savedCheckpoint.readings); seen=new Set(savedCheckpoint.seen); population=savedCheckpoint.population; count=savedCheckpoint.count; noGain=savedCheckpoint.noGain; calls=savedCheckpoint.calls; pending=savedCheckpoint.pending;
        probeReadings=savedCheckpoint.probeReadings||[];modelCalls=savedCheckpoint.modelCalls||0;probeCalls=savedCheckpoint.probeCalls||0;
        // 上次中断时停留在生成中的代：如实标记，不留「永远运行中」的记录
        for(const r of run.rounds) if(r.reasoning?.status==='running'){r.reasoning.status='interrupted';r.reasoning.error='服务重启，本代未完成（从检查点恢复后重新执行）';}
        send('resume',run.rounds.length,'从已冻结的评测和父代恢复，不使用终测反馈');
        if (pending) selectRound(run.context,true);
      } else {
        const at=new Date().toISOString();
        run={id:'run_'+crypto.randomBytes(8).toString('hex'),taskId:activeTaskId,at,baseVersion:initial.currentVersion,finalVersion:initial.currentVersion,
          commandId:opts.commandId||null,commandFingerprint:fingerprint,userInstruction:config.userInstruction,optimization:clone(config),scoringConcurrency:config.concurrency,maxRounds:config.maxRounds,noImproveLimit:config.noImproveRounds,
          adoptStrategy:config.strategy+'+multi-branch',multiBranch:true,totalAdopted:0,champion:'b0',status:'running',rounds:[],population:['b0'],branches:{},decisionMode:config.decisionMode,baselineMeasured:false};
        publish(); send('baseline',0,'核对并重新测量当前生产引擎基线');
        if (!fresh(initial)) {
          // 基线不能吃光预算：极小预算（maxMetricCalls=2/3）下降到 1 票，给候选评测留空间；
          // 常规预算（默认 120、adaptive 用例 14）仍是完整 3 票稳定基线。
          const baselineVotes = Math.min(measurementPolicyLib.votesFor('stable', config.measurementPolicy),
            Math.max(1, config.budget.maxMetricCalls - 2));
          if(!reserveMetrics(baselineVotes))throw new Error('稳定基线评测预算不足');
          run.baselineMeasured=true;
          await baseline({mode:'stable',repeat:baselineVotes,measurementPolicy:config.measurementPolicy,
            concurrency:config.concurrency,timeoutMs:config.deadline-Date.now()});
        }
        initial=deps.loadState();
        const ctx=context(initial), rootHash=freeze(graphOf(initial),initial.currentVersion);
        run.context=ctx; run.engineRev=ctx.engineRev; run.rootAssetHash=rootHash;
        run.branches=snapshotBranches({b0:{id:'b0',parent:null,op:'root',depth:0,gen:0,baseVersion:initial.currentVersion,artifactHash:rootHash,scores:initial.baseline.scores,status:'alive'}});
        readings.set('b0',{scores:initial.baseline.scores,results:initial.baseline.results,context:ctx}); seen.add(rootHash);
        initial.rsiConfig={optimization:clone(config),scoringConcurrency:config.concurrency,at}; deps.saveState(initial); publish();
      }
      const s=deps.loadState(),ctx=run.context,rootHash=run.rootAssetHash;
      const exhausted=()=>metricBudgetReached||calls>=config.budget.maxMetricCalls||!!deadlineError||Date.now()>=config.deadline;
      // 候选吸收：freeze→查重→生产评测→门禁→台账（规则/Agent 两条生成路径共用）
      const absorbCandidate=async(gen,parent,m,s,current)=>{
        const cid='b'+(++count),candidateHash=freeze(m.graph,run.baseVersion,[run.branches[parent].artifactHash]);
        const parentRows=readings.get(parent)?.results||[];
        // 生成时就记录「这是哪个动作、打哪个失败族、覆盖几道题」，评测后不再靠猜归因。
        const arm=strategyLib.describeArm({target:m.target||'graph',proposal:m.proposal,runtimeMutation:m.runtimeMutation},
          {familyByCase:strategyLib.familyIndex(parentRows.length?parentRows:(current.baseline?.results||[]))});
        const branch={id:cid,parent,parents:[parent],gen,depth:(run.branches[parent].depth||0)+1,op:m.proposal?.type||m.target||'graph',target:m.target||'graph',method:m.method||'reflective_search',summary:m.summary||'候选改动',artifactHash:candidateHash,proposal:clone(m.proposal),runtimeMutation:clone(m.runtimeMutation),arm,armKey:m.armKey||arm.key,status:'evaluating',baseVersion:run.baseVersion,proposalId:run.id+'_'+cid,createdAt:new Date().toISOString()};
        run.branches[cid]=branch; pending.branchIds.push(cid);
        if(seen.has(candidateHash)){branch.status='duplicate';branch.gateReason='相同完整资产，跳过重复评测';branch.duplicateOf=Object.values(run.branches).find(b=>b.id!==cid&&b.artifactHash===candidateHash)?.id||null;pending.candidates=pending.branchIds.map(c=>clone(run.branches[c]));publish();return;}
        seen.add(candidateHash);
        // 优化器提示词只改变下一轮搜索指令，识别引擎根本不消费它：
        // 规则模式此前仍做完整评测并可能顶替冠军（审计 P1），这里与模型模式对齐。
        if (m.target === 'optimizer_prompt') {
          branch.status = 'search_only'; branch.searchOnly = true;
          branch.gateReason = '只更新后续搜索指令，未进行识别评测';
          run.searchStrategy = { id: cid, text: m.runtimeMutation?.text || '', artifactHash: candidateHash, parentId: parent, gen };
          pending.candidates = pending.branchIds.map(c => clone(run.branches[c])); publish(); return;
        }
        send('evaluate',gen,`生产引擎验证 ${cid}`);pending.phase='evaluate';publish();
        try {
          const assessment=await assessCandidate({graph:m.graph,current,ctx,parentReading:readings.get(parent),rootReading:{scores:s.baseline.scores,results:s.baseline.results}});
          if(assessment.budgetSkipped){branch.status='budget_skipped';branch.gateReason=assessment.reason;pending.candidates=pending.branchIds.map(c=>clone(run.branches[c]));publish();return;}
          const result=assessment.reading,gate=assessment.gate,rootGate=assessment.rootGate;readings.set(cid,result);
          branch.fullScores=result.scores;branch.measurement=clone(assessment.measurement);branch.confirmation=clone(assessment.confirmation?.measurement);
          branch.confirmationGate=clone(assessment.confirmationGate);branch.gate=clone(gate);
          branch.adoptability=clone(assessment.adoptability||{ok:false,reason:gate.passed?rootGate.reason:gate.reason});
          branch.evaluatedAt=new Date().toISOString();branch.scores={trainStrict:result.scores.train.strict_pct,heldoutStrict:result.scores.heldout.strict_pct,allStrict:result.scores.all.strict_pct};branch.engineRev=result.scores.engineRev;branch.status=assessment.passed?'alive':'gated';branch.gateReason=assessment.passed?assessment.adoptability.reason:(gate.passed?rootGate.reason:gate.reason);
          // 状态写入串行化（H3）：并发 worker 的 load-modify-save 会互相覆盖 archive/stats/strategy
          await withStateWrite(() => {
          const latest=deps.loadState();
          const entry={id:branch.proposalId,taskId:activeTaskId,branchId:cid,runId:run.id,gen,parentBranch:parent,parents:[parent],runtimeMutation:clone(m.runtimeMutation),proposal:clone(m.proposal)||{type:'bundle',target:'',motivation:branch.summary},opLabel:TARGETS[branch.target]?.label||'图谱优化',createdAt:branch.createdAt,status:branch.status==='alive'?'passed':'gated',candidateHash,candidateBaseVersion:run.baseVersion,baseAssetHash:rootHash,evaluationContext:ctx,measurement:clone(assessment.measurement),confirmation:clone(assessment.confirmation?.measurement),confirmationGate:clone(assessment.confirmationGate),adoptability:clone(branch.adoptability),trainScores:result.scores.train,heldoutScores:result.scores.heldout,fullScores:result.scores,baselineAtEval:{version:run.baseVersion,train:s.baseline.scores.train,heldout:s.baseline.scores.heldout},engineCheck:{ok:assessment.passed,engineRev:ctx.engineRev,candidateHash,baseAssetHash:rootHash},gate:{...clone(gate),stage:branch.status==='alive'?'passed':'regression',reason:branch.gateReason},fixedCases:result.results.filter(r=>current.split.train.includes(r.case_id)&&r.strict&&!s.baseline.results.find(b=>b.case_id===r.case_id)?.strict).map(r=>r.case_id)};
          latest.archive.unshift(entry);latest.stats||={};latest.stats.evaluated=(latest.stats.evaluated||0)+1;if(entry.status==='passed')latest.stats.passed=(latest.stats.passed||0)+1;
          // 相对父代的修/破（McNemar 口径）才是这个动作的真实效果；相对基线只用于展示。
          const trainSet=new Set(current.split.train), parentById=new Map(parentRows.map(r=>[r.case_id,r]));
          const armFixes=result.results.filter(r=>trainSet.has(r.case_id)&&r.strict&&parentById.get(r.case_id)&&!parentById.get(r.case_id).strict).map(r=>r.case_id);
          const armBroken=result.results.filter(r=>trainSet.has(r.case_id)&&!r.strict&&parentById.get(r.case_id)?.strict).map(r=>r.case_id);
          entry.armFixes=armFixes;entry.armBroken=armBroken;entry.arm=branch.arm;
          branch.armFixes=armFixes;branch.armBroken=armBroken;
          branch.trainingFeedback=result.results.filter(r=>trainSet.has(r.case_id)&&(m.proposal?.evidence_cases?.includes(r.case_id)||armFixes.includes(r.case_id)||armBroken.includes(r.case_id)))
            .map(r=>({case_id:r.case_id,before:reasoning.trainingRow(parentById.get(r.case_id)||{}),after:reasoning.trainingRow(r)}));
          latest.methodHistory||=[];latest.methodHistory.push(methodRecord({...branch,scores:result.scores,gatePassed:assessment.passed},readings.get(parent).scores,run.id,gen));
          // 策略记忆：每测一个候选就重算一次，下一代的排序立即用上（不是等整轮结束）。
          latest.strategy=strategyLib.summarize(latest);
          addHistory(latest,cid,result,{runId:run.id,gen,assetHash:candidateHash});deps.saveState(latest);
          });
        }catch(e){branch.status='eval_error';branch.gateReason=e.message;}
        pending.candidates=pending.branchIds.map(c=>clone(run.branches[c]));publish();
      };
      // ── Agent 模式：rsi-agent（openjiuwen 框架+SKILL+工具）作为规划/提案大脑 ──
      // 闭环保证来自工具反馈而非 prompt 纪律：agent 用 probe_query 反事实探针（草案真应用+引擎复测）
      // 验证后才提交；runtime 保留测量/门禁/采纳权威，服务端测量永不经过模型。
      let agentCtxRef=null;
      const agentUrl=(deps.agentUrl||'').trim().replace(/\/+$/,'');
      const agentInvoke=async payload=>{
        if(!agentUrl)throw new Error('未配置 rsi-agent 服务地址（RSI_AGENT_URL）');
        return controlled({timeoutMs:Math.max(1,Math.min(900000,config.deadline-Date.now())),timeoutMessage:'Agent 任务超时'},async signal=>{
          const r=await fetch(agentUrl+'/v1/tasks/propose',{method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({...payload,tool_ctx:{taskId:payload.taskId,branch:payload.branch}}),signal});
          if(!r.ok)throw new Error(`Agent 服务 HTTP ${r.status}`);
          return await r.json();
        });
      };
      const compactNode=n=>({intent_id:n.identity?.intent_id,intent_name:n.identity?.intent_name,
        utterances:(n.retrieval_profile?.utterance_view||[]).slice(0,10),hints:(n.semantic_definition?.disambiguation_hints||[]).slice(0,8),
        scope_out:(n.semantic_definition?.scope_out||[]).slice(0,8),clause_views:(n.retrieval_profile?.clause_view||[]).slice(0,6),
        description:(n.semantic_definition?.description||'').slice(0,300),confusable:(n.semantic_definition?.confusable_intents||[]).slice(0,6)});
      const probeScoreOnce=async(graph,caseId)=>{
        const remainMs=(config.deadline||Infinity)-Date.now();
        if(remainMs<=2000)throw new Error('运行时间预算已耗尽，探针不可用：请基于已有信息立即提交提案，或返回空提案数组');
        if(probeCalls>=config.budget.maxProbeCalls){probeBudgetReached=true;throw new Error('训练探针预算耗尽');}
        probeCalls++;
        const reading=await score(graph,deps.loadState(),{context:ctx,probeIds:[caseId],concurrency:1,timeoutMs:remainMs});
        probeReadings.push(reading);publish();return reading.results[0];
      };
      const agentProbe=async p=>{
        if(!agentCtxRef)throw new Error('探针上下文不可用');
        const q=String(p.q||'').trim(),target=String(p.target||'').trim();
        if(!q)throw new Error('probe 需要训练题原始 q');
        const original=agentCtxRef.allTrainRows.find(r=>r.query===q&&(!p.caseId||r.case_id===p.caseId));
        if(!original)throw new Error('probe 只能使用当前训练题完整原话，以保留真实题型、期望集合与任务约束；不得用单意图伪金标代替歧义或复合题');
        const base=agentCtxRef.graph;
        if(target&&!(base.intent_nodes||[]).some(n=>n.identity?.intent_id===target))throw new Error('target 意图不在父代图谱：'+target);
        let draft=base;
        const op=p.op||(p.utt?'A1_utterance_expand':'');
        if(op){
          const proposal=normalizeGraphProposal({type:op,target,motivation:'训练案例反事实探针',evidence_cases:[original.case_id],
            ...(p.targets?{targets:Array.isArray(p.targets)?p.targets:String(p.targets).split('||').filter(Boolean)}:{}),
            ...(p.utt?{add_utterances:String(p.utt).split('||').filter(Boolean)}:{}),
            ...(p.hints?{add_hints:String(p.hints).split('||').filter(Boolean)}:{}),
            ...(p.scopeOut?{add_scope_out:String(p.scopeOut).split('||').filter(Boolean)}:{}),
            ...(p.clauses?{add_clause_views:String(p.clauses).split('||').filter(Boolean)}:{}),
            ...(p.desc?{new_description:p.desc}:{}),...(p.clarify?{add_clarify_question:p.clarify}:{})});
          if(!Object.hasOwn(reasoning.GRAPH_OPERATORS,proposal.type)||config.ops.length&&!config.ops.includes(proposal.type))throw new Error('探针算子未授权');
          const probeState=deps.loadState();
          const validation=deps.validateProposal(proposal,base,new Map(deps.readCases(probeState).filter(c=>probeState.split.train.includes(c.case_id)).map(c=>[c.case_id,c])));
          if(validation)throw new Error(validation);
          draft=deps.applyProposal(base,proposal).graph;
        }
        const measured=op?await probeScoreOnce(draft,original.case_id):original;
        const summary=r=>({strict:r.strict===true,relaxed:r.relaxed??null,resultType:r.resultType,clarifying:r.engine_clarifying===true,candidates:r.engine_candidates||[],
          top:r.evidence?.routes?.lexical?.rows||[],observations:reasoning.observeTrainingRow(r)});
        return {query:q,caseId:original.case_id,target,op:op||null,shape:original.shape,expected:original.expected,current:summary(original),draft:summary(measured),
          improved:!original.strict&&(measured.strict===true||Number.isFinite(measured.relaxed)&&measured.relaxed>(original.relaxed||0)),
          scope:'单道训练反事实，不等于完整评测或泛化提升'};
      };
      const agentToolCall=(taskId,tool,params={})=>{
        if(!agentCtxRef||agentCtxRef.taskId!==taskId)throw new Error('Agent 调研上下文不可用（任务不匹配或代次已结束）');
        if(Date.now()>=(config.deadline||Infinity))throw new Error('运行时间预算已耗尽，调研工具已关闭：请基于已有信息立即提交提案，或返回空提案数组');
        const {graph,rows}=agentCtxRef;
        // attributeResults 返回按 count 降序的数组（元素自带 family 字段），不是 map
        const listFamilies=()=>deps.attributeResults(rows)||[];
        if(tool==='weaknesses'){
          return {data:listFamilies().map(f=>({family:f.family,count:f.count,suggested_op:f.suggested_op,note:f.note,samples:f.samples})),
            capabilities:{graphOperators:Object.fromEntries(Object.entries(reasoning.GRAPH_OPERATORS).filter(([op])=>!config.ops.length||config.ops.includes(op)))},
            controls:agentCtxRef.allTrainRows.filter(r=>r.strict).slice(0,8).map(reasoning.trainingRow)};
        }
        if(tool==='badcases'){
          const family=String(params.family||''),limit=Math.min(6,Math.max(1,Number(params.limit)||4));
          const fams=listFamilies();
          const f=fams.find(x=>x.family===family);
          if(!f)throw new Error('未知族 '+family+'，可用：'+fams.map(x=>x.family).join('、'));
          return {data:{family:f.family,count:f.count,suggested_op:f.suggested_op,note:f.note,samples:f.samples.slice(0,limit)}};
        }
        if(tool==='search'){
          const kw=String(params.keyword||'').trim();if(!kw)throw new Error('search 缺少 keyword');
          const hits=(graph.intent_nodes||[]).filter(n=>JSON.stringify([n.identity?.intent_id,n.identity?.intent_name,n.retrieval_profile?.utterance_view]).includes(kw)).slice(0,10)
            .map(n=>({intent_id:n.identity?.intent_id,intent_name:n.identity?.intent_name,utterance_sample:(n.retrieval_profile?.utterance_view||[]).slice(0,4)}));
          return {data:hits};
        }
        if(tool==='intent'){
          const id=String(params.id||'');const n=(graph.intent_nodes||[]).find(x=>x.identity?.intent_id===id);
          if(!n)throw new Error('意图不存在：'+id);
          return {data:compactNode(n)};
        }
        if(tool==='probe')return agentProbe(params);
        throw new Error('未知工具：'+tool);
      };
      const agentGeneration=async(current,ctx,gen,parentIds,s)=>{
        const state=pending.reasoning={schema:1,mode:'agent',status:'running',contract:'rsi-reasoning-v1',trials:[],toolCalls:[]};
        const parent=parentIds[0],parentGraph=readAsset(run.branches[parent].artifactHash);
        const trainSet=new Set(current.split.train);
        const failedRows=(readings.get(parent).results||[]).filter(r=>trainSet.has(r.case_id)&&!r.strict);
        agentCtxRef={taskId:activeTaskId,branch:parent,graph:parentGraph,rows:failedRows,
          allTrainRows:(readings.get(parent).results||[]).filter(r=>trainSet.has(r.case_id))};
        activeAgentTool=(tid,tool,params)=>agentToolCall(tid,tool,params);
        send('plan',gen,`Agent 正在调研训练坏例并对 ${parent} 草案做反事实探针`);publish();
        let resp=null;
        try{
          resp=await agentInvoke({taskId:activeTaskId,branch:parent,context:JSON.stringify({
            goal:'针对训练坏例对当前父代图谱产出整改提案（先调研后提案；probe_query 反事实验证后再提交）',
            userInstruction:config.userInstruction||undefined,
            generation:gen,parentBranch:parent,graphIntents:(parentGraph.intent_nodes||[]).length,
            authorizedOperations:Object.keys(reasoning.GRAPH_OPERATORS).filter(op=>!config.ops.length||config.ops.includes(op)),
            graphOperators:reasoning.GRAPH_OPERATORS,
            previousExperiments:run.rounds.flatMap(r=>r.candidates||[]).slice(-8).map(b=>({proposal:b.proposal,trainingChanges:b.trainingFeedback,fixes:b.armFixes,regressions:b.armBroken})),
            maxProposals:4,probeBudgetEach:3,trainFailureCount:failedRows.length})});
          state.toolCalls=resp.toolCalls||[];
          if(resp.status!=='ok')throw new Error(resp.errorKind==='max_iterations'?'Agent 迭代预算耗尽':(resp.error||'Agent 任务失败'));
          const proposals=deps.extractJsonArray(resp.reply||'').filter(p=>p&&typeof p==='object'&&p.type);
          if(!proposals.length){
            // SKILL 允许 agent 评估后返回 []（附原因行）——这是模型决策不是失败；
            // 但错误字典形式的回复（网关 502 等）必须如实报错
            if(/model call failed|InternalServerError|\b502\b/.test(String(resp.reply||'')))
              throw new Error('模型网关不可用（qwen 上游 502），Agent 未能完成规划；可稍后重试');
            state.plan={summary:'Agent 评估后未提出整改提案',diagnoses:[],experiments:[],decision:{action:'stop',reason:String(resp.reply||'').slice(0,200)}};
            state.status='stopped';publish();return;
          }
          const byId=new Map(deps.readCases(current).filter(c=>trainSet.has(c.case_id)).map(c=>[c.case_id,c]));
          state.plan={summary:`Agent 调研 ${state.toolCalls.length} 次工具后提交 ${proposals.length} 个提案`,diagnoses:[],
            experiments:proposals.map((p,i)=>({id:'a'+(i+1),hypothesisId:'agent',parentId:parent,target:'graph',kind:'improvement',
              caseIds:(p.evidence_cases||[]).slice(0,8),controlCaseIds:[],instruction:String(p.motivation||'').slice(0,300)})),
            decision:{action:'continue',reason:'Agent 模式由预算与无改善轮数收敛'}};
          state.status='planned';publish();
          for(const raw of proposals){
            const p=normalizeGraphProposal(raw);
            if(stopped||exhausted())break;
            const trial={experimentId:'a'+(state.trials.length+1),hypothesisId:'agent',parentId:parent,target:'graph',status:'generating'};
            state.trials.push(trial);publish();
            const before=Object.keys(run.branches).length;
            const error=!Object.hasOwn(reasoning.GRAPH_OPERATORS,p.type)||(config.ops.length&&!config.ops.includes(p.type))?'Agent 提案算子未授权':
              !p.evidence_cases?.length||p.evidence_cases.some(id=>!trainSet.has(id))?'Agent 提案只能引用当前训练案例':deps.validateProposal(p,parentGraph,byId);
            if(error){trial.status='generation_error';trial.error=error;pending.mutationErrors.push({target:p.type||'graph',reason:error});publish();continue;}
            const m={graph:deps.applyProposal(parentGraph,p).graph,target:'graph',summary:p.motivation,proposal:p,method:'agent_propose'};
            await absorbCandidate(gen,parent,m,s,current);
            const created=Object.keys(run.branches).slice(before).map(id=>run.branches[id]);
            const main=created.find(b=>b.status!=='duplicate')||created[0];
            if(!main){trial.status='generation_error';trial.error='提案未产生分支';}
            else{trial.branchIds=created.map(b=>b.id);
              trial.status=main.status==='duplicate'?'duplicate':main.fullScores?'measured':(main.status==='eval_error'?'execution_error':'submitted');
              if(main.status==='eval_error')trial.error=main.gateReason;}
            publish();
          }
          if(!state.trials.length){state.status='error';state.error='Agent 未提交任何可校验提案';}
          else state.status='complete';
        }catch(e){state.status='error';state.error=e.message;pending.mutationErrors.push({target:'decision',reason:e.message});publish();return;}
        finally{activeAgentTool=null;agentCtxRef=null;}
      };
      // 未达标却连续无收益时，如果短板表里还有没攻过的环节，就换方向继续，而不是停机。
      // 依据：priority 已按「修好能救回几题」排序。同一环节连续失败只证明该环节的某个机制无效，
      // 不能推出其他环节也没救——此前 3 次运行都是在这里直接停机，把预算耗在同一条死路上。
      let generationLimit=config.maxRounds,forcedExtensionUsed=false;
      const switchStage=gen=>{
        if(noGain<config.noImproveRounds||stopped||exhausted())return false;
        const pri=(pending?.reasoning?.input?.priority)||(run.rounds.at(-1)?.reasoning?.input?.priority)||[];
        const attacked=new Set(run.rounds.flatMap(r=>((r.reasoning?.plan?.experiments)||[]).map(e=>e.fixesStage).filter(Boolean)));
        const next=pri.find(p=>p.stage!=='diagnostic'&&!attacked.has(p.stage));
        if(!next)return false;
        forcedStage=next.stage;noGain=0;
        if(gen>=generationLimit&&!forcedExtensionUsed){generationLimit++;forcedExtensionUsed=true;}
        send('strategy',gen,`连续 ${config.noImproveRounds} 代无收益，但短板表仍有未攻环节：${next.label}（${next.caseCount} 题，约 ${next.gainPts}pp），自动切换主攻方向继续`);
        publish();return true;
      };
      for(let gen=run.rounds.length+1;gen<=generationLimit&&!stopped&&!exhausted();gen++) {
        const current=deps.loadState();
        if(current.currentVersion!==run.baseVersion||assetHash(graphOf(current))!==rootHash||!contextEqual(ctx,context(current))) throw new Error('正式版本或评测协议变化，禁止跨上下文继续');
        // 达标即停：目标不是「一直涨」，而是「到线」。已达标就不再消耗评测预算。
        const reached=()=>{const g=goalLib.safeGoal(current.goal);const sc=readings.get(run.champion)?.scores;return !!(sc&&Number.isFinite(sc.all?.strict_pct)&&sc.all.strict_pct>=g.target);};
        if(config.stopOnGoal!==false&&current.goal&&reached()){goalHit=true;send('goal',gen,`已达标：当前 ${readings.get(run.champion).scores.all.strict_pct}% ≥ 目标 ${goalLib.safeGoal(current.goal).target}%`);break;}
        const input=run.champion,parentIds=config.parentPolicy==='pareto_population'?[...population]:[input];
        pending={gen,round:gen,inputBranch:input,inputBranches:parentIds,inputScores:clone(readings.get(input).scores),phase:'mutate',result:'running',candidates:[],branchIds:[],mutationErrors:[],outputScores:null};
        publish(); send('mutate',gen,`第${gen}代从已验证父代生成候选`);
        if(config.decisionMode==='model'){
          await modelGeneration(current,ctx,gen,parentIds);
          send('select',gen,'程序执行实际评分与保护门禁，模型不修改成绩');selectRound(ctx);
          await reflectGeneration(run.rounds.at(-1),current);
          if(noGain>=config.noImproveRounds&&switchStage(gen)){modelStopped=false;continue;}
          if(modelStopped||modelBudgetReached||probeBudgetReached)break;
          if(noGain>=config.noImproveRounds)break;
          if(config.stopOnGoal!==false&&current.goal&&(()=>{const g=goalLib.safeGoal(current.goal);const sc=readings.get(run.champion)?.scores;return !!(sc&&sc.all?.strict_pct>=g.target);})()){goalHit=true;break;}
        if(config.stopOnNoLeverage!==false&&noGain>=1){const lev=strategyLib.noLeverage(strategyOf(deps.loadState()));if(lev.exhausted){noLeverageStop=lev.reason;send('select',gen,`停止：${lev.reason}`);break;}}
          continue;
        }
        if(config.decisionMode==='agent'&&agentUrl){
          await agentGeneration(current,ctx,gen,parentIds,s);
          send('select',gen,'程序执行实际评分与保护门禁，Agent 提案不修改成绩');selectRound(ctx);
          if(noGain>=config.noImproveRounds){if(switchStage(gen))continue;break;}
          if(config.stopOnGoal!==false&&current.goal&&(()=>{const g=goalLib.safeGoal(current.goal);const sc=readings.get(run.champion)?.scores;return !!(sc&&sc.all?.strict_pct>=g.target);})()){goalHit=true;break;}
        if(config.stopOnNoLeverage!==false&&noGain>=1){const lev=strategyLib.noLeverage(strategyOf(deps.loadState()));if(lev.exhausted){noLeverageStop=lev.reason;send('select',gen,`停止：${lev.reason}`);break;}}
          continue;
        }
        for(const parent of parentIds) {
          if(stopped||exhausted()) break;
          const recordError=error=>{pending.mutationErrors.push({...error,parent});send('mutate_error',gen,`${parent} / ${error.target||'变异'}：${error.reason}`);publish();};
          let proposed;
          try { proposed=await mutations(readAsset(run.branches[parent].artifactHash),readings.get(parent).results,config,deps.loadState(),gen,recordError); }
          catch(e){recordError({reason:e.message});continue;}
          // 候选间并行评测：候选彼此独立，串行只增加墙钟（每候选 ~100s，4 候选串行 = 7 分钟）。
          // 用信号量限流到 scoringConcurrency，避免 LLM 请求风暴；失败互不影响（各自的 try 在 absorb 内）。
          const tasks=proposed.map(m=>({m,parent}));
          const limit=Math.max(1,config.concurrency||1);
          let idx=0;
          const worker=async()=>{ while(!stopped&&!exhausted()){ const i=idx++; if(i>=tasks.length)break; await absorbCandidate(gen,tasks[i].parent,tasks[i].m,s,current); } };
          const workers=await Promise.allSettled(Array.from({length:Math.min(limit,tasks.length)},worker));
          const failure=workers.find(result=>result.status==='rejected');if(failure)throw failure.reason;
        }
        send('select',gen,'主指标 + 有界回退 + 配对检验筛选；验证集仅作否决');selectRound(ctx);
        if(noGain>=config.noImproveRounds){if(switchStage(gen))continue;break;}
        if(config.stopOnGoal!==false&&current.goal&&(()=>{const g=goalLib.safeGoal(current.goal);const sc=readings.get(run.champion)?.scores;return !!(sc&&sc.all?.strict_pct>=g.target);})()){goalHit=true;break;}
        if(config.stopOnNoLeverage!==false&&noGain>=1){const lev=strategyLib.noLeverage(strategyOf(deps.loadState()));if(lev.exhausted){noLeverageStop=lev.reason;break;}}
      }
      run.status=goalHit?'done':stopped?'stopped':run.champion==='b0'?'no_adopt':'awaiting_human';
      run.stopReason=goalHit?'goal_reached':noLeverageStop?'no_remaining_leverage':stopped?'user_stop':modelStopped?'model_decision':modelBudgetReached?'model_budget':probeBudgetReached?'probe_budget':metricBudgetReached||calls>=config.budget.maxMetricCalls?'metric_budget':deadlineError||Date.now()>=config.deadline?'time_budget':noGain>=config.noImproveRounds?'no_improvement':'max_generations';
      if(!stopped&&config.strategy==='best'&&run.champion!=='b0'&&trainingBetter(s.baseline.scores,readings.get(run.champion).scores)){
        const result=await adopt(run.branches[run.champion].proposalId);recordAdoption(run,result.entry,result.currentVersion);run.status='done';
      }
      // 收尾结论：无论哪种停机方式都生成「发生了什么/为什么/下一步」总结（结论生成失败不影响运行记录本身）
      try{run.conclusion=buildRunConclusion(run);}catch(e){run.conclusion={schema:1,error:'结论生成失败：'+e.message};}
    }catch(e){if(run){run.status=stopped?'stopped':'error';run.error=e.message;try{run.conclusion=buildRunConclusion(run);}catch(ce){run.conclusion={schema:1,error:'结论生成失败：'+ce.message};}}if(!stopped)throw e;}
    finally{
      clearTimeout(deadlineTimer);
      abortAll(new Error('运行结束，清理剩余请求'));
      await Promise.allSettled([...activeOperations]);
      clock.mark('done');
      try { if(run){publish();const current=deps.loadState();current.evolveRuns||=[];const index=current.evolveRuns.findIndex(r=>r.id===run.id);if(index<0)current.evolveRuns.push(clone(run));else current.evolveRuns[index]=clone(run);current.activeEvolution=null;deps.saveState(current);} }
      finally{running=false;activeTaskId=null;deadlineError=null;}
    }
    return clone(run);
  }
  const resume = (runId, onProgress = () => {}) => evolve({ resumeRunId: runId }, onProgress);
  // Task discovery needs only current measurement validity. Do not expand all
  // candidate/run evidence (or validate their assets) to render a task row.
  function scoreValidity(s, snapshot) {
    const engineRev=snapshot?.engineRev||revision(),ctx=snapshot?.ctx||context(s,engineRev);
    const currentAssetHash=snapshot?.assetHash||assetHash(graphOf(s));
    const valid=s.baseline?.version===s.currentVersion&&s.baseline?.assetHash===currentAssetHash&&contextEqual(s.baseline.context,ctx);
    return {current:valid,reason:valid?'当前正式实验版本的同口径生产成绩':s.baseline?'资产、题库、切分或引擎协议已经变化，需重测':'尚未测量当前基线',
      metric:'strict_pct',split:'all',value:valid?s.baseline.scores.all.strict_pct:null,n:s.split.train.length+s.split.heldout.length,
      assetHash:s.baseline?.assetHash||null,contextId:hash(ctx)};
  }
  function state(s = deps.loadState(), snapshot, opts = {}) {
    const currentEngineRev = snapshot?.engineRev || revision(), ctx = snapshot?.ctx || context(s, currentEngineRev);
    const currentAssetHash = snapshot?.assetHash || assetHash(graphOf(s));
    const valid = s.baseline?.version === s.currentVersion && s.baseline?.assetHash === currentAssetHash && contextEqual(s.baseline.context, ctx);
    const view = deps.publicState(s);
    snapshot = { engineRev: currentEngineRev, ctx, assetHash: currentAssetHash, valid };
    const ownsRun = running && (s.taskId || null) === activeTaskId;
    return { ...view, taskId: s.taskId || null, taskName: s.taskName || s.taskId || '意图进化实验', taskDesc: s.taskDesc || '', revision: s.revision || 0, engineRef: s.engineRef || null,
      rev: 7, currentEngineRev, capabilities: { productionScoring: true, multiGeneration: true, finalExam: !!s.split.test?.length, merge: false, resume: true, export: true, memberOptimizer: false },
      scoreValidity: scoreValidity(s,snapshot),
      goal: (() => {
        const g = goalLib.safeGoal(s.goal);
        if (!valid || !s.baseline?.results?.length) return { ...g, current: null, met: false, summary: `目标 ${g.target}%｜尚无当前口径基线` };
        try { return goalWithRates(g, s.baseline.scores, s.baseline.results, deps.readCases(s), s); }
        catch (e) { return { ...g, current: null, met: false, summary: `目标 ${g.target}%｜归因失败：${e.message}` }; }
      })(),
      baseline: view.baseline ? { ...view.baseline, measurement: s.baseline.measurement || measurementPolicyLib.legacyMeta(), engineRev: s.baseline.engineRev || s.baseline.scores?.engineRev || null, stale: !valid } : null,
      split: { ...view.split, trainCount: s.split.train.length, heldoutCount: s.split.heldout.length, testCount: s.split.test?.length || 0 },
      scoreHistory: clone(s.scoreHistory || []).map(h => ({ ...h, measurement: h.measurement || measurementPolicyLib.legacyMeta(), engineRev: h.engineRev || h.scores?.engineRev || null, comparable: contextEqual(h.context, ctx) })),
      // 摘要视图先裁剪再克隆（10-30 审计 P1）：此前先 clone 完整运行记录再做 summaryRun，
      // 9 次运行的完整 rounds/input 要克隆并序列化近 30MB，摘要接口承担了不必要的成本。
      evolveRuns: (s.evolveRuns || []).map(r => { const run = opts.summary ? summaryRun(r) : clone(r);
        return {...run,rounds:Array.isArray(run.rounds)?run.rounds:[],branches:run.branches||{},stale:!contextEqual(r.context,ctx)};}),
      activeEvolution: s.activeEvolution ? (() => { const run = opts.summary ? summaryRun(s.activeEvolution) : clone(s.activeEvolution);
        return { ...run,rounds:Array.isArray(run.rounds)?run.rounds:[],branches:run.branches||{}, status: ownsRun ? 'running' : run.status === 'running' ? 'interrupted' : run.status, stale: !contextEqual(s.activeEvolution.context,ctx) }; })() : null,
      evolveRunning: ownsRun, rsiConfig: s.rsiConfig || {}, finalExam: s.finalExam || { history: [], runCount: 0 }, methodHistory: s.methodHistory || [],
      strategy: (() => { try { const st = strategyOf(s); return { ...st, digest: st.digest }; } catch (e) { return { version: 2, error: e.message, arms: [], families: [], operators: [], digest: '' }; } })(),
      archive: view.archive.map(e => { const raw = s.archive.find(a => a.id === e.id); return { ...e, ...Object.fromEntries(['candidateHash', 'candidateBaseVersion', 'baseAssetHash', 'evaluationContext', 'baselineAtEval', 'engineCheck', 'fullScores', 'runId', 'branchId', 'measurement', 'confirmation', 'confirmationGate'].map(k => [k, clone(raw[k])])), measurement: raw.measurement || (raw.fullScores ? measurementPolicyLib.legacyMeta() : null), adoptability: adoption(s, raw, snapshot) }; }) };
  }
  async function evaluate(id) {
    const s = deps.loadState(), e = s.archive.find(e => e.id === id);
    if (!e || ['adopted', 'rejected'].includes(e.status)) throw new Error('候选不存在或已终态');
    if (!fresh(s)) throw new Error('当前生产基线已过期，请重新测试');
    if (e.candidateBaseVersion !== s.currentVersion || e.baseAssetHash !== null && e.baseAssetHash !== assetHash(graphOf(s))) throw new Error('候选父版本缺失或已变化，请重新生成候选');
    // 三级测量的单候选版（10-31）：先单票初筛（省预算），命中「证据不足但非净负」时
    // 用三票复核再判——LLM judge 边界题单票 1 题之差抛硬币（v15 配方实测：全量净+2 的
    // 真修复被单票 2修1破 拦在初筛）。净负或回退直接 gated，不浪费三票。
    const candidateGraph = readAsset(e.candidateHash);
    const screenResult = await score(candidateGraph, s, { concurrency: s.rsiConfig?.scoringConcurrency || 1 });
    let result = screenResult;
    let measurement = measurementPolicyLib.measurementMeta('screening', 1, 1);
    const screenGate = gateCandidate(s.baseline.scores, screenResult.scores, screenResult.results, s.regression,
      { beforeRows: s.baseline.results, goal: s.goal, cases: deps.readCases(s), trainIds: s.split.train });
    if (!screenGate.passed && ['evidence_insufficient', 'no_effect'].includes(screenGate.verdict)) {
      const votes = measurementPolicyLib.votesFor('stable');
      result = await scoreRepeat(candidateGraph, deps.loadState(), { context: result.context, concurrency: s.rsiConfig?.scoringConcurrency || 1, repeat: votes });
      measurement = measurementPolicyLib.measurementMeta('stable', votes, votes);
    } else if (screenGate.passed) {
      // 单票初筛直接通过 → 采纳前仍需稳定复测（adoption 要求 confidence=stable）。
      // 单票过 ≠ 稳定过：v11 的假提升正是单票全过。这里就是确认档。
      const votes = measurementPolicyLib.votesFor('stable');
      result = await scoreRepeat(candidateGraph, deps.loadState(), { context: result.context, concurrency: s.rsiConfig?.scoringConcurrency || 1, repeat: votes });
      measurement = measurementPolicyLib.measurementMeta('stable', votes, votes);
    }
    const current = deps.loadState();
    if (current.currentVersion !== s.currentVersion || !contextEqual(result.context, context(current))) throw new Error('评测期间上下文变化');
    const gate = gateCandidate(s.baseline.scores, result.scores, result.results, s.regression,
      { beforeRows: s.baseline.results, goal: s.goal, cases: deps.readCases(s), trainIds: s.split.train });
    let confirmation = null, confirmationGate = null;
    if (measurement.confidence === 'stable' && gate.passed) {
      const confirmationVotes = measurementPolicyLib.votesFor('confirmation');
      const confirmationResult = await scoreRepeat(candidateGraph, deps.loadState(), {
        context: result.context, concurrency: s.rsiConfig?.scoringConcurrency || 1,
        repeat: confirmationVotes,
      });
      confirmation = measurementPolicyLib.measurementMeta('confirmation', confirmationVotes, confirmationVotes);
      confirmationGate = gateCandidate(s.baseline.scores, confirmationResult.scores,
        confirmationResult.results, s.regression, { beforeRows: s.baseline.results,
          goal: s.goal, cases: deps.readCases(s), trainIds: s.split.train });
    }
    const confirmed = gate.passed && confirmationGate?.passed === true;
    const target = current.archive.find(a => a.id === id);
    Object.assign(target, { status: confirmed ? 'passed' : 'gated', fullScores: result.scores, trainScores: result.scores.train,
      heldoutScores: result.scores.heldout, evaluationContext: result.context, measurement,
      ...(confirmation ? { confirmation: clone(confirmation), confirmationGate: clone(confirmationGate) } : {}),
      adoptability: confirmed ? { ok: true, reason: '稳定评测与独立确认均通过' }
        : { ok: false, reason: gate.passed ? `独立确认未通过：${confirmationGate?.reason || '未取得确认测量'}` : gate.reason },
      engineCheck: { ok: confirmed, engineRev: result.scores.engineRev }, gate: { ...clone(gate), stage: confirmed ? 'passed' : 'regression', reason: screenGate.passed ? (confirmed ? gate.reason : `稳定评测通过，但${confirmationGate?.reason || '未取得独立确认'}`) : `单票初筛未过（${screenGate.verdict}），${measurement.mode === 'stable' ? `三票复核：` : ''}${gate.reason}` } });
    deps.saveState(current); return { entry: target };
  }
  const capabilities = () => ({ ...(require('./rsi-optimization').capabilityRegistry?.() || {}), targets: { ...TARGETS, engine: { ...TARGETS.engine, methods: ['parameter_search'] } }, methods: METHODS, features: { merge: false, allStrategy: false, memberOptimizer: false, resume: true, export: true, agent: !!deps.agentUrl },
    defaults: { branching: 'path', parentPolicy: 'champion', maxMetricCalls: 200, maxMinutes: 60 } });
  function preflight(opts = {}) {
    const s = deps.loadState(), blockers = [], warnings = [], cases = deps.readCases(s), ids = new Set(cases.map(c=>c.case_id));
    if (!s.split.train?.length) blockers.push('训练题为空，请先准备题库');
    if (!s.split.heldout?.length) blockers.push('验证集 heldout 为空，不能执行门禁');
    const all = [...s.split.train,...s.split.heldout,...(s.split.test||[])];
    if (new Set(all).size !== all.length) blockers.push('训练、验证与终测存在重叠题目');
    if (all.some(id=>!ids.has(id))) blockers.push('题库缺少切分指定的题目');
    if (!s.split.test?.length) warnings.push('未封存独立终测题，可探索但不能宣称独立测试完成');
    try { const cfg = configOf(opts); if (cfg.targets.some(t=>t!=='engine') && !(deps.proposerReady ? deps.proposerReady() : deps.propose || deps.callLLM)) blockers.push('未配置提案模型凭据'); }
    catch(e) { blockers.push(e.message); }
    if (!fresh(s)) warnings.push('基线缺失或过期，启动后将先重新评测，计入预算');
    // 目标导向：启动前就说清「差几题、差在哪、现有手段够不够」，而不是跑完再说没涨。
    const goal = goalLib.safeGoal(s.goal);
    const progress = s.baseline?.results?.length && fresh(s) ? goalWithRates(goal, s.baseline.scores, s.baseline.results, cases, s) : null;
    if (progress) {
      if (progress.met) warnings.push(`已达标：${goal.metric} ${progress.current}% ≥ 目标 ${goal.target}%`);
      else {
        warnings.push(`距目标 ${goal.target}% 还差 ${progress.missingCases} 题（${progress.gapPts}pp）；失败集中在 ${progress.byShape.filter(x => x.failed).slice(0, 2).map(x => `${x.shape} ${x.failed}题`).join('、') || '无'}；现有动作空间估算上限 ${progress.ceilingPct}%`);
        if (!progress.reachable) warnings.push(`按当前动作空间与回收率无法达到 ${goal.target}%：需新增澄清策略类动作或补充题库覆盖`);
      }
    }
    // 策略记忆：启动前就说清「这套工具在本任务已经学会了什么、哪些动作不必再试」。
    let strategy = null;
    try { strategy = strategyOf(s); } catch (_) { /* 策略折叠失败不阻断预检 */ }
    if (strategy) {
      if (strategy.measuredCount >= 3) {
        if (strategy.deadDimensions.length) warnings.push(`策略记忆：${strategy.deadDimensions.map(d => strategyLib.OPERATOR_LABEL[d] || d).join('、')} 在本任务已连续 ${strategyLib.DEAD_DIMENSION}+ 次无收益，本次不再优先尝试`);
        if (strategy.untriedOperators.length) warnings.push(`尚未尝试的动作：${strategy.untriedOperators.map(o => strategyLib.OPERATOR_LABEL[o] || o).join('、')}（搜索会优先覆盖未探索维度）`);
        if (!strategy.arms.some(a => a.wins > 0) && strategy.measuredCount >= 6) warnings.push(`已测 ${strategy.measuredCount} 个候选仍无有效动作，现有动作空间可能已到上限，建议扩展算子而不是继续调参`);
      }
      if (strategy.digest) warnings.push(`策略记忆：${strategy.digest}`);
    }
    // 验证集覆盖：heldout 里没有的意图，无法证明改动是泛化而非记忆。
    try {
      const byId = new Map(cases.map(c => [c.case_id, c]));
      const intents = ids0 => new Set(ids0.flatMap(id => byId.get(id)?.expected_intents || []));
      const trainIntents = intents(s.split.train), heldIntents = intents(s.split.heldout || []);
      const uncovered = [...trainIntents].filter(x => !heldIntents.has(x));
      if (uncovered.length) warnings.push(`验证集未覆盖 ${uncovered.length}/${trainIntents.size} 个训练意图，这些意图上的涨分不能证明泛化`);
    } catch (_) { /* 题库异常时由上面的缺题检查兜底 */ }
    if (fresh(s)) {
      const rows = new Map((s.baseline.results || []).map(r => [r.case_id, r]));
      const failed = Object.keys(s.regression || {}).filter(id => rows.has(id) && !rows.get(id).strict);
      const missing = Object.keys(s.regression || {}).filter(id => !rows.has(id));
      if (failed.length) warnings.push(`历史回归保护在基线即失败：${failed.join('、')}，已 quarantine（不再阻断晋升，但仍会作为坏例进入变异反馈）`);
      if (missing.length) blockers.push(`历史回归保护不在当前训练/验证评测中：${missing.join('、')}，请核对题库和保护记录后再运行`);
    }
    return { ready: blockers.length === 0, blockers, warnings, goal: progress ? { ...goal, ...progress } : { ...goal }, strategy: strategy ? { digest: strategy.digest, deadDimensions: strategy.deadDimensions, untriedOperators: strategy.untriedOperators, leverage: strategy.leverage, candidateCount: strategy.candidateCount, measuredCount: strategy.measuredCount, successRate: strategy.successRate } : null, summary: { taskId: s.taskId || null,taskName:s.taskName||s.taskId,version:s.currentVersion,
      trainCount:s.split.train.length,heldoutCount:s.split.heldout.length,testCount:s.split.test?.length||0,baselineCurrent:fresh(s),engineRev:revision(),capabilities:capabilities(),
      goal: progress ? { target: goal.target, current: progress.current, gapPts: progress.gapPts, missingCases: progress.missingCases, met: progress.met, reachable: progress.reachable } : { target: goal.target },
      budgetUnits:{metricCalls:'完整评测调用，不是模型调用或题数',maxMinutes:'本次运行累计活跃分钟；暂停时间不计入',cost:'未知费用，不作为零费用'}} };
  }
  function candidateDiff(id) {
    const s=deps.loadState(),e=s.archive.find(e=>e.id===id); if(!e)throw new Error('候选不存在');
    const run=(s.evolveRuns||[]).find(r=>r.id===e.runId)||(s.activeEvolution?.id===e.runId?s.activeEvolution:null);
    const parent=run?.branches?.[e.parentBranch||e.parents?.[0]],parentHash=parent?.artifactHash||e.baseAssetHash;
    let saved=null;try{saved=JSON.parse(fs.readFileSync(checkpointFile(s,e.runId)));}catch(_){}
    const rows=new Map(saved?.readings||[]),beforeRows=rows.get(parent?.id||'b0')?.results||s.baseline?.results||[],afterRows=rows.get(e.branchId)?.results||[];
    return {candidate:{id:e.id,summary:e.proposal?.motivation||e.opLabel,status:e.status},parents:[parentHash],context:e.evaluationContext,
      valid:contextEqual(e.evaluationContext,context(s)),changes:diffAssets(readAsset(parentHash),readAsset(e.candidateHash)),
      caseChanges:caseChanges(beforeRows,afterRows),gate:e.gate};
  }
  async function finalExam() {
    const s=deps.loadState();if(!fresh(s))throw new Error('最终测试前需当前生产基线');
    if(!s.split.test?.length)throw new Error('未封存独立终测题，不能开考');
    const graph=graphOf(s),asset=assetHash(graph),ctx=context(s),key=hash({asset,ctx,test:s.split.test});
    const cached=s.finalExam?.history?.find(e=>e.measurementKey===key);
    if(cached)return {finalExam:{...cached,runCount:s.finalExam.runCount,reused:true}};
    const reading=await score(graph,s,{test:true,concurrency:s.rsiConfig?.scoringConcurrency||1}),current=deps.loadState();
    if(current.currentVersion!==s.currentVersion||assetHash(graphOf(current))!==asset||!contextEqual(reading.context,context(current)))throw new Error('最终测试期间上下文变化');
    current.finalExam||={history:[],runCount:0};current.finalExam.runCount++;
    const item={taskId:s.taskId||null,version:s.currentVersion,assetHash:asset,context:ctx,measurementKey:key,testCount:s.split.test.length,
      scores:reading.scores.all,engineRev:reading.scores.engineRev,at:new Date().toISOString(),testSetPreviouslyUsed:current.finalExam.history.length>0};
    current.finalExam.history.push(item);deps.saveState(current);return {finalExam:{...item,runCount:current.finalExam.runCount}};
  }
  function exportBundle() {
    const s=deps.loadState(), currentScoreValid=fresh(s);
    const graph=graphOf(s),asset=assetHash(graph),ctx=context(s),exam=[...(s.finalExam?.history||[])].reverse().find(e=>e.assetHash===asset&&contextEqual(e.context,ctx));
    return {downloadName:`rsi-${s.taskId||'experiment'}-${s.currentVersion}.json`,bundle:{schema:1,taskId:s.taskId||null,taskName:s.taskName,version:s.currentVersion,assetHash:asset,graph,context:ctx,
      baseline:s.baseline?{...clone(s.baseline),stale:!currentScoreValid}:null,finalExam:exam||null,snapshot:clone(s),dataset:{cases:clone(deps.readCases(s)),split:clone(s.split),splitConfig:clone(s.splitConfig)},
      manifest:{exportedAt:new Date().toISOString(),currentScoreValid,independentTestMeasured:!!exam,productionPublished:false,
        contents:['graph','runtime prompts and parameters','dataset and split','task snapshot','evaluation context','baseline','independent final exam when measured'],scope:currentScoreValid?'实验资产与证据导出；生产发布需使用目标环境的独立发布流程':'未完成当前评测的实验备份，不代表验证通过或已发布'}}};
  }
  async function handle(req, res) {
    const p = req.pathname, endpoint = p.slice('/api/intent-rsi'.length), method = req.method;
    const json = (code, value) => deps.sendJson(res, code, value);
    if (endpoint === '/state' && method === 'GET') {
      const raw = deps.loadState(), engineRev = revision(), ctx = context(raw, engineRev), currentAssetHash = assetHash(graphOf(raw));
      const summary = new URL(req.url, 'http://localhost').searchParams.get('view') === 'summary';
      const etag = '"' + hash({ taskId: raw.taskId, revision: raw.revision || 0, engineRev, ctx, currentAssetHash, summary,
        running: running && activeTaskId === (raw.taskId || null), baselineAt: raw.baseline?.at || null,
        currentVersion: raw.currentVersion || null, activeEvolution: raw.activeEvolution?.id || null,
        evolveRuns: (raw.evolveRuns || []).length, archive: (raw.archive || []).length }) + '"';
      // nginx weakens validators when it compresses JSON. GET uses weak comparison.
      const matches = String(req.headers?.['if-none-match'] || '').split(',').some(tag => tag.trim().replace(/^W\//, '') === etag || tag.trim() === '*');
      if (raw.revision && matches) { res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' }); res.end(); return true; }
      res.setHeader?.('ETag', etag); res.setHeader?.('Cache-Control', 'no-cache');
      const view = state(raw, { engineRev, ctx, assetHash: currentAssetHash }, { summary });
      json(200, { ok: true, state: view }); return true;
    }
    if (endpoint === '/run-trace' && method === 'GET') {
      const query = new URL(req.url, 'http://localhost').searchParams;
      const s = deps.loadState(), run = [s.activeEvolution, ...(s.evolveRuns || [])].find(r => r && r.id === query.get('runId'));
      const round = run?.rounds?.find(r => String(r.gen ?? r.round) === query.get('gen'));
      if (!round?.reasoning) { json(404, { ok: false, error: '运行分析记录不存在' }); return true; }
      // Only recorded training evidence is returned; no checkpoint/test readings.
      json(200, { ok: true, reasoning: round.reasoning }); return true;
    }
    if (endpoint === '/optimization-capabilities' && method === 'GET') { json(200, { ok: true, data: capabilities() }); return true; }
    if (endpoint === '/asset-lineage' && method === 'GET') {
      const s = deps.loadState(), assets = [];
      const references=new Set([...(s.versions||[]).map(v=>v.assetHash),...(s.archive||[]).map(e=>e.candidateHash),...[...(s.evolveRuns||[]),s.activeEvolution].filter(Boolean).flatMap(r=>Object.values(r.branches||{}).map(b=>b.artifactHash))].filter(Boolean));
      const files = (await fs.promises.readdir(artifacts).catch(error => { if (error.code === 'ENOENT') return []; throw error; }))
        .filter(file => /^[a-f0-9]{64}\.json$/.test(file) && references.has(file.slice(0, -5)));
      // Limit IO concurrency and yield while crossing Docker bind mounts so this
      // secondary view cannot hold up the state endpoint or the event loop.
      for (let offset = 0; offset < files.length; offset += 8) {
        const batch = await Promise.all(files.slice(offset, offset + 8).map(async file => {
          const fullPath = path.join(artifacts, file);
          try {
            const stat = await fs.promises.stat(fullPath, { bigint: true });
            const stamp = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
            let metadata = lineageMetadata.get(file);
            if (metadata?.stamp !== stamp) {
              const bundle = JSON.parse(await fs.promises.readFile(fullPath, 'utf8')); assertBundle(bundle);
              if (bundle.hash !== file.slice(0, -5)) throw new Error('Asset identity mismatch');
              metadata = { stamp, hash: bundle.hash, parents: bundle.parents || [], baseVersion: bundle.baseVersion,
                mutations: Object.keys(bundle.graph.meta?.rsi_runtime?.engine || {}) };
              if (lineageMetadata.size > 2048) lineageMetadata.clear();
              lineageMetadata.set(file, metadata);
            }
            const { hash, parents, baseVersion, mutations } = metadata;
            const entry = s.archive.find(e => e.candidateHash === hash);
            const reading = [...(s.scoreHistory || [])].reverse().find(h => h.ctx?.assetHash === hash);
            return { hash, short: hash.slice(0, 8), parents, baseVersion, mutations,
              adoptedBy: s.versions.filter(v => v.assetHash === hash || v.applied?.some(id => s.archive.find(e => e.id === id)?.candidateHash === hash)).map(v => v.version),
              scores: reading ? { all: reading.scores.all.strict_pct, heldout: reading.scores.heldout.strict_pct } : entry?.fullScores ? { all: entry.fullScores.all.strict_pct, heldout: entry.fullScores.heldout.strict_pct } : null };
          } catch (_) { lineageMetadata.delete(file); return null; }
        }));
        assets.push(...batch.filter(Boolean));
      }
      json(200, { ok: true, assets }); return true;
    }
    if (endpoint === '/auto-evolve-stop' && method === 'POST') {
      if(running&&(deps.loadState().taskId||null)!==activeTaskId){json(409,{ok:false,error:'不能停止其他任务的运行'});return true;}
      stop();json(200,{ok:true,status:running?'stopping':'idle'});return true;
    }
    // F16 整改收口：启动/恢复一律 POST（幂等 commandId），GET 不再携带启动副作用。
    // 此前前端已改 POST，但这里只注册了 GET —— POST 穿透 404，UI 实际起不了进化。
    if ((endpoint === '/auto-evolve' || endpoint === '/auto-evolve-resume') && method === 'POST') {
      if (running || locked) { json(409, { ok: false, error: '已有任务运行中' }); return true; }
      let body = {};
      try { body = (await deps.readJsonBody(req)) || {}; } catch (e) {json(400,{ok:false,error:e.message});return true;}
      const opts = { ...body };
      if (endpoint === '/auto-evolve-resume') {
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(String(opts.runId || ''))) { json(400, { ok: false, error: '缺少有效的 runId（检查点恢复）' }); return true; }
        opts.resumeRunId = opts.runId;
      } else {
        try { const check=preflight(opts);if(!check.ready)throw new Error(check.blockers.join('；')); }
        catch (e) { json(400, { ok: false, error: e.message }); return true; }
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const send = data => { if (!res.destroyed) res.write(`data: ${JSON.stringify(data)}\n\n`); };
      const pulse = setInterval(() => { if (!res.destroyed) res.write(': heartbeat\n\n'); }, 15000);
      // SSE 客户端断连时停止进化运行（M2）：否则 evolve 继续后台消耗模型/评测预算，
      // running=true 持续阻塞新任务直到时间预算耗尽
      res.once?.('close', () => { clearInterval(pulse); stop(); });
      try { const run = await evolve(opts, send); send({ step: 'complete', round: run.rounds.length, detail: run.status === 'awaiting_human' ? '实验完成，等待人工采纳；正式图谱未改动' : '实验结束', status: run.status,runId:run.id }); }
      catch (e) { send({ step: 'error', round: 0, detail: e.message }); }
      finally { clearInterval(pulse); res.end(); } return true;
    }
    if ((endpoint === '/auto-evolve' || endpoint === '/auto-evolve-resume') && method === 'GET') {
      json(405, { ok: false, error: endpoint === '/auto-evolve'
        ? '启动进化请使用 POST /auto-evolve（SSE，携带幂等 commandId）；GET 不再携带启动副作用'
        : '恢复运行请使用 POST /auto-evolve-resume（body 带 runId）' });
      return true;
    }
    // 此前三处函数已实现但从未挂路由：预检/候选差异/成果导出（评审 F16/F18/F19 交互链断点）
    if (endpoint === '/preflight' && method === 'POST') {
      try { const body = (await deps.readJsonBody(req)) || {}; json(200, { ok: true, ...preflight(body) }); }
      catch (e) { json(400, { ok: false, error: e.message }); } return true;
    }
    if (endpoint === '/candidate-diff' && method === 'GET') {
      try { const id = new URL(req.url, 'http://localhost').searchParams.get('id'); json(200, { ok: true, ...candidateDiff(id) }); }
      catch (e) { json(400, { ok: false, error: e.message }); } return true;
    }
    if (endpoint === '/export' && ['GET', 'POST'].includes(method)) {
      try { json(200, { ok: true, ...exportBundle() }); }
      catch (e) { json(400, { ok: false, error: e.message }); } return true;
    }
    // 目标读写：没有目标就没有「达标」，所有运行与门禁都读这一份。
    if ((endpoint === '/goal' || endpoint === '/goal-update') && method === 'GET') {
      json(200, { ok: true, goal: state(deps.loadState()).goal }); return true;
    }
    if (endpoint === '/goal' && method === 'POST') {
      if (running || locked) { json(409, { ok: false, error: '运行中不能修改目标，请先停止' }); return true; }
      try {
        const body = (await deps.readJsonBody(req)) || {};
        const s = deps.loadState();
        const next = goalLib.normalizeGoal({ ...(s.goal || {}), ...body });
        s.goal = next; s.log ||= [];
        s.log.push({ at: new Date().toISOString(), event: 'goal', detail: `目标更新：${next.metric} ≥ ${next.target}%，最小效应 ${next.minEffect}pp，α=${next.alpha}` });
        deps.saveState(s);
        json(200, { ok: true, goal: state(deps.loadState()).goal });
      } catch (e) { json(400, { ok: false, error: e.message }); }
      return true;
    }
    // 策略记忆：工具自己的「哪种改法在这道任务上有效」台账，含已证否动作与下一步建议。
    if (endpoint === '/strategy' && method === 'GET') {
      try { const st = strategyLib.summarize(deps.loadState()); json(200, { ok: true, strategy: st }); }
      catch (e) { json(500, { ok: false, error: e.message }); } return true;
    }
    if (method === 'POST') {
      if (running || locked) { json(409, { ok: false, error: '生产任务运行中，禁止并发修改实验状态' }); return true; }
      // 正式基线不能被客户端降级成单票；缺省或传 1/2 都提升到三票稳定测量。
      const actions = { '/baseline': body => baseline({
          mode: 'stable',
          repeat: Math.max(3, Math.min(5, Math.floor(Number(body?.repeatVotes)) || 3)),
        }), '/adopt': body => adopt(body.id), '/evaluate-proposal': body => evaluate(body.id), '/verify-engine': body => evaluate(body.id),
        '/propose': async () => { throw new Error('请从启动配置选择优化路径，运行真实多代实验；不再生成无父资产的孤立提案'); },
        '/engine-param-search': async () => { throw new Error('旧沙盒参数不能用于生产引擎，请在启动配置选择意图引擎参数搜索'); },
        '/bundle-evaluate': async () => { throw new Error('未验证的跨候选组合已停用，请使用完整冻结候选'); },
        '/final-exam': () => finalExam() };
      if (actions[endpoint]) { locked = true; try { const body = await deps.readJsonBody(req); json(200, { ok: true, ...await actions[endpoint](body) }); }
        catch (e) { json(400, { ok: false, error: e.message }); } finally { locked = false; } return true; }
    }
    return false;
  }
  function acquireLegacy() {
    if (running || locked) throw new Error('生产任务运行中，禁止并发修改实验状态');
    locked = true;
    let released = false;
    return () => { if (!released) { released = true; locked = false; } };
  }
  return { state, scoreValidity, baseline, evolve, resume, adopt, evaluate, handle, capabilities, configOf, acquireLegacy, stop,preflight,candidateDiff,finalExam,exportBundle,isFresh:fresh,runningTaskId:()=>running?activeTaskId:null,
    // 手动提案的资产冻结（10-31）：与运行时候选同一 bundle 格式，走同一 readAsset 校验
    freezeAsset: (graph, base, parents) => freeze(graph, base, parents || []), contextOf: s => context(s),
    // Agent 调研工具桥：/agent/* 端点转发到此；仅对应任务运行中且开放代次可用
    agentTool:(taskId,tool,params)=>{ if(!activeAgentTool) throw new Error('Agent 工具桥未开放（无运行中的 Agent 代次）'); return activeAgentTool(taskId,tool,params); } };
}

module.exports = { createProductionRuntime, gateCandidate, trainingBetter };
// __marker2__
