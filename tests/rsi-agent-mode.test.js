'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createProductionRuntime } = require('../routes/rsi-production-runtime');
const rev = { engineSha: 'fixture', protoRev: 2, engineMode: 'offline-deterministic+decl' };
const scores = n => ({ engineRev: rev, all: { total: 2, strict_pct: n, relaxed_pct: n }, train: { total: 1, strict_pct: n, relaxed_pct: n }, heldout: { total: 1, strict_pct: n, relaxed_pct: n } });

function fixture(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-agent-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let state = { currentVersion: 'v1', versions: [{ version: 'v1' }], archive: [], log: [], regression: {},
    split: { train: ['t', 't2'], heldout: ['h'], test: ['secret'] }, stats: {}, evolveRuns: [], scoreHistory: [] };
  const graph = { meta: {}, intent_nodes: [] };
  const clone = x => JSON.parse(JSON.stringify(x));
  const runtimeDeps = { root: dir, rsiDir: dir, defaultDecisionMode: 'rules', loadState: () => clone(state),
    saveState: s => { state = clone(s); }, loadGraph: () => clone(graph),
    saveVersion: (v, g) => fs.writeFileSync(path.join(dir, `${v}.json`), JSON.stringify(g)),
    readCases: () => [{ case_id: 't' }, { case_id: 't2' }, { case_id: 'h' }, { case_id: 'secret' }],
    revision: () => rev, publicState: s => ({ currentVersion: s.currentVersion }),
    scoreGraph: async (g, o) => {
      const results = (o?.ids || ['t', 't2', 'h']).map(case_id => ({ case_id, strict: case_id === 'h' || (g.meta.level || 0) > 0, relaxed: case_id === 'h' || (g.meta.level || 0) > 0 ? 1 : 0 }));
      const bucket = rs => ({ total: rs.length, strict_pct: rs.length ? 100 * rs.filter(r => r.strict).length / rs.length : 0, relaxed_pct: rs.length ? 100 * rs.filter(r => r.relaxed).length / rs.length : 0 });
      return { scores: { engineRev: rev, train: bucket(results.filter(r => r.case_id !== 'h')), heldout: bucket(results.filter(r => r.case_id === 'h')), all: bucket(results) }, results };
    }, ...extra };
  const runtime = createProductionRuntime(runtimeDeps);
  return { runtime, state: () => state, set: s => { state = s; } };
}

const PROPOSAL = { type: 'A1_utterance_expand', target: 'i1', add_utterances: ['查余额'], motivation: '补充余额查询说法', evidence_cases: ['t'] };

test('agent mode turns framework proposals into measured gated candidates', async t => {
  const calls = [];
  const f = fixture(t, {
    agentUrl: 'http://agent.test', validateProposal: () => null,
    applyProposal: (g, p) => ({ graph: { ...g, meta: { ...g.meta, level: (g.meta.level || 0) + 1, lastProposal: p.type } } }),
    attributeResults: () => [{ family: 'fam1', count: 1, suggested_op: 'A1_utterance_expand', note: '', samples: [{ case_id: 't', query: 'q', shape: 'single_intent' }] }],
    extractJsonArray: JSON.parse,
  });
  const origFetch = globalThis.fetch;
  let bridgeCheck = null;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), body: JSON.parse(opts.body) });
    // Agent 任务进行中，Node 侧 /agent/* 工具桥必须可用（对应任务绑定）
    bridgeCheck = { weaknesses: f.runtime.agentTool(null, 'weaknesses', {}), wrongTask: (() => { try { f.runtime.agentTool('other', 'weaknesses', {}); return 'should_throw'; } catch (e) { return e.message; } })() };
    return { ok: true, status: 200, json: async () => ({ status: 'ok', reply: JSON.stringify([PROPOSAL]), toolCalls: [{ name: 'list_weaknesses', args: {} }, { name: 'probe_query', args: { q: '查余额', target: 'i1', op: 'A1_utterance_expand', utt: '查余额' } }] }) };
  };
  t.after(() => { globalThis.fetch = origFetch; });
  const run = await f.runtime.evolve({ maxRounds: 1, optimization: { targets: ['graph'], decisionMode: 'agent' } });
  assert.equal(run.decisionMode, 'agent');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.tool_ctx.branch, 'b0');
  assert.ok(bridgeCheck.weaknesses.data[0].family === 'fam1', 'bridge serves attribution families');
  assert.match(bridgeCheck.wrongTask, /不可用/);
  const r = run.rounds[0];
  assert.equal(r.reasoning.mode, 'agent');
  assert.equal(r.reasoning.status, 'complete');
  assert.equal(r.reasoning.toolCalls.length, 2);
  assert.equal(r.reasoning.trials[0].status, 'measured');
  assert.ok(r.reasoning.trials[0].branchIds.length >= 1);
  const candidate = Object.values(run.branches).find(b => b.method === 'agent_propose');
  assert.ok(candidate, 'agent proposal becomes a branch');
  assert.equal(candidate.status, 'alive');
  assert.equal(candidate.proposal.type, 'A1_utterance_expand');
  assert.equal(run.champion, candidate.id, 'training improvement promotes the agent candidate');
  assert.equal(run.rounds[0].improved, true);
  assert.ok(!JSON.stringify(r.reasoning).includes('secret'), 'reasoning record never exposes heldout/test');
});

test('agent failure is recorded honestly and the run still completes without fabricating candidates', async t => {
  const f = fixture(t, { agentUrl: 'http://agent.test', extractJsonArray: JSON.parse });
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ status: 'error', errorKind: 'max_iterations', error: '迭代预算耗尽', reply: '', toolCalls: [] }) });
  t.after(() => { globalThis.fetch = origFetch; });
  const run = await f.runtime.evolve({ maxRounds: 1, optimization: { targets: ['graph'], decisionMode: 'agent' } });
  const r = run.rounds[0];
  assert.equal(r.reasoning.mode, 'agent');
  assert.equal(r.reasoning.status, 'error');
  assert.match(r.reasoning.error, /迭代预算/);
  assert.equal(r.proposed, 0);
  assert.equal(run.champion, 'b0');
  assert.equal(run.totalAdopted, 0);
});

test('agent probe uses actual training gold and clarification quality rather than option IDs as ranking objects',async t=>{
 const graph={meta:{},intent_nodes:['i1','i2'].map(intent_id=>({identity:{intent_id},semantic_definition:{disambiguation_hints:['真实语义线索'],scope_out:['真实排除边界'],confusable_intents:['other']},retrieval_profile:{utterance_view:[]}}))};
 let probe,inspected,weaknesses;
 const f=fixture(t,{agentUrl:'http://agent.test',loadGraph:()=>graph,attributeResults:()=>[],
  readCases:()=>[{case_id:'t',query:'模糊业务',intent_shape:'ambiguous_intent',expected_intents:['i1','i2']},{case_id:'t2'},{case_id:'h'},{case_id:'secret'}],
  validateProposal:()=>null,applyProposal:g=>({graph:{...g,meta:{fixed:true}}}),extractJsonArray:JSON.parse,
  scoreGraph:async(g,o)=>{const results=o.ids.map(case_id=>({case_id,query:'模糊业务',expected:['i1','i2'],shape:'ambiguous_intent',strict:case_id!=='t'||!!g.meta.fixed,relaxed:g.meta.fixed?1:0,resultType:g.meta.fixed?'correct':'clarify_not_triggered',engine_top1:'i1',engine_clarifying:!!g.meta.fixed,engine_candidates:g.meta.fixed?['i1','i2']:[],evidence:{routes:{lexical:{status:'completed',rows:[{intent_id:'i1',score:2},{intent_id:'i2',score:1}]}}}}));return {scores:scores(67),results};},
 });
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
 globalThis.fetch=async()=>{
  inspected=f.runtime.agentTool(null,'intent',{id:'i1'}).data;
  weaknesses=f.runtime.agentTool(null,'weaknesses',{});
  probe=await f.runtime.agentTool(null,'probe',{q:'模糊业务',target:'i1',op:'A6',targets:'i1||i2',utt:'模糊业务'});
  return {ok:true,json:async()=>({status:'ok',reply:'[]',toolCalls:[]})};
 };
 const run=await f.runtime.evolve({maxRounds:1,optimization:{targets:['graph'],decisionMode:'agent'}});
 assert.deepEqual(inspected.hints,['真实语义线索']);
 assert.deepEqual(inspected.scope_out,['真实排除边界']);
 assert.equal(probe?.draft.strict,true);
 assert.equal(probe?.current.strict,false);
 assert.equal(probe?.draft.clarifying,true);
 assert.deepEqual(probe?.draft.candidates,['i1','i2']);
 assert.equal(probe?.improved,true);
 assert.equal(run.probeCalls,1);
 assert.ok(weaknesses.capabilities.graphOperators.A6_ambiguity_cluster_expand);
});
