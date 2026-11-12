const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

test('unsupported selected methods fail preflight instead of falling back to graph', () => {
  const { normalizeOptimizationConfig } = require('../routes/rsi-optimization');
  assert.throws(() => normalizeOptimizationConfig({ improveLayers: ['model'] }), /训练/);
  assert.throws(() => normalizeOptimizationConfig({ improveLayers: ['recognition_prompt'], optimizer: 'unknown' }), /方法/);
  const cfg = normalizeOptimizationConfig({ improveLayers: ['recognition_prompt', 'engine'], branching: 'path', parentPolicy: 'pareto_population', maxMetricCalls: 30 });
  assert.deepEqual(cfg.targets, ['recognition_prompt', 'engine']);
  assert.equal(cfg.parentPolicy, 'pareto_population');
  assert.equal(cfg.budget.maxMetricCalls, 30);
});

test('bundle survives multiple mutations and cannot be silently tampered with', () => {
  const { makeBundle, assertBundle, mutateRuntime } = require('../routes/rsi-optimization');
  const base = { meta: {}, intent_nodes: [{ identity: { intent_id: 'a' } }] };
  const one = mutateRuntime(base, { target: 'recognition_prompt', component: 'judge', text: '遇到对象缺失先澄清。' });
  const two = mutateRuntime(one, { target: 'engine', parameters: { hintWeight: 0.4 } });
  const bundle = makeBundle(two, 'v1', ['first', 'second']);
  assert.equal(assertBundle(bundle).meta.rsi_runtime.prompts.judge, '遇到对象缺失先澄清。');
  assert.equal(bundle.graph.meta.rsi_runtime.engine.hintWeight, 0.4);
  bundle.graph.intent_nodes = [];
  assert.throws(() => assertBundle(bundle), /完整性/);
});

test('conflicting runtime components cannot merge unnoticed', () => {
  const { mergeRuntime, mutateRuntime } = require('../routes/rsi-optimization');
  const root = { meta: {}, intent_nodes: [] };
  const a = mutateRuntime(root, { target: 'recognition_prompt', component: 'judge', text: '甲' });
  const b = mutateRuntime(root, { target: 'recognition_prompt', component: 'judge', text: '乙' });
  assert.throws(() => mergeRuntime(a, b), /冲突/);
});

test('runtime profiles are confined to explicitly selected asset files', () => {
  const { loadRuntimeProfile, runtimeParameter, runtimeInstruction } = require('../routes/rsi-runtime-profile');
  assert.deepEqual(loadRuntimeProfile(), { prompts: {}, engine: {}, optimizerPrompt: '' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-profile-test-'));
  try {
    const file = path.join(dir, 'graph.json');
    fs.writeFileSync(file, JSON.stringify({ meta: { rsi_runtime: { prompts: { judge: '测试指令' }, engine: { hintWeight: 0.4 } } } }));
    const profile = loadRuntimeProfile(file);
    assert.equal(runtimeParameter(profile, 'hintWeight', 0.28), 0.4);
    assert.equal(runtimeInstruction(profile, 'judge'), '测试指令');
    assert.equal(runtimeParameter(profile, 'unsupported', 7), 7);
  } finally { fs.rmSync(dir, { recursive: true }); }
});
