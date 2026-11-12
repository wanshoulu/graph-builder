'use strict';

/**
 * 意图 RSI 进化实验台（intent-rsi-lab）后端
 *
 * 定位：按《意图图谱+引擎 RSI 进化方案 v3》实现六环闭环的最小可运行版（E1 MVP）。
 * 零耦合约束：不读不改 data/graphs 现有图谱资产、不改生产意图引擎；
 * 使用 data/rsi/ 下自有同构 schema 图谱与题库，验证器为本文件内置的
 * 轻量声明驱动 matcher（评测口径与生产引擎不同，仅用于闭环演示）。
 * 验证器对照：scripts/rsi-engine-calibrate.js 以独立子进程调用生产引擎 evaluateIntent
 * 对同一题库打分（require.cache 注入图谱指向 + 清空 API key 保证离线确定性、
 * 不写 data/graphs 生产缓存），输出一致率报告供前端展示——只读调用，零侵入。
 *
 * 六环：归因结构化 → 变异提案器(LLM) → 级联评测 Runner(train初筛→held-out门禁)
 *       → 门禁选择(Pareto标记) → 人工采纳(本 API + 前端审阅台) → 固化(版本化+日志)。
 * 防自证：held-out 切分在首次初始化时按固定 seed 完成并持久化，变异器只见 train 侧归因样例；
 *         提案 schema 白名单校验；采纳即版本化，全量历史可回溯。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { API_ROUTES } = require('../config/api-keys');
const taskContext = require('./rsi-task-context');
const { writeJson, preserveTask, readStateJson, readStateJsonAsync } = require('./rsi-task-store');
const { readSnapshotInfo, manifestCatalog } = require('./rsi-asset-catalog');
const { normalizeCases, splitCases, splitPreview } = require('./rsi-task-dataset');
const goalLib = require('./rsi-goal');
const measurementPolicyLib = require('./rsi-measurement-policy');
const { trainingRow } = require('./rsi-reasoning');
const { buildGraphIndex, graphRecall } = require('./rsi-graph-recall');
const { engineRevision } = require('./rsi-engine-revision');
const { buildCaseReview } = require('./rsi-case-review');

const ROOT = path.join(__dirname, '..');
const RSI_DIR = process.env.INTENT_RSI_DIR ? path.resolve(process.env.INTENT_RSI_DIR) : path.join(ROOT, 'data', 'rsi');
const GRAPH_V1_PATH = path.join(RSI_DIR, 'rsi-graph.v1.json');
const VERSIONS_DIR = path.join(RSI_DIR, 'versions');
const SNAPSHOTS_DIR = path.join(RSI_DIR, 'snapshots');
const CALIB_DIR = path.join(RSI_DIR, 'calibration');
const HELDOUT_ARCHIVE_DIR = path.join(RSI_DIR, 'heldout-archive');
// 恢复园区任务数据源（f92e176e 曾有，后被误删导致前端 park 视图 404）
const PARK_HISTORY_PATH = path.join(RSI_DIR, 'park-history.json');
const PARK_CALIB_SCRIPT = path.join(__dirname, '..', 'scripts', 'park-engine-calibrate.js');
const ENGINE_SCORE_SCRIPT = path.join(__dirname, '..', 'scripts', 'rsi-engine-score.js');
const DRAFTS_DIR = path.join(RSI_DIR, 'drafts');
const CASES_PATH = path.join(RSI_DIR, 'rsi-eval-cases.json');
const CASES_IMPORTED_PATH = path.join(RSI_DIR, 'rsi-eval-cases.imported.json');
const MANIFEST_PATH = path.join(ROOT, 'data', 'graphs', 'intent-graph-version-manifest.json');
const STATE_PATH = path.join(RSI_DIR, 'rsi-state.json');

const SPLIT_SEED = 20261002;
const TRAIN_RATIO = 0.7;
const TOPK = 5;
const MAX_PROPOSALS_PER_RUN = 6;
const SUBCLAUSE_MIN_SCORE = 0.30; // 归因诊断用门槛（引擎参数化为 ep.subclause_min，此常量仅 attributeResults 归因引用）

// 引擎参数默认值 — 原为硬编码常量，现参数化以支持 E1_engine_param 变异
const DEFAULT_ENGINE_PARAMS = {
  w_utt: 0.55,          // utterance 召回路径权重
  w_obj: 0.25,          // object 关键词路径权重
  w_act: 0.20,          // action 关键词路径权重
  sem_decay: 0.9,       // semantic_view 衰减系数
  hint_decay: 0.85,     // disambiguation_hints 衰减系数
  score_cap: 0.95,      // 非精确命中分数上限
  clarify_low: 0.42,    // 低置信澄清阈值
  clarify_gap: 0.10,    // 混淆对接近间隙
  subclause_min: 0.30,  // 子句最低门槛
  no_match_floor: 0.08, // 无匹配地板值
  close_conf_ceil: 0.75, // 混淆对澄清时 top1 分数上限
  // 图召回通道：从词法高置信候选沿图谱关系扩展，与词法联合排序
  graph_weight: 0.3,        // 图候选对排序的加成权重
  graph_seed_floor: 0.3,    // 触发图扩展的种子最低分
  graph_row_floor: 0.2,     // 图召回候选最低分
  graph_confusable_weight: 1.0,
  graph_object_weight: 0.85,
  graph_action_weight: 0.7,
  graph_sibling_weight: 0.55,
};

const OPS = {
  A1_utterance_expand: { label: '补充说法', fields: ['add_utterances'] },
  A2_disambiguation: { label: '增强区分线索', fields: ['add_hints', 'add_scope_out?', 'confusable?'] },
  A3_clause_expansion: { label: '补充短句说法', fields: ['add_clause_views'] },
  A4_description_rewrite: { label: '改写意图描述', fields: ['new_description'] },
  A5_clarify: { label: '增加澄清问题', fields: ['add_clarify_question'] },
  // 歧义簇扩展：一道模糊坏例的期望答案通常是 2–4 个意图，A1 一次只能改一个 target
  // 永远凑不齐整簇（审计 7.7：5 道未触发 + 8 道选项过多的主修法）。targets 全部存在才算合法。
  A6_ambiguity_cluster_expand: { label: '歧义簇扩展（多意图同时补说法）', fields: ['add_utterances', 'targets[]'] },
  // 组合提案（审计 9.4/9.6）：A6 簇扩展把「该澄清没触发」搬到「选项过多」后，必须对
  // 抢答/多余选项的竞争意图做 A2 scope_out 收边才能到 strict——打包为一个候选一起评测
  combo: { label: '组合提案（A6 簇扩展 + A2 收边）', fields: ['parts'] },
  // 引擎参数变异：调整验证器权重/阈值
  E1_engine_param: { label: '引擎参数调优', fields: ['engine_params'] },
  // 提示词变异：LLM 改写识别/裁决提示词表述
  P1_prompt_variant: { label: '提示词变体', fields: ['prompt_variant'] },
};

// ───────────────────────── 基础工具 ─────────────────────────

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function defaultStats() {
  return { proposeRuns: 0, llmCalls: 0, proposalsTotal: 0, noveltyFiltered: 0, evaluated: 0, passed: 0, adopted: 0, rejected: 0 };
}

function casesPathOf(st) {
  return st && st.casesFile === 'imported' ? CASES_IMPORTED_PATH : CASES_PATH;
}
function readCases(st) {
  // 任务化：imported 题库优先读当前任务目录里的副本（gen-cases 重开只污染本任务）
  const p = taskCasesPathOf(st && st.taskId, st && st.casesFile);
  if (!fs.existsSync(p)) throw taskContext.fail('任务题库缺失，请显式导入题库，禁止回退全局数据', 409);
  return readJson(p).cases;
}
function casesSha256Of(casesFile, st) {
  try {
    // 任务化：指纹跟当前任务的题库文件走（多任务各自独立防漂移）
    const p = taskCasesPathOf(st?.taskId || currentTaskId(), casesFile);
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16);
  } catch (e) {
    return null;
  }
}
function fileSha256Of(p) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16);
  } catch (e) {
    return null;
  }
}

// 当前评测上下文指纹——趋势线 comparability 用（与生产运行时 context() 同口径）
function currentContext(st) {
  const casesSha256 = (st.integrity && st.integrity.casesSha256) || casesSha256Of(st.casesFile || 'main', st);
  const splitSha256 = crypto.createHash('sha256').update(JSON.stringify(st.split)).digest('hex');
  return { casesSha256, splitSha256 };
}

// ───────────────────────── 任务级隔离存储（多任务系统核心） ─────────────────────────
// 每个任务一个目录 data/rsi/tasks/<id>/：state.json + cases.imported.json + rsi-graph.<v>.json。
// activeTask 指针存 data/rsi/active-task.json。loadState/saveState 全部路由到当前任务目录，
// gen-cases 等重置操作从此只影响本任务——14 日 15:37 曾发生全局 state 被一次 gen-cases 清空的事故。
const TASKS_DIR = path.join(RSI_DIR, 'tasks');
const ACTIVE_TASK_PATH = path.join(RSI_DIR, 'active-task.json');
const TASK_ID_RE = /^[a-z0-9][a-z0-9-]{2,47}$/;

function readActiveTaskId() {
  try { return readJson(ACTIVE_TASK_PATH).id || null; } catch (e) { return null; }
}
function currentTaskId() { const ctx = taskContext.current(); return ctx ? ctx.taskId : readActiveTaskId(); }
function taskArtifactDir(st, leaf, fallback) { return st?.taskId && st.taskId !== 'default' ? path.join(TASKS_DIR, st.taskId, leaf) : fallback; }
function writeActiveTaskId(id) {
  writeJson(ACTIVE_TASK_PATH, { id, at: new Date().toISOString() });
}
// 任务 id → 该任务的 state 文件路径；无任务系统数据时回落到全局 STATE_PATH（兼容旧部署）
function statePathOf(taskId) {
  if (!taskId) return STATE_PATH;
  return path.join(TASKS_DIR, taskId, 'state.json');
}
// 任务 id → 该任务的题库目录。任务内题库独立，gen-cases 重开只影响本任务
function taskCasesPathOf(taskId, casesFile) {
  taskId = taskId || currentTaskId();
  if (!taskId || (taskId === 'default' && !fs.existsSync(statePathOf(taskId)))) return casesPathOf({ casesFile });
  return path.join(TASKS_DIR, taskId, casesFile === 'imported' ? 'cases.imported.json' : 'cases.main.json');
}
function listTaskIds() {
  if (!fs.existsSync(TASKS_DIR)) return [];
  return fs.readdirSync(TASKS_DIR).filter(f => {
    try { return TASK_ID_RE.test(f) && fs.existsSync(path.join(TASKS_DIR, f, 'state.json')); } catch (e) { return false; }
  });
}

function isOrphanRun(st, workerTaskId) {
  return st.activeEvolution?.status === 'running' && workerTaskId !== st.taskId;
}
function loadState() {
  const taskId = currentTaskId();
  const sp = statePathOf(taskId);
  if (fs.existsSync(sp)) {
    const st = readStateJson(sp);
    if (!st.taskId) st.taskId = taskId || 'default';
    if (!st.stats) st.stats = defaultStats();
    if (!st.regression) st.regression = {};
    if (!st.baseGraph) st.baseGraph = { kind: 'seed', id: 'seed', label: '智慧园区种子图谱' };
    if (!st.casesFile) st.casesFile = 'main';
    if (!st.integrity) st.integrity = { casesSha256: null, splitSeed: SPLIT_SEED, at: null };
    if (!st.scoreHistory) st.scoreHistory = [];
    if (!st.engineParams) st.engineParams = { ...DEFAULT_ENGINE_PARAMS };
    if (!st.promptVariants) st.promptVariants = {};
    // 达标目标：旧任务没有该字段时补默认值（85%），不写盘，等下一次 saveState 落定。
    if (!st.goal) st.goal = { ...goalLib.DEFAULTS };
    st.revision ||= 0;
    // 孤儿运行自愈（10-17）：服务重启后进程内已无运行时，state 里残留的
    // activeEvolution.status='running' 会持续 409「已有任务运行中」。checkpoint
    // 不可用的运行无法恢复，加载时直接降级为 interrupted（原子写 + revision+1）。
    if (isOrphanRun(st, productionRuntime.runningTaskId?.())) {
      st.activeEvolution.status = 'interrupted';
      st.activeEvolution.stopReason = 'service_restart_orphan';
      st.log.push({ at: new Date().toISOString(), event: 'orphan-heal', detail: `检测到服务重启残留的运行中状态（run=${st.activeEvolution.id}），已标记 interrupted；有可用检查点时可从 runId 恢复` });
      writeJson(sp, { ...st, revision: st.revision + 1 });
      st.revision += 1;
    }
    if (!st.splitConfig && st.split) {
      const total = ['train', 'heldout', 'test'].reduce((n, k) => n + (st.split[k]?.length || 0), 0);
      st.splitConfig = { trainRatio: total ? st.split.train.length / total : TRAIN_RATIO, testRatio: total ? (st.split.test?.length || 0) / total : 0, seed: st.split.seed ?? SPLIT_SEED };
    }
    return st;
  }
  if (taskId) throw taskContext.fail('任务不存在: ' + taskId, 404);
  const st = initState();
  st.taskId = taskId || 'default';
  writeJson(sp, st);
  return st;
}
function saveState(st) {
  const ctx = taskContext.current();
  if (ctx?.explicit && st.taskId !== ctx.taskId) throw taskContext.fail('请求任务与保存对象不一致', 409);
  const taskId = st.taskId === 'default' && !fs.existsSync(statePathOf('default')) ? null : st.taskId;
  const target = statePathOf(taskId);
  const diskRevision = fs.existsSync(target) ? (readJson(target).revision || 0) : 0;
  if ((st.revision || 0) !== diskRevision) throw taskContext.fail('任务 revision 已变化，请刷新后重试', 409);
  writeJson(target, { ...st, revision: diskRevision + 1 });
  st.revision = diskRevision + 1;
}

function makeFreshState(baseGraph, casesFile, cases, splitOpts) {
  // 切分配置（10-16 多任务 P1）：train 比例与 seed 可按任务定制；testRatio>0 时额外切出
  // 终极考（test）集——test 必须在第一次考试前封存，开考后再补就失去「全程不可见」效力。
  // 默认值 = 全局旧行为（train 70%、无 test），存量任务不受影响。
  const ratio = Math.min(0.9, Math.max(0.3, Number(splitOpts && splitOpts.trainRatio) || TRAIN_RATIO));
  const seed = Number.isInteger(splitOpts && splitOpts.seed) ? (splitOpts.seed >>> 0) : SPLIT_SEED;
  const testRatio = Math.min(0.3, Math.max(0, Number(splitOpts && splitOpts.testRatio) || 0));
  const split = stratifiedSplit(cases, seed, ratio, testRatio);
  const label = baseGraph.kind === 'snapshot' ? `真实图谱快照 ${baseGraph.label}` : '初始种子图谱（含预埋声明覆盖缺口）';
  // 防自证第一道闸的封存件：切分时登记题库指纹——之后题库文件一旦被外部改动，
  // 历史成绩与新成绩不再可比，前端明示漂移警示（held-out 锚点连续性）
  const integrity = { casesSha256: casesSha256Of(casesFile), splitSeed: seed, at: new Date().toISOString() };
  return {
    currentVersion: 'v1',
    baseGraph,
    casesFile,
    integrity,
    split,
    goal: goalLib.normalizeGoal(splitOpts && splitOpts.goal),
    // 切分配置存档（10-16 遗留修复）：gen-cases 等重开操作从此继承这份配置，
    // 空题库任务 AI 出题后仍保留创建时定的 train 比例与 test 集，不回退默认
    splitConfig: { trainRatio: ratio, seed, testRatio },
    baseline: null,
    scoreHistory: [],
    archive: [],
    regression: {},
    stats: defaultStats(),
    versions: [{ version: 'v1', applied: [], changelog: label, at: new Date().toISOString() }],
    log: [{ at: new Date().toISOString(), event: 'init', detail: `底图=${baseGraph.id} 题库 ${cases.length} 条切分 train=${split.train.length}/heldout=${split.heldout.length}${split.test ? `/test=${split.test.length}` : ''}（seed=${seed}）` }],
  };
}
function initState() {
  return makeFreshState({ kind: 'seed', id: 'seed', label: '智慧园区种子图谱' }, 'main', readJson(CASES_PATH).cases);
}

function stratifiedSplit(cases, seed, ratio, testRatio) {
  return splitCases(cases, seed, ratio, testRatio);

}

function resolveGraphPath(version, st) {
  if (version === 'v1') {
    const bg = (st && st.baseGraph) || { kind: 'seed' };
    if (bg.kind === 'snapshot') return path.join(SNAPSHOTS_DIR, `${bg.id}.json`);
    return GRAPH_V1_PATH;
  }
  // 任务化：非 v1 版本图存任务目录（版本演化是任务私有的）；旧部署无任务时回落全局 versions
  const taskId = (st && st.taskId) || currentTaskId();
  if (taskId) return path.join(TASKS_DIR, taskId, `rsi-graph.${version}.json`);
  return path.join(VERSIONS_DIR, `rsi-graph.${version}.json`);
}
function loadGraph(version, st) {
  const p = resolveGraphPath(version, st);
  if (!fs.existsSync(p)) throw new Error(`图谱版本不存在: ${version}`);
  return readJson(p);
}

// ───────────────────────── 轻量声明驱动验证器 ─────────────────────────

function normalize(q) {
  return String(q || '')
    .toLowerCase()
    .replace(/[？?！!。，,、．.\s"'（）()【】\[\]～~：:；;]/g, '')
    .trim();
}
function bigrams(str) {
  const s = normalize(str);
  const out = new Set();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  if (s.length === 1) out.add(s);
  return out;
}
function dice(aSet, bSet) {
  if (!aSet.size || !bSet.size) return 0;
  let inter = 0;
  for (const x of aSet) if (bSet.has(x)) inter++;
  return (2 * inter) / (aSet.size + bSet.size);
}

// 声明侧 bigram/normalize 按 node 缓存（WeakMap）：全图 1580 节点 × 均 57 utterance
// 在整轮评测中被反复评分。缓存随 node 对象生命周期回收；提案 apply 是整图深拷贝
// （applyProposal），draft node 是全新对象、自动重建缓存，无需内容签名校验
const NODE_BM = new WeakMap();
function nodeBigramEntry(node) {
  let e = NODE_BM.get(node);
  if (e) return e;
  const rp = node.retrieval_profile || {};
  const sd = node.semantic_definition || {};
  const uttRaw = [...(rp.utterance_view || []), ...(sd.scope_in || [])];
  const hintsSrc = sd.disambiguation_hints || [];
  e = {
    uttNorm: uttRaw.map(normalize),
    utt: uttRaw.map(bigrams),
    sem: (rp.semantic_view || []).map(bigrams),
    hints: (sd.description ? [...hintsSrc, sd.description] : hintsSrc).map(bigrams),
    objNorm: (rp.object_view || []).map(normalize),
    actNorm: (rp.action_view || []).map(normalize),
  };
  NODE_BM.set(node, e);
  return e;
}

// query 侧 memo：rankIntents 按同一 query 连续调满全图，单条缓存命中即全图共享一次构造
let _qRaw = null, _qNorm = '', _qSet = null;
function queryNorm(q) {
  if (q !== _qRaw) { _qRaw = q; _qNorm = normalize(q); _qSet = bigrams(q); }
  return _qNorm;
}
function queryBigrams(q) {
  queryNorm(q);
  return _qSet;
}

function matchOne(query, node, opts) {
  const ep = (opts && opts.engineParams) || DEFAULT_ENGINE_PARAMS;
  const nq = queryNorm(query);
  const qSet = queryBigrams(query);
  const e = nodeBigramEntry(node);
  const rp = node.retrieval_profile || {};
  // 子句模式：clause_view 是 A3 变异的落点，只有复合句拆分后的子句召回消费它——
  // 保证"评了能真实涨分"且不影响单意图整句路径
  let uttSets = e.utt;
  if (opts && opts.clauseMode && Array.isArray(rp.clause_view) && rp.clause_view.length) {
    if (!e.clauseUtt) e.clauseUtt = e.utt.concat(rp.clause_view.map(bigrams));
    uttSets = e.clauseUtt;
  }

  const exact = e.uttNorm.includes(nq);
  const maxUtt = Math.max(0, ...uttSets.map(s => dice(qSet, s)));
  const maxSem = Math.max(0, ...e.sem.map(s => dice(qSet, s)));
  // 消歧提示/描述参与语义打分：A2/A4 变异的落点必须能真实移动验证器分数，否则提案评了不涨
  const maxHint = Math.max(0, ...e.hints.map(s => dice(qSet, s)));
  const uttScore = Math.max(maxUtt, maxSem * ep.sem_decay, maxHint * ep.hint_decay);

  let objHits = 0;
  for (const o of e.objNorm) { if (o && nq.includes(o)) objHits++; }
  const objScore = objHits ? Math.min(1, objHits / Math.max(1, e.objNorm.length)) : 0;

  let actHits = 0;
  for (const a of e.actNorm) { if (a && nq.includes(a)) actHits++; }
  const actScore = actHits ? Math.min(1, actHits / Math.max(1, e.actNorm.length)) : 0;

  if (exact) return { score: 1.0, exact: true };
  const score = Math.min(ep.score_cap, ep.w_utt * uttScore + ep.w_obj * objScore + ep.w_act * actScore);
  return { score, exact: false };
}

function splitClauses(query) {
  // 子句切分：多意图拆分的声明外机制（验证器自带，非图谱变异对象）
  const parts = String(query || '')
    .split(/(?:再|然后|顺便|还要|之后|接着|,|，|;|；)+/)
    .map(s => s.replace(/^(先|帮我|请|麻烦|我想|我要|给我)+/g, '').trim())
    .filter(Boolean);
  // “和”仅当两侧都非空且切后仍有意义才切
  const out = [];
  for (const p of parts) {
    const andParts = p.split(/和/).map(x => x.trim()).filter(Boolean);
    if (andParts.length > 1 && andParts.every(x => x.length >= 2)) out.push(...andParts);
    else out.push(p);
  }
  return out.length ? out : [String(query || '').trim()];
}

function rankIntents(text, graph, opts) {
  const scored = (graph.intent_nodes || []).map(node => ({ id: node.identity.intent_id, name: node.identity.intent_name, ...matchOne(text, node, opts) }));
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

function nodeById(graph, id) {
  return (graph.intent_nodes || []).find(n => n.identity.intent_id === id) || null;
}

/**
 * 单句匹配 → { top1, topk, clarifying, candidates }
 * 澄清判定（声明驱动）：①低置信 ②混淆对分数接近 ③top1 声明了 clarify_questions 且非精确命中
 */

const GRAPH_INDEX_CACHE = new WeakMap();
function graphIndexFor(graph) {
  let index = GRAPH_INDEX_CACHE.get(graph);
  if (!index) { index = buildGraphIndex(graph); GRAPH_INDEX_CACHE.set(graph, index); }
  return index;
}
/** 图召回通道：从词法高置信候选出发，沿图谱关系扩展 1 跳邻居。 */
function graphRowsFor(ranked, graph, ep) {
  const index = graphIndexFor(graph);
  const seeds = ranked.slice(0, 6).map(r => ({ intent_id: r.id, score: r.score }));
  const rows = graphRecall(seeds, index, {
    limit: TOPK,
    minSeedScore: ep.graph_seed_floor,
    minScore: ep.graph_row_floor,
    relationWeights: {
      confusable: ep.graph_confusable_weight,
      shared_object: ep.graph_object_weight,
      shared_action: ep.graph_action_weight,
      sibling: ep.graph_sibling_weight,
    },
  });
  return rows.map(row => ({ intent_id: row.intent_id, intent_name: row.intent_name, score: row.score, relation: row.relation, support: row.support, evidence: row.evidence }));
}
/**
 * 图召回与词法联合排序：只有图谱显式声明的混淆边（confusable）参与改分。
 * 共享业务对象/动作/兄弟关系只做召回补位——种子取自当前 top1 时，给它的近邻加分
 * 等同于让 top1 和自己竞争（实测 6 题从正确 top1 翻到错误近邻），必须禁止。
 */
const GRAPH_BOOST_RELATIONS = new Set(['confusable']);
function fuseGraphRows(ranked, graphRows, ep) {
  if (!graphRows.length || !ranked.length) return;
  const byId = new Map(ranked.map(item => [item.id, item]));
  const ceiling = ranked[0].score || 0;
  const top1Id = ranked[0].id;
  for (const row of graphRows) {
    const item = byId.get(row.intent_id);
    if (!item) continue;
    if (item.id === top1Id) continue;
    if (!GRAPH_BOOST_RELATIONS.has(row.relation)) continue;
    const boostWeight = 1.0;
    if ((item.score || 0) < ceiling * 0.85) continue;
    const consensus = (row.support || 1) >= 2 ? 1 : 0.5;
    item.score = Number((item.score + row.score * ep.graph_weight * boostWeight * consensus).toFixed(4));
    item.graph_relation = row.relation;
  }
  const lexTop3 = ranked.slice(0, 3).map(r => r.id);
  const graphTop3 = graphRows.slice(0, 3).map(r => r.intent_id);
  for (const id of graphTop3) {
    if (lexTop3.includes(id)) {
      const item = byId.get(id);
      if (item && item.id !== top1Id) {
        item.score = Number((item.score + 0.05).toFixed(4));
        item.graph_consensus = true;
      }
    }
  }
  ranked.sort((a, b) => b.score - a.score);
}
function mergeChannelRows(groups) {
  const best = new Map();
  for (const rows of groups) for (const row of rows || []) {
    if (!row || !row.intent_id) continue;
    const prev = best.get(row.intent_id);
    if (!prev || (row.score || 0) > (prev.score || 0)) best.set(row.intent_id, row);
  }
  return Array.from(best.values()).sort((a, b) => (b.score || 0) - (a.score || 0));
}
/** 测量证据：三路通道各自的行 + 状态，供离线推导召回精度。 */
function buildEvidence(graphRows, lexicalRows) {
  return { schema: 1, status: 'recorded', routes: {
    lexical: { status: (lexicalRows || []).length ? 'completed' : 'unobserved', rows: lexicalRows || [] },
    vector: { status: 'unavailable', rows: [], reason: '沙盒验证器无向量召回' },
    subgraph: { status: (graphRows || []).length ? 'completed' : 'unobserved', rows: graphRows || [] },
  } };
}

function matchClause(text, graph, opts) {
  const ep = { ...DEFAULT_ENGINE_PARAMS, ...((opts && opts.engineParams) || {}) };
  const ranked = rankIntents(text, graph, opts);
  // 词法通道先快照，保证 lexical 精度只反映词法自身排序；随后再做图召回联合排序。
  const lexicalRows = ranked.slice(0, TOPK).map(r => ({ intent_id: r.id, intent_name: r.name, score: Number(r.score.toFixed(3)), exact: r.exact }));
  const graphRows = graphRowsFor(ranked, graph, ep);
  fuseGraphRows(ranked, graphRows, ep);
  const top1 = ranked[0] || null;
  const top2 = ranked[1] || null;
  const topk = ranked.slice(0, TOPK).map(r => ({ intent_id: r.id, intent_name: r.name, score: Number(r.score.toFixed(3)), exact: r.exact }));

  if (!top1 || top1.score < ep.no_match_floor) return { top1: null, topk, clarifying: false, candidates: [], reason: 'no_match', graphRows, lexicalRows };

  let clarifying = false;
  const candidates = [];
  const node1 = nodeById(graph, top1.id);
  const hasClarifyDecl = !!(node1 && node1.decision_policy && (node1.decision_policy.clarify_questions || []).length);

  if (top1.exact) {
    // 精确命中不澄清
  } else if (top1.score < ep.clarify_low) {
    clarifying = true;
  } else if (hasClarifyDecl) {
    clarifying = true;
  } else if (top2 && top1.score - top2.score < ep.clarify_gap && top1.score < ep.close_conf_ceil) {
    const sd1 = (nodeById(graph, top1.id)?.semantic_definition) || {};
    if ((sd1.confusable_intents || []).includes(top2.id)) clarifying = true;
  }

  if (clarifying) {
    // 候选取分数前二且必含 top1：低分触发的澄清若把 top1 挤出候选，歧义用例永远修不好
    const cand = ranked.slice(0, 2);
    candidates.push(...cand.map(r => r.id));
  }
  return { top1: top1.id, top1Name: top1.name, top1Score: Number(top1.score.toFixed(3)), topk, clarifying, candidates, graphRows, lexicalRows };
}

function predictCase(caseItem, graph, opts) {
  const ep = (opts && opts.engineParams) || DEFAULT_ENGINE_PARAMS;
  const shape = caseItem.intent_shape;
  if (shape === 'multi_intent') {
    const clauses = splitClauses(caseItem.query);
    const per = clauses.map(c => ({ clause: c, ...matchClause(c, graph, { clauseMode: true, engineParams: ep }) }));
    const graphRows = mergeChannelRows(per.map(item => item.graphRows));
    const lexicalRows = mergeChannelRows(per.map(item => item.lexicalRows));
    const set = [];
    for (const p of per) {
      if (p.top1 && p.top1Score >= ep.subclause_min && !set.includes(p.top1)) set.push(p.top1);
    }
    return { shape, per, predictedSet: set, clarifying: false, graphRows, lexicalRows };
  }
  // single / ambiguous：整句匹配
  const m = matchClause(caseItem.query, graph, { engineParams: ep });
  return { shape, single: m };
}

function evalCase(caseItem, graph, opts) {
  const pred = predictCase(caseItem, graph, opts);
  const expected = caseItem.expected_intents || [];
  let strict = false;
  let relaxed = 0;
  let resultType = '';

  if (pred.shape === 'single_intent') {
    const m = pred.single;
    const top1 = m.clarifying ? null : m.top1;
    strict = top1 !== null && expected.includes(top1);
    relaxed = m.topk.some(k => expected.includes(k.intent_id)) ? 1 : 0;
    if (strict) resultType = 'correct';
    else if (m.clarifying) resultType = expected.every(e => m.candidates.includes(e)) ? 'clarify_ok_set' : 'clarify_missing_expected';
    else if (relaxed) resultType = 'rank_error';
    else if (m.top1) resultType = 'wrong_label';
    else resultType = 'recall_miss';
  } else if (pred.shape === 'multi_intent') {
    const set = pred.predictedSet;
    const inter = expected.filter(e => set.includes(e)).length;
    const union = new Set([...expected, ...set]).size;
    relaxed = union ? inter / union : 0;
    strict = set.length === expected.length && expected.every(e => set.includes(e));
    const primaryHit = set.length > 0 && expected.includes(set[0]);
    resultType = strict ? 'correct' : (inter === 0 ? 'multi_no_hit' : (inter < Math.max(expected.length, set.length) ? 'multi_partial' : 'multi_extra'));
    return { strict, relaxed, resultType, primaryHit, predictedSet: set, per: pred.per, evidence: buildEvidence(pred.graphRows, pred.lexicalRows) };
  } else {
    // ambiguous：正确行为 = 触发澄清且候选覆盖期望
    const m = pred.single;
    strict = m.clarifying && expected.every(e => m.candidates.includes(e));
    relaxed = m.clarifying ? (expected.filter(e => m.candidates.includes(e)).length / expected.length) : 0;
    resultType = strict ? 'correct' : (m.clarifying ? 'clarify_missing_expected' : 'clarify_not_triggered');
  }
  return { strict, relaxed, resultType, predicted: pred.single, evidence: buildEvidence(pred.single.graphRows, pred.single.lexicalRows) };
}

function evaluateSet(graph, caseIds, casesById, opts) {
  const results = [];
  for (const id of caseIds) {
    const c = casesById.get(id);
    if (!c) continue;
    results.push({ case_id: c.case_id, query: c.query, difficulty: c.difficulty, shape: c.intent_shape, expected: c.expected_intents, ...evalCase(c, graph, opts) });
  }
  return results;
}

function aggregate(results) {
  const pct = (n, d) => (d ? Number(((100 * n) / d).toFixed(1)) : 0);
  const agg = { total: results.length, strict: 0, relaxedSum: 0 };
  const byShape = {};
  for (const r of results) {
    if (r.strict) agg.strict++;
    agg.relaxedSum += r.relaxed;
    const key = r.shape;
    if (!byShape[key]) byShape[key] = { total: 0, strict: 0, relaxedSum: 0 };
    byShape[key].total++;
    if (r.strict) byShape[key].strict++;
    byShape[key].relaxedSum += r.relaxed;
  }
  const scores = {
    total: agg.total,
    strict_pct: pct(agg.strict, agg.total),
    relaxed_pct: pct(Number((agg.relaxedSum).toFixed(2)), agg.total),
  };
  for (const [k, v] of Object.entries(byShape)) {
    scores[k] = { total: v.total, strict_pct: pct(v.strict, v.total), relaxed_pct: pct(Number(v.relaxedSum.toFixed(2)), v.total) };
  }
  return scores;
}

// ───────────────────────── 多路召回精度（Top-K 命中率）──────────────────
// 逐题读取引擎证据 evidence.routes 的真实候选行，按各通道自身排序统计命中率。
// 只统计该通道真的产出了候选的题（observed）；未产出/不可用不计入分母，单独计数。
const RECALL_CHANNELS = ['lexical', 'vector', 'subgraph'];
function computeRecallMetrics(results) {
  const pct = (n, d) => (d ? Number(((100 * n) / d).toFixed(1)) : 0);
  const init = () => ({ observed: 0, unavailable: 0, hit1: 0, hit3: 0, hit5: 0 });
  const CH = [...RECALL_CHANNELS, 'final'];
  const overall = {}; for (const c of CH) overall[c] = init();
  const byShape = {}; const totals = new Map();
  for (const r of results) {
    const expected = r.expected || [];
    if (!expected.length) continue;
    const key = r.shape || 'unknown';
    if (!byShape[key]) { byShape[key] = {}; for (const c of CH) byShape[key][c] = init(); }
    totals.set(key, (totals.get(key) || 0) + 1);
    const routes = (r.evidence && r.evidence.routes) || {};
    for (const ch of RECALL_CHANNELS) {
      const node = routes[ch] || {}; const rows = node.rows || [];
      if (node.status === 'unavailable' || !rows.length) { overall[ch].unavailable++; byShape[key][ch].unavailable++; continue; }
      const ids = rows.map(x => x.intent_id);
      const h1 = ids[0] && expected.includes(ids[0]) ? 1 : 0;
      const h3 = ids.slice(0, 3).some(id => expected.includes(id)) ? 1 : 0;
      const h5 = ids.slice(0, 5).some(id => expected.includes(id)) ? 1 : 0;
      overall[ch].observed++; overall[ch].hit1 += h1; overall[ch].hit3 += h3; overall[ch].hit5 += h5;
      byShape[key][ch].observed++; byShape[key][ch].hit1 += h1; byShape[key][ch].hit3 += h3; byShape[key][ch].hit5 += h5;
    }
    const fh = r.strict ? 1 : 0;
    overall.final.observed++; overall.final.hit1 += fh;
    byShape[key].final.observed++; byShape[key].final.hit1 += fh;
  }
  const ch = {};
  for (const c of CH) ch[c] = { observed: overall[c].observed, unavailable: overall[c].unavailable,
    hit1: overall[c].hit1, hit3: overall[c].hit3, hit5: overall[c].hit5,
    top1_pct: pct(overall[c].hit1, overall[c].observed), top3_pct: pct(overall[c].hit3, overall[c].observed), top5_pct: pct(overall[c].hit5, overall[c].observed) };
  const shapeOut = {};
  for (const [k, v] of Object.entries(byShape)) {
    shapeOut[k] = { total: totals.get(k) || 0 };
    for (const c of CH) shapeOut[k][c] = { observed: v[c].observed, unavailable: v[c].unavailable, hit1: v[c].hit1,
      top1_pct: pct(v[c].hit1, v[c].observed), top3_pct: pct(v[c].hit3, v[c].observed), top5_pct: pct(v[c].hit5, v[c].observed) };
  }
  return { total: overall.final.observed, channels: ch, byShape: shapeOut };
}

// ───────────────────────── 模型裁决指标（LLM 裁决触发率/改变率/增益）──────────────────
function computeAdjudicationMetrics(results, engineParams) {
  const ep = engineParams || DEFAULT_ENGINE_PARAMS;
  const pct = (n, d) => (d ? Number(((100 * n) / d).toFixed(1)) : 0);
  let total = 0;
  let triggered = 0;
  let changed = 0;
  let changedToCorrect = 0;
  let changedToWrong = 0;
  for (const r of results) {
    total++;
    const expected = r.expected || [];
    if (!expected.length) continue;
    if (r.shape === "multi_intent") continue;
    const m = r.predicted;
    if (!m || !m.topk || !m.topk.length) continue;
    const top1Id = m.top1;
    const top1Correct = expected.includes(top1Id);
    const hasCorrectInTopk = m.topk.slice(1).some(k => expected.includes(k.intent_id));
    let willTrigger = false;
    if (!m.top1) willTrigger = true;
    else if (m.clarifying) willTrigger = true;
    // 排序错误：正确答案已在候选里，只差裁决重排，这是 LLM 裁决最直接的回收空间
    else if (hasCorrectInTopk) willTrigger = true;
    else {
      const t1 = m.topk[0];
      const t2 = m.topk[1] || null;
      const s1 = t1 && typeof t1.score === 'number' ? t1.score : null;
      const s2 = t2 && typeof t2.score === 'number' ? t2.score : null;
      if (s1 != null && s1 < 0.55 && m.topk.length >= 2) willTrigger = true;
      else if (s1 != null && s2 != null && (s1 - s2) < 0.10 && s1 < 0.70) willTrigger = true;
    }
    if (!willTrigger) continue;
    triggered++;
    if (!top1Correct && hasCorrectInTopk) {
      changed++;
      changedToCorrect++;
    } else if (top1Correct) {
      changed++;
      changedToWrong++;
    }
  }
  return {
    total, triggered, triggered_pct: pct(triggered, total),
    changed, changed_pct: pct(changed, total),
    potential_fixes: changedToCorrect, potential_fixes_pct: pct(changedToCorrect, total),
    potential_regressions: changedToWrong, potential_regressions_pct: pct(changedToWrong, total),
    net_gain_estimate: changedToCorrect - changedToWrong,
  };
}

// ───────────────────────── ② 归因结构化 ─────────────────────────

function attributeResults(results) {
  const families = {};
  const push = (family, r, op, note) => {
    if (!families[family]) families[family] = { family, suggested_op: op, note, count: 0, samples: [] };
    families[family].count++;
    if (families[family].samples.length < 6) {
      // 多意图坏例附子句级竞争明细：变异器需要知道"被谁以多少分压过"才能产出能反超的锚定表达
      const clauses = (r.shape === 'multi_intent' ? (r.per || []) : []).map(p => ({
        clause: p.clause,
        top1: p.top1 ? { id: p.top1, name: p.top1Name, score: p.top1Score } : null,
        expected: (r.expected || []).map(e => {
          const idx = (p.topk || []).findIndex(k => k.intent_id === e);
          return { id: e, rank: idx === -1 ? null : idx + 1, score: idx === -1 ? null : (p.topk[idx] || {}).score };
        }),
      }));
      families[family].samples.push({
        ...trainingRow(r),
        case_id: r.case_id, query: r.query, shape: r.shape, expected: r.expected,
        clauses: clauses.length ? clauses : undefined,
        predicted: r.predictedSet || (r.predicted ? { top1: r.predicted.top1, topk: r.predicted.topk, clarifying: r.predicted.clarifying, candidates: r.predicted.candidates } : null),
      });
    }
  };
  for (const r of results) {
    if (r.shape === 'single_intent') {
      // 图召回归因：先看期望意图是否被图通道捞回、是否被词法捞到，把
      // 「图检索到了但联合排序没用上」与「图谱缺少可用的边」分开，避免一律归给补表达。
      const routes = (r.evidence || {}).routes || {};
      const lexicalRows = (routes.lexical || {}).rows || [];
      const graphRows = (routes.subgraph || {}).rows || [];
      const expectedIds = r.expected || [];
      const graphHit = graphRows.find(k => expectedIds.includes(k.intent_id));
      const lexicalHit = lexicalRows.some(k => expectedIds.includes(k.intent_id));
      if (!r.strict && graphHit && !lexicalHit) {
        push('graph_recall_gap', r, 'E1_engine_param', `图通道已沿「${graphHit.relation}」关系召回期望意图（support=${graphHit.support || 1}），但词法 topk 缺失 → 调 graphWeight/graphSeedFloor，或把图候选真正纳入联合排序`);
      } else if (!r.strict && !graphHit && !lexicalHit && r.resultType === 'wrong_label') {
        push('graph_edge_missing', r, 'A2_disambiguation', '期望意图既不在词法 topk，也不在图邻居里 → 图谱缺少可用声明边，补 confusable/区分说法把它连进候选域');
      }
      if (r.resultType === 'recall_miss') push('single_recall_miss', r, 'A1_utterance_expand', graphHit ? `topk 未出现期望意图；图通道已召回（${graphHit.relation}）→ 先补该说法让词法进榜` : 'topk 未出现期望意图 → 召回表达覆盖不足');
      else if (r.resultType === 'rank_error') push('single_rank_error', r, 'A2_disambiguation', '期望意图在榜但非第一 → 需消歧/描述区分');
      else if (r.resultType === 'wrong_label') push('single_wrong_label', r, 'A4_description_rewrite', '选错意图 → 描述/边界区分度不足');
    } else if (r.shape === 'multi_intent') {
      // 子句级细分：期望意图在子句 topk 中但最高分低于子句门槛 → 子句形态表达不足（A3 拉分）；
      // 期望完全不在 topk → 召回表达缺失（A1）。机制归因：切分是验证器声明外机制，子句→意图此前仅消费 utterance_view。
      const weakClauses = (r.per || []).filter(p => {
        if (p.top1Score >= SUBCLAUSE_MIN_SCORE) return false;
        const expScores = (p.topk || []).filter(k => (r.expected || []).includes(k.intent_id)).map(k => k.score);
        return expScores.length > 0 && Math.max(...expScores) < SUBCLAUSE_MIN_SCORE;
      });
      const missedClauses = (r.per || []).filter(p => {
        if (!p.top1) return true;
        return !(p.topk || []).some(k => (r.expected || []).includes(k.intent_id));
      });
      // 竞争失败：期望意图在子句 topk 且已过门槛，但子句 top1 被别的意图占据——
      // 这类坏例加通用表达推不动排名，必须给期望意图补"贴近该子句"的表达才能反超
      const rankLostClauses = (r.per || []).filter(p => {
        if (!p.top1 || p.top1Score < SUBCLAUSE_MIN_SCORE) return false;
        if ((r.expected || []).includes(p.top1)) return false;
        const hit = (p.topk || []).find(k => (r.expected || []).includes(k.intent_id));
        return !!hit;
      });
      if (['multi_no_hit','multi_partial','multi_missing'].includes(r.resultType)) {
        if (weakClauses.length) push('multi_clause_weak', r, 'A3_clause_expansion', `子句「${weakClauses[0].clause}」期望意图在榜但最高分未过门槛 ${SUBCLAUSE_MIN_SCORE} → 子句形态表达不足`);
        else if (missedClauses.length) push('multi_clause_miss', r, 'A1_utterance_expand', `子句「${missedClauses[0].clause}」期望意图不在 top${TOPK} → 召回表达缺失`);
        else if (rankLostClauses.length) {
          const p = rankLostClauses[0];
          push('multi_clause_rank', r, 'A3_clause_expansion', `子句「${p.clause}」被「${p.top1Name || p.top1}」(${p.top1Score}) 压过，期望意图在榜但非 top1 → 需补贴近该子句的表达反超`);
        }
        else push('multi_partial', r, 'A1_utterance_expand', '集合部分命中 → 部分子句召回缺失');
      }
      else if (r.resultType === 'multi_extra') push('multi_extra', r, 'A2_disambiguation', '多意图包含多余任务；检查子句与业务边界，不能只补召回');
      else if (r.resultType === 'multi_wrong') push('multi_task_constraints', r, null, '任务、顺序或槽位不正确；先检查分解和裁决阶段证据，再选择可影响该阶段的改动');
      else if (r.resultType === 'unexpected_clarification') push('multi_unnecessary_clarification', r, null, '正确复合意图被多余澄清打断；检查子句竞争与澄清触发，不改问题文案');
    } else if (r.shape === 'ambiguous_intent') {
      if (r.resultType === 'clarify_not_triggered') push('ambig_not_triggered', r, 'A6_ambiguity_cluster_expand', '应澄清未澄清；区分召回缺失与已召回后被直判，A6共同完整说法可声明歧义；A5只改文案');
      else if (r.resultType === 'clarify_missing_expected') push('ambig_missing_expected', r, null, '已澄清但选项不全；对照实际召回与最终选项，定位召回还是选项组织阶段');
      else if (r.resultType === 'clarify_extra_options') push('ambig_extra_options', r, null, '期望已覆盖时优先收敛多余选项；检查共同说法声明、排除边界和候选组织，不将其断言为召回不足');
      else if (r.resultType === 'clarify_unanswerable') push('ambig_unanswerable', r, 'A5_clarify', '澄清问题不可回答；在已正确触发和组织选项的前提下修改文案');
    }
  }
  return Object.values(families).sort((a, b) => b.count - a.count);
}

// ── 反事实翻转分析（counterfactual）：对每个坏例计算"改什么能让这题翻" ──
// 不重跑引擎，基于已有 topk 分数信号计算翻转条件——弥补分差、进榜门槛、澄清触发
// 喂给提案器，让它知道每题的瓶颈在召回/排序/门槛/澄清触发，而非盲目补表达
function counterfactualAnalysis(attributions) {
  const out = [];
  for (const fam of attributions) {
    for (const s of fam.samples.slice(0, 4)) {
      const cf = computeFlipCondition(s, fam.family);
      if (cf) out.push(cf);
    }
  }
  return out;
}

function computeFlipCondition(s, family) {
  const topk = s.predicted?.topk || [];
  const top1 = topk[0];
  if (family === 'single_recall_miss') {
    // 期望意图不在 topk → 需新增表达进 topk
    const threshold = topk.length >= TOPK ? topk[topk.length - 1].score : 0;
    return { case_id: s.case_id, query: s.query, family,
      flipCondition: `期望意图需进入前${TOPK}候选（当前进榜门槛≈${threshold.toFixed(3)}）`,
      requiredDelta: +threshold.toFixed(3), bottleneck: 'recall' };
  }
  if (family === 'single_rank_error' || family === 'single_wrong_label') {
    // 期望意图在 topk 但非 top1 → 需弥补的分差
    const expectedEntry = topk.find(k => (s.expected || []).includes(k.intent_id));
    if (!top1 || !expectedEntry) return null;
    const delta = top1.score - expectedEntry.score;
    return { case_id: s.case_id, query: s.query, family,
      flipCondition: `期望意图需反超「${top1.intent_name}」（弥补分差 ${(delta * 100).toFixed(1)}%）`,
      requiredDelta: +delta.toFixed(3), bottleneck: 'rank', competitor: top1.intent_name };
  }
  if (family === 'multi_clause_weak') {
    // 子句弱匹配 → 需弥补到门槛
    const weakClause = (s.clauses || []).find(c => {
      const exp = (c.expected || []).find(e => e.score != null);
      return exp && exp.score < SUBCLAUSE_MIN_SCORE;
    });
    if (!weakClause) return null;
    const exp = weakClause.expected.find(e => e.score != null);
    const delta = SUBCLAUSE_MIN_SCORE - (exp?.score || 0);
    return { case_id: s.case_id, query: s.query, family,
      flipCondition: `子句「${weakClause.clause}」期望意图需过门槛 ${SUBCLAUSE_MIN_SCORE}（弥补 ${(delta * 100).toFixed(1)}%）`,
      requiredDelta: +delta.toFixed(3), bottleneck: 'subclause_threshold', clause: weakClause.clause };
  }
  if (family === 'multi_clause_miss') {
    // 子句召回缺失 → 需新增子句表达
    const missClause = (s.clauses || []).find(c => !c.top1 || !c.expected?.some(e => e.rank != null));
    if (!missClause) return null;
    return { case_id: s.case_id, query: s.query, family,
      flipCondition: `子句「${missClause.clause}」期望意图完全不在前${TOPK}候选`,
      requiredDelta: null, bottleneck: 'subclause_recall', clause: missClause.clause };
  }
  if (family === 'multi_clause_rank') {
    // 子句竞争失败 → 需弥补的分差
    const rankClause = (s.clauses || []).find(c => {
      if (!c.top1) return false;
      const exp = (c.expected || []).find(e => e.rank != null);
      return exp && exp.rank > 1;
    });
    if (!rankClause) return null;
    const exp = rankClause.expected.find(e => e.rank != null);
    const delta = (rankClause.top1?.score || 0) - (exp?.score || 0);
    return { case_id: s.case_id, query: s.query, family,
      flipCondition: `子句「${rankClause.clause}」期望意图需反超「${rankClause.top1?.name}」（弥补 ${(delta * 100).toFixed(1)}%）`,
      requiredDelta: +delta.toFixed(3), bottleneck: 'subclause_rank', clause: rankClause.clause, competitor: rankClause.top1?.name };
  }
  if (family === 'graph_recall_gap') {
    return { case_id: s.case_id, query: s.query, family,
      flipCondition: '期望意图已被图通道召回但未进入自然排序 top1 → 提高 graphWeight 或写 confusable 边让图分参与反超',
      requiredDelta: null, bottleneck: 'graph_recall' };
  }
  if (family === 'graph_edge_missing') {
    return { case_id: s.case_id, query: s.query, family,
      flipCondition: '期望意图不在任何通道候选域 → 图谱缺声明边，需 A2 写 confusable/区分说法后才能被图召回',
      requiredDelta: null, bottleneck: 'graph_edge' };
  }
  if (family === 'ambig_not_triggered') {
    // 应澄清未澄清 → 需澄清声明触发
    return { case_id: s.case_id, query: s.query, family,
      flipCondition: `需触发澄清但直接猜了「${top1?.intent_name || '无'}」（top1 分数 ${(top1?.score || 0).toFixed(3)}）`,
      requiredDelta: null, bottleneck: 'clarify_trigger', competitor: top1?.intent_name };
  }
  if (family === 'ambig_missing_expected') {
    // 已澄清但选项不全 → 需补全澄清候选
    return { case_id: s.case_id, query: s.query, family,
      flipCondition: '已触发澄清但选项里缺正确答案',
      requiredDelta: null, bottleneck: 'clarify_options' };
  }
  return null;
}

// ───────────────────────── ③ 变异提案器（Agent + Skill 工作流） ─────────────────────────

// ── Agent 服务调用基础设施 ──
// 通用 HTTP POST 调用平台 agent 服务
function callAgentService(host, port, path, body, timeoutMs) {
  const http = require('http');
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const timer = setTimeout(() => reject(new Error(`agent 服务超时 ${host}:${port}${path} ${timeoutMs}ms`)), timeoutMs || 30000);
    const req = http.request({ hostname: host, port: port, path: path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', c => { text += c; });
      res.on('end', () => { clearTimeout(timer); try { resolve({ status: res.statusCode, body: text.length ? JSON.parse(text) : {} }); } catch (e) { resolve({ status: res.statusCode, body: { raw: text } }); } });
    });
    req.on('error', e => { clearTimeout(timer); reject(e); });
    req.write(data);
    req.end();
  });
}

// 1. knowledge-qa-agent (8100) — LangGraph KBQA agent，多步推理 + 图谱知识检索
// 请求: {message, graphId?, history?[]} → {answer}
async function callKnowledgeQAAgent(message, history, graphId) {
  const body = { message };
  if (history && history.length) body.history = history;
  if (graphId) body.graphId = graphId;
  try {
    const r = await callAgentService('knowledge-qa-agent', 8100, '/api/knowledge-qa-agent/query', body, 60000);
    if (r.status === 200 && r.body && r.body.answer) return r.body.answer;
    return null;
  } catch (e) { return null; }
}

// 2. ontomind-knowledge graph-badcase/analyze (8000) — 图谱坏例深度归因
// 注意：容器内部端口是 8000（宿主机映射为 8001）
async function callGraphBadcaseAnalyze(caseData) {
  try {
    const r = await callAgentService('ontomind-knowledge', 8000, '/api/v1/evaluation/graph-badcase/analyze', caseData, 30000);
    if (r.status === 200 && r.body) return r.body;
    return null;
  } catch (e) { return null; }
}

// 3. ontomind-knowledge skill-judge (8000) — 语义裁决（LLM-as-judge）
async function callSkillJudge(query, answer, goldAnswer, criteria) {
  const body = { query, answer, gold_answer: goldAnswer || '', judge_criteria: criteria || '意图识别是否正确' };
  try {
    const r = await callAgentService('ontomind-knowledge', 8000, '/api/v1/evaluation/skill-judge', body, 30000);
    if (r.status === 200 && r.body) return r.body;
    return null;
  } catch (e) { return null; }
}

// 4. ontomind-knowledge badcase/analyze (8000) — 通用坏例分析
async function callBadcaseAnalyze(question, answer, goldAnswer) {
  const body = { question, answer, gold_answer: goldAnswer || '' };
  try {
    const r = await callAgentService('ontomind-knowledge', 8000, '/api/v1/evaluation/badcase/analyze', body, 30000);
    if (r.status === 200 && r.body) return r.body;
    return null;
  } catch (e) { return null; }
}

// 5. skill-build-agent (8300) — Skill 构建 agent，SSE 流式
// 请求: {message, history?[], system_prompt?} → SSE (phase/token/result/done/error/hb)
async function callSkillBuildAgent(message, systemPrompt, history) {
  const body = { message };
  if (systemPrompt) body.system_prompt = systemPrompt;
  if (history && history.length) body.history = history;
  const http = require('http');
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    let timer = setTimeout(() => resolve(null), 60000);
    const req = http.request({ hostname: 'skill-build-agent', port: 8300, path: '/api/skill-build-agent/chat', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', c => { text += c; // 解析 SSE 事件（格式: event: <type>\ndata: <json>\n\n）
        const events = text.split('\n\n');
        text = events.pop() || ''; // 保留最后不完整的块
        for (const ev of events) {
          // 提取 data: 行，忽略 event: 行
          const dataLines = ev.split('\n').filter(l => l.startsWith('data:')).map(l => l.replace(/^data:\s*/, ''));
          if (!dataLines.length) continue;
          try {
            const obj = JSON.parse(dataLines.join(''));
            if (obj.result && obj.result.answer) { clearTimeout(timer); resolve(obj.result.answer); return; }
            if (obj.answer) { clearTimeout(timer); resolve(obj.answer); return; }
            if (obj.error) { clearTimeout(timer); resolve(null); return; }
          } catch (_) { /* SSE 块可能不完整，跳过 */ }
        }
      });
      res.on('end', () => { clearTimeout(timer); resolve(null); });
    });
    req.on('error', () => { clearTimeout(timer); resolve(null); });
    req.write(data);
    req.end();
  });
}

// ── 深度归因：用 graph-badcase/analyze 做语义级根因分析 ──
// 对每条 train 坏例，调用 ontomind-knowledge 的 graph-badcase/analyze 获取 LLM 驱动的根因
async function deepAnalyzeBadCases(results, graph) {
  const errors = results.filter(r => !r.strict);
  if (!errors.length) return [];
  const analyses = [];
  for (const r of errors.slice(0, 15)) { // 最多分析 15 条坏例，避免过长
    const expectedNames = (r.expected || []).map(id => (nodeById(graph, id) || {}).identity?.intent_name || id);
    const predictedName = r.predicted?.top1 ? ((nodeById(graph, r.predicted.top1) || {}).identity?.intent_name || r.predicted.top1) : '无';
    const caseData = {
      case_name: r.case_id,
      assertion_kind: r.shape === 'multi_intent' ? 'NODE_COUNT' : 'NODE_EXISTS',
      spec: JSON.stringify({ query: r.query, expected_intents: expectedNames, predicted: predictedName, shape: r.shape }),
      expected: r.expected ? expectedNames.join(',') : '正确意图',
      actual: predictedName,
      matched_samples: r.predicted?.topk ? r.predicted.topk.slice(0, 5).map(k => ({ intent_id: k.intent_id, name: (nodeById(graph, k.intent_id) || {}).identity?.intent_name || k.intent_id, score: k.score })) : null,
    };
    const analysis = await callGraphBadcaseAnalyze(caseData);
    analyses.push({
      case_id: r.case_id, query: r.query, shape: r.shape,
      expected: r.expected, predicted: r.predicted?.top1,
      expectedNames, predictedName,
      rootCause: analysis ? (analysis.root_cause || analysis.analysis || JSON.stringify(analysis).slice(0, 300)) : null,
      suggestion: analysis ? (analysis.suggestion || analysis.recommendation || null) : null,
    });
  }
  return analyses;
}

// ── 语义验证：用 skill-judge 在确定性评测前做语义裁决 ──
// 对每条 train 坏例，检查变异后的验证器结果是否语义正确（而非仅 bigram 匹配）
async function semanticVerify(draftResults, graph) {
  const checks = draftResults.filter(r => r.strict && r.predicted); // 只检查"修复成功"的，验证语义是否真的对
  let verified = 0;
  let failed = 0;
  for (const r of checks.slice(0, 10)) { // 最多抽检 10 条
    const expectedName = (nodeById(graph, r.expected?.[0]) || {}).identity?.intent_name || r.expected?.[0] || '';
    const predictedName = (nodeById(graph, r.predicted.top1) || {}).identity?.intent_name || r.predicted.top1;
    const judgment = await callSkillJudge(r.query, predictedName, expectedName, `用户输入"${r.query}"是否应该匹配到意图"${expectedName}"？`);
    if (judgment && (judgment.verdict === 'pass' || judgment.passed === true)) verified++;
    else if (judgment && (judgment.verdict === 'fail' || judgment.passed === false)) failed++;
  }
  return { verified, failed, total: Math.min(checks.length, 10) };
}

function callLLM(messages, timeoutMs, maxTokens, signal, temperature) {
  if (signal?.aborted) return Promise.reject(Object.assign(new Error('LLM 请求已停止'), { name: 'AbortError' }));
  const prefer = ['qwen3.7-flash', 'qwen-plus', 'deepseek-chat'];
  let route = null;
  let apiKey = null;
  for (const name of prefer) {
    const r = API_ROUTES[name];
    const k = r && r.getKey && r.getKey();
    if (r && k) { route = r; apiKey = k; break; }
  }
  if (!route || !apiKey) return Promise.reject(new Error('LLM route/key 未配置（config/api-keys.js）'));
  const model = route.model || 'qwen-plus';
  const body = JSON.stringify({ model, messages, temperature: typeof temperature === 'number' ? temperature : 0.3, max_tokens: maxTokens || 3000 });
  // 传输层重试（最多 2 次，退避 1s/3s）：仅对网络断连与 HTTP 5xx/429——瞬时抖动不应让整轮实验失败；
  // 4xx（配额/参数类）、超时与用户停止（AbortError）不重试。
  const retryable = e => {
    if (!e || e.name === 'AbortError') return false;
    if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN'].includes(String(e.code || ''))) return true;
    const msg = String(e.message || '');
    if (/socket (disconnected|hung up)|network error|TLS connection/i.test(msg)) return true;
    const m = msg.match(/^LLM HTTP (\d{3})/);
    return !!(m && (+m[1] >= 500 || +m[1] === 429));
  };
  const attempt = () => new Promise((resolve, reject) => {
    const https = require('https');
    let settled = false;
    const timer = setTimeout(() => { req.destroy(new Error(`LLM 超时 ${timeoutMs}ms`)); }, timeoutMs || 60000);
    const req = https.request({ hostname: route.host, path: route.path, method: 'POST', signal, headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}`, 'content-length': Buffer.byteLength(body) } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', c => { text += c; });
      res.on('end', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (res.statusCode < 200 || res.statusCode >= 300) { reject(new Error(`LLM HTTP ${res.statusCode}: ${text.slice(0, 300)}`)); return; }
        try {
          const data = JSON.parse(text);
          resolve(data.choices?.[0]?.message?.content || '');
        } catch (e) { reject(new Error('LLM 响应解析失败')); }
      });
    });
    req.on('error', e => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
    req.write(body);
    req.end();
  });
  return (async () => {
    for (let i = 0; ; i++) {
      try { return await attempt(); }
      catch (e) {
        if (i >= 2 || !retryable(e)) throw e;
        await new Promise(r => setTimeout(r, 1000 * Math.pow(3, i)));
      }
    }
  })();
}

// P1 recognition 角色：对 ambiguous_intent 类 case 用 LLM + 变异提示词在 topK 候选中重判
// 确定性验证器先跑出 topK → LLM 在 topK 中做澄清/重排判断 → 覆盖确定性结果
async function llmAmbiguousRerank(results, graph, promptText) {
  const ambigCases = results.filter(r => r.shape === 'ambiguous_intent' && r.predicted);
  if (!ambigCases.length) return;

  // 逐条用 knowledge-qa-agent（LangGraph 多步推理 + 图谱知识检索）重判
  // agent 不可用时降级到 callLLM——不崩溃，只降级
  for (const r of ambigCases) {
    const m = r.predicted;
    if (!m.topk || m.topk.length === 0) continue;
    const candidates = m.topk.map(k => ({
      id: k.intent_id,
      name: (nodeById(graph, k.intent_id) || {}).identity?.intent_name || k.intent_id,
      score: k.score,
    }));
    const agentMessage = `${promptText}\n\n用户输入: "${r.query}"\n\n候选意图:\n${JSON.stringify(candidates)}\n\n请判断：1) 应该直接回答还是需要澄清？2) 如果直接回答，top1 是哪个意图 ID？3) 如果需要澄清，哪些意图应作为候选？\n只输出 JSON: {"clarifying":true或false,"top1":"意图ID或null","candidates":["ID1","ID2"]}`;
    try {
      // 优先用 knowledge-qa-agent（LangGraph KBQA agent，支持图谱知识检索 + 多步推理）
      let text = await callKnowledgeQAAgent(agentMessage, []);
      if (!text) {
        // agent 不可用时降级到裸 callLLM
        text = await callLLM([
          { role: 'system', content: promptText },
          { role: 'user', content: `用户输入: "${r.query}"\n\n候选意图:\n${JSON.stringify(candidates)}\n\n请判断：1) 应该直接回答还是需要澄清？2) 如果直接回答，top1 是哪个意图 ID？3) 如果需要澄清，哪些意图应作为候选？\n只输出 JSON: {"clarifying":true或false,"top1":"意图ID或null","candidates":["ID1","ID2"]}` },
        ], 15000, 300);
      }
      r.rerankSource = text ? 'knowledge-qa-agent' : 'callLLM';
      const match = text && text.match(/\{[\s\S]*\}/);
      if (match) {
        const judgment = JSON.parse(match[0]);
        // 覆盖确定性验证器的 ambiguous 判定
        if (judgment.clarifying !== undefined) {
          m.clarifying = !!judgment.clarifying;
          if (judgment.candidates && Array.isArray(judgment.candidates)) {
            m.candidates = judgment.candidates;
          } else if (judgment.top1) {
            m.candidates = [judgment.top1, ...(m.topk[1] ? [m.topk[1].intent_id] : [])];
          }
          // 重算 strict/relaxed
          const expected = r.expected || [];
          r.strict = m.clarifying && expected.every(e => m.candidates.includes(e));
          r.relaxed = m.clarifying ? (expected.filter(e => m.candidates.includes(e)).length / Math.max(1, expected.length)) : 0;
          r.resultType = r.strict ? 'correct' : (m.clarifying ? 'clarify_missing_expected' : 'clarify_not_triggered');
          r.llmReranked = true;
        }
      }
    } catch (e) {
      // LLM 重判失败则保留确定性验证器结果——降级而非崩溃
      r.llmRerankError = e.message;
    }
  }
}

function extractJsonArray(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) throw new Error('响应中未找到 JSON 数组');
  const body = raw.slice(start, end + 1);
  try {
    return JSON.parse(body);
  } catch (e) {
    // LLM 长 JSON 常见单点语法瑕疵：降级为逐对象提取，坏对象跳过（能救多少救多少）
    const objs = [];
    let depth = 0, inStr = false, esc = false, objStart = -1;
    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { if (inStr) esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') { if (depth === 0) objStart = i; depth++; }
      else if (ch === '}') { depth--; if (depth === 0 && objStart >= 0) { objs.push(body.slice(objStart, i + 1)); objStart = -1; } }
    }
    const parsed = [];
    let bad = 0;
    for (const o of objs) {
      try { parsed.push(JSON.parse(o)); } catch (_) { bad++; }
    }
    if (!parsed.length) throw e;
    console.warn(`[intent-rsi] extractJsonArray 降级解析: 整体失败，逐对象救回 ${parsed.length} 个（丢弃 ${bad} 个坏对象）`);
    return parsed;
  }
}

function buildProposePrompt(attributions, graph, casesById, archive, engineParams, counterfactuals, recallMetrics) {
  const lines = [];
  lines.push('你是意图进化优化专家。以下是意图评测的坏例归因（仅 train 侧），请产出优化提案。');
  lines.push('优化目标不限于图谱声明修改——如果坏例的根因是引擎参数不合理（如澄清阈值过高/过低、权重配比不当）或提示词表述不佳，请直接提出引擎参数或提示词优化提案。');
  lines.push('');
  lines.push('可用算子（严格按 type 输出）：');
  lines.push('1. {"type":"A1_utterance_expand","target":"<intent_id>","add_utterances":["..."],"motivation":"...","evidence_cases":["case_id"]}  // 增补召回表达，每条≤20字，≤10条');
  lines.push('2. {"type":"A2_disambiguation","target":"<intent_id>","confusable":"<intent_id>","add_hints":["..."],"add_scope_out":["..."],"motivation":"...","evidence_cases":[...]}');
  lines.push('3. {"type":"A3_clause_expansion","target":"<intent_id>","add_clause_views":["..."],"motivation":"...","evidence_cases":[...]}  // 增补子句形态表达（该意图在复合句中作为子句出现时的说法，如「查下余额」），仅在多意图子句召回中生效，每条≤20字，≤10条');
  lines.push('4. {"type":"A4_description_rewrite","target":"<intent_id>","new_description":"...","motivation":"...","evidence_cases":[...]}  // 改写 description，拉开与混淆意图的边界');
  lines.push('5. {"type":"A5_clarify","target":"<intent_id>","add_clarify_question":"...","motivation":"...","evidence_cases":[...]}  // 增加澄清问题声明，使模糊输入触发澄清');
  lines.push('6. {"type":"E1_engine_param","target":"_engine","engine_params":{"<param_name>":<value>},"motivation":"...","evidence_cases":["case_id"]}  // 引擎参数调优，不修改图谱。以下参数可调：w_utt(utterance权重,0~1)、w_obj(object权重,0~1)、w_act(action权重,0~1)、sem_decay(语义衰减,0~1)、hint_decay(提示衰减,0~1)、score_cap(非精确上限,0~1)、clarify_low(低置信澄清阈值,0~1)、clarify_gap(混淆间隙,0~1)、subclause_min(子句门槛,0~1)。注意：三路权重之和建议≈1.0');
  lines.push('7. {"type":"P1_prompt_variant","target":"_prompt","prompt_variant":{"role":"recognition|optimizer","text":"..."},"motivation":"...","evidence_cases":["case_id"]}  // 提示词变体：recognition=识别提示词优化（改善意图识别准确率），optimizer=提案器提示词优化（改善提案质量）。text 为改写后的完整提示词文本');
  lines.push('');
  lines.push('硬约束：只能引用下方图谱中存在的 intent_id（E1/P1 的 target 固定为 _engine/_prompt）；禁止修改 identity/scope_in 之外的注入字段；泛化表达优先（覆盖一类说法），禁止逐字照抄测试用例原文作为别名；每条提案必须给 motivation 和 evidence_cases。motivation 面向业务人员解释理由：用意图中文名，禁止出现 intent_id、字段名（utterance_view/clause_view/hints）等内部术语。');
  lines.push('锚定硬约束：A1/A3 的增补表达必须贴住 evidence 坏例中期望意图对应的子句。多意图坏例中期望意图常以微弱分差输给近义竞争意图（如「查下申请进度」被「咨询申请进度」以 0.538 vs 0.5 压过）——泛化变体若丢掉子句的关键词序（如「查下」变成「查询」）就反超不了。因此：A3 clause_view 应产出子句的口语等价形态（可保留原词序，如「查下申请进度」「查一下申请进度」；子句是拆分产物、不是用例原文，不算照抄）；A1 utterance_view 产出该意图常见完整问法。禁止整句复述坏例（把两个子句拼回一整句是无效变异）；禁止与坏例子句无共同实体词的空洞泛化（如「入口」「在哪」单独成词）。评分是字符级相似度，表达离子句越近越能反超竞争意图。');
  lines.push('机制提示：A5 澄清声明会让该意图所有非精确命中进入澄清（可能伤及单意图用例），给意图加 A5 前，优先用 A1 把它的常见问法补足到可高分召回；A2 的 disambiguation_hints 会作为该意图的语义证据参与召回打分，提示文本应包含目标场景的高频词；A3 的 clause_view 只在多意图子句召回中打分，适合修「子句有弱匹配但未过门槛」或「子句竞争失败」的坏例。');
  lines.push('E1 使用指南：当坏例是「模糊意图应澄清但未触发」（clarify_not_triggered），可能是 clarify_low 阈值过高（该澄清的没澄清），可以提议降低 clarify_low；当坏例是「单意图被误触发澄清」，可能是 clarify_low 过低或 clarify_gap 过大，可以提议提高阈值。当多意图子句有弱匹配但未过门槛，可以提议降低 subclause_min。每次只调 1-2 个参数，给出明确动机。');
  lines.push('图召回指南：归因出现 graph_recall_gap（图通道已经召回期望意图但没进最终排序）时，优先调 graph_weight/graph_seed_floor/graph_row_floor（0~1）；出现 graph_edge_missing（期望意图不在任何通道候选域）时，用 A2 给它与竞争意图写 confusable 边。');
  lines.push('P1 使用指南：当坏例集中表现为同类意图识别困难（如多个意图的召回表达相似度极高），可以提议优化识别提示词；当 LLM 提案质量不高（频繁被门禁拦截），可以提议优化提案器提示词。text 字段为改写后的完整提示词文本，不超 5000 字。');
  if (engineParams) {
    lines.push(`\n## 当前引擎参数（E1 变异基线）`);
    lines.push(JSON.stringify(engineParams, null, 2));
  }
  const hist = (archive || []).filter(a => ['gated', 'rejected', 'adopted'].includes(a.status));
  if (hist.length) {
    lines.push('');
    lines.push('## 已尝试策略汇总（必须换方向，禁止重复同类提案）');
    // 按 (算子类型, 目标意图) 聚合失败原因
    const failByKey = {};
    for (const h of hist) {
      if (h.status === 'adopted') continue;
      const pr = h.proposal || {};
      const key = `${pr.type}→${pr.target}`;
      if (!failByKey[key]) failByKey[key] = { count: 0, reasons: [] };
      failByKey[key].count++;
      if (h.gate && h.gate.reason) failByKey[key].reasons.push(h.gate.reason.slice(0, 80));
    }
    const failEntries = Object.entries(failByKey).sort((a, b) => b[1].count - a[1].count);
    for (const [key, info] of failEntries.slice(0, 10)) {
      const topReasons = [...new Set(info.reasons)].slice(0, 2).join('；');
      lines.push(`- ${key}：失败 ${info.count} 次，原因：${topReasons || '未通过门禁'}`);
    }
    const adoptedKeys = new Set();
    for (const h of hist) {
      if (h.status === 'adopted') adoptedKeys.add(`${h.proposal?.type}→${h.proposal?.target}`);
    }
    if (adoptedKeys.size) {
      lines.push('已采纳（不要再对同 target 提同内容）：' + [...adoptedKeys].slice(0, 6).join('、'));
    }
    lines.push('上述已失败的策略方向不要原样重提。如果你的新提案与已失败提案同算子同目标，必须有本质区别（不同的 utterance/hint/参数）。');
    // 未试方向推荐：算子 × 错误意图 的组合中哪些从没试过
    const allOps = ['A1_add_utterances', 'A2_disambiguate', 'A3_add_clause_view', 'A4_add_hint', 'A5_adjust_score', 'A6_add_clarify_question', 'A7_scope_in'];
    const triedCombos = new Set();
    for (const h of hist) {
      triedCombos.add(`${(h.proposal||{}).type}→${(h.proposal||{}).target}`);
    }
    const errorTargets = [...new Set((attributions||[]).map(a => a.family).filter(Boolean))];
    if (errorTargets.length) {
      const untried = [];
      for (const op of allOps) {
        for (const t of errorTargets.slice(0, 8)) {
          if (!triedCombos.has(`${op}→${t}`)) untried.push(`${op}→${t}`);
        }
      }
      if (untried.length) {
        lines.push('');
        lines.push('## 未试方向（高优先探索，以下组合尚无任何提案记录）');
        lines.push(untried.slice(0, 12).join('、'));
      }
    }
  }
  lines.push('输出：仅一个 JSON 数组，最多 ' + MAX_PROPOSALS_PER_RUN + ' 个提案，按预期收益排序。');
  lines.push('');
  lines.push('## 坏例归因（train 侧）');
  for (const fam of attributions.slice(0, 6)) {
    lines.push(`\n### ${fam.family}（${fam.count} 条）→ 建议算子 ${fam.suggested_op}`);
    for (const s of fam.samples.slice(0, 4)) {
      lines.push(`- [${s.case_id}] 「${s.query}」 期望=${JSON.stringify(s.expected)} 实际=${JSON.stringify(s.predicted)}`);
      if (Array.isArray(s.clauses)) {
        for (const cl of s.clauses) {
          const expTxt = (cl.expected || []).map(e => `${e.id}第${e.rank || '?'}名(${e.score ?? '不在榜'})`).join('、');
          lines.push(`    子句「${cl.clause}」top1=${cl.top1 ? `${cl.top1.name}(${cl.top1.score})` : '无'}；期望：${expTxt}`);
        }
      }
    }
  }
  lines.push('\n## 相关意图当前声明');
  const involved = new Set();
  for (const fam of attributions.slice(0, 6)) {
    for (const s of fam.samples) { for (const e of s.expected || []) involved.add(e); }
  }
  for (const id of involved) {
    const n = nodeById(graph, id);
    if (!n) continue;
    lines.push(`\n### ${id}（${n.identity.intent_name}）`);
    lines.push(JSON.stringify({
      description: n.semantic_definition?.description,
      utterance_view: n.retrieval_profile?.utterance_view,
      semantic_view: n.retrieval_profile?.semantic_view,
      object_view: n.retrieval_profile?.object_view,
      action_view: n.retrieval_profile?.action_view,
      scope_out: n.semantic_definition?.scope_out,
      confusable_intents: n.semantic_definition?.confusable_intents,
      disambiguation_hints: n.semantic_definition?.disambiguation_hints,
      clarify_questions: n.decision_policy?.clarify_questions,
    }, null, 0));
  }
  if (counterfactuals && counterfactuals.length) {
    lines.push('\n## 反事实翻转分析（counterfactual）');
    lines.push('每条坏例的翻转条件——改什么能让这题翻。优先修复弥补分差最小（最容易翻转）的坏例。');
    for (const cf of counterfactuals.slice(0, 12)) {
      lines.push(`- [${cf.case_id}] 「${cf.query}」瓶颈=${cf.bottleneck}：${cf.flipCondition}`);
    }
  }
  return lines.join('\n');
}

function validateProposal(raw, graph, casesById) {
  if (!raw || typeof raw !== 'object') return '提案必须是对象';
  const op = raw.type;
  if (!OPS[op]) return `未知算子 ${op}`;
  const motivation = String(raw.motivation || '').trim();
  if (!motivation) return '缺少 motivation';
  if (!Array.isArray(raw.evidence_cases) || !raw.evidence_cases.length) return '缺少 evidence_cases';
  // combo：A6 主提案 + 竞争意图 A2 收边，递归校验各部分；恰好一个 A6，不允许嵌套
  if (op === 'combo') {
    const parts = Array.isArray(raw.parts) ? raw.parts : [];
    if (parts.length < 2 || parts.length > 4) return 'combo 需要 2 至 4 个子提案';
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part || typeof part !== 'object') return `combo 第 ${i + 1} 部分不是对象`;
      if (part.type === 'combo') return 'combo 不允许嵌套 combo';
      // 10-31 放宽：A1（说法注册）也是合法主提案——边界题修复配方常是「A1 注册泛问说法 + A2 收边」。
      // 约束不变：恰好一个主提案（A6 或 A1），其余是 A2；仍不允许嵌套。
      if (!['A6_ambiguity_cluster_expand','A1_utterance_expand','A2_disambiguation'].includes(part.type)) return 'combo 只允许 A6/A1 主提案与 A2 收边';
      const partError = validateProposal({ ...part,
        motivation: String(part.motivation || '').trim() || motivation,
        evidence_cases: Array.isArray(part.evidence_cases) && part.evidence_cases.length ? part.evidence_cases : raw.evidence_cases,
      }, graph, casesById);
      if (partError) return `combo 第 ${i + 1} 部分（${part.type || '无类型'}）：${partError}`;
    }
    const a6Parts = parts.filter(p => p.type === 'A6_ambiguity_cluster_expand');
    const a1Parts = parts.filter(p => p.type === 'A1_utterance_expand');
    if (a6Parts.length > 2) return 'combo 至多 2 个 A6 簇扩展主提案';
    if (a1Parts.length > 1) return 'combo 至多一个 A1 主提案';
    const a2Parts = parts.filter(p => p.type === 'A2_disambiguation');
    const mainCount = a6Parts.length + a1Parts.length;
    // 12-04 放开纯 A2 叠加：单个 A2 常只修 1 题，永远过不了「净修复≥2」门禁，
    // 反复 probePromoted 却 fullPassed=0 的算子必须允许多目标叠加成一个候选。
    if (mainCount === 0) {
      if (a2Parts.length < 2 || a2Parts.length > 3) return '纯 A2 组合需要 2 至 3 个 A2 子提案';
      const tgts = a2Parts.map(p => String(p.target || '').trim()).filter(Boolean);
      if (tgts.length < 2 || new Set(tgts).size !== tgts.length) return '纯 A2 组合的每个 A2 必须作用于不同意图';
      return null;
    }
    if (mainCount > 2) return 'combo 至多 2 个主提案（A6 至多 2 个，A1 至多 1 个）';
    return null;
  }
  // A6 是多目标算子：target 语义由 targets 承担，先做簇级校验再走通用单目标路径
  //（下游分支仍读 target 做字段校验，这里给 A6 补一个名义 target）。
  if (op === 'A6_ambiguity_cluster_expand') {
    const targets = Array.isArray(raw.targets) ? raw.targets.map(t => String(t || '').trim()).filter(Boolean) : [];
    if (targets.length < 2) return 'A6 缺 targets（歧义簇至少 2 个意图）';
    if (targets.length > 6) return 'A6 一次最多 6 个意图';
    for (const t of targets) if (!nodeById(graph, t)) return `A6 target 不存在: ${t}`;
    const arr = raw.add_utterances;
    if (!Array.isArray(arr) || !arr.length) return 'A6 缺 add_utterances';
    if (arr.length > 6) return 'A6 一次最多 6 条';
    for (const u of arr) {
      if (typeof u !== 'string' || !u.trim() || u.length > 20) return `别名不合法: ${u}`;
    }
    const anchorErr = (function () {
      const units = [];
      for (const cid of raw.evidence_cases) {
        const c = casesById && casesById.get ? casesById.get(cid) : null;
        if (!c) continue;
        units.push({ set: bigrams(c.query), th: 0.55 });
      }
      if (!units.length) return null;
      const prec = (b, u) => { let inter = 0; for (const x of b) if (u.set.has(x)) inter++; return b.size ? inter / b.size : 0; };
      const ok = arr.some(u => { const b = bigrams(u); return units.some(x => prec(b, x) >= x.th); });
      if (!ok) return 'A6 增补表达未锚定坏例：至少一条需贴近 evidence 坏例原话（轻泛化变体）';
      return null;
    })();
    if (anchorErr) return anchorErr;
    return null;
  }
  const target = String(raw.target || '').trim();
  if (!target) return '提案缺少 target 意图 ID（须使用图谱节点的 intent_id 原值）';
  if (!nodeById(graph, target)) return `目标意图不存在: ${target}`;

  // 锚定校验：A1/A3 至少一条增补表达"贴住" evidence 坏例的评分单元。
  // 多意图的评分单元是子句（整句复述别名推不动子句排名——正是 6/6 全拦根因），其余形态是整句。
  // 用非对称 precision（交集/变体 bigram 数）而非 dice：整句复述别名会靠长度在 dice 上占便宜（0.6+），
  // precision 衡量"变体内容有多少来自坏例评分单元"，整句复述仅 0.3-0.4，子句贴近变体 0.65+。
  const anchorCheck = (arr, label) => {
    const units = [];
    for (const cid of raw.evidence_cases) {
      const c = casesById && casesById.get ? casesById.get(cid) : null;
      if (!c) continue;
      if (c.intent_shape === 'multi_intent') {
        for (const cl of splitClauses(c.query)) units.push({ set: bigrams(cl), th: 0.6 });
      } else {
        units.push({ set: bigrams(c.query), th: 0.55 });
      }
    }
    if (!units.length) return null;
    const prec = (b, u) => { let inter = 0; for (const x of b) if (u.set.has(x)) inter++; return b.size ? inter / b.size : 0; };
    const ok = arr.some(u => { const b = bigrams(u); return units.some(x => prec(b, x) >= x.th); });
    if (!ok) return `${label} 增补表达未锚定坏例：至少一条需贴近 evidence 坏例的子句/整句（轻泛化变体，勿整句复述或空洞泛化）`;
    return null;
  };

  if (op === 'A1_utterance_expand') {
    const arr = raw.add_utterances;
    if (!Array.isArray(arr) || !arr.length) return 'A1 缺 add_utterances';
    if (arr.length > 10) return 'A1 一次最多 10 条';
    const node = nodeById(graph, target);
    const existing = new Set((node.retrieval_profile?.utterance_view || []).map(normalize));
    for (const u of arr) {
      if (typeof u !== 'string' || !u.trim() || u.length > 20) return `别名不合法: ${u}`;
      if (existing.has(normalize(u))) return `别名已存在: ${u}`;
    }
    const anchorErr = anchorCheck(arr, 'A1');
    if (anchorErr) return anchorErr;
  } else if (op === 'A3_clause_expansion') {
    const arr = raw.add_clause_views;
    if (!Array.isArray(arr) || !arr.length) return 'A3 缺 add_clause_views';
    if (arr.length > 10) return 'A3 一次最多 10 条';
    const node = nodeById(graph, target);
    const existing = new Set((node.retrieval_profile?.clause_view || []).map(normalize));
    for (const u of arr) {
      if (typeof u !== 'string' || !u.trim() || u.length > 20) return `子句表达不合法: ${u}`;
      if (existing.has(normalize(u))) return `子句表达已存在: ${u}`;
    }
    const anchorErr = anchorCheck(arr, 'A3');
    if (anchorErr) return anchorErr;
  } else if (op === 'A2_disambiguation') {
    if (raw.confusable && !nodeById(graph, raw.confusable)) return `confusable 不存在: ${raw.confusable}`;
    const hasHints = Array.isArray(raw.add_hints) && raw.add_hints.some(h => typeof h === 'string' && h.trim());
    const hasExclusions = Array.isArray(raw.add_scope_out) && raw.add_scope_out.some(h => typeof h === 'string' && h.trim());
    if (!hasHints && !hasExclusions && !raw.confusable) return 'A2 缺 add_hints、add_scope_out 或 confusable';
    for (const field of ['add_hints', 'add_scope_out']) {
      if (raw[field] != null && (!Array.isArray(raw[field]) || raw[field].some(h => typeof h !== 'string' || !h.trim() || h.length > 1000))) return `A2 ${field} 必须是非空文本数组`;
    }
    if ((raw.add_scope_out || []).some(h => /^intent_[a-z0-9_]+$/i.test(h.trim()))) return 'A2 add_scope_out 必须是用户说法，不能填写意图ID；易混淆意图ID请用 confusable';
  } else if (op === 'A4_description_rewrite') {
    if (!String(raw.new_description || '').trim()) return 'A4 缺 new_description';
    if (String(raw.new_description).length > 200) return 'A4 描述过长（≤200）';
  } else if (op === 'A5_clarify') {
    if (!String(raw.add_clarify_question || '').trim()) return 'A5 缺 add_clarify_question';
  } else if (op === 'E1_engine_param') {
    // 引擎参数调优提案：不修改图谱节点，调整验证器权重/阈值
    if (!raw.engine_params || typeof raw.engine_params !== 'object') return 'E1 缺 engine_params 对象';
    const validKeys = Object.keys(DEFAULT_ENGINE_PARAMS);
    for (const k of Object.keys(raw.engine_params)) {
      if (!validKeys.includes(k)) return `E1 未知参数: ${k}`;
      const v = raw.engine_params[k];
      if (typeof v !== 'number' || !isFinite(v)) return `E1 参数 ${k} 必须是数字`;
      // 权重类参数约束 0~1
      if (['w_utt', 'w_obj', 'w_act', 'sem_decay', 'hint_decay', 'score_cap', 'clarify_low', 'clarify_gap', 'subclause_min', 'no_match_floor', 'close_conf_ceil',
        'graph_weight', 'graph_seed_floor', 'graph_row_floor', 'graph_confusable_weight', 'graph_object_weight', 'graph_action_weight', 'graph_sibling_weight'].includes(k)) {
        if (v < 0 || v > 1) return `E1 参数 ${k} 超出 [0,1] 范围`;
      }
    }
  } else if (op === 'P1_prompt_variant') {
    // 提示词变体提案：不修改图谱，提供 LLM 改写后的提示词文本
    if (!raw.prompt_variant || typeof raw.prompt_variant !== 'object') return 'P1 缺 prompt_variant 对象';
    if (!raw.prompt_variant.role || !['recognition', 'optimizer'].includes(raw.prompt_variant.role)) return 'P1 role 必须是 recognition 或 optimizer';
    if (!String(raw.prompt_variant.text || '').trim()) return 'P1 缺 text';
    if (String(raw.prompt_variant.text).length > 5000) return 'P1 文本过长（≤5000）';
  }
  return null;
}

function applyProposal(graph, proposal, opts) {
  // combo：子提案顺序应用（A6 先、A2 收边后——顺序影响 scope_out 与新说法的生效组合）
  if (proposal.type === 'combo') {
    const parts = Array.isArray(proposal.parts) ? proposal.parts : [];
    if (parts.length < 2 || parts.length > 4) throw new Error('combo 需要 2 至 4 个子提案');
    let working = graph;
    const allChanges = [];
    for (const part of parts) {
      const result = applyProposal(working, part, opts);
      working = result.graph;
      for (const c of result.changes || []) allChanges.push(`[${part.type}] ${c}`);
    }
    return { graph: working, changes: allChanges };
  }
  // E1/P1 不修改图谱，返回原图 + 引擎参数/提示词变体
  if (proposal.type === 'E1_engine_param') {
    const ep = { ...((opts && opts.engineParams) || DEFAULT_ENGINE_PARAMS), ...proposal.engine_params };
    const changes = Object.keys(proposal.engine_params).map(k => `${k}: ${(opts && opts.engineParams && opts.engineParams[k]) ?? DEFAULT_ENGINE_PARAMS[k]} → ${proposal.engine_params[k]}`);
    return { graph: JSON.parse(JSON.stringify(graph)), changes, engineParams: ep };
  }
  if (proposal.type === 'P1_prompt_variant') {
    const changes = [`提示词变体(${proposal.prompt_variant.role}): ${String(proposal.prompt_variant.text).slice(0, 60)}...`];
    return { graph: JSON.parse(JSON.stringify(graph)), changes, promptVariant: proposal.prompt_variant };
  }
  const g = JSON.parse(JSON.stringify(graph));
  // A6 是簇算子：不走单节点路径，直接对 targets 逐个补说法
  if (proposal.type === 'A6_ambiguity_cluster_expand') {
    let total = 0, touched = 0;
    for (const t of proposal.targets || []) {
      const n = nodeById(g, t);
      if (!n) continue;
      const rp = n.retrieval_profile || (n.retrieval_profile = {});
      rp.utterance_view || (rp.utterance_view = []);
      const before = rp.utterance_view.length;
      for (const u of proposal.add_utterances) if (!rp.utterance_view.includes(u)) rp.utterance_view.push(u);
      total += rp.utterance_view.length - before; touched++;
    }
    return { graph: g, changes: [`歧义簇 ${touched} 个意图 utterance_view 共 +${total} 条`] };
  }
  const node = nodeById(g, proposal.target);
  if (!node) throw new Error('target 不存在');
  const sd = node.semantic_definition;
  const rp = node.retrieval_profile;
  const dp = node.decision_policy;
  const changes = [];
  if (proposal.type === 'A1_utterance_expand') {
    const before = rp.utterance_view.length;
    for (const u of proposal.add_utterances) if (!rp.utterance_view.includes(u)) rp.utterance_view.push(u);
    changes.push(`utterance_view +${rp.utterance_view.length - before} 条`);
  } else if (proposal.type === 'A3_clause_expansion') {
    if (!Array.isArray(rp.clause_view)) rp.clause_view = [];
    const before = rp.clause_view.length;
    for (const u of proposal.add_clause_views) if (!rp.clause_view.includes(u)) rp.clause_view.push(u);
    changes.push(`clause_view +${rp.clause_view.length - before} 条（仅子句召回生效）`);
  } else if (proposal.type === 'A2_disambiguation') {
    if (proposal.confusable && !(sd.confusable_intents || []).includes(proposal.confusable)) {
      sd.confusable_intents = [...(sd.confusable_intents || []), proposal.confusable];
      changes.push(`confusable_intents + ${proposal.confusable}`);
    }
    if (Array.isArray(proposal.add_hints)) {
      sd.disambiguation_hints = [...(sd.disambiguation_hints || []), ...proposal.add_hints.filter(h => String(h).trim())];
      changes.push(`disambiguation_hints +${proposal.add_hints.length} 条`);
    }
    if (Array.isArray(proposal.add_scope_out) && proposal.add_scope_out.length) {
      sd.scope_out = [...(sd.scope_out || []), ...proposal.add_scope_out];
      changes.push(`scope_out +${proposal.add_scope_out.length} 条`);
    }
  } else if (proposal.type === 'A4_description_rewrite') {
    changes.push(`description: 「${sd.description}」→「${proposal.new_description}」`);
    sd.description = proposal.new_description;
  } else if (proposal.type === 'A5_clarify') {
    dp.clarify_questions = [...(dp.clarify_questions || []), proposal.add_clarify_question];
    changes.push(`clarify_questions + 1 条`);
  } else if (proposal.type === 'A6_ambiguity_cluster_expand') {
    // 向簇内每个意图补同一组说法（去重按各意图自身 utterance_view）。
    let total = 0;
    for (const t of proposal.targets) {
      const n = nodeById(g, t);
      if (!n) continue;
      const rp = n.retrieval_profile || (n.retrieval_profile = {});
      rp.utterance_view || (rp.utterance_view = []);
      const before = rp.utterance_view.length;
      for (const u of proposal.add_utterances) if (!rp.utterance_view.includes(u)) rp.utterance_view.push(u);
      total += rp.utterance_view.length - before;
    }
    changes.push(`歧义簇 ${proposal.targets.length} 个意图 utterance_view 共 +${total} 条`);
  }
  return { graph: g, changes };
}

// ───────────────────────── 主流程 API ─────────────────────────

function nextVersion(v) {
  const n = parseInt(String(v).replace('v', ''), 10) || 1;
  return `v${n + 1}`;
}

function runBaseline() {
  const st = loadState();
  const graph = loadGraph(st.currentVersion, st);
  const cases = readCases(st);
  const byId = new Map(cases.map(c => [c.case_id, c]));
  // 使用当前版本关联的引擎参数（E1 采纳后固化）
  const ep = st.engineParams || DEFAULT_ENGINE_PARAMS;

  const trainResults = evaluateSet(graph, st.split.train, byId, { engineParams: ep });
  const heldResults = evaluateSet(graph, st.split.heldout, byId, { engineParams: ep });
  const allResults = [...trainResults, ...heldResults];

  const scores = {
    version: st.currentVersion,
    train: aggregate(trainResults),
    heldout: aggregate(heldResults),
    all: aggregate(allResults),
  };
  const attributions = attributeResults([...trainResults]);
  const regIds = Object.keys(st.regression || {});
  const regResults = regIds.map(id => allResults.find(r => r.case_id === id)).filter(Boolean);
  const regressionStatus = { total: regIds.length, pass: regResults.filter(r => r.strict).length };
  // 多路召回精度 + 模型裁决指标：纯离线推导，不调 LLM、不重跑引擎
  const recallMetrics = computeRecallMetrics(allResults);
  const adjudicationMetrics = computeAdjudicationMetrics(allResults, ep);
  st.baseline = { version: st.currentVersion, scores, attributions, results: allResults, engineParams: ep, recallMetrics, adjudicationMetrics, at: new Date().toISOString() };
  const regRows = new Map(allResults.map(r => [r.case_id, r]));
  st.regressionStatus = {
    enforced: regIds.filter(id => regRows.get(id)?.strict === true),
    quarantined: regIds.filter(id => regRows.get(id) && !regRows.get(id).strict),
    missing: regIds.filter(id => !regRows.has(id)),
    at: new Date().toISOString(),
  };
  st.baseline.goal = goalLib.goalProgress(goalLib.safeGoal(st.goal), scores, allResults, cases);
  // 成绩轨迹：每次考试按版本记一条（同版本重测覆盖），前端据此画跨版本进化曲线
  // 附 context（casesSha256/splitSha256）和 engineRev，前端 formalVersionView 据此判断版本间可比性画趋势连线
  const ctx = currentContext(st);
  const engRev = engineRevision({ ...process.env, INTENT_ENGINE_CONSUME_DECLARATIONS: '1' }, ROOT);
  st.scoreHistory = [...(st.scoreHistory || []).filter(h => h.version !== st.currentVersion), { version: st.currentVersion, at: st.baseline.at, scores, engineRev: engRev, context: ctx }];
  st.log.push({ at: new Date().toISOString(), event: 'baseline', detail: `v=${st.currentVersion} 全量 ${allResults.length} 条评测完成；${st.baseline.goal.summary}` });
  saveState(st);
  return { baseline: st.baseline, split: st.split, regressionStatus };
}

function proposalCore(p) {
  const pick = v => (Array.isArray(v) ? v.map(normalize).sort() : null);
  if (p.type === 'E1_engine_param') {
    const keys = p.engine_params ? Object.keys(p.engine_params).sort() : [];
    return { type: p.type, target: '__engine__', items: keys.map(k => `${k}=${p.engine_params[k]}`) };
  }
  if (p.type === 'P1_prompt_variant') {
    return { type: p.type, target: '__prompt_' + (p.prompt_variant?.role || '?') + '__', items: [normalize((p.prompt_variant?.text || '').slice(0, 80))] };
  }
  return { type: p.type, target: p.target, items: pick(p.add_utterances) || pick(p.add_clause_views) || pick(p.add_hints) || (p.new_description ? [normalize(p.new_description)] : p.add_clarify_question ? [normalize(p.add_clarify_question)] : []) };
}

function noveltyHit(raw, archive) {
  // 与任一历史提案同算子+同目标，且核心内容重叠 ≥ 0.5 → 视为重复（DGM novelty 过滤的轻量实现）
  const mine = proposalCore(raw);
  if (!mine.items.length) return false;
  for (const h of archive) {
    const theirs = proposalCore(h.proposal || {});
    if (theirs.type !== mine.type || theirs.target !== mine.target || !theirs.items.length) continue;
    const set = new Set(theirs.items);
    const inter = mine.items.filter(x => set.has(x)).length;
    if (inter / mine.items.length >= 0.5) return h;
  }
  return null;
}

// ── D: 提案多样性采样——多视角并发产出，覆盖更多算子空间 ──
// 单次 LLM 调用产出的候选倾向同一算子/目标；用不同"视角"（steering instruction）+
// 归因重排序 + 温度变化并发产出多组候选，合并去重后进入校验，提升算子空间覆盖率。
const PROPOSE_PERSPECTIVES = [
  {
    key: 'counterfactual_first',
    steer: '优先修复反事实分析中弥补分差最小（requiredDelta 最小）的坏例——这些最容易翻转，投入产出比最高。对这些题优先产出 A1/A3 锚定表达，精准反超竞争意图。',
    reorderAttributions: (attrs, counterfactuals) => {
      if (!counterfactuals || !counterfactuals.length) return attrs;
      const deltaByCase = new Map(counterfactuals.filter(c => c.requiredDelta != null).map(c => [c.case_id, c.requiredDelta]));
      return [...attrs].sort((a, b) => {
        const da = Math.min(...(a.samples || []).map(s => deltaByCase.has(s.case_id) ? deltaByCase.get(s.case_id) : Infinity));
        const db = Math.min(...(b.samples || []).map(s => deltaByCase.has(s.case_id) ? deltaByCase.get(s.case_id) : Infinity));
        return da - db;
      });
    },
    temperature: 0.4,
  },
  {
    key: 'explore_untried',
    steer: '优先使用尚未尝试过的算子类型（对照历史档案），探索新的优化方向。如果所有算子都已尝试，优先对未充分探索的意图 target 产出提案，避免在同一 target 上重复劳动。',
    reorderAttributions: (attrs, _cf, triedOps) => {
      return [...attrs].sort((a, b) => {
        const aTried = a.suggested_op ? (triedOps.has(a.suggested_op) ? 1 : 0) : 1;
        const bTried = b.suggested_op ? (triedOps.has(b.suggested_op) ? 1 : 0) : 1;
        return aTried - bTried;
      });
    },
    temperature: 0.7,
  },
  {
    key: 'engine_clarify',
    steer: '优先考虑引擎参数调优（E1）和澄清/歧义声明（A5/A6/combo）。这些方向常被表达补充淹没——检查是否有应澄清未澄清的坏例（clarify 阈值问题）、子句门槛不合理（subclause_min）、澄清间隙过大（clarify_gap）等引擎层面根因。',
    reorderAttributions: (attrs) => {
      const priority = f => (f.startsWith('ambig_') || f.includes('clarif') || f.includes('unnecessary')) ? 0 : 1;
      return [...attrs].sort((a, b) => priority(a.family) - priority(b.family));
    },
    temperature: 0.6,
  },
  {
    key: 'structural_recall',
    steer: '聚焦图结构和融合策略层面的优化，而非 utterance 微调。分析召回精度数据：如果某通道 Top3/Top5 命中率远高于 Top1，说明排序问题是主要瓶颈。应产出 A2 disambiguation、E1 engine_param（调 graph_weight/graph_row_floor）、或 A2 confusable 声明。如果 subgraph Top1 < 15%，优先用 A2 给语义相近意图写混淆边。严禁针对具体 badcase 硬编码。',
    reorderAttributions: (attrs) => {
      const priority = f => (f.includes('graph_') || f.includes('recall_gap') || f.includes('edge_missing')) ? 0 : 1;
      return [...attrs].sort((a, b) => priority(a.family) - priority(b.family));
    },
    temperature: 0.65,
  },
];

// 局部去重：同算子+同目标+核心内容重叠 >= 0.5 视为重复（用于同轮多视角候选合并）
function dedupeCandidates(candidates) {
  const seen = [];
  const out = [];
  for (const raw of candidates) {
    const core = proposalCore(raw);
    if (!core.items.length) { out.push(raw); continue; }
    const dup = seen.find(c => {
      if (c.type !== core.type || c.target !== core.target) return false;
      const set = new Set(c.items);
      const inter = core.items.filter(x => set.has(x)).length;
      return inter / core.items.length >= 0.5;
    });
    if (dup) continue;
    seen.push(core);
    out.push(raw);
  }
  return out;
}

async function runPropose() {
  const st = loadState();
  if (!st.baseline || st.baseline.version !== st.currentVersion) {
    throw new Error('请先对当前版本跑基线评测');
  }
  const graph = loadGraph(st.currentVersion, st);
  const cases = readCases(st);
  const byId = new Map(cases.map(c => [c.case_id, c]));
  const ep = st.engineParams || DEFAULT_ENGINE_PARAMS;

  // ── Step 1: 深度归因 — 用 graph-badcase/analyze 做语义级根因分析 ──
  // 在规则归因（attributeResults）之上叠加 agent 驱动的语义级根因，让提案器获得更精准的问题定位
  const trainResultIds = st.split.train;
  const baselineTrainResults = (st.baseline.results || []).filter(r => trainResultIds.includes(r.case_id));
  const deepAnalyses = await deepAnalyzeBadCases(baselineTrainResults, graph);

  // ── Step 1b: 反事实翻转分析 — 基于信号级 topk 分数计算每题翻转条件 ──
  const counterfactuals = counterfactualAnalysis(st.baseline.attributions || []);

  // ── Step 2: 构建提案提示 — 规则归因 + 反事实分析 + Agent 深度归因 ──
  let prompt = buildProposePrompt(st.baseline.attributions || [], graph, byId, st.archive, ep, counterfactuals);
  if (deepAnalyses.length) {
    prompt += '\n\n## Agent 深度归因（graph-badcase/analyze 语义级根因）';
    for (const da of deepAnalyses.slice(0, 8)) {
      prompt += `\n- [${da.case_id}] 「${da.query}」`;
      if (da.rootCause) prompt += ` 根因: ${da.rootCause}`;
      if (da.suggestion) prompt += ` 建议: ${da.suggestion}`;
    }
    prompt += '\n以上深度归因由 graph-badcase/analyze agent 产出，比纯规则归因更精准——优先参考其根因和建议产出提案。';
  }

  // P1 optimizer：如果已采纳 optimizer 提示词变体，用它作为 system prompt
  const optimizerPrompt = (st.promptVariants && st.promptVariants.optimizer && st.promptVariants.optimizer.text) || null;
  const systemContent = optimizerPrompt || '你是意图进化优化专家，只输出 JSON，不输出其他文本。';

  // ── Step 3: 多视角并发采样——主调用 + 多样性视角，覆盖更多算子空间 ──
  // 主调用: skill-build-agent（最佳质量，完整 prompt，无视角偏置）
  // 多样性调用: callLLM × N 视角（不同 steering instruction + 归因重排序 + 温度变化）
  const triedOps = new Set((st.archive || []).map(a => a.proposal && a.proposal.type).filter(Boolean));
  const baseAttributions = st.baseline.attributions || [];

  // 构建各视角的变体 prompt（归因重排序 + 视角指令注入）
  const perspectivePrompts = PROPOSE_PERSPECTIVES.map(p => {
    const reordered = p.reorderAttributions(baseAttributions, counterfactuals, triedOps);
    let vp = buildProposePrompt(reordered, graph, byId, st.archive, ep, counterfactuals, recallMetrics);
    if (deepAnalyses.length) {
      vp += '\n\n## Agent 深度归因（graph-badcase/analyze 语义级根因）';
      for (const da of deepAnalyses.slice(0, 8)) {
        vp += `\n- [${da.case_id}] 「${da.query}」`;
        if (da.rootCause) vp += ` 根因: ${da.rootCause}`;
        if (da.suggestion) vp += ` 建议: ${da.suggestion}`;
      }
      vp += '\n以上深度归因由 graph-badcase/analyze agent 产出，比纯规则归因更精准——优先参考其根因和建议产出提案。';
    }
    vp += `\n\n## 视角指令（${p.key}）\n${p.steer}`;
    return { key: p.key, temperature: p.temperature, prompt: vp };
  });

  // 并发执行：主调用 + 多样性视角调用
  const primaryCall = (async () => {
    let text = await callSkillBuildAgent(prompt, systemContent);
    let source = 'skill-build-agent';
    if (!text) {
      source = 'callLLM';
      st.stats.llmCalls++;
      text = await callLLM([
        { role: 'system', content: systemContent },
        { role: 'user', content: prompt },
      ], 180000);
    }
    return { text, source };
  })();

  const diversityCalls = perspectivePrompts.map(p =>
    callLLM([
      { role: 'system', content: systemContent },
      { role: 'user', content: p.prompt },
    ], 180000, 3000, null, p.temperature)
      .then(text => { st.stats.llmCalls++; return { text, source: `callLLM(${p.key},t=${p.temperature})` }; })
      .catch(() => ({ text: '', source: `callLLM(${p.key},failed)` }))
  );

  const results = await Promise.all([primaryCall, ...diversityCalls]);
  st.stats.proposeRuns++;

  // 合并所有候选 + 局部去重
  const allCandidates = [];
  const sources = [];
  for (const r of results) {
    if (!r.text) { sources.push(`${r.source}:0`); continue; }
    let arr;
    try { arr = extractJsonArray(r.text); } catch (_) { arr = []; }
    allCandidates.push(...arr);
    sources.push(`${r.source}:${arr.length}`);
  }
  if (!allCandidates.length) {
    throw new Error('提案输出无法解析为 JSON 数组（所有视角调用均未产出可解析候选）');
  }
  const deduped = dedupeCandidates(allCandidates);

  const accepted = [];
  const rejected = [];
  for (const raw of deduped.slice(0, MAX_PROPOSALS_PER_RUN * 3)) {
    const err = validateProposal(raw, graph, byId);
    if (err) { rejected.push({ proposal: raw, reason: err }); continue; }
    const dup = noveltyHit(raw, st.archive);
    if (dup) {
      st.stats.noveltyFiltered++;
      rejected.push({ proposal: raw, reason: `novelty: 与历史提案 ${dup.id} 重复（${dup.status}），不再浪费评估` });
      continue;
    }
    const id = 'prop_' + crypto.randomBytes(4).toString('hex');
    const entry = {
      id,
      proposal: raw,
      opLabel: OPS[raw.type].label,
      status: 'proposed',
      createdAt: new Date().toISOString(),
      trainScores: null,
      heldoutScores: null,
      gate: null,
      paretoOptimal: false,
      fixedCases: [],
      draftChanges: applyProposal(graph, raw, { engineParams: ep }).changes,
    };
    st.archive.unshift(entry);
    accepted.push(entry);
    st.stats.proposalsTotal++;
  }
  st.log.push({ at: new Date().toISOString(), event: 'propose', detail: `${sources.join(' + ')}，合并 ${allCandidates.length} 候选，去重后 ${deduped.length}，接受 ${accepted.length}，schema/novelty 拒绝 ${rejected.length}，深度归因 ${deepAnalyses.length} 条，反事实分析 ${counterfactuals.length} 条` });
  saveState(st);
  return { accepted, rejected, rawCount: allCandidates.length, deepAnalyses: deepAnalyses.length, proposalSource: sources.join('+') };
}

// E1 确定性参数搜索：坐标下降，不靠 LLM 猜参数
// 对每个引擎参数在搜索空间内做网格扫描，用确定性验证器评估，选 relaxed_pct 最优值
function runEngineParamSearch() {
  const st = loadState();
  if (!st.baseline || st.baseline.version !== st.currentVersion) {
    throw new Error('请先对当前版本跑基线评测');
  }
  const graph = loadGraph(st.currentVersion, st);
  const cases = readCases(st);
  const byId = new Map(cases.map(c => [c.case_id, c]));
  const baseEp = st.baseline.engineParams || st.engineParams || DEFAULT_ENGINE_PARAMS;
  const baseRelaxed = st.baseline.scores.train.relaxed_pct;
  const baseStrict = st.baseline.scores.train.strict_pct;

  // 参数搜索空间：每个参数定义扫描范围和步长
  const PARAM_SPACE = {
    w_utt:       { min: 0.35, max: 0.75, step: 0.05 },
    w_obj:       { min: 0.10, max: 0.40, step: 0.05 },
    w_act:       { min: 0.05, max: 0.35, step: 0.05 },
    sem_decay:   { min: 0.70, max: 1.00, step: 0.05 },
    hint_decay:  { min: 0.60, max: 1.00, step: 0.05 },
    score_cap:   { min: 0.85, max: 1.00, step: 0.01 },
    clarify_low: { min: 0.25, max: 0.55, step: 0.02 },
    clarify_gap: { min: 0.04, max: 0.20, step: 0.02 },
    subclause_min: { min: 0.15, max: 0.45, step: 0.03 },
    no_match_floor: { min: 0.03, max: 0.15, step: 0.02 },
    close_conf_ceil: { min: 0.60, max: 0.90, step: 0.05 },
  };

  let bestEp = { ...baseEp };
  let bestRelaxed = baseRelaxed;
  let bestStrict = baseStrict;
  const trials = [];

  // 坐标下降：逐参数扫描，每轮固定其他参数只变一个
  for (const [key, range] of Object.entries(PARAM_SPACE)) {
    const currentVal = bestEp[key];
    let bestVal = currentVal;
    let bestValRelaxed = bestRelaxed;

    for (let v = range.min; v <= range.max + 0.0001; v += range.step) {
      v = Math.round(v * 100) / 100; // 避免浮点累积
      if (Math.abs(v - currentVal) < 0.005) continue; // 跳过当前值（已知）

      const trialEp = { ...bestEp, [key]: v };
      const results = evaluateSet(graph, st.split.train, byId, { engineParams: trialEp });
      const scores = aggregate(results);
      trials.push({ key, value: v, relaxed_pct: scores.relaxed_pct, strict_pct: scores.strict_pct });

      // 优先 relaxed_pct，并列时取 strict_pct 更高者
      if (scores.relaxed_pct > bestValRelaxed ||
          (scores.relaxed_pct === bestValRelaxed && scores.strict_pct > bestStrict)) {
        bestValRelaxed = scores.relaxed_pct;
        bestVal = v;
      }
    }

    if (Math.abs(bestVal - currentVal) > 0.005) {
      bestEp[key] = bestVal;
      bestRelaxed = bestValRelaxed;
    }
  }

  const changedKeys = Object.keys(baseEp).filter(k => Math.abs(baseEp[k] - bestEp[k]) > 0.005);

  if (!changedKeys.length) {
    st.log.push({ at: new Date().toISOString(), event: 'engine_param_search', detail: `坐标下降 ${trials.length} 次试验，未找到更优参数` });
    saveState(st);
    return { improved: false, message: '坐标下降未找到更优参数', trials: trials.length, baseRelaxed, bestRelaxed };
  }

  // 生成 E1 提案
  const engineParams = {};
  for (const k of changedKeys) engineParams[k] = bestEp[k];

  const proposal = {
    type: 'E1_engine_param',
    target: '_engine',
    engine_params: engineParams,
    motivation: `坐标下降参数搜索（${trials.length}次试验）：${changedKeys.map(k => `${k}: ${baseEp[k]}→${bestEp[k]}`).join('，')}，train relaxed_pct ${baseRelaxed}%→${bestRelaxed}%`,
    evidence_cases: [],
  };

  const id = 'prop_' + crypto.randomBytes(4).toString('hex');
  const entry = {
    id,
    proposal,
    opLabel: OPS.E1_engine_param.label,
    status: 'proposed',
    createdAt: new Date().toISOString(),
    trainScores: null,
    heldoutScores: null,
    gate: null,
    paretoOptimal: false,
    fixedCases: [],
    draftChanges: [`坐标下降(${trials.length}次试验)：${changedKeys.map(k => `${k}: ${baseEp[k]}→${bestEp[k]}`).join('，')}`],
    searchMeta: { method: 'coordinate_descent', trials: trials.length, baseRelaxed, bestRelaxed, changedKeys },
  };
  st.archive.unshift(entry);
  st.stats.proposalsTotal++;
  st.log.push({ at: new Date().toISOString(), event: 'engine_param_search', detail: `坐标下降 ${trials.length} 次试验，找到 ${changedKeys.length} 个参数改进，relaxed ${baseRelaxed}%→${bestRelaxed}%` });
  saveState(st);
  return { improved: true, entry, trials: trials.length, changedKeys, baseRelaxed, bestRelaxed };
}

async function runEvaluateProposal(proposalId) {
  const st = loadState();
  const entry = st.archive.find(a => a.id === proposalId);
  if (!entry) throw new Error('提案不存在');
  if (entry.status === 'adopted' || entry.status === 'rejected') throw new Error('提案已终态');
  const graph = loadGraph(st.currentVersion, st);
  const baseline = st.baseline && st.baseline.version === st.currentVersion ? st.baseline : null;
  if (!baseline) throw new Error('当前版本无基线，请先跑基线');

  const cases = readCases(st);
  const byId = new Map(cases.map(c => [c.case_id, c]));
  // 图谱类提案用基线引擎参数；E1 引擎参数提案用变异后的参数评测
  const baseEp = baseline.engineParams || st.engineParams || DEFAULT_ENGINE_PARAMS;
  const { graph: draft, changes, engineParams: draftEp, promptVariant } = applyProposal(graph, entry.proposal, { engineParams: baseEp });
  const evalOpts = { engineParams: draftEp || baseEp };

  // 第一道门：train 初筛
  const trainResults = evaluateSet(draft, st.split.train, byId, evalOpts);
  // P1 recognition：对 ambiguous case 用 LLM + 变异提示词重判（确定性验证器最弱的场景）
  if (promptVariant && promptVariant.role === 'recognition') {
    await llmAmbiguousRerank(trainResults, draft, promptVariant.text);
  }
  const trainScores = aggregate(trainResults);
  const bTrain = baseline.scores.train;
  entry.trainScores = trainScores;

  const shapeRegressed = Object.keys(bTrain).some(k => {
    if (k === 'total') return false;
    return (bTrain[k]?.relaxed_pct ?? 0) - (trainScores[k]?.relaxed_pct ?? 0) > 5;
  });
  // 顺带计算：该提案把哪些 train 坏例修好了（采纳后固化为回归用例）
  const bResultsById = new Map((baseline.results || []).map(r => [r.case_id, r]));
  entry.fixedCases = trainResults
    .filter(r => r.strict && bResultsById.get(r.case_id) && !bResultsById.get(r.case_id).strict)
    .map(r => r.case_id);

  if (trainScores.relaxed_pct < bTrain.relaxed_pct || shapeRegressed) {
    entry.status = 'gated';
    entry.gate = { stage: 'train', reason: `练习题上没有变好（基本正确 ${bTrain.relaxed_pct}%→${trainScores.relaxed_pct}%），或某类意图退步超过 5 个百分点` };
    st.stats.evaluated++;
    saveState(st);
    return { entry };
  }

  // 第二道门：回归保护（已采纳提案修复的用例不得回退——熔断"采纳后回归失败"的事前拦截）
  // 只检查 baseline 中 strict=true 的 case：如果 baseline 已未通过，不算回归（本来就没修好）
  const regIds = Object.keys(st.regression || {});
  const regViolations = [];
  for (const rid of regIds) {
    const baseRr = baseline && baseline.results ? baseline.results.find(r => r.case_id === rid) : null;
    const rr = trainResults.find(r => r.case_id === rid);
    if (rr && baseRr && baseRr.strict && !rr.strict) regViolations.push(rid);
  }
  if (regViolations.length) {
    entry.status = 'gated';
    entry.gate = { stage: 'regression', reason: `让 ${regViolations.length} 道已经修好的题又错了（${regViolations.join('、')}）——已修复的错题不许再坏` };
    st.stats.evaluated++;
    saveState(st);
    return { entry };
  }

  // 语义验证：用 skill-judge 验证"修复成功"的 case 是否语义正确（而非仅 bigram 匹配）
  // 确定性验证器是字符级相似度，可能存在"bigram 匹配但语义错误"的假阳性——skill-judge 做语义裁决拦截
  if (entry.fixedCases.length > 0) {
    entry.semanticVerify = await semanticVerify(trainResults, draft);
  }

  // 第三道门：held-out 全量（变异循环期间对循环不可见的最终裁判）
  const heldResults = evaluateSet(draft, st.split.heldout, byId, evalOpts);
  // P1 recognition：heldout 也做 LLM 重判
  if (promptVariant && promptVariant.role === 'recognition') {
    await llmAmbiguousRerank(heldResults, draft, promptVariant.text);
  }
  const heldScores = aggregate(heldResults);
  const bHeld = baseline.scores.heldout;
  entry.heldoutScores = heldScores;

  const heldImproved = heldScores.relaxed_pct > bHeld.relaxed_pct || heldScores.strict_pct > bHeld.strict_pct;
  const heldRegressed = Object.keys(bHeld).some(k => {
    if (k === 'total') return false;
    return (bHeld[k]?.relaxed_pct ?? 0) - (heldScores[k]?.relaxed_pct ?? 0) > 3;
  });
  const bHeldResultsById = new Map((baseline.results || []).filter(r => st.split.heldout.includes(r.case_id)).map(r => [r.case_id, r]));
  const heldFixedCases = heldResults.filter(r => r.strict && bHeldResultsById.get(r.case_id) && !bHeldResultsById.get(r.case_id).strict).map(r => r.case_id);
  entry.heldFixedCases = heldFixedCases;
  const heldZeroBreak = heldScores.relaxed_pct >= bHeld.relaxed_pct;
  const heldNetFix = heldFixedCases.length >= 1;
  if (heldImproved && !heldRegressed) {
    entry.status = 'passed';
    entry.gate = { stage: 'passed', reason: `盲测题提升（完全正确 ${bHeld.strict_pct}%→${heldScores.strict_pct}%，基本正确 ${bHeld.relaxed_pct}%→${heldScores.relaxed_pct}%），已修复的题无退步${regIds.length ? `；盯守的 ${regIds.length} 条错题全部守住` : ''}` };
    st.stats.passed++;
  } else if (heldZeroBreak && heldNetFix && !heldRegressed) {
    entry.status = 'passed';
    entry.gate = { stage: 'passed', reason: '盲测题零破坏且净修复 ' + heldFixedCases.length + ' 题——基线已高，每修一题都是实质进展' };
    st.stats.passed++;
  } else {
    entry.status = 'gated';
    entry.gate = { stage: 'heldout', reason: heldRegressed ? '盲测题里某类意图退步超过 3 个百分点' : '盲测题成绩没有提升且无净修复' };
  }
  st.stats.evaluated++;

  // Pareto 标记：档案内按形态三维，无任何其他候选拟优于此候选
  const dims = e => [e.heldoutScores?.single_intent?.relaxed_pct ?? -1, e.heldoutScores?.multi_intent?.relaxed_pct ?? -1, e.heldoutScores?.ambiguous_intent?.relaxed_pct ?? -1];
  const mine = dims(entry);
  entry.paretoOptimal = !st.archive.some(o => o !== entry && o.status === 'passed' && dims(o).every((v, i) => v >= mine[i]) && dims(o).some((v, i) => v > mine[i]));

  st.log.push({ at: new Date().toISOString(), event: 'evaluate_proposal', detail: `${entry.id} → ${entry.status}` });
  saveState(st);
  return { entry };
}

function runAdopt(proposalId) {
  const st = loadState();
  const entry = st.archive.find(a => a.id === proposalId);
  if (!entry) throw new Error('提案不存在');
  if (entry.status !== 'passed') throw new Error('仅 passed 提案可采纳（当前 ' + entry.status + '）');
  const graph = loadGraph(st.currentVersion, st);
  const baseEp = (st.baseline && st.baseline.engineParams) || st.engineParams || DEFAULT_ENGINE_PARAMS;
  const { graph: next, engineParams: adoptedEp, promptVariant } = applyProposal(graph, entry.proposal, { engineParams: baseEp });
  const nv = nextVersion(st.currentVersion);
  writeJson(resolveGraphPath(nv), next);
  entry.status = 'adopted';
  entry.adoptedAs = nv;
  st.currentVersion = nv;
  // E1 引擎参数采纳：固化引擎参数到状态
  if (adoptedEp) {
    st.engineParams = adoptedEp;
  }
  // P1 提示词采纳：固化提示词变体到状态
  if (promptVariant) {
    if (!st.promptVariants) st.promptVariants = {};
    st.promptVariants[promptVariant.role] = { text: promptVariant.text, adoptedAt: nv };
  }
  // 固化器⑥：本提案修复的坏例回流为回归保护集——后续任何提案回退它们即被门禁拦截
  for (const cid of entry.fixedCases || []) {
    st.regression[cid] = { fixedIn: nv, by: entry.id };
  }
  st.stats.adopted++;
  const targetNode = nodeById(next, entry.proposal.target);
  let targetLabel = (targetNode && targetNode.identity && targetNode.identity.intent_name) || entry.proposal.target;
  // E1/P1 没有 target 节点，用算子标签代替
  if (entry.proposal.type === 'E1_engine_param') targetLabel = '引擎参数';
  if (entry.proposal.type === 'P1_prompt_variant') targetLabel = `${promptVariant.role} 提示词`;
  st.versions.push({ version: nv, applied: [entry.id], changelog: `${entry.opLabel} · ${targetLabel}：${entry.proposal.motivation}`, at: new Date().toISOString() });
  st.baseline = null; // 新版本需重跑基线
  st.log.push({ at: new Date().toISOString(), event: 'adopt', detail: `${entry.id} 采纳，固化为 ${nv}（基线已失效，请重跑）${adoptedEp ? `；引擎参数已更新` : ''}${promptVariant ? `；${promptVariant.role} 提示词已更新` : ''}${(entry.fixedCases || []).length ? `；${entry.fixedCases.length} 条修复用例进入回归保护` : ''}` });
  saveState(st);
  return { entry, currentVersion: nv };
}

function runReject(proposalId) {
  const st = loadState();
  const entry = st.archive.find(a => a.id === proposalId);
  if (!entry) throw new Error('提案不存在');
  entry.status = 'rejected';
  st.stats.rejected++;
  st.log.push({ at: new Date().toISOString(), event: 'reject', detail: `${entry.id} 人工拒绝` });
  saveState(st);
  return { entry };
}

// 共识④"档案化可回滚"的回滚半环：任一历史版本可整体回退（版本线性，晚于目标的
// 回归盯守项随图谱一并失效，移出盯守集——它们描述的是不再存在的图谱状态）
function runRollback(opts) {
  const st = loadState();
  const target = String((opts || {}).toVersion || '');
  const idx = st.versions.findIndex(v => v.version === target);
  if (idx === -1) throw new Error(`版本不存在: ${target}`);
  if (target === st.currentVersion) throw new Error('当前已是该版本，无需回滚');
  const from = st.currentVersion;
  const kept = {};
  for (const [cid, meta] of Object.entries(st.regression || {})) {
    const fi = st.versions.findIndex(v => v.version === meta.fixedIn);
    if (fi !== -1 && fi <= idx) kept[cid] = meta;
  }
  const dropped = Object.keys(st.regression || {}).length - Object.keys(kept).length;
  st.regression = kept;
  st.currentVersion = target;
  st.baseline = null;
  st.versions.push({ version: target, rollbackFrom: from, changelog: `人工回滚：${from} → ${target}`, at: new Date().toISOString() });
  st.log.push({ at: new Date().toISOString(), event: 'rollback', detail: `图谱回滚 ${from} → ${target}（基线失效，需重跑）${dropped ? `；${dropped} 条回滚后不再适用的盯守项已移出` : ''}` });
  saveState(st);
  return { from, currentVersion: target };
}

// ───────────────────────── 验证器对照（双验证器校准） ─────────────────────────

const CALIB_TIMEOUT_MS = 10 * 60 * 1000;
const CALIB_SCRIPT = path.join(__dirname, '..', 'scripts', 'rsi-engine-calibrate.js');

function calibrationReport(st) {
  const p = path.join(taskArtifactDir(st, 'calibration', CALIB_DIR), 'last.json');
  if (!fs.existsSync(p)) return null;
  try { return readJson(p); } catch (e) { return null; }
}

function runCalibrate(opts) {
  const st = loadState();
  if (st.calibration && st.calibration.status === 'running') {
    const prev = calibrationReport(st);
    if (prev && prev.finishedAt && (!st.calibration.startedAt || new Date(prev.finishedAt) > new Date(st.calibration.startedAt))) {
      st.calibration.status = 'done';
      saveState(st);
    } else if (Date.now() - new Date(st.calibration.startedAt).getTime() < CALIB_TIMEOUT_MS) {
      return { running: true, startedAt: st.calibration.startedAt };
    }
  }
  // 对照对象是当前版本图谱（采纳/回滚后跟版本走），不是固定底图
  const graphPath = resolveGraphPath(st.currentVersion, st);
  const graphRel = path.relative(RSI_DIR, graphPath).split(path.sep).join('/');
  const calibDir = taskArtifactDir(st, 'calibration', CALIB_DIR);
  const out = path.join(calibDir, 'last.json');
  if (fs.existsSync(out)) fs.unlinkSync(out);
  // 对照元数据独立落盘（不随 state 重开丢失）：记录本次对照时的图谱/题库指纹，
  // 之后图谱被采纳/回滚或题库重开，报告即判定过期，避免旧对照被当成现状
  writeJson(path.join(calibDir, 'meta.json'), {
    taskId: st.taskId,
    graph: graphRel,
    graphSha: fileSha256Of(graphPath),
    casesSha: casesSha256Of(st.casesFile || 'main', st),
    startedAt: new Date().toISOString(),
  });
  // key 全清：引擎降级为离线确定性形态，embedding cache-miss 不会写 data/graphs 生产缓存
  const child = spawn(process.execPath, [
    CALIB_SCRIPT,
    `--graph=${graphPath}`,
    `--cases=${taskCasesPathOf(st.taskId, st.casesFile)}`,
    `--out=${out}`,
    `--limit=${Math.max(0, Number((opts || {}).limit) || 0)}`,
  ], {
    cwd: ROOT,
    env: { ...process.env, QWEN_KEY: '', DEEPSEEK_KEY: '', KIMI_KEY: '', GLM_KEY: '', VOLCANO_KEY: '' },
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
  st.calibration = { status: 'running', startedAt: new Date().toISOString(), graph: graphRel, cases: readCases(st).length };
  st.log.push({ at: new Date().toISOString(), event: 'calibrate', detail: `启动生产引擎对照打分（离线形态，题库 ${st.calibration.cases} 条）` });
  saveState(st);
  return { started: true, graph: graphRel, cases: st.calibration.cases };
}

function calibrationPublicState(st) {
  const c = st.calibration || null;
  const r = calibrationReport(st);
  let status = c ? c.status : (r ? 'done' : 'idle');
  if (c && c.status === 'running') {
    const fresh = r && r.finishedAt && new Date(r.finishedAt) > new Date(c.startedAt);
    if (fresh) status = 'done';
    else if (Date.now() - new Date(c.startedAt).getTime() > CALIB_TIMEOUT_MS) status = 'error';
  }
  const report = status === 'done' && r && r.status === 'ok' ? (() => {
    const g = loadGraph(st.currentVersion, st);
    const toName = id => (nodeById(g, id) || {}).identity?.intent_name || id;
    // 引擎判的是同一张沙盒图，id→中文名可就地解析；漏网的兜底替换成中性表述（防内部 ID 上屏）
    const humanizeDetail = s => String(s || '')
      .replace(/intent_[a-z0-9_]+/g, m => toName(m))
      .replace(/intent_[a-z0-9_]+/g, '某个意图');
    return {
      finishedAt: r.finishedAt,
      engineMode: r.engineMode,
      engineErrors: r.engineErrors,
      engineMeta: r.engineMeta,
      matchOneScores: r.matchOneScores,
      agreement: r.agreement,
      totalCases: r.total,
      disagreements: (r.rows || []).filter(x => !x.agree && !x.error).slice(0, 8).map(x => ({
        case_id: x.case_id, query: x.query, shape: x.shape, detail: humanizeDetail(x.detail),
      })),
    };
  })() : (status === 'done' && r && r.status === 'error' ? { error: r.error, finishedAt: r.finishedAt } : null);
  // 对照过期判定：meta.json 记录出报告那次运行时的图谱/题库指纹（独立落盘，
  // gen-cases 重开实验/reset 后仍可判）；指纹对不上 = 结论描述的不是当前对象
  let stale = false;
  let staleReason = null;
  if (status === 'done' && r && r.status === 'ok') {
    const metaPath = path.join(taskArtifactDir(st, 'calibration', CALIB_DIR), 'meta.json');
    const meta = fs.existsSync(metaPath) ? (() => { try { return readJson(metaPath); } catch (e) { return null; } })() : null;
    if (meta) {
      const reasons = [];
      const curGraphSha = fileSha256Of(resolveGraphPath(st.currentVersion, st));
      const curCasesSha = casesSha256Of(st.casesFile || 'main', st);
      if (meta.graphSha && curGraphSha && meta.graphSha !== curGraphSha) reasons.push('图谱已更新（采纳或回滚过）');
      if (meta.casesSha && curCasesSha && meta.casesSha !== curCasesSha) reasons.push('题库已重开');
      if (reasons.length) { stale = true; staleReason = reasons.join('、'); }
    }
  }
  return { status, startedAt: c ? c.startedAt : null, graph: c ? c.graph : null, stale, staleReason, report };
}

// ───────────────────────── 园区任务（独立引擎调参记录，恢复自 f92e176e） ─────────────────────────

// 离线子进程的最小 env 白名单：容器 env 里的密钥/中继配置会让引擎逐条尝试网络调用
// （实测 8.5s/条；白名单后整体秒级）——"清空五个 key"不够，必须整体换最小环境
function offlineChildEnv() {
  const e = {};
  for (const k of ['PATH', 'HOME', 'LANG', 'TZ', 'NODE_ENV', 'SystemRoot', 'windir', 'COMSPEC']) {
    if (process.env[k]) e[k] = process.env[k];
  }
  return e;
}

function readParkHistory() {
  try { return readJson(PARK_HISTORY_PATH); } catch (e) { return { engine: 'intent-evaluator-park', totalCases: 0, versions: [] }; }
}

function parkCalibrationReport() {
  const p = path.join(CALIB_DIR, 'park-last.json');
  if (!fs.existsSync(p)) return null;
  try { return readJson(p); } catch (e) { return null; }
}

function runParkCalibrate(opts) {
  const st = loadState();
  if (st.parkCalibration && st.parkCalibration.status === 'running') {
    const prev = parkCalibrationReport();
    if (prev && prev.finishedAt && (!st.parkCalibration.startedAt || new Date(prev.finishedAt) > new Date(st.parkCalibration.startedAt))) {
      st.parkCalibration.status = 'done';
      saveState(st);
    } else if (Date.now() - new Date(st.parkCalibration.startedAt).getTime() < 10 * 60 * 1000) {
      return { running: true, startedAt: st.parkCalibration.startedAt };
    }
  }
  const out = path.join(CALIB_DIR, 'park-last.json');
  if (fs.existsSync(out)) fs.unlinkSync(out);
  const child = spawn(process.execPath, [
    PARK_CALIB_SCRIPT,
    `--out=${out}`,
    `--limit=${Math.max(0, Number((opts || {}).limit) || 0)}`,
  ], {
    cwd: ROOT,
    env: offlineChildEnv(),
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
  st.parkCalibration = { status: 'running', startedAt: new Date().toISOString() };
  st.log = st.log || [];
  st.log.push({ at: new Date().toISOString(), event: 'park_calibrate', detail: '启动园区引擎校准打分' });
  saveState(st);
  return { started: true };
}

function parkCalibrationPublicState(st) {
  const c = st.parkCalibration || { status: 'idle', startedAt: null };
  if (c.status !== 'running') {
    const r = parkCalibrationReport();
    if (r && r.finishedAt) return { status: 'done', startedAt: c.startedAt, report: r };
    return { status: 'idle', startedAt: null, report: null };
  }
  const r = parkCalibrationReport();
  if (r && r.finishedAt && new Date(r.finishedAt) > new Date(c.startedAt)) {
    return { status: 'done', startedAt: c.startedAt, report: r };
  }
  if (Date.now() - new Date(c.startedAt).getTime() > 10 * 60 * 1000) {
    return { status: 'error', startedAt: c.startedAt, report: null };
  }
  return { status: 'running', startedAt: c.startedAt, report: null };
}

// ───────────────────────── 任务注册表：多任务列表（评审报告阶段 C） ─────────────────────────
// 当前两个任务：bank=意图进化实验台（可进化）、park=园区引擎调参记录（只读历史+校准）。
// 列表只读聚合，不改任何实验状态；任务级隔离存储（tasks/<id>/state.json）留待后续阶段，
// 当前两个任务的数据源天然不同文件，已满足"选择任务→进入详情"的隔离展示。

// 任务注册表：扫描 tasks/ 目录聚合每个任务的运行时摘要（列表页数据源）。
// 含迁移任务（legacy/fresh）+ 用户自建任务；park 园区记录不是 RSI 任务，仍单列。
function taskSummaryOf(taskId, suppliedState) {
  const dir = path.join(TASKS_DIR, taskId);
  const st = suppliedState || readStateJson(path.join(dir, 'state.json'));
  const b = st.baseline;
  let scoreValidity = { current: false, reason: '缺少有效的生产评测证据', metric: 'strict_pct', split: 'all', value: null, n: 0 };
  if (productionRuntime.scoreValidity) {
    try { scoreValidity = productionRuntime.scoreValidity(st) || scoreValidity; }
    catch (e) { scoreValidity.reason = e.message; }
  }
  const runMap = new Map((st.evolveRuns || []).map(r => [r.id, r]));
  if (st.activeEvolution) runMap.set(st.activeEvolution.id, st.activeEvolution);
  const runs = [...runMap.values()];
  const pendingReview = (st.archive || []).filter(e => e.status === 'proposed' || e.status === 'passed').length;
  const lastScore = (st.scoreHistory || []).slice(-1)[0] || null;
  const goal = goalLib.safeGoal(st.goal);
  const goalCurrent = scoreValidity.current ? b?.scores?.all?.[goal.metric] ?? null : null;
  return {
    id: taskId,
    name: st.taskName || taskId,
    archived: st.archived === true,
    kind: 'evolvable',
    description: st.taskDesc || ('意图图谱进化任务（底图 ' + (st.baseGraph ? st.baseGraph.label || st.baseGraph.id : 'seed') + '）'),
    targetGraph: st.baseGraph ? (st.baseGraph.label || st.baseGraph.id) : null,
    currentVersion: st.currentVersion,
    // 目标导向：任务列表直接显示「离目标还差多少」，而不是只有当前分数
    goal: { metric: goal.metric, target: goal.target, current: goalCurrent === null ? null : +Number(goalCurrent).toFixed(1) },
    goalMet: goalCurrent !== null && goalCurrent >= goal.target,
    caseCount: st.split ? ((st.split.train || []).length + (st.split.heldout || []).length + (st.split.test || []).length) : 0,
    testCount: (st.split && st.split.test ? st.split.test.length : 0),
    baselineStrict: scoreValidity.current ? b?.scores?.all?.strict_pct ?? null : null,
    baselineRelaxed: scoreValidity.current ? b?.scores?.all?.relaxed_pct ?? null : null,
    baselineCurrent: scoreValidity.current,
    scoreValidity,
    bestStrict: scoreValidity.current ? scoreValidity.value : null,
    lastMeasuredStrict: b?.scores?.all?.strict_pct ?? null,
    candidates: { total: (st.archive || []).length, pendingReview },
    rounds: runs.reduce((sum, run) => sum + (Array.isArray(run.rounds) ? run.rounds.length : 0), 0),
    runs: runs.length,
    adoptedVersions: Math.max(0, (st.versions || []).length - 1),
    running: productionRuntime.runningTaskId?.() === taskId,
    active: readActiveTaskId() === taskId,
    updatedAt: st.log && st.log.length ? st.log[st.log.length - 1].at : null,
    engineRev: st.currentEngineRev || (b && b.engineRev) || null,
  };
}

async function taskRegistry() {
  const tasks = await Promise.all(listTaskIds().map(async taskId => {
    try {
      const state=await readStateJsonAsync(path.join(TASKS_DIR,taskId,'state.json'));
      return taskSummaryOf(taskId,state);
    } catch(error) {
      return {id:taskId,name:taskId,kind:'evolvable',description:'任务记录暂时无法读取，请重新加载或检查任务详情',loadError:error.message,
        targetGraph:null,currentVersion:null,caseCount:0,testCount:0,baselineStrict:null,baselineRelaxed:null,baselineCurrent:false,bestStrict:null,
        candidates:{total:0,pendingReview:0},rounds:0,adoptedVersions:0,running:false,active:false,updatedAt:null,engineRev:null};
    }
  }));
  // 兼容：无任务系统数据时回落到旧的单任务摘要（全局 STATE_PATH）
  if (!tasks.length) {
    const st = loadState();
    const b = st.baseline;
    const lastScore = (st.scoreHistory || []).slice(-1)[0] || null;
    tasks.push({
      id: 'default', name: '意图进化实验台', kind: 'evolvable',
      description: '意图图谱的递归自我改进：考出弱点 → AI 开方 → 四关验证 → 拍板采纳',
      targetGraph: st.baseGraph ? (st.baseGraph.label || st.baseGraph.id) : null,
      currentVersion: st.currentVersion,
      caseCount: st.split ? ((st.split.train || []).length + (st.split.heldout || []).length) : 0,
      testCount: (st.split && st.split.test ? st.split.test.length : 0),
      baselineStrict: b && b.scores && b.scores.all ? b.scores.all.strict_pct : null,
      baselineRelaxed: b && b.scores && b.scores.all ? b.scores.all.relaxed_pct : null,
      baselineCurrent: !!b && !b.stale && b.version === st.currentVersion,
      bestStrict: lastScore && lastScore.scores && lastScore.scores.all ? lastScore.scores.all.strict_pct : null,
      candidates: { total: (st.archive || []).length, pendingReview: (st.archive || []).filter(e => e.status === 'proposed' || e.status === 'passed').length },
      rounds: (st.stats && st.stats.proposeRuns) || 0,
      adoptedVersions: Math.max(0, (st.versions || []).length - 1),
      running: false, active: true,
      updatedAt: st.log && st.log.length ? st.log[st.log.length - 1].at : null,
      engineRev: st.currentEngineRev || (b && b.engineRev) || null,
    });
  }
  // park 园区调参记录（只读，独立数据源）
  const ph = readParkHistory();
  const pc = parkCalibrationPublicState(loadState());
  const pv = ph.versions || [];
  tasks.push({
    id: 'park', name: '园区引擎调参记录', kind: 'readonly',
    description: '智慧园区独立引擎的调参精度曲线与实时校准（只读历史，不走 RSI 循环）',
    targetGraph: 'intent-evaluator-park',
    currentVersion: pv.length ? pv[pv.length - 1].version : null,
    caseCount: ph.totalCases || 0, testCount: 0,
    baselineStrict: pv.length ? pv[0].strict_pct : null,
    baselineRelaxed: pv.length ? pv[0].relaxed_pct : null,
    baselineCurrent: true,
    bestStrict: pv.length ? pv[pv.length - 1].strict_pct : null,
    candidates: { total: 0, pendingReview: 0 },
    rounds: Math.max(0, pv.length - 1),
    adoptedVersions: Math.max(0, pv.length - 1),
    running: pc.status === 'running', active: false,
    updatedAt: null, engineRev: null, calibrationStatus: pc.status,
  });
  return tasks;
}

// 任务名 → 目录 id（小写字母数字连字符）
function nameToTaskId(name) {
  return String(name).trim().toLowerCase()
    .replace(/[^a-z0-9\-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || ('task-' + Date.now().toString(36));
}

// 新建任务：独立底图 + 独立题库 → 独立 state。新任务自动成为当前任务。
function runCreateTask(opts) {
  const name = String(opts.name || '').trim().slice(0, 40);
  if (!name) throw new Error('任务名不能为空');
  const desc = String(opts.description || '').trim().slice(0, 200);
  const base = String(opts.base || 'seed');
  const id = nameToTaskId(name);
  const dir = path.join(TASKS_DIR, id);
  if (!TASK_ID_RE.test(id)) throw new Error('任务名需能生成 3-48 位小写字母/数字/连字符的 id');
  if (fs.existsSync(dir)) throw new Error('任务已存在: ' + id);
  // 底图：seed / 已导入 snapshot / manifest 线上版本（自动导入，打通图谱编辑器资产）
  let baseGraph, casesSeed;
  if (base === 'seed') {
    baseGraph = { kind: 'seed', id: 'seed', label: '种子图谱' };
    casesSeed = readJson(CASES_PATH).cases;
  } else if (base.startsWith('manifest:')) {
    // 10-16 打通 AI Harbor：manifest:<versionId> = 从图谱编辑器的版本清单直接选线上版本，
    // 未导入过则先落一份 RSI 快照（与 import-snapshot 同一套裁剪规则）
    const vid = base.slice('manifest:'.length);
    if (!fs.existsSync(MANIFEST_PATH)) throw new Error('未找到 intent-graph-version-manifest.json（图谱资产不可达）');
    const entry = (readJson(MANIFEST_PATH).versions || []).find(v => v.version_id === vid);
    if (!entry) throw new Error(`图谱版本清单中无 ${vid}`);
    let snapPath = path.join(SNAPSHOTS_DIR, `${vid}.json`);
    if (!fs.existsSync(snapPath)) {
      const graphFile = path.join(ROOT, entry.graph_file);
      if (!fs.existsSync(graphFile)) throw new Error(`图谱文件不存在: ${entry.graph_file}`);
      const full = readJson(graphFile);
      const nodes = (full.intent_nodes || []).map(n => (
        { identity: n.identity, semantic_definition: n.semantic_definition || {}, retrieval_profile: n.retrieval_profile || {}, decision_policy: n.decision_policy || {} }
      ));
      if (!nodes.length) throw new Error('该版本无 intent_nodes，拒绝导入');
      if (!fs.existsSync(SNAPSHOTS_DIR)) fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
      writeJson(snapPath, {
        meta: { ...(full.meta || {}), version_id: vid, rsi_imported_at: new Date().toISOString(), rsi_note: 'RSI 实验台只读快照（字段裁剪），源=' + entry.graph_file },
        intent_nodes: nodes,
      });
    }
    baseGraph = { kind: 'snapshot', id: vid, label: entry.version_name || vid };
    casesSeed = [];
  } else if (base.startsWith('snapshot:')) {
    const sid = base.slice('snapshot:'.length);
    const sp = path.join(SNAPSHOTS_DIR, sid + '.json');
    if (!fs.existsSync(sp)) throw new Error('快照不存在: ' + sid);
    const g = readJson(sp);
    baseGraph = { kind: 'snapshot', id: sid, label: (g.meta && g.meta.version_id) || sid };
    casesSeed = [];
  } else {
    throw new Error('base 须为 seed、snapshot:<id> 或 manifest:<versionId>');
  }
  // 评测集来源（10-16 多任务 P0-②）：inherit=复制全局当前题库（默认）；none=空题库，
  // 创建后用 gen-cases 让 AI 出题。题库副本进任务目录——gen-cases 重开只影响本任务。
  const casesSource = String(opts.casesSource || 'inherit');
  if (casesSource === 'none') casesSeed = [];
  else if (!['inherit', 'dataset', 'file'].includes(casesSource)) throw taskContext.fail('casesSource 须为 inherit、none、dataset 或 file');
  let importReport = null;
  let imported = false;
  let sourceName = null;
  const graph = loadGraph('v1', { baseGraph });
  if (opts.datasetId || opts.cases !== undefined || ['dataset', 'file'].includes(casesSource)) {
    const source = datasetSource(opts);
    const normalized = normalizeCases(source.rawCases, graph, opts);
    casesSeed = normalized.cases; importReport = normalized.report; sourceName = source.sourceName; imported = true;
  } else if (casesSeed.length) {
    // inherit 历史题库：宽容模式过滤坏题（如老数据里标准答案不足 2 的多意图题），
    // 不阻断任务创建；报告里 filtered/rejected 可见
    const normalized = normalizeCases(casesSeed, graph, { ...opts, legacyTolerant: true });
    casesSeed = normalized.cases; importReport = normalized.report;
  }
  // 切分配置（10-16 多任务 P1-④）：train 比例 / seed / test 比例。test>0 时在创建时即切出
  // 终极考集并随 state 封存——开考后不可再补，否则失去「全程不可见」效力。
  const splitOpts = {
    trainRatio: Number(opts.trainRatio) || undefined,
    seed: Number.isInteger(opts.splitSeed) ? opts.splitSeed : undefined,
    testRatio: Number(opts.testRatio) || 0,
    // 目标随任务创建固化：后续所有运行都以它判定「达标没达标」。
    goal: opts.goal || (opts.targetStrict != null ? { target: opts.targetStrict, minEffect: opts.minEffect } : undefined),
  };
  const casesFile = imported || baseGraph.kind === 'snapshot' ? 'imported' : 'main';
  const st = makeFreshState(baseGraph, casesFile, casesSeed, splitOpts);
  st.taskId = id;
  st.taskName = name;
  if (desc) st.taskDesc = desc;
  // 引擎归属（10-16 打通）：记录任务创建时选的评测引擎（与图谱评测页注册表同一 id 体系，
  // 如 v2:intent-graph-v2.1-p1-batch10 / bank:ccb-mobile-bank-intents），详情页档案可见。
  // 打分实际统一走生产引擎——保证不同任务成绩可比与防自证。
  if (opts.engine) st.engineRef = String(opts.engine).slice(0, 80);
  st.createdAt = new Date().toISOString();
  st.revision = 1;
  const staging = path.join(TASKS_DIR, '.create-' + crypto.randomBytes(8).toString('hex'));
  try {
    const document = { version: 2, imported_from: sourceName, cases: casesSeed };
    writeJson(path.join(staging, casesFile === 'imported' ? 'cases.imported.json' : 'cases.main.json'), document);
    st.integrity.casesSha256 = fileSha256Of(path.join(staging, casesFile === 'imported' ? 'cases.imported.json' : 'cases.main.json'));
    writeJson(path.join(staging, 'state.json'), st);
    fs.renameSync(staging, dir);
    const result = { task: taskSummaryOf(id), state: publicState(st), importReport };
    writeActiveTaskId(id);
    return result;
  } catch (e) {
    if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

// 切换当前任务：后续所有 loadState/saveState 与打分都落在新任务
function runSwitchTask(opts) {
  const id = String(opts.id || '');
  if (id === 'park') { writeActiveTaskId(id); return { ok: true, active: id }; }
  const dir = path.join(TASKS_DIR, id);
  if (!fs.existsSync(path.join(dir, 'state.json'))) throw new Error('任务不存在: ' + id);
  writeActiveTaskId(id);
  return { ok: true, active: id, state: publicState(taskContext.run({ taskId: id }, loadState)) };
}

// 删除任务（软删除）：目录改名进 .trash- 前缀，不真正 rm——误删可人工改回。
// 保护：park 只读任务、正在运行的进化任务拒绝删除。
function runDeleteTask(opts) {
  const id = String(opts.id || '').trim();
  if (!id) throw new Error('缺少任务 id');
  if (id === 'park') throw new Error('park 为系统只读任务，不可删除');
  const dir = path.join(TASKS_DIR, id);
  if (!fs.existsSync(path.join(dir, 'state.json'))) throw new Error('任务不存在: ' + id);
  const st = readJson(path.join(dir, 'state.json'));
  if (st.activeEvolution && st.activeEvolution.running) throw new Error('任务正在运行进化，禁止删除');
  const trashed = path.join(TASKS_DIR, '.trash-' + id + '-' + Date.now());
  fs.renameSync(dir, trashed);
  // 先切活动指针再碰注册表：注册表内部 loadState 跟随活动指针，指针若还指向
  // 已删任务会直接抛"任务不存在"（10-17 实测），导致指针永远悬空
  const switched = readActiveTaskId() === id;
  if (switched) {
    const rest = listTaskIds().filter(tid => tid !== 'park' && fs.existsSync(path.join(TASKS_DIR, tid, 'state.json')));
    writeActiveTaskId(rest[0] || 'park');
  }
  return { deleted: id, trashedTo: path.basename(trashed), switchedAway: switched };
}

function runReset() {
  const prev = loadState();
  const taskId = prev.taskId === 'default' ? null : prev.taskId;
  const taskDir = taskId ? path.join(TASKS_DIR, taskId) : null;
  // 任务化：reset 只清当前任务的 state 与版本图（无任务时回落全局行为）
  if (taskDir) {
    for (const f of fs.readdirSync(taskDir).filter(f => /^rsi-graph\..+\.json$/.test(f))) fs.unlinkSync(path.join(taskDir, f));
  } else {
    const files = fs.existsSync(VERSIONS_DIR) ? fs.readdirSync(VERSIONS_DIR).filter(f => f.endsWith('.json')) : [];
    for (const f of files) fs.unlinkSync(path.join(VERSIONS_DIR, f));
  }
  // 保留底图轨道与题库选择，只清版本/档案/基线；切分配置同样继承（reset 不改变成绩口径）
  const st = preserveTask(prev, makeFreshState(prev.baseGraph || { kind: 'seed', id: 'seed', label: '智慧园区种子图谱' }, prev.casesFile || 'main', readCases(prev), prev.splitConfig), true);
  saveState(st);
  return { reset: true, state: publicState(st) };
}

// ───────────────────────── 底图轨道：真实图谱快照导入 + 配套题库生成 ─────────────────────────

const SNAPSHOT_KEEP_FIELDS = ['identity', 'semantic_definition', 'retrieval_profile', 'decision_policy'];

function listSnapshots() {
  if (!fs.existsSync(SNAPSHOTS_DIR)) return [];
  return fs.readdirSync(SNAPSHOTS_DIR).filter(f => f.endsWith('.json')).map(f => {
    try {
      return readSnapshotInfo(path.join(SNAPSHOTS_DIR, f));
    } catch (e) { return null; }
  }).filter(Boolean);
}

function runImportSnapshot(opts) {
  if (!fs.existsSync(MANIFEST_PATH)) throw new Error('未找到 intent-graph-version-manifest.json（真实图谱资产不可达）');
  const manifest = readJson(MANIFEST_PATH);
  const wanted = String(opts.versionId || manifest.active_default);
  const entry = (manifest.versions || []).find(v => v.version_id === wanted);
  if (!entry) throw new Error(`manifest 中无版本 ${wanted}`);
  const graphFile = path.join(ROOT, entry.graph_file);
  if (!fs.existsSync(graphFile)) throw new Error(`图谱文件不存在: ${entry.graph_file}`);
  const full = readJson(graphFile);
  const nodes = (full.intent_nodes || []).map(n => (
    { identity: n.identity, semantic_definition: n.semantic_definition || {}, retrieval_profile: n.retrieval_profile || {}, decision_policy: n.decision_policy || {} }
  ));
  if (!nodes.length) throw new Error('快照无 intent_nodes，拒绝导入');
  if (!fs.existsSync(SNAPSHOTS_DIR)) fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  const slimGraph = {
    meta: { ...(full.meta || {}), version_id: entry.version_id, rsi_imported_at: new Date().toISOString(), rsi_note: 'RSI 实验台只读快照（字段裁剪：identity/semantic_definition/retrieval_profile/decision_policy），源=' + entry.graph_file },
    intent_nodes: nodes,
  };
  writeJson(path.join(SNAPSHOTS_DIR, `${entry.version_id}.json`), slimGraph);
  // 只写快照文件，不切当前实验轨道；进入快照轨道由 gen-cases（出配套题后自动切换）或 switch-base 完成
  const importedCases = fs.existsSync(CASES_IMPORTED_PATH) ? readJson(CASES_IMPORTED_PATH).cases : [];
  return {
    snapshot: { id: entry.version_id, intents: nodes.length, label: entry.version_name || entry.version_id },
    importedCases: importedCases.length,
    next: importedCases.length ? `调用 switch-base {base:"snapshot:${entry.version_id}"} 进入该轨道，或直接 gen-cases 重新出题` : `调用 gen-cases {base:"snapshot:${entry.version_id}"} 生成配套题库并进入该轨道`,
  };
}

// org-graph 文档节点（AI 建图导出）→ RSI 七段节点归一化。映射：identity←node.id/properties.name、
// description←goal、scope_in/out/utterance_view 同名直取、object/action_view←tb_object_name/tb_action_code；
// disambiguation/clarify 等留空，由 A2/A5 算子在进化中填充。
function orgGraphNodeToRsi(n) {
  const p = n.properties || {};
  const asArr = v => (Array.isArray(v) ? v.map(String) : (v == null || v === '' ? [] : [String(v)]));
  const scopeIn = asArr(p.scope_in);
  const utter = asArr(p.utterance_view);
  const goal = String(p.goal || '');
  return {
    identity: { intent_id: String(n.id || ''), intent_name: String(p.name || n.id || '') },
    semantic_definition: {
      description: goal,
      scope_in: scopeIn,
      scope_out: asArr(p.scope_out),
      disambiguation_hints: asArr(p.disambiguation_hints),
      confusable_intents: asArr(p.confusable_intents),
    },
    retrieval_profile: {
      utterance_view: utter.length ? utter : scopeIn,
      clause_view: [],
      semantic_view: goal ? [goal] : [],
      object_view: asArr(p.tb_object_name),
      action_view: asArr(p.tb_action_code),
    },
    decision_policy: { clarify_questions: [] },
  };
}

// 本地图谱文件导入（10-16 打通 AI Harbor 补充）：不经 manifest，前端直接上传图谱 JSON。
// 校验意图节点非空后落为 RSI 快照——兼容 RSI 七段快照（intent_nodes）与 AI 建图 org-graph 文档
// （data.nodes / nodes，节点 type=INTENT，自动归一化转换）。
function runImportGraphFile(opts) {
  const name = String(opts.name || '').trim().slice(0, 60) || '本地导入图谱';
  const graph = opts.graph;
  if (!graph || typeof graph !== 'object') throw taskContext.fail('缺少图谱 JSON 内容');
  const nodes = (Array.isArray(graph.intent_nodes) ? graph.intent_nodes : []).map(n => (
    { identity: n.identity, semantic_definition: n.semantic_definition || {}, retrieval_profile: n.retrieval_profile || {}, decision_policy: n.decision_policy || {} }
  )).filter(n => n.identity && n.identity.intent_id);
  let converted = 0;
  if (!nodes.length) {
    // org-graph 文档可能是 API 原始响应包装（{success,data:{nodes}}）或已解包（{nodes}）
    const doc = graph.data && typeof graph.data === 'object' ? graph.data : graph;
    const orgNodes = Array.isArray(doc.nodes) ? doc.nodes.filter(n => n && n.type === 'INTENT' && n.id) : [];
    for (const n of orgNodes) { const r = orgGraphNodeToRsi(n); if (r.identity.intent_id) { nodes.push(r); converted++; } }
  }
  if (!nodes.length) throw taskContext.fail('图谱无有效意图节点：需 intent_nodes[].identity.intent_id（RSI 快照）或 nodes[]（AI 建图文档，节点 type=INTENT），无法作为 RSI 底图');
  // 快照 id：local- 前缀 + 时间戳基36（名称含中文转不了合法 id，直接用时间保证唯一可读性靠 label）
  const id = 'local-' + Date.now().toString(36);
  if (!fs.existsSync(SNAPSHOTS_DIR)) fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  writeJson(path.join(SNAPSHOTS_DIR, `${id}.json`), {
    meta: { ...(graph.meta || {}), version_id: id, rsi_imported_at: new Date().toISOString(), rsi_source_name: name, rsi_note: `RSI 实验台只读快照（本地文件导入：${name}，${converted ? `org-graph 归一化 ${converted} 节点` : '字段裁剪'}），源=前端上传` },
    intent_nodes: nodes,
  });
  return { snapshot: { id, intents: nodes.length, label: name }, next: `新建任务时底图选「已导入快照：${name}」，或 switch-base {base:"snapshot:${id}"}` };
}

// 评测集导入（10-16 打通图谱评测）：把 intent-testset 的 AI 生成数据集（或外部上传的同构 JSON）
// 转换为 RSI 题库格式。字段映射：caseId→case_id、expected.intentId→expected_intents、
// category(SINGLE_INTENT)→intent_shape(single_intent)、query 原样。
function convertTestsetCases(rawCases) {
  const st = loadState();
  return normalizeCases(rawCases, loadGraph(st.currentVersion, st)).cases;
}

function datasetSource(opts) {
  let rawCases, sourceName;
  if (opts.datasetId) {
    if (!/^[a-zA-Z0-9_-]{1,120}$/.test(String(opts.datasetId))) throw taskContext.fail('无效 datasetId');
    // 从 data/testsets 加载已有 AI 生成数据集
    const p = path.join(ROOT, 'data', 'testsets', `dataset-${opts.datasetId}.json`);
    if (!fs.existsSync(p)) throw taskContext.fail(`评测数据集不存在: ${opts.datasetId}`);
    const d = readJson(p);
    rawCases = d.cases || [];
    sourceName = d.datasetId || opts.datasetId;
  } else if (opts.cases) {
    rawCases = opts.cases;
    sourceName = String(opts.casesName || opts.name || '').trim().slice(0, 60) || '外部导入评测集';
  } else {
    throw taskContext.fail('须提供 datasetId（加载已有数据集）或 cases+casesName（外部导入）');
  }
  return { rawCases, sourceName };
}
function runImportEvalDataset(opts) {
  const { rawCases, sourceName } = datasetSource(opts);
  const prev = loadState();
  const { cases, report: importReport } = normalizeCases(rawCases, loadGraph('v1', prev), opts);
  // 落为本任务的题库文件（cases.imported.json）， gen-cases 重开只影响本任务
  const taskId = prev.taskId;
  if (!taskId) throw new Error('无当前任务：评测集导入到任务，请先创建/切换任务');
  const target = path.join(TASKS_DIR, taskId, 'cases.imported.json');
  writeJson(target, { version: 2, imported_from: sourceName, imported_at: new Date().toISOString(), cases });
  // 题库变化 → 重开实验（保留底图与切分配置）
  const st = preserveTask(prev, makeFreshState(prev.baseGraph || { kind: 'seed', id: 'seed', label: '种子图谱' }, 'imported', cases, prev.splitConfig));
  st.log.push({ at: new Date().toISOString(), event: 'import_eval', detail: `导入评测集「${sourceName}」${cases.length} 题（源 ${rawCases.length} 条），实验已重开` });
  saveState(st);
  return { imported: cases.length, sourceName, total: cases.length, importReport, state: publicState(st) };
}

function runSwitchBase(opts) {
  const base = String(opts.base || 'seed');
  // 切分配置继承（10-16 遗留修复）：换底图轨道不改变本任务的切分口径
  const prev = loadState();
  const splitOpts = prev.splitConfig;
  let st;
  if (base === 'seed') {
    const cases = readCases(prev);
    normalizeCases(cases, readJson(GRAPH_V1_PATH));
    st = makeFreshState({ kind: 'seed', id: 'seed', label: '智慧园区种子图谱' }, prev.casesFile, cases, splitOpts);
  } else if (base.startsWith('snapshot:')) {
    const id = base.slice('snapshot:'.length);
    const p = path.join(SNAPSHOTS_DIR, `${id}.json`);
    if (!fs.existsSync(p)) throw new Error(`快照不存在: ${id}`);
    const cases = readCases(prev);
    if (!cases.length) throw new Error('该快照无配套题库，请先 gen-cases');
    const g = readJson(p);
    normalizeCases(cases, g);
    st = makeFreshState({ kind: 'snapshot', id, label: g.meta?.version_id || id }, prev.casesFile, cases, splitOpts);
  } else {
    throw new Error('base 须为 seed 或 snapshot:<id>');
  }
  preserveTask(prev, st, true);
  saveState(st);
  return { state: publicState(st) };
}

function pickIntentIdsForGen(graph, limit) {
  // 默认挑声明最全的意图（utterance_view+hints 丰富度），ASK/QUERY 优先且保证 confusable 对尽量成对出现
  const scored = (graph.intent_nodes || []).map(n => ({
    id: n.identity.intent_id,
    score: (n.retrieval_profile?.utterance_view || []).length + 2 * (n.semantic_definition?.disambiguation_hints || []).length
      + (({ ASK: 3, QUERY: 2 })[n.identity.intent_type] || 0),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(x => x.id);
}

function buildGenCasesPrompt(graph, intentIds, perShape, blind) {
  const lines = [];
  lines.push('你是意图评测题库出题专家。请基于以下意图声明出评测用例（query + 期望意图），用于黑盒评测一个"声明驱动"的意图召回引擎。');
  lines.push('');
  const shapeReqs = [];
  if (perShape.single > 0) shapeReqs.push(`${perShape.single} 条单意图`);
  if (perShape.multi > 0) shapeReqs.push(`${perShape.multi} 条多意图`);
  if (perShape.ambiguous > 0) shapeReqs.push(`${perShape.ambiguous} 条歧义`);
  lines.push(`要求产出 ${shapeReqs.join('、')}用例（共 ${perShape.single + perShape.multi + perShape.ambiguous} 条）：`);
  lines.push('- 单意图：口语化问法，难度 easy/medium/hard 均匀；hard 题必须是意图声明的 scope_in 内但措辞与 utterance_view 样例明显不同的真实变体（同义改写/口语化/带上下文省略），禁止照抄样例原文');
  lines.push('- 多意图：一句话包含两个意图（用「再/然后/顺便/还要/和」等连接），expected_intents 按子句顺序列出两个意图');
  lines.push('- 歧义：query 落在两个语义边界接近的意图之间（互为 confusable 的对优先；若无 confusable 声明，选同场景下最易混淆的一对），正确行为是触发澄清；expected_intents 恰好为这两个意图');
  lines.push('');
  lines.push('输出：仅一个 JSON 数组，每条 {"query":"...","intent_shape":"single_intent|multi_intent|ambiguous_intent","expected_intents":["intent_id",...],"difficulty":"easy|medium|hard","note":"出题动机(≤20字)"}');
  lines.push('硬约束：expected_intents 只能引用下列意图 id；query 10-30 字；不得编造不存在的意图；歧义题只能选提供的 confusable 配对。');
  lines.push('');
  lines.push('## 可用意图声明');
  for (const id of intentIds) {
    const n = nodeById(graph, id);
    if (!n) continue;
    const rp = n.retrieval_profile || {};
    const sd = n.semantic_definition || {};
    lines.push(`\n### ${id}（${n.identity.intent_name}，${n.identity.intent_type}）`);
    lines.push(JSON.stringify(blind ? {
      // 盲出题：不给 utterance_samples/hints/confusable——题库不看到会直接构成答案的表达样例，
      // 用于对照测"看着声明出题"的自证回声（出题源污染程度）
      description: sd.description,
      scope_in: (sd.scope_in || []).slice(0, 6),
      scope_out: (sd.scope_out || []).slice(0, 6),
    } : {
      description: sd.description,
      utterance_samples: (rp.utterance_view || []).slice(0, 8),
      scope_in: (sd.scope_in || []).slice(0, 6),
      scope_out: (sd.scope_out || []).slice(0, 6),
      confusable: (sd.confusable_intents || []).slice(0, 5),
      hints: (sd.disambiguation_hints || []).slice(0, 4),
    }, null, 0));
  }
  return lines.join('\n');
}

function validateGenCase(raw, validIds, existingQueries, confusablePairs) {
  if (!raw || typeof raw !== 'object') return '非对象';
  const q = String(raw.query || '').trim();
  if (q.length < 6 || q.length > 40) return 'query 长度须 6-40';
  const shape = raw.intent_shape;
  if (!['single_intent', 'multi_intent', 'ambiguous_intent'].includes(shape)) return `非法 shape ${shape}`;
  const exp = Array.isArray(raw.expected_intents) ? raw.expected_intents : [];
  if (!exp.length || exp.some(e => !validIds.has(e))) return 'expected 引用了不可用意图';
  if (shape === 'single_intent' && exp.length !== 1) return '单意图 expected 须 1 个';
  if (shape === 'multi_intent' && exp.length !== 2) return '多意图 expected 须 2 个';
  if (shape === 'ambiguous_intent' && exp.length !== 2) return '歧义 expected 须 2 个';
  // LLM 出题实测会把同一意图填进 expected 两次（如歧义题 [A, A]），退化为单意图题且永不 strict
  if (new Set(exp).size !== exp.length) return 'expected 意图不得重复';
  // 歧义对不强制 confusable 声明：真图谱 confusable/clarify 声明稀疏，歧义坏例→A5 补声明本身就是进化闭环的一部分
  // （引擎低置信路径 ①仍可触发澄清，A5 声明加入后命中率提升可测量）
  void confusablePairs;
  const nq = normalize(q);
  for (const eq of existingQueries) {
    if (dice(bigrams(q), bigrams(eq)) >= 0.7) return `与既有题高度相似: ${eq}`;
  }
  if (existingQueries.some(x => normalize(x) === nq)) return '重复 query';
  return null;
}

async function runGenCases(opts) {
  const st = loadState();
  // 目标轨道：默认当前轨道；opts.base 可指定 seed / snapshot:<id>（出题即进入该轨道）
  let targetBase = st.baseGraph || { kind: 'seed', id: 'seed', label: '智慧园区种子图谱' };
  const currentBaseKey = targetBase.kind === 'snapshot' ? `snapshot:${targetBase.id}` : 'seed';
  if (opts.base && opts.base !== currentBaseKey) {
    if (opts.base === 'seed') {
      targetBase = { kind: 'seed', id: 'seed', label: '智慧园区种子图谱' };
    } else if (opts.base.startsWith('snapshot:')) {
      const id = opts.base.slice('snapshot:'.length);
      const p = path.join(SNAPSHOTS_DIR, `${id}.json`);
      if (!fs.existsSync(p)) throw new Error(`快照不存在: ${id}（请先 import-snapshot）`);
      const g = readJson(p);
      targetBase = { kind: 'snapshot', id, label: g.meta?.version_id || id };
    } else {
      throw new Error('base 须为 seed 或 snapshot:<id>');
    }
  }
  const targetCasesFile = targetBase.kind === 'snapshot' ? 'imported' : 'main';
  const graph = loadGraph('v1', { baseGraph: targetBase });
  const allIds = new Set((graph.intent_nodes || []).map(n => n.identity.intent_id));
  if (allIds.size < 3) throw new Error('底图意图过少，无法出题');

  const limit = Math.min(20, Math.max(4, Number(opts.intentCount) || 14));
  let intentIds = Array.isArray(opts.intentIds) ? opts.intentIds.filter(id => allIds.has(id)) : [];
  if (intentIds.length < 3) intentIds = pickIntentIdsForGen(graph, limit);
  if (intentIds.length < 3) throw new Error('可用意图不足 3 个');

  // 歧义对集合：互为 confusable 且都在本次出题意图清单内
  const confusablePairs = new Set();
  for (const id of intentIds) {
    const n = nodeById(graph, id);
    for (const c of (n.semantic_definition?.confusable_intents || [])) {
      if (intentIds.includes(c)) confusablePairs.add([id, c].sort().join('|'));
    }
  }

  const existing = targetBase.id === st.baseGraph?.id ? readCases(st) : [];
  const targetAdd = Math.min(120, Math.max(10, Number(opts.count) || 90));
  // 分批出题：单次 LLM 长 JSON 输出易截断/出语法瑕疵，每批 ≤30 条
  const batches = [];
  let remain = targetAdd;
  while (remain > 0) { batches.push(Math.min(30, remain)); remain -= 30; }

  const added = [];
  const rejected = [];
  const queries = existing.map(c => c.query);
  const rawPreviews = [];
  let rawTotal = 0;
  for (let bi = 0; bi < batches.length; bi++) {
    const perShape = opts.onlyShape === 'ambiguous_intent' ? { single: 0, multi: 0, ambiguous: batches[bi] }
      : opts.onlyShape === 'multi_intent' ? { single: 0, multi: batches[bi], ambiguous: 0 }
      : opts.onlyShape === 'single_intent' ? { single: batches[bi], multi: 0, ambiguous: 0 }
      : {
      single: Math.round(batches[bi] * 0.5),
      multi: Math.round(batches[bi] * 0.25),
      ambiguous: batches[bi] - Math.round(batches[bi] * 0.5) - Math.round(batches[bi] * 0.25),
    };
    const prompt = buildGenCasesPrompt(graph, intentIds, perShape, !!opts.blind);
    const text = await callLLM([
      { role: 'system', content: '你是意图评测出题专家，只输出 JSON 数组，不输出其他文本。' },
      { role: 'user', content: prompt },
    ], 240000, 6000);
    st.stats.llmCalls++;
    rawPreviews.push({ len: (text || '').length, head: String(text || '').slice(0, 150) });
    if (!text || !text.trim()) {
      if (!added.length) { saveState(st); throw new Error('LLM 返回空内容（max_tokens 截断或上游异常）'); }
      break;
    }

    let arr;
    try { arr = extractJsonArray(text); } catch (e) {
      if (!added.length) { saveState(st); throw new Error('LLM 出题输出无法解析: ' + e.message); }
      break; // 后续批次失败但已有收获，用已有部分继续
    }
    rawTotal += Array.isArray(arr) ? arr.length : 0;
    for (const raw of (Array.isArray(arr) ? arr : [])) {
      const err = validateGenCase(raw, allIds, queries, confusablePairs);
      if (err) { rejected.push({ query: raw && raw.query, reason: err }); continue; }
      queries.push(String(raw.query).trim());
      added.push({
        case_id: `rsi_g${String(existing.length + added.length + 1).padStart(3, '0')}`,
        query: String(raw.query).trim(),
        difficulty: ['easy', 'medium', 'hard'].includes(raw.difficulty) ? raw.difficulty : 'medium',
        intent_shape: raw.intent_shape,
        expected_intents: raw.expected_intents,
        note: String(raw.note || '').slice(0, 30) || 'LLM 生成',
      });
    }
  }

  const merged = existing.concat(added);
  // 任务化：写当前任务的题库副本（无任务时回落全局路径）
  writeJson(taskCasesPathOf(st.taskId, targetCasesFile), { version: 2, generated_at: new Date().toISOString(), base: targetBase.id, blind: !!opts.blind, cases: merged });
  // 扩题即重切 held-out：旧切分封存留档，盲测题锚点可追溯（跨轮连续性）
  if (st.split && Array.isArray(st.split.heldout) && st.split.heldout.length) {
    try {
      writeJson(path.join(taskArtifactDir(st, 'heldout-archive', HELDOUT_ARCHIVE_DIR), `${(st.baseGraph && st.baseGraph.id) || 'seed'}-${Date.now()}.json`), {
        base: st.baseGraph || null,
        casesFile: st.casesFile || 'main',
        casesSha256: (st.integrity && st.integrity.casesSha256) || casesSha256Of(st.casesFile || 'main', st),
        split: st.split,
        archivedAt: new Date().toISOString(),
      });
    } catch (_) { /* 留档失败不阻塞出题 */ }
  }
  // 题库变化 → 分层切分失效，重开实验并进入目标轨道
  // 切分配置继承（10-16 遗留修复）：gen-cases 重开沿用任务创建时定下的切分配置
  //（train 比例 / seed / test 比例），空题库任务 AI 出题后不再回退默认口径
  const fresh = preserveTask(st, makeFreshState(targetBase, targetCasesFile, merged, st.splitConfig));
  // 追加训练资料不能把已封存终测题重新洗回训练集。
  if (st.split?.test?.length && st.baseGraph?.id === targetBase.id) {
    const ids = new Set(merged.map(c => c.case_id));
    const frozen = st.split.test.filter(id => ids.has(id));
    const remaining = merged.filter(c => !frozen.includes(c.case_id));
    const ratio = st.splitConfig?.trainRatio || TRAIN_RATIO;
    const testRatio = st.splitConfig?.testRatio || 0;
    const retest = stratifiedSplit(remaining, st.splitConfig?.seed ?? st.split.seed, Math.min(.99, ratio / Math.max(.01, 1 - testRatio)), 0);
    fresh.split = { ...retest, test: frozen };
  }
  fresh.stats.llmCalls = st.stats.llmCalls;
  fresh.log.push({ at: new Date().toISOString(), event: 'gen_cases', detail: `${opts.blind ? '盲出题（不给说法样例）' : 'LLM 出题'} ${rawTotal}，校验通过 ${added.length}（拒 ${rejected.length}），题库共 ${merged.length} 条，实验已重开` });
  fresh.taskId = st.taskId || currentTaskId() || 'default';
  saveState(fresh);
  return { added: added.length, rejectedCount: rejected.length, rejectedSample: rejected.slice(0, 5), llmBatches: batches.length, rawPreviews, total: merged.length, state: publicState(fresh) };
}

function runListBases() {
  const st = loadState();
  // 打通 AI Harbor 图谱资产（10-16）：把图谱编辑器维护的 manifest 版本清单一并返回，
  // 前端可从全部线上版本中选底图（import-snapshot 支持按 versionId 导入任意版本）。
  let manifestVersions = [];
  if (fs.existsSync(MANIFEST_PATH)) {
    try {
      manifestVersions = manifestCatalog(readJson(MANIFEST_PATH), id => fs.existsSync(path.join(SNAPSHOTS_DIR, id + '.json')));
    } catch (e) { /* manifest 损坏不阻塞 bases */ }
  }
  // 来源归属清单（10-17 更名澄清）：这是图谱评测页的「图谱注册表」（bank:/v2: 是图谱 id），
  // 不是引擎清单——此前前端把它标成"来源引擎归属"，用户在引擎下拉里看到一堆图谱名。
  // 字段与文案统一为 sourceGraphs：label=图谱名，engineVersion=真实执行器，语义对齐。
  // engines 字段保留一个版本周期做兼容，前端切换后可删。
  const sourceGraphs = manifestVersions.map(v => ({ id: 'v2:' + v.versionId, engine: 'v2', label: v.name, sublabel: null, engineVersion: 'Intent Evaluator v2', intentCount: v.intentCount }));
  // 评测集清单（10-16 打通图谱评测）：intent-testset 的 AI 生成数据集（camelCase），
  // 前端选择后由 /import-eval-dataset 转换为 RSI 题库格式
  let evalDatasets = [];
  try {
    const tsDir = path.join(ROOT, 'data', 'testsets');
    if (fs.existsSync(tsDir)) {
      evalDatasets = fs.readdirSync(tsDir).filter(f => /^dataset-.*\.json$/.test(f)).map(f => {
        try {
          const d = readJson(path.join(tsDir, f));
          const cases = Array.isArray(d.cases) ? d.cases : [];
          const d2 = d;
          const cases0 = Array.isArray(d2.cases) ? d2.cases : [];
          // 10-17 补齐：题型分布 shapeCounts + graphVersionId（供前端把图谱名对齐到底图口径）
          const shapeCounts = {};
          for (const c of cases0) {
            const shape = c.intent_shape || c.category || 'unknown';
            shapeCounts[shape] = (shapeCounts[shape] || 0) + 1;
          }
          return {
            datasetId: d2.datasetId || f.replace(/^dataset-|\.json$/g, ''),
            name: d2.datasetId || f.replace(/^dataset-|\.json$/g, ''),
            graph: (d2.graph && (d2.graph.versionName || d2.graph.versionId)) || null,
            graphVersionId: (d2.graph && d2.graph.versionId) || null,
            caseCount: cases0.length,
            shapeCounts,
            createdAt: d2.createdAt || null,
          };
        } catch (e) { return null; }
      }).filter(d => d && d.caseCount > 0);
    }
  } catch (e) { /* 清单失败不阻塞 */ }
  return {
    current: st.baseGraph,
    casesFile: st.casesFile,
    casesCount: readCases(st).length,
    snapshots: listSnapshots(),
    manifestVersions,
    manifestActive: fs.existsSync(MANIFEST_PATH) ? readJson(MANIFEST_PATH).active_default : null,
    sourceGraphs,
    engines: sourceGraphs,
    evalDatasets,
  };
}

function publicState(st) {
  // 对外视图：隐去逐条评测明细，只保留聚合
  // 历史数据没有测量档位。只在读取时投影为旧单票证据，不回写体积很大的任务状态。
  const measurementOf = value => value?.measurement || measurementPolicyLib.legacyMeta();
  const b = st.baseline ? { version: st.baseline.version, scores: st.baseline.scores, attributions: st.baseline.attributions, at: st.baseline.at, measurement: measurementOf(st.baseline), recallMetrics: (st.baseline.results && st.baseline.results.length ? computeRecallMetrics(st.baseline.results) : (st.baseline.recallMetrics || null)), adjudicationMetrics: st.baseline.adjudicationMetrics || null } : null;
  const cases = readCases(st);
  const byId = new Map(cases.map(c => [c.case_id, c]));
  const g = loadGraph(st.currentVersion, st);
  // 内部意图 ID 禁上屏：历史持久化文本（changelog/motivation/LLM 理由）里可能残留
  // intent_xxx 形态 ID，出口统一翻译成意图中文名（图里查不到的兜底为中性表述）
  const deid = s => String(s || '').replace(/intent_[a-z0-9_]+/g, m => ((nodeById(g, m) || {}).identity?.intent_name) || '某个意图');
  return {
    taskId: st.taskId,
    taskName: st.taskName || st.taskId,
    taskDesc: st.taskDesc || '',
    createdAt: st.createdAt,
    engineRef: st.engineRef || null,
    revision: st.revision || 0,
    currentVersion: st.currentVersion,
    baseGraph: st.baseGraph || { kind: 'seed', id: 'seed', label: '智慧园区种子图谱' },
    casesFile: st.casesFile || 'main',
    split: { seed: st.split.seed, trainCount: st.split.train.length, heldoutCount: st.split.heldout.length, testCount: st.split.test?.length || 0 },
    splitConfig: st.splitConfig,
    goal: (() => {
      const g = goalLib.safeGoal(st.goal);
      if (!st.baseline?.results?.length) return { ...g, current: null, met: false, summary: `目标 ${g.target}%｜尚无基线` };
      try { return goalLib.goalProgress(g, st.baseline.scores, st.baseline.results, cases); }
      catch (e) { return { ...g, current: null, met: false, summary: `目标 ${g.target}%｜归因失败：${e.message}` }; }
    })(),
    regressionStatus: st.regressionStatus || null,
    baseline: b ? {
      ...b,
      // 弱点卡下钻：每族样例附期望意图中文名（前端不做 id→名解析）
      attributions: (b.attributions || []).map(f => ({
        ...f,
        samples: (f.samples || []).map(s => ({ ...s, expectedNames: (s.expected || []).map(id => (nodeById(g, id) || {}).identity?.intent_name || id) })),
      })),
    } : null,
    archive: st.archive.map(a => ({
      id: a.id,
      proposal: { ...a.proposal, motivation: deid(a.proposal.motivation), confusableName: a.proposal.confusable ? deid(a.proposal.confusable) : undefined },
      opLabel: OPS[a.proposal.type]?.label || a.opLabel, status: a.status,
      targetName: (nodeById(g, a.proposal.target) || {}).identity?.intent_name || a.proposal.target,
      evidenceQueries: (a.proposal.evidence_cases || []).map(cid => byId.get(cid)?.query || cid),
      trainScores: a.trainScores, heldoutScores: a.heldoutScores, gate: a.gate ? { ...a.gate, reason: deid(a.gate.reason) } : null, paretoOptimal: a.paretoOptimal, draftChanges: a.draftChanges, fixedCases: a.fixedCases || [], adoptedAs: a.adoptedAs, createdAt: a.createdAt,
      measurement: a.measurement || (a.fullScores ? measurementPolicyLib.legacyMeta() : null), confirmation: a.confirmation || null, confirmationGate: a.confirmationGate || null,
    })),
    regression: Object.entries(st.regression || {}).map(([caseId, meta]) => ({ caseId, fixedIn: meta.fixedIn, by: meta.by, query: byId.get(caseId)?.query || caseId })),
    integrity: (() => {
      const recorded = (st.integrity && st.integrity.casesSha256) || null;
      const current = casesSha256Of(st.casesFile || 'main', st);
      let blind = false;
      try {
        const p = taskCasesPathOf(st.taskId, st.casesFile);
        blind = !!(fs.existsSync(p) && readJson(p).blind);
      } catch (_) { /* 题库文件异常时漂移检测已覆盖，这里不阻塞 */ }
      return {
        recordedCasesSha256: recorded,
        currentCasesSha256: current,
        drift: !!(recorded && current && recorded !== current),
        blind,
        heldoutArchives: (() => { const p = taskArtifactDir(st, 'heldout-archive', HELDOUT_ARCHIVE_DIR); return fs.existsSync(p) ? fs.readdirSync(p).filter(f => f.endsWith('.json')).length : 0; })(),
      };
    })(),
    calibration: calibrationPublicState(st),
    stats: st.stats || defaultStats(),
    scoreHistory: (() => {
      const formal = (st.scoreHistory || []).filter(h => /^v\d+$/.test(h.version));
      const byVer = new Map();
      for (const h of formal) byVer.set(h.version, h);
      return Array.from(byVer.values()).sort((a, b) => parseInt(a.version.slice(1)) - parseInt(b.version.slice(1)))
        .map(h => ({ version: h.version, at: h.at, scores: h.scores, engineRev: h.engineRev || null, context: h.context || null, measurement: measurementOf(h) }));
    })(),
    versions: st.versions.map(v => ({ ...v, changelog: deid(v.changelog) })),
    log: st.log.slice(-40).reverse().map(l => ({ ...l, detail: deid(l.detail) })),
    ops: Object.fromEntries(Object.entries(OPS).map(([k, v]) => [k, v.label])),
    engineParams: st.engineParams || { ...DEFAULT_ENGINE_PARAMS },
    promptVariants: st.promptVariants || {},
  };
}

function getState() {
  return publicState(loadState());
}

// ───────────────────────── Bundle 组合评估 ─────────────────────────
// 将多个已通过单提案评估的 passed 提案联合打包，叠加图谱+引擎参数变更后统一评测
function runBundleEvaluate(proposalIds) {
  const st = loadState();
  if (!proposalIds || !Array.isArray(proposalIds) || proposalIds.length < 2) {
    throw new Error('bundle 评估至少需要 2 个提案');
  }
  const baseline = st.baseline && st.baseline.version === st.currentVersion ? st.baseline : null;
  if (!baseline) throw new Error('当前版本无基线，请先跑基线');

  const baseEp = baseline.engineParams || st.engineParams || DEFAULT_ENGINE_PARAMS;
  let graph = loadGraph(st.currentVersion, st);
  let ep = { ...baseEp };
  const allChanges = [];
  const entries = [];

  for (const pid of proposalIds) {
    const entry = st.archive.find(a => a.id === pid);
    if (!entry) throw new Error(`提案 ${pid} 不存在`);
    if (entry.status === 'adopted' || entry.status === 'rejected') throw new Error(`提案 ${pid} 已终态（${entry.status}）`);
    const result = applyProposal(graph, entry.proposal, { engineParams: ep });
    graph = result.graph;
    if (result.engineParams) ep = result.engineParams;
    allChanges.push(...(result.changes || []));
    entries.push({ id: pid, type: entry.proposal.type, changes: result.changes });
  }

  const cases = readCases(st);
  const byId = new Map(cases.map(c => [c.case_id, c]));
  const evalOpts = { engineParams: ep };

  // train 初筛
  const trainResults = evaluateSet(graph, st.split.train, byId, evalOpts);
  const trainScores = aggregate(trainResults);
  const bTrain = baseline.scores.train;

  const trainRelaxedDrop = bTrain.relaxed_pct - trainScores.relaxed_pct;
  if (trainRelaxedDrop > 2) {
    st.log.push({ at: new Date().toISOString(), event: 'bundle_gated', detail: `train 退步 ${trainRelaxedDrop.toFixed(1)}%` });
    saveState(st);
    return { proposalIds, changes: allChanges, trainScores, heldoutScores: null, gate: { stage: 'train', reason: `组合后练习题退步 ${trainRelaxedDrop.toFixed(1)}%` }, engineParams: ep };
  }

  // heldout 终判
  const heldResults = evaluateSet(graph, st.split.heldout, byId, evalOpts);
  const heldScores = aggregate(heldResults);
  const bHeld = baseline.scores.heldout;

  const heldImproved = heldScores.relaxed_pct > bHeld.relaxed_pct || heldScores.strict_pct > bHeld.strict_pct;
  const heldRegressed = Object.keys(bHeld).some(k => {
    if (k === 'total') return false;
    return (bHeld[k]?.relaxed_pct ?? 0) - (heldScores[k]?.relaxed_pct ?? 0) > 3;
  });
  const bHeldResultsById = new Map((baseline.results || []).filter(r => st.split.heldout.includes(r.case_id)).map(r => [r.case_id, r]));
  const heldFixedCases = heldResults.filter(r => r.strict && bHeldResultsById.get(r.case_id) && !bHeldResultsById.get(r.case_id).strict).map(r => r.case_id);
  const heldZeroBreak = heldScores.relaxed_pct >= bHeld.relaxed_pct;
  const heldNetFix = heldFixedCases.length >= 1;

  const gate = heldImproved && !heldRegressed
    ? { stage: 'passed', reason: `组合后盲测提升（完全正确 ${bHeld.strict_pct}%→${heldScores.strict_pct}%，基本正确 ${bHeld.relaxed_pct}%→${heldScores.relaxed_pct}%）` }
    : heldZeroBreak && heldNetFix && !heldRegressed
    ? { stage: 'passed', reason: '组合后盲测题零破坏且净修复 ' + heldFixedCases.length + ' 题——基线已高，每修一题都是实质进展' }
    : { stage: 'heldout', reason: heldRegressed ? '组合后盲测某类意图退步超过 3 个百分点' : '组合后盲测成绩没有提升且无净修复' };

  st.log.push({ at: new Date().toISOString(), event: 'bundle_evaluate', detail: `${proposalIds.length} 提案组合 → ${gate.stage}` });
  saveState(st);
  return { proposalIds, changes: allChanges, trainScores, heldoutScores: heldScores, gate, engineParams: ep };
}

// ───────────────────────── HTTP 分发 ─────────────────────────

function readJsonBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > (limit || 512 * 1024)) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(new Error('JSON body 解析失败')); }
    });
    req.on('error', reject);
  });
}
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

async function handleIntentRsiRequest(req, res) {
  if (!req.pathname.startsWith('/api/intent-rsi')) return false;
  try {
    const ctx = taskContext.fromRequest(req, readActiveTaskId);
    return await taskContext.run(ctx, async () => {
      if (ctx.explicit) {
        const file = statePathOf(ctx.taskId);
        if (!fs.existsSync(file)) throw taskContext.fail('任务不存在: ' + ctx.taskId, 404);
        if (ctx.expectedRevision !== undefined) {
          const revision = Number(ctx.expectedRevision);
          if (!Number.isSafeInteger(revision) || revision < 0) throw taskContext.fail('无效 X-RSI-Revision');
          if (revision !== (readJson(file).revision || 0)) throw taskContext.fail('任务 revision 已变化，请刷新后重试', 409);
        }
      }
      return handleTaskRequest(req, res);
    });
  } catch (e) {
    sendJson(res, e.statusCode || 500, { ok: false, error: e.message, ...(e.importReport ? { importReport: e.importReport } : {}) });
    return true;
  }
}
async function handleTaskRequest(req, res) {
  const p = req.pathname;
  if (!p.startsWith('/api/intent-rsi')) return false;
  let releaseLegacy;
  try {
    if (p === '/api/intent-rsi/case-review' && req.method === 'GET') {
      const st=loadState(),query=new URL(req.url,'http://localhost').searchParams;
      const id=st.taskId||'legacy';
      if(!/^[a-zA-Z0-9_-]{1,128}$/.test(id))throw taskContext.fail('任务编号无效');
      const runs=[...(st.evolveRuns||[]),...(st.activeEvolution?[st.activeEvolution]:[])];
      const available=[...new Map(runs.filter(r=>/^[a-zA-Z0-9_-]{1,128}$/.test(r.id||'')).map(r=>[r.id,r])).values()]
        .filter(r=>fs.existsSync(path.join(RSI_DIR,'checkpoints',id,r.id+'.json')));
      const sources=[{value:'current',label:`当前实验版本 ${st.currentVersion}`},...available.slice().reverse().map(r=>({value:`run:${r.id}`,label:`${r.at?.slice(0,16).replace('T',' ')} · ${r.baseVersion||'历史运行'} 保留结果对比`}))];
      const requested=query.get('source')||'current';let source;
      if(requested!=='current'){
        const run=available.find(r=>`run:${r.id}`===requested);
        if(!run)throw taskContext.fail('没有可用的历史评测证据',404);
        const saved=readJson(path.join(RSI_DIR,'checkpoints',id,run.id+'.json'));
        if(saved.run?.id!==run.id||(saved.run.taskId||'legacy')!==id)throw taskContext.fail('历史评测所属任务不匹配',409);
        const readings=new Map(saved.readings||[]);
        source={id:requested,label:sources.find(s=>s.value===requested).label,before:readings.get('b0'),after:readings.get(saved.run.champion||'b0')};
        if(!source.after)throw taskContext.fail('该运行未保存完整评测结果',404);
      }
      sendJson(res,200,{ok:true,...buildCaseReview({state:st,cases:readCases(st),graph:loadGraph(st.currentVersion,st),source,caseId:query.get('caseId')||undefined,baselineCurrent:productionRuntime.isFresh(st)}),sources});
      return true;
    }
    if (p === '/api/intent-rsi/split-preview' && req.method === 'POST') {
      const body = await readJsonBody(req);
      let previewCases;
      if (body.datasetId || body.cases !== undefined || ['dataset', 'file'].includes(body.casesSource)) {
        const source = datasetSource(body);
        previewCases = source.rawCases.map((c, index) => ({ ...c, case_id: String(c.case_id || c.caseId || index), intent_shape: c.intent_shape || c.category }));
      } else if (body.casesSource === 'none') previewCases = [];
      else previewCases = body.base && body.base !== 'seed' ? [] : readJson(CASES_PATH).cases;
      const preview = splitPreview(previewCases, body.splitSeed ?? SPLIT_SEED, Number(body.trainRatio) || TRAIN_RATIO, Number(body.testRatio) || 0);
      sendJson(res, 200, { ok: true, preview, total: preview.total, split: { trainCount: preview.train, heldoutCount: preview.heldout, testCount: preview.test }, warnings: preview.warnings });
      return true;
    }
    if (p.startsWith('/api/intent-rsi/agent/') && req.method === 'GET') {
      // rsi-agent 工具回调（weaknesses/badcases/search/intent/probe）：仅在对应任务运行中的
      // Agent 代次开放；数据只来自训练侧与父代草案，永不触达验证/终测
      const tool = p.slice('/api/intent-rsi/agent/'.length).split('?')[0];
      const taskId = taskContext.current()?.taskId;
      const query = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
      const data = await productionRuntime.agentTool(taskId, tool, query);
      sendJson(res, 200, { ok: true, data });
      return true;
    }
    if (await productionRuntime.handle(req, res)) return true;
    if (req.method === 'POST') releaseLegacy = productionRuntime.acquireLegacy();
    if (p === '/api/intent-rsi/state' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, state: getState() });
      return true;
    }
    if (p === '/api/intent-rsi/baseline' && req.method === 'POST') {
      sendJson(res, 200, { ok: true, ...runBaseline() });
      return true;
    }
    if (p === '/api/intent-rsi/propose' && req.method === 'POST') {
      const out = await runPropose();
      sendJson(res, 200, { ok: true, ...out });
      return true;
    }
    // 手动提案（10-31）：外部已验证的图谱修复配方直接入档为 proposed 候选，
    // 之后由生产运行时的 /evaluate-proposal 三级测量链评测——提案来源可以是引擎快测、
    // 人工分析或 Agent 工具，但测量/门禁/采纳权威始终在运行时，不因来源不同绕过门禁。
    if (p === '/api/intent-rsi/manual-proposal' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const proposal = body.proposal;
      if (!proposal || typeof proposal !== 'object') { sendJson(res, 400, { ok: false, error: '缺少 proposal 对象' }); return true; }
      const st = loadState();
      const graph = loadGraph(st.currentVersion, st);
      const cases = readCases(st);
      const byId = new Map(cases.map(c => [c.case_id, c]));
      const validationError = validateProposal(proposal, graph, byId);
      if (validationError) { sendJson(res, 400, { ok: false, error: `提案不合法: ${validationError}` }); return true; }
      const { changes, graph: draft } = applyProposal(graph, proposal, { engineParams: st.engineParams || DEFAULT_ENGINE_PARAMS });
      const id = 'prop_' + crypto.randomBytes(4).toString('hex');
      // 生产评测链（/evaluate-proposal → adoption）要求的父版本指纹与冻结资产：
      // 与运行时候选完全同一格式（freeze bundle + readAsset 校验），测量权威不因来源不同而绕过。
      const candidateHash = productionRuntime.freezeAsset(draft, st.currentVersion, []);
      const ctx = productionRuntime.contextOf(st);
      const rootHash = productionRuntime.freezeAsset(graph, st.currentVersion, []);
      const entry = { id, proposal, opLabel: OPS[proposal.type]?.label || proposal.type, status: 'proposed',
        createdAt: new Date().toISOString(), trainScores: null, heldoutScores: null, gate: null, paretoOptimal: false,
        fixedCases: [], draftChanges: changes, source: 'manual_verified_recipe',
        candidateHash, candidateBaseVersion: st.currentVersion, baseAssetHash: rootHash,
        evaluationContext: ctx, engineCheck: { ok: null, engineRev: ctx.engineRev, candidateHash } };
      st.archive.unshift(entry);
      st.stats = st.stats || {}; st.stats.proposalsTotal = (st.stats.proposalsTotal || 0) + 1;
      st.log.push({ at: new Date().toISOString(), event: 'manual_proposal', detail: `${id} 手动入档（${OPS[proposal.type]?.label || proposal.type}）：${String(proposal.motivation || '').slice(0, 120)}` });
      saveState(st);
      sendJson(res, 200, { ok: true, entry });
      return true;
    }
    if (p === '/api/intent-rsi/evaluate-proposal' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const result = await runEvaluateProposal(String(body.id || ''));
      sendJson(res, 200, { ok: true, ...result });
      return true;
    }
    if (p === '/api/intent-rsi/bundle-evaluate' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const ids = Array.isArray(body.ids) ? body.ids : (body.id ? [body.id] : []);
      sendJson(res, 200, { ok: true, ...runBundleEvaluate(ids) });
      return true;
    }
    if (p === '/api/intent-rsi/engine-param-search' && req.method === 'POST') {
      sendJson(res, 200, { ok: true, ...runEngineParamSearch() });
      return true;
    }
    if (p === '/api/intent-rsi/adopt' && req.method === 'POST') {
      const body = await readJsonBody(req);
      sendJson(res, 200, { ok: true, ...runAdopt(String(body.id || '')) });
      return true;
    }
    if (p === '/api/intent-rsi/reject' && req.method === 'POST') {
      const body = await readJsonBody(req);
      sendJson(res, 200, { ok: true, ...runReject(String(body.id || '')) });
      return true;
    }
    if (p === '/api/intent-rsi/rollback' && req.method === 'POST') {
      const body = await readJsonBody(req);
      sendJson(res, 200, { ok: true, ...runRollback(body) });
      return true;
    }
    if (p === '/api/intent-rsi/calibrate' && req.method === 'POST') {
      const body = await readJsonBody(req);
      sendJson(res, 200, { ok: true, ...runCalibrate(body) });
      return true;
    }
    if (p === '/api/intent-rsi/reset' && req.method === 'POST') {
      sendJson(res, 200, { ok: true, ...runReset() });
      return true;
    }
    if (p === '/api/intent-rsi/bases' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, ...runListBases() });
      return true;
    }
    if (p === '/api/intent-rsi/import-snapshot' && req.method === 'POST') {
      const body = await readJsonBody(req);
      sendJson(res, 200, { ok: true, ...runImportSnapshot(body) });
      return true;
    }
    // 本地图谱文件导入（不经 manifest）：前端上传图谱 JSON，校验后落为 RSI 快照
    if (p === '/api/intent-rsi/import-graph-file' && req.method === 'POST') {
      const body = await readJsonBody(req);
      sendJson(res, 200, { ok: true, ...runImportGraphFile(body) });
      return true;
    }
    // 评测集导入（打通图谱评测页）：datasetId=加载 intent-testset AI 生成数据集；cases=外部导入
    if (p === '/api/intent-rsi/import-eval-dataset' && req.method === 'POST') {
      const body = await readJsonBody(req);
      sendJson(res, 200, { ok: true, ...runImportEvalDataset(body) });
      return true;
    }
    if (p === '/api/intent-rsi/switch-base' && req.method === 'POST') {
      const body = await readJsonBody(req);
      sendJson(res, 200, { ok: true, ...runSwitchBase(body) });
      return true;
    }
    if (p === '/api/intent-rsi/gen-cases' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const out = await runGenCases(body);
      sendJson(res, 200, { ok: true, ...out });
      return true;
    }
    // 版本谱系资产：从版本链 + 采纳提案构建谱系边，供前端 DAG 渲染
    // 前端 mvt 组件期望每个 asset 含: short, parents, adoptedBy, mutations, scores, baseVersion
    if (p === '/api/intent-rsi/asset-lineage' && req.method === 'GET') {
      const st = loadState();
      const scoreByVer = new Map();
      for (const h of (st.scoreHistory || [])) {
        scoreByVer.set(h.version, h.scores);
      }
      const assets = [];
      const seen = new Set();
      for (let i = 0; i < st.versions.length; i++) {
        const v = st.versions[i];
        const short = v.version;
        seen.add(short);
        const parents = [];
        if (i > 0) parents.push(st.versions[i - 1].version);
        if (v.rollbackFrom) parents.push(v.rollbackFrom);
        const sc = scoreByVer.get(short);
        assets.push({
          short,
          parents,
          adoptedBy: [],
          mutations: [],
          scores: sc ? { all: sc.all?.strict_pct ?? null, heldout: sc.heldout?.strict_pct ?? null } : null,
          baseVersion: null,
        });
      }
      for (const a of st.archive) {
        const baseVersion = a.candidateBaseVersion || (a.baselineAtEval && a.baselineAtEval.version) || st.versions[0].version;
        const short = (a.candidateHash || a.id).slice(0, 8);
        if (seen.has(short)) continue;
        seen.add(short);
        assets.push({
          short,
          parents: [baseVersion],
          adoptedBy: a.adoptedAs ? [a.adoptedAs] : [],
          mutations: a.proposal && a.proposal.type ? [OPS[a.proposal.type]?.label || a.proposal.type] : [],
          scores: (a.trainScores || a.heldoutScores) ? { all: a.trainScores?.strict_pct ?? null, heldout: a.heldoutScores?.strict_pct ?? null } : null,
          baseVersion,
        });
      }
      sendJson(res, 200, { ok: true, assets });
      return true;
    }
    // 优化能力清单：声明可用的优化路径与方法，供前端多路径优化面板
    if (p === '/api/intent-rsi/optimization-capabilities' && req.method === 'GET') {
      const st = loadState();
      sendJson(res, 200, {
        ok: true,
        data: {
          targets: {
            graph: { methods: ['A1_utterance_expand', 'A2_disambiguation', 'A3_clause_expansion', 'A4_description_rewrite', 'A5_clarify', 'bundle'] },
            engine: { methods: ['E1_engine_param', 'bundle'] },
            prompt: { methods: ['P1_prompt_variant', 'bundle'] },
          },
          methods: {
            A1_utterance_expand: { status: 'ready', label: OPS.A1_utterance_expand.label, target: 'graph', engine: 'LLM提案→确定性验证器评估' },
            A2_disambiguation: { status: 'ready', label: OPS.A2_disambiguation.label, target: 'graph', engine: 'LLM提案→确定性验证器评估' },
            A3_clause_expansion: { status: 'ready', label: OPS.A3_clause_expansion.label, target: 'graph', engine: 'LLM提案→确定性验证器评估' },
            A4_description_rewrite: { status: 'ready', label: OPS.A4_description_rewrite.label, target: 'graph', engine: 'LLM提案→确定性验证器评估' },
            A5_clarify: { status: 'ready', label: OPS.A5_clarify.label, target: 'graph', engine: 'LLM提案→确定性验证器评估' },
            E1_engine_param: { status: 'ready', label: OPS.E1_engine_param.label, target: 'engine', engine: '坐标下降确定性搜索(POST /engine-param-search) + LLM提案双路径', search: 'coordinate_descent' },
            P1_prompt_variant: { status: 'ready', label: OPS.P1_prompt_variant.label, target: 'prompt', engine: 'LLM改写→recognition角色在ambiguous类case上LLM重判/optimizer角色替换提案器system prompt' },
            bundle: { status: 'ready', label: '组合打包评测', target: 'mixed', engine: '多提案叠加→统一门禁' },
          },
          currentEngineParams: st.engineParams || { ...DEFAULT_ENGINE_PARAMS },
          currentPromptVariants: st.promptVariants || {},
        },
      });
      return true;
    }
    // ── 任务列表：进化任务一览（含迁移任务 / 自建任务 / park 只读） ──
    if (p === '/api/intent-rsi/tasks' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, tasks: await taskRegistry() });
      return true;
    }
    if (p === '/api/intent-rsi/tasks/update' && req.method === 'POST') {
      const body=await readJsonBody(req),st=loadState();
      if(body.name!==undefined){const name=String(body.name).trim();if(!name||name.length>40)throw new Error('任务名称需为1至40个字');st.taskName=name;}
      if(body.description!==undefined){const description=String(body.description).trim();if(description.length>200)throw new Error('任务说明不能超过200字');st.taskDesc=description;}
      if(body.archived!==undefined){if(typeof body.archived!=='boolean')throw new Error('归档状态无效');st.archived=body.archived;st.archivedAt=body.archived?new Date().toISOString():null;}
      st.log||=[];st.log.push({at:new Date().toISOString(),event:'task_metadata',detail:body.archived===true?'任务已归档（数据保留）':body.archived===false?'任务已恢复':'任务名称或说明已更新'});saveState(st);
      sendJson(res,200,{ok:true,task:taskSummaryOf(st.taskId)});return true;
    }
    // ── 新建任务（body: {name, description?, base?}） ──
    if (p === '/api/intent-rsi/tasks/create' && req.method === 'POST') {
      const body = await readJsonBody(req);
      sendJson(res, 200, { ok: true, ...runCreateTask(body) });
      return true;
    }
    // ── 切换当前任务（body: {id}） ──
    if (p === '/api/intent-rsi/tasks/switch' && req.method === 'POST') {
      const body = await readJsonBody(req);
      sendJson(res, 200, { ok: true, ...runSwitchTask(body) });
      return true;
    }
    // ── 删除任务（body/query: {id}）：软删除——目录改名为 .trash-<id>-<ts>，可人工恢复；
    // 正在运行的任务与 park 拒绝删除；被删的是当前活动任务时自动切回剩余任务 ──
    if (p === '/api/intent-rsi/tasks/delete' && req.method === 'POST') {
      const body = await readJsonBody(req);
      sendJson(res, 200, { ok: true, ...runDeleteTask(body) });
      return true;
    }
    // ── 园区独立引擎精度历史 + 校准状态（恢复自 f92e176e，前端 park 视图数据源） ──
    if (p === '/api/intent-rsi/park-history' && req.method === 'GET') {
      const st = loadState();
      sendJson(res, 200, { ok: true, history: readParkHistory(), calibration: parkCalibrationPublicState(st) });
      return true;
    }
    // ── 园区独立引擎实时校准 ──
    if (p === '/api/intent-rsi/park-calibrate' && req.method === 'POST') {
      const body = await readJsonBody(req);
      sendJson(res, 200, { ok: true, ...runParkCalibrate(body) });
      return true;
    }
    // ── prompt 层优化三端点：后端未实现 openjiuwen MemberOptimizer 集成（评审 F02），
    // 此前 404 "unknown endpoint" 让用户以为是故障；现在给出明确的"未接入"说明 ──
    if (['/api/intent-rsi/prompt-optimize', '/api/intent-rsi/prompt-apply', '/api/intent-rsi/prompt-reject'].includes(p)) {
      sendJson(res, 501, { ok: false, error: '提示词层自优化（MemberOptimizer）尚未接入当前后端：rsi-agent 服务未部署。前端将隐藏该入口，避免误操作。' });
      return true;
    }
    sendJson(res, 404, { ok: false, error: 'unknown intent-rsi endpoint' });
    return true;
  } catch (e) {
    sendJson(res, e.statusCode || 500, { ok: false, error: e.message, ...(e.importReport ? { importReport: e.importReport } : {}) });
    return true;
  } finally {
    releaseLegacy?.();
  }
}

const productionRuntime = require('./rsi-production-runtime').createProductionRuntime({
  root: ROOT, rsiDir: RSI_DIR, loadState, saveState, loadGraph, readCases, publicState,
  agentUrl: process.env.RSI_AGENT_URL || 'http://rsi-agent:18132',
  proposerReady: () => Object.values(API_ROUTES).some(route => typeof route?.getKey === 'function' && !!route.getKey()),
  aggregate, computeRecallMetrics, computeAdjudicationMetrics, attributeResults, applyProposal, validateProposal, extractJsonArray, callLLM, readJsonBody, sendJson,
  saveVersion: (version, graph, state) => writeJson(resolveGraphPath(version, state), graph),
  childEnv: () => {
    const env = { ...process.env };
    for (const [route, key] of [['qwen-plus', 'QWEN_KEY'], ['deepseek-chat', 'DEEPSEEK_KEY']]) {
      if (!env[key] && API_ROUTES[route]?.getKey) env[key] = API_ROUTES[route].getKey() || '';
    }
    return env;
  },
});
module.exports = { handleIntentRsiRequest };
// 只读测试导出：供 E2E/冒烟脚本验证引擎与去重机制，不含任何写路径
module.exports.__test = { rsiDir: RSI_DIR, isOrphanRun, callLLM, matchOne, splitClauses, evalCase, noveltyHit, proposalCore, loadGraph, nodeById, SUBCLAUSE_MIN_SCORE, validateProposal, applyProposal, aggregate, extractJsonArray, attributeResults, counterfactualAnalysis, bigrams };

