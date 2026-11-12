/**
 * 图谱版本 diff 纯函数
 *
 * 对比两个 GraphDocument，输出节点/边的增删改明细。
 * 无副作用，可在任何上下文中直接调用。
 */
import type { GraphDocument, GraphNode, GraphEdge } from '@/api/orgGraph';

export type DiffChangeKind = 'added' | 'removed' | 'modified';

export interface NodeDiffEntry {
  kind: DiffChangeKind;
  id: string;
  type?: string;
  label?: string;
  /** modified 时的变更字段（旧值 → 新值） */
  changes?: { field: string; oldValue: unknown; newValue: unknown }[];
}

export interface EdgeDiffEntry {
  kind: DiffChangeKind;
  id: string;
  type?: string;
  source?: string;
  target?: string;
  changes?: { field: string; oldValue: unknown; newValue: unknown }[];
}

export interface GraphDiffResult {
  /** 基线版本标识 */
  baselineLabel: string;
  /** 目标版本标识 */
  targetLabel: string;
  nodes: NodeDiffEntry[];
  edges: EdgeDiffEntry[];
  /** 汇总统计 */
  stats: {
    nodesAdded: number;
    nodesRemoved: number;
    nodesModified: number;
    edgesAdded: number;
    edgesRemoved: number;
    edgesModified: number;
  };
}

/** 节点显示标签 */
function nodeLabel(n: GraphNode): string {
  return String(n.properties?.name || n.properties?.title || n.id);
}

/** 边显示标签 */
function edgeLabel(e: GraphEdge): string {
  return String(e.type || e.id);
}

/** 比较两个节点的属性，返回变更字段列表 */
function compareNodeProperties(
  oldNode: GraphNode,
  newNode: GraphNode,
): { field: string; oldValue: unknown; newValue: unknown }[] {
  const changes: { field: string; oldValue: unknown; newValue: unknown }[] = [];
  const allKeys = new Set([
    ...Object.keys(oldNode.properties || {}),
    ...Object.keys(newNode.properties || {}),
  ]);
  // 也检查 type 变更
  if (oldNode.type !== newNode.type) {
    changes.push({ field: '_type', oldValue: oldNode.type, newValue: newNode.type });
  }
  for (const key of allKeys) {
    const oldVal = oldNode.properties?.[key];
    const newVal = newNode.properties?.[key];
    if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
      changes.push({ field: key, oldValue: oldVal, newValue: newVal });
    }
  }
  return changes;
}

/** 比较两条边的属性，返回变更字段列表 */
function compareEdgeProperties(
  oldEdge: GraphEdge,
  newEdge: GraphEdge,
): { field: string; oldValue: unknown; newValue: unknown }[] {
  const changes: { field: string; oldValue: unknown; newValue: unknown }[] = [];
  if (oldEdge.type !== newEdge.type) {
    changes.push({ field: '_type', oldValue: oldEdge.type, newValue: newEdge.type });
  }
  if (oldEdge.source !== newEdge.source) {
    changes.push({ field: '_source', oldValue: oldEdge.source, newValue: newEdge.source });
  }
  if (oldEdge.target !== newEdge.target) {
    changes.push({ field: '_target', oldValue: oldEdge.target, newValue: newEdge.target });
  }
  const allKeys = new Set([
    ...Object.keys(oldEdge.properties || {}),
    ...Object.keys(newEdge.properties || {}),
  ]);
  for (const key of allKeys) {
    const oldVal = oldEdge.properties?.[key];
    const newVal = newEdge.properties?.[key];
    if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
      changes.push({ field: key, oldValue: oldVal, newValue: newVal });
    }
  }
  return changes;
}

/**
 * 计算两个 GraphDocument 的 diff
 * @param baseline 基线文档（旧版本）
 * @param target 目标文档（新版本）
 * @param baselineLabel 基线版本标签（如 "v1.0.0" / "草稿"）
 * @param targetLabel 目标版本标签
 */
export function diffGraphDocuments(
  baseline: GraphDocument,
  target: GraphDocument,
  baselineLabel: string,
  targetLabel: string,
): GraphDiffResult {
  const oldNodes = new Map<string, GraphNode>(baseline.nodes.map((n) => [n.id, n]));
  const newNodes = new Map<string, GraphNode>(target.nodes.map((n) => [n.id, n]));
  const oldEdges = new Map<string, GraphEdge>(baseline.edges.map((e) => [e.id, e]));
  const newEdges = new Map<string, GraphEdge>(target.edges.map((e) => [e.id, e]));

  const nodeEntries: NodeDiffEntry[] = [];
  const edgeEntries: EdgeDiffEntry[] = [];

  let nodesAdded = 0, nodesRemoved = 0, nodesModified = 0;
  let edgesAdded = 0, edgesRemoved = 0, edgesModified = 0;

  // 节点 diff
  for (const [id, newNode] of newNodes) {
    const oldNode = oldNodes.get(id);
    if (!oldNode) {
      nodeEntries.push({ kind: 'added', id, type: newNode.type, label: nodeLabel(newNode) });
      nodesAdded++;
    } else {
      const changes = compareNodeProperties(oldNode, newNode);
      if (changes.length > 0) {
        nodeEntries.push({ kind: 'modified', id, type: newNode.type, label: nodeLabel(newNode), changes });
        nodesModified++;
      }
    }
  }
  for (const [id, oldNode] of oldNodes) {
    if (!newNodes.has(id)) {
      nodeEntries.push({ kind: 'removed', id, type: oldNode.type, label: nodeLabel(oldNode) });
      nodesRemoved++;
    }
  }

  // 边 diff
  for (const [id, newEdge] of newEdges) {
    const oldEdge = oldEdges.get(id);
    if (!oldEdge) {
      edgeEntries.push({ kind: 'added', id, type: newEdge.type, source: newEdge.source, target: newEdge.target });
      edgesAdded++;
    } else {
      const changes = compareEdgeProperties(oldEdge, newEdge);
      if (changes.length > 0) {
        edgeEntries.push({ kind: 'modified', id, type: newEdge.type, source: newEdge.source, target: newEdge.target, changes });
        edgesModified++;
      }
    }
  }
  for (const [id, oldEdge] of oldEdges) {
    if (!newEdges.has(id)) {
      edgeEntries.push({ kind: 'removed', id, type: oldEdge.type, source: oldEdge.source, target: oldEdge.target });
      edgesRemoved++;
    }
  }

  return {
    baselineLabel,
    targetLabel,
    nodes: nodeEntries,
    edges: edgeEntries,
    stats: { nodesAdded, nodesRemoved, nodesModified, edgesAdded, edgesRemoved, edgesModified },
  };
}
