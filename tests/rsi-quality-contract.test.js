'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const scoring = require('../routes/rsi-case-scoring');
const learning = require('../routes/rsi-learning');
const taskResult = tasks => ({ understanding: { tasks, clarification: { needed: false } } });

test('legacy multi-set detects extra separately and preserves clause trace/topk/span', () => {
  const res = { segment_results: [
    { segment_index: 1, query: '查余额', span: { start: 0, end: 3, text: '查余额' }, final_result: { intent_id: 'balance' }, methods: { local: { top: [{ intent_id: 'balance' }, { intent_id: 'bill' }] }, llm_judge: { decision_trace: { steps: [] } } } },
    { segment_index: 2, query: '转账', final_result: { intent_id: 'transfer' } },
  ] };
  const row = scoring.scoreIntentCase({ query: '查余额和转账', intent_shape: 'multi_intent', expected_intents: ['balance'] }, res);
  assert.equal(row.resultType, 'multi_extra');
  assert.deepEqual(row.diagnosis.extra, ['transfer']);
  assert.deepEqual(row.engine_segments[0].topk, ['balance', 'bill']);
  assert.equal(row.engine_segments[0].span.start, 0);
  assert.deepEqual(row.engine_segments[0].trace, { steps: [] });
});

test('task gold distinguishes repeated intents, slots, order, dependencies and wrong labels', () => {
  const gold = { intent_shape: 'multi_intent', expected_tasks: [
    { task_id: 'a', intent_id: 'transfer', task_index: 1, slots: { payee: '甲', amount: 100 } },
    { task_id: 'b', intent_id: 'transfer', task_index: 2, slots: { payee: '乙', amount: 200 }, depends_on: ['a'] },
  ] };
  const tasks = [
    { task_id: 'x', intent_id: 'transfer', task_index: 1, payee: '甲', amount: 100 },
    { task_id: 'y', intent_id: 'transfer', task_index: 2, slots: { payee: '乙', amount: 200 }, depends_on: ['x'] },
  ];
  assert.equal(scoring.scoreIntentCase(gold, taskResult(tasks)).strict, true);
  assert.equal(scoring.scoreIntentCase(gold, taskResult(tasks.slice(0, 1))).resultType, 'multi_missing');
  const bad = JSON.parse(JSON.stringify(tasks)); bad[1].slots.payee = '甲';
  const wrong = scoring.scoreIntentCase(gold, taskResult(bad));
  assert.equal(wrong.resultType, 'multi_wrong');
  assert.equal(wrong.diagnosis.wrong[0].fields.includes('slots.payee'), true);
  const deps = JSON.parse(JSON.stringify(tasks)); deps[1].depends_on = [];
  assert.equal(scoring.scoreIntentCase(gold, taskResult(deps)).strict, false);
  const reversed = JSON.parse(JSON.stringify(tasks)); reversed[1].task_index = 1;
  assert.equal(scoring.scoreIntentCase(gold, taskResult(reversed)).strict, false);
  assert.equal(scoring.scoreIntentCase({ intent_shape: 'multi_intent', expected_intents: ['transfer'] }, taskResult(tasks)).strict, true);
});

test('task dependency matching accepts equivalent duplicate-intent graphs without relying on incidental IDs', () => {
  const gold = { intent_shape: 'multi_intent', expected_tasks: [
    { task_id: 'first', intent_id: 'transfer', depends_on: [] },
    { task_id: 'next', intent_id: 'transfer', depends_on: ['first'] },
  ] };
  assert.equal(scoring.scoreIntentCase(gold, taskResult([
    { task_id: 'x', intent_id: 'transfer', depends_on: [] },
    { task_id: 'y', intent_id: 'transfer', depends_on: ['x'] },
  ])).strict, true);
});

test('production A5 ignores irrelevant wording even when attached to an active candidate', () => {
  const { consumeGraphClarificationQuestions } = require('../routes/rsi-runtime-profile');
  const q = { type: 'generic_ambiguous_intent', question: '请选择', options: [
    { intent_id: 'balance', label: '账户余额' }, { intent_id: 'records', label: '交易明细' },
  ] };
  const candidates = [{ intent_id: 'balance', object: '账户', node: { decision_policy: { clarify_questions: ['您要提供哪个贷款合同？'] } } }];
  const result = consumeGraphClarificationQuestions([q], { intent_id: 'balance' }, candidates)[0];
  assert.equal(result.source, 'candidate_options');
  assert.match(result.question, /账户余额.*交易明细/);
  assert.doesNotMatch(result.question, /贷款/);
});

test('ambiguous option quality penalizes irrelevant and duplicate options while retaining coverage', () => {
  const gold = { intent_shape: 'ambiguous_intent', expected_intents: ['a', 'b'] };
  const res = ids => ({ understanding: { clarification: { needed: true, question: '您要办理哪项业务？', options: ids.map(intent_id => ({ intent_id })) } } });
  const clean = scoring.scoreIntentCase(gold, res(['a', 'b']));
  assert.equal(clean.strict, true);
  const broad = scoring.scoreIntentCase(gold, res(['a', 'b', 'junk']));
  assert.equal(broad.strict, false);
  assert.equal(broad.resultType, 'clarify_extra_options');
  assert.equal(broad.clarification_quality.coverage, 1);
  assert.equal(broad.clarification_quality.precision, 2 / 3);
  assert.ok(broad.relaxed < clean.relaxed);
  assert.equal(scoring.scoreIntentCase(gold, res(['a', 'b', 'a'])).strict, false);
  assert.equal(scoring.scoreIntentCase(gold, { final_result: { intent_id: 'a' } }).resultType, 'clarify_not_triggered');
});

test('optional question dimensions and offline turns evaluate answerability and convergence honestly', () => {
  const gold = { expected_turns: [
    { intent_shape: 'ambiguous_intent', expected_intents: ['a', 'b'], expected_clarification: { question_terms: ['账户'] } },
    { intent_shape: 'single_intent', expected_intents: ['b'] },
  ] };
  const turns = [
    { understanding: { clarification: { needed: true, question: '您要查看哪个账户？', options: [{ intent_id: 'a' }, { intent_id: 'b' }] } } },
    { final_result: { intent_id: 'b' } },
  ];
  assert.equal(scoring.evaluateConversationQuality(gold, turns).converged, true);
  turns[0].understanding.clarification.question = '请确认';
  assert.equal(scoring.evaluateConversationQuality(gold, turns).strict, false);
  assert.equal(scoring.evaluateConversationQuality(gold, turns.slice(0, 1)).converged, false);
  assert.equal(scoring.SCORING_CAPABILITIES.runtimeMultiTurn, false);
});

test('expected schema rejects malformed task gold instead of inflating scores', () => {
  assert.throws(() => scoring.scoreIntentCase({ intent_shape: 'multi_intent', expected_tasks: [{ slots: {} }] }, {}), /intent_id/);
  assert.throws(() => scoring.scoreIntentCase({ intent_shape: 'multi_intent', expected_tasks: [] }, {}), /expected_tasks/);
  assert.throws(() => scoring.scoreIntentCase({ intent_shape: 'ambiguous_intent', expected_intents: [] }, {}), /expected_intents/);
});

test('batch scoring entry consumes task gold and returns diagnosis without paid model calls', async () => {
  const { scoreEngineCase } = require('../routes/rsi-scoring-runtime');
  assert.equal(typeof scoreEngineCase, 'function', 'the batch scorer must use the same task-aware quality contract');
  let calls = 0;
  const evaluate = async () => { calls++; return taskResult([{ intent_id: 'transfer', payee: '乙' }]); };
  const gold = { case_id: 'offline', query: '转账给甲', intent_shape: 'multi_intent', expected_tasks: [{ intent_id: 'transfer', slots: { payee: '甲' } }] };
  const row = await scoreEngineCase(gold, evaluate, { concurrency: 2 });
  assert.equal(calls, 1);
  assert.equal(row.resultType, 'multi_wrong');
  assert.equal(row.errorFamily, 'multi_task_constraints');
  assert.equal(row.scoring_concurrency, 2);
  assert.ok(row.latency_ms >= 0);
  const malformed = await scoreEngineCase({ expected_tasks: [] }, evaluate);
  assert.equal(malformed.resultType, 'invalid_gold');
  assert.equal(calls, 1, 'invalid gold must fail before running the engine');
});

test('structured error families and generation rotation balance feedback rather than newest-only slices', () => {
  const rows = [
    ...Array.from({ length: 10 }, (_, n) => ({ case_id: `rank${n}`, shape: 'single_intent', strict: false, resultType: 'rank_error' })),
    { case_id: 'split', strict: false, shape: 'multi_intent', resultType: 'multi_missing', diagnosis: { missing: ['a'] } },
    { case_id: 'clarify', strict: false, shape: 'ambiguous_intent', resultType: 'clarify_extra_options' },
    { case_id: 'pass', strict: true },
  ];
  assert.equal(learning.diagnoseError(rows[0]).errorFamily, 'ranking');
  const sampled = learning.selectTrainingFeedback(rows, 3, 1);
  assert.deepEqual(new Set(sampled.map(r => r.errorFamily)), new Set(['ranking', 'multi_missing', 'clarification_precision']));
  assert.ok(!sampled.some(r => r.strict));
  assert.notDeepEqual(learning.selectTrainingFeedback(rows, 1, 1), learning.selectTrainingFeedback(rows, 1, 2));
});

test('ambiguous failures do not permanently occupy first two parameter candidates', () => {
  const graph = { meta: {}, intent_nodes: [] };
  const first = Array.from({ length: 8 }, (_, i) => learning.parameterMutations(graph, [], i + 1, [{ shape: 'ambiguous_intent' }]).slice(0, 2));
  const keys = new Set(first.flat().flatMap(m => Object.keys(m.parameters)));
  for (const key of ['hintWeight', 'clauseWeight', 'lexicalWeight', 'actionWeight', 'negativePenalty', 'graphClusterFirst']) assert.ok(keys.has(key), key);
});

test('capability registry separates runnable, setup, reserved and unavailable capabilities', () => {
  const { capabilityRegistry, normalizeOptimizationConfig } = require('../routes/rsi-optimization');
  const registry = capabilityRegistry();
  assert.equal(registry.methods.gepa.status, 'requires_setup');
  assert.equal(registry.targets.engine_code.status, 'reserved');
  assert.equal(registry.targets.model.status, 'reserved');
  assert.equal(registry.memberOptimizer.status, 'unavailable');
  assert.equal(registry.fusion, false);
  assert.equal(normalizeOptimizationConfig({}).allowMerge, false);
  assert.throws(() => normalizeOptimizationConfig({ allowMerge: true }), /融合|fusion/);
  assert.match(registry.graphOperators.A3.scope, /single|单/);
});

test('production understanding consumes relevant A5 questions only after ambiguity is established', () => {
  const { buildIntentUnderstanding } = require('../routes/intent-evaluator-v2');
  const balance = { intent_id: 'a', intent_name: '账户余额', eval_label: '账户余额', object: '账户', action_code: 'query', score: 0.8,
    node: { semantic_definition: { scope_in: ['账户余额'] }, decision_policy: { clarify_questions: ['您想查看账户余额，还是交易明细？'] } } };
  const records = { intent_id: 'b', intent_name: '交易明细', eval_label: '交易明细', object: '账户', action_code: 'query',
    node: { semantic_definition: { scope_in: ['账户交易明细'] }, decision_policy: { clarify_questions: [] } } };
  const unrelated = { intent_id: 'z', intent_name: '贷款', eval_label: '贷款', object: '贷款', action_code: 'repay',
    node: { decision_policy: { clarify_questions: ['请提供贷款合同编号？'] } } };
  const unclear = buildIntentUnderstanding('我的账户', { final: balance, slots: {} }, [balance, records, unrelated]);
  assert.equal(unclear.clarification.needed, true);
  assert.match(unclear.clarification.question, /账户余额.*交易明细/);
  assert.doesNotMatch(unclear.clarification.question, /贷款/);
  assert.equal(unclear.clarification.questions[0].source, 'graph.decision_policy.clarify_questions');
  const clear = buildIntentUnderstanding('查询账户余额', { final: { ...balance, score: 0.99 }, slots: {} }, [balance, records]);
  assert.equal(clear.clarification.needed, false);
});

test('shared graph utterances declare ambiguity even when a high scoring result would otherwise suppress it',()=>{
 const {buildIntentUnderstanding}=require('../routes/intent-evaluator-v2');
 const candidate=(id,name,utterances)=>({intent_id:id,intent_name:name,eval_label:name,object:name,action_code:'query',score:2,
  node:{retrieval_profile:{utterance_view:utterances},semantic_definition:{scope_in:[]},decision_policy:{}}});
 const a=candidate('a','网点预约',['网点的事','查询网点预约']);
 const b=candidate('b','网点详情',['网点的事','查询网点详情']);
 const unrelated=candidate('z','贷款',['查贷款']);
 const result=buildIntentUnderstanding('网点的事',{final:a,slots:{}},[a,b,unrelated]);
 assert.equal(result.clarification.needed,true);
 assert.deepEqual(result.clarification.options.map(o=>o.intent_id),['a','b']);
 const clear=buildIntentUnderstanding('查询网点预约',{final:a,slots:{}},[a,b,unrelated]);
 assert.equal(clear.clarification.needed,false);
});

test('shared utterance candidates narrow broad fallback options without leaking into a specific expression',()=>{
 const {buildIntentUnderstanding}=require('../routes/intent-evaluator-v2');
 const make=(intent_id,words)=>({intent_id,intent_name:intent_id,eval_label:intent_id,action_code:'query',score:0.5,node:{retrieval_profile:{utterance_view:words},semantic_definition:{scope_in:['单子']},decision_policy:{}}});
 const candidates=[make('receipt',['查单子','查电子回单']),make('bill',['查单子','查信用卡账单']),make('irrelevant',['查其他单据'])];
 const ambiguous=buildIntentUnderstanding('我要查单子',{final:null,slots:{}},candidates);
 assert.deepEqual(ambiguous.clarification.options.map(o=>o.intent_id),['receipt','bill']);
 assert.equal(buildIntentUnderstanding('查电子回单',{final:{...candidates[0],score:2},slots:{}},candidates).clarification.needed,false);
});

test('agent attribution includes excess options and stage observations instead of prescribing wording for trigger failures',()=>{
 const {attributeResults}=require('../routes/intent-rsi').__test;
 const families=attributeResults([
  {case_id:'excess',query:'查单据',shape:'ambiguous_intent',strict:false,resultType:'clarify_extra_options',expected:['a','b'],engine_candidates:['a','b','z'],engine_clarifying:true,diagnosis:{missing:[],extra:['z']},evidence:{status:'recorded',routes:{lexical:{status:'completed',rows:[{intent_id:'a'},{intent_id:'b'}]}}}},
  {case_id:'trigger',query:'网点业务',shape:'ambiguous_intent',strict:false,resultType:'clarify_not_triggered',expected:['a','b'],engine_top1:'a'},
  {case_id:'composite',query:'查余额和账单',shape:'multi_intent',strict:false,resultType:'unexpected_clarification',expected:['a','b']},
 ]);
 assert.ok(families.some(f=>f.samples.some(s=>s.case_id==='excess')));
 const trigger=families.find(f=>f.samples.some(s=>s.case_id==='trigger'));
 assert.notEqual(trigger.suggested_op,'A5_clarify');
 assert.ok(families.find(f=>f.samples.some(s=>s.case_id==='excess')).samples[0].observations);
 assert.ok(families.some(f=>f.samples.some(s=>s.case_id==='composite')));
});
