'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { __test } = require('../routes/intent-rsi');
const { validateProposal, applyProposal } = __test;

const node = id => ({ identity: { intent_id: id, intent_name: '意图' + id }, semantic_definition: {}, retrieval_profile: {}, decision_policy: {} });
const graph = () => ({ meta: {}, intent_nodes: [node('i1'), node('i2'), node('i3')] });
const casesById = new Map([['c1', { case_id: 'c1', query: '我要把钱转给张三' }]]);
const a6 = { type: 'A6_ambiguity_cluster_expand', targets: ['i1', 'i2'], add_utterances: ['把钱转给张三'], motivation: '簇补说法', evidence_cases: ['c1'] };
const a2 = { type: 'A2_disambiguation', target: 'i3', add_scope_out: ['把钱转给张三'], motivation: '收边', evidence_cases: ['c1'] };

test('combo proposal validates when it packs one A6 with A2 trims', () => {
  const combo = { type: 'combo', parts: [a6, a2], motivation: '组合', evidence_cases: ['c1'] };
  assert.equal(validateProposal(combo, graph(), casesById), null);
});

test('combo rejects wrong shape: single part, nesting, missing A6, bad part target', () => {
  const byId = casesById;
  assert.match(validateProposal({ type: 'combo', parts: [a6], motivation: 'x', evidence_cases: ['c1'] }, graph(), byId) || '', /2 至 4/);
  assert.match(validateProposal({ type: 'combo', parts: [{ type: 'combo', parts: [a6, a2], motivation: 'x', evidence_cases: ['c1'] }, a2], motivation: 'x', evidence_cases: ['c1'] }, graph(), byId) || '', /嵌套/);
  assert.match(validateProposal({ type: 'combo', parts: [a2, a2], motivation: 'x', evidence_cases: ['c1'] }, graph(), byId) || '', /A6/);
  const badTarget = { type: 'A2_disambiguation', target: 'i9', add_scope_out: ['x'], motivation: 'm', evidence_cases: ['c1'] };
  assert.match(validateProposal({ type: 'combo', parts: [a6, badTarget], motivation: 'x', evidence_cases: ['c1'] }, graph(), byId) || '', /第 2 部分/);
});

test('combo application lands both the cluster expansion and the competing scope_out', () => {
  const combo = { type: 'combo', parts: [a6, a2], motivation: '组合', evidence_cases: ['c1'] };
  const result = applyProposal(graph(), combo);
  const byId = new Map(result.graph.intent_nodes.map(n => [n.identity.intent_id, n]));
  assert.ok(byId.get('i1').retrieval_profile.utterance_view.includes('把钱转给张三'));
  assert.ok(byId.get('i2').retrieval_profile.utterance_view.includes('把钱转给张三'));
  assert.ok(byId.get('i3').semantic_definition.scope_out.includes('把钱转给张三'));
  assert.ok(result.changes.some(c => c.includes('[A6_ambiguity_cluster_expand]')));
  assert.ok(result.changes.some(c => c.includes('[A2_disambiguation]') && c.includes('scope_out')));
});

test('combo excludes unrelated operators so the measured intervention matches its advertised scope',()=>{
 const unrelated={type:'A4_description_rewrite',target:'i3',new_description:'改写描述',motivation:'其他实验',evidence_cases:['c1']};
 assert.match(validateProposal({type:'combo',parts:[a6,unrelated],motivation:'组合',evidence_cases:['c1']},graph(),casesById)||'',/A2|收边/);
});

test('A2 exclusions require user-language phrases rather than intent identifiers',()=>{
 const proposal={...a2,add_scope_out:['intent_scene_12345678']};
 assert.match(validateProposal(proposal,graph(),casesById)||'',/scope_out.*意图|用户.*说法/);
 assert.equal(validateProposal(a2,graph(),casesById),null);
});
