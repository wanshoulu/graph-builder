/**
 * 评测预算预设（codex 10-18 复审"尚需注意"：预算单位缺目标式预设）：
 * 用户想的是"先小成本试试 / 认真跑一轮 / 深度搜一遍"，不是抽象的次数-分钟数字。
 * 三档预设一键填充，仍可手动覆盖；不承诺费用（实际费用取决于服务计费，不冒充免费）。
 */

export interface BudgetPreset {
  id: string;
  /** 业务说法，作为选项 label */
  label: string;
  /** 这档大概做什么、适合什么阶段，一句话人话 */
  explanation: string;
  maxMetricCalls: number;
  maxMinutes: number;
}

export const BUDGET_PRESETS: BudgetPreset[] = [
  {
    id: 'probe',
    label: '先小规模试探',
    explanation: '跑 2-3 代看 AI 的改进方向对不对，不对就调配置再来；适合第一次跑或换了优化目标之后。',
    maxMetricCalls: 40,
    maxMinutes: 20,
  },
  {
    id: 'standard',
    label: '标准一轮优化',
    explanation: '给 AI 足够的迭代空间找到并通过验证的方案；日常优化用这档。',
    maxMetricCalls: 120,
    maxMinutes: 60,
  },
  {
    id: 'deep',
    label: '深度搜索',
    explanation: '多代多分支充分搜索，耗时与用量明显更高；确认方向正确、想要更好结果时再选。',
    maxMetricCalls: 300,
    maxMinutes: 180,
  },
];

/** 预设归档：预算数字落在预设范围内才认（用户手动改过就不归档） */
export function matchBudgetPreset(maxMetricCalls: number, maxMinutes: number): string | null {
  const hit = BUDGET_PRESETS.find(p => p.maxMetricCalls === maxMetricCalls && p.maxMinutes === maxMinutes);
  return hit ? hit.id : null;
}
