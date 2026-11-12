/**
 * org-graph 草稿历史 + 覆盖防线单测（2026-09-18 intent-graph 草稿被小图覆盖事故的防线）
 * 用法: node --test tests/org-graph-draft-history.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { saveDraft, loadDraft, listDraftHistory } = require('../routes/org-graph');

function makeAsset() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-draft-'));
  return { storageDir: dir, draftPath: path.join(dir, 'drafts', 'org-graph-draft.json') };
}
function doc(n, tag) {
  return {
    document_id: tag || 't',
    nodes: Array.from({ length: n }, (_, i) => ({ id: 'n' + i, type: 'T', properties: { name: 'node' + i } })),
    edges: [],
  };
}
function digestOf(a) {
  const d = loadDraft(a);
  return d ? d.nodes.length : -1;
}

test('首次保存不产生历史；内容变化覆盖时归档旧稿', () => {
  const a = makeAsset();
  saveDraft(doc(20, 'v1'), a, {});
  assert.equal(listDraftHistory(a).length, 0, '首存无历史');
  saveDraft(doc(22, 'v2'), a, {});
  const hist = listDraftHistory(a);
  assert.equal(hist.length, 1);
  assert.equal(hist[0].nodes, 20, '归档的是旧稿（20 节点）');
  assert.equal(digestOf(a), 22, '草稿已是新内容');
});

test('覆盖防线：新稿 < 原稿一半且原稿 ≥10 节点时拒绝（自动保存场景），原稿完好且已归档', () => {
  const a = makeAsset();
  saveDraft(doc(30, 'big'), a, {});
  assert.throws(
    () => saveDraft(doc(8, 'small'), a, {}),
    (e) => e.code === 'ORG_GRAPH_DRAFT_SHRINK_GUARD' && e.statusCode === 409,
  );
  assert.equal(digestOf(a), 30, '被拦截后草稿不被覆盖');
  const hist = listDraftHistory(a);
  assert.equal(hist.length, 1, '拦截前旧稿已归档');
  assert.equal(hist[0].nodes, 30);
});

test('force=true 放行骤减覆盖（手动保存场景），旧稿归档可回退', () => {
  const a = makeAsset();
  saveDraft(doc(30, 'big'), a, {});
  saveDraft(doc(8, 'small'), a, { force: true });
  assert.equal(digestOf(a), 8);
  const hist = listDraftHistory(a);
  assert.equal(hist.length, 1);
  assert.equal(hist[0].nodes, 30, '旧稿在历史里可恢复');
});

test('小草稿之间的正常覆盖不触发防线（<10 节点基线）；内容相同不归档', () => {
  const a = makeAsset();
  saveDraft(doc(5, 'a'), a, {});
  saveDraft(doc(2, 'b'), a, {}); // 原稿 5 < 10 基线，放行
  assert.equal(digestOf(a), 2);
  const before = listDraftHistory(a).length;
  saveDraft(doc(2, 'b'), a, {}); // 内容完全相同（updated_at 被忽略）→ 不归档
  assert.equal(listDraftHistory(a).length, before, '相同内容不产生新历史');
});

test('listDraftHistory 倒序排列且携带规模/大小字段；历史保留上限 30 份', () => {
  const a = makeAsset();
  saveDraft(doc(12, 'base'), a, {});
  for (let i = 0; i < 35; i += 1) {
    saveDraft(doc(12 + ((i % 7) + 1), 'v' + i), a, { force: true }); // 交错变化内容 + 强制放行
  }
  const hist = listDraftHistory(a);
  assert.equal(hist.length, 30, '只保留最近 30 份');
  assert.ok(hist[0].file >= hist[1].file, '文件名时间戳倒序');
  for (const item of hist) {
    assert.ok(item.nodes > 0 && item.edges === 0 && item.bytes > 0);
    assert.match(item.file, /^draft-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-\d{3}-[a-z0-9]{4}-\d+n\.json$/);
    assert.ok(!Number.isNaN(Date.parse(item.savedAt)), 'savedAt 是可解析时间');
  }
});

// ── 发布治理（2026-09-22 审计修复）：审批模式统一入口 + approve 路径 manifest 覆盖防线 ──
const { createPublishRequestFromDocument } = require('../routes/org-graph');

test('createPublishRequestFromDocument 固化快照挂请求（审批模式统一入口，替代 /publish 抛 400 死路）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-pr-'));
  const a = { storageDir: dir, manifestPath: path.join(dir, 'manifest.json') };
  const document = { document_id: 't', nodes: [{ id: 'n1', type: 'T', properties: {} }], edges: [] };
  const res = createPublishRequestFromDocument(document, '审批测试', a, 'asset-x');
  assert.equal(res.pendingApproval, true, '调用方据此提示「已提交审批」而非「已发布」');
  assert.equal(res.assetId, 'asset-x');
  assert.equal(res.request.status, 'pending');
  assert.equal(res.request.note, '审批测试');
  const manifest = JSON.parse(fs.readFileSync(a.manifestPath, 'utf8'));
  assert.equal(manifest.publishRequests.length, 1, '请求已挂入 manifest');
  assert.ok(fs.existsSync(path.join(dir, res.request.snapshotFile)), '快照文件已固化');
  assert.equal(manifest.auditLog.filter((x) => x.action === 'publish_requested').length, 1, '审计已记 publish_requested');
  // 非法内容拒绝
  assert.throws(
    () => createPublishRequestFromDocument(null, '', a, 'asset-x'),
    (e) => e.code === 'ORG_GRAPH_DOCUMENT_INVALID',
  );
  assert.throws(
    () => createPublishRequestFromDocument({ nodes: 'nope' }, '', a, 'asset-x'),
    (e) => e.code === 'ORG_GRAPH_DOCUMENT_INVALID',
  );
});
