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
  loadManifest,
  saveManifest,
  publishApprovalEnabled,
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

test('截断抢救：max_tokens 掐断的 JSON 能回收已完整闭合的实体/关系，全垃圾才 parseError', () => {
  const extractor = new GraphExtractor({});
  // 模拟截断：entities 数组前两个对象完整，第三个被拦腰切断
  const truncated = '{"entities": ['
    + '{"name": "手机银行", "type": "Concept", "description": "应用"},'
    + '{"name": "转账", "type": "Method", "confidence": 0.9},'
    + '{"name": "被截断的实';
  const parsed = extractor._parseExtractionResult(truncated, [{ id: 't#chunk1' }]);
  assert.equal(parsed.entities.length, 2, '完整闭合的两个实体被抢救');
  assert.equal(parsed.entities[0].name, '手机银行');
  assert.equal(parsed.salvaged, true, '带 salvaged 标记');
  assert.ok(!parsed.parseError, '抢救成功不算解析失败');
  // 关系截断：一个完整 relation + 半截
  const truncatedRel = '{"relations": ['
    + '{"source": "手机银行", "type": "INCLUDES", "target": "转账"},'
    + '{"source": "半截';
  const parsedRel = extractor._parseExtractionResult(truncatedRel, [{ id: 't#chunk1' }]);
  assert.equal(parsedRel.relations.length, 1);
  assert.equal(parsedRel.relations[0].type, 'INCLUDES');
  // 串内花括号/转义不干扰扫描（字符串里带 { } " 的实体名）
  const tricky = '{"entities": [{"name": "带}花括号{\\"的实体", "type": "Concept"}, {"name": "第二个", "type": "Concept"}';
  const parsedTricky = extractor._parseExtractionResult(tricky, [{ id: 't#chunk1' }]);
  assert.equal(parsedTricky.entities.length, 2, '字符串内嵌引号/花括号不破坏抢救');
  // 全垃圾（无任何完整子对象）→ parseError 标记
  const garbage = '{"entities": [{"name": "半截';
  const parsedBad = extractor._parseExtractionResult(garbage, [{ id: 't#chunk1' }]);
  assert.equal(parsedBad.entities.length, 0);
  assert.match(parsedBad.parseError, /LLM 输出无法解析为实体 JSON/);
});

test('截断抢救不写毒缓存：salvaged 结果经 onDocDone 正常入 checkpoint，parseError 不回调', async () => {
  const extractor = new GraphExtractor({});
  const outputs = [
    '{"entities": [{"name": "抢救实体", "type": "CONCEPT"}', // 截断 → 抢救 1 条
    '完全不是 JSON', // 全垃圾 → parseError
  ];
  let call = 0;
  extractor._callLLM = async () => outputs[call++];
  const doneIds = [];
  const result = await extractor.extractFromDocsResumable([
    { id: 's#chunk1', title: 'c1', content: 'a' },
    { id: 's#chunk2', title: 'c2', content: 'b' },
  ], { gleaning: false, onDocDone: (id) => doneIds.push(id) });
  assert.deepEqual(doneIds, ['s#chunk1'], '只有抢救成功的块回调');
  assert.equal(result.entities.length, 1);
  assert.equal(result.failedDocs.length, 1);
  assert.match(result.failedDocs[0].error, /解析失败/);
});

test('extract-progress: set/get 往返，未知 jobId 返回 null', () => {
  setExtractProgress('job-1', 3, 10);
  const p = getExtractProgress('job-1');
  assert.deepEqual(p, { completed: 3, total: 10, phase: 'extracting', updatedAt: p.updatedAt });
  assert.equal(getExtractProgress('no-such-job'), null);
});

test('extract-progress: extra 字段（gleanTotal）透传，缺省不污染形状', () => {
  setExtractProgress('job-g', 22, 20, 'gleaning', { gleanTotal: 5 });
  const g = getExtractProgress('job-g');
  assert.deepEqual(g, { completed: 22, total: 20, phase: 'gleaning', gleanTotal: 5, updatedAt: g.updatedAt });
  setExtractProgress('job-h', 3, 10);
  assert.deepEqual(Object.keys(getExtractProgress('job-h')).sort(), ['completed', 'phase', 'total', 'updatedAt']);
});

test('gleaning: 二次扫描逐块回调 onGleanStart/onGleanDone，单块失败只计 stats.gleanFailed 不进 failedDocs', async () => {
  const extractor = new GraphExtractor({});
  let firstCalls = 0, gleanCalls = 0;
  extractor._callLLM = async (prompt) => {
    if (prompt.includes('第二次扫描')) {
      gleanCalls += 1;
      if (gleanCalls === 2) throw new Error('glean 超时');
      return '{}';
    }
    firstCalls += 1;
    return '{}';
  };
  extractor._parseExtractionResult = (out, batch) => ({
    entities: batch.map((d) => ({ name: 'E-' + d.id, type: 'CONCEPT', sourceDoc: d.id })),
    relations: [],
  });
  let gleanStart = 0;
  const gleanedIds = [];
  const result = await extractor.extractFromDocsResumable([
    { id: 'g#chunk1', title: 'c1', content: 'a' },
    { id: 'g#chunk2', title: 'c2', content: 'b' },
    { id: 'g#chunk3', title: 'c3', content: 'c' },
  ], { onGleanStart: (n) => { gleanStart = n; }, onGleanDone: (id) => gleanedIds.push(id) });
  assert.equal(firstCalls, 3, '首抽 3 块各 1 次');
  assert.equal(gleanStart, 3, 'onGleanStart 带候选总数');
  assert.equal(gleanCalls, 3, 'glean 候选 3 块都尝试（失败块也消耗调用）');
  assert.deepEqual(gleanedIds.sort(), ['g#chunk1', 'g#chunk3'], '失败块不回调 onGleanDone');
  assert.equal(result.stats.gleanFailed, 1);
  assert.equal(result.failedDocs.length, 0, 'glean 失败不污染首抽失败清单');
  assert.equal(result.entities.length, 3, '首抽实体不受影响');
});

test('gleaning: gleaned checkpoint 命中的块不烧 LLM，缓存结果并入且 onGleanDone 照常回调', async () => {
  const extractor = new GraphExtractor({});
  let gleanCalls = 0;
  extractor._callLLM = async (prompt) => {
    if (prompt.includes('第二次扫描')) { gleanCalls += 1; return '{}'; }
    return '{}';
  };
  extractor._parseExtractionResult = (out, batch) => ({
    entities: batch.map((d) => ({ name: 'E-' + d.id, type: 'CONCEPT', sourceDoc: d.id })),
    relations: [],
  });
  const gleanedIds = [];
  const result = await extractor.extractFromDocsResumable([
    { id: 'gc#chunk1', title: 'c1', content: 'a' },
    { id: 'gc#chunk2', title: 'c2', content: 'b' },
  ], {
    gleaned: { 'gc#chunk1': { entities: [{ name: '缓存补充', type: 'CONCEPT', sourceDoc: 'gc#chunk1' }], relations: [] } },
    onGleanDone: (id) => gleanedIds.push(id),
  });
  assert.equal(gleanCalls, 1, '只有 chunk2 需要重烧 glean');
  assert.deepEqual(gleanedIds.sort(), ['gc#chunk1', 'gc#chunk2'], '缓存命中的 glean 块也回调');
  const names = result.entities.map((e) => e.name);
  assert.ok(names.includes('缓存补充'), 'glean 缓存实体并入结果');
});

test('checkpoint: glean 条目落 gleaned 桶，与首抽 docs 互不干扰；旧格式文件自动补 gleaned 桶', () => {
  const a = tmpAsset();
  const digest = buildExtractDigest('gk', '内容', 10);
  upsertExtractCheckpoint(a, digest, { total: 2, docId: 'c1', entities: [{ name: '首抽' }], relations: [] });
  upsertExtractCheckpoint(a, digest, { total: 2, docId: 'c1', entities: [{ name: '补充' }], relations: [], kind: 'glean' });
  const cp = readExtractCheckpoint(a, digest);
  assert.deepEqual(cp.docs.c1.entities, [{ name: '首抽' }]);
  assert.deepEqual(cp.gleaned.c1.entities, [{ name: '补充' }]);
  // 旧格式（无 gleaned 键）手工构造后 upsert glean 不炸
  const digest2 = buildExtractDigest('gk2', '内容', 10);
  upsertExtractCheckpoint(a, digest2, { total: 1, docId: 'd1', entities: [], relations: [] });
  const file = path.join(a.dir, 'drafts', 'extract-cache', digest2 + '.json');
  const legacy = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete legacy.gleaned;
  fs.writeFileSync(file, JSON.stringify(legacy), 'utf8');
  upsertExtractCheckpoint(a, digest2, { total: 1, docId: 'd1', entities: [{ name: 'X' }], relations: [], kind: 'glean' });
  assert.deepEqual(readExtractCheckpoint(a, digest2).gleaned.d1.entities, [{ name: 'X' }]);
});

test('loadManifest: 缺失返回空骨架；损坏 JSON 报 MANIFEST_CORRUPT 并留备份；saveManifest 原子写可读回', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-test-'));
  const a = { manifestPath: path.join(dir, 'org-graph-manifest.json'), storageDir: dir };
  const empty = loadManifest(a);
  assert.equal(empty.active_version, null);
  assert.deepEqual(empty.versions, []);
  const manifest = { asset_id: 'x', active_version: 'org-graph-v1', versions: [{ version: 'org-graph-v1' }] };
  saveManifest(manifest, a);
  assert.equal(loadManifest(a).active_version, 'org-graph-v1');
  assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')).length, 0, '原子写不残留 .tmp');
  fs.writeFileSync(a.manifestPath, '{broken json', 'utf8');
  assert.throws(() => loadManifest(a), (e) => e.code === 'ORG_GRAPH_MANIFEST_CORRUPT');
  assert.equal(fs.readdirSync(dir).filter((f) => f.includes('.corrupt-')).length, 1, '损坏现场已备份');
});

test('publishApprovalEnabled: 默认开，显式 false 关，其余值视为开', () => {
  const prev = process.env.REQUIRE_PUBLISH_APPROVAL;
  try {
    delete process.env.REQUIRE_PUBLISH_APPROVAL;
    assert.equal(publishApprovalEnabled(), true);
    process.env.REQUIRE_PUBLISH_APPROVAL = 'false';
    assert.equal(publishApprovalEnabled(), false);
    process.env.REQUIRE_PUBLISH_APPROVAL = 'true';
    assert.equal(publishApprovalEnabled(), true);
    process.env.REQUIRE_PUBLISH_APPROVAL = '1';
    assert.equal(publishApprovalEnabled(), true);
  } finally {
    if (prev === undefined) delete process.env.REQUIRE_PUBLISH_APPROVAL;
    else process.env.REQUIRE_PUBLISH_APPROVAL = prev;
  }
});
