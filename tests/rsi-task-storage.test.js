'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const testRoot = path.join(process.cwd(), '.tmp-tests');
fs.mkdirSync(testRoot, { recursive: true });
const dir = fs.mkdtempSync(path.join(testRoot, 'rsi-task-contract-'));
process.env.INTENT_RSI_DIR = dir;
const route = require('../routes/intent-rsi');
const { Readable } = require('node:stream');
const {readStateJsonAsync}=require('../routes/rsi-task-store');
const graph = { meta: {}, intent_nodes: ['a', 'b', 'c'].map(id => ({ identity: { intent_id: id, intent_name: id }, semantic_definition: {}, retrieval_profile: {} })) };
const cases = n => Array.from({ length: n }, (_, i) => ({ case_id: `q${i}`, query: `query ${i}`, intent_shape: 'single_intent', expected_intents: ['a'] }));
fs.writeFileSync(path.join(dir, 'rsi-graph.v1.json'), JSON.stringify(graph));
fs.writeFileSync(path.join(dir, 'rsi-eval-cases.json'), JSON.stringify({ cases: cases(100) }));
const stored = id => JSON.parse(fs.readFileSync(path.join(dir, 'tasks', id, 'state.json')));
async function request(endpoint, { method = 'GET', body, headers = {} } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  req.method = method; req.url = '/api/intent-rsi' + endpoint; req.pathname = req.url.split('?')[0]; req.headers = headers;
  let status, output;
  const res = { writeHead: code => { status = code; }, end: data => { output = JSON.parse(data); } };
  await route.handleIntentRsiRequest(req, res);
  return { status, ...output };
}
const create = (name, opts = {}) => request('/tasks/create', { method: 'POST', body: { name, ...opts } });

test('one unreadable task does not prevent healthy tasks from loading',async()=>{
 await create('healthy-list-task');
 const broken=path.join(dir,'tasks','broken-list-task');fs.mkdirSync(broken,{recursive:true});fs.writeFileSync(path.join(broken,'state.json'),'{invalid');
 try{
  const result=await request('/tasks');
  assert.equal(result.status,200,JSON.stringify(result));
  assert.ok(result.tasks.find(t=>t.id==='healthy-list-task'));
  assert.ok(result.tasks.find(t=>t.id==='broken-list-task').loadError);
 }finally{fs.rmSync(broken,{recursive:true,force:true});}
});

test('asynchronous task reads yield during cold IO, isolate objects and observe replacements',async()=>{
 const file=path.join(dir,'async-state-fixture.json');
 fs.writeFileSync(file,JSON.stringify({revision:1,nested:{name:'first'}}));
 let settled=false;
 const cold=readStateJsonAsync(file).then(v=>{settled=true;return v;});
 await Promise.resolve();assert.equal(settled,false);
 const one=await cold;one.nested.name='mutated';
 assert.equal((await readStateJsonAsync(file)).nested.name,'first');
 const next=file+'.next';fs.writeFileSync(next,JSON.stringify({revision:2,nested:{name:'second'}}));fs.renameSync(next,file);
 assert.equal((await readStateJsonAsync(file)).revision,2);
 fs.unlinkSync(file);
 await assert.rejects(readStateJsonAsync(file),/ENOENT/);
});

test('case review HTTP endpoint excludes sealed cases and rejects direct requests for them',async()=>{
 await create('case-review-reader',{trainRatio:.7,testRatio:.15});
 const st=stored('case-review-reader');
 const out=await request('/case-review?taskId=case-review-reader');
 assert.equal(out.status,200,JSON.stringify(out));
 assert.equal(out.rows.length,st.split.train.length+st.split.heldout.length);
 assert.equal(out.sealedTestCount,st.split.test.length);
 assert.ok(out.rows.every(r=>!st.split.test.includes(r.caseId)));
 const hidden=await request(`/case-review?taskId=case-review-reader&caseId=${st.split.test[0]}`);
 assert.equal(hidden.status,404);
 const invalid=await request('/case-review?taskId=case-review-reader&source=run:../../another');
 assert.equal(invalid.status,404);
});
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
test('RSI storage accepts an isolated root before any write', () => {
  assert.equal(route.__test.rsiDir, dir);
});
test('three-way splitting uses the total population and offers small-sample preview', async () => {
  const out = await create('split-task', { trainRatio: .7, testRatio: .15 });
  assert.equal(out.status, 200, JSON.stringify(out));
  const split = stored('split-task').split;
  assert.deepEqual([split.train.length, split.heldout.length, split.test.length], [70, 15, 15]);
  const preview = await request('/split-preview', { method: 'POST', body: { cases: cases(3), trainRatio: .7, testRatio: .15 } });
  assert.equal(preview.status, 200);
  assert.ok(preview.preview.warnings.length);
});
test('two browser tabs address their own task without trusting the active pointer', async () => {
  await create('tab-alpha', { description: 'keep description', engine: 'source-only' });
  await create('tab-bravo');
  const before = stored('tab-bravo');
  const out = await request('/reset?taskId=tab-alpha', { method: 'POST' });
  assert.equal(out.status, 200);
  assert.equal(out.state.taskId, 'tab-alpha');
  assert.equal(stored('tab-alpha').taskName, 'tab-alpha');
  assert.equal(stored('tab-alpha').taskDesc, 'keep description');
  assert.equal(stored('tab-alpha').engineRef, 'source-only');
  assert.ok(stored('tab-alpha').createdAt);
  assert.deepEqual(stored('tab-bravo'), before);
  assert.equal((await request('/state', { headers: { 'x-rsi-task-id': 'tab-alpha' } })).state.taskId, 'tab-alpha');
  assert.equal((await request('/reset', { method: 'POST' })).status, 400);
});
test('seed datasets are task-owned and a missing task dataset never falls back globally', async () => {
  await create('seed-alpha'); await create('seed-bravo');
  const owned = path.join(dir, 'tasks', 'seed-alpha', 'cases.main.json');
  assert.ok(fs.existsSync(owned));
  fs.unlinkSync(owned);
  const out = await request('/state?taskId=seed-alpha');
  assert.equal(out.status, 409);
  assert.match(out.error, /题库|dataset/);
  assert.equal((await request('/state?taskId=seed-bravo')).status, 200);
});
test('native ambiguous cases round-trip losslessly and testset ambiguous maps explicitly', async () => {
  const canonical = [{ case_id: 'amb', query: 'a or b', intent_shape: 'ambiguous_intent', expected_intents: ['a', 'b'], note: '原文', extra: { preserve: true } }];
  const out = await create('native-import', { cases: canonical, casesName: 'native JSON', engine: 'origin' });
  assert.equal(out.status, 200);
  assert.equal(out.importReport.accepted, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'tasks', 'native-import', 'cases.imported.json'))).cases, canonical);
  const mapped = await create('testset-import', { cases: [{ caseId: 'ts1', query: 'a?', category: 'AMBIGUOUS', expected: { intentIds: ['a', 'b'] } }] });
  assert.equal(mapped.status, 200);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'tasks', 'testset-import', 'cases.imported.json'))).cases[0].intent_shape, 'ambiguous_intent');
});
test('invalid imports report rejected rows and failed creation leaves no task or changed active pointer', async () => {
  const pointer = fs.readFileSync(path.join(dir, 'active-task.json'), 'utf8');
  for (const [suffix, invalid] of [
    ['unknown', [{ ...cases(1)[0], intent_shape: 'made_up' }]],
    ['duplicate', [cases(1)[0], cases(1)[0]]],
    ['foreign', [{ ...cases(1)[0], expected_intents: ['foreign'] }]],
    ['compound', [{ caseId: 'cc', query: 'a and b', category: 'COMPOUND', expected: { intentIds: ['a', 'b'] } }]],
  ]) {
    const name = 'failed-' + suffix;
    const out = await create(name, { cases: invalid });
    assert.equal(out.status, 400, JSON.stringify(out));
    assert.ok(out.importReport.rejected > 0);
    assert.equal(fs.existsSync(path.join(dir, 'tasks', name)), false);
    assert.equal(fs.readFileSync(path.join(dir, 'active-task.json'), 'utf8'), pointer);
  }
  const adapted = await create('compound-adapted', { cases: [{ caseId: 'cc', query: 'a and b', category: 'COMPOUND', expected: { intentIds: ['a', 'b'] } }], multiIntentAdapter: true });
  assert.equal(adapted.status, 200);
});
test('optional revision prevents a stale browser write before reset changes files', async () => {
  await create('revision-task');
  const before = stored('revision-task');
  const out = await request('/reset?taskId=revision-task', { method: 'POST', headers: { 'x-rsi-revision': String((before.revision || 0) + 5) } });
  assert.equal(out.status, 409);
  assert.deepEqual(stored('revision-task'), before);
  const good = await request('/reset?taskId=revision-task', { method: 'POST', headers: { 'x-rsi-revision': String(before.revision) } });
  assert.equal(good.status, 200);
  assert.ok(stored('revision-task').revision > before.revision);
});
test('reset migrates old splitConfig without discarding frozen test IDs', async () => {
  await create('legacy-test', { testRatio: .15 });
  const before = stored('legacy-test'); delete before.splitConfig;
  fs.writeFileSync(path.join(dir, 'tasks', 'legacy-test', 'state.json'), JSON.stringify(before));
  assert.equal((await request('/reset?taskId=legacy-test', { method: 'POST' })).status, 200);
  assert.deepEqual(stored('legacy-test').split, before.split);
});
test('task registry derives real rounds and treats unknown production evidence as stale', async () => {
  await create('summary-task');
  const st = stored('summary-task'); st.taskName = '真实任务名';
  st.evolveRuns = [{ id: 'r1', rounds: [{}, {}, {}] }, { id: 'r2', rounds: [{}] }];
  st.baseline = { version: 'v1', scores: { all: { strict_pct: 99, relaxed_pct: 99 } } };
  st.scoreHistory = [{ version: 'v1', scores: { all: { strict_pct: 99 } } }];
  fs.writeFileSync(path.join(dir, 'tasks', 'summary-task', 'state.json'), JSON.stringify(st));
  const out = await request('/tasks');
  assert.equal(out.status, 200);
  const summary = out.tasks.find(t => t.id === 'summary-task');
  assert.equal(summary.name, '真实任务名');
  assert.equal(summary.rounds, 4); assert.equal(summary.runs, 2);
  assert.equal(summary.baselineCurrent, false);
  assert.equal(summary.bestStrict, null);
});
test('legacy score evidence is projected as single-vote confidence without rewriting stored state', async () => {
  const created = await create('legacy-measure');
  assert.equal(created.status, 200, JSON.stringify(created));
  const st = stored('legacy-measure');
  st.baseline = {
    version: st.currentVersion,
    at: '2026-10-01T00:00:00.000Z',
    scores: { all: { strict_pct: 50, relaxed_pct: 50 } },
    results: [],
  };
  st.scoreHistory = [{ version: st.currentVersion, at: st.baseline.at, scores: st.baseline.scores }];
  fs.writeFileSync(path.join(dir, 'tasks', 'legacy-measure', 'state.json'), JSON.stringify(st));

  const out = await request('/state?taskId=legacy-measure');
  assert.equal(out.status, 200, JSON.stringify(out));
  const legacy = { mode: 'screening', repeatVotes: 1, completedVotes: 1, confidence: 'legacy_single_vote' };
  assert.deepEqual(out.state.baseline.measurement, legacy);
  assert.deepEqual(out.state.scoreHistory[0].measurement, legacy);
  assert.equal(stored('legacy-measure').baseline.measurement, undefined);
  assert.equal(stored('legacy-measure').scoreHistory[0].measurement, undefined);
});
test('calibration reports stay with their task across tab switches', async () => {
  const ca = await create('calib-alpha'), cb = await create('calib-bravo');
  assert.equal(ca.status, 200, JSON.stringify(ca)); assert.equal(cb.status, 200, JSON.stringify(cb));
  for (const [id, total] of [['calib-alpha', 7], ['calib-bravo', 11]]) {
    const target = path.join(dir, 'tasks', id, 'calibration'); fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'last.json'), JSON.stringify({ status: 'ok', total, rows: [], finishedAt: '2026-10-17T00:00:00Z' }));
  }
  const a = await request('/state?taskId=calib-alpha'), b = await request('/state?taskId=calib-bravo');
  assert.equal(a.status, 200, JSON.stringify(a)); assert.equal(b.status, 200, JSON.stringify(b));
  assert.equal(a.state.calibration.report.totalCases, 7);
  assert.equal(b.state.calibration.report.totalCases, 11);
});
test('an already cancelled model request never opens a paid connection', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(route.__test.callLLM([], 100, 10, controller.signal), { name: 'AbortError' });
});
test('atomic JSON replacement preserves old bytes when serialization fails', () => {
  const { writeJson } = require('../routes/rsi-task-store');
  const file = path.join(dir, 'atomic.json'); writeJson(file, { original: true });
  const circular = {}; circular.self = circular;
  assert.throws(() => writeJson(file, circular), /circular/i);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { original: true });
  assert.deepEqual(fs.readdirSync(dir).filter(f => f.endsWith('.tmp')), []);
});
test('an asynchronous import remains bound to its originating tab after the global pointer changes', async () => {
  await create('async-alpha', { description: 'origin', engine: 'source-ref' }); await create('async-bravo');
  const untouched = stored('async-bravo');
  const req = new Readable({ read() {} });
  req.method = 'POST'; req.pathname = '/api/intent-rsi/import-eval-dataset';
  req.url = req.pathname + '?taskId=async-alpha'; req.headers = {};
  let result;
  const pending = route.handleIntentRsiRequest(req, { writeHead: code => { result = { status: code }; }, end: value => Object.assign(result, JSON.parse(value)) });
  await new Promise(resolve => setImmediate(resolve));
  fs.writeFileSync(path.join(dir, 'active-task.json'), JSON.stringify({ id: 'async-bravo' }));
  req.push(Buffer.from(JSON.stringify({ cases: cases(5), casesName: 'tab alpha upload' }))); req.push(null);
  await pending;
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(result.state.taskId, 'async-alpha');
  assert.equal(result.state.engineRef, 'source-ref');
  assert.equal(stored('async-alpha').split.train.length + stored('async-alpha').split.heldout.length, 5);
  assert.deepEqual(stored('async-bravo'), untouched);
});
test('conflicting or unknown task identities fail before changing any task', async () => {
  const before = stored('async-alpha');
  assert.equal((await request('/reset?taskId=async-alpha', { method: 'POST', headers: { 'x-rsi-task-id': 'async-bravo' } })).status, 400);
  assert.equal((await request('/reset?taskId=not-existing', { method: 'POST' })).status, 404);
  assert.equal((await request('/auto-evolve')).status, 400);
  assert.deepEqual(stored('async-alpha'), before);
  assert.equal(fs.existsSync(path.join(dir, 'tasks', 'not-existing')), false);
});
test('generating additional cases preserves the frozen test IDs and task metadata', async t => {
  await create('generated-task', { description: 'generated source', engine: 'original-source', testRatio: .15 });
  const before = stored('generated-task');
  const https = require('node:https'), { EventEmitter } = require('node:events');
  const { API_ROUTES } = require('../config/api-keys');
  const originalRequest = https.request, originalKey = API_ROUTES['qwen-plus'].getKey;
  API_ROUTES['qwen-plus'].getKey = () => 'fixture-only-never-sent';
  https.request = (_opts, callback) => {
    const req = new EventEmitter(); req.write = () => {}; req.destroy = error => req.emit('error', error);
    req.end = () => queueMicrotask(() => {
      const res = new EventEmitter(); res.statusCode = 200; res.setEncoding = () => {};
      callback(res);
      res.emit('data', JSON.stringify({ choices: [{ message: { content: JSON.stringify([{ query: '新增完全独立任务查询内容', intent_shape: 'single_intent', expected_intents: ['b'] }]) } }] }));
      res.emit('end');
    });
    return req;
  };
  t.after(() => { https.request = originalRequest; API_ROUTES['qwen-plus'].getKey = originalKey; });
  const out = await request('/gen-cases?taskId=generated-task', { method: 'POST', body: { count: 10, onlyShape: 'single_intent' } });
  assert.equal(out.status, 200, JSON.stringify(out)); assert.equal(out.added, 1);
  const after = stored('generated-task');
  assert.deepEqual(after.split.test, before.split.test);
  assert.ok(after.split.test.every(id => !after.split.train.includes(id) && !after.split.heldout.includes(id)));
  assert.equal(after.taskName, before.taskName); assert.equal(after.taskDesc, before.taskDesc);
  assert.equal(after.createdAt, before.createdAt); assert.equal(after.engineRef, before.engineRef);
});

test('task rename and reversible archive preserve all evaluation data and sibling tasks', async()=>{
  await create('managed-task'); const original=stored('managed-task'), sibling=stored('async-bravo');
  const rename=await request('/tasks/update?taskId=managed-task',{method:'POST',body:{name:'Readable business goal'}});
  assert.equal(rename.status,200,JSON.stringify(rename));
  assert.equal(stored('managed-task').taskName,'Readable business goal');
  assert.deepEqual(stored('managed-task').split,original.split);
  assert.equal((await request('/tasks/update?taskId=managed-task',{method:'POST',body:{archived:true}})).status,200);
  assert.equal(stored('managed-task').archived,true);
  assert.equal((await request('/tasks/update?taskId=managed-task',{method:'POST',body:{archived:false}})).status,200);
  assert.equal(stored('managed-task').archived,false);
  assert.deepEqual(stored('async-bravo'),sibling);
});

test('an active worker is never mistaken for an orphaned run during ordinary state reads',()=>{
  const state={taskId:'task-alpha',activeEvolution:{id:'run-a',status:'running'}};
  assert.equal(route.__test.isOrphanRun(state,'task-alpha'),false);
  assert.equal(route.__test.isOrphanRun(state,null),true);
  assert.equal(route.__test.isOrphanRun({...state,activeEvolution:{status:'stopped'}},null),false);
});


test('cached task reads avoid rereading unchanged bytes and return isolated mutable states', () => {
 const {readStateJson}=require('../routes/rsi-task-store');
 assert.equal(typeof readStateJson,'function');
 const file=path.join(dir,'cache-read.json');fs.writeFileSync(file,JSON.stringify({revision:1,log:[]}));
 const original=fs.readFileSync;let reads=0;
 fs.readFileSync=function(target,...args){if(target===file)reads++;return original.call(fs,target,...args);};
 try {
  const first=readStateJson(file);first.log.push('caller mutation');
  assert.deepEqual(readStateJson(file).log,[]);assert.equal(reads,1);
  fs.writeFileSync(file,JSON.stringify({revision:2,log:[]}));assert.equal(readStateJson(file).revision,2);
  assert.equal(reads,2);
  fs.unlinkSync(file);assert.throws(()=>readStateJson(file),/ENOENT/);
 }finally{fs.readFileSync=original;}
});
