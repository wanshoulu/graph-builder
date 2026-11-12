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

// 与银行线 intent-graph-builder.graphDigest 保持一致的摘要算法（内联以免拖入建模器依赖）
function canonicalStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalStringify).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalStringify(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function graphDigest(input) {
  const copy = JSON.parse(JSON.stringify(input));
  delete copy.digest;
  return 'sha256:' + crypto.createHash('sha256').update(canonicalStringify(copy)).digest('hex');
}

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

// intake 草稿把意图字段放在 properties 内且用 snake_case；buildScene 从顶层 camelCase 读取。
// 这里把 properties + 边派生字段映射成 buildScene 期望的顶层字段，复用 buildScene（不改其签名）。
function buildIntakeScene(intentProps, actionId) {
  const synthetic = {
    action: intentProps.intent_type || 'DO',
    title: intentProps.goal || intentProps.name,
    description: intentProps.description || '',
    confusableIntents: intentProps.confusable_intents || [],
    disambiguationHints: intentProps.disambiguation_hints || [],
    aliases: intentProps.aliases || [],
    recallTerms: intentProps.recallTerms || [],
    recallTermSets: intentProps.recallTermSets || [],
    negativeExamples: intentProps.negativeExamples || [],
    semanticPriority: intentProps.semanticPriority || 0,
    actionId: actionId || '',
  };
  return buildScene(synthetic);
}

// intake 草稿的 leaf：id 由 category id + intentId 后4位拼接，保证唯一性。
function buildIntakeLeafNode(intent, catId, catPath, actionId, businessObjectIds) {
  const props = intent.properties || {};
  const title = props.name || intent.id;
  const scene = buildIntakeScene(props, actionId);
  const bindings = { menu: { path: catPath.replace(`${ROOT_TITLE}/`, '') } };
  if (businessObjectIds && businessObjectIds.length) {
    bindings.businessObjects = businessObjectIds.slice();
  }
  return {
    id: `${catId}.${intent.id.slice(-4)}`,
    title,
    node_role: 'leaf',
    parent_intent_id: catId,
    path: `${catPath}/${title}`,
    scenes: [scene],
    scope_in: [title, ...(props.description ? [props.description] : [])],
    bindings,
    observability: {
      sourceRecords: [
        {
          type: 'requirement_doc',
          ref: `intake-draft:${intent.id}`,
          note: JSON.stringify({ domain: props.domain, parent_intent_id: props.parent_intent_id }),
        },
      ],
    },
    owner: 'ai-native-bank',
    lifecycle: 'active',
    semanticVersion: '1.0.0',
  };
}

// 将 intake/builder V1 草稿（大写 type、properties 内字段、has_leaf_intent 边）转换为 v4 intentTree。
// 树结构：root → domain(INTENT.properties.domain 分组) → category(AGGREGATE_INTENT，is_child_of 建树) → leaf(INTENT，has_leaf_intent)。
function convertIntakeDraftToV4(v1Graph) {
  const nodes = v1Graph.nodes || [];
  const edges = v1Graph.edges || [];

  const aggregates = nodes.filter(n => n.type === 'AGGREGATE_INTENT');
  const intents = nodes.filter(n => n.type === 'INTENT');
  const actions = nodes.filter(n => n.type === 'ACTION');

  const aggById = new Map(aggregates.map(a => [a.id, a]));
  const actionById = new Map(actions.map(a => [a.id, a]));
  const intentById = new Map(intents.map(i => [i.id, i]));

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

  // 聚合意图 category id：ccb.channel.{domainIndex}.{aggId后4位}
  function categoryId(aggId) {
    const agg = aggById.get(aggId);
    const idx = domainIndex.has(agg.properties.domain)
      ? domainIndex.get(agg.properties.domain)
      : 0;
    return `ccb.channel.${idx}.${aggId.slice(-4)}`;
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
    const catId = categoryId(aggId);
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
      const actionNodeId = actionByIntent.get(intentId);
      const action = actionNodeId ? actionById.get(actionNodeId) : null;
      const actionId = action ? (action.properties.action_code || action.id) : '';
      const businessObjectIds = objectsByIntent.get(intentId) || [];
      tree.push(buildIntakeLeafNode(intent, catId, path, actionId, businessObjectIds));
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

  const v4 = {
    schemaVersion: '4.0',
    graphId: v1Graph.graphId || v1Graph.document_id || 'intent-graph-draft',
    version: v1Graph.version || 'draft',
    bank: v1Graph.bank || 'ccb',
    appSurface: v1Graph.appSurface || 'mobile-bank',
    publishedAt: v1Graph.publishedAt || null,
    intentTree: tree,
  };
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

module.exports = { convertV1ToV4, convertV1ToV4File, ROOT_ID, ROOT_TITLE };

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
