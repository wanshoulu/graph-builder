'use strict';

const DEFAULTS = Object.freeze({
  screeningVotes: 1,
  stableVotes: 3,
  confirmationVotes: 3,
});

function clampVotes(value) {
  return Math.max(1, Math.min(5, Math.floor(Number(value)) || 1));
}

function normalizePolicy(input = {}) {
  return {
    screeningVotes: clampVotes(input.screeningVotes ?? DEFAULTS.screeningVotes),
    stableVotes: Math.max(3, clampVotes(input.stableVotes ?? DEFAULTS.stableVotes)),
    confirmationVotes: Math.max(3, clampVotes(input.confirmationVotes ?? DEFAULTS.confirmationVotes)),
  };
}

function votesFor(mode, policy = DEFAULTS) {
  const normalized = normalizePolicy(policy);
  if (mode === 'screening') return normalized.screeningVotes;
  if (mode === 'confirmation') return normalized.confirmationVotes;
  return normalized.stableVotes;
}

function measurementMeta(mode, repeatVotes, completedVotes = repeatVotes) {
  return {
    mode,
    repeatVotes,
    completedVotes,
    confidence: mode === 'screening'
      ? 'provisional'
      : completedVotes >= 3 ? 'stable' : 'provisional',
  };
}

function legacyMeta() {
  return {
    mode: 'screening',
    repeatVotes: 1,
    completedVotes: 1,
    confidence: 'legacy_single_vote',
  };
}

function reserve(remaining, mode, policy) {
  const votes = votesFor(mode, policy);
  return {
    ok: remaining >= votes,
    votes,
    remaining: remaining >= votes ? remaining - votes : remaining,
  };
}

module.exports = {
  DEFAULTS,
  normalizePolicy,
  votesFor,
  measurementMeta,
  legacyMeta,
  reserve,
};
