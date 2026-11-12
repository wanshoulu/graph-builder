/**
 * 意图图谱开发工具 — API 路由（专家手工建模）
 *
 * 端点：
 *   GET  /api/intent-graph/versions  — 列出版本列表
 *   POST /api/intent-graph/load      — 加载指定版本图谱
 *   POST /api/intent-graph/export    — 导出为新批次版本
 *   GET  /api/intent-graph/schema    — 返回 Schema 定义（枚举值、边类型、必填字段）
 *   POST /api/intent-graph/validate  — Schema 校验
 */

'use strict';

const path = require('path');
const fs = require('fs');

const GRAPHS_DIR  = path.join(__dirname, '../data/graphs');
const MANIFEST    = path.join(GRAPHS_DIR, 'intent-graph-version-manifest.json');

// ── Schema 常量（统一来源：tools/intent-graph-schema.js，对齐 intent-graph-v2-schema.json 与模板 v1.5.0）──

const schema = require('../tools/intent-graph-schema');
const INTENT_TYPES     = schema.INTENT_TYPES;
const INTENT_LEVELS    = schema.INTENT_LEVELS;
const DOMAINS          = schema.DOMAINS;
const NODE_TYPES       = schema.NODE_TYPES;
const EDGE_TYPES       = schema.EDGE_TYPES;
const ACTION_CODES     = schema.ACTION_CODES;
const REQUIRED_IDENTITY = schema.REQUIRED_IDENTITY;
const REQUIRED_SEMANTIC = schema.REQUIRED_SEMANTIC;

// ── Helpers ──

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
  return new Promise(function(resolve) {
    var body = '';
    req.on('data', function(c) { body += c; });
    req.on('end', function() {
      try { resolve(body ? JSON.parse(body) : {}); } catch(e) { resolve({}); }
    });
  });
}

// ── 扫描可用版本 ──

function listVersions() {
  var versions = [];
  if (!fs.existsSync(GRAPHS_DIR)) return versions;

  var seen = {};
  var files = fs.readdirSync(GRAPHS_DIR);
  files.forEach(function(f) {
    var m = f.match(/^intent-graph-v2\.1-p([12])-batch(\d+)(-pruned|-safe)?\.json$/);
    if (!m) return;
    // 排重（同批次取不带后缀的基础版本；键含 phase，避免 p1/p2 同批次互相遮蔽）
    var phase = m[1];
    var batchNum = parseInt(m[2], 10);
    var suffix = m[3] || '';
    var key = 'p' + phase + '-batch' + batchNum;
    if (!seen[key] || (suffix === '' && seen[key].suffix !== '')) {
      var stat = fs.statSync(path.join(GRAPHS_DIR, f));
      seen[key] = {
        version: 'intent-graph-v2.1-p' + phase + '-batch' + batchNum + (suffix ? '-' + suffix : ''),
        file: f,
        size: stat.size,
        updated: stat.mtime.toISOString(),
        suffix: suffix,
      };
    }
  });

  // 按 batch 号排序（键形如 p1-batch10）
  Object.keys(seen).sort(function(a, b) {
    return parseInt(a.replace(/.*batch/, ''), 10) - parseInt(b.replace(/.*batch/, ''), 10);
  }).forEach(function(k) {
    var v = seen[k];
    // 跳过 -graph 可视化文件
    if (v.file.indexOf('-graph.json') >= 0) return;
    versions.push({ version: v.version, file: v.file, size: v.size, updated: v.updated });
  });

  // 加 manifest 中的 active default
  try {
    var mf = JSON.parse(fs.readFileSync(MANIFEST, 'utf-8'));
    versions.forEach(function(v) {
      (mf.versions || []).forEach(function(mv) {
        if (v.file === path.basename(mv.graph_file || '')) {
          v.stage = mv.stage;
          v.status = mv.status;
          v.changes = mv.changes;
        }
      });
    });
  } catch(e) {}

  return versions;
}

// ── 加载图谱 ──

function loadGraph(versionId) {
  // 支持按版本 ID 或文件名加载
  var candidates = [];
  if (fs.existsSync(GRAPHS_DIR)) {
    fs.readdirSync(GRAPHS_DIR).forEach(function(f) {
      if (f.endsWith('.json') && f.indexOf('intent-graph-v2.1') >= 0 && f.indexOf('-graph.json') < 0) {
        candidates.push(f);
      }
    });
  }

  var target = null;
  candidates.forEach(function(f) {
    var id = f.replace('.json', '');
    if (id === versionId || f === versionId) {
      // 优先匹配精确版本，其次最新 batch
      if (!target || f.length < target.length) target = f;
    }
  });

  if (!target) {
    // 回退到 manifest active default
    try {
      var mf = JSON.parse(fs.readFileSync(MANIFEST, 'utf-8'));
      var active = mf.active_default;
      if (active) {
        candidates.forEach(function(f) {
          if (f.indexOf(active) >= 0 && f.indexOf('-graph.json') < 0) target = f;
        });
      }
    } catch(e) {}
  }

  if (!target) {
    // 最终回退：找最新 batch 文件
    var maxBatch = 0;
    candidates.forEach(function(f) {
      var m = f.match(/batch(\d+)/);
      if (m) {
        var n = parseInt(m[1], 10);
        if (n > maxBatch) { maxBatch = n; target = f; }
      }
    });
  }

  if (!target) throw new Error('No graph version found');

  var raw = fs.readFileSync(path.join(GRAPHS_DIR, target), 'utf-8');
  return JSON.parse(raw);
}

// ── Main dispatcher ──

function handleIntentGraphEditorRequest(req, res) {
  var url;
  try { url = new URL(req.url, 'http://' + (req.headers.host || 'localhost')); } catch(e) { return false; }
  var pathname = url.pathname;
  var method = req.method;

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return true;
  }

  if (!pathname.startsWith('/api/intent-graph/')) return false;

  // GET /api/intent-graph/versions
  if (method === 'GET' && pathname === '/api/intent-graph/versions') {
    try {
      var versions = listVersions();
      sendJSON(res, 200, { success: true, versions: versions });
    } catch(e) { sendJSON(res, 500, { error: e.message }); }
    return true;
  }

  // POST /api/intent-graph/create — 新建空白图谱
  if (method === 'POST' && pathname === '/api/intent-graph/create') {
    parseBody(req).then(function(body) {
      var version = body.version || 'intent-graph-v2.1-p2-batch1';
      var graph = createBlankGraph(version);
      sendJSON(res, 200, { success: true, graph: graph });
    }).catch(function(e) { sendJSON(res, 500, { error: e.message }); });
    return true;
  }

  // POST /api/intent-graph/load
  if (method === 'POST' && pathname === '/api/intent-graph/load') {
    parseBody(req).then(function(body) {
      try {
        var version = body.version || 'batch10';
        var graph = loadGraph(version);
        sendJSON(res, 200, { success: true, graph: graph });
      } catch(e) { sendJSON(res, 500, { error: e.message }); }
    }).catch(function(e) { sendJSON(res, 500, { error: e.message }); });
    return true;
  }

  // GET /api/intent-graph/schema
  if (method === 'GET' && pathname === '/api/intent-graph/schema') {
    // 模板（builder 链路 schema 权威）↔ v2 常量（editor/autobuild/评测链路）漂移检测
    var alignment = schema.checkTemplateAlignment();
    sendJSON(res, 200, {
      intent_types: INTENT_TYPES,
      intent_levels: INTENT_LEVELS,
      domains: DOMAINS,
      node_types: NODE_TYPES,
      edge_types: EDGE_TYPES,
      action_codes: ACTION_CODES,
      required_identity: REQUIRED_IDENTITY,
      required_semantic: REQUIRED_SEMANTIC,
      type_mapping: { template_to_v2: schema.TEMPLATE_TO_V2, v2_to_template: schema.V2_TO_TEMPLATE },
      template_alignment: {
        ok: alignment.ok,
        issues: alignment.issues,
        template_node_types: alignment.templateNodeTypes,
        template_edge_types: alignment.templateEdgeTypes,
      },
    });
    return true;
  }

  // POST /api/intent-graph/validate
  if (method === 'POST' && pathname === '/api/intent-graph/validate') {
    parseBody(req).then(function(body) {
      var graph = body.graph;
      if (!graph) { sendJSON(res, 400, { error: 'Missing graph' }); return; }
      var errors = validateGraph(graph);
      var modeling = validateModelingGraph(graph);
      sendJSON(res, 200, {
        success: errors.length === 0 && modeling.errors.length === 0,
        errors: errors,
        count: errors.length,
        modeling: modeling,
      });
    });
    return true;
  }

  // POST /api/intent-graph/export
  if (method === 'POST' && pathname === '/api/intent-graph/export') {
    parseBody(req).then(function(body) {
      try {
        var graph = body.graph;
        var newVersion = body.version || 'intent-graph-v2.1-p2-batch1';
        if (!graph) { sendJSON(res, 400, { error: 'Missing graph' }); return; }
        // 防路径穿越：版本名只允许字母数字点连字符
        if (!/^[A-Za-z0-9._-]+$/.test(newVersion)) { sendJSON(res, 400, { error: 'Invalid version name' }); return; }

        // 先校验
        var errors = validateGraph(graph);
        var modeling = validateModelingGraph(graph);
        if (errors.length > 0 || modeling.errors.length > 0) {
          sendJSON(res, 400, {
            success: false,
            errors: errors,
            modeling: modeling,
            message: 'Validation failed: ' + (errors.length + modeling.errors.length) + ' errors',
          });
          return;
        }

        // 更新 meta
        if (!graph.meta) graph.meta = {};
        var sourceVersionId = graph.meta.graph_version_id || graph.meta.version || 'unknown';
        var releaseStage = body.release_stage || 'p2_candidate';
        var releaseStatus = body.release_status || 'candidate';
        var shouldPromote = !!body.promote_to_active;
        graph.meta.version = newVersion;
        graph.meta.graph_version_id = newVersion;
        graph.meta.graph_version_name = 'AI Harbor Intent Graph ' + newVersion;
        graph.meta.graph_version_stage = releaseStage;
        graph.meta.release_status = releaseStatus;
        graph.meta.generated_at = new Date().toISOString();
        if (!graph.summary) graph.summary = {};
        graph.summary.leaf_intent_count = (graph.intent_nodes || []).length;
        graph.summary.aggregate_intent_count = (graph.aggregate_intents || []).length;
        graph.summary.edge_count = (graph.edges || []).length;

        // 写文件
        var filePath = path.join(GRAPHS_DIR, newVersion + '.json');
        fs.writeFileSync(filePath, JSON.stringify(graph, null, 2), 'utf-8');

        // 更新 manifest
        try {
          var mf = JSON.parse(fs.readFileSync(MANIFEST, 'utf-8'));
          if (shouldPromote) mf.active_default = newVersion;
          mf.updated_at = new Date().toISOString();
          mf.versions = mf.versions || [];
          // 去重
          mf.versions = mf.versions.filter(function(v) { return v.version_id !== newVersion; });
          mf.versions.push({
            version_id: newVersion,
            version_name: 'AI Harbor Intent Graph ' + newVersion,
            stage: releaseStage,
            status: shouldPromote ? 'active_default' : releaseStatus,
            graph_file: 'data/graphs/' + newVersion + '.json',
            source_version_id: sourceVersionId,
            changes: body.changes || ['Expert manual modeling'],
          });
          fs.writeFileSync(MANIFEST, JSON.stringify(mf, null, 2), 'utf-8');
        } catch(e) { /* manifest update non-fatal */ }

        sendJSON(res, 200, {
          success: true,
          version: newVersion,
          file: filePath,
          stats: {
            intent_nodes: (graph.intent_nodes || []).length,
            aggregate_intents: (graph.aggregate_intents || []).length,
            edges: (graph.edges || []).length,
          },
          release_status: releaseStatus,
        });
      } catch(e) { sendJSON(res, 500, { error: e.message }); }
    }).catch(function(e) { sendJSON(res, 500, { error: e.message }); });
    return true;
  }

  return false;
}

// ── 新建空白图谱 ──

function createBlankGraph(version) {
  var now = new Date().toISOString();
  return {
    meta: {
      name: 'aiharbor_intent_graph_v2',
      version: version,
      graph_version_id: version,
      graph_version_name: 'AI Harbor Intent Graph ' + version,
      graph_version_stage: 'p2_expert_modeling',
      generated_at: now,
      schema_profile: 'ai_harbor_intent_graph_v2',
      schema_version: 'v1.0',
      release_status: 'draft',
    },
    summary: {
      aggregate_intent_count: 0,
      leaf_intent_count: 0,
      executable_intent_count: 0,
      knowledge_intent_count: 0,
      business_object_count: 0,
      action_count: 0,
      edge_count: 0,
      domain_distribution: {},
      action_distribution: {},
      intent_type_distribution: {},
    },
    ontology: {
      runtime_primary_object: 'intent_node',
      node_types: NODE_TYPES,
      edge_types: EDGE_TYPES,
    },
    aggregate_intents: [],
    intent_nodes: [],
    supporting_nodes: {
      business_objects: [],
      actions: [],
      slots: [],
      states: [],
      risks: [],
      knowledge_answers: [],
      runtime_boundaries: [],
    },
    edges: [],
  };
}

function validateModelingGraph(graph) {
  var errors = [];
  var warnings = [];
  var intentNodes = graph.intent_nodes || [];
  var aggIds = {};
  (graph.aggregate_intents || []).forEach(function(n) {
    if (n && n.intent_id) aggIds[n.intent_id] = true;
  });

  intentNodes.forEach(function(n, idx) {
    var prefix = 'intent_nodes[' + idx + ']';
    var id = n.identity || {};
    var name = id.intent_name || id.intent_id || prefix;
    if (!id.parent_intent_id) warnings.push(name + ': leaf intent missing parent aggregate');
    else if (!aggIds[id.parent_intent_id]) warnings.push(name + ': parent aggregate not found in aggregate_intents');

    if (id.intent_type === 'DO' && !n.task_binding) {
      errors.push(name + ': DO leaf missing task_binding');
    }
    if ((id.intent_type === 'ASK' || id.intent_type === 'HELP') && !n.knowledge_binding) {
      warnings.push(name + ': ASK/HELP leaf missing knowledge_binding');
    }
    if (!n.semantic_definition || !(n.semantic_definition.scope_in || []).length) {
      warnings.push(name + ': semantic_definition.scope_in is empty');
    }
    if (!n.retrieval_profile || !(n.retrieval_profile.utterance_view || []).length) {
      warnings.push(name + ': retrieval_profile.utterance_view is empty');
    }
    if (!n.execution_binding || !n.execution_binding.standard_navigation_path) {
      warnings.push(name + ': execution_binding.standard_navigation_path is empty');
    }
  });

  return {
    errors: errors,
    warnings: warnings,
    summaries: [
      'aggregate_intents=' + (graph.aggregate_intents || []).length,
      'intent_nodes=' + intentNodes.length,
      'modeling_errors=' + errors.length,
      'modeling_warnings=' + warnings.length,
    ],
  };
}

// ── Schema 校验 ──

function validateGraph(graph) {
  var errors = [];

  var intentNodes = graph.intent_nodes || [];
  var aggIntents  = graph.aggregate_intents || [];
  var edges       = graph.edges || [];
  var allNodes    = intentNodes.concat(aggIntents);

  // 收集所有 supporting_nodes 的 ID
  var supNodes = graph.supporting_nodes || {};
  var allIds = {};
  allNodes.forEach(function(n) { allIds[n.identity ? n.identity.intent_id : n.intent_id] = true; });
  Object.keys(supNodes).forEach(function(key) {
    var arr = supNodes[key];
    if (!Array.isArray(arr)) return;
    arr.forEach(function(n) {
      if (!n) return;
      var id = n.object_id || n.action_id || n.knowledge_id || n.answer_id || n.slot_id || n.state_id || n.risk_id || n.runtime_boundary_id || n.id;
      if (id) allIds[id] = true;
    });
  });

  // ── 校验 intent_nodes ──
  var seenIds = {};
  intentNodes.forEach(function(n, idx) {
    var id = n.identity;
    var prefix = 'intent_nodes[' + idx + ']';

    if (!id) { errors.push(prefix + ': missing identity'); return; }

    // 必填字段
    REQUIRED_IDENTITY.forEach(function(f) {
      if (id[f] === undefined || id[f] === null || id[f] === '') {
        errors.push(prefix + '.identity.' + f + ': required');
      }
    });

    // intent_type 枚举
    if (id.intent_type && INTENT_TYPES.indexOf(id.intent_type) < 0) {
      errors.push(prefix + '.identity.intent_type: invalid "' + id.intent_type + '", allowed: ' + INTENT_TYPES.join(','));
    }

    // domain 枚举
    if (id.domain && DOMAINS.indexOf(id.domain) < 0) {
      errors.push(prefix + '.identity.domain: invalid "' + id.domain + '", allowed: ' + DOMAINS.join(','));
    }

    // ID 唯一性
    if (id.intent_id) {
      if (seenIds[id.intent_id]) errors.push(prefix + '.identity.intent_id: duplicate "' + id.intent_id + '"');
      seenIds[id.intent_id] = true;
    }

    // semantic_definition
    var sd = n.semantic_definition;
    if (!sd) { errors.push(prefix + ': missing semantic_definition'); }
    else {
      REQUIRED_SEMANTIC.forEach(function(f) {
        var val = sd[f];
        if (val === undefined || val === null || val === '') {
          errors.push(prefix + '.semantic_definition.' + f + ': required');
        }
      });
    }

    // retrieval_profile
    if (!n.retrieval_profile) errors.push(prefix + ': missing retrieval_profile');

    // parent_intent_id 引用完整性
    if (id.parent_intent_id) {
      if (!allIds[id.parent_intent_id] && id.parent_intent_id !== 'root') {
        errors.push(prefix + '.identity.parent_intent_id: "' + id.parent_intent_id + '" not found');
      }
    }

    // task_binding action code
    var tb = n.task_binding;
    if (tb && tb.action && tb.action.action_code) {
      if (ACTION_CODES.indexOf(tb.action.action_code) < 0) {
        errors.push(prefix + '.task_binding.action.action_code: invalid "' + tb.action.action_code + '"');
      }
    }
  });

  // ── 校验 aggregate_intents ──
  aggIntents.forEach(function(n, idx) {
    var prefix = 'aggregate_intents[' + idx + ']';
    if (!n.intent_id) errors.push(prefix + ': missing intent_id');
    if (!n.intent_name) errors.push(prefix + ': missing intent_name');
    if (n.intent_id && seenIds[n.intent_id]) errors.push(prefix + '.intent_id: duplicate "' + n.intent_id + '"');
    if (n.intent_id) seenIds[n.intent_id] = true;
  });

  // ── 校验 edges ──
  var seenEdgeIds = {};
  edges.forEach(function(e, idx) {
    var prefix = 'edges[' + idx + ']';
    if (!e.from && !e.source) errors.push(prefix + ': missing from/source');
    if (!e.to && !e.target) errors.push(prefix + ': missing to/target');
    var type = e.type || e.relation_type;
    if (!type) errors.push(prefix + ': missing type');
    else if (EDGE_TYPES.indexOf(type) < 0) {
      errors.push(prefix + '.type: invalid "' + type + '", allowed: ' + EDGE_TYPES.join(','));
    }
    var from = e.from || e.source;
    var to   = e.to   || e.target;
    if (from && !allIds[from]) errors.push(prefix + '.from: "' + from + '" not found in nodes');
    if (to   && !allIds[to])   errors.push(prefix + '.to: "' + to + '" not found in nodes');
    if (e.edge_id) {
      if (seenEdgeIds[e.edge_id]) errors.push(prefix + '.edge_id: duplicate');
      seenEdgeIds[e.edge_id] = true;
    }
  });

  return errors;
}

module.exports = { handleIntentGraphEditorRequest };
