/**
 * 自动进化运行轨迹：真正的 DAG——分支节点 + parent→child 有向边。
 * 按代际(layer)分层布局，champion 路径蓝色加粗，淘汰分支灰色，
 * 采纳节点高亮，每代顶部标注轮次摘要。
 */
import { Card, Tag, Typography, Collapse } from "antd";
import type { EvolveRun, EvolveRound, EvolutionBranch } from "./rsiShared";
import { COLOR, TYPE, RULE, SHADOW } from "./rsiDesign";

const RESULT_META: Record<string, { color: string; label: string }> = {
  decision_error:{color:'red',label:'模型计划无效'},
  probe_only:{color:'default',label:'仅训练探针'},
  search_updated:{color:'blue',label:'搜索策略更新'},
  no_evaluations:{color:'default',label:'无新增全量测量'},
  improved: { color: "green", label: "有提升" },
  improved_strict: { color: "green", label: "精度提升" },
  improved_relaxed: { color: "green", label: "部分得分提升" },
  improved_tradeoff: { color: "gold", label: "有提升·有权衡" },
  no_improve: { color: "orange", label: "无提升" },
  no_pass: { color: "red", label: "门禁全拦" },
  no_adopt: { color: "orange", label: "无采纳" },
  converged_novelty: { color: "default", label: "AI 无新方案" },
  awaiting_human: { color: "gold", label: "等你拍板" },
  propose_fail: { color: "red", label: "提案失败" },
  no_mutations: { color: "orange", label: "零产出" },
  stopped: { color: "orange", label: "已停止" },
};

const NW = 130, NH = 58, GAP_X = 72, GAP_Y = 10, PAD_X = 20, PAD_Y = 38;

const opName = (s: string) => ({
  root: '基线', engine: '识别参数', recognition_prompt: '识别指令',
  optimizer_prompt: '变异方法', graph: '图谱优化', bundle: '组合优化',
  combined: '融合互补', crossover: '融合互补',
}[s] || s);

/** 构建分支 DAG 的节点和边 */
function buildDag(run: EvolveRun) {
  const branches = run.branches || {};
  const byId = new Map<string, EvolutionBranch>();
  Object.values(branches).forEach(b => byId.set(b.id, b));
  // candidates 里的 branch 对象也收进来
  run.rounds.forEach(r => (r.candidates || []).forEach(c => {
    if (typeof c !== 'string' && !byId.has(c.id)) byId.set(c.id, c);
  }));

  const championSet = new Set<string>();
  run.rounds.forEach(r => { if (r.champion) championSet.add(r.champion); if (r.roundChampion) championSet.add(r.roundChampion); });
  const adoptedId = run.adoptedBranch || run.champion || run.rounds.at(-1)?.champion || run.rounds.at(-1)?.roundChampion;

  // 按 gen 分层
  const layers = new Map<number, EvolutionBranch[]>();
  byId.forEach(b => {
    const g = b.gen ?? (b.parent ? (byId.get(b.parent)?.gen ?? 0) + 1 : 0);
    if (!layers.has(g)) layers.set(g, []);
    layers.get(g)!.push(b);
  });
  // 每层排序：champion 在前，然后按 score 降序，root 最前
  layers.forEach(arr => arr.sort((a, b) => {
    if (!a.parent && b.parent) return -1;
    if (a.parent && !b.parent) return 1;
    const ca = championSet.has(a.id) ? 1 : 0, cb = championSet.has(b.id) ? 1 : 0;
    if (ca !== cb) return cb - ca;
    const sa = a.scores?.heldoutStrict ?? a.scores?.allStrict ?? -1;
    const sb = b.scores?.heldoutStrict ?? b.scores?.allStrict ?? -1;
    return sb - sa;
  }));

  // 布局：每层一列，节点竖排
  const pos = new Map<string, { x: number; y: number }>();
  const gens = [...layers.keys()].sort((a, b) => a - b);
  let maxNodes = 0;
  gens.forEach(g => {
    const arr = layers.get(g)!;
    maxNodes = Math.max(maxNodes, arr.length);
    arr.forEach((b, i) => pos.set(b.id, { x: g * (NW + GAP_X) + PAD_X, y: i * (NH + GAP_Y) + PAD_Y }));
  });

  // 边：parent → child
  type Edge = { from: string; to: string; champion: boolean };
  const edges: Edge[] = [];
  byId.forEach(b => {
    const parents = b.parents?.length ? b.parents : [b.parent].filter((x): x is string => !!x);
    parents.forEach(p => {
      if (byId.has(p)) edges.push({ from: p, to: b.id, champion: championSet.has(b.id) && championSet.has(p) });
    });
  });

  const numGens = gens.length;
  const w = PAD_X * 2 + numGens * NW + (numGens - 1) * GAP_X;
  const h = PAD_Y + maxNodes * (NH + GAP_Y);

  return { pos, edges, byId, layers, gens, championSet, adoptedId, w, h };
}

function RunDag({ run }: { run: EvolveRun }) {
  const { pos, edges, byId, layers, gens, championSet, adoptedId, w, h } = buildDag(run);
  if (!byId.size) return <Typography.Text type="secondary" style={{ fontSize: TYPE.micro }}>本轮无分支记录</Typography.Text>;

  const isDead = (b: EvolutionBranch) => ['gated', 'pruned', 'eval_error', 'duplicate', 'budget_skipped', 'probe_rejected'].includes(b.status);
  const scoreStr = (b: EvolutionBranch) => {
    const s = b.scores?.heldoutStrict ?? b.scores?.allStrict ?? b.fullScores?.heldout?.strict_pct;
    return s != null ? `${s}%` : '—';
  };

  return (
    <div style={{ overflowX: "auto", padding: "4px 0" }}>
      <svg viewBox={`0 0 ${w} ${h}`} style={{ minWidth: w, width: "100%", height: h }}>
        <defs>
          <marker id="dag-arrow-blue" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto">
            <path d="M0 0L10 5L0 10z" fill={COLOR.accent} />
          </marker>
          <marker id="dag-arrow-grey" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="4" markerHeight="4" orient="auto">
            <path d="M0 0L10 5L0 10z" fill="#b0b8c0" />
          </marker>
        </defs>

        {/* 代际标注 */}
        {gens.map(g => {
          const round = run.rounds.find(r => (r.gen ?? r.round) === g);
          const m = round ? RESULT_META[round.result] : null;
          return (
            <g key={`gen-${g}`} transform={`translate(${g * (NW + GAP_X) + PAD_X}, 0)`}>
              <text x={NW / 2} y={14} textAnchor="middle" fontSize={TYPE.small} fontWeight={700} fill={COLOR.textPrimary}>
                G{g}
              </text>
              {round && <text x={NW / 2} y={28} textAnchor="middle" fontSize={10} fill={m?.color === 'green' ? COLOR.good : m?.color === 'red' ? COLOR.bad : m?.color === 'orange' ? COLOR.warning : COLOR.textTertiary}>
                {m ? m.label : round.result}
              </text>}
            </g>
          );
        })}

        {/* 边 */}
        {edges.map((e, i) => {
          const a = pos.get(e.from), b = pos.get(e.to);
          if (!a || !b) return null;
          const x1 = a.x + NW, y1 = a.y + NH / 2, x2 = b.x, y2 = b.y + NH / 2;
          const mx = (x1 + x2) / 2;
          const path = `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
          return <path key={i} d={path} fill="none"
            stroke={e.champion ? COLOR.accent : "#c0c8d0"}
            strokeWidth={e.champion ? 2.5 : 1.2}
            opacity={e.champion ? 1 : 0.5}
            markerEnd={e.champion ? "url(#dag-arrow-blue)" : "url(#dag-arrow-grey)"}
          />;
        })}

        {/* 节点 */}
        {gens.map(g => (layers.get(g) || []).map(b => {
          const p = pos.get(b.id)!;
          const dead = isDead(b);
          const isChamp = championSet.has(b.id);
          const isRoot = !b.parent;
          const isAdopted = b.id === adoptedId || !!b.adoptedAs;
          const stroke = isAdopted ? COLOR.accent : isChamp ? COLOR.accent : dead ? "#d0d4d8" : RULE;
          const fill = isAdopted ? "rgba(42,120,214,0.08)" : isRoot ? "#f0f5fc" : dead ? "#fafafa" : "#fff";
          return (
            <g key={b.id} transform={`translate(${p.x},${p.y})`}>
              <rect width={NW} height={NH} rx={7} fill={fill} stroke={stroke} strokeWidth={isChamp || isAdopted ? 1.5 : 1}
                strokeDasharray={dead ? "3 2" : undefined} />
              {/* 分支 ID + 状态标签 */}
              <text x={8} y={16} fontSize={10} fontWeight={700} fill={isChamp || isAdopted ? COLOR.accent : COLOR.textPrimary} style={{ fontVariantNumeric: "tabular-nums" }}>
                {b.id}{isRoot ? ' · 基线' : ''}
              </text>
              {b.adoptedAs && (
                <text x={NW - 8} y={16} textAnchor="end" fontSize={9} fontWeight={600} fill={COLOR.accent}>
                  → {b.adoptedAs}
                </text>
              )}
              {/* 操作类型 */}
              <text x={8} y={31} fontSize={9} fill={COLOR.textSecondary}>
                {opName(b.op)} · {b.status === 'alive' ? '存活' : b.status === 'gated' ? '门禁淘汰' : b.status === 'pruned' ? '筛选淘汰' : b.status === 'probe_rejected' ? '探针否决' : b.status === 'eval_error' ? '评测失败' : b.status === 'duplicate' ? '重复' : b.status}
              </text>
              {/* 成绩 */}
              <text x={8} y={48} fontSize={14} fontWeight={700} fill={isChamp && !dead ? COLOR.accent : COLOR.textPrimary} style={{ fontVariantNumeric: "tabular-nums" }}>
                {scoreStr(b)}
              </text>
              {/* 淘汰叉号 */}
              {dead && <path d={`M${NW - 20},${16} l8,8 m-8,0 l8,-8`} stroke="#b0b8c0" strokeWidth={1.2} />}
            </g>
          );
        }))}
      </svg>
    </div>
  );
}

export function RsiEvolveRuns(props: { runs?: EvolveRun[] }) {
  const { runs } = props;
  if (!runs || runs.length === 0) return null;

  return (
    <Card size="small" style={{ marginBottom: 16 }}>
      <div style={{ marginBottom: 10, display: "flex", gap: 16, flexWrap: "wrap" }}>
        <span style={{ fontSize: TYPE.micro, color: COLOR.textTertiary }}>
          <span style={{ display: "inline-block", width: 12, height: 2, background: COLOR.accent, verticalAlign: "middle", marginRight: 4 }} />champion 路径
        </span>
        <span style={{ fontSize: TYPE.micro, color: COLOR.textTertiary }}>
          <span style={{ display: "inline-block", width: 12, height: 1, background: "#c0c8d0", verticalAlign: "middle", marginRight: 4, borderTop: "1px dashed #c0c8d0" }} />淘汰分支
        </span>
        <span style={{ fontSize: TYPE.micro, color: COLOR.textTertiary }}>
          <span style={{ display: "inline-block", width: 10, height: 10, background: "rgba(42,120,214,0.08)", border: `1px solid ${COLOR.accent}`, borderRadius: 3, verticalAlign: "middle", marginRight: 4 }} />采纳节点
        </span>
      </div>
      <Collapse
        ghost
        defaultActiveKey={[runs.length - 1]}
        items={runs.map((run, idx) => ({
          key: idx,
          label: (
            <span>
              <Typography.Text strong style={{ fontSize: TYPE.small }}>自动进化 #{idx + 1}</Typography.Text>
              <Tag style={{ marginLeft: 8, borderRadius: 4 }} color={run.status === "done" ? "green" : run.status === "stopped" || run.status === "awaiting_human" ? "orange" : "red"}>
                {run.status === "done" ? "完成" : run.status === "stopped" ? "已停止" : run.status === "awaiting_human" ? "等你拍板" : run.status === "no_adopt" ? "无采纳收场" : run.status}
              </Tag>
              <Typography.Text type="secondary" style={{ fontSize: TYPE.micro, marginLeft: 8 }}>
                {run.at.replace("T", " ").slice(0, 19)} · 采纳 {run.totalAdopted} 个 · 最终版本 {run.finalVersion} · 策略 {run.adoptStrategy}
              </Typography.Text>
            </span>
          ),
          children: <RunDag run={run} />,
        }))}
      />
    </Card>
  );
}
