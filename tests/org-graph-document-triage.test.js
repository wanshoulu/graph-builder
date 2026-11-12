/**
 * org-graph 文档分诊单测：画像纯函数 / 表头-模板匹配 / 分诊裁决规则矩阵。
 * 相关性评估（assessCorpusRelevance）走真实 LLM，不在单测内——规则矩阵用 relevance=null 与低相关两种桩验证。
 * 用法: node --test tests/org-graph-document-triage.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDocumentProfile, matchHeadersToTemplate, triageRecommendation, resolveAsset } = require('../routes/org-graph');

const INTENT_ASSET = resolveAsset('intent-graph');

function paragraph(ch, count) {
  return new Array(count + 1).join(ch);
}

// ── buildDocumentProfile ──

test('画像：正常中文语料 → 乱码率 0、表格率低', () => {
  const text = ['客户可以在手机银行上查询账户余额并办理转账。', '理财经理负责推荐稳健型理财产品。'].join('\n');
  const p = buildDocumentProfile(text);
  assert.equal(p.chars, text.length);
  assert.equal(p.lines, 2);
  assert.equal(p.garbledRatio, 0);
  assert.ok(p.tableLikeRatio === 0);
  assert.ok(p.sample.includes('账户余额'), '样本包含正文片段');
});

test('画像：替换符乱码行占比超阈值可检出', () => {
  const text = Array.from({ length: 10 }, (_, i) => (i < 6 ? '乱码�行�' + i : '正常行' + i)).join('\n');
  const p = buildDocumentProfile(text);
  assert.equal(p.garbledRatio, 0.6, '6/10 行含 U+FFFD');
});

test('画像：逗号密集的表格文本 → tableLikeRatio 高', () => {
  const text = Array.from({ length: 10 }, (_, i) => `转账汇款,功能${i},页面路径${i},P0-高频,意图描述${i}`).join('\n');
  const p = buildDocumentProfile(text);
  assert.equal(p.tableLikeRatio, 1, '每行 4+ 逗号都算表格行');
});

test('画像：纯单行长文本（无换行）→ 表格率 0 但不含 U+FFFD', () => {
  const p = buildDocumentProfile(paragraph('x', 3000));
  assert.equal(p.lines, 1);
  assert.equal(p.garbledRatio, 0);
  assert.equal(p.tableLikeRatio, 0);
});

// ── matchHeadersToTemplate ──

test('表头匹配：意图清单列名命中模板字段（label 完全匹配）', () => {
  const m = matchHeadersToTemplate(['意图名称', '业务描述', '说法内容', '热度'], INTENT_ASSET);
  assert.ok(m && m.score >= 0.5, 'score=' + (m && m.score));
  assert.ok(m.matchedCount >= 2);
  assert.ok(m.matched.some((x) => x.header === '意图名称'));
});

test('表头匹配：无关列名（产品 SKU/仓库库存）→ 低分', () => {
  const m = matchHeadersToTemplate(['产品SKU', '仓库库存', '进货价'], INTENT_ASSET);
  assert.ok(m && m.score < 0.5, 'score=' + (m && m.score));
});

test('表头匹配：空表头/空数组 → null', () => {
  assert.equal(matchHeadersToTemplate([], INTENT_ASSET), null);
  assert.equal(matchHeadersToTemplate(null, INTENT_ASSET), null);
});

// ── triageRecommendation 规则矩阵 ──

test('裁决：内容过短 → reject', () => {
  const r = triageRecommendation(buildDocumentProfile('太短'), null, null);
  assert.equal(r.mode, 'reject');
});

test('裁决：乱码率超 20% → reject（不放行烧 LLM）', () => {
  const text = Array.from({ length: 10 }, (_, i) => (i < 5 ? '坏�行' + i : '好行' + i)).join('\n') + paragraph('x', 500);
  const r = triageRecommendation(buildDocumentProfile(text), null, null);
  assert.equal(r.mode, 'reject');
  assert.ok(r.reasons[0].includes('乱码'));
});

test('裁决：相关性低（置信≥0.6）→ low_relevance，附理由', () => {
  const text = Array.from({ length: 8 }, (_, i) => `今天是周${'一二三四五六日'[i]}，天气不错，我去公园散步。`).join('\n') + paragraph('x', 500);
  const r = triageRecommendation(buildDocumentProfile(text), null, { relevant: false, confidence: 0.75, reasons: '内容是生活随笔', contentTypes: '随笔' });
  assert.equal(r.mode, 'low_relevance');
  assert.ok(r.reasons.some((x) => x.includes('相关性低')));
  assert.ok(r.reasons.some((x) => x.includes('随笔')));
});

test('裁决：高置信无关（置信≥0.85）→ reject，避免无效抽取', () => {
  const text = Array.from({ length: 8 }, (_, i) => `今天是周${'一二三四五六日'[i]}，天气不错，我去公园散步。`).join('\n') + paragraph('x', 500);
  const r = triageRecommendation(buildDocumentProfile(text), null, { relevant: false, confidence: 0.9, reasons: '内容是生活随笔', contentTypes: '随笔' });
  assert.equal(r.mode, 'reject');
  assert.ok(r.reasons.some((x) => x.includes('主题无关')));
  assert.ok(r.reasons.some((x) => x.includes('随笔')));
});

test('裁决：表头匹配度 ≥0.5 且相关性正常 → suggest_tabular', () => {
  const text = Array.from({ length: 20 }, (_, i) => `转账,意图名称${i},业务描述${i},P0-高频,话术答复`).join('\n');
  const profile = buildDocumentProfile(text);
  const structure = [{ name: '意图清单', headers: ['意图名称', '业务描述', '热度'], rows: 20, match: matchHeadersToTemplate(['意图名称', '业务描述', '热度'], INTENT_ASSET) }];
  const r = triageRecommendation(profile, structure, { relevant: true, confidence: 0.9, reasons: '', contentTypes: '意图清单' });
  assert.equal(r.mode, 'suggest_tabular');
  assert.ok(r.reasons[0].includes('匹配度'));
});

test('裁决：无结构、相关性高 → extract（正常放行）', () => {
  const text = '客户可以在手机银行上查询账户余额并办理转账。\n' + paragraph('x', 500);
  const r = triageRecommendation(buildDocumentProfile(text), null, { relevant: true, confidence: 0.85, reasons: '语料描述银行业务', contentTypes: '业务说明' });
  assert.equal(r.mode, 'extract');
});

test('裁决：相关性评估服务挂了（relevant=null）→ 不阻塞，按画像放行', () => {
  const text = '客户可以在手机银行上查询账户余额并办理转账。\n' + paragraph('x', 500);
  const r = triageRecommendation(buildDocumentProfile(text), null, { relevant: null, confidence: null, reasons: '评估服务不可用', contentTypes: '' });
  assert.equal(r.mode, 'extract');
});
