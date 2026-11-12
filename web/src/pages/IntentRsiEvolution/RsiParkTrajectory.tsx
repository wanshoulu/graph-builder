/**
 * 园区独立引擎精度提升曲线（集成在 RSI 进化实验台内）。
 * 数据来源：后端 /api/intent-rsi/park-history + /api/intent-rsi/park-calibrate。
 * 设计：与主页面同一套「墨 · 线 · 蓝」纪律——题型分组柱沿用蓝梯度（与 RsiTrajectory 一致），
 * 折线用蓝/橙双系列；术语统一为「完全正确率 / 部分得分率」（不再用 Top-1/Top-5 精度）。
 */
import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Card, Collapse, Table, Tabs, Tag, Typography, message } from "antd";
import { ExperimentOutlined, CheckCircleOutlined, CloseCircleOutlined, ArrowUpOutlined } from "@ant-design/icons";
import { rsiRequest } from "./rsiShared";
import { COLOR, CHART_DIM, InfoBox, MetricCard, RULE, SectionTitle, SHADOW, TYPE, niceDomain } from "./rsiDesign";

// ── 类型定义 ──
export interface ParkFixedIntent { intent: string; case: string; fix: string; }
export interface ParkNewFailure { intent: string; case: string; reason: string; }
export interface ParkVersion {
  version: string;
  strict_pct: number;
  relaxed_pct: number;
  strict_correct: number;
  relaxed_correct: number;
  failed: number;
  byShape: {
    single_intent: { strict_pct: number; relaxed_pct: number };
    multi_intent: { strict_pct: number; relaxed_pct: number };
    ambiguous_intent: { strict_pct: number; relaxed_pct: number };
  };
  changelog: string;
  details: string[];
  fixedIntents: ParkFixedIntent[];
  newFailures: ParkNewFailure[];
}
export interface ParkHistory {
  engine: string;
  totalCases: number;
  byShape?: { single_intent: number; multi_intent: number; ambiguous_intent: number };
  versions: ParkVersion[];
}
interface ParkCalibReport {
  engine: string; total: number; strict_pct: number; relaxed_pct: number;
  by_shape: Record<string, { total: number; strict_pct: number; relaxed_pct: number }>;
  results: { case_id: string; query: string; shape: string; strict: boolean; predicted: string[] }[];
  finishedAt: string;
}
interface ParkCalibState { status: "idle" | "running" | "done" | "error"; startedAt: string | null; report: ParkCalibReport | null; }

const SHAPE_LABELS: Record<string, string> = {
  single_intent: "单意图",
  multi_intent: "复合句",
  ambiguous_intent: "模糊提问",
};

// 题型分组柱：与主页面 RsiTrajectory 同套蓝梯度（遵守"一种强调色，用明度区分类别"）
const SHAPE_COLORS: Record<string, string> = {
  single_intent: "#2a78d6",
  multi_intent: "#6ba3e3",
  ambiguous_intent: "#a8c9ee",
};

const { W, H, PAD } = CHART_DIM;

// ── 主组件 ──
export function RsiParkTrajectory() {
  const [history, setHistory] = useState<ParkHistory | null>(null);
  const [calib, setCalib] = useState<ParkCalibState>({ status: "idle", startedAt: null, report: null });
  const [busy, setBusy] = useState(false);
  /** 只读视图切分：overview=对象+概览+trend；data=题型+校准+高级数据；runs=版本迭代记录 */
  const [view, setView] = useState<"overview" | "runs" | "data">("overview");

  const refreshHistory = useCallback(async () => {
    try {
      const r = await rsiRequest<{ history: ParkHistory; calibration: ParkCalibState }>("/park-history");
      setHistory(r.history);
      setCalib(r.calibration || { status: "idle", startedAt: null, report: null });
    } catch { /* 静默 */ }
  }, []);

  useEffect(() => { refreshHistory(); }, [refreshHistory]);
  useEffect(() => {
    if (calib.status !== "running") return;
    const t = setInterval(refreshHistory, 3000);
    return () => clearInterval(t);
  }, [calib.status, refreshHistory]);

  const runCalibrate = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await rsiRequest("/park-calibrate", {});
      setCalib({ status: "running", startedAt: new Date().toISOString(), report: null });
      setTimeout(refreshHistory, 1500);
      message.success("已启动园区引擎校准，完成后自动显示结果");
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const versions = history?.versions || [];
  const totalCases = history?.totalCases ?? 60;
  const latest = versions.length > 0 ? versions[versions.length - 1] : null;
  const first = versions.length > 0 ? versions[0] : null;
  const delta = latest && first
    ? { strict: latest.strict_pct - first.strict_pct, relaxed: latest.relaxed_pct - first.relaxed_pct }
    : null;

  const fixColumns = [
    { title: "意图", dataIndex: "intent", key: "intent", width: 120, render: (t: string) => <Tag color="blue" style={{ borderRadius: 4 }}>{t}</Tag> },
    { title: "测试用例", dataIndex: "case", key: "case", width: 200 },
    { title: "修复方式", dataIndex: "fix", key: "fix" },
  ];

  // SVG 折线图
  const chart = (() => {
    if (versions.length === 0) return null;
    const series = [
      { key: "strict", name: "完全正确率", color: COLOR.strict, get: (v: ParkVersion) => v.strict_pct },
      { key: "relaxed", name: "部分得分率", color: COLOR.relaxed, get: (v: ParkVersion) => v.relaxed_pct },
    ];
    const allVals = versions.flatMap(v => series.map(s => s.get(v)));
    const [lo, hi] = niceDomain(allVals);
    const x = (i: number) => PAD.l + (i * (W - PAD.l - PAD.r)) / Math.max(versions.length - 1, 1);
    const y = (v: number) => PAD.t + ((hi - v) * (H - PAD.t - PAD.b)) / (hi - lo);
    const ticks = [0, 1, 2, 3, 4].map(k => Math.round(lo + ((hi - lo) * k) / 4));

    return (
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }}>
        <defs>
          <linearGradient id="strictGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={COLOR.strict} stopOpacity={0.15} />
            <stop offset="100%" stopColor={COLOR.strict} stopOpacity={0} />
          </linearGradient>
          <linearGradient id="relaxedGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={COLOR.relaxed} stopOpacity={0.12} />
            <stop offset="100%" stopColor={COLOR.relaxed} stopOpacity={0} />
          </linearGradient>
        </defs>

        {/* 背景 */}
        <rect x={PAD.l} y={PAD.t} width={W - PAD.l - PAD.r} height={H - PAD.t - PAD.b} fill={COLOR.chartBg} rx={8} stroke={COLOR.gridLine} />

        {/* 网格线 */}
        {ticks.map(t => (
          <g key={t}>
            <line x1={PAD.l} y1={y(t)} x2={W - PAD.r} y2={y(t)} stroke={COLOR.gridLine} strokeDasharray="3 3" />
            <text x={PAD.l - 8} y={y(t) + 4} textAnchor="end" fontSize={11} fill={COLOR.axisLabel} fontWeight={500}>{t}%</text>
          </g>
        ))}

        {/* 填充区域 */}
        {series.map(s => {
          const areaPts = versions.map((v, i) => `${x(i)},${y(s.get(v))}`).join(" ");
          const baseY = H - PAD.b;
          return (
            <polygon
              key={`area-${s.key}`}
              points={`${PAD.l},${baseY} ${areaPts} ${x(versions.length - 1)},${baseY}`}
              fill={`url(#${s.key}Grad)`}
            />
          );
        })}

        {/* 折线 */}
        {series.map(s => (
          <polyline
            key={s.key}
            fill="none"
            stroke={s.color}
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray={s.key === "relaxed" ? "6 4" : undefined}
            points={versions.map((v, i) => `${x(i)},${y(s.get(v))}`).join(" ")}
          />
        ))}

        {/* 数据点 */}
        {series.map(s =>
          versions.map((v, i) => (
            <g key={`pt-${s.key}-${v.version}-${i}`}>
              <circle cx={x(i)} cy={y(s.get(v))} r={i === versions.length - 1 ? 6 : 4.5} fill="#fff" stroke={s.color} strokeWidth={2.5} />
              {i === versions.length - 1 && (
                <circle cx={x(i)} cy={y(s.get(v))} r={10} fill={s.color} opacity={0.15} />
              )}
            </g>
          )),
        )}

        {/* 末端标签 */}
        {series.map(s => {
          const last = s.get(versions[versions.length - 1]);
          return (
            <g key={`lbl-${s.key}`}>
              <rect x={x(versions.length - 1) + 10} y={y(last) - 18} width={48} height={20} rx={4} fill={s.color} />
              <text x={x(versions.length - 1) + 34} y={y(last) - 4} textAnchor="middle" fontSize={12} fontWeight={700} fill="#fff">
                {last}%
              </text>
            </g>
          );
        })}

        {/* X 轴标签 */}
        {versions.map((v, i) => (
          <text key={`v-${v.version}-${i}`} x={x(i)} y={H - 30} textAnchor="middle" fontSize={12} fontWeight={600} fill={COLOR.textSecondary}>
            {v.version}
          </text>
        ))}
        {versions.map((v, i) => (
          <text key={`cl-${v.version}-${i}`} x={x(i)} y={H - 14} textAnchor="middle" fontSize={9.5} fill={COLOR.axisLabel}>
            {v.changelog.length > 14 ? v.changelog.slice(0, 14) + "…" : v.changelog}
          </text>
        ))}
      </svg>
    );
  })();

  if (versions.length === 0) {
    return (
      <Card style={{ borderRadius: 12, textAlign: "center", padding: 40 }}>
        <Typography.Text type="secondary" style={{ fontSize: TYPE.body }}>园区引擎历史数据加载中…</Typography.Text>
      </Card>
    );
  }

  // 只读任务的分段内容——与可进化任务同一套 Tabs 骨架对齐（10-17 用户反馈：三个任务点进去界面要一致）
  const overviewBody = (
    <>
      {/* ── 0. 方法论声明：这条曲线是对同一份题库反复调参的结果 ── */}
      <Alert
        style={{ marginBottom: 16 }}
        type="warning"
        showIcon
        message="这条曲线是对同一份题库反复调参的结果，不是引擎质量的证据"
        description="历史版本里包含针对评测题的特设规则（如「怎么办」不触发澄清、AMBIGUOUS_SUPPRESS 抑制规则、复合关键词穷举）。在评测集上拿到 100% 只说明规则记住了这些题，不代表对新问题的泛化能力。要看引擎的泛化水平，需要一份引擎从未见过的新题。"
      />

      {/* ── 1. 实验对象 ── */}
      <SectionTitle hint="当前园区引擎基本信息（对评测集调参，非泛化指标）。" color={COLOR.strict}>实验对象</SectionTitle>
      <InfoBox style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <Tag color="green" style={{ borderRadius: 6, padding: "2px 10px", fontSize: TYPE.small }}>intent-evaluator-park.js</Tag>
        <Tag style={{ borderRadius: 6, padding: "2px 10px", fontSize: TYPE.small }}>题库 {totalCases} 条</Tag>
        <Tag color="geekblue" style={{ borderRadius: 6, padding: "2px 10px", fontSize: TYPE.small }}>当前版本 {latest?.version ?? "—"}</Tag>
        {history?.byShape && (
          <Tag style={{ borderRadius: 6, padding: "2px 10px", fontSize: TYPE.small, background: COLOR.bg, border: `1px solid ${COLOR.border}` }}>
            单意图 {history.byShape.single_intent} · 复合句 {history.byShape.multi_intent} · 模糊提问 {history.byShape.ambiguous_intent}
          </Tag>
        )}
      </InfoBox>

      {/* ── 2. 快速概览 ── */}
      <SectionTitle hint="当前精度水平、总提升幅度、剩余错题。" color={COLOR.accent}>快速概览</SectionTitle>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 4 }}>
        <MetricCard
          title="完全正确率"
          value={latest?.strict_pct ?? 0}
          suffix="%"
          sub={`${latest?.strict_correct ?? 0} / ${totalCases} 条正确`}
          color={COLOR.strict}
          icon={<CheckCircleOutlined />}
        />
        <MetricCard
          title="部分得分率"
          value={latest?.relaxed_pct ?? 0}
          suffix="%"
          sub={`${latest?.relaxed_correct ?? 0} / ${totalCases} 条正确`}
          color={COLOR.relaxed}
          icon={<CheckCircleOutlined />}
        />
        <MetricCard
          title="完全正确率提升"
          value={delta?.strict ?? 0}
          precision={1}
          suffix="%"
          sub={`从 ${first?.version} 到 ${latest?.version}`}
          color={COLOR.accent}
          icon={<ArrowUpOutlined />}
        />
        <MetricCard
          title="剩余错题"
          value={latest?.failed ?? 0}
          suffix="条"
          sub={latest?.failed === 0 ? "全部正确" : `${latest?.failed} 条待修复`}
          color={latest?.failed === 0 ? COLOR.relaxed : COLOR.warning}
          icon={latest?.failed === 0 ? <CheckCircleOutlined /> : <CloseCircleOutlined />}
        />
      </div>

      {/* ── 3. 成绩趋势 ── */}
      <SectionTitle hint="每次版本迭代的精度走势。" color={COLOR.strict}>成绩趋势</SectionTitle>
      <InfoBox style={{ padding: "14px 16px" }}>
        {chart}
        <div style={{ marginTop: 12, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: 16 }}>
            <span style={{ fontSize: TYPE.micro, color: COLOR.textSecondary, display: "inline-flex", alignItems: "center" }}>
              <span style={{ display: "inline-block", width: 12, height: 2, background: COLOR.strict, marginRight: 5 }} />
              完全正确率
            </span>
            <span style={{ fontSize: TYPE.micro, color: COLOR.textSecondary, display: "inline-flex", alignItems: "center" }}>
              <span style={{ display: "inline-block", width: 12, height: 2, background: COLOR.relaxed, marginRight: 5 }} />
              部分得分率
            </span>
          </div>
          <Typography.Text type="secondary" style={{ fontSize: TYPE.micro }}>题库 {totalCases} 条 · 横轴为引擎版本迭代</Typography.Text>
        </div>
      </InfoBox>
    </>
  );

  const runsBody = (
    <>
      {/* ── 6. 版本迭代记录（时间轴） ── */}
      <SectionTitle hint="每个版本做了什么改动、修复了哪些意图、有没有引入新问题。" color={COLOR.accent}>版本迭代记录</SectionTitle>
      <div style={{ position: "relative", paddingLeft: 20, marginBottom: 4 }}>
        {/* 时间轴竖线 */}
        <div style={{ position: "absolute", left: 7, top: 8, bottom: 8, width: 2, background: RULE }} />

        {versions.map((v, idx) => {
          const prev = idx > 0 ? versions[idx - 1] : null;
          const improvement = prev ? v.strict_pct - prev.strict_pct : 0;
          const isLatest = idx === versions.length - 1;
          return (
            <div key={v.version} style={{ position: "relative", marginBottom: 16 }}>
              {/* 时间轴节点 */}
              <div
                style={{
                  position: "absolute",
                  left: -20,
                  top: 12,
                  width: 16,
                  height: 16,
                  borderRadius: "50%",
                  background: isLatest ? COLOR.strict : COLOR.gridLine,
                  border: "3px solid #fff",
                  boxShadow: isLatest ? `0 0 0 4px ${COLOR.strict}25` : "none",
                }}
              />

              <div
                style={{
                  background: "#fff",
                  borderRadius: 12,
                  padding: "14px 18px",
                  border: `1px solid ${isLatest ? `${COLOR.strict}30` : COLOR.border}`,
                  boxShadow: isLatest ? SHADOW.cardHover : "none",
                }}
              >
                {/* 标题行 */}
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
                  <Tag color={isLatest ? "blue" : "default"} style={{ borderRadius: 6, fontWeight: 600, minWidth: 44, textAlign: "center" }}>{v.version}</Tag>
                  <span style={{ fontSize: TYPE.body, fontWeight: 600, color: COLOR.strict, fontVariantNumeric: "tabular-nums" }}>{v.strict_pct}%</span>
                  <span style={{ fontSize: TYPE.micro, color: COLOR.textSecondary }}>完全正确率</span>
                  <span style={{ fontSize: TYPE.body, fontWeight: 600, color: COLOR.relaxed, marginLeft: 8, fontVariantNumeric: "tabular-nums" }}>{v.relaxed_pct}%</span>
                  <span style={{ fontSize: TYPE.micro, color: COLOR.textSecondary }}>部分得分率</span>
                  {improvement > 0 && (
                    <Tag color="green" style={{ borderRadius: 4, fontSize: 11 }}>
                      <ArrowUpOutlined style={{ fontSize: 9 }} /> {improvement.toFixed(1)}%
                    </Tag>
                  )}
                  <span style={{ fontSize: TYPE.micro, color: COLOR.textSecondary, marginLeft: "auto" }}>
                    {v.strict_correct}/{totalCases} 正确 · {v.failed} 错
                  </span>
                </div>

                {/* 改动摘要 */}
                <div style={{ background: COLOR.bg, borderRadius: 8, padding: "8px 12px", marginBottom: 8, fontSize: TYPE.small, color: COLOR.textPrimary }}>
                  {v.changelog}
                </div>

                {/* 各题型详情 */}
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 8 }}>
                  {v.details.map((d, i) => (
                    <div key={i} style={{ fontSize: TYPE.small, color: COLOR.textSecondary, background: COLOR.bg, borderRadius: 6, padding: "4px 10px", flex: "1 1 200px" }}>
                      {d}
                    </div>
                  ))}
                </div>

                {/* 修复的意图 */}
                {v.fixedIntents.length > 0 && (
                  <div style={{ marginBottom: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 6 }}>
                      <CheckCircleOutlined style={{ color: COLOR.relaxed, fontSize: 13 }} />
                      <Typography.Text strong style={{ fontSize: TYPE.small }}>本版修复意图（{v.fixedIntents.length} 个）</Typography.Text>
                    </div>
                    <Table
                      size="small"
                      columns={fixColumns}
                      dataSource={v.fixedIntents}
                      rowKey={(_, i) => `fix-${i}`}
                      pagination={false}
                      style={{ borderRadius: 8, overflow: "hidden" }}
                    />
                  </div>
                )}

                {/* 引入的新问题 */}
                {v.newFailures.length > 0 && (
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 4 }}>
                      <CloseCircleOutlined style={{ color: COLOR.danger, fontSize: 13 }} />
                      <Typography.Text strong style={{ fontSize: TYPE.small, color: COLOR.danger }}>本版引入的新问题（{v.newFailures.length} 个）</Typography.Text>
                    </div>
                    {v.newFailures.map((f, i) => (
                      <div key={i} style={{
                        fontSize: TYPE.small,
                        color: COLOR.danger,
                        background: COLOR.dangerBg,
                        borderRadius: 6,
                        padding: "6px 10px",
                        marginBottom: 4,
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                      }}>
                        <Tag color="red" style={{ fontSize: 10, borderRadius: 4, margin: 0 }}>{f.intent}</Tag>
                        <span>用例「{f.case}」— {f.reason}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );

  const dataBody = (
    <>
      {/* ── 4. 题型分类精度 ── */}
      <SectionTitle hint="按题型看每个版本的完全正确率变化。" color={COLOR.accent}>题型分类精度</SectionTitle>
      <InfoBox style={{ padding: "14px 16px" }}>
        {(() => {
          const shapes = ["single_intent", "multi_intent", "ambiguous_intent"] as const;
          if (versions.length === 0) return <Typography.Text type="secondary" style={{ fontSize: TYPE.body }}>暂无数据</Typography.Text>;
          const chartW = W - PAD.l - PAD.r;
          const groupW = chartW / versions.length;
          const barW = Math.min(22, (groupW * 0.7) / shapes.length);
          const barsTotal = barW * shapes.length;
          const baseY = H - PAD.b;
          const plotH = H - PAD.t - PAD.b;
          const y = (v: number) => PAD.t + ((100 - v) * plotH) / 100;
          const ticks = [0, 25, 50, 75, 100];

          return (
            <>
              <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }}>
                {/* 背景 */}
                <rect x={PAD.l} y={PAD.t} width={chartW} height={plotH} fill={COLOR.chartBg} rx={8} stroke={COLOR.gridLine} />
                {/* 网格线 */}
                {ticks.map(t => (
                  <g key={t}>
                    <line x1={PAD.l} y1={y(t)} x2={W - PAD.r} y2={y(t)} stroke={COLOR.gridLine} strokeDasharray="3 3" />
                    <text x={PAD.l - 8} y={y(t) + 4} textAnchor="end" fontSize={11} fill={COLOR.axisLabel} fontWeight={500}>{t}%</text>
                  </g>
                ))}
                {/* 分组柱状图 */}
                {versions.map((v, i) => {
                  const groupStart = PAD.l + i * groupW + (groupW - barsTotal) / 2;
                  return (
                    <g key={`grp-${v.version}-${i}`}>
                      {shapes.map((s, si) => {
                        const val = v.byShape[s]?.strict_pct ?? 0;
                        const barX = groupStart + si * barW;
                        return (
                          <rect
                            key={`bar-${v.version}-${s}`}
                            x={barX}
                            y={y(val)}
                            width={barW - 3}
                            height={Math.max(0, baseY - y(val))}
                            fill={SHAPE_COLORS[s]}
                            opacity={i === versions.length - 1 ? 1 : 0.6}
                            rx={2}
                          >
                            <title>{`${v.version} · ${SHAPE_LABELS[s]}：完全正确率 ${val}%`}</title>
                          </rect>
                        );
                      })}
                    </g>
                  );
                })}
                {/* 末端版本数值标签 */}
                {(() => {
                  const v = versions[versions.length - 1];
                  const groupStart = PAD.l + (versions.length - 1) * groupW + (groupW - barsTotal) / 2;
                  return shapes.map((s, si) => {
                    const val = v.byShape[s]?.strict_pct ?? 0;
                    const barX = groupStart + si * barW;
                    return (
                      <text key={`lbl-${s}`} x={barX + (barW - 3) / 2} y={y(val) - 6} textAnchor="middle" fontSize={11} fontWeight={700} fill={SHAPE_COLORS[s]}>
                        {val}%
                      </text>
                    );
                  });
                })()}
                {/* X 轴标签 */}
                {versions.map((v, i) => {
                  const groupCenter = PAD.l + i * groupW + groupW / 2;
                  return (
                    <text key={`v-${v.version}-${i}`} x={groupCenter} y={H - 30} textAnchor="middle" fontSize={12} fontWeight={600} fill={COLOR.textSecondary}>
                      {v.version}
                    </text>
                  );
                })}
                {versions.map((v, i) => {
                  const groupCenter = PAD.l + i * groupW + groupW / 2;
                  return (
                    <text key={`cl-${v.version}-${i}`} x={groupCenter} y={H - 14} textAnchor="middle" fontSize={9.5} fill={COLOR.axisLabel}>
                      {v.changelog.length > 12 ? v.changelog.slice(0, 12) + "…" : v.changelog}
                    </text>
                  );
                })}
              </svg>
              {/* 图例 */}
              <div style={{ marginTop: 12, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                  {shapes.map(s => {
                    const val = latest?.byShape[s]?.strict_pct ?? 0;
                    const firstVal = first?.byShape[s]?.strict_pct ?? 0;
                    const d = val - firstVal;
                    const count = history?.byShape?.[s] ?? 0;
                    return (
                      <span key={s} style={{ fontSize: TYPE.micro, color: COLOR.textSecondary, display: "inline-flex", alignItems: "center", gap: 5 }}>
                        <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: SHAPE_COLORS[s] }} />
                        {SHAPE_LABELS[s]} <b style={{ color: COLOR.textPrimary, fontVariantNumeric: "tabular-nums" }}>{val}%</b>
                        {count > 0 && <span style={{ fontSize: 10 }}>({count}条)</span>}
                        {d > 0 && <Tag color="green" style={{ fontSize: 10, borderRadius: 4 }}>+{d.toFixed(1)}%</Tag>}
                      </span>
                    );
                  })}
                </div>
                <Typography.Text type="secondary" style={{ fontSize: TYPE.micro }}>完全正确率 · 横轴为引擎版本</Typography.Text>
              </div>
            </>
          );
        })()}
      </InfoBox>

      {/* ── 5. 实时校准 ── */}
      <SectionTitle hint="实时跑一遍全部用例。" color={COLOR.relaxed}>实时校准</SectionTitle>
      <InfoBox style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
        <div style={{ flex: "1 1 300px" }}>
          {calib.status === "idle" && !calib.report && (
            <Typography.Text type="secondary" style={{ fontSize: TYPE.body }}>还没校准过。点「实时校准」跑一遍全部 {totalCases} 条用例。</Typography.Text>
          )}
          {calib.status === "running" && (
            <Typography.Text type="secondary" style={{ fontSize: TYPE.body }}>正在校准中（对 {totalCases} 条用例逐条打分）…</Typography.Text>
          )}
          {calib.status === "done" && calib.report && (
            <div style={{ display: "flex", gap: 28, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontSize: 26, fontWeight: 600, color: COLOR.strict, fontVariantNumeric: "tabular-nums", lineHeight: 1.15 }}>{calib.report.strict_pct}%</div>
                <Typography.Text type="secondary" style={{ fontSize: TYPE.micro }}>完全正确率</Typography.Text>
              </div>
              <div>
                <div style={{ fontSize: 26, fontWeight: 600, color: COLOR.relaxed, fontVariantNumeric: "tabular-nums", lineHeight: 1.15 }}>{calib.report.relaxed_pct}%</div>
                <Typography.Text type="secondary" style={{ fontSize: TYPE.micro }}>部分得分率</Typography.Text>
              </div>
              <div>
                <div style={{ fontSize: 26, fontWeight: 600, color: COLOR.textPrimary, fontVariantNumeric: "tabular-nums", lineHeight: 1.15 }}>{calib.report.total}</div>
                <Typography.Text type="secondary" style={{ fontSize: TYPE.micro }}>用例数</Typography.Text>
              </div>
              {calib.report.by_shape && (
                <Typography.Text type="secondary" style={{ fontSize: TYPE.small, alignSelf: "center" }}>
                  单意图 {calib.report.by_shape.single_intent?.strict_pct ?? "-"}% / 复合句 {calib.report.by_shape.multi_intent?.strict_pct ?? "-"}% / 模糊提问 {calib.report.by_shape.ambiguous_intent?.strict_pct ?? "-"}%
                </Typography.Text>
              )}
            </div>
          )}
          {calib.status === "error" && <Typography.Text type="danger" style={{ fontSize: TYPE.body }}>校准超时或失败（请确认引擎已部署到容器）</Typography.Text>}
        </div>
        <Button
          icon={<ExperimentOutlined />}
          loading={busy || calib.status === "running"}
          onClick={runCalibrate}
          style={{ borderRadius: 8 }}
          type="primary"
        >
          {calib.report ? "重新校准" : "实时校准"}
        </Button>
      </InfoBox>

      {/* ── 7. 高级数据 ── */}
      <SectionTitle hint="校准逐题明细，日常不需要展开。" color={COLOR.textSecondary}>高级数据</SectionTitle>
      <Collapse
        ghost
        style={{ background: "#fff", borderRadius: 12, border: `1px solid ${COLOR.border}`, padding: "0 20px" }}
        items={[{
          key: "calib-detail",
          label: "校准逐题明细（每条用例的预测结果）",
          forceRender: true,
          children: (
            <div>
              {calib.status === "running" && <Typography.Text type="secondary" style={{ fontSize: TYPE.body }}>正在校准中…</Typography.Text>}
              {(!calib.report || calib.report.results.length === 0) && calib.status !== "running" && (
                <Typography.Text type="secondary" style={{ fontSize: TYPE.body }}>还没有校准结果。点上方「实时校准」跑一遍。</Typography.Text>
              )}
              {calib.report && calib.report.results.length > 0 && (
                <div style={{ background: COLOR.bg, borderRadius: 8, padding: "8px 12px" }}>
                  {calib.report.results.map(r => (
                    <div key={r.case_id} style={{
                      padding: "5px 0",
                      borderBottom: `1px dashed ${COLOR.gridDash}`,
                      fontSize: TYPE.small,
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                    }}>
                      <Tag color={r.strict ? "green" : "red"} style={{ fontSize: 10, borderRadius: 4, minWidth: 32, textAlign: "center" }}>
                        {r.strict ? "正确" : "错误"}
                      </Tag>
                      <Typography.Text style={{ fontSize: TYPE.small, flex: 1 }}>{r.query}</Typography.Text>
                      <Typography.Text type="secondary" style={{ fontSize: TYPE.micro }}>
                        → {r.predicted?.join(", ") || "（无）"}
                      </Typography.Text>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ),
        }]}
      />
    </>
  );

  // 与可进化任务同一套 Tabs 骨架（标签名也对齐：运行与 DAG / 数据评测），
  // 只读任务没有候选比较/成果/设置三项——内容裁剪但骨架一致（10-17 用户反馈）
  return (
    <div>
      <Tabs
        activeKey={view}
        onChange={(k: string) => setView(k as typeof view)}
        items={[
          { key: "overview", label: "概览与下一步", children: overviewBody },
          { key: "runs", label: "运行与 DAG", children: runsBody },
          { key: "data", label: "数据评测", children: dataBody },
        ]}
      />
    </div>
  );
}
