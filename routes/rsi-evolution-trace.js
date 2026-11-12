'use strict';

// Immutable run-local observations. Branch IDs restart at b0 on each run.
function snapshotBranches(branches, describe = b => b.opLabel || b.op) {
  return Object.fromEntries(Object.entries(branches || {}).map(([id, b]) => [id, {
    id, parent: b.parent || null, crossedWith: b.crossedWith || null,
    parents: [b.parent, b.crossedWith].filter(Boolean), op: b.op, opLabel: b.opLabel || b.op,
    summary: describe(b), proposalId: b.proposalId || null,
    target: b.target || 'graph', method: b.method || 'reflective_search', artifactHash: b.artifactHash || null,
    status: b.status, depth: b.depth, gen: b.gen ?? null, baseVersion: b.baseVersion || null,
    gateReason: b.selectionReason || b.gateReason || b.error || null, paretoOptimal: !!b.paretoOptimal,
    createdAt: b.createdAt, evaluatedAt: b.evaluatedAt || null,
    engineRev: b.scores?.engineRev || b.engineRev || null,
    fullScores: b.scores ? JSON.parse(JSON.stringify(b.scores)) : null,
    scores: b.scores ? { allStrict: b.scores.all?.strict_pct ?? null,
      trainStrict: b.scores.train?.strict_pct ?? null, heldoutStrict: b.scores.heldout?.strict_pct ?? null } : null,
  }]));
}

function serializeEvolutionRun(run, deid = s => s) {
  if (!run) return null;
  return {
    ...run,
    branches: run.branches ? Object.fromEntries(Object.entries(run.branches).map(([id, b]) => [id, {
      ...b, summary: deid(b.summary || b.opLabel || b.op), gateReason: b.gateReason ? deid(b.gateReason) : null,
    }])) : null,
    rounds: (run.rounds || []).map(r => ({
      ...r, gen: r.gen ?? r.round, round: r.round ?? r.gen,
      champion: r.champion ?? r.roundChampion ?? null,
      roundChampion: r.champion ?? r.roundChampion ?? null,
      allStrict: r.allStrict ?? null, evaluatedCount: r.evaluatedCount ?? r.evaluated,
      note: r.note ? deid(r.note) : null,
      candidates: r.candidates?.map(b => ({ ...b, summary: deid(b.summary || b.opLabel || b.op), gateReason: b.gateReason ? deid(b.gateReason) : null })),
    })),
  };
}

// Candidate selection can retain Top-K within a generation. Only its converged
// output is allowed to seed the following generation.
function nextGenerationInputs(st, policy = 'champion') {
  if (policy === 'pareto_population') return (st.population || []).filter(id => {
    const b = st.branches?.[id];
    return b?.scores && !b.staleEngine && !['gated', 'pruned', 'eval_error'].includes(b.status);
  });
  const b = st.branches?.[st.champion];
  return b && b.scores && !b.staleEngine && b.status !== 'gated' && b.status !== 'pruned' ? [st.champion] : [];
}

function snapshotProposals(entries, inputBranch, gen) {
  return (entries || []).map(e => ({
    id: e.id, parent: inputBranch, parents: [inputBranch], gen, depth: gen,
    op: e.proposal?.type || 'graph', opLabel: e.opLabel || e.proposal?.type || '图谱优化',
    summary: e.proposal?.motivation || e.opLabel || '候选改动', proposalId: e.id,
    target: e.proposal?.type || 'graph', artifactHash: e.candidateHash || null,
    status: e.status, gateReason: e.gate?.reason || null, createdAt: e.createdAt,
    engineRev: e.trainScores?.engineRev || e.fullScores?.engineRev || null,
    fullScores: e.fullScores ? JSON.parse(JSON.stringify(e.fullScores)) : null,
    scores: { allStrict: e.fullScores?.all?.strict_pct ?? null,
      trainStrict: e.trainScores?.strict_pct ?? null, heldoutStrict: e.heldoutScores?.strict_pct ?? null },
  }));
}

function createStageTimer(now = Date.now) {
  const started = now(), phases = {};
  let stage = null, since = started;
  return {
    mark(step) {
      if (!['baseline', 'attribute', 'propose', 'mutate', 'plan', 'probe', 'reflect', 'evaluate', 'select', 'crossover', 'engine_check', 'adopt', 'done', 'stopped'].includes(step)) return;
      const at = now();
      if (stage) phases[stage] = (phases[stage] || 0) + at - since;
      stage = ['done', 'stopped'].includes(step) ? null : step;
      since = at;
    },
    snapshot() {
      const at = now(), current = { ...phases };
      if (stage) current[stage] = (current[stage] || 0) + at - since;
      return { elapsedMs: at - started, phases: current };
    },
  };
}

function uniqueCandidateIds(ids, branches, evaluatedIds = []) {
  const seen = new Set(evaluatedIds.map(id => branches[id]?.artifactHash).filter(Boolean));
  const unique = [], duplicates = [];
  for (const id of ids) {
    const hash = branches[id]?.artifactHash;
    if (hash && seen.has(hash)) duplicates.push(id);
    else { unique.push(id); if (hash) seen.add(hash); }
  }
  return { unique, duplicates };
}

module.exports = { snapshotBranches, snapshotProposals, serializeEvolutionRun, nextGenerationInputs, createStageTimer, uniqueCandidateIds };
