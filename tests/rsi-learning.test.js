'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const optimization = require('../routes/rsi-optimization');

test('different scoring concurrency cannot be credited as a recognition latency improvement', () => {
  const base = { all: { performance: { measured: 20, p95_ms: 100, mean_ms: 80, scoring_concurrency: 1 } }, train: { strict_pct: 70 }, heldout: { strict_pct: 70 } };
  const next = JSON.parse(JSON.stringify(base));
  next.all.performance = { measured: 20, p95_ms: 50, mean_ms: 40, scoring_concurrency: 4 };
  assert.equal(optimization.compareProgress(base, next).performanceMeasured, false);
  assert.equal(optimization.compareProgress(base, next).performanceImproved, false);
});

test('parent feedback removes repaired errors and never sends validation cases to search', () => {
  const st = { split: { train: ['repaired', 'new-error'], heldout: ['secret'] }, baseline: { results: [
    { case_id: 'repaired', strict: false }, { case_id: 'new-error', strict: true },
  ] }, branches: { b1: { evaluationResults: [
    { case_id: 'repaired', strict: true }, { case_id: 'new-error', strict: false, query: '新错题' },
    { case_id: 'secret', strict: false, query: '不能泄漏' },
  ] } } };
  assert.deepEqual(optimization.trainingFeedback(st, 'b1').map(r => r.case_id), ['new-error']);
  assert.deepEqual(optimization.trainingFeedback(st, 'b0').map(r => r.case_id), ['repaired']);
});

test('method memory uses training evidence and excludes validation results and raw examples', () => {
  const records = [{ target: 'engine', method: 'parameter_search', hypothesis: '降低线索权重减少误召回',
    mutation: { target: 'engine', parameters: { hintWeight: 0.16 } }, trainGain: 3, validationGain: 5,
    status: 'observed_gain', artifactHash: 'a', reason: '隐藏题含机密题面', independentValidated: false }];
  const memory = optimization.searchMemory(records, 'engine');
  assert.equal(memory[0].trainGain, 3);
  assert.equal(memory[0].validationGain, undefined);
  assert.equal(memory[0].reason, undefined);
  assert.equal(memory[0].independentValidated, false);
  assert.equal(optimization.searchMemory([{ target: 'engine', trainGain: null }])[0].trainingOutcome, 'unmeasured');
});

test('parameter candidates explore decreases at the upper bound and do not repeat rejected assets', () => {
  const graph = { meta: { rsi_runtime: { engine: { hintWeight: 1, clauseWeight: 1 } } }, intent_nodes: [] };
  const trials = optimization.parameterMutations(graph, [], 1);
  assert.ok(trials.some(m => m.parameters.hintWeight < 1));
  assert.ok(trials.every(m => optimization.assetHash(optimization.mutateRuntime(graph, m)) !== optimization.assetHash(graph)));
  const rejected = { target: 'engine', mutation: trials[0], trainGain: -3, artifactHash: optimization.assetHash(optimization.mutateRuntime(graph, trials[0])) };
  assert.ok(!optimization.parameterMutations(graph, [rejected], 1).some(m =>
    optimization.assetHash(optimization.mutateRuntime(graph, m)) === rejected.artifactHash));
});

test('ambiguous failure feedback prioritizes an active clarification mechanism instead of dormant limits', () => {
  const trials = optimization.parameterMutations({ meta: {}, intent_nodes: [] }, [], 1,
    [{ case_id: 'amb', shape: 'ambiguous_intent', resultType: 'clarify_missing_expected' }]);
  assert.equal(trials[0].parameters.graphClusterFirst, true);
});

test('progress accepts weak-shape gains with flat strict totals but refuses tradeoffs as comprehensive gains', () => {
  const score = (strict, ambig, p95) => ({ train: { strict_pct: strict, relaxed_pct: strict },
    heldout: { strict_pct: strict, relaxed_pct: strict, ambiguous_intent: { total: 4, strict_pct: ambig, relaxed_pct: ambig } },
    all: { strict_pct: strict, relaxed_pct: strict, performance: { p95_ms: p95, mean_ms: p95 } } });
  assert.equal(optimization.compareProgress(score(75, 25, 100), score(75, 50, 100)).improved, true);
  const result = optimization.compareProgress(score(75, 25, 100), score(80, 50, 200));
  assert.equal(result.comprehensive, false);
  assert.equal(result.performanceImproved, false);
  assert.equal(optimization.compareProgress(score(75, 25, 100), score(75, 25, 50)).performanceImproved, true);
});

test('latency aggregation reports measured percentiles and leaves unknown call/token counts unknown', () => {
  const result = optimization.performanceSummary([{ latency_ms: 10 }, { latency_ms: 20 }, { latency_ms: 100 }]);
  assert.equal(result.p50_ms, 20);
  assert.equal(result.p95_ms, 100);
  assert.equal(result.measured, 3);
  assert.equal(result.llm_calls, null);
  assert.equal(result.tokens, null);
});

test('revision includes runtime and scoring implementation, not just the main engine file', () => {
  const { engineRevision } = require('../routes/rsi-engine-revision');
  const os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-revision-'));
  try {
    fs.mkdirSync(path.join(root, 'routes')); fs.mkdirSync(path.join(root, 'scripts'));
    for (const file of ['routes/intent-evaluator-v2.js', 'routes/rsi-runtime-profile.js', 'scripts/rsi-engine-score.js', 'routes/rsi-scoring-runtime.js', 'routes/rsi-case-scoring.js']) fs.writeFileSync(path.join(root, file), 'original');
    const first = engineRevision({}, root);
    fs.writeFileSync(path.join(root, 'routes/rsi-runtime-profile.js'), 'changed runtime');
    assert.notEqual(engineRevision({}, root).engineSha, first.engineSha);
    const second = engineRevision({}, root);
    fs.writeFileSync(path.join(root, 'scripts/rsi-engine-score.js'), 'changed scoring');
    assert.notEqual(engineRevision({}, root).engineSha, second.engineSha);
  } finally { fs.rmSync(root, { recursive: true }); }
});

test('internal gateway routing is fingerprinted as online independently of provider keys', () => {
  const { engineRevision } = require('../routes/rsi-engine-revision');
  const rev = engineRevision({ AI_BANK_AGENT_RUNTIME_TOKEN_FILE: '/private/token', INTENT_ENGINE_CONSUME_DECLARATIONS: '1' });
  assert.equal(rev.engineMode, 'online+decl');
  assert.notEqual(rev.engineSha, engineRevision({ INTENT_ENGINE_CONSUME_DECLARATIONS: '1' }).engineSha);
});


// Orchestrator contracts now run against the actual production adapter in rsi-production-runtime.test.js, not extracted obsolete private functions.


test('engine revision reuses unchanged file contents but detects same-size edits and deletion', t => {
 const fs=require('node:fs'), os=require('node:os'),path=require('node:path');
 const {engineRevision}=require('../routes/rsi-engine-revision');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'rsi-rev-cache-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.mkdirSync(path.join(root,'routes'));
 const file=path.join(root,'routes','intent-evaluator-v2.js');fs.writeFileSync(file,'one');
 const read=fs.readFileSync;let reads=0;
 fs.readFileSync=function(target,...args){if(target===file)reads++;return read.call(fs,target,...args);};
 try{
  const first=engineRevision({},root);engineRevision({},root);
  assert.equal(reads,1,'unchanged source must not cross the bind mount on every poll');
  const mtime=fs.statSync(file).mtime;fs.writeFileSync(file,'two');fs.utimesSync(file,mtime,mtime);
  assert.notEqual(engineRevision({},root).engineSha,first.engineSha,'ctime detects edits even with preserved mtime and size');
  fs.unlinkSync(file);assert.notEqual(engineRevision({},root).engineSha,first.engineSha);
 }finally{fs.readFileSync=read;}
});
