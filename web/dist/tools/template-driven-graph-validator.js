/**
 * 模板驱动图谱文档校验器（通用/金融等注册资产共用）
 *
 * 职责边界（与 X6 模板校验器分工）：
 *   本文件只做骨架检查：文档对象、nodes/edges 数组、id/type/source/target 非空、
 *   id 唯一、类型属于模板、自环禁止（按模板 validation_rules）、边端点存在。
 *   字段必填/字段类型/边端点类型约束由 x6-graph-template-validator 的 validateGraph 负责，不重复实现。
 *
 * 使用：createTemplateDrivenValidator(templatePath) → (document) => {valid, errors, warnings}
 * 模板惰性加载（首次校验时读取），注册进 org-graph.js ASSETS 一行即可。
 */
'use strict';

const fs = require('fs');

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

/** 文档骨架校验（错误码 GEN_*，对齐 validateOrgDocument 返回形状） */
function validateTemplateDrivenGraphDocument(document, template) {
  const errors = [];
  const warnings = [];
  const nodeTypes = (template.node_types || []).map(function (t) { return t.type; });
  const edgeTypes = (template.edge_types || []).map(function (t) { return t.type; });
  const allowSelfLoop = !!(template.validation_rules && template.validation_rules.allow_self_loop);

  if (!document || typeof document !== 'object') {
    return { valid: false, errors: [{ code: 'GEN_DOC_NOT_OBJECT', message: '文档不是对象' }], warnings: [] };
  }
  if (!Array.isArray(document.nodes) || !Array.isArray(document.edges)) {
    errors.push({ code: 'GEN_NODES_EDGES_ARRAY', message: 'nodes/edges 必须是数组' });
    return { valid: false, errors: errors, warnings: warnings };
  }

  const nodeIds = {};
  document.nodes.forEach(function (n, i) {
    const prefix = 'nodes[' + i + ']';
    if (!n || typeof n !== 'object' || !text(n.id) || !text(n.type)) {
      errors.push({ code: 'GEN_NODE_INVALID', message: prefix + ': 缺少 id/type' });
      return;
    }
    if (nodeTypes.indexOf(n.type) < 0) {
      errors.push({ code: 'GEN_NODE_UNKNOWN_TYPE', message: prefix + ': 未知节点类型 ' + n.type });
      return;
    }
    if (nodeIds[n.id]) {
      errors.push({ code: 'GEN_NODE_ID_DUP', message: prefix + ': 节点 id 重复 ' + n.id });
    }
    nodeIds[n.id] = n;
    if (n.properties && typeof n.properties !== 'object') {
      errors.push({ code: 'GEN_NODE_PROPERTIES_INVALID', message: prefix + ': properties 必须是对象' });
    }
  });

  const edgeIds = {};
  document.edges.forEach(function (e, i) {
    const prefix = 'edges[' + i + ']';
    if (!e || typeof e !== 'object' || !text(e.id) || !text(e.type) || !text(e.source) || !text(e.target)) {
      errors.push({ code: 'GEN_EDGE_INVALID', message: prefix + ': 缺少 id/type/source/target' });
      return;
    }
    if (edgeTypes.indexOf(e.type) < 0) {
      errors.push({ code: 'GEN_EDGE_UNKNOWN_TYPE', message: prefix + ': 未知边类型 ' + e.type });
      return;
    }
    if (edgeIds[e.id]) {
      errors.push({ code: 'GEN_EDGE_ID_DUP', message: prefix + ': 边 id 重复 ' + e.id });
    }
    edgeIds[e.id] = true;
    if (e.source === e.target && !allowSelfLoop) {
      errors.push({ code: 'GEN_EDGE_SELF_LOOP', message: prefix + ': 自环边 ' + e.source });
    }
    if (!nodeIds[e.source] || !nodeIds[e.target]) {
      errors.push({ code: 'GEN_EDGE_ENDPOINT_MISSING', message: prefix + ': 端点不存在 ' + e.source + ' → ' + e.target });
    }
  });

  if (!errors.length && !document.nodes.length) {
    warnings.push({ code: 'GEN_WARN_EMPTY_GRAPH', message: '图谱为空（0 节点）' });
  }
  return { valid: errors.length === 0, errors: errors, warnings: warnings };
}

/** 工厂：按模板路径创建资产校验器（模板惰性加载，坏模板抛错由调用方处理） */
function createTemplateDrivenValidator(templatePath) {
  let cached = null;
  return function (document) {
    if (!cached) cached = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
    return validateTemplateDrivenGraphDocument(document, cached);
  };
}

module.exports = {
  validateTemplateDrivenGraphDocument: validateTemplateDrivenGraphDocument,
  createTemplateDrivenValidator: createTemplateDrivenValidator,
};
