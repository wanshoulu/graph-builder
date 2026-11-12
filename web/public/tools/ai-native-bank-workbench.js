(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.AINativeBankWorkbench = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function fail() { throw new Error('invalid_workbench_view'); }
  function exact(value, keys) {
    return value && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).length === keys.length
      && Object.keys(value).every(function (key) { return keys.indexOf(key) >= 0; });
  }
  function freeze(value) {
    if (!value || typeof value !== 'object') return value;
    Object.values(value).forEach(freeze);
    return Object.freeze(value);
  }
  function text(value, maximum) {
    if (typeof value !== 'string' || !value || value.length > maximum || /[<>]/.test(value)) fail();
    return value;
  }
  function count(value) {
    if (!Number.isSafeInteger(value) || value < 0) fail();
    return value;
  }
  function rate(value) {
    if (!exact(value, ['ready', 'total', 'rate'])) fail();
    count(value.ready); count(value.total);
    if (value.ready > value.total || (value.total === 0) !== (value.rate === null)
      || value.rate !== null && (typeof value.rate !== 'number' || value.rate < 0 || value.rate > 100)) fail();
    return value.rate === null ? '—' : String(value.rate) + '%';
  }
  function label(map, value) { return map[value] || text(value, 64); }

  function projectOverviewCards(overview) {
    if (!overview || !overview.capabilities || !overview.skills || !overview.providers
      || !overview.intents || !overview.entries) fail();
    var capabilities = overview.capabilities;
    return freeze([
      { label: '注册能力', value: String(count(capabilities.registered)), note: '统一能力注册表' },
      { label: '可规划 / 可执行', value: count(capabilities.plannable) + ' / ' + count(capabilities.executable), note: '执行口径不含写操作' },
      { label: '集成启用', value: count(capabilities.enabled) + ' / ' + count(capabilities.registered), note: '其余明确标记延期或平台专用' },
      { label: 'Skill / Provider', value: count(overview.skills.active) + ' / ' + count(overview.providers.businessAvailable), note: '有效 Skill / 当前业务可用 Provider' },
    ]);
  }

  function projectScenarioCards(scenarios) {
    if (!Array.isArray(scenarios) || scenarios.length > 32) fail();
    return freeze(scenarios.map(function (item) {
      if (!item || !item.intentReadiness || !item.capabilityReadiness || !item.evaluation
        || !Array.isArray(item.gaps)) fail();
      return {
        id: text(item.id, 64), title: text(item.title, 80), domain: text(item.domain, 64),
        readinessLabel: label({ ready: '已就绪', partial: '部分就绪', planned: '规划中' }, item.readinessStatus),
        intentRate: rate(item.intentReadiness), capabilityRate: rate(item.capabilityReadiness),
        capabilityRatePercent: item.capabilityReadiness.rate,
        evaluationLabel: label({ not_evaluated: '未评测' }, item.evaluation.status),
        evaluationRate: item.evaluation.rate === null ? '—' : String(item.evaluation.rate) + '%',
        gapCount: count(item.gaps.length),
      };
    }));
  }

  function projectRunRows(page) {
    if (!exact(page, ['items', 'nextCursor']) || !Array.isArray(page.items) || page.items.length > 50) fail();
    var statuses = {
      accepted: '已接收', interpreting: '理解中', planning: '规划中', awaiting_confirmation: '等待确认',
      executing: '执行中', succeeded: '成功', failed: '失败', clarification_required: '需要澄清',
      navigation_only: '仅导航', blocked: '已阻止',
    };
    var traces = { recording: '采集中', complete: '轨迹完整', incomplete: '轨迹不完整', legacy_unavailable: '旧记录无轨迹' };
    return freeze({
      items: page.items.map(function (item) {
        return {
          id: text(item.id, 160), title: '运行 ' + item.id.slice(-8),
          status: text(item.status, 32), statusLabel: label(statuses, item.status),
          traceLabel: label(traces, item.traceAvailability), createdAt: text(item.createdAt, 40),
          durationLabel: item.durationMs === null ? '—' : count(item.durationMs) + ' ms',
          invocationCount: count(item.capabilityInvocationCount), confirmationCount: count(item.confirmationCount),
        };
      }),
      nextCursor: page.nextCursor === null ? null : text(page.nextCursor, 512),
    });
  }

  function projectRunDetail(detail) {
    if (!detail || !detail.run || !Array.isArray(detail.events) || !Array.isArray(detail.workflows)
      || !Array.isArray(detail.invocations) || !Array.isArray(detail.confirmations)) fail();
    var row = projectRunRows({ items: [detail.run], nextCursor: null }).items[0];
    return freeze({
      run: row,
      traceAvailability: text(detail.traceAvailability, 32),
      turns: (detail.turns || []).map(function (item) {
        return {
          role: text(item.role, 16), text: text(item.text, 1000),
          createdAt: text(item.createdAt, 40),
        };
      }),
      events: detail.events.map(function (event) {
        return {
          sequence: count(event.sequence), stage: text(event.stage, 64), status: text(event.status, 32),
          title: text(event.summary && event.summary.title, 240),
          durationLabel: event.durationMs === null ? '—' : count(event.durationMs) + ' ms',
          // API 客户端已对 summary 做过有界安全校验（深度 8、串长 1000、敏感键过滤）
          // 并冻结；这里整体透传给详情页的通用 trace 渲染器，不再只留标题。
          summary: event.summary,
        };
      }),
      workflows: detail.workflows.map(function (item) {
        return { id: text(item.id, 160), status: text(item.status, 64), revision: count(item.workflowRevision) };
      }),
      invocationCount: count(detail.invocations.length), confirmationCount: count(detail.confirmations.length),
      memoryUpdates: projectMemoryUpdates(detail.memoryUpdates || []),
      // 模型调用文本已由 API 客户端做过结构+长度校验并冻结；
      // prompt/response 可含任意字符（含 < >），这里整体透传给详情页渲染。
      modelCalls: (detail.modelCalls || []).map(function (item) {
        return {
          phase: text(item.phase, 64),
          model: item.model === null ? null : text(item.model, 96),
          prompt: item.prompt, response: item.response,
          toolsCount: count(item.toolsCount),
          durationLabel: item.durationMs === null ? '—' : count(item.durationMs) + ' ms',
          status: item.status,
          occurredAt: text(item.occurredAt, 40),
        };
      }),
    });
  }

  function projectMemoryUpdates(items) {
    if (!Array.isArray(items) || items.length > 20) fail();
    var statuses = {
      QUEUED: '已进入可靠队列', PROCESSING: '正在提交治理', PENDING_RETRY: '等待自动重试',
      PERSISTED: '已落盘', CONTESTED: '存在冲突，未作为有效记忆使用',
      REJECTED: '候选未通过记忆治理', DEAD_LETTER: '自动重试未完成，需运维处理',
    };
    var decisions = { ADD: '新增', MERGE: '合并', SUPERSEDE: '替代', CONTESTED: '冲突', REJECT: '拒绝' };
    return freeze(items.map(function (item) {
      if (!item || !statuses[item.status]) fail();
      var decisionLabel = item.decision === null ? null : decisions[item.decision];
      if (item.decision !== null && !decisionLabel) fail();
      return {
        candidateType: text(item.candidateType, 64), predicate: text(item.predicate, 80),
        status: item.status, statusLabel: statuses[item.status],
        detail: decisionLabel ? decisionLabel + ' · ' + text(item.reason, 128) : statuses[item.status],
        policyVersion: item.policyVersion === null ? null : text(item.policyVersion, 128),
        attempts: count(item.attempts), updatedAt: text(item.updatedAt, 40),
      };
    }));
  }

  var DOMAIN_LABELS = {
    account: '账户', cashflow: '资金流水', 'credit-card': '信用卡', customer: '客户',
    loan: '贷款', obligation: '待办履约', transfer: '转账汇款', utility: '生活缴费',
    wealth: '财富理财',
  };

  var PROVIDER_TYPE_LABELS = { mcp: 'MCP 工具', 'user-action': '用户动作' };

  function projectAssetGroups(assets) {
    if (!exact(assets, ['filters', 'total', 'items']) || !Array.isArray(assets.items)
      || assets.items.length > 128 || count(assets.total) !== assets.items.length) fail();
    var byDomain = {};
    var skills = [];
    var providers = {};
    assets.items.forEach(function (item) {
      if (!item || ['capability', 'skill', 'provider'].indexOf(item.type) < 0) fail();
      var projected;
      if (item.type === 'provider') {
        projected = {
          id: text(item.id, 160), title: text(item.title, 160), type: item.type,
          domain: text(item.domain, 64),
          status: text(item.health, 32),
          statusLabel: label({ ready: '就绪', degraded: '降级', unavailable: '不可用' }, item.health),
          detail: text(item.exposure, 64) + ' · ' + text(item.capabilityId, 160),
        };
        if (!providers[item.providerType]) providers[item.providerType] = [];
        providers[item.providerType].push(projected);
        return;
      }
      projected = {
        id: text(item.id, 160), title: text(item.title, 160), type: item.type,
        domain: item.type === 'capability' ? text(item.domain, 64) : 'skill',
        status: item.type === 'capability' ? text(item.integrationStatus, 32) : text(item.status, 32),
        statusLabel: label({ enabled: '已启用', deferred: '延期', 'platform-only': '平台专用', active: '有效' },
          item.type === 'capability' ? item.integrationStatus : item.status),
        detail: item.type === 'capability'
          ? text(item.exposure, 64) + ' · ' + text(item.riskLevel, 32)
          : count(item.requiredCapabilityIds.length) + ' 项依赖能力',
      };
      if (item.type === 'skill') { skills.push(projected); return; }
      if (!byDomain[projected.domain]) byDomain[projected.domain] = [];
      byDomain[projected.domain].push(projected);
    });
    var groups = Object.keys(byDomain).sort().map(function (domain) {
      return { id: 'domain-' + domain, title: label(DOMAIN_LABELS, domain), items: byDomain[domain] };
    });
    // MCP 工具与业务 Skill 是两类资产：模型可调用工具 vs 编排型技能，明确分开展示。
    Object.keys(PROVIDER_TYPE_LABELS).forEach(function (providerType) {
      if (providers[providerType] && providers[providerType].length) {
        groups.push({
          id: 'provider-' + providerType,
          title: PROVIDER_TYPE_LABELS[providerType],
          items: providers[providerType],
        });
      }
    });
    if (skills.length) groups.push({ id: 'skill', title: '业务 Skill', items: skills });
    return freeze({ total: assets.total, groups: groups });
  }

  function projectExperienceScenarioCards(scenarios) {
    if (!Array.isArray(scenarios) || scenarios.length > 128) fail();
    return freeze(scenarios.map(function (item) {
      if (!item || typeof item.triggerSummary !== 'string' || typeof item.reasonTextTemplate !== 'string'
        || !Array.isArray(item.surfaces) || !item.surfaces.length) fail();
      return {
        id: text(item.id, 96), title: text(item.title, 80),
        typeLabel: label({ resume_task: '任务续办', next_intent: '意图推荐',
          proactive_service: '主动服务', care: '关怀提醒' }, item.type),
        priorityLabel: label({ critical: '紧急', high: '高', normal: '普通', low: '低' }, item.priority),
        actionLabel: label({ START_ASSISTANCE: '引导办理', OPEN_CATALOG: '打开功能目录' }, item.action),
        complianceLabel: item.complianceClass === null ? null
          : label({ service: '服务类', marketing: '营销类', risk: '风控类' }, item.complianceClass),
        surfaceLabel: item.surfaces
          .map(function (surface) { return label({ home: '首页', agent: '智能助手', channel: '渠道' }, surface); })
          .join(' / '),
        targetIntentId: item.targetIntentId === null ? null : text(item.targetIntentId, 160),
        capabilityCount: count(item.requiredCapabilityIds.length),
        triggerSummary: text(item.triggerSummary, 500),
        reasonTextTemplate: text(item.reasonTextTemplate, 160),
        reshowLabel: item.reshowAfterHours === null ? '持续提醒' : count(item.reshowAfterHours) + ' 小时内不重复',
        cooldownLabel: item.cooldownHours === 0 ? '无办理冷却' : count(item.cooldownHours) + ' 小时办理冷却',
        memoryLabel: item.memoryEnabled ? '记忆增强' : '不依赖记忆',
      };
    }));
  }

  return Object.freeze({
    projectOverviewCards: projectOverviewCards,
    projectScenarioCards: projectScenarioCards,
    projectRunRows: projectRunRows,
    projectRunDetail: projectRunDetail,
    projectMemoryUpdates: projectMemoryUpdates,
    projectAssetGroups: projectAssetGroups,
    projectExperienceScenarioCards: projectExperienceScenarioCards,
  });
});
