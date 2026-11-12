/**
 * 图谱知识评测工具页共享元数据：与 AI Harbor intent-evaluator / test-case-library 的枚举文案对齐。
 */

export const RESULT_TYPE_META: Record<string, { label: string; color: string }> = {
  single_intent: { label: "单意图", color: "blue" },
  multi_intent_plan: { label: "多意图", color: "gold" },
  idle_chat: { label: "闲聊", color: "default" },
  fuzzy: { label: "模糊", color: "purple" },
  clarify: { label: "澄清", color: "purple" },
  multi_intent_turn: { label: "多意图轮", color: "purple" },
};

export const FAILURE_META: Record<string, { label: string; color: string; desc: string }> = {
  graph_wrong_boundary: { label: "图谱边界错误", color: "red", desc: "意图范围划错了——该归 A 的操作被归到了 B，两条意图的边界需要重新界定" },
  graph_wrong_object_ownership: { label: "图谱对象归属错误", color: "red", desc: "操作对象挂错了节点——比如「转账限额」本该属于「转账管理」却挂到了「账户管理」下" },
  graph_near_intent_confusion: { label: "图谱近义混淆", color: "orange", desc: "两个含义相近的意图互相串了——比如「查余额」被误认成「查明细」，需要补充区分性关键词" },
  graph_missing_alias: { label: "图谱别名缺失", color: "gold", desc: "用户的问法没被收录——图谱不认识这种说法，需要补录同义词/别名" },
  runtime_wrong_consumption_mode: { label: "引擎处理模式错误", color: "purple", desc: "引擎选错了处理方式——该直接执行的走了澄清，该澄清的却直接执行了" },
  clarification_misfire: { label: "澄清策略误触发", color: "gold", desc: "不该追问的却追问了——用户意图已明确，引擎仍要求二次确认" },
  multi_intent_split_failure: { label: "多意图拆分失败", color: "purple", desc: "一句话含多个需求，引擎没能正确拆分——比如「查余额再转账」被当成一个意图" },
  unknown_manual_review: { label: "待人工复核", color: "default", desc: "自动归因无法定位根因，需要人工排查具体原因" },
};

export const OWNER_META: Record<string, { label: string; color: string }> = {
  graph: { label: "图谱", color: "red" },
  runtime: { label: "引擎", color: "purple" },
  eval: { label: "评测", color: "cyan" },
};

export const SOURCE_META: Record<string, { label: string; color: string }> = {
  auto: { label: "自动", color: "blue" },
  manual: { label: "手动", color: "green" },
  batch_import: { label: "导入", color: "purple" },
};

export const ACTION_COLOR: Record<string, string> = {
  query: "blue", apply: "green", change: "gold", transfer: "purple", ask: "default",
  open: "green", cancel: "red", close: "red", guide: "cyan", repay: "gold",
};

export const TURN_TYPE_LABELS: Record<string, string> = {
  running: "识别中", new_intent: "新意图", same_intent_continue: "继续", context_followup: "上下文补充",
  slot_update: "补槽", slot_modify: "改槽", clarification_choice: "澄清选择", intent_drift: "意图漂移",
  intent_switch: "意图切换", intent_restart: "意图重启", intent_resume: "意图恢复", intent_forget: "意图遗忘",
  multi_intent_turn: "多意图", multi_task_turn: "多任务", idle_chat: "闲聊", no_match: "未命中",
  navigation: "页面导航", blocked: "风控拦截", unavailable: "能力不可用", unsupported: "暂不支持", planned: "已规划",
};

export const ENGINE_META: Record<string, { label: string; color: string }> = {
  bank: { label: "银行意图引擎", color: "gold" },
  v2: { label: "引擎 v2.1", color: "geekblue" },
};

export const INTENT_SHAPE_LABELS: Record<string, string> = {
  idle_chat: "闲聊/非业务输入", single_intent: "单意图", multi_intent: "多意图", ambiguous_intent: "模糊意图",
  business: "业务办理意图", faq: "问答意图", mixed: "问答+办理混合", multi_task: "多任务意图",
  multi_task_intent: "多任务意图", multi_task_same_intent: "同意图多任务", single_task: "单任务意图",
  context_state_update: "上下文状态更新",
};

export const BAR_COLORS = ["#1677ff", "#52c41a", "#722ed1", "#faad14", "#f5222d", "#13c2c2", "#eb2f96", "#fa8c16"];

export function turnTypeLabel(type?: string): string {
  if (!type) return "-";
  return TURN_TYPE_LABELS[type] || type;
}

export function shapeLabel(value?: string): string {
  if (!value) return "-";
  return INTENT_SHAPE_LABELS[value] || value;
}

// 决策模式枚举 → 通俗说明
export const DECISION_MODE_LABELS: Record<string, { label: string; desc: string }> = {
  llm_judge: { label: "AI 判断", desc: "由大模型裁决最终意图" },
  embedding_fusion: { label: "语义排序", desc: "由语义相似度排序选定（未走 AI 裁决）" },
  degraded_fusion: { label: "降级兜底", desc: "AI 判断异常，退回关键词+语义融合排序" },
  local_only: { label: "仅关键词", desc: "只靠关键词匹配（语义和 AI 均未参与）" },
};

// 召回来源枚举 → 通俗标签
export const SOURCE_LABELS: Record<string, string> = {
  local: "关键词匹配",
  embedding: "语义搜索",
  llm_judge: "AI 判断",
  subgraph: "子图推理",
};

export function decisionModeLabel(mode?: string): { label: string; desc: string } {
  if (!mode) return { label: "-", desc: "" };
  return DECISION_MODE_LABELS[mode] || { label: mode, desc: "" };
}

export function sourceLabel(src?: string): string {
  if (!src) return "-";
  return SOURCE_LABELS[src] || src;
}

export function formatMs(ms?: number): string {
  const n = Math.max(0, Number(ms) || 0);
  if (n >= 1000) return (n / 1000).toFixed(1) + "s";
  if (n > 0 && n < 1) return "<1ms";
  if (n > 0 && n < 10) return n.toFixed(1) + "ms";
  return `${Math.round(n)}ms`;
}

export function pct(v?: number | null): string {
  return v == null ? "-" : (Number(v) * 100).toFixed(2) + "%";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function displayName(item: any): string {
  return (item && (item.display_name || item.eval_label || item.object || item.intent_name)) || "";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function isAskRow(row: any): boolean {
  return !!row && (row.answer_mode === "faq" || row.runtime_action_code === "ask" || row.action_code === "ask");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function prettyJson(v: any): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
