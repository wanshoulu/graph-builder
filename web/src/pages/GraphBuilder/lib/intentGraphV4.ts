/**
 * V4.1 意图图谱文件 ↔ builder GraphDocument 适配层（纯函数，可单测）
 *
 * 对齐 docs/ai-native-bank/intent-graph-schema-v4.md v4.1：
 *   层级       → builder 边类型 has_child（父→子）；导出派生 parent_intent_id / path
 *   横切关系   → same_as / confusable_with / related_to 边 → relations[]（id=rel.{from}.{type}.{to}，#场景 后缀存 edge.properties.scene）
 *   场景       → 节点 properties.scenes（JSON 字符串；模板字段类型 multiline，前端按 key 特判渲染场景卡编辑器）
 *   资源注册表 → document.metadata.v4ResourceRegistries = {capabilities,faqs,policies,skillBindings}
 *   digest     → sha256（canonical JSON：键排序递归稳定序列化，与后端 graphDocumentDigest 同规则）
 */
import type { GraphDocument, GraphEdge, GraphNode } from '@/api/orgGraph';

export const V4_SCHEMA_VERSION = '4.1';

export const V4_SCENE_TYPES = ['ASK', 'QUERY', 'DO', 'CHANGE', 'CANCEL', 'HELP', 'TRANSFER', 'REPAY'] as const;
export const V4_EXECUTION_MODES = ['read-execute', 'confirm-required', 'knowledge-only', 'multi_intent', 'navigation-only', 'unavailable'] as const;
export const V4_CAPABILITY_KINDS = ['mcp-tool', 'skill', 'workflow', 'agent', 'menu-nav'] as const;
export const V4_RELATION_EDGE_TYPES = ['same_as', 'confusable_with', 'related_to'] as const;

const NODE_ROLE_BY_TYPE: Record<string, string> = { ROOT: 'root', DOMAIN: 'domain', CATEGORY: 'category', LEAF: 'leaf' };

/** V4.1 顶层结构（§7） */
export interface V41Graph {
  schemaVersion: string;
  graphId: string;
  version: string;
  bank: string;
  appSurface: string;
  publishedAt: string;
  intentTree: V41Node[];
  relations: V41Relation[];
  resourceRegistries: V41Registries;
  digest?: string;
}

export interface V41Node {
  id: string;
  title: string;
  node_role: string;
  parent_intent_id: string | null;
  path: string;
  depth?: number;
  scope_in: string[];
  scope_out: string[];
  navigationTerms: string[];
  bindings?: { menu?: { path: string }; businessObjects?: string[]; policies?: string[] };
  observability?: unknown;
  scenes?: V41Scene[];
  lifecycle?: string;
}

export interface V41Scene {
  scene_type: string;
  semantic_definition?: Record<string, unknown>;
  retrieval_profile?: Record<string, unknown>;
  task_binding?: Record<string, unknown>;
  knowledge_binding?: Record<string, unknown>;
  decision_policy?: Record<string, unknown>;
  execution_binding?: Record<string, unknown>;
  bindings?: { capabilities?: string[]; policies?: string[] };
}

export interface V41Relation {
  id: string;
  type: string;
  from: string;
  to: string;
  relation_category?: string;
  status?: string;
  weight?: number;
  evidence?: string;
  condition?: string;
  owner?: string;
  version?: string;
}

export interface V41Registries {
  capabilities: Record<string, unknown>[];
  faqs: Record<string, unknown>[];
  policies: Record<string, unknown>[];
  skillBindings: Record<string, unknown>[];
}

export interface V4ExportOptions {
  graphId?: string;
  version?: string;
  bank?: string;
  appSurface?: string;
  publishedAt?: string;
}

// ── canonical JSON + sha256（对齐后端 graphDocumentDigest：键排序、忽略生成时间类字段） ──

export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return '[' + value.map((v) => canonicalJson(v)).join(',') + ']';
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson((value as Record<string, unknown>)[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

/** sha256 hex（WebCrypto；浏览器与 Node 18+ 均可用） */
export async function sha256Hex(text: string): Promise<string> {
  const globalCrypto = (globalThis as { crypto?: { subtle?: { digest: (a: string, d: Uint8Array) => Promise<ArrayBuffer> } } }).crypto;
  if (!globalCrypto?.subtle) return '';
  const data = new TextEncoder().encode(text);
  const buf = await globalCrypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** V4.1 文件 digest（sha256:<hex>，对 canonicalJson({intentTree,relations,resourceRegistries})） */
export async function computeV41Digest(graph: Pick<V41Graph, 'intentTree' | 'relations' | 'resourceRegistries'>): Promise<string> {
  const hex = await sha256Hex(canonicalJson({ intentTree: graph.intentTree, relations: graph.relations, resourceRegistries: graph.resourceRegistries }));
  return 'sha256:' + hex;
}

// ── 解析工具 ──

/** 解析 properties.scenes（JSON 字符串 → 数组；解析失败返回 null） */
export function parseScenesProp(value: unknown): V41Scene[] | null {
  const raw = String(value ?? '').trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as V41Scene[]) : null;
  } catch {
    return null;
  }
}

function safeParseObject(value: unknown): Record<string, unknown> | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 从标题派生 ASCII slug（id 只允许 ^[a-z0-9.-]+$；无 ASCII 字符时退回 base36 hash） */
export function asciiSlug(title: string): string {
  const slug = String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return slug;
}

function shortHash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * V4 规范的新节点 id：子 id = 父id + '.' + slug（无 ASCII 时用 hash）；ROOT 无父时用根段。
 * existingIds 用于保证全图唯一（冲突时追加 -hash 短后缀）。
 */
export function deriveV4NodeId(nodeType: string, parentId: string | null, title: string, existingIds: Set<string>): string {
  const base = asciiSlug(title) || shortHash(String(title || '') + nodeType);
  const prefix = parentId && parentId.trim() ? parentId.trim() + '.' : (nodeType === 'ROOT' ? 'root' : 'n') + '.';
  let id = prefix + base;
  if (!existingIds.has(id)) return id;
  id = prefix + base + '-' + shortHash(base + String(existingIds.size));
  let n = 2;
  while (existingIds.has(id)) { id = prefix + base + '-' + n; n += 1; }
  return id;
}

// ── GraphDocument → V4.1 文件 ──

/** builder 文档 → V4.1 文件（digest 异步；digest 传 undefined 时输出省略该字段） */
export async function graphDocumentToV4(document: GraphDocument, opts?: V4ExportOptions & { digest?: string }): Promise<V41Graph> {
  const nodes = document.nodes || [];
  const edges = document.edges || [];
  const byId = new Map<string, GraphNode>();
  nodes.forEach((n) => { byId.set(n.id, n); });

  // 层级：has_child（父→子）→ parentOf / childrenOf
  const parentOf = new Map<string, string>();
  edges.forEach((e) => {
    if (e.type !== 'has_child') return;
    if (byId.has(e.source) && byId.has(e.target) && !parentOf.has(e.target)) parentOf.set(e.target, e.source);
  });

  // path / depth 派生（沿父链收集 title，'/' 连接；根 depth=0）
  const pathOf = new Map<string, string>();
  const depthOf = new Map<string, number>();
  const computePath = (id: string): { path: string; depth: number } => {
    const cached = pathOf.get(id);
    if (cached !== undefined && depthOf.has(id)) return { path: cached, depth: depthOf.get(id) as number };
    const chain: string[] = [];
    let cur: string | undefined = id;
    const seen = new Set<string>();
    while (cur && byId.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      chain.push(cur);
      cur = parentOf.get(cur);
    }
    const titles = chain.slice().reverse().map((nid) => String(byId.get(nid)?.properties?.title || nid));
    const path = titles.join('/');
    chain.forEach((nid, i) => {
      if (!pathOf.has(nid)) {
        pathOf.set(nid, titles.slice(0, titles.length - i).join('/'));
        depthOf.set(nid, chain.length - 1 - i);
      }
    });
    return { path, depth: chain.length - 1 };
  };

  const registries = readRegistries(document);
  const intentTree: V41Node[] = nodes.map((n) => {
    const p = n.properties || {};
    const parentId = parentOf.get(n.id) || null;
    const { path, depth } = computePath(n.id);
    const scenes = parseScenesProp(p.scenes);
    const observability = typeof p.observability === 'string' && p.observability.trim() ? safeParseObject(p.observability) : null;
    const node: V41Node = {
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

  // 横切关系：3 种关系边 → relations[]（#场景 后缀从 properties.scene 拼进 from/to）
  const relations: V41Relation[] = [];
  edges.forEach((e: GraphEdge) => {
    if ((V4_RELATION_EDGE_TYPES as readonly string[]).indexOf(e.type) < 0) return;
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

  const graph: V41Graph = {
    schemaVersion: V4_SCHEMA_VERSION,
    graphId: opts?.graphId || 'graph-builder-v4',
    version: opts?.version || (document.document_version || '1.0.0'),
    bank: opts?.bank || 'CCB',
    appSurface: opts?.appSurface || 'mock-mobile-bank',
    publishedAt: opts?.publishedAt || new Date().toISOString(),
    intentTree,
    relations,
    resourceRegistries: registries,
  };
  if (opts?.digest !== undefined) {
    graph.digest = opts.digest || (await computeV41Digest(graph));
  }
  return graph;
}

/** 读文档 metadata.v4ResourceRegistries（缺省补空表） */
export function readRegistries(document: GraphDocument): V41Registries {
  const reg = ((document.metadata || {}) as Record<string, unknown>).v4ResourceRegistries as Partial<V41Registries> | undefined;
  return {
    capabilities: Array.isArray(reg?.capabilities) ? reg!.capabilities! : [],
    faqs: Array.isArray(reg?.faqs) ? reg!.faqs! : [],
    policies: Array.isArray(reg?.policies) ? reg!.policies! : [],
    skillBindings: Array.isArray(reg?.skillBindings) ? reg!.skillBindings! : [],
  };
}

// ── V4.1 文件 → GraphDocument ──

export interface V4ImportResult {
  document: GraphDocument;
  errors: string[];
}

/** V4.1 文件 → builder 文档（层级合成 has_child 边；relations 合成关系边；#场景 后缀拆到 properties.scene） */
export function v4ToGraphDocument(graph: V41Graph, base?: GraphDocument): V4ImportResult {
  const errors: string[] = [];
  const tree = Array.isArray(graph.intentTree) ? graph.intentTree : [];
  const ids = new Set<string>();
  tree.forEach((n) => { if (n && n.id) ids.add(n.id); });

  const nodes: GraphNode[] = tree.map((n) => {
    const properties: Record<string, unknown> = {
      title: String(n.title ?? n.id),
      node_role: String(n.node_role || 'leaf'),
      scope_in: Array.isArray(n.scope_in) ? n.scope_in : [],
      scope_out: Array.isArray(n.scope_out) ? n.scope_out : [],
      navigation_terms: Array.isArray(n.navigationTerms) ? n.navigationTerms : [],
      menu: n.bindings?.menu?.path ? String(n.bindings.menu.path) : '',
      business_objects: Array.isArray(n.bindings?.businessObjects) ? n.bindings!.businessObjects : [],
      policies: Array.isArray(n.bindings?.policies) ? n.bindings!.policies : [],
      observability: n.observability !== undefined && n.observability !== null ? JSON.stringify(n.observability) : '',
      lifecycle: String(n.lifecycle || 'active'),
    };
    if (Array.isArray(n.scenes) && n.scenes.length > 0) {
      properties.scenes = JSON.stringify(n.scenes);
    } else if (n.scenes !== undefined && !Array.isArray(n.scenes)) {
      errors.push(`节点 ${n.id} 的 scenes 不是数组，已忽略`);
    }
    const type = (Object.keys(NODE_ROLE_BY_TYPE).find((t) => NODE_ROLE_BY_TYPE[t] === n.node_role)) || 'LEAF';
    return { id: n.id, type, properties };
  });

  const edges: GraphEdge[] = [];
  tree.forEach((n) => {
    if (!n.parent_intent_id) return;
    if (!ids.has(n.parent_intent_id)) {
      errors.push(`节点 ${n.id} 的 parent_intent_id「${n.parent_intent_id}」不存在，已跳过该层级边`);
      return;
    }
    edges.push({
      id: `edge.hc.${n.id}`,
      type: 'has_child',
      source: n.parent_intent_id,
      target: n.id,
      properties: { relation_category: 'hierarchy', owner: '', version: '', evidence: '' },
    });
  });

  (Array.isArray(graph.relations) ? graph.relations : []).forEach((rel) => {
    const type = String(rel.type || '');
    if ((V4_RELATION_EDGE_TYPES as readonly string[]).indexOf(type) < 0) {
      errors.push(`关系 ${rel.id || ''} 类型「${type}」不在 same_as/confusable_with/related_to 内，已跳过`);
      return;
    }
    const splitRef = (ref: string): { id: string; scene?: string } => {
      const at = ref.indexOf('#');
      return at >= 0 ? { id: ref.slice(0, at), scene: ref.slice(at + 1) } : { id: ref };
    };
    const from = splitRef(String(rel.from || ''));
    const to = splitRef(String(rel.to || ''));
    if (!ids.has(from.id) || !ids.has(to.id)) {
      errors.push(`关系 ${rel.id || type} 端点不存在（${rel.from} → ${rel.to}），已跳过`);
      return;
    }
    edges.push({
      id: rel.id || `edge.rel.${from.id}.${type}.${to.id}`,
      type,
      source: from.id,
      target: to.id,
      properties: {
        relation_category: rel.relation_category || (type === 'confusable_with' ? 'clarification' : 'semantic'),
        status: rel.status || 'active',
        weight: typeof rel.weight === 'number' ? rel.weight : 1,
        scene: from.scene || '',
        evidence: rel.evidence || '',
        condition: rel.condition || '',
        owner: rel.owner || '',
        version: rel.version || '',
      },
    });
  });

  const metadata: Record<string, unknown> = { ...((base?.metadata || {}) as Record<string, unknown>) };
  metadata.v4ResourceRegistries = {
    capabilities: graph.resourceRegistries?.capabilities || [],
    faqs: graph.resourceRegistries?.faqs || [],
    policies: graph.resourceRegistries?.policies || [],
    skillBindings: graph.resourceRegistries?.skillBindings || [],
  };

  return {
    document: {
      document_id: base?.document_id || 'graph-v4-imported',
      document_version: base?.document_version || graph.version || '1.0.0',
      asset_id: base?.asset_id || 'intent-graph-v4',
      template_ref: base?.template_ref || { template_id: 'intent-graph-v4', template_version: '1.0.0' },
      nodes,
      edges,
      metadata,
    },
    errors,
  };
}
