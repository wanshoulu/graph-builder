(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.AINativeBankApi = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  function BankClientError(status, payload) {
    var item = payload && payload.error || {};
    Error.call(this, item.message || '银行服务暂时不可用');
    this.name = 'BankClientError';
    this.message = item.message || '银行服务暂时不可用';
    this.status = status;
    this.code = item.code || 'bank_api_error';
    this.details = Array.isArray(item.details) ? item.details : [];
    this.meta = payload && payload.meta || {};
    this.operationOutcome = item.operationOutcome || 'known';
  }
  BankClientError.prototype = Object.create(Error.prototype);
  BankClientError.prototype.constructor = BankClientError;

  function createClient(options) {
    var opts = options || {};
    var fetchImpl = opts.fetch || (typeof fetch === 'function' && fetch.bind(root));
    if (!fetchImpl) throw new Error('fetch is required');
    var baseUrl = String(opts.baseUrl || '/api/ai-bank/v1').replace(/\/$/, '');
    var customerId = opts.customerId || 'cust_demo_001';
    var trace = opts.trace || root.AINativeBankTrace;
    var userResponse = opts.userResponse || root.AINativeBankUserResponse;
    var configuredSessionTimeout = Number(opts.sessionTimeoutMs == null ? 5000 : opts.sessionTimeoutMs);
    var sessionTimeoutMs = Number.isFinite(configuredSessionTimeout) && configuredSessionTimeout > 0
      ? Math.min(60000, Math.floor(configuredSessionTimeout)) : 5000;
    var idFactory = opts.idFactory || function () {
      return typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : Date.now().toString(36) + Math.random().toString(36).slice(2);
    };

    async function request(path, requestOptions) {
      var input = requestOptions || {};
      var headers = Object.assign({
        'Accept': 'application/json',
        'X-Mock-Customer-Id': customerId,
        'X-Request-Id': 'phone-' + idFactory(),
        'X-Trace-Id': input.traceId || 'phone-trace-' + idFactory(),
      }, input.headers || {});
      var init = { method: input.method || 'GET', headers: headers };
      if (Object.prototype.hasOwnProperty.call(input, 'body')) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(input.body || {});
      }
      var controller = null;
      var timeout = null;
      var timedOut = false;
      var externalSignal = input.signal || null;
      var abortFromCaller = null;
      if (input.timeoutMs != null && typeof AbortController === 'function') {
        controller = new AbortController();
        init.signal = controller.signal;
        timeout = setTimeout(function () {
          timedOut = true;
          controller.abort();
        }, input.timeoutMs);
      }
      if (externalSignal) {
        if (!controller && typeof AbortController === 'function') {
          controller = new AbortController();
          init.signal = controller.signal;
        }
        if (controller) {
          abortFromCaller = function () { controller.abort(); };
          if (externalSignal.aborted) controller.abort();
          else externalSignal.addEventListener('abort', abortFromCaller, { once: true });
        } else {
          init.signal = externalSignal;
        }
      }
      try {
        var response = await fetchImpl(baseUrl + path, init);
        var payload;
        try { payload = await response.json(); }
        catch (error) {
          if (timedOut || error && error.name === 'AbortError') throw error;
          payload = { error: { code: 'invalid_response', message: '银行服务返回了无法解析的响应' }, meta: {} };
        }
        if (!response.ok) throw new BankClientError(response.status, payload);
        return payload.data;
      } catch (error) {
        if (timedOut || error && error.name === 'AbortError') {
          throw localError(504, 'request_timeout', '银行服务响应超时，请稍后重试', 'unknown');
        }
        throw error;
      } finally {
        if (timeout != null) clearTimeout(timeout);
        if (externalSignal && abortFromCaller) externalSignal.removeEventListener('abort', abortFromCaller);
      }
    }

    function command(method, path, body, actorType, key, traceId, timeoutMs) {
      return request(path, {
        method: method, body: body || {}, traceId: traceId, timeoutMs: timeoutMs,
        headers: { 'Idempotency-Key': key || idFactory(), 'X-Actor-Type': actorType || 'agent' },
      });
    }

    function mutate(path, body, actorType, key, traceId) {
      return command('POST', path, body, actorType, key, traceId);
    }

    function wait(milliseconds) {
      return new Promise(function (resolve) { setTimeout(resolve, milliseconds); });
    }

    function localError(status, code, message, operationOutcome) {
      return new BankClientError(status, {
        error: { code: code, message: message, details: [], operationOutcome: operationOutcome },
        meta: {},
      });
    }

    function invalidResponse() {
      return localError(502, 'invalid_response', '银行服务返回了无法识别的响应', 'known-failure');
    }

    function hasExactKeys(value, keys) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      var actual = Object.keys(value);
      return actual.length === keys.length && actual.every(function (key) { return keys.indexOf(key) >= 0; });
    }

    function isSafeIdentifier(value) {
      return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value);
    }

    function isSafeAgentSessionIdentifier(value) {
      return typeof value === 'string'
        && /^conv_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
    }

    function isTimestamp(value) {
      return typeof value === 'string' && value.length <= 40
        && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
    }

    function utf8ByteLength(value) {
      if (typeof root.TextEncoder !== 'function') return Number.POSITIVE_INFINITY;
      return new root.TextEncoder().encode(value).byteLength;
    }

    function normalizeSessionSecurityText(value) {
      return value.normalize('NFKC').toLowerCase().replace(/[\u3002\uff0e\uff61]/gu, '.');
    }

    function isHexDigit(character) {
      return character >= '0' && character <= '9'
        || character >= 'a' && character <= 'f'
        || character >= 'A' && character <= 'F';
    }

    function isPercentByteAt(value, index) {
      return value[index] === '%' && index + 2 < value.length
        && isHexDigit(value[index + 1]) && isHexDigit(value[index + 2]);
    }

    function decodeSessionPercentRuns(value) {
      var parts = [];
      var unchangedStart = 0;
      var index = 0;
      var invalidRun = false;
      while (index < value.length) {
        if (!isPercentByteAt(value, index)) {
          index += 1;
          continue;
        }
        var runStart = index;
        var byteCount = 0;
        while (byteCount < 10922 && isPercentByteAt(value, index)) {
          index += 3;
          byteCount += 1;
        }
        var run = value.slice(runStart, index);
        var decoded = null;
        try { decoded = decodeURIComponent(run); }
        catch (_) { invalidRun = true; }
        parts.push(value.slice(unchangedStart, runStart), decoded === null ? run : decoded);
        unchangedStart = index;
      }
      if (unchangedStart === 0) return { value: value, changed: false, invalidRun: false };
      parts.push(value.slice(unchangedStart));
      var result = parts.join('');
      return { value: result, changed: result !== value, invalidRun: invalidRun };
    }

    function decodedSessionSecurityForms(value) {
      var forms = [];
      var current = normalizeSessionSecurityText(value);
      for (var pass = 0; pass <= 8; pass += 1) {
        var form = current.replace(/[\p{Cf}\p{Mn}\p{Me}]/gu, '');
        if (forms.indexOf(form) < 0) forms.push(form);
        var probe = decodeSessionPercentRuns(current);
        if (probe.invalidRun) return { forms: forms, unsafePercentEncoding: true };
        if (pass === 8) return { forms: forms, unsafePercentEncoding: probe.changed };
        if (!probe.changed) return { forms: forms, unsafePercentEncoding: false };
        current = normalizeSessionSecurityText(probe.value);
      }
      return { forms: forms, unsafePercentEncoding: false };
    }

    function isBase64UrlCharacter(character) {
      return character >= 'a' && character <= 'z'
        || character >= '0' && character <= '9'
        || character === '_' || character === '-';
    }

    function containsOpaqueSecret(value) {
      var runLength = 0;
      for (var index = 0; index < value.length; index += 1) {
        var character = value[index];
        if (isBase64UrlCharacter(character)) {
          runLength += 1;
          if (runLength >= 42) return true;
        } else {
          runLength = 0;
        }
        if (value.slice(index, index + 3) === 'sk-') {
          var secretLength = 0;
          for (var secretIndex = index + 3;
            secretIndex < value.length && secretLength <= 512
              && isBase64UrlCharacter(value[secretIndex]); secretIndex += 1) {
            secretLength += 1;
          }
          if (secretLength >= 20) return true;
        }
      }
      return /[a-z0-9_-]{8,2048}\.[a-z0-9_-]{8,2048}\.[a-z0-9_-]{16,2048}/iu.test(value);
    }

    function containsFullAccountNumber(value) {
      var digitCount = 0;
      for (var character of value) {
        if (/\p{Nd}/u.test(character)) {
          digitCount += 1;
          if (digitCount >= 15) return true;
        }
      }
      return false;
    }

    function isSafeSessionTurnText(value) {
      if (typeof value !== 'string' || utf8ByteLength(value) > 32768) return false;
      var decoded;
      try { decoded = decodedSessionSecurityForms(value); }
      catch (_) { return false; }
      if (decoded.unsafePercentEncoding) return false;
      var credentialMarkers = [
        'confirmationtoken', 'submissiontoken', 'tokenhash', 'authorizationtoken',
        'accesstoken', 'refreshtoken', 'grantid', 'checkpointid',
        'businessworkflowid', 'workflowid', 'agentrunid', 'conversationid',
        'customerid', 'accountid',
      ];
      for (var formIndex = 0; formIndex < decoded.forms.length; formIndex += 1) {
        var securityForm = decoded.forms[formIndex];
        var compactSecurityForm = securityForm.replace(/[\p{P}\p{S}\p{C}\p{M}]/gu, '');
        var markerForm = securityForm.replace(/[\p{P}\p{Z}\p{S}\p{M}\p{C}]/gu, '');
        if (/(?:%u[0-9a-f]{4}|\\u[0-9a-f]{4}|\\u\{[0-9a-f]{1,6}\}|\\x[0-9a-f]{2}|&#x[0-9a-f]{1,6};?|&#[0-9]{1,7};?|&(?:colon|sol|period);)/iu.test(securityForm)
          || containsFullAccountNumber(securityForm)
          || containsFullAccountNumber(compactSecurityForm)
          || credentialMarkers.some(function (marker) { return markerForm.indexOf(marker) >= 0; })
          || /\b(?:acct|acp|acg|bwf|cap|card|challenge|chk|checkpoint|conv|cust|dlg|execution|grant|order|payee|req|run|task|tok|token|trace|transfer|workflow)_[a-z0-9._:-]+\b/iu.test(securityForm)
          || /\b(?:https?|wss?|ftp|file):\/\//iu.test(securityForm)
          || /\b(?:mailto|javascript|data):/iu.test(securityForm)
          || /\/\//u.test(securityForm)
          || containsOpaqueSecret(securityForm)
          || containsOpaqueSecret(compactSecurityForm)) return false;
      }
      return true;
    }

    function normalizeStoredSessionResponse(value) {
      if (!userResponse || typeof userResponse.normalize !== 'function') throw invalidResponse();
      if (!hasExactKeys(value, ['type', 'title', 'body', 'items'])) {
        return userResponse.normalize(value);
      }
      if (['result', 'clarification', 'answer', 'confirmation', 'navigation', 'notice'].indexOf(value.type) < 0
        || !isSafeSessionTurnText(value.title) || !isSafeSessionTurnText(value.body)
        || !Array.isArray(value.items) || value.items.length > 20) throw invalidResponse();
      var items = value.items.map(function (item) {
        if (!hasExactKeys(item, ['label', 'value'])
          || !isSafeSessionTurnText(item.label) || !isSafeSessionTurnText(item.value)) throw invalidResponse();
        return item.label + '：' + item.value;
      });
      return userResponse.normalize({
        schemaVersion: '1.0', type: 'notice', title: value.title, body: value.body,
        items: items, actions: [], source: null,
      });
    }

    function projectSession(value, mode) {
      var withTurns = mode === 'get';
      var baseKeys = [
        'id', 'status', 'createdAt', 'lastActiveAt', 'idleExpiresAt',
        'absoluteExpiresAt', 'closedAt', 'closeReason',
      ];
      var keys = withTurns ? baseKeys.concat(['turns']) : baseKeys;
      var activeState = value && value.status === 'active'
        && value.closedAt === null && value.closeReason === null;
      var terminalGetState = mode === 'get' && value
        && (value.status === 'closed' || value.status === 'expired')
        && isTimestamp(value.closedAt) && isSafeIdentifier(value.closeReason);
      var closedCommandState = mode === 'close' && value && value.status === 'closed'
        && isTimestamp(value.closedAt) && isSafeIdentifier(value.closeReason);
      if (!hasExactKeys(value, keys) || !isSafeIdentifier(value.id)
        || !isTimestamp(value.createdAt) || !isTimestamp(value.lastActiveAt)
        || !isTimestamp(value.idleExpiresAt) || !isTimestamp(value.absoluteExpiresAt)
        || (mode === 'close' ? !closedCommandState : !(activeState || terminalGetState))) {
        throw invalidResponse();
      }
      var result = {
        id: value.id, status: value.status, createdAt: value.createdAt,
        lastActiveAt: value.lastActiveAt, idleExpiresAt: value.idleExpiresAt,
        absoluteExpiresAt: value.absoluteExpiresAt, closedAt: value.closedAt,
        closeReason: value.closeReason,
      };
      if (withTurns) {
        if (!Array.isArray(value.turns) || value.turns.length > 40) throw invalidResponse();
        if (value.status !== 'active' && value.turns.length !== 0) throw invalidResponse();
        result.turns = Object.freeze(value.turns.map(function (turn) {
          if (!hasExactKeys(turn, ['role', 'text', 'response'])
            || ['user', 'assistant'].indexOf(turn.role) < 0
            || typeof turn.text !== 'string' || turn.text.length > 32768
            || !isSafeSessionTurnText(turn.text)
            || utf8ByteLength(JSON.stringify(turn)) > 32768) throw invalidResponse();
          var response = null;
          if (turn.response !== null) {
            try { response = normalizeStoredSessionResponse(turn.response); }
            catch (_) { throw invalidResponse(); }
          }
          return Object.freeze({ role: turn.role, text: turn.text, response: response });
        }));
      }
      return Object.freeze(result);
    }

    function projectWorkflowSummaries(value) {
      var keys = ['businessTitle', 'completedTodoCount', 'totalTodoCount', 'updatedAt', 'riskLevel', 'maskedObject'];
      if (!Array.isArray(value) || value.length > 8) throw invalidResponse();
      return Object.freeze(value.map(function (summary) {
        if (!hasExactKeys(summary, keys)
          || typeof summary.businessTitle !== 'string' || !summary.businessTitle || summary.businessTitle.length > 240
          || !Number.isSafeInteger(summary.completedTodoCount) || summary.completedTodoCount < 0
          || !Number.isSafeInteger(summary.totalTodoCount) || summary.totalTodoCount < 1
          || summary.completedTodoCount > summary.totalTodoCount
          || !isTimestamp(summary.updatedAt)
          || typeof summary.riskLevel !== 'string' || !/^[A-Za-z0-9_.:-]{1,32}$/.test(summary.riskLevel)
          || typeof summary.maskedObject !== 'string' || !summary.maskedObject || summary.maskedObject.length > 240) {
          throw invalidResponse();
        }
        return Object.freeze({
          businessTitle: summary.businessTitle,
          completedTodoCount: summary.completedTodoCount,
          totalTodoCount: summary.totalTodoCount,
          updatedAt: summary.updatedAt,
          riskLevel: summary.riskLevel,
          maskedObject: summary.maskedObject,
        });
      }));
    }

    function projectSmartCompanions(value) {
      var keys = [
        'companionId', 'sessionId', 'title', 'stage', 'progressText',
        'summary', 'nextStep', 'actionLabel', 'updatedAt',
      ];
      var stages = ['running', 'awaiting_clarification', 'awaiting_confirmation'];
      if (!Array.isArray(value) || value.length > 2) throw invalidResponse();
      return Object.freeze(value.map(function (item) {
        function safeText(field, maximum) {
          return typeof item[field] === 'string' && item[field].length > 0
            && item[field].length <= maximum && !/[<>]/.test(item[field]);
        }
        if (!hasExactKeys(item, keys) || !isSafeIdentifier(item.companionId)
          || !isSafeIdentifier(item.sessionId) || stages.indexOf(item.stage) < 0
          || !safeText('title', 80) || !safeText('progressText', 80)
          || !safeText('summary', 160) || !safeText('nextStep', 160)
          || !safeText('actionLabel', 40) || !isTimestamp(item.updatedAt)) {
          throw invalidResponse();
        }
        return Object.freeze({
          companionId: item.companionId, sessionId: item.sessionId, title: item.title,
          stage: item.stage, progressText: item.progressText, summary: item.summary,
          nextStep: item.nextStep, actionLabel: item.actionLabel, updatedAt: item.updatedAt,
        });
      }));
    }

    function projectWorkflowBinding(value) {
      if (!hasExactKeys(value, ['businessWorkflowId', 'status', 'workflowRevision'])
        || !isSafeIdentifier(value.businessWorkflowId) || value.status !== 'suspended'
        || !Number.isSafeInteger(value.workflowRevision) || value.workflowRevision < 1) throw invalidResponse();
      return Object.freeze({
        businessWorkflowId: value.businessWorkflowId,
        status: value.status,
        workflowRevision: value.workflowRevision,
      });
    }

    function cloneAndFreeze(value) {
      if (!value || typeof value !== 'object') return value;
      var result = Array.isArray(value) ? value.map(cloneAndFreeze) : {};
      if (!Array.isArray(value)) Object.keys(value).forEach(function (key) {
        result[key] = cloneAndFreeze(value[key]);
      });
      return Object.freeze(result);
    }

    function projectServiceProgressProfiles(value) {
      var stages = [
        'request.accepted', 'user_agent.completed', 'delegation.created',
        'business_agent.started', 'business_agent.completed',
        'business_skill.started', 'business_skill.completed',
        'capability.invocation_started', 'capability.invocation_completed',
        'plan.validated', 'run.awaiting_confirmation', 'run.completed', 'workflow.rebound',
      ];
      var states = ['running', 'completed', 'failed', 'skipped'];
      function safeCopy(text, maximum) {
        return typeof text === 'string' && text.length > 0 && text.length <= maximum
          && !/[<>]/.test(text) && !/\d{12,}/.test(text)
          && !/(?:system\s*prompt|private\s*prompt|confirmation\s*token|access\s*token)/i.test(text);
      }
      if (!hasExactKeys(value, ['schemaVersion', 'profiles']) || value.schemaVersion !== '1.0'
        || !Array.isArray(value.profiles) || value.profiles.length > 64) throw invalidResponse();
      var profileIds = new Set();
      var skillIds = new Set();
      value.profiles.forEach(function (profile) {
        if (!hasExactKeys(profile, [
          'id', 'version', 'title', 'skillIds', 'intentIds', 'completionSummary',
          'failureSummary', 'steps', 'transitions',
        ]) || !/^[a-z][a-z0-9-]{2,79}$/.test(profile.id) || profileIds.has(profile.id)
          || !/^\d+\.\d+\.\d+$/.test(profile.version) || !safeCopy(profile.title, 80)
          || !safeCopy(profile.completionSummary, 240) || !safeCopy(profile.failureSummary, 160)
          || !Array.isArray(profile.skillIds) || !profile.skillIds.length || profile.skillIds.length > 16
          || !Array.isArray(profile.intentIds) || !profile.intentIds.length || profile.intentIds.length > 16
          || !Array.isArray(profile.steps) || !profile.steps.length || profile.steps.length > 24
          || !Array.isArray(profile.transitions) || !profile.transitions.length || profile.transitions.length > 48) {
          throw invalidResponse();
        }
        profile.skillIds.forEach(function (id) {
          if (!/^bank\.[a-z0-9.-]+$/.test(id) || skillIds.has(id)) throw invalidResponse();
          skillIds.add(id);
        });
        if (new Set(profile.intentIds).size !== profile.intentIds.length
          || profile.intentIds.some(function (id) { return !/^ccb\.[a-z0-9.-]+$/.test(id); })) throw invalidResponse();
        var stepIds = new Set();
        profile.steps.forEach(function (step) {
          if (!hasExactKeys(step, ['id', 'label', 'completedLabel'])
            || !/^[a-z][a-z0-9_]{1,63}$/.test(step.id) || stepIds.has(step.id)
            || !safeCopy(step.label, 100) || !safeCopy(step.completedLabel, 100)) throw invalidResponse();
          stepIds.add(step.id);
        });
        profile.transitions.forEach(function (transition) {
          if (!hasExactKeys(transition, ['stage', 'match', 'updates'])
            || stages.indexOf(transition.stage) < 0 || !transition.match
            || typeof transition.match !== 'object' || Array.isArray(transition.match)
            || Object.keys(transition.match).some(function (key) {
              return ['skillId', 'capabilityId'].indexOf(key) < 0
                || !/^bank\.[a-z0-9.-]+$/.test(transition.match[key]);
            }) || !Array.isArray(transition.updates) || !transition.updates.length
            || transition.updates.length > 24) throw invalidResponse();
          transition.updates.forEach(function (update) {
            if (!hasExactKeys(update, ['stepId', 'state']) || !stepIds.has(update.stepId)
              || states.indexOf(update.state) < 0) throw invalidResponse();
          });
        });
        profileIds.add(profile.id);
      });
      return cloneAndFreeze(value);
    }

    function isCount(value) {
      return Number.isSafeInteger(value) && value >= 0;
    }

    function isWorkbenchTimestamp(value) {
      return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
    }

    function assertExactCountObject(value, keys) {
      if (!hasExactKeys(value, keys) || keys.some(function (key) { return !isCount(value[key]); })) {
        throw invalidResponse();
      }
    }

    function projectWorkbenchOverview(value) {
      if (!hasExactKeys(value, ['graph', 'capabilities', 'skills', 'providers', 'intents', 'entries'])
        || !hasExactKeys(value.graph, ['id', 'version'])
        || !isSafeIdentifier(value.graph.id)
        || typeof value.graph.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(value.graph.version)) {
        throw invalidResponse();
      }
      assertExactCountObject(value.capabilities, [
        'registered', 'modelCallable', 'userAction', 'systemOnly', 'plannable',
        'executable', 'enabled', 'deferred', 'platformOnly',
      ]);
      assertExactCountObject(value.skills, ['registered', 'active']);
      if (!hasExactKeys(value.providers, [
        'registered', 'declaredReady', 'liveHealthy', 'liveUnavailable', 'liveStale',
        'businessAvailable', 'observedAt', 'status',
      ])) throw invalidResponse();
      [
        'registered', 'declaredReady', 'liveHealthy', 'liveUnavailable', 'liveStale',
        'businessAvailable',
      ].forEach(function (key) { if (!isCount(value.providers[key])) throw invalidResponse(); });
      if (!(value.providers.observedAt === null || isWorkbenchTimestamp(value.providers.observedAt))
        || ['healthy', 'degraded', 'unavailable', 'stale', 'unverified'].indexOf(value.providers.status) < 0) {
        throw invalidResponse();
      }
      assertExactCountObject(value.intents, ['registered', 'ready']);
      assertExactCountObject(value.entries, [
        'channels', 'menus', 'actions', 'capabilityBackedActions', 'readyActions',
      ]);
      if (value.capabilities.modelCallable + value.capabilities.userAction
          + value.capabilities.systemOnly !== value.capabilities.registered
        || value.capabilities.enabled + value.capabilities.deferred
          + value.capabilities.platformOnly !== value.capabilities.registered
        || value.skills.active > value.skills.registered
        || value.providers.declaredReady > value.providers.registered
        || value.providers.liveHealthy + value.providers.liveUnavailable
          + value.providers.liveStale > value.providers.registered
        || value.providers.businessAvailable > value.providers.liveHealthy
        || value.intents.ready > value.intents.registered
        || value.entries.readyActions > value.entries.actions
        || value.entries.capabilityBackedActions > value.entries.actions) throw invalidResponse();
      return cloneAndFreeze(value);
    }

    var MEMORY_RECORD_KINDS = ['working', 'semantic', 'episodic', 'procedural'];
    var MEMORY_STATUSES = ['active', 'pending', 'contested', 'revoked', 'expired', 'rejected'];
    var MEMORY_DISPLAY_TYPES = ['text', 'currency', 'integer', 'boolean', 'date', 'enum', 'masked_reference'];
    var MEMORY_SENSITIVITY = ['L0', 'L1', 'L2', 'L3'];

    function isMemoryText(value, maximum) {
      return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[<>]/.test(value);
    }

    function isMemoryRef(value, prefix) {
      var expression = prefix === 'cursor'
        ? /^memcursor_[A-Za-z0-9_-]{20,80}$/
        : /^memview_[A-Za-z0-9_-]{20,80}$/;
      return typeof value === 'string' && expression.test(value);
    }

    function validateMemoryTimeRange(value) {
      if (!hasExactKeys(value, ['from', 'to']) || !isWorkbenchTimestamp(value.from)
        || !(value.to === null || isWorkbenchTimestamp(value.to))) throw invalidResponse();
    }

    function validateMemoryCustomer(value) {
      if (!hasExactKeys(value, ['displayName', 'maskedId'])
        || !isMemoryText(value.displayName, 120) || !isMemoryText(value.maskedId, 120)
        || !/^[A-Za-z0-9][A-Za-z0-9._:•*-]{0,127}$/.test(value.maskedId)) throw invalidResponse();
    }

    function validateMemoryPredicate(value) {
      if (value === null) return;
      if (!hasExactKeys(value, ['id', 'label']) || !isSafeIdentifier(value.id)
        || !isMemoryText(value.label, 120)) throw invalidResponse();
    }

    function validateMemoryRow(value) {
      if (!hasExactKeys(value, [
        'id', 'customer', 'recordKind', 'predicate', 'safeValueSummary', 'displayType',
        'source', 'status', 'validTime', 'systemTime', 'sensitivity',
      ]) || !isMemoryRef(value.id, 'view') || MEMORY_RECORD_KINDS.indexOf(value.recordKind) < 0
        || !isMemoryText(value.safeValueSummary, 240)
        || MEMORY_DISPLAY_TYPES.indexOf(value.displayType) < 0
        || MEMORY_STATUSES.indexOf(value.status) < 0
        || MEMORY_SENSITIVITY.indexOf(value.sensitivity) < 0
        || !hasExactKeys(value.source, ['type', 'label']) || !isSafeIdentifier(value.source.type)
        || !isMemoryText(value.source.label, 120)) throw invalidResponse();
      validateMemoryCustomer(value.customer);
      validateMemoryPredicate(value.predicate);
      validateMemoryTimeRange(value.validTime);
      validateMemoryTimeRange(value.systemTime);
    }

    function projectMemoryWorkbenchOverview(value) {
      if (!hasExactKeys(value, ['schemaVersion', 'generatedAt', 'mode', 'policyVersion', 'health', 'counts'])
        || value.schemaVersion !== '1.0' || !isWorkbenchTimestamp(value.generatedAt)
        || ['off', 'shadow', 'read_only', 'governed_write', 'graph_projection'].indexOf(value.mode) < 0
        || !isSafeIdentifier(value.policyVersion)
        || !hasExactKeys(value.health, ['controlPlane', 'relationalStore', 'index', 'graph'])
        || ['healthy', 'degraded', 'unavailable'].indexOf(value.health.controlPlane) < 0
        || ['healthy', 'degraded', 'unavailable'].indexOf(value.health.relationalStore) < 0
        || ['healthy', 'degraded', 'unavailable', 'disabled'].indexOf(value.health.index) < 0
        || ['healthy', 'degraded', 'unavailable', 'disabled'].indexOf(value.health.graph) < 0) {
        throw invalidResponse();
      }
      assertExactCountObject(value.counts, ['total', 'active', 'pending', 'contested', 'revokedOrExpired']);
      if (value.counts.active + value.counts.pending + value.counts.contested
          + value.counts.revokedOrExpired > value.counts.total) throw invalidResponse();
      return cloneAndFreeze(value);
    }

    function projectMemoryWorkbenchPage(value) {
      if (!hasExactKeys(value, ['schemaVersion', 'generatedAt', 'policyVersion', 'items', 'nextCursor'])
        || value.schemaVersion !== '1.0' || !isWorkbenchTimestamp(value.generatedAt)
        || !isSafeIdentifier(value.policyVersion) || !Array.isArray(value.items)
        || value.items.length > 100
        || !(value.nextCursor === null || isMemoryRef(value.nextCursor, 'cursor'))) throw invalidResponse();
      value.items.forEach(validateMemoryRow);
      return cloneAndFreeze(value);
    }

    function validateMemoryDetailOverview(value) {
      if (!hasExactKeys(value, [
        'customer', 'predicate', 'safeValueSummary', 'displayType', 'memoryType', 'status',
        'sensitivity', 'sourceAuthority', 'confidence', 'validTime', 'systemTime',
        'allowedPurposes', 'usagePolicy', 'requiresCoreRefresh', 'requiresConfirmation',
        'policyVersion', 'retentionLabel',
      ]) || !isMemoryText(value.safeValueSummary, 240)
        || MEMORY_DISPLAY_TYPES.indexOf(value.displayType) < 0
        || MEMORY_RECORD_KINDS.indexOf(value.memoryType) < 0
        || MEMORY_STATUSES.indexOf(value.status) < 0
        || MEMORY_SENSITIVITY.indexOf(value.sensitivity) < 0
        || !hasExactKeys(value.sourceAuthority, ['label', 'rank'])
        || !isMemoryText(value.sourceAuthority.label, 120)
        || !Number.isSafeInteger(value.sourceAuthority.rank) || value.sourceAuthority.rank < 0
        || value.sourceAuthority.rank > 100 || typeof value.confidence !== 'number'
        || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1
        || !Array.isArray(value.allowedPurposes) || value.allowedPurposes.length > 20
        || value.allowedPurposes.some(function (item) { return !isSafeIdentifier(item); })
        || !isSafeIdentifier(value.usagePolicy) || typeof value.requiresCoreRefresh !== 'boolean'
        || typeof value.requiresConfirmation !== 'boolean' || !isSafeIdentifier(value.policyVersion)
        || !isMemoryText(value.retentionLabel, 120)) throw invalidResponse();
      validateMemoryCustomer(value.customer);
      validateMemoryPredicate(value.predicate);
      validateMemoryTimeRange(value.validTime);
      validateMemoryTimeRange(value.systemTime);
    }

    function validateMemoryTimelineItem(value) {
      if (!hasExactKeys(value, ['safeValueSummary', 'status', 'validTime', 'systemTime', 'relation'])
        || !isMemoryText(value.safeValueSummary, 240) || MEMORY_STATUSES.indexOf(value.status) < 0
        || ['current', 'supersedes', 'superseded_by', 'contests', 'late_arrival',
          'revoked_by_consent', 'tombstoned'].indexOf(value.relation) < 0) {
        throw invalidResponse();
      }
      validateMemoryTimeRange(value.validTime);
      validateMemoryTimeRange(value.systemTime);
    }

    function validateMemoryEvidenceItem(value) {
      if (!hasExactKeys(value, [
        'episodeType', 'occurredAt', 'recordedAt', 'sourceLabel', 'contentHashShort',
        'safeSummary', 'sourceLink',
      ]) || !isSafeIdentifier(value.episodeType) || !isWorkbenchTimestamp(value.occurredAt)
        || !isWorkbenchTimestamp(value.recordedAt) || !isMemoryText(value.sourceLabel, 120)
        || !/^[a-f0-9]{8,16}$/.test(value.contentHashShort || '')
        || !isMemoryText(value.safeSummary, 240)) throw invalidResponse();
      if (value.sourceLink !== null && (!hasExactKeys(value.sourceLink, ['type', 'targetId'])
        || value.sourceLink.type !== 'agent_run' || !isSafeIdentifier(value.sourceLink.targetId))) {
        throw invalidResponse();
      }
    }

    function validateMemoryUseItem(value) {
      if (!hasExactKeys(value, ['usedAt', 'purpose', 'outcome', 'runRef'])
        || !isWorkbenchTimestamp(value.usedAt) || !isSafeIdentifier(value.purpose)
        || ['included', 'filtered', 'core_refresh_required', 'confirmation_required'].indexOf(value.outcome) < 0
        || !(value.runRef === null || isSafeIdentifier(value.runRef))) throw invalidResponse();
    }

    function projectMemoryWorkbenchDetail(value) {
      if (!hasExactKeys(value, ['schemaVersion', 'id', 'overview', 'timeline', 'evidence', 'uses'])
        || value.schemaVersion !== '1.0' || !isMemoryRef(value.id, 'view')
        || !Array.isArray(value.timeline) || value.timeline.length > 50
        || !Array.isArray(value.evidence) || value.evidence.length > 50
        || !Array.isArray(value.uses) || value.uses.length > 50) throw invalidResponse();
      validateMemoryDetailOverview(value.overview);
      value.timeline.forEach(validateMemoryTimelineItem);
      value.evidence.forEach(validateMemoryEvidenceItem);
      value.uses.forEach(validateMemoryUseItem);
      return cloneAndFreeze(value);
    }

    function validateRate(value) {
      if (!hasExactKeys(value, ['ready', 'total', 'rate'])
        || !isCount(value.ready) || !isCount(value.total) || value.ready > value.total
        || !(value.rate === null || typeof value.rate === 'number'
          && Number.isFinite(value.rate) && value.rate >= 0 && value.rate <= 100)
        || (value.total === 0) !== (value.rate === null)) throw invalidResponse();
    }

    function validateIdArray(value, pattern, maximum) {
      if (!Array.isArray(value) || value.length > maximum
        || new Set(value).size !== value.length
        || value.some(function (item) { return typeof item !== 'string' || !pattern.test(item); })) {
        throw invalidResponse();
      }
    }

    function projectWorkbenchScenarios(value) {
      if (!Array.isArray(value) || value.length > 32) throw invalidResponse();
      var ids = new Set();
      value.forEach(function (item) {
        var keys = [
          'id', 'version', 'title', 'domain', 'owner', 'manifestStatus', 'readinessStatus',
          'intentReadiness', 'capabilityReadiness', 'evaluation', 'intentIds', 'menuIds',
          'requiredCapabilityIds', 'gaps',
        ];
        if (!hasExactKeys(item, keys) || !/^[a-z][a-z0-9-]{1,63}$/.test(item.id || '')
          || ids.has(item.id) || !/^\d+\.\d+\.\d+$/.test(item.version || '')
          || typeof item.title !== 'string' || !item.title || item.title.length > 80
          || !/^[a-z][a-z0-9-]{1,63}$/.test(item.domain || '')
          || !/^[a-z][a-z0-9-]{1,63}$/.test(item.owner || '')
          || ['active', 'planned', 'retired'].indexOf(item.manifestStatus) < 0
          || ['ready', 'partial', 'planned'].indexOf(item.readinessStatus) < 0) throw invalidResponse();
        ids.add(item.id);
        validateRate(item.intentReadiness);
        validateRate(item.capabilityReadiness);
        if (!hasExactKeys(item.evaluation, [
          'status', 'passed', 'executed', 'rate', 'datasetId', 'evaluatedAt',
        ]) || item.evaluation.status !== 'not_evaluated'
          || item.evaluation.passed !== 0 || item.evaluation.executed !== 0
          || item.evaluation.rate !== null || item.evaluation.evaluatedAt !== null
          || !(item.evaluation.datasetId === null
            || typeof item.evaluation.datasetId === 'string' && item.evaluation.datasetId.length <= 128)) {
          throw invalidResponse();
        }
        validateIdArray(item.intentIds, /^ccb\.[a-z0-9.-]+$/, 64);
        validateIdArray(item.menuIds, /^ccb\.menu\.[a-z0-9.-]+$/, 32);
        validateIdArray(item.requiredCapabilityIds, /^bank\.[a-z0-9.-]+$/, 64);
        if (!Array.isArray(item.gaps) || item.gaps.length > 64) throw invalidResponse();
        item.gaps.forEach(function (gap) {
          if (!hasExactKeys(gap, ['capabilityId', 'integrationStatus', 'reason'])
            || !/^bank\.[a-z0-9.-]+$/.test(gap.capabilityId || '')
            || ['deferred', 'platform-only'].indexOf(gap.integrationStatus) < 0
            || typeof gap.reason !== 'string' || gap.reason.length > 500) throw invalidResponse();
        });
      });
      return cloneAndFreeze(value);
    }

    function validateSafeWorkbenchValue(value, depth) {
      var level = depth || 0;
      if (level > 6 || value === undefined) throw invalidResponse();
      if (value === null || typeof value === 'boolean') return;
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw invalidResponse();
        return;
      }
      if (typeof value === 'string') {
        if (value.length > 1000 || !isSafeSessionTurnText(value)) throw invalidResponse();
        return;
      }
      if (Array.isArray(value)) {
        if (value.length > 64) throw invalidResponse();
        value.forEach(function (item) { validateSafeWorkbenchValue(item, level + 1); });
        return;
      }
      if (Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length > 64) {
        throw invalidResponse();
      }
      Object.keys(value).forEach(function (key) {
        if (/token|secret|password|prompt|stack|database|input.?hash|graph.?digest|raw.?content/i.test(key)) {
          throw invalidResponse();
        }
        validateSafeWorkbenchValue(value[key], level + 1);
      });
    }

    function validateBoundedWorkbenchValue(value, depth, maxDepth) {
      var level = depth || 0;
      var cap = maxDepth || 6;
      if (level > cap || value === undefined) throw invalidResponse();
      if (value === null || typeof value === 'boolean') return;
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw invalidResponse();
        return;
      }
      if (typeof value === 'string') {
        if (value.length > 1000) throw invalidResponse();
        return;
      }
      if (Array.isArray(value)) {
        if (value.length > 128) throw invalidResponse();
        value.forEach(function (item) { validateBoundedWorkbenchValue(item, level + 1, maxDepth); });
        return;
      }
      if (Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length > 64) {
        throw invalidResponse();
      }
      Object.keys(value).forEach(function (key) {
        if (/token|secret|password|prompt|stack|database.?path|input.?hash|graph.?digest|raw.?content/i.test(key)) {
          throw invalidResponse();
        }
        validateBoundedWorkbenchValue(value[key], level + 1, maxDepth);
      });
    }

    function projectWorkbenchAssets(value) {
      if (!hasExactKeys(value, ['filters', 'total', 'items'])
        || !hasExactKeys(value.filters, ['type', 'domain', 'integrationStatus'])
        || ['all', 'capability', 'skill', 'provider'].indexOf(value.filters.type) < 0
        || !(value.filters.domain === null || /^[a-z][a-z0-9-]{1,63}$/.test(value.filters.domain))
        || !(value.filters.integrationStatus === null
          || ['enabled', 'deferred', 'platform-only'].indexOf(value.filters.integrationStatus) >= 0)
        || !isCount(value.total) || !Array.isArray(value.items) || value.items.length > 128
        || value.total !== value.items.length) throw invalidResponse();
      value.items.forEach(function (item) {
        if (!item || typeof item !== 'object' || Array.isArray(item)
          || ['capability', 'skill', 'provider'].indexOf(item.type) < 0) throw invalidResponse();
        var keys = item.type === 'capability' ? [
          'type', 'id', 'title', 'description', 'version', 'domain', 'exposure', 'sideEffect',
          'riskLevel', 'requiredScopes', 'confirmationPolicy', 'idempotencyPolicy', 'readiness',
          'integrationStatus', 'integrationReason', 'providerIds', 'skillIds', 'intentIds',
          'featureActionKeys', 'inputFields', 'outputFields',
        ] : item.type === 'skill' ? [
          'type', 'id', 'title', 'version', 'status', 'owner', 'riskBoundary',
          'handledIntentIds', 'requiredCapabilityIds', 'businessObjectIds', 'providerIds',
        ] : [
          'type', 'id', 'title', 'providerType', 'exposure', 'health', 'version', 'domain',
          'capabilityId',
        ];
        if (!hasExactKeys(item, keys)) throw invalidResponse();
        validateBoundedWorkbenchValue(item);
      });
      return cloneAndFreeze(value);
    }

    function projectDataAssetMetrics(value) {
      if (!Array.isArray(value) || value.length > 8) throw invalidResponse();
      value.forEach(function (item) {
        if (!hasExactKeys(item, ['label', 'value'])
          || typeof item.label !== 'string' || !item.label || item.label.length > 40
          || typeof item.value !== 'string' || item.value.length > 80) throw invalidResponse();
      });
      return value;
    }

    function projectDataAssets(value) {
      if (!hasExactKeys(value, ['total', 'items'])
        || !isCount(value.total) || !Array.isArray(value.items)
        || value.items.length > 16 || value.total !== value.items.length) throw invalidResponse();
      value.items.forEach(function (item) {
        if (!hasExactKeys(item, ['id', 'title', 'description', 'recordCount', 'metrics'])
          || !isSafeIdentifier(item.id)
          || typeof item.title !== 'string' || !item.title || item.title.length > 80
          || typeof item.description !== 'string' || item.description.length > 240
          || !isCount(item.recordCount)) throw invalidResponse();
        projectDataAssetMetrics(item.metrics);
      });
      return cloneAndFreeze(value);
    }

    function projectDataAssetDetail(value) {
      if (!hasExactKeys(value, ['category', 'recordCount', 'metrics', 'records'])
        || !hasExactKeys(value.category, ['id', 'title', 'description'])
        || !isSafeIdentifier(value.category.id)
        || typeof value.category.title !== 'string' || !value.category.title
        || value.category.title.length > 80
        || typeof value.category.description !== 'string'
        || value.category.description.length > 240
        || !isCount(value.recordCount) || !Array.isArray(value.records)
        || value.records.length > 64 || value.recordCount !== value.records.length) throw invalidResponse();
      projectDataAssetMetrics(value.metrics);
      value.records.forEach(function (record) {
        if (!hasExactKeys(record, ['id', 'title', 'subtitle', 'statusLabel', 'fields'])
          || !isSafeIdentifier(record.id)
          || typeof record.title !== 'string' || !record.title || record.title.length > 160
          || typeof record.subtitle !== 'string' || record.subtitle.length > 240
          || record.statusLabel !== null && (typeof record.statusLabel !== 'string'
            || !record.statusLabel || record.statusLabel.length > 40)
          || !Array.isArray(record.fields) || record.fields.length > 12) throw invalidResponse();
        record.fields.forEach(function (field) {
          if (!hasExactKeys(field, ['label', 'value'])
            || typeof field.label !== 'string' || !field.label || field.label.length > 40
            || typeof field.value !== 'string' || field.value.length > 200) throw invalidResponse();
        });
      });
      return cloneAndFreeze(value);
    }

    function projectWorkbenchExperienceScenarios(value) {
      if (!Array.isArray(value) || value.length > 128) throw invalidResponse();
      var ids = new Set();
      value.forEach(function (item) {
        if (!hasExactKeys(item, [
          'id', 'version', 'title', 'type', 'priority', 'complianceClass', 'action', 'surfaces',
          'targetIntentId', 'workflowTemplateId', 'supersededBy', 'requiredSkillIds',
          'requiredCapabilityIds', 'reasonCode', 'reasonTextTemplate', 'entryMessage',
          'triggerSummary', 'reshowAfterHours', 'cooldownHours', 'memoryEnabled',
        ]) || !/^[a-z][a-z0-9-]{2,95}$/.test(item.id || '')
          || ids.has(item.id) || !/^\d+\.\d+\.\d+$/.test(item.version || '')
          || typeof item.title !== 'string' || !item.title || item.title.length > 80
          || ['next_intent', 'proactive_service', 'care'].indexOf(item.type) < 0
          || ['critical', 'high', 'normal', 'low'].indexOf(item.priority) < 0
          || !(item.complianceClass === null
            || ['service', 'marketing', 'risk'].indexOf(item.complianceClass) >= 0)
          || ['START_ASSISTANCE', 'OPEN_CATALOG'].indexOf(item.action) < 0
          || !Array.isArray(item.surfaces) || !item.surfaces.length || item.surfaces.length > 3
          || item.surfaces.some(function (s) { return ['home', 'agent', 'channel'].indexOf(s) < 0; })
          || typeof item.triggerSummary !== 'string' || !item.triggerSummary
          || item.triggerSummary.length > 500
          || typeof item.reasonTextTemplate !== 'string' || !item.reasonTextTemplate
          || item.reasonTextTemplate.length > 160
          || typeof item.memoryEnabled !== 'boolean'
          || !Number.isInteger(item.cooldownHours)
          || item.cooldownHours < 0 || item.cooldownHours > 8760
          || !(item.reshowAfterHours === null
            || Number.isInteger(item.reshowAfterHours) && item.reshowAfterHours >= 1 && item.reshowAfterHours <= 168)) {
          throw invalidResponse();
        }
        ids.add(item.id);
        validateIdArray(item.requiredSkillIds, /^bank\.[a-z0-9.-]+$/, 16);
        validateIdArray(item.requiredCapabilityIds, /^bank\.[a-z0-9.-]+$/, 32);
        validateBoundedWorkbenchValue(item);
      });
      return cloneAndFreeze(value);
    }

    var runStatuses = [
      'accepted', 'interpreting', 'planning', 'awaiting_confirmation', 'executing',
      'succeeded', 'failed', 'clarification_required', 'navigation_only', 'blocked',
    ];
    var traceAvailability = ['recording', 'complete', 'incomplete', 'legacy_unavailable'];

    function validateRunSummary(item) {
      var keys = [
        'id', 'conversationId', 'traceId', 'status', 'graphVersion', 'traceAvailability',
        'lastTraceSequence', 'createdAt', 'updatedAt', 'durationMs',
        'capabilityInvocationCount', 'confirmationCount',
      ];
      if (!hasExactKeys(item, keys) || !isSafeIdentifier(item.id)
        || !isSafeIdentifier(item.conversationId) || !isSafeIdentifier(item.traceId)
        || runStatuses.indexOf(item.status) < 0 || traceAvailability.indexOf(item.traceAvailability) < 0
        || typeof item.graphVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(item.graphVersion)
        || !isCount(item.lastTraceSequence) || item.lastTraceSequence > 128
        || !isWorkbenchTimestamp(item.createdAt) || !isWorkbenchTimestamp(item.updatedAt)
        || !(item.durationMs === null || isCount(item.durationMs))
        || !isCount(item.capabilityInvocationCount) || !isCount(item.confirmationCount)) {
        throw invalidResponse();
      }
    }

    function projectAgentRunPage(value) {
      if (!hasExactKeys(value, ['items', 'nextCursor'])
        || !Array.isArray(value.items) || value.items.length > 50
        || !(value.nextCursor === null || typeof value.nextCursor === 'string'
          && value.nextCursor.length >= 1 && value.nextCursor.length <= 512)) throw invalidResponse();
      value.items.forEach(validateRunSummary);
      return cloneAndFreeze(value);
    }

    var memoryCommandStatuses = [
      'QUEUED', 'PROCESSING', 'PENDING_RETRY', 'PERSISTED', 'CONTESTED', 'REJECTED', 'DEAD_LETTER',
    ];
    var memoryCommandDecisions = ['ADD', 'MERGE', 'SUPERSEDE', 'CONTESTED', 'REJECT'];

    function validateMemoryUpdateItem(item) {
      if (!hasExactKeys(item, [
        'candidateType', 'predicate', 'status', 'decision', 'governanceStatus',
        'reason', 'policyVersion', 'attempts', 'updatedAt',
      ]) || !isSafeIdentifier(item.candidateType) || !isSafeIdentifier(item.predicate)
        || memoryCommandStatuses.indexOf(item.status) < 0
        || !(item.decision === null || memoryCommandDecisions.indexOf(item.decision) >= 0)
        || !(item.governanceStatus === null || isSafeIdentifier(item.governanceStatus))
        || !(item.reason === null || typeof item.reason === 'string' && item.reason.length <= 200)
        || !(item.policyVersion === null || isSafeIdentifier(item.policyVersion))
        || !isCount(item.attempts) || !isWorkbenchTimestamp(item.updatedAt)) {
        throw invalidResponse();
      }
    }

    function validateModelCallItem(item) {
      if (!hasExactKeys(item, [
        'phase', 'model', 'prompt', 'response', 'toolsCount', 'durationMs', 'status', 'occurredAt',
      ]) || !/^[a-z][a-z0-9_]{1,63}$/.test(item.phase || '')
        || !(item.model === null || /^[A-Za-z0-9_.:-]{1,96}$/.test(item.model))
        || !(item.prompt === null || typeof item.prompt === 'string' && item.prompt.length <= 16000)
        || !(item.response === null || typeof item.response === 'string' && item.response.length <= 16000)
        || !isCount(item.toolsCount)
        || !(item.durationMs === null || isCount(item.durationMs))
        || ['ok', 'error'].indexOf(item.status) < 0
        || !isWorkbenchTimestamp(item.occurredAt)) {
        throw invalidResponse();
      }
    }

    function projectAgentRunDetail(value) {
      if (!hasExactKeys(value, [
        'run', 'traceAvailability', 'turns', 'events', 'workflows', 'invocations', 'confirmations', 'audits',
        'memoryUpdates', 'modelCalls',
      ])) throw invalidResponse();
      validateRunSummary(value.run);
      if (traceAvailability.indexOf(value.traceAvailability) < 0
        || value.traceAvailability !== value.run.traceAvailability) throw invalidResponse();
      var limits = {
        events: 128, workflows: 32, invocations: 128, confirmations: 64, audits: 128, memoryUpdates: 20,
        modelCalls: 64, turns: 20,
      };
      Object.keys(limits).forEach(function (key) {
        if (!Array.isArray(value[key]) || value[key].length > limits[key]) throw invalidResponse();
      });
      value.memoryUpdates.forEach(validateMemoryUpdateItem);
      value.turns.forEach(function (item) {
        if (!hasExactKeys(item, ['role', 'text', 'createdAt'])
          || ['user', 'assistant'].indexOf(item.role) < 0
          || typeof item.text !== 'string' || item.text.length > 1000
          || !isWorkbenchTimestamp(item.createdAt)) throw invalidResponse();
      });
      // 模型调用是运维观测层文本（prompt/response），与轨迹摘要同一信任边界：
      // 只做结构+长度校验，不做聊天文本启发式，渲染统一走 escapeHtml。
      value.modelCalls.forEach(validateModelCallItem);
      value.events.forEach(function (event) {
        if (!hasExactKeys(event, [
          'sequence', 'stage', 'status', 'durationMs', 'policyVersion', 'summary', 'createdAt',
        ]) || !Number.isInteger(event.sequence) || event.sequence < 1 || event.sequence > 128
          || !/^[a-z][a-z0-9_.-]{1,63}$/.test(event.stage || '')
          || !/^[a-z][a-z0-9_.-]{1,31}$/.test(event.status || '')
          || !(event.durationMs === null || isCount(event.durationMs))
          || !(event.policyVersion === null || isSafeIdentifier(event.policyVersion))
          || !isWorkbenchTimestamp(event.createdAt)) throw invalidResponse();
        // 轨迹摘要是服务端生成的安全投影（服务端已做键级敏感过滤与字节上限，
        // 深度按 summary→memoryRecall→groups→items→controls 允许到 8 层），
        // 且前端只渲染 escapeHtml 后的 title：这里用结构+长度校验，不能用
        // 聊天文本启发式（禁 ID 形态/URL 等），否则带关联 ID 的正常轨迹会被整体拒载。
        validateBoundedWorkbenchValue(event.summary, 0, 8);
      });
      value.workflows.forEach(function (item) {
        if (!hasExactKeys(item, [
          'id', 'conversationId', 'status', 'relation', 'workflowRevision', 'todoRevision',
          'pendingConfirmationCount', 'createdAt', 'updatedAt',
        ]) || !isSafeIdentifier(item.id) || !isSafeIdentifier(item.conversationId)
          || typeof item.status !== 'string' || !item.status
          || ['created-or-updated', 'resumed', 'confirmed'].indexOf(item.relation) < 0
          || !isCount(item.workflowRevision) || !isCount(item.todoRevision)
          || !isCount(item.pendingConfirmationCount)
          || !isWorkbenchTimestamp(item.createdAt) || !isWorkbenchTimestamp(item.updatedAt)) throw invalidResponse();
      });
      value.invocations.forEach(function (item) {
        if (!hasExactKeys(item, ['capabilityId', 'status', 'createdAt'])
          || !/^bank\.[a-z0-9.-]+$/.test(item.capabilityId || '')
          || typeof item.status !== 'string' || !item.status
          || !isWorkbenchTimestamp(item.createdAt)) throw invalidResponse();
      });
      value.confirmations.forEach(function (item) {
        if (!hasExactKeys(item, ['capabilityId', 'status', 'expiresAt', 'consumedAt', 'createdAt'])
          || !/^bank\.[a-z0-9.-]+$/.test(item.capabilityId || '')
          || typeof item.status !== 'string' || !item.status
          || !isWorkbenchTimestamp(item.expiresAt)
          || !(item.consumedAt === null || isWorkbenchTimestamp(item.consumedAt))
          || !isWorkbenchTimestamp(item.createdAt)) throw invalidResponse();
      });
      value.audits.forEach(function (item) {
        if (!hasExactKeys(item, ['action', 'resourceType', 'outcome', 'createdAt'])
          || typeof item.action !== 'string' || !item.action
          || typeof item.resourceType !== 'string' || !item.resourceType
          || typeof item.outcome !== 'string' || !item.outcome
          || !isWorkbenchTimestamp(item.createdAt)) throw invalidResponse();
      });
      return cloneAndFreeze(value);
    }

    function projectNextActionPage(value) {
      if (!hasExactKeys(value, ['schemaVersion', 'mode', 'generatedAt', 'personalizationEnabled', 'items'])
        || value.schemaVersion !== '1.0' || ['deterministic', 'hybrid'].indexOf(value.mode) < 0
        || !isTimestamp(value.generatedAt) || typeof value.personalizationEnabled !== 'boolean'
        || !Array.isArray(value.items) || value.items.length > 3) throw invalidResponse();
      return cloneAndFreeze({
        schemaVersion: value.schemaVersion,
        mode: value.mode,
        generatedAt: value.generatedAt,
        personalizationEnabled: value.personalizationEnabled,
        items: value.items.map(projectNextActionItem),
      });
    }

    function projectNextActionItem(item) {
      var keys = [
        'recommendationId', 'scenarioId', 'scenarioVersion', 'type', 'title', 'priority',
        'reasonCodes', 'reasonText', 'action', 'targetIntentId', 'workflowTemplateId',
        'requiredSkillIds', 'requiredCapabilityIds', 'catalogAction', 'surface', 'channel',
        'status', 'score', 'rank', 'generatedAt', 'expiresAt', 'shownAt', 'acceptedAt',
        'completedAt', 'outcome',
      ];
      var types = ['resume_task', 'proactive_service', 'next_intent'];
      var priorities = ['critical', 'high', 'normal', 'low'];
      var actions = ['START_ASSISTANCE', 'OPEN_CATALOG', 'RESUME_WORKFLOW'];
      var statuses = ['generated', 'shown', 'accepted', 'dismissed', 'snoozed', 'expired', 'started', 'completed'];
      if (!hasExactKeys(item, keys) || !isSafeIdentifier(item.recommendationId)
        || !isSafeIdentifier(item.scenarioId) || typeof item.scenarioVersion !== 'string'
        || !/^\d+\.\d+\.\d+$/.test(item.scenarioVersion) || types.indexOf(item.type) < 0
        || !safeNextActionText(item.title, 80) || priorities.indexOf(item.priority) < 0
        || !safeIdentifierArray(item.reasonCodes, 8) || !safeNextActionText(item.reasonText, 160)
        || actions.indexOf(item.action) < 0
        || item.targetIntentId !== null && !isSafeIdentifier(item.targetIntentId)
        || item.workflowTemplateId !== null && !isSafeIdentifier(item.workflowTemplateId)
        || !safeIdentifierArray(item.requiredSkillIds, 16)
        || !safeIdentifierArray(item.requiredCapabilityIds, 32)
        || !safeCatalogAction(item.catalogAction)
        || ['home', 'agent', 'channel'].indexOf(item.surface) < 0
        || item.channel !== null && !isSafeIdentifier(item.channel)
        || (item.surface === 'channel') !== Boolean(item.channel)
        || statuses.indexOf(item.status) < 0
        || !Number.isSafeInteger(item.score) || item.score < 0
        || !Number.isInteger(item.rank) || item.rank < 1 || item.rank > 3
        || !isTimestamp(item.generatedAt) || !isTimestamp(item.expiresAt)
        || !nullableTimestamp(item.shownAt) || !nullableTimestamp(item.acceptedAt)
        || !nullableTimestamp(item.completedAt) || !safeNextActionOutcome(item.outcome)) {
        throw invalidResponse();
      }
      return item;
    }

    function safeNextActionText(value, maximum) {
      return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[<>]/.test(value);
    }

    function safeIdentifierArray(value, maximum) {
      return Array.isArray(value) && value.length <= maximum && value.every(isSafeIdentifier);
    }

    function safeCatalogAction(value) {
      return value === null || hasExactKeys(value, ['channel', 'item', 'action'])
        && isSafeIdentifier(value.channel) && isSafeIdentifier(value.item) && isSafeIdentifier(value.action);
    }

    function nullableTimestamp(value) { return value === null || isTimestamp(value); }

    function safeNextActionOutcome(value) {
      if (value === null) return true;
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      try {
        var encoded = JSON.stringify(value);
        return encoded.length <= 4096 && !/[<>]/.test(encoded);
      } catch (_) { return false; }
    }

    function projectNextActionDecision(value) {
      if (!hasExactKeys(value, [
        'decisionId', 'recommendationId', 'decision', 'status',
        'snoozeUntil', 'feedbackCode', 'createdAt',
      ]) || !isSafeIdentifier(value.decisionId) || !isSafeIdentifier(value.recommendationId)
        || ['accept', 'dismiss', 'snooze', 'disable_personalization'].indexOf(value.decision) < 0
        || ['accepted', 'dismissed', 'snoozed', 'disabled'].indexOf(value.status) < 0
        || !nullableTimestamp(value.snoozeUntil)
        || value.feedbackCode !== null && !isSafeIdentifier(value.feedbackCode)
        || !isTimestamp(value.createdAt)) throw invalidResponse();
      return cloneAndFreeze(value);
    }

    function buildNextActionQuery(input) {
      var query = input || {};
      if (!hasExactKeys(query, Object.keys(query))
        || Object.keys(query).some(function (key) { return ['surface', 'channel', 'limit'].indexOf(key) < 0; })) {
        throw localError(422, 'validation_error', 'Next Action query is invalid', 'known-failure');
      }
      var surface = query.surface || 'home';
      var channel = query.channel || null;
      var limit = query.limit == null ? 3 : query.limit;
      if (['home', 'agent', 'channel'].indexOf(surface) < 0
        || (surface === 'channel') !== Boolean(channel)
        || channel !== null && !isSafeIdentifier(channel)
        || !Number.isInteger(limit) || limit < 1 || limit > 3) {
        throw localError(422, 'validation_error', 'Next Action query is invalid', 'known-failure');
      }
      var params = new URLSearchParams();
      params.set('surface', surface);
      if (channel) params.set('channel', channel);
      params.set('limit', String(limit));
      return '?' + params.toString();
    }

    function validateNextActionDecisionInput(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some(function (key) {
          return ['decision', 'snoozeUntil', 'feedbackCode'].indexOf(key) < 0;
        }) || ['accept', 'dismiss', 'snooze', 'disable_personalization'].indexOf(value.decision) < 0
        || value.snoozeUntil !== undefined && !isTimestamp(value.snoozeUntil)
        || value.feedbackCode !== undefined && !isSafeIdentifier(value.feedbackCode)) {
        throw localError(422, 'validation_error', 'Next Action decision is invalid', 'known-failure');
      }
      return value;
    }

    function buildWorkbenchQuery(input, allowed) {
      var value = input || {};
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some(function (key) { return allowed.indexOf(key) < 0; })) {
        throw localError(422, 'validation_error', '工作台查询参数无效', 'known-failure');
      }
      var query = new URLSearchParams();
      allowed.forEach(function (key) {
        if (value[key] !== null && value[key] !== undefined && value[key] !== '') {
          query.set(key, String(value[key]));
        }
      });
      return query.toString() ? '?' + query.toString() : '';
    }

    function buildMemoryWorkbenchQuery(input) {
      var value = input || {};
      var allowed = [
        'query', 'customerRef', 'recordKinds', 'statuses', 'sources', 'purposes',
        'validFrom', 'validTo', 'cursor', 'limit',
      ];
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some(function (key) { return allowed.indexOf(key) < 0; })) {
        throw localError(422, 'validation_error', '记忆专区查询参数无效', 'known-failure');
      }
      var normalized = {};
      Object.keys(value).forEach(function (key) {
        var item = value[key];
        if (Array.isArray(item)) {
          if (item.length > 12 || new Set(item).size !== item.length
            || item.some(function (entry) { return typeof entry !== 'string' || !entry; })) {
            throw localError(422, 'validation_error', '记忆专区查询参数无效', 'known-failure');
          }
          normalized[key] = item.join(',');
        } else {
          normalized[key] = item;
        }
      });
      return buildWorkbenchQuery(normalized, allowed);
    }

    async function waitForTransferCompletion(transferOrderId, waitOptions) {
      var settings = waitOptions || {};
      var intervalMs = Math.max(0, Number(settings.intervalMs == null ? 250 : settings.intervalMs));
      var timeoutMs = Math.max(1, Number(settings.timeoutMs == null ? 10000 : settings.timeoutMs));
      var maxAttempts = Math.max(1, Number(settings.maxAttempts == null ? 40 : settings.maxAttempts));
      var startedAt = Date.now();
      var latest = null;
      for (var attempt = 0; attempt < maxAttempts; attempt += 1) {
        latest = await request('/transfer-orders/' + encodeURIComponent(transferOrderId));
        if (latest.status === 'SUCCEEDED') {
          if (!latest.executionId) throw localError(502, 'invalid_transfer_status', '交易已完成但执行编号缺失，请稍后查询', 'unknown');
          return latest;
        }
        if (latest.status === 'FAILED' || latest.status === 'CANCELLED') {
          throw localError(409, 'transfer_not_completed', '交易未完成，请查看订单状态', 'known-failure');
        }
        if (Date.now() - startedAt >= timeoutMs || attempt === maxAttempts - 1) break;
        await wait(intervalMs);
      }
      throw localError(504, 'transfer_outcome_unknown', '授权已提交，交易结果待查询，请勿重复转账', 'unknown');
    }

    async function streamAgentRun(input, streamHandlers) {
      if (!trace || typeof trace.createSseParserState !== 'function' || typeof trace.parseSseChunk !== 'function') {
        throw localError(500, 'trace_adapter_missing', '运行轨迹组件尚未加载', 'known-failure');
      }
      var handlers = streamHandlers || {};
      var onEvent = typeof handlers.onEvent === 'function' ? handlers.onEvent : function () {};
      var onResult = typeof handlers.onResult === 'function' ? handlers.onResult : function () {};
      var onSession = typeof handlers.onSession === 'function' ? handlers.onSession : function () {};
      var timeoutMs = handlers.timeoutMs != null ? handlers.timeoutMs : 120000;
      var controller = null;
      var timeout = null;
      var timedOut = false;
      var externalSignal = handlers.signal || null;
      var abortFromCaller = null;
      if (typeof AbortController === 'function') {
        controller = new AbortController();
        timeout = setTimeout(function () {
          timedOut = true;
          controller.abort();
        }, timeoutMs);
      }
      if (externalSignal) {
        if (!controller && typeof AbortController === 'function') {
          controller = new AbortController();
        }
        if (controller) {
          abortFromCaller = function () { controller.abort(); };
          if (externalSignal.aborted) controller.abort();
          else externalSignal.addEventListener('abort', abortFromCaller, { once: true });
        }
      }
      var fetchSignal = controller ? controller.signal : (externalSignal || undefined);
      var response;
      try {
        response = await fetchImpl(baseUrl + '/agent-runs', {
          method: 'POST',
          headers: {
            'Accept': 'text/event-stream',
            'Content-Type': 'application/json',
            'X-Mock-Customer-Id': customerId,
            'X-Actor-Type': 'agent',
            'X-Request-Id': 'phone-' + idFactory(),
            'X-Trace-Id': 'phone-trace-' + idFactory(),
          },
          body: JSON.stringify(input || {}),
          signal: fetchSignal,
        });
      } catch (error) {
        if (timeout != null) clearTimeout(timeout);
        if (externalSignal && abortFromCaller) externalSignal.removeEventListener('abort', abortFromCaller);
        if (timedOut || (error && error.name === 'AbortError')) {
          throw localError(504, 'request_timeout', '智能服务响应超时，请稍后重试', 'unknown');
        }
        throw error;
      }
      if (!response.ok) {
        var payload;
        try { payload = await response.json(); }
        catch (_) { payload = { error: { code: 'invalid_response', message: '智能服务返回了无法解析的响应' }, meta: {} }; }
        throw new BankClientError(response.status, payload);
      }
      var effectiveSessionId = response.headers && response.headers.get
        ? response.headers.get('x-agent-session-id') : null;
      if (effectiveSessionId != null) {
        if (!isSafeAgentSessionIdentifier(effectiveSessionId)) {
          throw localError(502, 'invalid_response', '智能服务返回的会话标识无效', 'known-failure');
        }
        onSession(effectiveSessionId);
      }
      var contentType = response.headers && response.headers.get
        ? String(response.headers.get('content-type') || '').toLowerCase()
        : '';
      if (contentType.indexOf('text/event-stream') !== 0 || !response.body || typeof response.body.getReader !== 'function') {
        throw localError(502, 'invalid_response', '智能服务没有返回有效事件流', 'known-failure');
      }
      var reader = response.body.getReader();
      var decoder = new TextDecoder('utf-8', { fatal: true });
      var parser = trace.createSseParserState();
      var lastEvent = null;
      try {
        while (true) {
          var item = await reader.read();
          if (item.done) break;
          var events = trace.parseSseChunk(parser, decoder.decode(item.value, { stream: true }), false);
          events.forEach(function (event) {
            if (event && event.eventType === 'agent.result') onResult(event);
            else { lastEvent = event; onEvent(event); }
          });
        }
        var finalEvents = trace.parseSseChunk(parser, decoder.decode(), true);
        finalEvents.forEach(function (event) {
          if (event && event.eventType === 'agent.result') onResult(event);
          else { lastEvent = event; onEvent(event); }
        });
      } catch (error) {
        if (error && error.name === 'AbortError') {
          if (timedOut) throw localError(504, 'request_timeout', '智能服务响应超时，请稍后重试', 'unknown');
          throw error;
        }
        console.error('[ai-native-bank-api] SSE stream parsing failed:', error && error.message ? error.message : error, 'buffer tail:', parser.buffer ? parser.buffer.slice(-200) : '(no parser)');
        throw localError(502, 'invalid_response', '智能服务事件流无法识别', 'known-failure');
      } finally {
        if (timeout != null) clearTimeout(timeout);
        if (externalSignal && abortFromCaller) externalSignal.removeEventListener('abort', abortFromCaller);
        if (reader && typeof reader.releaseLock === 'function') reader.releaseLock();
      }
      return lastEvent;
    }

    function startAgentRecommendation(conversationId, recommendationId, serviceActionId, streamHandlers) {
      if (serviceActionId && typeof serviceActionId === 'object') {
        streamHandlers = serviceActionId;
        serviceActionId = null;
      }
      if (!isSafeIdentifier(conversationId) || !isSafeIdentifier(recommendationId)) {
        return Promise.reject(localError(422, 'validation_error', '推荐办理入口无效', 'known-failure'));
      }
      if (serviceActionId != null && !isSafeIdentifier(serviceActionId)) {
        return Promise.reject(localError(422, 'validation_error', '服务办理入口无效', 'known-failure'));
      }
      var payload = {
        conversationId: conversationId,
        recommendationId: recommendationId,
      };
      if (serviceActionId) payload.serviceActionId = serviceActionId;
      return streamAgentRun(payload, streamHandlers);
    }

    return {
      getAgentRuntimeStatus: function () { return request('/agent-runtime/status'); },
      getServiceProgressProfiles: async function () {
        return projectServiceProgressProfiles(await request('/agent-runtime/service-progress-profiles'));
      },
      getWorkbenchOverview: async function () {
        return projectWorkbenchOverview(await request('/workbench/overview'));
      },
      listWorkbenchScenarios: async function () {
        return projectWorkbenchScenarios(await request('/workbench/scenarios'));
      },
      listWorkbenchExperienceScenarios: async function () {
        return projectWorkbenchExperienceScenarios(await request('/workbench/experience-scenarios'));
      },
      listWorkbenchAssets: async function (filters) {
        var query = buildWorkbenchQuery(filters, ['type', 'domain', 'integrationStatus']);
        return projectWorkbenchAssets(await request('/workbench/assets' + query));
      },
      listDataAssets: async function () {
        return projectDataAssets(await request('/workbench/data-assets'));
      },
      getDataAssetDetail: async function (categoryId) {
        if (!isSafeIdentifier(categoryId)) {
          throw localError(422, 'validation_error', '数据资产类别无效', 'known-failure');
        }
        return projectDataAssetDetail(await request(
          '/workbench/data-assets/' + encodeURIComponent(categoryId)
        ));
      },
      getMemoryWorkbenchOverview: async function (filters) {
        return projectMemoryWorkbenchOverview(await request(
          '/workbench/memories/overview' + buildMemoryWorkbenchQuery(filters),
        ));
      },
      listMemoryWorkbenchMemories: async function (filters, requestOptions) {
        return projectMemoryWorkbenchPage(await request(
          '/workbench/memories' + buildMemoryWorkbenchQuery(filters),
          { signal: requestOptions && requestOptions.signal },
        ));
      },
      getMemoryWorkbenchDetail: async function (id) {
        if (!isMemoryRef(id, 'view')) {
          throw localError(422, 'validation_error', '记忆详情引用无效', 'known-failure');
        }
        return projectMemoryWorkbenchDetail(await request(
          '/workbench/memories/' + encodeURIComponent(id),
        ));
      },
      listAgentRuns: async function (filters) {
        var query = buildWorkbenchQuery(filters, ['status', 'limit', 'cursor']);
        return projectAgentRunPage(await request('/agent-runs' + query));
      },
      getAgentRunDetail: async function (id) {
        return projectAgentRunDetail(await request('/agent-runs/' + encodeURIComponent(id)));
      },
      getNextActions: async function (query) {
        return projectNextActionPage(await request('/next-actions' + buildNextActionQuery(query)));
      },
      getAssistantTips: async function () {
        var payload = await request('/assistant-tips');
        var tips = payload && Array.isArray(payload.tips) ? payload.tips : [];
        return tips
          .filter(function (tip) { return tip && typeof tip.text === 'string' && tip.text; })
          .map(function (tip) { return { kind: tip.kind || 'recommendation', scenarioId: tip.scenarioId || null, text: tip.text }; });
      },
      decideNextAction: async function (id, body, key) {
        if (!isSafeIdentifier(id)) {
          throw localError(422, 'validation_error', 'Recommendation ID is invalid', 'known-failure');
        }
        return projectNextActionDecision(await command(
          'POST', '/next-actions/' + encodeURIComponent(id) + '/decisions',
          validateNextActionDecisionInput(body), 'user', key,
        ));
      },
      createAgentSession: async function () {
        return projectSession(await command('POST', '/agent-sessions', {}, 'user', null, null, sessionTimeoutMs), 'create');
      },
      bootstrapAgentSession: async function (id) {
        var body = {};
        if (id != null) {
          if (!isSafeIdentifier(id)) {
            throw localError(422, 'validation_error', 'Session ID is invalid', 'known-failure');
          }
          body.sessionId = id;
        }
        return projectSession(await command(
          'POST', '/agent-sessions/bootstrap', body, 'user', null, null, sessionTimeoutMs,
        ), 'get');
      },
      createRecommendationSession: async function (recommendationId, mode, key) {
        return projectSession(await command(
          'POST', '/agent-sessions/recommendation',
          { recommendationId: recommendationId, mode: mode },
          'user', key, null, sessionTimeoutMs,
        ), 'get');
      },
      getAgentSession: async function (id) {
        return projectSession(await request('/agent-sessions/' + encodeURIComponent(id), { timeoutMs: sessionTimeoutMs }), 'get');
      },
      listSmartCompanions: async function () {
        return projectSmartCompanions(await request(
          '/assistant-companions', { timeoutMs: sessionTimeoutMs }));
      },
      closeAgentSession: async function (id, reason, key) {
        return projectSession(await command('POST', '/agent-sessions/' + encodeURIComponent(id) + '/close',
          { reason: reason }, 'user', key, null, sessionTimeoutMs), 'close');
      },
      listResumableWorkflows: async function (id) {
        return projectWorkflowSummaries(await request(
          '/agent-sessions/' + encodeURIComponent(id) + '/resumable-workflows', { timeoutMs: sessionTimeoutMs }));
      },
      bindWorkflow: async function (id, input, key) {
        return projectWorkflowBinding(await command(
          'POST', '/agent-sessions/' + encodeURIComponent(id) + '/workflow-bindings',
          input, 'user', key, null, sessionTimeoutMs));
      },
      createAgentRun: function (input) {
        return request('/agent-runs', {
          method: 'POST', body: input || {},
          headers: { 'X-Actor-Type': 'agent' },
        });
      },
      streamAgentRun: streamAgentRun,
      startAgentRecommendation: startAgentRecommendation,
      confirmAgentAction: function (agentRunId, checkpointId, confirmationToken, key, traceId) {
        return command('POST', '/agent-runs/' + encodeURIComponent(agentRunId) + '/confirmations', {
          checkpointId: checkpointId, confirmationToken: confirmationToken,
        }, 'user', key, traceId);
      },
      confirmAgentActions: function (agentRunId, confirmations, key, traceId) {
        return command('POST', '/agent-runs/' + encodeURIComponent(agentRunId) + '/confirmations', {
          confirmations: confirmations,
        }, 'user', key, traceId);
      },
      submitAgentClarification: function (agentRunId, input, key, traceId) {
        return command('POST', '/agent-runs/' + encodeURIComponent(agentRunId) + '/clarifications',
          input, 'user', key, traceId, 90000);
      },
      submitBusinessReply: function (agentRunId, message, key, traceId) {
        return command('POST', '/agent-runs/' + encodeURIComponent(agentRunId) + '/business-replies',
          { message: message }, 'user', key, traceId);
      },
      getCustomer: function () { return request('/customers/me'); },
      listCapabilities: function (audience) { return request('/capabilities?audience=' + encodeURIComponent(audience || 'model')); },
      listAccounts: function () { return request('/accounts'); },
      getBalance: function (accountId) { return request('/accounts/' + encodeURIComponent(accountId) + '/balance'); },
      listTransactions: function (accountId, paging) {
        var query = new URLSearchParams();
        var options = paging || {};
        if (options.limit != null) query.set('limit', options.limit);
        if (options.cursor) query.set('cursor', options.cursor);
        return request('/accounts/' + encodeURIComponent(accountId) + '/transactions' + (query.toString() ? '?' + query.toString() : ''));
      },
      listPayees: function () { return request('/payees'); },
      /* ---- 财富域 ---- */
      listFinancialProducts: function (category) {
        return request('/financial-products' + (category ? '?category=' + encodeURIComponent(category) : ''));
      },
      getFinancialProduct: function (productId) {
        return request('/financial-products/' + encodeURIComponent(productId));
      },
      listWealthHoldings: function () { return request('/wealth/holdings'); },
      listWealthTransactions: function () { return request('/wealth/transactions'); },
      getSalaryInsights: function () { return request('/wealth/salary-insights'); },
      getWealthRecommendations: function () { return request('/wealth/recommendations'); },
      purchaseWealthProduct: function (input, key, traceId) {
        return mutate('/wealth/purchases', input, 'user', key, traceId);
      },
      redeemWealthHolding: function (input, key, traceId) {
        return mutate('/wealth/redemptions', input, 'user', key, traceId);
      },
      /* ---- 贷款域 ---- */
      listLoans: function () { return request('/loans'); },
      getLoan: function (loanId) { return request('/loans/' + encodeURIComponent(loanId)); },
      listLoanRepayments: function (loanId) { return request('/loans/' + encodeURIComponent(loanId) + '/repayments'); },
      precalculateLoan: function (input, key, traceId) {
        return mutate('/loans/precalculations', input || {}, 'user', key, traceId);
      },
      listCreditCards: function () { return request('/credit-cards'); },
      getCreditCard: function (cardId) { return request('/credit-cards/' + encodeURIComponent(cardId)); },
      listCreditCardTransactions: function (cardId, paging) {
        var query = new URLSearchParams();
        var options = paging || {};
        if (options.limit != null) query.set('limit', options.limit);
        if (options.cursor) query.set('cursor', options.cursor);
        return request('/credit-cards/' + encodeURIComponent(cardId) + '/transactions' + (query.toString() ? '?' + query.toString() : ''));
      },
      getCreditCardSettings: function (cardId) { return request('/credit-cards/' + encodeURIComponent(cardId) + '/settings'); },
      getCreditCardBill: function (cardId) { return request('/credit-cards/' + encodeURIComponent(cardId) + '/bill'); },
      repayCreditCard: function (cardId, input, key, traceId) {
        return command('POST', '/credit-cards/' + encodeURIComponent(cardId) + '/repayments', input, 'user', key, traceId);
      },
      activateCreditCard: function (cardId, key, traceId) {
        return command('POST', '/credit-cards/' + encodeURIComponent(cardId) + '/activations', {}, 'user', key, traceId);
      },
      reportCreditCardLoss: function (cardId, input, key, traceId) {
        return command('POST', '/credit-cards/' + encodeURIComponent(cardId) + '/loss-reports', input, 'user', key, traceId);
      },
      requestCreditCardLimitChange: function (cardId, input, key, traceId) {
        return command('POST', '/credit-cards/' + encodeURIComponent(cardId) + '/limit-change-requests', input, 'user', key, traceId);
      },
      updateCreditCardSecuritySettings: function (cardId, input, key, traceId) {
        return command('PUT', '/credit-cards/' + encodeURIComponent(cardId) + '/security-settings', input, 'user', key, traceId);
      },
      validatePayee: function (payeeId, key, traceId) { return mutate('/payee-validations', { payeeId: payeeId }, 'agent', key, traceId); },
      createTransferOrder: function (input, key, traceId) { return mutate('/transfer-orders', input, 'agent', key, traceId); },
      validateTransferOrder: function (transferOrderId, key, traceId) { return mutate('/transfer-orders/' + encodeURIComponent(transferOrderId) + '/validations', {}, 'agent', key, traceId); },
      requestConfirmation: function (transferOrderId, key, traceId) { return mutate('/transfer-orders/' + encodeURIComponent(transferOrderId) + '/confirmation-challenges', {}, 'agent', key, traceId); },
      authorizeTransfer: function (transferOrderId, challengeId, confirmationToken, key, traceId) {
        return mutate('/transfer-orders/' + encodeURIComponent(transferOrderId) + '/authorizations', {
          challengeId: challengeId, confirmationToken: confirmationToken,
        }, 'user', key, traceId);
      },
      waitForTransferCompletion: waitForTransferCompletion,
      getTransferOrder: function (transferOrderId) { return request('/transfer-orders/' + encodeURIComponent(transferOrderId)); },
      getReceipt: function (executionId) { return request('/transfer-executions/' + encodeURIComponent(executionId)); },
      resetScenario: function (scenarioId, key, traceId) { return mutate('/__mock/reset', { scenarioId: scenarioId || 'default' }, 'agent', key, traceId); },
      getDailyRecommendations: function () { return request('/recommendations'); },
    };
  }

  return { createClient: createClient, BankClientError: BankClientError };
});
