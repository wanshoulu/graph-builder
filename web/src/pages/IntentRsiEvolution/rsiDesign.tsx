/**
 * RSI 进化实验台设计系统（克制编辑部风「墨 · 线 · 蓝」）。
 *
 * 纪律
 *  · 墨色承文字、系列色只承数据、状态色只表状态；全页一种强调色（蓝）。
 *  · 分区靠发丝线（rule）而不是卡片边框；层级靠字号、字重与留白，不靠更多色块。
 *  · 数字一律 tabular-nums（等宽），避免读数跳动、列对不齐。
 *
 * 系列色：蓝 #2a78d6（完全正确率）/ 橙 #eb6834（部分得分率），已过 CVD 校验。
 * 语义色：变好 #006300 / 变坏 #d03b3b / 提示 #b45309 —— 绿红只表状态，不当系列色用。
 */
import { Typography } from "antd";
import type React from "react";

// ── 色彩令牌（键名兼容旧代码，值收敛到纪律集）──
export const COLOR = {
  // 系列/强调：blue=第一系列+全局唯一强调；orange=第二系列
  strict: "#2a78d6",
  relaxed: "#eb6834",
  accent: "#2a78d6",
  // 语义文字色
  good: "#006300",
  bad: "#d03b3b",
  warning: "#b45309",
  danger: "#d03b3b",
  // 状态底：仅异常态/提示态卡片用；正常态一律中性
  strictBg: "#fafaf9",
  relaxedBg: "#fafaf9",
  accentBg: "#fafaf9",
  warningBg: "#fdf6ec",
  dangerBg: "#fdf1f0",
  // 中性面/墨
  bg: "#f9f9f7",
  border: "rgba(11,11,11,0.10)",
  textPrimary: "#0b0b0b",
  textSecondary: "#52514e",
  textTertiary: "#898781",
  chartBg: "#fbfcfe",
  gridLine: "#e8eaed",
  gridDash: "#e8eaed",
  axisLabel: "#898781",
  // 蓝色层次梯度（从深到浅 8 级——参考图的层次感核心：面积填充/渐变/柱状图分色）
  blueScale: ["#1a5fbf", "#2a78d6", "#4a8ee8", "#6ba3e3", "#8fb8ec", "#a8c9ee", "#c5dbf5", "#e8f1fb"],
  // 面板底色微蓝（比纯灰更优雅，参考图3浅蓝紫面板的克制版）
  panelTint: "#fbfcfe",
} as const;

/** 渐变定义（增加层次感而非花哨：顶条/进度条/面积图/卡片背景） */
export const GRADIENT = {
  accent: "linear-gradient(135deg, #2a78d6 0%, #4a8ee8 100%)",
  accentH: "linear-gradient(90deg, #2a78d6 0%, #5a9ae8 100%)",
  heroBg: "linear-gradient(180deg, #f7fafe 0%, #ffffff 60%)",
  panelBg: "linear-gradient(180deg, #fbfcfe 0%, #ffffff 40%)",
  areaFill: "linear-gradient(180deg, rgba(42,120,214,0.12) 0%, rgba(42,120,214,0.02) 100%)",
} as const;

/** 发丝分隔线（比 border 更浅，专用于分区与栏内分隔） */
export const RULE = "rgba(11,11,11,0.085)";

// ── 字号阶梯（取代散落的魔法数字，全页统一节奏）──
export const TYPE = {
  /** 首屏锚点大数字 */
  hero: 30,
  /** 指标卡大数字 */
  metric: 26,
  /** 并排小指标 */
  metricSm: 20,
  /** 分区标题 */
  section: 15,
  /** 正文 */
  body: 13.5,
  /** 次要正文 */
  small: 12.5,
  /** 标签 / 导语 / 元信息 */
  micro: 11.5,
} as const;

// ── 阴影系统（保持极轻，编辑部风不靠重投影分层）──
export const SHADOW = {
  card: "0 1px 3px rgba(11,11,11,0.05), 0 1px 2px rgba(11,11,11,0.03)",
  cardHover: "0 8px 24px rgba(11,11,11,0.08), 0 2px 6px rgba(11,11,11,0.04)",
  panel: "0 2px 8px rgba(11,11,11,0.06), 0 1px 3px rgba(11,11,11,0.04)",
  metricCard: "0 1px 3px rgba(11,11,11,0.04), 0 1px 2px rgba(11,11,11,0.02)",
  heroCard: "0 4px 16px rgba(42,120,214,0.07), 0 1px 3px rgba(11,11,11,0.04)",
} as const;

// ── 间距系统（8px 网格）──
export const SPACE = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
} as const;

// ── 发丝分隔：栏内/卡片内分隔的通用件 ──
export function Hairline({ style }: { style?: React.CSSProperties }) {
  return <div style={{ height: 1, background: RULE, ...style }} />;
}

/**
 * 分区标题（编辑部栏目感）：小竖条 + 标题 + 右侧贯通细线，导语另起一行小字。
 * 导语从"挤在标题右边"改为"标题下方"，长句不再折断标题行。
 */
export function SectionTitle({ children, hint, color }: {
  children: React.ReactNode;
  hint?: string;
  color?: string;
}) {
  return (
    <div style={{ marginTop: 36, marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{
          width: 3, height: 15, borderRadius: 2,
          background: color || GRADIENT.accent, flexShrink: 0,
        }} />
        <Typography.Text strong style={{ fontSize: TYPE.section, color: COLOR.textPrimary, whiteSpace: "nowrap" }}>
          {children}
        </Typography.Text>
        <div style={{ flex: 1, height: 1, background: RULE, minWidth: 24 }} />
      </div>
      {hint && (
        <Typography.Text style={{
          display: "block", marginTop: 7, marginLeft: 13,
          fontSize: TYPE.micro, color: COLOR.textTertiary, lineHeight: 1.65,
        }}>
          {hint}
        </Typography.Text>
      )}
    </div>
  );
}

/**
 * 统计瓦片：中性白底 + 发丝边，墨色大数字（文字永不穿系列色）。
 * emphasis：
 *  · hero    —— 首屏锚点用，超大数字、顶部强调条、更宽容的留白
 *  · default —— 常规指标
 *  · compact —— 并排小指标（榜单/对照列）
 * color 仅用于图标与强调条，不染文字。
 */
export function MetricCard({ title, value, suffix, sub, color, bgColor, icon, precision, accent, emphasis = "default", extra }: {
  title: string;
  value: number | string;
  suffix?: string;
  sub?: string;
  color?: string;
  bgColor?: string;
  icon?: React.ReactNode;
  precision?: number;
  accent?: boolean;
  emphasis?: "hero" | "default" | "compact";
  /** 卡底部追加的操作区（如按钮）——卡片是受控展示件，操作仍由外层注入 */
  extra?: React.ReactNode;
}) {
  const displayValue = typeof value === "number" && precision !== undefined
    ? value.toFixed(precision) : value;

  const spec = {
    hero: { pad: "20px 24px", num: TYPE.hero, gap: 8, minW: 190 },
    default: { pad: "15px 18px", num: TYPE.metric, gap: 6, minW: 150 },
    compact: { pad: "12px 14px", num: TYPE.metricSm, gap: 5, minW: 120 },
  }[emphasis];

  const isHero = emphasis === "hero";
  return (
    <div style={{
      background: isHero ? GRADIENT.heroBg : "#fff",
      borderRadius: 12,
      padding: spec.pad,
      border: `1px solid ${COLOR.border}`,
      boxShadow: isHero ? SHADOW.heroCard : SHADOW.metricCard,
      minWidth: spec.minW,
      flex: `1 1 ${spec.minW}px`,
      position: "relative",
      overflow: "hidden",
      transition: "box-shadow 0.25s ease",
    }}>
      {accent && (
        <div style={{
          position: "absolute", top: 0, left: 0, right: 0,
          height: isHero ? 3 : 2,
          background: GRADIENT.accent,
        }} />
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: spec.gap }}>
        {icon && <span style={{ color: color || COLOR.textTertiary, fontSize: 13, display: "inline-flex" }}>{icon}</span>}
        <Typography.Text style={{ fontSize: TYPE.micro, color: COLOR.textSecondary, fontWeight: 500 }}>{title}</Typography.Text>
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 3 }}>
        <span style={{
          fontSize: spec.num, fontWeight: 600, color: COLOR.textPrimary,
          lineHeight: 1.12, fontVariantNumeric: "tabular-nums", letterSpacing: "-0.01em",
        }}>{displayValue}</span>
        {suffix && <span style={{ fontSize: TYPE.small, color: COLOR.textSecondary, fontWeight: 500 }}>{suffix}</span>}
      </div>
      {sub && (
        <Typography.Text style={{
          fontSize: TYPE.micro, color: COLOR.textTertiary, display: "block",
          marginTop: 5, lineHeight: 1.55,
        }}>
          {sub}
        </Typography.Text>
      )}
      {extra && <div style={{ marginTop: 10 }}>{extra}</div>}
    </div>
  );
}

// ── 进度条：实色，轨道用中性浅灰 ──
export function ProgressBar({ value, max = 100, color, height = 6 }: {
  value: number;
  max?: number;
  color?: string;
  height?: number;
}) {
  const pct = Math.min(100, (value / max) * 100);
  const c = color || COLOR.accent;
  const useGradient = !color;
  return (
    <div style={{ width: "100%", height, background: "#edeef0", borderRadius: height / 2, overflow: "hidden" }}>
      <div style={{
        width: `${pct}%`,
        height: "100%",
        background: useGradient ? GRADIENT.accentH : c,
        borderRadius: height / 2,
        transition: "width 0.6s ease",
        boxShadow: useGradient ? "0 0 8px rgba(42,120,214,0.25)" : undefined,
      }} />
    </div>
  );
}

// ── 信息条（代替裸 Card，统一圆角和边框）──
export function InfoBox({ children, style }: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div style={{
      background: GRADIENT.panelBg,
      borderRadius: 12,
      padding: "18px 22px",
      marginBottom: 4,
      border: `1px solid ${COLOR.border}`,
      boxShadow: SHADOW.card,
      ...style,
    }}>
      {children}
    </div>
  );
}

// ── SVG 图表工具函数 ──
export function niceDomain(values: number[]): [number, number] {
  const lo = Math.max(0, Math.floor(Math.min(...values) - 5));
  const hi = Math.min(100, Math.ceil(Math.max(...values) + 5));
  return lo === hi ? [lo, Math.min(100, lo + 5)] : [lo, hi];
}

// 通用 SVG 图表尺寸
export const CHART_DIM = { W: 680, H: 320, PAD: { l: 48, r: 90, t: 24, b: 56 } };
