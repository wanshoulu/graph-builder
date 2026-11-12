/**
 * 知识导入工作台共享常量与小组件（两段式状态语义的唯一定义处）
 */
import { Tag } from "antd";
import type { IntakeRowType } from "@/api/knowledgeIntake";

export const ROW_TYPE_LABEL: Record<IntakeRowType, string> = {
  functions: "业务功能",
  intents: "意图",
  utterances: "说法",
};

// 两段式状态语义：approved 只能由平台人工确认产生；Excel「已审核」与 LLM「建议」都不是确认
export const STATUS_META: Record<string, { label: string; color: string }> = {
  approved: { label: "已确认", color: "green" },
  pending: { label: "待确认", color: "orange" },
  rejected: { label: "已驳回", color: "red" },
};

export const INTENT_TYPE_COLOR: Record<string, string> = {
  查询: "blue",
  办理: "green",
  管理: "purple",
  咨询: "cyan",
  投诉: "red",
  营销: "orange",
};

export function statusTag(status: string) {
  const meta = STATUS_META[status] || { label: status, color: "default" };
  return <Tag color={meta.color}>{meta.label}</Tag>;
}

export const ASSIST_KIND_META: Record<string, { label: string; color: string; hint: string }> = {
  gaps: { label: "查漏建议", color: "blue", hint: "骨架里缺的意图/子域，AI 建议补上" },
  duplicates: { label: "疑似重复", color: "purple", hint: "名称/语义相近的意图，AI 建议合并去重" },
  naming: { label: "命名规范", color: "cyan", hint: "不是动宾短语/含黑话的命名，AI 建议改名" },
  ambiguities: { label: "歧义风险", color: "orange", hint: "边界含混的意图对，需人工划清排除边界" },
};

export const ASSIST_STATUS_META: Record<string, { label: string; color: string }> = {
  suggested: { label: "建议中", color: "blue" },
  accepted: { label: "已采纳", color: "green" },
  dismissed: { label: "已忽略", color: "default" },
};

export const ISSUE_LEVEL_COLOR: Record<string, string> = { error: "red", warn: "orange", info: "blue" };
export const ISSUE_LEVEL_LABEL: Record<string, string> = { error: "严重", warn: "提醒", info: "建议" };

// ── 修订审阅（Word track changes 式）：颜色与文案的唯一定义处 ──

export const REVISION_TYPE_META: Record<string, { label: string; color: string }> = {
  "utterance-expansion": { label: "AI 补全", color: "green" },
  "row-edit": { label: "人工编辑", color: "blue" },
  "assist-apply": { label: "骨架助手", color: "purple" },
};

/** 修订 change 的字段 key → 中文 label（row-edit 审计展示用；与 detail-fields.ts 口径一致） */
export const REVISION_FIELD_LABEL: Record<string, string> = {
  // ── 功能行 ──
  path: "功能路径",
  name: "名称",
  description: "业务描述",
  clientClass: "客户分类",
  securityLevel: "安全分级",
  department: "责任部门",
  domain: "业务域",
  menuKey: "菜单键",
  // ── 意图行 ──
  funcPath: "所属功能全路径",
  ref: "意图标识",
  intentType: "意图类型",
  goal: "用户目标",
  action: "动作类型",
  sourceAction: "来源动作",
  businessObjects: "涉及业务对象",
  businessObjectId: "业务对象标识",
  keySlots: "关键要素",
  triggerScene: "触发场景",
  scopeIn: "范围边界-包含",
  scopeOut: "范围边界-排除",
  roles: "涉及角色",
  confusableIntents: "易混意图",
  answerForm: "答案形态",
  heat: "热度",
  aliases: "别名列表",
  recallTerms: "召回关键词",
  recallTermSets: "多词组合",
  negativeExamples: "排除说法",
  disambiguationHints: "消歧提示",
  semanticPriority: "优先级权重",
  executionMode: "执行模式",
  riskLevel: "风险等级",
  readiness: "就绪状态",
  requiredSlots: "必需参数",
  capabilityBindings: "系统能力绑定",
  taskPolicyShapes: "结果展示形式",
  taskPolicyMode: "任务模式",
  taskPolicyMaxTasks: "最大任务数",
  contextPolicyRetain: "追问保留上下文",
  contextPolicySwitch: "允许中途切换",
  contextPolicyResumable: "中断后可恢复",
  responsePolicy: "响应策略",
  orchestrationMode: "编排模式",
  lifecycle: "生命周期",
  semanticVersion: "语义版本",
  owner: "负责团队",
  sourceChannel: "来源渠道",
  sourceMenuId: "来源菜单ID",
  sourceActionId: "来源动作ID",
  code: "意图编码",
  // ── 说法行 ──
  intentRef: "所属意图",
  kind: "说法类型",
  text: "说法文本",
  source: "来源",
  confidence: "置信度",
  status: "业务状态",
  reviewNote: "审核意见",
  note: "备注",
};

export function scoreColor(score: number) {
  return score >= 90 ? "#52c41a" : score >= 70 ? "#faad14" : "#ff4d4f";
}

// ── 在线编辑的枚举镜像（与 routes/knowledge-intake.js 校验枚举一一对应，改这里必须同步服务端） ──

export const CLIENT_CLASS_VALUES = ["个人客户", "对公客户", "小微客户", "不区分"];
export const SECURITY_LEVEL_VALUES = ["L1-公开", "L2-内部", "L3-敏感", "L4-机密"];
export const FUNC_STATUS_VALUES = ["启用", "停用"];
export const INTENT_TYPE_VALUES = ["查询", "办理", "管理", "咨询", "投诉", "营销"];
export const ANSWER_FORM_VALUES = ["话术答复", "数据卡片", "跳转办理", "转人工"];
export const HEAT_VALUES = ["P0-高频", "P1-中频", "P2-低频"];
export const INTENT_STATUS_VALUES = ["草稿", "生效", "停用"];
export const UTTER_KIND_VALUES = ["标问", "扩展问"];
export const UTTER_SOURCE_VALUES = ["人工编写", "存量导入", "客服挖掘", "LLM生成"];
export const UTTER_STATUS_VALUES = ["已审核", "候选", "驳回"];

// ── 意图图谱架构 schema 对齐枚举（与 routes/knowledge-intake.js 同步） ──

// 业务域（menu 节点 domain 字段）
export const DOMAIN_VALUES = [
  "首页", "账户管理", "转账服务", "支付管理", "信用卡",
  "贷款服务", "财富管理", "网点服务", "权益服务", "民生服务",
  "生活服务", "金融助手", "客户专享", "企业服务",
];

// 动作类型（intent 节点 action 字段，对应图谱 action 枚举）
export const ACTION_VALUES = ["QUERY-查询", "DO-执行", "CHANGE-变更", "HELP-帮助"];

// 来源动作（intent 节点 sourceAction 字段）
export const SOURCE_ACTION_VALUES = ["QUERY-查询", "CREATE-创建", "UPDATE-更新", "APPLY-申请", "EXPLAIN-说明"];

// 执行模式（intent 节点 executionMode 字段，全链路 6 值，与主项目 web/ 对齐 2026-10-03）
export const EXECUTION_MODE_VALUES = [
  "read-execute-读执行", "confirm-required-确认后执行", "navigation-only-仅导航", "knowledge-only-知识应答", "unavailable-不可用", "multi_intent-多意图",
];

// 风险等级（intent 节点 riskLevel 字段，贯穿意图→能力→Provider 安全分级）
export const RISK_LEVEL_VALUES = ["L0-无风险", "L1-低风险", "L2-中风险", "L3-高风险"];

// 就绪状态（intent 节点 readiness 字段，控制意图是否可执行）
export const READINESS_VALUES = ["ready-就绪", "mock-only-模拟", "planned-规划中"];

// 生命周期（intent 节点 lifecycle 字段）
export const LIFECYCLE_VALUES = ["active-活跃", "planned-规划中", "deprecated-已废弃", "retired-已下线"];

// 编排模式（intent 节点 orchestrationMode 字段）
export const ORCHESTRATION_MODE_VALUES = ["deterministic-确定式", "agent-智能体"];

// 布尔值（contextPolicy 相关字段使用）
export const BOOLEAN_VALUES = ["true-是", "false-否"];

// 任务模式（taskPolicy.mode 字段）
export const TASK_MODE_VALUES = ["single-单意图", "multi-多意图", "batch-批量"];

export const toOptions = (values: string[]) => values.map((v) => ({ value: v, label: v }));
