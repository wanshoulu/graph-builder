'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mapConcurrent, createUsageObserver, scoreEngineCase } = require('../routes/rsi-scoring-runtime');

test('bounded scoring overlaps work but preserves case order', async () => {
  let active = 0, peak = 0;
  const results = await mapConcurrent([30, 5, 10, 1], 2, async (ms, i) => {
    peak = Math.max(peak, ++active);
    await new Promise(r => setTimeout(r, ms));
    active--;
    return i;
  });
  assert.equal(peak, 2);
  assert.deepEqual(results, [0, 1, 2, 3]);
});

test('concurrent LLM usage belongs to its own case, including missing token usage', async () => {
  const observer = createUsageObserver(async (_, opts) => {
    const body = JSON.parse(opts.body);
    await new Promise(r => setTimeout(r, body.delay));
    return { clone: () => ({ json: async () => body.tokens == null ? {} : { usage: { total_tokens: body.tokens } } }) };
  });
  const results = await mapConcurrent([20, null], 2, async (tokens, i) => observer.measure(async () => {
    await observer.fetch('http://fixture', { body: JSON.stringify({ messages: [], tokens, delay: i ? 1 : 8 }) });
    return `case-${i}`;
  }));
  assert.deepEqual(results.map(r => r.usage), [{ llm_calls: 1, tokens: 20 }, { llm_calls: 1, tokens: null }]);
  assert.deepEqual(results.map(r => r.value), ['case-0', 'case-1']);
});

test('production scorer applies selected concurrency and keeps per-case usage and results aligned', async () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../scripts/rsi-engine-score.js'), 'utf8');
  const body = source.slice(source.indexOf('async function run()'), source.indexOf('\nrun().catch'));
  let active = 0, peak = 0, report;
  const originalFetch = async () => {
    peak = Math.max(peak, ++active); await new Promise(r => setTimeout(r, 8)); active--;
    return { clone: () => ({ json: async () => ({ usage: { total_tokens: 9 } }) }) };
  };
  const context = { args: { concurrency: 2 }, cases: [1, 2, 3, 4].map(i => ({ case_id: `c${i}`, query: `q${i}`, expected_intents: ['intent'] })),
    performance, fetch: originalFetch, mapConcurrent, createUsageObserver, scoreEngineCase,
    SCORING_CAPABILITIES: require('../routes/rsi-case-scoring').SCORING_CAPABILITIES,
    engineFingerprint: () => ({ engineSha: 'fixture' }),
    performanceSummary: require('../routes/rsi-learning').performanceSummary, engineMode: 'online', outPath: 'report.json', path,
    console: { error() {} }, fs: { mkdirSync() {}, writeFileSync(_, text) { report = JSON.parse(text); } } };
  const run = vm.runInNewContext(`async function evaluateIntent() { await globalThis.fetch('fixture', { body: JSON.stringify({ messages: [] }) }); return { final_result: { intent_id: 'intent' } }; }\n${body}\nrun`, context);
  await run();
  assert.equal(peak, 2);
  assert.equal(report.execution.concurrency, 2);
  assert.equal(report.strict_pct, 100);
  assert.deepEqual(report.rows.map(r => [r.case_id, r.llm_calls, r.tokens]), [['c1', 1, 9], ['c2', 1, 9], ['c3', 1, 9], ['c4', 1, 9]]);
  assert.equal(context.fetch, originalFetch);
});

test('a failed request leaves token usage unknown even when recognition falls back successfully', async () => {
  const observer = createUsageObserver(async () => { throw new Error('network'); });
  const result = await observer.measure(async () => {
    try { await observer.fetch('fixture', { body: JSON.stringify({ messages: [] }) }); } catch (_) {}
    return 'fallback';
  });
  assert.equal(result.value, 'fallback');
  assert.equal(result.usage.tokens, null);
});

test('a worker error drains in-flight work before scoring cleanup can run', async () => {
  let drained = false;
  await assert.rejects(mapConcurrent([0, 1], 2, async i => {
    if (!i) throw new Error('worker');
    await new Promise(r => setTimeout(r, 10)); drained = true;
  }), /worker/);
  assert.equal(drained, true);
});
