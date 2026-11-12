/**
 * 意图图谱确定性后处理纯函数 — 共享模块（UMD）
 *
 * 单一来源：从 scripts/build-intent-graph-v2.js 原样抽取（函数体逐字一致，2026-08-24）。
 * 用途：意图自动构建管线（routes/intent-graph-autobuild.js）对 LLM 输出做确定性兜底；
 *      build 脚本亦经 require 复用（容器内 scripts/ 非 bind mount，共享模块须放在 tools/）。
 * 注意：仅在 Node 环境使用（hash 依赖 crypto），不要引入浏览器页面。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IntentGraphPostprocess = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var crypto = require('crypto');

  function hash(input, len) {
    if (len === undefined) len = 12;
    return crypto.createHash('sha1').update(String(input)).digest('hex').slice(0, len);
  }

  function compactId(prefix, value) {
    return prefix + '_' + hash(value);
  }

  function arr(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value.filter(v => v !== undefined && v !== null && String(v).trim() !== '');
    return [value].filter(v => String(v).trim() !== '');
  }

  function uniq(values) {
    return Array.from(new Set(arr(values).map(v => String(v).trim()).filter(Boolean)));
  }

  function firstNonEmpty(...values) {
    for (const v of values) {
      if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
    }
    return '';
  }

  function cleanText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function pathParts(value) {
    return String(value || '')
      .replace(/^菜单功能树\s*>\s*/, '')
      .replace(/^首页\s*>\s*/, '')
      .split(/[>\/]/)
      .map(s => s.trim())
      .filter(Boolean);
  }

  function normalizeIntentType(scene, actionCode) {
    const t = String(scene.intent_type || '').toUpperCase();
    if (t) return t;
    if (actionCode === 'ask' || actionCode === 'guide') return 'ASK';
    if (actionCode === 'query') return 'QUERY';
    return 'DO';
  }

  function isKnowledgeIntent(intentType, scene) {
    return ['ASK', 'HELP', 'GUIDE', 'FAQ'].includes(intentType) || (scene.can_answer_directly && !scene.can_execute_directly);
  }

  function isExecutableIntent(intentType, scene, actionCode) {
    if (isKnowledgeIntent(intentType, scene)) return false;
    if (scene.can_execute_directly) return true;
    return !['ask', 'guide', 'complain'].includes(actionCode);
  }

  function inferRisk(objectName, actionCode, intentName, scene) {
    const text = [objectName, actionCode, intentName, scene.scene_description, scene.user_goal].join(' ');
    const risks = [];
    if (/转账|付款|支付|缴费|还款|充值|汇款|收款/.test(text)) {
      risks.push({ risk_id: 'risk_transaction', risk_name: '交易类操作', risk_level: 'L2', policy: '需要交易确认，必要时进入二次校验。' });
    }
    if (/挂失|冻结|解冻|注销|关闭|解约|删除|解绑|密码|限额|停用/.test(text)) {
      risks.push({ risk_id: 'risk_sensitive_account', risk_name: '账户敏感操作', risk_level: 'L3', policy: '需要强校验，禁止仅凭语义高分直接执行。' });
    }
    if (/贷款|借款|授信|额度|信用卡申请|开户|开通|签约|购买|申购/.test(text)) {
      risks.push({ risk_id: 'risk_contract_or_credit', risk_name: '合约/授信类操作', risk_level: 'L2', policy: '需要资格、协议或风险揭示校验。' });
    }
    return risks;
  }

  function buildSlot(slot, required) {
    const name = typeof slot === 'string' ? slot : firstNonEmpty(slot.name, slot.slot_name, slot.id);
    return {
      slot_id: compactId('slot', name),
      slot_name: name,
      required,
      data_type: typeof slot === 'object' && slot.data_type ? slot.data_type : 'string',
      clarify_question: typeof slot === 'object' ? firstNonEmpty(slot.clarify_question, slot.question) : ''
    };
  }

  function inferSlots(actionCode, objectName, intentName) {
    const text = `${actionCode} ${objectName} ${intentName}`;
    if (/transfer|转账|汇款/.test(text)) {
      return [
        { slot_name: '收款人', data_type: 'party', clarify_question: '请提供收款人信息。' },
        { slot_name: '收款账户', data_type: 'account_no', clarify_question: '请提供收款账户。' },
        { slot_name: '转账金额', data_type: 'money', clarify_question: '请确认转账金额。' }
      ];
    }
    if (/repay|还款/.test(text)) {
      return [
        { slot_name: '还款金额', data_type: 'money', clarify_question: '请确认还款金额。' },
        { slot_name: '扣款账户', data_type: 'account', clarify_question: '请选择扣款账户。' }
      ];
    }
    if (/query|查询|查看|明细|流水|账单/.test(text)) {
      return [
        { slot_name: '查询时间范围', data_type: 'date_range', clarify_question: '请确认查询的时间范围。', required: false }
      ];
    }
    if (/apply|open|申请|办理|开通|开户/.test(text)) {
      return [
        { slot_name: '办理对象', data_type: 'business_object', clarify_question: '请确认要办理的具体对象。', required: false }
      ];
    }
    if (/change|修改|调整|变更/.test(text)) {
      return [
        { slot_name: '修改项', data_type: 'string', clarify_question: '请说明要修改哪一项。' }
      ];
    }
    if (/cancel|close|注销|取消|关闭|解约/.test(text)) {
      return [
        { slot_name: '确认对象', data_type: 'business_object', clarify_question: '请确认要取消或关闭的对象。' }
      ];
    }
    return [];
  }

  function buildRetrievalProfile({ node, action, scene, intentName, objectName, taskName, knowledgeName }) {
    const sem = node.node_semantics || {};
    const nav = node.navigation || {};
    const identity = node.node_identity || {};
    const pathText = firstNonEmpty(identity.business_category_path, nav.standard_navigation_path);
    const actionCode = String(action.action_code || '').toLowerCase();

    // 通用负例库：基于 action_code 的跨动作互斥（V4GraphAdapter 每条 -120 排除误召回）
    // 当场景自身未提供 negative_examples/boundary_exclusions/disambiguation_hints 时兜底
    var NEGATIVE_BANK = {
      query: ['转账', '付款', '充值', '还款', '挂失'],
      ask:   ['转账', '付款', '充值', '还款', '挂失'],
      transfer: ['查询余额', '查明细', '查流水', '查账单'],
      pay:   ['查询余额', '查明细', '查流水', '查账单'],
      repay: ['查询余额', '查明细', '查流水'],
      apply: ['查询进度', '查状态', '查详情'],
      open:  ['查询进度', '查状态', '查详情'],
      change: ['查询信息', '查详情', '看明细'],
      modify: ['查询信息', '查详情', '看明细'],
      cancel: ['查询信息', '查详情', '看明细'],
      close:  ['查询信息', '查详情', '看明细'],
      guide:  ['转账', '付款', '查询余额'],
      complain: ['转账', '查询余额', '查明细'],
    };

    // 负例不足 2 条时从通用负例库补齐（排除与本场景 aliases 重叠的项）
    var rawNegatives = uniq([
      ...(scene.negative_examples || []),
      ...(sem.boundary_exclusions || []),
      ...(scene.disambiguation_hints || [])
    ]).filter(Boolean);
    var aliasesForNegCheck = uniq([
      intentName, scene.scene_name, identity.node_name, objectName, action.action_name,
      ...(action.action_aliases || [])
    ]).filter(Boolean);
    if (rawNegatives.length < 2) {
      var bank = NEGATIVE_BANK[actionCode] || ['转账', '查询余额', '付款'];
      for (var i = 0; i < bank.length && rawNegatives.length < 2; i++) {
        if (aliasesForNegCheck.indexOf(bank[i]) < 0 && rawNegatives.indexOf(bank[i]) < 0) {
          rawNegatives.push(bank[i]);
        }
      }
    }

    // recallTermSets：把 trigger_keywords/similar_questions 分成 2 组词群（每组 +75）
    var triggers = arr(scene.trigger_keywords);
    var utterSrc = arr(scene.similar_questions).slice(0, 20);
    var recallTermSets = [];
    if (triggers.length >= 4) {
      var mid = Math.ceil(triggers.length / 2);
      recallTermSets.push(triggers.slice(0, mid));
      recallTermSets.push(triggers.slice(mid));
    } else if (utterSrc.length >= 4) {
      var mid2 = Math.ceil(utterSrc.length / 2);
      recallTermSets.push(utterSrc.slice(0, mid2));
      recallTermSets.push(utterSrc.slice(mid2));
    }

    // semanticPriority：按 action_code 分级（交易/敏感 > 操作 > 查询）
    var priorityMap = { cancel: 40, close: 40, transfer: 30, repay: 30, pay: 30, apply: 25, open: 25, change: 20, modify: 20, do: 20, query: 10, ask: 10, guide: 5, complain: 5 };
    var semanticPriority = priorityMap[actionCode] || 10;

    return {
      index_unit: 'intent_node',
      strategy: 'multi_view_retrieval_profile',
      utterance_view: uniq([
        scene.user_goal,
        scene.scene_name,
        ...(scene.standard_questions || []),
        ...(scene.similar_questions || []).slice(0, 80),
        ...(scene.scenario_prototypes || []),
        ...(scene.trigger_keywords || [])
      ]),
      semantic_view: uniq([
        intentName,
        scene.scene_description,
        sem.semantic_description,
        sem.node_description,
        sem.typical_user_goal,
        ...(sem.typical_user_goals || [])
      ]),
      object_view: uniq([
        objectName,
        sem.service_object,
        sem.result_object,
        identity.node_name,
        ...pathParts(pathText)
      ]),
      action_view: uniq([
        action.action_code,
        action.action_name,
        ...(action.action_aliases || []),
        ...(action.supported_intent_types || [])
      ]),
      structure_view: uniq([
        identity.domain,
        identity.business_category_path,
        nav.standard_navigation_path,
        ...(nav.source_navigation_paths || [])
      ]),
      boundary_view: uniq([
        ...(sem.boundary_exclusions || []),
        ...(scene.disambiguation_hints || []),
        ...(scene.negative_examples || [])
      ]),
      rule_view: uniq([
        ...(scene.required_slots || []).map(s => typeof s === 'string' ? s : s.slot_name || s.name),
        ...(scene.optional_slots || []).map(s => typeof s === 'string' ? s : s.slot_name || s.name),
        ...(scene.profile_constraints || []),
        sem.precondition_summary
      ]),
      legacy_scene_label_view: uniq([scene.scene_id, scene.scene_name, taskName, knowledgeName]),
      // V4 精度字段：V4GraphAdapter.recall() 打分依赖（aliases 精确+80/包含+55，recallTerms +65/条，
      // recallTermSets 每组+75，negativeExamples 每条-120，semanticPriority 越大越优先）
      aliases: uniq([
        intentName,
        scene.scene_name,
        identity.node_name,
        objectName,
        action.action_name,
        scene.user_goal,
        ...pathParts(pathText),
        ...(sem.typical_user_goals || []),
        ...(action.action_aliases || [])
      ]).filter(Boolean),
      recallTerms: uniq([
        ...(scene.trigger_keywords || []),
        scene.user_goal,
        ...(scene.standard_questions || []),
        ...(scene.similar_questions || []).slice(0, 20)
      ]).filter(Boolean),
      recallTermSets: recallTermSets,
      negativeExamples: rawNegatives,
      semanticPriority: semanticPriority,
      weights: {
        utterance_view: 0.28,
        semantic_view: 0.20,
        object_view: 0.18,
        action_view: 0.16,
        structure_view: 0.08,
        boundary_view: 0.06,
        rule_view: 0.04,
        legacy_scene_label_view: 0.03
      }
    };
  }

  return {
    hash: hash,
    compactId: compactId,
    arr: arr,
    uniq: uniq,
    firstNonEmpty: firstNonEmpty,
    cleanText: cleanText,
    pathParts: pathParts,
    normalizeIntentType: normalizeIntentType,
    isKnowledgeIntent: isKnowledgeIntent,
    isExecutableIntent: isExecutableIntent,
    inferRisk: inferRisk,
    buildSlot: buildSlot,
    inferSlots: inferSlots,
    buildRetrievalProfile: buildRetrievalProfile,
  };
});
