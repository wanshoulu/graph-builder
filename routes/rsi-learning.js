'use strict';
const { ENGINE_PARAMETERS, normalizeProfile } = require('./rsi-runtime-profile');

function trainingFeedback(st, branchId) {
  const allowed = new Set(st.split?.train || []);
  const rows = st.branches?.[branchId]?.evaluationResults ?? st.baseline?.results ?? [];
  return rows.filter(r => allowed.has(r.case_id) && !r.strict).map(r => ({ ...r, ...diagnoseError(r) }));
}

function diagnoseError(row = {}) {
  const type = row.resultType || '';
  const families = [];
  const add = family => { if (!families.includes(family)) families.push(family); };
  if (row.strict) return { errorFamily: null, errorFamilies: [], diagnosis: row.diagnosis || {} };
  if (type === 'engine_error') add('engine_error');
  if (/multi_/.test(type)) {
    if (row.diagnosis?.missing?.length || /missing|partial|no_hit/.test(type)) add('multi_missing');
    if (row.diagnosis?.extra?.length || /extra/.test(type)) add('multi_extra');
    if (row.diagnosis?.wrong?.length || /wrong/.test(type)) add('multi_task_constraints');
  }
  if (/extra_options/.test(type)) add('clarification_precision');
  else if (/unanswerable/.test(type)) add('clarification_question');
  else if (/clarify_not_triggered/.test(type)) add('clarification_trigger');
  else if (/clarify_missing/.test(type)) add('clarification_coverage');
  else if (/clarify_ok_set|unexpected_clarification/.test(type)) add('unnecessary_clarification');
  if (type === 'rank_error') add('ranking');
  if (type === 'wrong_label') add('wrong_label');
  if (type === 'recall_miss') add('recall');
  if (type === 'negative_violation') add('negative_boundary');
  if (!families.length) add(row.errorFamily || 'unclassified');
  return { errorFamily: families[0], errorFamilies: families, diagnosis: row.diagnosis || {} };
}

function selectTrainingFeedback(rows = [], limit = 16, generation = 1, weights = null) {
  const cap = Math.max(0, Math.floor(Number(limit)) || 0);
  const turn = Math.max(0, Math.floor(Number(generation) || 1) - 1);
  const groups = new Map();
  for (const row of rows) {
    if (row.strict) continue;
    const diagnosed = { ...row, ...diagnoseError(row) };
    const group = groups.get(diagnosed.errorFamily) || [];
    group.push(diagnosed); groups.set(diagnosed.errorFamily, group);
  }
  const keys = [...groups.keys()].sort();
  if (!keys.length || !cap) return [];
  const offset = turn % keys.length;
  const ordered = [...keys.slice(offset), ...keys.slice(0, offset)];
  const queues = ordered.map(key => {
    const group = groups.get(key), start = Math.floor(turn / keys.length) % group.length;
    return [...group.slice(start), ...group.slice(0, start)];
  });
  // 按「缺口 × 实测可修率」分配反馈席位：有杠杆的族多给坏例，没杠杆的族不再占一半预算。
  // 不传权重时保持原来的轮转（兼容旧调用与测试）。
  const seats = queues.map((_, i) => (weights ? Math.max(0, Math.floor(Number(weights[ordered[i]]) || 0)) : Infinity));
  const selected = [];
  if (weights) {
    const left = seats.map((n, i) => Math.min(n, queues[i].length));
    while (left.some(n => n > 0) && selected.length < cap) {
      for (let i = 0; i < queues.length && selected.length < cap; i++) {
        if (left[i] > 0 && queues[i].length) { selected.push(queues[i].shift()); left[i]--; }
      }
    }
  }
  while (selected.length < cap && queues.some(q => q.length)) {
    for (const q of queues) if (q.length && selected.length < cap) selected.push(q.shift());
  }
  return selected;
}

function searchMemory(records = [], target) {
  return records.filter(r => !target || r.target === target).slice(-16).map(r => ({
    target: r.target, method: r.method, hypothesis: r.hypothesis,
    mutation: r.mutation, trainGain: r.trainGain ?? null,
    // Validation may select candidates, but its outcomes/reasons must not feed search.
    trainingOutcome: r.trainGain == null ? 'unmeasured' : r.trainGain > 0 ? 'gain' : r.trainGain < 0 ? 'regression' : 'no_gain',
    independentValidated: !!r.independentValidated,
  }));
}

function parameterMutations(graph, history = [], generation = 1, failures = [], policy = null) {
  const { assetHash, mutateRuntime } = require('./rsi-optimization');
  const { paramSignature, paramDimension } = require('./rsi-strategy');
  const current = normalizeProfile(graph.meta?.rsi_runtime || {}).engine;
  const defaults = { hintWeight: 0.28, clauseWeight: 0.30, lexicalWeight: 0.72, actionWeight: 0.62,
    negativePenalty: 1, clarificationLimit: 6, graphClusterFirst: false };
  const seen = new Set(history.map(r => r.artifactHash).filter(Boolean));
  const add = (bucket, parameters, motivation) => {
    const mutation = { target: 'engine', parameters, motivation };
    const hash = assetHash(mutateRuntime(graph, mutation));
    if (Object.entries(parameters).every(([k, v]) => v === (current[k] ?? defaults[k])) || seen.has(hash)) return;
    seen.add(hash);
    mutation.armKey = `engine|${paramSignature(parameters)}|engine_global`;
    mutation.armDimension = paramDimension(parameters);
    bucket.push(mutation);
  };
  const ambiguous = failures.some(r => r.shape === 'ambiguous_intent');
  const currentLimit = current.clarificationLimit ?? defaults.clarificationLimit;
  const grid = [], oneD = [];
  // 审计实验（2026-10-19）：12 道训练模糊题，只有 graphClusterFirst=true 且
  // clarificationLimit=3 的二维组合把 strict 从 8.3% 拉到 33.3%；单改澄清数完全无效。
  // 原坐标下降只翻布尔或 ±2，走不到这个点，所以这里显式枚举二维网格。
  if (ambiguous) {
    const limits = [...new Set([3, 4, 5, Math.max(2, currentLimit - 2), currentLimit + 2, 8, 12])]
      .filter(v => v >= 2 && v <= 12).sort((a, b) => Math.abs(a - 3) - Math.abs(b - 3));
    // 已证否的组合不再占用第一顺位；本任务实测有效的澄清数前移，没测过才回落到 3。
    // Number(null)===0 会被当成合法澄清数，必须先判 null
    const learnedLimit = Number.isFinite(policy?.bestClarificationLimit) ? Number(policy.bestClarificationLimit) : null;
    const ordered = learnedLimit != null ? [learnedLimit, ...limits.filter(v => v !== learnedLimit)] : limits;
    for (const limit of ordered) add(grid, { graphClusterFirst: true, clarificationLimit: limit },
      limit === learnedLimit ? `联合检验：本任务实测有效的澄清数 ${limit} × 候选簇优先` : `联合检验：候选簇优先 × 澄清候选数 ${limit}`);
    add(grid, { graphClusterFirst: true }, '单杠杆：仅开启候选簇优先，保持现有澄清数');
    add(grid, { clarificationLimit: 3 }, '对照组：仅收紧澄清候选数到 3（实测单独无效，用于留痕）');
    // 沉淀的行为开关联合探索：模糊意图失败时检验整句匹配与短词召回的行为组合
    add(grid, { wholeExpressionMatch: !(current.wholeExpressionMatch ?? true) }, '联合检验：切换A6整句全等匹配行为');
    add(grid, { shortCoreSubstring: !(current.shortCoreSubstring ?? true) }, '联合检验：切换短核心词子串召回行为');
  } else {
    add(grid, { graphClusterFirst: !(current.graphClusterFirst ?? false) }, '切换图谱候选簇优先策略');
  }
  const keys = ['hintWeight', 'clauseWeight', 'clarificationLimit', 'lexicalWeight', 'actionWeight', 'negativePenalty'];
  const offset = (Math.max(1, generation) - 1) % keys.length;
  for (const key of [...keys.slice(offset), ...keys.slice(0, offset)]) {
    const base = current[key] ?? defaults[key];
    const step = key === 'clarificationLimit' ? 2 : 0.12 / (1 + Math.floor((generation - 1) / keys.length));
    const bounds = ENGINE_PARAMETERS[key];
    for (const direction of [-1, 1]) add(oneD, { [key]: Number(Math.max(bounds[0], Math.min(bounds[1], base + direction * step)).toFixed(4)) }, `${key} ${direction < 0 ? '降低' : '提高'}：检验召回与误触发的权衡`);
  }
  // 沉淀自人工引擎优化的行为开关：每代轮换探索布尔行为的开关，parameter_search 自动发现最优组合
  const boolKeys = ['actionPrefixStrip', 'colloquialSuffixNorm', 'wholeExpressionMatch', 'shortCoreSubstring'];
  const boolOffset = (Math.max(1, generation) - 1) % boolKeys.length;
  for (const key of [...boolKeys.slice(boolOffset), ...boolKeys.slice(0, boolOffset)].slice(0, 2)) {
    const base = current[key] ?? true;
    add(oneD, { [key]: !base }, `${key} ${base ? '关闭' : '开启'}：检验该通用行为对当前任务的影响`);
  }
  // 网格点与一维点 1:1 交替：实测最优的二维组合排第一，但一维参数每代都能排上队。
  const interleaved = [];
  for (let i = 0, j = 0; i < grid.length || j < oneD.length;) {
    if (i < grid.length) interleaved.push(grid[i++]);
    if (j < oneD.length) interleaved.push(oneD[j++]);
  }
  if (!policy) return interleaved;
  // 策略记忆生效：已证否的臂不再重试；有胜绩的前移；没试过的保持原轮转（稳定排序）。
  const live = interleaved.filter(m => !policy.dead(m.armKey, m.armDimension));
  const scored = live.map((m, index) => ({ m, index, score: policy.score(m.armKey) }));
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  let out = scored.map(x => x.m);
  const dropped = interleaved.length - out.length;
  if (!out.length && interleaved.length) {
    // 全部被证否：保留一个探索位，避免「记忆」把搜索彻底锁死。
    out = [interleaved[0]];
    out[0].motivation += '（本任务已证否该维度，保留唯一探索位复核）';
    return out;
  }
  if (dropped && out.length) out[0].motivation += `（已跳过 ${dropped} 个被本任务证否的组合）`;
  return out;
}

function performanceSummary(rows = []) {
  const values = rows.map(r => r.latency_ms).filter(n => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
  const percentile = p => values.length ? values[Math.ceil(values.length * p) - 1] : null;
  const sumKnown = key => rows.length && rows.every(r => Number.isFinite(r[key])) ? rows.reduce((s, r) => s + r[key], 0) : null;
  return { measured: values.length, total: rows.length, p50_ms: percentile(0.5), p95_ms: percentile(0.95),
    scoring_concurrency: rows.length && rows.every(r => r.scoring_concurrency === rows[0].scoring_concurrency) ? rows[0].scoring_concurrency ?? 1 : null,
    mean_ms: values.length ? Number((values.reduce((s, n) => s + n, 0) / values.length).toFixed(2)) : null,
    llm_calls: sumKnown('llm_calls'), tokens: sumKnown('tokens'), cost: sumKnown('cost') };
}

function qualityVector(scores) {
  const result = [];
  for (const side of ['train', 'heldout']) {
    const s = scores?.[side];
    for (const metric of ['strict_pct', 'relaxed_pct']) if (Number.isFinite(s?.[metric])) result.push(s[metric]);
    for (const key of ['single_intent', 'multi_intent', 'ambiguous_intent', 'negative_intent']) {
      if (s?.[key]?.total > 0) for (const metric of ['strict_pct', 'relaxed_pct']) result.push(s[key][metric] ?? 0);
    }
    for (const metric of ['intent_f1_pct', 'clarify_coverage_pct']) if (Number.isFinite(s?.metrics?.[metric])) result.push(s.metrics[metric]);
  }
  return result;
}

function compareProgress(before, after) {
  const a = qualityVector(before), b = qualityVector(after);
  const comparable = a.length > 0 && a.length === b.length;
  const qualityImproved = comparable && b.every((v, i) => v >= a[i]) && b.some((v, i) => v > a[i]);
  const qualityStable = comparable && b.every((v, i) => v >= a[i]);
  const pa = before?.all?.performance, pb = after?.all?.performance;
  const measured = (pa?.scoring_concurrency ?? 1) === (pb?.scoring_concurrency ?? 1) && pa?.measured !== 0 && pb?.measured !== 0 && Number.isFinite(pa?.p95_ms) && Number.isFinite(pb?.p95_ms);
  const performanceImproved = measured && pb.p95_ms < pa.p95_ms * 0.9 && pb.mean_ms <= pa.mean_ms;
  const performanceStable = measured && pb.p95_ms <= pa.p95_ms * 1.1 && pb.mean_ms <= pa.mean_ms * 1.1;
  return { improved: qualityImproved || (qualityStable && performanceImproved), qualityImproved,
    performanceImproved: !!performanceImproved, performanceMeasured: !!measured,
    comprehensive: qualityImproved && !!performanceImproved,
    tradeoff: !!(qualityImproved && measured && !performanceStable), independentValidated: false };
}

module.exports = { trainingFeedback, diagnoseError, selectTrainingFeedback, searchMemory, parameterMutations, performanceSummary, qualityVector, compareProgress };
