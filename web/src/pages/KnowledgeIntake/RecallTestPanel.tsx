/**
 * 召回试测面板：借鉴小i知识工作台「业务人员即时试测 + 回归用例」的运营形态。
 * 判定语义走图谱声明（目标/描述/范围/易混/说法证据），LLM 定性结论，无分数阈值。
 */
import { useCallback, useEffect, useState } from "react";
import { Button, Drawer, Empty, Input, Select, Space, Table, Tabs, Tag, Tooltip, Typography, message } from "antd";
import { CaretRightOutlined, DeleteOutlined, ExperimentOutlined } from "@ant-design/icons";
import {
  knowledgeIntakeApi,
  type IntakeItem,
  type RecallCase,
  type RecallCasesResult,
  type RecallMatch,
  type RecallRunItem,
  type RecallRunResult,
  type RecallTestResult,
} from "@/api/knowledgeIntake";

const { Text } = Typography;

const VERDICT_META: Record<RecallMatch["verdict"], { label: string; color: string }> = {
  hit: { label: "命中", color: "green" },
  ambiguous: { label: "歧义", color: "orange" },
};

const CONFIDENCE_LABEL: Record<RecallMatch["confidence"], string> = {
  high: "把握高",
  medium: "把握中",
  low: "把握低",
};

const OUTCOME_META: Record<string, { label: string; color: string }> = {
  pass: { label: "过", color: "green" },
  ambiguous: { label: "歧义", color: "orange" },
  fail: { label: "不过", color: "red" },
};

function MatchCards({ matches }: { matches: RecallMatch[] }) {
  if (!matches.length) {
    return (
      <div style={{ padding: "20px 0", textAlign: "center" }}>
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <Text type="secondary" style={{ fontSize: 12 }}>
              未命中任何意图 —— 可能超出本批次的意图范围，或说法覆盖不足（考虑补说法 / 补边界声明）
            </Text>
          }
        />
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {matches.map((m, idx) => (
        <div
          key={m.ref + idx}
          style={{
            border: "1px solid #e5e6eb",
            borderRadius: 8,
            padding: "10px 12px",
            background: idx === 0 ? "#fafffa" : "#fff",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Text strong style={{ fontSize: 13 }}>{m.name}</Text>
            <Text type="secondary" style={{ fontSize: 11, maxWidth: 260 }} ellipsis={{ tooltip: m.ref }}>{m.ref}</Text>
            <span style={{ flex: 1 }} />
            <Tag color={VERDICT_META[m.verdict].color} style={{ marginInlineEnd: 0 }}>{VERDICT_META[m.verdict].label}</Tag>
            <Text type="secondary" style={{ fontSize: 11 }}>{CONFIDENCE_LABEL[m.confidence]}</Text>
          </div>
          {m.reason && (
            <div style={{ marginTop: 4 }}>
              <Text style={{ fontSize: 12, color: "#4b5563" }}>{m.reason}</Text>
            </div>
          )}
          {m.evidence.length > 0 && (
            <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
              <Text type="secondary" style={{ fontSize: 11 }}>证据</Text>
              {m.evidence.map((e, i) => (
                <span
                  key={i}
                  style={{
                    fontSize: 11,
                    color: "#475569",
                    background: "#f1f5f9",
                    borderRadius: 4,
                    padding: "1px 6px",
                  }}
                >
                  {e}
                </span>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function RecallTestPanel({
  batchId,
  open,
  onClose,
}: {
  batchId: string;
  open: boolean;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<RecallTestResult | null>(null);

  const [cases, setCases] = useState<RecallCase[]>([]);
  const [casesLoading, setCasesLoading] = useState(false);
  const [newQuery, setNewQuery] = useState("");
  const [newExpected, setNewExpected] = useState<string | undefined>(undefined);
  const [adding, setAdding] = useState(false);
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<RecallRunResult | null>(null);
  const [intents, setIntents] = useState<IntakeItem[]>([]);

  const refreshCases = useCallback(async (id: string) => {
    setCasesLoading(true);
    try {
      const data: RecallCasesResult = await knowledgeIntakeApi.listRecallCases(id);
      setCases(data.cases);
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setCasesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open || !batchId) return;
    setResult(null);
    setRunResult(null);
    refreshCases(batchId);
    knowledgeIntakeApi
      .getItems(batchId, { kind: "intents" })
      .then((data) => setIntents(data.items || []))
      .catch(() => setIntents([]));
  }, [open, batchId, refreshCases]);

  const handleTest = async () => {
    const q = query.trim();
    if (!q) {
      message.warning("先输入一句想试的问话");
      return;
    }
    setTesting(true);
    try {
      const data = await knowledgeIntakeApi.recallTest(batchId, q);
      setResult(data);
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setTesting(false);
    }
  };

  const handleAddCase = async () => {
    const q = newQuery.trim();
    if (!q) {
      message.warning("先输入用例问句");
      return;
    }
    setAdding(true);
    try {
      await knowledgeIntakeApi.addRecallCase(batchId, { query: q, expectedRef: newExpected || "" });
      setNewQuery("");
      setNewExpected(undefined);
      message.success("用例已添加");
      refreshCases(batchId);
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setAdding(false);
    }
  };

  const handleRunAll = async () => {
    if (!cases.length) {
      message.warning("还没有用例，先添加几条");
      return;
    }
    setRunning(true);
    try {
      const data = await knowledgeIntakeApi.runRecallCases(batchId);
      setRunResult(data);
      refreshCases(batchId);
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const handleDeleteCase = (item: RecallCase) => {
    knowledgeIntakeApi
      .deleteRecallCase(batchId, item.id)
      .then(() => refreshCases(batchId))
      .catch((error) => message.error((error as Error).message));
  };

  const intentOptions = intents.map((it) => ({
    value: it.ref || "",
    label: `${it.name || "未命名"}${it.ref ? `（${it.ref}）` : ""}`,
  }));

  const caseColumns = [
    {
      title: "用例问句",
      dataIndex: "query",
      key: "query",
      ellipsis: true,
      render: (v: string, row: RecallCase) => <Tooltip title={v}><Text style={{ fontSize: 12 }}>{v}</Text></Tooltip>,
    },
    { title: "期望意图", dataIndex: "expectedName", key: "expectedName", width: 150, ellipsis: true, render: (v: string) => v || <Text type="secondary">—</Text> },
    {
      title: "上次结论",
      dataIndex: "lastResult",
      key: "lastResult",
      width: 90,
      render: (_: unknown, row: RecallCase) => {
        const outcome = row.lastResult?.outcome;
        if (!outcome) return <Text type="secondary">未跑</Text>;
        const meta = OUTCOME_META[outcome];
        return <Tag color={meta.color} style={{ marginInlineEnd: 0 }}>{meta.label}</Tag>;
      },
    },
    {
      title: "",
      key: "op",
      width: 40,
      render: (_: unknown, row: RecallCase) => (
        <Button type="text" size="small" aria-label={`删除用例 ${row.query}`} icon={<DeleteOutlined />} onClick={() => handleDeleteCase(row)} />
      ),
    },
  ];

  const runById = new Map<string, RecallRunItem>((runResult?.results || []).map((r) => [r.caseId, r]));

  return (
    <Drawer
      title={
        <Space size={8}>
          <ExperimentOutlined />
          <span>召回试测</span>
          <Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>按意图声明的要素语义判定，试试业务人员会怎么问</Text>
        </Space>
      }
      open={open}
      onClose={onClose}
      width={680}
      destroyOnHidden
    >
      <Tabs
        defaultActiveKey="playground"
        items={[
          {
            key: "playground",
            label: "单句试测",
            children: (
              <div>
                <Input.Search
                  placeholder="输入一句用户可能说的话，例如：工资单明细怎么查"
                  enterButton="试测"
                  value={query}
                  maxLength={200}
                  onChange={(e) => setQuery(e.target.value)}
                  onSearch={handleTest}
                  loading={testing}
                />
                {result && (
                  <div style={{ marginTop: 12 }}>
                    <div style={{ marginBottom: 8 }}>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        参与意图 {result.considered}
                        {result.offlineCount > 0 && ` · 已排除停用/驳回 ${result.offlineCount}`}
                        {result.omitted > 0 && ` · 超限裁剪 ${result.omitted}`}
                      </Text>
                    </div>
                    <MatchCards matches={result.matches} />
                  </div>
                )}
              </div>
            ),
          },
          {
            key: "cases",
            label: `回归用例集${cases.length ? `（${cases.length}）` : ""}`,
            children: (
              <div>
                <Space.Compact style={{ width: "100%", marginBottom: 12 }}>
                  <Input
                    placeholder="用户问句（用例）"
                    value={newQuery}
                    maxLength={200}
                    onChange={(e) => setNewQuery(e.target.value)}
                    onPressEnter={handleAddCase}
                    style={{ flex: 1 }}
                  />
                  <Select
                    allowClear
                    showSearch
                    optionFilterProp="label"
                    placeholder="期望意图（选填）"
                    value={newExpected}
                    onChange={(v) => setNewExpected(v)}
                    options={intentOptions}
                    style={{ width: 220 }}
                    popupMatchSelectWidth={320}
                  />
                  <Button type="primary" loading={adding} onClick={handleAddCase}>添加</Button>
                </Space.Compact>
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
                  <Button
                    type="primary"
                    ghost
                    size="small"
                    icon={<CaretRightOutlined />}
                    loading={running}
                    disabled={!cases.length}
                    onClick={handleRunAll}
                  >
                    运行全部
                  </Button>
                  {runResult && (
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      过 <Text strong style={{ color: "#15803d" }}>{runResult.passed}</Text>
                      {" · "}歧义 <Text strong style={{ color: "#d97706" }}>{runResult.ambiguous}</Text>
                      {" · "}不过 <Text strong style={{ color: "#dc2626" }}>{runResult.failed}</Text>
                      {runResult.errors > 0 && ` · 失败 ${runResult.errors}`}
                    </Text>
                  )}
                  <span style={{ flex: 1 }} />
                  <Text type="secondary" style={{ fontSize: 12 }}>期望意图填了才会判定过/不过</Text>
                </div>
                <Table
                  size="small"
                  rowKey="id"
                  loading={casesLoading}
                  dataSource={cases}
                  columns={caseColumns}
                  pagination={cases.length > 10 ? { pageSize: 10, size: "small" } : false}
                  expandable={{
                    rowExpandable: (row) => !!runById.get(row.id),
                    expandedRowRender: (row) => {
                      const run = runById.get(row.id);
                      if (!run) return null;
                      return (
                        <div style={{ padding: "4px 0" }}>
                          {run.error ? (
                            <Text type="danger" style={{ fontSize: 12 }}>运行失败：{run.error}</Text>
                          ) : (
                            <MatchCards matches={run.matches} />
                          )}
                        </div>
                      );
                    },
                  }}
                />
              </div>
            ),
          },
        ]}
      />
    </Drawer>
  );
}

export default RecallTestPanel;
