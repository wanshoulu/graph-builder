/**
 * V4.1 构建文档 → intentTree 服务端桥单测（auto-build 图谱直达银行运行时的关键桥）
 * 映射规则与前端 lib/intentGraphV4.ts graphDocumentToV4() 一一对应，本测试锁定后端侧契约。
 * 用法: node --test tests/org-graph-v41-bridge.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { builderDocumentToV41, computeV41Digest, canonicalJson } = require('../services/graph-conversion/intent-graph-v41-bridge');

function sampleDoc() {
  return {
    document_id: 'graph-v4-test',
    document_version: '2.0.0',
    nodes: [
      { id: 'ccb', type: 'ROOT', properties: { title: '建设银行手机银行', node_role: 'root' } },
      { id: 'ccb.credit', type: 'DOMAIN', properties: { title: '信用卡', menu: '信用卡' } },
      { id: 'ccb.credit.apply', type: 'CATEGORY', properties: { title: '申请信用卡' } },
      { id: 'ccb.credit.apply.online', type: 'LEAF', properties: {
        title: '在线申请',
        scope_in: ['信用卡申请'],
        scope_out: ['境外卡'],
        navigation_terms: ['办卡'],
        menu: '信用卡/办卡',
        business_objects: ['信用卡'],
        policies: ['pol.1'],
        observability: '{"trace":"on"}',
        scenes: JSON.stringify([
          { scene_type: 'DO', semantic_definition: { description: '在线填写资料申请信用卡' }, retrieval_profile: { aliases: ['网申信用卡', '在线办卡', '申请信用卡'] } },
        ]),
        lifecycle: 'active',
      } },
      { id: 'ccb.credit.apply.web', type: 'LEAF', properties: { title: 'Web 申请', scenes: '[]' } },
    ],
    edges: [
      { id: 'e1', type: 'has_child', source: 'ccb', target: 'ccb.credit' },
      { id: 'e2', type: 'has_child', source: 'ccb.credit', target: 'ccb.credit.apply' },
      { id: 'e3', type: 'has_child', source: 'ccb.credit.apply', target: 'ccb.credit.apply.online' },
      { id: 'e3b', type: 'has_child', source: 'ccb', target: 'ccb.credit.apply.online' }, // 多父：首边生效
      { id: 'e4', type: 'same_as', source: 'ccb.credit.apply.online', target: 'ccb.credit.apply.web', properties: { scene: '在线申请', weight: 2, status: 'active' } },
    ],
    metadata: { v4ResourceRegistries: { capabilities: [{ id: 'cap.x' }], faqs: [], policies: [], skillBindings: [{ id: 'sb.1' }] } },
  };
}

test('builderDocumentToV41: 层级/路径/深度/角色完整映射（V4GraphAdapter 消费字段全齐）', () => {
  const v4 = builderDocumentToV41(sampleDoc());
  assert.equal(v4.schemaVersion, '4.1');
  const byId = new Map(v4.intentTree.map((n) => [n.id, n]));
  assert.equal(v4.intentTree.length, 5);
  assert.equal(byId.get('ccb').node_role, 'root');
  assert.equal(byId.get('ccb').parent_intent_id, null);
  assert.equal(byId.get('ccb.credit').parent_intent_id, 'ccb');
  assert.equal(byId.get('ccb.credit.apply.online').parent_intent_id, 'ccb.credit.apply');
  assert.equal(
    byId.get('ccb.credit.apply.online').path,
    '建设银行手机银行/信用卡/申请信用卡/在线申请',
    'path 沿父链 title 以 / 连接',
  );
  assert.equal(byId.get('ccb.credit.apply.online').depth, 3);
  assert.deepEqual(byId.get('ccb.credit.apply.online').scope_in, ['信用卡申请']);
  assert.deepEqual(byId.get('ccb.credit.apply.online').scope_out, ['境外卡']);
  assert.deepEqual(byId.get('ccb.credit.apply.online').navigationTerms, ['办卡']);
});

test('builderDocumentToV41: scenes JSON 字符串解析、bindings 派生、root 不带 bindings', () => {
  const v4 = builderDocumentToV41(sampleDoc());
  const byId = new Map(v4.intentTree.map((n) => [n.id, n]));
  const leaf = byId.get('ccb.credit.apply.online');
  assert.equal(leaf.scenes.length, 1);
  assert.equal(leaf.scenes[0].scene_type, 'DO');
  assert.deepEqual(leaf.scenes[0].retrieval_profile.aliases, ['网申信用卡', '在线办卡', '申请信用卡']);
  assert.deepEqual(leaf.bindings.menu, { path: '信用卡/办卡' });
  assert.deepEqual(leaf.bindings.businessObjects, ['信用卡']);
  assert.deepEqual(leaf.bindings.policies, ['pol.1']);
  assert.deepEqual(leaf.observability, { trace: 'on' });
  assert.equal(byId.get('ccb').bindings, undefined, 'root 不输出 bindings');
  // 空 scenes 数组 → 不带 scenes 键
  assert.equal(byId.get('ccb.credit.apply.web').scenes, undefined);
});

test('builderDocumentToV41: 横切关系带 #场景 后缀与关系 id 规则；registries/digest 透出', () => {
  const v4 = builderDocumentToV41(sampleDoc());
  assert.equal(v4.relations.length, 1);
  const rel = v4.relations[0];
  assert.equal(rel.from, 'ccb.credit.apply.online#在线申请');
  assert.equal(rel.to, 'ccb.credit.apply.web');
  assert.equal(rel.id, 'rel.ccb.credit.apply.online#在线申请.same_as.ccb.credit.apply.web');
  assert.equal(rel.weight, 2);
  assert.deepEqual(v4.resourceRegistries.capabilities, [{ id: 'cap.x' }]);
  assert.deepEqual(v4.resourceRegistries.skillBindings, [{ id: 'sb.1' }]);
  assert.match(v4.digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(v4.appSurface, 'mock-mobile-bank', '服务端桥缺省对齐银行运行时');
});

test('builderDocumentToV41: 非法 scenes JSON 丢弃不炸；has_child 环安全终止', () => {
  const doc = sampleDoc();
  doc.nodes[3].properties.scenes = '{broken json';
  const e5 = { id: 'e5', type: 'has_child', source: 'ccb.credit.apply.online', target: 'ccb.credit.apply' };
  doc.edges.push(e5); // 构造环
  const v4 = builderDocumentToV41(doc);
  const leaf = v4.intentTree.find((n) => n.id === 'ccb.credit.apply.online');
  assert.equal(leaf.scenes, undefined, '非法 scenes JSON 被丢弃');
  assert.ok(leaf.path.length > 0, '环存在时 path 仍可终止派生');
});

test('computeV41Digest/canonicalJson: 键排序稳定序列化，同内容同摘要、异内容异摘要', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [2, { c: 1 }] } }), '{"a":{"d":[2,{"c":1}]},"b":1}');
  const g1 = { intentTree: [{ id: 'x' }], relations: [], resourceRegistries: { capabilities: [] } };
  const g2 = { resourceRegistries: { capabilities: [] }, relations: [], intentTree: [{ id: 'x' }] };
  assert.equal(computeV41Digest(g1), computeV41Digest(g2), '键序无关');
  assert.notEqual(computeV41Digest(g1), computeV41Digest({ ...g1, intentTree: [{ id: 'y' }] }));
});

test('发布链路接线：publish-v4-to-runtime 对 V4.1 构建文档自动桥接（源码锚定）', () => {
  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'org-graph.js'), 'utf8');
  assert.match(route, /require\([^)]*intent-graph-v41-bridge'\)/, '桥接模块必须被路由引用');
  assert.match(route, /v4Doc = builderDocumentToV41\(v4Doc\)/, '缺 intentTree 且有 nodes 时必须自动桥接');
  assert.match(route, /不是可桥接的 V4\.1 构建文档/, '既无 intentTree 又无 nodes 才允许报格式错');
  assert.match(route, /发布到运行时会自动桥接转换为 intentTree/, 'pipeline-status 对 V4.1 草稿降级为 warning 并说明桥接');
});
