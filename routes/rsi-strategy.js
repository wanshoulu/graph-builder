'use strict';
// 策略层（strategy）——让 RSI 工具「越用越会改」，而不是每轮从零重搜。
//
// 审计（2026-10-19）发现的问题：判定层修好后，搜索仍是无记忆的固定坐标下降。
//   · FAMILY_FIX.rate 是硬编码的 0.25/0.35，目标上限“77.2%”其实是个拍脑袋数；
//   · parameterMutations 每代从同一个网格起点重排，上一轮被证否的 (true,3) 下轮还是第一个；
//   · methodHistory 只被当去重集合，从没被告知“这个动作在本任务 0/7 有效”；
//   · 失败族反馈是纯轮转，不按“缺口 × 实测可修率 × 成本”分配预算。
//
// 本模块只做一件事：把「动作 → 结果」折叠成可复用、可审计的先验，并回答三个问题：
//   1. 哪个动作在这道任务上被实测证否？（deadArms）
//   2. 每个失败族还剩多少可回收空间？（ratesFor → 目标上限自校准）
//   3. 下一条最该试什么、值不值得花一次评测？（rankArms / leverage）
//
// 折叠是幂等的：始终从 evolveRuns/archive 全量重算，不追加计数，
// 因此重启、重放、断点恢复都不会把同一候选记两遍。

// 先验：只作为「无实测数据」时的起点，样本进来后被实测值覆盖（经验贝叶斯收缩）。
const FAMILY_PRIOR = {
  clarification_precision: { label: '澄清选项过多', fixableBy: 'A2/A6 候选边界 / 引擎澄清策略', prior: 0.25, operators: ['A2_disambiguation', 'A6_ambiguity_cluster_expand', 'combo', 'param:graphClusterFirst', 'param:clarificationLimit', 'clarification:cluster+limit'] },
  unnecessary_clarification: { label: '不必要澄清', fixableBy: '引擎澄清策略', prior: 0.25, operators: ['param:clarificationLimit', 'A5_clarify'] },
  clarification_trigger: { label: '该澄清未触发', fixableBy: 'A6 歧义声明 / 引擎澄清策略', prior: 0.25, operators: ['A6_ambiguity_cluster_expand', 'combo', 'A1_utterance_expand', 'param:clarificationLimit'] },
  clarification_coverage: { label: '澄清覆盖不足', fixableBy: 'A6 歧义范围 / A1 说法', prior: 0.25, operators: ['A6_ambiguity_cluster_expand', 'combo', 'A1_utterance_expand', 'A3_clause_expansion'] },
  clarification_question: { label: '澄清问法不可答', fixableBy: 'A5 文案', prior: 0.25, operators: ['A5_clarify'] },
  multi_missing: { label: '多意图漏识别', fixableBy: 'A1/A3 声明层', prior: 0.35, operators: ['A1_utterance_expand', 'A3_clause_expansion'] },
  multi_extra: { label: '多意图多识别', fixableBy: 'A2/A4 边界声明', prior: 0.30, operators: ['A2_disambiguation', 'A4_description_rewrite'] },
  multi_task_constraints: { label: '多意图任务约束错', fixableBy: 'A3 子句表达', prior: 0.30, operators: ['A3_clause_expansion'] },
  recall: { label: '说法未召回', fixableBy: 'A1 说法扩展 / A3 子句', prior: 0.45, operators: ['A1_utterance_expand', 'A3_clause_expansion'] },
  ranking: { label: '排序错误', fixableBy: 'A2 区分线索', prior: 0.35, operators: ['A2_disambiguation'] },
  wrong_label: { label: '意图判错', fixableBy: 'A2/A4 语义边界', prior: 0.35, operators: ['A2_disambiguation', 'A4_description_rewrite'] },
  negative_boundary: { label: '负例越界', fixableBy: 'A4 描述/否定声明', prior: 0.40, operators: ['A4_description_rewrite'] },
  engine_error: { label: '引擎错误', fixableBy: '基础设施', prior: 0, operators: [] },
  unclassified: { label: '未归类', fixableBy: '人工分析', prior: 0, operators: [] },
};

const GLOBAL_FAMILY = 'engine_global';
const PRIOR_WEIGHT = 3;      // 先验等价样本量：3 题实测即可把先验拉走一半
const DEAD_ATTEMPTS = 3;     // 同一动作 3 次无胜绩且累计无正收益 → 判为已证否
const DEAD_DIMENSION = 4;    // 同一参数维度 4 次无胜绩 → 判为「这个维度在本任务没杠杆」
// 分层指标环节 → 失败族。策略记忆的「失败题数」必须与 stageMetrics 同源：
// 此前失败族只按"候选实际覆盖到的题"计数，没被候选打过的族恒为 0，
// 于是摘要里 ranking（实际 12 题）显示 0 题、clarification_precision（实际 10 题）显示 4 题，
// 预算分配依据的是失真的失败分布（10-30 Codex 审计 P0）。
const STAGE_FAMILY = {
  judge_rank: 'ranking', judge_select: 'wrong_label', recall: 'recall',
  clarify_trigger: 'clarification_trigger', clarify_options: 'clarification_precision',
  clarify_question: 'clarification_question', clarify_over: 'unnecessary_clarification',
  composite_split: 'multi_missing', composite_over: 'multi_extra',
  negative_guard: 'negative_boundary', multi_turn: 'unclassified',
};
const OPERATOR_LABEL = {
  A1_utterance_expand: 'A1 补说法', A2_disambiguation: 'A2 区分线索', A3_clause_expansion: 'A3 子句表达',
  A4_description_rewrite: 'A4 改描述', A5_clarify: 'A5 澄清文案', A6_ambiguity_cluster_expand: 'A6 歧义簇扩展',
  engine_global: '引擎参数', optimizer_prompt: '搜索指令', recognition_prompt: '识别指令',
  bundle: '图谱组合改法', graph: '图谱改动', engine: '引擎参数', unknown: '未标注动作',
};

const round = (n, d = 2) => Number.isFinite(n) ? +(+n).toFixed(d) : null;
const pct = (a, b) => b > 0 ? 100 * a / b : 0;

// 参数动作的稳定签名：同一组参数在任何分支上都算同一臂，才能累计出胜率。
function paramSignature(parameters = {}) {
  const keys = Object.keys(parameters).filter(k => parameters[k] !== undefined).sort();
  if (!keys.length) return null;
  return 'param:' + keys.map(k => `${k}=${parameters[k]}`).join(',');
}

const REAL_OPERATORS = new Set(['A1_utterance_expand', 'A2_disambiguation', 'A3_clause_expansion', 'A4_description_rewrite', 'A5_clarify', 'A6_ambiguity_cluster_expand']);
// 参数动作要分两层看：具体取值（arm，用于去重/别重复试）与维度（dimension，用于学习）。
// 只按 `hintWeight=0.16` 累计，每个取值都只试一次，永远学不出「调 hintWeight 在这任务没用」。
function paramDimension(parameters = {}) {
  const keys = Object.keys(parameters).filter(k => parameters[k] !== undefined).sort();
  if (!keys.length) return null;
  if (keys.includes('graphClusterFirst') && keys.includes('clarificationLimit')) return 'clarification:cluster+limit';
  return keys.map(k => {
    if (k === 'graphClusterFirst') return 'param:graphClusterFirst';
    if (k === 'clarificationLimit') return 'param:clarificationLimit';
    return 'param:' + k;
  }).join('+');
}
function operatorOf({ target, proposal, runtimeMutation } = {}) {
  if (proposal && REAL_OPERATORS.has(proposal.type)) return proposal.type;
  const dim = runtimeMutation?.parameters ? paramDimension(runtimeMutation.parameters) : null;
  if (dim) return dim;
  if (runtimeMutation?.text) return 'prompt:' + (target || 'prompt');
  // 历史运行的 proposal.type 是 bundle/graph 这类占位名，不能当成算子身份
  if (proposal?.type && proposal.type !== 'bundle' && !['graph', 'engine', 'optimizer_prompt', 'recognition_prompt'].includes(proposal.type)) return proposal.type;
  return target === 'optimizer_prompt' ? 'prompt:optimizer_prompt' : target === 'recognition_prompt' ? 'prompt:recognition_prompt' : target || 'unknown';
}

// 失败族索引：case_id → 该题在父代里暴露的错误族（按优先级取第一个）。
function familyIndex(rows = []) {
  const map = new Map();
  for (const row of rows) {
    if (row.strict) continue;
    try {
      const dx = require('./rsi-learning').diagnoseError(row);
      map.set(row.case_id, dx.errorFamilies?.length ? dx.errorFamilies : [dx.errorFamily || 'unclassified']);
    } catch (_) { map.set(row.case_id, [row.errorFamily || 'unclassified']); }
  }
  return map;
}

// 候选在生成时就要标好「打的是哪个族、几道题」，评测后不再猜。
function describeArm(candidate = {}, ctx = {}) {
  const operator = operatorOf(candidate);
  const evidence = candidate.proposal?.evidence_cases || [];
  const familyByCase = ctx.familyByCase || new Map();
  // A6 一次改 N 个意图，它的"覆盖量"是簇大小，不是证据条数——回收率统计必须按真实覆盖算。
  const clusterSize = Array.isArray(candidate.proposal?.targets) ? candidate.proposal.targets.length : 0;
  let family = GLOBAL_FAMILY, targeted = clusterSize || Math.max(1, evidence.length);
  if (evidence.length) {
    const votes = new Map();
    for (const id of evidence) for (const f of (familyByCase.get(id) || ['unclassified'])) votes.set(f, (votes.get(f) || 0) + 1);
    family = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'unclassified';
  } else if (candidate.target === 'engine' || candidate.target === 'optimizer_prompt') {
    family = GLOBAL_FAMILY;
    targeted = 1;
  } else if (ctx.dominantFamily) {
    family = ctx.dominantFamily;
  }
  // key 用「精确取值」以便和学习层去重对齐；operator 用维度，便于跨取值累计胜率。
  const signature = candidate.runtimeMutation?.parameters ? paramSignature(candidate.runtimeMutation.parameters) : null;
  return { key: `${candidate.target || 'graph'}|${signature || operator}|${family}`, operator, family, targeted, signature };
}

function newArm(meta) {
  return { ...meta, attempts: 0, measuredAttempts: 0, uncomparableAttempts: 0, comparisons: [], wins: 0, fixes: 0, broken: 0, targeted: 0, gainSum: 0, gainMax: null, lastAt: null, runIds: [] };
}

function historicalTrainScore(branch, entry) {
  for (const [source, value] of [
    ['branch.fullScores.train.strict_pct', branch?.fullScores?.train?.strict_pct],
    ['branch.scores.trainStrict', branch?.scores?.trainStrict],
    ['branch.scores.train.strict_pct', branch?.scores?.train?.strict_pct],
    ['archive.fullScores.train.strict_pct', entry?.fullScores?.train?.strict_pct],
    ['archive.trainScores.strict_pct', entry?.trainScores?.strict_pct],
  ]) if (Number.isFinite(value)) return { source, value };
  return { source: null, value: null };
}

/**
 * 从历史运行折叠出策略记忆。幂等：同一份 state 反复调用结果相同。
 * @param {object} state 任务状态（evolveRuns / archive / baseline）
 * @param {object} opts  {cases}
 */
function summarize(state = {}, opts = {}) {
  const runs = Array.isArray(state.evolveRuns) ? state.evolveRuns : [];
  const archive = Array.isArray(state.archive) ? state.archive : [];
  const archiveBy = new Map();
  for (const e of archive) if (e?.runId && e?.branchId) archiveBy.set(`${e.runId}:${e.branchId}`, e);
  const baselineFail = familyIndex(state.baseline?.results || []);

  const arms = new Map();
  const families = new Map();
  const operators = new Map();
  let candidateCount = 0, measuredCount = 0, promotedCount = 0, ignoredCandidateCount = 0;
  // 候选生命周期（10-30 审计 P0）：attempted / probed / measured / gated / adopted 必须分开记。
  // 此前只有 attempts 与 measuredAttempts 两个桶，"提过案但没跑出测量"与"根本没提过"混为一谈。
  const lifecycle = { attempted: 0, probed: 0, measured: 0, gated: 0, adopted: 0 };
  // 旧引擎或旧口径上试过的算子与失败族：算「试过」，不算「测得收益」
  const staleTried = new Set(), staleFamilies = new Set();
  const currentRevision = state.baseline?.scores?.engineRev;
  // 无基线引擎指纹时不能判定兼容——保守跳过而非全部视为兼容
  const compatible = rev => !!currentRevision && !!rev && ['engineSha','protoRev','engineMode'].every(key=>rev[key]===currentRevision[key]);

  for (const run of runs) {
    for (const branch of Object.values(run.branches || {})) {
      if (!branch || !branch.id || branch.op === 'root') continue;
      const entry = archiveBy.get(`${run.id}:${branch.id}`);
      const measuredRevision = run.engineRev || run.context?.engineRev || branch.fullScores?.engineRev || branch.engineRev || entry?.fullScores?.engineRev;
      const measured = !!(branch.fullScores || branch.scores || entry?.trainScores);
      const arm = branch.arm || entry?.arm || describeArm({ target: branch.target, proposal: branch.proposal ?? entry?.proposal, runtimeMutation: branch.runtimeMutation ?? entry?.runtimeMutation },
        { familyByCase: baselineFail, dominantFamily: undefined });
      // 换引擎后历史候选不能用于收益判断（口径不可比），但它确实被尝试过。
      // 10-30 审计：此前这类候选被整条 continue 掉，于是这些算子又回到「尚未尝试」，
      // 策略记忆失忆，重测时会重复搜索。这里把「试过」和「测得出收益」分开记。
      if (!compatible(measuredRevision) && (measuredRevision || branch.fullScores || branch.scores || entry?.trainScores)) {
        ignoredCandidateCount++;
        lifecycle.attempted++;
        if (branch.probe) lifecycle.probed++;
        if (arm.operator) staleTried.add(arm.operator);
        if (arm.family && arm.family !== GLOBAL_FAMILY) staleFamilies.add(arm.family);
        continue;
      }
      candidateCount++;
      lifecycle.attempted++;
      if (branch.probe) lifecycle.probed++;
      if (measured) lifecycle.measured++;
      if (['gated', 'probe_rejected', 'diagnostic_complete', 'pruned'].includes(branch.status)) lifecycle.gated++;
      if (branch.status === 'adopted') lifecycle.adopted++;
      const a = arms.get(arm.key) || newArm({ key: arm.key, target: branch.target || 'graph', operator: arm.operator, family: arm.family });
      arms.set(arm.key, a);   // 漏了这行会让所有臂只活在局部变量里，排序永远等于「全部没试过」
      a.attempts++;
      if (!a.runIds.includes(run.id)) a.runIds.push(run.id);
      a.lastAt = branch.evaluatedAt || branch.createdAt || run.at || a.lastAt;
      const parent = run.branches?.[branch.parent];
      const parentEntry = archiveBy.get(`${run.id}:${branch.parent}`);
      const parentReading = historicalTrainScore(parent, parentEntry);
      const ownReading = historicalTrainScore(branch, entry);
      const parentScore = parentReading.value, ownScore = ownReading.value;
      const comparable = measured && Number.isFinite(ownScore) && Number.isFinite(parentScore);
      if (measured && !comparable) a.uncomparableAttempts++;
      if (comparable) {
        measuredCount++;
        a.measuredAttempts++;
        const delta = ownScore - parentScore;
        a.comparisons.push({ runId: run.id, branchId: branch.id, parentBranchId: branch.parent,
          parentSource: parentReading.source, ownSource: ownReading.source, before: parentScore, after: ownScore, delta });
        a.gainSum += delta;
        a.gainMax = a.gainMax == null ? delta : Math.max(a.gainMax, delta);
        if (delta >= 1 || branch.status === 'alive') a.wins++;
        if (branch.status === 'alive') promotedCount++;
      }
      // 优先用「相对父代」的修/破（McNemar 口径）；旧记录只有相对基线的 fixedCases。
      const fixes = comparable ? (entry?.armFixes?.length ?? entry?.fixedCases?.length ?? 0) : 0;
      const broken = comparable ? (entry?.armBroken?.length ?? entry?.brokenCases?.length ?? 0) : 0;
      const targeted = comparable ? (Number(entry?.targeted) > 0 ? Number(entry.targeted) : arm.targeted) : 0;
      a.fixes += fixes; a.broken += broken; a.targeted += targeted;

      if (arm.family !== GLOBAL_FAMILY) {
        const pri = FAMILY_PRIOR[arm.family] || FAMILY_PRIOR.unclassified;
        const f = families.get(arm.family) || { family: arm.family, label: pri.label, fixableBy: pri.fixableBy, prior: pri.prior,
          attempts: 0, measuredAttempts: 0, wins: 0, fixes: 0, broken: 0, targeted: 0, operators: new Map() };
        if (comparable) f.measuredAttempts++;
        f.attempts++; f.fixes += fixes; f.broken += broken; f.targeted += targeted;
        if (measured && Number.isFinite(ownScore) && Number.isFinite(parentScore) && (ownScore - parentScore >= 1 || branch.status === 'alive')) f.wins++;
        f.operators.set(arm.operator, (f.operators.get(arm.operator) || 0) + 1);
        families.set(arm.family, f);
      }
      const o = operators.get(arm.operator) || { operator: arm.operator, label: OPERATOR_LABEL[arm.operator] || arm.operator, attempts: 0, measuredAttempts: 0, wins: 0, fixes: 0, broken: 0, targeted: 0 };
      if (comparable) o.measuredAttempts++;
      o.attempts++; o.wins += (measured && Number.isFinite(ownScore) && Number.isFinite(parentScore) && (ownScore - parentScore >= 1 || branch.status === 'alive')) ? 1 : 0;
      o.fixes += fixes; o.broken += broken; o.targeted += targeted;
      operators.set(arm.operator, o);
    }
  }

  // 经验贝叶斯：实测修正 + 先验伪计数，样本少时退回先验，样本多时以实测为准。
  // 失败族底数必须与分层指标同源：候选没覆盖到的族也可能有大量失败题。
  // 取「候选实测覆盖数」与「stageMetrics 归因数」的较大者，并标注来源，
  // 避免摘要显示的失败分布与短板表打架（10-30 Codex 审计 P0）。
  const stageFamilies = (() => {
    try {
      const m = require('./rsi-metrics').stageMetrics(state.baseline?.results || [], { target: Number(state.goal?.target) || 85 });
      const out = new Map();
      for (const d of (m.deficits || [])) {
        const family = STAGE_FAMILY[d.stage];
        if (!family) continue;
        out.set(family, (out.get(family) || 0) + (Number(d.caseCount) || 0));
      }
      return { families: out, overall: m.overall, total: m.total };
    } catch (_) { return { families: new Map(), overall: null, total: 0 }; }
  })();
  for (const [family, cases] of stageFamilies.families) {
    if (!families.has(family) && cases > 0) {
      const pri = FAMILY_PRIOR[family] || FAMILY_PRIOR.unclassified;
      families.set(family, { family, label: pri.label, fixableBy: pri.fixableBy, prior: pri.prior,
        attempts: 0, measuredAttempts: 0, wins: 0, fixes: 0, broken: 0, targeted: 0, operators: new Map() });
    }
  }
  const familyRows = [...families.values()].map(f => {
    const fused = (f.fixes + f.prior * PRIOR_WEIGHT) / (f.targeted + PRIOR_WEIGHT);
    const stageCases = stageFamilies.families.get(f.family) || 0;
    return {
      family: f.family, label: f.label, fixableBy: f.fixableBy,
      failedCases: Math.max(f.targeted, stageCases), measuredFailedCases: f.targeted, stageFailedCases: stageCases,
      failedCasesSource: stageCases > f.targeted ? 'stage_metrics' : f.targeted > 0 ? 'candidates' : 'none',
      attempts: f.attempts, measuredAttempts: f.measuredAttempts, wins: f.wins, fixes: f.fixes, broken: f.broken,
      prior: f.prior, rate: +fused.toFixed(3),
      source: f.targeted >= PRIOR_WEIGHT ? 'measured' : f.targeted > 0 ? 'blended' : 'prior',
      winRate: round(f.measuredAttempts ? f.wins / f.measuredAttempts : 0, 3),
      operators: [...f.operators.entries()].sort((a, b) => b[1] - a[1]).map(([operator, n]) => ({ operator, attempts: n })),
    };
  }).sort((a, b) => b.failedCases - a.failedCases || b.attempts - a.attempts);

  const rateOf = Object.fromEntries(familyRows.map(f => [f.family, f.rate]));
  for (const key of Object.keys(FAMILY_PRIOR)) if (rateOf[key] == null) rateOf[key] = FAMILY_PRIOR[key].prior;

  const armRows = [...arms.values()].map(a => ({
    ...a,
    winRate: round(a.measuredAttempts ? a.wins / a.measuredAttempts : 0, 3),
    meanGain: round(a.measuredAttempts ? a.gainSum / a.measuredAttempts : 0, 2),
    fixRate: round(a.targeted ? a.fixes / a.targeted : 0, 3),
    dead: a.measuredAttempts >= DEAD_ATTEMPTS && a.wins === 0 && a.gainSum <= 0,
  })).sort((a, b) => b.attempts - a.attempts || (b.gainMax ?? -99) - (a.gainMax ?? -99));

  const operatorRows = [...operators.values()].map(o => ({
    ...o, winRate: round(o.measuredAttempts ? o.wins / o.measuredAttempts : 0, 3),
    fixRate: round(o.targeted ? o.fixes / o.targeted : 0, 3),
    dead: o.measuredAttempts >= DEAD_DIMENSION && o.wins === 0,
  })).sort((a, b) => b.attempts - a.attempts);

  // 未尝试过的动作：先验表里登记过、但本任务一次都没试的算子。
  // 「尝试过」必须按 attempts 算，不能按 measuredAttempts 算：
  // 之前把「提过案但没跑出测量」的动作列进「尚未尝试」，模型于是反复重提同一条死路
  //（10-30 审计 P0：42 个候选、1 个 measured、0 promoted，摘要却说 A2/澄清类动作"尚未尝试"）。
  const attemptedOps = new Set([...armRows.filter(a => a.attempts > 0).map(a => a.operator), ...staleTried]);
  const attemptedUnmeasured = armRows.filter(a => a.attempts > 0 && a.measuredAttempts === 0).map(a => a.operator);
  const deadOps = new Set(operatorRows.filter(o => o.dead).map(o => o.operator));
  // stalled：反复尝试却一次测量都没跑出来（提案契约/执行链问题，不是机制无效），
  // 与 dead（实测多次无胜绩）分开报，否则会把「跑不起来」误读成「改了没用」。
  const stalled = operatorRows.filter(o => o.attempts >= DEAD_ATTEMPTS && o.measuredAttempts === 0).map(o => o.operator);
  const untried = [...new Set(Object.values(FAMILY_PRIOR).flatMap(f => f.operators))].filter(op => !attemptedOps.has(op) && !deadOps.has(op));
  const untriedClean = untried.filter(op => !deadOps.has(op));

  const summary = {
    version: 2, generatedAt: new Date().toISOString(),
    runCount: runs.length, candidateCount, measuredCount, promotedCount, ignoredCandidateCount,
    lifecycle,
    successRate: round(measuredCount ? promotedCount / measuredCount : 0, 3),
    arms: armRows, families: familyRows, operators: operatorRows,
    deadArms: armRows.filter(a => a.dead).map(a => a.key),
    deadOperators: operatorRows.filter(o => o.dead).map(o => o.operator),
    deadDimensions: operatorRows.filter(o => o.dead && /^(param:|clarification:)/.test(o.operator)).map(o => o.operator),
    stalledOperators: stalled,
    attemptedOperators: [...attemptedOps],
    attemptedUnmeasuredOperators: [...new Set(attemptedUnmeasured)],
    unmeasuredFamilies: familyRows.filter(f => f.failedCases > 0 && f.measuredAttempts === 0).map(f => f.family),
    untriedOperators: untriedClean,
    lifecycle,
    /** 旧引擎或旧口径上试过、当前口径无有效测量的算子：算尝试过，不算收益证据 */
    staleTriedOperators: [...staleTried],
    rates: rateOf,
    stageBasis: stageFamilies.overall ? { total: stageFamilies.total, strict_pct: stageFamilies.overall.strict_pct, gapPts: stageFamilies.overall.gapPts } : null,
  };
  summary.digest = digest(summary);
  summary.leverage = leverage(summary);
  return summary;
}

// 给模型看的「知识」而不是 16 条原始记录：哪些动作有效、哪些被证否、哪些还没试。
function digest(s = {}) {
  const parts = [];
  if(s.ignoredCandidateCount)parts.push(`已排除 ${s.ignoredCandidateCount} 个旧引擎或缺少版本凭证的候选，不用于当前算子收益判断`);
  const ops = (s.operators || []).filter(o => o.measuredAttempts > 0);
  if (ops.length) {
    parts.push('本任务实测：' + ops.map(o => {
      const tag = o.dead ? '已证否' : o.wins > 0 ? `${o.wins}/${o.measuredAttempts} 有效` : `${o.measuredAttempts} 次无收益`;
      return `${o.label} ${tag}（修 ${o.fixes} 破 ${o.broken}）`;
    }).join('；'));
  }
  if (s.lifecycle) parts.push(`候选生命周期：提交 ${s.lifecycle.attempted} → 训练探针 ${s.lifecycle.probed} → 完整评测 ${s.lifecycle.measured} → 未通过 ${s.lifecycle.gated} → 采纳 ${s.lifecycle.adopted}`);
  const unmeasured = (s.operators || []).filter(o => o.attempts > o.measuredAttempts);
  if (unmeasured.length) parts.push('生成/执行尝试未取得测量：' + unmeasured.map(o => `${o.label} ${o.attempts-o.measuredAttempts} 次`).join('；'));
  if (s.stalledOperators?.length) parts.push(`反复尝试但一次测量都没跑出来（先修提案/执行契约，别再换说法重提）：${s.stalledOperators.map(o => OPERATOR_LABEL[o] || o).join('、')}`);
  const fam = (s.families || []).filter(f => f.failedCases > 0).slice(0, 4);
  if (fam.length) parts.push('失败族（题数 / 回收率）：' + fam.map(f => `${f.label} ${f.failedCases} 题 ${(f.rate * 100).toFixed(0)}%（${f.source === 'prior' ? '先验' : `实测 ${f.fixes}/${f.failedCases}`}${f.failedCasesSource === 'stage_metrics' ? '，题数来自分层指标' : ''}）`).join('；'));
  if (s.deadOperators?.length) parts.push(`不要重复：${s.deadOperators.map(o => OPERATOR_LABEL[o] || o).join('、')} 在本任务已被证否`);
  if (s.untriedOperators?.length) parts.push(`尚未尝试：${s.untriedOperators.map(o => OPERATOR_LABEL[o] || o).join('、')}`);
  return parts.join('。') || '本任务暂无历史候选，按失败类型选择算子。';
}

// 每个失败族还有多少可回收空间、最优动作是否已证否。
function leverage(s = {}) {
  return (s.families || []).map(f => {
    const pri = FAMILY_PRIOR[f.family] || FAMILY_PRIOR.unclassified;
    const arms = (s.arms || []).filter(a => a.family === f.family).sort((a, b) => (b.winRate - a.winRate) || ((b.gainMax ?? -99) - (a.gainMax ?? -99)));
    const best = arms.find(a => !a.dead) || null;
    const expected = f.failedCases * f.rate;
    const deadOps = (s.deadOperators || []);
    const remaining = pri.operators.filter(op => !arms.some(a => a.operator === op && a.dead) && !deadOps.includes(op));
    return {
      family: f.family, failedCases: f.failedCases, rate: f.rate, expectedFixes: round(expected, 2),
      bestArm: best?.key || null, bestWinRate: best?.winRate ?? null,
      exhausted: arms.length > 0 && !best && remaining.length === 0,
      remainingOperators: remaining,
    };
  }).sort((a, b) => b.expectedFixes - a.expectedFixes);
}

// 全部失败族都没有可用动作（且已有足够证据）→ 别再烧预算。
function noLeverage(s = {}) {
  const rows = s.leverage || [];
  if (!rows.length) return { exhausted: false, reason: '暂无失败族归因' };
  if ((s.measuredCount || 0) < 3) return { exhausted: false, reason: '证据不足，至少需要 3 个完成测量的候选' };
  const live = rows.filter(r => !r.exhausted);
  if (live.length) return { exhausted: false, reason: `仍有可回收族：${live.slice(0, 3).map(r => r.family).join('、')}` };
  return { exhausted: true, reason: `所有失败族的最优动作均已证否：${rows.filter(r => r.exhausted).map(r => r.family).slice(0, 4).join('、')}` };
}

// 搜索调度：已证否的动作不再排前面；有胜绩的动作加权前移；没试过的保持基础轮转。
function policyFor(s = {}) {
  const byKey = new Map((s.arms || []).map(a => [a.key, a]));
  const dead = new Set(s.deadArms || []);
  // 从胜绩里反推出本任务实测有效的澄清候选数，下一轮直接把它排到网格第一位。
  let bestClarificationLimit = null, bestGain = -Infinity;
  for (const a of s.arms || []) {
    if (a.dead || !a.wins) continue;
    const m = /clarificationLimit=(\d+)/.exec(a.key || '') || /clarificationLimit=(\d+)/.exec(a.operator || '');
    if (!m) continue;
    if ((a.gainMax ?? 0) > bestGain) { bestGain = a.gainMax ?? 0; bestClarificationLimit = Number(m[1]); }
  }
  return {
    bestClarificationLimit,
    score(key) {
      const a = byKey.get(key);
      if (!a) return 0;                       // 没试过：不加权，保留原有轮转
      if (dead.has(key)) return -100;
      // 拉普拉斯收缩 + 尝试次数折扣：1 次胜绩不该压过没试过的动作，2/2 才稍微前移。
      const smoothed = (a.wins + 1) / (a.measuredAttempts + 2);
      return +((smoothed - 0.5) * Math.min(1, a.measuredAttempts / 3)).toFixed(4);
    },
    dead: (key, dimension) => dead.has(key) || (!!dimension && (s.deadDimensions || []).includes(dimension)),
    deadOperators: new Set(s.deadOperators || []),
    rateOf: family => (s.rates || {})[family] ?? FAMILY_PRIOR[family]?.prior ?? 0,
    digest: s.digest || '',
  };
}

// 预算分配：按「缺口 × 实测可修率」给每族配额，而不是均分。
function allocate(s = {}, total = 4) {
  const rows = (s.leverage || []).filter(r => r.expectedFixes > 0);
  const n = Math.max(1, Math.floor(total));
  if (!rows.length) return [];
  const weight = rows.reduce((sum, r) => sum + r.expectedFixes, 0);
  const quota = rows.map(r => ({ family: r.family, expectedFixes: r.expectedFixes, seats: Math.max(0, Math.floor(n * r.expectedFixes / weight)) }));
  let left = n - quota.reduce((a, b) => a + b.seats, 0);
  for (const q of quota.sort((a, b) => b.expectedFixes - a.expectedFixes)) { if (left <= 0) break; q.seats++; left--; }
  return quota.sort((a, b) => b.seats - a.seats);
}

module.exports = { FAMILY_PRIOR, GLOBAL_FAMILY, DEAD_ATTEMPTS, DEAD_DIMENSION, OPERATOR_LABEL, PRIOR_WEIGHT,
  paramSignature, paramDimension, operatorOf, familyIndex, describeArm, summarize, digest, leverage, noLeverage, policyFor, allocate };
