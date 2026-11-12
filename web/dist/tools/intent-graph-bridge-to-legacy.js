/**
 * 意图图谱 v2 包 → legacy 识别引擎 bundle（intent-graph-full.json）下转换 — 共享模块（UMD）
 *
 * 背景：routes/intent-recognizer.js 只读 legacy bundle（data/graphs/intent-graph-full.json，
 * 字段 node_identity/node_semantics/navigation/actions[].scenes/retrieval_profile{entity_text,
 * action_text,context_text}）；v2 包经 evaluator manifest 消费。发布桥接把 v2 包确定性下转换为
 * legacy bundle（可审计发布物，备份旧包 + manifest 记录 recognizer_bundle），不在运行时做转换
 * （intent-engine-generalization.md 规则 17/18/20）。
 *
 * 映射（v2 → legacy）：
 *   intent_nodes → nodes[]（每叶子 = 1 legacy node + 1 action + 1 scene）
 *   aggregate_intents → semantic_aggregations{name: scope_in 关键词数组}
 *   supporting_nodes.actions → action_definitions{action_code: action_name}
 * 仅 Node 环境使用。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IntentGraphBridgeToLegacy = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var fs = require('fs');
  var path = require('path');

  var GRAPHS_DIR = path.join(__dirname, '..', 'data', 'graphs');
  var FULL_PATH = path.join(GRAPHS_DIR, 'intent-graph-full.json');
  var BACKUPS_DIR = path.join(GRAPHS_DIR, 'backups');

  function arr(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value.filter(function (v) { return v !== undefined && v !== null && String(v).trim() !== ''; });
    return [value].filter(function (v) { return String(v).trim() !== ''; });
  }

  function uniq(values) {
    var seen = {};
    var out = [];
    arr(values).forEach(function (v) {
      var s = String(v).trim();
      if (s && !seen[s]) { seen[s] = true; out.push(s); }
    });
    return out;
  }

  function firstNonEmpty() {
    for (var i = 0; i < arguments.length; i++) {
      var v = arguments[i];
      if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
    }
    return '';
  }

  /** v2 叶子意图 → legacy node（字段形状对齐现有 full.json 节点） */
  function leafToLegacyNode(intent) {
    var id = intent.identity || {};
    var sd = intent.semantic_definition || {};
    var rp = intent.retrieval_profile || {};
    var tb = intent.task_binding || {};
    var eb = intent.execution_binding || {};
    var kb = intent.knowledge_binding;
    var dp = intent.decision_policy || {};
    var sl = intent.source_legacy || {};
    var labels = intent.labels || {};

    var utterance = uniq(rp.utterance_view || []);
    var aliases = utterance.slice(0, 10);
    var navPath = firstNonEmpty(eb.standard_navigation_path, sl.standard_navigation_path, '');
    var objectName = firstNonEmpty(tb.business_object && tb.business_object.object_name, '');
    var actionCode = firstNonEmpty(tb.action && tb.action.action_code, 'query');
    var actionName = firstNonEmpty(tb.action && tb.action.action_name, actionCode);
    var sceneId = 'scene_' + id.intent_id;
    var userGoal = firstNonEmpty(sd.user_goal, id.intent_name);

    return {
      node_identity: {
        node_id: id.intent_id,
        node_name: id.intent_name,
        business_category_path: firstNonEmpty(sl.business_category_path, navPath, id.domain),
        parent_business_category_path: '',
        level: 2,
        domain: id.domain,
        business_domain: id.domain,
        node_kind: 'leaf',
        entity_type: 'intent',
        is_leaf: true,
        children_business_category_paths: [],
        aliases: aliases,
        modeling_role: 'intent_candidate',
        quality_flags: ['bridged_from_v2'],
      },
      node_semantics: {
        node_description: sd.description || '',
        business_scope: uniq(sd.scope_in || []).join('、'),
        distinction_hint: uniq(sd.scope_out || []).join('、'),
        service_object: objectName,
        result_object: '',
        precondition_summary: '',
        typical_user_goals: [userGoal],
        boundary_exclusions: uniq(sd.scope_out || []),
        description_source: 'bridged_from_v2',
        description_matched_key: '',
        description_match_type: 'v2_bridge',
        semantic_description: sd.description || '',
        typical_user_goal: userGoal,
      },
      navigation: {
        standard_navigation_path: navPath,
        source_navigation_paths: [],
        source_records: [],
      },
      actions: [{
        action_code: actionCode,
        action_name: actionName,
        action_aliases: [],
        action_definition: '',
        action_source: 'v2_bridge',
        source_trigger_terms: utterance,
        supported_intent_types: [id.intent_type],
        scenes: [{
          scene_id: sceneId,
          scene_name: id.intent_name,
          intent_type: id.intent_type,
          scene_description: sd.description || '',
          user_goal: userGoal,
          standard_questions: utterance.slice(0, 8),
          similar_questions: [],
          scenario_prototypes: [],
          trigger_keywords: utterance,
          required_slots: [],
          optional_slots: [],
          clarify_questions: dp.clarify_questions || [],
          profile_constraints: [],
          scene_complexity: 'simple',
          disambiguation_hints: [],
          negative_examples: uniq(sd.scope_out || []),
          follow_up_capability: false,
          can_answer_directly: !!id.is_knowledge_intent,
          can_execute_directly: !!id.is_executable_leaf,
          evidence_terms: [],
        }],
      }],
      faq_capability: {
        faq_enabled: !!kb,
        faq_topics: [],
        faq_notes: kb ? '由 v2 knowledge_binding 桥接；问答内容待业务维护表补充。' : '',
      },
      routing_strategy: {
        parent_selection_rule: '先召回具体节点；当候选均为短名/泛名或分数接近时，回退到父节点澄清。',
        sibling_disambiguation_rule: '',
        in_node_disambiguation_rule: '先识别动作，再在节点内选择对应 scene。',
        clarify_gate_rule: '短名节点、泛动作、同父兄弟分数接近时必须澄清。',
        negative_scope_rule: '用户明确排除某产品/功能时，不命中对应节点。',
        multi_intent_rule: '当前阶段仅标记多意图，不进入执行计划。',
        semantic_prompt_strategy: '宽泛表达先落父节点或语义汇聚节点，再追问具体业务。',
        routing_rule_refs: ['V2_BRIDGE'],
      },
      governance: { source_version: labels.eval_label || '', bridge_note: 'autobuild/专家建模 v2 包桥接' },
      synthesis_metadata: { source_legacy_node_id: sl.node_id || '' },
      retrieval_profile: {
        entity_text: uniq((rp.object_view || []).concat([objectName, id.intent_name]).concat(aliases)).join(' '),
        action_text: uniq(rp.action_view || []).concat([actionName, actionCode]).join(' '),
        context_text: [navPath, id.domain].filter(Boolean).join(' '),
      },
      recognition_overlay: {},
    };
  }

  /** v2 包 → legacy bundle（纯函数，无文件 IO） */
  function bridgeToLegacy(v2Package) {
    var nodes = (v2Package.intent_nodes || []).map(leafToLegacyNode);
    var supporting = v2Package.supporting_nodes || {};

    var semanticAggregations = {};
    (v2Package.aggregate_intents || []).forEach(function (agg) {
      if (!agg.intent_name) return;
      semanticAggregations[agg.intent_name] = uniq(agg.semantic_definition && agg.semantic_definition.scope_in || []).slice(0, 8);
    });

    var actionDefinitions = {};
    (supporting.actions || []).forEach(function (a) {
      if (a.action_code) actionDefinitions[a.action_code] = a.action_name || a.action_code;
    });

    var domainDist = {};
    nodes.forEach(function (n) {
      var d = n.node_identity.domain;
      domainDist[d] = (domainDist[d] || 0) + 1;
    });

    return {
      meta: {
        name: 'intent_graph_bundle_bridged',
        version: v2Package.meta && v2Package.meta.graph_version_id || v2Package.meta && v2Package.meta.version || 'unknown',
        template_version: 'v2-bridge-1.0',
        source: v2Package.meta && v2Package.meta.graph_version_id || v2Package.meta && v2Package.meta.version || 'v2-package',
        node_count: nodes.length,
        action_count: nodes.length,
        scene_count: nodes.length,
        bridged_at: new Date().toISOString(),
      },
      summary: {
        input_menu_nodes: 0,
        intent_node_count: nodes.length,
        action_count: nodes.length,
        scene_count: nodes.length,
        semantic_hub_count: 0,
        domain_distribution: domainDist,
      },
      action_definitions: actionDefinitions,
      semantic_hubs: [],
      semantic_aggregations: semanticAggregations,
      nodes: nodes,
    };
  }

  /**
   * 读取 v2 包（按版本 ID）→ 备份旧 full.json → 写新 full.json。
   * 返回 { written, backup, node_count, version }；调用方负责路径合法性校验。
   */
  function bridgeToLegacyFile(versionId) {
    var packagePath = path.join(GRAPHS_DIR, versionId + '.json');
    if (!fs.existsSync(packagePath)) throw new Error('v2 包不存在：' + versionId);
    var v2Package = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    var bundle = bridgeToLegacy(v2Package);

    var backupPath = null;
    if (fs.existsSync(FULL_PATH)) {
      fs.mkdirSync(BACKUPS_DIR, { recursive: true });
      backupPath = path.join(BACKUPS_DIR, 'intent-graph-full-' + versionId + '.json');
      fs.copyFileSync(FULL_PATH, backupPath);
    }
    fs.writeFileSync(FULL_PATH, JSON.stringify(bundle, null, 2), 'utf8');
    return { written: FULL_PATH, backup: backupPath, node_count: bundle.nodes.length, version: versionId };
  }

  return { bridgeToLegacy: bridgeToLegacy, bridgeToLegacyFile: bridgeToLegacyFile, FULL_PATH: FULL_PATH };
});
