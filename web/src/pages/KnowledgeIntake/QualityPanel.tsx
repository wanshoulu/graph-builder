/**
 * 质量验收（readiness-first）：先回答「能不能入图」（阻断项/就绪判定），综合分与各维细节居后
 * 入图是门控流程：就绪才可点「应用到图谱」→ 预览变更（index 弹窗）→ 确认入图
 */
import { useState } from "react";
import { Alert, Button, Card, Progress, Select, Space, Spin, Statistic, Tag, Tooltip, Typography } from "antd";
import { ExportOutlined, MessageOutlined, RightOutlined } from "@ant-design/icons";
import type { AcceptanceReport, ApplyResult } from "@/api/knowledgeIntake";
import { ISSUE_LEVEL_COLOR, ISSUE_LEVEL_LABEL, scoreColor } from "./constants";

const { Text } = Typography;

interface QualityPanelProps {
  data: AcceptanceReport | null;
  loading: boolean;
  /** 点问题条目的「定位修正」：跳到审核工作台并定位该节点（unit=功能全路径或意图 ref） */
  onFixIssue?: (unit: string) => void;
  /** 说法不足类问题的「去补全」：直接对该意图跑一次 LLM 扩展问补全 */
  onExpandIssue?: (unit: string) => Promise<void>;
  approvedCount: number;
  blockedCount: number;
  applyAsset: string;
  assetOptions: { value: string; label: string }[];
  onApplyAssetChange: (v: string) => void;
  onPreviewApply: (ids: string[]) => void;
  previewLoading: boolean;
  applyResult: ApplyResult | null;
  onGoBuilder: () => void;
}

const EXPANDABLE_RE = /说法仅 \d+ 条/;

export function QualityPanel(props: QualityPanelProps) {
  const {
    data, loading, onFixIssue, onExpandIssue,
    approvedCount, blockedCount,
    applyAsset, assetOptions, onApplyAssetChange,
    onPreviewApply, previewLoading, applyResult, onGoBuilder,
  } = props;
  const [expandingUnits, setExpandingUnits] = useState<string[]>([]);

  const gateReasons: string[] = [];
  if (approvedCount === 0) gateReasons.push("还没有「已确认」条目");
  if (blockedCount > 0) gateReasons.push(`还有 ${blockedCount} 个阻断项（挂接缺口 / 冲突）待解决`);
  if (data && !data.ready && data.weakestDimension) {
    gateReasons.push(`「${data.dimensions[data.weakestDimension].label}」仅 ${data.dimensions[data.weakestDimension].score} 分（<90）`);
  }
  const canApply = gateReasons.length === 0;

  return (
    <Spin spinning={loading}>
      <Space direction="vertical" size={16} style={{ width: "100%" }}>
        <Card size="small">
          <Space size={40} wrap align="start" style={{ width: "100%" }}>
            <div>
              <div style={{ fontSize: 17, fontWeight: 600, color: canApply ? "#15803d" : "#b45309", marginBottom: 4 }}>
                {canApply ? "✓ 已满足应用条件，可应用到图谱" : "暂不可应用：先解决下方问题"}
              </div>
              {!canApply && (
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {gateReasons.map((g) => (
                    <li key={g}>
                      <Text type="secondary" style={{ fontSize: 12 }}>{g}</Text>
                    </li>
                  ))}
                </ul>
              )}
              {canApply && (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  各维验收全部 ≥90 且无阻断项；应用到图谱前会先预览变更
                </Text>
              )}
            </div>
            {data && (
              <Space size={24}>
                <Statistic title="综合得分" value={data.overall} suffix="/ 100" valueStyle={{ color: scoreColor(data.overall) }} />
                <Tag color={data.ready ? "green" : data.overall >= 70 ? "orange" : "red"} style={{ fontSize: 13, padding: "4px 12px" }}>
                  {data.label}
                </Tag>
              </Space>
            )}
            <div style={{ flex: 1, minWidth: 260 }}>
              <Space wrap>
                <Tooltip title="把「已确认」条目写入图谱草稿；应用该批次全部已确认条目">
                  <Button
                    type="primary"
                    ghost
                    icon={<ExportOutlined />}
                    loading={previewLoading}
                    disabled={!canApply}
                    onClick={() => onPreviewApply([])}
                  >
                    应用到图谱
                  </Button>
                </Tooltip>
                <Select size="small" style={{ minWidth: 220 }} value={applyAsset} onChange={onApplyAssetChange} options={assetOptions} />
                <Button size="small" onClick={onGoBuilder}>去图谱构建复核</Button>
              </Space>
              {!canApply && (
                <Text type="secondary" style={{ display: "block", fontSize: 12, marginTop: 6 }}>
                  就绪前入图按钮保持禁用——两段式要求先完成人工确认与质量验收
                </Text>
              )}
            </div>
          </Space>
        </Card>

        {applyResult && (
          <Alert
            type={applyResult.applied && applyResult.saved ? "success" : "error"}
            showIcon
            message={
              applyResult.applied && applyResult.saved
                ? `已写入「${applyResult.asset}」草稿：新建聚合 ${applyResult.stats.aggregatesCreated}、复用 ${applyResult.stats.aggregatesReused}；新建意图 ${applyResult.stats.intentsCreated}、复用 ${applyResult.stats.intentsReused}；合并说法 ${applyResult.stats.utterancesAdded}、新建边 ${applyResult.stats.edgesCreated}`
                : "图谱校验未通过，未写入草稿"
            }
            description={
              applyResult.applied && applyResult.saved ? (
                <Space direction="vertical" size={0}>
                  {applyResult.stats.skipped.length > 0 && (
                    <Text type="secondary">跳过 {applyResult.stats.skipped.length} 条（{applyResult.stats.skipped[0]?.reason}）</Text>
                  )}
                  {(applyResult.stats.confusableUnresolved?.length ?? 0) > 0 && (
                    <Text type="secondary">
                      易混意图 {applyResult.stats.confusableUnresolved?.length} 个名称未解析到已入图意图已丢弃：{applyResult.stats.confusableUnresolved?.slice(0, 5).join("、")}
                    </Text>
                  )}
                  {applyResult.hint && <Text type="secondary">{applyResult.hint}</Text>}
                </Space>
              ) : (
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {(applyResult.validation?.asset?.errors || []).slice(0, 5).map((e, i) => (
                    <li key={`a${i}`}>{e.message}</li>
                  ))}
                  {(applyResult.validation?.template?.errors || []).slice(0, 5).map((e, i) => (
                    <li key={`t${i}`}>{e.message}</li>
                  ))}
                </ul>
              )
            }
          />
        )}

        {!data ? (
          <Text type="secondary">选择批次后自动生成验收报告</Text>
        ) : (
          <>
            <Text type="secondary" style={{ display: "block" }}>
              各维均分：覆盖度 / 边界 / 命名 / 完整性 / 语义一致性（预检后计入）—— 已检维度全部 ≥90 才建议提交入图
              {!data.ready && data.weakestDimension && (
                <>；当前短板在<Text type="warning">「{data.dimensions[data.weakestDimension].label}」{data.dimensions[data.weakestDimension].score} 分</Text>，点问题条目的「定位修正」跳转修复</>
              )}
            </Text>

            {(["coverage", "boundary", "naming", "completeness", "consistency"] as const).map((key) => {
              const dim = data.dimensions[key];
              const unchecked = dim.score === null;
              return (
                <Card
                  key={key}
                  size="small"
                  title={
                    <Space size={8}>
                      <Text strong>{dim.label}</Text>
                      {unchecked ? (
                        <Tag color="default" style={{ marginInlineEnd: 0 }}>未预检</Tag>
                      ) : (
                        <Text style={{ color: scoreColor(dim.score ?? 0) }}>{dim.score} 分</Text>
                      )}
                      {key === "consistency" && typeof dim.checked === "number" && dim.checked > 0 && (
                        <Text type="secondary" style={{ fontSize: 12 }}>已预检 {dim.checked} 条 · 冲突 {dim.conflicts} 条</Text>
                      )}
                      {dim.issues.length === 0 && <Tag color="green" style={{ marginInlineEnd: 0 }}>无问题</Tag>}
                    </Space>
                  }
                  extra={<Progress type="circle" size={44} percent={dim.score ?? 0} strokeColor={unchecked ? "#d9d9d9" : scoreColor(dim.score ?? 0)} />}
                >
                  {dim.issues.length === 0 ? (
                    <Text type="secondary">该维度未发现问题</Text>
                  ) : (
                    <Space direction="vertical" size={4} style={{ width: "100%" }}>
                      {dim.issues.slice(0, 20).map((issue, i) => {
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
                              <Tooltip title="LLM 为该意图生成扩展问说法，生成后进入修订审阅，逐条确认后生效">
                                <Button
                                  type="link"
                                  size="small"
                                  style={{ padding: 0, fontSize: 12, flexShrink: 0 }}
                                  icon={<MessageOutlined />}
                                  loading={expanding}
                                  onClick={async () => {
                                    setExpandingUnits((prev) => [...prev, issue.unit]);
                                    try {
                                      await onExpandIssue(issue.unit);
                                    } finally {
                                      setExpandingUnits((prev) => prev.filter((u) => u !== issue.unit));
                                    }
                                  }}
                                >
                                  去补全
                                </Button>
                              </Tooltip>
                            )}
                            {issue.unit && onFixIssue && !expandable && (
                              <Tooltip title="跳转到该条目在工作台的位置，人工修改保存（修改前可确认差异）后生效">
                                <Button
                                  type="link"
                                  size="small"
                                  style={{ padding: 0, fontSize: 12, flexShrink: 0 }}
                                  icon={<RightOutlined />}
                                  onClick={() => onFixIssue(issue.unit)}
                                >
                                  定位修正
                                </Button>
                              </Tooltip>
                            )}
                          </Space>
                        );
                      })}
                      {dim.issues.length > 20 && (
                        <Text type="secondary" style={{ fontSize: 12 }}>… 其余 {dim.issues.length - 20} 条略</Text>
                      )}
                    </Space>
                  )}
                </Card>
              );
            })}

            {data.assist && data.assist.total > 0 && (
              <Alert
                type="warning"
                showIcon
                message={`还有 ${Object.values(data.assist.byKind).reduce((s, k) => s + (k?.open || 0), 0)} 条 AI 建议未裁决`}
                description="先到审核工作台处理 AI 骨架助手里的建议（采纳/忽略），再复核验收报告的变化"
              />
            )}
          </>
        )}
      </Space>
    </Spin>
  );
}
