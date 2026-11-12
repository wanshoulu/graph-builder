/**
 * 知识导入（knowledge-intake）→ intent-graph 模板校验契约测试
 *
 * 目的：锁死「入图写入端」与「图谱模板 Schema」的契约。
 * 历史教训：intake V4.1 段曾写出模板不认识的 CAPABILITY 节点/大写边（REQUIRES_SLOT 等）、
 * scenes 写成对象数组而模板声明 multiline（JSON 字符串）、fulfillment_kind 触发条件必填却无对应字段，
 * 导致业务人员任何含新意图的批次都卡在入图校验（详见 2026-09-26 可操作性分析报告）。
 *
 * 契约：applyToIntakeDocument 的输出喂给 validateGraph 必须 0 error（warning 允许）。
 * 模板或写入端任何一侧改动，若破坏契约，本测试立即报警。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { applyToIntakeDocument, rollbackFromDocument } = require('../routes/knowledge-intake');
const { validateGraph } = require('../tools/x6-graph-template-validator');

const TEMPLATE_PATH = path.join(__dirname, '..', 'data', 'graph-builder-templates', 'intent-graph.json');
const template = JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf8'));

function baseGraphDoc() {
  return {
    nodes: [
      { id: 'agg:root:wealth', type: 'AGGREGATE_INTENT', properties: { name: '财富管理', domain: '财富管理' } },
    ],
    edges: [],
  };
}

// 覆盖全部交付形态/执行模式的意图行：answer(话术)、skill(confirm-required)、query(read-execute)、menu(跳转)、
// 以及不带任何执行信息的裸查询（回落 confirm-required → requires_confirmation 路径）
function fullCoverageApproved() {
  return {
    functions: [
      { rowId: 'f-1', path: '财富管理/账户查询', name: '账户查询', description: '查询本人账户余额、明细与持仓的服务' },
    ],
    intents: [
      { rowId: 'i-1', ref: '财富管理/账户查询/查询账户余额', name: '查询账户余额', funcPath: '财富管理/账户查询', intentType: '查询', description: '客户询问账户余额时的查询意图', answerForm: '话术答复' },
      { rowId: 'i-2', ref: '财富管理/账户查询/办理定期存款', name: '办理定期存款', funcPath: '财富管理/账户查询', intentType: '办理', description: '客户办理整存整取定期存款的意图', executionMode: 'confirm-required-确认后执行', requiredSlots: '存期,金额', capabilityBindings: '定期开户接口', confusableIntents: '查询账户余额' },
      { rowId: 'i-3', ref: '财富管理/账户查询/查询交易明细', name: '查询交易明细', funcPath: '财富管理/账户查询', intentType: '查询', description: '客户查询交易流水的意图', executionMode: 'read-execute-读执行', answerForm: '数据卡片', requiredSlots: '时间范围' },
      { rowId: 'i-4', ref: '财富管理/账户查询/跳转手机银行', name: '跳转手机银行', funcPath: '财富管理/账户查询', intentType: '查询', description: '跳转手机银行相关页面的意图', answerForm: '跳转办理' },
      { rowId: 'i-5', ref: '财富管理/账户查询/咨询理财风险', name: '咨询理财风险', funcPath: '财富管理/账户查询', intentType: '咨询', description: '客户咨询理财产品风险等级的意图' },
    ],
    utterances: [
      { rowId: 'u-1', intentRef: '财富管理/账户查询/查询账户余额', kind: '标问', text: '查询账户余额' },
      { rowId: 'u-2', intentRef: '财富管理/账户查询/查询账户余额', kind: '扩展问', text: '我卡里还有多少钱' },
      { rowId: 'u-3', intentRef: '财富管理/账户查询/办理定期存款', kind: '标问', text: '办理定期存款' },
      { rowId: 'u-4', intentRef: '财富管理/账户查询/查询交易明细', kind: '标问', text: '查询交易明细' },
      { rowId: 'u-5', intentRef: '财富管理/账户查询/跳转手机银行', kind: '标问', text: '跳转手机银行' },
      { rowId: 'u-6', intentRef: '财富管理/账户查询/咨询理财风险', kind: '标问', text: '咨询理财风险' },
    ],
  };
}

function assertZeroTemplateErrors(document, label) {
  const result = validateGraph(template, document);
  const errorLines = result.errors.map((e) => e.code + ': ' + e.message + ' @ ' + (e.path || '')).join('\n  ');
  assert.ok(result.valid, label + ' 应通过模板校验，实际 errors:\n  ' + errorLines);
  return result;
}

test('契约：全交付形态/执行模式混合批次入图后 0 校验错误', () => {
  const { document, stats } = applyToIntakeDocument(baseGraphDoc(), fullCoverageApproved(), 'ki-contract-1', '2026-09-26T00:00:00Z');
  assert.equal(stats.intentsCreated, 5);
  assert.equal(stats.skipped.length, 0);
  assertZeroTemplateErrors(document, '全形态批次');
});

test('契约：scenes 落地为 JSON 字符串（模板 multiline），内容可反序列化', () => {
  const { document } = applyToIntakeDocument(baseGraphDoc(), fullCoverageApproved(), 'ki-contract-2', '2026-09-26T00:00:00Z');
  const intent = document.nodes.find((n) => n.properties.name === '查询账户余额');
  assert.equal(typeof intent.properties.scenes, 'string', 'scenes 必须是字符串（模板 multiline）');
  const scenes = JSON.parse(intent.properties.scenes);
  assert.ok(Array.isArray(scenes) && scenes.length >= 1, 'scenes 可反序列化为非空数组');
  assert.ok(scenes[0].intentType && scenes[0].userGoal, '场景块含 intentType/userGoal');
});

test('契约：fulfillment_kind=answer 时必须带 answer_text', () => {
  const { document } = applyToIntakeDocument(baseGraphDoc(), fullCoverageApproved(), 'ki-contract-3', '2026-09-26T00:00:00Z');
  const intent = document.nodes.find((n) => n.properties.name === '查询账户余额');
  assert.equal(intent.properties.fulfillment_kind, 'answer');
  assert.ok(String(intent.properties.answer_text || '').trim(), 'answer 交付必须有 answer_text 正文');
});

test('契约：confirm-required 必须落 requires_confirmation=true；query/menu/skill 各自 _ref 必填', () => {
  const { document } = applyToIntakeDocument(baseGraphDoc(), fullCoverageApproved(), 'ki-contract-4', '2026-09-26T00:00:00Z');
  const deposit = document.nodes.find((n) => n.properties.name === '办理定期存款');
  assert.equal(deposit.properties.requires_confirmation, true, 'confirm-required → requires_confirmation');
  assert.ok(deposit.properties.skill_ref, 'skill 交付必须有 skill_ref');

  const detail = document.nodes.find((n) => n.properties.name === '查询交易明细');
  assert.equal(detail.properties.fulfillment_kind, 'query');
  assert.ok(detail.properties.query_ref, 'query 交付必须有 query_ref');

  const nav = document.nodes.find((n) => n.properties.name === '跳转手机银行');
  assert.equal(nav.properties.fulfillment_kind, 'menu');
  assert.ok(nav.properties.menu_ref, 'menu 交付必须有 menu_ref');
});

test('契约：V4.1 槽位/易混只用模板类型（SLOT 节点带 data_type、requires_slot/confusable_with 小写边）', () => {
  const { document } = applyToIntakeDocument(baseGraphDoc(), fullCoverageApproved(), 'ki-contract-5', '2026-09-26T00:00:00Z');
  // 边类型必须在模板 edge_types 白名单内
  const edgeTypes = new Set(template.edge_types.map((e) => e.type));
  document.edges.forEach((e) => {
    assert.ok(edgeTypes.has(e.type), '边类型 ' + e.type + ' 必须在模板 edge_types 中');
  });
  // 节点类型必须在模板 node_types 白名单内（CAPABILITY 不允许再出现）
  const nodeTypes = new Set(template.node_types.map((n) => n.type));
  document.nodes.forEach((n) => {
    assert.ok(nodeTypes.has(n.type), '节点类型 ' + n.type + ' 必须在模板 node_types 中');
  });
  // SLOT 带必填 data_type
  const slots = document.nodes.filter((n) => n.type === 'SLOT');
  assert.ok(slots.length >= 3, '三个执行类意图共 3 个槽位');
  slots.forEach((s) => assert.ok(String(s.properties.data_type || '').trim(), 'SLOT ' + s.id + ' 缺 data_type'));
  // 易混边存在
  assert.ok(document.edges.some((e) => e.type === 'confusable_with'), 'confusable_with 边已建立');
  // 能力绑定进 capabilities tags 而非独立节点
  const deposit = document.nodes.find((n) => n.properties.name === '办理定期存款');
  assert.ok((deposit.properties.capabilities || []).includes('capability:定期开户接口'), '能力绑定落 capabilities tags');
});

test('契约：幂等重放仍 0 错误（重复 apply 不破坏模板校验）', () => {
  const first = applyToIntakeDocument(baseGraphDoc(), fullCoverageApproved(), 'ki-contract-6', '2026-09-26T00:00:00Z');
  const second = applyToIntakeDocument(first.document, fullCoverageApproved(), 'ki-contract-6', '2026-09-26T01:00:00Z');
  assert.equal(second.stats.intentsCreated, 0, '重放不新建意图');
  assertZeroTemplateErrors(second.document, '重放文档');
});

test('契约：基于 journal 的回滚后文档仍 0 校验错误', () => {
  const applied = applyToIntakeDocument(baseGraphDoc(), fullCoverageApproved(), 'ki-contract-7', '2026-09-26T00:00:00Z');
  const rolled = rollbackFromDocument(applied.document, applied.journal);
  assert.ok(rolled.removed.intents >= 5, '回滚移除本次新建意图');
  assertZeroTemplateErrors(rolled.document, '回滚后文档');
});

test('契约：模板校验对历史漂移输出仍然报警（防校验器被反向放松）', () => {
  // 手工构造漂移期写法：CAPABILITY 节点 + 大写边 + scenes 对象数组
  const bad = {
    nodes: [
      { id: 'agg:1', type: 'AGGREGATE_INTENT', properties: { name: '账户', domain: '账户' } },
      { id: 'intent:1', type: 'INTENT', properties: { name: '查询余额', intent_type: 'QUERY', domain: '账户', scenes: [{ intentType: 'QUERY', userGoal: 'x' }], fulfillment_kind: 'answer', execution_mode: 'confirm-required' } },
      { id: 'cap:1', type: 'CAPABILITY', properties: { name: 'x' } },
    ],
    edges: [
      { id: 'e:1', type: 'has_leaf_intent', source: 'agg:1', target: 'intent:1', properties: {} },
      { id: 'e:2', type: 'HANDLED_BY', source: 'intent:1', target: 'cap:1', properties: {} },
    ],
  };
  const result = validateGraph(template, bad);
  assert.equal(result.valid, false, '漂移期写法必须继续报错');
  const codes = new Set(result.errors.map((e) => e.code));
  assert.ok(codes.has('FIELD_TYPE_INVALID'), 'scenes 对象数组必须继续报类型错误');
  assert.ok(codes.has('EDGE_TYPE_UNKNOWN') || codes.has('NODE_TYPE_UNKNOWN'), 'CAPABILITY/HANDLED_BY 必须继续报类型未知');
});
