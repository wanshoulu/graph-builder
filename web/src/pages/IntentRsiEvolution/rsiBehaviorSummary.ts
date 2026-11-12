/**
 * 方案审阅行为变化摘要（codex 2026-10-18 复审 P1③）：
 * 审阅决策的第一眼不是参数 diff / hash / 评分协议，而是具体行为变化——
 * 「原来漏掉哪个需求、现在识别到了什么」「原来直接猜测、现在反问澄清」「新引入了哪些误识别」。
 * 数据全部来自 candidate-diff 已保存的父子逐题证据；历史方案缺逐题轨迹时明确标证据不足，不补写。
 */
import type { CandidateDiff } from './rsiCandidateEvidence';

export type BehaviorChange = {
  kind: 'fixed' | 'clarified' | 'regressed' | 'broken';
  /** 人话标题：讲清"原来怎样 → 现在怎样" */
  title: string;
  query: string;
  caseId: string;
};

export interface BehaviorSummary {
  changes: BehaviorChange[];
  /** 证据是否足以支撑审阅（false 时 UI 明示"证据不足"而不是装作没问题） */
  sufficient: boolean;
  /** 为什么证据不足（原文展示，不补写改善案例） */
  insufficientReason?: string;
  /** 统计：改善/回退/无变化，与逐题表格一致 */
  counts: { improved: number; regressed: number; unchanged: number; unmeasured: number };
}

const SHAPE_LABEL: Record<string, string> = {
  single_intent: '单意图',
  multi_intent: '多意图',
  ambiguous_intent: '模糊提问',
  negative_intent: '反例',
};

export function behaviorSummary(diff: CandidateDiff): BehaviorSummary {
  const counts = { improved: 0, regressed: 0, unchanged: 0, unmeasured: 0 };
  const changes: BehaviorChange[] = [];
  for (const c of diff.caseChanges || []) {
    counts[c.change === 'improved' ? 'improved' : c.change === 'regressed' ? 'regressed' : c.change === 'unmeasured' ? 'unmeasured' : 'unchanged']++;
  }
  // 行为例卡只挑有完整父子判分记录的题；before/after 缺失的一律归入"证据不足"叙述
  for (const c of diff.caseChanges || []) {
    const shape = SHAPE_LABEL[c.shape || ''] || '';
    if (c.change === 'improved' && c.before && c.after) {
      // 多意图题的"漏掉需求"与模糊题的"开始澄清"给不同叙述
      if (c.shape === 'ambiguous_intent' && c.after.resultType) {
        changes.push({ kind: 'clarified', caseId: c.case_id, query: c.query, title: `模糊提问（${shape}）：原来${c.before.strict ? '给出答案' : '没正确澄清'}，现在${c.after.resultType === 'clarify' ? '按预期反问澄清' : `识别为${c.after.resultType}`}` });
      } else {
        changes.push({ kind: 'fixed', caseId: c.case_id, query: c.query, title: `${shape || '题目'}：原来判错${c.before.resultType ? `（${c.before.resultType}）` : ''}，现在识别正确` });
      }
    } else if (c.change === 'regressed' && c.before && c.after) {
      changes.push({ kind: 'regressed', caseId: c.case_id, query: c.query, title: `${shape || '题目'}：原来识别正确，现在判错${c.after.resultType ? `（${c.after.resultType}）` : ''}——采纳前需要权衡` });
    }
  }
  // 证据充分性：有逐题变化且至少一半题目有父代记录，才算可审阅
  const total = diff.caseChanges?.length ?? 0;
  const measurable = counts.improved + counts.regressed + counts.unchanged;
  let sufficient = total > 0 && measurable >= Math.ceil(total / 2);
  let insufficientReason: string | undefined;
  if (!total) {
    sufficient = false;
    insufficientReason = '该方案没有保存逐题评测轨迹（旧档案常见）。分数仍可参考，但无法展示具体哪道题变了——不要把它当作有行为证据的改善。';
  } else if (!sufficient) {
    insufficientReason = `逐题证据不完整：${total} 道题里只有 ${measurable} 道有完整的改前/改后记录（父代记录缺失）。以下变化仅为可确认部分，不能代表方案整体效果。`;
  }
  return { changes, sufficient, insufficientReason, counts };
}

/** 行为例卡最多展示几条（多出的进折叠），避免展开行过长 */
export const BEHAVIOR_EXAMPLES_LIMIT = 4;
