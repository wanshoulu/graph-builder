'use strict';
// 分层指标（stage metrics）——把评测结果拆成可归因的分环节精度，供规划器定点优化。
//
// 为什么需要这个模块（2026-10-30）：
// 评测层一直都有全部原始证据：每题的 resultType（correct/rank_error/recall_miss/
// clarify_not_triggered/clarify_missing_expected/multi_partial/multi_extra）、
// evidence.routes 里词法/向量/子图的候选、evidence.stages 里 deepseek_judge 等阶段、
// evidence.clarification 的 needed/missing/extra。但规划器拿到的只有 20 道题的明细，
// 没有人替它把这些明细汇总成「哪个环节精度最低、修好能救回几题」。
// 结果就是：模型每轮只能凭印象挑方向（先后试了 prompt、参数、A6 别名），
// 四轮都没打到真正的短板，探针零效果，最后按 noImproveLimit 停机。
//
// 本模块的输出是一张排序后的短板表：
//   deficits[0] = {stage, label, cases, gainPts, actions:[可用的动作空间]}
// 规划器的任务因此从「猜根因」变成「在给定动作空间里攻最短板」。

const CASE_SHAPES = ['single_intent', 'multi_intent', 'ambiguous_intent', 'negative_intent'];
const SHAPE_LABEL = {
  single_intent: '单意图', multi_intent: '多意图', ambiguous_intent: '模糊意图', negative_intent: '负例',
};

// resultType → 失败环节 + 可用动作空间。
// actions 里的键名必须与系统真实授权的能力对齐（GRAPH_OPERATORS / ENGINE_PARAMETERS /
// recognition_prompt 的 judge|shape|boundary），否则模型会写出执行不了的提案。
// 词表与 routes/rsi-case-scoring.js 的 scoreIntentCase 严格对齐（2026-10-30 校准）。
// 之前只按 intent-rsi.js 的旧 evalCase 猜标签，会漏掉 multi_missing_extra /
// clarify_unanswerable / unexpected_clarification / negative_violation 这类实际大量出现的类型，
// 导致短板表把整片失败题归入 untyped，规划器看到的排序是错的。
const FAULT = {
  // —— 召回 / 排序 / 裁决（单意图为主）
  recall_miss: {
    stage: 'recall', label: '召回缺失（top1 为空，候选里找不到正确意图）',
    actions: ['graph:A1_utterance_expand（补说法）', 'graph:A4_description_rewrite（补语义描述）', 'graph:A3_clause_expansion（补子句模式）'],
  },
  rank_error: {
    stage: 'judge_rank', label: '排序错误（期望在候选内但没被置顶）',
    actions: ['recognition_prompt:judge（强化排序证据）', 'graph:A2_disambiguation（拉开区分度）', 'engine:打分权重参数'],
  },
  wrong_label: {
    stage: 'judge_select', label: '裁决选错（候选里没有正确意图，选了错误标签）',
    actions: ['graph:A2_disambiguation（增加排斥线索）', 'engine:negativePenalty / 阈值参数'],
  },
  // —— 澄清
  clarify_not_triggered: {
    stage: 'clarify_trigger', label: '澄清未触发（模糊题应澄清却直接判定）',
    actions: ['graph:A6_ambiguity_cluster_expand（声明歧义簇）', 'graph:A2_disambiguation（补歧义信号）', 'engine:clarificationLimit / negativePenalty'],
  },
  clarify_missing_expected: {
    stage: 'clarify_options', label: '澄清选项缺期望意图',
    actions: ['graph:A6_ambiguity_cluster_expand（补簇成员）', 'graph:A2_disambiguation（收窄范围）', 'recognition_prompt:boundary（选项边界）'],
  },
  clarify_extra_options: {
    stage: 'clarify_options', label: '澄清选项越界/重复/精度不足',
    actions: ['graph:A2_disambiguation（scope_out 收边）', 'recognition_prompt:boundary（选项数量与边界）', 'engine:clarificationLimit'],
  },
  clarify_unanswerable: {
    stage: 'clarify_question', label: '澄清问题本身没问到点上（缺关键术语）',
    actions: ['graph:A5_clarification_text（澄清问法）', 'recognition_prompt:boundary'],
  },
  clarify_ok_set: {
    stage: 'clarify_over', label: '单意图被误澄清（选项集合对但不应澄清）',
    actions: ['engine:clarificationLimit（收紧）', 'recognition_prompt:boundary（抑制误澄清）'],
  },
  unexpected_clarification: {
    stage: 'clarify_over', label: '多意图答案正确却多余触发澄清',
    actions: ['engine:clarificationLimit（收紧）', 'recognition_prompt:judge'],
  },
  // —— 多意图切分
  multi_missing: {
    stage: 'composite_split', label: '多意图漏识别（子句没切出来）',
    actions: ['graph:A3_clause_expansion（子句模式）', 'engine:subclause_min（子句阈值）', 'graph:A1_utterance_expand'],
  },
  multi_missing_extra: {
    stage: 'composite_split', label: '多意图既漏又多（切分与收边同时错）',
    actions: ['graph:A3_clause_expansion + A2_disambiguation（组合）', 'engine:subclause_min'],
  },
  multi_extra: {
    stage: 'composite_over', label: '多意图多出意图（子句被过度匹配）',
    actions: ['graph:A2_disambiguation（scope_out）', 'engine:subclause_min 提高'],
  },
  multi_wrong: {
    stage: 'composite_split', label: '多意图子任务判错',
    actions: ['graph:A3_clause_expansion', 'recognition_prompt:shape（切分指令）'],
  },
  // —— 负例
  negative_violation: {
    stage: 'negative_guard', label: '负例未被拒答（给出了业务意图或选项）',
    actions: ['graph:A2_disambiguation（排斥边界）', 'recognition_prompt:boundary'],
  },
  missing_turn: { stage: 'multi_turn', label: '多轮缺轮次', actions: [] },
};

const pct = (n, d) => (d ? Number(((100 * n) / d).toFixed(1)) : null);
const idOf = c => (typeof c === 'string' ? c : (c && (c.intent_id || c.id || c.value)) || null);

function obsOf(row) {
  if (row.observations) return row.observations;
  const ev = row.evidence || {};
  const routes = Object.values(ev.routes || {}).filter(c => c && c.status === 'completed');
  const recalled = new Set(routes.flatMap(c => (c.rows || []).map(idOf).filter(Boolean)));
  const expected = Array.isArray(row.expected) ? row.expected : [];
  const options = (row.predicted && row.predicted.candidates) || (ev.clarification && ev.clarification.options) || [];
  const optionIds = [...new Set(options.map(idOf).filter(Boolean))];
  const needed = ev.clarification ? ev.clarification.needed === true : null;
  return {
    recall: {
      status: routes.length ? 'observed' : 'unobserved',
      expectedSeen: expected.filter(id => recalled.has(id)),
      notObservedExpectedIds: routes.length ? expected.filter(id => !recalled.has(id)) : null,
    },
    clarification: {
      needed,
      optionIds,
      missingExpectedIds: needed === true ? expected.filter(id => !optionIds.includes(id)) : null,
      extraOptionIds: optionIds.filter(id => !expected.includes(id)),
    },
    decision: { mode: (ev.decision && ev.decision.mode) || null, bypassedJudge: (ev.decision && ev.decision.mode) === 'deterministic_agree' },
  };
}

// 按通道统计「期望意图是否被该通道召回」——这才是词法/向量/子图各自的召回精度。
function channelStats(rows) {
  const out = {};
  for (const key of ['lexical', 'vector', 'subgraph']) {
    let observed = 0, error = 0, unavailable = 0, hitCases = 0, hitExpect = 0, totalExpect = 0;
    for (const row of rows) {
      const ch = (row.evidence && row.evidence.routes && row.evidence.routes[key]) || null;
      if (!ch || ch.status === 'unobserved') continue;
      if (ch.status === 'unavailable') { unavailable++; continue; }
      if (ch.status === 'error') { error++; continue; }
      observed++;
      const ids = new Set((ch.rows || []).map(idOf).filter(Boolean));
      const expected = Array.isArray(row.expected) ? row.expected : [];
      if (!expected.length) continue;
      const hit = expected.filter(id => ids.has(id)).length;
      totalExpect += expected.length;
      hitExpect += hit;
      if (hit > 0) hitCases++;
    }
    out[key] = {
      observedCases: observed, errorCases: error, unavailableCases: unavailable,
      recall_pct: pct(hitExpect, totalExpect),
      case_hit_pct: pct(hitCases, observed),
    };
  }
  return out;
}

/**
 * @param {Array} rows 完整评测行（含 case_id/shape/strict/relaxed/resultType/expected/evidence|observations）
 * @param {{target?:number, metric?:string}} opts target=验收目标精度（默认 85）
 */
function stageMetrics(rows, opts = {}) {
  const list = Array.isArray(rows) ? rows.filter(r => r && typeof r === 'object') : [];
  const target = Number.isFinite(opts.target) ? opts.target : 85;
  const total = list.length;
  if (!total) return { total: 0, target, note: '本轮无评测行，无法计算分层指标' };

  const correct = list.filter(r => r.strict).length;
  const overall = { strict_pct: pct(correct, total), correct, total, target, gapPts: +Math.max(0, target - pct(correct, total)).toFixed(1) };

  // ① 题型精度
  const byShape = {};
  for (const s of CASE_SHAPES) byShape[s] = { total: 0, correct: 0 };
  const shapeRows = [];
  for (const r of list) {
    const s = CASE_SHAPES.includes(r.shape) ? r.shape : 'ambiguous_intent';
    byShape[s].total++; if (r.strict) byShape[s].correct++;
  }
  for (const s of CASE_SHAPES) {
    const b = byShape[s];
    if (!b.total) continue;
    const p = pct(b.correct, b.total);
    shapeRows.push({
      shape: s, label: SHAPE_LABEL[s], total: b.total, correct: b.correct, failed: b.total - b.correct,
      strict_pct: p, // 该题型离目标差几题（用于判断"修好它能拿几题"）
      gapCases: Math.max(0, Math.ceil((target * b.total) / 100 - 1e-9) - b.correct),
    });
  }
  shapeRows.sort((a, b) => b.failed - a.failed);

  // ② 失败环节分布（resultType 就是阶段归因标签）
  const faults = {};
  const untyped = [];
  for (const r of list) {
    if (r.strict) continue;
    const t = r.resultType && FAULT[r.resultType] ? r.resultType : null;
    if (!t) { untyped.push(r.case_id); continue; }
    faults[t] = (faults[t] || 0) + 1;
  }
  const failed = total - correct;
  const deficitRows = Object.entries(faults).map(([type, cases]) => {
    const meta = FAULT[type];
    return {
      stage: meta.stage, fault: type, label: meta.label, cases: failed ? +(100 * cases / total).toFixed(1) : 0,
      caseCount: cases, gainPts: +(100 * cases / total).toFixed(1),
      actions: meta.actions,
    };
  }).sort((a, b) => b.gainPts - a.gainPts || a.stage.localeCompare(b.stage));

  // ③ 召回通道精度（词法 / 向量 / 子图）
  const channels = channelStats(list);

  // ④ 澄清阶段细分（只模糊题）：优先用评分器已算好的 clarification_quality
  const amb = list.filter(r => r.shape === 'ambiguous_intent');
  let ambTriggered = 0, ambMissing = 0, ambCovered = 0, extraSum = 0, ambExtraZero = 0;
  let qCov = 0, qPrec = 0, qCount = 0, qDup = 0, qUnanswerable = 0, qRows = 0;
  for (const r of amb) {
    const o = obsOf(r);
    const c = o.clarification || {};
    const q = r.clarification_quality || null;
    if (q) {
      qRows++; qCov += Number(q.coverage) || 0; qPrec += Number(q.precision) || 0;
      qCount += Number(q.option_count) || 0; qDup += Number(q.duplicate_count) || 0;
      if (q.answerable === false) qUnanswerable++;
    }
    if (c.needed === true) {
      ambTriggered++;
      const miss = (c.missingExpectedIds || []).length;
      if (miss) ambMissing++; else ambCovered++;
      const extra = (c.extraOptionIds || []).length;
      extraSum += extra;
      if (!extra) ambExtraZero++;
    }
  }
  const clarification = amb.length ? {
    total: amb.length,
    trigger_pct: pct(ambTriggered, amb.length),
    option_cover_pct: pct(ambCovered, ambTriggered),
    missing_cases: ambMissing,
    avg_extra_options: +(extraSum / Math.max(1, ambTriggered)).toFixed(1),
    clean_option_pct: pct(ambExtraZero, ambTriggered),
    // 评分器口径（存在时）：覆盖/精度/选项数/重复/问法可答
    ...(qRows ? {
      gold_coverage_pct: +(100 * qCov / qRows).toFixed(1),
      gold_precision_pct: +(100 * qPrec / qRows).toFixed(1),
      avg_option_count: +(qCount / qRows).toFixed(1),
      duplicate_total: qDup,
      unanswerable_cases: qUnanswerable,
    } : {}),
  } : null;

  // ⑤ 裁决阶段
  let judgeRan = 0, judgeBypassed = 0, judgeObserved = 0;
  for (const r of list) {
    const d = (obsOf(r).decision) || {};
    if (d.mode == null) continue;
    judgeObserved++;
    if (d.bypassedJudge) judgeBypassed++; else judgeRan++;
  }
  const judge = judgeObserved ? { observed: judgeObserved, ran_pct: pct(judgeRan, judgeObserved), bypassed_cases: judgeBypassed } : null;

  // ⑥ 召回质量：期望路径上的召回缺失题数（与 resultType 交叉校验）
  let recallMissCases = 0, recallObserved = 0;
  for (const r of list) {
    const o = obsOf(r);
    if (!o.recall || o.recall.status !== 'observed') continue;
    recallObserved++;
    if ((o.recall.notObservedExpectedIds || []).length) recallMissCases++;
  }

  return {
    total, target, overall,
    byShape: shapeRows,
    deficits: deficitRows,
    weakest: deficitRows.slice(0, 3).map(d => d.stage),
    channels, clarification, judge,
    recall: { observedCases: recallObserved, casesWithMiss: recallMissCases, case_miss_pct: pct(recallMissCases, recallObserved) },
    untypedFailures: untyped.length,
    summary: buildSummary({ overall, shapeRows, deficitRows, channels, clarification }),
  };
}

function buildSummary({ overall, shapeRows, deficitRows, channels, clarification }) {
  const parts = [`总 ${overall.strict_pct}%（${overall.correct}/${overall.total}），目标 ${overall.target}%，差 ${overall.gapPts}pp`];
  if (shapeRows.length) {
    parts.push('题型 ' + shapeRows.map(s => `${s.label} ${s.strict_pct}%（${s.correct}/${s.total}）`).join(' / '));
  }
  if (deficitRows.length) {
    parts.push('最短板 ' + deficitRows.slice(0, 2).map(d => `${d.label} ${d.caseCount}题≈${d.gainPts}pp`).join('；'));
  }
  const ch = Object.entries(channels || {}).filter(([, v]) => v.observedCases > 0)
    .map(([k, v]) => `${k} ${v.recall_pct}%`).join(' ');
  if (ch) parts.push('通道召回 ' + ch);
  if (clarification) parts.push(`澄清触发 ${clarification.trigger_pct}%（${clarification.total}题模糊）`);
  return parts.join('；');
}

module.exports = { CASE_SHAPES, SHAPE_LABEL, FAULT, stageMetrics, channelStats };
