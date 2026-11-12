'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const goal = require('../routes/rsi-goal');
const { splitCases, splitPreview } = require('../routes/rsi-task-dataset');

const rev = { engineSha: 'fixture', protoRev: 3, engineMode: 'online+decl' };
const rev2 = { engineSha: 'other', protoRev: 3, engineMode: 'online+decl' };
const agg = (total, correct, extra = {}) => ({ total, strict_pct: 100 * correct / total, relaxed_pct: 100 * correct / total, ...extra });
const rowsOf = (n, correctIds, shape = 'single_intent', prefix = 'c') => Array.from({ length: n }, (_, i) => ({
  case_id: `${prefix}${i}`, shape, strict: correctIds.includes(`${prefix}${i}`), resultType: correctIds.includes(`${prefix}${i}`) ? 'ok' : 'recall_miss',
}));
function scoresOf(train, heldout) {
  return { engineRev: rev, train: agg(train.length, train.filter(r => r.strict).length), heldout: agg(heldout.length, heldout.filter(r => r.strict).length),
    all: agg(train.length + heldout.length, [...train, ...heldout].filter(r => r.strict).length) };
}

test('goal normalization rejects impossible values and keeps defaults', () => {
  assert.deepEqual(goal.normalizeGoal(), { ...goal.DEFAULTS, note: '' });
  assert.equal(goal.normalizeGoal({ target: 90, minEffect: 5 }).target, 90);
  assert.throws(() => goal.normalizeGoal({ target: 120 }), /目标精度/);
  assert.throws(() => goal.normalizeGoal({ alpha: 0.9 }), /显著性/);
});

test('goal progress reports missing cases, failure families and a measured ceiling', () => {
  const cases = Array.from({ length: 10 }, (_, i) => ({ case_id: `c${i}`, intent_shape: i < 4 ? 'ambiguous_intent' : 'single_intent' }));
  const rows = [
    ...Array.from({ length: 4 }, (_, i) => ({ case_id: `c${i}`, shape: 'ambiguous_intent', strict: i === 0, resultType: i === 0 ? 'ok' : 'clarify_extra_options' })),
    ...Array.from({ length: 6 }, (_, i) => ({ case_id: `c${i + 4}`, shape: 'single_intent', strict: i < 4, resultType: i < 4 ? 'ok' : 'recall_miss' })),
  ];
  const scores = { all: agg(10, 5), train: agg(10, 5), heldout: agg(10, 5) };
  const p = goal.goalProgress({ target: 85 }, scores, rows, cases);
  assert.equal(p.current, 50);
  assert.equal(p.missingCases, 4);
  assert.equal(p.gapPts, 35);
  assert.equal(p.met, false);
  assert.equal(p.reachable, false);
  assert.ok(p.byShape.find(s => s.shape === 'ambiguous_intent').failed === 3);
  assert.ok(p.byFamily.find(f => f.family === 'clarification_precision').count === 3);
  assert.match(p.summary, /差 4 题/);
});

test('mcnemar counts only discordant pairs', () => {
  const before = rowsOf(12, ['c0', 'c1', 'c2', 'c3']);
  const after = rowsOf(12, ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9']);
  const m = goal.mcnemar(before, after);
  assert.equal(m.fixed, 6);
  assert.equal(m.broken, 0);
  assert.ok(m.pValue < 0.05);
  const flat = goal.mcnemar(before, before);
  assert.equal(flat.pValue, 1);
});

test('gate rejects an unchanged asset as no effect and rejects cross-engine evidence', () => {
  const train = rowsOf(20, ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9', 'c10', 'c11', 'c12']);
  const held = rowsOf(10, ['h0', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'], 'single_intent', 'h');
  const before = scoresOf(train, held);
  const same = goal.gateReport({ before, after: before, beforeRows: [...train, ...held], afterRows: [...train, ...held], trainIds: train.map(r => r.case_id) });
  assert.equal(same.passed, false);
  assert.equal(same.verdict, 'no_effect');
  const cross = goal.gateReport({ before, after: { ...before, engineRev: rev2 }, beforeRows: [...train, ...held], afterRows: [...train, ...held] });
  assert.equal(cross.verdict, 'invalid');
});

test('gate promotes a real paired gain and quarantines baseline-failing regression cases', () => {
  const trainBefore = rowsOf(20, ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9', 'c10', 'c11', 'c12']);
  const held = rowsOf(10, ['h0', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'], 'single_intent', 'h');
  const trainAfter = rowsOf(20, [...Array.from({ length: 17 }, (_, i) => `c${i}`)]);
  const before = scoresOf(trainBefore, held), after = scoresOf(trainAfter, held);
  const r = goal.gateReport({
    before, after, beforeRows: [...trainBefore, ...held], afterRows: [...trainAfter, ...held],
    trainIds: trainBefore.map(x => x.case_id), regression: { c0: {}, c19: {} }, goal: { target: 80 },
  });
  assert.equal(r.passed, true);
  assert.equal(r.verdict, 'promoted');
  assert.deepEqual(r.metrics.quarantined, ['c19'], '基线即失败的题不再阻断晋升');
  assert.deepEqual(r.metrics.enforced, 1);
});

test('gate vetoes a broken protected case and an out-of-tolerance heldout drop', () => {
  const trainBefore = rowsOf(20, ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9', 'c10', 'c11', 'c12']);
  const held = rowsOf(10, ['h0', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'], 'single_intent', 'h');
  const trainAfter = rowsOf(20, Array.from({ length: 17 }, (_, i) => `c${i}`).filter(id => id !== 'c0'));
  const heldAfter = rowsOf(10, ['h0', 'h1', 'h2'], 'single_intent', 'h');
  const before = scoresOf(trainBefore, held), after = scoresOf(trainAfter, heldAfter);
  const broken = goal.gateReport({ before, after, beforeRows: [...trainBefore, ...held], afterRows: [...trainAfter, ...heldAfter],
    trainIds: trainBefore.map(x => x.case_id), regression: { c0: {} } });
  assert.equal(broken.passed, false);
  assert.match(broken.reason, /回归保护未通过|验证完全正确率回退/);
});

test('gate keeps one clean fix as insufficient evidence', () => {
  const trainBefore = rowsOf(20, Array.from({ length: 12 }, (_, i) => `c${i}`));
  const trainAfter = rowsOf(20, Array.from({ length: 13 }, (_, i) => `c${i}`));
  const held = rowsOf(10, Array.from({ length: 7 }, (_, i) => `h${i}`), 'single_intent', 'h');
  const r = goal.gateReport({
    before: scoresOf(trainBefore, held), after: scoresOf(trainAfter, held),
    beforeRows: [...trainBefore, ...held], afterRows: [...trainAfter, ...held],
    trainIds: trainBefore.map(x => x.case_id),
  });
  assert.equal(r.passed, false);
  assert.equal(r.verdict, 'evidence_insufficient');
  assert.equal(r.metrics.minCleanFixes, 2);
});

test('gate requires two net fixes in the complete set', () => {
  const trainBefore = rowsOf(20, Array.from({ length: 12 }, (_, i) => `c${i}`));
  const trainAfter = rowsOf(20, Array.from({ length: 14 }, (_, i) => `c${i}`));
  const heldBefore = rowsOf(10, Array.from({ length: 7 }, (_, i) => `h${i}`), 'single_intent', 'h');
  const heldAfter = rowsOf(10, Array.from({ length: 6 }, (_, i) => `h${i}`), 'single_intent', 'h');
  const r = goal.gateReport({
    before: scoresOf(trainBefore, heldBefore), after: scoresOf(trainAfter, heldAfter),
    beforeRows: [...trainBefore, ...heldBefore], afterRows: [...trainAfter, ...heldAfter],
    trainIds: trainBefore.map(x => x.case_id),
  });
  assert.equal(r.passed, false);
  assert.match(r.reason, /全量净修复至少 2 题|验证集不得净退化/);
});

test('split keeps ratios, has no overlap, and reports intent coverage honestly', () => {
  const cases = [];
  for (let i = 0; i < 40; i++) cases.push({ case_id: `s${i}`, intent_shape: 'single_intent', expected_intents: [`i${i % 10}`] });
  for (let i = 0; i < 10; i++) cases.push({ case_id: `m${i}`, intent_shape: 'multi_intent', expected_intents: [`i${i % 10}`, `i${(i + 1) % 10}`] });
  const split = splitCases(cases, 7, 0.6, 0.2);
  assert.equal(split.train.length + split.heldout.length + split.test.length, 50);
  const all = [...split.train, ...split.heldout, ...split.test];
  assert.equal(new Set(all).size, 50);
  assert.ok(split.heldout.length > 0 && split.test.length > 0);
  const preview = splitPreview(cases, 7, 0.6, 0.2);
  assert.ok(preview.coverage.heldoutIntents >= 8);
  assert.ok(preview.coverage.advice === null || /train 比例|补题|覆盖/.test(preview.coverage.advice));
});
