/**
 * 图文档 ↔ 编辑器画布数据转换 + AI 候选合并（纯函数，可单测）
 *
 * 数据模型约定（与 AI Harbor org-graph 文档同构）：
 *   document.nodes[i] = { id, type, properties, x?, y?, provenance?, confidence?, review_status? }
 *   溯源/布局字段放元素顶层 —— X6 校验器只查 properties，顶层键安全（已验证）。
 */
import type { GraphDocument, GraphEdge, GraphNode, GraphTemplate, ExtractResult, ReviewStatus } from '@/api/orgGraph';
import { primaryFieldKey } from './templateSchema';

/** 意图图谱系资产（旧 v2 模板 + V4.1 功能节点×场景制模板）：文档必须绑定当前模板版本 */
export const INTENT_TEMPLATE_ASSETS = ['intent-graph', 'intent-graph-v4'];

/** intent 系资产的文档必须绑定当前模板版本（其余资产原样返回；专家建图页与自动建图页共用） */
export function currentIntentTemplateDocument(assetId: string, template: GraphTemplate | null, document: GraphDocument): GraphDocument {
  if (INTENT_TEMPLATE_ASSETS.indexOf(assetId) < 0 || !template) return document;
  if (document.template_ref?.template_id === template.template_id && document.template_ref.template_version === template.template_version) return document;
  return { ...document, template_ref: { template_id: template.template_id, template_version: template.template_version } };
}

/** 浏览器端确定性字符串 hash（djb2；仅需会话内稳定，无需与后端 sha1 一致） */
export function hashText(text: string): string {
  let hsh = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hsh = ((hsh << 5) + hsh + text.charCodeAt(i)) | 0;
  }
  return (hsh >>> 0).toString(36);
}

/** 画布节点（React Flow 需要的形状；data 为平铺字段） */
export interface CanvasNode {
  id: string;
  position: { x: number; y: number };
  /** React Flow 节点组件类型（性能关键：直接作为 RF node 传入，避免每帧 map 重建） */
  type?: string;
  data: Record<string, unknown>;
}

export interface CanvasEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  data: Record<string, unknown>;
}

export interface CanvasGraph {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

const RESERVED_KEYS = ['id', 'position', 'source', 'target', 'label', 'type', 'style'];

/** 文档节点 → 画布节点（properties 平铺进 data；x/y/raw 顶层还原——raw 为 v2.1 原对象无损通道） */
export function nodeToCanvas(node: GraphNode): CanvasNode {
  const data: Record<string, unknown> = { id: node.id, nodeType: node.type };
  Object.keys(node.properties || {}).forEach((k) => { data[k] = node.properties[k]; });
  if (node.x !== undefined) data.x = node.x;
  if (node.y !== undefined) data.y = node.y;
  if (node.provenance) data.provenance = node.provenance;
  if (node.confidence !== undefined) data.confidence = node.confidence;
  if (node.review_status) data.review_status = node.review_status;
  if (node.raw !== undefined) data.raw = node.raw;
  return { id: node.id, type: 'custom', position: { x: node.x || 0, y: node.y || 0 }, data };
}

/** 文档边 → 画布边 */
export function edgeToCanvas(edge: GraphEdge): CanvasEdge {
  const data: Record<string, unknown> = { id: edge.id, edgeType: edge.type };
  Object.keys(edge.properties || {}).forEach((k) => { data[k] = edge.properties[k]; });
  if (edge.provenance) data.provenance = edge.provenance;
  if (edge.confidence !== undefined) data.confidence = edge.confidence;
  if (edge.review_status) data.review_status = edge.review_status;
  if (edge.raw !== undefined) data.raw = edge.raw;
  return { id: edge.id, source: edge.source, target: edge.target, label: edge.type, data };
}

/** 文档 → 画布图 */
export function documentToCanvas(document: GraphDocument): CanvasGraph {
  return {
    nodes: (document.nodes || []).map(nodeToCanvas),
    edges: (document.edges || []).map(edgeToCanvas),
  };
}

/**
 * 画布是否有任何节点带有效坐标。
 * 旧资产/AI 生成的文档节点无 x/y（nodeToCanvas 兜底为 0,0），
 * 全为原点时画布全部重叠 → 调用方需 layoutDagre 自动布局兜底。
 */
export function hasAnyPosition(nodes: CanvasNode[]): boolean {
  return nodes.some((n) => n.position.x !== 0 || n.position.y !== 0);
}

/** 画布节点 → 文档节点（data 平铺还原 properties：模板字段进 properties，顶层键回顶层） */
export function canvasToNode(node: CanvasNode, template: GraphTemplate): GraphNode {
  const fieldsByType: Record<string, string[]> = {};
  template.node_types.forEach((t) => { fieldsByType[t.type] = (t.fields || []).map((f) => f.key); });
  const nodeType = String(node.data.nodeType || '');
  const declared = nodeType ? fieldsByType[nodeType] || [] : [];
  const properties: Record<string, unknown> = {};
  const top: Partial<GraphNode> = {};
  Object.keys(node.data).forEach((k) => {
    const value = node.data[k];
    if (k === 'id' || k === 'nodeType') return;
    if (k === 'x') { top.x = typeof value === 'number' ? Math.round(value) : Number(value) || 0; return; }
    if (k === 'y') { top.y = typeof value === 'number' ? Math.round(value) : Number(value) || 0; return; }
    if (k === 'provenance') { top.provenance = value as GraphNode['provenance']; return; }
    if (k === 'confidence') { top.confidence = value as number; return; }
    if (k === 'review_status') { top.review_status = value as ReviewStatus; return; }
    if (k === 'raw') { top.raw = value; return; } // v2.1 原对象原样带回（无损通道）
    if (declared.indexOf(k) >= 0) properties[k] = value;
  });
  const result: GraphNode = { id: node.id, type: nodeType, properties };
  if (top.x !== undefined) result.x = top.x as number;
  if (top.y !== undefined) result.y = top.y as number;
  if (top.provenance) result.provenance = top.provenance;
  if (top.confidence !== undefined) result.confidence = top.confidence;
  if (top.review_status) result.review_status = top.review_status;
  if (top.raw !== undefined) result.raw = top.raw;
  return result;
}

/** 画布边 → 文档边 */
export function canvasToEdge(edge: CanvasEdge, template: GraphTemplate): GraphEdge {
  const fieldsByType: Record<string, string[]> = {};
  template.edge_types.forEach((t) => { fieldsByType[t.type] = (t.fields || []).map((f) => f.key); });
  const edgeType = String(edge.data.edgeType || edge.label || '');
  const declared = edgeType ? fieldsByType[edgeType] || [] : [];
  const properties: Record<string, unknown> = {};
  const top: Partial<GraphEdge> = {};
  Object.keys(edge.data).forEach((k) => {
    const value = edge.data[k];
    if (k === 'id' || k === 'edgeType' || k === 'label') return;
    if (k === 'provenance') { top.provenance = value as GraphEdge['provenance']; return; }
    if (k === 'confidence') { top.confidence = value as number; return; }
    if (k === 'review_status') { top.review_status = value as ReviewStatus; return; }
    if (k === 'raw') { top.raw = value; return; } // v2.1 原对象原样带回（无损通道）
    if (declared.indexOf(k) >= 0) properties[k] = value;
  });
  const result: GraphEdge = { id: edge.id, type: edgeType, source: edge.source, target: edge.target, properties };
  if (top.provenance) result.provenance = top.provenance;
  if (top.confidence !== undefined) result.confidence = top.confidence;
  if (top.review_status) result.review_status = top.review_status;
  if (top.raw !== undefined) result.raw = top.raw;
  return result;
}

/** 画布图 → 文档（document_id/template_ref 由调用方补） */
export function canvasToDocument(canvas: CanvasGraph, template: GraphTemplate, base?: GraphDocument): GraphDocument {
  const nodes = canvas.nodes.map((n) => canvasToNode(n, template));
  const edges = canvas.edges.map((e) => canvasToEdge(e, template));
  return {
    document_id: base?.document_id || 'graph-edited',
    document_version: base?.document_version || '1.0.0',
    asset_id: base?.asset_id || template.template_id,
    template_ref: base?.template_ref || { template_id: template.template_id, template_version: template.template_version },
    nodes,
    edges,
    metadata: base?.metadata || {},
  };
}

/** 节点主标签（模板主字段 → 回退 name/title/第一个非空字符串字段） */
export function nodeDisplayName(node: GraphNode | CanvasNode, template?: GraphTemplate): string {
  const props = 'properties' in node ? (node as GraphNode).properties : (node as CanvasNode).data;
  const nodeType = 'properties' in node ? (node as GraphNode).type : String((node as CanvasNode).data.nodeType || '');
  if (template) {
    const nt = template.node_types.find((t) => t.type === nodeType);
    const primary = primaryFieldKey((nt || { fields: [] }).fields);
    if (primary && props[primary]) return String(props[primary]);
  }
  if (props.name) return String(props.name);
  if (props.title) return String(props.title);
  const first = Object.keys(props).find((k) => typeof props[k] === 'string' && props[k] !== '');
  return first ? String(props[first]) : node.id;
}

/** 为模板字段生成默认值（优先使用模板 default；否则按类型给出空壳值） */
function defaultForField(f: { type?: string; default?: unknown; options?: string[] }): unknown {
  if (f.default !== undefined && f.default !== null) return f.default;
  switch (f.type) {
    case 'number': return 0;
    case 'boolean': return false;
    case 'enum': return (f.options && f.options.length > 0) ? f.options[0] : '';
    case 'multi_enum':
    case 'tags': return [];
    default: return '';
  }
}

/**
 * extract 返回扁平 shape（实测）：entities[{name,type,description,sourceDoc,sourceChunk,confidence}]、
 * relations[{source,type,target,sourceDoc,confidence}]，源/目标按名称引用。
 * 适配：entityType→type；name→主标签字段；description→description/definition 字段（模板有才写）；
 * sourceDoc/sourceChunk/confidence → 顶层 provenance/confidence（不进 properties）。
 */
export function extractResultToDocument(result: ExtractResult, template: GraphTemplate): GraphDocument {
  // ── 模板字段索引：主标签字段、描述字段、合法字段 key 集合、必填字段清单 ──
  const primaryByType: Record<string, string> = {};
  const descFieldByType: Record<string, string | null> = {};
  const validNodeFields: Record<string, Set<string>> = {};
  const requiredNodeFields: Record<string, { key: string; def: unknown }[]> = {};
  template.node_types.forEach((t) => {
    primaryByType[t.type] = primaryFieldKey(t.fields) || 'name';
    const keys = t.fields.map((f) => f.key);
    descFieldByType[t.type] = keys.indexOf('description') >= 0 ? 'description' : keys.indexOf('definition') >= 0 ? 'definition' : null;
    validNodeFields[t.type] = new Set(keys);
    requiredNodeFields[t.type] = (t.fields || []).filter((f) => f.required).map((f) => ({ key: f.key, def: defaultForField(f) }));
  });
  // 边类型合法字段 + 必填字段
  const validEdgeFields: Record<string, Set<string>> = {};
  const requiredEdgeFields: Record<string, { key: string; def: unknown }[]> = {};
  template.edge_types.forEach((t) => {
    validEdgeFields[t.type] = new Set((t.fields || []).map((f) => f.key));
    requiredEdgeFields[t.type] = (t.fields || []).filter((f) => f.required).map((f) => ({ key: f.key, def: defaultForField(f) }));
  });

  const idByName: Record<string, string> = {};
  const nodes: GraphNode[] = (result.entities || []).map((entity) => {
    const id = `${entity.type}:${hashText(entity.name)}`;
    if (!idByName[entity.name]) idByName[entity.name] = id;
    const properties: Record<string, unknown> = { [primaryByType[entity.type] || 'name']: entity.name };
    const descField = descFieldByType[entity.type];
    if (descField && entity.description) properties[descField] = entity.description;
    // 仅写入模板声明的字段 key（过滤 LLM 自造 key），跳过已由 name/description 覆盖的键
    const allowed = validNodeFields[entity.type];
    if (entity.fields && allowed) {
      for (const [k, v] of Object.entries(entity.fields)) {
        if (!allowed.has(k)) continue;
        if (k === primaryByType[entity.type] || k === descField) continue;
        if (v != null && v !== '') properties[k] = v;
      }
    }
    // 为缺失的必填字段填充默认值
    for (const req of (requiredNodeFields[entity.type] || [])) {
      if (properties[req.key] === undefined || properties[req.key] === null || properties[req.key] === '') {
        properties[req.key] = req.def;
      }
    }
    return {
      id,
      type: entity.type,
      properties,
      provenance: { source: 'ai-extract', sourceDoc: entity.sourceDoc, sourceChunk: entity.sourceChunk, generatedAt: new Date().toISOString() },
      confidence: entity.confidence,
      review_status: 'pending',
    };
  });

  const edgeIds: Record<string, boolean> = {};
  const edges: GraphEdge[] = [];
  (result.relations || []).forEach((rel) => {
    // 源/目标按名称解析（同名跨类型取首个匹配，extract 输出即名称引用）
    const src = idByName[rel.source];
    const tgt = idByName[rel.target];
    if (!src || !tgt) return;
    const edgeId = `edge:${rel.type}:${hashText(`${src}->${tgt}`)}`;
    if (edgeIds[edgeId]) return;
    edgeIds[edgeId] = true;
    // 边属性：仅写入模板声明的字段 key（与节点同理，过滤 LLM 自造 key）
    const edgeProps: Record<string, unknown> = {};
    const allowedEdge = validEdgeFields[rel.type];
    if (rel.fields && allowedEdge) {
      for (const [k, v] of Object.entries(rel.fields)) {
        if (!allowedEdge.has(k)) continue;
        if (v != null && v !== '') edgeProps[k] = v;
      }
    }
    // 为缺失的必填边字段填充默认值
    for (const req of (requiredEdgeFields[rel.type] || [])) {
      if (edgeProps[req.key] === undefined || edgeProps[req.key] === null || edgeProps[req.key] === '') {
        edgeProps[req.key] = req.def;
      }
    }
    edges.push({
      id: edgeId,
      type: rel.type,
      source: src,
      target: tgt,
      properties: edgeProps,
      provenance: { source: 'ai-extract', sourceDoc: rel.sourceDoc, generatedAt: new Date().toISOString() },
      confidence: rel.confidence,
      review_status: 'pending',
    });
  });

  return {
    document_id: 'extract-generated',
    document_version: '1.0.0',
    asset_id: template.template_id,
    template_ref: { template_id: template.template_id, template_version: template.template_version },
    nodes,
    edges,
    metadata: {},
  };
}

// ── 半自动合并（HITL 确认队列数据源） ──

export type CandidateStatus = 'new' | 'merge' | 'duplicate' | 'conflict' | 'endpoint_missing';

export interface CandidateItem {
  kind: 'node' | 'edge';
  status: CandidateStatus;
  item: GraphNode | GraphEdge;
  /** status=merge 时：并入的既有节点 id */
  existingId?: string;
  message?: string;
}

/**
 * AI 候选与既有画布合并分析（不改动输入，纯函数）：
 *  节点：同名同类型 → merge；同名异类型 → conflict；新 → new
 *  边：(source,target,type) 三元组去重 → duplicate；端点缺失 → endpoint_missing
 */
export function analyzeCandidates(base: GraphDocument, candidates: GraphDocument): CandidateItem[] {
  const items: CandidateItem[] = [];
  const existingNodes = base.nodes;
  const byNameType: Record<string, GraphNode> = {};
  const byId: Record<string, GraphNode> = {};
  existingNodes.forEach((n) => {
    byId[n.id] = n;
    byNameType[`${n.type}::${n.properties.name ?? ''}`] = n;
  });
  const edgeTriples: Record<string, boolean> = {};
  (base.edges || []).forEach((e) => { edgeTriples[`${e.source}|${e.target}|${e.type}`] = true; });

  const candidateNodeIds: Record<string, boolean> = {};
  const remappedIds: Record<string, string> = {};
  const invalidIds = new Set<string>();
  (candidates.nodes || []).forEach((n) => {
    const sameId = byId[n.id];
    if (sameId && sameId.type === n.type) {
      if (n.properties.name && sameId.properties.name && n.properties.name !== sameId.properties.name) {
        invalidIds.add(n.id);
        items.push({ kind: 'node', status: 'conflict', item: n, existingId: sameId.id, message: '候选使用了已有 ID，但名称不同；请核对是否误把两个意图合为一个' });
        return;
      }
      remappedIds[n.id] = sameId.id;
      items.push({ kind: 'node', status: 'merge', item: n, existingId: sameId.id, message: '补充已有节点中的空字段和典型表达，不覆盖已有内容' });
      return;
    }
    if (sameId && sameId.type !== n.type) {
      invalidIds.add(n.id);
      items.push({ kind: 'node', status: 'conflict', item: n, existingId: sameId.id, message: '候选 ID 与现有节点冲突且类型不同，不能直接写入' });
      return;
    }
    candidateNodeIds[n.id] = true;
    const sameNameSameType = n.properties.name ? byNameType[`${n.type}::${n.properties.name}`] : undefined;
    if (sameNameSameType) {
      remappedIds[n.id] = sameNameSameType.id;
      delete candidateNodeIds[n.id];
      items.push({ kind: 'node', status: 'merge', item: n, existingId: sameNameSameType.id, message: '已有同名同类型节点，将补充空字段和典型表达' });
      return;
    }
    const sameNameDiffType = Object.values(byNameType).find((e) => e.properties.name === n.properties.name);
    if (sameNameDiffType) {
      items.push({ kind: 'node', status: 'conflict', item: n, existingId: sameNameDiffType.id, message: `同名节点已存在但类型不同（现有 ${sameNameDiffType.type}），请先核对建模类型` });
      return;
    }
    items.push({ kind: 'node', status: 'new', item: n });
  });

  (candidates.edges || []).forEach((e) => {
    const edge = { ...e, source: remappedIds[e.source] || e.source, target: remappedIds[e.target] || e.target };
    if (invalidIds.has(e.source) || invalidIds.has(e.target)) {
      items.push({ kind: 'edge', status: 'endpoint_missing', item: edge, message: '关系连接了类型冲突的节点，暂不能写入' });
      return;
    }
    const triple = `${edge.source}|${edge.target}|${edge.type}`;
    if (edgeTriples[triple]) {
      items.push({ kind: 'edge', status: 'duplicate', item: edge, message: '这条关系在草稿中已经存在' });
      return;
    }
    if (!candidateNodeIds[edge.source] && !byId[edge.source]) {
      items.push({ kind: 'edge', status: 'endpoint_missing', item: edge, message: `起点 ${edge.source} 不在当前草稿或建议中` });
      return;
    }
    if (!candidateNodeIds[edge.target] && !byId[edge.target]) {
      items.push({ kind: 'edge', status: 'endpoint_missing', item: edge, message: `终点 ${edge.target} 不在当前草稿或建议中` });
      return;
    }
    items.push({ kind: 'edge', status: 'new', item: edge });
  });

  return items;
}

/**
 * 应用已确认候选到基础文档（返回新文档；不改动输入）：
 *   merge 节点：补全空字段，典型表达/边界数组去重追加，不覆盖已有非空值
 *   new 节点：加入草稿；冲突节点不自动写入
 *   new 边：仅在两端节点确实存在且未重复时加入
 */
export function applyCandidates(base: GraphDocument, accepted: CandidateItem[]): GraphDocument {
  const nodes = base.nodes.map((n) => ({ ...n, properties: { ...n.properties } }));
  const edges = base.edges.map((e) => ({ ...e, properties: { ...e.properties } }));
  const nodeIndex: Record<string, GraphNode> = {};
  nodes.forEach((n) => { nodeIndex[n.id] = n; });

  const ADDITIVE_FIELDS = new Set(['utterance_view', 'scope_in', 'scope_out', 'object_view', 'action_view', 'negative_view', 'disambiguation_hints']);
  accepted.filter((candidate) => candidate.kind === 'node').forEach((candidate) => {
    const item = candidate.item;
      if (candidate.status === 'merge' && candidate.existingId && nodeIndex[candidate.existingId]) {
        const existing = nodeIndex[candidate.existingId];
        const src = item as GraphNode;
        Object.keys(src.properties || {}).forEach((k) => {
          if (ADDITIVE_FIELDS.has(k) && Array.isArray(existing.properties[k]) && Array.isArray(src.properties[k])) {
            const oldArr = existing.properties[k] as unknown[];
            const newItems = (src.properties[k] as unknown[]).filter(
              (item2) => !oldArr.some((exist) => JSON.stringify(exist) === JSON.stringify(item2)),
            );
            if (newItems.length > 0) {
              const startIdx = oldArr.length;
              existing.properties[k] = [...oldArr, ...newItems];
              /* 在 raw._aiPatch 记录 AI 追加的数组索引，供 UI 标记 */
              const rawObj = (existing.raw || {}) as Record<string, unknown>;
              const patch = rawObj._aiPatch as Record<string, number[]> | undefined;
              rawObj._aiPatch = { ...(patch || {}), [k]: [...(patch?.[k] || []), ...newItems.map((_, i) => startIdx + i)] };
              existing.raw = rawObj;
            }
            return;
          }
          if (existing.properties[k] === undefined || existing.properties[k] === null || existing.properties[k] === '') {
            existing.properties[k] = src.properties[k];
            /* 标量字段也记录 AI 补全 */
            if (ADDITIVE_FIELDS.has(k)) {
              const rawObj2 = (existing.raw || {}) as Record<string, unknown>;
              const patch2 = rawObj2._aiPatch as Record<string, unknown> | undefined;
              rawObj2._aiPatch = { ...(patch2 || {}), [k]: true };
              existing.raw = rawObj2;
            }
          }
        });
        existing.review_status = 'merged';
      } else if (candidate.status === 'new' && !nodeIndex[(item as GraphNode).id]) {
        const src = item as GraphNode;
        const copy: GraphNode = { ...src, properties: { ...src.properties }, review_status: 'accepted' };
        /* 新增节点的全部数组字段标记为 AI 生成 */
        const aiPatch: Record<string, unknown> = {};
        ADDITIVE_FIELDS.forEach((f) => {
          if (Array.isArray(copy.properties[f])) {
            aiPatch[f] = Array.from({ length: (copy.properties[f] as unknown[]).length }, (_, i) => i);
          }
        });
        if (Object.keys(aiPatch).length > 0) {
          copy.raw = { ...(copy.raw || {}), _aiPatch: aiPatch };
        }
        nodes.push(copy);
        nodeIndex[copy.id] = copy;
      }
  });

  const edgeTriples = new Set(edges.map((edge) => `${edge.source}|${edge.target}|${edge.type}`));
  const edgeIds = new Set(edges.map((edge) => edge.id));
  accepted.filter((candidate) => candidate.kind === 'edge' && candidate.status === 'new').forEach((candidate) => {
    const src = candidate.item as GraphEdge;
    const triple = `${src.source}|${src.target}|${src.type}`;
    if (!nodeIndex[src.source] || !nodeIndex[src.target] || edgeTriples.has(triple) || edgeIds.has(src.id)) return;
    edges.push({ ...src, properties: { ...src.properties }, review_status: 'accepted' });
    edgeTriples.add(triple);
    edgeIds.add(src.id);
  });

  return { ...base, nodes, edges };
}
