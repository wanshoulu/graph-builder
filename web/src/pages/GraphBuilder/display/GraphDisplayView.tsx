/**
 * 展示模式（基于 graph-intent-visual.html 可视化底层）：
 *   GraphDocument → 转换为 vis-network 格式 → postMessage 推送到 iframe
 *   节点选中/边选中 → postMessage 回传 → PropertyPanel 显示/编辑属性
 *   工具栏：搜索 / 适配 / 添加节点 / 连线 / 布局 / 折叠展开 / 图层 / 边过滤 / AI辅助 / 质量校验 / 保存 / 发布
 * 支持完整编辑：添加/修改/删除节点和边，连线（三态），撤销/重做，复制/粘贴，键盘快捷键,
 *   布局切换（力导向/树/径向/分栏/分层LR/TB），拖拽位置持久化，交互式折叠/展开，
 *   图层开关，边类型过滤，AI辅助建图，质量校验定位。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Panel, Group, Separator } from 'react-resizable-panels';
import { Button, Empty, Input, Modal, Select, Spin, Tag, Popover, Checkbox, Dropdown, Tooltip } from 'antd';
import { message } from '@/utils/antdStatic';
import {
  AimOutlined,
  DownloadOutlined,
  ExpandOutlined,
  PlusOutlined,
  RocketOutlined,
  SaveOutlined,
  UndoOutlined,
  RedoOutlined,
  CopyOutlined,
  SnippetsOutlined,
  LayoutOutlined,
  EyeOutlined,
  ExpandAltOutlined,
  ApartmentOutlined,
  ShrinkOutlined,
  BlockOutlined,
  AppstoreOutlined,
  GlobalOutlined,
  AlignLeftOutlined,
  UploadOutlined,
  FileImageOutlined,
  QuestionCircleOutlined,
  BarChartOutlined,
  SafetyOutlined,
  DownOutlined,
  EyeInvisibleOutlined,
  DiffOutlined,
  AuditOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  DatabaseOutlined,
} from '@ant-design/icons';
import { loadGraph, nodeReview, type GraphDocument, type GraphStatus, type GraphTemplate, type NodeReviewItem } from '@/api/orgGraph';
import {
  canvasToDocument,
  documentToCanvas,
  hasAnyPosition,
  type CanvasNode,
  type CanvasEdge,
  type CanvasGraph,
} from '../lib/graphDoc';
import { templateToEditorSchema, type EditorSchema } from '../lib/templateSchema';
import { applyCanvasVisuals, DOMAIN_TINTS, DOMAIN_TINT_FALLBACK } from '../lib/canvasVisuals';
import { buildTreeChildren, layoutDagre, layoutTree, layoutRadial, layoutColumns } from '../lib/layout';
import {
  computeVisibleGraph,
  filterLayerGraph,
  initialCollapseDepth,
  initialCollapsedSet,
  treeNodeIdSet,
  layerGroupOf,
  type LayerGroup,
} from '../lib/visible';
import { findEdgeByTriple, suggestEdgeTypes, rankEdgeTypes, type EdgeTypeRecommendation } from '../lib/edgeRules';
import { frameOrigin, isTrustedFrameMessage, postFrameMessage } from '../lib/frameBridge';
import { PropertyPanel, type SelectedElement } from '../manual/PropertyPanel';
import { AiAssistDrawer } from '../manual/AiAssistDrawer';
import { IntentTrialDrawer } from '../intentTrial/IntentTrialDrawer';
import { AddNodeModal } from '../manual/AddNodeModal';
import { SelectEdgeTypeModal } from '../manual/SelectEdgeTypeModal';
import { NodePalette } from '../manual/NodePalette';
import { DomainTreePanel } from '../manual/DomainTreePanel';
import {
  TemplateLibraryDrawer,
  loadNodeTemplates, saveNodeTemplate, removeNodeTemplate,
  loadSubgraphTemplates, saveSubgraphTemplate, removeSubgraphTemplate,
  extractNodeProperties,
  type SavedNodeTemplate, type SavedSubgraphTemplate,
} from '../manual/TemplateLibraryDrawer';
import {
  initialHistory,
  pushHistory,
  canUndo,
  canRedo,
  undo as undoHistory,
  redo as redoHistory,
  cloneSnapshot,
  type HistoryState,
} from '../manual/editorState';
import { layoutFruchterman, layoutConcentric, layoutGrid, layoutGeo } from '../lib/layout';
import {
  bfsShortestPath,
  findAllPaths,
  findConnectedComponents,
  detectCommunities,
  computeCentrality,
  computeDegreeDistribution,
  detectCycles,
  kCoreDecomposition,
  findNeighbors,
  findCommonNeighbors,
  jaccardSimilarity,
} from '../lib/graphAlgorithms';
import { exportCSV, exportJSONLD, exportRDFTurtle, exportGraphML } from '../lib/dataIO';
import { diffGraphDocuments, type GraphDiffResult, type NodeDiffEntry, type EdgeDiffEntry } from '../lib/graphDiff';
import { computeQualityScore, type QualityScore } from '../lib/qualityScore';
import { deriveV4NodeId, graphDocumentToV4, v4ToGraphDocument, readRegistries, type V41Graph } from '../lib/intentGraphV4';
import { ResourceRegistryDrawer, type V4Registries } from '../shared/ResourceRegistryDrawer';

interface GraphDisplayViewProps {
  asset: string;
  template: GraphTemplate;
  document: GraphDocument | null;
  loading: boolean;
  onDocumentChange: (document: GraphDocument) => void;
  status?: GraphStatus | null;
  dirty?: boolean;
  saving?: boolean;
  publishing?: boolean;
  onSave?: () => void;
  onValidate?: () => void;
  onPublish?: () => void;
  onDownloadDraftExcel?: () => void;
}

/** 构建工具 URL：同源网关（/tools/ → graph-builder 服务），不做端口改写 */
function toolsUrl(fileName: string): string {
  return `/tools/${fileName}`;
}

/** vis-network 节点调色板 */
const NODE_PALETTE = ['#5B8FF9','#5AD8A6','#5D7092','#F6BD16','#E8684A','#6DC8EC','#9270CA','#FF9D4D','#269A99','#FF99C3'];

/** graph-intent-visual.html 缓存破坏版本号（修改 HTML 后递增） */
const GRAPH_TOOL_VERSION = '20260922a';

/** 默认隐藏图层（与编辑画布一致：对象 + 约束·答案） */
const DEFAULT_HIDDEN_LAYERS = new Set<LayerGroup>(['objects', 'constraints']);

/** 布局模式 */
type LayoutMode = 'force' | 'tree' | 'radial' | 'columns' | 'dagre' | 'dagre-tb' | 'fruchterman' | 'concentric' | 'grid' | 'geo';

const LAYOUT_OPTIONS: { value: LayoutMode; label: string }[] = [
  { value: 'force', label: '力导向' },
  { value: 'fruchterman', label: 'Fruchterman' },
  { value: 'tree', label: '组织树' },
  { value: 'radial', label: '径向' },
  { value: 'concentric', label: '同心圆' },
  { value: 'columns', label: '类型分栏' },
  { value: 'grid', label: '网格' },
  { value: 'dagre', label: '分层·左右' },
  { value: 'dagre-tb', label: '分层·上下' },
  { value: 'geo', label: '地理坐标' },
];

/** 新节点 id（type + 时间戳，画布内唯一） */
function nextNodeId(nodeType: string): string {
  return `${nodeType}:${Date.now().toString(36)}${Math.floor(Math.random() * 1000).toString(36)}`;
}

/** 模板字段默认值（required 字段用 default，无 default 用空串） */
function nodeDefaults(template: GraphTemplate, nodeType: string): Record<string, unknown> {
  const nt = template.node_types.find((t) => t.type === nodeType);
  const properties: Record<string, unknown> = {};
  (nt?.fields || []).forEach((f) => {
    if (f.default !== undefined && f.default !== null && f.default !== '') properties[f.key] = f.default;
  });
  return properties;
}

/** 模板边字段默认值 */
function edgeDefaults(template: GraphTemplate, edgeType: string): Record<string, unknown> {
  const et = template.edge_types.find((t) => t.type === edgeType);
  const properties: Record<string, unknown> = {};
  (et?.fields || []).forEach((f) => {
    if (f.default !== undefined && f.default !== null && f.default !== '') properties[f.key] = f.default;
  });
  return properties;
}

/** 版本 diff 可视化标记类型 */
type VersionDiffKind = 'added' | 'modified';

/** 单个 CanvasNode → vis-network 节点格式 */
function transformNode(n: CanvasNode, schema: EditorSchema, diffKind?: VersionDiffKind | null) {
  const nodeType = String(n.data.nodeType || '');
  const label = String(n.data.name || n.data.title || n.id);
  const color = String(n.data.nodeColor || schema.nodeColors[nodeType] || NODE_PALETTE[0]);
  const degree = Number(n.data.degree || 0);
  // AI置信度→边框透明度：confidence<0.5虚线边框，≥0.8加粗
  const confidence = Number(n.data.confidence ?? 1);
  const reviewStatus = String(n.data.review_status || '');
  const provenance = String(n.data.provenance || '');
  // review_status: pending→橙色虚线, rejected→红色, approved→绿色, AI生成→蓝色虚线
  let borderColor = color;
  let borderWidth = 1;
  let borderDashes: boolean | number[] = false;
  let shadow: { enabled: boolean; color?: string; size?: number; x?: number; y?: number } | undefined = undefined;

  // 版本 diff 标记优先级最高
  if (diffKind === 'added') {
    borderColor = '#52c41a'; borderWidth = 3;
    shadow = { enabled: true, color: 'rgba(82,196,26,0.6)', size: 15 };
  } else if (diffKind === 'modified') {
    borderColor = '#faad14'; borderWidth = 3; borderDashes = [6, 3];
    shadow = { enabled: true, color: 'rgba(250,173,20,0.5)', size: 12 };
  } else if (reviewStatus === 'pending' || reviewStatus === '待审核') {
    borderColor = '#fa8c16'; borderWidth = 2; borderDashes = [5, 3];
  } else if (reviewStatus === 'rejected' || reviewStatus === '已驳回') {
    borderColor = '#f5222d'; borderWidth = 2;
  } else if (reviewStatus === 'approved' || reviewStatus === '已审核') {
    borderColor = '#52c41a'; borderWidth = 2;
  } else if (confidence < 0.5) {
    borderColor = '#fa8c16'; borderWidth = 1; borderDashes = [3, 3];
  }
  // AI生成节点加provenance标记到title
  const aiTag = provenance === 'ai' || provenance === 'AI' ? '🤖' : '';
  const confTag = confidence < 1 ? ` [${(confidence * 100).toFixed(0)}%]` : '';
  const diffTag = diffKind === 'added' ? '🟢新增' : diffKind === 'modified' ? '🟡修改' : '';
  return {
    id: n.id,
    label,
    fullLabel: label,
    title: (aiTag || confTag || diffTag) ? `${diffTag ? diffTag + ' ' : ''}${aiTag} ${label}${confTag}${reviewStatus ? ` · ${reviewStatus}` : ''}` : undefined,
    nodeType,
    domain: String(n.data.domain || ''),
    color: { background: color, border: borderColor, highlight: { background: color, border: borderColor } },
    borderWidth,
    borderDashes,
    shadow,
    shape: 'dot',
    size: Math.max(8, Math.min(30, 8 + degree * 1.5)),
    x: n.position?.x,
    y: n.position?.y,
  };
}

/** 可见子图 → graph-intent-visual.html 所需的 graphData 格式 */
function transformCanvas(canvas: CanvasGraph, schema: EditorSchema, diffNodeMap?: Map<string, VersionDiffKind> | null) {
  const graphNodes = canvas.nodes.map(n => transformNode(n, schema, diffNodeMap?.get(n.id) || null));
  const graphEdges = canvas.edges.map(e => ({
    id: e.id,
    from: e.source,
    to: e.target,
    label: e.label || undefined,
  }));

  const typeDist: Record<string, number> = {};
  const domainDist: Record<string, number> = {};
  graphNodes.forEach(n => {
    const t = n.nodeType || 'unknown';
    typeDist[t] = (typeDist[t] || 0) + 1;
    const d = String(n.domain || '未知');
    domainDist[d] = (domainDist[d] || 0) + 1;
  });

  return {
    graph: { nodes: graphNodes, edges: graphEdges },
    summary: {
      total_nodes: graphNodes.length,
      domain_distribution: domainDist,
      action_distribution: typeDist,
      domain_nodes: Object.keys(domainDist).length,
    },
    meta: { version: '' },
  };
}

/** 右键菜单状态 */
interface ContextMenuState {
  kind: 'node' | 'edge' | 'canvas';
  nodeId?: string;
  edgeId?: string;
  x: number;
  y: number;
}

interface ContextMenuItem {
  key: string;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}

export function GraphDisplayView({
  asset,
  template,
  document: doc,
  loading,
  onDocumentChange,
  status,
  dirty,
  saving,
  publishing,
  onSave,
  onValidate,
  onPublish,
  onDownloadDraftExcel,
}: GraphDisplayViewProps) {
  const schema = useMemo(() => templateToEditorSchema(template), [template]);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const iframeReadyRef = useRef(false);
  const iframeSrc = `${toolsUrl('graph-intent-visual.html')}?embed=1&_v=${GRAPH_TOOL_VERSION}`;
  const iframeTargetOrigin = frameOrigin(iframeSrc, window.location.href);
  const sendToIframe = useCallback((message: unknown) => {
    return postFrameMessage(
      iframeRef.current?.contentWindow,
      message,
      iframeTargetOrigin,
      iframeReadyRef.current,
    );
  }, [iframeTargetOrigin]);
  const pendingDataRef = useRef<{ graph: { nodes: unknown[]; edges: unknown[] }; summary: Record<string, unknown>; meta: Record<string, unknown> } | null>(null);
  const pendingMessagesRef = useRef<unknown[]>([]);
  const fullNodesRef = useRef<CanvasNode[]>([]);
  const fullEdgesRef = useRef<CanvasEdge[]>([]);
  const producedRef = useRef<GraphDocument | null>(null);

  const [nodes, setNodes] = useState<CanvasNode[]>([]);
  const [edges, setEdges] = useState<CanvasEdge[]>([]);
  const [selected, setSelected] = useState<SelectedElement | null>(null);
  const loadingRef = useRef(loading);
  loadingRef.current = loading;
  const [iframeError, setIframeError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [assistOpen, setAssistOpen] = useState(false);
  const [assistGroupNodeId, setAssistGroupNodeId] = useState<string | undefined>(undefined);
  const [assistAutoStart, setAssistAutoStart] = useState(false);
  const [trialOpen, setTrialOpen] = useState(false);
  const [editingInField, setEditingInField] = useState(false);

  // 逐字段 AI 审核（按元素 key + groupKey 存储建议，切换元素保留历史）
  const [nodeReviewRunningGroups, setNodeReviewRunningGroups] = useState<Set<string>>(new Set());
  const [nodeReviewMap, setNodeReviewMap] = useState<Record<string, Record<string, NodeReviewItem[]>>>({});

  // 添加节点弹窗
  const [addNodeOpen, setAddNodeOpen] = useState(false);
  const [addNodePosition, setAddNodePosition] = useState<{ x: number; y: number } | undefined>(undefined);
  const [addNodeParentId, setAddNodeParentId] = useState<string | undefined>(undefined);

  // 连线模式
  const [connectMode, setConnectMode] = useState(false);

  // 连线到空白：选择目标节点类型
  const [connectCanvasOpen, setConnectCanvasOpen] = useState(false);
  const [connectCanvasSource, setConnectCanvasSource] = useState<string | null>(null);
  const [connectCanvasPosition, setConnectCanvasPosition] = useState<{ x: number; y: number } | null>(null);

  // 边类型选择弹窗
  const [edgeTypeModal, setEdgeTypeModal] = useState<{
    source: string;
    target: string;
    sourceName: string;
    targetName: string;
    candidates: string[];
    recommendations?: EdgeTypeRecommendation[];
  } | null>(null);

  // 右键菜单
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  // 撤销/重做
  const [history, setHistory] = useState<HistoryState | null>(null);
  const historyRef = useRef<HistoryState | null>(null);
  historyRef.current = history;

  // 布局模式
  const [layoutMode, setLayoutMode] = useState<LayoutMode>(
    (template.layout?.default_layout as LayoutMode) || (template.layout?.tree_edges?.length ? 'tree' : 'dagre')
  );

  // 折叠状态
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    const canvas = doc ? documentToCanvas(doc) : { nodes: [], edges: [] };
    const treeEdgeDefs = template.layout?.tree_edges?.length ? template.layout.tree_edges : null;
    if (!treeEdgeDefs || !doc) return new Set();
    const treeParent = template.layout?.tree_parent || 'source';
    const ch = buildTreeChildren(canvas.edges, treeEdgeDefs, treeParent);
    if (ch.size === 0) return new Set();
    const configuredDepth = template.layout?.initial_collapse_depth ?? 3;
    return initialCollapsedSet(canvas.nodes, ch, initialCollapseDepth(canvas.nodes.length, configuredDepth));
  });

  // 图层开关
  const [hiddenLayers, setHiddenLayers] = useState<Set<LayerGroup>>(new Set(DEFAULT_HIDDEN_LAYERS));

  // 边类型显隐
  const allEdgeTypes = useMemo(() => template.edge_types.map(e => e.type), [template]);
  const [hiddenEdgeTypes, setHiddenEdgeTypes] = useState<Set<string>>(new Set(
    (template.layout?.default_hidden_edges as string[] || []).filter(e => typeof e === 'string')
  ));

  // 节点类型显隐（右侧概览面板：AGGREGATE_INTENT/INTENT 等可勾选隐藏）
  const allNodeTypes = useMemo(() => template.node_types.map(n => n.type), [template]);
  const [hiddenNodeTypes, setHiddenNodeTypes] = useState<Set<string>>(new Set());

  // 剪贴板（支持单节点 / 单边（含端点） / 子图 / 全图）
  type ClipboardData = { kind: 'node' | 'subgraph'; nodes: CanvasNode[]; edges: CanvasEdge[] };
  const clipboardRef = useRef<ClipboardData | null>(null);

  // 树面板开关
  const [treeOpen, setTreeOpen] = useState(true);
  // 框选多选
  const [multiSelected, setMultiSelected] = useState<string[] | null>(null);

  // P1: 模板库
  const [tplDrawerOpen, setTplDrawerOpen] = useState(false);
  const [nodeTemplates, setNodeTemplates] = useState<SavedNodeTemplate[]>([]);
  const [subgraphTemplates, setSubgraphTemplates] = useState<SavedSubgraphTemplate[]>([]);

  // P3: 画布体验增强
  const [minimapOpen, setMinimapOpen] = useState(false);
  const [alignGuidesEnabled, setAlignGuidesEnabled] = useState(false);

  // 快捷优化：导出 PNG / 快捷键帮助 / 统计面板
  const exportingPNGRef = useRef(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [registryOpen, setRegistryOpen] = useState(false);

  /** V4.1 功能节点×场景制资产（intent-graph-v4）：启用 V4 id 派生 / 场景卡 / 资源注册表 / V4.1 导入导出 */
  const isV4Asset = asset === 'intent-graph-v4' || template.template_id === 'intent-graph-v4';
  const [statsOpen, setStatsOpen] = useState(true);

  // 图分析面板
  const [analysisOpen, setAnalysisOpen] = useState(false);
  const [analysisType, setAnalysisType] = useState<'centrality' | 'communities' | 'connected' | 'cycles' | 'kcore' | 'degree'>('centrality');
  const [analysisResult, setAnalysisResult] = useState<{ label: string; items: Array<{ id: string; label: string; value: string | number; extra?: string }> } | null>(null);

  // AI生成结果 diff 审查
  const [pendingMerge, setPendingMerge] = useState<GraphDocument | null>(null);
  const [mergeDiff, setMergeDiff] = useState<GraphDiffResult | null>(null);
  const [diffRejectedNodes, setDiffRejectedNodes] = useState<Set<string>>(new Set());
  const [diffRejectedEdges, setDiffRejectedEdges] = useState<Set<string>>(new Set());

  // 版本 diff 画布可视化
  const [versionDiffOpen, setVersionDiffOpen] = useState(false);
  const [compareVersion, setCompareVersion] = useState<string>('');
  const [versionDiffResult, setVersionDiffResult] = useState<GraphDiffResult | null>(null);
  const [loadingVersionDiff, setLoadingVersionDiff] = useState(false);

  // 批量审阅工作流
  const [batchReviewOpen, setBatchReviewOpen] = useState(false);
  const [batchSelectedIds, setBatchSelectedIds] = useState<Set<string>>(new Set());

  // 发布前预览
  const [publishPreviewOpen, setPublishPreviewOpen] = useState(false);
  const [publishPreviewDiff, setPublishPreviewDiff] = useState<GraphDiffResult | null>(null);
  const [loadingPublishPreview, setLoadingPublishPreview] = useState(false);

  // handler ref：消息监听器通过 ref 调用最新函数，避免 useEffect([]) 闭包陈旧
  const handlersRef = useRef<{
    handleConnect: (source: string, target: string) => void;
    handleDragEnd: (positions: { id: string; x: number; y: number }[]) => void;
  }>({ handleConnect: () => {}, handleDragEnd: () => {} });

  // 树边定义
  const treeEdgeDefs = template.layout?.tree_edges?.length ? template.layout.tree_edges : null;
  const treeParent = template.layout?.tree_parent || 'source';

  // 树子节点邻接表（memo 化）
  const treeChildren = useMemo(() => {
    if (!treeEdgeDefs || !doc) return null;
    const canvas = documentToCanvas(doc);
    return buildTreeChildren(canvas.edges, treeEdgeDefs, treeParent);
  }, [doc, treeEdgeDefs, treeParent]);

  /** 领域泳道（树布局下按域着色） */
  const swimlanes = useMemo(() => {
    if (layoutMode !== 'tree' || !treeChildren) return [];
    const treeNodeIds = treeNodeIdSet(treeChildren);
    const byDomain = new Map<string, CanvasNode[]>();
    nodes.forEach((n) => {
      if (!treeNodeIds.has(n.id)) return;
      const d = String(n.data.domain || '');
      if (!d) return;
      const list = byDomain.get(d) || [];
      list.push(n);
      byDomain.set(d, list);
    });
    const out: { domain: string; color: string; box: { x: number; y: number; w: number; h: number } }[] = [];
    byDomain.forEach((list, domain) => {
      if (list.length < 2) return;
      const xs = list.map(n => n.position?.x || 0);
      const ys = list.map(n => n.position?.y || 0);
      const x0 = Math.min(...xs) - 40;
      const y0 = Math.min(...ys) - 28;
      const x1 = Math.max(...xs) + 40;
      const y1 = Math.max(...ys) + 28;
      out.push({ domain, color: DOMAIN_TINTS[domain] || DOMAIN_TINT_FALLBACK, box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } });
    });
    return out;
  }, [layoutMode, treeChildren, nodes]);

  useEffect(() => {
    sendToIframe({ type: 'setSwimlanes', lanes: swimlanes });
  }, [sendToIframe, swimlanes]);

  // P3-2: 对齐辅助线开关 → 通知 iframe
  useEffect(() => {
    sendToIframe({ type: 'setAlignmentGuides', enabled: alignGuidesEnabled, threshold: 8 });
  }, [alignGuidesEnabled, sendToIframe]);

  /** 获取当前可见子图（含折叠+图层+节点类型+边类型过滤） */
  const computeVisible = useCallback((docArg: GraphDocument, collapsedArg: Set<string>, hiddenLayersArg: Set<LayerGroup>, hiddenEdgeTypesArg: Set<string>, hiddenNodeTypesArg?: Set<string>): CanvasGraph => {
    const canvas = applyCanvasVisuals(documentToCanvas(docArg), schema);
    const treeParentVal = template.layout?.tree_parent || 'source';
    let result = canvas;

    if (treeEdgeDefs) {
      const ch = buildTreeChildren(canvas.edges, treeEdgeDefs, treeParentVal);
      if (ch.size > 0) {
        const visible = computeVisibleGraph(canvas.nodes, canvas.edges, ch, collapsedArg);
        result = filterLayerGraph(visible.nodes, visible.edges, treeNodeIdSet(ch), hiddenLayersArg);
      }
    }

    // 节点类型过滤（右侧概览面板勾选）
    if (hiddenNodeTypesArg && hiddenNodeTypesArg.size > 0) {
      result = {
        nodes: result.nodes.filter(n => !hiddenNodeTypesArg.has(String((n.data as Record<string, unknown>).nodeType || ''))),
        edges: result.edges,
      };
      const keptIds = new Set(result.nodes.map(n => n.id));
      result = { ...result, edges: result.edges.filter(e => keptIds.has(e.source) && keptIds.has(e.target)) };
    }

    // 边类型过滤
    if (hiddenEdgeTypesArg.size > 0) {
      result = {
        nodes: result.nodes,
        edges: result.edges.filter(e => !hiddenEdgeTypesArg.has(String(e.data.edgeType || e.label || ''))),
      };
    }

    if (result.nodes.length > 1 && !hasAnyPosition(result.nodes) && layoutMode !== 'force') {
      let positioned: CanvasNode[];
      if (layoutMode === 'tree') {
        const visibleTree = treeEdgeDefs
          ? buildTreeChildren(result.edges, treeEdgeDefs, treeParentVal)
          : new Map<string, string[]>();
        positioned = visibleTree.size > 0
          ? layoutTree(result.nodes, visibleTree)
          : layoutDagre(result.nodes, result.edges, { rankdir: 'TB' });
      } else if (layoutMode === 'radial') {
        positioned = layoutRadial(result.nodes, result.edges);
      } else if (layoutMode === 'columns') {
        positioned = layoutColumns(result.nodes, template.node_types.map((type) => type.type));
      } else {
        positioned = layoutDagre(result.nodes, result.edges, { rankdir: layoutMode === 'dagre-tb' ? 'TB' : 'LR' });
      }
      result = { ...result, nodes: positioned };
    }

    return result;
  }, [layoutMode, schema, template, treeEdgeDefs]);

  /** 全量重载 iframe（可见子图 → vis 格式 → postMessage） */
  const diffNodeKindMap = useMemo(() => {
    if (!versionDiffResult) return null;
    const m = new Map<string, VersionDiffKind>();
    for (const entry of versionDiffResult.nodes) {
      if (entry.kind === 'added' || entry.kind === 'modified') {
        m.set(entry.id, entry.kind);
      }
    }
    return m;
  }, [versionDiffResult]);

  const reloadIframe = useCallback((visibleCanvas: CanvasGraph) => {
    const graphData = transformCanvas(visibleCanvas, schema, diffNodeKindMap);
    pendingDataRef.current = graphData;
    if (iframeReadyRef.current && iframeRef.current?.contentWindow) {
      sendToIframe({ type: 'reloadGraph', payload: graphData });
    }
  }, [schema, sendToIframe, diffNodeKindMap]);

  // 文档变更 → 画布数据 + iframe 数据
  useEffect(() => {
    if (loadingRef.current) return;
    if (!doc) {
      setNodes([]); setEdges([]); setSelected(null);
      pendingDataRef.current = null;
      fullNodesRef.current = []; fullEdgesRef.current = [];
      return;
    }
    if (producedRef.current === doc) {
      producedRef.current = null;
      return;
    }
    // 全量画布保留在 ref，可见子图用于展示
    const fullCanvas = applyCanvasVisuals(documentToCanvas(doc), schema);
    fullNodesRef.current = fullCanvas.nodes;
    fullEdgesRef.current = fullCanvas.edges;

    const visibleCanvas = computeVisible(doc, collapsed, hiddenLayers, hiddenEdgeTypes, hiddenNodeTypes);
    setNodes(visibleCanvas.nodes);
    setEdges(visibleCanvas.edges);
    setSelected(null);

    // 初始化历史栈
    if (!historyRef.current) {
      setHistory(initialHistory(cloneSnapshot({ nodes: fullCanvas.nodes, edges: fullCanvas.edges })));
    }

    reloadIframe(visibleCanvas);
  }, [doc, schema, template, collapsed, hiddenLayers, hiddenEdgeTypes, hiddenNodeTypes, computeVisible, reloadIframe]);

  // 监听 iframe 消息
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (!isTrustedFrameMessage(e, iframeRef.current?.contentWindow, iframeTargetOrigin)) return;
      const msg = e.data;
      if (msg.type === 'graphReady') {
        iframeReadyRef.current = true;
        if (pendingDataRef.current && iframeRef.current?.contentWindow) {
          sendToIframe({ type: 'setPhysics', enabled: layoutMode === 'force' });
          sendToIframe({ type: 'loadGraph', payload: pendingDataRef.current });
          sendToIframe({ type: 'setSwimlanes', lanes: swimlanes });
          sendToIframe({ type: 'setAlignmentGuides', enabled: alignGuidesEnabled, threshold: 8 });
        }
        // flush 增量消息队列（iframe 未就绪期间积攒的 addNode/updateNode/removeNode/addEdge/removeEdge）
        if (pendingMessagesRef.current.length) {
          const queue = pendingMessagesRef.current;
          pendingMessagesRef.current = [];
          queue.forEach(m => sendToIframe(m));
        }
      } else if (msg.type === 'graphLoaded') {
        // ok
      } else if (msg.type === 'graphError') {
        setIframeError(msg.error || '未知错误');
      } else if (msg.type === 'nodeSelected' && msg.nodeId) {
        const n = fullNodesRef.current.find(x => x.id === msg.nodeId);
        if (n) setSelected({ kind: 'node', id: n.id, data: n.data });
      } else if (msg.type === 'edgeSelected' && msg.edgeId) {
        const e2 = fullEdgesRef.current.find(x => x.id === msg.edgeId);
        if (e2) setSelected({ kind: 'edge', id: e2.id, data: e2.data });
      } else if (msg.type === 'addNodeRequest' && msg.pointer) {
        setAddNodePosition(msg.pointer);
        setAddNodeParentId(undefined);
        setAddNodeOpen(true);
      } else if (msg.type === 'connectRequest' && msg.source && msg.target) {
        handlersRef.current.handleConnect(msg.source, msg.target);
      } else if (msg.type === 'connectToCanvasRequest' && msg.source && msg.pointer) {
        // 连线模式下点击空白：弹出类型选择，创建新节点并连线
        setConnectCanvasSource(msg.source);
        setConnectCanvasPosition(msg.pointer);
        setConnectCanvasOpen(true);
      } else if (msg.type === 'contextMenu') {
        // iframe 内 clientX/clientY 是相对 iframe 视口的，需加上 iframe 在页面中的偏移
        const iframeRect = iframeRef.current?.getBoundingClientRect();
        setContextMenu({
          kind: msg.kind,
          nodeId: msg.nodeId || undefined,
          edgeId: msg.edgeId || undefined,
          x: (msg.pointer?.x || 0) + (iframeRect?.left || 0),
          y: (msg.pointer?.y || 0) + (iframeRect?.top || 0),
        });
      } else if (msg.type === 'dragEnd' && msg.positions) {
        handlersRef.current.handleDragEnd(msg.positions);
      } else if (msg.type === 'selectionChanged') {
        setMultiSelected(msg.nodeIds?.length > 1 ? msg.nodeIds : null);
      } else if (msg.type === 'imageData' && msg.dataUrl && exportingPNGRef.current) {
        exportingPNGRef.current = false;
        try {
          const a = document.createElement('a');
          a.href = msg.dataUrl;
          a.download = `${asset || 'graph'}-${new Date().toISOString().slice(0, 10)}.png`;
          a.click();
          message.success('PNG 图片已导出');
        } catch {
          message.error('图片下载失败');
        }
      } else if (msg.type === 'imageError' && exportingPNGRef.current) {
        exportingPNGRef.current = false;
        message.error(msg.error || '图片导出失败');
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [alignGuidesEnabled, iframeTargetOrigin, layoutMode, sendToIframe, swimlanes]);

  /** 快照压入历史栈 */
  const pushSnapshot = useCallback(() => {
    if (!historyRef.current) return;
    const snap = cloneSnapshot({ nodes: fullNodesRef.current, edges: fullEdgesRef.current });
    setHistory(pushHistory(historyRef.current, snap));
  }, []);

  /** 画布 → 文档 → 通知父级（标记 producedRef 防回流） */
  const syncToParent = useCallback((nextNodes: CanvasNode[], nextEdges: CanvasEdge[]) => {
    const newDoc = canvasToDocument({ nodes: nextNodes, edges: nextEdges }, template, producedRef.current || doc || undefined);
    producedRef.current = newDoc;
    onDocumentChange(newDoc);
  }, [template, onDocumentChange, doc]);

  /** 增量 postMessage 发送函数（iframe 未就绪时加入 pending 队列，ready 后统一 flush） */
  const sendAddNode = useCallback((node: CanvasNode) => {
    const visNode = transformNode(node, schema);
    const msg = { type: 'addNode', node: visNode };
    if (!iframeReadyRef.current) { pendingMessagesRef.current.push(msg); return; }
    sendToIframe(msg);
  }, [schema, sendToIframe]);

  const sendUpdateNode = useCallback((id: string, patch: Record<string, unknown>) => {
    const msg = { type: 'updateNode', node: { id, ...patch } };
    if (!iframeReadyRef.current) { pendingMessagesRef.current.push(msg); return; }
    sendToIframe(msg);
  }, [sendToIframe]);

  const sendRemoveNode = useCallback((id: string) => {
    const msg = { type: 'removeNode', nodeId: id };
    if (!iframeReadyRef.current) { pendingMessagesRef.current.push(msg); return; }
    sendToIframe(msg);
  }, [sendToIframe]);

  const sendAddEdge = useCallback((edge: CanvasEdge) => {
    const msg = { type: 'addEdge', edge: { id: edge.id, from: edge.source, to: edge.target, label: edge.label || undefined } };
    if (!iframeReadyRef.current) { pendingMessagesRef.current.push(msg); return; }
    sendToIframe(msg);
  }, [sendToIframe]);

  const sendRemoveEdge = useCallback((id: string) => {
    const msg = { type: 'removeEdge', edgeId: id };
    if (!iframeReadyRef.current) { pendingMessagesRef.current.push(msg); return; }
    sendToIframe(msg);
  }, [sendToIframe]);

  /** 树骨架边类型查找（加子节点用） */
  function childEdgeTypeFor(parentId: string, childType: string): string | null {
    const parent = fullNodesRef.current.find(n => n.id === parentId);
    if (!parent) return null;
    const candidates = suggestEdgeTypes(template, String(parent.data.nodeType || ''), childType);
    if (!candidates.length) return null;
    const treeTypes = treeEdgeDefs ? treeEdgeDefs.map(d => typeof d === 'string' ? d : d.type) : [];
    const preferred = candidates.filter(c => treeTypes.indexOf(c) >= 0);
    return preferred[0] || candidates[0] || null;
  }

  function edgeEndsFor(edgeType: string, parentId: string, childId: string): { source: string; target: string } {
    const decl = treeEdgeDefs ? treeEdgeDefs.find(d => (typeof d === 'string' ? d : d.type) === edgeType) : undefined;
    const parentEnd = decl ? (typeof decl === 'string' ? treeParent : decl.parent || treeParent) : 'source';
    return parentEnd === 'source' ? { source: parentId, target: childId } : { source: childId, target: parentId };
  }

  /** 添加节点 */
  function handleAddNode(nodeType: string, _position?: { x: number; y: number }, parentId?: string, extraProperties?: Record<string, unknown>) {
    pushSnapshot();
    // V4.1 资产：子 id 必须以「父id.」为前缀（校验第 3 条），由 title 派生 slug（无 ASCII 时 hash）
    const id = isV4Asset
      ? deriveV4NodeId(nodeType, parentId || null, String((extraProperties || {}).title || ''), new Set(fullNodesRef.current.map((n) => n.id)))
      : nextNodeId(nodeType);
    const pos = _position || { x: 80 + fullNodesRef.current.length * 32, y: 80 + fullNodesRef.current.length * 32 };
    const node: CanvasNode = {
      id,
      position: pos,
      data: {
        id, nodeType,
        ...nodeDefaults(template, nodeType),
        ...(extraProperties || {}),
        nodeColor: schema.nodeColors[nodeType],
        provenance: { source: 'manual' },
        review_status: 'accepted',
      },
    };
    const nextFullNodes = [...fullNodesRef.current, node];
    fullNodesRef.current = nextFullNodes;
    let nextFullEdges = fullEdgesRef.current;
    if (parentId) {
      const edgeType = childEdgeTypeFor(parentId, nodeType);
      if (edgeType) {
        const { source, target } = edgeEndsFor(edgeType, parentId, id);
        const eid = `edge:${Date.now().toString(36)}${Math.floor(Math.random() * 1000).toString(36)}`;
        const childEdge: CanvasEdge = {
          id: eid, source, target, label: edgeType,
          data: { id: eid, edgeType, ...edgeDefaults(template, edgeType), provenance: { source: 'manual' }, review_status: 'accepted' },
        };
        nextFullEdges = [...nextFullEdges, childEdge];
        fullEdgesRef.current = nextFullEdges;
        sendAddEdge(childEdge);
      }
    }
    setNodes(prev => [...prev, node]);
    sendAddNode(node);
    setSelected({ kind: 'node', id, data: node.data });
    syncToParent(nextFullNodes, nextFullEdges);
    message.success(`已添加 ${nodeType} 节点${parentId ? '并挂到父节点' : ''}，请在右侧填写属性`);
  }

  /** 三态连线 */
  function handleConnect(source: string, target: string) {
    if (source === target) { message.error('不允许自环边'); return; }
    const srcNode = fullNodesRef.current.find(n => n.id === source);
    const tgtNode = fullNodesRef.current.find(n => n.id === target);
    if (!srcNode || !tgtNode) { message.error('端点节点不存在'); return; }
    const candidates = suggestEdgeTypes(template, String(srcNode.data.nodeType || ''), String(tgtNode.data.nodeType || ''));
    if (candidates.length === 0) {
      message.error(`${srcNode.data.nodeType} → ${tgtNode.data.nodeType} 没有模板允许的边类型，已取消连线`);
      return;
    }
    if (candidates.length === 1) { createEdge(source, target, candidates[0]); return; }
    const srcName = String(srcNode.data.name || srcNode.data.title || source);
    const tgtName = String(tgtNode.data.name || tgtNode.data.title || target);
    const srcType = String(srcNode.data.nodeType || '');
    const tgtType = String(tgtNode.data.nodeType || '');
    const recommendations = rankEdgeTypes(template, candidates, srcName, tgtName, srcType, tgtType);
    setEdgeTypeModal({
      source, target,
      sourceName: srcName,
      targetName: tgtName,
      candidates,
      recommendations,
    });
  }

  /** 拖拽位置回传 */
  function handleDragEnd(positions: { id: string; x: number; y: number }[]) {
    // P3-3: 拖拽操作纳入撤销栈
    pushSnapshot();

    // P3-2: 拖拽后对齐吸附（x/y 与其他节点差值 < 8px 则对齐）
    const ALIGN_THRESHOLD = 8;
    const snapped = positions.map(p => ({ ...p }));
    if (alignGuidesEnabled) {
      const draggedIds = new Set(positions.map(p => p.id));
      for (const pos of snapped) {
        let bestX: number | null = null;
        let bestXDist = ALIGN_THRESHOLD;
        let bestY: number | null = null;
        let bestYDist = ALIGN_THRESHOLD;
        for (const n of fullNodesRef.current) {
          if (draggedIds.has(n.id)) continue;
          const nx = n.position?.x ?? 0;
          const ny = n.position?.y ?? 0;
          const dx = Math.abs(pos.x - nx);
          const dy = Math.abs(pos.y - ny);
          if (dx < bestXDist) { bestX = nx; bestXDist = dx; }
          if (dy < bestYDist) { bestY = ny; bestYDist = dy; }
        }
        if (bestX !== null) pos.x = bestX;
        if (bestY !== null) pos.y = bestY;
      }
      // 将吸附后的位置同步回 iframe
      snapped.forEach((p, i) => {
        if (p.x !== positions[i].x || p.y !== positions[i].y) {
          sendUpdateNode(p.id, { x: p.x, y: p.y });
        }
      });
    }

    const posMap = new Map(snapped.map(p => [p.id, { x: p.x, y: p.y }]));
    const nextFull = fullNodesRef.current.map(n => {
      const p = posMap.get(n.id);
      return p ? { ...n, position: p } : n;
    });
    fullNodesRef.current = nextFull;
    setNodes(prev => prev.map(n => {
      const p = posMap.get(n.id);
      return p ? { ...n, position: p } : n;
    }));
    syncToParent(nextFull, fullEdgesRef.current);
  }

  /* handlersRef 赋值移入 useEffect 避免渲染期副作用 */
  useEffect(() => {
    handlersRef.current.handleConnect = handleConnect;
    handlersRef.current.handleDragEnd = handleDragEnd;
  });

  function createEdge(source: string, target: string, edgeType: string) {
    if (findEdgeByTriple(fullEdgesRef.current, source, target, edgeType)) {
      message.warning('相同端点与类型的边已存在');
      return;
    }
    pushSnapshot();
    const id = `edge:${Date.now().toString(36)}${Math.floor(Math.random() * 1000).toString(36)}`;
    const edge: CanvasEdge = {
      id, source, target, label: edgeType,
      data: { id, edgeType, ...edgeDefaults(template, edgeType), provenance: { source: 'manual' }, review_status: 'accepted' },
    };
    const nextFullEdges = [...fullEdgesRef.current, edge];
    fullEdgesRef.current = nextFullEdges;
    setEdges(prev => [...prev, edge]);
    sendAddEdge(edge);
    setSelected({ kind: 'edge', id, data: edge.data });
    syncToParent(fullNodesRef.current, nextFullEdges);
    message.success(`已创建 ${edgeType} 边`);
  }

  /** 属性编辑 */
  function handleFieldChange(field: string, value: unknown) {
    if (!selected) return;
    pushSnapshot();
    if (selected.kind === 'node') {
      const nextFull = fullNodesRef.current.map(n => {
        if (n.id !== selected.id) return n;
        return { ...n, data: { ...n.data, [field]: value } };
      });
      fullNodesRef.current = nextFull;
      setNodes(prev => prev.map(n => n.id === selected.id ? { ...n, data: { ...n.data, [field]: value } } : n));
      const updated = nextFull.find(n => n.id === selected.id);
      if (updated) {
        sendUpdateNode(selected.id, { label: String(updated.data.name || updated.data.title || updated.id) });
        setSelected({ kind: 'node', id: selected.id, data: updated.data });
      }
      syncToParent(nextFull, fullEdgesRef.current);
    } else {
      const nextFull = fullEdgesRef.current.map(e => {
        if (e.id !== selected.id) return e;
        const data = { ...e.data, [field]: value };
        return { ...e, data, label: field === 'edgeType' ? String(value ?? '') : e.label };
      });
      fullEdgesRef.current = nextFull;
      setEdges(prev => prev.map(e => {
        if (e.id !== selected.id) return e;
        const found = nextFull.find(x => x.id === e.id);
        return found || e;
      }));
      const updated = nextFull.find(e => e.id === selected.id);
      if (updated) setSelected({ kind: 'edge', id: selected.id, data: updated.data });
      syncToParent(fullNodesRef.current, nextFull);
    }
    // 手动编辑字段后清除该字段的审核建议（已过时）
    const rk = `${selected.kind}:${selected.id}`;
    setNodeReviewMap(prev => {
      const groupMap = prev[rk];
      if (!groupMap) return prev;
      let changed = false;
      const nextGroupMap: Record<string, NodeReviewItem[]> = {};
      for (const [gk, items] of Object.entries(groupMap)) {
        const filtered = items.filter(it => it.payload.field !== field);
        if (filtered.length !== items.length) changed = true;
        nextGroupMap[gk] = filtered;
      }
      return changed ? { ...prev, [rk]: nextGroupMap } : prev;
    });
  }

  /** AI 补全项采纳/拒绝 */
  function handleAiAction(field: string, index: number, action: 'accept' | 'reject') {
    if (!selected || selected.kind !== 'node') return;
    const raw = selected.data.raw as Record<string, unknown> | undefined;
    const aiPatch = raw?._aiPatch as Record<string, unknown> | undefined;
    if (!aiPatch) return;
    const fieldAi = aiPatch[field];
    if (!Array.isArray(fieldAi)) return;
    const indices = fieldAi as number[];

    if (action === 'accept') {
      const newIndices = indices.filter((i) => i !== index);
      const newPatch = { ...aiPatch, [field]: newIndices.length > 0 ? newIndices : undefined };
      const patch = newPatch as Record<string, unknown>;
      if (newIndices.length === 0) delete patch[field];
      const newRaw = Object.keys(patch).length > 0 ? { ...raw, _aiPatch: patch } : (() => { const r = { ...raw }; delete (r as Record<string, unknown>)._aiPatch; return r; })();
      handleFieldChange('raw', newRaw);
      return;
    }

    /* 拒绝：删除数组项 + 调整索引 */
    const arr = selected.data[field];
    if (!Array.isArray(arr)) return;
    const newArr = (arr as unknown[]).filter((_, i) => i !== index);
    const newIndices = indices.filter((i) => i !== index).map((i) => (i > index ? i - 1 : i));
    const newPatch = { ...aiPatch, [field]: newIndices.length > 0 ? newIndices : undefined };
    const patch = newPatch as Record<string, unknown>;
    if (newIndices.length === 0) delete patch[field];
    const newRaw = Object.keys(patch).length > 0 ? { ...raw, _aiPatch: patch } : (() => { const r = { ...raw }; delete (r as Record<string, unknown>)._aiPatch; return r; })();

    pushSnapshot();
    const nextFull = fullNodesRef.current.map(n => {
      if (n.id !== selected.id) return n;
      return { ...n, data: { ...n.data, [field]: newArr, raw: newRaw } };
    });
    fullNodesRef.current = nextFull;
    setNodes(prev => prev.map(n => n.id === selected.id ? { ...n, data: { ...n.data, [field]: newArr, raw: newRaw } } : n));
    const updated = nextFull.find(n => n.id === selected.id);
    if (updated) setSelected({ kind: 'node', id: selected.id, data: updated.data });
    syncToParent(nextFull, fullEdgesRef.current);
  }

  /** 逐字段 AI 审核：对当前选中元素的指定分组调用 LLM 逐字段审核 */
  async function handleNodeReview(groupKey: string, fieldKeys: string[]) {
    if (!selected) return;
    const key = `${selected.kind}:${selected.id}`;
    setNodeReviewRunningGroups(prev => new Set(prev).add(groupKey));
    try {
      let element = { kind: selected.kind, id: selected.id, data: selected.data } as { kind: 'node' | 'edge'; id: string; data: Record<string, unknown>; source?: string; target?: string };
      if (selected.kind === 'edge') {
        const fullEdge = fullEdgesRef.current.find(e => e.id === selected.id);
        if (fullEdge) { element.source = fullEdge.source; element.target = fullEdge.target; }
      }
      const result = await nodeReview(element, asset, groupKey, fieldKeys);
      setNodeReviewMap(prev => {
        const prevGroupItems = prev[key]?.[groupKey] || [];
        // 保留之前已决策（accepted/ignored）的 item，按 field 合并新结果
        const decidedByField = new Map<string, NodeReviewItem>();
        prevGroupItems.forEach(it => {
          if (it.status !== 'suggested') decidedByField.set(it.payload.field, it);
        });
        const merged = result.items.map(newItem => {
          const decided = decidedByField.get(newItem.payload.field);
          return decided ? { ...newItem, status: decided.status } : newItem;
        });
        return { ...prev, [key]: { ...(prev[key] || {}), [groupKey]: merged } };
      });
      if (result.items.length === 0) message.success('AI 审核完成，未发现字段问题');
      else message.info(`AI 审核完成，发现 ${result.items.length} 条字段建议`);
    } catch (e) {
      message.error((e as Error).message || 'AI 审核失败');
    } finally {
      setNodeReviewRunningGroups(prev => { const s = new Set(prev); s.delete(groupKey); return s; });
    }
  }

  /** 字段审核建议决策：accept=采纳新值写入字段，ignore=忽略 */
  function handleDecideReview(itemId: string, decision: 'accept' | 'ignore') {
    if (!selected) return;
    const key = `${selected.kind}:${selected.id}`;
    const groupMap = nodeReviewMap[key] || {};
    // 在所有分组中查找该 item
    let targetGroupKey: string | undefined;
    let targetItems: NodeReviewItem[] | undefined;
    for (const [gk, items] of Object.entries(groupMap)) {
      const found = items.find(it => it.id === itemId);
      if (found) { targetGroupKey = gk; targetItems = items; break; }
    }
    if (!targetGroupKey || !targetItems) return;
    const item = targetItems.find(it => it.id === itemId);
    if (!item) return;
    if (decision === 'accept' && item.payload.newValue) {
      let value: unknown = item.payload.newValue;
      const curVal = selected.data[item.payload.field];
      if (Array.isArray(curVal)) {
        value = item.payload.newValue.split(',').map(s => s.trim()).filter(Boolean);
      }
      handleFieldChange(item.payload.field, value);
    }
    setNodeReviewMap(prev => ({
      ...prev,
      [key]: {
        ...prev[key],
        [targetGroupKey]: targetItems.map(it => it.id === itemId ? { ...it, status: decision === 'accept' ? 'accepted' : 'ignored' } : it),
      },
    }));
  }

  /** 删除节点/边 */
  function handleDeleteTarget(target: SelectedElement) {
    pushSnapshot();
    if (target.kind === 'node') {
      const nextFullNodes = fullNodesRef.current.filter(n => n.id !== target.id);
      const nextFullEdges = fullEdgesRef.current.filter(e => e.source !== target.id && e.target !== target.id);
      fullNodesRef.current = nextFullNodes;
      fullEdgesRef.current = nextFullEdges;
      setNodes(prev => prev.filter(n => n.id !== target.id));
      setEdges(prev => prev.filter(e => e.source !== target.id && e.target !== target.id));
      sendRemoveNode(target.id);
      syncToParent(nextFullNodes, nextFullEdges);
    } else {
      const nextFullEdges = fullEdgesRef.current.filter(e => e.id !== target.id);
      fullEdgesRef.current = nextFullEdges;
      setEdges(prev => prev.filter(e => e.id !== target.id));
      sendRemoveEdge(target.id);
      syncToParent(fullNodesRef.current, nextFullEdges);
    }
    if (selected && selected.id === target.id) setSelected(null);
    // 清理已删除元素的审核建议
    setNodeReviewMap(prev => { const next = { ...prev }; delete next[`${target.kind}:${target.id}`]; return next; });
    message.success('已删除');
  }

  function confirmDelete(target: SelectedElement) {
    const node = target.kind === 'node' ? fullNodesRef.current.find(n => n.id === target.id) : undefined;
    const edge = target.kind === 'edge' ? fullEdgesRef.current.find(e => e.id === target.id) : undefined;
    const name = node
      ? String(node.data.name || node.data.title || node.id)
      : edge ? String(edge.data.edgeType || edge.id) : target.id;
    Modal.confirm({
      title: target.kind === 'node' ? `删除节点「${name}」？` : `删除边「${name}」？`,
      content: target.kind === 'node' ? '与其相连的所有边将一并删除' : undefined,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => handleDeleteTarget(target),
    });
  }

  /** 框选批量删除 */
  function handleBatchDelete() {
    if (!multiSelected || multiSelected.length === 0) return;
    const count = multiSelected.length;
    Modal.confirm({
      title: `批量删除 ${count} 个节点？`,
      content: '与其相连的所有边将一并删除',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => {
        pushSnapshot();
        const idSet = new Set(multiSelected);
        const nextFullNodes = fullNodesRef.current.filter(n => !idSet.has(n.id));
        const nextFullEdges = fullEdgesRef.current.filter(e => !idSet.has(e.source) && !idSet.has(e.target));
        fullNodesRef.current = nextFullNodes;
        fullEdgesRef.current = nextFullEdges;
        setNodes(prev => prev.filter(n => !idSet.has(n.id)));
        setEdges(prev => prev.filter(e => !idSet.has(e.source) && !idSet.has(e.target)));
        multiSelected.forEach(id => sendRemoveNode(id));
        syncToParent(nextFullNodes, nextFullEdges);
        setMultiSelected(null);
        setSelected(null);
        sendToIframe({ type: 'clearSelection' });
        message.success(`已删除 ${count} 个节点`);
      },
    });
  }

  /** 撤销 */
  const handleUndo = useCallback(() => {
    if (!historyRef.current || !canUndo(historyRef.current)) return;
    const { history: next, snapshot } = undoHistory(historyRef.current);
    setHistory(next);
    fullNodesRef.current = snapshot.nodes;
    fullEdgesRef.current = snapshot.edges;
    setSelected(null);
    // P3-3: 全量 reload iframe（原实现遗漏 reloadIframe 导致画布不随撤销更新）
    const visibleCanvas = computeVisible(
      canvasToDocument({ nodes: snapshot.nodes, edges: snapshot.edges }, template, producedRef.current || doc || undefined),
      collapsed, hiddenLayers, hiddenEdgeTypes
    );
    setNodes(visibleCanvas.nodes);
    setEdges(visibleCanvas.edges);
    reloadIframe(visibleCanvas);
    syncToParent(snapshot.nodes, snapshot.edges);
  }, [template, doc, collapsed, hiddenLayers, hiddenEdgeTypes, computeVisible, syncToParent, reloadIframe]);

  /** 重做 */
  const handleRedo = useCallback(() => {
    if (!historyRef.current || !canRedo(historyRef.current)) return;
    const { history: next, snapshot } = redoHistory(historyRef.current);
    setHistory(next);
    fullNodesRef.current = snapshot.nodes;
    fullEdgesRef.current = snapshot.edges;
    setSelected(null);
    // P3-3: 全量 reload iframe
    const visibleCanvas = computeVisible(
      canvasToDocument({ nodes: snapshot.nodes, edges: snapshot.edges }, template, producedRef.current || doc || undefined),
      collapsed, hiddenLayers, hiddenEdgeTypes
    );
    setNodes(visibleCanvas.nodes);
    setEdges(visibleCanvas.edges);
    reloadIframe(visibleCanvas);
    syncToParent(snapshot.nodes, snapshot.edges);
  }, [template, doc, collapsed, hiddenLayers, hiddenEdgeTypes, computeVisible, syncToParent, reloadIframe]);

  /** 复制：优先多选子图 → 单节点 → 单边（含端点） */
  const handleCopy = useCallback(() => {
    // 多选框选 → 复制子图
    if (multiSelected && multiSelected.length > 0) {
      const idSet = new Set(multiSelected);
      const subNodes = fullNodesRef.current.filter(n => idSet.has(n.id));
      const subEdges = fullEdgesRef.current.filter(e => idSet.has(e.source) && idSet.has(e.target));
      clipboardRef.current = {
        kind: 'subgraph',
        nodes: JSON.parse(JSON.stringify(subNodes)),
        edges: JSON.parse(JSON.stringify(subEdges)),
      };
      message.success(`已复制子图（${subNodes.length} 节点 · ${subEdges.length} 边）`);
      return;
    }
    if (!selected) { message.warning('请先选中节点或边'); return; }
    if (selected.kind === 'node') {
      const node = fullNodesRef.current.find(n => n.id === selected.id);
      if (node) {
        clipboardRef.current = {
          kind: 'node',
          nodes: [JSON.parse(JSON.stringify(node))],
          edges: [],
        };
        message.success('已复制节点');
      }
    } else if (selected.kind === 'edge') {
      // 复制边时连同端点节点一起复制，粘贴时生成全新节点+边
      const edge = fullEdgesRef.current.find(e => e.id === selected.id);
      if (edge) {
        const srcNode = fullNodesRef.current.find(n => n.id === edge.source);
        const tgtNode = fullNodesRef.current.find(n => n.id === edge.target);
        const endNodes = [srcNode, tgtNode].filter(Boolean) as CanvasNode[];
        clipboardRef.current = {
          kind: 'subgraph',
          nodes: JSON.parse(JSON.stringify(endNodes)),
          edges: [JSON.parse(JSON.stringify(edge))],
        };
        message.success('已复制边（含端点节点）');
      }
    }
  }, [selected, multiSelected]);

  /** 复制全图 */
  const handleCopyAll = useCallback(() => {
    if (fullNodesRef.current.length === 0) { message.warning('画布为空'); return; }
    clipboardRef.current = {
      kind: 'subgraph',
      nodes: JSON.parse(JSON.stringify(fullNodesRef.current)),
      edges: JSON.parse(JSON.stringify(fullEdgesRef.current)),
    };
    message.success(`已复制全图（${fullNodesRef.current.length} 节点 · ${fullEdgesRef.current.length} 边）`);
  }, []);

  // P1: 模板库 — 打开抽屉时从 localStorage 加载
  const refreshTplDrawer = useCallback(() => {
    setNodeTemplates(loadNodeTemplates());
    setSubgraphTemplates(loadSubgraphTemplates());
  }, []);

  /** P1-1: 存为节点模板 */
  const handleSaveNodeTemplate = useCallback((nodeId: string) => {
    const n = fullNodesRef.current.find(x => x.id === nodeId);
    if (!n) return;
    const props = extractNodeProperties(n.data as Record<string, unknown>);
    const name = String(n.data.name || n.data.title || n.data.nodeType || nodeId);
    const tpl: SavedNodeTemplate = {
      id: `ntpl:${Date.now().toString(36)}${Math.floor(Math.random() * 1000).toString(36)}`,
      name, nodeType: String(n.data.nodeType || ''), properties: props, createdAt: Date.now(),
    };
    saveNodeTemplate(tpl);
    message.success(`已保存节点模板「${name}」`);
  }, []);

  /** P1-2: 存为子图模板 */
  const handleSaveSubgraphTemplate = useCallback((nodeIds: string[]) => {
    const idSet = new Set(nodeIds);
    const subNodes = fullNodesRef.current.filter(n => idSet.has(n.id));
    const subEdges = fullEdgesRef.current.filter(e => idSet.has(e.source) && idSet.has(e.target));
    if (subNodes.length === 0) { message.warning('未选中有效节点'); return; }
    const tpl: SavedSubgraphTemplate = {
      id: `sgtpl:${Date.now().toString(36)}${Math.floor(Math.random() * 1000).toString(36)}`,
      name: `子图模板 (${subNodes.length}节点·${subEdges.length}边)`,
      nodes: JSON.parse(JSON.stringify(subNodes)),
      edges: JSON.parse(JSON.stringify(subEdges)),
      createdAt: Date.now(),
    };
    saveSubgraphTemplate(tpl);
    message.success(`已保存子图模板（${subNodes.length} 节点 · ${subEdges.length} 边）`);
  }, []);

  /** P1: 从模板插入节点 */
  const handleInsertNodeFromTemplate = useCallback((nodeType: string, properties: Record<string, unknown>) => {
    handleAddNode(nodeType, undefined, undefined, properties);
  }, [handleAddNode]);

  /** P1: 从模板插入子图（复用粘贴逻辑的 ID 重映射） */
  const handleInsertSubgraphFromTemplate = useCallback((srcNodes: CanvasNode[], srcEdges: CanvasEdge[]) => {
    pushSnapshot();
    const idMap = new Map<string, string>();
    const newNodes = srcNodes.map(src => {
      const nt = String(src.data.nodeType || '');
      const newId = nextNodeId(nt);
      idMap.set(src.id, newId);
      return {
        ...JSON.parse(JSON.stringify(src)),
        id: newId,
        position: { x: 80 + fullNodesRef.current.length * 32, y: 80 + fullNodesRef.current.length * 32 },
        data: { ...JSON.parse(JSON.stringify(src.data)), id: newId },
      };
    });
    const newEdges = srcEdges.map(src => {
      const eid = `edge:${Date.now().toString(36)}${Math.floor(Math.random() * 1000).toString(36)}`;
      return {
        ...JSON.parse(JSON.stringify(src)),
        id: eid, source: idMap.get(src.source) || src.source, target: idMap.get(src.target) || src.target,
        data: { ...JSON.parse(JSON.stringify(src.data)), id: eid },
      };
    });
    const nextFullNodes = [...fullNodesRef.current, ...newNodes];
    const nextFullEdges = [...fullEdgesRef.current, ...newEdges];
    fullNodesRef.current = nextFullNodes;
    fullEdgesRef.current = nextFullEdges;
    setNodes(prev => [...prev, ...newNodes]);
    setEdges(prev => [...prev, ...newEdges]);
    newNodes.forEach(n => sendAddNode(n));
    newEdges.forEach(e => sendAddEdge(e));
    if (newNodes.length > 0) setSelected({ kind: 'node', id: newNodes[0].id, data: newNodes[0].data });
    syncToParent(nextFullNodes, nextFullEdges);
  }, [pushSnapshot, sendAddNode, sendAddEdge, syncToParent]);

  /** 粘贴：统一处理单节点/子图/全图，自动重映射 ID */
  const handlePaste = useCallback(() => {
    if (!clipboardRef.current) { message.warning('剪贴板为空'); return; }
    pushSnapshot();
    const clip = clipboardRef.current;

    // ID 重映射：oldId → newId
    const idMap = new Map<string, string>();
    const newNodes: CanvasNode[] = clip.nodes.map(src => {
      const nodeType = String(src.data.nodeType || '');
      const newId = nextNodeId(nodeType);
      idMap.set(src.id, newId);
      return {
        ...JSON.parse(JSON.stringify(src)),
        id: newId,
        position: { x: (src.position?.x || 0) + 24, y: (src.position?.y || 0) + 24 },
        data: { ...JSON.parse(JSON.stringify(src.data)), id: newId },
      };
    });

    // 边端点重映射
    const newEdges: CanvasEdge[] = clip.edges.map(src => {
      const newEdgeId = `edge:${Date.now().toString(36)}${Math.floor(Math.random() * 1000).toString(36)}`;
      const newSource = idMap.get(src.source) || src.source;
      const newTarget = idMap.get(src.target) || src.target;
      return {
        ...JSON.parse(JSON.stringify(src)),
        id: newEdgeId,
        source: newSource,
        target: newTarget,
        data: { ...JSON.parse(JSON.stringify(src.data)), id: newEdgeId },
      };
    });

    // 批量添加到画布
    const nextFullNodes = [...fullNodesRef.current, ...newNodes];
    const nextFullEdges = [...fullEdgesRef.current, ...newEdges];
    fullNodesRef.current = nextFullNodes;
    fullEdgesRef.current = nextFullEdges;
    setNodes(prev => [...prev, ...newNodes]);
    setEdges(prev => [...prev, ...newEdges]);
    newNodes.forEach(n => sendAddNode(n));
    newEdges.forEach(e => sendAddEdge(e));

    if (newNodes.length > 0) {
      setSelected({ kind: 'node', id: newNodes[0].id, data: newNodes[0].data });
    }
    syncToParent(nextFullNodes, nextFullEdges);

    if (newNodes.length > 1) {
      message.success(`已粘贴子图（${newNodes.length} 节点 · ${newEdges.length} 边）`);
    } else if (newEdges.length > 0) {
      message.success(`已粘贴边（含 ${newNodes.length} 端点节点）`);
    } else {
      message.success('已粘贴节点');
    }
  }, [pushSnapshot, sendAddNode, sendAddEdge, syncToParent]);

  /** 布局切换 */
  const handleLayout = useCallback((mode: LayoutMode) => {
    setLayoutMode(mode);
    if (mode === 'force') {
      // 力导向：启用 vis-network 物理引擎
      sendToIframe({ type: 'setPhysics', enabled: true });
      message.success('已切换为力导向布局');
      return;
    }
    // 其他布局：关闭物理引擎，在 React 侧计算位置后下发
    sendToIframe({ type: 'setPhysics', enabled: false });
    pushSnapshot();
    const allNodes = fullNodesRef.current;
    const allEdges = fullEdgesRef.current;
    let positioned: CanvasNode[];
    switch (mode) {
      case 'fruchterman':
        positioned = layoutFruchterman(allNodes, allEdges);
        break;
      case 'concentric':
        positioned = layoutConcentric(allNodes, allEdges);
        break;
      case 'grid':
        positioned = layoutGrid(allNodes);
        break;
      case 'geo':
        positioned = layoutGeo(allNodes);
        break;
      case 'tree':
        if (treeChildren) {
          positioned = layoutTree(allNodes, treeChildren);
        } else {
          positioned = layoutDagre(allNodes, allEdges, { rankdir: 'TB' });
        }
        break;
      case 'radial':
        positioned = layoutRadial(allNodes, allEdges);
        break;
      case 'columns':
        positioned = layoutColumns(allNodes);
        break;
      case 'dagre':
        positioned = layoutDagre(allNodes, allEdges, { rankdir: 'LR' });
        break;
      case 'dagre-tb':
        positioned = layoutDagre(allNodes, allEdges, { rankdir: 'TB' });
        break;
      default:
        positioned = allNodes;
    }
    fullNodesRef.current = positioned;
    // 更新可见节点位置
    const posMap = new Map(positioned.map(n => [n.id, n.position]));
    setNodes(prev => prev.map(n => {
      const p = posMap.get(n.id);
      return p ? { ...n, position: p } : n;
    }));
    // 下发位置到 iframe
    const positions = positioned.map(n => ({ id: n.id, x: n.position?.x || 0, y: n.position?.y || 0 }));
    sendToIframe({ type: 'applyLayout', positions });
    syncToParent(positioned, allEdges);
    message.success(`已切换为${LAYOUT_OPTIONS.find(o => o.value === mode)?.label || mode}布局`);
  }, [treeChildren, pushSnapshot, sendToIframe, syncToParent]);

  /** 折叠/展开节点 */
  const handleToggleCollapse = useCallback((nodeId: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }, []);

  /** 全部展开 */
  const handleExpandAll = useCallback(() => {
    setCollapsed(new Set());
  }, []);

  /** 全部折叠 */
  const handleCollapseAll = useCallback(() => {
    if (!treeChildren || !doc) return;
    const canvas = documentToCanvas(doc);
    setCollapsed(initialCollapsedSet(canvas.nodes, treeChildren, 1));
  }, [treeChildren, doc, template]);

  /** 定位节点：自动展开折叠祖先 + 取消隐藏图层，然后延迟 focusNode */
  function locateNode(id: string, closeDrawer?: () => void) {
    const exists = fullNodesRef.current.some(x => x.id === id);
    if (!exists) { message.warning('节点不在当前画布中'); return; }

    // 1. 展开折叠的祖先节点
    let needCollapseUpdate = false;
    if (treeChildren) {
      // 构建 child → parent 映射
      const parentOf = new Map<string, string>();
      treeChildren.forEach((kids, parent) => { kids.forEach(k => parentOf.set(k, parent)); });
      // 从目标节点向上遍历，展开所有折叠的祖先
      const newCollapsed = new Set(collapsed);
      let cur = parentOf.get(id);
      while (cur) {
        if (newCollapsed.has(cur)) { newCollapsed.delete(cur); needCollapseUpdate = true; }
        cur = parentOf.get(cur);
      }
      if (needCollapseUpdate) setCollapsed(newCollapsed);
    }

    // 2. 取消隐藏该节点所在图层
    const target = fullNodesRef.current.find(x => x.id === id);
    let needLayerUpdate = false;
    if (target) {
      const g = layerGroupOf(String(target.data.nodeType || ''));
      if (g && hiddenLayers.has(g)) {
        const next = new Set(hiddenLayers);
        next.delete(g);
        setHiddenLayers(next);
        needLayerUpdate = true;
      }
    }

    // 3. 聚焦节点：若有状态更新则延迟等 iframe 重载完成
    const sendFocus = () => {
      sendToIframe({ type: 'focusNode', nodeId: id });
      const n = fullNodesRef.current.find(x => x.id === id);
      if (n) setSelected({ kind: 'node', id: n.id, data: n.data });
      closeDrawer?.();
    };
    if (needCollapseUpdate || needLayerUpdate) {
      setTimeout(sendFocus, 400);
    } else {
      // 节点已在可见画布中，直接聚焦
      const visible = nodes.some(x => x.id === id);
      if (visible) sendFocus();
      else { message.warning('节点暂时不可见，请稍后重试'); }
    }
  }

  /** AI 合并后回流 */
  function handleMerged(merged: GraphDocument) {
    producedRef.current = merged;
    const fullCanvas = applyCanvasVisuals(documentToCanvas(merged), schema);
    fullNodesRef.current = fullCanvas.nodes;
    fullEdgesRef.current = fullCanvas.edges;
    const visibleCanvas = computeVisible(merged, collapsed, hiddenLayers, hiddenEdgeTypes);
    setNodes(visibleCanvas.nodes);
    setEdges(visibleCanvas.edges);
    setSelected(null);
    const snap = cloneSnapshot({ nodes: fullCanvas.nodes, edges: fullCanvas.edges });
    setHistory(historyRef.current ? pushHistory(historyRef.current, snap) : initialHistory(snap));
    reloadIframe(visibleCanvas);
    onDocumentChange(merged);
  }

  /** AI生成结果 diff 审查：对比当前文档与AI提案，弹出审查面板 */
  function handleAiMergeProposal(proposed: GraphDocument) {
    if (!doc) { handleMerged(proposed); return; }
    const diff = diffGraphDocuments(doc, proposed, '当前画布', 'AI生成');
    setPendingMerge(proposed);
    setMergeDiff(diff);
    setDiffRejectedNodes(new Set());
    setDiffRejectedEdges(new Set());
  }

  /** 确认合并AI结果（可排除被拒绝的项） */
  function confirmAiMerge() {
    if (!pendingMerge || !doc) return;
    // 如果没有拒绝项，直接合并
    if (diffRejectedNodes.size === 0 && diffRejectedEdges.size === 0) {
      handleMerged(pendingMerge);
    } else {
      // 过滤掉被拒绝的新增节点和边
      const filtered: GraphDocument = {
        ...pendingMerge,
        nodes: pendingMerge.nodes.filter(n => !diffRejectedNodes.has(n.id)),
        edges: pendingMerge.edges.filter(e => !diffRejectedEdges.has(e.id)),
      };
      // 保留被拒绝删除的旧节点和边（即如果AI删除了某节点但用户拒绝删除，从旧文档补回）
      if (mergeDiff) {
        const keepOldNodeIds = new Set<string>();
        const keepOldEdgeIds = new Set<string>();
        mergeDiff.nodes.forEach(d => { if (d.kind === 'removed' && diffRejectedNodes.has(`keep:${d.id}`)) keepOldNodeIds.add(d.id); });
        mergeDiff.edges.forEach(d => { if (d.kind === 'removed' && diffRejectedEdges.has(`keep:${d.id}`)) keepOldEdgeIds.add(d.id); });
        if (keepOldNodeIds.size > 0) {
          const existing = new Map(doc.nodes.map(n => [n.id, n]));
          keepOldNodeIds.forEach(id => { const n = existing.get(id); if (n && !filtered.nodes.find(x => x.id === id)) filtered.nodes.push(n); });
        }
        if (keepOldEdgeIds.size > 0) {
          const existing = new Map(doc.edges.map(e => [e.id, e]));
          keepOldEdgeIds.forEach(id => { const e = existing.get(id); if (e && !filtered.edges.find(x => x.id === id)) filtered.edges.push(e); });
        }
      }
      // 悬挂边防线：节点被拒绝后，引用它的边必须一并剔除，否则脏边直接入稿
      const liveNodeIds = new Set(filtered.nodes.map(n => n.id));
      const beforeEdgeCount = filtered.edges.length;
      filtered.edges = filtered.edges.filter(e => liveNodeIds.has(e.source) && liveNodeIds.has(e.target));
      if (filtered.edges.length < beforeEdgeCount) {
        message.info(`${beforeEdgeCount - filtered.edges.length} 条边因端点被拒绝已一并剔除`);
      }
      handleMerged(filtered);
    }
    setPendingMerge(null);
    setMergeDiff(null);
    setDiffRejectedNodes(new Set());
    setDiffRejectedEdges(new Set());
  }

  /** 取消AI合并 */
  function cancelAiMerge() {
    setPendingMerge(null);
    setMergeDiff(null);
    setDiffRejectedNodes(new Set());
    setDiffRejectedEdges(new Set());
  }

  /** 版本对比：加载历史版本并计算 diff */
  const handleStartVersionDiff = useCallback(async (version: string) => {
    if (!doc || !asset || !version) return;
    setLoadingVersionDiff(true);
    try {
      const compareDoc = await loadGraph(asset, version);
      const diff = diffGraphDocuments(
        compareDoc, doc,
        version === 'draft' ? '草稿' : version,
        '当前画布',
      );
      setCompareVersion(version);
      setVersionDiffResult(diff);
      setVersionDiffOpen(true);
      message.success(`版本对比完成：${diff.stats.nodesAdded} 新增 / ${diff.stats.nodesModified} 修改 / ${diff.stats.nodesRemoved} 删除`);
    } catch {
      message.error('加载版本失败');
    } finally {
      setLoadingVersionDiff(false);
    }
  }, [doc, asset]);

  /** 清除版本对比 */
  const handleClearVersionDiff = useCallback(() => {
    setVersionDiffOpen(false);
    setCompareVersion('');
    setVersionDiffResult(null);
  }, []);

  /** 发布前预览：加载当前已发布版本与草稿diff + 质量报告 */
  const handlePublishPreview = useCallback(async () => {
    if (!doc || !asset) return;
    setPublishPreviewOpen(true);
    setLoadingPublishPreview(true);
    try {
      if (status?.activeVersion) {
        const publishedDoc = await loadGraph(asset, status.activeVersion);
        const diff = diffGraphDocuments(publishedDoc, doc, `已发布 v${status.activeVersion}`, '当前草稿');
        setPublishPreviewDiff(diff);
      } else {
        setPublishPreviewDiff(null);
      }
    } catch {
      setPublishPreviewDiff(null);
    } finally {
      setLoadingPublishPreview(false);
    }
  }, [doc, asset, status]);

  /** 确认发布 */
  const handleConfirmPublish = useCallback(() => {
    setPublishPreviewOpen(false);
    setPublishPreviewDiff(null);
    onPublish?.();
  }, [onPublish]);

  /** 连线模式切换 */
  const handleToggleConnect = useCallback(() => {
    const next = !connectMode;
    setConnectMode(next);
    sendToIframe({ type: 'setConnectMode', enabled: next });
    if (next) message.info('连线模式：依次点击两个节点完成连线');
  }, [connectMode, sendToIframe]);

  const handleFit = useCallback(() => {
    sendToIframe({ type: 'fitView' });
  }, [sendToIframe]);

  /** 导出 GraphDocument 为 JSON 文件 */
  const handleExportJSON = useCallback(() => {
    if (!doc || doc.nodes.length === 0) { message.warning('画布为空，无可导出内容'); return; }
    const json = JSON.stringify(doc, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${asset || 'graph'}-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    message.success(`已导出 ${doc.nodes.length} 节点 / ${doc.edges.length} 边`);
  }, [doc, asset]);

  /** 导入 JSON 文件 */
  const handleImportJSON = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        if (!parsed || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
          message.error('文件格式不正确：需要包含 nodes 和 edges 数组');
          return;
        }
        onDocumentChange(parsed as GraphDocument);
        message.success(`已导入 ${parsed.nodes.length} 节点 / ${parsed.edges.length} 边`);
      } catch {
        message.error('JSON 解析失败，请检查文件内容');
      }
    };
    input.click();
  }, [onDocumentChange]);

  /** 导出 V4.1 图谱文件（schemaVersion/graphId/intentTree/relations/resourceRegistries/digest，schema 文档 §7） */
  const handleExportV4JSON = useCallback(async () => {
    if (!doc || doc.nodes.length === 0) { message.warning('画布为空，无可导出内容'); return; }
    try {
      const graph = await graphDocumentToV4(doc, { graphId: `${asset || 'graph-builder'}-v4`, digest: '' });
      const json = JSON.stringify(graph, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${asset || 'graph'}-v4.1-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      message.success(`已导出 V4.1 JSON：${graph.intentTree.length} 节点 / ${graph.relations.length} 关系 / 资源注册表 ${graph.resourceRegistries.capabilities.length + graph.resourceRegistries.faqs.length + graph.resourceRegistries.policies.length + graph.resourceRegistries.skillBindings.length} 条`);
    } catch (e) {
      message.error('V4.1 导出失败：' + (e instanceof Error ? e.message : String(e)));
    }
  }, [doc, asset]);

  /** 导入 V4.1 图谱文件（intentTree/relations/resourceRegistries → builder 文档） */
  const handleImportV4JSON = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        if (!parsed || !Array.isArray(parsed.intentTree)) {
          message.error('不是 V4.1 图谱文件（缺少 intentTree 数组）');
          return;
        }
        const { document: nextDoc, errors } = v4ToGraphDocument(parsed as V41Graph, doc || undefined);
        onDocumentChange(nextDoc);
        if (errors.length > 0) {
          message.warning(`已导入 ${nextDoc.nodes.length} 节点，但跳过 ${errors.length} 处问题（详见服务端校验）`);
        } else {
          message.success(`已导入 ${nextDoc.nodes.length} 节点 / ${nextDoc.edges.length} 边`);
        }
      } catch {
        message.error('JSON 解析失败，请检查文件内容');
      }
    };
    input.click();
  }, [onDocumentChange, doc]);

  /** 导出当前画布为 PNG 图片（通过 postMessage 让 iframe 内 vis-network 截图） */
  const handleExportPNG = useCallback(() => {
    if (!iframeReadyRef.current) { message.warning('画布尚未就绪，请稍后重试'); return; }
    exportingPNGRef.current = true;
    sendToIframe({ type: 'exportImage' });
    // 5 秒超时保护
    setTimeout(() => {
      if (exportingPNGRef.current) {
        exportingPNGRef.current = false;
        message.error('图片导出超时');
      }
    }, 5000);
  }, [sendToIframe]);

  /** 导出 CSV（节点表 + 边表） */
  const handleExportCSV = useCallback(() => {
    if (!doc || doc.nodes.length === 0) { message.warning('画布为空，无可导出内容'); return; }
    const { nodes: nodesCsv, edges: edgesCsv } = exportCSV(doc);
    const combined = `# Nodes\n${nodesCsv}\n\n# Edges\n${edgesCsv}\n`;
    const blob = new Blob([combined], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${asset || 'graph'}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    message.success(`已导出 CSV ${doc.nodes.length} 节点 / ${doc.edges.length} 边`);
  }, [doc, asset]);

  /** 导出 JSON-LD（语义Web RDF格式） */
  const handleExportJSONLD = useCallback(() => {
    if (!doc || doc.nodes.length === 0) { message.warning('画布为空'); return; }
    const jsonld = exportJSONLD(doc);
    const blob = new Blob([JSON.stringify(jsonld, null, 2)], { type: 'application/ld+json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${asset || 'graph'}-${new Date().toISOString().slice(0, 10)}.jsonld`;
    a.click();
    URL.revokeObjectURL(url);
    message.success(`已导出 JSON-LD`);
  }, [doc, asset]);

  /** 导出 RDF Turtle */
  const handleExportRDF = useCallback(() => {
    if (!doc || doc.nodes.length === 0) { message.warning('画布为空'); return; }
    const turtle = exportRDFTurtle(doc);
    const blob = new Blob([turtle], { type: 'text/turtle' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${asset || 'graph'}-${new Date().toISOString().slice(0, 10)}.ttl`;
    a.click();
    URL.revokeObjectURL(url);
    message.success(`已导出 RDF Turtle`);
  }, [doc, asset]);

  /** 导出 GraphML（Gephi/Cytoscape兼容） */
  const handleExportGraphML = useCallback(() => {
    if (!doc || doc.nodes.length === 0) { message.warning('画布为空'); return; }
    const xml = exportGraphML(doc);
    const blob = new Blob([xml], { type: 'application/graphml+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${asset || 'graph'}-${new Date().toISOString().slice(0, 10)}.graphml`;
    a.click();
    URL.revokeObjectURL(url);
    message.success(`已导出 GraphML`);
  }, [doc, asset]);

  /** 图谱统计（节点类型分布 + 边类型分布 + 度分布 top5） */
  const graphStats = useMemo(() => {
    if (!doc) return null;
    const nodeTypeDist: Record<string, number> = {};
    const edgeTypeDist: Record<string, number> = {};
    const degreeMap: Record<string, number> = {};
    doc.nodes.forEach((n) => {
      const t = String(n.type || 'unknown');
      nodeTypeDist[t] = (nodeTypeDist[t] || 0) + 1;
    });
    doc.edges.forEach((e) => {
      const t = String(e.type || 'unknown');
      edgeTypeDist[t] = (edgeTypeDist[t] || 0) + 1;
      degreeMap[e.source] = (degreeMap[e.source] || 0) + 1;
      degreeMap[e.target] = (degreeMap[e.target] || 0) + 1;
    });
    const topNodes = Object.entries(degreeMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([id, deg]) => {
        const node = doc.nodes.find((n) => n.id === id);
        return { id, degree: deg, name: String(node?.properties?.name || node?.id || id) };
      });
    return {
      totalNodes: doc.nodes.length,
      totalEdges: doc.edges.length,
      nodeTypeDist,
      edgeTypeDist,
      topNodes,
      visibleNodes: nodes.length,
      visibleEdges: edges.length,
    };
  }, [doc, nodes, edges]);

  /** 质量评分 */
  const qualityScore = useMemo<QualityScore | null>(() => {
    if (!doc || !template) return null;
    return computeQualityScore(doc, template);
  }, [doc, template]);

  /** 待审阅 AI 节点列表 */
  const pendingReviewNodes = useMemo(() => {
    if (!doc) return [];
    return doc.nodes.filter(n => {
      const rs = String((n.properties as Record<string, unknown>)?.review_status || '');
      return rs === 'pending' || rs === '待审核';
    });
  }, [doc]);

  /** 待审阅 AI 边列表 */
  const pendingReviewEdges = useMemo(() => {
    if (!doc) return [];
    return doc.edges.filter(e => {
      const rs = String((e.properties as Record<string, unknown>)?.review_status || '');
      return rs === 'pending' || rs === '待审核';
    });
  }, [doc]);

  /** 批量接受节点审阅 */
  const handleBatchAccept = useCallback((nodeIds: Set<string>) => {
    if (!doc || nodeIds.size === 0) { message.warning('请先选择节点'); return; }
    pushSnapshot();
    const updatedNodes = fullNodesRef.current.map(n => {
      if (nodeIds.has(n.id)) {
        return { ...n, data: { ...n.data, review_status: 'approved' } };
      }
      return n;
    });
    syncToParent(updatedNodes, fullEdgesRef.current);
    setBatchSelectedIds(new Set());
    message.success(`已批量接受 ${nodeIds.size} 个节点`);
  }, [doc, pushSnapshot, syncToParent]);

  /** 批量拒绝节点审阅（从画布移除） */
  const handleBatchReject = useCallback((nodeIds: Set<string>) => {
    if (!doc || nodeIds.size === 0) { message.warning('请先选择节点'); return; }
    pushSnapshot();
    const idSet = new Set(nodeIds);
    const updatedNodes = fullNodesRef.current.filter(n => !idSet.has(n.id));
    const updatedEdges = fullEdgesRef.current.filter(e => !idSet.has(e.source) && !idSet.has(e.target));
    syncToParent(updatedNodes, updatedEdges);
    setBatchSelectedIds(new Set());
    message.success(`已批量拒绝并移除 ${nodeIds.size} 个节点`);
  }, [doc, pushSnapshot, syncToParent]);

  /** 全部接受 */
  const handleAcceptAllPending = useCallback(() => {
    const ids = new Set(pendingReviewNodes.map(n => n.id));
    if (ids.size === 0) { message.info('没有待审阅节点'); return; }
    handleBatchAccept(ids);
  }, [pendingReviewNodes, handleBatchAccept]);

  /** 全部拒绝 */
  const handleRejectAllPending = useCallback(() => {
    const ids = new Set(pendingReviewNodes.map(n => n.id));
    if (ids.size === 0) { message.info('没有待审阅节点'); return; }
    handleBatchReject(ids);
  }, [pendingReviewNodes, handleBatchReject]);

  /** 切换选中 */
  const toggleBatchSelect = useCallback((id: string) => {
    setBatchSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  /** 运行图分析算法 */
  const handleRunAnalysis = useCallback(() => {
    if (!doc || doc.nodes.length === 0) { message.warning('画布为空'); return; }
    const canvasNodes: CanvasNode[] = fullNodesRef.current.length > 0 ? fullNodesRef.current : doc.nodes.map(n => ({ id: n.id, data: n.properties || {}, position: { x: n.x || 0, y: n.y || 0 } }));
    const canvasEdges: CanvasEdge[] = fullEdgesRef.current.length > 0 ? fullEdgesRef.current : doc.edges.map(e => ({ id: e.id, source: e.source, target: e.target, label: e.type, data: e.properties || {} }));
    const nodeLabel = (id: string) => {
      const n = canvasNodes.find(x => x.id === id);
      return String(n?.data?.name || n?.data?.title || id);
    };

    if (analysisType === 'centrality') {
      const result = computeCentrality(canvasNodes, canvasEdges);
      const items = Array.from(result.betweennessCentrality.entries())
        .sort(([, a], [, b]) => b - a)
        .slice(0, 15)
        .map(([id, betweenness]) => {
          const deg = result.degreeCentrality.get(id) ?? 0;
          const close = result.closenessCentrality.get(id) ?? 0;
          return { id, label: nodeLabel(id), value: betweenness.toFixed(3), extra: `度=${deg.toFixed(2)} 接近=${close.toFixed(3)} 介数=${betweenness.toFixed(3)}` };
        });
      setAnalysisResult({ label: '节点中心性分析（按介数排序 Top15）', items });
    } else if (analysisType === 'communities') {
      const result = detectCommunities(canvasNodes, canvasEdges);
      const items = result.communities.map(c => ({ id: `community-${c.communityId}`, label: `社区 ${c.communityId}`, value: c.nodeIds.length, extra: c.nodeIds.map(nodeLabel).join(', ').slice(0, 60) }));
      setAnalysisResult({ label: `社区发现（标签传播算法，共 ${result.communities.length} 个社区）`, items });
    } else if (analysisType === 'connected') {
      const result = findConnectedComponents(canvasNodes, canvasEdges);
      const items = result.components.map((c, i) => ({ id: `comp-${i}`, label: `连通分量 ${i + 1}`, value: c.nodeIds.length, extra: c.nodeIds.map(nodeLabel).join(', ').slice(0, 60) }));
      setAnalysisResult({ label: `联通子图分析（并查集，共 ${result.count} 个连通分量）`, items });
    } else if (analysisType === 'cycles') {
      const result = detectCycles(canvasNodes, canvasEdges);
      const items = result.cycles.slice(0, 10).map((c, i) => ({ id: `cycle-${i}`, label: `环 ${i + 1}`, value: c.length, extra: c.map(nodeLabel).join(' → ') }));
      setAnalysisResult({ label: `环路检测（三色DFS，${result.hasCycle ? `发现 ${result.cycles.length} 个环` : '无环'}）`, items });
    } else if (analysisType === 'kcore') {
      const result = kCoreDecomposition(canvasNodes, canvasEdges);
      const items = Array.from(result.coreness.entries())
        .sort(([, a], [, b]) => b - a)
        .slice(0, 15)
        .map(([id, coreness]) => ({ id, label: nodeLabel(id), value: coreness, extra: `K-Core=${coreness}` }));
      setAnalysisResult({ label: `K-Core 分解（核度分布 Top15，最大核度=${result.maxCoreness}）`, items });
    } else if (analysisType === 'degree') {
      const result = computeDegreeDistribution(canvasNodes, canvasEdges);
      const items = result.nodes
        .sort((a, b) => b.totalDegree - a.totalDegree)
        .slice(0, 15)
        .map(n => ({ id: n.nodeId, label: nodeLabel(n.nodeId), value: n.totalDegree, extra: `入度=${n.inDegree} 出度=${n.outDegree}` }));
      setAnalysisResult({ label: `度分布分析（按总度排序 Top15，平均度=${result.averageDegree.toFixed(2)}）`, items });
    }
    setAnalysisOpen(true);
  }, [doc, analysisType]);

  // 键盘快捷键
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // 输入框聚焦时不拦截
      const target = e.target as HTMLElement;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable || editingInField)) {
        return;
      }
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key === 'z' && !e.shiftKey) { e.preventDefault(); handleUndo(); return; }
      if (ctrl && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); handleRedo(); return; }
      if (ctrl && e.key === 'c') { e.preventDefault(); handleCopy(); return; }
      if (ctrl && e.key === 'v') { e.preventDefault(); handlePaste(); return; }
      if (ctrl && e.shiftKey && e.key === 'C') { e.preventDefault(); handleCopyAll(); return; }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
        e.preventDefault();
        confirmDelete(selected);
        return;
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [selected, editingInField, handleUndo, handleRedo, handleCopy, handlePaste, handleCopyAll]);

  // 高级搜索匹配（支持属性级搜索：name:转账 intent_type:DO 等）
  const searchMatches = useMemo(() => {
    const q = search.trim();
    if (!q) return [];
    const ql = q.toLowerCase();
    const out: { id: string; label: string; type: string; matchField?: string }[] = [];
    // 解析 key:value 语法
    const colonIdx = ql.indexOf(':');
    const hasFieldFilter = colonIdx > 0 && colonIdx < ql.length - 1;
    const fieldKey = hasFieldFilter ? ql.slice(0, colonIdx).trim() : null;
    const fieldValue = hasFieldFilter ? ql.slice(colonIdx + 1).trim() : ql;

    nodes.forEach(n => {
      const name = String(n.data.name || n.data.title || n.id);
      const nodeType = String(n.data.nodeType || '');
      if (hasFieldFilter && fieldKey) {
        // 属性级搜索：匹配指定字段
        if (fieldKey === 'type' || fieldKey === 'nodetype') {
          if (nodeType.toLowerCase().includes(fieldValue)) {
            out.push({ id: n.id, label: name, type: nodeType, matchField: 'type' });
          }
        } else if (fieldKey === 'domain') {
          const domain = String(n.data.domain || '');
          if (domain.toLowerCase().includes(fieldValue)) {
            out.push({ id: n.id, label: name, type: nodeType, matchField: 'domain' });
          }
        } else {
          // 通用属性匹配
          const val = String(n.data[fieldKey] ?? '');
          if (val.toLowerCase().includes(fieldValue)) {
            out.push({ id: n.id, label: name, type: nodeType, matchField: fieldKey });
          }
        }
      } else {
        // 全局模糊搜索：name + 所有属性值
        if (name.toLowerCase().includes(ql)) {
          out.push({ id: n.id, label: name, type: nodeType });
          return;
        }
        // 搜索所有 data 字段值
        for (const [k, v] of Object.entries(n.data)) {
          if (k === 'id' || k === 'nodeType' || k === 'nodeColor' || k === 'degree') continue;
          const sv = String(v ?? '');
          if (sv.toLowerCase().includes(ql)) {
            out.push({ id: n.id, label: name, type: nodeType, matchField: k });
            break;
          }
        }
      }
    });
    return out;
  }, [search, nodes]);

  const handleSearchSelect = useCallback((id: string) => {
    sendToIframe({ type: 'focusNode', nodeId: id });
    const n = fullNodesRef.current.find(x => x.id === id);
    if (n) setSelected({ kind: 'node', id: n.id, data: n.data });
    setSearch('');
  }, [sendToIframe]);

  // 图层计数
  const layerCounts = useMemo(() => {
    if (!treeChildren || !doc) return { objects: 0, constraints: 0 };
    const canvas = documentToCanvas(doc);
    const treeNodeIds = treeNodeIdSet(treeChildren);
    let objects = 0, constraints = 0;
    canvas.nodes.forEach(n => {
      if (treeNodeIds.has(n.id)) return;
      const g = layerGroupOf(String(n.data.nodeType || ''));
      if (g === 'objects') objects++;
      else if (g === 'constraints') constraints++;
    });
    return { objects, constraints };
  }, [treeChildren, doc]);

  // 右键菜单项
  const contextMenuItems: ContextMenuItem[] = (() => {
    if (!contextMenu) return [];
    if (contextMenu.kind === 'node' && contextMenu.nodeId) {
      const node = fullNodesRef.current.find(n => n.id === contextMenu.nodeId);
      const name = node ? String(node.data.name || node.data.title || node.id) : contextMenu.nodeId;
      const isCollapsedNode = collapsed.has(contextMenu.nodeId);
      return [
        { key: 'edit', label: `编辑「${name}」`, onClick: () => {
          const n = fullNodesRef.current.find(x => x.id === contextMenu.nodeId);
          if (n) setSelected({ kind: 'node', id: n.id, data: n.data });
        }},
        ...(node && node.data.nodeType === 'AGGREGATE_INTENT' ? [{
          key: 'aiAssist', label: 'AI辅助审核编辑', onClick: () => {
            setAssistGroupNodeId(contextMenu.nodeId!);
            setAssistAutoStart(true);
            setAssistOpen(true);
          }
        }] : []),
        { key: 'addChild', label: '添加子节点', onClick: () => {
          setAddNodeParentId(contextMenu.nodeId);
          setAddNodePosition(undefined);
          setAddNodeOpen(true);
        }},
        ...(treeChildren && treeChildren.has(contextMenu.nodeId) ? [{
          key: 'toggleCollapse', label: isCollapsedNode ? '展开子树' : '折叠子树', onClick: () => {
            handleToggleCollapse(contextMenu.nodeId!);
          }
        }] : []),
        ...(multiSelected && multiSelected.length > 1 ? [
          { key: 'copySubgraph', label: `复制选中子图（${multiSelected.length} 节点）`, onClick: () => {
            handleCopy();
          }},
          { key: 'saveSubgraphTpl', label: '存为子图模板', onClick: () => {
            handleSaveSubgraphTemplate(multiSelected);
          }},
        ] : []),
        { key: 'copy', label: '复制节点', onClick: () => {
          const n = fullNodesRef.current.find(x => x.id === contextMenu.nodeId);
          if (n) {
            clipboardRef.current = { kind: 'node', nodes: [JSON.parse(JSON.stringify(n))], edges: [] };
            message.success('已复制节点');
          }
        }},
        { key: 'copySubtree', label: '复制子树', onClick: () => {
          const startId = contextMenu.nodeId!;
          if (treeChildren) {
            // 递归收集所有子孙节点
            const subtreeIds = new Set<string>([startId]);
            const queue = [startId];
            while (queue.length > 0) {
              const cur = queue.shift()!;
              const children = treeChildren.get(cur);
              if (children) {
                children.forEach(cid => {
                  if (!subtreeIds.has(cid)) { subtreeIds.add(cid); queue.push(cid); }
                });
              }
            }
            const subNodes = fullNodesRef.current.filter(n => subtreeIds.has(n.id));
            const subEdges = fullEdgesRef.current.filter(e => subtreeIds.has(e.source) && subtreeIds.has(e.target));
            clipboardRef.current = { kind: 'subgraph', nodes: JSON.parse(JSON.stringify(subNodes)), edges: JSON.parse(JSON.stringify(subEdges)) };
            message.success(`已复制子树（${subNodes.length} 节点 · ${subEdges.length} 边）`);
          } else {
            // 无树结构：复制该节点 + 直接相连的邻居 + 边
            const neighborIds = new Set<string>([startId]);
            const neighborEdges = fullEdgesRef.current.filter(e => {
              if (e.source === startId) { neighborIds.add(e.target); return true; }
              if (e.target === startId) { neighborIds.add(e.source); return true; }
              return false;
            });
            const subNodes = fullNodesRef.current.filter(n => neighborIds.has(n.id));
            clipboardRef.current = { kind: 'subgraph', nodes: JSON.parse(JSON.stringify(subNodes)), edges: JSON.parse(JSON.stringify(neighborEdges)) };
            message.success(`已复制邻域（${subNodes.length} 节点 · ${neighborEdges.length} 边）`);
          }
        }},
        { key: 'copyNeighborhood', label: '复制邻域（1跳）', onClick: () => {
          const startId = contextMenu.nodeId!;
          const neighborIds = new Set<string>([startId]);
          const neighborEdges = fullEdgesRef.current.filter(e => {
            if (e.source === startId) { neighborIds.add(e.target); return true; }
            if (e.target === startId) { neighborIds.add(e.source); return true; }
            return false;
          });
          const subNodes = fullNodesRef.current.filter(n => neighborIds.has(n.id));
          clipboardRef.current = { kind: 'subgraph', nodes: JSON.parse(JSON.stringify(subNodes)), edges: JSON.parse(JSON.stringify(neighborEdges)) };
          message.success(`已复制邻域（${subNodes.length} 节点 · ${neighborEdges.length} 边）`);
        }},
        { key: 'saveNodeTpl', label: '存为节点模板', onClick: () => {
          handleSaveNodeTemplate(contextMenu.nodeId!);
        }},
        { key: 'delete', label: '删除节点', danger: true, onClick: () => {
          const n = fullNodesRef.current.find(x => x.id === contextMenu.nodeId);
          if (n) confirmDelete({ kind: 'node', id: n.id, data: n.data });
        }},
      ];
    }
    if (contextMenu.kind === 'edge' && contextMenu.edgeId) {
      return [
        { key: 'edit', label: '编辑边属性', onClick: () => {
          const e2 = fullEdgesRef.current.find(x => x.id === contextMenu.edgeId);
          if (e2) setSelected({ kind: 'edge', id: e2.id, data: e2.data });
        }},
        { key: 'copy', label: '复制边（含端点）', onClick: () => {
          const edge = fullEdgesRef.current.find(x => x.id === contextMenu.edgeId);
          if (edge) {
            const srcNode = fullNodesRef.current.find(n => n.id === edge.source);
            const tgtNode = fullNodesRef.current.find(n => n.id === edge.target);
            const endNodes = [srcNode, tgtNode].filter(Boolean) as CanvasNode[];
            clipboardRef.current = {
              kind: 'subgraph',
              nodes: JSON.parse(JSON.stringify(endNodes)),
              edges: [JSON.parse(JSON.stringify(edge))],
            };
            message.success('已复制边（含端点节点）');
          }
        }},
        { key: 'delete', label: '删除边', danger: true, onClick: () => {
          const e2 = fullEdgesRef.current.find(x => x.id === contextMenu.edgeId);
          if (e2) confirmDelete({ kind: 'edge', id: e2.id, data: e2.data });
        }},
      ];
    }
    // 画布右键：快速建节点（每种类型一条）+ 粘贴 + 复制全图 + 适配
    const quickAddItems = template.node_types.slice(0, 8).map((t) => ({
      key: `quickAdd_${t.type}`,
      label: `新建 ${t.type}`,
      onClick: () => {
        // 右键位置作为节点位置（需转换为 iframe 内部坐标）
        const iframeRect = iframeRef.current?.getBoundingClientRect();
        const px = contextMenu.x - (iframeRect?.left || 0);
        const py = contextMenu.y - (iframeRect?.top || 0);
        handleAddNode(t.type, { x: px, y: py });
      },
    }));
    return [
      ...quickAddItems,
      { key: 'sep1', label: '─', disabled: true, onClick: () => {} },
      { key: 'addNodeModal', label: '添加节点（弹窗）…', onClick: () => {
        setAddNodePosition(undefined);
        setAddNodeParentId(undefined);
        setAddNodeOpen(true);
      }},
      { key: 'paste', label: clipboardRef.current ? `粘贴（${clipboardRef.current.nodes.length} 节点）` : '粘贴', disabled: !clipboardRef.current, onClick: () => {
        handlePaste();
      }},
      { key: 'copyAll', label: `复制全图（${fullNodesRef.current.length} 节点）`, onClick: () => {
        handleCopyAll();
      }},
      { key: 'fit', label: '适配画布', onClick: () => handleFit() },
    ];
  })();

  if (loading && !doc) {
    return <div style={{ textAlign: 'center', padding: 48 }}><Spin /></div>;
  }
  if (!doc) {
    return <Empty description="暂无图谱数据（无草稿也无发布版本）" style={{ padding: 48 }} />;
  }

  const hasTree = !!treeEdgeDefs;
  const undoDisabled = !history || !canUndo(history);
  const redoDisabled = !history || !canRedo(history);

  // 边类型颜色
  const edgeTypeColors: Record<string, string> = {};
  template.edge_types.forEach((et, i) => {
    edgeTypeColors[et.type] = NODE_PALETTE[i % NODE_PALETTE.length];
  });

  // 可见边数
  const visibleEdgeCount = edges.length;

  // 工具栏分隔符（竖线）
  const toolbarSep = <span style={{ width: 1, height: 18, background: '#e5e6eb', margin: '0 3px', flexShrink: 0 }} />;

  // 「视图」下拉：低频视图开关集中收纳
  const viewMenuItems = [
    { key: 'expandAll', icon: <ExpandAltOutlined />, label: '展开全部', disabled: !hasTree, onClick: handleExpandAll },
    { key: 'collapseAll', icon: <ShrinkOutlined />, label: '折叠全部', disabled: !hasTree, onClick: handleCollapseAll },
    { type: 'divider' as const, key: 'vd1' },
    { key: 'align', icon: <AlignLeftOutlined />, label: `对齐辅助${alignGuidesEnabled ? '（已开）' : ''}`, onClick: () => setAlignGuidesEnabled(!alignGuidesEnabled) },
    { key: 'minimap', icon: <GlobalOutlined />, label: `小地图${minimapOpen ? '（已开）' : ''}`, onClick: () => setMinimapOpen(!minimapOpen) },
    { key: 'versionDiff', icon: <DiffOutlined />, label: `版本对比${versionDiffOpen ? '（已开）' : ''}`, disabled: !status || status.versions.length === 0, onClick: () => { if (!versionDiffOpen) setVersionDiffOpen(true); else handleClearVersionDiff(); } },
    { key: 'batchReview', icon: <AuditOutlined />, label: `修订审阅${batchReviewOpen ? '（已开）' : ''}${pendingReviewNodes.length > 0 ? ` (${pendingReviewNodes.length})` : ''}`, disabled: pendingReviewNodes.length === 0, onClick: () => setBatchReviewOpen(!batchReviewOpen) },
    { key: 'shortcuts', icon: <QuestionCircleOutlined />, label: '快捷键', onClick: () => setShortcutsOpen(true) },
  ];

  // 「数据」下拉：导入导出与资产操作集中收纳
  const dataMenuItems = [
    { key: 'export', icon: <DownloadOutlined />, label: '导出 JSON', disabled: !doc || doc.nodes.length === 0, onClick: handleExportJSON },
    { key: 'import', icon: <UploadOutlined />, label: '导入 JSON', onClick: handleImportJSON },
    ...(isV4Asset ? [
      { key: 'exportV4', icon: <DownloadOutlined />, label: '导出 V4.1 JSON', disabled: !doc || doc.nodes.length === 0, onClick: handleExportV4JSON },
      { key: 'importV4', icon: <UploadOutlined />, label: '导入 V4.1 JSON', onClick: handleImportV4JSON },
    ] : []),
    { key: 'png', icon: <FileImageOutlined />, label: '导出 PNG', disabled: !doc || doc.nodes.length === 0, onClick: handleExportPNG },
    { type: 'divider' as const, key: 'dd0' },
    { key: 'csv', icon: <DownloadOutlined />, label: '导出 CSV', disabled: !doc || doc.nodes.length === 0, onClick: handleExportCSV },
    { key: 'jsonld', icon: <DownloadOutlined />, label: '导出 JSON-LD', disabled: !doc || doc.nodes.length === 0, onClick: handleExportJSONLD },
    { key: 'rdf', icon: <DownloadOutlined />, label: '导出 RDF Turtle', disabled: !doc || doc.nodes.length === 0, onClick: handleExportRDF },
    { key: 'graphml', icon: <DownloadOutlined />, label: '导出 GraphML', disabled: !doc || doc.nodes.length === 0, onClick: handleExportGraphML },
    { type: 'divider' as const, key: 'dd1' },
    { key: 'stats', icon: <BarChartOutlined />, label: `概览面板${statsOpen ? '（已开）' : ''}`, onClick: () => setStatsOpen(!statsOpen) },
    { key: 'analysis', icon: <SafetyOutlined />, label: `图分析${analysisOpen ? '（已开）' : ''}`, onClick: () => setAnalysisOpen(!analysisOpen) },
    { key: 'tpl', icon: <AppstoreOutlined />, label: '模板库', onClick: () => { refreshTplDrawer(); setTplDrawerOpen(true); } },
    { key: 'copyAll', icon: <BlockOutlined />, label: '全选复制（Ctrl+Shift+C）', disabled: fullNodesRef.current.length === 0, onClick: handleCopyAll },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, border: '1px solid #e5e6eb', borderRadius: 8, overflow: 'hidden', background: '#fff' }}>
      {/* 工具栏：高频操作 icon 化 + 低频操作收进「视图 / 数据」下拉，保证单行 */}
      <div style={{ display: 'flex', gap: 4, alignItems: 'center', padding: '6px 10px', borderBottom: '1px solid #e5e6eb', flexWrap: 'wrap' }}>
        <Tooltip title="添加节点"><Button size="small" icon={<PlusOutlined />} onClick={() => { setAddNodePosition(undefined); setAddNodeParentId(undefined); setAddNodeOpen(true); }} /></Tooltip>
        <Tooltip title="连线模式"><Button size="small" icon={<AimOutlined />} type={connectMode ? 'primary' : 'default'} onClick={handleToggleConnect} /></Tooltip>
        {toolbarSep}
        <Tooltip title="撤销 Ctrl+Z"><Button size="small" icon={<UndoOutlined />} disabled={undoDisabled} onClick={handleUndo} /></Tooltip>
        <Tooltip title="重做 Ctrl+Y"><Button size="small" icon={<RedoOutlined />} disabled={redoDisabled} onClick={handleRedo} /></Tooltip>
        <Tooltip title="复制选中"><Button size="small" icon={<CopyOutlined />} disabled={!selected && !(multiSelected && multiSelected.length > 0)} onClick={handleCopy} /></Tooltip>
        <Tooltip title="粘贴"><Button size="small" icon={<SnippetsOutlined />} disabled={!clipboardRef.current} onClick={handlePaste} /></Tooltip>
        {toolbarSep}
        <Select
          size="small"
          style={{ width: 96 }}
          value={layoutMode}
          onChange={handleLayout}
          options={LAYOUT_OPTIONS}
        />
        {hasTree && (
          <Tooltip title="分域树面板"><Button size="small" icon={<ApartmentOutlined />} type={treeOpen ? 'primary' : 'default'} onClick={() => setTreeOpen(!treeOpen)} /></Tooltip>
        )}
        {isV4Asset && (
          <Tooltip title="资源注册表（能力/FAQ/策略/技能绑定）">
            <Button size="small" icon={<DatabaseOutlined />} type={registryOpen ? 'primary' : 'default'} onClick={() => setRegistryOpen(true)} />
          </Tooltip>
        )}
        {multiSelected && multiSelected.length > 1 && (
          <>
            {toolbarSep}
            <Button size="small" icon={<CopyOutlined />} onClick={handleCopy}>复制子图({multiSelected.length})</Button>
            <Button size="small" danger onClick={handleBatchDelete}>删除({multiSelected.length})</Button>
          </>
        )}
        {/* 图层面板 */}
        <Popover
          trigger="click"
          content={
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Checkbox
                checked={!hiddenLayers.has('objects')}
                onChange={e => {
                  const next = new Set(hiddenLayers);
                  if (e.target.checked) next.delete('objects'); else next.add('objects');
                  setHiddenLayers(next);
                }}
              >对象 ({layerCounts.objects})</Checkbox>
              <Checkbox
                checked={!hiddenLayers.has('constraints')}
                onChange={e => {
                  const next = new Set(hiddenLayers);
                  if (e.target.checked) next.delete('constraints'); else next.add('constraints');
                  setHiddenLayers(next);
                }}
              >约束·答案 ({layerCounts.constraints})</Checkbox>
            </div>
          }
        >
          <Tooltip title="图层过滤"><Button size="small" icon={hiddenLayers.size > 0 ? <EyeInvisibleOutlined /> : <LayoutOutlined />} /></Tooltip>
        </Popover>
        {/* 边类型过滤 */}
        <Popover
          trigger="click"
          content={
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 300, overflowY: 'auto' }}>
              {allEdgeTypes.map(et => (
                <Checkbox
                  key={et}
                  checked={!hiddenEdgeTypes.has(et)}
                  onChange={e => {
                    const next = new Set(hiddenEdgeTypes);
                    if (e.target.checked) next.delete(et); else next.add(et);
                    setHiddenEdgeTypes(next);
                  }}
                >
                  <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: edgeTypeColors[et] || '#999', marginRight: 6 }} />
                  {et}
                </Checkbox>
              ))}
            </div>
          }
        >
          <Tooltip title={`边类型过滤（${allEdgeTypes.length - hiddenEdgeTypes.size}/${allEdgeTypes.length}）`}>
            <Button size="small" icon={hiddenEdgeTypes.size > 0 ? <EyeInvisibleOutlined /> : <EyeOutlined />} />
          </Tooltip>
        </Popover>
        {toolbarSep}
        <Tooltip title="适配画布"><Button size="small" icon={<ExpandOutlined />} onClick={handleFit} /></Tooltip>
        <Dropdown menu={{ items: viewMenuItems }} trigger={['click']}>
          <Button size="small">视图 <DownOutlined style={{ fontSize: 10 }} /></Button>
        </Dropdown>
        <Dropdown menu={{ items: dataMenuItems }} trigger={['click']}>
          <Button size="small">数据 <DownOutlined style={{ fontSize: 10 }} /></Button>
        </Dropdown>
        {toolbarSep}
        {doc.nodes.some((node) => node.type === 'INTENT') && (
          <Button size="small" icon={<AimOutlined />} onClick={() => setTrialOpen(true)}>AI 评测迭代</Button>
        )}
        {dirty && <Tag color="orange" style={{ marginLeft: 4 }}>未保存</Tag>}
        {onSave && <Button size="small" icon={<SaveOutlined />} loading={saving} disabled={!doc} onClick={onSave}>保存</Button>}
        {onDownloadDraftExcel && <Tooltip title="下载资产草稿的符合 schema 的 Excel（保存草稿时自动生成）"><Button size="small" icon={<DownloadOutlined />} disabled={!doc} onClick={onDownloadDraftExcel}>草稿 Excel</Button></Tooltip>}
        {onValidate && <Tooltip title="双关校验"><Button size="small" icon={<SafetyOutlined />} disabled={!doc} onClick={onValidate} /></Tooltip>}
        {onPublish && <Button size="small" type="primary" icon={<RocketOutlined />} loading={publishing} disabled={!doc} onClick={handlePublishPreview}>发布</Button>}
        <div style={{ marginLeft: 'auto', position: 'relative' }}>
          <Input.Search
            size="small"
            style={{ width: 150 }}
            allowClear
            placeholder="搜索节点 / 属性 (name:转账)"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          {search.trim() && (
            <div style={{
              position: 'absolute', top: 26, right: 0, width: 260, zIndex: 100,
              background: '#fff', border: '1px solid #e5e6eb', borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,.12)',
              maxHeight: 280, overflowY: 'auto', padding: 4,
            }}>
              {searchMatches.slice(0, 12).map(m => (
                <div
                  key={m.id}
                  onClick={() => handleSearchSelect(m.id)}
                  style={{ padding: '4px 8px', fontSize: 12, cursor: 'pointer', borderRadius: 4, display: 'flex', gap: 6, alignItems: 'center' }}
                  onMouseEnter={e => (e.currentTarget.style.background = '#f2f3f5')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  <span style={{ color: '#86909c', fontSize: 10, flexShrink: 0 }}>{m.type}</span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.label}</span>
                  {m.matchField && <span style={{ color: '#1677ff', fontSize: 10, flexShrink: 0 }}>↦{m.matchField}</span>}
                </div>
              ))}
              {searchMatches.length === 0 && (
                <div style={{ borderTop: searchMatches.length > 0 ? '1px solid #f0f0f0' : 'none', marginTop: searchMatches.length > 0 ? 4 : 0, paddingTop: 4 }}>
                  <div style={{ fontSize: 11, color: '#86909c', padding: '4px 8px' }}>未找到匹配节点</div>
                  {template.node_types.slice(0, 6).map(t => (
                    <div
                      key={t.type}
                      onClick={() => {
                        handleAddNode(t.type, undefined, undefined, { name: search.trim() });
                        setSearch('');
                      }}
                      style={{ padding: '4px 8px', fontSize: 12, cursor: 'pointer', borderRadius: 4, display: 'flex', gap: 6, alignItems: 'center' }}
                      onMouseEnter={e => (e.currentTarget.style.background = '#f2f3f5')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    >
                      <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: schema.nodeColors[t.type] || '#5B8FF9', flexShrink: 0 }} />
                      <span style={{ color: '#1677ff' }}>创建 {t.type}</span>
                      <span style={{ color: '#1d2129', fontWeight: 500 }}>「{search.trim()}」</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 图谱 iframe + 属性面板 + AI审核补全（可调整三栏分屏，flex 自适应高度） */}
      <Group orientation="horizontal" style={{ flex: 1, minHeight: 360 }}>

        {/* 左栏：节点库 + 分域树 */}
        <Panel defaultSize="15" minSize={56} maxSize="30" style={{ display: 'flex', overflow: 'hidden' }}>
          <NodePalette template={template} nodeColors={schema.nodeColors} onAddNode={(t) => handleAddNode(t)} />
          {treeOpen && treeChildren && (
            <div style={{ flex: 1, minWidth: 0, borderRight: '1px solid #e5e6eb', background: '#fff', overflowY: 'auto' }}>
              <DomainTreePanel
                nodes={nodes}
                childrenOf={treeChildren}
                domainTints={DOMAIN_TINTS}
                onSelect={(id) => { sendToIframe({ type: 'focusNode', nodeId: id }); const n = fullNodesRef.current.find(x => x.id === id); if (n) setSelected({ kind: 'node', id: n.id, data: n.data }); }}
                onDelete={(id) => { const n = fullNodesRef.current.find(x => x.id === id); if (n) confirmDelete({ kind: 'node', id: n.id, data: n.data }); }}
                onAddChild={(parentId) => { setAddNodeParentId(parentId); setAddNodePosition(undefined); setAddNodeOpen(true); }}
              />
            </div>
          )}
        </Panel>
        <Separator style={{ width: 4, background: '#e5e6eb', cursor: 'col-resize' }} />

        {/* 中栏：画布 iframe */}
        <Panel minSize="30">
          <div style={{ position: 'relative', width: '100%', height: '100%' }} onClick={() => { if (contextMenu) setContextMenu(null); }}>
          {/* 画布左下角：可见性统计 */}
          <div style={{
            position: 'absolute', left: 8, bottom: 8, zIndex: 10, pointerEvents: 'none',
            padding: '2px 8px', borderRadius: 6, fontSize: 11, color: '#4e5969',
            background: 'rgba(255,255,255,.88)', border: '1px solid #e5e6eb',
          }}>
            当前可见 {nodes.length}/{fullNodesRef.current.length} 节点 · {visibleEdgeCount}/{fullEdgesRef.current.length} 边
          </div>
          <iframe
            ref={iframeRef}
            src={iframeSrc}
            style={{ width: '100%', height: '100%', border: 'none' }}
            title="图谱可视化"
          />
          {iframeError && (
            <div style={{
              position: 'absolute', inset: 0, background: 'rgba(255,255,255,.95)',
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              padding: 24, color: '#e5484d', fontSize: 13, textAlign: 'center',
            }}>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>图谱渲染失败</div>
              <div style={{ wordBreak: 'break-all', maxWidth: 400 }}>{iframeError}</div>
              <Button size="small" style={{ marginTop: 12 }} onClick={() => setIframeError(null)}>关闭</Button>
            </div>
          )}
          {/* 右键菜单 */}
          {contextMenu && contextMenuItems.length > 0 && (
            <div style={{
              position: 'fixed', top: contextMenu.y, left: contextMenu.x, zIndex: 1050,
              background: '#fff', border: '1px solid #e5e6eb', borderRadius: 8,
              boxShadow: '0 4px 16px rgba(0,0,0,.12)', padding: 4, minWidth: 160,
            }}>
              {contextMenuItems.map(item => (
                <div
                  key={item.key}
                  onClick={() => { if (!item.disabled) { item.onClick?.(); setContextMenu(null); } }}
                  style={{
                    padding: '6px 12px', fontSize: 13, borderRadius: 4,
                    cursor: item.disabled ? 'not-allowed' : 'pointer',
                    color: item.disabled ? '#c9cdd4' : (item.danger ? '#f53f3f' : '#1d2129'),
                  }}
                  onMouseEnter={e => { if (!item.disabled) e.currentTarget.style.background = item.danger ? '#fff0f0' : '#f2f3f5'; }}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  {item.label}
                </div>
              ))}
            </div>
          )}
          {/* P3-1: 小地图导航 */}
          {minimapOpen && fullNodesRef.current.length > 0 && (() => {
            const MAP_W = 200, MAP_H = 140, PAD = 8;
            const ns = fullNodesRef.current;
            const es = fullEdgesRef.current;
            const xs = ns.map(n => n.position?.x ?? 0);
            const ys = ns.map(n => n.position?.y ?? 0);
            const minX = Math.min(...xs), maxX = Math.max(...xs);
            const minY = Math.min(...ys), maxY = Math.max(...ys);
            const rangeX = Math.max(1, maxX - minX);
            const rangeY = Math.max(1, maxY - minY);
            const scale = Math.min((MAP_W - PAD * 2) / rangeX, (MAP_H - PAD * 2) / rangeY);
            const offsetX = (MAP_W - rangeX * scale) / 2;
            const offsetY = (MAP_H - rangeY * scale) / 2;
            const toMapX = (x: number) => (x - minX) * scale + offsetX;
            const toMapY = (y: number) => (y - minY) * scale + offsetY;
            return (
              <div style={{
                position: 'absolute', bottom: 8, right: 8, width: MAP_W, height: MAP_H,
                background: 'rgba(255,255,255,.92)', border: '1px solid #d9d9d9',
                borderRadius: 6, boxShadow: '0 2px 8px rgba(0,0,0,.1)', zIndex: 10,
                overflow: 'hidden',
              }}>
                <svg width={MAP_W} height={MAP_H} style={{ cursor: 'pointer' }} onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const cx = e.clientX - rect.left;
                  const cy = e.clientY - rect.top;
                  let nearest: string | null = null;
                  let minDist = Infinity;
                  ns.forEach(n => {
                    const px = toMapX(n.position?.x ?? 0);
                    const py = toMapY(n.position?.y ?? 0);
                    const d = Math.hypot(px - cx, py - cy);
                    if (d < minDist) { minDist = d; nearest = n.id; }
                  });
                  if (nearest) handleSearchSelect(nearest);
                }}>
                  {/* 边 */}
                  {es.map(e => {
                    const src = ns.find(n => n.id === e.source);
                    const tgt = ns.find(n => n.id === e.target);
                    if (!src || !tgt) return null;
                    return (
                      <line key={e.id}
                        x1={toMapX(src.position?.x ?? 0)} y1={toMapY(src.position?.y ?? 0)}
                        x2={toMapX(tgt.position?.x ?? 0)} y2={toMapY(tgt.position?.y ?? 0)}
                        stroke="#d9d9d9" strokeWidth={0.5}
                      />
                    );
                  })}
                  {/* 节点 */}
                  {ns.map(n => {
                    const color = schema.nodeColors[String(n.data.nodeType || '')] || '#5B8FF9';
                    return (
                      <circle key={n.id}
                        cx={toMapX(n.position?.x ?? 0)}
                        cy={toMapY(n.position?.y ?? 0)}
                        r={2.5}
                        fill={color}
                        fillOpacity={0.7}
                      />
                    );
                  })}
                </svg>
                <div style={{ position: 'absolute', top: 2, left: 6, fontSize: 10, color: '#86909c', pointerEvents: 'none' }}>
                  {ns.length} 节点 · {es.length} 边
                </div>
              </div>
            );
          })()}
          {/* 图分析面板（画布内浮动） */}
          {analysisOpen && (
            <div style={{
              position: 'absolute', top: 8, right: 8, width: 280,
              background: 'rgba(255,255,255,.96)', border: '1px solid #d9d9d9',
              borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,.12)', zIndex: 10,
              overflow: 'auto', maxHeight: 'calc(100% - 16px)',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid #f0f0f0' }}>
                <span style={{ fontWeight: 600, fontSize: 13 }}>图分析</span>
                <span style={{ cursor: 'pointer', color: '#86909c', fontSize: 12 }} onClick={() => setAnalysisOpen(false)}>关闭</span>
              </div>
              <div style={{ padding: '8px 12px' }}>
                <Select
                  size="small"
                  style={{ width: '100%', marginBottom: 8 }}
                  value={analysisType}
                  onChange={setAnalysisType}
                  options={[
                    { value: 'centrality', label: '中心性分析' },
                    { value: 'communities', label: '社区发现' },
                    { value: 'connected', label: '联通子图' },
                    { value: 'cycles', label: '环路检测' },
                    { value: 'kcore', label: 'K-Core分解' },
                    { value: 'degree', label: '度分布' },
                  ]}
                />
                <Button size="small" type="primary" block onClick={handleRunAnalysis} disabled={!doc || doc.nodes.length === 0}>运行分析</Button>
              </div>
              {analysisResult && (
                <div style={{ padding: '0 12px 8px' }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#4e5969', marginBottom: 6, marginTop: 4 }}>{analysisResult.label}</div>
                  {analysisResult.items.length === 0 ? (
                    <div style={{ fontSize: 11, color: '#86909c', textAlign: 'center', padding: '12px 0' }}>无结果</div>
                  ) : analysisResult.items.map((item, i) => (
                    <div key={item.id || i} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3, fontSize: 11 }}>
                      <span style={{ width: 20, color: '#86909c', flexShrink: 0 }}>{i + 1}.</span>
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#1d2129' }}>{item.label}</span>
                      <span style={{ color: '#1677ff', fontWeight: 600, flexShrink: 0 }}>{item.value}</span>
                    </div>
                  ))}
                  {analysisResult.items.some(it => it.extra) && (
                    <details style={{ marginTop: 6 }}>
                      <summary style={{ fontSize: 11, color: '#86909c', cursor: 'pointer' }}>详细信息</summary>
                      {analysisResult.items.filter(it => it.extra).slice(0, 10).map((it, i) => (
                        <div key={i} style={{ fontSize: 10, color: '#86909c', padding: '2px 0', borderBottom: '1px dashed #f0f0f0' }}>
                          <span style={{ color: '#1d2129', fontWeight: 500 }}>{it.label}</span>: {it.extra}
                        </div>
                      ))}
                    </details>
                  )}
                </div>
              )}
            </div>
          )}

          {/* 版本对比面板 */}
          {versionDiffOpen && (
            <div style={{
              position: 'absolute', top: 8, right: statsOpen ? 296 : (analysisOpen ? 296 : 8), width: 280,
              background: 'rgba(255,255,255,.96)', border: '1px solid #d9d9d9',
              borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,.12)', zIndex: 10,
              overflow: 'auto', maxHeight: 'calc(100% - 16px)',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid #f0f0f0' }}>
                <span style={{ fontWeight: 600, fontSize: 13 }}>版本对比</span>
                <span style={{ cursor: 'pointer', color: '#86909c', fontSize: 12 }} onClick={handleClearVersionDiff}>关闭</span>
              </div>
              <div style={{ padding: '8px 12px' }}>
                <Select
                  size="small"
                  style={{ width: '100%', marginBottom: 8 }}
                  placeholder="选择对比版本"
                  value={compareVersion || undefined}
                  loading={loadingVersionDiff}
                  onChange={(v) => handleStartVersionDiff(v)}
                  options={(status?.versions || []).map(v => ({
                    value: v.version,
                    label: `${v.version}${v.note ? ' · ' + v.note : ''}${v.stats ? ` (${v.stats.nodes}节点/${v.stats.edges}边)` : ''}`,
                  }))}
                />
              </div>
              {versionDiffResult && (
                <div style={{ padding: '0 12px 8px' }}>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8 }}>
                    <Tag color="green" style={{ margin: 0, fontSize: 11 }}>新增 {versionDiffResult.stats.nodesAdded}</Tag>
                    <Tag color="orange" style={{ margin: 0, fontSize: 11 }}>修改 {versionDiffResult.stats.nodesModified}</Tag>
                    <Tag color="red" style={{ margin: 0, fontSize: 11 }}>删除 {versionDiffResult.stats.nodesRemoved}</Tag>
                  </div>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8 }}>
                    <Tag color="green" style={{ margin: 0, fontSize: 11 }}>+{versionDiffResult.stats.edgesAdded}边</Tag>
                    <Tag color="orange" style={{ margin: 0, fontSize: 11 }}>~{versionDiffResult.stats.edgesModified}边</Tag>
                    <Tag color="red" style={{ margin: 0, fontSize: 11 }}>-{versionDiffResult.stats.edgesRemoved}边</Tag>
                  </div>
                  <div style={{ fontSize: 11, color: '#86909c', marginBottom: 4 }}>
                    对比：{versionDiffResult.baselineLabel} → {versionDiffResult.targetLabel}
                  </div>
                  {/* 图例 */}
                  <div style={{ display: 'flex', gap: 8, fontSize: 10, color: '#86909c', marginBottom: 6, alignItems: 'center' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}><span style={{ width: 8, height: 8, borderRadius: '50%', background: '#52c41a', display: 'inline-block' }} />新增节点</span>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}><span style={{ width: 8, height: 8, borderRadius: '50%', background: '#faad14', display: 'inline-block' }} />已修改</span>
                  </div>
                  {/* 新增节点列表 */}
                  {versionDiffResult.nodes.filter(n => n.kind === 'added').length > 0 && (
                    <details open style={{ marginBottom: 4 }}>
                      <summary style={{ fontSize: 11, color: '#52c41a', cursor: 'pointer', fontWeight: 600 }}>新增节点（{versionDiffResult.stats.nodesAdded}）</summary>
                      {versionDiffResult.nodes.filter(n => n.kind === 'added').map(n => (
                        <div key={n.id} style={{ fontSize: 11, color: '#1d2129', padding: '1px 0 1px 12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          🟢 {n.label}<span style={{ color: '#86909c' }}> · {n.type}</span>
                        </div>
                      ))}
                    </details>
                  )}
                  {/* 修改节点列表 */}
                  {versionDiffResult.nodes.filter(n => n.kind === 'modified').length > 0 && (
                    <details style={{ marginBottom: 4 }}>
                      <summary style={{ fontSize: 11, color: '#faad14', cursor: 'pointer', fontWeight: 600 }}>修改节点（{versionDiffResult.stats.nodesModified}）</summary>
                      {versionDiffResult.nodes.filter(n => n.kind === 'modified').map(n => (
                        <div key={n.id} style={{ fontSize: 11, color: '#1d2129', padding: '1px 0 1px 12px' }}>
                          🟡 {n.label}
                          {n.changes && n.changes.length > 0 && (
                            <span style={{ color: '#86909c' }}> · {n.changes.map(c => c.field).join(', ')}</span>
                          )}
                        </div>
                      ))}
                    </details>
                  )}
                  {/* 删除节点列表 */}
                  {versionDiffResult.nodes.filter(n => n.kind === 'removed').length > 0 && (
                    <details style={{ marginBottom: 4 }}>
                      <summary style={{ fontSize: 11, color: '#f5222d', cursor: 'pointer', fontWeight: 600 }}>删除节点（{versionDiffResult.stats.nodesRemoved}）</summary>
                      {versionDiffResult.nodes.filter(n => n.kind === 'removed').map(n => (
                        <div key={n.id} style={{ fontSize: 11, color: '#86909c', padding: '1px 0 1px 12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          🔴 {n.label}<span> · {n.type}</span>
                        </div>
                      ))}
                    </details>
                  )}
                </div>
              )}
            </div>
          )}

          {/* 批量审阅面板 */}
          {batchReviewOpen && pendingReviewNodes.length > 0 && (
            <div style={{
              position: 'absolute', top: 8, right: statsOpen ? 296 : (analysisOpen ? 296 : (versionDiffOpen ? 296 : 8)), width: 280,
              background: 'rgba(255,255,255,.96)', border: '1px solid #d9d9d9',
              borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,.12)', zIndex: 10,
              overflow: 'auto', maxHeight: 'calc(100% - 16px)',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid #f0f0f0' }}>
                <span style={{ fontWeight: 600, fontSize: 13 }}>修订审阅 ({pendingReviewNodes.length})</span>
                <span style={{ cursor: 'pointer', color: '#86909c', fontSize: 12 }} onClick={() => setBatchReviewOpen(false)}>关闭</span>
              </div>
              <div style={{ padding: '8px 12px' }}>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8 }}>
                  <Tag color="orange" style={{ margin: 0, fontSize: 11 }}>待审节点 {pendingReviewNodes.length}</Tag>
                  <Tag color="blue" style={{ margin: 0, fontSize: 11 }}>待审边 {pendingReviewEdges.length}</Tag>
                </div>
                {/* 批量操作按钮 */}
                <div style={{ display: 'flex', gap: 4, marginBottom: 8, flexWrap: 'wrap' }}>
                  <Button size="small" type="primary" icon={<CheckCircleOutlined />} onClick={handleAcceptAllPending} style={{ fontSize: 11 }}>全部接受</Button>
                  <Button size="small" danger icon={<CloseCircleOutlined />} onClick={handleRejectAllPending} style={{ fontSize: 11 }}>全部拒绝</Button>
                </div>
                {batchSelectedIds.size > 0 && (
                  <div style={{ display: 'flex', gap: 4, marginBottom: 8, flexWrap: 'wrap' }}>
                    <Button size="small" icon={<CheckCircleOutlined />} onClick={() => handleBatchAccept(batchSelectedIds)} style={{ fontSize: 11 }}>接受选中({batchSelectedIds.size})</Button>
                    <Button size="small" danger icon={<CloseCircleOutlined />} onClick={() => handleBatchReject(batchSelectedIds)} style={{ fontSize: 11 }}>拒绝选中({batchSelectedIds.size})</Button>
                  </div>
                )}
                {/* 图例 */}
                <div style={{ fontSize: 10, color: '#86909c', marginBottom: 6 }}>
                  接受 = 标记为已审核 | 拒绝 = 从画布移除
                </div>
                {/* 待审节点列表 */}
                <div style={{ borderTop: '1px dashed #f0f0f0', paddingTop: 6 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: '#faad14', marginBottom: 4 }}>
                    待审节点列表
                  </div>
                  {pendingReviewNodes.map(n => {
                    const props = (n.properties || {}) as Record<string, unknown>;
                    const label = String(props.name || props.title || n.id);
                    const nodeType = n.type || '';
                    const conf = props.confidence != null ? `置信度 ${(Number(props.confidence) * 100).toFixed(0)}%` : '';
                    return (
                      <div key={n.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 4, marginBottom: 3, fontSize: 11 }}>
                        <Checkbox
                          checked={batchSelectedIds.has(n.id)}
                          onChange={() => toggleBatchSelect(n.id)}
                          style={{ flexShrink: 0, marginTop: 1 }}
                        />
                        <div style={{ flex: 1, overflow: 'hidden' }}>
                          <div style={{ color: '#1d2129', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {label}
                          </div>
                          <div style={{ color: '#86909c', fontSize: 10 }}>
                            {nodeType}{conf ? ` · ${conf}` : ''}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
          </div>
        </Panel>

        <Separator style={{ width: 4, background: '#e5e6eb', cursor: 'col-resize' }} />

        {/* 右栏：属性面板 + AI审核补全（竖直分割） */}
        <Panel defaultSize="25" minSize={320} maxSize="50">
          <Group orientation="vertical" style={{ height: '100%' }}>
            <Panel defaultSize="55" minSize={20} style={{ borderLeft: '1px solid #e5e6eb', background: '#fff', overflowY: 'auto' }}>
              <PropertyPanel
                selected={selected}
                schema={schema}
                referenceNodes={template.template_id === 'intent-graph' ? fullNodesRef.current.map((node) => ({ id: node.id, type: String(node.data.nodeType || ''), name: String(node.data.name || node.id), answerText: String(node.data.answer_text || ''), contentStatus: String(node.data.content_status || '') })) : undefined}
                onEditingInFieldChange={setEditingInField}
                onFieldChange={handleFieldChange}
                onAiAction={handleAiAction}
                onAiAssist={selected?.kind === 'node' && selected.data.nodeType === 'AGGREGATE_INTENT' ? () => {
                  setAssistGroupNodeId(selected.id);
                  setAssistAutoStart(true);
                  setAssistOpen(true);
                } : undefined}
                onNodeReview={handleNodeReview}
                nodeReviewRunningGroups={nodeReviewRunningGroups}
                reviewItems={selected ? (nodeReviewMap[`${selected.kind}:${selected.id}`]) : undefined}
                onDecideReview={handleDecideReview}
                onDelete={() => {
                  if (selected) confirmDelete(selected);
                }}
              />
            </Panel>
          </Group>
        </Panel>

        <Separator style={{ width: 4, background: '#e5e6eb', cursor: 'col-resize' }} />

        {/* 最右栏：图谱概览（统计 + 质量评分 + 类型分布），页面级常驻 */}
        {statsOpen && graphStats && (() => {
          const nodeTypeEntries = Object.entries(graphStats.nodeTypeDist).sort((a, b) => b[1] - a[1]);
          const edgeTypeEntries = Object.entries(graphStats.edgeTypeDist).sort((a, b) => b[1] - a[1]);
          const maxNodeCount = Math.max(1, ...nodeTypeEntries.map(([, c]) => c));
          const maxEdgeCount = Math.max(1, ...edgeTypeEntries.map(([, c]) => c));
          const nodeLabelMap = new Map(schema.nodeTypeDefs.map(d => [d.type, d.label]));
          const edgeLabelMap = new Map(schema.edgeTypeDefs.map(d => [d.type, d.label]));
          return (
            <Panel defaultSize="18" minSize={200} maxSize="30" style={{ display: 'flex', overflow: 'hidden' }}>
              <div style={{ width: '100%', height: '100%', overflowY: 'auto', background: '#fff', borderLeft: '1px solid #e5e6eb', display: 'flex', flexDirection: 'column' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', borderBottom: '1px solid #f0f0f0', flexShrink: 0 }}>
                  <span style={{ fontWeight: 600, fontSize: 13 }}>图谱概览</span>
                  <span style={{ cursor: 'pointer', color: '#86909c', fontSize: 12 }} onClick={() => setStatsOpen(false)}>收起 »</span>
                </div>
                {/* 概览数字 */}
                <div style={{ display: 'flex', gap: 8, padding: '8px 12px' }}>
                  <div style={{ flex: 1, textAlign: 'center', background: '#f2f3f5', borderRadius: 6, padding: '6px 0' }}>
                    <div style={{ fontSize: 18, fontWeight: 700, color: '#1677ff' }}>{graphStats.totalNodes}</div>
                    <div style={{ fontSize: 11, color: '#86909c' }}>总节点</div>
                  </div>
                  <div style={{ flex: 1, textAlign: 'center', background: '#f2f3f5', borderRadius: 6, padding: '6px 0' }}>
                    <div style={{ fontSize: 18, fontWeight: 700, color: '#52c41a' }}>{graphStats.totalEdges}</div>
                    <div style={{ fontSize: 11, color: '#86909c' }}>总边数</div>
                  </div>
                  <div style={{ flex: 1, textAlign: 'center', background: '#f2f3f5', borderRadius: 6, padding: '6px 0' }}>
                    <div style={{ fontSize: 18, fontWeight: 700, color: '#fa8c16' }}>{graphStats.visibleNodes}</div>
                    <div style={{ fontSize: 11, color: '#86909c' }}>可见节点</div>
                  </div>
                </div>
                {/* 图层开关 */}
                <div style={{ padding: '6px 12px 8px', borderBottom: '1px solid #f0f0f0', marginBottom: 4 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#4e5969', marginBottom: 6 }}>显示内容</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12, color: '#1d2129' }}>
                      <input type="checkbox" checked={!hiddenLayers.has('objects')} onChange={e => { const next = new Set(hiddenLayers); if (e.target.checked) next.delete('objects'); else next.add('objects'); setHiddenLayers(next); }} style={{ accentColor: '#1677ff' }} />
                      <span>业务对象（{layerCounts.objects}）</span>
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12, color: '#1d2129' }}>
                      <input type="checkbox" checked={!hiddenLayers.has('constraints')} onChange={e => { const next = new Set(hiddenLayers); if (e.target.checked) next.delete('constraints'); else next.add('constraints'); setHiddenLayers(next); }} style={{ accentColor: '#1677ff' }} />
                      <span>约束·答案（{layerCounts.constraints}）</span>
                    </label>
                  </div>
                  {/* 节点类型开关（聚合/叶子等层级类型显隐——大图可只看聚合骨架） */}
                  {nodeTypeEntries.length > 0 && (
                    <div style={{ marginTop: 8 }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: '#86909c', marginBottom: 4 }}>节点类型（{nodeTypeEntries.length - hiddenNodeTypes.size}/{nodeTypeEntries.length}）</div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 160, overflowY: 'auto' }}>
                        {nodeTypeEntries.map(([nt, count]) => {
                          const label = nodeLabelMap.get(nt) || nt;
                          return (
                            <label key={nt} style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', fontSize: 11, color: '#4e5969' }}>
                              <input type="checkbox" checked={!hiddenNodeTypes.has(nt)} onChange={e => { const next = new Set(hiddenNodeTypes); if (e.target.checked) next.delete(nt); else next.add(nt); setHiddenNodeTypes(next); }} style={{ accentColor: '#1677ff' }} />
                              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
                              <span style={{ color: '#86909c', flexShrink: 0 }}>{count}</span>
                            </label>
                          );
                        })}
                      </div>
                      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                        <a style={{ fontSize: 10, color: '#1677ff', cursor: 'pointer' }} onClick={() => setHiddenNodeTypes(new Set())}>全选</a>
                        <a style={{ fontSize: 10, color: '#1677ff', cursor: 'pointer' }} onClick={() => setHiddenNodeTypes(new Set(nodeTypeEntries.map(([nt]) => nt)))}>全不选</a>
                      </div>
                    </div>
                  )}
                  {/* 边类型开关 */}
                  {allEdgeTypes.length > 0 && (
                    <div style={{ marginTop: 8 }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: '#86909c', marginBottom: 4 }}>边类型（{allEdgeTypes.length - hiddenEdgeTypes.size}/{allEdgeTypes.length}）</div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 160, overflowY: 'auto' }}>
                        {allEdgeTypes.map(et => {
                          const label = edgeLabelMap.get(et) || et;
                          const count = graphStats.edgeTypeDist[et] || 0;
                          return (
                            <label key={et} style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', fontSize: 11, color: '#4e5969' }}>
                              <input type="checkbox" checked={!hiddenEdgeTypes.has(et)} onChange={e => { const next = new Set(hiddenEdgeTypes); if (e.target.checked) next.delete(et); else next.add(et); setHiddenEdgeTypes(next); }} style={{ accentColor: '#1677ff' }} />
                              <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: edgeTypeColors[et] || '#999', flexShrink: 0 }} />
                              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
                              <span style={{ color: '#86909c', flexShrink: 0 }}>{count}</span>
                            </label>
                          );
                        })}
                      </div>
                      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                        <a style={{ fontSize: 10, color: '#1677ff', cursor: 'pointer' }} onClick={() => setHiddenEdgeTypes(new Set())}>全选</a>
                        <a style={{ fontSize: 10, color: '#1677ff', cursor: 'pointer' }} onClick={() => setHiddenEdgeTypes(new Set(allEdgeTypes))}>全不选</a>
                      </div>
                    </div>
                  )}
                </div>
                {/* 质量评分 */}
                {qualityScore && (() => {
                  const gradeColor = qualityScore.grade === 'A' ? '#52c41a' : qualityScore.grade === 'B' ? '#1677ff' : qualityScore.grade === 'C' ? '#faad14' : qualityScore.grade === 'D' ? '#fa8c16' : '#f5222d';
                  return (
                    <div style={{ padding: '4px 12px 8px', borderBottom: '1px solid #f0f0f0', marginBottom: 4 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                        <span style={{ fontSize: 12, fontWeight: 600, color: '#4e5969' }}>质量评分</span>
                        <span style={{ fontSize: 20, fontWeight: 800, color: gradeColor }}>{qualityScore.overall}<span style={{ fontSize: 12, fontWeight: 600, marginLeft: 2 }}>分 {qualityScore.grade}</span></span>
                      </div>
                      {qualityScore.dimensions.map(dim => (
                        <div key={dim.name} style={{ marginBottom: 4 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#1d2129', marginBottom: 1 }}>
                            <span>{dim.name} <span style={{ color: '#86909c' }}>({dim.weight}%)</span></span>
                            <span style={{ color: dim.score >= 75 ? '#52c41a' : dim.score >= 50 ? '#faad14' : '#f5222d', fontWeight: 600 }}>{dim.score}</span>
                          </div>
                          <div style={{ height: 6, background: '#f2f3f5', borderRadius: 3, overflow: 'hidden' }}>
                            <div style={{ width: `${dim.score}%`, height: '100%', background: dim.score >= 75 ? '#52c41a' : dim.score >= 50 ? '#faad14' : '#f5222d', borderRadius: 3, transition: 'width .3s' }} />
                          </div>
                          {dim.issues > 0 && <div style={{ fontSize: 10, color: '#86909c', marginTop: 1 }}>{dim.detail}</div>}
                        </div>
                      ))}
                      {qualityScore.recommendations.length > 0 && (
                        <details style={{ marginTop: 6 }}>
                          <summary style={{ fontSize: 11, color: '#1677ff', cursor: 'pointer' }}>改进建议 ({qualityScore.recommendations.length})</summary>
                          {qualityScore.recommendations.map((rec, i) => (
                            <div key={i} style={{ fontSize: 10, color: '#4e5969', padding: '2px 0', borderBottom: '1px dashed #f0f0f0' }}>{rec}</div>
                          ))}
                        </details>
                      )}
                    </div>
                  );
                })()}
                {/* 节点类型分布 */}
                <div style={{ padding: '4px 12px 8px' }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#4e5969', marginBottom: 6 }}>节点类型分布</div>
                  {nodeTypeEntries.map(([type, count]) => (
                    <div key={type} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                      <span style={{ fontSize: 11, color: '#1d2129', width: 70, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={type}>{nodeLabelMap.get(type) || type}</span>
                      <div style={{ flex: 1, height: 14, background: '#f2f3f5', borderRadius: 3, overflow: 'hidden' }}>
                        <div style={{ width: `${(count / maxNodeCount) * 100}%`, height: '100%', background: schema.nodeColors[type] || '#5B8FF9', borderRadius: 3 }} />
                      </div>
                      <span style={{ fontSize: 11, color: '#86909c', width: 24, textAlign: 'right' }}>{count}</span>
                    </div>
                  ))}
                </div>
                {/* 边类型分布 */}
                {edgeTypeEntries.length > 0 && (
                  <div style={{ padding: '4px 12px 8px' }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#4e5969', marginBottom: 6 }}>边类型分布</div>
                    {edgeTypeEntries.map(([type, count]) => (
                      <div key={type} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                        <span style={{ fontSize: 11, color: '#1d2129', width: 70, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={type}>{edgeLabelMap.get(type) || type}</span>
                        <div style={{ flex: 1, height: 14, background: '#f2f3f5', borderRadius: 3, overflow: 'hidden' }}>
                          <div style={{ width: `${(count / maxEdgeCount) * 100}%`, height: '100%', background: '#5D7092', borderRadius: 3 }} />
                        </div>
                        <span style={{ fontSize: 11, color: '#86909c', width: 24, textAlign: 'right' }}>{count}</span>
                      </div>
                    ))}
                  </div>
                )}
                {/* 关联最密集的节点（连接数最多前5名） */}
                {graphStats.topNodes.length > 0 && (
                  <div style={{ padding: '4px 12px 8px' }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#4e5969', marginBottom: 2 }}>关联最密集的节点</div>
                    <div style={{ fontSize: 10, color: '#86909c', marginBottom: 6 }}>按连接数（边数）从多到少排列</div>
                    {graphStats.topNodes.map((n, i) => (
                      <div key={n.id} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3, fontSize: 11 }}>
                        <span style={{ width: 16, color: '#86909c', flexShrink: 0 }}>{i + 1}.</span>
                        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#1d2129' }}>{n.name}</span>
                        <span style={{ color: '#1677ff', fontWeight: 600 }}>{n.degree} 条连接</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </Panel>
          );
        })()}

        {/* 收起状态下的小展开按钮（贴在右侧栏位置） */}
        {!statsOpen && graphStats && (
          <Panel defaultSize="4" minSize={32} maxSize={48} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div
              style={{
                cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
                padding: '8px 4px', borderRadius: 6, background: '#f2f3f5', width: '100%',
              }}
              onClick={() => setStatsOpen(true)}
            >
              <BarChartOutlined style={{ fontSize: 16, color: '#1677ff' }} />
              <span style={{ fontSize: 10, color: '#4e5969', writingMode: 'vertical-rl', letterSpacing: 2 }}>概览</span>
            </div>
          </Panel>
        )}
      </Group>

      {/* 添加节点弹窗 */}
      <AddNodeModal
        open={addNodeOpen}
        template={template}
        parentId={addNodeParentId}
        position={addNodePosition}
        onClose={() => { setAddNodeOpen(false); setAddNodePosition(undefined); setAddNodeParentId(undefined); }}
        onCreate={(type, properties, parentId) => {
          handleAddNode(type, addNodePosition, parentId, properties);
          setAddNodeOpen(false);
          setAddNodePosition(undefined);
          setAddNodeParentId(undefined);
        }}
      />

      {/* 边类型选择弹窗 */}
      {edgeTypeModal && (
        <SelectEdgeTypeModal
          open
          template={template}
          candidates={edgeTypeModal.candidates}
          recommendations={edgeTypeModal.recommendations}
          sourceName={edgeTypeModal.sourceName}
          targetName={edgeTypeModal.targetName}
          onClose={() => setEdgeTypeModal(null)}
          onConfirm={(edgeType) => {
            createEdge(edgeTypeModal.source, edgeTypeModal.target, edgeType);
            setEdgeTypeModal(null);
          }}
        />
      )}

      {/* 连线到空白：选择目标节点类型 → 创建节点 + 连线 */}
      <Modal
        open={connectCanvasOpen}
        title="连线到新节点"
        onCancel={() => { setConnectCanvasOpen(false); setConnectCanvasSource(null); setConnectCanvasPosition(null); }}
        footer={null}
        width={360}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '4px 0' }}>
          <p style={{ fontSize: 12, color: '#86909c', marginBottom: 4 }}>选择目标节点类型，将创建新节点并自动连线：</p>
          {template.node_types.map((t) => {
            const srcNode = fullNodesRef.current.find(n => n.id === connectCanvasSource);
            const srcType = srcNode ? String(srcNode.data.nodeType || '') : '';
            const edgeCandidates = suggestEdgeTypes(template, srcType, t.type);
            return (
              <Button
                key={t.type}
                block
                style={{ textAlign: 'left', height: 'auto', padding: '8px 12px' }}
                disabled={edgeCandidates.length === 0}
                onClick={() => {
                  if (!connectCanvasSource || !connectCanvasPosition) return;
                  // 1. 创建目标节点
                  handleAddNode(t.type, connectCanvasPosition, undefined, undefined);
                  // 2. 找到刚创建的节点（最新创建的该类型节点）
                  const srcNode2 = fullNodesRef.current.find(n => n.id === connectCanvasSource);
                  // 递增的节点ID是按时间戳生成的，最新创建的就是最后一个
                  const newNode = fullNodesRef.current[fullNodesRef.current.length - 1];
                  if (newNode && srcNode2) {
                    // 3. 连线
                    const edgeType = edgeCandidates[0];
                    if (edgeCandidates.length === 1) {
                      createEdge(connectCanvasSource, newNode.id, edgeType);
                    } else {
                      const srcName = String(srcNode2.data.name || srcNode2.data.title || connectCanvasSource);
                      const tgtName = String(newNode.data.name || newNode.data.title || newNode.id);
                      const recs = rankEdgeTypes(template, edgeCandidates, srcName, tgtName, srcType, t.type);
                      setEdgeTypeModal({
                        source: connectCanvasSource,
                        target: newNode.id,
                        sourceName: srcName,
                        targetName: tgtName,
                        candidates: edgeCandidates,
                        recommendations: recs,
                      });
                    }
                  }
                  setConnectCanvasOpen(false);
                  setConnectCanvasSource(null);
                  setConnectCanvasPosition(null);
                  setConnectMode(false);
                  sendToIframe({ type: 'setConnectMode', enabled: false });
                }}
              >
                <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: schema.nodeColors[t.type] || '#5B8FF9', marginRight: 8 }} />
                {t.type} · {t.label}
                {edgeCandidates.length === 0 && <span style={{ float: 'right', color: '#c9cdd4', fontSize: 11 }}>无可用边类型</span>}
                {edgeCandidates.length > 0 && <span style={{ float: 'right', color: '#86909c', fontSize: 11 }}>{edgeCandidates.length} 种边</span>}
              </Button>
            );
          })}
        </div>
      </Modal>

      <AiAssistDrawer open={assistOpen} onClose={() => { setAssistOpen(false); setAssistAutoStart(false); }}
        asset={asset}
        template={template}
        currentDocument={doc}
        onMerged={handleAiMergeProposal}
        onLocateNode={(id) => locateNode(id)}
        groupNodeId={assistGroupNodeId}
        autoStart={assistAutoStart}
      />

      {isV4Asset && (
        <ResourceRegistryDrawer
          open={registryOpen}
          onClose={() => setRegistryOpen(false)}
          registries={doc ? (readRegistries(doc) as unknown as V4Registries) : null}
          onFocusChange={setEditingInField}
          onChange={(next) => {
            if (!doc) return;
            onDocumentChange({ ...doc, metadata: { ...(doc.metadata || {}), v4ResourceRegistries: next } });
          }}
        />
      )}

      {trialOpen && <IntentTrialDrawer open onClose={() => setTrialOpen(false)} document={doc}
        onLocate={(id) => {
          sendToIframe({ type: 'focusNode', nodeId: id });
          const node = fullNodesRef.current.find((item) => item.id === id);
          if (node) setSelected({ kind: 'node', id: node.id, data: node.data });
        }}
        onUpdateDocument={(updated) => handleAiMergeProposal(updated)} />}

      {/* P1: 模板库抽屉 */}
      <TemplateLibraryDrawer
        open={tplDrawerOpen}
        onClose={() => setTplDrawerOpen(false)}
        template={template}
        nodeTemplates={nodeTemplates}
        subgraphTemplates={subgraphTemplates}
        onInsertNode={handleInsertNodeFromTemplate}
        onInsertSubgraph={handleInsertSubgraphFromTemplate}
        onDeleteNodeTemplate={(id) => { removeNodeTemplate(id); setNodeTemplates(loadNodeTemplates()); }}
        onDeleteSubgraphTemplate={(id) => { removeSubgraphTemplate(id); setSubgraphTemplates(loadSubgraphTemplates()); }}
      />

      {/* 快捷优化：键盘快捷键帮助 */}
      <Modal
        open={shortcutsOpen}
        title="键盘快捷键"
        onCancel={() => setShortcutsOpen(false)}
        footer={null}
        width={420}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          {[
            { keys: 'Ctrl+Z', desc: '撤销' },
            { keys: 'Ctrl+Y / Ctrl+Shift+Z', desc: '重做' },
            { keys: 'Ctrl+C', desc: '复制选中节点/边（支持多选框选子图）' },
            { keys: 'Ctrl+V', desc: '粘贴（自动重映射 ID）' },
            { keys: 'Ctrl+Shift+C', desc: '复制全图' },
            { keys: 'Delete / Backspace', desc: '删除选中节点/边（含确认弹窗）' },
            { keys: '双击空白', desc: '在该位置添加节点（弹窗选择类型）' },
            { keys: '右键', desc: '上下文菜单（编辑/复制/删除等）' },
          ].map((item, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', padding: '8px 0', borderBottom: i < 7 ? '1px solid #f2f3f5' : 'none' }}>
              <span style={{ display: 'inline-block', minWidth: 180, fontFamily: 'monospace', fontSize: 12, color: '#1677ff', fontWeight: 600, background: '#f0f5ff', padding: '2px 8px', borderRadius: 4, marginRight: 12 }}>
                {item.keys}
              </span>
              <span style={{ fontSize: 13, color: '#1d2129' }}>{item.desc}</span>
            </div>
          ))}
        </div>
      </Modal>

      {/* AI生成结果 diff 审查面板 */}
      <Modal
        open={!!pendingMerge}
        title="AI 生成结果审查"
        onCancel={cancelAiMerge}
        width={680}
        footer={
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: '#86909c' }}>
              {mergeDiff ? `变更：+${mergeDiff.stats.nodesAdded + mergeDiff.stats.edgesAdded} ~${mergeDiff.stats.nodesModified + mergeDiff.stats.edgesModified} -${mergeDiff.stats.nodesRemoved + mergeDiff.stats.edgesRemoved}` : ''}
            </span>
            <div style={{ display: 'flex', gap: 8 }}>
              <Button onClick={cancelAiMerge}>取消</Button>
              <Button type="primary" onClick={confirmAiMerge}>确认合并</Button>
            </div>
          </div>
        }
      >
        {mergeDiff && (() => {
          const s = mergeDiff.stats;
          const addedNodes = mergeDiff.nodes.filter(n => n.kind === 'added');
          const removedNodes = mergeDiff.nodes.filter(n => n.kind === 'removed');
          const modifiedNodes = mergeDiff.nodes.filter(n => n.kind === 'modified');
          const addedEdges = mergeDiff.edges.filter(e => e.kind === 'added');
          const removedEdges = mergeDiff.edges.filter(e => e.kind === 'removed');
          const modifiedEdges = mergeDiff.edges.filter(e => e.kind === 'modified');
          const toggleNode = (entry: NodeDiffEntry) => {
            if (entry.kind === 'added') {
              const next = new Set(diffRejectedNodes);
              if (next.has(entry.id)) next.delete(entry.id); else next.add(entry.id);
              setDiffRejectedNodes(next);
            } else if (entry.kind === 'removed') {
              const key = `keep:${entry.id}`;
              const next = new Set(diffRejectedNodes);
              if (next.has(key)) next.delete(key); else next.add(key);
              setDiffRejectedNodes(next);
            }
          };
          const toggleEdge = (entry: EdgeDiffEntry) => {
            if (entry.kind === 'added') {
              const next = new Set(diffRejectedEdges);
              if (next.has(entry.id)) next.delete(entry.id); else next.add(entry.id);
              setDiffRejectedEdges(next);
            } else if (entry.kind === 'removed') {
              const key = `keep:${entry.id}`;
              const next = new Set(diffRejectedEdges);
              if (next.has(key)) next.delete(key); else next.add(key);
              setDiffRejectedEdges(next);
            }
          };
          const rowStyle = (kind: string, rejected: boolean): CSSProperties => ({
            display: 'flex', alignItems: 'center', gap: 6, padding: '3px 6px', marginBottom: 2, borderRadius: 4,
            background: rejected ? '#f2f3f5' : kind === 'added' ? '#f6ffed' : kind === 'removed' ? '#fff2f0' : '#fffbe6',
            opacity: rejected ? 0.5 : 1, fontSize: 12,
          });
          const kindColor = (kind: string) => kind === 'added' ? '#52c41a' : kind === 'removed' ? '#f5222d' : '#faad14';
          const kindLabel = (kind: string) => kind === 'added' ? '新增' : kind === 'removed' ? '删除' : '修改';
          return (
            <div style={{ maxHeight: 480, overflow: 'auto' }}>
              {/* 统计概览 */}
              <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
                <Tag color="green">新增节点 {s.nodesAdded}</Tag>
                <Tag color="red">删除节点 {s.nodesRemoved}</Tag>
                <Tag color="orange">修改节点 {s.nodesModified}</Tag>
                <Tag color="green">新增边 {s.edgesAdded}</Tag>
                <Tag color="red">删除边 {s.edgesRemoved}</Tag>
                <Tag color="orange">修改边 {s.edgesModified}</Tag>
              </div>
              {/* 新增节点 */}
              {addedNodes.length > 0 && (
                <div style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#52c41a', marginBottom: 4 }}>新增节点</div>
                  {addedNodes.map(n => {
                    const rejected = diffRejectedNodes.has(n.id);
                    return (
                      <div key={n.id} style={rowStyle('added', rejected)}>
                        <Checkbox checked={!rejected} onChange={() => toggleNode(n)} />
                        <span style={{ color: kindColor('added'), fontWeight: 600, width: 32 }}>{kindLabel('added')}</span>
                        <span style={{ flex: 1 }}>{n.label}</span>
                        <Tag style={{ fontSize: 10 }}>{n.type}</Tag>
                      </div>
                    );
                  })}
                </div>
              )}
              {/* 删除节点 */}
              {removedNodes.length > 0 && (
                <div style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#f5222d', marginBottom: 4 }}>删除节点</div>
                  {removedNodes.map(n => {
                    const rejected = diffRejectedNodes.has(`keep:${n.id}`);
                    return (
                      <div key={n.id} style={rowStyle('removed', !rejected)}>
                        <Checkbox checked={rejected} onChange={() => toggleNode(n)} />
                        <span style={{ color: kindColor('removed'), fontWeight: 600, width: 32 }}>{kindLabel('removed')}</span>
                        <span style={{ flex: 1, textDecoration: 'line-through' }}>{n.label}</span>
                        <Tag style={{ fontSize: 10 }}>{n.type}</Tag>
                      </div>
                    );
                  })}
                </div>
              )}
              {/* 修改节点 */}
              {modifiedNodes.length > 0 && (
                <div style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#faad14', marginBottom: 4 }}>修改节点</div>
                  {modifiedNodes.map(n => (
                    <div key={n.id} style={rowStyle('modified', false)}>
                      <span style={{ color: kindColor('modified'), fontWeight: 600, width: 32 }}>{kindLabel('modified')}</span>
                      <span style={{ flex: 1 }}>{n.label}</span>
                      {n.changes?.slice(0, 3).map((c, i) => (
                        <Tag key={i} style={{ fontSize: 10 }}>{c.field}</Tag>
                      ))}
                    </div>
                  ))}
                </div>
              )}
              {/* 新增边 */}
              {addedEdges.length > 0 && (
                <div style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#52c41a', marginBottom: 4 }}>新增边</div>
                  {addedEdges.map(e => {
                    const rejected = diffRejectedEdges.has(e.id);
                    return (
                      <div key={e.id} style={rowStyle('added', rejected)}>
                        <Checkbox checked={!rejected} onChange={() => toggleEdge(e)} />
                        <span style={{ color: kindColor('added'), fontWeight: 600, width: 32 }}>{kindLabel('added')}</span>
                        <span style={{ flex: 1 }}>{e.source} → {e.target}</span>
                        <Tag style={{ fontSize: 10 }}>{e.type}</Tag>
                      </div>
                    );
                  })}
                </div>
              )}
              {/* 删除边 */}
              {removedEdges.length > 0 && (
                <div style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#f5222d', marginBottom: 4 }}>删除边</div>
                  {removedEdges.map(e => {
                    const rejected = diffRejectedEdges.has(`keep:${e.id}`);
                    return (
                      <div key={e.id} style={rowStyle('removed', !rejected)}>
                        <Checkbox checked={rejected} onChange={() => toggleEdge(e)} />
                        <span style={{ color: kindColor('removed'), fontWeight: 600, width: 32 }}>{kindLabel('removed')}</span>
                        <span style={{ flex: 1, textDecoration: 'line-through' }}>{e.source} → {e.target}</span>
                        <Tag style={{ fontSize: 10 }}>{e.type}</Tag>
                      </div>
                    );
                  })}
                </div>
              )}
              {/* 修改边 */}
              {modifiedEdges.length > 0 && (
                <div style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#faad14', marginBottom: 4 }}>修改边</div>
                  {modifiedEdges.map(e => (
                    <div key={e.id} style={rowStyle('modified', false)}>
                      <span style={{ color: kindColor('modified'), fontWeight: 600, width: 32 }}>{kindLabel('modified')}</span>
                      <span style={{ flex: 1 }}>{e.source} → {e.target}</span>
                      {e.changes?.slice(0, 3).map((c, i) => (
                        <Tag key={i} style={{ fontSize: 10 }}>{c.field}</Tag>
                      ))}
                    </div>
                  ))}
                </div>
              )}
              {mergeDiff.nodes.length === 0 && mergeDiff.edges.length === 0 && (
                <div style={{ textAlign: 'center', color: '#86909c', padding: 24 }}>无变更</div>
              )}
            </div>
          );
        })()}
      </Modal>

      {/* 发布前预览 Modal */}
      <Modal
        open={publishPreviewOpen}
        title="发布前预览"
        onCancel={() => { setPublishPreviewOpen(false); setPublishPreviewDiff(null); }}
        width={620}
        footer={
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: '#86909c' }}>
              {publishPreviewDiff
                ? `变更：+${publishPreviewDiff.stats.nodesAdded + publishPreviewDiff.stats.edgesAdded} ~${publishPreviewDiff.stats.nodesModified + publishPreviewDiff.stats.edgesModified} -${publishPreviewDiff.stats.nodesRemoved + publishPreviewDiff.stats.edgesRemoved}`
                : '首次发布'}
            </span>
            <div style={{ display: 'flex', gap: 8 }}>
              <Button onClick={() => { setPublishPreviewOpen(false); setPublishPreviewDiff(null); }}>取消</Button>
              <Button type="primary" loading={publishing} onClick={handleConfirmPublish}>确认发布</Button>
            </div>
          </div>
        }
      >
        {loadingPublishPreview ? (
          <div style={{ textAlign: 'center', padding: 32 }}><Spin tip="加载版本对比..." /></div>
        ) : (
          <div>
            {/* 质量评分摘要 */}
            {qualityScore && (
              <div style={{ marginBottom: 16, padding: 12, background: '#fafafa', borderRadius: 8, border: '1px solid #f0f0f0' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
                  <div style={{
                    width: 48, height: 48, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontWeight: 700, fontSize: 20,
                    background: qualityScore.overall >= 75 ? '#f6ffed' : qualityScore.overall >= 50 ? '#fffbe6' : '#fff2f0',
                    color: qualityScore.overall >= 75 ? '#52c41a' : qualityScore.overall >= 50 ? '#faad14' : '#f5222d',
                    border: `2px solid ${qualityScore.overall >= 75 ? '#52c41a' : qualityScore.overall >= 50 ? '#faad14' : '#f5222d'}`,
                  }}>
                    {qualityScore.overall}
                  </div>
                  <div>
                    <div style={{ fontSize: 16, fontWeight: 600 }}>
                      质量等级 {qualityScore.grade}
                      {qualityScore.grade === 'A' && <span style={{ color: '#52c41a', marginLeft: 6 }}>优秀</span>}
                      {qualityScore.grade === 'B' && <span style={{ color: '#1677ff', marginLeft: 6 }}>良好</span>}
                      {qualityScore.grade === 'C' && <span style={{ color: '#faad14', marginLeft: 6 }}>合格</span>}
                      {qualityScore.grade === 'D' && <span style={{ color: '#fa8c16', marginLeft: 6 }}>待改进</span>}
                      {qualityScore.grade === 'F' && <span style={{ color: '#f5222d', marginLeft: 6 }}>不合格</span>}
                    </div>
                    <div style={{ fontSize: 12, color: '#86909c' }}>
                      {qualityScore.dimensions.map(d => `${d.name} ${d.score}`).join(' · ')}
                    </div>
                  </div>
                </div>
                {qualityScore.recommendations.length > 0 && (
                  <div style={{ fontSize: 12, color: '#86909c' }}>
                    <span style={{ fontWeight: 600 }}>改进建议：</span>
                    {qualityScore.recommendations.slice(0, 3).map((r, i) => (
                      <div key={i} style={{ paddingLeft: 8, marginTop: 2 }}>• {r}</div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* 版本 diff 摘要 */}
            {publishPreviewDiff ? (
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
                  与已发布版本对比（{publishPreviewDiff.baselineLabel} → {publishPreviewDiff.targetLabel}）
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
                  <Tag color="green" style={{ margin: 0 }}>新增节点 {publishPreviewDiff.stats.nodesAdded}</Tag>
                  <Tag color="orange" style={{ margin: 0 }}>修改节点 {publishPreviewDiff.stats.nodesModified}</Tag>
                  <Tag color="red" style={{ margin: 0 }}>删除节点 {publishPreviewDiff.stats.nodesRemoved}</Tag>
                  <Tag color="green" style={{ margin: 0 }}>新增边 {publishPreviewDiff.stats.edgesAdded}</Tag>
                  <Tag color="orange" style={{ margin: 0 }}>修改边 {publishPreviewDiff.stats.edgesModified}</Tag>
                  <Tag color="red" style={{ margin: 0 }}>删除边 {publishPreviewDiff.stats.edgesRemoved}</Tag>
                </div>
                {publishPreviewDiff.nodes.length === 0 && publishPreviewDiff.edges.length === 0 && (
                  <div style={{ textAlign: 'center', color: '#86909c', padding: 16 }}>无变更内容</div>
                )}
                {/* 变更详情 */}
                {publishPreviewDiff.nodes.filter(n => n.kind === 'added').length > 0 && (
                  <details open style={{ marginBottom: 4 }}>
                    <summary style={{ fontSize: 12, color: '#52c41a', cursor: 'pointer', fontWeight: 600 }}>新增节点（{publishPreviewDiff.stats.nodesAdded}）</summary>
                    {publishPreviewDiff.nodes.filter(n => n.kind === 'added').map(n => (
                      <div key={n.id} style={{ fontSize: 12, color: '#1d2129', padding: '1px 0 1px 12px' }}>🟢 {n.label} <span style={{ color: '#86909c' }}>· {n.type}</span></div>
                    ))}
                  </details>
                )}
                {publishPreviewDiff.nodes.filter(n => n.kind === 'removed').length > 0 && (
                  <details style={{ marginBottom: 4 }}>
                    <summary style={{ fontSize: 12, color: '#f5222d', cursor: 'pointer', fontWeight: 600 }}>删除节点（{publishPreviewDiff.stats.nodesRemoved}）</summary>
                    {publishPreviewDiff.nodes.filter(n => n.kind === 'removed').map(n => (
                      <div key={n.id} style={{ fontSize: 12, color: '#86909c', padding: '1px 0 1px 12px' }}>🔴 {n.label} <span>· {n.type}</span></div>
                    ))}
                  </details>
                )}
              </div>
            ) : (
              <div style={{ textAlign: 'center', color: '#86909c', padding: 16 }}>
                首次发布，无历史版本可对比
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
