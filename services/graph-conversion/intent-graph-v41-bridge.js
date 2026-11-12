/**
 * V4.1 构建文档（builder GraphDocument：nodes+edges）→ V4.1 运行时文档（intentTree）服务端桥。
 *
 * 自动建图（auto-build）在 intent-graph-v4 资产上产出的是 nodes+edges 形态：
 *   - 层级：has_child 边（父→子），子节点 id 以「父节点id.」为前缀
 *   - 场景：LEAF 节点 properties.scenes（JSON 字符串数组）
 *   - 横切：same_as / confusable_with / related_to 边
 *   - 资源注册表：document.metadata.v4ResourceRegistries
 * 而银行运行时 V4GraphAdapter 只消费 intentTree 树结构（parent_intent_id/path/scenes）。
 * 本桥与前端 knowledgebuilder/web/src/pages/GraphBuilder/lib/intentGraphV4.ts 的
 * graphDocumentToV4() 映射规则一一对应（两侧改动必须同步），差异仅两点：
 *   1. digest 用 node:crypto（web 用 WebCrypto）
 *   2. appSurface 缺省 'mock-mobile-bank'（web 导出缺省 'mobile-app'）——
 *      服务端桥的对齐目标是银行运行时，与 /publish-v4-to-runtime 的缺省元数据一致
 */
'use strict';

const crypto = require('node:crypto');

const NODE_ROLE_BY_TYPE = { ROOT: 'root', DOMAIN: 'domain', CATEGORY: 'category', LEAF: 'leaf' };
const V4_RELATION_EDGE_TYPES = ['same_as', 'confusable_with', 'related_to'];
const V4_SCHEMA_VERSION = '4.1';

/** canonical JSON：键排序递归稳定序列化（与前端 canonicalJson 同规则，digest 才可比） */
function canonicalJson(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

/** sha256:<hex>，对 canonicalJson({intentTree,relations,resourceRegistries})（与前端 computeV41Digest 同规则） */
function computeV41Digest(graph) {
  const hex = crypto.createHash('sha256')
    .update(canonicalJson({ intentTree: graph.intentTree, relations: graph.relations, resourceRegistries: graph.resourceRegistries }))
    .digest('hex');
  return 'sha256:' + hex;
}

/** properties.scenes（JSON 字符串 → 数组；空串 → []；非法 JSON → null） */
function parseScenesProp(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function safeParseObject(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * builder V4.1 文档 → V4.1 运行时文档（intentTree + relations + resourceRegistries + digest）。
 * @param {object} doc  nodes+edges 形态的构建文档（auto-build / 工作台产出）
 * @param {object} [opts] { graphId, version, bank, appSurface, publishedAt }
 * @returns {object} intentTree 形态文档
 */
function builderDocumentToV41(doc, opts) {
  const nodes = doc.nodes || [];
  const edges = doc.edges || [];
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // 层级：has_child（父→子），首边生效（与前端一致：多父取第一条，其余忽略）
  const parentOf = new Map();
  edges.forEach((e) => {
    if (!e || e.type !== 'has_child') return;
    if (byId.has(e.source) && byId.has(e.target) && !parentOf.has(e.target)) parentOf.set(e.target, e.source);
  });

  // path / depth 派生：沿父链收集 title 以 '/' 连接（环安全）
  const pathOf = new Map();
  const depthOf = new Map();
  const computePath = (id) => {
    const cached = pathOf.get(id);
    if (cached !== undefined && depthOf.has(id)) return { path: cached, depth: depthOf.get(id) };
    const chain = [];
    let cur = id;
    const seen = new Set();
    while (cur && byId.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      chain.push(cur);
      cur = parentOf.get(cur);
    }
    const titles = chain.slice().reverse().map((nid) => String((byId.get(nid).properties || {}).title || (byId.get(nid).properties || {}).name || nid));
    const path = titles.join('/');
    chain.forEach((nid, i) => {
      if (!pathOf.has(nid)) {
        pathOf.set(nid, titles.slice(0, titles.length - i).join('/'));
        depthOf.set(nid, chain.length - 1 - i);
      }
    });
    return { path, depth: chain.length - 1 };
  };

  const registries = readRegistries(doc);
  const intentTree = nodes.map((n) => {
    const p = n.properties || {};
    const parentId = parentOf.get(n.id) || null;
    const { path, depth } = computePath(n.id);
    const scenes = parseScenesProp(p.scenes);
    const observability = typeof p.observability === 'string' && p.observability.trim() ? safeParseObject(p.observability) : null;
    const node = {
      id: n.id,
      title: String(p.title ?? p.name ?? n.id),
      node_role: String(p.node_role || NODE_ROLE_BY_TYPE[n.type] || 'category'),
      parent_intent_id: parentId,
      path,
      depth,
      scope_in: Array.isArray(p.scope_in) ? p.scope_in.map(String) : [],
      scope_out: Array.isArray(p.scope_out) ? p.scope_out.map(String) : [],
      navigationTerms: Array.isArray(p.navigation_terms) ? p.navigation_terms.map(String) : [],
      lifecycle: String(p.lifecycle || 'active'),
    };
    // 功能级 bindings（menu/businessObjects/policies 任一非空才输出；root 不输出）
    const menu = String(p.menu ?? '').trim();
    const businessObjects = Array.isArray(p.business_objects) ? p.business_objects.map(String).filter(Boolean) : [];
    const policies = Array.isArray(p.policies) ? p.policies.map(String).filter(Boolean) : [];
    if (n.type !== 'ROOT' && (menu || businessObjects.length || policies.length)) {
      node.bindings = {};
      if (menu) node.bindings.menu = { path: menu };
      if (businessObjects.length) node.bindings.businessObjects = businessObjects;
      if (policies.length) node.bindings.policies = policies;
    }
    if (observability) node.observability = observability;
    if (scenes && scenes.length > 0) node.scenes = scenes;
    return node;
  });

  // 横切关系：3 种关系边 → relations[]（源端 #场景 后缀从 properties.scene 拼回）
  const relations = [];
  edges.forEach((e) => {
    if (!e || V4_RELATION_EDGE_TYPES.indexOf(e.type) < 0) return;
    if (!byId.has(e.source) || !byId.has(e.target)) return;
    const props = e.properties || {};
    const scene = String(props.scene ?? '').trim();
    const from = scene ? e.source + '#' + scene : e.source;
    const to = e.target;
    relations.push({
      id: `rel.${from}.${e.type}.${to}`,
      type: e.type,
      from,
      to,
      relation_category: String(props.relation_category || '') || undefined,
      status: String(props.status || '') || undefined,
      weight: typeof props.weight === 'number' ? props.weight : undefined,
      evidence: String(props.evidence ?? '') || undefined,
      condition: String(props.condition ?? '') || undefined,
      owner: String(props.owner ?? '') || undefined,
      version: String(props.version ?? '') || undefined,
    });
  });

  const graph = {
    schemaVersion: V4_SCHEMA_VERSION,
    graphId: (opts && opts.graphId) || doc.graphId || doc.document_id || 'graph-builder-v4',
    version: (opts && opts.version) || doc.document_version || '1.0.0',
    bank: (opts && opts.bank) || doc.bank || 'CCB',
    appSurface: (opts && opts.appSurface) || doc.appSurface || 'mock-mobile-bank',
    publishedAt: (opts && opts.publishedAt) || doc.publishedAt || new Date().toISOString(),
    intentTree,
    relations,
    resourceRegistries: registries,
  };
  graph.digest = computeV41Digest(graph);
  return graph;
}

/** 读文档 metadata.v4ResourceRegistries（缺省补空表） */
function readRegistries(doc) {
  const reg = ((doc.metadata || {})).v4ResourceRegistries || {};
  return {
    capabilities: Array.isArray(reg.capabilities) ? reg.capabilities : [],
    faqs: Array.isArray(reg.faqs) ? reg.faqs : [],
    policies: Array.isArray(reg.policies) ? reg.policies : [],
    skillBindings: Array.isArray(reg.skillBindings) ? reg.skillBindings : [],
  };
}

module.exports = { builderDocumentToV41, computeV41Digest, canonicalJson, parseScenesProp, readRegistries };
