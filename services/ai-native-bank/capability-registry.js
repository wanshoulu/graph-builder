'use strict';

const API_PREFIX = '/api/ai-bank/v1';

function objectSchema(properties, required) {
  return { type: 'object', additionalProperties: false, properties: properties || {}, required: required || [] };
}

function arraySchema(items) {
  return { type: 'array', items };
}

const identifier = { type: 'string', minLength: 1, maxLength: 64 };
const dateTime = { type: 'string', format: 'date-time' };
const nullableDateTime = { type: ['string', 'null'], format: 'date-time' };
const minorAmount = { type: 'integer', minimum: 1, description: 'Amount in minor currency units (fen)' };
const currency = { type: 'string', enum: ['CNY'] };
const money = objectSchema({ amountMinor: { type: 'integer' }, currency, formatted: { type: 'string' } }, ['amountMinor', 'currency', 'formatted']);
const account = objectSchema({
  id: identifier,
  name: { type: 'string' },
  type: { type: 'string' },
  maskedNo: { type: 'string' },
  status: { type: 'string' },
  currency,
}, ['id', 'name', 'type', 'maskedNo', 'status', 'currency']);
const payee = objectSchema({
  id: identifier,
  name: { type: 'string' },
  bankName: { type: 'string' },
  maskedNo: { type: 'string' },
  status: { type: 'string' },
}, ['id', 'name', 'bankName', 'maskedNo', 'status']);
const creditCard = objectSchema({
  id: identifier,
  maskedNo: { type: 'string' },
  productName: { type: 'string' },
  network: { type: 'string' },
  cardType: { type: 'string' },
  status: { type: 'string', enum: ['INACTIVE', 'ACTIVE', 'LOST'] },
  totalLimit: money,
  availableLimit: money,
  cashLimit: money,
  statementDay: { type: 'integer', minimum: 1, maximum: 31 },
  dueDay: { type: 'integer', minimum: 1, maximum: 31 },
  updatedAt: dateTime,
}, ['id', 'maskedNo', 'productName', 'network', 'cardType', 'status', 'totalLimit', 'availableLimit', 'cashLimit', 'statementDay', 'dueDay', 'updatedAt']);
const creditCardSettings = objectSchema({
  cardId: identifier,
  onlineTransactionsEnabled: { type: 'boolean' },
  contactlessEnabled: { type: 'boolean' },
  overseasEnabled: { type: 'boolean' },
  singleTransactionLimit: money,
  dailyLimit: money,
  updatedAt: dateTime,
}, ['cardId', 'onlineTransactionsEnabled', 'contactlessEnabled', 'overseasEnabled', 'singleTransactionLimit', 'dailyLimit', 'updatedAt']);
const transferOrder = objectSchema({
  id: identifier,
  fromAccountId: identifier,
  payeeId: identifier,
  amount: money,
  purpose: { type: 'string' },
  status: { type: 'string', enum: ['DRAFT', 'VALIDATED', 'PENDING_CONFIRMATION', 'AUTHORIZED', 'SUCCEEDED', 'FAILED', 'CANCELLED'] },
  balanceVersion: { type: 'integer', minimum: 1 },
  createdAt: dateTime,
  updatedAt: dateTime,
  executionId: { type: ['string', 'null'] },
}, ['id', 'fromAccountId', 'payeeId', 'amount', 'purpose', 'status', 'balanceVersion', 'createdAt', 'updatedAt']);
const execution = objectSchema({
  id: identifier,
  transferOrderId: identifier,
  status: { type: 'string', enum: ['SUCCEEDED', 'FAILED', 'PROCESSING'] },
  ledgerTransactionId: { type: ['string', 'null'] },
  receiptNo: { type: ['string', 'null'] },
  executedAt: nullableDateTime,
  failureCode: { type: ['string', 'null'] },
}, ['id', 'transferOrderId', 'status']);
// 转账回单查询的输出契约：在 execution 基础上附带收款人/付款账户/金额
// 脱敏详情，供 user_result.py receipt 投影直接渲染，避免再次反查目录。
const transferReceipt = objectSchema({
  id: identifier,
  transferOrderId: identifier,
  status: { type: 'string', enum: ['SUCCEEDED', 'FAILED', 'PROCESSING'] },
  ledgerTransactionId: { type: ['string', 'null'] },
  receiptNo: { type: ['string', 'null'] },
  executedAt: nullableDateTime,
  failureCode: { type: ['string', 'null'] },
  fromAccount: { type: ['object', 'null'] },
  payee: { type: ['object', 'null'] },
  amount: { type: ['object', 'null'] },
}, ['id', 'transferOrderId', 'status']);

const creditCardBill = objectSchema({
  cardId: identifier, productName: { type: 'string' }, maskedNo: { type: 'string' }, status: { type: 'string' },
  totalLimit: money, availableLimit: money, outstanding: money, minimumPayment: money,
  statementDay: { type: 'integer' }, dueDay: { type: 'integer' },
  billStatus: { type: 'string', enum: ['PAYMENT_DUE', 'SETTLED'] },
  note: { type: 'string' }, generatedAt: dateTime,
}, ['cardId', 'productName', 'maskedNo', 'status', 'totalLimit', 'availableLimit', 'outstanding', 'minimumPayment', 'statementDay', 'dueDay', 'billStatus', 'note', 'generatedAt']);

const creditCardRepayment = objectSchema({
  id: identifier, cardId: identifier, status: { type: 'string', enum: ['SUCCEEDED'] },
  paid: money, remainingOutstanding: money,
  fromAccount: objectSchema({ id: identifier, name: { type: 'string' }, maskedNo: { type: 'string' } }, ['id', 'name', 'maskedNo']),
  paidAt: dateTime,
}, ['id', 'cardId', 'status', 'paid', 'remainingOutstanding', 'fromAccount', 'paidAt']);

const wealthProduct = objectSchema({
  id: identifier, category: { type: 'string' }, name: { type: 'string' }, issuer: { type: 'string' },
  productCode: { type: 'string' }, riskLevel: { type: 'string' },
  minPurchase: money, minIncrement: money,
  termType: { type: 'string' }, termDays: { type: 'integer' },
  annualRateBp: { type: 'integer' }, rateType: { type: 'string' }, rateNote: { type: 'string' },
  purchaseChannel: { type: 'string' }, status: { type: 'string' }, features: arraySchema({ type: 'string' }),
}, ['id', 'category', 'name', 'issuer', 'productCode', 'riskLevel', 'minPurchase', 'minIncrement', 'termType', 'termDays', 'annualRateBp', 'rateType', 'rateNote', 'purchaseChannel', 'status', 'features']);

const wealthHolding = objectSchema({
  id: identifier, productName: { type: 'string' }, category: { type: 'string' },
  principal: money, currentValue: money, accumulatedEarnings: money,
  status: { type: 'string' }, openedAt: dateTime, maturesAt: nullableDateTime,
  lastValuedAt: dateTime, accountId: identifier,
}, ['id', 'productName', 'category', 'principal', 'currentValue', 'accumulatedEarnings', 'status', 'openedAt', 'maturesAt', 'lastValuedAt', 'accountId']);

const wealthTransaction = objectSchema({
  id: identifier, productName: { type: 'string' },
  direction: { type: 'string', enum: ['PURCHASE', 'REDEMPTION'] },
  amount: money, earnings: money, status: { type: 'string' }, occurredAt: dateTime,
}, ['id', 'productName', 'direction', 'amount', 'earnings', 'status', 'occurredAt']);

const wealthPurchase = objectSchema({
  id: identifier, orderId: identifier, holdingId: identifier,
  productId: identifier, productName: { type: 'string' },
  amount: money, accountId: identifier, status: { type: 'string' }, occurredAt: dateTime,
}, ['id', 'orderId', 'holdingId', 'productId', 'productName', 'amount', 'accountId', 'status', 'occurredAt']);

const wealthRedemption = objectSchema({
  orderId: identifier, holdingId: identifier,
  productId: identifier, productName: { type: 'string' },
  amount: money, earnings: money, accountId: identifier,
  status: { type: 'string' }, occurredAt: dateTime,
}, ['orderId', 'holdingId', 'productId', 'productName', 'amount', 'earnings', 'accountId', 'status', 'occurredAt']);

const salaryMonth = objectSchema({
  month: { type: 'string' }, income: money, expense: money, salary: money, wealthInvest: money,
}, ['month', 'income', 'expense', 'salary', 'wealthInvest']);

const salaryInsights = objectSchema({
  months: arraySchema(salaryMonth),
  monthlyAvgSalary: money, monthlyAvgExpense: money, monthlyAvgNet: money,
  wealthMonthlyInvest: money, paydayHint: { type: 'string' }, summary: { type: 'string' },
}, ['months', 'monthlyAvgSalary', 'monthlyAvgExpense', 'monthlyAvgNet', 'wealthMonthlyInvest', 'paydayHint', 'summary']);

const recommendationItem = objectSchema({
  productId: identifier, productName: { type: 'string' }, category: { type: 'string' },
  riskLevel: { type: 'string' }, annualRateBp: { type: 'integer' }, rateNote: { type: 'string' },
  suggestedAmount: money, tag: { type: 'string' }, reason: { type: 'string' },
}, ['productId', 'productName', 'category', 'riskLevel', 'annualRateBp', 'rateNote', 'suggestedAmount', 'tag', 'reason']);

const recommendations = objectSchema({
  profile: objectSchema({
    monthlyAvgSalary: money, monthlyAvgExpense: money, monthlyAvgNet: money,
    liquidAssets: money, emergencyTarget: money, monthsAnalyzed: { type: 'integer' },
  }, ['monthlyAvgSalary', 'monthlyAvgExpense', 'monthlyAvgNet', 'liquidAssets', 'emergencyTarget', 'monthsAnalyzed']),
  items: arraySchema(recommendationItem),
  generatedAt: dateTime, disclaimer: { type: 'string' },
}, ['profile', 'items', 'generatedAt', 'disclaimer']);

const wealthAdvisoryRecommendation = objectSchema({
  productId: identifier,
  productName: { type: 'string' },
  category: { type: 'string' },
  riskLevel: { type: 'string', enum: ['R1', 'R2', 'R3', 'R4', 'R5'] },
  annualRateBp: { type: 'integer', minimum: 0 },
  rateNote: { type: 'string' },
  termDays: { type: 'integer', minimum: 0 },
  liquidity: { type: 'string' },
  suitability: { type: 'string' },
  suggestedAmountRange: objectSchema({ minimum: money, maximum: money }, ['minimum', 'maximum']),
  reasons: arraySchema({ type: 'string', minLength: 1, maxLength: 240 }),
}, [
  'productId', 'productName', 'category', 'riskLevel', 'annualRateBp', 'rateNote',
  'termDays', 'liquidity', 'suitability', 'suggestedAmountRange', 'reasons',
]);

const wealthAdvisoryAllocation = objectSchema({
  productId: identifier,
  productName: { type: 'string', minLength: 1, maxLength: 120 },
  productCategory: { type: 'string', minLength: 1, maxLength: 40 },
  productCategoryLabel: { type: 'string', minLength: 1, maxLength: 40 },
  portfolioRole: { type: 'string', enum: ['core', 'liquidity', 'stable_floor', 'growth'] },
  portfolioRoleLabel: { type: 'string', minLength: 1, maxLength: 40 },
  amount: money,
  ratioBasisPoints: { type: 'integer', minimum: 1, maximum: 10000 },
  riskLevel: { type: 'string', enum: ['R1', 'R2', 'R3', 'R4', 'R5'] },
  termDays: { type: 'integer', minimum: 0 },
  liquidity: { type: 'string', minLength: 1, maxLength: 240 },
  suitability: { type: 'string', minLength: 1, maxLength: 240 },
  annualRateBp: { type: 'integer', minimum: 0 },
  rateNote: { type: 'string', maxLength: 400 },
  reasons: arraySchema({ type: 'string', minLength: 1, maxLength: 240 }),
}, [
  'productId', 'productName', 'productCategory', 'productCategoryLabel',
  'portfolioRole', 'portfolioRoleLabel', 'amount', 'ratioBasisPoints', 'riskLevel',
  'termDays', 'liquidity', 'suitability', 'annualRateBp', 'rateNote', 'reasons',
]);

const wealthAdvisoryPlan = objectSchema({
  planId: identifier,
  title: { type: 'string', minLength: 1, maxLength: 80 },
  summary: { type: 'string', minLength: 1, maxLength: 240 },
  kind: { type: 'string', enum: ['single_product', 'diversified'] },
  totalAmount: money,
  allocations: arraySchema(wealthAdvisoryAllocation),
  rationale: arraySchema({ type: 'string', minLength: 1, maxLength: 240 }),
}, ['planId', 'title', 'summary', 'kind', 'totalAmount', 'allocations', 'rationale']);

const nullableWealthAdvisoryPlan = { ...wealthAdvisoryPlan, type: ['object', 'null'] };

const wealthAdvisoryContext = objectSchema({
  recommendationStatus: {
    type: 'string',
    enum: ['ready', 'risk_assessment_required', 'preferences_required', 'no_suitable_products', 'no_suitable_plan'],
  },
  riskAssessment: objectSchema({
    status: { type: 'string', enum: ['VALID', 'MISSING', 'EXPIRED', 'INACTIVE'] },
    level: { type: 'string' },
    assessedAt: nullableDateTime,
    expiresAt: nullableDateTime,
    source: { type: 'string' },
  }, ['status', 'level', 'assessedAt', 'expiresAt', 'source']),
  profile: objectSchema({
    availableAssets: money,
    holdingValue: money,
    emergencyReserveTarget: money,
    monthlyAvgExpense: money,
    monthlyAvgNet: money,
    holdingCount: { type: 'integer', minimum: 0 },
    investmentTransactionCount: { type: 'integer', minimum: 0 },
    asOf: dateTime,
  }, [
    'availableAssets', 'holdingValue', 'emergencyReserveTarget', 'monthlyAvgExpense',
    'monthlyAvgNet', 'holdingCount', 'investmentTransactionCount', 'asOf',
  ]),
  preferences: objectSchema({
    investmentGoal: { type: 'string' },
    horizonMonths: { type: 'integer', minimum: 0 },
    plannedAmount: money,
    productScope: { type: 'string', enum: ['wealth_only', 'wealth_and_conservative_alternatives'] },
  }, ['investmentGoal', 'horizonMonths', 'plannedAmount', 'productScope']),
  missingPreferenceFields: arraySchema({ type: 'string' }),
  dataSources: arraySchema(objectSchema({
    kind: { type: 'string', enum: ['core_data', 'derived_profile', 'product_knowledge'] },
    source: { type: 'string' },
    status: { type: 'string' },
    recordCount: { type: 'integer', minimum: 0 },
    asOf: dateTime,
  }, ['kind', 'source', 'status', 'recordCount', 'asOf'])),
  requiredActions: arraySchema(objectSchema({
    code: { type: 'string' }, title: { type: 'string' }, message: { type: 'string' },
  }, ['code', 'title', 'message'])),
  recommendations: arraySchema(wealthAdvisoryRecommendation),
  primaryPlan: nullableWealthAdvisoryPlan,
  alternativePlans: arraySchema(wealthAdvisoryPlan),
  planMetrics: objectSchema({
    candidateCount: { type: 'integer', minimum: 0 },
    feasiblePlanCount: { type: 'integer', minimum: 0 },
    amountConserved: { type: 'boolean' },
  }, ['candidateCount', 'feasiblePlanCount', 'amountConserved']),
  generatedAt: dateTime,
  disclaimer: { type: 'string' },
}, [
  'recommendationStatus', 'riskAssessment', 'profile', 'preferences',
  'missingPreferenceFields', 'dataSources', 'requiredActions', 'recommendations',
  'generatedAt', 'disclaimer',
]);

const loanSummary = objectSchema({
  id: identifier, productName: { type: 'string' }, loanType: { type: 'string' },
  contractNo: { type: 'string' },
  principal: money, outstandingPrincipal: money,
  annualRatePercent: { type: 'string' }, annualRateBp: { type: 'integer' },
  rateType: { type: 'string' }, termMonths: { type: 'integer' }, remainingMonths: { type: 'integer' },
  repaymentMethod: { type: 'string' }, monthlyPayment: money, monthlyPaymentDay: { type: 'integer' },
  status: { type: 'string' }, disbursedAt: dateTime, settledAt: nullableDateTime,
  repaymentAccount: { type: ['object', 'null'] },
}, ['id', 'productName', 'loanType', 'contractNo', 'principal', 'outstandingPrincipal', 'annualRatePercent', 'annualRateBp', 'rateType', 'termMonths', 'remainingMonths', 'repaymentMethod', 'monthlyPayment', 'monthlyPaymentDay', 'status', 'disbursedAt', 'settledAt', 'repaymentAccount']);

const loanRepaymentItem = objectSchema({
  periodNo: { type: 'integer' }, dueDate: { type: 'string' },
  principal: money, interest: money, total: money,
  status: { type: 'string' }, paidAt: nullableDateTime,
}, ['periodNo', 'dueDate', 'principal', 'interest', 'total', 'status', 'paidAt']);

const loanPrecalculate = objectSchema({
  purpose: { type: 'string' },
  estimatedLimits: objectSchema({ kuaidai: money, jianyidai: money, renovation: money }, ['kuaidai', 'jianyidai', 'renovation']),
  basedOn: objectSchema({
    monthlyAvgIncome: money, monthlyObligation: money, monthlyDisposable: money, monthsAnalyzed: { type: 'integer' },
  }, ['monthlyAvgIncome', 'monthlyObligation', 'monthlyDisposable', 'monthsAnalyzed']),
  products: arraySchema(objectSchema({ productId: identifier, name: { type: 'string' }, rateNote: { type: 'string' } }, ['productId', 'name', 'rateNote'])),
  note: { type: 'string' }, calculatedAt: dateTime,
}, ['purpose', 'estimatedLimits', 'basedOn', 'products', 'note', 'calculatedAt']);

const compactMoney = objectSchema({ amountMinor: { type: 'integer', minimum: 0 }, currency }, ['amountMinor', 'currency']);
const evidenceFinding = objectSchema({
  kind: { type: 'string', enum: ['fact', 'rule_inference', 'model_hypothesis'] },
  code: { type: 'string' }, text: { type: 'string' }, sourceRefs: arraySchema({ type: 'string' }),
}, ['kind', 'code', 'text', 'sourceRefs']);
const obligationItem = objectSchema({
  id: identifier, type: { type: 'string', enum: ['credit_card', 'loan', 'utility'] },
  displayName: { type: 'string', minLength: 1, maxLength: 120 },
  amount: compactMoney, dueAt: { type: ['string', 'null'] },
  executionStatus: { type: 'string', enum: ['available', 'unavailable'] },
  sourceRefs: arraySchema({ type: 'string' }),
}, ['id', 'type', 'displayName', 'amount', 'dueAt', 'executionStatus', 'sourceRefs']);
const utilityBill = objectSchema({
  id: identifier, type: { type: 'string' }, name: { type: 'string' }, period: { type: 'string' },
  amount: money, dueDate: { type: 'string' }, status: { type: 'string', enum: ['UNPAID', 'PAID'] },
}, ['id', 'type', 'name', 'period', 'amount', 'dueDate', 'status']);
const paymentReceipt = objectSchema({
  id: identifier, accountId: identifier, status: { type: 'string', enum: ['SUCCEEDED'] },
  paid: money, paidAt: dateTime,
}, ['id', 'accountId', 'status', 'paid', 'paidAt']);

const CAPABILITIES = [
  define({
    id: 'bank.customer.profile.get', title: '客户资料查询', description: '读取当前客户的脱敏资料', domain: 'customer',
    exposure: 'model-callable', sideEffect: 'none', riskLevel: 'L0', scopes: ['customer:read'], method: 'GET', path: '/customers/me',
    input: objectSchema(),
    output: objectSchema({ id: identifier, displayName: { type: 'string' }, mobileMasked: { type: 'string' }, customerLevel: { type: 'string' } }, ['id', 'displayName', 'mobileMasked']),
    errors: ['not_found', 'forbidden'], example: { id: 'cust_demo_001', displayName: '张先生', mobileMasked: '138****8000', customerLevel: 'STANDARD' },
  }),
  define({
    id: 'bank.account.list', title: '账户列表查询', description: '列出当前客户可访问的银行账户', domain: 'account',
    exposure: 'model-callable', sideEffect: 'none', riskLevel: 'L0', scopes: ['account:read'], method: 'GET', path: '/accounts',
    input: objectSchema(), output: objectSchema({ accounts: arraySchema(account) }, ['accounts']), errors: ['forbidden'],
    example: { accounts: [{ id: 'acct_salary_6217', name: '工资卡', type: 'DEBIT', maskedNo: '****6217', status: 'ACTIVE', currency: 'CNY' }] },
  }),
  define({
    id: 'bank.account.detail.get', title: '账户详情查询', description: '读取指定账户的脱敏详情', domain: 'account',
    exposure: 'model-callable', sideEffect: 'none', riskLevel: 'L0', scopes: ['account:read'], method: 'GET', path: '/accounts/{accountId}',
    input: objectSchema({ accountId: identifier }, ['accountId']), output: account, errors: ['not_found', 'forbidden'],
    example: { id: 'acct_salary_6217', name: '工资卡', type: 'DEBIT', maskedNo: '****6217', status: 'ACTIVE', currency: 'CNY' },
  }),
  define({
    id: 'bank.account.balance.get', title: '账户余额查询', description: '读取指定账户的可用余额、账面余额和版本', domain: 'account',
    exposure: 'model-callable', sideEffect: 'none', riskLevel: 'L1', scopes: ['account:read'], method: 'GET', path: '/accounts/{accountId}/balance',
    input: objectSchema({ accountId: identifier }, ['accountId']),
    output: objectSchema({ accountId: identifier, available: money, ledger: money, version: { type: 'integer', minimum: 1 }, asOf: dateTime }, ['accountId', 'available', 'ledger', 'version', 'asOf']),
    errors: ['not_found', 'forbidden'], example: { accountId: 'acct_salary_6217', available: { amountMinor: 2864036, currency: 'CNY', formatted: '¥28,640.36' }, ledger: { amountMinor: 2864036, currency: 'CNY', formatted: '¥28,640.36' }, version: 1, asOf: '2026-08-29T10:00:00.000+08:00' },
  }),
  define({
    id: 'bank.account.transactions.list', title: '账户流水查询', description: '游标分页读取指定账户流水', domain: 'account',
    exposure: 'model-callable', sideEffect: 'none', riskLevel: 'L1', scopes: ['account:read'], method: 'GET', path: '/accounts/{accountId}/transactions',
    input: objectSchema({ accountId: identifier, cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, ['accountId']),
    output: objectSchema({ data: arraySchema(objectSchema({ id: identifier, direction: { type: 'string', enum: ['DEBIT', 'CREDIT'] }, amount: money, description: { type: 'string' }, postedAt: dateTime }, ['id', 'direction', 'amount', 'description', 'postedAt'])), meta: objectSchema({ hasNext: { type: 'boolean' }, nextCursor: { type: ['string', 'null'] }, limit: { type: 'integer' } }, ['hasNext', 'nextCursor', 'limit']) }, ['data', 'meta']),
    errors: ['not_found', 'forbidden', 'validation_error'], example: { data: [], meta: { hasNext: false, nextCursor: null, limit: 20 } },
  }),
  define({
    id: 'bank.payee.list', title: '收款方列表查询', description: '列出当前客户可使用的脱敏常用收款方', domain: 'transfer',
    exposure: 'model-callable', sideEffect: 'none', riskLevel: 'L1', scopes: ['payee:read'], method: 'GET', path: '/payees',
    input: objectSchema(), output: objectSchema({ payees: arraySchema(payee) }, ['payees']), errors: ['forbidden'],
    example: { payees: [{ id: 'payee_zhangsan_7319', name: '张三', bankName: '中国建设银行', maskedNo: '****7319', status: 'ACTIVE' }] },
  }),
  define({
    id: 'bank.payee.validate', title: '收款方校验', description: '校验客户常用收款方状态和银行信息', domain: 'transfer',
    exposure: 'model-callable', sideEffect: 'none', riskLevel: 'L1', scopes: ['payee:read'], method: 'POST', path: '/payee-validations',
    input: objectSchema({ payeeId: identifier }, ['payeeId']),
    output: objectSchema({ payeeId: identifier, valid: { type: 'boolean' }, status: { type: 'string' }, bankName: { type: 'string' }, maskedNo: { type: 'string' }, checkedAt: dateTime }, ['payeeId', 'valid', 'status', 'checkedAt']),
    errors: ['not_found', 'payee_unavailable', 'idempotency_conflict'], example: { payeeId: 'payee_zhang_4321', valid: true, status: 'ACTIVE', bankName: '中国建设银行', maskedNo: '****4321', checkedAt: '2026-08-29T10:00:00.000+08:00' },
  }),
  define({
    id: 'bank.transfer.order.create', title: '创建转账指令', description: '创建不产生资金移动的转账草稿', domain: 'transfer',
    exposure: 'model-callable', sideEffect: 'state-change', riskLevel: 'L1', scopes: ['transfer:create'], method: 'POST', path: '/transfer-orders',
    input: objectSchema({ fromAccountId: identifier, payeeId: identifier, amountMinor: minorAmount, currency, purpose: { type: 'string', minLength: 1, maxLength: 40 } }, ['fromAccountId', 'payeeId', 'amountMinor', 'currency']),
    output: transferOrder, errors: ['validation_error', 'not_found', 'idempotency_conflict'],
    example: orderExample('DRAFT'),
  }),
  define({
    id: 'bank.transfer.order.validate', title: '校验转账指令', description: '检查账户、余额、限额、收款方和费用', domain: 'transfer',
    exposure: 'model-callable', sideEffect: 'state-change', riskLevel: 'L1', scopes: ['transfer:create'], method: 'POST', path: '/transfer-orders/{transferOrderId}/validations',
    input: objectSchema({ transferOrderId: identifier }, ['transferOrderId']),
    output: objectSchema({ id: identifier, transferOrderId: identifier, result: { type: 'string', enum: ['PASSED', 'FAILED'] }, checks: arraySchema({ type: 'string' }), fee: money, balanceAfter: money, expiresAt: dateTime }, ['id', 'transferOrderId', 'result', 'checks', 'fee', 'balanceAfter', 'expiresAt']),
    errors: ['not_found', 'state_conflict', 'insufficient_funds', 'idempotency_conflict'], example: { id: 'validation_001', transferOrderId: 'transfer_001', result: 'PASSED', checks: ['account', 'balance', 'payee'], fee: moneyExample(0, '¥0.00'), balanceAfter: moneyExample(2854036, '¥28,540.36'), expiresAt: '2026-08-29T10:05:00.000+08:00' },
  }),
  define({
    id: 'bank.transfer.confirmation.request', title: '请求转账确认', description: '生成脱敏确认摘要和一次性确认挑战', domain: 'transfer',
    exposure: 'model-callable', sideEffect: 'state-change', riskLevel: 'L2', scopes: ['transfer:create'], method: 'POST', path: '/transfer-orders/{transferOrderId}/confirmation-challenges',
    input: objectSchema({ transferOrderId: identifier }, ['transferOrderId']),
    output: objectSchema({ id: identifier, transferOrderId: identifier, status: { type: 'string', enum: ['PENDING_CONFIRMATION'] }, summary: { type: 'object' }, confirmationToken: { type: 'string', minLength: 16, sensitive: true }, expiresAt: dateTime }, ['id', 'transferOrderId', 'status', 'summary', 'confirmationToken', 'expiresAt']),
    errors: ['not_found', 'state_conflict', 'validation_expired', 'idempotency_conflict'], example: { id: 'challenge_001', transferOrderId: 'transfer_001', status: 'PENDING_CONFIRMATION', summary: { amount: '¥100.00', payee: '张三（****4321）' }, confirmationToken: '<one-time-token>', expiresAt: '2026-08-29T10:05:00.000+08:00' },
  }),
  define({
    id: 'bank.transfer.confirmation.invalidate', title: '使转账确认失效', description: '由受控系统使活动确认挑战永久失效', domain: 'transfer',
    exposure: 'system-only', sideEffect: 'state-change', riskLevel: 'L2', scopes: ['transfer:control'], method: 'POST', path: '/confirmation-challenges/{challengeId}/invalidations',
    input: objectSchema({ challengeId: identifier, reason: { type: 'string', minLength: 1, maxLength: 64 } }, ['challengeId', 'reason']),
    output: objectSchema({ id: identifier, challengeId: identifier, status: { type: 'string', enum: ['INVALIDATED'] }, invalidatedAt: dateTime, reason: { type: 'string' } }, ['id', 'challengeId', 'status', 'invalidatedAt', 'reason']),
    errors: ['not_found', 'state_conflict', 'idempotency_conflict'], example: { id: 'invalidation_001', challengeId: 'challenge_001', status: 'INVALIDATED', invalidatedAt: '2026-08-29T10:01:00.000+08:00', reason: 'order_cancelled' },
  }),
  define({
    id: 'bank.transfer.authorize', title: '用户授权转账', description: '由明确用户交互提交一次性确认令牌', domain: 'transfer',
    exposure: 'user-action', sideEffect: 'state-change', riskLevel: 'L2', scopes: ['transfer:authorize'], method: 'POST', path: '/transfer-orders/{transferOrderId}/authorizations',
    input: objectSchema({ transferOrderId: identifier, challengeId: identifier, confirmationToken: { type: 'string', minLength: 16, maxLength: 256 } }, ['transferOrderId', 'challengeId', 'confirmationToken']),
    output: objectSchema({ id: identifier, transferOrderId: identifier, challengeId: identifier, status: { type: 'string', enum: ['AUTHORIZED'] }, authorizedAt: dateTime }, ['id', 'transferOrderId', 'challengeId', 'status', 'authorizedAt']),
    errors: ['forbidden', 'confirmation_expired', 'invalid_confirmation_token', 'confirmation_summary_changed', 'idempotency_conflict'], example: { id: 'authorization_001', transferOrderId: 'transfer_001', challengeId: 'challenge_001', status: 'AUTHORIZED', authorizedAt: '2026-08-29T10:02:00.000+08:00' },
  }),
  define({
    id: 'bank.transfer.execute', title: '执行已授权转账', description: '系统执行引擎对已授权指令进行最终记账', domain: 'transfer',
    exposure: 'system-only', sideEffect: 'money-movement', riskLevel: 'L3', scopes: ['transfer:execute'], method: 'POST', path: '/transfer-orders/{transferOrderId}/executions',
    input: objectSchema({ transferOrderId: identifier }, ['transferOrderId']), output: execution,
    errors: ['forbidden', 'state_conflict', 'authorization_missing', 'account_version_conflict', 'insufficient_funds', 'idempotency_conflict'], example: executionExample(),
  }),
  define({
    id: 'bank.transfer.order.cancel', title: '取消未授权转账指令', description: '取消未授权转账指令并使活动确认失效', domain: 'transfer',
    exposure: 'model-callable', sideEffect: 'state-change', riskLevel: 'L1', scopes: ['transfer:create'], method: 'POST', path: '/transfer-orders/{transferOrderId}/cancellations',
    input: objectSchema({ transferOrderId: identifier }, ['transferOrderId']),
    output: objectSchema({ id: identifier, transferOrderId: identifier, status: { type: 'string', enum: ['CANCELLED'] }, cancelledAt: dateTime }, ['id', 'transferOrderId', 'status', 'cancelledAt']),
    errors: ['not_found', 'state_conflict', 'idempotency_conflict'], example: { id: 'cancellation_001', transferOrderId: 'transfer_001', status: 'CANCELLED', cancelledAt: '2026-08-29T10:01:00.000+08:00' },
  }),
  define({
    id: 'bank.transfer.status.get', title: '转账状态查询', description: '查询转账指令当前状态', domain: 'transfer',
    exposure: 'model-callable', sideEffect: 'none', riskLevel: 'L1', scopes: ['transfer:read'], method: 'GET', path: '/transfer-orders/{transferOrderId}',
    input: objectSchema({ transferOrderId: identifier }, ['transferOrderId']), output: transferOrder,
    errors: ['not_found', 'forbidden'], example: orderExample('AUTHORIZED'),
  }),
  define({
    id: 'bank.transfer.receipt.get', title: '转账回单查询', description: '查询成功执行结果和电子回单', domain: 'transfer',
    exposure: 'model-callable', sideEffect: 'none', riskLevel: 'L1', scopes: ['transfer:read'], method: 'GET', path: '/transfer-executions/{executionId}',
    input: objectSchema({ executionId: identifier }, ['executionId']), output: transferReceipt,
    errors: ['not_found', 'forbidden'], example: executionExample(),
  }),
  define({
    id: 'bank.credit-card.list', title: '信用卡列表查询', description: '查询当前客户的脱敏信用卡列表', domain: 'credit-card',
    exposure: 'model-callable', sideEffect: 'none', riskLevel: 'L0', scopes: ['credit-card:read'], method: 'GET', path: '/credit-cards',
    input: objectSchema(), output: objectSchema({ cards: arraySchema(creditCard) }, ['cards']), errors: ['forbidden'],
    example: { cards: [creditCardExample()] },
  }),
  define({
    id: 'bank.credit-card.detail.get', title: '信用卡详情查询', description: '查询指定信用卡的脱敏详情和额度', domain: 'credit-card',
    exposure: 'model-callable', sideEffect: 'none', riskLevel: 'L1', scopes: ['credit-card:read'], method: 'GET', path: '/credit-cards/{cardId}',
    input: objectSchema({ cardId: identifier }, ['cardId']), output: creditCard, errors: ['not_found', 'forbidden'], example: creditCardExample(),
  }),
  define({
    id: 'bank.credit-card.transactions.list', title: '信用卡交易明细查询', description: '分页查询指定信用卡的交易明细', domain: 'credit-card',
    exposure: 'model-callable', sideEffect: 'none', riskLevel: 'L1', scopes: ['credit-card:read'], method: 'GET', path: '/credit-cards/{cardId}/transactions',
    input: objectSchema({ cardId: identifier, cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, ['cardId']),
    output: objectSchema({ data: arraySchema(objectSchema({ id: identifier, direction: { type: 'string', enum: ['DEBIT', 'CREDIT'] }, amount: money, description: { type: 'string' }, status: { type: 'string' }, occurredAt: dateTime }, ['id', 'direction', 'amount', 'description', 'status', 'occurredAt'])), meta: objectSchema({ hasNext: { type: 'boolean' }, nextCursor: { type: ['string', 'null'] }, limit: { type: 'integer' } }, ['hasNext', 'nextCursor', 'limit']) }, ['data', 'meta']),
    errors: ['not_found', 'forbidden', 'validation_error'], example: { data: [], meta: { hasNext: false, nextCursor: null, limit: 20 } },
  }),
  define({
    id: 'bank.credit-card.settings.get', title: '信用卡安全设置查询', description: '查询指定信用卡的交易安全设置', domain: 'credit-card',
    exposure: 'model-callable', sideEffect: 'none', riskLevel: 'L1', scopes: ['credit-card:read'], method: 'GET', path: '/credit-cards/{cardId}/settings',
    input: objectSchema({ cardId: identifier }, ['cardId']), output: creditCardSettings, errors: ['not_found', 'forbidden'], example: creditCardSettingsExample(),
  }),
  define({
    id: 'bank.credit-card.activation.create', title: '信用卡激活', description: '由用户确认后激活未激活信用卡', domain: 'credit-card',
    exposure: 'user-action', sideEffect: 'state-change', riskLevel: 'L2', scopes: ['credit-card:manage'], method: 'POST', path: '/credit-cards/{cardId}/activations',
    input: objectSchema({ cardId: identifier }, ['cardId']), output: objectSchema({ id: identifier, cardId: identifier, status: { type: 'string', enum: ['ACTIVE'] }, activatedAt: dateTime }, ['id', 'cardId', 'status', 'activatedAt']), errors: ['forbidden', 'not_found', 'state_conflict', 'idempotency_conflict'],
    example: { id: 'card_activation_demo', cardId: 'credit_digital_2268', status: 'ACTIVE', activatedAt: '2026-08-30T10:00:00.000+08:00' },
  }),
  define({
    id: 'bank.credit-card.loss-report.create', title: '信用卡挂失', description: '由用户确认后挂失激活信用卡', domain: 'credit-card',
    exposure: 'user-action', sideEffect: 'state-change', riskLevel: 'L2', scopes: ['credit-card:manage'], method: 'POST', path: '/credit-cards/{cardId}/loss-reports',
    input: objectSchema({ cardId: identifier, reason: { type: 'string', enum: ['CARD_MISSING', 'STOLEN', 'DAMAGED'] } }, ['cardId', 'reason']), output: objectSchema({ id: identifier, cardId: identifier, status: { type: 'string', enum: ['LOST'] }, reason: { type: 'string' }, reportedAt: dateTime }, ['id', 'cardId', 'status', 'reason', 'reportedAt']), errors: ['forbidden', 'not_found', 'state_conflict', 'validation_error', 'idempotency_conflict'],
    example: { id: 'card_loss_demo', cardId: 'credit_global_8891', status: 'LOST', reason: 'CARD_MISSING', reportedAt: '2026-08-30T10:00:00.000+08:00' },
  }),
  define({
    id: 'bank.credit-card.limit-change.create', title: '信用卡额度调整申请', description: '由用户确认后提交信用卡额度调整申请', domain: 'credit-card',
    exposure: 'user-action', sideEffect: 'state-change', riskLevel: 'L2', scopes: ['credit-card:manage'], method: 'POST', path: '/credit-cards/{cardId}/limit-change-requests',
    input: objectSchema({ cardId: identifier, requestedLimitMinor: { type: 'integer', minimum: 100000, maximum: 50000000 } }, ['cardId', 'requestedLimitMinor']), output: objectSchema({ id: identifier, cardId: identifier, requestedLimit: money, status: { type: 'string', enum: ['PENDING_REVIEW'] }, submittedAt: dateTime }, ['id', 'cardId', 'requestedLimit', 'status', 'submittedAt']), errors: ['forbidden', 'not_found', 'state_conflict', 'validation_error', 'idempotency_conflict'],
    example: { id: 'card_limit_demo', cardId: 'credit_global_8891', requestedLimit: moneyExample(8000000, '¥80,000.00'), status: 'PENDING_REVIEW', submittedAt: '2026-08-30T10:00:00.000+08:00' },
  }),
  define({
    id: 'bank.credit-card.security-settings.update', title: '信用卡安全设置更新', description: '由用户确认后更新信用卡交易安全设置', domain: 'credit-card',
    exposure: 'user-action', sideEffect: 'state-change', riskLevel: 'L2', scopes: ['credit-card:manage'], method: 'PUT', path: '/credit-cards/{cardId}/security-settings',
    input: objectSchema({ cardId: identifier, onlineTransactionsEnabled: { type: 'boolean' }, contactlessEnabled: { type: 'boolean' }, overseasEnabled: { type: 'boolean' }, singleTransactionLimitMinor: { type: 'integer' }, dailyLimitMinor: { type: 'integer' } }, ['cardId', 'onlineTransactionsEnabled', 'contactlessEnabled', 'overseasEnabled', 'singleTransactionLimitMinor', 'dailyLimitMinor']), output: objectSchema({ id: identifier, cardId: identifier, status: { type: 'string', enum: ['UPDATED'] }, settings: creditCardSettings, updatedAt: dateTime }, ['id', 'cardId', 'status', 'settings', 'updatedAt']), errors: ['forbidden', 'not_found', 'state_conflict', 'validation_error', 'idempotency_conflict'],
    example: { id: 'card_settings_demo', cardId: 'credit_global_8891', status: 'UPDATED', settings: creditCardSettingsExample(), updatedAt: '2026-08-30T10:00:00.000+08:00' },
  }),
  define({
    id: 'bank.credit-card.bill.get', title: '信用卡账单查询', description: '查询指定信用卡的本期账单、未还金额和最低还款额', domain: 'credit-card',
    exposure: 'model-callable', sideEffect: 'none', riskLevel: 'L1', scopes: ['credit-card:read'], method: 'GET', path: '/credit-cards/{cardId}/bill',
    input: objectSchema({ cardId: identifier }, ['cardId']),
    output: creditCardBill,
    errors: ['not_found', 'forbidden'], example: creditCardBillExample(),
  }),
  define({
    id: 'bank.credit-card.repayment.create', title: '信用卡还款', description: '由用户确认后从借记卡还款至信用卡', domain: 'credit-card',
    exposure: 'user-action', sideEffect: 'state-change', riskLevel: 'L2', scopes: ['credit-card:manage'], method: 'POST', path: '/credit-cards/{cardId}/repayments',
    input: objectSchema({ cardId: identifier, fromAccountId: identifier, amountMinor: minorAmount }, ['cardId', 'fromAccountId', 'amountMinor']),
    output: creditCardRepayment,
    errors: ['forbidden', 'not_found', 'insufficient_funds', 'state_conflict', 'idempotency_conflict'],
    example: creditCardRepaymentExample(),
  }),
  define({
    id: 'bank.wealth.product.list', title: '理财产品列表查询', description: '查询在售理财、存款与基金产品', domain: 'wealth',
    exposure: 'model-callable', sideEffect: 'none', riskLevel: 'L1', scopes: ['wealth:read'], method: 'GET', path: '/financial-products',
    input: objectSchema({ category: { type: 'string' }, riskLevel: { type: 'string' } }, []),
    output: objectSchema({ products: arraySchema(wealthProduct) }, ['products']),
    errors: ['forbidden'], example: { products: [wealthProductExample()] },
  }),
  define({
    id: 'bank.wealth.product.detail.get', title: '理财产品详情查询', description: '查询指定理财产品的详细信息', domain: 'wealth',
    exposure: 'model-callable', sideEffect: 'none', riskLevel: 'L1', scopes: ['wealth:read'], method: 'GET', path: '/financial-products/{productId}',
    input: objectSchema({ productId: identifier }, ['productId']),
    output: wealthProduct,
    errors: ['not_found', 'forbidden'], example: wealthProductExample(),
  }),
  define({
    id: 'bank.wealth.holding.list', title: '理财持仓查询', description: '查询当前客户的理财持仓总览与收益', domain: 'wealth',
    exposure: 'model-callable', sideEffect: 'none', riskLevel: 'L1', scopes: ['wealth:read'], method: 'GET', path: '/wealth/holdings',
    input: objectSchema(),
    output: objectSchema({
      holdingCount: { type: 'integer' }, totalValue: money, totalPrincipal: money, totalEarnings: money,
      holdings: arraySchema(wealthHolding),
    }, ['holdingCount', 'totalValue', 'totalPrincipal', 'totalEarnings', 'holdings']),
    errors: ['forbidden'], example: { holdingCount: 1, totalValue: moneyExample(512500, '¥5,125.00'), totalPrincipal: moneyExample(500000, '¥5,000.00'), totalEarnings: moneyExample(12500, '¥125.00'), holdings: [wealthHoldingExample()] },
  }),
  define({
    id: 'bank.wealth.transaction.list', title: '理财申赎记录查询', description: '查询历史申购与赎回记录', domain: 'wealth',
    exposure: 'model-callable', sideEffect: 'none', riskLevel: 'L1', scopes: ['wealth:read'], method: 'GET', path: '/wealth/transactions',
    input: objectSchema(),
    output: objectSchema({ data: arraySchema(wealthTransaction) }, ['data']),
    errors: ['forbidden'], example: { data: [] },
  }),
  define({
    id: 'bank.wealth.salary-insights.get', title: '发薪收支画像', description: '基于近一年工资流水生成月度收支画像', domain: 'wealth',
    exposure: 'model-callable', sideEffect: 'none', riskLevel: 'L1', scopes: ['wealth:read'], method: 'GET', path: '/wealth/salary-insights',
    input: objectSchema(),
    output: salaryInsights,
    errors: ['forbidden'], example: { months: [], monthlyAvgSalary: moneyExample(1500000, '¥15,000.00'), monthlyAvgExpense: moneyExample(800000, '¥8,000.00'), monthlyAvgNet: moneyExample(700000, '¥7,000.00'), wealthMonthlyInvest: moneyExample(200000, '¥2,000.00'), paydayHint: '每月20日', summary: '近12个月收支稳定' },
  }),
  define({
    id: 'bank.wealth.recommendations.get', title: '理财配置建议', description: '基于收支画像生成理财配置推荐', domain: 'wealth',
    exposure: 'model-callable', sideEffect: 'none', riskLevel: 'L1', scopes: ['wealth:read'], method: 'GET', path: '/wealth/recommendations',
    input: objectSchema(),
    output: recommendations,
    errors: ['forbidden'], example: { profile: { monthlyAvgSalary: moneyExample(1500000, '¥15,000.00'), monthlyAvgExpense: moneyExample(800000, '¥8,000.00'), monthlyAvgNet: moneyExample(700000, '¥7,000.00'), liquidAssets: moneyExample(2864036, '¥28,640.36'), emergencyTarget: moneyExample(2400000, '¥24,000.00'), monthsAnalyzed: 12 }, items: [], generatedAt: '2026-09-01T10:00:00.000+08:00', disclaimer: '建议仅供参考' },
  }),
  define({
    id: 'bank.wealth.advisory.context.get', title: '财富建议上下文',
    description: '聚合当前风险测评、资金、持仓、投资历史与产品知识并执行适当性筛选', domain: 'wealth',
    exposure: 'model-callable', sideEffect: 'none', riskLevel: 'L1', scopes: ['wealth:read'],
    method: 'GET', path: '/wealth/advisory-context',
    input: objectSchema({
      investmentGoal: { type: 'string', enum: ['capital_preservation', 'steady_growth', 'long_term_growth'] },
      horizonMonths: { type: 'integer', minimum: 1, maximum: 600 },
      plannedAmountMinor: { type: 'integer', minimum: 100, maximum: 1000000000 },
      productScope: { type: 'string', enum: ['wealth_only', 'wealth_and_conservative_alternatives'] },
    }, []),
    output: wealthAdvisoryContext,
    errors: ['forbidden', 'validation_error'],
    example: {
      recommendationStatus: 'preferences_required',
      riskAssessment: { status: 'VALID', level: 'C2', assessedAt: '2026-03-12T01:30:00.000Z', expiresAt: '2027-03-12T15:59:59.000Z', source: 'CORE_WEALTH_SUITABILITY' },
      profile: { availableAssets: moneyExample(2864036, '¥28,640.36'), holdingValue: moneyExample(2002650, '¥20,026.50'), emergencyReserveTarget: moneyExample(2400000, '¥24,000.00'), monthlyAvgExpense: moneyExample(800000, '¥8,000.00'), monthlyAvgNet: moneyExample(700000, '¥7,000.00'), holdingCount: 1, investmentTransactionCount: 3, asOf: '2026-09-06T02:00:00.000Z' },
      preferences: { investmentGoal: '', horizonMonths: 0, plannedAmount: moneyExample(0, '¥0.00'), productScope: 'wealth_and_conservative_alternatives' },
      missingPreferenceFields: ['investmentGoal', 'horizonMonths'],
      dataSources: [], requiredActions: [], recommendations: [],
      generatedAt: '2026-09-06T02:00:00.000Z', disclaimer: '建议仅供参考',
    },
  }),
  define({
    id: 'bank.wealth.purchase.create', title: '理财申购', description: '由用户确认后提交理财申购', domain: 'wealth',
    exposure: 'user-action', sideEffect: 'state-change', riskLevel: 'L2', scopes: ['wealth:manage'], method: 'POST', path: '/wealth/purchases',
    input: objectSchema({ productId: identifier, accountId: identifier, amountMinor: minorAmount }, ['productId', 'accountId', 'amountMinor']),
    output: wealthPurchase,
    errors: ['forbidden', 'not_found', 'insufficient_funds', 'state_conflict', 'validation_error', 'idempotency_conflict'],
    example: wealthPurchaseExample(),
  }),
  define({
    id: 'bank.wealth.redeem.create', title: '理财赎回', description: '由用户确认后提交理财赎回', domain: 'wealth',
    exposure: 'user-action', sideEffect: 'state-change', riskLevel: 'L2', scopes: ['wealth:manage'], method: 'POST', path: '/wealth/redemptions',
    input: objectSchema({ holdingId: identifier }, ['holdingId']),
    output: wealthRedemption,
    errors: ['forbidden', 'not_found', 'state_conflict', 'validation_error', 'idempotency_conflict'],
    example: wealthRedemptionExample(),
  }),
  define({
    id: 'bank.loan.list', title: '贷款列表查询', description: '查询当前客户的贷款总览与待还余额', domain: 'loan',
    exposure: 'model-callable', sideEffect: 'none', riskLevel: 'L1', scopes: ['loan:read'], method: 'GET', path: '/loans',
    input: objectSchema(),
    output: objectSchema({ data: arraySchema(loanSummary), totalOutstanding: money, monthlyObligation: money }, ['data', 'totalOutstanding', 'monthlyObligation']),
    errors: ['forbidden'], example: { data: [loanSummaryExample()], totalOutstanding: moneyExample(1500000, '¥15,000.00'), monthlyObligation: moneyExample(169750, '¥1,697.50') },
  }),
  define({
    id: 'bank.loan.detail.get', title: '贷款详情查询', description: '查询指定贷款的合同信息与还款计划', domain: 'loan',
    exposure: 'model-callable', sideEffect: 'none', riskLevel: 'L1', scopes: ['loan:read'], method: 'GET', path: '/loans/{loanId}',
    input: objectSchema({ loanId: identifier }, ['loanId']),
    output: loanSummary,
    errors: ['not_found', 'forbidden'], example: loanSummaryExample(),
  }),
  define({
    id: 'bank.loan.repayment.list', title: '贷款还款计划查询', description: '查询指定贷款的分期还款计划', domain: 'loan',
    exposure: 'model-callable', sideEffect: 'none', riskLevel: 'L1', scopes: ['loan:read'], method: 'GET', path: '/loans/{loanId}/repayments',
    input: objectSchema({ loanId: identifier }, ['loanId']),
    output: objectSchema({ loanId: identifier, productName: { type: 'string' }, data: arraySchema(loanRepaymentItem) }, ['loanId', 'productName', 'data']),
    errors: ['not_found', 'forbidden'], example: { loanId: 'loan_kuaidai_001', productName: '建行快贷', data: [] },
  }),
  define({
    id: 'bank.loan.precalculate.create', title: '贷款额度测算', description: '基于代发工资流水进行统一额度测算', domain: 'loan',
    exposure: 'model-callable', sideEffect: 'none', riskLevel: 'L1', scopes: ['loan:read'], method: 'POST', path: '/loans/precalculations',
    input: objectSchema({ purpose: { type: 'string', enum: ['CONSUMPTION', 'RENOVATION', 'HOUSING'] } }, ['purpose']),
    output: loanPrecalculate,
    errors: ['validation_error'], example: loanPrecalculateExample(),
  }),
  define({
    id: 'bank.cashflow.salary-plan.get', title: '工资月度安排', description: '依据工资、刚性支出与预算策略生成可解释的月度资金安排', domain: 'cashflow',
    exposure: 'model-callable', sideEffect: 'none', riskLevel: 'L1', scopes: ['cashflow:read'], method: 'GET', path: '/cashflow/salary-plan',
    input: objectSchema(), output: objectSchema({ salary: compactMoney, availableBalance: compactMoney, totalObligations: compactMoney, mandatoryObligations: compactMoney, plannedRepayment: compactMoney, uncoveredObligations: compactMoney, livingBudget: compactMoney, emergencyReserve: compactMoney, allocatable: compactMoney, obligationItems: arraySchema(objectSchema({ id: identifier, type: { type: 'string', enum: ['credit_card', 'loan', 'utility'] }, displayName: { type: 'string' }, amountMinor: { type: 'integer', minimum: 1 }, dueAt: { type: ['string', 'null'] }, executionStatus: { type: 'string', enum: ['available', 'unavailable'] }, sourceRefs: arraySchema({ type: 'string' }) }, ['id', 'type', 'displayName', 'amountMinor', 'dueAt', 'executionStatus', 'sourceRefs'])), supplementaryAccounts: arraySchema(objectSchema({ accountId: identifier, accountName: { type: 'string' }, availableMinor: { type: 'integer', minimum: 0 }, currency: { type: 'string' } }, ['accountId', 'accountName', 'availableMinor', 'currency'])), items: arraySchema(objectSchema({ id: identifier, amountMinor: { type: 'integer', minimum: 0 }, sourceRefs: arraySchema({ type: 'string' }) }, ['id', 'amountMinor', 'sourceRefs'])), generatedAt: dateTime }, ['salary', 'availableBalance', 'totalObligations', 'mandatoryObligations', 'plannedRepayment', 'uncoveredObligations', 'livingBudget', 'emergencyReserve', 'allocatable', 'obligationItems', 'supplementaryAccounts', 'items', 'generatedAt']),
    errors: ['cashflow_source_missing', 'cashflow_provider_invalid'], example: { salary: { amountMinor: 1860000, currency: 'CNY' }, availableBalance: { amountMinor: 2864036, currency: 'CNY' }, totalObligations: { amountMinor: 2311186, currency: 'CNY' }, mandatoryObligations: { amountMinor: 2311186, currency: 'CNY' }, plannedRepayment: { amountMinor: 2064036, currency: 'CNY' }, uncoveredObligations: { amountMinor: 247150, currency: 'CNY' }, livingBudget: { amountMinor: 500000, currency: 'CNY' }, emergencyReserve: { amountMinor: 300000, currency: 'CNY' }, allocatable: { amountMinor: 0, currency: 'CNY' }, obligationItems: [{ id: 'card_bill_202609', type: 'credit_card', displayName: '龙卡账单', amountMinor: 1422000, dueAt: '2026-09-18', executionStatus: 'available', sourceRefs: ['card_bill_202609'] }], supplementaryAccounts: [{ accountId: 'acct_saving_8032', accountName: '储蓄卡', availableMinor: 7582000, currency: 'CNY' }], items: [{ id: 'planned_repayment', amountMinor: 2064036, sourceRefs: ['card_bill_202609'] }], generatedAt: '2026-09-03T08:00:00.000Z' },
  }),
  define({
    id: 'bank.cashflow.spending-analysis.get', title: '资金去向分析', description: '剔除内部划转并冲减退款后解释指定月份的净支出变化', domain: 'cashflow',
    exposure: 'model-callable', sideEffect: 'none', riskLevel: 'L1', scopes: ['cashflow:read'], method: 'GET', path: '/cashflow/spending-analysis',
    input: objectSchema({ period: { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' } }, ['period']), output: objectSchema({ period: { type: 'string' }, comparisonPeriod: { type: 'string' }, current: objectSchema({ netExpenseMinor: { type: 'integer', minimum: 0 } }, ['netExpenseMinor']), previous: objectSchema({ netExpenseMinor: { type: 'integer', minimum: 0 } }, ['netExpenseMinor']), excluded: objectSchema({ internalTransferMinor: { type: 'integer', minimum: 0 }, refundMinor: { type: 'integer', minimum: 0 } }, ['internalTransferMinor', 'refundMinor']), categories: arraySchema(objectSchema({ category: { type: 'string', pattern: '^[A-Za-z0-9_]{1,40}$' }, currentMinor: { type: 'integer', minimum: 0 }, previousMinor: { type: 'integer', minimum: 0 }, deltaMinor: { type: 'integer' } }, ['category', 'currentMinor', 'previousMinor', 'deltaMinor'])), findings: arraySchema(evidenceFinding), generatedAt: dateTime }, ['period', 'comparisonPeriod', 'current', 'previous', 'excluded', 'categories', 'findings', 'generatedAt']),
    errors: ['cashflow_query_invalid', 'cashflow_provider_invalid'], example: { period: '2026-08', comparisonPeriod: '2026-07', current: { netExpenseMinor: 190000 }, previous: { netExpenseMinor: 90000 }, excluded: { internalTransferMinor: 200000, refundMinor: 30000 }, findings: [{ kind: 'fact', code: 'NET_EXPENSE_TOTAL', text: '净支出事实', sourceRefs: ['txn_food'] }], generatedAt: '2026-09-03T08:00:00.000Z' },
  }),
  define({
    id: 'bank.obligation.list', title: '统一待还查询', description: '汇总信用卡、贷款与生活缴费的当前待处理义务', domain: 'obligation', exposure: 'model-callable', sideEffect: 'none', riskLevel: 'L1', scopes: ['obligation:read'], method: 'GET', path: '/obligations', input: objectSchema(), output: objectSchema({ accountId: identifier, availableBalance: compactMoney, items: arraySchema(obligationItem), total: compactMoney, generatedAt: dateTime }, ['accountId', 'availableBalance', 'items', 'total', 'generatedAt']), errors: ['obligation_input_invalid'], example: { accountId: 'acct_salary_6217', availableBalance: { amountMinor: 2864036, currency: 'CNY' }, items: [{ id: 'utility_due_202609', type: 'utility', displayName: '电费 · 2026-09', amount: { amountMinor: 50000, currency: 'CNY' }, dueAt: '2026-09-09', executionStatus: 'available', sourceRefs: ['utility_due_202609'] }], total: { amountMinor: 50000, currency: 'CNY' }, generatedAt: '2026-09-03T08:00:00.000Z' },
  }),
  define({
    id: 'bank.loan.repayment.create', title: '贷款还款', description: '经客户本人确认后支付指定一期贷款', domain: 'loan', exposure: 'user-action', sideEffect: 'money-movement', riskLevel: 'L2', scopes: ['loan:repay'], method: 'POST', path: '/loans/repayments', input: objectSchema({ repaymentId: identifier, fromAccountId: identifier, amountMinor: minorAmount }, ['repaymentId', 'fromAccountId', 'amountMinor']), output: objectSchema(Object.assign({ repaymentId: identifier, loanId: identifier }, paymentReceipt.properties), ['id', 'repaymentId', 'loanId', 'accountId', 'status', 'paid', 'paidAt']), errors: ['loan_repayment_not_found', 'loan_repayment_changed', 'insufficient_funds'], example: { id: 'loan_repay_001', repaymentId: 'lrp_001', loanId: 'loan_mortgage_001', accountId: 'acct_salary_6217', status: 'SUCCEEDED', paid: moneyExample(250000, '¥2,500.00'), paidAt: '2026-09-03T08:00:00.000Z' },
  }),
  define({
    id: 'bank.utility.bill.list', title: '生活缴费账单查询', description: '查询客户名下水电燃气等生活缴费账单', domain: 'utility', exposure: 'model-callable', sideEffect: 'none', riskLevel: 'L1', scopes: ['utility:read'], method: 'GET', path: '/utility-bills', input: objectSchema(), output: objectSchema({ data: arraySchema(utilityBill) }, ['data']), errors: ['not_found', 'forbidden'], example: { data: [{ id: 'utility_due_202609', type: 'ELECTRICITY', name: '电费', period: '2026-09', amount: moneyExample(50000, '¥500.00'), dueDate: '2026-09-09', status: 'UNPAID' }] },
  }),
  define({
    id: 'bank.utility.payment.create', title: '生活缴费', description: '经客户本人确认后从指定账户支付生活缴费账单', domain: 'utility', exposure: 'user-action', sideEffect: 'money-movement', riskLevel: 'L2', scopes: ['utility:pay'], method: 'POST', path: '/utility-payments', input: objectSchema({ billId: identifier, accountId: identifier }, ['billId', 'accountId']), output: objectSchema(Object.assign({ billId: identifier, receiptNo: { type: 'string' } }, paymentReceipt.properties), ['id', 'billId', 'accountId', 'status', 'receiptNo', 'paid', 'paidAt']), errors: ['utility_bill_unavailable', 'insufficient_funds', 'idempotency_conflict'], example: { id: 'utility_payment_001', billId: 'utility_due_202609', accountId: 'acct_salary_6217', status: 'SUCCEEDED', receiptNo: 'UTILITY-20260903-00000001', paid: moneyExample(50000, '¥500.00'), paidAt: '2026-09-03T08:00:00.000Z' },
  }),
];

function moneyExample(amountMinor, formatted) {
  return { amountMinor, currency: 'CNY', formatted };
}

function orderExample(status) {
  return { id: 'transfer_001', fromAccountId: 'acct_salary_6217', payeeId: 'payee_zhang_4321', amount: moneyExample(10000, '¥100.00'), purpose: '餐费', status, balanceVersion: 1, createdAt: '2026-08-29T10:00:00.000+08:00', updatedAt: '2026-08-29T10:02:00.000+08:00' };
}

function executionExample() {
  return { id: 'execution_001', transferOrderId: 'transfer_001', status: 'SUCCEEDED', ledgerTransactionId: 'ledger_001', receiptNo: 'RCPT-20260829100200-ABC123', executedAt: '2026-08-29T10:02:00.000+08:00', failureCode: null };
}

function creditCardExample() {
  return { id: 'credit_global_8891', maskedNo: '****8891', productName: '龙卡全球支付卡', network: 'UNIONPAY', cardType: 'CREDIT', status: 'ACTIVE', totalLimit: moneyExample(5000000, '¥50,000.00'), availableLimit: moneyExample(4632800, '¥46,328.00'), cashLimit: moneyExample(2500000, '¥25,000.00'), statementDay: 15, dueDay: 5, updatedAt: '2026-08-30T10:00:00.000+08:00' };
}

function creditCardSettingsExample() {
  return { cardId: 'credit_global_8891', onlineTransactionsEnabled: true, contactlessEnabled: true, overseasEnabled: false, singleTransactionLimit: moneyExample(500000, '¥5,000.00'), dailyLimit: moneyExample(2000000, '¥20,000.00'), updatedAt: '2026-08-30T10:00:00.000+08:00' };
}

function creditCardBillExample() {
  return { cardId: 'credit_global_8891', productName: '龙卡全球支付卡', maskedNo: '****8891', status: 'ACTIVE', totalLimit: moneyExample(5000000, '¥50,000.00'), availableLimit: moneyExample(4632800, '¥46,328.00'), outstanding: moneyExample(367200, '¥3,672.00'), minimumPayment: moneyExample(36720, '¥367.20'), statementDay: 15, dueDay: 5, billStatus: 'PAYMENT_DUE', note: '本期账单已生成，请在到期日前还款', generatedAt: '2026-09-01T10:00:00.000+08:00' };
}

function creditCardRepaymentExample() {
  return { id: 'repayment_001', cardId: 'credit_global_8891', status: 'SUCCEEDED', paid: moneyExample(367200, '¥3,672.00'), remainingOutstanding: moneyExample(0, '¥0.00'), fromAccount: { id: 'acct_salary_6217', name: '工资卡', maskedNo: '****6217' }, paidAt: '2026-09-01T10:05:00.000+08:00' };
}

function wealthProductExample() {
  return { id: 'wp_jianxin_dayi_001', category: '理财', name: '建信乾元安鑫日日盈', issuer: '建信理财', productCode: 'JXAYY001', riskLevel: 'R2', minPurchase: moneyExample(1000, '¥10.00'), minIncrement: moneyExample(100, '¥1.00'), termType: 'OPEN', termDays: 0, annualRateBp: 350, rateType: 'FLOATING', rateNote: '七日年化收益率 3.50%', purchaseChannel: 'MOBILE', status: 'ON_SALE', features: ['T+0赎回', '随时存取'] };
}

function wealthHoldingExample() {
  return { id: 'wh_demo_001', productName: '建信乾元安鑫日日盈', category: '理财', principal: moneyExample(500000, '¥5,000.00'), currentValue: moneyExample(512500, '¥5,125.00'), accumulatedEarnings: moneyExample(12500, '¥125.00'), status: 'ACTIVE', openedAt: '2026-06-01T10:00:00.000+08:00', maturesAt: null, lastValuedAt: '2026-09-01T10:00:00.000+08:00', accountId: 'acct_salary_6217' };
}

function wealthPurchaseExample() {
  return { id: 'wp_order_001', orderId: 'order_001', holdingId: 'wh_demo_001', productId: 'wp_jianxin_dayi_001', productName: '建信乾元安鑫日日盈', amount: moneyExample(100000, '¥1,000.00'), accountId: 'acct_salary_6217', status: 'CONFIRMED', occurredAt: '2026-09-01T10:05:00.000+08:00' };
}

function wealthRedemptionExample() {
  return { orderId: 'redeem_001', holdingId: 'wh_demo_001', productId: 'wp_jianxin_dayi_001', productName: '建信乾元安鑫日日盈', amount: moneyExample(512500, '¥5,125.00'), earnings: moneyExample(12500, '¥125.00'), accountId: 'acct_salary_6217', status: 'SETTLED', occurredAt: '2026-09-01T10:10:00.000+08:00' };
}

function loanSummaryExample() {
  return { id: 'loan_kuaidai_001', productName: '建行快贷', loanType: 'CONSUMPTION', contractNo: 'KL20260101001', principal: moneyExample(2000000, '¥20,000.00'), outstandingPrincipal: moneyExample(1500000, '¥15,000.00'), annualRatePercent: '4.35', annualRateBp: 435, rateType: 'FIXED', termMonths: 12, remainingMonths: 9, repaymentMethod: 'EQUAL_INSTALLMENT', monthlyPayment: moneyExample(169750, '¥1,697.50'), monthlyPaymentDay: 20, status: 'ACTIVE', disbursedAt: '2026-03-01T10:00:00.000+08:00', settledAt: null, repaymentAccount: { id: 'acct_salary_6217', name: '工资卡', maskedNo: '****6217' } };
}

function loanPrecalculateExample() {
  return { purpose: 'CONSUMPTION', estimatedLimits: { kuaidai: moneyExample(3000000, '¥30,000.00'), jianyidai: moneyExample(5000000, '¥50,000.00'), renovation: moneyExample(2000000, '¥20,000.00') }, basedOn: { monthlyAvgIncome: moneyExample(1500000, '¥15,000.00'), monthlyObligation: moneyExample(169750, '¥1,697.50'), monthlyDisposable: moneyExample(1330250, '¥13,302.50'), monthsAnalyzed: 12 }, products: [{ productId: 'loan_kuaidai', name: '建行快贷', rateNote: '年利率 4.35%' }, { productId: 'loan_jianyidai', name: '建易贷', rateNote: '年利率 4.75%' }], note: '以上额度为预估值，最终以审批为准', calculatedAt: '2026-09-01T10:00:00.000+08:00' };
}

function define(spec) {
  const ready = spec.ready !== false;
  return {
    id: spec.id,
    version: '1.0.0',
    title: spec.title,
    description: spec.description,
    domain: spec.domain,
    exposure: spec.exposure,
    sideEffect: spec.sideEffect,
    riskLevel: spec.riskLevel,
    requiredScopes: spec.scopes,
    confirmationPolicy: spec.exposure === 'system-only' ? 'pre-authorized-order-required' : (spec.riskLevel === 'L2' || spec.riskLevel === 'L3' ? 'explicit-user-confirmation' : 'none'),
    idempotencyPolicy: spec.method === 'GET' ? 'not-applicable' : 'required',
    inputSchema: spec.input,
    outputSchema: spec.output,
    endpoint: API_PREFIX + spec.path,
    httpMethod: spec.method,
    possibleErrors: spec.errors,
    examples: [{ type: 'success', value: spec.example }],
    readiness: { status: ready ? 'ready' : 'blocked', environment: 'mock', blockers: ready ? [] : ['implementation_missing'] },
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function list(options) {
  const audience = (options && options.audience) || 'all';
  const items = audience === 'model'
    ? CAPABILITIES.filter(item => item.exposure === 'model-callable' && item.readiness.status === 'ready')
    : CAPABILITIES;
  return clone(items);
}

function listForActor(context) {
  const actorType = context && context.actorType;
  const allowedExposure = actorType === 'system'
    ? ['model-callable', 'user-action', 'system-only']
    : actorType === 'user'
      ? ['model-callable', 'user-action']
      : ['model-callable'];
  return clone(CAPABILITIES.filter(item =>
    allowedExposure.includes(item.exposure) && item.readiness.status === 'ready'
  ));
}

function getForActor(id, context) {
  const item = listForActor(context).find(capabilityItem => capabilityItem.id === id);
  return item || null;
}

function get(id) {
  const item = CAPABILITIES.find(capabilityItem => capabilityItem.id === id);
  return item ? clone(item) : null;
}

function projectForAgentRuntime() {
  const ready = CAPABILITIES.filter(item => item.readiness.status === 'ready');
  return clone({
    executableCapabilities: ready.filter(item =>
      item.exposure === 'model-callable' && item.sideEffect === 'none'
    ),
    plannableCapabilities: ready.filter(item => item.exposure !== 'system-only'),
  });
}

module.exports = { API_PREFIX, list, listForActor, get, getForActor, projectForAgentRuntime };
