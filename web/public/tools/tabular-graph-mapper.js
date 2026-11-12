/**
 * 表格数据 → 图谱文档确定性映射器（无 LLM）
 *
 * 定位：补 Neo4j LLM KG Builder「不适合表格数据」的缺口。
 * CSV/JSON 行数据按模板字段做确定性建图（与 customer-ecosystem-seed 同风格，可单测断言）。
 *
 * 输入（buildDocumentFromTabular）：
 *   content       string  — CSV 全文 或 JSON 行对象数组（JSON 字符串）
 *   format        'csv' | 'json'
 *   template      模板 JSON（node_types/edge_types 用于字段类型归一与主标签字段判定）
 *   nodeMappings  [{ nodeType, idColumn?, nameColumn?, fieldMap? }]
 *       nodeType  目标节点类型（须在模板中声明）
 *       idColumn  行内 ID 列（可选；缺省用 type:hash(name) 确定性生成）
 *       nameColumn 主标签列（映射到该类型第一个必填 string/multiline 字段，通常 name）
 *       fieldMap   { 模板字段key: 列名 }，值按模板字段类型归一（number/boolean/date/tags）
 *   edgeMappings  [{ edgeType, sourceNodeType, targetNodeType, sourceColumn, targetColumn, idColumn?, weightColumn?, fieldMap? }]
 *       源/目标按 (nodeType + 主标签列值) 在节点索引中解析；缺失行计入 stats.skippedEdges
 *
 * 输出：{ document, stats: { nodeCount, edgeCount, skippedNodes, skippedEdges, errors: [...] } }
 */
'use strict';

const crypto = require('crypto');
const KnowledgeBuilderDataImport = require('./knowledge-builder-data-import');

function hash(text) {
  return crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 10);
}

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

/** 模板节点类型 → { fields: {key: field}, primaryKey } */
function buildTemplateIndex(template) {
  const index = {};
  (template.node_types || []).forEach(function (t) {
    const byKey = {};
    let primaryKey = null;
    (t.fields || []).forEach(function (f) {
      byKey[f.key] = f;
      if (!primaryKey && f.required && (f.type === 'string' || f.type === 'multiline')) primaryKey = f.key;
    });
    index[t.type] = { fields: byKey, primaryKey: primaryKey || 'name' };
  });
  return index;
}

/** 按模板字段类型归一单元格值（number/boolean/tags；其他保持原样） */
function coerce(value, field) {
  if (!field) return value;
  const t = field.type;
  if (t === 'number') {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const n = Number(text(value));
    return Number.isFinite(n) ? n : null;
  }
  if (t === 'boolean') {
    if (typeof value === 'boolean') return value;
    const s = text(value).toLowerCase();
    if (s === 'true') return true;
    if (s === 'false') return false;
    return null;
  }
  if (t === 'tags') {
    return Array.isArray(value) ? value : text(value) ? text(value).split(/[,，、;；]/).map(function (v) { return v.trim(); }).filter(Boolean) : [];
  }
  return value;
}

function parseRows(content, format) {
  if (format === 'csv') return KnowledgeBuilderDataImport.parseCsv(content);
  if (format === 'json') return KnowledgeBuilderDataImport.parseJsonRows(content);
  fail('TABULAR_FORMAT_INVALID', 'format 必须是 csv 或 json');
}

/** 表格数据 → 图谱文档（纯函数，确定性） */
function buildDocumentFromTabular(options) {
  const opts = options || {};
  if (!opts.template || typeof opts.template !== 'object') fail('TABULAR_TEMPLATE_REQUIRED', '缺少 template（模板 JSON）');
  if (!Array.isArray(opts.nodeMappings) || !opts.nodeMappings.length) fail('TABULAR_NODE_MAPPINGS_REQUIRED', '缺少 nodeMappings');
  const rows = parseRows(opts.content || '', opts.format || 'csv');
  const typeIndex = buildTemplateIndex(opts.template);
  const stats = { nodeCount: 0, edgeCount: 0, skippedNodes: 0, skippedEdges: 0, errors: [] };

  const nodes = [];
  const edges = [];
  const nodeIds = {};
  const byTypeName = {}; // nodeType + '::' + name → id

  // ① 节点：nodeMappings 依次遍历全部行（同一行可为多个类型产出节点）
  opts.nodeMappings.forEach(function (mapping) {
    if (!typeIndex[mapping.nodeType]) {
      stats.errors.push({ code: 'TABULAR_NODE_TYPE_UNKNOWN', message: '模板未声明节点类型：' + mapping.nodeType });
      return;
    }
    const def = typeIndex[mapping.nodeType];
    const nameKey = mapping.nameColumn ? String(mapping.nameColumn) : null;
    const fieldMap = mapping.fieldMap || {};
    rows.forEach(function (row) {
      const name = nameKey ? text(row[nameKey]) : text(row[def.primaryKey]);
      if (!name) { stats.skippedNodes += 1; return; }
      const id = mapping.idColumn && text(row[mapping.idColumn])
        ? text(row[mapping.idColumn])
        : mapping.nodeType + ':' + hash(name);
      const key = mapping.nodeType + '::' + name;
      if (byTypeName[key] || nodeIds[id]) return; // 同名同类型或 id 已占用 → 幂等跳过
      nodeIds[id] = true;
      byTypeName[key] = id;
      const properties = {};
      if (nameKey) properties[def.primaryKey] = name;
      Object.keys(fieldMap).forEach(function (fieldKey) {
        if (!def.fields[fieldKey]) return; // 未在模板声明的字段跳过
        const value = coerce(row[fieldMap[fieldKey]], def.fields[fieldKey]);
        if (value !== null && value !== undefined && value !== '') properties[fieldKey] = value;
      });
      nodes.push({ id: id, type: mapping.nodeType, properties: properties });
      stats.nodeCount += 1;
    });
  });

  // ② 边：引用节点索引解析端点，缺失行跳过并统计
  const edgeIds = {};
  (opts.edgeMappings || []).forEach(function (mapping) {
    if (!mapping.edgeType || !mapping.sourceNodeType || !mapping.targetNodeType) {
      stats.errors.push({ code: 'TABULAR_EDGE_MAPPING_INVALID', message: 'edgeMappings 项缺少 edgeType/sourceNodeType/targetNodeType' });
      return;
    }
    const fieldMap = mapping.fieldMap || {};
    rows.forEach(function (row, rowIndex) {
      const sourceId = byTypeName[mapping.sourceNodeType + '::' + text(row[mapping.sourceColumn])];
      const targetId = byTypeName[mapping.targetNodeType + '::' + text(row[mapping.targetColumn])];
      if (!sourceId || !targetId) { stats.skippedEdges += 1; return; }
      const id = mapping.idColumn && text(row[mapping.idColumn])
        ? text(row[mapping.idColumn])
        : 'edge:' + mapping.edgeType + ':' + hash(sourceId + '->' + targetId + '#' + rowIndex);
      if (edgeIds[id]) return;
      edgeIds[id] = true;
      const properties = {};
      if (mapping.weightColumn && text(row[mapping.weightColumn])) {
        const weight = Number(text(row[mapping.weightColumn]));
        if (Number.isFinite(weight)) properties.weight = weight;
      }
      Object.keys(fieldMap).forEach(function (fieldKey) {
        const value = text(row[fieldMap[fieldKey]]);
        if (value !== '') properties[fieldKey] = value;
      });
      edges.push({ id: id, type: mapping.edgeType, source: sourceId, target: targetId, properties: properties });
      stats.edgeCount += 1;
    });
  });

  const document = {
    document_id: 'tabular-generated',
    document_version: '1.0.0',
    asset_id: (opts.template && opts.template.template_id) || 'tabular',
    template_ref: {
      template_id: opts.template.template_id,
      template_version: opts.template.template_version,
    },
    nodes: nodes,
    edges: edges,
    metadata: {
      source: 'tabular:' + (opts.format || 'csv'),
      generated_at: new Date().toISOString(),
    },
  };
  return { document: document, stats: stats };
}

module.exports = { buildDocumentFromTabular: buildDocumentFromTabular };
