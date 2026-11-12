/**
 * 意图图谱模板自检（data/graph-builder-templates/intent-graph.json）
 * 模板自身结构 + starter_graph 过 X6 校验器（对齐 org-graph.js 发布门禁）
 *
 * schema 与真实数据来源：AI Harbor 意图建模 v2.1（intent-graph-v2.1-p1-batch10）——
 * ontology 的 9 类节点 / edge_type_definitions 的 17 类可表达边；
 * starter_graph 由 tools/intent-graph-template-builder.js 从最新批次提取
 * 「转账服务 + 财富管理」领域子图生成。
 * 用法: node --test tests/intent-graph-template.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateGraph } = require('../tools/x6-graph-template-validator');
const template = require('../data/graph-builder-templates/intent-graph.json');

test('模板骨架：id/版本/9 类节点/21 类边（对齐 ontology）', () => {
  assert.equal(template.template_id, 'intent-graph');
  const nodeTypes = template.node_types.map(function (t) { return t.type; });
  assert.deepEqual(nodeTypes, [
    'AGGREGATE_INTENT', 'INTENT', 'BUSINESS_OBJECT', 'ACTION', 'SLOT',
    'STATE', 'RISK', 'KNOWLEDGE_ANSWER', 'RUNTIME_BOUNDARY',
  ]);
  const edgeTypes = template.edge_types.map(function (t) { return t.type; });
  assert.deepEqual(edgeTypes, [
    'has_leaf_intent', 'is_child_of', 'same_as', 'related_to', 'attribute_of', 'setting_of',
    'has_business_object', 'acts_on_object', 'uses_action',
    'requires_slot', 'optional_slot', 'has_state_constraint', 'has_risk_constraint',
    'has_knowledge_answer', 'references', 'clarify_to', 'confusable_with',
    'binds_to_workflow', 'binds_to_api', 'binds_to_agent', 'has_navigation_path',
  ]);
  assert.equal(template.validation_rules.allow_self_loop, false);
});

test('意图类型枚举对齐 v2 schema（ASK/QUERY/DO/CHANGE/CANCEL/HELP/TRANSFER/REPAY）', () => {
  const intent = template.node_types.filter(function (t) { return t.type === 'INTENT'; })[0];
  const typeField = intent.fields.filter(function (f) { return f.key === 'intent_type'; })[0];
  assert.deepEqual(typeField.options, ['ASK', 'QUERY', 'DO', 'CHANGE', 'CANCEL', 'HELP', 'TRANSFER', 'REPAY']);
  assert.equal(typeField.required, true);
  // 语义字段对齐真实数据（semantic_definition 平铺）
  const keys = intent.fields.map(function (f) { return f.key; });
  ['goal', 'description', 'scope_in', 'scope_out', 'confusable_intents', 'disambiguation_hints'].forEach(function (k) {
    assert.ok(keys.indexOf(k) >= 0, '缺少字段 ' + k);
  });
});

test('交付契约：演示节点兼容，已选方式必须有目标，内部引用必须指向正确节点', () => {
  const base = template.starter_graph.nodes.find(function (node) { return node.type === 'INTENT'; });
  const answerSource = template.starter_graph.nodes.find(function (node) { return node.type === 'KNOWLEDGE_ANSWER'; });
  const answer = { ...answerSource, properties: { ...answerSource.properties, answer_text: '【演示】答案待业务确认。', content_status: 'mock' } };
  const slot = template.starter_graph.nodes.find(function (node) { return node.type === 'SLOT'; });
  const graph = { nodes: [{ ...base, properties: { ...base.properties } }, answer, slot], edges: [] };
  assert.equal(validateGraph(template, graph).valid, true, '旧版意图无需逐个补齐交付配置');

  graph.nodes[0].properties.fulfillment_kind = 'skill';
  let report = validateGraph(template, graph);
  assert.ok(report.errors.some(function (issue) { return issue.code === 'CONDITIONAL_FIELD_REQUIRED' && issue.path.endsWith('.skill_ref'); }));
  graph.nodes[0].properties.skill_ref = 'skill:transfer-assistant';
  assert.equal(validateGraph(template, graph).valid, true);

  graph.nodes[0].properties.fulfillment_kind = 'answer';
  graph.nodes[0].properties.answer_ref = 'missing-answer';
  report = validateGraph(template, graph);
  assert.ok(report.errors.some(function (issue) { return issue.code === 'FULFILLMENT_REFERENCE_INVALID' && issue.path.endsWith('.answer_ref'); }));
  graph.nodes[0].properties.answer_ref = answer.id;
  graph.nodes[0].properties.required_slot_refs = [slot.id];
  report = validateGraph(template, graph);
  assert.equal(report.valid, true);
  assert.ok(report.warnings.some(function (issue) { return issue.code === 'MOCK_ANSWER_CONTENT'; }));
  delete answer.properties.answer_text;
  assert.ok(validateGraph(template, graph).errors.some(function (issue) { return issue.code === 'ANSWER_CONTENT_REQUIRED'; }));
  answer.properties.answer_text = '【演示】答案待业务确认。';
  graph.nodes[0].properties.fulfillment_kind = 'query';
  graph.nodes[0].properties.query_ref = 'mock:query:account-query';
  assert.ok(validateGraph(template, graph).warnings.some(function (issue) { return issue.code === 'MOCK_FULFILLMENT_REFERENCE'; }));
  graph.nodes[0].properties.query_ref = 'capability:account-query';
  graph.nodes[0].properties.input_mapping_json = '{"accountId":"missing-slot"}';
  assert.ok(validateGraph(template, graph).errors.some(function (issue) { return issue.code === 'INPUT_MAPPING_INVALID'; }));
  graph.nodes[0].properties.input_mapping_json = JSON.stringify({ accountId: slot.id });
  graph.nodes[0].properties.confirmation_policy = 'before_execute';
  assert.ok(validateGraph(template, graph).errors.some(function (issue) { return issue.code === 'CONDITIONAL_FIELD_REQUIRED' && issue.path.endsWith('.confirmation_prompt'); }));
  graph.nodes[0].properties.confirmation_prompt = '请确认';
  assert.equal(validateGraph(template, graph).valid, true);
  graph.nodes[0].properties.required_slot_refs = [answer.id];
  assert.ok(validateGraph(template, graph).errors.some(function (issue) { return issue.code === 'FULFILLMENT_REFERENCE_INVALID' && issue.path.includes('required_slot_refs'); }));
});

test('核心边端点约束（对齐 ontology edge_type_definitions）', () => {
  const byType = {};
  template.edge_types.forEach(function (et) { byType[et.type] = et; });
  assert.deepEqual(byType.has_leaf_intent.source_types, ['AGGREGATE_INTENT']);
  assert.deepEqual(byType.has_leaf_intent.target_types, ['INTENT']);
  assert.deepEqual(byType.has_business_object.source_types, ['AGGREGATE_INTENT']);
  assert.deepEqual(byType.has_business_object.target_types, ['BUSINESS_OBJECT']);
  assert.deepEqual(byType.acts_on_object.source_types, ['INTENT']);
  assert.deepEqual(byType.acts_on_object.target_types, ['BUSINESS_OBJECT']);
  assert.deepEqual(byType.uses_action.source_types, ['INTENT']);
  assert.deepEqual(byType.uses_action.target_types, ['ACTION']);
  assert.deepEqual(byType.requires_slot.target_types, ['SLOT']);
  assert.deepEqual(byType.has_state_constraint.target_types, ['STATE']);
  assert.deepEqual(byType.has_risk_constraint.target_types, ['RISK']);
  assert.deepEqual(byType.has_knowledge_answer.target_types, ['KNOWLEDGE_ANSWER']);
  assert.deepEqual(byType.references.source_types, ['KNOWLEDGE_ANSWER']);
  assert.deepEqual(byType.clarify_to.source_types, ['AGGREGATE_INTENT']);
  assert.deepEqual(byType.confusable_with.target_types, ['INTENT']);
});

test('layout 声明：组织树默认 + 双树边层级（has_leaf_intent/is_child_of 各自父端）', () => {
  assert.equal(template.layout.default_layout, 'tree');
  assert.deepEqual(template.layout.tree_edges, [
    { type: 'has_leaf_intent', parent: 'source' },
    { type: 'is_child_of', parent: 'target' },
  ]);
  assert.equal(template.layout.initial_collapse_depth, 2);
});

test('层级组织：总根「手机银行」→ 2 个领域根 → 50 个聚合意图（is_child_of 52 条）', () => {
  const aggs = template.starter_graph.nodes.filter(function (n) { return n.type === 'AGGREGATE_INTENT'; });
  const byId = {};
  aggs.forEach(function (n) { byId[n.id] = n.properties.name; });
  const hier = template.starter_graph.edges.filter(function (e) { return e.type === 'is_child_of'; });
  assert.equal(hier.length, 52);
  // 2 条领域根边：转账汇款/理财 → 同一总根
  const domainEdges = hier.filter(function (e) { return byId[e.source] === '转账汇款' || byId[e.source] === '理财'; });
  assert.equal(domainEdges.length, 2);
  const rootIds = new Set(domainEdges.map(function (e) { return e.target; }));
  assert.equal(rootIds.size, 1);
  const root = aggs.find(function (n) { return rootIds.has(n.id); });
  assert.equal(root.properties.name, '手机银行');
  // 50 条聚合意图边挂到对应领域根（转账域→转账汇款、理财域→理财）
  const aggEdges = hier.filter(function (e) { return byId[e.source] !== '转账汇款' && byId[e.source] !== '理财'; });
  assert.equal(aggEdges.length, 50);
  const rootNames = new Set();
  aggEdges.forEach(function (e) { rootNames.add(byId[e.target]); });
  assert.deepEqual([...rootNames].sort(), ['理财', '转账汇款']);
  aggEdges.forEach(function (e) {
    const src = aggs.find(function (n) { return n.id === e.source; });
    assert.ok(src, '层级边源必须是聚合意图');
    const expectRoot = src.properties.domain === '转账服务' ? '转账汇款' : '理财';
    assert.equal(byId[e.target], expectRoot);
  });
});

test('starter_graph 为真实两领域子图且过 X6 校验器（发布门禁同款）', () => {
  const nodes = template.starter_graph.nodes;
  const edges = template.starter_graph.edges;
  // 规模：真实数据非手工示例（转账汇款 + 纯理财）
  assert.ok(nodes.length >= 350, '节点数 ' + nodes.length);
  assert.ok(edges.length >= 780, '边数 ' + edges.length);
  // 领域聚焦：转账服务全量 17 聚合 + 财富管理理财线 58 聚合，不含代发工资/外汇/保险
  const aggs = nodes.filter(function (n) { return n.type === 'AGGREGATE_INTENT'; });
  assert.equal(aggs.filter(function (n) { return n.properties.domain === '转账服务'; }).length, 17);
  assert.equal(aggs.filter(function (n) { return n.properties.domain === '财富管理'; }).length, 35);
  const names = aggs.map(function (n) { return n.properties.name; });
  ['代发工资', '保险', '购买基金', '存款', '积存贵金属'].forEach(function (bad) {
    assert.ok(names.indexOf(bad) < 0, '不应包含' + bad);
  });
  // 两领域覆盖
  const domains = {};
  nodes.forEach(function (n) {
    const d = n.properties && n.properties.domain;
    if (d) domains[d] = true;
  });
  assert.ok(domains['转账服务'], '含转账汇款领域');
  assert.ok(domains['财富管理'], '含金融理财领域');
  // 意图类型分布（六型枚举内）
  const types = {};
  nodes.filter(function (n) { return n.type === 'INTENT'; }).forEach(function (n) {
    types[n.properties.intent_type] = (types[n.properties.intent_type] || 0) + 1;
  });
  Object.keys(types).forEach(function (t) {
    assert.ok(['ASK', 'QUERY', 'DO', 'CHANGE', 'CANCEL', 'HELP'].indexOf(t) >= 0, '非法意图类型 ' + t);
  });
  // 运行边界节点（idle_chat）在场
  assert.ok(nodes.some(function (n) { return n.type === 'RUNTIME_BOUNDARY'; }));
  const result = validateGraph(template, template.starter_graph);
  assert.equal(result.valid, true, JSON.stringify(result.errors && result.errors.slice(0, 3)));
});
