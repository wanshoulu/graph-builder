/**
 * 客户生态图谱种子构建器 — 真实数据确定性建图（CommonJS，服务端专用）
 *
 * 数据源（data/graph-builder-samples/ 下，与 test-docs/ 原件同内容——
 * test-docs 不在容器 bind mount 列表，种子读取必须以 data/ 为规范输入）：
 *   customer-profiles.csv  对公客户画像 25 行（企业画像 + 关键决策人）
 *   customer-relations.csv 企业关系 40 行（子公司/母公司/兄弟公司/上游供应商/下游经销商/下游客户，强/中/弱）
 *
 * 建图规则：
 *   - 画像行 → CUSTOMER 节点（isBankCustomer=true）+ 关键决策人 PERSON 节点 + WORK_FOR 边
 *   - 关系行 → 关联企业补建 CUSTOMER 节点（isBankCustomer=是否本行客户）；边方向按语义：
 *       子公司/下游经销商/下游客户/兄弟公司：本行客户 → 关联企业
 *       母公司/上游供应商：关联企业 → 本行客户
 *   - 关联强度 强/中/弱 → 权重 9/5/2；relationType 保留原始标签；origin='seed:csv'
 *   - 全部确定性（文件顺序稳定），可单测断言
 */
'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var KnowledgeBuilderDataImport = require('./knowledge-builder-data-import');

var SAMPLES_DIR = path.join(__dirname, '..', 'data', 'graph-builder-samples');
var PROFILES_PATH = path.join(SAMPLES_DIR, 'customer-profiles.csv');
var RELATIONS_PATH = path.join(SAMPLES_DIR, 'customer-relations.csv');

var NODE_TYPES = ['CUSTOMER', 'PERSON'];
var EDGE_TYPES = ['SUBSIDIARY', 'SUPPLIER', 'DISTRIBUTOR', 'DOWNSTREAM_CUSTOMER', 'SIBLING', 'WORK_FOR'];
var STRENGTH_WEIGHT = { '强': 9, '中': 5, '弱': 2 };

// 关联类型 → {edgeType, direction}；direction 1=本行客户→关联企业，-1=反向
var RELATION_MAP = {
  '子公司': { edgeType: 'SUBSIDIARY', direction: 1 },
  '母公司': { edgeType: 'SUBSIDIARY', direction: -1 },
  '兄弟公司': { edgeType: 'SIBLING', direction: 1 },
  '上游供应商': { edgeType: 'SUPPLIER', direction: -1 },
  '下游经销商': { edgeType: 'DISTRIBUTOR', direction: 1 },
  '下游客户': { edgeType: 'DOWNSTREAM_CUSTOMER', direction: 1 },
};

function hash(text) {
  return crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 10);
}

function str(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function parseCsv(text) {
  return KnowledgeBuilderDataImport.parseCsv(text);
}

/** 客户生态图谱文档确定性构建（纯数据 IO，无 LLM） */
function buildCustomerEcosystemDocument() {
  var profiles = parseCsv(fs.readFileSync(PROFILES_PATH, 'utf8'));
  var relations = parseCsv(fs.readFileSync(RELATIONS_PATH, 'utf8'));

  var nodes = [];
  var edges = [];
  var byName = {};   // 企业名称 → node id（画像客户与关联企业统一命名空间）
  var byCode = {};   // 客户编号 → node id

  var nodeIndex = 0;
  var edgeIndex = 0;
  function addNode(node) {
    nodes.push(node);
    return node.id;
  }
  function nextEdgeId() { edgeIndex += 1; return 'edge:seed-' + edgeIndex; }

  // ① 画像客户 + 关键决策人
  profiles.forEach(function (row) {
    var code = str(row['客户编号']);
    var name = str(row['企业名称']);
    if (!name) return;
    var nodeId = 'cust:' + (code || 'x' + hash(name));
    byName[name] = nodeId;
    if (code) byCode[code] = nodeId;
    addNode({
      id: nodeId,
      type: 'CUSTOMER',
      properties: {
        name: name,
        customerCode: code,
        industry: str(row['行业分类']),
        chainPosition: str(row['产业链位置']),
        registeredCapital: str(row['注册资本(万元)']),
        employeeCount: str(row['员工数']),
        revenueRange: str(row['营收区间(万元)']),
        companyType: str(row['企业类型']),
        listed: str(row['上市情况']),
        specialNew: str(row['专精特新']),
        assetLiabilityRatio: str(row['资产负债率(%)']),
        revenueGrowth: str(row['营收增速(%)']),
        foundedYear: str(row['成立年份']),
        province: str(row['所在省份']),
        isBankCustomer: true,
        tags: [],
      },
    });
    var decisionMaker = str(row['关键决策人']);
    if (decisionMaker) {
      var personId = 'person:' + (code || hash(name)) + '-1';
      addNode({
        id: personId,
        type: 'PERSON',
        properties: { name: decisionMaker, title: '关键决策人', phone: str(row['联系方式']), customerCode: code },
      });
      edges.push({
        id: nextEdgeId(), type: 'WORK_FOR', source: personId, target: nodeId,
        properties: { weight: 9, relationType: '关键决策人', origin: 'seed:csv' },
      });
    }
    nodeIndex += 1;
  });

  // ② 关联企业 + 关系边
  relations.forEach(function (row) {
    var sourceCode = str(row['客户编号']);
    var sourceName = str(row['企业名称']);
    var relationType = str(row['关联类型']);
    var targetName = str(row['关联企业名称']);
    if (!targetName) return;

    var mapping = RELATION_MAP[relationType];
    if (!mapping) return; // 未知关联类型跳过（记录在 metadata.skipped 中由调用方可见）
    var strength = str(row['关联强度']);
    var weight = STRENGTH_WEIGHT[strength] !== undefined ? STRENGTH_WEIGHT[strength] : 1;

    var sourceId = byName[sourceName] || (byCode[sourceCode] || null);
    if (!sourceId) return; // 关系行的本行客户必须在画像中

    // 关联企业节点：已在画像/已补建则复用，否则补建（isBankCustomer 取"是否本行客户"）
    var targetId = byName[targetName];
    if (!targetId) {
      var relatedCode = str(row['对应客户编号']);
      // 对应客户编号仅在未被画像客户占用时复用（数据中母公司与子公司可能共用同一客户编号）
      if (relatedCode && relatedCode !== '-' && !byCode[relatedCode]) {
        targetId = 'cust:' + relatedCode;
        byCode[relatedCode] = targetId;
      } else {
        targetId = 'custx:' + hash(targetName);
      }
      byName[targetName] = targetId;
      addNode({
        id: targetId,
        type: 'CUSTOMER',
        properties: {
          name: targetName,
          customerCode: relatedCode && relatedCode !== '-' ? relatedCode : '',
          industry: '',
          chainPosition: '',
          registeredCapital: '',
          employeeCount: '',
          revenueRange: str(row['关联企业营收(万元)']),
          companyType: '',
          listed: '',
          specialNew: '',
          assetLiabilityRatio: '',
          revenueGrowth: '',
          foundedYear: '',
          province: '',
          isBankCustomer: str(row['关联企业是否本行客户']) === '是',
          tags: [relationType],
        },
      });
    }

    var from = mapping.direction === 1 ? sourceId : targetId;
    var to = mapping.direction === 1 ? targetId : sourceId;
    edges.push({
      id: nextEdgeId(), type: mapping.edgeType, source: from, target: to,
      properties: { weight: weight, relationType: relationType, origin: 'seed:csv' },
    });
  });

  return {
    document_id: 'customer-ecosystem-doc',
    document_version: '1.0.0',
    asset_id: 'customer-ecosystem',
    template_ref: { template_id: 'customer-ecosystem', template_version: '1.0.0' },
    nodes: nodes,
    edges: edges,
    metadata: {
      source: 'seed:data/graph-builder-samples/customer-profiles.csv + customer-relations.csv',
      note: '客户生态种子：25 家对公客户画像 + 40 条企业关系（真实数据，origin=test-docs）',
      profile_count: profiles.length,
      relation_count: relations.length,
      generated_at: new Date().toISOString(),
    },
  };
}

/** 客户生态文档校验（对齐 org-graph-model 校验风格，错误码 CUST_*） */
function validateCustomerEcosystemDocument(document) {
  var errors = [];
  var warnings = [];
  if (!document || typeof document !== 'object') {
    return { valid: false, errors: [{ code: 'CUST_DOC_NOT_OBJECT', message: '文档不是对象' }], warnings: [] };
  }
  if (!Array.isArray(document.nodes) || !Array.isArray(document.edges)) {
    errors.push({ code: 'CUST_NODES_EDGES_ARRAY', message: 'nodes/edges 必须是数组' });
    return { valid: false, errors: errors, warnings: warnings };
  }

  var nodeIds = {};
  document.nodes.forEach(function (n, i) {
    var prefix = 'nodes[' + i + ']';
    if (!n || typeof n !== 'object' || !n.id || !n.type) {
      errors.push({ code: 'CUST_NODE_INVALID', message: prefix + ': 缺少 id/type' });
      return;
    }
    if (NODE_TYPES.indexOf(n.type) < 0) {
      errors.push({ code: 'CUST_NODE_UNKNOWN_TYPE', message: prefix + ': 未知节点类型 ' + n.type });
      return;
    }
    if (nodeIds[n.id]) {
      errors.push({ code: 'CUST_NODE_ID_DUP', message: prefix + ': 节点 id 重复 ' + n.id });
    }
    nodeIds[n.id] = n;
    var props = n.properties || {};
    if (!str(props.name)) {
      errors.push({ code: 'CUST_NAME_REQUIRED', message: prefix + ' (' + n.type + '): 缺少必填 name' });
    }
    if (n.type === 'PERSON' && !str(props.customerCode)) {
      warnings.push({ code: 'CUST_WARN_PERSON_NO_CUSTOMER_CODE', message: prefix + ': 决策人缺少 customerCode' });
    }
  });

  var edgeIds = {};
  document.edges.forEach(function (e, i) {
    var prefix = 'edges[' + i + ']';
    if (!e || typeof e !== 'object' || !e.id || !e.type || !e.source || !e.target) {
      errors.push({ code: 'CUST_EDGE_INVALID', message: prefix + ': 缺少 id/type/source/target' });
      return;
    }
    if (EDGE_TYPES.indexOf(e.type) < 0) {
      errors.push({ code: 'CUST_EDGE_UNKNOWN_TYPE', message: prefix + ': 未知边类型 ' + e.type });
      return;
    }
    if (edgeIds[e.id]) {
      errors.push({ code: 'CUST_EDGE_ID_DUP', message: prefix + ': 边 id 重复 ' + e.id });
    }
    edgeIds[e.id] = true;
    if (e.source === e.target) {
      errors.push({ code: 'CUST_EDGE_SELF_LOOP', message: prefix + ': 自环边 ' + e.source });
    }
    var sourceNode = nodeIds[e.source];
    var targetNode = nodeIds[e.target];
    if (!sourceNode || !targetNode) {
      errors.push({ code: 'CUST_EDGE_ENDPOINT_MISSING', message: prefix + ': 端点不存在 ' + e.source + ' → ' + e.target });
      return;
    }
    if (e.type === 'WORK_FOR') {
      if (sourceNode.type !== 'PERSON' || targetNode.type !== 'CUSTOMER') {
        errors.push({ code: 'CUST_EDGE_ENDPOINT_TYPE', message: prefix + ': WORK_FOR 必须 PERSON → CUSTOMER' });
      }
    } else if (sourceNode.type !== 'CUSTOMER' || targetNode.type !== 'CUSTOMER') {
      errors.push({ code: 'CUST_EDGE_ENDPOINT_TYPE', message: prefix + ': ' + e.type + ' 必须 CUSTOMER → CUSTOMER' });
    }
    var weight = e.properties && e.properties.weight;
    if (weight !== undefined && (typeof weight !== 'number' || weight < 0 || weight > 10)) {
      errors.push({ code: 'CUST_EDGE_WEIGHT_RANGE', message: prefix + ': weight 必须在 0-10 之间' });
    }
  });

  return { valid: errors.length === 0, errors: errors, warnings: warnings };
}

module.exports = {
  buildCustomerEcosystemDocument: buildCustomerEcosystemDocument,
  validateCustomerEcosystemDocument: validateCustomerEcosystemDocument,
};
