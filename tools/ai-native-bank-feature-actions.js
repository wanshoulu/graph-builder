(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.AINativeBankFeatureActions = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var KINDS = ['api-read', 'api-command', 'mock-view', 'faq', 'unavailable'];
  var ACTIONS = ['QUERY', 'CREATE', 'UPDATE', 'APPLY', 'EXPLAIN'];
  var RISKS = ['L0', 'L1', 'L2'];
  var READINESS = ['ready', 'mock-only', 'planned'];
  var ALLOWED_KEYS = [
    'id', 'title', 'description', 'kind', 'businessObject', 'action',
    'riskLevel', 'capabilityId', 'readiness', 'requiresConfirm',
  ];

  var EXPLICIT_ACTIONS = {
    'home:account': [
      action('overview', '查询与管理', '查询账户、余额与状态', 'api-read', 'account', 'QUERY', 'L1', 'bank.account.list', 'ready', false),
      action('apply', '账户服务', '进入账户相关服务办理', 'mock-view', 'account', 'APPLY', 'L1', null, 'mock-only', false),
      faq('account'),
    ],
    'home:details': [
      action('overview', '查询与管理', '查询账户流水和交易记录', 'api-read', 'account_transaction', 'QUERY', 'L1', 'bank.account.transactions.list', 'ready', false),
      action('apply', '流水服务', '筛选、查询与证明申请说明', 'mock-view', 'account_transaction', 'APPLY', 'L1', null, 'mock-only', false),
      faq('account_transaction'),
    ],
    'home:transfer': [
      action('overview', '收款人与进度', '查询常用收款人和转账状态', 'api-read', 'transfer', 'QUERY', 'L1', 'bank.payee.list', 'ready', false),
      action('apply', '发起转账', '进入转账汇款安全办理链', 'api-command', 'transfer_order', 'CREATE', 'L2', 'bank.transfer.order.create', 'ready', true),
      faq('transfer'),
    ],
    'home:repayment': [
      action('overview', '本期账单', '查询未还金额、最低还款额与还款日', 'api-read', 'credit_card_bill', 'QUERY', 'L1', 'bank.credit-card.bill.get', 'ready', false),
      action('repay', '立即还款', '从本人借记卡还款至信用卡', 'api-command', 'credit_card_bill', 'UPDATE', 'L2', 'bank.credit-card.repayment.create', 'ready', true),
      faq('credit_card'),
    ],
    'home:loan': [
      action('overview', '我的贷款', '查询房贷、信用贷与还款计划', 'api-read', 'loan', 'QUERY', 'L1', 'bank.loan.list', 'mock-only', false),
      action('repayment', '还款计划', '查询指定贷款的分期还款计划', 'api-read', 'loan', 'QUERY', 'L1', 'bank.loan.repayment.list', 'mock-only', false),
      action('measure', '统一测额', '基于代发工资流水的额度测算', 'api-read', 'loan', 'APPLY', 'L1', 'bank.loan.precalculate.create', 'mock-only', false),
      faq('loan'),
    ],
    'home:payroll': [
      action('overview', '发薪与收支', '近一年工资流水与月度收支画像', 'api-read', 'salary_insight', 'QUERY', 'L1', 'bank.wealth.salary-insights.get', 'mock-only', false),
      action('apply', '发薪理财建议', '基于收支画像的理财配置推荐', 'api-read', 'wealth_recommendation', 'APPLY', 'L1', 'bank.wealth.recommendations.get', 'mock-only', false),
      faq('wealth'),
    ],
    'credit:card-manage': [
      action('overview', '查询与管理', '查询本人信用卡、状态和额度', 'api-read', 'credit_card', 'QUERY', 'L1', 'bank.credit-card.list', 'ready', false),
      action('transactions', '交易明细', '查询消费、退款和入账状态', 'api-read', 'credit_card_transaction', 'QUERY', 'L1', 'bank.credit-card.transactions.list', 'ready', false),
      action('security-query', '安全设置查询', '查询信用卡交易安全设置', 'api-read', 'credit_card_security', 'QUERY', 'L1', 'bank.credit-card.settings.get', 'ready', false),
      action('activation', '卡片激活', '激活尚未启用的信用卡', 'api-command', 'credit_card', 'UPDATE', 'L2', 'bank.credit-card.activation.create', 'ready', true),
      action('loss-report', '卡片挂失', '正式挂失遗失的信用卡', 'api-command', 'credit_card', 'UPDATE', 'L2', 'bank.credit-card.loss-report.create', 'ready', true),
      action('limit', '额度管理', '提交信用额度调整申请', 'api-command', 'credit_card_limit', 'APPLY', 'L2', 'bank.credit-card.limit-change.create', 'ready', true),
      action('security', '安全设置', '管理线上、非接和境外交易设置', 'api-command', 'credit_card_security', 'UPDATE', 'L2', 'bank.credit-card.security-settings.update', 'ready', true),
      faq('credit_card'),
    ],
    'credit:bill': [
      action('overview', '本期账单', '未还金额、最低还款与到期日', 'api-read', 'credit_card_bill', 'QUERY', 'L1', 'bank.credit-card.bill.get', 'ready', false),
      action('repay', '立即还款', '从本人借记卡还款至信用卡', 'api-command', 'credit_card_bill', 'UPDATE', 'L2', 'bank.credit-card.repayment.create', 'mock-only', true),
      faq('credit_card'),
    ],
    'credit:repay': [
      action('overview', '还款试算', '查询未还金额与最低还款额', 'api-read', 'credit_card_bill', 'QUERY', 'L1', 'bank.credit-card.bill.get', 'ready', false),
      action('repay', '一键还款', '从本人借记卡即时还款', 'api-command', 'credit_card_bill', 'UPDATE', 'L2', 'bank.credit-card.repayment.create', 'mock-only', true),
      faq('credit_card'),
    ],
    'wealth:overview': [
      action('overview', '资产负债全景', '现金、持仓与贷款负债总览', 'api-read', 'wealth_overview', 'QUERY', 'L1', 'bank.wealth.holding.list', 'ready', false),
      action('buy', '申购理财', '选择产品与账户提交申购', 'api-command', 'wealth_order', 'CREATE', 'L2', 'bank.wealth.purchase.create', 'mock-only', true),
      faq('wealth'),
    ],
    'wealth:portfolio': [
      action('overview', '我的持仓', '理财、存款与基金持仓及收益', 'api-read', 'wealth_holding', 'QUERY', 'L1', 'bank.wealth.holding.list', 'ready', false),
      action('records', '申赎记录', '历史申购、赎回与到期记录', 'api-read', 'wealth_transaction', 'QUERY', 'L1', 'bank.wealth.transaction.list', 'mock-only', false),
      action('redeem', '赎回持仓', '赎回理财持仓资金', 'api-command', 'wealth_order', 'UPDATE', 'L2', 'bank.wealth.redeem.create', 'mock-only', true),
      faq('wealth'),
    ],
    'wealth:wealth-product': [
      action('overview', '产品列表', '建信理财在售产品与业绩基准', 'api-read', 'wealth_product', 'QUERY', 'L1', 'bank.wealth.product.list', 'ready', false),
      action('buy', '申购理财', '选择产品与账户提交申购', 'api-command', 'wealth_order', 'CREATE', 'L2', 'bank.wealth.purchase.create', 'ready', true),
      faq('wealth'),
    ],
    'wealth:deposit': [
      action('overview', '存款产品', '挂牌利率定期存款与大额存单', 'api-read', 'deposit_product', 'QUERY', 'L1', 'bank.wealth.product.list', 'ready', false),
      action('buy', '存入定期', '选择期限与账户办理存款', 'api-command', 'wealth_order', 'CREATE', 'L2', 'bank.wealth.purchase.create', 'mock-only', true),
      faq('wealth'),
    ],
    'wealth:fund': [
      action('overview', '基金产品', '代销基金与申购费率', 'api-read', 'fund_product', 'QUERY', 'L1', 'bank.wealth.product.list', 'ready', false),
      action('buy', '申购基金', '选择基金与账户提交申购', 'api-command', 'wealth_order', 'CREATE', 'L2', 'bank.wealth.purchase.create', 'mock-only', true),
      faq('wealth'),
    ],
    'wealth:dragon-money': [
      action('overview', '龙钱宝', '零钱理财持仓与申赎', 'api-read', 'wealth_holding', 'QUERY', 'L1', 'bank.wealth.holding.list', 'ready', false),
      action('buy', '申购龙钱宝', '零钱理财快速申购', 'api-command', 'wealth_order', 'CREATE', 'L2', 'bank.wealth.purchase.create', 'ready', true),
      action('auto-invest', '自动转入', '设置工资卡余额自动转入龙钱宝', 'api-command', 'auto_save', 'UPDATE', 'L2', null, 'mock-only', true),
      faq('wealth'),
    ],
    'wealth:income': [
      action('overview', '收益中心', '日、月、年多周期收益汇总', 'mock-view', 'wealth_income', 'QUERY', 'L0', null, 'mock-only', false),
      action('apply', '收益分析', '查看收益趋势与产品贡献分解', 'mock-view', 'wealth_income', 'APPLY', 'L1', null, 'mock-only', false),
      faq('wealth_income'),
    ],
    'wealth:four-money': [
      action('overview', '四笔钱', '按日常活钱、稳健理财、长期投资、保险保障分类', 'mock-view', 'wealth_allocation', 'QUERY', 'L0', null, 'mock-only', false),
      action('apply', '配置建议', '基于四笔钱框架的配置调整建议', 'mock-view', 'wealth_allocation', 'APPLY', 'L1', null, 'mock-only', false),
      faq('wealth_allocation'),
    ],
    'wealth:save': [
      action('overview', '嗖嗖攒', '消费后自动小额攒钱规则与累计金额', 'mock-view', 'auto_save', 'QUERY', 'L0', null, 'mock-only', false),
      action('setup', '设置攒钱规则', '设置攒钱比例、上限和扣款账户', 'api-command', 'auto_save', 'UPDATE', 'L2', null, 'mock-only', true),
      faq('auto_save'),
    ],
    'credit:auto-repay': [
      action('overview', '约定还款', '查询自动还款账户与还款方式', 'mock-view', 'credit_card_auto_repay', 'QUERY', 'L0', null, 'mock-only', false),
      action('setup', '设置约定还款', '选择还款账户和还款方式（全额/最低）', 'api-command', 'credit_card_auto_repay', 'UPDATE', 'L2', null, 'mock-only', true),
      faq('credit_card_auto_repay'),
    ],
    'home:utility': [
      action('overview', '待缴账单', '查询水、电、燃气与话费待缴账单', 'api-read', 'utility_bill', 'QUERY', 'L1', 'bank.utility.bill.list', 'mock-only', false),
      action('apply', '生活缴费', '选择缴费项目进入缴费流程', 'mock-view', 'utility_bill', 'APPLY', 'L1', null, 'mock-only', false),
      faq('utility_bill'),
    ],
    'life:social': [
      action('overview', '社保查询', '查询养老保险、医疗保险缴费基数与月数', 'mock-view', 'social_security', 'QUERY', 'L0', null, 'mock-only', false),
      action('apply', '电子社保卡', '申领或使用电子社保卡', 'mock-view', 'social_security', 'APPLY', 'L1', null, 'mock-only', false),
      faq('social_security'),
    ],
    'life:housing-fund': [
      action('overview', '公积金查询', '查询公积金余额、缴存明细与贷款信息', 'mock-view', 'housing_fund', 'QUERY', 'L0', null, 'mock-only', false),
      action('apply', '公积金业务', '提取申请与贷款查询', 'mock-view', 'housing_fund', 'APPLY', 'L1', null, 'mock-only', false),
      faq('housing_fund'),
    ],
    'me:messages': [
      action('overview', '消息中心', '账户变动、交易提醒与服务通知', 'mock-view', 'message', 'QUERY', 'L0', null, 'mock-only', false),
      action('apply', '消息设置', '管理消息推送偏好与免打扰', 'mock-view', 'message', 'APPLY', 'L1', null, 'mock-only', false),
      faq('message'),
    ],
    'me:income-expense': [
      action('overview', '收支分析', '月度收入、支出分类与结余趋势', 'mock-view', 'income_expense', 'QUERY', 'L0', null, 'mock-only', false),
      action('apply', '收支报告', '查看年度收支报告与消费画像', 'mock-view', 'income_expense', 'APPLY', 'L1', null, 'mock-only', false),
      faq('income_expense'),
    ],
    'credit:installment': [
      action('overview', '账单分期', '查询可分期金额、期数与手续费', 'mock-view', 'credit_card_installment', 'QUERY', 'L0', null, 'mock-only', false),
      action('apply', '申请分期', '选择分期期数与金额提交申请', 'mock-view', 'credit_card_installment', 'APPLY', 'L1', null, 'mock-only', false),
      faq('credit_card_installment'),
    ],
    'credit:points': [
      action('overview', '龙积分', '查询积分余额、获取途径与过期提醒', 'mock-view', 'credit_card_points', 'QUERY', 'L0', null, 'mock-only', false),
      action('apply', '积分兑换', '查看可兑换权益与商品', 'mock-view', 'credit_card_points', 'APPLY', 'L1', null, 'mock-only', false),
      faq('credit_card_points'),
    ],
    'wealth:insurance': [
      action('overview', '保险产品', '保障型与储蓄型保险产品', 'mock-view', 'insurance_product', 'QUERY', 'L0', null, 'mock-only', false),
      action('apply', '保险规划', '保障需求评估与产品推荐', 'mock-view', 'insurance_product', 'APPLY', 'L1', null, 'mock-only', false),
      faq('insurance_product'),
    ],
    'wealth:gold': [
      action('overview', '黄金积存', '积存金余额、金价行情与交易', 'mock-view', 'gold_product', 'QUERY', 'L0', null, 'mock-only', false),
      action('apply', '积存购买', '设置定期积存或买入黄金', 'mock-view', 'gold_product', 'APPLY', 'L1', null, 'mock-only', false),
      faq('gold_product'),
    ],
    'me:assets': [
      action('overview', '资产负债', '资产、负债与净资产总览', 'mock-view', 'asset_overview', 'QUERY', 'L0', null, 'mock-only', false),
      action('apply', '资产分析', '资产结构与配置建议', 'mock-view', 'asset_overview', 'APPLY', 'L1', null, 'mock-only', false),
      faq('asset_overview'),
    ],
    'me:calendar': [
      action('overview', '待办日历', '还款、存款到期与预约提醒', 'mock-view', 'calendar_todo', 'QUERY', 'L0', null, 'mock-only', false),
      action('apply', '添加提醒', '设置自定义提醒事项', 'mock-view', 'calendar_todo', 'APPLY', 'L1', null, 'mock-only', false),
      faq('calendar_todo'),
    ],
  };

  function action(id, title, description, kind, businessObject, actionName, riskLevel, capabilityId, readiness, requiresConfirm) {
    return {
      id: id,
      title: title,
      description: description,
      kind: kind,
      businessObject: businessObject,
      action: actionName,
      riskLevel: riskLevel,
      capabilityId: capabilityId,
      readiness: readiness,
      requiresConfirm: requiresConfirm,
    };
  }

  function faq(businessObject) {
    return action('faq', '常见问题', '查看办理条件、时效、费用和安全提示', 'faq', businessObject, 'EXPLAIN', 'L0', null, 'mock-only', false);
  }

  function defaultActions(item) {
    var objectName = String(item && item.id || 'service').replace(/[^a-z0-9-]/gi, '_');
    return [
      action('overview', '查询与管理', '查看当前状态、历史记录和相关信息', 'mock-view', objectName, 'QUERY', 'L0', null, 'mock-only', false),
      action('apply', '在线办理', '查看办理流程、条件和所需材料', 'unavailable', objectName, 'APPLY', 'L1', null, 'planned', false),
      faq(objectName),
    ];
  }

  function validateAction(input, channel, item) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('feature action must be an object');
    Object.keys(input).forEach(function (key) {
      if (ALLOWED_KEYS.indexOf(key) < 0) throw new TypeError('unknown feature action field: ' + key);
    });
    if (!/^[a-z][a-z0-9-]{0,47}$/.test(input.id)) throw new TypeError('invalid feature action id');
    if (!input.title || !input.description || !input.businessObject) throw new TypeError('incomplete feature action');
    if (KINDS.indexOf(input.kind) < 0 || ACTIONS.indexOf(input.action) < 0 || RISKS.indexOf(input.riskLevel) < 0 || READINESS.indexOf(input.readiness) < 0) {
      throw new TypeError('invalid feature action enum');
    }
    if (input.readiness === 'planned' && input.capabilityId) throw new TypeError('planned feature action cannot expose capability');
    var output = clone(input);
    output.key = String(channel) + '.' + String(item.id) + '.' + input.id;
    return output;
  }

  // 意图描述覆写表：key = channel:item:action。模板工厂（faq/defaultActions）产出的
  // 通用描述会让多条意图共享同一句 description，稀释语义召回与 LLM 裁决信号；
  // 覆写文本按菜单主题撰写"做什么+对象+边界"，构建期由 builder 强制跨意图唯一。
  var DESCRIPTION_OVERRIDES = {
    'home:account:faq': '解答账户查询与管理的常见问题,含余额、明细、账户状态与安全提示',
    'home:transfer:faq': '解答转账汇款的常见问题,含限额、手续费、到账时效与退回处理',
    'home:loan:faq': '解答贷款服务的常见问题,含可贷产品、测额规则、还款方式与逾期处理',
    'home:scan:overview': '查看扫一扫的付款与收款记录,管理扫码相关设置',
    'home:scan:faq': '解答扫一扫的常见问题,含扫码付款限额、到账与资金安全提示',
    'home:details:faq': '解答账户明细的常见问题,含交易记录查询区间、流水证明与入账时效',
    'home:repayment:repay': '从本人借记卡还款至本人或他人信用卡',
    'home:repayment:faq': '解答信用卡还款的常见问题,含到账时效、跨行还款与溢缴款处理',
    'home:utility:faq': '解答生活缴费的常见问题,含可缴公共事业费类目、代扣与发票',
    'home:limit:overview': '查看额度测算的历史结果与适用产品,管理测额相关设置',
    'home:limit:faq': '解答额度测算的常见问题,含测算口径、结果有效期与对正式审批的影响',
    'home:crossborder:overview': '查看跨境服务的可用功能与办理记录,管理跨境相关设置',
    'home:crossborder:faq': '解答跨境服务的常见问题,含购汇额度、汇款路径与合规要求',
    'home:fund:overview': '查看基金行情与自选基金,管理基金投资相关设置',
    'home:fund:faq': '解答首页基金投资的常见问题,含入口功能、行情查看与自选管理',
    'home:branch:overview': '查看附近网点的营业时间与排队情况,预约网点服务',
    'home:branch:faq': '解答网点服务的常见问题,含预约方式、所需证件与业务办理范围',
    'home:benefit:overview': '查看权益中心的权益发放与使用记录,管理首页权益',
    'home:benefit:faq': '解答权益中心的常见问题,含权益领取条件、有效期与使用规则',
    'home:calendar:overview': '查看待办日历的提醒事项与还款日程,管理待办提醒',
    'home:calendar:faq': '解答待办日历的常见问题,含提醒规则、日程同步与删除恢复',
    'home:pension:overview': '查看养老金融服务的账户信息与办理记录,管理养老相关设置',
    'home:pension:faq': '解答养老金融的常见问题,含养老金账户、产品选择与领取方式',
    'home:housing:overview': '查看住房服务的可用功能与办理进度,管理住房相关设置',
    'home:housing:faq': '解答住房服务的常见问题,含房贷、公积金与装修分期等办理咨询',
    'home:payroll:faq': '解答代发专区的常见问题,含发薪到账查询、工资理财与专属权益',
    'home:family:overview': '查看亲子服务的可用功能与办理记录,管理家庭成员相关设置',
    'home:family:faq': '解答亲子服务的常见问题,含子女账户、教育金与亲情卡功能',
    'home:social:overview': '查看社保服务的参保信息与办理记录,管理社保相关设置',
    'home:social:faq': '解答社保服务的常见问题,含电子社保卡、参保查询与缴费办理',
    'home:medical:overview': '查看医保服务的参保信息与使用记录,管理医保相关设置',
    'home:medical:faq': '解答医保服务的常见问题,含医保码使用、缴费查询与异地就医',
    'home:custom:overview': '查看我的应用的已添加功能与使用情况,管理首页自定义',
    'home:custom:faq': '解答我的应用的常见问题,含功能添加、排序与恢复默认布局',
    'credit:card-manage:faq': '解答卡片管理的常见问题,含卡片激活、密码设置、销户与安全用卡',
    'credit:bill:repay': '从本人借记卡一键偿还本期信用卡账单',
    'credit:bill:faq': '解答账单查询的常见问题,含出账日、未还金额、最低还款与到期日',
    'credit:repay:faq': '解答一键还款的常见问题,含还款试算、扣款顺序与到账时效',
    'credit:transactions:overview': '查看信用卡交易明细与入账状态,管理交易相关查询',
    'credit:transactions:faq': '解答信用卡交易明细的常见问题,含消费入账、退款与争议处理',
    'credit:installment:faq': '解答账单分期的常见问题,含可分期金额、期数费率与申请条件',
    'credit:cash-installment:overview': '查看现金分期的办理记录与可借额度,管理分期相关设置',
    'credit:cash-installment:faq': '解答现金分期的常见问题,含办理条件、额度、费用与到账时效',
    'credit:limit:overview': '查看额度管理的申请记录与当前进度,管理固定与临时额度',
    'credit:limit:faq': '解答额度管理的常见问题,含提额条件、临时额度与审核时效',
    'credit:auto-repay:faq': '解答约定还款的常见问题,含扣款规则、账户要求与扣款时间',
    'credit:apply:overview': '查看信用卡申请的办卡记录与附属卡信息,管理申卡相关设置',
    'credit:apply:faq': '解答申请信用卡的常见问题,含申请条件、卡片等级与资料准备',
    'credit:progress:overview': '查看办卡进度的申请记录与当前审核状态,管理办卡相关设置',
    'credit:progress:faq': '解答办卡进度的常见问题,含审核时长、寄卡进度与激活提醒',
    'credit:points:faq': '解答龙积分的常见问题,含积分累计规则、兑换比例与有效期',
    'credit:benefits:overview': '查看卡权益的发放与使用记录,管理信用卡相关权益',
    'credit:benefits:faq': '解答卡权益的常见问题,含权益内容、领取方式与适用卡片',
    'credit:security:overview': '查看支付安全的防护状态与开通记录,管理交易安全设置',
    'credit:security:faq': '解答支付安全的常见问题,含交易限额、风险防控与盗刷保障',
    'credit:cash:overview': '将信用卡授信额度以现金形式转入本人储蓄卡,查看现金转出办理记录与状态,管理现金转出',
    'credit:cash:faq': '解答现金转出的常见问题,含可转额度、手续费与到账时效',
    'credit:profile:overview': '查看信用卡资料管理的预留信息与更新记录,管理个人资料',
    'credit:profile:faq': '解答资料管理的常见问题,含预留手机号、账单地址修改与生效时间',
    'credit:service:overview': '查看信用卡客服的服务记录与常见入口,管理客服相关设置',
    'credit:service:faq': '解答信用卡客服的常见问题,含服务渠道、人工时段与投诉建议',
    'wealth:overview:buy': '在财富全景选择理财产品并提交申购',
    'wealth:overview:faq': '解答财富全景的常见问题,含资产总览口径、持仓归集与功能入口',
    'wealth:income:faq': '解答收益中心的常见问题,含收益统计口径、历史走势与对比规则',
    'wealth:four-money:faq': '解答四笔钱的常见问题,含活钱、保障、稳健与长钱四类配置逻辑',
    'wealth:dragon-money:faq': '解答龙钱宝1号的常见问题,含申购赎回规则、收益结算与快速取用',
    'wealth:save:faq': '解答嗖嗖攒的常见问题,含攒钱规则设置、扣款频率与资金去向',
    'wealth:easy-repay:overview': '查看轻松还的还款计划与扣款记录,管理自动还款安排',
    'wealth:easy-repay:faq': '解答轻松还的常见问题,含绑定卡要求、扣款顺序与还款提醒',
    'wealth:deposit:faq': '解答存款产品的常见问题,含定期利率、存期选择与提前支取规则',
    'wealth:wealth-product:buy': '挑选在售理财产品,选择资金账户提交申购',
    'wealth:wealth-product:faq': '解答理财产品的常见问题,含产品风险等级、申购费率与赎回规则',
    'wealth:fund:faq': '解答基金投资的常见问题,含申购赎回、费率优惠与分红方式',
    'wealth:insurance:faq': '解答保险的常见问题,含产品保障范围、投保条件与退保规则',
    'wealth:gold:faq': '解答黄金积存的常见问题,含积存起点、价格规则与赎回方式',
    'wealth:bond:overview': '查看债券产品的持仓与交易记录,管理债券投资相关设置',
    'wealth:bond:faq': '解答债券的常见问题,含可购品种、认购门槛与兑付方式',
    'wealth:fx:overview': '查看外汇买卖的行情与交易记录,管理外汇相关设置',
    'wealth:fx:faq': '解答外汇买卖的常见问题,含交易币种、报价方式与委托规则',
    'wealth:settlement:overview': '查看结售汇的办理记录与年度额度,管理购结汇相关设置',
    'wealth:settlement:faq': '解答结售汇的常见问题,含年度便利化额度、汇率与办理材料',
    'wealth:pension:overview': '查看个人养老金的账户信息与缴存记录,管理养老金相关设置',
    'wealth:pension:faq': '解答个人养老金的常见问题,含开户、缴存上限、税收优惠与领取',
    'wealth:portfolio:faq': '解答我的持仓的常见问题,含持仓成本、在途资金与订单状态',
    'wealth:favorites:overview': '查看我的关注的产品行情与动态,管理关注列表',
    'wealth:favorites:faq': '解答我的关注的常见问题,含关注方式、行情提醒与列表管理',
    'wealth:advisor:overview': '查看智能顾问的历史建议与配置方案,管理顾问相关设置',
    'wealth:advisor:faq': '解答智能顾问的常见问题,含建议生成逻辑、风险测评与调仓参考',
    'wealth:member:overview': '查看财富会员的等级与专属权益,管理会员相关服务',
    'wealth:member:faq': '解答财富会员的常见问题,含等级评定、权益领取与积分规则',
    'wealth:guide:overview': '查看新手宝典的学习记录与推荐内容,管理新手相关设置',
    'wealth:guide:faq': '解答新手宝典的常见问题,含理财入门课程、工具用法与风险须知',
    'life:mobile:overview': '查看话费充值的缴费记录与充值到账情况,管理话费相关设置',
    'life:mobile:faq': '解答话费充值的常见问题,含支持运营商、到账时效与优惠活动',
    'life:water:overview': '查看水费的待缴账单与历史缴费,管理水费户号相关设置',
    'life:water:faq': '解答水费缴纳的常见问题,含户号绑定、账单周期与代扣设置',
    'life:electric:overview': '查看电费的待缴账单与历史缴费,管理电费户号相关设置',
    'life:electric:faq': '解答电费缴纳的常见问题,含户号绑定、阶梯电价与代扣设置',
    'life:gas:overview': '查看燃气费的待缴账单与历史缴费,管理燃气户号相关设置',
    'life:gas:faq': '解答燃气费缴纳的常见问题,含户号绑定、账单出账与代扣设置',
    'life:heating:overview': '查看供暖费的待缴账单与历史缴费,管理供暖费相关设置',
    'life:heating:faq': '解答供暖费缴纳的常见问题,含缴费期、收费标准与发票开具',
    'life:property:overview': '查看物业费的待缴账单与历史缴费,管理物业费相关设置',
    'life:property:faq': '解答物业费缴纳的常见问题,含缴费标准、账单查询与发票开具',
    'life:social:faq': '解答社保的常见问题,含参保信息查询、缴费记录与电子社保卡',
    'life:medical:overview': '查看医保的余额与缴费明细,办理医保查询相关业务',
    'life:medical:faq': '解答医保的常见问题,含医保余额、缴费明细与就医结算查询',
    'life:housing-fund:faq': '解答公积金的常见问题,含缴存查询、提取条件与贷款额度',
    'life:government:overview': '查看政务服务的可用事项与办理记录,管理政务相关设置',
    'life:government:faq': '解答政务服务的常见问题,含可办事项、办事材料与进度查询',
    'life:movie:overview': '查看电影票的购票记录与场次信息,管理购票相关设置',
    'life:movie:faq': '解答电影票的常见问题,含选座购票、退改签规则与优惠券使用',
    'life:video:overview': '查看影音会员的订购记录与到期时间,管理会员自动续费',
    'life:video:faq': '解答影音会员的常见问题,含会员开通、续费管理与权益使用',
    'life:food:overview': '查看智慧就餐的订单与消费记录,管理就餐相关设置',
    'life:food:faq': '解答智慧就餐的常见问题,含就餐场景、支付方式与优惠活动',
    'life:travel:overview': '查看出行服务的订单与行程记录,管理出行相关设置',
    'life:travel:faq': '解答出行服务的常见问题,含购票入口、行程保障与优惠权益',
    'life:car:overview': '查看车主服务的用车记录与办理进度,管理车辆相关设置',
    'life:car:faq': '解答车主服务的常见问题,含违章代缴、加油优惠与洗车权益',
    'life:health:overview': '查看医疗健康的服务记录与预约信息,管理健康相关设置',
    'life:health:faq': '解答医疗健康的常见问题,含预约挂号、健康咨询与费用支付',
    'life:campus:overview': '查看校园教育的服务记录与办理进度,管理校园相关设置',
    'life:campus:faq': '解答校园教育的常见问题,含学费缴纳、校园卡与教育优惠',
    'life:coupon:overview': '查看领券中心的已领优惠券与使用状态,管理优惠券相关设置',
    'life:coupon:faq': '解答领券中心的常见问题,含领券条件、适用范围与有效期',
    'life:my-payment:overview': '查看我的缴费的待缴账单与缴费渠道,管理常用缴费项目',
    'life:my-payment:faq': '解答我的缴费的常见问题,含账单归集、缴费记录与代扣管理',
    'life:history:overview': '查看历史缴费记录与电子回单,管理缴费相关查询',
    'life:history:faq': '解答缴费记录的常见问题,含记录查询区间、电子回单与补打',
    'me:accounts:overview': '查看我的账户的银行卡列表与使用记录,管理账户相关设置',
    'me:accounts:faq': '解答我的账户的常见问题,含卡片展示、账户分类与安全隐藏',
    'me:cards:overview': '查看银行卡管理的卡片列表与状态,管理银行卡相关设置',
    'me:cards:faq': '解答银行卡管理的常见问题,含卡片挂失、限额调整与账户安全',
    'me:assets:faq': '解答资产负债的常见问题,含资产统计口径、负债归类与数据更新',
    'me:income-expense:faq': '解答收支分析的常见问题,含收支报告生成、分类规则与导出',
    'me:messages:faq': '解答消息中心的常见问题,含消息订阅、免打扰与历史消息查询',
    'me:calendar:faq': '解答我的日历的常见问题,含待办提醒、还款日程与同步规则',
    'me:tasks:overview': '查看任务中心的任务列表与完成进度,管理任务提醒',
    'me:tasks:faq': '解答任务中心的常见问题,含任务领取、奖励发放与有效期',
    'me:benefits:overview': '查看我的权益的持有情况与使用记录,管理权益兑换',
    'me:benefits:faq': '解答我的权益的常见问题,含权益查询、兑换流程与失效规则',
    'me:manager:overview': '查看客户经理的联系记录与服务安排,管理经理相关服务',
    'me:manager:faq': '解答客户经理的常见问题,含联系预约、服务范围与咨询方式',
    'me:branch:overview': '查看我的常用网点与预约记录,管理网点预约',
    'me:branch:faq': '解答我的网点的常见问题,含预约记录查询、改约与取消',
    'me:proof:overview': '查看证明服务的开立记录与文件列表,管理证明相关设置',
    'me:proof:faq': '解答证明服务的常见问题,含可开证明类型、申请流程与电子章效力',
    'me:address:overview': '查看收件地址的保存列表与使用记录,管理地址簿',
    'me:address:faq': '解答收件地址的常见问题,含地址新增修改、默认设置与删除',
    'me:security:overview': '查看安全中心的防护状态与安全事件记录,管理安全设置',
    'me:security:faq': '解答安全中心的常见问题,含登录保护、设备管理与风险检测',
    'me:privacy:overview': '查看隐私管理的授权记录与数据使用情况,管理隐私设置',
    'me:privacy:faq': '解答隐私管理的常见问题,含授权撤回、数据查询与个人信息保护',
    'me:settings:overview': '查看设置的配置项与最近变更,管理应用偏好',
    'me:settings:faq': '解答设置的常见问题,含通知开关、语言字体与功能偏好调整',
    'me:version:overview': '查看版本切换的可用版本与当前状态,管理版本偏好',
    'me:version:faq': '解答版本切换的常见问题,含标准版与长辈版差异、切换与恢复',
    'me:senior:overview': '查看长辈版的功能配置与使用状态,管理长辈版相关设置',
    'me:senior:faq': '解答长辈版的常见问题,含大字模式、常用功能配置与远程协助',
    'me:help:overview': '查看帮助与客服的服务记录与常见问题入口,管理客服相关设置',
    'me:help:faq': '解答帮助与客服的常见问题,含在线客服时段、热线电话与留言反馈',
    'me:about:overview': '查看关于与协议的版本记录与条款内容,管理协议相关设置',
    'me:about:faq': '解答关于与协议的常见问题,含服务协议、隐私政策与版本更新说明',
    'me:logout:overview': '查看安全退出的登录记录与设备状态,管理退出相关设置',
    'me:logout:faq': '解答安全退出的常见问题,含退出登录影响、设备登出与账号安全',
  };

  function listActions(channel, item) {
    if (!item || typeof item.id !== 'string' || !item.id) return [];
    var key = String(channel) + ':' + String(item.id);
    var definitions = EXPLICIT_ACTIONS[key] || defaultActions(item);
    return definitions.map(function (entry) {
      var override = DESCRIPTION_OVERRIDES[key + ':' + entry.id];
      if (!override) return validateAction(entry, channel, item);
      var patched = clone(entry);
      patched.description = override;
      return validateAction(patched, channel, item);
    });
  }

  function resolveAction(channel, item, actionId) {
    return listActions(channel, item).find(function (entry) { return entry.id === actionId; }) || null;
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  return { listActions: listActions, resolveAction: resolveAction };
});
