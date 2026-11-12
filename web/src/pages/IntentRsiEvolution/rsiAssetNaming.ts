/**
 * 资产业务命名（codex 10-18 复审 P2：资产名需业务元数据，不能只重命名技术版本）：
 * v1/v2/run_xxx 这类技术标识对业务人员不可读。把任务名、业务图谱名与版本号组合成
 * 业务可读名；技术号永远保留（降为次要文本），不冒充业务名、不丢弃追溯锚点。
 * 后端没有业务名时回退展示技术号——宁可生硬，不造假。
 */
import type { RsiState } from './rsiShared';

/** 业务上下文一行摘要："任务名 · 图谱名"（缺哪个补哪个，全缺返回 null） */
export function businessContextName(state: Pick<RsiState, 'taskName' | 'baseGraph' | 'taskId'>): string | null {
  const task = state.taskName && state.taskName !== state.taskId ? state.taskName : null;
  const graph = state.baseGraph?.label || null;
  const parts = [task, graph].filter(Boolean) as string[];
  return parts.length ? parts.join(' · ') : null;
}

/** 版本的业务可读展示：主文本 = 业务语境（若有），版本号始终以次要形式保留 */
export function versionDisplay(
  version: string,
  state: Pick<RsiState, 'taskName' | 'baseGraph' | 'taskId'>,
): { primary: string; secondary: string | null } {
  const ctx = businessContextName(state);
  return ctx ? { primary: `${ctx} · ${version}`, secondary: null } : { primary: version, secondary: null };
}

/** 实验（运行）的业务可读 label：日期与代号保留，任务语境不足时补业务名 */
export function runDisplayLabel(
  label: string,
  state: Pick<RsiState, 'taskName' | 'baseGraph' | 'taskId'>,
): string {
  // buildEvolutionViews 的 label 形如 "实验 1 · 10/18 09:30 · v1 · 进行中"——
  // 已含时间与基线版本；业务人员还缺"这是哪个业务"，补前缀
  const ctx = businessContextName(state);
  return ctx ? `${ctx} · ${label}` : label;
}
