'use strict';

/**
 * RSI 引擎探针脚本 — 用生产意图引擎（intent-evaluator-v2）对单条 query 打分，
 * 供 agent 工具 probe_query 的"同口径试跑"使用（替代旧沙盒 bigram 仿制品——
 * 10-14 审计：沙盒探针与引擎一致率仅 33%，agent 在局部模型里验证、被门禁引擎否决）。
 *
 * 用法：node scripts/rsi-engine-probe.js --graph=<绝对路径> --query=<q> --out=<绝对路径>
 * 环境：由调用方（routes/intent-rsi.js engineProbe）注入 offlineChildEnv()——
 * 与门禁同环境（含 INTENT_ENGINE_CONSUME_DECLARATIONS=1，key 在场时跑在线三路融合）。
 *
 * 输出：{ status, engineMode, top:[{intent_id,intent_name,score}], top1, clarifying, candidates }
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
    args[arg.slice(0, eq).replace(/^--/, '')] = arg.slice(eq + 1);
  }
}

const graphArg = args.graph || '';
const query = args.query || '';
const outPath = args.out ? (path.isAbsolute(args.out) ? args.out : path.resolve(ROOT, args.out)) : '';
if (!graphArg || !query) {
  console.error('[engine-probe] --graph 与 --query 必填');
  process.exit(1);
}
process.env.INTENT_GRAPH_PATH = graphArg;

async function run() {
  const { evaluateIntent } = require(ENGINE_PATH);
  const res = await evaluateIntent(query, { topk: 5 });
  const localTop = ((res.methods || {}).local || {}).top || [];
  const finalResult = res.final_result || {};
  const clarification = (res.understanding || {}).clarification || {};
  const report = {
    status: 'ok',
    engine: 'intent-evaluator-v2',
    engineMode: (process.env.QWEN_KEY || process.env.DEEPSEEK_KEY || process.env.KIMI_KEY || process.env.GLM_KEY || process.env.VOLCANO_KEY) ? 'online' : 'offline-deterministic',
    query,
    // 规则路完整排名（词法分数）；在线时另有 embedding/llm_judge 口径可从 methods 取
    top: localTop.map(r => ({
      intent_id: r.intent_id,
      intent_name: r.intent_name || '',
      score: typeof r.local_score === 'number' ? r.local_score : (typeof r.score === 'number' ? r.score : null),
    })),
    top1: finalResult.intent_id || '',
    top1Clarifying: !!(res.methods && res.methods.local && res.methods.local.top1 && res.methods.local.top1.clarifying),
    clarifying: clarification.needed === true,
    candidates: (clarification.options || []).map(o => o.intent_id).filter(Boolean),
    finishedAt: new Date().toISOString(),
  };
  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.error(`[engine-probe] top1=${report.top1} candidates=${report.top.length} -> ${outPath}`);
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
}

run().catch(err => {
  console.error('[engine-probe] Fatal:', err.message);
  if (outPath) {
    try { fs.writeFileSync(outPath, JSON.stringify({ status: 'error', error: String(err && err.message || err), finishedAt: new Date().toISOString() }, null, 2)); } catch (_) {}
  }
  process.exit(1);
});
