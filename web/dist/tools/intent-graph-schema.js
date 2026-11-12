/**
 * 意图图谱统一 Schema 模块 —— 全链路唯一 schema 权威
 *
 * 背景：历史上 editor/autobuild/evaluator-v2 各自复制一份 schema 常量（小写类型，
 * 对齐 data/graphs/intent-graph-v2-schema.json），而 builder 链路使用模板
 * data/graph-builder-templates/template.intent.v2.json（大写类型）。三份复制 + 一份模板
 * 导致漂移风险（模板曾缺 4 种执行边）。
 *
 * 本模块收敛：
 *   1. v2.1 七段格式的全部 schema 常量（单一来源，editor/autobuild/evaluator 复用）
 *   2. 大写（X6 模板）↔ 小写（v2.1）节点类型双向映射
 *   3. 模板 ↔ 常量一致性校验（检测漂移，供 CI/巡检调用）
 *
 * 模板版本要求：template.intent.v2.json >= 1.5.0（补齐 V4.1 结构化字段后，
 * INTENT 节点 67 字段、8 种 intent_type、property_sections 含 V4.1 阶段分组）。
 */

'use strict';

var path = require('path');

// ── v2.1 七段格式 schema 常量（对齐 data/graphs/intent-graph-v2-schema.json）──
// 注意：数组被 editor/autobuild/evaluator 共享引用，约定只读，不得原地修改。

var INTENT_TYPES = ['ASK', 'QUERY', 'DO', 'CHANGE', 'CANCEL', 'HELP', 'TRANSFER', 'REPAY'];
var INTENT_LEVELS = ['leaf', 'aggregate'];
var DOMAINS = [
  '财富管理', '企业服务', '信用卡', '权益服务', '客户专享', '支付管理',
  '民生服务', '账户管理', '生活服务', '网点服务', '贷款服务', '转账服务', '金融助手',
];
var NODE_TYPES = [
  'intent_node', 'aggregate_intent', 'business_object', 'action', 'slot',
  'state_constraint', 'risk', 'knowledge_answer', 'runtime_boundary',
];
var EDGE_TYPES = [
  'has_leaf_intent', 'is_child_of', 'same_as', 'related_to', 'attribute_of', 'setting_of',
  'has_business_object', 'acts_on_object', 'uses_action',
  'requires_slot', 'optional_slot', 'has_state_constraint', 'has_risk_constraint',
  'has_knowledge_answer', 'references',
  'binds_to_workflow', 'binds_to_api', 'binds_to_agent', 'has_navigation_path',
  'clarify_to', 'confusable_with',
];
var ACTION_CODES = ['ask', 'query', 'apply', 'open', 'close', 'change', 'cancel', 'transfer', 'repay', 'guide'];

// ── V4.1 新增 schema 常量（对齐 docs/ai-native-bank/intent-graph-schema-v4.md §8）──

var SCHEMA_VERSION = '4.1';
var SCENE_TYPES = INTENT_TYPES; // V4.1 §8.2：场景类型与 intent_type 同源（8 种）
var EXECUTION_MODES = ['read-execute', 'confirm-required', 'knowledge-only', 'multi_intent', 'navigation-only', 'unavailable'];
var RISK_LEVELS = ['L0', 'L1', 'L2', 'L3'];
var LIFECYCLE_STATES = ['active', 'inactive', 'planned', 'deprecated', 'retired'];
var READINESS_STATES = ['ready', 'mock-only', 'planned'];
var ORCHESTRATION_HINTS = ['single', 'parallel-safe', 'sequential'];
var ORCHESTRATION_MODES = ['single', 'parallel', 'sequential'];
var SUPPORTED_SHAPES = ['single_intent', 'multi_intent', 'parallel'];
var ANSWER_TYPES = ['faq', 'rag'];
var ANSWER_POLICIES = ['direct_answer_or_recommend_entry', 'single_best'];
var NODE_ROLES = ['root', 'domain', 'category', 'leaf'];
var FULFILLMENT_KINDS = ['unconfigured', 'answer', 'query', 'menu', 'skill', 'workflow', 'agent'];
// V4.1 资源注册表常量（§10；builder v4 资产校验器消费）
var NODE_ROLE_BY_TYPE = { ROOT: 'root', DOMAIN: 'domain', CATEGORY: 'category', LEAF: 'leaf' };
var CAPABILITY_KINDS = ['mcp-tool', 'skill', 'workflow', 'agent', 'menu-nav'];

// V4.1 §8 节点必需字段（在 V2 identity/semantic 基础上扩展）
var V41_REQUIRED_FIELDS = [
  'lifecycle',                    // §8.1 节点生命周期
  'scenes',                       // §8.3 场景数组（叶子节点必须，至少 1 个场景）
];

// V4.1 场景块必需字段（每个 scene 对象）
var V41_REQUIRED_SCENE_FIELDS = [
  'intentType',                   // §8.4 场景类型
  'userGoal',                     // §8.4 用户目标
];

// V4.1 → V2 字段映射表（对齐 §12.4 IntentCandidate 适配器接口契约）
// key = V4.1 嵌套块字段路径，value = V2 扁平字段名
var V4_TO_V2_FIELD_MAP = {
  // identity
  'identity.intentId':              'intent_id',
  'identity.intentName':            'intent_name',
  'identity.intentType':            'intent_type',
  'identity.intentLevel':           'intent_level',
  'identity.parentIntentId':        'parent_intent_id',
  'identity.domain':                'domain',
  'identity.isExecutableLeaf':      'is_executable_leaf',
  'identity.isKnowledgeIntent':     'is_knowledge_intent',
  // semantic_definition
  'semantic_definition.userGoal':              'user_goal',
  'semantic_definition.description':           'description',
  'semantic_definition.scopeIn':               'scope_in',
  'semantic_definition.scopeOut':              'scope_out',
  'semantic_definition.confusableIntents':     'confusable_intents',
  'semantic_definition.disambiguationHints':   'disambiguation_hints',
  // retrieval_profile
  'retrieval_profile.aliases':                 'recall_terms',
  'retrieval_profile.recallTerms':             'recall_terms',
  'retrieval_profile.recallTermSets':          'recall_term_sets',
  'retrieval_profile.negativeExamples':        'negative_examples',
  'retrieval_profile.semanticView':            'semantic_view',
  'retrieval_profile.semanticPriority':        'semantic_priority',
  // task_binding
  'task_binding.actionCode':                   'action_code',
  'task_binding.skillBinding':                 'skill_binding',
  'task_binding.stateConstraints':             'state_constraints',
  'task_binding.riskConstraints':              'risk_constraints',
  'task_binding.executionPrecondition':        'execution_precondition',
  // knowledge_binding
  'knowledge_binding.answerType':              'answer_type',
  'knowledge_binding.answerPolicy':            'answer_policy',
  // decision_policy
  'decision_policy.supportedShapes':           'supported_shapes',
  'decision_policy.orchestrationHint':         'orchestration_hint',
  'decision_policy.contextPolicy':             'context_policy',
  // execution_binding
  'execution_binding.executionMode':           'execution_mode',
  'execution_binding.routeType':               'execution_mode',
  'execution_binding.apiOrWorkflowId':         'api_or_workflow_id',
  'execution_binding.altNavigationPaths':      'alt_navigation_paths',
  'execution_binding.readiness':               'readiness',
  'execution_binding.requiresConfirmation':    'requires_confirmation',
  'execution_binding.riskLevel':               'risk_level',
  'execution_binding.orchestrationMode':       'orchestration_mode',
  'execution_binding.fulfillmentKind':         'fulfillment_kind',
  // observability
  'observability.metrics':                     'observability',
};

var REQUIRED_IDENTITY = [
  'intent_id', 'intent_name', 'intent_type', 'intent_level', 'parent_intent_id', 'domain',
  'is_executable_leaf', 'is_knowledge_intent',
];
var REQUIRED_SEMANTIC = ['user_goal', 'description', 'scope_in', 'scope_out'];

// ── 边类型定义（含类别与描述，供 evaluator-v2 运行时巡检/展示消费）──

var SCHEMA_EDGE_DEFINITIONS = {
  has_leaf_intent: { category: 'hierarchy', description: '聚合意图包含叶子意图。' },
  is_child_of: { category: 'hierarchy', description: '子节点属于父节点。' },
  same_as: { category: 'hierarchy', description: '人工确认的等价关系。' },
  related_to: { category: 'hierarchy', description: '弱相关关系。' },
  attribute_of: { category: 'hierarchy', description: '属性归属关系。' },
  setting_of: { category: 'hierarchy', description: '设置项归属关系。' },
  has_business_object: { category: 'semantic', description: '聚合意图关联业务对象。' },
  acts_on_object: { category: 'semantic', description: '意图作用于业务对象。' },
  uses_action: { category: 'semantic', description: '意图使用业务动作。' },
  requires_slot: { category: 'constraint', description: '意图执行必须具备的槽位。' },
  optional_slot: { category: 'constraint', description: '意图执行可选槽位。' },
  has_state_constraint: { category: 'constraint', description: '意图受状态约束。' },
  has_risk_constraint: { category: 'constraint', description: '意图可能触发风险控制。' },
  has_knowledge_answer: { category: 'knowledge', description: '问答意图关联知识答案。' },
  references: { category: 'knowledge', description: '知识答案引用业务对象或意图。' },
  binds_to_workflow: { category: 'execution', description: '意图绑定工作流。' },
  binds_to_api: { category: 'execution', description: '意图绑定 API。' },
  binds_to_agent: { category: 'execution', description: '意图绑定 Agent。' },
  has_navigation_path: { category: 'execution', description: '意图绑定菜单或页面路径。' },
  clarify_to: { category: 'clarification', description: '聚合意图可澄清到叶子意图。' },
  confusable_with: { category: 'clarification', description: '两个意图存在语义混淆风险。' },
};

// ── 大写（X6 模板）↔ 小写（v2.1）节点类型映射 ──

var TEMPLATE_TO_V2 = {
  AGGREGATE_INTENT: 'aggregate_intent',
  INTENT: 'intent_node',
  BUSINESS_OBJECT: 'business_object',
  ACTION: 'action',
  SLOT: 'slot',
  STATE: 'state_constraint',
  RISK: 'risk',
  KNOWLEDGE_ANSWER: 'knowledge_answer',
  RUNTIME_BOUNDARY: 'runtime_boundary',
};

var V2_TO_TEMPLATE = {};
Object.keys(TEMPLATE_TO_V2).forEach(function (upper) {
  V2_TO_TEMPLATE[TEMPLATE_TO_V2[upper]] = upper;
});

/** 小写（v2.1）→ 大写（X6 模板）；未知类型原样返回 */
function toTemplateType(v2Type) {
  return V2_TO_TEMPLATE[v2Type] || v2Type;
}

/** 大写（X6 模板）→ 小写（v2.1）；未知类型原样返回 */
function toV2Type(templateType) {
  return TEMPLATE_TO_V2[templateType] || templateType;
}

/** 边端点字段归一：v2.1 用 from/to，X6 用 source/target。返回 {from, to} */
function edgeEndpoints(edge) {
  if (!edge) return { from: '', to: '' };
  return {
    from: edge.from !== undefined ? edge.from : edge.source,
    to: edge.to !== undefined ? edge.to : edge.target,
  };
}

// ── 模板 ↔ 常量一致性校验（漂移检测）──

var TEMPLATE_PATH = path.join(__dirname, '..', 'data', 'graph-builder-templates', 'template.intent.v2.json');

/**
 * 校验模板与 v2.1 常量的一致性。
 * @returns {{ok: boolean, issues: string[], templateEdgeTypes: string[], templateNodeTypes: string[]}}
 */
function checkTemplateAlignment() {
  var issues = [];
  var tmpl = null;
  try {
    tmpl = require(TEMPLATE_PATH);
  } catch (e) {
    return { ok: false, issues: ['模板加载失败：' + e.message], templateEdgeTypes: [], templateNodeTypes: [] };
  }

  var tmplNodeTypes = (tmpl.node_types || []).map(function (t) { return t.type; });
  var tmplEdgeTypes = (tmpl.edge_types || []).map(function (t) { return t.type; });

  // 节点类型：模板大写集合映射到小写后应与 NODE_TYPES 一致
  var mappedNodes = tmplNodeTypes.map(toV2Type);
  NODE_TYPES.forEach(function (n) {
    if (mappedNodes.indexOf(n) < 0) issues.push('模板缺少 v2.1 节点类型对应项：' + n + '（模板大写名：' + toTemplateType(n) + '）');
  });
  mappedNodes.forEach(function (n) {
    if (NODE_TYPES.indexOf(n) < 0) issues.push('模板含 v2.1 未声明的节点类型：' + n);
  });

  // 边类型：模板与 v2.1 应为同一集合（边类型名两边一致，无需映射）
  tmplEdgeTypes.forEach(function (t) {
    if (EDGE_TYPES.indexOf(t) < 0) issues.push('模板含 v2.1 未声明的边类型：' + t);
  });
  EDGE_TYPES.forEach(function (t) {
    if (tmplEdgeTypes.indexOf(t) < 0) issues.push('v2.1 含模板未声明的边类型：' + t);
  });

  // 版本检查：1.5.0 起模板含 V4.1 结构化字段（67 个 INTENT 字段、8 种 intent_type）
  var minVersion = [1, 5, 0];
  var ver = String(tmpl.template_version || '0').split('.').map(Number);
  var outdated = false;
  for (var i = 0; i < minVersion.length; i++) {
    if ((ver[i] || 0) < minVersion[i]) { outdated = true; break; }
    if ((ver[i] || 0) > minVersion[i]) break;
  }
  if (outdated) issues.push('模板版本过低：' + tmpl.template_version + '（需 >= 1.5.0，低于该版本缺 V4.1 结构化字段）');

  // V4.1 字段级检查：INTENT 节点应含 V4.1 必需字段
  var V41_INTENT_FIELDS = [
    'lifecycle', 'recall_terms', 'semantic_view', 'semantic_priority', 'scenes',
    'action_code', 'slot_contract', 'skill_binding', 'execution_mode', 'risk_level',
    'readiness', 'requires_confirmation', 'orchestration_hint', 'orchestration_mode',
    'knowledge_binding', 'answer_type', 'capabilities', 'policies', 'observability',
  ];
  var intentNodeType = (tmpl.node_types || []).find(function (t) { return t.type === 'INTENT'; });
  if (intentNodeType) {
    var tmplFieldKeys = (intentNodeType.fields || []).map(function (f) { return f.key; });
    V41_INTENT_FIELDS.forEach(function (fk) {
      if (tmplFieldKeys.indexOf(fk) < 0) issues.push('模板 INTENT 节点缺 V4.1 必需字段：' + fk);
    });
  }

  // V4.1 intent_type 枚举检查：模板 INTENT 节点 intent_type 字段应有 8 种枚举
  if (intentNodeType) {
    var intentTypeField = (intentNodeType.fields || []).find(function (f) { return f.key === 'intent_type'; });
    if (intentTypeField && Array.isArray(intentTypeField.options)) {
      INTENT_TYPES.forEach(function (it) {
        if (intentTypeField.options.indexOf(it) < 0) issues.push('模板 INTENT 节点 intent_type 缺少枚举值：' + it);
      });
    }
  }

  return {
    ok: issues.length === 0,
    issues: issues,
    templateNodeTypes: tmplNodeTypes,
    templateEdgeTypes: tmplEdgeTypes,
  };
}

module.exports = {
  // v2.1 七段格式常量（单一来源）
  INTENT_TYPES: INTENT_TYPES,
  INTENT_LEVELS: INTENT_LEVELS,
  DOMAINS: DOMAINS,
  NODE_TYPES: NODE_TYPES,
  EDGE_TYPES: EDGE_TYPES,
  ACTION_CODES: ACTION_CODES,
  REQUIRED_IDENTITY: REQUIRED_IDENTITY,
  REQUIRED_SEMANTIC: REQUIRED_SEMANTIC,
  SCHEMA_EDGE_DEFINITIONS: SCHEMA_EDGE_DEFINITIONS,
  // V4.1 新增常量
  SCHEMA_VERSION: SCHEMA_VERSION,
  SCENE_TYPES: SCENE_TYPES,
  EXECUTION_MODES: EXECUTION_MODES,
  RISK_LEVELS: RISK_LEVELS,
  LIFECYCLE_STATES: LIFECYCLE_STATES,
  READINESS_STATES: READINESS_STATES,
  ORCHESTRATION_HINTS: ORCHESTRATION_HINTS,
  ORCHESTRATION_MODES: ORCHESTRATION_MODES,
  SUPPORTED_SHAPES: SUPPORTED_SHAPES,
  ANSWER_TYPES: ANSWER_TYPES,
  ANSWER_POLICIES: ANSWER_POLICIES,
  NODE_ROLES: NODE_ROLES,
  FULFILLMENT_KINDS: FULFILLMENT_KINDS,
  NODE_ROLE_BY_TYPE: NODE_ROLE_BY_TYPE,
  CAPABILITY_KINDS: CAPABILITY_KINDS,
  V41_REQUIRED_FIELDS: V41_REQUIRED_FIELDS,
  V41_REQUIRED_SCENE_FIELDS: V41_REQUIRED_SCENE_FIELDS,
  V4_TO_V2_FIELD_MAP: V4_TO_V2_FIELD_MAP,
  // 类型映射与转换
  TEMPLATE_TO_V2: TEMPLATE_TO_V2,
  V2_TO_TEMPLATE: V2_TO_TEMPLATE,
  toTemplateType: toTemplateType,
  toV2Type: toV2Type,
  edgeEndpoints: edgeEndpoints,
  // 漂移检测
  checkTemplateAlignment: checkTemplateAlignment,
  TEMPLATE_PATH: TEMPLATE_PATH,
};
