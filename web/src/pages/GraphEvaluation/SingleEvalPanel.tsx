import { useEffect, useRef, useState } from "react";
import { Alert, Button, Card, Collapse, Empty, Input, Spin, Table, Tag, Tooltip, Typography, message } from "antd";
import { ExperimentOutlined, ThunderboltFilled } from "@ant-design/icons";
import { evaluateIntent, type IntentEvalResponse, type TraceStep } from "./api";
import { displayName, formatMs, isAskRow, pct, prettyJson } from "./meta";
import "./GraphEvaluation.css";

const { Title, Text, Paragraph } = Typography;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRec = any;

const PRESETS = [
  { label: "信用卡账单查询", query: "帮我查一下信用卡账单" },
  { label: "修改类", query: "怎么修改支付密码" },
  { label: "问答/查询边界", query: "介绍一下网点服务电话咨询" },
  { label: "近邻对象", query: "看看企业服务的工资单导出" },
  { label: "转账办理", query: "我要通过预约转账转一笔钱" },
];

interface PipelineStep {
  label: string;
  desc: string;
  state: "done" | "active" | "fail" | "";
  time: string;
}

/** 参考实现 estimateLoadingPipeline 的移植：按 query 预判链路，供执行中动画。 */
function estimateLoadingPipeline(query: string): { title: string; desc: string }[] {
  const q = String(query || "").trim();
  const hasMultiBoundary = /[，,；;。]|然后|并且|同时|顺便|另外|还有|再查|再帮我|再给我|再/.test(q);
  const isTransfer = /给.+(转|打)\s*[0-9]+|转账|汇款|打钱/.test(q);
  const multiPayeeTransfer = isTransfer && /(和|与|以及|、)/.test(q) && /[0-9]/.test(q);
  const purchaseExecution = /(买|购买|买入|申购)\s*[0-9]*|买.*(理财|基金|天天盈|产品|存款|保险)/.test(q);
  const askLike = /(什么是|啥是|是啥|什么意思|介绍|说明|规则|\?|？|吗)/.test(q);
  if (hasMultiBoundary && !multiPayeeTransfer) {
    return [
      { title: "查询理解", desc: "读取组合 query" }, { title: "意图形态判断", desc: "判断单/多/模糊" },
      { title: "多意图拆分", desc: "拆分独立子意图" }, { title: "分段动作与槽位解析", desc: "逐段解析动作/金额/对象" },
      { title: "分段本地召回", desc: "逐段规则/词典/图谱" }, { title: "分段语义召回", desc: "逐段 Qwen embedding" },
      { title: "分段召回质量判断", desc: "判断强弱召回" }, { title: "分段候选融合排序", desc: "融合本地与语义候选" },
      { title: "分段图谱兜底目录", desc: "必要时启用兜底" }, { title: "子意图分别裁决", desc: "逐段 DeepSeek 裁决" },
      { title: "分段业务边界校验", desc: "校验动作/对象边界" }, { title: "组合澄清判断", desc: "判断是否追问" },
      { title: "最终结果", desc: "合并任务计划" },
    ];
  }
  const desc = purchaseExecution ? "购买/申购型短句" : multiPayeeTransfer ? "多收款人转账" : askLike ? "咨询/问答表达" : "单意图表达";
  return [
    { title: "查询理解", desc }, { title: "动作与槽位解析", desc: purchaseExecution ? "解析购买动作和金额" : "解析动作/金额/对象" },
    { title: "本地规则 + 图谱检索", desc: "规则/词典/图谱候选" }, { title: "Qwen embedding 语义召回", desc: "语义候选召回" },
    { title: "召回质量判断", desc: "判断强弱召回/分歧" }, { title: "候选融合排序", desc: "合并本地与语义候选" },
    { title: "图谱兜底目录", desc: "必要时启用兜底" }, { title: "DeepSeek 候选内裁决", desc: "模型裁判候选" },
    { title: "业务边界校验", desc: "校验动作/对象边界" }, { title: "意图形态判断", desc: multiPayeeTransfer ? "识别多任务" : "识别单/多/模糊" },
    { title: "追问澄清判断", desc: multiPayeeTransfer ? "判断金额/方式澄清" : "判断是否追问" }, { title: "最终权威结果", desc: "输出可路由结果" },
  ];
}

function traceStepState(step: TraceStep, clarificationNeeded: boolean, hasFinal: boolean): PipelineStep["state"] {
  if (step.step === "deepseek_judge" && step.data?.degraded) return "fail";
  if (step.step === "deepseek_judge" && step.data?.repaired) return "active";
  if (step.step === "recall_quality_gate" && step.data?.weak) return "active";
  if (step.step === "fallback_catalog" && step.data?.fallback_count) return "active";
  if (step.step === "business_boundary_validation" && step.data?.boundary_override) return "active";
  if (step.step === "clarification_decision" && (step.data?.needed || clarificationNeeded)) return "active";
  if (step.step === "final_result" && !hasFinal) return "fail";
  return "done";
}

function traceStepDesc(step: TraceStep): string {
  const map: Record<string, string> = {
    query_understanding: "动作/对象线索", action_slot_extraction: "动作/金额/对象", composite_split: "拆分独立子意图",
    local_recall: "规则/词典/图谱", embedding_recall: "Qwen embedding", recall_quality_gate: "强弱召回判断",
    candidate_merge: "本地+语义融合", fallback_catalog: "弱召回时启用", segment_judges: "逐段 DeepSeek",
    faq_seed_object_correction: "FAQ边界纠偏", ask_object_runtime_derivation: "咨询意图派生",
    intent_shape_analysis: "单/多/模糊", final_result: "权威输出",
  };
  if (step.step === "deepseek_judge") return step.data?.degraded ? "模型失败降级" : "候选内裁决";
  if (step.step === "business_boundary_validation") return step.data?.boundary_override ? "已纠偏" : "通过";
  if (step.step === "clarification_decision") return step.data?.needed ? "需要用户确认" : "无需追问";
  return map[step.step || ""] || step.conclusion || step.title || "";
}

/** 意图形态汇总（对齐 summarizeShape）。 */
function summarizeShape(data: IntentEvalResponse): { label: string; title: string; subtitle: string } {
  const understanding = data.understanding || {};
  const clarification = understanding.clarification || {};
  const cardinality = understanding.cardinality || "";
  const final = data.final_result || {};
  const finalAction = final.runtime_action_code || final.action_code || "";
  const authoritative = data.authoritative_results || [];
  const isIdleChat = data.result_type === "idle_chat" || cardinality === "idle_chat" || finalAction === "idle_chat";
  const isComposite = data.result_type === "multi_intent_plan" || cardinality === "multi_intent" || authoritative.length > 1;
  const isMultiTask = cardinality === "multi_task_intent";
  const isFaq = authoritative.some(isAskRow) || isAskRow(final);
  const isFuzzy = !!clarification.needed || !!understanding.final_is_non_leaf;
  if (isIdleChat) return { label: "闲聊/非业务输入", title: displayName(final) || "闲聊", subtitle: "当前输入未形成明确手机银行业务任务，系统返回固定引导话术，不进入业务路由。" };
  if (isComposite) return { label: "多意图", title: `识别到 ${authoritative.length || understanding.task_count || 0} 个子意图`, subtitle: "系统已将用户输入拆成多个可独立评测与路由的意图结果。" };
  if (isMultiTask) return { label: "多任务", title: displayName(authoritative[0]) || "同一意图下存在多任务", subtitle: "用户表达属于同一意图，但包含多个执行对象或任务实例。" };
  if (isFuzzy) return { label: "模糊意图", title: displayName(authoritative[0]) || "需要进一步确认", subtitle: "需要澄清确认后继续。" };
  if (isFaq) return { label: "问答意图", title: displayName(authoritative[0]) || displayName(final) || "知识问答", subtitle: "当前 query 被识别为咨询/问答类意图，FAQ / 知识答案是该意图的回答内容。" };
  return { label: "单意图", title: displayName(authoritative[0]) || displayName(final) || "未命中", subtitle: "当前 query 被识别为一个主要意图，可进入路由或执行前校验。" };
}

function ScoreTags({ row }: { row: AnyRec }) {
  return (
    <span style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" }}>
      {(row.sources || []).slice(0, 3).map((s: string, i: number) => <Tag key={i} color="blue" style={{ marginInlineEnd: 0 }}>{s}</Tag>)}
      {(row.evidence || []).slice(0, 3).map((s: string, i: number) => <Tag key={i} style={{ marginInlineEnd: 0 }}>{s}</Tag>)}
    </span>
  );
}

// 召回通道：与银行运行时 evaluate_intent_ladder 的 evidence 词表逐项对齐
// （intent_graph.py: alias/graph_term/graph_term_set/page_menu/page_tab + graph_expand:{edge}；
//   semantic_recall_v4.py: semantic_recall；service.py FAQ: faq_pattern/faq_multiple；上下文种子类）
const CHANNEL_KEYS = ["lexical", "graph_expand", "semantic", "faq", "context"] as const;
type ChannelKey = (typeof CHANNEL_KEYS)[number];
const CHANNEL_INFO: Record<ChannelKey, { label: string; color: string; desc: string }> = {
  lexical: { label: "词法 / 图谱词项", color: "#1677ff", desc: "别名、recallTerms/词组、页面菜单上下文直命中" },
  graph_expand: { label: "图谱结构扩展", color: "#722ed1", desc: "沿混淆/关联/子边扩展近邻意图（子图扩展）" },
  semantic: { label: "Embedding 语义", color: "#13c2c2", desc: "TuGraph 向量 KNN 语义召回（含弱召回拓宽）" },
  faq: { label: "FAQ 直答", color: "#faad14", desc: "FAQ 模式匹配的问答型意图" },
  context: { label: "上下文种子", color: "#8c93a3", desc: "会话连续性/页面引导等上下文注入候选" },
};
function channelKeyOf(ev: string): ChannelKey {
  const raw = String(ev || "");
  if (raw.startsWith("graph_expand")) return "graph_expand";
  if (raw.startsWith("semantic_recall")) return "semantic";
  if (raw.startsWith("faq")) return "faq";
  if (["alias", "graph_term", "graph_term_set", "page_menu", "page_tab"].includes(raw)) return "lexical";
  return "context";
}
function channelChip(ev: string): { label: string; color: string } {
  const key = channelKeyOf(ev);
  const info = CHANNEL_INFO[key];
  const sub = String(ev || "").includes(":") ? `·${String(ev).split(":")[1]}` : "";
  const nameMap: Record<string, string> = {
    alias: "别名", graph_term: "词项", graph_term_set: "词组", page_menu: "页面菜单", page_tab: "页面页签",
    semantic_recall: "KNN", faq_pattern: "FAQ", context: ev || "种子",
  };
  const label = key === "context" ? (nameMap[ev] || ev || "种子") : (info.label.split(" / ")[0]) + (sub || (key === "lexical" ? `·${nameMap[ev] || ""}` : ""));
  return { label, color: info.color };
}

function CandidateTable({ rows, scoreKey }: { rows: AnyRec[]; scoreKey: "fused" | "embedding" }) {
  if (!rows?.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无候选" />;
  const scoreOf = (r: AnyRec) => {
    const s = scoreKey === "embedding" ? (r.embedding_adjusted_score ?? r.embedding_score ?? r.score ?? 0) : (r.score ?? r.local_score ?? r.fused_score ?? 0);
    return typeof s === "number" ? s : Number(s) || 0;
  };
  // bar 是比例编码：以 Top1 为 100% 归一（融合分可超 100，clamp 到满格会失去区分度）
  const maxScore = Math.max(...rows.map(scoreOf), 0.000001);
  return (
    <Table<AnyRec>
      size="small"
      rowKey={(_, i) => String(i)}
      dataSource={rows}
      pagination={false}
      scroll={{ y: 320 }}
      rowClassName={(r) => (r.authoritative || r.rank === 1 ? "ge-row-winner" : "")}
      columns={[
        { title: "#", width: 44, render: (_, __, i) => i + 1 },
        {
          title: "意图", render: (_, r) => (
            <div style={{ minWidth: 0 }}>
              <b style={{ fontSize: 12 }}>{displayName(r) || "-"}{r.authoritative ? <Tag color="green" style={{ marginLeft: 6, marginInlineEnd: 0 }}>权威</Tag> : null}</b>
              <div style={{ fontSize: 11, color: "#8c93a3" }}>
                {[r.intent_id, [r.domain, r.object].filter(Boolean).join("/"), r.segment_query ? `子句：${r.segment_query}` : ""].filter(Boolean).join(" · ")}
              </div>
            </div>
          ),
        },
        {
          title: "召回通道", width: 150, render: (_, r) => (
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {(r.evidence || []).slice(0, 4).map((ev: string, i: number) => {
                const chip = channelChip(ev);
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                return <Tag key={i} color={chip.color as any} style={{ marginInlineEnd: 0, fontSize: 11 }}>{chip.label}</Tag>;
              })}
              {!(r.evidence || []).length ? <span style={{ color: "#c1c7d0", fontSize: 11 }}>-</span> : null}
            </div>
          ),
        },
        { title: "动作", width: 78, render: (_, r) => r.action_code || "-" },
        {
          title: "融合分", width: 150, render: (_, r) => {
            const num = scoreOf(r);
            return (
              <div className="ge-score">
                <div className="ge-scorebar">
                  <span>{num}</span>
                  <div className="track"><div className="fill" style={{ width: `${Math.max(2, (num / maxScore) * 100)}%` }} /></div>
                </div>
                {(r.embedding_score != null || r.local_score != null) ? (
                  <div className="ge-score-sub">emb {r.embedding_score ?? "-"} / local {r.local_score ?? "-"}</div>
                ) : null}
              </div>
            );
          },
        },
      ]}
    />
  );
}

function MiniCandidates({ rows, mode }: { rows: AnyRec[]; mode: "local" | "embedding" }) {
  const list = (rows || []).slice(0, 5);
  if (!list.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无候选" />;
  return (
    <div className="ge-mini-candidates">
      {list.map((r, i) => (
        <div className="ge-mini-candidate" key={i}>
          <div className="ge-mini-rank">{i + 1}</div>
          <div style={{ minWidth: 0 }}>
            <div className="ge-mini-name" title={displayName(r)}>{displayName(r) || "-"}</div>
            <div className="ge-mini-meta">{r.domain || "-"} · {r.object || "-"} · {r.action_code || "-"}</div>
            <div className="ge-mini-meta"><ScoreTags row={r} /></div>
          </div>
          <div className="ge-score">
            {mode === "embedding" ? (r.embedding_adjusted_score ?? r.embedding_score ?? r.score ?? "-") : (r.score ?? r.local_score ?? r.fused_score ?? "-")}
          </div>
        </div>
      ))}
    </div>
  );
}

function flowTone(step: TraceStep): "ok" | "warn" | "fail" {
  if (step.step === "deepseek_judge" && step.data?.degraded) return "fail";
  if (step.step === "deepseek_judge" && step.data?.repaired) return "warn";
  if (step.step === "recall_quality_gate" && step.data?.weak) return "warn";
  if (step.step === "fallback_catalog" && step.data?.fallback_count) return "warn";
  if (step.step === "business_boundary_validation" && step.data?.boundary_override) return "warn";
  if (["composite_split", "segment_judges", "faq_seed_object_correction", "ask_object_runtime_derivation", "embedding_recall"].includes(step.step || "")) return "warn";
  return "ok";
}

function flowStatusText(step: TraceStep): string {
  if (step.step === "deepseek_judge") return step.data?.degraded ? "模型失败" : step.data?.repaired ? "修复后可用" : "通过";
  if (step.step === "composite_split") return "已拆分";
  if (step.step === "segment_judges") return "分段裁决";
  if (step.step === "action_slot_extraction") return "槽位解析";
  if (step.step === "recall_quality_gate") return step.data?.weak ? "弱召回" : "候选可用";
  if (step.step === "candidate_merge") return "候选融合";
  if (step.step === "fallback_catalog") return step.data?.fallback_count ? "已启用" : "未启用";
  if (step.step === "business_boundary_validation") return step.data?.boundary_override ? "边界纠偏" : "边界通过";
  if (step.step === "intent_shape_analysis") return "形态判断";
  if (step.step === "clarification_decision") return "澄清判断";
  if (step.step === "embedding_recall") return "语义候选";
  if (step.step === "faq_seed_object_correction") return "对象校验";
  if (step.step === "ask_object_runtime_derivation") return "咨询派生";
  if (step.step === "final_result") return "最终结果";
  return "通过";
}

function flowMiniText(step: TraceStep): string {
  const d = step.data || {};
  if (step.step === "action_slot_extraction") return `action=${d.inferred_action || "-"}；amount=${d.amount || "-"}；purchase=${d.purchase_execution ? "yes" : "no"}；transfer=${d.transfer_execution ? "yes" : "no"}`;
  if (step.step === "recall_quality_gate") return `weak=${d.weak ? "yes" : "no"}；reason=${d.reason || "-"}；local=${d.local_top_score || 0}；embedding=${d.embedding_top_score || 0}`;
  if (step.step === "candidate_merge") return `candidate_count=${d.candidate_count || 0}`;
  if (step.step === "fallback_catalog") return `fallback_count=${d.fallback_count || 0}`;
  if (step.step === "embedding_recall" && step.selected) return `Top1=${step.selected.display_name || "-"}；原始相似度=${step.selected.embedding_score || 0}；重排后=${step.selected.embedding_adjusted_score || step.selected.score || 0}`;
  if (step.step === "deepseek_judge" && d) {
    const diag = d.diagnostics || {};
    return `mode=${d.decision_mode || "-"}；source=${d.selected_source || "-"}；rank=${d.selected_rank || 0}；prompt=${diag.prompt_chars || 0} chars；raw=${diag.raw_response_chars || 0} chars；finish=${diag.finish_reason || "-"}`;
  }
  return "";
}

function DecisionFlow({ trace }: { trace: { summary?: string; steps?: TraceStep[] } }) {
  const steps = trace.steps || [];
  if (!steps.length) return null;
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {trace.summary ? <Alert type={/没有给出|纠正|校验/.test(trace.summary) ? "warning" : "success"} showIcon message={trace.summary} /> : null}
      {steps.map((step, i) => {
        const tone = flowTone(step);
        return (
          <div style={{ display: "grid", gridTemplateColumns: "30px minmax(0,1fr)", gap: 8 }} key={i}>
            <div className="ge-mini-rank" style={{ width: 30, height: 30 }}>{i + 1}</div>
            <div style={{ minWidth: 0 }}>
              <div className="ge-card" style={{ border: 0, padding: 0 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                  <b style={{ fontSize: 13 }}>{step.title || step.step || "-"}</b>
                  <Tag color={tone === "ok" ? "green" : tone === "fail" ? "red" : "gold"} style={{ marginInlineEnd: 0 }}>{flowStatusText(step)}</Tag>
                </div>
                <div style={{ fontSize: 12, color: "#4b5563", lineHeight: 1.55, marginTop: 4 }}>{step.conclusion || ""}</div>
                {flowMiniText(step) ? <div style={{ fontSize: 11, color: "#8c93a3", marginTop: 4 }}>{flowMiniText(step)}</div> : null}
                {step.selected ? (
                  <div style={{ marginTop: 6 }}>
                    <Tag color="blue">选择</Tag><Tag color="green">{step.selected.display_name || "-"}</Tag>
                    <Tag color="blue">action: {step.selected.action_code || "-"}</Tag>
                    <Tag color="green">score: {step.selected.score || 0}</Tag>
                  </div>
                ) : null}
                {step.data ? (
                  <Collapse size="small" ghost items={[{ key: "d", label: "查看技术细节", children: <pre style={{ fontSize: 11, margin: 0, maxHeight: 300, overflow: "auto" }}>{prettyJson(step.data)}</pre> }]} />
                ) : null}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function SingleEvalPanel({ autoCollect, graphId }: { autoCollect: (query: string, data: unknown, mode: "single", sessionId: string, turnIndex: number) => void; graphId: string }) {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<IntentEvalResponse | null>(null);
  const [error, setError] = useState("");
  const [progressIdx, setProgressIdx] = useState(0);
  const [openChannel, setOpenChannel] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current); }, []);

  // 切换图谱/引擎后旧结果不再适用，清空展示
  useEffect(() => {
    setResult(null);
    setError("");
  }, [graphId]);

  const run = async (q?: string) => {
    const text = (q ?? query).trim();
    if (!text || busy) return;
    if (q) setQuery(q);
    setBusy(true);
    setResult(null);
    setError("");
    setProgressIdx(0);
    if (timerRef.current) clearInterval(timerRef.current);
    const steps = estimateLoadingPipeline(text);
    timerRef.current = setInterval(() => {
      setProgressIdx((prev) => Math.min(prev + 1, steps.length - 1));
    }, 700);
    try {
      const data = await evaluateIntent(text, graphId);
      if (timerRef.current) clearInterval(timerRef.current);
      setResult(data);
      autoCollect(text, data, "single", "", 0);
    } catch (e) {
      if (timerRef.current) clearInterval(timerRef.current);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const buildPipelineSteps = (): PipelineStep[] => {
    if (!result) {
      const steps = estimateLoadingPipeline(query);
      return steps.slice(0, Math.min(steps.length, Math.max(0, progressIdx) + 1)).map((s, i) => ({
        label: s.title, desc: s.desc, state: i < progressIdx ? "done" : i === progressIdx ? "active" : "", time: "执行中...",
      }));
    }
    const llm = result.methods?.llm_judge || {};
    const clarification = result.understanding?.clarification || {};
    const traceSteps: TraceStep[] = llm.decision_trace?.steps || [];
    const hasFinal = !!(result.final_result?.intent_id || (result.authoritative_results || []).length);
    if (traceSteps.length) {
      return traceSteps.map((step, i) => ({
        label: step.title || step.step || "流程节点",
        desc: traceStepDesc(step),
        state: traceStepState(step, !!clarification.needed, hasFinal),
        time: typeof step.timing_ms === "number"
          ? i === traceSteps.length - 1 ? `总耗时 ${formatMs(result.latency_ms ?? step.timing_ms)}` : `真实 ${formatMs(step.timing_ms)}`
          : i === traceSteps.length - 1 ? `总耗时 ${formatMs(result.latency_ms)}` : "并入相邻节点",
      }));
    }
    return estimateLoadingPipeline(query).map((s) => ({ label: s.title, desc: s.desc, state: "done" as const, time: formatMs(result.latency_ms) }));
  };

  // ── 意图形态树（简化版形态图，带当前路径高亮） ──
  const renderShapeTree = () => {
    const understanding = result?.understanding || {};
    const clarification = understanding.clarification || {};
    const cardinality = understanding.cardinality || "";
    const final = result?.final_result || {};
    const authoritative = result?.authoritative_results || [];
    const finalAction = final.runtime_action_code || final.action_code || "";
    const isIdle = result?.result_type === "idle_chat" || cardinality === "idle_chat" || finalAction === "idle_chat";
    const isComposite = result?.result_type === "multi_intent_plan" || cardinality === "multi_intent" || authoritative.length > 1;
    const isMultiTask = cardinality === "multi_task_intent";
    const isFaq = authoritative.some(isAskRow) || isAskRow(final);
    const isFuzzy = !!clarification.needed || !!understanding.final_is_non_leaf;
    const node = (key: string, title: string, desc: string) => {
      const active =
        (isIdle && ["root", "idle", "idle_response"].includes(key)) ||
        (isComposite && ["root", "multi", "multi_split"].includes(key)) ||
        (!isIdle && !isComposite && ["root", "single"].includes(key)) ||
        (!isIdle && !isComposite && !isFaq && ["business", "business_task", isMultiTask ? "multi_task" : "single_task"].includes(key)) ||
        (!isIdle && !isComposite && isFaq && ["business", "faq", "faq_hit"].includes(key)) ||
        (isFuzzy && ["fuzzy", "clarify"].includes(key));
      const warn = isFuzzy && ["fuzzy", "clarify"].includes(key);
      return (
        <div key={key} style={{
          border: `1px solid ${active ? (warn ? "#ffd666" : "#b7eb8f") : "#eef0f4"}`,
          background: active ? (warn ? "#fffbe6" : "#f6ffed") : "#fff",
          borderRadius: 8, padding: "8px 10px", minHeight: 56, position: "relative", opacity: active ? 1 : 0.62,
        }}>
          {active ? <span style={{ position: "absolute", right: 8, top: 8, fontSize: 10, color: warn ? "#d48806" : "#389e0d", border: `1px solid ${warn ? "#ffd666" : "#b7eb8f"}`, borderRadius: 999, padding: "0 6px", background: "#fff" }}>当前</span> : null}
          <b style={{ display: "block", fontSize: 13, color: active ? (warn ? "#d48806" : "#389e0d") : "#4b5563", marginBottom: 3 }}>{title}</b>
          <span style={{ display: "block", fontSize: 11, color: "#8c93a3", lineHeight: 1.45 }}>{desc}</span>
        </div>
      );
    };
    return (
      <div style={{ display: "grid", gap: 10 }}>
        <div style={{ maxWidth: 220 }}>{node("root", "意图形态", "先判断单意图、多意图或模糊意图")}</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0,1fr))", gap: 10 }}>
          <div style={{ display: "grid", gap: 8 }}>
            {node("idle", "闲聊/非业务输入", "无业务诉求，返回固定引导")}
            {node("idle_response", "固定引导话术", "不进入业务路由")}
          </div>
          <div style={{ display: "grid", gap: 8 }}>
            {node("single", "单意图", "一个主要业务目标")}
            {node("faq", "问答意图", "咨询概念/规则/说明")}
            {node("faq_hit", "FAQ命中", "种子知识命中答案")}
            {node("business", "业务办理意图", "查询/办理/修改/交易")}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {node("single_task", "单任务意图", "只包含一个明确任务")}
              {node("multi_task", "多任务意图", "多个对象或多笔任务")}
            </div>
          </div>
          <div style={{ display: "grid", gap: 8 }}>
            {node("multi", "多意图", "多个独立任务，拆分裁决")}
            {node("multi_split", "拆分后分别裁决", "逐子意图独立评测路由")}
          </div>
          <div style={{ display: "grid", gap: 8 }}>
            {node("fuzzy", "模糊意图", "对象/动作/叶子不明确")}
            {node("clarify", "追问澄清", "确认业务方向或参数")}
          </div>
        </div>
      </div>
    );
  };

  const renderUnderstanding = () => {
    if (!result) return null;
    const understanding = result.understanding || {};
    const clarification = understanding.clarification || {};
    const tasks: AnyRec[] = understanding.tasks || [];
    const authoritative: AnyRec[] = result.authoritative_results || [];
    const final = result.final_result || {};
    const llm = result.methods?.llm_judge || {};
    const shape = summarizeShape(result);
    const resultRows = authoritative.length ? authoritative : final.intent_id ? [final] : [];
    const isFaq = resultRows.some(isAskRow) || isAskRow(final);
    const isIdle = result.result_type === "idle_chat" || shape.label.startsWith("闲聊");
    return (
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1.15fr) minmax(0,0.85fr)", gap: 14 }}>
        <Card
          size="small"
          title={
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Title level={5} style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>意图形态判断</Title>
            </div>
          }
        >
          <div style={{ fontSize: 22, fontWeight: 700, color: shape.label === "单意图" || shape.label === "问答意图" ? "#389e0d" : "#d48806", marginBottom: 8 }}>{shape.label}</div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>{shape.title}</div>
          <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 10 }}>{shape.subtitle}</div>
          {renderShapeTree()}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 12 }}>
            <Tag color={understanding.cardinality?.startsWith("multi") ? "gold" : "green"}>cardinality: {understanding.cardinality || "-"}</Tag>
            <Tag color={understanding.task_count > 1 ? "gold" : "blue"}>task_count: {understanding.task_count || 0}</Tag>
            <Tag color={understanding.final_is_non_leaf ? "gold" : "green"}>non_leaf: {understanding.final_is_non_leaf ? "yes" : "no"}</Tag>
            <Tag color={clarification.needed ? "gold" : "green"}>fuzzy: {clarification.needed ? "yes" : "no"}</Tag>
            <Tag color={isFaq ? "green" : "blue"}>answer: {isFaq ? "yes" : "no"}</Tag>
          </div>
          <Alert
            style={{ marginTop: 10 }}
            type={shape.label === "多意图" || shape.label === "模糊意图" ? "warning" : "success"}
            showIcon
            message={isIdle ? "当前输入未形成明确手机银行业务任务；系统返回固定引导话术，不进入业务办理或问答路由。" : isFaq ? "已识别为问答/咨询类意图；答案内容见右侧。" : understanding.reason || "识别完成。"}
          />
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 12, color: "#8c93a3", marginBottom: 6 }}>最终权威结果</div>
            <MiniCandidates rows={resultRows.map((r, i) => ({ ...r, display_name: displayName(r) || r.intent_name, sources: [`rank ${i + 1}`] }))} mode="local" />
          </div>
          {tasks.length > 0 && (
            <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
              {tasks.map((t, i) => (
                <div key={i} style={{ border: "1px solid #eef0f4", borderRadius: 8, padding: "9px 11px", fontSize: 12, background: "#fafafa" }}>
                  <b>#{t.task_index ?? i + 1} {displayName(t) || t.intent_name || "-"}</b>
                  <div style={{ marginTop: 4 }}>
                    <Tag color="blue">{t.action_code || "-"}</Tag>
                    <Tag color={t.status === "ready" ? "green" : "gold"}>{t.status || "-"}</Tag>
                  </div>
                  {(t.payee || t.amount) && <div style={{ marginTop: 4 }}>收款人：{t.payee || "-"}　金额：{t.amount || "-"}</div>}
                  {t.segment_query && <div style={{ color: "#8c93a3", marginTop: 2 }}>子句：{t.segment_query}</div>}
                </div>
              ))}
            </div>
          )}
        </Card>
        <Card
          size="small"
          title={
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Title level={5} style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
                {isFaq || isIdle ? (isIdle ? "闲聊固定话术" : "问答意图答案") : "追问澄清确认"}
              </Title>
            </div>
          }
        >
          {clarification.needed ? (
            (() => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const questions: any[] = clarification.questions?.length ? clarification.questions : [{ title: "请确认", question: clarification.question || "需要进一步确认用户意图。", options: clarification.options || [] }];
              return questions.map((q, qi) => (
                <div key={qi} style={{ border: "1px solid #ffe58f", background: "#fffbe6", borderRadius: 8, padding: 12, marginBottom: 10 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#d48806", marginBottom: 6 }}>{q.title || q.type || "澄清问题"}</div>
                  <div style={{ fontSize: 14, lineHeight: 1.65, color: "#874d00" }}>{q.question || ""}</div>
                  {(q.options || []).length > 0 && (
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                      {q.options.map((o: any, oi: number) => {
                        const label = o.label || o.display_label || o.intent_name || o.value || "-";
                        return (
                          <button type="button" className="ge-clarify-option" key={oi} onClick={() => { setQuery(label); message.info("已填入输入框，可直接发送下一轮验证"); }}>
                            {label}{o.description ? <span>{o.description}</span> : null}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              ));
            })()
          ) : isFaq || isIdle ? (
            (result.answers || []).length ? (
              <div style={{ display: "grid", gap: 8 }}>
                {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                {(result.answers || []).map((a: any, i: number) => (
                  <div key={i} style={{ border: "1px solid #eef0f4", borderRadius: 8, padding: 11, background: "#fafafa" }}>
                    <b>#{a.segment_index ?? i + 1} {a.display_name || "-"}</b>
                    <div style={{ color: "#6b7280", fontSize: 12, marginTop: 4 }}>用户表达：{a.query || ""}</div>
                    <div style={{ fontSize: 13, marginTop: 8 }}>{a.answer || ""}</div>
                    {a.answer_disclaimer ? <Alert style={{ marginTop: 8 }} type="warning" showIcon message={a.answer_disclaimer} /> : null}
                    <div style={{ marginTop: 8, display: "flex", gap: 6, flexWrap: "wrap" }}>
                      <Tag color="blue">{a.answer_policy || "direct_answer"}</Tag>
                      <Tag color="green">faq_id: {a.faq_id || "-"}</Tag>
                      <Tag color="gold">confidence: {a.confidence || 0}</Tag>
                      <Tag color={(a.answer_source || a.source) === "llm_generated" ? "gold" : "blue"}>{a.answer_source || a.source || "faq_seed"}</Tag>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <Alert type="warning" showIcon message="已识别为问答/咨询类意图，但当前 FAQ 种子库未命中答案。" />
            )
          ) : (
            <>
              <Alert type="success" showIcon message="当前不需要追问确认，可进入路由或执行前校验。" />
              <div style={{ marginTop: 10, display: "flex", gap: 6, flexWrap: "wrap" }}>
                {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                {(clarification.types || []).map((t: string, i: number) => <Tag color="gold" key={i}>{t}</Tag>)}
                <Tag color={clarification.needed ? "gold" : "green"}>next: {clarification.default_action || "-"}</Tag>
              </div>
            </>
          )}
          <Collapse size="small" ghost style={{ marginTop: 10 }} items={[{ key: "u", label: "查看结构化澄清结果", children: <pre style={{ fontSize: 11, margin: 0, maxHeight: 300, overflow: "auto" }}>{prettyJson(understanding)}</pre> }]} />
        </Card>
      </div>
    );
  };

  // ── 最终意图结果（hero，收尾结论位）：银行引擎专用，召回/裁决看完后看结论 ──
  const renderFinalResultHero = () => {
    if (!result || !result.methods?.bank) return null;
    const bank = result.methods.bank;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cands: any[] = bank.candidates || [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const final: any = result.final_result || {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const clarification: any = (result.understanding && result.understanding.clarification) || {};
    if (clarification.needed) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const q = (clarification.questions || [])[0] || {};
      return (
        <Card
          size="small"
          style={{ background: "#fffbe6", border: "1px solid #ffe58f" }}
          title={
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Title level={5} style={{ margin: 0, fontSize: 16, fontWeight: 600, color: "#d48806" }}>最终意图结果 · 待澄清</Title>
            </div>
          }
        >
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
            <span style={{ fontSize: 20, fontWeight: 700 }}>{displayName(final) || "未定"}</span>
            <Tag color="gold">低置信 · 需用户选择</Tag>
            {typeof final.score === "number" ? <span style={{ fontSize: 12, color: "#8c93a3" }}>最高分 {final.score}</span> : null}
          </div>
          {q.question || q.body ? <div style={{ marginTop: 8, fontSize: 13 }}>{q.title ? <b>{q.title}：</b> : null}{q.question || q.body}</div> : null}
          {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
          {(q.options || []).length ? (
            <div style={{ marginTop: 8, display: "flex", gap: 6, flexWrap: "wrap" }}>
              {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
              {(q.options || []).map((o: any, i: number) => <Tag key={i} color="gold">{typeof o === "string" ? o : o.label || o.display_label || "-"}</Tag>)}
            </div>
          ) : null}
        </Card>
      );
    }
    if (!final.intent_id) {
      return (
        <Card
          size="small"
          title={
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Title level={5} style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>最终意图结果</Title>
            </div>
          }
        >
          <div style={{ padding: "10px 0", color: "#8c93a3", fontSize: 13 }}>
            本轮未形成明确业务意图{result.result_type === "idle_chat" ? "（闲聊/非业务输入，固定引导话术）" : "，未命中权威候选"}。
          </div>
        </Card>
      );
    }
    // ── 多意图 / 多任务规划：每个任务一张卡，独立展示槽位与状态 ──
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const understanding: any = result.understanding || {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const taskList: any[] = understanding.tasks || [];
    const isMulti = understanding.cardinality === "multi_intent" || understanding.cardinality === "multi_task"
      || (understanding.task_count || 0) > 1 || String(result.result_type || "").includes("multi");
    if (isMulti) {
      const doneCount = taskList.filter((t) => t.status === "ready").length;
      return (
        <Card
          size="small"
          title={
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Title level={5} style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>最终意图结果 · 多意图规划</Title>
            </div>
          }
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
            <span style={{ fontSize: 18, fontWeight: 700 }}>{taskList.length || understanding.task_count || "-"} 个任务</span>
            <Tag color="purple">{understanding.cardinality || "multi_intent"}</Tag>
            <Tag color={doneCount === taskList.length && taskList.length ? "green" : "gold"}>就绪 {doneCount} / {taskList.length || understanding.task_count || "-"}</Tag>
            <Tag color="blue">综合分 {typeof final.score === "number" ? final.score : "-"}</Tag>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 10 }}>
            {taskList.map((t, i) => (
              <div key={i} style={{ border: "1px solid #eef0f4", borderRadius: 9, padding: "10px 12px", background: "#fff" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span className="ge-mini-rank">{t.task_index ?? i + 1}</span>
                  <b style={{ fontSize: 13, flex: 1, minWidth: 0 }}>{displayName(t) || t.intent_name || t.intent_id || "-"}</b>
                  <Tag color={t.status === "ready" ? "green" : "gold"} style={{ marginInlineEnd: 0 }}>{t.status || "-"}</Tag>
                </div>
                <div style={{ marginTop: 6, display: "flex", gap: 5, flexWrap: "wrap" }}>
                  <Tag color="blue" style={{ marginInlineEnd: 0 }}>{t.action_code || "-"}</Tag>
                  {t.payee ? <Tag style={{ marginInlineEnd: 0 }}>收款人 {t.payee}</Tag> : null}
                  {t.amount ? <Tag style={{ marginInlineEnd: 0 }}>金额 {t.amount}</Tag> : null}
                </div>
                <div style={{ marginTop: 6, fontSize: 11, color: "#8c93a3" }}>{t.intent_id || ""}</div>
                {t.segment_query ? <div style={{ marginTop: 4, fontSize: 11, color: "#6b7280" }}>子句：{t.segment_query}</div> : null}
                {(t.required_slots || []).length ? (
                  <div style={{ marginTop: 4, fontSize: 11, color: "#6b7280" }}>需补槽位：{(t.required_slots || []).join("、")}</div>
                ) : null}
              </div>
            ))}
          </div>
          {!taskList.length ? (
            <div style={{ color: "#8c93a3", fontSize: 12 }}>引擎未返回任务明细（task_count {understanding.task_count || "-"}），仅展示综合结果。</div>
          ) : null}
          <div style={{ marginTop: 10, fontSize: 12, color: "#1677ff" }}>
            多意图按任务拆分处理：各任务独立补槽与校验后依次执行，任一任务缺槽会先澄清。
          </div>
        </Card>
      );
    }
    const nextStep = final.authoritative
      ? "唯一权威候选，直接进入业务路由。"
      : "无权威候选：结果作为证据保留，供澄清或人工复核。";
    const objDomain = [final.object, final.domain].filter(Boolean).filter((v: string, i: number, a: string[]) => a.indexOf(v) === i).join(" / ");
    return (
      <Card
        size="small"
        title={
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Title level={5} style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>最终意图结果</Title>
          </div>
        }
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
          <div style={{ minWidth: 0, flex: "1 1 320px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.25 }}>{displayName(final) || "-"}</span>
              {String(understanding.cardinality || "").includes("fuzzy") ? <Tag color="gold">模糊意图</Tag> : null}
              {final.authoritative ? <Tag color="green">权威收敛</Tag> : <Tag color="gold">证据保留</Tag>}
            </div>
            <div style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              <Tag color="blue">{final.action_code || "-"}</Tag>
              {objDomain ? <Tag>{objDomain}</Tag> : null}
              <Tag color="purple">{bank.shape || "single_intent"} · 任务 {bank.shapeTaskCount ?? 1}</Tag>
              {(final.evidence || []).slice(0, 3).map((ev: string, i: number) => {
                const chip = channelChip(ev);
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                return <Tag key={i} color={chip.color as any}>来源 {chip.label}</Tag>;
              })}
            </div>
            {(final.required_slots || []).length ? (
              <div style={{ marginTop: 8, fontSize: 12, color: "#6b7280" }}>
                需补槽位：{(final.required_slots || []).join("、")}
                {final.unresolved_slot_readiness ? `（${final.unresolved_slot_readiness}）` : ""}
              </div>
            ) : null}
            {final.disambiguation_hints ? (
              <div style={{ marginTop: 6, fontSize: 12, color: "#8c93a3", background: "#fafafa", borderRadius: 7, padding: "6px 9px" }}>
                澄清提示：{String(final.disambiguation_hints).replace(/^\['|'\]$/g, "")}
              </div>
            ) : null}
            <div style={{ marginTop: 8, fontSize: 12, color: "#1677ff" }}>{nextStep}</div>
          </div>
          <div style={{ textAlign: "center", padding: "0 8px" }}>
            <div style={{ fontSize: 34, fontWeight: 700, lineHeight: 1 }}>{typeof final.score === "number" ? final.score : "-"}</div>
            <div style={{ fontSize: 11, color: "#8c93a3", marginTop: 2 }}>融合分</div>
            {cands[1] ? <div style={{ fontSize: 11, color: "#8c93a3", marginTop: 6 }}>领先第 2 名 {(final.score || 0) - (cands[1].score || 0)} 分</div> : null}
          </div>
        </div>
      </Card>
    );
  };

  const renderEvidence = () => {
    if (!result) return null;
    const bank = result.methods?.bank;
    if (bank) {
      const timings = bank.timings || {};
      const faq = bank.faq || {};
      const digestShort = String(bank.graphDigest || "").slice(7, 19);
      const attr = result.attribution || {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cands: any[] = bank.candidates || [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const final: any = result.final_result || {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const clarification: any = (result.understanding && result.understanding.clarification) || {};
      const authoritativeCount = cands.filter((c) => c.authoritative).length;

      // ── ② 多路召回通道（有候选的通道卡可下钻；零候选通道收成一行，不占同等权重）──
      const renderChannels = () => {
        const all = CHANNEL_KEYS.map((key) => {
          const info = CHANNEL_INFO[key];
          const rows = cands.filter((c) => (c.evidence || []).some((ev: string) => channelKeyOf(ev) === key));
          return { key, ...info, rows, count: rows.length, best: rows.reduce((m, r) => Math.max(m, r.score || 0), 0) };
        }).filter((ch) => ch.key !== "context" || ch.count > 0);
        const channels = all.filter((ch) => ch.count > 0);
        const zeros = all.filter((ch) => ch.count === 0);
        const faqHit = (faq.matchedIntentIds || []).length;
        const active = channels.find((ch) => ch.key === openChannel);
        return (
          <Card
            size="small"
            title={
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Title level={5} style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>多路召回通道</Title>
              </div>
            }
            extra={
              <span style={{ fontSize: 11, color: "#8c93a3" }}>
                形态判定 {timings.shapeMs ?? 0}ms → 图谱召回 {timings.recallMs ?? 0}ms → 语义拓宽 {timings.widenMs ?? 0}ms
                {bank.widened ? " · 已触发拓宽" : " · 未触发拓宽"}
              </span>
            }
          >
            <div className="ge-channel-grid">
              {channels.map((ch) => {
                const open = openChannel === ch.key;
                return (
                  <button
                    type="button"
                    key={ch.key}
                    className={`ge-channel-card has-count${open ? " open" : ""}`}
                    style={{ ["--ch" as string]: ch.color }}
                    onClick={() => setOpenChannel(open ? null : ch.key)}
                  >
                    <div className="ge-channel-head">
                      <span style={{ width: 8, height: 8, borderRadius: 999, background: ch.color, flexShrink: 0 }} />
                      <span className="ge-channel-name">{ch.label}</span>
                      <span style={{ marginLeft: "auto", fontSize: 11, color: open ? "#1677ff" : "#98a1b2" }}>{open ? "收起 ▲" : "明细 ▼"}</span>
                    </div>
                    <div className="ge-channel-num">
                      <b>{ch.count}</b><span>候选</span>
                      <span style={{ marginLeft: "auto" }}>最高分 {ch.best}</span>
                    </div>
                    <div className="ge-channel-desc">{ch.desc}</div>
                  </button>
                );
              })}
            </div>
            {zeros.length ? (
              <div className="ge-channel-zeros">
                {zeros.map((ch) => (
                  <em key={ch.key}>
                    <span style={{ width: 7, height: 7, borderRadius: 999, background: "#d9dee7", display: "inline-block" }} />
                    {ch.label} 0 候选
                  </em>
                ))}
              </div>
            ) : null}
            {active ? (
              <div style={{ marginTop: 10, border: "1px solid #d6e8ff", borderRadius: 9, padding: "10px 12px", background: "#fcfdff" }}>
                <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>
                  「{active.label}」通道召回明细 · {active.count} 条
                  <span style={{ fontWeight: 400, color: "#8c93a3", marginLeft: 8 }}>{active.desc}</span>
                </div>
                <CandidateTable rows={active.rows} scoreKey="fused" />
              </div>
            ) : (
              <div style={{ marginTop: 8, fontSize: 11, color: "#8c93a3" }}>
                共 {cands.length} 条候选进入融合排序 · FAQ 命中 {faqHit} · 图谱 TuGraph V4（{bank.graphVersion || "-"} · digest {digestShort}）· 点击通道查看该路候选明细
              </div>
            )}
          </Card>
        );
      };

      // ── ③ 融合排序与裁决 ──
      const renderAdjudication = () => (
        <Card
          size="small"
          title={
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Title level={5} style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>融合排序与裁决</Title>
            </div>
          }
        >
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
            <Tag color="blue">确定性权威收敛（本环节无 LLM）</Tag>
            <Tag color={authoritativeCount ? "green" : "gold"}>权威候选 {authoritativeCount} 条</Tag>
            <Tag>{authoritativeCount ? "收敛路径：唯一权威 → 直接输出" : "收敛路径：保留证据 → 澄清/复核"}</Tag>
          </div>
          <CandidateTable rows={cands} scoreKey="fused" />
          {attr?.signals?.length ? (
            <Collapse
              size="small"
              ghost
              style={{ marginTop: 8 }}
              items={[{
                key: "attr",
                label: `归因信号 ${attr.signals.length} 条${attr.recommendation ? " · 含优化建议" : ""}`,
                children: (
                  <div style={{ display: "grid", gap: 6 }}>
                    {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                    {attr.signals.map((s: any, i: number) => (
                      <div key={i} style={{ border: "1px solid #eef0f4", borderRadius: 7, padding: "7px 9px", fontSize: 12, background: "#fafafa" }}>
                        {typeof s === "string"
                          ? s
                          : <span><b>{s.type || s.signal || "信号"}</b>{s.level ? <Tag style={{ marginLeft: 6, marginInlineEnd: 0 }} color={s.level === "strong" ? "green" : "default"}>{s.level}</Tag> : null}{s.message ? <span style={{ marginLeft: 8, color: "#6b7280" }}>{s.message}</span> : null}</span>}
                      </div>
                    ))}
                    {attr.recommendation ? <Alert type="info" showIcon message={attr.recommendation} /> : null}
                  </div>
                ),
              }]}
            />
          ) : null}
        </Card>
      );

      return (
        <div style={{ display: "grid", gap: 14 }}>
          {renderChannels()}
          {renderAdjudication()}
        </div>
      );
    }
    const local = result.methods?.local || {};
    const embedding = result.methods?.embedding || {};
    const llm = result.methods?.llm_judge || {};
    const trace = llm.decision_trace || {};
    const attr = result.attribution || {};
    const segments: AnyRec[] = result.segment_results || result.final_results || [];
    const segRows = segments.filter((seg) => seg?.methods?.llm_judge);
    return (
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <Card
          size="small"
          title={
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Title level={5} style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>召回证据</Title>
            </div>
          }
        >
          <div style={{ border: "1px solid #eef0f4", borderRadius: 8, padding: 10, marginBottom: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>本地词法 / 规则 / 图谱</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
              <Tag color="blue">action: {local.inferred_action || "-"}</Tag>
              <Tag color="green">confidence: {pct(local.confidence)}</Tag>
              <Tag color="gold">margin: {local.margin || 0}</Tag>
            </div>
            <MiniCandidates rows={local.top || []} mode="local" />
            <Collapse size="small" ghost items={[{ key: "f", label: "查看完整本地候选", children: <CandidateTable rows={local.top || []} scoreKey="fused" /> }]} />
          </div>
          <div style={{ border: "1px solid #eef0f4", borderRadius: 8, padding: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>Qwen embedding 语义召回</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
              <Tag color="blue">model: {embedding.model || "-"}</Tag>
              <Tag color={embedding.query_embedding_cached ? "green" : "gold"}>query cached: {embedding.query_embedding_cached ? "yes" : "no"}</Tag>
              <Tag color={(embedding.missing_candidate_vectors || 0) ? "gold" : "green"}>missing vectors: {embedding.missing_candidate_vectors || 0}</Tag>
            </div>
            <MiniCandidates rows={embedding.top || []} mode="embedding" />
            <Collapse size="small" ghost items={[{ key: "f", label: "查看完整语义候选", children: <CandidateTable rows={embedding.top || []} scoreKey="embedding" /> }]} />
          </div>
        </Card>
        <Card
          size="small"
          title={
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Title level={5} style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>推理与裁判证据</Title>
            </div>
          }
        >
          <div style={{ border: "1px solid #eef0f4", borderRadius: 8, padding: 10, marginBottom: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>DeepSeek 裁判状态</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <Tag color={llm.selected_source === "fallback" ? "gold" : "blue"}>mode: {llm.decision_mode || "-"}</Tag>
              <Tag color={llm.selected_source === "fallback" ? "gold" : "green"}>source: {llm.selected_source || "-"}</Tag>
              {llm.degraded ? <Tag color="red">JSON失败</Tag> : llm.repaired ? <Tag color="gold">JSON修复</Tag> : <Tag color="green">JSON正常</Tag>}
              {llm.boundary_override ? <Tag color="gold">边界纠正</Tag> : null}
            </div>
            {trace.summary ? <Alert style={{ marginTop: 8 }} type={/没有给出|纠正|校验/.test(trace.summary) ? "warning" : "success"} showIcon message={trace.summary} /> : null}
            <Collapse size="small" ghost items={[{ key: "df", label: "查看完整推理流程", children: <DecisionFlow trace={trace} /> }]} />
          </div>
          <div style={{ border: "1px solid #eef0f4", borderRadius: 8, padding: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>最终权威结果</div>
            {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
            {(result.authoritative_results || []).map((r: any, i: number) => (
              <div className="ge-mini-candidate" key={i} style={{ borderTop: i ? "1px solid #f5f6f8" : 0, paddingTop: i ? 7 : 0 }}>
                <div className="ge-mini-rank">{r.segment_index || i + 1}</div>
                <div style={{ minWidth: 0 }}>
                  <div className="ge-mini-name">{displayName(r) || r.intent_name || "未命中"}</div>
                  <div className="ge-mini-meta">{r.query || r.domain || "-"} · {r.intent_id || "-"}</div>
                  <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 3 }}>
                    <Tag color="blue" style={{ marginInlineEnd: 0 }}>{r.runtime_action_code || r.action_code || "-"}</Tag>
                    {r.runtime_boundary ? <Tag color="gold" style={{ marginInlineEnd: 0 }}>{r.runtime_boundary}</Tag> : null}
                  </div>
                </div>
                <div className="ge-score">{r.score ?? "-"}</div>
              </div>
            ))}
            {attr?.signals?.length ? (
              <div style={{ marginTop: 10, display: "grid", gap: 6 }}>
                <div style={{ fontSize: 12, fontWeight: 700 }}>归因信号</div>
                {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                {attr.signals.map((s: any, i: number) => (
                  <div key={i} style={{ border: "1px solid #eef0f4", borderRadius: 7, padding: "7px 9px", fontSize: 12, background: "#fafafa" }}>
                    {typeof s === "string" ? s : prettyJson(s)}
                  </div>
                ))}
                {attr.recommendation ? <Alert type="info" showIcon message={attr.recommendation} /> : null}
              </div>
            ) : null}
            <Collapse size="small" ghost items={[{
              key: "raw", label: "查看 DeepSeek Prompt / Raw",
              children: <pre style={{ fontSize: 11, margin: 0, maxHeight: 320, overflow: "auto" }}>{prettyJson({ prompt_summary: llm.prompt_summary, diagnostics: llm.llm_diagnostics, parsed: llm.parsed, reason: llm.reason, raw_response: llm.raw_response, parse_error: llm.parse_error })}</pre>,
            }]} />
          </div>
        </Card>
        {segRows.length > 0 && (
          <Card
            size="small"
            style={{ gridColumn: "1 / -1" }}
            title={
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Title level={5} style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>子意图裁决链路</Title>
              </div>
            }
          >
            <Alert style={{ marginBottom: 10 }} type="info" showIcon message="组合 query 会先拆成子意图；每个子意图分别完成本地召回、Qwen embedding 召回和 DeepSeek 候选内裁决。" />
            <div style={{ display: "grid", gap: 10 }}>
              {segRows.map((seg, i) => {
                const llmSeg = seg.methods.llm_judge || {};
                const finalSeg = seg.final_result || {};
                return (
                  <div key={i} style={{ border: "1px solid #eef0f4", borderRadius: 8, padding: 11, background: "#fafafa" }}>
                    <b>#{seg.segment_index ?? i + 1} {seg.query || ""}</b>
                    <div style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" }}>
                      <Tag color={finalSeg.action_code === "ask" ? "gold" : "green"}>{displayName(finalSeg) || "未命中"}</Tag>
                      <Tag color="blue">{finalSeg.action_code || "-"}</Tag>
                      <Tag color="green">score: {finalSeg.score || 0}</Tag>
                      {llmSeg.degraded ? <Tag color="red">LLM失败</Tag> : llmSeg.repaired ? <Tag color="gold">LLM修复后可用</Tag> : <Tag color="green">LLM正常</Tag>}
                    </div>
                    <Collapse size="small" ghost style={{ marginTop: 6 }} items={[{ key: "seg", label: "本段裁决流程", children: <DecisionFlow trace={llmSeg.decision_trace || {}} /> }]} />
                  </div>
                );
              })}
            </div>
          </Card>
        )}
      </div>
    );
  };

  const steps = buildPipelineSteps();

  return (
    <div style={{ display: "grid", gap: 14 }}>
      {/* ── 顶部输入卡：标题 + 输入区 + 预设按钮（对齐工作台输入区视觉层次）── */}
      <Card
        className="ge-input-card"
        styles={{ body: { padding: 20 } }}
        title={
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <ExperimentOutlined style={{ fontSize: 18, color: "#2878b5" }} />
            <Title level={5} style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>单次意图评测</Title>
            <Text type="secondary" style={{ fontSize: 12 }}>输入用户 query，查看引擎完整推理链路</Text>
          </div>
        }
      >
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="输入用户 query，例如：帮我查一下信用卡账单"
            onPressEnter={() => run()}
            allowClear
            size="large"
            style={{ borderRadius: 6 }}
          />
          <Button
            type="primary"
            icon={<ThunderboltFilled />}
            loading={busy}
            onClick={() => run()}
            size="large"
            style={{ minWidth: 124, borderRadius: 6, fontWeight: 500 }}
          >开始评测</Button>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 12, alignItems: "center" }}>
          <Text type="secondary" style={{ fontSize: 12, marginRight: 4 }}>预设用例：</Text>
          {PRESETS.map((p) => (
            <Button
              key={p.label}
              type="default"
              size="small"
              onClick={() => run(p.query)}
              style={{ borderRadius: 6, fontSize: 12 }}
            >{p.label}</Button>
          ))}
        </div>
      </Card>

      {error ? <Alert type="error" showIcon message={`评测出错：${error}`} /> : null}
      {!result && !busy ? (
        <div className="ge-empty">
          <div className="ge-empty-icon"><ExperimentOutlined style={{ fontSize: 20 }} /></div>
          <div className="ge-empty-title">还没有评测结果</div>
          <div className="ge-empty-desc">
            输入用户 query 并点击「开始评测」，这里将展示引擎的真实意图裁决链路：<br />
            形态判定、多路召回候选、融合排序与裁决、最终权威结果。
          </div>
        </div>
      ) : null}

      {busy || result ? (
      <Card
        size="small"
        title={
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Title level={5} style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>意图推理流程进度</Title>
            <Text type="secondary" style={{ fontSize: 12 }}>共 {steps.length} 个节点</Text>
          </div>
        }
        extra={result ? <Tag color="green">后端真实裁决链路 · 总耗时 {formatMs(result.latency_ms)}</Tag> : <Tag color="gold">按 query 预判链路</Tag>}
      >
        {busy && !result ? <Spin size="small" /> : null}
        <div className="ge-pipeline-scroll">
          <div className="ge-pipeline-track" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(104px, 1fr))` }}>
            {steps.map((s, i) => (
              <div className={`ge-pipeline-step ge-pipeline-step-${s.state || "idle"}`} key={i}>
                <div className="ge-pipeline-dot">{s.state === "done" ? "✓" : s.state === "fail" ? "!" : "•"}</div>
                <b>{s.label}</b>
                <span>{s.desc || "-"}</span>
                <em className="ge-pipeline-time" style={{ fontStyle: "normal" }}>{s.time || "-"}</em>
              </div>
            ))}
          </div>
        </div>
      </Card>
      ) : null}

      {result ? renderEvidence() : null}
      {result ? renderFinalResultHero() : null}
      {(() => {
        // 银行引擎简单单意图：形态/任务附录与 hero 全重复，仅多任务/FAQ/闲聊/澄清时保留
        if (!result || !result.methods?.bank) return result ? renderUnderstanding() : null;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const u: any = result.understanding || {};
        const hasTasks = (u.task_count || 0) > 1 || (u.tasks || []).length > 1;
        const hasFaq = (result.answers || []).length > 0 || !!u.faq_answer;
        const isIdle = result.result_type === "idle_chat";
        const clarified = !!(u.clarification && u.clarification.needed);
        return hasTasks || hasFaq || isIdle || clarified ? renderUnderstanding() : null;
      })()}
    </div>
  );
}
