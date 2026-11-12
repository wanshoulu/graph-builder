(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.AINativeBankAgentView = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SHAPES = ['single_intent', 'multi_intent', 'same_intent_multi_task', 'ambiguous_intent', 'non_task'];
  var STATUSES = ['planned', 'clarification_required', 'navigation_only', 'unsupported', 'blocked'];
  var ACTIONS = ['ASK', 'QUERY', 'NAVIGATE', 'DO', 'CHANGE', 'CANCEL', 'HELP'];
  var READINESS = ['ready', 'needs_slots', 'needs_clarification', 'navigation_only', 'unsupported'];
  var RISKS = ['L0', 'L1', 'L2', 'L3'];

  function AgentViewError(message) {
    Error.call(this, message || 'Agent 结果无法识别');
    this.name = 'AgentViewError';
    this.message = message || 'Agent 结果无法识别';
  }
  AgentViewError.prototype = Object.create(Error.prototype);
  AgentViewError.prototype.constructor = AgentViewError;

  function fail(message) { throw new AgentViewError(message); }
  function object(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(label + ' 格式无效');
    return value;
  }
  function keys(value, allowed, label) {
    var unknown = Object.keys(value).filter(function (key) { return allowed.indexOf(key) < 0; });
    if (unknown.length) fail(label + ' 包含不允许的字段');
  }
  function text(value, label, maximum, pattern) {
    if (typeof value !== 'string' || !value || value.length > maximum || /[<>\u0000-\u001f\u007f]/.test(value)) {
      fail(label + ' 包含不安全文本');
    }
    if (pattern && !pattern.test(value)) fail(label + ' 格式无效');
    return value;
  }
  function choice(value, allowed, label) {
    if (allowed.indexOf(value) < 0) fail(label + ' 无效');
    return value;
  }
  function stringArray(value, label, maximum, pattern) {
    if (!Array.isArray(value) || value.length > maximum) fail(label + ' 格式无效');
    return value.map(function (item) { return text(item, label, 160, pattern); });
  }
  function safeJson(value, depth, state) {
    if (depth > 8 || ++state.nodes > 1024) fail('结构化字段过大');
    if (value == null || typeof value === 'boolean') return;
    if (typeof value === 'number') { if (!Number.isFinite(value)) fail('结构化字段无效'); return; }
    if (typeof value === 'string') { text(value, '结构化字段', 4000); return; }
    if (Array.isArray(value)) {
      if (value.length > 128) fail('结构化字段过大');
      value.forEach(function (item) { safeJson(item, depth + 1, state); });
      return;
    }
    object(value, '结构化字段');
    if (Object.keys(value).length > 128) fail('结构化字段过大');
    Object.keys(value).forEach(function (key) {
      text(key, '结构化字段键', 128, /^[A-Za-z0-9_.:-]+$/);
      safeJson(value[key], depth + 1, state);
    });
  }

  function projectTask(item) {
    object(item, '任务');
    keys(item, ['task_id', 'intent_id', 'action', 'business_object', 'slots', 'dependencies', 'execution_readiness', 'risk_level'], '任务');
    var taskId = text(item.task_id, 'task_id', 96, /^[A-Za-z0-9_.:-]+$/);
    var slots = object(item.slots, 'slots');
    if (Object.keys(slots).length > 64) fail('slots 过大');
    Object.keys(slots).forEach(function (slotName) {
      text(slotName, 'slot', 128, /^[A-Za-z0-9_.:-]+$/);
      var slot = object(slots[slotName], 'slot');
      keys(slot, ['value', 'source', 'confidence'], 'slot');
      choice(slot.source, ['user_explicit', 'user_selection', 'context', 'intent_default'], 'slot source');
      if (typeof slot.confidence !== 'number' || slot.confidence < 0 || slot.confidence > 1) fail('slot confidence 无效');
      safeJson(slot.value, 0, { nodes: 0 });
    });
    return {
      id: taskId,
      intentId: text(item.intent_id, 'intent_id', 160, /^[A-Za-z0-9_.:-]+$/),
      action: choice(item.action, ACTIONS, 'action'),
      businessObject: text(item.business_object, 'business_object', 128, /^[A-Za-z0-9_.:-]+$/),
      readiness: choice(item.execution_readiness, READINESS, 'execution_readiness'),
      risk: choice(item.risk_level, RISKS, 'risk_level'),
      dependencies: stringArray(item.dependencies, 'task dependencies', 32, /^[A-Za-z0-9_.:-]+$/),
      slotNames: Object.keys(slots),
    };
  }

  function projectStep(item, taskIds) {
    object(item, '计划步骤');
    keys(item, ['step_id', 'task_id', 'capability_id', 'input_bindings', 'requires_user_confirmation', 'depends_on'], '计划步骤');
    var taskId = text(item.task_id, 'step task_id', 96, /^[A-Za-z0-9_.:-]+$/);
    if (taskIds.indexOf(taskId) < 0) fail('计划步骤引用未知任务');
    var bindings = object(item.input_bindings, 'input_bindings');
    safeJson(bindings, 0, { nodes: 0 });
    if (typeof item.requires_user_confirmation !== 'boolean') fail('确认标记无效');
    return {
      id: text(item.step_id, 'step_id', 96, /^[A-Za-z0-9_.:-]+$/),
      taskId: taskId,
      capabilityId: text(item.capability_id, 'capability_id', 128, /^bank\.[a-z0-9.-]+$/),
      inputKeys: Object.keys(bindings),
      requiresConfirmation: item.requires_user_confirmation,
      dependencies: stringArray(item.depends_on, 'step dependencies', 32, /^[A-Za-z0-9_.:-]+$/),
    };
  }

  function uniqueGraph(items, dependencyKey, label) {
    var ids = items.map(function (item) { return item.id; });
    if (new Set(ids).size !== ids.length) fail(label + ' 标识重复');
    items.forEach(function (item) {
      item[dependencyKey].forEach(function (dependency) {
        if (dependency === item.id || ids.indexOf(dependency) < 0) fail(label + ' 依赖关系无效');
      });
    });
  }

  function toAgentView(run) {
    object(run, 'Agent Run');
    keys(run, ['agentRunId', 'conversationId', 'status', 'intentTaskEnvelope', 'capabilityPlan', 'businessWorkflow'], 'Agent Run');
    var id = text(run.agentRunId, 'agentRunId', 96, /^[A-Za-z0-9_.:-]+$/);
    var conversationId = text(run.conversationId, 'conversationId', 96, /^[A-Za-z0-9_.:-]+$/);
    var status = choice(run.status, STATUSES, 'status');
    var envelope = object(run.intentTaskEnvelope, '意图任务信封');
    keys(envelope, ['schema_version', 'delegation_id', 'trace_id', 'conversation_id', 'source_agent_run_id', 'intent_shape', 'tasks', 'predicted_next_intents'], '意图任务信封');
    if (envelope.schema_version !== '1.0') fail('意图任务版本无效');
    if (envelope.source_agent_run_id !== id || envelope.conversation_id !== conversationId) fail('资源标识不一致');
    var shape = choice(envelope.intent_shape, SHAPES, 'intent_shape');
    if (!Array.isArray(envelope.tasks) || envelope.tasks.length > 16) fail('tasks 格式无效');
    var tasks = envelope.tasks.map(projectTask);
    if (shape === 'single_intent' && tasks.length !== 1) fail('意图任务数量无效');
    if ((shape === 'multi_intent' || shape === 'same_intent_multi_task') && tasks.length < 2) fail('意图任务数量无效');
    if ((shape === 'ambiguous_intent' || shape === 'non_task') && tasks.length) fail('意图任务数量无效');
    uniqueGraph(tasks, 'dependencies', '任务');

    var plan = object(run.capabilityPlan, '能力计划');
    keys(plan, ['schema_version', 'business_agent_run_id', 'delegation_id', 'status', 'steps'], '能力计划');
    if (plan.schema_version !== '1.0' || plan.delegation_id !== envelope.delegation_id || plan.status !== status) fail('能力计划关联无效');
    text(plan.business_agent_run_id, 'business_agent_run_id', 96, /^[A-Za-z0-9_.:-]+$/);
    if (!Array.isArray(plan.steps) || plan.steps.length > 64) fail('steps 格式无效');
    var taskIds = tasks.map(function (item) { return item.id; });
    var steps = plan.steps.map(function (item) { return projectStep(item, taskIds); });
    uniqueGraph(steps, 'dependencies', '计划步骤');
    if (status === 'planned' && !steps.length) fail('能力计划步骤缺失');
    if ((status === 'navigation_only' || status === 'unsupported') && steps.length) fail('能力计划状态无效');

    var businessAgent = null;
    if (run.businessWorkflow != null) {
      var workflow = object(run.businessWorkflow, 'Business Agent 状态');
      keys(workflow, ['loopIteration', 'todoRevision', 'currentTodoStatus', 'delegatedTaskCount', 'coveredTaskCount'], 'Business Agent 状态');
      ['loopIteration', 'todoRevision', 'delegatedTaskCount', 'coveredTaskCount'].forEach(function (key) {
        if (!Number.isInteger(workflow[key]) || workflow[key] < 0 || workflow[key] > 1000000) fail('Business Agent 计数无效');
      });
      businessAgent = {
        loopIteration: workflow.loopIteration,
        todoRevision: workflow.todoRevision,
        currentTodoStatus: choice(workflow.currentTodoStatus, ['pending', 'in_progress', 'awaiting_clarification', 'awaiting_confirmation', 'completed', 'partial_success', 'failed', 'temporarily_unavailable'], 'Todo 状态'),
        delegatedTaskCount: workflow.delegatedTaskCount,
        coveredTaskCount: workflow.coveredTaskCount,
      };
      if (businessAgent.coveredTaskCount > businessAgent.delegatedTaskCount) fail('Business Agent 覆盖数无效');
    }

    return {
      id: id,
      conversationId: conversationId,
      delegationId: text(envelope.delegation_id, 'delegation_id', 96, /^[A-Za-z0-9_.:-]+$/),
      status: status,
      intentShape: shape,
      tasks: tasks,
      steps: steps,
      predictedNextIntents: stringArray(envelope.predicted_next_intents, 'predicted intents', 8, /^[A-Za-z0-9_.:-]+$/),
      requiresConfirmation: steps.some(function (step) { return step.requiresConfirmation; }),
      userAgent: { intentShape: shape, taskCount: tasks.length },
      businessAgent: businessAgent,
    };
  }

  return { AgentViewError: AgentViewError, toAgentView: toAgentView };
});
