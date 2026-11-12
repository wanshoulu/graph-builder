/**
 * 意图图谱 v2.1 → org-graph 文档 转换器（纯函数，可单测）
 *
 * 双通道保真（用户选型「全字段 schema」落法）：
 *   可编辑通道：v2.1 嵌套字段按 FIELD_PATHS 映射表平铺进 properties（模板已声明这些字段，
 *     四阶段属性面板直接可编辑）；
 *   无损通道：v2.1 原对象整存进元素顶层 raw（X6 校验器只查 properties，顶层键安全——
 *     已实测 provenance 先例）。反向导出（export 方向）用同一张 FIELD_PATHS 把 properties
 *     深合并回 raw 的嵌套路径，未改字段保持原值。
 *
 * 数据源形状（data/graphs/intent-graph-v2.1-p1-batchN.json）：
 *   aggregate_intents / intent_nodes（identity+semantic_definition+retrieval_profile+
 *   task_binding+execution_binding+labels+governance） / supporting_nodes{
 *   business_objects, actions, slots, states, risks, knowledge_answers, runtime_boundaries}
 *   edges[{edge_id,from,to,type,relation_category,evidence,condition,weight,priority,status,version,owner}]
 */
'use strict';

/** 节点属性 ↔ v2.1 嵌套路径 映射表（properties 键 → 原对象字段路径数组；import/export 双向共用） */
const INTENT_FIELD_PATHS = {
  name: ['identity', 'intent_name'],
  intent_type: ['identity', 'intent_type'],
  domain: ['identity', 'domain'],
  parent_intent_id: ['identity', 'parent_intent_id'],
  is_executable_leaf: ['identity', 'is_executable_leaf'],
  is_knowledge_intent: ['identity', 'is_knowledge_intent'],
  goal: ['semantic_definition', 'user_goal'],
  description: ['semantic_definition', 'description'],
  scope_in: ['semantic_definition', 'scope_in'],
  scope_out: ['semantic_definition', 'scope_out'],
  confusable_intents: ['semantic_definition', 'confusable_intents'],
  disambiguation_hints: ['semantic_definition', 'disambiguation_hints'],
  utterance_view: ['retrieval_profile', 'utterance_view'],
  object_view: ['retrieval_profile', 'object_view'],
  action_view: ['retrieval_profile', 'action_view'],
  tb_action_code: ['task_binding', 'action', 'action_code'],
  tb_action_name: ['task_binding', 'action', 'action_name'],
  tb_object_name: ['task_binding', 'business_object', 'object_name'],
  route_type: ['execution_binding', 'route_type'],
  standard_navigation_path: ['execution_binding', 'standard_navigation_path'],
};

const AGGREGATE_FIELD_PATHS = {
  name: ['intent_name'],
  domain: ['domain'],
  modeling_role: ['modeling_role'],
  goal: ['semantic_definition', 'user_goal'],
  description: ['semantic_definition', 'description'],
  scope_in: ['semantic_definition', 'scope_in'],
  scope_out: ['semantic_definition', 'scope_out'],
  boundary_note: ['semantic_definition', 'boundary_note'],
};

/** 支撑节点：org 类型 → { 集合名, id 键, name 键, 其余字段平铺路径 } */
const SUPPORTING_DEFS = {
  BUSINESS_OBJECT: { collection: 'business_objects', id: 'object_id', fields: { name: 'object_name', domain: 'domain', aliases: 'aliases', description: 'description' } },
  ACTION: { collection: 'actions', id: 'action_id', fields: { name: 'action_name', action_code: 'action_code', aliases: 'aliases', intent_types: 'intent_types', definition: 'definition' } },
  SLOT: { collection: 'slots', id: 'slot_id', fields: { name: 'slot_name', data_type: 'data_type', clarify_question: 'clarify_question' } },
  STATE: { collection: 'states', id: 'state_id', fields: { name: 'state_name', state_type: 'state_type', source: 'source' } },
  RISK: { collection: 'risks', id: 'risk_id', fields: { name: 'risk_name', policy: 'policy' } },
  KNOWLEDGE_ANSWER: { collection: 'knowledge_answers', id: 'knowledge_id', fields: { name: 'knowledge_name', answer_type: 'answer_type', boundary_rules: 'boundary_rules' } },
  RUNTIME_BOUNDARY: { collection: 'runtime_boundaries', id: 'boundary_id', fields: { name: 'boundary_name', boundary_code: 'boundary_code', definition: 'definition', retrieval_policy: 'retrieval_policy', route_type: 'route_type', fixed_response: 'fixed_response' } },
};

/** 边属性（v2.1 边字段与模板声明同键，映射即字段级拷贝） */
const EDGE_FIELD_KEYS = ['relation_category', 'status', 'weight', 'priority', 'evidence', 'condition', 'owner', 'version'];

/** 嵌套取值（路径不存在返回 undefined） */
function getPath(obj, paths) {
  let cur = obj;
  for (let i = 0; i < paths.length; i += 1) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[paths[i]];
  }
  return cur;
}

/** 嵌套赋值（路径不存在则创建对象；export 方向用） */
function setPath(obj, paths, value) {
  let cur = obj;
  for (let i = 0; i < paths.length - 1; i += 1) {
    if (cur[paths[i]] == null || typeof cur[paths[i]] !== 'object') cur[paths[i]] = {};
    cur = cur[paths[i]];
  }
  cur[paths[paths.length - 1]] = value;
}

/** 按映射表把嵌套字段平铺进 properties（值 undefined 不写；数组/字符串原样） */
function flattenByPaths(source, paths) {
  const properties = {};
  Object.keys(paths).forEach(function (key) {
    const value = getPath(source, paths[key]);
    if (value === undefined || value === null || value === '') return;
    properties[key] = value;
  });
  return properties;
}

/** v2.1 批量文件 → org-graph 文档（nodes/edges + metadata + report）。
 *  opts.sourceLabel：批次名（provenance 与 metadata 记录用）。 */
function convertIntentV21(batch, template, opts) {
  const sourceLabel = (opts && opts.sourceLabel) || 'v2.1';
  const report = { skippedEdges: [], droppedEdgesByReason: {}, droppedNodesByReason: {} };
  const nodes = [];
  const edges = [];
  const seenNodeIds = new Set();

  function pushNode(id, type, properties, raw) {
    if (seenNodeIds.has(id)) {
      report.droppedNodesByReason.duplicate_id = (report.droppedNodesByReason.duplicate_id || 0) + 1;
      return;
    }
    seenNodeIds.add(id);
    nodes.push({
      id: id, type: type, properties: properties, raw: raw,
      provenance: { source: 'import', sourceBatch: sourceLabel },
      review_status: 'accepted',
    });
  }

  (batch.aggregate_intents || []).forEach(function (n) {
    pushNode(n.intent_id, 'AGGREGATE_INTENT', flattenByPaths(n, AGGREGATE_FIELD_PATHS), n);
  });
  (batch.intent_nodes || []).forEach(function (n) {
    const identity = n.identity || {};
    pushNode(identity.intent_id, 'INTENT', flattenByPaths(n, INTENT_FIELD_PATHS), n);
  });
  const supporting = batch.supporting_nodes || {};
  Object.keys(SUPPORTING_DEFS).forEach(function (orgType) {
    const def = SUPPORTING_DEFS[orgType];
    (supporting[def.collection] || []).forEach(function (n) {
      const properties = {};
      Object.keys(def.fields).forEach(function (key) {
        const value = n[def.fields[key]];
        if (value === undefined || value === null || value === '') return;
        properties[key] = value;
      });
      pushNode(n[def.id], orgType, properties, n);
    });
  });

  (batch.edges || []).forEach(function (e) {
    if (!e.from || !e.to) {
      report.skippedEdges.push({ edge_id: e.edge_id, reason: 'empty_endpoint' });
      report.droppedEdgesByReason.empty_endpoint = (report.droppedEdgesByReason.empty_endpoint || 0) + 1;
      return;
    }
    if (!seenNodeIds.has(e.from) || !seenNodeIds.has(e.to)) {
      report.skippedEdges.push({ edge_id: e.edge_id, reason: 'endpoint_missing' });
      report.droppedEdgesByReason.endpoint_missing = (report.droppedEdgesByReason.endpoint_missing || 0) + 1;
      return;
    }
    const properties = {};
    EDGE_FIELD_KEYS.forEach(function (key) {
      const value = e[key];
      if (value === undefined || value === null || value === '') return;
      properties[key] = value;
    });
    edges.push({
      id: e.edge_id, type: e.type, source: e.from, target: e.to, properties: properties, raw: e,
      provenance: { source: 'import', sourceBatch: sourceLabel },
      review_status: 'accepted',
    });
  });

  report.sourceStats = {
    aggregate_intents: (batch.aggregate_intents || []).length,
    intent_nodes: (batch.intent_nodes || []).length,
    supporting_nodes: nodes.length - (batch.aggregate_intents || []).length - (batch.intent_nodes || []).length,
    edges: (batch.edges || []).length,
  };

  const document = {
    document_id: 'intent-v21-import',
    document_version: '1.0.0',
    asset_id: template.template_id,
    template_ref: { template_id: template.template_id, template_version: template.template_version },
    nodes: nodes,
    edges: edges,
    metadata: {
      importer: 'intent-v21',
      source_batch: sourceLabel,
      source_stats: report.sourceStats,
      imported_at: new Date().toISOString(),
    },
  };
  return { document: document, report: report };
}

/**
 * 反向导出（P4）：org-graph 文档 → v2.1 形状。
 * 以 raw（v2.1 原对象）为底，把 properties 按映射表深合并回嵌套路径——
 * 专家在 GraphBuilder 改过的字段回写，未改字段保持原值；raw 缺失的元素（新建节点）
 * 用最小 v2.1 形状生成（identity.intent_id/intent_name 等）。
 */
function exportIntentV21(document) {
  const nodes = document.nodes || [];
  const byId = {};
  nodes.forEach(function (n) { byId[n.id] = n; });

  function mergePaths(raw, properties, paths) {
    Object.keys(paths).forEach(function (key) {
      if (!(key in properties)) return;
      setPath(raw, paths[key], properties[key]);
    });
    return raw;
  }

  const aggregate_intents = [];
  const intent_nodes = [];
  const supporting = { business_objects: [], actions: [], slots: [], states: [], risks: [], knowledge_answers: [], runtime_boundaries: [] };
  const idPrefixOf = function (type) {
    return { AGGREGATE_INTENT: 'intent_group_node_', INTENT: 'intent_leaf_', BUSINESS_OBJECT: 'obj_', ACTION: 'act_', SLOT: 'slot_', STATE: 'state_', RISK: 'risk_', KNOWLEDGE_ANSWER: 'knowledge_', RUNTIME_BOUNDARY: 'rb_' }[type] || (String(type).toLowerCase() + '_');
  };
  let synthCounter = 0;
  function syntheticId(type) {
    synthCounter += 1;
    return idPrefixOf(type) + 'synth_' + synthCounter;
  }

  function synthBase(id, type, name) {
    const base = {
      intent_id: id, intent_name: name, intent_level: 'aggregate', domain: '', modeling_role: 'aggregate',
      semantic_definition: { user_goal: '', description: '', scope_in: [], scope_out: [], boundary_note: '' },
    };
    return base;
  }

  nodes.forEach(function (n) {
    const props = n.properties || {};
    if (n.type === 'AGGREGATE_INTENT') {
      const raw = mergePaths(n.raw && typeof n.raw === 'object' ? n.raw : synthBase(n.id, 'AGGREGATE_INTENT', String(props.name || n.id)), props, AGGREGATE_FIELD_PATHS);
      raw.intent_id = n.id; // id 以 org 文档为准（防止 id 被改名）
      aggregate_intents.push(raw);
    } else if (n.type === 'INTENT') {
      const base = n.raw && typeof n.raw === 'object' ? n.raw : (function () {
        const b = synthBase(n.id, 'INTENT', String(props.name || n.id));
        b.intent_level = 'leaf';
        b.identity = {
          intent_id: n.id, intent_name: String(props.name || n.id), intent_type: props.intent_type || 'ASK',
          intent_level: 'leaf', parent_intent_id: String(props.parent_intent_id || ''), domain: String(props.domain || ''),
          is_executable_leaf: !!props.is_executable_leaf, is_knowledge_intent: !!props.is_knowledge_intent,
        };
        b.retrieval_profile = { utterance_view: [], object_view: [], action_view: [] };
        b.task_binding = {};
        b.execution_binding = { route_type: '', standard_navigation_path: '' };
        return b;
      })();
      const raw = mergePaths(base, props, INTENT_FIELD_PATHS);
      if (raw.identity) raw.identity.intent_id = n.id;
      intent_nodes.push(raw);
    } else {
      const def = SUPPORTING_DEFS[n.type];
      if (!def) return; // 未知类型不导出（report 由调用方统计）
      const name = String(props.name || n.id);
      const base = n.raw && typeof n.raw === 'object' ? n.raw : {};
      if (!base[def.id]) base[def.id] = n.id;
      Object.keys(def.fields).forEach(function (key) {
        if (key in props) base[def.fields[key]] = props[key];
      });
      supporting[def.collection].push(base);
    }
  });

  const edges = (document.edges || []).map(function (e) {
    const base = e.raw && typeof e.raw === 'object' ? Object.assign({}, e.raw) : {};
    base.edge_id = e.id;
    base.from = e.source;
    base.to = e.target;
    base.type = e.type;
    const props = e.properties || {};
    EDGE_FIELD_KEYS.forEach(function (key) {
      if (key in props) base[key] = props[key];
    });
    return base;
  });

  return { aggregate_intents: aggregate_intents, intent_nodes: intent_nodes, supporting_nodes: supporting, edges: edges };
}

module.exports = {
  convertIntentV21: convertIntentV21,
  exportIntentV21: exportIntentV21,
  INTENT_FIELD_PATHS: INTENT_FIELD_PATHS,
  AGGREGATE_FIELD_PATHS: AGGREGATE_FIELD_PATHS,
  SUPPORTING_DEFS: SUPPORTING_DEFS,
  EDGE_FIELD_KEYS: EDGE_FIELD_KEYS,
};

// 自检：node tools/graph-importers/intent-v21.js
if (require.main === module) {
  var sample = {
    aggregate_intents: [{ intent_id: 'a1', intent_name: '转账汇款', intent_level: 'aggregate', domain: '转账服务', semantic_definition: { user_goal: '办理转账' } }],
    intent_nodes: [{ identity: { intent_id: 'i1', intent_name: '行内转账', intent_type: 'DO', parent_intent_id: 'a1', domain: '转账服务' }, semantic_definition: { user_goal: '向本行账户转账' } }],
    supporting_nodes: { business_objects: [], actions: [], slots: [], states: [], risks: [], knowledge_answers: [], runtime_boundaries: [] },
    edges: [{ edge_id: 'e1', from: 'a1', to: 'i1', type: 'has_leaf_intent', relation_category: 'hierarchy' }],
  };
  var tpl = { template_id: 'intent-graph', template_version: '1.1.0' };
  var out = convertIntentV21(sample, tpl, { sourceLabel: 'sample' });
  console.log(JSON.stringify(out.document.nodes, null, 1));
  console.log('edges:', out.document.edges.length, 'report:', JSON.stringify(out.report));
  var back = exportIntentV21(out.document);
  console.log('roundtrip intent_type:', back.intent_nodes[0].identity.intent_type);
}
