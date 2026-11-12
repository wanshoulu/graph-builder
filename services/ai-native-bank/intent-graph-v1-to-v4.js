'use strict';

/**
 * v1 (扁平 nodes+edges) → v4 (intentTree 树结构) 转换器。
 *
 * 为什么需要这个转换器：
 *   bank builder (intent-graph-builder.js) 产出 schemaVersion 2.0 的扁平图谱；
 *   Python 识别器 (V4GraphAdapter) 消费 schemaVersion 4.0 的 intentTree 树结构；
 *   此前二者之间无自动转换，v4-fixed.json 是手工 fix 脚本 + 6 份备份的产物。
 *
 * 字段对账依据：
 *   - app/v4_graph_adapter.py 的 leaf 展平逻辑（_flatten_tree / scene 5 块读取）
 *   - app/semantic_recall_v4.py 的 _intent_utterances（决定哪些字段进向量索引）
 *   - app/v4_graph_adapter.py 的 _extract_v2_id（靠 observability.sourceRecords 回收 v2 id）
 *   - skill 映射来自独立文件 skill-bindings.v1.json，不在图谱内
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { graphDigest } = require('./intent-graph-builder');

const ROOT_ID = 'ccb';
const ROOT_TITLE = '建设银行手机银行';

function compareById(left, right) {
  return left.id.localeCompare(right.id, 'en');
}

// ccb.menu.credit.apply -> ccb.channel.credit.apply
function categoryIdFromMenu(menuNode) {
  return menuNode.id.replace(/^ccb\.menu\./, 'ccb.channel.');
}

// 取 v1 intent id 的最后一段作为 leaf 后缀（如 ccb.credit.card.query -> query）
function lastSegment(v1Id) {
  const parts = v1Id.split('.');
  return parts[parts.length - 1];
}

// 取 v1 intent id 的最后 n 段（冲突回退用）
function lastNSegments(v1Id, n) {
  const parts = v1Id.split('.');
  return parts.slice(-n).join('.');
}

// 按 (channel, menuId) 分组为每个 intent 分配唯一 leaf 后缀。
// 为什么需要：多个 v1 intent 可能共享同一个 (channel, menuId, actionId) source
// （如 5 个 intent 共享 {home, account, guided}），用 actionId 派生 leaf id 会冲突。
// 规则：默认用 v1 intent id 最后一段；同组冲突时回退到最后两段、三段……直到唯一。
// 此规则对齐原 v4-fixed.json 的命名约定（如 ccb.channel.home.account.salary-plan）。
function assignLeafSegments(intents) {
  const groups = new Map();
  for (const intent of intents) {
    if (!intent.source) continue;
    const key = `${intent.source.channel}.${intent.source.menuId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(intent);
  }
  const segmentByIntentId = new Map();
  for (const group of groups.values()) {
    group.sort(compareById);
    const used = new Set();
    for (const intent of group) {
      const totalParts = intent.id.split('.').length;
      let seg = lastSegment(intent.id);
      let n = 2;
      while (used.has(seg) && n <= totalParts) {
        seg = lastNSegments(intent.id, n);
        n++;
      }
      used.add(seg);
      segmentByIntentId.set(intent.id, seg);
    }
  }
  return segmentByIntentId;
}

// leaf id = ccb.channel.<channel>.<menuId>.<segment>
function leafIdFromSegment(source, segment) {
  return `ccb.channel.${source.channel}.${source.menuId}.${segment}`;
}

function buildDomainNode(channelNode) {
  const title = channelNode.title;
  return {
    id: channelNode.id,
    title,
    node_role: 'domain',
    parent_intent_id: ROOT_ID,
    path: `${ROOT_TITLE}/${title}`,
    scope_in: [title],
    navigationTerms: [title],
    bindings: { menu: { path: title } },
  };
}

function buildCategoryNode(menuNode, domainNode) {
  const title = menuNode.title;
  return {
    id: categoryIdFromMenu(menuNode),
    title,
    node_role: 'category',
    parent_intent_id: domainNode.id,
    path: `${domainNode.path}/${title}`,
    scope_in: menuNode.description ? [title, menuNode.description] : [title],
    navigationTerms: menuNode.menuKey ? [menuNode.menuKey] : [],
    bindings: { menu: { path: `${domainNode.title}>${title}` } },
  };
}

function buildScene(intentNode) {
  const sceneType = intentNode.action || 'DO';
  // v1 的 capabilityBindings 是顶层字段；v4 期望它在 task_binding.slotContract 内部。
  // 纯读意图（pureRead）没有 slotContract，需合成最小契约承载 capabilityBindings。
  const capabilityBindings = intentNode.capabilityBindings || [];
  const slotContract = intentNode.slotContract
    ? { ...intentNode.slotContract, capabilityBindings }
    : { slots: [], clarificationOrder: [], capabilityBindings };

  const taskPolicy = intentNode.taskPolicy || {};
  const decisionPolicy = {
    orchestrationHint: taskPolicy.mode || intentNode.orchestrationMode || 'parallel',
    supportedShapes: taskPolicy.supportedShapes || ['single_intent'],
    contextPolicy: intentNode.contextPolicy || {},
  };
  if (intentNode.responsePolicy) decisionPolicy.responsePolicy = intentNode.responsePolicy;

  const semanticDefinition = {
    intentType: sceneType,
    description: intentNode.description || '',
    userGoal: intentNode.title,
  };
  if (intentNode.confusableIntents) {
    semanticDefinition.confusableIntents = [...intentNode.confusableIntents];
  }
  if (intentNode.disambiguationHints) {
    semanticDefinition.disambiguationHints = intentNode.disambiguationHints;
  }

  return {
    scene_type: sceneType,
    semantic_definition: semanticDefinition,
    retrieval_profile: {
      aliases: intentNode.aliases || [],
      recallTerms: intentNode.recallTerms || [],
      recallTermSets: intentNode.recallTermSets || [],
      negativeExamples: intentNode.negativeExamples || [],
      semanticPriority: intentNode.semanticPriority || 0,
    },
    execution_binding: {
      executionMode: intentNode.executionMode || 'read-execute',
      readiness: intentNode.readiness || 'planned',
      riskLevel: intentNode.riskLevel || 'L1',
    },
    task_binding: {
      slotContract,
      actionCode: intentNode.actionId || '',
    },
    decision_policy: decisionPolicy,
  };
}

function buildLeafNode(intentNode, categoryNode, segment) {
  const source = intentNode.source;
  const bindings = { menu: { path: categoryNode.bindings.menu.path } };
  if (intentNode.businessObject) bindings.businessObjects = [intentNode.businessObject];

  return {
    id: leafIdFromSegment(source, segment),
    title: intentNode.title,
    node_role: 'leaf',
    parent_intent_id: categoryNode.id,
    path: `${categoryNode.path}/${intentNode.title}`,
    scenes: [buildScene(intentNode)],
    scope_in: [intentNode.title, ...(intentNode.description ? [intentNode.description] : [])],
    bindings,
    observability: {
      sourceRecords: [
        {
          type: 'requirement_doc',
          ref: `v2-source:${intentNode.id}`,
          note: JSON.stringify(source),
        },
      ],
    },
    owner: intentNode.owner || 'ai-native-bank',
    lifecycle: intentNode.lifecycle || 'active',
    semanticVersion: intentNode.semanticVersion || '1.0.0',
  };
}

// 检测 intake/builder 草稿格式：节点 type 大写（INTENT/AGGREGATE_INTENT）。
// ccb v1 格式节点 type 小写（channel/menu/intent），走原转换路径。
function isIntakeDraftFormat(nodes) {
  return nodes.some(n => n.type === 'INTENT' || n.type === 'AGGREGATE_INTENT');
}

// ── intake 草稿字段读取辅助（对齐 routes/knowledge-intake.js apply 的写入契约）──

// 批内列表字段在 batch.json 里是逗号分隔字符串，apply 落图时已 splitList 成数组；两种形态都容忍
function parseIntakeList(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === 'string' && value.trim()) {
    return value.split(/[,，;；]/).map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

// recallTermSets 在图 properties 里存 JSON 字符串（legacy 模板 multiline 契约）
function parseIntakeTermSets(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) { return []; }
  }
  return [];
}

// apply 对未配置的交付引用写 mock:* 占位（MOCK_FULFILLMENT_REFERENCE 警告，发布前替换）。
// 转换不把占位当真实能力绑定，否则 V4_TASK_CAPABILITIES 门控被假引用骗过、运行时能力校验也会炸
function isMockRef(ref) {
  return /^mock:/i.test(String(ref || ''));
}

function dedupeStrings(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const t = String(item || '').trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function shortHashId(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 8);
}

const INTAKE_KNOWLEDGE_TYPES = ['ASK', 'HELP'];
// 6 个交付引用列 → CAPABILITY_KINDS（tools/intent-graph-schema.js）；answer_ref 走 FAQ 不进能力
const INTAKE_REF_KIND = { query_ref: 'mcp-tool', menu_ref: 'menu-nav', skill_ref: 'skill', workflow_ref: 'workflow', agent_ref: 'agent' };
const INTAKE_REF_KEYS = Object.keys(INTAKE_REF_KIND);

// 能力注册表条目的 provider（校验第 9 条：注册表条目必须带按 kind 的寻址信息）
function intakeCapabilityProvider(kind, id) {
  if (kind === 'skill') return { entry: id };
  if (kind === 'workflow') return { workflowId: id };
  if (kind === 'agent') return { agentId: id, endpoint: '' };
  if (kind === 'menu-nav') return { entry: id };
  return { protocol: 'mcp', serverId: 'ai-native-bank', toolName: id };
}

// 从 properties.capabilities（capability:<名称> tags）与 5 个交付引用列汇总真实能力引用（剔除 mock 占位）
function collectIntakeCapabilities(props) {
  const out = [];
  const byId = new Map();
  const push = (id, kind) => {
    const t = String(id || '').trim();
    if (!t || isMockRef(t)) return;
    const found = byId.get(t);
    if (found) { if (kind && found.kind === 'mcp-tool') found.kind = kind; return; }
    const entry = { id: t, kind: kind || 'mcp-tool', provider: intakeCapabilityProvider(kind || 'mcp-tool', t) };
    byId.set(t, entry);
    out.push(entry);
  };
  parseIntakeList(props.capabilities).forEach((raw) => push(raw.replace(/^capability:/, ''), 'mcp-tool'));
  INTAKE_REF_KEYS.forEach((key) => {
    parseIntakeList(props[key]).forEach((raw) => push(raw, INTAKE_REF_KIND[key]));
  });
  return out;
}

// ASK/HELP 的 knowledge_binding.answerRefs：优先复用 answer_ref 里已填的 FAQ id；
// 有 answer_text 而无引用时合成 faq:intake:* 注册表条目（§11 第 7 条：FAQ 唯一引用源）；
// 都没有时回退到 has_knowledge_answer 边挂的 KNOWLEDGE_ANSWER 节点（name=问题，boundary_rules=答案素材）
function collectIntakeFaqs(props, faqRegistry, knowledgeAnswerIds, nodesById) {
  const refs = [];
  parseIntakeList(props.answer_ref).forEach((ref) => {
    if (isMockRef(ref)) return;
    refs.push(ref);
    if (!faqRegistry.some((f) => f.id === ref)) {
      faqRegistry.push({ id: ref, question: String(props.goal || props.name || ref), answer: String(props.answer_text || '').trim() });
    }
  });
  const answerText = String(props.answer_text || '').trim();
  if (!refs.length && answerText) {
    const id = 'faq:intake:' + shortHashId(String(props.name || '') + '|' + answerText);
    if (!faqRegistry.some((f) => f.id === id)) {
      faqRegistry.push({ id, question: String(props.goal || props.name || ''), answer: answerText });
    }
    refs.push(id);
  }
  if (!refs.length && Array.isArray(knowledgeAnswerIds)) {
    for (const kaId of knowledgeAnswerIds) {
      const ka = nodesById && nodesById.get(kaId);
      const kp = (ka && ka.properties) || {};
      const question = String(kp.name || kaId);
      const rules = Array.isArray(kp.boundary_rules) ? kp.boundary_rules.map(String).filter(Boolean) : [];
      if (!question && !rules.length) continue;
      const id = 'faq:intake:' + shortHashId(kaId + '|' + question);
      if (!faqRegistry.some((f) => f.id === id)) {
        faqRegistry.push({ id, question, answer: rules.join('\n') });
      }
      refs.push(id);
    }
  }
  return refs;
}

// intake 草稿把意图字段放在 properties 内且用 snake_case；buildScene 从顶层 camelCase 读取。
// 这里把 properties + 边派生字段映射成 buildScene 期望的顶层字段，复用 buildScene（不改其签名）。
// V4.1 运行时契约字段（execution_mode/risk_level/readiness/orchestration_mode）apply 已写入
// properties，转换不再用默认值吞掉； utterance_view（标问/扩展问）是召回主素材，并入 aliases
// （schema §8.5：相似问与 v2 aliases 同义）。
function buildIntakeScene(props, ctx) {
  const sceneType = props.intent_type || 'DO';
  const isKnowledge = INTAKE_KNOWLEDGE_TYPES.indexOf(sceneType) >= 0;
  const utterances = Array.isArray(props.utterance_view) ? props.utterance_view.map(String).filter(Boolean) : [];
  // 检索素材回退链：显式列（utterance_view/aliases/recallTerms/negativeExamples）缺位时，
  // 用草稿必有的 scope_in（边界内表述→别名/召回词）与 scope_out（易混不属于→负例）补位，
  // 满足模板 min_count（aliases≥3 / recallTerms≥2 / negativeExamples≥2）
  const scopeIn = (ctx && ctx.scopeIn) || [];
  const scopeOut = (ctx && ctx.scopeOut) || [];
  let aliases = dedupeStrings(utterances.concat(parseIntakeList(props.aliases)));
  if (aliases.length < 3) aliases = dedupeStrings(aliases.concat(scopeIn));
  let recallTerms = parseIntakeList(props.recallTerms);
  if (recallTerms.length < 2) recallTerms = dedupeStrings(recallTerms.concat(scopeIn));
  let negativeExamples = parseIntakeList(props.negativeExamples);
  if (negativeExamples.length < 2) negativeExamples = dedupeStrings(negativeExamples.concat(scopeOut));
  // 别名全图唯一（校验第 5 条）：先到先得认领；被抢走的用路径词组垫底（路径段拼接天然含上下文、跨节点不重）
  const claims = ctx && ctx.aliasClaims;
  if (claims) {
    aliases = aliases.filter((a) => !claims.has(a));
    if (aliases.length < 3) aliases = dedupeStrings(aliases.concat(((ctx && ctx.aliasPad) || []).filter((a) => !claims.has(a))));
    aliases.forEach((a) => claims.set(a, ctx.ownerId || ''));
  }
  const synthetic = {
    action: sceneType,
    title: props.goal || props.name,
    description: props.description || '',
    confusableIntents: Array.isArray(props.confusable_intents) ? props.confusable_intents.map(String) : [],
    disambiguationHints: Array.isArray(props.disambiguation_hints) ? props.disambiguation_hints.map(String) : [],
    aliases,
    recallTerms,
    recallTermSets: parseIntakeTermSets(props.recallTermSets),
    negativeExamples,
    semanticPriority: Number(props.semanticPriority) || 0,
    actionId: (ctx && ctx.actionCode) || '',
    executionMode: props.execution_mode || undefined,
    readiness: props.readiness || undefined,
    riskLevel: props.risk_level || undefined,
    orchestrationMode: props.orchestration_mode || undefined,
  };
  const scene = buildScene(synthetic);
  // §11 第 7/8 条互斥：问答场景只走知识块；任务场景必带 task_binding + scene.bindings.capabilities
  if (isKnowledge) {
    delete scene.task_binding;
    scene.knowledge_binding = { answerRefs: (ctx && ctx.answerRefs) || [] };
    scene.decision_policy.responsePolicy = 'knowledge_answer';
    return scene;
  }
  const capabilities = ((ctx && ctx.capabilities) || []).map((c) => c.id);
  if (capabilities.length) scene.bindings = { capabilities };
  const slotNames = (ctx && ctx.slotNames) || [];
  if (slotNames.length || capabilities.length) {
    const slotContract = {
      slots: slotNames.map((name) => ({
        slotId: 'slot:' + name,
        name,
        label: name,
        type: 'string',
        required: true,
        extractionKeys: [],
      })),
      clarificationOrder: slotNames.slice(),
      capabilityBindings: capabilities.slice(),
    };
    // 运行时 _safe_slot_contract 契约：无 executionBinding 子键整个 slotContract 会被静默置 None
    if (capabilities.length) {
      slotContract.executionBinding = { capabilityId: capabilities[0], requiresConfirmation: !!props.requires_confirmation };
    }
    scene.task_binding.slotContract = slotContract;
  }
  return scene;
}

// intake 草稿的 leaf：id 由 category id + intentId 后4位拼接，保证唯一性。
function buildIntakeLeafNode(intent, catId, catPath, ctx) {
  const props = intent.properties || {};
  const title = props.name || intent.id;
  // 场景检索素材的回退源（见 buildIntakeScene）：scope_in=边界内表述、scope_out=易混不属于
  ctx.scopeIn = Array.isArray(props.scope_in) ? props.scope_in.map(String) : [];
  ctx.scopeOut = Array.isArray(props.scope_out) ? props.scope_out.map(String) : [];
  // 别名垫底素材：菜单路径段拼接（去根标题），长度从长到短，含完整上下文不易与兄弟节点撞词
  const pathSegs = String(catPath).replace(`${ROOT_TITLE}/`, '').split('/').filter(Boolean);
  ctx.aliasPad = dedupeStrings([].concat(
    pathSegs.map((_, i) => pathSegs.slice(i).join('')),
    [title]
  ).filter(Boolean));
  ctx.ownerId = intent.id;
  const scene = buildIntakeScene(props, ctx);
  const bindings = { menu: { path: catPath.replace(`${ROOT_TITLE}/`, '') } };
  const businessObjects = dedupeStrings([].concat(
    Array.isArray(props.object_view) ? props.object_view : [],
    (ctx && ctx.businessObjectIds) || []
  ));
  if (businessObjects.length) bindings.businessObjects = businessObjects;
  const sourceRecords = [];
  // code=v1 意图 id 是银行 sidecar 桥（bridge-intake-to-v4-supplements）唯一挂接键，
  // 放 sourceRecords.v2-source: 前缀与运行面既有 leaf 同构
  const code = String(props.code || '').trim();
  if (code) sourceRecords.push({ type: 'requirement_doc', ref: 'v2-source:' + code, note: JSON.stringify({ code }) });
  sourceRecords.push({
    type: 'requirement_doc',
    ref: `intake-draft:${intent.id}`,
    note: JSON.stringify({ domain: props.domain, parent_intent_id: props.parent_intent_id }),
  });
  const scopeIn = Array.isArray(props.scope_in) && props.scope_in.length
    ? props.scope_in.map(String)
    : [title, ...(props.description ? [String(props.description)] : [])];
  const leaf = {
    id: `${catId}.${intent.id.slice(-4)}`,
    title,
    node_role: 'leaf',
    parent_intent_id: catId,
    path: `${catPath}/${title}`,
    scenes: [scene],
    scope_in: scopeIn,
    bindings,
    observability: { sourceRecords },
    owner: 'ai-native-bank',
    lifecycle: props.lifecycle || 'active',
    semanticVersion: '1.0.0',
  };
  if (Array.isArray(props.scope_out) && props.scope_out.length) leaf.scope_out = props.scope_out.map(String);
  return leaf;
}

// 将 intake/builder V1 草稿（大写 type、properties 内字段、has_leaf_intent 边）转换为 v4 intentTree。
// 树结构：root → domain(INTENT.properties.domain 分组) → category(AGGREGATE_INTENT，is_child_of 建树) → leaf(INTENT，has_leaf_intent)。
function convertIntakeDraftToV4(v1Graph) {
  const nodes = v1Graph.nodes || [];
  const edges = v1Graph.edges || [];

  const aggregates = nodes.filter(n => n.type === 'AGGREGATE_INTENT');
  const intents = nodes.filter(n => n.type === 'INTENT');
  const actions = nodes.filter(n => n.type === 'ACTION');
  const slotNodes = nodes.filter(n => n.type === 'SLOT');

  const aggById = new Map(aggregates.map(a => [a.id, a]));
  const actionById = new Map(actions.map(a => [a.id, a]));
  const intentById = new Map(intents.map(i => [i.id, i]));
  const slotById = new Map(slotNodes.map(s => [s.id, s]));
  const nodesById = new Map(nodes.map(n => [n.id, n]));

  // requires_slot: INTENT -> SLOT（apply 的 V4.1 槽位契约落图形态）
  const slotNamesByIntent = new Map();
  for (const e of edges) {
    if (e.type !== 'requires_slot') continue;
    const slot = slotById.get(e.target);
    if (!slot) continue;
    const name = (slot.properties && slot.properties.name) || slot.id;
    if (!slotNamesByIntent.has(e.source)) slotNamesByIntent.set(e.source, []);
    slotNamesByIntent.get(e.source).push(name);
  }

  // has_knowledge_answer: INTENT -> KNOWLEDGE_ANSWER（ASK/HELP 的答案素材：name + boundary_rules）
  const knowledgeByIntent = new Map();
  for (const e of edges) {
    if (e.type !== 'has_knowledge_answer') continue;
    if (!knowledgeByIntent.has(e.source)) knowledgeByIntent.set(e.source, []);
    knowledgeByIntent.get(e.source).push(e.target);
  }

  // 别名全图唯一（校验第 5 条）：转换期全局认领表，先到先得
  const aliasClaims = new Map();

  // 意图类型 → 通用 ACTION（草稿的 ACTION 节点就是 query/apply/ask/change 这套通用动作）
  const actionByIntentType = new Map();
  for (const a of actions) {
    const types = Array.isArray(a.properties && a.properties.intent_types) ? a.properties.intent_types : [];
    for (const t of types) {
      if (!actionByIntentType.has(t)) actionByIntentType.set(String(t), a);
    }
  }

  // 资源注册表（§11 第 9 条引用可解析的落地物）；apply 侧只产 capabilities/faqs 两类来源
  const faqRegistry = [];
  const capabilityRegistry = [];

  // 域节点：用 INTENT.properties.domain 分组建域（聚合意图域是子集，已被覆盖）。
  const domainList = [];
  const domainIndex = new Map();
  for (const intent of intents) {
    const domain = intent.properties.domain;
    if (!domainIndex.has(domain)) {
      domainIndex.set(domain, domainList.length);
      domainList.push(domain);
    }
  }

  // has_leaf_intent: AGGREGATE_INTENT -> INTENT
  const leafByAgg = new Map();
  for (const e of edges) {
    if (e.type !== 'has_leaf_intent') continue;
    if (!leafByAgg.has(e.source)) leafByAgg.set(e.source, []);
    leafByAgg.get(e.source).push(e.target);
  }

  // acts_on_object: INTENT -> BUSINESS_OBJECT；uses_action: INTENT -> ACTION
  const objectsByIntent = new Map();
  const actionByIntent = new Map();
  for (const e of edges) {
    if (e.type === 'acts_on_object') {
      if (!objectsByIntent.has(e.source)) objectsByIntent.set(e.source, []);
      objectsByIntent.get(e.source).push(e.target);
    } else if (e.type === 'uses_action') {
      if (!actionByIntent.has(e.source)) actionByIntent.set(e.source, e.target);
    }
  }

  // is_child_of: source(子) -> target(父)，构建聚合意图树。
  // 根聚合意图：无 is_child_of 出边，或指向 ROOT/非聚合意图节点。
  const childOf = new Map();
  for (const e of edges) {
    if (e.type !== 'is_child_of') continue;
    childOf.set(e.source, e.target);
  }
  const childrenByParent = new Map();
  for (const a of aggregates) {
    const p = childOf.get(a.id);
    if (!p || !aggById.has(p)) continue; // 父是非聚合(ROOT)或缺失，本节点按根处理
    if (!childrenByParent.has(p)) childrenByParent.set(p, []);
    childrenByParent.get(p).push(a.id);
  }

  // 聚合意图 category id：父节点 id + '.' + aggId 后4位（schema §6.3：子 id 必须以父 id 为前缀）。
  // 根类目挂域节点（ccb.channel.{i}）下，嵌套类目逐级延伸
  function categoryId(aggId, parentNodeId) {
    return `${parentNodeId}.${aggId.slice(-4)}`;
  }

  const tree = [{
    id: ROOT_ID,
    title: ROOT_TITLE,
    node_role: 'root',
    parent_intent_id: null,
    path: ROOT_TITLE,
  }];

  // 域节点
  const domainNodes = [];
  for (let i = 0; i < domainList.length; i++) {
    const title = domainList[i];
    const node = {
      id: `ccb.channel.${i}`,
      title,
      node_role: 'domain',
      parent_intent_id: ROOT_ID,
      path: `${ROOT_TITLE}/${title}`,
      scope_in: [title],
      navigationTerms: [title],
      bindings: { menu: { path: title } },
    };
    tree.push(node);
    domainNodes.push(node);
  }

  const emittedAggs = new Set();
  function emitCategory(aggId, parentPath, parentNodeId) {
    const agg = aggById.get(aggId);
    const title = agg.properties.name;
    const catId = categoryId(aggId, parentNodeId);
    const path = `${parentPath}/${title}`;
    emittedAggs.add(aggId);

    const scopeIn = agg.properties.scope_in && agg.properties.scope_in.length
      ? [...agg.properties.scope_in]
      : [title];
    tree.push({
      id: catId,
      title,
      node_role: 'category',
      parent_intent_id: parentNodeId,
      path,
      scope_in: scopeIn,
      navigationTerms: [title],
      bindings: { menu: { path: path.replace(`${ROOT_TITLE}/`, '') } },
    });

    const leafIntentIds = (leafByAgg.get(aggId) || []).slice().sort((a, b) => a.localeCompare(b, 'en'));
    for (const intentId of leafIntentIds) {
      const intent = intentById.get(intentId);
      if (!intent) continue;
      const props = intent.properties || {};
      const actionNodeId = actionByIntent.get(intentId);
      const action = actionNodeId ? actionById.get(actionNodeId) : null;
      const ctx = {
        // apply 不建 ACTION 节点，action_code 直接写在 INTENT properties（ACTION 节点是旧 graph-importers 的来源）
        actionCode: String(props.action_code || (action ? (action.properties.action_code || action.id) : '') || ''),
        slotNames: (slotNamesByIntent.get(intentId) || []).slice(),
        capabilities: (function() {
          const listed = collectIntakeCapabilities(props);
          if (listed.length) return listed;
          // 草稿用共享 ACTION 节点（uses_action 边）表达执行能力 → 回退为能力引用 cap.<action_code>，
          // 满足 §11 第 6 条（任务场景必带 scene.bindings.capabilities）；连边都没有时按意图类型取通用动作
          const a = action || actionByIntentType.get(String(props.intent_type || ''));
          if (!a) return [];
          const code = String((a.properties && a.properties.action_code) || a.id).toLowerCase();
          return [{
            id: 'cap.' + code,
            kind: 'mcp-tool',
            title: (a.properties && a.properties.name) || code,
            provider: intakeCapabilityProvider('mcp-tool', code),
          }];
        })(),
        answerRefs: collectIntakeFaqs(props, faqRegistry, knowledgeByIntent.get(intentId) || [], nodesById),
        businessObjectIds: objectsByIntent.get(intentId) || [],
        aliasClaims,
      };
      capabilityRegistry.push(...ctx.capabilities);
      tree.push(buildIntakeLeafNode(intent, catId, path, ctx));
    }

    const kids = (childrenByParent.get(aggId) || []).slice().sort((a, b) => a.localeCompare(b, 'en'));
    for (const k of kids) emitCategory(k, path, catId);
  }

  // 根聚合意图挂到对应域节点下（按 AGGREGATE_INTENT.properties.domain 匹配）。
  const roots = aggregates.filter(a => {
    const p = childOf.get(a.id);
    if (!p) return true; // 无 is_child_of 出边
    return !aggById.has(p); // 指向 ROOT/非聚合意图 → 视为根
  }).sort(compareById);

  for (const r of roots) {
    const idx = domainIndex.has(r.properties.domain)
      ? domainIndex.get(r.properties.domain)
      : 0;
    const domainNode = domainNodes[idx] || domainNodes[0];
    emitCategory(r.id, domainNode.path, domainNode.id);
  }

  // 孤儿聚合意图告警（未被根递归覆盖，如 is_child_of 成环）
  const orphanAggs = aggregates.filter(a => !emittedAggs.has(a.id));
  if (orphanAggs.length) {
    console.warn(`[v1-to-v4] dropped ${orphanAggs.length} orphan aggregate(s) (unreachable from root)`);
  }
  // 孤儿叶子意图告警（无 has_leaf_intent 边）
  const leafIntents = new Set();
  for (const ids of leafByAgg.values()) for (const id of ids) leafIntents.add(id);
  const orphanIntents = intents.filter(i => !leafIntents.has(i.id));
  if (orphanIntents.length) {
    console.warn(`[v1-to-v4] dropped ${orphanIntents.length} orphan intent(s) (no has_leaf_intent edge)`);
  }

  // confusable_intents 存的是意图名称（apply 只保留能解析到图内的名称）→ 改写成 v4 leaf id，
  // 并落 relations[]（confusable_with）；解析不到/自引用的丢弃并计数
  const leafIdByTitle = new Map();
  const leafIdByIntentNodeId = new Map();
  for (const node of tree) {
    if (node.node_role !== 'leaf') continue;
    if (!leafIdByTitle.has(node.title)) leafIdByTitle.set(node.title, node.id);
    const records = (node.observability && node.observability.sourceRecords) || [];
    const draftRef = records.find((r) => String(r.ref || '').startsWith('intake-draft:'));
    if (draftRef) leafIdByIntentNodeId.set(String(draftRef.ref).slice('intake-draft:'.length), node.id);
  }
  const relations = [];
  const relationSeen = new Set();
  let rewrittenConfusables = 0;
  let droppedConfusables = 0;
  for (const node of tree) {
    if (node.node_role !== 'leaf' || !node.scenes) continue;
    for (const scene of node.scenes) {
      const sd = scene.semantic_definition;
      if (!sd || !Array.isArray(sd.confusableIntents)) continue;
      const mapped = [];
      for (const name of sd.confusableIntents) {
        const targetId = leafIdByTitle.get(name) || leafIdByIntentNodeId.get(name) || null;
        if (!targetId || targetId === node.id) { droppedConfusables += 1; continue; }
        mapped.push(targetId);
        const relId = `rel.${node.id}.confusable_with.${targetId}`;
        if (!relationSeen.has(relId)) {
          relationSeen.add(relId);
          relations.push({ id: relId, type: 'confusable_with', from: node.id, to: targetId });
        }
        rewrittenConfusables += 1;
      }
      sd.confusableIntents = mapped;
    }
  }
  if (rewrittenConfusables || droppedConfusables) {
    console.warn(`[v1-to-v4] confusableIntents: rewrote ${rewrittenConfusables}, dropped ${droppedConfusables} (unresolved/self)`);
  }

  // 能力注册表：同名去重保首个 kind；注册表同时挂 metadata（GraphDocument 形态兼容读取）
  const capabilitiesById = new Map();
  for (const c of capabilityRegistry) {
    if (!capabilitiesById.has(c.id)) {
      capabilitiesById.set(c.id, {
        id: c.id,
        title: c.title || c.id,
        kind: c.kind,
        riskLevel: 'L0',
        provider: c.provider || intakeCapabilityProvider(c.kind, c.id),
      });
    }
  }
  const resourceRegistries = {
    capabilities: Array.from(capabilitiesById.values()),
    faqs: faqRegistry,
    policies: [],
    skillBindings: [],
  };

  const v4 = {
    schemaVersion: '4.0',
    graphId: v1Graph.graphId || v1Graph.document_id || 'intent-graph-draft',
    version: v1Graph.version || 'draft',
    bank: v1Graph.bank || 'ccb',
    appSurface: v1Graph.appSurface || 'mobile-bank',
    publishedAt: v1Graph.publishedAt || null,
    intentTree: tree,
    relations,
    resourceRegistries,
  };
  v4.metadata = { v4ResourceRegistries: resourceRegistries };
  v4.digest = graphDigest(v4);
  return v4;
}

/**
 * 将 v1 扁平图谱转换为 v4 intentTree 树结构。
 * @param {object} v1Graph - schemaVersion 2.0 的扁平图谱 (nodes+edges)
 * @returns {object} schemaVersion 4.0 的树结构图谱 (intentTree)
 */
function convertV1ToV4(v1Graph) {
  const nodes = v1Graph.nodes || [];
  // intake/builder 草稿格式（大写 type、properties 内字段、has_leaf_intent 边）
  // 与 ccb v1 格式（小写 type、顶层字段、contains/offers 边）分流。
  // nodes 为空时保持原 ccb v1 逻辑。
  if (nodes.length > 0 && isIntakeDraftFormat(nodes)) {
    return convertIntakeDraftToV4(v1Graph);
  }
  const edges = v1Graph.edges || [];

  const channels = nodes.filter(n => n.type === 'channel').sort(compareById);
  const menus = nodes.filter(n => n.type === 'menu');
  const intents = nodes.filter(n => n.type === 'intent');

  // v1 intent id (如 ccb.credit.card.query) -> v4 leaf id (ccb.channel.credit.card-manage.query)
  // 用于改写 confusableIntents 里引用的 v1 id，使其指向 v4 树节点。
  // leaf 后缀用 v1 intent id 的最后一段（冲突时回退到最后两段），对齐原 v4-fixed 命名约定。
  const segmentByIntentId = assignLeafSegments(intents);
  const v1ToV4IdMap = new Map();
  for (const intent of intents) {
    if (intent.source) {
      const seg = segmentByIntentId.get(intent.id);
      v1ToV4IdMap.set(intent.id, leafIdFromSegment(intent.source, seg));
    }
  }

  // contains: channel -> menu ; offers: menu -> intent
  const containsByMenu = new Map();
  const offersByIntent = new Map();
  for (const e of edges) {
    if (e.type === 'contains') containsByMenu.set(e.to, e.from);
    else if (e.type === 'offers') offersByIntent.set(e.to, e.from);
  }

  const tree = [{
    id: ROOT_ID,
    title: ROOT_TITLE,
    node_role: 'root',
    parent_intent_id: null,
    path: ROOT_TITLE,
  }];

  let orphanMenus = 0;
  let orphanIntents = 0;

  for (const channel of channels) {
    const domainNode = buildDomainNode(channel);
    tree.push(domainNode);

    const channelMenus = menus
      .filter(m => containsByMenu.get(m.id) === channel.id)
      .sort(compareById);
    for (const menu of channelMenus) {
      const categoryNode = buildCategoryNode(menu, domainNode);
      tree.push(categoryNode);

      const menuIntents = intents
        .filter(i => offersByIntent.get(i.id) === menu.id)
        .sort(compareById);
      for (const intent of menuIntents) {
        tree.push(buildLeafNode(intent, categoryNode, segmentByIntentId.get(intent.id)));
      }
    }
  }

  // 孤儿节点告警：menu/intent 没有对应 contains/offers 边
  orphanMenus = menus.filter(m => !containsByMenu.has(m.id)).length;
  orphanIntents = intents.filter(i => !offersByIntent.has(i.id)).length;
  if (orphanMenus || orphanIntents) {
    console.warn(`[v1-to-v4] dropped orphans: ${orphanMenus} menus, ${orphanIntents} intents (no contains/offers edge)`);
  }

  // 后处理：把 leaf 场景里 confusableIntents 引用的 v1 id 改写为 v4 leaf id。
  // v1 的 confusableIntents 引用的是扁平 intent id（如 ccb.credit.card.query），
  // v4 树里 leaf id 多了 channel 中段（ccb.channel.credit.card.query）。
  let rewrittenConfusables = 0;
  for (const node of tree) {
    if (node.node_role !== 'leaf' || !node.scenes) continue;
    for (const scene of node.scenes) {
      const sd = scene.semantic_definition;
      if (!sd || !Array.isArray(sd.confusableIntents)) continue;
      sd.confusableIntents = sd.confusableIntents.map(id => {
        const mapped = v1ToV4IdMap.get(id);
        if (mapped) { rewrittenConfusables++; return mapped; }
        return id;
      });
    }
  }
  if (rewrittenConfusables > 0) {
    console.warn(`[v1-to-v4] rewrote ${rewrittenConfusables} confusableIntents id(s) from v1 to v4`);
  }

  const v4 = {
    schemaVersion: '4.0',
    graphId: v1Graph.graphId,
    version: v1Graph.version,
    bank: v1Graph.bank,
    appSurface: v1Graph.appSurface,
    publishedAt: v1Graph.publishedAt,
    intentTree: tree,
  };
  v4.digest = graphDigest(v4);
  return v4;
}

function convertV1ToV4File(inputPath, outputPath) {
  const v1 = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const v4 = convertV1ToV4(v1);
  fs.writeFileSync(outputPath, JSON.stringify(v4, null, 2) + '\n', 'utf8');
  return v4;
}

// ── 形态适配器：V4.1 文件（intentTree）↔ GraphDocument（builder 草稿/校验器形态）──
// 字段映射与前端 web/src/pages/GraphBuilder/lib/intentGraphV4.ts 的 v4ToGraphDocument /
// graphDocumentToV4 保持同构；服务端发布门控与 convert 落盘都吃 GraphDocument 形态
// （saveDraft 强制 nodes/edges，草稿 Excel 桥与草稿历史也按 nodes 计数）。

const NODE_TYPE_BY_ROLE = { root: 'ROOT', domain: 'DOMAIN', category: 'CATEGORY', leaf: 'LEAF' };

/** V4.1 文档（intentTree）→ GraphDocument。resourceRegistries 取顶层或 metadata，挂到 metadata.v4ResourceRegistries */
function intentTreeToGraphDocument(v4Doc) {
  const tree = Array.isArray(v4Doc && v4Doc.intentTree) ? v4Doc.intentTree : [];
  const ids = new Set(tree.map((n) => n && n.id).filter(Boolean));
  const nodes = tree.map((n) => {
    const role = String(n.node_role || 'leaf');
    // ROOT 模板只声明 title/node_role/lifecycle，多出的键会被 PROPERTY_NOT_IN_SCHEMA 拦下
    const properties = {
      title: String(n.title !== undefined && n.title !== null ? n.title : n.id),
      node_role: role,
      lifecycle: String(n.lifecycle || 'active'),
    };
    if (role !== 'root') {
      properties.scope_in = Array.isArray(n.scope_in) ? n.scope_in : [];
      properties.scope_out = Array.isArray(n.scope_out) ? n.scope_out : [];
      properties.navigation_terms = Array.isArray(n.navigationTerms) ? n.navigationTerms : [];
      properties.menu = n.bindings && n.bindings.menu && n.bindings.menu.path ? String(n.bindings.menu.path) : '';
      properties.business_objects = n.bindings && Array.isArray(n.bindings.businessObjects) ? n.bindings.businessObjects : [];
      properties.policies = n.bindings && Array.isArray(n.bindings.policies) ? n.bindings.policies : [];
      properties.observability = n.observability !== undefined && n.observability !== null ? JSON.stringify(n.observability) : '';
    }
    if (Array.isArray(n.scenes) && n.scenes.length > 0) properties.scenes = JSON.stringify(n.scenes);
    return { id: n.id, type: NODE_TYPE_BY_ROLE[role] || 'LEAF', properties };
  });
  const edges = [];
  tree.forEach((n) => {
    if (!n || !n.parent_intent_id || !ids.has(n.parent_intent_id)) return;
    edges.push({ id: 'edge.hc.' + n.id, type: 'has_child', source: n.parent_intent_id, target: n.id, properties: {} });
  });
  const reg = (v4Doc && v4Doc.resourceRegistries) || (v4Doc && v4Doc.metadata && v4Doc.metadata.v4ResourceRegistries) || {};
  const asArray = (v) => (Array.isArray(v) ? v : []);
  return {
    document_id: String((v4Doc && v4Doc.graphId) || 'v4-doc'),
    document_version: String((v4Doc && v4Doc.version) || '1.0.0'),
    asset_id: 'intent-graph-v4',
    template_ref: { template_id: 'intent-graph-v4', template_version: '1.0.0' },
    nodes,
    edges,
    metadata: {
      v4ResourceRegistries: {
        capabilities: asArray(reg.capabilities),
        faqs: asArray(reg.faqs),
        policies: asArray(reg.policies),
        skillBindings: asArray(reg.skillBindings),
      },
    },
  };
}

module.exports = { convertV1ToV4, convertV1ToV4File, intentTreeToGraphDocument, ROOT_ID, ROOT_TITLE };

if (require.main === module) {
  const args = process.argv.slice(2);
  const input = args[0] || path.join(__dirname, '..', '..', 'data', 'ai-native-bank', 'intent-graph', 'graph.ccb.intents.v1.0.0.json');
  const output = args[1] || path.join(__dirname, '..', '..', 'data', 'ai-native-bank', 'intent-graph', 'archive', 'ccb-mobile-bank-intents.v4.json');
  const v4 = convertV1ToV4File(input, output);
  const counts = v4.intentTree.reduce((acc, n) => {
    acc[n.node_role] = (acc[n.node_role] || 0) + 1;
    return acc;
  }, {});
  console.log(`v4 graph written: ${output}`);
  console.log(`tree stats: ${JSON.stringify(counts)} (total ${v4.intentTree.length})`);
  console.log(`digest: ${v4.digest}`);
}
