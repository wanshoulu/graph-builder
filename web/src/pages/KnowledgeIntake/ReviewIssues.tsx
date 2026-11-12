/**
 * 问题与建议面板（工作台右栏）：把选中行相关的阻断项（冲突/挂接缺口）、验收问题、AI 骨架建议、审核备注聚到一处
 * AI 建议沿用既有 accept/dismiss 契约；AI 只给建议，不做决定
 */
import { Button, Tag, Tooltip } from "antd";
import {
  AimOutlined,
  BulbOutlined,
  CaretRightOutlined,
  FileTextOutlined,
  WarningOutlined,
} from "@ant-design/icons";
import type { AcceptanceIssue, AssistItem, IntakeRowType } from "@/api/knowledgeIntake";
import { ASSIST_KIND_META, ISSUE_LEVEL_COLOR, ISSUE_LEVEL_LABEL } from "./constants";

/** 覆盖度问题里的「说法仅 N 条」可一键补全 */
const EXPANDABLE_RE = /说法仅\s*(\d+)\s*条/;

export interface ReviewIssuesProps {
  row: { rowId: string; rowType: IntakeRowType; reviewNote?: string } | null;
  issues: AcceptanceIssue[];
  conflictItems: { rowId: string; text: string; reason: string }[];
  gapNote?: string;
  assistItems: AssistItem[];
  assistBusy: boolean;
  onDecideAssist: (action: "accept" | "dismiss", item: AssistItem) => void;
  onLocate: (unit: string) => void;
  onExpandUtterances: (intentRowId: string) => void;
  onOpenAll?: () => void;
}

export function ReviewIssues(props: ReviewIssuesProps) {
  const {
    row, issues, conflictItems, gapNote, assistItems, assistBusy,
    onDecideAssist, onLocate, onExpandUtterances, onOpenAll,
  } = props;

  if (!row) {
    return (
      <div className="kwi">
        <div className="kwi-head">
          <span>问题与建议</span>
        </div>
        <div className="kwi-quiet" style={{ marginTop: 24 }}>选中审核对象后，这里显示与之相关的问题</div>
      </div>
    );
  }

  const hasBlockers = gapNote || conflictItems.length > 0;
  const quiet = !hasBlockers && !issues.length && !assistItems.length && !row.reviewNote;

  return (
    <div className="kwi" aria-label="问题与建议面板">
      <div className="kwi-head">
        <span>问题与建议</span>
        {onOpenAll && (
          <button type="button" className="kwi-collapse" onClick={onOpenAll}>
            查看全部 AI 建议
          </button>
        )}
      </div>
      <div className="kwi-body">
        {quiet && <div className="kwi-quiet" style={{ marginTop: 20 }}>当前对象没有关联问题</div>}

        {(gapNote || conflictItems.length > 0) && (
          <div className="kwi-section">
            <div className="kwi-section-title">
              <WarningOutlined style={{ color: "#f5222d" }} />
              <span>阻断项（需先解决）</span>
            </div>
            {gapNote && (
              <div className="kwi-item">
                <span className="kwi-item-title">挂接缺口：{gapNote}</span>
                <span className="kwi-item-meta">修改上级路径或驳回该行即可消除</span>
              </div>
            )}
            {conflictItems.map((c) => (
              <div className="kwi-item" key={c.rowId}>
                <span className="kwi-item-title">「{c.text}」疑似挂错意图</span>
                <span className="kwi-item-meta">{c.reason}</span>
              </div>
            ))}
          </div>
        )}

        {issues.length > 0 && (
          <div className="kwi-section">
            <div className="kwi-section-title">
              <FileTextOutlined style={{ color: "#64748b" }} />
              <span>验收问题（{issues.length}）</span>
            </div>
            {issues.map((iss, i) => {
              const expandable = row.rowType === "intents" && EXPANDABLE_RE.test(iss.message);
              return (
                <div className="kwi-item" key={`${iss.unit}-${i}`}>
                  <span className="kwi-item-title">
                    <Tag color={ISSUE_LEVEL_COLOR[iss.level]} style={{ marginInlineEnd: 4 }}>{ISSUE_LEVEL_LABEL[iss.level]}</Tag>
                    {iss.message}
                  </span>
                  <span className="kwi-item-actions">
                    {expandable && (
                      <Tooltip title="LLM 为该意图生成扩展问说法，生成后进入修订审阅，逐条确认后生效">
                        <Button size="small" type="link" icon={<CaretRightOutlined />} onClick={() => onExpandUtterances(row.rowId)}>
                          去补全
                        </Button>
                      </Tooltip>
                    )}
                    <Tooltip title="跳转到该条目在工作台的位置，人工修改保存（修改前可确认差异）后生效">
                      <Button size="small" type="link" onClick={() => onLocate(iss.unit)}>定位修正</Button>
                    </Tooltip>
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {assistItems.length > 0 && (
          <div className="kwi-section">
            <div className="kwi-section-title">
              <BulbOutlined style={{ color: "#faad14" }} />
              <span>AI 建议（{assistItems.length}）</span>
            </div>
            {assistItems.map((it) => {
              const kindMeta = ASSIST_KIND_META[it.kind];
              return (
                <div className="kwi-item" key={it.id}>
                  <span className="kwi-item-title">
                    <Tag color={kindMeta?.color} style={{ marginInlineEnd: 4 }}>{kindMeta?.label || it.kind}</Tag>
                    {it.payload.suggestion || it.payload.name || it.payload.reason || "（无内容）"}
                  </span>
                  {it.payload.reason && it.payload.suggestion && (
                    <span className="kwi-item-meta">{it.payload.reason}</span>
                  )}
                  <span className="kwi-item-actions">
                    <Button size="small" type="link" icon={<AimOutlined />} disabled={assistBusy} onClick={() => onDecideAssist("accept", it)}>
                      采纳
                    </Button>
                    <Button size="small" type="link" disabled={assistBusy} onClick={() => onDecideAssist("dismiss", it)}>
                      忽略
                    </Button>
                  </span>
                </div>
              );
            })}
            <div className="kwi-quiet" style={{ padding: "4px 0 0" }}>AI 只给建议，不做决定；采纳后仍需人工确认</div>
          </div>
        )}

        {row.reviewNote && (
          <div className="kwi-section">
            <div className="kwi-section-title">
              <FileTextOutlined style={{ color: "#d46b08" }} />
              <span>审核备注</span>
            </div>
            <div className="kwi-item">
              <span className="kwi-item-title" style={{ color: "#d46b08" }}>{row.reviewNote}</span>
              <span className="kwi-item-meta">历史审核记录，供复核参考</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
