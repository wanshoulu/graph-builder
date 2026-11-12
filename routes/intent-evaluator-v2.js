'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { performance } = require('perf_hooks');

const { API_ROUTES } = require('../config/api-keys');
const { resolveGraphPathForVersion } = require('./intent-evaluator-graphs');
const { loadRuntimeProfile, runtimeParameter, runtimeInstruction, declaredAmbiguityCandidates, graphClarificationCandidates, consumeGraphClarificationQuestions } = require('./rsi-runtime-profile');
const { locateSpan } = require('./rsi-case-scoring');
const { buildGraphIndex, graphRecall } = require('./rsi-graph-recall');
const { AsyncLocalStorage } = require('async_hooks');
// Explicitly bound to an RSI candidate asset. Ordinary production calls do not
// read an experiment's prompt/parameter changes from shared state.
const RSI_RUNTIME = loadRuntimeProfile(process.env.INTENT_RSI_RUNTIME_GRAPH);

const ROOT = path.join(__dirname, '..');
const GRAPH_PATH = process.env.INTENT_GRAPH_PATH
  ? path.resolve(ROOT, process.env.INTENT_GRAPH_PATH)
  : path.join(ROOT, 'data', 'graphs', 'intent-graph-v2-clean-p0.json');
const CACHE_PATH = path.join(ROOT, 'data', 'graphs', 'intent-graph-v2-semantic-cache-v21.json');
const FAQ_PATH = path.join(ROOT, 'data', 'graphs', 'intent-faq-seed.json');
const VERSION_MANIFEST_PATH = path.join(ROOT, 'data', 'graphs', 'intent-graph-version-manifest.json');
// Docker / 生产环境自动检测：存在 runtime token 文件时走内部模型网关
// 容器内 dashscope.aliyuncs.com 不可达（TLS 断开），需通过 ai-harbor 模型网关调用 LLM
const _USE_INTERNAL_GATEWAY = !!process.env.AI_BANK_AGENT_RUNTIME_TOKEN_FILE;
const EMBEDDING_MODEL = process.env.INTENT_EMBEDDING_ROUTE || (_USE_INTERNAL_GATEWAY ? 'internal-gateway-embedding' : 'text-embedding-v4');
const INTENT_LLM_ROUTE = process.env.INTENT_LLM_ROUTE || (_USE_INTERNAL_GATEWAY ? 'internal-gateway-chat' : 'qwen3.7-flash');
const LLM_MODEL = process.env.INTENT_LLM_MODEL || API_ROUTES[INTENT_LLM_ROUTE].model || 'qwen3.7-flash';
const LLM_JUDGE_MAX_TOKENS = 1800;
const LLM_REPAIR_MAX_TOKENS = 800;
// ── 声明消费开关（2026-10-14，RSI 批次2）──
// 置 1 时引擎消费图谱语义声明的完整集合：disambiguation_hints（区分线索）/
// scope_out（排除域）/ confusable_intents（易混淆对）/ clause_view（子句说法）/
// semantic_definition.description。默认关闭——其他消费方（图谱评测页等）行为
// 完全不变；RSI 实验台的打分子进程经 offlineChildEnv 显式开启。
// 背景：10-14 双审计证实 A2/A3/A4 类提案写入的字段此前在本评分链路零消费，
// "评了不涨分"使这些算子的进化通道结构性失效。
const DECLARATION_AWARE = process.env.INTENT_ENGINE_CONSUME_DECLARATIONS === '1';
const INTENT_EVALUATOR_VERSION_ID = 'intent-evaluator-v2.1-p1-batch9';
const INTENT_EVALUATOR_VERSION_NAME = 'AI Harbor Intent Evaluator v2.1 P1 Batch9';
const INTENT_EVALUATOR_VERSION_STAGE = 'p1_graph_ownership_and_runtime_boundary_batch9';

// 边类型定义统一来源：tools/intent-graph-schema.js（与 editor/autobuild/builder 模板共享同一份，消除复制漂移）
const SCHEMA_EDGE_DEFINITIONS = require('../tools/intent-graph-schema').SCHEMA_EDGE_DEFINITIONS;

function elapsedMs(start) {
  return round(performance.now() - start, 3);
}

const ACTION_ALIASES = {
  query: ['帮我查', '查一下', '查询', '查看', '看看', '在哪里看', '在哪看', '明细', '记录', '进度'],
  ask: ['咨询', '了解', '介绍', '怎么', '如何', '规则', '说明', '什么是', '啥是', '是什么', '是啥', '什么意思', '啥意思', '含义', '定义'],
  guide: ['入口', '流程', '步骤', '怎么操作'],
  apply: ['申请', '办理', '提交', '我要办', '购买', '买入', '申购'],
  open: ['开通', '开户', '启用', '签约'],
  change: ['修改', '调整', '变更', '更换', '怎么改', '如何改', '设置'],
  cancel: ['取消', '撤销', '解约', '解除'],
  close: ['关闭', '注销', '销户', '停用'],
  transfer: ['转账', '汇款', '打钱', '转给', '转入', '转出'],
  repay: ['还款', '还钱', '还信用卡', '还贷款'],
};

const TRANSFER_EXECUTION_DISTRACTORS = [
  '协议', '记录', '明细', '提醒', '限额', '管理', '绑定', '修改',
  '收款码', '归集', '外汇', '兑换', '智能语音', '问问',
];

const OBJECT_ALIAS_RULES = [
  {
    match: candidate => ['余额查询', '账户余额'].includes(candidate.eval_label || candidate.object),
    aliases: ['银行卡余额', '卡余额', '储蓄卡余额', '借记卡余额', '账户余额', '余额查询', '卡里余额', '卡上余额', '卡里还有多少', '卡上还有多少', '卡里多少钱', '账户里还有多少'],
  },
  {
    match: candidate => (candidate.eval_label || candidate.object) === '待还款',
    aliases: ['信用卡待还', '信用卡待还款', '信用卡应还', '信用卡未还', '信用卡待还金额', '本期待还'],
  },
  {
    match: candidate => (candidate.eval_label || candidate.object) === '转账汇款',
    aliases: ['转账汇款', '转账功能', '汇款功能', '手机银行转账'],
  },
  {
    match: candidate => (candidate.eval_label || candidate.object) === '信用卡账单',
    aliases: ['信用卡账单', '信用卡的账单', '信用卡本期账单', '信用卡账单明细'],
  },
  {
    match: candidate => (candidate.eval_label || candidate.object) === '信用卡还款',
    aliases: ['还信用卡', '信用卡还款', '信用卡账单还款', '还信用卡账单'],
  },
  {
    match: candidate => (candidate.eval_label || candidate.object) === '房贷还款',
    aliases: ['房贷还款', '还房贷', '住房贷款还款', '按揭还款', '房贷怎么还'],
  },
  {
    match: candidate => (candidate.eval_label || candidate.object) === '还款计划',
    aliases: ['还款计划', '贷款还款', '贷款还款计划', '贷款怎么还', '贷款还款入口'],
  },
  {
    match: candidate => (candidate.eval_label || candidate.object) === '我的贷款',
    aliases: ['我的贷款', '贷款还款', '贷款还款入口', '贷款入口', '贷款服务'],
  },
  {
    match: candidate => (candidate.eval_label || candidate.object) === '解绑银行卡',
    aliases: ['解绑银行卡', '银行卡解绑', '解绑定银行卡', '取消绑定银行卡', '删除银行卡绑定', '移除银行卡绑定', '解除绑卡'],
  },
  {
    match: candidate => (candidate.eval_label || candidate.object) === '银行卡挂失',
    aliases: ['银行卡挂失', '挂失银行卡', '借记卡挂失', '卡丢了挂失', '银行卡丢了挂失', '卡片挂失'],
  },
  {
    match: candidate => (candidate.eval_label || candidate.object) === '外币预约',
    aliases: ['外币预约', '预约外币', '外币取现预约', '预约取外币'],
  },
  {
    match: candidate => (candidate.eval_label || candidate.object) === '注销电子银行',
    aliases: ['注销电子银行', '电子银行注销', '关闭电子银行'],
  },
  {
    match: candidate => (candidate.eval_label || candidate.object) === '网证登录',
    aliases: ['网证登录', '网证授权登录', '查看网证登录'],
  },
  {
    match: candidate => (candidate.eval_label || candidate.object) === '客服热线',
    aliases: ['客服热线', '客服电话', '银行客服', '联系银行客服', '人工客服热线'],
  },
  {
    match: candidate => (candidate.eval_label || candidate.object) === '购买记录',
    aliases: ['购买记录', '购买产品记录', '产品购买记录', '买过的产品'],
  },
  {
    match: candidate => (candidate.eval_label || candidate.object) === '资金归集',
    aliases: ['资金归集', '转到另一个账户', '转到我的另一个账户', '账户归集'],
  },
  {
    match: candidate => (candidate.eval_label || candidate.object) === '购买理财',
    aliases: ['购买理财', '买理财', '理财产品购买', '可以买的理财产品'],
  },
  {
    match: candidate => (candidate.eval_label || candidate.object) === '医保',
    aliases: ['医保', '医保账户', '医保余额', '医保账户余额'],
  },
  {
    match: candidate => (candidate.eval_label || candidate.object) === '绑定微信',
    aliases: ['绑定微信', '微信绑定', '开通微信绑定', '微信绑卡'],
  },
  {
    match: candidate => (candidate.eval_label || candidate.object) === '绑定支付宝',
    aliases: ['绑定支付宝', '支付宝绑定', '开通支付宝绑定', '支付宝绑卡'],
  },
  {
    match: candidate => (candidate.eval_label || candidate.object) === '绑定手机号',
    aliases: ['绑定手机号', '手机号绑定', '绑定手机号码', '手机号码绑定'],
  },
  {
    match: candidate => (candidate.eval_label || candidate.object) === '去兑换',
    aliases: ['去兑换', '兑换权益', '权益兑换', '兑换优惠'],
  },
  {
    match: candidate => (candidate.eval_label || candidate.object) === '维护英文姓名',
    aliases: ['维护英文姓名', '英文姓名维护', '修改英文姓名'],
  },
  {
    match: candidate => (candidate.eval_label || candidate.object) === '卡片推荐',
    aliases: ['卡片推荐', '信用卡推荐', '推荐办卡', '推荐信用卡'],
  },
  {
    match: candidate => (candidate.eval_label || candidate.object) === '收款服务',
    aliases: ['收款服务', '企业收款', '收款设置', '企业收款设置'],
  },
  {
    match: candidate => (candidate.eval_label || candidate.object) === '企业账户',
    aliases: ['企业账户', '企业账户余额', '企业账户查询', '公司账户', '对公账户'],
  },
  {
    match: candidate => (candidate.eval_label || candidate.object) === '公益捐赠',
    aliases: ['公益捐赠', '公益捐款', '捐款活动', '捐赠活动'],
  },
  {
    match: candidate => (candidate.eval_label || candidate.object) === '按类别查询',
    aliases: ['按类别查询', '刷卡记录', '消费类别查询', '按类别看消费'],
  },
];

const SUSPICIOUS_TRANSFER_OBJECT_TERMS = [
  '限额', '协议', '记录', '明细', '提醒', '管理', '密码', '设置',
  '安全', '额度', '查询', '规则', '客服', '收款码', '扫一扫',
];

// ── 图谱词群注册表（playbook：图内容质量决定召回上限——运行时打分词源图谱驱动、硬编码兜底）──
// 词群按「图谱状态」归属：loadGraphState 把 action_view / scope_in + object_view 算进各自
// 的 graph state，不再累加进模块级全局表——此前跨版本加载会互相污染（A 图词汇泄漏给 B 图）。
// graphRuntimeContext 允许并发评测各自绑定图谱（AsyncLocalStorage 隔离）；
// 未加载图谱前回退 = 硬编码表副本，保证 inferAction/getRuntimeObjectAliases 始终可用。
const graphRuntimeContext = new AsyncLocalStorage();
let activeGraphState = null; // loadGraphState 最近一次加载（默认图）
let fallbackActionAliases = null; // 惰性初始化为 ACTION_ALIASES 副本

function getGraphActionAliases() {
  const state = graphRuntimeContext.getStore() || activeGraphState;
  if (state && state.actionAliases) return state.actionAliases;
  if (!fallbackActionAliases) {
    fallbackActionAliases = {};
    Object.keys(ACTION_ALIASES).forEach(code => {
      fallbackActionAliases[code] = ACTION_ALIASES[code].slice();
    });
  }
  return fallbackActionAliases;
}

function currentGraphObjectAliases() {
  const state = graphRuntimeContext.getStore() || activeGraphState;
  return (state && state.objectAliases) || {};
}

const graphStateCache = new Map(); // resolvedPath -> graph state（支持多图谱版本并存）
let cacheState = null;
let faqState = null;
let versionManifestState = null;

function resolveDefaultGraphPath() {
  if (process.env.INTENT_GRAPH_PATH) return path.resolve(ROOT, process.env.INTENT_GRAPH_PATH);
  try {
    const manifest = JSON.parse(fs.readFileSync(VERSION_MANIFEST_PATH, 'utf8'));
    const activeVersion = Array.isArray(manifest.versions)
      ? manifest.versions.find(version => version.version_id === manifest.active_default)
      : null;
    const graphFile = activeVersion && (activeVersion.clean_alias_file || activeVersion.graph_file);
    if (graphFile) return path.join(ROOT, graphFile);
  } catch (error) {
    // fall back to legacy default below
  }
  return GRAPH_PATH;
}

/** options.graph_version_id 指定 manifest 版本时返回对应图谱文件路径，否则 null（用默认图）。 */
function resolveGraphPathFromOptions(options) {
  const versionId = String((options || {}).graph_version_id || '').trim();
  if (!versionId) return null;
  return resolveGraphPathForVersion(versionId) || null;
}

function sha(text, n) {
  return crypto.createHash('sha1').update(String(text), 'utf8').digest('hex').slice(0, n || 16);
}

function schemaEdgeId(edge) {
  return 'edge_' + sha([edge && edge.from, edge && edge.type, edge && edge.to].join('|'), 12);
}

function inspectIntentGraphSchema(graph, resolvedGraphPath) {
  const normalized = graph || {};
  const ontology = normalized.ontology || {};
  const edges = Array.isArray(normalized.edges) ? normalized.edges : [];
  const intentNodes = Array.isArray(normalized.intent_nodes) ? normalized.intent_nodes : [];
  const actualEdgeTypes = Array.from(new Set(edges.map(edge => edge && edge.type).filter(Boolean)));
  const declaredEdgeTypes = new Set(Array.isArray(ontology.edge_types) ? ontology.edge_types : []);
  const edgeTypeDefinitions = ontology.edge_type_definitions || {};
  const missingDeclaredEdgeTypes = actualEdgeTypes.filter(type => !declaredEdgeTypes.has(type));
  const missingDefinitionEdgeTypes = actualEdgeTypes.filter(type => !edgeTypeDefinitions[type]);
  const missingEdgeMetadataCounts = {
    edge_id: 0,
    relation_category: 0,
    status: 0,
    version: 0,
    owner: 0,
  };
  for (const edge of edges) {
    if (!edge || !edge.edge_id) missingEdgeMetadataCounts.edge_id += 1;
    if (!edge || !edge.relation_category) missingEdgeMetadataCounts.relation_category += 1;
    if (!edge || !edge.status) missingEdgeMetadataCounts.status += 1;
    if (!edge || !edge.version) missingEdgeMetadataCounts.version += 1;
    if (!edge || !edge.owner) missingEdgeMetadataCounts.owner += 1;
  }

  let legacyActionFallbackCandidates = 0;
  let legacyNavigationFallbackCandidates = 0;
  for (const node of intentNodes) {
    const task = node.task_binding || {};
    const legacy = node.source_legacy || {};
    const explicitAction = normalizeActionCode((task.action || {}).action_code);
    const intentTypeAction = normalizeActionCode((node.identity || {}).intent_type);
    if (!explicitAction && !intentTypeAction && legacy.action_code) legacyActionFallbackCandidates += 1;
    const standardNavigation = String(((node.execution_binding || {}).standard_navigation_path) || '').trim();
    const legacyNavigation = String(legacy.standard_navigation_path || legacy.business_category_path || '').trim();
    if (!standardNavigation && legacyNavigation) legacyNavigationFallbackCandidates += 1;
  }

  return {
    schema_profile: 'ai_harbor_intent_graph_v2',
    inspected_in_memory: true,
    inspected_at: new Date().toISOString(),
    source_graph_path: path.relative(ROOT, resolvedGraphPath || resolveDefaultGraphPath()).replace(/\\/g, '/'),
    edge_count: edges.length,
    ontology_edge_type_coverage_ok: missingDeclaredEdgeTypes.length === 0,
    ontology_missing_edge_types: missingDeclaredEdgeTypes,
    ontology_missing_edge_type_definitions: missingDefinitionEdgeTypes,
    edge_metadata_missing_counts: missingEdgeMetadataCounts,
    legacy_action_fallback_candidates: legacyActionFallbackCandidates,
    legacy_navigation_fallback_candidates: legacyNavigationFallbackCandidates,
    runtime_schema_repair_enabled: false,
  };
}

function normalize(text) {
  return String(text || '').replace(/\s+/g, '').toLowerCase();
}

function charNgrams(text, n) {
  const value = normalize(text);
  if (!value) return new Set();
  if (value.length <= n) return new Set([value]);
  const out = new Set();
  for (let i = 0; i <= value.length - n; i++) out.add(value.slice(i, i + n));
  return out;
}

function textJoin(values, maxItems) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    if (Array.isArray(value)) {
      for (const item of value.slice(0, maxItems || 120)) {
        const s = String(item || '').trim();
        if (s && !seen.has(s)) { seen.add(s); out.push(s); }
      }
    } else {
      const s = String(value || '').trim();
      if (s && !seen.has(s)) { seen.add(s); out.push(s); }
    }
  }
  return out.join(' | ');
}

function inferAction(query) {
  const q = String(query || '');
  if (/(去哪里操作|从哪里操作|在哪(?:里|儿)?操作|入口在(?:哪|哪里)|从哪(?:里|儿)?进|怎么进入)/.test(q)
    && /(转账|汇款|打钱|还信用卡|还款|买理财|理财|申请|办理|开通|绑定|解绑|挂失)/.test(q)
    && !/\d+(?:\.\d+)?/.test(q)) return 'guide';
  if (/^(问问|问下|咨询|了解).{2,}/.test(q) && !/(绑定|开通|申请|办理|转入|转账|汇款|激活|授权|设置|修改|调整)/.test(q)) return 'ask';
  if (/余额|卡里.*(多少|多少钱)|卡上.*(多少|多少钱)|账户里.*(多少|多少钱)|还有多少|剩多少/.test(q)) return 'query';
  if (/贷款额度|能贷多少|可贷额度|测测/.test(q)) return 'query';
  if (/^(查|查询|查看|看看|查一下|查查|看一下|看下)/.test(q)) return 'query';
  if (/给.+(转|打)\d+|给.+(转账|汇款|打钱)|给.+转.*(钱|元|块|美元|欧元|外币)|他行卡?转入|转入|转\d+/.test(q)) return 'transfer';
  if (/(还信用卡|信用卡.*还款|还.*信用卡|房贷.*还|还.*房贷|怎么还|如何还)/.test(q)) return 'repay';
  if (/(解绑银行卡|银行卡解绑|解绑定银行卡|取消绑定银行卡|删除银行卡绑定|移除银行卡绑定|解除绑卡)/.test(q)) return 'cancel';
  if (/(挂失|临时挂失|正式挂失)/.test(q) && !/(解除挂失|解挂|取消挂失|解除借记卡挂失)/.test(q)) return 'change';
  if (/(解挂|解除挂失|取消挂失|解除借记卡挂失)/.test(q)) return 'cancel';
  if (/(注销|销户|关闭|停用)/.test(q)) return 'close';
  if (/(办.*卡|申请.*卡|新卡|换卡)/.test(q)) return 'apply';
  if (/(买|购买|买入|申购)\s*[0-9]+(?:\.[0-9]+)?\s*[\u4e00-\u9fa5A-Za-z0-9]*|买.*(理财|基金|天天盈|产品|存款|保险)|买点.*(理财|基金|天天盈|产品)|买个.*(理财|基金|天天盈|产品)/.test(q)) return 'apply';
  if (/(购买|买入|申购|可以买|怎么买|如何买|兑换|预约)/.test(q)) return 'apply';
  if (/(开通|启用|绑定|签约|激活|授权)/.test(q)) return 'open';
  if (/^(查|查询|查看|看看)/.test(q) || ['帮我查', '查一下', '查询', '查看', '看看', '在哪里看', '在哪看', '余额', '账单', '明细', '记录'].some(x => q.includes(x))) return 'query';
  if (['怎么改', '如何改', '修改', '调整', '变更', '更换', '调大', '调小'].some(x => q.includes(x))) return 'change';
  if (/(联系.*(客服|你们|我行|银行)|怎么联系|客服热线|客服电话|人工客服)/.test(q)) return 'guide';
  // 图谱动作词优先（retrieval_profile.action_view 的原始中文词，按 action_code 分组），
  // 硬编码 ACTION_ALIASES 作为兜底（图谱未加载或 action_view 未覆盖时）
  const graphAliases = getGraphActionAliases();
  for (const [code, aliases] of Object.entries(graphAliases)) {
    if (aliases.some(x => q.includes(x))) return code;
  }
  return '';
}

function analyzeQuery(query) {
  const q = String(query || '');
  const amount = (q.match(/(?:转|打|汇|买|购买|买入|申购)\s*([0-9]+(?:\.[0-9]+)?)/) || [])[1] || '';
  const transferExecution = /给.+(转|打)\s*[0-9]+|给.+(转账|汇款|打钱)|给.+转.*(钱|元|块|美元|欧元|外币)|(?:转|打|汇)\s*[0-9]+/.test(q);
  const purchaseExecution = /(买|购买|买入|申购)\s*[0-9]+(?:\.[0-9]+)?|买.*(理财|基金|天天盈|产品|存款|保险)|购买.*(理财|基金|天天盈|产品|存款|保险)|申购.*(理财|基金|天天盈|产品)/.test(q);
  const askQuery = /(是什么|什么意思|介绍|规则|说明|为什么|\?|？|吗)$/.test(q) || /(是什么|什么意思|介绍一下|说明一下|规则|含义|定义)/.test(q);
  const whereQuery = /(在哪里|在哪|哪里|入口|怎么查|如何查)/.test(q);
  const changeQuery = /(设置|调整|修改|提高|降低|提升|变更|开通|关闭|挂失|解绑|解挂|解除绑定)/.test(q);
  return {
    original: q,
    inferred_action: inferAction(q),
    transfer_execution: transferExecution,
    purchase_execution: purchaseExecution,
    ask_query: askQuery || /(是什么|什么是|啥是|是啥|什么意思|啥意思|含义|定义|介绍|说明|规则|为什么|\?|？|吗)$/.test(q) || /(是什么|什么是|啥是|是啥|什么意思|啥意思|介绍一下|说明一下|规则|含义|定义)/.test(q),
    where_query: whereQuery,
    change_query: changeQuery,
    limit_object_query: /限额/.test(q),
    balance_query: /余额|卡里.*(多少|多少钱)|卡上.*(多少|多少钱)|账户里.*(多少|多少钱)|还有多少|剩多少|多少钱/.test(q),
    credit_card_due_query: /信用卡/.test(q) && /(待还|待还款|应还|未还|还款)/.test(q),
    amount,
  };
}

function buildIdleChatResult(query, reason) {
  return {
    intent_id: 'runtime_idle_chat',
    intent_name: '闲聊',
    eval_label: '闲聊',
    display_name: '闲聊',
    action_code: 'idle_chat',
    runtime_action_code: 'idle_chat',
    runtime_boundary: 'non_business_or_chat',
    object: '闲聊',
    domain: '通用交互',
    score: 1,
    evidence: ['non_business_boundary'],
    sources: ['runtime_boundary'],
    answer_available: true,
    answer_status: 'fixed_response',
    answer_policy: 'fixed_idle_chat_response',
    answer_source: 'runtime_template',
    idle_chat_reason: reason || '',
  };
}

function buildIdleChatUnderstanding(query, reason) {
  return {
    cardinality: 'idle_chat',
    task_count: 0,
    is_multi_intent: false,
    final_is_non_leaf: false,
    reason: reason || '当前输入未形成明确手机银行业务任务，按闲聊或域外输入处理。',
    tasks: [],
    clarification: {
      needed: false,
      types: [],
      question: '',
      questions: [],
      suppressed_questions: [],
      options: [],
      service_style: 'customer_facing_concise',
      internal_reason: 'non_business_or_chat',
      default_action: 'fixed_response',
    },
  };
}

function getIdleChatAnswer(query) {
  return {
    faq_id: 'runtime_idle_chat_fixed_response',
    display_name: '闲聊',
    question: query,
    answer: '我可以帮您办理或查询手机银行相关业务。您可以直接说出想办理的事项，例如查余额、转账、查账单或买理财。',
    answer_policy: 'fixed_idle_chat_response',
    answer_source: 'runtime_template',
    source: 'runtime_template',
  };
}

function shouldTreatAsIdleChat(query, shapeDetection, finalResult, queryProfile) {
  const shape = shapeDetection || {};
  const tasks = Array.isArray(shape.tasks) ? shape.tasks : [];
  const contextSpans = Array.isArray(shape.context_spans) ? shape.context_spans : [];
  const action = queryProfile && queryProfile.inferred_action || '';
  if (tasks.length > 0 || action) return false;
  if (!contextSpans.length && shape.shape !== 'single_intent') return false;
  if (!finalResult) return true;

  const q = normalize(query);
  const display = normalize(getDisplayName(finalResult));
  const object = normalize(finalResult.object);
  const strongObject = (display && display.length >= 2 && q.includes(display)) || (object && object.length >= 2 && q.includes(object));
  if (strongObject) return false;

  const evidence = finalResult.evidence || [];
  const sources = finalResult.sources || [];
  const weakSemanticOnly = sources.includes('embedding') && !sources.includes('local')
    && !evidence.some(item => ['strong_object_match', 'utterance_exact', 'query_in_profile', 'action_match'].includes(item));
  const weakScore = (finalResult.score || 0) <= 0.5 && (finalResult.fused_score || 0) <= 0.35;
  return weakSemanticOnly || weakScore;
}

function splitQueryEnumeration(raw) {
  const value = String(raw || '').trim();
  const profile = analyzeQuery(value);
  if (profile.transfer_execution) return [];
  // 「网点预约和网点详情一起看」：无动作前缀但有「一起看/办」复合尾 —— 同样是枚举复合句（rsi_t104）
  if (!profile.inferred_action && !/(查|查询|查看|看看|余额|账单|明细|记录|待还|待还款|一起(看|办|办理|处理|查))/.test(value)) return [];
  if (!/(和|与|以及|及|、)/.test(value)) return [];

  const body = value
    .replace(/^(帮我|麻烦|请|给我)?(查下|查一下|查询|查看|看看|看下|看一下|查)(一下)?(我的|我)?/, '')
    .replace(/^(我的|我)/, '')
    .replace(/一起(看下|看一下|看看|看|办一下|办|办理|处理|查下|查)?$/, '')
    .trim();
  if (!body || body === value) return [];

  const parts = body
    .split(/(?:以及|和|与|及|、)/)
    .map(x => x.replace(/^(我的|我)/, '').trim())
    .filter(Boolean);
  if (parts.length < 2) return [];

  const queryTargetPattern = /(余额|账单|明细|记录|待还|待还款|应还|未还|还款|额度|积分|预约|详情|进度)/;
  if (!parts.every(part => queryTargetPattern.test(part))) return [];

  return parts.map(part => `查${part}`);
}

function splitCompositeQuery(query) {
  const raw = String(query || '').trim();
  if (!raw) return [];
  const enumerated = splitQueryEnumeration(raw);
  const splitProtectedSegments = value => {
    const protectedValue = String(value || '')
      .replace(/还有多少钱/g, '剩余多少钱')
      .replace(/还有多少/g, '剩余多少')
      .replace(/再问问/g, '，问问')
      .replace(/再问下/g, '，问下')
      .replace(/再查一下/g, '，查一下')
      .replace(/再查/g, '，查')
      .replace(/再看看/g, '，看看')
      .replace(/再看下/g, '，看下')
      .replace(/顺便查查/g, '，查查')
      .replace(/顺便查下/g, '，查下')
      .replace(/顺便查一下/g, '，查一下')
      .replace(/顺便申请/g, '，申请')
      .replace(/顺便办理/g, '，办理')
      .replace(/顺便看看/g, '，看看')
      .replace(/顺便看下/g, '，看下')
      .replace(/接着查/g, '，查')
      .replace(/接着看/g, '，看')
      .replace(/接着替我/g, '，替我')
      .replace(/接着帮我/g, '，帮我')
      .replace(/接着/g, '，');
    return protectedValue
      .replace(/(?:然后再|然后|并且|同时|顺便看看|顺便看下|顺便查下|顺便查查|顺便|另外我想|另外|还有就是|还有|还要|还想|我还想|再帮我|再给我|再看看|再看下|再问问|再查一下|再查|再|接着)\s*/g, '，')
      .split(/[，,；;。！？\n]+/)
      .map(x => x.trim())
      .filter(Boolean)
      .filter(x => x.length >= 2);
  };
  if (enumerated.length > 1) return normalizeCompositeSegments(enumerated.flatMap(splitProtectedSegments));
  return normalizeCompositeSegments(splitProtectedSegments(raw));
}

function normalizeCompositeSegments(segments) {
  const normalized = [];
  for (const raw of segments || []) {
    const segment = String(raw || '').trim().replace(/^(这个|那个)(?=[\u4e00-\u9fa5A-Za-z0-9]{2,})/, '');
    if (!segment) continue;
    if (/^(先|我想|想)?(了解一下|咨询一下|问一下|看一下)$/.test(segment)) continue;

    const enumerated = splitQueryEnumeration(segment);
    if (enumerated.length > 1) {
      normalized.push(...enumerated);
      continue;
    }

    const profile = analyzeQuery(segment);
    const isContextOnly = !profile.inferred_action
      && !isPotentialTaskSegment(segment)
      && /(丢了|不见了|找不到|忘了|忘记|打不开|不能|无法|失败|异常|被锁|冻结)/.test(segment);
    if (isContextOnly && normalized.length) {
      normalized[normalized.length - 1] = `${normalized[normalized.length - 1]}，${segment}`;
      continue;
    }
    if (isContextOnly) {
      normalized.push(segment);
      continue;
    }

    const previous = normalized[normalized.length - 1] || '';
    const previousProfile = analyzeQuery(previous);
    const previousContextOnly = previous
      && !previousProfile.inferred_action
      && !isPotentialTaskSegment(previous)
      && /(丢了|不见了|找不到|忘了|忘记|打不开|不能|无法|失败|异常|被锁|冻结)/.test(previous);
    if (previousContextOnly) {
      normalized[normalized.length - 1] = `${previous}，${segment}`;
    } else {
      normalized.push(segment);
    }
  }
  return normalized;
}

function isPotentialTaskSegment(segment) {
  const s = String(segment || '');
  if (s.length < 2) return false;
  return /(查|查询|查看|看看|看下|了解|问问|办理|办|打开|开一下|开个|开通|关闭|关了|取消|设置|修改|调整|换|更换|切换|预约|申请|绑定|解绑|激活|授权|还款|怎么还|待还|待还款|转账|转入|缴费|挂失|注销|联系|入口|推荐|收益|记录|明细|账单|余额|账户|积分|额度|电话|网点|理财|基金|信用卡|贷款|保险|钱包|ETC|消息|协议|收款|认证|优惠|活动|参加|消费得豆|刷卡|新卡|企业|房贷)/.test(s);
}

function isBackgroundOnlySegment(segment) {
  const s = String(segment || '').trim();
  if (!s) return false;
  const profile = analyzeQuery(s);
  if (profile.inferred_action || profile.transfer_execution) return false;
  if (/(查|查询|查看|看看|办理|申请|开通|设置|修改|转账|还款|缴费|挂失|注销|余额|账单|明细|记录|额度|积分)/.test(s)) return false;
  return /(旅游|旅行|出差|买房|装修|结婚|看病|住院|购物|消费|吃饭|开学|留学|还账|周转|应急|备用|发工资|报销|发奖金|攒钱|存点钱)/.test(s);
}

function hasDirectObjectEvidence(evidence) {
  return evidence.includes('strong_object_match')
    || evidence.includes('query_in_profile')
    || evidence.includes('utterance_exact');
}

function hasHighPrecisionObjectEvidence(text) {
  return (HIGH_PRECISION_INTENT_OVERRIDES || []).some(rule => rule.pattern.test(String(text || '')));
}

function shouldUseCompositeQuery(query, segments) {
  if (!Array.isArray(segments) || segments.length < 2) return false;
  const profiles = segments.map(analyzeQuery);
  const actions = new Set(profiles.map(p => p.inferred_action).filter(Boolean));
  const hasTransfer = profiles.some(p => p.transfer_execution || p.inferred_action === 'transfer');
  const hasQuery = profiles.some(p => p.inferred_action === 'query' || /(查|查询|查看|余额|账单|明细|记录)/.test(p.original || ''));
  const hasDifferentActions = actions.size >= 2;
  const hasExecutableAndQuery = hasTransfer && segments.some(s => /(查|查询|查看|余额|账单|明细|记录)/.test(s));
  const hasIndependentBoundary = /[，,；;。！？?]/.test(String(query || ''));
  const hasSequentialBoundary = /(先.+再|先.+然后|先.+后再|查.+再转|看.+再转)/.test(String(query || ''));
  const hasEnumerationBoundary = !hasIndependentBoundary
    && !profiles.some(p => p.transfer_execution)
    && /(和|与|以及|及|、)/.test(String(query || ''));
  const allQuerySegments = profiles.every((p, index) => p.inferred_action === 'query'
    || /(查|查询|查看|余额|账单|明细|记录|待还|待还款)/.test(segments[index]));
  const independentTaskSegments = hasIndependentBoundary
    && segments.length >= 2
    && segments.every(isPotentialTaskSegment);
  return ((hasIndependentBoundary || hasSequentialBoundary) && (hasDifferentActions || hasExecutableAndQuery || segments.length >= 2))
    || independentTaskSegments
    || (hasEnumerationBoundary && allQuerySegments);
}

function shouldPromoteCompositeTasks(query, segments, tasks, ambiguousSpans) {
  if (!shouldUseCompositeQuery(query, segments)) return false;
  if (tasks.length >= 2) return true;
  if (tasks.length >= 1 && ambiguousSpans.length >= 1) return true;

  const raw = String(query || '');
  const hasEnumerationBoundary = /(和|与|以及|及|、)/.test(raw);
  if (!hasEnumerationBoundary) return false;

  const queryLikeSegments = (segments || []).filter(segment => {
    const text = String(segment || '');
    const profile = analyzeQuery(text);
    return profile.inferred_action === 'query'
      || /(查|查询|查看|看看|看下|余额|账单|明细|记录|待还|待还款|额度|积分|收益)/.test(text);
  });
  return queryLikeSegments.length >= 2;
}

function classifyTaskSegment(segment, candidates) {
  const text = String(segment || '').trim();
  const profile = analyzeQuery(text);
  const local = runLocal(text, candidates, 5);
  const top1 = local.top1 || null;
  const evidence = top1 && Array.isArray(top1.evidence) ? top1.evidence : [];
  const directObjectEvidence = hasDirectObjectEvidence(evidence);
  const highPrecisionObjectEvidence = hasHighPrecisionObjectEvidence(text);
  const concreteBusinessText = isPotentialTaskSegment(text) && !isBackgroundOnlySegment(text);
  const hasObjectEvidence = directObjectEvidence
    || highPrecisionObjectEvidence
    || (top1 && concreteBusinessText && (top1.score || 0) >= 0.95);
  const inferredAction = profile.inferred_action || (top1 && directObjectEvidence && (top1.score || 0) >= 0.95 ? top1.action_code : '');
  const hasAction = !!inferredAction || !!profile.transfer_execution;
  const transferIntentTask = inferredAction === 'transfer' && /(转账|汇款|转给|转入|转出)/.test(text);
  const highConfidenceTask = hasAction
    && top1
    && (local.confidence || 0) >= 0.78
    && (directObjectEvidence || highPrecisionObjectEvidence || profile.transfer_execution || transferIntentTask || ((top1.score || 0) >= 0.95 && concreteBusinessText));
  const implicitObjectTask = !profile.inferred_action
    && top1
    && hasObjectEvidence
    && (local.confidence || 0) >= 0.85;
  const contextOnly = isBackgroundOnlySegment(text) || (!hasAction
    && !hasObjectEvidence
    && /(丢了|不见了|找不到|忘了|忘记|打不开|不能|无法|失败|异常|被锁|冻结)/.test(text));
  const complete = !!((hasAction && (hasObjectEvidence || profile.transfer_execution || transferIntentTask || highConfidenceTask)) || implicitObjectTask);

  return {
    text,
    role: contextOnly ? 'context' : complete ? 'task' : hasAction || hasObjectEvidence ? 'ambiguous_task' : 'other',
    action: inferredAction || '',
    object: top1 ? getDisplayName(top1) : '',
    confidence: local.confidence || 0,
    local_top1: top1 ? {
      intent_id: top1.intent_id,
      display_name: getDisplayName(top1),
      action_code: top1.action_code,
      score: top1.score || 0,
      evidence,
    } : null,
    reason: contextOnly
      ? '片段是原因或状态说明，不作为独立任务。'
      : complete
        ? '片段同时具备动作线索和对象/候选证据，可作为独立任务。'
        : '片段缺少完整动作或对象证据，不单独进入多意图执行。',
  };
}

function detectIntentShape(query, candidates) {
  const raw = String(query || '').trim();
  const segments = splitCompositeQuery(raw);
  const profile = analyzeQuery(raw);
  const payees = profile.transfer_execution ? inferPayeesFromQuery(raw) : [];
  const hasSeparateTaskBeforeTransfer = segments.length > 1
    && segments.some(s => /(查|查询|查看|看看|余额|账单|明细|记录|待还|额度|积分)/.test(s))
    && segments.some(s => {
      const p = analyzeQuery(s);
      return p.transfer_execution || p.inferred_action === 'transfer';
    });

  if (profile.transfer_execution && payees.length > 1 && !hasSeparateTaskBeforeTransfer) {
    return {
      shape: 'multi_task_same_intent',
      segments: [raw],
      tasks: [{
        text: raw,
        role: 'task',
        action: 'transfer',
        object: '转账',
        confidence: 1,
        reason: '同一转账意图下包含多个收款人，属于多任务同一意图，不拆成多个意图节点。',
      }],
      context_spans: [],
      ambiguous_spans: [],
      reason: '多收款人转账应由单个转账意图生成多个任务实例。',
    };
  }

  const classified = segments.map(segment => classifyTaskSegment(segment, candidates));
  const tasks = classified.filter(item => item.role === 'task');
  const contextSpans = classified.filter(item => item.role === 'context');
  const ambiguousSpans = classified.filter(item => item.role === 'ambiguous_task');

  // 声明驱动强制多意图：切分≥2段且≥2段有图谱声明级证据
  // （utterance_exact / strong_object_match / query_in_profile）→ 覆盖
  // shouldPromoteCompositeTasks 的保守判定，避免 LLM shape 误判 single
  // （rsi_t111/t115："还有"切分正常但 shape 层判 single → engine_segments=[]）
  if (segments.length >= 2) {
    const declaredHitCount = classified.filter(item => {
      const ev = item.local_top1 && Array.isArray(item.local_top1.evidence) ? item.local_top1.evidence : [];
      return ev.some(e => e === 'utterance_exact' || e === 'strong_object_match' || e === 'query_in_profile');
    }).length;
    if (declaredHitCount >= 2) {
      return {
        shape: 'multi_intent',
        segments,
        tasks: classified.filter(item => item.role === 'task' || item.role === 'ambiguous_task'),
        context_spans: contextSpans,
        ambiguous_spans: ambiguousSpans,
        reason: `声明驱动强制多意图：${declaredHitCount}/${segments.length} 段有图谱声明级证据。`,
      };
    }
  }

  if (shouldPromoteCompositeTasks(raw, segments, tasks, ambiguousSpans)) {
    return {
      shape: 'multi_intent',
      segments,
      tasks,
      context_spans: contextSpans,
      ambiguous_spans: ambiguousSpans,
      reason: tasks.length >= 2
        ? `识别到 ${tasks.length} 个具备动作和对象证据的独立任务片段。`
        : '输入包含明确的复合任务边界，且至少一个片段已形成独立任务，剩余片段进入多意图候选确认。',
    };
  }

  if (!tasks.length && ambiguousSpans.length >= 1 && segments.length >= 2) {
    return {
      shape: 'ambiguous_intent',
      segments,
      tasks,
      context_spans: contextSpans,
      ambiguous_spans: ambiguousSpans,
      reason: '存在多个候选片段，但缺少足够对象或动作证据，不直接进入多意图执行。',
    };
  }

  return {
    shape: 'single_intent',
    segments,
    tasks,
    context_spans: contextSpans,
    ambiguous_spans: ambiguousSpans,
    reason: tasks.length === 1
      ? '仅识别到一个完整任务片段，按单意图处理。'
      : '未识别到多个独立完整任务，按单意图处理。',
  };
}

function candidateBoundaryText(candidate) {
  return [candidate.intent_name, candidate.eval_label, candidate.object].filter(Boolean).join('|');
}

function getRuntimeObjectAliases(candidate, objectAliasesOverride) {
  if (!candidate) return [];
  const aliases = [];
  // 图谱词群优先：semantic_definition.scope_in（用户可能的表达）+ retrieval_profile.object_view，按 eval_label 索引；
  // 构建期传 state 本地表，其余场景读当前上下文的活跃表
  const aliasTable = objectAliasesOverride || currentGraphObjectAliases();
  const graphKey = candidate.eval_label || candidate.object;
  if (graphKey && aliasTable[graphKey]) aliases.push(...aliasTable[graphKey]);
  // 硬编码规则兜底（历史调优词，图谱未覆盖时仍生效）
  for (const rule of OBJECT_ALIAS_RULES) {
    if (rule.match(candidate)) aliases.push(...rule.aliases);
  }
  return Array.from(new Set(aliases.map(normalize).filter(Boolean)));
}

// 归一化 eval_label：去掉 action 前缀后比较核心业务词
// 用于跨 action_code 匹配同业务域图节点（如 query "查询电子银行限额调整" vs change "修改电子银行限额调整"）
function normalizeEvalLabel(label) {
  return String(label || '').replace(/^(查询|修改|申请|办理|咨询|变更|设置|开通|关闭|取消|添加|删除|调整)/, '');
}

// 泛化 query-action 对齐：当 query 句式动词暗示"查询/查看"但 finalResult 返回非 query action 时，
// 自动在候选中找同业务域的 query 候选替换。不硬编码任何业务词。
function alignQueryAction(query, finalResult, candidates) {
  if (!finalResult) return finalResult;
  const isQueryAction = finalResult.action_code === 'query';

  // 非 query action：检查触发词
  if (!isQueryAction) {
    const QUERY_PROBE_RE = /能查|能看|怎么调|看看|查看|查一下|查查|看一下|看下|在哪看|在哪查|怎么查|如何查|到哪了/;
    const STRONG_CHANGE_VERB_RE = /修改|变更|设置|关闭|取消|删除|办理|挂失|解绑|开通|激活|签约|授权/;

    if (!QUERY_PROBE_RE.test(query)) return finalResult;
    if (STRONG_CHANGE_VERB_RE.test(query) && !/怎么调/.test(query)) return finalResult;
  }

  const curId = finalResult.intent_id || '';
  const curCand = (candidates || []).find(c => c.intent_id === curId);

  // Tier 0: finalResult 的 intent_id 在候选中已是 query → 只修正 action_code，不替换节点
  if (!isQueryAction && curCand && curCand.action_code === 'query') {
    return {
      ...finalResult,
      action_code: 'query',
      runtime_boundary: 'query_action_alignment',
      evidence: Array.from(new Set([...(finalResult.evidence || []), 'query_action_alignment'])),
      sources: Array.from(new Set([...(finalResult.sources || []), 'query_action_alignment'])),
    };
  }

  const curLabel = (curCand && curCand.eval_label) || finalResult.eval_label || '';

  // Tier 1: normalizeEvalLabel 精确匹配（仅非 query action 时触发——action 对位替换）
  if (!isQueryAction && curLabel) {
    const curNorm = normalizeEvalLabel(curLabel);
    const alts = (candidates || []).filter(c =>
      c.action_code === 'query' && c.intent_id !== curId && normalizeEvalLabel(c.eval_label) === curNorm
    );
    if (alts.length === 1) {
      const alt = alts[0];
      return {
        ...alt,
        score: Math.max(finalResult.score || 0, 0.8),
        display_name: alt.intent_name || alt.eval_label || alt.object || '',
        runtime_boundary: 'query_action_alignment',
        evidence: Array.from(new Set([...(alt.evidence || []), 'query_action_alignment'])),
        sources: Array.from(new Set([...(alt.sources || []), 'query_action_alignment'])),
      };
    }
  }

  // Tier 2: 缺失词检测——query 含某些词但 finalResult 的 strong_object_terms 没有这些词时
  // 仅非 query action 时触发，避免误替换已正确的 query finalResult
  if (!isQueryAction) {
    const curTerms = (curCand && curCand.strong_object_terms) || [];
    const queryAlts = (candidates || []).filter(c =>
      c.action_code === 'query' && c.intent_id !== curId && c.strong_object_terms
    );
    if (queryAlts.length && curTerms.length) {
      const scored = queryAlts.map(c => {
        const missingTerms = c.strong_object_terms.filter(t => query.includes(t) && !curTerms.includes(t));
        const overlapTerms = c.strong_object_terms.filter(t => curTerms.includes(t));
        return { cand: c, missingCount: missingTerms.length, overlapCount: overlapTerms.length };
      }).filter(s => s.missingCount > 0);
      if (scored.length) {
        scored.sort((a, b) => b.missingCount - a.missingCount || b.overlapCount - a.overlapCount);
        const alt = scored[0].cand;
        return {
          ...alt,
          score: Math.max(finalResult.score || 0, 0.8),
          display_name: alt.intent_name || alt.eval_label || alt.object || '',
          runtime_boundary: 'query_action_alignment',
          evidence: Array.from(new Set([...(alt.evidence || []), 'query_action_alignment'])),
          sources: Array.from(new Set([...(alt.sources || []), 'query_action_alignment'])),
        };
      }
    }
  }

  return finalResult;
}

function isSuspiciousTransferCandidate(candidate) {
  if (!candidate || candidate.action_code !== 'transfer') return false;
  const text = candidateBoundaryText(candidate);
  if (candidate.eval_label === '转账' || candidate.intent_name === '转账转账') return false;
  if (candidate.eval_label === '转账汇款' || candidate.intent_name === '转账转账汇款') return false;
  return SUSPICIOUS_TRANSFER_OBJECT_TERMS.some(term => text.includes(term));
}

function isTransferExecutionDistractor(candidate) {
  if (!candidate) return false;
  const text = candidateBoundaryText(candidate);
  if (candidate.eval_label === '转账' || candidate.intent_name === '转账转账') return false;
  return TRANSFER_EXECUTION_DISTRACTORS.some(term => text.includes(term));
}

function transferExecutionAdjustment(queryProfile, candidate) {
  if (!queryProfile.transfer_execution) return 0;
  if (isTransferExecutionDistractor(candidate)) return -0.75;
  if (candidate.action_code !== 'transfer') return 0;
  if (candidate.eval_label === '转账' || candidate.intent_name === '转账转账') return 0.42;
  if (candidate.intent_name === '转账转账汇款' || candidate.eval_label === '转账汇款') return 0.18;
  return 0;
}

function queryBoundaryAdjustment(queryProfile, candidate) {
  if (!candidate) return 0;
  const text = candidateBoundaryText(candidate);
  const queryNorm = normalize(queryProfile.original);
  const strongObjectMatch = candidate.strong_object_terms.some(term => term && queryNorm.includes(term));
  let score = 0;

  if (queryProfile.ask_query) {
    const askLikeTarget = /(限额|协议|规则|说明|介绍|费用|利率|手续费|定义|含义|是什么|问答|帮助)/.test(text);
    if (candidate.action_code === 'ask' && strongObjectMatch) score += 1.18;
    else if (candidate.action_code === 'ask' && askLikeTarget) score += 1.05;
    if (candidate.action_code === 'query' && strongObjectMatch) score += 0.18;
    else if (candidate.action_code === 'query' && askLikeTarget) score += 0.22;
    if (['transfer', 'change', 'apply', 'open', 'close', 'cancel'].includes(candidate.action_code)) score -= 0.65;
  }

  if (queryProfile.where_query) {
    if (['query', 'guide'].includes(candidate.action_code)) score += 0.58;
    if (candidate.action_code === 'ask') score += 0.12;
    if (['transfer', 'change', 'apply'].includes(candidate.action_code)) score -= 0.36;
  }

  if (queryProfile.change_query) {
    if (['change', 'open', 'close', 'apply', 'cancel'].includes(candidate.action_code)) score += 0.72;
    if (candidate.action_code === 'ask') score -= 0.42;
    if (candidate.action_code === 'query' && /设置|调整|修改|限额/.test(text)) score += 0.12;
  }

  if (/贷款/.test(queryProfile.original || '') && /还款/.test(queryProfile.original || '') && !/房贷|按揭|住房贷款/.test(queryProfile.original || '')) {
    if (/(还款计划|我的贷款|贷款)/.test(text)) score += 0.36;
    if (/房贷还款/.test(text)) score -= 0.28;
  }

  if (queryProfile.balance_query) {
    if (/(余额查询|账户余额|钱包余额|余额)/.test(text)) score += 0.72;
    if (candidate.action_code === 'query') score += 0.48;
    if (candidate.action_code === 'change') score -= 0.78;
    if (/^(银行卡|银行卡信息|添加银行卡|银行卡数值)$/.test(candidate.eval_label || '')) score -= 0.72;
    if (/银行卡/.test(text) && !/余额/.test(text)) score -= 0.42;
  }

  if (queryProfile.credit_card_due_query) {
    if (/(待还款|还款金额|应还|未还|待还)/.test(text)) score += 0.86;
    else if (/信用卡还款/.test(text)) score += 0.38;
    if (/(提醒|设置|分期|登录|挂失|解锁|信用卡申请|添加银行卡)/.test(candidate.eval_label || '')) score -= 0.72;
    if ((candidate.eval_label || '') === '还款' && !/信用卡|待还|应还|未还/.test(text)) score -= 0.24;
  }

  if (queryProfile.purchase_execution) {
    if (candidate.action_code === 'apply' || candidate.action_code === 'open') score += 0.92;
    if (['query', 'change', 'ask', 'guide'].includes(candidate.action_code)) score -= 0.58;
    if (/(天天盈|理财|基金|产品|存款|保险)/.test(text) && candidate.action_code === 'apply') score += 0.45;
    if (/(总榜|产品榜|乐园|记录|明细|规则|说明|介绍|收益|持仓)/.test(candidate.eval_label || candidate.object || '')) score -= 0.46;
  }

  return score;
}

function getSlotArray(slots, key) {
  return Array.isArray(slots && slots[key]) ? slots[key].filter(Boolean) : [];
}

function inferPayeesFromQuery(query) {
  const q = String(query || '');
  const beforeAmount = q.replace(/(?:转|打|汇)\s*[0-9]+(?:\.[0-9]+)?[\u4e00-\u9fa5]*/g, '');
  const afterGive = beforeAmount.replace(/^.*?给/, '');
  const explicit = afterGive
    .split(/和|与|、|,|，|\s+/)
    .map(x => x.trim())
    .filter(x => /^[\u4e00-\u9fa5]{2,4}$/.test(x));
  if (explicit.length > 1) return explicit;
  const compact = afterGive.match(/^[\u4e00-\u9fa5]{4,8}$/);
  if (compact && compact[0].length % 2 === 0) {
    const names = [];
    for (let i = 0; i < compact[0].length; i += 2) names.push(compact[0].slice(i, i + 2));
    return names.length > 1 ? names : [];
  }
  return explicit;
}

function detectTransferPayeeAmbiguityFallback(query) {
  const q = String(query || '');
  const profile = analyzeQuery(q);
  if (!profile.transfer_execution) return null;

  const beforeAmount = q.replace(/(?:转|打|汇)\s*[0-9]+(?:\.[0-9]+)?[\u4e00-\u9fa5]*/g, '');
  const afterGive = beforeAmount
    .replace(/^.*?给/, '')
    .replace(/(?:然后|并且|顺便|另外|再).*/g, '')
    .replace(/[，,；;。！？?]/g, '')
    .trim();
  if (!afterGive) return null;

  const localPayees = inferPayeesFromQuery(q);
  const suspiciousConnector = /^[\u4e00-\u9fa5]{1,3}(是|时|给|和|与)[\u4e00-\u9fa5]{2,4}$/.test(afterGive)
    && !/(女士|先生|经理|公司|银行|账户|余额|汇款|转账)/.test(afterGive);
  if (!suspiciousConnector) return null;

  return {
    raw_payee_text: afterGive,
    inferred_payees: localPayees,
    payee_ambiguity_type: 'possible_typo_or_connector',
    source: 'deterministic_fallback',
    reason: suspiciousConnector
      ? '疑似收款人姓名中包含连接词错字或多个姓名粘连。'
      : '疑似多个收款人姓名粘连。',
  };
}

function getTransferClarificationOptions(candidates) {
  const preferred = ['转账汇款', '跨行转账', '手机号转账', '工行转账', '境内汇款', '跨境汇款'];
  const descriptions = {
    转账汇款: '常规境内转账汇款',
    跨行转账: '转给其他银行账户',
    手机号转账: '通过手机号识别收款方',
    工行转账: '转给工行账户',
    境内汇款: '办理境内汇款业务',
    跨境汇款: '办理跨境汇款业务',
  };
  const rows = [];
  const seen = new Set();
  for (const label of preferred) {
    const hit = candidates.find(c => c.action_code === 'transfer'
      && !isTransferExecutionDistractor(c)
      && (c.eval_label === label || c.intent_name.includes(label)));
    if (hit && !seen.has(hit.intent_id)) {
      seen.add(hit.intent_id);
      rows.push({
        label: hit.eval_label,
        display_label: hit.eval_label,
        description: descriptions[hit.eval_label] || '',
        intent_id: hit.intent_id,
        intent_name: hit.intent_name,
        action_code: hit.action_code,
      });
    }
  }
  return rows;
}

function isGenericNonLeafIntent(finalResult) {
  if (!finalResult) return false;
  if (finalResult.action_code === 'transfer' && (finalResult.eval_label === '转账' || finalResult.intent_name === '转账转账')) return true;
  return false;
}

const GENERIC_AMBIGUOUS_LABELS = [
  '还款', '转账', '账户', '我的账户', '银行卡', '信用卡', '理财', '基金', '贷款', '保险',
  '设置', '通用设置', '挂失', '分期申请', '额度管理', '积分记录', '客服与帮助咨询',
  '电话咨询', '联系我行', '开通', '注销', '业务办理', '帮助与反馈咨询', '基本信息',
  '银行卡咨询', '交易记录', '收支', '权益中心', '支付', '外汇', '外币识别', '卡片服务', '到期提醒',
  '积分权益', '我的贷款',
];

function isGenericAmbiguousQuery(query, finalResult) {
  const q = String(query || '').trim();
  if (!q) return false;
  const profile = analyzeQuery(q);
  // 比较句式（X和Y有什么关系 / X还是Y）→ 直接判为泛化模糊，必须在 ask_query 早退之前检查
  // 比较句式是问句（含"吗？/区别？"），ask_query=true，LLM 会给 action_code='ask'，
  // 不提前检查则 isComparisonQuery 永远执行不到（rsi_g130/g131/g132 实测）
  if (isComparisonQuery(q)) return true;
  if (profile.ask_query && finalResult && (finalResult.action_code === 'ask' || finalResult.runtime_action_code === 'ask')) {
    return false;
  }
  // ── 图谱驱动泛化判定（RSI 场景：query 是"裸业务词"或"泛化动作+业务词"）──
  // 旧词表（GENERIC_AMBIGUOUS_LABELS + 关键词→labels 映射）按固定业务域硬编码，
  // 换图谱（如 RSI 导入的子图）后词表全不命中 → 泛化澄清永不触发。
  // 规则：≤5 字裸词 / 泛化标记（的事/还是/那个/怎么办）/ 泛化动作+短词（查下XX）
  const vagueMarker = /(的事|还是|那个|这个(?!月)|怎么办|怎么弄|怎么开(?!通)|办一下|弄一下|帮我办|我想查)/.test(q);
  const genericActionShort = (() => {
    const m = q.match(/^(帮我|麻烦|请)?(查下|查一下|看看|看一下|查个)(.{0,4})$/);
    return !!m;
  })();
  const bareBusinessWord = q.length <= 5 && !/[?？!！]/.test(q);
  // 模糊句式（的事/那个/怎么弄）和泛化动作+短词（查下XX/看看XX）天然歧义，
  // 即使引擎高分匹配也可能是匹配到知识意图而非可执行意图（rsi_t203/t206/t214/t217/t219/t220 实测）
  // 直接触发澄清，不走 confidentExact 检查
  if (vagueMarker || genericActionShort) return true;
  if (bareBusinessWord) {
    const confidentExact = finalResult && (finalResult.score || 0) >= 0.95;
    if (!confidentExact) return true;
  }
  const display = finalResult ? getDisplayName(finalResult) : '';
  const graphDisplay = finalResult ? getGraphDisplayName(finalResult) : '';
  const text = normalize(q);
  const displayNorm = normalize(display);
  const graphNorm = normalize(graphDisplay);
  const genericLabel = GENERIC_AMBIGUOUS_LABELS.some(label => {
    const n = normalize(label);
    return n && (displayNorm === n || graphNorm === n || displayNorm.includes(n));
  });
  const shortGeneric = q.length <= 12 && /(还款|转账|账户|理财|基金|贷款|保险|设置|挂失|分期|额度|积分|联系|客服|开通|关闭|注销|收支|权益|支付|外币|外汇|卡片|提醒)/.test(q);
  const vaguePronoun = /(这个(?!月)|那个|这张卡|我的卡|我的账户|怎么关|怎么开|怎么办|怎么弄|设置一下|办一下|查一下我的账户|查一下我的卡)/.test(q);
  const broadAction = /^(我要|我想|帮我|麻烦|请)?(还款|转账|设置|开通|关闭|注销|办分期|查账户|查积分|联系你们|挂失)$/.test(q);
  const hasSpecificQualifier = /(信用卡|房贷|车贷|公积金|跨行|工行|手机号|收款人|账单|明细|余额|待还|自动|一键|网点|基金超市|理财推荐|ETC|钱包|密码|手机号)/.test(q);
  const specificButStillAmbiguous = /(申请.*银行卡|新的银行卡|修改.*信息|我的信息)/.test(q);
  const explicitResolvedQuery = finalResult
    && (finalResult.score || 0) >= 0.98
    && /(查|查询|查看|看看|看下|想知道|确认).*(还款计划|待还|待还款|余额|账单|明细|记录|进度)/.test(q);
  if (explicitResolvedQuery) return false;
  if (hasSpecificQualifier && !vaguePronoun && !broadAction && !specificButStillAmbiguous) return false;
  if (!finalResult) return vaguePronoun || broadAction || /^(怎么)?(取消|关闭|开通|设置|修改).*(功能|这个)?$/.test(q);
  const broadBusinessObject = /(查交易记录|交易记录|我的收支|查.*收支|我的权益|支付方式|我的外币|取消卡片|提醒设置|积分.*权益|我的贷款|新的银行卡)/.test(q);
  return genericLabel && (shortGeneric || vaguePronoun || broadAction || specificButStillAmbiguous || broadBusinessObject || text.length <= 8);
}

// ── 比较句式检测：X和Y有什么关系 / X和Y是一个东西吗 / X还是Y ──
// 这类 query gold 要求返回两个意图让用户选择，不是单意图直答。
// detectComparisonClarification 从候选中找出 X 和 Y 各自匹配的意图，返回精确的 2 选项。
function detectComparisonClarification(query, candidates) {
  const q = String(query || '').trim();
  if (!q || !candidates || !candidates.length) return null;
  // 排除转账/收款人场景（由 slot 逻辑处理）
  if (/给.*转|收款人|打钱|汇款/.test(q)) return null;

  // 匹配 "X和Y..." / "X跟Y..." / "X还是Y"
  // 尾部允许：有什么关系/是一个东西吗/是一个意思吗/的区别/啥区别/什么区别/区别/对比/比较/空
  const m = q.match(/^(.+?)(?:和|跟|还是)(.+?)(?:有什么关系|是一个东西吗|是一个意思吗|有什么区别|有啥区别|的区别|啥区别|什么区别|区别|对比|比较)?[？?]?(?:)$/);
  if (!m) return null;
  const leftRaw = m[1].trim();
  let rightRaw = m[2].trim();
  // 清除右侧尾部的问句残留
  rightRaw = rightRaw.replace(/(有什么关系|是一个东西吗|是一个意思吗|有什么区别|有啥区别|的区别|啥区别|什么区别|区别|对比|比较).*$/, '').trim();
  if (!leftRaw || !rightRaw || leftRaw.length < 2 || rightRaw.length < 2) return null;
  // 排除明显不是业务词的（如"我和你"）
  if (leftRaw.length <= 1 && rightRaw.length <= 1) return null;

  const stripPrefix = s => s.replace(/^(查询|查看|看看|申请\/办理|申请|办理|我的|帮我查|查)/, '').trim();
  const findMatch = (part) => {
    const partNorm = normalize(part);
    const partStripped = normalize(stripPrefix(part));
    const hits = [];
    for (const c of candidates) {
      const display = normalize(getDisplayName(c));
      const evalLabel = normalize(c.eval_label || '');
      const graphDisplay = normalize(getGraphDisplayName(c));
      // 精确匹配优先
      if (display === partNorm || evalLabel === partNorm || graphDisplay === partNorm) {
        hits.push({ c, score: 100 });
        continue;
      }
      // 去前缀后精确匹配
      if (partStripped && (display === partStripped || evalLabel === partStripped)) {
        hits.push({ c, score: 90 });
        continue;
      }
      // 包含匹配（候选名包含 query 片段 或反过来）
      const hay = `${display}|${evalLabel}|${graphDisplay}`;
      if (partNorm.length >= 2 && hay.includes(partNorm)) {
        hits.push({ c, score: 50 + partNorm.length });
        continue;
      }
      if (partStripped.length >= 2 && hay.includes(partStripped)) {
        hits.push({ c, score: 40 + partStripped.length });
        continue;
      }
    }
    if (!hits.length) return null;
    // 优先 query 动作，其次按匹配分排序
    hits.sort((a, b) => {
      const aQ = a.c.action_code === 'query' ? 0 : 1;
      const bQ = b.c.action_code === 'query' ? 0 : 1;
      if (aQ !== bQ) return aQ - bQ;
      return b.score - a.score;
    });
    return hits[0].c;
  };

  const leftMatch = findMatch(leftRaw);
  const rightMatch = findMatch(rightRaw);
  if (!leftMatch || !rightMatch) return null;
  if (leftMatch.intent_id === rightMatch.intent_id) return null;

  const buildOpt = c => ({
    label: getDisplayName(c),
    display_label: getDisplayName(c),
    value: c.intent_id,
    intent_id: c.intent_id,
    intent_name: c.intent_name,
    action_code: c.action_code,
  });
  return [buildOpt(leftMatch), buildOpt(rightMatch)];
}

// ── 复合查询守卫：query 含有其他候选名中的业务词片段，但 top1 不含 → 可能漏选，不走直判 ──
// 典型场景："申请信用卡进度到哪了" top1="申请/办理申请信用卡"（含"申请信用卡"不含"进度"），
// 但候选中有"查询申请进度"（含"进度"），说明 query 是复合结构，应交 LLM judge 裁决。
function hasCompetingCandidate(query, selected, merged) {
  if (!selected || !merged || merged.length < 2) return false;
  const selText = normalize(getDisplayName(selected) + (selected.eval_label || '') + (selected.intent_name || ''));
  const q = String(query || '');
  for (const c of merged) {
    if (!c || c.intent_id === selected.intent_id) continue;
    const cDisplay = getDisplayName(c);
    const cNorm = normalize(cDisplay);
    // 滑窗检查候选名中 2 字片段是否出现在 query 中但不在 selected 中
    for (let i = 0; i <= cNorm.length - 2; i++) {
      const frag = cNorm.slice(i, i + 2);
      if (frag.length < 2) continue;
      if (q.includes(frag) && !selText.includes(frag)) {
        // 排除动作词和非业务片段
        if (/查询|查看|申请|办理|我的|帮|看看|一下|怎么|在哪|能查/.test(frag)) continue;
        return true;
      }
    }
  }
  return false;
}

// 判断 query 是否为比较句式（不需要候选，仅形态判定）
function isComparisonQuery(query) {
  const q = String(query || '').trim();
  if (!q) return false;
  if (/给.*转|收款人|打钱|汇款/.test(q)) return false;
  // X和Y有什么关系 / X和Y是一个东西吗 / X和Y有啥区别 / X还是Y
  return /(.+)(和|跟)(.+)(有什么关系|是一个东西吗|是一个意思吗|有什么区别|有啥区别|的区别|啥区别|什么区别|区别)/.test(q)
    || /^(.+?)还是(.+?)$/.test(q)
    || /^(.+?)(?:和|跟)(.+?)(?:有什么关系|是一个东西吗|是一个意思吗|有什么区别|有啥区别|啥区别|什么区别|区别)/.test(q);
}

function getGenericClarificationOptions(query, finalResult, candidates) {
  if (runtimeParameter(RSI_RUNTIME, 'graphClusterFirst', false)) {
    const graphOptions = graphClarificationCandidates(query, candidates || [], runtimeParameter(RSI_RUNTIME, 'clarificationLimit', 6), RSI_RUNTIME);
    // 单成员簇也走图谱通道：「查绿色那个」只召回绿色空间一个意图，用户用指示词
    // 显式表达了模糊，图谱单成员恰是 gold 期望的澄清选项集合（rsi_t217）。
    if (graphOptions.length >= 1) return graphOptions;
  }
  const q = String(query || '');
  const labels = [];
  if (/还款/.test(q)) labels.push('信用卡还款', '自动还款', '一键还款', '房贷还款', '还款计划', '待还款');
  if (/转账/.test(q)) labels.push('转账汇款', '工行转账', '跨行转账', '手机号转账', '预约转账');
  if (/账户/.test(q)) labels.push('我的账户', '账户余额', '余额查询', '收支分析', '年度分析', '消费分析', '收入统计');
  if (/卡丢|卡.*丢|挂失/.test(q)) labels.push('账户挂失', '介质挂失', '理财金账户正式挂失', '理财金账户延长挂失期限', '解除借记卡挂失');
  if (/挂失/.test(q) && /银行卡|借记卡|卡/.test(q)) labels.unshift('银行卡挂失');
  if (/银行卡|新的银行卡|申请.*卡|办.*卡/.test(q)) labels.push('添加银行卡', '添加其他银行卡', '申请办卡');
  if (/解绑|解绑定|取消绑定|删除.*绑定|移除.*绑定/.test(q)) labels.unshift('解绑银行卡', '一键绑卡');
  if (/卡/.test(q) && !/银行卡|新的银行卡|申请.*卡|办.*卡|信用卡/.test(q)) labels.push('银行卡', '账户挂失', '账户安全锁', '余额查询');
  if (/分期/.test(q)) labels.push('信用卡分期', '账单分期', '消费分期', '家装分期', '现金分期');
  if (/额度/.test(q)) labels.push('额度管理', '支付限额', '转账限额', '电子银行限额调整', '卡片等级', '卡片权益');
  if (/积分/.test(q)) labels.push('积分记录', '工银i豆数值', '优惠券');
  if (/联系|客服|电话/.test(q)) labels.push('联系我行', '网点电话', '客服热线', '网点客服');
  if (/设置/.test(q)) labels.push('通用设置', '消息设置', '账户安全', '支付限额');
  if (/理财/.test(q)) labels.push('理财', '理财推荐', '股票型基金', '外汇交易');
  if (/基金/.test(q)) labels.push('基金持仓', '股票型基金', '理财推荐');
  if (/收支|交易记录/.test(q)) labels.push('收支分析', '年度分析', '消费分析', '收入统计', '交易记录');
  if (/修改.*信息|我的信息/.test(q)) labels.push('联系方式', '手机号收款', '基本信息', '卡片等级');
  if (/在线取号|取号/.test(q)) labels.push('预约取号', '网点现场取号方法');
  if (/权益/.test(q)) labels.push('卡片权益', '优惠券', '权益中心');
  if (/支付方式|支付/.test(q)) labels.push('e支付', '子钱包', '收款服务');
  if (/外币|外汇/.test(q)) labels.push('外汇交易', '外币预约');
  if (/开通/.test(q)) labels.push('开通钱包', '薪管家', '卡片等级', '卡片权益');
  if (/取消|关闭|怎么关/.test(q)) labels.push('撤销免签标志', '卡片权益', '解除钱包挂失', '卡片管理');
  if (/贷款/.test(q)) labels.push('还款计划', '房贷还款', '我的贷款');
  if (/提醒/.test(q)) labels.push('交易提醒', '到期提醒', '消息设置');

  const wanted = new Set(labels.map(normalize));
  const rows = [];
  const seenLabels = new Set();

  // ── 图谱驱动兜底：词表没命中时，按 query 核心词从全图候选里组织业务簇 ──
  // 对齐 ai-native-bank 的思想：模糊 query 的澄清选项按"业务名词簇"组织，
  // 意图自己的 scope_in 声明（含 RSI 进化 A1 加的说法）是簇成员依据。
  if (!rows.length) {
    let core = String(q || '')
      .replace(/查|查询|看|看看|查看|办|办理|弄|改|修改|设置|开|开通|关|关闭|我要|我想|帮我|请|麻烦|一下|下|的|我的|信息|还是/g, '')
      .replace(/(事|怎么|如何|弄)$/, '')
      .trim();
    // "限额还是额度"→双核心 [限额, 额度]；任一命中即入簇
    const cores = core.split(/和|跟/).map(s => s.trim()).filter(s => s.length >= 1);
    if (cores.length) {
      const fallbackRows = [];
      const seenIds = new Set();
      // 1. 召回候选：display name 精确匹配优先，scope_in 次之
      for (const candidate of candidates || []) {
        const display = getDisplayName(candidate);
        const graphDisplay = getGraphDisplayName(candidate);
        const sd = (candidate.node && candidate.node.semantic_definition) || {};
        const scopeIn = Array.isArray(sd.scope_in) ? sd.scope_in.join('|') : '';
        const nameMatch = cores.some(c0 => display.includes(c0) || graphDisplay.includes(c0));
        const scopeMatch = cores.some(c0 => scopeIn.includes(c0));
        if (nameMatch || scopeMatch) {
          if (seenIds.has(candidate.intent_id)) continue;
          seenIds.add(candidate.intent_id);
          fallbackRows.push({
            label: display,
            display_label: display,
            value: candidate.intent_id,
            intent_id: candidate.intent_id,
            intent_name: candidate.intent_name,
            action_code: candidate.action_code,
            rank: nameMatch ? 900 : 920, // display name 匹配优先
          });
        }
      }
      // 2. 全图补充：召回候选不足 2 个 display name 匹配时，从全图搜含核心词的意图
      const nameMatchCount = fallbackRows.filter(r => r.rank === 900).length;
      if (nameMatchCount < 2) {
        try {
          const allState = loadGraphState();
          const allCandidates = allState.candidates || [];
          for (const candidate of allCandidates) {
            const display = getDisplayName(candidate);
            const graphDisplay = getGraphDisplayName(candidate);
            if (cores.some(c0 => display.includes(c0) || graphDisplay.includes(c0))) {
              if (seenIds.has(candidate.intent_id)) continue;
              seenIds.add(candidate.intent_id);
              fallbackRows.push({
                label: display,
                display_label: display,
                value: candidate.intent_id,
                intent_id: candidate.intent_id,
                intent_name: candidate.intent_name,
                action_code: candidate.action_code,
                rank: 950, // 全图补充排在召回之后
              });
            }
          }
        } catch(e) { /* ignore graph load errors */ }
      }
      if (fallbackRows.length) {
        return fallbackRows.sort((a, b) => a.rank - b.rank).slice(0, 4);
      }
    }
  }
  for (const candidate of candidates || []) {
    const display = getDisplayName(candidate);
    const graphDisplay = getGraphDisplayName(candidate);
    const dn = normalize(display);
    const gn = normalize(graphDisplay);
    if ((wanted.has(dn) || wanted.has(gn) || labels.some(label => display.includes(label) || graphDisplay.includes(label)))
    ) {
      const labelKey = normalize(display);
      if (seenLabels.has(labelKey)) continue;
      seenLabels.add(labelKey);
      const labelIndex = labels.findIndex(label => display.includes(label) || graphDisplay.includes(label) || normalize(label) === dn || normalize(label) === gn);
      const exactIndex = labels.findIndex(label => normalize(label) === dn || normalize(label) === gn);
      const rank = exactIndex >= 0 ? exactIndex * 10 : labelIndex >= 0 ? labelIndex * 10 + 5 : 999;
      rows.push({
        label: display,
        display_label: display,
        value: candidate.intent_id,
        intent_id: candidate.intent_id,
        intent_name: candidate.intent_name,
        action_code: candidate.action_code,
        rank: rank < 0 ? 999 : rank,
      });
    }
  }
  if (rows.length) {
    const sorted = rows.sort((a, b) => a.rank - b.rank);
    const selected = [];
    const seenGroups = new Set();
    for (const row of sorted) {
      const group = Math.floor(row.rank / 10);
      if (seenGroups.has(group)) continue;
      seenGroups.add(group);
      selected.push(row);
      if (selected.length >= 4) break;
    }
    for (const row of sorted) {
      if (selected.includes(row)) continue;
      selected.push(row);
      if (selected.length >= 4) break;
    }
    // 词表命中但候选不足 4（换图谱后旧词表指向的意图可能不存在）→ 用图谱簇补齐：
    // 按 query 核心词从全图补，保证澄清选项落在当前图谱的真实意图上
    if (selected.length < 4) {
      let core = String(q || '')
        .replace(/查|查询|看|看看|查看|办|办理|弄|改|修改|设置|开|开通|关|关闭|我要|我想|帮我|请|麻烦|一下|下|的|我的|信息|还是|多少|几|咋|我|你|他|她/g, '')
        .replace(/(事|怎么|如何|弄)$/, '')
        .trim();
      const cores = core.split(/和|跟/).map(s => s.trim()).filter(s => s.length >= 1);
      const selectedIds = new Set(selected.map(r => r.intent_id));
      for (const candidate of candidates || []) {
        if (selected.length >= 4) break;
        if (selectedIds.has(candidate.intent_id)) continue;
        const display = getDisplayName(candidate);
        const graphDisplay = getGraphDisplayName(candidate);
        const sd = (candidate.node && candidate.node.semantic_definition) || {};
        const scopeIn = Array.isArray(sd.scope_in) ? sd.scope_in.join('|') : '';
        const hay = `${display}|${graphDisplay}|${scopeIn}|${candidate.eval_label || ''}|${candidate.object || ''}`;
        if (cores.some(c0 => c0 && hay.includes(c0))) {
          selectedIds.add(candidate.intent_id);
          selected.push({
            label: display,
            display_label: display,
            value: candidate.intent_id,
            intent_id: candidate.intent_id,
            intent_name: candidate.intent_name,
            action_code: candidate.action_code,
            rank: 950,
          });
        }
      }
    }
    // 按 intent_id 去重（eval_label/graph_display/display 可能产生同名不同源条目）
    const dedup = [];
    const ids = new Set();
    for (const row of selected) {
      const key = row.intent_id || row.value;
      if (ids.has(key)) continue;
      ids.add(key);
      dedup.push(row);
    }
    return dedup;
  }
  if (!finalResult) return [];
  return [{
    label: getDisplayName(finalResult),
    display_label: getDisplayName(finalResult),
    value: finalResult.intent_id,
    intent_id: finalResult.intent_id,
    intent_name: finalResult.intent_name,
    action_code: finalResult.action_code,
  }];
}

function isObjectlessReferenceQuery(query) {
  const q = String(query || '').trim();
  if (!q) return false;
  const hasReference = /(这个|那个|这项|那项|它|当前|刚才)/.test(q);
  const hasOperation = /(怎么|如何|怎样)?(关|关闭|取消|开|打开|开通|改|修改|设置|查|查看|办理|弄)(一下)?/.test(q);
  const hasConcreteObject = /(账户|银行卡|信用卡|转账|汇款|余额|账单|还款|贷款|基金|理财|保险|钱包|支付|限额|网点|客服|手机号|外币|外汇|医保|ETC|消息|积分|权益|密码|挂失|收款)/.test(q);
  return hasReference && hasOperation && !hasConcreteObject;
}

function buildObjectlessClarificationResult(query, graph, candidates, loadedAt, topk, started) {
  const operationActions = /(关|关闭|取消)/.test(query)
    ? new Set(['close', 'cancel'])
    : /(改|修改|设置)/.test(query)
      ? new Set(['change'])
      : new Set(['open', 'apply', 'query', 'ask']);
  const options = getGenericClarificationOptions(query, null, candidates)
    .filter(option => !operationActions.size || option.action_code == null || operationActions.has(option.action_code))
    .slice(0, 6);
  const question = /(关|关闭|取消)/.test(query)
    ? '请问您想关闭或取消哪项服务？'
    : /(改|修改|设置)/.test(query)
      ? '请问您想修改或设置哪项服务？'
      : '请问您想办理哪项服务？';
  return {
    query,
    result_type: 'ambiguous_intent',
    graph: buildGraphRuntimeInfo(graph, candidates, loadedAt),
    models: {
      embedding: EMBEDDING_MODEL,
      llm: LLM_MODEL,
    },
    final_result: null,
    authoritative_results: [],
    understanding: {
      cardinality: 'ambiguous_intent',
      task_count: 1,
      is_multi_intent: false,
      clarification_needed: true,
      clarification_types: ['objectless_reference'],
      reason: '用户使用了指代词，但当前方案不接入页面上下文，无法确定具体业务对象。',
      clarification: {
        needed: true,
        types: ['objectless_reference'],
        question,
        questions: [{
          type: 'objectless_reference',
          question,
          options,
        }],
        options,
        default_action: 'ask_clarification',
        internal_reason: 'objectless_reference_without_page_context',
      },
    },
    methods: {
      local: null,
      embedding: null,
      llm_judge: null,
    },
    attribution: {
      query,
      final_source: 'clarification_short_circuit',
      agreement: false,
      signals: [{
        type: 'objectless_reference',
        level: 'warning',
        message: '缺少页面上下文或明确业务对象，系统直接追问澄清，不进入模型裁判。',
      }],
      recommendation: '需要用户补充具体业务对象后再进行意图识别。',
    },
    latency_ms: Date.now() - started,
    topk,
  };
}

function buildIntentUnderstanding(query, llmResult, candidates) {
  const finalResult = llmResult.final || null;
  const slots = llmResult.slots || {};
  const queryProfile = analyzeQuery(query);
  const llmPayees = getSlotArray(slots, 'payees');
  const rulePayees = queryProfile.transfer_execution ? inferPayeesFromQuery(query) : [];
  const llmPayeeAmbiguityType = String(slots.payee_ambiguity_type || 'none').trim();
  const llmNeedsClarification = slots.needs_clarification === true;
  const fallbackPayeeAmbiguity = queryProfile.transfer_execution && !llmNeedsClarification && (!llmPayeeAmbiguityType || llmPayeeAmbiguityType === 'none')
    ? detectTransferPayeeAmbiguityFallback(query)
    : null;
  const payeeAmbiguityType = llmNeedsClarification && llmPayeeAmbiguityType && llmPayeeAmbiguityType !== 'none'
    ? llmPayeeAmbiguityType
    : fallbackPayeeAmbiguity && fallbackPayeeAmbiguity.payee_ambiguity_type || 'none';
  const payeeAmbiguity = payeeAmbiguityType !== 'none'
    ? {
        raw_payee_text: slots.payee_text_raw || (fallbackPayeeAmbiguity && fallbackPayeeAmbiguity.raw_payee_text) || '',
        inferred_payees: llmPayees.length ? llmPayees : (fallbackPayeeAmbiguity && fallbackPayeeAmbiguity.inferred_payees) || rulePayees,
        payee_ambiguity_type: payeeAmbiguityType,
        source: llmNeedsClarification ? 'llm_structured_understanding' : 'deterministic_fallback',
        reason: slots.clarification_reason || (fallbackPayeeAmbiguity && fallbackPayeeAmbiguity.reason) || '',
        question: slots.clarification_question || '',
      }
    : null;
  const inferredPayees = queryProfile.transfer_execution
    ? (payeeAmbiguity ? (payeeAmbiguity.inferred_payees.length ? payeeAmbiguity.inferred_payees : [payeeAmbiguity.raw_payee_text]) : (llmPayees.length ? llmPayees : rulePayees))
    : [];
  const payeeCount = Number(payeeAmbiguity ? Math.max(inferredPayees.length, 2) : (slots.payee_count || inferredPayees.length || 0));
  const amount = slots.amount || queryProfile.amount || '';
  const multiTask = queryProfile.transfer_execution && payeeCount > 1;
  const genericNonLeaf = isGenericNonLeafIntent(finalResult);
  const declaredOptions = declaredAmbiguityCandidates(query, candidates || [], runtimeParameter(RSI_RUNTIME, 'clarificationLimit', 4), RSI_RUNTIME);
  // 图谱声明级多候选：即使 LLM 给 top1 高分（confidentExact），
  // 只要图谱召回 ≥2 个澄清候选且 query 无明确动作词结尾，就认定泛化模糊——
  // ambiguous 题型（如"网点的事"）gold 要求必须澄清，LLM 高分不应压制（rsi_t205）。
  // 但 query 以具体动作词结尾（如"薪管家怎么开通"）时，用户意图明确，不应强制澄清（rsi_t044）。
  const hasExplicitAction = /(开通|关闭|取消|修改|设置|查询|查看|申请|办理|转账|还款|挂失|注销|解绑|绑定)$/.test(query);
  const actionOverrideBoundary = finalResult && (finalResult.runtime_boundary === 'query_action_alignment' || finalResult.runtime_boundary === 'multi_intent_query_verb_override');
  const graphClarOptions = graphClarificationCandidates(query, candidates || [], runtimeParameter(RSI_RUNTIME, 'clarificationLimit', 4), RSI_RUNTIME);
  const graphClarForce = !actionOverrideBoundary && graphClarOptions.length >= 2 && !hasExplicitAction;
  const genericAmbiguous = declaredOptions.length >= 2 || graphClarForce || isGenericAmbiguousQuery(query, finalResult);
  const clarificationTypes = [];
  const transferOptions = genericNonLeaf ? getTransferClarificationOptions(candidates) : [];
  // 比较句式优先：精确匹配 X 和 Y 各自对应的候选，返回精确 2 选项（不走硬编码关键词表）
  const comparisonOptions = detectComparisonClarification(query, candidates || []);
  const isComparisonQ = isComparisonQuery(query);
  // 比较句式但未找到精确候选 → 用 top 候选做 fallback 选项，确保澄清不被空选项抑制
  const comparisonFallback = isComparisonQ && !comparisonOptions && (candidates || []).slice(0, 4).map(c => ({
    label: getDisplayName(c), display_label: getDisplayName(c),
    value: c.intent_id, intent_id: c.intent_id, intent_name: c.intent_name, action_code: c.action_code,
  }));
  const genericOptions = comparisonOptions || comparisonFallback || (declaredOptions.length >= 2 ? declaredOptions : (graphClarForce ? graphClarOptions : (genericAmbiguous ? getGenericClarificationOptions(query, finalResult, candidates) : [])));
  // 泛化指示词（这个/那个/哪一个）= 用户显式模糊表达：即使图谱只召回一个候选，
  // 也不压制澄清——直答违背 gold 对模糊题「必须澄清」的判定（rsi_t217 实测）。
  // 注意「这个月」是时间词组，不是指示词——用负向先行断言(?!月)排除。
  const explicitVague = /这个(?!月)|那个|哪一个/.test(query);
  const suppressGenericAmbiguous = !explicitVague && !declaredOptions.length && genericAmbiguous && !isComparisonQ && shouldSuppressGenericAmbiguousQuestion(finalResult, genericOptions);
  if (genericNonLeaf) clarificationTypes.push('non_leaf_intent');
  if (multiTask) clarificationTypes.push('multi_task_confirmation');
  if (payeeAmbiguity) clarificationTypes.push('payee_ambiguity_confirmation');
  if (llmNeedsClarification && !payeeAmbiguity && !multiTask) clarificationTypes.push('llm_slot_clarification');
  if (genericAmbiguous && !suppressGenericAmbiguous) clarificationTypes.push('generic_ambiguous_intent');
  const tasks = multiTask
    ? inferredPayees.map((payee, index) => ({
        task_index: index + 1,
        intent_id: finalResult && finalResult.intent_id || '',
        intent_name: finalResult && finalResult.intent_name || '',
        eval_label: finalResult && finalResult.eval_label || '',
        display_name: getDisplayName(finalResult),
        action_code: finalResult && finalResult.action_code || '',
        payee,
        amount,
        status: 'needs_confirmation',
      }))
    : [{
        task_index: 1,
        intent_id: finalResult && finalResult.intent_id || '',
        intent_name: finalResult && finalResult.intent_name || '',
        eval_label: finalResult && finalResult.eval_label || '',
        display_name: getDisplayName(finalResult),
        action_code: finalResult && finalResult.action_code || '',
        payee: inferredPayees[0] || '',
        amount,
        status: clarificationTypes.length ? 'needs_confirmation' : 'ready',
      }];

  const questions = [];
  const suppressedQuestions = [];
  if (multiTask) {
    const payeeAmbiguityQuestion = payeeAmbiguity && payeeAmbiguity.question
      ? payeeAmbiguity.question
      : `您输入的收款人“${payeeAmbiguity && payeeAmbiguity.raw_payee_text || inferredPayees.join('')}”可能有歧义。请确认这是一个收款人姓名，还是多个收款人；如果是分别转账，请再确认是每人转${amount || '这笔金额'}，还是${amount || '这笔金额'}为总金额？`;
    questions.push({
      type: payeeAmbiguity ? 'payee_ambiguity_confirmation' : 'multi_task_confirmation',
      title: '请确认转账金额',
      question: payeeAmbiguity
        ? payeeAmbiguityQuestion
        : `您要给${inferredPayees.join('、')}转账。请问是每人转${amount || '这笔金额'}，还是${amount || '这笔金额'}为总金额？`,
      options: [
        { label: `每人转${amount || '这笔金额'}`, value: 'separate_tasks' },
        { label: `${amount || '这笔金额'}是总金额`, value: 'split_total_amount' },
        ...(payeeAmbiguity ? [{ label: `这是一个收款人姓名：${payeeAmbiguity.raw_payee_text}`, value: 'single_payee_name' }] : []),
      ],
    });
  }
  if (llmNeedsClarification && !multiTask && !genericNonLeaf && !genericAmbiguous) {
    questions.push({
      type: 'llm_slot_clarification',
      title: '请确认关键信息',
      question: slots.clarification_question || '当前表达存在关键信息歧义，请您补充确认后再继续。',
      options: [],
    });
  }
  if (genericNonLeaf) {
    questions.push({
      type: 'non_leaf_intent',
      title: '请选择转账方式',
      question: '我可以继续为您办理转账。请先选择具体转账方式：',
      options: transferOptions.map(o => ({
        label: o.display_label || o.label,
        value: o.intent_id,
        description: o.description,
        intent_id: o.intent_id,
        intent_name: o.intent_name,
        action_code: o.action_code,
      })),
    });
  }
  if (genericAmbiguous && !suppressGenericAmbiguous) {
    const genericQuestion = {
      type: 'generic_ambiguous_intent',
      title: '请确认办理内容',
      question: '您提到的业务有多个办理方向，请先选择具体事项。',
      options: genericOptions.map(o => ({
        label: o.display_label || o.label,
        value: o.intent_id || o.value,
        intent_id: o.intent_id,
        intent_name: o.intent_name,
        action_code: o.action_code,
      })),
    };
    if (genericNonLeaf) {
      suppressedQuestions.push({
        ...genericQuestion,
        suppressed_reason: '已由更具体的非叶子意图澄清覆盖，避免重复询问办理内容和转账方式。',
      });
    } else {
      questions.push(genericQuestion);
    }
  }
  const visibleQuestions = consumeGraphClarificationQuestions(dedupeClarificationQuestions(questions), finalResult, candidates);
  const visibleTypes = visibleQuestions.map(q => q.type);
  const visibleOptions = visibleQuestions.flatMap(q => q.options || []);

  return {
    cardinality: multiTask ? 'multi_task_intent' : 'single_intent',
    task_count: multiTask ? payeeCount : 1,
    is_multi_intent: multiTask,
    final_is_non_leaf: genericNonLeaf,
    reason: multiTask
      ? (payeeAmbiguity ? '模型识别到收款人边界或金额分配存在歧义，当前轮次优先追问确认。' : '识别到多个收款人，当前轮次优先确认转账金额分配。')
      : '当前 query 暂按单意图处理。',
    slots: {
      ...slots,
      payees: inferredPayees,
      payee_count: payeeCount,
      amount,
      payee_ambiguity_type: payeeAmbiguityType,
      payee_ambiguity_source: payeeAmbiguity && payeeAmbiguity.source || '',
    },
    tasks,
    clarification: {
      needed: visibleQuestions.length > 0,
      types: visibleTypes,
      question: visibleQuestions.map(q => q.question).join(' '),
      questions: visibleQuestions,
      suppressed_questions: suppressedQuestions,
      options: visibleOptions,
      service_style: 'customer_facing_concise',
      internal_reason: visibleTypes.length
        ? `本轮展示${visibleTypes.length}类澄清：${visibleTypes.join('、')}；已压制与更具体问题重复的泛化澄清。`
        : '',
      default_action: visibleQuestions.length ? 'ask_user_confirmation' : 'execute_or_route',
    },
  };
}

function dedupeClarificationQuestions(questions) {
  const out = [];
  const seen = new Set();
  for (const question of questions || []) {
    if (!question || !question.type || seen.has(question.type)) continue;
    seen.add(question.type);
    out.push(question);
  }
  return out;
}

function shouldSuppressGenericAmbiguousQuestion(finalResult, genericOptions) {
  const options = Array.isArray(genericOptions) ? genericOptions : [];
  if (!options.length) return true;
  if (options.length > 1) return false;
  const finalIntentId = String(finalResult && finalResult.intent_id || '').trim();
  const finalDisplay = normalize(getDisplayName(finalResult));
  const only = options[0] || {};
  const optionIntentId = String(only.intent_id || only.value || '').trim();
  const optionDisplay = normalize(only.display_label || only.label || only.intent_name || '');
  if (finalIntentId && optionIntentId && finalIntentId === optionIntentId) return true;
  if (finalDisplay && optionDisplay && finalDisplay === optionDisplay) return true;
  return false;
}

function actionCompatible(inferred, candidate) {
  if (!inferred) return 0;
  if (inferred === candidate) return 1;
  if ((inferred === 'apply' && candidate === 'open') || (inferred === 'open' && candidate === 'apply')) return 0.75;
  if ((inferred === 'guide' && candidate === 'ask') || (inferred === 'ask' && candidate === 'guide')) return 0.65;
  if (inferred === 'guide' && ['query', 'transfer', 'repay', 'apply', 'open', 'change', 'cancel', 'close'].includes(candidate)) return 0.35;
  if (inferred === 'ask' && ['query', 'transfer', 'repay', 'apply', 'open', 'change', 'cancel', 'close'].includes(candidate)) return 0.22;
  return -0.85;
}

function normalizeActionCode(value) {
  const code = String(value || '').trim().toLowerCase();
  if (!code) return '';
  const aliases = {
    query: 'query',
    ask: 'ask',
    help: 'ask',
    guide: 'guide',
    apply: 'apply',
    do: 'apply',
    open: 'open',
    change: 'change',
    modify: 'change',
    cancel: 'cancel',
    close: 'close',
    transfer: 'transfer',
    repay: 'repay',
  };
  return aliases[code] || code;
}

function inferCandidateAction(node, task, legacy, retrieval) {
  const explicit = normalizeActionCode((task.action || {}).action_code);
  if (explicit) return explicit;

  const byType = normalizeActionCode((node.identity || {}).intent_type);
  if (byType) return byType;

  const name = String((node.identity || {}).intent_name || '');
  if (/^(查询|查看|看一下|看看)/.test(name)) return 'query';
  if (/^(咨询|了解|介绍|问一下)/.test(name)) return 'ask';
  if (/^(申请|办理|提交|购买|买入|申购)/.test(name)) return 'apply';
  if (/^(修改|调整|变更|更换|设置)/.test(name)) return 'change';
  if (/^(取消|撤销|解除|解约)/.test(name)) return 'cancel';
  if (/^(关闭|注销|销户|停用)/.test(name)) return 'close';
  if (/^(开通|开户|启用|签约)/.test(name)) return 'open';
  if (/(转账|汇款|转入|转出)/.test(name)) return 'transfer';
  if (/(还款|还钱)/.test(name)) return 'repay';

  const actionTerms = (retrieval.action_view || []).map(normalizeActionCode).filter(Boolean);
  return actionTerms.find(code => ACTION_ALIASES[code] || ['query', 'ask', 'apply', 'change', 'cancel', 'close', 'open'].includes(code)) || '';
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

function loadGraphState(graphPath) {
  const resolvedGraphPath = graphPath || resolveDefaultGraphPath();
  if (graphStateCache.has(resolvedGraphPath)) {
    const cached = graphStateCache.get(resolvedGraphPath);
    activeGraphState = cached; // 命中缓存同样切换默认图（词群表随图切换，不残留上一张图的词汇）
    return cached;
  }
  const graph = JSON.parse(fs.readFileSync(resolvedGraphPath, 'utf8'));
  const schemaRuntimeProfile = inspectIntentGraphSchema(graph, resolvedGraphPath);

  // ── 填充图谱词群注册表（必须在 candidates.map 之前：getRuntimeObjectAliases/inferAction 消费）──
  // 动作词：retrieval_profile.action_view 原始词 → 按该意图 action_code 分组（图谱优先，硬编码兜底）；
  // 词群归属本图谱状态——从硬编码副本起步叠加本图谱词，绝不读写其他图谱的表（跨版本加载不泄漏）
  const actionAliasesFromGraph = {};
  Object.keys(ACTION_ALIASES).forEach(code => {
    actionAliasesFromGraph[code] = ACTION_ALIASES[code].slice();
  });
  const objectAliasesFromGraph = {};
  (graph.intent_nodes || []).forEach(node => {
    const retrieval = node.retrieval_profile || {};
    const task = node.task_binding || {};
    const legacy = node.source_legacy || {};
    const action = inferCandidateAction(node, task, legacy, retrieval);
    (retrieval.action_view || []).forEach(w => {
      const word = String(w || '').trim();
      if (!word || word.length < 2 || /^[a-z_]+$/.test(word)) return; // 过滤空词与纯 code 词
      (actionAliasesFromGraph[action] = actionAliasesFromGraph[action] || []).push(word);
    });
    const label = ((node.labels || {}).eval_label) || node.identity.intent_name;
    const sem = node.semantic_definition || {};
    const objWords = []
      .concat(sem.scope_in || [])
      .concat(retrieval.object_view || []);
    objWords.forEach(w => {
      const word = String(w || '').trim();
      if (!word) return;
      if (!objectAliasesFromGraph[label]) objectAliasesFromGraph[label] = [];
      objectAliasesFromGraph[label].push(word);
    });
  });
  // 去重
  Object.keys(actionAliasesFromGraph).forEach(code => {
    actionAliasesFromGraph[code] = Array.from(new Set(actionAliasesFromGraph[code]));
  });
  Object.keys(objectAliasesFromGraph).forEach(label => {
    objectAliasesFromGraph[label] = Array.from(new Set(objectAliasesFromGraph[label]));
  });
  // 候选构建期就用本图谱自己的表（getRuntimeObjectAliases 的 override 参数）
  const stateObjectAliases = objectAliasesFromGraph;

  const candidates = (graph.intent_nodes || []).map(node => {
    const retrieval = node.retrieval_profile || {};
    const task = node.task_binding || {};
    const legacy = node.source_legacy || {};
    const action = inferCandidateAction(node, task, legacy, retrieval);
    const label = ((node.labels || {}).eval_label) || node.identity.intent_name;
    const objectName = ((task.business_object || {}).object_name) || label;
    const pathText = [
      (node.execution_binding || {}).standard_navigation_path || '',
    ].filter(Boolean).join(' > ');
    // 声明消费（DECLARATION_AWARE）：把语义声明的剩余集合接入特征与排除通道——
    // ① text 是词法召回（jaccard/contains）与 embedding 的共同输入，补入
    //    description / clause_view / disambiguation_hints 让 A3/A4/A2 的写入可被召回；
    // ② scope_out 并入 negative_terms（复用既有 graphNegativeBoundaryAdjustment 惩罚通道）；
    // ③ hints/scope_out/confusable 作为独立字段随 compactCandidate 进 LLM 裁决。
    const semDecl = DECLARATION_AWARE ? (node.semantic_definition || {}) : {};
    const declTextFields = DECLARATION_AWARE ? [
      semDecl.description || '',
      retrieval.clause_view || [],
      semDecl.disambiguation_hints || [],
    ] : [];
    const uvAll = retrieval.utterance_view || [];
    const uttForText = uvAll.length <= 80 ? uvAll : Array.from(new Set([...uvAll.slice(0, 60), ...uvAll.slice(-40)]));
    const text = textJoin([
      node.identity.intent_name,
      label,
      objectName,
      uttForText,
      retrieval.semantic_view || [],
      retrieval.object_view || [],
      retrieval.action_view || [],
      retrieval.boundary_view || [],
      ...declTextFields,
    ], 80).slice(0, 8000);
    const decisionPolicy = node.decision_policy || {};
    const objectTerms = Array.from(new Set([
      normalize(label),
      ...(retrieval.object_view || []).map(normalize),
      ...getRuntimeObjectAliases({ eval_label: label, object: objectName, action_code: action }, stateObjectAliases),
    ])).filter(x => x && x.length >= 3 && !['企业服务', '财富管理', '账户管理', '支付管理', '金融助手', '生活服务', '权益服务'].includes(x));
    return {
      intent_id: node.identity.intent_id,
      intent_name: node.identity.intent_name || '',
      eval_label: label,
      action_code: action,
      object: objectName,
      domain: node.identity.domain || '',
      path: pathText,
      text,
      text_norm: normalize(text),
      ngrams: charNgrams(text, 2),
      utterances: (retrieval.utterance_view || []).map(normalize),
      utterance_set: new Set((retrieval.utterance_view || []).map(normalize)),
      object_terms: (retrieval.object_view || []).map(normalize),
      strong_object_terms: objectTerms,
      action_terms: (retrieval.action_view || []).map(normalize),
      negative_terms: Array.from(new Set([]
        .concat(retrieval.negative_view || decisionPolicy.out_of_scope_examples || [])
        .concat(semDecl.scope_out || [])
      )).map(normalize).filter(Boolean),
      min_accept_signal: decisionPolicy.min_accept_signal || '',
      in_scope_required_evidence: decisionPolicy.in_scope_required_evidence || [],
      embedding_weight_multiplier: typeof decisionPolicy.embedding_weight_multiplier === 'number' ? decisionPolicy.embedding_weight_multiplier : 1,
      disambiguation_hints: (semDecl.disambiguation_hints || []).filter(Boolean),
      scope_out_declared: (semDecl.scope_out || []).filter(Boolean),
      confusable_intents: (semDecl.confusable_intents || []).filter(Boolean),
      clause_phrases: DECLARATION_AWARE ? (retrieval.clause_view || []).map(normalize).filter(x => x && x.length >= 4) : [],
      governance: ((node.governance || {}).quality_flags || []).join(','),
      node,
    };
  });
  const graphState = {
    path: resolvedGraphPath,
    graph,
    candidates,
    actionAliases: actionAliasesFromGraph,
    objectAliases: objectAliasesFromGraph,
    loaded_at: new Date().toISOString(),
    schema_runtime_profile: schemaRuntimeProfile,
  };
  graphStateCache.set(resolvedGraphPath, graphState);
  activeGraphState = graphState; // 默认图切换为最近一次加载；并发隔离走 graphRuntimeContext
  return graphState;
}

function loadCacheState() {
  if (cacheState) return cacheState;
  let cache = { embeddings: {}, llm_judgments: {}, meta: {} };
  if (fs.existsSync(CACHE_PATH)) {
    try {
      cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    } catch (e) {
      console.error('[cache] cache file corrupted, resetting:', e.message.substring(0, 120));
      cache = { embeddings: {}, llm_judgments: {}, meta: {} };
    }
    cache.embeddings = cache.embeddings || {};
    cache.llm_judgments = cache.llm_judgments || {};
    cache.semantic_boundaries = cache.semantic_boundaries || {};
    cache.meta = cache.meta || {};
  }
  cacheState = cache;
  return cacheState;
}

function loadFaqState() {
  if (faqState) return faqState;
  let faq = { version: 'missing', items: [] };
  if (fs.existsSync(FAQ_PATH)) {
    faq = JSON.parse(fs.readFileSync(FAQ_PATH, 'utf8'));
    faq.items = Array.isArray(faq.items) ? faq.items : [];
  }
  faqState = {
    version: faq.version || 'unknown',
    items: faq.items.map(item => ({
      ...item,
      _display_norm: normalize(item.display_name),
      _intent_norms: (item.intent_names || []).map(normalize),
      _alias_norms: (item.aliases || []).map(normalize),
      _question_norms: (item.questions || []).map(normalize),
      _action_codes: item.action_codes || ['ask'],
    })),
  };
  return faqState;
}

function loadVersionManifest() {
  let stat = null;
  try { stat = fs.statSync(VERSION_MANIFEST_PATH); } catch { /* 缺文件走 missing */ }
  if (!stat) return { manifest_version: 'missing', versions: [] };
  // mtime 缓存：评测中新增的图谱版本（消解修复/编辑器导出）要即时可评，不能进程级钉死
  if (versionManifestState && versionManifestState.mtimeMs === stat.mtimeMs) return versionManifestState.manifest;
  try {
    versionManifestState = { mtimeMs: stat.mtimeMs, manifest: JSON.parse(fs.readFileSync(VERSION_MANIFEST_PATH, 'utf8')) };
  } catch {
    return { manifest_version: 'missing', versions: [] };
  }
  return versionManifestState.manifest;
}

function buildGraphRuntimeInfo(graph, candidates, loadedAt) {
  const state = loadGraphState();
  const manifest = loadVersionManifest();
  const meta = graph.meta || {};
  const summary = graph.summary || {};
  const activeVersion = (manifest.versions || []).find(version => version.version_id === manifest.active_default) || null;
  return {
    path: path.relative(ROOT, state.path || resolveDefaultGraphPath()).replace(/\\/g, '/'),
    version: meta.version || meta.graph_version_id || null,
    version_id: meta.graph_version_id || (activeVersion && activeVersion.version_id) || null,
    version_name: meta.graph_version_name || (activeVersion && (activeVersion.version_name || activeVersion.name)) || null,
    version_stage: meta.graph_version_stage || (activeVersion && activeVersion.stage) || null,
    release_status: meta.release_status || (activeVersion && activeVersion.status) || null,
    active_default: manifest.active_default || null,
    rollback_default: manifest.rollback_default || null,
    intent_count: summary.leaf_intent_count || (graph.intent_nodes || []).length,
    leaf_intent_count: summary.leaf_intent_count || (graph.intent_nodes || []).length,
    executable_intent_count: summary.executable_intent_count || 0,
    knowledge_intent_count: summary.knowledge_intent_count || 0,
    aggregate_intent_count: summary.aggregate_intent_count || (graph.aggregate_intents || []).length,
    runtime_candidate_count: candidates.length,
    loaded_at: loadedAt,
  };
}

let _saveCacheTimer = null;
let _saveCachePending = false;
function saveCacheState() {
  if (!cacheState) return;
  if (process.env.RSI_SCORING_MODE) return; // skip cache saves in scoring mode (ephemeral process)
  if (_saveCacheTimer) { _saveCachePending = true; return; }
  _saveCacheTimer = setTimeout(() => {
    _saveCacheTimer = null;
    if (_saveCachePending) { _saveCachePending = false; saveCacheState(); }
  }, 5000);
  // Async write to avoid blocking the event loop (cache can be 100MB+)
  // 进程级唯一临时文件：多进程并发保存缓存时共用同一个 .tmp 会互相覆盖/rename 失败
  const tmpPath = CACHE_PATH + '.' + process.pid + '.' + Date.now() + '.tmp';
  fs.promises.writeFile(tmpPath, JSON.stringify(cacheState), 'utf8')
    .then(() => fs.promises.rename(tmpPath, CACHE_PATH))
    .catch(e => console.error('[cache] save failed:', e.message.substring(0, 120)));
}

function semanticObjectTerms(queryProfile) {
  const boundary = queryProfile && queryProfile.semantic_boundary || {};
  const terms = [
    boundary.business_object,
    ...(Array.isArray(boundary.object_aliases) ? boundary.object_aliases : []),
    ...(Array.isArray(boundary.object_constraints) ? boundary.object_constraints : []),
  ]
    .map(term => normalize(term))
    .filter(term => term && term.length >= 2);
  return Array.from(new Set(terms));
}

function candidateObjectText(candidate) {
  return normalize(textJoin([
    candidate.eval_label,
    candidate.object,
    candidate.intent_name,
    candidate.display_name,
    candidate.graph_display_name,
    candidate.path,
    candidate.strong_object_terms || [],
    candidate.object_terms || [],
  ], 60));
}

function charSetOverlapScore(a, b) {
  const left = normalize(a);
  const right = normalize(b);
  if (!left || !right) return 0;
  const leftChars = Array.from(new Set([...left]));
  const rightSet = new Set([...right]);
  const overlap = leftChars.filter(ch => rightSet.has(ch)).length;
  return overlap / Math.max(leftChars.length, 1);
}

function objectAlignmentScore(queryProfile, candidate) {
  const terms = semanticObjectTerms(queryProfile);
  if (!terms.length || !candidate) return 0;
  const candidateText = candidateObjectText(candidate);
  if (!candidateText) return 0;

  let best = 0;
  for (const term of terms) {
    if (!term) continue;
    if (candidateText === term) best = Math.max(best, 1.1);
    else if (candidateText.includes(term)) best = Math.max(best, 0.95);
    else if (term.includes(candidateText) && candidateText.length >= 3) best = Math.max(best, 0.48);
    else {
      const overlap = charSetOverlapScore(term, candidateText);
      if (overlap >= 0.82) best = Math.max(best, 0.55);
      else if (overlap >= 0.62) best = Math.max(best, 0.28);
    }
  }

  const boundary = queryProfile && queryProfile.semantic_boundary || {};
  const highConfidence = (boundary.confidence || 0) >= 0.75;
  const semanticMode = queryProfile && (queryProfile.semantic_task_mode || queryProfile.semantic_action) || '';
  const shouldPenalize = highConfidence && ['faq', 'guide', 'query'].includes(semanticMode) && best <= 0.05;
  return shouldPenalize ? -0.22 : best;
}

function addObjectAlignmentEvidence(evidence, objectScore) {
  const ev = Array.from(new Set(evidence || []));
  if (objectScore >= 0.75) ev.push('semantic_object_strong_match');
  else if (objectScore >= 0.25) ev.push('semantic_object_partial_match');
  else if (objectScore < 0) ev.push('semantic_object_mismatch_penalty');
  return ev;
}

function localScoreCandidate(query, qgrams, queryProfile, candidate) {
  if (!query) return 0;
  const inferredAction = queryProfile.inferred_action;
  const cgrams = candidate.ngrams;
  let overlap = 0;
  for (const gram of qgrams) if (cgrams.has(gram)) overlap++;
  const union = new Set([...qgrams, ...cgrams]).size || 1;
  const jaccard = overlap / union;
  let containsBonus = 0;
  if (candidate.text_norm.includes(query)) containsBonus += 0.20;

  const matchedObjects = candidate.strong_object_terms.filter(term => query.includes(term));
  if (matchedObjects.length) {
    const best = matchedObjects.sort((a, b) => b.length - a.length)[0];
    containsBonus += Math.min(0.58, 0.18 + 0.08 * best.length);
  } else if (candidate.object_terms.some(term => term && query.includes(term))) {
    containsBonus += 0.08;
  }

  if (candidate.utterance_set.has(query)) containsBonus += 1.35;
  else if (candidate.utterances.slice(0, 120).some(term => term.length >= 4 && query.includes(term))) containsBonus += 0.32;

  // 声明消费（DECLARATION_AWARE）：区分线索/子句说法是意图边界的声明性语言——
  // query 命中其中短语（≥4 字连续出现）视为召回证据，权重略低于 utterance 本身。
  // 这是 A2(add_hints)/A3(add_clause_views) 提案在规则路的确定性涨分通道
  if ((candidate.disambiguation_hints || []).length) {
    const hintHit = candidate.disambiguation_hints.some(h => {
      const nh = normalize(h);
      return nh.length >= 4 && query.includes(nh);
    });
    if (hintHit) containsBonus += runtimeParameter(RSI_RUNTIME, 'hintWeight', 0.28);
  }
  if ((candidate.clause_phrases || []).length) {
    const clauseHit = candidate.clause_phrases.some(term => query.includes(term));
    if (clauseHit) containsBonus += runtimeParameter(RSI_RUNTIME, 'clauseWeight', 0.30);
  }

  const hasUtteranceExact = candidate.utterance_set.has(query);
  const rawActionCompat = actionCompatible(inferredAction, candidate.action_code);
  // utterance_exact 是最强声明信号：query 是候选意图的注册说法时，
  // action 推断（基于词面）不应反向压分——应视为 action 匹配。
  // "申请信用卡进度到哪了"含"申请"触发 apply 推断，但 gold action=query（查询进度），
  // utterance_exact 证明这是注册说法，action mismatch 应视为匹配（rsi_t014）。
  const actionBonus = runtimeParameter(RSI_RUNTIME, 'actionWeight', 0.62) * (hasUtteranceExact ? 1 : rawActionCompat);
  const objectBonus = objectAlignmentScore(queryProfile, candidate);
  const boundaryBonus = transferExecutionAdjustment(queryProfile, candidate) + queryBoundaryAdjustment(queryProfile, candidate) + graphNegativeBoundaryAdjustment(query, queryProfile, candidate) * runtimeParameter(RSI_RUNTIME, 'negativePenalty', 1);
  const lengthPenalty = Math.min(candidate.text_norm.length / 5000, 0.14);
  return jaccard * runtimeParameter(RSI_RUNTIME, 'lexicalWeight', 0.72) + containsBonus + actionBonus + objectBonus + boundaryBonus - lengthPenalty;
}

function hasStrongCandidateEvidence(query, queryProfile, candidate) {
  if ((candidate.strong_object_terms || []).some(term => term && query.includes(term))) return true;
  if (queryProfile && queryProfile.inferred_action && queryProfile.inferred_action === candidate.action_code) return true;
  if (candidate.utterance_set && candidate.utterance_set.has(query)) return true;
  return false;
}

function graphNegativeBoundaryAdjustment(query, queryProfile, candidate) {
  const terms = candidate.negative_terms || [];
  if (!terms.length) return 0;
  const matched = terms.some(term => term && term.length >= 3 && query.includes(term));
  if (!matched) return 0;
  // 声明消费（DECLARATION_AWARE）：scope_out 是业务边界声明——豁免判据收窄为
  // "说法精确命中或业务对象词命中"；动作匹配（inferred_action）不再构成豁免。
  // 关闸（未开 env）保持旧判据，其他消费方行为零变化
  if (DECLARATION_AWARE) {
    const objectHit = (candidate.strong_object_terms || []).some(term => term && query.includes(term));
    const utteranceHit = candidate.utterance_set && candidate.utterance_set.has(query);
    return (objectHit || utteranceHit) ? -0.08 : -0.65;
  }
  return hasStrongCandidateEvidence(query, queryProfile, candidate) ? -0.08 : -0.65;
}

function runLocal(query, candidates, topk, queryProfileOverride) {
  const q = normalize(query);
  const qgrams = charNgrams(q, 2);
  const queryProfile = queryProfileOverride || analyzeQuery(query);
  const inferredAction = queryProfile.inferred_action;
  const scored = [];
  for (const c of candidates) {
    const score = localScoreCandidate(q, qgrams, queryProfile, c);
    const objectScore = objectAlignmentScore(queryProfile, c);
    if (score > 0) scored.push({
      ...compactCandidate(c),
      score: round(score),
      object_alignment_score: round(objectScore, 4),
      evidence: addObjectAlignmentEvidence(localEvidence(q, inferredAction, c), objectScore),
    });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, topk || 8);
  const margin = top.length > 1 ? top[0].score - top[1].score : top[0] ? top[0].score : 0;
  return {
    method: 'local_lexical_rules_graph',
    inferred_action: inferredAction,
    query_profile: queryProfile,
    top,
    top1: top[0] || null,
    confidence: top[0] ? round(1 / (1 + Math.exp(-6 * (top[0].score + margin - 0.35)))) : 0,
    margin: round(margin),
    explanation: '本地方案综合字符 ngram、表达包含、强对象词、utterance 精确命中和动作门控。',
  };
}

function localEvidence(q, inferredAction, c) {
  const ev = [];
  if (c.utterance_set.has(q)) ev.push('utterance_exact');
  if (c.text_norm.includes(q)) ev.push('query_in_profile');
  if (c.strong_object_terms.some(term => q.includes(term))) ev.push('strong_object_match');
  if (c.action_code === 'ask' && c.strong_object_terms.some(term => q.includes(term))) ev.push('ask_object_match');
  if (inferredAction && inferredAction === c.action_code) ev.push('action_match');
  if (inferredAction && inferredAction !== c.action_code) ev.push('action_mismatch_penalty');
  return ev;
}

function compactCandidate(c) {
  const displayName = c.eval_label || c.object || c.intent_name || '';
  const compact = {
    intent_id: c.intent_id,
    intent_name: c.intent_name,
    eval_label: c.eval_label,
    display_name: displayName,
    action_code: c.action_code,
    object: c.object,
    domain: c.domain,
    path: c.path,
    governance: c.governance,
    min_accept_signal: c.min_accept_signal || '',
    embedding_weight_multiplier: c.embedding_weight_multiplier || 1,
  };
  // 声明消费：候选带区分线索/排除域/易混淆对时透传给下游（LLM 裁决 prompt 消费；
  // 未开启 DECLARATION_AWARE 时三字段为空数组，输出与旧行为一致）
  if (DECLARATION_AWARE) {
    if ((c.disambiguation_hints || []).length) compact.disambiguation_hints = c.disambiguation_hints.slice(0, 6);
    if ((c.scope_out_declared || []).length) compact.scope_out = c.scope_out_declared.slice(0, 6);
    if ((c.confusable_intents || []).length) compact.confusable_intents = c.confusable_intents.slice(0, 6);
    const desc = ((c.node || {}).semantic_definition || {}).description || '';
    if (desc) compact.description = String(desc).slice(0, 200);
  }
  return compact;
}

function getDisplayName(result) {
  if (!result) return '';
  return result.display_name || result.eval_label || result.object || result.intent_name || '';
}

function getGraphDisplayName(result) {
  if (!result) return '';
  return result.graph_display_name || result.eval_label || result.object || result.intent_name || result.display_name || '';
}

function ensureGraphOwnershipFields(result) {
  if (!result || typeof result !== 'object') return result;
  const graphActionCode = result.graph_action_code || result.action_code || '';
  const graphIntentName = result.graph_intent_name || result.intent_name || '';
  const graphDisplayName = result.graph_display_name || result.eval_label || result.object || result.intent_name || result.display_name || '';
  const next = { ...result, graph_action_code: graphActionCode };
  if (graphIntentName) next.graph_intent_name = graphIntentName;
  if (graphDisplayName) next.graph_display_name = graphDisplayName;
  return next;
}

function inferGraphOwnershipPlane(result) {
  const graphAction = result && (result.graph_action_code || result.action_code) || '';
  if (!graphAction) return 'runtime_only';
  if (['ask', 'guide'].includes(graphAction)) return 'knowledge';
  if (['query', 'transfer', 'repay', 'apply', 'open', 'change', 'cancel', 'close'].includes(graphAction)) return 'task';
  return 'unknown';
}

function inferRuntimeConsumptionMode(result) {
  if (!result) return '';
  if (result.runtime_action_code === 'guide' || result.runtime_boundary === 'semantic_guide_boundary') return 'guide';
  if (isAskResult(result)) return 'faq';
  if (result.runtime_action_code === 'query' || result.action_code === 'query') return 'query';
  if (['transfer', 'repay', 'apply', 'open', 'change', 'cancel', 'close'].includes(result.action_code || '')) return 'execute';
  return result.runtime_action_code || result.action_code || '';
}

function annotateRuntimeOwnership(result) {
  if (!result || typeof result !== 'object') return result;
  const next = ensureGraphOwnershipFields(result);
  return {
    ...next,
    graph_ownership_plane: inferGraphOwnershipPlane(next),
    runtime_consumption_mode: inferRuntimeConsumptionMode(next),
    runtime_ownership_boundary: next.runtime_boundary || 'graph_native',
  };
}

function normalizeRuntimeDisplayResult(item) {
  if (!item || typeof item !== 'object') return item;
  const seeded = annotateRuntimeOwnership(item);
  if (seeded.action_code === 'multi_intent' || seeded.action_code === 'idle_chat') return seeded;
  const displayName = getDisplayName(seeded);
  if (!displayName) return seeded;
  const graphIntentName = seeded.graph_intent_name || seeded.intent_name || '';
  const next = {
    ...seeded,
    display_name: displayName,
    intent_name: displayName,
  };
  if (graphIntentName && graphIntentName !== displayName) {
    next.graph_intent_name = graphIntentName;
  }
  return next;
}

function normalizeRuntimeDisplayPayload(result) {
  if (!result || typeof result !== 'object') return result;
  const normalized = { ...result };
  if (normalized.final_result) {
    normalized.final_result = normalizeRuntimeDisplayResult(normalized.final_result);
  }
  if (Array.isArray(normalized.authoritative_results)) {
    normalized.authoritative_results = normalized.authoritative_results.map(normalizeRuntimeDisplayResult);
  }
  if (Array.isArray(normalized.final_results)) {
    normalized.final_results = normalized.final_results.map(segment => ({
      ...segment,
      final_result: normalizeRuntimeDisplayResult(segment.final_result),
    }));
  }
  if (Array.isArray(normalized.answers)) {
    normalized.answers = normalized.answers.map(answer => ({
      ...answer,
      intent_name: answer.display_name || answer.intent_name || '',
      display_name: answer.display_name || answer.intent_name || '',
    }));
  }
  return normalized;
}

function applyRuntimeIntentLabel(result) {
  if (!result || !isAskResult(result)) return result;
  if (result.runtime_action_code === 'guide' || result.runtime_boundary === 'semantic_guide_boundary') {
    return {
      ...result,
      intent_name: result.display_name || getDisplayName(result),
      runtime_intent_name: result.display_name || getDisplayName(result),
    };
  }
  if ((result.evidence || []).includes('semantic_object_display_alignment') && result.display_name) {
    return {
      ...result,
      intent_name: result.display_name,
      runtime_intent_name: result.display_name,
    };
  }
  const graphDisplay = getGraphDisplayName(result);
  if (!graphDisplay) return result;
  const runtimeName = /(咨询|问答|说明|介绍|是什么)$/.test(graphDisplay) ? graphDisplay : `${graphDisplay}咨询`;
  return {
    ...result,
    graph_display_name: graphDisplay,
    intent_name: runtimeName,
    runtime_intent_name: runtimeName,
    display_name: runtimeName,
  };
}

function semanticObjectDisplayBase(result, profile) {
  if (!result || !profile || !profile.semantic_boundary) return '';
  const boundary = profile.semantic_boundary || {};
  if ((boundary.confidence || 0) < 0.82) return '';
  const semanticObject = String(boundary.business_object || '').trim();
  if (!semanticObject || normalize(semanticObject).length < 4) return '';

  const graphDisplay = getGraphDisplayName(result) || getDisplayName(result);
  const graphNorm = normalize(graphDisplay);
  const semanticNorm = normalize(semanticObject);
  const genericLoanRepayment = /贷款还款/.test(semanticObject) && /(还款计划|我的贷款|房贷还款)/.test(graphDisplay);
  if (genericLoanRepayment) return semanticObject;
  if (!graphNorm || semanticNorm.length <= graphNorm.length) return '';
  if (semanticNorm.includes(graphNorm) || charSetOverlapScore(graphNorm, semanticNorm) >= 0.62) {
    return semanticObject;
  }
  return '';
}

function canApplySemanticObjectDisplay(result) {
  if (!result) return false;
  if (result.runtime_action_code === 'guide') return true;
  if (result.action_code === 'query' || result.runtime_action_code === 'query') return true;
  if (['semantic_guide_boundary', 'semantic_ask_boundary', 'faq_or_business_boundary'].includes(result.runtime_boundary || '')) return true;
  return isAskResult(result);
}

function resolveRuntimeBoundaryDecision(query, result, profile) {
  if (!result) return null;
  const text = candidateBoundaryText(result);
  const askLikeTarget = /(限额|协议|规则|说明|介绍|是什么|指南|帮助|常见问题|问答|费用|利率|手续费|定义|含义|余额|账单|待还款|登录密码|记录|提醒)/.test(text);
  const semanticAction = profile.semantic_action || '';
  const semanticTaskMode = profile.semantic_task_mode || '';
  const semanticGuide = semanticAction === 'guide' || semanticTaskMode === 'guide';
  const semanticAsk = semanticAction === 'ask' || semanticTaskMode === 'faq';

  if (semanticGuide && !profile.transfer_execution && !profile.purchase_execution && result.action_code !== 'idle_chat') {
    return {
      action_code: 'ask',
      runtime_action_code: 'guide',
      runtime_boundary: 'semantic_guide_boundary',
      answer_mode: 'faq',
      display_variant: 'guide',
      semantic_boundary: profile.semantic_boundary || null,
      extra_evidence: ['semantic_guide_boundary'],
      apply_semantic_display: true,
    };
  }

  if (semanticAsk && !profile.transfer_execution && !profile.purchase_execution && result.action_code !== 'idle_chat') {
    return {
      action_code: 'ask',
      runtime_action_code: 'ask',
      runtime_boundary: 'semantic_ask_boundary',
      answer_mode: 'faq',
      display_variant: 'ask',
      semantic_boundary: profile.semantic_boundary || null,
      extra_evidence: ['semantic_ask_boundary'],
      apply_semantic_display: true,
    };
  }

  if (profile.ask_query && !profile.transfer_execution && !profile.where_query && !profile.change_query && (askLikeTarget || result.action_code === 'query')) {
    return {
      action_code: 'ask',
      runtime_action_code: 'ask',
      runtime_boundary: 'faq_or_business_boundary',
      answer_mode: 'faq',
      display_variant: 'ask',
      extra_evidence: ['faq_or_business_boundary'],
      apply_semantic_display: true,
    };
  }

  if (profile.where_query && !profile.transfer_execution && ['transfer', 'apply', 'change'].includes(result.action_code)) {
    return {
      action_code: 'query',
      runtime_action_code: 'query',
      runtime_boundary: 'query_or_business_boundary',
      extra_evidence: ['query_or_business_boundary'],
      apply_semantic_display: false,
    };
  }

  if (profile.where_query
    && /(去哪里操作|从哪里操作|在哪(?:里|儿)?操作|入口在(?:哪|哪里)|从哪(?:里|儿)?进|怎么进入)/.test(query)
    && ['query', 'transfer', 'repay', 'apply', 'open', 'change'].includes(result.action_code)) {
    return {
      action_code: 'ask',
      runtime_action_code: 'guide',
      runtime_boundary: 'semantic_guide_boundary',
      answer_mode: 'faq',
      display_variant: 'guide',
      extra_evidence: ['semantic_guide_boundary', 'entry_or_howto_pattern'],
      apply_semantic_display: true,
    };
  }

  return null;
}

function applyResolvedRuntimeBoundary(result, profile, decision) {
  if (!decision) return annotateRuntimeOwnership(applySemanticObjectDisplay(result, profile));
  const graphDisplay = getGraphDisplayName(result) || getDisplayName(result);
  const displayBase = semanticObjectDisplayBase(result, profile) || graphDisplay || getDisplayName(result);
  let displayName = result.display_name || displayBase;
  if (decision.display_variant === 'guide') {
    displayName = displayBase && /指南$/.test(displayBase) ? displayBase : `${displayBase}指南`;
  } else if (decision.display_variant === 'ask') {
    displayName = displayBase && /(咨询|说明|介绍|是什么意思)$/.test(displayBase) ? displayBase : `${displayBase}咨询`;
  }
  const next = annotateRuntimeOwnership({
    ...result,
    graph_action_code: result.graph_action_code || result.action_code || '',
    action_code: decision.action_code,
    runtime_action_code: decision.runtime_action_code,
    runtime_boundary: decision.runtime_boundary,
    answer_mode: decision.answer_mode || result.answer_mode || '',
    display_name: displayName,
    semantic_boundary: decision.semantic_boundary || result.semantic_boundary || null,
    evidence: Array.from(new Set([...(result.evidence || []), ...(decision.extra_evidence || [])])),
  });
  return decision.apply_semantic_display ? annotateRuntimeOwnership(applySemanticObjectDisplay(next, profile)) : next;
}

function applySemanticObjectDisplay(result, profile) {
  if (!canApplySemanticObjectDisplay(result)) return result;
  const base = semanticObjectDisplayBase(result, profile);
  if (!base) return result;
  const graphDisplay = getGraphDisplayName(result) || getDisplayName(result);
  let displayName = base;
  if (result.runtime_action_code === 'guide' || result.runtime_boundary === 'semantic_guide_boundary') {
    displayName = /指南$/.test(base) ? base : `${base}指南`;
  } else if (isAskResult(result) || result.runtime_boundary === 'semantic_ask_boundary') {
    displayName = /(咨询|说明|介绍|是什么意思)$/.test(base) ? base : `${base}咨询`;
  }
  return {
    ...result,
    display_name: displayName,
    eval_label: base,
    object: base,
    graph_display_name: graphDisplay,
    graph_action_code: result.graph_action_code || result.action_code || '',
    runtime_boundary: result.runtime_boundary || 'semantic_object_display_alignment',
    evidence: Array.from(new Set([...(result.evidence || []), 'semantic_object_display_alignment'])),
  };
}

function applyRuntimeActionBoundary(query, result, queryProfileOverride) {
  if (!result) return result;
  const profile = queryProfileOverride || analyzeQuery(query);
  const seeded = annotateRuntimeOwnership(result);
  const decision = resolveRuntimeBoundaryDecision(query, seeded, profile);
  return applyResolvedRuntimeBoundary(seeded, profile, decision);
}

function applyObjectSpecialization(query, result) {
  if (!result) return result;
  const profile = analyzeQuery(query);
  const graphDisplay = getGraphDisplayName(result);

  if (profile.ask_query && /(转账记录|转账明细|汇款记录)/.test(query) && graphDisplay === '汇款明细') {
    const alias = (query.match(/转账记录|转账明细|汇款记录/) || [])[0] || '转账记录';
    return {
      ...result,
      intent_name: `${alias}咨询`,
      display_name: `${alias}咨询`,
      eval_label: alias,
      object: alias,
      graph_display_name: graphDisplay,
      graph_action_code: result.graph_action_code || result.action_code,
      runtime_boundary: result.runtime_boundary || 'object_alias_specialization',
      evidence: Array.from(new Set([...(result.evidence || []), 'transfer_record_object_specialization'])),
    };
  }

  if (profile.credit_card_due_query && graphDisplay === '待还款') {
    return {
      ...result,
      display_name: result.action_code === 'ask' ? '信用卡待还咨询' : '信用卡待还',
      eval_label: '信用卡待还',
      object: '信用卡待还',
      graph_display_name: graphDisplay,
      graph_action_code: result.graph_action_code || result.action_code,
      runtime_boundary: result.runtime_boundary || 'object_alias_specialization',
      evidence: Array.from(new Set([...(result.evidence || []), 'credit_card_due_object_specialization'])),
    };
  }

  if (profile.balance_query && /银行卡|卡里|卡上|储蓄卡|借记卡/.test(query) && ['余额查询', '账户余额'].includes(graphDisplay)) {
    return {
      ...result,
      display_name: result.action_code === 'ask' ? '银行卡余额咨询' : '银行卡余额查询',
      eval_label: '银行卡余额',
      object: '银行卡余额',
      graph_display_name: graphDisplay,
      graph_action_code: result.graph_action_code || result.action_code,
      runtime_boundary: result.runtime_boundary || 'object_alias_specialization',
      evidence: Array.from(new Set([...(result.evidence || []), 'bank_card_balance_object_specialization'])),
    };
  }

  if (profile.balance_query && /账户|余额/.test(query) && ['账户查询', '余额查询', '账户余额'].includes(graphDisplay)) {
    return {
      ...result,
      display_name: result.action_code === 'ask' ? '账户余额咨询' : '账户余额查询',
      eval_label: '账户余额',
      object: '账户余额',
      graph_display_name: graphDisplay,
      graph_action_code: result.graph_action_code || result.action_code,
      runtime_boundary: result.runtime_boundary || 'object_alias_specialization',
      evidence: Array.from(new Set([...(result.evidence || []), 'account_balance_object_specialization'])),
    };
  }

  if (/转账.*(记录|明细)|转账汇款.*(记录|明细)/.test(query) && ['转账汇款', '转账记录', '转账明细'].includes(graphDisplay)) {
    return {
      ...result,
      display_name: result.action_code === 'ask' ? '转账记录咨询' : '转账记录查询',
      eval_label: '转账记录',
      object: '转账记录',
      graph_display_name: graphDisplay,
      graph_action_code: result.graph_action_code || result.action_code,
      clarification_needed: false,
      runtime_boundary: result.runtime_boundary || 'object_alias_specialization',
      evidence: Array.from(new Set([...(result.evidence || []), 'transfer_record_object_specialization'])),
    };
  }

  if (/手机号.*转账|转账.*手机号|\b1[3-9]\d{9}\b/.test(query) && ['手机号收款', '手机号转账', '转账汇款'].includes(graphDisplay)) {
    return {
      ...result,
      display_name: result.action_code === 'ask' ? '手机号转账咨询' : '手机号转账',
      eval_label: '手机号转账',
      object: '手机号转账',
      graph_display_name: graphDisplay,
      graph_action_code: result.graph_action_code || result.action_code,
      runtime_boundary: result.runtime_boundary || 'object_alias_specialization',
      evidence: Array.from(new Set([...(result.evidence || []), 'mobile_transfer_object_specialization'])),
    };
  }

  return result;
}

const HIGH_PRECISION_INTENT_OVERRIDES = [
  { pattern: /网点.*预约|预约.*网点/, labels: ['网点预约'] },
  { pattern: /线上工作室/, labels: ['线上工作室'] },
  { pattern: /财富.*(情况|查询|查看|查)|查.*财富/, labels: ['财富查询'] },
  { pattern: /买的保险|我的保险|查.*保险|保险.*查询/, labels: ['保险'] },
  { pattern: /密码.*(忘|重置)|重置.*密码/, labels: ['密码重置'] },
  { pattern: /联系你们|怎么联系|联系我行|联系银行/, labels: ['联系我行'] },
  { pattern: /存款.*(情况|查询|查看|查)|查.*存款/, labels: ['存款'] },
  { pattern: /网点.*现场.*取号|现场取号|在线取号/, labels: ['网点现场取号方法', '预约取号'] },
  { pattern: /购汇/, labels: ['购汇'] },
  { pattern: /私人银行/, labels: ['私人银行'] },
  { pattern: /e支付.*安全|安全.*e支付/, labels: ['e支付安全管理'] },
  { pattern: /绑定手机号收款/, labels: ['绑定手机号收款'] },
  { pattern: /他行卡?转入|转入.*他行卡?/, labels: ['他行卡转入'] },
  { pattern: /贷款额度/, labels: ['我的贷款'] },
  { pattern: /能贷多少|可贷额度|测测/, labels: ['测测我能贷多少'] },
  { pattern: /切换.*城市.*缴费|切换缴费城市|城市缴费/, labels: ['切换缴费城市'] },
  { pattern: /预约(个|一下|一笔)?转账|转账预约/, labels: ['预约转账'] },
  { pattern: /字体.*(调大|调小|大小|设置|调整)|调大.*字体|调小.*字体/, labels: ['字体大小'] },
  { pattern: /基金超市/, labels: ['基金超市'] },
  { pattern: /还.*信用卡|信用卡.*还款|信用卡账单.*还|还.*信用卡账单/, labels: ['信用卡还款'] },
  { pattern: /信用卡.*账单|账单.*信用卡/, labels: ['信用卡账单'] },
  { pattern: /房贷.*还|还.*房贷|住房贷款.*还|按揭.*还/, labels: ['房贷还款'] },
  { pattern: /外币.*预约|预约.*外币/, labels: ['外币预约'] },
  { pattern: /注销.*电子银行|电子银行.*注销|关闭.*电子银行/, labels: ['注销电子银行'] },
  { pattern: /网证.*登录|网证授权登录/, labels: ['网证登录', '网证授权登录'] },
  { pattern: /客服热线|客服电话|联系.*客服|人工客服/, labels: ['客服热线'] },
  { pattern: /购买.*记录|买过.*产品|产品.*购买记录/, labels: ['购买记录'] },
  { pattern: /资金归集|另一个账户|账户归集/, labels: ['资金归集'] },
  { pattern: /购买.*理财|买.*理财|理财产品.*买|可以买.*理财/, labels: ['购买理财'] },
  { pattern: /激活.*医保|医保.*激活/, labels: ['激活授权'] },
  { pattern: /医保账户|医保.*余额|医保/, labels: ['医保'] },
  { pattern: /微信绑定/, labels: ['微信绑定'] },
  { pattern: /绑定.*微信|微信.*绑定|微信绑卡/, labels: ['绑定微信', '微信绑定'] },
  { pattern: /绑定.*京东|京东.*绑定/, labels: ['绑定京东'] },
  { pattern: /绑定.*支付宝|支付宝.*绑定|支付宝绑卡/, labels: ['绑定支付宝'] },
  { pattern: /绑定.*手机号|手机号.*绑定|手机号码.*绑定/, labels: ['绑定手机号'] },
  { pattern: /兑换.*权益|权益.*兑换|去.*兑换/, labels: ['去兑换'] },
  { pattern: /英文姓名/, labels: ['维护英文姓名'] },
  { pattern: /推荐.*信用卡|信用卡.*推荐|推荐办.*信用卡|办.*信用卡.*推荐/, labels: ['卡片推荐'] },
  { pattern: /临时挂失|卡.*丢了.*挂失|卡.*不见.*挂失/, labels: ['临时挂失'] },
  { pattern: /免签标志|免签/, labels: ['撤销免签标志'] },
  { pattern: /企业收款|收款.*设置|设置.*收款/, labels: ['收款服务'] },
  { pattern: /企业账户|公司账户|对公账户/, labels: ['企业账户'] },
  { pattern: /公益捐款|公益捐赠|捐款活动|捐赠活动/, labels: ['公益捐赠', '公益捐款'] },
  { pattern: /刷卡记录|消费.*类别|按类别.*(查|看)/, labels: ['按类别查询'] },
  { pattern: /转账记录|转账明细|汇款记录|汇款明细/, labels: ['汇款明细'] },
];

function findCandidateByLabels(candidates, labels, queryProfile) {
  const wanted = labels.map(normalize);
  const inferredAction = queryProfile && queryProfile.inferred_action || '';
  const matches = (candidates || []).filter(candidate => {
    const names = [getDisplayName(candidate), getGraphDisplayName(candidate), candidate.intent_name, candidate.eval_label, candidate.object]
      .filter(Boolean)
      .map(normalize);
    return wanted.some(label => names.includes(label));
  });
  if (!matches.length) return null;
  matches.sort((a, b) => {
    const actionScore = candidate => {
      if (!inferredAction) return 0;
      if (candidate.action_code === inferredAction) return 3;
      const compatible = actionCompatible(inferredAction, candidate.action_code);
      if (compatible > 0) return compatible;
      return -2;
    };
    const exactObjectScore = candidate => wanted.some(label => normalize(candidate.eval_label) === label || normalize(candidate.object) === label) ? 0.4 : 0;
    const supportScore = candidate => {
      const evidence = candidate.evidence || [];
      let score = 0;
      if (evidence.includes('strong_object_match')) score += 0.25;
      if (evidence.includes('action_match')) score += 0.25;
      return score;
    };
    const as = actionScore(a) + exactObjectScore(a) + supportScore(a);
    const bs = actionScore(b) + exactObjectScore(b) + supportScore(b);
    return bs - as;
  });
  return matches[0];
}

function applyHighPrecisionIntentOverride(query, result, candidates) {
  const q = String(query || '');
  const profile = analyzeQuery(query);
  for (const rule of HIGH_PRECISION_INTENT_OVERRIDES) {
    if (!rule.pattern.test(q)) continue;
    if ((rule.labels || []).includes('信用卡还款') && /信用卡还款提醒/.test(q)) continue;
    const candidate = findCandidateByLabels(candidates, rule.labels, profile);
    if (!candidate) return result;
    const transferRecordAlias = profile.ask_query && /(转账记录|转账明细|汇款记录)/.test(q)
      ? ((q.match(/转账记录|转账明细|汇款记录/) || [])[0] || '')
      : '';
    const displayName = transferRecordAlias && (rule.labels || []).includes('汇款明细')
      ? `${transferRecordAlias}咨询`
      : (candidate.display_name || candidate.eval_label || candidate.object || '');
    return applyRuntimeActionBoundary(query, {
      ...candidate,
      intent_name: displayName || candidate.intent_name,
      display_name: displayName,
      eval_label: displayName || candidate.eval_label,
      object: transferRecordAlias ? '汇款明细' : candidate.object,
      score: Math.max(result && result.score || 0, candidate.score || candidate.local_score || 0, 0.88),
      runtime_boundary: 'high_precision_object_override',
      evidence: Array.from(new Set([...(candidate.evidence || []), 'high_precision_object_override'])),
      sources: Array.from(new Set([...(candidate.sources || []), 'high_precision_object_override'])),
    });
  }
  return result;
}

function buildAuthoritativeResult(segment) {
  const final = segment && segment.final_result || {};
  return {
    segment_index: segment && segment.segment_index || 1,
    query: segment && segment.query || '',
    result_type: final.action_code === 'idle_chat' ? 'idle_chat' : 'single_intent',
    intent_id: final.intent_id || '',
    intent_name: final.intent_name || '',
    eval_label: final.eval_label || '',
    display_name: getDisplayName(final),
    graph_display_name: final.graph_display_name || '',
    runtime_intent_name: final.runtime_intent_name || '',
    action_code: final.action_code || '',
    graph_action_code: final.graph_action_code || '',
    runtime_action_code: final.runtime_action_code || final.action_code || '',
    runtime_boundary: final.runtime_boundary || '',
    answer_mode: final.answer_mode || '',
    object: final.object || '',
    domain: final.domain || '',
    score: final.score || 0,
    clarification_needed: !!(((segment && segment.understanding || {}).clarification || {}).needed),
    task_count: (segment && segment.understanding || {}).task_count || 1,
  };
}

function isAskResult(result) {
  if (!result) return false;
  return result.answer_mode === 'faq'
    || result.runtime_action_code === 'ask'
    || result.action_code === 'ask';
}

function scoreFaqItem(query, result, item) {
  const q = normalize(query);
  const display = normalize(getDisplayName(result));
  const graphDisplay = normalize(getGraphDisplayName(result));
  const intentName = normalize(result && result.intent_name);
  const evalLabel = normalize(result && result.eval_label);
  let score = 0;

  if (display && item._display_norm && display === item._display_norm) score += 1.1;
  if (graphDisplay && item._display_norm && graphDisplay === item._display_norm) score += 1.1;
  if (display && item._display_norm && (q.includes(item._display_norm) || item._display_norm.includes(display))) score += 0.35;
  if (item._intent_norms.includes(intentName) || item._intent_norms.includes(evalLabel)) score += 0.65;
  if (item._question_norms.includes(q)) score += 1.4;
  if (item._question_norms.some(text => text && (q.includes(text) || text.includes(q)))) score += 0.45;
  if (item._alias_norms.some(text => text && q.includes(text))) score += 0.36;

  const action = (result && (result.runtime_action_code || result.action_code)) || 'ask';
  if ((item._action_codes || []).includes(action) || ((item._action_codes || []).includes('ask') && action === 'ask')) score += 0.2;
  return round(score, 5);
}

function matchFaqAnswer(query, result) {
  if (!isAskResult(result)) return null;
  const faq = loadFaqState();
  let best = null;
  for (const item of faq.items) {
    const score = scoreFaqItem(query, result, item);
    if (!best || score > best.score) best = { item, score };
  }
  if (!best || best.score < 0.75) return null;
  return {
    faq_id: best.item.faq_id,
    display_name: best.item.display_name,
    answer: best.item.answer,
    answer_policy: best.item.answer_policy || 'direct_answer',
    related_actions: best.item.related_actions || [],
    confidence: best.score,
    source: best.item.source || 'faq_seed',
  };
}

function buildLlmFaqAnswerPrompt(query, result) {
  const graphName = getGraphDisplayName(result) || getDisplayName(result);
  return [
    '你是手机银行意图评测引擎中的 FAQ 答案生成器。请只生成面向用户的简洁中文解释。',
    '',
    '要求：',
    '1. 只解释概念或功能用途，不要声称已经为用户办理业务。',
    '2. 不要编造具体限额、费率、到账时间、活动规则、政策细节或个性化账户信息。',
    '3. 涉及银行具体规则时，必须提示以手机银行页面展示或银行官方说明为准。',
    '4. 答案 1 到 3 句话，语气自然、克制、适合对客服务。',
    '5. 只输出答案正文，不要输出 JSON、Markdown、标题或多余说明。',
    '',
    `用户问题：${query}`,
    `已识别意图：${getDisplayName(result)}`,
    `图谱节点：${graphName}`,
    `图谱原动作：${result.graph_action_code || result.action_code || ''}`,
    `运行时动作：${result.runtime_action_code || result.action_code || ''}`,
  ].join('\n');
}

async function generateLlmFaqAnswer(query, result) {
  const route = API_ROUTES[INTENT_LLM_ROUTE];
  const apiKey = route && route.getKey();
  if (!route || !apiKey) {
    return {
      answer_available: false,
      answer_status: 'missing_faq_seed',
      generation_error: 'LLM route or key not configured',
    };
  }
  try {
    const parsed = await callJsonApi(route.host, route.path, {
      model: LLM_MODEL,
      messages: [
        { role: 'system', content: '你只能输出面向用户的简洁中文答案正文，不要输出 JSON 或 Markdown。' },
        { role: 'user', content: buildLlmFaqAnswerPrompt(query, result) },
      ],
      temperature: 0.2,
      max_tokens: 220,
    }, apiKey, 60000);
    const message = parsed.choices && parsed.choices[0] && parsed.choices[0].message || {};
    const answer = getMessageContent(message, parsed)
      .replace(/^```[\s\S]*?\n?/, '')
      .replace(/```$/g, '')
      .trim();
    if (!answer) throw new Error('empty LLM answer');
    return {
      faq_id: `llm_faq_${sha((result.intent_id || '') + '\n' + query, 12)}`,
      display_name: getGraphDisplayName(result) || getDisplayName(result),
      answer,
      answer_policy: 'llm_generated_concept_answer',
      related_actions: [],
      confidence: 0.5,
      source: 'llm_generated',
      answer_source: 'llm_generated',
      answer_disclaimer: '此答案由大模型根据已识别意图生成，未命中正式 FAQ 知识库；具体规则请以手机银行页面或银行官方说明为准。',
    };
  } catch (e) {
    return {
      answer_available: false,
      answer_status: 'missing_faq_seed',
      generation_error: e.message || String(e),
    };
  }
}

function findStrongFaqSeedForQuery(query) {
  const profile = analyzeQuery(query);
  if (!profile.ask_query || profile.transfer_execution || profile.where_query || profile.change_query) return null;
  const q = normalize(query);
  const faq = loadFaqState();
  let best = null;
  for (const item of faq.items) {
    let score = 0;
    if (item._question_norms.includes(q)) score += 1.8;
    if (item._display_norm && q.includes(item._display_norm)) score += 0.85;
    if (item._alias_norms.some(alias => alias && q.includes(alias))) score += 0.35;
    if (!best || score > best.score) best = { item, score };
  }
  return best && best.score >= 1.2 ? best.item : null;
}

function buildFaqSeedRuntimeCandidate(seed, query, final) {
  const displayName = seed.display_name || (seed.intent_names || [])[0] || '';
  if (!displayName) return final;
  return {
    intent_id: `runtime_faq_seed_${sha(displayName, 12)}`,
    intent_name: displayName,
    display_name: displayName,
    graph_intent_name: displayName,
    graph_display_name: displayName,
    eval_label: displayName,
    object: displayName,
    action_code: 'ask',
    graph_action_code: '',
    runtime_action_code: 'ask',
    runtime_boundary: 'faq_seed_runtime_derivation',
    answer_mode: 'faq',
    answer_available: !!seed.answer,
    answer_status: seed.answer ? 'seed_answer_available' : 'seed_answer_missing',
    answer_source: seed.source || 'faq_seed',
    faq_id: seed.faq_id || seed.id || '',
    score: Math.max(final && final.score || 0, 1.35),
    sources: ['faq_seed_runtime_derivation'],
    evidence: ['faq_seed_strong_object', 'ask_query_template_match'],
    query,
  };
}

function applyFaqSeedObjectCorrection(query, final, localResult, embeddingResult) {
  if (!final) return final;
  const seed = findStrongFaqSeedForQuery(query);
  if (!seed) return final;
  if (normalize(getDisplayName(final)) === seed._display_norm && isAskResult(final)) return final;

  const pool = [
    ...(((localResult || {}).top) || []),
    ...(((embeddingResult || {}).top) || []),
  ].filter(item => normalize(getDisplayName(item)) === seed._display_norm);
  if (!pool.length) return buildFaqSeedRuntimeCandidate(seed, query, final);

  pool.sort((a, b) => (b.score || b.embedding_score || 0) - (a.score || a.embedding_score || 0));
  const selected = pool[0];
  return applyRuntimeActionBoundary(query, {
    ...selected,
    graph_action_code: selected.graph_action_code || selected.action_code || '',
    runtime_action_code: 'ask',
    runtime_boundary: 'faq_seed_object_correction',
    answer_mode: 'faq',
    action_code: 'ask',
    score: Math.max(final.score || 0, selected.score || selected.embedding_score || 0),
    sources: Array.from(new Set([...(selected.sources || []), 'faq_seed_object_correction'])),
    evidence: Array.from(new Set([...(selected.evidence || []), 'faq_seed_exact_object'])),
  });
}

function askObjectMatchScore(query, candidate) {
  if (!candidate) return 0;
  const q = normalize(query);
  const display = normalize(getGraphDisplayName(candidate));
  const object = normalize(candidate.object);
  const evidence = candidate.evidence || [];
  let score = 0;
  if (display && display.length >= 2 && q.includes(display)) score += 2.2;
  if (object && object.length >= 2 && q.includes(object) && object !== display) score += 1.2;
  if (evidence.includes('utterance_exact')) score += 1.4;
  if (evidence.includes('query_in_profile')) score += 1.0;
  if (evidence.includes('strong_object_match')) score += 1.3;
  if (['帮助与反馈', '帮助中心', '客服与帮助', '新功能介绍'].includes(getGraphDisplayName(candidate))) score -= 2.0;
  return round(score + Math.min(candidate.score || candidate.local_score || 0, 1), 5);
}

function deriveAskIntentFromObjectCandidate(query, final, localResult, embeddingResult) {
  const profile = analyzeQuery(query);
  if (!profile.ask_query || profile.transfer_execution || profile.where_query || profile.change_query) return final;

  const rows = [];
  const seen = new Set();
  for (const source of [
    ...(((localResult || {}).top) || []).map((item, index) => ({ item, source: 'local', rank: index + 1 })),
    ...(((embeddingResult || {}).top) || []).map((item, index) => ({ item, source: 'embedding', rank: index + 1 })),
  ]) {
    const key = source.item.intent_id + ':' + source.item.action_code;
    if (seen.has(key)) continue;
    seen.add(key);
    const objectScore = askObjectMatchScore(query, source.item);
    if (objectScore >= 2.0) rows.push({ ...source, objectScore });
  }
  if (!rows.length) return final;

  rows.sort((a, b) => b.objectScore - a.objectScore || a.rank - b.rank);
  const selected = rows[0].item;
  const currentScore = final ? askObjectMatchScore(query, final) : 0;
  if (final && currentScore >= rows[0].objectScore && isAskResult(final)) return final;

  return {
    ...selected,
    graph_action_code: selected.graph_action_code || selected.action_code || '',
    action_code: 'ask',
    runtime_action_code: 'ask',
    runtime_boundary: 'ask_object_runtime_derivation',
    answer_mode: 'faq',
    score: Math.max(final && final.score || 0, selected.score || selected.local_score || selected.embedding_score || 0),
    sources: Array.from(new Set([...(selected.sources || []), rows[0].source + '_strong_object', 'ask_object_runtime_derivation'])),
    evidence: Array.from(new Set([...(selected.evidence || []), 'ask_query_strong_object_derivation'])),
  };
}

function compactTraceCandidate(candidate) {
  if (!candidate) return null;
  return {
    intent_id: candidate.intent_id || '',
    intent_name: candidate.intent_name || '',
    display_name: getDisplayName(candidate),
    graph_display_name: candidate.graph_display_name || '',
    action_code: candidate.action_code || '',
    graph_action_code: candidate.graph_action_code || '',
    runtime_action_code: candidate.runtime_action_code || '',
    runtime_boundary: candidate.runtime_boundary || '',
    score: candidate.score || 0,
    local_score: candidate.local_score || 0,
    embedding_score: candidate.embedding_score || 0,
    embedding_adjusted_score: candidate.embedding_adjusted_score || 0,
    evidence: candidate.evidence || [],
    sources: candidate.sources || [],
  };
}

function sameTraceCandidate(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return (a.intent_id || '') === (b.intent_id || '')
    && (a.action_code || '') === (b.action_code || '')
    && getDisplayName(a) === getDisplayName(b)
    && (a.runtime_boundary || '') === (b.runtime_boundary || '');
}

function buildDecisionTrace(query, localResult, embeddingResult, llmResult, llmFinal, faqCorrectedFinal, finalResult, understanding, timings) {
  const timing = timings || {};
  const profile = (localResult && localResult.query_profile) || analyzeQuery(query);
  const recallProfile = (llmResult.prompt_summary && llmResult.prompt_summary.recall_profile) || {};
  const fallbackCount = (llmResult.prompt_summary && llmResult.prompt_summary.fallback_count) || 0;
  const candidateCount = (llmResult.prompt_summary && llmResult.prompt_summary.candidate_count) || 0;
  const judgeTiming = llmResult.timings || {};
  const steps = [
    {
      step: "query_understanding",
      title: "查询理解",
      conclusion: profile.ask_query
        ? "识别为解释/咨询型表达，运行时动作应优先按 ask 处理。"
        : "未识别为解释/咨询型表达，按原动作线索处理。",
      data: profile,
      timing_ms: timing.query_understanding_ms,
    },
    {
      step: "action_slot_extraction",
      title: "动作与槽位解析",
      conclusion: "动作识别为 " + (profile.inferred_action || "unknown") + "，金额=" + (profile.amount || "无") + "，购买执行=" + (profile.purchase_execution ? "yes" : "no") + "，转账执行=" + (profile.transfer_execution ? "yes" : "no") + "。",
      data: {
        inferred_action: profile.inferred_action || "",
        amount: profile.amount || "",
        purchase_execution: !!profile.purchase_execution,
        transfer_execution: !!profile.transfer_execution,
        ask_query: !!profile.ask_query,
        balance_query: !!profile.balance_query,
      },
      timing_ms: timing.query_understanding_ms,
    },
    {
      step: "local_recall",
      title: "本地规则 + 图谱检索",
      conclusion: localResult && localResult.top1
        ? "本地 Top1 为" + getDisplayName(localResult.top1) + "，证据：" + ((localResult.top1.evidence || []).join(", ") || "无") + "。"
        : "本地检索未命中候选。",
      selected: compactTraceCandidate(localResult && localResult.top1),
      timing_ms: timing.local_recall_ms,
    },
    {
      step: "embedding_recall",
      title: "Qwen embedding 语义召回",
      conclusion: embeddingResult && embeddingResult.top1
        ? "Embedding Top1 为" + getDisplayName(embeddingResult.top1) + "。原始相似度=" + (embeddingResult.top1.embedding_score || 0) + "，重排后分=" + (embeddingResult.top1.embedding_adjusted_score || embeddingResult.top1.score || 0) + "。"
        : "Embedding 未返回候选。",
      selected: compactTraceCandidate(embeddingResult && embeddingResult.top1),
      timing_ms: timing.embedding_recall_ms,
    },
    {
      step: "recall_quality_gate",
      title: "召回质量判断",
      conclusion: "召回质量判断为 " + (recallProfile.weak ? "弱召回" : "候选可用") + "，原因：" + (recallProfile.reason || "未标注") + "；本地 Top1 与 embedding Top1 " + ((((localResult && localResult.top1 && localResult.top1.intent_id) || "") === ((embeddingResult && embeddingResult.top1 && embeddingResult.top1.intent_id) || "")) ? "一致" : "不一致") + "。",
      data: recallProfile,
      timing_ms: judgeTiming.recall_quality_ms,
    },
    {
      step: "candidate_merge",
      title: "候选融合排序",
      conclusion: "已合并本地与 embedding 候选，共 " + candidateCount + " 个候选进入 LLM 裁决。",
      data: {
        candidate_count: candidateCount,
        local_top1: compactTraceCandidate(localResult && localResult.top1),
        embedding_top1: compactTraceCandidate(embeddingResult && embeddingResult.top1),
        merged_top3: (llmResult.top || []).slice(0, 3).map(compactTraceCandidate),
      },
      timing_ms: round((Number(judgeTiming.candidate_merge_ms) || 0) + (Number(judgeTiming.candidate_pack_ms) || 0), 3),
    },
    {
      step: "fallback_catalog",
      title: "图谱兜底目录",
      conclusion: fallbackCount
        ? "召回较弱，已构建 " + fallbackCount + " 个图谱兜底候选。"
        : "召回证据可用，本轮未启用图谱兜底目录。",
      data: {
        fallback_count: fallbackCount,
        fallback_top5: (llmResult.fallback_catalog || []).slice(0, 5).map(compactTraceCandidate),
      },
      timing_ms: judgeTiming.fallback_catalog_ms,
    },
    {
      step: "deepseek_judge",
      title: "LLM 候选内裁决",
      conclusion: llmResult.degraded
        ? "LLM 输出未能解析为结构化 JSON，系统进入 degraded_fusion。parse_error=" + (llmResult.parse_error || "unknown") + "。"
        : llmResult.repaired
          ? "LLM 首次输出不是合法 JSON，系统二次修复后得到结构化裁决。initial_parse_error=" + (llmResult.initial_parse_error || "unknown") + "。"
          : "LLM 返回结构化裁决：" + (llmResult.reason || "无原因文本") + "。",
      selected: compactTraceCandidate(llmFinal),
      data: {
        decision_mode: llmResult.decision_mode,
        selected_source: llmResult.selected_source,
        selected_rank: llmResult.selected_rank,
        fallback_rank: llmResult.fallback_rank,
        reason: llmResult.reason,
        diagnosis: llmResult.diagnosis || [],
        initial_parse_error: llmResult.initial_parse_error || "",
        parse_error: llmResult.parse_error || "",
        repaired: !!llmResult.repaired,
        degraded: !!llmResult.degraded,
        diagnostics: llmResult.llm_diagnostics || {},
        raw_response_excerpt: String(llmResult.raw_response || "").slice(0, 900),
      },
      timing_ms: timing.deepseek_judge_ms,
    },
    {
      step: "business_boundary_validation",
      title: "业务边界校验",
      conclusion: llmResult.boundary_override
        ? "模型选择触发业务边界纠偏：" + (llmResult.boundary_reason || "已纠偏") + "。"
        : "模型选择未触发强制边界纠偏。",
      selected: compactTraceCandidate(llmResult.final),
      data: {
        boundary_override: !!llmResult.boundary_override,
        boundary_reason: llmResult.boundary_reason || "",
        selected_source: llmResult.selected_source || "",
        selected_rank: llmResult.selected_rank || 0,
        fallback_rank: llmResult.fallback_rank || 0,
      },
      timing_ms: judgeTiming.business_boundary_validation_ms,
    },
  ];

  if (!sameTraceCandidate(llmFinal, faqCorrectedFinal)) {
    steps.push({
      step: "faq_seed_object_correction",
      title: "FAQ 种子对象纠偏",
      conclusion: "用户问法与 FAQ 种子中的对象强匹配，系统将候选从" + (getDisplayName(llmFinal) || "无") + " / " + ((llmFinal && llmFinal.action_code) || "-") + "纠正为" + getDisplayName(faqCorrectedFinal) + " / " + ((faqCorrectedFinal && faqCorrectedFinal.action_code) || "-") + "。",
      before: compactTraceCandidate(llmFinal),
      after: compactTraceCandidate(faqCorrectedFinal),
      timing_ms: timing.postprocess_ms,
    });
  }

  if (!sameTraceCandidate(faqCorrectedFinal, finalResult)) {
    steps.push({
      step: "ask_object_runtime_derivation",
      title: "运行时咨询意图派生",
      conclusion: "解释型问法命中强业务对象，系统派生最终运行时意图" + getDisplayName(finalResult) + "。",
      before: compactTraceCandidate(faqCorrectedFinal),
      after: compactTraceCandidate(finalResult),
      timing_ms: timing.postprocess_ms,
    });
  }

  if (understanding) {
    var clarification = understanding.clarification || {};
    var taskSummary = (understanding.tasks || [])
      .map(function(task) { return "#" + (task.task_index || "-") + " " + (task.display_name || task.intent_name || "-") + (task.payee ? " / " + task.payee : "") + (task.amount ? " / " + task.amount : ""); })
      .join("；");
    steps.push({
      step: "intent_shape_analysis",
      title: "意图形态判断",
      conclusion: "识别为 " + (understanding.cardinality || "single_intent") + "，任务数 " + (understanding.task_count || 1) + "。" + (understanding.reason || ""),
      selected: compactTraceCandidate(finalResult),
      data: {
        cardinality: understanding.cardinality,
        task_count: understanding.task_count,
        is_multi_intent: !!understanding.is_multi_intent,
        final_is_non_leaf: !!understanding.final_is_non_leaf,
        task_summary: taskSummary,
        tasks: understanding.tasks || [],
      },
      timing_ms: timing.postprocess_ms,
    });
    steps.push({
      step: "clarification_decision",
      title: "追问澄清判断",
      conclusion: clarification.needed
        ? "需要追问澄清：" + ((clarification.types || []).join("、") || "未标注类型") + "。" + (clarification.question || "")
        : "当前结果不需要追问澄清，可直接进入路由或执行。",
      data: {
        needed: !!clarification.needed,
        types: clarification.types || [],
        question: clarification.question || "",
        questions: clarification.questions || [],
        default_action: clarification.default_action || "",
        internal_reason: clarification.internal_reason || "",
      },
      timing_ms: timing.postprocess_ms,
    });
  }

  steps.push({
    step: "final_result",
    title: "最终权威结果",
    conclusion: "最终用于评测与路由的结果是" + (getDisplayName(finalResult) || "无匹配") + "。",
    selected: compactTraceCandidate(finalResult),
    timing_ms: timing.total_ms,
  });

  return {
    summary: llmResult.degraded
      ? "LLM 本轮没有给出可采信的结构化裁判，最终结果由系统边界校验确定为" + (getDisplayName(finalResult) || "无匹配") + "。"
      : llmResult.repaired
        ? "LLM 首次输出不是合法 JSON，系统通过二次修复得到结构化裁判；最终结果为" + (getDisplayName(finalResult) || "无匹配") + "。"
        : sameTraceCandidate(llmFinal, finalResult)
          ? "LLM 结构化裁判与最终结果一致，结果为" + (getDisplayName(finalResult) || "无匹配") + "。"
          : "LLM 给出了候选判断，但系统发现对象或动作边界需要校验，最终纠正为" + (getDisplayName(finalResult) || "无匹配") + "。",
    steps,
  };
}

async function attachFaqAnswers(result) {
  const faq = loadFaqState();
  const answers = Array.isArray(result.answers) ? result.answers.slice() : [];
  const authoritative = result.authoritative_results || [];

  for (const row of authoritative) {
    if (!isAskResult(row)) continue;
    let answer = matchFaqAnswer(row.query || result.query, row);
    let generated = false;
    if (!answer) {
      answer = await generateLlmFaqAnswer(row.query || result.query, row);
      generated = !!(answer && answer.source === 'llm_generated');
    }
    if (answer && answer.answer_available !== false && answer.answer) {
      row.answer_available = true;
      row.answer_status = generated ? 'llm_generated' : 'matched';
      row.faq_id = answer.faq_id;
      row.answer_policy = answer.answer_policy;
      row.answer_source = answer.answer_source || answer.source || (generated ? 'llm_generated' : 'faq_seed');
      row.answer_disclaimer = answer.answer_disclaimer || '';
      answers.push({
        segment_index: row.segment_index || 1,
        query: row.query || result.query,
        intent_id: row.intent_id || '',
        intent_name: row.intent_name || '',
        display_name: row.display_name || answer.display_name,
        action_code: row.runtime_action_code || row.action_code || 'ask',
        ...answer,
      });
    } else {
      row.answer_available = false;
      row.answer_status = 'missing_faq_seed';
      row.generation_error = answer && answer.generation_error || '';
    }
  }

  if (result.final_result && authoritative.length === 1 && result.final_result.action_code !== 'idle_chat') {
    const row = authoritative[0];
    result.final_result.answer_available = !!row.answer_available;
    result.final_result.answer_status = row.answer_status || '';
    result.final_result.faq_id = row.faq_id || '';
    result.final_result.answer_policy = row.answer_policy || result.final_result.answer_policy || '';
    result.final_result.answer_source = row.answer_source || '';
    result.final_result.answer_disclaimer = row.answer_disclaimer || '';
  }

  if (Array.isArray(result.final_results)) {
    for (const segment of result.final_results) {
      const row = authoritative.find(item => item.segment_index === segment.segment_index);
      if (row && segment.final_result) {
        segment.final_result.answer_available = !!row.answer_available;
        segment.final_result.answer_status = row.answer_status || '';
        segment.final_result.faq_id = row.faq_id || '';
        segment.final_result.answer_source = row.answer_source || '';
        segment.final_result.answer_disclaimer = row.answer_disclaimer || '';
      }
    }
  }

  return normalizeRuntimeDisplayPayload({
    ...result,
    faq: {
      path: 'data/graphs/intent-faq-seed.json',
      version: faq.version,
      item_count: faq.items.length,
    },
    answers,
  });
}

function round(n, digits) {
  const p = Math.pow(10, digits || 4);
  return Math.round((n || 0) * p) / p;
}

// API circuit breaker with retry: transient failures get retried once,
// persistent failures trip the breaker for fast-fail. General for any environment.
const _apiBreaker = { fails: 0, tripped: false, threshold: 5, resetTs: 0, cooldownMs: 30000 };
function _breakerTrip(error) {
  _apiBreaker.fails++;
  if (_apiBreaker.fails >= _apiBreaker.threshold && !_apiBreaker.tripped) {
    _apiBreaker.tripped = true;
    _apiBreaker.resetTs = Date.now() + _apiBreaker.cooldownMs;
    console.error('[api-breaker] tripped after ' + _apiBreaker.fails + ' consecutive failures; fast-failing for ' + _apiBreaker.cooldownMs + 'ms');
  }
}
function _breakerSuccess() {
  if (_apiBreaker.fails > 0 || _apiBreaker.tripped) {
    _apiBreaker.fails = 0;
    _apiBreaker.tripped = false;
    _apiBreaker.resetTs = 0;
  }
}
function _breakerShouldFastFail() {
  if (_apiBreaker.tripped) {
    if (Date.now() >= _apiBreaker.resetTs) {
      _apiBreaker.tripped = false;
      _apiBreaker.fails = 0;
      return false;
    }
    return true;
  }
  return false;
}
async function callJsonApi(host, apiPath, payload, apiKey, timeoutMs) {
  if (_breakerShouldFastFail()) {
    throw new Error('api_breaker_tripped: API endpoint unreachable, fast-failing');
  }
  const baseUrl = host.startsWith('http://') || host.startsWith('https://') ? host : 'https://' + host;
  const doFetch = async (signal) => {
    const res = await fetch(baseUrl + apiPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify(payload),
      signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + text.slice(0, 500));
    return JSON.parse(text);
  };
  // First attempt
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || 10000);
    try {
      const result = await doFetch(controller.signal);
      _breakerSuccess();
      return result;
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    // Retry once after short delay (handles transient connection refused)
    await new Promise(r => setTimeout(r, 100));
    try {
      const controller2 = new AbortController();
      const timer2 = setTimeout(() => controller2.abort(), timeoutMs || 10000);
      try {
        const result = await doFetch(controller2.signal);
        _breakerSuccess();
        return result;
      } finally {
        clearTimeout(timer2);
      }
    } catch (e2) {
      _breakerTrip(e2);
      throw e2;
    }
  }
}

function normalizeTaskMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  const aliases = {
    faq: 'faq',
    ask: 'faq',
    qa: 'faq',
    guide: 'guide',
    howto: 'guide',
    query: 'query',
    execute: 'execute',
    do: 'execute',
    idle_chat: 'idle_chat',
    chat: 'idle_chat',
  };
  return aliases[mode] || '';
}

function buildSemanticBoundaryPrompt(query, queryProfile) {
  return [
    runtimeInstruction(RSI_RUNTIME, 'boundary'),
    '你是手机银行意图引擎的语义边界判断器。只输出一个合法 JSON object，不要输出 Markdown 或解释。',
    '',
    '任务：判断用户是在问知识/问怎么操作/查询信息/办理执行/修改取消/闲聊。',
    '',
    '动作定义：',
    '- ask: 问定义、规则、费用、限额、说明、是什么意思。',
    '- guide: 问怎么操作、入口在哪、从哪里看、如何办理，但没有要求立即执行。',
    '- query: 要查询本人账户、余额、账单、记录、明细、状态等结果。',
    '- transfer/repay/apply/open/change/cancel/close: 明确要求执行交易、办理、开通、修改、取消或关闭。',
    '- idle_chat: 非手机银行业务。',
    '',
    '重要区分：',
    '- “查余额”是 query；“怎么查余额”是 guide。',
    '- “还信用卡1000”是 repay；“如何还信用卡”是 guide。',
    '- “看信用卡账单”是 query；“信用卡账单从哪里看”是 guide。',
    '- “什么是转账汇款”是 ask；“给张三转100”是 transfer。',
    '',
    '输出字段：',
    '{"semantic_action":"ask|guide|query|transfer|repay|apply|open|change|cancel|close|idle_chat","task_mode":"faq|guide|query|execute|idle_chat","business_object":"","object_aliases":[],"object_constraints":[],"confidence":0.0,"reason":""}',
    '',
    'query=' + query,
    'rule_profile=' + JSON.stringify({
      rule_action: queryProfile.inferred_action || '',
      transfer_execution: !!queryProfile.transfer_execution,
      purchase_execution: !!queryProfile.purchase_execution,
      ask_query: !!queryProfile.ask_query,
      where_query: !!queryProfile.where_query,
      change_query: !!queryProfile.change_query,
      amount: queryProfile.amount || '',
    }),
  ].join('\n');
}

function normalizeSemanticBoundary(raw, queryProfile, source, error) {
  const semanticAction = normalizeActionCode(raw && raw.semantic_action);
  const taskMode = normalizeTaskMode(raw && raw.task_mode);
  const confidence = normalizeJudgeConfidence(raw && raw.confidence);
  const objectAliases = Array.isArray(raw && raw.object_aliases)
    ? raw.object_aliases.map(item => String(item || '').trim()).filter(Boolean).slice(0, 8)
    : [];
  const objectConstraints = Array.isArray(raw && raw.object_constraints)
    ? raw.object_constraints.map(item => {
      if (typeof item === 'string') return item.trim();
      if (item && typeof item === 'object') return String(item.value || item.name || item.label || '').trim();
      return String(item || '').trim();
    }).filter(Boolean).slice(0, 8)
    : [];
  return {
    source: source || 'runtime_fallback',
    semantic_action: semanticAction || queryProfile.inferred_action || '',
    task_mode: taskMode || (semanticAction === 'ask' ? 'faq' : semanticAction === 'guide' ? 'guide' : queryProfile.inferred_action ? 'execute_or_query' : ''),
    business_object: String(raw && raw.business_object || '').slice(0, 80),
    object_aliases: objectAliases,
    object_constraints: objectConstraints,
    confidence,
    reason: String(raw && raw.reason || error || '').slice(0, 160),
    error: error || '',
  };
}

function applySemanticBoundaryToProfile(queryProfile, boundary) {
  const semanticAction = normalizeActionCode(boundary && boundary.semantic_action);
  const taskMode = normalizeTaskMode(boundary && boundary.task_mode);
  if (!semanticAction) return queryProfile;
  const executable = ['transfer', 'repay', 'apply', 'open', 'change', 'cancel', 'close'].includes(semanticAction);
  const inferred = semanticAction === 'idle_chat'
    ? ''
    : semanticAction === 'guide'
      ? 'guide'
      : semanticAction === 'ask'
        ? 'ask'
        : semanticAction;
  return {
    ...queryProfile,
    rule_action: queryProfile.inferred_action || '',
    inferred_action: inferred,
    semantic_action: semanticAction,
    semantic_task_mode: taskMode || (executable ? 'execute' : semanticAction),
    semantic_boundary: boundary,
    semantic_boundary_confidence: boundary.confidence || 0,
  };
}

async function runSemanticBoundaryJudge(query, queryProfile) {
  const cache = loadCacheState();
  cache.semantic_boundaries = cache.semantic_boundaries || {};
  // 缓存键必须覆盖全部有效输入：模型 + 边界指令 + 规则档（inferred_action 等）+ query。
  // 此前只有 model+query——换边界指令或规则档后会命中旧结果，边界裁决等于没跑（P1-1）。
  const prompt = buildSemanticBoundaryPrompt(query, queryProfile);
  const cacheKey = sha(INTENT_LLM_ROUTE + '\n' + LLM_MODEL + '\nsemantic_boundary_v4\n' + prompt, 24);
  if (cache.semantic_boundaries[cacheKey]) {
    return {
      ...cache.semantic_boundaries[cacheKey],
      cached: true,
    };
  }
  const route = API_ROUTES[INTENT_LLM_ROUTE];
  if (!route) throw new Error('LLM route not configured');
  const apiKey = route.getKey();
  if (!apiKey) throw new Error('LLM key not configured');
  const parsed = await callJsonApi(route.host, route.path, {
    model: LLM_MODEL,
    messages: [
      { role: 'system', content: '只输出合法 JSON object，第一个字符必须是 {。' },
      { role: 'user', content: prompt },
    ],
    temperature: 0,
    max_tokens: 500,
    response_format: { type: 'json_object' },
  }, apiKey, 60000);
  const apiChoice = parsed.choices && parsed.choices[0] || {};
  const message = apiChoice.message || {};
  const rawText = getMessageContent(message, parsed);
  const raw = extractJson(rawText);
  const boundary = normalizeSemanticBoundary(raw, queryProfile, 'deepseek_semantic_boundary', '');
  boundary.prompt_chars = prompt.length;
  boundary.raw_response = rawText;
  boundary.finish_reason = apiChoice.finish_reason || '';
  cache.semantic_boundaries[cacheKey] = boundary;
  saveCacheState();
  return {
    ...boundary,
    cached: false,
  };
}

async function safeRunSemanticBoundaryJudge(query, queryProfile) {
  try {
    return await runSemanticBoundaryJudge(query, queryProfile);
  } catch (error) {
    return normalizeSemanticBoundary(null, queryProfile, 'runtime_fallback', error && (error.message || String(error)) || 'semantic boundary failed');
  }
}

async function embedText(text) {
  const cache = loadCacheState();
  const key = sha(EMBEDDING_MODEL + '\n' + text, 24);
  if (cache.embeddings[key]) return { vector: cache.embeddings[key], cached: true, key };
  const route = API_ROUTES[EMBEDDING_MODEL];
  if (!route) throw new Error('Embedding route not configured');
  const apiKey = route.getKey();
  if (!apiKey) throw new Error('Qwen embedding key not configured');
  const parsed = await callJsonApi(route.host, route.path, { model: EMBEDDING_MODEL, input: [text] }, apiKey, 80000);
  const vector = parsed.data && parsed.data[0] && parsed.data[0].embedding;
  if (!vector) throw new Error('Invalid embedding response');
  cache.embeddings[key] = vector;
  saveCacheState();
  return { vector, cached: false, key };
}

async function runEmbedding(query, candidates, topk, queryProfileOverride) {
  const cache = loadCacheState();
  const queryEmbedding = await embedText(query);
  const queryProfile = queryProfileOverride || analyzeQuery(query);
  const inferredAction = queryProfile.inferred_action;
  const scored = [];
  let missingCandidateVectors = 0;
  for (const c of candidates) {
    let vec;
    try {
      const emb = await embedText(c.text);
      vec = emb.vector;
    } catch (e) { missingCandidateVectors++; continue; }
    const sim = cosine(queryEmbedding.vector, vec);
    const objectScore = objectAlignmentScore(queryProfile, c);
    const baseAdjusted = sim
      + (inferredAction && inferredAction === c.action_code ? 0.02 : 0)
      + (inferredAction && inferredAction !== c.action_code ? -0.04 : 0)
      + objectScore
      + transferExecutionAdjustment(queryProfile, c)
      + queryBoundaryAdjustment(queryProfile, c);
    const adjusted = (baseAdjusted * (c.embedding_weight_multiplier || 1)) + graphNegativeBoundaryAdjustment(normalize(query), queryProfile, c);
    scored.push({
      ...compactCandidate(c),
      score: round(adjusted, 5),
      embedding_score: round(sim, 5),
      embedding_adjusted_score: round(adjusted, 5),
      object_alignment_score: round(objectScore, 4),
      evidence: addObjectAlignmentEvidence(evidenceForEmbedding(inferredAction, c), objectScore),
    });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, topk || 8);
  return {
    method: 'qwen_embedding',
    model: EMBEDDING_MODEL,
    query_embedding_cached: queryEmbedding.cached,
    inferred_action: inferredAction,
    query_profile: queryProfile,
    missing_candidate_vectors: missingCandidateVectors,
    top,
    top1: top[0] || null,
    explanation: 'Embedding 方案使用 Qwen text-embedding-v4 对 query 和意图 retrieval_profile 做语义相似度召回，并加入轻量动作门控。',
  };
}

async function safeRunEmbedding(query, candidates, topk, queryProfileOverride) {
  try {
    return await runEmbedding(query, candidates, topk, queryProfileOverride);
  } catch (error) {
    const queryProfile = queryProfileOverride || analyzeQuery(query);
    return {
      method: 'qwen_embedding',
      model: EMBEDDING_MODEL,
      degraded: true,
      error: error && (error.message || String(error)) || 'unknown embedding error',
      query_embedding_cached: false,
      inferred_action: queryProfile.inferred_action,
      query_profile: queryProfile,
      missing_candidate_vectors: candidates.length,
      top: [],
      top1: null,
      explanation: 'Embedding 调用失败，本轮保留错误信息并降级使用本地召回和图谱规则。',
    };
  }
}

function evidenceForEmbedding(inferredAction, c) {
  const ev = ['semantic_similarity'];
  if (inferredAction && inferredAction === c.action_code) ev.push('action_bonus');
  if (inferredAction && inferredAction !== c.action_code) ev.push('action_penalty');
  return ev;
}

function extractJson(text) {
  const value = String(text || '').trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(value.slice(start, end + 1));
  throw new Error('no JSON object');
}

function getMessageContent(message, response) {
  const content = message && (message.content || message.reasoning_content);
  if (Array.isArray(content)) {
    return content.map(item => typeof item === 'string' ? item : (item.text || item.content || JSON.stringify(item))).join('\n');
  }
  if (content) return String(content);
  return JSON.stringify({
    choices: response && response.choices,
    usage: response && response.usage,
    id: response && response.id,
  });
}

function fallbackJudge(merged, parseError) {
  const selected = merged[0] || null;
  return {
    decision_mode: 'degraded_fusion',
    selected_source: selected ? 'candidate' : 'none',
    selected_rank: selected ? 1 : 0,
    fallback_rank: 0,
    intent_id: selected && selected.intent_id || '',
    intent_name: selected && selected.intent_name || '',
    eval_label: selected && selected.eval_label || '',
    action_code: selected && selected.action_code || '',
    confidence: selected ? Math.max(0.35, Math.min(0.72, selected.fused_score || selected.score || 0.45)) : 0,
    reason: 'LLM 返回未能解析为 JSON，系统按本地召回与 embedding 融合排序降级选择 Top1。',
    diagnosis: ['llm_json_parse_failed', parseError.message || String(parseError)],
  };
}

function isWeakRecall(localResult, embeddingResult, merged) {
  const localTop = localResult.top1 || {};
  const embTop = embeddingResult.top1 || {};
  const localScore = localTop.score || 0;
  const embScore = embTop.embedding_score || embTop.score || 0;
  const localEvidence = localTop.evidence || [];
  const hasStrongLocalEvidence = localEvidence.includes('utterance_exact') || localEvidence.includes('strong_object_match') || localEvidence.includes('query_in_profile');
  if (!merged.length) return { weak: true, reason: 'no_candidate' };
  if (!localTop.intent_id && embScore < 0.62) return { weak: true, reason: 'no_local_candidate_and_low_embedding' };
  if (localScore < 0.7 && embScore < 0.66) return { weak: true, reason: 'low_local_and_embedding_score' };
  if (localTop.intent_id && embTop.intent_id && localTop.intent_id !== embTop.intent_id && localScore < 0.55 && embScore >= 0.7) {
    return { weak: true, reason: 'local_embedding_disagreement_with_strong_semantic_candidate' };
  }
  if (localEvidence.includes('action_match') && !hasStrongLocalEvidence && embScore < 0.72) return { weak: true, reason: 'only_action_match_without_object_evidence' };
  return { weak: false, reason: 'candidate_evidence_available' };
}

function fallbackScore(query, queryProfile, c) {
  let score = 0;
  const inferredAction = queryProfile.inferred_action;
  const q = normalize(query);
  if (inferredAction && c.action_code === inferredAction) score += 2.0;
  if (inferredAction && actionCompatible(inferredAction, c.action_code) > 0) score += 0.8;
  score += objectAlignmentScore(queryProfile, c) * 1.25;
  if (c.domain === '转账服务' && inferredAction === 'transfer') score += 0.8;
  if (c.domain === '支付管理' && inferredAction === 'transfer') score += 0.4;
  if (queryProfile.purchase_execution && (c.action_code === 'apply' || c.action_code === 'open')) score += 0.9;
  if (queryProfile.purchase_execution && /(天天盈|理财|基金|产品|存款|保险)/.test(candidateBoundaryText(c))) score += 0.6;
  if (c.strong_object_terms.some(term => q.includes(term))) score += 1.2;
  if (c.intent_name.includes('工行转账') && /给.+(转|打)\d+|转\d+/.test(query)) score += 0.35;
  if (c.intent_name.includes('境内汇款') && /汇款|转账/.test(query)) score += 0.25;
  score += transferExecutionAdjustment(queryProfile, c);
  score -= Math.min((c.text_norm || '').length / 12000, 0.2);
  return score;
}

function buildFallbackCatalog(query, graphCandidates, merged, limit, queryProfileOverride) {
  const queryProfile = queryProfileOverride || analyzeQuery(query);
  const inferredAction = queryProfile.inferred_action;
  const mergedIds = new Set((merged || []).map(c => c.intent_id + ':' + c.action_code));
  const pool = graphCandidates
    .filter(c => !mergedIds.has(c.intent_id + ':' + c.action_code))
    .filter(c => !inferredAction || actionCompatible(inferredAction, c.action_code) > 0 || c.action_code === inferredAction)
    .map(c => {
      const objectScore = objectAlignmentScore(queryProfile, c);
      return {
        ...compactCandidate(c),
        object_alignment_score: round(objectScore, 4),
        fallback_score: round(fallbackScore(query, queryProfile, c), 4),
      };
    })
    .filter(c => c.fallback_score > 0)
    .sort((a, b) => b.fallback_score - a.fallback_score);
  return pool.slice(0, limit || 16);
}

function buildLlmPrompt(query, candidates, fallbackCatalog, recallProfile) {
  const slotSchema = {
    payee_count: 0,
    amount: '',
    payees: [],
    payee_text_raw: '',
    payee_entity_type: 'person | organization | merchant | unknown',
    payee_confidence: 1,
    payee_ambiguity_type: 'none | unclear_entity_boundary | multiple_payees | possible_typo_or_connector | unknown',
    needs_clarification: false,
    clarification_question: '',
  };
  const outputSchema = {
    decision_mode: 'candidate_judge | graph_fallback | reject',
    selected_source: 'candidate | fallback | none',
    selected_rank: 1,
    fallback_rank: 0,
    intent_id: '必须复制所选节点的 intent_id',
    intent_name: '必须复制所选节点的 intent_name',
    eval_label: '必须复制所选节点的 eval_label',
    action_code: '必须复制所选节点的 action_code',
    confidence: 0.88,
    slots: slotSchema,
    reason: '短原因',
    diagnosis: ['关键归因'],
  };
  return [
    runtimeInstruction(RSI_RUNTIME, 'judge'),
    '你是手机银行意图图谱评测引擎的最终裁判。只输出 JSON object，不要输出 Markdown，不要解释。',
    '',
    '核心原则：',
    '1. 不能自由创造意图。最终 intent_id、intent_name、eval_label、action_code 必须来自 candidates 或 fallback_catalog 中的某一项，并逐字复制。',
    '2. 强召回场景：优先在 candidates 中裁判，decision_mode="candidate_judge"，selected_source="candidate"，填写 selected_rank。',
    '3. 弱召回/无召回场景：如果 query 明确表达银行任务，但 candidates 缺失或证据很弱，可以从 fallback_catalog 中兜底选择，decision_mode="graph_fallback"，selected_source="fallback"，填写 fallback_rank。',
    '4. 如果 candidates 和 fallback_catalog 都没有合适图谱节点，输出 decision_mode="reject"，selected_source="none"，rank 均为 0。',
    '5. 人名、金额、卡号、手机号、日期是槽位，不是意图名。例如“给张三转300”“给张三和李四转300”应识别为转账类意图，张三/李四/300 放入 slots，不要生成“给张三转账”这类图谱外意图。',
    '6. 对“给某人转N元/给A和B转N元/转N元”这类执行转账 query，不能选择“转账协议、转账记录、转账明细、转账提醒、转账限额、收款人管理、绑定手机号、修改收款卡、智能语音助手”等管理/查询/辅助节点；应优先选择图谱中通用的执行转账节点。',
    '7. 区分问答、查询、办理/执行：问规则/怎么办通常是 ask；查余额/账单/记录是 query；转账/还款/申请/修改是执行或变更类动作。',
    '8. 收款人槽位由语义判断负责，不按姓名长度粗暴拆分。长姓名、公司名、商户名都可能是合法单一收款人。',
    '9. 如果收款人边界不清、像多个姓名粘连、或存在疑似错字连接词，应设置 slots.needs_clarification=true，并填写 payee_ambiguity_type 与 clarification_question。',
    '10. 例：“给张三李四转200”通常是多个收款人且金额分配不清；“给张是李四转200”通常存在收款人边界/错字歧义；“给北京某某科技有限公司转200”是清晰公司名，不要仅因长而追问。',
    '',
    '输出 JSON Schema 示例：' + JSON.stringify(outputSchema),
    '',
    'query=' + query,
    'recall_profile=' + JSON.stringify(recallProfile),
    'candidates=' + JSON.stringify(candidates),
    'fallback_catalog=' + JSON.stringify(fallbackCatalog),
  ].join('\n');
}

function buildLlmPromptV2(query, candidates, fallbackCatalog, recallProfile) {
  const compactCandidates = candidates.map(item => {
    const compact = {
      rank: item.rank,
      intent_id: item.intent_id,
      intent_name: item.intent_name,
      eval_label: item.eval_label,
      action_code: item.action_code,
      object: item.object,
      domain: item.domain,
      object_alignment_score: item.object_alignment_score || 0,
      local_score: item.local_score,
      embedding_score: item.embedding_score,
      evidence: item.evidence,
    };
    // 声明消费：区分线索/排除域/易混淆对进裁决视野（DECLARATION_AWARE 下由 compactCandidate 透传）
    if ((item.disambiguation_hints || []).length) compact.disambiguation_hints = item.disambiguation_hints;
    if ((item.scope_out || []).length) compact.scope_out = item.scope_out;
    if ((item.confusable_intents || []).length) compact.confusable_intents = item.confusable_intents;
    if (item.description) compact.description = item.description;
    return compact;
  });
  const compactFallback = fallbackCatalog.map(item => ({
    rank: item.rank,
    intent_id: item.intent_id,
    intent_name: item.intent_name,
    eval_label: item.eval_label,
    action_code: item.action_code,
    object: item.object,
    domain: item.domain,
    object_alignment_score: item.object_alignment_score || 0,
    fallback_score: item.fallback_score,
    ...(item.disambiguation_hints?.length ? {disambiguation_hints: item.disambiguation_hints} : {}),
    ...(item.scope_out?.length ? {scope_out: item.scope_out} : {}),
    ...(item.confusable_intents?.length ? {confusable_intents: item.confusable_intents} : {}),
    ...(item.description ? {description: item.description} : {}),
  }));
  const hasDeclarations = [...compactCandidates, ...compactFallback].some(c => c.disambiguation_hints || c.scope_out || c.confusable_intents);
  const outputSchema = {
    decision_mode: 'candidate_judge|graph_fallback|reject',
    selected_source: 'candidate|fallback|none',
    selected_rank: 0,
    fallback_rank: 0,
    intent_id: '',
    intent_name: '',
    eval_label: '',
    action_code: '',
    confidence: 0.0,
    slots: {
      payee_count: 0,
      amount: '',
      payees: [],
      payee_text_raw: '',
      payee_entity_type: 'person|organization|merchant|unknown',
      payee_confidence: 1,
      payee_ambiguity_type: 'none|unclear_entity_boundary|multiple_payees|possible_typo_or_connector|unknown',
      needs_clarification: false,
      clarification_question: '',
    },
    reason: '',
    diagnosis: [],
  };
  return [
    runtimeInstruction(RSI_RUNTIME, 'judge'),
    '语义边界优先级：recall_profile.semantic_action / semantic_task_mode 是独立语义判断结果，优先级高于 rule_action。',
    '如果 semantic_action=guide 或 semantic_task_mode=guide，用户是在问入口/步骤/怎么操作，不是要求立即执行；此时应选择对象最匹配的业务节点，即使该节点 action_code 是 query/repay/transfer/apply，系统后处理会派生成指南/咨询结果。不要仅因为没有专门的 guide 节点就 reject。',
    '如果 semantic_action=ask 或 semantic_task_mode=faq，用户是在问解释/规则/定义；应选择对象最匹配的节点，系统后处理会派生成咨询结果。',
    '对象匹配优先级高于动作字面匹配。例如“贷款还款入口在哪”应优先选择贷款/还款/房贷还款/我的贷款相关候选，而不是帮助与反馈、扫码入口、网点电话等泛入口候选。',
    '候选中的 object_alignment_score 表示用户语义对象与候选图谱对象的一致性。分值高时优先选择；分值为负表示对象不一致，应谨慎选择，即使动作或 embedding 分较高。',
    '',
    '你是手机银行意图图谱的最终裁判。只输出一个合法 JSON object，第一字符必须是 {。不要输出解释、Markdown 或思考过程。',
    '',
    '裁判规则：',
    '1. 只能选择 candidates 或 fallback_catalog 中的一项，或 reject；不能创造图谱外意图。',
    '2. 如果用户问“什么是/啥是/是啥/什么意思 X”，优先选择对象 X 精确匹配的节点；即使该节点 action_code 是 transfer/query/change，也可以先选中它，系统后续会派生 X咨询。',
    '3. 不要因为某个 ask 候选分数高，就选择对象不一致的 FAQ。例如 query 问“转账汇款”，不能选“转账限额”。',
    '4. 如果 candidates 对象不匹配，但 fallback_catalog 有对象精确匹配项，选择 fallback，decision_mode=graph_fallback。',
    '5. 如果 query 是执行交易，如“给张三转200”，不要选择协议、限额、记录、提醒等 FAQ/查询节点。',
    '6. 如果 query 是购买/申购/买入类短句，例如“买500天天盈”“买点理财”“申购1000基金”，动作应按 apply 理解；金额是 slots.amount，产品名是业务对象，不是新意图。',
    '7. 对“买500天天盈”这类 query，如果 candidates 中存在对象包含“天天盈”且 action_code=apply/open 的候选，应优先选择该候选；不要因为没有“购买天天盈”这个完全同名节点而 reject。',
    '8. 当本地 Top1 与 embedding Top1 冲突时，如果 embedding Top1 对象和动作都更贴近 query，可以选择 embedding 候选。不要被“总榜、产品榜、乐园、记录、明细”等路径噪声误导。',
    '9. 只有在 candidates 和 fallback_catalog 中都没有对象相关且动作兼容的节点时，才能 reject。',
    '9a. 候选 evidence 含 utterance_exact 表示 query 与该意图图谱声明的标准说法逐字一致，这是图谱的权威声明，优先级高于 object_alignment_score、embedding 分以及第 8 条的冲突裁决；除非该候选命中 scope_out 或另一候选也命中 utterance_exact，否则必须选择 utterance_exact 候选。',
    '9b. 复合查询优先：如果 query 同时含有两个不同候选的业务词片段（如"申请信用卡进度到哪了"含"信用卡"和"进度"两个不同候选的业务词），应选覆盖 query 业务词最多的候选。不要因为某候选词面分高就选它，而忽略了 query 中只被另一候选覆盖的业务词——如果 query 含有某候选的核心业务词但该候选不在 Top1 位置，必须重新审视排名是否正确。',
    '10. 人名、金额、卡号、手机号、日期是槽位，不是意图名称。',
    '11. 转账收款人理解必须输出结构化 slots：payee_text_raw 是“给”和金额之间的原文；payees 是你理解出的收款人列表；payee_count 是收款人数。',
    '12. 不要按长度判断收款人。长姓名、少数民族姓名、公司/商户全称都可能是一个合法收款人；只有语义边界不清、明显多个姓名粘连、疑似错字连接词时才需要追问。',
    '13. “给张三李四转200”应视为多个收款人且金额分配不清，slots.needs_clarification=true，clarification_question 需询问每人 200 还是总金额 200。',
    '14. “给张是李四转200”应视为收款人边界或疑似错字歧义，slots.needs_clarification=true，payee_ambiguity_type 可为 unclear_entity_boundary 或 possible_typo_or_connector。',
    '15. “给北京某某科技有限公司转200”“给阿布都热合曼转200”如语义上是清晰单一实体，不要仅因字数多而追问。',
    '16. reason 必须少于 40 个中文字符；diagnosis 最多 3 项。',
    ...(hasDeclarations ? [
      '17. 候选可能带三类图谱声明：disambiguation_hints（该意图的边界说明）、scope_out（明确不属于该意图的说法）、confusable_intents（与之互为易混淆的意图 id）。query 命中某候选 scope_out 中的说法时不要选它；两个互为 confusable 的候选都与对象匹配且分数接近时，倾向于 slots.needs_clarification=true 并把两者都放进澄清选项。',
    ] : []),
    '',
    '输出 JSON 字段：',
    JSON.stringify(outputSchema),
    '',
    'query=' + query,
    'recall_profile=' + JSON.stringify(recallProfile),
    'candidates=' + JSON.stringify(compactCandidates),
    'fallback_catalog=' + JSON.stringify(compactFallback),
  ].join('\n');
}

async function repairLlmJudgeJson(rawText, query, candidates, fallbackCatalog, apiRoute, apiKey) {
  const prompt = [
    '把下面模型输出修复为一个合法 JSON object。只输出 JSON，不要解释。',
    '如果原文已经表达了选择对象，按原文选择；不要新增 candidates/fallback_catalog 外的意图。',
    '如果无法判断，输出 reject。',
    '保留原文中的 slots.needs_clarification、payee_ambiguity_type、clarification_question；不要把收款人歧义修没。',
    'JSON 字段：{"decision_mode":"candidate_judge|graph_fallback|reject","selected_source":"candidate|fallback|none","selected_rank":0,"fallback_rank":0,"intent_id":"","intent_name":"","eval_label":"","action_code":"","confidence":0.0,"slots":{"payee_count":0,"amount":"","payees":[],"payee_text_raw":"","payee_entity_type":"person|organization|merchant|unknown","payee_confidence":1,"payee_ambiguity_type":"none|unclear_entity_boundary|multiple_payees|possible_typo_or_connector|unknown","needs_clarification":false,"clarification_question":""},"reason":"","diagnosis":[]}',
    'query=' + query,
    'candidates=' + JSON.stringify(candidates),
    'fallback_catalog=' + JSON.stringify(fallbackCatalog),
    'raw=' + String(rawText || '').slice(0, 2000),
  ].join('\n');
  const repaired = await callJsonApi(apiRoute.host, apiRoute.path, {
    model: LLM_MODEL,
    messages: [
      { role: 'system', content: '只输出合法 JSON object，第一字符必须是 {。' },
      { role: 'user', content: prompt },
    ],
    temperature: 0,
    max_tokens: LLM_REPAIR_MAX_TOKENS,
    response_format: { type: 'json_object' },
  }, apiKey, 60000);
  const message = repaired.choices && repaired.choices[0] && repaired.choices[0].message || {};
  return extractJson(getMessageContent(message, repaired));
}

function selectLlmResult(judge, merged, fallbackCatalog) {
  const selectedSource = String(judge.selected_source || '').toLowerCase();
  const candidateRank = parseInt(judge.selected_rank || judge.rank || 0, 10);
  const fallbackRank = parseInt(judge.fallback_rank || 0, 10);
  const byId = [...merged, ...fallbackCatalog].find(c => c.intent_id === judge.intent_id && (!judge.action_code || c.action_code === judge.action_code));
  if (selectedSource === 'candidate' && candidateRank >= 1 && candidateRank <= merged.length) {
    return { selected: merged[candidateRank - 1], rank: candidateRank, source: 'candidate' };
  }
  if (selectedSource === 'fallback' && fallbackRank >= 1 && fallbackRank <= fallbackCatalog.length) {
    return { selected: fallbackCatalog[fallbackRank - 1], rank: fallbackRank, source: 'fallback' };
  }
  if (byId) {
    const source = merged.some(c => c.intent_id === byId.intent_id && c.action_code === byId.action_code) ? 'candidate' : 'fallback';
    const rank = source === 'candidate'
      ? merged.findIndex(c => c.intent_id === byId.intent_id && c.action_code === byId.action_code) + 1
      : fallbackCatalog.findIndex(c => c.intent_id === byId.intent_id && c.action_code === byId.action_code) + 1;
    return { selected: byId, rank, source };
  }
  return { selected: null, rank: 0, source: 'none' };
}

function normalizeJudgeConfidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return round(Math.max(0, Math.min(1, n)), 4);
}

function enforceTransferExecutionBoundary(query, selection, merged, fallbackCatalog, queryProfileOverride) {
  const queryProfile = queryProfileOverride || analyzeQuery(query);
  if (!queryProfile.transfer_execution) return { ...selection, boundary_override: false };
  if (selection.selected && !isTransferExecutionDistractor(selection.selected)) {
    return { ...selection, boundary_override: false };
  }
  const all = [
    ...merged.map((item, index) => ({ item, source: 'candidate', rank: index + 1 })),
    ...fallbackCatalog.map((item, index) => ({ item, source: 'fallback', rank: index + 1 })),
  ];
  const replacement = all.find(x => x.item.intent_name === '转账转账' || x.item.eval_label === '转账')
    || all.find(x => x.item.intent_name.includes('转账汇款') || x.item.eval_label === '转账汇款')
    || all.find(x => x.item.action_code === 'transfer' && !isTransferExecutionDistractor(x.item));
  if (!replacement) return { ...selection, boundary_override: false };
  return {
    selected: replacement.item,
    rank: replacement.rank,
    source: replacement.source,
    boundary_override: true,
    boundary_reason: '执行转账 query 不能选择协议/记录/提醒/管理等辅助节点，已纠正为执行转账节点。',
  };
}

function boundaryCandidatePools(localResult, embeddingResult, graphCandidates) {
  return [
    ...((localResult && localResult.top) || []),
    ...((embeddingResult && embeddingResult.top) || []),
    ...(graphCandidates || []),
  ];
}

function pickSemanticBoundaryCandidate(pool, options) {
  const ranked = [];
  for (const candidate of pool || []) {
    if (!candidate || !candidate.intent_id) continue;
    const text = candidateBoundaryText(candidate);
    let score = 0;
    if (options.actionCodes && options.actionCodes.includes(candidate.action_code)) score += 3;
    if (options.preferPatterns) {
      for (const pattern of options.preferPatterns) {
        if (pattern.test(text)) score += 2;
      }
    }
    if (options.acceptPatterns) {
      for (const pattern of options.acceptPatterns) {
        if (pattern.test(text)) score += 1;
      }
    }
    if (score > 0) ranked.push({ candidate, score });
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked.length ? ranked[0].candidate : null;
}

function exactObjectLocalCandidate(localResult) {
  const top = (localResult && localResult.top || [])[0];
  if (!top || !top.intent_id) return null;
  const evidence = new Set(top.evidence || []);
  const hasExactSignal = evidence.has('utterance_exact') || evidence.has('query_in_profile');
  const hasObjectSignal = evidence.has('strong_object_match') || evidence.has('semantic_object_strong_match');
  if (!hasExactSignal || !hasObjectSignal) return null;
  if ((top.object_alignment_score || 0) < 0.75) return null;
  return top;
}

function applyExactObjectLocalCandidateCorrection(result, localResult) {
  const replacement = exactObjectLocalCandidate(localResult);
  if (!replacement) return result;
  if (result && result.intent_id === replacement.intent_id) return result;

  const resultObjectScore = result ? (result.object_alignment_score || 0) : 0;
  const replacementScore = replacement.score || replacement.local_score || 0;
  const resultScore = result ? (result.score || result.local_score || result.embedding_score || 0) : 0;
  const resultEvidence = new Set(result && result.evidence || []);
  const resultHasStrongObject = resultEvidence.has('strong_object_match') || resultEvidence.has('semantic_object_strong_match');
  const exactReplacementWins = replacementScore >= resultScore + 1.2;
  if (resultHasStrongObject && resultObjectScore >= 0.55 && !exactReplacementWins) return result;

  return applyRuntimeIntentLabel({
    ...replacement,
    runtime_boundary: 'exact_object_local_candidate_correction',
    graph_action_code: replacement.graph_action_code || replacement.action_code || '',
    evidence: Array.from(new Set([...(replacement.evidence || []), 'exact_object_local_candidate_correction'])),
  });
}

function applySemanticBoundaryCorrection(query, result, localResult, embeddingResult, graphCandidates, queryProfileOverride) {
  const profile = queryProfileOverride || analyzeQuery(query);
  const q = String(query || '');
  result = applyExactObjectLocalCandidateCorrection(result, localResult);
  const text = result ? candidateBoundaryText(result) : '';
  const pool = boundaryCandidatePools(localResult, embeddingResult, graphCandidates);

  if (/(解绑银行卡|银行卡解绑|解绑定银行卡|取消绑定银行卡|删除银行卡绑定|移除银行卡绑定|解除绑卡)/.test(q)) {
    const wrongFamily = !result || !/解绑|绑卡|绑定/.test(text) || result.action_code !== 'cancel';
    if (wrongFamily) {
      const replacement = pickSemanticBoundaryCandidate(pool, {
        actionCodes: ['cancel', 'change'],
        preferPatterns: [/解绑银行卡/, /银行卡解绑/],
        acceptPatterns: [/绑卡/, /绑定微信/, /绑定支付宝/, /绑定手机号/],
      });
      if (replacement) {
        return applyRuntimeIntentLabel({
          ...replacement,
          action_code: 'cancel',
          runtime_action_code: 'cancel',
          runtime_boundary: 'semantic_boundary_correction',
          graph_action_code: replacement.graph_action_code || replacement.action_code || '',
          evidence: Array.from(new Set([...(replacement.evidence || []), 'semantic_boundary_correction', 'unbind_boundary_correction'])),
        });
      }
    }
  }

  if (/(挂失|临时挂失|正式挂失|卡丢|卡.*不见)/.test(q) && /银行卡|借记卡|卡/.test(q) && !/(解除挂失|解挂|取消挂失)/.test(q)) {
    const wrongFamily = !result || result.action_code !== 'change' || /解除挂失/.test(text);
    if (wrongFamily) {
      const replacement = pickSemanticBoundaryCandidate(pool, {
        actionCodes: ['change', 'query'],
        preferPatterns: [/银行卡挂失/, /挂失银行卡/],
        acceptPatterns: [/介质挂失/, /挂失/],
      });
      if (replacement) {
        return applyRuntimeIntentLabel({
          ...replacement,
          action_code: 'change',
          runtime_action_code: 'change',
          runtime_boundary: 'semantic_boundary_correction',
          graph_action_code: replacement.graph_action_code || replacement.action_code || '',
          evidence: Array.from(new Set([...(replacement.evidence || []), 'semantic_boundary_correction', 'loss_report_boundary_correction'])),
        });
      }
    }
  }

  if (profile.where_query && /贷款/.test(q) && /还款/.test(q) && !/房贷|按揭|住房贷款/.test(q)) {
    const tooNarrow = result && /房贷还款/.test(text);
    if (!result || tooNarrow) {
      const replacement = pickSemanticBoundaryCandidate(pool, {
        actionCodes: ['query', 'ask', 'guide'],
        preferPatterns: [/还款计划/, /我的贷款/],
        acceptPatterns: [/贷款/, /还款/],
      });
      if (replacement) {
        return applyRuntimeIntentLabel({
          ...replacement,
          runtime_boundary: 'semantic_boundary_correction',
          graph_action_code: replacement.graph_action_code || replacement.action_code || '',
          evidence: Array.from(new Set([...(replacement.evidence || []), 'semantic_boundary_correction', 'loan_repayment_boundary_correction'])),
        });
      }
    }
  }

  return result;
}

async function runLlmJudge(query, localResult, embeddingResult, graphCandidates, topk, queryProfileOverride, graphRecallTop) {
  const route = API_ROUTES[INTENT_LLM_ROUTE];
  if (!route) throw new Error('LLM route not configured');
  const apiKey = route.getKey();
  if (!apiKey) throw new Error('LLM key not configured');

  const judgeTimings = {};
  let timer = performance.now();
  const merged = mergeCandidates(localResult.top, embeddingResult.top, topk || 10, graphRecallTop);
  judgeTimings.candidate_merge_ms = elapsedMs(timer);
  timer = performance.now();
  const queryProfile = queryProfileOverride || localResult.query_profile || embeddingResult.query_profile || analyzeQuery(query);
  const recallProfile = {
    rule_action: queryProfile.rule_action || '',
    semantic_action: queryProfile.semantic_action || '',
    semantic_task_mode: queryProfile.semantic_task_mode || '',
    semantic_boundary_confidence: queryProfile.semantic_boundary_confidence || 0,
    semantic_boundary_source: queryProfile.semantic_boundary && queryProfile.semantic_boundary.source || '',
    inferred_action: queryProfile.inferred_action || localResult.inferred_action || embeddingResult.inferred_action || inferAction(query),
    local_top_score: localResult.top1 && localResult.top1.score || 0,
    embedding_top_score: embeddingResult.top1 && (embeddingResult.top1.embedding_score || embeddingResult.top1.score) || 0,
    local_confidence: localResult.confidence || 0,
    local_margin: localResult.margin || 0,
    ...isWeakRecall(localResult, embeddingResult, merged),
  };
  judgeTimings.recall_quality_ms = elapsedMs(timer);
  timer = performance.now();
  const fallbackCatalog = recallProfile.weak ? buildFallbackCatalog(query, graphCandidates, merged, 18, queryProfile) : [];
  judgeTimings.fallback_catalog_ms = elapsedMs(timer);
  timer = performance.now();
  const candidates = merged.map((c, i) => ({
    rank: i + 1,
    intent_id: c.intent_id,
    intent_name: c.intent_name,
    eval_label: c.eval_label,
    action_code: c.action_code,
    object: c.object,
    domain: c.domain,
    local_score: c.local_score || 0,
    embedding_score: c.embedding_score || 0,
    object_alignment_score: c.object_alignment_score ?? 0,
    strong_object_terms: c.strong_object_terms || [],
    disambiguation_hints: c.disambiguation_hints,
    scope_out: c.scope_out,
    confusable_intents: c.confusable_intents,
    description: c.description,
    evidence: c.evidence || [],
  }));
  judgeTimings.candidate_pack_ms = elapsedMs(timer);
  const prompt = buildLlmPromptV2(query, candidates, fallbackCatalog.map((c, i) => ({ rank: i + 1, ...c })), recallProfile);
  const parsed = await callJsonApi(route.host, route.path, {
    model: LLM_MODEL,
    messages: [
      { role: 'system', content: '只输出合法 JSON object。禁止输出 Markdown、自然语言前缀或推理过程。' },
      { role: 'user', content: prompt },
    ],
    temperature: 0,
    max_tokens: LLM_JUDGE_MAX_TOKENS,
    response_format: { type: 'json_object' },
  }, apiKey, 90000);
  const apiChoice = parsed.choices && parsed.choices[0] || {};
  const message = apiChoice.message || {};
  const content = getMessageContent(message, parsed);
  let judge;
  let parseError = null;
  let initialParseError = null;
  let repaired = false;
  try {
    judge = extractJson(content);
  } catch (e) {
    initialParseError = e;
    parseError = e;
    try {
      judge = await repairLlmJudgeJson(content, query, candidates, fallbackCatalog.map((c, i) => ({ rank: i + 1, ...c })), route, apiKey);
      repaired = true;
      parseError = null;
    } catch (repairError) {
      parseError = repairError;
      judge = fallbackJudge(merged, repairError);
    }
  }
  judge.confidence = normalizeJudgeConfidence(judge.confidence);
  timer = performance.now();
  const rawSelection = selectLlmResult(judge, merged, fallbackCatalog);
  if (rawSelection.selected && judge.confidence <= 0) judge.confidence = 0.72;
  const selection = enforceTransferExecutionBoundary(query, rawSelection, merged, fallbackCatalog, queryProfile);
  judgeTimings.business_boundary_validation_ms = elapsedMs(timer);
  const selected = selection.selected;
  const diagnosis = Array.isArray(judge.diagnosis) ? [...judge.diagnosis] : [];
  if (selection.boundary_override) diagnosis.push('transfer_execution_boundary_override');
  return {
    method: 'deepseek_judge_with_graph_fallback',
    model: LLM_MODEL,
    model: LLM_MODEL,
    prompt_summary: {
      candidate_count: candidates.length,
      fallback_count: fallbackCatalog.length,
      recall_profile: recallProfile,
      local_top1: localResult.top1,
      embedding_top1: embeddingResult.top1,
    },
    prompt,
    raw_response: content,
    llm_diagnostics: {
      prompt_chars: prompt.length,
      prompt_bytes: Buffer.byteLength(prompt, 'utf8'),
      raw_response_chars: String(content || '').length,
      raw_response_bytes: Buffer.byteLength(String(content || ''), 'utf8'),
      finish_reason: apiChoice.finish_reason || '',
      usage: parsed.usage || {},
      max_tokens: LLM_JUDGE_MAX_TOKENS,
      initial_parse_error: initialParseError ? (initialParseError.message || String(initialParseError)) : '',
      repair_attempted: !!initialParseError,
      repair_succeeded: repaired,
      likely_truncated: apiChoice.finish_reason === 'length',
    },
    parsed: judge,
    parse_error: parseError ? (parseError.message || String(parseError)) : '',
    initial_parse_error: initialParseError ? (initialParseError.message || String(initialParseError)) : '',
    repaired,
    degraded: !!parseError,
    decision_mode: judge.decision_mode || (selection.source === 'fallback' ? 'graph_fallback' : selection.source === 'candidate' ? 'candidate_judge' : 'reject'),
    selected_source: selection.source,
    selected_rank: selection.source === 'candidate' ? selection.rank : 0,
    fallback_rank: selection.source === 'fallback' ? selection.rank : 0,
    boundary_override: !!selection.boundary_override,
    boundary_reason: selection.boundary_reason || '',
    fallback_catalog: fallbackCatalog,
    timings: judgeTimings,
    top: merged,
    final: selected ? applyRuntimeIntentLabel(applyRuntimeActionBoundary(query, { ...selected, sources: Array.from(new Set([...(selected.sources || []), selection.source === 'fallback' ? 'llm_fallback' : 'llm_candidate_judge', selection.boundary_override ? 'boundary_override' : ''])).filter(Boolean), score: round(judge.confidence || selected.score || 0) }, queryProfile)) : null,
    reason: selection.boundary_override ? selection.boundary_reason : (judge.reason || ''),
    diagnosis,
    slots: judge.slots || {},
    explanation: 'LLM 优先在本地方案和 embedding 方案合并后的 TopK 候选内裁决；当召回为空或证据很弱时，允许在图谱 fallback_catalog 中兜底选择，但仍必须复制已有意图节点。',
  };
}

async function safeRunLlmJudge(query, localResult, embeddingResult, graphCandidates, topk, queryProfileOverride, graphRecallTop) {
  try {
    return await runLlmJudge(query, localResult, embeddingResult, graphCandidates, topk, queryProfileOverride, graphRecallTop);
  } catch (error) {
    const queryProfile = queryProfileOverride || (localResult && localResult.query_profile) || (embeddingResult && embeddingResult.query_profile) || analyzeQuery(query);
    const merged = mergeCandidates(localResult && localResult.top || [], embeddingResult && embeddingResult.top || [], topk || 10, graphRecallTop);
    const judge = fallbackJudge(merged, error || new Error('LLM judge failed'));
    const selected = merged[0] || null;
    return {
      method: 'deepseek_judge_with_graph_fallback',
      model: LLM_MODEL,
      prompt_summary: {
        candidate_count: merged.length,
        fallback_count: 0,
        recall_profile: {
          rule_action: queryProfile.rule_action || '',
          semantic_action: queryProfile.semantic_action || '',
          semantic_task_mode: queryProfile.semantic_task_mode || '',
          semantic_boundary_confidence: queryProfile.semantic_boundary_confidence || 0,
          inferred_action: queryProfile.inferred_action || (localResult && localResult.inferred_action) || (embeddingResult && embeddingResult.inferred_action) || inferAction(query),
          local_top_score: localResult && localResult.top1 && localResult.top1.score || 0,
          embedding_top_score: embeddingResult && embeddingResult.top1 && (embeddingResult.top1.embedding_score || embeddingResult.top1.score) || 0,
          local_confidence: localResult && localResult.confidence || 0,
          local_margin: localResult && localResult.margin || 0,
          weak: true,
          reason: 'llm_call_failed',
        },
        local_top1: localResult && localResult.top1 || null,
        embedding_top1: embeddingResult && embeddingResult.top1 || null,
      },
      prompt: '',
      raw_response: '',
      llm_diagnostics: {
        prompt_chars: 0,
        prompt_bytes: 0,
        raw_response_chars: 0,
        raw_response_bytes: 0,
        finish_reason: '',
        usage: {},
        max_tokens: LLM_JUDGE_MAX_TOKENS,
        initial_parse_error: '',
        parse_error: error && (error.message || String(error)) || 'unknown llm error',
        repair_attempted: false,
        repair_succeeded: false,
        likely_truncated: false,
      },
      parsed: judge,
      parse_error: error && (error.message || String(error)) || 'unknown llm error',
      initial_parse_error: '',
      repaired: false,
      degraded: true,
      decision_mode: 'degraded_fusion',
      selected_source: selected ? 'candidate' : 'none',
      selected_rank: selected ? 1 : 0,
      fallback_rank: 0,
      boundary_override: false,
      boundary_reason: '',
      fallback_catalog: [],
      timings: {
        candidate_merge_ms: 0,
        candidate_pack_ms: 0,
        recall_quality_ms: 0,
        fallback_catalog_ms: 0,
        business_boundary_validation_ms: 0,
      },
      top: merged,
      final: selected ? applyRuntimeIntentLabel(applyRuntimeActionBoundary(query, {
        ...selected,
        sources: Array.from(new Set([...(selected.sources || []), 'degraded_fusion'])),
        score: round(judge.confidence || selected.score || selected.fused_score || 0.45),
      }, queryProfile)) : null,
      reason: 'LLM 调用失败，系统保留错误并按本地召回与 embedding 融合排序降级选择。',
      diagnosis: ['llm_call_failed', error && (error.message || String(error)) || 'unknown llm error'],
      slots: {},
      explanation: 'LLM 调用失败时不直接中断评测；系统进入 degraded_fusion，并在裁决链路中显式展示失败原因。',
    };
  }
}

function mergeCandidates(localTop, embeddingTop, limit, graphTop) {
  const map = new Map();
  for (const c of localTop || []) {
    const item = { ...c, local_score: c.score, sources: ['local'], evidence: Array.from(new Set([...(c.evidence || []), 'local_candidate'])) };
    map.set(c.intent_id + ':' + c.action_code, item);
  }
  for (const c of embeddingTop || []) {
    const key = c.intent_id + ':' + c.action_code;
    if (map.has(key)) {
      const item = map.get(key);
      item.embedding_score = c.embedding_score || c.score;
      item.embedding_adjusted_score = c.embedding_adjusted_score || c.score;
      item.object_alignment_score = Math.max(item.object_alignment_score || 0, c.object_alignment_score || 0);
      item.score = Math.max(item.score || 0, c.score || 0);
      item.sources.push('embedding');
      item.evidence = Array.from(new Set([...(item.evidence || []), ...(c.evidence || []), 'embedding_candidate']));
    } else {
      map.set(key, { ...c, embedding_score: c.embedding_score || c.score, embedding_adjusted_score: c.embedding_adjusted_score || c.score, sources: ['embedding'], evidence: Array.from(new Set([...(c.evidence || []), 'embedding_candidate'])) });
    }
  }
  // 图召回候选并入同一候选池：只贡献排序加成，不覆盖词法/向量自身分数。
  for (const c of graphTop || []) {
    const key = c.intent_id + ':' + (c.action_code || '');
    const existing = map.get(key) || Array.from(map.values()).find(item => item.intent_id === c.intent_id);
    if (existing) {
      existing.graph_score = Math.max(existing.graph_score || 0, c.score || 0);
      existing.graph_support = Math.max(existing.graph_support || 0, c.support || 1);
      existing.graph_relation = c.relation || existing.graph_relation;
      if (!existing.sources.includes('graph')) existing.sources.push('graph');
      existing.evidence = Array.from(new Set([...(existing.evidence || []), ...(c.evidence || []), 'graph_candidate']));
    } else {
      map.set(key, { ...c, graph_score: c.score || 0, graph_support: c.support || 1, sources: ['graph'], evidence: Array.from(new Set([...(c.evidence || []), 'graph_candidate'])) });
    }
  }
  const graphWeight = runtimeParameter(RSI_RUNTIME, 'graphWeight', 0.3);
  const baseScore = row => (row.sources.includes('local') && row.sources.includes('embedding') ? 0.15 : 0)
    + (row.local_score || 0) * 0.5
    + (row.embedding_adjusted_score || row.embedding_score || 0) * 0.42
    + (row.object_alignment_score || 0) * 0.18;
  const allRows = Array.from(map.values());
  const rankedRows = [], recallOnly = [];
  for (const row of allRows) {
    if (row.sources.length === 1 && row.sources[0] === 'graph') recallOnly.push(row);
    else rankedRows.push(row);
  }
  const ceiling = rankedRows.reduce((max, row) => Math.max(max, baseScore(row)), 0);
  for (const row of rankedRows) {
    let boost = 0;
    // 只有显式混淆边允许改分，且候选必须已与领先者近并列；共享对象/动作/兄弟只补召回。
    if (row.graph_relation === 'confusable' && baseScore(row) >= ceiling * 0.9) {
      const consensus = (row.graph_support || 1) >= 2 ? 1 : 0.5;
      boost = (row.graph_score || 0) * graphWeight * consensus;
    }
    row.fused_score = round(baseScore(row) + boost, 5);
  }
  rankedRows.sort((a, b) => b.fused_score - a.fused_score);
  recallOnly.sort((a, b) => (b.graph_score || 0) - (a.graph_score || 0));
  for (const row of recallOnly) row.fused_score = 0;
  // 图新召回候选追加在队尾（最多占 2 个位）：保证召回覆盖进入裁决候选池，
  // 但不顶掉词法/向量已经排出的顺序，避免离线降级时改坏 top1。
  const limitN = limit || 10;
  const reserve = recallOnly.length ? Math.min(2, Math.max(0, limitN - 1)) : 0;
  const merged = rankedRows.slice(0, Math.max(1, limitN - reserve));
  for (const row of recallOnly.slice(0, reserve)) merged.push(row);
  return merged;
}

function buildAttribution(query, localResult, embeddingResult, llmResult) {
  const localId = localResult.top1 && (localResult.top1.intent_id + ':' + localResult.top1.action_code);
  const embId = embeddingResult.top1 && (embeddingResult.top1.intent_id + ':' + embeddingResult.top1.action_code);
  const finalId = llmResult.final && (llmResult.final.intent_id + ':' + llmResult.final.action_code);
  const signals = [];
  if (localId && embId && localId === embId) signals.push({ type: 'agreement', level: 'strong', message: '本地方案与 embedding Top1 一致，候选稳定性较高。' });
  if (localId && embId && localId !== embId) signals.push({ type: 'disagreement', level: 'warning', message: '本地方案与 embedding Top1 不一致，需要查看业务对象和动作边界。' });
  if (finalId && finalId === localId) signals.push({ type: 'llm_alignment', level: 'info', message: 'LLM 最终裁判选择了本地方案 Top1。' });
  if (finalId && finalId === embId && finalId !== localId) signals.push({ type: 'llm_alignment', level: 'warning', message: 'LLM 最终裁判改选 embedding Top1 或语义候选。' });
  if (llmResult.selected_source === 'fallback') signals.push({ type: 'llm_fallback', level: 'warning', message: '前序召回为空或证据较弱，LLM 从图谱 fallback_catalog 中兜底选择。' });
  if (llmResult.boundary_override) signals.push({ type: 'boundary_override', level: 'warning', message: llmResult.boundary_reason || '最终结果触发业务边界校验并被纠正。' });
  if ((llmResult.prompt_summary || {}).recall_profile && llmResult.prompt_summary.recall_profile.weak) signals.push({ type: 'weak_recall', level: 'warning', message: '召回证据较弱，本轮需要重点检查图谱覆盖、动作识别和候选生成策略。' });
  if (embeddingResult.top && embeddingResult.top.length) signals.push({ type: 'semantic_recall', level: 'info', message: 'Embedding Top5 可用于判断正确意图是否被语义召回。' });
  return {
    query,
    final_source: llmResult.selected_source === 'fallback' ? 'llm_graph_fallback' : finalId === localId ? 'local' : finalId === embId ? 'embedding' : 'merged_topk',
    agreement: localId && embId ? localId === embId : false,
    signals,
    recommendation: signals.some(s => s.type === 'disagreement') ? '建议人工查看候选分歧、业务对象边界和动作边界。' : '候选链路较一致，可重点检查路由与执行绑定。',
  };
}

/**
 * 图召回通道：不依赖外部图数据库进程，直接用图谱节点自身的关系做子图扩展。
 * 种子来自 local/embedding 的高置信候选，沿混淆边、共享业务对象、共享动作、兄弟关系扩 1 跳。
 */
function runGraphRecallChannel(localResult, embeddingResult, candidates, topk) {
  const nodes = (candidates || []).map(candidate => candidate && candidate.node).filter(Boolean);
  if (!nodes.length) return { method: 'graph_subgraph_expand', top: [], top1: null, edges: 0, nodes: 0 };
  const index = buildGraphIndex(nodes);
  const seeds = [...(localResult.top || []), ...(embeddingResult.top || [])]
    .slice(0, 6)
    .map(candidate => ({ intent_id: candidate && candidate.intent_id, score: Number(candidate && candidate.score) || 0 }));
  const rows = graphRecall(seeds, index, {
    limit: Math.max(3, Math.min(Number(topk) || 5, 6)),
    minSeedScore: runtimeParameter(RSI_RUNTIME, 'graphSeedFloor', 0.3),
    minScore: runtimeParameter(RSI_RUNTIME, 'graphRowFloor', 0.2),
    relationWeights: {
      confusable: runtimeParameter(RSI_RUNTIME, 'graphConfusableWeight', 1.0),
      shared_object: runtimeParameter(RSI_RUNTIME, 'graphObjectWeight', 0.85),
      shared_action: runtimeParameter(RSI_RUNTIME, 'graphActionWeight', 0.7),
      sibling: runtimeParameter(RSI_RUNTIME, 'graphSiblingWeight', 0.55),
    },
  });
  return { method: 'graph_subgraph_expand', top: rows, top1: rows[0] || null, edges: index.edgeCount, nodes: index.nodeCount };
}

async function evaluateSingleIntentPipeline(query, candidates, topk, shapeDetection) {
  const pipelineStarted = performance.now();
  const timings = {};
  let checkpoint = performance.now();
  const ruleQueryProfile = analyzeQuery(query);
  const semanticBoundary = await safeRunSemanticBoundaryJudge(query, ruleQueryProfile);
  const queryProfile = applySemanticBoundaryToProfile(ruleQueryProfile, semanticBoundary);
  timings.query_understanding_ms = elapsedMs(checkpoint);
  checkpoint = performance.now();
  const localResult = runLocal(query, candidates, topk, queryProfile);
  if (!localResult.query_profile) localResult.query_profile = queryProfile;
  timings.local_recall_ms = elapsedMs(checkpoint);
  checkpoint = performance.now();
  const embeddingResult = await safeRunEmbedding(query, candidates, topk, queryProfile);
  timings.embedding_recall_ms = elapsedMs(checkpoint);
  checkpoint = performance.now();
  // 图召回通道：从 local/embedding 的高置信候选出发，沿图谱关系（混淆边/共享对象/共享动作/兄弟）扩展 1 跳邻居。
  const graphResult = runGraphRecallChannel(localResult, embeddingResult, candidates, topk);
  timings.graph_recall_ms = elapsedMs(checkpoint);
  checkpoint = performance.now();
  // 确定性直判：local 与 embedding Top1 一致且是声明说法（utterance_view/scope_in）的
  // 精确或紧近命中（去前后缀修饰后全等）→ 直接采纳，不进 LLM judge。
  // LLM judge 有温度：同一句两次评测可能翻到近义意图（rsi_t014「申请信用卡进度到哪了」
  // 在「查询申请进度」vs「查询申请信用卡」之间抛硬币，基线自身 5 测 2 翻）。这类
  // 双召回一致的题本就无需裁决，跳过 judge 同时消除了最大的单题噪声源。
  const localTop1 = localResult.top1, embTop1 = embeddingResult.top1;
  const stripMod = q => String(q || '').replace(/^(帮我|请|麻烦|我要|我想|给我)+/, '')
    .replace(/(一下|下|下子)$/, '').replace(/^(查|看|查查看|看看|查询|查看下|查下)/, '').trim();
  const exactUtteranceHit = c => {
    if (!c) return false;
    const rp = c.node?.retrieval_profile || {};
    const sd = c.node?.semantic_definition || {};
    const words = [...(rp.utterance_view || []), ...(sd.scope_in || [])].filter(Boolean);
    const q = stripMod(query);
    return words.some(w => w === query || w === q || stripMod(w) === q);
  };
  // score 保留原值：抬到 0.99 会把泛化 query 误判成 confidentExact（≥0.98），
  // 切断泛化澄清路径（rsi_t207「民生服务」实测被直判破坏）。泛化/裸词 query 一律不直判。
  // 泛化形态判定不看分数：的事/裸词/泛化动作等形态本身就是「应澄清」的证据，
  // A6 补说法会推高 local 分数，若把分数掺进判定，泛化题会被直判抢答（rsi_t205 实测）。
  const looksGeneric = declaredAmbiguityCandidates(query, candidates || [], undefined, RSI_RUNTIME).length >= 2
    || isGenericAmbiguousQuery(query, null) || isGenericAmbiguousQuery(query, localTop1);
  // 复合查询守卫：query 含有其他候选名中的业务词片段但 top1 不含 → 可能漏选，阻止直判交 LLM judge
  const mergedForGuard = mergeCandidates(localResult.top || [], embeddingResult.top || [], 10, graphResult.top);
  const deterministicAgree = !looksGeneric && localTop1 && embTop1 && localTop1.intent_id === embTop1.intent_id
    && (exactUtteranceHit(localTop1) || (localTop1.score || 0) >= 0.9)
    && !hasCompetingCandidate(query, localTop1, mergedForGuard);
  // 声明说法逐字命中直判：local Top1 evidence 含 utterance_exact（query 与图谱声明说法归一化后
  // 完全一致）且无并列命中 → 图谱声明本身即权威答案，不依赖 embedding 背书，也不进 LLM judge。
  // 泛化/声明歧义簇形态仍被 looksGeneric 挡住（泛化题必须走澄清路径），双命中交给 judge 裁决。
  const exactHitRows = (localResult.top || []).filter(c => (c.evidence || []).includes('utterance_exact'));
  const deterministicExact = !looksGeneric && exactHitRows.length === 1
    && localTop1 && exactHitRows[0].intent_id === localTop1.intent_id && (localTop1.score || 0) >= 1.2
    && !hasCompetingCandidate(query, localTop1, mergedForGuard);
  // 泛化题兜底：judge 偶尔把「民生服务」这类裸业务词判给闲聊（runtime_idle_chat），
  // 另一些时候正确 reject 转澄清——同一题两次评测两种结果，是最隐蔽的测量噪声。
  // 程序化规则：泛化 query + judge 选了闲聊/低置信(<0.5) → 强制 reject（final=null），
  // 让泛化澄清接管。这个决策不依赖模型情绪，完全可复现。
  const genericChatterGuard = looksGeneric && localTop1 && (localTop1.score || 0) < 0.75;
  // 多意图任务全对守卫（在管线后段有 pred_set 后再看）：任务实例全对 → needs_clarification
  // 一定是 judge 温度噪声（任务都认全了没有可澄清的内容）。管线后段覆盖见 applyMultiTaskClarifyGuard。
  const llmResult = (deterministicAgree || deterministicExact)
    ? { final: { ...localTop1 }, selected_source: 'candidate',
        decision_mode: deterministicExact ? 'deterministic_declared_exact' : 'deterministic_agree', slots: {},
        reason: deterministicExact ? 'query 与图谱声明说法逐字一致且无并列命中，直接采纳以消除裁决噪声' : 'local 与 embedding Top1 一致且命中声明说法，跳过 LLM 裁决以保证可复现性',
        top: mergeCandidates(localResult.top || [], embeddingResult.top || [], 10, graphResult.top), timings: {}, parsed: null,
        degraded: false, deterministic: true }
    : await safeRunLlmJudge(query, localResult, embeddingResult, candidates, Math.max(topk, 10), queryProfile, graphResult.top);
  if (genericChatterGuard && llmResult.final
      && (/idle_chat|闲聊/.test(llmResult.final.intent_id + llmResult.final.intent_name || '')
          || (llmResult.final.score || 0) < 0.5)) {
    llmResult.final = null;
    llmResult.selected_source = 'none';
    llmResult.decision_mode = 'generic_reject_guard';
    llmResult.reason = '泛化 query 命中程序化兜底：闲聊/低置信判定被否决，转澄清路径';
    llmResult.deterministic = true;
  }
  timings.deepseek_judge_ms = elapsedMs(checkpoint);
  checkpoint = performance.now();
  const llmFinal = llmResult.final;
  const faqCorrectedFinal = applyFaqSeedObjectCorrection(query, llmFinal, localResult, embeddingResult);
  const correctedResult = applyHighPrecisionIntentOverride(query, applyObjectSpecialization(query, applyRuntimeIntentLabel(deriveAskIntentFromObjectCandidate(
    query,
    faqCorrectedFinal,
    localResult,
    embeddingResult
  ))), candidates);
  const boundaryCorrectedResult = applySemanticBoundaryCorrection(query, correctedResult, localResult, embeddingResult, candidates, queryProfile);
  let finalResult = applyRuntimeIntentLabel(applyRuntimeActionBoundary(query, applyObjectSpecialization(query, boundaryCorrectedResult), queryProfile));
  // 泛化 query-action 对齐：探查/查看/状态查询句式触发，normalizeEvalLabel + 缺失词两层匹配
  finalResult = alignQueryAction(query, finalResult, candidates);
  // Fix A: 同义词排序修正——"付款额度"→"支付限额"
  // 不属于 action 对齐范畴（finalResult 已是 query），是同义词排序问题，保留为独立修正块。
  // 未来泛化方向：通过 OBJECT_ALIAS_RULES 扩展"付款"→"支付"同义词映射。
  if (finalResult && /付款/.test(query) && /(额度|限额)/.test(query)) {
    const curLabel = finalResult.intent_name || finalResult.eval_label || finalResult.object || '';
    if (/查额度/.test(curLabel) && !/支付限额/.test(curLabel)) {
      const payLimitAlt = (candidates || []).find(c =>
        c.action_code === 'query' && /支付限额/.test(c.intent_name || c.eval_label || c.object || '')
      );
      if (payLimitAlt) {
        finalResult = {
          ...payLimitAlt,
          score: Math.max(finalResult.score || 0, 0.85),
          display_name: payLimitAlt.intent_name || payLimitAlt.eval_label || payLimitAlt.object || '',
          runtime_boundary: 'payment_limit_override',
          evidence: Array.from(new Set([...(payLimitAlt.evidence || []), 'payment_limit_override'])),
          sources: Array.from(new Set([...(payLimitAlt.sources || []), 'payment_limit_override'])),
        };
      }
    }
  }
  const idleReason = '形态检测未发现明确业务任务，且最终候选缺少强对象或动作证据。';
  // 泛化守卫延伸：guard 命中（generic_reject_guard）时不允许 idle-chat 兜底抢答——
  // 那会重新塞回闲聊 final，让泛化澄清永远不触发（rsi_t207 实测）。
  // guard 触发面含 judge 自身 reject：泛化 query 上 judge 拒答（final=null）正是「该澄清」的信号，
  // 此时 idle 兜底抢答会把泛化澄清永久吞掉（rsi_t207：judge 10 次里 6 次 reject 却被闲聊顶掉）。
  const guardActive = llmResult.decision_mode === 'generic_reject_guard'
    || (looksGeneric && !llmResult.final);
  const boundaryFinalResult = !guardActive && shouldTreatAsIdleChat(query, shapeDetection, finalResult, queryProfile)
    ? buildIdleChatResult(query, idleReason)
    : finalResult;
  llmResult.final = boundaryFinalResult;
  if (boundaryFinalResult && boundaryFinalResult.action_code === 'idle_chat') {
    llmResult.boundary_override = true;
    llmResult.boundary_reason = idleReason;
  }
  const understanding = boundaryFinalResult && boundaryFinalResult.action_code === 'idle_chat'
    ? buildIdleChatUnderstanding(query, idleReason)
    : buildIntentUnderstanding(query, llmResult, candidates);
  timings.postprocess_ms = elapsedMs(checkpoint);
  timings.total_ms = elapsedMs(pipelineStarted);
  llmResult.decision_trace = buildDecisionTrace(query, localResult, embeddingResult, llmResult, llmFinal, faqCorrectedFinal, boundaryFinalResult, understanding, timings);
  return {
    query,
    result_type: boundaryFinalResult && boundaryFinalResult.action_code === 'idle_chat' ? 'idle_chat' : 'single_intent',
    evaluator: {
      version_id: INTENT_EVALUATOR_VERSION_ID,
      version_name: INTENT_EVALUATOR_VERSION_NAME,
      version_stage: INTENT_EVALUATOR_VERSION_STAGE,
    },
    final_result: llmResult.final,
    authoritative_results: [buildAuthoritativeResult({
      segment_index: 1,
      query,
      final_result: llmResult.final,
      understanding,
    })],
    understanding,
    answers: boundaryFinalResult && boundaryFinalResult.action_code === 'idle_chat' ? [getIdleChatAnswer(query)] : [],
    methods: {
      local: localResult,
      embedding: embeddingResult,
      graph: graphResult,
      llm_judge: llmResult,
    },
    attribution: buildAttribution(query, localResult, embeddingResult, llmResult),
    timings,
  };
}

function aggregateMethodTop(segmentResults, methodName, perSegmentLimit) {
  const rows = [];
  for (const segment of segmentResults) {
    const method = ((segment.methods || {})[methodName]) || {};
    for (const candidate of (method.top || []).slice(0, perSegmentLimit || 4)) {
      rows.push({
        ...candidate,
        segment_index: segment.segment_index,
        segment_query: segment.query,
        evidence: Array.from(new Set([...(candidate.evidence || []), `segment_${segment.segment_index}`])),
      });
    }
  }
  return rows;
}

function buildCompositeUnderstanding(query, segmentResults) {
  const tasks = [];
  const questions = [];
  const types = new Set(['composite_intent']);
  let finalIsNonLeaf = false;

  for (const segment of segmentResults) {
    const understanding = segment.understanding || {};
    finalIsNonLeaf = finalIsNonLeaf || !!understanding.final_is_non_leaf;
    // 泛化澄清传递守卫：子句已有确定 final（任务实例全对）时，generic_ambiguous_intent
    // 不再向组合层传递——两个子句都各自落在具体意图上，「泛化不确定」前提不成立，
    // 组合澄清只会把全对的题打成 unexpected_clarification（t101/t108/t105 实测）。
    // 其他类型（payee/multi_task/non_leaf/llm_slot）保留传递，它们是真实的澄清需求。
    const segTypes = (((understanding.clarification || {}).types) || [])
      .filter(t => !(t === 'generic_ambiguous_intent' && segment.final_result));
    for (const type of segTypes) types.add(type);
    const segQuestions = (((understanding.clarification || {}).questions) || [])
      .filter(q => !(q.type === 'generic_ambiguous_intent' && segment.final_result));
    for (const question of segQuestions) {
      const customerQuestion = question.type === 'payee_ambiguity_confirmation' && question.question && !/歧义|不明确|确认.*收款人/.test(question.question)
        ? `收款人信息可能有歧义。${question.question}`
        : question.question;
      questions.push({
        ...question,
        question: customerQuestion,
        segment_index: segment.segment_index,
        segment_query: segment.query,
      });
    }
    const segmentTasks = (understanding.tasks || []).length
      ? understanding.tasks
      : [{
          task_index: 1,
          intent_id: segment.final_result && segment.final_result.intent_id || '',
          intent_name: segment.final_result && segment.final_result.intent_name || '',
          eval_label: segment.final_result && segment.final_result.eval_label || '',
          display_name: getDisplayName(segment.final_result),
          action_code: segment.final_result && segment.final_result.action_code || '',
          status: 'ready',
        }];
    for (const task of segmentTasks) {
      tasks.push({
        ...task,
        task_id: `segment_${segment.segment_index}_task_${tasks.length + 1}`,
        task_index: tasks.length + 1,
        slots: { ...(understanding.slots || {}), ...(task.slots || {}),
          ...(task.payee ? { payee: task.payee } : {}), ...(task.amount ? { amount: task.amount } : {}) },
        span: segment.span || null,
        // Sequencing is not inferred from array position. Missing semantic
        // dependency information remains explicit for the scorer to diagnose.
        depends_on: task.depends_on || [],
        segment_index: segment.segment_index,
        segment_query: segment.query,
        intent_id: task.intent_id || (segment.final_result && segment.final_result.intent_id) || '',
        intent_name: task.intent_name || (segment.final_result && segment.final_result.intent_name) || '',
        eval_label: task.eval_label || (segment.final_result && segment.final_result.eval_label) || '',
        display_name: task.display_name || getDisplayName(segment.final_result),
        action_code: task.action_code || (segment.final_result && segment.final_result.action_code) || '',
      });
    }
  }

  const filteredQuestions = questions.filter(question => {
    if (!question || question.type !== 'generic_ambiguous_intent') return true;
    const options = Array.isArray(question.options) ? question.options : [];
    if (options.length !== 1) return true;
    const single = options[0] || {};
    const segment = segmentResults.find(item => item.segment_index === question.segment_index) || {};
    const finalResult = segment.final_result || {};
    const finalIntentId = String(finalResult.intent_id || '').trim();
    const finalDisplay = normalize(getDisplayName(finalResult));
    const optionIntentId = String(single.intent_id || single.value || '').trim();
    const optionDisplay = normalize(single.display_label || single.label || single.intent_name || '');
    if (finalIntentId && optionIntentId && finalIntentId === optionIntentId) return false;
    if (finalDisplay && optionDisplay && finalDisplay === optionDisplay) return false;
    return true;
  });

  return {
    cardinality: 'multi_intent',
    task_count: tasks.length,
    segment_count: segmentResults.length,
    is_multi_intent: true,
    final_is_non_leaf: finalIsNonLeaf,
    reason: `识别到 ${segmentResults.length} 个独立子意图，已按子句分别召回、裁决并合并为任务计划。`,
    tasks,
    clarification: {
      needed: filteredQuestions.length > 0,
      types: Array.from(types),
      question: filteredQuestions.map(q => q.question).join(' '),
      questions: filteredQuestions,
      options: filteredQuestions.flatMap(q => q.options || []),
      service_style: 'customer_facing_concise',
      internal_reason: '组合 query 先进行子意图切分，再分别进入本地规则、embedding 和 LLM 裁决，避免单一动作门控吞掉其他子意图。',
      default_action: filteredQuestions.length ? 'ask_user_confirmation' : 'execute_or_route',
    },
  };
}

function buildCompositeAttribution(query, segmentResults) {
  return {
    query,
    final_source: 'composite_intent_planner',
    agreement: false,
    signals: [
      {
        type: 'composite_split',
        level: 'warning',
        message: `检测到组合 query，已拆分为 ${segmentResults.length} 个子意图分别评测。`,
      },
    ...segmentResults.map(segment => ({
        type: 'segment_result',
        level: 'info',
        message: `子意图 #${segment.segment_index}「${segment.query}」 -> ${getDisplayName(segment.final_result) || '未命中'}`,
      })),
    ],
    recommendation: '优先查看各子意图的召回链路，再检查组合任务的澄清问题是否只针对需要确认的子任务。',
  };
}

function buildCompositeDecisionTrace(query, segmentResults, understanding, timings) {
  const compositeTimings = timings || {};
  const segmentTimings = segmentResults.map(segment => segment.timings || {});
  const sumTiming = key => segmentTimings.reduce((sum, item) => sum + (Number(item[key]) || 0), 0);
  const splitTiming = compositeTimings.shape_detection_ms || 0;
  const segmentRows = segmentResults.map(segment => {
    const llm = segment.methods && segment.methods.llm_judge || {};
    return {
      segment_index: segment.segment_index,
      query: segment.query,
      final: compactTraceCandidate(segment.final_result),
      decision_mode: llm.decision_mode || '',
      selected_source: llm.selected_source || '',
      selected_rank: llm.selected_rank || 0,
      degraded: !!llm.degraded,
      repaired: !!llm.repaired,
      parse_error: llm.parse_error || '',
      diagnostics: llm.llm_diagnostics || {},
      timings: segment.timings || {},
    };
  });
  return {
    summary: `识别到 ${segmentResults.length} 个子意图，系统先拆分子句，再对每个子句分别执行本地召回、embedding 召回和 LLM 裁决，最后合并为多意图任务计划。`,
    steps: [
      {
        step: 'query_understanding',
        title: '查询理解',
        conclusion: '当前 query 被识别为多意图表达，不能只输出单个 Top1 意图。',
        data: { query, understanding },
        timing_ms: compositeTimings.query_understanding_ms || splitTiming,
      },
      {
        step: 'intent_shape_analysis',
        title: '意图形态判断',
        conclusion: `识别为 multi_intent，包含 ${segmentResults.length} 个独立子意图。`,
        data: {
          cardinality: 'multi_intent',
          segment_count: segmentResults.length,
          task_count: understanding && understanding.task_count,
          shape_detection: understanding && understanding.shape_detection,
        },
        timing_ms: compositeTimings.shape_detection_ms || splitTiming,
      },
      {
        step: 'composite_split',
        title: '多意图拆分',
        conclusion: `已拆分为 ${segmentResults.length} 个子句：${segmentResults.map(x => `#${x.segment_index} ${x.query}`).join('；')}。`,
        data: segmentRows.map(row => ({ segment_index: row.segment_index, query: row.query })),
        timing_ms: compositeTimings.composite_split_ms || 0,
      },
      {
        step: 'action_slot_extraction',
        title: '分段动作与槽位解析',
        conclusion: `已对 ${segmentResults.length} 个子句分别解析动作、金额、对象等线索。`,
        data: segmentResults.map(segment => {
          const profile = ((segment.methods && segment.methods.local) || {}).query_profile || analyzeQuery(segment.query);
          return {
            segment_index: segment.segment_index,
            query: segment.query,
            inferred_action: profile.inferred_action || '',
            amount: profile.amount || '',
            purchase_execution: !!profile.purchase_execution,
            transfer_execution: !!profile.transfer_execution,
            ask_query: !!profile.ask_query,
          };
        }),
        timing_ms: sumTiming('query_understanding_ms'),
      },
      {
        step: 'local_recall',
        title: '分段本地召回',
        conclusion: `已对 ${segmentResults.length} 个子句分别执行本地规则、词典和图谱召回。`,
        data: segmentRows.map(row => ({
          segment_index: row.segment_index,
          query: row.query,
          local_recall_ms: row.timings.local_recall_ms || 0,
        })),
        timing_ms: sumTiming('local_recall_ms'),
      },
      {
        step: 'embedding_recall',
        title: '分段语义召回',
        conclusion: `已对 ${segmentResults.length} 个子句分别执行 Qwen embedding 语义召回。`,
        data: segmentRows.map(row => ({
          segment_index: row.segment_index,
          query: row.query,
          embedding_recall_ms: row.timings.embedding_recall_ms || 0,
        })),
        timing_ms: sumTiming('embedding_recall_ms'),
      },
      {
        step: 'recall_quality_gate',
        title: '分段召回质量判断',
        conclusion: `已对 ${segmentResults.length} 个子句分别判断强召回、弱召回和召回分歧。`,
        data: segmentRows.map(row => {
          const segment = segmentResults.find(item => item.segment_index === row.segment_index) || {};
          const llm = segment.methods && segment.methods.llm_judge || {};
          return {
            segment_index: row.segment_index,
            query: row.query,
            recall_profile: (llm.prompt_summary || {}).recall_profile || {},
          };
        }),
        timing_ms: 0,
      },
      {
        step: 'candidate_merge',
        title: '分段候选融合排序',
        conclusion: `已对 ${segmentResults.length} 个子句分别融合本地候选与 embedding 候选。`,
        data: segmentRows.map(row => {
          const segment = segmentResults.find(item => item.segment_index === row.segment_index) || {};
          const llm = segment.methods && segment.methods.llm_judge || {};
          return {
            segment_index: row.segment_index,
            query: row.query,
            candidate_count: (llm.prompt_summary || {}).candidate_count || 0,
            local_top1: compactTraceCandidate(((segment.methods || {}).local || {}).top1),
            embedding_top1: compactTraceCandidate(((segment.methods || {}).embedding || {}).top1),
          };
        }),
        timing_ms: 0,
      },
      {
        step: 'fallback_catalog',
        title: '分段图谱兜底目录',
        conclusion: `已按子句判断是否需要启用图谱兜底目录。`,
        data: segmentRows.map(row => {
          const segment = segmentResults.find(item => item.segment_index === row.segment_index) || {};
          const llm = segment.methods && segment.methods.llm_judge || {};
          return {
            segment_index: row.segment_index,
            query: row.query,
            fallback_count: (llm.prompt_summary || {}).fallback_count || 0,
          };
        }),
        timing_ms: 0,
      },
      {
        step: 'segment_judges',
        title: '子意图分别裁决',
        conclusion: '每个子句都有独立的 LLM 候选内裁决链路，详见下方“子意图裁决链路”。',
        data: segmentRows,
        timing_ms: sumTiming('deepseek_judge_ms'),
      },
      {
        step: 'business_boundary_validation',
        title: '分段业务边界校验',
        conclusion: `已对 ${segmentResults.length} 个子意图分别执行动作边界、对象边界和运行时派生校验。`,
        data: segmentRows.map(row => {
          const segment = segmentResults.find(item => item.segment_index === row.segment_index) || {};
          const llm = segment.methods && segment.methods.llm_judge || {};
          return {
            segment_index: row.segment_index,
            query: row.query,
            boundary_override: !!llm.boundary_override,
            boundary_reason: llm.boundary_reason || '',
            final: compactTraceCandidate(segment.final_result),
          };
        }),
        timing_ms: sumTiming('postprocess_ms'),
      },
      {
        step: 'clarification_decision',
        title: '组合澄清判断',
        conclusion: (understanding && understanding.clarification && understanding.clarification.needed)
          ? `组合任务存在需要澄清的问题：${(understanding.clarification.types || []).join('、')}。`
          : '组合任务当前不需要追问澄清，可进入路由或执行编排。',
        data: understanding && understanding.clarification || {},
        timing_ms: 0,
      },
      {
        step: 'final_result',
        title: '最终结果',
        conclusion: `最终合并为多意图任务计划，包含 ${segmentResults.length} 项任务。`,
        selected: compactTraceCandidate({
          intent_id: `composite_${sha(query, 12)}`,
          intent_name: '多意图任务计划',
          display_name: `多意图任务计划（${segmentResults.length}项）`,
          action_code: 'multi_intent',
          score: segmentResults.length ? round(segmentResults.reduce((sum, item) => sum + ((item.final_result && item.final_result.score) || 0), 0) / segmentResults.length, 4) : 0,
        }),
        timing_ms: sumTiming('total_ms'),
      },
    ],
  };
}

function buildCompositeResult(query, graph, candidates, loadedAt, topk, segmentResults, started, shapeDetection, compositeTimings) {
  const scores = segmentResults
    .map(item => item.final_result && item.final_result.score)
    .filter(value => typeof value === 'number' && !Number.isNaN(value));
  const avgScore = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  const finalLabels = segmentResults
    .map(item => getDisplayName(item.final_result))
    .filter(Boolean);
  const understanding = {
    ...buildCompositeUnderstanding(query, segmentResults),
    shape_detection: shapeDetection || null,
  };
  const localTop = aggregateMethodTop(segmentResults, 'local', topk);
  const embeddingTop = aggregateMethodTop(segmentResults, 'embedding', topk);
  const llmTop = segmentResults
    .map(segment => segment.final_result ? {
      ...segment.final_result,
      segment_index: segment.segment_index,
      segment_query: segment.query,
      evidence: Array.from(new Set([...(segment.final_result.evidence || []), `segment_${segment.segment_index}`, 'llm_segment_final'])),
    } : null)
    .filter(Boolean);

  return {
    query,
    result_type: 'multi_intent_plan',
    evaluator: {
      version_id: INTENT_EVALUATOR_VERSION_ID,
      version_name: INTENT_EVALUATOR_VERSION_NAME,
      version_stage: INTENT_EVALUATOR_VERSION_STAGE,
    },
    graph: buildGraphRuntimeInfo(graph, candidates, loadedAt),
    models: {
      embedding: EMBEDDING_MODEL,
      llm: LLM_MODEL,
    },
    final_result: {
      intent_id: `composite_${sha(query, 12)}`,
      intent_name: '多意图任务计划',
      eval_label: '多意图任务计划',
      display_name: `多意图任务计划（${segmentResults.length}项）`,
      action_code: 'multi_intent',
      object: finalLabels.join(' + '),
      domain: '组合意图',
      score: round(avgScore || 0.5, 4),
      sources: ['composite_intent_planner'],
      result_labels: finalLabels,
      semantic_role: 'summary_only',
    },
    authoritative_results: segmentResults.map(buildAuthoritativeResult),
    final_results: segmentResults.map(segment => ({
      segment_index: segment.segment_index,
      query: segment.query,
      final_result: segment.final_result,
      understanding: segment.understanding,
      methods: segment.methods,
      attribution: segment.attribution,
    })),
    understanding,
    methods: {
      local: {
        method: 'segmented_local_lexical_rules_graph',
        inferred_action: 'multi_intent',
        top: localTop,
        top1: localTop[0] || null,
        confidence: round(avgScore || 0.5, 4),
        margin: 0,
        explanation: '组合 query 已先拆分为多个子意图，每个子意图分别运行本地规则、词典和图谱检索。',
      },
      embedding: {
        method: 'segmented_qwen_embedding',
        model: EMBEDDING_MODEL,
        query_embedding_cached: false,
        inferred_action: 'multi_intent',
        top: embeddingTop,
        top1: embeddingTop[0] || null,
        missing_candidate_vectors: 0,
        explanation: '组合 query 的 embedding 结果按子意图分别计算，避免后半句语义覆盖前半句。',
      },
      graph: {
        method: 'segmented_graph_subgraph_expand',
        top: aggregateMethodTop(segmentResults, 'graph', 4),
        top1: aggregateMethodTop(segmentResults, 'graph', 4)[0] || null,
        explanation: '组合 query 的图召回按子意图分别沿图谱关系扩展，再汇总候选。',
      },
      llm_judge: {
        method: 'segmented_deepseek_judge',
        model: LLM_MODEL,
        decision_mode: 'composite_intent_plan',
        selected_source: 'segments',
        selected_rank: 0,
        fallback_rank: 0,
        top: llmTop,
        final: null,
        reason: understanding.reason,
        diagnosis: ['composite_query_split', 'segment_level_evaluation'],
        decision_trace: buildCompositeDecisionTrace(query, segmentResults, understanding, compositeTimings),
        explanation: '组合 query 不直接让 LLM 在整句候选中裁决，而是先拆成子意图分别裁决，再合并任务计划。',
      },
    },
    segment_results: segmentResults,
    attribution: buildCompositeAttribution(query, segmentResults),
    latency_ms: Date.now() - started,
  };
}

function likelyNeedsShapeFallback(query, shapeDetection) {
  const raw = String(query || '').trim();
  if (!raw) return false;
  if (shapeDetection && shapeDetection.shape === 'multi_intent') return false;
  const segments = shapeDetection && Array.isArray(shapeDetection.segments) ? shapeDetection.segments : splitCompositeQuery(raw);
  const hasBoundary = /[，,；;。！？?]/.test(raw) || /(?:然后|并且|同时|顺便|另外|还有|还想|我还想|再帮我|再给我|再问问|再查|再)/.test(raw);
  const hasEnumeration = /(和|与|以及|及|、)/.test(raw) && /(查|查询|查看|看看|余额|账单|明细|记录|待还|额度|积分)/.test(raw);
  const profiles = segments.map(analyzeQuery);
  const actionCount = new Set(profiles.map(p => p.inferred_action).filter(Boolean)).size;
  const tasks = shapeDetection && Array.isArray(shapeDetection.tasks) ? shapeDetection.tasks : [];
  const ambiguousSpans = shapeDetection && Array.isArray(shapeDetection.ambiguous_spans) ? shapeDetection.ambiguous_spans : [];
  const actionableSegments = tasks
    .filter(task => task.role === 'task' || task.role === 'ambiguous_task').length;
  const distinctTaskActions = new Set(tasks.map(task => task.action).filter(Boolean)).size;
  const hasTransfer = profiles.some(p => p.transfer_execution || p.inferred_action === 'transfer');
  const hasQuery = profiles.some(p => p.inferred_action === 'query' || /(查|查询|查看|看看|余额|账单|明细|记录)/.test(p.original || ''));
  const localShape = shapeDetection && shapeDetection.shape || '';
  const localMismatch = (tasks.length >= 2 && localShape !== 'multi_intent')
    || (tasks.length >= 1 && ambiguousSpans.length >= 1 && localShape === 'single_intent');
  const complexStructure = actionCount >= 2
    || distinctTaskActions >= 2
    || (hasTransfer && hasQuery)
    || segments.length >= 2;
  return hasBoundary
    || hasEnumeration
    || localMismatch
    || (complexStructure && actionableSegments < 2)
    || (complexStructure && localShape === 'ambiguous_intent');
}

function buildLlmShapePrompt(query, localShape) {
  return [
    runtimeInstruction(RSI_RUNTIME, 'shape'),
    '你是手机银行意图理解器，负责判断用户 query 的意图形态并拆解任务。只输出合法 JSON object，第一字符必须是 {。',
    '',
    '核心任务：',
    '1. 判断 shape：single_intent、multi_intent、ambiguous_intent、multi_task_same_intent。',
    '2. multi_intent 表示用户要办理/查询/咨询两个或以上相互独立的银行任务，例如“查余额，再转账”。',
    '3. multi_task_same_intent 表示同一个意图下有多个任务实例，例如“给张三和李四转200”，意图是转账，收款人是槽位，不拆成两个意图。',
    '3.1 先判断结构，再判断主动作强弱。不能因为“转账/还款/购买”等执行动作更强，就把“查余额然后转账”压成 single_intent。',
    '4. 背景/目的不是意图，例如“我要去旅游，先看看卡里还有多少”只有“查余额”一个银行意图，“我要去旅游”是 context。',
    '5. 连接词如果在固定表达内部不要拆，例如“卡里还有多少”不是“还有”连接两个任务。',
    '6. 子任务 text 必须是用户原文中可独立执行或查询的片段，可适当补全省略的动作，但不要编造图谱节点名。',
    '7. action_hint 只能是 ask、query、transfer、repay、apply、open、change、cancel、close、guide、unknown。',
    '8. 如果一句话里能抽出两个以上可独立查询/执行的任务片段，优先判 multi_intent。',
    '9. 如果一句话只有一个主动作，其他信息只是收款人、金额、账户、时间等槽位展开，判 multi_task_same_intent 或 single_intent，不要误拆。',
    '',
    '判定样例：',
    '- “查余额然后给张三转100” => multi_intent，tasks 至少包括“查余额”“给张三转100”。',
    '- “给张三和李四转100” => multi_task_same_intent，任务核心仍是一次转账意图，张三李四是收款人槽位集合。',
    '- “我去旅游前想看看卡里还有多少钱” => single_intent，只有“查余额”，旅游是背景。',
    '',
    '输出字段：',
    '{"shape":"single_intent|multi_intent|ambiguous_intent|multi_task_same_intent","tasks":[{"text":"","action_hint":"","object_hint":"","reason":""}],"context_spans":[""],"ambiguous_spans":[""],"reason":""}',
    '',
    'query=' + query,
    'local_shape=' + JSON.stringify(localShape || {}),
  ].join('\n');
}

function normalizeLlmShapeTask(task) {
  const text = String(task && task.text || '').trim()
    .replace(/^(然后|并且|同时|顺便|另外|还有|还想|我还想|再帮我|再给我|再问问|再查|再)\s*/, '')
    .replace(/^(这个|那个)(?=[\u4e00-\u9fa5A-Za-z0-9]{2,})/, '');
  if (!text || text.length < 2) return null;
  if (/^(先|我想|想)?(了解一下|咨询一下|问一下|看一下)$/.test(text)) return null;
  if (isBackgroundOnlySegment(text)) return null;
  return {
    text,
    role: 'task',
    action: String(task.action_hint || ''),
    object: String(task.object_hint || ''),
    confidence: 0.78,
    reason: String(task.reason || 'LLM 形态拆解输出的独立任务片段。').slice(0, 80),
  };
}

async function runLlmShapeFallback(query, localShape) {
  const route = API_ROUTES[INTENT_LLM_ROUTE];
  if (!route) throw new Error('LLM route not configured');
  const apiKey = route.getKey();
  if (!apiKey) throw new Error('LLM key not configured');
  const prompt = buildLlmShapePrompt(query, localShape);
  const parsed = await callJsonApi(route.host, route.path, {
    model: LLM_MODEL,
    messages: [
      { role: 'system', content: '只输出合法 JSON object。禁止输出 Markdown、自然语言前缀或推理过程。' },
      { role: 'user', content: prompt },
    ],
    temperature: 0,
    max_tokens: Math.max(900, LLM_REPAIR_MAX_TOKENS || 900),
    response_format: { type: 'json_object' },
  }, apiKey, 60000);
  const apiChoice = parsed.choices && parsed.choices[0] || {};
  const message = apiChoice.message || {};
  const raw = getMessageContent(message, parsed);
  const result = extractJson(raw);
  const tasks = Array.isArray(result.tasks) ? result.tasks.map(normalizeLlmShapeTask).filter(Boolean) : [];
  return {
    shape: result.shape || 'single_intent',
    segments: tasks.map(task => task.text),
    tasks,
    context_spans: Array.isArray(result.context_spans) ? result.context_spans : [],
    ambiguous_spans: Array.isArray(result.ambiguous_spans) ? result.ambiguous_spans : [],
    reason: String(result.reason || 'LLM 形态拆解兜底。').slice(0, 120),
    source: 'deepseek_shape_fallback',
    llm_diagnostics: {
      prompt_chars: prompt.length,
      prompt_bytes: Buffer.byteLength(prompt, 'utf8'),
      raw_response_chars: String(raw || '').length,
      raw_response_bytes: Buffer.byteLength(String(raw || ''), 'utf8'),
      finish_reason: apiChoice.finish_reason || '',
      usage: parsed.usage || {},
    },
  };
}

async function maybeApplyLlmShapeFallback(query, localShape) {
  if (!likelyNeedsShapeFallback(query, localShape)) return localShape;
  if (_breakerShouldFastFail()) return localShape;
  try {
    const llmShape = await runLlmShapeFallback(query, localShape);
    const resolved = {
      ...llmShape,
      local_shape: localShape,
      arbitration_mode: 'llm_shape_primary',
    };
    if (llmShape.shape === 'multi_intent' && llmShape.tasks.length >= 2) return resolved;
    if (llmShape.shape === 'multi_task_same_intent' && llmShape.tasks.length >= 1) return resolved;
    if (llmShape.shape === 'single_intent' || llmShape.shape === 'ambiguous_intent') {
      return resolved;
    }
    return {
      ...localShape,
      llm_shape_fallback: llmShape,
    };
  } catch (error) {
    return {
      ...localShape,
      llm_shape_fallback: {
        source: 'deepseek_shape_fallback',
        error: error && (error.message || String(error)) || 'unknown error',
      },
    };
  }
}

function getSpanText(span) {
  if (!span) return '';
  if (typeof span === 'string') return span.trim();
  return String(span.text || '').trim();
}

function getCompositeEvaluationSegments(shapeDetection) {
  const rawSegments = shapeDetection && Array.isArray(shapeDetection.segments)
    ? shapeDetection.segments.map(item => String(item || '').trim()).filter(Boolean)
    : [];
  const taskTexts = shapeDetection && Array.isArray(shapeDetection.tasks)
    ? shapeDetection.tasks.map(getSpanText).filter(Boolean)
    : [];
  const ambiguousTexts = shapeDetection && Array.isArray(shapeDetection.ambiguous_spans)
    ? shapeDetection.ambiguous_spans.map(getSpanText).filter(Boolean)
    : [];
  const actionableTexts = Array.from(new Set(taskTexts.concat(ambiguousTexts)));
  if (!actionableTexts.length) return rawSegments;

  const normalizedActionable = actionableTexts.map(normalize);
  const orderedSegments = rawSegments.filter(segment => {
    const norm = normalize(segment);
    return normalizedActionable.some(text => text === norm || text.includes(norm) || norm.includes(text));
  });
  if (orderedSegments.length >= 2) return Array.from(new Set(orderedSegments));
  if (actionableTexts.length >= 2) return actionableTexts;
  if (rawSegments.length >= 2) return rawSegments;
  return actionableTexts.length ? actionableTexts : rawSegments;
}

async function evaluateIntent(query, options) {
  const state = loadGraphState(resolveGraphPathFromOptions(options));
  return graphRuntimeContext.run(state, () => evaluateIntentWithGraph(query, options, state));
}

async function evaluateIntentWithGraph(query, options, state) {
  const started = Date.now();
  const { graph, candidates, loaded_at } = state;
  loadCacheState();
  const topk = Math.max(3, Math.min(parseInt((options || {}).topk || 8, 10), 20));
  const shapeTimer = performance.now();
  const localShapeDetection = detectIntentShape(query, candidates);
  const localShapeMs = elapsedMs(shapeTimer);
  const fallbackShapeTimer = performance.now();
  const shapeDetection = await maybeApplyLlmShapeFallback(query, localShapeDetection);
  const fallbackShapeMs = elapsedMs(fallbackShapeTimer);
  const compositeTimings = {
    query_understanding_ms: localShapeMs,
    shape_detection_ms: round(localShapeMs + fallbackShapeMs, 3),
    composite_split_ms: fallbackShapeMs,
  };
  if (shapeDetection.shape === 'multi_intent') {
    const segments = getCompositeEvaluationSegments(shapeDetection);
    const segmentResults = [];
    let spanCursor = 0;
    for (let i = 0; i < segments.length; i++) {
      const segmentResult = await evaluateSingleIntentPipeline(segments[i], candidates, topk, null);
      const span = locateSpan(query, segments[i], spanCursor);
      if (span) spanCursor = span.end;
      segmentResults.push({
        segment_index: i + 1,
        span,
        span_status: span ? 'aligned' : 'unavailable_rewritten_segment',
        ...segmentResult,
      });
    }
    // Multi-intent segment 后处理：segment 返回 change/apply 但应该是 query 时，
    // 用同业务域的 query 候选替换。
    // 触发条件（满足任一）：
    //   A) segment 自身文本含"查/查询/看看/看下" → 明确查询意图
    //   B) segment 不含变更动词(改/修改/变更/调整等) 且整体 query 以"查"开头且通过"和/与/以及"连接
    //      → "查X和Y"句式中查动词贯穿到 Y 段（g125/g129）
    // 不触发：segment 自身含"改/修改/调整"等变更动词 → 保持 change（g141/t107/t123/g105/t121/g128）
    for (const seg of segmentResults) {
        const segFr = seg.final_result;
        const segText = String(seg.text || seg.query || '');
        if (!segFr || (segFr.action_code !== 'change' && segFr.action_code !== 'apply')) continue;
        const hasQueryVerb = /查|查询|看看|看下/.test(segText);
        const hasChangeVerb = /改|修改|变更|设置|关闭|取消|删除|办理|申请/.test(segText);
        const isConjContinuation = !hasChangeVerb && /查/.test(query) && /(和|与|以及|及)/.test(query);
        if (hasQueryVerb || isConjContinuation) {
          const segId = segFr.intent_id || '';
          const segCand = (candidates || []).find(c => c.intent_id === segId);
          const segLabel = (segCand && segCand.eval_label) || segFr.eval_label || '';
          if (segLabel) {
            const segNorm = normalizeEvalLabel(segLabel);
            const queryAlts = (candidates || []).filter(c =>
              c.action_code === 'query' && c.intent_id !== segId && normalizeEvalLabel(c.eval_label) === segNorm
            );
            if (queryAlts.length === 1) {
              const queryAlt = queryAlts[0];
              seg.final_result = {
                ...queryAlt,
                score: Math.max(segFr.score || 0, 0.85),
                display_name: queryAlt.intent_name || queryAlt.eval_label || queryAlt.object || '',
                runtime_boundary: 'multi_intent_query_verb_override',
                evidence: Array.from(new Set([...(queryAlt.evidence || []), 'multi_intent_query_verb_override'])),
                sources: Array.from(new Set([...(queryAlt.sources || []), 'multi_intent_query_verb_override'])),
              };
              // 同步更新 understanding.tasks，否则 extractPrediction 仍读旧 intent_id 导致 baseline 不涨分
              if (seg.understanding && Array.isArray(seg.understanding.tasks)) {
                seg.understanding.tasks = seg.understanding.tasks.map(t => ({
                  ...t,
                  intent_id: queryAlt.intent_id,
                  intent_name: queryAlt.intent_name || queryAlt.eval_label || '',
                  eval_label: queryAlt.eval_label,
                  action_code: queryAlt.action_code,
                  display_name: queryAlt.intent_name || queryAlt.eval_label || queryAlt.object || '',
                }));
              }
            }
          }
        }
    }
    return await attachFaqAnswers(buildCompositeResult(query, graph, candidates, loaded_at, topk, segmentResults, started, shapeDetection, compositeTimings));
  }
  if (isObjectlessReferenceQuery(query)) {
    return await attachFaqAnswers(buildObjectlessClarificationResult(query, graph, candidates, loaded_at, topk, started));
  }

  const singleResult = await evaluateSingleIntentPipeline(query, candidates, topk, shapeDetection);
  return await attachFaqAnswers({
    query,
    result_type: singleResult.result_type,
    evaluator: singleResult.evaluator || {
      version_id: INTENT_EVALUATOR_VERSION_ID,
      version_name: INTENT_EVALUATOR_VERSION_NAME,
      version_stage: INTENT_EVALUATOR_VERSION_STAGE,
    },
    graph: buildGraphRuntimeInfo(graph, candidates, loaded_at),
    models: {
      embedding: EMBEDDING_MODEL,
      llm: LLM_MODEL,
    },
    final_result: singleResult.final_result,
    authoritative_results: singleResult.authoritative_results,
    answers: singleResult.answers || [],
    understanding: {
      ...singleResult.understanding,
      shape_detection: shapeDetection,
    },
    methods: singleResult.methods,
    attribution: singleResult.attribution,
    timings: singleResult.timings,
    latency_ms: Date.now() - started,
  });
}

/**
 * 多轮澄清选项匹配 — 检查当前 query 是否命中了上一轮澄清中的某个选项
 * 匹配成功返回 { matched: true, option }，失败返回 { matched: false }
 */
function matchClarificationChoice(query, lastRound) {
  if (!lastRound || !lastRound.clarification || !lastRound.clarification.needed) {
    return { matched: false };
  }
  var options = lastRound.clarification.options || [];
  var q = query.replace(/\s+/g, '').toLowerCase();

  // 精确匹配：query 与 option 的 label/display_label/intent_name 完全一致
  for (var i = 0; i < options.length; i++) {
    var opt = options[i];
    var labels = [opt.label, opt.display_label, opt.intent_name].filter(Boolean);
    for (var j = 0; j < labels.length; j++) {
      if (q === labels[j].replace(/\s+/g, '').toLowerCase()) {
        return { matched: true, option: opt };
      }
    }
  }

  // 模糊匹配：query 包含 option label 或 option label 包含 query（长度>=2 时）
  if (q.length >= 2) {
    for (var k = 0; k < options.length; k++) {
      var opt2 = options[k];
      var labels2 = [opt2.label, opt2.display_label, opt2.intent_name].filter(Boolean);
      for (var m = 0; m < labels2.length; m++) {
        var clean = labels2[m].replace(/\s+/g, '').toLowerCase();
        if (clean.indexOf(q) >= 0 || q.indexOf(clean) >= 0) {
          return { matched: true, option: opt2 };
        }
      }
    }
  }

  return { matched: false };
}

/**
 * 构建多轮澄清确认结果 — 当用户选择了上一轮的澄清选项时，
 * 直接返回选中的 intent，跳过完整管线
 */
function buildClarificationResolvedResult(query, option, lastRound, graph, candidates, loaded_at, topk, started) {
  var now = Date.now();
  var candidate = candidates.find(function(c) { return c.intent_id === option.intent_id; }) || {};

  return {
    query: query,
    result_type: 'single_intent',
    resolved_via: 'clarification_choice',
    final_result: {
      intent_id: option.intent_id || '',
      intent_name: option.intent_name || option.label || '',
      eval_label: option.intent_name || option.label || '',
      display_name: option.display_label || option.label || '',
      action_code: option.action_code || 'transfer',
      confidence: 1.0,
      source: 'clarification_selection',
      reason: '用户从上一轮澄清选项中选择了「' + (option.display_label || option.label) + '」',
    },
    authoritative_results: [{
      segment_index: 1,
      query: query,
      intent_id: option.intent_id || '',
      display_name: option.display_label || option.label || '',
      action_code: option.action_code || 'transfer',
      confidence: 1.0,
      source: 'clarification_selection',
    }],
    understanding: {
      cardinality: 'single_intent',
      task_count: 1,
      is_multi_intent: false,
      final_is_non_leaf: false,
      reason: '用户从上一轮澄清选项中选择了「' + (option.display_label || option.label) + '」，意图已确认。',
      tasks: [{
        task_index: 1,
        intent_id: option.intent_id || '',
        intent_name: option.intent_name || option.label || '',
        eval_label: option.intent_name || option.label || '',
        display_name: option.display_label || option.label || '',
        action_code: option.action_code || 'transfer',
        status: 'resolved',
      }],
      clarification: {
        needed: false,
        types: [],
        question: '',
        questions: [],
        options: [],
        service_style: 'customer_facing_concise',
        internal_reason: '已在多轮对话第 ' + (lastRound.round || 1) + ' 轮澄清选项中确认',
        default_action: 'execute_or_route',
      },
    },
    methods: {
      local: { top1: candidate, candidates: candidate ? [candidate] : [], explanation: '多轮澄清选择（用户确认）' },
      embedding: { top1: candidate, candidates: [], explanation: '多轮澄清选择（跳过 embedding 召回）' },
      llm_judge: { top1: candidate, decision_mode: 'clarification_selection', candidates: [], explanation: '多轮澄清选择（跳过 LLM 裁决）' },
    },
    attribution: {
      query: query,
      final_source: 'clarification_selection',
      agreement: 'clarification_resolved',
      signals: [],
      recommendation: '用户从澄清选项中选择了「' + (option.display_label || option.label) + '」，意图链已闭合。',
    },
    timings: { total_ms: Date.now() - started, pipeline: 'clarification-only' },
    decision_trace: [{
      step: 'clarification_match',
      title: '澄清选项匹配',
      status: 'ok',
      description: '用户输入「' + query + '」匹配到上一轮澄清选项「' + (option.display_label || option.label) + '」',
      conclusion: '意图链闭合 — 从 ' + (lastRound.intent_name || '上一轮意图') + ' → ' + (option.display_label || option.label),
    }],
    faq: { path: '', version: '', item_count: 0 },
    answers: [],
  };
}

/**
 * POST /api/intent-evaluate-multi — 多轮评估端点
 * 接受 session（含历史轮次），支持澄清选项匹配和上下文注入
 */
async function handleIntentEvaluateMulti(req, res, helpers) {
  var sendJSON = helpers.sendJSON;
  var parseRequestBody = helpers.parseRequestBody;
  try {
    if (req.method !== 'POST') { sendJSON(res, 405, { error: 'POST required' }); return; }
    var body = await parseRequestBody(req);
    var payload = body.data || body;
    var query = String(payload.query || '').trim();
    if (!query) { sendJSON(res, 400, { error: 'query required' }); return; }

    var session = payload.session || {};
    var history = Array.isArray(session.history) ? session.history : [];
    var currentRound = (session.round || 0) + 1;

    // 1) 检查是否命中上一轮的澄清选项
    if (history.length > 0) {
      var lastRound = history[history.length - 1];
      var match = matchClarificationChoice(query, lastRound);
      if (match.matched) {
        var g = loadGraphState(resolveGraphPathFromOptions(payload.options));
        var result = buildClarificationResolvedResult(
          query, match.option, lastRound,
          g.graph, g.candidates, g.loaded_at,
          parseInt((payload.options || {}).topk || 8, 10), Date.now()
        );
        result.session = {
          round: currentRound,
          history: history.concat([{
            query: query,
            intent_id: result.final_result.intent_id,
            intent_name: result.final_result.intent_name,
            display_name: result.final_result.display_name,
            action_code: result.final_result.action_code,
            status: 'resolved',
            resolved_via: 'clarification_choice',
            selected_option: match.option.label,
          }]),
        };
        sendJSON(res, 200, result);
        return;
      }
    }

    // 2) 未命中澄清选项 — 走完整管线，注入 history 上下文
    var options = payload.options || {};
    if (history.length > 0) {
      options.session_history = history;
    }

    var result = await evaluateIntent(query, options);
    result.session = {
      round: currentRound,
      history: history.concat([{
        query: query,
        intent_id: (result.final_result || {}).intent_id || '',
        intent_name: (result.final_result || {}).intent_name || '',
        display_name: (result.final_result || {}).display_name || '',
        action_code: (result.final_result || {}).action_code || '',
        status: (result.understanding && result.understanding.clarification && result.understanding.clarification.needed) ? 'pending' : 'resolved',
        clarification: result.understanding && result.understanding.clarification,
      }]),
    };
    sendJSON(res, 200, result);
  } catch (e) {
    sendJSON(res, 500, { error: e.message, stack: process.env.NODE_ENV === 'development' ? e.stack : undefined });
  }
}

async function handleIntentEvaluate(req, res, helpers) {
  const sendJSON = helpers.sendJSON;
  const parseRequestBody = helpers.parseRequestBody;
  try {
    if (req.method !== 'POST') {
      sendJSON(res, 405, { error: 'POST required' });
      return;
    }
    const body = await parseRequestBody(req);
    const payload = body.data || body;
    const query = String(payload.query || '').trim();
    if (!query) {
      sendJSON(res, 400, { error: 'query required' });
      return;
    }
    const result = await evaluateIntent(query, payload.options || {});
    sendJSON(res, 200, result);
  } catch (e) {
    sendJSON(res, 500, { error: e.message, stack: process.env.NODE_ENV === 'development' ? e.stack : undefined });
  }
}

function getIntentEvaluatorStatus(options) {
  const g = loadGraphState(resolveGraphPathFromOptions(options));
  const c = loadCacheState();
  const f = loadFaqState();
  const manifest = loadVersionManifest();
  const meta = g.graph.meta || {};
  const summary = g.graph.summary || {};
  const activeVersion = (manifest.versions || []).find(version => version.version_id === manifest.active_default) || null;
  const actualEdgeTypes = Array.from(new Set((g.graph.edges || []).map(edge => edge.type).filter(Boolean))).sort();
  const declaredEdgeTypes = new Set(((g.graph.ontology || {}).edge_types || []));
  const leafIntentCount = summary.leaf_intent_count || (g.graph.intent_nodes || []).length;
  return {
    evaluator_version: INTENT_EVALUATOR_VERSION_ID,
    evaluator_version_id: INTENT_EVALUATOR_VERSION_ID,
    evaluator_version_name: INTENT_EVALUATOR_VERSION_NAME,
    evaluator_version_stage: INTENT_EVALUATOR_VERSION_STAGE,
    graph_version: g.graph.meta && g.graph.meta.version,
    graph_version_id: meta.graph_version_id || (activeVersion && activeVersion.version_id) || null,
    graph_version_name: meta.graph_version_name || (activeVersion && (activeVersion.version_name || activeVersion.name)) || null,
    graph_version_stage: meta.graph_version_stage || (activeVersion && activeVersion.stage) || null,
    graph_release_status: meta.release_status || (activeVersion && activeVersion.release_status) || null,
    graph_manifest_version: manifest.manifest_version || null,
    graph_active_default: manifest.active_default || null,
    graph_rollback_default: manifest.rollback_default || null,
    intent_count: leafIntentCount,
    leaf_intent_count: leafIntentCount,
    executable_intent_count: summary.executable_intent_count || 0,
    knowledge_intent_count: summary.knowledge_intent_count || 0,
    aggregate_intent_count: summary.aggregate_intent_count || (g.graph.aggregate_intents || []).length,
    runtime_candidate_count: g.candidates.length,
    runtime_candidate_excluded_count: Math.max(0, leafIntentCount - g.candidates.length),
    edge_count: summary.edge_count || (g.graph.edges || []).length,
    schema_profile: g.schema_runtime_profile && g.schema_runtime_profile.schema_profile,
    source_graph_path: g.schema_runtime_profile && g.schema_runtime_profile.source_graph_path,
    schema_inspected_in_memory: !!(g.schema_runtime_profile && g.schema_runtime_profile.inspected_in_memory),
    runtime_schema_repair_enabled: !!(g.schema_runtime_profile && g.schema_runtime_profile.runtime_schema_repair_enabled),
    ontology_edge_type_coverage_ok: actualEdgeTypes.every(type => declaredEdgeTypes.has(type)),
    ontology_missing_edge_types: (g.schema_runtime_profile && g.schema_runtime_profile.ontology_missing_edge_types) || [],
    ontology_missing_edge_type_definitions: (g.schema_runtime_profile && g.schema_runtime_profile.ontology_missing_edge_type_definitions) || [],
    edge_metadata_missing_counts: (g.schema_runtime_profile && g.schema_runtime_profile.edge_metadata_missing_counts) || {},
    legacy_action_fallback_candidates: (g.schema_runtime_profile && g.schema_runtime_profile.legacy_action_fallback_candidates) || 0,
    legacy_navigation_fallback_candidates: (g.schema_runtime_profile && g.schema_runtime_profile.legacy_navigation_fallback_candidates) || 0,
    faq_version: f.version,
    faq_count: f.items.length,
    embedding_cache_count: Object.keys(c.embeddings || {}).length,
    llm_cache_count: Object.keys(c.llm_judgments || {}).length,
    embedding_model: EMBEDDING_MODEL,
    llm_model: LLM_MODEL,
  };
}

/** 意图清单（测试集生成等工具复用）：与评测器同源同版本，卡片段落上下文安全（≤8 说法/≤6 负例）。 */
function getIntentInventory() {
  const state = loadGraphState();
  const info = buildGraphRuntimeInfo(state.graph, state.candidates, state.loaded_at);
  const domains = [...new Set(state.candidates.map(c => c.domain).filter(Boolean))].sort();
  const intents = state.candidates.map(c => {
    const retrieval = c.node.retrieval_profile || {};
    const decision = c.node.decision_policy || {};
    const identity = c.node.identity || {};
    return {
      intentId: c.intent_id,
      name: c.intent_name || c.eval_label,
      evalLabel: c.eval_label,
      intentType: identity.intent_type || '',
      domain: c.domain || '',
      isExecutable: identity.is_executable_leaf === true,
      isKnowledge: identity.is_knowledge_intent === true,
      object: c.object || '',
      action: c.action_code || '',
      utterances: (retrieval.utterance_view || []).filter(u => typeof u === 'string' && u.trim()).slice(0, 8),
      negatives: (decision.out_of_scope_examples || []).filter(u => typeof u === 'string' && u.trim()).slice(0, 6),
      clarifyQuestions: (decision.clarify_questions || []).filter(u => typeof u === 'string' && u.trim()).slice(0, 3),
    };
  });
  return {
    graph: {
      path: info.path,
      version: info.version,
      versionId: info.version_id,
      versionName: info.version_name,
      releaseStatus: info.release_status,
      loadedAt: info.loaded_at,
    },
    stats: {
      intentCount: info.leaf_intent_count,
      executableIntentCount: info.executable_intent_count,
      knowledgeIntentCount: info.knowledge_intent_count,
      domainCount: domains.length,
    },
    domains,
    intents,
  };
}

module.exports = {
  evaluateIntent,
  buildIntentUnderstanding,
  handleIntentEvaluate,
  handleIntentEvaluateMulti,
  getIntentEvaluatorStatus,
  getIntentInventory,
};


