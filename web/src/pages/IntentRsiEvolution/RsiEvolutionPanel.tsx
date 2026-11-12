/**
 * 意图进化实验台主壳。
 *
 * 信息架构（克制编辑部风「墨 · 线 · 蓝」）：
 *   ① 工具条      —— 换图谱 / 启动自动进化
 *   ② 决策锚点    —— 「现在该做什么」：步骤条 + 主 CTA + 三个关键读数
 *   ③ 进化效果    —— 精度趋势 + 自动进化历史
 *   ④ 待审阅方案    —— 候选方案并列对比 + 识别问题与改进建议
 *   ⑤ 明细与设置  —— 折叠：实验对象 / 成绩明细 / 运行数据 / 维护
 *
 * 机制术语（算子码/归因族/门禁）一律翻译为人话，共享层见 rsiShared.tsx。
 * 独立数据（data/rsi/），不触碰生产图谱与引擎；API 走 /api/intent-rsi/*（graph-builder 同源，无前置网关）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Card, Collapse, Empty, InputNumber, List, Modal, Popconfirm, Select, Space, Spin, Statistic, Switch, Tag, Tabs, Tooltip, Typography, message } from "antd";
import { RsiDataPreparation } from './RsiDataPreparation';
import { CaretRightOutlined, CloudDownloadOutlined, ExperimentOutlined, FileAddOutlined, RedoOutlined, ThunderboltFilled, ThunderboltOutlined, StopFilled, CheckCircleOutlined, WarningOutlined, AimOutlined } from "@ant-design/icons";
import {
  GATE_NAME, humanize, infoTitle, rsiRequest as sharedRequest, rsiAutoEvolveSSE, SCORE_DIM_NOTES,
  engineBreakPoints, engineRevShort, canAdopt, synthesizeRunSteps,
  type BasesInfo, type RsiState, type OptimizationCapabilities, type AssetLineage,
} from "./rsiShared";
import { COLOR, GRADIENT, InfoBox, MetricCard, RULE, SectionTitle, SHADOW, TYPE } from "./rsiDesign";
import { RsiTaskOverview } from "./RsiTaskOverview";
import { RsiCureGroups } from "./RsiCureCard";
import { RsiTrajectory } from "./RsiTrajectory";
import { RsiParkTrajectory } from "./RsiParkTrajectory";
import { RsiCandidatesTable } from "./RsiCandidatesTable";
import { RsiEvolveRuns } from "./RsiEvolveRuns";
import { RsiReasoningReview } from './RsiReasoningReview';
import { RsiMultiBranchStatus } from "./RsiMultiBranchStatus";
import { RsiRunSummaryCard } from "./RsiRunSummaryCard";
import type { BranchInfo } from "./rsiShared";
import { GOAL_TEMPLATES, applyGoalTemplate, goalTemplateById, type GoalTemplate } from "./rsiGoalTemplates";
import { BUDGET_PRESETS, matchBudgetPreset } from "./rsiBudgetPresets";

// 部署核验标记：构建后 grep dist bundle 里本串，确认新版已上线（防并发会话/旧包混淆）
console.info("[rsi-ui] build 20261018-task-overview");

/** 可进化算子清单（与生产环白名单 A1-A6 + combo 一致）——启动配置里勾选哪些允许 AI 使用。
 *  注：A7/A8（合并意图、调整关系）后端白名单不支持，曾在此误列导致选了也无效（评审 F08），已删。
 *  A6_ambiguity_cluster_expand 和 combo 已在后端 intent-rsi.js 放宽校验后支持（t217 patch）。 */
const OP_OPTIONS = [
  { value: "A1_utterance_expand", label: "A1 补充说法（意图找不到/说法太少）" },
  { value: "A2_disambiguation", label: "A2 增强区分线索（相近意图分不清）" },
  { value: "A3_clause_expansion", label: "A3 补充短句说法（复合句子句匹配弱）" },
  { value: "A4_description_rewrite", label: "A4 改写意图描述（认错对象）" },
  { value: "A5_clarify", label: "A5 增加澄清问题（该反问没反问）" },
  { value: "A6_ambiguity_cluster_expand", label: "A6 歧义簇声明（模糊意图触发澄清）" },
  { value: "combo", label: "组合提案（A6 簇扩展 + A2 收边）" },
];

/** 工具条：迭代对象 + 自动进化入口，全页唯一的"换对象 / 跑批"控制条 */
function Toolbar({ extra }: { extra?: React.ReactNode }) {
  if(!extra)return null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", margin: "22px 0 18px" }}>
      <Typography.Text strong style={{ fontSize: TYPE.small, color: COLOR.textSecondary }}>迭代对象</Typography.Text>
      {extra}
    </div>
  );
}

export default function RsiEvolutionPanel({ initialGraphKey = "bank", taskId, onTaskName }: { initialGraphKey?: string; taskId: string; onTaskName?: (name: string) => void }) {
  const rsiRequest = useCallback(<T,>(path: string, body?: unknown) => sharedRequest<T>(path, body, taskId), [taskId]);
  const [section, setSection] = useState(() => typeof window === 'undefined' ? 'overview' : new URLSearchParams(window.location.search).get('section') || 'overview');
  const [preflight, setPreflight] = useState<{ ready: boolean; blockers: string[]; warnings: string[]; summary?: Record<string, unknown> } | null>(null);
  const [preflightBusy, setPreflightBusy] = useState(false);
  const chooseSection = (key: string) => { setSection(key); const url = new URL(window.location.href); url.searchParams.set('section', key); window.history.replaceState(null, '', url); };
  const setRunUrl = (id: string) => { const url = new URL(window.location.href); url.searchParams.set('runId', id); window.history.replaceState(null, '', url); };
  const [state, setState] = useState<RsiState | null>(null);
  const [bases, setBases] = useState<BasesInfo | null>(null);
  // 资产谱系（10-15 谱系 DAG 完整变异树）：artifacts 磁盘上的 bundle 边集，
  // run 元数据随 state 事故丢失后只有它能还原"哪些变异从哪个母资产长出来"
  const [lineage, setLineage] = useState<AssetLineage | null>(null);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState("");
  const [openFamily, setOpenFamily] = useState<string>("");
  // ── 自动进化状态 ──
  const [autoEvolveRunning, setAutoEvolveRunning] = useState(false);
  const [autoEvolveSteps, setAutoEvolveSteps] = useState<{ step: string; round: number; detail: string; [k: string]: unknown }[]>([]);
  const [evolveConfigOpen, setEvolveConfigOpen] = useState(false);
  const [evolveModalOpen, setEvolveModalOpen] = useState(false);
  const [sseStale, setSseStale] = useState(false);
  const [evolveCfg, setEvolveCfg] = useState<{ maxRounds: number; noImproveRounds: number; strategy: string; multiBranch: boolean; scoringConcurrency?: number; ops?: string[] }>({ maxRounds: 10, noImproveRounds: 3, strategy: "manual", multiBranch: true, scoringConcurrency: 2, ops: [] });
  // ── 多路径优化（设计草案：用户配置驱动的多路径意图优化框架）──
  // optCfg 为 null = 未启用多路径（单线图谱优化，旧行为）。启用时按能力注册表
  // 组装 routes；requires_setup/reserved 项展示但禁选并给原因，不冒充可执行。
  const [optCapabilities, setOptCapabilities] = useState<OptimizationCapabilities | null>(null);
  const [optEnabled, setOptEnabled] = useState(true);
  const [optTargets, setOptTargets] = useState<string[]>(["graph", "recognition_prompt", "engine"]);
  const [optDecisionMode,setOptDecisionMode]=useState<'model'|'rules'|'agent'>('model');
  const [optModelBudget,setOptModelBudget]=useState({maxModelCalls:32,maxProbeCalls:40});
  const [optMethods, setOptMethods] = useState<Record<string, string>>({});
  const [optParentPolicy, setOptParentPolicy] = useState<"champion" | "pareto_population">("champion");
  const [optBudget, setOptBudget] = useState<{ maxMetricCalls: number; maxMinutes: number }>({ maxMetricCalls: 120, maxMinutes: 60 });
  // 业务目标模板（codex 10-18 P1①）：选择后给推荐配置，全部可改；null=未选择
  const [goalTpl, setGoalTpl] = useState<GoalTemplate | null>(null);
  const sseRef = useRef<{ close: () => void } | null>(null);
  // ── 多分支进化实时状态 ──
  const [mbBranches, setMbBranches] = useState<BranchInfo[] | null>(null);
  const [mbPopulation, setMbPopulation] = useState<string[] | null>(null);
  const [mbChampion, setMbChampion] = useState<string | null>(null);
  const staleRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // ── 图谱选择 ──
  // 初始视图由任务列表传入（进入哪个任务就显示哪个），页内仍可切换
  const graphKey = initialGraphKey;

  const refresh = useCallback(async () => {
    try {
      const r = await rsiRequest<{ state: RsiState }>("/state");
      setState(r.state);
      if (r.state.taskName) onTaskName?.(r.state.taskName === taskId ? "识别优化任务" : r.state.taskName);
      setLoadError("");
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [rsiRequest, onTaskName]);

  useEffect(() => () => { sseRef.current?.close(); if (pollRef.current) clearInterval(pollRef.current); if (staleRef.current) clearInterval(staleRef.current); }, []);
  useEffect(() => {
    if (!evolveConfigOpen) return;
    let active = true;
    const timer = setTimeout(() => {
      setPreflight(null); setPreflightBusy(true);
      rsiRequest<{ ready: boolean; blockers: string[]; warnings: string[]; summary?: Record<string, unknown> }>('/preflight', { optimization: buildOptimizationPayload(), ops:evolveCfg.ops }).then(r => { if (active) setPreflight(r); }).catch(e => { if (active) setPreflight({ ready: false, blockers: [e.message], warnings: [] }); }).finally(() => { if (active) setPreflightBusy(false); });
    }, 400);
    return () => { active = false; clearTimeout(timer); };
  }, [evolveConfigOpen,rsiRequest,optDecisionMode,optEnabled,optTargets,optParentPolicy,optBudget,optModelBudget,optMethods,evolveCfg.ops]);

  // Production runs own their snapshots. Legacy state.branches can belong to an older experiment.
  useEffect(() => {
    const run = state?.activeEvolution || state?.evolveRuns?.at(-1);
    if (!run?.branches) return;
    setMbBranches(Object.values(run.branches).map(b => ({ ...b, createdAt: b.createdAt || run.at,
      scores: b.fullScores || null })));
    setMbPopulation(run.population || []);
    setMbChampion(run.champion || null);
    // 事件流兜底：SSE 只活在发起页，刷新/新开页面后从持久化 run 记录合成，不吞掉实时流
    setAutoEvolveSteps(prev => prev.length ? prev : synthesizeRunSteps(run));
  }, [state]);

  useEffect(() => {
    refresh();
    rsiRequest<BasesInfo>("/bases").then(setBases).catch(() => {});
    // 能力注册表：启动弹窗的可选路径/方法与禁选原因（reserved/requires_setup）都来自它
    rsiRequest<{ data: OptimizationCapabilities }>("/optimization-capabilities").then(r => setOptCapabilities(r.data)).catch(() => {});
  }, [refresh]);

  // 资产谱系：延迟到运行记录标签页激活时才加载（首屏非必需，减少初始请求数）
  useEffect(() => {
    if (section !== 'runs') return;
    rsiRequest<AssetLineage>("/asset-lineage").then(setLineage).catch(() => {});
  }, [section, rsiRequest]);

  // 统一轮询调度器：空闲态 15s / 进化运行 3s / 校准运行 3s
  // 自动进化运行中有专用 3s 轮询（startAutoEvolve 内），此处跳过避免重复拉取
  useEffect(() => {
    if (autoEvolveRunning) return;
    const interval = state?.evolveRunning || state?.calibration?.status === "running" ? 3000 : 15000;
    const t = setInterval(refresh, interval);
    return () => clearInterval(t);
  }, [autoEvolveRunning, state?.evolveRunning, state?.calibration?.status, refresh]);

  const wrap = async (key: string, fn: () => Promise<string>) => {
    if (busy) return;
    setBusy(key);
    try {
      const msg = await fn();
      await refresh();
      if (msg) message.success(msg);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const runBaseline = () => wrap("baseline", async () => {
    const r = await rsiRequest<{ baseline: NonNullable<RsiState["baseline"]> }>("/baseline", {});
    return `测试完成：完全正确率 ${r.baseline.scores.all.strict_pct}% / 部分得分率 ${r.baseline.scores.all.relaxed_pct}%`;
  });

  const runFinalExam = () => wrap("finalexam", async () => {
    const r = await rsiRequest<{ finalExam: { version: string; scores: { strict_pct: number; relaxed_pct: number }; runCount: number } }>("/final-exam", {});
    return `最终验收完成：完全正确率 ${r.finalExam.scores.strict_pct}% / 部分得分率 ${r.finalExam.scores.relaxed_pct}%（第 ${r.finalExam.runCount} 次测试）`;
  });

  const runPropose = () => setEvolveConfigOpen(true);

  const evaluateAll = () => wrap("evalall", async () => {
    const pending = (state?.archive || []).filter((p) => p.status === "proposed");
    if (!pending.length) { message.info("没有待验证的方案"); return ""; }
    let passed = 0;
    for (const p of pending) {
      const r = await rsiRequest<{ entry: RsiState["archive"][number] }>("/evaluate-proposal", { id: p.id });
      if (r.entry.status === "passed") passed += 1;
    }
    return `验证完成：${passed}/${pending.length} 个方案前三关通过，过「引擎复核」后可采纳`;
  });

  const evaluateOne = (id: string) => wrap(`eval-${id}`, async () => {
    const r = await rsiRequest<{ entry: RsiState["archive"][number] }>("/evaluate-proposal", { id });
    return r.entry.status === "passed" ? "前三关通过——还要过「引擎复核」才能采纳" : `验证未通过（${GATE_NAME[r.entry.gate?.stage || ""] || r.entry.gate?.stage}）`;
  });

  const verifyEngine = (p: RsiState["archive"][number]) => wrap(`eng-${p.id}`, async () => {
    // 后端 evaluate() 返回 engineCheck: { ok, engineRev, candidateHash, baseAssetHash }——
    // 曾误读不存在的 current/draft.strict_pct 字段导致复核成功也显示 undefined%（评审 F03）
    const r = await rsiRequest<{ entry: { engineCheck: { ok: boolean; engineRev?: { engineSha: string; protoRev: number; engineMode: string } | null } | null } }>("/verify-engine", { id: p.id });
    return r.entry.engineCheck?.ok
      ? `第四关通过：生产引擎复核确认无回退（${engineRevShort(r.entry.engineCheck.engineRev) || "同口径"}）`
      : "第四关未通过：生产引擎复核发现回退或异常，方案已拦截";
  });

  const adopt = (p: RsiState["archive"][number]) => wrap(`adopt-${p.id}`, async () => {
    const r = await rsiRequest<{ currentVersion: string }>("/adopt", { id: p.id });
    return `已采纳生效为 ${r.currentVersion}，建议点「测试当前水平」看整体变化`;
  });

  const reject = (p: RsiState["archive"][number]) => wrap(`reject-${p.id}`, async () => {
    await rsiRequest("/reject", { id: p.id });
    return "已拒绝该方案";
  });

  const reset = () => wrap("reset", async () => {
    await rsiRequest("/reset", {});
    return "已清空重来（实验对象与题库保留）";
  });

  const runCalibrate = () => wrap("calibrate", async () => {
    await rsiRequest("/calibrate", {});
    setTimeout(refresh, 1500);
    return "已启动生产引擎对照打分（离线确定性运行），完成后自动显示结果";
  });

  const rollback = (version: string) => wrap(`rollback-${version}`, async () => {
    await rsiRequest("/rollback", { toVersion: version });
    return `已回滚到 ${version}，请点「测试当前水平」重新测试`;
  });

  // ── prompt 层 RSI：优化/应用/拒绝提案器指令候选稿 ──
  // 评审 F02：后端未接入 MemberOptimizer（rsi-agent 未部署），后端现返回 501 明确说明；
  // 前端把错误透传给用户，不再出现来历不明的 404
  const promptOptimize = () => wrap("prompt-opt", async () => {
    const r = await rsiRequest<{ status: string; reason?: string; detail?: string; error?: string; candidate?: NonNullable<RsiState["promptCandidates"]>[number] }>("/prompt-optimize", { skill: "propose" });
    if (r.status === "ok" && r.candidate) return `优化完成（${r.candidate.elapsedSec ?? "?"}s，动因 ${r.candidate.issuesCount} 条）：在下方候选稿审阅，认可后点「应用」`;
    if (r.status === "running") return "已有一次优化在进行中，稍候刷新查看";
    return r.reason || r.detail || r.error || "本轮无可优化信号：先跑几轮进化积累反馈再试";
  }).catch(() => { /* wrap 已 toast 错误信息，这里只防未捕获 reject */ });

  const promptApply = (id: string) => wrap(`papply-${id}`, async () => {
    await rsiRequest("/prompt-apply", { id });
    return "已应用：此后每轮「AI 提改进方案」都使用这份新指令";
  });

  const promptReject = (id: string) => wrap(`preject-${id}`, async () => {
    await rsiRequest("/prompt-reject", { id });
    return "已拒绝该候选稿";
  });

  const basesRefresh = useCallback(async () => {
    try {
      const r = await rsiRequest<{ current: RsiState["baseGraph"]; casesCount: number; snapshots: { id: string; label: string; intents: number }[]; manifestActive: string | null }>("/bases");
      setBases(r);
    } catch { /* 轨道信息加载失败不阻塞主面板 */ }
  }, []);

  const importSnapshot = (versionId?: string) => wrap("import", async () => {
    const r = await rsiRequest<{ snapshot: { id: string; intents: number }; next: string }>("/import-snapshot", versionId ? { versionId } : {});
    await basesRefresh();
    return `已导入线上图谱副本「${r.snapshot.id}」（${r.snapshot.intents} 个意图）。${r.next}`;
  });

  const genCases = (count: number) => {
    // 破坏性操作警示（评审阶段 B）：gen-cases 会 makeFreshState 重开实验——
    // 版本链/候选档案/成绩历史全部清空，此前静默重开，用户不知情
    const hasHistory = (state?.versions?.length ?? 0) > 1 || (state?.archive?.length ?? 0) > 0 || (state?.evolveRuns?.length ?? 0) > 0;
    const doGen = () => wrap("gencases", async () => {
      const isSnap = state?.baseGraph?.kind === "snapshot";
      const base = isSnap ? `snapshot:${state?.baseGraph?.id}` : undefined;
      const r = await rsiRequest<{ added: number; rejectedCount: number; total: number }>("/gen-cases", base ? { base, count } : { count });
      await basesRefresh();
      return `AI 补充 ${r.added} 道测试题（淘汰 ${r.rejectedCount} 道不合格），题库共 ${r.total} 条，实验已重开`;
    });
    if (hasHistory) {
      Modal.confirm({
        title: "补充测试题将重开本次实验",
        content: "出题会重置版本链、候选方案与成绩历史（题库指纹防作弊机制的一部分）。当前实验记录将不可恢复，确定继续？",
        okText: "继续出题", cancelText: "取消",
        onOk: doGen,
      });
    } else {
      doGen();
    }
  };

  const switchBase = (base: string, label: string) => wrap(`switch-${base}`, async () => {
    await rsiRequest("/switch-base", { base });
    await basesRefresh();
    return `已切换到${label}，实验已重开`;
  });

  const onFlowAction = useCallback((key: string) => {
    if (key === "baseline") runBaseline();
    else if (key === "propose") setEvolveConfigOpen(true);
    else if (key === "evalall") evaluateAll();
    else if (key === "gencases") genCases(state?.baseGraph?.kind === "snapshot" ? 30 : 60);
    else if (key === "auto-evolve") setEvolveConfigOpen(true);
    // 待审阅入口：跳到「改进方案」标签页——此前这里只给纯文字"可在下方审阅"，
    // 而候选表在另一个标签页，首页徽标「N 待审阅」点进来根本找不到审阅采纳处（用户实测反馈）
    else if (key === "review") chooseSection("candidates");
  }, [state, busy]);

  // ── 自动进化 ──
  // 多路径配置组装：optEnabled 时按用户选择的 targets 生成 routes（每路径的方法
  // 默认取能力注册表该 target 的首个 ready 方法）。预算/父策略随配置下发，
  // 后端 normalizeOptimizationConfig 会再做一次硬校验（不支持的组合启动前拒绝）。
  const buildOptimizationPayload = (): Record<string, unknown> | null => {
    const targets=optEnabled?optTargets:['graph'];
    const methods: Record<string, string> = {};
    for (const t of targets) {
      const ready = (optCapabilities?.targets[t]?.methods || []).filter(m => optCapabilities?.methods[m]?.status === "ready");
      methods[t] = optMethods[t] && ready.includes(optMethods[t]) ? optMethods[t] : t==='engine'?'parameter_search':ready[0] || "reflective_search";
    }
    // schema:1 与后端 normalizeOptimizationConfig 输出同构；SSE 入口按
    // opts.optimization.schema 判定"是否启用多路径"，缺了会被当成单线图谱
    return { schema: 1, targets, decisionMode:optDecisionMode, methods, parentPolicy: optParentPolicy, allowMerge: false, budget: {...optBudget,...optModelBudget} };
  };

  const startAutoEvolve = async (cfg: { maxRounds: number; noImproveRounds: number; strategy: string; multiBranch: boolean; scoringConcurrency?: number; ops?: string[] }, resumeRunId?: string) => {
    if (autoEvolveRunning) return;
    if (!resumeRunId) {
      try {
        const check = await rsiRequest<{ ready: boolean; blockers: string[]; warnings: string[] }>('/preflight', { optimization:buildOptimizationPayload(),ops:cfg.ops });
        setPreflight(check);
        if (!check.ready) { message.error(check.blockers.join('；') || '启动预检未通过'); return; }
      } catch (e) { message.error((e as Error).message); return; }
    }
    const optimization = buildOptimizationPayload();
    if (optEnabled && !optTargets.length) {
      message.warning("已启用多路径优化但未选择任何路径——请至少勾选一条，或关闭多路径开关");
      return;
    }
    setEvolveConfigOpen(false);
    setEvolveModalOpen(true);
    setSseStale(false);
    setAutoEvolveSteps([{ step: "start", round: 0, detail: "正在启动自动进化…" }]);
    setAutoEvolveRunning(true);
    setMbBranches(null);
    setMbPopulation(null);
    setMbChampion(null);
    // 心跳看门狗：服务端 15s 一跳；>90s 无任何事件判定连接可疑（但服务端仍在跑）
    let lastEvent = Date.now();
    let terminal = false;
    const staleTimer = setInterval(() => {
      if (Date.now() - lastEvent > 90000) setSseStale(true);
    }, 5000);
    staleRef.current = staleTimer;
    // 进化进行中轮询 state：主页 3 图（进化树/精度趋势/题型）实时刷新 + 多分支树同步
    if (pollRef.current === null) {
      pollRef.current = setInterval(async () => {
        try {
          const r = await rsiRequest<{ state: RsiState }>("/state");
          setState(r.state); // 主页图表实时跟进（新分支/新成绩/新版本）
        } catch { /* 轮询失败不阻塞 */ }
      }, 3000);
    }
    const finish = () => {
      clearInterval(staleTimer); staleRef.current = null;
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      setAutoEvolveRunning(false);
      sseRef.current = null;
      refresh();
      // 最后再拉一次 state 确保图表是终态
      rsiRequest<{ state: RsiState }>("/state").then(r => {
        setState(r.state);
      }).catch(() => {});
    };
    sseRef.current = rsiAutoEvolveSSE(
      { ...cfg, taskId, commandId: globalThis.crypto?.randomUUID?.() || `command-${Date.now()}`, ...(resumeRunId ? { runId: resumeRunId } : {}), budget: optBudget, ...optBudget, multiBranch: cfg.multiBranch || !!optimization, optimization },
      (data) => {
        lastEvent = Date.now();
        setSseStale(false);
        if (typeof data.runId === 'string') setRunUrl(data.runId);
        if (data.step === 'heartbeat') return;
        setAutoEvolveSteps(prev => [...prev.slice(-999), data]);
        if (data.step === "complete" || data.step === "error" || data.step === "stopped") {
          terminal = true;
          finish();
          if (data.step === "complete") {
            message.success(data.detail);
          } else if (data.step === "error") {
            message.error(data.detail);
          }
        }
      },
      (msg) => {
        finish();
        setSseStale(true);
        message.error(`实时连接已中断：${msg}。服务端状态将继续轮询，请勿重复启动。`);
      },
      () => {
        if (!terminal) setSseStale(true);
        finish();
      },
    );
  };

  const stopAutoEvolve = () => {
    rsiRequest('/auto-evolve-stop', { runId: state?.activeEvolution?.id || new URLSearchParams(window.location.search).get('runId') }).then(() => { message.info('已请求停止，等待服务端保存检查点'); refresh(); }).catch(e => message.error(e.message));
  };

  // ── 图谱选择器（多个图谱共用 RSI 实验台入口） ──
  // 这是"视图开关"不是"实验对象开关"：实际迭代对象由 state.baseGraph 决定（工具条下方
  // 有实名牌）。旧文案「进化沙盒（演示图谱）」在真子图轨道上是撒谎（10-14 审计）
  const graphSelector = initialGraphKey === 'park' ? <Tag>园区引擎调参记录 · 只读</Tag> : null;

  // 园区意图图谱：独立引擎精度曲线 + 校准
  if (graphKey === "park") {
    return (
      <div>
        <Toolbar extra={graphSelector} />
        <RsiParkTrajectory />
      </div>
    );
  }

  if (loadError) {
    return (
      <div>
        <Toolbar extra={graphSelector} />
        <Alert type="error" showIcon message="实验台加载失败" description={`${loadError}（请确认 graph-builder 服务在运行）`} />
      </div>
    );
  }
  if (!state) return (
    <div>
      <Toolbar extra={graphSelector} />
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 12, padding: "72px 0", color: COLOR.textTertiary }}>
        <Spin />
        <Typography.Text type="secondary" style={{ fontSize: TYPE.body }}>正在加载实验台…</Typography.Text>
      </div>
    </div>
  );

  const b = state.baseline;
  // freshness 双判（10-15 审核 P1）：图谱升级（版本）或引擎口径变更（指纹）都让旧基线
  // 失去"当前水平"资格——此前只比版本，引擎变更后旧分数会被当成当前水平展示
  const currentEngineRev = state.currentEngineRev ?? b?.engineRev ?? null;
  const baselineCurrent = state.scoreValidity?.current !== false && state.scoreValidity?.valid !== false && !!b && !b.stale && b.version === state.currentVersion
    && !(state.scoreHistory || []).some((h) => h.engineRev && currentEngineRev
      && (h.engineRev.engineSha !== currentEngineRev.engineSha || h.engineRev.protoRev !== currentEngineRev.protoRev || h.engineRev.engineMode !== currentEngineRev.engineMode)
      && h.at > b.at);
  const passedCount = state.archive.filter((p) => canAdopt(p, { currentVersion: state.currentVersion, currentEngineRev, baselineFresh: baselineCurrent }).ok).length;
  // passed 但证据过期（不能直接采纳，需重测）——用于「待审阅方案」卡的数字拆解，避免"1 待审阅"却无一个能采纳的误导
  const passedStaleCount = state.archive.filter((p) => p.status === "passed" && !canAdopt(p, { currentVersion: state.currentVersion, currentEngineRev, baselineFresh: baselineCurrent }).ok).length;
  // 在途方案 = proposed（待验证）+ passed（待处置）：gated 是门禁淘汰的死方案，不是"进行中"
  // （10-17 概览页复审 P0：此前把 gated 算进 activeCount，24 个已淘汰方案被显示为"进行中 25 个"）
  const activeCount = state.archive.filter((p) => p.status === "proposed" || p.status === "passed").length;
  const adoptedCount = state.archive.filter((p) => p.status === "adopted").length;
  const gatedCount = state.archive.filter((p) => p.status === "gated" || p.status === "rejected").length;
  const caseCount = state.split.trainCount + state.split.heldoutCount + (state.split.testCount || 0);
  // 后端能力标记：rev<4 = 容器里还是旧代码（host-mount 改文件不重启不生效）
  const backendStale = (state.rev ?? 1) < 4;
  const testCount = state.split.testCount ?? 0;
  const fe = state.finalExam && state.finalExam.history.length ? state.finalExam.history[state.finalExam.history.length - 1] : null;
  const rounds = state.stats.proposeRuns;
  // 运行状态三分（10-15 前端一致性审核 P0）：evolveRunning=任务真的在跑；
  // archive 有 proposed/passed 只说明「有待处置的方案」，不等于任务运行中。
  // 此前把 passed 也算进 roundInProgress，出现「无任务却显示进行中」的误导。
  const pendingReviewCount = state.archive.filter((p) => p.status === "proposed" || p.status === "passed").length;
  const roundLabel = state.evolveRunning
    ? `自动进化运行中 · 已出 ${rounds} 次方案`
    : state.activeEvolution?.status === "stopped" ? "已停止 · 检查点已保存" : state.activeEvolution?.status === "interrupted" ? "运行中断 · 可从检查点恢复"
    : pendingReviewCount > 0
      ? `空闲 · ${pendingReviewCount} 个方案待处置`
      : rounds > 0
        ? `空闲 · 已出 ${rounds} 次方案`
        : "空闲 · 准备第 1 轮";
  // v1 初始版本 + 无方案 + 无成绩 = 全新实验（versions 恒含 v1 条目，旧条件 length===0 永假，
  // 导致空态引导永远不出现）。10-14 补：还要看历史活动——回滚/采纳后基线为空是常态，
  // 有进化记录或成绩轨迹的实验不是新手，渲染空态引导会把全部进阶功能藏起来
  const isEmpty = !b && state.archive.length === 0 && state.versions.length <= 1
    && (state.evolveRuns || []).length === 0 && (state.scoreHistory || []).length <= 1;
  const recoverableRun = [state.activeEvolution, ...[...(state.evolveRuns || [])].reverse()].find(r => r?.checkpoint?.available === true && ['stopped', 'error', 'interrupted'].includes(r.status || ''));

  // 首屏三个读数所需的派生值
  const heldNow = b?.scores.heldout;
  // 校准对照过期（10-15 审核 P1）：stale 时不能拿旧一致率当当前可靠性展示
  const calibrationPct = state.calibration.stale ? null : state.calibration.report?.agreement.overallPct;
  const calibrationLow = calibrationPct != null && calibrationPct < 60;

  const calibrationRunning = state.calibration.status === "running";

  return (
    <div>
      <Toolbar extra={graphSelector} />
      <Typography.Paragraph type="secondary">业务图谱：{state.baseGraph.label} · 当前实验版本 {state.currentVersion} · 共 {caseCount} 道评测题目 · <Typography.Link href="/tools/intent-rsi-lab.html" target="_blank">打开 V1 实验台（规则模式，原始 API 视图）</Typography.Link></Typography.Paragraph>
      <Tabs activeKey={section} onChange={chooseSection} items={[{ key: 'overview', label: '任务概览' }, { key: 'runs', label: '运行记录' }, { key: 'candidates', label: '改进方案' }, { key: 'data', label: '评测题目' }, { key: 'results', label: '成果与交付' }, { key: 'settings', label: '设置' }]} />
      {section === 'overview' && <>
      <RsiTaskOverview state={state} baselineCurrent={baselineCurrent} pendingCount={pendingReviewCount} adoptableCount={passedCount} busy={busy} onAction={onFlowAction} onSection={chooseSection} />
      <RsiEvolveRuns runs={state.evolveRuns} />
      </>}
      {section === 'runs' && <>
        {/* 运行中把版面让给实时种群视图（摘要在下方主区块），推理长文挪到其后；空闲时保持原顺序 */}
        {!state.evolveRunning && <RsiReasoningReview runs={[...(state.evolveRuns||[]),...(state.activeEvolution?[state.activeEvolution]:[])]} />}
        {(sseStale || state.activeEvolution?.status === 'error' || state.activeEvolution?.status === 'interrupted') && <Alert showIcon type="warning" style={{marginBottom:16}} message={state.evolveRunning ? '实时连接中断，任务仍在后台运行' : '最近一次运行未正常结束'} description="进度以服务端保存的记录为准。查看运行记录确认原因后再继续，刷新页面不会自动启动新任务。" />}
        {recoverableRun?.id && !state.evolveRunning && <Alert type="info" showIcon style={{marginBottom:16}} message="已保存可恢复的运行进度" description="恢复会继续消耗评测与模型预算。若题目、版本或评测方式已变化，系统会阻止续跑并说明原因。" action={<Button onClick={() => startAutoEvolve(evolveCfg, recoverableRun.id ?? undefined)}>从检查点恢复</Button>} />}
        {state.evolveRunning && <Alert type="info" showIcon style={{marginBottom:16}} message="任务正在运行，进度会自动刷新" action={<Button danger onClick={stopAutoEvolve}>停止运行</Button>} />}
        {!state.evolveRunning && <Button style={{marginBottom:16}} onClick={()=>setEvolveConfigOpen(true)} disabled={!!busy || backendStale}>配置新一轮优化</Button>}
      </>}
      {section === 'results' && <Card title="冻结成果与终测证据" style={{ marginBottom: 20 }}><Typography.Paragraph>导出包含当前版本资产、评测上下文与已保存的终测证据。{!testCount ? '此任务无独立 test 集，不能宣称独立泛化提升。' : !fe ? '尚无终测证据，请先到评测题目完成终审。' : `已保存终测 ${state.finalExam?.runCount} 次。`}</Typography.Paragraph><Alert showIcon type="info" style={{ marginBottom: 12 }} message="导出的是实验资产与证据，不代表已发布上线" description="采纳只更新本任务的实验副本；把成果用到生产图谱属于目标环境的独立发布流程（含审批与回滚），本工具不代替这一步。" /><Button icon={<CloudDownloadOutlined />} disabled={optCapabilities?.features?.export !== true} loading={busy === 'export'} onClick={() => wrap('export', async () => { const r = await rsiRequest<{ bundle: unknown; downloadName?: string }>('/export'); const url = URL.createObjectURL(new Blob([JSON.stringify(r.bundle, null, 2)], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = r.downloadName || `${taskId}-${state.currentVersion}.json`; a.click(); URL.revokeObjectURL(url); return '已导出冻结成果'; })}>导出资产与证据</Button>{optCapabilities?.features?.export !== true && <Typography.Text type="secondary"> 导出能力尚未确认可用</Typography.Text>}</Card>}
      {backendStale && <Alert style={{marginBottom:16}} type="error" showIcon message="当前服务版本暂不支持优化运行" description="请联系服务维护者更新服务。任务记录仍可查看。" />}
      {section !== 'overview' && (state.attribution?.stale || state.integrity.drift || !baselineCurrent || engineBreakPoints(state.scoreHistory||[]).size > 0) && <Collapse style={{marginBottom:16}} items={[{key:'evidence-notes',label:'评测证据与可比性说明',children:<Space direction="vertical">
        {!baselineCurrent && <Typography.Text>当前识别效果尚无有效评测。{state.scoreValidity?.reason || '请先在概览页重新评测当前版本，再比较改善与退化。'}</Typography.Text>}
        {state.attribution?.stale && <Typography.Text>历史错误分析已过期，下一轮优化将重新分析。</Typography.Text>}
        {state.integrity.drift && <Typography.Text>题目文件发生外部变化，请到评测题目页检查数据后再继续。</Typography.Text>}
        {engineBreakPoints(state.scoreHistory||[]).size > 0 && <Typography.Text>历史记录存在评测方式变更，变更前后的分数不能直接比较；运行图中保留了对应标记。</Typography.Text>}
      </Space>}]} />}

      {/* ── 自动进化配置弹窗 ── */}
      <Modal
        title="配置新一轮优化"
        open={evolveConfigOpen}
        onCancel={() => setEvolveConfigOpen(false)}
        footer={null}
        width={600}
      >
        <Space direction="vertical" style={{ width: "100%" }} size={12}>
          {/* ── 业务目标模板（codex 10-18 复审 P1①）：业务说法→可解释推荐配置，全部可改 ── */}
          <div>
            <Typography.Text strong>这轮优化主要想解决什么？</Typography.Text>
            <Select
              value={goalTpl?.id}
              onChange={(v: string) => {
                const tpl = goalTemplateById(v);
                setGoalTpl(tpl);
                if (tpl) {
                  const rec = applyGoalTemplate(tpl, evolveCfg);
                  setEvolveCfg(c => ({ ...c, ...rec }));
                  if (rec.ops.length) message.info(`已按目标推荐优化算子与收敛轮数，可在下方修改`);
                }
              }}
              allowClear
              placeholder="选择业务目标（可选：选了会给推荐配置）"
              style={{ width: "100%", marginTop: 4 }}
              aria-label="业务目标模板"
              options={GOAL_TEMPLATES.map(t => ({ value: t.id, label: t.label }))}
            />
            {goalTpl && <Alert type="info" showIcon={false} style={{ marginTop: 8 }} message={<div style={{ display: 'grid', gap: 4 }}>
              <div>{goalTpl.explanation}</div>
              <div><Typography.Text type="secondary" style={{ fontSize: TYPE.small }}>对题目的要求：{goalTpl.caseNote}</Typography.Text></div>
              <div><Typography.Text type="secondary" style={{ fontSize: TYPE.small }}>效果在哪儿看：{goalTpl.whereToLook}</Typography.Text></div>
            </div>} />}
          </div>
          <div>
            <Typography.Text strong>决策方式</Typography.Text>
            <Select aria-label="决策方式" value={optDecisionMode} onChange={setOptDecisionMode} style={{width:'100%'}} options={[
              {value:'agent',label:'Agent 自迭代（推荐）：rsi-agent 框架调度调研工具与反事实探针，产出已验证提案'},
              {value:'model',label:'模型诊断 → 实验规划 → 训练探针 → 复盘调整'},{value:'rules',label:'规则搜索：固定路径生成，不使用模型规划与复盘'}]} />
            {optDecisionMode==='agent'&&!optCapabilities?.features?.agent&&<Alert type="warning" showIcon style={{marginTop:8}} message="rsi-agent 服务不可用，启动将失败；请先部署 rsi-agent 或改用其他决策方式" />}
            <Typography.Text strong>采纳策略</Typography.Text>
            <Select
              value={evolveCfg.strategy}
              onChange={(v) => setEvolveCfg(c => ({ ...c, strategy: v }))}
              style={{ width: "100%", marginTop: 4 }}
              aria-label="采纳策略"
              options={[
                { value: "manual", label: "人工审阅后采纳（推荐）" },
                { value: "best", label: "结束后自动采纳通过验证的最佳方案" },
                { value: "all", label: "整批采纳未启用：不能逐项验证组合效果", disabled: true },
              ]}
            />
          </div>
          <div style={{ display: "flex", gap: 12 }}>
            <div style={{ flex: 1 }}>
              <Typography.Text strong>最多轮数</Typography.Text>
              <InputNumber min={1} max={20} value={evolveCfg.maxRounds} onChange={(v) => setEvolveCfg(c => ({ ...c, maxRounds: v || 10 }))} style={{ width: "100%", marginTop: 4 }} aria-label="最多轮数" />
            </div>
            <div style={{ flex: 1 }}>
              <Typography.Text strong>连续几轮没进步就停止</Typography.Text>
              <InputNumber min={1} max={5} value={evolveCfg.noImproveRounds} onChange={(v) => setEvolveCfg(c => ({ ...c, noImproveRounds: v || 3 }))} style={{ width: "100%", marginTop: 4 }} aria-label="连续无提升收敛轮数" />
            </div>
          </div>
          {/* 预算预设（codex 10-18：想的是"试一试/认真跑/深度搜"，不是抽象数字） */}
          <div>
            <Typography.Text strong>这轮打算跑多大规模？</Typography.Text>
            <Select
              value={matchBudgetPreset(optBudget.maxMetricCalls, optBudget.maxMinutes)}
              onChange={(v: string) => {
                const p = BUDGET_PRESETS.find(x => x.id === v);
                if (p) { setOptBudget({ maxMetricCalls: p.maxMetricCalls, maxMinutes: p.maxMinutes }); message.info(`已按「${p.label}」填充预算，可在下方微调`); }
              }}
              allowClear
              placeholder="选择预算档位（可选）"
              style={{ width: "100%", marginTop: 4 }}
              aria-label="评测预算预设"
              options={BUDGET_PRESETS.map(p => ({ value: p.id, label: p.label }))}
            />
            {(() => { const p = BUDGET_PRESETS.find(x => x.id === matchBudgetPreset(optBudget.maxMetricCalls, optBudget.maxMinutes));
              return p ? <Typography.Text type="secondary" style={{ fontSize: TYPE.small, display: 'block', marginTop: 4 }}>{p.explanation}</Typography.Text> : null; })()}
          </div>
          <Space wrap><label>评测预算 <InputNumber aria-label="总评测预算次数" min={2} max={10000} value={optBudget.maxMetricCalls} onChange={v => setOptBudget(b => ({ ...b, maxMetricCalls: v || 120 }))} /></label><label>时间预算（分钟）<InputNumber aria-label="总时间预算分钟" min={1} max={1440} value={optBudget.maxMinutes} onChange={v => setOptBudget(b => ({ ...b, maxMinutes: v || 60 }))} /></label></Space>
          {optDecisionMode==='model'&&<><Space wrap><label>模型请求上限 <InputNumber aria-label="模型请求上限" min={1} max={1000} value={optModelBudget.maxModelCalls} onChange={v=>setOptModelBudget(b=>({...b,maxModelCalls:v||32}))}/></label><label>训练探针上限 <InputNumber aria-label="训练探针上限" min={1} max={1000} value={optModelBudget.maxProbeCalls} onChange={v=>setOptModelBudget(b=>({...b,maxProbeCalls:v||40}))}/></label></Space><Typography.Text type="secondary">模型在允许范围内设计实验，每次探针最多8道训练题；探针有收益后才进行完整评测。模型、探针、完整评测和时间分别受上限约束；费用按实际服务计费。</Typography.Text></>}
          <Typography.Text type="secondary">每次评测预算指对一份候选进行完整评测，不是单题数量或费用上限。运行会调用模型服务，实际费用取决于服务计费。</Typography.Text>
          <details style={{width:"100%"}}><summary style={{cursor:"pointer",fontWeight:600,padding:"8px 0"}}>高级优化设置（默认推荐）</summary>
          <div>
            <Typography.Text strong>评测速度</Typography.Text>
            <Select aria-label="题目评测并发数" value={evolveCfg.scoringConcurrency || 1} onChange={v => setEvolveCfg(c => ({ ...c, scoringConcurrency: v }))}
              style={{ width: '100%', marginTop: 4 }} options={[{ value: 1, label: '串行 · 基准测量 / 接口限流时使用' }, { value: 2, label: '2 题并发 · 平衡速度与服务压力（推荐）' }, { value: 4, label: '4 题并发 · 需模型服务有足够容量' }]} />
            <Typography.Text type="secondary" style={{ fontSize: TYPE.small }}>不减少评测题或验证关卡。并发耗时受服务限流影响；不同并发下的延迟不直接比较。</Typography.Text>
          </div>
          <Typography.Text type="secondary" style={{ fontSize: TYPE.small }}>
            {evolveCfg.strategy === "manual"
              ? "manual：实验内连续多代变异与收敛，结束后等你采纳，不自动修改正式版本。"
              : evolveCfg.strategy === "best"
                ? "best：按训练指标选择冠军，验证题只作回退否决；实验结束后仅采纳最终确有训练提升的完整候选。"
                : "all：一轮内全部过门禁的方案都会被采纳。多个方案各自只对同一份改前成绩验证过，组合效果要等轮末重考才知道。"}
          </Typography.Text>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0" }}>
            <Switch checked disabled aria-label="多分支种群进化" />
            <div>
              <Typography.Text strong>多分支种群进化</Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: TYPE.small, display: "block" }}>
                每代从父代生成候选，筛选后收敛为下一代输入；没有可靠改善时保留父代，不虚增正式版本。候选依次评测，每份候选内的题目按上方设置限流并发。
              </Typography.Text>
            </div>
          </div>
          {/* ── 多路径优化配置（启动前选择并冻结；不支持项禁选给原因，不冒充可执行）── */}
          <div style={{ borderTop: `1px dashed ${COLOR.gridLine}`, paddingTop: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0 8px" }}>
              <Switch disabled={!optCapabilities} checked={optEnabled} onChange={(v) => { setOptEnabled(v); if (v && !optCapabilities) message.warning("能力注册表未加载——路径选项可能不全，可在关闭后重试"); }} aria-label="多路径优化" />
              <div>
                <Typography.Text strong>多路径优化</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: TYPE.small, display: "block" }}>
                  选择允许修改的范围。模型依据训练证据决定本代实际探索哪些路径；不会强制每条路径都生成候选。关闭后仅允许图谱改动。提案器指令单独记录为搜索策略，不直接产生新识别精度。
                </Typography.Text>
              </div>
            </div>
            {optEnabled && (
              <Space direction="vertical" style={{ width: "100%" }} size={10}>
                <div>
                  <Typography.Text strong style={{ fontSize: TYPE.small }}>允许模型修改的范围</Typography.Text>
                  <Select
                    mode="multiple"
                    allowClear
                    placeholder="选择本轮要优化的对象"
                    value={optTargets}
                    onChange={(v) => setOptTargets(v.length ? v : ["graph"])}
                    style={{ width: "100%", marginTop: 4 }}
                    aria-label="优化路径选择"
                    maxTagCount="responsive"
                    options={Object.entries(optCapabilities?.targets || {}).map(([k, t]) => ({
                      value: k,
                      label: `${t.label}（${t.status === "ready" ? "可执行" : t.status === "requires_setup" ? "需部署" : "预留"}）`,
                      disabled: t.status !== "ready",
                      title: t.status !== "ready" ? t.reason : undefined,
                    }))}
                  />
                  <Typography.Text type="secondary" style={{ fontSize: TYPE.micro, display: "block", marginTop: 2 }}>
                    引擎代码 / 模型训练为预留能力：适配器未接入，选中会被启动预检拒绝。
                  </Typography.Text>
                </div>
                <div style={{ display: "flex", gap: 12 }}>
                  <div style={{ flex: 1 }}>
                    <Typography.Text strong style={{ fontSize: TYPE.small }}>代际输入策略</Typography.Text>
                    <Select
                      value={optParentPolicy}
                      onChange={setOptParentPolicy}
                      style={{ width: "100%", marginTop: 4 }}
                      aria-label="代际输入策略"
                      options={[
                        { value: "champion", label: "单冠军：每代收敛 1 个最优候选作为下一代输入" },
                        { value: "pareto_population", label: "帕累托池：每代保留非支配候选池作为下一代输入" },
                      ]}
                    />
                  </div>
                </div>
                <Typography.Text type="secondary" style={{ fontSize: TYPE.small }}>
                  每条路径的方法按能力自动选择（图谱=失败轨迹反思、引擎=参数候选搜索）。预算耗尽或超时的候选标记为 budget_skipped，不伪造成绩。GEPA 需正式部署 worker 后才会解锁。
                </Typography.Text>
              </Space>
            )}
          </div>
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <Typography.Text strong>可进化算子</Typography.Text>
              <Typography.Link
                style={{ fontSize: TYPE.micro }}
                onClick={() => setEvolveCfg(c => ({ ...c, ops: OP_OPTIONS.map(o => o.value) }))}
              >
                全选
              </Typography.Link>
              <Typography.Link
                style={{ fontSize: TYPE.micro }}
                onClick={() => setEvolveCfg(c => ({ ...c, ops: [] }))}
              >
                清空（=不限制）
              </Typography.Link>
            </div>
            <Select
              mode="multiple"
              allowClear
              placeholder="不选 = 全部可执行算子（A1-A5）"
              value={evolveCfg.ops}
              onChange={(v) => setEvolveCfg(c => ({ ...c, ops: v }))}
              style={{ width: "100%", marginTop: 4 }}
              aria-label="可进化算子白名单"
              optionFilterProp="label"
              options={OP_OPTIONS}
              maxTagCount="responsive"
            />
            <Typography.Text type="secondary" style={{ fontSize: TYPE.small, display: "block", marginTop: 4 }}>
              限定本轮 AI 只能用选中算子提改进方案（写入提案指令 + 硬校验白名单，越界提案直接拒绝）。按弱点类型选算子能显著提高过门禁率。
            </Typography.Text>
          </div>
          </details>
          <Alert type={preflight?.ready ? 'success' : 'warning'} showIcon message={preflightBusy ? '正在检查任务、题库与执行器…' : preflight?.ready ? '启动预检通过' : '启动前需解决阻塞项'} description={<><div>{preflight?.blockers?.join('；')}{preflight?.warnings?.join('；')}</div><div>本次最多 {evolveCfg.maxRounds} 代；评测预算 {optBudget.maxMetricCalls} 次完整评测；时间预算 {optBudget.maxMinutes} 分钟；{evolveCfg.strategy === 'manual' ? '结束后等待人工采纳' : '结束后仅采纳通过门禁的最终冠军'}。</div></>} />

          <Button type="primary" icon={<ThunderboltFilled />} disabled={preflightBusy || preflight?.ready !== true} loading={autoEvolveRunning} onClick={() => startAutoEvolve(evolveCfg)} block>
            开始优化
          </Button>
        </Space>
      </Modal>

      {/* ── 自动进化进度面板 ── */}
      <Modal
        title={(
          <Space size={8}>
            <ExperimentOutlined style={{ color: COLOR.accent }} />
            自动进化
            {evolveCfg.multiBranch && <Tag color="blue">多分支种群</Tag>}
            {sseStale && autoEvolveRunning && <Tag color="orange">已 90 秒无消息——服务端可能仍在运行（LLM 生成中），可稍等或停止</Tag>}
          </Space>
        )}
        open={evolveModalOpen}
        onCancel={() => setEvolveModalOpen(false)}
        footer={[
          ...(autoEvolveRunning ? [<Button key="stop" danger icon={<StopFilled />} onClick={stopAutoEvolve}>停止进化</Button>] : []),
          <Button key="close" type="primary" onClick={() => setEvolveModalOpen(false)}>{autoEvolveRunning ? "隐藏（后台继续）" : "关闭"}</Button>,
        ]}
        width={evolveCfg.multiBranch ? 960 : 680}
        maskClosable={false}
      >
        {evolveCfg.multiBranch || optEnabled ? (
          <RsiMultiBranchStatus
            steps={autoEvolveSteps}
            branches={mbBranches}
            population={mbPopulation}
            champion={mbChampion}
            running={autoEvolveRunning}
            maxRounds={evolveCfg.maxRounds}
          />
        ) : (
          <div style={{ maxHeight: 420, overflowY: "auto" }}>
            {autoEvolveSteps.map((s, i) => {
              // 步骤色收敛：常规步骤一律中性，只有终态用状态色（完成=绿/错误=红/停止与等待=琥珀）
              const color = s.step === "complete" ? "#0ca30c"
                : s.step === "error" ? COLOR.danger
                : s.step === "stopped" ? COLOR.warning
                : s.step === "converged" ? COLOR.textSecondary
                : s.step.startsWith("awaiting") ? COLOR.warning
                : COLOR.textSecondary;
              return (
                <div key={i} style={{ padding: "8px 0", borderBottom: `1px dashed ${COLOR.gridLine}`, fontSize: TYPE.small, lineHeight: 1.7 }}>
                  <Tag color={color} style={{ marginRight: 8, fontSize: 11 }}>
                    {s.round > 0 ? `R${s.round}` : s.step}
                  </Tag>
                  <Typography.Text style={{ fontSize: TYPE.small, color: COLOR.textPrimary }}>{humanize(s.detail)}</Typography.Text>
                </div>
              );
            })}
            {autoEvolveRunning && (
              <div style={{ textAlign: "center", padding: 16, color: COLOR.textTertiary }}>
                <Typography.Text type="secondary">正在自动进化中…</Typography.Text>
              </div>
            )}
          </div>
        )}
      </Modal>

      {section === "runs" && <div>
      {/* P1② 运行集中摘要：先回答"是否正常、还在做什么"——阶段/候选/预算/耗时/最近活动 */}
      <RsiRunSummaryCard state={state} />

      {/* ══ ③.0 自动进化·多分支种群（实时 + 回顾） ══
          运行中：复用 SSE/轮询注入的 mb* 实时状态；
          运行后：useEffect 从 state.evolveRuns.at(-1) 把 branches/population/champion
                 回填到 mb*（持久化，刷新不丢），所以渲染条件必须同时看 mbBranches，
                 不能只看 state.branches（旧字段，G5 后 /state 不再回填）。
          数据条件：有分支数据 或 正在运行 才展示，避免空态占位。 */}
      {(autoEvolveRunning || state.evolveRunning || (mbBranches && mbBranches.length > 0) || (state.branches && state.branches.length > 0)) && (
        <>
          <SectionTitle hint="一条流水线 + 点线分支树 + 事件流：实时看变异→评测→选择→交叉走到哪一步；运行结束后作为本次进化的回顾视图，悬停分支点查看成绩与淘汰原因。">自动进化 · 多分支种群</SectionTitle>
          <RsiMultiBranchStatus
            steps={autoEvolveSteps}
            branches={mbBranches ?? state.branches ?? null}
            population={mbPopulation ?? state.population ?? null}
            champion={mbChampion ?? state.champion ?? null}
            running={autoEvolveRunning || !!state.evolveRunning}
            maxRounds={evolveCfg.maxRounds}
          />
        </>
      )}

      {/* 运行中：推理长文排在实时种群视图之后，先看到画面再看诊断 */}
      {state.evolveRunning && <RsiReasoningReview runs={[...(state.evolveRuns||[]),...(state.activeEvolution?[state.activeEvolution]:[])]} />}

      {/* ══ ③ 进化效果 ══ */}
      <SectionTitle hint="成绩随版本的变化。验证集只守「不回退」，不代表独立泛化水平；柱状图按题型拆解，哪类题拖后腿一眼可见。">进化效果</SectionTitle>
      <RsiTrajectory state={state} lineage={lineage} />

      {/* ── 自动进化运行轨迹（持久化，刷新不丢） ── */}
      <RsiEvolveRuns runs={state.evolveRuns} />

      </div>}
      {section === "candidates" && <div>
      {/* ══ ④ 待审阅方案 ══ */}
      <SectionTitle hint="先查看方案修改了什么、哪些题改善或退化，再决定是否采纳。方案需通过效果提升、防退化和引擎复核；证据过期时需重新评测。">候选方案</SectionTitle>
      <RsiCandidatesTable state={state} busy={busy} onEvaluateOne={evaluateOne} onVerifyEngine={verifyEngine} onAdopt={adopt} onReject={reject} />

      {optCapabilities?.features?.memberOptimizer === true && <>
      {/* ══ ④.5 提示词层自优化（openjiuwen MemberOptimizer）══ */}
      <SectionTitle hint="改进「出改进方案的那份指令」本身——改进器的自我改进。基于本实验的反馈信号（门禁拦截、重复提案、归因降级）让 openjiuwen MemberOptimizer 重写提案器提示词，产出候选稿，你审阅后审阅采纳应用；应用后每轮提案都使用新指令。" color={COLOR.relaxed}>提示词层自优化</SectionTitle>
      <div style={{ border: `1px solid ${COLOR.border}`, borderRadius: 12, background: "#fff", padding: "14px 18px", marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
          <Tag color={state.skillOverrides?.propose ? "green" : "default"} style={{ borderRadius: 6 }}>
            {state.skillOverrides?.propose ? "已启用优化指令" : "使用内置指令"}
          </Tag>
          <Typography.Text type="secondary" style={{ fontSize: TYPE.small }}>
            {state.promptOptimize?.status === "running"
              ? "优化进行中（MemberOptimizer 全管线约 15-25 分钟，可离开此页，完成后刷新可见候选稿）…"
              : state.promptOptimize?.status === "error"
                ? `上次优化失败：${state.promptOptimize.detail || "未知原因"}`
                : "信号源：门禁拦截记录 · 重复提案率 · 归因降级 · 采纳质量"}
          </Typography.Text>
          <Button
            size="small"
            icon={<ThunderboltOutlined />}
            loading={busy === "prompt-opt"}
            disabled={!!busy || backendStale}
            onClick={promptOptimize}
            style={{ marginLeft: "auto" }}
          >
            优化提案指令
          </Button>
        </div>
        {(state.promptCandidates || []).length > 0 && (
          <Space direction="vertical" size={8} style={{ width: "100%" }}>
            {state.promptCandidates!.map(c => (
              <div key={c.id} style={{ border: `1px solid ${COLOR.gridLine}`, borderRadius: 8, padding: "8px 12px", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <Tag color={c.status === "applied" ? "green" : c.status === "rejected" ? "default" : "blue"} style={{ borderRadius: 6 }}>
                  {c.status === "applied" ? "已应用" : c.status === "rejected" ? "已拒绝" : "待审阅"}
                </Tag>
                <Typography.Text style={{ fontSize: TYPE.small }}>
                  {c.at.slice(0, 16).replace("T", " ")} · {c.oldChars}→{c.newChars} 字 · 动因 {c.issuesCount} 条{c.elapsedSec ? ` · ${c.elapsedSec}s` : ""}
                </Typography.Text>
                <Tooltip title={<div style={{ whiteSpace: "pre-wrap", maxHeight: 400, overflowY: "auto", display: "block", maxWidth: 560 }}>{c.optimizedPrompt}</div>}>
                  <Button size="small" type="link" style={{ padding: 0 }}>查看全文</Button>
                </Tooltip>
                {c.actions.length > 0 && (
                  <Tooltip title={c.actions.map((a, i) => `${i + 1}. ${a.operation} ${a.target}：${a.rationale}`).join("\n")}>
                    <Typography.Text type="secondary" style={{ fontSize: TYPE.micro, cursor: "help" }}>
                      改动 {c.actions.length} 处（悬停看明细）
                    </Typography.Text>
                  </Tooltip>
                )}
                {c.status === "draft" && (
                  <>
                    <Popconfirm
                      title="应用这份指令？"
                      description="此后每轮「AI 提改进方案」都使用这份新指令（可再次优化覆盖）。"
                      onConfirm={() => promptApply(c.id)}
                      okText="应用" cancelText="取消"
                    >
                      <Button size="small" type="primary" ghost loading={busy === `papply-${c.id}`}>应用</Button>
                    </Popconfirm>
                    <Button size="small" loading={busy === `preject-${c.id}`} onClick={() => promptReject(c.id)}>拒绝</Button>
                  </>
                )}
              </div>
            ))}
          </Space>
        )}
        {!state.promptCandidates?.length && (
          <Typography.Text type="secondary" style={{ fontSize: TYPE.micro }}>
            还没有候选稿——跑几轮进化积累反馈后点「优化提案指令」。内置指令改动保守（每次最多 2 处），且必须由你审阅采纳才生效。
          </Typography.Text>
        )}
      </div>

      </>}
      {/* P2 降级可见性：归因走了引擎信号兜底时明示（不静默） */}
      {state.attribution?.degraded && !state.attribution.stale && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16, borderRadius: 10 }}
          message="本轮归因为降级模式"
          description={`${state.attribution.degradedReason || "部分依赖（rsi-agent/深诊断）不可用"}——归因结论由引擎信号确定性构造，缺少 LLM 根因归纳。整改方向可能偏保守；恢复 rsi-agent 后重跑归因可获得更准的处方。`}
        />
      )}

      <SectionTitle hint="按错误类型查看原因、证据与对应改进。" color={COLOR.warning}>识别问题与改进建议</SectionTitle>
      <RsiCureGroups
        state={state}
        busy={busy}
        openFamily={openFamily}
        setOpenFamily={setOpenFamily}
        onPropose={runPropose}
        onEvaluateOne={evaluateOne}
        onVerifyEngine={verifyEngine}
        onAdopt={adopt}
        onReject={reject}
      />

      </div>}
      {(section === "data" || section === "settings") && <div>
      {section === 'data' && <RsiDataPreparation taskId={taskId} hasHistory={!isEmpty} onChanged={refresh} onGenerate={() => genCases(state.baseGraph.kind === 'snapshot' ? 30 : 60)} />}
      {/* ══ ⑤ 明细与设置 ══ */}
      <SectionTitle color={COLOR.textSecondary}>{section === "data" ? "评测结果" : "任务设置"}</SectionTitle>
      <Collapse
        ghost
        style={{ background: "#fff", borderRadius: 12, border: `1px solid ${COLOR.border}`, padding: "0 20px" }}
        items={[
          {
            key: "subject",
            label: "实验对象与题库",
            forceRender: true,
            children: (
              <Space direction="vertical" size={12} style={{ width: "100%" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <Select
                    size="small"
                    style={{ minWidth: 260 }}
                    placeholder="导入线上图谱副本（选版本）"
                    value={undefined}
                    allowClear
                    loading={busy === "import"}
                    options={(bases?.manifestVersions || []).map(v => ({
                      value: v.versionId,
                      label: `${v.name}${v.status === "active_default" ? " · 当前线上" : ""}${v.imported ? " · 已导入" : ""}`,
                    }))}
                    onChange={(vid: string | undefined) => { if (vid) importSnapshot(vid); }}
                  />
                  <Popconfirm
                    title="让 AI 补充测试题？"
                    description={`针对当前图谱出 ${state.baseGraph.kind === "snapshot" ? "30" : "60"} 道新题并入题库，实验将重开（图谱回到初版）。`}
                    onConfirm={() => genCases(state.baseGraph.kind === "snapshot" ? 30 : 60)}
                    okText="出题" cancelText="取消"
                  >
                    <Button size="small" icon={<FileAddOutlined />} loading={busy === "gencases"}>AI 补充测试题（{state.baseGraph.kind === "snapshot" ? "+30" : "+60"}）</Button>
                  </Popconfirm>
                  {state.baseGraph.kind === "snapshot" && (
                    <Popconfirm title="换回演示图谱？" description="回到内置演示图谱与配套题库（60 条），实验重开。已导入的图谱副本保留，可随时再次使用。" onConfirm={() => switchBase("seed", "演示图谱")} okText="切换" cancelText="取消">
                      <Button size="small" loading={busy === "switch-seed"}>换回演示图谱</Button>
                    </Popconfirm>
                  )}
                </div>
                <Typography.Text type="secondary" style={{ fontSize: TYPE.small }}>
                  当前：{state.baseGraph.label}（{state.baseGraph.id}）· 版本 {state.currentVersion} · 题库 {caseCount} 条
                  {bases && bases.snapshots.length > 0 ? ` · 已导入：${bases.snapshots.map((s) => `${s.label}${s.intents == null ? "" : `（${s.intents} 个意图）`}`).join("、")}` : ""}
                </Typography.Text>
              </Space>
            ),
          },
          {
            key: "scores",
            label: "成绩明细与引擎对照",
            forceRender: true,
            children: (
              <div>
                {/* 当前成绩单：freshness = 版本 + 引擎口径（10-15 审核 P1：只比版本会漏掉引擎变更） */}
                <Typography.Text strong style={{ fontSize: TYPE.small, display: "block", marginBottom: 10 }}>
                  {b ? `最近一次成绩单（版本 ${b.version} · ${b.at?.replace("T", " ").slice(0, 16)}${b.engineRev ? ` · 引擎 ${engineRevShort(b.engineRev)}` : ""}）` : "当前成绩单"}
                  {!baselineCurrent && b && <Tag color="orange" style={{ marginLeft: 8 }}>版本、题库或引擎口径已变化，请重新测试</Tag>}
                </Typography.Text>
                {b ? (
                  <>
                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
                      <MetricCard emphasis="compact" title="完全正确率（全体）" value={b.scores.all.strict_pct} suffix="%" color={COLOR.strict} />
                      <MetricCard emphasis="compact" title="部分得分率（全体）" value={b.scores.all.relaxed_pct} suffix="%" color={COLOR.relaxed} />
                      <MetricCard emphasis="compact" title="验证题完全正确率" value={b.scores.heldout.strict_pct} suffix="%" color={COLOR.danger} />
                      <MetricCard emphasis="compact" title="验证题部分得分率" value={b.scores.heldout.relaxed_pct} suffix="%" color={COLOR.relaxed} />
                      <MetricCard emphasis="compact" title="优化题完全正确率" value={b.scores.train.strict_pct} suffix="%" color={COLOR.warning} />
                    </div>
                    <Typography.Text type="secondary" style={{ display: "block", fontSize: TYPE.micro }}>
                      分题型完全正确率：单意图 {b.scores.all.single_intent?.strict_pct ?? "-"}% · 复合句 {b.scores.all.multi_intent?.strict_pct ?? "-"}% · 模糊提问 {b.scores.all.ambiguous_intent?.strict_pct ?? "-"}%
                    </Typography.Text>
                  </>
                ) : (
                  <Typography.Text type="secondary" style={{ fontSize: TYPE.small }}>尚未评测。准备好题目后，到任务概览评测当前版本。</Typography.Text>
                )}

                <div style={{ height: 1, background: RULE, margin: "18px 0" }} />

                {/* 引擎对照（10-17 从概览标签行归位到此处：诊断工具入口与结果同址，
                    概览只留主流程动作；「引擎对照」术语对新人不可读，标题改为问题式说法 */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, gap: 12, flexWrap: "wrap" }}>
                  <Typography.Text strong style={{ fontSize: TYPE.small }}>
                    {infoTitle("诊断：AI 判断和生产引擎判定有多一致？（引擎对照）", "AI 在提改进方案时会先用轻量探针自查；这个对照用生产引擎把全部题重打一遍分，衡量 AI 自查结论可信到什么程度。一致率高 → AI 的调研读数可参考；一致率低 → AI 的自行验证结论要打折听（门禁与成绩不受影响，已直接用生产引擎）。对照结果有时效：图谱或题库更新后需重跑。日常进化不需要跑它，遇到「AI 说的和实际考出来的对不上」时才需要。")}
                  </Typography.Text>
                  <Button size="small" icon={<ExperimentOutlined />} loading={busy === "calibrate"} onClick={runCalibrate}>
                    {state.calibration.report ? "重新对照" : "开始对照"}
                  </Button>
                </div>
                {state.calibration.status === "running" && (
                  <Typography.Text type="secondary" style={{ fontSize: TYPE.small }}>正在用生产引擎给全部 {state.split.trainCount + state.split.heldoutCount} 条题打分，请等待评测服务返回结果…</Typography.Text>
                )}
                {state.calibration.status !== "running" && !state.calibration.report && (
                  <Typography.Text type="secondary" style={{ fontSize: TYPE.small, color: COLOR.warning }}>
                    尚未进行诊断对照。它用于排查模型自查与引擎结果不一致的问题，不是启动优化的必需步骤。
                  </Typography.Text>
                )}
                {state.calibration.report && state.calibration.report.totalCases > 0 && (() => {
                  const r = state.calibration.report;
                  const low = r.agreement.overallPct < 60;
                  const pct = (v: { total: number; agreePct: number } | undefined) => (v ? `${v.agreePct}%` : "-");
                  return (
                    <>
                      <Space size={32} wrap style={{ marginBottom: 8 }}>
                        <Statistic title="总体一致率" value={`${r.agreement.overallPct}%`} />
                        <Statistic title="单意图题一致率" value={pct(r.agreement.byShape.single_intent)} />
                        <Statistic title="复合句题一致率" value={pct(r.agreement.byShape.multi_intent)} />
                        <Statistic title="模糊提问一致率" value={pct(r.agreement.byShape.ambiguous_intent)} />
                      </Space>
                      <Typography.Text style={{ display: "block", fontSize: TYPE.small, color: low ? COLOR.warning : COLOR.good }}>
                        {low
                          ? "一致率偏低：AI 调研（探针读数）与引擎裁决常有出入——门禁与成绩不受影响（已是引擎口径），但 AI 的自行验证结论要打折听。"
                          : "一致率较高：AI 探针读数对引擎裁决有较好代表性，调研结论可参考。"}
                      </Typography.Text>
                      <Typography.Text type="secondary" style={{ display: "block", marginTop: 4, fontSize: TYPE.micro }}>
                        形态 {humanize(r.engineMode)} · 完成于 {r.finishedAt?.replace("T", " ").slice(5, 16)} · 引擎报错 {r.engineErrors} 条
                        {state.calibration.stale ? ` · ${state.calibration.staleReason || "图谱或题库已更新，已过期"}` : ""}
                      </Typography.Text>
                      {r.disagreements.length > 0 && (
                        <div style={{ background: COLOR.bg, borderRadius: 8, padding: "10px 14px", marginTop: 10 }}>
                          <Typography.Text strong style={{ fontSize: TYPE.small }}>两边结论相反的题（前 {r.disagreements.length} 条）：</Typography.Text>
                          {r.disagreements.map((d) => (
                            <div key={d.case_id} style={{ padding: "5px 0", borderBottom: `1px dashed ${COLOR.gridDash}`, fontSize: TYPE.small, lineHeight: 1.7 }}>
                              「{d.query}」 — {d.detail}
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  );
                })()}

                <div style={{ height: 1, background: RULE, margin: "18px 0" }} />

                {/* 最终验收 */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, gap: 12, flexWrap: "wrap" }}>
                  <Typography.Text strong style={{ fontSize: TYPE.small }}>
                    {infoTitle("最终验收（test 集）", SCORE_DIM_NOTES.test || "整个优化循环全程不可见的题目，只在人工发起时评测")}
                  </Typography.Text>
                  <Popconfirm
                    title="对 test 集跑一次最终验收？"
                    description={`将使用 ${testCount} 道独立验收题检查当前版本，并调用评测服务。题目不会参与优化；相同版本与评测条件复用已有结果。对验收结果反复调整方案会削弱独立性。`}
                    onConfirm={runFinalExam}
                    okText="开始验收" cancelText="取消"
                    disabled={backendStale || !testCount}
                  >
                    <Button size="small" icon={<ExperimentOutlined />} loading={busy === "finalexam"} disabled={backendStale || !testCount}>
                      最终验收
                    </Button>
                  </Popconfirm>
                </div>
                {fe ? (
                  <>
                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
                      <MetricCard emphasis="compact" title="完全正确率" value={fe.scores.strict_pct} suffix="%" color={COLOR.strict} />
                      <MetricCard emphasis="compact" title="部分得分率" value={fe.scores.relaxed_pct} suffix="%" color={COLOR.relaxed} />
                    </div>
                    <Typography.Text type="secondary" style={{ fontSize: TYPE.micro }}>
                      版本 {fe.version} · 第 {state.finalExam?.runCount} 次测试 · {fe.at?.replace("T", " ").slice(5, 16)}
                      {fe.version !== state.currentVersion ? ` · ⚠️ 测的是旧版本（当前 ${state.currentVersion}），结论对当前版本不成立` : ""}
                    </Typography.Text>
                  </>
                ) : (
                  <Typography.Text type="secondary" style={{ fontSize: TYPE.small }}>
                    {testCount
                      ? `还没测过。自动进化全程不会碰这 ${testCount} 道题；实验收尾时在这里考一次，作为最终结论。`
                      : "当前题库没有 test 集（旧切分）——「AI 补充测试题」或「清空重来」重开实验后会自动升级为三分切分。"}
                  </Typography.Text>
                )}
                {(() => {
                  // 终局盲测待办（P1-4）：已有采纳版本但从未跑 test → 收尾提醒
                  const adoptedVersions = state.versions.filter((v) => v.version !== "v1").length;
                  if (!fe && adoptedVersions > 0 && testCount > 0) {
                    return (
                      <div style={{ marginTop: 8, padding: "6px 10px", background: "#fffbe6", border: "1px solid #ffe58f", borderRadius: 8, fontSize: TYPE.small, color: "#8c6d1f" }}>
                        已固化 {adoptedVersions} 个新版本但从未跑最终验收——当前所有「变好」的结论只覆盖优化题+验证题，没有未污染数字兜底。
                      </div>
                    );
                  }
                  return null;
                })()}
              </div>
            ),
          },
          {
            key: "history",
            label: "运行数据（统计 / 版本历史 / 日志）",
            forceRender: true,
            children: (
              <Space size={16} align="start" style={{ alignItems: "flex-start", display: "flex", flexWrap: "wrap" }}>
                <Card size="small" title="运行统计" style={{ flex: "1 1 320px" }}>
                  <Space size={24} wrap>
                    <Statistic title={infoTitle("提案任务数 / 代理内 LLM 请求数", "左数=发起的提案任务次数；右数=评分子进程实测的 LLM 请求次数（每次任务内部可能有多轮调用）。两者口径不同，不能互相换算")} value={state.stats.proposeRuns} suffix={`/ ${state.stats.llmCalls}`} />
                    <Statistic title="已验证 / 前三关通过" value={state.stats.evaluated} suffix={`/ ${state.stats.passed}`} />
                    <Statistic title="采纳 / 拒绝" value={state.stats.adopted} suffix={`/ ${state.stats.rejected}`} />
                    <Statistic title={infoTitle("重复方案拦截", "AI 重复提出已经提过的方案时会被自动拦下，避免原地打转")} value={state.stats.noveltyFiltered} suffix="个" />
                  </Space>
                  <Typography.Text type="secondary" style={{ display: "block", marginTop: 8, fontSize: TYPE.micro }}>
                    采纳率 {state.stats.evaluated ? Math.round((100 * state.stats.adopted) / state.stats.evaluated) : 0}%（采纳/已验证）· 盯守中的错题 {(state.regression || []).length} 条随版本累积，任何改动让它们再错都会被拦下
                  </Typography.Text>
                  {state.statsReconciliation && (
                    <Typography.Text type="secondary" style={{ display: "block", marginTop: 4, fontSize: TYPE.micro }}>
                      对账：档案落档 {state.statsReconciliation.archiveTotal} 条（{Object.entries(state.statsReconciliation.byStatus).map(([k, v]) => `${k} ${v}`).join(" / ")}）——与过程计数的差异来自评测失败与分支路径
                    </Typography.Text>
                  )}
                </Card>
                <Card size="small" title="版本历史" style={{ flex: "1 1 320px" }}>
                  <List
                    size="small"
                    dataSource={[...state.versions].reverse()}
                    renderItem={(v) => {
                      const isCurrent = v.version === state.currentVersion && !v.rollbackFrom;
                      const onlyOnce = state.versions.filter((x) => x.version === v.version).length === 1;
                      return (
                        <List.Item
                          actions={
                            !isCurrent && onlyOnce && v.version !== "v1"
                              ? [<Popconfirm key="rb" title={`回滚到 ${v.version}？`} description="图谱整体退回该版本（之后的改动全部撤销），回滚后需重新测试。" onConfirm={() => rollback(v.version)} okText="回滚" cancelText="取消">
                                  <Button size="small" type="link" loading={busy === `rollback-${v.version}`}>回滚到此版</Button>
                                </Popconfirm>]
                              : undefined
                          }
                        >
                          <Typography.Text strong style={{ marginRight: 8 }}>{v.rollbackFrom ? `${v.version}（回滚点）` : v.version}</Typography.Text>
                          {/* P2 业务命名：业务图谱名紧随版本号，纯技术号不再是唯一可读信息 */}
                          <Tag style={{ borderRadius: 4, marginRight: 8 }}>{state.baseGraph.label}</Tag>
                          <Typography.Text type="secondary" style={{ fontSize: TYPE.small }}>{humanize(v.changelog)}</Typography.Text>
                        </List.Item>
                      );
                    }}
                  />
                </Card>
                <Card size="small" title="运行日志" style={{ flex: "1 1 320px", maxHeight: 360, overflowY: "auto" }}>
                  <List
                    size="small"
                    dataSource={state.log}
                    renderItem={(l) => (
                      <List.Item style={{ fontSize: TYPE.small }}>
                        <Typography.Text type="secondary">[{l.event}] {humanize(l.detail)} · {l.at.replace("T", " ").slice(5, 19)}</Typography.Text>
                      </List.Item>
                    )}
                  />
                </Card>
              </Space>
            ),
          },
          {
            key: "danger",
            label: "维护（清空重来）",
            forceRender: true,
            children: (
              <Space size={12} wrap>
                <Popconfirm title="清空重来？" description="仅重置本任务：清空候选、成绩、运行记录和版本历史，图谱回到初版；实验对象与题库保留。操作无法撤销，建议先导出成果。" onConfirm={reset} okText="清空" cancelText="取消">
                  <Button danger ghost icon={<RedoOutlined />} loading={busy === "reset"}>清空重来</Button>
                </Popconfirm>
                <Typography.Text type="secondary" style={{ fontSize: TYPE.small }}>实验对象与题库保留，只清空方案、成绩与版本。</Typography.Text>
              </Space>
            ),
          },
        ].filter(item => section === "data" ? ["scores"].includes(item.key) : !["scores"].includes(item.key))}
        activeKey={section === 'data' ? ['subject', 'scores'] : undefined}
        defaultActiveKey={calibrationRunning ? ["scores"] : []}
      />
      </div>}
    </div>
  );
}
