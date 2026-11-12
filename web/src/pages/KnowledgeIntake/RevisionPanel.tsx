/**
 * 修订审阅抽屉（Word 修订式 track changes）
 * AI 补全 / 人工编辑产生的每处变更都以痕迹呈现：逐条 ✓采纳（生效）/ ✗放弃（留痕），裁决权在人；
 * 两段式不破：采纳 = 平台人工确认（行 approved），放弃 = 行驳回留痕
 */
import { Alert, Button, Drawer, Empty, Space, Spin, Tag, Typography } from "antd";
import { CheckOutlined, CloseOutlined, FileDoneOutlined } from "@ant-design/icons";
import { useCallback, useEffect, useState } from "react";
import type { Revision, RevisionChange, RevisionListResult } from "@/api/knowledgeIntake";
import { knowledgeIntakeApi } from "@/api/knowledgeIntake";
import { REVISION_FIELD_LABEL, REVISION_TYPE_META, ROW_TYPE_LABEL } from "./constants";

const { Text } = Typography;

function changeKey(change: RevisionChange) {
  return `${change.rowId}::${change.field || ""}`;
}

/** 新增变更：绿色 + 条 + 浅绿底 + 下划线（Word 插入痕迹）；行已删除灰显 */
function AddChangeBody({ change }: { change: RevisionChange }) {
  const stale = !!change.stale;
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
      <span style={{ color: "#389e0d", fontWeight: 600, userSelect: "none" }}>+</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            color: stale ? "rgba(0,0,0,0.45)" : "#389e0d",
            textDecoration: stale ? "line-through" : "underline",
            textDecorationColor: "#b7eb8f",
            textDecorationThickness: 2,
            wordBreak: "break-all",
          }}
        >
          {change.label}
        </span>
        {!stale && (change.confidence !== undefined || change.sourceStatus) && (
          <Space size={4} style={{ marginInlineStart: 8 }}>
            {change.confidence !== undefined && (
              <Tag style={{ marginInlineEnd: 0, fontSize: 12, lineHeight: "18px" }}>
                置信 {Math.round((change.confidence || 0) * 100)}%
              </Tag>
            )}
            {change.sourceStatus && (
              <Tag color={change.autoApproved ? "green" : change.autoRejected ? "red" : "default"} style={{ marginInlineEnd: 0, fontSize: 12, lineHeight: "18px" }}>
                AI 分诊：{change.sourceStatus}
              </Tag>
            )}
          </Space>
        )}
        {stale && <Text type="secondary" style={{ fontSize: 12, marginInlineStart: 8 }}>行已不存在，裁决时自动按放弃处理</Text>}
      </div>
    </div>
  );
}

/** 修改变更：字段 label + 旧值删除线红 → 新值蓝（Word 修改痕迹） */
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
          <Text type="secondary" style={{ fontSize: 12 }}>
            {revision.createdAt.slice(0, 16).replace("T", " ")} · {revision.createdBy === "auto" ? "AI" : revision.createdBy}
          </Text>
          {open && <Tag color="orange" style={{ marginInlineEnd: 0 }}>{pending.length} 条待审</Tag>}
        </Space>
        {open && (
          <Space size={8}>
            <Button
              type="primary"
              size="small"
              icon={<CheckOutlined />}
              loading={resolving === revision.revId + ":all:y"}
              onClick={() => onResolve(revision, pending.map((c) => ({ rowId: c.rowId, action: "accept" as const })), revision.revId + ":all:y")}
            >
              全部采纳
            </Button>
            <Button
              size="small"
              icon={<CloseOutlined />}
              loading={resolving === revision.revId + ":all:n"}
              onClick={() => onResolve(revision, pending.map((c) => ({ rowId: c.rowId, action: "reject" as const })), revision.revId + ":all:n")}
            >
              全部放弃
            </Button>
          </Space>
        )}
      </div>
      <div style={{ marginTop: 6 }}>
        {revision.changes.map((change) => {
          const decided = change.resolution !== "pending";
          return (
            <div
              key={changeKey(change)}
              style={{
                padding: "6px 8px",
                marginTop: 4,
                borderRadius: 6,
                background: change.op === "add" ? "#f6ffed" : "#f0f7ff",
                borderLeft: `3px solid ${change.op === "add" ? "#b7eb8f" : "#91caff"}`,
                opacity: change.stale ? 0.72 : decided ? 0.82 : 1,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  {change.op === "add" ? <AddChangeBody change={change} /> : <ModifyChangeBody change={change} />}
                </div>
                {!decided && !change.stale && (
                  <Space size={4} style={{ flexShrink: 0 }}>
                    <Button
                      type="link"
                      size="small"
                      style={{ padding: 0, color: "#389e0d" }}
                      loading={resolving === revision.revId + ":y:" + changeKey(change)}
                      onClick={() => onResolve(revision, [{ rowId: change.rowId, action: "accept" }], revision.revId + ":y:" + changeKey(change))}
                    >
                      ✓ 采纳
                    </Button>
                    <Button
                      type="link"
                      size="small"
                      style={{ padding: 0, color: "rgba(0,0,0,0.45)" }}
                      loading={resolving === revision.revId + ":n:" + changeKey(change)}
                      onClick={() => onResolve(revision, [{ rowId: change.rowId, action: "reject" }], revision.revId + ":n:" + changeKey(change))}
                    >
                      ✗ 放弃
                    </Button>
                  </Space>
                )}
                {decided && (
                  <Space size={4} style={{ flexShrink: 0 }}>
                    <Tag color={change.resolution === "accepted" ? "green" : "default"} style={{ marginInlineEnd: 0, fontSize: 12, lineHeight: "18px" }}>
                      {change.resolution === "accepted" ? "已采纳" : "已放弃"}
                    </Tag>
                    {change.resolvedBy && (
                      <Text type="secondary" style={{ fontSize: 12 }}>{change.resolvedBy}</Text>
                    )}
                    {change.note === "行已不存在" && <Text type="secondary" style={{ fontSize: 12 }}>行已不存在</Text>}
                  </Space>
                )}
                {onLocate && !decided && !change.stale && (
                  <Button type="link" size="small" style={{ padding: 0, flexShrink: 0 }} onClick={() => onLocate(change)}>
                    定位
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface RevisionPanelProps {
  batchId: string | null;
  open: boolean;
  /** 有值 = 只为定位这次新产生的修订（AI 补全后自动打开） */
  revId?: string | null;
  onClose: () => void;
  /** 任一裁决成功后回调（父级刷新树/队列/摘要） */
  onResolved: () => void;
  /** 变更定位（跳到工作台对应行） */
  onLocate?: (change: RevisionChange) => void;
}

export function RevisionPanel({ batchId, open, revId, onClose, onResolved, onLocate }: RevisionPanelProps) {
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

  useEffect(() => {
    if (open) void load();
  }, [open, load, revId]);

  const handleResolve = async (
    revision: Revision,
    changes: { rowId: string; action: "accept" | "reject" }[],
    scope: string,
  ) => {
    if (!batchId) return;
    setResolving(scope);
    try {
      await knowledgeIntakeApi.resolveRevision(batchId, revision.revId, changes);
      await load();
      onResolved();
    } catch (err) {
      // 失败留在原状：下次打开重载
      console.warn("resolve revision failed", err);
    } finally {
      setResolving(null);
    }
  };

  const totalPending = data?.revisions.reduce((n, rev) => n + rev.changes.filter((c) => c.resolution === "pending").length, 0) || 0;

  // revId 有值（AI 补全后自动打开）：滚到该修订并短暂高亮
  useEffect(() => {
    if (!open || !revId || loading) return;
    const el = document.querySelector(`[data-rev-id="${revId}"]`);
    if (el) {
      el.scrollIntoView({ block: "center" });
      el.classList.add("rev-flash");
      window.setTimeout(() => el.classList.remove("rev-flash"), 1800);
    }
  }, [open, revId, loading]);

  return (
    <Drawer
      title={
        <Space>
          <FileDoneOutlined />
          修订审阅（痕迹 · 逐条确认）
          {totalPending > 0 && <Tag color="orange" style={{ marginInlineEnd: 0 }}>{totalPending} 条待确认</Tag>}
        </Space>
      }
      width={560}
      open={open}
      onClose={onClose}
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="绿色 + 为 AI 新增，删除线为修改前旧值：采纳后变更生效（行变已确认），放弃则驳回留痕"
      />
      {loading ? (
        <div style={{ textAlign: "center", padding: 48 }}><Spin /></div>
      ) : !data || data.revisions.length === 0 ? (
        <Empty description="还没有修订记录：AI 补全扩展问或人工编辑保存后，变更会以痕迹形式出现在这里" />
      ) : (
        data.revisions.map((revision) => (
          <RevisionCard key={revision.revId} revision={revision} resolving={resolving} onResolve={handleResolve} onLocate={onLocate} />
        ))
      )}
    </Drawer>
  );
}
