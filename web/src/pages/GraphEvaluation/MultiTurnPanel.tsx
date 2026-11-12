import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Card, Collapse, Empty, Input, Select, Spin, Switch, Table, Tag, Alert, message } from "antd";
import { ClearOutlined, SendOutlined } from "@ant-design/icons";
import { evaluateMultiTurn, resetMultiTurnSession, submitMultiTurnClarify, type MultiTurnResponse, type TraceStep } from "./api";
import { displayName, formatMs, turnTypeLabel, shapeLabel } from "./meta";
import "./GraphEvaluation.css";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TurnData = MultiTurnResponse & { _loading?: boolean };

interface MultiTurnPipelineStep {
  label: string;
  desc: string;
  state: "done" | "active" | "fail" | "";
  time: string;
}

// ── 意图推理流程进度（与 SingleEvalPanel.buildPipelineSteps 同源） ──
// 数据源优先级：
//   1. latest.single_turn_result.methods.llm_judge.decision_trace.steps —— 与单轮评测同源的 6 步真实链路
//      （形态判定 → 图谱召回 → 向量语义拓宽 → LLM 候选内裁决 → 权威收敛 → 最终结果）
//   2. latest.trace —— 多轮级 5 步 trace（context_load / single_turn_recognition / state_update 等），
//      forget / slot_fill 等跳过单轮管线的轮次会走这里
// 引擎源码：services/ai-native-bank/agent-runtime/app/service.py evaluate_intent_ladder
// 前端适配器：routes/intent-evaluator-bank.js 第 188-324 行（6 步 steps 数组）
function buildMultiTurnPipeline(data: TurnData): MultiTurnPipelineStep[] {
  if (!data || data._loading) return [];
  const totalLatency = data.turn?.latency_ms ?? data.latency_ms ?? 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const llmJudge: any = (data.single_turn_result as any)?.methods?.llm_judge || {};
  const singleSteps: TraceStep[] = llmJudge.decision_trace?.steps || [];
  if (singleSteps.length) {
    return singleSteps.map((step, i) => {
      const isLast = i === singleSteps.length - 1;
      const timing = typeof step.timing_ms === "number" ? step.timing_ms : 0;
      let state: MultiTurnPipelineStep["state"] = "done";
      if (step.step === "deepseek_judge" && step.data?.degraded) state = "fail";
      else if (step.step === "final_result" && !step.data?.final_intent_id && !step.data?.intent_id) state = "fail";
      else if (step.step === "semantic_widening" && step.data?.widened) state = "active";
      else if (step.step === "authority_shortcut" && step.data?.fallback) state = "active";
      return {
        label: step.title || step.step || `步骤 ${i + 1}`,
        desc: step.conclusion || "",
        state,
        time: isLast
          ? `总耗时 ${formatMs(totalLatency)}`
          : timing ? `真实 ${formatMs(timing)}` : "并入相邻节点",
      };
    });
  }
  // 退化：多轮级 trace（forget/slot_fill 跳过单轮管线的场景）
  const multiTrace: TraceStep[] = data.trace || [];
  return multiTrace.map((step, i) => ({
    label: step.title || step.step || `步骤 ${i + 1}`,
    desc: step.conclusion || "",
    state: "done" as const,
    time: i === multiTrace.length - 1 ? `总耗时 ${formatMs(totalLatency)}` : "并入相邻节点",
  }));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ClarifyFormField = { name: string; label: string; required?: boolean; value?: string; options?: { label: string; value: string }[] };

// 结构化补录表单：对齐生产 App 的澄清答复通道（值编码进 clarificationMessage 后 resume）
function ClarifyForm({ fields, disabled, onSubmit }: { fields: ClarifyFormField[]; disabled: boolean; onSubmit: (values: Record<string, string>) => void }) {
  const initial = useMemo(() => {
    const init: Record<string, string> = {};
    fields.forEach((f) => { init[f.name] = f.value || ""; });
    return init;
  }, [fields]);
  const [values, setValues] = useState<Record<string, string>>(initial);
  useEffect(() => setValues(initial), [initial]);
  const isBool = (v?: string) => v === "true" || v === "false";
  return (
    <div className="ge-clarify-form">
      <div className="ge-clarify-grid">
        {fields.map((f) => (
          <div className="ge-clarify-field" key={f.name}>
            <span className="ge-clarify-field-label">{f.label}{f.required ? <span className="req">*</span> : null}</span>
            {isBool(f.value) ? (
              <Switch
                size="small"
                checked={values[f.name] !== "false"}
                disabled={disabled}
                onChange={(v) => setValues((prev) => ({ ...prev, [f.name]: String(v) }))}
              />
            ) : f.options && f.options.length ? (
              <Select
                size="small"
                value={values[f.name] || undefined}
                disabled={disabled}
                placeholder={`选择${f.label}`}
                options={f.options.map((o) => ({ label: o.label, value: o.value }))}
                onChange={(v) => setValues((prev) => ({ ...prev, [f.name]: String(v) }))}
                style={{ width: "100%" }}
              />
            ) : (
              <Input
                size="small"
                value={values[f.name] || ""}
                disabled={disabled}
                onChange={(e) => setValues((prev) => ({ ...prev, [f.name]: e.target.value }))}
                placeholder={f.label}
              />
            )}
          </div>
        ))}
      </div>
      <div style={{ marginTop: 9, display: "flex", justifyContent: "flex-end" }}>
        <Button
          size="small"
          type="primary"
          disabled={disabled || fields.some((f) => f.required && !String(values[f.name] || "").trim())}
          onClick={() => onSubmit(values)}
        >
          提交补录
        </Button>
      </div>
    </div>
  );
}

const EXAMPLES: string[][] = [
  ["我要转100", "张三", "手机号转账"],
  ["查一下我的余额", "再看看信用卡待还", "算了，先查基金超市"],
  ["给张三转100", "算了，先查余额吧", "继续转账吧"],
];
const EXAMPLE_LABELS = ["补槽示例", "漂移示例", "恢复示例"];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getTurnIntentRows(data: MultiTurnResponse | null): { name: string; query: string; intentId: string; action: string; score?: number }[] {
  if (!data) return [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const state: any = data.state_after || {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = data.turn_intents || state.turn_intents || [];
  if (rows.length) {
    return rows.map((item) => ({
      name: item.name || item.display_name || item.intent_name || "",
      query: item.query || item.text || "",
      intentId: item.intent_id || "",
      action: item.action || item.action_code || "",
      score: item.score,
    }));
  }
  const summary = state.last_result_summary || {};
  if (summary.final_name) return [{ name: summary.final_name, query: data.query || "", intentId: "", action: summary.action || "", score: summary.score }];
  return [];
}

// ── 多路召回通道（与 SingleEvalPanel 同源，复用 bank 引擎三路召回渲染） ──
// 数据源：latest.single_turn_result.methods.bank（含 candidates/timings/faq/graphDigest）
// 与首页位置要求对齐：本卡位于「意图推理流程进度」之下、「当前轮理解」之上。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRec = any;
// 召回通道：与银行运行时 evaluate_intent_ladder 的 evidence 词表逐项对齐
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

export default function MultiTurnPanel({ autoCollect, graphId }: { autoCollect: (query: string, data: unknown, mode: "multi", sessionId: string, turnIndex: number) => void; graphId: string }) {
  const [sessionId, setSessionId] = useState("");
  const [turns, setTurns] = useState<TurnData[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [openChannel, setOpenChannel] = useState<string | null>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  const isBankEngine = graphId.startsWith("bank:");

  // 切换图谱/引擎后旧会话不再适用，清空本地轮次（有上下文时提示，避免误以为会话还在）
  useEffect(() => {
    if (sessionId) message.info("已切换图谱/引擎：原多轮会话已重置，后续输入将开启新会话");
    setSessionId("");
    setTurns([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphId]);

  const scrollToBottom = () => {
    setTimeout(() => {
      if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
    }, 60);
  };

  const send = async (raw: string) => {
    const query = raw.trim();
    if (!query || busy) return;
    setInput("");
    setBusy(true);
    const loading: TurnData = {
      query,
      turn: { type: "running", reason: "正在调用多轮意图引擎...", latency_ms: 0 },
      state_after: { active_tasks: [], pending_slots: [], clarification: null, last_result_summary: { final_name: "识别中" } },
      trace: [],
      _loading: true,
    };
    setTurns((prev) => [...prev, loading]);
    scrollToBottom();
    try {
      const data = await evaluateMultiTurn(query, sessionId, graphId);
      if (data.session_id) setSessionId(data.session_id);
      setTurns((prev) => {
        const next = [...prev];
        next[next.length - 1] = data;
        return next;
      });
      scrollToBottom();
      autoCollect(query, data, "multi", data.session_id || sessionId, turns.length + 1);
    } catch (e) {
      setTurns((prev) => prev.slice(0, -1));
      setInput(query); // 输入还给自己：失败轮不应吞掉用户敲的 query
      message.error(`多轮评测出错：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const sendClarifyForm = async (values: Record<string, string>) => {
    if (busy || !sessionId) return;
    const filled = Object.entries(values)
      .filter(([, v]) => String(v || "").trim())
      .map(([k, v]) => `${k}:${v}`);
    const query = `【补录】${filled.join("；") || "空表单"}`;
    setBusy(true);
    const loading: TurnData = {
      query,
      turn: { type: "running", reason: "正在提交补录信息...", latency_ms: 0 },
      state_after: { active_tasks: [], pending_slots: [], clarification: null, last_result_summary: { final_name: "识别中" } },
      trace: [],
      _loading: true,
    };
    setTurns((prev) => [...prev, loading]);
    scrollToBottom();
    try {
      const data = await submitMultiTurnClarify(sessionId, values, graphId);
      if (data.session_id) setSessionId(data.session_id);
      setTurns((prev) => {
        const next = [...prev];
        next[next.length - 1] = data;
        return next;
      });
      scrollToBottom();
      autoCollect(query, data, "multi", data.session_id || sessionId, turns.length + 1);
    } catch (e) {
      setTurns((prev) => prev.slice(0, -1));
      message.error(`补录提交出错：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    if (sessionId) {
      resetMultiTurnSession(sessionId, graphId).catch(() => undefined);
    }
    setSessionId("");
    setTurns([]);
  };

  const loadExample = (groupIdx: number) => {
    const group = EXAMPLES[groupIdx] || EXAMPLES[0];
    setInput(group[0]);
  };

  const latest = turns.length ? turns[turns.length - 1] : null;
  const state = useMemo(() => (latest && (latest.state_after as Record<string, unknown>)) || {}, [latest]);
  const turn = latest?.turn || {};
  const activeTasks = (state.active_tasks as unknown[]) || [];
  const pendingSlots = (state.pending_slots as string[]) || [];
  const clarification = (state.clarification as Record<string, unknown>) || {};

  // ── 助手消息渲染（对齐参考实现 buildMultiAssistantMessage） ──
  const renderAssistant = (data: TurnData, key: number) => {
    if (data._loading) {
      return (
        <div className="ge-msg" key={key}>
          <div className="ge-avatar">AI</div>
          <div className="ge-bubble">正在识别本轮意图...</div>
        </div>
      );
    }
    const st = (data.state_after as Record<string, unknown>) || {};
    const tn = data.turn || {};
    const clf = (st.clarification as Record<string, unknown>) || {};
    const summary = (st.last_result_summary as Record<string, unknown>) || {};
    const rows = getTurnIntentRows(data);
    const taskNames = (summary.task_names as string[]) || rows.map((r) => r.name).filter(Boolean);
    const finalName = (summary.final_name as string) || rows[0]?.name || "";
    const nameDisplay = taskNames.length > 1 ? taskNames.map((n) => `「${n}」`).join(" + ") : `「${finalName}」`;
    const resultType = (summary.result_type as string) || "";
    const slots = (st.pending_slots as string[]) || [];
    return (
      <div className="ge-msg" key={key}>
        <div className="ge-avatar">AI</div>
        <div className="ge-bubble">
          {clf.needed ? (
            <>
              <div>{(clf.question as string) || "需要进一步确认意图。"}</div>
              {(() => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const questions: any[] = Array.isArray(clf.questions) && clf.questions.length ? clf.questions : [{ title: "请确认", question: clf.question || "需要进一步确认用户意图。", options: clf.options || [] }];
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const form = (clf.form as { kind?: string; fields?: ClarifyFormField[] } | null) || null;
                const formFields = form && Array.isArray(form.fields) ? form.fields : [];
                const isActive = key === turns.length - 1;
                return questions.map((q, qi) => {
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  const options: any[] = q.options || [];
                  return (
                    <div key={qi}>
                      <div className="ge-hint"><b>{q.title || "请确认"}</b><br />{q.question || q.message || ""}</div>
                      {options.length > 0 && (
                        <div className="ge-clarify-options">
                          {options.map((opt, oi) => {
                            const label = typeof opt === "string" ? opt : opt.display_label || opt.label || opt.name || opt.intent_name || "";
                            const desc = typeof opt === "string" ? "" : opt.description || opt.reason || "";
                            return (
                              <button type="button" className="ge-clarify-option" key={oi} onClick={() => send(label)}>
                                {label}
                                {desc ? <span>{desc}</span> : null}
                              </button>
                            );
                          })}
                        </div>
                      )}
                      {formFields.length > 0 && (
                        <ClarifyForm
                          fields={formFields}
                          disabled={busy || !isActive}
                          onSubmit={(values) => sendClarifyForm(values)}
                        />
                      )}
                    </div>
                  );
                });
              })()}
              <div className="ge-hint">
                已识别到 {nameDisplay}，{slots.length ? `还需要补充：${slots.join("、")}。` : "需要进一步确认。"}
              </div>
            </>
          ) : resultType === "idle_chat" || summary.intent_id === "idle_chat" || tn.type === "idle_chat" ? (
            <>
              <div>已识别为闲聊/非业务输入。</div>
              <div className="ge-answer-box">{(summary.answer as string) || "我可以帮您办理查询、转账、缴费、理财等手机银行业务。"}</div>
            </>
          ) : finalName ? (
            <div>已识别到 {nameDisplay}。</div>
          ) : (
            <div>已完成本轮理解。</div>
          )}
          {slots.length > 0 && !clf.needed && <div className="ge-hint">还需要补充：{slots.join("、")}。</div>}
          {tn.reason && !clf.needed && <div className="ge-hint">{tn.reason}</div>}
        </div>
      </div>
    );
  };

  // ── 逐轮时间线 ──
  const renderTimeline = () => (
    <div className="ge-state-flow">
      {turns.map((data, index) => {
        const st = (data.state_after as Record<string, unknown>) || {};
        const tn = data.turn || {};
        const rows = getTurnIntentRows(data);
        const summary = (st.last_result_summary as Record<string, unknown>) || {};
        const names = rows.map((r) => r.name).filter(Boolean);
        const intentName = names.length ? names.join(" + ") : (summary.final_name as string) || "未命中";
        const isLast = index === turns.length - 1;
        const cls = isLast ? " ge-state-node-active" : tn.type === "intent_drift" || tn.type === "intent_restart" ? " ge-state-node-drift" : tn.type === "intent_resume" ? " ge-state-node-resume" : "";
        const slots = (st.pending_slots as string[]) || [];
        return (
          <div className={`ge-state-node${cls}`} key={index}>
            <div className="ge-state-dot-col">
              <div className="ge-state-dot" />
              {!isLast && <div className="ge-state-line" />}
            </div>
            <div className="ge-state-card">
              <div className="ge-idx">
                第 {index + 1} 轮 · {turnTypeLabel(tn.type)}
                {isLast && slots.length ? <span style={{ color: "#d48806", marginLeft: 6 }}>待补 {slots.join("、")}</span> : null}
              </div>
              <div className="ge-name">{intentName}</div>
              <div className="ge-meta">{tn.reason || ""} · {formatMs(tn.latency_ms)}</div>
            </div>
          </div>
        );
      })}
    </div>
  );

  // ── 多路召回通道（三路召回：lexical / graph_expand / semantic，外加 faq / context）──
  // 数据源：latest.single_turn_result.methods.bank（与单轮评测同源，由 intent-evaluator-multiturn.js 透传）
  // 位置：意图推理流程进度之下、当前轮理解之上 —— 对齐「流程进度在召回之上」的首页要求
  const renderRecallChannels = () => {
    if (!latest || latest._loading) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bank: any = (latest.single_turn_result as any)?.methods?.bank;
    if (!bank) return null;
    const timings = bank.timings || {};
    const faq = bank.faq || {};
    const digestShort = String(bank.graphDigest || "").slice(7, 19);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cands: any[] = bank.candidates || [];
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
        title="多路召回通道"
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

  // ── 融合排序与裁决（召回之后、意图形态判断之前）──
  // 数据源：latest.single_turn_result.methods.bank.candidates + latest.single_turn_result.attribution
  // 位置：在多路召回通道之下、意图形态判断展开之上，对齐 SingleEvalPanel 的 renderAdjudication。
  const renderAdjudication = () => {
    if (!latest || latest._loading) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const single: any = latest.single_turn_result as any;
    if (!single) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bank: any = single.methods?.bank;
    if (!bank) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cands: any[] = bank.candidates || [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const attr: any = single.attribution || {};
    const authoritativeCount = cands.filter((c) => c.authoritative).length;
    return (
      <Card size="small" title="融合排序与裁决">
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
  };

  // ── 当前轮理解 + 意图行 + 澄清引导（合并一卡，消除重复） ──
  const renderCurrentTurn = () => {
    if (!latest || latest._loading) return null;
    const st = state as Record<string, unknown>;
    const summary = (st.last_result_summary as Record<string, unknown>) || {};
    const shape = (st.intent_shape as Record<string, unknown>) || {};
    const rows = getTurnIntentRows(latest);
    const taskNames = (summary.task_names as string[]) || rows.map((r) => r.name).filter(Boolean);
    const finalName = (summary.final_name as string) || taskNames.join(" + ") || "未命中";
    const nameDisplay = taskNames.length > 1 ? taskNames.map((n) => `「${n}」`).join(" + ") : `「${finalName}」`;
    const displayReason = clarification.needed ? "当前意图需要澄清确认，请在左侧对话区选择。" : ((turn.reason as string) || "本轮已完成意图理解。");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const questions: any[] = Array.isArray(clarification.questions) && clarification.questions.length ? clarification.questions : [];
    const first = questions[0] || {};
    const optionCount = ((first.options as unknown[]) || (clarification.options as unknown[]) || []).length;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const form = (clarification.form as { fields?: ClarifyFormField[] } | null) || null;
    const formFields = Array.isArray(form?.fields) ? form!.fields! : [];
    const hasOptions = optionCount > 0;
    const hasForm = formFields.length > 0;
    const guide = hasOptions
      ? "候选项已在左侧对话区展示，点击选项继续。"
      : hasForm
        ? "请在左侧对话区的补录表单中填写后提交。"
        : "请直接在左侧输入框输入答复内容（如：给张三转100）。";
    return (
      <>
        <div style={{ background: "#fafafa", borderRadius: 8, padding: "10px 12px" }}>
          <div style={{ fontSize: 16, lineHeight: 1.35, fontWeight: 700 }}>{nameDisplay}</div>
          <div style={{ margin: "5px 0 0", color: "#6b7280", fontSize: 12 }}>{displayReason}</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
            <Tag color="blue" style={{ marginInlineEnd: 0 }}>{turnTypeLabel(turn.type)}</Tag>
            <Tag color={shape.clarification_needed ? "gold" : "green"} style={{ marginInlineEnd: 0 }}>{shapeLabel((shape.cardinality as string) || (summary.result_type as string))}</Tag>
            {shape.intent_nature ? <Tag color="blue" style={{ marginInlineEnd: 0 }}>{shapeLabel(shape.intent_nature as string)}</Tag> : null}
          </div>
        </div>
        {rows.length > 1 ? (
          <div style={{ marginTop: 10 }}>
            {rows.map((row, i) => (
              <div key={i} style={{ display: "grid", gridTemplateColumns: "24px minmax(0,1fr) auto", gap: 8, alignItems: "center", border: "1px solid #eef0f4", borderRadius: 8, background: "#fff", padding: "7px 10px", marginBottom: 6 }}>
                <div className="ge-mini-rank">{i + 1}</div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 600 }}>{row.name || "-"}</div>
                  <div style={{ fontSize: 11, color: "#8c93a3" }}>{row.query || row.intentId || ""}</div>
                </div>
                <Tag color="blue" style={{ marginInlineEnd: 0 }}>{row.action || "-"}</Tag>
              </div>
            ))}
          </div>
        ) : null}
        {clarification.needed ? (
          <div style={{ border: "1px solid #ffe58f", background: "#fffbe6", borderRadius: 8, padding: "10px 12px", marginTop: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#874d00" }}>{first.title || "需要确认"}</div>
            <div style={{ color: "#8c93a3", fontSize: 12, marginTop: 4 }}>{guide}</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
              <Tag color="gold" style={{ marginInlineEnd: 0 }}>{hasOptions ? "待选择" : hasForm ? "待补录" : "待答复"}</Tag>
              {hasOptions ? <Tag color="blue" style={{ marginInlineEnd: 0 }}>{optionCount} 个选项</Tag> : null}
              {hasForm ? <Tag color="blue" style={{ marginInlineEnd: 0 }}>{formFields.length} 个待补字段</Tag> : null}
              {pendingSlots.length ? <Tag color="gold" style={{ marginInlineEnd: 0 }}>待补槽：{pendingSlots.join("、")}</Tag> : null}
            </div>
          </div>
        ) : null}
      </>
    );
  };

  // ── 推理过程 ──
  const renderTraceTurns = () => (
    <Collapse
      size="small"
      items={turns.map((data, index) => {
        const tn = data.turn || {};
        const st = (data.state_after as Record<string, unknown>) || {};
        const summary = (st.last_result_summary as Record<string, unknown>) || {};
        const trace = data.trace || [];
        return {
          key: String(index),
          label: (
            <span style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <b>第 {index + 1} 轮 · {turnTypeLabel(tn.type)}</b>
              <span style={{ color: "#8c93a3", fontSize: 11 }}>{(summary.final_name as string) || "未命中"} · {formatMs(tn.latency_ms)}</span>
            </span>
          ),
          children: trace.length ? (
            <div className="ge-trace-steps">
              {trace.map((t, i) => (
                <div className="ge-trace-step" key={i}>
                  <div className="ge-dot">{i + 1}</div>
                  <div className="ge-card">
                    <b>{t.title || t.step || `步骤 ${i + 1}`}</b>
                    <p>{t.conclusion || ""}{t.latency_ms != null ? ` · ${Math.round(t.latency_ms)}ms` : ""}</p>
                    {t.data ? (
                      <Collapse size="small" ghost items={[{ key: "data", label: "结构化依据", children: <pre style={{ fontSize: 11, whiteSpace: "pre-wrap", wordBreak: "break-all", margin: 0, maxHeight: 260, overflow: "auto" }}>{JSON.stringify(t.data, null, 2)}</pre> }]} />
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ color: "#8c93a3", fontSize: 12 }}>服务端未返回明细埋点，本轮仅展示类型、结果和总耗时。</div>
          ),
        };
      })}
    />
  );

  const hasSession = turns.length > 0;

  return (
    <div className="ge-multi-grid">
      <Card
        size="small"
        title={<span>对话交互{sessionId ? <Tag color="blue" style={{ marginLeft: 8, marginInlineEnd: 0 }}>{sessionId.slice(0, 8)}</Tag> : null}</span>}
        extra={hasSession ? <Button type="text" size="small" icon={<ClearOutlined />} onClick={reset}>重置会话</Button> : null}
        styles={{ body: { padding: 12 } }}
      >
        {isBankEngine ? (
          <div style={{ fontSize: 11, color: "#8c93a3", margin: "0 2px 8px" }}>
            银行引擎真实会话：每轮调用一次与手机银行 App 相同的 LLM Agent Run，延迟为秒级，会消耗模型 token。
          </div>
        ) : null}
        <div className="ge-chat-window" ref={chatRef}>
          <div className="ge-msg">
            <div className="ge-avatar">AI</div>
            <div className="ge-bubble">请输入用户问题，我会按多轮意图识别流程返回意图、状态更新和必要的澄清问题。</div>
          </div>
          {turns.map((data, i) => (
            <div key={i} style={{ display: "grid", gap: 10 }}>
              <div className="ge-msg ge-msg-user">
                <div className="ge-avatar">测</div>
                <div className="ge-bubble">{data.query || ""}</div>
              </div>
              {renderAssistant(data, i)}
            </div>
          ))}
        </div>
        <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
          <Input.TextArea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="测试者代表用户输入，例如：我要转100"
            autoSize={{ minRows: 1, maxRows: 4 }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(input);
              }
            }}
          />
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
            <Button type="primary" icon={<SendOutlined />} loading={busy} onClick={() => send(input)}>发送</Button>
            {EXAMPLE_LABELS.map((label, idx) => (
              <Button key={label} type="text" size="small" onClick={() => loadExample(idx)}>{label}</Button>
            ))}
          </div>
        </div>
      </Card>

      <div style={{ display: "grid", gap: 12, minWidth: 0 }}>
        {!hasSession ? (
          <div className="ge-empty">
            <div className="ge-empty-icon">AI</div>
            <div className="ge-empty-title">发送第一轮用户输入</div>
            <div className="ge-empty-desc">左侧每轮对话都会调用真实意图引擎，右侧同步展示当前轮理解、槽位状态与逐轮轨迹。可从「补槽 / 漂移 / 恢复」三类示例脚本开始。</div>
          </div>
        ) : (
          <>
            <div className="ge-stat-strip">
              <div className="ge-stat-cell"><b>{activeTasks.length || 0}</b><span>活动任务</span></div>
              <div className="ge-stat-cell"><b>{pendingSlots.length || 0}</b><span>待补槽</span></div>
              <div className="ge-stat-cell"><b>{turnTypeLabel(turn.type)}</b><span>本轮类型</span></div>
              <div className="ge-stat-cell"><b>{latest && !latest._loading ? formatMs(turn.latency_ms) : "-"}</b><span>本轮耗时</span></div>
            </div>
            {(() => {
              // 意图推理流程进度：与单轮评测同源的 6 步真实链路，放在「当前轮理解」之上，
              // 对齐首页位置要求（三路召回之上）。评测任务发起时即展示（loading 阶段显示预判骨架，
              // 结果返回后切换为后端真实 trace）。forget / slot_fill 跳过单轮管线时退化为多轮级 trace。
              if (!latest) return null;
              const isLoading = !!latest._loading;
              const pipelineSteps = buildMultiTurnPipeline(latest);
              // loading 阶段无 trace 时，用单轮同源 6 步预判骨架占位，确保发起即可见
              const loadingSteps: MultiTurnPipelineStep[] = !pipelineSteps.length && isLoading ? [
                { label: "① 意图形态判定", desc: "analyze_intent_shape", state: "active", time: "执行中..." },
                { label: "② 图谱召回", desc: "recall_intent_constraints", state: "", time: "待执行" },
                { label: "③ 向量语义拓宽", desc: "_widen_intent_constraints", state: "", time: "待执行" },
                { label: "④ LLM 候选内裁决", desc: "LLMJudgeV4", state: "", time: "待执行" },
                { label: "⑤ 权威收敛", desc: "authority_shortcut", state: "", time: "待执行" },
                { label: "⑥ 最终结果", desc: "final_result", state: "", time: "待执行" },
              ] : pipelineSteps;
              if (!loadingSteps.length) return null;
              const isSingleTurn = !!(latest.single_turn_result as Record<string, unknown>);
              return (
                <Card
                  size="small"
                  title={`意图推理流程进度（${loadingSteps.length}个节点）`}
                  extra={
                    isLoading
                      ? <Tag color="gold">引擎执行中 · 按 query 预判链路</Tag>
                      : <Tag color={isSingleTurn ? "green" : "gold"}>{isSingleTurn ? "后端真实裁决链路" : "多轮级 trace"} · 总耗时 {formatMs(latest.turn?.latency_ms ?? 0)}</Tag>
                  }
                >
                  {isLoading && <div style={{ marginBottom: 8 }}><Spin size="small" /></div>}
                  <div className="ge-pipeline-scroll">
                    <div className="ge-pipeline-track" style={{ gridTemplateColumns: `repeat(${loadingSteps.length}, minmax(104px, 1fr))` }}>
                      {loadingSteps.map((s, i) => (
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
              );
            })()}
            {renderRecallChannels()}
            {renderAdjudication()}
            <Card size="small" title="意图形态判断展开" styles={{ body: { padding: 12 } }}>
              {renderCurrentTurn()}
            </Card>
            <Card size="small" title="逐轮轨迹" styles={{ body: { padding: 12 } }}>
              {renderTimeline()}
            </Card>
            <Card size="small" title="推理过程" styles={{ body: { padding: 12 } }}>
              {renderTraceTurns()}
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
