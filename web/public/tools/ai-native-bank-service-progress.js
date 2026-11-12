(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.AINativeBankServiceProgress = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var STEP_RANK = { pending: 0, running: 1, skipped: 2, completed: 3, failed: 3 };
  var SAFE_ID = /^[A-Za-z0-9_.:-]{1,160}$/;
  var SAFE_STAGES = [
    'request.accepted', 'user_agent.completed', 'delegation.created',
    'business_agent.started', 'business_agent.completed',
    'business_skill.started', 'business_skill.completed',
    'capability.invocation_started', 'capability.invocation_completed',
    'plan.validated', 'run.awaiting_confirmation', 'run.completed', 'workflow.rebound'
  ];

  function copy(value) { return JSON.parse(JSON.stringify(value)); }
  function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.keys(value).forEach(function (key) { deepFreeze(value[key]); });
    return Object.freeze(value);
  }

  function validSnapshot(snapshot) {
    return Boolean(snapshot && snapshot.schemaVersion === '1.0' && Array.isArray(snapshot.profiles));
  }

  function profiles(snapshot) {
    return validSnapshot(snapshot) ? snapshot.profiles : [];
  }

  function profileById(snapshot, profileId) {
    return profiles(snapshot).find(function (profile) { return profile.id === profileId; }) || null;
  }

  function profileBySkill(snapshot, skillId) {
    if (!SAFE_ID.test(skillId || '')) return null;
    return profiles(snapshot).find(function (profile) {
      return Array.isArray(profile.skillIds) && profile.skillIds.indexOf(skillId) >= 0;
    }) || null;
  }

  function safeEvent(event) {
    if (!event || SAFE_STAGES.indexOf(event.stage) < 0) return null;
    var metrics = event.summary && event.summary.metrics || {};
    var result = event.summary && event.summary.result || {};
    return {
      stage: event.stage,
      sequence: Number.isInteger(event.sequence) && event.sequence >= 0 ? event.sequence : null,
      skillId: SAFE_ID.test(metrics.skillId || '') ? metrics.skillId : null,
      capabilityId: SAFE_ID.test(metrics.capabilityId || '') ? metrics.capabilityId : null,
      outcome: SAFE_ID.test(metrics.outcome || '') ? metrics.outcome : null,
      resultStatus: SAFE_ID.test(result.status || metrics.status || '')
        ? (result.status || metrics.status) : null
    };
  }

  function createState(requestId) {
    return deepFreeze({
      requestId: String(requestId),
      status: 'running',
      profileId: null,
      title: '智能服务处理进度',
      currentText: '正在理解你的需求…',
      summary: '',
      expanded: true,
      userExpanded: false,
      lastSequence: -1,
      events: [],
      steps: []
    });
  }

  function genericText(stage) {
    if (stage === 'user_agent.completed' || stage === 'delegation.created') return '已理解需求，正在组织服务…';
    if (stage === 'workflow.rebound') return '正在恢复未完成业务…';
    if (stage === 'business_agent.started' || stage === 'business_agent.completed'
      || stage === 'business_skill.started' || stage === 'business_skill.completed') return '正在生成办理方案…';
    if (stage === 'capability.invocation_started' || stage === 'capability.invocation_completed') return '正在调用核心查询服务…';
    if (stage === 'plan.validated') return '方案已生成，正在整理结果…';
    return '正在理解你的需求…';
  }

  function transitionMatches(transition, event) {
    if (transition.stage !== event.stage) return false;
    var match = transition.match || {};
    return Object.keys(match).every(function (key) { return event[key] === match[key]; });
  }

  function advanceStep(step, nextState) {
    if (!(nextState in STEP_RANK)) return step;
    if (STEP_RANK[nextState] < STEP_RANK[step.state]) return step;
    if ((step.state === 'completed' || step.state === 'failed') && step.state !== nextState) return step;
    return Object.assign({}, step, { state: nextState });
  }

  // run.completed 的 profile 迁移把剩余步骤全部置为 completed，只对成功终态成立；
  // 等待用户（澄清/确认）或失败时不能应用，否则面板会显示"已确认转账/正在执行转账"的假进度。
  function isNonSuccessRunCompleted(event) {
    if (event.stage !== 'run.completed') return false;
    return ['clarification_required', 'awaiting_confirmation',
      'blocked', 'unavailable', 'failed'].indexOf(event.resultStatus) >= 0;
  }

  function applyProfileEvent(state, profile, event) {
    if (isNonSuccessRunCompleted(event)) return state;
    var updates = [];
    (profile.transitions || []).forEach(function (transition) {
      if (transitionMatches(transition, event)) updates = updates.concat(transition.updates || []);
    });
    var steps = state.steps.map(function (step) {
      var update = updates.find(function (candidate) { return candidate.stepId === step.id; });
      return update ? advanceStep(step, update.state) : step;
    });
    var running = steps.find(function (step) { return step.state === 'running'; });
    return Object.assign({}, state, {
      steps: steps,
      currentText: running ? running.label : (state.currentText || '正在处理…')
    });
  }

  function bindProfile(state, profile) {
    var next = Object.assign({}, state, {
      profileId: profile.id,
      title: profile.title,
      currentText: profile.initialText || '正在处理…',
      steps: (profile.steps || []).map(function (step) {
        return { id: step.id, label: step.label, completedLabel: step.completedLabel, state: 'pending' };
      })
    });
    state.events.forEach(function (event) { next = applyProfileEvent(next, profile, event); });
    return next;
  }

  function finish(state, profile) {
    var failed = state.steps.some(function (step) { return step.state === 'failed'; });
    if (failed) return fail(state, { schemaVersion: '1.0', profiles: profile ? [profile] : [] });
    return Object.assign({}, state, {
      status: 'completed',
      expanded: state.userExpanded ? state.expanded : false,
      summary: profile ? profile.completionSummary : '服务分析已完成',
      currentText: profile ? profile.completionSummary : '服务分析已完成',
      steps: state.steps.map(function (step) {
        return step.state === 'skipped' ? step : advanceStep(step, 'completed');
      })
    });
  }

  function waitForUser(state, profile, resultStatus) {
    var summary = resultStatus === 'awaiting_confirmation'
      ? '方案已准备，等待本人确认后继续'
      : '已理解当前需求，等待补充办理信息后继续';
    return Object.assign({}, state, {
      status: 'waiting',
      expanded: state.userExpanded ? state.expanded : false,
      summary: summary,
      currentText: summary,
      steps: state.steps.map(function (step) {
        var lastStep = state.steps[state.steps.length - 1];
        if (step === lastStep) return Object.assign({}, step, { state: 'pending' });
        return step.state === 'running' ? Object.assign({}, step, { state: 'pending' }) : step;
      })
    });
  }

  function reduceEvent(state, rawEvent, snapshot) {
    var event = safeEvent(rawEvent);
    if (!event || (state.status !== 'running' && state.status !== 'waiting')) return state;
    if (event.sequence != null && event.sequence <= state.lastSequence) return state;
    var next = copy(state);
    if (next.status === 'waiting') next.status = 'running';
    next.lastSequence = event.sequence == null ? state.lastSequence + 1 : event.sequence;
    next.events = state.events.concat([event]);
    next.currentText = genericText(event.stage);
    var profile = profileById(snapshot, next.profileId);
    if (!profile && event.skillId) {
      profile = profileBySkill(snapshot, event.skillId);
      if (profile) next = bindProfile(next, profile);
    }
    if (profile) next = applyProfileEvent(next, profile, event);
    if (event.stage === 'run.completed') {
      if (['blocked', 'unavailable', 'failed'].indexOf(event.resultStatus) >= 0) next = fail(next, snapshot);
      else if (['clarification_required', 'awaiting_confirmation'].indexOf(event.resultStatus) >= 0) {
        next = waitForUser(next, profile, event.resultStatus);
      }
      else next = finish(next, profile);
    }
    return deepFreeze(next);
  }

  function fail(state, snapshot) {
    if (state.status === 'completed') return state;
    var profile = profileById(snapshot, state.profileId);
    return deepFreeze(Object.assign({}, copy(state), {
      status: 'failed',
      expanded: true,
      summary: profile ? profile.failureSummary : '本次服务未完成，请稍后重试',
      currentText: profile ? profile.failureSummary : '本次服务未完成，请稍后重试',
      steps: state.steps.map(function (step) {
        return step.state === 'running' ? Object.assign({}, step, { state: 'failed' }) : step;
      })
    }));
  }

  function setExpanded(state, expanded) {
    if (state.status === 'running') return state;
    return deepFreeze(Object.assign({}, copy(state), {
      expanded: Boolean(expanded), userExpanded: true
    }));
  }

  return {
    createState: createState,
    reduceEvent: reduceEvent,
    fail: fail,
    setExpanded: setExpanded,
    validSnapshot: validSnapshot
  };
});
