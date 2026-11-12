import type { RsiState, ShapeScores } from './rsiShared';
const reading = (scores: ShapeScores | null) => scores && Number.isFinite(scores.strict_pct) ? `${scores.strict_pct}% · n=${scores.total ?? '未记录'}` : '未评测';
export function candidateComparisonRows(entries: RsiState['archive']) {
  return entries.map(p => ({ id: p.id, name: p.targetName || p.opLabel || p.id, status: p.status,
    train: reading(p.trainScores), heldout: reading(p.heldoutScores), version: p.candidateBaseVersion || p.baselineAtEval?.version || '未记录',
    runId: p.runId || '历史记录 · 归属未知', gate: p.gate?.reason || '未记录', hash: p.candidateHash || '未记录' }));
}
export interface CandidateDiff {
  candidate: { id: string; summary?: string; status?: string }; parents: string[];
  context?: Record<string, unknown>; valid: boolean;
  changes: { path: string; before: unknown; after: unknown }[];
  caseChanges: { case_id: string; query: string; shape?: string; before?: { strict?: boolean; resultType?: string }; after?: { strict?: boolean; resultType?: string }; change: string }[];
  gate?: unknown;
}
