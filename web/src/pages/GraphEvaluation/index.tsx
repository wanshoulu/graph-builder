import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Select, Switch, Tabs, Tag, Tooltip, Typography, message } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import CaseLibraryPanel from "./CaseLibraryPanel";
import MultiTurnPanel from "./MultiTurnPanel";
import SingleEvalPanel from "./SingleEvalPanel";
import TestRunsPanel from "./TestRunsPanel";
import TestSetGenPanel from "./TestSetGenPanel";
import { createTestCase, getEngineStatus, listGraphs, type EvaluationGraph, type IntentEngineStatus } from "./api";

export const DEFAULT_EVAL_GRAPH_ID = "bank:ccb-mobile-bank-intents";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function summarizeForCollection(query: string, data: any, mode: "single" | "multi") {
  // 对齐参考实现 saveTestCase：从引擎响应提取用例摘要字段
  let finalIntent = "";
  let actionCode = "";
  let businessObject = "";
  let resultType = "";
  let latencyMs = 0;
  if (mode === "multi") {
    const state = data.state_after || {};
    const turn = data.turn || {};
    const summary = state.last_result_summary || {};
    const turnIntentRows = data.turn_intents || state.turn_intents || [];
    if (turnIntentRows.length) {
      if (turnIntentRows.length > 1) {
        finalIntent = turnIntentRows.map((r: any) => r.name || r.display_name || r.intent_name || "").filter(Boolean).join(" + ");
        actionCode = turnIntentRows.map((r: any) => r.action || r.action_code || "").filter(Boolean).join(" + ");
        businessObject = turnIntentRows.map((r: any) => r.object || "").filter(Boolean).join(" + ");
      } else {
        finalIntent = turnIntentRows[0].name || turnIntentRows[0].display_name || turnIntentRows[0].intent_name || "";
        actionCode = turnIntentRows[0].action || turnIntentRows[0].action_code || "";
        businessObject = turnIntentRows[0].object || "";
      }
    } else if (summary.final_name) {
      finalIntent = summary.final_name;
      actionCode = summary.action || "";
      businessObject = summary.object || "";
    }
    resultType = turn.type || "";
    latencyMs = turn.latency_ms || 0;
  } else {
    const finalResult = data.final_result || {};
    const authoritative = data.authoritative_results || [];
    const segments = data.final_results || data.segment_results || [];
    if (authoritative.length > 1) {
      finalIntent = authoritative.map((r: any) => r.display_name || r.intent_name || "").filter(Boolean).join(" + ");
      actionCode = authoritative.map((r: any) => r.action_code || r.runtime_action_code || "").filter(Boolean).join(" + ");
      businessObject = authoritative.map((r: any) => r.object || "").filter(Boolean).join(" + ");
    } else if (segments.length > 1) {
      finalIntent = segments.map((r: any) => r.display_name || r.intent_name || "").filter(Boolean).join(" + ");
      actionCode = segments.map((r: any) => r.action_code || r.runtime_action_code || "").filter(Boolean).join(" + ");
      businessObject = segments.map((r: any) => r.object || "").filter(Boolean).join(" + ");
    } else {
      finalIntent = authoritative.length ? authoritative[0].display_name || authoritative[0].intent_name || "" : finalResult.display_name || finalResult.intent_name || "";
      actionCode = finalResult.runtime_action_code || finalResult.action_code || "";
      businessObject = authoritative.length ? authoritative[0].object || "" : finalResult.object || "";
    }
    resultType = data.result_type || "";
    latencyMs = data.latency_ms || 0;
  }
  return { query, result_type: resultType, final_intent: finalIntent, action_code: actionCode, business_object: businessObject, latency_ms: latencyMs, eval_mode: mode, session_id: "", turn_index: 0 };
}

export default function GraphEvaluation() {
  const [status, setStatus] = useState<IntentEngineStatus | null>(null);
  const [statusError, setStatusError] = useState("");
  const [autoCollectOn, setAutoCollectOn] = useState(true);
  const [libraryRefresh, setLibraryRefresh] = useState(0);
  const recentKeys = useRef<Record<string, boolean>>({});
  const [graphId, setGraphId] = useState(DEFAULT_EVAL_GRAPH_ID);
  const [graphs, setGraphs] = useState<EvaluationGraph[]>([]);

  const loadStatus = useCallback(() => {
    setStatusError("");
    getEngineStatus(graphId)
      .then(setStatus)
      .catch((e) => setStatusError((e as Error).message));
  }, [graphId]);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    listGraphs()
      .then((result) => setGraphs(result.graphs || []))
      .catch(() => setGraphs([]));
  }, []);

  const graphOptions = useMemo(() => {
    const toOption = (g: EvaluationGraph) => ({
      label: `${g.label}${g.active ? "（active）" : ""}`,
      value: g.id,
      title: g.sublabel || g.label,
    });
    const bank = graphs.filter((g) => g.engine === "bank").map(toOption);
    const v2 = graphs.filter((g) => g.engine === "v2").map(toOption);
    const groups: { label: string; title: string; options: { label: string; value: string; title?: string }[] }[] = [];
    if (bank.length) groups.push({ label: "银行运行时", title: "银行运行时", options: bank });
    if (v2.length) groups.push({ label: "v2 历史版本", title: "v2 历史版本", options: v2 });
    return groups;
  }, [graphs]);

  const isBankEngine = graphId.startsWith("bank:");

  const autoCollect = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (query: string, data: any, mode: "single" | "multi", sessionId: string, turnIndex: number) => {
      if (!autoCollectOn) return;
      const dedupeKey = `${query}|${mode}|${sessionId || ""}|${turnIndex || 0}`;
      if (recentKeys.current[dedupeKey]) return;
      recentKeys.current[dedupeKey] = true;
      setTimeout(() => {
        delete recentKeys.current[dedupeKey];
      }, 5000);
      const engineTag = isBankEngine ? "engine:bank" : "engine:v2";
      const tags = `${engineTag} graph:${graphId}`;
      const payload = { ...summarizeForCollection(query, data, mode), session_id: sessionId || "", turn_index: turnIndex || 0, tags, full_response: data, source: "auto" as const };
      createTestCase(payload)
        .then(() => setLibraryRefresh((x) => x + 1))
        .catch((e) => message.warning(`自动收集失败：${(e as Error).message}`));
    },
    [autoCollectOn, graphId, isBankEngine],
  );

  const gv = String(status?.graph_version_id || status?.graph_version || "").replace(/^intent-graph-v/, "").replace(/^bank:/, "");
  // 引擎版本只取 major.minor：evaluator_version_id 里残存的 batch 尾巴是图谱代次，展示会造成"引擎 batch9 vs 图谱 batch10"的假混淆
  const ev = String(status?.evaluator_version_id || status?.evaluator_version || "").replace(/^intent-evaluator-v/, "").split("-").slice(0, 2).join("-");

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
        <div style={{ minWidth: 0 }}>
          <Typography.Title level={3} style={{ marginBottom: 4 }}>图谱评测（意图图谱）</Typography.Title>
          <Typography.Text type="secondary">在线测试 · 测试集生成 · 跑批测试 · 归因分析 —— 支持银行意图引擎与 v2 历史版本对比</Typography.Text>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <Select
            size="small"
            style={{ minWidth: 240 }}
            value={graphId}
            onChange={(value) => setGraphId(value)}
            options={graphOptions}
            showSearch
            optionFilterProp="label"
            placeholder="选择评测图谱"
          />
          {status ? (
            <Typography.Text type="secondary" style={{ fontSize: 12, whiteSpace: "nowrap" }}>
              {(() => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const src = (status as any).runtime_source as { reachable?: boolean; graph_version?: string; intent_nodes?: number; node_total?: number } | undefined;
                if (isBankEngine && src?.reachable) {
                  return [
                    "银行意图引擎",
                    `TuGraph V4 真源 · ${src.graph_version || "3.0.0"}`,
                    `意图节点 ${src.intent_nodes ?? "-"} / 全图 ${src.node_total ?? "-"}`,
                    status.llm_model || "LLM 规划",
                  ].join(" · ");
                }
                return [
                  isBankEngine ? "银行意图引擎" : `引擎 v${ev || "-"}`,
                  isBankEngine ? `图谱 ${gv || "bank"}` : `图谱 v${gv || "-"}`,
                  `意图 ${status.intent_count ?? 0}`,
                  ...(isBankEngine
                    ? [status.llm_model || "LLM 规划"]
                    : [`FAQ ${status.faq_count ?? 0}`, `LLM ${status.llm_model || "-"}`]),
                ].join(" · ");
              })()}
            </Typography.Text>
          ) : statusError ? (
            <Tooltip title={statusError}>
              <Tag color="red">引擎状态加载失败</Tag>
            </Tooltip>
          ) : (
            <Tag color="gold">引擎状态加载中...</Tag>
          )}
          <Button size="small" icon={<ReloadOutlined />} onClick={loadStatus}>刷新状态</Button>
          <Tooltip title="每次评测后自动把用例（含完整响应）沉淀到测试用例库，5 秒去重">
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "#6b7280" }}>
              自动收集
              <Switch size="small" checked={autoCollectOn} onChange={setAutoCollectOn} />
            </span>
          </Tooltip>
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <Tabs
          defaultActiveKey="online"
          items={[
            {
              key: "online", label: "图谱在线测试",
              children: (
                <Tabs
                  defaultActiveKey="multi"
                  items={[
                    { key: "multi", label: "多轮对话", children: <MultiTurnPanel autoCollect={autoCollect} graphId={graphId} /> },
                    { key: "single", label: "单次评测", children: <SingleEvalPanel autoCollect={autoCollect} graphId={graphId} /> },
                  ]}
                />
              ),
            },
            {
              key: "testset", label: "测试集生成",
              children: <TestSetGenPanel onImported={() => setLibraryRefresh((x) => x + 1)} />,
            },
            {
              key: "batch", label: "图谱跑批测试",
              children: <TestRunsPanel graphId={graphId} graphOptions={graphOptions.flatMap((g) => g.options)} />,
            },
            {
              key: "attribution", label: "测试结果归因分析",
              children: <CaseLibraryPanel refreshToken={libraryRefresh} />,
            },
          ]}
        />
      </div>
    </div>
  );
}
