import { useEffect, useRef, useState } from 'react';
import { Alert, Empty, Select, Segmented, Table, Tag } from 'antd';
import { humanize } from './rsiShared';
import { COLOR } from './rsiDesign';
import type { RsiState, ShapeScores, RsiScores, AssetLineage } from './rsiShared';
import { buildEvolutionViews, normalizeEvolutionRun, generationDelta, missingReading, type GenPoint, type EvolutionTrial, type Scope } from './rsiEvolutionModel';
import './rsiEvolution.css';
import { layoutEvolutionDag } from './rsiDagLayout';
import { businessContextName, runDisplayLabel } from './rsiAssetNaming';

const SHAPES = [
  { key: 'single_intent', name: '单意图', color: '#2a78d6' },
  { key: 'multi_intent', name: '复合句', color: '#e07b39' },
  { key: 'ambiguous_intent', name: '模糊提问', color: '#7957a8' },
  { key: 'negative_intent', name: '反例', color: '#397b71' },
  { key: 'multi_task_same_intent', name: '多轮任务', color: '#5f6775' },
] as const;
const RESULT: Record<string, string> = { baseline: '实验输入', improved: '已收敛 · 有指标改善', no_improve: '已收敛 · 未观察到净改善',
  no_mutations: '零产出', no_evaluations: '没有成功评测', propose_fail: '变异失败', running: '进行中', stopped: '已停止', no_pass: '全部未通过',
  version: '已固化', retest: '同版本重测', awaiting_human: '待人工采纳' };
const pct = (v?: number | null) => v == null ? '未评测' : `${v.toFixed(1)}%`;
const pp = (v: number | null) => v == null ? '不可比 / 未评测' : `${v > 0 ? '+' : ''}${v.toFixed(1)} pp`;
const value = (g: GenPoint, scope: Scope) => g.g === 0 ? g.inputScore[scope] : g.championScore?.[scope] ?? null;
const shape = (scores: RsiScores | null, scope: Scope, key: string): ShapeScores | undefined =>
  (scores?.[scope] as unknown as Record<string, ShapeScores> | undefined)?.[key];
const dead = (t: EvolutionTrial) => ['gated', 'pruned', 'eval_error', 'duplicate', 'budget_skipped'].includes(t.status);
const status = (t: EvolutionTrial, champion: string | null) => t.status === 'duplicate' ? '重复资产 · 未重评' : t.status === 'budget_skipped' ? '预算不足 · 未评测' : t.status === 'eval_error' ? '评测失败' : t.status === 'gated' ? '门禁淘汰'
  : t.status === 'pruned' ? '筛选淘汰' : t.id === champion ? '收敛胜出' : t.score.all == null && t.score.heldout == null ? '待评测' : '候选';
// 全量谱系节点总数：正式版本 + 未被运行分支承接的档案提案 + 运行分支（非根）+ 资产谱系快照
const lineageRuns = (state: RsiState) => {
  const runs = [...(state.evolveRuns || [])];
  if (state.activeEvolution) {
    const index = state.activeEvolution.id ? runs.findIndex(r => r.id === state.activeEvolution!.id) : -1;
    if (index >= 0) runs[index] = state.activeEvolution; else runs.push(state.activeEvolution);
  }
  return runs.map(normalizeEvolutionRun);
};
const nodesTotal = (points: GenPoint[], state: RsiState, lineage: AssetLineage | null) => {
  const archiveNotRun = (state.archive || []).filter(p => !lineageRuns(state).some(r => Object.values(r.branches || {}).some(b => b.proposalId === p.id))).length;
  const runBranches = lineageRuns(state).reduce((n, r) => n + Object.values(r.branches || {}).filter(b => b.parent).length, 0);
  // 资产树里除根之外、且未被 archive/版本承接的快照数（已承接的不重复建节点）
  const bound = new Set<string>((state.archive || []).map(a => (a.candidateHash || '').slice(0, 8)).filter(Boolean));
  const extraAssets = (lineage?.assets || []).filter(a => a.parents.length > 0 && !bound.has(a.short)).length;
  return state.versions.length + archiveNotRun + runBranches + extraAssets;
};

// ── 全量谱系 DAG（10-15 用户反馈：不要每代一张分开的图，要单张图展示 v1→v2→… 的迭代演进，
//    每个代际的变异分支像思维导图一样从基线扇出、收敛固化后进入下一代）──
// 节点两类：正式版本（主轴）+ 变异候选（archive 提案 / evolveRuns 分支）。
// 边两类：变异来源（灰，指向候选）+ 采纳固化（蓝，候选 → 新版本）。
// 层号 = 最长父链：版本固定在偶数层，候选插在基线版本与固化版本之间。
type LNode = {
  id: string; kind: 'version' | 'variant'; layer: number;
  title: string; sub: string | null; pill: string;
  score: { all: number | null; heldout: number | null } | null;
  rejected: boolean; winner: boolean; gen: number | null; tip: string; sortKey: string;
  metricLabel?: string; gain?: string; reason?: string;
};

const mutationName = (s: string) => humanize(s)
  .replace(/hintWeight/g, '区分线索权重').replace(/clauseWeight/g, '子句匹配权重')
  .replace(/graphClusterFirst/g, '优先按图谱聚合候选').replace(/shape(?:Prompt|提示词)/g, '句式识别指令')
  .replace(/judge(?:Prompt|提示词|提示)/g, '裁决指令').replace(/scope_in/g, '适用范围')
  .replace(/clarificationLimit/g, '澄清选项上限').replace(/\btrue\b/g, '开启').replace(/\bfalse\b/g, '关闭')
  .replace(/clarification/g, '澄清判断');
const pathName = (s?: string) => ({ engine: '识别参数优化', recognition_prompt: '识别指令优化', optimizer_prompt: '变异方法优化',
  graph: '图谱优化', bundle: '组合优化', combined: '融合互补改动', crossover: '融合互补改动' }[s || ''] || mutationName(s || '图谱优化'));
const localGain = (before?: number | null, after?: number | null) => before != null && after != null ? `相对父代训练 ${pp(after - before)}` : '父代成绩缺失，暂不可比';
type LEdge = { from: string; to: string; kind: 'base' | 'adopt' };

function LineageGraph({ state, points, scope, selectedGen, onSelect, lineage, runId }:
  { state: RsiState; points: GenPoint[]; scope: Scope; selectedGen: number; onSelect: (g: number) => void; lineage: AssetLineage | null; runId?: string }) {
  const NODE_W = 280;
  const [zoom, setZoom] = useState(1);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  // 代际联动锚点：版本名 → GenPoint.g（明细表按代过滤）
  const genOf = new Map<string, number>();
  points.forEach(p => {
    if (!genOf.has(p.inputLabel)) genOf.set(p.inputLabel, p.g);
    if (p.championLabel) genOf.set(p.championLabel, p.g);
    if (p.fixedVersion) genOf.set(p.fixedVersion, p.g);
  });
  const versionReading = (v: string) => {
    const hs = (state.scoreHistory || []).filter(h => h.version === v);
    return hs.length ? hs[hs.length - 1] : null;
  };
  const nodes: LNode[] = []; const rawEdges: LEdge[] = [];
  const layerOf = new Map<string, number>();
  const runsAll = lineageRuns(state);
  const selectedRun = runsAll.find((r, i) => (r.id || `legacy-${i}`) === runId);
  // 未选中具体实验（如落在正式版本视图）时展开全部实验分支——全量 DAG 要能看到变异迭代关系
  const displayedRuns = selectedRun ? [selectedRun] : runsAll;
  const runBase = selectedRun?.baseVersion || points[0]?.inputLabel;
  // 1) 正式版本主轴：v1, v2, … 固定在 0, 2, 4… 层
  state.versions.forEach((v, i) => {
    if (selectedRun && v.version !== runBase && !(selectedRun.totalAdopted > 0 && v.version === selectedRun.finalVersion)) return;
    const id = `ver:${v.version}`; layerOf.set(id, i * 2);
    const h = selectedRun && v.version === runBase ? { scores: points[0]?.inputScores } : versionReading(v.version);
    nodes.push({ id, kind: 'version', layer: i * 2, title: v.version,
      sub: mutationName(v.changelog || '') || null,
      pill: v.version === state.currentVersion ? '当前版本' : '正式版本',
      score: h?.scores ? { all: h.scores.all?.strict_pct ?? null, heldout: h.scores.heldout?.strict_pct ?? null } : null,
      rejected: false, winner: v.version === state.currentVersion, gen: genOf.get(v.version) ?? null,
      tip: `${v.version} · ${v.changelog || '正式版本'}`, sortKey: `0-${i}` });
  });
  // 2) 变异候选：archive 提案（跳过已被运行分支承接的，避免重复节点）
  const runProposalIds = new Set<string>();
  displayedRuns.forEach(r => Object.values(r.branches || {}).forEach(b => { if (b.proposalId) runProposalIds.add(b.proposalId); }));
  const firstVersion = state.versions[0]?.version || 'v1';
  [...(state.archive || [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).forEach(p => {
    if (selectedRun ? (p as any).runId !== runId : p.status !== 'adopted') return;
    if (runProposalIds.has(p.id)) return;
    const base = p.candidateBaseVersion || p.baselineAtEval?.version;
    const id = `prop:${p.id}`;
    const pill = p.status === 'adopted' ? `已采纳 → ${p.adoptedAs || '?'}`
      : p.status === 'rejected' ? '已否决'
      : p.status === 'gated' ? '门禁淘汰'
      : p.status === 'passed' ? (p.engineCheck?.ok ? '已过四关' : '已过三关 · 待引擎复核')
      : '验证中 / 待评测';
    nodes.push({ id, kind: 'variant', layer: -1, title: pathName(p.opLabel || p.proposal.type),
      sub: p.proposal.motivation ? mutationName(p.proposal.motivation) : '改动说明未保存', pill,
      metricLabel: '训练完全正确率', gain: localGain(p.baselineAtEval?.train?.strict_pct, p.trainScores?.strict_pct),
      reason: `${!base ? '父代未记录，不推断来源；' : ''}${p.status === 'adopted' ? `采纳结果：已固化为 ${p.adoptedAs || '正式版本'}` : p.gate?.reason ? `${p.status === 'gated' || p.status === 'rejected' ? '淘汰原因' : '筛选依据'}：${mutationName(p.gate.reason)}` : '尚无筛选结论'}`,
      score: { all: p.trainScores?.strict_pct ?? null, heldout: p.heldoutScores?.strict_pct ?? null },
      rejected: p.status === 'gated' || p.status === 'rejected', winner: p.status === 'adopted',
      gen: points.find(point => point.trials.some(t => t.proposalId === p.id || t.id === p.id))?.g ?? null,
      tip: `${p.id} · ${pill}${p.gate?.reason ? ` · 历史门禁记录（非当前流程状态）：${p.gate.reason}` : ''}`, sortKey: `1-${p.createdAt}` });
    if (layerOf.has(`ver:${base}`)) rawEdges.push({ from: `ver:${base}`, to: id, kind: 'base' });
    if (p.adoptedAs && layerOf.has(`ver:${p.adoptedAs}`)) rawEdges.push({ from: id, to: `ver:${p.adoptedAs}`, kind: 'adopt' });
  });
  // 3) 变异候选：进化运行的分支树（多代链 via parent 边）
  displayedRuns.forEach(run => {
    const branchRunId = run.id || `legacy-${runsAll.indexOf(run)}`;
    const branchesById = { ...(run.branches || {}) };
    run.rounds.forEach(r => r.candidates?.forEach(b => { if (typeof b !== 'string' && !branchesById[b.id]) branchesById[b.id] = b; }));
    const branches = Object.values(branchesById);
    const byId = new Map(branches.map(b => [b.id, b]));
    const baseVersion = run.baseVersion || branches.find(b => !b.parent)?.baseVersion || run.finalVersion || firstVersion;
    const championIds = new Set(run.rounds.map(r => r.champion ?? r.roundChampion).filter((x): x is string => !!x));
    const promoted = run.adoptedBranch || run.champion || run.rounds.at(-1)?.champion || run.rounds.at(-1)?.roundChampion;
    const adoptedSet = new Set((run.totalAdopted > 0 && run.finalVersion && run.finalVersion !== baseVersion && promoted) ? [promoted] : []);
    branches.sort((a, b) => (a.gen ?? 99) - (b.gen ?? 99) || (a.createdAt || '').localeCompare(b.createdAt || '')).forEach(b => {
      if (!b.parent) return; // 根分支 = 基线复制，由版本节点承担
      const id = `br:${branchRunId}/${b.id}`;
      const parents = b.parents?.length ? b.parents : [b.parent, b.crossedWith].filter((x): x is string => !!x);
      const actualAdoption = b.adoptedAs || state.archive?.find(p => p.id === b.proposalId && p.status === 'adopted')?.adoptedAs;
      const pill = actualAdoption ? `已采纳 → ${actualAdoption}` : adoptedSet.has(b.id) ? `已采纳 → ${run.finalVersion}`
        : championIds.has(b.id) ? '收敛胜出'
        : b.status === 'search_only' ? '仅更新搜索策略' : b.status === 'diagnostic_complete' ? '诊断探针完成' : b.status === 'probe_rejected' ? '探针无收益' : b.status === 'duplicate' ? '重复资产 · 未重评' : b.status === 'evaluating' ? '评测中' : b.status === 'budget_skipped' ? '预算不足 · 未评测' : b.status === 'gated' ? '门禁淘汰' : b.status === 'pruned' ? '筛选淘汰' : b.status === 'eval_error' ? '评测失败' : run.population?.includes(b.id) ? '保留路径' : '候选';
      const parentScores = byId.get(b.parent)?.scores;
      nodes.push({ id, kind: 'variant', layer: -1, title: `G${b.gen ?? '?'} · ${b.id} · ${pathName(b.target || b.opLabel || b.op)}`,
        sub: mutationName(b.summary || b.opLabel || b.op), pill,
        metricLabel: '全体完全正确率',
        gain: localGain(parentScores?.trainStrict ?? run.rounds.find(r => r.branchIds?.includes(b.id))?.inputScores?.train?.strict_pct, b.scores?.trainStrict),
        reason: b.gateReason ? `${['gated', 'pruned', 'eval_error'].includes(b.status) ? '淘汰原因' : '筛选依据'}：${mutationName(b.gateReason)}` : championIds.has(b.id) ? '本代胜出，作为后续变异输入' : '筛选原因未保存',
        score: { all: b.scores?.allStrict ?? null, heldout: b.scores?.heldoutStrict ?? null },
        rejected: ['gated', 'pruned', 'eval_error'].includes(b.status), winner: adoptedSet.has(b.id) || championIds.has(b.id),
        gen: branchRunId === runId ? b.gen ?? genOf.get(b.id) ?? null : null,
        tip: `${branchRunId} / ${b.id} · ${pill}${b.crossedWith ? ` · 融合 ${b.parent} + ${b.crossedWith}` : ''}${b.artifactHash ? ` · 资产 ${b.artifactHash.slice(0, 12)}` : ''}${b.gateReason ? ` · ${b.gateReason}` : ''}`, sortKey: `1-${b.createdAt || b.id}` });
      parents.forEach(pid => {
        const pb = byId.get(pid);
        const from = pb ? (pb.parent ? `br:${branchRunId}/${pid}` : `ver:${pb.baseVersion || baseVersion}`) : `ver:${pid}`;
        if (layerOf.has(from) || from.startsWith('br:')) rawEdges.push({ from, to: id, kind: 'base' });
      });
      if (adoptedSet.has(b.id) && run.finalVersion && layerOf.has(`ver:${run.finalVersion}`)) rawEdges.push({ from: id, to: `ver:${run.finalVersion}`, kind: 'adopt' });
      if (actualAdoption && layerOf.has(`ver:${actualAdoption}`) && !rawEdges.some(e => e.from === id && e.to === `ver:${actualAdoption}`)) rawEdges.push({ from: id, to: `ver:${actualAdoption}`, kind: 'adopt' });
    });
  });
  // Unbound snapshots live in a separate ledger. Unknown parents are never guessed.
  // 4) 层号定型：候选取最长父链；版本若被跨越则顺延（防同层自环）
  // Only use recorded relations, including explicit formal-version parents.
  state.versions.forEach(v => {
    if (v.parentVersion && !rawEdges.some(e => e.to === `ver:${v.version}` && e.kind === 'adopt'))
      rawEdges.push({ from: `ver:${v.parentVersion}`, to: `ver:${v.version}`, kind: 'adopt' });
  });
  const ids = new Set(nodes.map(n => n.id));
  const edges = rawEdges.filter((e, i) => ids.has(e.from) && ids.has(e.to) && rawEdges.findIndex(o => o.from === e.from && o.to === e.to) === i);
  const layout = layoutEvolutionDag(nodes, edges);
  // Start with the actual lineage in view. Refit only when the run, geometry,
  // or viewport changes, so polling never overrides a user's manual zoom.
  useEffect(() => {
    const el = scrollRef.current;
    if (!layout || !el) return;
    const measure = () => {
      if (!el.clientWidth || !el.clientHeight) return;
      setZoom(Math.max(0.01, Math.min(1, (el.clientWidth - 24) / layout.width, (el.clientHeight - 24) / layout.height)));
      el.scrollTo(0, 0);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [runId, layout?.width, layout?.height, expanded]);
  if (!layout) return <Alert type="error" message="谱系记录中存在循环关系，无法显示为 DAG" description="请检查父节点记录；原始记录保留在下方台账。" />;
  const { pos, width: W, height: H } = layout;
  const ancestry = new Set<string>();
  const visit = (id: string) => { if (ancestry.has(id)) return; ancestry.add(id); edges.filter(e => e.to === id).forEach(e => visit(e.from)); };
  if (detailId) visit(detailId);
  const fit = () => { const el = scrollRef.current; if (el) { setZoom(Math.max(0.01, Math.min(1, (el.clientWidth - 24) / W, (el.clientHeight - 24) / H))); el.scrollTo(0, 0); } };
  const focusChampion = () => { const n = [...nodes].reverse().find(n => n.winner && n.kind === 'variant') || nodes.find(n => n.winner); if (!n) return;
    setDetailId(n.id); const p = pos.get(n.id)!; scrollRef.current?.scrollTo({ left: (p.x + 140) * zoom - (scrollRef.current.clientWidth / 2), top: p.y * zoom - 200, behavior: 'smooth' }); };
  const curve = (x1: number, y1: number, x2: number, y2: number) => `M${x1},${y1} C${x1 + 56},${y1} ${x2 - 56},${y2} ${x2},${y2}`;
  // 代际标尺（几十代际导航）：有正式版本的层（偶数层=代际主轴锚点）在顶部标 G 代号，
  // 横向滚动数十列时用户仍能对齐"哪一列是哪一代"
  const genAnchors = [...new Set(nodes.map(n => pos.get(n.id)!.x))].map(x => {
    const column = nodes.filter(n => pos.get(n.id)!.x === x), version = column.find(n => n.kind === 'version');
    return { x: x + NODE_W / 2, label: version?.title || `G${[...new Set(column.map(n => n.title.match(/^G(\d+)/)?.[1]).filter(Boolean))].join(' / G') || '?'}` };
  });
  return <div className={`rsi-dag-wrap ${expanded ? 'is-expanded' : ''}`}>
    {/* 缩放控件：几十代际时缩到 50-65% 一屏看全树，再看局部放大 */}
    <div className="rsi-dag-zoom" role="group" aria-label="谱系图缩放">
      <span>缩放 {Math.round(zoom * 100)}%</span>
      {[0.5, 0.65, 0.8, 1].map(z => <button key={z} className={zoom === z ? 'is-on' : ''} onClick={() => setZoom(z)} aria-pressed={zoom === z}>{Math.round(z * 100)}%</button>)}
      <button onClick={fit}>适应画布</button><button onClick={focusChampion}>定位胜出分支</button>
      <button onClick={() => setExpanded(!expanded)} aria-pressed={expanded}>{expanded ? '退出展开' : '展开画布'}</button>
      <span className="rsi-dag-count">{nodes.length} 个节点 · {edges.length} 条关系 · 拖动画布平移</span>
    </div>
    <div ref={scrollRef} className="rsi-dag-scroll" tabIndex={0} aria-label="变异与收敛全量谱系图，可上下左右滚动"
      onPointerDown={e => { if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return; const el = e.currentTarget;
        dragRef.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop }; el.setPointerCapture(e.pointerId); }}
      onPointerMove={e => { const d = dragRef.current; if (d) { e.currentTarget.scrollLeft = d.left - e.clientX + d.x; e.currentTarget.scrollTop = d.top - e.clientY + d.y; } }}
      onPointerUp={() => { dragRef.current = null; }} onPointerCancel={() => { dragRef.current = null; }}>
      <div className="rsi-dag" style={{ width: W * zoom, height: H * zoom }}>
        <div style={{ width: W, height: H, transform: `scale(${zoom})`, transformOrigin: 'top left' }}>
    <svg width={W} height={H} aria-hidden="true" className="rsi-dag-edges">
      <defs><marker id="rsi-lineage-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#8c9bab" /></marker>
        <marker id="rsi-lineage-arrow-blue" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill={COLOR.accent} /></marker></defs>
        {genAnchors.map((g, i) => <g key={`ruler-${i}`}>
          <rect x={g.x - 26} y={4} width="52" height="22" rx="11" fill="#eef3f9" />
          <text x={g.x} y={19} textAnchor="middle" fontSize="12" fontWeight="700" fill="#3d5a80">{g.label}</text>
        </g>)}
        {edges.map((e, i) => { const a = pos.get(e.from), b = pos.get(e.to); if (!a || !b) return null;
          const adopt = e.kind === 'adopt', traced = !!detailId && ancestry.has(e.from) && ancestry.has(e.to);
          return <g key={i}>
            <path data-from={e.from} data-to={e.to} d={curve(a.x + NODE_W, a.y, b.x, b.y)} fill="none" stroke={adopt || traced ? COLOR.accent : '#8c9bab'}
              opacity={detailId && !traced ? 0.22 : 1} strokeWidth={adopt || traced ? 2.5 : 1.5} markerEnd={adopt || traced ? 'url(#rsi-lineage-arrow-blue)' : 'url(#rsi-lineage-arrow)'} />
            {adopt && <text x={(a.x + NODE_W + b.x) / 2} y={(a.y + b.y) / 2 - 7} textAnchor="middle" fontSize="10" fill={COLOR.accent}>固化</text>}
          </g>;
        })}
      </svg>
      {nodes.map(n => { const p = pos.get(n.id)!; const active = n.gen != null && n.gen === selectedGen;
        return <button key={n.id} onClick={() => { setDetailId(n.id); if (n.gen != null) onSelect(n.gen); }}
          className={`rsi-dag-node ${n.kind === 'version' ? 'rsi-dag-input' : 'rsi-dag-trial'} ${n.rejected ? 'is-rejected' : ''} ${n.winner ? 'is-winner' : ''} ${detailId === n.id ? 'is-focused' : ''}`}
          style={{ left: p.x, top: p.y - 76, width: NODE_W, height: 152, opacity: detailId && !ancestry.has(n.id) ? 0.45 : 1, ...(active && !detailId ? { outline: '2px solid #73a1d7', outlineOffset: 2 } : {}) }}
          title={n.tip} data-node-id={n.id} data-generation={n.gen ?? undefined}>
          <span className="rsi-node-top"><b>{n.title}</b><span>{n.pill}</span></span>
          {n.sub && <span className="rsi-node-summary">{n.sub}</span>}
          {n.score && <span className="rsi-node-detail">{n.metricLabel || '全体完全正确率'} {pct(n.score.all)} · 验证 {pct(n.score.heldout)}</span>}
          {n.gain && <span className="rsi-node-detail">{n.gain}</span>}
          {n.reason && <span className="rsi-node-reason">{n.reason}</span>}
        </button>;
      })}
        </div>
      </div>
    </div>
    {detailId && (() => { const n = nodes.find(n => n.id === detailId); return n ? <div className="rsi-lineage-detail" role="region" aria-label="选中节点完整说明">
      <button className="rsi-detail-close" onClick={() => setDetailId(null)}>关闭详情</button><b>{n.title} · {n.pill}</b>
      <p>来源：{edges.filter(e => e.to === n.id).map(e => nodes.find(p => p.id === e.from)?.title).join(' + ') || '未记录父代'}</p>
      <p>{n.sub}</p>{n.score && <p>{n.metricLabel || '全体完全正确率'} {pct(n.score.all)}；验证完全正确率 {pct(n.score.heldout)}</p>}{n.gain && <p>{n.gain}</p>}<p>{n.reason || '正式版本；成绩以当前评测口径为准'}</p><small>{mutationName(n.tip)}</small>
    </div> : null; })()}
  </div>;
}

function AccuracyChart({ points, scope, selectedGen, onSelect, formal = false }: { points: GenPoint[]; scope: Scope; selectedGen: number; onSelect: (g: number) => void; formal?: boolean }) {
  const w = Math.max(760, points.length * 110), h = 270, pad = { l: 58, r: 40, t: 32, b: 58 };
  const readings = points.flatMap(g => [value(g, scope), ...g.trials.map(t => t.score[scope])]).filter((n): n is number => n != null);
  const lo = Math.max(0, Math.floor((Math.min(...readings, 100) - 4) / 5) * 5);
  const hi = Math.min(100, Math.max(lo + 10, Math.ceil((Math.max(...readings, 0) + 4) / 5) * 5));
  const min = readings.length ? lo : 0, max = readings.length ? hi : 100;
  const x = (i: number) => pad.l + (i + 0.5) * (w - pad.l - pad.r) / points.length;
  const y = (v: number) => pad.t + (max - v) * (h - pad.t - pad.b) / Math.max(1, max - min);
  return <div className="rsi-chart-scroll" tabIndex={0} aria-label="逐代精度趋势，可横向滚动">
    <svg viewBox={`0 0 ${w} ${h}`} style={{ minWidth: w, width: '100%', height: h }} role="img" aria-label={formal ? '正式版本最新实测，不代表实验代际' : '收敛精度折线与每代候选散点；详细读数见下方台账'}>
      {[0, 1, 2, 3, 4].map(i => { const v = min + (max - min) * i / 4; return <g key={i}>
        <line x1={pad.l} y1={y(v)} x2={w - pad.r} y2={y(v)} stroke="#e6ebf1" /><text x={pad.l - 10} y={y(v) + 4} textAnchor="end" fontSize="12" fill="#596879">{v.toFixed(v % 1 ? 1 : 0)}%</text>
      </g>; })}
      {points.map((p, i) => {
        const v = value(p, scope), prior = points[i - 1], priorV = prior && value(prior, scope);
        return <g key={p.g} onClick={() => onSelect(p.g)}>
          {p.g === selectedGen && <rect x={x(i) - 37} y={pad.t - 12} width="74" height={h - pad.t - pad.b + 24} rx="6" fill="#2a78d6" opacity=".055" />}
          {/* 10-15 用户反馈：G0→G1→…→Gn 要形成完整趋势线；引擎口径变化段用虚线连接并标注，不再断线 */}
          {i > 0 && p.comparable && v != null && priorV != null && <line x1={x(i - 1)} y1={y(priorV)} x2={x(i)} y2={y(v)} stroke={COLOR.accent} strokeWidth="2.5" />}
          {i > 0 && !p.comparable && v != null && priorV != null && (<>
            <line x1={x(i - 1)} y1={y(priorV)} x2={x(i)} y2={y(v)} stroke="#a8b3c0" strokeWidth="1.5" strokeDasharray="4 3" />
            <text x={(x(i - 1) + x(i)) / 2} y={Math.min(y(priorV), y(v)) - 10}
              textAnchor="middle" fontSize="10" fill="#8c9bab">引擎口径变更</text>
          </>)}
          {p.trials.map((t, ti) => { const tv = t.score[scope]; if (tv == null) return null;
            const tx = x(i) + (ti - (p.trials.length - 1) / 2) * Math.min(14, 50 / Math.max(1, p.trials.length));
            return <g key={t.id}><circle cx={tx} cy={y(tv)} r="5" fill="#fff" stroke={dead(t) ? '#8c96a3' : '#e07b39'} strokeWidth="1.6" />
              {dead(t) && <path d={`M${tx - 3},${y(tv) - 3}l6,6m-6,0l6,-6`} stroke="#8c96a3" />}<title>{`${t.id} · ${pct(tv)} · ${status(t, p.championLabel)}${t.gateReason ? ` · ${t.gateReason}` : ''}`}</title></g>;
          })}
          {v != null ? <g><circle cx={x(i)} cy={y(v)} r="5" fill={COLOR.accent} stroke="#fff" strokeWidth="2" /><text x={x(i)} y={y(v) - 14} textAnchor="middle" fontSize="13" fontWeight="700" fill={COLOR.accent}>{v.toFixed(1)}%</text></g>
            : <text x={x(i)} y={pad.t + 35} textAnchor="middle" fontSize="11" fill="#6b7785">{missingReading(p, formal)}</text>}
          <text x={x(i)} y={h - 30} textAnchor="middle" fontSize="13" fontWeight="600" fill="#263445">{formal ? p.inputLabel : `G${p.g}`}</text>
          <text x={x(i)} y={h - 12} textAnchor="middle" fontSize="11" fill="#596879">{formal ? p.measurementCount ? `${p.measurementCount}次实测 · 最近一次` : '无实测记录' : p.g === 0 ? p.inputLabel : pp(generationDelta(p, scope))}</text>
          <rect x={x(i) - 38} y={h - pad.b} width="76" height={pad.b} fill="transparent" tabIndex={0} role="button" aria-label={`选择 ${formal ? p.inputLabel : `G${p.g}`}，${pct(v)}`} onClick={() => onSelect(p.g)}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(p.g); } }} className="rsi-chart-hit"><title>{`${formal ? p.inputLabel : `G${p.g}`} ${RESULT[p.result] || p.result} · ${pct(v)} · ${p.note || ''}${p.measurementAt ? ` · ${p.measurementAt}` : ''}`}</title></rect>
        </g>;
      })}
    </svg>
  </div>;
}

function ShapeChart({ points, scope, selectedGen, onSelect, formal = false }: { points: GenPoint[]; scope: Scope; selectedGen: number; onSelect: (g: number) => void; formal?: boolean }) {
  const keys = SHAPES.filter(k => points.some(p => shape(p.scores, scope, k.key)));
  if (!keys.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该实验没有保存逐代题型明细；不能用最新版本成绩代替历史成绩。新运行将自动记录。" />;
  const w = Math.max(720, points.length * 140), h = 235, left = 48, bottom = 193;
  const groupW = (w - left - 24) / points.length, bw = Math.min(22, (groupW - 22) / keys.length);
  return <><div className="rsi-chart-scroll" tabIndex={0} aria-label="逐代题型正确率柱状图，可横向滚动">
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', minWidth: w, height: h }} role="img" aria-label={formal ? '正式版本最新实测的各题型正确率' : '每代收敛结果的各题型正确率'}>
      {[0, 25, 50, 75, 100].map(v => <g key={v}><line x1={left} y1={bottom - v * 1.65} x2={w - 24} y2={bottom - v * 1.65} stroke="#e6ebf1" /><text x={left - 9} y={bottom - v * 1.65 + 4} textAnchor="end" fontSize="11" fill="#596879">{v}%</text></g>)}
      {points.map((p, i) => { const cx = left + (i + 0.5) * groupW; return <g key={p.g} onClick={() => onSelect(p.g)}>
        {p.g === selectedGen && <rect x={cx - groupW / 2 + 5} y="17" width={groupW - 10} height="187" fill="#2a78d6" opacity=".055" rx="6" />}
        {keys.map((k, ki) => { const s = shape(p.scores, scope, k.key); if (!s || s.total === 0) return null; const bx = cx - keys.length * bw / 2 + ki * bw;
          const barTop = bottom - Math.max(2, s.strict_pct * 1.65);
          return <g key={k.key}>
            <rect x={bx + 2} y={barTop} width={bw - 4} height={Math.max(2, s.strict_pct * 1.65)} rx="2" fill={k.color}><title>{`${formal ? p.inputLabel : `G${p.g}`} ${k.name} ${s.strict_pct.toFixed(1)}% · n=${s.total}`}</title></rect>
            {/* 10-15 用户反馈：柱顶数据标签；只显整数省宽，小数与题数在 hover 提示中 */}
            <text x={bx + bw / 2} y={barTop - 4} textAnchor="middle" fontSize="10" fontWeight="600" fill={k.color}>{s.strict_pct.toFixed(0)}</text>
          </g>;
        })}
        {!p.scores && <text x={cx} y="92" textAnchor="middle" fontSize="11" fill="#6b7785">{missingReading(p, formal)}</text>}
        <text x={cx} y="222" textAnchor="middle" fontSize="12" fill="#263445">{formal ? p.inputLabel : `G${p.g}`}</text>
        <rect x={cx - groupW / 2} y="202" width={groupW} height="30" fill="transparent" tabIndex={0} role="button" aria-label={`选择第 ${p.g} 代题型数据`} onClick={() => onSelect(p.g)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(p.g); } }} className="rsi-chart-hit" />
      </g>; })}
    </svg>
  </div><div className="rsi-chart-legend">{keys.map(k => <span key={k.key}><i style={{ background: k.color }} />{k.name}</span>)}</div></>;
}

export function RsiTrajectory({ state, lineage }: { state: RsiState; lineage?: AssetLineage | null }) {
  const [scope, setScope] = useState<Scope>('all'), [runId, setRunId] = useState<string | undefined>();
  const [selected, setSelected] = useState<{ run: string; gen: number } | null>(null);
  const [allRuns, setAllRuns] = useState(false);
  const views = buildEvolutionViews(state), formalView = views.find(v => v.id === 'versions' && v.points.some(p => p.scores));
  const view = views.find(v => v.id === runId) || views.find(v => v.run?.status === 'running') || [...views].reverse().find(v => v.run) || formalView || views[0], points = view?.points || [];
  const formal = view?.id === 'versions', pointName = (p: GenPoint) => formal ? p.inputLabel : `G${p.g}`;
  const selectedGen = selected?.run === view?.id && points.some(p => p.g === selected.gen) ? selected.gen : points[points.length - 1]?.g ?? 0;
  const point = points.find(p => p.g === selectedGen), onSelect = (gen: number) => setSelected({ run: view.id, gen });
  const measured = points.filter(p => p.g > 0 && value(p, scope) != null);
  // 空谱系紧凑态（10-15 审核 P2）：只有 G0（还没任何代际尝试）时不铺开谱系/折线/柱状
  // 三大图表区——单点折线+空谱系占满首屏，真正的薄弱指标被压到下面。展示紧凑摘要，
  // 至少出现一次真实代际读数后才展开完整趋势。
  const onlyBaseline = !formal && points.length <= 1 && (state.evolveRuns || []).every(r => r.rounds.length === 0)
    && nodesTotal(points, state, lineage ?? null) <= 1;
  const rows = points.flatMap(p => [{ key: `${p.g}-output`, gen: `G${p.g}`, object: formal ? p.inputLabel : p.g === 0 ? p.inputLabel : p.championLabel || '—', kind: formal ? '版本最新实测' : p.g === 0 ? '输入基线' : '收敛结果', status: formal && !p.scores ? '版本未评测' : RESULT[p.result] || p.result,
    all: p.g === 0 ? p.inputScore.all : p.championScore?.all, heldout: p.g === 0 ? p.inputScore.heldout : p.championScore?.heldout, delta: p.g === 0 ? null : generationDelta(p, scope), reason: p.note },
    ...p.trials.map(t => ({ key: `${p.g}-${t.id}`, gen: `G${p.g}`, object: t.id, kind: t.summary || t.opLabel || t.op, status: status(t, p.championLabel), all: t.score.all, heldout: t.score.heldout,
      delta: t.comparable && t.score[scope] != null && t.parentScore[scope] != null ? t.score[scope]! - t.parentScore[scope]! : null, reason: `${t.parent ? `父代 ${t.parent}。` : ''}${t.gateReason || ''}` }))]);
  return <section className="rsi-evolution-view" aria-label="进化效果">
    <div className="rsi-evolution-toolbar"><div><h3>进化迭代 DAG</h3><p>沿父代追溯每次变异、分支延续和采纳结果，点击节点查看改动依据。{businessContextName(state) ? `业务对象：${businessContextName(state)}；版本号是追溯锚点，业务名帮助定位。` : ''}</p></div>
      <div className="rsi-evolution-controls"><Select aria-label="选择进化实验" value={view?.id} onChange={id => { setRunId(id); setSelected(null); }} options={[...views].reverse().map(v => ({ label: runDisplayLabel(v.label, state), value: v.id }))} style={{ minWidth: 270 }} />
        <Segmented aria-label="精度评测范围" value={scope} onChange={v => setScope(v as Scope)} options={[{ label: '全体评测题', value: 'all' }, { label: '隐藏验证题', value: 'heldout' }]} /></div>
    </div>
    <div className="rsi-evolution-summary"><span>正式版本 <b>{state.currentVersion}</b></span>{formal ? <><span>版本记录 <b>{points.length}</b> 个</span><span>有实测 <b>{points.filter(p => p.scores).length}</b> 个</span><span>未评测 <b>{points.filter(p => !p.scores).length}</b> 个</span><Tag>版本测量不是代际；同版重测已折叠</Tag></> : <><span>本实验 <b>{Math.max(0, points.length - 1)}</b> 次代际尝试</span><span>有收敛读数 <b>{measured.length}</b> 代</span><span>记录候选 <b>{points.reduce((n, p) => n + p.trials.length, 0)}</b> 个</span>
      <Tag color={view?.run?.status === 'running' ? 'processing' : undefined}>{view?.run?.status === 'running' ? '运行中 · 自动更新' : view?.run?.totalAdopted ? `已固化为 ${view.run.finalVersion}` : view?.run?.status === 'awaiting_human' ? '等待人工采纳，正式版本未改动' : '本实验未固化新版本'}</Tag></>}</div>
    {view?.legacy && <Alert type="info" showIcon message="历史实验部分代际或题型明细未保存；缺失读数保留为空，不跨实验续接。" style={{ marginBottom: 14 }} />}
    {view?.run?.rounds.flatMap(r => (r.mutationErrors || []).map((e, i) => <Alert key={`${r.gen}-${i}`} type="warning" showIcon message={`G${r.gen ?? r.round} · ${pathName(e.target)}变异失败`} description={`${e.parent || ''} ${e.reason}；其他路径继续运行。`} style={{ marginBottom: 8 }} />))}
    {view?.run?.timings && <section className="rsi-chart-section" aria-label="进化耗时分解"><div className="rsi-section-heading"><h4>本次进化耗时</h4><span>题目并发 {view.run.scoringConcurrency || 1} · 累计 {(view.run.timings.elapsedMs / 1000).toFixed(1)} 秒</span></div>
      <div className="rsi-shape-readings">{Object.entries(view.run.timings.phases).map(([key, ms]) => <span key={key}>{({ baseline: '基线评测', attribute: '错题归因', propose: '生成方案', mutate: '生成变异', evaluate: '候选评测', select: '筛选收敛', crossover: '融合验证', engine_check: '引擎复核', adopt: '采纳固化' } as Record<string, string>)[key] || key} <strong>{(ms / 1000).toFixed(1)} 秒</strong></span>)}</div>
      <p className="rsi-chart-caption">按实际阶段累计，用于定位等待；不是识别请求延迟，也不代表算法性能提升。</p></section>}
    {state.integrity.drift && <Alert type="warning" showIcon message="题库已变化，历史成绩不能与当前成绩直接比较。" style={{ marginBottom: 14 }} />}
    {onlyBaseline ? <>
      {/* 紧凑基线摘要：只有 G0 时替代三大图表区，一眼看到起点成绩与题型短板 */}
      <section className="rsi-chart-section"><div className="rsi-section-heading"><h4>起点成绩</h4><span>尚无代际尝试——完成一轮自动进化后这里展开完整趋势</span></div>
        <p className="rsi-chart-caption">当前只有 G0 基线读数（{scope === 'all' ? '训练 + 隐藏验证题，不含终极考题' : '参与筛选的验证集，不代表独立泛化测试'}）。谱系图、代际折线与题型柱状图会在第一代候选出现后自动展开。</p>
        {points[0] && <div className="rsi-shape-readings"><b>G0 基线读数</b>{SHAPES.map(k => { const s = shape(points[0].scores, scope, k.key); return s && s.total > 0 ? <span key={k.key}>{k.name} <strong>{pct(s.strict_pct)}</strong> · n={s.total}{s.total < 10 ? ` · 1题=${(100 / s.total).toFixed(1)} pp` : ''}</span> : null; })}{!points[0].scores && <span>基线未保存题型明细</span>}</div>}
        <Table size="small" pagination={false} rowKey="key" dataSource={rows} scroll={{ x: 850 }} columns={[
          { title: '对象', dataIndex: 'object', width: 80 }, { title: '变异 / 角色', dataIndex: 'kind', width: 260 }, { title: '状态', dataIndex: 'status', width: 130 }, { title: '全体精度', dataIndex: 'all', width: 95, render: pct },
          { title: '隐藏验证精度', dataIndex: 'heldout', width: 120, render: pct }, { title: '相对输入', dataIndex: 'delta', width: 130, render: pp }, { title: '原因', dataIndex: 'reason', render: v => v || '—' },
        ]} />
      </section>
      <section className="rsi-chart-section"><div className="rsi-section-heading"><h4>逐次评测原始台账</h4><span>{state.scoreHistory?.length || 0} 条 · 保留重测，按实验定位分支</span></div><Table size="small" pagination={false} rowKey="rowId" scroll={{ x: 850 }} dataSource={[...(state.scoreHistory || [])].reverse().map((h, i) => ({ ...h, rowId: `${h.ctx?.runId || 'legacy'}-${h.version}-${h.at}-${i}` }))} columns={[
        { title: '对象', dataIndex: 'version', width: 85 }, { title: '实验 / 代', render: (_, h) => h.ctx?.runId ? `${h.ctx.runId} / G${h.ctx.gen ?? '?'}` : '历史记录 · 归属未保存', width: 240 }, { title: '全体精度', render: (_, h) => pct(h.scores.all?.strict_pct), width: 110 },
        { title: '训练精度', render: (_, h) => pct(h.scores.train?.strict_pct), width: 110 }, { title: '隐藏验证精度', render: (_, h) => pct(h.scores.heldout?.strict_pct), width: 120 },
        { title: '引擎口径', render: (_, h) => h.engineRev ? `${h.engineRev.engineSha.slice(0, 8)} / ${h.engineRev.engineMode}` : '未保存', width: 180 }, { title: '时间', render: (_, h) => new Date(h.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) },
      ]} /></section>
    </> : <>
    <section className="rsi-chart-section"><div className="rsi-section-heading"><h4>变异与收敛谱系</h4><Segmented aria-label="谱系显示范围" value={allRuns ? 'all' : 'run'} onChange={v => setAllRuns(v === 'all')} options={[{ label: '当前实验', value: 'run' }, { label: '全部实验关系', value: 'all' }]} /></div>
      {/* 10-15 用户反馈重构：单张全量 DAG——v1→v2→… 主轴 + 每代变异分支思维导图式扇出，
          不再每代一张分开的图。点击节点按其所属代际联动下方明细表 */}
      {nodesTotal(points, state, lineage ?? null) === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚无版本与变异记录。完成一次进化或提交提案后，这里会显示完整谱系。" />
        : <LineageGraph key={`${allRuns ? 'all' : view?.id}`} state={state} points={points} scope={scope} selectedGen={selectedGen} onSelect={onSelect} lineage={lineage ?? null} runId={allRuns ? undefined : view?.id} />}
      <p className="rsi-chart-caption">灰线表示变异来源，蓝线表示采纳或选中节点的祖先路径；虚线框保留淘汰记录。拖动空白处平移，点击「适应画布」查看全貌。</p>
    </section>
    <section className="rsi-chart-section"><div className="rsi-section-heading"><h4>{formal ? '正式版本精度 · 最新实测' : '代际精度 · 收敛结果与试验分支'}</h4><span>{scope === 'all' ? '训练 + 隐藏验证题，不含终极考题' : '参与筛选的验证集，不代表独立泛化测试'}</span></div>
      <div className="rsi-chart-legend"><span><i className="rsi-legend-line" />{formal ? '版本实测（同版重测折叠）' : '收敛读数'}</span>{!formal && <><span><i className="rsi-legend-trial" />本代已记录的候选</span><span>× 淘汰 / 评测失败</span></>}<span>不同或缺失评测条件保留断点；点击查看明细</span></div>
      {points.length ? <AccuracyChart points={points} scope={scope} selectedGen={selectedGen} onSelect={onSelect} formal={formal} /> : <Empty description="暂无实测成绩" />}
      <p className="rsi-chart-caption">{formal ? '横轴是真实正式版本，不是代际。未独立评测的版本保留空位；同版本历史重测完整保留在原始台账。' : '无候选、评测失败、待人工采纳和历史未保存分别标注；已有候选成绩仍显示，不用父代成绩补造新输出。'}只有评测器、题库与切分可比时才连线并计算收益。窄屏可在图内横向滚动查看全部读数。</p>
    </section>
    <section className="rsi-chart-section"><div className="rsi-section-heading"><h4>{formal ? '正式版本题型精度' : '逐代题型精度'}</h4><span>{formal ? '每组柱对应一个版本的最新独立实测' : '每组柱对应一代的收敛读数；未保存的不补造'}</span></div><ShapeChart points={points} scope={scope} selectedGen={selectedGen} onSelect={onSelect} formal={formal} />
      {point && <div className="rsi-shape-readings"><b>{pointName(point)} 选中读数</b>{SHAPES.map(k => { const s = shape(point.scores, scope, k.key); return s && s.total > 0 ? <span key={k.key}>{k.name} <strong>{pct(s.strict_pct)}</strong> · n={s.total}{s.total < 10 ? ` · 1题=${(100 / s.total).toFixed(1)} pp` : ''}</span> : null; })}{!point.scores && <span>{missingReading(point, formal)}</span>}</div>}
    </section>
    <section className="rsi-chart-section"><div className="rsi-section-heading"><h4>{formal ? '版本性能实测记录' : '代际性能与收益证据'}</h4><span>尚无独立终测的结果不代表泛化提升</span></div>
      <Table size="small" pagination={false} rowKey="g" scroll={{ x: 850 }} dataSource={points.map(p => ({ g: p.g, reading: p.g === 0 ? p.inputScores : p.scores }))} columns={[
        { title: formal ? '版本' : '代际', dataIndex: 'g', render: g => formal ? points.find(p => p.g === g)?.inputLabel : `G${g}` },
        { title: '评测并发', render: (_, r) => r.reading?.all?.performance?.scoring_concurrency ?? (r.reading?.all?.performance ? 1 : '未记录') },
        { title: 'P50 延迟', render: (_, r) => r.reading?.all?.performance?.p50_ms == null ? '未记录' : `${r.reading.all.performance.p50_ms.toFixed(2)} ms` },
        { title: 'P95 延迟', render: (_, r) => r.reading?.all?.performance?.p95_ms == null ? '未记录' : `${r.reading.all.performance.p95_ms.toFixed(2)} ms` },
        { title: '实测题数', render: (_, r) => r.reading?.all?.performance ? `${r.reading.all.performance.measured}/${r.reading.all.performance.total}` : '未记录' },
        { title: '实际 LLM 调用', render: (_, r) => r.reading?.all?.performance?.llm_calls ?? '未记录' },
        { title: '实际 tokens', render: (_, r) => r.reading?.all?.performance?.tokens ?? '未记录' },
        { title: '费用', render: (_, r) => r.reading?.all?.performance?.cost == null ? '未计价' : r.reading.all.performance.cost },
      ]} />
      <p className="rsi-chart-caption">延迟包含缓存状态和调用重试，单次运行仅作观察；调用数由评分进程记录真实请求，缺失用量不估算为零。不得仅凭精度上涨宣称综合提升。</p>
    </section>
    <section className="rsi-chart-section"><div className="rsi-section-heading"><h4>{point ? pointName(point) : '记录'} 明细</h4><span>{formal ? point?.note : '当前代已保存的候选与淘汰原因'}</span></div><Table size="small" pagination={false} rowKey="key" dataSource={rows.filter(r => r.gen === `G${selectedGen}`)} scroll={{ x: 850 }} columns={[
      { title: '对象', dataIndex: 'object', width: 80 }, { title: '变异 / 角色', dataIndex: 'kind', width: 260 }, { title: '状态', dataIndex: 'status', width: 130 }, { title: '全体精度', dataIndex: 'all', width: 95, render: pct },
      { title: '隐藏验证精度', dataIndex: 'heldout', width: 120, render: pct }, { title: '相对输入', dataIndex: 'delta', width: 130, render: pp }, { title: '原因', dataIndex: 'reason', render: v => v || '—' },
    ]} /></section>
    <section className="rsi-chart-section"><div className="rsi-section-heading"><h4>逐次评测原始台账</h4><span>{state.scoreHistory?.length || 0} 条 · 保留重测，按实验定位分支</span></div><Table size="small" pagination={false} rowKey="rowId" scroll={{ x: 850 }} dataSource={[...(state.scoreHistory || [])].reverse().map((h, i) => ({ ...h, rowId: `${h.ctx?.runId || 'legacy'}-${h.version}-${h.at}-${i}` }))} columns={[
      { title: '对象', dataIndex: 'version', width: 85 }, { title: '实验 / 代', render: (_, h) => h.ctx?.runId ? `${h.ctx.runId} / G${h.ctx.gen ?? '?'}` : '历史记录 · 归属未保存', width: 240 }, { title: '全体精度', render: (_, h) => pct(h.scores.all?.strict_pct), width: 110 },
      { title: '训练精度', render: (_, h) => pct(h.scores.train?.strict_pct), width: 110 }, { title: '隐藏验证精度', render: (_, h) => pct(h.scores.heldout?.strict_pct), width: 120 },
      { title: '引擎口径', render: (_, h) => h.engineRev ? `${h.engineRev.engineSha.slice(0, 8)} / ${h.engineRev.engineMode}` : '未保存', width: 180 }, { title: '时间', render: (_, h) => new Date(h.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) },
    ]} /></section>
    {!!lineage?.assets.length && <details className="rsi-chart-section"><summary>历史资产台账（独立快照，不自动拼成实验代际） · {lineage.assets.length} 条</summary><Table size="small" rowKey="short" pagination={{ pageSize: 5 }} scroll={{ x: 800 }} dataSource={lineage.assets} columns={[
      { title: '资产', render: (_, a) => `资产 ${a.short}` }, { title: '已记录改动', render: (_, a) => mutationName(a.mutations.join('；')) || '未保存' },
      { title: '真实父资产', render: (_, a) => a.parents.join('、') || '未记录，不推断' }, { title: '固化版本', render: (_, a) => a.adoptedBy.join('、') || '无固化记录' },
      { title: '全体完全正确率', render: (_, a) => pct(a.scores?.all) },
    ]} /></details>}
    </>}
  </section>;
}
