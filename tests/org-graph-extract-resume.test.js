/**
 * 抽取断点续跑单测：digest 确定性 / checkpoint 读写 + TTL 清理 / extractFromDocsResumable
 * （completed 复用不烧 LLM、失败块显式上报、onDocDone 逐块回调）
 * 用法: node --test tests/org-graph-extract-resume.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  buildExtractDigest,
  readExtractCheckpoint,
  upsertExtractCheckpoint,
  pruneExtractCache,
  getExtractProgress,
  setExtractProgress,
} = require('../routes/org-graph');
const { GraphExtractor } = require('../tools/graph-extractor');

function tmpAsset() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-cache-test-'));
  return { draftPath: path.join(dir, 'drafts', 'draft.json'), dir };
}

test('buildExtractDigest: 同输入同摘要，asset/内容/块数任一变化摘要变化', () => {
  const d1 = buildExtractDigest('org-people', '同一份内容', 10);
  assert.equal(d1, buildExtractDigest('org-people', '同一份内容', 10));
  assert.notEqual(d1, buildExtractDigest('finance-knowledge', '同一份内容', 10));
  assert.notEqual(d1, buildExtractDigest('org-people', '另一份内容', 10));
  assert.notEqual(d1, buildExtractDigest('org-people', '同一份内容', 20));
  assert.match(d1, /^[0-9a-f]{40}$/);
});

test('checkpoint: 首次读取为 null，逐块 upsert 后读回 entities/relations 完整', () => {
  const a = tmpAsset();
  const digest = buildExtractDigest('org-people', '内容A', 10);
  assert.equal(readExtractCheckpoint(a, digest), null);
  upsertExtractCheckpoint(a, digest, { total: 3, docId: 'doc#chunk1', entities: [{ name: '张伟', type: '人物' }], relations: [] });
  upsertExtractCheckpoint(a, digest, { total: 3, docId: 'doc#chunk2', entities: [], relations: [{ source: '张伟', type: '参与', target: '手机银行' }] });
  const cp = readExtractCheckpoint(a, digest);
  assert.ok(cp, 'checkpoint 应可读回');
  assert.equal(cp.total, 3);
  assert.equal(Object.keys(cp.docs).length, 2);
  assert.deepEqual(cp.docs['doc#chunk1'].entities, [{ name: '张伟', type: '人物' }]);
  assert.deepEqual(cp.docs['doc#chunk2'].relations, [{ source: '张伟', type: '参与', target: '手机银行' }]);
  assert.ok(cp.updatedAt);
});

test('pruneExtractCache: 只清理超过 TTL 的缓存文件，新鲜文件保留', () => {
  const a = tmpAsset();
  const old = upsertExtractCheckpoint(a, buildExtractDigest('x', '旧内容', 10), { total: 1, docId: 'c1', entities: [], relations: [] });
  const freshFile = upsertExtractCheckpoint(a, buildExtractDigest('x', '新内容', 10), { total: 1, docId: 'c1', entities: [], relations: [] });
  void old; void freshFile;
  const cacheDir = path.join(a.dir, 'drafts', 'extract-cache');
  const files = fs.readdirSync(cacheDir).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 2);
  // 把第一个文件 mtime 拨回 8 天前（超过 7 天 TTL）
  const oldTime = new Date(Date.now() - 8 * 24 * 3600 * 1000);
  fs.utimesSync(path.join(cacheDir, files[0]), oldTime, oldTime);
  const pruned = pruneExtractCache(a);
  assert.equal(pruned, 1);
  assert.equal(fs.readdirSync(cacheDir).filter((f) => f.endsWith('.json')).length, 1);
});

test('extractFromDocsResumable: completed 命中的块不烧 LLM（resumed 计数），其余块逐块抽取并回调', async () => {
  const extractor = new GraphExtractor({});
  let llmCalls = 0;
  const doneIds = [];
  extractor._callLLM = async () => { llmCalls += 1; return '{}'; };
  extractor._parseExtractionResult = (out, batch) => ({
    entities: batch.map((d) => ({ name: '实体-' + d.id, type: 'CONCEPT', sourceDoc: d.id })),
    relations: [],
  });
  const docs = [
    { id: 'f#chunk1', title: 'c1', content: 'a' },
    { id: 'f#chunk2', title: 'c2', content: 'b' },
    { id: 'f#chunk3', title: 'c3', content: 'c' },
  ];
  const result = await extractor.extractFromDocsResumable(docs, {
    gleaning: false,
    completed: { 'f#chunk1': { entities: [{ name: '缓存实体', type: 'CONCEPT' }], relations: [] } },
    onDocDone: (id) => doneIds.push(id),
  });
  assert.equal(llmCalls, 2, '只有 2 个未完成块调用 LLM');
  assert.equal(result.resumed, 1);
  assert.deepEqual(doneIds, ['f#chunk2', 'f#chunk3']);
  const names = result.entities.map((e) => e.name);
  assert.ok(names.includes('缓存实体'), '缓存实体应并入结果');
  assert.ok(names.includes('实体-f#chunk2') && names.includes('实体-f#chunk3'));
});

test('extractFromDocsResumable: 单块失败显式进 failedDocs（不再静默吞错），成功块照常回调', async () => {
  const extractor = new GraphExtractor({});
  extractor._callLLM = async (prompt) => {
    if (prompt.includes('f#chunk2')) throw new Error('LLM 超时');
    return '{}';
  };
  extractor._parseExtractionResult = (out, batch) => ({ entities: batch.map((d) => ({ name: 'E-' + d.id, type: 'CONCEPT', sourceDoc: d.id })), relations: [] });
  const doneIds = [];
  const result = await extractor.extractFromDocsResumable([
    { id: 'f#chunk1', title: 'c1', content: 'a' },
    { id: 'f#chunk2', title: 'c2', content: 'b' },
  ], { gleaning: false, onDocDone: (id) => doneIds.push(id) });
  assert.equal(result.failedDocs.length, 1);
  assert.equal(result.failedDocs[0].id, 'f#chunk2');
  assert.match(result.failedDocs[0].error, /LLM 超时/);
  assert.deepEqual(doneIds, ['f#chunk1']);
  assert.equal(result.entities.length, 1);
});

test('extractFromDocsResumable: 全部块失败时 failedDocs 覆盖全部且 entities 为空', async () => {
  const extractor = new GraphExtractor({});
  extractor._callLLM = async () => { throw new Error('网络不可达'); };
  extractor._parseExtractionResult = () => ({ entities: [], relations: [] });
  const result = await extractor.extractFromDocsResumable([
    { id: 'a1', title: 'a', content: 'x' },
    { id: 'a2', title: 'b', content: 'y' },
  ], { gleaning: false });
  assert.equal(result.failedDocs.length, 2);
  assert.equal(result.entities.length, 0);
});

test('extract-progress: set/get 往返，未知 jobId 返回 null', () => {
  setExtractProgress('job-1', 3, 10);
  assert.deepEqual(getExtractProgress('job-1'), { completed: 3, total: 10, updatedAt: getExtractProgress('job-1').updatedAt });
  assert.equal(getExtractProgress('no-such-job'), null);
});
