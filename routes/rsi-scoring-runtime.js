'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const { performance } = require('node:perf_hooks');
const { scoreIntentCase, validateGold } = require('./rsi-case-scoring');
const { diagnoseError } = require('./rsi-learning');

async function scoreEngineCase(c, evaluateIntent, options = {}) {
  const started = performance.now();
  let row;
  try { validateGold(c); }
  catch (error) {
    return { case_id: c.case_id, query: c.query, shape: c.intent_shape || 'single_intent', expected: c.expected_intents || [],
      strict: false, relaxed: 0, resultType: 'invalid_gold', errorFamily: 'invalid_gold', errorFamilies: ['invalid_gold'],
      error: error.message, latency_ms: 0, scoring_concurrency: options.concurrency || 1, cost: null };
  }
  try { row = scoreIntentCase(c, await evaluateIntent(c.query, { topk: options.topk || 5 })); }
  catch (error) {
    row = { case_id: c.case_id, query: c.query, shape: c.intent_shape || 'single_intent', expected: c.expected_intents || [],
      ...(c.expected_tasks ? { expected_tasks: c.expected_tasks } : {}), strict: false, relaxed: 0,
      resultType: 'engine_error', error: error.message, engine_tasks: [], engine_segments: [] };
  }
  return { ...row, ...diagnoseError(row), latency_ms: Number((performance.now() - started).toFixed(2)),
    scoring_concurrency: options.concurrency || 1, cost: null };
}

// Only case evaluation is concurrent. State, gates and promotion remain serial.
async function mapConcurrent(items, concurrency, work) {
  // 评测是网络等待型负载：并发上限不应硬编码为 4，按环境变量放开（默认 8）
  const maxWidth = Math.max(1, Math.floor(Number(process.env.RSI_SCORING_MAX_CONCURRENCY)) || 8);
  const width = Math.min(items.length, Math.max(1, Math.min(maxWidth, Math.floor(Number(concurrency)) || 1)));
  const results = new Array(items.length);
  let next = 0;
  const workers = await Promise.allSettled(Array.from({ length: width }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await work(items[i], i);
    }
  }));
  const failed = workers.find(r => r.status === 'rejected');
  if (failed) throw failed.reason;
  return results;
}

function createUsageObserver(fetchImpl) {
  const storage = new AsyncLocalStorage();
  return {
    async fetch(url, options) {
      const usage = storage.getStore();
      let isLlm = false;
      try { isLlm = Array.isArray(JSON.parse(options?.body || '{}').messages); } catch (_) {}
      if (usage && isLlm) usage.llm_calls++;
      let response;
      try { response = await fetchImpl(url, options); }
      catch (error) { if (usage && isLlm) usage.complete = false; throw error; }
      if (usage && isLlm) {
        try {
          const body = await response.clone().json();
          if (Number.isFinite(body.usage?.total_tokens)) usage.tokens += body.usage.total_tokens;
          else usage.complete = false;
        } catch (_) { usage.complete = false; }
      }
      return response;
    },
    async measure(work) {
      const usage = { llm_calls: 0, tokens: 0, complete: true };
      const value = await storage.run(usage, work);
      return { value, usage: { llm_calls: usage.llm_calls, tokens: usage.complete ? usage.tokens : null } };
    },
  };
}

module.exports = { mapConcurrent, createUsageObserver, scoreEngineCase };
