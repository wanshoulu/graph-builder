'use strict';
// Run the actual RSI loop and actual production scoring engine in a private
// state directory. No public reset/evolve/adopt endpoint is used. Defaults to
// offline execution (no model keys); this is pipeline evidence, not online gain.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const root = path.join(__dirname, '..');
const concurrency = Math.max(1, Math.min(4, Number(process.argv.find(a => a.startsWith('--concurrency='))?.split('=')[1]) || 1));
const rsi = path.join(root, 'data/rsi');
const sandbox = fs.mkdtempSync(path.join(rsi, 'validation-'));
const filename = path.join(root, 'routes/intent-rsi.js');
const original = JSON.parse(fs.readFileSync(path.join(rsi, 'rsi-state.json'), 'utf8'));
const state = JSON.parse(JSON.stringify(original));
state.baseline = null; state.branches = {}; state.population = []; state.archive = [];
state.scoreHistory = []; state.evolveRuns = []; state.methodHistory = []; state.activeEvolution = null;
state.attribution = null; state.regression = {}; state.log = []; state.stats = {};
state.rsiConfig = { improveLayers: ['engine'] };
// Only inputs are copied; original experiment state and versions stay untouched.
for (const name of ['rsi-graph.v1.json', 'rsi-eval-cases.json', 'rsi-eval-cases.imported.json']) {
  const file = path.join(rsi, name);
  if (fs.existsSync(file)) fs.copyFileSync(file, path.join(sandbox, name));
}
for (const dir of ['snapshots', 'versions']) {
  if (fs.existsSync(path.join(rsi, dir))) fs.cpSync(path.join(rsi, dir), path.join(sandbox, dir), { recursive: true });
}
fs.writeFileSync(path.join(sandbox, 'rsi-state.json'), JSON.stringify(state));
const exportsHolder = { exports: {} };
const context = { require: createRequire(filename), module: exportsHolder, exports: exportsHolder.exports,
  __dirname: path.dirname(filename), __filename: filename, process, console, Buffer, URL,
  setTimeout, clearTimeout, setInterval, clearInterval };
const source = fs.readFileSync(filename, 'utf8').replace("const RSI_DIR = path.join(ROOT, 'data', 'rsi');", `const RSI_DIR = ${JSON.stringify(sandbox)};`);
vm.runInNewContext(source + '\nmodule.exports.validationDeps = {loadState,saveState,loadGraph,readCases,publicState,aggregate,attributeResults};', context, { filename });
// Keep real evaluator spawning, rewrite only sandbox file addressing. The
// scoring script normally resolves relative cases under the public RSI root.
const env = {};
for (const key of ['PATH', 'SystemRoot', 'windir', 'LANG', 'TZ']) if (process.env[key]) env[key] = process.env[key];
const runtime = require('../routes/rsi-production-runtime').createProductionRuntime({
  ...exportsHolder.exports.validationDeps, root, rsiDir: sandbox, childEnv: () => env,
  saveVersion: () => { throw new Error('Validation must not promote'); },
});
async function main() {
  const normalize = require('../routes/rsi-optimization').normalizeOptimizationConfig;
  await runtime.evolve({ multiBranch: true, maxRounds: 3, noImproveRounds: 5, scoringConcurrency: concurrency,
    strategy: 'manual', optimization: normalize({ targets: ['engine'], allowMerge: false, maxMetricCalls: 20, maxMinutes: 15 }) },
  e => { if (['gen_start', 'gen_done', 'no_mutations', 'mutate_error', 'done'].includes(e.step)) console.log(e.detail); });
  const result = JSON.parse(fs.readFileSync(path.join(sandbox, 'rsi-state.json'), 'utf8'));
  const run = result.evolveRuns.at(-1);
  const beforeHash = require('node:crypto').createHash('sha256').update(JSON.stringify(original)).digest('hex');
  const after = JSON.parse(fs.readFileSync(path.join(rsi, 'rsi-state.json'), 'utf8'));
  const afterHash = require('node:crypto').createHash('sha256').update(JSON.stringify(after)).digest('hex');
  const report = { mode: 'offline-real-engine', sandbox, productionStateUnchanged: beforeHash === afterHash,
    baseline: result.baseline?.scores, run, methodHistory: result.methodHistory,
    acceptance: { threeGenerations: run?.rounds.length === 3, allGenerationsMeasured: run?.rounds.every(r => r.evaluated >= 2),
      completeAssets: Object.values(run?.branches || {}).every(b => !!(b.artifactHash || b.candidateHash)),
      consistentRevision: Object.values(run?.branches || {}).every(b => b.engineRev?.engineSha === run.engineRev?.engineSha),
      noAutomaticPromotion: result.currentVersion === original.currentVersion, independentValidated: false } };
  const out = path.join(sandbox, 'validation-report.json');
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ report: out, acceptance: report.acceptance, productionStateUnchanged: report.productionStateUnchanged }, null, 2));
  if (!report.acceptance.threeGenerations || !report.acceptance.allGenerationsMeasured || !report.acceptance.consistentRevision || !report.productionStateUnchanged) process.exitCode = 1;
}
main().catch(e => { console.error(e.stack); process.exitCode = 1; });
