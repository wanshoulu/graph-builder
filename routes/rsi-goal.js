'use strict';
// 达标（goal）与门禁（gate）——RSI 循环的判定层。
//
// 修复的三件事（2026-10-19 审计）：
// 1. 原系统只有「这轮涨没涨」，没有「离目标还差多少、差在哪」→ goalProgress 给出
//    差距题数、题型分布、失败族分布与按实测回收率估算的可达上限。
// 2. 原门禁要求 train/heldout × strict/relaxed × 4 题型共 20 维全部不退，
//    数学上几乎不可满足；且回归保护集里基线就失败的题永远无法通过 →
//    gateCandidate 改为主指标 + 最小效应/配对显著性 + 有界回退 + 基线失败题 quarantine。
// 3. 同一资产重测会翻转 5/71 题（模型温度导致），单次比较会把噪声当提升 →
//    有逐题结果时用 McNemar 配对检验，并要求最小效应量。

// minEffect 从 3 降到 1（10-31）：3pp 是「没有全量净收益保护」时代的设计值——当时唯一
// 防线就是分片大幅提升。现在晋升必须先过「全量配对净收益 ≥0」硬门（v3 教训后新增），
// 验证容差/题型容差/回归保护集三重把关仍在；3pp 门槛的副作用被 v6-v10 四轮实测证实：
// 每轮都有「修 1-2 题、零/微破坏、全量 +0.7pp」的真改善候选被拒（12 道排序错题根因各异，
// 单机制每轮只能救 1 题，攒不出 3pp）。净收益硬门兜底下，1pp 是合理的「可靠改善」起点。
const DEFAULTS = Object.freeze({ metric: 'strict_pct', target: 85, minEffect: 1, alpha: 0.05 });

function normalizeGoal(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  if (src.metric != null && src.metric !== DEFAULTS.metric) throw new Error('验收目标仅支持完全正确率 strict_pct；部分得分率仅作辅助指标');
  const metric = DEFAULTS.metric;
  const num = (v, fallback, min, max, name) => {
    if (v == null || v === '') return fallback;
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name}须为 ${min}–${max} 的数值`);
    return n;
  };
  return {
    metric,
    target: num(src.target ?? src.targetStrict, DEFAULTS.target, 1, 100, '目标精度'),
    minEffect: num(src.minEffect ?? src.mde, DEFAULTS.minEffect, 0.1, 50, '最小效应量'),
    alpha: num(src.alpha, DEFAULTS.alpha, 0.001, 0.2, '显著性水平'),
    note: typeof src.note === 'string' ? src.note.slice(0, 200) : '',
  };
}

// 单臂比例的最小可检测效应（95%）：用于没有逐题对照时的保守门槛。
function mdeFor(n, p) {
  if (!(n > 0) || !Number.isFinite(p)) return null;
  const q = Math.max(1e-6, Math.min(1 - 1e-6, p / 100));
  return +(196 * Math.sqrt(2 * q * (1 - q) / n)).toFixed(2); // 百分比点
}

const LOG_FACT = [0];
function logFact(n) {
  for (let i = LOG_FACT.length; i <= n; i++) LOG_FACT[i] = LOG_FACT[i - 1] + Math.log(i);
  return LOG_FACT[n];
}
function binomTwoSided(k, n) {
  if (!n) return 1;
  const tail = i => Math.exp(logFact(n) - logFact(i) - logFact(n - i) - n * Math.LN2);
  let p = 0;
  for (let i = 0; i <= k; i++) p += tail(i);
  return Math.min(1, 2 * p);
}

// McNemar 精确检验：只统计「父代对、候选错」（b）与「父代错、候选对」（c）。
// 逐题结果缺失时返回 null，调用方退回最小效应量判定。
function mcnemar(beforeRows = [], afterRows = []) {
  if (!beforeRows?.length || !afterRows?.length) return null;
  const after = new Map(afterRows.map(r => [r.case_id, r]));
  let both = 0, fixed = 0, broken = 0, neither = 0;
  for (const b of beforeRows) {
    const a = after.get(b.case_id);
    if (!a) continue;
    if (b.strict && a.strict) both++;
    else if (!b.strict && a.strict) fixed++;
    else if (b.strict && !a.strict) broken++;
    else neither++;
  }
  const n = fixed + broken;
  return { paired: both + fixed + broken + neither, both, fixed, broken, neither,
    deltaCases: fixed - broken, pValue: n ? +binomTwoSided(Math.min(fixed, broken), n).toFixed(6) : 1, n };
}

// 失败族 → 现有动作空间里的修复手段。
// rate 只是先验起点：有实测后由 routes/rsi-strategy.js 的经验贝叶斯结果覆盖，
// 目标上限因此会随工具自身的历史表现自校准（原实现把 0.25 写死，永远算 77.2%）。
const strategy = require('./rsi-strategy');
const FAMILY_FIX = Object.fromEntries(Object.entries(strategy.FAMILY_PRIOR).map(([k, v]) => [k, {
  label: v.label, fixableBy: v.fixableBy, rate: v.prior,
}]));

function diagnose(row = {}) {
  // 与 routes/rsi-learning.js 的 diagnoseError 保持同一族名，避免两套口径。
  try { return require('./rsi-learning').diagnoseError(row); } catch (_) { return { errorFamilies: [row.errorFamily || 'unclassified'] }; }
}

function shapeOfRow(row, caseById) {
  return row.shape || caseById.get(row.case_id)?.intent_shape || 'unknown';
}

// 差距归因：目标还差几题、差在哪些题型、哪些失败族、按实测回收率还能拿回几题。
function goalProgress(goal, scores, rows = [], cases = [], opts = {}) {
  const g = normalizeGoal(goal);
  const learned = opts.rates || null;   // {family: rate}，来自实测折叠
  const strategySummary = opts.strategy || null;
  const rateOf = (key, fallback) => Number.isFinite(learned?.[key]) ? learned[key] : fallback;
  const caseById = new Map((cases || []).map(c => [c.case_id, c]));
  const total = rows.length || scores?.all?.total || 0;
  const current = Number(scores?.all?.[g.metric] ?? 0);
  const correct = rows.length ? rows.filter(r => r.strict).length : Math.round(current * total / 100);
  const needCorrect = Math.ceil(g.target * total / 100 - 1e-9);
  const missingCases = Math.max(0, needCorrect - correct);
  const met = total > 0 && current >= g.target;
  const shapes = new Map(), families = new Map(), fixableRows = new Set();
  let estimatedFixes = 0;
  for (const row of rows) {
    if (row.strict) continue;
    const shape = shapeOfRow(row, caseById);
    const s = shapes.get(shape) || { shape, total: 0, correct: 0, failed: 0 };
    shapes.set(shape, s);
    const dx = diagnose(row);
    const keys = dx.errorFamilies?.length ? dx.errorFamilies : [dx.errorFamily || 'unclassified'];
    let bestRate = 0, bestKey = keys[0];
    for (const key of keys) {
      const meta = FAMILY_FIX[key] || FAMILY_FIX.unclassified;
      const rate = rateOf(key, meta.rate);
      const f = families.get(key) || { family: key, label: meta.label, fixableBy: meta.fixableBy, count: 0, rate };
      f.count++; families.set(key, f);
      if (rate > bestRate) { bestRate = rate; bestKey = key; }
    }
    estimatedFixes += bestRate;
    if (bestRate > 0) fixableRows.add(row.case_id);
    const fam = families.get(bestKey);
    if (fam) fam.primary = (fam.primary || 0) + 1;
  }
  for (const row of rows) {
    const shape = shapeOfRow(row, caseById);
    const s = shapes.get(shape) || { shape, total: 0, correct: 0, failed: 0 };
    if (!shapes.has(shape)) shapes.set(shape, s);
    s.total++; if (row.strict) s.correct++; else s.failed++;
  }
  const shapeRows = [...shapes.values()].sort((a, b) => b.failed - a.failed).map(s => ({
    ...s, strict_pct: +(100 * s.correct / Math.max(1, s.total)).toFixed(1),
  }));
  const familyRows = [...families.values()].sort((a, b) => b.count - a.count).map(f => ({
    ...f, estimatedFixes: +(f.count * f.rate).toFixed(1),
    rateSource: strategySummary?.families?.find(x => x.family === f.family)?.source || 'prior',
  }));
  const nextActions = (strategySummary?.leverage || [])
    .filter(l => l.expectedFixes > 0 && !l.exhausted)
    .slice(0, 3)
    .map(l => ({ family: l.family, expectedFixes: l.expectedFixes, bestArm: l.bestArm, winRate: l.bestWinRate,
      label: FAMILY_FIX[l.family]?.label || l.family, fixableBy: FAMILY_FIX[l.family]?.fixableBy || '' }));
  const estimatedGain = Math.round(estimatedFixes);
  const ceilingPct = total ? +(current + 100 * estimatedFixes / total).toFixed(1) : current;
  return {
    ...g, total, correct, current: +current.toFixed(1), gapPts: +Math.max(0, g.target - current).toFixed(1),
    missingCases, needCorrect, met, estimatedGain, ceilingPct, reachable: ceilingPct >= g.target,
    byShape: shapeRows, byFamily: familyRows, nextActions,
    ceilingBasis: familyRows.some(f => f.rateSource !== 'prior') ? 'measured' : 'prior',
    summary: total
      ? `目标 ${g.target}%｜当前 ${current.toFixed(1)}%（${correct}/${total}）｜${met ? '已达标' : `差 ${missingCases} 题/${Math.max(0, g.target - current).toFixed(1)}pp`}｜现有动作空间上限 ${ceilingPct}%（可拿回约 ${estimatedGain} 题，${familyRows.some(f => f.rateSource !== 'prior') ? '按本任务实测回收率' : '按先验回收率'}）${ceilingPct < g.target ? '，需扩动作空间或补数据' : ''}`
      : `目标 ${g.target}%｜尚无评测数据`,
  };
}

// 有界回退：允许「修 A 破 B」在一个题的量级内发生，但要求主指标净增。
// 题型维度最多容 2 题或 20%（小样本的 1 题抖动不应当作退化）。
function toleranceFor(n, metric) {
  // strict_pct 容差最小 0.5pp：大样本集上 100/n 过小（如 n=2033 → 0.049pp），
  // LLM judge 随机翻转 1-5 题就触发回退。0.5pp ≈ 10 题波动，是统计合理的下限。
  if (!n) return metric === 'relaxed_pct' ? 2 : 0.5;
  return metric === 'relaxed_pct' ? Math.max(2, 100 / n) : Math.max(0.5, 100 / n);
}
function shapeTolerance(n) {
  // 1–2 题的题型没有统计容差：任何一题翻转都是 50–100pp，谈不上「抖动」。
  if (!n || n <= 2) return 0;
  return Math.min(2 * 100 / n, 20);
}

function fmt(n, digits = 1) { return Number.isFinite(n) ? (+n).toFixed(digits) : '—'; }

/**
 * 晋升门禁 v2。
 * @param {object} p
 * @param {object} p.before 父代聚合成绩（train/heldout/all）
 * @param {object} p.after  候选聚合成绩
 * @param {object} p.beforeRows 父代逐题结果（可选；有则可做配对检验与 quarantine）
 * @param {object} p.afterRows  候选逐题结果
 * @param {object} p.regression 回归保护表 {caseId: meta}
 * @param {object} p.goal 目标（可选）
 * @param {string[]} p.trainIds 训练题 id（可选）
 * @param {Array} p.cases 题库（可选，用于目标归因）
 */
function gateReport(p = {}) {
  const { before, after, beforeRows = [], afterRows = [], regression = {}, goal, cases = [] } = p;
  const g = safeGoal(goal);
  const reject = (verdict, reason, extra = {}) => ({ passed: false, verdict, reason, ...extra });
  if (!before?.engineRev || !after?.engineRev || JSON.stringify(before.engineRev) !== JSON.stringify(after.engineRev)) {
    return reject('invalid', '评测器指纹缺失或不同，禁止跨口径晋升');
  }
  const trainIds = p.trainIds?.length ? new Set(p.trainIds) : null;
  const pairs = beforeRows?.length && afterRows?.length
    ? (() => {
      const afterMap = new Map(afterRows.map(r => [r.case_id, r]));
      return beforeRows.filter(r => afterMap.has(r.case_id) && (!trainIds || trainIds.has(r.case_id)));
    })()
    : [];
  const compareRows = trainIds ? pairs.filter(r => trainIds.has(r.case_id)) : pairs;

  for (const side of ['train', 'heldout']) {
    if (!(before[side]?.total > 0) || after[side]?.total !== before[side].total) return reject('invalid', '训练/验证评测题数不完整');
  }
  if (afterRows.some(r => r.resultType === 'engine_error')) return reject('invalid', '包含引擎错误，成绩无效');

  const nTrain = before.train.total, nHeld = before.heldout.total;
  const dTrain = after.train.strict_pct - before.train.strict_pct;
  const dHeld = after.heldout.strict_pct - before.heldout.strict_pct;
  const mc = compareRows.length ? mcnemar(compareRows, afterRows) : null;
  const allMc = (beforeRows?.length && afterRows?.length) ? mcnemar(beforeRows, afterRows) : null;
  const heldoutBeforeRows = trainIds ? beforeRows.filter(r => !trainIds.has(r.case_id)) : [];
  const heldoutAfterRows = trainIds ? afterRows.filter(r => !trainIds.has(r.case_id)) : [];
  const heldoutMc = heldoutBeforeRows.length && heldoutAfterRows.length
    ? mcnemar(heldoutBeforeRows, heldoutAfterRows)
    : null;
  const minCleanFixes = 2;
  const trainNet = mc ? mc.fixed - mc.broken : null;
  const overallNet = allMc ? allMc.fixed - allMc.broken : null;
  const heldoutNet = heldoutMc ? heldoutMc.fixed - heldoutMc.broken : null;
  const unchanged = !!allMc && allMc.fixed === 0 && allMc.broken === 0;
  const minEffect = g.minEffect;
  const significant = !!mc && mc.pValue < g.alpha && mc.fixed > mc.broken;
  const meetsEffect = dTrain >= minEffect;
  // 单题翻转在当前 LLM judge 上会造成 0.7–1.4pp 抖动；配对证据至少需要
  // 两个净修复，且完整集同样达到该阈值，才能进入稳定评测/确认链路。
  const cleanFixes = !!mc && mc.broken === 0 && mc.fixed >= minCleanFixes;
  // 没有逐题对照时，用单臂 MDE 兜底：样本越小，要求越大，避免一次噪声就被采纳。
  const fallbackMde = mdeFor(nTrain, before.train.strict_pct);
  const effectOk = mc
    ? trainNet >= minCleanFixes && (significant || meetsEffect || cleanFixes)
    : dTrain >= Math.max(minEffect, fallbackMde || 0);
  // 配对证据充分时（significant 或 cleanFixes），允许 dTrain 在容差内通过；
  // LLM judge 随机性会导致真实改善的候选在总分上微降，配对 McNemar 比总分更可靠。
  const tolTrainVal = toleranceFor(nTrain);
  const improved = effectOk && (dTrain > 0 || (mc && (significant || cleanFixes) && dTrain >= -tolTrainVal));

  // 回退检查（有界）：验证集允许 1 题的抖动；训练主指标要求净增；题型允许 1 题内波动。
  const regressions = [];
  const tolTrain = toleranceFor(nTrain), tolHeld = toleranceFor(nHeld);
  if (dTrain < -tolTrain) regressions.push(`训练完全正确率回退 ${fmt(dTrain)}pp（容差 ${fmt(tolTrain)}pp）`);
  if (heldoutNet != null && heldoutNet < 0) regressions.push(`验证集不得净退化：修 ${heldoutMc.fixed} 题 / 破 ${heldoutMc.broken} 题（净 ${heldoutNet} 题）`);
  else if (dHeld < -tolHeld) regressions.push(`验证完全正确率回退 ${fmt(dHeld)}pp（容差 ${fmt(tolHeld)}pp）`);
  for (const side of ['train', 'heldout']) {
    const dr = (after[side].relaxed_pct ?? NaN) - (before[side].relaxed_pct ?? NaN);
    if (Number.isFinite(dr) && dr < -toleranceFor(before[side].total, 'relaxed_pct')) regressions.push(`${side === 'train' ? '训练' : '验证'}部分得分率回退 ${fmt(dr)}pp`);
  }
  for (const side of ['train', 'heldout']) {
    for (const shape of ['single_intent', 'multi_intent', 'ambiguous_intent', 'negative_intent']) {
      const b = before[side][shape], a = after[side][shape];
      if (!(b?.total > 0)) continue;
      if (a?.total !== b.total) { regressions.push(`${side}/${shape} 题数不一致`); continue; }
      if (!Number.isFinite(a.strict_pct) || !Number.isFinite(a.relaxed_pct)) { regressions.push(`${side}/${shape} 成绩缺失`); continue; }
      const drop = a.strict_pct - b.strict_pct;
      if (drop < -shapeTolerance(b.total)) regressions.push(`${side === 'train' ? '训练' : '验证'}「${shape}」题型退化 ${fmt(drop)}pp（容差 ${fmt(shapeTolerance(b.total))}pp）`);
    }
  }

  // 完整集配对保护：训练集局部提升不能掩盖验证集或其他题型的破坏。
  if (allMc && overallNet < 0) {
    regressions.push(`全量净收益为负：修 ${allMc.fixed} 题 / 破 ${allMc.broken} 题（净 ${overallNet} 题），分片提升不能掩盖整体回退`);
  }

  // 回归保护：只保护「基线就通过」的题；基线失败的题进 quarantine，不阻断晋升，
  // 否则历史遗留失败会让门禁永远无法通过（审计中 6/8 个分支卡在 rsi_t214）。
  const beforeStrict = new Map((beforeRows || []).map(r => [r.case_id, !!r.strict]));
  const afterById = new Map((afterRows || []).map(r => [r.case_id, r]));
  const enforced = [], quarantined = [], broken = [];
  for (const id of Object.keys(regression || {})) {
    const row = afterById.get(id);
    const beforeRow = beforeStrict.get(id);
    if (!row) { broken.push(`${id}（未覆盖）`); continue; }
    // 基线中缺失的案例不知道是否通过，不能假设通过而阻断晋升——放入 quarantine
    if (beforeStrict.size && beforeRow === undefined) { quarantined.push(id); continue; }
    if (beforeStrict.size && beforeRow === false) { quarantined.push(id); continue; }
    enforced.push(id);
    if (!row.strict) broken.push(id);
  }
  if (broken.length) regressions.push(`回归保护未通过：${broken.slice(0, 6).join('、')}${broken.length > 6 ? ` 等 ${broken.length} 题` : ''}`);

  const metrics = {
    trainStrict: { before: +before.train.strict_pct.toFixed(1), after: +after.train.strict_pct.toFixed(1), delta: +dTrain.toFixed(1), mde: fallbackMde },
    heldoutStrict: { before: +before.heldout.strict_pct.toFixed(1), after: +after.heldout.strict_pct.toFixed(1), delta: +dHeld.toFixed(1), tolerance: +tolHeld.toFixed(1) },
    relaxed: { trainDelta: +(after.train.relaxed_pct - before.train.relaxed_pct).toFixed(1), heldoutDelta: +(after.heldout.relaxed_pct - before.heldout.relaxed_pct).toFixed(1) },
    paired: mc, significant, meetsEffect, cleanFixes: !!cleanFixes, minCleanFixes, minEffect, alpha: g.alpha,
    trainNetCases: trainNet, allPaired: allMc, overallNetCases: overallNet,
    heldoutPaired: heldoutMc, heldoutNetCases: heldoutNet,
    enforced: enforced.length, quarantined, gateVersion: 2,
  };
  const progress = (goal && afterRows.length) ? goalProgress(g, after, afterRows, cases) : null;
  if (progress) metrics.goal = { target: g.target, current: progress.current, gapPts: progress.gapPts, met: progress.met, missingCases: progress.missingCases };

  if (regressions.length) {
    return { passed: false, verdict: 'regressed', reason: regressions.join('；'), metrics };
  }
  if (unchanged) {
    return { passed: false, verdict: 'no_effect', reason: '未观测到可靠提升：完整集逐题结果没有变化', metrics };
  }
  if (allMc && overallNet < minCleanFixes) {
    return {
      passed: false,
      verdict: 'evidence_insufficient',
      reason: `证据不足：全量净修复 ${overallNet} 题，稳定采纳要求全量净修复至少 ${minCleanFixes} 题`,
      metrics,
    };
  }
  if (!improved) {
    const why = dTrain <= 0
      ? `训练完全正确率未提升（${fmt(dTrain)}pp）`
      : `训练 +${fmt(dTrain)}pp 未达判定门槛（${mc ? `配对 ${mc.fixed} 修 / ${mc.broken} 破，净修复要求 ≥${minCleanFixes} 题；` : ''}要求 ≥${fmt(minEffect)}pp、p<${g.alpha}${mc ? `，或零破坏且修题数 ≥${minCleanFixes}` : ` 且 ≥MDE ${fmt(fallbackMde)}pp`}）`;
    return { passed: false, verdict: dTrain > 0 ? 'evidence_insufficient' : 'no_effect', reason: `未观测到可靠提升：${why}`, metrics };
  }
  const mcText = mc
    ? `配对 ${mc.fixed} 修 / ${mc.broken} 破（${significant ? `p=${mc.pValue} 显著` : cleanFixes ? `零破坏且修题达标的干净晋升` : `p=${mc.pValue}，达到最小效应`}）`
    : `无逐题对照，按 MDE ${fmt(fallbackMde)}pp 判定`;
  return {
    passed: true, verdict: 'promoted',
    reason: `训练 +${fmt(dTrain)}pp（${mcText}）；验证 ${dHeld >= 0 ? '+' : ''}${fmt(dHeld)}pp 在 ±${fmt(tolHeld)}pp 容差内；回归 ${enforced.length - broken.length}/${enforced.length} 通过${quarantined.length ? `，quarantine ${quarantined.length} 题（基线即失败）` : ''}`,
    metrics,
  };
}

function safeGoal(goal) {
  try { return normalizeGoal(goal); } catch (_) { return { ...DEFAULTS }; }
}

module.exports = { DEFAULTS, FAMILY_FIX, normalizeGoal, mdeFor, mcnemar, goalProgress, gateReport, toleranceFor, shapeTolerance, safeGoal };
