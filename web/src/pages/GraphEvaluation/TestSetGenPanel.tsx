import { useCallback, useMemo, useRef, useState } from "react";
import {
  Alert, Button, Card, Checkbox, Collapse, Descriptions, Empty, InputNumber,
  Progress, Select, Space, Spin, Table, Tag, Typography, message,
} from "antd";
import { CaretRightOutlined, DownloadOutlined, ExperimentOutlined, ThunderboltOutlined } from "@ant-design/icons";
import {
  createTestCase, getTestSetJob, loadTestSetDataset, scaffoldTestSet, seedFallbackTestSet, startGenerateTestSet,
  type GeneratedTestSetCase, type TestSetGenerateResult, type TestSetPlanOptions, type TestSetScaffoldResult,
} from "./api";

const AMBIGUOUS_SUBOPTIONS = [
  { value: "declared", label: "声明歧义" },
  { value: "shared", label: "同面歧义" },
  { value: "underspecified", label: "缺槽位" },
  { value: "vague", label: "泛指含糊" },
  { value: "oos", label: "超范围" },
];
const STYLE_OPTIONS = [
  { value: "colloquial", label: "口语化" },
  { value: "ellipsis", label: "省略式" },
  { value: "detail", label: "具体参数" },
  { value: "polite", label: "礼貌措辞" },
  { value: "typo", label: "错字扰动" },
];
const MULTI_SUB_LABELS: Record<string, string> = {
  within_domain: "同域组合", cross_domain: "跨域组合", ask_do: "问办组合", query_change: "查改组合",
};
const AMB_SUB_LABELS: Record<string, string> = Object.fromEntries(AMBIGUOUS_SUBOPTIONS.map((o) => [o.value, o.label]));
const STYLE_LABELS: Record<string, string> = Object.fromEntries(STYLE_OPTIONS.map((o) => [o.value, o.label]));
const DIFFICULTY_LEVELS = ["easy", "medium", "hard", "super"];
const DIFFICULTY_LABELS: Record<string, string> = { easy: "易", medium: "中", hard: "难", super: "超难" };
const DIFFICULTY_PRESETS: { value: string; label: string; mix?: Record<string, number> }[] = [
  { value: "none", label: "不指定（沿用风格轴）" },
  { value: "balanced", label: "均衡：易中难超各 1 份", mix: { easy: 1, medium: 1, hard: 1, super: 1 } },
  { value: "basic", label: "偏易：重基础口语与参数", mix: { easy: 4, medium: 3, hard: 1, super: 0 } },
  { value: "advanced", label: "偏难：错字+多条件叠加", mix: { easy: 1, medium: 2, hard: 3, super: 2 } },
  { value: "stress", label: "冲刺超难：间接指代为主", mix: { easy: 0, medium: 1, hard: 2, super: 5 } },
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function expectedText(expected: any): string {
  if (!expected) return "-";
  if (Array.isArray(expected.candidateNames) && expected.candidateNames.length) return `澄清候选：${expected.candidateNames.join(" / ")}`;
  if (Array.isArray(expected.steps)) return expected.steps.map((s: { intentName?: string }) => s.intentName).filter(Boolean).join(" + ");
  return expected.intentName || expected.note || expected.resolution || "-";
}

function categoryTag(category: string, subcategory: string) {
  const color = category === "SINGLE_INTENT" ? "blue" : category === "MULTI_INTENT" ? "gold" : "purple";
  const subLabel = category === "MULTI_INTENT" ? MULTI_SUB_LABELS[subcategory] : category === "AMBIGUOUS_INTENT" ? AMB_SUB_LABELS[subcategory] : subcategory === "knowledge" ? "知识问答" : "业务办理";
  return (
    <Space size={4}>
      <Tag color={color} style={{ marginRight: 0 }}>{category === "SINGLE_INTENT" ? "单意图" : category === "MULTI_INTENT" ? "多意图" : "模糊意图"}</Tag>
      <span style={{ fontSize: 12, color: "#6b7280" }}>{subLabel || subcategory}</span>
    </Space>
  );
}

export default function TestSetGenPanel({ onImported }: { onImported?: () => void }) {
  const [singleCount, setSingleCount] = useState(10);
  const [multiCount, setMultiCount] = useState(8);
  const [ambiguousCount, setAmbiguousCount] = useState(8);
  const [ambMix, setAmbMix] = useState<Record<string, boolean>>({ declared: true, shared: true, underspecified: true, vague: true, oos: true });
  const [domains, setDomains] = useState<string[]>([]);
  const [perTargetCount, setPerTargetCount] = useState(3);
  const [styles, setStyles] = useState<string[]>(["colloquial", "ellipsis", "detail", "polite"]);
  const [difficultyPreset, setDifficultyPreset] = useState("none");
  const [confusableBias, setConfusableBias] = useState(false);
  const [scaffold, setScaffold] = useState<TestSetScaffoldResult | null>(null);
  const [dataset, setDataset] = useState<TestSetGenerateResult | null>(null);
  const [planning, setPlanning] = useState(false);
  const [synthesizing, setSynthesizing] = useState(false);
  const [jobProgress, setJobProgress] = useState<{ done: number; total: number } | null>(null);
  const [importing, setImporting] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<React.Key[]>([]);
  const generateEpoch = useRef(0);

  const buildOptions = useCallback((): TestSetPlanOptions => {
    const preset = DIFFICULTY_PRESETS.find((p) => p.value === difficultyPreset);
    return {
      singleCount, multiCount, ambiguousCount, ambiguousMix: ambMix, domains, perTargetCount, styles,
      ...(preset && preset.mix ? { difficultyMix: preset.mix } : {}),
      ...(confusableBias ? { confusableBias: true } : {}),
    };
  }, [singleCount, multiCount, ambiguousCount, ambMix, domains, perTargetCount, styles, difficultyPreset, confusableBias]);

  const acceptDataset = useCallback((res: TestSetGenerateResult, label: string) => {
    setDataset(res);
    setSelectedKeys(res.cases.map((c) => c.caseId));
    if (res.fallbackUsed) {
      message.warning("AI 合成不可用，已使用模板问法替代");
    } else if (res.resumedTargets && res.pendingTargets === 0) {
      message.success(`${label}完成：全部复用已有进度（${res.summary.total} 条用例，无需重新生成）`);
    } else if (res.resumedTargets) {
      message.success(`${label}完成：复用 ${res.resumedTargets} 个已有目标 + 新生成 ${res.pendingTargets} 个，共 ${res.summary.total} 条用例`);
    } else {
      message.success(`${label}完成：${res.summary.total} 条用例`);
    }
  }, []);

  const doGenerate = useCallback(() => {
    setPlanning(true);
    scaffoldTestSet(buildOptions())
      .then((res) => {
        setScaffold(res);
        setDataset(null);
        setSelectedKeys([]);
        setDomains((prev) => (prev.length ? prev : []));
        // scaffold 完成后立即启动 AI 生成
        const epoch = ++generateEpoch.current;
        setSynthesizing(true);
        setPlanning(false);
        setJobProgress(null);
        const poll = async (jobId: string): Promise<void> => {
          for (;;) {
            await new Promise((r) => setTimeout(r, 1500));
            if (generateEpoch.current !== epoch) return;
            const status = await getTestSetJob(jobId);
            if (generateEpoch.current !== epoch) return;
            setJobProgress({ done: status.done, total: status.total });
            if (status.status === "completed") {
              const ds = await loadTestSetDataset(status.datasetId as string);
              if (generateEpoch.current !== epoch) return;
              acceptDataset(ds, "生成测试集");
              return;
            }
            if (status.status === "failed") throw new Error(status.error || "生成任务失败");
          }
        };
        startGenerateTestSet(res.planId)
          .then((job) => {
            setJobProgress({ done: job.done, total: job.total });
            return poll(job.jobId);
          })
          .catch((e) => {
            if (generateEpoch.current === epoch) {
              // AI 生成失败，自动降级到模板问法
              seedFallbackTestSet(res.planId)
                .then((ds) => acceptDataset(ds, "生成测试集"))
                .catch((e2) => message.error(`生成测试集失败：${(e2 as Error).message}`))
                .finally(() => { if (generateEpoch.current === epoch) setSynthesizing(false); });
            }
          })
          .finally(() => { if (generateEpoch.current === epoch) setSynthesizing(false); });
      })
      .catch((e) => {
        message.error(`生成测试集失败：${(e as Error).message}`);
        setPlanning(false);
      });
  }, [buildOptions, acceptDataset]);

  const runSeedFallback = useCallback((label: string) => {
    if (!scaffold) return;
    setSynthesizing(true);
    seedFallbackTestSet(scaffold.planId)
      .then((res) => acceptDataset(res, label))
      .catch((e) => message.error(`${label}失败：${(e as Error).message}`))
      .finally(() => setSynthesizing(false));
  }, [scaffold, acceptDataset]);

  // LLM 合成走异步 job：POST 立即返回 jobId，每 1.5s 轮询进度；服务端每批落盘，中断后同 plan 重新生成自动续跑
  const runGenerateAsync = useCallback((label: string) => {
    if (!scaffold) return;
    const epoch = ++generateEpoch.current;
    setSynthesizing(true);
    setJobProgress(null);
    const poll = async (jobId: string): Promise<void> => {
      for (;;) {
        await new Promise((r) => setTimeout(r, 1500));
        if (generateEpoch.current !== epoch) return;
        const status = await getTestSetJob(jobId);
        if (generateEpoch.current !== epoch) return;
        setJobProgress({ done: status.done, total: status.total });
        if (status.status === "completed") {
          const res = await loadTestSetDataset(status.datasetId as string);
          if (generateEpoch.current !== epoch) return;
          acceptDataset(res, label);
          return;
        }
        if (status.status === "failed") throw new Error(status.error || "生成任务失败");
      }
    };
    startGenerateTestSet(scaffold.planId)
      .then((job) => {
        setJobProgress({ done: job.done, total: job.total });
        return poll(job.jobId);
      })
      .catch((e) => {
        if (generateEpoch.current === epoch) message.error(`${label}失败：${(e as Error).message}`);
      })
      .finally(() => {
        if (generateEpoch.current === epoch) setSynthesizing(false);
      });
  }, [scaffold, acceptDataset]);

  const doImport = useCallback(() => {
    if (!dataset) return;
    const chosen = dataset.testRows.filter((_, idx) => selectedKeys.includes(dataset.cases[idx]?.caseId));
    if (!chosen.length) {
      message.warning("请先勾选要导入的用例");
      return;
    }
    setImporting(true);
    Promise.allSettled(chosen.map((row) => createTestCase(row)))
      .then((results) => {
        const ok = results.filter((r) => r.status === "fulfilled").length;
        const bad = results.length - ok;
        if (ok) message.success(`已导入 ${ok} 条到测试用例库`);
        if (bad) message.warning(`${bad} 条导入失败`);
        if (ok) onImported?.();
      })
      .finally(() => setImporting(false));
  }, [dataset, selectedKeys, onImported]);

  const doExport = useCallback(() => {
    if (!dataset) return;
    const blob = new Blob([JSON.stringify({ datasetId: dataset.datasetId, graph: dataset.graph, cases: dataset.cases }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${dataset.datasetId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [dataset]);

  const summaryChips = useMemo(() => {
    if (!scaffold) return null;
    const s = scaffold.planSummary;
    return (
      <Space size={8} wrap>
        <Tag color="blue">单意图目标 {s.byCategory.SINGLE_INTENT || 0}</Tag>
        <Tag color="gold">多意图目标 {s.byCategory.MULTI_INTENT || 0}</Tag>
        <Tag color="purple">模糊目标 {s.byCategory.AMBIGUOUS_INTENT || 0}</Tag>
        {s.byDifficulty && DIFFICULTY_LEVELS.filter((l) => s.byDifficulty && s.byDifficulty[l] > 0).map((l) => (
          <Tag key={l}>{DIFFICULTY_LABELS[l]} {s.byDifficulty ? s.byDifficulty[l] : 0}</Tag>
        ))}
        <Tag>预计用例 {s.expectedCases}</Tag>
      </Space>
    );
  }, [scaffold]);

  const suspectCount = useMemo(() => (dataset ? dataset.cases.filter((c) => c.suspect).length : 0), [dataset]);
  const diffCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const c of dataset?.cases || []) if (c.difficulty) m[c.difficulty] = (m[c.difficulty] || 0) + 1;
    return m;
  }, [dataset]);

  const caseColumns = useMemo(() => [
    {
      title: "类别", width: 200,
      render: (_: unknown, row: GeneratedTestSetCase) => categoryTag(row.category, row.subcategory),
    },
    { title: "问法", dataIndex: "query", ellipsis: true },
    { title: "期望", key: "expected", ellipsis: true, render: (_: unknown, row: GeneratedTestSetCase) => <span style={{ fontSize: 12, color: "#374151" }}>{expectedText(row.expected)}</span> },
    { title: "风格", dataIndex: "style", width: 90, render: (v: string) => <Tag style={{ marginRight: 0 }}>{STYLE_LABELS[v] || v}</Tag> },
    { title: "难度", dataIndex: "difficulty", width: 56, render: (v: string) => (v ? DIFFICULTY_LABELS[v] || v : "-") },
  ], []);

  return (
    <div className="tst-layout">
      <Card size="small" className="tst-config" title={
        <Space size={6}><ExperimentOutlined />生成配置</Space>
      }>
        <Descriptions column={1} size="small" className="tst-source">
          <Descriptions.Item label="意图源">{scaffold?.graph.versionName || scaffold?.graph.version || "评测器当前激活图谱"}</Descriptions.Item>
          {scaffold && (
            <Descriptions.Item label="规模">
              意图 {scaffold.stats.intentCount ?? "-"} · 可执行 {scaffold.stats.executableIntentCount ?? "-"} · 知识 {scaffold.stats.knowledgeIntentCount ?? "-"} · 域 {scaffold.stats.domainCount ?? "-"}
            </Descriptions.Item>
          )}
        </Descriptions>

        <div className="tst-field">
          <div className="tst-field-label">各类目标数量</div>
          <Space size={12} wrap>
            <span className="tst-num"><span className="tst-num-label">单意图</span><InputNumber min={0} max={80} value={singleCount} onChange={(v) => setSingleCount(v || 0)} size="small" /></span>
            <span className="tst-num"><span className="tst-num-label">多意图</span><InputNumber min={0} max={80} value={multiCount} onChange={(v) => setMultiCount(v || 0)} size="small" /></span>
            <span className="tst-num"><span className="tst-num-label">模糊</span><InputNumber min={0} max={80} value={ambiguousCount} onChange={(v) => setAmbiguousCount(v || 0)} size="small" /></span>
          </Space>
        </div>

        <div className="tst-field">
          <div className="tst-field-label">模糊意图构成</div>
          <Checkbox.Group
            className="tst-checks"
            options={AMBIGUOUS_SUBOPTIONS}
            value={AMBIGUOUS_SUBOPTIONS.map((o) => o.value).filter((v) => ambMix[v])}
            onChange={(vals) => {
              const next: Record<string, boolean> = {};
              for (const o of AMBIGUOUS_SUBOPTIONS) next[o.value] = vals.includes(o.value);
              setAmbMix(next);
            }}
          />
        </div>

        <div className="tst-field">
          <div className="tst-field-label">领域过滤（留空=全部）</div>
          <Select
            mode="multiple" allowClear placeholder="全部领域" size="small" style={{ width: "100%" }}
            options={(scaffold?.domains || []).map((d) => ({ value: d, label: d }))}
            value={domains} onChange={setDomains}
          />
        </div>

        <div className="tst-field">
          <div className="tst-field-label">难度分布（单意图问法难度分配）</div>
          <Select
            size="small" style={{ width: "100%" }} value={difficultyPreset} onChange={setDifficultyPreset}
            options={DIFFICULTY_PRESETS.map(({ value, label }) => ({ value, label }))}
          />
        </div>

        <div className="tst-field">
          <div className="tst-field-label">问法风格（轮替使用{difficultyPreset !== "none" ? "，已由难度分布接管" : ""}）</div>
          <Checkbox.Group
            className="tst-checks" options={STYLE_OPTIONS} value={styles}
            disabled={difficultyPreset !== "none"} onChange={(v) => setStyles(v as string[])}
          />
        </div>

        <div className="tst-field">
          <Checkbox checked={confusableBias} onChange={(e) => setConfusableBias(e.target.checked)}>
            多意图近义优先（同对象意图对，更易混）
          </Checkbox>
        </div>

        <div className="tst-field">
          <div className="tst-field-label">每目标问法数</div>
          <InputNumber min={1} max={5} value={perTargetCount} onChange={(v) => setPerTargetCount(v || 3)} size="small" />
        </div>

        <Space direction="vertical" style={{ width: "100%" }} size={8}>
          <Button type="primary" block loading={planning || synthesizing} onClick={doGenerate}>
            <CaretRightOutlined /> 生成测试集
          </Button>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            根据左侧配置从图谱中自动生成测试用例。支持中断后自动续跑。
          </Typography.Text>
        </Space>
      </Card>

      <div className="tst-result">
        {synthesizing && (
          <Card size="small">
            <Space direction="vertical" size={4} style={{ width: "100%" }}>
              <Space size={10}>
                <Spin size="small" />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  生成进行中：可切换页签，服务端继续执行；中断后重新点击会自动续跑。
                </Typography.Text>
              </Space>
              {jobProgress && jobProgress.total > 0 && (
                <>
                  <Progress
                    size="small"
                    percent={Math.min(100, Math.round((jobProgress.done / jobProgress.total) * 100))}
                    showInfo={false}
                  />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>批次进度 {jobProgress.done}/{jobProgress.total}</Typography.Text>
                </>
              )}
            </Space>
          </Card>
        )}

        {!scaffold && !synthesizing && (
          <Card size="small">
            <Empty description="点击「生成测试集」按钮，自动从图谱生成测试用例" />
            <div className="tst-steps">
              <span className="tst-step"><b>1</b> 配置参数：选择意图类型、数量、问法风格</span>
              <span className="tst-step"><b>2</b> 生成测试集：自动从图谱抽取目标并生成多种问法</span>
              <span className="tst-step"><b>3</b> 导入用例库：勾选用例，进入测试用例库参与评测</span>
            </div>
          </Card>
        )}

        {scaffold && !dataset && !synthesizing && (
          <Card size="small" title={<Space size={8}>测试目标{summaryChips}</Space>}>
            <Collapse
              items={[{
                key: "targets",
                label: `测试目标明细（${scaffold.planSummary.totalTargets} 个${scaffold.targetsTruncated ? "，仅预览前 120" : ""}）`,
                children: (
                  <Table
                    size="small" rowKey="targetId"
                    dataSource={scaffold.targetsPreview}
                    pagination={{ pageSize: 10, size: "small" }}
                    columns={[
                      { title: "目标", dataIndex: "targetId", ellipsis: true, width: 260 },
                      { title: "类别", key: "cat", width: 220, render: (_: unknown, r: TestSetScaffoldResult["targetsPreview"][number]) => categoryTag(r.category, r.subcategory) },
                      { title: "意图", key: "intents", ellipsis: true, render: (_: unknown, r: TestSetScaffoldResult["targetsPreview"][number]) => (r.intents || []).join(" + ") || "-" },
                      { title: "条数", dataIndex: "count", width: 60 },
                    ]}
                  />
                ),
              }]}
            />
          </Card>
        )}

        {dataset && !synthesizing && (
          <Card
            size="small"
            title={
              <Space size={8} wrap>
                合成结果
                <Tag color="blue">单 {dataset.summary.byCategory["SINGLE_INTENT/execute"]?.count + (dataset.summary.byCategory["SINGLE_INTENT/knowledge"]?.count || 0) || 0}</Tag>
                <Tag color="gold">多 {Object.entries(dataset.summary.byCategory).filter(([k]) => k.startsWith("MULTI_INTENT")).reduce((s, [, v]) => s + v.count, 0)}</Tag>
                <Tag color="purple">模糊 {Object.entries(dataset.summary.byCategory).filter(([k]) => k.startsWith("AMBIGUOUS")).reduce((s, [, v]) => s + v.count, 0)}</Tag>
                {DIFFICULTY_LEVELS.filter((l) => diffCounts[l] > 0).map((l) => (
                  <Tag key={l}>{DIFFICULTY_LABELS[l]} {diffCounts[l]}</Tag>
                ))}
                {suspectCount > 0 && <Tag color="orange">疑 {suspectCount}</Tag>}
                <Tag>共 {dataset.summary.total}</Tag>
              </Space>
            }
            extra={
              <Space size={8}>
                <Button size="small" type="primary" loading={importing} onClick={doImport}>导入用例库（{selectedKeys.length}）</Button>
                <Button size="small" icon={<DownloadOutlined />} onClick={doExport}>导出 JSON</Button>
              </Space>
            }
          >
            {dataset.fallbackUsed && (
              <Alert style={{ marginBottom: 12 }} type="warning" showIcon
                message="AI 合成不可用，当前使用模板问法替代，请检查 AI 合成服务后重试" />
            )}
            {!dataset.fallbackUsed && dataset.batchErrors.length > 0 && (
              <Alert style={{ marginBottom: 12 }} type="warning" showIcon
                message={`${dataset.batchErrors.length} 个批次生成失败（部分目标缺失），其余已生成；失败目标 ${dataset.failed.length} 个`} />
            )}
            {suspectCount > 0 && (
              <Alert style={{ marginBottom: 12 }} type="warning" showIcon
                message={`${suspectCount} 条问法与期望意图的已知说法无词汇关联，疑似 AI 生成的偏离表达，建议人工复核后再导入用例库`} />
            )}
            <Table
              size="small"
              rowKey="caseId"
              dataSource={dataset.cases}
              columns={caseColumns}
              pagination={{ pageSize: 10, size: "small", showSizeChanger: false }}
              rowSelection={{ selectedRowKeys: selectedKeys, onChange: (keys) => setSelectedKeys(keys) }}
            />
          </Card>
        )}
      </div>
    </div>
  );
}
