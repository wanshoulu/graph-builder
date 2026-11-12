'use strict';

/**
 * RSI 生产引擎打分脚本 — 用生产意图引擎（intent-evaluator-v2）对给定图谱 + 题库
 * 纯打分（不做沙盒对照），输出引擎口径的 strict/relaxed。
 *
 * 用途：第四关·生产引擎复核（提案草案 vs 当前图谱，引擎上无真实收益不得采纳）。
 * 与 rsi-engine-calibrate.js 的区别：那个算"沙盒 vs 引擎一致率"，这个只要引擎分。
 *
 * 用法：
 *   node scripts/rsi-engine-score.js --graph=<abs路径或 rsi:data/rsi下相对路径> \
 *        --cases=rsi-eval-cases.json --out=<abs路径.json>
 *
 * 输出契约（routes/intent-rsi.js runVerifyEngine / evaluateSetEngine 消费）：
 *   { status:'ok', engineMode, total, strict_pct, relaxed_pct, by_shape,
 *     rows:[{case_id,query,shape,expected,strict,relaxed,resultType,engine_top1,engine_clarifying,engine_candidates}],
 *     finishedAt }
 *
 * per-case 输出供前三关门禁使用（evaluateSetEngine 消费 rows 数组）。
 * negative_intent 支持：TRIGGER_NEGATIVE 用例，正确行为 = 不触发期望意图。
 *
 * 引擎在线模式（QWEN_KEY 可用时）跑三路融合（规则+embedding+LLM裁决）；
 * 离线模式（无 key）降级为仅规则召回。由调用方通过环境变量控制。
 */

const fs = require('fs');
const path = require('path');

const ROOT = fs.existsSync('/app/package.json') ? '/app' : path.join(__dirname, '..');
const ENGINE_PATH = ROOT === '/app'
  ? '/app/routes/intent-evaluator-v2.js'
  : path.join(__dirname, '..', 'routes', 'intent-evaluator-v2.js');

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  const eq = arg.indexOf('=');
  if (eq > 0) {
    const key = arg.slice(0, eq).replace(/^--/, '');
    args[key] = arg.slice(eq + 1);
  }
}

const graphArg = args.graph || '';
const casesArg = args.cases || '';
const limit = Math.max(0, parseInt(args.limit || '0', 10));
const outPath = args.out ? (path.isAbsolute(args.out) ? args.out : path.resolve(ROOT, args.out)) : '';

let graphPath;
if (graphArg.startsWith('rsi:')) {
  graphPath = path.join(ROOT, 'data', 'rsi', graphArg.slice(4));
} else if (graphArg) {
  graphPath = path.resolve(ROOT, graphArg);
} else {
  graphPath = null;
}
if (graphPath) {
  process.env.INTENT_GRAPH_PATH = path.relative(ROOT, graphPath);
  // 审计 P1：评测脚本此前不设置运行时剖面，图谱里的引擎参数/提示词变体被静默忽略，
  // 命令行复核会得出「改参数没用」的错误结论。默认用本次评测的图谱作为运行时图谱。
  if (!process.env.INTENT_RSI_RUNTIME_GRAPH) process.env.INTENT_RSI_RUNTIME_GRAPH = graphPath;
}

const casesPath = casesArg
  ? path.join(ROOT, 'data', 'rsi', casesArg)
  : path.join(ROOT, 'data', 'rsi', 'rsi-eval-cases.json');
if (!fs.existsSync(casesPath)) {
  console.error('Cases file not found:', casesPath);
  process.exit(1);
}
const allCases = JSON.parse(fs.readFileSync(casesPath, 'utf8'));
let cases = Array.isArray(allCases) ? allCases : (allCases.cases || []);
if (limit > 0 && limit < cases.length) cases = cases.slice(0, limit);

console.error(`[engine-score] Graph: ${graphPath || 'default'}, Cases: ${cases.length}, Out: ${outPath || 'stdout'}`);

const { evaluateIntent } = require(ENGINE_PATH);
const { performanceSummary } = require('../routes/rsi-learning');
const { engineRevision } = require('../routes/rsi-engine-revision');
const { mapConcurrent, createUsageObserver, scoreEngineCase } = require('../routes/rsi-scoring-runtime');
const { SCORING_CAPABILITIES } = require('../routes/rsi-case-scoring');

const engineMode = engineRevision(process.env, ROOT).engineMode.split('+')[0];

// ── 引擎指纹（engineRev）：打分器版本锚点 ──
// 同一版本图谱在不同引擎实现下分数不同（10-13 审计 P0-2：v1 的 heldout 在
// 72.2↔77.8 间跳变 3 次，引擎修复前后历史分数被直接对比）。每次打分输出
// 引擎文件指纹，历史分数按指纹归档——指纹不同即不可比，前端明示断点。
// 协议版本 SCORE_PROTO_REV：打分判定协议变化（如新增题型/澄清口径）时 +1。
function engineFingerprint() {
  return engineRevision(process.env, ROOT);
}

async function run() {
  let strictHit = 0;
  let relaxedSum = 0;
  let errors = 0;
  const byShape = {};
  const concurrency = Math.max(1, Math.min(4, Math.floor(Number(args.concurrency)) || 1));
  const batchStarted = performance.now();
  const originalFetch = globalThis.fetch;
  const observer = createUsageObserver(originalFetch);
  globalThis.fetch = observer.fetch;
  let rows;
  try {
  rows = await mapConcurrent(cases, concurrency, async (c, i) => {
    const measured = await observer.measure(() => scoreEngineCase(c, evaluateIntent, { concurrency }));
    if (['engine_error', 'invalid_gold'].includes(measured.value.resultType)) {
      errors++;
      console.error(`[engine-score] Case ${i} ${measured.value.resultType}:`, measured.value.error);
    }
    if ((i + 1) % 20 === 0) console.error(`[engine-score] case ${i + 1}/${cases.length} done`);
    return { ...measured.value, ...measured.usage, ...(measured.value.resultType === 'engine_error' ? { tokens: null } : {}) };
  });
  } finally {
    globalThis.fetch = originalFetch;
  }
  for (const row of rows) {
    if (row.strict) strictHit++;
    relaxedSum += row.relaxed;
    const agg = byShape[row.shape] || (byShape[row.shape] = { total: 0, strict: 0, relaxedSum: 0 });
    agg.total++;
    if (row.strict) agg.strict++;
    agg.relaxedSum += row.relaxed;
  }

  const total = cases.length;
  const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);
  const report = {
    status: 'ok',
    engine: 'intent-evaluator-v2',
    engineMode,
    engineRev: engineFingerprint(),
    scoringCapabilities: SCORING_CAPABILITIES,
    engineErrors: errors,
    execution: { concurrency, wall_ms: Number((performance.now() - batchStarted).toFixed(2)), cases_per_second: Number((cases.length * 1000 / Math.max(1, performance.now() - batchStarted)).toFixed(2)) },
    performance: performanceSummary(rows),
    total,
    strict_pct: pct(strictHit, total),
    relaxed_pct: pct(relaxedSum, total),
    by_shape: Object.fromEntries(Object.entries(byShape).map(([shape, s]) => [
      shape, { total: s.total, strict_pct: pct(s.strict, s.total), relaxed_pct: pct(s.relaxedSum, s.total) },
    ])),
    rows,
    finishedAt: new Date().toISOString(),
  };

  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.error(`[engine-score] strict ${report.strict_pct}% / relaxed ${report.relaxed_pct}% -> ${outPath}`);
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
}

run().catch(err => {
  console.error('[engine-score] Fatal:', err);
  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify({ status: 'error', error: String(err && err.message || err), finishedAt: new Date().toISOString() }, null, 2));
  }
  process.exit(1);
});
