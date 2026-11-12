/**
 * 意图图谱 v2 包 → 可视化包（viz）生成器 — 共享模块（UMD）
 *
 * 单一来源：从 scripts/build-intent-graph-v2-viz-from-package.js 原样抽取
 * （函数体逐字一致，2026-08-25；仅 buildViz 增 sourceName 参数替代原 DEFAULT_IN 引用，
 * 展开运算 {...visualProps()} 用 Object.assign 等价重写以保持键序）。
 * 用途：release 端点（routes/intent-graph-autobuild.js，容器内运行）与 CLI 脚本共用。
 * 注意：仅在 Node 环境使用（Buffer 依赖），不要引入浏览器页面。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IntentGraphVizBuilder = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var NODE_VISUAL_STYLES = {
    root: { color: '#f8fafc', border: '#cbd5e1', shape: 'star', size: 32 },
    domain: { color: '#60a5fa', border: '#93c5fd', shape: 'ellipse', size: 22 },
    aggregate_intent: { color: '#2dd4bf', border: '#99f6e4', shape: 'box', size: 18 },
    intent: { color: '#f59e0b', border: '#fbbf24', executableBorder: '#fde68a', shape: 'dot', size: 12 },
    business_object: { color: '#a78bfa', border: '#ddd6fe', shape: 'hexagon', size: 12 },
    action: { color: '#fb7185', border: '#fecdd3', shape: 'diamond', size: 13 },
    knowledge: { color: '#94a3b8', border: '#cbd5e1', shape: 'database', size: 12 },
  };

  function visualProps(type, extra) {
    var style = NODE_VISUAL_STYLES[type] || { color: '#94a3b8', border: '#cbd5e1', shape: 'dot', size: 10 };
    var isExecutableIntent = type === 'intent' && extra.isExecutableLeaf;
    return {
      color: style.color,
      borderColor: isExecutableIntent ? style.executableBorder : style.border,
      shape: style.shape,
      size: style.size,
      borderWidth: isExecutableIntent ? 3 : 2,
    };
  }

  function addUniqueNode(nodes, seen, node) {
    if (!node || !node.id || seen.has(node.id)) return;
    seen.add(node.id);
    nodes.push(node);
  }

  function addUniqueEdge(edges, seen, edge) {
    if (!edge || !edge.from || !edge.to) return;
    var key = edge.from + '|' + edge.to + '|' + (edge.relationType || edge.label || '');
    if (seen.has(key)) return;
    seen.add(key);
    edges.push(edge);
  }

  function pickWeightFields(source) {
    if (!source || typeof source !== 'object') return {};
    var result = {};
    var keys = ['weight', 'priority', 'score', 'confidence', 'importance', 'weights'];
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (source[key] !== undefined && source[key] !== null) result[key] = source[key];
    }
    return result;
  }

  function domainId(domain) {
    return 'domain_' + Buffer.from(String(domain || 'unknown')).toString('hex').slice(0, 16);
  }

  function buildViz(graph, sourceName) {
    var nodes = [];
    var edges = [];
    var nodeSeen = new Set();
    var edgeSeen = new Set();
    var summary = graph.summary || {};
    var meta = graph.meta || {};
    var domains = Object.keys(summary.domain_distribution || {});
    var rootVersionName = meta.graph_version_name || meta.version || 'AI Harbor Intent Graph';
    var rootVersionId = meta.graph_version_id || meta.version || 'intent-graph';

    addUniqueNode(nodes, nodeSeen, Object.assign({
      id: 'root',
      label: rootVersionId,
      fullLabel: rootVersionName,
      nodeType: 'root',
    }, visualProps('root')));

    domains.forEach(function (domain) {
      var id = domainId(domain);
      addUniqueNode(nodes, nodeSeen, Object.assign({
        id: id,
        label: domain,
        fullLabel: domain,
        nodeType: 'domain',
      }, visualProps('domain'), {
        count: summary.domain_distribution[domain],
      }));
      addUniqueEdge(edges, edgeSeen, { from: 'root', to: id, label: 'has_domain', relationType: 'has_domain', arrows: 'to' });
    });

    (graph.aggregate_intents || []).forEach(function (aggregate) {
      addUniqueNode(nodes, nodeSeen, Object.assign({
        id: aggregate.intent_id,
        label: aggregate.intent_name,
        fullLabel: aggregate.intent_name,
        nodeType: 'aggregate_intent',
      }, visualProps('aggregate_intent'), {
        domain: aggregate.domain,
        description: aggregate.semantic_definition && aggregate.semantic_definition.description || '',
        sourcePath: aggregate.source_binding && aggregate.source_binding.business_category_path || '',
        navigationPath: aggregate.source_binding && aggregate.source_binding.standard_navigation_path || '',
      }, pickWeightFields(aggregate)));
      addUniqueEdge(edges, edgeSeen, { from: domainId(aggregate.domain), to: aggregate.intent_id, label: 'contains', relationType: 'contains', arrows: 'to' });
    });

    (graph.intent_nodes || []).forEach(function (intent) {
      var task = intent.task_binding || {};
      var action = task.action || {};
      var object = task.business_object || {};
      var isExecutableLeaf = !!(intent.identity && intent.identity.is_executable_leaf);
      addUniqueNode(nodes, nodeSeen, Object.assign({
        id: intent.identity.intent_id,
        label: intent.labels && intent.labels.display_label || intent.identity.intent_name,
        fullLabel: intent.identity.intent_name,
        nodeType: 'intent',
      }, visualProps('intent', { isExecutableLeaf: isExecutableLeaf }), {
        isExecutableLeaf: isExecutableLeaf,
        domain: intent.identity.domain,
        intentType: intent.identity.intent_type,
        actionCode: action.action_code || intent.source_legacy && intent.source_legacy.action_code || '',
        businessObject: object.object_name || '',
        description: intent.semantic_definition && intent.semantic_definition.description || '',
        evalLabel: intent.labels && intent.labels.eval_label || '',
        taskId: task.task_id || '',
        knowledgeRefs: intent.knowledge_binding && intent.knowledge_binding.knowledge_refs || [],
        navigationPath: intent.execution_binding && intent.execution_binding.standard_navigation_path || '',
        legacySceneName: intent.source_legacy && intent.source_legacy.scene_name || '',
        retrievalPreview: intent.observability && intent.observability.retrieval_text_preview || '',
      }, pickWeightFields(intent)));
    });

    var supporting = graph.supporting_nodes || {};
    (supporting.business_objects || []).forEach(function (object) {
      addUniqueNode(nodes, nodeSeen, Object.assign({
        id: object.object_id,
        label: object.object_name,
        fullLabel: object.object_name,
        nodeType: 'business_object',
      }, visualProps('business_object'), {
        domain: object.domain,
        aliases: object.aliases || [],
      }, pickWeightFields(object)));
    });
    (supporting.actions || []).forEach(function (action) {
      addUniqueNode(nodes, nodeSeen, Object.assign({
        id: action.action_id,
        label: action.action_name || action.action_code,
        fullLabel: action.action_name || action.action_code,
        nodeType: 'action',
      }, visualProps('action'), {
        actionCode: action.action_code,
        aliases: action.aliases || [],
      }, pickWeightFields(action)));
    });
    (supporting.knowledge_answers || []).forEach(function (knowledge) {
      addUniqueNode(nodes, nodeSeen, Object.assign({
        id: knowledge.knowledge_id,
        label: knowledge.knowledge_name,
        fullLabel: knowledge.knowledge_name,
        nodeType: 'knowledge',
      }, visualProps('knowledge'), {
        answerType: knowledge.answer_type,
        answerPolicy: knowledge.answer_policy,
        boundaryRules: knowledge.boundary_rules || [],
      }, pickWeightFields(knowledge)));
    });

    (graph.edges || []).forEach(function (edge) {
      if (!nodeSeen.has(edge.from) || !nodeSeen.has(edge.to)) return;
      addUniqueEdge(edges, edgeSeen, {
        from: edge.from,
        to: edge.to,
        label: edge.type,
        relationType: edge.type,
        relationCategory: edge.relation_category || '',
        edgeId: edge.edge_id || '',
        evidence: edge.evidence || '',
        condition: edge.condition,
        status: edge.status || '',
        version: edge.version || '',
        owner: edge.owner || '',
        weight: edge.weight,
        priority: edge.priority,
        arrows: 'to',
      });
    });

    return {
      meta: Object.assign({}, graph.meta || {}, {
        viz_source: sourceName || '',
        viz_generated_at: new Date().toISOString(),
      }),
      summary: Object.assign({}, summary, {
        total_nodes: nodes.length,
        total_edges: edges.length,
      }),
      graph: { nodes: nodes, edges: edges },
    };
  }

  return { buildViz: buildViz };
});
