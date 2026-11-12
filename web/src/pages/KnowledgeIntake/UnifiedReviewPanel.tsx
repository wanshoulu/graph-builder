/**
 * 全局AI审核面板（合并质量报告 + AI骨架助手 + 修订审阅）
 * 一个抽屉内分三层展示：
 *   1. 质量评分区 — 五维分数 + 就绪判定 + 入图按钮
 *   2. 结构建议区 — 查漏/重复/命名/歧义
 *   3. 变更审阅区 — AI/人工变更的痕迹逐条确认
 * 字段级AI审核（node-review）保留在详情页不动，不合并到此面板
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  Collapse,
  Drawer,
  Empty,
  Progress,
  Select,
  Space,
  Spin,
  Statistic,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import {
  AimOutlined,
  CheckOutlined,
  CloseOutlined,
  ExportOutlined,
  FileDoneOutlined,
  MessageOutlined,
  RightOutlined,
  RobotOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import {
  knowledgeIntakeApi,
  type AcceptanceReport,
  type ApplyResult,
  type AssistGetResult,
  type AssistItem,
  type AssistKind,
  type Revision,
  type RevisionChange,
  type RevisionListResult,
} from "@/api/knowledgeIntake";
import {
  ASSIST_KIND_META,
  ASSIST_STATUS_META,
  ISSUE_LEVEL_COLOR,
  ISSUE_LEVEL_LABEL,
  REVISION_FIELD_LABEL,
  REVISION_TYPE_META,
  ROW_TYPE_LABEL,
  scoreColor,
} from "./constants";
import { assistLocateUnit } from "./AssistPanel";

const { Text } = Typography;

const EXPANDABLE_RE = /说法仅 \d+ 条/;

/* ── Part 1: 质量评分区 ── */

function QualitySection({
  data,
  loading,
  approvedCount,
  blockedCount,
  applyAsset,
  assetOptions,
  onApplyAssetChange,
  onPreviewApply,
  previewLoading,
  applyResult,
  onGoBuilder,
  onFixIssue,
  onExpandIssue,
}: {
  data: AcceptanceReport | null;
  loading: boolean;
  approvedCount: number;
  blockedCount: number;
  applyAsset: string;
  assetOptions: { value: string; label: string }[];
  onApplyAssetChange: (v: string) => void;
  onPreviewApply: (ids: string[]) => void;
  previewLoading: boolean;
  applyResult: ApplyResult | null;
  onGoBuilder: () => void;
  onFixIssue?: (unit: string) => void;
  onExpandIssue?: (unit: string) => Promise<void>;
}) {
  const [expandingUnits, setExpandingUnits] = useState<string[]>([]);

  const gateReasons: string[] = [];
  if (approvedCount === 0) gateReasons.push("还没有已确认条目");
  if (blockedCount > 0) gateReasons.push(`还有 ${blockedCount} 个阻断项待解决`);
  if (data && !data.ready && data.weakestDimension) {
    gateReasons.push(`「${data.dimensions[data.weakestDimension].label}」仅 ${data.dimensions[data.weakestDimension].score} 分（<90）`);
  }
  const canApply = gateReasons.length === 0;

  if (loading) return <div style={{ textAlign: "center", padding: 32 }}><Spin /></div>;

  return (
    <Space direction="vertical" size={12} style={{ width: "100%" }}>
      <Card size="small">
        <Space size={24} wrap align="start" style={{ width: "100%" }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, color: canApply ? "#15803d" : "#b45309", marginBottom: 4 }}>
              {canApply ? "✓ 已满足入图条件" : "暂不可入图：先解决下方问题"}
            </div>
            {!canApply && (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {gateReasons.map((g) => (
                  <li key={g}><Text type="secondary" style={{ fontSize: 12 }}>{g}</Text></li>
                ))}
              </ul>
            )}
          </div>
          {data && (
            <Space size={16}>
              <Statistic title="综合得分" value={data.overall} suffix="/100" valueStyle={{ color: scoreColor(data.overall), fontSize: 20 }} />
              <Tag color={data.ready ? "green" : data.overall >= 70 ? "orange" : "red"} style={{ fontSize: 13, padding: "4px 12px" }}>
                {data.label}
              </Tag>
            </Space>
          )}
          <div style={{ flex: 1, minWidth: 200 }}>
            <Space wrap>
              <Tooltip title="把已确认条目写入图谱草稿">
                <Button type="primary" ghost icon={<ExportOutlined />} loading={previewLoading} disabled={!canApply} onClick={() => onPreviewApply([])}>
                  应用到图谱
                </Button>
              </Tooltip>
              <Select size="small" style={{ minWidth: 200 }} value={applyAsset} onChange={onApplyAssetChange} options={assetOptions} />
              <Button size="small" onClick={onGoBuilder}>去图谱复核</Button>
            </Space>
          </div>
        </Space>
      </Card>

      {applyResult && (
        <Alert
          type={applyResult.applied && applyResult.saved ? "success" : "error"}
          showIcon
          message={applyResult.applied && applyResult.saved ? "已写入图谱草稿" : "图谱校验未通过，未写入草稿"}
        />
      )}

      {data && (["coverage", "boundary", "naming", "completeness", "consistency"] as const).map((key) => {
        const dim = data.dimensions[key];
        const unchecked = dim.score === null;
        return (
          <Card
            key={key}
            size="small"
            title={
              <Space size={6}>
                <Text strong>{dim.label}</Text>
                {unchecked ? <Tag color="default" style={{ marginInlineEnd: 0 }}>未预检</Tag>
                  : <Text style={{ color: scoreColor(dim.score ?? 0) }}>{dim.score} 分</Text>}
                {dim.issues.length === 0 && <Tag color="green" style={{ marginInlineEnd: 0 }}>无问题</Tag>}
              </Space>
            }
            extra={<Progress type="circle" size={36} percent={dim.score ?? 0} strokeColor={unchecked ? "#d9d9d9" : scoreColor(dim.score ?? 0)} />}
          >
            {dim.issues.length === 0 ? (
              <Text type="secondary">该维度未发现问题</Text>
            ) : (
              <Space direction="vertical" size={4} style={{ width: "100%" }}>
                {dim.issues.slice(0, 10).map((issue, i) => {
                  const expandable = !!issue.unit && EXPANDABLE_RE.test(issue.message) && !!onExpandIssue;
                  const expanding = expandable && expandingUnits.includes(issue.unit);
                  return (
                    <Space key={i} size={6} wrap align="start" style={{ width: "100%" }}>
                      <Tag color={ISSUE_LEVEL_COLOR[issue.level]} style={{ marginInlineEnd: 0, flexShrink: 0 }}>
                        {ISSUE_LEVEL_LABEL[issue.level]}
                      </Tag>
                      <Text style={{ fontSize: 12 }}>
                        {issue.unit ? <Text type="secondary">{issue.unit}：</Text> : null}
                        {issue.message}
                      </Text>
                      {expandable && (
                        <Button type="link" size="small" style={{ padding: 0, fontSize: 12 }} icon={<MessageOutlined />} loading={expanding}
                          onClick={async () => {
                            setExpandingUnits((prev) => [...prev, issue.unit]);
                            try { await onExpandIssue(issue.unit); } finally { setExpandingUnits((prev) => prev.filter((u) => u !== issue.unit)); }
                          }}>
                          去补全
                        </Button>
                      )}
                      {issue.unit && onFixIssue && !expandable && (
                        <Button type="link" size="small" style={{ padding: 0, fontSize: 12 }} icon={<RightOutlined />} onClick={() => onFixIssue(issue.unit)}>
                          定位
                        </Button>
                      )}
                    </Space>
                  );
                })}
                {dim.issues.length > 10 && <Text type="secondary" style={{ fontSize: 12 }}>… 其余 {dim.issues.length - 10} 条略</Text>}
              </Space>
            )}
          </Card>
        );
      })}
    </Space>
  );
}

/* ── Part 2: 结构建议区（AI骨架助手） ── */

function assistItemView(
  item: AssistItem,
  deciding: boolean,
  onDecide: (action: "accept" | "dismiss", item: AssistItem) => void,
  onLocate?: (item: AssistItem) => void,
) {
  const p = item.payload;
  const decided = item.status !== "suggested";
  const locatable = !!assistLocateUnit(item);
  return (
    <div key={item.id} style={{ padding: "8px 0", borderBottom: "1px dashed #f0f0f0", opacity: decided ? 0.65 : 1 }}>
      <Space direction="vertical" size={4} style={{ width: "100%" }}>
        <Space wrap size={6}>
          {(() => {
            if (item.kind === "gaps") {
              return p.type === "subdomain"
                ? <Text strong>补充子域「{p.path}」</Text>
                : <Text strong>补充意图「{p.name}」→ {p.path}</Text>;
            }
            if (item.kind === "duplicates") {
              return <Text strong>「{(p.refs || [])[0]}」≈「{(p.refs || [])[1]}」建议合并</Text>;
            }
            if (item.kind === "naming") {
              return <Text strong>改名：{p.ref?.split("/").pop()} → {p.suggestion}</Text>;
            }
            return <Text strong>{(p.refs || []).join(" 与 ")} 语义重叠</Text>;
          })()}
          <Tag color={ASSIST_STATUS_META[item.status].color} style={{ marginInlineEnd: 0 }}>
            {ASSIST_STATUS_META[item.status].label}
          </Tag>
        </Space>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {item.kind === "gaps" && (p.description || "")}
          {item.kind === "gaps" && p.reason ? `（理由：${p.reason}）` : ""}
          {item.kind === "duplicates" && `理由：${p.reason || "名称/语义相近"}`}
          {item.kind === "naming" && `问题：${p.issue || "命名不规范"}`}
          {item.kind === "ambiguities" && `重叠点：${p.overlap || "边界含混"}${p.suggestion ? `；建议：${p.suggestion}` : ""}`}
        </Text>
        {!decided && (
          <Space size={8}>
            <Button type="primary" size="small" icon={<CheckOutlined />} loading={deciding} onClick={() => onDecide("accept", item)}>采纳</Button>
            <Button size="small" icon={<CloseOutlined />} loading={deciding} onClick={() => onDecide("dismiss", item)}>忽略</Button>
            {locatable && onLocate && (
              <Button type="link" size="small" icon={<AimOutlined />} style={{ padding: 0 }} onClick={() => onLocate(item)}>定位</Button>
            )}
          </Space>
        )}
      </Space>
    </div>
  );
}

function StructureSection({
  data,
  running,
  deciding,
  onRun,
  onDecide,
  onLocate,
}: {
  data: AssistGetResult | null;
  running: boolean;
  deciding: string[];
  onRun: () => void;
  onDecide: (action: "accept" | "dismiss", item: AssistItem) => void;
  onLocate?: (item: AssistItem) => void;
}) {
  const openCount = useMemo(
    () => Object.values(data?.summary?.byKind || {}).reduce((sum, k) => sum + (k?.open || 0), 0),
    [data],
  );

  return (
    <Space direction="vertical" size={8} style={{ width: "100%" }}>
      <Space wrap>
        <Button type="primary" ghost icon={<ThunderboltOutlined />} loading={running} onClick={onRun}>
          {data?.summary.total ? "重新评审骨架" : "AI 评审骨架结构"}
        </Button>
        {openCount > 0 && <Tag color="orange" style={{ marginInlineEnd: 0 }}>{openCount} 条待裁决</Tag>}
        {data?.generatedAt && <Text type="secondary" style={{ fontSize: 12 }}>上次评审：{data.generatedAt.slice(0, 16).replace("T", " ")}</Text>}
      </Space>
      {!data || data.summary.total === 0 ? (
        <Empty description={<Text type="secondary">还没有结构建议，点上方按钮让 AI 检查骨架（查漏/去重/命名/歧义）</Text>} />
      ) : (
        <Collapse
          defaultActiveKey={(Object.keys(data.grouped) as AssistKind[]).filter((k) => data.grouped[k].items.length)}
          items={(Object.keys(data.grouped) as AssistKind[]).map((kind) => {
            const group = data.grouped[kind];
            const meta = ASSIST_KIND_META[kind];
            const stat = data.summary.byKind[kind];
            return {
              key: kind,
              label: (
                <Space size={6}>
                  <Tag color={meta.color} style={{ marginInlineEnd: 0 }}>{meta.label}</Tag>
                  <Text>{group.items.length} 条</Text>
                  {stat.open > 0 && <Tag color="blue" style={{ marginInlineEnd: 0 }}>{stat.open} 待裁决</Tag>}
                </Space>
              ),
              children: group.items.length ? (
                <>{group.items.map((item) => assistItemView(item, deciding.includes(item.id), onDecide, onLocate))}</>
              ) : <Text type="secondary">AI 未发现此类问题</Text>,
            };
          })}
        />
      )}
    </Space>
  );
}

/* ── Part 3: 变更审阅区 ── */

function changeKey(change: RevisionChange) {
  return `${change.rowId}::${change.field || ""}`;
}

function AddChangeBody({ change }: { change: RevisionChange }) {
  const stale = !!change.stale;
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
      <span style={{ color: "#389e0d", fontWeight: 600, userSelect: "none" }}>+</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <span style={{ color: stale ? "rgba(0,0,0,0.45)" : "#389e0d", textDecoration: stale ? "line-through" : "underline", textDecorationColor: "#b7eb8f", textDecorationThickness: 2, wordBreak: "break-all" }}>
          {change.label}
        </span>
        {!stale && (change.confidence !== undefined || change.sourceStatus) && (
          <Space size={4} style={{ marginInlineStart: 8 }}>
            {change.confidence !== undefined && (
              <Tag style={{ marginInlineEnd: 0, fontSize: 12, lineHeight: "18px" }}>置信 {Math.round((change.confidence || 0) * 100)}%</Tag>
            )}
            {change.sourceStatus && (
              <Tag color={change.autoApproved ? "green" : change.autoRejected ? "red" : "default"} style={{ marginInlineEnd: 0, fontSize: 12, lineHeight: "18px" }}>
                AI 分诊：{change.sourceStatus}
              </Tag>
            )}
          </Space>
        )}
        {stale && <Text type="secondary" style={{ fontSize: 12, marginInlineStart: 8 }}>行已不存在</Text>}
      </div>
    </div>
  );
}

function ModifyChangeBody({ change }: { change: RevisionChange }) {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
      <span style={{ color: "#1677ff", fontWeight: 600, userSelect: "none" }}>~</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Text type="secondary" style={{ fontSize: 12, marginInlineEnd: 8 }}>
          {REVISION_FIELD_LABEL[change.field || ""] || change.field}（{ROW_TYPE_LABEL[change.rowType] || change.rowType}）
        </Text>
        <span style={{ color: "#ef4444", textDecoration: "line-through", wordBreak: "break-all" }}>{change.before || "（空）"}</span>
        <span style={{ margin: "0 6px", color: "rgba(0,0,0,0.45)" }}>→</span>
        <span style={{ color: "#1677ff", borderBottom: "2px solid #91caff", wordBreak: "break-all" }}>{change.after || "（空）"}</span>
        {change.stale && <Text type="secondary" style={{ fontSize: 12, marginInlineStart: 8 }}>行已不存在</Text>}
      </div>
    </div>
  );
}

function RevisionCard({
  revision,
  resolving,
  onResolve,
  onLocate,
}: {
  revision: Revision;
  resolving: string | null;
  onResolve: (revision: Revision, changes: { rowId: string; action: "accept" | "reject" }[], scope: string) => void;
  onLocate?: (change: RevisionChange) => void;
}) {
  const meta = REVISION_TYPE_META[revision.type] || { label: revision.type, color: "default" };
  const pending = revision.changes.filter((c) => c.resolution === "pending");
  const open = pending.length > 0;
  return (
    <div data-rev-id={revision.revId} style={{ border: "1px solid #f0f0f0", borderRadius: 8, padding: "10px 12px", marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <Space wrap size={6}>
          <Tag color={meta.color} style={{ marginInlineEnd: 0 }}>{meta.label}</Tag>
          <Text strong>{revision.title}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>{revision.createdAt.slice(0, 16).replace("T", " ")} · {revision.createdBy === "auto" ? "AI" : revision.createdBy}</Text>
          {open && <Tag color="orange" style={{ marginInlineEnd: 0 }}>{pending.length} 条待审</Tag>}
        </Space>
        {open && (
          <Space size={8}>
            <Button type="primary" size="small" icon={<CheckOutlined />} loading={resolving === revision.revId + ":all:y"}
              onClick={() => onResolve(revision, pending.map((c) => ({ rowId: c.rowId, action: "accept" as const })), revision.revId + ":all:y")}>
              全部采纳
            </Button>
            <Button size="small" icon={<CloseOutlined />} loading={resolving === revision.revId + ":all:n"}
              onClick={() => onResolve(revision, pending.map((c) => ({ rowId: c.rowId, action: "reject" as const })), revision.revId + ":all:n")}>
              全部放弃
            </Button>
          </Space>
        )}
      </div>
      <div style={{ marginTop: 6 }}>
        {revision.changes.map((change) => {
          const decided = change.resolution !== "pending";
          return (
            <div key={changeKey(change)}
              style={{ padding: "6px 8px", marginTop: 4, borderRadius: 6, background: change.op === "add" ? "#f6ffed" : "#f0f7ff", borderLeft: `3px solid ${change.op === "add" ? "#b7eb8f" : "#91caff"}`, opacity: change.stale ? 0.72 : decided ? 0.82 : 1 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  {change.op === "add" ? <AddChangeBody change={change} /> : <ModifyChangeBody change={change} />}
                </div>
                {!decided && !change.stale && (
                  <Space size={4} style={{ flexShrink: 0 }}>
                    <Button type="link" size="small" style={{ padding: 0, color: "#389e0d" }} loading={resolving === revision.revId + ":y:" + changeKey(change)}
                      onClick={() => onResolve(revision, [{ rowId: change.rowId, action: "accept" }], revision.revId + ":y:" + changeKey(change))}>
                      ✓ 采纳
                    </Button>
                    <Button type="link" size="small" style={{ padding: 0, color: "rgba(0,0,0,0.45)" }} loading={resolving === revision.revId + ":n:" + changeKey(change)}
                      onClick={() => onResolve(revision, [{ rowId: change.rowId, action: "reject" }], revision.revId + ":n:" + changeKey(change))}>
                      ✗ 放弃
                    </Button>
                  </Space>
                )}
                {decided && (
                  <Tag color={change.resolution === "accepted" ? "green" : "default"} style={{ marginInlineEnd: 0, fontSize: 12, lineHeight: "18px" }}>
                    {change.resolution === "accepted" ? "已采纳" : "已放弃"}
                  </Tag>
                )}
                {onLocate && !decided && !change.stale && (
                  <Button type="link" size="small" style={{ padding: 0, flexShrink: 0 }} onClick={() => onLocate(change)}>定位</Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RevisionsSection({
  batchId,
  revId,
  onResolved,
  onLocate,
}: {
  batchId: string | null;
  revId?: string | null;
  onResolved: () => void;
  onLocate?: (change: RevisionChange) => void;
}) {
  const [data, setData] = useState<RevisionListResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [resolving, setResolving] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!batchId) return;
    setLoading(true);
    try {
      setData(await knowledgeIntakeApi.listRevisions(batchId));
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [batchId]);

  useEffect(() => { void load(); }, [load, revId]);

  const handleResolve = async (revision: Revision, changes: { rowId: string; action: "accept" | "reject" }[], scope: string) => {
    if (!batchId) return;
    setResolving(scope);
    try {
      await knowledgeIntakeApi.resolveRevision(batchId, revision.revId, changes);
      await load();
      onResolved();
    } catch (err) {
      console.warn("resolve revision failed", err);
    } finally {
      setResolving(null);
    }
  };

  const totalPending = data?.revisions.reduce((n, rev) => n + rev.changes.filter((c) => c.resolution === "pending").length, 0) || 0;

  useEffect(() => {
    if (!revId || loading) return;
    const el = document.querySelector(`[data-rev-id="${revId}"]`);
    if (el) {
      el.scrollIntoView({ block: "center" });
      el.classList.add("rev-flash");
      window.setTimeout(() => el.classList.remove("rev-flash"), 1800);
    }
  }, [revId, loading]);

  if (loading) return <div style={{ textAlign: "center", padding: 32 }}><Spin /></div>;
  if (!data || data.revisions.length === 0) return <Empty description={<Text type="secondary">还没有修订记录，AI 补全或人工编辑后变更会出现在这里</Text>} />;

  return (
    <Space direction="vertical" size={8} style={{ width: "100%" }}>
      {totalPending > 0 && <Tag color="orange" style={{ marginInlineEnd: 0 }}>{totalPending} 条待确认</Tag>}
      {data.revisions.map((revision) => (
        <RevisionCard key={revision.revId} revision={revision} resolving={resolving} onResolve={handleResolve} onLocate={onLocate} />
      ))}
    </Space>
  );
}

/* ── 主面板：合并三层 ── */

export interface UnifiedReviewPanelProps {
  open: boolean;
  onClose: () => void;
  batchId: string | null;
  revId?: string | null;
  /** 质量评分 */
  acceptanceData: AcceptanceReport | null;
  acceptanceLoading: boolean;
  approvedCount: number;
  blockedCount: number;
  applyAsset: string;
  assetOptions: { value: string; label: string }[];
  onApplyAssetChange: (v: string) => void;
  onPreviewApply: (ids: string[]) => void;
  previewLoading: boolean;
  applyResult: ApplyResult | null;
  onGoBuilder: () => void;
  onFixIssue?: (unit: string) => void;
  onExpandIssue?: (unit: string) => Promise<void>;
  /** 结构建议 */
  assistData: AssistGetResult | null;
  assistRunning: boolean;
  assistDeciding: string[];
  onRunAssist: () => void;
  onDecideAssist: (action: "accept" | "dismiss", item: AssistItem) => void;
  onLocateAssist?: (item: AssistItem) => void;
  /** 变更审阅 */
  onRevisionResolved: () => void;
  onLocateRevision?: (change: RevisionChange) => void;
}

export function UnifiedReviewPanel(props: UnifiedReviewPanelProps) {
  const {
    open, onClose, batchId, revId,
    acceptanceData, acceptanceLoading, approvedCount, blockedCount,
    applyAsset, assetOptions, onApplyAssetChange, onPreviewApply, previewLoading, applyResult, onGoBuilder,
    onFixIssue, onExpandIssue,
    assistData, assistRunning, assistDeciding, onRunAssist, onDecideAssist, onLocateAssist,
    onRevisionResolved, onLocateRevision,
  } = props;

  // Badge 计数
  const qualityBadges = acceptanceData && !acceptanceData.ready ? 1 : 0;
  const structBadges = useMemo(
    () => Object.values(assistData?.summary?.byKind || {}).reduce((sum, k) => sum + (k?.open || 0), 0),
    [assistData],
  );
  const totalBadge = qualityBadges + structBadges;

  return (
    <Drawer
      title={
        <Space>
          <RobotOutlined />
          全局AI审核
          {totalBadge > 0 && <Badge count={totalBadge} size="small" offset={[4, -2]} />}
        </Space>
      }
      width={680}
      open={open}
      onClose={onClose}
    >
      <Collapse
        defaultActiveKey={["quality", "structure", "revisions"]}
        items={[
          {
            key: "quality",
            label: (
              <Space size={6}>
                <FileDoneOutlined />
                <Text strong>质量评分</Text>
                {acceptanceData && !acceptanceData.ready && <Tag color="orange" style={{ marginInlineEnd: 0 }}>未达标</Tag>}
                {acceptanceData && acceptanceData.ready && <Tag color="green" style={{ marginInlineEnd: 0 }}>已达标</Tag>}
              </Space>
            ),
            children: (
              <QualitySection
                data={acceptanceData}
                loading={acceptanceLoading}
                approvedCount={approvedCount}
                blockedCount={blockedCount}
                applyAsset={applyAsset}
                assetOptions={assetOptions}
                onApplyAssetChange={onApplyAssetChange}
                onPreviewApply={onPreviewApply}
                previewLoading={previewLoading}
                applyResult={applyResult}
                onGoBuilder={onGoBuilder}
                onFixIssue={onFixIssue}
                onExpandIssue={onExpandIssue}
              />
            ),
          },
          {
            key: "structure",
            label: (
              <Space size={6}>
                <RobotOutlined />
                <Text strong>结构建议</Text>
                {structBadges > 0 && <Tag color="blue" style={{ marginInlineEnd: 0 }}>{structBadges} 条待裁决</Tag>}
              </Space>
            ),
            children: (
              <StructureSection
                data={assistData}
                running={assistRunning}
                deciding={assistDeciding}
                onRun={onRunAssist}
                onDecide={onDecideAssist}
                onLocate={onLocateAssist}
              />
            ),
          },
          {
            key: "revisions",
            label: (
              <Space size={6}>
                <FileDoneOutlined />
                <Text strong>变更审阅</Text>
                <Text type="secondary" style={{ fontSize: 12 }}>AI/人工变更痕迹</Text>
              </Space>
            ),
            children: (
              <RevisionsSection
                batchId={batchId}
                revId={revId}
                onResolved={onRevisionResolved}
                onLocate={onLocateRevision}
              />
            ),
          },
        ]}
      />
    </Drawer>
  );
}
