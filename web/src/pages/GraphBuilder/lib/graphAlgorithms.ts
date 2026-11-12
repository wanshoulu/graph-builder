/**
 * 图算法库（纯函数，无副作用，无外部依赖）
 *
 * 提供知识图谱分析能力：最短路径、联通子图、社区发现、中心性、环路检测等。
 * 对标 Neo4j GDS / Cytoscape.js 内置图算法，补齐图分析能力。
 */
import type { CanvasNode, CanvasEdge } from './graphDoc';

// ── 内部工具 ──

/** 从边数据中提取权重（优先 data.weight，其次 data.confidence，默认 1） */
function edgeWeight(edge: CanvasEdge): number {
  const w = edge.data.weight;
  if (typeof w === 'number' && w > 0) return w;
  const c = edge.data.confidence;
  if (typeof c === 'number' && c > 0) return c;
  return 1;
}

/** 构建有向邻接表（节点 id → 出边目标列表） */
function buildDirectedAdj(
  nodeIds: string[],
  edges: CanvasEdge[],
): Map<string, string[]> {
  const idSet = new Set(nodeIds);
  const adj = new Map<string, string[]>();
  nodeIds.forEach((id) => adj.set(id, []));
  edges.forEach((e) => {
    if (idSet.has(e.source) && idSet.has(e.target)) {
      adj.get(e.source)!.push(e.target);
    }
  });
  return adj;
}

/** 构建无向邻接表（双向，用 Set 去重自环/平行边） */
function buildUndirectedAdj(
  nodeIds: string[],
  edges: CanvasEdge[],
): Map<string, Set<string>> {
  const idSet = new Set(nodeIds);
  const adj = new Map<string, Set<string>>();
  nodeIds.forEach((id) => adj.set(id, new Set()));
  edges.forEach((e) => {
    if (idSet.has(e.source) && idSet.has(e.target) && e.source !== e.target) {
      adj.get(e.source)!.add(e.target);
      adj.get(e.target)!.add(e.source);
    }
  });
  return adj;
}

/** 简单二叉最小堆（用于 Dijkstra；纯 TS 实现，无外部依赖） */
class MinHeap {
  private items: { priority: number; value: string }[] = [];

  get size(): number { return this.items.length; }

  push(value: string, priority: number): void {
    this.items.push({ priority, value });
    this.bubbleUp(this.items.length - 1);
  }

  pop(): { priority: number; value: string } | null {
    if (this.items.length === 0) return null;
    const top = this.items[0];
    const last = this.items.pop()!;
    if (this.items.length > 0) {
      this.items[0] = last;
      this.bubbleDown(0);
    }
    return top;
  }

  private bubbleUp(idx: number): void {
    while (idx > 0) {
      const parent = (idx - 1) >> 1;
      if (this.items[idx].priority >= this.items[parent].priority) break;
      [this.items[idx], this.items[parent]] = [this.items[parent], this.items[idx]];
      idx = parent;
    }
  }

  private bubbleDown(idx: number): void {
    const n = this.items.length;
    while (true) {
      let smallest = idx;
      const left = 2 * idx + 1;
      const right = 2 * idx + 2;
      if (left < n && this.items[left].priority < this.items[smallest].priority) smallest = left;
      if (right < n && this.items[right].priority < this.items[smallest].priority) smallest = right;
      if (smallest === idx) break;
      [this.items[idx], this.items[smallest]] = [this.items[smallest], this.items[idx]];
      idx = smallest;
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// 1. 最短路径
// ═══════════════════════════════════════════════════════════════

export interface ShortestPathResult {
  /** 起点到终点的最短路径节点序列；不存在时为 null */
  path: string[] | null;
  /** 路径总权重（无权 BFS 为跳数） */
  distance: number;
  /** 起点到终点是否存在可达路径 */
  reachable: boolean;
}

/**
 * BFS 无权图最短路径（按跳数最少）
 *
 * 原理：广度优先搜索逐层扩展，首次到达终点即为最短跳数路径。
 *   用队列维护待访问节点，parent 表记录前驱以便回溯路径。
 * 复杂度：O(V + E)，V=节点数，E=边数。
 *
 * @param nodes 节点列表
 * @param edges 边列表（有向）
 * @param source 起点节点 id
 * @param target 终点节点 id
 * @returns 最短路径结果
 */
export function bfsShortestPath(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  source: string,
  target: string,
): ShortestPathResult {
  const nodeIds = nodes.map((n) => n.id);
  const idSet = new Set(nodeIds);
  if (!idSet.has(source) || !idSet.has(target)) {
    return { path: null, distance: -1, reachable: false };
  }
  if (source === target) return { path: [source], distance: 0, reachable: true };

  const adj = buildDirectedAdj(nodeIds, edges);
  const visited = new Set<string>([source]);
  const parent = new Map<string, string>();
  const queue: string[] = [source];
  let head = 0;

  while (head < queue.length) {
    const cur = queue[head++];
    const neighbors = adj.get(cur) || [];
    for (const nb of neighbors) {
      if (visited.has(nb)) continue;
      visited.add(nb);
      parent.set(nb, cur);
      if (nb === target) {
        const path: string[] = [target];
        let p = target;
        while (parent.has(p)) {
          p = parent.get(p)!;
          path.unshift(p);
        }
        return { path, distance: path.length - 1, reachable: true };
      }
      queue.push(nb);
    }
  }
  return { path: null, distance: -1, reachable: false };
}

/**
 * Dijkstra 加权最短路径
 *
 * 原理：基于最小堆的贪心搜索，逐步松弛所有可达节点的最短距离。
 *   权重取 edge.data.weight（缺失取 data.confidence，再缺失取 1），不支持负权边。
 * 复杂度：O((V + E) log V)
 *
 * @param nodes 节点列表
 * @param edges 边列表（有向）
 * @param source 起点节点 id
 * @param target 终点节点 id
 * @returns 加权最短路径结果
 */
export function dijkstraShortestPath(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  source: string,
  target: string,
): ShortestPathResult {
  const nodeIds = nodes.map((n) => n.id);
  const idSet = new Set(nodeIds);
  if (!idSet.has(source) || !idSet.has(target)) {
    return { path: null, distance: -1, reachable: false };
  }
  if (source === target) return { path: [source], distance: 0, reachable: true };

  const idSetAdj = idSet;
  const adj = new Map<string, { target: string; weight: number }[]>();
  nodeIds.forEach((id) => adj.set(id, []));
  edges.forEach((e) => {
    if (idSetAdj.has(e.source) && idSetAdj.has(e.target)) {
      adj.get(e.source)!.push({ target: e.target, weight: edgeWeight(e) });
    }
  });

  const dist = new Map<string, number>();
  nodeIds.forEach((id) => dist.set(id, Infinity));
  dist.set(source, 0);
  const parent = new Map<string, string>();
  const visited = new Set<string>();
  const heap = new MinHeap();
  heap.push(source, 0);

  while (heap.size > 0) {
    const top = heap.pop()!;
    const cur = top.value;
    if (visited.has(cur)) continue;
    visited.add(cur);
    if (cur === target) break;

    const neighbors = adj.get(cur) || [];
    for (const { target: nb, weight } of neighbors) {
      if (visited.has(nb)) continue;
      const newDist = dist.get(cur)! + weight;
      if (newDist < (dist.get(nb) ?? Infinity)) {
        dist.set(nb, newDist);
        parent.set(nb, cur);
        heap.push(nb, newDist);
      }
    }
  }

  const targetDist = dist.get(target);
  if (targetDist === undefined || targetDist === Infinity) {
    return { path: null, distance: -1, reachable: false };
  }

  const path: string[] = [target];
  let p = target;
  while (parent.has(p)) {
    p = parent.get(p)!;
    path.unshift(p);
  }
  return { path, distance: targetDist, reachable: true };
}

// ═══════════════════════════════════════════════════════════════
// 2. 所有路径
// ═══════════════════════════════════════════════════════════════

export interface AllPathsResult {
  /** 所有简单路径（不含重复节点的路径），上限 maxPaths 条 */
  paths: string[][];
  /** 是否因达到上限而截断 */
  truncated: boolean;
}

/**
 * 查找两个节点间所有简单路径（DFS 回溯）
 *
 * 原理：从起点深度优先搜索，维护当前路径与已访问集合，到达终点时记录路径。
 *   简单路径不经过重复节点，避免无限循环。结果上限 maxPaths 条防止指数爆炸。
 * 复杂度：最坏 O(V!)（完全图），实际知识图谱稀疏，通常可控。
 *
 * @param nodes 节点列表
 * @param edges 边列表（有向）
 * @param source 起点节点 id
 * @param target 终点节点 id
 * @param maxPaths 最大返回路径数，默认 10
 * @returns 所有简单路径
 */
export function findAllPaths(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  source: string,
  target: string,
  maxPaths = 10,
): AllPathsResult {
  const nodeIds = nodes.map((n) => n.id);
  const idSet = new Set(nodeIds);
  if (!idSet.has(source) || !idSet.has(target)) {
    return { paths: [], truncated: false };
  }

  const adj = buildDirectedAdj(nodeIds, edges);
  const paths: string[][] = [];
  const currentPath: string[] = [source];
  const visited = new Set<string>([source]);
  let truncated = false;

  function dfs(node: string): void {
    if (paths.length >= maxPaths) { truncated = true; return; }
    if (node === target) {
      paths.push([...currentPath]);
      return;
    }
    const neighbors = adj.get(node) || [];
    for (const nb of neighbors) {
      if (visited.has(nb)) continue;
      visited.add(nb);
      currentPath.push(nb);
      dfs(nb);
      currentPath.pop();
      visited.delete(nb);
      if (truncated) return;
    }
  }

  dfs(source);
  return { paths, truncated };
}

// ═══════════════════════════════════════════════════════════════
// 3. 联通子图（并查集）
// ═══════════════════════════════════════════════════════════════

export interface ConnectedComponent {
  /** 连通分量内的节点 id 列表 */
  nodeIds: string[];
  /** 分量大小 */
  size: number;
}

export interface ConnectedComponentsResult {
  /** 所有连通分量（按大小降序） */
  components: ConnectedComponent[];
  /** 分量总数 */
  count: number;
  /** 最大分量大小 */
  largestSize: number;
}

/**
 * 并查集识别所有连通分量（无向图）
 *
 * 原理：将每条边视为无向连接，用并查集合并两端节点所属集合，
 *   最终同一根的节点属于同一连通分量。路径压缩 + 按秩合并保证近线性复杂度。
 * 复杂度：O(V + E · α(V))，α 为反阿克曼函数，实际 ≈ 常数。
 *
 * @param nodes 节点列表
 * @param edges 边列表（按无向处理）
 * @returns 连通分量列表
 */
export function findConnectedComponents(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
): ConnectedComponentsResult {
  const nodeIds = nodes.map((n) => n.id);
  const idSet = new Set(nodeIds);

  // 并查集
  const parent = new Map<string, string>();
  const rank = new Map<string, number>();
  nodeIds.forEach((id) => { parent.set(id, id); rank.set(id, 0); });

  function find(x: string): string {
    let root = x;
    while (parent.get(root) !== root) {
      root = parent.get(root)!;
    }
    // 路径压缩
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  function union(a: string, b: string): void {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    const raRank = rank.get(ra) || 0;
    const rbRank = rank.get(rb) || 0;
    if (raRank < rbRank) {
      parent.set(ra, rb);
    } else if (raRank > rbRank) {
      parent.set(rb, ra);
    } else {
      parent.set(rb, ra);
      rank.set(ra, raRank + 1);
    }
  }

  edges.forEach((e) => {
    if (idSet.has(e.source) && idSet.has(e.target)) {
      union(e.source, e.target);
    }
  });

  // 按 root 分组
  const groups = new Map<string, string[]>();
  nodeIds.forEach((id) => {
    const root = find(id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(id);
  });

  const components: ConnectedComponent[] = Array.from(groups.values()).map((ids) => ({
    nodeIds: ids,
    size: ids.length,
  }));
  components.sort((a, b) => b.size - a.size);

  return {
    components,
    count: components.length,
    largestSize: components.length > 0 ? components[0].size : 0,
  };
}

// ═══════════════════════════════════════════════════════════════
// 4. 社区发现（标签传播算法 LPA）
// ═══════════════════════════════════════════════════════════════

export interface Community {
  /** 社区编号（从 0 开始） */
  communityId: number;
  /** 社区内的节点 id 列表 */
  nodeIds: string[];
  /** 社区大小 */
  size: number;
}

export interface CommunityDetectionResult {
  /** 所有社区（按大小降序） */
  communities: Community[];
  /** 社区总数 */
  count: number;
  /** 模块度 Q 值，范围 [-0.5, 1]，越高社区结构越明显 */
  modularity: number;
}

/**
 * 标签传播社区发现（Label Propagation Algorithm，LPA）
 *
 * 原理：每个节点初始化为独立标签，迭代时异步更新为邻居中出现频率最高的标签
 *   （同频取最小编号保证确定性）。收敛后标签相同的节点属于同一社区。
 *   LPA 是 Louvain 的快速近似，适合知识图谱规模。
 * 复杂度：O(E) 每轮迭代，通常 5-10 轮收敛。
 *
 * 模块度 Q = Σ_c [L_c/m - (D_c/2m)²]，L_c 为社区内部边数，D_c 为社区节点度数之和。
 *
 * @param nodes 节点列表
 * @param edges 边列表（按无向处理）
 * @param maxIterations 最大迭代次数，默认 20
 * @returns 社区检测结果
 */
export function detectCommunities(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  maxIterations = 20,
): CommunityDetectionResult {
  const nodeIds = nodes.map((n) => n.id);
  const idSet = new Set(nodeIds);

  // 无向邻接表
  const adj = buildUndirectedAdj(nodeIds, edges);

  // 初始标签：每个节点唯一
  const label = new Map<string, number>();
  nodeIds.forEach((id, i) => label.set(id, i));

  // 异步迭代
  let changed = true;
  let iter = 0;
  while (changed && iter < maxIterations) {
    changed = false;
    iter++;
    for (const id of nodeIds) {
      const neighbors = adj.get(id)!;
      if (neighbors.size === 0) continue;
      // 统计邻居标签频次
      const freq = new Map<number, number>();
      for (const nb of neighbors) {
        const l = label.get(nb)!;
        freq.set(l, (freq.get(l) || 0) + 1);
      }
      // 取最高频标签（同频取最小编号保证确定性）
      const sorted = Array.from(freq.entries()).sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        return a[0] - b[0];
      });
      const bestLabel = sorted[0][0];
      if (bestLabel !== label.get(id)) {
        label.set(id, bestLabel);
        changed = true;
      }
    }
  }

  // 收集社区
  const groups = new Map<number, string[]>();
  nodeIds.forEach((id) => {
    const l = label.get(id)!;
    if (!groups.has(l)) groups.set(l, []);
    groups.get(l)!.push(id);
  });

  // 重新编号（从 0 开始连续）
  const labels = Array.from(groups.keys()).sort((a, b) => a - b);
  const remap = new Map<number, number>();
  labels.forEach((l, i) => remap.set(l, i));

  const communities: Community[] = labels.map((l) => {
    const ids = groups.get(l)!;
    return { communityId: remap.get(l)!, nodeIds: ids, size: ids.length };
  });
  communities.sort((a, b) => b.size - a.size);

  // 模块度计算 Q = Σ_c [L_c/m - (D_c/2m)²]
  const validEdges = edges.filter(
    (e) => idSet.has(e.source) && idSet.has(e.target) && e.source !== e.target,
  );
  const m = validEdges.length;
  let modularity = 0;
  if (m > 0) {
    const degree = new Map<string, number>();
    nodeIds.forEach((id) => degree.set(id, 0));
    validEdges.forEach((e) => {
      degree.set(e.source, (degree.get(e.source) || 0) + 1);
      degree.set(e.target, (degree.get(e.target) || 0) + 1);
    });

    const commInternalEdges = new Map<number, number>();
    const commDegree = new Map<number, number>();
    nodeIds.forEach((id) => {
      const c = remap.get(label.get(id)!)!;
      commDegree.set(c, (commDegree.get(c) || 0) + (degree.get(id) || 0));
      if (!commInternalEdges.has(c)) commInternalEdges.set(c, 0);
    });
    validEdges.forEach((e) => {
      const cs = remap.get(label.get(e.source)!)!;
      const ct = remap.get(label.get(e.target)!)!;
      if (cs === ct) {
        commInternalEdges.set(cs, (commInternalEdges.get(cs) || 0) + 1);
      }
    });

    for (const c of commDegree.keys()) {
      const lc = commInternalEdges.get(c) || 0;
      const dc = commDegree.get(c) || 0;
      modularity += lc / m - Math.pow(dc / (2 * m), 2);
    }
  }

  return { communities, count: communities.length, modularity };
}

// ═══════════════════════════════════════════════════════════════
// 5. 中心性分析
// ═══════════════════════════════════════════════════════════════

export interface CentralityResult {
  /** 度中心性：节点度数 / (n-1)，范围 [0, 1] */
  degreeCentrality: Map<string, number>;
  /** 接近中心性：(n-1) / Σ d(v,u)，范围 (0, 1]，采用 Wasserman-Faust 归一化处理非连通图 */
  closenessCentrality: Map<string, number>;
  /** 介数中心性（Brandes 算法）：经过该节点的最短路径比例，范围 [0, 1] */
  betweennessCentrality: Map<string, number>;
}

/**
 * 三大中心性计算（度中心性 / 接近中心性 / 介数中心性）
 *
 * 原理：
 *   - 度中心性：节点连接数占全网可能连接数的比例
 *   - 接近中心性：节点到其他所有节点最短路径长度倒数的归一化
 *   - 介数中心性（Brandes 算法）：对每个源节点 BFS，记录最短路径数和前驱，
 *     再按距离降序累积依赖值 δ，得到每个节点被多少条最短路径经过
 * 复杂度：
 *   - 度中心性：O(E)
 *   - 接近中心性 + 介数中心性：O(V · (V + E))（Brandes 统一轮询）
 *
 * @param nodes 节点列表
 * @param edges 边列表（按无向处理）
 * @returns 中心性分析结果
 */
export function computeCentrality(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
): CentralityResult {
  const nodeIds = nodes.map((n) => n.id);
  const n = nodeIds.length;
  const adj = buildUndirectedAdj(nodeIds, edges);

  const degreeCentrality = new Map<string, number>();
  const closenessCentrality = new Map<string, number>();
  const betweennessCentrality = new Map<string, number>();
  nodeIds.forEach((id) => {
    degreeCentrality.set(id, 0);
    closenessCentrality.set(id, 0);
    betweennessCentrality.set(id, 0);
  });

  // 度中心性
  nodeIds.forEach((id) => {
    const deg = (adj.get(id) || new Set()).size;
    degreeCentrality.set(id, n > 1 ? deg / (n - 1) : 0);
  });

  // Brandes 算法：每轮 BFS 同时计算接近中心性和介数中心性
  for (const s of nodeIds) {
    // ── BFS from s ──
    const dist = new Map<string, number>();
    const sigma = new Map<string, number>(); // 最短路径条数
    const pred = new Map<string, string[]>();  // 前驱列表
    nodeIds.forEach((id) => { dist.set(id, -1); sigma.set(id, 0); pred.set(id, []); });
    dist.set(s, 0);
    sigma.set(s, 1);
    const queue: string[] = [s];
    let head = 0;
    const visitedOrder: string[] = []; // BFS 访问顺序（用于反向累积）

    while (head < queue.length) {
      const cur = queue[head++];
      visitedOrder.push(cur);
      const neighbors = adj.get(cur) || new Set<string>();
      for (const nb of neighbors) {
        if (dist.get(nb) === -1) {
          dist.set(nb, dist.get(cur)! + 1);
          queue.push(nb);
        }
        if (dist.get(nb) === dist.get(cur)! + 1) {
          sigma.set(nb, sigma.get(nb)! + sigma.get(cur)!);
          pred.get(nb)!.push(cur);
        }
      }
    }

    // 接近中心性（Wasserman-Faust 归一化，处理非连通图）
    let totalDist = 0;
    let reachableCount = 0;
    for (const id of nodeIds) {
      if (id !== s && dist.get(id)! > 0) {
        totalDist += dist.get(id)!;
        reachableCount++;
      }
    }
    if (reachableCount > 0 && totalDist > 0) {
      // WF 公式：(reachable / (n-1)) * (reachable / totalDist)
      closenessCentrality.set(
        s,
        (reachableCount / (n - 1)) * (reachableCount / totalDist),
      );
    }

    // 介数中心性：按距离降序累积依赖值
    const delta = new Map<string, number>();
    nodeIds.forEach((id) => delta.set(id, 0));
    for (let i = visitedOrder.length - 1; i >= 0; i--) {
      const w = visitedOrder[i];
      const preds = pred.get(w)!;
      for (const p of preds) {
        const ratio = sigma.get(p)! / sigma.get(w)!;
        delta.set(p, delta.get(p)! + ratio * (1 + (delta.get(w) || 0)));
      }
      if (w !== s) {
        betweennessCentrality.set(w, (betweennessCentrality.get(w) || 0) + delta.get(w)!);
      }
    }
  }

  // 介数中心性归一化（无向图：每对节点被计算两次，除以 2）
  // 归一化因子 = (n-1)(n-2)（无向图）
  const normFactor = n > 2 ? (n - 1) * (n - 2) : 1;
  nodeIds.forEach((id) => {
    const val = (betweennessCentrality.get(id) || 0) / 2;
    betweennessCentrality.set(id, normFactor > 0 ? val / normFactor : 0);
  });

  return { degreeCentrality, closenessCentrality, betweennessCentrality };
}

// ═══════════════════════════════════════════════════════════════
// 6. 环路检测
// ═══════════════════════════════════════════════════════════════

export interface CycleDetectionResult {
  /** 是否存在环 */
  hasCycle: boolean;
  /** 检测到的环（节点序列，首尾相同表示闭合） */
  cycles: string[][];
  /** 是否因达到上限而截断 */
  truncated: boolean;
}

/**
 * DFS 三色标记法检测有向图中的环
 *
 * 原理：白色（未访问）/灰色（在当前递归栈中）/黑色（已完成）。
 *   DFS 遇到灰色节点即发现回边，从递归栈中截取对应区间得到环的节点序列。
 * 复杂度：O(V + E)
 *
 * @param nodes 节点列表
 * @param edges 边列表（有向）
 * @param maxCycles 最大返回环数，默认 10
 * @returns 环路检测结果
 */
export function detectCycles(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  maxCycles = 10,
): CycleDetectionResult {
  const nodeIds = nodes.map((n) => n.id);
  const adj = buildDirectedAdj(nodeIds, edges);

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  nodeIds.forEach((id) => color.set(id, WHITE));
  const stack: string[] = [];
  const cycles: string[][] = [];
  let truncated = false;

  function dfs(node: string): void {
    if (truncated) return;
    color.set(node, GRAY);
    stack.push(node);

    const neighbors = adj.get(node) || [];
    for (const nb of neighbors) {
      if (color.get(nb) === GRAY) {
        // 发现环：从栈中截取灰色节点到当前位置
        const startIdx = stack.indexOf(nb);
        if (startIdx >= 0) {
          const cycle = stack.slice(startIdx);
          cycles.push([...cycle, nb]);
          if (cycles.length >= maxCycles) {
            truncated = true;
            break;
          }
        }
      } else if (color.get(nb) === WHITE) {
        dfs(nb);
      }
    }

    stack.pop();
    color.set(node, BLACK);
  }

  for (const id of nodeIds) {
    if (color.get(id) === WHITE) {
      dfs(id);
      if (truncated) break;
    }
  }

  return { hasCycle: cycles.length > 0, cycles, truncated };
}

// ═══════════════════════════════════════════════════════════════
// 7. 节点度数分布
// ═══════════════════════════════════════════════════════════════

export interface NodeDegreeInfo {
  /** 节点 id */
  nodeId: string;
  /** 入度（作为边的目标） */
  inDegree: number;
  /** 出度（作为边的起点） */
  outDegree: number;
  /** 总度数 = 入度 + 出度 */
  totalDegree: number;
}

export interface DegreeDistributionResult {
  /** 每个节点的度数信息 */
  nodes: NodeDegreeInfo[];
  /** 入度分布直方图（度数 → 节点数） */
  inDegreeHistogram: Map<number, number>;
  /** 出度分布直方图（度数 → 节点数） */
  outDegreeHistogram: Map<number, number>;
  /** 总度数分布直方图（度数 → 节点数） */
  totalDegreeHistogram: Map<number, number>;
  /** 平均总度数 */
  averageDegree: number;
  /** 最大总度数 */
  maxDegree: number;
}

/**
 * 节点度数统计（入度 / 出度 / 总度）
 *
 * 原理：遍历所有边，累加每条边端点的入度和出度，生成分布直方图。
 * 复杂度：O(V + E)
 *
 * @param nodes 节点列表
 * @param edges 边列表（有向）
 * @returns 度数分布结果
 */
export function computeDegreeDistribution(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
): DegreeDistributionResult {
  const idSet = new Set(nodes.map((n) => n.id));
  const inDeg = new Map<string, number>();
  const outDeg = new Map<string, number>();
  nodes.forEach((n) => { inDeg.set(n.id, 0); outDeg.set(n.id, 0); });

  edges.forEach((e) => {
    if (idSet.has(e.source)) outDeg.set(e.source, (outDeg.get(e.source) || 0) + 1);
    if (idSet.has(e.target)) inDeg.set(e.target, (inDeg.get(e.target) || 0) + 1);
  });

  const inDegreeHistogram = new Map<number, number>();
  const outDegreeHistogram = new Map<number, number>();
  const totalDegreeHistogram = new Map<number, number>();
  let totalDegreeSum = 0;
  let maxDegree = 0;

  const nodeInfos: NodeDegreeInfo[] = nodes.map((n) => {
    const inD = inDeg.get(n.id) || 0;
    const outD = outDeg.get(n.id) || 0;
    const total = inD + outD;
    totalDegreeSum += total;
    if (total > maxDegree) maxDegree = total;
    inDegreeHistogram.set(inD, (inDegreeHistogram.get(inD) || 0) + 1);
    outDegreeHistogram.set(outD, (outDegreeHistogram.get(outD) || 0) + 1);
    totalDegreeHistogram.set(total, (totalDegreeHistogram.get(total) || 0) + 1);
    return { nodeId: n.id, inDegree: inD, outDegree: outD, totalDegree: total };
  });

  const n = nodes.length;
  return {
    nodes: nodeInfos,
    inDegreeHistogram,
    outDegreeHistogram,
    totalDegreeHistogram,
    averageDegree: n > 0 ? totalDegreeSum / n : 0,
    maxDegree,
  };
}

// ═══════════════════════════════════════════════════════════════
// 8. K-Core 分解
// ═══════════════════════════════════════════════════════════════

export interface KCoreResult {
  /** k-core 中的节点 id 列表（传入 k 时为筛选结果，否则为全部节点） */
  nodeIds: string[];
  /** 每个节点的 coreness 值（最大 k 使该节点在 k-core 中） */
  coreness: Map<string, number>;
  /** coreness 值分布（coreness → 节点数） */
  corenessDistribution: Map<number, number>;
  /** 最大 coreness 值 */
  maxCoreness: number;
}

/**
 * K-Core 分解（Batagelj-Zaversnik 线性算法）
 *
 * 原理：在无向图中按度数升序处理节点。处理度数为 d 的节点 v 时，
 *   coreness[v] = d；然后将 v 从图中"移除"，对其仍在图中的邻居度数减一，
 *   并将邻居移到对应桶中。仅处理 deg[u] > d 的邻居（deg[u] ≤ d 的已处理或同批）。
 *   传入 k 时仅返回 coreness ≥ k 的节点；不传 k 返回全部节点的 coreness。
 * 复杂度：O(V + E)
 *
 * @param nodes 节点列表
 * @param edges 边列表（按无向处理）
 * @param k 目标 core 值；不传则计算所有节点的 coreness
 * @returns k-core 分解结果
 */
export function kCoreDecomposition(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  k?: number,
): KCoreResult {
  const nodeIds = nodes.map((n) => n.id);
  const adj = buildUndirectedAdj(nodeIds, edges);

  // 当前度数（随剥离动态更新）
  const degree = new Map<string, number>();
  nodeIds.forEach((id) => degree.set(id, (adj.get(id) || new Set()).size));

  // 按度数分桶
  let maxDeg = 0;
  nodeIds.forEach((id) => { const d = degree.get(id)!; if (d > maxDeg) maxDeg = d; });
  const bin: string[][] = Array.from({ length: maxDeg + 1 }, () => []);
  nodeIds.forEach((id) => bin[degree.get(id)!].push(id));

  const coreness = new Map<string, number>();
  nodeIds.forEach((id) => coreness.set(id, 0));
  const processed = new Set<string>();

  for (let d = 0; d <= maxDeg; d++) {
    while (bin[d] && bin[d].length > 0) {
      const node = bin[d].pop()!;
      if (processed.has(node)) continue;
      if (degree.get(node)! !== d) continue; // 度数已被更新，跳过旧桶残留

      coreness.set(node, d);
      processed.add(node);

      // 对每个未处理的邻居，减少其度数
      const neighbors = adj.get(node) || new Set<string>();
      for (const nb of neighbors) {
        if (processed.has(nb)) continue;
        const oldDeg = degree.get(nb)!;
        if (oldDeg > d) {
          degree.set(nb, oldDeg - 1);
          bin[oldDeg - 1].push(nb);
        }
      }
    }
  }

  // 分配结果
  const corenessDistribution = new Map<number, number>();
  let maxCoreness = 0;
  nodeIds.forEach((id) => {
    const c = coreness.get(id) || 0;
    corenessDistribution.set(c, (corenessDistribution.get(c) || 0) + 1);
    if (c > maxCoreness) maxCoreness = c;
  });

  const resultNodeIds = k !== undefined
    ? nodeIds.filter((id) => (coreness.get(id) || 0) >= k)
    : nodeIds;

  return {
    nodeIds: resultNodeIds,
    coreness,
    corenessDistribution,
    maxCoreness,
  };
}

// ═══════════════════════════════════════════════════════════════
// 9. 关键路径（DAG 最长路径）
// ═══════════════════════════════════════════════════════════════

export interface CriticalPathResult {
  /** 是否为 DAG（无环有向图） */
  isDag: boolean;
  /** 关键路径上的节点序列（空数组表示无路径或非 DAG） */
  path: string[];
  /** 关键路径长度（边权重之和） */
  length: number;
}

/**
 * DAG 关键路径（拓扑排序 + DP 求最长路径）
 *
 * 原理：先用 Kahn 拓扑排序检测是否有环（有环则非 DAG，无法计算关键路径）；
 *   若为 DAG，在拓扑序上线性 DP：
 *   dist[v] = max(dist[u] + weight(u,v)) for all edges u→v
 *   最后取 dist 最大的节点回溯得到最长路径。
 * 复杂度：O(V + E)
 *
 * @param nodes 节点列表
 * @param edges 边列表（有向）
 * @returns 关键路径结果
 */
export function findCriticalPath(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
): CriticalPathResult {
  const nodeIds = nodes.map((n) => n.id);
  const idSet = new Set(nodeIds);

  const adj = new Map<string, { target: string; weight: number }[]>();
  const inDegree = new Map<string, number>();
  nodeIds.forEach((id) => { adj.set(id, []); inDegree.set(id, 0); });
  edges.forEach((e) => {
    if (idSet.has(e.source) && idSet.has(e.target)) {
      adj.get(e.source)!.push({ target: e.target, weight: edgeWeight(e) });
      inDegree.set(e.target, (inDegree.get(e.target) || 0) + 1);
    }
  });

  // Kahn 拓扑排序（同时检测环）
  const queue: string[] = [];
  nodeIds.forEach((id) => { if ((inDegree.get(id) || 0) === 0) queue.push(id); });
  const topoOrder: string[] = [];
  const inDegCopy = new Map(inDegree);

  while (queue.length > 0) {
    const cur = queue.shift()!;
    topoOrder.push(cur);
    const neighbors = adj.get(cur) || [];
    for (const { target } of neighbors) {
      inDegCopy.set(target, (inDegCopy.get(target) || 0) - 1);
      if ((inDegCopy.get(target) || 0) === 0) queue.push(target);
    }
  }

  if (topoOrder.length < nodeIds.length) {
    return { isDag: false, path: [], length: 0 };
  }

  // DP 求最长路径
  const dist = new Map<string, number>();
  const parent = new Map<string, string>();
  nodeIds.forEach((id) => { dist.set(id, 0); parent.set(id, ''); });

  for (const u of topoOrder) {
    const neighbors = adj.get(u) || [];
    for (const { target: v, weight } of neighbors) {
      const newDist = dist.get(u)! + weight;
      if (newDist > (dist.get(v) || 0)) {
        dist.set(v, newDist);
        parent.set(v, u);
      }
    }
  }

  // 找到 dist 最大的节点
  let endNode = '';
  let maxDist = 0;
  for (const id of nodeIds) {
    if ((dist.get(id) || 0) > maxDist) {
      maxDist = dist.get(id)!;
      endNode = id;
    }
  }

  if (!endNode || maxDist === 0) {
    return { isDag: true, path: [], length: 0 };
  }

  // 回溯路径
  const path: string[] = [endNode];
  let cur = endNode;
  while (parent.get(cur)) {
    cur = parent.get(cur)!;
    path.unshift(cur);
  }

  return { isDag: true, path, length: maxDist };
}

// ═══════════════════════════════════════════════════════════════
// 10. 邻居发现
// ═══════════════════════════════════════════════════════════════

export interface NeighborResult {
  /** 一跳邻居 */
  oneHop: string[];
  /** 两跳邻居（不含自身和一跳邻居） */
  twoHop: string[];
}

export interface CommonNeighborResult {
  /** 共同邻居节点 id 列表 */
  common: string[];
  /** 共同邻居数量 */
  count: number;
}

export interface SimilarityResult {
  /** Jaccard 相似度 [0, 1] */
  similarity: number;
  /** 节点 A 的邻居数 */
  neighborsA: number;
  /** 节点 B 的邻居数 */
  neighborsB: number;
  /** 交集大小 */
  intersection: number;
  /** 并集大小 */
  union: number;
}

/**
 * 一跳 / 两跳邻居发现（无向图）
 *
 * 原理：从节点 BFS 两层，一跳为直接邻居，两跳为邻居的邻居（去重，排除自身和一跳）。
 * 复杂度：O(d²)，d 为平均度数
 *
 * @param nodes 节点列表
 * @param edges 边列表（无向）
 * @param nodeId 目标节点 id
 * @returns 邻居发现结果
 */
export function findNeighbors(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  nodeId: string,
): NeighborResult {
  const nodeIds = nodes.map((n) => n.id);
  const idSet = new Set(nodeIds);
  if (!idSet.has(nodeId)) return { oneHop: [], twoHop: [] };

  const adj = buildUndirectedAdj(nodeIds, edges);
  const oneHopSet = adj.get(nodeId) || new Set<string>();
  const oneHop = Array.from(oneHopSet);

  const twoHopSet = new Set<string>();
  for (const nb of oneHopSet) {
    const neighbors = adj.get(nb) || new Set<string>();
    for (const nnb of neighbors) {
      if (nnb !== nodeId && !oneHopSet.has(nnb)) {
        twoHopSet.add(nnb);
      }
    }
  }

  return { oneHop, twoHop: Array.from(twoHopSet) };
}

/**
 * 共同邻居发现
 *
 * 原理：取两个节点的邻居集合的交集。共同邻居越多，两节点关系越紧密。
 * 复杂度：O(d)
 *
 * @param nodes 节点列表
 * @param edges 边列表（无向）
 * @param nodeIdA 节点 A id
 * @param nodeIdB 节点 B id
 * @returns 共同邻居结果
 */
export function findCommonNeighbors(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  nodeIdA: string,
  nodeIdB: string,
): CommonNeighborResult {
  const nodeIds = nodes.map((n) => n.id);
  const idSet = new Set(nodeIds);
  if (!idSet.has(nodeIdA) || !idSet.has(nodeIdB)) {
    return { common: [], count: 0 };
  }

  const adj = buildUndirectedAdj(nodeIds, edges);
  const neighborsA = adj.get(nodeIdA) || new Set<string>();
  const neighborsB = adj.get(nodeIdB) || new Set<string>();
  const common = Array.from(neighborsA).filter((x) => neighborsB.has(x));

  return { common, count: common.length };
}

/**
 * Jaccard 相似度（基于邻居集合）
 *
 * 原理：Jaccard(A, B) = |A ∩ B| / |A ∪ B|，其中 A、B 为两节点的邻居集合。
 *   值域 [0, 1]，1 表示邻居完全相同。用于链路预测和相似节点推荐。
 * 复杂度：O(d)
 *
 * @param nodes 节点列表
 * @param edges 边列表（无向）
 * @param nodeIdA 节点 A id
 * @param nodeIdB 节点 B id
 * @returns 相似度结果
 */
export function jaccardSimilarity(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  nodeIdA: string,
  nodeIdB: string,
): SimilarityResult {
  const nodeIds = nodes.map((n) => n.id);
  const idSet = new Set(nodeIds);
  if (!idSet.has(nodeIdA) || !idSet.has(nodeIdB)) {
    return { similarity: 0, neighborsA: 0, neighborsB: 0, intersection: 0, union: 0 };
  }

  const adj = buildUndirectedAdj(nodeIds, edges);
  const neighborsA = adj.get(nodeIdA) || new Set<string>();
  const neighborsB = adj.get(nodeIdB) || new Set<string>();

  let intersection = 0;
  for (const x of neighborsA) {
    if (neighborsB.has(x)) intersection++;
  }
  const union = neighborsA.size + neighborsB.size - intersection;

  return {
    similarity: union > 0 ? intersection / union : 0,
    neighborsA: neighborsA.size,
    neighborsB: neighborsB.size,
    intersection,
    union,
  };
}
