(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.AINativeBankNextAction = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var ITEM_KEYS = [
    'recommendationId', 'scenarioId', 'scenarioVersion', 'type', 'title', 'priority',
    'reasonCodes', 'reasonText', 'action', 'targetIntentId', 'workflowTemplateId',
    'requiredSkillIds', 'requiredCapabilityIds', 'catalogAction', 'surface', 'channel',
    'status', 'score', 'rank', 'generatedAt', 'expiresAt', 'shownAt', 'acceptedAt',
    'completedAt', 'outcome',
  ];
  // 记忆富化字段为可选：服务端仅在个性化命中时附加，展示层只认"按你设定"标注。
  var ITEM_OPTIONAL_KEYS = ['memoryEnriched', 'memoryFacts'];
  var MEMORY_FACT_KEYS = ['predicate', 'safeLabel', 'safeValueSummary', 'evidenceRef', 'requiresConfirmation'];
  var ACTION_LABELS = Object.freeze({
    START_ASSISTANCE: '开始办理', OPEN_CATALOG: '查看服务', RESUME_WORKFLOW: '继续办理',
  });
  var WORKFLOW_ACTION_LABELS = Object.freeze({
    adjust: '调整方案', pause: '稍后继续', resume: '继续办理', cancel: '取消办理',
    retry_failed: '重试失败项', handoff: '人工帮助',
  });

  function fail() { throw new Error('invalid_next_action_view'); }
  function exact(value, keys) {
    return value && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).length === keys.length
      && Object.keys(value).every(function (key) { return keys.indexOf(key) >= 0; });
  }
  function freeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.values(value).forEach(freeze);
    return Object.freeze(value);
  }
  function id(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(value)) fail();
    return value;
  }
  function text(value, maximum) {
    if (typeof value !== 'string' || !value || value.length > maximum || /[<>]/.test(value)) fail();
    return value;
  }
  function timestamp(value) {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail();
    return value;
  }
  function ids(value, maximum) {
    if (!Array.isArray(value) || value.length > maximum) fail();
    value.forEach(id);
  }

  function validateItem(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail();
    if (!ITEM_KEYS.every(function (key) { return Object.prototype.hasOwnProperty.call(item, key); })) fail();
    var unknown = Object.keys(item).filter(function (key) {
      return ITEM_KEYS.indexOf(key) < 0 && ITEM_OPTIONAL_KEYS.indexOf(key) < 0;
    });
    if (unknown.length) fail();
    id(item.recommendationId); id(item.scenarioId);
    if (!/^\d+\.\d+\.\d+$/.test(item.scenarioVersion)
      || ['resume_task', 'proactive_service', 'next_intent'].indexOf(item.type) < 0
      || ['critical', 'high', 'normal', 'low'].indexOf(item.priority) < 0
      || ['home', 'agent', 'channel'].indexOf(item.surface) < 0
      || (item.surface === 'channel') !== Boolean(item.channel)
      || ['generated', 'shown', 'accepted', 'dismissed', 'snoozed', 'expired', 'started', 'completed'].indexOf(item.status) < 0
      || !Object.prototype.hasOwnProperty.call(ACTION_LABELS, item.action)
      || !Number.isSafeInteger(item.score) || item.score < 0
      || !Number.isInteger(item.rank) || item.rank < 1 || item.rank > 3) fail();
    text(item.title, 80); text(item.reasonText, 160);
    ids(item.reasonCodes, 8); ids(item.requiredSkillIds, 16); ids(item.requiredCapabilityIds, 32);
    if (item.targetIntentId !== null) id(item.targetIntentId);
    if (item.workflowTemplateId !== null) id(item.workflowTemplateId);
    if (item.channel !== null) id(item.channel);
    if (item.catalogAction !== null) {
      if (!exact(item.catalogAction, ['channel', 'item', 'action'])) fail();
      id(item.catalogAction.channel); id(item.catalogAction.item); id(item.catalogAction.action);
    }
    timestamp(item.generatedAt); timestamp(item.expiresAt);
    ['shownAt', 'acceptedAt', 'completedAt'].forEach(function (field) {
      if (item[field] !== null) timestamp(item[field]);
    });
    if (item.outcome !== null) {
      var encoded;
      try { encoded = JSON.stringify(item.outcome); } catch (_) { fail(); }
      if (!encoded || encoded.length > 4096 || /[<>]/.test(encoded)) fail();
    }
    if (item.memoryEnriched !== undefined) {
      if (item.memoryEnriched !== true || !Array.isArray(item.memoryFacts)
        || item.memoryFacts.length < 1 || item.memoryFacts.length > 4) fail();
      item.memoryFacts.forEach(function (fact) {
        if (!exact(fact, MEMORY_FACT_KEYS)) fail();
        id(fact.predicate); id(fact.evidenceRef);
        text(fact.safeLabel, 80); text(fact.safeValueSummary, 160);
        if (typeof fact.requiresConfirmation !== 'boolean') fail();
      });
    } else if (item.memoryFacts !== undefined) {
      fail();
    }
    return item;
  }

  function projectNextActionCards(page) {
    if (!exact(page, ['schemaVersion', 'mode', 'generatedAt', 'personalizationEnabled', 'items'])
      || page.schemaVersion !== '1.0' || ['deterministic', 'hybrid'].indexOf(page.mode) < 0
      || typeof page.personalizationEnabled !== 'boolean'
      || !Array.isArray(page.items) || page.items.length > 3) fail();
    timestamp(page.generatedAt);
    return freeze(page.items.map(function (raw) {
      var item = validateItem(raw);
      return {
        recommendationId: item.recommendationId,
        type: item.type,
        title: item.title,
        priority: item.priority,
        reasonText: item.reasonText,
        action: item.action,
        actionLabel: ACTION_LABELS[item.action],
        status: item.status,
        workflowTemplateId: item.workflowTemplateId,
        catalogAction: item.catalogAction ? { ...item.catalogAction } : null,
        memoryEnriched: item.memoryEnriched === true,
      };
    }));
  }

  function projectLegacyDetail(detail, fallbackDescription) {
    if (detail === undefined || detail === null) return {
      headline: fallbackDescription,
      metrics: [],
      items: [],
      insights: [],
      suggestion: fallbackDescription,
      callToAction: null,
    };
    var hasItems = exact(detail, ['headline', 'metrics', 'items', 'insights', 'suggestion']);
    var hasCallToAction = exact(detail, [
      'headline', 'metrics', 'items', 'insights', 'suggestion', 'callToAction',
    ]);
    if ((!hasItems && !hasCallToAction
      && !exact(detail, ['headline', 'metrics', 'insights', 'suggestion']))
      || !Array.isArray(detail.metrics) || detail.metrics.length > 8
      || ((hasItems || hasCallToAction) && (!Array.isArray(detail.items) || detail.items.length > 32))
      || !Array.isArray(detail.insights) || detail.insights.length > 8) fail();
    text(detail.headline, 240); text(detail.suggestion, 240);
    return {
      headline: detail.headline,
      metrics: detail.metrics.map(function (metric) {
        if (!exact(metric, ['label', 'value'])) fail();
        text(metric.label, 80); text(metric.value, 160);
        return { label: metric.label, value: metric.value };
      }),
      items: (hasItems || hasCallToAction ? detail.items : []).map(function (item) {
        var legacyItem = exact(item, ['id', 'title', 'subtitle', 'amount', 'status']);
        var actionableItem = exact(item, [
          'id', 'type', 'title', 'subtitle', 'amount', 'availability', 'action',
        ])
          && ['credit_card', 'loan', 'utility'].indexOf(item.type) >= 0;
        if ((!legacyItem && !actionableItem)
          || !exact(item.amount, ['amountMinor', 'currency', 'display'])
          || !Number.isSafeInteger(item.amount.amountMinor) || item.amount.amountMinor < 0
          || item.amount.currency !== 'CNY') fail();
        id(item.id); text(item.title, 120); text(item.subtitle, 120);
        text(item.amount.display, 40);
        var projected = {
          id: item.id, title: item.title, subtitle: item.subtitle,
          amount: {
            amountMinor: item.amount.amountMinor,
            currency: item.amount.currency,
            display: item.amount.display,
          },
        };
        if (legacyItem) {
          projected.status = text(item.status, 40);
          return projected;
        }
        projected.type = item.type;
        if (!exact(item.availability, ['state', 'reason'])
          || ['available', 'needs_information', 'unavailable'].indexOf(item.availability.state) < 0
          || (item.availability.reason !== null && !text(item.availability.reason, 120))) fail();
        projected.availability = {
          state: item.availability.state,
          reason: item.availability.reason,
        };
        projected.action = projectDetailItemAction(item.action, item.availability.state);
        return projected;
      }),
      insights: detail.insights.map(function (insight) { return text(insight, 240); }),
      suggestion: detail.suggestion,
      callToAction: hasCallToAction ? projectDetailCallToAction(detail.callToAction) : null,
    };
  }

  function projectDetailItemAction(action, availabilityState) {
    if (action === null) {
      if (availabilityState === 'available') fail();
      return null;
    }
    if (!exact(action, ['id', 'kind', 'label', 'targetIntentId', 'activationPhrases'])
      || ['agent_plan', 'agent_consult'].indexOf(action.kind) < 0
      || !Array.isArray(action.activationPhrases)
      || action.activationPhrases.length < 1 || action.activationPhrases.length > 6) fail();
    id(action.id); id(action.targetIntentId); text(action.label, 40);
    return {
      id: action.id,
      kind: action.kind,
      label: action.label,
      activationPhrases: action.activationPhrases.map(function (phrase) { return text(phrase, 80); }),
    };
  }

  function projectDetailCallToAction(value) {
    if (!exact(value, ['message', 'primaryLabel', 'activationPhrases', 'confirmationHint'])
      || !Array.isArray(value.activationPhrases)
      || value.activationPhrases.length < 1 || value.activationPhrases.length > 8) fail();
    return {
      message: text(value.message, 160),
      primaryLabel: text(value.primaryLabel, 80),
      activationPhrases: value.activationPhrases.map(function (phrase) { return text(phrase, 80); }),
      confirmationHint: text(value.confirmationHint, 160),
    };
  }

  function resolveDetailAction(detail, input) {
    if (!detail || typeof detail !== 'object' || typeof input !== 'string') return null;
    var phrase = input.trim();
    if (!phrase) return null;
    var callToAction = detail.callToAction;
    if (callToAction && Array.isArray(callToAction.activationPhrases)
      && callToAction.activationPhrases.indexOf(phrase) >= 0) {
      return freeze({ kind: 'recommendation', serviceActionId: null });
    }
    var matches = [];
    (Array.isArray(detail.items) ? detail.items : []).forEach(function (item) {
      if (item && item.action && Array.isArray(item.action.activationPhrases)
        && item.action.activationPhrases.indexOf(phrase) >= 0) matches.push(item.action);
    });
    if (matches.length !== 1) return null;
    return freeze({ kind: matches[0].kind, serviceActionId: matches[0].id });
  }

  function projectLegacyActions(actions, recommendationId) {
    if (actions === undefined || actions === null) return [];
    if (!Array.isArray(actions) || actions.length > 6) fail();
    return actions.map(function (action) {
      if (!action || typeof action !== 'object' || Array.isArray(action)) fail();
      if (action.kind === 'task') {
        if (!exact(action, ['id', 'label', 'kind', 'prompt'])) fail();
        id(action.id); text(action.label, 80); text(action.prompt, 240);
        return { id: action.id, label: action.label, kind: action.kind, prompt: action.prompt };
      }
      if (action.kind === 'catalog') {
        if (!exact(action, ['id', 'label', 'kind', 'channel', 'item', 'action'])) fail();
        id(action.id); text(action.label, 80);
        id(action.channel); id(action.item); id(action.action);
        return {
          id: action.id, label: action.label, kind: action.kind,
          channel: action.channel, item: action.item, action: action.action,
        };
      }
      if (action.kind === 'recommendation') {
        if (!exact(action, ['id', 'label', 'kind', 'recommendationId'])) fail();
        id(action.id); text(action.label, 80); id(action.recommendationId);
        if (action.recommendationId !== recommendationId) fail();
        return {
          id: action.id, label: action.label, kind: action.kind,
          recommendationId: action.recommendationId,
        };
      }
      fail();
    });
  }

  function projectLegacyRecommendationCards(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || !Array.isArray(value.recommendations) || value.recommendations.length > 16) fail();
    return freeze(value.recommendations.slice(0, 3).map(function (item) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) fail();
      id(item.id); text(item.title, 80); text(item.description, 160);
      var amount = null;
      if (Object.prototype.hasOwnProperty.call(item, 'amount') && item.amount !== null) {
        if (!exact(item.amount, ['amountMinor', 'currency', 'display'])
          || !Number.isSafeInteger(item.amount.amountMinor) || item.amount.amountMinor < 0
          || item.amount.currency !== 'CNY') fail();
        text(item.amount.display, 40);
        amount = {
          amountMinor: item.amount.amountMinor,
          currency: item.amount.currency,
          display: item.amount.display,
        };
      }
      var safetyHint = null;
      if (Object.prototype.hasOwnProperty.call(item, 'safetyHint') && item.safetyHint !== null) {
        text(item.safetyHint, 160);
        safetyHint = item.safetyHint;
      }
      if (typeof item.type !== 'string' || !/^[a-z][a-z0-9_-]{1,63}$/.test(item.type)
        || ['critical', 'high', 'medium', 'low'].indexOf(item.priority) < 0) fail();
      var primaryLabel = item.actions && item.actions[0]
        && typeof item.actions[0].label === 'string'
        && item.actions[0].label.length > 0 && item.actions[0].label.length <= 80
        ? item.actions[0].label : null;
      if (primaryLabel) text(primaryLabel, 80);
      return {
        recommendationId: item.id,
        type: item.type,
        title: item.title,
        priority: item.priority === 'medium' ? 'normal' : item.priority,
        reasonText: item.description,
        action: 'LEGACY_DETAIL',
        actionLabel: primaryLabel,
        status: 'shown',
        amount: amount,
        safetyHint: safetyHint,
        workflowTemplateId: null,
        catalogAction: null,
        legacyRecord: {
          id: item.id,
          type: item.type,
          title: item.title,
          description: item.description,
          safetyHint: safetyHint,
          prompt: typeof item.prompt === 'string' && item.prompt.length <= 240
            && !/[<>]/.test(item.prompt) ? item.prompt : item.title,
          detail: projectLegacyDetail(item.detail, item.description),
          actions: projectLegacyActions(item.actions, item.id),
        },
      };
    }));
  }

  function projectResumableWorkflowCards(value) {
    if (!Array.isArray(value) || value.length > 8) fail();
    return freeze(value.map(function (item, index) {
      if (!exact(item, [
        'businessTitle', 'completedTodoCount', 'totalTodoCount',
        'updatedAt', 'riskLevel', 'maskedObject',
      ])) fail();
      text(item.businessTitle, 240); text(item.maskedObject, 240);
      if (!Number.isInteger(item.completedTodoCount) || item.completedTodoCount < 0
        || !Number.isInteger(item.totalTodoCount) || item.totalTodoCount < 1
        || item.completedTodoCount > item.totalTodoCount
        || !/^L[0-3]$/.test(item.riskLevel)) fail();
      timestamp(item.updatedAt);
      return {
        key: 'resume-' + (index + 1),
        title: item.businessTitle,
        progressText: item.completedTodoCount + '/' + item.totalTodoCount,
        maskedObject: item.maskedObject,
        updatedAt: item.updatedAt,
        action: 'resume',
        actionLabel: WORKFLOW_ACTION_LABELS.resume,
      };
    }));
  }

  function projectGuidedWorkflow(workflow) {
    var keys = [
      'businessWorkflowId', 'title', 'status', 'completedTodoCount', 'totalTodoCount',
      'changedData', 'steps', 'allowedActions',
    ];
    if (!exact(workflow, keys)) fail();
    id(workflow.businessWorkflowId); text(workflow.title, 120);
    if (['running', 'awaiting_confirmation', 'suspended', 'partially_completed', 'completed', 'failed'].indexOf(workflow.status) < 0
      || !Number.isInteger(workflow.completedTodoCount) || workflow.completedTodoCount < 0
      || !Number.isInteger(workflow.totalTodoCount) || workflow.totalTodoCount < 1
      || workflow.completedTodoCount > workflow.totalTodoCount
      || typeof workflow.changedData !== 'boolean'
      || !Array.isArray(workflow.steps) || workflow.steps.length > 32
      || !Array.isArray(workflow.allowedActions) || workflow.allowedActions.length > 6) fail();
    var steps = workflow.steps.map(function (step) {
      if (!exact(step, ['id', 'title', 'status'])) fail();
      id(step.id); text(step.title, 120);
      if (['pending', 'in_progress', 'awaiting_confirmation', 'completed', 'failed', 'cancelled'].indexOf(step.status) < 0) fail();
      return { id: step.id, title: step.title, status: step.status };
    });
    var seen = {};
    var actions = workflow.allowedActions.map(function (actionId) {
      if (!Object.prototype.hasOwnProperty.call(WORKFLOW_ACTION_LABELS, actionId) || seen[actionId]) fail();
      seen[actionId] = true;
      return { id: actionId, label: WORKFLOW_ACTION_LABELS[actionId] };
    });
    return freeze({
      businessWorkflowId: workflow.businessWorkflowId,
      title: workflow.title,
      status: workflow.status,
      progressText: workflow.completedTodoCount + '/' + workflow.totalTodoCount,
      changedData: workflow.changedData,
      steps: steps,
      actions: actions,
    });
  }

  function projectNextActionEmptyState() {
    return freeze({
      title: '暂无新的推荐',
      description: '您仍可以从常用服务或智能助手发起办理。',
    });
  }

  return Object.freeze({
    projectNextActionCards: projectNextActionCards,
    projectLegacyRecommendationCards: projectLegacyRecommendationCards,
    resolveDetailAction: resolveDetailAction,
    projectResumableWorkflowCards: projectResumableWorkflowCards,
    projectGuidedWorkflow: projectGuidedWorkflow,
    projectNextActionEmptyState: projectNextActionEmptyState,
  });
});
