(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.AINativeBankTrace = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DEFINITIONS = [
    { stage: 'request.accepted', label: '请求接入', actor: 'Node 网关', eventStatus: 'accepted' },
    { stage: 'user_agent.started', label: '用户智能体启动', actor: 'openJiuwen User DeepAgent', eventStatus: 'running' },
    { stage: 'user_agent.completed', label: '用户意图识别', actor: 'openJiuwen User DeepAgent', eventStatus: 'completed' },
    { stage: 'delegation.created', label: 'A2A 任务委派', actor: 'Intent Task Envelope', eventStatus: 'completed' },
    { stage: 'business_agent.started', label: '业务智能体启动', actor: 'openJiuwen Business DeepAgent', eventStatus: 'running' },
    { stage: 'business_agent.completed', label: '业务能力规划', actor: 'openJiuwen Business DeepAgent', eventStatus: 'completed' },
    { stage: 'plan.validated', label: '能力计划校验', actor: 'Contract & Policy Guard', eventStatus: 'completed' },
    { stage: 'run.completed', label: '结果输出', actor: 'Agent Run Gateway', eventStatus: 'completed' },
    { stage: 'intent_graph.retrieved', label: '意图图谱召回', actor: 'CCB Intent Graph', eventStatus: 'completed', optional: true },
    { stage: 'memory.user_context_recalled', label: '用户记忆召回', actor: 'Memory Control', eventStatus: 'completed', optional: true },
    { stage: 'memory.task_context_recalled', label: '任务记忆召回', actor: 'Memory Control', eventStatus: 'completed', optional: true },
    { stage: 'memory.candidates_built', label: '记忆候选生成', actor: 'Agent Runtime', eventStatus: 'completed', optional: true },
    { stage: 'memory.governance_decided', label: '记忆治理裁决', actor: 'Memory Control', eventStatus: 'completed', optional: true },
    { stage: 'memory.persistence_completed', label: '记忆更新落盘', actor: 'Memory Control', eventStatus: 'completed', optional: true },
    { stage: 'business_skill.started', label: '业务 Skill 启动', actor: 'openJiuwen Skill Runtime', eventStatus: 'running', optional: true, depth: 1 },
    { stage: 'business_skill.completed', label: '业务 Skill 完成', actor: 'openJiuwen Skill Runtime', eventStatus: 'completed', optional: true, depth: 1 },
    { stage: 'capability.invocation_started', label: '原子能力调用', actor: 'Business DeepAgent Tool Gateway', eventStatus: 'running', optional: true },
    { stage: 'capability.invocation_completed', label: '原子能力返回', actor: 'Mock Core API', eventStatus: 'completed', optional: true },
    { stage: 'confirmation.checkpoint_created', label: '确认检查点', actor: 'Confirmation Guard', eventStatus: 'completed', optional: true },
    { stage: 'run.awaiting_confirmation', label: '等待本人确认', actor: 'Agent Run Gateway', eventStatus: 'awaiting_confirmation', optional: true },
    { stage: 'confirmation.checkpoint_accepted', label: '本人确认已接收', actor: 'Confirmation Guard', eventStatus: 'completed', optional: true },
    { stage: 'capability.execution_completed', label: '受控业务执行完成', actor: 'Mock Core Execution', eventStatus: 'completed', optional: true },
    { stage: 'session.created', label: '会话已创建', actor: 'Session Service', eventStatus: 'completed', optional: true },
    { stage: 'session.restored', label: '会话已恢复', actor: 'Session Service', eventStatus: 'completed', optional: true },
    { stage: 'session.closed', label: '会话已关闭', actor: 'Session Service', eventStatus: 'completed', optional: true },
    { stage: 'session.expired', label: '会话已过期', actor: 'Session Service', eventStatus: 'completed', optional: true },
    { stage: 'workflow.rebound', label: '业务跨会话恢复', actor: 'Workflow Control', eventStatus: 'completed', optional: true },
    { stage: 'input_rail.started', label: '安全 Rail 启动', actor: 'Finance Safety Rail', eventStatus: 'running', optional: true },
    { stage: 'input_rail.completed', label: '安全 Rail 判别', actor: 'Finance Safety Rail', eventStatus: 'completed', optional: true },
    { stage: 'security_gate.decided', label: '安全门禁裁决', actor: 'Safety Gate', eventStatus: 'completed', optional: true },
    { stage: 'user_agent.committed', label: '用户智能体状态提交', actor: 'openJiuwen Session', eventStatus: 'completed', optional: true },
    { stage: 'user_agent.rolled_back', label: '用户智能体推测回滚', actor: 'openJiuwen Session', eventStatus: 'completed', optional: true },
    { stage: 'action_rail.started', label: '动作 Rail 启动', actor: 'Finance Safety Rail', eventStatus: 'running', optional: true },
    { stage: 'action_rail.completed', label: '动作 Rail 判别', actor: 'Finance Safety Rail', eventStatus: 'completed', optional: true },
    { stage: 'output_rail.started', label: '输出 Rail 启动', actor: 'Finance Safety Rail', eventStatus: 'running', optional: true },
    { stage: 'output_rail.completed', label: '输出 Rail 判别', actor: 'Finance Safety Rail', eventStatus: 'completed', optional: true },
    { stage: 'run.failed', label: '智能体执行失败', actor: 'Agent Runtime', eventStatus: 'failed', optional: true },
  ];
  var MAIN_DEFINITIONS = DEFINITIONS.slice(0, 8);
  var DISPLAY_GROUPS = [
    {
      key: 'entry', kind: 'platform', label: '请求接入', role: 'Node 网关', mark: '入',
      stages: ['request.accepted', 'session.created', 'session.restored', 'session.closed', 'session.expired'],
    },
    {
      key: 'safety_gate', kind: 'platform', label: '输入安全门禁', role: '并行 Rail', mark: '安',
      stages: [
        'input_rail.started', 'input_rail.completed',
        'action_rail.started', 'action_rail.completed',
        'output_rail.started', 'output_rail.completed',
        'security_gate.decided',
      ],
    },
    {
      key: 'user_agent', kind: 'user-agent', label: '用户智能体', role: '理解用户', mark: '用',
      stages: ['user_agent.started', 'memory.user_context_recalled', 'intent_graph.retrieved', 'user_agent.committed', 'user_agent.rolled_back', 'user_agent.completed'],
    },
    {
      key: 'delegation', kind: 'handoff', label: 'A2A 任务委派', role: 'Intent Task Envelope', mark: 'A2A',
      stages: ['delegation.created'],
    },
    {
      key: 'business_agent', kind: 'business-agent', label: '业务智能体', role: '规划并调用能力', mark: '业',
      stages: [
        'business_agent.started', 'business_skill.started', 'business_skill.completed', 'business_agent.completed',
        'memory.task_context_recalled',
        'capability.invocation_started', 'capability.invocation_completed',
      ],
    },
    {
      key: 'platform', kind: 'platform', label: '平台控制层', role: '非智能体', mark: '控',
      stages: [
        'plan.validated', 'confirmation.checkpoint_created', 'run.awaiting_confirmation',
        'confirmation.checkpoint_accepted', 'capability.execution_completed', 'workflow.rebound',
        'memory.candidates_built', 'memory.governance_decided', 'memory.persistence_completed',
      ],
    },
    {
      key: 'outcome', kind: 'outcome', label: '运行结果', role: 'Agent Run Gateway', mark: '果',
      stages: ['run.completed'],
    },
  ];
  var ID = /^[A-Za-z0-9_.:-]+$/;
  var CAPABILITY_ID = /^bank\.[a-z0-9.-]+$/;
  var ERROR_CODE = /^[a-z0-9_]+$/;
  var UUID_TEXT = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  var AGENT_RUN_LONG_ID = new RegExp('^(?:' + UUID_TEXT + '|abr_' + UUID_TEXT + ')$', 'i');
  var TRACE_LONG_ID = new RegExp('^(?:' + UUID_TEXT + '|trace_' + UUID_TEXT + '|phone-trace-' + UUID_TEXT + ')$', 'i');
  var CONVERSATION_LONG_ID = new RegExp('^(?:' + UUID_TEXT + '|conv_(?:phone_)?' + UUID_TEXT + ')$', 'i');
  var DELEGATION_LONG_ID = new RegExp('^(?:' + UUID_TEXT + '|dlg_(?:' + UUID_TEXT + '|[0-9a-f]{32}))$', 'i');
  var TASK_LONG_ID = new RegExp(
    '^(?:' + UUID_TEXT + '|task_' + UUID_TEXT + '|task_guided_[0-9a-f]{20})$', 'i'
  );
  var STEP_LONG_ID = new RegExp('^(?:' + UUID_TEXT + '|step_' + UUID_TEXT + ')$', 'i');
  var ACTIONS = ['ASK', 'QUERY', 'NAVIGATE', 'DO', 'CHANGE', 'CANCEL', 'HELP'];
  var READINESS = ['ready', 'needs_slots', 'needs_clarification', 'navigation_only', 'unsupported'];
  var RISKS = ['L0', 'L1', 'L2', 'L3'];
  var SHAPES = ['single_intent', 'multi_intent', 'same_intent_multi_task', 'ambiguous_intent', 'non_task'];
  var RUN_STATUSES = ['planned', 'succeeded', 'awaiting_confirmation', 'clarification_required', 'navigation_only', 'unsupported', 'blocked', 'unavailable'];
  var MEMORY_SCOPES = ['user', 'task'];
  var MEMORY_DETAIL_STATUSES = ['available', 'empty', 'redacted', 'degraded'];
  var MEMORY_KINDS = ['semantic', 'episodic', 'working', 'procedural'];
  var MEMORY_APPLICATION_STATUSES = ['applied', 'not_applied_conflict', 'not_applied_policy'];
  var MEMORY_CONTROLS = ['current', 'requires_core_refresh', 'requires_confirmation'];
  var INTENT_GRAPH_ACTIONS = ['ASK', 'QUERY', 'DO', 'CHANGE', 'CANCEL', 'HELP', 'TRANSFER', 'REPAY'];
  var INTENT_GRAPH_EXECUTION_MODES = ['read-execute', 'confirm-required', 'knowledge-only', 'multi_intent', 'navigation-only', 'unavailable'];
  var INTENT_GRAPH_CONSTRAINTS = ['required', 'allowed'];
  var TRACE_FIELD_NAMES = [
    'message', 'pageContext', 'capabilitySummaries', 'agentRunId', 'traceId',
    'candidateCount', 'capabilityBindings', 'intentShape', 'taskCount', 'tasks',
    'delegationId', 'dependencies', 'intentTaskEnvelope', 'capabilities',
    'planStatus', 'stepCount', 'outputKeys', 'capabilityPlan', 'validated',
    'confirmationCount', 'checkpointStatus', 'status', 'steps', 'errorCode',
    'loopIteration', 'todoRevision', 'currentTodoStatus', 'delegatedTaskCount',
    'coveredTaskCount', 'grantCount', 'succeededCount', 'failedCount',
    'ambiguityType', 'ambiguities',
    'railDecision', 'decision', 'intentSummary', 'executionPermit', 'envelopeRevision',
    'userResponse', 'contextPackCount', 'conversationContext',
    'memoryContext', 'memoryCandidates', 'governanceDecision', 'memoryUpdateStatus',
  ];
  var TRACE_SECRET_MARKERS = [
    'confirmationtoken', 'tokenhash', 'authorization', 'accesstoken', 'accesskey',
    'refreshtoken', 'apikey', 'bearer', 'password', 'secret', 'systemprompt',
    'rawresponse', 'modelraw',
  ];
  var TRACE_INTERNAL_ID_PREFIXES = [
    'acp', 'bwf', 'conv', 'abr', 'dlg', 'trace', 'checkpoint', 'grant',
    'card', 'payee', 'execution', 'order', 'task', 'transfer',
  ];
  var SAFE_TRACE_ERROR_CODES = [
    'obligation_discovery_failed',
    'intent_graph_incompatible', 'agent_runtime_failed', 'user_agent_contract_violation',
    'user_agent_candidate_conflict', 'user_response_projection_failed',
    'balance_capability_unavailable', 'knowledge_only_capability_violation',
    'business_agent_contract_violation', 'balance_discovery_unavailable',
    'balance_discovery_policy_violation', 'business_agent_readonly_discovery_conflict',
    'capability_plan_invalid', 'balance_account_data_invalid',
    'balance_capability_invocation_failed', 'checkpoint_creation_failed',
    'user_result_projection_failed', 'agent_runtime_unavailable', 'agent_runtime_timeout',
    'agent_runtime_not_ready', 'agent_runtime_request_invalid',
    'agent_runtime_response_invalid',
    'business_workflow_restore_failed',
    'execution_permit_invalid', 'agent_session_commit_failed',
    'agent_session_revision_conflict',
    'task_slot_contract_invalid',
    'business_agent_todo_goal_conflict', 'business_agent_todo_loop_unavailable',
    'business_workflow_persistence_failed', 'completed_query_result_invalid',
    'guided_entry_invalid', 'query_capability_unavailable',
    'slot_resolver_data_invalid', 'slot_resolver_invocation_failed',
    'slot_resolver_policy_violation', 'slot_resolver_unavailable',
    'credit_card_repayment_context_unavailable',
    'user_agent_shape_conflict',
    'unhandled_exception', 'stream_error',
  ];
  var USER_RESPONSE_TYPES = ['result', 'clarification', 'answer', 'confirmation', 'navigation', 'notice'];
  var USER_RESPONSE_STATUS_TYPES = {
    succeeded: ['result', 'answer'],
    clarification_required: ['clarification'],
    awaiting_confirmation: ['confirmation'],
    navigation_only: ['navigation'],
    unsupported: ['notice'],
    blocked: ['notice'],
    unavailable: ['notice'],
  };
  var USER_TEXT_INTERNAL_MARKERS = [
    'confirmationtoken', 'tokenhash', 'authorizationtoken', 'accesstoken',
    'refreshtoken', 'systemprompt', '模型原文', 'accountid', 'cardid',
    'payeeid', 'capabilityid', 'intentid', 'taskid', 'stepid', 'agentrunid',
    'businessagentrunid', 'delegationid', 'traceid', 'requestid',
    'conversationid', 'errorcode', 'failedstage', 'risklevel',
    'executionreadiness', 'clarificationrequired', 'needsslots',
    'needsclarification', 'awaitingconfirmation', 'navigationonly',
    'bank', 'acct', 'credit', 'payee',
  ];
  var IDEOGRAPHIC_DOMAIN_PATTERN = /[\p{L}\p{N}-]+(?:。[\p{L}\p{N}-]+)+/giu;
  var COMMON_IDN_TLDS = [
    '中国', '公司', '网络', '网址', '在线', '商店', '中文网', '我爱你', '移动',
    '集团', '世界', '信息', '餐厅', '游戏', '企业', '娱乐', '香港', '台湾', '澳门', '政务',
  ];
  var TRACE_METRIC_KEYS = {
    'request.accepted': ['messageLength'],
    'input_rail.started': ['parallelGroup'],
    'input_rail.completed': ['decision', 'reasonCode', 'policyVersion', 'parallelGroup'],
    'action_rail.started': ['actionCount'],
    'action_rail.completed': ['decision', 'reasonCode', 'policyVersion', 'actionCount'],
    'output_rail.started': [],
    'output_rail.completed': ['decision', 'reasonCode', 'policyVersion'],
    'security_gate.decided': ['decision', 'reasonCode', 'policyVersion', 'permitType'],
    'user_agent.started': ['capabilityCount'],
    'user_agent.committed': ['permitType', 'envelopeRevision'],
    'user_agent.rolled_back': ['reasonCode'],
    'intent_graph.retrieved': ['candidateCount', 'graphVersion'],
    'memory.user_context_recalled': ['outcome', 'contextPackCount', 'factCount', 'conflictCount', 'omissionCount', 'requiresCoreRefreshCount', 'requiresConfirmationCount', 'policyVersion', 'intentId'],
    'memory.task_context_recalled': ['outcome', 'contextPackCount', 'factCount', 'conflictCount', 'omissionCount', 'requiresCoreRefreshCount', 'requiresConfirmationCount', 'policyVersion', 'taskCount', 'inputDefaultCount'],
    'memory.candidates_built': ['candidateCount', 'canonicalEpisodeCount', 'userPreferenceCount'],
    'memory.governance_decided': ['addCount', 'mergeCount', 'supersedeCount', 'contestedCount', 'rejectCount'],
    'memory.persistence_completed': ['persistedCount', 'pendingRetryCount', 'deadLetterCount'],
    'user_agent.completed': ['intentShape', 'taskCount', 'candidateConstraint', 'userRepairCount', 'intentSummary', 'slotSummary', 'ambiguityType'],
    'delegation.created': ['taskCount', 'dependencyCount'],
    'business_agent.started': ['capabilityCount', 'loopIteration', 'todoRevision', 'delegatedTaskCount'],
    'business_skill.started': ['skillId', 'skillVersion', 'skillCount', 'capabilityCount', 'providerCount'],
    'business_skill.completed': ['skillId', 'skillVersion', 'skillCount', 'outcome', 'stepCount'],
    'business_agent.completed': ['planStatus', 'stepCount', 'slotResolution', 'businessRepairCount', 'ambiguityType', 'loopIteration', 'todoRevision', 'currentTodoStatus', 'delegatedTaskCount', 'coveredTaskCount'],
    'capability.invocation_started': ['capabilityId'],
    'capability.invocation_completed': ['capabilityId', 'outcome'],
    'plan.validated': ['validated', 'confirmationCount'],
    'confirmation.checkpoint_accepted': ['capabilityId', 'outcome', 'checkpointStatus', 'grantCount'],
    'capability.execution_completed': ['capabilityId', 'outcome', 'grantCount', 'succeededCount', 'failedCount'],
    'confirmation.checkpoint_created': ['capabilityId', 'riskLevel', 'checkpointStatus', 'grantCount'],
    'run.awaiting_confirmation': ['status', 'taskCount', 'stepCount', 'checkpointStatus', 'grantCount'],
    'run.completed': ['status', 'taskCount', 'stepCount', 'grantCount', 'succeededCount', 'failedCount'],
    'run.failed': ['failedStage'],
    'session.created': ['idleAgeMs', 'resumableWorkflowCount'],
    'session.restored': ['idleAgeMs', 'resumableWorkflowCount'],
    'session.closed': ['idleAgeMs', 'resumableWorkflowCount'],
    'session.expired': ['idleAgeMs', 'resumableWorkflowCount'],
    'workflow.rebound': ['workflowRevision', 'completedTaskCount', 'taskCount'],
  };
  var LIFECYCLE_TRACE_TITLES = {
    'session.created': '会话已创建',
    'session.restored': '会话已恢复',
    'session.closed': '会话已关闭',
    'session.expired': '会话已过期',
    'workflow.rebound': '业务已安全绑定到当前会话',
  };
  var MAX_FRAME_BYTES = 64 * 1024;
  var MAX_STREAM_BYTES = 512 * 1024;

  function TraceViewError(message) {
    Error.call(this, message || '运行轨迹无法识别');
    this.name = 'TraceViewError';
    this.message = message || '运行轨迹无法识别';
  }
  TraceViewError.prototype = Object.create(Error.prototype);
  TraceViewError.prototype.constructor = TraceViewError;

  function fail(message) { throw new TraceViewError(message); }
  function plain(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(label + ' 格式无效');
    var prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail(label + ' 原型无效');
    return value;
  }
  function exactKeys(value, allowed, label) {
    var unknown = Object.keys(value).filter(function (key) { return allowed.indexOf(key) < 0; });
    if (unknown.length) fail(label + ' 包含不允许的字段');
  }
  function text(value, label, maximum, pattern) {
    if (typeof value !== 'string' || !value || value.length > maximum || /[<>\u0000-\u001f\u007f]/.test(value)) fail(label + ' 文本无效');
    if (pattern && !pattern.test(value)) fail(label + ' 格式无效');
    return value;
  }
  function list(value, label, maximum, pattern) {
    if (!Array.isArray(value) || value.length > maximum) fail(label + ' 格式无效');
    var result = value.map(function (item) { return text(item, label, 160, pattern); });
    if (new Set(result).size !== result.length) fail(label + ' 包含重复项');
    return result;
  }
  function traceText(value, label, maximum, pattern, allowedLongId) {
    var projected = text(value, label, maximum);
    var forms = decodedSecurityForms(projected);
    var containsSensitiveMarker = forms.some(function (candidate) {
      var compact = candidate.replace(/[\p{P}\p{Z}\p{S}\p{M}\p{C}]/gu, '');
      return TRACE_SECRET_MARKERS.some(function (marker) { return compact.indexOf(marker) >= 0; });
    });
    var containsInternalId = forms.some(function (candidate) {
      var compact = candidate.replace(/[\p{P}\p{Z}\p{S}\p{M}\p{C}]/gu, '');
      return TRACE_INTERNAL_ID_PREFIXES.some(function (prefix) {
        return compact.indexOf(prefix + 'private') >= 0
          || compact.indexOf(prefix + 'internal') >= 0;
      }) || /(?:^|[^a-z0-9])bwf_[a-f0-9]{24}(?:$|[^a-z0-9])/iu.test(candidate);
    });
    var containsLongCredential = forms.some(function (candidate) {
      return /[A-Za-z0-9_-]{32,}/u.test(candidate);
    });
    var isControlledLongId = Boolean(containsLongCredential && allowedLongId && allowedLongId.test(projected));
    var containsPaymentCardDigits = forms.some(function (candidate) {
      var digits = candidate.match(/\p{Nd}/gu);
      return digits && digits.length >= 15;
    });
    if (containsSensitiveMarker
      || containsTraceUrlLikeText(forms)
      || (containsInternalId && !isControlledLongId)
      || (containsLongCredential && !isControlledLongId)
      || (containsPaymentCardDigits && !isControlledLongId)) fail(label + ' 包含敏感信息');
    if (pattern) text(projected, label, maximum, pattern);
    return projected;
  }
  function traceList(value, label, maximum, pattern, allowedLongId) {
    if (!Array.isArray(value) || value.length > maximum) fail(label + ' list invalid');
    var result = value.map(function (item) { return traceText(item, label, 160, pattern, allowedLongId); });
    if (new Set(result).size !== result.length) fail(label + ' contains duplicate');
    return result;
  }
  function traceFieldList(value, label) {
    if (!Array.isArray(value) || value.length > 32) fail(label + ' 格式无效');
    var projected = value.map(function (item) {
      var field = traceText(item, label, 64);
      if (TRACE_FIELD_NAMES.indexOf(field) < 0) fail(label + ' 字段无效');
      return field;
    });
    if (new Set(projected).size !== projected.length) fail(label + ' 包含重复项');
    return projected;
  }
  function choice(value, allowed, label) {
    if (allowed.indexOf(value) < 0) fail(label + ' 无效');
    return value;
  }
  function metrics(value, stage) {
    plain(value, 'metrics');
    exactKeys(value, TRACE_METRIC_KEYS[stage] || [], 'metrics');
    if (Object.keys(value).length > 32) fail('metrics 过大');
    var result = {};
    Object.keys(value).forEach(function (key) {
      text(key, 'metric key', 64, ID);
      var item = value[key];
      if (item == null || typeof item === 'boolean') result[key] = item;
      else if (typeof item === 'number' && Number.isFinite(item)) result[key] = item;
      else if (typeof item === 'string') {
        if (stage === 'run.failed' && key === 'failedStage') {
          if (SAFE_TRACE_ERROR_CODES.indexOf(item) < 0) fail('failedStage 不是稳定错误码');
          result[key] = text(item, 'metric value', 96, ERROR_CODE);
        } else result[key] = traceText(item, 'metric value', 160);
      }
      else fail('metrics 只允许安全标量');
    });
    return result;
  }

  function projectMemoryNotice(value, label) {
    plain(value, label);
    exactKeys(value, ['label', 'count'], label);
    if (!Number.isSafeInteger(value.count) || value.count < 1 || value.count > 100000) fail(label + ' 数量无效');
    return { label: traceText(value.label, label, 80), count: value.count };
  }

  function projectMemoryRecall(value, stage, projectedMetrics) {
    plain(value, 'memory recall');
    exactKeys(value, ['schemaVersion', 'scope', 'detailStatus', 'groups', 'conflicts', 'omissions'], 'memory recall');
    if (value.schemaVersion !== '1.0') fail('memory recall 版本无效');
    var scope = choice(value.scope, MEMORY_SCOPES, 'memory recall scope');
    var detailStatus = choice(value.detailStatus, MEMORY_DETAIL_STATUSES, 'memory recall detail status');
    var expectedScope = stage === 'memory.user_context_recalled' ? 'user' : 'task';
    if (scope !== expectedScope) fail('memory recall 与阶段不匹配');
    if (!Array.isArray(value.groups) || value.groups.length > 8
      || !Array.isArray(value.conflicts) || value.conflicts.length > 12
      || !Array.isArray(value.omissions) || value.omissions.length > 10) fail('memory recall 列表无效');
    var itemCount = 0;
    var signatures = new Set();
    var groups = value.groups.map(function (group) {
      plain(group, 'memory recall group');
      exactKeys(group, ['key', 'label', 'items'], 'memory recall group');
      if (!Array.isArray(group.items) || group.items.length > 20) fail('memory recall items 无效');
      var items = group.items.map(function (item) {
        plain(item, 'memory recall item');
        exactKeys(item, ['label', 'displayValue', 'memoryKind', 'sourceLabel', 'validFrom', 'applicationStatus', 'controls'], 'memory recall item');
        var memoryKind = choice(item.memoryKind, MEMORY_KINDS, 'memory kind');
        var applicationStatus = choice(item.applicationStatus, MEMORY_APPLICATION_STATUSES, 'memory application status');
        if (typeof item.validFrom !== 'string' || item.validFrom.length > 40 || !Number.isFinite(Date.parse(item.validFrom))
          || !Array.isArray(item.controls) || item.controls.length > 3
          || item.controls.some(function (control) { return MEMORY_CONTROLS.indexOf(control) < 0; })
          || new Set(item.controls).size !== item.controls.length
          || (applicationStatus === 'applied' && item.controls.indexOf('current') < 0)) fail('memory recall item 枚举无效');
        var projected = {
          label: traceText(item.label, 'memory label', 80),
          displayValue: traceText(item.displayValue, 'memory display value', 160),
          memoryKind: memoryKind,
          sourceLabel: traceText(item.sourceLabel, 'memory source label', 80),
          validFrom: item.validFrom,
          applicationStatus: applicationStatus,
          controls: item.controls.slice(),
        };
        var signature = JSON.stringify(projected);
        if (signatures.has(signature)) fail('memory recall item 重复');
        signatures.add(signature);
        itemCount += 1;
        return projected;
      });
      return {
        key: text(group.key, 'memory group key', 64, ID),
        label: traceText(group.label, 'memory group label', 80),
        items: items,
      };
    });
    if (itemCount > 20) fail('memory recall item 超出预算');
    var groupKeys = groups.map(function (group) { return group.key; });
    if (new Set(groupKeys).size !== groupKeys.length) fail('memory recall group 重复');
    if (detailStatus === 'available' && itemCount === 0) fail('memory recall 可用状态缺少内容');
    if ((detailStatus === 'empty' || detailStatus === 'degraded')
      && (groups.length || value.conflicts.length || value.omissions.length)) fail('memory recall 空状态携带内容');
    if (!Number.isSafeInteger(projectedMetrics.factCount) || projectedMetrics.factCount < itemCount) fail('memory recall 数量不一致');
    var expectedStatus = projectedMetrics.outcome === 'degraded'
      ? 'degraded'
      : (projectedMetrics.outcome === 'empty' || projectedMetrics.outcome === 'not_applicable') ? 'empty' : null;
    if ((expectedStatus && detailStatus !== expectedStatus)
      || (!expectedStatus && ['available', 'redacted'].indexOf(detailStatus) < 0)) fail('memory recall 结果状态不一致');
    return {
      schemaVersion: '1.0', scope: scope, detailStatus: detailStatus,
      groups: groups,
      conflicts: value.conflicts.map(function (item) { return projectMemoryNotice(item, 'memory conflict'); }),
      omissions: value.omissions.map(function (item) { return projectMemoryNotice(item, 'memory omission'); }),
    };
  }

  function projectIntentGraphDetail(value, stage, projectedMetrics) {
    plain(value, 'intent graph detail');
    exactKeys(value, ['schemaVersion', 'graphVersion', 'candidates'], 'intent graph detail');
    if (value.schemaVersion !== '1.0') fail('intent graph detail 版本无效');
    if (typeof value.graphVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(value.graphVersion)) fail('intent graph 版本无效');
    if (!Array.isArray(value.candidates) || value.candidates.length > 8) fail('intent graph 候选无效');
    var candidates = value.candidates.map(function (candidate) {
      plain(candidate, 'intent graph candidate');
      exactKeys(candidate, ['intentId', 'title', 'action', 'businessObject', 'executionMode', 'capabilityBindings', 'score', 'evidence', 'constraint'], 'intent graph candidate');
      return {
        intentId: text(candidate.intentId, 'intent id', 160, ID),
        title: traceText(candidate.title, 'intent title', 80),
        action: choice(candidate.action, INTENT_GRAPH_ACTIONS, 'intent action'),
        businessObject: text(candidate.businessObject, 'business object', 128, ID),
        executionMode: choice(candidate.executionMode, INTENT_GRAPH_EXECUTION_MODES, 'intent execution mode'),
        capabilityBindings: Array.isArray(candidate.capabilityBindings)
          ? candidate.capabilityBindings.map(function (id) { return text(id, 'capability binding', 128, ID); })
          : [],
        score: typeof candidate.score === 'number' && Number.isInteger(candidate.score) && candidate.score >= 0 && candidate.score <= 1000
          ? candidate.score : fail('intent score 无效'),
        evidence: Array.isArray(candidate.evidence)
          ? candidate.evidence.map(function (e) { return traceText(e, 'evidence', 80); })
          : [],
        constraint: choice(candidate.constraint, INTENT_GRAPH_CONSTRAINTS, 'intent constraint'),
      };
    });
    if (projectedMetrics.candidateCount !== candidates.length) fail('intent graph 候选数量不一致');
    return { schemaVersion: '1.0', graphVersion: value.graphVersion, candidates: candidates };
  }

  function validateLifecycleTraceSummary(stage, summary) {
    if (!Object.prototype.hasOwnProperty.call(LIFECYCLE_TRACE_TITLES, stage)) return;
    if (summary.title !== LIFECYCLE_TRACE_TITLES[stage]
      || summary.input.length !== 0 || summary.output.length !== 0) fail('生命周期 Trace 摘要无效');
    var values = summary.metrics;
    function boundedInteger(value, minimum, maximum) {
      return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
    }
    if (stage.indexOf('session.') === 0) {
      if (!boundedInteger(values.idleAgeMs, 0, 31536000000)
        || !boundedInteger(values.resumableWorkflowCount, 0, 8)) fail('Session 生命周期指标无效');
      return;
    }
    if (!boundedInteger(values.workflowRevision, 1, 1000000000)
      || !boundedInteger(values.completedTaskCount, 0, 128)
      || !boundedInteger(values.taskCount, 1, 128)
      || values.completedTaskCount > values.taskCount) fail('Workflow 绑定指标无效');
  }

  function projectTask(value) {
    plain(value, 'task');
    exactKeys(value, ['id', 'intentId', 'action', 'businessObject', 'readiness', 'risk', 'dependencies', 'slotNames'], 'task');
    return {
      id: traceText(value.id, 'task id', 96, ID, TASK_LONG_ID),
      intentId: traceText(value.intentId, 'intent id', 160, ID),
      action: choice(value.action, ACTIONS, 'action'),
      businessObject: traceText(value.businessObject, 'business object', 128, ID),
      readiness: choice(value.readiness, READINESS, 'readiness'),
      risk: choice(value.risk, RISKS, 'risk'),
      dependencies: traceList(value.dependencies, 'task dependencies', 32, ID, TASK_LONG_ID),
      slotNames: traceList(value.slotNames, 'slot names', 64, ID),
    };
  }
  function projectStep(value) {
    plain(value, 'step');
    exactKeys(value, ['id', 'taskId', 'capabilityId', 'inputKeys', 'requiresConfirmation', 'dependencies'], 'step');
    if (typeof value.requiresConfirmation !== 'boolean') fail('确认标记无效');
    return {
      id: traceText(value.id, 'step id', 96, ID, STEP_LONG_ID),
      taskId: traceText(value.taskId, 'step task id', 96, ID, TASK_LONG_ID),
      capabilityId: traceText(value.capabilityId, 'capability id', 128, CAPABILITY_ID),
      inputKeys: traceList(value.inputKeys, 'input keys', 64, ID),
      requiresConfirmation: value.requiresConfirmation,
      dependencies: traceList(value.dependencies, 'step dependencies', 32, ID, STEP_LONG_ID),
    };
  }
  function graph(items, label) {
    var ids = items.map(function (item) { return item.id; });
    if (new Set(ids).size !== ids.length) fail(label + ' 标识重复');
    items.forEach(function (item) {
      item.dependencies.forEach(function (dependency) {
        if (dependency === item.id || ids.indexOf(dependency) < 0) fail(label + ' 依赖无效');
      });
    });
  }
  function projectResult(value, agentRunId) {
    plain(value, 'result');
    if (value.kind === 'security_gate') {
      exactKeys(value, ['kind', 'id', 'conversationId', 'status'], 'result');
      var gatedId = traceText(value.id, 'result id', 96, ID, AGENT_RUN_LONG_ID);
      if (gatedId !== agentRunId) fail('结果运行标识不一致');
      return {
        kind: 'security_gate',
        id: gatedId,
        conversationId: traceText(value.conversationId, 'conversation id', 96, ID, CONVERSATION_LONG_ID),
        status: choice(value.status, ['blocked', 'unavailable', 'clarification_required'], 'run status'),
      };
    }
    exactKeys(value, ['id', 'conversationId', 'delegationId', 'status', 'intentShape', 'tasks', 'steps', 'predictedNextIntents', 'requiresConfirmation'], 'result');
    if (!Array.isArray(value.tasks) || value.tasks.length > 16 || !Array.isArray(value.steps) || value.steps.length > 64) fail('result 列表无效');
    var tasks = value.tasks.map(projectTask);
    var steps = value.steps.map(projectStep);
    graph(tasks, 'task'); graph(steps, 'step');
    var taskIds = tasks.map(function (item) { return item.id; });
    if (steps.some(function (item) { return taskIds.indexOf(item.taskId) < 0; })) fail('step 引用未知任务');
    var shape = choice(value.intentShape, SHAPES, 'intent shape');
    if (shape === 'single_intent' && tasks.length !== 1) fail('意图任务数量无效');
    if ((shape === 'multi_intent' || shape === 'same_intent_multi_task') && tasks.length < 2) fail('意图任务数量无效');
    if ((shape === 'ambiguous_intent' || shape === 'non_task') && tasks.length) fail('意图任务数量无效');
    if (typeof value.requiresConfirmation !== 'boolean') fail('确认标记无效');
    var id = traceText(value.id, 'result id', 96, ID, AGENT_RUN_LONG_ID);
    if (id !== agentRunId) fail('结果运行标识不一致');
    return {
      id: id,
      conversationId: traceText(value.conversationId, 'conversation id', 96, ID, CONVERSATION_LONG_ID),
      delegationId: traceText(value.delegationId, 'delegation id', 96, ID, DELEGATION_LONG_ID),
      status: choice(value.status, RUN_STATUSES, 'run status'),
      intentShape: shape,
      tasks: tasks,
      steps: steps,
      predictedNextIntents: traceList(value.predictedNextIntents, 'predicted intents', 8, ID),
      requiresConfirmation: value.requiresConfirmation,
    };
  }

  function createRunState(identity) {
    var source = identity || {};
    var agentRunId = source.agentRunId == null ? null : traceText(source.agentRunId, 'agentRunId', 96, ID, AGENT_RUN_LONG_ID);
    var traceId = source.traceId == null ? null : traceText(source.traceId, 'traceId', 128, ID, TRACE_LONG_ID);
    return {
      agentRunId: agentRunId,
      traceId: traceId,
      status: 'connecting',
      lastSequence: 0,
      nextIndex: 0,
      terminal: false,
      resumable: false,
      openCapabilityInvocation: null,
      sessionLifecycleObserved: false,
      workflowReboundObserved: false,
      totalDurationMs: null,
      result: null,
      error: null,
      events: [],
      nodes: DEFINITIONS.map(function (item) {
        return { stage: item.stage, label: item.label, actor: item.actor, depth: item.depth || 0, status: 'waiting', durationMs: null, summary: null, error: null };
      }),
    };
  }

  function validateEvent(value, state) {
    if (state.terminal) fail('运行轨迹已进入终态');
    plain(value, 'trace event');
    exactKeys(value, ['schemaVersion', 'sequence', 'timestamp', 'stage', 'status', 'durationMs', 'agentRunId', 'traceId', 'summary', 'error'], 'trace event');
    if (value.schemaVersion !== '1.0' || !Number.isInteger(value.sequence) || value.sequence !== state.lastSequence + 1) fail('Trace 序号无效');
    if (!Number.isFinite(Date.parse(value.timestamp))) fail('Trace 时间无效');
    var agentRunId = traceText(value.agentRunId, 'agentRunId', 96, ID, AGENT_RUN_LONG_ID);
    var traceId = traceText(value.traceId, 'traceId', 128, ID, TRACE_LONG_ID);
    if ((state.agentRunId && state.agentRunId !== agentRunId) || (state.traceId && state.traceId !== traceId)) fail('Trace 运行标识不一致');
    if (value.durationMs != null && (!Number.isInteger(value.durationMs) || value.durationMs < 0 || value.durationMs > 600000)) fail('Trace 耗时无效');
    var summary = plain(value.summary, 'summary');
    exactKeys(summary, ['title', 'input', 'output', 'metrics', 'memoryRecall', 'intentGraphDetail', 'result'], 'summary');
    var projectedSummary = { title: traceText(summary.title, 'summary title', 128), input: traceFieldList(summary.input, 'summary input'), output: traceFieldList(summary.output, 'summary output'), metrics: metrics(summary.metrics, value.stage) };
    var memoryStage = value.stage === 'memory.user_context_recalled' || value.stage === 'memory.task_context_recalled';
    if (memoryStage !== (summary.memoryRecall != null)) fail('memory recall 阶段绑定无效');
    if (memoryStage) projectedSummary.memoryRecall = projectMemoryRecall(summary.memoryRecall, value.stage, projectedSummary.metrics);
    var intentGraphStage = value.stage === 'intent_graph.retrieved';
    if (intentGraphStage !== (summary.intentGraphDetail != null)) fail('intent graph detail 阶段绑定无效');
    if (intentGraphStage) projectedSummary.intentGraphDetail = projectIntentGraphDetail(summary.intentGraphDetail, value.stage, projectedSummary.metrics);
    validateLifecycleTraceSummary(value.stage, projectedSummary);
    var projectedError = null;
    var definition = MAIN_DEFINITIONS[state.nextIndex];
    if (value.stage === 'run.failed') {
      if (value.status !== 'failed') fail('失败状态无效');
      var error = plain(value.error, 'error');
      exactKeys(error, ['code', 'message'], 'error');
      projectedError = { code: text(error.code, 'error code', 96, ERROR_CODE), message: traceText(error.message, 'error message', 200) };
      if (SAFE_TRACE_ERROR_CODES.indexOf(projectedError.code) < 0) fail('error code 不是稳定错误码');
      if (summary.result != null) fail('失败事件不允许结果');
    } else {
      var optional = DEFINITIONS.some(function (item) { return item.optional && item.stage === value.stage; });
      var securityGateTerminal = value.stage === 'run.completed'
        && summary.result && summary.result.kind === 'security_gate';
      var skippedDelegationAndBusinessStart = value.stage === 'business_agent.completed'
        && definition && definition.stage === 'delegation.created';
      var skippedBusinessStart = value.stage === 'business_agent.completed'
        && definition && definition.stage === 'business_agent.started';
      var skippedPlanValidation = value.stage === 'run.completed'
        && definition && definition.stage === 'plan.validated';
      if (optional) validateOptionalStage(value, state);
      else if (value.stage === 'run.awaiting_confirmation') {
        if (!definition || definition.stage !== 'run.completed' || value.status !== 'awaiting_confirmation') fail('Trace 等待确认顺序无效');
      } else if (!securityGateTerminal && !skippedDelegationAndBusinessStart
        && !skippedBusinessStart && !skippedPlanValidation
        && (!definition || value.stage !== definition.stage || value.status !== definition.eventStatus)) fail('Trace 阶段顺序无效');
      if (value.error != null) fail('非失败事件不允许错误');
      if (value.stage === 'run.completed' || value.stage === 'run.awaiting_confirmation') projectedSummary.result = projectResult(summary.result, agentRunId);
      else if (summary.result != null) fail('非终态事件不允许结果');
    }
    return {
      schemaVersion: '1.0', sequence: value.sequence, timestamp: value.timestamp,
      stage: value.stage, status: value.status,
      ...(value.durationMs == null ? {} : { durationMs: value.durationMs }),
      agentRunId: agentRunId, traceId: traceId, summary: projectedSummary,
      ...(projectedError ? { error: projectedError } : {}),
    };
  }

  function reduceEvent(state, rawEvent) {
    plain(state, 'trace state');
    var event = validateEvent(rawEvent, state);
    var nodes = state.nodes.map(function (item) { return Object.assign({}, item); });
    nodes.forEach(function (node) { if (node.status === 'running') node.status = 'completed'; });
    var nextIndex = state.nextIndex;
    var terminal = false;
    var status = 'streaming';
    var result = state.result;
    var error = null;
    if (event.stage === 'run.failed') {
      var target = -1;
      for (var index = state.nodes.length - 1; index >= 0; index -= 1) {
        if (state.nodes[index].status === 'running') { target = index; break; }
      }
      if (target < 0) target = Math.min(nextIndex, nodes.length - 1);
      nodes[target].status = 'failed';
      nodes[target].error = event.error;
      nodes[target].summary = event.summary;
      nodes.slice(target + 1).forEach(function (node) {
        if (node.status === 'waiting') node.status = 'not_run';
      });
      terminal = true; status = 'failed'; error = event.error;
    } else {
      var optionalIndex = DEFINITIONS.findIndex(function (item) { return item.optional && item.stage === event.stage; });
      var skippedDelegationAndBusinessStart = optionalIndex < 0
        && event.stage === 'business_agent.completed'
        && MAIN_DEFINITIONS[nextIndex]
        && MAIN_DEFINITIONS[nextIndex].stage === 'delegation.created';
      var skippedBusinessStart = optionalIndex < 0
        && event.stage === 'business_agent.completed'
        && MAIN_DEFINITIONS[nextIndex]
        && MAIN_DEFINITIONS[nextIndex].stage === 'business_agent.started';
      var skippedPlanValidation = optionalIndex < 0
        && event.stage === 'run.completed'
        && MAIN_DEFINITIONS[nextIndex]
        && MAIN_DEFINITIONS[nextIndex].stage === 'plan.validated';
      var securityGateTerminal = event.stage === 'run.completed'
        && event.summary.result && event.summary.result.kind === 'security_gate';
      if (skippedDelegationAndBusinessStart) {
        var skippedDelegationNode = nodes.find(function (item) { return item.stage === 'delegation.created'; });
        var skippedBusinessNode = nodes.find(function (item) { return item.stage === 'business_agent.started'; });
        if (skippedDelegationNode) skippedDelegationNode.status = 'not_run';
        if (skippedBusinessNode) skippedBusinessNode.status = 'not_run';
      } else if (skippedBusinessStart) {
        var skippedNode = nodes.find(function (item) { return item.stage === 'business_agent.started'; });
        if (skippedNode) skippedNode.status = 'not_run';
      }
      if (skippedPlanValidation) {
        var skippedValidationNode = nodes.find(function (item) { return item.stage === 'plan.validated'; });
        if (skippedValidationNode) skippedValidationNode.status = 'not_run';
      }
      var node = optionalIndex >= 0
        ? nodes[optionalIndex]
        : securityGateTerminal
          ? nodes.find(function (item) { return item.stage === 'run.completed'; })
        : skippedDelegationAndBusinessStart || skippedBusinessStart
          ? nodes.find(function (item) { return item.stage === 'business_agent.completed'; })
          : skippedPlanValidation
            ? nodes.find(function (item) { return item.stage === 'run.completed'; })
            : nodes[nextIndex];
      node.status = event.status === 'running' ? 'running' : event.status === 'awaiting_confirmation' ? 'awaiting_confirmation' : 'completed';
      node.durationMs = event.durationMs == null ? null : event.durationMs;
      node.summary = event.summary;
      if (optionalIndex < 0) nextIndex = securityGateTerminal
        ? MAIN_DEFINITIONS.length
        : nextIndex + (skippedDelegationAndBusinessStart
          ? 3
          : skippedBusinessStart || skippedPlanValidation ? 2 : 1);
      if (event.stage === 'run.completed') {
        terminal = true; status = securityGateTerminal ? event.summary.result.status : 'completed'; result = event.summary.result;
        nodes.forEach(function (candidate) {
          var candidateDefinition = DEFINITIONS.find(function (item) { return item.stage === candidate.stage; });
          if (candidate.status === 'waiting' && candidateDefinition) {
            candidate.status = securityGateTerminal && !candidateDefinition.optional
              ? 'not_run'
              : candidateDefinition.optional ? 'not_applicable' : candidate.status;
          }
        });
      } else if (event.stage === 'run.awaiting_confirmation') {
        terminal = true; status = 'awaiting_confirmation'; result = event.summary.result;
      }
    }
    return {
      agentRunId: state.agentRunId || event.agentRunId,
      traceId: state.traceId || event.traceId,
      status: status,
      lastSequence: event.sequence,
      nextIndex: nextIndex,
      terminal: terminal,
      resumable: event.stage === 'run.awaiting_confirmation' || state.resumable,
      openCapabilityInvocation: state.openCapabilityInvocation,
      sessionLifecycleObserved: state.sessionLifecycleObserved,
      workflowReboundObserved: state.workflowReboundObserved,
      totalDurationMs: terminal && event.durationMs != null ? event.durationMs : state.totalDurationMs,
      result: result,
      error: error,
      events: state.events.concat([event]),
      nodes: nodes,
    };
  }

  function validateOptionalStage(value, state) {
    var positions = {
      'input_rail.started': [1],
      'input_rail.completed': [2],
      'action_rail.started': [7],
      'action_rail.completed': [7],
      'output_rail.started': [6, 7],
      'output_rail.completed': [6, 7],
      'security_gate.decided': [2, 3, 6, 7],
      'user_agent.committed': [2],
      'user_agent.rolled_back': [2, 3],
      'intent_graph.retrieved': [2],
      'memory.user_context_recalled': [4, 5],
      'memory.task_context_recalled': [5],
      'memory.candidates_built': [7],
      'memory.governance_decided': [7],
      'memory.persistence_completed': [7],
      'business_skill.started': [5],
      'business_skill.completed': [5],
      'capability.invocation_started': [6],
      'capability.invocation_completed': [6],
      'confirmation.checkpoint_created': [7],
      'run.awaiting_confirmation': [7],
      'session.created': [1],
      'session.restored': [1],
      'session.closed': [1],
      'session.expired': [1],
      'workflow.rebound': [4]
    };
    if (!positions[value.stage] || positions[value.stage].indexOf(state.nextIndex) < 0) fail('Trace 可选阶段顺序无效');
    var stageDefinition = DEFINITIONS.find(function (item) { return item.stage === value.stage; });
    if (!stageDefinition || value.status !== stageDefinition.eventStatus) fail('Trace 可选阶段状态无效');
    if (value.stage.indexOf('session.') === 0) {
      if (state.sessionLifecycleObserved) fail('Session 生命周期 Trace 重复');
      state.sessionLifecycleObserved = true;
    }
    if (value.stage === 'workflow.rebound') {
      if (state.workflowReboundObserved) fail('Workflow 绑定 Trace 重复');
      state.workflowReboundObserved = true;
    }
    var capabilityId = value.summary && value.summary.metrics && value.summary.metrics.capabilityId;
    if (value.stage === 'capability.invocation_started') {
      if (state.openCapabilityInvocation || !CAPABILITY_ID.test(capabilityId || '')) fail('能力调用开始事件无效');
      state.openCapabilityInvocation = capabilityId;
    }
    if (value.stage === 'capability.invocation_completed') {
      if (!state.openCapabilityInvocation || state.openCapabilityInvocation !== capabilityId) fail('能力调用完成事件未配对');
      state.openCapabilityInvocation = null;
    }
  }

  function createSseParserState() { return { buffer: '', totalBytes: 0 }; }
  function byteLength(value) {
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(value).byteLength;
    return unescape(encodeURIComponent(value)).length;
  }
  function parseSseChunk(state, chunk, flush) {
    plain(state, 'SSE parser state');
    if (typeof chunk !== 'string') fail('SSE 分块无效');
    state.totalBytes += byteLength(chunk);
    if (state.totalBytes > MAX_STREAM_BYTES) fail('SSE 总量过大');
    state.buffer += chunk;
    var events = [];
    while (true) {
      var match = /\r?\n\r?\n/.exec(state.buffer);
      if (!match) break;
      var frame = state.buffer.slice(0, match.index);
      state.buffer = state.buffer.slice(match.index + match[0].length);
      if (!frame.trim()) continue;
      if (byteLength(frame) > MAX_FRAME_BYTES) fail('SSE 帧过大');
      var eventName = null; var data = null;
      frame.split(/\r?\n/).forEach(function (line) {
        if (line.indexOf('event:') === 0) {
          if (eventName != null) fail('SSE event 重复');
          eventName = line.slice(6).trim();
        } else if (line.indexOf('data:') === 0) {
          if (data != null) fail('SSE data 重复');
          data = line.slice(5).replace(/^ /, '');
        } else if (line && line.charAt(0) !== ':') fail('SSE 字段无效');
      });
      if (['agent.trace', 'agent.result'].indexOf(eventName) < 0 || data == null) fail('SSE 事件无效');
      try {
        var parsed = JSON.parse(data);
      }
      catch (_) { fail('SSE JSON 无效'); }
      try {
        events.push(eventName === 'agent.result'
          ? deepFreeze(Object.assign({ eventType: 'agent.result' }, projectAgentDelivery(parsed)))
          : parsed);
      }
      catch (e) { fail(e && e.message ? e.message : 'SSE 事件校验失败'); }
    }
    if (byteLength(state.buffer) > MAX_FRAME_BYTES) fail('SSE 帧过大');
    if (flush && state.buffer.trim()) fail('SSE 尾帧不完整');
    return events;
  }

  function formatDuration(milliseconds) {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return '—';
    return milliseconds < 1000 ? Math.round(milliseconds) + 'ms' : (milliseconds / 1000).toFixed(1) + 's';
  }

  function getTraceGroups(state) {
    plain(state, 'trace state');
    if (!Array.isArray(state.nodes)) fail('trace nodes 格式无效');
    return DISPLAY_GROUPS.map(function (group) {
      return {
        key: group.key,
        kind: group.kind,
        label: group.label,
        role: group.role,
        mark: group.mark,
        nodes: group.stages.map(function (stage) {
          return state.nodes.find(function (node) { return node.stage === stage; });
        }).filter(Boolean),
      };
    });
  }

  function latestCompletedStatus(state) {
    for (var index = state.events.length - 1; index >= 0; index -= 1) {
      var event = state.events[index];
      if (event.stage === 'run.completed' && event.summary && event.summary.metrics && event.summary.metrics.status) {
        return event.summary.metrics.status;
      }
    }
    return state.result && state.result.status;
  }

  function getRunPresentation(state) {
    plain(state, 'trace state');
    if (state.status === 'failed') {
      return { title: '智能体执行链失败', statusText: '执行失败', tone: 'failed' };
    }
    if (state.status === 'awaiting_confirmation') {
      return { title: '业务方案等待确认', statusText: '等待本人确认', tone: 'awaiting_confirmation' };
    }
    if (state.status === 'connecting') {
      return { title: '正在接入智能服务', statusText: '正在连接', tone: 'connecting' };
    }
    if (state.status === 'streaming') {
      return { title: '双智能体正在协作', statusText: '执行中', tone: 'streaming' };
    }
    var outcome = latestCompletedStatus(state);
    var presentations = {
      clarification_required: { title: '本次请求需要补充信息', statusText: '等待用户澄清', tone: 'clarification' },
      planned: { title: '业务方案已生成', statusText: '规划完成', tone: 'completed' },
      succeeded: { title: '智能服务已完成', statusText: '执行完成', tone: 'completed' },
      navigation_only: { title: '已生成页面引导', statusText: '可继续操作', tone: 'completed' },
      unsupported: { title: '暂不支持该请求', statusText: '无法办理', tone: 'unsupported' },
      blocked: { title: '请求已被策略拦截', statusText: '已拦截', tone: 'blocked' },
      unavailable: { title: '安全检查暂时不可用', statusText: '未进入办理', tone: 'unsupported' },
      non_task: { title: '当前请求不属于可办理业务', statusText: '无需办理', tone: 'unsupported' },
    };
    return presentations[outcome] || { title: '智能体执行链', statusText: '已完成', tone: 'completed' };
  }

  function resultPreview(primary, secondary) {
    return { primary: primary, secondary: secondary || '' };
  }

  function getNodeResultPreview(state, node) {
    plain(state, 'trace state');
    if (!node || typeof node !== 'object') return null;
    if (node.status === 'failed' && node.error) {
      return resultPreview('失败：' + node.error.message);
    }
    if (['completed', 'awaiting_confirmation'].indexOf(node.status) < 0 || !node.summary) return null;
    var metrics = node.summary.metrics || {};
    var shapeLabels = {
      single_intent: '单意图', multi_intent: '多意图',
      same_intent_multi_task: '同意图多任务', ambiguous_intent: '模糊意图', non_task: '非任务请求',
    };
    var statusLabels = {
      planned: '方案已生成', succeeded: '执行成功', awaiting_confirmation: '等待本人确认',
      clarification_required: '需要补充信息', navigation_only: '仅页面引导',
      unsupported: '暂不支持', blocked: '已被策略拦截',
      unavailable: '安全检查暂时不可用',
    };
    if (['input_rail.completed', 'action_rail.completed', 'output_rail.completed'].indexOf(node.stage) >= 0) {
      var railLabels = { allow: '允许继续', review: '需要补充信息', block: '阻止办理', unavailable: '检查不可用' };
      return resultPreview(
        railLabels[metrics.decision] || metrics.decision,
        ['策略 ' + metrics.policyVersion, metrics.reasonCode].filter(Boolean).join(' · ')
      );
    }
    if (node.stage === 'security_gate.decided') {
      return resultPreview(
        metrics.decision === 'allow' ? '已签发执行许可'
          : metrics.decision === 'review' ? '仅允许安全澄清' : '未签发执行许可',
        metrics.reasonCode || ''
      );
    }
    if (node.stage === 'user_agent.committed') {
      return resultPreview('安全状态已提交 · 版本 ' + metrics.envelopeRevision);
    }
    if (node.stage === 'user_agent.rolled_back') {
      return resultPreview('推测结果已丢弃', metrics.reasonCode || '');
    }
    if (node.stage === 'intent_graph.retrieved') {
      var igDetail = node.summary.intentGraphDetail;
      if (igDetail && igDetail.candidates.length) {
        var intentTitles = igDetail.candidates.map(function (c) { return c.title; }).join('、');
        return resultPreview('召回 ' + metrics.candidateCount + ' 个候选 · 图谱 v' + metrics.graphVersion, intentTitles);
      }
      return resultPreview('召回 ' + metrics.candidateCount + ' 个候选 · 图谱 v' + metrics.graphVersion);
    }
    if (node.stage === 'memory.user_context_recalled' || node.stage === 'memory.task_context_recalled') {
      var memoryOutcome = {
        applied: node.stage === 'memory.user_context_recalled' ? '已应用用户记忆' : '已应用任务记忆',
        empty: '未召回到匹配记忆',
        not_applicable: '本次不需要记忆',
        degraded: '记忆召回已降级',
      };
      return resultPreview(
        memoryOutcome[metrics.outcome] || '记忆召回已完成',
        metrics.contextPackCount + ' 个上下文包 · ' + metrics.factCount + ' 条记忆 · '
          + metrics.requiresCoreRefreshCount + ' 条办理前需刷新'
      );
    }
    if (node.stage === 'user_agent.completed') {
      var intentSummary = metrics.intentSummary;
      if (!intentSummary && state.result && Array.isArray(state.result.tasks) && state.result.tasks.length) {
        intentSummary = state.result.tasks.map(function (task) { return task.intentId; }).join('、');
      }
      if (!intentSummary) intentSummary = shapeLabels[metrics.intentShape] || '未形成明确意图';
      var constraintLabel = metrics.candidateConstraint === 'matched'
        ? '候选约束已匹配' : metrics.candidateConstraint === 'not_applicable' ? '多候选受约束裁决' : '';
      return resultPreview(
        '识别结果：' + intentSummary,
        [shapeLabels[metrics.intentShape] || metrics.intentShape, metrics.taskCount + ' 个任务', constraintLabel, metrics.slotSummary]
          .filter(Boolean).join(' · ')
      );
    }
    if (node.stage === 'delegation.created') {
      return resultPreview('已委派 ' + metrics.taskCount + ' 个任务 · ' + metrics.dependencyCount + ' 个依赖');
    }
    if (node.stage === 'business_skill.started') {
      return resultPreview(
        metrics.skillId + ' v' + metrics.skillVersion + ' · 已装载',
        metrics.skillCount + ' 个 Skill · ' + metrics.capabilityCount + ' 项能力 · ' + metrics.providerCount + ' 个 Provider'
      );
    }
    if (node.stage === 'business_skill.completed') {
      return resultPreview(
        metrics.skillId + ' v' + metrics.skillVersion + ' · ' + (metrics.outcome === 'applied' ? '已应用' : metrics.outcome),
        '本轮生成 ' + metrics.stepCount + ' 个 Skill 步骤'
      );
    }
    if (node.stage === 'business_agent.completed') {
      var resolutionLabels = {
        read_only_discovery: '已完成只读账户发现', clarification: '等待补充业务槽位',
        not_required: '无需额外槽位解析',
      };
      var loopText = metrics.loopIteration == null ? ''
        : 'Loop ' + metrics.loopIteration + ' · Todo r' + metrics.todoRevision
          + ' · 覆盖 ' + metrics.coveredTaskCount + '/' + metrics.delegatedTaskCount;
      return resultPreview(
        (statusLabels[metrics.planStatus] || metrics.planStatus) + ' · ' + metrics.stepCount + ' 个能力步骤',
        [resolutionLabels[metrics.slotResolution] || metrics.slotResolution, loopText].filter(Boolean).join(' · ')
      );
    }
    if (node.stage === 'capability.invocation_completed') {
      return resultPreview(metrics.capabilityId + ' · ' + (metrics.outcome === 'succeeded' ? '调用成功' : metrics.outcome));
    }
    if (node.stage === 'plan.validated') {
      return resultPreview((metrics.validated ? '校验通过' : '校验未通过') + ' · ' + metrics.confirmationCount + ' 个确认点');
    }
    if (node.stage === 'confirmation.checkpoint_created') {
      return resultPreview(metrics.grantCount === 0
        ? '确认点已创建 · 尚未授权'
        : metrics.capabilityId + ' · ' + metrics.riskLevel + ' 确认点已创建');
    }
    if (node.stage === 'run.awaiting_confirmation') {
      return resultPreview('等待本人确认 · ' + metrics.taskCount + ' 个任务 · ' + metrics.stepCount + ' 个步骤');
    }
    if (node.stage === 'confirmation.checkpoint_accepted') {
      return resultPreview(metrics.grantCount == null
        ? metrics.capabilityId + ' · 本人确认已接收'
        : '本人确认已接收 · ' + metrics.grantCount + ' 项授权');
    }
    if (node.stage === 'capability.execution_completed') {
      return resultPreview(metrics.succeededCount == null
        ? metrics.capabilityId + ' · ' + (metrics.outcome === 'succeeded' ? '执行成功' : metrics.outcome)
        : '逐笔执行 · 成功 ' + metrics.succeededCount + ' · 失败 ' + metrics.failedCount);
    }
    if (node.stage === 'run.completed') {
      var result = state.result || {};
      var taskCount = metrics.taskCount == null && Array.isArray(result.tasks) ? result.tasks.length : metrics.taskCount;
      var stepCount = metrics.stepCount == null && Array.isArray(result.steps) ? result.steps.length : metrics.stepCount;
      return resultPreview(
        (statusLabels[metrics.status] || metrics.status) + ' · ' + taskCount + ' 个任务 · ' + stepCount + ' 个步骤'
      );
    }
    return null;
  }

  function resumeConfirmation(state, rawEvents) {
    plain(state, 'trace state');
    var clarificationPaused = state.result && state.result.status === 'clarification_required';
    if (!state.terminal || (!state.resumable && !clarificationPaused)
      || !Array.isArray(rawEvents) || rawEvents.length !== 3) fail('确认 Trace 无法续接');
    var expected = ['confirmation.checkpoint_accepted', 'capability.execution_completed', 'run.completed'];
    var nodes = state.nodes.map(function (item) { return Object.assign({}, item); });
    var events = state.events.slice();
    var awaitingIndex = DEFINITIONS.findIndex(function (item) { return item.stage === 'run.awaiting_confirmation'; });
    if (awaitingIndex >= 0 && nodes[awaitingIndex].status === 'awaiting_confirmation') {
      nodes[awaitingIndex].status = 'completed';
    }
    rawEvents.forEach(function (value, index) {
      plain(value, 'confirmation trace event');
      exactKeys(value, ['schemaVersion', 'sequence', 'timestamp', 'stage', 'status', 'durationMs', 'agentRunId', 'traceId', 'summary'], 'confirmation trace event');
      if (value.schemaVersion !== '1.0' || value.sequence !== state.lastSequence + index + 1
        || value.stage !== expected[index] || value.status !== 'completed'
        || value.agentRunId !== state.agentRunId || value.traceId !== state.traceId
        || !Number.isFinite(Date.parse(value.timestamp))) fail('确认 Trace 事件无效');
      var summary = plain(value.summary, 'confirmation trace summary');
      exactKeys(summary, ['title', 'input', 'output', 'metrics'], 'confirmation trace summary');
      var projected = {
        schemaVersion: '1.0', sequence: value.sequence, timestamp: value.timestamp,
        stage: value.stage, status: 'completed', agentRunId: state.agentRunId, traceId: state.traceId,
        summary: { title: traceText(summary.title, 'summary title', 128), input: traceFieldList(summary.input, 'summary input'), output: traceFieldList(summary.output, 'summary output'), metrics: {} },
      };
      var allowedMetrics = value.stage === 'confirmation.checkpoint_accepted'
        ? ['capabilityId', 'outcome', 'checkpointStatus', 'grantCount']
        : value.stage === 'capability.execution_completed'
          ? ['capabilityId', 'outcome', 'grantCount', 'succeededCount', 'failedCount']
          : ['status', 'grantCount', 'succeededCount', 'failedCount'];
      exactKeys(summary.metrics, allowedMetrics, 'confirmation trace metrics');
      Object.keys(summary.metrics).forEach(function (key) {
        var item = summary.metrics[key];
        if (typeof item === 'number') {
          if (!Number.isInteger(item) || item < 0 || item > 16) fail('确认 Trace 指标无效');
        } else if (typeof item !== 'string' || item.length > 160 || /[<>\u0000-\u001f\u007f]/.test(item)) {
          fail('确认 Trace 指标无效');
        }
        projected.summary.metrics[key] = item;
      });
      var nodeIndex = value.stage === 'run.completed'
        ? 7 : DEFINITIONS.findIndex(function (item) { return item.stage === value.stage; });
      nodes[nodeIndex].status = 'completed'; nodes[nodeIndex].summary = projected.summary;
      events.push(projected);
    });
    nodes.forEach(function (candidate) {
      var candidateDefinition = DEFINITIONS.find(function (item) { return item.stage === candidate.stage; });
      if (candidate.status === 'waiting' && candidateDefinition && candidateDefinition.optional) {
        candidate.status = 'not_applicable';
      }
    });
    var continuationStatus = rawEvents[2].summary.metrics.status;
    var continues = ['awaiting_confirmation', 'clarification_required'].indexOf(continuationStatus) >= 0;
    var nextResult = state.result ? Object.assign({}, state.result, { status: continuationStatus }) : state.result;
    return {
      agentRunId: state.agentRunId, traceId: state.traceId,
      status: continues ? continuationStatus : 'completed',
      lastSequence: state.lastSequence + 3, nextIndex: 8, terminal: true, resumable: continues,
      openCapabilityInvocation: null, totalDurationMs: state.totalDurationMs,
      result: nextResult, error: null, events: events, nodes: nodes,
    };
  }

  function projectUserFacingItemMeta(value) {
    plain(value, 'item meta');
    exactKeys(value, ['label', 'value'], 'item meta');
    return {
      label: userText(value.label, 'item meta label', 40),
      value: userText(value.value, 'item meta value', 120),
    };
  }

  function projectUserFacingItemAction(value) {
    plain(value, 'item action');
    exactKeys(value, ['label', 'message', 'detail', 'interaction', 'form'], 'item action');
    return {
      label: userText(value.label, 'item action label', 40),
      message: value.message == null ? null : userText(value.message, 'item action message', 240),
      detail: value.detail == null ? null : userMultiLineText(value.detail, 'item action detail', 2000),
      interaction: value.interaction === 'compose' ? 'compose' : 'submit',
      form: value.form == null ? null : projectUserResponseActionForm(value.form),
    };
  }

  function projectUserFacingItemCard(value) {
    plain(value, 'item card');
    exactKeys(value, ['id', 'title', 'subtitle', 'metas', 'action'], 'item card');
    return {
      id: value.id == null ? null : userText(value.id, 'item card id', 80),
      title: userText(value.title, 'item card title', 120),
      subtitle: value.subtitle == null ? null : userText(value.subtitle, 'item card subtitle', 80),
      metas: !Array.isArray(value.metas) ? [] : value.metas.slice(0, 8).map(projectUserFacingItemMeta),
      action: value.action == null ? null : projectUserFacingItemAction(value.action),
    };
  }

  function projectUserFacingPlanAllocation(value) {
    plain(value, 'plan allocation');
    exactKeys(value, [
      'productId', 'productName', 'productCategory', 'productCategoryLabel',
      'portfolioRole', 'portfolioRoleLabel', 'amountMinor', 'amount',
      'ratioBasisPoints', 'riskLevel', 'liquidity', 'suitability', 'rateNote',
      'detail', 'productActionLabel'
    ], 'plan allocation');
    if (typeof value.productId !== 'string' || !/^prod_[A-Za-z0-9_-]{1,63}$/.test(value.productId)
      || !Number.isInteger(value.amountMinor) || value.amountMinor < 100
      || !Number.isInteger(value.ratioBasisPoints)
      || value.ratioBasisPoints < 1 || value.ratioBasisPoints > 10000) fail('plan allocation 无效');
    return {
      productId: value.productId,
      productName: userText(value.productName, 'product name', 120),
      productCategory: userText(value.productCategory, 'product category', 40),
      productCategoryLabel: userText(value.productCategoryLabel, 'product category label', 40),
      portfolioRole: userText(value.portfolioRole, 'portfolio role', 40),
      portfolioRoleLabel: userText(value.portfolioRoleLabel, 'portfolio role label', 40),
      amountMinor: value.amountMinor,
      amount: userText(value.amount, 'allocation amount', 40),
      ratioBasisPoints: value.ratioBasisPoints,
      riskLevel: userText(value.riskLevel, 'allocation risk', 20),
      liquidity: userText(value.liquidity, 'allocation liquidity', 240),
      suitability: userText(value.suitability, 'allocation suitability', 240),
      rateNote: value.rateNote == null ? null : userText(value.rateNote, 'allocation rate note', 400),
      detail: value.detail == null ? null : userMultiLineText(value.detail, 'allocation detail', 2000),
      productActionLabel: userText(value.productActionLabel, 'product action label', 40)
    };
  }

  function projectUserFacingPlan(value) {
    plain(value, 'wealth plan');
    exactKeys(value, [
      'id', 'title', 'summary', 'totalAmountMinor', 'totalAmount', 'isPrimary',
      'allocations', 'rationale', 'selectLabel', 'selectMessage'
    ], 'wealth plan');
    if (typeof value.id !== 'string' || !/^plan_[A-Za-z0-9_-]{1,63}$/.test(value.id)
      || !Number.isInteger(value.totalAmountMinor) || value.totalAmountMinor < 100
      || typeof value.isPrimary !== 'boolean'
      || !Array.isArray(value.allocations) || value.allocations.length < 1 || value.allocations.length > 5
      || !Array.isArray(value.rationale) || value.rationale.length > 8) fail('wealth plan 无效');
    var allocations = value.allocations.map(projectUserFacingPlanAllocation);
    var productIds = allocations.map(function (item) { return item.productId; });
    if (new Set(productIds).size !== productIds.length
      || allocations.reduce(function (sum, item) { return sum + item.amountMinor; }, 0) !== value.totalAmountMinor
      || allocations.reduce(function (sum, item) { return sum + item.ratioBasisPoints; }, 0) !== 10000) {
      fail('wealth plan 金额或比例无效');
    }
    return {
      id: value.id,
      title: userText(value.title, 'plan title', 80),
      summary: userText(value.summary, 'plan summary', 240),
      totalAmountMinor: value.totalAmountMinor,
      totalAmount: userText(value.totalAmount, 'plan total amount', 40),
      isPrimary: value.isPrimary,
      allocations: allocations,
      rationale: value.rationale.map(function (item) { return userText(item, 'plan rationale', 240); }),
      selectLabel: userText(value.selectLabel, 'plan select label', 40),
      selectMessage: userText(value.selectMessage, 'plan select message', 240)
    };
  }

  function projectAgentDelivery(value) {
    plain(value, 'agent result');
    exactKeys(value, ['agentRunId', 'status', 'userResult', 'userResponse', 'userResponses', 'confirmation', 'clarificationForm'], 'agent result');
    var statuses = ['planned', 'succeeded', 'awaiting_confirmation', 'clarification_required', 'navigation_only', 'unsupported', 'blocked', 'unavailable'];
    var result = {
      agentRunId: text(value.agentRunId, 'agentRunId', 96, ID),
      status: choice(value.status, statuses, 'agent status'), userResult: null, userResponse: null, confirmation: null,
    };
    if (value.userResult != null) {
      plain(value.userResult, 'user result');
      exactKeys(value.userResult, ['kind', 'title', 'summary', 'items', 'itemCards', 'plans', 'primaryAction', 'actions'], 'user result');
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(value.userResult.kind)) fail('user result kind 无效');
      var plans = !Array.isArray(value.userResult.plans) ? []
        : value.userResult.plans.slice(0, 3).map(projectUserFacingPlan);
      if (plans.length && plans.filter(function (plan) { return plan.isPrimary; }).length !== 1) {
        fail('wealth plan 主方案无效');
      }
      result.userResult = {
        kind: value.userResult.kind,
        title: userText(value.userResult.title, 'result title', 80),
        summary: userText(value.userResult.summary, 'result summary', 240),
        items: userTextList(value.userResult.items, 'result items', 20, 240),
        itemCards: !Array.isArray(value.userResult.itemCards) ? [] : value.userResult.itemCards.slice(0, 20).map(projectUserFacingItemCard),
        plans: plans,
        primaryAction: value.userResult.primaryAction == null ? null : userText(value.userResult.primaryAction, 'primary action', 80),
        actions: !Array.isArray(value.userResult.actions) ? [] : value.userResult.actions.slice(0, 6).map(projectUserFacingItemAction),
      };
    }
    if (value.userResponse != null) result.userResponse = projectUserResponse(value.userResponse);
    if (value.userResponses != null) {
      if (!Array.isArray(value.userResponses) || value.userResponses.length < 1 || value.userResponses.length > 8) fail('user responses 无效');
      result.userResponses = value.userResponses.map(projectUserResponse);
      if (result.userResponses.slice(0, -1).some(function (item) {
        return ['result', 'notice'].indexOf(item.type) < 0 || item.actions.length;
      })) fail('user responses 前缀无效');
    }
    if (value.clarificationForm != null) result.clarificationForm = projectClarificationForm(value.clarificationForm);
    if (value.confirmation != null) {
      plain(value.confirmation, 'confirmation');
      exactKeys(value.confirmation, ['checkpointId', 'capabilityId', 'confirmationToken', 'expiresAt', 'summary', 'confirmations'], 'confirmation');
      plain(value.confirmation.summary, 'confirmation summary');
      // transferDetails/fromAccount 是确认卡的结构化渲染提示（逐笔明细
      // 与付款账户），服务端确认视图会携带，缺失时卡片退化为纯文本。
      exactKeys(value.confirmation.summary, ['title', 'description', 'riskLevel', 'items', 'taskCount', 'totalAmountMinor', 'transferDetails', 'fromAccount'], 'confirmation summary');
      var confirmationTaskCount = value.confirmation.summary.taskCount == null ? 1 : value.confirmation.summary.taskCount;
      var confirmationItems = value.confirmation.summary.items == null ? [] : value.confirmation.summary.items;
      var confirmationCredentials = value.confirmation.confirmations == null ? [] : value.confirmation.confirmations;
      if (typeof value.confirmation.checkpointId !== 'string' || value.confirmation.checkpointId.length > 96
        || !/^acp_[A-Za-z0-9_-]+$/.test(value.confirmation.checkpointId)
        || typeof value.confirmation.capabilityId !== 'string' || value.confirmation.capabilityId.length > 128
        || !CAPABILITY_ID.test(value.confirmation.capabilityId)
        || typeof value.confirmation.confirmationToken !== 'string' || value.confirmation.confirmationToken.length < 32 || value.confirmation.confirmationToken.length > 256
        || typeof value.confirmation.expiresAt !== 'string' || codePointLength(value.confirmation.expiresAt) < 20 || codePointLength(value.confirmation.expiresAt) > 40
        || !Number.isFinite(Date.parse(value.confirmation.expiresAt))
        || RISKS.indexOf(value.confirmation.summary.riskLevel) < 0
        || !Number.isInteger(confirmationTaskCount) || confirmationTaskCount < 1 || confirmationTaskCount > 16
        || !Array.isArray(confirmationItems) || confirmationItems.length > 16
        || (confirmationTaskCount > 1 && confirmationItems.length !== confirmationTaskCount)
        || !Array.isArray(confirmationCredentials) || confirmationCredentials.length > 16
        || (value.confirmation.summary.totalAmountMinor != null
          && (!Number.isInteger(value.confirmation.summary.totalAmountMinor)
            || value.confirmation.summary.totalAmountMinor < 1
            || value.confirmation.summary.totalAmountMinor > 800000000))) fail('confirmation 无效');
      confirmationCredentials = confirmationCredentials.map(function (item) {
        plain(item, 'confirmation credential');
        exactKeys(item, ['checkpointId', 'confirmationToken'], 'confirmation credential');
        if (!/^acp_[A-Za-z0-9_-]{1,92}$/.test(item.checkpointId || '')
          || typeof item.confirmationToken !== 'string'
          || item.confirmationToken.length < 32 || item.confirmationToken.length > 256) fail('confirmation credential 无效');
        return { checkpointId: item.checkpointId, confirmationToken: item.confirmationToken };
      });
      if ((confirmationCredentials.length && confirmationCredentials.length !== confirmationTaskCount)
        || (!confirmationCredentials.length && confirmationTaskCount !== 1)
        || (confirmationCredentials.length
          && (confirmationCredentials[0].checkpointId !== value.confirmation.checkpointId
            || confirmationCredentials[0].confirmationToken !== value.confirmation.confirmationToken))
        || new Set(confirmationCredentials.map(function (item) { return item.checkpointId; })).size !== confirmationCredentials.length) fail('confirmation credential 无效');
      result.confirmation = {
        checkpointId: value.confirmation.checkpointId,
        capabilityId: value.confirmation.capabilityId,
        confirmationToken: value.confirmation.confirmationToken,
        expiresAt: value.confirmation.expiresAt,
        ...(value.confirmation.confirmations == null ? {} : {
          confirmations: confirmationCredentials,
        }),
        summary: {
          title: userText(value.confirmation.summary.title, 'confirmation title', 80),
          description: userText(value.confirmation.summary.description, 'confirmation description', 200),
          riskLevel: value.confirmation.summary.riskLevel,
          ...(value.confirmation.summary.items == null ? {} : {
            items: userTextList(confirmationItems, 'confirmation items', 16, 240),
          }),
          ...(value.confirmation.summary.taskCount == null ? {} : {
            taskCount: confirmationTaskCount,
          }),
          ...(value.confirmation.summary.totalAmountMinor == null ? {} : {
            totalAmountMinor: value.confirmation.summary.totalAmountMinor,
          }),
          ...(Array.isArray(value.confirmation.summary.transferDetails) ? {
            transferDetails: value.confirmation.summary.transferDetails.slice(0, 16).map(function (detail) {
              plain(detail, 'confirmation transfer detail');
              return {
                sequence: Number.isInteger(detail.sequence) ? detail.sequence : null,
                payeeName: detail.payeeName == null ? null : userText(detail.payeeName, 'transfer detail payee', 40),
                payeeBank: detail.payeeBank == null ? null : userText(detail.payeeBank, 'transfer detail bank', 40),
                payeeTail: detail.payeeTail == null ? null : userText(detail.payeeTail, 'transfer detail tail', 8),
                amount: detail.amount == null ? null : userText(String(detail.amount), 'transfer detail amount', 16),
                amountMinor: detail.amountMinor,
              };
            }),
          } : {}),
          ...(value.confirmation.summary.fromAccount == null ? {} : {
            fromAccount: {
              name: userText(value.confirmation.summary.fromAccount.name, 'confirmation from account', 40),
              tail: value.confirmation.summary.fromAccount.tail == null
                ? null : userText(value.confirmation.summary.fromAccount.tail, 'confirmation from tail', 8),
            },
          }),
        },
      };
    }
    validateAgentDeliveryState(result);
    return deepFreeze(result);
  }

  function validateAgentDeliveryState(result) {
    if (result.userResponse && result.userResponses) fail('user response 载荷冲突');
    var terminalResponse = result.userResponses
      ? result.userResponses[result.userResponses.length - 1]
      : result.userResponse;
    if (result.status === 'planned') {
      if (result.userResult || terminalResponse || result.confirmation || result.clarificationForm) fail('规划状态不能携带终态结果');
      return;
    }
    if (result.status === 'succeeded') {
      if (!result.userResult && !terminalResponse) fail('成功状态缺少用户结果');
      if (terminalResponse && USER_RESPONSE_STATUS_TYPES.succeeded.indexOf(terminalResponse.type) < 0) fail('user response 状态冲突');
    } else {
      if (result.userResult) fail('user result 状态冲突');
      if (!terminalResponse
        || !USER_RESPONSE_STATUS_TYPES[result.status]
        || USER_RESPONSE_STATUS_TYPES[result.status].indexOf(terminalResponse.type) < 0) fail('user response 状态冲突');
    }
    if ((result.status === 'awaiting_confirmation') !== Boolean(result.confirmation)) fail('confirmation 状态冲突');
    if (result.clarificationForm && (result.status !== 'clarification_required'
      || !terminalResponse || terminalResponse.schemaVersion !== '1.1'
      || terminalResponse.type !== 'clarification')) fail('clarification form 状态冲突');
  }

  function projectUserResponse(value) {
    plain(value, 'user response');
    exactKeys(value, ['schemaVersion', 'type', 'title', 'body', 'items', 'actions', 'source', 'taskProgress'], 'user response');
    if (['1.0', '1.1'].indexOf(value.schemaVersion) < 0 || USER_RESPONSE_TYPES.indexOf(value.type) < 0
      || !Array.isArray(value.items) || value.items.length > 20
      || !Array.isArray(value.actions) || value.actions.length > 8) fail('user response 无效');
    var actions = value.actions.map(projectUserResponseAction);
    if (new Set(actions.map(function (action) { return action.id; })).size !== actions.length) fail('user response action 标识重复');
    if (value.type === 'clarification' && actions.some(function (action) { return action.kind !== 'reply'; })) fail('clarification action 无效');
    if (value.type === 'navigation' && (!actions.length || actions.some(function (action) { return action.kind !== 'navigate'; }))) fail('navigation action 无效');
    var source = value.source == null ? null : projectUserResponseSource(value.source);
    if ((value.type === 'answer') !== Boolean(source)) fail('user response source 状态冲突');
    var taskProgress = value.taskProgress == null ? null : projectTaskProgress(value.taskProgress);
    if (taskProgress && (value.schemaVersion !== '1.1'
      || ['clarification', 'confirmation', 'result'].indexOf(value.type) < 0)) fail('task progress 状态冲突');
    return {
      schemaVersion: value.schemaVersion, type: value.type,
      title: userText(value.title, 'user response title', 80),
      body: userText(value.body, 'user response body', 600),
      items: userTextList(value.items, 'user response items', 20, 240),
      actions: actions, source: source,
      ...(taskProgress ? { taskProgress: taskProgress } : {}),
    };
  }

  function projectTaskProgress(value) {
    plain(value, 'task progress');
    exactKeys(value, ['mode', 'current', 'total', 'completed', 'failed', 'skipped'], 'task progress');
    var counters = ['current', 'total', 'completed', 'failed', 'skipped'];
    if (value.mode !== 'sequential' || counters.some(function (name) { return !Number.isInteger(value[name]); })
      || value.current < 1 || value.total < 1 || value.total > 16 || value.current > value.total
      || value.completed < 0 || value.failed < 0 || value.skipped < 0
      || value.completed + value.failed + value.skipped >= value.total) fail('task progress 无效');
    return {
      mode: value.mode, current: value.current, total: value.total,
      completed: value.completed, failed: value.failed, skipped: value.skipped,
    };
  }

  function projectClarificationForm(value) {
    plain(value, 'clarification form');
    exactKeys(value, ['schemaVersion', 'clarificationId', 'submissionToken', 'expiresAt', 'kind', 'fields'], 'clarification form');
    if (value.schemaVersion !== '1.0' || !/^acl_[A-Za-z0-9_-]{1,92}$/.test(value.clarificationId || '')
      || typeof value.submissionToken !== 'string' || value.submissionToken.length < 32 || value.submissionToken.length > 256
      || typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt))
      || ['transfer_payee', 'transfer_full'].indexOf(value.kind) < 0 || !Array.isArray(value.fields)
      || value.fields.length < 2 || value.fields.length > 8) fail('clarification form 无效');
    var types = { payeeName: 'text', accountNo: 'bank_account', bankName: 'bank_name', purpose: 'text', savePayee: 'boolean', amount: 'amount', fromAccount: 'select' };
    var allowedNames = { payeeName: true, accountNo: true, bankName: true, purpose: true, savePayee: true, amount: true, fromAccount: true };
    var fields = value.fields.map(function (field) {
      plain(field, 'clarification field');
      exactKeys(field, ['name', 'label', 'type', 'required', 'value', 'editable', 'options'], 'clarification field');
      if (!allowedNames[field.name] || !types[field.name] || types[field.name] !== field.type
        || typeof field.required !== 'boolean' || typeof field.editable !== 'boolean'
        || (field.name === 'savePayee' ? typeof field.value !== 'boolean' : typeof field.value !== 'string')
        || (field.name === 'accountNo' && field.value !== '' && !/^\*[\*\s]*\d{0,4}$/.test(field.value))) fail('clarification field 无效');
      var projected = {
        name: field.name, label: userText(field.label, 'clarification field label', 40),
        type: field.type, required: field.required, value: field.value, editable: field.editable,
      };
      if (field.name === 'fromAccount' && Array.isArray(field.options)) {
        projected.options = field.options.map(function (opt) {
          if (!opt || typeof opt !== 'object'
            || typeof opt.label !== 'string' || opt.label.length < 1 || opt.label.length > 60
            || typeof opt.value !== 'string' || opt.value.length < 1 || opt.value.length > 60) fail('clarification field 选项无效');
          return { label: opt.label, value: opt.value };
        });
      }
      return projected;
    });
    var names = fields.map(function (field) { return field.name; });
    var requiredFields = value.kind === 'transfer_full'
      ? ['payeeName', 'accountNo', 'amount', 'bankName']
      : ['payeeName', 'accountNo', 'bankName'];
    if (new Set(names).size !== names.length || requiredFields.some(function (name) { return names.indexOf(name) < 0; })) fail('clarification fields 无效');
    return {
      schemaVersion: '1.0', clarificationId: value.clarificationId,
      submissionToken: value.submissionToken, expiresAt: value.expiresAt,
      kind: value.kind, fields: fields,
    };
  }

  function projectUserResponseActionForm(value) {
    if (value == null) return null;
    plain(value, 'action form');
    exactKeys(value, ['fields'], 'action form');
    if (!Array.isArray(value.fields) || value.fields.length < 1 || value.fields.length > 6) fail('action form 无效');
    return {
      fields: value.fields.map(function (field) {
        plain(field, 'action form field');
        exactKeys(field, ['name', 'label', 'type', 'required', 'options', 'placeholder'], 'action form field');
        if (typeof field.name !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(field.name)
          || ['text', 'number', 'select'].indexOf(field.type) < 0
          || typeof field.required !== 'boolean') fail('action form field 无效');
        var options = field.options == null ? [] : field.options;
        if (!Array.isArray(options) || options.length > 8
          || options.some(function (option) { return typeof option !== 'string' || !option || option.length > 40; })
          || (field.type === 'select' ? options.length < 2 : options.length > 0)) fail('action form field 无效');
        return {
          name: field.name,
          label: userText(field.label, 'form field label', 40, false),
          type: field.type,
          required: field.required,
          options: options,
          placeholder: field.placeholder == null ? null : userText(field.placeholder, 'form placeholder', 60, true),
        };
      }),
    };
  }

  function projectUserResponseAction(value) {
    plain(value, 'user response action');
    exactKeys(value, ['id', 'label', 'description', 'kind', 'interaction', 'payload', 'form'], 'user response action');
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(value.id)
      || ['reply', 'navigate', 'confirm', 'dismiss'].indexOf(value.kind) < 0) fail('user response action 无效');
    var action = {
      id: value.id,
      label: userText(value.label, 'action label', 80),
      description: value.description == null ? null : userText(value.description, 'action description', 160, true),
      kind: value.kind,
      interaction: null,
      payload: null,
    };
    plain(value.payload, 'action payload');
    exactKeys(value.payload, value.kind === 'reply'
      ? ['message']
      : value.kind === 'navigate'
        ? ['channel', 'featureId', 'actionId']
        : [], 'action payload');
    if (value.kind === 'reply') {
      if (value.interaction != null && ['submit', 'compose'].indexOf(value.interaction) < 0) {
        fail('reply interaction 无效');
      }
      action.interaction = value.interaction || 'compose';
      action.payload = { message: userText(value.payload.message, 'reply message', 240) };
      var form = projectUserResponseActionForm(Object.prototype.hasOwnProperty.call(value, 'form') ? value.form : null);
      if (form != null) {
        if (action.interaction !== 'compose') fail('action form 仅限 compose 交互');
        action.form = form;
      }
    } else if (value.kind === 'navigate') {
      if (value.interaction != null) fail('action interaction 无效');
      if (!/^[a-z][a-z0-9-]{0,31}$/.test(value.payload.channel)
        || !/^[a-z][a-z0-9-]{0,63}$/.test(value.payload.featureId)
        || !/^[a-z][a-z0-9-]{0,63}$/.test(value.payload.actionId)) fail('navigate target 无效');
      action.payload = {
        channel: value.payload.channel,
        featureId: value.payload.featureId,
        actionId: value.payload.actionId,
      };
    } else {
      if (value.interaction != null) fail('action interaction 无效');
      action.payload = {};
    }
    return action;
  }

  function projectUserResponseSource(value) {
    plain(value, 'user response source');
    exactKeys(value, ['id', 'version', 'label'], 'user response source');
    if (typeof value.id !== 'string' || value.id.length > 128 || !/^faq\.[a-z0-9.-]+$/.test(value.id)
      || typeof value.version !== 'string' || value.version.length > 32 || !/^\d+\.\d+\.\d+$/.test(value.version)
      || value.label !== 'Mock 业务知识') fail('user response source 无效');
    return { id: value.id, version: value.version, label: value.label };
  }

  function userTextList(value, label, maximumItems, maximumLength) {
    if (!Array.isArray(value) || value.length > maximumItems) fail(label + ' 无效');
    return value.map(function (item) { return userText(item, label, maximumLength); });
  }

  function userText(value, label, maximum, allowEmpty) {
    if (typeof value !== 'string' || (!allowEmpty && !value) || codePointLength(value) > maximum) fail(label + ' 无效');
    var canonical = value.normalize('NFKC').toLowerCase();
    var forms = decodedSecurityForms(canonical);
    if (forms.some(function (candidate) { return /[<>\p{C}]/u.test(candidate); })) fail(label + ' 无效');
    if (containsUrlLikeText(canonical)) fail(label + ' 包含任意链接');
    if (forms.some(function (candidate) {
      var compact = candidate.replace(/[\p{P}\p{Z}\p{S}\p{M}\p{C}]/gu, '');
      return USER_TEXT_INTERNAL_MARKERS.some(function (marker) { return compact.indexOf(marker) >= 0; });
    })) fail(label + ' 包含内部字段');
    if (forms.some(function (candidate) {
      return candidate.split(/\r?\n/u).some(function (line) {
        return longestDigitChain(line) >= 15;
      });
    })) fail(label + ' 包含未脱敏账号');
    return value;
  }

  function userMultiLineText(value, label, maximum) {
    if (typeof value !== 'string' || !value || codePointLength(value) > maximum) fail(label + ' 无效');
    var canonical = value.normalize('NFKC').toLowerCase();
    var forms = decodedSecurityForms(canonical);
    if (forms.some(function (candidate) { return /[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(candidate); })) fail(label + ' 无效');
    if (containsUrlLikeText(canonical)) fail(label + ' 包含任意链接');
    if (forms.some(function (candidate) {
      var compact = candidate.replace(/[\p{P}\p{Z}\p{S}\p{M}\p{C}]/gu, '');
      return USER_TEXT_INTERNAL_MARKERS.some(function (marker) { return compact.indexOf(marker) >= 0; });
    })) fail(label + ' 包含内部字段');
    if (forms.some(function (candidate) {
      return candidate.split(/\r?\n/u).some(function (line) {
        return longestDigitChain(line) >= 15;
      });
    })) fail(label + ' 包含未脱敏账号');
    return value;
  }

  // 与网关侧（services/ai-native-bank/agent-runtime-client.js longestDigitChain）同语义：
  // 数字被不超过 2 个非数字字符衔接仍视为同一链；金额/期数/日期等短串金融文本不会误判，
  // 连续（含空格分组）的 16 位账号仍会拦截。整行数字计数会把"序号+期数+金额+到期日"误判为账号。
  function longestDigitChain(line) {
    var best = 0;
    var current = 0;
    var gap = 0;
    var inDigits = false;
    Array.from(line).forEach(function (character) {
      if (/\p{Nd}/u.test(character)) {
        current += 1;
        if (current > best) best = current;
        gap = 0;
        inDigits = true;
      } else if (inDigits) {
        gap += 1;
        if (gap > 2) {
          current = 0;
          inDigits = false;
        }
      }
    });
    return best;
  }

  function containsUrlLikeText(value) {
    return decodedSecurityForms(value).some(function (candidate) {
      return /[a-z][a-z0-9+.-]{0,31}:/iu.test(candidate)
        || /\/\//u.test(candidate)
        || /(?:www\.)/iu.test(candidate)
        || /(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?/u.test(candidate)
        || /\[[0-9a-f:.]+\](?::\d{1,5})?/iu.test(candidate)
        || /localhost(?::\d{1,5})?/iu.test(candidate)
        || /[\p{L}\p{N}._%+-]+@(?:[\p{L}\p{N}-]+\.)+[\p{L}]{2,63}/iu.test(candidate)
        || /[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,62}\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})(?::\d{1,5})?(?:[/?#][^\s]*)?/iu.test(candidate)
        || containsIdeographicBareDomain(candidate);
    });
  }

  function containsTraceUrlLikeText(forms) {
    return forms.some(function (candidate) {
      return /(?:https?|ftp|file|data|javascript|vbscript|ws|wss):/iu.test(candidate)
        || /\/\//u.test(candidate)
        || /(?:www\.)/iu.test(candidate)
        || /(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?/u.test(candidate)
        || /localhost(?::\d{1,5})?/iu.test(candidate)
        || /[\p{L}\p{N}._%+-]+@(?:[\p{L}\p{N}-]+\.)+[\p{L}]{2,63}/iu.test(candidate)
        || containsIdeographicBareDomain(candidate);
    });
  }

  function containsIdeographicBareDomain(value) {
    IDEOGRAPHIC_DOMAIN_PATTERN.lastIndex = 0;
    var match;
    while ((match = IDEOGRAPHIC_DOMAIN_PATTERN.exec(value)) !== null) {
      var before = match.index > 0 ? value[match.index - 1] : '';
      var after = value[match.index + match[0].length] || '';
      if (before === '。' || after === '。') continue;
      var labels = match[0].split('。');
      var tld = labels[labels.length - 1];
      if (/[a-z0-9]/iu.test(match[0]) || COMMON_IDN_TLDS.indexOf(tld) >= 0) return true;
    }
    return false;
  }

  function decodedSecurityForms(value) {
    var forms = [];
    var current = String(value).normalize('NFKC').toLowerCase().replace(/[\uff0e\uff61]/gu, '.');
    for (var pass = 0; pass < 8; pass += 1) {
      if (forms.indexOf(current) < 0) forms.push(current);
      var invalidRun = false;
      var decodedValue = current.replace(/(?:%[0-9a-f]{2})+/giu, function (run) {
        try {
          return decodeURIComponent(run);
        } catch (_) {
          invalidRun = true;
          return run;
        }
      });
      if (invalidRun) fail('编码文本无效');
      var decoded = decodedValue.normalize('NFKC').toLowerCase()
        .replace(/[\uff0e\uff61]/gu, '.');
      if (decoded === current) break;
      current = decoded;
      if (forms.indexOf(current) < 0) forms.push(current);
      if (pass === 7) {
        var probeInvalid = false;
        var probe = current.replace(/(?:%[0-9a-f]{2})+/giu, function (run) {
          try {
            return decodeURIComponent(run);
          } catch (_) {
            probeInvalid = true;
            return run;
          }
        });
        if (probeInvalid || probe !== current) fail('编码层级无效');
      }
    }
    return forms;
  }

  function codePointLength(value) {
    return Array.from(value).length;
  }

  function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.freeze(value);
    Object.keys(value).forEach(function (key) { deepFreeze(value[key]); });
    return value;
  }

  return {
    TraceViewError: TraceViewError,
    createRunState: createRunState,
    createSseParserState: createSseParserState,
    parseSseChunk: parseSseChunk,
    reduceEvent: reduceEvent,
    resumeConfirmation: resumeConfirmation,
    projectAgentDelivery: projectAgentDelivery,
    formatDuration: formatDuration,
    getTraceGroups: getTraceGroups,
    getRunPresentation: getRunPresentation,
    getNodeResultPreview: getNodeResultPreview,
  };
});
