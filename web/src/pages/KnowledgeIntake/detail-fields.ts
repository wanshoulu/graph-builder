/**
 * 审核详情分组字段配置（纯数据，无 React）
 * 字段名/标签/校验规则与 DetailDrawer 表单一一对应；业务状态字段展示 sourceStatus（业务口径），平台状态另有徽标
 *
 * 字段来源对齐三份架构文档：
 * - docs/ai-native-bank/intent-graph-architecture-and-schema.md（运行时图谱 v2.1，22必填+8可选）
 * - docs/ai-native-bank/intent-graph-build-process-and-input-form.md（业务输入表41列A-AP）
 * - docs/intent-graph-v2.1-schema.md（评测治理图 schema）
 */
import type { Rule } from "antd/es/form";
import type { IntakeRowInput, IntakeRowType } from "@/api/knowledgeIntake";
import {
  ACTION_VALUES,
  ANSWER_FORM_VALUES,
  BOOLEAN_VALUES,
  CLIENT_CLASS_VALUES,
  DOMAIN_VALUES,
  EXECUTION_MODE_VALUES,
  FUNC_STATUS_VALUES,
  HEAT_VALUES,
  INTENT_STATUS_VALUES,
  INTENT_TYPE_VALUES,
  LIFECYCLE_VALUES,
  ORCHESTRATION_MODE_VALUES,
  READINESS_VALUES,
  RISK_LEVEL_VALUES,
  SECURITY_LEVEL_VALUES,
  SOURCE_ACTION_VALUES,
  TASK_MODE_VALUES,
  UTTER_KIND_VALUES,
  UTTER_SOURCE_VALUES,
  UTTER_STATUS_VALUES,
} from "./constants";

/** 在线新建行的默认值（平台状态固定 pending，两段式；业务状态给默认口径） */
export const CREATE_DRAFT_DEFAULTS: Record<IntakeRowType, IntakeRowInput> = {
  functions: {
    path: "", name: "", description: "", domain: "首页", menuKey: "",
    clientClass: "个人客户", securityLevel: "L2-内部", department: "",
    status: "启用", note: "",
  },
  intents: {
    // 基本定义
    name: "", ref: "", funcPath: "", domain: "首页", menuKey: "",
    action: "QUERY-查询", sourceAction: "QUERY-查询", intentType: "查询",
    description: "", goal: "",
    // 召回素材
    aliases: "", recallTerms: "", recallTermSets: "", negativeExamples: "", semanticPriority: 0,
    // 触发条件
    triggerScene: "",
    // 服务边界
    scopeIn: "", scopeOut: "", confusableIntents: "", disambiguationHints: "",
    // 执行契约
    executionMode: "read-execute-读执行", riskLevel: "L1-低风险", readiness: "ready-就绪",
    requiredSlots: "", capabilityBindings: "",
    businessObjects: "", businessObjectId: "", keySlots: "",
    answerForm: "话术答复", heat: "P1-中频",
    // 策略配置
    taskPolicyShapes: "", taskPolicyMode: "single-单意图", taskPolicyMaxTasks: 1,
    contextPolicyRetain: "true-是", contextPolicySwitch: "true-是", contextPolicyResumable: "true-是",
    responsePolicy: "", orchestrationMode: "deterministic-确定式",
    // 治理信息
    status: "生效", lifecycle: "active-活跃", semanticVersion: "", owner: "",
    sourceChannel: "", sourceMenuId: "", sourceActionId: "",
    code: "", note: "",
  },
  utterances: {
    intentRef: "", kind: "标问", text: "", source: "人工编写",
    confidence: "", status: "候选", reviewNote: "", note: "",
  },
};

export interface FieldDef {
  key: string;
  /** 只读展示取值键（编辑仍写 key）；业务状态编辑键为 status、业务口径值为 sourceStatus */
  readKey?: string;
  label: string;
  control?: "input" | "textarea" | "select" | "number";
  options?: string[];
  rules?: Rule[];
  extra?: string;
}

export interface FieldGroup {
  key: string;
  title: string;
  fields: FieldDef[];
}

const required = (msg: string): Rule[] => [{ required: true, message: msg }];
const descRules: Rule[] = [{ min: 10, message: "至少 10 字，按三段式写全" }];

// ══════════════════════════════════════════════════════════════
// 功能（functions）→ 图谱 menu 节点
// ══════════════════════════════════════════════════════════════

export const FUNC_GROUPS: FieldGroup[] = [
  {
    key: "base",
    title: "基本定义",
    fields: [
      { key: "name", label: "功能名称", rules: required("功能名称必填（需与路径末段一致）") },
      { key: "path", label: "功能全路径", rules: required("功能全路径必填") },
      { key: "description", label: "业务描述", control: "textarea", rules: descRules },
      { key: "domain", label: "业务域", control: "select", options: DOMAIN_VALUES, extra: "该功能所属的业务大类，如财富管理、账户管理" },
      { key: "menuKey", label: "菜单键", extra: "系统定位菜单页面的标识，格式如 account.balance" },
    ],
  },
  {
    key: "scope",
    title: "层级与范围",
    fields: [
      { key: "clientClass", label: "客户分类", control: "select", options: CLIENT_CLASS_VALUES },
      { key: "securityLevel", label: "安全分级", control: "select", options: SECURITY_LEVEL_VALUES, extra: "信息密级分级（L1-L4），与意图的风险等级是不同维度" },
      { key: "department", label: "责任部门", rules: required("责任部门必填") },
    ],
  },
  {
    key: "gov",
    title: "治理信息",
    fields: [
      { key: "status", readKey: "sourceStatus", label: "业务状态", control: "select", options: FUNC_STATUS_VALUES, extra: "业务侧的启用/停用状态，不等于平台确认" },
      { key: "note", label: "备注" },
    ],
  },
];

// ══════════════════════════════════════════════════════════════
// 意图（intents）→ 图谱 intent 节点
// 对齐架构文档 22 必填 + 8 可选，覆盖召回/执行/安全/治理全链路
// ══════════════════════════════════════════════════════════════

export const INTENT_GROUPS: FieldGroup[] = [
  // ── 1. 基本定义：意图身份与业务语义 ──
  {
    key: "base",
    title: "基本定义",
    fields: [
      { key: "name", label: "意图名称", rules: required("意图名称必填") },
      { key: "ref", label: "意图标识", extra: "意图的唯一编码，如 account.query_balance。留空时系统自动按路径和名称生成" },
      { key: "funcPath", label: "所属功能全路径", rules: required("所属功能必填（需已登记）") },
      { key: "domain", label: "业务域", control: "select", options: DOMAIN_VALUES, extra: "该意图所属的业务大类，如财富管理。系统按此匹配用户当前所在页面" },
      { key: "menuKey", label: "所属菜单键", extra: "所属菜单的标识，格式如 account.balance。系统通过此值定位用户所在页面" },
      { key: "action", label: "动作类型", control: "select", options: ACTION_VALUES, extra: "该意图的动作类型：查询选QUERY、执行选DO、变更选CHANGE、帮助选HELP" },
      { key: "sourceAction", label: "来源动作", control: "select", options: SOURCE_ACTION_VALUES, extra: "该意图的来源动作类型：查询选QUERY、创建选CREATE、更新选UPDATE、申请选APPLY、说明选EXPLAIN" },
      { key: "intentType", label: "业务意图类型", control: "select", options: INTENT_TYPE_VALUES, extra: "业务侧的意图分类口径" },
      { key: "description", label: "业务描述", control: "textarea", rules: descRules },
      { key: "goal", label: "用户目标", control: "textarea", extra: "用户想达到的目的，如「用户想知道账户当前可用余额」。留空时系统用业务描述代替" },
    ],
  },
  // ── 2. 召回素材：决定用户说什么能匹配到该意图 ──
  {
    key: "recall",
    title: "召回素材",
    fields: [
      { key: "aliases", label: "别名列表", control: "textarea", extra: "用户可能说的各种说法，逗号分隔，至少3个。如「查余额,余额多少,还剩多少钱」。越多越容易匹配到用户表达" },
      { key: "recallTerms", label: "召回关键词", control: "textarea", extra: "单个关键词，逗号分隔。如「余额,查询,还剩」。与别名互补，适合更短的表达" },
      { key: "recallTermSets", label: "多词组合", control: "textarea", extra: "多个词的组合，分号分隔组，组内逗号分隔词。如「余额,查询;余额,多少」。当用户同时说出多个词时优先匹配" },
      { key: "negativeExamples", label: "排除说法", control: "textarea", extra: "不应匹配到该意图的说法，逗号分隔。如「信用卡余额」（如果该意图只处理储蓄卡）。填了能减少误匹配" },
      { key: "semanticPriority", label: "优先级权重", control: "number", extra: "0-100的数字，值越大越优先。当多个意图都能匹配时，优先级高的排前面" },
    ],
  },
  // ── 3. 触发条件 ──
  {
    key: "trigger",
    title: "触发条件",
    fields: [
      { key: "triggerScene", label: "触发场景", control: "textarea", extra: "描述意图在什么场景下被触发，如「用户进入转账页面时」" },
    ],
  },
  // ── 4. 服务边界：意图范围与消歧 ──
  {
    key: "boundary",
    title: "服务边界",
    fields: [
      { key: "scopeIn", label: "范围边界-包含", control: "textarea", extra: "明确该意图覆盖的范围，如「本行卡之间转账」" },
      { key: "scopeOut", label: "范围边界-排除", control: "textarea", extra: "明确该意图不覆盖的范围，如「跨行转账（走超级网银）」" },
      { key: "confusableIntents", label: "易混意图", control: "textarea", extra: "容易混淆的其他意图名称，分号分隔。如「查询转账限额；查询转账记录」" },
      { key: "disambiguationHints", label: "消歧提示", control: "textarea", extra: "帮助系统区分相似意图的补充说明。如「余额查询指储蓄卡余额，不含信用卡可用额度」" },
    ],
  },
  // ── 5. 执行契约：执行路径、风险、槽位、能力绑定 ──
  {
    key: "contract",
    title: "执行契约",
    fields: [
      { key: "executionMode", label: "执行模式", control: "select", options: EXECUTION_MODE_VALUES, extra: "该意图的执行方式：读执行=直接返回结果，确认后执行=需用户确认才操作，仅导航=只跳转页面，知识应答=返回知识内容，不可用=暂不支持" },
      { key: "riskLevel", label: "风险等级", control: "select", options: RISK_LEVEL_VALUES, extra: "涉及资金操作应选L2以上，纯查询通常L0或L1" },
      { key: "readiness", label: "就绪状态", control: "select", options: READINESS_VALUES, extra: "控制该意图是否可执行：就绪=可执行，模拟=用假数据回复，规划中=暂不执行" },
      { key: "requiredSlots", label: "必需参数", control: "textarea", extra: "执行该意图必须收集的信息，逗号分隔。如「amount,accountNo」表示必须收集转账金额和收款账号" },
      { key: "capabilityBindings", label: "系统能力绑定", control: "textarea", extra: "对接的系统功能标识，逗号分隔。如「account.query_balance_v2」。填了才能实际调用系统执行" },
      { key: "businessObjects", label: "涉及业务对象", extra: "该意图涉及的业务对象，逗号分隔。如「账户,转账,银行卡」" },
      { key: "businessObjectId", label: "业务对象标识", extra: "与上面业务对象一一对应的编码，逗号分隔。如「account.account,transfer.transfer」" },
      { key: "keySlots", label: "关键要素", control: "textarea", extra: "该意图的关键信息要素，用业务语言描述。如「转账金额、收款人、收款账号」" },
      { key: "answerForm", label: "答案形态", control: "select", options: ANSWER_FORM_VALUES, extra: "回复用户的形式：话术答复=文字回复，数据卡片=结构化展示，跳转办理=跳转到操作页，转人工=交给客服" },
      { key: "heat", label: "热度", control: "select", options: HEAT_VALUES },
    ],
  },
  // ── 6. 策略配置：任务规划、上下文、编排 ──
  {
    key: "strategy",
    title: "策略配置",
    fields: [
      { key: "taskPolicyShapes", label: "结果展示形式", extra: "执行结果的展示形式，逗号分隔。如「query_result,card_list」表示查询结果和卡片列表" },
      { key: "taskPolicyMode", label: "任务模式", control: "select", options: TASK_MODE_VALUES, extra: "单次能处理的意图数：单意图=一次一个，多意图=可同时处理多个，批量=批量处理" },
      { key: "taskPolicyMaxTasks", label: "最大任务数", control: "number", extra: "单次最多处理的任务数，通常1-5" },
      { key: "contextPolicyRetain", label: "追问保留上下文", control: "select", options: BOOLEAN_VALUES, extra: "用户追问时是否保留之前的对话上下文。选「是」能理解「那他呢」这类追问" },
      { key: "contextPolicySwitch", label: "允许中途切换", control: "select", options: BOOLEAN_VALUES, extra: "执行过程中是否允许用户切换到另一个意图" },
      { key: "contextPolicyResumable", label: "中断后可恢复", control: "select", options: BOOLEAN_VALUES, extra: "中断后是否可以恢复之前的操作" },
      { key: "responsePolicy", label: "响应策略", extra: "回复策略，如「query_result」返回查询结果，「menu_redirect」跳转菜单" },
      { key: "orchestrationMode", label: "编排模式", control: "select", options: ORCHESTRATION_MODE_VALUES, extra: "确定式=按固定流程执行，智能体=由AI自主决策执行路径" },
    ],
  },
  // ── 7. 治理信息：生命周期、版本、来源 ──
  {
    key: "gov",
    title: "治理信息",
    fields: [
      { key: "status", readKey: "sourceStatus", label: "业务状态", control: "select", options: INTENT_STATUS_VALUES, extra: "业务侧的审核状态（草稿/生效/停用），不等于平台确认" },
      { key: "lifecycle", label: "生命周期", control: "select", options: LIFECYCLE_VALUES, extra: "该意图的当前阶段：活跃=正常使用，规划中=计划但未实现，已废弃=不再使用，已下线=完全停用" },
      { key: "semanticVersion", label: "语义版本", extra: "版本号，如1.0.0。用于追踪变更" },
      { key: "owner", label: "负责团队", extra: "负责维护该意图的团队，如「手机银行团队」" },
      { key: "sourceChannel", label: "来源渠道", extra: "该意图的来源渠道，如「手机银行/微信/小程序」" },
      { key: "sourceMenuId", label: "来源菜单ID", extra: "来源菜单的标识" },
      { key: "sourceActionId", label: "来源动作ID", extra: "来源动作的标识" },
      { key: "code", label: "意图编码", extra: "业务侧编码（选填）" },
      { key: "note", label: "备注" },
    ],
  },
];

// ══════════════════════════════════════════════════════════════
// 说法（utterances）→ 图谱 intent 节点 aliases/recallTerms 来源
// ══════════════════════════════════════════════════════════════

export const UTTER_GROUPS: FieldGroup[] = [
  {
    key: "content",
    title: "说法内容",
    fields: [
      { key: "text", label: "说法文本", rules: [{ required: true, message: "说法文本必填" }, { min: 2, max: 50, message: "长度需在 2~50 字之间" }] },
      { key: "kind", label: "说法类型", control: "select", options: UTTER_KIND_VALUES, extra: "标问=作为精确匹配素材，扩展问=补充更多表达帮助召回" },
      { key: "note", label: "备注" },
    ],
  },
  {
    key: "intent",
    title: "归属意图",
    fields: [
      { key: "intentRef", label: "意图标识", rules: required("意图标识必填（需已登记）") },
    ],
  },
  {
    key: "origin",
    title: "来源与置信度",
    fields: [
      { key: "source", label: "来源", control: "select", options: UTTER_SOURCE_VALUES },
      { key: "confidence", label: "置信度", control: "number", extra: "0-1的数字，表示这条说法的可靠程度，仅作参考" },
    ],
  },
  {
    key: "review",
    title: "审核信息",
    fields: [
      { key: "status", readKey: "sourceStatus", label: "业务状态", control: "select", options: UTTER_STATUS_VALUES, extra: "业务侧审核状态（已审核/候选/驳回），不等于平台确认" },
      { key: "reviewNote", label: "审核意见", extra: "业务状态为「驳回」时必填" },
    ],
  },
];
