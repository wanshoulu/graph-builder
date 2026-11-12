'use strict';

/**
 * 图谱质检报告 + 缺口填充 — 确定性纯函数（无 LLM 逻辑仅 buildFillPrompt/parseFillResponse）
 *
 * 供 routes/org-graph.js（前端 REST）与 routes/graph-builder-tools.js（Agent 工具）共用。
 *
 *   buildQualityReport(document, template, assetDef) → 三维质检报告（schema 合规 / 模板覆盖 / 内容质量）
 *   collectFillGaps(document, template, cap)         → 待填充缺口（占位符 + 空必填字段）
 *   buildFillPrompt(gaps, template, sourceText)      → 原文取证填充 prompt（缺口 ≤ cap 由调用方保证）
 *   parseFillResponse(text)                          → 解析 LLM fills 输出
 *   applyFills(document, fills, template)            → 白名单式填充应用（纯函数，不改入参）
 */

var fs = require('fs');
var { validateGraph } = require('./x6-graph-template-validator');
var { deterministicAudit } = require('./graph-audit');

// ── 占位符判定（与前端 deepAgent「待补充」约定对齐） ──

var PLACEHOLDER_TOKENS = ['待补充', '待定', 'todo', 'tbd', '占位'];

function isPlaceholderValue(value) {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') {
    var v = value.trim();
    if (!v) return true;
    var lower = v.toLowerCase();
    return PLACEHOLDER_TOKENS.some(function (t) { return lower === t; });
  }
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

// ── 质检报告 ──

function scoreFromPenalty(base, penalty) {
  return Math.max(0, Math.round(base - penalty));
}

/**
 * 三维质检（确定性，不发 LLM）：
 *   schema   必填/类型/端点等校验错误（资产校验器 + X6 模板校验器双关）
 *   coverage 模板声明的节点/关系类型覆盖率
 *   content  确定性质检发现（孤立/重复/命名等）+ 占位符字段
 * 总分 = schema*0.4 + content*0.35 + coverage*0.25（schema 是发布门禁，权重最高）
 */
function buildQualityReport(document, template, assetDef) {
  var nodes = Array.isArray(document && document.nodes) ? document.nodes : [];
  var edges = Array.isArray(document && document.edges) ? document.edges : [];
  var nodeTypes = (template && template.node_types) || [];
  var edgeTypes = (template && template.edge_types) || [];

  // ── schema 维度：双关校验错误 ──
  var schemaErrors = [];
  if (assetDef && typeof assetDef.validateDocument === 'function') {
    try {
      var assetReport = assetDef.validateDocument(document);
      if (assetReport && Array.isArray(assetReport.errors)) {
        assetReport.errors.forEach(function (e) {
          schemaErrors.push(typeof e === 'string' ? e : (e.message || JSON.stringify(e)));
        });
      }
    } catch (e) { schemaErrors.push('资产校验器执行失败：' + e.message); }
  }
  if (template) {
    try {
      var tmplReport = validateGraph(template, document);
      if (tmplReport && Array.isArray(tmplReport.errors)) {
        tmplReport.errors.forEach(function (e) {
          schemaErrors.push(typeof e === 'string' ? e : (e.message || JSON.stringify(e)));
        });
      }
    } catch (e) { schemaErrors.push('模板校验器执行失败：' + e.message); }
  }
  var schemaScore = schemaErrors.length === 0 ? 100 : scoreFromPenalty(100, schemaErrors.length * 12);

  // ── coverage 维度：声明类型覆盖 ──
  var nodeCountByType = {};
  var edgeCountByType = {};
  nodes.forEach(function (n) {
    var t = String(n.type || '');
    nodeCountByType[t] = (nodeCountByType[t] || 0) + 1;
  });
  edges.forEach(function (e) {
    var t = String(e.type || '');
    edgeCountByType[t] = (edgeCountByType[t] || 0) + 1;
  });
  var nodeTypeStats = nodeTypes.map(function (t) {
    return { type: t.type, label: t.label || t.type, count: nodeCountByType[t.type] || 0 };
  });
  var edgeTypeStats = edgeTypes.map(function (t) {
    return { type: t.type, label: t.label || t.type, count: edgeCountByType[t.type] || 0 };
  });
  var missingNodeTypes = nodeTypeStats.filter(function (s) { return s.count === 0; });
  var missingEdgeTypes = edgeTypeStats.filter(function (s) { return s.count === 0; });
  var nodeCoverage = nodeTypes.length ? (nodeTypes.length - missingNodeTypes.length) / nodeTypes.length : 1;
  var edgeCoverage = edgeTypes.length ? (edgeTypes.length - missingEdgeTypes.length) / edgeTypes.length : 1;
  var coverageScore = Math.round(((nodeCoverage + edgeCoverage) / 2) * 100);

  // ── content 维度：确定性发现 + 占位符 ──
  var findings = [];
  if (template) {
    try { findings = deterministicAudit(document, template) || []; } catch (e) { /* 质检器失败不阻断评分，计入 items */ }
  }
  var fieldsByType = {};
  nodeTypes.forEach(function (t) {
    fieldsByType[t.type] = t.fields || [];
  });
  var placeholders = [];
  nodes.forEach(function (n) {
    var fields = fieldsByType[n.type] || [];
    fields.forEach(function (f) {
      if (!f.required) return;
      var value = n.properties ? n.properties[f.key] : undefined;
      if (isPlaceholderValue(value)) {
        placeholders.push({
          nodeId: n.id,
          nodeType: n.type,
          field: f.key,
          fieldLabel: f.label || f.key,
          current: value === undefined || value === null ? '' : String(value),
        });
      }
    });
  });

  // ── 意图图谱专属内容质量检查（playbook 经验） ──
  var intentQualityItems = [];
  var intentNodesQ = nodes.filter(function (n) { return n.type === 'INTENT'; });

  // (a) 操作家族覆盖：含办理/管理属性的意图必须包含操作型说法
  var OP_PATTERNS = ['怎么开通', '怎么办理', '怎么申请', '怎么设置', '怎么取消', '怎么关闭', '如何开通', '如何办理', '如何申请', '如何设置', '如何取消'];
  intentNodesQ.forEach(function (n) {
    var p = n.properties || {};
    var intentType = String(p.intent_type || '');
    if (intentType === 'DO' || intentType === 'CHANGE' || intentType === 'CANCEL') {
      var utts = Array.isArray(p.utterance_view) ? p.utterance_view : [];
      var hasOp = utts.some(function (u) { return OP_PATTERNS.some(function (pat) { return String(u).indexOf(pat) >= 0; }); });
      if (!hasOp && utts.length > 0) {
        intentQualityItems.push({
          severity: 'warning',
          message: '意图 ' + (p.name || n.id) + '（' + intentType + '类）缺少操作型说法（怎么开通/怎么办理/怎么申请等），utterance_view 全是查询态',
        });
      }
    }
  });

  // (b) 描述唯一性：跨意图描述重复会稀释向量空间
  var descMap = {};
  intentNodesQ.forEach(function (n) {
    var desc = String((n.properties && n.properties.description) || '').trim();
    if (!desc) return;
    if (!descMap[desc]) descMap[desc] = [];
    descMap[desc].push(n.id);
  });
  Object.keys(descMap).forEach(function (desc) {
    if (descMap[desc].length > 1) {
      intentQualityItems.push({
        severity: 'warning',
        message: '描述跨意图重复（稀释向量空间）：「' + desc.slice(0, 30) + '...」→ ' + descMap[desc].join(', '),
      });
    }
  });

  // (c) 跨意图说法去重：同一说法被多个意图认领
  var uttMap = {};
  intentNodesQ.forEach(function (n) {
    var utts = (n.properties && n.properties.utterance_view) || [];
    if (!Array.isArray(utts)) return;
    utts.forEach(function (u) {
      var key = String(u).trim();
      if (!key) return;
      if (!uttMap[key]) uttMap[key] = [];
      if (uttMap[key].indexOf(n.id) < 0) uttMap[key].push(n.id);
    });
  });
  var ambiguousCount = Object.keys(uttMap).filter(function (k) { return uttMap[k].length > 1; }).length;
  if (ambiguousCount > 0) {
    intentQualityItems.push({
      severity: 'warning',
      message: '跨意图重复说法（歧义）：' + ambiguousCount + ' 条说法同时出现在多个意图下，应全部丢弃',
    });
  }

  // (d) V4.1 功能节点×场景制内容质量（intent-graph-v4 资产门控；旧 intent-graph 走上面的 (a)(b)(c)）
  var isV4Doc = !!(document.template_ref && document.template_ref.template_id === 'intent-graph-v4');
  var v4QualityItems = [];
  if (isV4Doc) {
    var v4Reg = (document.metadata && document.metadata.v4ResourceRegistries) || {};
    var leafNodesV4 = nodes.filter(function (n) { return n.type === 'LEAF'; });
    var noSceneLeaves = 0;
    var sceneCountV4 = 0;
    var aliasCountsV4 = [];
    nodes.forEach(function (n) {
      var raw = String((n.properties && n.properties.scenes) || '').trim();
      if (!raw) {
        if (n.type === 'LEAF') noSceneLeaves += 1;
        return;
      }
      try {
        var scenes = JSON.parse(raw);
        if (Array.isArray(scenes)) {
          sceneCountV4 += scenes.length;
          scenes.forEach(function (s) {
            var al = (s && s.retrieval_profile && s.retrieval_profile.aliases) || [];
            if (Array.isArray(al)) aliasCountsV4.push(al.length);
            var neg = (s && s.retrieval_profile && s.retrieval_profile.negativeExamples) || [];
            if (!Array.isArray(neg) || neg.length < 2) {
              v4QualityItems.push({
                severity: 'warning',
                message: '节点 ' + n.id + ' 场景「' + ((s && s.scene_type) || '?') + '」负例不足 2 条（同功能场景间互配负例）',
              });
            }
          });
        }
      } catch (e) { /* scenes 解析失败由资产校验器报 error，质检维度跳过 */ }
    });
    if (leafNodesV4.length > 0 && noSceneLeaves === leafNodesV4.length) {
      v4QualityItems.push({
        severity: 'warning',
        message: '全部 ' + leafNodesV4.length + ' 个叶子功能均未声明场景：业务功能应以「功能 × 场景」表达（schema 文档 8.2）',
      });
    }
    var thinAliasCount = aliasCountsV4.filter(function (c) { return c < 8; }).length;
    if (sceneCountV4 > 0 && thinAliasCount > 0) {
      v4QualityItems.push({
        severity: 'warning',
        message: thinAliasCount + '/' + sceneCountV4 + ' 个场景别名少于 8 条（建议 8~16 条，覆盖不同词群和操作态）',
      });
    }
    ['capabilities', 'faqs', 'policies'].forEach(function (table) {
      if (!Array.isArray(v4Reg[table]) || v4Reg[table].length === 0) {
        v4QualityItems.push({
          severity: 'warning',
          message: '资源注册表 ' + table + ' 为空：场景引用将无注册项可对（校验第 9 条悬空引用）',
        });
      }
    });
  }
  var qualityItems = isV4Doc ? v4QualityItems : intentQualityItems;

  var contentScore = scoreFromPenalty(100, findings.length * 8 + placeholders.length * 6 + qualityItems.length * 4);

  var schemaWeight = 0.4; var contentWeight = 0.35; var coverageWeight = 0.25;
  var overall = Math.round(schemaScore * schemaWeight + contentScore * contentWeight + coverageScore * coverageWeight);
  var grade = overall >= 90 ? '优秀' : overall >= 75 ? '良好' : overall >= 60 ? '及格' : '需改进';

  return {
    summary: {
      score: overall,
      grade: grade,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      errorCount: schemaErrors.length,
      findingCount: findings.length,
      placeholderCount: placeholders.length,
      intentQualityCount: qualityItems.length,
    },
    dimensions: [
      {
        key: 'schema', label: 'Schema 合规', score: schemaScore, weight: schemaWeight,
        items: schemaErrors.length
          ? schemaErrors.slice(0, 30).map(function (m) { return { severity: 'error', message: m }; })
          : [{ severity: 'ok', message: '双关校验通过，无 schema 错误' }],
      },
      {
        key: 'coverage', label: '模板覆盖', score: coverageScore, weight: coverageWeight,
        items: (missingNodeTypes.length === 0 && missingEdgeTypes.length === 0)
          ? [{ severity: 'ok', message: '模板声明的节点与关系类型均已覆盖' }]
          : missingNodeTypes.map(function (s) {
              return { severity: 'warning', message: '节点类型 ' + s.label + '（' + s.type + '）覆盖数为 0' };
            }).concat(missingEdgeTypes.map(function (s) {
              return { severity: 'warning', message: '关系类型 ' + s.label + '（' + s.type + '）覆盖数为 0' };
            })),
      },
      {
        key: 'content', label: '内容质量', score: contentScore, weight: contentWeight,
        items: (findings.length === 0 && placeholders.length === 0 && qualityItems.length === 0)
          ? [{ severity: 'ok', message: '无孤立/重复等结构问题，无占位符字段，意图图谱专属检查通过' }]
          : findings.map(function (f) {
              return { severity: f.severity || 'medium', message: (f.issue || f.category || '') + (f.suggestion ? '（建议：' + f.suggestion + '）' : '') };
            }).concat(placeholders.slice(0, 30).map(function (p) {
              return { severity: 'warning', message: '节点 ' + p.nodeId + ' 必填字段 ' + p.fieldLabel + ' 为占位/空值' };
            })).concat(qualityItems.slice(0, 20)),
      },
    ],
    coverage: {
      nodeTypes: nodeTypeStats,
      edgeTypes: edgeTypeStats,
      missingNodeTypes: missingNodeTypes.map(function (s) { return s.type; }),
      missingEdgeTypes: missingEdgeTypes.map(function (s) { return s.type; }),
    },
    placeholders: placeholders,
  };
}

// ── 缺口收集 + LLM 填充 ──

function nodeLabelOf(node) {
  var p = (node && node.properties) || {};
  return String(p.name || p.title || p.goal || node.id || '');
}

/** 占位符 + 空必填字段 → 填充缺口清单（cap 防止 prompt 膨胀） */
function collectFillGaps(document, template, cap) {
  var limit = cap || 40;
  var nodeTypes = (template && template.node_types) || [];
  var fieldsByType = {};
  nodeTypes.forEach(function (t) { fieldsByType[t.type] = t.fields || []; });
  var gaps = [];
  var nodes = Array.isArray(document && document.nodes) ? document.nodes : [];
  for (var i = 0; i < nodes.length && gaps.length < limit; i++) {
    var n = nodes[i];
    var fields = fieldsByType[n.type] || [];
    for (var j = 0; j < fields.length && gaps.length < limit; j++) {
      var f = fields[j];
      if (!f.required) continue;
      var value = n.properties ? n.properties[f.key] : undefined;
      if (isPlaceholderValue(value)) {
        gaps.push({
          nodeId: n.id,
          nodeType: n.type,
          nodeLabel: nodeLabelOf(n),
          field: f.key,
          fieldLabel: f.label || f.key,
          fieldType: f.type || 'string',
          current: value === undefined || value === null ? '' : String(value),
        });
      }
    }
  }
  return gaps;
}

/** 原文取证填充 prompt：只允许从 sourceText 取证，不允许编造（无证据则跳过该缺口） */
function buildFillPrompt(gaps, template, sourceText) {
  var lines = [];
  lines.push('任务：为知识图谱节点的缺失/占位字段补全。只能依据下方「来源材料」取证填写，材料中没有依据的字段直接跳过（不要编造）。');
  lines.push('');
  lines.push('图谱 schema（节点类型 → 字段）：');
  var mentionedTypes = {};
  gaps.forEach(function (g) {
    if (mentionedTypes[g.nodeType]) return;
    mentionedTypes[g.nodeType] = true;
    var t = ((template && template.node_types) || []).find(function (x) { return x.type === g.nodeType; });
    var fields = (t && t.fields) || [];
    lines.push('- ' + g.nodeType + '：' + fields.map(function (f) { return f.key + '(' + (f.required ? '必填' : '可选') + ')'; }).join(', '));
  });
  lines.push('');
  lines.push('待填充缺口（' + gaps.length + ' 个）：');
  gaps.forEach(function (g, i) {
    lines.push((i + 1) + '. nodeId=' + g.nodeId + ' | type=' + g.nodeType + ' | field=' + g.field + '（' + g.fieldLabel + '，' + g.fieldType + '） | 当前值=' + JSON.stringify(g.current) + ' | 节点名=' + g.nodeLabel);
  });
  lines.push('');
  lines.push('来源材料（唯一取证依据）：');
  lines.push(String(sourceText || '').slice(0, 30000));
  lines.push('');
  lines.push('输出单个合法 JSON 对象（不要 markdown 围栏）：');
  lines.push(JSON.stringify({
    fills: [
      { nodeId: '缺口中的 nodeId', field: '缺口中的 field', value: '依据材料填写的值（数组型字段用换行分隔多项）', evidence: '来源材料中的原句依据（≤80 字）' },
    ],
  }));
  lines.push('fills 只包含有材料依据的缺口；无依据的缺口不要出现在输出中。');
  return lines.join('\n');
}

/** 解析 LLM fills 输出（容错：围栏 / 顶层数组 / fills 键） */
function parseFillResponse(text) {
  var jsonStr = String(text || '').trim();
  var fence = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) jsonStr = fence[1].trim();
  var parsed = null;
  try { parsed = JSON.parse(jsonStr); } catch (e) { /* 整体解析失败 → 大括号切片兜底 */ }
  if (parsed === null) {
    var start = jsonStr.indexOf('{');
    var end = jsonStr.lastIndexOf('}');
    if (start < 0 || end <= start) return [];
    try { parsed = JSON.parse(jsonStr.slice(start, end + 1)); } catch (e) { return []; }
  }
  var fills = parsed && Array.isArray(parsed.fills) ? parsed.fills : (Array.isArray(parsed) ? parsed : []);
  return fills.filter(function (f) { return f && typeof f === 'object' && f.nodeId && f.field; });
}

/** 白名单式填充：节点存在 + 字段在模板声明 + 当前值为占位/空 + 新值非空才应用；数组型字段按换行/分号切分 */
function applyFills(document, fills, template) {
  var fieldsByType = {};
  ((template && template.node_types) || []).forEach(function (t) {
    fieldsByType[t.type] = {};
    (t.fields || []).forEach(function (f) { fieldsByType[t.type][f.key] = f; });
  });
  var nodeIndex = {};
  (document.nodes || []).forEach(function (n) { nodeIndex[n.id] = n; });

  var applied = [];
  var rejected = [];
  var nodes = document.nodes.map(function (n) { return { ...n, properties: { ...n.properties } }; });
  var indexById = {};
  nodes.forEach(function (n) { indexById[n.id] = n; });
  void nodeIndex;

  (Array.isArray(fills) ? fills : []).forEach(function (fill) {
    var nodeId = String(fill.nodeId || '');
    var field = String(fill.field || '');
    var reason = null;
    var before;
    var node = indexById[nodeId];
    if (!node) reason = '节点不存在';
    else if (!fieldsByType[node.type] || !fieldsByType[node.type][field]) reason = '字段 ' + field + ' 未在模板类型 ' + node.type + ' 中声明';
    else if (!isPlaceholderValue(node.properties[field])) reason = '字段已有非占位值，拒绝覆盖';
    else {
      before = node.properties[field];
      var raw = fill.value;
      if (raw === undefined || raw === null) reason = '填充值为空';
      else if (Array.isArray(raw)) {
        var arr = raw.map(function (x) { return String(x).trim(); }).filter(Boolean);
        if (!arr.length) reason = '填充值为空';
        else node.properties[field] = arr;
      } else {
        var str = String(raw).trim();
        if (!str || PLACEHOLDER_TOKENS.indexOf(str.toLowerCase()) >= 0) reason = '填充值为空或仍是占位符';
        else if (['multi_enum', 'tags'].indexOf((fieldsByType[node.type][field].type || '')) >= 0) {
          node.properties[field] = str.split(/\n+|；|;/).map(function (s) { return s.trim(); }).filter(Boolean);
        } else node.properties[field] = str;
      }
    }
    if (reason) {
      rejected.push({ nodeId: nodeId, field: field, reason: reason });
      return;
    }
    applied.push({
      nodeId: nodeId,
      nodeType: node.type,
      nodeLabel: nodeLabelOf(node),
      field: field,
      before: before === undefined || before === null ? '' : String(before),
      value: node.properties[field],
      evidence: String(fill.evidence || '').slice(0, 200),
    });
  });

  return { document: { ...document, nodes: nodes }, applied: applied, rejected: rejected };
}

// ── 确定性实体消解（零 LLM）──

// 只剥「软」尾标点，不含闭合括号：`（新版）！` 剥后为 `(新版)`，与 `（新版）` 归一到同一名字
var TRAILING_PUNCT = /[。．.、,，;；：:！!？?~～_\-·•\s]+$/;

function normalizeNodeName(raw) {
  var s = String(raw == null ? '' : raw);
  var out = '';
  for (var i = 0; i < s.length; i++) {
    var code = s.charCodeAt(i);
    if (code === 0x3000) { out += ' '; continue; }
    if (code >= 0xff01 && code <= 0xff5e) { out += String.fromCharCode(code - 0xfee0); continue; }
    out += s[i];
  }
  return out.replace(/\s+/g, ' ').trim().replace(TRAILING_PUNCT, '').trim().toLowerCase();
}

function propertyCount(node) {
  var p = (node && node.properties) || {};
  var n = 0;
  for (var k in p) { if (p[k] !== null && p[k] !== undefined && String(p[k]).trim() !== '') n++; }
  return n;
}

/** 同类型 + 归一化同名 → 合并到信息量最大的节点；边重定向、去自环、去重边 */
function resolveDuplicateNodes(document, template) {
  var nodes = Array.isArray(document && document.nodes) ? document.nodes.slice() : [];
  var edges = Array.isArray(document.edges) ? document.edges.slice() : [];
  var validTypes = {};
  ((template && template.node_types) || []).forEach(function (t) { validTypes[t.type] = true; });

  var groups = {};
  var order = [];
  var unknownTypeNodes = [];
  nodes.forEach(function (n, idx) {
    if (!n || !n.id) return;
    var name = normalizeNodeName(nodeLabelOf(n));
    if (!name) return;
    // 模板外类型不参与消解（避免误合并不该合并的节点），但显式统计并警告——
    // 静默跳过会让 LLM 抽取的类型漂移（如 LEAF_INTENT vs INTENT）看起来"没有重复"
    if (template && n.type && validTypes[n.type] !== true) { unknownTypeNodes.push(n); return; }
    var key = String(n.type || '_') + '::' + name;
    if (!groups[key]) { groups[key] = []; order.push(key); }
    groups[key].push(idx);
  });

  var unknownWarnings = [];
  if (template && unknownTypeNodes.length > 0) {
    var unknownTypes = Array.from(new Set(unknownTypeNodes.map(function (n) { return String(n.type); })));
    unknownWarnings.push(unknownTypeNodes.length + ' 个节点类型（' + unknownTypes.join(', ') + '）不在当前模板中，未参与消解；类型漂移常来自 LLM 抽取，建议先校对节点类型');
  }

  var keepOf = {};
  var merges = [];
  var multiGroups = 0;
  order.forEach(function (key) {
    var idxs = groups[key];
    if (idxs.length < 2) return;
    multiGroups++;
    var sorted = idxs.slice().sort(function (a, b) {
      var d = propertyCount(nodes[b]) - propertyCount(nodes[a]);
      if (d !== 0) return d;
      return a - b;
    });
    var keepIdx = sorted[0];
    var kept = nodes[keepIdx];
    idxs.forEach(function (i) {
      if (i === keepIdx) return;
      var dropped = nodes[i];
      var kp = kept.properties = kept.properties || {};
      var dp = dropped.properties || {};
      for (var k in dp) {
        if (kp[k] === undefined || kp[k] === null || String(kp[k]).trim() === '') kp[k] = dp[k];
      }
      keepOf[dropped.id] = kept.id;
      merges.push({ keptId: kept.id, keptName: nodeLabelOf(kept), droppedId: dropped.id, droppedName: nodeLabelOf(dropped), type: dropped.type || '_' });
    });
  });

  if (merges.length > 0) {
    nodes = nodes.filter(function (n) { return !keepOf[n.id]; });
    var seen = {};
    var keptEdges = [];
    var movedEdges = 0;
    var droppedEdges = 0;
    edges.forEach(function (e) {
      if (!e) return;
      var src = keepOf[e.source] || e.source;
      var tgt = keepOf[e.target] || e.target;
      if (src !== e.source || tgt !== e.target) movedEdges++;
      if (src === tgt) { droppedEdges++; return; }
      var ek = String(src) + '|' + String(tgt) + '|' + String(e.type || '');
      if (seen[ek]) { droppedEdges++; return; }
      seen[ek] = true;
      keptEdges.push({ ...e, source: src, target: tgt });
    });
    return {
      document: { ...document, nodes: nodes, edges: keptEdges },
      merges: merges,
      stats: { groups: multiGroups, mergedNodes: merges.length, movedEdges: movedEdges, droppedEdges: droppedEdges },
      warnings: unknownWarnings,
    };
  }
  return { document: document, merges: [], stats: { groups: 0, mergedNodes: 0, movedEdges: 0, droppedEdges: 0 }, warnings: unknownWarnings };
}

module.exports = {
  isPlaceholderValue: isPlaceholderValue,
  buildQualityReport: buildQualityReport,
  collectFillGaps: collectFillGaps,
  buildFillPrompt: buildFillPrompt,
  parseFillResponse: parseFillResponse,
  applyFills: applyFills,
  normalizeNodeName: normalizeNodeName,
  resolveDuplicateNodes: resolveDuplicateNodes,
};
