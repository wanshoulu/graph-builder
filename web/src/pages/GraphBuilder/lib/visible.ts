/**
 * 组织树折叠浏览模式（纯函数，可单测）
 *
 * 模式目标：173 节点 + 350 边全量平铺 = 糊成一团乱麻。
 * 组织图软件的标准解法是分层折叠：默认只显示顶层几层，
 * 有下级的节点显示「⊕ 后代数」徽标，逐级展开才深入。
 */
import type { CanvasEdge, CanvasNode } from './graphDoc';

/** 每个有子节点的后代数（不含自身；环防御） */
export function subtreeSizes(childrenOf: Map<string, string[]>): Map<string, number> {
  const size = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (id: string): number => {
    if (size.has(id)) return size.get(id)!;
    if (visiting.has(id)) return 0; // 环
    visiting.add(id);
    let total = 0;
    (childrenOf.get(id) || []).forEach((k) => { total += 1 + visit(k); });
    visiting.delete(id);
    size.set(id, total);
    return total;
  };
  childrenOf.forEach((_, id) => visit(id));
  return size;
}

/** 可见节点集合：从根遍历，collapsed 节点不进其子树；非树节点始终可见 */
export function visibleNodeIds(
  nodes: CanvasNode[],
  childrenOf: Map<string, string[]>,
  collapsed: Set<string>,
): Set<string> {
  const hasParent = new Set<string>();
  childrenOf.forEach((kids) => kids.forEach((k) => hasParent.add(k)));
  const visible = new Set<string>();
  const queue: string[] = [];
  nodes.forEach((n) => {
    if (childrenOf.has(n.id) && !hasParent.has(n.id) && !visible.has(n.id)) {
      visible.add(n.id);
      queue.push(n.id);
    }
  });
  while (queue.length) {
    const id = queue.shift()!;
    if (!collapsed.has(id)) {
      (childrenOf.get(id) || []).forEach((kid) => {
        if (!visible.has(kid)) {
          visible.add(kid);
          queue.push(kid);
        }
      });
    }
  }
  return visible;
}

/** 树骨架节点集合（childrenOf 中出现的所有节点 id） */
export function treeNodeIdSet(childrenOf: Map<string, string[]>): Set<string> {
  const s = new Set<string>();
  childrenOf.forEach((kids, parent) => { s.add(parent); kids.forEach((k) => s.add(k)); });
  return s;
}

/** 树骨架深度表（根=0，BFS 环防御）。节点按层级分尺寸、领域根标记使用 */
export function treeDepths(childrenOf: Map<string, string[]>): Map<string, number> {
  const hasParent = new Set<string>();
  childrenOf.forEach((kids) => kids.forEach((k) => hasParent.add(k)));
  const depth = new Map<string, number>();
  const queue: [string, number][] = [];
  childrenOf.forEach((_, id) => {
    if (!hasParent.has(id) && !depth.has(id)) { depth.set(id, 0); queue.push([id, 0]); }
  });
  while (queue.length) {
    const [id, d] = queue.shift()!;
    (childrenOf.get(id) || []).forEach((k) => {
      if (!depth.has(k)) { depth.set(k, d + 1); queue.push([k, d + 1]); }
    });
  }
  return depth;
}

/** 图层分组：支撑节点按类型归入 对象 / 约束·答案 两个显示图层；层级树节点不属于任何图层 */
export type LayerGroup = 'objects' | 'constraints';
const CONSTRAINT_TYPES = ['SLOT', 'STATE', 'RISK', 'ACTION', 'KNOWLEDGE_ANSWER', 'RUNTIME_BOUNDARY'];
export function layerGroupOf(nodeType: string): LayerGroup | null {
  if (nodeType === 'BUSINESS_OBJECT') return 'objects';
  if (CONSTRAINT_TYPES.indexOf(nodeType) >= 0) return 'constraints';
  return null;
}

/** 图层过滤：树节点恒显；被隐藏图层内的支撑节点及其边裁掉（意图图谱 851 边瘦身核心） */
export function filterLayerGraph(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  treeNodeIds: Set<string>,
  hiddenLayers: Set<LayerGroup>,
): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const kept = nodes.filter((n) => {
    if (treeNodeIds.has(n.id)) return true;
    const g = layerGroupOf(String(n.data.nodeType || ''));
    return g === null || !hiddenLayers.has(g);
  });
  const keptIds = new Set(kept.map((n) => n.id));
  return { nodes: kept, edges: edges.filter((e) => keptIds.has(e.source) && keptIds.has(e.target)) };
}

/** 可见子图：树内节点按折叠遍历；非树节点（支撑节点）只在有可见边连接时可见，迭代收敛；
 *  无任何边的孤立非树节点保持可见（手动新增节点即时显示） */
export function computeVisibleGraph(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  childrenOf: Map<string, string[]>,
  collapsed: Set<string>,
): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  // 完全展开（无折叠）→ 全部可见，跳过树遍历和连通传播
  // 修复：非树节点若只互相连接（不连任何树节点），连通传播无法触达它们，导致"完全展开"时节点数对不上
  if (collapsed.size === 0) {
    return { nodes, edges };
  }
  const visible = visibleNodeIds(nodes, childrenOf, collapsed);
  // 树内节点集合（有子树或挂在树上）——连通传播只加树外支撑节点，
  // 否则折叠的树边（如 has_leaf_intent）会把隐藏的子树又拉回可见
  const treeNodeIds = treeNodeIdSet(childrenOf);
  // 连通传播：有边连到可见节点的树外节点 → 可见（支撑节点随所属意图折叠/展开）
  let changed = true;
  while (changed) {
    changed = false;
    edges.forEach((e) => {
      if (visible.has(e.source) && !visible.has(e.target) && !treeNodeIds.has(e.target)) {
        visible.add(e.target);
        changed = true;
      } else if (visible.has(e.target) && !visible.has(e.source) && !treeNodeIds.has(e.source)) {
        visible.add(e.source);
        changed = true;
      }
    });
  }
  // 孤立非树节点（无任何边）保持可见
  const hasAnyEdge = new Set<string>();
  edges.forEach((e) => { hasAnyEdge.add(e.source); hasAnyEdge.add(e.target); });
  nodes.forEach((n) => {
    if (!visible.has(n.id) && !treeNodeIds.has(n.id) && !hasAnyEdge.has(n.id)) visible.add(n.id);
  });
  return {
    nodes: nodes.filter((n) => visible.has(n.id)),
    edges: edges.filter((e) => visible.has(e.source) && visible.has(e.target)),
  };
}

/**
 * 展开折叠后给"无坐标"的新出现节点做增量放置：有树父的排在父节点右侧环形，无父的排原点环形。
 * 避免展开时新节点全部叠在 (0,0)。
 */
export function placeUnpositionedNodes(
  nodes: CanvasNode[],
  childrenOf: Map<string, string[]>,
  parentsOf: Map<string, string>,
): CanvasNode[] {
  const parentPos = new Map<string, { x: number; y: number }>();
  nodes.forEach((n) => {
    if (n.position.x !== 0 || n.position.y !== 0) parentPos.set(n.id, n.position);
  });
  const placedCount = new Map<string, number>();
  return nodes.map((n, i) => {
    if (n.position.x !== 0 || n.position.y !== 0) return n;
    const parent = parentsOf.get(n.id);
    const base = parent ? parentPos.get(parent) : undefined;
    if (base && parent) {
      const k = placedCount.get(parent) || 0;
      placedCount.set(parent, k + 1);
      const angle = 0.6 + k * 0.9;
      return { ...n, position: { x: Math.round(base.x + 190 + 130 * Math.cos(angle)), y: Math.round(base.y + 130 * Math.sin(angle)) } };
    }
    const angle = (2 * Math.PI * i) / Math.max(1, nodes.length);
    return { ...n, position: { x: Math.round(420 * Math.cos(angle)), y: Math.round(320 * Math.sin(angle)) } };
  });
}

/** 初始折叠集合：深度 >= maxDepth 且有子树的节点折叠（根深度 0） */
export function initialCollapsedSet(
  nodes: CanvasNode[],
  childrenOf: Map<string, string[]>,
  maxDepth: number,
): Set<string> {
  const hasParent = new Set<string>();
  childrenOf.forEach((kids) => kids.forEach((k) => hasParent.add(k)));
  const depth = new Map<string, number>();
  const queue: [string, number][] = [];
  nodes.forEach((n) => {
    if (childrenOf.has(n.id) && !hasParent.has(n.id) && !depth.has(n.id)) {
      depth.set(n.id, 0);
      queue.push([n.id, 0]);
    }
  });
  while (queue.length) {
    const [id, d] = queue.shift()!;
    (childrenOf.get(id) || []).forEach((kid) => {
      if (!depth.has(kid)) {
        depth.set(kid, d + 1);
        queue.push([kid, d + 1]);
      }
    });
  }
  const collapsed = new Set<string>();
  depth.forEach((d, id) => {
    if (d >= maxDepth && (childrenOf.get(id) || []).length > 0) collapsed.add(id);
  });
  return collapsed;
}

/** Keep a large graph readable while preserving its first two useful hierarchy levels. */
export function initialCollapseDepth(
  totalNodes: number,
  configuredDepth: number,
  largeGraphThreshold = 120,
): number {
  const safeDepth = Math.max(0, Math.floor(configuredDepth));
  // 模板显式要求展开（>=99）时不做默认折叠压制——用户要全量视图，
  // 折叠仍可经「视图 → 折叠全部」或右键「折叠子树」手动触发。
  if (safeDepth >= 99) return safeDepth;
  return totalNodes > largeGraphThreshold ? Math.min(safeDepth, 2) : safeDepth;
}
