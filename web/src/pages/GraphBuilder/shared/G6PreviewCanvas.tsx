/**
 * G6 v5 大图预览画布 —— 复用平台已有 @antv/g6（WikiCandidateReview 同款引擎），替换 vis-network 预览。
 *
 * 知识图谱观感增强：
 *   force 力导向（防重叠）+ 按节点类型配色（模板 style.color 优先）+ 节点大小按度数自适应
 *   + 边按类型着色 + 箭头 + 拖拽/缩放/拖节点 + 点击高亮邻接（一跳上下文聚焦）
 */
import { useEffect, useRef } from 'react';
import { Empty, Tag } from 'antd';
import { Graph as G6Graph } from '@antv/g6';
import type { GraphDocument, GraphTemplate } from '@/api/orgGraph';
import { nodeDisplayName } from '../lib/graphDoc';

const FALLBACK_PALETTE = ['#1677ff', '#722ed1', '#13c2c2', '#eb2f96', '#fa8c16', '#52c41a', '#2f54eb', '#faad14'];
const MAX_PREVIEW_NODES = 500;

interface G6PreviewCanvasProps {
  document: GraphDocument | null;
  template?: GraphTemplate | null;
  height?: number;
}

export function G6PreviewCanvas({ document: doc, template, height = 560 }: G6PreviewCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<G6Graph | null>(null);

  useEffect(() => {
    if (!doc || !doc.nodes.length || !containerRef.current) return;
    if (graphRef.current) { graphRef.current.destroy(); graphRef.current = null; }

    // 模板类型色：node_types[].style.color → 调色板兜底
    const typeColor = new Map<string, string>();
    (template?.node_types || []).forEach((t, i) => {
      typeColor.set(t.type, t.style?.color || FALLBACK_PALETTE[i % FALLBACK_PALETTE.length]);
    });
    const colorOf = (type: string, i: number) => typeColor.get(type) || FALLBACK_PALETTE[i % FALLBACK_PALETTE.length];

    // 度数（节点大小与边宽依据）
    const degree = new Map<string, number>();
    doc.edges.forEach((e) => {
      degree.set(e.source, (degree.get(e.source) || 0) + 1);
      degree.set(e.target, (degree.get(e.target) || 0) + 1);
    });

    // 超大图裁剪（按度数保留枢纽，预览场景 500 上限）
    const trimmed = doc.nodes.length > MAX_PREVIEW_NODES
      ? new Set([...doc.nodes].sort((a, b) => (degree.get(b.id) || 0) - (degree.get(a.id) || 0)).slice(0, MAX_PREVIEW_NODES).map((n) => n.id))
      : null;

    // 初始位置：均匀圆形铺开——力导向若欠收敛也保证节点不叠、autoFit 不会放大成巨型圆
    const cw = containerRef.current.clientWidth || 900;
    const ringR = Math.max(140, Math.sqrt(doc.nodes.length) * 90);
    const cx = cw / 2;
    const cy = height / 2;

    const nodes = doc.nodes
      .filter((n) => !trimmed || trimmed.has(n.id))
      .map((n, i) => {
        const deg = degree.get(n.id) || 0;
        const size = Math.min(36, 22 + Math.sqrt(deg) * 5);
        const angle = (i / doc.nodes.length) * Math.PI * 2;
        return {
          id: n.id,
          data: { label: nodeDisplayName(n, template || undefined), type: n.type },
          style: {
            fill: colorOf(n.type, i),
            stroke: '#ffffff',
            lineWidth: 2,
            size,
            x: cx + Math.cos(angle) * ringR,
            y: cy + Math.sin(angle) * ringR,
          },
        };
      });
    const nodeIds = new Set(nodes.map((n) => n.id));
    const edgeColorCache = new Map<string, string>();
    const edges = doc.edges
      .filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target))
      .map((e, i) => {
        if (!edgeColorCache.has(e.type)) edgeColorCache.set(e.type, FALLBACK_PALETTE[edgeColorCache.size % FALLBACK_PALETTE.length]);
        return {
          id: e.id || `${e.source}-${e.target}-${i}`,
          source: e.source,
          target: e.target,
          data: { type: e.type },
          style: { stroke: edgeColorCache.get(e.type), lineWidth: 1.2, opacity: 0.75 },
        };
      });

    const instance = new G6Graph({
      container: containerRef.current,
      width: containerRef.current.clientWidth || 900,
      height,
      autoFit: 'view',
      padding: 40,
      data: { nodes, edges },
      layout: { type: 'force', preventOverlap: true, nodeStrength: -320, linkDistance: 150, nodeSize: 40 },
      animation: false,
      behaviors: ['drag-canvas', 'zoom-canvas', 'drag-element'],
      node: {
        type: 'circle',
        style: (datum: any) => ({
          ...datum.style,
          labelText: datum.data?.label || datum.id,
          labelFill: '#262626',
          labelFontSize: 11,
          labelPlacement: 'bottom',
          labelWordWrap: true,
          labelBackground: true,
          labelBackgroundFill: 'rgba(255,255,255,0.88)',
          labelBackgroundRadius: 4,
          labelPadding: [1, 5],
          cursor: 'pointer',
        }),
      },
      edge: {
        type: 'line',
        style: (datum: any) => ({ ...datum.style, endArrow: true, endArrowSize: 5 }),
      },
    });

    // 点击节点 → 高亮一跳邻接（再点空白复位）
    const adjacency = new Map<string, Set<string>>();
    edges.forEach((e) => {
      if (!adjacency.has(e.source)) adjacency.set(e.source, new Set());
      if (!adjacency.has(e.target)) adjacency.set(e.target, new Set());
      adjacency.get(e.source)!.add(e.target);
      adjacency.get(e.target)!.add(e.source);
    });
    instance.on('node:click', (event: any) => {
      const nodeId = event?.target?.id || event?.target?.getID?.() || event?.itemId;
      if (!nodeId) return;
      const neighbors = adjacency.get(String(nodeId)) || new Set<string>();
      const focus = new Set([String(nodeId), ...neighbors]);
      // 非邻接元素降透明，邻接保持高亮（G6 内置 dim/highlight 状态样式）
      instance.getNodeData().forEach((node) => {
        const id = node.id;
        if (!id) return;
        const isNeighbor = focus.has(String(id));
        instance.setElementState(id, isNeighbor ? ['highlight'] : ['dim']);
      });
      instance.getEdgeData().forEach((edge) => {
        const id = edge.id;
        const connected = focus.has(String(edge.source)) && focus.has(String(edge.target));
        if (id) instance.setElementState(id, connected ? ['highlight'] : ['dim']);
      });
    });
    instance.on('canvas:click', () => {
      [...instance.getNodeData(), ...instance.getEdgeData()].forEach((el) => {
        const id = el.id;
        if (id) instance.setElementState(id, []);
      });
    });

    instance.render();
    graphRef.current = instance;
    return () => {
      instance.destroy();
      if (graphRef.current === instance) graphRef.current = null;
    };
  }, [doc, template, height]);

  if (!doc || !doc.nodes.length) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无可预览的图谱数据" style={{ paddingTop: 80 }} />;
  }
  const trimmedCount = doc.nodes.length - MAX_PREVIEW_NODES;
  return (
    <div style={{ position: 'relative', height }}>
      <div
        ref={containerRef}
        style={{ height }}
        aria-label="图谱预览"
      />
      {trimmedCount > 0 && (
        <Tag color="warning" style={{ position: 'absolute', top: 8, right: 8, zIndex: 10 }}>
          预览裁剪：仅展示连接度最高的 {MAX_PREVIEW_NODES} 节点（共 {doc.nodes.length}，省 {trimmedCount}）
        </Tag>
      )}
    </div>
  );
}
