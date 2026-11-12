'use strict';

/**
 * 组织图谱图模型（UMD：浏览器 + Node 双端加载）
 *
 * 图文档格式与 x6-graph-builder-model 同构：
 *   { document_id, template_ref, nodes:[{id,type,properties}], edges:[{id,type,source,target,properties}] }
 * 未来回合 Knowledge Builder 时模型层零改造。
 *
 * 本模块职责：
 *   - createOrgDocument        空文档骨架
 *   - validateOrgDocument      组织专属校验（错误码列表，发布门禁第一关）
 *   - convertToConsumerGraph   图文档 → 日程 Agent 消费形状
 *       { employees, projects, interactions, graph }
 *     graph 直接从文档 COLLABORATES 边构造（不重跑信号算法）——
 *     专家手工调整的边权重得以原样保留。
 *
 * 约定：COLLABORATES 边的 interaction（{meetings30d, lastDays}）放在边**顶层**
 * （非 properties 内），因为 org-people 模板字段类型不支持对象，
 * 而 X6 模板校验器只校验 properties —— 顶层键不受影响，模板校验可整体复用。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.OrgGraphModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ── 元素类型常量 ──
  var NODE_TYPES = { EMPLOYEE: 'EMPLOYEE', PROJECT: 'PROJECT', DEPARTMENT: 'DEPARTMENT' };
  var EDGE_TYPES = { REPORTS_TO: 'REPORTS_TO', MEMBER_OF: 'MEMBER_OF', PARTICIPATES_IN: 'PARTICIPATES_IN', COLLABORATES: 'COLLABORATES' };

  // EMPLOYEE 属性全集（与消费侧 org-graph-builder 节点 16 字段 1:1 对应）
  var EMPLOYEE_PROPERTY_KEYS = [
    'name', 'empNo', 'pinyin', 'aliases', 'department', 'deptName', 'team', 'rank',
    'title', 'skills', 'location', 'email', 'phone', 'managerId', 'status', 'onboardDate',
  ];

  // 边类型 → 端点类型约束
  var EDGE_ENDPOINTS = {};
  EDGE_ENDPOINTS[EDGE_TYPES.REPORTS_TO] = { source: [NODE_TYPES.EMPLOYEE], target: [NODE_TYPES.EMPLOYEE] };
  EDGE_ENDPOINTS[EDGE_TYPES.MEMBER_OF] = { source: [NODE_TYPES.EMPLOYEE], target: [NODE_TYPES.DEPARTMENT] };
  EDGE_ENDPOINTS[EDGE_TYPES.PARTICIPATES_IN] = { source: [NODE_TYPES.EMPLOYEE], target: [NODE_TYPES.PROJECT] };
  EDGE_ENDPOINTS[EDGE_TYPES.COLLABORATES] = { source: [NODE_TYPES.EMPLOYEE], target: [NODE_TYPES.EMPLOYEE] };

  function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }
  function isNonEmptyString(value) { return typeof value === 'string' && value.trim() !== ''; }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }

  // ═══════════════════ 空文档骨架 ═══════════════════
  function createOrgDocument(options) {
    options = options || {};
    var now = new Date().toISOString();
    return {
      document_id: options.document_id || 'org-graph-draft',
      document_version: options.document_version || '0.1.0',
      asset_id: options.asset_id || 'org-graph',
      build_task_id: options.build_task_id || null,
      name: options.name || '组织图谱',
      template_ref: { template_id: 'org-people', template_version: '1.0.0' },
      nodes: options.nodes || [],
      edges: options.edges || [],
      metadata: {
        created_at: options.created_at || now,
        updated_at: now,
        source: options.source || 'manual',
        deletedEdgeIds: options.deletedEdgeIds || [],
      },
    };
  }

  // ═══════════════════ 组织专属校验 ═══════════════════
  /**
   * 校验图文档（发布门禁第一关；模板字段符合性由 X6 模板校验器在服务端把关）
   * @param {object} document 图文档
   * @returns {{ valid: boolean, errors: Array<{code,message,path}>, warnings: Array }}
   */
  function validateOrgDocument(document) {
    var report = { valid: true, errors: [], warnings: [] };
    function add(code, message, path) { report.errors.push({ code: code, message: message, path: path }); report.valid = false; }
    function warn(code, message, path) { report.warnings.push({ code: code, message: message, path: path }); }

    if (!isPlainObject(document)) { add('DOC_NOT_OBJECT', '图文档必须是对象', 'document'); return report; }
    if (!Array.isArray(document.nodes) || !Array.isArray(document.edges)) {
      add('DOC_NODES_EDGES_ARRAY', 'nodes/edges 必须是数组', 'document');
      return report;
    }

    // ── 节点 ──
    var nodeById = {};
    var empNoSeen = {};
    var nameSeen = {};
    document.nodes.forEach(function (n, i) {
      var path = 'nodes[' + i + ']';
      if (!isPlainObject(n) || !isNonEmptyString(n.id) || !isNonEmptyString(n.type)) {
        add('NODE_INVALID', '节点必须含非空 id/type', path);
        return;
      }
      if (!NODE_TYPES[n.type]) { add('NODE_UNKNOWN_TYPE', '未知节点类型：' + n.type, path + '.type'); return; }
      if (nodeById[n.id]) { add('NODE_ID_DUP', '节点 id 重复：' + n.id, path + '.id'); return; }
      nodeById[n.id] = n;
      var props = isPlainObject(n.properties) ? n.properties : {};
      // EMPLOYEE 必填 name；PROJECT/DEPARTMENT 必填 name（图查询 same_project 关系标签依赖）
      if (!isNonEmptyString(props.name)) { add('NODE_NAME_REQUIRED', n.type + ' 节点缺少 name 属性', path + '.properties.name'); }
      if (n.type === NODE_TYPES.EMPLOYEE) {
        if (!isNonEmptyString(props.empNo)) warn('WARN_EMP_NO_MISSING', '员工缺少 empNo：' + (props.name || n.id), path);
        else if (empNoSeen[props.empNo]) add('NODE_EMP_NO_DUP', 'empNo 重复：' + props.empNo, path + '.properties.empNo');
        else empNoSeen[props.empNo] = true;
        if (isNonEmptyString(props.name)) {
          if (nameSeen[props.name]) warn('WARN_DUP_NAME', '同名员工：' + props.name, path + '.properties.name');
          else nameSeen[props.name] = true;
        }
      }
    });

    // ── 边 ──
    var edgeIdSeen = {};
    var reportsTargetSeen = {}; // 员工 → 已出现 REPORTS_TO（单出边）
    document.edges.forEach(function (e, i) {
      var path = 'edges[' + i + ']';
      if (!isPlainObject(e) || !isNonEmptyString(e.id) || !isNonEmptyString(e.type) || !isNonEmptyString(e.source) || !isNonEmptyString(e.target)) {
        add('EDGE_INVALID', '边必须含非空 id/type/source/target', path);
        return;
      }
      if (edgeIdSeen[e.id]) { add('EDGE_ID_DUP', '边 id 重复：' + e.id, path + '.id'); return; }
      edgeIdSeen[e.id] = true;
      var endpoint = EDGE_ENDPOINTS[e.type];
      if (!endpoint) { add('EDGE_UNKNOWN_TYPE', '未知边类型：' + e.type, path + '.type'); return; }
      if (e.source === e.target) { add('EDGE_SELF_LOOP', '不允许自环边', path); return; }
      var s = nodeById[e.source];
      var t = nodeById[e.target];
      if (!s || !t) { add('EDGE_ENDPOINT_MISSING', '边端点节点不存在', path); return; }
      if (endpoint.source.indexOf(s.type) < 0 || endpoint.target.indexOf(t.type) < 0) {
        add('EDGE_ENDPOINT_TYPE', '边端点类型不符：' + s.type + ' → ' + t.type + '（' + e.type + '）', path);
        return;
      }
      if (e.type === EDGE_TYPES.REPORTS_TO) {
        if (reportsTargetSeen[e.source]) add('EDGE_REPORTS_TO_MULTI', '员工存在多个直接上级：' + e.source, path);
        reportsTargetSeen[e.source] = true;
      }
      if (e.type === EDGE_TYPES.COLLABORATES) {
        var props = isPlainObject(e.properties) ? e.properties : {};
        if (props.weight != null && (typeof props.weight !== 'number' || !isFinite(props.weight) || props.weight < 0 || props.weight > 10)) {
          add('EDGE_COLLAB_WEIGHT', 'COLLABORATES 权重必须是 0-10 的数字：' + props.weight, path + '.properties.weight');
        }
      }
    });

    // ── 孤立员工（警告不阻断：新员工无协作边属正常） ──
    var connected = {};
    document.edges.forEach(function (e) {
      if (isPlainObject(e) && e.source) connected[e.source] = true;
      if (isPlainObject(e) && e.target) connected[e.target] = true;
    });
    document.nodes.forEach(function (n, i) {
      if (n.type === NODE_TYPES.EMPLOYEE && !connected[n.id]) {
        warn('WARN_ISOLATED_EMPLOYEE', '员工无任何边：' + (n.properties && n.properties.name || n.id), 'nodes[' + i + ']');
      }
    });

    return report;
  }

  // ═══════════════════ 图文档 → 消费形状 ═══════════════════
  /**
   * 图文档转日程 Agent 消费形状（边是唯一真相，节点字段由边回填）：
   *   REPORTS_TO → employees[].managerId
   *   MEMBER_OF  → employees[].department/deptName（department 来自边，deptName 取 DEPARTMENT 节点 name，属性兜底）
   *   PARTICIPATES_IN → projects[].memberIds
   *   COLLABORATES → graph.edges/adjacency（weight/signals/interaction 原样保留）+ interactions
   * @param {object} document 图文档
   * @returns {{ employees: Array, projects: Array, interactions: Array, graph: {nodes,edges,adjacency,stats} }}
   */
  function convertToConsumerGraph(document) {
    var nodes = document.nodes || [];
    var edges = document.edges || [];

    var empNodeById = {};
    var deptNodeById = {};
    var projNodeById = {};
    nodes.forEach(function (n) {
      if (n.type === NODE_TYPES.EMPLOYEE) empNodeById[n.id] = n;
      else if (n.type === NODE_TYPES.DEPARTMENT) deptNodeById[n.id] = n;
      else if (n.type === NODE_TYPES.PROJECT) projNodeById[n.id] = n;
    });

    // 边派生字段
    var managerOf = {};
    var deptOf = {};
    var projMembers = {};
    var collabEdges = [];
    var interactions = [];
    edges.forEach(function (e) {
      if (e.type === EDGE_TYPES.REPORTS_TO) { if (!managerOf[e.source]) managerOf[e.source] = e.target; }
      if (e.type === EDGE_TYPES.MEMBER_OF) { if (!deptOf[e.source]) deptOf[e.source] = e.target; }
      if (e.type === EDGE_TYPES.PARTICIPATES_IN) {
        if (projNodeById[e.target]) { (projMembers[e.target] = projMembers[e.target] || []).push(e.source); }
      }
      if (e.type === EDGE_TYPES.COLLABORATES) {
        var p = isPlainObject(e.properties) ? e.properties : {};
        var weight = typeof p.weight === 'number' ? p.weight : 1;
        // interaction 在边顶层（模板字段类型不支持对象，校验器只查 properties）；
        // 兼容早期草稿把 interaction 放在 properties 内的写法
        var interaction = isPlainObject(e.interaction) ? e.interaction : (isPlainObject(p.interaction) ? p.interaction : null);
        collabEdges.push({ source: e.source, target: e.target, weight: weight, signals: Array.isArray(p.signals) ? p.signals : [], interaction: interaction });
        if (interaction && interaction.meetings30d > 0) {
          interactions.push({ empA: e.source, empB: e.target, meetings30d: interaction.meetings30d, lastDays: interaction.lastDays != null ? interaction.lastDays : 99 });
        }
      }
    });

    // 员工（16 字段对齐消费侧；边派生优先，属性兜底）
    var employees = Object.keys(empNodeById).map(function (id) {
      var n = empNodeById[id];
      var props = isPlainObject(n.properties) ? n.properties : {};
      var department = deptOf[id] || props.department || '';
      var deptNode = deptOf[id] ? deptNodeById[deptOf[id]] : null;
      var deptName = (deptNode && isPlainObject(deptNode.properties) && deptNode.properties.name) || props.deptName || '';
      var managerId = managerOf[id] || props.managerId || null;
      return {
        id: id,
        empNo: props.empNo || '',
        name: props.name || id,
        pinyin: props.pinyin || '',
        aliases: Array.isArray(props.aliases) ? props.aliases : [],
        department: department,
        deptName: deptName,
        rank: props.rank || '',
        team: props.team || '',
        title: props.title || '',
        skills: Array.isArray(props.skills) ? props.skills : [],
        location: props.location || '',
        email: props.email || '',
        phone: props.phone || '',
        managerId: managerId,
        status: props.status || 'active',
        onboardDate: props.onboardDate || '',
      };
    });

    // 项目
    var projects = Object.keys(projNodeById).map(function (id) {
      var n = projNodeById[id];
      var props = isPlainObject(n.properties) ? n.properties : {};
      return { id: id, name: props.name || id, memberIds: projMembers[id] || [] };
    });

    // 部门（handleCompany 部门统计消费）
    var departments = Object.keys(deptNodeById).map(function (id) {
      var n = deptNodeById[id];
      var props = isPlainObject(n.properties) ? n.properties : {};
      return { id: id, name: props.name || id, parent: props.parent || null };
    });

    // graph：邻接表（对称）+ 节点加权度 + 统计（与 buildOrgGraph 输出同构）
    var adjacency = {};
    collabEdges.forEach(function (e) {
      (adjacency[e.source] = adjacency[e.source] || []).push({ id: e.target, w: e.weight, sigs: e.signals, interaction: e.interaction });
      (adjacency[e.target] = adjacency[e.target] || []).push({ id: e.source, w: e.weight, sigs: e.signals, interaction: e.interaction });
    });
    var wdeg = {};
    collabEdges.forEach(function (e) {
      wdeg[e.source] = (wdeg[e.source] || 0) + e.weight;
      wdeg[e.target] = (wdeg[e.target] || 0) + e.weight;
    });
    var graphNodes = employees.map(function (e) {
      return {
        id: e.id, empNo: e.empNo, name: e.name, pinyin: e.pinyin, aliases: e.aliases,
        dept: e.department, deptName: e.deptName, rank: e.rank, team: e.team,
        title: e.title, skills: e.skills, location: e.location, email: e.email,
        phone: e.phone, managerId: e.managerId, status: e.status, onboardDate: e.onboardDate,
        weightedDegree: Math.round((wdeg[e.id] || 0) * 100) / 100,
      };
    });

    return {
      employees: employees,
      projects: projects,
      departments: departments,
      interactions: interactions,
      graph: {
        nodes: graphNodes,
        edges: collabEdges,
        adjacency: adjacency,
        stats: {
          totalNodes: employees.length,
          totalEdges: collabEdges.length,
          strongEdges: collabEdges.filter(function (e) { return e.weight >= 6; }).length,
          weakEdges: collabEdges.filter(function (e) { return e.weight <= 2; }).length,
        },
      },
    };
  }

  return {
    NODE_TYPES: NODE_TYPES,
    EDGE_TYPES: EDGE_TYPES,
    EMPLOYEE_PROPERTY_KEYS: EMPLOYEE_PROPERTY_KEYS,
    EDGE_ENDPOINTS: EDGE_ENDPOINTS,
    createOrgDocument: createOrgDocument,
    validateOrgDocument: validateOrgDocument,
    convertToConsumerGraph: convertToConsumerGraph,
  };
});
