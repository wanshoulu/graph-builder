'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../routes/rsi-measurement-policy');

test('adaptive policy keeps screening cheap and formal evidence stable', () => {
  assert.deepEqual(P.normalizePolicy(), {
    screeningVotes: 1,
    stableVotes: 3,
    confirmationVotes: 3,
  });
  assert.equal(P.votesFor('screening'), 1);
  assert.equal(P.votesFor('stable'), 3);
  assert.equal(P.votesFor('confirmation'), 3);
});

test('measurement metadata marks historical single votes separately', () => {
  assert.equal(P.measurementMeta('stable', 3, 3).confidence, 'stable');
  assert.equal(P.measurementMeta('screening', 1, 1).confidence, 'provisional');
  assert.equal(P.legacyMeta().confidence, 'legacy_single_vote');
});

test('reserve rejects an incomplete repeated evaluation before it starts', () => {
  assert.deepEqual(P.reserve(7, 'stable'), { ok: true, votes: 3, remaining: 4 });
  assert.deepEqual(P.reserve(2, 'stable'), { ok: false, votes: 3, remaining: 2 });
});
