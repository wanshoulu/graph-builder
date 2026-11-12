/**
 * 审核详情（工作台中栏）：一次只看一个对象，分组只读默认视图 + 按组进入编辑（沿用既有校验规则）
 * 底部固定审核操作：驳回并说明 / 确认并下一项 / 撤回重审（确认与驳回级联子级）
 */
import { useEffect, useState } from "react";
import { Button, Form, Input, InputNumber, Select, Space, Tag, Tooltip, message } from "antd";
import {
  AimOutlined,
  CheckOutlined,
  CloseOutlined,
  EditOutlined,
  LeftOutlined,
  RightOutlined,
  RollbackOutlined,
  BulbOutlined,
  WarningOutlined,
} from "@ant-design/icons";
import type { AssistItem, IntakeItem, IntakeRowInput, IntakeStatus } from "@/api/knowledgeIntake";
import { STATUS_META } from "./constants";
import { DiffConfirmModal, type DiffEntry } from "./DiffConfirmModal";
import { FUNC_GROUPS, INTENT_GROUPS, UTTER_GROUPS, type FieldDef } from "./detail-fields";
import { rowTitle, subtreeIds, type SheetRow } from "./sheet-model";

export interface ReviewDetailProps {
  row: SheetRow | null;
  pos: { n: number; total: number } | null;
  crumb: string;
  saving: boolean;
  siblingUtterances: { rowId: string; text: string; status: IntakeStatus }[];
  onPrev: () => void;
  onNext: () => void;
  onApprove: (ids: string[]) => void;
  onReject: (ids: string[]) => void;
  onReset: (ids: string[]) => void;
  onSaveEdit: (rowId: string, patch: IntakeRowInput) => Promise<unknown>;
  /** AI 辅助审核编辑：点击后自动调 AI 审核/补全，展示对比让用户确认 */
  onAiAssist?: (groupKey: string) => void;
  /** AI 辅助审核中 */
  aiAssistBusy?: boolean;
  /** AI 建议（已按行过滤，仅在 assistTriggeredGroup 匹配时展示） */
  assistItems?: AssistItem[];
  /** AI 审核触发的分组 key（null=未触发） */
  assistTriggeredGroup?: string | null;
  /** 采纳/忽略 AI 建议 */
  onDecideAssist?: (action: "accept" | "dismiss", item: AssistItem) => void;
}

function readValue(r: SheetRow, f: FieldDef): React.ReactNode {
  const v = r[(f.readKey || f.key) as keyof IntakeItem];
  if (f.control === "number") return v === null || v === undefined || v === "" ? "—" : String(v);
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return <span className="kwd-empty">—</span>;
  if (f.control === "select") return <Tag bordered={false} color="blue">{s}</Tag>;
  return s;
}

export function ReviewDetail(props: ReviewDetailProps) {
  const { row, pos, crumb, saving, siblingUtterances, onPrev, onNext, onApprove, onReject, onReset, onSaveEdit, onAiAssist, aiAssistBusy, assistItems, assistTriggeredGroup, onDecideAssist } = props;
  const [form] = Form.useForm();
  const [editingGroup, setEditingGroup] = useState<string | null>(null);
  const [pendingDiff, setPendingDiff] = useState<DiffEntry[] | null>(null);

  useEffect(() => {
    setEditingGroup(null);
    setPendingDiff(null);
  }, [row?.rowId]);

  // AI 建议：仅在触发审核的分组内，按 payload.field 匹配到对应字段（Word 修订式，每条只出现一次）
  const suggestionsForField = (groupKey: string, fieldKey: string): AssistItem[] => {
    if (!assistTriggeredGroup || groupKey !== assistTriggeredGroup) return [];
    return (assistItems || []).filter((it) => it.payload.field === fieldKey);
  };

  // 触发了 AI 审核但本组无任何匹配建议时，在首字段下显示"未发现问题"提示
  const groupHasNoSuggestions = (groupKey: string, fields: FieldDef[]): boolean => {
    if (!assistTriggeredGroup || groupKey !== assistTriggeredGroup) return false;
    return !fields.some((f) => suggestionsForField(groupKey, f.key).length > 0);
  };

  // 渲染单条 AI 建议的内联标注（Word 修订式）
  const renderInlineSuggestion = (item: AssistItem): React.ReactNode => {
    const kindLabel: Record<string, { color: string; text: string }> = {
      gaps: { color: "#52c41a", text: "AI 建议补充" },
      naming: { color: "#1677ff", text: "AI 建议改名" },
      duplicates: { color: "#faad14", text: "AI 发现重复" },
      ambiguities: { color: "#ff4d4f", text: "AI 发现歧义" },
      "node-review": { color: "#1677ff", text: "AI 审核意见" },
    };
    const meta = kindLabel[item.kind] || { color: "#1677ff", text: "AI 建议" };
    const content = item.payload.suggestion || item.payload.name || item.payload.description || item.payload.reason || item.payload.issue || item.payload.overlap || "（无内容）";
    const sevColor = item.payload.severity === "error" ? "#ff4d4f" : item.payload.severity === "warning" ? "#faad14" : "#1677ff";
    const sevMeta = item.kind === "node-review"
      ? { color: sevColor, text: item.payload.issueType === "missing" ? "内容缺失" : item.payload.issueType === "incomplete" ? "内容不完整" : item.payload.issueType === "inaccurate" ? "内容不准确" : item.payload.issueType === "inconsistent" ? "字段不一致" : "描述应规范" }
      : meta;

    return (
      <div key={item.id} style={{
        marginTop: 4,
        padding: "6px 8px",
        borderLeft: `3px solid ${sevMeta.color}`,
        background: `${sevMeta.color}0a`,
        borderRadius: 2,
        fontSize: 12,
        lineHeight: 1.6,
      }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
          <Tag color={sevMeta.color} style={{ marginInlineEnd: 4, flexShrink: 0, fontSize: 11 }}>{meta.text} · {sevMeta.text}</Tag>
          <span style={{ color: "#374151", flex: 1 }}>
            {/* node-review: 显示问题描述 + 新内容（有 newValue 时不显示空话 suggestion） */}
            {item.kind === "node-review" && (
              <>
                {item.payload.issue && (
                  <span style={{ display: "block" }}>{item.payload.issue}</span>
                )}
                {item.payload.newValue ? (
                  <span style={{ color: "#1677ff", display: "block", marginTop: 4, padding: "4px 6px", background: "#1677ff0a", borderRadius: 2 }}>
                    <CheckOutlined style={{ marginInlineEnd: 4 }} />
                    新内容：{item.payload.newValue}
                  </span>
                ) : item.payload.suggestion ? (
                  <span style={{ color: "#6b7280", display: "block", marginTop: 2 }}>
                    {item.payload.suggestion}
                  </span>
                ) : null}
              </>
            )}
            {/* gaps: 显示建议新增的名称和描述 */}
            {item.kind === "gaps" && item.payload.name && (
              <span style={{ fontWeight: 500, color: "#52c41a" }}>+ {item.payload.name}</span>
            )}
            {item.kind === "gaps" && item.payload.description && (
              <span style={{ color: "#6b7280" }}> — {item.payload.description}</span>
            )}
            {/* naming: 显示建议改的名（旧→新） */}
            {item.kind === "naming" && item.payload.suggestion && (
              <span><span style={{ textDecoration: "line-through", color: "#999" }}>{(row as SheetRow).text || (row as SheetRow).name || ""}</span> → <span style={{ color: "#1677ff", fontWeight: 500 }}>{item.payload.suggestion}</span></span>
            )}
            {/* duplicates: 显示重复内容 */}
            {item.kind === "duplicates" && (
              <span>{content}</span>
            )}
            {/* ambiguities: 显示歧义说明 */}
            {item.kind === "ambiguities" && (
              <span>{content}</span>
            )}
            {/* reason 通用 */}
            {item.payload.reason && item.kind !== "gaps" && item.kind !== "node-review" && (
              <span style={{ color: "#9ca3af", display: "block", marginTop: 2 }}>原因：{item.payload.reason}</span>
            )}
          </span>
        </div>
        {onDecideAssist && item.kind === "node-review" && (
          <div style={{ marginTop: 4, display: "flex", gap: 8 }}>
            <Button size="small" type="link" icon={<CheckOutlined />} style={{ color: "#52c41a", padding: 0, fontSize: 12 }} onClick={() => onDecideAssist("accept", item)}>
              {item.payload.newValue ? "采纳修改" : "已知悉"}
            </Button>
            <Button size="small" type="link" style={{ color: "#999", padding: 0, fontSize: 12 }} onClick={() => onDecideAssist("dismiss", item)}>
              忽略
            </Button>
          </div>
        )}
        {onDecideAssist && item.kind !== "node-review" && (
          <div style={{ marginTop: 4, display: "flex", gap: 8 }}>
            <Button size="small" type="link" icon={<AimOutlined />} style={{ color: "#52c41a", padding: 0, fontSize: 12 }} onClick={() => onDecideAssist("accept", item)}>
              采纳
            </Button>
            <Button size="small" type="link" style={{ color: "#999", padding: 0, fontSize: 12 }} onClick={() => onDecideAssist("dismiss", item)}>
              忽略
            </Button>
          </div>
        )}
      </div>
    );
  };

  if (!row) {
    return (
      <div className="kwd">
        <div className="kwd-empty-state">
          <div style={{ fontSize: 32, color: "#c9d2dc" }}>☰</div>
          <div style={{ fontSize: 15, color: "#4b5563", fontWeight: 500 }}>从左侧队列选择一个审核对象</div>
          <div>选中功能 / 意图 / 说法后，这里展示它的分组字段与审核操作</div>
        </div>
      </div>
    );
  }

  const meta = STATUS_META[row.status] || { color: "#98a2b3", label: row.status };
  const groups = row.rowType === "functions" ? FUNC_GROUPS : row.rowType === "intents" ? INTENT_GROUPS : UTTER_GROUPS;
  const hasKids = row.children.length > 0;

  const startEdit = (g: { key: string; fields: FieldDef[] }) => {
    const patch: Record<string, unknown> = {};
    g.fields.forEach((f) => {
      patch[f.key] = row[f.key as keyof IntakeItem] ?? (f.control === "number" ? undefined : "");
    });
    form.setFieldsValue(patch);
    setEditingGroup(g.key);
  };

  // 保存前先弹 diff 确认（Word 修订式）：旧值删除线 → 新值，确认才提交
  const saveEdit = async () => {
    const values = (await form.validateFields()) as Record<string, unknown>;
    const group = groups.find((g) => g.key === editingGroup);
    const entries: DiffEntry[] = [];
    (group?.fields || []).forEach((f) => {
      const before = String(row[f.key as keyof IntakeItem] ?? "");
      const after = String(values[f.key] ?? "");
      if (before !== after) entries.push({ label: f.label, before, after });
    });
    setPendingDiff(entries);
  };

  const confirmSave = async () => {
    const values = form.getFieldsValue() as IntakeRowInput;
    const err = await onSaveEdit(row.rowId, values);
    if (typeof err === "string" && err) {
      // 保存失败：保留编辑态，错误信息就地提示
      message.error(err);
      return;
    }
    setPendingDiff(null);
    setEditingGroup(null);
  };

  return (
    <div className="kwd">
      <div className="kwd-head">
        <div className="kwd-head-top">
          <Space size={0}>
            <Tooltip title="上一项">
              <Button size="small" type="text" aria-label="上一项" icon={<LeftOutlined />} onClick={onPrev} disabled={!pos || pos.n <= 1} />
            </Tooltip>
            <span style={{ fontSize: 12, color: "#8a94a6", padding: "0 4px" }}>
              {pos ? `${pos.n} / ${pos.total}` : "—"}
            </span>
            <Tooltip title="下一项">
              <Button size="small" type="text" aria-label="下一项" icon={<RightOutlined />} onClick={onNext} disabled={!pos || pos.n >= pos.total} />
            </Tooltip>
          </Space>
          <span className="kwd-title" title={rowTitle(row)}>{rowTitle(row)}</span>
          <Space size={6}>
            <Tag color={meta.color} style={{ marginInlineEnd: 0 }}>{meta.label}</Tag>
            {row.sourceStatus === "已审核" && (
              <Tooltip title="Excel 侧人工审过，但两段式要求仍需平台确认">
                <Tag color="geekblue" style={{ marginInlineEnd: 0 }}>Excel已审核</Tag>
              </Tooltip>
            )}
            {row.autoApproved && (
              <Tooltip title="AI 生成且高置信，仍需人工确认">
                <Tag color="purple" style={{ marginInlineEnd: 0 }}>AI建议</Tag>
              </Tooltip>
            )}
          </Space>
        </div>
        <div className="kwd-path">
          {crumb || "—"}
          {(row.sourceStatus === "已审核" || row.autoApproved) && (
            <span style={{ color: "#b0b8c4" }}>　Excel已审核 / AI建议 都不等于平台确认</span>
          )}
        </div>
      </div>

      <div className="kwd-body">
        {siblingUtterances.length > 0 && (
          <div className="kwd-context">
            同意图下共 {siblingUtterances.length + 1} 条说法：
            {siblingUtterances.slice(0, 4).map((u) => (
              <Tag key={u.rowId} bordered={false} style={{ marginInlineEnd: 4 }}>
                {u.text.length > 14 ? `${u.text.slice(0, 14)}…` : u.text}
              </Tag>
            ))}
            {siblingUtterances.length > 4 && <span>+{siblingUtterances.length - 4} 条</span>}
          </div>
        )}

        {groups.map((g) => (
          <div className="kwd-group" key={g.key}>
            <div className="kwd-group-head">
              <span className="kwd-group-title">{g.title}</span>
              {editingGroup === g.key ? (
                <Space size={4}>
                  <Button size="small" type="text" onClick={() => setEditingGroup(null)} disabled={saving}>取消</Button>
                  <Button size="small" type="primary" loading={saving} onClick={() => { void saveEdit(); }}>保存</Button>
                </Space>
              ) : (
                <Space size={4}>
                  <Button size="small" type="text" icon={<EditOutlined style={{ color: "#2878b5" }} />} onClick={() => startEdit(g)}>
                    编辑本组
                  </Button>
                  {onAiAssist && (
                    <Button
                      size="small"
                      type="text"
                      icon={<BulbOutlined style={{ color: "#1677ff" }} />}
                      loading={aiAssistBusy && assistTriggeredGroup === g.key}
                      onClick={() => onAiAssist(g.key)}
                    >
                      AI辅助审核编辑
                    </Button>
                  )}
                </Space>
              )}
            </div>
            {editingGroup === g.key ? (
              <Form form={form} layout="vertical" component="div" style={{ padding: "10px 12px" }}>
                {g.fields.map((f, i) => (
                  <Form.Item
                    key={f.key}
                    name={f.key}
                    label={f.label}
                    extra={f.extra}
                    rules={f.rules}
                    style={{ marginBottom: 10 }}
                  >
                    {f.control === "select" ? (
                      <Select size="small" autoFocus={i === 0} options={f.options?.map((o) => ({ value: o, label: o }))} />
                    ) : f.control === "textarea" ? (
                      <Input.TextArea rows={2} autoFocus={i === 0} />
                    ) : f.control === "number" ? (
                      <InputNumber size="small" min={0} max={1} step={0.05} style={{ width: 120 }} autoFocus={i === 0} />
                    ) : (
                      <Input autoFocus={i === 0} />
                    )}
                  </Form.Item>
                ))}
              </Form>
            ) : (
            g.fields.map((f, fi) => {
                const suggestions = suggestionsForField(g.key, f.key);
                const showNoIssue = fi === 0 && groupHasNoSuggestions(g.key, g.fields);
                return (
                  <div className="kwd-field" key={f.key}>
                    <span className="kwd-field-label">{f.label}</span>
                    <span className="kwd-field-value">
                      {f.key === "reviewNote" && row.reviewNote ? (
                        <span style={{ color: "#d46b08" }}>{row.reviewNote}</span>
                      ) : (
                        readValue(row, f)
                      )}
                    </span>
                    {suggestions.length > 0 && (
                      <div className="kwd-field-ai">
                        {suggestions.map((s) => renderInlineSuggestion(s))}
                      </div>
                    )}
                    {showNoIssue && (
                      <div className="kwd-field-ai">
                        <div style={{
                          padding: "6px 8px",
                          borderLeft: "3px solid #52c41a",
                          background: "#52c41a0a",
                          borderRadius: 2,
                          fontSize: 12,
                          color: "#52c41a",
                        }}>
                          <CheckOutlined style={{ marginInlineEnd: 4 }} />
                          AI 已审核本组内容，未发现需要修改的问题
                        </div>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        ))}
      </div>

      <div className="kwd-foot">
        <span className="kwd-foot-hint">{hasKids && "确认 / 驳回将级联到其子级"}</span>
        {row.status === "pending" ? (
          <>
            <Button size="small" icon={<CloseOutlined />} onClick={() => onReject(subtreeIds(row))}>驳回并说明</Button>
            <Button size="small" type="primary" icon={<CheckOutlined />} loading={saving} onClick={() => onApprove(subtreeIds(row))}>
              确认并下一项
            </Button>
          </>
        ) : (
          <Button size="small" icon={<RollbackOutlined />} loading={saving} onClick={() => onReset([row.rowId])}>
            撤回重审
          </Button>
        )}
      </div>

      <DiffConfirmModal
        open={pendingDiff !== null}
        title="确认修改"
        entries={pendingDiff || []}
        confirmLoading={saving}
        onOk={() => { void confirmSave(); }}
        onCancel={() => setPendingDiff(null)}
      />
    </div>
  );
}
