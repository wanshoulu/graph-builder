'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createProductionRuntime, gateCandidate, trainingBetter } = require('../routes/rsi-production-runtime');
const TEST_TMP_ROOT = path.join(__dirname, '..', '.tmp-tests');
fs.mkdirSync(TEST_TMP_ROOT, { recursive: true });
const rev = { engineSha: 'fixture', protoRev: 2, engineMode: 'offline-deterministic+decl' };
const scores = n => ({ engineRev: rev, all: { total: 2, strict_pct: n, relaxed_pct: n }, train: { total: 1, strict_pct: n, relaxed_pct: n }, heldout: { total: 1, strict_pct: n, relaxed_pct: n } });
// 门禁校验 after/before 的 train/heldout 题数必须一致：多题 fixture 的 scores 必须按切分自洽构造。
const bucket = rows => ({ total: rows.length,
  strict_pct: rows.length ? +(100 * rows.filter(r => r.strict).length / rows.length).toFixed(2) : 0,
  relaxed_pct: rows.length ? +(100 * rows.reduce((n, r) => n + (r.relaxed || 0), 0) / rows.length).toFixed(2) : 0 });
const splitScores = (results, train, heldout) => ({ engineRev: rev,
  train: bucket(results.filter(r => train.includes(r.case_id))),
  heldout: bucket(results.filter(r => heldout.includes(r.case_id))),
  all: bucket(results) });

function fixture(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(TEST_TMP_ROOT, 'rsi-runtime-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let state = { currentVersion: 'v1', versions: [{ version: 'v1' }], archive: [], log: [], regression: {},
    split: { train: ['t'], heldout: ['h'], test: ['secret'] }, stats: {}, evolveRuns: [], scoreHistory: [] };
  const graph = { meta: {}, intent_nodes: [] };
  const writes = [], parents = [];
  const clone = x => JSON.parse(JSON.stringify(x));
  const runtimeDeps = { root: dir, rsiDir: dir, defaultDecisionMode:'rules', loadState: () => clone(state),
    saveState: s => { state = clone(s); writes.push(clone(s)); }, loadGraph: () => clone(graph),
    saveVersion: (v, g) => fs.writeFileSync(path.join(dir, `${v}.json`), JSON.stringify(g)),
    readCases: () => [{ case_id: 't' }, { case_id: 'h' }, { case_id: 'secret' }],
    revision: () => rev, publicState: s => ({ currentVersion: s.currentVersion, baseline: s.baseline, archive: s.archive, versions: s.versions }),
    scoreGraph: async g => ({ scores: scores(g.meta.level ? 70 + g.meta.level * 5 : 70), results: [{ case_id: 't', strict: true }, { case_id: 'h', strict: true }] }),
    propose: async ({ graph, feedback }) => { parents.push(graph.meta.level || 0); assert.ok(feedback.every(r => state.split.train.includes(r.case_id)));
      return [{ graph: { ...graph, meta: { ...graph.meta, level: (graph.meta.level || 0) + 1 } }, target: 'graph', summary: '修复边界' }]; }, ...extra };
  const runtime = createProductionRuntime(runtimeDeps);
  return { runtime, restart: () => createProductionRuntime(runtimeDeps), state: () => state, set: s => { state = s; }, writes, parents, dir };
}

function adaptiveFixture(t) {
  const dir = fs.mkdtempSync(path.join(TEST_TMP_ROOT, 'rsi-adaptive-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const train = ['t0', 't1', 't2', 't3'], heldout = ['h0', 'h1'];
  let graph = { meta: {}, intent_nodes: [] };
  let state = { currentVersion: 'v1', versions: [{ version: 'v1' }], archive: [], regression: {}, stats: {},
    split: { train, heldout, test: ['secret'] }, evolveRuns: [], scoreHistory: [] };
  const clone = value => JSON.parse(JSON.stringify(value));
  const calls = { baseline: 0, noisy: 0, real: 0 };
  const aggregate = rows => ({ total: rows.length,
    strict_pct: rows.length ? 100 * rows.filter(row => row.strict).length / rows.length : 0,
    relaxed_pct: rows.length ? 100 * rows.filter(row => row.strict).length / rows.length : 0 });
  const runtime = createProductionRuntime({
    root: dir, rsiDir: dir, defaultDecisionMode: 'rules', revision: () => rev,
    loadState: () => clone(state), saveState: next => { state = clone(next); },
    loadGraph: () => clone(graph), saveVersion: (_version, next) => { graph = clone(next); },
    readCases: () => [...train, ...heldout, 'secret'].map(case_id => ({ case_id, intent_shape: 'single_intent' })),
    publicState: value => clone(value),
    propose: async ({ graph: parent }) => [
      { graph: { ...parent, meta: { kind: 'noisy' } }, target: 'graph', summary: 'noisy' },
      { graph: { ...parent, meta: { kind: 'real' } }, target: 'graph', summary: 'real' },
    ],
    scoreGraph: async (candidate, options) => {
      const kind = candidate.meta.kind || 'baseline';
      calls[kind]++;
      const noisyFix = kind === 'noisy' && [1, 2, 4].includes(calls.noisy);
      const results = options.ids.map(case_id => {
        const baselineCorrect = !['t0', 't1'].includes(case_id);
        const strict = kind === 'real' && ['t0', 't1'].includes(case_id)
          ? true
          : case_id === 't0' && noisyFix ? true : baselineCorrect;
        return { case_id, shape: 'single_intent', strict, relaxed: strict ? 1 : 0,
          resultType: strict ? 'ok' : 'wrong_label' };
      });
      const bucket = rows => {
        const value = aggregate(rows);
        return { ...value, single_intent: { ...value } };
      };
      return { results, scores: { engineRev: rev,
        train: bucket(results.filter(row => train.includes(row.case_id))),
        heldout: bucket(results.filter(row => heldout.includes(row.case_id))),
        all: bucket(results) } };
    },
  });
  return { runtime, calls, state: () => state, set: next => { state = clone(next); } };
}

test('baseline defaults to stable three-vote evidence', async t => {
  const f = adaptiveFixture(t);
  const result = await f.runtime.baseline();
  assert.equal(f.calls.baseline, 3);
  assert.equal(result.baseline.measurement.confidence, 'stable');
  assert.equal(result.baseline.measurement.repeatVotes, 3);
});

test('adaptive stable scoring rejects a noisy one-case gain and confirms a real two-case gain', async t => {
  const f = adaptiveFixture(t);
  await f.runtime.baseline();
  await f.runtime.evolve({ maxRounds: 1, strategy: 'manual',
    optimization: { targets: ['graph'], maxMetricCalls: 14 } });
  const noisy = f.state().archive.find(entry => entry.proposal?.motivation === 'noisy');
  const real = f.state().archive.find(entry => entry.proposal?.motivation === 'real');
  assert.equal(noisy.status, 'gated');
  assert.equal(noisy.gate.verdict, 'evidence_insufficient');
  assert.equal(real.measurement.confidence, 'stable');
  assert.equal(real.measurement.repeatVotes, 3);
  assert.equal(real.confirmation.confidence, 'stable');
  assert.equal(real.status, 'passed');
  assert.equal(real.adoptability.ok, true);
});

test('repeated evidence persists compact measurement summaries without raw judge payloads', async t => {
  const f = adaptiveFixture(t);
  await f.runtime.baseline();
  await f.runtime.evolve({ maxRounds: 1, strategy: 'manual',
    optimization: { targets: ['graph'], maxMetricCalls: 14 } });
  const state = f.state();
  const real = state.archive.find(entry => entry.proposal?.motivation === 'real');
  const evidence = { baseline: state.baseline.measurement, measurement: real.measurement, confirmation: real.confirmation };
  assert.deepEqual(Object.keys(evidence.measurement).sort(), ['completedVotes', 'confidence', 'mode', 'repeatVotes']);
  assert.deepEqual(Object.keys(evidence.confirmation).sort(), ['completedVotes', 'confidence', 'mode', 'repeatVotes']);
  assert.doesNotMatch(JSON.stringify(evidence), /rawRuns|rawResponses|responses|results/);
});

test('adoption requires both a stable baseline and confirmed candidate evidence', async t => {
  const withoutStableBaseline = adaptiveFixture(t);
  await withoutStableBaseline.runtime.baseline();
  await withoutStableBaseline.runtime.evolve({ maxRounds: 1, strategy: 'manual',
    optimization: { targets: ['graph'], maxMetricCalls: 14 } });
  const firstState = withoutStableBaseline.state();
  const firstReal = firstState.archive.find(entry => entry.proposal?.motivation === 'real');
  delete firstState.baseline.measurement;
  withoutStableBaseline.set(firstState);
  assert.equal(withoutStableBaseline.runtime.isFresh(firstState), false);
  await assert.rejects(() => withoutStableBaseline.runtime.adopt(firstReal.id), /稳定基线/);

  const withoutConfirmation = adaptiveFixture(t);
  await withoutConfirmation.runtime.baseline();
  await withoutConfirmation.runtime.evolve({ maxRounds: 1, strategy: 'manual',
    optimization: { targets: ['graph'], maxMetricCalls: 14 } });
  const secondState = withoutConfirmation.state();
  const secondReal = secondState.archive.find(entry => entry.proposal?.motivation === 'real');
  delete secondReal.confirmation;
  withoutConfirmation.set(secondState);
  await assert.rejects(() => withoutConfirmation.runtime.adopt(secondReal.id), /独立确认/);
});

test('cold evolution reserves and reports all stable baseline votes', async t => {
  const f = adaptiveFixture(t);
  const run = await f.runtime.evolve({ maxRounds: 1, strategy: 'manual',
    optimization: { targets: ['graph'], maxMetricCalls: 14 } });
  assert.equal(f.calls.baseline, 3);
  assert.equal(run.metricCalls, 11);
  assert.equal(f.state().baseline.measurement.confidence, 'stable');
});

test('manual candidate evaluation uses an independent three-vote confirmation', async t => {
  const f = adaptiveFixture(t);
  await f.runtime.baseline();
  await f.runtime.evolve({ maxRounds: 1, strategy: 'manual',
    optimization: { targets: ['graph'], maxMetricCalls: 14 } });
  const real = f.state().archive.find(entry => entry.proposal?.motivation === 'real');
  const before = f.calls.real;
  const result = await f.runtime.evaluate(real.id);
  assert.equal(f.calls.real - before, 7);
  assert.equal(result.entry.measurement.confidence, 'stable');
  assert.equal(result.entry.confirmation.confidence, 'stable');
  assert.equal(result.entry.confirmationGate.passed, true);
});

test('placeholder runtime instructions are rejected before expensive candidate scoring', async t => {
  let evaluations = 0;
  const f = fixture(t, { propose: undefined, extractJsonArray: JSON.parse,
    callLLM: async () => JSON.stringify([{ component: 'judge', text: '完整识别指令', motivation: '改动假设' }]),
    scoreGraph: async () => { evaluations++; return { scores: scores(70), results: [{case_id:'t',strict:false},{case_id:'h',strict:true}] }; },
  });
  const run = await f.runtime.evolve({ maxRounds: 1, optimization: { targets: ['recognition_prompt','optimizer_prompt'] } });
  assert.equal(evaluations, 3, 'only the stable baseline votes may be measured');
  assert.equal(run.rounds[0].proposed, 0);
  assert.equal(run.rounds[0].mutationErrors.length, 2);
  assert.match(run.rounds[0].mutationErrors[0].reason, /占位|有效指令/);
});

test('current failures of historical protection get first training feedback without exposing heldout', async t => {
  let feedback;
  const train = Array.from({length:18},(_,i)=>'t'+i);
  const f = fixture(t, { readCases:()=>[...train,'h','secret'].map(case_id=>({case_id})),
    scoreGraph:async()=>({scores:scores(70),results:[...train,'h'].map(case_id=>({case_id,strict:false,resultType:'clarify_extra_options'}))}),
    propose:async input=>{feedback=input.feedback;return[];},
  });
  f.set({...f.state(),split:{train,heldout:['h'],test:['secret']},regression:{t17:{fixedIn:'old'},h:{fixedIn:'old'}}});
  await f.runtime.evolve({maxRounds:1});
  assert.equal(feedback[0].case_id,'t17');
  assert.equal(feedback.length,16);
  assert.ok(feedback.every(r=>train.includes(r.case_id)));
  assert.equal(feedback[0].repairPriority,'historical_protection_failed');
});

test('preflight reports historical protection already failing the current baseline without deleting it', async t => {
  const f=fixture(t,{scoreGraph:async()=>({scores:scores(70),results:[{case_id:'t',strict:false},{case_id:'h',strict:true}]})});
  f.set({...f.state(),regression:{t:{fixedIn:'old'}}});
  await f.runtime.baseline();
  const report=f.runtime.preflight();
  assert.ok(report.warnings.some(w=>/历史.*保护/.test(w)&&w.includes('t')));
  assert.deepEqual(f.state().regression,{t:{fixedIn:'old'}});
});

test('degraded model or recall calls invalidate a comparison instead of becoming accuracy evidence',async t=>{
 const f=fixture(t,{scoreGraph:async()=>({scores:scores(70),results:[{case_id:'t',strict:false,evidence:{decision:{mode:'degraded_fusion'},routes:{vector:{status:'error'}}}},{case_id:'h',strict:true}]})});
 await assert.rejects(()=>f.runtime.baseline(),/通道.*失败|降级/);
 assert.equal(f.state().baseline,undefined);
});

test('invalid graph proposals keep the actual validation reason for the next search round', async t => {
  const f=fixture(t,{propose:undefined,extractJsonArray:JSON.parse,
    callLLM:async()=>JSON.stringify([{type:'A1_utterance_expand',target:'missing',evidence_cases:['t'],add_utterances:['查余额']}]),
    validateProposal:()=> '目标意图不存在',
    scoreGraph:async()=>({scores:scores(70),results:[{case_id:'t',strict:false},{case_id:'h',strict:true}]}),
  });
  const run=await f.runtime.evolve({maxRounds:1});
  assert.ok(run.rounds[0].mutationErrors.some(e=>e.reason==='目标意图不存在'));
});

test('graph mutation request includes concrete required operator fields', async t => {
  let request;
  const f=fixture(t,{propose:undefined,extractJsonArray:JSON.parse,
    callLLM:async messages=>{request=JSON.parse(messages[1].content);return '[]';},
    scoreGraph:async()=>({scores:scores(70),results:[{case_id:'t',strict:false},{case_id:'h',strict:true}]}),
  });
  await f.runtime.evolve({maxRounds:1});
  assert.deepEqual(request.graphProposalFields.A6_ambiguity_cluster_expand, {targets:'2至6个现有意图ID的数组',add_utterances:'这些意图共享的完整模糊表达字符串数组'});
  assert.ok(request.graphProposalFields.A2_disambiguation.add_scope_out);
});

test('mutation prompts use measured training observations and omit the hard-coded bank failure example',async t=>{
 let prompt;
 const f=fixture(t,{propose:undefined,extractJsonArray:JSON.parse,
  callLLM:async messages=>{prompt=JSON.parse(messages[1].content);return '[]';},
  scoreGraph:async()=>({scores:scores(70),results:[{case_id:'t',query:'本任务业务',shape:'ambiguous_intent',expected:['one','two'],strict:false,resultType:'clarify_extra_options',engine_candidates:['one','two','extra'],engine_clarifying:true,evidence:{routes:{lexical:{status:'completed',rows:[{intent_id:'one'},{intent_id:'two'}]}}}},{case_id:'h',strict:true}]}),
 });
 await f.runtime.evolve({maxRounds:1,optimization:{targets:['graph'],decisionMode:'rules'}});
 assert.doesNotMatch(prompt.instruction,/rsi_t211|查单子|必须用 A6/);
 assert.deepEqual(prompt.feedback[0].observations.recall.expectedSeen,['one','two']);
 assert.deepEqual(prompt.feedback[0].observations.clarification.extraOptionIds,['extra']);
 assert.ok(prompt.graphOperators.A6_ambiguity_cluster_expand);
});

test('an authorized A6 experiment is never silently rewritten into a different bundled experiment',async t=>{
 let applied;
 const proposal={type:'A6_ambiguity_cluster_expand',targets:['one','two'],evidence_cases:['t'],add_utterances:['模糊业务'],motivation:'检验共同说法声明的澄清作用'};
 const f=fixture(t,{propose:undefined,extractJsonArray:JSON.parse,validateProposal:()=>null,
  callLLM:async()=>JSON.stringify([proposal]),applyProposal:(g,p)=>{applied=p;return {graph:{...g,meta:{...g.meta,changed:true}}};},
  scoreGraph:async()=>({scores:scores(70),results:[{case_id:'t',query:'模糊业务',shape:'ambiguous_intent',expected:['one','two'],strict:false,resultType:'clarify_extra_options',engine_candidates:['one','two','extra'],predicted:{clarifying:true,candidates:['one','two','extra']}},{case_id:'h',strict:true}]}),
 });
 await f.runtime.evolve({maxRounds:1,ops:['A6_ambiguity_cluster_expand'],optimization:{targets:['graph'],decisionMode:'rules'}});
 assert.equal(applied.type,'A6_ambiguity_cluster_expand');assert.deepEqual(applied.targets,['one','two']);
});

test('public run status preserves saved stop/error states and only recovers an orphan running record',t=>{
 const f=fixture(t);
 for(const status of ['stopped','error','interrupted']){
  f.set({...f.state(),activeEvolution:{id:'old',status}});
  assert.equal(f.runtime.state().activeEvolution.status,status);
 }
 f.set({...f.state(),activeEvolution:{id:'old',status:'running'}});
 assert.equal(f.runtime.state().activeEvolution.status,'interrupted');
});

test('three actual generations inherit only the selected parent, preserve candidates and do not auto-adopt', async t => {
  const train8 = Array.from({ length: 8 }, (_, i) => 't' + i);
  const f = fixture(t, {
    readCases: () => [...train8, 'h', 'x'].map(case_id => ({ case_id })),
    scoreGraph: async g => {
      const results = [...train8.map((case_id, i) => ({ case_id, strict: i < 2 * (g.meta.level || 0) })), { case_id: 'h', strict: true }];
      return { scores: splitScores(results, train8, ['h']), results };
    },
  });
  f.set({ ...f.state(), split: { train: train8, heldout: ['h'], test: ['x'] } });
  await f.runtime.evolve({ maxRounds: 3, strategy: 'manual', optimization: { targets: ['graph'], allowMerge: false } });
  const s = f.state(), run = s.evolveRuns.at(-1);
  assert.deepEqual(f.parents, [0, 1, 2]);
  assert.deepEqual(run.rounds.map(r => r.outputScores.train.strict_pct), [25, 50, 75]);
  assert.equal(run.rounds[1].inputBranch, run.rounds[0].champion);
  assert.equal(s.currentVersion, 'v1');
  assert.equal(run.status, 'awaiting_human');
  assert.equal(run.totalAdopted, 0);
  assert.ok(f.writes.some(s => s.activeEvolution?.rounds?.[0]?.candidates?.length));
  const champ = s.archive.find(e => e.branchId === run.champion);
  await f.runtime.adopt(champ.id);
  const promoted = JSON.parse(fs.readFileSync(path.join(f.dir, 'v2.json')));
  assert.equal(promoted.meta.level, 3);
  const archived = f.state().evolveRuns.at(-1);
  assert.equal(archived.finalVersion, 'v2');
  assert.equal(archived.totalAdopted, 1);
  assert.equal(archived.branches[archived.champion].adoptedAs, 'v2');
  assert.equal(archived.rounds[2].adopted, 1);
  assert.deepEqual(archived.rounds[2].adoptedVersions, ['v2']);
});

test('run snapshots persist actual population, input parents and mutation details', async t => {
  const f = fixture(t);
  const run = await f.runtime.evolve({ maxRounds: 2 });
  assert.deepEqual(run.rounds[0].inputBranches, ['b0']);
  assert.ok(run.population.includes(run.champion));
  assert.deepEqual(run.branches.b1.parents, ['b0']);
  assert.equal(run.branches.b1.proposalId, f.state().archive.find(e => e.branchId === 'b1').id);
});

test('failure in graph mutation leaves the engine path runnable and records the failure', async t => {
  const f = fixture(t, { propose: undefined, callLLM: async () => { throw new Error('model unavailable'); } });
  const run = await f.runtime.evolve({ maxRounds: 1, optimization: { targets: ['graph', 'engine'], maxMetricCalls: 3 } });
  assert.ok(run.rounds[0].branchIds.length > 0);
  assert.ok(run.rounds[0].mutationErrors.some(e => e.target === 'graph'));
  assert.ok(Object.values(run.branches).some(b => b.target === 'engine'));
});

test('promotion refuses passed evidence from another parent or evaluator', async t => {
  const f = fixture(t, {
    readCases: () => ['t', 't2', 'h', 'x'].map(case_id => ({ case_id })),
    scoreGraph: async g => {
      const results = [{ case_id: 't', strict: !!g.meta.level }, { case_id: 't2', strict: !!g.meta.level }, { case_id: 'h', strict: true }];
      return { scores: splitScores(results, ['t', 't2'], ['h']), results };
    },
  });
  f.set({ ...f.state(), split: { train: ['t', 't2'], heldout: ['h'], test: ['x'] } });
  await f.runtime.evolve({ maxRounds: 1, strategy: 'manual', optimization: { targets: ['graph'] } });
  const s = f.state(), id = s.archive[0].id;
  s.currentVersion = 'v9'; f.set(s);
  await assert.rejects(f.runtime.adopt(id), /父版本|父资产/);
  assert.equal(f.state().versions.length, 1);
});

test('unknown revisions are never comparable and heldout-only gains do not define a winner', () => {
  assert.equal(gateCandidate(scores(70), { ...scores(80), engineRev: null }, [], {}).passed, false);
  const after = scores(70); after.heldout.strict_pct = 100;
  assert.equal(trainingBetter(scores(70), after), false);
});

test('state preserves raw history and real runs, and labels old baseline stale without modifying it', t => {
  const f = fixture(t); const s = f.state();
  s.evolveRuns = [{ id: 'old', rounds: [] }];
  s.scoreHistory = [{ version: 'v1', at: 'a', scores: scores(70) }, { version: 'v1', at: 'b', scores: scores(75) }];
  s.baseline = { version: 'v1', scores: { ...scores(70), engineRev: null } }; f.set(s);
  const view = f.runtime.state();
  assert.equal(view.evolveRuns.length, 1);
  assert.equal(view.scoreHistory.length, 2);
  assert.equal(view.baseline.stale, true);
  assert.equal(f.state().baseline.stale, undefined);
});

test('legacy writes hold the same lock as evolution and release it exactly once', async t => {
  const f = fixture(t), release = f.runtime.acquireLegacy();
  await assert.rejects(f.runtime.evolve(), /任务运行中/);
  assert.throws(() => f.runtime.acquireLegacy(), /并发/);
  assert.equal(f.state().evolveRuns.length, 0);
  release(); release();
  await f.runtime.evolve({ maxRounds: 1 });
  assert.equal(f.state().evolveRuns.length, 1);
});

test('neutral optimizer update is search-only, not a failed automatic promotion', async t => {
  let evaluations = 0;
  const f = fixture(t, {
    scoreGraph: async () => { evaluations++; return { scores: scores(70), results: [{ case_id: 't', strict: true }, { case_id: 'h', strict: true }] }; },
    propose: async ({ graph }) => [{ graph: { ...graph, meta: { level: 1 } }, target: 'optimizer_prompt', summary: '新的搜索假设' }],
  });
  const run = await f.runtime.evolve({ maxRounds: 1, strategy: 'best', optimization: { targets: ['optimizer_prompt'] } });
  assert.equal(run.rounds[0].result, 'search_updated');
  // 搜索指令变更不产生可采纳候选：冠军仍是基线，状态是 no_adopt（不是 awaiting_human）。
  assert.equal(run.status, 'no_adopt');
  assert.equal(run.totalAdopted, 0);
  assert.equal(f.state().currentVersion, 'v1');
  // 优化器提示词不进入识别评测：只测了基线的 3 票稳定证据（审计：旧实现会白烧候选完整评测）。
  assert.equal(evaluations, 3);
  assert.equal(run.metricCalls, 3);
});

test('artifact tampering is refused before promotion', async t => {
  const f = fixture(t, {
    readCases: () => ['t', 't2', 'h', 'x'].map(case_id => ({ case_id })),
    scoreGraph: async g => {
      const results = [{ case_id: 't', strict: !!g.meta.level }, { case_id: 't2', strict: !!g.meta.level }, { case_id: 'h', strict: true }];
      return { scores: splitScores(results, ['t', 't2'], ['h']), results };
    },
  });
  f.set({ ...f.state(), split: { train: ['t', 't2'], heldout: ['h'], test: ['x'] } });
  await f.runtime.evolve({ maxRounds: 1 });
  const entry = f.state().archive[0], file = path.join(f.dir, 'artifacts', entry.candidateHash + '.json');
  const bundle = JSON.parse(fs.readFileSync(file)); bundle.graph.meta.level = 999;
  fs.writeFileSync(file, JSON.stringify(bundle));
  await assert.rejects(f.runtime.adopt(entry.id), /指纹|hash|资产/);
  bundle.hash = require('../routes/rsi-optimization').assetHash(bundle.graph);
  fs.writeFileSync(file, JSON.stringify(bundle));
  await assert.rejects(f.runtime.adopt(entry.id), /指纹|资产/);
  assert.equal(f.state().currentVersion, 'v1');
});

test('regression cases, engine errors and per-shape regressions veto improvement', () => {
  assert.equal(gateCandidate(scores(70), scores(80), [{ case_id: 't', strict: false }], { t: {} }).passed, false);
  assert.equal(gateCandidate(scores(70), scores(80), [{ resultType: 'engine_error' }], {}).passed, false);
  const before = scores(70), after = scores(80);
  before.train.multi_intent = { total: 1, strict_pct: 80, relaxed_pct: 90 };
  after.train.multi_intent = { total: 1, strict_pct: 75, relaxed_pct: 90 };
  assert.equal(trainingBetter(before, after), false);
  assert.equal(gateCandidate(before, after, [], {}).passed, false);
  delete after.train.multi_intent.strict_pct;
  assert.equal(gateCandidate(before, after, [], {}).passed, false);
});

test('neutral search from a weaker Pareto parent cannot replace the stronger champion', async t => {
  const train20 = Array.from({ length: 20 }, (_, i) => 't' + i);
  const f = fixture(t, {
    readCases: () => [...train20, 'h', 'x'].map(case_id => ({ case_id })),
    scoreGraph: async g => {
      // b 通过门禁（净修 15 题）进入 Pareto 保留池：strict 75% 劣于 a（16/20=80%），
      // relaxed 85% 优于 a（80%）——互不支配，共同保留；行级 strict/relaxed 必须与断言一致。
      const fixed = g.meta.kind === 'a' ? 16 : g.meta.kind === 'b' ? 15 : 0;
      const relaxed = g.meta.kind === 'b' ? 17 : fixed;
      const results = [...train20.map((case_id, i) => ({ case_id, strict: i < fixed, relaxed: i < relaxed ? 1 : 0 })),
        { case_id: 'h', strict: true, relaxed: 1 }];
      return { scores: splitScores(results, train20, ['h']), results };
    },
    propose: async ({ graph, gen }) => gen === 1
      ? ['a', 'b'].map(kind => ({ graph: { ...graph, meta: { kind } }, target: 'engine', summary: kind }))
      : graph.meta.kind === 'b' ? [{ graph: { ...graph, meta: { kind: 'b-next' } }, target: 'optimizer_prompt', summary: '弱父代搜索' }] : [],
  });
  f.set({ ...f.state(), split: { train: train20, heldout: ['h'], test: ['x'] } });
  const run = await f.runtime.evolve({ maxRounds: 2, optimization: { targets: ['engine'], parentPolicy: 'pareto_population' } });
  assert.equal(run.rounds[0].outputScores.train.strict_pct, 80);
  assert.equal(run.rounds[1].outputScores.train.strict_pct, 80);
  assert.equal(run.rounds[1].champion, run.rounds[0].champion);
});

test('graph generator supplies training evidence schema and real validator accepts its proposal', async t => {
  let prompt = '';
  const { validateProposal } = require('../routes/intent-rsi').__test;
  const f = fixture(t, {
    propose: undefined,
    loadGraph: () => ({ meta: {}, intent_nodes: [{ identity: { intent_id: 'i1' }, retrieval_profile: { utterance_view: [] } }] }),
    readCases: () => [{ case_id: 't', query: '查询账户余额', intent_shape: 'single_intent' }, { case_id: 'h' }, { case_id: 'secret' }],
    scoreGraph: async g => ({ scores: scores(g.meta.level ? 80 : 70), results: [{ case_id: 't', strict: false }, { case_id: 'h', strict: true }] }),
    callLLM: async messages => { prompt = messages[1].content; return JSON.stringify([{ type: 'A1_utterance_expand', target: 'i1', motivation: '修复余额查询', evidence_cases: ['t'], add_utterances: ['查询账户余额'] }]); },
    extractJsonArray: JSON.parse, validateProposal,
    applyProposal: g => ({ graph: { ...g, meta: { level: 1 } } }),
  });
  const run = await f.runtime.evolve({ maxRounds: 1 });
  assert.match(prompt, /evidence_cases/);
  assert.equal(JSON.parse(prompt).feedback[0].case_id, 't');
  assert.equal(run.rounds[0].evaluated, 1);
});

test('evaluator changes invalidate all evidence even after only engineCheck is refreshed', async t => {
  let current = rev;
  const f = fixture(t, { revision: () => current,
    readCases: () => ['t', 't2', 'h', 'x'].map(case_id => ({ case_id })),
    scoreGraph: async g => {
      const results = [{ case_id: 't', strict: !!g.meta.level }, { case_id: 't2', strict: !!g.meta.level }, { case_id: 'h', strict: true }];
      return { scores: splitScores(results, ['t', 't2'], ['h']), results };
    } });
  f.set({ ...f.state(), split: { train: ['t', 't2'], heldout: ['h'], test: ['x'] } });
  await f.runtime.evolve({ maxRounds: 1 });
  const s = f.state(), e = s.archive[0];
  current = { ...rev, engineSha: 'changed' };
  e.engineCheck.engineRev = current; f.set(s);
  await assert.rejects(f.runtime.adopt(e.id), /评测器|过期|口径/);
  assert.equal(f.state().currentVersion, 'v1');
});

test('a subsequent run clears a previous stop request', async t => {
  const f = fixture(t);
  f.runtime.stop();
  const run = await f.runtime.evolve({ maxRounds: 1 });
  assert.equal(run.rounds.length, 1);
  assert.equal(run.rounds[0].evaluated, 1);
});

test('parent-local repaired feedback disappears before the next generation', async t => {
  const observed = [];
  const f = fixture(t, {
    readCases: () => ['t', 't2', 'h', 'x'].map(case_id => ({ case_id })),
    scoreGraph: async g => {
      const results = [{ case_id: 't', strict: !!g.meta.level }, { case_id: 't2', strict: !!g.meta.level }, { case_id: 'h', strict: false }];
      return { scores: splitScores(results, ['t', 't2'], ['h']), results };
    },
    propose: async ({ graph, feedback }) => { observed.push(feedback.map(r => r.case_id));
      return [{ graph: { ...graph, meta: { level: (graph.meta.level || 0) + 1 } }, target: 'engine' }]; },
  });
  f.set({ ...f.state(), split: { train: ['t', 't2'], heldout: ['h'], test: ['x'] } });
  await f.runtime.evolve({ maxRounds: 2 });
  assert.deepEqual(observed, [['t', 't2'], []]);
});

test('flat total accuracy is not a promotion even when one shape improves', () => {
  // 旧门禁的 20 维单调约束在这里把「修 1 题、破 1 题」当成提升；
  // 新判定要求主指标净增（或配对显著），题型内互换不算进步。
  const before = scores(70), after = scores(70);
  before.train.ambiguous_intent = { total: 4, strict_pct: 25, relaxed_pct: 25 };
  after.train.ambiguous_intent = { total: 4, strict_pct: 50, relaxed_pct: 50 };
  after.train.single_intent = { total: 4, strict_pct: 50, relaxed_pct: 50 };
  before.train.single_intent = { total: 4, strict_pct: 75, relaxed_pct: 75 };
  assert.equal(trainingBetter(before, after), false);
  // 有净增时，题型内的合理波动（≤2 题）不阻断。
  const up = scores(75);
  up.train.ambiguous_intent = { total: 4, strict_pct: 50, relaxed_pct: 50 };
  up.train.single_intent = { total: 4, strict_pct: 75, relaxed_pct: 75 };
  assert.equal(trainingBetter(before, up), true);
});

test('scoring exceptions never create a measured output and metric budget bounds work', async t => {
  let calls = 0;
  const f = fixture(t, { scoreGraph: async () => {
    if (++calls > 1) throw new Error('评测缺题');
    return { scores: scores(70), results: [{ case_id: 't', strict: true }, { case_id: 'h', strict: true }] };
  } });
  const run = await f.runtime.evolve({ maxRounds: 3, optimization: { targets: ['graph'], maxMetricCalls: 2 } });
  assert.equal(calls, 2);
  assert.equal(run.rounds[0].outputScores, null);
  assert.equal(run.rounds[0].candidates[0].status, 'eval_error');
  assert.equal(f.state().archive.length, 0);
});

test('task-specific state includes stable identity and one shared score validity contract', async t => {
  const f = fixture(t);
  f.set({ ...f.state(), taskId: 'task-a', taskName: '澄清专项', revision: 7 });
  await f.runtime.baseline();
  const snapshot = { ...f.state(), taskId: 'task-a', taskName: '澄清专项', revision: 7 };
  const view = f.runtime.state(snapshot);
  assert.equal(view.taskId, 'task-a');
  assert.equal(view.taskName, '澄清专项');
  assert.equal(view.revision, 7);
  assert.equal(view.scoreValidity.current, true);
  assert.equal(view.scoreValidity.split, 'all');
  assert.equal(view.scoreValidity.n, 2);
});

test('GET auto-evolve cannot start paid work', async t => {
  let output;
  const f = fixture(t, { sendJson: (_res, code, value) => { output = { code, value }; } });
  await f.runtime.handle({ pathname: '/api/intent-rsi/auto-evolve', method: 'GET', url: '/api/intent-rsi/auto-evolve' }, {});
  assert.equal(output.code, 405);
  assert.equal(f.state().evolveRuns.length, 0);
});

test('repeated evolution command returns its persisted run without evaluating again', async t => {
  const f = fixture(t);
  const opts = { maxRounds: 1, commandId: 'one-start-command' };
  const first = await f.runtime.evolve(opts);
  const count = f.parents.length;
  const second = await f.runtime.evolve(opts);
  assert.equal(second.id, first.id);
  assert.equal(f.parents.length, count);
  assert.equal(f.state().evolveRuns.length, 1);
});

test('stopped run resumes from persisted generations after runtime recreation', async t => {
  const train8 = Array.from({ length: 8 }, (_, i) => 't' + i);
  const f = fixture(t, {
    readCases: () => [...train8, 'h', 'x'].map(case_id => ({ case_id })),
    scoreGraph: async g => {
      const results = [...train8.map((case_id, i) => ({ case_id, strict: i < 2 * (g.meta.level || 0) })), { case_id: 'h', strict: true }];
      return { scores: splitScores(results, train8, ['h']), results };
    },
  });
  f.set({ ...f.state(), split: { train: train8, heldout: ['h'], test: ['x'] } });
  const first = await f.runtime.evolve({ maxRounds: 3 }, e => { if (e.step === 'gen_done') f.runtime.stop(); });
  assert.equal(first.status, 'stopped');
  assert.equal(first.rounds.length, 1);
  assert.equal(first.checkpoint.available, true);
  const restarted = f.restart();
  const resumed = await restarted.resume(first.id);
  assert.equal(resumed.id, first.id);
  assert.equal(resumed.rounds.length, 3);
  assert.deepEqual(f.parents, [0, 1, 2]);
  assert.equal(f.state().evolveRuns.length, 1);
  assert.equal(resumed.resumeCount, 1);
});

test('resume refuses changed task protocol instead of mixing old and new evidence', async t => {
  const f = fixture(t);
  const run = await f.runtime.evolve({ maxRounds: 3 }, e => { if (e.step === 'gen_done') f.runtime.stop(); });
  const s = f.state(); s.split.train = ['secret']; f.set(s);
  await assert.rejects(f.restart().resume(run.id), /上下文|协议|过期|切分/);
});

test('stop aborts the active scorer and always persists a recoverable terminal state', async t => {
  let started, observedSignal;
  const entered = new Promise(resolve => { started = resolve; });
  const f = fixture(t, { scoreGraph: async (g, options) => {
    if (!g.meta.level) return { scores: scores(70), results: [{ case_id: 't', strict: true }, { case_id: 'h', strict: true }] };
    observedSignal = options.signal; started();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('test abort signal missing')), 1000);
      options.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('已停止')); }, { once: true });
    });
  } });
  const work = f.runtime.evolve({ maxRounds: 3 });
  await entered; f.runtime.stop();
  const run = await work;
  assert.equal(observedSignal.aborted, true);
  assert.equal(run.status, 'stopped');
  assert.equal(f.runtime.state().evolveRunning, false);
});

test('preflight explains incomplete data and prevents unsupported optimization setup', t => {
  const f = fixture(t), s = f.state(); s.split.heldout = []; f.set(s);
  const result = f.runtime.preflight();
  assert.equal(result.ready, false);
  assert.ok(result.blockers.some(x => /验证|heldout/.test(x)));
  assert.equal(result.summary.budgetUnits.metricCalls, '完整评测调用，不是模型调用或题数');
  assert.equal(f.runtime.capabilities().features.memberOptimizer, false);
});

test('candidate comparison reports complete asset diff and per-case changes', async t => {
  const f = fixture(t, { scoreGraph: async g => ({ scores: scores(g.meta.level ? 80 : 70), results: [{case_id:'t',strict:!!g.meta.level,query:'查余额',shape:'single_intent'},{case_id:'h',strict:true}] }) });
  await f.runtime.evolve({maxRounds:1});
  const entry = f.state().archive[0];
  const diff = f.runtime.candidateDiff(entry.id);
  assert.ok(diff.changes.some(x => x.path === 'meta.level' && x.after === 1));
  assert.equal(diff.caseChanges.find(x => x.case_id === 't').change, 'improved');
  assert.equal(diff.valid, true);
});

test('independent final exam is bound to full asset and context and is reused for identical inputs', async t => {
  let testCalls = 0;
  const f = fixture(t, { scoreGraph: async (_g, opts) => {
    if(opts.test) testCalls++;
    return {scores:scores(70),results:opts.ids.map(case_id=>({case_id,strict:true}))};
  } });
  await f.runtime.baseline();
  const first = await f.runtime.finalExam();
  const second = await f.runtime.finalExam();
  assert.equal(testCalls, 1);
  assert.equal(second.finalExam.runCount, 1);
  assert.equal(first.finalExam.assetHash, f.state().baseline.assetHash);
  assert.ok(first.finalExam.context.casesSha256);
  assert.equal(first.finalExam.testCount, 1);
  const exported = f.runtime.exportBundle().bundle;
  assert.equal(exported.assetHash, first.finalExam.assetHash);
  assert.equal(exported.manifest.independentTestMeasured, true);
  assert.equal(exported.manifest.productionPublished, false);
});

test('unmeasured tasks can export a complete backup without claiming validated improvement',t=>{
 const f=fixture(t),bundle=f.runtime.exportBundle().bundle;
 assert.equal(bundle.manifest.currentScoreValid,false);
 assert.equal(bundle.manifest.independentTestMeasured,false);
 assert.deepEqual(bundle.dataset.split.train,['t']);
 assert.equal(bundle.snapshot.currentVersion,'v1');
 assert.equal(bundle.dataset.cases.length,3);
});


test('state conditional GET accepts nginx weak validators and skips repeated projection', async t => {
  let projections=0, output;
  const f=fixture(t,{publicState:s=>{projections++;return {archive:s.archive,versions:s.versions};},sendJson:(_r,code,value)=>{output={code,value};}});
  f.set({...f.state(),revision:1});
  let etag,code;
  const res={setHeader:(key,value)=>{if(key==='ETag')etag=value;},writeHead:c=>{code=c;},end:()=>{}};
  const req={pathname:'/api/intent-rsi/state',method:'GET',url:'/api/intent-rsi/state',headers:{}};
  await f.runtime.handle(req,res);
  await f.runtime.handle({...req,headers:{'if-none-match':`W/${etag}`}},res);
  assert.equal(code,304);
  assert.equal(projections,1);
  assert.equal(output.code,200);
});

test('state summary preserves experiment outcomes and lazy trace recovers full training input', async t => {
 let output;
 const f=fixture(t,{sendJson:(_r,code,value)=>{output={code,value};}});
 const reasoning={status:'complete',input:{parents:[{cases:[{case_id:'t',evidence:{trace:'large'}}],graph:{nodes:['large']}}]},plan:{summary:'diagnosis'},trials:[{status:'measured',probe:{count:1,changes:[],results:[{case_id:'t'}]}}]};
 const run={id:'run_perf',at:'2026-10-27',rounds:[{gen:1,reasoning,candidates:[{id:'b1',trainingFeedback:[{case_id:'t'}]}]}],branches:{b1:{id:'b1',trainingFeedback:[{case_id:'t'}],probe:{count:1,reason:'keep',changes:[],results:[{case_id:'t'}]}}}};
 f.set({...f.state(),revision:1,evolveRuns:[run]});
 await f.runtime.handle({pathname:'/api/intent-rsi/state',method:'GET',url:'/api/intent-rsi/state?view=summary',headers:{}},{setHeader:()=>{}});
 const projected=output.value.state.evolveRuns[0];
 assert.equal(projected.rounds[0].reasoning.input,undefined);
 assert.equal(projected.rounds[0].reasoning.traceDetailAvailable,true);
 assert.deepEqual(projected.rounds[0].reasoning.plan,reasoning.plan);
 assert.equal(projected.branches.b1.trainingFeedback,undefined);
 assert.equal(projected.branches.b1.probe.results,undefined);
 assert.equal(projected.branches.b1.probe.count,1);
 await f.runtime.handle({pathname:'/api/intent-rsi/run-trace',method:'GET',url:'/api/intent-rsi/run-trace?runId=run_perf&gen=1',headers:{}},{});
 assert.deepEqual(output.value.reasoning.input,reasoning.input);
 assert.deepEqual(f.state().evolveRuns[0],run,'read projection never mutates stored evidence');
});


test('asset lineage reads only referenced bundles and never blocks on synchronous artifact IO', async t => {
 let output;
 const f=fixture(t,{sendJson:(_r,code,value)=>{output={code,value};}});
 await f.runtime.baseline();
 f.set({...f.state(),versions:[{version:'v1',assetHash:f.state().baseline.assetHash}]});
 const unrelated=path.join(f.dir,'artifacts','f'.repeat(64)+'.json');
 fs.writeFileSync(unrelated,JSON.stringify({unrelated:true}));
 const original=fs.readFileSync;let syncArtifactReads=0;
 fs.readFileSync=function(file,...args){if(String(file).includes(path.join(f.dir,'artifacts')))syncArtifactReads++;return original.call(fs,file,...args);};
 try{await f.runtime.handle({pathname:'/api/intent-rsi/asset-lineage',method:'GET',url:'/api/intent-rsi/asset-lineage'},{});}
 finally{fs.readFileSync=original;}
 assert.equal(syncArtifactReads,0);
 assert.equal(output.code,200);
 assert.equal(output.value.assets.length,1);
 assert.equal(output.value.assets[0].hash,f.state().versions[0].assetHash);
});
