'use strict';

// Protocol 3: legacy expected_intents remain unique ID sets. Opt-in expected_tasks
// are task instances: {intent_id, task_id?, task_index?/order?, slots?, span?,
// depends_on?: [task_id|1-based task index]}. Only explicitly supplied constraints
// are scored. Expected slots use subset matching; scalar types are significant.
// expected_clarification optionally supplies max_options, max_extra_options,
// min_precision and question_terms (every term must occur in a visible question).
// expected_turns is for evaluateConversationQuality only: no session/model call is
// invented by the batch runner. Protocol 2 scores are stale and not comparable.
const SCORING_CAPABILITIES = Object.freeze({ protocol: 3, legacyIntentSets: true,
  taskInstances: true, clauseDiagnostics: true, clarificationPrecision: true,
  offlineConversationQuality: true, runtimeMultiTurn: false });
const {captureEvidence}=require('./rsi-reasoning');
const unique = xs => [...new Set(xs)];
const ids = rows => (rows || []).map(r => r.intent_id || r.value).filter(Boolean);
const f1 = (precision, recall) => precision + recall ? 2 * precision * recall / (precision + recall) : 0;
const equal = (a, b) => {
  if (a === b) return true;
  if (a == null || b == null) return a == b;
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa === sb) return true;
  // key 顺序不同但语义相同的对象：排序 key 后再比较
  try { return JSON.stringify(a, Object.keys(a).sort()) === JSON.stringify(b, Object.keys(b).sort()); } catch (_) { return false; }
};

function validateGold(c) {
  if (c.intent_shape != null && !['single_intent', 'multi_intent', 'ambiguous_intent', 'negative_intent'].includes(c.intent_shape)) throw new Error('Unsupported intent_shape');
  if (c.intent_shape === 'negative_intent' && (c.expected_tasks !== undefined || !Array.isArray(c.expected_intents) || c.expected_intents.length)) throw new Error('negative_intent 负例必须使用空 expected_intents，不接受业务任务或旧排除名单');
  if (c.expected_tasks !== undefined) {
    if (!Array.isArray(c.expected_tasks) || !c.expected_tasks.length) throw new Error('expected_tasks must be a non-empty task array');
    const names = new Set();
    for (const t of c.expected_tasks) {
      if (!t || typeof t.intent_id !== 'string' || !t.intent_id.trim()) throw new Error('expected_tasks[].intent_id is required');
      if (t.slots != null && (typeof t.slots !== 'object' || Array.isArray(t.slots))) throw new Error('expected_tasks[].slots must be an object');
      if (t.task_id != null && (typeof t.task_id !== 'string' || !t.task_id || names.has(t.task_id))) throw new Error('expected_tasks[].task_id must be unique');
      if (t.task_id) names.add(t.task_id);
      for (const key of ['task_index', 'order']) if (t[key] != null && (!Number.isInteger(t[key]) || t[key] < 1)) throw new Error(`expected_tasks[].${key} must be a positive integer`);
      if (t.depends_on != null && !Array.isArray(t.depends_on)) throw new Error('expected_tasks[].depends_on must be an array');
    }
    for (const t of c.expected_tasks) for (const d of t.depends_on || []) {
      if (!(typeof d === 'string' && names.has(d)) && !(Number.isInteger(d) && d >= 1 && d <= c.expected_tasks.length)) throw new Error('expected_tasks[].depends_on references an unknown task');
    }
  }
  if (c.expected_intents !== undefined && (!Array.isArray(c.expected_intents) || c.expected_intents.some(x => typeof x !== 'string' || !x))) throw new Error('expected_intents must be an intent ID array');
  if (c.intent_shape !== 'negative_intent' && !c.expected_tasks && !c.expected_intents?.length) throw new Error('expected_intents must be non-empty when expected_tasks is absent');
  const policy = c.expected_clarification || {};
  for (const k of ['max_options', 'max_extra_options']) if (policy[k] != null && (!Number.isInteger(policy[k]) || policy[k] < 0)) throw new Error(`expected_clarification.${k} must be a nonnegative integer`);
  if (policy.min_precision != null && (!Number.isFinite(policy.min_precision) || policy.min_precision < 0 || policy.min_precision > 1)) throw new Error('expected_clarification.min_precision must be 0..1');
  if (policy.question_terms != null && (!Array.isArray(policy.question_terms) || policy.question_terms.some(t => typeof t !== 'string' || !t))) throw new Error('expected_clarification.question_terms must be strings');
}

function locateSpan(query, text, from = 0) {
  const start = String(query || '').indexOf(text, from);
  return text && start >= 0 ? { start, end: start + text.length, text, offset_unit: 'utf16' } : null;
}

function extractPrediction(res, query = '') {
  let cursor = 0;
  const segments = (res.segment_results || []).map((seg, i) => {
    const span = seg.span || locateSpan(query, seg.query, cursor);
    if (span) cursor = span.end;
    const topk = unique([...(seg.authoritative_results || []),
      ...(seg.methods?.llm_judge?.top || []), ...(seg.methods?.local?.top || []),
      ...(seg.methods?.embedding?.top || []), ...(seg.methods?.graph?.top || [])].map(r => r.intent_id).filter(Boolean));
    return { segment_index: seg.segment_index || i + 1, query: seg.query || '', span,
      span_status: span ? 'aligned' : 'unavailable_rewritten_segment',
      top1: seg.final_result?.intent_id || '', topk,
      slots: seg.understanding?.slots || {},
      tasks: seg.understanding?.tasks || [], trace: seg.methods?.llm_judge?.decision_trace || null };
  });
  let tasks = res.understanding?.tasks;
  if (!Array.isArray(tasks) || !tasks.length) {
    tasks = (res.segment_results || []).flatMap((seg, i) => {
      const nested = seg.understanding?.tasks;
      return Array.isArray(nested) && nested.length ? nested.map(t => ({ ...t, segment_index: seg.segment_index || i + 1 }))
        : seg.final_result?.intent_id ? [{ ...seg.final_result, segment_index: seg.segment_index || i + 1, slots: seg.understanding?.slots || {} }] : [];
    });
  }
  if (!tasks.length && res.final_result?.intent_id && res.final_result?.semantic_role !== 'summary_only') tasks = [{ ...res.final_result, slots: res.understanding?.slots || {} }];
  tasks = tasks.map((t, i) => ({ ...t, task_id: t.task_id || `pred_${i + 1}`, task_index: t.task_index ?? i + 1,
    slots: { ...(t.payee !== undefined ? { payee: t.payee } : {}), ...(t.amount !== undefined ? { amount: t.amount } : {}), ...(t.slots || {}) },
    span: t.span || segments.find(s => s.segment_index === t.segment_index)?.span || null,
    depends_on: t.depends_on || [] }));
  return { tasks, segments, predSet: unique(tasks.map(t => t.intent_id).filter(Boolean)) };
}

function constraintDifferences(gold, pred) {
  const fields = [];
  if (gold.intent_id !== pred.intent_id) fields.push('intent_id');
  const expectedOrder = gold.order ?? gold.task_index;
  if (expectedOrder !== undefined && expectedOrder !== (pred.order ?? pred.task_index)) fields.push('task_index');
  const subset = (expected, actual, prefix) => {
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      for (const [k, v] of Object.entries(expected)) subset(v, actual?.[k], `${prefix}.${k}`);
    } else if (!equal(expected, actual)) fields.push(prefix);
  };
  if (gold.slots) subset(gold.slots, pred.slots || {}, 'slots');
  if (gold.span) subset(gold.span, pred.span, 'span');
  return fields;
}

function scoreTaskInstances(expected, predicted) {
  // Maximum bipartite matching prevents a wildcard task from stealing the only
  // instance that satisfies a more specific duplicate-intent gold task.
  const owner = new Map();
  function visit(g, seen) {
    for (let p = 0; p < predicted.length; p++) {
      if (seen.has(p) || constraintDifferences(expected[g], predicted[p]).length) continue;
      seen.add(p);
      if (!owner.has(p) || visit(owner.get(p), seen)) { owner.set(p, g); return true; }
    }
    return false;
  }
  for (let g = 0; g < expected.length; g++) visit(g, new Set());
  let mapping = new Map([...owner].map(([p, g]) => [g, p]));
  const wrong = [];
  const goldIndex = d => typeof d === 'number' ? d - 1 : expected.findIndex(t => t.task_id === d);
  const predIndex = d => typeof d === 'number' ? predicted.findIndex(t => t.task_index === d) : predicted.findIndex(t => t.task_id === d);
  // Duplicate intent instances can have several maximum matchings. Find a
  // dependency-consistent full mapping before diagnosing the incidental first
  // matching as wrong. Partial failures still retain the explicit field errors.
  if (mapping.size === expected.length && expected.length === predicted.length && expected.some(t => t.depends_on !== undefined)) {
    const choices = expected.map(g => predicted.map((p, i) => i).filter(i => !constraintDifferences(g, predicted[i]).length
      && (g.depends_on === undefined || unique(g.depends_on).length === unique(predicted[i].depends_on || []).length)));
    const order = expected.map((_, i) => i).sort((a, b) => choices[a].length - choices[b].length);
    const trial = new Map(), taken = new Set();
    function consistent() {
      for (const [g, p] of trial) {
        if (expected[g].depends_on === undefined) continue;
        const actual = (predicted[p].depends_on || []).map(predIndex);
        if (actual.some(i => i < 0)) return false;
        for (const d of expected[g].depends_on) {
          const target = goldIndex(d);
          if (trial.has(target) && !actual.includes(trial.get(target))) return false;
        }
        for (const [other, mapped] of trial) {
          if (actual.includes(mapped) && !expected[g].depends_on.map(goldIndex).includes(other)) return false;
        }
      }
      return true;
    }
    function search(depth) {
      if (depth === order.length) return true;
      const g = order[depth];
      for (const p of choices[g]) {
        if (taken.has(p)) continue;
        trial.set(g, p); taken.add(p);
        if (consistent() && search(depth + 1)) return true;
        trial.delete(g); taken.delete(p);
      }
      return false;
    }
    if (search(0)) mapping = trial;
  }
  const invalid = [];
  for (const [g, p] of mapping) {
    if (expected[g].depends_on === undefined) continue;
    const wanted = expected[g].depends_on.map(goldIndex).map(i => mapping.get(i));
    const actual = (predicted[p].depends_on || []).map(predIndex);
    if (wanted.some(i => i === undefined) || actual.some(i => i < 0) || !equal(unique(wanted).sort(), unique(actual).sort())) {
      wrong.push({ expected_index: g + 1, predicted_index: p + 1, fields: ['depends_on'] }); invalid.push(g);
    }
  }
  for (const g of invalid) { owner.delete(mapping.get(g)); mapping.delete(g); }
  const unpairedGold = expected.map((_, i) => i).filter(i => !mapping.has(i) && !invalid.includes(i));
  const usedPred = new Set([...mapping.values(), ...wrong.map(r => r.predicted_index - 1)]);
  const unpairedPred = predicted.map((_, i) => i).filter(i => !usedPred.has(i));
  // Diagnose aligned-but-wrong task instances separately from genuinely absent
  // or hallucinated tasks. The score still counts every wrong task as unmatched.
  for (let gi = unpairedGold.length - 1; gi >= 0; gi--) {
    const g = unpairedGold[gi];
    const match = unpairedPred.findIndex(p => predicted[p].task_index === (expected[g].order ?? expected[g].task_index ?? g + 1));
    if (match < 0) continue;
    const p = unpairedPred.splice(match, 1)[0];
    wrong.push({ expected_index: g + 1, predicted_index: p + 1, fields: constraintDifferences(expected[g], predicted[p]) });
    unpairedGold.splice(gi, 1);
  }
  const hits = mapping.size;
  const precision = predicted.length ? hits / predicted.length : 0;
  const recall = expected.length ? hits / expected.length : 0;
  return { strict: hits === expected.length && hits === predicted.length, relaxed: f1(precision, recall),
    task_quality: { matched: hits, expected: expected.length, predicted: predicted.length, precision, recall },
    diagnosis: { missing: unpairedGold.map(i => ({ ...expected[i], expected_index: i + 1 })),
      extra: unpairedPred.map(i => ({ ...predicted[i], predicted_index: i + 1 })), wrong } };
}

function scoreIntentCase(c, res) {
  validateGold(c);
  const shape = c.intent_shape || 'single_intent';
  const expected = unique(c.expected_intents?.length ? c.expected_intents : (c.expected_tasks || []).map(t => t.intent_id));
  const { tasks, segments, predSet } = extractPrediction(res, c.query);
  const clarification = res.understanding?.clarification || {};
  const clarifying = clarification.needed === true || clarification.needed === 'true' || clarification.needed === 1;
  const rawCandidates = ids(clarification.options || clarification.questions?.flatMap(q => q.options || []) || []);
  const candidates = unique(rawCandidates);
  const top1 = res.final_result?.intent_id || '';
  const topk = unique([...(res.authoritative_results || []), ...(res.methods?.llm_judge?.top || []),
    ...(res.methods?.local?.top || []), ...(res.methods?.embedding?.top || []),
    ...(res.methods?.graph?.top || [])].map(r => r.intent_id).filter(Boolean));
  // 多路召回候选（带分数）：merged topk 供 RSI 概览页离线推导召回/裁决指标
  const rankSources = [...(res.authoritative_results || []), ...(res.methods?.llm_judge?.top || []),
    ...(res.methods?.local?.top || []), ...(res.methods?.embedding?.top || []),
    ...(res.methods?.graph?.top || [])];
  const topkScored = [], seenRank = new Set();
  for (const it of rankSources) {
    const id = it && it.intent_id;
    if (!id || seenRank.has(id)) continue;
    seenRank.add(id);
    const sc = typeof it.score === 'number' ? it.score : (typeof it.confidence === 'number' ? it.confidence : null);
    topkScored.push({ intent_id: id, score: sc });
  }
  const row = { case_id: c.case_id, query: c.query, shape, expected,
    ...(c.expected_tasks ? { expected_tasks: c.expected_tasks } : {}), strict: false, relaxed: 0, resultType: '',
    engine_top1: top1, engine_clarifying: clarifying, engine_candidates: rawCandidates, engine_topk: topkScored,
    engine_pred_set: predSet, engine_tasks: tasks, engine_segments: segments,
    diagnosis: { missing: [], extra: [], wrong: [] }, evidence:captureEvidence(res) };
  if (shape === 'multi_intent' || c.expected_tasks && shape === 'single_intent') {
    if (c.expected_tasks) Object.assign(row, scoreTaskInstances(c.expected_tasks, tasks));
    else {
      const hits = expected.filter(id => predSet.includes(id)).length;
      const union = unique([...expected, ...predSet]).length;
      row.diagnosis.missing = expected.filter(id => !predSet.includes(id));
      row.diagnosis.extra = predSet.filter(id => !expected.includes(id));
      row.strict = !row.diagnosis.missing.length && !row.diagnosis.extra.length;
      row.relaxed = union ? hits / union : 0;
    }
    const d = row.diagnosis;
    row.resultType = row.strict ? 'correct' : d.missing.length && d.extra.length ? 'multi_missing_extra'
      : d.extra.length ? 'multi_extra' : d.wrong.length ? 'multi_wrong' : 'multi_missing';
    if (clarifying && row.strict) { row.strict = false; row.resultType = 'unexpected_clarification'; }
  } else if (shape === 'single_intent') {
    row.strict = !clarifying && expected.includes(top1);
    row.relaxed = topk.some(id => expected.includes(id)) ? 1 : 0;
    row.resultType = row.strict ? 'correct' : clarifying ? (expected.every(e => candidates.includes(e)) ? 'clarify_ok_set' : 'clarify_missing_expected')
      : row.relaxed ? 'rank_error' : top1 ? 'wrong_label' : 'recall_miss';
  } else if (shape === 'ambiguous_intent') {
    const hits = expected.filter(e => candidates.includes(e)).length;
    const coverage = hits / expected.length;
    const precision = rawCandidates.length ? hits / rawCandidates.length : 0;
    const extras = candidates.filter(id => !expected.includes(id));
    const duplicates = rawCandidates.length - candidates.length;
    const policy = c.expected_clarification || {};
    const question = clarification.question || (clarification.questions || []).map(q => q.question || '').join(' ');
    const missingTerms = (policy.question_terms || []).filter(term => !question.includes(term));
    const answerable = !!question.trim() && !missingTerms.length;
    const excessive = extras.length > (policy.max_extra_options ?? 0) || duplicates > 0
      || rawCandidates.length > (policy.max_options ?? expected.length) || precision < (policy.min_precision ?? 1);
    row.clarification_quality = { coverage, precision, f1: f1(precision, coverage),
      option_count: rawCandidates.length, extra_count: extras.length, duplicate_count: duplicates,
      answerable, missing_question_terms: missingTerms, question_quality_mode: policy.question_terms ? 'gold_terms' : 'nonempty_only' };
    row.diagnosis.missing = expected.filter(id => !candidates.includes(id));
    row.diagnosis.extra = extras;
    row.strict = clarifying && coverage === 1 && !excessive && answerable;
    row.relaxed = clarifying ? f1(precision, coverage) * (answerable ? 1 : 0.5) : 0;
    row.resultType = row.strict ? 'correct' : !clarifying ? 'clarify_not_triggered'
      : !answerable ? 'clarify_unanswerable' : excessive ? 'clarify_extra_options' : 'clarify_missing_expected';
  } else if (shape === 'negative_intent') {
    // Retrieval may return weak candidates for any query. Only authoritative
    // business tasks/final answers or offered business options violate rejection.
    row.diagnosis.extra = unique([...predSet, top1, ...candidates].filter(Boolean));
    row.strict = row.diagnosis.extra.length === 0;
    row.relaxed = row.strict ? 1 : 0;
    row.resultType = row.strict ? 'correct' : 'negative_violation';
  } else throw new Error(`Unsupported intent_shape: ${shape}`);
  return row;
}

function evaluateConversationQuality(gold, observations) {
  if (!Array.isArray(gold.expected_turns) || !gold.expected_turns.length) throw new Error('expected_turns must be a non-empty gold turn array');
  if (!Array.isArray(observations)) throw new Error('observations must be an array');
  const rows = gold.expected_turns.map((turn, i) => observations[i] ? scoreIntentCase(turn, observations[i])
    : { strict: false, relaxed: 0, resultType: 'missing_turn' });
  const last = rows[rows.length - 1];
  const complete = observations.length === rows.length;
  const converged = complete && last.strict && last.engine_clarifying === false;
  return { mode: 'offline_observations', runtimeMultiTurn: false, strict: complete && converged && rows.every(r => r.strict),
    converged, expected_turns: rows.length, observed_turns: observations.length,
    clarification_turns: rows.filter(r => r.engine_clarifying).length,
    relaxed: rows.reduce((n, r) => n + r.relaxed, 0) / rows.length, rows };
}

module.exports = { SCORING_CAPABILITIES, validateGold, locateSpan, extractPrediction, scoreTaskInstances, scoreIntentCase, evaluateConversationQuality };
