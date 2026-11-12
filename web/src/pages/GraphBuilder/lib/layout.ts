/**
 * dagre 分层布局（画布节点自动布局，移植自 AI Harbor graph-editor.html layoutDagre）
 */
import dagre from 'dagre';
import type { CanvasNode, CanvasEdge } from './graphDoc';

/** 对画布节点做 dagre 分层布局，返回新位置（不改动输入）。rankdir：LR=左右流向（默认），TB=上下层级 */
export function layoutDagre(nodes: CanvasNode[], edges: CanvasEdge[], opts?: { rankdir?: 'LR' | 'TB' }): CanvasNode[] {
  const graph = new dagre.graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: opts?.rankdir || 'LR', nodesep: 60, ranksep: 150, marginx: 20, marginy: 20 });
  nodes.forEach((n) => { graph.setNode(n.id, { width: 160, height: 56 }); });
  edges.forEach((e) => { graph.setEdge(e.source, e.target); });
  dagre.layout(graph);
  return nodes.map((n) => {
    const p = graph.node(n.id);
    return { ...n, position: { x: (p ? p.x : 0) - 80, y: (p ? p.y : 0) - 28 } };
  });
}

const NODE_W = 160;
const NODE_H = 56;
const H_GAP = 32; // 兄弟节点水平间距
const V_GAP = 48; // 层级垂直间距
const MAX_PER_ROW = 8; // 高扇出分行：单行最多子节点数（避免一条水平长龙）
const EXTRAS_PER_ROW = 10; // 底部支撑节点网格：单行最多节点数

/**
 * 组织树布局（TB 上下分层，组织结构图风格）：
 *   childrenOf = 父 id → 子 id[]（树骨架邻接表，调用方从模板声明的树边构建）。
 *   骨架节点：BFS 定深 + 子树宽度分配（父居中于子之上，叶宽度=1）；
 *   高扇出分行：子数 > MAX_PER_ROW 时逐行换行堆叠，父居中于最宽行
 *     （意图图谱「理财」35 个聚合意图 → 5 行 × 8 的整齐方块，而非 6700px 长龙）；
 *   多根/环：根并排聚合、环边忽略（visited 防御）；
 *   非骨架节点（如部门/业务对象）：排在骨架底部，EXTRAS_PER_ROW 换行的多行网格，居中对齐整棵树。
 * 返回新位置，不改动输入。
 */
export function layoutTree(nodes: CanvasNode[], childrenOf: Map<string, string[]>): CanvasNode[] {
  const widthCache = new Map<string, number>();
  const depthCache = new Map<string, number>();

  // 1. 定深（BFS，visited 防环）；孤立骨架节点也纳入（作为虚拟根的子）
  const roots: string[] = [];
  const hasParent = new Set<string>();
  childrenOf.forEach((kids) => kids.forEach((k) => hasParent.add(k)));
  const visited = new Set<string>();
  const queue: [string, number][] = [];
  nodes.forEach((n) => {
    if (childrenOf.has(n.id) && !hasParent.has(n.id) && !visited.has(n.id)) {
      visited.add(n.id);
      depthCache.set(n.id, 0);
      queue.push([n.id, 0]);
      roots.push(n.id);
    }
  });
  while (queue.length) {
    const [id, depth] = queue.shift()!;
    (childrenOf.get(id) || []).forEach((kid) => {
      if (!visited.has(kid)) {
        visited.add(kid);
        depthCache.set(kid, depth + 1);
        queue.push([kid, depth + 1]);
      }
    });
  }

  // 2. 子树宽度（叶=1；分行后宽度=最宽行的子宽之和，行内子宽累加）
  const computeWidth = (id: string): number => {
    if (widthCache.has(id)) return widthCache.get(id)!;
    const kids = (childrenOf.get(id) || []).filter((k) => depthCache.get(k) !== undefined);
    let maxRow = 0;
    for (let i = 0; i < kids.length; i += MAX_PER_ROW) {
      let rowW = 0;
      for (let j = i; j < Math.min(i + MAX_PER_ROW, kids.length); j++) rowW += computeWidth(kids[j]);
      if (rowW > maxRow) maxRow = rowW;
    }
    const w = maxRow || 1;
    widthCache.set(id, w);
    return w;
  };
  roots.forEach(computeWidth);

  // 3. 分配 x/y（虚拟根聚合多根，依次横排；子代按行换行堆叠）
  const position = new Map<string, { x: number; y: number }>();
  let maxY = 0;
  const assign = (id: string, x0: number, y: number, depth: number) => {
    const w = widthCache.get(id) || 1;
    const unionW = w * (NODE_W + H_GAP);
    position.set(id, { x: x0 + unionW / 2 - NODE_W / 2, y });
    maxY = Math.max(maxY, y);
    const kids = (childrenOf.get(id) || []).filter((k) => depthCache.get(k) === depth + 1);
    let row = 0;
    let childX = x0;
    for (let i = 0; i < kids.length; i++) {
      assign(kids[i], childX, y + (row + 1) * (NODE_H + V_GAP), depth + 1);
      childX += (widthCache.get(kids[i]) || 1) * (NODE_W + H_GAP);
      if ((i + 1) % MAX_PER_ROW === 0) { row += 1; childX = x0; }
    }
  };
  let rootX = 0;
  roots.forEach((r) => {
    assign(r, rootX, 0, 0);
    rootX += (widthCache.get(r) || 1) * (NODE_W + H_GAP);
  });

  // 4. 非骨架节点（含环中/父缺失的骨架节点）：骨架底部多行网格，居中对齐整棵树
  const extras = nodes.filter((n) => !position.has(n.id));
  const rowItems = Math.min(extras.length, EXTRAS_PER_ROW);
  const gridW = (rowItems - 1) * (NODE_W + H_GAP) + NODE_W;
  const extraStart = position.size ? rootX / 2 - gridW / 2 : -gridW / 2;
  const extraY = position.size ? maxY + (NODE_H + V_GAP) : 0;
  const extraPos = new Map<string, { x: number; y: number }>();
  extras.forEach((n, i) => {
    extraPos.set(n.id, {
      x: Math.round(extraStart + (i % EXTRAS_PER_ROW) * (NODE_W + H_GAP)),
      y: Math.round(extraY + Math.floor(i / EXTRAS_PER_ROW) * (NODE_H + V_GAP)),
    });
  });

  // 5. 生成结果
  return nodes.map((n) => {
    const pos = position.get(n.id) || extraPos.get(n.id) || { x: 0, y: 0 };
    return { ...n, position: { x: Math.round(pos.x), y: Math.round(pos.y) } };
  });
}

/**
 * 从模板声明的树边构建 childrenOf 邻接表。
 * treeEdges 可为 string[]（父端统一 treeParent）或 {type,parent}[]（每种边各自父端）。
 * 例：意图图谱 has_leaf_intent 父在 source（聚合→叶子）、is_child_of 父在 target（子→领域根）。
 */
export function buildTreeChildren(
  edges: CanvasEdge[],
  treeEdges: string | string[] | { type: string; parent?: 'source' | 'target' }[],
  treeParent: 'source' | 'target',
): Map<string, string[]> {
  const list = typeof treeEdges === 'string' ? [treeEdges] : (treeEdges || []);
  const decls: { type: string; parent: 'source' | 'target' }[] = list.map((d) =>
    typeof d === 'string' ? { type: d, parent: treeParent } : { type: d.type, parent: d.parent || treeParent });
  const parentByType = new Map<string, 'source' | 'target'>();
  decls.forEach((d) => parentByType.set(d.type, d.parent));
  const childrenOf = new Map<string, string[]>();
  edges.forEach((e) => {
    // 画布边类型在 data.edgeType（CanvasEdge 无顶层 type 字段）
    const edgeType = String(e.data.edgeType || e.label || '');
    const parentEnd = parentByType.get(edgeType);
    if (!parentEnd) return;
    const parent = parentEnd === 'target' ? e.target : e.source;
    const child = parentEnd === 'target' ? e.source : e.target;
    const kids = childrenOf.get(parent) || [];
    if (kids.indexOf(child) < 0) kids.push(child);
    childrenOf.set(parent, kids);
  });
  return childrenOf;
}

const RING_GAP = 190; // 径向环距（≥ 节点高 + 边穿过余量）

/**
 * 径向布局（G6 radial 同款思路）：核心枢纽居中，其余按 BFS 深度成环——
 *   一跳邻接在第一环、两跳在第二环……知识图谱「以中心实体展开」的标准读图方式。
 *   中心 = 度数最大节点（并列取数组序，确定性）；同环按（类型, 名称）排序均匀分布，
 *   奇偶环错开半格减少边交叉；环半径自适应容纳环上节点数（周长约束）；
 *   与中心不连通的节点放最外环（避免丢失）。
 * 返回新位置，不改动输入。
 */
export function layoutRadial(nodes: CanvasNode[], edges: CanvasEdge[]): CanvasNode[] {
  if (nodes.length === 0) return nodes;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  // 无向邻接 + 度数
  const adj = new Map<string, string[]>();
  const degree = new Map<string, number>();
  edges.forEach((e) => {
    if (!byId.has(e.source) || !byId.has(e.target)) return;
    let list = adj.get(e.source); if (!list) adj.set(e.source, (list = []));
    list.push(e.target);
    let list2 = adj.get(e.target); if (!list2) adj.set(e.target, (list2 = []));
    list2.push(e.source);
    degree.set(e.source, (degree.get(e.source) || 0) + 1);
    degree.set(e.target, (degree.get(e.target) || 0) + 1);
  });
  // 中心 = 度数最大（并列取先出现；全孤立取首节点）
  let center = nodes[0].id;
  let best = -1;
  nodes.forEach((n) => {
    const d = degree.get(n.id) || 0;
    if (d > best) { best = d; center = n.id; }
  });
  // BFS 定深（visited 防环）
  const depth = new Map<string, number>([[center, 0]]);
  const queue = [center];
  while (queue.length) {
    const id = queue.shift()!;
    (adj.get(id) || []).forEach((nb) => {
      if (!depth.has(nb)) { depth.set(nb, depth.get(id)! + 1); queue.push(nb); }
    });
  }
  // 分环（不连通节点放最外 +1 环）
  const maxDepth = Math.max(0, ...[...depth.values()]);
  const rings = new Map<number, string[]>();
  nodes.forEach((n) => {
    const d = depth.has(n.id) ? depth.get(n.id)! : maxDepth + 1;
    let ring = rings.get(d); if (!ring) rings.set(d, (ring = []));
    ring.push(n.id);
  });
  // 环半径：保证环周长容得下环上节点（弧间距 ≥ 节点宽 + 缝隙），且不小于上一环 + RING_GAP
  const nameOf = (id: string) => String((byId.get(id)!.data as Record<string, unknown>).name || byId.get(id)!.data.title || id);
  const typeOf = (id: string) => String(byId.get(id)!.data.nodeType || '');
  const position = new Map<string, { x: number; y: number }>([[center, { x: -NODE_W / 2, y: -NODE_H / 2 }]]);
  let prevRadius = 0;
  [...rings.keys()].sort((a, b) => a - b).forEach((d, ringIndex) => {
    if (d === 0) return; // 环 0 = 中心点自身，已居中放置
    const ids = (rings.get(d) || []).slice().sort((a, b) => (typeOf(a) < typeOf(b) ? -1 : typeOf(a) > typeOf(b) ? 1 : nameOf(a) < nameOf(b) ? -1 : 1));
    if (ids.length === 0) return;
    const needRadius = (ids.length * (NODE_W + 24)) / (2 * Math.PI);
    const radius = Math.max(prevRadius + RING_GAP, needRadius);
    const offset = (ringIndex % 2) * (Math.PI / ids.length); // 奇偶环错开半格
    ids.forEach((id, i) => {
      const angle = offset + (2 * Math.PI * i) / ids.length;
      position.set(id, { x: Math.round(radius * Math.cos(angle) - NODE_W / 2), y: Math.round(radius * Math.sin(angle) - NODE_H / 2) });
    });
    prevRadius = radius;
  });
  return nodes.map((n) => ({ ...n, position: position.get(n.id) || { x: 0, y: 0 } }));
}

const COL_GAP = 140; // 分栏横向间距（留出跨栏边的穿过空间）
const CELL_V_GAP = 24; // 分栏内纵向间距

/**
 * 类型分栏布局：节点按 nodeType 分列（栏序 = typeOrder 传入顺序，缺省按数量降序），
 * 栏内近方形网格（行列数 ≈ √n，157 员工 → 13×13 方块而非 1.2 万像素长条），各栏垂直居中对齐。
 * 适合属性图的 schema 视角：同类型聚成一栏，跨类型边模式一眼可辨（员工栏 → 部门栏 → 项目栏）。
 * 返回新位置，不改动输入。
 */
export function layoutColumns(nodes: CanvasNode[], typeOrder?: string[]): CanvasNode[] {
  if (nodes.length === 0) return nodes;
  // 分组（未知类型排最后）
  const groups = new Map<string, CanvasNode[]>();
  nodes.forEach((n) => {
    const t = String(n.data.nodeType || 'UNKNOWN');
    let list = groups.get(t); if (!list) groups.set(t, (list = []));
    list.push(n);
  });
  const counts = [...groups.entries()].map(([t, list]) => ({ type: t, count: list.length }));
  const order = (typeOrder || []).filter((t) => groups.has(t));
  [...counts].sort((a, b) => b.count - a.count || (a.type < b.type ? -1 : 1)).forEach((c) => {
    if (order.indexOf(c.type) < 0) order.push(c.type);
  });
  // 各栏网格尺寸
  const blocks = order.map((t) => {
    const list = groups.get(t)!;
    const rows = Math.max(1, Math.round(Math.sqrt(list.length)));
    return { type: t, list, rows, cols: Math.ceil(list.length / rows), height: rows * (NODE_H + CELL_V_GAP) - CELL_V_GAP };
  });
  const maxHeight = Math.max(...blocks.map((b) => b.height));
  let x = 0;
  const position = new Map<string, { x: number; y: number }>();
  blocks.forEach((b) => {
    const y0 = (maxHeight - b.height) / 2; // 垂直居中
    b.list.forEach((n, i) => {
      position.set(n.id, {
        x: Math.round(x + (i % b.cols) * (NODE_W + CELL_V_GAP)),
        y: Math.round(y0 + Math.floor(i / b.cols) * (NODE_H + CELL_V_GAP)),
      });
    });
    x += b.cols * (NODE_W + CELL_V_GAP) + COL_GAP - CELL_V_GAP;
  });
  return nodes.map((n) => ({ ...n, position: position.get(n.id) || { x: 0, y: 0 } }));
}

// ── Fruchterman-Reingold 力导向布局 ──

export interface FruchtermanOptions {
  /** 布局区域宽度（影响理想距离 k；默认按节点数自适应） */
  width?: number;
  /** 布局区域高度（影响理想距离 k；默认按节点数自适应） */
  height?: number;
  /** 迭代次数（默认按规模自适应） */
  iterations?: number;
}

/**
 * Fruchterman-Reingold 力导向布局（纯 TS 自实现，不依赖 d3-force）。
 *
 * 经典力导向算法：节点间全互斥（库仑斥力 k²/d），边两端相吸（弹簧引力 d²/k），
 * 迭代位移受温度限幅（温度按迭代线性衰减到 0）。理想距离 k = √(area/n)。
 * 收敛后高连接区自然聚簇、稀疏区铺开——知识图谱读图兼顾整体与局部。
 * 确定性：初始位置沿用既有坐标 + 环形兜底（无随机数），固定迭代同步。
 * 返回新位置，不改动输入。
 */
export function layoutFruchterman(nodes: CanvasNode[], edges: CanvasEdge[], opts?: FruchtermanOptions): CanvasNode[] {
  const n = nodes.length;
  if (n === 0) return nodes;
  void opts?.width; void opts?.height;
  const area = (opts?.width || 0) * (opts?.height || 0) || Math.max(1, n) * 200 * 200;
  const k = Math.sqrt(area / n);
  const iterations = opts?.iterations ?? Math.max(120, Math.min(400, Math.round(60000 / Math.sqrt(n))));
  // 初始位置：已有坐标沿用（布局稳定不跳变）；缺失者环形兜底（确定性，无随机数）
  const pos = nodes.map((node, i) => {
    if (node.position.x !== 0 || node.position.y !== 0) return { x: node.position.x, y: node.position.y };
    const r = Math.max(120, Math.sqrt(n) * 45);
    const angle = (2 * Math.PI * i) / Math.max(1, n);
    return { x: r * Math.cos(angle), y: r * Math.sin(angle) };
  });
  const byIdx = new Map(nodes.map((node, i) => [node.id, i]));
  const edgeList: [number, number][] = [];
  edges.forEach((e) => {
    const s = byIdx.get(e.source);
    const t = byIdx.get(e.target);
    if (s !== undefined && t !== undefined && s !== t) edgeList.push([s, t]);
  });
  const disp = pos.map(() => ({ x: 0, y: 0 }));
  let temperature = k * 2;
  const tempStep = temperature / iterations;
  for (let iter = 0; iter < iterations; iter += 1) {
    // 斥力：全对节点（库仑 k²/d，方向远离对方）
    for (let i = 0; i < n; i += 1) {
      disp[i].x = 0; disp[i].y = 0;
      for (let j = 0; j < n; j += 1) {
        if (i === j) continue;
        const dx = pos[i].x - pos[j].x;
        const dy = pos[i].y - pos[j].y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const force = (k * k) / dist;
        disp[i].x += (dx / dist) * force;
        disp[i].y += (dy / dist) * force;
      }
    }
    // 引力：边两端（弹簧 d²/k，方向相向）
    edgeList.forEach(([s, t]) => {
      const dx = pos[s].x - pos[t].x;
      const dy = pos[s].y - pos[t].y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const force = (dist * dist) / k;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      disp[s].x -= fx; disp[s].y -= fy;
      disp[t].x += fx; disp[t].y += fy;
    });
    // 应用位移（温度限幅，防节点飞太远）
    for (let i = 0; i < n; i += 1) {
      const d = Math.sqrt(disp[i].x * disp[i].x + disp[i].y * disp[i].y) || 0.01;
      const limit = Math.min(d, temperature);
      pos[i].x += (disp[i].x / d) * limit;
      pos[i].y += (disp[i].y / d) * limit;
    }
    temperature = Math.max(0, temperature - tempStep);
  }
  return nodes.map((node, i) => ({ ...node, position: { x: Math.round(pos[i].x), y: Math.round(pos[i].y) } }));
}

// ── 同心圆布局 ──

export interface ConcentricOptions {
  /** 同心圆数量上限（默认 min(6, √n)） */
  rings?: number;
  /** 圈间距（默认 180） */
  ringGap?: number;
}

const CONCENTRIC_GAP = 180; // 同心圆圈间距

/**
 * 同心圆布局（G6/vis-network concentric 同款思路）：
 *   节点按度数降序分配到同心圆——度数最高者在圆心（枢纽居中），其余按度数从内到外排列；
 *   每圈节点均匀分布（360°/圈节点数）。社交图/知识图谱「核心—外围」结构的直观读图。
 * 返回新位置，不改动输入。
 */
export function layoutConcentric(nodes: CanvasNode[], edges: CanvasEdge[], opts?: ConcentricOptions): CanvasNode[] {
  const n = nodes.length;
  if (n === 0) return nodes;
  // 度数
  const degree = new Map<string, number>();
  edges.forEach((e) => {
    degree.set(e.source, (degree.get(e.source) || 0) + 1);
    degree.set(e.target, (degree.get(e.target) || 0) + 1);
  });
  // 按度数降序（并列保持原序，确定性）
  const sorted = nodes
    .map((node, idx) => ({ id: node.id, deg: degree.get(node.id) || 0, idx }))
    .sort((a, b) => b.deg - a.deg || a.idx - b.idx);
  const ringCount = Math.min(opts?.rings ?? Math.max(1, Math.floor(Math.sqrt(n))), 6, n);
  const ringGap = opts?.ringGap ?? CONCENTRIC_GAP;
  const position = new Map<string, { x: number; y: number }>();
  // 度数最高节点居中
  position.set(sorted[0].id, { x: -NODE_W / 2, y: -NODE_H / 2 });
  // 其余按度数降序分配到各圈（内圈优先，均匀分摊）
  const remaining = sorted.length - 1;
  const perRing = Math.max(1, Math.ceil(remaining / ringCount));
  const ringNodes: string[][] = Array.from({ length: ringCount }, () => []);
  for (let i = 0; i < remaining; i += 1) {
    const ring = Math.min(Math.floor(i / perRing), ringCount - 1);
    ringNodes[ring].push(sorted[i + 1].id);
  }
  ringNodes.forEach((ids, ringIdx) => {
    const radius = (ringIdx + 1) * ringGap;
    ids.forEach((id, i) => {
      const angle = (2 * Math.PI * i) / ids.length;
      position.set(id, {
        x: Math.round(radius * Math.cos(angle) - NODE_W / 2),
        y: Math.round(radius * Math.sin(angle) - NODE_H / 2),
      });
    });
  });
  return nodes.map((node) => ({ ...node, position: position.get(node.id) || { x: 0, y: 0 } }));
}

// ── 网格布局 ──

export interface GridOptions {
  /** 是否按节点类型分组排列（同类型排在一起），默认 true */
  groupByType?: boolean;
  /** 类型排列顺序（缺省按数量降序） */
  typeOrder?: string[];
}

const GRID_H_GAP = H_GAP; // 网格水平间距（=32）
const GRID_V_GAP = 24; // 网格垂直间距（卡片高 56 + 24 缝隙）

/**
 * 网格布局：节点排列成近方形网格（行列数 ≈ √n），整齐易读。
 *   支持按节点类型分组——同类型节点排在一起（一组一行/多行），类型间留分隔行；
 *   适合 schema 视图或属性面板的紧凑展示。返回新位置，不改动输入。
 */
export function layoutGrid(nodes: CanvasNode[], opts?: GridOptions): CanvasNode[] {
  const n = nodes.length;
  if (n === 0) return nodes;
  const cellW = NODE_W + GRID_H_GAP;
  const cellH = NODE_H + GRID_V_GAP;
  const groupByType = opts?.groupByType !== false;
  const position = new Map<string, { x: number; y: number }>();
  if (!groupByType) {
    const cols = Math.max(1, Math.round(Math.sqrt(n)));
    nodes.forEach((node, i) => {
      position.set(node.id, {
        x: Math.round((i % cols) * cellW),
        y: Math.round(Math.floor(i / cols) * cellH),
      });
    });
  } else {
    // 分组（未知类型排最后）
    const groups = new Map<string, CanvasNode[]>();
    nodes.forEach((node) => {
      const t = String(node.data.nodeType || 'UNKNOWN');
      let list = groups.get(t); if (!list) groups.set(t, (list = []));
      list.push(node);
    });
    const order = (opts?.typeOrder || []).filter((t) => groups.has(t));
    [...groups.entries()]
      .map(([t, list]) => ({ type: t, count: list.length }))
      .sort((a, b) => b.count - a.count || (a.type < b.type ? -1 : 1))
      .forEach((c) => { if (order.indexOf(c.type) < 0) order.push(c.type); });
    let row = 0;
    order.forEach((t) => {
      const list = groups.get(t)!;
      const cols = Math.max(1, Math.round(Math.sqrt(list.length)));
      list.forEach((node, i) => {
        position.set(node.id, {
          x: Math.round((i % cols) * cellW),
          y: Math.round(row * cellH + Math.floor(i / cols) * cellH),
        });
      });
      row += Math.ceil(list.length / cols) + 1; // +1 分隔行
    });
  }
  return nodes.map((node) => ({ ...node, position: position.get(node.id) || { x: 0, y: 0 } }));
}

// ── 地理坐标布局 ──

export interface GeoOptions {
  /** 经纬度投影到画布的缩放系数（默认按节点跨度自适应） */
  scale?: number;
  /** 无地理坐标节点的网格列数（默认按数量自适应） */
  fallbackCols?: number;
}

/**
 * 地理坐标布局：读取节点的 data.latitude/longitude 或 data.lat/lng 或 data.x/y（地理坐标），
 * 经纬度映射到画布坐标（Mercator 投影简化版：x=经度弧度×R，y=ln(tan(π/4+纬度/2))×R）。
 * 无地理坐标的节点排在地理区下方的网格中（避免丢失）。返回新位置，不改动输入。
 */
export function layoutGeo(nodes: CanvasNode[], opts?: GeoOptions): CanvasNode[] {
  const n = nodes.length;
  if (n === 0) return nodes;
  const num = (v: unknown): number | null => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '') { const p = Number(v); return Number.isFinite(p) ? p : null; }
    return null;
  };
  interface Geo { id: string; lat: number; lng: number; }
  const geoNodes: Geo[] = [];
  const fallback: CanvasNode[] = [];
  nodes.forEach((node) => {
    const d = node.data;
    const lat = num(d.latitude) ?? num(d.lat) ?? num(d.y);
    const lng = num(d.longitude) ?? num(d.lng) ?? num(d.x);
    if (lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      geoNodes.push({ id: node.id, lat, lng });
    } else {
      fallback.push(node);
    }
  });
  const position = new Map<string, { x: number; y: number }>();
  if (geoNodes.length > 0) {
    // Mercator 投影（简化）：x=经度弧度，y=ln(tan(π/4+纬度/2))，再按跨度缩放居中
    const rad = Math.PI / 180;
    const projected = geoNodes.map((g) => ({
      id: g.id,
      x: g.lng * rad,
      y: Math.log(Math.tan(Math.PI / 4 + (g.lat * rad) / 2)),
    }));
    const xs = projected.map((p) => p.x);
    const ys = projected.map((p) => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const spanX = maxX - minX || 1;
    const spanY = maxY - minY || 1;
    const targetSpan = Math.max(400, Math.sqrt(geoNodes.length) * 200);
    const scale = opts?.scale ?? Math.min(targetSpan / spanX, targetSpan / spanY);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    projected.forEach((p) => {
      position.set(p.id, {
        x: Math.round((p.x - cx) * scale - NODE_W / 2),
        y: Math.round((p.y - cy) * scale - NODE_H / 2),
      });
    });
  }
  // 无地理坐标节点：排在地理区下方网格
  if (fallback.length > 0) {
    let bottomY = 0;
    position.forEach((p) => { bottomY = Math.max(bottomY, p.y); });
    const cols = opts?.fallbackCols ?? Math.max(1, Math.round(Math.sqrt(fallback.length)));
    const cellW = NODE_W + H_GAP;
    const cellH = NODE_H + V_GAP;
    const gridW = (cols - 1) * cellW + NODE_W;
    fallback.forEach((node, i) => {
      position.set(node.id, {
        x: Math.round((i % cols) * cellW - gridW / 2),
        y: Math.round(bottomY + cellH + Math.floor(i / cols) * cellH),
      });
    });
  }
  return nodes.map((node) => ({ ...node, position: position.get(node.id) || { x: 0, y: 0 } }));
}
