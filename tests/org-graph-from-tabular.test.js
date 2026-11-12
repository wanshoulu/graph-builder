/**
 * org-graph from-tabular 路由层单测（routes/org-graph.js handleOrgGraphRequest）
 * POST /api/org-graph/from-tabular：CSV → 图谱文档 + 双关校验 + stats
 * 用法: node --test tests/org-graph-from-tabular.test.js
 */
'use strict';

process.env.SKIP_AUTH = 'true';

const test = require('node:test');
const assert = require('node:assert/strict');
const { handleOrgGraphRequest } = require('../routes/org-graph');

function mockReq(method, url, body) {
  return {
    method: method,
    url: url,
    headers: { host: 'localhost' },
    on: function (event, callback) {
      if (event === 'data') {
        if (body !== undefined) process.nextTick(function () { callback(Buffer.from(JSON.stringify(body), 'utf8')); });
        return;
      }
      if (event === 'end') {
        process.nextTick(callback);
        return;
      }
      if (event === 'error') return;
    },
  };
}

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    writeHead: function (code) { this.statusCode = code; },
    end: function (data) { this.body = data; },
  };
}

function call(pathname, body) {
  const res = mockRes();
  const handled = handleOrgGraphRequest(mockReq('POST', pathname, body), res);
  assert.equal(handled, true, '路由应被 org-graph 处理');
  return new Promise(function (resolve) {
    setTimeout(function () {
      const parsed = JSON.parse(res.body || '{}');
      resolve({ statusCode: res.statusCode, body: parsed });
    }, 30);
  });
}

const CSV = [
  '机构名称,行业,产品名称,产品类型',
  '示例银行,银行业,稳健理财一年期,R2',
].join('\n');

test('from-tabular：CSV → 文档 + 双关校验通过 + stats', async () => {
  const result = await call('/api/org-graph/from-tabular', {
    asset: 'finance-knowledge',
    format: 'csv',
    content: CSV,
    nodeMappings: [
      { nodeType: 'FIN_ORG', nameColumn: '机构名称', fieldMap: { industry: '行业' } },
      { nodeType: 'FIN_PRODUCT', nameColumn: '产品名称', fieldMap: { category: '产品类型' } },
    ],
    edgeMappings: [
      { edgeType: 'PROVIDES', sourceNodeType: 'FIN_ORG', targetNodeType: 'FIN_PRODUCT', sourceColumn: '机构名称', targetColumn: '产品名称' },
    ],
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.success, true);
  const data = result.body.data;
  assert.equal(data.stats.nodeCount, 2);
  assert.equal(data.stats.edgeCount, 1);
  assert.equal(data.document.nodes.length, 2);
  assert.equal(data.document.edges.length, 1);
  assert.equal(data.document.asset_id, 'finance-knowledge');
  // 双关校验（资产骨架校验器 + X6 模板校验器）
  assert.equal(data.validation.asset.valid, true, JSON.stringify(data.validation.asset.errors));
  assert.equal(data.validation.template.valid, true, JSON.stringify(data.validation.template.errors));
});

test('from-tabular：显式未知资产 ID 返回 404，不回退默认图谱', async () => {
  const unknown = await call('/api/org-graph/from-tabular', {
    asset: 'no-such-asset',
    format: 'csv',
    content: 'name\nexample',
    nodeMappings: [{ nodeType: 'EMPLOYEE', nameColumn: 'name' }],
  });
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.body.error.code, 'ORG_GRAPH_ASSET_NOT_FOUND');
});

test('from-tabular：缺 content / mappings 报错', async () => {
  const missingContent = await call('/api/org-graph/from-tabular', {
    asset: 'finance-knowledge',
    format: 'csv',
    nodeMappings: [{ nodeType: 'FIN_ORG', nameColumn: '机构名称' }],
  });
  assert.equal(missingContent.statusCode, 400);
  assert.equal(missingContent.body.error.code, 'ORG_GRAPH_TABULAR_CONTENT_REQUIRED');

  const missingMappings = await call('/api/org-graph/from-tabular', {
    asset: 'finance-knowledge',
    format: 'csv',
    content: '机构名称\n示例银行',
  });
  assert.equal(missingMappings.statusCode, 400);
  assert.equal(missingMappings.body.error.code, 'ORG_GRAPH_TABULAR_MAPPINGS_REQUIRED');
});

test('from-tabular：模板未声明节点类型 → stats.errors 记录且文档可建', async () => {
  const result = await call('/api/org-graph/from-tabular', {
    asset: 'generic-knowledge',
    format: 'csv',
    content: '名称\n示例实体',
    nodeMappings: [{ nodeType: 'NOT_A_TYPE', nameColumn: '名称' }],
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.success, true);
  assert.ok(result.body.data.stats.errors.length >= 1);
  assert.equal(result.body.data.stats.errors[0].code, 'TABULAR_NODE_TYPE_UNKNOWN');
});
