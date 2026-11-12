/**
 * org-graph chunkContent 分块单测（routes/org-graph.js）
 * 段落边界切块 ≤2400 字符 + ~200 重叠 + 块数上限 10。
 * GraphExtractor 内部对单文档按 2500 截断——块长超限会静默丢内容。
 * 用法: node --test tests/org-graph-chunk.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { chunkContent } = require('../routes/org-graph');

function paragraph(ch, count) {
  return new Array(count + 1).join(ch); // count 个字符
}

test('空/空白输入 → 空数组', () => {
  assert.deepEqual(chunkContent(''), []);
  assert.deepEqual(chunkContent('   \n\n  '), []);
});

test('短文本 → 单块原样', () => {
  const text = '金融科技部三个人：王伟、李强、张敏。';
  const blocks = chunkContent(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0], text);
});

test('段落边界切块：每段 2000 字符 → 各自成块（后块带 200 重叠）', () => {
  const blocks = chunkContent([paragraph('a', 2000), paragraph('b', 2000), paragraph('c', 2000)].join('\n\n'));
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].length, 2000);
  assert.equal(blocks[1].length, 2202, '块 2 = 200 重叠 + 段落 b');
  assert.equal(blocks[2].length, 2202, '块 3 = 200 重叠 + 段落 c');
});

test('相邻段落合并：合并不超限时进同一块', () => {
  const blocks = chunkContent([paragraph('a', 800), paragraph('b', 800), paragraph('c', 800)].join('\n\n'));
  assert.equal(blocks.length, 2, '800*3=2400+2 换行超限 → 前两段一块 + 第三段一块');
  assert.equal(blocks[0], paragraph('a', 800) + '\n\n' + paragraph('b', 800));
});

test('重叠：后一块带入前一块尾部 ~200 字符', () => {
  const blocks = chunkContent([paragraph('a', 2000), paragraph('b', 2000)].join('\n\n'));
  assert.equal(blocks.length, 2);
  assert.ok(blocks[1].startsWith(blocks[0].slice(-200)), '块 2 以块 1 尾部 200 字符开头');
});

test('所有块长 ≤2400（含重叠块）', () => {
  const text = [paragraph('x', 2200), paragraph('y', 2200), paragraph('z', 2200)].join('\n\n');
  const blocks = chunkContent(text);
  assert.ok(blocks.length >= 3);
  blocks.forEach((b) => assert.ok(b.length <= 2400, '块长 ' + b.length + ' 超限'));
});

test('超长单段落（无段落边界）→ 硬切，每片 ≤2400 且相邻重叠', () => {
  const text = paragraph('m', 6000);
  const blocks = chunkContent(text);
  assert.equal(blocks.length, 3, '6000 → 2400 + 2400 + 1600（步长 2200 含重叠）');
  assert.deepEqual(blocks.map((b) => b.length), [2400, 2400, 1600]);
  assert.ok(blocks[1].startsWith(blocks[0].slice(-200)), '硬切相邻片重叠 200');
  assert.ok(blocks[2].endsWith(text.slice(-50)), '末尾内容完整保留');
});

test('块数上限 10：再多段落也只出 10 块', () => {
  const paragraphs = [];
  for (let i = 0; i < 25; i++) paragraphs.push(paragraph(String(i), 1500));
  const blocks = chunkContent(paragraphs.join('\n\n'));
  assert.equal(blocks.length, 10);
  assert.ok(blocks[0].startsWith(paragraph('0', 1500)));
});

test('maxBlocks 显式放大（整文档导入场景，/extract 端点 clamp 上限 80）', () => {
  const paragraphs = [];
  for (let i = 0; i < 100; i++) paragraphs.push(paragraph(String(i % 10), 1500));
  const blocks = chunkContent(paragraphs.join('\n\n'), 2400, 200, 80);
  assert.equal(blocks.length, 80, '100 段请求 80 块 → 恰好 80 块');
  const blocksDefault = chunkContent(paragraphs.join('\n\n'));
  assert.equal(blocksDefault.length, 10, '不传 maxBlocks 仍默认 10');
});
