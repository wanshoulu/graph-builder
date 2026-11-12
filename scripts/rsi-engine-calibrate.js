'use strict';

/**
 * RSI 双验证器校准脚本 — 独立子进程里用生产意图引擎 evaluateIntent 对 RSI 题库
 * 逐题打分，与沙盒内置轻量验证器（intent-rsi.js 的 matchOne/evalCase）对照，
 * 输出一致率报告。
 *
 * 输出契约（routes/intent-rsi.js calibrationPublicState 消费，字段不可随意改名）：
 *   { status:'ok', engineMode, engineErrors, engineMeta, matchOneScores,
 *     agreement:{ total, overallPct, byShape:{shape:{total,agreePct}} },
 *     total, rows:[{case_id,query,shape,agree,error?,detail?}], finishedAt }
 *
 * 用法：
 *   node scripts/rsi-engine-calibrate.js --graph=rsi:versions/rsi-graph.v2.json \
 *        --cases=rsi-eval-cases.json --out=calibration/last.json [--limit=0]
 *
 * API key 全清（由调用方保证）：引擎降级为离线确定性形态，不写生产语义缓存。
 */

const fs = require('fs');
const path = require('path');

// __dirname 在 /tmp 时回退到 /app
const ROOT = fs.existsSync('/app/package.json') ? '/app' : path.join(__dirname, '..');
const ENGINE_PATH = ROOT === '/app'
  ? '/app/routes/intent-evaluator-v2.js'
  : path.join(__dirname, '..', 'routes', 'intent-evaluator-v2.js');
const RSI_MODULE_PATH = ROOT === '/app'
  ? '/app/routes/intent-rsi.js'
  : path.join(__dirname, '..', 'routes', 'intent-rsi.js');

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

const graphArg = args.graph || '';
const casesArg = args.cases || '';
const outPath = args.out ? (path.isAbsolute(args.out) ? args.out : path.resolve(ROOT, args.out)) : '';
const limit = Math.max(0, parseInt(args.limit || '0', 10));

// ── 解析图谱路径（rsi: 前缀 = data/rsi 下相对路径；同时给生产引擎设 INTENT_GRAPH_PATH）──
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
  if (!process.env.INTENT_RSI_RUNTIME_GRAPH) process.env.INTENT_RSI_RUNTIME_GRAPH = graphPath;
}

// ── 加载题库 ──
const casesPath = casesArg
  ? (path.isAbsolute(casesArg) ? casesArg : path.join(ROOT, 'data', 'rsi', casesArg))
  : path.join(ROOT, 'data', 'rsi', 'rsi-eval-cases.json');

if (!fs.existsSync(casesPath)) {
  console.error('Cases file not found:', casesPath);
  process.exit(1);
}

const allCases = JSON.parse(fs.readFileSync(casesPath, 'utf8'));
let cases = Array.isArray(allCases) ? allCases : (allCases.cases || []);
if (limit > 0 && limit < cases.length) cases = cases.slice(0, limit);

console.error(`[calibrate] Graph: ${graphPath || 'default'}, Cases: ${cases.length}, Out: ${outPath || 'stdout'}`);

// ── 加载生产引擎 + 沙盒验证器（只读 __test 出口，不含写路径）──
const { evaluateIntent } = require(ENGINE_PATH);
const sandbox = require(RSI_MODULE_PATH).__test || {};
if (typeof sandbox.evalCase !== 'function') {
  console.error('[calibrate] intent-rsi.__test.evalCase 不可用，无法对照');
  process.exit(1);
}
const sandboxGraph = graphPath && fs.existsSync(graphPath) ? JSON.parse(fs.readFileSync(graphPath, 'utf8')) : null;
if (!sandboxGraph) {
  console.error('[calibrate] 沙盒图谱不可读：' + graphPath);
  process.exit(1);
}

const engineMode = (process.env.QWEN_KEY || process.env.DEEPSEEK_KEY || process.env.KIMI_KEY || process.env.GLM_KEY || process.env.VOLCANO_KEY)
  ? 'online' : 'offline-deterministic';

function shapeLabel(shape) {
  return shape === 'multi_intent' ? '复合句' : shape === 'ambiguous_intent' ? '模糊提问' : '单意图';
}

// 双方判定是否一致：strict 结论一致且部分得分差 < 0.01
function agreeOf(sb, en) {
  return sb.strict === en.strict && Math.abs(sb.relaxed - en.relaxed) < 0.01;
}

function verdictText(sb) {
  if (sb.strict) return '完全正确';
  if (sb.relaxed > 0) return `部分正确(${sb.relaxed.toFixed(2)})`;
  return '不得分';
}

async function run() {
  const rows = [];
  let agreeCount = 0;
  let engineErrors = 0;
  const byShape = {};
  const sbByShape = {};
  let sbStrictHit = 0, sbRelaxedSum = 0, enStrictHit = 0, enRelaxedSum = 0;

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const query = c.query;
    const expected = c.expected_intents || [];
    const shape = c.intent_shape || 'single_intent';

    // 沙盒侧判定
    let sb;
    try {
      sb = sandbox.evalCase(c, sandboxGraph);
    } catch (e) {
      sb = { strict: false, relaxed: 0, error: e.message };
    }

    // 生产引擎侧判定
    let en = { strict: false, relaxed: 0 };
    let error = null;
    try {
      const res = await evaluateIntent(query, { topk: 5 });
      const finalResult = res.final_result || {};
      const top1Id = finalResult.intent_id || '';
      const authResults = res.authoritative_results || [];
      const topkIds = authResults.map(r => r.intent_id).filter(Boolean);
      const understanding = res.understanding || {};
      const clarification = understanding.clarification || {};
      const isClarifying = clarification.needed === true;
      const candidateIds = (clarification.options || []).map(o => o.intent_id).filter(Boolean);

      if (shape === 'single_intent') {
        const effectiveTop1 = isClarifying ? null : top1Id;
        en.strict = effectiveTop1 !== null && expected.includes(effectiveTop1);
        en.relaxed = topkIds.some(id => expected.includes(id)) ? 1 : 0;
      } else if (shape === 'multi_intent') {
        const segResults = res.segment_results || [];
        const predSet = [];
        for (const seg of segResults) {
          const segFinal = seg.final_result || {};
          if (segFinal.intent_id && !predSet.includes(segFinal.intent_id)) predSet.push(segFinal.intent_id);
        }
        const inter = expected.filter(e => predSet.includes(e)).length;
        const union = new Set([...expected, ...predSet]).size;
        en.relaxed = union ? inter / union : 0;
        en.strict = predSet.length === expected.length && expected.every(e => predSet.includes(e));
      } else if (shape === 'ambiguous_intent') {
        en.strict = isClarifying && expected.every(e => candidateIds.includes(e));
        en.relaxed = isClarifying ? (expected.filter(e => candidateIds.includes(e)).length / expected.length) : 0;
      }
      en.top1 = top1Id;
      en.clarifying = isClarifying;
    } catch (err) {
      error = err.message;
      engineErrors++;
    }

    if (!sb.error) {
      sbStrictHit += sb.strict ? 1 : 0;
      sbRelaxedSum += sb.relaxed;
    }
    if (!error) {
      enStrictHit += en.strict ? 1 : 0;
      enRelaxedSum += en.relaxed;
    }
    const agg = byShape[shape] || (byShape[shape] = { total: 0, agree: 0 });
    const sba = sbByShape[shape] || (sbByShape[shape] = { total: 0, strict: 0, relaxedSum: 0 });
    agg.total++;
    sba.total++;
    sba.strict += sb.strict ? 1 : 0;
    sba.relaxedSum += sb.relaxed;

    const agree = !error && !sb.error && agreeOf(sb, en);
    if (agree) { agreeCount++; agg.agree++; }

    let detail = '';
    if (error) detail = `生产引擎报错：${error}`;
    else if (sb.error) detail = `沙盒验证器报错：${sb.error}`;
    else if (!agree) {
      detail = `沙盒判「${verdictText(sb)}」，生产引擎判「${verdictText(en)}」`
        + (shape === 'ambiguous_intent' ? `（引擎${en.clarifying ? '反问了' : '没反问'}）` : '');
    }

    rows.push({
      case_id: c.case_id || `case_${i}`,
      query,
      shape,
      expected,
      agree,
      sandboxStrict: sb.strict,
      sandboxRelaxed: sb.relaxed,
      engineStrict: en.strict,
      engineRelaxed: en.relaxed,
      engineTop1: en.top1 || '',
      error: error || undefined,
      detail,
    });

    if ((i + 1) % 20 === 0) console.error(`[calibrate] ${i + 1}/${cases.length} done`);
  }

  const total = cases.length;
  const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);
  const agreement = {
    total,
    overallPct: pct(agreeCount, total),
    byShape: Object.fromEntries(Object.entries(byShape).map(([shape, s]) => [
      shape, { total: s.total, agreePct: pct(s.agree, s.total) },
    ])),
  };
  const matchOneScores = {
    strict_pct: pct(sbStrictHit, total),
    relaxed_pct: pct(sbRelaxedSum, total),
    by_shape: Object.fromEntries(Object.entries(sbByShape).map(([shape, s]) => [
      shape, { total: s.total, strict_pct: pct(s.strict, s.total), relaxed_pct: pct(s.relaxedSum, s.total) },
    ])),
  };
  const engineScores = {
    strict_pct: pct(enStrictHit, total),
    relaxed_pct: pct(enRelaxedSum, total),
  };

  const report = {
    status: 'ok',
    engine: 'intent-evaluator-v2',
    engineMode,
    engineErrors,
    engineMeta: { graph: graphArg, cases: casesArg, engineScores },
    matchOneScores,
    agreement,
    total,
    rows,
    finishedAt: new Date().toISOString(),
  };

  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.error(`[calibrate] Report written to ${outPath} (agreement ${agreement.overallPct}%)`);
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
}

run().catch(err => {
  console.error('[calibrate] Fatal:', err);
  const fail = { status: 'error', error: String(err && err.message || err), finishedAt: new Date().toISOString() };
  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(fail, null, 2));
  }
  process.exit(1);
});
