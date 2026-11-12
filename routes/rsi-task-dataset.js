'use strict';
const { fail } = require('./rsi-task-context');
const shapes = new Set(['single_intent', 'multi_intent', 'ambiguous_intent', 'negative_intent']);
const aliases = { SINGLE_INTENT: 'single_intent', MULTI_INTENT: 'multi_intent', AMBIGUOUS: 'ambiguous_intent', AMBIGUOUS_INTENT: 'ambiguous_intent', NEGATIVE: 'negative_intent', NEGATIVE_INTENT: 'negative_intent' };
function normalizeCases(raw, graph, opts = {}) {
  if (!Array.isArray(raw)) throw fail('cases 必须是数组');
  const allowed = new Set((graph.intent_nodes || []).map(n => n.identity?.intent_id));
  const ids = new Set(), cases = [], errors = [], shapeCounts = {};
  raw.forEach((item, index) => {
    try {
      if (!item || typeof item !== 'object') throw Error('题目必须是对象');
      const c = { ...item };
      c.case_id = String(item.case_id || item.caseId || '').trim();
      if (!c.case_id) throw Error('缺少 case_id/caseId');
      if (ids.has(c.case_id)) throw Error('重复 case_id: ' + c.case_id);
      ids.add(c.case_id);
      if (typeof c.query !== 'string' || !c.query.trim()) throw Error('query 必须是非空字符串');
      const sourceShape = item.intent_shape || item.category;
      c.intent_shape = shapes.has(sourceShape) ? sourceShape : aliases[String(sourceShape || '').toUpperCase()];
      if (['COMPOUND', 'COMPLEX'].includes(String(sourceShape).toUpperCase())) {
        if (opts.multiIntentAdapter !== true) throw Error('COMPOUND/COMPLEX 需要显式 multiIntentAdapter:true 适配');
        c.intent_shape = 'multi_intent';
      }
      if (!c.intent_shape) throw Error('未知或缺失题型: ' + sourceShape);
      const expected = item.expected_intents ?? [...(item.expected?.intentId ? [item.expected.intentId] : []), ...(item.expected?.intentIds || [])];
      if (!Array.isArray(expected) || expected.some(id => typeof id !== 'string' || !id.trim())) throw Error('expected_intents 必须是有效意图 ID 数组');
      c.expected_intents = [...new Set(expected)];
      if (c.intent_shape === 'negative_intent' ? c.expected_intents.length !== 0 : c.expected_intents.length === 0) throw Error('题型与标准答案数量不兼容');
      if (c.intent_shape === 'single_intent' && c.expected_intents.length !== 1) throw Error('单意图题必须恰有一个标准答案');
      if (c.intent_shape === 'multi_intent' && c.expected_intents.length < 2) throw Error('多意图题至少需要两个标准答案');
      if (c.expected_intents.some(id => !allowed.has(id))) throw Error('标准答案意图不属于所选图谱');
      cases.push(c); shapeCounts[c.intent_shape] = (shapeCounts[c.intent_shape] || 0) + 1;
    } catch (e) { errors.push({ index, caseId: item?.case_id || item?.caseId || null, reason: e.message }); }
  });
  // filtered：宽容模式（legacyTolerant=true，用于 inherit 历史题库）下被过滤掉的坏题数。
  // 显式导入（dataset/file）不走宽容——用户主动上传的必须是干净集合，fail-fast 并返回完整报告。
  const report = { original: raw.length, accepted: cases.length, rejected: errors.length, filtered: 0, errors, shapeCounts };
  if (opts.legacyTolerant === true) {
    // 历史题库宽容：坏题只过滤不阻断；全坏才拒绝（否则会创建出空题库任务）
    report.filtered = errors.length;
    if (!cases.length) throw Object.assign(fail('历史题库全部无法通过校验，未导入任何题目'), { importReport: report });
    return { cases, report };
  }
  if (errors.length || !cases.length) throw Object.assign(fail('评测集校验失败，未导入任何题目'), { importReport: report });
  return { cases, report };
}
// 切分：先按题型分仓保证题型比例，仓内按意图轮转后与「侧别序列」逐位配对。
// 这样 heldout 天然覆盖尽可能多的不同意图，而不是集中抽到少数几个意图的题
//（审计 P0-4：旧切分下 14 个训练意图在 heldout 里一题都没有）。
function splitCases(cases, seed, trainRatio, testRatio = 0) {
  if (!(trainRatio >= .3 && trainRatio <= .9) || !(testRatio >= 0 && testRatio <= .3) || trainRatio + testRatio >= 1) throw fail('切分比例无效，须保留非空验证集比例');
  let state = seed >>> 0;
  const rand = () => { state |= 0; state = (state + 0x6D2B79F5) | 0; let t = Math.imul(state ^ state >>> 15, 1 | state); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const shuffle = list => { const a = list.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const n = cases.length, targets = [Math.round(n * trainRatio), Math.floor(n * testRatio), 0];
  targets[2] = n - targets[0] - targets[1];
  const groups = new Map();
  for (const c of cases) { if (!groups.has(c.intent_shape)) groups.set(c.intent_shape, []); groups.get(c.intent_shape).push(c); }
  const result = [[], [], []]; let remaining = n;
  // 贪心覆盖：先按「能带来多少新意图」挑验证/终测题，让有限的 seats 覆盖尽可能多的意图。
  const pickCovering = (pool, seats) => {
    const picked = [], left = pool.slice();
    const covered = new Set();
    const newIntents = c => (c.expected_intents || []).filter(x => !covered.has(x)).length;
    while (picked.length < seats && left.length) {
      let best = 0;
      for (let i = 1; i < left.length; i++) if (newIntents(left[i]) > newIntents(left[best])) best = i;
      const [c] = left.splice(best, 1);
      picked.push(c); for (const x of c.expected_intents || []) covered.add(x);
    }
    return picked;
  };
  for (const group of groups.values()) {
    const ordered = shuffle(group);
    const expected = targets.map(x => remaining ? ordered.length * x / remaining : 0), counts = expected.map(Math.floor);
    for (let seats = ordered.length - counts.reduce((a, b) => a + b, 0); seats > 0; seats--) {
      const side = [0, 1, 2].filter(i => counts[i] < targets[i]).sort((a, b) => (expected[b] - counts[b]) - (expected[a] - counts[a]))[0];
      counts[side]++;
    }
    const held = pickCovering(ordered, counts[2]);
    const heldIds = new Set(held.map(c => c.case_id));
    const rest = ordered.filter(c => !heldIds.has(c.case_id));
    const test = pickCovering(rest, counts[1]);
    const testIds = new Set(test.map(c => c.case_id));
    const train = rest.filter(c => !testIds.has(c.case_id));
    result[0].push(...train.map(c => c.case_id));
    result[1].push(...test.map(c => c.case_id));
    result[2].push(...held.map(c => c.case_id));
    for (let i = 0; i < 3; i++) targets[i] -= counts[i];
    remaining -= ordered.length;
  }
  return { seed, train: result[0], heldout: result[2], ...(testRatio > 0 ? { test: result[1] } : {}) };
}
function splitPreview(cases, seed, trainRatio, testRatio) {
  const split = splitCases(cases, seed, trainRatio, testRatio);
  const warnings = [];
  if (!split.train.length || !split.heldout.length || (testRatio > 0 && !split.test?.length)) warnings.push('样本量不足，至少一个要求的切分为空；请增加题目后再评测');
  const byShape = {};
  for (const c of cases) { const row = byShape[c.intent_shape] ||= { train: 0, heldout: 0, test: 0 }; for (const side of ['train', 'heldout', 'test']) if (split[side]?.includes(c.case_id)) row[side]++; }
  // 覆盖度：验证集里没有任何题目的意图，其上的涨分无法证明泛化（审计 P0-4）。
  const byId = new Map(cases.map(c => [c.case_id, c]));
  const intentsOf = ids => new Set(ids.flatMap(id => byId.get(id)?.expected_intents || []));
  const trainIntents = intentsOf(split.train), heldIntents = intentsOf(split.heldout);
  const missing = [...trainIntents].filter(x => !heldIntents.has(x));
  const singleCaseIntents = [...heldIntents].filter(x => split.heldout.filter(id => (byId.get(id)?.expected_intents || []).includes(x)).length === 1);
  if (missing.length) warnings.push(`验证集未覆盖 ${missing.length}/${trainIntents.size} 个训练意图：这些意图上的改动无法被证伪，建议补题或降低 train 比例`);
  if (singleCaseIntents.length > Math.max(2, heldIntents.size / 2)) warnings.push(`验证集有 ${singleCaseIntents.length} 个意图只有 1 题，单题波动会直接决定结论；建议每个意图至少 2 题`);
  // 给一条可执行的建议：在现有题库上降低 train 比例能换来多少覆盖。
  let advice = null;
  if (missing.length) {
    let bestRatio = trainRatio, bestCovered = heldIntents.size;
    for (let r = Math.max(0.3, trainRatio - 0.05); r >= 0.3 - 1e-9; r -= 0.05) {
      const alt = splitCases(cases, seed, +r.toFixed(2), testRatio);
      const covered = intentsOf(alt.heldout).size;
      if (covered > bestCovered) { bestCovered = covered; bestRatio = +r.toFixed(2); }
    }
    const perIntent = Math.ceil(cases.length / Math.max(1, trainIntents.size));
    advice = bestCovered > heldIntents.size
      ? `把 train 比例降到 ${bestRatio} 可把验证集意图覆盖从 ${heldIntents.size} 提到 ${bestCovered}；每个意图至少 2 题需要约 ${trainIntents.size * 2 + trainIntents.size * 2 * (testRatio + 0.2) | 0} 道题（当前 ${cases.length} 道，平均每意图 ${perIntent} 道）`
      : `当前题库量下降低 train 比例也无法明显提升覆盖；每意图至少 2 题需补充题目（当前平均每意图 ${perIntent} 道）`;
  }
  return { total: cases.length, train: split.train.length, heldout: split.heldout.length, test: split.test?.length || 0, byShape, warnings,
    coverage: { intents: trainIntents.size, heldoutIntents: heldIntents.size, missingInHeldout: missing.length, singleCaseIntents: singleCaseIntents.length, advice } };
}
module.exports = { normalizeCases, splitCases, splitPreview };
