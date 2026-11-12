'use strict';

function slot(slotId, name, label, type, options = {}) {
  return Object.freeze({
    slotId,
    name,
    label,
    type,
    required: options.required !== false,
    extractionKeys: Object.freeze(options.extractionKeys || [name]),
    ...(options.resolverCapabilityId ? { resolverCapabilityId: options.resolverCapabilityId } : {}),
    ...(options.normalizer ? { normalizer: options.normalizer } : {}),
    ...(Object.prototype.hasOwnProperty.call(options, 'defaultValue') ? { defaultValue: options.defaultValue } : {}),
    resolvedField: options.resolvedField || name,
  });
}

function profile(options) {
  return Object.freeze({
    skillId: options.skillId,
    businessObjectId: options.businessObjectId,
    capabilities: Object.freeze(options.capabilities),
    slots: Object.freeze(options.slots || []),
    clarificationOrder: Object.freeze(options.clarificationOrder || []),
    executionCapabilityId: options.executionCapabilityId,
    taskPolicy: Object.freeze({
      supportedShapes: Object.freeze(options.supportedShapes || ['single_intent']),
      mode: options.taskMode || 'sequential',
      maxTasks: options.maxTasks || 8,
    }),
    contextPolicy: Object.freeze({
      retainOnClarification: true,
      allowIntentSwitch: true,
      resumable: true,
    }),
    responsePolicy: options.responsePolicy,
    semanticPriority: Number.isInteger(options.semanticPriority) ? options.semanticPriority : 0,
    ...(options.orchestrationMode ? { orchestrationMode: options.orchestrationMode } : {}),
  });
}

const ACCOUNT_REFERENCE = () => slot(
  'slot.account.reference', 'accountReference', '查询账户', 'account_reference',
  {
    extractionKeys: ['accountName', 'accountReference', 'maskedAccountNo'],
    resolverCapabilityId: 'bank.account.list',
    resolvedField: 'accountId',
  },
);
const CARD_REFERENCE = () => slot(
  'slot.card.reference', 'cardReference', '信用卡', 'card_reference',
  {
    extractionKeys: ['cardName', 'cardReference', 'maskedCardNo'],
    resolverCapabilityId: 'bank.credit-card.list',
    resolvedField: 'cardId',
  },
);

const INTENT_PROFILES = Object.freeze({
  'ccb.account.balance.query': profile({
    skillId: 'bank.account-inquiry',
    businessObjectId: 'bank.account',
    capabilities: ['bank.account.list', 'bank.account.balance.get', 'bank.account.detail.get'],
    slots: [ACCOUNT_REFERENCE()],
    clarificationOrder: ['accountReference'],
    executionCapabilityId: 'bank.account.balance.get',
    supportedShapes: ['single_intent', 'same_intent_multi_task', 'multi_intent'],
    taskMode: 'parallel-safe',
    responsePolicy: 'query_result',
  }),
  'ccb.account.transactions.query': profile({
    skillId: 'bank.account-inquiry',
    businessObjectId: 'bank.account',
    capabilities: ['bank.account.list', 'bank.account.transactions.list', 'bank.account.detail.get'],
    slots: [ACCOUNT_REFERENCE()],
    clarificationOrder: ['accountReference'],
    executionCapabilityId: 'bank.account.transactions.list',
    supportedShapes: ['single_intent', 'same_intent_multi_task', 'multi_intent'],
    taskMode: 'parallel-safe',
    responsePolicy: 'query_result',
  }),
  'ccb.account.detail.query': profile({
    skillId: 'bank.account-inquiry',
    businessObjectId: 'bank.account',
    capabilities: ['bank.account.list', 'bank.account.detail.get'],
    slots: [ACCOUNT_REFERENCE()],
    clarificationOrder: ['accountReference'],
    executionCapabilityId: 'bank.account.detail.get',
    supportedShapes: ['single_intent', 'same_intent_multi_task', 'multi_intent'],
    taskMode: 'parallel-safe',
    responsePolicy: 'query_result',
  }),
  'ccb.customer.profile.query': profile({
    skillId: 'bank.customer-profile',
    businessObjectId: 'bank.customer',
    capabilities: ['bank.customer.profile.get'],
    executionCapabilityId: 'bank.customer.profile.get',
    supportedShapes: ['single_intent', 'multi_intent'],
    taskMode: 'parallel-safe',
    responsePolicy: 'query_result',
  }),
  'ccb.transfer.create': profile({
    skillId: 'bank.transfer-remittance',
    businessObjectId: 'bank.transfer-order',
    capabilities: ['bank.account.list', 'bank.payee.list', 'bank.payee.validate', 'bank.transfer.order.create', 'bank.transfer.status.get'],
    slots: [
      slot('slot.party.payee', 'payee', '收款人', 'party_reference', {
        extractionKeys: ['payeeName', 'payeeReference'],
        resolverCapabilityId: 'bank.payee.list',
        resolvedField: 'payeeId',
      }),
      slot('slot.account.reference', 'fromAccount', '转出账户', 'account_reference', {
        extractionKeys: ['fromAccountName', 'fromAccountReference'],
        resolverCapabilityId: 'bank.account.list',
        resolvedField: 'fromAccountId',
      }),
      slot('slot.money.amount', 'amount', '金额', 'money', {
        extractionKeys: ['amount', 'amountMinor'], normalizer: 'cny_amount_minor', resolvedField: 'amountMinor',
      }),
      slot('slot.currency', 'currency', '币种', 'currency', {
        extractionKeys: ['currency'], defaultValue: 'CNY', resolvedField: 'currency',
      }),
      slot('slot.transfer.purpose', 'purpose', '用途/备注', 'text', {
        required: false, extractionKeys: ['purpose'], resolvedField: 'purpose',
      }),
    ],
    clarificationOrder: ['payee', 'fromAccount', 'amount'],
    executionCapabilityId: 'bank.transfer.order.create',
    supportedShapes: ['single_intent', 'same_intent_multi_task', 'multi_intent'],
    taskMode: 'sequential',
    responsePolicy: 'confirmation_then_receipt',
  }),
  'ccb.transfer.payee.query': profile({
    skillId: 'bank.transfer-remittance',
    businessObjectId: 'bank.payee',
    capabilities: ['bank.payee.list'],
    executionCapabilityId: 'bank.payee.list',
    taskMode: 'parallel-safe',
    responsePolicy: 'query_result',
  }),
  'ccb.credit.card.query': profile({
    skillId: 'bank.credit-card-management',
    businessObjectId: 'bank.credit-card',
    capabilities: ['bank.credit-card.list'],
    executionCapabilityId: 'bank.credit-card.list',
    taskMode: 'parallel-safe',
    responsePolicy: 'query_result',
  }),
  'ccb.credit.card.transactions.query': profile({
    skillId: 'bank.credit-card-management',
    businessObjectId: 'bank.credit-card',
    capabilities: ['bank.credit-card.list', 'bank.credit-card.detail.get', 'bank.credit-card.transactions.list'],
    slots: [CARD_REFERENCE()],
    clarificationOrder: ['cardReference'],
    executionCapabilityId: 'bank.credit-card.transactions.list',
    supportedShapes: ['single_intent', 'same_intent_multi_task'],
    taskMode: 'parallel-safe',
    responsePolicy: 'query_result',
  }),
  'ccb.credit.card.activation': profile({
    skillId: 'bank.credit-card-management',
    businessObjectId: 'bank.credit-card',
    capabilities: ['bank.credit-card.list', 'bank.credit-card.activation.create'],
    slots: [CARD_REFERENCE()],
    clarificationOrder: ['cardReference'],
    executionCapabilityId: 'bank.credit-card.activation.create',
    supportedShapes: ['single_intent', 'same_intent_multi_task'],
    responsePolicy: 'confirmation_then_receipt',
  }),
  'ccb.credit.card.loss-report': profile({
    skillId: 'bank.credit-card-management',
    businessObjectId: 'bank.credit-card',
    capabilities: ['bank.credit-card.list', 'bank.credit-card.loss-report.create'],
    slots: [
      CARD_REFERENCE(),
      slot('slot.loss.reason', 'lossReason', '挂失原因', 'enum', {
        extractionKeys: ['lossReason', 'reason'], resolvedField: 'reason',
      }),
    ],
    clarificationOrder: ['cardReference', 'lossReason'],
    executionCapabilityId: 'bank.credit-card.loss-report.create',
    supportedShapes: ['single_intent', 'same_intent_multi_task'],
    responsePolicy: 'confirmation_then_receipt',
  }),
  'ccb.credit.card.limit-change': profile({
    skillId: 'bank.credit-card-management',
    businessObjectId: 'bank.credit-card',
    capabilities: ['bank.credit-card.list', 'bank.credit-card.limit-change.create'],
    slots: [
      CARD_REFERENCE(),
      slot('slot.credit-card.requested-limit', 'requestedLimit', '目标额度', 'money', {
        extractionKeys: ['requestedLimit', 'requestedLimitMinor'], normalizer: 'cny_amount_minor',
        resolvedField: 'requestedLimitMinor',
      }),
    ],
    clarificationOrder: ['cardReference', 'requestedLimit'],
    executionCapabilityId: 'bank.credit-card.limit-change.create',
    supportedShapes: ['single_intent', 'same_intent_multi_task'],
    responsePolicy: 'confirmation_then_receipt',
  }),
  'ccb.credit.card.security-settings.update': profile({
    skillId: 'bank.credit-card-management',
    businessObjectId: 'bank.credit-card',
    capabilities: ['bank.credit-card.list', 'bank.credit-card.detail.get', 'bank.credit-card.settings.get', 'bank.credit-card.security-settings.update'],
    slots: [
      CARD_REFERENCE(),
      slot('slot.credit-card.settings-patch', 'settingsPatch', '安全设置变更', 'settings_patch', {
        extractionKeys: ['settingsPatch', 'settingName', 'settingValue'], resolvedField: 'settingsPatch',
      }),
    ],
    clarificationOrder: ['cardReference', 'settingsPatch'],
    executionCapabilityId: 'bank.credit-card.security-settings.update',
    supportedShapes: ['single_intent', 'same_intent_multi_task'],
    responsePolicy: 'confirmation_then_receipt',
  }),
  'ccb.home.repayment.repay': profile({
    skillId: 'bank.credit-card-management',
    businessObjectId: 'bank.credit-card-bill',
    capabilities: [
      'bank.credit-card.list', 'bank.credit-card.detail.get', 'bank.credit-card.bill.get', 'bank.account.list',
      'bank.account.balance.get', 'bank.credit-card.repayment.create',
    ],
    slots: [
      slot('slot.credit-card.guided-card', 'card', '信用卡', 'card_reference', {
        extractionKeys: ['cardName', 'cardReference', 'maskedCardNo', 'cardId'],
        resolverCapabilityId: 'bank.credit-card.list', resolvedField: 'cardId',
      }),
      slot('slot.credit-card.guided-account', 'fromAccount', '付款账户', 'account_reference', {
        extractionKeys: ['fromAccountName', 'fromAccountReference', 'maskedAccountNo', 'fromAccountId'],
        resolverCapabilityId: 'bank.account.list', resolvedField: 'fromAccountId',
      }),
      slot('slot.credit-card.repayment-amount', 'amount', '还款金额', 'money', {
        extractionKeys: ['amount', 'amountMinor'], normalizer: 'cny_amount_minor',
        resolvedField: 'amountMinor',
      }),
    ],
    clarificationOrder: ['card', 'fromAccount', 'amount'],
    executionCapabilityId: 'bank.credit-card.repayment.create',
    supportedShapes: ['single_intent'],
    taskMode: 'sequential',
    responsePolicy: 'credit_card_repayment',
  }),
  'ccb.wealth.dragon-money.overview': profile({
    skillId: 'bank.wealth-management',
    businessObjectId: 'bank.wealth-holding',
    capabilities: ['bank.wealth.holding.list'],
    executionCapabilityId: 'bank.wealth.holding.list',
    supportedShapes: ['single_intent', 'multi_intent'],
    taskMode: 'parallel-safe',
    responsePolicy: 'query_result',
  }),
  'ccb.wealth.dragon-money.buy': profile({
    skillId: 'bank.wealth-management',
    businessObjectId: 'bank.wealth-order',
    capabilities: [
      'bank.wealth.product.list', 'bank.wealth.product.detail.get', 'bank.wealth.holding.list',
      'bank.wealth.transaction.list', 'bank.wealth.salary-insights.get', 'bank.wealth.recommendations.get',
      'bank.account.list', 'bank.wealth.purchase.create',
    ],
    slots: [
      slot('slot.wealth.product-reference', 'productReference', '理财产品', 'text', {
        extractionKeys: ['productReference', 'productName'], defaultValue: 'prod_w_lqb10', resolvedField: 'productId',
      }),
      slot('slot.account.reference', 'fromAccount', '付款账户', 'account_reference', {
        extractionKeys: ['fromAccountName', 'fromAccountReference', 'accountReference'],
        resolverCapabilityId: 'bank.account.list', resolvedField: 'accountId',
      }),
      slot('slot.money.amount', 'amount', '申购金额', 'money', {
        extractionKeys: ['amount', 'amountMinor'], normalizer: 'cny_amount_minor', resolvedField: 'amountMinor',
      }),
    ],
    clarificationOrder: ['fromAccount', 'amount'],
    executionCapabilityId: 'bank.wealth.purchase.create',
    supportedShapes: ['single_intent', 'multi_intent'],
    taskMode: 'sequential',
    responsePolicy: 'confirmation_then_receipt',
  }),
  'ccb.wealth.wealth-product.buy': profile({
    skillId: 'bank.wealth-management',
    businessObjectId: 'bank.wealth-order',
    capabilities: [
      'bank.wealth.product.list', 'bank.wealth.product.detail.get', 'bank.wealth.holding.list',
      'bank.wealth.transaction.list', 'bank.wealth.salary-insights.get', 'bank.wealth.recommendations.get',
      'bank.account.list', 'bank.wealth.purchase.create',
    ],
    slots: [
      slot('slot.wealth.product-reference', 'productReference', '理财产品', 'product_reference', {
        extractionKeys: ['productReference', 'productName'],
        resolverCapabilityId: 'bank.wealth.product.list', resolvedField: 'productId',
      }),
      slot('slot.account.reference', 'fromAccount', '付款账户', 'account_reference', {
        extractionKeys: ['fromAccountName', 'fromAccountReference', 'accountReference'],
        resolverCapabilityId: 'bank.account.list', resolvedField: 'accountId',
      }),
      slot('slot.money.amount', 'amount', '申购金额', 'money', {
        extractionKeys: ['amount', 'amountMinor'], normalizer: 'cny_amount_minor', resolvedField: 'amountMinor',
      }),
    ],
    clarificationOrder: ['productReference', 'fromAccount', 'amount'],
    executionCapabilityId: 'bank.wealth.purchase.create',
    supportedShapes: ['single_intent', 'multi_intent'],
    taskMode: 'sequential',
    responsePolicy: 'confirmation_then_receipt',
  }),
  'ccb.wealth.redeem': profile({
    skillId: 'bank.wealth-management',
    businessObjectId: 'bank.wealth-holding',
    capabilities: ['bank.wealth.holding.list', 'bank.wealth.redeem.create'],
    slots: [
      slot('slot.wealth.holding-reference', 'holdingReference', '理财持仓', 'holding_reference', {
        extractionKeys: ['holdingReference', 'productName', 'holdingId'],
        resolverCapabilityId: 'bank.wealth.holding.list',
        resolvedField: 'holdingId',
      }),
    ],
    clarificationOrder: ['holdingReference'],
    executionCapabilityId: 'bank.wealth.redeem.create',
    supportedShapes: ['single_intent'],
    taskMode: 'sequential',
    responsePolicy: 'confirmation_then_receipt',
  }),
  'ccb.wealth.advisor.recommend': profile({
    skillId: 'bank.wealth-advisory',
    businessObjectId: 'bank.wealth-advice',
    capabilities: ['bank.wealth.advisory.context.get'],
    slots: [
      slot('slot.wealth.planned-amount', 'plannedAmount', '计划金额', 'money', {
        required: false,
        extractionKeys: ['plannedAmount', 'plannedAmountMinor', 'amount', 'amountMinor'],
        normalizer: 'cny_amount_minor',
        resolvedField: 'plannedAmountMinor',
      }),
      slot('slot.wealth.horizon-months', 'horizonMonths', '预计持有期限', 'enum', {
        required: false,
        extractionKeys: ['horizonMonths', 'holdingPeriodMonths'],
        normalizer: 'duration_months',
        resolvedField: 'horizonMonths',
      }),
      slot('slot.wealth.investment-goal', 'investmentGoal', '投资目标', 'enum', {
        required: false,
        extractionKeys: ['investmentGoal'],
        normalizer: 'investment_goal',
        resolvedField: 'investmentGoal',
      }),
      slot('slot.wealth.product-scope', 'productScope', '产品范围', 'enum', {
        required: false,
        extractionKeys: ['productScope'],
        normalizer: 'wealth_product_scope',
        resolvedField: 'productScope',
      }),
    ],
    executionCapabilityId: 'bank.wealth.advisory.context.get',
    supportedShapes: ['single_intent', 'multi_intent'],
    taskMode: 'sequential',
    responsePolicy: 'wealth_advice',
    orchestrationMode: 'agent',
    // Explicit advisory/planning goals are semantically narrower than a
    // same-domain catalogue browse.  Runtime applies this graph-owned value
    // only when the corresponding recallTermSet actually matched.
    semanticPriority: 100,
  }),
  'ccb.cashflow.salary-plan': profile({
    skillId: 'bank.cashflow-planning', businessObjectId: 'bank.cashflow-plan',
    capabilities: ['bank.cashflow.salary-plan.get'],
    executionCapabilityId: 'bank.cashflow.salary-plan.get',
    supportedShapes: ['single_intent'], taskMode: 'sequential', responsePolicy: 'guided_plan',
  }),
  'ccb.cashflow.spending-explain': profile({
    skillId: 'bank.spending-analysis', businessObjectId: 'bank.spending-analysis',
    capabilities: ['bank.cashflow.spending-analysis.get'],
    slots: [slot('slot.cashflow.period', 'period', '分析月份', 'text', {
      extractionKeys: ['period', 'month'], normalizer: 'year_month', resolvedField: 'period',
    })],
    clarificationOrder: ['period'], executionCapabilityId: 'bank.cashflow.spending-analysis.get',
    supportedShapes: ['single_intent'], taskMode: 'parallel-safe', responsePolicy: 'query_result',
  }),
  'ccb.obligation.repay-all': profile({
    skillId: 'bank.obligation-management', businessObjectId: 'bank.obligation-plan',
    capabilities: [
      'bank.obligation.list', 'bank.loan.list', 'bank.loan.detail.get', 'bank.loan.repayment.list',
      'bank.loan.precalculate.create', 'bank.utility.bill.list',
      'bank.credit-card.repayment.create', 'bank.loan.repayment.create', 'bank.utility.payment.create',
    ],
    executionCapabilityId: 'bank.obligation.list',
    supportedShapes: ['single_intent'], taskMode: 'sequential', responsePolicy: 'guided_plan_then_receipts',
  }),
  'ccb.obligation.pay-selected': profile({
    skillId: 'bank.obligation-management', businessObjectId: 'bank.obligation-plan',
    capabilities: [
      'bank.obligation.list', 'bank.loan.list', 'bank.loan.detail.get', 'bank.loan.repayment.list',
      'bank.loan.precalculate.create', 'bank.utility.bill.list',
      'bank.credit-card.repayment.create', 'bank.loan.repayment.create', 'bank.utility.payment.create',
    ],
    executionCapabilityId: 'bank.obligation.list',
    supportedShapes: ['single_intent'], taskMode: 'sequential', responsePolicy: 'guided_plan_then_receipts',
  }),
});

const INTENT_RECALL_HINTS = Object.freeze({
  'ccb.account.balance.query': Object.freeze(['查余额', '余额查询', '可用余额', '工资卡余额']),
  'ccb.account.transactions.query': Object.freeze(['查流水', '账户流水', '账户明细', '交易明细']),
  'ccb.transfer.create': Object.freeze(['发起转账', '我要转账', '帮我转账', '给收款人转账']),
  'ccb.transfer.payee.query': Object.freeze(['常用收款人', '收款人列表', '查询收款人']),
  'ccb.home.transfer.faq': Object.freeze([
    '转账多久到账', '转账手续费', '转账限额', '转账失败原因', '转账能否撤回',
  ]),
  'ccb.credit.card.query': Object.freeze(['我的信用卡', '信用卡列表', '信用卡额度', '信用卡状态']),
  'ccb.credit.card.transactions.query': Object.freeze(['信用卡明细', '信用卡交易', '消费记录']),
  'ccb.credit.card.activation': Object.freeze(['激活信用卡', '信用卡开卡']),
  'ccb.credit.card.loss-report': Object.freeze(['信用卡挂失', '卡片丢失', '卡被盗']),
  'ccb.credit.card.limit-change': Object.freeze(['信用卡调额', '额度调整', '提高额度', '降低额度']),
  'ccb.credit.card.security-settings.update': Object.freeze(['信用卡安全设置', '境外交易设置', '非接设置']),
  'ccb.home.repayment.repay': Object.freeze(['信用卡还款', '还本月信用卡', '立即还款']),
  'ccb.home.repayment.overview': Object.freeze([
    '信用卡未还金额', '查信用卡欠款', '账单金额',
  ]),
  'ccb.credit.bill.overview': Object.freeze([
    '查账单', '信用卡账单', '本期账单', '未出账单', '账单查询',
  ]),
  'ccb.credit.bill.faq': Object.freeze(['账单常见问题', '账单规则', '账单费用']),
  'ccb.credit.bill.repay': Object.freeze(['还账单', '还清账单', '账单还款']),
  'ccb.credit.card.faq': Object.freeze(['信用卡常见问题', '信用卡规则', '信用卡费用']),
  'ccb.wealth.dragon-money.overview': Object.freeze([
    '我的理财', '理财持仓', '理财收益', '零钱理财', '理财查询',
  ]),
  'ccb.wealth.dragon-money.buy': Object.freeze([
    '购买天天利', '申购天天利', '购买龙钱宝', '申购龙钱宝', '购买现金管理产品',
  ]),
  'ccb.wealth.advisor.recommend': Object.freeze([
    '给我推荐理财产品', '什么理财适合我', '帮我选理财', '理财配置建议', '如何配置闲钱',
  ]),
  'ccb.wealth.wealth-product.overview': Object.freeze([
    '理财产品列表', '在售理财产品', '可购买理财', '有哪些理财产品',
  ]),
  'ccb.wealth.wealth-product.buy': Object.freeze([
    '购买理财产品', '申购理财产品', '买理财',
  ]),
  'ccb.cashflow.spending-explain': Object.freeze([
    '支出分析', '分析支出', '分析我的支出', '支出情况', '消费分析', '分析消费',
    '钱花哪了', '钱花得快', '本月支出', '上月支出', '支出对比',
    '收支概览', '查看收支概览', '本月收支', '收支情况', '支出归因', '消费归因',
  ]),
});

const INTENT_RECALL_TERMS = Object.freeze({
  // An account nickname identifies a slot; it is not a balance-query action.
  'ccb.account.balance.query': Object.freeze(['余额', '可用余额']),
  'ccb.account.transactions.query': Object.freeze(['账户流水', '账户明细', '银行卡流水']),
  'ccb.transfer.create': Object.freeze(['转账', '转给', '汇款']),
  'ccb.transfer.payee.query': Object.freeze(['常用收款人', '收款人列表']),
  'ccb.home.transfer.faq': Object.freeze(['手续费', '多久到账', '限额', '失败', '撤回']),
  'ccb.credit.card.query': Object.freeze(['我的信用卡', '信用卡额度', '信用卡状态']),
  'ccb.credit.card.transactions.query': Object.freeze(['信用卡明细', '信用卡交易', '消费记录']),
  'ccb.credit.card.activation': Object.freeze(['激活', '开卡']),
  'ccb.credit.card.loss-report': Object.freeze(['挂失', '丢卡', '卡丢', '被盗']),
  'ccb.credit.card.limit-change': Object.freeze(['调额', '额度调整', '提高额度', '降低额度']),
  'ccb.credit.card.security-settings.update': Object.freeze(['安全设置', '境外交易', '非接']),
  'ccb.home.repayment.repay': Object.freeze(['信用卡还款', '还信用卡', '还本月账单']),
  'ccb.home.repayment.overview': Object.freeze(['未还金额', '信用卡欠款']),
  'ccb.credit.bill.overview': Object.freeze(['信用卡账单', '查账单', '未出账单', '本期账单']),
  'ccb.credit.bill.faq': Object.freeze(['账单常见问题', '账单规则']),
  'ccb.credit.bill.repay': Object.freeze(['还账单', '还清账单']),
  'ccb.credit.card.faq': Object.freeze(['信用卡常见问题', '信用卡规则', '信用卡费用']),
  'ccb.wealth.dragon-money.overview': Object.freeze(['持仓', '收益', '零钱理财']),
  'ccb.wealth.dragon-money.buy': Object.freeze(['购买天天利', '申购天天利', '购买龙钱宝', '申购龙钱宝']),
  'ccb.wealth.advisor.recommend': Object.freeze(['理财推荐', '适合我的理财', '配置建议', '帮我选理财']),
  'ccb.wealth.wealth-product.overview': Object.freeze(['理财产品列表', '在售理财', '有哪些理财']),
  'ccb.wealth.wealth-product.buy': Object.freeze(['购买理财', '申购理财', '买理财']),
  'ccb.account.detail.query': Object.freeze(['账户详情', '账户信息']),
  'ccb.customer.profile.query': Object.freeze(['客户等级', '客户资料', '我是几级客户', '预留手机号']),
  'ccb.wealth.redeem': Object.freeze(['赎回', '理财赎回']),
  'ccb.cashflow.spending-explain': Object.freeze([
    '支出分析', '支出情况', '消费分析', '钱花哪了', '钱花得快', '本月支出', '支出对比',
    '收支概览', '本月收支', '支出归因', '消费归因',
  ]),
});

const INTENT_RECALL_TERM_SETS = Object.freeze({
  'ccb.transfer.create': Object.freeze([Object.freeze(['给', '转'])]),
  'ccb.account.detail.query': Object.freeze([Object.freeze(['账户', '详情'])]),
  'ccb.customer.profile.query': Object.freeze([
    Object.freeze(['客户', '等级']),
    Object.freeze(['客户', '资料']),
  ]),
  'ccb.wealth.redeem': Object.freeze([Object.freeze(['理财', '赎回'])]),
  'ccb.wealth.wealth-product.overview': Object.freeze([
    Object.freeze(['理财', '哪些']),
    Object.freeze(['理财', '在售']),
  ]),
  'ccb.wealth.advisor.recommend': Object.freeze([
    Object.freeze(['理财', '推荐']),
    Object.freeze(['理财', '适合']),
    Object.freeze(['理财', '配置']),
  ]),
  'ccb.cashflow.spending-explain': Object.freeze([
    Object.freeze(['支出', '分析']),
    Object.freeze(['消费', '分析']),
    Object.freeze(['支出', '情况']),
    Object.freeze(['支出', '对比']),
  ]),
});

// 易混淆意图的消歧元数据（对齐 Harbor intent-graph v2.1 canonical 语义字段
// confusable_intents / disambiguation_hints）。hints 是写给裁决层的语义判据，
// 禁止收录任何具体用户问法（badcase 原文）。
const INTENT_DISAMBIGUATION = Object.freeze({
  'ccb.home.repayment.overview': Object.freeze({
    confusableIntents: Object.freeze([
      'ccb.credit.bill.overview', 'ccb.credit.bill.repay', 'ccb.home.repayment.repay',
    ]),
    disambiguationHints: '用户关注应还金额、最低还款、还款日等还款义务本身时选本意图；仅查看账单内容或出账状态选账单查询；明确要求执行还款动作选还款办理。',
  }),
  'ccb.credit.bill.overview': Object.freeze({
    confusableIntents: Object.freeze([
      'ccb.home.repayment.overview', 'ccb.credit.bill.faq',
    ]),
    disambiguationHints: '用户关注账单内容、出账、账单日等账单事实时选本意图；关注应还金额与还款安排选还款概览；询问账单规则类知识选账单 FAQ。',
  }),
  'ccb.cashflow.spending-explain': Object.freeze({
    confusableIntents: Object.freeze([
      'ccb.me.income-expense.overview', 'ccb.cashflow.salary-plan',
    ]),
    disambiguationHints: '用户要求解释支出构成或消费归因时选本意图；仅查看收支流水汇总选收支总览；围绕工资安排资金选工资规划。',
  }),
  'ccb.account.balance.query': Object.freeze({
    confusableIntents: Object.freeze([
      'ccb.credit.card.query',
    ]),
    disambiguationHints: '用户关注存款账户可用余额时选本意图；关注信用卡额度或卡片状态选信用卡查询。',
  }),
  'ccb.transfer.create': Object.freeze({
    confusableIntents: Object.freeze([
      'ccb.transfer.payee.query',
    ]),
    disambiguationHints: '用户表达转账意图（收款人、金额、转出）时选本意图；仅查看或维护收款人列表选收款人查询。',
  }),
  'ccb.wealth.dragon-money.overview': Object.freeze({
    confusableIntents: Object.freeze([
      'ccb.wealth.wealth-product.overview', 'ccb.wealth.dragon-money.buy',
    ]),
    disambiguationHints: '用户关注自己已持有的现金管理类持仓与收益时选本意图；浏览在售产品列表选产品列表；表达购买动作选购买。',
  }),
  // === V4-021/022/158 case 修复同步(来源: graph.ccb.intents.v2.1.0.json L4931/L11073/L12127) ===
  // V4 id → V2 id 映射规则: 去掉 `channel.` 前缀
  'ccb.credit.repay.overview': Object.freeze({
    confusableIntents: Object.freeze([
      'ccb.credit.card.query', 'ccb.home.repayment.overview', 'ccb.credit.bill.overview',
      'ccb.home.loan.repayment', 'ccb.credit.repay.faq', 'ccb.credit.repay.repay',
    ]),
    disambiguationHints: '用户关注信用卡应还金额、未还金额或最低还款额时选本意图；关注信用卡卡片状态或额度选卡片管理查询；关注账单出账内容选账单查询。⚠️注意:query 仅含「还本月信用卡/怎么还款/如何还款」等泛指词而无「应还/未还/最低还款/欠多少」等金额词时不应选本意图,应选还款FAQ。',
  }),
  'ccb.home.loan.repayment': Object.freeze({
    confusableIntents: Object.freeze([
      'ccb.home.loan.overview', 'ccb.home.repayment.overview', 'ccb.credit.repay.overview',
    ]),
    disambiguationHints: '用户查看贷款还款计划、还款进度时选本意图；查看贷款概览选贷款概览；查看信用卡还款选还款概览。⚠️注意:query 含「还款计划」时必选本意图(贷款还款计划查询),即使用户同时提到还信用卡等其他操作,也应同时返回本意图。',
  }),
  'ccb.home.repayment.faq': Object.freeze({
    confusableIntents: Object.freeze([
      'ccb.home.repayment.overview', 'ccb.credit.repay.faq', 'ccb.credit.bill.faq',
    ]),
    disambiguationHints: '用户询问信用卡还款规则、到账时效、手续费等知识时选本意图；查看应还金额选还款概览；询问一键还款知识选还款FAQ。⚠️注意:query 含「查信用卡还款/看看信用卡还款」等泛指信用卡还款但无明显查账单或操作意图时必选本意图(知识咨询优先于账单查询)。',
  }),
  // === V4 其他 ⚠️ 修复同步(来源: graph.ccb.intents.v2.1.0.json L2679/L2783/L4688/L4813) ===
  // V4 id → V2 id 映射规则: 去掉 `channel.` 前缀
  'ccb.credit.cash.faq': Object.freeze({
    confusableIntents: Object.freeze([
      'ccb.credit.cash.overview', 'ccb.credit.cash.apply',
    ]),
    disambiguationHints: '用户询问现金转出规则、手续费、到账时效、限额政策等知识时选本意图;查当前可借/可转额度或办理记录选现金转出查询;明确办理选现金转出办理。⚠️注意:query 含「能借多少」「能转多少」「能取多少」等查额度词时必选现金转出查询(overview),不应选本意图。',
  }),
  'ccb.credit.cash.overview': Object.freeze({
    confusableIntents: Object.freeze([
      'ccb.credit.cash.apply', 'ccb.credit.cash.faq',
    ]),
    disambiguationHints: '用户查看现金转出进度、记录、状态、当前可借额度时选本意图(含「能借多少」「能转多少」「能取多少」等查额度查询);办理现金转出选现金转出办理;询问现金转出规则/手续费/到账时效等知识选现金转出FAQ。⚠️注意:query 含「能借多少」「能转多少」「能取多少」时必选本意图。',
  }),
  'ccb.credit.progress.overview': Object.freeze({
    confusableIntents: Object.freeze([
      'ccb.credit.apply.overview',
    ]),
    disambiguationHints: '用户查询非信用卡申请类办卡进度(如房贷卡/附属卡/储蓄卡等)时选本意图;查询信用卡申请进度/办卡进度(含「办卡进度怎么样了」「申卡到哪一步了」等)选申请信用卡查询。⚠️注意:query 含「办卡进度怎么样了」「办卡进度」「申卡进度」「我的办卡进度」时不应选本意图,应选申请信用卡查询(apply.overview)——本意图仅用于非信用卡申请类办卡进度。',
  }),
  'ccb.credit.repay.faq': Object.freeze({
    confusableIntents: Object.freeze([
      'ccb.credit.repay.overview', 'ccb.home.repayment.faq', 'ccb.credit.repay.repay',
    ]),
    disambiguationHints: '用户询问还款规则、到账时效、手续费等知识时选本意图；用户泛指「还本月信用卡/怎么还款/如何还款」等无明显金额或规则意图时选本意图；查看具体应还金额选还款试算。⚠️注意:query 含「还本月信用卡」时必选本意图(产品已将该 query 标注为本意图典型 alias),不应解读为查应还金额。⚠️注意:query 含「还信用卡要手续费吗/还信用卡要手续费不/信用卡还款收手续费吗」等信用卡还款手续费知识咨询时必选本意图,不应选 home.repayment.faq(本意图与首页信用卡还款FAQ功能重叠,但产品标注归属本意图)。',
  }),
});

module.exports = {
  INTENT_PROFILES,
  INTENT_RECALL_HINTS,
  INTENT_RECALL_TERMS,
  INTENT_RECALL_TERM_SETS,
  INTENT_DISAMBIGUATION,
};
