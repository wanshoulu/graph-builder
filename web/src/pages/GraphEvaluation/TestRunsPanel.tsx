import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button, Card, Checkbox, Empty, Input, Modal, Popconfirm, Progress, Select, Space, Table, Tag, Tooltip, Typography, message,
} from "antd";
import { CaretRightOutlined, DeleteOutlined, DownloadOutlined, ReloadOutlined, StopOutlined, ToolOutlined } from "@ant-design/icons";
import {
  analyzeRemediations, applyRemediations, cancelRun, createRun, deleteRun, deleteTestsetDataset, getRun, listRuns, listTestsetDatasets,
  type RemediationAnalysis, type TestDatasetMeta, type TestRunDetail, type TestRunListItem, type TestRunResultRow,
} from "./api";
import { FAILURE_META, formatMs, shapeLabel, decisionModeLabel, sourceLabel } from "./meta";

const STATUS_META: Record<string, { label: string; color: string }> = {
  running: { label: "运行中", color: "processing" },
  done: { label: "已完成", color: "success" },
  failed: { label: "失败", color: "error" },
  interrupted: { label: "已中断", color: "warning" },
};

function pct2(passed: number, total: number): string {
  if (!total) return "-";
  return `${((passed / total) * 100).toFixed(1)}%`;
}

function rateText(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function scoreText(score?: number): string {
  if (score == null) return "-";
  return score > 0 && score <= 1 ? `${(score * 100).toFixed(1)}%` : String(score);
}

function duration(startedAt: string, finishedAt?: string | null): string {
  const end = finishedAt ? Date.parse(finishedAt) : Date.now();
  const s = Math.max(0, Math.round((end - Date.parse(startedAt)) / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

function fmtTime(iso?: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

const CATEGORY_LABELS: Record<string, string> = {
  SINGLE_INTENT: "单意图", MULTI_INTENT: "多意图", AMBIGUOUS_INTENT: "模糊意图",
};

export default function TestRunsPanel({ graphId, graphOptions }: {
  graphId: string;
  graphOptions: { label: string; value: string }[];
}) {
  const [runs, setRuns] = useState<TestRunListItem[]>([]);
  const [datasets, setDatasets] = useState<TestDatasetMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [selDatasetId, setSelDatasetId] = useState<string | undefined>();
  const [selGraph, setSelGraph] = useState<string>(graphId);
  // 页头切换图谱时同步运行表单里的目标图谱，避免停留在旧选择
  useEffect(() => { setSelGraph(graphId); }, [graphId]);
  const [runName, setRunName] = useState("");
  const [detail, setDetail] = useState<TestRunDetail | null>(null);
  const [onlyFailed, setOnlyFailed] = useState(false);
  const [failureCatFilter, setFailureCatFilter] = useState<string | undefined>();
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    listRuns()
      .then((r) => setRuns(r.runs || []))
      .catch((e) => message.error(`任务列表加载失败：${(e as Error).message}`))
      .finally(() => setLoading(false));
  }, []);

  const refreshDatasets = useCallback(() => {
    listTestsetDatasets()
      .then((r) => {
        setDatasets(r.datasets || []);
        setSelDatasetId((prev) => prev || (r.datasets || [])[0]?.datasetId);
      })
      .catch(() => setDatasets([]));
  }, []);

  useEffect(() => {
    refresh();
    refreshDatasets();
  }, [refresh, refreshDatasets]);

  const hasRunning = useMemo(() => runs.some((r) => r.status === "running"), [runs]);
  const detailRunning = detail?.status === "running";

  useEffect(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (!hasRunning && !detailRunning) return;
    pollRef.current = setInterval(() => {
      listRuns().then((r) => setRuns(r.runs || [])).catch(() => {});
      if (detail) getRun(detail.runId).then(setDetail).catch(() => {});
    }, 3000);
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [hasRunning, detailRunning, detail]);

  const doCreate = useCallback(() => {
    if (!selDatasetId) { message.warning("请选择测试集"); return; }
    if (!selGraph) { message.warning("请选择评测图谱"); return; }
    setCreating(true);
    createRun({ datasetId: selDatasetId, graphId: selGraph, name: runName.trim() || undefined })
      .then((r) => {
        message.success(`任务已启动：${r.name}（${r.total} 条，串行评测中）`);
        setRunName("");
        refresh();
        getRun(r.runId).then(setDetail).catch(() => {});
      })
      .catch((e) => message.error(`启动失败：${(e as Error).message}`))
      .finally(() => setCreating(false));
  }, [selDatasetId, selGraph, runName, refresh]);

  const doDelete = useCallback((runId: string) => {
    deleteRun(runId)
      .then(() => { message.success("任务已删除"); setDetail((d) => (d && d.runId === runId ? null : d)); refresh(); })
      .catch((e) => message.error(`删除失败：${(e as Error).message}`));
  }, [refresh]);

  const doCancel = useCallback((runId: string) => {
    cancelRun(runId)
      .then((r) => { message.success(`已停止：已评测 ${r.done}/${r.total}`); refresh(); })
      .catch((e) => message.error(`停止失败：${(e as Error).message}`));
  }, [refresh]);

  const doDeleteDataset = useCallback(() => {
    if (!selDatasetId) return;
    deleteTestsetDataset(selDatasetId)
      .then(() => { message.success("测试集已删除"); setSelDatasetId(undefined); refreshDatasets(); })
      .catch((e) => message.error(`删除失败：${(e as Error).message}`));
  }, [selDatasetId, refreshDatasets]);

  const [compareOpen, setCompareOpen] = useState(false);
  const [compareBase, setCompareBase] = useState<TestRunListItem | null>(null);
  const [compareTargetId, setCompareTargetId] = useState<string | undefined>();
  const [comparing, setComparing] = useState(false);
  const [compareResult, setCompareResult] = useState<{ base: TestRunDetail; target: TestRunDetail } | null>(null);

  const openCompare = useCallback((r: TestRunListItem) => {
    setCompareBase(r);
    setCompareTargetId(undefined);
    setCompareResult(null);
    setCompareOpen(true);
  }, []);

  const doCompare = useCallback(() => {
    if (!compareBase || !compareTargetId) { message.warning("请选择对比基线任务"); return; }
    if (compareTargetId === compareBase.runId) { message.warning("不能与自身对比"); return; }
    setComparing(true);
    // base=基线（早先跑批），target=本次（点击行）；下方回归/修复判定与标签全按此方向渲染
    Promise.all([getRun(compareTargetId), getRun(compareBase.runId)])
      .then(([base, target]) => setCompareResult({ base, target }))
      .catch((e) => message.error(`对比失败：${(e as Error).message}`))
      .finally(() => setComparing(false));
  }, [compareBase, compareTargetId]);

  const compare = useMemo(() => {
    if (!compareResult) return null;
    const { base, target } = compareResult;
    const tMap = new Map(target.results.map((r) => [r.caseId, r]));
    const regress: TestRunResultRow[] = [];
    const improve: TestRunResultRow[] = [];
    let matched = 0;
    for (const b of base.results) {
      const t = tMap.get(b.caseId);
      if (!t) continue;
      matched += 1;
      if (!b.pass && t.pass) improve.push(t);
      else if (b.pass && !t.pass) regress.push(t);
    }
    const catDelta: { cat: string; from: number; to: number }[] = [];
    const cats = new Set([...Object.keys(base.summary?.byCategory || {}), ...Object.keys(target.summary?.byCategory || {})]);
    cats.forEach((cat) => {
      const bCat = base.summary?.byCategory?.[cat];
      const tCat = target.summary?.byCategory?.[cat];
      if (!bCat?.total || !tCat?.total) return;
      const from = bCat.passed / bCat.total;
      const to = tCat.passed / tCat.total;
      if (Math.abs(to - from) > 0.001) catDelta.push({ cat, from, to });
    });
    return {
      base, target, matched, regress, improve, catDelta,
      baseRate: base.summary?.total ? base.summary.passed / base.summary.total : 0,
      targetRate: target.summary?.total ? target.summary.passed / target.summary.total : 0,
    };
  }, [compareResult]);

  const openDetail = useCallback((runId: string) => {
    setFailureCatFilter(undefined);
    getRun(runId).then(setDetail).catch((e) => message.error(`加载失败：${(e as Error).message}`));
  }, []);

  const [remOpen, setRemOpen] = useState(false);
  const [remAnalysis, setRemAnalysis] = useState<RemediationAnalysis | null>(null);
  const [remLoading, setRemLoading] = useState(false);
  const [remSelGroups, setRemSelGroups] = useState<Set<string>>(new Set());
  const [remApplying, setRemApplying] = useState(false);
  const [remResult, setRemResult] = useState<{ versionId: string; graphId: string; batch: number; baseVersionId: string; applied: number; changes: string[]; nextStep: string } | null>(null);

  const openRemediation = useCallback(() => {
    if (!detail) return;
    setRemAnalysis(null);
    setRemResult(null);
    setRemSelGroups(new Set());
    setRemOpen(true);
    setRemLoading(true);
    analyzeRemediations(detail.runId)
      .then((a) => {
        setRemAnalysis(a);
        setRemSelGroups(new Set(a.groups.map((g) => g.intentId)));
      })
      .catch((e) => { message.error(`修复方案生成失败：${(e as Error).message}`); setRemOpen(false); })
      .finally(() => setRemLoading(false));
  }, [detail]);

  const doApplyRemediation = useCallback(() => {
    if (!detail || !remAnalysis) return;
    const caseIds = remAnalysis.groups.filter((g) => remSelGroups.has(g.intentId)).flatMap((g) => g.caseIds);
    if (!caseIds.length) { message.warning("请至少勾选一个意图的补强项"); return; }
    setRemApplying(true);
    applyRemediations({ runId: detail.runId, caseIds })
      .then((r) => { setRemResult(r); message.success(`已生成修复版本：${r.versionId}`); })
      .catch((e) => message.error(`应用失败：${(e as Error).message}`))
      .finally(() => setRemApplying(false));
  }, [detail, remAnalysis, remSelGroups]);

  const doRerunRemediated = useCallback(() => {
    if (!detail || !remResult) return;
    createRun({ datasetId: detail.datasetId, graphId: remResult.graphId, name: `${detail.name} × 修复验证` })
      .then((r) => {
        message.success(`验证跑批已启动：${r.name}（${r.total} 条）`);
        setRemOpen(false);
        refresh();
        getRun(r.runId).then(setDetail).catch(() => {});
      })
      .catch((e) => message.error(`启动失败：${(e as Error).message}`));
  }, [detail, remResult, refresh]);

  const listColumns = useMemo(() => [
    {
      title: "任务", key: "name", ellipsis: true,
      render: (_: unknown, r: TestRunListItem) => (
        <div>
          <div style={{ fontWeight: 600, fontSize: 13 }}>{r.name}</div>
          <div style={{ fontSize: 11, color: "#8c93a3" }}>{r.datasetId} · {fmtTime(r.startedAt)}</div>
        </div>
      ),
    },
    {
      title: "图谱", key: "graph", width: 200, ellipsis: true,
      render: (_: unknown, r: TestRunListItem) => (
        <Space size={4}>
          <Tag color={r.engine === "bank" ? "gold" : "geekblue"} style={{ marginRight: 0 }}>{r.engine === "bank" ? "银行引擎" : "v2"}</Tag>
          <span style={{ fontSize: 12, color: "#6b7280" }}>{r.graphLabel}</span>
        </Space>
      ),
    },
    {
      title: "状态", key: "status", width: 130,
      render: (_: unknown, r: TestRunListItem) => {
        const meta = STATUS_META[r.status] || { label: r.status, color: "default" };
        return (
          <Space size={6}>
            <Tag color={meta.color} style={{ marginRight: 0 }}>{meta.label}</Tag>
            {r.status === "running" && <span style={{ fontSize: 12, fontVariantNumeric: "tabular-nums" }}>{r.done}/{r.total}</span>}
          </Space>
        );
      },
    },
    {
      title: "通过率", key: "pass", width: 170,
      render: (_: unknown, r: TestRunListItem) => {
        const passed = r.summary?.passed ?? 0;
        const relaxed = r.summary?.relaxedPassed ?? 0;
        const total = r.summary?.total ?? r.done;
        const good = total > 0 && passed / total >= 0.8;
        return (
          <span style={{ fontWeight: 700, fontVariantNumeric: "tabular-nums", color: total ? (good ? "#52c41a" : "#f5222d") : "#98a1b2" }}>
            {total ? `${pct2(passed, total)}` : "-"}
            <span style={{ fontWeight: 400, fontSize: 11, color: "#8c93a3" }}> ({passed}/{total})</span>
            {total > 0 && relaxed !== passed && (
              <span style={{ fontWeight: 400, fontSize: 11, color: "#faad14", display: "block" }}>宽松 {pct2(relaxed, total)}</span>
            )}
          </span>
        );
      },
    },
    {
      title: "耗时", key: "dur", width: 80,
      render: (_: unknown, r: TestRunListItem) => <span style={{ fontSize: 12, fontVariantNumeric: "tabular-nums" }}>{duration(r.startedAt, r.finishedAt)}{r.status === "running" ? "+" : ""}</span>,
    },
    {
      title: "操作", key: "op", width: 190,
      render: (_: unknown, r: TestRunListItem) => (
        <Space size={2}>
          <Button size="small" type="link" style={{ padding: 0 }} onClick={(e) => { e.stopPropagation(); openDetail(r.runId); }}>报告</Button>
          {r.status === "running" && <Button size="small" type="link" style={{ padding: 0 }} onClick={(e) => { e.stopPropagation(); doCancel(r.runId); }}>停止</Button>}
          <Button size="small" type="link" style={{ padding: 0 }} onClick={(e) => { e.stopPropagation(); openCompare(r); }}>对比</Button>
          <Button size="small" type="link" danger style={{ padding: 0 }} onClick={(e) => { e.stopPropagation(); doDelete(r.runId); }}>删除</Button>
        </Space>
      ),
    },
  ], [openDetail, doCancel, openCompare, doDelete]);

  const detailRows: TestRunResultRow[] = useMemo(() => {
    if (!detail) return [];
    let rows = detail.results;
    if (onlyFailed) rows = rows.filter((r) => !r.pass);
    if (failureCatFilter) rows = rows.filter((r) => r.failureCategory === failureCatFilter);
    return rows;
  }, [detail, onlyFailed, failureCatFilter]);

  const s = detail?.summary;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Card size="small" title="新建跑批任务">
        <Space size={10} wrap>
          <Select
            showSearch optionFilterProp="label" placeholder="选择测试集" style={{ minWidth: 280 }}
            value={selDatasetId} onChange={setSelDatasetId}
            options={datasets.map((d) => ({ value: d.datasetId, label: `${d.datasetId}（${d.total} 条 · ${d.graph?.versionName || d.graph?.version || "?"}）` }))}
          />
          <Popconfirm
            title="删除该测试集？"
            description="仅删除数据集文件，已产生的跑批任务保留"
            okText="删除" cancelText="取消" okButtonProps={{ danger: true }}
            onConfirm={doDeleteDataset}
            disabled={!selDatasetId}
          >
            <Tooltip title="删除当前选中测试集">
              <Button size="small" icon={<DeleteOutlined />} disabled={!selDatasetId} />
            </Tooltip>
          </Popconfirm>
          <Select
            showSearch optionFilterProp="label" placeholder="评测图谱" style={{ minWidth: 240 }}
            value={selGraph} onChange={setSelGraph} options={graphOptions}
          />
          <Input
            placeholder="任务名（可选）" style={{ width: 200 }} value={runName}
            onChange={(e) => setRunName(e.target.value)} onPressEnter={doCreate}
          />
          <Button type="primary" loading={creating} onClick={doCreate}>
            <CaretRightOutlined /> 启动跑批
          </Button>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            建议选择与测试集同源的图谱（意图体系一致）；跨引擎结果仅供探查。v2 引擎逐条串行评测。
          </Typography.Text>
        </Space>
      </Card>

      <Card
        size="small"
        title={<Space size={8}>测试任务<Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>按启动时间归类的任务实例</Typography.Text></Space>}
        extra={<Button size="small" icon={<ReloadOutlined />} onClick={refresh}>刷新</Button>}
      >
        <Table
          size="small" rowKey="runId" loading={loading}
          dataSource={runs}
          columns={listColumns}
          pagination={{ pageSize: 10, size: "small", showSizeChanger: false }}
          locale={{ emptyText: <Empty description="还没有跑批任务：选择测试集与图谱，启动第一次跑批" /> }}
          onRow={(r) => ({ onClick: () => openDetail(r.runId), style: { cursor: "pointer" } })}
        />
      </Card>

      {detail && (
        <Card
          size="small"
          title={
            <Space size={8} wrap>
              任务报告：{detail.name}
              <Tag color={(STATUS_META[detail.status] || {}).color}>{(STATUS_META[detail.status] || {}).label}</Tag>
              {detail.status === "running" && <span style={{ fontSize: 12 }}>{detail.done}/{detail.total}</span>}
            </Space>
          }
          extra={
            <Space size={8}>
              <Checkbox checked={onlyFailed} onChange={(e) => setOnlyFailed(e.target.checked)}>仅看失败</Checkbox>
              {detail.engine === "v2" && (
                <Tooltip title="把图谱侧失败样本转成修复建议：补强召回词群，生成候选图谱版本">
                  <Button size="small" icon={<ToolOutlined />} onClick={openRemediation}>修复方案</Button>
                </Tooltip>
              )}
              <Select
                size="small" allowClear placeholder="失败原因筛选" style={{ minWidth: 160 }}
                value={failureCatFilter} onChange={setFailureCatFilter}
                options={Object.entries(s?.byFailureCategory || {}).map(([cat, count]) => ({
                  value: cat,
                  label: `${(FAILURE_META[cat] || { label: cat }).label}（${count}）`,
                }))}
              />
              {detail.status === "running" && (
                <Button size="small" danger icon={<StopOutlined />} onClick={() => doCancel(detail.runId)}>停止</Button>
              )}
              <Button size="small" onClick={() => setDetail(null)}>收起</Button>
            </Space>
          }
        >
          <div className="trn-summary">
            <div className="trn-kpi">
              <div className="trn-kpi-value" style={{ color: s && s.total && s.passed / s.total >= 0.8 ? "#52c41a" : "#f5222d" }}>
                {s && s.total ? pct2(s.passed, s.total) : "-"}
              </div>
              <div className="trn-kpi-label">精确通过率（{s?.passed ?? 0}/{s?.total ?? 0}）</div>
            </div>
            <div className="trn-kpi">
              <div className="trn-kpi-value" style={{ color: s && s.total && (s.relaxedPassed ?? 0) / s.total >= 0.8 ? "#52c41a" : "#faad14" }}>
                {s && s.total ? pct2(s.relaxedPassed ?? 0, s.total) : "-"}
              </div>
              <Tooltip title="别名也算对：引擎返回的意图名与期望不同但属于同一意图（如同义词、别称）">
                <div className="trn-kpi-label" style={{ cursor: "help", textDecoration: "underline dotted" }}>宽松通过率（{s?.relaxedPassed ?? 0}/{s?.total ?? 0}）</div>
              </Tooltip>
            </div>
            <div className="trn-kpi">
              <div className="trn-kpi-value">{s?.avgLatencyMs ? `${(s.avgLatencyMs / 1000).toFixed(1)}s` : "-"}</div>
              <div className="trn-kpi-label">平均每条耗时</div>
            </div>
            <div className="trn-kpi">
              <div className="trn-kpi-value">{s?.p50LatencyMs ? `${(s.p50LatencyMs / 1000).toFixed(1)}s` : "-"}</div>
              <Tooltip title="一半的测试用例快于此值">
                <div className="trn-kpi-label" style={{ cursor: "help", textDecoration: "underline dotted" }}>中位耗时</div>
              </Tooltip>
            </div>
            <div className="trn-kpi">
              <div className="trn-kpi-value" style={{ color: s?.p90LatencyMs && s.p90LatencyMs > 15000 ? "#faad14" : undefined }}>
                {s?.p90LatencyMs ? `${(s.p90LatencyMs / 1000).toFixed(1)}s` : "-"}
              </div>
              <Tooltip title="90% 的测试用例快于此值，反映最慢情况">
                <div className="trn-kpi-label" style={{ cursor: "help", textDecoration: "underline dotted" }}>90%用例耗时</div>
              </Tooltip>
            </div>
            {s?.degradedCount != null && s.degradedCount > 0 && (
              <div className="trn-kpi">
                <div className="trn-kpi-value" style={{ color: "#f5222d" }}>
                  {s.total ? pct2(s.degradedCount, s.total) : "-"}
                </div>
                <Tooltip title="AI 判断环节出错或超时，引擎退回关键词+语义排序兜底——这类结果可靠性较低">
                  <div className="trn-kpi-label" style={{ cursor: "help", textDecoration: "underline dotted" }}>AI判断异常率（{s.degradedCount}/{s?.total ?? 0}）</div>
                </Tooltip>
              </div>
            )}
            {s?.totalTokensUsed != null && s.totalTokensUsed > 0 && (
              <div className="trn-kpi">
                <div className="trn-kpi-value" style={{ fontSize: 20 }}>
                  {s.totalTokensUsed >= 10000 ? `${(s.totalTokensUsed / 1000).toFixed(1)}k` : s.totalTokensUsed}
                </div>
                <Tooltip title="本次跑批总共消耗的大模型 Token 数量，反映 AI 判断的调用量">
                  <div className="trn-kpi-label" style={{ cursor: "help", textDecoration: "underline dotted" }}>AI 用量</div>
                </Tooltip>
              </div>
            )}
            {Object.entries(s?.byCategory || {}).map(([cat, v]) => (
              <div className="trn-kpi" key={cat}>
                <div className="trn-kpi-value" style={{ fontSize: 20, color: v.passed / v.total >= 0.8 ? "#52c41a" : "#f5222d" }}>
                  {pct2(v.passed, v.total)}
                </div>
                <div className="trn-kpi-label">{CATEGORY_LABELS[cat] || cat}（{v.passed}/{v.total}）</div>
              </div>
            ))}
            {Object.entries(s?.byFailureCategory || {}).length > 0 && (
              <div className="trn-kpi" style={{ minWidth: 200 }}>
                <div className="trn-kpi-label" style={{ marginBottom: 4 }}>失败原因分布</div>
                <Space size={4} wrap>
                  {Object.entries(s?.byFailureCategory || {})
                    .sort((a, b) => b[1] - a[1])
                    .map(([cat, count]) => {
                      const meta = FAILURE_META[cat] || { label: cat, color: "default", desc: "" };
                      return (
                        <Tooltip key={cat} title={meta.desc}>
                          <Tag color={meta.color} style={{ marginRight: 0, cursor: "help" }}>{meta.label} {count}</Tag>
                        </Tooltip>
                      );
                    })}
                </Space>
              </div>
            )}
            {detail.status === "running" && (
              <div className="trn-kpi" style={{ minWidth: 160 }}>
                <Progress percent={detail.total ? Math.round((detail.done / detail.total) * 100) : 0} status="active" size="small" />
                <div className="trn-kpi-label">已评测 {detail.done}/{detail.total}</div>
              </div>
            )}
          </div>

          {detail.error && <Typography.Text type="danger" style={{ fontSize: 12 }}>{detail.error}</Typography.Text>}

          <Table
            size="small"
            rowKey="caseId"
            dataSource={detailRows}
            pagination={{ pageSize: 10, size: "small", showSizeChanger: false }}
            expandable={{
              rowExpandable: () => true,
              expandedRowRender: (r) => {
                const expectedHit = r.expectedDisplay;
                const layers = [
                  { label: "①关键词匹配", key: "local", data: r.recallDetail?.local },
                  { label: "②语义搜索", key: "embedding", data: r.recallDetail?.embedding },
                  { label: "③AI判断", key: "llmJudge", data: r.recallDetail?.llmJudge },
                ] as { label: string; key: string; data: { name: string; score: number; reason?: string } | null | undefined }[];
                const finalPick = r.actualDisplay || "（空）";
                const localHit = r.recallDetail?.local?.name === expectedHit;
                const embedHit = r.recallDetail?.embedding?.name === expectedHit;
                const judgeHit = r.recallDetail?.llmJudge?.name === expectedHit;

                // 生成来龙去脉分析文本
                const chainParts: string[] = [];
                if (r.recallDetail) {
                  if (r.recallDetail.local) chainParts.push(`关键词匹配找到「${r.recallDetail.local.name}」${localHit ? "✓找对了" : "✗找错了"}`);
                  if (r.recallDetail.embedding) chainParts.push(`语义搜索找到「${r.recallDetail.embedding.name}」${embedHit ? "✓找对了" : "✗找错了"}`);
                  if (r.recallDetail.llmJudge) chainParts.push(`AI判断选定「${r.recallDetail.llmJudge.name}」${judgeHit ? "✓选对了" : "✗选错了"}`);
                }

                let analysis = "";
                if (r.pass) {
                  const parts: string[] = [];
                  parts.push(`用户问「${r.query}」，引擎识别为「${finalPick}」，与期望一致，通过。`);
                  if (chainParts.length) parts.push(`识别过程：${chainParts.join(" → ")}`);
                  analysis = parts.join(" ");
                } else if (r.relaxedPass) {
                  const parts: string[] = [];
                  parts.push(`用户问「${r.query}」，引擎返回「${finalPick}」，虽然名字跟期望「${expectedHit}」不同，但属于同一意图（同义词/别称），算通过。`);
                  if (chainParts.length) parts.push(`识别过程：${chainParts.join(" → ")}`);
                  analysis = parts.join(" ");
                } else {
                  const parts: string[] = [];
                  parts.push(`用户问「${r.query}」，期望引擎识别为「${expectedHit}」，但引擎实际返回了「${finalPick}」，判为失败。`);
                  if (chainParts.length) parts.push(`识别过程：${chainParts.join(" → ")}`);
                  if (r.degraded) {
                    const dm = decisionModeLabel(r.decisionMode);
                    parts.push(`⚠ AI判断环节异常（${dm.label}），引擎退回关键词+语义排序兜底，结果可靠性较低。`);
                    if (r.recallDetail?.llmJudge?.reason) {
                      parts.push(`异常说明：${r.recallDetail.llmJudge.reason}`);
                    }
                  } else if (r.recallDetail?.llmJudge?.reason) {
                    parts.push(`AI判断理由：${r.recallDetail.llmJudge.reason}`);
                  }
                  const cat = r.failureCategory;
                  if (cat && FAILURE_META[cat]) {
                    parts.push(`失败原因：${FAILURE_META[cat].label}——${FAILURE_META[cat].desc}`);
                  }
                  analysis = parts.join(" ");
                }

                return (
                  <div style={{ fontSize: 12, color: "#4b5563", display: "flex", flexDirection: "column", gap: 10, padding: "4px 0" }}>
                    {/* 1. 来龙去脉分析 */}
                    <div style={{
                      background: r.pass ? "#f6ffed" : r.relaxedPass ? "#fffbe6" : "#fff2f0",
                      border: `1px solid ${r.pass ? "#b7eb8f" : r.relaxedPass ? "#ffe58f" : "#ffccc7"}`,
                      borderRadius: 6, padding: "8px 12px",
                    }}>
                      <div style={{ fontWeight: 600, marginBottom: 4, color: "#374151" }}>
                        来龙去脉分析
                      </div>
                      <div style={{ lineHeight: 1.8 }}>{analysis}</div>
                    </div>

                    {/* 2. 识别过程 · 三步各找了什么 */}
                    {r.recallDetail && (
                      <div>
                        <div style={{ marginBottom: 6, fontWeight: 600, color: "#374151" }}>
                          识别过程 · 三步各找了什么
                          <span style={{ fontWeight: 400, fontSize: 11, color: "#8c93a3", marginLeft: 8 }}>
                            绿色=该步找对了，红色=该步找错了
                          </span>
                        </div>
                        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                          {layers.map((layer) => {
                            const hit = layer.data && layer.data.name === expectedHit;
                            return (
                              <div key={layer.key} style={{
                                border: `1px solid ${hit ? "#b7eb8f" : layer.data ? "#ffccc7" : "#eef0f4"}`,
                                borderRadius: 6, padding: "6px 12px", minWidth: 160,
                                background: hit ? "#f6ffed" : layer.data ? "#fff2f0" : undefined,
                              }}>
                                <div style={{ fontSize: 11, color: "#8c93a3", marginBottom: 2 }}>{layer.label}</div>
                                {layer.data ? (
                                  <>
                                    <div style={{ fontWeight: 600, color: hit ? "#389e0d" : "#cf1322" }}>
                                      {hit ? "✓" : "✗"} {layer.data.name}
                                    </div>
                                    <div style={{ fontSize: 11, color: "#8c93a3" }}>匹配度: {scoreText(layer.data.score)}</div>
                                    {layer.key === "llmJudge" && layer.data.reason && (
                                      <div style={{ marginTop: 4, color: "#6b7280", fontSize: 11, maxWidth: 280, lineHeight: 1.5, borderTop: "1px dashed #eef0f4", paddingTop: 4 }}>
                                        {layer.data.reason}
                                      </div>
                                    )}
                                  </>
                                ) : (
                                  <div style={{ color: "#bfbfbf" }}>— 未启用 —</div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* 3. 引擎考虑了哪些选项 */}
                    {!!r.candidates?.length && (
                      <div>
                        <div style={{ marginBottom: 6, fontWeight: 600, color: "#374151" }}>
                          引擎考虑了哪些选项（共{r.candidates.length}个）
                          <span style={{ fontWeight: 400, fontSize: 11, color: "#8c93a3", marginLeft: 8 }}>
                            绿色=正确答案，橙色=引擎实际选的
                          </span>
                        </div>
                        <Space size={6} wrap>
                          {r.candidates.map((c, i) => {
                            const isExpected = c.name === expectedHit;
                            const isPicked = c.name === r.actualDisplay;
                            return (
                              <Tag key={i} color={isExpected ? "green" : isPicked ? "orange" : "default"}>
                                {i + 1}. {c.name} · 匹配度{scoreText(c.score)}{isExpected ? " ✓正确答案" : ""}{isPicked && !isExpected ? " ←引擎选的" : ""}
                              </Tag>
                            );
                          })}
                        </Space>
                        <div style={{ marginTop: 4, fontSize: 11, color: "#8c93a3" }}>
                          正确答案「{expectedHit}」 · 引擎最终选了「{finalPick}」{(r.pass || r.relaxedPass) ? "✓选对了" : "✗选错了"}
                        </div>
                      </div>
                    )}

                    {/* 4. 引擎运行参数 */}
                    {(r.degraded || r.decisionMode || r.totalTokens || r.shape || r.sources?.length) && (
                      <div style={{ borderTop: "1px dashed #eef0f4", paddingTop: 8 }}>
                        <div style={{ marginBottom: 6, fontWeight: 600, color: "#374151" }}>引擎运行参数</div>
                        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                          {r.degraded && <span style={{ color: "#f5222d" }}>⚠ AI判断异常，降级兜底</span>}
                          {r.decisionMode && <span><b>决策方式:</b> <Tooltip title={decisionModeLabel(r.decisionMode).desc}><span style={{ cursor: "help", textDecoration: "underline dotted" }}>{decisionModeLabel(r.decisionMode).label}</span></Tooltip></span>}
                          {r.shape && <span><b>识别类型:</b> {shapeLabel(r.shape)}</span>}
                          {r.totalTokens != null && r.totalTokens > 0 && <span><b>AI用量:</b> {r.totalTokens}</span>}
                          {!!r.sources?.length && <span><b>数据来源:</b> {r.sources.map(sourceLabel).join("、")}</span>}
                        </div>
                      </div>
                    )}
                  </div>
                );
              },
            }}
            columns={[
              {
                title: "结果", key: "pass", width: 80,
                render: (_: unknown, r: TestRunResultRow) => (
                  <Space size={3}>
                    {r.pass
                      ? <Tag color="success" style={{ marginRight: 0 }}>通过</Tag>
                      : r.relaxedPass
                        ? <Tag color="warning" style={{ marginRight: 0 }}>宽松</Tag>
                        : <Tag color="error" style={{ marginRight: 0 }}>失败</Tag>}
                    {r.degraded && <Tooltip title="AI 判断环节异常，退回关键词+语义排序兜底"><Tag color="error" style={{ marginRight: 0, fontSize: 10, padding: "0 4px" }}>AI异常</Tag></Tooltip>}
                  </Space>
                ),
              },
              { title: "问法", dataIndex: "query", ellipsis: true },
              {
                title: "类别", key: "cat", width: 90,
                render: (_: unknown, r: TestRunResultRow) => <span style={{ fontSize: 12, color: "#6b7280" }}>{CATEGORY_LABELS[r.category] || r.category}/{r.subcategory}</span>,
              },
              { title: "期望", dataIndex: "expectedDisplay", ellipsis: true, width: 160 },
              { title: "实际", dataIndex: "actualDisplay", ellipsis: true, width: 160 },
              {
                title: "识别路径", key: "recall", width: 200, ellipsis: true,
                render: (_: unknown, r: TestRunResultRow) => {
                  if (!r.recallDetail) return <span style={{ color: "#bfbfbf", fontSize: 11 }}>-</span>;
                  const rd = r.recallDetail;
                  const layers: { label: string; name: string; hit: boolean }[] = [];
                  if (rd.local) layers.push({ label: "关键词", name: rd.local.name, hit: rd.local.name === r.expectedDisplay });
                  if (rd.embedding) layers.push({ label: "语义", name: rd.embedding.name, hit: rd.embedding.name === r.expectedDisplay });
                  if (rd.llmJudge) layers.push({ label: "AI判断", name: rd.llmJudge.name, hit: rd.llmJudge.name === r.expectedDisplay });
                  if (!layers.length) return <span style={{ color: "#bfbfbf", fontSize: 11 }}>-</span>;
                  return (
                    <Tooltip title="引擎分三步识别意图：①关键词匹配 ②语义搜索 ③AI判断。绿色=该步找对了，红色=该步找错了">
                      <Space size={2} wrap>
                        {layers.map((l, i) => (
                          <span key={i} style={{ fontSize: 11 }}>
                            <span style={{ color: "#8c93a3" }}>{l.label}:</span>
                            <span style={{ color: l.hit ? "#52c41a" : "#f5222d", fontWeight: l.hit ? 600 : 400 }}>
                              {l.name}
                            </span>
                            {i < layers.length - 1 && <span style={{ color: "#d9d9d9" }}> → </span>}
                          </span>
                        ))}
                      </Space>
                    </Tooltip>
                  );
                },
              },
              {
                title: "失败原因", key: "note", width: 120,
                render: (_: unknown, r: TestRunResultRow) => {
                  if (r.pass) return <Tag color="success" style={{ marginRight: 0 }}>通过</Tag>;
                  const cat = r.failureCategory;
                  if (cat && FAILURE_META[cat]) {
                    return (
                      <Tooltip title={FAILURE_META[cat].desc}>
                        <Tag color={FAILURE_META[cat].color} style={{ marginRight: 0, cursor: "help" }}>{FAILURE_META[cat].label}</Tag>
                      </Tooltip>
                    );
                  }
                  return r.note ? <Tag color="volcano" style={{ marginRight: 0 }}>{r.note}</Tag> : "-";
                },
              },
              {
                title: "耗时", key: "lat", width: 70,
                render: (_: unknown, r: TestRunResultRow) => (
                  <span style={{ fontSize: 12, fontVariantNumeric: "tabular-nums", color: r.latencyMs > 15000 ? "#faad14" : undefined }}>
                    {r.latencyMs ? formatMs(r.latencyMs) : "-"}
                  </span>
                ),
              },
            ]}
          />
        </Card>
      )}

      <Modal
        title="跑批对比"
        open={compareOpen}
        onCancel={() => setCompareOpen(false)}
        footer={null}
        width={880}
      >
        <Space size={10} wrap style={{ marginBottom: 14 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>本次：{compareBase?.name}</span>
          <Select
            showSearch optionFilterProp="label" placeholder="选择基线任务（早先的一次跑批）"
            style={{ minWidth: 300 }} value={compareTargetId} onChange={setCompareTargetId}
            options={runs
              .filter((r) => r.runId !== compareBase?.runId
                && (r.datasetId === compareBase?.datasetId || (compareBase?.planId && r.planId === compareBase.planId)))
              .map((r) => ({ value: r.runId, label: `${r.name}（${r.graphLabel} · ${r.summary?.passed ?? 0}/${r.summary?.total ?? r.done}）` }))}
          />
          <Button type="primary" loading={comparing} disabled={!compareTargetId} onClick={doCompare}>开始对比</Button>
        </Space>
        {compare && (
          <div style={{ display: "grid", gap: 12 }}>
            <div className="trn-summary">
              <div className="trn-kpi">
                <div className="trn-kpi-value" style={{ fontSize: 20 }}>
                  {rateText(compare.baseRate)} → {rateText(compare.targetRate)}
                </div>
                <div className="trn-kpi-label">整体通过率（基线 → 本次）</div>
              </div>
              <div className="trn-kpi">
                <div className="trn-kpi-value" style={{ fontSize: 20, color: compare.regress.length ? "#f5222d" : "#52c41a" }}>{compare.regress.length}</div>
                <div className="trn-kpi-label">回归（基线通过 → 本次失败）</div>
              </div>
              <div className="trn-kpi">
                <div className="trn-kpi-value" style={{ fontSize: 20, color: "#52c41a" }}>{compare.improve.length}</div>
                <div className="trn-kpi-label">修复（基线失败 → 本次通过）</div>
              </div>
            </div>
            {compare.catDelta.length ? (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {compare.catDelta.map((d) => (
                  <Tag key={d.cat} color={d.to >= d.from ? "green" : "red"} style={{ marginRight: 0 }}>
                    {CATEGORY_LABELS[d.cat] || d.cat}：{rateText(d.from)} → {rateText(d.to)}
                  </Tag>
                ))}
              </div>
            ) : null}
            {[
              { title: "回归用例（重点排查本次改动伤到了什么）", rows: compare.regress, color: "#f5222d" },
              { title: "修复用例（本次改动带来的收益）", rows: compare.improve, color: "#52c41a" },
            ].map((sec) => (
              <div key={sec.title} style={{ border: "1px solid #eef0f4", borderRadius: 8, padding: 10 }}>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: sec.color }}>{sec.title}（{sec.rows.length}）</div>
                {sec.rows.length ? (
                  <div style={{ display: "grid", gap: 6, maxHeight: 240, overflow: "auto" }}>
                    {sec.rows.map((r) => (
                      <div key={r.caseId} style={{ fontSize: 12, borderBottom: "1px dashed #f0f1f5", paddingBottom: 6 }}>
                        <div style={{ fontWeight: 600 }}>{r.query}</div>
                        <div style={{ color: "#6b7280" }}>期望 {r.expectedDisplay} ｜ 实际 {r.actualDisplay}{r.note ? ` ｜ ${r.note}` : ""}</div>
                      </div>
                    ))}
                  </div>
                ) : <span style={{ fontSize: 12, color: "#8c93a3" }}>无</span>}
              </div>
            ))}
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              按 caseId 对齐，共匹配 {compare.matched} 条 · 基线：{compare.base.name}（{compare.base.graphLabel}）
            </Typography.Text>
          </div>
        )}
      </Modal>

      <Modal
        title={
          <Space size={8}>
            <ToolOutlined /> 消解优化 · 图谱修复方案
            {remAnalysis && <Tag color="geekblue" style={{ marginRight: 0 }}>{remAnalysis.baseVersionId}</Tag>}
          </Space>
        }
        open={remOpen}
        onCancel={() => setRemOpen(false)}
        width={820}
        footer={remResult ? (
          <Space>
            <Button icon={<DownloadOutlined />} onClick={() => {
              if (detail) window.open(`/api/intent-testset/runs/${detail.runId}/remediation-report`, "_blank");
            }}>下载修复报告</Button>
            <Button onClick={() => setRemOpen(false)}>关闭</Button>
            <Button type="primary" onClick={doRerunRemediated}>
              <CaretRightOutlined /> 用新图谱重跑同测试集
            </Button>
          </Space>
        ) : (
          <Space>
            <Button onClick={() => setRemOpen(false)}>取消</Button>
            <Button icon={<DownloadOutlined />} disabled={!remAnalysis} onClick={() => {
              if (detail) window.open(`/api/intent-testset/runs/${detail.runId}/remediation-report`, "_blank");
            }}>下载修复报告</Button>
            <Button type="primary" loading={remApplying} disabled={!remAnalysis || !remAnalysis.eligible} onClick={doApplyRemediation}>
              生成修复版本并注册
            </Button>
          </Space>
        )}
      >
        {remLoading && (
          <div style={{ textAlign: "center", padding: "36px 0" }}>
            <Typography.Text type="secondary">正在分析失败样本…</Typography.Text>
          </div>
        )}
        {!remLoading && remResult && (
          <div style={{ display: "grid", gap: 10 }}>
            <div style={{ fontSize: 13 }}>
              已生成候选版本 <Tag color="geekblue">{remResult.graphId}</Tag>
              补强 {remResult.applied} 条问法，未切 active（原 {remResult.baseVersionId} 保持不变）。
            </div>
            <div style={{ border: "1px solid #eef0f4", borderRadius: 8, padding: 10, display: "grid", gap: 6 }}>
              {remResult.changes.map((c, i) => (
                <div key={i} style={{ fontSize: 12, color: "#4b5563" }}>· {c}</div>
              ))}
            </div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>{remResult.nextStep}</Typography.Text>
          </div>
        )}
        {!remLoading && !remResult && remAnalysis && (
          <div style={{ display: "grid", gap: 12 }}>
            <div style={{ fontSize: 13 }}>
              跑批「{remAnalysis.runName}」共失败 <b>{remAnalysis.failedTotal}</b> 条，
              其中 <b style={{ color: remAnalysis.eligible ? "#1677ff" : "#98a1b2" }}>{remAnalysis.eligible}</b> 条可自动补强
              （{remAnalysis.groups.length} 个意图），其余 {remAnalysis.failedTotal - remAnalysis.eligible} 条需人工处理。
            </div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>{remAnalysis.action}</Typography.Text>
            {remAnalysis.groups.length ? (
              <div style={{ display: "grid", gap: 8, maxHeight: 300, overflow: "auto" }}>
                {remAnalysis.groups.map((g) => (
                  <div key={g.intentId} style={{ border: "1px solid #eef0f4", borderRadius: 8, padding: 10 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                      <Checkbox
                        checked={remSelGroups.has(g.intentId)}
                        onChange={(e) => setRemSelGroups((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(g.intentId); else next.delete(g.intentId);
                          return next;
                        })}
                      />
                      <span style={{ fontWeight: 600, fontSize: 13 }}>{g.intentName}</span>
                      {g.categories.map((c) => (
                        <Tag key={c} color={(FAILURE_META[c] || { color: "default" }).color} style={{ marginRight: 0 }}>
                          {(FAILURE_META[c] || { label: c }).label}
                        </Tag>
                      ))}
                      <span style={{ fontSize: 12, color: "#8c93a3" }}>+{g.queries.length} 条问法</span>
                    </div>
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap", paddingLeft: 22 }}>
                      {g.queries.map((q, i) => <Tag key={i} style={{ marginRight: 0 }}>{q}</Tag>)}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <Empty description="没有可自动补强的失败样本（全部需人工归因或属引擎侧归因）" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            )}
            {Object.keys(remAnalysis.skipped.counts).length > 0 && (
              <div style={{ fontSize: 12, color: "#8c93a3" }}>
                跳过明细：
                {Object.entries(remAnalysis.skipped.counts).map(([reason, n]) => ` ${reason}×${n}`).join("；")}
                {remAnalysis.skipped.samples.length > 0 && (
                  <div style={{ marginTop: 4 }}>
                    示例：{remAnalysis.skipped.samples.slice(0, 3).map((s) => `「${s.query}」`).join("、")}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
