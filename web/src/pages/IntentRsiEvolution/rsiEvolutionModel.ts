import type { RsiState, RsiScores, EvolveRun, EvolutionBranch, EngineRev } from './rsiShared';

export type Scope = 'all' | 'heldout';
export type GenScore = { all: number | null; heldout: number | null };
export type EvolutionTrial = EvolutionBranch & { score: GenScore; parentScore: GenScore; comparable: boolean };
export interface GenPoint {
  g: number; inputLabel: string; inputScore: GenScore; inputScores: RsiScores | null;
  championLabel: string | null; championScore: GenScore | null; scores: RsiScores | null;
  trials: EvolutionTrial[]; result: string; note: string | null; phase?: string;
  fixedVersion: string | null; comparable: boolean; engineRev: EngineRev | null;
  measurementAt?: string; measurementCount?: number;
}
export interface EvolutionView { id: string; run: EvolveRun | null; points: GenPoint[]; label: string; legacy: boolean }
export function normalizeEvolutionRun(run:EvolveRun):EvolveRun {
  return {...run,rounds:Array.isArray(run.rounds)?run.rounds:[],branches:run.branches||{},at:run.at||''};
}

const finite = (n: unknown): number | null => typeof n === 'number' && Number.isFinite(n) ? n : null;
const empty = (): GenScore => ({ all: null, heldout: null });
const numeric = (s?: RsiScores | null): GenScore => ({ all: finite(s?.all?.strict_pct), heldout: finite(s?.heldout?.strict_pct) });
export function sameEngine(a?: EngineRev | null, b?: EngineRev | null): boolean {
  return !!a && !!b && a.engineSha === b.engineSha && a.protoRev === b.protoRev && a.engineMode === b.engineMode;
}


function formalVersionView(state: RsiState): EvolutionView {
  let previous: NonNullable<RsiState['scoreHistory']>[number] | null = null;
  const points: GenPoint[] = state.versions.map((v, i) => {
    const readings = (state.scoreHistory || []).filter(h => h.version === v.version).sort((a, b) => a.at.localeCompare(b.at));
    // 10-22 正式版本趋势线始终连接：v4 是进化结果，引擎口径变更不阻断版本演进趋势
    const h = readings.at(-1);
    const scores = h?.scores || null;
    const rev = h?.engineRev || (scores as (RsiScores & { engineRev?: EngineRev }) | null)?.engineRev || null;
    const before = previous;
    // 正式版本间只要都有实测就连线——它们是同一条进化线上的里程碑
    const comparable = !!h && !!before;
    const p: GenPoint = { g: i, inputLabel: v.version, inputScore: numeric(i ? before?.scores : scores), inputScores: i ? before?.scores || null : scores,
      championLabel: i && scores ? v.version : null, championScore: i && scores ? numeric(scores) : null,
      scores, trials: [], result: !h ? 'unmeasured' : readings.length > 1 ? 'retest' : 'version',
      note: h ? (readings.length > 1 ? `${readings.length}次实测，展示最近一次` : '版本实测记录') : '版本已生成，但没有独立实测记录',
      fixedVersion: v.version, comparable, engineRev: rev, measurementAt: h?.at, measurementCount: readings.length };
    previous = h || null;
    return p;
  });
  return { id: 'versions', run: null, points, label: '正式版本实测 · 非实验代际', legacy: false };
}

export function missingReading(point: GenPoint, formal = false): string {
  if (formal) return '版本未评测';
  if (point.g === 0) return '历史基线未保存';
  return ({ running: '评测进行中', no_mutations: '未产生新候选', propose_fail: '变异失败', no_evaluations: '候选评测未成功',
    no_pass: '候选未通过，无收敛输出', awaiting_human: '待采纳，无正式输出', stopped: '任务已停止', error: '任务失败' } as Record<string, string>)[point.result] || '历史收敛成绩未保存';
}

export function buildEvolutionViews(state: RsiState): EvolutionView[] {
  const runs = (state.evolveRuns || []).map(normalizeEvolutionRun);
  if (state.activeEvolution) {
    const index = runs.findIndex(r => r.id === state.activeEvolution!.id);
    if (index >= 0) runs[index] = normalizeEvolutionRun(state.activeEvolution); else runs.push(normalizeEvolutionRun(state.activeEvolution));
  }
  return [formalVersionView(state), ...runs.map((run, index) => {
    const id = run.id || `legacy-${index}`;
    const branches = run.branches || {};
    const branchReading = (branchId: string): RsiScores | null => {
      const tagged = (state.scoreHistory || []).filter(h => h.version === branchId && h.ctx?.runId === id);
      if (tagged.length) return tagged[tagged.length - 1].scores;
      // Legacy IDs restart on each run. Recover only an unambiguous reading
      // within this completed run's window matching its saved aggregates.
      if (run.context || run.status === 'running') return null;
      const b = branches[branchId], lower = runs[index - 1]?.at || '';
      const candidates = (state.scoreHistory || []).filter(h => h.version === branchId && !h.ctx?.runId && h.at > lower && h.at <= run.at
        && (b?.scores?.trainStrict == null || h.scores.train.strict_pct === b.scores.trainStrict)
        && (b?.scores?.heldoutStrict == null || h.scores.heldout.strict_pct === b.scores.heldoutStrict));
      return candidates.length === 1 ? candidates[0].scores : null;
    };
    const root = Object.values(branches).find(b => !b.parent);
    const baseVersion = run.baseVersion || root?.baseVersion || run.finalVersion || 'v1';
    // Only a historical reading made before this run can supply its baseline.
    const baseline = [...(state.scoreHistory || [])].reverse().find(h => h.version === baseVersion && h.at <= run.at && (!run.engineRev || sameEngine(run.engineRev, h.engineRev)));
    const rootScores = root?.fullScores || run.rounds[0]?.inputScores || baseline?.scores || null;
    const rootRev = root?.engineRev || run.engineRev || baseline?.engineRev || null;
    const rootNum = rootScores ? numeric(rootScores) : { all: finite(root?.scores?.allStrict), heldout: finite(root?.scores?.heldoutStrict) };
    const points: GenPoint[] = [{ g: 0, inputLabel: baseVersion, inputScore: rootNum, inputScores: rootScores,
      championLabel: null, championScore: null, scores: rootScores, trials: [], result: 'baseline', note: null,
      fixedVersion: null, comparable: true, engineRev: rootRev }];
    let previousLabel = root?.id || baseVersion;
    let previousScores = rootScores;
    let previousNumeric = rootNum;
    let previousRev = rootRev;
    for (const [ri, round] of run.rounds.entries()) {
      const gen = round.gen ?? round.round ?? ri + 1;
      const champ = round.champion ?? round.roundChampion ?? null;
      const inputLabel = round.inputBranch || previousLabel;
      const inputScores = round.inputScores || previousScores;
      const inputScore = round.inputScores ? numeric(round.inputScores) : previousNumeric;
      const rawTrials = (round.candidates || round.branchIds || Object.values(branches).filter(b => b.parent && (b.gen != null ? b.gen === gen : run.rounds.length === 1)))
        .map(b => typeof b === 'string' ? branches[b] || { id: b, parent: null, gen, depth: gen, op: 'unknown', status: 'unmeasured', scores: null } : b);
      const pointRev = round.engineRev || round.outputScores && (round.outputScores as RsiScores & { engineRev?: EngineRev }).engineRev || rootRev;
      const trials = rawTrials.map(b => { const fullScores = b.fullScores || branchReading(b.id);
        const parent = branches[b.parent || ''], parentScores = parent?.fullScores || (parent ? branchReading(parent.id) : null);
        const parentScore = parentScores ? numeric(parentScores) : parent?.scores ? { all: finite(parent.scores.allStrict), heldout: finite(parent.scores.heldoutStrict) } : b.parent === inputLabel ? inputScore : empty();
        return { ...b, fullScores, parentScore,
        score: fullScores ? numeric(fullScores) : { all: finite(b.scores?.allStrict), heldout: finite(b.scores?.heldoutStrict) },
        comparable: !!run.context && sameEngine(parent?.engineRev || previousRev, b.engineRev || pointRev) }; });
      const noOutput = ['no_mutations', 'no_evaluations', 'propose_fail', 'stopped', 'running'].includes(round.result);
      const champBranch = rawTrials.find(b => b.id === champ) || branches[champ || ''];
      const outputScores = noOutput ? null : round.outputScores || champBranch?.fullScores || (champ ? branchReading(champ) : null);
      const outputNum = noOutput ? empty() : outputScores ? numeric(outputScores) : {
        all: finite(round.allStrict) ?? finite(champBranch?.scores?.allStrict),
        heldout: finite(round.heldoutStrict) ?? finite(champBranch?.scores?.heldoutStrict),
      };
      const hasOutput = outputNum.all != null || outputNum.heldout != null;
      const explicitAdoptions = Object.values(branches).filter(b => b.adoptedAs);
      const adoptedBranch = run.adoptedBranch || (!explicitAdoptions.length && !run.rounds.some(r => r.adoptedVersions?.length) ? run.champion : null);
      const adoptedVersion = rawTrials.find(b => b.adoptedAs)?.adoptedAs || explicitAdoptions.find(b => b.gen === gen)?.adoptedAs;
      const adoptedHere = adoptedBranch && (round.branchIds?.includes(adoptedBranch) || rawTrials.some(b => b.id === adoptedBranch) || branches[adoptedBranch]?.gen === gen);
      const p: GenPoint = { g: gen, inputLabel, inputScore, inputScores,
        championLabel: champ, championScore: hasOutput ? outputNum : null, scores: outputScores,
        trials, result: round.result, note: round.note || ((round as { retainedParent?: boolean }).retainedParent ? '本代未找到可靠改善，沿用父代已有成绩；不是新增实测或正式升级' : null), phase: round.phase,
        fixedVersion: round.adoptedVersions?.at(-1) || adoptedVersion || (adoptedHere && run.totalAdopted > 0 && run.finalVersion !== baseVersion ? run.finalVersion : null),
        comparable: !!run.context && sameEngine(previousRev, pointRev), engineRev: pointRev };
      points.push(p);
      if (hasOutput) { previousLabel = champ || inputLabel; previousScores = outputScores; previousNumeric = outputNum; previousRev = pointRev; }
    }
    const date = run.at ? new Date(run.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '时间未记录';
    return { id, run, points, label: `实验 ${index + 1} · ${date} · ${baseVersion}${run.status === 'running' ? ' · 进行中' : ''}`, legacy: !run.context };
  })];
}

export function buildGenSeries(state: RsiState, runId?: string): GenPoint[] {
  const views = buildEvolutionViews(state);
  return (views.find(v => v.id === runId) || views[views.length - 1])?.points || [];
}

export function generationDelta(point: GenPoint, scope: Scope): number | null {
  const output = point.championScore?.[scope];
  const input = point.inputScore[scope];
  return point.comparable && output != null && input != null ? output - input : null;
}
