'use strict';

/**
 * 图谱评测图谱注册表：合并银行意图图谱（bank 引擎）与 v2 引擎的 manifest 版本，
 * 供评测页图谱选择器与 status 端点按 graph id 分流。
 * graph id 约定：`bank:<graphId>` 走银行运行时引擎；其余按 v2 版本 id 解析 manifest。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const BANK_GRAPH_PATH = path.join(ROOT, 'data', 'ai-native-bank', 'intent-graph', 'graph.ccb.intents.v1.0.0.json');
const VERSION_MANIFEST_PATH = path.join(ROOT, 'data', 'graphs', 'intent-graph-version-manifest.json');

let bankGraphCache = null; // { mtimeMs, size, stats }
let bankTitleCache = null; // { mtimeMs, size, titles }
let manifestCache = null; // { mtimeMs, manifest }
let v2GraphCountCache = new Map(); // path -> { mtimeMs, intentCount }

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function getBankGraphStats() {
  let stat;
  try {
    stat = fs.statSync(BANK_GRAPH_PATH);
  } catch (error) {
    return null;
  }
  if (bankGraphCache && bankGraphCache.mtimeMs === stat.mtimeMs && bankGraphCache.size === stat.size) {
    return bankGraphCache.stats;
  }
  try {
    const graph = readJsonFile(BANK_GRAPH_PATH);
    const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
    const edges = Array.isArray(graph.edges) ? graph.edges : [];
    const stats = {
      path: BANK_GRAPH_PATH,
      graphId: graph.graphId || 'ccb-mobile-bank-intents',
      version: graph.version || '',
      schemaVersion: graph.schemaVersion || '',
      nodeCount: nodes.length,
      edgeCount: edges.length,
      intentCount: nodes.filter((node) => node && node.type === 'intent').length,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(BANK_GRAPH_PATH)).digest('hex'),
    };
    bankGraphCache = { mtimeMs: stat.mtimeMs, size: stat.size, stats };
    return stats;
  } catch (error) {
    return null;
  }
}

function getBankIntentTitles() {
  let stat;
  try {
    stat = fs.statSync(BANK_GRAPH_PATH);
  } catch (error) {
    return {};
  }
  if (bankTitleCache && bankTitleCache.mtimeMs === stat.mtimeMs && bankTitleCache.size === stat.size) {
    return bankTitleCache.titles;
  }
  try {
    const graph = readJsonFile(BANK_GRAPH_PATH);
    const titles = {};
    const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
    nodes.forEach((node) => {
      if (node && node.id && node.title) titles[node.id] = node.title;
    });
    bankTitleCache = { mtimeMs: stat.mtimeMs, size: stat.size, titles };
    return titles;
  } catch (error) {
    return {};
  }
}

function getVersionManifest() {
  let stat;
  try {
    stat = fs.statSync(VERSION_MANIFEST_PATH);
  } catch (error) {
    return { versions: [], active_default: '' };
  }
  if (manifestCache && manifestCache.mtimeMs === stat.mtimeMs) return manifestCache.manifest;
  try {
    const manifest = readJsonFile(VERSION_MANIFEST_PATH);
    manifestCache = { mtimeMs: stat.mtimeMs, manifest };
    return manifest;
  } catch (error) {
    return { versions: [], active_default: '' };
  }
}

function resolveGraphPathForVersion(versionId) {
  const manifest = getVersionManifest();
  const versions = Array.isArray(manifest.versions) ? manifest.versions : [];
  const version = versions.find((item) => item && item.version_id === versionId);
  const graphFile = version && (version.clean_alias_file || version.graph_file);
  if (!graphFile) return null;
  return path.join(ROOT, graphFile);
}

function countV2Intents(graphPath) {
  let stat;
  try {
    stat = fs.statSync(graphPath);
  } catch (error) {
    return null;
  }
  const cached = v2GraphCountCache.get(graphPath);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.intentCount;
  try {
    const graph = readJsonFile(graphPath);
    const intentCount = Array.isArray(graph.intent_nodes)
      ? graph.intent_nodes.length
      : Array.isArray(graph.nodes)
        ? graph.nodes.filter((node) => node && /intent/i.test(String(node.type || ''))).length
        : null;
    v2GraphCountCache.set(graphPath, { mtimeMs: stat.mtimeMs, intentCount });
    return intentCount;
  } catch (error) {
    return null;
  }
}

function listEvaluationGraphs() {
  const graphs = [];
  const bank = getBankGraphStats();
  if (bank) {
    graphs.push({
      id: `bank:${bank.graphId}`,
      engine: 'bank',
      label: `银行意图图谱 ${bank.graphId}`,
      sublabel: `schema ${bank.schemaVersion || '2.0'} · v${bank.version} · ${bank.intentCount} 意图 / ${bank.nodeCount} 节点`,
      intent_count: bank.intentCount,
      node_count: bank.nodeCount,
      edge_count: bank.edgeCount,
      version: bank.version,
      engine_version: '意图引擎（确定性召回阶梯 + LLM 规划）',
      active: true,
      default: true,
    });
  }
  const manifest = getVersionManifest();
  const versions = Array.isArray(manifest.versions) ? manifest.versions : [];
  versions.forEach((version) => {
    if (!version || !version.version_id) return;
    const graphFile = version.clean_alias_file || version.graph_file;
    const intentCount = graphFile ? countV2Intents(path.join(ROOT, graphFile)) : null;
    graphs.push({
      id: `v2:${version.version_id}`,
      engine: 'v2',
      label: `v2 图谱 ${version.version_id}`,
      sublabel: `${version.stage || ''} · ${intentCount != null ? `${intentCount} 意图` : '意图数未知'}`,
      intent_count: intentCount,
      version: version.version_id,
      stage: version.stage || '',
      engine_version: 'Intent Evaluator v2.1',
      active: manifest.active_default === version.version_id,
      default: false,
    });
  });
  return { graphs, default_graph: graphs.length ? graphs[0].id : '' };
}

function resolveEngineTarget(graphId) {
  const raw = String(graphId || '').trim();
  if (raw.startsWith('bank:')) return { engine: 'bank', graphId: raw };
  if (raw.startsWith('v2:')) return { engine: 'v2', graphId: raw, graphVersionId: raw.slice(3) };
  return { engine: 'v2', graphId: raw, graphVersionId: raw || '' };
}

function getBankEngineStatus() {
  const bank = getBankGraphStats();
  if (!bank) return null;
  return {
    engine: 'bank',
    graph_version_id: `bank:${bank.graphId}`,
    graph_version: bank.version,
    graph_version_name: `银行意图图谱 ${bank.graphId} v${bank.version}`,
    graph_release_status: 'active',
    intent_count: bank.intentCount,
    executable_intent_count: bank.intentCount,
    knowledge_intent_count: 0,
    aggregate_intent_count: 0,
    edge_count: bank.edgeCount,
    faq_count: null,
    embedding_cache_count: null,
    llm_cache_count: null,
    // 运行时 LLM 裁决（LLMJudgeV4）模型名随每次真实评测由 bankRuntimeMeta 刷新（server.js 合并），
    // 此处仅给引擎事实描述，不硬编码具体模型名
    llm_model: 'LLMJudgeV4 候选内裁决',
    embedding_model: 'text-embedding-v4（弱召回拓宽）',
    evaluator_version_id: 'bank-runtime-intent-engine',
    evaluator_version: 'bank-runtime-intent-engine',
    evaluator_version_name: 'AI Native Bank 意图引擎（确定性召回阶梯）',
  };
}

/** 交互路径 v2 图谱选择回填：graph id（v2:<versionId>/裸版本id）→ options.graph_version_id。
 *  与跑批 engineFunctionFor 的映射同源；evaluateIntent 只认 graph_version_id，不回填会静默跑默认图。 */
function applyEngineTargetOptions(options) {
  const opts = options || {};
  const target = resolveEngineTarget(opts.graph);
  if (target.engine === 'v2' && target.graphVersionId && !String(opts.graph_version_id || '').trim()) {
    opts.graph_version_id = target.graphVersionId;
  }
  return opts;
}

module.exports = {
  listEvaluationGraphs,
  resolveEngineTarget,
  resolveGraphPathForVersion,
  getBankEngineStatus,
  getBankGraphStats,
  getBankIntentTitles,
  applyEngineTargetOptions,
};
