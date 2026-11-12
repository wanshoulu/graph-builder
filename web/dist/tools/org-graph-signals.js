'use strict';

/**
 * 组织图谱信号建边模块（UMD：浏览器 + Node 双端加载）
 *
 * 信号（搬运自 tools/schedule-agent/org-graph-builder.js，算法零改动）：
 *   report         汇报线 ×3.0（REPORTS_TO 直属关系；双向 = 上级也认识下属）
 *   member_overlap 同团队/同项目 ×4.0（组织内最强协作信号，对应 source_overlap）
 *   adamic_adar    共同邻居 ×1.5（共同汇报人/共同项目，仅贡献 ≥1.5 建边）
 *   skill_affinity 技能重叠 ×1.0（仅已有边 bonus，对应 type_affinity）
 * 权重归一化 0-10。
 *
 * 本模块供三处使用：
 *   - 日程管理 Agent（org-graph-builder.js 薄包装引用，算法同源）
 *   - 组织图谱构建工具：名册导入 → 结构边 + 信号建边 → 图文档
 *   - 未来回合 Knowledge Builder：纯函数可直接挂作「信号建边」构建阶段
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.OrgGraphSignals = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }
  function copy(value) {
    return JSON.parse(JSON.stringify(value));
  }

  // ═══════════════════ buildOrgGraph：从 org-graph-builder.js 原样搬运 ═══════════════════
  /**
   * 从企业数据构建组织图谱（与 tools/schedule-agent/org-graph-builder.js 算法同源）
   * @param {object} company { employees, projects, interactions }
   * @returns {{ nodes: Array, edges: Array, adjacency: Object, stats: Object }}
   */
  function buildOrgGraph(company) {
    var employees = company.employees;
    var projects = company.projects || [];

    var nodes = employees.map(function (e) {
      return {
        id: e.id,
        empNo: e.empNo,
        name: e.name,
        pinyin: e.pinyin,
        aliases: e.aliases || [],
        dept: e.department,
        deptName: e.deptName,
        rank: e.rank,
        team: e.team || '',
        title: e.title,
        skills: e.skills || [],
        location: e.location,
        email: e.email,
        phone: e.phone,
        managerId: e.managerId || null,
        status: e.status,
        onboardDate: e.onboardDate,
      };
    });

    // ── 加权边（无向聚合，与 wiki-graph-builder 同构） ──
    var edgeMap = {};
    function edgeKey(a, b) { return a < b ? a + '||' + b : b + '||' + a; }
    function addSignal(s, t, w, sig) {
      if (s === t) return;
      var key = edgeKey(s, t);
      if (!edgeMap[key]) edgeMap[key] = { source: s < t ? s : t, target: s < t ? t : s, weight: 0, signals: {} };
      edgeMap[key].weight += w;
      edgeMap[key].signals[sig] = true;
    }

    // 信号 1：汇报线 ×3.0
    var empById = {};
    employees.forEach(function (e) { empById[e.id] = e; });
    employees.forEach(function (e) {
      if (e.managerId && empById[e.managerId]) {
        addSignal(e.id, e.managerId, 3.0, 'report');
      }
    });

    // 信号 2：同团队/同项目 ×4.0（每人计一个关系，权重上限 8 防超级边）
    employees.forEach(function (e) {
      if (e.team && e.department) {
        var sameTeam = employees.filter(function (o) {
          return o.id !== e.id && o.department === e.department && o.team === e.team;
        });
        // 同团队全连接太重（38 人科技部），只连前 3 个（按 id 序稳定）
        sameTeam.slice(0, 3).forEach(function (o) {
          addSignal(e.id, o.id, 4.0, 'member_overlap');
        });
      }
    });
    projects.forEach(function (p) {
      var members = p.memberIds || [];
      for (var i = 0; i < members.length; i++) {
        for (var j = i + 1; j < members.length; j++) {
          addSignal(members[i], members[j], 4.0, 'member_overlap');
        }
      }
    });

    // 信号 3：共同邻居 Adamic-Adar ×1.5（仅 ≥1.5 建边）
    var neighborMap = {};
    Object.keys(edgeMap).forEach(function (k) {
      var e = edgeMap[k];
      (neighborMap[e.source] = neighborMap[e.source] || []).push(e.target);
      (neighborMap[e.target] = neighborMap[e.target] || []).push(e.source);
    });
    var ids = employees.map(function (e) { return e.id; });
    for (var a = 0; a < ids.length; a++) {
      for (var b = a + 1; b < ids.length; b++) {
        var na = neighborMap[ids[a]] || [];
        var nb = neighborMap[ids[b]] || [];
        var common = na.filter(function (n) { return nb.indexOf(n) >= 0; });
        if (!common.length) continue;
        var aa = 0;
        common.forEach(function (n) {
          var deg = (neighborMap[n] || []).length || 1;
          aa += 1 / Math.log(deg + 1);
        });
        aa *= 1.5;
        if (aa >= 1.5) addSignal(ids[a], ids[b], aa, 'adamic_adar');
      }
    }

    // 信号 4：技能重叠 ×1.0（仅已有边 bonus）
    Object.keys(edgeMap).forEach(function (k) {
      var e = edgeMap[k];
      var pa = empById[e.source];
      var pb = empById[e.target];
      if (pa && pb) {
        var overlap = (pa.skills || []).filter(function (s) { return (pb.skills || []).indexOf(s) >= 0; });
        if (overlap.length) {
          e.weight += Math.min(overlap.length, 3) * 1.0;
          e.signals.skill_affinity = true;
        }
      }
    });

    // 信号 5：近期协作（行为信号——只作边属性与查询信号，不并入结构权重，
    // 对标 Microsoft Graph people insights：协作热度是行为特征，不是组织结构）
    (company.interactions || []).forEach(function (ix) {
      var key = edgeKey(ix.empA, ix.empB);
      if (edgeMap[key]) {
        if (!edgeMap[key].interaction) edgeMap[key].interaction = { meetings30d: 0, lastDays: 99 };
        edgeMap[key].interaction.meetings30d += ix.meetings30d;
        edgeMap[key].interaction.lastDays = Math.min(edgeMap[key].interaction.lastDays, ix.lastDays);
        edgeMap[key].signals.recent_collab = true;
      }
    });

    // ── 归一化 0-10 ──
    var rawEdges = Object.keys(edgeMap).map(function (k) { return edgeMap[k]; });
    var maxW = rawEdges.reduce(function (m, e) { return Math.max(m, e.weight); }, 1);
    var edges = rawEdges.map(function (e) {
      return {
        source: e.source,
        target: e.target,
        weight: Math.round(e.weight / maxW * 1000) / 100,
        signals: Object.keys(e.signals),
        interaction: e.interaction || null, // 近期协作：{meetings30d, lastDays}，无协作则 null
      };
    }).sort(function (a, b) { return b.weight - a.weight; });

    // 邻接表（供 graph-query 推理用，weight 保留原值）
    var adjacency = {};
    edges.forEach(function (e) {
      (adjacency[e.source] = adjacency[e.source] || []).push({ id: e.target, w: e.weight, sigs: e.signals, interaction: e.interaction });
      (adjacency[e.target] = adjacency[e.target] || []).push({ id: e.source, w: e.weight, sigs: e.signals, interaction: e.interaction });
    });

    // 加权度（节点规模/枢纽）
    var wdeg = {};
    edges.forEach(function (e) {
      wdeg[e.source] = (wdeg[e.source] || 0) + e.weight;
      wdeg[e.target] = (wdeg[e.target] || 0) + e.weight;
    });
    nodes.forEach(function (n) { n.weightedDegree = Math.round((wdeg[n.id] || 0) * 100) / 100; });

    return {
      nodes: nodes,
      edges: edges,
      adjacency: adjacency,
      stats: {
        totalNodes: nodes.length,
        totalEdges: edges.length,
        strongEdges: edges.filter(function (e) { return e.weight >= 6; }).length,
        weakEdges: edges.filter(function (e) { return e.weight <= 2; }).length,
      },
    };
  }

  // ═══════════════════ 结构边：名册字段 → 图文档结构边 ═══════════════════
  /**
   * 从名册数据派生结构边（边是唯一真相；节点字段由边回填）
   * @param {Array} employees 名册行（需含 id/managerId/department/team 等字段）
   * @param {Array} projects 项目（{id, name, memberIds}）
   * @returns {Array} 图文档结构边 [{id, type, source, target, properties}]
   */
  function buildStructuralEdges(employees, projects) {
    var edges = [];
    var seq = 0;
    var empIds = {};
    (employees || []).forEach(function (e) { empIds[e.id] = true; });
    // REPORTS_TO：直属汇报（一人一个上级）
    (employees || []).forEach(function (e) {
      if (e.managerId && empIds[e.managerId] && e.managerId !== e.id) {
        edges.push({ id: 'edge-rep-' + (++seq), type: 'REPORTS_TO', source: e.id, target: e.managerId, properties: {} });
      }
    });
    // MEMBER_OF：员工属于部门
    (employees || []).forEach(function (e) {
      if (e.department) {
        edges.push({ id: 'edge-dep-' + (++seq), type: 'MEMBER_OF', source: e.id, target: e.department, properties: {} });
      }
    });
    // PARTICIPATES_IN：参与项目
    (projects || []).forEach(function (p) {
      (p.memberIds || []).forEach(function (empId) {
        if (empIds[empId]) {
          edges.push({ id: 'edge-prj-' + (++seq), type: 'PARTICIPATES_IN', source: empId, target: p.id, properties: {} });
        }
      });
    });
    return edges;
  }

  // ═══════════════════ 合并自动边 ═══════════════════
  /**
   * 重算信号边并合并进图文档：
   *   - origin 'auto' 的 COLLABORATES 边整体替换为新的 collabEdges
   *   - origin 'manual' | 'expert' 的边保留（手工权重是最终值）
   *   - document.metadata.deletedEdgeIds 中的边重算后不恢复
   *   - 结构边按 source||target||type 键幂等 upsert
   * @param {object} document 图文档（同构 x6-graph-builder-model）
   * @param {Array} collabEdges 新算出的 COLLABORATES 边（{source,target,weight,signals,interaction}）
   * @param {Array} structuralEdges 结构边数组
   * @returns {object} 新文档（原文档不被修改）
   */
  function mergeAutoEdges(document, collabEdges, structuralEdges) {
    var next = copy(document);
    var deleted = (next.metadata && next.metadata.deletedEdgeIds) || [];
    var deletedKeys = {};
    deleted.forEach(function (id) { deletedKeys[id] = true; });

    // 保留 manual/expert 的 COLLABORATES + 被标记删除键不恢复
    var keptCollab = (next.edges || []).filter(function (e) {
      if (e.type !== 'COLLABORATES') return false;
      return (e.properties && (e.properties.origin === 'manual' || e.properties.origin === 'expert'));
    });
    var keptKeys = {};
    keptCollab.forEach(function (e) { keptKeys[e.source + '||' + e.target] = true; });

    // 新 auto 边 id 避让已有 id（重算后保留边与新边 id 可能撞名）
    var usedIds = {};
    (next.edges || []).forEach(function (e) { usedIds[e.id] = true; });
    var idSeq = 0;
    function nextFreeEdgeId() {
      while (usedIds['edge-col-' + (++idSeq)]) {}
      usedIds['edge-col-' + idSeq] = true;
      return 'edge-col-' + idSeq;
    }

    var newCollab = (collabEdges || []).filter(function (e) {
      var key = e.source + '||' + e.target;
      return !keptKeys[key] && !deletedKeys[e.id || ''] && !deletedKeys[key];
    }).map(function (e) {
      // interaction 放边顶层（模板字段类型不支持对象，X6 校验器只查 properties）
      return {
        id: nextFreeEdgeId(),
        type: 'COLLABORATES',
        source: e.source,
        target: e.target,
        properties: {
          weight: e.weight,
          signals: e.signals || [],
          origin: 'auto',
        },
        interaction: e.interaction || null,
      };
    });

    // 结构边幂等 upsert（按 source||target||type）
    var structKey = {};
    (next.edges || []).forEach(function (e) {
      if (e.type === 'COLLABORATES') return;
      structKey[e.source + '||' + e.target + '||' + e.type] = e;
    });
    (structuralEdges || []).forEach(function (e) {
      structKey[e.source + '||' + e.target + '||' + e.type] = e;
    });
    var mergedStruct = Object.keys(structKey).map(function (k) { return structKey[k]; });

    next.edges = mergedStruct.concat(keptCollab).concat(newCollab);
    return next;
  }

  // ═══════════════════ 种子：企业数据 → 图文档 ═══════════════════
  /**
   * 把企业数据（mock 或真实名册）转成组织图谱图文档（节点/结构边/协作边全量）
   * @param {object} company { employees, projects, interactions }
   * @returns {object} 图文档 {document_id, template_ref, nodes, edges, metadata}
   */
  function seedDocumentFromCompany(company) {
    var employees = company.employees || [];
    var projects = company.projects || [];
    var orgGraph = buildOrgGraph(company);

    // 节点：EMPLOYEE / DEPARTMENT / PROJECT
    var nodes = [];
    employees.forEach(function (e) {
      nodes.push({
        id: e.id,
        type: 'EMPLOYEE',
        properties: {
          name: e.name, empNo: e.empNo, pinyin: e.pinyin, aliases: e.aliases || [],
          department: e.department || '', deptName: e.deptName || '', team: e.team || '',
          rank: e.rank || '', title: e.title || '', skills: e.skills || [],
          location: e.location || '', email: e.email || '', phone: e.phone || '',
          status: e.status || 'active', onboardDate: e.onboardDate || '',
        },
      });
    });
    var deptMap = {};
    employees.forEach(function (e) {
      if (e.department && !deptMap[e.department] && e.deptName) {
        deptMap[e.department] = true;
        nodes.push({ id: e.department, type: 'DEPARTMENT', properties: { name: e.deptName, parent: '' } });
      }
    });
    projects.forEach(function (p) {
      nodes.push({ id: p.id, type: 'PROJECT', properties: { name: p.name } });
    });

    // 边：结构边 + 信号协作边（origin 'auto'）
    var edges = buildStructuralEdges(employees, projects);
    var collab = orgGraph.edges.map(function (e, i) {
      // interaction 放边顶层（模板字段类型不支持对象，X6 校验器只查 properties）
      return {
        id: 'edge-col-' + (i + 1),
        type: 'COLLABORATES',
        source: e.source,
        target: e.target,
        properties: { weight: e.weight, signals: e.signals || [], origin: 'auto' },
        interaction: e.interaction || null,
      };
    });

    return {
      document_id: 'org-graph-doc',
      document_version: '1.0.0',
      asset_id: 'org-graph',
      build_task_id: 'org-graph-seed',
      name: '银行总行组织图谱',
      template_ref: { template_id: 'org-people', template_version: '1.0.0' },
      nodes: nodes,
      edges: edges.concat(collab),
      metadata: { source: 'seed:mock-42', created_at: new Date().toISOString(), deletedEdgeIds: [] },
    };
  }

  return {
    buildOrgGraph: buildOrgGraph,
    buildStructuralEdges: buildStructuralEdges,
    mergeAutoEdges: mergeAutoEdges,
    seedDocumentFromCompany: seedDocumentFromCompany,
  };
});
