(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.AINativeBankUserResponse = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var TYPES = Object.freeze(['result', 'clarification', 'answer', 'confirmation', 'navigation', 'notice']);
  var ACTION_KINDS = ['reply', 'navigate', 'confirm', 'dismiss'];
  var RESPONSE_FIELDS = ['schemaVersion', 'type', 'title', 'body', 'items', 'actions', 'source', 'taskProgress'];
  var ACTION_FIELDS = ['id', 'label', 'description', 'kind', 'interaction', 'payload', 'form'];
  var INTERNAL_MARKERS = [
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

  function fail(message) {
    throw new TypeError(message || 'user response 无效');
  }

  function plain(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(label + ' 无效');
    var prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail(label + ' 无效');
    return value;
  }

  function exactKeys(value, allowed, label) {
    var unknown = Object.keys(value).filter(function (key) { return allowed.indexOf(key) < 0; });
    if (unknown.length) fail(label + ' 包含未知字段');
  }

  function codePointLength(value) {
    return Array.from(value).length;
  }

  function decodedSecurityForms(value) {
    var forms = [];
    var current = String(value).normalize('NFKC').toLowerCase().replace(/[\uff0e\uff61]/gu, '.');
    for (var pass = 0; pass < 4; pass += 1) {
      if (forms.indexOf(current) < 0) forms.push(current);
      try {
        var decoded = decodeURIComponent(current).normalize('NFKC').toLowerCase().replace(/[\uff0e\uff61]/gu, '.');
        if (decoded === current) break;
        current = decoded;
      } catch (_) {
        break;
      }
    }
    return forms;
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

  function containsUrlLikeText(value) {
    return decodedSecurityForms(value).some(function (candidate) {
      return /[a-z][a-z0-9+.-]{0,31}:/iu.test(candidate)
        || /\/\//u.test(candidate)
        || /(?:www\.)/iu.test(candidate)
        || /(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?/u.test(candidate)
        || /\[[0-9a-f:.]+\](?::\d{1,5})?/iu.test(candidate)
        || /localhost(?::\d{1,5})?/iu.test(candidate)
        || /[\p{L}\p{N}._%+-]+@(?:[\p{L}\p{N}-]+\.)+[\p{L}]{2,63}/iu.test(candidate)
        || /[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,62}\.)+[\p{L}]{2,63}(?::\d{1,5})?(?:[/?#][^\s]*)?/iu.test(candidate)
        || containsIdeographicBareDomain(candidate);
    });
  }

  function safeText(value, label, maximum, allowEmpty) {
    if (typeof value !== 'string' || (!allowEmpty && !value) || codePointLength(value) > maximum) fail(label + ' 无效');
    var canonical = value.normalize('NFKC').toLowerCase();
    var forms = decodedSecurityForms(canonical);
    if (forms.some(function (candidate) { return /[<>\p{C}]/u.test(candidate); }) || containsUrlLikeText(canonical)) fail(label + ' 无效');
    if (forms.some(function (candidate) {
      var compact = candidate.replace(/[\p{P}\p{Z}\p{S}\p{M}\p{C}]/gu, '');
      return INTERNAL_MARKERS.some(function (marker) { return compact.indexOf(marker) >= 0; });
    })) fail(label + ' 无效');
    if (forms.some(function (candidate) {
      var digits = candidate.match(/\p{Nd}/gu);
      return digits && digits.length >= 15;
    })) fail(label + ' 无效');
    return value;
  }

  function safeTextList(value, label, maximumItems, maximumLength) {
    if (!Array.isArray(value) || value.length > maximumItems) fail(label + ' 无效');
    return value.map(function (item) { return safeText(item, label, maximumLength, false); });
  }

  function normalizeAction(value) {
    plain(value, 'user response action');
    exactKeys(value, ACTION_FIELDS, 'user response action');
    if (typeof value.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value.id)
      || ACTION_KINDS.indexOf(value.kind) < 0) fail('user response action 无效');
    plain(value.payload, 'action payload');
    var interaction = null;
    if (value.kind === 'reply') {
      interaction = value.interaction == null ? 'compose' : value.interaction;
      if (['submit', 'compose'].indexOf(interaction) < 0) fail('reply interaction 无效');
    } else if (value.interaction != null) {
      fail('action interaction 无效');
    }
    var payloadFields = value.kind === 'reply' ? ['message']
      : value.kind === 'navigate' ? ['channel', 'featureId', 'actionId'] : [];
    exactKeys(value.payload, payloadFields, 'action payload');

    var payload;
    if (value.kind === 'reply') {
      payload = { message: safeText(value.payload.message, 'reply message', 240, false) };
    } else if (value.kind === 'navigate') {
      if (typeof value.payload.channel !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(value.payload.channel)
        || typeof value.payload.featureId !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value.payload.featureId)
        || typeof value.payload.actionId !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value.payload.actionId)) {
        fail('navigate target 无效');
      }
      payload = {
        channel: value.payload.channel,
        featureId: value.payload.featureId,
        actionId: value.payload.actionId,
      };
    } else {
      payload = {};
    }

    var form = null;
    if (value.form != null) {
      if (value.kind !== 'reply' || interaction !== 'compose') fail('action form 仅限 compose 交互');
      plain(value.form, 'action form');
      exactKeys(value.form, ['fields'], 'action form');
      if (!Array.isArray(value.form.fields) || value.form.fields.length < 1 || value.form.fields.length > 6) fail('action form 无效');
      form = {
        fields: value.form.fields.map(function (field) {
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
            label: safeText(field.label, 'form field label', 40, false),
            type: field.type,
            required: field.required,
            options: options,
            placeholder: field.placeholder == null ? null : safeText(field.placeholder, 'form placeholder', 60, true),
          };
        }),
      };
    }

    var item = {
      id: value.id,
      label: safeText(value.label, 'action label', 80, false),
      description: value.description == null ? null : safeText(value.description, 'action description', 160, true),
      kind: value.kind,
      interaction: interaction,
      payload: payload,
    };
    if (form != null) item.form = form;
    return item;
  }

  function normalizeSource(value) {
    plain(value, 'user response source');
    exactKeys(value, ['id', 'version', 'label'], 'user response source');
    if (typeof value.id !== 'string' || value.id.length > 128 || !/^faq\.[a-z0-9.-]+$/.test(value.id)
      || typeof value.version !== 'string' || value.version.length > 32 || !/^\d+\.\d+\.\d+$/.test(value.version)
      || value.label !== 'Mock 业务知识') fail('user response source 无效');
    return { id: value.id, version: value.version, label: value.label };
  }

  function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.freeze(value);
    Object.keys(value).forEach(function (key) { deepFreeze(value[key]); });
    return value;
  }

  function normalize(value) {
    plain(value, 'user response');
    exactKeys(value, RESPONSE_FIELDS, 'user response');
    if (['1.0', '1.1'].indexOf(value.schemaVersion) < 0 || TYPES.indexOf(value.type) < 0
      || !Array.isArray(value.actions) || value.actions.length > 8) fail('user response 无效');
    var actions = value.actions.map(normalizeAction);
    if (new Set(actions.map(function (item) { return item.id; })).size !== actions.length) fail('user response action 标识重复');
    if (value.type === 'clarification' && actions.some(function (item) { return item.kind !== 'reply'; })) fail('clarification action 无效');
    if (value.type === 'navigation' && (!actions.length || actions.some(function (item) { return item.kind !== 'navigate'; }))) fail('navigation action 无效');
    var source = value.source == null ? null : normalizeSource(value.source);
    if ((value.type === 'answer') !== Boolean(source)) fail('user response source 状态冲突');
    var taskProgress = value.taskProgress == null ? null : normalizeTaskProgress(value.taskProgress);
    if (taskProgress && (value.schemaVersion !== '1.1'
      || ['clarification', 'confirmation', 'result'].indexOf(value.type) < 0)) fail('task progress 状态冲突');
    return deepFreeze({
      schemaVersion: value.schemaVersion,
      type: value.type,
      title: safeText(value.title, 'user response title', 80, false),
      body: safeText(value.body, 'user response body', 600, false),
      items: safeTextList(value.items, 'user response items', 20, 240),
      actions: actions,
      source: source,
      taskProgress: taskProgress,
    });
  }

  function normalizeTaskProgress(value) {
    plain(value, 'task progress');
    exactKeys(value, ['mode', 'current', 'total', 'completed', 'failed', 'skipped'], 'task progress');
    var names = ['current', 'total', 'completed', 'failed', 'skipped'];
    if (value.mode !== 'sequential' || names.some(function (name) { return !Number.isInteger(value[name]); })
      || value.current < 1 || value.total < 1 || value.total > 16 || value.current > value.total
      || value.completed < 0 || value.failed < 0 || value.skipped < 0
      || value.completed + value.failed + value.skipped >= value.total) fail('task progress 无效');
    return deepFreeze({ mode: value.mode, current: value.current, total: value.total,
      completed: value.completed, failed: value.failed, skipped: value.skipped });
  }

  var CLARIFICATION_KIND_SCHEMAS = {
    transfer_payee: {
      // amount 允许出现（只读回显）：批量转账后续笔次金额已在澄清轮
      // 确认（每人X元），表单以只读金额字段回显核对。缺失该类型会把
      // 后续笔次表单整体拒掉，前端退化为纯文本卡（填槽卡片丢失）。
      fieldTypes: { payeeName: 'text', accountNo: 'bank_account', bankName: 'bank_name', amount: 'amount', purpose: 'text', savePayee: 'boolean', fromAccount: 'select' },
      requiredFields: ['payeeName', 'accountNo'],
      minFields: 2, maxFields: 6,
    },
    transfer_full: {
      fieldTypes: { payeeName: 'text', accountNo: 'bank_account', bankName: 'bank_name', amount: 'amount', purpose: 'text', savePayee: 'boolean', fromAccount: 'select' },
      requiredFields: ['payeeName', 'accountNo', 'amount'],
      minFields: 3, maxFields: 8,
    },
    generic: {
      fieldTypes: null,
      requiredFields: [],
      minFields: 1, maxFields: 5,
    },
  };
  var GENERIC_FIELD_TYPES = new Set(['text', 'textarea', 'select', 'boolean', 'number', 'amount', 'bank_account', 'bank_name']);

  function normalizeClarificationForm(value) {
    plain(value, 'clarification form');
    exactKeys(value, ['schemaVersion', 'clarificationId', 'submissionToken', 'expiresAt', 'kind', 'fields'], 'clarification form');
    if (value.schemaVersion !== '1.0' || !/^acl_[A-Za-z0-9_-]{1,92}$/.test(value.clarificationId || '')
      || typeof value.submissionToken !== 'string' || value.submissionToken.length < 32 || value.submissionToken.length > 256
      || typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt))
      || !CLARIFICATION_KIND_SCHEMAS[value.kind] || !Array.isArray(value.fields)
      || value.fields.length < CLARIFICATION_KIND_SCHEMAS[value.kind].minFields
      || value.fields.length > CLARIFICATION_KIND_SCHEMAS[value.kind].maxFields) fail('clarification form 无效');
    var schema = CLARIFICATION_KIND_SCHEMAS[value.kind];
    var fields = value.fields.map(function (field) {
      plain(field, 'clarification field');
      exactKeys(field, ['name', 'label', 'type', 'required', 'value', 'editable', 'options'], 'clarification field');
      if (typeof field.name !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(field.name)
        || typeof field.required !== 'boolean' || typeof field.editable !== 'boolean'
        || (field.type === 'boolean' ? typeof field.value !== 'boolean' : typeof field.value !== 'string')) fail('clarification field 无效');
      if (schema.fieldTypes) {
        if (!schema.fieldTypes[field.name] || field.type !== schema.fieldTypes[field.name]) fail('clarification field 无效');
      } else {
        if (!GENERIC_FIELD_TYPES.has(field.type)) fail('clarification field 无效');
      }
      if (field.name === 'accountNo' && field.value !== '' && !/^\*[\*\s]*\d{0,4}$/.test(field.value)) fail('clarification field 无效');
      var projected = { name: field.name, label: safeText(field.label, 'field label', 40, false),
        type: field.type, required: field.required, value: field.value, editable: field.editable };
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
    if (new Set(names).size !== names.length) fail('clarification fields 无效');
    schema.requiredFields.forEach(function (req) {
      if (names.indexOf(req) < 0) fail('clarification fields 无效');
    });
    return deepFreeze({ schemaVersion: '1.0', clarificationId: value.clarificationId,
      submissionToken: value.submissionToken, expiresAt: value.expiresAt, kind: value.kind, fields: fields });
  }

  async function executeAction(value, handlers) {
    var item = normalizeAction(value);
    plain(handlers, 'action handlers');
    if (item.kind === 'reply') {
      if (typeof handlers.reply !== 'function') fail('reply handler 无效');
      return handlers.reply(item.payload.message);
    }
    if (item.kind === 'navigate') {
      if (typeof handlers.navigate !== 'function') fail('navigate handler 无效');
      return handlers.navigate(item.payload.channel, item.payload.featureId, item.payload.actionId);
    }
    if (item.kind === 'confirm') {
      if (typeof handlers.confirm !== 'function') fail('confirm handler 无效');
      return handlers.confirm();
    }
    if (item.kind === 'dismiss') {
      if (typeof handlers.dismiss !== 'function') fail('dismiss handler 无效');
      return handlers.dismiss();
    }
    fail('user response action 无效');
  }

  async function runAction(value, handlers, lifecycle) {
    plain(lifecycle, 'action lifecycle');
    exactKeys(lifecycle, ['isBusy', 'setPending', 'setDisabled', 'markConsumed', 'showBusy', 'showFailure'], 'action lifecycle');
    ['isBusy', 'setPending', 'setDisabled', 'markConsumed', 'showBusy', 'showFailure'].forEach(function (name) {
      if (typeof lifecycle[name] !== 'function') fail('action lifecycle 无效');
    });
    if (lifecycle.isBusy()) {
      lifecycle.showBusy();
      return false;
    }
    lifecycle.setPending(true);
    lifecycle.setDisabled(true);
    try {
      var result = await executeAction(value, handlers);
      if (result === false) throw new Error('action not delivered');
      lifecycle.setPending(false);
      lifecycle.markConsumed();
      return true;
    } catch (_) {
      lifecycle.showFailure();
      lifecycle.setPending(false);
      lifecycle.setDisabled(false);
      return false;
    }
  }

  return { TYPES: TYPES, normalize: normalize, normalizeClarificationForm: normalizeClarificationForm, executeAction: executeAction, runAction: runAction };
});
