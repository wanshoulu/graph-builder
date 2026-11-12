/**
 * 知识导入与审核工作台 API 客户端
 *
 * 与 org-graph 一致：不走 axios client.ts（其 baseURL 指向 Java 后端），
 * 经 nginx 同源代理 /api/knowledge-intake/* 访问 AI Harbor。
 */
import { getToken } from '@/utils/auth';

const BASE = '/api/knowledge-intake';

// ── 类型（与 AI Harbor routes/knowledge-intake.js 响应形状一致） ──

export type IntakeRowType = 'functions' | 'intents' | 'utterances';
export type IntakeStatus = 'approved' | 'pending' | 'rejected';

export interface IntakeCounts {
  total: number;
  approved: number;
  pending: number;
  rejected: number;
}

export interface IntakeBatchSummary {
  batchId: string;
  fileName: string;
  importedBy: string;
  importedAt: string;
  /** 图谱领域（L0 根节点名，如「手机银行」）；空 = 未命名，前端回退显示 */
  domain?: string;
  counts: Record<IntakeRowType, IntakeCounts>;
  hasJournal?: boolean;
  broken?: boolean;
  message?: string;
  /** 修订（track changes）计数：total 累计、open 待审 */
  revisions?: { total: number; open: number };
}

/** 修订审阅（Word track changes 式）：一次 AI/人工动作产生的变更集 */
export interface RevisionChange {
  rowId: string;
  rowType: IntakeRowType;
  op: 'add' | 'modify';
  /** 新增说法文本 / 变更摘要 */
  label?: string;
  field?: string;
  before?: string;
  after?: string;
  resolution: 'pending' | 'accepted' | 'rejected';
  resolvedBy?: string;
  resolvedAt?: string;
  note?: string;
  /** op:'add' 附带：置信度与 AI 分诊标志 */
  confidence?: number;
  sourceStatus?: string;
  autoApproved?: boolean;
  autoRejected?: boolean;
  /** GET /revisions 附带：行当前状态；行已删除时 null 且 stale=true */
  liveStatus?: IntakeStatus | null;
  stale?: boolean;
}

export interface Revision {
  revId: string;
  type: 'utterance-expansion' | 'row-edit' | 'assist-apply';
  title: string;
  createdAt: string;
  createdBy: string;
  changes: RevisionChange[];
}

export interface RevisionListResult {
  batchId: string;
  open: number;
  revisions: Revision[];
}

export interface RevisionResolveResult {
  batchId: string;
  revId: string;
  reviewed: { approved: number; rejected: number };
  resolved: number;
  revision: Revision;
}

export interface IntakeItem {
  rowId: string;
  rowType: IntakeRowType;
  status: IntakeStatus;
  sourceStatus?: string;
  reviewNote?: string;
  reviewedBy?: string;
  reviewedAt?: string;
  autoApproved?: boolean;
  autoRejected?: boolean;
  conflict?: IntakeConflictVerdict;
  /** 功能行 */
  path?: string;
  name?: string;
  description?: string;
  domain?: string;
  menuKey?: string;
  clientClass?: string;
  securityLevel?: string;
  department?: string;
  /** 意图行 */
  ref?: string;
  funcPath?: string;
  intentType?: string;
  goal?: string;
  action?: string;
  sourceAction?: string;
  businessObjects?: string;
  businessObjectId?: string;
  keySlots?: string;
  triggerScene?: string;
  scopeIn?: string;
  scopeOut?: string;
  roles?: string;
  confusableIntents?: string;
  disambiguationHints?: string;
  answerForm?: string;
  heat?: string;
  /** 召回素材 */
  aliases?: string;
  recallTerms?: string;
  recallTermSets?: string;
  negativeExamples?: string;
  semanticPriority?: number;
  /** 执行契约 */
  executionMode?: string;
  riskLevel?: string;
  readiness?: string;
  requiredSlots?: string;
  capabilityBindings?: string;
  /** 策略配置 */
  taskPolicyShapes?: string;
  taskPolicyMode?: string;
  taskPolicyMaxTasks?: number;
  contextPolicyRetain?: string;
  contextPolicySwitch?: string;
  contextPolicyResumable?: string;
  responsePolicy?: string;
  orchestrationMode?: string;
  /** 治理信息 */
  lifecycle?: string;
  semanticVersion?: string;
  owner?: string;
  sourceChannel?: string;
  sourceMenuId?: string;
  sourceActionId?: string;
  code?: string;
  /** 说法行 */
  intentRef?: string;
  kind?: string;
  text?: string;
  source?: string;
  confidence?: number | null;
  note?: string;
}

export interface IntakeConflictVerdict {
  verdict: 'fit' | 'conflict';
  suspect: string;
  reason: string;
  checkedAt: string;
}

export interface IntakeRejection {
  sheet: string;
  rowNumber: number;
  errors: string[];
}

export interface IntakeWarning {
  sheet: string;
  rowNumber: number;
  message: string;
}

export interface ImportResult {
  batchId: string;
  fileName: string;
  importedAt: string;
  routed: Record<IntakeRowType, IntakeCounts>;
  rejected: IntakeRejection[];
  warnings: IntakeWarning[];
  /** 导出表回带的业务审核结论（待采纳标记，导入本身不改变两段式状态） */
  reviewMeta?: { marked: number; approved: number; rejected: number };
  /** 导出表「批次标识」列：回导来源批次的 id，可用于合并回去 */
  srcBatchId?: string;
}

export interface IntakeItemsResult {
  batchId: string;
  fileName: string;
  total: number;
  items: IntakeItem[];
  warnings: IntakeWarning[];
  rejected: IntakeRejection[];
}

export interface ApplyStats {
  aggregatesCreated: number;
  aggregatesReused: number;
  intentsCreated: number;
  intentsReused: number;
  utterancesAdded: number;
  edgesCreated: number;
  skipped: { kind: string; ref: string; reason: string }[];
  confusableUnresolved?: string[];
}

export interface ApplyResult {
  batchId: string;
  asset: string;
  applied: boolean;
  saved: boolean;
  stats: ApplyStats;
  validation?: {
    valid: boolean;
    asset?: { errors?: { message: string }[] };
    template?: { errors?: { message: string }[] };
  };
  hint?: string;
}

export interface ExpandResult {
  batchId: string;
  requested: number;
  added: number;
  addedByIntent: Record<string, number>;
  autoApproved?: number;
  autoRejected?: number;
  thresholds?: { autoApprove: number; autoReject: number };
  errors: { intentId: string; status: string; message?: string }[];
  /** 本次补全登记的修订（track changes），供前端直接打开审阅 */
  revision?: Revision | null;
}

export type PreviewChangeKind = 'aggregate' | 'intent' | 'utterance';
export interface PreviewChange {
  kind: PreviewChangeKind;
  action: 'create' | 'reuse' | 'add';
  name: string;
  ref?: string;
  detail?: string;
}

export interface PreviewApplyResult {
  batchId: string;
  asset: string;
  valid: boolean;
  stats: ApplyStats;
  validation?: {
    valid: boolean;
    asset?: { errors?: { message: string }[] };
    template?: { errors?: { message: string }[] };
  };
  changes: PreviewChange[];
  changesTotal: number;
  changesTruncated: boolean;
  skipped: ApplyStats['skipped'];
}

export interface RollbackResult {
  batchId: string;
  asset: string;
  rolledBack: boolean;
  saved: boolean;
  appliedAt?: string;
  removed: { aggregates: number; intents: number; edges: number; utterances: number };
  kept: string[];
  validation?: { valid: boolean };
  hint?: string;
}

export interface ConflictCheckResult {
  batchId: string;
  requested: number;
  checked: number;
  conflicts: number;
  errors: { intentId: string; status: string; message?: string }[];
}

/** 骨架树节点（业务域 → 子域 → 意图 → 说法，一体化审核树） */
export interface IntakeTreeNode {
  key: string;
  rowId: string;
  rowType: IntakeRowType;
  name: string;
  path: string;
  status: IntakeStatus;
  sourceStatus?: string;
  /** Excel 业务侧已确认（启用/生效/已审核）参考标志 —— 不等于平台确认 */
  bizConfirmed?: boolean;
  /** LLM 建议通过标志 */
  aiSuggested?: boolean;
  conflict?: 'fit' | 'conflict';
  intentType?: string;
  /** 意图节点：折叠说法计数；说法节点：本体属性 */
  utteranceCount?: number;
  kind?: string;
  source?: string;
  confidence?: number | null;
  reason?: string;
  /** 视图过滤产生的背景祖先（自身不命中该视图，但有命中后代）：置灰展示、不进逐个审核队列 */
  contextOnly?: boolean;
  children: IntakeTreeNode[];
}

export interface IntakeTreeResult {
  batchId: string;
  status: string;
  roots: IntakeTreeNode[];
  orphans: IntakeTreeNode[];
  counts: Record<IntakeRowType, IntakeCounts>;
  assist?: IntakeAssistSummary;
}

/** AI 骨架助手（三步法第 1 步）：查漏/语义去重/规范化/歧义标注 —— 全部只是建议 */
export type AssistKind = 'gaps' | 'duplicates' | 'naming' | 'ambiguities' | 'node-review';

export interface AssistItem {
  id: string;
  kind: AssistKind;
  payload: {
    type?: 'intent' | 'subdomain';
    path?: string;
    name?: string;
    description?: string;
    reason?: string;
    /** naming/duplicates/ambiguities 指向的意图标识 */
    ref?: string;
    refs?: string[];
    suggestion?: string;
    issue?: string;
    overlap?: string;
    /** node-review: 指向哪个字段 */
    field?: string;
    /** node-review: 字段中文标签 */
    fieldLabel?: string;
    /** node-review: 问题类型 missing/incomplete/inaccurate/inconsistent/style */
    issueType?: string;
    /** node-review: 严重程度 error/warning/info */
    severity?: string;
    /** node-review: 该字段修改后的完整新值，采纳后直接替换字段内容 */
    newValue?: string;
  };
  status: 'suggested' | 'accepted' | 'dismissed';
  blockReason?: string;
  decidedBy?: string;
  decidedAt?: string;
}

export interface IntakeAssistSummary {
  generatedAt: string | null;
  total: number;
  byKind: Record<AssistKind, { total: number; open: number; accepted: number; dismissed: number }>;
}

/** POST skeleton-assist 响应：服务端把 byKind 平铺成四类键（gaps/duplicates/naming/ambiguities） */
export type AssistRunResult = {
  batchId: string;
  generatedAt: string;
  total: number;
} & Record<AssistKind, { total: number; open: number; accepted: number; dismissed: number }>;

export interface AssistGetResult {
  batchId: string;
  generatedAt: string | null;
  /** 汇总（total/byKind 在 summary 下，不在顶层） */
  summary: IntakeAssistSummary;
  grouped: Record<AssistKind, { label: string; items: AssistItem[] }>;
}

export interface AssistActionResult {
  batchId: string;
  updated: number;
  blocked: number;
  results: { id: string; applied?: boolean; reason?: string; dismissed?: boolean }[];
}

/** POST node-review 响应：AI 逐字段审核当前节点，返回字段级审核意见 */
export interface NodeReviewResult {
  batchId: string;
  rowId: string;
  rowType: IntakeRowType;
  items: AssistItem[];
  generatedAt: string;
}

/** 第 1 步验收报告：覆盖度 / 边界 / 命名 / 完整性（确定性计算） */
export interface AcceptanceIssue {
  level: 'error' | 'warn' | 'info';
  unit: string;
  message: string;
}

export interface AcceptanceReport {
  batchId: string;
  generatedAt: string;
  overall: number;
  /** 各维（语义一致性未预检时不计入）全部 ≥90 才为 true（与「可提交入图」标签同口径，均分高但短板明显时为 false） */
  ready: boolean;
  weakestDimension: 'coverage' | 'boundary' | 'naming' | 'completeness' | 'consistency' | null;
  label: string;
  dimensions: Record<'coverage' | 'boundary' | 'naming' | 'completeness' | 'consistency', {
    label: string;
    /** 语义一致性没跑过冲突预检时为 null：不计入综合分与就绪判定，只提示先预检 */
    score: number | null;
    /** 仅 consistency 维携带：已预检说法数 / 判定为冲突数 */
    checked?: number;
    conflicts?: number;
    issues: AcceptanceIssue[];
  }>;
  counts: Record<IntakeRowType, IntakeCounts>;
  assist?: IntakeAssistSummary;
}

/** 在线行编辑输入（v4）：按 rowType 取子集字段；status 是业务侧状态值（启用/生效/已审核/候选/驳回…） */
export interface IntakeRowInput {
  /** 功能行 */
  path?: string;
  name?: string;
  description?: string;
  domain?: string;
  menuKey?: string;
  clientClass?: string;
  securityLevel?: string;
  department?: string;
  /** 意图行 */
  funcPath?: string;
  ref?: string;
  intentType?: string;
  goal?: string;
  action?: string;
  sourceAction?: string;
  businessObjects?: string;
  businessObjectId?: string;
  keySlots?: string;
  triggerScene?: string;
  scopeIn?: string;
  scopeOut?: string;
  roles?: string;
  confusableIntents?: string;
  disambiguationHints?: string;
  answerForm?: string;
  heat?: string;
  aliases?: string;
  recallTerms?: string;
  recallTermSets?: string;
  negativeExamples?: string;
  semanticPriority?: number;
  executionMode?: string;
  riskLevel?: string;
  readiness?: string;
  requiredSlots?: string;
  capabilityBindings?: string;
  taskPolicyShapes?: string;
  taskPolicyMode?: string;
  taskPolicyMaxTasks?: number;
  contextPolicyRetain?: string;
  contextPolicySwitch?: string;
  contextPolicyResumable?: string;
  responsePolicy?: string;
  orchestrationMode?: string;
  lifecycle?: string;
  semanticVersion?: string;
  owner?: string;
  sourceChannel?: string;
  sourceMenuId?: string;
  sourceActionId?: string;
  code?: string;
  /** 说法行 */
  intentRef?: string;
  kind?: string;
  text?: string;
  source?: string;
  confidence?: string | number | null;
  /** 公共 */
  status?: string;
  reviewNote?: string;
  note?: string;
}

export interface IntakeRowMutationResult {
  batchId: string;
  rowType: IntakeRowType;
  row: IntakeItem;
  /** 编辑前是已确认行：本次编辑使确认失效（approved → pending） */
  demoted?: boolean;
  cascaded?: Record<IntakeRowType, number>;
  warnings: string[];
}

export interface IntakeRowDeleteResult {
  batchId: string;
  deleted: Record<IntakeRowType, number>;
}

// ── 请求封装 ──

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
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
    res = await fetch(`${BASE}${path}`, { method, headers, body: payload, cache: 'no-store' });
  } catch {
    throw new Error('网络连接失败，请检查知识导入服务（knowledge-intake API）是否可用');
  }
  const json = await res.json().catch(() => ({}));
  if (!json.success) {
    const message = json.error?.message || json.message || `HTTP ${res.status}`;
    throw new Error(message);
  }
  return json.data as T;
}

async function upload<T>(path: string, file: File): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const form = new FormData();
  form.append('file', file);
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { method: 'POST', headers, body: form });
  } catch {
    throw new Error('网络连接失败，上传未送达服务端');
  }
  const json = await res.json().catch(() => ({}));
  if (!json.success) {
    const message = json.error?.message || json.message || `HTTP ${res.status}`;
    throw new Error(message);
  }
  return json.data as T;
}

// ── 召回试测（借鉴小i「业务人员即时试测+回归用例」形态，判定走意图声明语义） ──

export interface RecallMatch {
  ref: string;
  name: string;
  verdict: 'hit' | 'ambiguous';
  /** 命中证据：从该意图已有说法里原样摘抄 */
  evidence: string[];
  reason: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface RecallTestResult {
  batchId: string;
  query: string;
  matches: RecallMatch[];
  /** 实际参与试测的意图数 */
  considered: number;
  onlineCount: number;
  /** 停用/驳回（视同下线）意图数 */
  offlineCount: number;
  /** 超出候选上限被裁剪的在线意图数 */
  omitted: number;
}

export interface RecallCaseLastResult {
  ranAt: string;
  outcome: 'pass' | 'ambiguous' | 'fail' | null;
  topRef: string;
  matched: number;
}

export interface RecallCase {
  id: string;
  query: string;
  expectedRef: string;
  note: string;
  createdAt: string;
  lastResult: RecallCaseLastResult | null;
}

export interface RecallCasesResult {
  batchId: string;
  cases: RecallCase[];
  total: number;
}

export interface RecallCaseMutationResult {
  batchId: string;
  case: RecallCase;
  total: number;
}

export interface RecallRunItem {
  caseId: string;
  query: string;
  expectedRef: string;
  expectedName: string;
  matches: RecallMatch[];
  outcome: 'pass' | 'ambiguous' | 'fail' | null;
  topRef: string;
  error: string;
}

export interface RecallRunResult {
  batchId: string;
  results: RecallRunItem[];
  total: number;
  passed: number;
  ambiguous: number;
  failed: number;
  errors: number;
  onlineCount: number;
  offlineCount: number;
}

// ── 接口 ──

export const knowledgeIntakeApi = {
  importExcel: (file: File) => upload<ImportResult>('/import', file),

  listBatches: () => request<{ batches: IntakeBatchSummary[] }>('GET', '/batches'),

  getItems: (
    batchId: string,
    params: { kind?: string; status?: string; q?: string; sort?: string } = {},
  ) => {
    const search = new URLSearchParams();
    if (params.kind && params.kind !== 'all') search.set('kind', params.kind);
    if (params.status && params.status !== 'all') search.set('status', params.status);
    if (params.q) search.set('q', params.q);
    if (params.sort) search.set('sort', params.sort);
    const qs = search.toString();
    return request<IntakeItemsResult>('GET', `/batches/${batchId}/items${qs ? `?${qs}` : ''}`);
  },

  getTree: (batchId: string, status?: string) => {
    const qs = status && status !== 'all' ? `?status=${status}` : '';
    return request<IntakeTreeResult>('GET', `/batches/${batchId}/tree${qs}`);
  },

  review: (batchId: string, action: 'approve' | 'reject' | 'reset', itemIds: string[], note = '') =>
    request<{ batchId: string; updated: number; status: string }>(
      'POST',
      `/batches/${batchId}/review`,
      { action, itemIds, note },
    ),

  /** 修订（track changes）列表：倒序，change 附 liveStatus/stale */
  listRevisions: (batchId: string) =>
    request<RevisionListResult>('GET', `/batches/${batchId}/revisions`),

  /** 修订裁决：accept=采纳（行 approve 生效）、reject=放弃（行 reject 留痕） */
  resolveRevision: (
    batchId: string,
    revId: string,
    changes: { rowId: string; action: 'accept' | 'reject' }[],
    note = '',
  ) =>
    request<RevisionResolveResult>(
      'POST',
      `/batches/${batchId}/revisions/${revId}/resolve`,
      { changes, note },
    ),

  /** 采纳导出表回带的业务审核结论（显式人工动作；未标记父级按「下级全确认」保守推导） */
  applyReview: (batchId: string) =>
    request<{ batchId: string; applied: { approved: number; rejected: number }; derived: { intents: number; functions: number } }>(
      'POST',
      `/batches/${batchId}/apply-review`,
      {},
    ),

  /** 把来源批次合并回本批次：相同行去重（只搬人工结论），新增行追加，来源批次删除 */
  mergeBatch: (batchId: string, sourceId: string) =>
    request<{ batchId: string; sourceBatchId: string; added: Record<string, number>; updated: Record<string, number>; sourceDeleted: boolean }>(
      'POST',
      `/batches/${batchId}/merge`,
      { sourceId },
    ),

  expandUtterances: (batchId: string, intentItemIds: string[], count = 5) =>
    request<ExpandResult>('POST', `/batches/${batchId}/expand-utterances`, { intentItemIds, count }),

  previewApply: (batchId: string, asset = 'intent-graph', itemIds: string[] = []) =>
    request<PreviewApplyResult>('POST', `/batches/${batchId}/preview-apply`, { asset, itemIds }),

  apply: (batchId: string, asset = 'intent-graph', itemIds: string[] = []) =>
    request<ApplyResult>('POST', `/batches/${batchId}/apply`, { asset, itemIds }),

  rollback: (batchId: string, asset = 'intent-graph') =>
    request<RollbackResult>('POST', `/batches/${batchId}/rollback`, { asset }),

  checkConflicts: (batchId: string, itemIds: string[] = []) =>
    request<ConflictCheckResult>('POST', `/batches/${batchId}/check-conflicts`, { itemIds }),

  /** 召回试测：输一句问话，看会命中批次内哪些意图（LLM 依据意图声明判定） */
  recallTest: (batchId: string, query: string) =>
    request<RecallTestResult>('POST', `/batches/${batchId}/recall-test`, { query }),

  /** 试测用例集（资产级回归的雏形）：列表 */
  listRecallCases: (batchId: string) =>
    request<RecallCasesResult>('GET', `/batches/${batchId}/recall-cases`),

  /** 新增试测用例（期望意图选填；填了运行时给三态结论） */
  addRecallCase: (batchId: string, payload: { query: string; expectedRef?: string; note?: string }) =>
    request<RecallCaseMutationResult>('POST', `/batches/${batchId}/recall-cases`, payload),

  deleteRecallCase: (batchId: string, caseId: string) =>
    request<{ batchId: string; deleted: boolean; total: number }>('DELETE', `/batches/${batchId}/recall-cases/${caseId}`),

  /** 运行用例（全部或指定 ids），结果落 lastResult */
  runRecallCases: (batchId: string) =>
    request<RecallRunResult>('POST', `/batches/${batchId}/recall-cases/run`, {}),

  runSkeletonAssist: (batchId: string, product = '手机银行个人业务') =>
    request<AssistRunResult>('POST', `/batches/${batchId}/skeleton-assist`, { product }),

  getSkeletonAssist: (batchId: string) =>
    request<AssistGetResult>('GET', `/batches/${batchId}/skeleton-assist`),

  decideSkeletonAssist: (batchId: string, action: 'accept' | 'dismiss', ids: string[]) =>
    request<AssistActionResult>('POST', `/batches/${batchId}/skeleton-assist/action`, { action, ids }),

  /** 节点级字段内容审核（Word 式逐字段审核）：传入行 ID、行类型、分组 key，AI 审核该分组各字段内容质量 */
  runNodeReview: (batchId: string, rowId: string, rowType: IntakeRowType, groupKey: string) =>
    request<NodeReviewResult>('POST', `/batches/${batchId}/node-review`, { rowId, rowType, groupKey }),

  getAcceptance: (batchId: string) =>
    request<AcceptanceReport>('GET', `/batches/${batchId}/acceptance`),

  createBatch: (name = '') =>
    request<IntakeBatchSummary>('POST', '/batches', { name }),

  /** 批次元信息编辑：目前支持 L0 领域名（审核队列根节点） */
  updateBatch: (batchId: string, patch: { domain: string }) =>
    request<IntakeBatchSummary>('PATCH', `/batches/${batchId}`, patch),

  /** 导出一体化填写大表（xlsx 二进制，业务人员可直接查看审核，也可原样回导） */
  exportExcel: async (batchId: string): Promise<{ blob: Blob; fileName: string }> => {
    const headers: Record<string, string> = {};
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    let res: Response;
    try {
      res = await fetch(`${BASE}/batches/${batchId}/export`, { headers, cache: 'no-store' });
    } catch {
      throw new Error('网络连接失败，导出请求未送达服务端');
    }
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      throw new Error(json.error?.message || json.message || `HTTP ${res.status}`);
    }
    const blob = await res.blob();
    const m = /filename\*=UTF-8''([^;]+)/i.exec(res.headers.get('Content-Disposition') || '');
    return { blob, fileName: m ? decodeURIComponent(m[1]) : '一体化填写.xlsx' };
  },

  createRow: (batchId: string, rowType: IntakeRowType, row: IntakeRowInput) =>
    request<IntakeRowMutationResult>('POST', `/batches/${batchId}/rows`, { rowType, row }),

  updateRow: (batchId: string, rowId: string, row: IntakeRowInput) =>
    request<IntakeRowMutationResult>('PATCH', `/batches/${batchId}/rows/${rowId}`, { row }),

  deleteRow: (batchId: string, rowId: string) =>
    request<IntakeRowDeleteResult>('DELETE', `/batches/${batchId}/rows/${rowId}`),

  deleteBatch: (batchId: string) =>
    request<{ batchId: string; deleted: boolean }>('DELETE', `/batches/${batchId}`),
};
