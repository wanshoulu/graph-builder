/**
 * 图谱智能诊断引擎（纯函数，无副作用）
 *
 * 三大检查维度：
 *   1. 格式问题   — 必填字段缺失、占位名称、空值
 *   2. 规范性问题 — 孤立节点、重复命名、结构断裂、类型约束违背
 *   3. 语义充分性 — 意图表达不足、交付配置缺失、槽位/知识未连接、边界缺失
 *
 * 每条诊断带 fix_type + fix_data，可直接生成 CandidateItem 供用户采纳。
 */
import type { GraphDocument, GraphEdge, GraphNode, GraphTemplate, GraphTemplateField, AuditFinding } from '@/api/orgGraph';
import { collectMissingRequired, primaryFieldKey } from './templateSchema';
import type { CandidateItem } from './graphDoc';

// ── 类型定义 ──

export type DiagnosisCategory = 'format' | 'normative' | 'semantic';
export type Severity = 'high' | 'medium' | 'low';
export type FixType =
  | 'add_field'      // 补充缺失字段
  | 'add_edge'       // 补充缺失关系
  | 'remove_edge'    // 删除错误关系
  | 'rename'         // 重命名
  | 'merge'          // 合并重复节点
  | 'add_utterances' // 补充典型说法
  | 'add_node'       // 新增缺失节点
  | 'manual';        // 需人工处理

export type IssueSource = 'client' | 'det' | 'sem';

export interface DiagnosisIssue {
  id: string;
  category: DiagnosisCategory;
  severity: Severity;
  title: string;
  description: string;
  nodeIds: string[];
  edgeIds: string[];
  suggestion: string;
  fixType: FixType;
  /** 可直接转为 CandidateItem 的修复数据；为 null 表示需人工判断 */
  fixData: CandidateItem[] | null;
  /** 诊断来源：client=客户端规则, det=后端确定性规则, sem=后端LLM语义分析 */
  source: IssueSource;
}

export interface DiagnosisResult {
  issues: DiagnosisIssue[];
  stats: {
    total: number;
    format: number;
    normative: number;
    semantic: number;
    high: number;
    autoFixable: number;
  };
}

// ── 工具函数 ──

function val(input: unknown): string {
  return typeof input === 'string' ? input.trim() : '';
}
function arr(input: unknown): string[] {
  return Array.isArray(input) ? input.map((v) => val(v)).filter(Boolean) : [];
}
function isPlaceholder(name: string): boolean {
  return /^(未命名|新节点|新边|示例|example|placeholder|none|null|undefined|测试|test|xxx|todo|待填|空)/i.test(name);
}
function nodeName(node: GraphNode): string {
  return val(node.properties.name) || val(node.properties.title) || node.id;
}
function nodeDegree(nodeId: string, edges: GraphEdge[]): { in: number; out: number; total: number } {
  let inDeg = 0, outDeg = 0;
  for (const e of edges) {
    if (e.target === nodeId) inDeg++;
    if (e.source === nodeId) outDeg++;
  }
  return { in: inDeg, out: outDeg, total: inDeg + outDeg };
}

// ── 1. 格式问题检查 ──

function checkFormat(document: GraphDocument, template: GraphTemplate): DiagnosisIssue[] {
  const issues: DiagnosisIssue[] = [];
  const byId = new Map(document.nodes.map((n) => [n.id, n]));

  // 1a. 必填字段缺失（复用模板 schema 校验）
  const missing = collectMissingRequired(document.nodes, document.edges, template);
  const byNode = new Map<string, { field: string; label: string }[]>();
  missing.forEach((m) => {
    if (!byNode.has(m.id)) byNode.set(m.id, []);
    byNode.get(m.id)!.push({ field: m.label.split(' ').pop() || m.label, label: m.label });
  });
  byNode.forEach((fields, nodeId) => {
    const node = byId.get(nodeId);
    if (!node) return;
    issues.push({
      id: `fmt-missing-${nodeId}`,
      category: 'format',
      severity: 'high',
      title: `${nodeName(node)} 缺少 ${fields.length} 个必填字段`,
      description: `缺失字段：${fields.map((f) => f.label).join('、')}`,
      nodeIds: [nodeId],
      edgeIds: [],
      suggestion: '补全必填字段后才能通过发布校验',
      fixType: 'manual',
      fixData: null,
      source: 'client' as const,
    });
  });

  // 1b. 占位名称
  document.nodes.forEach((node) => {
    const name = nodeName(node);
    if (isPlaceholder(name)) {
      issues.push({
        id: `fmt-placeholder-${node.id}`,
        category: 'format',
        severity: 'medium',
        title: `${name} 使用了占位名称`,
        description: `节点 ${node.id} 的名称"${name}"疑似占位符，需替换为有业务含义的名称`,
        nodeIds: [node.id],
        edgeIds: [],
        suggestion: '替换为有业务含义的名称',
        fixType: 'rename',
        fixData: null,
        source: 'client' as const,
      });
    }
  });

  // 1c. 空图谱
  if (document.nodes.length === 0) {
    issues.push({
      id: 'fmt-empty-graph',
      category: 'format',
      severity: 'high',
      title: '图谱为空',
      description: '当前画布没有任何节点，请先从模板创建或导入内容',
      nodeIds: [], edgeIds: [],
      suggestion: '使用 AI 自动建图或手动添加节点',
      fixType: 'manual',
      fixData: null,
      source: 'client' as const,
    });
  }

  return issues;
}

// ── 2. 规范性问题检查 ──

function checkNormative(document: GraphDocument, template: GraphTemplate): DiagnosisIssue[] {
  const issues: DiagnosisIssue[] = [];
  const edges = document.edges || [];
  const byId = new Map(document.nodes.map((n) => [n.id, n]));

  // 2a. 孤立节点（无任何边连接）
  const connectedIds = new Set<string>();
  edges.forEach((e) => { connectedIds.add(e.source); connectedIds.add(e.target); });
  const orphans = document.nodes.filter((n) => !connectedIds.has(n.id));
  if (orphans.length > 0 && orphans.length < document.nodes.length) {
    orphans.forEach((node) => {
      issues.push({
        id: `nor-orphan-${node.id}`,
        category: 'normative',
        severity: 'medium',
        title: `${nodeName(node)} 是孤立节点`,
        description: `节点 ${node.id}（${node.type}）没有任何关系连接，可能是遗漏或误删`,
        nodeIds: [node.id],
        edgeIds: [],
        suggestion: '检查是否需要连接到相关意图或业务对象',
        fixType: 'add_edge',
        fixData: null,
        source: 'client' as const,
      });
    });
  }

  // 2b. 重复命名（同类型同名）
  const nameTypeMap = new Map<string, GraphNode[]>();
  document.nodes.forEach((node) => {
    const name = nodeName(node);
    if (!name) return;
    const key = `${node.type}::${name}`;
    if (!nameTypeMap.has(key)) nameTypeMap.set(key, []);
    nameTypeMap.get(key)!.push(node);
  });
  nameTypeMap.forEach((nodes, key) => {
    if (nodes.length < 2) return;
    const [name] = key.split('::');
    issues.push({
      id: `nor-dup-${key}`,
      category: 'normative',
      severity: 'medium',
      title: `${nodes.length} 个${nodes[0].type}节点同名"${name}"`,
      description: `节点 ${nodes.map((n) => n.id).join('、')} 名称相同，可能是重复建模`,
      nodeIds: nodes.map((n) => n.id),
      edgeIds: [],
      suggestion: '确认是否为同一实体，如是则合并',
      fixType: 'merge',
      fixData: [{
        kind: 'node', status: 'merge', existingId: nodes[0].id,
        item: { ...nodes[1], properties: { ...nodes[1].properties } },
        message: `将 ${nodes[1].id} 合并到 ${nodes[0].id}（同名同类型）`,
      }],
      source: 'client' as const,
    });
  });

  // 2c. 超级枢纽节点（度数 >= 45）
  document.nodes.forEach((node) => {
    const deg = nodeDegree(node.id, edges);
    if (deg.total >= 45) {
      issues.push({
        id: `nor-hub-${node.id}`,
        category: 'normative',
        severity: 'low',
        title: `${nodeName(node)} 是超度枢纽（${deg.total} 条边）`,
        description: `节点 ${node.id} 连接了 ${deg.total} 条边，可能需要拆分为子分组`,
        nodeIds: [node.id],
        edgeIds: [],
        suggestion: '考虑拆分为多个子节点或引入中间层',
        fixType: 'manual',
        fixData: null,
        source: 'client' as const,
      });
    }
  });

  // 2d. 边端点缺失
  edges.forEach((edge) => {
    if (!byId.has(edge.source) || !byId.has(edge.target)) {
      issues.push({
        id: `nor-edge-endpoint-${edge.id}`,
        category: 'normative',
        severity: 'high',
        title: `关系 ${edge.type} 端点缺失`,
        description: `边 ${edge.id}（${edge.type}）的${!byId.has(edge.source) ? '起点' : '终点'} ${!byId.has(edge.source) ? edge.source : edge.target} 不存在于节点列表`,
        nodeIds: [],
        edgeIds: [edge.id],
        suggestion: '删除此边或补充缺失的节点',
        fixType: 'remove_edge',
        fixData: null,
        source: 'client' as const,
      });
    }
  });

  // 2e. 自环边
  edges.forEach((edge) => {
    if (edge.source === edge.target) {
      issues.push({
        id: `nor-selfloop-${edge.id}`,
        category: 'normative',
        severity: 'medium',
        title: `${edge.type} 存在自环`,
        description: `边 ${edge.id} 的起点和终点都是 ${edge.source}，自环通常无业务意义`,
        nodeIds: [edge.source],
        edgeIds: [edge.id],
        suggestion: '删除自环边',
        fixType: 'remove_edge',
        fixData: null,
        source: 'client' as const,
      });
    }
  });

  // 2f. 未使用的模板类型
  const usedTypes = new Set(document.nodes.map((n) => n.type));
  template.node_types.forEach((nt) => {
    if (!usedTypes.has(nt.type)) {
      issues.push({
        id: `nor-unused-type-${nt.type}`,
        category: 'normative',
        severity: 'low',
        title: `模板类型 ${nt.label}(${nt.type}) 无实例`,
        description: `模板声明了节点类型 ${nt.type}，但当前图谱没有该类型的节点`,
        nodeIds: [],
        edgeIds: [],
        suggestion: '确认是否需要补充该类型节点',
        fixType: 'manual',
        fixData: null,
        source: 'client' as const,
      });
    }
  });

  return issues;
}

// ── 3. 语义充分性检查（意图图谱专用） ──

function checkSemantic(document: GraphDocument, template: GraphTemplate): DiagnosisIssue[] {
  const issues: DiagnosisIssue[] = [];
  const edges = document.edges || [];
  const byId = new Map(document.nodes.map((n) => [n.id, n]));
  const isIntentGraph = template.template_id === 'intent-graph';
  if (!isIntentGraph) return issues;

  const intents = document.nodes.filter((n) => n.type === 'INTENT');
  const aggregates = document.nodes.filter((n) => n.type === 'AGGREGATE_INTENT');
  const slots = document.nodes.filter((n) => n.type === 'SLOT');
  const answers = document.nodes.filter((n) => n.type === 'KNOWLEDGE_ANSWER');
  const actions = document.nodes.filter((n) => n.type === 'ACTION');
  const objects = document.nodes.filter((n) => n.type === 'BUSINESS_OBJECT');

  // 边索引
  const outEdges = new Map<string, GraphEdge[]>();
  const inEdges = new Map<string, GraphEdge[]>();
  edges.forEach((e) => {
    if (!outEdges.has(e.source)) outEdges.set(e.source, []);
    outEdges.get(e.source)!.push(e);
    if (!inEdges.has(e.target)) inEdges.set(e.target, []);
    inEdges.get(e.target)!.push(e);
  });

  // 3a. 意图节点典型说法不足（< 3 条）
  intents.forEach((node) => {
    const utterances = [...arr(node.properties.utterance_view), ...arr(node.properties.scope_in)];
    if (utterances.length < 3) {
      const need = 3 - utterances.length;
      issues.push({
        id: `sem-utterance-${node.id}`,
        category: 'semantic',
        severity: utterances.length === 0 ? 'high' : 'medium',
        title: `${nodeName(node)} 典型说法不足（仅 ${utterances.length} 条）`,
        description: `意图 ${node.id} 只有 ${utterances.length} 条典型说法，建议至少 3 条以保证召回率。已有：${utterances.join('、') || '（无）'}`,
        nodeIds: [node.id],
        edgeIds: [],
        suggestion: `补充 ${need} 条真实用户问法`,
        fixType: 'add_utterances',
        fixData: [{
          kind: 'node', status: 'merge', existingId: node.id,
          item: { id: node.id, type: 'INTENT', properties: {
            name: nodeName(node),
            utterance_view: utterances,
            scope_in: utterances,
          } },
          message: `补充典型说法到已有意图（需 AI 生成 ${need} 条后合并）`,
        }],
        source: 'client' as const,
      });
    }
  });

  // 3b. 意图节点缺少 intent_type
  intents.forEach((node) => {
    if (!val(node.properties.intent_type)) {
      issues.push({
        id: `sem-intent-type-${node.id}`,
        category: 'semantic',
        severity: 'medium',
        title: `${nodeName(node)} 缺少意图类别`,
        description: `意图 ${node.id} 没有设置 intent_type（QUERY/DO/CHANGE/CANCEL/ASK/HELP），影响动作判定和路由`,
        nodeIds: [node.id],
        edgeIds: [],
        suggestion: '根据意图语义设置正确的 intent_type',
        fixType: 'add_field',
        fixData: null,
        source: 'client' as const,
      });
    }
  });

  // 3c. 意图节点缺少交付配置（fulfillment_kind）
  intents.forEach((node) => {
    const kind = val(node.properties.fulfillment_kind);
    if (!kind || kind === 'unconfigured') {
      issues.push({
        id: `sem-fulfillment-${node.id}`,
        category: 'semantic',
        severity: 'medium',
        title: `${nodeName(node)} 未配置交付方式`,
        description: `意图 ${node.id} 没有设置 fulfillment_kind，无法确定该意图命中后如何交付（answer/query/menu/skill/workflow/agent）`,
        nodeIds: [node.id],
        edgeIds: [],
        suggestion: '配置交付方式：知识答案 / 查询接口 / 菜单 / 技能 / 工作流 / 智能体',
        fixType: 'add_field',
        fixData: null,
        source: 'client' as const,
      });
    }
  });

  // 3d. mock/演示交付引用
  intents.forEach((node) => {
    const kind = val(node.properties.fulfillment_kind);
    const refFields: Record<string, string> = {
      query: 'query_ref', menu: 'menu_ref', skill: 'skill_ref',
      workflow: 'workflow_ref', agent: 'agent_ref',
    };
    const ref = val(node.properties[refFields[kind] || '']);
    if (ref && /^mock:|^\/mock\//.test(ref)) {
      issues.push({
        id: `sem-mock-ref-${node.id}`,
        category: 'semantic',
        severity: 'low',
        title: `${nodeName(node)} 使用了 mock 交付引用`,
        description: `意图 ${node.id} 的交付引用 ${ref} 是 mock 值，需替换为真实能力`,
        nodeIds: [node.id],
        edgeIds: [],
        suggestion: '替换为真实的能力 ID',
        fixType: 'manual',
        fixData: null,
        source: 'client' as const,
      });
    }
    const answerText = val(node.properties.answer_text);
    if (answerText.startsWith('【演示】') || answerText.startsWith('【mock】')) {
      issues.push({
        id: `sem-mock-answer-${node.id}`,
        category: 'semantic',
        severity: 'low',
        title: `${nodeName(node)} 使用了演示答案`,
        description: `意图 ${node.id} 的答案文本是演示值，需替换为正式内容`,
        nodeIds: [node.id],
        edgeIds: [],
        suggestion: '替换为正式知识答案',
        fixType: 'manual',
        fixData: null,
        source: 'client' as const,
      });
    }
  });

  // 3e. 意图节点未挂载到聚合意图
  intents.forEach((node) => {
    const parentId = val(node.properties.parent_intent_id);
    if (!parentId) {
      issues.push({
        id: `sem-no-parent-${node.id}`,
        category: 'semantic',
        severity: 'medium',
        title: `${nodeName(node)} 未归属任何意图分组`,
        description: `意图 ${node.id} 没有设置 parent_intent_id，将无法在意图树中被正确组织`,
        nodeIds: [node.id],
        edgeIds: [],
        suggestion: '归属到合适的 AGGREGATE_INTENT 或创建新分组',
        fixType: 'add_edge',
        fixData: null,
        source: 'client' as const,
      });
    } else if (!byId.has(parentId)) {
      issues.push({
        id: `sem-bad-parent-${node.id}`,
        category: 'semantic',
        severity: 'high',
        title: `${nodeName(node)} 的父分组不存在`,
        description: `意图 ${node.id} 的 parent_intent_id 指向 ${parentId}，但该节点不存在`,
        nodeIds: [node.id],
        edgeIds: [],
        suggestion: '修正 parent_intent_id 或创建对应的聚合意图节点',
        fixType: 'add_edge',
        fixData: null,
        source: 'client' as const,
      });
    }
  });

  // 3f. 聚合意图无叶子意图
  aggregates.forEach((node) => {
    const leafCount = intents.filter((i) => val(i.properties.parent_intent_id) === node.id).length;
    if (leafCount === 0) {
      issues.push({
        id: `sem-empty-aggregate-${node.id}`,
        category: 'semantic',
        severity: 'medium',
        title: `意图分组 ${nodeName(node)} 下无叶子意图`,
        description: `AGGREGATE_INTENT ${node.id} 没有任何子意图，空分组无业务意义`,
        nodeIds: [node.id],
        edgeIds: [],
        suggestion: '补充子意图或删除此空分组',
        fixType: 'manual',
        fixData: null,
        source: 'client' as const,
      });
    }
  });

  // 3g. SLOT 节点未连接到任何 INTENT
  slots.forEach((node) => {
    const connected = (inEdges.get(node.id) || []).some((e) => e.type === 'requires_slot' || e.type === 'optional_slot');
    if (!connected) {
      issues.push({
        id: `sem-orphan-slot-${node.id}`,
        category: 'semantic',
        severity: 'medium',
        title: `识别要素 ${nodeName(node)} 未被任何意图使用`,
        description: `SLOT ${node.id} 没有通过 requires_slot 或 optional_slot 连接到意图`,
        nodeIds: [node.id],
        edgeIds: [],
        suggestion: '连接到使用该要素的意图，或删除无用要素',
        fixType: 'add_edge',
        fixData: null,
        source: 'client' as const,
      });
    }
  });

  // 3h. KNOWLEDGE_ANSWER 节点未连接到任何 INTENT
  answers.forEach((node) => {
    const connected = (inEdges.get(node.id) || []).some((e) => e.type === 'has_knowledge_answer');
    if (!connected) {
      issues.push({
        id: `sem-orphan-answer-${node.id}`,
        category: 'semantic',
        severity: 'low',
        title: `知识答案 ${nodeName(node)} 未被任何意图引用`,
        description: `KNOWLEDGE_ANSWER ${node.id} 没有通过 has_knowledge_answer 连接到意图`,
        nodeIds: [node.id],
        edgeIds: [],
        suggestion: '连接到对应意图，或删除无用答案',
        fixType: 'add_edge',
        fixData: null,
        source: 'client' as const,
      });
    }
  });

  // 3i. ACTION 节点未连接到任何 INTENT
  actions.forEach((node) => {
    const connected = (inEdges.get(node.id) || []).some((e) => e.type === 'uses_action');
    if (!connected) {
      issues.push({
        id: `sem-orphan-action-${node.id}`,
        category: 'semantic',
        severity: 'low',
        title: `业务动作 ${nodeName(node)} 未被任何意图使用`,
        description: `ACTION ${node.id} 没有通过 uses_action 连接到意图`,
        nodeIds: [node.id],
        edgeIds: [],
        suggestion: '连接到使用该动作的意图',
        fixType: 'add_edge',
        fixData: null,
        source: 'client' as const,
      });
    }
  });

  // 3j. BUSINESS_OBJECT 节点未连接到任何 INTENT
  objects.forEach((node) => {
    const connected = (inEdges.get(node.id) || []).some((e) => e.type === 'acts_on_object');
    if (!connected) {
      issues.push({
        id: `sem-orphan-object-${node.id}`,
        category: 'semantic',
        severity: 'low',
        title: `业务对象 ${nodeName(node)} 未被任何意图使用`,
        description: `BUSINESS_OBJECT ${node.id} 没有通过 acts_on_object 连接到意图`,
        nodeIds: [node.id],
        edgeIds: [],
        suggestion: '连接到操作该对象的意图',
        fixType: 'add_edge',
        fixData: null,
        source: 'client' as const,
      });
    }
  });

  // 3k. 意图缺少排除边界（scope_out）
  intents.forEach((node) => {
    if (arr(node.properties.scope_out).length === 0 && arr(node.properties.negative_view).length === 0) {
      issues.push({
        id: `sem-no-scope-out-${node.id}`,
        category: 'semantic',
        severity: 'low',
        title: `${nodeName(node)} 未设置排除边界`,
        description: `意图 ${node.id} 没有配置 scope_out 或 negative_view，可能导致误召回`,
        nodeIds: [node.id],
        edgeIds: [],
        suggestion: '补充不属于此意图的边界说法',
        fixType: 'manual',
        fixData: null,
        source: 'client' as const,
      });
    }
  });

  return issues;
}

// ── 主入口 ──

export function diagnoseGraph(document: GraphDocument, template: GraphTemplate): DiagnosisResult {
  const all = [
    ...checkFormat(document, template),
    ...checkNormative(document, template),
    ...checkSemantic(document, template),
  ].map((issue) => ({ ...issue, source: 'client' as const }));
  const stats = {
    total: all.length,
    format: all.filter((i) => i.category === 'format').length,
    normative: all.filter((i) => i.category === 'normative').length,
    semantic: all.filter((i) => i.category === 'semantic').length,
    high: all.filter((i) => i.severity === 'high').length,
    autoFixable: all.filter((i) => i.fixData !== null).length,
  };
  return { issues: all, stats };
}

// ── 后端 AuditFinding → DiagnosisIssue 转换 ──

/** 后端 audit category → 客户端三维度映射 */
const AUDIT_CATEGORY_MAP: Record<string, DiagnosisCategory> = {
  orphan_node: 'normative',
  duplicate_nodes: 'normative',
  placeholder_name: 'format',
  hub_node: 'normative',
  unused_type: 'normative',
  invalid_edge_endpoint: 'normative',
  undeclared_edge_type: 'normative',
  missing_required_field: 'normative',
  invalid_enum_value: 'normative',
  missing_relation: 'semantic',
  type_mismatch: 'normative',
  suspicious_edge: 'semantic',
  boundary_conflict: 'semantic',
  insufficient_utterances: 'semantic',
  coverage_gap: 'semantic',
  delivery_incomplete: 'semantic',
  semantic_overlap: 'semantic',
  other: 'format',
};

/** 后端可自动修复的 category */
const AUDIT_AUTO_FIXABLE = new Set(['orphan_node', 'duplicate_nodes', 'invalid_edge_endpoint', 'undeclared_edge_type', 'missing_required_field', 'invalid_enum_value']);

/** 后端 audit category → 中文标签 */
export const AUDIT_CATEGORY_LABELS: Record<string, string> = {
  orphan_node: '孤立节点',
  duplicate_nodes: '疑似重复',
  placeholder_name: '占位名称',
  hub_node: '超度枢纽',
  unused_type: '未用类型',
  invalid_edge_endpoint: '端点违规',
  undeclared_edge_type: '未声明边类型',
  missing_required_field: '必填字段缺失',
  invalid_enum_value: '枚举值非法',
  missing_relation: '缺失关系',
  type_mismatch: '类型不匹配',
  suspicious_edge: '可疑边',
  boundary_conflict: '边界冲突',
  insufficient_utterances: '说法不足',
  coverage_gap: '覆盖缺口',
  delivery_incomplete: '交付链断',
  semantic_overlap: '语义重叠',
  other: '其他',
};

/** 将后端 AuditFinding 转为 DiagnosisIssue，可合并到统一诊断列表 */
export function auditFindingToIssue(finding: AuditFinding, index: number, source: 'det' | 'sem'): DiagnosisIssue {
  const category = AUDIT_CATEGORY_MAP[finding.category] || 'format';
  const canAutoFix = AUDIT_AUTO_FIXABLE.has(finding.category);
  return {
    id: `audit-${source}-${index}-${finding.category}`,
    category,
    severity: finding.severity as Severity,
    title: finding.issue.slice(0, 80),
    description: finding.issue,
    nodeIds: finding.node_ids || [],
    edgeIds: finding.edge_ids || [],
    suggestion: finding.suggestion || '',
    fixType: canAutoFix ? 'add_edge' : 'manual',
    fixData: null,
    source,
  };
}

// ── 分类标签 ──

export const CATEGORY_LABELS: Record<DiagnosisCategory, { label: string; color: string; icon: string }> = {
  format: { label: '格式问题', color: 'red', icon: '⚠' },
  normative: { label: '规范性问题', color: 'orange', icon: '📐' },
  semantic: { label: '语义充分性', color: 'blue', icon: '🧠' },
};

export const SEVERITY_LABELS: Record<Severity, { label: string; color: string }> = {
  high: { label: '严重', color: 'red' },
  medium: { label: '中等', color: 'orange' },
  low: { label: '提示', color: 'default' },
};

export const SOURCE_LABELS: Record<IssueSource, { label: string; color: string }> = {
  client: { label: '规则', color: 'default' },
  det: { label: '后端规则', color: 'cyan' },
  sem: { label: 'AI 语义', color: 'purple' },
};
