'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const model = require('../../tools/ai-native-bank-model');
const featureActions = require('../../tools/ai-native-bank-feature-actions');
const capabilityRegistry = require('./capability-registry');
const { loadBusinessResourceRegistry } = require('./business-resource-registry');
const {
  INTENT_PROFILES,
  INTENT_RECALL_HINTS,
  INTENT_RECALL_TERMS,
  INTENT_RECALL_TERM_SETS,
  INTENT_DISAMBIGUATION,
} = require('./intent-profiles');

const GRAPH_ID = 'ccb-mobile-bank-intents';
const GRAPH_VERSION = '2.1.0';
const ALIAS_PACK_PATH = path.join(__dirname, '..', '..', 'data', 'ai-native-bank', 'intent-graph', 'alias-packs.v2.1.json');
const MAX_ALIAS_PACK_ALIASES = 24;
const PUBLISHED_AT = '2026-09-17T00:00:00+08:00';
const EXECUTION_MODES = new Set([
  'read-execute', 'confirm-required', 'knowledge-only', 'multi_intent',
  'navigation-only', 'unavailable',
]);
const RUNTIME_ACTION = Object.freeze({
  QUERY: 'QUERY', CREATE: 'DO', UPDATE: 'CHANGE', APPLY: 'DO', EXPLAIN: 'HELP',
  ASK: 'ASK', CANCEL: 'CANCEL', TRANSFER: 'TRANSFER', REPAY: 'REPAY',
});
const DEFAULT_CONVERSATION_POLICIES = Object.freeze({
  'knowledge-only': Object.freeze({
    taskPolicy: Object.freeze({ supportedShapes: Object.freeze(['single_intent', 'multi_intent']), mode: 'parallel-safe', maxTasks: 8 }),
    contextPolicy: Object.freeze({ retainOnClarification: true, allowIntentSwitch: true, resumable: false }),
    responsePolicy: 'knowledge_answer',
  }),
  'read-execute': Object.freeze({
    taskPolicy: Object.freeze({ supportedShapes: Object.freeze(['single_intent', 'same_intent_multi_task', 'multi_intent']), mode: 'parallel-safe', maxTasks: 8 }),
    contextPolicy: Object.freeze({ retainOnClarification: true, allowIntentSwitch: true, resumable: true }),
    responsePolicy: 'query_result',
  }),
  'confirm-required': Object.freeze({
    taskPolicy: Object.freeze({ supportedShapes: Object.freeze(['single_intent', 'same_intent_multi_task']), mode: 'sequential', maxTasks: 8 }),
    contextPolicy: Object.freeze({ retainOnClarification: true, allowIntentSwitch: true, resumable: true }),
    responsePolicy: 'confirmation_then_receipt',
  }),
  'multi_intent': Object.freeze({
    taskPolicy: Object.freeze({ supportedShapes: Object.freeze(['single_intent', 'multi_intent', 'parallel']), mode: 'parallel-safe', maxTasks: 8 }),
    contextPolicy: Object.freeze({ retainOnClarification: true, allowIntentSwitch: true, resumable: true }),
    responsePolicy: 'multi_intent_result',
  }),
});
const SPECIAL_INTENT_IDS = Object.freeze({
  'home.account.overview': 'ccb.account.balance.query',
  'home.details.overview': 'ccb.account.transactions.query',
  'home.transfer.overview': 'ccb.transfer.payee.query',
  'home.transfer.apply': 'ccb.transfer.create',
  'credit.card-manage.overview': 'ccb.credit.card.query',
  'credit.card-manage.transactions': 'ccb.credit.card.transactions.query',
  'credit.card-manage.activation': 'ccb.credit.card.activation',
  'credit.card-manage.loss-report': 'ccb.credit.card.loss-report',
  'credit.card-manage.limit': 'ccb.credit.card.limit-change',
  'credit.card-manage.security': 'ccb.credit.card.security-settings.update',
  'credit.card-manage.faq': 'ccb.credit.card.faq',
});
const BUSINESS_OBJECT_OVERRIDES = Object.freeze({
  'home.account.overview': 'account_balance',
});
const POLICY_NODES = Object.freeze([
  {
    id: 'policy.actor-scope-enforcement', type: 'policy', title: '调用者权限交集',
    policyType: 'authorization', version: '1.0.0', owner: 'ai-native-bank-security',
  },
  {
    id: 'policy.explicit-user-confirmation', type: 'policy', title: '本人明确确认',
    policyType: 'confirmation', version: '1.0.0', owner: 'ai-native-bank-security',
  },
  {
    id: 'policy.system-only-isolation', type: 'policy', title: '系统能力隔离',
    policyType: 'execution-boundary', version: '1.0.0', owner: 'ai-native-bank-security',
  },
]);
const GUIDED_INTENTS = Object.freeze([
  { id: 'ccb.cashflow.salary-plan', title: '这个月工资怎么安排', domain: 'cashflow', action: 'QUERY', businessObject: 'cashflow_plan', executionMode: 'read-execute', riskLevel: 'L2', aliases: ['工资规划', '月度资金安排'], recallTerms: ['工资怎么安排', '工资规划'], menuId: 'account' },
  { id: 'ccb.cashflow.spending-explain', title: '为什么这个月钱花得这么快', domain: 'cashflow', action: 'QUERY', businessObject: 'spending_analysis', executionMode: 'read-execute', riskLevel: 'L1', aliases: ['支出分析', '分析支出', '消费分析', '钱花哪了', '支出情况', '我的支出', '分析我的支出情况', '收支概览', '本月收支', '收支情况', '支出归因', '消费归因'], recallTerms: ['支出分析', '支出情况', '消费分析', '钱花哪了', '钱花得快', '本月支出', '支出对比', '收支概览', '本月收支', '支出归因'], menuId: 'details' },
  { id: 'ccb.obligation.repay-all', title: '帮我把该还的钱都处理掉', domain: 'obligation', action: 'DO', businessObject: 'obligation_plan', executionMode: 'confirm-required', riskLevel: 'L2', aliases: ['统一还款', '全部待还'], recallTerms: ['该还的钱', '统一还款'], menuId: 'account' },
  { id: 'ccb.obligation.pay-selected', title: '办理已选择的待还账单', domain: 'obligation', action: 'DO', businessObject: 'obligation_plan', executionMode: 'confirm-required', riskLevel: 'L2', aliases: ['办理所选账单', '只处理这一笔'], recallTerms: ['所选账单', '这一笔还款'], menuId: 'account' },
  { id: 'ccb.wealth.advisor.recommend', title: '个性化理财建议', domain: 'wealth', action: 'QUERY', businessObject: 'wealth_advice', executionMode: 'read-execute', riskLevel: 'L1', aliases: ['给我推荐理财产品', '什么理财适合我', '财富配置建议'], recallTerms: ['理财推荐', '适合我的理财', '理财配置建议'], negativeExamples: ['有哪些在售理财产品', '看看理财产品列表', '购买龙钱宝'], menuId: 'fund' },
  { id: 'ccb.account.detail.query', title: '查询账户详情', domain: 'account', action: 'QUERY', businessObject: 'account', executionMode: 'read-execute', riskLevel: 'L1', aliases: ['账户详情', '查看账户信息'], recallTerms: ['账户详情', '账户信息'], menuId: 'account' },
  { id: 'ccb.customer.profile.query', title: '查询我的客户资料', domain: 'account', action: 'QUERY', businessObject: 'customer_profile', executionMode: 'read-execute', riskLevel: 'L1', aliases: ['我的客户资料', '客户资料查询', '我是几级客户'], recallTerms: ['客户等级', '客户资料', '我是几级客户', '预留手机号'], menuId: 'account' },
  { id: 'ccb.wealth.redeem', title: '赎回我的理财', domain: 'wealth', action: 'DO', businessObject: 'wealth_holding', executionMode: 'confirm-required', riskLevel: 'L2', aliases: ['理财赎回', '赎回龙钱宝', '把理财赎回来'], recallTerms: ['赎回', '理财赎回'], negativeExamples: ['在售理财产品有哪些', '理财产品详情', '购买理财'], menuId: 'fund' },
]);

function loadAliasPacks() {
  const packPath = process.env.AI_BANK_ALIAS_PACK_PATH || ALIAS_PACK_PATH;
  if (!fs.existsSync(packPath)) return null;
  const pack = JSON.parse(fs.readFileSync(packPath, 'utf8'));
  if (pack.graphId !== GRAPH_ID || !pack.packs || typeof pack.packs !== 'object') {
    throw new TypeError('alias pack identity is invalid');
  }
  return pack;
}

// 口语别名包由 scripts/generate-intent-alias-packs.js 用 LLM 按意图语义系统化
// 生成（含来源元数据）；构建期确定性合并进 aliases，禁止运行时注入或手写穷举。
function packAliasesFor(aliasPacks, intentId) {
  if (!aliasPacks) return [];
  const entry = aliasPacks.packs[intentId];
  if (!entry || !Array.isArray(entry.aliases)) return [];
  return entry.aliases
    .filter(item => typeof item === 'string' && item.trim())
    .slice(0, MAX_ALIAS_PACK_ALIASES);
}

function buildIntentGraph() {
  const nodes = [];
  const edges = [];
  const catalog = model.getChannelCatalog();
  const resources = loadBusinessResourceRegistry();
  const skillsById = new Map(resources.skills.map(item => [item.id, item]));
  const aliasPacks = loadAliasPacks();

  Object.keys(catalog).sort().forEach(channel => {
    const group = catalog[channel];
    const channelId = `ccb.channel.${channel}`;
    nodes.push({
      id: channelId,
      type: 'channel',
      title: group.title,
      domain: channel,
      menuKey: null,
      capabilityBindings: [],
      source: { bank: 'CCB', channel, menuId: null, actionId: null },
    });

    group.items.forEach(item => {
      const menuKey = `${channel}.${item.id}`;
      const menuId = `ccb.menu.${channel}.${item.id}`;
      nodes.push({
        id: menuId,
        type: 'menu',
        title: item.name,
        description: item.description,
        domain: channel,
        menuKey,
        capabilityBindings: [],
        source: { bank: 'CCB', channel, menuId: item.id, actionId: null },
      });
      edges.push(edge('contains', channelId, menuId));

      featureActions.listActions(channel, item).forEach(action => {
        const capability = action.capabilityId ? capabilityRegistry.get(action.capabilityId) : null;
        const intentId = SPECIAL_INTENT_IDS[`${channel}.${item.id}.${action.id}`]
          || `ccb.${channel}.${item.id}.${action.id}`;
        const profile = INTENT_PROFILES[intentId] || null;
        const executionModeValue = executionMode(action, capability);
        // 纯查询（read-execute）且无槽位需解析时，直接绑定 capability 走 MCP；
        // 有槽位（如余额查询需解析账户）或需确认的业务仍保留 skill 与 slot 契约。
        const hasDeclaredSlots = Boolean(profile && profile.slots && profile.slots.length > 0);
        const pureRead = executionModeValue === 'read-execute' && !hasDeclaredSlots;
        const declaredCapabilityBindings = profile
          ? [...profile.capabilities]
          : (action.capabilityId ? [action.capabilityId] : []);
        const skill = (!pureRead && profile) ? skillsById.get(profile.skillId) : null;
        const slotContract = pureRead
          ? directReadSlotContractFor(declaredCapabilityBindings)
          : (profile ? slotContractFor(profile, declaredCapabilityBindings) : null);
        const capabilityBindings = slotContract
          ? [...slotContract.capabilityBindings] : declaredCapabilityBindings;
        const conversationPolicies = profile || DEFAULT_CONVERSATION_POLICIES[executionModeValue];
        const intent = {
          id: intentId,
          type: 'intent',
          title: `${item.name}·${action.title}`,
          description: action.description,
          domain: channel,
          menuKey,
          actionId: action.id,
          action: RUNTIME_ACTION[action.action],
          sourceAction: action.action,
          businessObject: BUSINESS_OBJECT_OVERRIDES[`${channel}.${item.id}.${action.id}`]
            || normalizeIdentifier(action.businessObject),
          // 别名只收口语源（菜单口语 query、召回提示、LLM 别名包）。菜单名/动作名/
          // 描述属展示文案，会稀释语义向量并造成跨意图模板串扰，故不再进别名。
          aliases: uniqueText([
            item.query,
            ...(INTENT_RECALL_HINTS[intentId] || []),
            ...packAliasesFor(aliasPacks, intentId),
          ]),
          ...(INTENT_DISAMBIGUATION[intentId] ? {
            confusableIntents: [...INTENT_DISAMBIGUATION[intentId].confusableIntents],
            disambiguationHints: INTENT_DISAMBIGUATION[intentId].disambiguationHints,
          } : {}),
          recallTerms: uniqueText(INTENT_RECALL_TERMS[intentId] || []),
          recallTermSets: clone(INTENT_RECALL_TERM_SETS[intentId] || []),
          semanticPriority: profile ? profile.semanticPriority : 0,
          negativeExamples: manualNegativeExamples(intentId),
          requiredSlots: slotContract
            ? slotContract.slots
              .filter(slot => slot.required && !Object.prototype.hasOwnProperty.call(slot, 'defaultValue'))
              .map(slot => slot.name)
            : uniqueText(capabilityBindings.flatMap(id => {
                const bound = capabilityRegistry.get(id);
                return bound && bound.inputSchema && Array.isArray(bound.inputSchema.required)
                  ? bound.inputSchema.required
                  : [];
              })),
          ...(slotContract ? { slotContract } : {}),
          ...(skill ? {
            skillBinding: { skillId: skill.id, version: skill.version, digest: skill.digest },
            businessObjectId: profile.businessObjectId,
          } : {}),
          ...(profile && profile.orchestrationMode
            ? { orchestrationMode: profile.orchestrationMode }
            : {}),
          taskPolicy: clone(conversationPolicies.taskPolicy),
          contextPolicy: clone(conversationPolicies.contextPolicy),
          responsePolicy: conversationPolicies.responsePolicy,
          capabilityBindings,
          executionMode: executionModeValue,
          fulfillmentKind: fulfillmentKind(executionModeValue, action, skill),
          riskLevel: action.riskLevel,
          readiness: action.readiness === 'mock-only' ? 'ready' : action.readiness,
          owner: 'ai-native-bank',
          // mock-only surface is available in this Mock App for navigation and
          // knowledge answers; it maps to readiness=ready, lifecycle=active.
          // Only genuinely planned (future) work is kept out of runtime recall.
          lifecycle: action.readiness === 'planned' ? 'inactive' : 'active',
          semanticVersion: '1.0.0',
          effectiveAt: PUBLISHED_AT,
          source: { bank: 'CCB', channel, menuId: item.id, actionId: action.id },
        };
        nodes.push(intent);
        edges.push(edge('offers', menuId, intentId));
        if (profile) {
          // 业务对象关联与执行路径无关：纯查询意图同样 TARGETS 其业务对象。
          edges.push(edge('TARGETS', intentId, objectNodeId(profile.businessObjectId)));
        }
        if (profile && !pureRead) {
          edges.push(edge('HANDLED_BY', intentId, profile.skillId));
          profile.slots.forEach(definition => {
            edges.push(edge('REQUIRES_SLOT', intentId, definition.slotId));
            if (definition.resolverCapabilityId) {
              edges.push(edge('RESOLVED_BY', definition.slotId, definition.resolverCapabilityId));
            }
          });
        }
        if (profile || pureRead) {
          capabilityBindings.forEach(id => edges.push(edge('REQUIRES_CAPABILITY', intentId, id)));
          edges.push(edge('GUARDED_BY', intentId, 'policy.actor-scope-enforcement'));
          edges.push(edge('GUARDED_BY', intentId, 'policy.system-only-isolation'));
          if (executionModeValue === 'confirm-required') {
            edges.push(edge('GUARDED_BY', intentId, 'policy.explicit-user-confirmation'));
          }
        }
      });
    });
  });

  appendGuidedIntents(nodes, edges, skillsById, aliasPacks);

  applyDerivedNegativeExamples(nodes);

  appendResourceNodes(nodes, edges, resources);

  const graph = {
    schemaVersion: '2.0',
    graphId: GRAPH_ID,
    version: GRAPH_VERSION,
    bank: 'CCB',
    appSurface: 'mock-mobile-bank',
    publishedAt: PUBLISHED_AT,
    nodes: nodes.sort(compareById),
    edges: [...new Map(edges.map(item => [item.id, item])).values()].sort(compareById),
  };
  graph.digest = graphDigest(graph);
  validateIntentGraph(graph);
  return clone(graph);
}

function appendGuidedIntents(nodes, edges, skillsById, aliasPacks) {
  GUIDED_INTENTS.forEach(definition => {
    const profile = INTENT_PROFILES[definition.id];
    const skill = profile && skillsById.get(profile.skillId);
    if (!profile || !skill || skill.status !== 'active') throw new TypeError(`guided intent resource is unavailable: ${definition.id}`);
    const capabilityBindings = [...profile.capabilities];
    const slotContract = slotContractFor(profile, capabilityBindings);
    nodes.push({
      id: definition.id, type: 'intent', title: definition.title,
      description: definition.title, domain: definition.domain, menuKey: `home.${definition.menuId}`,
      actionId: 'guided', action: definition.action, sourceAction: definition.action === 'QUERY' ? 'QUERY' : 'CREATE',
      businessObject: definition.businessObject,
      aliases: uniqueText([definition.title, ...definition.aliases, ...packAliasesFor(aliasPacks, definition.id)]),
      ...(INTENT_DISAMBIGUATION[definition.id] ? {
        confusableIntents: [...INTENT_DISAMBIGUATION[definition.id].confusableIntents],
        disambiguationHints: INTENT_DISAMBIGUATION[definition.id].disambiguationHints,
      } : {}),
      recallTerms: [...definition.recallTerms],
      recallTermSets: clone(INTENT_RECALL_TERM_SETS[definition.id] || []),
      semanticPriority: profile.semanticPriority,
      negativeExamples: [...(definition.negativeExamples || [])],
      requiredSlots: slotContract.slots.filter(item => item.required && !Object.prototype.hasOwnProperty.call(item, 'defaultValue')).map(item => item.name),
      slotContract,
      skillBinding: { skillId: skill.id, version: skill.version, digest: skill.digest },
      businessObjectId: profile.businessObjectId, taskPolicy: clone(profile.taskPolicy),
      contextPolicy: clone(profile.contextPolicy), responsePolicy: profile.responsePolicy,
      ...(profile.orchestrationMode ? { orchestrationMode: profile.orchestrationMode } : {}),
      capabilityBindings, executionMode: definition.executionMode, riskLevel: definition.riskLevel,
      readiness: 'ready', owner: 'ai-native-bank', lifecycle: 'active', semanticVersion: '1.0.0', effectiveAt: PUBLISHED_AT,
      source: { bank: 'CCB', channel: 'home', menuId: definition.menuId, actionId: 'guided' },
    });
    const intentId = definition.id;
    edges.push(edge('offers', `ccb.menu.home.${definition.menuId}`, intentId));
    edges.push(edge('HANDLED_BY', intentId, profile.skillId));
    edges.push(edge('TARGETS', intentId, objectNodeId(profile.businessObjectId)));
    profile.slots.forEach(item => {
      edges.push(edge('REQUIRES_SLOT', intentId, item.slotId));
      if (item.resolverCapabilityId) edges.push(edge('RESOLVED_BY', item.slotId, item.resolverCapabilityId));
    });
    capabilityBindings.forEach(id => edges.push(edge('REQUIRES_CAPABILITY', intentId, id)));
    edges.push(edge('GUARDED_BY', intentId, 'policy.actor-scope-enforcement'));
    edges.push(edge('GUARDED_BY', intentId, 'policy.system-only-isolation'));
    if (definition.executionMode === 'confirm-required') edges.push(edge('GUARDED_BY', intentId, 'policy.explicit-user-confirmation'));
  });
}

function slotContractFor(profile, capabilityBindings) {
  const executionCapability = capabilityRegistry.get(profile.executionCapabilityId);
  return {
    version: '2.0',
    slots: profile.slots.map(item => clone(item)),
    clarificationOrder: [...profile.clarificationOrder],
    executionBinding: {
      capabilityId: profile.executionCapabilityId,
      requiresConfirmation: executionCapability
        ? executionCapability.confirmationPolicy === 'explicit-user-confirmation'
        : false,
    },
    capabilityBindings: [...capabilityBindings],
  };
}

function directReadSlotContractFor(capabilityBindings) {
  const executionCapabilityId = capabilityBindings[capabilityBindings.length - 1];
  const executionCapability = capabilityRegistry.get(executionCapabilityId);
  if (!executionCapability || executionCapability.sideEffect !== 'none') {
    throw new TypeError(`direct read capability is invalid: ${executionCapabilityId || '<missing>'}`);
  }
  const required = executionCapability.inputSchema
    && Array.isArray(executionCapability.inputSchema.required)
    ? executionCapability.inputSchema.required : [];
  const resolverCapabilities = [];
  const slots = required.map(name => {
    if (name === 'cardId') {
      resolverCapabilities.push('bank.credit-card.list');
      return {
        slotId: 'slot.card.reference',
        name: 'cardReference',
        label: '信用卡',
        type: 'card_reference',
        required: true,
        extractionKeys: ['cardName', 'cardReference', 'maskedCardNo'],
        resolverCapabilityId: 'bank.credit-card.list',
        resolvedField: 'cardId',
      };
    }
    return {
      slotId: `slot.direct.${normalizeIdentifier(name)}`,
      name,
      label: name,
      type: 'identifier',
      required: true,
      extractionKeys: [name],
      resolvedField: name,
    };
  });
  return {
    version: '2.0',
    slots,
    clarificationOrder: slots.map(item => item.name),
    executionBinding: { capabilityId: executionCapabilityId, requiresConfirmation: false },
    capabilityBindings: [...new Set([...resolverCapabilities, ...capabilityBindings])],
  };
}

function objectNodeId(businessObjectId) {
  return `object.${businessObjectId}`;
}

function appendResourceNodes(nodes, edges, resources) {
  const objectIds = new Set();
  const slotDefinitions = new Map();
  Object.values(INTENT_PROFILES).forEach(profile => {
    objectIds.add(profile.businessObjectId);
    profile.slots.forEach(item => slotDefinitions.set(item.slotId, item));
  });
  objectIds.forEach(id => nodes.push({
    id: objectNodeId(id), type: 'business-object', title: businessObjectTitle(id),
    businessObjectId: id, owner: 'ai-native-bank', lifecycle: 'active', semanticVersion: '1.0.0',
  }));
  slotDefinitions.forEach(item => nodes.push({
    id: item.slotId, type: 'slot', title: item.label, semanticType: item.type,
    extractionKeys: [...item.extractionKeys], owner: 'ai-native-bank',
    lifecycle: 'active', semanticVersion: '1.0.0',
  }));
  resources.skills.forEach(skill => {
    nodes.push({
      id: skill.id, type: 'skill', title: skill.id.replace(/^bank\./, ''),
      version: skill.version, digest: skill.digest, status: skill.status,
      entrypoint: skill.entrypoint, owner: skill.owner,
    });
    skill.requiredCapabilityIds.forEach(capabilityId => {
      edges.push(edge('USES_CAPABILITY', skill.id, capabilityId));
    });
  });
  resources.providers.forEach(provider => {
    const capability = capabilityRegistry.get(provider.capabilityId);
    if (!nodes.some(node => node.id === provider.capabilityId)) {
      nodes.push({
        id: provider.capabilityId, type: 'capability', title: capability.title,
        version: capability.version, exposure: capability.exposure,
        sideEffect: capability.sideEffect, riskLevel: capability.riskLevel,
        schemaDigest: provider.schemaDigest, owner: 'ai-native-bank',
      });
    }
    nodes.push({
      id: provider.providerId, type: 'provider', title: provider.providerId.replace(/^provider\./, ''),
      providerType: provider.providerType, capabilityId: provider.capabilityId,
      version: provider.version, schemaDigest: provider.schemaDigest,
      exposure: provider.exposure, requiredScopes: [...provider.requiredScopes],
      health: provider.health, endpointBinding: clone(provider.endpointBinding),
    });
    edges.push(edge('PROVIDED_BY', provider.capabilityId, provider.providerId));
  });
  POLICY_NODES.forEach(item => nodes.push(clone(item)));
}

function businessObjectTitle(id) {
  const titles = {
    'bank.account': '银行账户',
    'bank.customer': '银行客户',
    'bank.payee': '收款人',
    'bank.transfer-order': '转账指令',
    'bank.credit-card': '信用卡',
  };
  return titles[id] || id;
}

function validateIntentGraph(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('graph must be an object');
  if (input.schemaVersion !== '2.0' || input.graphId !== GRAPH_ID || input.bank !== 'CCB') {
    throw new TypeError('graph identity is invalid');
  }
  if (!/^\d+\.\d+\.\d+$/.test(input.version || '')) throw new TypeError('graph version is invalid');
  if (!Array.isArray(input.nodes) || !Array.isArray(input.edges)) throw new TypeError('graph nodes and edges are required');
  const nodeIds = new Set();
  const menuKeys = new Set();
  const allNodeIds = new Set(input.nodes.map(node => node && node.id));
  input.nodes.forEach(node => {
    if (!node || typeof node !== 'object' || !/^[a-z0-9.-]+$/.test(node.id || '')) throw new TypeError('graph node id is invalid');
    if (nodeIds.has(node.id)) throw new TypeError('graph node id is duplicated');
    nodeIds.add(node.id);
    if (![
      'channel', 'menu', 'intent', 'business-object', 'skill', 'slot',
      'capability', 'provider', 'policy',
    ].includes(node.type)) throw new TypeError('graph node type is invalid');
    if (node.type === 'menu') {
      if (!node.menuKey || menuKeys.has(node.menuKey)) throw new TypeError('graph menu binding is invalid');
      menuKeys.add(node.menuKey);
    }
    if (node.type !== 'intent') return;
    if (!EXECUTION_MODES.has(node.executionMode)) throw new TypeError('intent execution mode is invalid');
    if (!Array.isArray(node.aliases) || new Set(node.aliases).size !== node.aliases.length || node.aliases.some(item => !item)) {
      throw new TypeError('intent aliases are invalid');
    }
    if (!Array.isArray(node.recallTerms)
      || new Set(node.recallTerms).size !== node.recallTerms.length
      || node.recallTerms.some(item => typeof item !== 'string' || item.length < 2)) {
      throw new TypeError('intent recall terms are invalid');
    }
    if (!Array.isArray(node.recallTermSets)
      || node.recallTermSets.some(set => !Array.isArray(set)
        || set.length < 2 || set.length > 4
        || new Set(set).size !== set.length
        || set.some(item => typeof item !== 'string' || item.length < 1 || item.length > 16))) {
      throw new TypeError('intent recall term sets are invalid');
    }
    if (!Number.isInteger(node.semanticPriority)
      || node.semanticPriority < 0 || node.semanticPriority > 100) {
      throw new TypeError('intent semantic priority is invalid');
    }
    if (!Array.isArray(node.negativeExamples) || new Set(node.negativeExamples).size !== node.negativeExamples.length || node.negativeExamples.some(item => !item)) {
      throw new TypeError('intent negative examples are invalid');
    }
    if (!Array.isArray(node.capabilityBindings)) throw new TypeError('intent capability bindings are invalid');
    if (node.confusableIntents != null || node.disambiguationHints != null) {
      if (!Array.isArray(node.confusableIntents)
        || node.confusableIntents.length === 0
        || new Set(node.confusableIntents).size !== node.confusableIntents.length
        || typeof node.disambiguationHints !== 'string'
        || !node.disambiguationHints.trim()) {
        throw new TypeError(`intent disambiguation metadata is invalid: ${node.id}`);
      }
      node.confusableIntents.forEach(id => {
        if (!allNodeIds.has(id)) throw new TypeError(`confusable intent is unknown: ${node.id} -> ${id}`);
      });
    }
    if (!node.taskPolicy || !Array.isArray(node.taskPolicy.supportedShapes)
      || !node.contextPolicy || typeof node.responsePolicy !== 'string') {
      throw new TypeError(`intent conversation policies are incomplete: ${node.id}`);
    }
    if (node.orchestrationMode != null
      && !['deterministic', 'agent', 'single', 'parallel', 'sequential'].includes(node.orchestrationMode)) {
      throw new TypeError(`intent orchestration mode is invalid: ${node.id}`);
    }
    if (node.fulfillmentKind != null
      && !['unconfigured', 'answer', 'query', 'page', 'menu', 'skill', 'workflow', 'agent'].includes(node.fulfillmentKind)) {
      throw new TypeError(`intent fulfillment kind is invalid: ${node.id}`);
    }
    if (node.orchestrationMode === 'agent' && !node.skillBinding) {
      throw new TypeError(`agent-orchestrated intent lacks skill binding: ${node.id}`);
    }
    node.capabilityBindings.forEach(id => {
      const capability = capabilityRegistry.get(id);
      if (!capability) throw new TypeError(`capability binding is unknown: ${id}`);
      if (capability.readiness.status !== 'ready') throw new TypeError(`capability binding is not ready: ${id}`);
      if (capability.exposure === 'system-only') throw new TypeError(`system-only capability binding is forbidden: ${id}`);
    });
    if (node.slotContract != null) validateSlotContract(node);
    if (node.readiness === 'ready') {
      if (node.executionMode === 'read-execute') {
        // 纯查询直接绑定 capability 走 MCP，不要求 skill/profile/slotContract。
        if (!Array.isArray(node.capabilityBindings) || node.capabilityBindings.length === 0) {
          throw new TypeError(`read-execute intent lacks capability binding: ${node.id}`);
        }
      } else if (node.executionMode === 'confirm-required') {
        const profile = INTENT_PROFILES[node.id];
        if (!profile || !node.skillBinding || !node.slotContract) {
          throw new TypeError(`ready intent contract is incomplete: ${node.id}`);
        }
        if (node.skillBinding.skillId !== profile.skillId
          || !/^\d+\.\d+\.\d+$/.test(node.skillBinding.version || '')
          || !/^sha256:[a-f0-9]{64}$/.test(node.skillBinding.digest || '')) {
          throw new TypeError(`ready intent skill binding is invalid: ${node.id}`);
        }
      }
      // knowledge-only: no skill/slot contract required
    }
  });
  if (menuKeys.size !== 96) throw new TypeError(`graph must cover 96 menus, got ${menuKeys.size}`);
  input.edges.forEach(item => {
    if (!item || !nodeIds.has(item.from) || !nodeIds.has(item.to)) throw new TypeError('graph edge binding is invalid');
  });
  input.nodes.filter(node => node.type === 'intent' && node.readiness === 'ready').forEach(intent => {
    const requiredRelations = intent.executionMode === 'read-execute'
      ? ['REQUIRES_CAPABILITY', 'GUARDED_BY']
      : intent.executionMode === 'confirm-required'
      ? ['HANDLED_BY', 'TARGETS', 'REQUIRES_CAPABILITY', 'GUARDED_BY']
      : []; // knowledge-only: no required relations
    for (const relation of requiredRelations) {
      if (!input.edges.some(item => item.type === relation && item.from === intent.id)) {
        throw new TypeError(`ready intent relation is missing: ${intent.id}:${relation}`);
      }
    }
  });
  // 语义内容不变式：active 意图的描述必须跨意图唯一。共享模板描述会在
  // 多向量索引中互相稀释，且从不赢得 top-1（实证 0/16），只产生串扰。
  // planned 意图不进语义索引与召回，不在约束范围。
  const descriptionOwners = new Map();
  input.nodes.filter(node => node.type === 'intent' && node.lifecycle === 'active').forEach(intent => {
    const previous = descriptionOwners.get(intent.description);
    if (previous) throw new TypeError(`intent description is duplicated across intents: ${previous} and ${intent.id}`);
    descriptionOwners.set(intent.description, intent.id);
  });
  const expectedDigest = graphDigest(input);
  if (input.digest !== expectedDigest) throw new TypeError('graph digest is invalid');
  return true;
}

function validateSlotContract(node) {
  const contract = node.slotContract;
  if (!contract || typeof contract !== 'object' || Array.isArray(contract) || !['2.0', '4.1'].includes(contract.version)) {
    throw new TypeError('slot contract identity is invalid');
  }
  if (!Array.isArray(contract.slots) || contract.slots.length > 16) {
    throw new TypeError('slot contract slots are invalid');
  }
  const names = new Set();
  contract.slots.forEach(slot => {
    if (!slot || typeof slot !== 'object' || Array.isArray(slot)
      || !/^[a-z][A-Za-z0-9]{0,63}$/.test(slot.name || '')
      || !/^slot\.[a-z0-9.-]+$/.test(slot.slotId || '')
      || /Id$/.test(slot.name)
      || typeof slot.label !== 'string' || !slot.label
      || ![
        'party_reference', 'account_reference', 'card_reference', 'product_reference',
        'holding_reference', 'money',
        'currency', 'text', 'enum', 'settings_patch',
      ].includes(slot.type)
      || typeof slot.required !== 'boolean'
      || !Array.isArray(slot.extractionKeys) || !slot.extractionKeys.length
      || slot.extractionKeys.some(key => typeof key !== 'string' || !/^[a-z][A-Za-z0-9]{0,63}$/.test(key))) {
      throw new TypeError('slot contract definition is invalid');
    }
    if (names.has(slot.name)) throw new TypeError('slot contract names are duplicated');
    names.add(slot.name);
    if (slot.resolverCapabilityId) {
      const resolver = capabilityRegistry.get(slot.resolverCapabilityId);
      if (!resolver || resolver.readiness.status !== 'ready' || resolver.exposure === 'system-only'
        || resolver.sideEffect !== 'none' || !node.capabilityBindings.includes(slot.resolverCapabilityId)) {
        throw new TypeError('slot contract resolver is invalid');
      }
    }
  });
  if (!Array.isArray(contract.clarificationOrder)
    || new Set(contract.clarificationOrder).size !== contract.clarificationOrder.length) {
    throw new TypeError('slot contract clarification order is invalid');
  }
  contract.clarificationOrder.forEach(name => {
    const slot = contract.slots.find(item => item.name === name);
    if (!slot || !slot.required || Object.prototype.hasOwnProperty.call(slot, 'defaultValue')) {
      throw new TypeError('slot contract clarification slot is invalid');
    }
  });
  const binding = contract.executionBinding;
  const capability = binding && capabilityRegistry.get(binding.capabilityId);
  if (!binding || typeof binding.requiresConfirmation !== 'boolean' || !capability
    || capability.readiness.status !== 'ready' || capability.exposure === 'system-only'
    || !node.capabilityBindings.includes(binding.capabilityId)) {
    throw new TypeError('slot contract execution binding is invalid');
  }
  const inputProperties = capability.inputSchema && capability.inputSchema.properties || {};
  contract.slots.forEach(slot => {
    if (!slot.resolvedField || (
      slot.type !== 'settings_patch'
      && !Object.prototype.hasOwnProperty.call(inputProperties, slot.resolvedField)
    )) {
      throw new TypeError('slot contract resolved field is invalid');
    }
  });
  const expectedRequired = contract.slots
    .filter(slot => slot.required && !Object.prototype.hasOwnProperty.call(slot, 'defaultValue'))
    .map(slot => slot.name);
  if (JSON.stringify(node.requiredSlots) !== JSON.stringify(expectedRequired)) {
    throw new TypeError('slot contract required slots are invalid');
  }
}

function executionMode(action, capability) {
  if (action.kind === 'faq') return 'knowledge-only';
  if (action.readiness === 'mock-only') return 'knowledge-only';
  if (action.kind === 'unavailable' || action.readiness === 'planned') return 'knowledge-only';
  if (!capability) return 'knowledge-only';
  if (capability.exposure === 'model-callable' && capability.sideEffect === 'none') return 'read-execute';
  return 'confirm-required';
}

function fulfillmentKind(execMode, action, skill) {
  if (execMode === 'knowledge-only') return action.kind === 'faq' ? 'answer' : 'answer';
  if (skill) return 'skill';
  if (execMode === 'read-execute') return 'query';
  if (execMode === 'confirm-required') return action.kind === 'navigate' ? 'menu' : 'skill';
  if (execMode === 'multi_intent') return 'workflow';
  return 'unconfigured';
}

function manualNegativeExamples(intentId) {
  const examples = {
    'ccb.credit.card.loss-report': ['查询信用卡交易明细', '申请提高信用卡额度'],
    'ccb.credit.card.transactions.query': ['挂失信用卡', '修改信用卡安全设置'],
    'ccb.account.balance.query': ['查询信用卡可用额度', '申请贷款额度'],
    'ccb.wealth.dragon-money.overview': [
      '购买龙钱宝', '申购龙钱宝', '购买天天利', '申购天天利',
    ],
  };
  return examples[intentId] ? [...examples[intentId]] : [];
}

// 负例从图谱结构确定性派生：同菜单下兄弟意图的短口语别名互为负例，
// 运行时 query 命中负例扣 160 分，压制同菜单跨意图误召。
// 手写负例（guided 定义与 manual 表）优先，派生只补空白；与自身
// 别名/标题存在包含关系的候选剔除，避免误伤本意图的正例命中。
function applyDerivedNegativeExamples(nodes) {
  const groups = new Map();
  nodes.filter(node => node.type === 'intent' && node.lifecycle === 'active').forEach(intent => {
    if (!groups.has(intent.menuKey)) groups.set(intent.menuKey, []);
    groups.get(intent.menuKey).push(intent);
  });
  groups.forEach(group => {
    if (group.length < 2) return;
    group.forEach(intent => {
      if (intent.negativeExamples && intent.negativeExamples.length) return;
      const own = [...(intent.aliases || []), intent.title];
      const candidates = group
        .filter(sibling => sibling.id !== intent.id)
        .flatMap(sibling => sibling.aliases || [])
        .filter(alias => !own.some(text => text.includes(alias) || alias.includes(text)))
        .sort((left, right) => left.length - right.length);
      const picks = [];
      for (const alias of candidates) {
        if (picks.some(picked => picked.includes(alias) || alias.includes(picked))) continue;
        picks.push(alias);
        if (picks.length >= 2) break;
      }
      if (picks.length) intent.negativeExamples = picks;
    });
  });
}

function normalizeIdentifier(value) {
  return String(value || 'service').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'service';
}

function uniqueText(values) {
  return [...new Set(values.filter(value => typeof value === 'string').map(value => value.trim()).filter(Boolean))];
}

function edge(type, from, to) {
  return { id: `${type}:${from}:${to}`, type, from, to };
}

function compareById(left, right) {
  return left.id.localeCompare(right.id, 'en');
}

function graphDigest(input) {
  const copy = clone(input);
  delete copy.digest;
  return 'sha256:' + crypto.createHash('sha256').update(canonicalStringify(copy)).digest('hex');
}

function canonicalStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalStringify).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalStringify(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = {
  GRAPH_ID,
  GRAPH_VERSION,
  buildIntentGraph,
  validateIntentGraph,
  canonicalStringify,
  graphDigest,
};
