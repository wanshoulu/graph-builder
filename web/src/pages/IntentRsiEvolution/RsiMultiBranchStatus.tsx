/**
 * 多分支种群进化实时状态面板（第四版：一条流水线 + 活的数字）。
 * 设计参考：GitHub Actions 运行页（阶段状态行 / 点线依赖图 / 日志流）
 * 与 "system is alive" 规则——实时数字与新事件 cross-fade 淡入，绝无布局跳动。
 * 纪律：墨色承文字、系列色只染数据、状态色只表状态；单容器，发丝线分区，无图例堆砌。
 * 无障碍：尊重 prefers-reduced-motion（关闭脉冲与淡入）。
 */
import { Typography } from "antd";
import type React from "react";
import type { BranchInfo } from "./rsiShared";
import { humanize } from "./rsiShared";
import { COLOR, InfoBox, ProgressBar, TYPE } from "./rsiDesign";

export interface MultiBranchEvolveStep {
  step: string;
  round: number;
  detail: string;
  [k: string]: unknown;
}

interface Props {
  steps: MultiBranchEvolveStep[];
  branches: BranchInfo[] | null;
  population: string[] | null;
  champion: string | null;
  running: boolean;
  maxRounds: number;
}

// ── 动画：脉冲（活动阶段）+ 淡入（数字/新事件） ──
const CSS = `
@keyframes rsi-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.72)}}
@keyframes rsi-fade{from{opacity:.15}to{opacity:1}}
.rsi-fade{animation:rsi-fade .45s ease}
@media (prefers-reduced-motion: reduce){
  .rsi-fade{animation:none}
  .rsi-pulse-el{animation:none !important}
}
`;

// ── 进化阶段流水线 ──
const PHASES = [
  { key: "mutate", label: "变异" },
  { key: "evaluate", label: "评测" },
  { key: "select", label: "选择" },
  { key: "crossover", label: "交叉" },
] as const;

function derivePhase(steps: MultiBranchEvolveStep[]): string {
  const last = steps[steps.length - 1];
  if (!last) return "idle";
  if (last.step === "complete" || last.step === "done") return "complete";
  if (last.step === "converged") return "converged";
  for (const k of ["mutate", "evaluate", "select", "crossover"]) {
    if (last.step.startsWith(k)) return k;
  }
  return "idle";
}

// ── 活数字：值变化时整段淡入（key 变化触发重挂载），宽度用 tabular-nums 保持稳定 ──
function LiveNum({ text, color }: { text: string; color?: string }) {
  return (
    <span key={text} className="rsi-fade" style={{
      fontSize: 19, fontWeight: 600, lineHeight: 1.2,
      fontVariantNumeric: "tabular-nums",
      color: color || COLOR.textPrimary,
    }}>{text}</span>
  );
}

// ── 阶段流水线行：完成=绿✓，活动=蓝脉冲点，未到=空心点；发丝线连接 ──
function PhasePipeline({ current, running, finished }: {
  current: string;
  running: boolean;
  finished: boolean;
}) {
  const idx = PHASES.findIndex(p => p.key === current);
  return (
    <div style={{ display: "flex", alignItems: "center" }}>
      {PHASES.map((p, i) => {
        const isDone = finished || (idx >= 0 && i < idx);
        const isActive = !finished && i === idx;
        return (
          <div key={p.key} style={{ display: "flex", alignItems: "center", flex: i < PHASES.length - 1 ? 1 : "none", minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
              {isDone ? (
                <span style={{
                  width: 13, height: 13, borderRadius: "50%",
                  background: COLOR.good, color: "#fff", fontSize: 9,
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  boxShadow: "0 1px 4px rgba(0,99,0,0.2)",
                }} aria-hidden="true">✓</span>
              ) : isActive ? (
                <span style={{ position: "relative", display: "inline-flex", alignItems: "center", justifyContent: "center", width: 16, height: 16 }}>
                  {running && (
                    <span style={{
                      position: "absolute", width: 14, height: 14, borderRadius: "50%",
                      background: COLOR.accent, opacity: 0.12,
                    }} aria-hidden="true" />
                  )}
                  <span className={running ? "rsi-pulse-el" : undefined} style={{
                    width: 8, height: 8, borderRadius: "50%", background: COLOR.accent,
                    animation: running ? "rsi-pulse 1s ease-in-out infinite" : undefined,
                    display: "inline-block", boxShadow: "0 0 6px rgba(42,120,214,0.35)",
                  }} aria-hidden="true" />
                </span>
              ) : (
                <span style={{
                  width: 8, height: 8, borderRadius: "50%", boxSizing: "border-box",
                  border: `1.5px solid ${COLOR.gridLine}`, display: "inline-block",
                }} aria-hidden="true" />
              )}
              <span style={{
                fontSize: TYPE.small,
                fontWeight: isActive ? 600 : 400,
                color: isActive ? COLOR.accent : isDone ? COLOR.textSecondary : COLOR.textTertiary,
              }}>{p.label}</span>
            </div>
            {i < PHASES.length - 1 && (
              <div style={{
                flex: 1, height: 1, minWidth: 12, margin: "0 10px",
                background: isDone ? "linear-gradient(90deg, #c5dbf5, #e8f1fb)" : COLOR.border,
              }} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── 点线分支树：小圆点 + 连线；冠军路径蓝色加粗；细节走 hover ──
const DOT_R = 4.5;
const DEPTH_GAP = 84;
const SIB_GAP = 28;
const T_PAD = 8;
const ID_GAP = 12; // 点右侧到 id 文字的距离

function layoutDots(branches: BranchInfo[]) {
  const byParent = new Map<string | null, BranchInfo[]>();
  for (const b of branches) {
    const p = b.parent ?? null;
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p)!.push(b);
  }
  const pos = new Map<string, { x: number; y: number }>();
  let nextY = T_PAD;
  const place = (b: BranchInfo, depth: number) => {
    if (pos.has(b.id)) return;
    const children = byParent.get(b.id) || [];
    if (children.length === 0) {
      pos.set(b.id, { x: depth * DEPTH_GAP + T_PAD, y: nextY });
      nextY += SIB_GAP;
      return;
    }
    for (const c of children) place(c, depth + 1);
    const a = pos.get(children[0].id)!;
    const z = pos.get(children[children.length - 1].id)!;
    pos.set(b.id, { x: depth * DEPTH_GAP + T_PAD, y: (a.y + z.y) / 2 });
  };
  for (const r of byParent.get(null) || []) place(r, 0);
  for (const b of branches) {
    if (!pos.has(b.id)) {
      pos.set(b.id, { x: (b.depth || 0) * DEPTH_GAP + T_PAD, y: nextY });
      nextY += SIB_GAP;
    }
  }
  return pos;
}

function championPath(branches: BranchInfo[], champion: string | null): Set<string> {
  const byId = new Map(branches.map(b => [b.id, b]));
  const path = new Set<string>();
  let cur = champion ? byId.get(champion) : undefined;
  let guard = 0;
  while (cur && guard++ < 64) {
    path.add(cur.id);
    cur = cur.parent ? byId.get(cur.parent) : undefined;
  }
  return path;
}

function BranchTree({ branches, population, champion }: {
  branches: BranchInfo[];
  population: string[] | null;
  champion: string | null;
}) {
  const pos = layoutDots(branches);
  const path = championPath(branches, champion);
  const popSet = new Set(population || []);
  const byParent = new Map<string | null, BranchInfo[]>();
  for (const b of branches) {
    const p = b.parent ?? null;
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p)!.push(b);
  }
  const maxDepth = Math.max(...branches.map(b => b.depth || 0));
  const width = maxDepth * DEPTH_GAP + T_PAD + ID_GAP + 96;
  const height = branches.length * SIB_GAP + T_PAD * 2 - SIB_GAP + DOT_R * 2;

  const dotTitle = (b: BranchInfo) => {
    const t = b.scores?.train?.strict_pct;
    const h = b.scores?.heldout?.strict_pct;
    const parts = [
      `${b.id}${b.op === "root" ? "（根/基线）" : " · " + (b.opLabel || b.op)}`,
      t !== undefined ? `练习题 ${t.toFixed(1)}%` : null,
      h !== undefined ? `隐藏考 ${h.toFixed(1)}%` : null,
      b.status === "gated" ? `已淘汰：${b.gateReason || "门禁未过"}` : "存活",
    ].filter(Boolean);
    return parts.join(" · ");
  };

  return (
    <div style={{ maxHeight: 240, overflow: "auto" }}>
      <svg width={Math.max(width, 320)} height={height} style={{ display: "block" }}>
        <defs>
          <radialGradient id="champNodeGrad" cx="35%" cy="35%">
            <stop offset="0%" stopColor="#5a9ae8" />
            <stop offset="100%" stopColor="#1a5fbf" />
          </radialGradient>
          <linearGradient id="champPathGrad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#2a78d6" stopOpacity="0.5" />
            <stop offset="100%" stopColor="#4a8ee8" stopOpacity="0.85" />
          </linearGradient>
          <filter id="nodeShadow" x="-50%" y="-50%" width="200%" height="200%">
            <feDropShadow dx="0" dy="1" stdDeviation="1.5" floodColor="rgba(11,11,11,0.12)" />
          </filter>
        </defs>
        {/* 连线：冠军路径 accent 加粗，其余发丝灰 */}
        {branches.flatMap(c => [...new Set(c.parents?.length ? c.parents : [c.parent, c.crossedWith].filter((id): id is string => !!id))].map(parent => {
          const b = branches.find(b => b.id === parent);
          if (!b) return null;
          const p = pos.get(b.id)!;
          const q = pos.get(c.id)!;
          const onPath = path.has(c.id) && path.has(b.id);
          return (
            <path key={`l-${b.id}-${c.id}`}
              d={`M ${p.x + DOT_R} ${p.y} L ${q.x - DOT_R} ${q.y}`}
              fill="none"
              stroke={onPath ? "url(#champPathGrad)" : COLOR.gridLine}
              strokeWidth={onPath ? 2 : 1}
            />
          );
        }))}
        {/* 节点：存活=墨色实心，淘汰=空心灰，冠军=蓝点+外圈，旧引擎口径=橙色虚线圈 */}
        {branches.map(b => {
          const q = pos.get(b.id)!;
          const isChamp = b.id === champion;
          const dead = b.status === "gated";
          const inPop = popSet.has(b.id);
          return (
            <g key={b.id}>
              <circle cx={q.x} cy={q.y} r={DOT_R + 5} fill="transparent">
                <title>{dotTitle(b)}</title>
              </circle>
              {isChamp && (
                <>
                  <circle cx={q.x} cy={q.y} r={DOT_R + 6} fill="none" stroke={COLOR.accent} strokeWidth={0.5} opacity={0.2} />
                  <circle cx={q.x} cy={q.y} r={DOT_R + 4} fill="none" stroke={COLOR.accent} strokeWidth={1} opacity={0.5} />
                </>
              )}
              {b.staleEngine && (
                <circle cx={q.x} cy={q.y} r={DOT_R + 2.5} fill="none" stroke="#e08a00" strokeWidth={1.2} strokeDasharray="3 2" />
              )}
              {dead ? (
                <circle cx={q.x} cy={q.y} r={DOT_R} fill="#fff" stroke={COLOR.gridLine} strokeWidth={1.5} />
              ) : (
                <circle cx={q.x} cy={q.y} r={isChamp ? DOT_R + 1.5 : DOT_R}
                  fill={isChamp ? "url(#champNodeGrad)" : inPop ? COLOR.blueScale[2] : COLOR.textTertiary}
                  filter="url(#nodeShadow)"
                />
              )}
              <text x={q.x + ID_GAP} y={q.y + 3.5}
                fontSize={10.5}
                fontWeight={isChamp ? 700 : 400}
                fill={isChamp ? COLOR.accent : dead ? COLOR.textTertiary : COLOR.textSecondary}>
                {b.id}{isChamp ? " 冠军" : ""}{b.staleEngine ? " ⧗旧引擎" : ""}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ── 指标块 ──
function StatBlock({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <span style={{ fontSize: TYPE.micro, color: COLOR.textTertiary }}>{label}</span>
      {children}
    </div>
  );
}

const Hairline = () => <div style={{ height: 1, background: "linear-gradient(90deg, transparent, rgba(42,120,214,0.12), transparent)", margin: "14px 0" }} />;

export function RsiMultiBranchStatus({ steps, branches, population, champion, running, maxRounds }: Props) {
  const lastGen = [...steps].reverse().find(s => s.round > 0);
  const all = branches || [];
  // 代数兜底：SSE 事件流只在发起页累积，刷新/新开页面后 steps 为空——此时从分支数据
  // 推导当前代数，避免运行中显示「第 0 代」（10-19 用户实测反馈）
  const branchGen = all.length ? Math.max(0, ...all.map(b => Number(b.gen) || 0)) : 0;
  const currentGen = lastGen?.round || branchGen;
  const phase = derivePhase(steps);
  const finished = phase === "complete" || phase === "converged";

  // 存活分支以种群为准（10-14 审计：旧口径把 pruned/已固化也算"存活"）
  const alive = population ? population.length : all.filter(b => b.status === "alive").length;
  const champ = champion ? all.find(b => b.id === champion) : null;
  const root = all.find(b => !b.parent);
  const champHeld = champ?.scores?.heldout?.strict_pct;
  const rootHeld = root?.scores?.heldout?.strict_pct;
  const hasDelta = champHeld !== undefined && rootHeld !== undefined && champion !== "b0" && champion !== null;
  const delta = hasDelta ? champHeld! - rootHeld! : null;

  const recent = steps.slice(-30);
  const recentOffset = steps.length - recent.length;

  return (
    <div>
      <style>{CSS}</style>
      <InfoBox>
        {/* ── 阶段流水线 ── */}
        <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 14 }}>
          <span style={{ fontSize: TYPE.body, fontWeight: 600, color: COLOR.textPrimary, flexShrink: 0 }}>
            第 <span key={currentGen} className="rsi-fade" style={{ fontVariantNumeric: "tabular-nums" }}>{currentGen}</span> / {maxRounds} 代
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <PhasePipeline current={phase} running={running} finished={finished} />
          </div>
        </div>

        {/* ── 大进度条（完成后转绿） ── */}
        <ProgressBar value={finished ? maxRounds : currentGen} max={maxRounds} height={12} color={finished ? COLOR.good : COLOR.accent} />

        {/* ── 活数字：存活分支 / 冠军成绩 / 较根提升 ── */}
        <div style={{ display: "flex", alignItems: "flex-end", gap: 40, marginTop: 14 }}>
          <StatBlock label="存活分支">
            <LiveNum text={`${alive}`} />
          </StatBlock>
          <StatBlock label="冠军（隐藏考）">
            <LiveNum text={champHeld !== undefined ? `${champHeld.toFixed(1)}%` : "—"} color={COLOR.relaxed} />
          </StatBlock>
          <StatBlock label="较根提升">
            <LiveNum
              text={delta === null ? "—" : `${delta > 0 ? "+" : ""}${delta.toFixed(1)} pp`}
              color={delta === null ? COLOR.textTertiary : delta > 0 ? COLOR.good : delta < 0 ? COLOR.bad : COLOR.textSecondary}
            />
          </StatBlock>
          <div style={{ flex: 1 }} />
          {phase === "converged" && (
            <Typography.Text style={{ fontSize: TYPE.small, color: COLOR.warning, paddingBottom: 2 }}>已收敛：连续多代无提升</Typography.Text>
          )}
          {phase === "complete" && (
            <Typography.Text style={{ fontSize: TYPE.small, color: COLOR.good, paddingBottom: 2 }}>进化完成</Typography.Text>
          )}
        </div>

        <Hairline />

        {/* ── 点线分支树 ── */}
        <div style={{ fontSize: TYPE.micro, color: COLOR.textTertiary, marginBottom: 6 }}>分支树（悬停查看成绩）</div>
        {all.length > 0 ? (
          <BranchTree branches={all} population={population} champion={champion} />
        ) : (
          <div style={{ fontSize: TYPE.small, color: COLOR.textTertiary, padding: "12px 0" }}>等待分支数据…</div>
        )}

        <Hairline />

        {/* ── 事件流：最新在上，新条目淡入 ── */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <span style={{ fontSize: TYPE.micro, color: COLOR.textTertiary }}>事件流</span>
          {running && !finished && (
            <span className="rsi-pulse-el" style={{
              width: 6, height: 6, borderRadius: "50%", background: COLOR.accent,
              animation: "rsi-pulse 1s ease-in-out infinite", display: "inline-block",
            }} aria-hidden="true" />
          )}
        </div>
        <div style={{ maxHeight: 180, overflowY: "auto" }}>
          {[...recent].reverse().map((s, i) => {
            const gIdx = recentOffset + (recent.length - 1 - i); // 全局稳定索引：旧行不重播动画
            return (
              <div key={gIdx} className="rsi-fade" style={{
                display: "flex", gap: 10, padding: "4px 0",
                fontSize: TYPE.small, lineHeight: 1.55,
              }}>
                <span style={{
                  width: 26, flexShrink: 0, fontSize: 10.5,
                  fontVariantNumeric: "tabular-nums", color: COLOR.textTertiary,
                }}>{s.round > 0 ? `G${s.round}` : "—"}</span>
                <span style={{ color: COLOR.textSecondary }}>{humanize(s.detail)}</span>
              </div>
            );
          })}
          {recent.length === 0 && (
            <div style={{ fontSize: TYPE.small, color: COLOR.textTertiary, padding: "8px 0" }}>尚未产生事件</div>
          )}
        </div>
      </InfoBox>
    </div>
  );
}
