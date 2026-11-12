'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { flag: 'wx' });
    // Windows 上目标文件被索引器/杀软短暂持有会 EPERM：小退避重试而不是让整次 publish 崩掉
    let lastError = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try { fs.renameSync(temporary, file); lastError = null; break; }
      catch (e) { lastError = e; if (e.code !== 'EPERM' || attempt === 4) break; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (attempt + 1)); }
    }
    if (lastError) throw lastError;
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

function diffAssets(before, after, prefix = '', changes = []) {
  if (JSON.stringify(before) === JSON.stringify(after)) return changes;
  if (before && after && !Array.isArray(before) && !Array.isArray(after) && typeof before === 'object' && typeof after === 'object') {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) diffAssets(before[key], after[key], prefix ? prefix + '.' + key : key, changes);
  } else changes.push({ path: prefix || '$', before: before ?? null, after: after ?? null });
  return changes;
}

function caseChanges(before = [], after = []) {
  const previous = new Map(before.map(r => [r.case_id, r]));
  return after.map(row => {
    const old = previous.get(row.case_id);
    return { case_id: row.case_id, query: row.query || old?.query || '', shape: row.shape || old?.shape,
      before: old ? { strict: old.strict, resultType: old.resultType, relaxed: old.relaxed } : null,
      after: { strict: row.strict, resultType: row.resultType, relaxed: row.relaxed },
      change: !old ? 'unmeasured' : !old.strict && row.strict ? 'improved' : old.strict && !row.strict ? 'regressed' : 'unchanged' };
  });
}

function usageSummary(readings, proposerRequests = 0) {
  const rows = readings.flatMap(r => r?.results || []);
  const known = rows.length > 0 && rows.every(r => Number.isFinite(r.llm_calls));
  const tokensKnown = rows.length > 0 && rows.every(r => Number.isFinite(r.tokens));
  return { metricCalls: readings.length, evaluatedCases: rows.length, proposerRequests,
    recognizerRequests: known ? rows.reduce((n, r) => n + r.llm_calls, 0) : null,
    recognizerTokens: tokensKnown ? rows.reduce((n, r) => n + r.tokens, 0) : null,
    proposerTokens: null, cost: null, costStatus: 'unknown' };
}
module.exports = { atomicWrite, diffAssets, caseChanges, usageSummary };
