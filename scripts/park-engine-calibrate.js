'use strict';

/**
 * 园区意图引擎校准脚本
 *
 * 用法（容器内）:
 *   node /app/scripts/park-engine-calibrate.js
 *   node /app/scripts/park-engine-calibrate.js --limit=10
 *   node /app/scripts/park-engine-calibrate.js --out=calibration/park-last.json
 */

const fs = require('fs');
const path = require('path');

const ROOT = fs.existsSync('/app/package.json') ? '/app' : path.join(__dirname, '..');
const ENGINE_PATH = ROOT === '/app'
  ? '/app/routes/intent-evaluator-park.js'
  : path.join(__dirname, '..', 'routes', 'intent-evaluator-park.js');

// ── 解析命令行参数 ──
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  const eq = arg.indexOf('=');
  if (eq > 0) {
    const key = arg.slice(0, eq).replace(/^--/, '');
    args[key] = arg.slice(eq + 1);
  }
}

const limit = Math.max(0, parseInt(args.limit || '0', 10));
const outPath = args.out ? (path.isAbsolute(args.out) ? args.out : path.resolve(ROOT, args.out)) : '';

// ── 加载题库 ──
const casesPath = path.join(ROOT, 'data', 'rsi', 'rsi-eval-cases.json');
if (!fs.existsSync(casesPath)) {
  console.error('Cases file not found:', casesPath);
  process.exit(1);
}

const allCases = JSON.parse(fs.readFileSync(casesPath, 'utf8'));
let cases = Array.isArray(allCases) ? allCases : (allCases.cases || []);
if (limit > 0 && limit < cases.length) cases = cases.slice(0, limit);

console.error(`[park-calibrate] Cases: ${cases.length}, Out: ${outPath || 'stdout'}`);

// ── 加载园区引擎 ──
const { evaluateIntentPark } = require(ENGINE_PATH);

// ── 逐条评测 ──
function run() {
  const results = [];
  let strictHit = 0;
  let relaxedSum = 0;
  const byShape = {};

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const query = c.query;
    const expected = c.expected_intents || [];
    const shape = c.intent_shape || 'single_intent';

    try {
      const res = evaluateIntentPark(query, { topk: 5 });
      const predSet = res.predicted_set || [];

      // strict / relaxed 判定
      let strict = false;
      let relaxed = 0;

      if (shape === 'single_intent') {
        // strict: predicted_set[0] in expected
        strict = predSet.length > 0 && expected.includes(predSet[0]);
        relaxed = predSet.some(id => expected.includes(id)) ? 1 : 0;
      } else if (shape === 'multi_intent') {
        // strict: predicted_set === expected (set equality)
        strict = predSet.length === expected.length && expected.every(e => predSet.includes(e));
        const inter = expected.filter(e => predSet.includes(e)).length;
        const union = new Set([...expected, ...predSet]).size;
        relaxed = union ? inter / union : 0;
      } else if (shape === 'ambiguous_intent') {
        // strict: predicted_set contains all expected
        strict = expected.every(e => predSet.includes(e));
        const inter = expected.filter(e => predSet.includes(e)).length;
        const union = new Set([...expected, ...predSet]).size;
        relaxed = union ? inter / union : 0;
      }

      if (strict) strictHit++;
      relaxedSum += relaxed;

      if (!byShape[shape]) byShape[shape] = { total: 0, strict: 0, relaxedSum: 0 };
      byShape[shape].total++;
      if (strict) byShape[shape].strict++;
      byShape[shape].relaxedSum += relaxed;

      results.push({
        case_id: c.case_id || `case_${i}`,
        query,
        shape,
        expected,
        predicted: predSet,
        result_type: res.result_type,
        strict,
        relaxed: Math.round(relaxed * 100) / 100,
        latency_ms: res.latency_ms,
      });

      if (!strict) {
        console.error(`  MISS ${c.case_id} [${shape}] "${query}"`);
        console.error(`    expected: ${JSON.stringify(expected)} | predicted: ${JSON.stringify(predSet)}`);
      }

      if ((i + 1) % 20 === 0) console.error(`[park-calibrate] ${i + 1}/${cases.length} done`);
    } catch (err) {
      console.error(`[park-calibrate] Case ${i} error:`, err.message);
      results.push({
        case_id: c.case_id || `case_${i}`,
        query,
        shape,
        expected,
        error: err.message,
        strict: false,
        relaxed: 0,
      });
    }
  }

  const total = cases.length;
  const strictPct = total ? Math.round((strictHit / total) * 1000) / 10 : 0;
  const relaxedPct = total ? Math.round((relaxedSum / total) * 1000) / 10 : 0;

  const shapeStats = {};
  for (const [shape, s] of Object.entries(byShape)) {
    shapeStats[shape] = {
      total: s.total,
      strict_pct: s.total ? Math.round((s.strict / s.total) * 1000) / 10 : 0,
      relaxed_pct: s.total ? Math.round((s.relaxedSum / s.total) * 1000) / 10 : 0,
    };
  }

  const report = {
    engine: 'intent-evaluator-park',
    total,
    strict_pct: strictPct,
    relaxed_pct: relaxedPct,
    by_shape: shapeStats,
    results,
    finishedAt: new Date().toISOString(),
  };

  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.error(`[park-calibrate] Report written to ${outPath}`);
  } else {
    console.log(JSON.stringify(report, null, 2));
  }

  // 摘要输出
  console.error(`\n=== 园区引擎校准结果 ===`);
  console.error(`Strict: ${strictHit}/${total} (${strictPct}%)`);
  console.error(`Relaxed: ${Math.round(relaxedSum)}/${total} (${relaxedPct}%)`);
  for (const [shape, s] of Object.entries(byShape)) {
    console.error(`  ${shape}: strict ${s.strict}/${s.total} (${Math.round((s.strict / s.total) * 1000) / 10}%)`);
  }

  // 失败用例
  const failures = results.filter(r => !r.strict);
  if (failures.length > 0) {
    console.error(`\n=== 失败用例 (${failures.length}) ===`);
    for (const f of failures) {
      console.error(`${f.case_id} [${f.shape}] ${f.query}`);
      console.error(`  expected: ${JSON.stringify(f.expected)} | predicted: ${JSON.stringify(f.predicted)}`);
    }
  }
}

run();
