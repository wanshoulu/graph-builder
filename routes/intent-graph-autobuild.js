/**
 * 意图图谱自动构建 — 服务端路由（/api/intent-graph-autobuild/* + /api/intent-graph/release）
 *
 * 管线：menu-tree.json 候选（intent_candidate / semantic_aggregation）
 *   → LLM 批量生成七段 intent_nodes（SSE 流式、断点续跑、dry_run 调试模式）
 *   → merge 打包为 v2 包（确定性后处理 + 校验）
 *   → 编辑器专家修改 → 现有 /api/intent-graph/export 导出 p2 批次
 *   → POST /api/intent-graph/release 发布桥接（viz + legacy full.json + manifest）
 *
 * 端点：
 *   GET  /api/intent-graph-autobuild/candidates    候选列表（role/domain/q/分页）
 *   POST /api/intent-graph-autobuild/generate      SSE 批量生成
 *   GET  /api/intent-graph-autobuild/job/:jobId    任务状态
 *   POST /api/intent-graph-autobuild/job/:jobId/resume  SSE 断点续跑
 *   POST /api/intent-graph-autobuild/merge         打包 v2 包（含校验报告）
 *   POST /api/intent-graph/release                 发布桥接（阶段 3）
 *
 * 确定性后处理复用 scripts/build-intent-graph-v2.js 的纯函数（normalizeIntentType 等），
 * LLM 路由复用 config/api-keys.js API_ROUTES（deepseek-chat → qwen-plus 回退）。
 */
'use strict';

var fs = require('fs');
var path = require('path');
var https = require('https');
var post = require('../tools/intent-graph-postprocess'); // 确定性后处理纯函数（tools/ 为 bind mount，容器内可用）
var API_ROUTES = require('../config/api-keys').API_ROUTES;
var { authenticate } = require('../middleware/auth');
var { getLLMRoute, callLLMJson } = require('../tools/llm-client');

var GRAPHS_DIR = path.join(__dirname, '..', 'data', 'graphs');
var MENU_TREE_PATH = path.join(GRAPHS_DIR, 'menu-tree.json');
var MANIFEST = path.join(GRAPHS_DIR, 'intent-graph-version-manifest.json');
var JOBS_DIR = path.join(GRAPHS_DIR, 'autobuild-jobs');
var FULL_PATH = path.join(GRAPHS_DIR, 'intent-graph-full.json');
var BACKUPS_DIR = path.join(GRAPHS_DIR, 'backups');
// builder 草稿路径（与 org-graph ASSETS['intent-graph'].draftPath 一致），autobuild 产出可直接回流 builder
var BUILDER_DRAFT_PATH = path.join(GRAPHS_DIR, 'org', 'intent', 'drafts', 'org-graph-draft.json');
var BUILDER_DRAFT_HISTORY_DIR = path.join(GRAPHS_DIR, 'org', 'intent', 'drafts', 'history');

// ── Schema 常量（统一来源：tools/intent-graph-schema.js，与 editor/评测共享同一份；对齐模板 v1.5.0）──
var SCHEMA_LIB = require('../tools/intent-graph-schema');
var DOMAINS = SCHEMA_LIB.DOMAINS;
var INTENT_TYPES = SCHEMA_LIB.INTENT_TYPES;
var NODE_TYPES = SCHEMA_LIB.NODE_TYPES;
var EDGE_TYPES = SCHEMA_LIB.EDGE_TYPES;
var ACTION_CODES = SCHEMA_LIB.ACTION_CODES;
var REQUIRED_IDENTITY = SCHEMA_LIB.REQUIRED_IDENTITY;
var REQUIRED_SEMANTIC = SCHEMA_LIB.REQUIRED_SEMANTIC;

// ── 基础工具 ──

function sendJSON(res, code, data) {
  res.writeHead(code, {
    'Content-Type': 'application/json;charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise(function(resolve, reject) {
    var parts = [];
    var total = 0;
    req.on('data', function(c) {
      total += c.length;
      if (total > 4 * 1024 * 1024) { reject(new Error('请求体过大')); return; }
      parts.push(c);
    });
    req.on('end', function() {
      try {
        var body = parts.length ? Buffer.concat(parts).toString('utf8') : '';
        resolve(body ? JSON.parse(body) : {});
      } catch(e) { resolve({}); }
    });
    req.on('error', reject);
  });
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch(e) { return fallback; }
}

function writeJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch(e) { return false; }
}

function arr(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(function(v) { return v !== undefined && v !== null && String(v).trim() !== ''; });
  return [value].filter(function(v) { return String(v).trim() !== ''; });
}

function uniq(values) {
  var seen = {};
  var out = [];
  arr(values).forEach(function(v) {
    var s = String(v).trim();
    if (s && !seen[s]) { seen[s] = true; out.push(s); }
  });
  return out;
}

function loadMenuTree() {
  var tree = readJson(MENU_TREE_PATH, null);
  if (!tree || !Array.isArray(tree.menu_nodes)) throw new Error('menu-tree.json 不可用');
  return tree;
}

function menuNodeById(tree, nodeId) {
  var nodes = tree.menu_nodes || [];
  for (var i = 0; i < nodes.length; i++) {
    if (nodes[i].node_identity && nodes[i].node_identity.node_id === nodeId) return nodes[i];
  }
  return null;
}

function triggerTexts(node) {
  var texts = [];
  (node.navigation && node.navigation.source_records || []).forEach(function(r) {
    texts = texts.concat(r.trigger_texts || []);
  });
  return uniq(texts);
}

// ── 候选列表 ──

function listCandidates(opts) {
  var tree = loadMenuTree();
  var role = opts.role || 'intent_candidate';
  var domain = opts.domain || '';
  var q = String(opts.q || '').trim();
  var page = Math.max(1, parseInt(opts.page, 10) || 1);
  var pageSize = Math.min(200, Math.max(1, parseInt(opts.pageSize, 10) || 50));

  var items = [];
  (tree.menu_nodes || []).forEach(function(node) {
    var id = node.node_identity || {};
    if (id.modeling_role !== role) return;
    if (domain && id.domain !== domain) return;
    var aliases = uniq(id.aliases || []);
    var triggers = triggerTexts(node);
    if (q) {
      var hay = [id.node_name, id.path, id.full_path].concat(aliases, triggers).join(' ');
      if (hay.indexOf(q) < 0) return;
    }
    var nav = node.navigation || {};
    var tp = node.tree_position || {};
    items.push({
      node_id: id.node_id,
      node_name: id.node_name,
      domain: id.domain,
      level: id.level,
      is_leaf: !!id.is_leaf,
      modeling_role: id.modeling_role,
      path: id.path,
      standard_navigation_path: nav.standard_navigation_path || '',
      trigger_texts: triggers,
      page_titles: uniq(nav.source_records && [].concat.apply([], nav.source_records.map(function(r) { return r.page_titles || []; }))),
      aliases: aliases,
      children_count: tp.child_count || 0,
      sibling_count: tp.sibling_count || 0,
      quality_flags: id.quality_flags || [],
    });
  });

  items.sort(function(a, b) { return String(a.path).localeCompare(String(b.path)); });

  var total = items.length;
  var start = (page - 1) * pageSize;
  return { total: total, page: page, pageSize: pageSize, items: items.slice(start, start + pageSize) };
}

// ── LLM 调用已提取至 tools/llm-client.js ──

function extractJSON(text) {
  var jsonStr = String(text).trim();
  var codeMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeMatch) jsonStr = codeMatch[1].trim();
  var startIdx = jsonStr.indexOf('{');
  var endIdx = jsonStr.lastIndexOf('}');
  if (startIdx >= 0 && endIdx > startIdx) jsonStr = jsonStr.slice(startIdx, endIdx + 1);
  return JSON.parse(jsonStr);
}

// ── 确定性后处理（LLM 输出 → 合法七段 intent_node）──

function buildMethodologyDescription(menuNode) {
  var id = menuNode.node_identity || {};
  var nav = menuNode.navigation || {};
  return id.node_name + '属于' + id.domain + '领域的手机银行功能节点，标准业务路径为"' +
    (nav.standard_navigation_path || id.path || '') + '"。';
}

/**
 * 用 scripts/build-intent-graph-v2.js 的纯函数兜底：LLM 输出缺失/矛盾字段时确定性补齐。
 * intent_id = compactId('intent', menu node_id) —— 一个菜单节点恰好映射一个意图叶子，重跑幂等。
 */
function postProcessIntentNode(raw, menuNode) {
  var id0 = raw.identity || {};
  var menuId = menuNode.node_identity || {};
  var nav = menuNode.navigation || {};
  var name = post.firstNonEmpty(id0.intent_name, menuId.node_name);
  var navPath = post.firstNonEmpty(
    raw.execution_binding && raw.execution_binding.standard_navigation_path,
    nav.standard_navigation_path, menuId.path
  );

  // action code 推导：LLM 给出优先；否则按意图类型映射
  var rawActionCode = raw.task_binding && raw.task_binding.action && raw.task_binding.action.action_code;
  var intentType = post.normalizeIntentType({ intent_type: id0.intent_type }, rawActionCode || '');
  var actionCode = rawActionCode || { ASK: 'ask', QUERY: 'query', DO: 'apply', CHANGE: 'change', CANCEL: 'cancel', HELP: 'guide', TRANSFER: 'transfer', REPAY: 'repay' }[intentType] || 'query';
  if (ACTION_CODES.indexOf(actionCode) < 0) actionCode = 'query';

  var isKnowledge = !!post.isKnowledgeIntent(intentType, { can_answer_directly: !!id0.is_knowledge_intent, can_execute_directly: !id0.is_knowledge_intent });
  var isExecutable = !!post.isExecutableIntent(intentType, { can_execute_directly: !id0.is_knowledge_intent }, actionCode);
  var objectName = post.firstNonEmpty(
    raw.task_binding && raw.task_binding.business_object && raw.task_binding.business_object.object_name,
    menuId.node_name
  );

  var sd = raw.semantic_definition || {};
  var userGoal = post.firstNonEmpty(sd.user_goal, name);
  var description = post.firstNonEmpty(sd.description, buildMethodologyDescription(menuNode));
  var scopeIn = post.uniq(sd.scope_in);
  if (!scopeIn.length) scopeIn = post.uniq([name].concat(menuId.aliases || []));
  var scopeOut = post.uniq(sd.scope_out);

  // retrieval_profile：LLM 输出有效则保留（补齐缺失视图）；否则用 buildRetrievalProfile 确定性生成
  var rp = raw.retrieval_profile;
  if (!rp || !Array.isArray(rp.utterance_view) || !rp.utterance_view.length) {
    var legacyNode = {
      node_identity: { node_name: name, domain: menuId.domain, business_category_path: navPath },
      node_semantics: { service_object: objectName, node_description: description, semantic_description: description, typical_user_goal: userGoal, typical_user_goals: [userGoal] },
      navigation: { standard_navigation_path: navPath, source_navigation_paths: nav.source_navigation_paths || [] },
    };
    var legacyScene = {
      scene_id: 'scene_' + menuId.node_id, scene_name: name, user_goal: userGoal,
      standard_questions: [userGoal, name],
      similar_questions: [], scenario_prototypes: [], trigger_keywords: triggerTexts(menuNode),
      scene_description: description, disambiguation_hints: [], negative_examples: [],
      required_slots: [], optional_slots: [], profile_constraints: [],
    };
    var legacyAction = { action_code: actionCode, action_name: post.firstNonEmpty(raw.task_binding && raw.task_binding.action && raw.task_binding.action.action_name, actionCode), action_aliases: [], supported_intent_types: [intentType] };
    rp = post.buildRetrievalProfile({
      node: legacyNode, action: legacyAction, scene: legacyScene,
      intentName: name, objectName: objectName, taskName: '', knowledgeName: '',
    });
  } else {
    rp.utterance_view = post.uniq(rp.utterance_view);
    if (!rp.semantic_view || !rp.semantic_view.length) rp.semantic_view = [name];
    if (!rp.object_view || !rp.object_view.length) rp.object_view = [objectName];
    if (!rp.action_view || !rp.action_view.length) rp.action_view = [actionCode];
    if (!rp.weights) rp.weights = { query_vs_action: actionCode === 'query' || actionCode === 'ask' ? 1.0 : 0.3, object_match: 0.8 };
    // V4 精度字段补齐：LLM 输出缺失时从已有视图/name/objectName 兜底
    if (!Array.isArray(rp.aliases) || !rp.aliases.length) {
      rp.aliases = post.uniq([name, objectName, actionCode, ...(rp.object_view || []), ...(rp.action_view || [])]).filter(Boolean);
    }
    if (!Array.isArray(rp.recallTerms) || !rp.recallTerms.length) {
      rp.recallTerms = post.uniq((rp.utterance_view || []).slice(0, 20)).filter(Boolean);
    }
    if (!Array.isArray(rp.recallTermSets)) rp.recallTermSets = [];
    if (!Array.isArray(rp.negativeExamples)) rp.negativeExamples = [];
    if (typeof rp.semanticPriority !== 'number') rp.semanticPriority = 0;
  }

  var taskBinding = raw.task_binding;
  if (!taskBinding && (intentType === 'DO' || intentType === 'QUERY')) {
    taskBinding = {
      action: { action_code: actionCode, action_name: post.firstNonEmpty(raw.task_binding && raw.task_binding.action && raw.task_binding.action.action_name, actionCode) },
      business_object: { object_name: objectName, object_type: 'business_object' },
    };
  }

  var knowledgeBinding = raw.knowledge_binding;
  if (!knowledgeBinding && isKnowledge) {
    knowledgeBinding = { knowledge_refs: [], answer_policy: 'direct_answer_or_recommend_entry' };
  }

  var decisionPolicy = raw.decision_policy || {
    default_decision: isExecutable ? 'execute' : 'answer',
    low_confidence_strategy: isExecutable ? 'confirm_before_execution' : 'keep_topk',
    clarify_questions: [], reject_policy: 'fallback',
  };

  var executionBinding = raw.execution_binding || {};
  executionBinding.route_type = executionBinding.route_type || (isExecutable ? 'action_execution' : 'answer_or_entry_recommendation');
  executionBinding.standard_navigation_path = navPath;
  executionBinding.route_readiness = executionBinding.route_readiness || 'path_available';

  // V4.1 字段：execution_mode / fulfillment_kind / orchestration_mode / risk_level / confirmation_policy
  var risks = post.inferRisk(objectName, actionCode, name, { scene_description: description, user_goal: userGoal });
  if (!executionBinding.execution_mode) {
    executionBinding.execution_mode = isKnowledge ? 'knowledge-only' : (actionCode === 'transfer' || actionCode === 'apply' || actionCode === 'change' || actionCode === 'cancel' || actionCode === 'repay' ? 'confirm-required' : 'read-execute');
  }
  if (!executionBinding.fulfillment_kind) {
    var fkMap = { 'knowledge-only': 'answer', 'read-execute': 'query', 'confirm-required': 'skill', 'multi_intent': 'workflow' };
    executionBinding.fulfillment_kind = fkMap[executionBinding.execution_mode] || 'unconfigured';
  }
  if (!executionBinding.orchestration_mode) {
    executionBinding.orchestration_mode = (decisionPolicy && decisionPolicy.orchestration_mode === 'agent') ? 'agent-智能体' : 'deterministic-确定式';
  }
  if (!executionBinding.confirmation_policy) {
    executionBinding.confirmation_policy = isExecutable ? 'before_execute' : 'none';
  }
  if (!executionBinding.risk_level) {
    var rawRiskLevel = (risks && risks.length > 0) ? (risks[0].risk_level || 'L1') : 'L0';
    var rlMap = { 'L0': 'L0-无风险', 'L1': 'L1-低风险', 'L2': 'L2-中风险', 'L3': 'L3-高风险' };
    executionBinding.risk_level = rlMap[rawRiskLevel] || 'L0-无风险';
  }

  return {
    identity: {
      intent_id: post.compactId('intent', menuId.node_id),
      intent_name: name,
      intent_type: intentType,
      intent_level: 'leaf',
      parent_intent_id: id0.parent_intent_id || '', // merge 阶段统一归属聚合
      domain: menuId.domain,
      is_executable_leaf: isExecutable,
      is_knowledge_intent: isKnowledge,
    },
    semantic_definition: { user_goal: userGoal, description: description, scope_in: scopeIn, scope_out: scopeOut },
    retrieval_profile: rp,
    task_binding: taskBinding || undefined,
    knowledge_binding: knowledgeBinding || undefined,
    decision_policy: decisionPolicy,
    execution_binding: executionBinding,
    lifecycle: raw.lifecycle || 'active-活跃',
    readiness: raw.readiness || 'ready-就绪',
    governance: Object.assign({ quality_flags: ['autobuild_llm'], build_status: 'autobuild_llm', review_status: 'needs_methodology_review' }, raw.governance || {}),
    labels: Object.assign({ display_label: name, eval_label: name, legacy_node_id: menuId.node_id }, raw.labels || {}),
    source_legacy: { node_id: menuId.node_id, node_name: menuId.node_name, standard_navigation_path: navPath },
    observability: { source_count: (nav.source_records || []).length, retrieval_text_preview: (rp.utterance_view || []).slice(0, 5).join(' | ') },
    _supporting: {
      business_object: { object_id: post.compactId('object', objectName), object_name: objectName, object_type: 'business_object' },
      action: { action_id: post.compactId('action', actionCode), action_name: post.firstNonEmpty(taskBinding && taskBinding.action && taskBinding.action.action_name, actionCode), action_code: actionCode },
      risks: risks,
    },
  };
}

// dry_run：不调 LLM，用模板化启发式生成**原始模板**（与 LLM 输出同形状，由公共后处理管线统一处理一次）
function dryRunNode(menuNode) {
  var id = menuNode.node_identity || {};
  var name = id.node_name;
  var text = name + ' ' + (id.path || '');
  var intentType = 'QUERY';
  if (/限额|规则|怎么|如何|指南|说明|网点|利率|费率|手续费|开户行|条件|要求|多久|哪里|是什么|含义/.test(text)) intentType = 'ASK';
  else if (/申请|办理|开通|签约|转账|汇款|修改|设置|绑定|解绑|挂失|还款|缴费|购买|赎回|销户|注销|充值|提现|预约|登记|认证/.test(text)) intentType = 'DO';
  return {
    identity: { intent_name: name, intent_type: intentType, intent_level: 'leaf', domain: id.domain, is_knowledge_intent: intentType === 'ASK' },
    semantic_definition: {
      user_goal: (intentType === 'ASK' ? '了解' : intentType === 'DO' ? '办理' : '查询') + name,
      description: buildMethodologyDescription(menuNode),
      scope_in: [name],
      scope_out: [],
    },
    retrieval_profile: null,
    task_binding: intentType === 'ASK' ? undefined : { action: { action_code: intentType === 'DO' ? 'apply' : 'query' }, business_object: { object_name: name } },
    decision_policy: null, execution_binding: null,
  };
}

// ── LLM 批量生成 prompt ──

function buildBatchPrompt(menuNodes) {
  var inputNodes = menuNodes.map(function(node) {
    var id = node.node_identity || {};
    var nav = node.navigation || {};
    return {
      node_id: id.node_id, node_name: id.node_name, path: id.path, domain: id.domain,
      level: id.level, is_leaf: !!id.is_leaf, aliases: id.aliases || [],
      standard_navigation_path: nav.standard_navigation_path || '',
      source_navigation_paths: nav.source_navigation_paths || [],
      trigger_texts: triggerTexts(node).slice(0, 8),
      page_titles: uniq([].concat.apply([], (nav.source_records || []).map(function(r) { return r.page_titles || []; }))).slice(0, 5),
      child_count: (node.tree_position || {}).child_count || 0,
    };
  });

  return [
    '为下列手机银行菜单功能节点生成意图图谱节点（七段结构）。',
    '',
    '输出约束（必须严格遵守）：',
    '1. 输出单个 JSON 对象：{"intents":[...],"edges":[...]}，intents 每个元素是一个意图叶子节点。',
    '2. 每个叶子节点含七个段落：identity / semantic_definition / retrieval_profile / task_binding / knowledge_binding / decision_policy / execution_binding。',
    '3. identity：intent_id 留空字符串（由系统按菜单节点 id 确定性生成）；intent_name 用口语化用户表达（如"查询余额"）；intent_type 取 ASK|QUERY|DO|CHANGE|CANCEL|HELP|TRANSFER|REPAY：咨询/规则/怎么办理类→ASK；查/看/明细/余额/记录类→QUERY；申请/办理/开通类→DO；修改/变更/设置类→CHANGE；取消/关闭/注销类→CANCEL；帮助/指引类→HELP；转账/汇款类→TRANSFER；还款/缴款类→REPAY；intent_level="leaf"；parent_intent_id 留空；domain 取自输入；is_knowledge_intent：ASK 为 true；is_executable_leaf：DO/CHANGE/CANCEL/TRANSFER/REPAY 为 true。',
    '4. semantic_definition：user_goal 一句话用户目标；description 一句话描述（必须跨意图唯一，禁止使用共享模板文案如"该功能属于XX领域"——描述重复会稀释向量空间）；scope_in 3-8 条中文短语（用户可能的表达）；scope_out 3-8 条容易混淆的邻接意图（不属于本意图）。',
    '5. retrieval_profile：utterance_view 12-20 条（结合 trigger_texts/aliases/user_goal 扩写），必须遵守以下说法生成规则：',
    '   a) 词群家族覆盖：同一目标下用户会用不同词群表达（如查交易类：交易/流水/明细/进出账/消费记录/账目各算一个家族），条目要摊开，禁止一半以上挤在同一批同义词里；',
    '   b) 操作家族覆盖：若该意图含办理/管理/设置属性，必须包含"怎么开通/怎么办理/怎么申请/怎么设置/怎么取消"等操作型说法，否则模型会顺着已有别名全写成查询态；',
    '   c) 结构多样：动宾式、名词式、疑问式都要有，不要只改换同义词；',
    '   d) 不得照抄菜单名/动作名/页面标题作为说法（会造成跨意图模板串扰）；',
    '   e) 每条长度 2-24 字，无连续 3 位以上数字，不含具体卡号/金额/日期占位符；',
    '   f) 不得包含其他意图标志性词汇（如转账类不出现"账单"，账单类不出现"转账"）；',
    '   semantic_view/object_view/action_view 各 2-6 条；weights 用 {"query_vs_action":0.3-1.0,"object_match":0.7-0.9}。',
    '6. task_binding：QUERY/DO 必填（action.action_code 取 query|apply|open|close|change|cancel|transfer|repay|guide|ask 之一，business_object.object_name 为业务对象名）；ASK 用 knowledge_binding{knowledge_refs:[],answer_policy:"direct_answer_or_recommend_entry"}。',
    '7. execution_binding.standard_navigation_path 必须取自输入的 standard_navigation_path，禁止编造路径。',
    '8. 同批内 intent_name 不得重复；scope 短语不得与别的节点含义重叠；description 不得与同批其他意图的 description 相似（描述重复会污染语义召回）。',
    '9. edges 数组给出建议边：{"from":节点序号或名称,"to":节点序号或名称,"type":"acts_on_object|uses_action|requires_slot","evidence":"理由"}，type 仅限上述四种；没有把握不要编造边。',
    '',
    '输入菜单节点：',
    JSON.stringify(inputNodes),
    '',
    '示例（few-shot，输出结构与字段齐全度参照此例，不要输出示例本身）：',
    JSON.stringify({
      intents: [
        {
          identity: { intent_name: '查询余额', intent_type: 'QUERY', intent_level: 'leaf', domain: '账户管理', is_executable_leaf: true, is_knowledge_intent: false },
          semantic_definition: { user_goal: '查询当前账户余额', description: '用户想查看账户里还有多少钱', scope_in: ['查余额', '余额查询', '我的余额', '还有多少钱'], scope_out: ['转账', '修改密码', '充值'] },
          retrieval_profile: { utterance_view: ['查余额', '余额查询', '我的余额', '卡里还有多少'], semantic_view: ['查询余额'], object_view: ['余额', '账户', '金额'], action_view: ['query', '查询'], weights: { query_vs_action: 1.0, object_match: 0.9 } },
          task_binding: { action: { action_code: 'query', action_name: '查询' }, business_object: { object_name: '账户余额', object_type: '余额' } },
          decision_policy: { default_decision: 'answer', low_confidence_strategy: 'keep_topk', clarify_questions: [], reject_policy: 'fallback' },
          execution_binding: { route_type: 'answer_or_entry_recommendation', standard_navigation_path: '首页 > 我的账户 > 余额', route_readiness: 'path_available' },
        },
        {
          identity: { intent_name: '咨询转账限额', intent_type: 'ASK', intent_level: 'leaf', domain: '转账服务', is_executable_leaf: false, is_knowledge_intent: true },
          semantic_definition: { user_goal: '了解转账限额规则', description: '用户咨询转账限额是多少、为什么限额', scope_in: ['转账限额', '限额多少', '最多转多少', '转账额度'], scope_out: ['修改限额', '提升额度', '大额转账'] },
          retrieval_profile: { utterance_view: ['转账限额', '限额多少', '最多转多少', '一天能转多少'], semantic_view: ['咨询转账限额'], object_view: ['限额', '转账', '额度'], action_view: ['ask', '咨询'], weights: { query_vs_action: 1.0, object_match: 0.7 } },
          knowledge_binding: { knowledge_refs: [], answer_policy: 'direct_answer_or_recommend_entry' },
          decision_policy: { default_decision: 'answer', low_confidence_strategy: 'keep_topk', clarify_questions: [], reject_policy: 'fallback' },
          execution_binding: { route_type: 'answer_or_entry_recommendation', standard_navigation_path: '首页 > 转账 > 转账限额说明', route_readiness: 'path_available' },
        },
      ],
      edges: [],
    }),
  ].join('\n');
}

// ── Job 状态机（内存 Map + 磁盘检查点，docker restart 可续跑）──

var jobs = {};

function loadJobsFromDisk() {
  try {
    fs.readdirSync(JOBS_DIR).forEach(function(f) {
      if (!/\.json$/.test(f)) return;
      var job = readJson(path.join(JOBS_DIR, f), null);
      if (job && job.job_id) jobs[job.job_id] = job;
    });
  } catch(e) { /* JOBS_DIR 不存在 */ }
}
loadJobsFromDisk();

function persistJob(job) {
  jobs[job.job_id] = job;
  writeJson(path.join(JOBS_DIR, job.job_id + '.json'), job);
}

function newJobId() {
  return 'job' + Date.now().toString(36);
}

function jobSummary(job) {
  return {
    job_id: job.job_id, status: job.status, total: job.total, done: job.done,
    failed_count: job.failed_count, produced: job.produced.length,
    failures: job.failures,
  };
}

function resolveCandidateIds(body, tree) {
  if (Array.isArray(body.candidate_ids) && body.candidate_ids.length) return body.candidate_ids;
  var role = body.role || 'intent_candidate';
  var domain = body.domain || '';
  var ids = [];
  (tree.menu_nodes || []).forEach(function(n) {
    var id = n.node_identity || {};
    if (id.modeling_role !== role) return;
    if (domain && id.domain !== domain) return;
    ids.push(id.node_id);
  });
  return ids;
}

function sseWrite(res, evt) {
  try { res.write('data: ' + JSON.stringify(evt) + '\n\n'); } catch(e) { /* 客户端已断开 */ }
}

/**
 * 批量生成主流程（SSE）。批次间并发 concurrency 个，每批最多 attempt 2 次；
 * 每完成一个节点下发 node 事件；每完成一批持久化检查点。
 */
function runGeneration(req, res, body, resumeJob) {
  var tree = loadMenuTree();
  var candidateIds = resolveCandidateIds(body, tree);
  var batchSize = Math.min(20, Math.max(1, parseInt(body.batch_size, 10) || 10));
  var concurrency = Math.min(4, Math.max(1, parseInt(body.concurrency, 10) || 2));
  var dryRun = !!body.dry_run;

  var job = resumeJob || {
    job_id: newJobId(), status: 'running', total: candidateIds.length, done: 0,
    failed_count: 0, produced: [], failures: [],
    candidate_ids: candidateIds, completed_candidate_ids: [],
    params: { batch_size: batchSize, concurrency: concurrency, dry_run: dryRun, role: body.role || '', domain: body.domain || '' },
    menu_tree_version: (tree.meta && tree.meta.version) || 'unknown',
  };
  persistJob(job);

  sseWrite(res, { type: 'job', job_id: job.job_id, total: job.total, dry_run: dryRun, menu_tree_version: job.menu_tree_version });

  var remaining = candidateIds.filter(function(id) { return job.completed_candidate_ids.indexOf(id) < 0; });
  var batches = [];
  for (var i = 0; i < remaining.length; i += batchSize) {
    batches.push(remaining.slice(i, i + batchSize));
  }

  var aborted = false;
  req.on('close', function() { aborted = true; });

  var nextIndex = 0;

  // 递归 worker：每批完成后再取下一批，实现真正的 concurrency 并发上限
  function worker() {
    if (aborted || nextIndex >= batches.length) return Promise.resolve();
    var batchIndex = nextIndex++;
    var batchIds = batches[batchIndex];
    var nodes = batchIds.map(function(id) { return menuNodeById(tree, id); }).filter(Boolean);
    if (!nodes.length) {
      // 候选在菜单树中缺失：计入失败，避免 done 永远达不到 total
      batchIds.forEach(function(id) {
        if (job.completed_candidate_ids.indexOf(id) < 0) job.completed_candidate_ids.push(id);
      });
      job.done += batchIds.length;
      job.failed_count += batchIds.length;
      job.failures.push({ candidate_ids: batchIds, error: '候选节点不在菜单树中', attempt: 0 });
      persistJob(job);
      maybeFinish();
      return worker();
    }
    return attemptBatch(job, nodes, batchIds, batchIndex, dryRun).then(worker);
  }

  function attemptBatch(job, nodes, batchIds, batchIndex, dryRun) {
    var startedAt = Date.now();
    sseWrite(res, { type: 'batch_start', batch_index: batchIndex, candidate_ids: batchIds });
    var generate = function(attempt) {
      return Promise.resolve()
        .then(function() {
          if (dryRun) return { intents: nodes.map(dryRunNode), edges: [] };
          return callLLMJson(buildBatchPrompt(nodes), '你是图谱建模专家，输出严格 JSON，不输出任何解释。', { maxTokens: 12000 }).then(extractJSON);
        })
        .then(function(result) {
          var produced = [];
          var edges = [];
          (Array.isArray(result.intents) ? result.intents : []).forEach(function(raw, i) {
            if (!nodes[i]) return;
            produced.push(postProcessIntentNode(raw || {}, nodes[i]));
          });
          (Array.isArray(result.edges) ? result.edges : []).forEach(function(e) {
            edges.push({ from: e.from, to: e.to, type: e.type, evidence: e.evidence || '' });
          });
          return { produced: produced, edges: edges };
        })
        .catch(function(err) {
          if (attempt < 2) {
            sseWrite(res, { type: 'batch_failed', batch_index: batchIndex, candidate_ids: batchIds, error: err.message, attempt: attempt, retrying: true });
            return new Promise(function(r) { setTimeout(r, 2000); }).then(function() { return generate(attempt + 1); });
          }
          throw err;
        });
    };
    return generate(1).then(function(result) {
      batchIds.forEach(function(id) {
        if (job.completed_candidate_ids.indexOf(id) < 0) job.completed_candidate_ids.push(id);
      });
      job.llm_edges = (job.llm_edges || []).concat(result.edges);
      result.produced.forEach(function(node) {
        job.produced.push(node);
        sseWrite(res, { type: 'node', intent_node: node });
      });
      job.done += batchIds.length;
      var summary = jobSummary(job);
      sseWrite(res, {
        type: 'batch_done', batch_index: batchIndex, produced: result.produced.length,
        edges: result.edges.length, duration_ms: Date.now() - startedAt,
      });
      sseWrite(res, Object.assign({ type: 'progress' }, summary));
      persistJob(job);
      maybeFinish();
    }).catch(function(err) {
      job.failed_count += batchIds.length;
      job.done += batchIds.length;
      job.failures.push({ candidate_ids: batchIds, error: err.message, attempt: 2 });
      var summary = jobSummary(job);
      sseWrite(res, { type: 'batch_failed', batch_index: batchIndex, candidate_ids: batchIds, error: err.message, attempt: 2 });
      sseWrite(res, Object.assign({ type: 'progress' }, summary));
      persistJob(job);
      maybeFinish();
    });
  }

  function maybeFinish() {
    if (job.status === 'done') return;
    if (job.done < job.total) return;
    job.status = 'done';
    job.completed_at = new Date().toISOString();
    persistJob(job);
    sseWrite(res, { type: 'done', job_id: job.job_id, summary: jobSummary(job) });
    res.end();
  }

  if (!batches.length) { maybeFinish(); return; }
  var workers = Math.min(concurrency, batches.length);
  for (var w = 0; w < workers; w++) worker();
}

// ── merge：生成结果打包为 v2 包 ──

function buildAggregateForDomain(domain) {
  return {
    intent_id: 'intent_group_' + post.hash('domain:' + domain, 8),
    intent_name: domain,
    intent_level: 'aggregate',
    domain: domain,
    modeling_role: 'semantic_aggregation',
    semantic_definition: {
      user_goal: '覆盖' + domain + '领域的相关操作与咨询',
      description: '自动构建聚合：' + domain + '（由 menu-tree semantic_aggregation / 领域兜底生成）',
      scope_in: [domain], scope_out: [],
    },
    source_binding: { source: 'autobuild_domain_fallback' },
  };
}

function buildPackage(job, intentIds) {
  var tree = loadMenuTree();
  var nodes = job.produced.filter(function(n) {
    return !intentIds || intentIds.indexOf(n.identity.intent_id) >= 0;
  });
  if (!nodes.length) throw new Error('没有可合并的生成结果');

  // 聚合：semantic_aggregation 菜单节点（若在任务中）+ 领域兜底聚合
  var aggregates = [];
  var domainAggMap = {};
  var seenAgg = {};
  job.candidate_ids.forEach(function(nodeId) {
    var menuNode = menuNodeById(tree, nodeId);
    if (!menuNode || !menuNode.node_identity) return;
    var id = menuNode.node_identity;
    if (id.modeling_role === 'semantic_aggregation') {
      var aggId = 'intent_group_' + post.hash('node:' + nodeId, 8);
      if (seenAgg[aggId]) return;
      seenAgg[aggId] = true;
      aggregates.push({
        intent_id: aggId, intent_name: id.node_name, intent_level: 'aggregate',
        domain: id.domain, modeling_role: 'semantic_aggregation',
        semantic_definition: {
          user_goal: '覆盖' + id.node_name + '相关的操作与咨询',
          description: buildMethodologyDescription(menuNode),
          scope_in: post.uniq([id.node_name].concat(id.aliases || [])), scope_out: [],
        },
        source_binding: { legacy_node_id: nodeId, business_category_path: id.path, standard_navigation_path: (menuNode.navigation || {}).standard_navigation_path },
      });
    }
  });

  var domains = {};
  nodes.forEach(function(n) { domains[n.identity.domain] = true; });
  Object.keys(domains).forEach(function(domain) {
    // 领域内已有 semantic_aggregation 聚合则不复用兜底
    var hasAgg = aggregates.some(function(a) { return a.domain === domain; });
    if (!hasAgg) {
      var agg = buildAggregateForDomain(domain);
      if (!seenAgg[agg.intent_id]) { seenAgg[agg.intent_id] = true; aggregates.push(agg); }
    }
    domainAggMap[domain] = aggregates.filter(function(a) { return a.domain === domain; })[0];
  });

  var aggIds = {};
  aggregates.forEach(function(a) { aggIds[a.intent_id] = true; });

  // 叶子 parent 归属：LLM 给出的 parent 在聚合集内则保留，否则挂同领域聚合
  nodes.forEach(function(n) {
    if (n.identity.parent_intent_id && aggIds[n.identity.parent_intent_id]) return;
    var agg = domainAggMap[n.identity.domain];
    n.identity.parent_intent_id = agg ? agg.intent_id : '';
  });

  // supporting_nodes 去重合并
  var supporting = { business_objects: [], actions: [], slots: [], states: [], risks: [], knowledge_answers: [], runtime_boundaries: [] };
  var seenObjects = {}, seenActions = {}, seenRisks = {};
  nodes.forEach(function(n) {
    var s = n._supporting || {};
    if (s.business_object && !seenObjects[s.business_object.object_id]) {
      seenObjects[s.business_object.object_id] = true;
      supporting.business_objects.push(s.business_object);
    }
    if (s.action && !seenActions[s.action.action_id]) {
      seenActions[s.action.action_id] = true;
      supporting.actions.push(s.action);
    }
    (s.risks || []).forEach(function(r) {
      if (!seenRisks[r.risk_id]) { seenRisks[r.risk_id] = true; supporting.risks.push(r); }
    });
  });

  // 边：has_leaf_intent（聚合→叶子）+ LLM 建议边（过滤非法）+ acts_on_object/uses_action
  var edges = [];
  var seenEdges = {};
  function addEdge(from, to, type, category) {
    var key = from + '|' + type + '|' + to;
    if (seenEdges[key]) return;
    seenEdges[key] = true;
    edges.push({
      edge_id: 'edge_' + post.hash(key, 10),
      from: from, to: to, type: type,
      relation_category: category,
      status: 'active', version: 'autobuild', owner: 'autobuild_llm',
    });
  }
  var intentById = {};
  nodes.forEach(function(n) { intentById[n.identity.intent_id] = n; });

  nodes.forEach(function(n) {
    var agg = domainAggMap[n.identity.domain];
    if (agg && n.identity.parent_intent_id === agg.intent_id) addEdge(agg.intent_id, n.identity.intent_id, 'has_leaf_intent', 'hierarchy');
  });
  nodes.forEach(function(n) {
    var s = n._supporting || {};
    if (s.business_object) addEdge(n.identity.intent_id, s.business_object.object_id, 'acts_on_object', 'semantic');
    if (s.action) addEdge(n.identity.intent_id, s.action.action_id, 'uses_action', 'semantic');
    (s.risks || []).forEach(function(r) { addEdge(n.identity.intent_id, r.risk_id, 'has_risk_constraint', 'governance'); });
  });
  job.llm_edges = job.llm_edges || [];
  job.llm_edges.forEach(function(e) {
    if (EDGE_TYPES.indexOf(e.type) < 0) return;
    var fromNode = nodes[parseInt(e.from, 10)] || intentById[e.from];
    var toNode = nodes[parseInt(e.to, 10)] || intentById[e.to];
    if (fromNode && toNode) addEdge(fromNode.identity.intent_id, toNode.identity.intent_id, e.type, 'semantic');
  });

  // 剥离内部字段
  var cleanNodes = nodes.map(function(n) {
    var copy = JSON.parse(JSON.stringify(n));
    // 保留 action_code 和 risks（_supporting 删除后无法再读取，graphDoc 构建时需要）
    if (copy._supporting) {
      if (copy._supporting.action) copy._action_code = copy._supporting.action.action_code || '';
      if (copy._supporting.risks) copy._risks = copy._supporting.risks;
    }
    delete copy._supporting;
    return copy;
  });

  // 跨意图说法去重：同一说法被多个意图认领时全部丢弃（歧义说法交给下游裁决层）
  var utteranceOwners = {};
  cleanNodes.forEach(function(n) {
    var utts = (n.retrieval_profile && n.retrieval_profile.utterance_view) || [];
    utts.forEach(function(u) {
      var key = String(u).trim();
      if (!key) return;
      if (!utteranceOwners[key]) utteranceOwners[key] = [];
      utteranceOwners[key].push(n.identity.intent_id);
    });
  });
  var ambiguousUtts = Object.keys(utteranceOwners).filter(function(k) { return utteranceOwners[k].length > 1; });
  if (ambiguousUtts.length > 0) {
    cleanNodes.forEach(function(n) {
      var utts = (n.retrieval_profile && n.retrieval_profile.utterance_view) || [];
      n.retrieval_profile.utterance_view = utts.filter(function(u) {
        return utteranceOwners[String(u).trim()].length === 1;
      });
    });
  }

  // 跨场景负例派生：同域不同场景的 aliases 是天然负例素材（V4GraphAdapter 每条 -120 排除误召回）
  // 当本场景 negativeExamples 不足 2 条时，从同域其他场景的 aliases 中补齐
  var aliasesByDomain = {};
  cleanNodes.forEach(function(n) {
    var dom = (n.identity && n.identity.domain) || '_default';
    if (!aliasesByDomain[dom]) aliasesByDomain[dom] = [];
    var al = (n.retrieval_profile && n.retrieval_profile.aliases) || [];
    if (Array.isArray(al)) aliasesByDomain[dom] = aliasesByDomain[dom].concat(al);
  });
  cleanNodes.forEach(function(n) {
    var rp = n.retrieval_profile || {};
    if (!Array.isArray(rp.negativeExamples)) rp.negativeExamples = [];
    if (rp.negativeExamples.length >= 2) return;
    var dom = (n.identity && n.identity.domain) || '_default';
    var myAliases = (rp.aliases || []).filter(Boolean);
    var pool = (aliasesByDomain[dom] || []).filter(function(a) {
      return myAliases.indexOf(a) < 0 && rp.negativeExamples.indexOf(a) < 0;
    });
    for (var i = 0; i < pool.length && rp.negativeExamples.length < 2; i++) {
      rp.negativeExamples.push(pool[i]);
    }
    n.retrieval_profile.negativeExamples = rp.negativeExamples;
  });

  // 描述唯一性校验：active 意图描述跨意图重复会稀释向量空间
  var descOwners = {};
  cleanNodes.forEach(function(n) {
    var desc = (n.semantic_definition && n.semantic_definition.description || '').trim();
    if (!desc) return;
    if (!descOwners[desc]) descOwners[desc] = [];
    descOwners[desc].push(n.identity.intent_name);
  });
  var duplicateDescs = Object.keys(descOwners).filter(function(k) { return descOwners[k].length > 1; });

  var typeDist = {};
  cleanNodes.forEach(function(n) {
    typeDist[n.identity.intent_type] = (typeDist[n.identity.intent_type] || 0) + 1;
  });
  var domainDist = {};
  cleanNodes.forEach(function(n) {
    domainDist[n.identity.domain] = (domainDist[n.identity.domain] || 0) + 1;
  });

  var llmModel = job.params.dry_run ? 'dry_run_template' : (getLLMRoute() ? getLLMRoute().model : 'unknown');

  // ── 构建 builder/bridge 兼容格式（graph_doc）──
  // 将七段嵌套 intent_node 展平为 {id, type, properties}，from/to 转为 source/target
  // 使 auto-build 输出可直接被 builder merge 和 intake bridge graphToIntakeExcel 消费
  var graphDocNodes = [];
  var graphDocEdges = [];

  // 聚合意图 → AGGREGATE_INTENT 节点
  aggregates.forEach(function(a) {
    graphDocNodes.push({
      id: a.intent_id, type: 'AGGREGATE_INTENT',
      properties: {
        name: a.intent_name, domain: a.domain, intent_level: 'aggregate',
        description: (a.semantic_definition && a.semantic_definition.description) || '',
        scope_in: (a.semantic_definition && a.semantic_definition.scope_in) || [],
        scope_out: (a.semantic_definition && a.semantic_definition.scope_out) || [],
        lifecycle: 'active',
        readiness: 'ready',
      },
    });
  });

  // 叶子意图 → INTENT 节点（七段展平为 properties）
  cleanNodes.forEach(function(n) {
    var id = n.identity || {};
    var sem = n.semantic_definition || {};
    var ret = n.retrieval_profile || {};
    var exec = n.execution_binding || {};
    graphDocNodes.push({
      id: id.intent_id, type: 'INTENT',
      properties: {
        name: id.intent_name,
        intent_type: id.intent_type,
        action_code: n._action_code || '',
        intent_level: id.intent_level,
        parent_intent_id: id.parent_intent_id,
        domain: id.domain,
        is_executable_leaf: id.is_executable_leaf,
        is_knowledge_intent: id.is_knowledge_intent,
        goal: sem.user_goal || '',
        description: sem.description || '',
        scope_in: sem.scope_in || [],
        scope_out: sem.scope_out || [],
        utterance_view: ret.utterance_view || [],
        semantic_view: ret.semantic_view || [],
        object_view: ret.object_view || [],
        action_view: ret.action_view || [],
        // V4 精度字段（展平到 properties，供 builder 编辑和 v1→v4 转换器读取）
        aliases: ret.aliases || [],
        recallTerms: ret.recallTerms || [],
        recallTermSets: ret.recallTermSets || [],
        negativeExamples: ret.negativeExamples || [],
        semanticPriority: ret.semanticPriority || 0,
        confusable_intents: sem.scope_out || [],
        fulfillment_kind: exec.fulfillment_kind || 'unconfigured',
        execution_mode: exec.execution_mode || '',
        lifecycle: 'active',
        readiness: 'ready',
        orchestration_mode: (n.decision_policy && n.decision_policy.orchestration_mode) || 'single',
        risk_level: (n._risks && n._risks.length > 0) ? (n._risks[0].risk_level || 'L1') : 'L0',
        confirmation_policy: id.is_executable_leaf ? 'before_execute' : 'none',
        // V4.1 scenes 五块结构：retrieval_profile 含 5 个精度字段，V4GraphAdapter.recall() 打分依赖
        scenes: [{
          scene_type: (id.intent_type || 'QUERY').toUpperCase(),
          semantic_definition: {
            description: sem.description || '',
            userGoal: sem.user_goal || '',
            scopeIn: sem.scope_in || [],
            scopeOut: sem.scope_out || [],
          },
          retrieval_profile: {
            aliases: ret.aliases || [],
            recallTerms: ret.recallTerms || [],
            recallTermSets: ret.recallTermSets || [],
            negativeExamples: ret.negativeExamples || [],
            semanticPriority: ret.semanticPriority || 0,
            utterance_view: ret.utterance_view || [],
            semantic_view: ret.semantic_view || [],
            object_view: ret.object_view || [],
            action_view: ret.action_view || [],
          },
          // V4.1: task_binding 用 camelCase actionCode（小写），不再用 action.action_code
          task_binding: {
            slotContract: { slots: [], capabilityBindings: [] },
            actionCode: n._action_code || '',
          },
          // V4.1: bindings.capabilities 任务场景至少 1 个能力 id（用 business_object 作占位）
          bindings: {
            capabilities: (n.task_binding && n.task_binding.business_object && n.task_binding.business_object.object_id) ? [n.task_binding.business_object.object_id] : [],
            policies: [],
          },
          decision_policy: n.decision_policy || {},
          execution_binding: {
            executionMode: exec.execution_mode || '',
            fulfillmentKind: exec.fulfillment_kind || 'unconfigured',
            riskLevel: (n._risks && n._risks.length > 0) ? (n._risks[0].risk_level || 'L1') : 'L0',
          },
        }],
      },
    });
  });

  // supporting_nodes → 大写类型节点
  supporting.business_objects.forEach(function(b) {
    graphDocNodes.push({ id: b.object_id, type: 'BUSINESS_OBJECT', properties: { name: b.object_name, description: b.description || '' } });
  });
  supporting.actions.forEach(function(a) {
    graphDocNodes.push({ id: a.action_id, type: 'ACTION', properties: { name: a.action_name, action_code: a.action_code || '' } });
  });
  supporting.slots.forEach(function(s) {
    graphDocNodes.push({ id: s.slot_id, type: 'SLOT', properties: { name: s.slot_name, data_type: s.data_type || '' } });
  });
  supporting.states.forEach(function(s) {
    graphDocNodes.push({ id: s.state_id, type: 'STATE', properties: { name: s.state_name } });
  });
  supporting.risks.forEach(function(r) {
    graphDocNodes.push({ id: r.risk_id, type: 'RISK', properties: { name: r.risk_name, description: r.description || '' } });
  });
  supporting.knowledge_answers.forEach(function(k) {
    graphDocNodes.push({ id: k.answer_id, type: 'KNOWLEDGE_ANSWER', properties: { name: k.title || k.answer_id, content: k.content || '' } });
  });
  supporting.runtime_boundaries.forEach(function(rb) {
    graphDocNodes.push({ id: rb.boundary_id, type: 'RUNTIME_BOUNDARY', properties: { name: rb.boundary_name } });
  });

  // edges: from/to → source/target
  edges.forEach(function(e) {
    graphDocEdges.push({
      id: e.edge_id, type: e.type, source: e.from, target: e.to,
      properties: { relation_category: e.relation_category, status: e.status, version: e.version, owner: e.owner },
    });
  });

  var graphDoc = {
    document_id: 'autobuild_' + (job.job_id || Date.now()),
    document_version: '1.0',
    asset_id: 'intent-graph',
    template_ref: { template_id: 'intent-graph', template_version: '1.5.0' },
    nodes: graphDocNodes,
    edges: graphDocEdges,
    metadata: {
      source: 'ai-autobuild',
      generated_at: new Date().toISOString(),
      autobuild_info: { job_id: job.job_id, llm_model: llmModel, dry_run: !!job.params.dry_run },
    },
  };

  return {
    meta: {
      name: 'aiharbor_intent_graph_v2',
      version: 'autobuild',
      graph_version_id: 'autobuild',
      graph_version_name: 'AI Harbor Intent Graph (autobuild)',
      graph_version_stage: 'p2_autobuild',
      generated_at: new Date().toISOString(),
      schema_profile: 'ai_harbor_intent_graph_v4',
      schema_version: '4.0',
      release_status: 'draft',
      autobuild_info: {
        menu_tree_version: job.menu_tree_version, job_id: job.job_id,
        batches: job.completed_candidate_ids.length, llm_model: llmModel,
        dry_run: !!job.params.dry_run, candidate_role: job.params.role || 'intent_candidate',
      },
    },
    summary: {
      aggregate_intent_count: aggregates.length,
      leaf_intent_count: cleanNodes.length,
      executable_intent_count: cleanNodes.filter(function(n) { return n.identity.is_executable_leaf; }).length,
      knowledge_intent_count: cleanNodes.filter(function(n) { return n.identity.is_knowledge_intent; }).length,
      business_object_count: supporting.business_objects.length,
      action_count: supporting.actions.length,
      edge_count: edges.length,
      domain_distribution: domainDist,
      intent_type_distribution: typeDist,
      content_quality: {
        cross_intent_duplicate_utterances_dropped: ambiguousUtts.length,
        duplicate_description_count: duplicateDescs.length,
        avg_utterance_count: cleanNodes.length ? Math.round(cleanNodes.reduce(function(s, n) { return s + ((n.retrieval_profile && n.retrieval_profile.utterance_view) || []).length; }, 0) / cleanNodes.length) : 0,
      },
    },
    ontology: { runtime_primary_object: 'intent_node', node_types: NODE_TYPES, edge_types: EDGE_TYPES },
    aggregate_intents: aggregates,
    intent_nodes: cleanNodes,
    supporting_nodes: supporting,
    edges: edges,
    graph_doc: graphDoc,
  };
}

// ── 轻量校验（与 routes/intent-graph-editor.js validateGraph 同款检查，本路由自包含实现）──

function validateAutobuildPackage(graph) {
  var errors = [];
  var warnings = [];
  var intentNodes = graph.intent_nodes || [];
  var aggIds = {};
  (graph.aggregate_intents || []).forEach(function(n) { if (n && n.intent_id) aggIds[n.intent_id] = true; });

  var seenIds = {};
  intentNodes.forEach(function(n, idx) {
    var prefix = 'intent_nodes[' + idx + ']';
    var id = n.identity || {};
    var name = id.intent_name || id.intent_id || prefix;
    REQUIRED_IDENTITY.forEach(function(f) {
      if (id[f] === undefined || id[f] === null || id[f] === '') errors.push(prefix + '.identity.' + f + ': required');
    });
    if (id.intent_type && INTENT_TYPES.indexOf(id.intent_type) < 0) errors.push(prefix + '.identity.intent_type: invalid "' + id.intent_type + '"');
    if (id.domain && DOMAINS.indexOf(id.domain) < 0) errors.push(prefix + '.identity.domain: invalid "' + id.domain + '"');
    if (id.intent_id) {
      if (seenIds[id.intent_id]) errors.push(prefix + '.identity.intent_id: duplicate "' + id.intent_id + '"');
      seenIds[id.intent_id] = true;
    }
    var sd = n.semantic_definition;
    if (!sd) errors.push(prefix + ': missing semantic_definition');
    else REQUIRED_SEMANTIC.forEach(function(f) {
      if (sd[f] === undefined || sd[f] === null || sd[f] === '') errors.push(prefix + '.semantic_definition.' + f + ': required');
    });
    if (!n.retrieval_profile) errors.push(prefix + ': missing retrieval_profile');
    // V4.1 精度字段校验（对齐 v4-graph-validator.js §11：aliases≥3/negativeExamples≥2/格式）
    var rp = n.retrieval_profile || {};
    var rpAliases = Array.isArray(rp.aliases) ? rp.aliases.filter(Boolean) : [];
    var rpNegatives = Array.isArray(rp.negativeExamples) ? rp.negativeExamples.filter(Boolean) : [];
    var rpRecallTerms = Array.isArray(rp.recallTerms) ? rp.recallTerms.filter(Boolean) : [];
    // 第 5/6 条：别名 ≥3、格式 → error 阻断（对齐 V4_ALIAS_TOO_FEW / V4_ALIAS_FORMAT）
    if (rpAliases.length < 3) {
      errors.push(name + ': aliases 不足 3 条（当前 ' + rpAliases.length + '，要求≥3，V4GraphAdapter 精确匹配+110/包含+75，建议8~16条）');
    }
    rpAliases.forEach(function(a) {
      var problems = [];
      if (String(a).length < 2 || String(a).length > 24) problems.push('长度须在 2~24 字之间');
      if (/\d{3,}/.test(String(a))) problems.push('含连续3位以上数字');
      if (problems.length > 0) errors.push(name + ': alias「' + a + '」' + problems.join('；') + '（校验第 6 条）');
    });
    // negativeExamples≥2 保持 warning（对齐 V4_NEGATIVE_FEW）
    if (rpNegatives.length < 2) {
      warnings.push(name + ': negativeExamples 不足 2 条（每条-120 排除误召回，建议≥2）');
    }
    if (rpRecallTerms.length < 2) {
      warnings.push(name + ': recallTerms 不足 2 条（每条+65，建议≥2）');
    }
    rpNegatives.forEach(function(neg) {
      if (rpAliases.indexOf(neg) >= 0 || rpRecallTerms.indexOf(neg) >= 0) {
        warnings.push(name + ': negativeExample「' + neg + '」与 aliases/recallTerms 重叠（会互相抵消打分）');
      }
    });
    if (n.retrieval_profile && (!n.retrieval_profile.utterance_view || n.retrieval_profile.utterance_view.length < 6)) {
      warnings.push(name + ': utterance_view 条目不足（' + (n.retrieval_profile.utterance_view || []).length + '条，建议≥12条覆盖词群家族）');
    }
    if (!id.parent_intent_id) warnings.push(name + ': leaf intent missing parent aggregate');
    else if (!aggIds[id.parent_intent_id]) errors.push(name + ': parent aggregate "' + id.parent_intent_id + '" not found');
  });

  // V4.1 场景结构校验（对齐 v4-graph-validator.js §11：task_binding/bindings.capabilities/actionCode/executionMode）
  // autobuild graphDoc.nodes[i].properties.scenes 是对象数组（非 JSON 字符串），直接遍历
  var TASK_SCENE_TYPES = ['QUERY', 'DO', 'CHANGE', 'CANCEL', 'TRANSFER', 'REPAY'];
  var KNOWLEDGE_SCENE_TYPES = ['ASK', 'HELP'];
  var EXEC_MODES = ['read-execute', 'confirm-required', 'knowledge-only', 'multi_intent', 'navigation-only', 'unavailable'];
  var docNodes = (graph.graph_doc && Array.isArray(graph.graph_doc.nodes)) ? graph.graph_doc.nodes : [];
  docNodes.forEach(function(node) {
    var props = (node && node.properties) || {};
    if (!Array.isArray(props.scenes)) return;
    var label = props.name || node.id || '?';
    props.scenes.forEach(function(scene, si) {
      var sl = label + '#scene[' + si + ']';
      var st = String((scene && scene.scene_type) || '').toUpperCase();
      var tb = scene && scene.task_binding;
      var caps = (scene && scene.bindings && Array.isArray(scene.bindings.capabilities)) ? scene.bindings.capabilities : [];
      // 第 8 条：任务场景必填 task_binding + 至少 1 个能力
      if (TASK_SCENE_TYPES.indexOf(st) >= 0) {
        if (!tb) errors.push(sl + '（' + st + '）必须填写 task_binding（校验第 8 条：任务场景必填任务块）');
        else {
          // 第 14 条：actionCode 小写
          var ac = String(tb.actionCode || '').trim();
          if (ac && /^[A-Z]/.test(ac)) errors.push(sl + ' task_binding.actionCode「' + ac + '」应为小写（校验第 14 条）');
        }
        if (caps.length === 0) errors.push(sl + '（' + st + '）必须绑定至少 1 个能力（bindings.capabilities，校验第 8 条）');
      }
      // 第 7 条：问答场景不允许 task_binding / capabilities
      if (KNOWLEDGE_SCENE_TYPES.indexOf(st) >= 0) {
        if (tb) errors.push(sl + '（' + st + '）不允许 task_binding（校验第 7 条：问答场景只走知识块）');
        if (caps.length > 0) errors.push(sl + '（' + st + '）的 bindings.capabilities 必须为空（校验第 7 条）');
      }
      // 第 10 条：executionMode 合法性 + 任务场景不允许 knowledge-only
      var mode = String((scene && scene.execution_binding && scene.execution_binding.executionMode) || '').trim();
      if (mode && EXEC_MODES.indexOf(mode) < 0) errors.push(sl + ' executionMode「' + mode + '」不在枚举（' + EXEC_MODES.join('/') + '）');
      if (TASK_SCENE_TYPES.indexOf(st) >= 0 && mode === 'knowledge-only') errors.push(sl + '（' + st + '）任务场景不允许 knowledge-only 执行模式（校验第 10 条）');
    });
  });

  // 跨意图描述重复检查
  var descMap = {};
  intentNodes.forEach(function(n) {
    var desc = (n.semantic_definition && n.semantic_definition.description || '').trim();
    if (!desc) return;
    if (!descMap[desc]) descMap[desc] = [];
    descMap[desc].push(n.identity.intent_name || n.identity.intent_id);
  });
  Object.keys(descMap).forEach(function(desc) {
    if (descMap[desc].length > 1) {
      warnings.push('描述跨意图重复（稀释向量空间）: "' + desc.slice(0, 30) + '..." → ' + descMap[desc].join(', '));
    }
  });

  return { errors: errors, warnings: warnings, valid: errors.length === 0 };
}

// ── 路由分发 ──

function handleIntentGraphAutobuildRequest(req, res) {
  var url;
  try { url = new URL(req.url, 'http://' + (req.headers.host || 'localhost')); } catch(e) { return false; }
  var pathname = url.pathname;
  var method = req.method;

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return true;
  }

  if (!pathname.startsWith('/api/intent-graph-autobuild/') && pathname !== '/api/intent-graph/release') return false;

  // 认证检查
  if (!authenticate(req, res)) return true;

  // GET /api/intent-graph-autobuild/candidates
  if (method === 'GET' && pathname === '/api/intent-graph-autobuild/candidates') {
    try {
      sendJSON(res, 200, { success: true, data: listCandidates({
        role: url.searchParams.get('role'),
        domain: url.searchParams.get('domain'),
        q: url.searchParams.get('q'),
        page: url.searchParams.get('page'),
        pageSize: url.searchParams.get('pageSize'),
      }) });
    } catch(e) { sendJSON(res, 500, { success: false, error: e.message }); }
    return true;
  }

  // POST /api/intent-graph-autobuild/generate （SSE）
  if (method === 'POST' && pathname === '/api/intent-graph-autobuild/generate') {
    parseBody(req).then(function(body) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
        'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*',
      });
      try {
        runGeneration(req, res, body, null);
      } catch(e) {
        try { sseWrite(res, { type: 'error', message: e.message }); } catch(e2) {}
        res.end();
      }
    }).catch(function(e) {
      sendJSON(res, 500, { success: false, error: e.message });
    });
    return true;
  }

  // GET /api/intent-graph-autobuild/job/:jobId
  var jobMatch = pathname.match(/^\/api\/intent-graph-autobuild\/job\/([^/]+)$/);
  if (method === 'GET' && jobMatch) {
    var job = jobs[jobMatch[1]];
    if (!job) { sendJSON(res, 404, { success: false, error: 'job 不存在：' + jobMatch[1] }); return true; }
    sendJSON(res, 200, { success: true, data: jobSummary(job) });
    return true;
  }

  // POST /api/intent-graph-autobuild/job/:jobId/resume （SSE 续跑）
  var resumeMatch = pathname.match(/^\/api\/intent-graph-autobuild\/job\/([^/]+)\/resume$/);
  if (method === 'POST' && resumeMatch) {
    var resumeJob = jobs[resumeMatch[1]];
    if (!resumeJob) { sendJSON(res, 404, { success: false, error: 'job 不存在：' + resumeMatch[1] }); return true; }
    parseBody(req).then(function(body) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
        'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*',
      });
      resumeJob.status = 'running';
      if (body.dry_run !== undefined) resumeJob.params.dry_run = !!body.dry_run;
      try {
        runGeneration(req, res, { candidate_ids: resumeJob.candidate_ids, batch_size: body.batch_size, concurrency: body.concurrency, dry_run: resumeJob.params.dry_run }, resumeJob);
      } catch(e) {
        try { sseWrite(res, { type: 'error', message: e.message }); } catch(e2) {}
        res.end();
      }
    });
    return true;
  }

  // POST /api/intent-graph-autobuild/merge
  if (method === 'POST' && pathname === '/api/intent-graph-autobuild/merge') {
    parseBody(req).then(function(body) {
      try {
        var job = body.job_id ? jobs[body.job_id] : null;
        if (!job) { sendJSON(res, 404, { success: false, error: 'job 不存在：' + (body.job_id || '') }); return; }
        var intentIds = Array.isArray(body.intent_ids) && body.intent_ids.length ? body.intent_ids : null;
        var pkg = buildPackage(job, intentIds);
        var validation = validateAutobuildPackage(pkg);

        // 可选落盘：save_version 传入合法版本名时，把 v2 包写入 data/graphs/{version}.json
        // 并登记 manifest（p2_candidate），打通 merge → release 链路（此前依赖 editor export 手动落盘）
        var saved = null;
        if (body.save_version) {
          var saveVersion = String(body.save_version).trim();
          if (!/^intent-graph-v\d+\.\d+-p[12]-batch\d+$/.test(saveVersion)) {
            sendJSON(res, 400, { success: false, error: 'save_version 非法：' + saveVersion + '（须为 intent-graph-vX.Y-pZ-batchN）' });
            return;
          }
          if (validation.errors && validation.errors.length) {
            sendJSON(res, 400, { success: false, error: '包校验存在 error，拒绝落盘（先修复再保存）', validation: validation });
            return;
          }
          pkg.meta.version = saveVersion;
          pkg.meta.graph_version_id = saveVersion;
          pkg.meta.graph_version_stage = 'p2_autobuild';
          var savePath = path.join(GRAPHS_DIR, saveVersion + '.json');
          writeJson(savePath, pkg);
          // manifest 登记（与 editor export 同款约定；非致命失败）
          try {
            var mf = readJson(MANIFEST, { versions: [], active_default: null });
            mf.versions = mf.versions || [];
            mf.versions = mf.versions.filter(function(v) { return v.version_id !== saveVersion; });
            mf.versions.push({
              version_id: saveVersion,
              version_name: 'AI Harbor Intent Graph ' + saveVersion,
              stage: 'p2_autobuild', status: 'candidate',
              graph_file: 'data/graphs/' + saveVersion + '.json',
              source_version_id: saveVersion,
              changes: ['autobuild merge save（job ' + (job.job_id || '') + '）'],
            });
            mf.updated_at = new Date().toISOString();
            writeJson(MANIFEST, mf);
          } catch (e) { /* manifest 更新失败不阻断落盘结果 */ }
          saved = { version: saveVersion, file: savePath };
        }

        // 可选回流 builder 草稿：save_to_builder_draft !== false 时把 graph_doc 写入 builder 草稿路径
        // 打通 autobuild → builder 数据流（此前 autobuild 产出是孤岛，builder 无法直接消费）
        // P0-10：默认回流（save_to_builder_draft !== false），避免前端漏传参导致 builder 无法消费 autobuild 产出
        var builderDraftSaved = null;
        if (body.save_to_builder_draft !== false && pkg.graph_doc) {
          try {
            var graphDoc = pkg.graph_doc;
            // 归档已有草稿到 history（防止覆盖丢失）
            var existingDraft = readJson(BUILDER_DRAFT_PATH, null);
            if (existingDraft && Array.isArray(existingDraft.nodes)) {
              var ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
              var rand = Math.random().toString(36).slice(2, 6);
              var archiveName = 'draft-' + ts + '-' + rand + '-' + existingDraft.nodes.length + 'n.json';
              writeJson(path.join(BUILDER_DRAFT_HISTORY_DIR, archiveName), existingDraft);
            }
            // 写入新草稿
            if (!graphDoc.metadata) graphDoc.metadata = {};
            graphDoc.metadata.status = 'draft';
            graphDoc.metadata.source = 'ai-autobuild';
            graphDoc.metadata.updated_at = new Date().toISOString();
            if (!graphDoc.metadata.name) graphDoc.metadata.name = 'autobuild 草稿 ' + new Date().toISOString().slice(0, 10);
            writeJson(BUILDER_DRAFT_PATH, graphDoc);
            builderDraftSaved = {
              path: BUILDER_DRAFT_PATH,
              nodes: (graphDoc.nodes || []).length,
              edges: (graphDoc.edges || []).length,
            };
          } catch(e) { builderDraftSaved = { error: e.message }; }
        }

        sendJSON(res, 200, { success: true, package: pkg, validation: validation, saved: saved, builder_draft_saved: builderDraftSaved });
      } catch(e) { sendJSON(res, 500, { success: false, error: e.message }); }
    });
    return true;
  }

  // POST /api/intent-graph/release —— 发布桥接：viz 包 + manifest viz_file + legacy full.json
  if (method === 'POST' && pathname === '/api/intent-graph/release') {
    parseBody(req).then(function(body) {
      try {
        var version = String(body.version || '').trim();
        if (!/^intent-graph-v\d+\.\d+-p[12]-batch\d+$/.test(version)) {
          sendJSON(res, 400, { success: false, error: '版本名非法：' + version + '（须为 intent-graph-vX.Y-pZ-batchN）' });
          return;
        }
        var packagePath = path.join(GRAPHS_DIR, version + '.json');
        if (!fs.existsSync(packagePath)) {
          sendJSON(res, 404, { success: false, error: 'v2 包不存在：' + version });
          return;
        }
        var v2Package = readJson(packagePath, null);

        // ① viz 包（供 GET /api/intent-graph 可视化消费）
        var viz = require('../tools/intent-graph-viz-builder').buildViz(v2Package, version + '.json');
        var vizPath = path.join(GRAPHS_DIR, version + '-graph.json');
        writeJson(vizPath, viz);

        // ② manifest 条目补 viz_file / recognizer_bundle；promote 时置 active_default
        var mf = readJson(MANIFEST, { versions: [], active_default: null });
        mf.versions = mf.versions || [];
        var entry = null;
        mf.versions.forEach(function(v) { if (v.version_id === version) entry = v; });
        if (!entry) {
          entry = {
            version_id: version,
            version_name: 'AI Harbor Intent Graph ' + version,
            stage: 'p2_candidate', status: 'candidate',
            graph_file: 'data/graphs/' + version + '.json',
            source_version_id: version,
            changes: ['autobuild release'],
          };
          mf.versions.push(entry);
        }
        entry.viz_file = 'data/graphs/' + version + '-graph.json';

        // ③ legacy full.json 桥接（bridge_full：备份旧包 → 写识别引擎 bundle）
        var fullBridge = null;
        if (body.bridge_full) {
          var bridge = require('../tools/intent-graph-bridge-to-legacy');
          fullBridge = bridge.bridgeToLegacyFile(version);
          entry.recognizer_bundle = 'data/graphs/intent-graph-full.json';
        }

        if (body.promote_to_active) {
          mf.active_default = version;
          entry.status = 'active_default';
        }
        mf.updated_at = new Date().toISOString();
        writeJson(MANIFEST, mf);

        sendJSON(res, 200, {
          success: true, version: version, viz_file: entry.viz_file,
          manifest_updated: true, full_bridge: fullBridge,
        });
      } catch(e) { sendJSON(res, 500, { success: false, error: e.message }); }
    });
    return true;
  }

  sendJSON(res, 404, { success: false, error: 'autobuild 路由不存在：' + pathname });
  return true;
}

module.exports = { handleIntentGraphAutobuildRequest: handleIntentGraphAutobuildRequest };
