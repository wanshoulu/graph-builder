'use strict';

/**
 * RSI 引擎信号归因脚本 — 用生产意图引擎（intent-evaluator-v2）对指定题逐条评测，
 * 输出引擎自带的信号级 attribution（三路一致性/分歧/边界纠正/弱召回）+ 各路方法分数。
 *
 * 与 rsi-engine-score.js 的区别：那个只要总分，这个要逐题归因信号——
 * RSI 的归因环节以引擎 attribution 为数据源（复用生产引擎的归因能力，不重造）。
 *
 * 用法：
 *   node scripts/rsi-engine-attribute.js --graph=<abs或 rsi:相对路径> \
 *        --cases=rsi-eval-cases.json --out=<abs路径.json> [--only=id1,id2,...]
 * API key 全清（调用方保证）：引擎离线确定性形态，不写生产语义缓存。
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
  if (eq > 0) args[arg.slice(0, eq).replace(/^--/, '')] = arg.slice(eq + 1);
}

const graphArg = args.graph || '';
let graphPath;
if (graphArg.startsWith('rsi:')) graphPath = path.join(ROOT, 'data', 'rsi', graphArg.slice(4));
else if (graphArg) graphPath = path.resolve(ROOT, graphArg);
else graphPath = null;
if (graphPath) process.env.INTENT_GRAPH_PATH = path.relative(ROOT, graphPath);

const casesPath = args.cases
  ? (path.isAbsolute(args.cases) ? args.cases : path.join(ROOT, 'data', 'rsi', args.cases))
  : path.join(ROOT, 'data', 'rsi', 'rsi-eval-cases.json');
if (!fs.existsSync(casesPath)) {
  console.error('Cases file not found:', casesPath);
  process.exit(1);
}
const allCases = JSON.parse(fs.readFileSync(casesPath, 'utf8'));
let cases = Array.isArray(allCases) ? allCases : (allCases.cases || []);
const only = (args.only || '').split(',').map(s => s.trim()).filter(Boolean);
if (only.length) cases = cases.filter(c => only.includes(c.case_id));
if (!cases.length) {
  console.error('No cases to attribute (only filter matched nothing)');
  process.exit(1);
}

console.error(`[engine-attribute] Graph: ${graphPath || 'default'}, Cases: ${cases.length}`);

const { evaluateIntent } = require(ENGINE_PATH);

const engineMode = (process.env.QWEN_KEY || process.env.DEEPSEEK_KEY || process.env.KIMI_KEY || process.env.GLM_KEY || process.env.VOLCANO_KEY)
  ? 'online' : 'offline-deterministic';

function briefMethod(m) {
  if (!m) return null;
  const top = (m.top || [])[0] || m.top1 || {};
  return {
    top1_intent: top.intent_id || null,
    top1_score: top.score != null ? Number(top.score.toFixed(3)) : null,
  };
}

async function run() {
  const rows = [];
  let errors = 0;
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    try {
      const res = await evaluateIntent(c.query, { topk: 5 });
      const final = res.final_result || {};
      const understanding = res.understanding || {};
      const clarification = understanding.clarification || {};
      // 多意图：逐段归因也带上（segment_results 每段自带 attribution）
      const segments = (res.segment_results || []).map(s => ({
        segment_query: s.query || '',
        final_intent: (s.final_result || {}).intent_id || null,
        attribution: s.attribution || null,
      }));
      rows.push({
        case_id: c.case_id,
        query: c.query,
        shape: c.intent_shape,
        expected: c.expected_intents || [],
        engine_final: final.intent_id || null,
        engine_clarifying: clarification.needed === true,
        engine_candidates: (clarification.options || []).map(o => o.intent_id).filter(Boolean),
        final_source: (res.attribution || {}).final_source || null,
        agreement: (res.attribution || {}).agreement,
        signals: ((res.attribution || {}).signals || []).map(s => ({ type: s.type, level: s.level, message: s.message })),
        recommendation: (res.attribution || {}).recommendation || null,
        methods: {
          local: briefMethod((res.methods || {}).local),
          embedding: briefMethod((res.methods || {}).embedding),
        },
        segments,
      });
    } catch (err) {
      errors++;
      console.error(`[engine-attribute] Case ${c.case_id} error:`, err.message);
      rows.push({ case_id: c.case_id, query: c.query, error: err.message });
    }
    if ((i + 1) % 10 === 0) console.error(`[engine-attribute] ${i + 1}/${cases.length} done`);
  }
  const report = {
    status: 'ok',
    engine: 'intent-evaluator-v2',
    engineMode,
    graph: graphArg,
    total: rows.length,
    engineErrors: errors,
    rows,
    finishedAt: new Date().toISOString(),
  };
  const outPath = args.out ? (path.isAbsolute(args.out) ? args.out : path.resolve(ROOT, args.out)) : '';
  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.error(`[engine-attribute] ${rows.length} rows -> ${outPath}`);
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
}

run().catch(err => {
  console.error('[engine-attribute] Fatal:', err);
  process.exit(1);
});
