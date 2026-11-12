/**
 * RSI 实验台共享层：API 封装、类型、文案映射、纯函数。
 * 独立仓的 BASE 固定为 /api；单体的 /ontomind/wiki/api 由本仓 server.js 兼容层归一化。
 */
import { Tooltip } from "antd";
import { currentTaskId, taskScopedPath } from "./rsiTaskContext";

export const BASE = "/api";

const stateCache = new Map<string, { etag: string; json: unknown }>();
const ETAG_ENDPOINTS = new Set(['/state', '/bases', '/asset-lineage', '/optimization-capabilities']);

export async function rsiRequest<T>(path: string, body?: unknown, taskId = currentTaskId()): Promise<T> {
  // Capture identity before any asynchronous work; navigation cannot retarget this request.
  const url = `${BASE}/intent-rsi${taskScopedPath(path, taskId)}`;
  const endpoint = path.split('?')[0];
  const cached = body === undefined && ETAG_ENDPOINTS.has(endpoint) ? stateCache.get(url) : undefined;
  const res = await fetch(url, {
    method: body !== undefined ? "POST" : "GET",
    headers: { "Content-Type": "application/json", ...(cached ? { "If-None-Match": cached.etag } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 304 && cached) return cached.json as T;
  const json = await res.json().catch(() => ({} as Record<string, unknown>));
  if (!res.ok || (json as Record<string, unknown>)?.ok === false) {
    const err = (json as Record<string, unknown>)?.error;
    throw new Error(typeof err === "string" ? err : `请求失败(${res.status})`);
  }
  const etag = res.headers.get('ETag');
  if (etag && body === undefined && ETAG_ENDPOINTS.has(endpoint)) {
    // LRU 淘汰：超过 50 条时删最早的，不做 clear() 避免缓存雪崩
    if (stateCache.size > 50) { const firstKey = stateCache.keys().next().value; if (firstKey) stateCache.delete(firstKey); }
    stateCache.set(url, { etag, json });
  }
  return json as T;
}

export interface AutoEvolveOptions {
  taskId?: string; runId?: string; commandId?: string; maxRounds?: number; noImproveRounds?: number;
  strategy?: string; multiBranch?: boolean; scoringConcurrency?: number; ops?: string[];
  maxMetricCalls?: number; maxMinutes?: number; budget?: { maxMetricCalls: number; maxMinutes: number };
  optimization?: Record<string, unknown> | null;
}
export type RsiStreamEvent = { step: string; round: number; detail: string; [k: string]: unknown };
/** Start/resume are explicit POST commands. Disconnecting never means the server stopped. */
export function rsiAutoEvolveSSE(opts: AutoEvolveOptions, onEvent: (data: RsiStreamEvent) => void, onError?: (msg: string) => void, onDone?: () => void): { close: () => void } {
  const taskId = opts.taskId || currentTaskId();
  const url = `${BASE}/intent-rsi${taskScopedPath(opts.runId ? '/auto-evolve-resume' : '/auto-evolve', taskId)}`;
  const controller = new AbortController();
  const { taskId: _taskId, ...body } = opts;
  fetch(url, { method: 'POST', body: JSON.stringify(body), signal: controller.signal,
    headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' } }).then(async res => {
    if (!res.ok || !res.body) {
      const j = await res.json().catch(() => ({} as Record<string, unknown>));
      throw new Error(typeof j.error === 'string' ? j.error : `请求失败(${res.status})`);
    }
    const reader = res.body.getReader(), decoder = new TextDecoder();
    let buf = '';
    const dispatch = (part: string) => {
      const lines = part.split('\n');
      const data = lines.filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
      if (!data) {
        if (lines.some(l => l.startsWith(':'))) onEvent({ step: 'heartbeat', round: 0, detail: '' });
        return;
      }
      try { const event = JSON.parse(data); onEvent(event); }
      catch (error) { if (!(error instanceof SyntaxError)) throw error; }
    };
    for (;;) {
      const { done, value } = await reader.read();
      buf += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n');
      const parts = buf.split('\n\n'); buf = parts.pop() || '';
      parts.forEach(dispatch);
      if (done) { if (buf.trim()) dispatch(buf); break; }
    }
    onDone?.();
  }).catch(error => { if (!controller.signal.aborted) onError?.(error instanceof Error ? error.message : '实时连接中断'); });
  return { close: () => controller.abort() };
}

export interface PerformanceEvidence {
  scoring_concurrency?: number | null;
  measured: number; total: number; p50_ms: number | null; p95_ms: number | null; mean_ms: number | null;
  llm_calls: number | null; tokens: number | null; cost: number | null;
}
export interface ShapeScores { total: number; strict_pct: number; relaxed_pct: number; performance?: PerformanceEvidence }
/** 引擎指纹：打分器版本锚点（引擎文件 sha + 协议版 + 模式），跨指纹的历史分数不可比 */
export interface EngineRev { engineSha: string; protoRev: number; engineMode: string }
/** 分题型子指标：all/train/heldout 三个口径都可能带（后端实际均产出） */
export interface ShapeBreakdown {
  single_intent?: ShapeScores;
  multi_intent?: ShapeScores;
  ambiguous_intent?: ShapeScores;
  negative_intent?: ShapeScores;
  multi_task_same_intent?: ShapeScores;
}
export type ScoresWithShapes = ShapeScores & ShapeBreakdown;

/** 策略臂：一个 (target, operator, family) 组合的实测台账 */
export interface StrategyArm {
  key: string; target: string; operator: string; family: string;
  attempts: number; measuredAttempts: number; wins: number;
  gainSum: number; gainMax: number | null;
  fixes: number; broken: number; targeted: number;
  winRate: number; meanGain: number; fixRate: number; dead: boolean;
}
/** 策略族：按失败族聚合的实测回收率与算子分布 */
export interface StrategyFamily {
  family: string; label: string; fixableBy: string;
  failedCases: number; attempts: number; measuredAttempts: number;
  wins: number; fixes: number; broken: number; targeted: number;
  prior: number; rate: number; source: 'measured' | 'blended' | 'prior';
  winRate: number;
  operators: { operator: string; attempts: number }[];
}
/** 策略算子：单个算子的实测胜率与修复率 */
export interface StrategyOperator {
  operator: string; label: string;
  attempts: number; measuredAttempts: number; wins: number;
  fixes: number; broken: number; targeted: number;
  winRate: number; fixRate: number; dead: boolean;
}
/** 杠杆：每个失败族的可回收空间与最优动作 */
export interface StrategyLeverage {
  family: string; failedCases: number; rate: number;
  expectedFixes: number; bestArm: string | null; bestWinRate: number | null;
  exhausted: boolean; remainingOperators: string[];
}
/** 策略记忆：从历史运行折叠出的搜索空间状态（后端 summarize() 全量输出，已随 /state 返回） */
export interface StrategySummary {
  version: number; generatedAt?: string; error?: string;
  runCount: number; candidateCount: number; measuredCount: number; promotedCount: number;
  successRate: number;
  arms: StrategyArm[];
  families: StrategyFamily[];
  operators: StrategyOperator[];
  deadArms: string[];
  deadOperators: string[];
  deadDimensions: string[];
  untriedOperators: string[];
  rates: Record<string, number>;
  digest: string;
  leverage: StrategyLeverage[];
}

export interface RsiGoal {
  metric: string; target: number; current?: number | null; gapPts?: number; missingCases?: number;
  total?: number; correct?: number; met?: boolean; reachable?: boolean; ceilingPct?: number; estimatedGain?: number;
  summary?: string;
  byShape?: { shape: string; total: number; correct: number; failed: number; strict_pct: number }[];
  byFamily?: { family: string; label: string; count: number; fixableBy?: string; estimatedFixes?: number }[];
  /** 下一步最该试什么：从 strategy.leverage 过滤出 expectedFixes>0 且未穷尽的失败族 */
  nextActions?: { family: string; expectedFixes: number; bestArm: string | null; winRate: number | null; label: string; fixableBy: string }[];
}

export interface RsiState {
  taskId?: string; taskName?: string; revision?: number;
  scoreValidity?: { current?: boolean; valid?: boolean; reasons?: string[]; reason?: string };
  /** 达标目标与缺口归因（当前口径基线有效时带 byShape/byFamily/nextActions） */
  goal?: RsiGoal | null;
  /** 策略记忆：搜索空间状态（已证否/未尝试/杠杆），随 /state 返回，无需单独调 /strategy */
  strategy?: StrategySummary | null;
  context?: Record<string, unknown>;
  rev?: number;
  currentEngineRev?: EngineRev | null;
  currentVersion: string;
  baseGraph: { kind: string; id: string; label: string };
  casesFile: string;
  split: { trainCount: number; heldoutCount: number; testCount?: number };
  /** 任务创建时选的评测引擎归属（引擎注册表 id，如 v2:xxx / bank:xxx），详情档案展示用 */
  engineRef?: string | null;
  finalExam?: {
    runCount: number;
    history: { version: string; at: string; engineRev?: EngineRev | null; scores: ShapeScores }[];
  } | null;
  attribution?: {
    at: string;
    version: string;
    engineMode?: string;
    engineRev?: EngineRev | null;
    engineBadCases?: { case_id: string; resultType: string; source: string }[];
    engineBadCaseCount?: number;
    families?: { family: string; rootCause: string; rootCauseDetail?: string; evidenceCases: string[]; suggestedOps: string[]; priority: string }[];
    stale?: boolean;
    staleReason?: string;
    /** P2 降级可见性（rev4）：归因走了引擎信号兜底/深诊断缺失时为 true */
    degraded?: boolean;
    degradedReason?: string;
    [k: string]: unknown;
  } | null;
  baseline: {
    stale?: boolean;
    version: string; at: string; engineRev?: EngineRev | null;
    scores: { all: ScoresWithShapes; train: ScoresWithShapes; heldout: ScoresWithShapes };
    /** 后端在 baseline 上也附了一份 goal（同口径基线有效时的差距归因） */
    goal?: RsiGoal | null;
    /** 高频混淆对：期望意图 → 实际误判为（次数）。后端在部分版本产出，可能缺省。 */
    confusionTop?: { expectedName: string; predictedName: string; count: number }[];
    /** 多路召回精度：各召回通道 top-1 命中率（离线推导，不调 LLM） */
    recallMetrics?: {
      total: number;
      channels: {
        lexical: { hit1: number; top1_pct: number };
        vector: { hit1: number; top1_pct: number };
        subgraph: { hit1: number; top1_pct: number };
        final: { hit1: number; top1_pct: number };
      };
      byShape: Record<string, { total: number; lexical: { hit1: number; top1_pct: number }; vector: { hit1: number; top1_pct: number }; subgraph: { hit1: number; top1_pct: number }; final: { hit1: number; top1_pct: number } }>;
    } | null;
    /** 模型裁决指标：LLM 裁决触发率/改变率/潜在增益（离线推导，不调 LLM） */
    adjudicationMetrics?: {
      total: number; triggered: number; triggered_pct: number;
      changed: number; changed_pct: number;
      potential_fixes: number; potential_fixes_pct: number;
      potential_regressions: number; potential_regressions_pct: number;
      net_gain_estimate: number;
    } | null;
    attributions: {
      family: string; count: number; suggested_op: string; note: string;
      samples?: {
        case_id: string; query: string; shape: string;
        expected: string[]; expectedNames?: string[];
        clauses?: { clause: string; top1: { id: string; name: string; score: number } | null; expected: { id: string; rank: number | null; score: number | null }[] }[];
        predicted: { top1: string; topk: { intent_id: string; intent_name: string; score: number }[]; clarifying: boolean } | null;
      }[];
    }[];
  } | null;
  archive: {
    runId?: string; branchId?: string; adoptability?: { ok: boolean; reason: string };
    id: string; opLabel: string; status: "proposed" | "passed" | "gated" | "adopted" | "rejected";
    createdAt: string; adoptedAs?: string;
    targetName?: string; evidenceQueries?: string[];
    proposal: { type: string; target: string; motivation?: string; evidence_cases?: string[];
      add_utterances?: string[]; add_hints?: string[]; add_scope_out?: string[]; confusable?: string; confusableName?: string;
      add_clause_views?: string[];
      new_description?: string; add_clarify_question?: string;
      /* A6-A8 结构级算子字段 */
      intent_name?: string; intent_type?: string; utterance_view?: string[]; description?: string;
      /* A6_ambiguity_cluster_expand：歧义簇声明，targets 为互为澄清候选的意图 ID 列表 */
      targets?: string[];
      /* combo：组合提案，parts 为子提案数组 */
      parts?: Array<{ type: string; targets?: string[]; target?: string; add_utterances?: string[]; add_hints?: string[]; add_scope_out?: string[]; evidence_cases?: string[] }>;
      source?: string; add_confusable?: string[]; remove_confusable?: string[]; domain?: string; intent_level?: string;
      /* 后端出的结构字段人话名（内部 ID 不上屏） */
      sourceName?: string; targetIntentName?: string; addConfusableNames?: string[]; removeConfusableNames?: string[] };
    trainScores: ShapeScores | null; heldoutScores: ShapeScores | null;
    /** bundle（融合候选）的完整资产标识；单体提案无此字段 */
    candidateHash?: string | null;
    /** 融合候选所基于的底图版本（谱系 DAG 的变异来源边用；后端盖章，可能缺省） */
    candidateBaseVersion?: string | null;
    /** 融合候选基于的母资产指纹（谱系 DAG 变异来源边用；后端盖章，可能缺省） */
    baseAssetHash?: string | null;
    baselineAtEval?: { version: string; train: { strict_pct: number; relaxed_pct: number }; heldout: { strict_pct: number; relaxed_pct: number } } | null;
    engineCheck?: { at: string; ok: boolean; engineMode?: string; engineRev?: EngineRev | null; candidateHash?: string | null; baseAssetHash?: string | null; caseCount: number; current: { strict_pct: number; relaxed_pct: number }; draft: { strict_pct: number; relaxed_pct: number } } | null;
    gate: { stage: string; reason: string } | null;
    fixedCases?: string[];
    paretoOptimal?: boolean;
    staleEngine?: boolean;
    evaluatedAt?: string | null;
    pendingHours?: number | null;
  }[];
  regression: { caseId: string; fixedIn: string; by: string; query: string }[];
  integrity: { drift: boolean; blind: boolean; heldoutArchives: number };
  calibration: {
    status: "idle" | "running" | "done" | "error";
    startedAt: string | null;
    stale?: boolean;
    staleReason?: string | null;
    /** P3（rev4）：wrapper 落盘退出码——即时判错（不再干等超时） */
    errorCode?: string | null;
    report: {
      finishedAt: string; engineMode: string; engineErrors: number; totalCases: number;
      agreement: { total: number; overallPct: number; byShape: Record<string, { total: number; agreePct: number }> };
      disagreements: { case_id: string; query: string; shape: string; detail: string }[];
    } | null;
  };
  stats: { proposeRuns: number; llmCalls: number; proposalsTotal: number; noveltyFiltered: number; evaluated: number; passed: number; adopted: number; rejected: number };
  statsReconciliation?: { archiveTotal: number; byStatus: Record<string, number>; note: string };
  scoreHistory?: { version: string; at: string; engineRev?: EngineRev | null; scores: RsiScores & { engineRev?: EngineRev }; context?: { casesSha256: string; splitSha256: string }; ctx?: { runId?: string | null; gen?: number | null; casesSha256?: string | null; splitRev?: number | null } | null }[];
  evolveRuns?: EvolveRun[];
  activeEvolution?: EvolveRun | null;
  /** 方法台账（设计「方法沉淀」节）：假设/净收益/淘汰原因/成本，方法生命周期 hypothesis→tested→validated→promoted/rejected */
  methodHistory?: MethodRecord[];
  /** 当前冻结的多路径优化配置（上次运行的路由），启动弹窗回显用 */
  optimizationConfig?: OptimizationConfig | null;
  branches?: BranchInfo[] | null;
  population?: string[] | null;
  champion?: string | null;
  /** 自动进化是否进行中（内存态；页面刷新后据此显示进行中横幅——SSE 流不可重附） */
  evolveRunning?: boolean;
  versions: { version: string; changelog: string; at: string; rollbackFrom?: string; parentVersion?: string; applied?: string[]; assetHash?: string }[];
  log: { at: string; event: string; detail: string }[];
  /** prompt 层 RSI（rev4）：MemberOptimizer 优化提案器指令 */
  promptOptimize?: { status: string; at?: string; startedAt?: string; skill?: string; lastId?: string; detail?: string } | null;
  skillOverrides?: { propose?: boolean; attribute?: boolean };
  promptCandidates?: {
    id: string; skill: string; at: string; status: "draft" | "applied" | "rejected";
    issuesCount: number; oldChars: number; newChars: number;
    optimizedPrompt: string; actions: { operation: string; target: string; rationale: string }[];
    elapsedSec?: number; appliedAt?: string;
  }[];
}

export interface BasesInfo {
  current: RsiState["baseGraph"];
  casesCount: number;
  snapshots: { id: string; label: string; intents: number; importedAt?: string }[];
  /** AI Harbor 线上图谱版本清单（图谱编辑器 manifest 共享，10-16 打通） */
  manifestVersions?: { versionId: string; name: string; status: string | null; graphFile: string | null; imported: boolean }[];
  manifestActive: string | null;
}

/** 资产谱系（/api/intent-rsi/asset-lineage）：artifacts 目录全部 bundle 摘要，
 *  parents 边集构成真实变异树——run 元数据随 state 存活，资产树在磁盘永存。 */
export interface AssetLineage {
  assets: { hash: string; short: string; baseVersion: string | null; parents: string[];
    mutations: string[]; adoptedBy: string[]; createdAt: string | null;
    /** 分支成绩（state.branches 里以该资产记账的评测；历史 bundle 可能缺失） */
    scores?: { all: number | null; heldout: number | null } | null }[];
  currentVersion: string;
}

export interface BranchInfo {
  id: string;
  parent: string | null;
  parents?: string[];
  crossedWith?: string | null;
  op: string;
  opLabel?: string;
  status: string;
  depth: number;
  /** 诞生代（0=根/输入复制，≥1=第 gen 代变异产物；10-14 起后端盖章） */
  gen?: number | null;
  /** 根分支复制自的正式版本（分支树的代际锚点） */
  baseVersion?: string | null;
  scores: { train?: ShapeScores; heldout?: ShapeScores; all?: ShapeScores & { single_intent?: ShapeScores; multi_intent?: ShapeScores; ambiguous_intent?: ShapeScores } } | null;
  gatePassed?: boolean;
  gateReason?: string | null;
  paretoOptimal?: boolean;
  createdAt: string;
  evaluatedAt?: string | null;
  staleEngine?: boolean;
}

export interface EvolveRound {
  reasoning?: RsiReasoningRecord;
  timings?: { elapsedMs: number; phases: Record<string, number> };
  round: number;
  gen?: number;
  proposed: number;
  accepted: number;
  passed: number;
  adopted: number;
  adoptedVersions: string[];
  mutated?: number;
  survivors?: number;
  pruned?: number;
  champion?: string | null;
  roundChampion?: string | null;
  inputBranch?: string | null;
  inputBranches?: string[];
  population?: string[];
  mutationErrors?: { target?: string; method?: string; parent?: string; reason: string }[];
  inputScores?: RsiScores | null;
  outputScores?: RsiScores | null;
  engineRev?: EngineRev | null;
  branchIds?: string[];
  candidates?: (EvolutionBranch | string)[];
  phase?: string;
  note?: string | null;
  heldoutRelaxed: number | null;
  heldoutStrict: number | null;
  trainStrict?: number | null;
  allStrict?: number | null;
  /** 轮末全量成绩（含分题型）；heldoutRelaxed/heldoutStrict 缺失时的回退来源（10-15 审核 P2） */
  fullScores?: RsiScores | null;
  improved: boolean;
  result: string;
}

export interface EvolveRun {
  decisionMode?: 'model'|'rules'|'agent';
  modelCalls?: number;
  probeCalls?: number;
  taskId?: string; checkpoint?: Record<string, unknown>;
  timings?: { elapsedMs: number; phases: Record<string, number> };
  scoringConcurrency?: number;
  id?: string | null;
  at: string;
  maxRounds: number;
  noImproveLimit: number;
  adoptStrategy: string;
  totalAdopted: number;
  finalVersion: string;
  status: string;
  multiBranch?: boolean;
  /** 该轮结束时的冠军分支（多分支策略才有；= null 表示仍是基线 b0） */
  champion?: string | null;
  population?: string[];
  adoptedBranch?: string;
  baseVersion?: string;
  engineRev?: EngineRev | null;
  context?: { casesSha256?: string | null; splitRev?: number | null; contextId?: string | null };
  stale?: boolean;
  currentGen?: number;
  /** 多路径优化配置（用户启动前冻结；= null 表示未启用多路径，走单线图谱） */
  optimization?: OptimizationConfig | null;
  /** 评测预算台账：本次 run 消耗的评测次数 */
  metricCalls?: number;
  /** 本次 run 启动时冻结的预算上限（运行摘要"已用/上限"展示用；旧记录可能缺省） */
  budget?: { maxMetricCalls: number; maxMinutes: number };
  /** 每轮结束时的分支快照（多分支策略才有）——分支 ID 跨轮复用（每轮从 b1 重编），须按 run 分组解读 */
  branches?: Record<string, EvolutionBranch> | null;
  rounds: EvolveRound[];
}

/** 多路径优化能力注册表（/optimization-capabilities 返回）——启动弹窗据此渲染 */
export interface OptimizationCapabilities {
  features?: { merge?: boolean; allStrategy?: boolean; memberOptimizer?: boolean; resume?: boolean; export?: boolean; agent?: boolean };
  targets: Record<string, { label: string; status: "ready" | "requires_setup" | "reserved"; methods: string[]; reason?: string }>;
  methods: Record<string, { label: string; status: "ready" | "requires_setup" | "reserved"; reason?: string }>;
  defaults: { branching: string; parentPolicy: string; maxMetricCalls: number; maxMinutes: number };
}

/** 用户启动前冻结的多路径优化配置（与后端 normalizeOptimizationConfig 输出同构） */
export interface OptimizationConfig {
  decisionMode?: 'model'|'rules'|'agent';
  schema: number;
  targets: string[];
  routes: { id: string; target: string; method: string }[];
  branching: string;
  parentPolicy: string;
  allowMerge: boolean;
  budget: { maxMetricCalls: number; maxMinutes: number };
}

export interface RsiReasoningRecord {
 schema:number; mode:'model'|'agent'; status:string; error?:string;
 repair?:{used:boolean;firstError?:string};
 input?:{parents:{cases:{case_id:string;query?:string;strict:boolean;resultType?:string;evidence?:unknown}[]}[]};
 plan?:{summary:string; diagnoses:{id:string;cause:string;evidenceCaseIds:string[];probe:string}[];
  experiments:{id:string;hypothesisId:string;parentId:string;target:string;kind:string;caseIds:string[];controlCaseIds:string[];instruction:string;successCriterion:string}[];
  decision:{action:string;reason:string}};
 reflection?:{decision:'continue'|'revise'|'stop';reason:string;nextFocusCaseIds:string[];rejectedHypothesisIds:string[]};
 trials?:{experimentId:string;status:string;error?:string;probe?:{count:number;reason:string;changes:{case_id:string;change:string;before:{resultType?:string};after:{resultType?:string}}[]}}[];
}

/** 方法台账条目（后端 methodRecord 输出）：一条可迁移优化方法的证据与生命周期 */
export interface MethodRecord {
  id: string; runId: string; gen: number; branch: string;
  target: string; method: string;
  hypothesis: string | null;
  trainGain: number | null; validationGain: number | null;
  status: "observed_gain" | "no_gain" | "rejected" | "hypothesis";
  reason: string | null;
  independentValidated?: boolean;
  artifactHash?: string | null;
}

export interface EvolutionBranch {
  id: string; parent: string | null; op: string; status: string; depth: number;
  crossedWith?: string | null; parents?: string[];
  opLabel?: string; summary?: string; proposalId?: string | null;
  target?: string; method?: string; artifactHash?: string | null;
  gen?: number | null; baseVersion?: string | null; gateReason?: string | null;
  scores: { trainStrict?: number | null; heldoutStrict?: number | null; allStrict?: number | null } | null;
  fullScores?: RsiScores | null; engineRev?: EngineRev | null;
  paretoOptimal?: boolean; evaluatedAt?: string | null; createdAt?: string;
  adoptedAs?: string; duplicateOf?: string | null;
  proposal?: Record<string, unknown> | null; runtimeMutation?: Record<string, unknown> | null;
}

export type RsiScores = NonNullable<RsiState["baseline"]>["scores"];

export const STATUS_META: Record<string, { color: string; label: string }> = {
  proposed: { color: "default", label: "待验证" },
  passed: { color: "green", label: "验证通过，待采纳" },
  gated: { color: "red", label: "验证未通过" },
  adopted: { color: "blue", label: "已采纳生效" },
  rejected: { color: "default", label: "已拒绝" },
  rolled_back: { color: "orange", label: "已回滚" },
  eval_error: { color: "orange", label: "评测出错" },
  pruned: { color: "default", label: "已淘汰" },
};

// 引擎指纹短名：sha 前 6 位 + 模式，用于「跨引擎断点」标记
export function engineRevShort(rev?: EngineRev | null): string {
  if (!rev || !rev.engineSha) return "";
  return `${rev.engineSha.slice(0, 6)}/${rev.engineMode.split('+')[0] === "online" ? "在线" : "离线"}`;
}

// 成绩轨迹里的引擎断点检测：相邻点指纹不同 → 断点索引集合，断点前后历史不可比
export function engineBreakPoints(history: { engineRev?: EngineRev | null }[] | undefined): Set<number> {
  const breaks = new Set<number>();
  if (!history || history.length < 2) return breaks;
  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1].engineRev;
    const cur = history[i].engineRev;
    if (prev && cur && (prev.engineSha !== cur.engineSha || prev.protoRev !== cur.protoRev || prev.engineMode !== cur.engineMode)) {
      breaks.add(i);
    }
  }
  return breaks;
}

// ── 可采纳统一判定（10-15 前端一致性审核 P0-2）──
// 与后端 runAdopt 的闸门逐条对齐：passed 状态 → 非旧引擎口径 → 第四关引擎复核通过
// → 第四关带引擎指纹且与三关证据同口径。此前前端只看 engineCheck.ok，
// 出现「按钮亮着、后台拒绝」的不一致。所有采纳入口（病因处方卡 / 候选对比表）共用。
export function canAdopt(
  p: RsiState["archive"][number],
  ctx: { currentVersion: string; currentEngineRev?: EngineRev | null; baselineFresh?: boolean },
): { ok: boolean; reason: string } {
  if (p.adoptability) return p.adoptability;
  if (p.status !== "passed") return { ok: false, reason: "方案未通过前三关验证" };
  if (p.staleEngine) return { ok: false, reason: "成绩产自旧版评测引擎，与当前口径不可比——请先重新评测" };
  if (!p.engineCheck || p.engineCheck.ok !== true) return { ok: false, reason: "需先通过第四关·生产引擎复核" };
  if (!p.engineCheck.engineRev) return { ok: false, reason: "第四关复核缺引擎指纹（旧代码产物），请重新做引擎复核" };
  const cur = ctx.currentEngineRev;
  if (cur && (p.engineCheck.engineRev.engineSha !== cur.engineSha || p.engineCheck.engineRev.protoRev !== cur.protoRev || p.engineCheck.engineRev.engineMode !== cur.engineMode)) {
    return { ok: false, reason: "引擎复核用的是旧口径引擎，请重新复核" };
  }
  for (const ev of [p.trainScores, p.heldoutScores]) {
    const rev = ev && (ev as { engineRev?: EngineRev | null }).engineRev;
    if (!rev) return { ok: false, reason: "三关成绩缺引擎指纹（旧代码产物），请重新评测" };
    if (p.engineCheck.engineRev && (rev.engineSha !== p.engineCheck.engineRev.engineSha || rev.protoRev !== p.engineCheck.engineRev.protoRev)) {
      return { ok: false, reason: "三关成绩与引擎复核不是同一口径，请重新评测并复核" };
    }
  }
  if (p.baselineAtEval && p.baselineAtEval.version !== ctx.currentVersion) {
    return { ok: false, reason: `该方案的成绩是对版本 ${p.baselineAtEval.version} 验证的，图谱已升级到 ${ctx.currentVersion}——请重新评测` };
  }
  const gain = p.trainScores && p.baselineAtEval
    ? Number((p.trainScores.relaxed_pct - p.baselineAtEval.train.relaxed_pct).toFixed(1))
    : null;
  if (gain != null && gain <= 0) return { ok: false, reason: `练习题部分得分率无净提升（Δ=${gain}pp），无实效的改动不固化版本` };
  return { ok: true, reason: "已过四关且证据与当前引擎同口径，可以采纳" };
}

export const FAMILY_INFO: Record<string, { name: string; desc: string }> = {
  single_recall_miss: { name: "没有找到", desc: "正确意图压根没进候选名单 → 补充该意图的说法示例" },
  single_rank_error: { name: "排序输了", desc: "正确意图在候选里但排不到第一 → 增加与其他意图的区分线索" },
  single_wrong_label: { name: "认错了", desc: "把用户的话匹配到了别的意图 → 改写意图描述、划清边界" },
  multi_clause_rank: { name: "复合句：子句输给相近意图", desc: "拆出的子句被一个相近意图压过 → 给该子句补充口语化短句说法" },
  multi_clause_weak: { name: "复合句：子句匹配太弱", desc: "子句能找到正确意图但分数太低 → 补充该子句的短句说法" },
  multi_clause_miss: { name: "复合句：子句没找到", desc: "拆出的子句完全召回不到正确意图 → 补充说法示例" },
  multi_partial: { name: "复合句：只答对一半", desc: "多个子句只命中了一部分 → 补充缺失部分的说法" },
  ambig_not_triggered: { name: "该反问没反问", desc: "问题有歧义时系统直接猜了答案 → 给意图增加澄清问题" },
  ambig_missing_expected: { name: "反问了但没给对选项", desc: "反问的选项里没有正确答案 → 补全澄清候选范围" },
};

export const GATE_NAME: Record<string, string> = {
  train: "第一关·练习题初筛",
  regression: "第二关·防回退",
  heldout: "第三关·隐藏考",
  engine: "第四关·生产引擎复核",
};

export const OP_ACTION: Record<string, string> = {
  A1_utterance_expand: "补充说法",
  A2_disambiguation: "增强区分线索",
  A3_clause_expansion: "补充短句说法",
  A4_description_rewrite: "改写意图描述",
  A5_clarify: "增加澄清问题",
  A6_add_intent: "新增意图",
  A6_ambiguity_cluster_expand: "歧义簇声明",
  A7_merge_intent: "合并意图",
  A8_relation_edit: "调整关系",
  combo: "组合提案",
};

// 成绩维度的一句白话（对比卡/统计卡通用）
// 命名说明：strict/relaxed 在不同题型上语义不同（单意图=Top-1/Top-5 命中；
// 复合句=意图集合完全命中/重叠度；模糊=正确反问/选项覆盖率），统一叫
// 「完全正确率/部分得分率」才不撒谎——此前全局叫 Top-1/Top-5 精度是错误标注
export const METRIC = { strict: "完全正确率", relaxed: "部分得分率" } as const;

export const SCORE_DIM_NOTES: Record<string, string> = {
  strict: "完全正确率：单意图=第一名命中；复合句=意图集合完全命中；模糊提问=正确反问且选项覆盖。单意图语境下即 Top-1 命中",
  relaxed: "部分得分率：单意图=正确进前5候选；复合句=意图集合重叠度；模糊提问=反问选项覆盖率。单意图语境下即 Top-5 命中",
  train: "练习题——参与优化的题目（AI 看得见错题），成绩偏乐观",
  heldout: "隐藏考题——AI 优化时看得见门禁结果但从不参与拟合，作为选型依据；最终结论以「终极考题」（test 集，一次触达）为准",
  test: "终极考题（test 集）——整个优化循环全程不可见，只在你手动发起时评测；每测一次参考价值下降一分",
  total: "本轮考试的全部题目",
};

// 历史 state 里持久化的 reason/changelog 可能仍含机制词，渲染层统一翻译兜底。
// 复合字段名必须先于其子串替换（否则 disambiguation_hints 会被拦腰改成「disambiguation_区分线索」）
export function humanize(s: string) {
  return String(s || "")
    .replace(/disambiguation_hints/g, "区分线索")
    .replace(/clarify_questions/g, "澄清问题")
    .replace(/utterance[ _]view/g, "说法示例")
    .replace(/clause[ _]view/g, "子句说法")
    .replace(/\bscope_out\b/g, "排除项")
    .replace(/\bA[1-8]_[a-z_]+\b/g, m => OP_ACTION[m] || m)
    .replace(/盲测/g, "隐藏考")
    .replace(/held-?out/g, "隐藏考题")
    .replace(/\bstrict\b/g, METRIC.strict)
    .replace(/\brelaxed\b/g, METRIC.relaxed)
    .replace(/\btrain\b/g, "练习题")
    .replace(/形态回撤/g, "某类意图退步")
    .replace(/回归保护/g, "防回退盯守")
    .replace(/基线/g, "改前成绩")
    .replace(/提案/g, "方案")
    .replace(/topk/g, "前5候选")
    .replace(/top1/g, "第一名")
    .replace(/hints/g, "区分线索")
    .replace(/坏例/g, "错题")
    .replace(/schema\/novelty/g, "格式/重复拦截")
    .replace(/schema/g, "格式校验")
    .replace(/novelty/g, "重复拦截");
}

// 档案条目 delta 的合法基线：只能是「该方案评估时」的基线快照。
// 旧档案没有 baselineAtEval —— 宁可不显示 delta，也不能拿当前基线错位对比
//（曾把已采纳方案显示成负分：v2 方案 +5.3 被对着 v3 基线显示成 -5.2）
export function baselineForDelta(p: RsiState["archive"][number]): {
  trainRelaxed: number; heldStrict: number; heldRelaxed: number; version: string;
} | null {
  const b = p.baselineAtEval;
  if (!b) return null;
  return { trainRelaxed: b.train.relaxed_pct, heldStrict: b.heldout.strict_pct, heldRelaxed: b.heldout.relaxed_pct, version: b.version };
}

export function deltaNode(base: number | undefined, now: number | undefined) {
  if (now === undefined || now === null || base === undefined || base === null) return null;
  const d = now - base;
  if (Math.abs(d) < 0.05) return <span style={{ color: "#898781" }}>持平</span>;
  // Δ 单位一律 pp（百分点），与相对百分比区分（10-15 审核 P2：此前裸数字无单位）
  return <span style={{ color: d > 0 ? "#006300" : "#d03b3b", fontWeight: 600 }}>{d > 0 ? "+" : ""}{d.toFixed(1)} pp</span>;
}

export function proposalChanges(p: RsiState["archive"][number]) {
  const pr = p.proposal;
  if (pr.type === "A1_utterance_expand") return `补充这些说法：${(pr.add_utterances || []).join(" / ")}`;
  if (pr.type === "A2_disambiguation") return `新增区分线索：${(pr.add_hints || []).join(" / ")}${pr.confusableName ? `；易混淆意图 → ${pr.confusableName}` : ""}${pr.add_scope_out?.length ? `；明确不管：${pr.add_scope_out.join("/")}` : ""}`;
  if (pr.type === "A3_clause_expansion") return `给复合句拆出的子句补充短句说法：${(pr.add_clause_views || []).join(" / ")}`;
  if (pr.type === "A4_description_rewrite") return `把意图描述改写为：${pr.new_description}`;
  if (pr.type === "A5_clarify") return `新增澄清问题（遇到模糊提问时反问用户）：${pr.add_clarify_question}`;
  if (pr.type === "A6_add_intent") return `新建意图「${pr.intent_name}」（类型 ${pr.intent_type || "ASK"}${pr.description ? `：${pr.description}` : ""}），首批说法：${(pr.utterance_view || []).join(" / ")}`;
  if (pr.type === "A6_ambiguity_cluster_expand") return `声明歧义簇（${(pr.targets || []).length} 个意图互为澄清候选），补充触发说法：${(pr.add_utterances || []).join(" / ")}`;
  // combo：逐个子提案展开（A6 簇扩展 + A2 收边等），用编号分行
  if (pr.type === "combo") {
    const parts = pr.parts as Array<Record<string, unknown>> || [];
    const lines = parts.map((part, i) => {
      const label = OP_ACTION[part.type as string] || String(part.type || "");
      if (part.type === "A6_ambiguity_cluster_expand") {
        const tg = (part.targets as string[]) || [];
        const ut = (part.add_utterances as string[]) || [];
        return `${i + 1}. ${label}：${tg.length} 个意图互为澄清候选，补充说法「${ut.join(" / ")}」`;
      }
      if (part.type === "A2_disambiguation") {
        const hints = (part.add_hints as string[]) || [];
        return `${i + 1}. ${label}：${hints.length ? `线索「${hints.join(" / ")}」` : "收边"}`;
      }
      if (part.type === "A1_utterance_expand") {
        const ut = (part.add_utterances as string[]) || [];
        return `${i + 1}. ${label}：「${ut.join(" / ")}」`;
      }
      return `${i + 1}. ${label}`;
    });
    return lines.join("\n");
  }
  // A7/A8 用后端出的人话名（10-14 审计：此前直接渲染 pr.target / add_confusable 裸 ID）
  if (pr.type === "A7_merge_intent") return `把「${pr.sourceName || p.targetName?.split(" → ")[0] || pr.source}」合并进「${pr.targetIntentName || p.targetName?.split(" → ")[1] || pr.target}」——两意图边界长期重叠、划界修不动时合并声明（仅限无题引用的安全合并）`;
  if (pr.type === "A8_relation_edit") return `调整「${p.targetName || pr.target}」的混淆关系：${pr.addConfusableNames?.length ? `标记易混淆 → ${pr.addConfusableNames.join("/")}` : ""}${pr.removeConfusableNames?.length ? `${pr.addConfusableNames?.length ? "；" : ""}解除混淆 → ${pr.removeConfusableNames.join("/")}` : ""}${pr.domain ? `；域归属 → ${pr.domain}` : ""}${pr.intent_level ? `；层级 → ${pr.intent_level}` : ""}`;
  return "";
}

export function infoTitle(text: string, tip: string) {
  return <Tooltip title={tip}><span>{text}</span></Tooltip>;
}

// 错题样例一行人话：题目 → 期望 vs 实际（LangSmith 式例子级下钻）
export type RsiAttribution = NonNullable<NonNullable<RsiState["baseline"]>["attributions"]>[number];
export type RsiSample = NonNullable<RsiAttribution["samples"]>[number];
export function sampleLines(s: RsiSample) {
  const lines: JSX.Element[] = [];
  if (s.shape === "multi_intent" && s.clauses?.length) {
    for (const c of s.clauses) {
      const expParts = (c.expected || [])
        .map((e) => `${e.rank ? `第${e.rank}名` : "没进前5"}(${e.score ?? "-"})`)
        .join("、");
      lines.push(
        <div key={`c-${c.clause}`} style={{ fontSize: 12, lineHeight: 1.8 }}>
          子句「{c.clause}」→ 实际给了「{c.top1?.name || "无匹配"}」{c.top1 ? `(${c.top1.score})` : ""}，期望意图{expParts}
        </div>,
      );
    }
    return lines;
  }
  const top1 = s.predicted?.topk?.[0];
  if (!top1) {
    lines.push(<div key="miss" style={{ fontSize: 12, lineHeight: 1.8 }}>系统没给出任何候选（完全没找到）</div>);
  } else if (s.shape === "ambiguous_intent") {
    lines.push(
      <div key="amb" style={{ fontSize: 12, lineHeight: 1.8 }}>
        {s.predicted?.clarifying ? "反问了，但选项里没有正确答案" : "直接猜了答案（没有反问）"}；实际给了「{top1.intent_name}」({top1.score})，期望「{(s.expectedNames || []).join("、")}」
      </div>,
    );
  } else {
    const inTopk = s.predicted?.topk?.some((k) => (s.expected || []).includes(k.intent_id));
    lines.push(
      <div key="single" style={{ fontSize: 12, lineHeight: 1.8 }}>
        实际给了「{top1.intent_name}」({top1.score}){inTopk ? "，正确意图在候选里但排不到第一" : "，正确意图没进前 5 候选"}
      </div>,
    );
  }
  return lines;
}

/** 事件流条目（SSE 与持久化回放共用形态） */
export interface RsiStreamStep { step: string; round: number; detail: string; [k: string]: unknown }

/** 从持久化 run 记录合成事件流——SSE 只活在发起页，刷新/新开页面后用这个兜底（10-19 用户实测反馈）。全部来自真实记录，不合成测量。 */
export function synthesizeRunSteps(run: EvolveRun): RsiStreamStep[] {
  const out: RsiStreamStep[] = [];
  for (const r of run.rounds || []) {
    const rs = r.reasoning; const gen = r.gen ?? r.round ?? 0;
    if (!rs) continue;
    if (rs.plan?.summary) out.push({ step: "plan", round: gen, detail: `第${gen}代计划：${rs.plan.summary}（${rs.plan.experiments?.length || 0} 个实验）` });
    else if (rs.error) out.push({ step: "plan", round: gen, detail: `第${gen}代计划未通过契约校验：${rs.error}` });
    else out.push({ step: "mutate", round: gen, detail: `第${gen}代进行中：${rs.mode === "agent" ? "Agent 调研与反事实探针" : "规划执行"}` });
    for (const t of rs.trials || []) {
      const p = t.probe;
      out.push({ step: "probe", round: gen, detail: `实验 ${t.experimentId}：${p ? `训练探针 ${p.count} 题${p.reason ? "，" + p.reason : ""}` : t.status === "duplicate" ? "重复完整资产，未重复测量" : t.status || "已执行"}` });
    }
    if (rs.reflection) out.push({ step: "reflect", round: gen, detail: `复盘：${rs.reflection.reason || rs.reflection.decision}` });
  }
  for (const b of Object.values(run.branches || {})) {
    if (!b.status || ["alive", "evaluating"].includes(b.status)) continue;
    const fate = b.status === "pruned" ? "淘汰" : b.status === "adopted" || b.status === "frozen" ? "固化" : b.status;
    out.push({ step: "select", round: b.gen || 0, detail: `分支 ${b.id}${b.summary ? `（${b.summary}）` : ""}：${fate}${b.gateReason ? `，${b.gateReason}` : ""}` });
  }
  return out.sort((a, b) => a.round - b.round);
}
