/**
 * 运行页集中摘要（codex 2026-10-18 复审 P1②）：
 * 运行页顶部先回答"是否正常、还在做什么"——阶段/代次、候选数、已用预算、
 * 真实已运行时间、最近活动。不写固定预计完成时间（没有可靠模型时只报事实）。
 */
import type { EvolveRun, RsiState } from './rsiShared';

export interface RunSummaryItem {
  label: string;
  value: string;
  /** 一句话解释该数字怎么来的，避免口径误读 */
  note?: string;
}

const PHASE_NAME: Record<string, string> = {
  attribution: '错误归因',
  propose: '生成改进方案',
  evaluate: '评测候选',
  gate: '门禁判定',
  adopt: '采纳',
  converge: '收敛检查',
  round: '代际迭代',
};

function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '未记录';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${s % 60} 秒`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

/** 从运行记录推断"候选数"口径：多分支=分支数，单线=已产出方案数；都无则回退轮次产出 */
function candidateCount(run: EvolveRun): { count: number | null; note: string } {
  const branches = Object.keys(run.branches || {}).length;
  if (branches > 0) return { count: branches, note: '本次运行的候选分支数（含被淘汰的）' };
  const proposed = run.rounds.reduce((a, r) => a + (r.proposed || 0), 0);
  if (proposed > 0) return { count: proposed, note: '各轮 AI 产出方案累计（含被门禁拦下的）' };
  return { count: null, note: '尚未产出候选' };
}

export function runSummary(state: RsiState, now: number = Date.now()): { items: RunSummaryItem[]; recent: { at: string; detail: string }[] } {
  const run = state.activeEvolution || state.evolveRuns?.[state.evolveRuns.length - 1] || null;
  const running = !!state.evolveRunning;
  const items: RunSummaryItem[] = [];
  // 阶段/代次
  if (run) {
    const gen = run.currentGen;
    if (running) {
      const lastRound = [...run.rounds].reverse().find(r => r.round > 0)?.round ?? 0;
      items.push({ label: '当前阶段', value: gen != null ? `第 ${gen} 代优化中` : lastRound ? `第 ${lastRound} 轮迭代中` : '正在启动', note: '以服务端记录为准，页面刷新不影响运行' });
    } else {
      const statusLabel = ({ stopped: '已停止', interrupted: '已中断', error: '运行失败', awaiting_human: '等待审阅', no_adopt: '未产生可采纳方案' } as Record<string, string>)[run.status || ''] || '已结束';
      items.push({ label: '运行状态', value: statusLabel, note: run.status === 'stopped' ? '已保存检查点，可从运行页恢复' : run.status === 'error' ? '查看日志确认原因；已完成的代次产出保留' : undefined });
    }
  } else {
    items.push({ label: '运行状态', value: '尚未运行', note: '配置运行上限后才会开始生成与验证方案' });
  }
  // 候选数
  if (run) {
    const c = candidateCount(run);
    items.push({ label: '候选方案', value: c.count == null ? '暂无' : `${c.count} 个`, note: c.note });
  } else {
    items.push({ label: '候选方案', value: '—' });
  }
  // 已用预算：优先 run 记账，缺省回退任务累计 stats
  if (run?.metricCalls != null || run?.budget) {
    const used = run.metricCalls ?? 0;
    const cap = run.budget?.maxMetricCalls;
    items.push({ label: '已用评测预算', value: cap ? `${used} / ${cap} 次` : `${used} 次`, note: '一次完整候选评测记 1 次；时间预算见运行记录详情' });
  } else {
    items.push({ label: '累计评测', value: `${state.stats?.evaluated ?? 0} 次`, note: '本任务历史累计（跨运行）' });
  }
  // 已运行时间：完成跑用服务端 timings；运行中用 startedAt 到现在的真实时长；都不写预计完成
  if (run?.timings?.elapsedMs != null && !running) {
    items.push({ label: '运行耗时', value: fmtDuration(run.timings.elapsedMs) });
  } else if (running && run) {
    const started = run.timings?.phases ? null : (state.activeEvolution?.at || null);
    const startMs = started ? Date.parse(started) : NaN;
    items.push({ label: '已运行', value: Number.isFinite(startMs) ? fmtDuration(now - startMs) : '进行中', note: '实际耗时取决于模型服务速度，不预估完成时间' });
  } else if (run) {
    items.push({ label: '运行耗时', value: '未记录', note: '旧记录没有保存耗时' });
  } else {
    items.push({ label: '运行耗时', value: '—' });
  }
  // 最近活动：publicState 已把 log 倒序、截 40 条，取前 4 条即可
  const recent = (state.log || []).slice(0, 4).map(l => ({ at: l.at, detail: l.detail }));
  return { items, recent };
}
