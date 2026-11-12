'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createProductionRuntime } = require('../routes/rsi-production-runtime');
const goal = require('../routes/rsi-goal');
const { summarize } = require('../routes/rsi-strategy');
const { engineRevision } = require('../routes/rsi-engine-revision');
const TEST_TMP_ROOT = path.join(__dirname, '..', '.tmp-tests');
fs.mkdirSync(TEST_TMP_ROOT, { recursive: true });
const rev = { engineSha: 'remediation-fixture', protoRev: 7, engineMode: 'online+decl' };
const clone = value => JSON.parse(JSON.stringify(value));
const results = [{ case_id: 't', strict: false }, { case_id: 'h', strict: true }];
const scores = n => ({ engineRev: rev, all: { total: 2, strict_pct: n, relaxed_pct: n }, train: { total: 1, strict_pct: n, relaxed_pct: n }, heldout: { total: 1, strict_pct: n, relaxed_pct: n } });
function directory(t) {
  const dir = fs.mkdtempSync(path.join(TEST_TMP_ROOT, 'rsi-remediation-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(dir)), path.resolve(TEST_TMP_ROOT)); fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}
function fixture(t, extra = {}) {
  const dir = directory(t);
  let state = { currentVersion: 'v1', versions: [{ version: 'v1' }], archive: [], log: [], regression: {}, split: { train: ['t'], heldout: ['h'], test: ['x'] }, stats: {}, evolveRuns: [], scoreHistory: [] };
  const graph = { meta: {}, intent_nodes: [] };
  const runtime = createProductionRuntime({ root: dir, rsiDir: dir, defaultDecisionMode: 'rules', loadState: () => clone(state), saveState: s => state = clone(s), loadGraph: () => clone(graph), saveVersion: () => {}, readCases: () => ['t', 'h', 'x'].map(case_id => ({ case_id })), revision: () => rev, publicState: s => s,
    scoreGraph: async () => ({ scores: scores(70), results }), propose: async () => [{ graph: { ...graph, meta: { changed: true } }, target: 'graph', summary: 'fixture candidate' }], ...extra });
  return { runtime, state: () => state, dir };
}
test('acceptance goal rejects explicit partial-credit or unknown metrics', () => {
  assert.throws(() => goal.normalizeGoal({ metric: 'relaxed_pct', target: 85 }), /strict_pct|完全正确率/);
  assert.throws(() => goal.normalizeGoal({ metric: 'typo' }), /strict_pct|完全正确率/);
  assert.equal(goal.normalizeGoal({ target: 85 }).metric, 'strict_pct');
  assert.equal(goal.goalProgress({ target: 85 }, { all: { total: 2, strict_pct: 50, relaxed_pct: 90 } }, results).met, false);
});

test('task-list score validity reads only current evidence and never builds detailed state', async t => {
  let projections=0;
  const f=fixture(t,{publicState:()=>{projections++;throw new Error('full candidate projection forbidden for task list');}});
  await f.runtime.baseline();
  const value=f.runtime.scoreValidity(f.state());
  assert.equal(value.current,true);
  assert.equal(value.value,50);
  assert.equal(projections,0);
});

test('conversation instruction is validated, frozen and passed to actual candidate generation',async t=>{
 let observed;
 const f=fixture(t,{propose:async({graph,config})=>{observed=config.userInstruction;return [{graph:{...graph,meta:{changed:true}},target:'graph',summary:'fixture candidate'}];}});
 assert.throws(()=>f.runtime.configOf({userInstruction:{bad:true}}),/优化要求|instruction/);
 assert.throws(()=>f.runtime.configOf({userInstruction:'x'.repeat(2001)}),/2000|优化要求/);
 const run=await f.runtime.evolve({userInstruction:'  优先修复澄清候选过多，保护明确问法  ',maxRounds:1});
 assert.equal(observed,'优先修复澄清候选过多，保护明确问法');
 assert.equal(run.userInstruction,observed);
 assert.equal(f.state().evolveRuns[0].userInstruction,observed);
 const saved=JSON.parse(fs.readFileSync(require('node:path').join(f.dir,'checkpoints','legacy',run.id+'.json'),'utf8'));
 assert.equal(saved.config.userInstruction,observed);
});

test('lightweight score validity invalidates changed cases or engine without returning historic accuracy',async t=>{
  let engine=rev,cases=['t','h','x'].map(case_id=>({case_id}));
  const f=fixture(t,{revision:()=>engine,readCases:()=>cases});
  await f.runtime.baseline();
  assert.equal(f.runtime.scoreValidity(f.state()).current,true);
  engine={...rev,engineSha:'changed'};
  assert.equal(f.runtime.scoreValidity(f.state()).current,false);
  assert.equal(f.runtime.scoreValidity(f.state()).value,null);
  engine=rev;cases=[...cases,{case_id:'new'}];
  assert.equal(f.runtime.scoreValidity(f.state()).current,false);
});
for (const fresh of [true, false]) test(`rules reserve an entire repeat group including ${fresh ? 'reused' : 'new'} baseline cost`, async t => {
  let actual = 0;
  const f = fixture(t, { scoreGraph: async () => { actual++; return { scores: scores(70), results }; } });
  if (fresh) { await f.runtime.baseline(); actual = 0; }
  const run = await f.runtime.evolve({ maxRounds: 3, repeatVotes: 3, optimization: { targets: ['graph'], budget: { maxMetricCalls: fresh ? 2 : 3, maxMinutes: 1 } } });
  assert.equal(actual, fresh ? 0 : 1);
  assert.equal(run.metricCalls, actual);
  assert.equal(run.stopReason, 'metric_budget');
  assert.equal(run.branches.b1.status, 'budget_skipped');
});
test('parallel candidate workers atomically reserve whole repeat groups', async t => {
  let actual = 0;
  const f = fixture(t, { scoreGraph: async () => { actual++; await new Promise(r => setTimeout(r, 2)); return { scores: scores(70), results }; }, propose: async ({ graph }) => [1, 2, 3].map(changed => ({ graph: { ...graph, meta: { changed } }, target: 'graph' })) });
  await f.runtime.baseline(); actual = 0;
  const run = await f.runtime.evolve({ maxRounds: 1, repeatVotes: 3, scoringConcurrency: 3, optimization: { targets: ['graph'], budget: { maxMetricCalls: 4 } } });
  assert.equal(actual, 3); assert.equal(run.metricCalls, 3); assert.equal(run.stopReason, 'metric_budget');
});
test('stop cancels every repeat and awaits asynchronous score cleanup before returning', async t => {
  let started = 0, aborted = 0, cleaned = 0, f;
  f = fixture(t, { scoreGraph: async (graph, options) => {
    if (!graph.meta.changed) return { scores: scores(70), results };
    started++;
    const pending = new Promise((resolve, reject) => options.signal.addEventListener('abort', () => { aborted++; setTimeout(() => { cleaned++; reject(new Error('cancelled')); }, 10); }, { once: true }));
    if (started === 3) queueMicrotask(() => f.runtime.stop());
    // Bound the regression test even if a controller is leaked.
    const fallback = setTimeout(() => { cleaned++; }, 100);
    const escaped = new Promise(resolve => setTimeout(() => resolve({ scores: scores(70), results }), 120));
    try { return await Promise.race([pending, escaped]); } finally { clearTimeout(fallback); }
  } });
  await f.runtime.baseline();
  const run = await f.runtime.evolve({ maxRounds: 1, repeatVotes: 3 });
  assert.equal(run.status, 'stopped'); assert.equal(aborted, 3); assert.equal(cleaned, 3);
  assert.equal(f.runtime.runningTaskId(), null);
});
test('failed repeat cancels its siblings and waits for them without recording a score', async t => {
  let started = 0, cancelled = 0, cleaned = 0;
  const f = fixture(t, { scoreGraph: async (graph, options) => {
    if (!graph.meta.changed) return { scores: scores(70), results };
    const index = ++started;
    if (index === 1) { await new Promise(r => setTimeout(r, 2)); throw new Error('invalid vote'); }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ scores: scores(70), results }), 100);
      options.signal.addEventListener('abort', () => { cancelled++; clearTimeout(timer); setTimeout(() => { cleaned++; reject(new Error('sibling cancelled')); }, 8); }, { once: true });
    });
  } });
  await f.runtime.baseline(); const run = await f.runtime.evolve({ maxRounds: 1, repeatVotes: 3 });
  assert.equal(cancelled, 2); assert.equal(cleaned, 2); assert.equal(run.branches.b1.fullScores, undefined); assert.equal(f.state().archive.length, 0);
});
test('model promotion reserves all repeat votes after its probe and baseline', async t => {
  const calls = [];
  const instruction = '只保留动作与对象一致的候选，保护已有明确表达；信息不足时澄清，不扩大无关业务候选。';
  const f = fixture(t, { propose: undefined, extractJsonArray: JSON.parse,
    callLLM: async messages => JSON.stringify(messages[0].content.includes('研究员') ? {
      summary: '检验裁决边界是否引入多余候选', diagnoses: [{ id: 'h1', cause: '裁决未过滤无关动作', evidenceCaseIds: ['t'], probe: '只收紧边界指令对比坏例' }],
      experiments: [{ id: 'e1', hypothesisId: 'h1', parentId: 'b0', target: 'recognition_prompt', kind: 'improvement', caseIds: ['t'], controlCaseIds: [], component: 'boundary', instruction, successCriterion: '训练坏例完全修复且不会引入新的无关候选' }], decision: { action: 'continue', reason: '已有训练坏例支持单变量实验' },
    } : messages[0].content.includes('复盘') ? { decision: 'stop', reason: '剩余完整评测预算不足', nextFocusCaseIds: ['t'], rejectedHypothesisIds: [] } : [{ component: 'boundary', text: instruction, motivation: '排除无关动作，修复训练坏例' }]),
    scoreGraph: async (graph, options) => { calls.push({ probe: !!options.probeIds }); return { scores: scores(70), results: options.ids.map(case_id => ({ case_id, strict: case_id !== 't' || !!graph.meta.rsi_runtime?.prompts?.boundary })) }; },
  });
  const run = await f.runtime.evolve({ maxRounds: 1, repeatVotes: 3, optimization: { targets: ['recognition_prompt'], decisionMode: 'model', budget: { maxMetricCalls: 3 } } });
  assert.equal(run.probeCalls, 1, JSON.stringify(run.rounds)); assert.equal(run.metricCalls, 1); assert.equal(calls.length, 2);
  assert.equal(run.branches.b1.status, 'budget_skipped'); assert.equal(f.state().archive.length, 0);
});
test('elapsed run deadline cancels all repeat scores and awaits cleanup', async t => {
  let cancelled = 0, cleaned = 0;
  const now = Date.now;
  t.after(() => { Date.now = now; });
  const f = fixture(t, { scoreGraph: async (graph, options) => {
    if (!graph.meta.changed) return { scores: scores(70), results };
    return new Promise((resolve, reject) => {
      const fallback = setTimeout(() => resolve({ scores: scores(70), results }), 100);
      options.signal.addEventListener('abort', () => { cancelled++; clearTimeout(fallback); setTimeout(() => { cleaned++; reject(options.signal.reason); }, 5); }, { once: true });
    });
  } });
  await f.runtime.baseline();
  const run = await f.runtime.evolve({ maxRounds: 1, repeatVotes: 3, optimization: { targets: ['graph'], budget: { maxMinutes: 1 } } }, event => {
    if (event.step === 'evaluate') Date.now = () => now() + 60001;
  });
  assert.equal(run.stopReason, 'time_budget'); assert.equal(cancelled, 3); assert.equal(cleaned, 3); assert.equal(f.state().archive.length, 0);
});
for (const decisionMode of ['model', 'rules', 'agent']) test(`stop cancels an in-flight ${decisionMode} proposer and awaits cleanup`, async t => {
  let cleaned = false, f;
  const waiting = signal => new Promise((resolve, reject) => {
    const fallback = setTimeout(() => resolve('[]'), 100);
    signal.addEventListener('abort', () => { clearTimeout(fallback); setTimeout(() => { cleaned = true; reject(signal.reason); }, 5); }, { once: true });
    queueMicrotask(() => f.runtime.stop());
  });
  f = fixture(t, { propose: undefined, extractJsonArray: JSON.parse, callLLM: (messages, timeout, tokens, signal) => waiting(signal), agentUrl: 'http://fixture.invalid' });
  if (decisionMode === 'agent') {
    const fetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = fetch; });
    globalThis.fetch = (url, options) => waiting(options.signal);
  }
  const run = await f.runtime.evolve({ maxRounds: 1, optimization: { targets: ['graph'], decisionMode } });
  assert.equal(run.status, 'stopped'); assert.equal(cleaned, true); assert.equal(f.state().archive.length, 0);
});
test('stopping a scorer subprocess awaits exit and removes its temporary score files', async t => {
  const root = directory(t), pidFile = path.join(root, 'scorer.pid');
  write(root, 'scripts/rsi-engine-score.js', `const fs=require('node:fs');const args=Object.fromEntries(process.argv.slice(2).map(s=>{const i=s.indexOf('=');return[s.slice(2,i),s.slice(i+1)]}));const graph=JSON.parse(fs.readFileSync(args.graph));if(graph.meta.changed){fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);}else{fs.writeFileSync(args.out,JSON.stringify({status:'ok',engineRev:${JSON.stringify(rev)},rows:${JSON.stringify(results)}}));}`);
  const f = fixture(t, { root, scoreGraph: undefined });
  await f.runtime.baseline();
  const running = f.runtime.evolve({ maxRounds: 1, repeatVotes: 3 });
  const limit = Date.now() + 3000;
  while (!fs.existsSync(pidFile) && Date.now() < limit) await new Promise(resolve => setTimeout(resolve, 5));
  f.runtime.stop();
  const run = await running;
  assert.equal(run.status, 'stopped'); assert.equal(fs.existsSync(pidFile), true);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.equal(fs.readdirSync(path.join(f.dir, 'drafts')).some(name => /production-/.test(name)), false);
});
function historical(parent) {
  return { baseline: { scores: { engineRev: rev, train: { strict_pct: 90 } }, results: [] }, evolveRuns: [{ id: 'old', engineRev: rev, branches: { ...(parent ? { b0: parent } : {}), b1: { id: 'b1', parent: 'b0', target: 'graph', status: 'alive', scores: { trainStrict: 75 }, proposal: { type: 'A1_utterance_expand' } } } }] };
}
test('strategy attributes compact historical scores to their actual parent with provenance', () => {
  const s = summarize(historical({ id: 'b0', op: 'root', scores: { trainStrict: 70 } }));
  assert.equal(s.arms[0].gainSum, 5); assert.equal(s.measuredCount, 1);
  assert.deepEqual(s.arms[0].comparisons[0], { runId: 'old', branchId: 'b1', parentBranchId: 'b0', parentSource: 'branch.scores.trainStrict', ownSource: 'branch.scores.trainStrict', before: 70, after: 75, delta: 5 });
});
test('strategy excludes missing historical parents instead of substituting the current baseline', () => {
  const s = summarize(historical());
  assert.equal(s.measuredCount, 0); assert.equal(s.arms[0].gainSum, 0); assert.equal(s.arms[0].wins, 0); assert.equal(s.arms[0].uncomparableAttempts, 1);
});
function write(root, name, value) { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); }
test('fingerprint includes FAQ and dependent scoring modules, with deterministic missing files', t => {
  const root = directory(t), initial = engineRevision({}, root);
  assert.deepEqual(engineRevision({}, root), initial);
  for (const file of ['data/graphs/intent-faq-seed.json', 'routes/rsi-learning.js', 'tools/intent-graph-schema.js', 'routes/intent-evaluator-graphs.js']) {
    const before = engineRevision({}, root); write(root, file, 'fixture'); assert.notEqual(engineRevision({}, root).engineSha, before.engineSha, file);
  }
});
test('fingerprint tracks routing models and endpoints but excludes secrets and secret file paths', t => {
  const root = directory(t);
  const config = (model, secret) => `module.exports={API_ROUTES:{'qwen-plus':{host:'models.example',path:'/chat',model:'${model}',provider:'qwen',getKey:()=> '${secret}'},'text-embedding-v4':{host:'models.example',path:'/embedding',model:'embed',dim:1024}}};`;
  write(root, 'config/api-keys.js', config('old', 'secret-a'));
  const first = engineRevision({ QWEN_KEY: 'one' }, root);
  write(root, 'config/api-keys.js', config('new', 'secret-a'));
  const changed = engineRevision({ QWEN_KEY: 'one' }, root); assert.notEqual(first.engineSha, changed.engineSha);
  write(root, 'config/api-keys.js', config('new', 'secret-b'));
  assert.deepEqual(engineRevision({ QWEN_KEY: 'two' }, root), changed);
  assert.deepEqual(engineRevision({ AI_BANK_AGENT_RUNTIME_TOKEN_FILE: '/secret/a' }, root), engineRevision({ AI_BANK_AGENT_RUNTIME_TOKEN_FILE: '/secret/b' }, root));
});
