'use strict';
// 策略层测试：工具必须能从自己的历史里学到「哪种改法有效」，并把结论用于下一轮搜索。
const test = require('node:test');
const assert = require('node:assert');
const S = require('../routes/rsi-strategy');
const L = require('../routes/rsi-learning');
const G = require('../routes/rsi-goal');

const REV = { engineSha: 'fixture', protoRev: 3, engineMode: 'offline-deterministic+decl' };
const scores = trainPct => ({
  engineRev: REV, all: { total: 10, strict_pct: trainPct, relaxed_pct: trainPct },
  train: { total: 10, strict_pct: trainPct, relaxed_pct: trainPct },
  heldout: { total: 4, strict_pct: 50, relaxed_pct: 50 },
});

test('未测量的失败候选不能证否算子或耗尽搜索', () => {
  const branches = {};
  for (let i = 1; i <= 5; i++) {
    branches['b' + i] = branch('b' + i, { target: 'graph', type: 'A2_disambiguation', evidence: ['c1'] });
    delete branches['b' + i].fullScores;
    delete branches['b' + i].scores;
    branches['b' + i].status = 'error';
  }
  const s = S.summarize(stateWith(branches, { baselineRows: [{case_id:'c1',strict:false,resultType:'wrong_label'}] }));
  assert.equal(s.measuredCount, 0);
  assert.deepEqual(s.deadOperators, []);
  assert.deepEqual(s.deadArms, []);
  assert.equal(S.noLeverage(s).exhausted, false);
  assert.ok(!s.untriedOperators.includes('A2_disambiguation'));
  assert.ok(s.attemptedOperators.includes('A2_disambiguation'));
  assert.ok(s.unmeasuredFamilies.includes('wrong_label'));
  assert.doesNotMatch(s.digest,/本任务实测|5 次无收益/);
  assert.match(s.digest,/未取得测量/);
});

test('低预计收益不等于动作已证否；只有全部明确耗尽才能停止', () => {
  const s = { candidateCount: 5, measuredCount: 3, leverage: [{family:'unclassified',expectedFixes:0,exhausted:false}] };
  assert.equal(S.noLeverage(s).exhausted, false);
  assert.equal(S.noLeverage({...s,leverage:[{family:'ranking',expectedFixes:0,exhausted:true}]}).exhausted, true);
});

test('旧引擎的负收益不能证否修复后引擎中的同一算子',()=>{
 const branches={};for(let i=1;i<=4;i++)branches['b'+i]=branch('b'+i,{target:'graph',type:'A6_ambiguity_cluster_expand',evidence:['c1']});
 const s=stateWith(branches,{baselineRows:[{case_id:'c1',strict:false,resultType:'clarify_extra_options'}]});
 s.evolveRuns[0].engineRev={...REV,engineSha:'before-engine-fix'};
 const current=S.summarize(s);
 assert.equal(current.measuredCount,0);
 assert.deepEqual(current.deadOperators,[]);
 assert.equal(current.ignoredCandidateCount,4);
 assert.match(current.digest,/旧引擎/);
});

function branch(id, { parent = 'b0', target = 'engine', params, type, evidence, status = 'gated', trainPct = 60 } = {}) {
  return {
    id, parent, target, status, op: type || target,
    proposal: type ? { type, evidence_cases: evidence || [], motivation: 'fixture' } : undefined,
    runtimeMutation: params ? { parameters: params } : undefined,
    fullScores: scores(trainPct), scores: { trainStrict: trainPct, heldoutStrict: 50, allStrict: trainPct },
    gateReason: status === 'alive' ? '通过' : '未观测到可靠提升',
  };
}

function stateWith(branches, opts = {}) {
  return {
    split: { train: ['c1', 'c2'], heldout: ['h1'] },
    baseline: {
      scores: scores(70),
      results: (opts.baselineRows || []),
    },
    evolveRuns: [{ id: 'run_a', at: '2026-10-19T00:00:00Z', branches: { b0: { id: 'b0', op: 'root', fullScores: scores(70) }, ...branches } }],
    archive: opts.archive || [],
  };
}

test('折叠是幂等的：同一份历史重算两次结果一致', () => {
  const st = stateWith({
    b1: branch('b1', { params: { hintWeight: 0.2 }, trainPct: 68 }),
    b2: branch('b2', { params: { hintWeight: 0.4 }, trainPct: 72, status: 'alive' }),
  });
  const a = S.summarize(st), b = S.summarize(st);
  delete a.generatedAt; delete b.generatedAt;
  assert.deepEqual(a, b);
  assert.equal(a.candidateCount, 2);
  assert.equal(a.measuredCount, 2);
  const arm = a.arms.find(x => x.key.includes('hintWeight=0.4'));
  assert.equal(arm.attempts, 1);
  assert.equal(arm.wins, 1, '过门禁的动作要记一次胜绩');
  assert.equal(a.promotedCount, 1);
});

test('参数按维度累计：单个取值只试一次也能学出「这个维度没杠杆」', () => {
  const branches = {};
  [0.1, 0.15, 0.2, 0.25].forEach((v, i) => { branches['b' + (i + 1)] = branch('b' + (i + 1), { params: { hintWeight: v }, trainPct: 66 }); });
  const st = stateWith(branches);
  const s = S.summarize(st);
  const dim = s.operators.find(o => o.operator === 'param:hintWeight');
  assert.equal(dim.attempts, 4);
  assert.equal(dim.wins, 0);
  assert.equal(dim.dead, true, '4 次无胜绩应判该维度已证否');
  assert.deepEqual(s.deadDimensions, ['param:hintWeight']);
  const policy = S.policyFor(s);
  assert.equal(policy.dead('engine|param:hintWeight=0.2|engine_global', 'param:hintWeight'), true);
  assert.equal(policy.dead('engine|param:hintWeight=0.9|engine_global', 'param:hintWeight'), true, '维度级结论应覆盖同维度其他取值');
});

test('被证否的维度不再占用候选位，全部证否时保留唯一探索位', () => {
  const graph = { meta: { rsi_runtime: { engine: { hintWeight: 0.28 } } }, intent_nodes: [] };
  const failures = [{ shape: 'ambiguous_intent' }];
  const open = L.parameterMutations(graph, [], 1, failures, null);
  assert.ok(open.some(m => Object.hasOwn(m.parameters, 'hintWeight')), '无记忆时一维参数应在候选里');

  const blocked = L.parameterMutations(graph, [], 1, failures, { dead: (k, d) => d === 'param:hintWeight', score: () => 0 });
  assert.ok(!blocked.some(m => Object.hasOwn(m.parameters, 'hintWeight')), '已证否维度不应再出现');
  assert.ok(blocked.length > 0, '其他维度仍要能排上队');

  const all = L.parameterMutations(graph, [], 1, failures, { dead: () => true, score: () => 0 });
  assert.equal(all.length, 1, '全部证否时保留一个探索位，不能把搜索锁死');
  assert.match(all[0].motivation, /探索位/);
});

test('失败族回收率由实测修正，目标上限随之自校准', () => {
  const baselineRows = [
    { case_id: 'c1', strict: false, shape: 'single_intent', resultType: 'recall_miss' },
    { case_id: 'c2', strict: false, shape: 'single_intent', resultType: 'recall_miss' },
    { case_id: 'c3', strict: true, shape: 'single_intent', resultType: 'ok' },
    { case_id: 'c4', strict: true, shape: 'single_intent', resultType: 'ok' },
  ];
  const st = stateWith({
    b1: branch('b1', { target: 'graph', type: 'A1_utterance_expand', evidence: ['c1'], trainPct: 50 }),
    b2: branch('b2', { target: 'graph', type: 'A1_utterance_expand', evidence: ['c2'], trainPct: 50 }),
  }, { baselineRows });
  st.archive = [
    { runId: 'run_a', branchId: 'b1', armFixes: [], armBroken: ['c3'] },
    { runId: 'run_a', branchId: 'b2', armFixes: [], armBroken: ['c4'] },
  ];
  const s = S.summarize(st);
  const recall = s.families.find(f => f.family === 'recall');
  assert.equal(recall.failedCases, 2);
  assert.equal(recall.fixes, 0);
  assert.equal(recall.source, 'blended');
  // (0 + 0.45*3) / (2 + 3) = 0.27，比先验 0.45 低，说明实测把乐观先验拉回来了
  assert.ok(recall.rate < 0.45 && recall.rate > 0.2, `expected shrunk rate, got ${recall.rate}`);

  const rows = baselineRows.filter(r => !r.strict);
  const withPrior = G.goalProgress({ target: 100 }, { all: { total: 4, strict_pct: 50 }, train: { total: 4, strict_pct: 50 }, heldout: { total: 1, strict_pct: 0 } }, rows, []);
  const withMeasured = G.goalProgress({ target: 100 }, { all: { total: 4, strict_pct: 50 }, train: { total: 4, strict_pct: 50 }, heldout: { total: 1, strict_pct: 0 } }, rows, [],
    { rates: s.rates, strategy: s });
  assert.ok(withMeasured.ceilingPct < withPrior.ceilingPct, '实测回收率低于先验时，上限必须下调');
  assert.equal(withMeasured.ceilingBasis, 'measured');
  assert.equal(withMeasured.byFamily[0].rateSource, 'blended');
});

test('所有失败族的最优动作都被证否时，判定为没有剩余杠杆', () => {
  const baselineRows = [
    { case_id: 'c1', strict: false, shape: 'ambiguous_intent', resultType: 'clarify_extra_options' },
    { case_id: 'c2', strict: true, shape: 'ambiguous_intent', resultType: 'ok' },
  ];
  const branches = {};
  for (let i = 1; i <= 4; i++) branches['b' + i] = branch('b' + i, { target: 'graph', type: 'A5_clarify', evidence: ['c1'], trainPct: 50 });
  const st = stateWith(branches, { baselineRows });
  const s = S.summarize(st);
  // 只有本族全部真实可执行算子均已证否，才能说动作耗尽。
  const dead = new Set(s.deadOperators);
  assert.ok(dead.has('A5_clarify'));
  const open = S.leverage({ ...s, deadOperators: [...dead, 'param:graphClusterFirst'] });
  assert.equal(open.find(l=>l.family==='clarification_precision').exhausted,false);
  const lev = S.leverage({ ...s, deadOperators: [...dead,...S.FAMILY_PRIOR.clarification_precision.operators] });
  const precision = lev.find(l => l.family === 'clarification_precision');
  assert.equal(precision.exhausted, true);
  assert.deepEqual(precision.remainingOperators, []);
});

test('动作归因：提案的 evidence_cases 决定它打的是哪个失败族', () => {
  const familyByCase = new Map([['c9', ['multi_missing']], ['c8', ['recall']]]);
  const arm = S.describeArm({ target: 'graph', proposal: { type: 'A1_utterance_expand', evidence_cases: ['c9', 'c9', 'c8'] } }, { familyByCase });
  assert.equal(arm.operator, 'A1_utterance_expand');
  assert.equal(arm.family, 'multi_missing');
  assert.equal(arm.targeted, 3);

  const param = S.describeArm({ target: 'engine', runtimeMutation: { parameters: { graphClusterFirst: true, clarificationLimit: 3 } } }, {});
  assert.equal(param.operator, 'clarification:cluster+limit');
  assert.equal(param.family, S.GLOBAL_FAMILY);
  assert.match(param.key, /clarificationLimit=3/);
});

test('预算按缺口×实测可修率分配，而不是平均分', () => {
  const quota = S.allocate({ leverage: [
    { family: 'recall', expectedFixes: 3.0 },
    { family: 'ranking', expectedFixes: 0.5 },
    { family: 'unclassified', expectedFixes: 0 },
  ] }, 4);
  assert.equal(quota.reduce((n, q) => n + q.seats, 0), 4);
  assert.equal(quota[0].family, 'recall');
  assert.ok(quota[0].seats > quota[1].seats);
  assert.ok(!quota.some(q => q.family === 'unclassified'));
});

test('给模型的摘要是知识而不是原始记录：含已证否与未尝试', () => {
  const branches = {};
  for (let i = 1; i <= 5; i++) branches['b' + i] = branch('b' + i, { target: 'graph', type: 'A1_utterance_expand', evidence: [], trainPct: 66 });
  const s = S.summarize(stateWith(branches));
  assert.match(s.digest, /已证否/);
  assert.match(s.digest, /A1/);
  assert.ok(s.deadOperators.includes('A1_utterance_expand'));
  assert.ok(!s.untriedOperators.includes('A1_utterance_expand'), '已证否的动作不能同时出现在「尚未尝试」里');
  assert.ok(s.untriedOperators.includes('A3_clause_expansion'));
});
