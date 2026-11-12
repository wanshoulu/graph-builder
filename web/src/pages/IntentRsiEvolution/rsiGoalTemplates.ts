/**
 * 业务目标模板（codex 2026-10-18 复审 P1①）：
 * 把业务说法（"减少一句话里多个需求的漏识别""模糊提问先澄清"）映射成
 * 可执行的推荐配置（算子白名单、停止轮数、题目构成期望），全部可改。
 *
 * 设计取舍（先解释后推荐，不包装默认全体正确率为万能答案）：
 * - 只推荐「能被当前算子与评测体系兑现」的目标；识别准确率类目标必须先评测基线，
 *   否则推荐无效（模板会说明这一点，而不是硬给阈值）。
 * - 不在此处生成"验收阈值"数字：阈值属于业务决策，模板只说明对应看哪个数、在哪儿看。
 */

export interface GoalTemplate {
  id: string;
  /** 业务说法原话，作为选项 label */
  label: string;
  /** 这句话落到哪些可执行配置，一句话人话（每个非主选项都要有说明——10-17 布局铁律） */
  explanation: string;
  /** 推荐算子白名单（空 = 不限制） */
  ops: string[];
  /** 推荐连续无提升停止轮数（多意图/澄清类目标方案见效慢，给更宽容的收敛窗口） */
  noImproveRounds: number;
  /** 题目构成提醒：该目标需要哪类题足够多才能被优化看见 */
  caseNote: string;
  /** 效果到哪儿看（指标与页面位置，不编造阈值） */
  whereToLook: string;
}

export const GOAL_TEMPLATES: GoalTemplate[] = [
  {
    id: 'multi_intent_recall',
    label: '一句话包含多个需求时，少漏识别',
    explanation: '把「复合句子句匹配弱」的题喂给 AI，重点让它练补充短句说法（A3），同时用补充说法（A1）兜住整句变体。',
    ops: ['A3_clause_expansion', 'A1_utterance_expand'],
    noImproveRounds: 4,
    caseNote: '题库里需要足够多「多意图」题（一句话两个需求），太少时 AI 找不到练习素材。',
    whereToLook: '效果看「多意图」题型的完全正确率：运行记录的趋势图按题型拆解，采纳后在评测结果页确认。',
  },
  {
    id: 'clarify_first',
    label: '模糊提问先反问澄清，不要瞎猜',
    explanation: '先检查澄清触发、候选范围与边界证据，再由模型设计图谱、识别指令或参数实验；A5只修改已触发的问题文案。',
    ops: [],
    noImproveRounds: 4,
    caseNote: '题库里需要「模糊提问」题，且期望答案是触发澄清；没有这类题时该目标无法被评测。',
    whereToLook: '效果看「模糊提问」题型的得分：正确反问且选项覆盖才计分，运行记录趋势图按题型拆解。',
  },
  {
    id: 'phrase_variants',
    label: '换个说法就认不出了',
    explanation: '重点补充说法（A1）和改写意图描述（A4），让图谱覆盖更多口语化表达；认错对象的题交给 A4 修描述。',
    ops: ['A1_utterance_expand', 'A4_description_rewrite'],
    noImproveRounds: 3,
    caseNote: '需要「单意图」题里有与图谱样例措辞明显不同的真实变体；题目太像样例时提升会虚高。',
    whereToLook: '效果看「单意图」题型（尤其是 hard 难度）的完全正确率：运行记录趋势图按题型拆解。',
  },
  {
    id: 'overall',
    label: '整体识别准确率提升',
    explanation: '不限定算子，让 AI 按错题归因自行选择改进方向；先评测当前版本找出错题，效果提升才可靠。',
    ops: [],
    noImproveRounds: 3,
    caseNote: '整体目标对题目构成没有额外要求，但覆盖的意图和题型越全，提升越可信。',
    whereToLook: '效果看「完全正确率」总分数：运行记录趋势图与评测结果页。',
  },
];

/** 应用模板：只覆盖模板能解释的字段，用户改过的其他字段不动 */
export function applyGoalTemplate(
  tpl: GoalTemplate,
  cfg: { noImproveRounds: number; ops?: string[] },
): { noImproveRounds: number; ops: string[] } {
  return { noImproveRounds: tpl.noImproveRounds, ops: [...tpl.ops] };
}

/** 模板 id → 对象（持久化恢复用；未知 id 返回 null 由调用方回退到不选） */
export function goalTemplateById(id: string | undefined | null): GoalTemplate | null {
  if (!id) return null;
  return GOAL_TEMPLATES.find(t => t.id === id) || null;
}
