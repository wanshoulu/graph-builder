(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.AINativeBankModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var INITIAL_STATE = {
    customer: {
      id: 'CUST-MOCK-001',
      name: '陈先生',
      level: '财富会员',
      city: '上海'
    },
    accounts: [
      {
        id: 'account-salary-6217',
        name: '工资卡',
        type: '龙卡通',
        cardNo: '6217',
        available: 28640.36,
        balance: 28640.36,
        currency: 'CNY'
      },
      {
        id: 'account-saving-8032',
        name: '储蓄卡',
        type: '一类账户',
        cardNo: '8032',
        available: 75820,
        balance: 75820,
        currency: 'CNY'
      }
    ],
    creditCards: [
      {
        id: 'credit-8891',
        name: '全球支付卡',
        cardNo: '8891',
        amountDue: 6820,
        minimumDue: 682,
        dueDate: '09-18',
        limit: 60000,
        availableLimit: 45780
      }
    ],
    wealth: {
      totalAssets: 186420.36,
      yesterdayIncome: 32.18,
      monthIncome: 468.72,
      demand: 104460.36,
      steady: 61800,
      longTerm: 20160
    },
    benefits: {
      points: 12860,
      coupons: 6,
      pendingTasks: 2
    },
    utilities: [
      { id: 'gas-0829', name: '燃气费', amount: 126.8, period: '2026-08', status: 'unpaid' },
      { id: 'mobile-0829', name: '手机话费', amount: 100, period: '2026-08', status: 'unpaid' }
    ]
  };

  var CHANNEL_CATALOG = {
    home: {
      title: '首页',
      items: [
        { id: 'account', name: '账户查询', mark: '账', description: '余额、明细与账户管理', query: '查一下我的工资卡余额' },
        { id: 'transfer', name: '转账汇款', mark: '转', description: '境内转账与进度查询', query: '给张伟转账1000元' },
        { id: 'loan', name: '贷款服务', mark: '贷', description: '统一测额与贷款管理', query: '帮我做贷款统一测额' },
        { id: 'scan', name: '扫一扫', mark: '扫', description: '扫码支付与网点识别' },
        { id: 'details', name: '账户明细', mark: '明', description: '最长十五年账户明细' },
        { id: 'repayment', name: '信用卡还款', mark: '还', description: '本人及他人信用卡还款', query: '还本月信用卡' },
        { id: 'utility', name: '生活缴费', mark: '缴', description: '水、电、燃气与话费', query: '交本月燃气费' },
        { id: 'limit', name: '额度测算', mark: '额', description: '贷款额度模拟测算', query: '帮我做贷款统一测额' },
        { id: 'crossborder', name: '跨境服务', mark: '境', description: '汇款、结售汇与留学服务' },
        { id: 'fund', name: '基金投资', mark: '基', description: '基金筛选、持仓与定投' },
        { id: 'branch', name: '网点服务', mark: '点', description: '预约、取号与导航' },
        { id: 'benefit', name: '权益中心', mark: '权', description: '等级权益、积分与优惠券' },
        { id: 'calendar', name: '待办日历', mark: '日', description: '还款、存款到期与预约提醒' },
        { id: 'pension', name: '养老金融', mark: '养', description: '个人养老金与颐养服务' },
        { id: 'housing', name: '住房服务', mark: '房', description: '房贷、公积金与住房专区' },
        { id: 'payroll', name: '代发专区', mark: '薪', description: '工资单、薪享通与专属权益' },
        { id: 'family', name: '亲子服务', mark: '亲', description: '亲子账户与成长规划' },
        { id: 'social', name: '社保服务', mark: '社', description: '电子社保卡与缴费查询' },
        { id: 'medical', name: '医保服务', mark: '医', description: '医保凭证与账户查询' },
        { id: 'custom', name: '我的应用', mark: '+', description: '自定义首页常用功能' }
      ]
    },
    credit: {
      title: '信用卡',
      items: [
        { id: 'bill', name: '账单查询', mark: '账', description: '本期、历史与未出账单', query: '查信用卡账单' },
        { id: 'repay', name: '一键还款', mark: '还', description: '本人信用卡一键还款', query: '还本月信用卡' },
        { id: 'transactions', name: '交易明细', mark: '明', description: '消费、退款与入账进度', query: '查信用卡交易明细' },
        { id: 'installment', name: '账单分期', mark: '分', description: '账单分期与试算' },
        { id: 'cash-installment', name: '现金分期', mark: '现', description: '现金分期额度与办理' },
        { id: 'limit', name: '额度管理', mark: '额', description: '固定与临时额度申请' },
        { id: 'auto-repay', name: '约定还款', mark: '约', description: '自动还款账户与规则' },
        { id: 'card-manage', name: '卡片管理', mark: '卡', description: '激活、挂失、换卡与限额' },
        { id: 'apply', name: '申请信用卡', mark: '申', description: '主卡、附属卡与数字卡' },
        { id: 'progress', name: '办卡进度', mark: '进', description: '审核与邮寄进度查询' },
        { id: 'points', name: '龙积分', mark: '积', description: '积分查询与兑换' },
        { id: 'benefits', name: '卡权益', mark: '享', description: '机场、出行与商户权益' },
        { id: 'security', name: '支付安全', mark: '安', description: '交易限额与小额免密' },
        { id: 'cash', name: '现金转出', mark: '取', description: '信用额度现金转出' },
        { id: 'profile', name: '资料管理', mark: '资', description: '账单地址与个人资料' },
        { id: 'service', name: '信用卡客服', mark: '客', description: '智能客服与人工服务' }
      ]
    },
    wealth: {
      title: '财富',
      items: [
        { id: 'overview', name: '财富全景', mark: '全', description: '资产、负债与持仓全景', query: '分析一下我的资产配置' },
        { id: 'income', name: '收益中心', mark: '收', description: '日、月、年多周期收益' },
        { id: 'four-money', name: '四笔钱', mark: '四', description: '按资金用途进行配置' },
        { id: 'dragon-money', name: '龙钱宝1号', mark: '龙', description: '零钱管理与支付联动' },
        { id: 'save', name: '嗖嗖攒', mark: '攒', description: '消费后自动小额攒钱' },
        { id: 'easy-repay', name: '轻松还', mark: '轻', description: '还款资金归集与管理' },
        { id: 'deposit', name: '存款产品', mark: '存', description: '活期、定期与大额存单' },
        { id: 'wealth-product', name: '理财产品', mark: '理', description: '建信理财与代销理财' },
        { id: 'fund', name: '基金投资', mark: '基', description: '基金筛选、定投与持仓' },
        { id: 'insurance', name: '保险', mark: '保', description: '保障规划与保险产品' },
        { id: 'gold', name: '黄金积存', mark: '金', description: '黄金积存与实物金' },
        { id: 'bond', name: '债券', mark: '债', description: '储蓄国债与柜台债' },
        { id: 'fx', name: '外汇买卖', mark: '汇', description: '外币行情与交易' },
        { id: 'settlement', name: '结售汇', mark: '兑', description: '个人购汇与结汇' },
        { id: 'pension', name: '个人养老金', mark: '养', description: '开户、缴存与养老产品' },
        { id: 'portfolio', name: '我的持仓', mark: '持', description: '持仓、在途与订单' },
        { id: 'favorites', name: '我的关注', mark: '关', description: '自选产品与行情提醒' },
        { id: 'advisor', name: '智能顾问', mark: '顾', description: '财富体检与配置建议' },
        { id: 'member', name: '财富会员', mark: '会', description: '会员等级与专属服务' },
        { id: 'guide', name: '新手宝典', mark: '学', description: '财富知识与入门引导' }
      ]
    },
    life: {
      title: '生活',
      items: [
        { id: 'mobile', name: '话费充值', mark: '话', description: '手机充值与充值记录', query: '交100元手机话费' },
        { id: 'water', name: '水费', mark: '水', description: '水费查询与缴纳' },
        { id: 'electric', name: '电费', mark: '电', description: '电费查询与缴纳' },
        { id: 'gas', name: '燃气费', mark: '气', description: '燃气账单与缴纳', query: '交本月燃气费' },
        { id: 'heating', name: '供暖费', mark: '暖', description: '供暖账单与缴纳' },
        { id: 'property', name: '物业费', mark: '物', description: '物业账单与缴纳' },
        { id: 'social', name: '社保', mark: '社', description: '社保查询与电子社保卡' },
        { id: 'medical', name: '医保', mark: '医', description: '医保账户与电子凭证' },
        { id: 'housing-fund', name: '公积金', mark: '积', description: '余额、明细与贷款查询' },
        { id: 'government', name: '政务服务', mark: '政', description: '线上政务与证明服务' },
        { id: 'movie', name: '电影票', mark: '影', description: '影院选座与优惠购票' },
        { id: 'video', name: '影音会员', mark: '视', description: '主流影音会员充值' },
        { id: 'food', name: '智慧就餐', mark: '餐', description: '餐饮服务与优惠' },
        { id: 'travel', name: '出行服务', mark: '行', description: '机票、火车票与酒店' },
        { id: 'car', name: '车主服务', mark: '车', description: '加油、停车与罚款' },
        { id: 'health', name: '医疗健康', mark: '健', description: '挂号、体检与购药' },
        { id: 'campus', name: '校园教育', mark: '学', description: '学费与校园服务' },
        { id: 'coupon', name: '领券中心', mark: '券', description: '品牌券与本地优惠' },
        { id: 'my-payment', name: '我的缴费', mark: '我', description: '常用项目与缴费提醒' },
        { id: 'history', name: '缴费记录', mark: '记', description: '历史缴费与电子回单' }
      ]
    },
    me: {
      title: '我的',
      items: [
        { id: 'accounts', name: '我的账户', mark: '账', description: '银行卡与账户总览' },
        { id: 'cards', name: '银行卡管理', mark: '卡', description: '添加、解绑与账户设置' },
        { id: 'assets', name: '资产负债', mark: '资', description: '资产、负债与净资产' },
        { id: 'income-expense', name: '收支分析', mark: '析', description: '收支记录与月度报告' },
        { id: 'messages', name: '消息中心', mark: '信', description: '账户、交易与服务消息' },
        { id: 'calendar', name: '待办日历', mark: '日', description: '还款、到期与预约待办' },
        { id: 'tasks', name: '任务中心', mark: '任', description: '会员任务与奖励' },
        { id: 'benefits', name: '权益中心', mark: '权', description: '等级权益、积分与优惠券' },
        { id: 'manager', name: '客户经理', mark: '经', description: '在线联系专属客户经理' },
        { id: 'branch', name: '网点服务', mark: '点', description: '附近网点、预约与取号' },
        { id: 'proof', name: '证明服务', mark: '证', description: '流水与资信证明申请' },
        { id: 'address', name: '收件地址', mark: '址', description: '邮寄地址与邮箱管理' },
        { id: 'security', name: '安全中心', mark: '安', description: '设备、密码与交易安全' },
        { id: 'privacy', name: '隐私管理', mark: '隐', description: '授权、协议与个人信息' },
        { id: 'settings', name: '设置', mark: '设', description: '登录、通知与通用设置' },
        { id: 'version', name: '版本切换', mark: '版', description: '标准版、英文版等版本' },
        { id: 'senior', name: '长辈版', mark: '长', description: '大字、读屏与简化服务' },
        { id: 'help', name: '帮助与客服', mark: '客', description: '智能客服与问题反馈' },
        { id: 'about', name: '关于与协议', mark: '关', description: '版本信息与服务协议' },
        { id: 'logout', name: '安全退出', mark: '退', description: '退出当前登录会话' }
      ]
    }
  };

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function createInitialState() {
    return clone(INITIAL_STATE);
  }

  function getChannelCatalog() {
    return clone(CHANNEL_CATALOG);
  }

  function money(value) {
    return Math.round(Number(value || 0) * 100) / 100;
  }

  function extractAmount(query, fallback) {
    var match = String(query || '').match(/(?:转账?|转给|还款?|缴费|交)[^\d]{0,12}(\d+(?:\.\d{1,2})?)/);
    if (!match) match = String(query || '').match(/(\d+(?:\.\d{1,2})?)\s*(?:元|块)/);
    return match ? money(match[1]) : money(fallback || 0);
  }

  function extractRecipient(query) {
    var match = String(query || '').match(/给\s*([^，。,.\d]{1,12})\s*(?:转账?|转)/);
    return match ? match[1].trim() : '张伟';
  }

  function step(id, title, tool, status, detail) {
    return { id: id, title: title, tool: tool, status: status, detail: detail || '' };
  }

  function basePlan(query, code, name, domain, confidence, routeType, requiresConfirmation) {
    return {
      id: 'PLAN-' + Date.now(),
      query: String(query || '').trim(),
      source: 'local-fallback',
      intent: { code: code, name: name, domain: domain },
      confidence: confidence,
      routeType: routeType,
      requiresConfirmation: requiresConfirmation,
      steps: [],
      preview: {},
      safety: requiresConfirmation
        ? 'AI 只负责理解与编排，资金动作必须由本人确认并通过交易认证。'
        : '当前任务为只读查询，不产生资金变动。'
    };
  }

  function buildLocalPlan(query, inputState) {
    var state = inputState || createInitialState();
    var text = String(query || '').trim();
    var salary = state.accounts[0];
    var card = state.creditCards[0];
    var plan;

    if ((/工资卡|余额/.test(text) && /还.*信用卡|信用卡.*还|如果够/.test(text))) {
      plan = basePlan(text, 'conditional_credit_repayment', '条件式信用卡还款', '信用卡', 0.964, 'direct_execute', true);
      plan.preview = {
        fromAccount: salary.name + ' · ' + salary.cardNo,
        card: card.name + ' · ' + card.cardNo,
        available: salary.available,
        amount: card.amountDue,
        balanceAfter: money(salary.available - card.amountDue),
        conditionMet: salary.available >= card.amountDue
      };
      plan.steps = [
        step('balance', '查询工资卡可用余额', 'account.balance.get', 'completed', '可用余额 ¥' + salary.available.toFixed(2)),
        step('bill', '查询本期信用卡账单', 'credit.bill.current', 'completed', '本期待还 ¥' + card.amountDue.toFixed(2)),
        step('condition', '判断余额是否充足', 'rule.balance.compare', 'completed', plan.preview.conditionMet ? '条件满足' : '条件不满足'),
        step('repay', '创建信用卡还款交易', 'credit.repayment.create', 'awaiting_confirmation', '等待本人确认'),
        step('receipt', '返回交易回执', 'receipt.transaction.get', 'pending', '确认并执行后生成')
      ];
      return plan;
    }

    if (/还.*信用卡|信用卡.*还|还款/.test(text)) {
      plan = basePlan(text, 'credit_repayment', '信用卡还款', '信用卡', 0.951, 'direct_execute', true);
      plan.preview = {
        fromAccount: salary.name + ' · ' + salary.cardNo,
        card: card.name + ' · ' + card.cardNo,
        available: salary.available,
        amount: extractAmount(text, card.amountDue),
        balanceAfter: money(salary.available - extractAmount(text, card.amountDue))
      };
      plan.steps = [
        step('bill', '查询本期信用卡账单', 'credit.bill.current', 'completed', '本期待还 ¥' + card.amountDue.toFixed(2)),
        step('account', '选择还款账户', 'account.available.list', 'completed', salary.name + ' · ' + salary.cardNo),
        step('repay', '创建信用卡还款交易', 'credit.repayment.create', 'awaiting_confirmation', '等待本人确认'),
        step('receipt', '返回交易回执', 'receipt.transaction.get', 'pending')
      ];
      return plan;
    }

    if (/转账|转给|汇款/.test(text)) {
      var transferAmount = extractAmount(text, 1000);
      plan = basePlan(text, 'bank_transfer', '转账汇款', '支付', 0.943, 'direct_execute', true);
      plan.preview = {
        fromAccount: salary.name + ' · ' + salary.cardNo,
        recipient: extractRecipient(text),
        amount: transferAmount,
        balanceAfter: money(salary.available - transferAmount)
      };
      plan.steps = [
        step('recipient', '识别并核对收款人', 'transfer.recipient.resolve', 'completed', plan.preview.recipient),
        step('account', '选择付款账户', 'account.available.list', 'completed', plan.preview.fromAccount),
        step('risk', '执行交易风险预检', 'risk.transfer.precheck', 'completed', '当前未发现异常'),
        step('transfer', '创建转账交易', 'transfer.order.create', 'awaiting_confirmation', '等待本人确认'),
        step('receipt', '跟踪转账进度', 'transfer.progress.get', 'pending')
      ];
      return plan;
    }

    if (/缴费|燃气|水费|电费|话费|交.*费/.test(text)) {
      var bill = /话费/.test(text) ? state.utilities[1] : state.utilities[0];
      plan = basePlan(text, 'utility_payment', '生活缴费', '生活', 0.932, 'direct_execute', true);
      plan.preview = {
        fromAccount: salary.name + ' · ' + salary.cardNo,
        billId: bill.id,
        billName: bill.name,
        period: bill.period,
        amount: bill.amount,
        balanceAfter: money(salary.available - bill.amount)
      };
      plan.steps = [
        step('bill', '查询待缴账单', 'utility.bill.get', 'completed', bill.period + ' · ' + bill.name),
        step('account', '选择付款账户', 'account.available.list', 'completed', plan.preview.fromAccount),
        step('payment', '创建缴费交易', 'utility.payment.create', 'awaiting_confirmation', '等待本人确认'),
        step('receipt', '返回缴费结果', 'receipt.utility.get', 'pending')
      ];
      return plan;
    }

    if (/基金|理财|资产配置|财富|收益/.test(text)) {
      plan = basePlan(text, 'wealth_overview', '财富全景分析', '财富', 0.918, 'direct_answer', false);
      plan.preview = clone(state.wealth);
      plan.steps = [
        step('assets', '汇总资产与负债', 'wealth.overview.get', 'completed'),
        step('income', '分析阶段收益', 'wealth.income.analyze', 'completed'),
        step('allocation', '生成四笔钱视图', 'wealth.allocation.explain', 'completed')
      ];
      return plan;
    }

    if (/贷款|快贷|测额|借钱/.test(text)) {
      plan = basePlan(text, 'loan_measurement', '贷款统一测额', '信贷', 0.906, 'direct_execute', false);
      plan.preview = { estimatedLimit: 180000, products: ['快贷', '建信福贷'], note: '模拟测额结果，不构成授信承诺' };
      plan.steps = [
        step('profile', '读取客户授权信息', 'customer.profile.authorized', 'completed'),
        step('measure', '执行统一测额', 'loan.limit.measure', 'completed'),
        step('match', '匹配贷款方案', 'loan.product.match', 'completed')
      ];
      return plan;
    }

    if (/权益|积分|优惠券/.test(text)) {
      plan = basePlan(text, 'benefit_overview', '权益查询', '权益', 0.924, 'direct_answer', false);
      plan.preview = clone(state.benefits);
      plan.steps = [step('benefit', '查询等级权益与积分', 'benefit.overview.get', 'completed')];
      return plan;
    }

    plan = basePlan(text, 'account_balance_query', '账户余额查询', '账户', 0.936, 'direct_answer', false);
    plan.preview = {
      account: salary.name + ' · ' + salary.cardNo,
      balance: salary.available,
      currency: salary.currency
    };
    plan.steps = [
      step('identity', '校验当前登录客户', 'customer.session.verify', 'completed'),
      step('balance', '查询工资卡可用余额', 'account.balance.get', 'completed', '¥' + salary.available.toFixed(2))
    ];
    return plan;
  }

  function applyConfirmedPlan(inputState, plan) {
    var state = clone(inputState || createInitialState());
    if (!plan || !plan.requiresConfirmation) return state;

    var amount = money(plan.preview && plan.preview.amount);
    var account = state.accounts[0];
    if (amount <= 0 || amount > account.available) {
      throw new Error('模拟账户可用余额不足');
    }

    account.available = money(account.available - amount);
    account.balance = money(account.balance - amount);

    if (plan.intent.code === 'credit_repayment' || plan.intent.code === 'conditional_credit_repayment') {
      state.creditCards[0].amountDue = money(Math.max(0, state.creditCards[0].amountDue - amount));
      state.creditCards[0].availableLimit = money(Math.min(state.creditCards[0].limit, state.creditCards[0].availableLimit + amount));
    }

    if (plan.intent.code === 'utility_payment') {
      var bill = state.utilities.find(function (item) { return item.id === plan.preview.billId; });
      if (bill) bill.status = 'paid';
    }

    state.wealth.totalAssets = money(state.wealth.totalAssets - amount);
    state.wealth.demand = money(Math.max(0, state.wealth.demand - amount));
    return state;
  }

  return {
    createInitialState: createInitialState,
    getChannelCatalog: getChannelCatalog,
    buildLocalPlan: buildLocalPlan,
    applyConfirmedPlan: applyConfirmedPlan
  };
});
