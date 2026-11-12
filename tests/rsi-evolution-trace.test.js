'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
test('single-line proposal snapshots retain identity, rejection and measured full-scope scores', () => {
  const { snapshotProposals } = require('../routes/rsi-evolution-trace');
  const scores = { all: { strict_pct: 81 }, train: { strict_pct: 80 }, heldout: { strict_pct: 83 } };
  const snap = snapshotProposals([{ id: 'p1', status: 'gated', candidateHash: 'asset',
    proposal: { type: 'engine', motivation: '降低误触发' }, fullScores: scores,
    gate: { reason: '单意图退步' } }], 'v2', 3);
  scores.all.strict_pct = 0;
  assert.equal(snap[0].id, 'p1');
  assert.equal(snap[0].parent, 'v2');
  assert.equal(snap[0].gen, 3);
  assert.equal(snap[0].fullScores.all.strict_pct, 81);
  assert.equal(snap[0].gateReason, '单意图退步');
  assert.equal(snap[0].artifactHash, 'asset');
});

test('phase timer records real durations without counting progress messages as new phases', () => {
  const { createStageTimer } = require('../routes/rsi-evolution-trace');
  let now = 100;
  const clock = createStageTimer(() => now);
  clock.mark('evaluate'); now = 180; clock.mark('evaluate_progress'); now = 200;
  clock.mark('select'); now = 230;
  assert.deepEqual(clock.snapshot(), { elapsedMs: 130, phases: { evaluate: 100, select: 30 } });
});

test('identical frozen assets do not trigger another evaluation, but unknown hashes are not deduplicated', () => {
  const { uniqueCandidateIds } = require('../routes/rsi-evolution-trace');
  const branches = { root: { artifactHash: 'root' }, a: { artifactHash: 'new' }, b: { artifactHash: 'new' }, c: {}, d: {}, e: { artifactHash: 'root' } };
  const result = uniqueCandidateIds(['a', 'b', 'c', 'd', 'e'], branches, ['root']);
  assert.deepEqual(result.unique, ['a', 'c', 'd']);
  assert.deepEqual(result.duplicates, ['b', 'e']);
});

test('branch snapshots retain both fusion parents and immutable per-shape scores', () => {
  const { snapshotBranches } = require('../routes/rsi-evolution-trace');
  const scores = { all: { strict_pct: 80, single_intent: { total: 5, strict_pct: 100 } }, train: { strict_pct: 80 }, heldout: { strict_pct: 80 } };
  const snap = snapshotBranches({ b3: { parent: 'b1', crossedWith: 'b2', gen: 2, scores } });
  scores.all.single_intent.strict_pct = 0;
  assert.deepEqual(snap.b3.parents, ['b1', 'b2']);
  assert.equal(snap.b3.fullScores.all.single_intent.strict_pct, 100);
});


// Orchestrator contracts now run against the actual production adapter in rsi-production-runtime.test.js, not extracted obsolete private functions.
