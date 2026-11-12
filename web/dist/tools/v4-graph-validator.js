/**
 * 意图图谱 V4.1 资产校验器（builder 建图链路专用）
 *
 * 对齐 docs/ai-native-bank/intent-graph-schema-v4.md v4.1（2026-09-24 评审通过）§11 的 14 条校验。
 * 模板：data/graph-builder-templates/template.intent.v4.json（template_id: intent-graph-v4）。
 *
 * builder 文档形态与 V4.1 文件的映射（由前端 lib/intentGraphV4.ts 导出时转换）：
 *   层级        → has_child 边（父→子）；导出派生 parent_intent_id / path
 *   横切关系    → same_as / confusable_with / related_to 边 → relations[]
 *   场景        → LEAF（或任意非 root 节点）properties.scenes（JSON 字符串）
 *   资源注册表  → document.metadata.v4ResourceRegistries = {capabilities,faqs,policies,skillBindings}
 *
 * 分层：骨架检查（createTemplateDrivenValidator）+ 字段级检查（x6 validateGraph）
 *       + V4.1 语义规则（本文件）。旧 intent-graph 资产不受影响。
 *
 * 使用：createV4IntentValidator(templatePath) → (document) => {valid, errors, warnings}
 */
'use strict';

const {
  SCENE_TYPES,
  EXECUTION_MODES,
  NODE_ROLE_BY_TYPE,
  CAPABILITY_KINDS,
  RISK_LEVELS,
} = require('./intent-graph-schema');

const { createTemplateDrivenValidator } = require('./template-driven-graph-validator');
const { validateGraph } = require('./x6-graph-template-validator');

// V4.1 场景互斥分组（§8.2/§11 第 7/8 条）
const KNOWLEDGE_SCENE_TYPES = ['ASK', 'HELP'];
const TASK_SCENE_TYPES = ['QUERY', 'DO', 'CHANGE', 'CANCEL', 'TRANSFER', 'REPAY'];

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

/** 解析 properties.scenes（JSON 字符串）。返回 {scenes, error} */
function parseScenes(value) {
  if (value === undefined || value === null || text(value) === '') return { scenes: [], error: null };
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (e) {
    return { scenes: null, error: 'scenes 不是合法 JSON：' + e.message };
  }
  if (!Array.isArray(parsed)) return { scenes: null, error: 'scenes 必须是 JSON 数组' };
  return { scenes: parsed, error: null };
}

/** 读资源注册表（缺省为空表，各表非数组时按空处理并在注册表自身校验中报错） */
function readRegistries(document) {
  const meta = (document && document.metadata) || {};
  const reg = meta.v4ResourceRegistries || {};
  return {
    capabilities: Array.isArray(reg.capabilities) ? reg.capabilities : [],
    faqs: Array.isArray(reg.faqs) ? reg.faqs : [],
    policies: Array.isArray(reg.policies) ? reg.policies : [],
    skillBindings: Array.isArray(reg.skillBindings) ? reg.skillBindings : [],
    raw: reg,
  };
}

/** 别名格式校验（§8.5：2~24 字、无连续 3 位以上数字、禁卡号/金额/日期形态） */
function aliasFormatProblems(alias) {
  const problems = [];
  const s = String(alias);
  if (s.length < 2 || s.length > 24) problems.push('长度须在 2~24 字之间');
  if (/\d{3,}/.test(s)) problems.push('不得含连续 3 位及以上数字');
  if (/\d+\s*(元|块钱|万)/.test(s)) problems.push('疑似金额表达，别名应避免具体金额');
  if (/\d+\s*[月日年号]/.test(s)) problems.push('疑似日期表达，别名应避免具体日期');
  if (/^\d{6,}$/.test(s)) problems.push('疑似卡号/单号');
  return problems;
}

/**
 * V4.1 语义规则校验（§11 十四条的 builder 文档形态实现）。
 * @returns {{errors:[], warnings:[]}}
 */
function validateV4Rules(document, ctx) {
  const errors = [];
  const warnings = [];
  const { registries } = ctx;

  const nodes = Array.isArray(document.nodes) ? document.nodes : [];
  const edges = Array.isArray(document.edges) ? document.edges : [];

  // ── 资源 id 索引（悬空引用检查用） ──
  const capabilityIds = {};
  const faqIds = {};
  const policyIds = {};
  const skillIds = {};
  registries.capabilities.forEach(function (c) { if (text(c && c.id)) capabilityIds[text(c.id)] = c; });
  registries.faqs.forEach(function (f) { if (text(f && f.id)) faqIds[text(f.id)] = f; });
  registries.policies.forEach(function (p) { if (text(p && p.id)) policyIds[text(p.id)] = p; });
  registries.skillBindings.forEach(function (s) { if (text(s && s.skillId)) skillIds[text(s.skillId)] = s; });

  const refExists = function (kind, id, where, ruleNum) {
    const table = { capability: capabilityIds, faq: faqIds, policy: policyIds, skill: skillIds }[kind];
    if (!table[id]) {
      errors.push({ code: 'V4_DANGLING_REF', message: '悬空引用：' + where + ' 引用的' +
        { capability: '能力', faq: 'FAQ', policy: '策略', skill: '技能绑定' }[kind] +
        '「' + id + '」不在资源注册表中（校验第 ' + (ruleNum || 9) + ' 条）', path: where });
    }
  };

  // ── 层级：has_child 父子关系（第 1/3 条 + node_role 交叉核对） ──
  const nodeById = {};
  const parentOf = {};
  const childCount = {};
  nodes.forEach(function (n, i) {
    const id = text(n && n.id);
    if (id) nodeById[id] = n;
    const prefix = 'nodes[' + i + ']';
    const role = text(n && n.properties && n.properties.node_role);
    const expectedRole = NODE_ROLE_BY_TYPE[text(n && n.type)];
    if (expectedRole && role !== expectedRole) {
      errors.push({ code: 'V4_ROLE_TYPE_MISMATCH', message: prefix + '（' + id + '）：节点类型 ' + n.type +
        ' 的 node_role 必须是「' + expectedRole + '」，实际「' + (role || '缺省') + '」' });
    }
  });

  let rootCount = 0;
  nodes.forEach(function (n) {
    if (!text(n && n.id)) return;
    if (n.type === 'ROOT') {
      rootCount += 1;
      if (text(n.properties && n.properties.scenes) !== '') {
        errors.push({ code: 'V4_ROOT_SCENES', message: '根节点「' + n.id + '」不允许声明 scenes（校验第 10 条）' });
      }
    }
  });
  if (rootCount !== 1) {
    errors.push({ code: 'V4_ROOT_COUNT', message: rootCount === 0
      ? '图谱缺少唯一的 ROOT 根节点（校验第 1 条：必须是一棵树）'
      : 'ROOT 根节点只能有一个，当前 ' + rootCount + ' 个' });
  }

  edges.forEach(function (e, i) {
    if (!e || e.type !== 'has_child') return;
    const prefix = 'edges[' + i + ']';
    const src = text(e.source);
    const tgt = text(e.target);
    if (!src || !tgt) return;
    if (src === tgt) return; // 自环由骨架层报
    if (!nodeById[src]) {
      errors.push({ code: 'V4_PARENT_MISSING', message: prefix + ': has_child 的父节点「' + src + '」不存在（校验第 1 条）' });
      return;
    }
    if (!nodeById[tgt]) return; // 骨架层已报端点缺失
    if (nodeById[tgt].type === 'ROOT') {
      errors.push({ code: 'V4_ROOT_HAS_PARENT', message: prefix + ': 根节点「' + tgt + '」不能有父节点' });
    }
    if (parentOf[tgt]) {
      errors.push({ code: 'V4_MULTI_PARENT', message: tgt + ' 已有父节点「' + parentOf[tgt] + '」，不能再挂到「' + src +
        '」（校验第 1 条：必须是一棵树）' });
    }
    parentOf[tgt] = src;
    childCount[src] = (childCount[src] || 0) + 1;
    // 第 3 条：子 id 必须以父 id 为前缀
    if (tgt.indexOf(src + '.') !== 0) {
      errors.push({ code: 'V4_ID_PREFIX', message: '子节点 id「' + tgt + '」必须以父节点 id「' + src +
        '.」为前缀（校验第 3 条，命名规则见 schema 文档 6.3）' });
    }
  });

  // 无环 + 深度（第 1/12 条）：沿 parent 链上行，重复访问即环
  const depthOf = {};
  nodes.forEach(function (n) {
    const id = text(n && n.id);
    if (!id || depthOf[id] !== undefined) return;
    const chain = [];
    let cur = id;
    while (cur !== undefined && cur !== null && cur !== '' && depthOf[cur] === undefined) {
      if (chain.indexOf(cur) >= 0) {
        errors.push({ code: 'V4_CYCLE', message: '层级成环：' + chain.concat(cur).join(' → ') + '（校验第 1 条：必须是无环树）' });
        chain.forEach(function (c) { depthOf[c] = -1; });
        break;
      }
      chain.push(cur);
      cur = parentOf[cur];
    }
    const baseDepth = (cur !== undefined && cur !== null && cur !== '' && depthOf[cur] !== undefined) ? depthOf[cur] : -1;
    for (let i = chain.length - 1; i >= 0; i--) {
      if (depthOf[chain[i]] !== -1) depthOf[chain[i]] = baseDepth + (chain.length - i);
    }
    if (depthOf[id] > 5) {
      warnings.push({ code: 'V4_DEPTH', message: '节点「' + id + '」深度为 ' + depthOf[id] +
        '（>5 层，校验第 12 条建议收敛层级）' });
    }
  });

  // ── 第 2 条：path 与父节点链一致 ──
  nodes.forEach(function (n) {
    const id = text(n && n.id);
    if (!id) return;
    const declaredPath = text(n && n.properties && n.properties.path);
    if (!declaredPath) return; // path 缺失由骨架层报
    // 沿父链构造期望路径
    const segments = [];
    let cur = n;
    while (cur) {
      const cid = text(cur && cur.id);
      if (!cid) break;
      segments.unshift(text(cur && cur.properties && cur.properties.title) || cid);
      const pid = parentOf[cid];
      cur = pid ? nodeById[pid] : null;
    }
    const expectedPath = segments.join('/');
    if (declaredPath !== expectedPath) {
      errors.push({ code: 'V4_PATH_MISMATCH', message: '节点「' + id + '」path「' + declaredPath +
        '」与父节点链构造的路径「' + expectedPath + '」不一致（校验第 2 条：path 必须与父节点 title 链一致）' });
    }
  });

  // ── 场景校验（第 4/5/6/7/8/10/11/13/14 条） ──
  const descSeen = {};
  const aliasSeen = {};
  let sceneTotal = 0;

  nodes.forEach(function (n) {
    const id = text(n && n.id);
    if (!id) return;
    const props = n.properties || {};

    // 功能级 policies 悬空引用
    if (Array.isArray(props.policies)) {
      props.policies.forEach(function (pid) {
        if (text(pid)) refExists('policy', text(pid), '节点「' + id + '」功能级 policies');
      });
    }

    const rawScenes = text(props.scenes);
    if (rawScenes === '') {
      if (n.type === 'LEAF') {
        warnings.push({ code: 'V4_LEAF_NO_SCENES', message: '叶子功能「' + id +
          '（' + text(props.title) + '）」尚未声明场景：纯分类/入口节点可留空，业务功能应声明 QUERY/ASK/DO 等场景（schema 文档 8.2）' });
      }
      return;
    }
    const parsed = parseScenes(rawScenes);
    if (parsed.error) {
      errors.push({ code: 'V4_SCENES_PARSE', message: '节点「' + id + '」' + parsed.error });
      return;
    }

    const seenTypes = {};
    parsed.scenes.forEach(function (scene, si) {
      const label = '节点「' + id + '」场景 #' + (si + 1);
      const st = text(scene && scene.scene_type);
      sceneTotal += 1;

      // 第 14 条：scene_type 必须大写枚举
      if (!st) {
        errors.push({ code: 'V4_SCENE_TYPE_MISSING', message: label + ' 缺少 scene_type' });
      } else if (SCENE_TYPES.indexOf(st) < 0) {
        const upper = st.toUpperCase();
        if (SCENE_TYPES.indexOf(upper) >= 0) {
          errors.push({ code: 'V4_SCENE_TYPE_CASE', message: label + ' scene_type「' + st +
            '」应为大写「' + upper + '」（校验第 14 条：scene_type 大写）' });
        } else {
          errors.push({ code: 'V4_SCENE_TYPE_UNKNOWN', message: label + ' scene_type「' + st +
            '」不在枚举内（' + SCENE_TYPES.join('/') + '）' });
        }
      }
      if (st && seenTypes[st]) {
        errors.push({ code: 'V4_SCENE_TYPE_DUP', message: '节点「' + id + '」存在重复 scene_type「' + st +
          '」（校验第 10 条：同节点内场景类型唯一）' });
      }
      seenTypes[st] = true;

      const sem = (scene && scene.semantic_definition) || {};
      const desc = text(sem.description);
      // 第 4 条：描述 ≥8 字 + 全图场景维度唯一
      if (!desc) {
        errors.push({ code: 'V4_SCENE_DESC_MISSING', message: label + ' 缺少 semantic_definition.description' });
      } else {
        if (desc.length < 8) {
          errors.push({ code: 'V4_SCENE_DESC_SHORT', message: label + ' 的场景描述不足 8 字（当前 ' + desc.length +
            ' 字）：「' + desc + '」' });
        }
        if (descSeen[desc]) {
          errors.push({ code: 'V4_SCENE_DESC_DUP', message: label + ' 的场景描述与「' + descSeen[desc] +
            '」重复（校验第 4 条：描述全图唯一）：「' + desc + '」' });
        } else {
          descSeen[desc] = id + '#' + (st || '?');
        }
      }
      // intentType 冗余字段须与 scene_type 一致（§8.4）
      const it = text(sem.intentType);
      if (st && it && it !== st) {
        errors.push({ code: 'V4_INTENT_TYPE_MISMATCH', message: label + ' semantic_definition.intentType「' + it +
          '」与 scene_type「' + st + '」不一致（冗余字段必须一致）' });
      }

      const retrieval = (scene && scene.retrieval_profile) || {};
      const aliases = Array.isArray(retrieval.aliases) ? retrieval.aliases.map(text).filter(Boolean) : [];
      // 第 5/6 条：别名 ≥3、格式、全图场景维唯一
      if (aliases.length < 3) {
        errors.push({ code: 'V4_ALIAS_TOO_FEW', message: label + ' 别名不足 3 条（当前 ' + aliases.length +
          '，要求 ≥3，建议 8~16 条）' });
      }
      aliases.forEach(function (a) {
        const problems = aliasFormatProblems(a);
        if (problems.length > 0) {
          errors.push({ code: 'V4_ALIAS_FORMAT', message: label + ' 别名「' + a + '」不合规：' + problems.join('；') + '（校验第 6 条）' });
        }
        if (aliasSeen[a]) {
          errors.push({ code: 'V4_ALIAS_DUP', message: label + ' 别名「' + a + '」已被「' + aliasSeen[a] +
            '」占用（校验第 5 条：别名全图唯一）' });
        } else {
          aliasSeen[a] = id + '#' + (st || '?');
        }
      });
      const negatives = Array.isArray(retrieval.negativeExamples) ? retrieval.negativeExamples.map(text).filter(Boolean) : [];
      if (negatives.length < 2) {
        warnings.push({ code: 'V4_NEGATIVE_FEW', message: label + ' 负例不足 2 条（建议 ≥2，同功能其他场景说法是天然负例素材）' });
      }
      negatives.forEach(function (neg) {
        if (aliases.indexOf(neg) >= 0 || (Array.isArray(retrieval.recallTerms) && retrieval.recallTerms.map(text).indexOf(neg) >= 0)) {
          warnings.push({ code: 'V4_NEGATIVE_OVERLAP', message: label + ' 负例「' + neg + '」与本场景别名/召回词重叠' });
        }
      });

      // 第 10 条互斥：knowledge_binding vs task_binding；executionMode 合法性
      const knowledge = (scene && scene.knowledge_binding) || null;
      const task = (scene && scene.task_binding) || null;
      const execution = (scene && scene.execution_binding) || {};
      const isKnowledgeType = KNOWLEDGE_SCENE_TYPES.indexOf(st) >= 0;
      const isTaskType = TASK_SCENE_TYPES.indexOf(st) >= 0;

      if (!knowledge && isKnowledgeType) {
        errors.push({ code: 'V4_KNOWLEDGE_MISSING', message: label + '（' + st +
          '）必须填写 knowledge_binding.answerRefs（校验第 7 条：FAQ 唯一引用源）' });
      }
      if (task && isKnowledgeType) {
        errors.push({ code: 'V4_MUTEX_TASK_IN_ASK', message: label + '（' + st +
          '）不允许 task_binding（校验第 7 条：问答场景只走知识块）' });
      }
      if (Array.isArray(scene && scene.bindings && scene.bindings.capabilities) && scene.bindings.capabilities.length > 0 && isKnowledgeType) {
        errors.push({ code: 'V4_ASK_CAPABILITIES', message: label + '（' + st +
          '）的 bindings.capabilities 必须为空（校验第 7 条：纯咨询场景不绑能力）' });
      }
      if (!task && isTaskType) {
        errors.push({ code: 'V4_TASK_MISSING', message: label + '（' + st +
          '）必须填写 task_binding（含 actionCode）（校验第 8 条：任务场景必填任务块）' });
      }
      const capList = (scene && scene.bindings && Array.isArray(scene.bindings.capabilities)) ? scene.bindings.capabilities : [];
      if (isTaskType && capList.length === 0) {
        errors.push({ code: 'V4_TASK_CAPABILITIES', message: label + '（' + st +
          '）必须绑定至少 1 个能力（bindings.capabilities，校验第 8 条）' });
      }
      if (scene && scene.bindings && Array.isArray(scene.bindings.faqs) && scene.bindings.faqs.length > 0) {
        errors.push({ code: 'V4_FAQS_IN_BINDINGS', message: label + ' 的 bindings 里不允许 faqs（校验第 11 条：FAQ 引用统一走 knowledge_binding.answerRefs）' });
      }

      const mode = text(execution.executionMode);
      if (mode && EXECUTION_MODES.indexOf(mode) < 0) {
        errors.push({ code: 'V4_EXECUTION_MODE_UNKNOWN', message: label + ' executionMode「' + mode +
          '」不在枚举内（' + EXECUTION_MODES.join('/') + '）' });
      }
      if (isTaskType && mode === 'knowledge-only') {
        errors.push({ code: 'V4_MODE_MUTEX', message: label + '（' + st +
          '）任务场景不允许 knowledge-only 执行模式（校验第 10 条：executionMode 决定互斥）' });
      }
      if (!scene || typeof scene.execution_binding !== 'object' || scene.execution_binding === null) {
        errors.push({ code: 'V4_EXECUTION_MISSING', message: label + ' 缺少 execution_binding（JSON schema 必填）' });
      }

      // 第 9/13 条：引用可解析
      (knowledge && Array.isArray(knowledge.answerRefs) ? knowledge.answerRefs : []).forEach(function (rid) {
        if (text(rid)) refExists('faq', text(rid), label + ' knowledge_binding.answerRefs');
      });
      capList.forEach(function (cid) {
        if (text(cid)) refExists('capability', text(cid), label + ' bindings.capabilities');
      });
      ((scene && scene.bindings && Array.isArray(scene.bindings.policies)) ? scene.bindings.policies : []).forEach(function (pid) {
        if (text(pid)) refExists('policy', text(pid), label + ' bindings.policies');
      });
      const skillBinding = (task && task.skillBinding) || null;
      if (skillBinding) {
        if (!text(skillBinding.skillId)) {
          errors.push({ code: 'V4_SKILL_ID_EMPTY', message: label + ' task_binding.skillBinding 已声明但 skillId 为空（校验第 13 条：skillBinding.skillId 不可为空）' });
        } else {
          refExists('skill', text(skillBinding.skillId), label + ' task_binding.skillBinding.skillId', 13);
        }
      }
      const slots = (task && task.slotContract && Array.isArray(task.slotContract.slots)) ? task.slotContract.slots : [];
      slots.forEach(function (slot) {
        const rid = text(slot && slot.resolverCapabilityId);
        if (rid) refExists('capability', rid, label + ' 槽位「' + text(slot && slot.slotId) + '」resolverCapabilityId');
      });
      // 第 14 条：actionCode 小写
      const actionCode = text(task && task.actionCode);
      if (actionCode && /^[A-Z]/.test(actionCode)) {
        errors.push({ code: 'V4_ACTION_CODE_CASE', message: label + ' task_binding.actionCode「' + actionCode +
          '」应为小写（校验第 14 条：scene_type 大写 / actionCode 小写，两者不可混用）' });
      }
      // apiOrWorkflowId 落到能力表
      const apiId = text(execution.apiOrWorkflowId);
      if (apiId && !capabilityIds[apiId]) {
        errors.push({ code: 'V4_DANGLING_REF', message: '悬空引用：' + label + ' execution_binding.apiOrWorkflowId「' +
          apiId + '」不在能力表中（校验第 9 条）' });
      }
    });
  });

  // ── 注册表自身形状（轻量：id 唯一 + 必填核心字段） ──
  const seenCap = {};
  registries.capabilities.forEach(function (c, i) {
    const cid = text(c && c.id);
    if (!cid) { errors.push({ code: 'V4_REGISTRY', message: '能力表第 ' + (i + 1) + ' 条缺少 id' }); return; }
    if (seenCap[cid]) errors.push({ code: 'V4_REGISTRY', message: '能力表 id 重复：' + cid });
    seenCap[cid] = true;
    if (!text(c.title)) errors.push({ code: 'V4_REGISTRY', message: '能力「' + cid + '」缺少 title' });
    if (CAPABILITY_KINDS.indexOf(text(c.kind)) < 0) {
      errors.push({ code: 'V4_REGISTRY', message: '能力「' + cid + '」kind「' + text(c.kind) + '」不在枚举（' + CAPABILITY_KINDS.join('/') + '）' });
    }
    if (RISK_LEVELS.indexOf(text(c.riskLevel)) < 0) {
      errors.push({ code: 'V4_REGISTRY', message: '能力「' + cid + '」riskLevel「' + text(c.riskLevel) + '」不在枚举（' + RISK_LEVELS.join('/') + '）' });
    }
    if (!c.provider || typeof c.provider !== 'object') {
      errors.push({ code: 'V4_REGISTRY', message: '能力「' + cid + '」缺少 provider（按 kind 填 protocol/serverId/toolName、entry、workflowId、agentId/endpoint 或 route）' });
    }
  });
  const seenFaq = {};
  registries.faqs.forEach(function (f, i) {
    const fid = text(f && f.id);
    if (!fid) { errors.push({ code: 'V4_REGISTRY', message: 'FAQ 表第 ' + (i + 1) + ' 条缺少 id' }); return; }
    if (seenFaq[fid]) errors.push({ code: 'V4_REGISTRY', message: 'FAQ 表 id 重复：' + fid });
    seenFaq[fid] = true;
    if (!text(f.question) || !text(f.answer)) errors.push({ code: 'V4_REGISTRY', message: 'FAQ「' + fid + '」缺少 question/answer' });
  });
  const seenPol = {};
  registries.policies.forEach(function (p, i) {
    const pid = text(p && p.id);
    if (!pid) { errors.push({ code: 'V4_REGISTRY', message: '策略表第 ' + (i + 1) + ' 条缺少 id' }); return; }
    if (seenPol[pid]) errors.push({ code: 'V4_REGISTRY', message: '策略表 id 重复：' + pid });
    seenPol[pid] = true;
    if (!Array.isArray(p.rules) || p.rules.length === 0) errors.push({ code: 'V4_REGISTRY', message: '策略「' + pid + '」缺少 rules 规则条目' });
  });
  const seenSkill = {};
  registries.skillBindings.forEach(function (s, i) {
    const sid = text(s && s.skillId);
    if (!sid) { errors.push({ code: 'V4_REGISTRY', message: '技能绑定表第 ' + (i + 1) + ' 条缺少 skillId' }); return; }
    if (seenSkill[sid]) errors.push({ code: 'V4_REGISTRY', message: '技能绑定表 skillId 重复：' + sid });
    seenSkill[sid] = true;
  });

  if (sceneTotal === 0) {
    warnings.push({ code: 'V4_NO_SCENES', message: '全图尚无任何场景：业务功能以「功能 × 场景」表达（schema 文档第 8 章）' });
  }

  return { errors: errors, warnings: warnings };
}

/**
 * 组装 V4.1 资产校验器：骨架 + x6 字段级 + V4.1 语义规则。
 * @param {string} templatePath template.intent.v4.json 路径
 */
function createV4IntentValidator(templatePath) {
  // 相对路径统一按 cwd 解析为绝对（fs 与 require 的相对基准不同，避免歧义）
  templatePath = require('path').resolve(templatePath);
  const skeleton = createTemplateDrivenValidator(templatePath);
  return function validateDocument(document) {
    // 1) 骨架检查（文档形状 / id 唯一 / 类型在模板 / 端点存在）；连 nodes/edges 数组都没有时无需继续
    const base = skeleton(document);
    if (!Array.isArray(document && document.nodes) || !Array.isArray(document && document.edges)) {
      return base;
    }
    const errors = Array.isArray(base.errors) ? base.errors.slice() : [];
    const warnings = Array.isArray(base.warnings) ? base.warnings.slice() : [];

    // 2) x6 字段级检查（必填/枚举/端点类型；旧 intent-graph 硬编码块按 template_id 门控不会触发）
    try {
      const template = require(templatePath);
      const x6Report = validateGraph(template, document);
      (x6Report.errors || []).forEach(function (e) {
        errors.push(typeof e === 'string' ? { code: 'X6', message: e } : e);
      });
      (x6Report.warnings || []).forEach(function (w) {
        warnings.push(typeof w === 'string' ? { code: 'X6', message: w } : w);
      });
    } catch (e) {
      errors.push({ code: 'V4_X6_FAILED', message: '模板校验器执行失败：' + e.message });
    }

    // 3) V4.1 语义规则（§11）
    try {
      const v4 = validateV4Rules(document, { registries: readRegistries(document) });
      errors.push.apply(errors, v4.errors);
      warnings.push.apply(warnings, v4.warnings);
    } catch (e) {
      errors.push({ code: 'V4_RULES_FAILED', message: 'V4.1 规则校验器执行失败：' + e.message });
    }

    return { valid: errors.length === 0, errors: errors, warnings: warnings };
  };
}

module.exports = {
  createV4IntentValidator: createV4IntentValidator,
  validateV4Rules: validateV4Rules,
  readRegistries: readRegistries,
  parseScenes: parseScenes,
  aliasFormatProblems: aliasFormatProblems,
  KNOWLEDGE_SCENE_TYPES: KNOWLEDGE_SCENE_TYPES,
  TASK_SCENE_TYPES: TASK_SCENE_TYPES,
};
