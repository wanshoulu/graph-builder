(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.AINativeBankMemoryWorkbench = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var STATUS_LABELS = Object.freeze({
    active: '当前有效', pending: '待处理', contested: '存在冲突',
    revoked: '已撤回', expired: '已过期', rejected: '已拒绝',
  });
  var KIND_LABELS = Object.freeze({
    working: '工作记忆', semantic: '语义记忆', episodic: '情景记忆',
    procedural: '程序记忆',
  });
  var RELATION_LABELS = Object.freeze({
    current: '当前版本', supersedes: '替代前序', superseded_by: '已被替代',
    contests: '同级冲突', late_arrival: '迟到历史事件',
    revoked_by_consent: '授权撤回停用', tombstoned: '用户停用（墓碑）',
  });
  var USE_LABELS = Object.freeze({
    included: '已用于服务', filtered: '因策略过滤', core_refresh_required: '要求核心数据刷新',
    confirmation_required: '需要本人确认',
  });
  var USAGE_POLICY_LABELS = Object.freeze({
    display_only: '仅展示参考，不可用于办理',
    advisory_requires_confirmation: '建议性参考，使用前需本人确认',
    advisory_requires_core_refresh: '建议性参考，办理前需刷新核心数据',
    deny_when_false: '条件为假时拒绝调用',
    deny_when_true: '条件为真时拒绝调用',
    context_only: '仅用于上下文组装，不持久化',
  });
  var PURPOSE_LABELS = Object.freeze({
    service_personalization: '服务个性化',
    cashflow_explanation: '资金解释',
    wealth_guidance: '财富建议',
    service_continuity: '服务连续性',
    consent_governance: '授权治理',
    monthly_fund_planning: '月度资金安排',
    bill_payment_reminder: '账单缴付提醒',
    session_context: '会话上下文',
  });
  var SENSITIVITY_LABELS = Object.freeze({
    L0: '公开', L1: '低敏感', L2: '中敏感', L3: '高敏感',
  });

  function fail() {
    throw new Error('invalid_memory_workbench_view');
  }

  function exact(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    var actual = Object.keys(value).sort();
    var expected = keys.slice().sort();
    return actual.length === expected.length && actual.every(function (key, index) {
      return key === expected[index];
    });
  }

  function text(value, maximum) {
    if (typeof value !== 'string' || !value || value.length > maximum || /[<>]/.test(value)) fail();
    return value;
  }

  function freeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.values(value).forEach(freeze);
    return Object.freeze(value);
  }

  function formatTime(value) {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail();
    return value.replace('T', ' ').replace(/\.\d+/, '').replace(/(?:Z|[+-]\d\d:\d\d)$/, '');
  }

  function formatRange(value) {
    if (!exact(value, ['from', 'to'])) fail();
    var start = formatTime(value.from);
    return value.to === null ? start + ' 起' : start + ' 至 ' + formatTime(value.to);
  }

  function formatDisplayValue(value, displayType) {
    var allowed = ['text', 'currency', 'integer', 'boolean', 'date', 'enum', 'masked_reference'];
    if (allowed.indexOf(displayType) < 0) fail();
    return text(value, 240);
  }

  function projectMemoryOverview(value) {
    if (!exact(value, ['schemaVersion', 'generatedAt', 'mode', 'policyVersion', 'health', 'counts'])
      || value.schemaVersion !== '1.0'
      || !exact(value.health, ['controlPlane', 'relationalStore', 'index', 'graph'])
      || !exact(value.counts, ['total', 'active', 'pending', 'contested', 'revokedOrExpired'])) fail();
    Object.values(value.counts).forEach(function (count) {
      if (!Number.isSafeInteger(count) || count < 0) fail();
    });
    var healthParts = [];
    if (value.health.relationalStore === 'healthy') healthParts.push('结构化查询可用');
    else healthParts.push('结构化查询' + (value.health.relationalStore === 'degraded' ? '降级' : '不可用'));
    if (value.health.index === 'degraded') healthParts.push('索引降级');
    else if (value.health.index === 'unavailable') healthParts.push('索引不可用');
    if (value.health.graph === 'disabled') healthParts.push('图能力未启用');
    else if (value.health.graph === 'degraded') healthParts.push('图能力降级');
    var definitions = [
      ['total', '记忆总数', []], ['active', '当前有效', ['active']],
      ['pending', '待处理候选', ['pending']], ['contested', '冲突记忆', ['contested']],
      ['revokedOrExpired', '已撤回 / 过期', ['revoked', 'expired']],
    ];
    return freeze({
      schemaVersion: value.schemaVersion,
      generatedAt: formatTime(value.generatedAt),
      mode: value.mode,
      policyVersion: text(value.policyVersion, 128),
      healthLabel: healthParts.join(' · '),
      cards: definitions.map(function (definition) {
        return { key: definition[0], label: definition[1], value: String(value.counts[definition[0]]), statuses: definition[2] };
      }),
    });
  }

  function projectMemoryRow(value) {
    if (!exact(value, [
      'id', 'customer', 'recordKind', 'predicate', 'safeValueSummary', 'displayType',
      'source', 'status', 'validTime', 'systemTime', 'sensitivity',
    ]) || !exact(value.customer, ['displayName', 'maskedId'])
      || !exact(value.source, ['type', 'label'])
      || !(value.predicate === null || exact(value.predicate, ['id', 'label']))
      || !STATUS_LABELS[value.status] || !KIND_LABELS[value.recordKind]) fail();
    return freeze({
      id: text(value.id, 88),
      customerLabel: text(value.customer.displayName, 120) + ' · ' + text(value.customer.maskedId, 120),
      title: value.predicate ? text(value.predicate.label, 120) : '受限记忆',
      predicateId: value.predicate ? text(value.predicate.id, 128) : null,
      value: formatDisplayValue(value.safeValueSummary, value.displayType),
      kindLabel: KIND_LABELS[value.recordKind],
      sourceLabel: text(value.source.label, 120),
      status: value.status,
      statusLabel: STATUS_LABELS[value.status],
      validTimeLabel: formatRange(value.validTime),
      systemTimeLabel: formatRange(value.systemTime),
      sensitivity: text(value.sensitivity, 2),
    });
  }

  function projectMemoryPage(value) {
    if (!exact(value, ['schemaVersion', 'generatedAt', 'policyVersion', 'items', 'nextCursor'])
      || value.schemaVersion !== '1.0' || !Array.isArray(value.items) || value.items.length > 100
      || !(value.nextCursor === null || typeof value.nextCursor === 'string')) fail();
    return freeze({
      generatedAt: formatTime(value.generatedAt),
      policyVersion: text(value.policyVersion, 128),
      rows: value.items.map(projectMemoryRow),
      nextCursor: value.nextCursor,
    });
  }

  function projectMemoryDetail(value) {
    if (!exact(value, ['schemaVersion', 'id', 'overview', 'timeline', 'evidence', 'uses'])
      || value.schemaVersion !== '1.0' || !Array.isArray(value.timeline)
      || !Array.isArray(value.evidence) || !Array.isArray(value.uses)) fail();
    var overview = value.overview;
    if (!exact(overview, [
      'customer', 'predicate', 'safeValueSummary', 'displayType', 'memoryType', 'status',
      'sensitivity', 'sourceAuthority', 'confidence', 'validTime', 'systemTime',
      'allowedPurposes', 'usagePolicy', 'requiresCoreRefresh', 'requiresConfirmation',
      'policyVersion', 'retentionLabel',
    ]) || !STATUS_LABELS[overview.status] || !KIND_LABELS[overview.memoryType]) fail();
    var evidence = value.evidence.map(function (item) {
      if (!exact(item, ['episodeType', 'occurredAt', 'recordedAt', 'sourceLabel', 'contentHashShort', 'safeSummary', 'sourceLink'])) fail();
      return {
        title: text(item.sourceLabel, 120), summary: text(item.safeSummary, 240),
        timeLabel: formatTime(item.occurredAt), recordedLabel: formatTime(item.recordedAt),
        hashLabel: text(item.contentHashShort, 16),
        runTargetId: item.sourceLink && item.sourceLink.type === 'agent_run' ? text(item.sourceLink.targetId, 160) : null,
      };
    });
    var timeline = value.timeline.map(function (item) {
      if (!exact(item, ['safeValueSummary', 'status', 'validTime', 'systemTime', 'relation'])
        || !STATUS_LABELS[item.status] || !RELATION_LABELS[item.relation]) fail();
      return {
        value: text(item.safeValueSummary, 240), statusLabel: STATUS_LABELS[item.status],
        relationLabel: RELATION_LABELS[item.relation], validTimeLabel: formatRange(item.validTime),
        systemTimeLabel: formatRange(item.systemTime),
      };
    });
    var uses = value.uses.map(function (item) {
      if (!exact(item, ['usedAt', 'purpose', 'outcome', 'runRef']) || !USE_LABELS[item.outcome]) fail();
      return { timeLabel: formatTime(item.usedAt), purpose: text(item.purpose, 128),
        outcomeLabel: USE_LABELS[item.outcome], runRef: item.runRef === null ? null : text(item.runRef, 160) };
    });
    return freeze({
      id: text(value.id, 88),
      tabs: [
        { id: 'overview', label: '概览' }, { id: 'timeline', label: '时序演化' },
        { id: 'evidence', label: '证据链' }, { id: 'uses', label: '使用记录' },
      ],
      overview: {
        customerLabel: text(overview.customer.displayName, 120) + ' · ' + text(overview.customer.maskedId, 120),
        title: overview.predicate ? text(overview.predicate.label, 120) : KIND_LABELS[overview.memoryType] + '条目',
        value: overview.predicate
          ? formatDisplayValue(overview.safeValueSummary, overview.displayType)
          : '内容受控，仅限当前会话使用，不展示具体内容',
        kindLabel: KIND_LABELS[overview.memoryType], statusLabel: STATUS_LABELS[overview.status],
        sensitivityLabel: SENSITIVITY_LABELS[overview.sensitivity] || overview.sensitivity,
        sensitivityCode: text(overview.sensitivity, 2),
        sourceLabel: text(overview.sourceAuthority.label, 120),
        confidenceLabel: Math.round(Number(overview.confidence) * 100) + '%',
        validTimeLabel: formatRange(overview.validTime), systemTimeLabel: formatRange(overview.systemTime),
        allowedPurposeLabels: overview.allowedPurposes.map(function (item) { return PURPOSE_LABELS[item] || item; }),
        usagePolicyLabel: USAGE_POLICY_LABELS[overview.usagePolicy] || overview.usagePolicy,
        requiresCoreRefresh: Boolean(overview.requiresCoreRefresh),
        requiresConfirmation: Boolean(overview.requiresConfirmation),
        retentionLabel: text(overview.retentionLabel, 120),
        policyVersion: text(overview.policyVersion, 128),
      },
      timeline: timeline, evidence: evidence, uses: uses,
    });
  }

  function buildMemoryQuery(filters) {
    var input = filters || {};
    var result = {};
    ['query', 'customerRef', 'validFrom', 'validTo', 'cursor'].forEach(function (key) {
      if (input[key] !== null && input[key] !== undefined && input[key] !== '') result[key] = String(input[key]).trim();
    });
    ['recordKinds', 'statuses', 'sources', 'purposes'].forEach(function (key) {
      if (Array.isArray(input[key]) && input[key].length) result[key] = input[key].slice();
    });
    result.limit = Number.isSafeInteger(input.limit) ? input.limit : 20;
    return freeze(result);
  }

  return Object.freeze({
    buildMemoryQuery: buildMemoryQuery,
    formatDisplayValue: formatDisplayValue,
    projectMemoryDetail: projectMemoryDetail,
    projectMemoryOverview: projectMemoryOverview,
    projectMemoryPage: projectMemoryPage,
    projectMemoryRow: projectMemoryRow,
  });
});
