'use strict';
const crypto = require('node:crypto');
const { normalizeProfile } = require('./rsi-runtime-profile');
const TARGETS = {
  graph: { label: '图谱', status: 'ready', methods: ['reflective_search'] },
  recognition_prompt: { label: '识别提示词', status: 'ready', methods: ['reflective_search', 'gepa'] },
  engine: { label: '意图引擎参数与规则', status: 'ready', methods: ['reflective_search', 'parameter_search'] },
  optimizer_prompt: { label: '提案器提示词', status: 'ready', methods: ['reflective_search'] },
  engine_code: { label: '引擎代码', status: 'reserved', methods: ['sandbox_code_mutation'], reason: '需接隔离构建与代码评测适配器' },
  model: { label: '模型训练', status: 'reserved', methods: ['training'], reason: '模型训练适配器尚未接入' },
};
const METHODS = {
  reflective_search: { label: '失败轨迹反思', status: 'ready' },
  parameter_search: { label: '参数候选搜索', status: 'ready' },
  gepa: { label: 'GEPA', status: 'requires_setup', reason: '尚未接入开源 gepa.optimize，当前为自定义反思/变异循环' },
  sandbox_code_mutation: { label: '隔离代码变异', status: 'reserved' },
  training: { label: '模型训练', status: 'reserved' },
};
function capabilityRegistry() {
  return { schema: 1, targets: JSON.parse(JSON.stringify(TARGETS)), methods: JSON.parse(JSON.stringify(METHODS)),
    memberOptimizer: { status: 'unavailable', reason: 'optimize/apply/reject 尚无生产实现' }, fusion: false,
    evaluation: require('./rsi-case-scoring').SCORING_CAPABILITIES,
    graphOperators: {
      A1: { status: 'ready', scope: 'utterances/scope_in; affects single and multi intent recall' },
      A2: { status: 'ready', scope: 'disambiguation hints; declaration-aware scoring' },
      A3: { status: 'ready', scope: 'clause_view enters shared candidate text and scoring; affects single and multi intent' },
      A4: { status: 'ready', scope: 'negative declarations; declaration-aware scoring' },
      A5: { status: 'ready', scope: 'clarify_questions consumed only for established ambiguity and relevant candidates' },
      A6: { status: 'ready', scope: 'shared complete utterance declarations establish ambiguity and restrict the clarification option set' },
    },
  };
}
function positive(v, fallback, name, max) {
  if (v == null) return fallback;
  if (!Number.isInteger(v) || v < 1 || v > max) throw new Error(`${name}须为 1–${max} 的整数`);
  return v;
}
function normalizeOptimizationConfig(opts = {}, capabilities = METHODS) {
  if (opts.allowMerge === true) throw new Error('候选融合 fusion 尚未启用');
  const requested = opts.targets ?? opts.improveLayers ?? ['graph'];
  if (!Array.isArray(requested) || !requested.length) throw new Error('至少选择一条优化路径');
  const targets = [...new Set(requested.map(t => t === 'prompt' ? 'recognition_prompt' : t === 'code' ? 'engine' : t))];
  for (const t of targets) {
    if (!TARGETS[t] || TARGETS[t].status !== 'ready') throw new Error(TARGETS[t]?.reason || `未知优化路径：${t}`);
  }
  const routes = targets.map(t => {
    const method = opts.methods?.[t] || opts.optimizer || (t === 'engine' ? 'parameter_search' : 'reflective_search');
    if (!capabilities[method] || capabilities[method].status !== 'ready') throw new Error(`优化方法 ${method} 不可运行：${capabilities[method]?.reason || '尚未接入'}`);
    if (!TARGETS[t].methods.includes(method)) throw new Error(`方法 ${method} 不支持路径 ${t}`);
    return { id: `${t}:${method}`, target: t, method };
  });
  const branching = opts.branching || 'path';
  if (!['path', 'failure_family', 'hybrid'].includes(branching)) throw new Error('未知分支划分策略');
  const parentPolicy = opts.parentPolicy || 'champion';
  if (!['champion', 'pareto_population'].includes(parentPolicy)) throw new Error('未知代际输入策略');
  return { schema: 1, targets, routes, branching, parentPolicy, allowMerge: false,
    budget: { maxMetricCalls: positive(opts.maxMetricCalls, 120, '评测预算', 10000), maxMinutes: positive(opts.maxMinutes, 60, '时间预算', 1440) },
  };
}
function canonical(obj) {
  if (Array.isArray(obj)) return obj.map(canonical);
  if (obj && typeof obj === 'object') return Object.fromEntries(Object.keys(obj).sort().map(k => [k, canonical(obj[k])]));
  return obj;
}
function assetHash(graph) { return crypto.createHash('sha256').update(JSON.stringify(canonical(graph))).digest('hex'); }
function makeBundle(graph, baseVersion, parents = []) {
  const frozen = JSON.parse(JSON.stringify(graph));
  return { schema: 1, hash: assetHash(frozen), graph: frozen, baseVersion, parents: [...parents] };
}
function assertBundle(bundle) {
  if (!bundle?.graph || bundle.schema !== 1 || assetHash(bundle.graph) !== bundle.hash) throw new Error('候选资产完整性校验失败，需重新评测');
  normalizeProfile(bundle.graph.meta?.rsi_runtime || {});
  return JSON.parse(JSON.stringify(bundle.graph));
}
function mutateRuntime(graph, mutation) {
  const next = JSON.parse(JSON.stringify(graph));
  next.meta ||= {};
  const profile = normalizeProfile(next.meta.rsi_runtime || {});
  if (mutation.target === 'recognition_prompt') profile.prompts[mutation.component || 'judge'] = mutation.text;
  else if (mutation.target === 'engine') Object.assign(profile.engine, mutation.parameters);
  else if (mutation.target === 'optimizer_prompt') profile.optimizerPrompt = mutation.text;
  else throw new Error('未知运行时变异路径');
  next.meta.rsi_runtime = normalizeProfile(profile);
  return next;
}
function mergeRuntime(a, b) {
  const pa = normalizeProfile(a.meta?.rsi_runtime || {}), pb = normalizeProfile(b.meta?.rsi_runtime || {});
  for (const key of ['prompts', 'engine']) {
    for (const [k, v] of Object.entries(pb[key])) {
      if (pa[key][k] != null && JSON.stringify(pa[key][k]) !== JSON.stringify(v)) throw new Error(`融合冲突：${key}.${k}`);
      pa[key][k] = v;
    }
  }
  if (pa.optimizerPrompt && pb.optimizerPrompt && pa.optimizerPrompt !== pb.optimizerPrompt) throw new Error('融合冲突：优化器提示词');
  pa.optimizerPrompt ||= pb.optimizerPrompt;
  return pa;
}
function methodRecord(branch, input, runId, gen) {
  const trainGain = branch.scores?.train?.strict_pct != null && input?.train?.strict_pct != null ? branch.scores.train.strict_pct - input.train.strict_pct : null;
  const validationGain = branch.scores?.heldout?.strict_pct != null && input?.heldout?.strict_pct != null ? branch.scores.heldout.strict_pct - input.heldout.strict_pct : null;
  return { id: `${runId}:${branch.id}`, runId, gen, branch: branch.id, target: branch.target || 'graph', method: branch.method || 'reflective_search',
    hypothesis: branch.summary || branch.opLabel || branch.op, mutation: branch.runtimeMutation || null,
    trainGain, validationGain, status: branch.gatePassed && trainGain > 0 ? 'observed_gain' : branch.gatePassed ? 'no_gain' : 'rejected',
    reason: branch.gateReason || null, independentValidated: false, artifactHash: branch.artifactHash || null,
  };
}
module.exports = { TARGETS, METHODS, capabilityRegistry, normalizeOptimizationConfig, makeBundle, assertBundle, assetHash, mutateRuntime, mergeRuntime, methodRecord,
  ...require('./rsi-learning') };
