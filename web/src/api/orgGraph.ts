/**
 * AI Harbor org-graph API 客户端（图谱构建工作台专用）
 *
 * ⚠️ 全部 fetch 走同源 /api 前缀，由反向代理转发到图谱服务。
 * org-graph 在 AI Harbor（3000），经 nginx 同源代理 /api/org-graph/* 访问
 * （生产 docker/nginx/nginx.conf 与 vite dev proxy 均已配置）。
 */
import { getToken } from '@/utils/auth';

const BASE = '/api/org-graph';

// ── 类型（与 AI Harbor routes/org-graph.js 响应形状一致） ──

export interface GraphTemplateField {
  key: string;
  label: string;
  type: 'string' | 'multiline' | 'number' | 'boolean' | 'date' | 'enum' | 'multi_enum' | 'tags' | 'url';
  required: boolean;
  default?: unknown;
  options?: string[];
}

export interface GraphTemplateNodeType {
  type: string;
  label: string;
  style?: { color?: string; shape?: string };
  fields: GraphTemplateField[];
}

export interface GraphTemplateEdgeType {
  type: string;
  label: string;
  source_types: string[];
  target_types: string[];
  style?: { color?: string };
  fields: GraphTemplateField[];
}

/** 树骨架边声明（支持多种边各自指定父节点端） */
export type TreeEdgeDecl = { type: string; parent?: 'source' | 'target' };

/** 模板声明的布局与边显示偏好（组织树等规整布局） */
export interface GraphTemplateLayout {
  /** 树骨架边类型（string[] 时父端统一取 tree_parent）；声明后布局用组织树布局替代 dagre */
  tree_edges?: string[] | TreeEdgeDecl[];
  /** 树边的父节点端（REPORTS_TO 方向为 下级→上级 → parent 在 target） */
  tree_parent?: 'source' | 'target';
  /** 默认隐藏的边类型（噪声大时提升可读性，工具栏可开关） */
  default_hidden_edges?: string[];
  /** 首次加载的默认布局（无坐标时生效）；force=力导向（知识图谱观感） */
  default_layout?: 'force' | 'tree' | 'dagre';
  /** 初始折叠深度（根=0，折叠 depth >= 该值的子树；默认 3；大图资产设小值只显示顶层） */
  initial_collapse_depth?: number;
}

export interface GraphTemplate {
  template_id: string;
  template_version: string;
  name: string;
  name_en?: string;
  description?: string;
  node_types: GraphTemplateNodeType[];
  edge_types: GraphTemplateEdgeType[];
  starter_graph?: { nodes: unknown[]; edges: unknown[] };
  validation_rules: Record<string, boolean>;
  layout?: GraphTemplateLayout;
  metadata?: Record<string, unknown>;
}

export interface GraphAsset {
  assetId: string;
  name: string;
  name_en?: string;
  /** 管理字段（旧版 AI Harbor 可能缺省） */
  description?: string;
  builtin?: boolean;
  createdAt?: string;
  versionCount?: number;
  latestPublishedAt?: string | null;
  templateId: string;
  templateVersion: string;
  nodeTypes: string[];
  edgeTypes: string[];
  hasPublished: boolean;
  /** active 版本内容统计（P0 闭环字段，旧版缺省） */
  activeVersion?: string | null;
  activeStats?: { nodes: number; edges: number } | null;
  hasDraft?: boolean;
  /** knowledge-qa 检索端使用的图谱 ID（org/<子目录>/<version>） */
  graphId?: string | null;
}

/** 溯源/置信度/审阅状态放元素顶层（X6 校验器只查 properties，已验证安全） */
export interface GraphProvenance {
  source: 'manual' | 'ai-generate' | 'ai-extract' | 'ai-assist' | 'tabular';
  sourceDoc?: string;
  sourceChunk?: string;
  description?: string;
  generatedAt?: string;
}

export type ReviewStatus = 'pending' | 'accepted' | 'rejected' | 'merged';

export interface GraphNode {
  id: string;
  type: string;
  properties: Record<string, unknown>;
  x?: number;
  y?: number;
  provenance?: GraphProvenance;
  confidence?: number;
  review_status?: ReviewStatus;
  /** v2.1 原对象整存（数据桥双通道无损保真；X6 校验器不查顶层键） */
  raw?: unknown;
}

export interface GraphEdge {
  id: string;
  type: string;
  source: string;
  target: string;
  properties: Record<string, unknown>;
  provenance?: GraphProvenance;
  confidence?: number;
  review_status?: ReviewStatus;
  /** v2.1 原对象整存（同上） */
  raw?: unknown;
}

export interface GraphDocument {
  document_id?: string;
  document_version?: string;
  asset_id?: string;
  template_ref?: { template_id: string; template_version: string };
  nodes: GraphNode[];
  edges: GraphEdge[];
  metadata?: Record<string, unknown>;
}

export interface GraphStatus {
  asset: string;
  activeVersion: string | null;
  versions: { version: string; file: string; published_at: string; note?: string; name?: string; stats?: { nodes: number; edges: number } }[];
  /** 回滚事件（切 active 指针时记录；旧版后端缺省） */
  rollbacks?: { from: string | null; to: string; at: string }[];
  draft: { document_id?: string; nodes: number; edges: number; updated_at?: string; name?: string; status?: string } | null;
}

export interface ValidationReport {
  valid: boolean;
  errors: { code: string; message: string; path?: string }[];
  warnings?: { code: string; message: string }[];
}

/** 质量校验发现（规则检查与 LLM 语义审查共用形状） */
export interface AuditFinding {
  severity: 'high' | 'medium' | 'low';
  category: string;
  node_ids: string[];
  edge_ids: string[];
  issue: string;
  suggestion: string;
}

export interface AuditResult {
  /** 确定性规则检查（不发 LLM，秒出） */
  deterministic: AuditFinding[];
  /** LLM 语义审查（全图摘要 → deepseek → qwen 回退；失败为空） */
  semantic: AuditFinding[];
  stats: {
    nodes: number; edges: number; deterministic: number;
    coverage?: 'full' | 'partial' | 'batched';
    batches?: number;
    batchDetail?: { ok: number; failed: number; failedBatches: { batch: number; error: string }[]; globalPass: string };
    auditedNodes?: number; auditedEdges?: number;
  };
  /** 'ok' = LLM 审查完成；'parse_error' = 输出解析失败（≠无发现）；其他 = LLM 不可用原因 */
  llm: string;
}

export interface ExtractResult {
  entities: { name: string; type: string; description?: string; fields?: Record<string, unknown>; sourceDoc?: string; sourceChunk?: string; confidence?: number }[];
  relations: { source: string; type: string; target: string; fields?: Record<string, unknown>; sourceDoc?: string; confidence?: number }[];
  stats?: Record<string, unknown>;
  resume?: ExtractResume;
}

export interface ExtractResume {
  total: number;
  fromCache: number;
  failed: number;
  failedDocs?: { id: string; error: string }[];
}

export interface ExtractOptions {
  jobId?: string;
  onProgress?: (completed: number, total: number, phase?: string, gleanTotal?: number) => void;
}

export interface TabularNodeMapping {
  nodeType: string;
  idColumn?: string;
  nameColumn?: string;
  fieldMap?: Record<string, string>;
}

export interface TabularEdgeMapping {
  edgeType: string;
  sourceNodeType: string;
  targetNodeType: string;
  sourceColumn: string;
  targetColumn: string;
  idColumn?: string;
  weightColumn?: string;
  fieldMap?: Record<string, string>;
}

// ── 底层 fetch（Bearer + 统一错误处理；响应包 {success, data} / {success:false, error}） ──

/** 携带后端错误码的 API 错误（如 ORG_GRAPH_DRAFT_SHRINK_GUARD），调用方按 code 分支处理 */
export class OrgGraphApiError extends Error {
  code: string;
  statusCode: number;
  constructor(message: string, code: string, statusCode: number) {
    super(message);
    this.name = 'OrgGraphApiError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function isOrgGraphError(e: unknown, code: string): boolean {
  return e instanceof OrgGraphApiError && e.code === code;
}

/** 常规请求默认超时；LLM 长任务端点（抽取/填充/审查等）显式传 LLM_TIMEOUT_MS */
const DEFAULT_TIMEOUT_MS = 120_000;
const LLM_TIMEOUT_MS = 900_000; // 对齐 nginx /api 代理超时

async function request<T>(method: string, path: string, body?: unknown, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload: string | undefined;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let res: Response;
  try {
    // cache: no-store —— 模板/资产/图谱数据实时变化，禁止浏览器启发式缓存旧响应
    res = await fetch(`${BASE}${path}`, { method, headers, body: payload, cache: 'no-store', signal: controller.signal });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new OrgGraphApiError(`请求超时（${Math.round(timeoutMs / 1000)} 秒无响应）：服务可能仍在处理，请稍后重试`, 'ORG_GRAPH_TIMEOUT', 0);
    }
    throw new Error('网络连接失败，请检查图谱服务（org-graph API）是否可用');
  } finally {
    if (timer) clearTimeout(timer);
  }
  const json = await res.json().catch(() => ({}));
  if (!json.success) {
    const message = json.error?.message || json.message || `HTTP ${res.status}`;
    throw new OrgGraphApiError(message, json.error?.code || 'ORG_GRAPH_ERROR', res.status);
  }
  return json.data as T;
}

function get<T>(path: string): Promise<T> {
  return request<T>('GET', path);
}

function post<T>(path: string, body: unknown, timeoutMs?: number): Promise<T> {
  return request<T>('POST', path, body, timeoutMs);
}

function patch<T>(path: string, body: unknown): Promise<T> {
  return request<T>('PATCH', path, body);
}

function put<T>(path: string, body: unknown): Promise<T> {
  return request<T>('PUT', path, body);
}

function del<T>(path: string): Promise<T> {
  return request<T>('DELETE', path);
}

// ── 端点（与 AI Harbor routes/org-graph.js 一一对应） ──

/** 资产列表（模板选择器数据源） */
export function listAssets(): Promise<GraphAsset[]> {
  return get<GraphAsset[]>('/assets');
}

// ── 图谱知识测试集（确定性派生引擎的 REST 路，load 仅供建图外的平台 UI 导入桥） ──

export interface IntentEvalGraphBinding {
  assetId: string;
  graphId: string;
  version: string;
  digest: string;
}

export interface IntentEvalCase {
  caseId: string;
  category: string;
  subcategory?: string;
  query: string;
  turns: string[];
  pageContext?: Record<string, unknown>;
  intentId?: string;
  expected: Record<string, unknown>;
  derivation: { sourceNodeIds: string[]; rule?: string; fields?: string[] };
}

export interface IntentEvalDataset {
  datasetId: string;
  graph: IntentEvalGraphBinding;
  digest: string;
  categories: string[];
  counts: Record<string, number>;
  totalCases: number;
  cases: IntentEvalCase[];
}

/** 读取已落盘的五类意图测试集全量 JSON（测试集管理页导入桥专用）；端点回 {dataset, outputPath,...} 包装，这里拍平 */
export async function loadIntentEvalDataset(
  asset: string,
  version?: string,
): Promise<IntentEvalDataset & { outputPath: string }> {
  const res = await post<{
    dataset: IntentEvalDataset;
    outputPath: string;
    counts?: IntentEvalDataset['counts'];
    graph?: IntentEvalDataset['graph'];
    digest?: string;
  }>('/eval-dataset', { action: 'load', asset, version });
  const ds = res.dataset;
  return { ...ds, totalCases: ds.totalCases ?? (Array.isArray(ds.cases) ? ds.cases.length : 0), outputPath: res.outputPath };
}

// ── 内容级管理（P1）/ 治理（P2）──

export interface AssetLatest {
  assetId: string;
  version: string;
  graphId: string;
  publishedAt: string;
  note: string;
  stats: { nodes: number; edges: number };
}

export interface AssetContentPage {
  assetId: string;
  version: string;
  total: number;
  matched: number;
  typeCounts: Record<string, number>;
  nodes: { id: string; type: string; properties: Record<string, unknown> }[];
  offset: number;
  limit: number;
}

export interface EntityDetail {
  assetId: string;
  version: string;
  node: GraphNode;
  degree: number;
  edges: GraphEdge[];
  neighbors: { id: string; type: string; properties: Record<string, unknown> }[];
}

export interface AssetDiff {
  assetId: string;
  from: string;
  to: string;
  summary: {
    nodes: { from: number; to: number; added: number; removed: number; changed: number };
    edges: { from: number; to: number; added: number; removed: number; changed: number };
  };
  nodes: { added: { id: string; type: string; name: string }[]; removed: { id: string; type: string; name: string }[]; changed: { id: string; type: string; name: string }[] };
  edges: { added: { id: string; type: string; source: string; target: string }[]; removed: { id: string; type: string; source: string; target: string }[]; changed: { id: string; type: string; source: string; target: string }[] };
}

export interface AuditEntry {
  at: string;
  action: string;
  version?: string;
  note?: string;
  from?: string | null;
  to?: string;
  requestId?: string;
  stats?: { nodes: number; edges: number };
  [key: string]: unknown;
}

/** 最新已发布版本（knowledge-qa 消费端 graphId 解析口径一致） */
export function getLatestPublished(asset: string): Promise<AssetLatest> {
  return get<AssetLatest>(`/assets/${encodeURIComponent(asset)}/latest`);
}

/** 实体检索 + 类型分布（active 或指定版本） */
export function fetchAssetContent(asset: string, params: { q?: string; type?: string; limit?: number; offset?: number; version?: string } = {}): Promise<AssetContentPage> {
  const search = new URLSearchParams();
  if (params.q) search.set('q', params.q);
  if (params.type) search.set('type', params.type);
  if (params.limit) search.set('limit', String(params.limit));
  if (params.offset) search.set('offset', String(params.offset));
  if (params.version) search.set('version', params.version);
  const qs = search.toString();
  return get<AssetContentPage>(`/assets/${encodeURIComponent(asset)}/content${qs ? `?${qs}` : ''}`);
}

/** 单实体详情（属性 + 关联边 + 邻居） */
export function fetchEntityDetail(asset: string, nodeId: string, version?: string): Promise<EntityDetail> {
  const suffix = version ? `?version=${encodeURIComponent(version)}` : '';
  return get<EntityDetail>(`/assets/${encodeURIComponent(asset)}/entities/${encodeURIComponent(nodeId)}${suffix}`);
}

/** 两版本内容 diff（默认 to=active） */
export function fetchAssetDiff(asset: string, from: string, to?: string): Promise<AssetDiff> {
  const suffix = to ? `&to=${encodeURIComponent(to)}` : '';
  return get<AssetDiff>(`/assets/${encodeURIComponent(asset)}/diff?from=${encodeURIComponent(from)}${suffix}`);
}

/** 操作审计日志（倒序） */
export function fetchAssetAudit(asset: string): Promise<{ assetId: string; auditLog: AuditEntry[] }> {
  return get<{ assetId: string; auditLog: AuditEntry[] }>(`/assets/${encodeURIComponent(asset)}/audit`);
}

export interface PublishRequest {
  id: string;
  status: 'pending' | 'approved' | 'rejected';
  note: string;
  snapshotFile: string;
  stats: { nodes: number; edges: number };
  createdAt: string;
  decidedAt?: string;
}

/** 发布审批申请列表（倒序，含已处理） */
export function listPublishRequests(asset: string): Promise<{ assetId: string; requests: PublishRequest[] }> {
  return get(`/assets/${encodeURIComponent(asset)}/publish-requests`);
}

/** 审批通过 / 拒绝（通过即按提交时快照发布） */
export function decidePublishRequest(asset: string, requestId: string, approve: boolean): Promise<{ assetId: string; request: PublishRequest; published?: { version: string; stats: { nodes: number; edges: number }; contentDigest?: string } }> {
  return post(`/assets/${encodeURIComponent(asset)}/publish-requests/${encodeURIComponent(requestId)}/${approve ? 'approve' : 'reject'}`, {});
}

/** 资产模板（编辑器 schema 来源） */
export function getTemplate(asset: string): Promise<GraphTemplate> {
  return get<GraphTemplate>(`/template?asset=${encodeURIComponent(asset)}`);
}

/** 状态（activeVersion / 版本历史 / 草稿摘要） */
export function getStatus(asset: string): Promise<GraphStatus> {
  return get<GraphStatus>(`/status?asset=${encodeURIComponent(asset)}`);
}

/** 加载：draft 优先 → 指定版本 → active 版本 */
export function loadGraph(asset: string, version?: string): Promise<GraphDocument> {
  const query = version ? `&version=${encodeURIComponent(version)}` : '';
  return get<GraphDocument>(`/load?asset=${encodeURIComponent(asset)}${query}`);
}

/** 保存草稿；force=true（手动保存/导入/恢复）绕过骤减防线，自动保存不放行 */
export function saveGraph(asset: string, document: GraphDocument, options?: { force?: boolean }): Promise<{ saved: boolean; asset: string }> {
  return post<{ saved: boolean; asset: string }>('/save', { asset, document, force: options?.force === true });
}

/** 草稿历史项 */
export interface DraftHistoryItem {
  file: string;
  savedAt: string;
  nodes: number;
  edges: number;
  bytes: number;
}

/** 草稿历史列表（倒序，最近 30 份） */
export function draftHistory(asset: string): Promise<{ asset: string; items: DraftHistoryItem[] }> {
  return get<{ asset: string; items: DraftHistoryItem[] }>(`/draft-history?asset=${encodeURIComponent(asset)}`);
}

/** 从草稿历史恢复：当前草稿先归档，历史快照写回草稿 */
export function restoreDraft(asset: string, file: string): Promise<{ restored: boolean; asset: string; file: string; nodes: number; edges: number; previousArchivedAs: string }> {
  return post<{ restored: boolean; asset: string; file: string; nodes: number; edges: number; previousArchivedAs: string }>('/draft-restore', { asset, file });
}

/** 双关校验（资产校验器 + X6 模板校验器） */
export function validateGraph(asset: string, document: GraphDocument): Promise<{ valid: boolean; asset: ValidationReport; template: ValidationReport }> {
  return post<{ valid: boolean; asset: ValidationReport; template: ValidationReport }>('/validate', { asset, document });
}

/** 发布（校验通过 → 不可变版本 + manifest active 切换）；审批模式下转发布请求，pendingApproval=true */
export interface GraphPublishResult {
  version: string;
  manifest: unknown;
  contentDigest: string;
  stats: { nodes: number; edges: number };
  validation: { asset: ValidationReport; template: ValidationReport };
  pendingApproval?: boolean;
  request?: { id: string; status: string };
}

export function publishGraph(asset: string, document: GraphDocument, note: string): Promise<GraphPublishResult> {
  return post<GraphPublishResult>('/publish', { asset, document, note });
}

export interface DraftTrialPolicy {
  strategy: 'rules' | 'semantic' | 'hybrid';
  model: 'off' | 'auto' | 'deepseek-v4-flash' | 'qwen-plus';
  topK: number;
  matchThreshold: number;
  clarifyThreshold: number;
  ambiguityMargin: number;
}

export interface DraftTrialCandidate {
  id: string; name: string; domain: string; intentType: string;
  score: number; localScore: number; semanticScore: number | null; evidence: string[];
  fulfillmentKind: string; fulfillmentRef: string; fulfillmentPreview: string;
  mock: boolean; clarificationPrompt: string; handoffIssue: string;
}

export interface DraftTrialSegment {
  text: string; inferredAction: string; status: 'matched' | 'clarify' | 'no_match';
  selectedId: string; reason: string; clarification: string; candidates: DraftTrialCandidate[];
}

export interface DraftTrialResult {
  query: string; shape: 'single_intent' | 'multi_intent' | 'multi_task_same_intent';
  status: 'matched' | 'clarify' | 'no_match';
  segments: DraftTrialSegment[]; intentCount: number; engine: 'draft_hybrid';
  policy: DraftTrialPolicy; stages: { local: string; semantic: string; model: string };
  model: string; reason: string;
}

export interface DraftTrialCapabilities {
  embedding: boolean; models: string[]; defaultPolicy: DraftTrialPolicy; source: 'current_draft';
}

export function getDraftTrialCapabilities(): Promise<DraftTrialCapabilities> {
  return get<DraftTrialCapabilities>('/trial/capabilities?asset=intent-graph');
}

export function trialIntentGraph(document: GraphDocument, query: string, policy: DraftTrialPolicy,
  contextQuery?: string, choiceId?: string, choiceSegment?: number): Promise<DraftTrialResult> {
  return post<DraftTrialResult>('/trial', { asset: 'intent-graph', document, query, policy, contextQuery, choiceId, choiceSegment });
}

// ── 试问修正（方案 A + B） ──

/** 方案 A：将用户试问表达加入意图节点的 utterance_view */
export interface AddUtteranceResult {
  document: GraphDocument;
  nodeId: string;
  utterance: string;
  added: boolean;
  total: number;
}

export function addUtterance(document: GraphDocument, nodeId: string, utterance: string): Promise<AddUtteranceResult> {
  return post<AddUtteranceResult>('/trial/add-utterance', { asset: 'intent-graph', document, nodeId, utterance });
}

/** 方案 B：AI 辅助修正——分析召回问题并建议修改方案 */
export interface FixSuggestion {
  type: 'add_utterance' | 'rename_intent' | 'change_action' | 'change_object';
  nodeId: string;
  label: string;
  detail: string;
  value: string;
}

export interface SuggestFixResult {
  analysis: string;
  suggestions: FixSuggestion[];
  fallback?: boolean;
}

export function suggestFix(
  document: GraphDocument,
  query: string,
  correction: string,
  candidates: DraftTrialCandidate[],
  targetNodeId?: string,
): Promise<SuggestFixResult> {
  return post<SuggestFixResult>('/trial/suggest-fix', { asset: 'intent-graph', document, query, correction, candidates, targetNodeId });
}

/** 质量校验：确定性规则检查 + LLM 语义审查（LLM 失败仍返回规则结果） */
export function auditGraph(asset: string, document: GraphDocument): Promise<AuditResult> {
  return post<AuditResult>('/audit', { asset, document }, LLM_TIMEOUT_MS);
}

// ── 逐节点/逐边 AI 字段审核（graph-builder-tools /node-review，响应不包裹 {success, data}） ──

/** 单条字段审核建议（与知识导入 runNodeReview 的 AssistItem 形状一致） */
export interface NodeReviewItem {
  id: string;
  kind: 'node-review';
  payload: {
    field: string;
    fieldLabel: string;
    issueType: 'missing' | 'incomplete' | 'inaccurate' | 'inconsistent' | 'style';
    issue: string;
    suggestion: string;
    /** 可直接采纳的完整新值（空字符串表示仅提示问题无修改值） */
    newValue: string;
    severity: 'error' | 'warning' | 'info';
  };
  status: 'suggested' | 'accepted' | 'rejected' | 'ignored';
}

const TOOLS_BASE = '/api/graph-builder/tools';

/**
 * 逐节点/逐边 AI 字段审核：提交选中元素的 JSON，后端按模板字段逐项 LLM 审核。
 * 走 vite proxy：/api/graph-builder/tools/node-review → /api/graph-builder/tools/node-review。
 */
export async function nodeReview(
  element: { kind: 'node' | 'edge'; id: string; data: Record<string, unknown>; source?: string; target?: string },
  assetId?: string,
  groupKey?: string,
  fieldKeys?: string[],
): Promise<{ items: NodeReviewItem[]; generatedAt: string }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(`${TOOLS_BASE}/node-review`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ element, assetId: assetId || 'intent-graph', groupKey, fieldKeys }),
      cache: 'no-store',
    });
  } catch {
    throw new Error('网络连接失败，请检查图谱工具服务是否可用');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    throw new Error(json.error || `HTTP ${res.status}`);
  }
  return json as { items: NodeReviewItem[]; generatedAt: string };
}

/** 文档抽取（长文分块 → LLM 抽取实体/关系；jobId 断点续跑：已完成文档从 extract-cache 恢复不重复调用 LLM） */
export function extractGraph(asset: string, content: string, fileName?: string, maxChunks?: number, options?: ExtractOptions): Promise<ExtractResult> {
  // 块数未指定时按文档大小自动放大（4000 字/块 + 200 重叠），避免长文档被服务端默认 10 块静默截尾
  const blocks = maxChunks ?? Math.min(80, Math.max(10, Math.ceil(content.length / 3800) + 1));
  const jobId = options?.jobId || `ej-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const onProgress = options?.onProgress;
  let timer: ReturnType<typeof setInterval> | null = null;
  if (onProgress) {
    timer = setInterval(() => {
      get<{ jobId: string; completed: number; total: number; phase?: string; gleanTotal?: number }>(`/extract-progress?jobId=${encodeURIComponent(jobId)}`)
        .then((p) => { if (p && p.total > 0) onProgress(p.completed, p.total, p.phase, p.gleanTotal); })
        .catch(() => { /* 轮询失败不干扰主请求 */ });
    }, 1500);
  }
  return post<ExtractResult>('/extract', { asset, content, fileName: fileName || '未命名文档', maxChunks: blocks, jobId }, LLM_TIMEOUT_MS)
    .finally(() => { if (timer) clearInterval(timer); });
}

/** 确定性实体消解：同名（归一化后）同类型节点合并，边重定向 + 去自环 + 去重边，零 LLM */
export interface ResolveEntitiesResult {
  document: GraphDocument;
  merges: { keptId: string; keptName: string; droppedId: string; droppedName: string; type: string }[];
  stats: { groups: number; mergedNodes: number; movedEdges: number; droppedEdges: number };
}

export function resolveEntities(asset: string, document: GraphDocument): Promise<ResolveEntitiesResult> {
  return post<ResolveEntitiesResult>('/resolve-entities', { asset, document });
}

/** 服务端文档解析：docx/pdf/xlsx 走 base64 二进制；txt/md/csv 前端已读文本走 content */
export interface ParsedDocument {
  fileName: string;
  format: string;
  totalLength: number;
  truncated: boolean;
  maxChars: number;
  /** xlsx 才有：每个 sheet 的表头与行数据（行数据上限 2000 行，dataTruncated 标记截断） */
  sheets: { name: string; headers: string[]; rows: number; data?: string[][]; dataTruncated?: boolean }[] | null;
  text: string;
  preview: string;
}

export function parseDocument(fileName: string, payload: { base64?: string; content?: string }): Promise<ParsedDocument> {
  return post<ParsedDocument>('/parse-document', { fileName, ...payload }, 300_000);
}

// ── 文档分诊（上传后先体检：画像/结构匹配/相关性/成本预估，确认后才进全量抽取） ──

export interface DocumentProfile {
  chars: number;
  lines: number;
  emptyLineRatio: number;
  garbledRatio: number;
  tableLikeRatio: number;
}

export interface SheetStructureMatch {
  name: string;
  headers: string[];
  rows: number;
  match: { score: number; matchedCount: number; headerCount: number; matched: { header: string; field: string; nodeType: string }[] } | null;
}

export interface TriageResult {
  profile: DocumentProfile;
  structure: SheetStructureMatch[] | null;
  relevance: { relevant: boolean | null; confidence: number | null; reasons: string; contentTypes: string };
  plan: { blocks: number; llmCalls: number; estSeconds: number };
  recommendation: { mode: 'extract' | 'suggest_tabular' | 'low_relevance' | 'reject'; reasons: string[] };
}

/** 文档体检：画像与结构匹配零成本，相关性评估为单次 LLM 调用（服务端 fail-open） */
export function documentTriage(asset: string, text: string, sheets?: { name: string; headers: string[]; rows: number }[] | null): Promise<TriageResult> {
  return post<TriageResult>('/document-triage', { asset, text, sheets: sheets || undefined }, 300_000);
}

// ── 确定性质检报告 + 原文取证填充（tools/graph-quality-tools.js） ──

export interface QualityDimension {
  key: string;
  label: string;
  score: number;
  weight: number;
  items: { severity: string; message: string }[];
}

export interface QualityReport {
  summary: {
    score: number;
    grade: string;
    nodeCount: number;
    edgeCount: number;
    errorCount: number;
    findingCount: number;
    placeholderCount: number;
  };
  dimensions: QualityDimension[];
  coverage: {
    nodeTypes: { type: string; label: string; count: number }[];
    edgeTypes: { type: string; label: string; count: number }[];
    missingNodeTypes: string[];
    missingEdgeTypes: string[];
  };
  placeholders: { nodeId: string; nodeType: string; field: string; fieldLabel: string; current: string }[];
}

/** 确定性质检报告（不发 LLM）：schema 合规 + 模板覆盖 + 内容质量 */
export function qualityReport(asset: string, document: GraphDocument): Promise<QualityReport> {
  return post<QualityReport>('/quality-report', { asset, document });
}

export interface FillApplied {
  nodeId: string;
  nodeType: string;
  nodeLabel: string;
  field: string;
  before: string;
  value: unknown;
  evidence: string;
}

export interface FillGapsResult {
  document: GraphDocument;
  fills: FillApplied[];
  rejected: { nodeId: string; field: string; reason: string }[];
  /** 非阻断警告（如节点类型不在模板中无法识别缺口） */
  warnings?: string[];
  stats: { gaps: number; filled: number; rejected: number };
}

/** 原文取证填充：占位/空必填字段由 LLM 从 sourceText 取证补全（无依据不编造） */
export function fillGaps(asset: string, document: GraphDocument, sourceText: string): Promise<FillGapsResult> {
  return post<FillGapsResult>('/fill-gaps', { asset, document, sourceText }, LLM_TIMEOUT_MS);
}

/** 表格数据确定性建图（CSV/JSON + 列映射，无 LLM） */
export function buildFromTabular(
  asset: string,
  payload: { format: 'csv' | 'json'; content: string; nodeMappings: TabularNodeMapping[]; edgeMappings?: TabularEdgeMapping[] },
): Promise<{
  document: GraphDocument;
  stats: { nodeCount: number; edgeCount: number; skippedNodes: number; skippedEdges: number; errors: { code: string; message: string }[] };
  validation: { asset: ValidationReport; template: ValidationReport };
}> {
  return post('/from-tabular', { asset, ...payload });
}

/** 数据桥：外部数据源导入（如 v2.1 意图图谱 → org 资产；转换 → 双关校验 → 默认落草稿） */
export function importGraphFromSource(
  asset: string,
  source: { kind: string; path?: string; label?: string },
  options?: { saveAsDraft?: boolean; autoPublish?: boolean; note?: string },
): Promise<{
  document: GraphDocument;
  stats: { nodes: number; edges: number };
  validation: { asset: ValidationReport; template: ValidationReport };
  report: { skippedEdges: { edge_id: string; reason: string }[]; droppedEdgesByReason: Record<string, number> };
  saved: boolean;
  published?: { version: string };
}> {
  return post('/import', { asset, source, options }, LLM_TIMEOUT_MS);
}

/** 数据桥：org 资产 → v2.1 候选批次回写（闭环反向桥，不自动切 active） */
export function exportGraphToSource(
  asset: string,
  document: GraphDocument,
  phase?: '1' | '2',
): Promise<{
  exported: boolean;
  file: string;
  stats: { aggregate_intents: number; intent_nodes: number; supporting_nodes: number; edges: number };
}> {
  return post('/export', { asset, document, phase });
}

// ── 图谱 ↔ 知识导入 Excel 双向转换 ──

/** 图谱 → 知识导入一体化填写 Excel（下载 xlsx） */
export async function graphToIntakeExcel(document: GraphDocument): Promise<{ blob: Blob; fileName: string }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}/graph-to-intake-excel`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ document }),
    cache: 'no-store',
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new OrgGraphApiError(j?.error?.message || j?.message || `HTTP ${res.status}`, j?.error?.code || 'ORG_GRAPH_ERROR', res.status);
  }
  const cd = res.headers.get('Content-Disposition') || '';
  const m = cd.match(/filename\*?=UTF-8''(.+)/) || cd.match(/filename="?(.+?)"?$/);
  const fileName = m ? decodeURIComponent(m[1]) : 'intake-excel.xlsx';
  const blob = await res.blob();
  return { blob, fileName };
}

/** 知识导入 Excel → 图谱 JSON */
export function intakeExcelToGraph(base64: string): Promise<{
  document: GraphDocument;
  stats: { nodeCount: number; edgeCount: number; functionCount: number; intentCount: number };
}> {
  return post('/intake-excel-to-graph', { base64 });
}

/** 下载资产的草稿 Excel（saveDraft 时自动生成） */
export async function downloadDraftExcel(asset: string): Promise<{ blob: Blob; fileName: string }> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}/draft-excel?asset=${encodeURIComponent(asset)}`, {
    method: 'GET',
    headers,
    cache: 'no-store',
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new OrgGraphApiError(j?.error?.message || j?.message || `HTTP ${res.status}`, j?.error?.code || 'ORG_GRAPH_ERROR', res.status);
  }
  const cd = res.headers.get('Content-Disposition') || '';
  const m = cd.match(/filename\*?=UTF-8''(.+)/) || cd.match(/filename="?(.+?)"?$/);
  const fileName = m ? decodeURIComponent(m[1]) : `${asset}-draft-excel.xlsx`;
  const blob = await res.blob();
  return { blob, fileName };
}

// ── 资产管理端点（图谱管理页） ──

/** 注册资产：上传模板 JSON 或从现有资产复制模板 */
export function registerAsset(payload: {
  assetId: string;
  name?: string;
  description?: string;
  template?: GraphTemplate;
  copyFrom?: string;
}): Promise<{ assetId: string; name: string; created: boolean }> {
  return post('/assets', payload);
}

/** 更新资产元数据（内置资产写入覆盖元数据） */
export function updateAsset(assetId: string, meta: { name?: string; description?: string }): Promise<{ assetId: string; updated: boolean }> {
  return patch(`/assets/${encodeURIComponent(assetId)}`, meta);
}

/** 删除自建资产（内置资产后端拒绝） */
export function deleteAsset(assetId: string): Promise<{ assetId: string; deleted: boolean }> {
  return del(`/assets/${encodeURIComponent(assetId)}`);
}

/** 回滚：切换 active 版本指针（manifest 记录回滚事件，历史不重写） */
export function setActiveVersion(assetId: string, version: string): Promise<{ assetId: string; activeVersion: string; previous: string | null }> {
  return put(`/assets/${encodeURIComponent(assetId)}/active`, { version });
}

/** 放弃草稿（未发布内容不可恢复） */
export function discardDraft(assetId: string): Promise<{ assetId: string; discarded: boolean; hadDraft: boolean }> {
  return del(`/assets/${encodeURIComponent(assetId)}/draft`);
}

/** 删除历史版本（active 版本后端拒绝） */
export function deleteVersion(assetId: string, version: string): Promise<{ assetId: string; version: string; deleted: boolean; remaining: number }> {
  return del(`/assets/${encodeURIComponent(assetId)}/versions/${encodeURIComponent(version)}`);
}

// ── 评测迭代 Agent（多轮对话）──

/** Agent 响应不包裹 {success, data}，用独立 fetch */
async function agentRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload: string | undefined;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(`${BASE}/trial-agent${path}`, { method, headers, body: payload, cache: 'no-store' });
  } catch {
    throw new Error('Agent 服务连接失败，请检查 intent-trial-agent 是否运行');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = json.detail?.message || json.detail || json.message || `HTTP ${res.status}`;
    throw new Error(message);
  }
  return json as T;
}

export interface TrialAgentHealth {
  provider: string;
  version: string;
  agentId: string;
  ready: boolean;
  modelConfigured: boolean;
  modelProvider: string | null;
  modelName: string | null;
}

export interface TrialAgentSession {
  sessionId: string;
  document: GraphDocument;
  policy: DraftTrialPolicy | null;
}

export interface TrialAgentInvokeResult {
  sessionId: string;
  reply: string;
  status: 'ok' | 'error';
}

/** 检查 Agent 服务状态 */
export function checkTrialAgentHealth(): Promise<TrialAgentHealth> {
  return agentRequest<TrialAgentHealth>('GET', '/health');
}

/** 创建会话 */
export function createTrialAgentSession(document: GraphDocument, policy?: DraftTrialPolicy): Promise<TrialAgentSession> {
  return agentRequest<TrialAgentSession>('POST', '/v1/sessions', { document, policy });
}

/** 多轮对话调用 */
export function invokeTrialAgent(sessionId: string, message: string, document?: GraphDocument, policy?: DraftTrialPolicy): Promise<TrialAgentInvokeResult> {
  return agentRequest<TrialAgentInvokeResult>('POST', `/v1/sessions/${sessionId}/invoke`, { message, document, policy });
}

/** 释放会话 */
export function releaseTrialAgentSession(sessionId: string): Promise<{ sessionId: string; released: boolean }> {
  return agentRequest<{ sessionId: string; released: boolean }>('DELETE', `/v1/sessions/${sessionId}`);
}

// ── 图谱构建 Agent（openjiuwen 多轮对话）──

/** Builder Agent 响应不包裹 {success, data}，用独立 fetch；timeoutMs 防挂死（invoke 长任务放宽） */
async function builderAgentRequest<T>(method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload: string | undefined;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${BASE}/builder-agent${path}`, { method, headers, body: payload, cache: 'no-store', signal: controller.signal });
  } catch {
    if (controller.signal.aborted) throw new Error('Agent 请求超时，请稍后重试');
    throw new Error('Agent 服务连接失败，请检查 graph-builder-agent 是否运行');
  } finally {
    clearTimeout(timer);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = json.detail?.message || json.detail || json.message || `HTTP ${res.status}`;
    throw new Error(message);
  }
  return json as T;
}

export interface BuilderAgentHealth {
  provider: string;
  version: string;
  agentId: string;
  ready: boolean;
  modelConfigured: boolean;
  modelProvider: string | null;
  modelName: string | null;
}

export interface BuilderAgentSession {
  sessionId: string;
  asset: string;
  document: GraphDocument | null;
}

/** Agent skill 包内单个能力的展示元数据（/v1/skills） */
export interface BuilderAgentSkill {
  name: string;
  label: string;
  trigger: string;
  description: string;
}

export interface BuilderAgentSkillsResult {
  skill: string | null;
  source?: string;
  skills: BuilderAgentSkill[];
}

export interface BuilderAgentInvokeResult {
  sessionId: string;
  reply: string;
  status: 'ok' | 'error';
  /** Agent 返回的结构化图谱文档（complement_graph 工具生成） */
  document?: GraphDocument;
  /** document 的写入语义：incremental=修改片段（须并入已有结果区）；create=完整文档（可覆盖） */
  mode?: 'create' | 'incremental';
  /** Agent 返回的审核发现（complement_graph 工具生成） */
  audit?: unknown;
  /** Agent 返回的修正建议（iterate_intent 工具生成） */
  suggestions?: unknown;
  /** Agent 返回的试问结果（iterate_intent 工具生成） */
  trial?: unknown;
  /** Agent 返回的摘要信息 */
  summary?: string;
}

/** 检查 Builder Agent 服务状态 */
export function checkBuilderAgentHealth(): Promise<BuilderAgentHealth> {
  return builderAgentRequest<BuilderAgentHealth>('GET', '/health');
}

/** 获取 Agent 已加载的技能清单（供技能面板展示与 @ 点选） */
export function listBuilderAgentSkills(): Promise<BuilderAgentSkillsResult> {
  return builderAgentRequest<BuilderAgentSkillsResult>('GET', '/v1/skills');
}

/** 创建 Builder Agent 会话 */
export function createBuilderAgentSession(asset: string, document?: GraphDocument): Promise<BuilderAgentSession> {
  return builderAgentRequest<BuilderAgentSession>('POST', '/v1/sessions', { asset, document: document ?? null });
}

/** Builder Agent 多轮对话调用（skill=@ 显式指定的技能名，本轮强制路由；sourceText=材料库取证文本，fill_gaps 缺省取用） */
export function invokeBuilderAgent(sessionId: string, message: string, asset?: string, document?: GraphDocument, skill?: string, sourceText?: string): Promise<BuilderAgentInvokeResult> {
  return builderAgentRequest<BuilderAgentInvokeResult>('POST', `/v1/sessions/${sessionId}/invoke`, { message, asset, document, skill: skill || null, source_text: sourceText || null }, 330_000);
}

/** 释放 Builder Agent 会话 */
export function releaseBuilderAgentSession(sessionId: string): Promise<{ sessionId: string; released: boolean }> {
  return builderAgentRequest<{ sessionId: string; released: boolean }>('DELETE', `/v1/sessions/${sessionId}`);
}

// ── SSE 流式审核 ──

export interface AuditStreamEvent {
  type: 'progress' | 'findings' | 'merged' | 'done' | 'warning' | 'error';
  current?: number;
  total?: number;
  step?: string;
  batch?: number;
  deterministic?: AuditFinding[];
  semantic?: AuditFinding[];
  message?: string;
  summary?: {
    nodes: number;
    edges: number;
    deterministic: number;
    semantic: number;
    batches: number;
    coverage: string;
  };
}

export interface AuditStreamCallbacks {
  onProgress?: (current: number, total: number, step: string) => void;
  onFindings?: (deterministic: AuditFinding[], semantic: AuditFinding[], batch: number) => void;
  onMerged?: (deterministic: AuditFinding[], semantic: AuditFinding[]) => void;
  onDone?: (summary: AuditStreamEvent['summary']) => void;
  onWarning?: (message: string) => void;
  onError?: (message: string) => void;
}

/**
 * SSE 流式审核：通过 fetch + ReadableStream 接收逐批审核结果。
 * 不走 Agent LLM，直接调后端 audit API 分批并行审核。
 */
export async function streamAuditGraph(
  sessionId: string,
  asset: string,
  document: GraphDocument,
  callbacks: AuditStreamCallbacks,
): Promise<void> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  let res: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 300_000);
    res = await fetch(`${BASE}/builder-agent/v1/sessions/${sessionId}/audit-stream`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ asset, document }),
      cache: 'no-store',
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new Error('审核超时（300 秒），请缩小图谱规模后重试');
    }
    throw new Error('Agent 服务连接失败，请检查 graph-builder-agent 是否运行');
  }

  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    const msg = json.detail?.message || json.detail || json.message || `HTTP ${res.status}`;
    throw new Error(msg);
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (!data) continue;
        let event: AuditStreamEvent;
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }
        switch (event.type) {
          case 'progress':
            callbacks.onProgress?.(event.current || 0, event.total || 0, event.step || '');
            break;
          case 'findings':
            callbacks.onFindings?.(event.deterministic || [], event.semantic || [], event.batch || 0);
            break;
          case 'merged':
            callbacks.onMerged?.(event.deterministic || [], event.semantic || []);
            break;
          case 'done':
            callbacks.onDone?.(event.summary);
            break;
          case 'warning':
            callbacks.onWarning?.(event.message || '');
            break;
          case 'error':
            callbacks.onError?.(event.message || '审核失败');
            break;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
