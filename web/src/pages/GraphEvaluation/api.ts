/**
 * 图谱知识评测 API：复用意图评测引擎（同源 /api 前缀，由反向代理转发到评测服务）。
 * 走 fetch 而非 axios client（与 orgGraph.ts 同模式），引擎单次评测可达 1 分钟以上，不设前端超时。
 */

const BASE = "/api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const json = await res.json().catch(() => ({} as Record<string, unknown>));
  if (!res.ok || (json && (json as Record<string, unknown>).error)) {
    const err = (json as Record<string, unknown>)?.error;
    throw new Error(typeof err === "string" ? err : `请求失败(${res.status})`);
  }
  return json as T;
}

export interface IntentEngineStatus {
  engine?: string;
  evaluator_version_id?: string;
  evaluator_version?: string;
  evaluator_version_name?: string;
  graph_version_id?: string;
  graph_version?: string;
  graph_version_name?: string;
  graph_release_status?: string;
  intent_count?: number;
  executable_intent_count?: number;
  knowledge_intent_count?: number;
  aggregate_intent_count?: number;
  edge_count?: number;
  faq_count?: number;
  embedding_cache_count?: number;
  llm_cache_count?: number;
  embedding_model?: string;
  llm_model?: string;
}

export interface TraceStep {
  step?: string;
  title?: string;
  conclusion?: string;
  latency_ms?: number;
  timing_ms?: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  selected?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  before?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  after?: any;
}

export interface IntentEvalResponse {
  query?: string;
  result_type?: string;
  latency_ms?: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  final_result?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  authoritative_results?: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  answers?: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  understanding?: any;
  methods?: {
    local?: any;
    embedding?: any;
    llm_judge?: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    bank?: any;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  attribution?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  final_results?: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  segment_results?: any[];
  error?: string;
}

export interface MultiTurnResponse {
  success?: boolean;
  session_id?: string;
  query?: string;
  turn?: { index?: number; type?: string; reason?: string; latency_ms?: number };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  state_after?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  turn_intents?: any[];
  trace?: TraceStep[];
  single_turn_result?: IntentEvalResponse;
  latency_ms?: number;
  error?: string;
}

export interface TestCase {
  id: number;
  query: string;
  result_type: string;
  final_intent: string;
  action_code: string;
  business_object: string;
  latency_ms: number;
  eval_mode: string;
  session_id: string;
  turn_index: number;
  tags: string;
  source: string;
  failure_category?: string;
  failure_owner?: string;
  failure_reason?: string;
  fix_recommendation?: string;
  created_at?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  full_response?: any;
}

export interface TestCaseListResult {
  data: TestCase[];
  limit: number;
  offset: number;
}

export interface TestCaseStats {
  total: number;
  distinct_final_intents: number;
  by_result_type: { result_type: string; count: number }[];
  by_final_intent: { final_intent: string; count: number }[];
  by_eval_mode: { eval_mode: string; count: number }[];
  by_source: { source: string; count: number }[];
  by_failure_category: { failure_category: string; count: number }[];
  by_failure_owner: { failure_owner: string; count: number }[];
  attributed_total: number;
  latency: { avg: number; max: number; min: number };
}

export interface TestCaseFilters {
  result_type?: string;
  final_intent?: string;
  eval_mode?: string;
  session_id?: string;
  source?: string;
  failure_category?: string;
  failure_owner?: string;
  keyword?: string;
}

function toQuery(params: object): string {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== "") search.set(k, String(v));
  });
  const s = search.toString();
  return s ? `?${s}` : "";
}

export interface EvaluationGraph {
  id: string;
  engine: "bank" | "v2";
  label: string;
  sublabel?: string;
  intent_count?: number | null;
  node_count?: number;
  edge_count?: number;
  version?: string;
  stage?: string;
  engine_version?: string;
  active?: boolean;
  default?: boolean;
}

export interface EvaluationGraphList {
  graphs: EvaluationGraph[];
  default_graph: string;
}

export function listGraphs(): Promise<EvaluationGraphList> {
  return request<EvaluationGraphList>("/intent-evaluate/graphs");
}

export function getEngineStatus(graphId?: string): Promise<IntentEngineStatus> {
  return request<IntentEngineStatus>(`/intent-evaluate/status${toQuery({ graph: graphId })}`);
}

export function evaluateIntent(query: string, graphId?: string): Promise<IntentEvalResponse> {
  return request<IntentEvalResponse>("/intent-evaluate", {
    method: "POST",
    body: JSON.stringify({ query, options: { topk: 8, graph: graphId || undefined } }),
  });
}

export function evaluateMultiTurn(
  query: string,
  sessionId: string,
  graphId?: string,
): Promise<MultiTurnResponse> {
  return request<MultiTurnResponse>("/intent-evaluate-multiturn", {
    method: "POST",
    body: JSON.stringify({
      query,
      session_id: sessionId || undefined,
      options: { topk: 8, graph: graphId || undefined },
    }),
  });
}

export function resetMultiTurnSession(sessionId: string, graphId?: string): Promise<MultiTurnResponse> {
  return request<MultiTurnResponse>("/intent-evaluate-multiturn/reset", {
    method: "POST",
    body: JSON.stringify({ session_id: sessionId, options: { graph: graphId || undefined } }),
  });
}

export function submitMultiTurnClarify(
  sessionId: string,
  values: Record<string, string | number>,
  graphId?: string,
): Promise<MultiTurnResponse> {
  return request<MultiTurnResponse>("/intent-evaluate-multiturn/clarify", {
    method: "POST",
    body: JSON.stringify({
      session_id: sessionId,
      values,
      options: { graph: graphId || undefined },
    }),
  });
}

export function listTestCases(
  limit: number,
  offset: number,
  filters: TestCaseFilters = {},
): Promise<TestCaseListResult> {
  return request<TestCaseListResult>(`/test-cases${toQuery({ limit, offset, ...filters })}`);
}

export function getTestCaseStats(): Promise<TestCaseStats> {
  return request<TestCaseStats>("/test-cases/stats");
}

export function getTestCase(id: number): Promise<TestCase> {
  return request<TestCase>(`/test-cases/${id}`);
}

export interface AttributionPatch {
  failure_category?: string;
  failure_owner?: string;
  failure_reason?: string;
  fix_recommendation?: string;
}

export function updateTestCaseAttribution(
  id: number,
  payload: AttributionPatch,
): Promise<{ success: boolean; attribution: AttributionPatch }> {
  return request(`/test-cases/${id}/attribution`, { method: "POST", body: JSON.stringify(payload) });
}

export interface CreateTestCasePayload {
  query: string;
  result_type: string;
  final_intent: string;
  action_code: string;
  business_object: string;
  latency_ms?: number;
  eval_mode?: string;
  session_id?: string;
  turn_index?: number;
  tags?: string;
  source: "auto" | "manual" | "batch_import";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  full_response?: any;
}

export function createTestCase(
  payload: CreateTestCasePayload,
): Promise<{ success: boolean; id: number | null; attribution?: { failure_category?: string; failure_owner?: string; failure_reason?: string; fix_recommendation?: string } }> {
  return request("/test-cases", { method: "POST", body: JSON.stringify(payload) });
}

export interface BatchImportResult {
  success: boolean;
  total: number;
  inserted: number;
  failed: number;
  failures?: { index: number; reason: string }[];
}

export function batchImportTestCases(items: unknown[]): Promise<BatchImportResult> {
  return request("/test-cases/batch-import", { method: "POST", body: JSON.stringify({ items }) });
}

export function deleteTestCase(id: number): Promise<{ success: boolean }> {
  return request(`/test-cases/${id}`, { method: "DELETE" });
}

export function exportTestCases(filters: TestCaseFilters = {}): Promise<TestCaseListResult & { count: number }> {
  return request(`/test-cases/export${toQuery(filters)}`);
}

export function clearTestCases(sessionId?: string): Promise<{ success: boolean }> {
  return request(`/test-cases/clear${toQuery({ session_id: sessionId })}`, { method: "DELETE" });
}

// ── 意图测试集生成（评测工具前置：图谱采样 → openjiuwen 合成 → 用例库） ──

export interface TestSetPlanOptions {
  singleCount: number;
  multiCount: number;
  ambiguousCount: number;
  ambiguousMix: Record<string, boolean>;
  domains: string[];
  perTargetCount: number;
  styles: string[];
  seed?: string;
  /** 难度权重（仅单意图表面形分轴）：提供后按难度风格包轮替，替代合成风格轴 */
  difficultyMix?: Record<string, number>;
  /** 多意图子类配额覆盖；缺省子类回落固定比例 */
  multiQuota?: Record<string, number>;
  /** 同对象意图对优先（近义易混对） */
  confusableBias?: boolean;
}

export interface TestSetScaffoldResult {
  planId: string;
  graph: { version?: string; versionName?: string; releaseStatus?: string; path?: string };
  stats: { intentCount?: number; executableIntentCount?: number; knowledgeIntentCount?: number; domainCount?: number };
  domains: string[];
  styleOptions: { value: string; label: string }[];
  planSummary: {
    totalTargets: number;
    byCategory: Record<string, number>;
    ambiguousBySubcategory: Record<string, number>;
    multiBySubcategory: Record<string, number>;
    byDifficulty?: Record<string, number> | null;
    expectedCases: number;
  };
  targetsPreview: { targetId: string; category: string; subcategory: string; intents: string[]; count: number; styles: string[] }[];
  targetsTruncated: boolean;
}

export interface GeneratedTestSetCase {
  caseId: string;
  category: string;
  subcategory: string;
  query: string;
  style: string;
  difficulty?: string;
  /** no_lexical_ground：问法与期望意图已知说法零词汇交集，疑似幻觉表面形，建议人工复核 */
  suspect?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expected: any;
  derivation: { sourceIntentIds?: string[]; graphVersion?: string; targetId?: string };
}

export interface TestSetGenerateResult {
  datasetId: string;
  planId: string;
  graph: Record<string, unknown>;
  summary: {
    total: number;
    byCategory: Record<string, { count: number; samples: { query: string; expected: string }[] }>;
    failedCount: number;
  };
  cases: GeneratedTestSetCase[];
  failed: { targetId: string; kind: string; reason: string }[];
  batchErrors: string[];
  fallbackUsed?: boolean;
  totalTargets?: number;
  pendingTargets?: number;
  resumedTargets?: number;
  testRows: CreateTestCasePayload[];
}

export function scaffoldTestSet(options: TestSetPlanOptions): Promise<TestSetScaffoldResult> {
  return request<TestSetScaffoldResult>("/intent-testset/scaffold", {
    method: "POST",
    body: JSON.stringify({ options }),
  });
}

export function generateTestSet(planId: string, fallbackToSeed = true): Promise<TestSetGenerateResult> {
  return request<TestSetGenerateResult>("/intent-testset/generate", {
    method: "POST",
    body: JSON.stringify({ planId, fallbackToSeed }),
  });
}

/** 异步生成 job：立即返回，之后轮询 getTestSetJob；完成取 datasetId 再 loadTestSetDataset。 */
export interface TestSetJobStatus {
  jobId: string;
  planId: string;
  status: "running" | "completed" | "failed";
  done: number;
  total: number;
  datasetId?: string;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}

export function startGenerateTestSet(planId: string, fallbackToSeed = true): Promise<TestSetJobStatus> {
  return request<TestSetJobStatus>("/intent-testset/generate", {
    method: "POST",
    body: JSON.stringify({ planId, fallbackToSeed, mode: "async" }),
  });
}

export function getTestSetJob(jobId: string): Promise<TestSetJobStatus> {
  return request<TestSetJobStatus>(`/intent-testset/generate/jobs/${jobId}`);
}

export function loadTestSetDataset(datasetId: string): Promise<TestSetGenerateResult> {
  return request<TestSetGenerateResult>(`/intent-testset/dataset/${datasetId}`);
}

export function seedFallbackTestSet(planId: string): Promise<TestSetGenerateResult> {
  return request<TestSetGenerateResult>("/intent-testset/seed-fallback", {
    method: "POST",
    body: JSON.stringify({ planId }),
  });
}

// ── 跑批评测（测试任务实例：测试集 × 图谱 → 报告） ──

export interface TestRunListItem {
  runId: string;
  name: string;
  datasetId: string;
  planId?: string;
  graphId: string;
  engine: "bank" | "v2";
  graphLabel: string;
  status: "running" | "done" | "failed" | "interrupted";
  total: number;
  done: number;
  summary: {
    total: number;
    done: number;
    passed: number;
    relaxedPassed?: number;
    byCategory: Record<string, { total: number; passed: number }>;
    byFailureCategory?: Record<string, number>;
    bySubcategory?: Record<string, { total: number; passed: number }>;
    avgLatencyMs: number;
    p50LatencyMs?: number;
    p90LatencyMs?: number;
    degradedCount?: number;
    totalTokensUsed?: number;
  };
  startedAt: string;
  finishedAt?: string | null;
  error?: string | null;
}

export interface TestRunResultRow {
  caseId: string;
  query: string;
  category: string;
  subcategory: string;
  expectedDisplay: string;
  actualDisplay: string;
  pass: boolean;
  relaxedPass?: boolean;
  note: string;
  failureCategory?: string;
  resultType: string;
  latencyMs: number;
  candidates?: { name: string; score: number }[];
  degraded?: boolean;
  decisionMode?: string;
  sources?: string[];
  totalTokens?: number;
  shape?: string;
  recallDetail?: {
    local: { name: string; score: number } | null;
    embedding: { name: string; score: number } | null;
    llmJudge: { name: string; score: number; reason?: string } | null;
  };
}

export interface TestRunDetail extends TestRunListItem {
  results: TestRunResultRow[];
}

export interface TestDatasetMeta {
  datasetId: string;
  planId: string;
  graph: { version?: string; versionName?: string };
  total: number;
  createdAt?: string | null;
  fallbackUsed?: boolean;
  byCategory: Record<string, number>;
}

export function listRuns(): Promise<{ runs: TestRunListItem[] }> {
  return request("/intent-testset/runs");
}

export function getRun(runId: string): Promise<TestRunDetail> {
  return request<TestRunDetail>(`/intent-testset/runs/${runId}`);
}

export function createRun(payload: { datasetId: string; graphId: string; name?: string }): Promise<{ runId: string; name: string; total: number; engine: string; graphLabel: string }> {
  return request("/intent-testset/runs", { method: "POST", body: JSON.stringify(payload) });
}

export function deleteRun(runId: string): Promise<{ success: boolean }> {
  return request(`/intent-testset/runs/${runId}`, { method: "DELETE" });
}

export function cancelRun(runId: string): Promise<{ success: boolean; status: string; done: number; total: number }> {
  return request(`/intent-testset/runs/${runId}/cancel`, { method: "POST" });
}

export function listTestsetDatasets(): Promise<{ datasets: TestDatasetMeta[]; note?: string }> {
  return request("/intent-testset/datasets");
}

export function deleteTestsetDataset(datasetId: string): Promise<{ success: boolean; datasetId: string }> {
  return request(`/intent-testset/dataset/${datasetId}`, { method: "DELETE" });
}

export interface RemediationGroup {
  intentId: string;
  intentName: string;
  queries: string[];
  caseIds: string[];
  categories: string[];
}

export interface RemediationAnalysis {
  runId: string;
  runName: string;
  baseVersionId: string;
  baseLabel: string;
  failedTotal: number;
  eligible: number;
  groups: RemediationGroup[];
  skipped: { counts: Record<string, number>; samples: { caseId: string; query: string; reason: string }[] };
  action: string;
}

export function analyzeRemediations(runId: string): Promise<RemediationAnalysis> {
  return request(`/intent-testset/runs/${runId}/remediations`, { method: "POST", body: "{}" });
}

export function applyRemediations(payload: { runId: string; caseIds?: string[] }): Promise<{
  versionId: string; graphId: string; batch: number; baseVersionId: string;
  applied: number; file: string; changes: string[]; nextStep: string;
}> {
  return request("/intent-testset/remediations/apply", { method: "POST", body: JSON.stringify(payload) });
}
