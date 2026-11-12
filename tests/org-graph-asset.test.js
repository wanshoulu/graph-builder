/**
 * org-graph 资产化单测（routes/org-graph.js resolveAsset）
 * 默认分支 = org-people 原路径（零回归）；customer-ecosystem 独立目录隔离。
 * 用法: node --test tests/org-graph-asset.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { resolveAsset, listAssets, graphDocumentDigest } = require('../routes/org-graph');

const ORG_STORAGE = path.join(__dirname, '..', 'data', 'graphs', 'org');

test('resolveAsset 默认分支 = org-people 原路径（零行为变化）', () => {
  const def = resolveAsset(undefined);
  assert.equal(def.storageDir, ORG_STORAGE);
  assert.equal(def.manifestPath, path.join(ORG_STORAGE, 'org-graph-manifest.json'));
  assert.equal(def.draftPath, path.join(ORG_STORAGE, 'drafts', 'org-graph-draft.json'));
  assert.equal(def.templatePath, path.join(__dirname, '..', 'data', 'graph-builder-templates', 'org-people.json'));
  assert.equal(typeof def.validateDocument, 'function');
  assert.throws(
    () => resolveAsset('no-such-asset'),
    (error) => error && error.code === 'ORG_GRAPH_ASSET_NOT_FOUND' && error.statusCode === 404,
  );
});

test('customer-ecosystem 独立存储目录 + 专属模板/校验器/schema', () => {
  const cust = resolveAsset('customer-ecosystem');
  assert.equal(cust.storageDir, path.join(ORG_STORAGE, 'customer'));
  assert.equal(cust.manifestPath, path.join(ORG_STORAGE, 'customer', 'org-graph-manifest.json'));
  assert.equal(cust.draftPath, path.join(ORG_STORAGE, 'customer', 'drafts', 'org-graph-draft.json'));
  assert.equal(cust.templatePath, path.join(__dirname, '..', 'data', 'graph-builder-templates', 'customer-ecosystem.json'));
  assert.notEqual(cust.storageDir, resolveAsset('org-people').storageDir, '两资产存储隔离');
  assert.notEqual(cust.validateDocument, resolveAsset('org-people').validateDocument, '两资产校验器不同');
  // 抽取 schema：员工域与客户域实体类型互斥
  assert.deepEqual(Object.keys(cust.entityTypes), ['CUSTOMER', 'PERSON']);
  assert.deepEqual(Object.keys(resolveAsset('org-people').entityTypes), ['EMPLOYEE', 'DEPARTMENT', 'PROJECT']);
  assert.deepEqual(Object.keys(cust.relationTypes), ['WORK_FOR', 'SUBSIDIARY', 'SUPPLIER', 'DISTRIBUTOR', 'DOWNSTREAM_CUSTOMER', 'SIBLING']);
});

test('generateRules：两资产均注入模板无法表达的业务规则（LLM 生成 prompt 挂载点）', () => {
  const org = resolveAsset('org-people');
  const cust = resolveAsset('customer-ecosystem');
  assert.ok(Array.isArray(org.generateRules) && org.generateRules.length >= 2);
  assert.ok(org.generateRules.some((r) => r.includes('REPORTS_TO')));
  assert.ok(Array.isArray(cust.generateRules) && cust.generateRules.length >= 2);
  assert.ok(cust.generateRules.some((r) => r.includes('isBankCustomer')));
});

test('listAssets：注册制枚举（左导航数据源），字段完整 + 逐资产容错', () => {
  const assets = listAssets();
  assert.ok(assets.length >= 2, '至少两资产');
  const org = assets.find((a) => a.assetId === 'org-people');
  const cust = assets.find((a) => a.assetId === 'customer-ecosystem');
  assert.ok(org && cust, '两资产均在枚举中');
  // 字段完整
  [org, cust].forEach((a) => {
    assert.equal(typeof a.name, 'string');
    assert.equal(typeof a.templateId, 'string');
    assert.equal(typeof a.templateVersion, 'string');
    assert.ok(Array.isArray(a.nodeTypes) && a.nodeTypes.length > 0);
    assert.ok(Array.isArray(a.edgeTypes) && a.edgeTypes.length > 0);
    assert.equal(typeof a.hasPublished, 'boolean');
  });
  // 内容正确（模板真实值）
  assert.equal(org.templateId, 'org-people');
  assert.ok(org.nodeTypes.includes('EMPLOYEE'));
  assert.ok(org.edgeTypes.includes('REPORTS_TO'));
  assert.equal(cust.templateId, 'customer-ecosystem');
  assert.ok(cust.nodeTypes.includes('CUSTOMER'));
  assert.ok(cust.edgeTypes.includes('WORK_FOR'));
});

test('graphDocumentDigest：稳定摘要忽略发布时间等易变元数据', () => {
  const first = {
    metadata: { updated_at: '2026-09-08T10:00:00Z', published_at: '2026-09-08T10:01:00Z', owner: 'team-a' },
    nodes: [{ id: 'n1', type: 'INTENT', properties: { name: '查余额', priority: 1 } }],
    edges: [],
  };
  const second = {
    edges: [],
    nodes: [{ properties: { priority: 1, name: '查余额' }, type: 'INTENT', id: 'n1' }],
    metadata: { owner: 'team-a', published_at: '2026-09-08T11:01:00Z', updated_at: '2026-09-08T11:00:00Z' },
  };

  assert.match(graphDocumentDigest(first), /^sha256:[a-f0-9]{64}$/);
  assert.equal(graphDocumentDigest(first), graphDocumentDigest(second));
});
