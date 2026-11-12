/**
 * 图谱质检工具（AI 质检功能核心，纯函数可单测）
 *
 *  - deterministicAudit：确定性规则检查（不发 LLM，O(V+E) 可任意扩规模）
 *  - buildAuditPrompt：小图（≤ nodeCap/edgeCap）单次全量语义审查 prompt
 *  - 分治并行审查（大图）：partitionGraph 按连通片切批 → runPartitionedAudit
 *    有界并发逐批调 LLM → 全局跨批一致性审查 → mergeAuditFindings 去重合并。
 *    每批 ≤ partitionNodeCap 节点（短 prompt 注意力可靠），全量覆盖无采样盲区。
 *  - parseAuditResponse：LLM 输出 → 标准化 finding 数组（围栏剥离 + 字段清洗 + 上限 15）
 *
 * 用法: node tools/graph-audit.js 自检 / require 供 routes 与单测
 */
'use strict';

/** 规模上限。
 *  小图路径：≤ nodeCap/edgeCap 全量入单次 prompt（deepseek-chat 64K 上下文安全）。
 *  大图路径：超限即分治——每批 partitionNodeCap 节点 / partitionEdgeCap 边，
 *  小连通片（≤ smallComponentMax）并入杂批；externalEdgeCap 控制跨批引用边列表；
 *  auditConcurrency 并发批次数；maxFindings 合并后总发现上限。 */
var AUDIT_LIMITS = {
  nodeCap: 1000, edgeCap: 1000, edgeTypeCap: 200,
  partitionNodeCap: 300, partitionEdgeCap: 400,
  smallComponentMax: 8, externalEdgeCap: 80,
  globalNodeListCap: 3000,
  auditConcurrency: 4, maxFindings: 60,
};

/** 确定性规则检查（不发 LLM） */
function deterministicAudit(document, template) {
  var nodes = document.nodes || [];
  var edges = document.edges || [];
  var findings = [];
  var degree = {};
  nodes.forEach(function (n) { degree[n.id] = 0; });
  edges.forEach(function (e) {
    if (degree[e.source] !== undefined) degree[e.source]++;
    if (degree[e.target] !== undefined) degree[e.target]++;
  });

  // 1. 孤立节点（无任何边）
  var orphans = nodes.filter(function (n) { return (degree[n.id] || 0) === 0; });
  if (orphans.length) {
    findings.push({
      severity: 'medium', category: 'orphan_node', node_ids: orphans.map(function (n) { return n.id; }), edge_ids: [],
      issue: '孤立节点：没有任何边连接（' + orphans.length + ' 个）',
      suggestion: '挂到所属聚合/对象，或确认无意义后删除',
    });
  }

  // 2. 同类型同名节点（疑似重复；跨类型同名不算）
  var nameGroups = {};
  nodes.forEach(function (n) {
    var name = String((n.properties && (n.properties.name || n.properties.title)) || '').trim();
    if (!name) return;
    var key = n.type + '||' + name;
    (nameGroups[key] = nameGroups[key] || []).push(n.id);
  });
  Object.keys(nameGroups).forEach(function (key) {
    var ids = nameGroups[key];
    if (ids.length > 1) {
      findings.push({
        severity: 'medium', category: 'duplicate_nodes', node_ids: ids, edge_ids: [],
        issue: '同类型同名节点疑似重复：' + key.split('||')[1] + '（' + ids.length + ' 个）',
        suggestion: '语义相同则合并，不同则改名区分',
      });
    }
  });

  // 3. 占位名称（未命名/示例等）
  var PLACEHOLDER = /^(未命名|新节点|新边|示例|example|placeholder|none|null|undefined)$/i;
  var placeholders = nodes.filter(function (n) {
    var name = String((n.properties && (n.properties.name || n.properties.title)) || '').trim();
    return PLACEHOLDER.test(name);
  });
  if (placeholders.length) {
    findings.push({
      severity: 'low', category: 'placeholder_name', node_ids: placeholders.map(function (n) { return n.id; }), edge_ids: [],
      issue: '占位名称节点（未命名/示例等）：' + placeholders.length + ' 个',
      suggestion: '补全真实名称',
    });
  }

  // 4. 超度枢纽（信息性提示；意图图谱聚合挂 30+ 叶子属正常，阈值取 45）
  var HUBS = nodes.filter(function (n) { return (degree[n.id] || 0) >= 45; });
  if (HUBS.length) {
    findings.push({
      severity: 'low', category: 'hub_node', node_ids: HUBS.map(function (n) { return n.id; }), edge_ids: [],
      issue: '超度枢纽节点（度数 >= 45）：' + HUBS.map(function (n) {
        var p = n.properties || {};
        return (p.name || p.title || n.id) + '(' + degree[n.id] + ')';
      }).join(', '),
      suggestion: '确认该节点确为中心节点，或考虑拆分聚合',
    });
  }

  // 5. 模板声明但无实例的节点类型（信息性）
  if (template && Array.isArray(template.node_types)) {
    var usedTypes = {};
    nodes.forEach(function (n) { usedTypes[n.type] = true; });
    var unused = template.node_types.filter(function (t) { return !usedTypes[t.type]; }).map(function (t) { return t.type; });
    if (unused.length) {
      findings.push({
        severity: 'low', category: 'unused_type', node_ids: [], edge_ids: [],
        issue: '模板声明但无实例的节点类型：' + unused.join(', '),
        suggestion: '按需补充该类型节点，或忽略',
      });
    }
  }

  // 6. 边端点类型违背模板约束 / 未声明边类型（schema 级确定性判定——大图中此类问题
  //    不应依赖 LLM 逐条扫描边清单，位置靠后的违规边 LLM 可能漏看）
  if (template && Array.isArray(template.edge_types) && template.edge_types.length) {
    var nodeType = {};
    nodes.forEach(function (n) { nodeType[n.id] = n.type; });
    var edgeConstraint = {};
    template.edge_types.forEach(function (t) { edgeConstraint[t.type] = t; });
    var badEndpoints = [];
    var undeclared = [];
    edges.forEach(function (e) {
      var c = edgeConstraint[e.type];
      if (!c) { undeclared.push(e); return; }
      var st = nodeType[e.source];
      var tt = nodeType[e.target];
      var bad = (Array.isArray(c.source_types) && c.source_types.length && c.source_types.indexOf(st) < 0) ||
        (Array.isArray(c.target_types) && c.target_types.length && c.target_types.indexOf(tt) < 0);
      if (bad) badEndpoints.push(e);
    });
    if (badEndpoints.length) {
      findings.push({
        severity: 'high', category: 'invalid_edge_endpoint',
        node_ids: [], edge_ids: badEndpoints.map(function (e) { return e.id; }),
        issue: '边端点类型违背模板约束（' + badEndpoints.length + ' 条）：' + badEndpoints.slice(0, 5).map(function (e) {
          return e.id + '（' + e.type + '：' + (nodeType[e.source] || '?') + '→' + (nodeType[e.target] || '?') + '）';
        }).join('，') + (badEndpoints.length > 5 ? ' 等' : ''),
        suggestion: '对照模板 edge_types 端点约束修正边类型或端点节点',
      });
    }
    if (undeclared.length) {
      findings.push({
        severity: 'medium', category: 'undeclared_edge_type',
        node_ids: [], edge_ids: undeclared.map(function (e) { return e.id; }),
        issue: '使用了模板未声明的边类型（' + undeclared.length + ' 条）：' +
          undeclared.slice(0, 5).map(function (e) { return e.type; }).join('，'),
        suggestion: '改用模板声明的边类型，或在模板中补充该类型',
      });
    }
  }

  // 7. 跨意图说法去重：同一说法被多个意图认领时标记歧义（playbook 经验）
  var intentNodes = nodes.filter(function (n) { return n.type === 'INTENT' || n.type === 'AGGREGATE_INTENT'; });
  var uttOwner = {};
  intentNodes.forEach(function (n) {
    var utts = (n.properties && n.properties.utterance_view) || [];
    if (!Array.isArray(utts)) return;
    utts.forEach(function (u) {
      var key = String(u).trim();
      if (!key) return;
      if (!uttOwner[key]) uttOwner[key] = [];
      if (uttOwner[key].indexOf(n.id) < 0) uttOwner[key].push(n.id);
    });
  });
  var ambiguousUtts = Object.keys(uttOwner).filter(function (k) { return uttOwner[k].length > 1; });
  if (ambiguousUtts.length) {
    findings.push({
      severity: 'high', category: 'cross_intent_utterance', node_ids: [], edge_ids: [],
      issue: '跨意图重复说法（歧义）：' + ambiguousUtts.length + ' 条说法同时出现在多个意图下，如「' + ambiguousUtts.slice(0, 3).join('、') + '」',
      suggestion: '同一说法被多个意图认领时应全部丢弃（歧义说法交给下游裁决层）',
    });
  }

  // 8. 描述唯一性：跨意图描述重复会稀释向量空间（playbook 经验）
  var descOwner = {};
  intentNodes.forEach(function (n) {
    var desc = String((n.properties && n.properties.description) || '').trim();
    if (!desc) return;
    if (!descOwner[desc]) descOwner[desc] = [];
    descOwner[desc].push(n.id);
  });
  var dupDescs = Object.keys(descOwner).filter(function (k) { return descOwner[k].length > 1; });
  if (dupDescs.length) {
    findings.push({
      severity: 'high', category: 'duplicate_description', node_ids: [], edge_ids: [],
      issue: '描述跨意图重复（稀释向量空间）：' + dupDescs.length + ' 条描述被多个意图共用，如「' + dupDescs.slice(0, 2).map(function (d) { return d.slice(0, 30); }).join('」、「') + '...」',
      suggestion: '每个意图的 description 必须跨意图唯一，禁止使用共享模板文案',
    });
  }

  // 9. utterance_view 条目不足 + 词群维度覆盖检查
  var UTT_DIMENSIONS = [
    { key: 'direct', label: '直接说法', patterns: [/^(查|看|搜|找|要|想看|想查)/] },
    { key: 'colloquial', label: '口语化变体', patterns: [/(多少|还剩|有没有|是不是|到底|真的)/] },
    { key: 'scene', label: '场景化表达', patterns: [/(如果|万一|比如|像.*那样|的时候|之后|之前)/] },
    { key: 'operation', label: '操作型表达', patterns: [/^(怎么|如何|在哪|哪里|哪能|怎样)/] },
  ];
  var lowUtts = [], lowDimUtts = [];
  intentNodes.forEach(function (n) {
    var utts = (n.properties && n.properties.utterance_view) || [];
    if (!Array.isArray(utts)) return;
    if (utts.length < 6) lowUtts.push(n);
    var covered = {};
    utts.forEach(function (u) {
      var s = String(u).trim();
      UTT_DIMENSIONS.forEach(function (dim) {
        if (!covered[dim.key] && dim.patterns.some(function (p) { return p.test(s); })) {
          covered[dim.key] = true;
        }
      });
    });
    var missing = UTT_DIMENSIONS.filter(function (dim) { return !covered[dim.key]; });
    if (missing.length >= 2) lowDimUtts.push({ id: n.id, missing: missing });
  });
  if (lowUtts.length) {
    findings.push({
      severity: 'medium', category: 'insufficient_utterances',
      node_ids: lowUtts.map(function (n) { return n.id; }), edge_ids: [],
      issue: 'utterance_view 条目不足（<6条）：' + lowUtts.length + ' 个意图',
      suggestion: '补充说法至 ≥8 条，覆盖直接说法、口语化变体、场景化表达、操作型表达四个维度',
    });
  }
  if (lowDimUtts.length) {
    findings.push({
      severity: 'medium', category: 'utterance_dimension_gap',
      node_ids: lowDimUtts.slice(0, 20).map(function (x) { return x.id; }), edge_ids: [],
      issue: '说法维度覆盖不足（≥2个维度缺失）：' + lowDimUtts.length + ' 个意图，缺维度如「' +
        lowDimUtts.slice(0, 3).map(function (x) { return x.missing.map(function (m) { return m.label; }).join('+'); }).join('、') + '」',
      suggestion: '每个维度至少1条：直接说法（查X/看X）、口语化变体（还有多少）、场景化表达（工资到账没）、操作型表达（怎么查/在哪看）',
    });
  }

  // 9b. 句式单一检查：若某意图的说法首词集中度过高（同一首词占比 >=70%），召回覆盖面不足
  var monoUtts = [];
  intentNodes.forEach(function (n) {
    var utts = (n.properties && n.properties.utterance_view) || [];
    if (!Array.isArray(utts) || utts.length < 3) return;
    var firstWords = {};
    utts.forEach(function (u) {
      var s = String(u).trim();
      var fw = s.charAt(0);
      firstWords[fw] = (firstWords[fw] || 0) + 1;
    });
    var maxRatio = 0, maxWord = '';
    Object.keys(firstWords).forEach(function (k) {
      if (firstWords[k] / utts.length > maxRatio) { maxRatio = firstWords[k] / utts.length; maxWord = k; }
    });
    if (maxRatio >= 0.7) monoUtts.push({ id: n.id, firstWord: maxWord, ratio: maxRatio, count: utts.length });
  });
  if (monoUtts.length) {
    findings.push({
      severity: 'medium', category: 'utterance_pattern_monotone', node_ids: monoUtts.slice(0, 20).map(function (x) { return x.id; }), edge_ids: [],
      issue: '说法句式单一（同一首词占比≥70%）：' + monoUtts.length + ' 个意图，如「' + monoUtts[0].firstWord + '」开头占比' + (monoUtts[0].ratio * 100).toFixed(0) + '%',
      suggestion: '补充不同首词开头的说法，避免全部以同一动词开头',
    });
  }

  // 9c. 描述与说法语义一致性
  var VERB_FAMILIES = [
    { verbs: ['查询', '查', '看', '搜', '找', '查看'], label: '查询' },
    { verbs: ['办理', '开', '开通', '申请', '签约', '注册'], label: '办理' },
    { verbs: ['修改', '改', '变更', '更新', '调整'], label: '修改' },
    { verbs: ['取消', '撤销', '解除', '关闭', '注销'], label: '取消' },
    { verbs: ['转账', '转', '汇款', '汇'], label: '转账' },
    { verbs: ['还款', '还', '还款', '还款'], label: '还款' },
  ];
  var descUttMismatch = [];
  intentNodes.forEach(function (n) {
    var desc = String((n.properties && n.properties.description) || '').trim();
    var utts = (n.properties && n.properties.utterance_view) || [];
    if (!desc || !Array.isArray(utts) || utts.length < 3) return;
    var descFamilies = VERB_FAMILIES.filter(function (f) {
      return f.verbs.some(function (v) { return desc.indexOf(v) >= 0; });
    });
    if (descFamilies.length === 0) return;
    var uttText = utts.join(' ');
    var hasMatch = descFamilies.some(function (f) {
      return f.verbs.some(function (v) { return uttText.indexOf(v) >= 0; });
    });
    if (!hasMatch) {
      descUttMismatch.push({ id: n.id, descVerb: descFamilies[0].label, descPreview: desc.slice(0, 20), uttSample: utts.slice(0, 3).join('、') });
    }
  });
  if (descUttMismatch.length) {
    findings.push({
      severity: 'medium', category: 'description_utterance_mismatch', node_ids: descUttMismatch.slice(0, 20).map(function (x) { return x.id; }), edge_ids: [],
      issue: '描述与说法语义不一致：' + descUttMismatch.length + ' 个意图的描述核心动词与说法不匹配，如描述为「' + descUttMismatch[0].descPreview + '...」（动词族：' + descUttMismatch[0].descVerb + '）但说法为「' + descUttMismatch[0].uttSample + '」',
      suggestion: '检查描述的核心动词是否与说法的动词族一致，修正描述或补充匹配的说法',
    });
  }

  // 10. 别名长度约束（playbook 经验：2-24字，无连续3位以上数字）
  var badLen = [], badDigits = [];
  intentNodes.forEach(function (n) {
    var utts = (n.properties && n.properties.utterance_view) || [];
    if (!Array.isArray(utts)) return;
    utts.forEach(function (u) {
      var s = String(u).trim();
      if (s.length < 2 || s.length > 24) badLen.push({ id: n.id, alias: s });
      if (/\d{3,}/.test(s)) badDigits.push({ id: n.id, alias: s });
    });
  });
  if (badLen.length) {
    findings.push({
      severity: 'low', category: 'alias_length',
      node_ids: [], edge_ids: [],
      issue: '说法长度不在2-24字范围：' + badLen.length + ' 条',
      suggestion: '裁剪或改写超长/超短说法',
    });
  }
  if (badDigits.length) {
    findings.push({
      severity: 'low', category: 'alias_digits',
      node_ids: [], edge_ids: [],
      issue: '说法含连续3位以上数字：' + badDigits.length + ' 条，如「' + badDigits.slice(0, 3).map(function (b) { return b.alias; }).join('、') + '」',
      suggestion: '去除卡号/金额/日期等占位符',
    });
  }

  // 11. parent_intent_id 归属校验：检查 parent 是否指向存在的 AGGREGATE_INTENT 节点
  var aggIds = {};
  nodes.forEach(function (n) { if (n.type === 'AGGREGATE_INTENT') aggIds[n.id] = true; });
  var orphanIntents = intentNodes.filter(function (n) {
    if (n.type !== 'INTENT') return false;
    var pid = n.properties && n.properties.parent_intent_id;
    return pid && !aggIds[pid];
  });
  if (orphanIntents.length) {
    findings.push({
      severity: 'medium', category: 'orphan_parent',
      node_ids: orphanIntents.map(function (n) { return n.id; }), edge_ids: [],
      issue: 'parent_intent_id 指向不存在的聚合意图：' + orphanIntents.length + ' 个意图',
      suggestion: '修正 parent_intent_id 或创建对应的 AGGREGATE_INTENT 节点',
    });
  }

  return findings;
}

// ───────────────────────── 共享 prompt 组装 ─────────────────────────

/**
 * 审查判定依据（一 schema / 二领域语义 / 三业务规则 / 四确定性发现）。
 * 小图单次审查与大图分批审查共用同一份判定依据，保证两路径结论口径一致。
 */
function auditPreambleLines(template, assetRules, deterministicFindings) {
  var rules = (assetRules && assetRules.rules) || [];
  var lines = [];
  lines.push('你是知识图谱质检专家。审查下面这份图谱的质量问题。审查判定必须严格基于「模板 schema」与「业务规则」——不理解 schema 配置与建图要求的判断一律不要给出。');
  lines.push('');
  lines.push('一、模板 schema（字段全量）：');
  (template.node_types || []).forEach(function (t) {
    lines.push('- 节点类型 ' + t.type + '（' + (t.label || '') + '）：');
    (t.fields || []).forEach(function (f) {
      lines.push('  · ' + f.key + '：' + (f.type || 'string') + (f.required ? '（必填）' : '（可选）') +
        (f.options && f.options.length ? '，取值 ∈ ' + f.options.join('/') : ''));
    });
  });
  (template.edge_types || []).forEach(function (e) {
    lines.push('- 边类型 ' + e.type + '（' + (e.label || '') + '）：' + (e.source_types || []).join('/') + ' → ' + (e.target_types || []).join('/') +
      (e.fields && e.fields.length ? '；properties: ' + e.fields.map(function (f) { return f.key; }).join(', ') : ''));
  });
  lines.push('');
  lines.push('二、领域语义说明（节点/边类型的业务含义，用于判断类型-内容匹配与语义边界）：');
  if (assetRules && assetRules.entityTypes) {
    Object.keys(assetRules.entityTypes).forEach(function (t) {
      var d = assetRules.entityTypes[t];
      if (d && d.desc) lines.push('- ' + t + '：' + d.desc + (d.examples ? '（例：' + d.examples + '）' : ''));
    });
  }
  if (assetRules && assetRules.relationTypes) {
    Object.keys(assetRules.relationTypes).forEach(function (t) {
      var d = assetRules.relationTypes[t];
      if (d && d.desc) lines.push('- ' + t + '：' + d.desc + (d.example ? '（例：' + d.example + '）' : ''));
    });
  }
  lines.push('');
  lines.push('三、业务规则（质检判定依据，逐条核对图谱是否违背）：');
  if (!rules.length) lines.push('（无）');
  rules.forEach(function (r) { lines.push('- ' + r); });
  lines.push('');
  lines.push('四、确定性检查已发现（不要重复报告）：');
  if (!deterministicFindings.length) lines.push('（无）');
  deterministicFindings.forEach(function (f) { lines.push('- [' + f.severity + '] ' + f.issue); });
  lines.push('');
  return lines;
}

/** 节点摘要行（id|type|name|degree|intent_meta）。degree 相对传入边集计算；
 *  意图节点属性摘要让 LLM 能判断说法充分性、交付完整性、意图分类合理性。 */
function nodeLines(nodes, edges) {
  var lines = [];
  var degree = {};
  nodes.forEach(function (n) { degree[n.id] = 0; });
  edges.forEach(function (e) {
    if (degree[e.source] !== undefined) degree[e.source]++;
    if (degree[e.target] !== undefined) degree[e.target]++;
  });
  var intentLeafCount = {};
  nodes.forEach(function (n) {
    if (n.type === 'INTENT') {
      var pid = String((n.properties && n.properties.parent_intent_id) || '');
      if (pid) intentLeafCount[pid] = (intentLeafCount[pid] || 0) + 1;
    }
  });
  nodes.forEach(function (n) {
    var p = n.properties || {};
    var base = n.id + '|' + n.type + '|' + (p.name || p.title || '') + '|' + (degree[n.id] || 0);
    var meta = '';
    if (n.type === 'INTENT') {
      var utts = [];
      if (Array.isArray(p.utterance_view)) utts = utts.concat(p.utterance_view);
      if (Array.isArray(p.scope_in)) utts = utts.concat(p.scope_in);
      var uttSamples = utts.slice(0, 3).map(function (u) { return String(u).slice(0, 20); }).join(';');
      meta = 'utt:' + utts.length + (uttSamples ? '(' + uttSamples + ')' : '') +
        '|type:' + (p.intent_type || '?') +
        '|fulfill:' + (p.fulfillment_kind || '?') +
        '|parent:' + (p.parent_intent_id || '-') +
        '|scope_out:' + (Array.isArray(p.scope_out) ? p.scope_out.length : 0);
    } else if (n.type === 'AGGREGATE_INTENT') {
      meta = 'leafs:' + (intentLeafCount[n.id] || 0);
    }
    lines.push(base + (meta ? '|' + meta : ''));
  });
  return lines;
}

/** 边端点类型分布摘要：让 LLM 一眼看到异常端点组合（裸扫长边清单会漏看位置靠后的违规） */
function edgeDistributionLines(edges) {
  var lines = [];
  var byType = {};
  edges.forEach(function (e) { (byType[e.type] = byType[e.type] || []).push(e); });
  Object.keys(byType).forEach(function (t) {
    var pairs = {};
    byType[t].forEach(function (e) {
      var k = (e._sourceType || '?') + '→' + (e._targetType || '?');
      pairs[k] = (pairs[k] || 0) + 1;
    });
    lines.push('- ' + t + '：' + Object.keys(pairs).map(function (k) { return k + ' ×' + pairs[k]; }).join('，'));
  });
  return lines;
}

/** 按类型分组的边清单；capPerType 为 null 表示全量（调用方保证规模） */
function groupedEdgesLines(edges, nodeTypeOf, capPerType) {
  var lines = [];
  var byType = {};
  edges.forEach(function (e) { (byType[e.type] = byType[e.type] || []).push(e); });
  Object.keys(byType).forEach(function (t) {
    var group = byType[t];
    if (capPerType) {
      lines.push('- ' + t + '（共 ' + group.length + ' 条，列前 ' + Math.min(capPerType, group.length) + ' 条）：');
      group.slice(0, capPerType).forEach(function (e) { lines.push('  ' + e.source + ' -> ' + e.target); });
    } else {
      lines.push('- ' + t + '（共 ' + group.length + ' 条）：');
      group.forEach(function (e) { lines.push('  ' + e.source + ' -> ' + e.target); });
    }
  });
  return lines;
}

/** 重点排查类别与输出契约（小图/分批审查共用，保证发现格式一致可合并） */
function auditFocusLines() {
  var lines = [];
  lines.push('重点排查（schema 与业务规则是判定参照，三类发现都有效）：');
  lines.push('A. 规则违背类（必须注明对应的字段/枚举/业务规则条款）：');
  lines.push('  - missing_relation：业务规则要求的关系缺失（如叶子意图未挂聚合意图、SLOT 未挂叶子意图）');
  lines.push('  - type_mismatch：节点类型与属性内容不匹配（如动作类内容建成了意图节点、领域名不属于该类型业务域）');
  lines.push('  - boundary_conflict：枚举语义边界冲突（如 intent_type 与名称语义不符：查询类意图标成了 DO；字段取值不在声明枚举内）');
  lines.push('B. 语义质量类（基于「领域语义说明」的语义判断，列出具体节点对即可，不必对应规则条款）：');
  lines.push('  - duplicate_nodes：不同名但语义相同的节点（如 风险测评/风险评测）');
  lines.push('  - suspicious_edge：连接语义不相关两端的边（按边类型语义判断）');
  lines.push('C. 语义充分性类（基于意图节点属性 intent_meta 判断，规则检查只看数量和维度覆盖，你需判断语义质量和内容充分度）：');
  lines.push('  - insufficient_utterances：意图典型说法质量不足（数量够但句式单一全是"查X""问X"；缺少口语化/场景化/变体表述；utt 字段列出的说法代表性不够）');
  lines.push('  - utterance_dimension_gap：说法维度覆盖不足（确定性检查已识别≥2个维度缺失，你需判断缺失维度对召回率的实际影响）');
  lines.push('  - utterance_pattern_monotone：说法句式单一（确定性检查已识别同一首词占比≥70%，你需判断是否影响召回覆盖面）');
  lines.push('  - description_low_quality：描述质量不足——描述必须包含四要素：用户角色（谁用）+触发场景（什么时候用）+功能边界（包含/不包含什么）+产出结果（得到什么）。缺少任一要素应标记，尤其是功能边界缺失会导致相邻意图区分度不足');
  lines.push('  - description_utterance_mismatch：描述与说法语义不一致（确定性检查已识别描述核心动词族与说法不匹配，你需确认是否为实质性语义偏差）');
  lines.push('  - near_duplicate_description：近义描述高度相似（确定性检查已识别 Jaccard 相似度>0.75 的描述对，你需判断是否足以区分相邻意图）');
  lines.push('  - coverage_gap：明显缺少的用户目标/意图（根据领域语义说明和已有意图推断，图谱中应有的意图类型缺失）');
  lines.push('  - delivery_incomplete：交付链不完整（intent 配置了 fulfillment_kind=answer 但无 KNOWLEDGE_ANSWER 连接；fulfillment_kind=query 但 query_ref 缺失；有意图但无对应 BUSINESS_OBJECT 连接）');
  lines.push('  - semantic_overlap：不同 INTENT 节点语义高度重叠（表达同一用户目标但分别建了节点，应合并或明确边界区分）');
  lines.push('确有问题就明确列出；没有把握的具体判断不要凑数。');
  lines.push('输出纪律：同质问题（如大量节点同样缺连接、句式同样单一）必须合并为一条发现，issue 注明数量概括；node_ids 只列最有代表性的节点（最多 20 个），禁止逐节点罗列长清单——超长输出会被截断导致整批作废。');
  lines.push('输出严格 JSON 数组（不要 markdown 围栏），每项：');
  lines.push(JSON.stringify({
    severity: 'high|medium|low',
    category: 'duplicate_nodes|missing_relation|type_mismatch|suspicious_edge|boundary_conflict|insufficient_utterances|utterance_dimension_gap|utterance_pattern_monotone|description_low_quality|description_utterance_mismatch|near_duplicate_description|coverage_gap|delivery_incomplete|semantic_overlap|other',
    node_ids: ['涉及的节点 id 数组，可空'],
    edge_ids: ['涉及的边 id 数组，可空'],
    issue: '一句话问题描述（规则违背类注明对应条款，语义质量类注明语义依据）',
    suggestion: '一句话修复建议',
  }));
  lines.push('最多 15 条；没有发现问题输出 []。');
  return lines;
}

/**
 * 小图路径：图谱压缩摘要 → 单次全量语义审查 prompt。
 * 节点/边在规模上限内全量入 prompt；超限才采样并显式声明未覆盖——
 * 但调用方（路由层）应在超限时改走 runPartitionedAudit 分治路径，本函数的采样只是兜底。
 */
function buildAuditPrompt(document, template, deterministicFindings, assetRules) {
  var nodes = document.nodes || [];
  var edges = document.edges || [];
  var lines = auditPreambleLines(template, assetRules, deterministicFindings);
  lines.push('五、图谱内容（共 ' + nodes.length + ' 节点 / ' + edges.length + ' 边）：');
  var shownNodes = nodes.length <= AUDIT_LIMITS.nodeCap ? nodes : nodes.slice(0, AUDIT_LIMITS.nodeCap);
  lines.push('节点（id|type|name|degree|intent_meta — 仅意图类节点附关键属性）：');
  nodeLines(shownNodes, edges).forEach(function (l) { lines.push(l); });
  if (shownNodes.length < nodes.length) {
    lines.push('（注意：节点超过 ' + AUDIT_LIMITS.nodeCap + '，仅列前 ' + AUDIT_LIMITS.nodeCap + '，其余 ' +
      (nodes.length - shownNodes.length) + ' 个未纳入本次审查，结论仅针对已列节点）');
  }
  lines.push('');
  // 端点类型注入：_sourceType/_targetType 由调用上下文补（保持 nodeLines 纯净）
  var nodeTypeOf = {};
  nodes.forEach(function (n) { nodeTypeOf[n.id] = n.type; });
  var taggedEdges = edges.map(function (e) {
    return { type: e.type, source: e.source, target: e.target, id: e.id, _sourceType: nodeTypeOf[e.source], _targetType: nodeTypeOf[e.target] };
  });
  lines.push('边端点类型分布（快速定位异常组合）：');
  edgeDistributionLines(taggedEdges).forEach(function (l) { lines.push(l); });
  lines.push('');
  if (edges.length <= AUDIT_LIMITS.edgeCap) {
    lines.push('边（全量，按类型分组）：');
    groupedEdgesLines(edges, nodeTypeOf, null).forEach(function (l) { lines.push(l); });
  } else {
    lines.push('边（按类型分组，每组最多 ' + AUDIT_LIMITS.edgeTypeCap + ' 条示例；图超过 ' + AUDIT_LIMITS.edgeCap +
      ' 条边未能全量审查，结论仅针对已列边）：');
    groupedEdgesLines(edges, nodeTypeOf, AUDIT_LIMITS.edgeTypeCap).forEach(function (l) { lines.push(l); });
  }
  lines.push('');
  auditFocusLines().forEach(function (l) { lines.push(l); });
  return lines.join('\n');
}

// ───────────────────────── 大图分治并行审查 ─────────────────────────

/** 超过单次审查上限 → 路由层应改走 runPartitionedAudit */
function needsPartitionedAudit(document) {
  return (document.nodes || []).length > AUDIT_LIMITS.nodeCap || (document.edges || []).length > AUDIT_LIMITS.edgeCap;
}

/** 连通片过大时 BFS 切分：每次从剩余最高度节点出发广度优先收满一批，保持邻接节点同批 */
function splitComponent(compIds, cap, adj, edgeById) {
  var remaining = new Set(compIds);
  var chunks = [];
  while (remaining.size) {
    var seed = null, best = -1;
    remaining.forEach(function (id) {
      if (adj[id].length > best) { best = adj[id].length; seed = id; }
    });
    remaining.delete(seed);
    var chunk = [seed];
    var frontier = [seed];
    while (frontier.length && chunk.length < cap) {
      var id = frontier.shift();
      adj[id].forEach(function (eid) {
        var e = edgeById[eid];
        var other = e.source === id ? e.target : e.source;
        if (chunk.length < cap && remaining.has(other)) {
          remaining.delete(other);
          chunk.push(other);
          frontier.push(other);
        }
      });
    }
    chunks.push(chunk);
  }
  return chunks;
}

/**
 * 连通片感知分批：
 *  - 大连通片（> partitionNodeCap）从高度数种子 BFS 切分，邻接节点尽量同批（聚合-叶子不散批）
 *  - 小连通片（≤ smallComponentMax）并入杂批，避免批次数爆炸
 *  - 中等连通片独立成批
 * 每批返回批内边（全量）+ 跨批引用边（供 missing_relation / 交付链判断）。
 */
function partitionGraph(document, limits) {
  limits = limits || AUDIT_LIMITS;
  var nodes = document.nodes || [];
  var edges = document.edges || [];
  var cap = limits.partitionNodeCap;
  var adj = {};
  nodes.forEach(function (n) { adj[n.id] = []; });
  var edgeById = {};
  edges.forEach(function (e) {
    edgeById[e.id] = e;
    if (adj[e.source]) adj[e.source].push(e.id);
    if (adj[e.target]) adj[e.target].push(e.id);
  });
  var visited = {};
  var components = [];
  nodes.forEach(function (n) {
    if (visited[n.id]) return;
    var comp = [];
    var queue = [n.id];
    visited[n.id] = true;
    while (queue.length) {
      var id = queue.shift();
      comp.push(id);
      adj[id].forEach(function (eid) {
        var e = edgeById[eid];
        var other = e.source === id ? e.target : e.source;
        if (!visited[other]) { visited[other] = true; queue.push(other); }
      });
    }
    components.push(comp);
  });
  var batches = [];
  var smallPool = [];
  components.forEach(function (comp) {
    if (comp.length > cap) {
      splitComponent(comp, cap, adj, edgeById).forEach(function (chunk) { batches.push(chunk); });
    } else if (comp.length <= limits.smallComponentMax) {
      smallPool.push.apply(smallPool, comp);
    } else {
      batches.push(comp);
    }
  });
  for (var i = 0; i < smallPool.length; i += cap) batches.push(smallPool.slice(i, i + cap));
  var partitionOf = {};
  batches.forEach(function (ids, bi) { ids.forEach(function (id) { partitionOf[id] = bi; }); });
  var partitions = batches.map(function () { return { index: 0, nodes: [], internalEdges: [], externalEdges: [] }; });
  partitions.forEach(function (p, bi) { p.index = bi; });
  nodes.forEach(function (n) { partitions[partitionOf[n.id]].nodes.push(n); });
  edges.forEach(function (e) {
    var si = partitionOf[e.source];
    var ti = partitionOf[e.target];
    if (si === undefined || ti === undefined) return; // 悬挂端点由 schema 校验器负责
    if (si === ti) { partitions[si].internalEdges.push(e); return; }
    partitions[si].externalEdges.push({ edgeId: e.id, edgeType: e.type, otherId: e.target });
    partitions[ti].externalEdges.push({ edgeId: e.id, edgeType: e.type, otherId: e.source });
  });
  return { partitions: partitions };
}

/** 单批审查 prompt：与全量审查同一份判定依据（preamble）与输出契约（focus），
 *  本批节点/边全量列出并明确「必须逐一过目」，跨批引用边压缩列出。 */
function buildPartitionAuditPrompt(partition, preambleLines, focusLines, info) {
  var p = partition;
  var lines = preambleLines.slice();
  lines.push('【分批审查】全图共 ' + info.totalNodes + ' 节点 / ' + info.totalEdges + ' 边，超过单次审查上限，已切成 ' +
    info.batchTotal + ' 批并行审查，本提示是第 ' + info.batchNo + '/' + info.batchTotal + ' 批。');
  lines.push('各批独立审查同一份 schema 与业务规则；跨批重复发现会在汇总层去重合并。你只需对本批内容负责，但本批列出的每个节点、每条边都必须逐一过目，不许抽样。需要对照其它批内容才能下的判断（如与未列出节点的语义重复）交给汇总层，不要猜测其它批内容。');
  lines.push('');
  lines.push('五、本批图谱内容（第 ' + info.batchNo + ' 批：' + p.nodes.length + ' 节点 / ' + p.internalEdges.length + ' 批内边）：');
  lines.push('节点（id|type|name|degree|intent_meta — 仅意图类节点附关键属性；degree 为批内度数）：');
  nodeLines(p.nodes, p.internalEdges).forEach(function (l) { lines.push(l); });
  lines.push('');
  var nodeTypeOf = {};
  p.nodes.forEach(function (n) { nodeTypeOf[n.id] = n.type; });
  var tagged = p.internalEdges.map(function (e) {
    return { type: e.type, source: e.source, target: e.target, id: e.id, _sourceType: nodeTypeOf[e.source], _targetType: nodeTypeOf[e.target] };
  });
  lines.push('批内边端点类型分布：');
  edgeDistributionLines(tagged).forEach(function (l) { lines.push(l); });
  lines.push('');
  lines.push('批内边（全量，按类型分组）：');
  groupedEdgesLines(p.internalEdges, nodeTypeOf, null).forEach(function (l) { lines.push(l); });
  lines.push('');
  lines.push('跨批引用边（本批节点与其它批节点之间的边，列前 ' + AUDIT_LIMITS.externalEdgeCap + ' 条）：');
  if (!p.externalEdges.length) lines.push('（无）');
  p.externalEdges.slice(0, AUDIT_LIMITS.externalEdgeCap).forEach(function (x) {
    lines.push('  ' + x.edgeId + '(' + x.edgeType + ') -> ' + x.otherId);
  });
  if (p.externalEdges.length > AUDIT_LIMITS.externalEdgeCap) {
    lines.push('  （另有 ' + (p.externalEdges.length - AUDIT_LIMITS.externalEdgeCap) + ' 条跨批边未列出）');
  }
  lines.push('');
  focusLines.forEach(function (l) { lines.push(l); });
  return lines.join('\n');
}

/** 全局跨批一致性审查 prompt：全图节点清单（id|type|name）→ 语义重复/命名不一致/覆盖缺口 */
function buildGlobalAuditPrompt(document, limits) {
  limits = limits || AUDIT_LIMITS;
  var nodes = document.nodes || [];
  var lines = [];
  lines.push('你是知识图谱质检专家。一份大图谱（共 ' + nodes.length + ' 节点）已分批完成局部语义审查（类型匹配、规则违背、说法充分性等已由各批负责），现在只做跨批一致性汇总审查。');
  lines.push('只排查三类跨批问题，局部问题不要重复：');
  lines.push('- semantic_overlap：分布在清单不同位置的节点语义高度重叠（同义/近义名称、表达同一用户目标），应合并或明确边界区分');
  lines.push('- naming_inconsistency：同类型节点命名风格不一致（如同为查询类意图，一部分带「查询」前缀一部分不带，影响检索与消解）');
  lines.push('- coverage_gap：从全图类型分布推断明显缺失的用户目标/意图（谨慎判断，没有把握不要给）');
  lines.push('');
  var typeDist = {};
  nodes.forEach(function (n) { typeDist[n.type] = (typeDist[n.type] || 0) + 1; });
  lines.push('一、类型分布：' + Object.keys(typeDist).map(function (t) { return t + ' ×' + typeDist[t]; }).join('，'));
  lines.push('');
  lines.push('二、全图节点清单（id|type|name）：');
  var shown = nodes.slice(0, limits.globalNodeListCap);
  shown.forEach(function (n) {
    var p = n.properties || {};
    lines.push(n.id + '|' + n.type + '|' + (p.name || p.title || ''));
  });
  if (shown.length < nodes.length) {
    lines.push('（节点超过 ' + limits.globalNodeListCap + '，仅列前 ' + limits.globalNodeListCap + '，其余 ' +
      (nodes.length - shown.length) + ' 个未纳入跨批清单，命名一致性判断仅针对已列节点）');
  }
  lines.push('');
  lines.push('输出严格 JSON 数组（不要 markdown 围栏），每项：');
  lines.push(JSON.stringify({
    severity: 'high|medium|low',
    category: 'semantic_overlap|naming_inconsistency|coverage_gap|other',
    node_ids: ['涉及的节点 id 数组'],
    edge_ids: [],
    issue: '一句话问题描述',
    suggestion: '一句话修复建议',
  }));
  lines.push('最多 10 条；没有发现问题输出 []。');
  return lines.join('\n');
}

var SEV_RANK = { high: 0, medium: 1, low: 2 };
function severityRank(f) { return SEV_RANK[f.severity] === undefined ? 1 : SEV_RANK[f.severity]; }
function overlapRatio(a, b) {
  if (!a.length || !b.length) return 0;
  var set = new Set(a);
  var hit = 0;
  b.forEach(function (id) { if (set.has(id)) hit++; });
  return hit / Math.min(a.length, b.length);
}

/** 多批发现合并：severity 排序 → 按类别+节点重叠去重（跨批报同一问题只留一条）→ 截断上限 */
function mergeAuditFindings(groups, maxFindings) {
  var all = [];
  (groups || []).forEach(function (g) { (g || []).forEach(function (f) { if (f) all.push(f); }); });
  all.sort(function (a, b) { return severityRank(a) - severityRank(b); });
  var accepted = [];
  all.forEach(function (f) {
    var dup = accepted.some(function (a) {
      if (a.category !== f.category) return false;
      if (overlapRatio(a.node_ids, f.node_ids) >= 0.5) return true;
      if (!a.node_ids.length && !f.node_ids.length && String(a.issue).slice(0, 40) === String(f.issue).slice(0, 40)) return true;
      return false;
    });
    if (!dup) accepted.push(f);
  });
  return accepted.slice(0, maxFindings || AUDIT_LIMITS.maxFindings);
}

/**
 * 分治并行审查编排：确定性检查（全图一次）→ 连通片分批 → 有界并发逐批 LLM
 * （传输失败重试 retries 次；解析失败记批次失败，不静默当 0）→ 全局跨批一致性审查 →
 * 合并去重。callLLM(prompt) → Promise<string> 由调用方注入（无状态客户端可安全并发）。
 * opts.onProgress(done, total, step) / opts.onBatch({ batchNo, batchTotal, findings, ok, error })
 * 供 SSE 逐批推送；回调异常不阻断审查。
 * 返回 { deterministic, semantic, stats, llm }；llm: 'ok' | 'partial' | 错误串。
 */
async function runPartitionedAudit(document, template, assetRules, callLLM, opts) {
  opts = opts || {};
  var concurrency = Math.max(1, opts.concurrency || AUDIT_LIMITS.auditConcurrency);
  var retries = opts.retries === undefined ? 2 : opts.retries;
  var nodes = document.nodes || [];
  var edges = document.edges || [];
  var deterministic = deterministicAudit(document, template);
  var preamble = auditPreambleLines(template, assetRules, deterministic);
  var focus = auditFocusLines();
  var parts = partitionGraph(document).partitions;
  var total = parts.length;
  var results = new Array(total);
  var nextIndex = 0;

  async function callWithRetry(prompt) {
    var lastErr;
    for (var attempt = 0; attempt <= retries; attempt++) {
      try { return await callLLM(prompt); } catch (e) {
        lastErr = e;
        if (attempt < retries) await new Promise(function (r) { setTimeout(r, 1200 * (attempt + 1)); });
      }
    }
    throw lastErr;
  }

  async function worker() {
    while (nextIndex < total) {
      var idx = nextIndex++;
      var p = parts[idx];
      var prompt = buildPartitionAuditPrompt(p, preamble, focus, {
        batchNo: idx + 1, batchTotal: total, totalNodes: nodes.length, totalEdges: edges.length,
      });
      // 传输失败与输出解析失败都重试（LLM 非确定性，重试可恢复大多数 parse_error）
      var settled = false;
      var lastError = '';
      for (var attempt = 0; attempt <= retries && !settled; attempt++) {
        try {
          var parsed = parseAuditResponse(await callLLM(prompt));
          if (parsed) { results[idx] = { findings: parsed, ok: true }; settled = true; break; }
          lastError = 'parse_error';
        } catch (e) {
          lastError = String((e && e.message) || e);
        }
        if (attempt < retries) await new Promise(function (r) { setTimeout(r, 1200 * (attempt + 1)); });
      }
      if (!settled) results[idx] = { findings: [], ok: false, error: lastError };
      completed++;
      if (opts.onBatch) {
        var r = results[idx];
        try { opts.onBatch({ batchNo: idx + 1, batchTotal: total, findings: r.findings, ok: r.ok, error: r.error }); } catch (e) { /* 同上 */ }
      }
      reportProgress('已完成 ' + completed + '/' + total + ' 批');
    }
  }
  var workers = [];
  for (var w = 0; w < Math.min(concurrency, total); w++) workers.push(worker());
  var completed = 0;
  function reportProgress(step) {
    if (!opts.onProgress) return;
    try { opts.onProgress(completed, total, step); } catch (e) { /* 进度回调异常不阻断审查 */ }
  }
  if (total) reportProgress('分批并行审查中');
  await Promise.all(workers);

  // 汇总层：跨批一致性单独一次审查（全图节点清单）
  var globalResult = { findings: [], ok: true, error: '' };
  if (nodes.length) {
    try {
      var gparsed = parseAuditResponse(await callWithRetry(buildGlobalAuditPrompt(document)));
      globalResult = gparsed ? { findings: gparsed, ok: true, error: '' } : { findings: [], ok: false, error: 'parse_error' };
    } catch (e) {
      globalResult = { findings: [], ok: false, error: String((e && e.message) || e) };
    }
  }

  if (total) reportProgress('跨批一致性汇总中');
  var merged = mergeAuditFindings(results.map(function (r) { return r.findings; }).concat([globalResult.findings]));
  var okBatches = results.filter(function (r) { return r.ok; }).length;
  var failedBatches = results.map(function (r, i) { return r.ok ? null : { batch: i + 1, error: r.error }; }).filter(Boolean);
  var anyOk = okBatches > 0 || globalResult.ok;
  var llm = (okBatches === total && globalResult.ok) ? 'ok'
    : (anyOk ? 'partial' : (failedBatches.length ? failedBatches[0].error : (globalResult.error || 'unavailable')));
  return {
    deterministic: deterministic,
    semantic: merged,
    stats: {
      nodes: nodes.length, edges: edges.length, deterministic: deterministic.length,
      // coverage 语义对齐前端：full=单次全量；batched=分批并行（全量覆盖，无采样盲区）；partial 仅历史兼容
      coverage: 'batched',
      auditedNodes: nodes.length, auditedEdges: edges.length,
      batches: total,
      batchDetail: {
        ok: okBatches, failed: failedBatches.length, failedBatches: failedBatches,
        globalPass: globalResult.ok ? 'ok' : (globalResult.error || 'failed'),
      },
    },
    llm: llm,
  };
}

/** LLM 输出 → 标准化 finding 数组（围栏剥离 + 字段清洗 + 上限 15；解析失败返回 null） */
function parseAuditResponse(text) {
  var jsonStr = String(text || '').trim();
  var codeMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeMatch) jsonStr = codeMatch[1].trim();
  var startIdx = jsonStr.indexOf('[');
  var endIdx = jsonStr.lastIndexOf(']');
  if (startIdx >= 0 && endIdx > startIdx) jsonStr = jsonStr.slice(startIdx, endIdx + 1);
  var arr;
  try { arr = JSON.parse(jsonStr); } catch (e) {
    // 截断兜底：输出撞 maxTokens 断在半截时，截到最后一个完整对象再闭数组
    var lastObj = jsonStr.lastIndexOf('}');
    if (lastObj < 0) return null;
    try { arr = JSON.parse(jsonStr.slice(0, lastObj + 1) + ']'); } catch (e2) { return null; }
  }
  if (!Array.isArray(arr)) return null;
  return arr
    .filter(function (f) { return f && typeof f === 'object' && (f.issue || f.suggestion); })
    .map(function (f) {
      return {
        severity: ['high', 'medium', 'low'].indexOf(f.severity) >= 0 ? f.severity : 'medium',
        category: String(f.category || 'other'),
        node_ids: Array.isArray(f.node_ids) ? f.node_ids.map(String) : [],
        edge_ids: Array.isArray(f.edge_ids) ? f.edge_ids.map(String) : [],
        issue: String(f.issue || ''),
        suggestion: String(f.suggestion || ''),
      };
    })
    .slice(0, 15);
}

module.exports = {
  deterministicAudit, buildAuditPrompt, parseAuditResponse, AUDIT_LIMITS,
  needsPartitionedAudit, partitionGraph, buildPartitionAuditPrompt, buildGlobalAuditPrompt,
  mergeAuditFindings, runPartitionedAudit, auditPreambleLines, auditFocusLines, nodeLines,
};

// 自检：node tools/graph-audit.js
if (require.main === module) {
  var sample = {
    nodes: [
      { id: 'a', type: 'NODE', properties: { name: '张三' } },
      { id: 'b', type: 'NODE', properties: { name: '张三' } },
      { id: 'c', type: 'NODE', properties: { name: '未命名' } },
      { id: 'd', type: 'NODE', properties: { name: '孤儿' } },
    ],
    edges: [{ id: 'e1', type: 'REL', source: 'a', target: 'b', properties: {} }],
  };
  var tpl = { node_types: [{ type: 'NODE', label: '节点', fields: [{ key: 'name', required: true }] }, { type: 'OTHER', label: '其他', fields: [] }] };
  console.log(JSON.stringify(deterministicAudit(sample, tpl), null, 1));
  console.log('prompt lines:', buildAuditPrompt(sample, tpl, []).split('\n').length);
  console.log(JSON.stringify(parseAuditResponse('```json\n[{"severity":"high","category":"other","issue":"x","suggestion":"y"}]\n```')));
  // 分治自检：一条 700 节点链 + 3 个小岛
  var big = { nodes: [], edges: [] };
  for (var i = 0; i < 700; i++) big.nodes.push({ id: 'n' + i, type: 'NODE', properties: { name: '节点' + i } });
  for (var j = 0; j < 699; j++) big.edges.push({ id: 'e' + j, type: 'REL', source: 'n' + j, target: 'n' + (j + 1), properties: {} });
  for (var k = 0; k < 9; k++) {
    big.nodes.push({ id: 'iso' + k, type: 'NODE', properties: { name: '孤岛' + k } });
    if (k) big.edges.push({ id: 'ie' + k, type: 'REL', source: 'iso' + (k - 1), target: 'iso' + k, properties: {} });
  }
  var parts = partitionGraph(big).partitions;
  console.log('partition sizes:', parts.map(function (p) { return p.nodes.length; }).join(','),
    '| internal edges:', parts.map(function (p) { return p.internalEdges.length; }).join(','),
    '| external:', parts.map(function (p) { return p.externalEdges.length; }).join(','));
}
