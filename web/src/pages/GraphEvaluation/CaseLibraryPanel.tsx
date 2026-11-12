import { useCallback, useEffect, useState } from "react";
import {
  Alert, Button, Card, Descriptions, Drawer, Empty, Input, Modal, Popconfirm, Select,
  Space, Table, Tabs, Tag, Upload, message,
} from "antd";
import { DownloadOutlined, PlusOutlined, ReloadOutlined, UploadOutlined } from "@ant-design/icons";
import {
  batchImportTestCases, clearTestCases, createTestCase, deleteTestCase, exportTestCases, getTestCase, getTestCaseStats,
  listTestCases, updateTestCaseAttribution, type TestCase, type TestCaseFilters, type TestCaseStats,
} from "./api";
import { ACTION_COLOR, FAILURE_META, OWNER_META, RESULT_TYPE_META, SOURCE_META, TURN_TYPE_LABELS } from "./meta";
import { csvToItems } from "./csvParse";

const PAGE_SIZE = 30;

function metaTag(map: Record<string, { label: string; color: string }>, key?: string, fallback = "-") {
  if (!key) return <Tag>{fallback}</Tag>;
  const m = map[key];
  return <Tag color={m?.color || "default"}>{m?.label || key}</Tag>;
}

// 多轮用例的 result_type 存的是轮次类型（如 new_intent），优先按轮次字典翻译
function typeTag(key?: string) {
  if (key && RESULT_TYPE_META[key]) return metaTag(RESULT_TYPE_META, key);
  if (key && TURN_TYPE_LABELS[key]) return <Tag color="geekblue">{TURN_TYPE_LABELS[key]}</Tag>;
  return metaTag(RESULT_TYPE_META, key);
}

function failureTag(cat?: string) {
  if (!cat) return <Tag>未标记</Tag>;
  return metaTag(FAILURE_META, cat);
}

function download(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}


export default function CaseLibraryPanel({ refreshToken }: { refreshToken: number }) {
  const [stats, setStats] = useState<TestCaseStats | null>(null);
  const [rows, setRows] = useState<TestCase[]>([]);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState<TestCaseFilters>({});
  const [keyword, setKeyword] = useState("");
  const [detail, setDetail] = useState<TestCase | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [importItems, setImportItems] = useState<any[] | null>(null);
  const [importFileName, setImportFileName] = useState("");
  const [markForm, setMarkForm] = useState<{ failure_category?: string; failure_owner?: string; failure_reason: string; fix_recommendation: string }>({ failure_reason: "", fix_recommendation: "" });
  const [markSaving, setMarkSaving] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [addForm, setAddForm] = useState<any>({ result_type: "single_intent", eval_mode: "single" });

  const loadStats = useCallback(() => {
    getTestCaseStats().then(setStats).catch((e) => message.error(`统计加载失败：${e.message}`));
  }, []);

  const loadRows = useCallback((off: number, f: TestCaseFilters) => {
    setLoading(true);
    listTestCases(PAGE_SIZE, off, f)
      .then((res) => {
        setRows(res.data || []);
        setOffset(off);
      })
      .catch((e) => message.error(`用例加载失败：${e.message}`))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadStats();
    loadRows(0, {});
  }, [loadStats, loadRows, refreshToken]);

  const applyFilters = (next: Partial<TestCaseFilters>) => {
    const merged = { ...filters, ...next };
    setFilters(merged);
    loadRows(0, merged);
  };

  const refreshAll = () => {
    loadStats();
    loadRows(offset, filters);
  };

  const viewDetail = async (id: number) => {
    setDetailLoading(true);
    try {
      const item = await getTestCase(id);
      setDetail(item);
      setMarkForm({
        failure_category: item?.failure_category || undefined,
        failure_owner: item?.failure_owner || undefined,
        failure_reason: item?.failure_reason || "",
        fix_recommendation: item?.fix_recommendation || "",
      });
    } catch (e) {
      message.error(`详情加载失败：${(e as Error).message}`);
    } finally {
      setDetailLoading(false);
    }
  };

  const saveMark = async () => {
    if (!detail) return;
    setMarkSaving(true);
    try {
      await updateTestCaseAttribution(detail.id, {
        failure_category: markForm.failure_category || "",
        failure_owner: markForm.failure_owner || "",
        failure_reason: markForm.failure_reason.trim(),
        fix_recommendation: markForm.fix_recommendation.trim(),
      });
      message.success("已保存人工标记");
      const fresh = await getTestCase(detail.id);
      setDetail(fresh);
      refreshAll();
    } catch (e) {
      message.error(`保存失败：${(e as Error).message}`);
    } finally {
      setMarkSaving(false);
    }
  };

  const removeCase = async (id: number) => {
    await deleteTestCase(id);
    message.success("已删除");
    setDetail(null);
    refreshAll();
  };

  const clearAll = async () => {
    await clearTestCases();
    message.success("已清空全部用例");
    refreshAll();
  };

  const exportJson = async () => {
    const res = await exportTestCases(filters);
    download("intent-test-cases.json", JSON.stringify(res.data || [], null, 2), "application/json");
  };

  const exportCsv = async () => {
    const res = await exportTestCases(filters);
    const header = ["id", "query", "result_type", "final_intent", "action_code", "business_object", "latency_ms", "eval_mode", "session_id", "turn_index", "tags", "source", "failure_category", "failure_owner", "failure_reason", "fix_recommendation", "created_at"];
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [header.join(",")];
    (res.data || []).forEach((r) => {
      lines.push(header.map((h) => esc(r[h as keyof TestCase])).join(","));
    });
    download("intent-test-cases.csv", "\uFEFF" + lines.join("\n"), "text/csv");
  };

  const submitAdd = async () => {
    if (!addForm.query?.trim()) {
      message.warning("Query 必填");
      return;
    }
    const res = await createTestCase({
      query: addForm.query.trim(),
      result_type: addForm.result_type || "single_intent",
      final_intent: addForm.final_intent || "",
      action_code: addForm.action_code || "",
      business_object: addForm.business_object || "",
      tags: addForm.tags || "",
      source: "manual",
    });
    message.success(`已添加用例 #${res.id}${res.attribution?.failure_category ? `（自动归因：${FAILURE_META[res.attribution.failure_category]?.label || res.attribution.failure_category}）` : "（未命中归因规则）"}`);
    setAddOpen(false);
    setAddForm({ result_type: "single_intent", eval_mode: "single" });
    refreshAll();
  };

  const resetImportState = () => {
    setImportOpen(false);
    setImportText("");
    setImportItems(null);
    setImportFileName("");
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleImportFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = String(reader.result || "");
        let items: unknown[] = [];
        let skipped = 0;
        if (/\.csv$/i.test(file.name)) {
          const r = csvToItems(text);
          items = r.items;
          skipped = r.skipped;
        } else {
          const parsed = JSON.parse(text);
          items = Array.isArray(parsed) ? parsed : [parsed];
        }
        if (!items.length) {
          message.warning(`文件中没有可导入的记录${skipped ? `（${skipped} 行缺 query 已跳过）` : ""}`);
          return;
        }
        setImportItems(items);
        setImportFileName(file.name);
        message.success(`已解析 ${items.length} 条${skipped ? `，跳过 ${skipped} 行（缺 query）` : ""}`);
      } catch {
        message.error("文件解析失败：JSON 需为对象数组，CSV 需含表头行且带 query 列");
      }
    };
    reader.readAsText(file);
    return false; // 阻止 antd 自动上传，文件内容全在客户端解析
  };

  const submitImport = async () => {
    let items: unknown[] = [];
    if (importItems) {
      items = importItems;
    } else {
      try {
        const parsed = JSON.parse(importText);
        items = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        message.error("JSON 解析失败，请粘贴对象数组或选择文件");
        return;
      }
    }
    if (!items.length) {
      message.warning("没有可导入的记录");
      return;
    }
    const modal = message.loading(`正在导入 ${items.length} 条...`, 0);
    try {
      const res = await batchImportTestCases(items);
      modal();
      message.success(`导入完成：${res.inserted}/${items.length} 条${res.failed ? `，失败 ${res.failed} 条` : ""}`);
      resetImportState();
      refreshAll();
    } catch (e) {
      modal();
      message.error(`导入失败：${(e as Error).message || "未知错误"}`);
    }
  };

  const total = stats?.total ?? 0;
  const singleCount = stats?.by_eval_mode?.find((x) => x.eval_mode === "single")?.count ?? 0;
  const multiCount = stats?.by_eval_mode?.find((x) => x.eval_mode === "multi")?.count ?? 0;
  const pendingAttr = Math.max(0, total - (stats?.attributed_total ?? 0));
  const top8 = (stats?.by_final_intent || []).slice(0, 8);
  const maxBar = Math.max(1, ...top8.map((x) => x.count));
  const owners = stats?.by_failure_owner || [];
  const ownerTop = owners.slice().sort((a, b) => b.count - a.count)[0];
  const unmarked = Math.max(0, total - (stats?.attributed_total ?? 0));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const BAR_COLORS = ["#1677ff", "#52c41a", "#722ed1", "#faad14", "#f5222d", "#13c2c2", "#eb2f96", "#fa8c16"];

  const hasPrev = offset > 0;
  const hasNext = rows.length === PAGE_SIZE;

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0,1fr))", gap: 12 }}>
        <div className="ge-stat-card">
          <div className="ge-stat-value" style={{ color: "#1677ff" }}>{total}</div>
          <div className="ge-stat-label">总用例</div>
          <div className="ge-stat-sub">{singleCount} 单轮 · {multiCount} 多轮</div>
        </div>
        <div className="ge-stat-card">
          <div className="ge-stat-value" style={{ color: "#52c41a" }}>{stats?.distinct_final_intents ?? 0}</div>
          <div className="ge-stat-label">意图覆盖</div>
          <div className="ge-stat-sub">已覆盖意图类型</div>
        </div>
        <div className="ge-stat-card">
          <div className="ge-stat-value" style={{ color: pendingAttr > 0 ? "#faad14" : "#52c41a" }}>{pendingAttr}</div>
          <div className="ge-stat-label">待归因</div>
          <div className="ge-stat-sub">未命中归因规则</div>
        </div>
        <div className="ge-stat-card">
          <div className="ge-stat-value" style={{ color: "#722ed1" }}>{stats ? Math.round(stats.latency?.avg || 0) : "-"}ms</div>
          <div className="ge-stat-label">平均耗时</div>
          <div className="ge-stat-sub">最大 {stats ? Math.round(stats.latency?.max || 0) : "-"}ms</div>
        </div>
        <div className="ge-stat-card">
          <div className="ge-stat-value" style={ownerTop ? { color: "#f5222d", fontSize: 20, lineHeight: 1.55 } : { color: "#d1d5db" }}>{ownerTop ? OWNER_META[ownerTop.failure_owner]?.label || ownerTop.failure_owner : "—"}</div>
          <div className="ge-stat-label">主要责任域</div>
          <div className="ge-stat-sub">{ownerTop ? `归因 ${stats?.attributed_total ?? 0} 条` : "暂无失败归因数据"}</div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1.4fr) minmax(0,1fr)", gap: 14 }}>
        <Card size="small" title="意图分布 TOP 8">
          {top8.length ? top8.map((x, i) => (
            <div className="ge-bar-row" key={x.final_intent}>
              <div className="ge-bar-label" title={x.final_intent}>{x.final_intent}</div>
              <div className="ge-bar-track">
                <div className="ge-bar-fill" style={{ width: `${(x.count / maxBar) * 100}%`, background: BAR_COLORS[i % BAR_COLORS.length] }} />
              </div>
              <div className="ge-bar-count">{x.count}</div>
            </div>
          )) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无数据" />}
        </Card>
        <Card size="small" title="失败归因分布" extra={<Button size="small" icon={<ReloadOutlined />} onClick={refreshAll}>刷新</Button>}>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {(stats?.by_failure_category || []).length ? (
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (stats?.by_failure_category || []).map((x: any) => (
                <div key={x.failure_category} style={{ border: "1px solid #eef0f4", borderRadius: 8, padding: "8px 12px", display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }} onClick={() => applyFilters({ failure_category: x.failure_category })}>
                  <span style={{ fontSize: 18, fontWeight: 700, color: "#faad14" }}>{x.count}</span>
                  {failureTag(x.failure_category)}
                </div>
              ))
            ) : null}
            {unmarked > 0 ? (
              <div style={{ border: "1px solid #eef0f4", borderRadius: 8, padding: "8px 12px", display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }} onClick={() => applyFilters({ failure_category: "__unmarked__" })}>
                <span style={{ fontSize: 18, fontWeight: 700, color: "#8c93a3" }}>{unmarked}</span>
                <Tag>未标记</Tag>
              </div>
            ) : null}
            {!(stats?.by_failure_category || []).length && !unmarked ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无归因数据" /> : null}
          </div>
        </Card>
      </div>

      <Card size="small" styles={{ body: { padding: 12 } }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
          <Input.Search
            allowClear
            placeholder="搜索 Query / 意图 / 动作 / 归因..."
            style={{ width: 320 }}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onSearch={(v) => applyFilters({ keyword: v || undefined })}
          />
          <Select
            allowClear placeholder="类型" style={{ width: 120 }}
            value={filters.result_type}
            onChange={(v) => applyFilters({ result_type: v })}
            options={Object.entries(RESULT_TYPE_META).map(([k, v]) => ({ value: k, label: v.label }))}
          />
          <Select
            allowClear placeholder="模式" style={{ width: 110 }}
            value={filters.eval_mode}
            onChange={(v) => applyFilters({ eval_mode: v })}
            options={[{ value: "single", label: "单次评测" }, { value: "multi", label: "多轮对话" }]}
          />
          <Select
            allowClear placeholder="来源" style={{ width: 110 }}
            value={filters.source}
            onChange={(v) => applyFilters({ source: v })}
            options={Object.entries(SOURCE_META).map(([k, v]) => ({ value: k, label: v.label }))}
          />
          <Select
            allowClear placeholder="归因" style={{ width: 170 }}
            value={filters.failure_category}
            onChange={(v) => applyFilters({ failure_category: v })}
            options={[...Object.entries(FAILURE_META).map(([k, v]) => ({ value: k, label: v.label })), { value: "__unmarked__", label: "待归因（未标记）" }]}
          />
          <Select
            allowClear placeholder="责任域" style={{ width: 110 }}
            value={filters.failure_owner}
            onChange={(v) => applyFilters({ failure_owner: v })}
            options={Object.entries(OWNER_META).map(([k, v]) => ({ value: k, label: v.label }))}
          />
          <Button onClick={() => { setKeyword(""); setFilters({}); loadRows(0, {}); }}>重置筛选</Button>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
          <Button size="small" icon={<PlusOutlined />} type="primary" ghost onClick={() => setAddOpen(true)}>手动添加</Button>
          <Button size="small" icon={<UploadOutlined />} onClick={() => setImportOpen(true)}>批量导入</Button>
          <Button size="small" icon={<DownloadOutlined />} onClick={exportJson}>导出 JSON</Button>
          <Button size="small" icon={<DownloadOutlined />} onClick={exportCsv}>导出 CSV</Button>
          <Popconfirm title="清空全部用例？" description="该操作不可恢复（可先用导出备份）。" onConfirm={clearAll}>
            <Button size="small" danger>清空全部</Button>
          </Popconfirm>
          <span style={{ marginLeft: "auto", fontSize: 12, color: "#8c93a3", alignSelf: "center" }}>
            共 {total} 条 · 第 {Math.floor(offset / PAGE_SIZE) + 1} 页
          </span>
        </div>
        <Table<TestCase>
          size="small"
          rowKey="id"
          loading={loading}
          dataSource={rows}
          pagination={false}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有符合条件的记录" /> }}
          columns={[
            { title: "#", width: 56, render: (_, r) => r.id },
            { title: "Query", ellipsis: true, render: (_, r) => <span title={r.query} style={{ fontWeight: 600 }}>{r.query}</span> },
            { title: "类型", width: 90, render: (_, r) => typeTag(r.result_type) },
            {
              title: "意图 + 动作", ellipsis: true, render: (_, r) => (
                <Space size={4} wrap>
                  <span style={{ color: "#389e0d", fontSize: 12 }}>{r.final_intent || "-"}</span>
                  {r.action_code ? <Tag color={ACTION_COLOR[r.action_code] || "default"} style={{ marginInlineEnd: 0 }}>{r.action_code}</Tag> : null}
                </Space>
              ),
            },
            { title: "业务对象", ellipsis: true, render: (_, r) => r.business_object || "-" },
            { title: "归因", width: 140, render: (_, r) => failureTag(r.failure_category) },
            { title: "责任", width: 80, render: (_, r) => metaTag(OWNER_META, r.failure_owner) },
            { title: "耗时", width: 90, render: (_, r) => <span style={{ fontVariantNumeric: "tabular-nums" }}>{Math.round(r.latency_ms || 0)}ms</span> },
            { title: "来源", width: 80, render: (_, r) => metaTag(SOURCE_META, r.source) },
            {
              title: "操作", width: 130, render: (_, r) => (
                <Space size={4}>
                  <Button size="small" type="link" style={{ padding: 0 }} onClick={() => viewDetail(r.id)}>详情</Button>
                  <Popconfirm title="删除这条用例？" onConfirm={() => removeCase(r.id)}>
                    <Button size="small" type="link" danger style={{ padding: 0 }}>删除</Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 10 }}>
          <Button size="small" disabled={!hasPrev} onClick={() => loadRows(Math.max(0, offset - PAGE_SIZE), filters)}>上一页</Button>
          <Button size="small" disabled={!hasNext} onClick={() => loadRows(offset + PAGE_SIZE, filters)}>下一页</Button>
        </div>
      </Card>

      <Drawer
        title={detail ? `用例详情 #${detail.id}` : "用例详情"}
        open={!!detail || detailLoading}
        onClose={() => setDetail(null)}
        width={720}
        loading={detailLoading}
        extra={detail ? (
          <Popconfirm title="删除这条用例？" onConfirm={() => removeCase(detail.id)}>
            <Button danger size="small">删除此记录</Button>
          </Popconfirm>
        ) : null}
      >
        {detail ? (
          <Tabs
            items={[
              {
                key: "info", label: "基本信息",
                children: (
                  <Descriptions column={2} size="small" bordered>
                    <Descriptions.Item label="Query" span={2}>{detail.query}</Descriptions.Item>
                    <Descriptions.Item label="结果类型">{typeTag(detail.result_type)}</Descriptions.Item>
                    <Descriptions.Item label="评测模式">{detail.eval_mode === "multi" ? "多轮对话" : "单次评测"}</Descriptions.Item>
                    <Descriptions.Item label="最终意图" span={2}><span style={{ color: "#389e0d" }}>{detail.final_intent || "-"}</span></Descriptions.Item>
                    <Descriptions.Item label="动作代码">{detail.action_code ? <Tag color={ACTION_COLOR[detail.action_code] || "default"}>{detail.action_code}</Tag> : "-"}</Descriptions.Item>
                    <Descriptions.Item label="业务对象">{detail.business_object || "-"}</Descriptions.Item>
                    <Descriptions.Item label="轮次">{detail.turn_index || 0}</Descriptions.Item>
                    <Descriptions.Item label="会话 ID">{detail.session_id || "-"}</Descriptions.Item>
                    <Descriptions.Item label="标签" span={2}>
                      {detail.tags ? (
                        <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
                          {detail.tags.split(/\s+/).filter(Boolean).map((t, i) => (
                            <Tag key={i} color={t.startsWith("engine:bank") || t.startsWith("graph:bank") ? "gold" : "geekblue"} style={{ marginInlineEnd: 0 }}>{t}</Tag>
                          ))}
                        </span>
                      ) : "-"}
                    </Descriptions.Item>
                    <Descriptions.Item label="耗时"><span style={{ color: "#1677ff" }}>{Math.round(detail.latency_ms || 0)}ms</span></Descriptions.Item>
                    <Descriptions.Item label="来源">{metaTag(SOURCE_META, detail.source)}</Descriptions.Item>
                    <Descriptions.Item label="创建时间" span={2}>{detail.created_at || "-"}</Descriptions.Item>
                  </Descriptions>
                ),
              },
              {
                key: "attr", label: "归因分析",
                children: (
                  <div style={{ display: "grid", gap: 10 }}>
                    <div style={{ border: "1px solid #eef0f4", borderRadius: 8, padding: 12 }}>
                      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>{failureTag(detail.failure_category)}{metaTag(OWNER_META, detail.failure_owner)}</div>
                      <Descriptions column={1} size="small">
                        <Descriptions.Item label="原因说明">{detail.failure_reason || "未命中稳定归因规则"}</Descriptions.Item>
                        <Descriptions.Item label="整改建议">{detail.fix_recommendation || "暂无"}</Descriptions.Item>
                      </Descriptions>
                    </div>
                    {!detail.failure_category ? <Alert type="info" showIcon message="该用例尚未命中任何失败归因规则，可在引擎复测后自动补充，或人工按需标记。" /> : null}
                    <div style={{ border: "1px dashed #d9deea", borderRadius: 8, padding: 12, display: "grid", gap: 8 }}>
                      <div style={{ fontSize: 12, color: "#8c93a3" }}>人工标记（保存后覆盖自动归因；选择归因族可留空表示清除标记）</div>
                      <Space size={8} wrap>
                        <Select
                          allowClear placeholder="失败归因族" style={{ width: 200 }}
                          value={markForm.failure_category}
                          onChange={(v) => setMarkForm((f) => ({ ...f, failure_category: v }))}
                          options={Object.entries(FAILURE_META).map(([k, v]) => ({ value: k, label: v.label }))}
                        />
                        <Select
                          allowClear placeholder="责任域" style={{ width: 140 }}
                          value={markForm.failure_owner}
                          onChange={(v) => setMarkForm((f) => ({ ...f, failure_owner: v }))}
                          options={Object.entries(OWNER_META).map(([k, v]) => ({ value: k, label: v.label }))}
                        />
                      </Space>
                      <Input placeholder="原因说明（可选）" value={markForm.failure_reason} onChange={(e) => setMarkForm((f) => ({ ...f, failure_reason: e.target.value }))} />
                      <Input placeholder="整改建议（可选）" value={markForm.fix_recommendation} onChange={(e) => setMarkForm((f) => ({ ...f, fix_recommendation: e.target.value }))} />
                      <Button type="primary" size="small" loading={markSaving} onClick={saveMark} style={{ justifySelf: "start" }}>保存标记</Button>
                    </div>
                  </div>
                ),
              },
              {
                key: "raw", label: "原始响应",
                children: detail.full_response ? (
                  <pre style={{ fontSize: 11, lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-all", color: "#4b5563", maxHeight: "60vh", overflow: "auto", background: "#fafafa", padding: 12, borderRadius: 8 }}>
                    {typeof detail.full_response === "string" ? detail.full_response : JSON.stringify(detail.full_response, null, 2)}
                  </pre>
                ) : (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无原始响应数据" />
                ),
              },
            ]}
          />
        ) : null}
      </Drawer>

      <Modal
        title="手动添加用例"
        open={addOpen}
        onOk={submitAdd}
        onCancel={() => setAddOpen(false)}
        okText="添加"
        destroyOnHidden
      >
        <div style={{ display: "grid", gap: 10, paddingTop: 6 }}>
          <Input.TextArea placeholder="Query（必填）" value={addForm.query} onChange={(e) => setAddForm({ ...addForm, query: e.target.value })} autoSize={{ minRows: 2, maxRows: 4 }} />
          <Select
            value={addForm.result_type}
            onChange={(v) => setAddForm({ ...addForm, result_type: v })}
            options={Object.entries(RESULT_TYPE_META).map(([k, v]) => ({ value: k, label: v.label }))}
            style={{ width: "100%" }}
          />
          <Input placeholder="最终意图（如：转账汇款）" value={addForm.final_intent} onChange={(e) => setAddForm({ ...addForm, final_intent: e.target.value })} />
          <Input placeholder="动作代码（如：transfer / query）" value={addForm.action_code} onChange={(e) => setAddForm({ ...addForm, action_code: e.target.value })} />
          <Input placeholder="业务对象" value={addForm.business_object} onChange={(e) => setAddForm({ ...addForm, business_object: e.target.value })} />
          <Input placeholder="标签（可选）" value={addForm.tags} onChange={(e) => setAddForm({ ...addForm, tags: e.target.value })} />
          <div style={{ fontSize: 12, color: "#8c93a3" }}>保存时引擎会自动运行失败归因规则（澄清误触发 / 多意图拆分失败 / 图谱边界等 7 类）。</div>
        </div>
      </Modal>

      <Modal
        title="批量导入（JSON / CSV）"
        open={importOpen}
        onOk={submitImport}
        onCancel={resetImportState}
        okText="开始导入"
        width={680}
        destroyOnHidden
      >
        <Space style={{ marginBottom: 8 }} wrap>
          <Upload accept=".json,.csv" showUploadList={false} beforeUpload={(file) => handleImportFile(file)}>
            <Button icon={<UploadOutlined />}>选择文件（.json / .csv）</Button>
          </Upload>
          {importItems && (
            <Tag closable onClose={() => { setImportItems(null); setImportFileName(""); }} color="blue">
              {importFileName}：{importItems.length} 条（以文件为准）
            </Tag>
          )}
        </Space>
        <Input.TextArea
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
          placeholder={'JSON 数组：\n  [{"query": "给张三转100", "result_type": "single_intent", "final_intent": "转账汇款", "action_code": "transfer", "business_object": "转账汇款"}]\n或 CSV（首行表头，须含 query 列，兼容本页导出的 CSV 格式）'}
          autoSize={{ minRows: 8, maxRows: 16 }}
          style={{ fontFamily: "monospace", fontSize: 12 }}
        />
        <div style={{ fontSize: 12, color: "#8c93a3", marginTop: 8 }}>每条至少包含 query；其余字段可选，来源将标记为「导入」，导入后自动运行归因规则。选择文件后以文件内容为准。</div>
      </Modal>
    </div>
  );
}
