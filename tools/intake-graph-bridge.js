/**
 * 图谱 JSON ↔ 知识导入 Excel 双向转换桥接模块
 *
 * 方向1：graph JSON → Intake 一体化填写 Excel
 *   AGGREGATE_INTENT 节点 → 功能行
 *   INTENT 节点 → 意图行（funcPath 由 has_leaf_intent 边推导）
 *   INTENT 节点的 utterance_view tags → 说法行
 *
 * 方向2：Intake Excel → graph JSON
 *   功能行 → AGGREGATE_INTENT 节点
 *   意图行 → INTENT 节点 + has_leaf_intent 边
 *   说法行 → INTENT 节点的 utterance_view tags
 */

var XLSX = require('xlsx');

// ── Intake 一体化填写列定义（与 knowledge-intake.js 中 FLAT_COLUMNS 保持一致）──

var FLAT_COLUMNS = [
  { key: 'path',              name: '功能全路径' },
  { key: 'fname',             name: '功能名称' },
  { key: 'fdesc',             name: '功能描述' },
  { key: 'clientClass',       name: '客户分类' },
  { key: 'securityLevel',     name: '安全分级' },
  { key: 'department',        name: '责任部门' },
  { key: 'fstatus',           name: '功能状态' },
  { key: 'fdomain',           name: '功能业务域' },
  { key: 'fmenuKey',          name: '功能菜单键' },
  { key: 'iname',             name: '意图名称' },
  { key: 'idomain',           name: '意图业务域' },
  { key: 'imenuKey',          name: '意图菜单键' },
  { key: 'iaction',           name: '动作类型' },
  { key: 'isourceAction',     name: '来源动作' },
  { key: 'intentType',        name: '意图类型' },
  { key: 'idesc',             name: '意图描述' },
  { key: 'igoal',             name: '用户目标' },
  { key: 'triggerScene',      name: '触发场景' },
  { key: 'scopeIn',           name: '范围边界-包含' },
  { key: 'scopeOut',          name: '范围边界-排除' },
  { key: 'roles',             name: '涉及角色' },
  { key: 'iconfusable',       name: '易混意图' },
  { key: 'disambiguationHints', name: '消歧提示' },
  { key: 'businessObjects',   name: '涉及业务对象' },
  { key: 'keySlots',          name: '关键要素' },
  { key: 'answerForm',        name: '答案形态' },
  { key: 'heat',              name: '热度' },
  { key: 'aliases',           name: '别名列表' },
  { key: 'recallTerms',       name: '召回关键词' },
  { key: 'recallTermSets',    name: '召回词组' },
  { key: 'negativeExamples',  name: '排除说法' },
  { key: 'semanticPriority',  name: '语义优先级' },
  { key: 'executionMode',      name: '执行模式' },
  { key: 'riskLevel',         name: '风险等级' },
  { key: 'readiness',         name: '就绪状态' },
  { key: 'requiredSlots',     name: '必需参数' },
  { key: 'capabilityBindings', name: '系统能力绑定' },
  { key: 'businessObjectId',  name: '业务对象标识' },
  { key: 'taskPolicyShapes',  name: '结果展示形式' },
  { key: 'taskPolicyMode',    name: '任务模式' },
  { key: 'taskPolicyMaxTasks', name: '最大任务数' },
  { key: 'contextPolicyRetain', name: '追问保留上下文' },
  { key: 'contextPolicySwitch', name: '允许中途切换' },
  { key: 'contextPolicyResumable', name: '中断后可恢复' },
  { key: 'responsePolicy',    name: '响应策略' },
  { key: 'orchestrationMode', name: '编排模式' },
  { key: 'lifecycle',         name: '生命周期' },
  { key: 'semanticVersion',   name: '语义版本' },
  { key: 'owner',             name: '负责团队' },
  { key: 'sourceChannel',     name: '来源渠道' },
  { key: 'sourceMenuId',      name: '来源菜单ID' },
  { key: 'sourceActionId',    name: '来源动作ID' },
  { key: 'istatus',           name: '意图状态' },
  { key: 'kind',              name: '说法类型' },
  { key: 'text',              name: '说法文本' },
  { key: 'source',            name: '说法来源' },
  { key: 'confidence',        name: '置信度' },
  { key: 'ustatus',           name: '说法状态' },
  { key: 'note',              name: '备注' },
];

var FLAT_SHEET = '一体化填写';

// ── 图谱节点 properties → Intake 意图列 映射表 ──

var INTENT_PROP_TO_FLAT = {
  'name':                   'iname',
  'domain':                 'idomain',
  'intent_type':            'intentType',
  'goal':                   'igoal',
  'description':            'idesc',
  'scope_in':               'scopeIn',
  'scope_out':              'scopeOut',
  'confusable_intents':    'iconfusable',
  'disambiguation_hints':  'disambiguationHints',
  'utterance_view':         'aliases',
  'object_view':            'businessObjects',
  'action_view':            'keySlots',
  'fulfillment_kind':       'executionMode',
  'required_slot_refs':     'requiredSlots',
  'tb_action_code':         'iaction',
  'tb_action_name':         'isourceAction',
  'tb_object_name':         'businessObjectId',
  'route_type':             'answerForm',
  'standard_navigation_path': 'imenuKey',
  'answer_text':            'responsePolicy',
  'result_template':        'taskPolicyShapes',
  'answer_ref':             'capabilityBindings',
  'query_ref':              'capabilityBindings',
  'menu_ref':               'capabilityBindings',
  'skill_ref':              'capabilityBindings',
  'workflow_ref':           'capabilityBindings',
  'agent_ref':              'capabilityBindings',
  'confirmation_policy':    'contextPolicyRetain',
};

// ── 图谱 AGGREGATE_INTENT properties → Intake 功能列 映射表 ──

var AGG_PROP_TO_FLAT = {
  'name':          'fname',
  'domain':        'fdomain',
  'description':   'fdesc',
  'goal':          'fdesc',
  'boundary_note': 'fdesc',
  'scope_in':      'scopeIn',
  'scope_out':     'scopeOut',
};

// ── tags 数组 → 逗号分隔字符串 ──

function tagsToStr(val) {
  if (!val) return '';
  if (Array.isArray(val)) return val.join(',');
  return String(val);
}

// ── 字符串 → tags 数组 ──

function strToTags(str) {
  if (!str) return [];
  if (Array.isArray(str)) return str;
  return String(str).split(/[,，;；、]/).map(function (s) { return s.trim(); }).filter(Boolean);
}

/**
 * 图谱 JSON → Intake 一体化填写 Excel Buffer
 * @param {Object} doc - 图谱文档 { nodes, edges, ... }
 * @returns {{ buffer: Buffer, fileName: string }}
 */
function graphToIntakeExcel(doc) {
  var nodes = (doc && doc.nodes) || [];
  var edges = (doc && doc.edges) || [];

  // 1. 建立 AGGREGATE_INTENT 节点索引：id → path
  var aggNodes = nodes.filter(function (n) { return n.type === 'AGGREGATE_INTENT'; });
  var aggPath = {}; // nodeId → path
  aggNodes.forEach(function (n) {
    var name = (n.properties && n.properties.name) || n.id;
    var domain = (n.properties && n.properties.domain) || '';
    aggPath[n.id] = domain ? (domain + '/' + name) : name;
  });

  // 2. 建立 has_leaf_intent 边索引：INTENT nodeId → AGGREGATE_INTENT path
  var intentToParent = {}; // intentNodeId → parentPath
  edges.forEach(function (e) {
    if (e.type === 'has_leaf_intent' && aggPath[e.source]) {
      intentToParent[e.target] = aggPath[e.source];
    }
  });

  // 2b. 建立 same_as 边索引：INTENT nodeId → [BUSINESS_OBJECT names], [ACTION names]
  var boIndex = {}; // nodeId → { name }
  var actionIndex = {}; // nodeId → { name }
  var boNodes = {};
  var actionNodes = {};
  nodes.forEach(function (n) {
    if (n.type === 'BUSINESS_OBJECT') boNodes[n.id] = (n.properties && n.properties.name) || n.id;
    if (n.type === 'ACTION') actionNodes[n.id] = (n.properties && n.properties.name) || n.id;
  });
  edges.forEach(function (e) {
    if (e.type !== 'same_as') return;
    // INTENT → BUSINESS_OBJECT
    if (boNodes[e.target]) { boIndex[e.source] = boIndex[e.source] || []; boIndex[e.source].push(boNodes[e.target]); }
    if (boNodes[e.source]) { boIndex[e.target] = boIndex[e.target] || []; boIndex[e.target].push(boNodes[e.source]); }
    // INTENT → ACTION
    if (actionNodes[e.target]) { actionIndex[e.source] = actionIndex[e.source] || []; actionIndex[e.source].push(actionNodes[e.target]); }
    if (actionNodes[e.source]) { actionIndex[e.target] = actionIndex[e.target] || []; actionIndex[e.target].push(actionNodes[e.source]); }
  });

  // 3. is_child_of 边：子 AGGREGATE_INTENT → 父 AGGREGATE_INTENT（拓扑序处理多级嵌套）
  var childEdges = edges.filter(function (e) { return e.type === 'is_child_of' && aggPath[e.source] && aggPath[e.target]; });
  var isChild = {}; // nodeId → true if this node is a child of another
  childEdges.forEach(function (e) { isChild[e.source] = true; });
  var processed = {};
  var maxIter = childEdges.length + 1;
  while (childEdges.length > 0 && maxIter-- > 0) {
    var progressed = false;
    for (var i = childEdges.length - 1; i >= 0; i--) {
      var e = childEdges[i];
      // 父节点如果自身也是子节点，需先处理其父边
      if (isChild[e.target] && !processed[e.target]) continue;
      var parentPath = aggPath[e.target];
      var childNode = nodes.find(function (n) { return n.id === e.source; });
      if (childNode && parentPath) {
        aggPath[e.source] = parentPath + '/' + ((childNode.properties && childNode.properties.name) || e.source);
        processed[e.source] = true;
        childEdges.splice(i, 1);
        progressed = true;
      }
    }
    if (!progressed) break;
  }

  var rows = [];

  // 4. 输出功能行（AGGREGATE_INTENT）
  aggNodes.forEach(function (n) {
    var p = n.properties || {};
    var row = {};
    FLAT_COLUMNS.forEach(function (c) { row[c.key] = ''; });
    row.path = aggPath[n.id] || p.name || n.id;
    Object.keys(AGG_PROP_TO_FLAT).forEach(function (pk) {
      var fk = AGG_PROP_TO_FLAT[pk];
      if (p[pk] && !row[fk]) row[fk] = String(p[pk]);
    });
    row.fstatus = '启用';
    row.clientClass = '个人客户';
    row.securityLevel = 'L2';
    row.department = p.domain || '';
    rows.push(row);
  });

  // 5. 输出意图行（INTENT）+ 说法行
  var intentNodes = nodes.filter(function (n) { return n.type === 'INTENT'; });
  intentNodes.forEach(function (n) {
    var p = n.properties || {};
    var parentPath = intentToParent[n.id] || (p.domain ? p.domain : '');
    var row = {};
    FLAT_COLUMNS.forEach(function (c) { row[c.key] = ''; });
    row.path = parentPath;
    row.istatus = '生效';

    // 映射 properties → flat columns
    Object.keys(INTENT_PROP_TO_FLAT).forEach(function (pk) {
      var fk = INTENT_PROP_TO_FLAT[pk];
      var val = p[pk];
      if (val === undefined || val === null || val === '') return;
      var strVal;
      if (Array.isArray(val)) {
        strVal = val.join(',');
      } else if (typeof val === 'boolean') {
        strVal = val ? '是' : '否';
      } else {
        strVal = String(val);
      }
      // 多个图谱属性映射到同一 Intake 列时，追加而非覆盖
      if (row[fk] && row[fk] !== strVal) {
        row[fk] = row[fk] + ',' + strVal;
      } else {
        row[fk] = strVal;
      }
    });

    // 补充 same_as 边关联的 BUSINESS_OBJECT 和 ACTION 名称
    if (boIndex[n.id] && boIndex[n.id].length > 0) {
      var existingBO = row.businessObjects ? row.businessObjects.split(',') : [];
      boIndex[n.id].forEach(function (name) {
        if (existingBO.indexOf(name) < 0) existingBO.push(name);
      });
      row.businessObjects = existingBO.join(',');
    }
    if (actionIndex[n.id] && actionIndex[n.id].length > 0) {
      var existingAction = row.keySlots ? row.keySlots.split(',') : [];
      actionIndex[n.id].forEach(function (name) {
        if (existingAction.indexOf(name) < 0) existingAction.push(name);
      });
      row.keySlots = existingAction.join(',');
    }

    // intent_type 枚举映射
    if (p.intent_type) {
      row.intentType = p.intent_type;
    }

    // 补充默认值
    if (!row.answerForm) row.answerForm = '话术答复';
    if (!row.heat) row.heat = 'P2-低频';

    rows.push(row);

    // 6. 输出说法行（utterance_view tags）
    var utterances = strToTags(p.utterance_view);
    utterances.forEach(function (text) {
      var urow = {};
      FLAT_COLUMNS.forEach(function (c) { urow[c.key] = ''; });
      urow.path = parentPath;
      urow.iname = p.name || '';
      urow.kind = '扩展问';
      urow.text = text;
      urow.source = '图谱导入';
      urow.confidence = '1.0';
      urow.ustatus = '候选';
      rows.push(urow);
    });
  });

  // 7. 生成 Excel
  var header = FLAT_COLUMNS.map(function (c) { return c.name; });
  var data = rows.map(function (r) {
    return FLAT_COLUMNS.map(function (c) { return r[c.key] || ''; });
  });

  // 8. 质量校验告警（跨意图重复说法、共享描述）
  var gWarnings = [];
  var uttOwner = {};
  var descOwnerGraph = {};
  intentNodes.forEach(function (n) {
    var p = n.properties || {};
    var utts = Array.isArray(p.utterance_view) ? p.utterance_view : strToTags(p.utterance_view);
    utts.forEach(function (u) {
      var key = String(u).trim();
      if (!key) return;
      if (!uttOwner[key]) uttOwner[key] = [];
      uttOwner[key].push(n.id);
    });
    var desc = (p.description || '').trim();
    if (desc) {
      if (!descOwnerGraph[desc]) descOwnerGraph[desc] = [];
      descOwnerGraph[desc].push(n.id);
    }
  });
  Object.keys(uttOwner).forEach(function (u) {
    if (uttOwner[u].length > 1) {
      gWarnings.push({ level: 'error', type: 'cross_intent_utterance', message: '说法「' + u + '」同时出现在多个意图节点：' + uttOwner[u].join(', ') + '（歧义说法应删除或交给下游裁决）' });
    }
  });
  Object.keys(descOwnerGraph).forEach(function (d) {
    if (descOwnerGraph[d].length > 1) {
      gWarnings.push({ level: 'warn', type: 'duplicate_description', message: '描述跨意图重复（稀释向量空间）：「' + d.slice(0, 30) + '...」→ ' + descOwnerGraph[d].join(', ') });
    }
  });

  var wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([header].concat(data)), FLAT_SHEET);
  var buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  var domain = (doc.template_ref && doc.template_ref.template_id) || 'intent-graph';
  return { buffer: buffer, fileName: domain + '-一体化填写.xlsx', warnings: gWarnings };
}

/**
 * Intake Excel Buffer → 图谱 JSON
 * @param {Buffer} buffer - xlsx 文件内容
 * @returns {{ document: Object, stats: Object }}
 */
function intakeExcelToGraph(buffer) {
  var wb = XLSX.read(buffer, { type: 'buffer' });

  // 自动检测格式：多表格式（gitcode 8-Sheet）或扁平格式
  if (msIsMultiSheet(wb)) {
    return multiSheetExcelToGraph(buffer);
  }

  // 读取一体化填写 sheet（或三张分表）
  var rows = [];
  if (wb.Sheets[FLAT_SHEET]) {
    var sheet = wb.Sheets[FLAT_SHEET];
    var rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    if (rawRows.length < 2) return { document: emptyDoc(), stats: { count: 0 } };
    var headers = rawRows[0];
    var keyMap = {};
    FLAT_COLUMNS.forEach(function (c) {
      var idx = headers.indexOf(c.name);
      if (idx >= 0) keyMap[c.key] = idx;
    });
    for (var i = 1; i < rawRows.length; i++) {
      var r = rawRows[i];
      if (!r.join('').trim()) continue;
      var row = {};
      Object.keys(keyMap).forEach(function (k) {
        row[k] = String(r[keyMap[k]] || '').trim();
      });
      rows.push(row);
    }
  } else {
    return { document: emptyDoc(), stats: { count: 0, error: '未找到一体化填写 Sheet' } };
  }

  // 解析为功能/意图/说法
  var functions = {};  // path → { name, domain, description, ... }
  var intents = {};    // path/iname → { name, funcPath, domain, ... , utterances: [] }
  var currentIntentRef = null;

  rows.forEach(function (r) {
    var path = r.path;
    if (!path) return;

    // 功能行：有 path 但无 iname
    if (!r.iname) {
      if (!functions[path]) {
        functions[path] = {
          name: r.fname || path.split('/').pop(),
          domain: r.fdomain || path.split('/')[0] || '',
          description: r.fdesc || '',
          status: r.fstatus || '启用',
          scopeIn: r.scopeIn || '',
          scopeOut: r.scopeOut || '',
        };
      } else {
        // 补充字段
        if (r.fname) functions[path].name = r.fname;
        if (r.fdomain) functions[path].domain = r.fdomain;
        if (r.fdesc) functions[path].description = r.fdesc;
      }
      currentIntentRef = null;
      return;
    }

    // 意图行：有 path + iname
    var intentRef = path + '/' + r.iname;
    if (!intents[intentRef]) {
      intents[intentRef] = {
        name: r.iname,
        funcPath: path,
        domain: r.idomain || functions[path] && functions[path].domain || '',
        intentType: r.intentType || 'QUERY',
        description: r.idesc || '',
        goal: r.igoal || '',
        scopeIn: r.scopeIn || '',
        scopeOut: r.scopeOut || '',
        confusableIntents: r.iconfusable || '',
        disambiguationHints: r.disambiguationHints || '',
        aliases: r.aliases || '',
        recallTerms: r.recallTerms || '',
        recallTermSets: r.recallTermSets || '',
        negativeExamples: r.negativeExamples || '',
        executionMode: r.executionMode || '',
        requiredSlots: r.requiredSlots || '',
        businessObjects: r.businessObjects || '',
        answerForm: r.answerForm || '话术答复',
        heat: r.heat || 'P2-低频',
        status: r.istatus || '生效',
        actionType: r.iaction || '',
        sourceAction: r.isourceAction || '',
        businessObjectId: r.businessObjectId || '',
        menuKey: r.imenuKey || '',
        responsePolicy: r.responsePolicy || '',
        keySlots: r.keySlots || '',
        taskPolicyShapes: r.taskPolicyShapes || '',
        capabilityBindings: r.capabilityBindings || '',
        contextPolicyRetain: r.contextPolicyRetain || '',
        semanticPriority: r.semanticPriority || '',
        utterances: [],
      };
      currentIntentRef = intentRef;
    }

    // 说法行：有 text
    if (r.text && currentIntentRef) {
      intents[currentIntentRef].utterances.push({
        text: r.text,
        kind: r.kind || '扩展问',
        source: r.source || 'Excel导入',
        confidence: r.confidence || '',
        status: r.ustatus || '候选',
      });
    }
  });

  // 转换为图谱节点和边
  var nodes = [];
  var edges = [];

  // 功能 → AGGREGATE_INTENT 节点
  var funcNodeId = {};
  Object.keys(functions).forEach(function (path) {
    var f = functions[path];
    var nodeId = 'agg:' + path.replace(/[\/\s]/g, '_');
    funcNodeId[path] = nodeId;
    nodes.push({
      id: nodeId,
      type: 'AGGREGATE_INTENT',
      properties: {
        name: f.name,
        domain: f.domain,
        description: f.description,
        goal: '',
        scope_in: strToTags(f.scopeIn || ''),
        scope_out: strToTags(f.scopeOut || ''),
        boundary_note: '',
        modeling_role: 'aggregate',
      },
    });
  });

  // 意图 → INTENT 节点 + has_leaf_intent 边
  Object.keys(intents).forEach(function (ref) {
    var it = intents[ref];
    var nodeId = 'intent:' + ref.replace(/[\/\s]/g, '_');
    nodes.push({
      id: nodeId,
      type: 'INTENT',
      properties: {
        name: it.name,
        intent_type: it.intentType,
        domain: it.domain,
        goal: it.goal,
        description: it.description,
        scope_in: strToTags(it.scopeIn),
        scope_out: strToTags(it.scopeOut),
        confusable_intents: strToTags(it.confusableIntents),
        disambiguation_hints: strToTags(it.disambiguationHints),
        utterance_view: strToTags(it.aliases),
        object_view: strToTags(it.businessObjects),
        action_view: strToTags(it.keySlots),
        fulfillment_kind: mapExecutionMode(it.executionMode),
        required_slot_refs: strToTags(it.requiredSlots),
        tb_action_code: it.actionType,
        tb_action_name: it.sourceAction,
        tb_object_name: it.businessObjectId,
        route_type: it.answerForm,
        standard_navigation_path: it.menuKey,
        answer_text: it.responsePolicy,
        result_template: it.taskPolicyShapes,
        confirmation_policy: it.contextPolicyRetain === '是' ? 'before_execute' : 'none',
        is_executable_leaf: it.executionMode && !/knowledge-only|知识应答/.test(it.executionMode),
        is_knowledge_intent: !!it.executionMode && /knowledge-only|知识应答/.test(it.executionMode),
        parent_intent_id: funcNodeId[it.funcPath] || '',
      },
    });

    // has_leaf_intent 边
    if (funcNodeId[it.funcPath]) {
      edges.push({
        id: 'edge:' + nodeId,
        type: 'has_leaf_intent',
        source: funcNodeId[it.funcPath],
        target: nodeId,
        properties: { relation_category: 'hierarchy', status: 'active', weight: 1 },
      });
    }

    // 说法 → utterance_view tags 补充
    if (it.utterances.length > 0) {
      var utterTags = it.utterances.map(function (u) { return u.text; });
      var node = nodes[nodes.length - 1];
      var existing = node.properties.utterance_view || [];
      node.properties.utterance_view = existing.concat(utterTags.filter(function (t) {
        return existing.indexOf(t) < 0;
      }));
    }
  });

  // BUSINESS_OBJECT 节点 + same_as 边（从 businessObjects 列还原）
  var boNodeId = {}; // boName → nodeId
  Object.keys(intents).forEach(function (ref) {
    var it = intents[ref];
    var intentNodeId = 'intent:' + ref.replace(/[\/\s]/g, '_');
    var boNames = strToTags(it.businessObjects);
    boNames.forEach(function (boName) {
      if (!boName) return;
      if (!boNodeId[boName]) {
        var boId = 'bo:' + boName.replace(/[\/\s]/g, '_');
        boNodeId[boName] = boId;
        nodes.push({
          id: boId,
          type: 'BUSINESS_OBJECT',
          properties: { name: boName },
        });
      }
      edges.push({
        id: 'edge:same_as:' + intentNodeId + ':' + boNodeId[boName],
        type: 'same_as',
        source: intentNodeId,
        target: boNodeId[boName],
        properties: { relation_category: 'semantic', status: 'active', weight: 1 },
      });
    });
  });

  // ACTION 节点 + same_as 边（从 keySlots 列还原）
  var actionNodeId = {}; // actionName → nodeId
  Object.keys(intents).forEach(function (ref) {
    var it = intents[ref];
    var intentNodeId = 'intent:' + ref.replace(/[\/\s]/g, '_');
    var actionNames = strToTags(it.keySlots);
    actionNames.forEach(function (actName) {
      if (!actName) return;
      if (!actionNodeId[actName]) {
        var actId = 'action:' + actName.replace(/[\/\s]/g, '_');
        actionNodeId[actName] = actId;
        nodes.push({
          id: actId,
          type: 'ACTION',
          properties: { name: actName },
        });
      }
      edges.push({
        id: 'edge:same_as:' + intentNodeId + ':' + actionNodeId[actName],
        type: 'same_as',
        source: intentNodeId,
        target: actionNodeId[actName],
        properties: { relation_category: 'semantic', status: 'active', weight: 1 },
      });
    });
  });

  var doc = emptyDoc();
  doc.nodes = nodes;
  doc.edges = edges;
  doc.metadata.source = 'intake-excel';
  doc.metadata.generated_at = new Date().toISOString();

  // ── 质量校验告警（playbook 经验吸纳）──
  var warnings = [];

  // 1. 跨意图别名去重：同一说法被多个意图认领时标记歧义
  var aliasOwner = {};
  Object.keys(intents).forEach(function (ref) {
    var list = (intents[ref].aliases || '').split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean);
    list.forEach(function (alias) {
      if (!aliasOwner[alias]) aliasOwner[alias] = [];
      if (aliasOwner[alias].indexOf(ref) < 0) aliasOwner[alias].push(ref);
    });
  });
  Object.keys(aliasOwner).forEach(function (alias) {
    if (aliasOwner[alias].length > 1) {
      warnings.push({ level: 'error', type: 'cross_intent_alias', message: '别名「' + alias + '」同时出现在多个意图：' + aliasOwner[alias].join(', ') + '（歧义说法应删除或交给下游裁决）' });
    }
  });

  // 2. 描述唯一性：active 意图描述跨意图重复会稀释向量空间
  var descOwners = {};
  Object.keys(intents).forEach(function (ref) {
    var desc = (intents[ref].description || '').trim();
    if (!desc) return;
    if (!descOwners[desc]) descOwners[desc] = [];
    descOwners[desc].push(ref);
  });
  Object.keys(descOwners).forEach(function (desc) {
    if (descOwners[desc].length > 1) {
      warnings.push({ level: 'warn', type: 'duplicate_description', message: '描述跨意图重复（稀释向量空间）：「' + desc.slice(0, 30) + '...」→ ' + descOwners[desc].join(', ') });
    }
  });

  // 3. 操作家族覆盖：含办理/管理属性的意图必须包含操作型说法
  var OP_PATTERNS = ['怎么开通', '怎么办理', '怎么申请', '怎么设置', '怎么取消', '怎么关闭', '如何开通', '如何办理', '如何申请', '如何设置', '如何取消'];
  Object.keys(intents).forEach(function (ref) {
    var it = intents[ref];
    var intentType = (it.intentType || '').trim();
    if (intentType === '办理' || intentType === '管理') {
      var list = (it.aliases || '').split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean);
      var hasOp = list.some(function (alias) { return OP_PATTERNS.some(function (pat) { return alias.indexOf(pat) >= 0; }); });
      if (!hasOp && list.length > 0) {
        warnings.push({ level: 'warn', type: 'missing_operation_family', message: ref + '：' + intentType + '类意图缺少操作型说法（怎么开通/怎么办理/怎么申请等），别名全是查询态' });
      }
    }
  });

  // 4. 别名长度约束：2-24 字，无连续 3 位以上数字
  Object.keys(intents).forEach(function (ref) {
    var list = (intents[ref].aliases || '').split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean);
    list.forEach(function (alias) {
      if (alias.length < 2 || alias.length > 24) {
        warnings.push({ level: 'info', type: 'alias_length', message: ref + '：别名「' + alias + '」长度' + alias.length + '字，不在2-24字范围' });
      }
      if (/\d{3,}/.test(alias)) {
        warnings.push({ level: 'info', type: 'alias_digits', message: ref + '：别名「' + alias + '」含连续3位以上数字，影响匹配精度' });
      }
    });
  });

  return {
    document: doc,
    stats: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      functionCount: Object.keys(functions).length,
      intentCount: Object.keys(intents).length,
      warnings: warnings,
      warningCount: warnings.length,
    },
  };
}

function mapExecutionMode(mode) {
  if (!mode) return 'unconfigured';
  var map = {
    // VALUE-LABEL 格式（与 knowledge-intake.js EXECUTION_MODES 对齐）
    'read-execute-读执行': 'query',
    'confirm-required-确认后执行': 'skill',
    'knowledge-only-知识应答': 'answer',
    'multi_intent-多意图': 'workflow',
    // 兼容旧值
    'navigation-only-仅导航': 'page',
    'unavailable-不可用': 'unconfigured',
    // 纯中文标签
    '读执行': 'query',
    '确认后执行': 'skill',
    '知识应答': 'answer',
    '多意图': 'workflow',
    '仅导航': 'page',
    '不可用': 'unconfigured',
    // 纯英文值
    'read-execute': 'query',
    'confirm-required': 'skill',
    'knowledge-only': 'answer',
    'multi_intent': 'workflow',
    'query': 'query',
    'answer': 'answer',
    'page': 'page',
    'menu': 'page', // 兼容旧值 menu → page（V4.1 枚举为 page）
    'skill': 'skill',
    'workflow': 'workflow',
    'agent': 'agent',
    'unconfigured': 'unconfigured',
  };
  return map[mode] || 'unconfigured';
}

function emptyDoc() {
  return {
    document_id: 'graph-generated',
    document_version: '1.0.0',
    asset_id: 'intent-graph',
    template_ref: { template_id: 'intent-graph', template_version: '1.5.0' },
    nodes: [],
    edges: [],
    metadata: {},
  };
}

// ── 多表格式适配器（gitcode 8-Sheet 模板）──

// Sheet 名称匹配（支持模糊匹配）
var MS_SHEET_NAMES = {
  instructions: ['填表说明', '填表指南', '说明'],
  functionTree: ['功能树', '功能列表', '功能'],
  sceneDecl: ['场景声明', '场景', '意图声明'],
  utterance: ['说法素材', '说法', '语料', '话术'],
  slots: ['信息收集项', '收集项', '信息收集', '槽位'],
  faq: ['常见问答', 'FAQ', '问答'],
  capability: ['系统能力', '能力', '系统对接', '能力绑定'],
  confusion: ['易混淆关系', '混淆关系', '易混淆', '消歧'],
};

// 场景类型 → V4.1 intent_type
var SCENE_TYPE_MAP = {
  '查询': 'QUERY', '办理': 'DO', '问答': 'ASK', '修改': 'CHANGE',
  '撤销': 'CANCEL', '转账': 'TRANSFER', '还款': 'REPAY', '帮助': 'HELP',
  '咨询': 'ASK', '投诉': 'HELP', '营销': 'ASK', '取消': 'CANCEL', '管理': 'CHANGE',
};

// 执行方式 → V4.1 execution_mode
var EXEC_MODE_CN_MAP = {
  '直接执行': 'read-execute', '需确认': 'confirm-required', '需确认后执行': 'confirm-required',
  '仅回答': 'knowledge-only', '知识应答': 'knowledge-only', '多意图': 'multi_intent', '复合意图': 'multi_intent',
};

// 落地方式 → V4.1 fulfillment_kind
var FULFILL_KIND_CN_MAP = {
  '调接口': '__api__', // 特殊标记：根据是否写操作动态决定 query/skill
  '技能编排': 'skill', '工作流': 'workflow',
  '智能体': 'agent', '页面直达': 'page', '话术答复': 'answer',
  '数据卡片': 'query', '转人工': 'agent',
};

// 根据 CAPABILITY 的落地方式 + 是否写操作，推导 fulfillment_kind
function deriveFulfillmentKindFromCapability(cmethod, isWrite) {
  var mapped = FULFILL_KIND_CN_MAP[cmethod];
  if (mapped === '__api__') return isWrite ? 'skill' : 'query';
  return mapped || null;
}

// intent_type → action_code（V4.1 ACTION_CODES）
var SCENE_ACTION_CODE_MAP = {
  ASK: 'ask', QUERY: 'query', DO: 'apply', CHANGE: 'change',
  CANCEL: 'cancel', HELP: 'guide', TRANSFER: 'transfer', REPAY: 'repay',
};

function msMatchSheet(wb, keys) {
  var sheetNames = wb.SheetNames;
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    for (var j = 0; j < sheetNames.length; j++) {
      if (sheetNames[j].indexOf(key) >= 0 || key.indexOf(sheetNames[j]) >= 0) {
        return wb.Sheets[sheetNames[j]];
      }
    }
  }
  return null;
}

function msReadSheet(sheet) {
  if (!sheet) return [];
  var raw = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  if (raw.length < 2) return [];
  return raw.slice(1).filter(function (r) { return r.join('').trim(); });
}

function msGet(row, idx) {
  if (idx == null || idx < 0) return '';
  return String(row[idx] || '').trim();
}

function msCol(headers, names) {
  for (var i = 0; i < names.length; i++) {
    var idx = headers.indexOf(names[i]);
    if (idx >= 0) return idx;
  }
  return -1;
}

function msIsMultiSheet(wb) {
  return !!msMatchSheet(wb, MS_SHEET_NAMES.functionTree) ||
    !!msMatchSheet(wb, MS_SHEET_NAMES.sceneDecl);
}

function multiSheetExcelToGraph(buffer) {
  var wb = XLSX.read(buffer, { type: 'buffer' });

  // ── 1. 功能树 Sheet → AGGREGATE_INTENT 节点 + 层级边 ──
  var funcSheet = msMatchSheet(wb, MS_SHEET_NAMES.functionTree);
  var funcRaw = funcSheet ? XLSX.utils.sheet_to_json(funcSheet, { header: 1, defval: '' }) : [];
  var funcHeaders = funcRaw.length > 0 ? funcRaw[0].map(function (h) { return String(h || '').trim(); }) : [];

  var cFName = msCol(funcHeaders, ['功能名称', '功能', '名称']);
  var cFLevel = msCol(funcHeaders, ['层级', '级别', '级别']);
  var cFParent = msCol(funcHeaders, ['上级功能', '上级', '父功能', '父节点']);
  var cFPath = msCol(funcHeaders, ['App菜单路径', '菜单路径', '路径', '导航路径']);
  var cFDesc = msCol(funcHeaders, ['业务说明', '说明', '描述']);
  var cFScopeIn = msCol(funcHeaders, ['范围内关键词', '范围内', 'scope_in']);
  var cFScopeOut = msCol(funcHeaders, ['范围外关键词', '范围外', 'scope_out']);
  var cFNavTerms = msCol(funcHeaders, ['导航词', '导航关键词', '导航']);
  var cFBizObj = msCol(funcHeaders, ['业务对象', '对象']);
  var cFHasIntent = msCol(funcHeaders, ['有无用户意图', '有意图', '是否叶子']);

  var funcNodes = {};  // name → node
  var funcPathMap = {}; // name → path
  var funcParentMap = {}; // name → parent name
  var nodes = [];
  var edges = [];

  for (var i = 1; i < funcRaw.length; i++) {
    var r = funcRaw[i];
    if (!r.join('').trim()) continue;
    var fname = msGet(r, cFName);
    if (!fname) continue;
    var flevel = msGet(r, cFLevel);
    var fparent = msGet(r, cFParent);
    var fpath = msGet(r, cFPath) || fname;
    var fdesc = msGet(r, cFDesc);
    var fscopeIn = msGet(r, cFScopeIn);
    var fscopeOut = msGet(r, cFScopeOut);
    var fnavTerms = msGet(r, cFNavTerms);
    var fbizObj = msGet(r, cFBizObj);
    var fhasIntent = msGet(r, cFHasIntent);

    var nodeId = 'agg:' + fname.replace(/[\/\s]/g, '_');
    funcNodes[fname] = {
      id: nodeId, type: 'AGGREGATE_INTENT',
      properties: {
        name: fname,
        domain: flevel === '领域' ? fname : (fpath.split('/')[0] || fname),
        description: fdesc,
        goal: '',
        scope_in: strToTags(fscopeIn),
        scope_out: strToTags(fscopeOut),
        boundary_note: '',
        modeling_role: flevel === '领域' ? 'domain' : 'aggregate',
        standard_navigation_path: fpath,
        navigation_terms: strToTags(fnavTerms),
        business_objects: strToTags(fbizObj),
        has_leaf_intent: fhasIntent === '有' || fhasIntent === '是',
      },
    };
    funcPathMap[fname] = fpath;
    if (fparent && fparent !== fname) funcParentMap[fname] = fparent;
    nodes.push(funcNodes[fname]);
  }

  // 层级边（CHILD_OF / has_leaf_intent 等价）
  Object.keys(funcParentMap).forEach(function (name) {
    var parent = funcParentMap[name];
    if (funcNodes[parent] && funcNodes[name]) {
      edges.push({
        id: 'edge:contains:' + funcNodes[parent].id + ':' + funcNodes[name].id,
        type: 'contains',
        source: funcNodes[parent].id,
        target: funcNodes[name].id,
        properties: { relation_category: 'hierarchy', status: 'active', weight: 1 },
      });
    }
  });

  // ── 2. 场景声明 Sheet → INTENT 节点 + has_leaf_intent 边 ──
  var sceneSheet = msMatchSheet(wb, MS_SHEET_NAMES.sceneDecl);
  var sceneRaw = sceneSheet ? XLSX.utils.sheet_to_json(sceneSheet, { header: 1, defval: '' }) : [];
  var sceneHeaders = sceneRaw.length > 0 ? sceneRaw[0].map(function (h) { return String(h || '').trim(); }) : [];

  var cSFunc = msCol(sceneHeaders, ['功能名称', '功能', '关联功能']);
  var cSType = msCol(sceneHeaders, ['场景类型', '类型', '意图类型']);
  var cSDesc = msCol(sceneHeaders, ['场景描述', '描述', '说明']);
  var cSGoal = msCol(sceneHeaders, ['用户目标', '目标', '用户意图']);
  var cSChannel = msCol(sceneHeaders, ['适用渠道', '渠道']);
  var cSExec = msCol(sceneHeaders, ['执行方式', '执行模式', '落地方式']);
  var cSConfirm = msCol(sceneHeaders, ['需要确认', '是否确认', '需确认']);
  var cSRisk = msCol(sceneHeaders, ['风险等级', '风险']);
  var cSNote = msCol(sceneHeaders, ['备注', '说明']);

  var intents = {}; // funcName|sceneType → intent node data
  var intentNodes = {}; // same key → node ref

  for (var i = 1; i < sceneRaw.length; i++) {
    var r = sceneRaw[i];
    if (!r.join('').trim()) continue;
    var sfunc = msGet(r, cSFunc);
    if (!sfunc) continue;
    var stype = msGet(r, cSType);
    var sdesc = msGet(r, cSDesc);
    var sgoal = msGet(r, cSGoal);
    var schannel = msGet(r, cSChannel);
    var sexec = msGet(r, cSExec);
    var sconfirm = msGet(r, cSConfirm);
    var srisk = msGet(r, cSRisk);
    var snote = msGet(r, cSNote);

    var intentType = SCENE_TYPE_MAP[stype] || 'ASK';
    var execMode = EXEC_MODE_CN_MAP[sexec] || parseEnumValue(sexec) || (intentType === 'ASK' || intentType === 'HELP' ? 'knowledge-only' : 'confirm-required');
    var fulfillmentKind = FULFILL_KIND_CN_MAP[sexec] || mapExecutionMode(execMode);
    var riskLevel = srisk ? parseEnumValue(srisk) : 'L0';
    var key = sfunc + '|' + stype;

    var funcNode = funcNodes[sfunc];
    var fpath = funcPathMap[sfunc] || sfunc;
    var fdomain = funcNode ? funcNode.properties.domain : (fpath.split('/')[0] || '');
    var nodeId = 'intent:' + sfunc.replace(/[\/\s]/g, '_') + ':' + intentType.toLowerCase();

    var intentData = {
      id: nodeId,
      type: 'INTENT',
      properties: {
        name: sfunc + '-' + stype,
        intent_type: intentType,
        action_code: SCENE_ACTION_CODE_MAP[intentType] || 'ask',
        domain: fdomain,
        goal: sgoal || sdesc,
        description: sdesc,
        scope_in: funcNode ? funcNode.properties.scope_in : [],
        scope_out: funcNode ? funcNode.properties.scope_out : [],
        confusable_intents: [],
        disambiguation_hints: [],
        utterance_view: [],
        object_view: funcNode ? (funcNode.properties.business_objects || []) : [],
        action_view: [],
        fulfillment_kind: fulfillmentKind,
        execution_mode: execMode,
        lifecycle: 'active',
        readiness: 'ready',
        orchestration_mode: 'single',
        risk_level: riskLevel,
        required_slot_refs: [],
        confirmation_policy: (sconfirm === '是' || execMode === 'confirm-required') ? 'before_execute' : 'none',
        is_executable_leaf: execMode !== 'knowledge-only',
        is_knowledge_intent: execMode === 'knowledge-only',
        parent_intent_id: funcNode ? funcNode.id : '',
        channels: schannel ? strToTags(schannel) : [],
        scenes: [{
          intentType: intentType,
          userGoal: sgoal || sdesc || sfunc,
          triggerScene: stype,
          note: snote,
        }],
      },
    };

    intents[key] = intentData;
    intentNodes[key] = intentData;
    nodes.push(intentData);

    // has_leaf_intent 边
    if (funcNode) {
      edges.push({
        id: 'edge:has_leaf_intent:' + funcNode.id + ':' + nodeId,
        type: 'has_leaf_intent',
        source: funcNode.id,
        target: nodeId,
        properties: { relation_category: 'hierarchy', status: 'active', weight: 1 },
      });
    }
  }

  // ── 3. 说法素材 Sheet → utterance_view / recall_terms / negative_examples ──
  var uttSheet = msMatchSheet(wb, MS_SHEET_NAMES.utterance);
  var uttRaw = msReadSheet(uttSheet);
  if (uttRaw.length > 0) {
    var uttHeaders = uttSheet ? XLSX.utils.sheet_to_json(uttSheet, { header: 1, defval: '' })[0].map(function (h) { return String(h || '').trim(); }) : [];
    var cUFunc = msCol(uttHeaders, ['功能名称', '功能', '关联功能']);
    var cUType = msCol(uttHeaders, ['场景类型', '类型', '意图类型']);
    var cUKind = msCol(uttHeaders, ['素材类型', '类型', '说法类型']);
    var cUContent = msCol(uttHeaders, ['素材内容', '内容', '说法']);
    var cUNote = msCol(uttHeaders, ['备注', '说明']);

    uttRaw.forEach(function (r) {
      var ufunc = msGet(r, cUFunc);
      var utype = msGet(r, cUType);
      var ukind = msGet(r, cUKind);
      var ucontent = msGet(r, cUContent);
      if (!ufunc || !ucontent) return;
      var key = ufunc + '|' + utype;
      var intent = intentNodes[key];
      if (!intent) return;
      var kindLower = ukind.toLowerCase();
      if (kindLower.indexOf('负例') >= 0 || kindLower.indexOf('否定') >= 0) {
        intent.properties.negative_examples = intent.properties.negative_examples || [];
        intent.properties.negative_examples.push(ucontent);
      } else if (kindLower.indexOf('召回词') >= 0 || kindLower.indexOf('关键词') >= 0) {
        intent.properties.recall_terms = intent.properties.recall_terms || [];
        intent.properties.recall_terms.push(ucontent);
      } else if (kindLower.indexOf('词组') >= 0 || kindLower.indexOf('组合') >= 0) {
        intent.properties.recall_term_sets = intent.properties.recall_term_sets || [];
        intent.properties.recall_term_sets.push(ucontent);
      } else {
        // 标准别名 / 口语变体 / 语义扩展 → utterance_view
        intent.properties.utterance_view.push(ucontent);
      }
    });
  }

  // ── 4. 信息收集项 Sheet → SLOT 节点 + REQUIRES_SLOT 边 ──
  var slotSheet = msMatchSheet(wb, MS_SHEET_NAMES.slots);
  var slotRaw = msReadSheet(slotSheet);
  if (slotRaw.length > 0) {
    var slotHeaders = slotSheet ? XLSX.utils.sheet_to_json(slotSheet, { header: 1, defval: '' })[0].map(function (h) { return String(h || '').trim(); }) : [];
    var cSlFunc = msCol(slotHeaders, ['功能名称', '功能', '关联功能']);
    var cSlType = msCol(slotHeaders, ['场景类型', '类型']);
    var cSlSeq = msCol(slotHeaders, ['收集项序号', '序号', '顺序']);
    var cSlName = msCol(slotHeaders, ['收集项名称', '名称', '槽位名称']);
    var cSlValueType = msCol(slotHeaders, ['值类型', '类型', '数据类型']);
    var cSlRequired = msCol(slotHeaders, ['是否必填', '必填', '是否必选']);
    var cSlPrompt = msCol(slotHeaders, ['追问话术', '话术', '提示语']);
    var cSlKeyword = msCol(slotHeaders, ['原话关键词', '关键词']);
    var cSlNote = msCol(slotHeaders, ['备注', '说明']);

    var slotNodeId = {};
    slotRaw.forEach(function (r) {
      var slfunc = msGet(r, cSlFunc);
      var sltype = msGet(r, cSlType);
      var slseq = msGet(r, cSlSeq);
      var slname = msGet(r, cSlName);
      if (!slfunc || !slname) return;
      var key = slfunc + '|' + sltype;
      var intent = intentNodes[key];
      if (!intent) return;

      var slotId = 'slot:' + intent.id + ':' + slname.replace(/[\/\s]/g, '_');
      var slotNode = {
        id: slotId,
        type: 'SLOT',
        properties: {
          name: slname,
          value_type: msGet(r, cSlValueType) || '文本',
          required: msGet(r, cSlRequired) === '是',
          prompt: msGet(r, cSlPrompt),
          keywords: strToTags(msGet(r, cSlKeyword)),
          seq: slseq ? parseInt(slseq, 10) || 0 : 0,
        },
      };
      nodes.push(slotNode);
      intent.properties.required_slot_refs.push(slotId);
      edges.push({
        id: 'edge:REQUIRES_SLOT:' + intent.id + ':' + slotId,
        type: 'REQUIRES_SLOT',
        source: intent.id,
        target: slotId,
        properties: { relation_category: 'dependency', status: 'active', weight: 1 },
      });
    });
  }

  // ── 5. 常见问答 Sheet → scenes[].faq ──
  var faqSheet = msMatchSheet(wb, MS_SHEET_NAMES.faq);
  var faqRaw = msReadSheet(faqSheet);
  if (faqRaw.length > 0) {
    var faqHeaders = faqSheet ? XLSX.utils.sheet_to_json(faqSheet, { header: 1, defval: '' })[0].map(function (h) { return String(h || '').trim(); }) : [];
    var cQFunc = msCol(faqHeaders, ['关联功能', '功能', '功能名称']);
    var cQType = msCol(faqHeaders, ['关联场景', '场景', '场景类型']);
    var cQQuestion = msCol(faqHeaders, ['问题', 'Q', '提问']);
    var cQAnswer = msCol(faqHeaders, ['答案', 'A', '回答', '解答']);
    var cQNote = msCol(faqHeaders, ['备注', '说明']);

    faqRaw.forEach(function (r) {
      var qfunc = msGet(r, cQFunc);
      var qtype = msGet(r, cQType);
      var qquestion = msGet(r, cQQuestion);
      var qanswer = msGet(r, cQAnswer);
      if (!qquestion || !qanswer) return;
      var key = qfunc + '|' + qtype;
      var intent = intentNodes[key];
      if (!intent) return;
      var scene = intent.properties.scenes[0];
      if (scene) {
        scene.faq = scene.faq || [];
        scene.faq.push({ question: qquestion, answer: qanswer, note: msGet(r, cQNote) });
      }
    });
  }

  // ── 6. 系统能力 Sheet → CAPABILITY 节点 + HANDLED_BY 边 + fulfillment_kind 更新 ──
  var capSheet = msMatchSheet(wb, MS_SHEET_NAMES.capability);
  var capRaw = msReadSheet(capSheet);
  if (capRaw.length > 0) {
    var capHeaders = capSheet ? XLSX.utils.sheet_to_json(capSheet, { header: 1, defval: '' })[0].map(function (h) { return String(h || '').trim(); }) : [];
    var cCFunc = msCol(capHeaders, ['关联功能', '功能', '功能名称']);
    var cCType = msCol(capHeaders, ['关联场景', '场景', '场景类型']);
    var cCName = msCol(capHeaders, ['能力名称', '名称', '能力']);
    var cCMethod = msCol(capHeaders, ['落地方式', '方式', '实现方式']);
    var cCSystem = msCol(capHeaders, ['对接系统/接口', '对接系统', '接口', '系统']);
    var cCWrite = msCol(capHeaders, ['是否写操作', '写操作', '是否有写操作']);
    var cCRisk = msCol(capHeaders, ['风险等级', '风险']);
    var cCNote = msCol(capHeaders, ['备注', '说明']);

    var capNodeId = {};
    capRaw.forEach(function (r) {
      var cfunc = msGet(r, cCFunc);
      var ctype = msGet(r, cCType);
      var cname = msGet(r, cCName);
      if (!cfunc || !cname) return;
      var key = cfunc + '|' + ctype;
      var intent = intentNodes[key];
      if (!intent) return;

      var capId = 'cap:' + cname.replace(/[\/\s]/g, '_');
      if (!capNodeId[cname]) {
        capNodeId[cname] = capId;
        var cmethod = msGet(r, cCMethod);
        var isWrite = msGet(r, cCWrite) === '是';
        nodes.push({
          id: capId,
          type: 'CAPABILITY',
          properties: {
            name: cname,
            fulfillment_kind: deriveFulfillmentKindFromCapability(cmethod, isWrite) || 'unconfigured',
            binding_system: msGet(r, cCSystem),
            has_side_effect: isWrite,
            risk_level: msGet(r, cCRisk) ? parseEnumValue(msGet(r, cCRisk)) : 'L0',
            note: msGet(r, cCNote),
          },
        });
      }

      // 用落地方式覆盖意图的 fulfillment_kind（系统能力 Sheet 优先级更高）
      var cmethod = msGet(r, cCMethod);
      var derived = deriveFulfillmentKindFromCapability(cmethod, msGet(r, cCWrite) === '是');
      if (derived) {
        intent.properties.fulfillment_kind = derived;
      }
      intent.properties.capability_bindings = intent.properties.capability_bindings || [];
      intent.properties.capability_bindings.push(capId);

      edges.push({
        id: 'edge:HANDLED_BY:' + intent.id + ':' + capId,
        type: 'HANDLED_BY',
        source: intent.id,
        target: capId,
        properties: { relation_category: 'binding', status: 'active', weight: 1 },
      });
    });
  }

  // ── 7. 易混淆关系 Sheet → CONFUSABLE_WITH 边 + disambiguation_hints ──
  var confSheet = msMatchSheet(wb, MS_SHEET_NAMES.confusion);
  var confRaw = msReadSheet(confSheet);
  if (confRaw.length > 0) {
    var confHeaders = confSheet ? XLSX.utils.sheet_to_json(confSheet, { header: 1, defval: '' })[0].map(function (h) { return String(h || '').trim(); }) : [];
    var cCfFuncA = msCol(confHeaders, ['功能A', '功能1', '功能a']);
    var cCfTypeA = msCol(confHeaders, ['场景A', '场景1', '场景a']);
    var cCfFuncB = msCol(confHeaders, ['功能B', '功能2', '功能b']);
    var cCfTypeB = msCol(confHeaders, ['场景B', '场景2', '场景b']);
    var cCfHint = msCol(confHeaders, ['消歧提示', '提示', '消歧']);
    var cCfReason = msCol(confHeaders, ['混淆原因', '原因', '说明']);
    var cCfNote = msCol(confHeaders, ['备注']);

    confRaw.forEach(function (r) {
      var fA = msGet(r, cCfFuncA);
      var tA = msGet(r, cCfTypeA);
      var fB = msGet(r, cCfFuncB);
      var tB = msGet(r, cCfTypeB);
      var hint = msGet(r, cCfHint);
      var reason = msGet(r, cCfReason);
      if (!fA || !fB) return;

      var keyA = fA + '|' + tA;
      var keyB = fB + '|' + tB;
      var intentA = intentNodes[keyA];
      var intentB = intentNodes[keyB];
      if (!intentA || !intentB) return;

      // CONFUSABLE_WITH 边（双向）
      edges.push({
        id: 'edge:CONFUSABLE_WITH:' + intentA.id + ':' + intentB.id,
        type: 'CONFUSABLE_WITH',
        source: intentA.id,
        target: intentB.id,
        properties: { relation_category: 'confusion', evidence: reason, disambiguation_hint: hint, status: 'active', weight: 1 },
      });

      // 补充 confusable_intents 和 disambiguation_hints
      if (intentA.properties.confusable_intents.indexOf(intentB.properties.name) < 0) {
        intentA.properties.confusable_intents.push(intentB.properties.name);
      }
      if (intentB.properties.confusable_intents.indexOf(intentA.properties.name) < 0) {
        intentB.properties.confusable_intents.push(intentA.properties.name);
      }
      if (hint) {
        intentA.properties.disambiguation_hints.push(hint);
        intentB.properties.disambiguation_hints.push(hint);
      }
    });
  }

  // ── 组装文档 ──
  var doc = emptyDoc();
  doc.nodes = nodes;
  doc.edges = edges;
  doc.metadata.source = 'multi-sheet-excel';
  doc.metadata.generated_at = new Date().toISOString();
  doc.metadata.sheet_count = Object.keys(MS_SHEET_NAMES).length;
  doc.metadata.stats = {
    functions: Object.keys(funcNodes).length,
    intents: Object.keys(intents).length,
    nodes: nodes.length,
    edges: edges.length,
  };

  return { document: doc, stats: doc.metadata.stats };
}

// 从 VALUE-LABEL 格式中提取 VALUE 部分（如 'read-execute-读执行' → 'read-execute'）
function parseEnumValue(raw) {
  if (!raw) return '';
  var s = String(raw).trim();
  var m = s.match(/^([a-z_]+)-/);
  return m ? m[1] : s;
}

module.exports = {
  graphToIntakeExcel: graphToIntakeExcel,
  intakeExcelToGraph: intakeExcelToGraph,
  multiSheetExcelToGraph: multiSheetExcelToGraph,
  msIsMultiSheet: msIsMultiSheet,
};
