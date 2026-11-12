import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Drawer, Empty, Segmented, Space, Spin, Tag, Typography } from 'antd';
import { BulbOutlined, CheckOutlined, AuditOutlined, ThunderboltOutlined, MessageOutlined } from '@ant-design/icons';
import { message } from '@/utils/antdStatic';
import type { GraphDocument, GraphEdge, GraphNode, GraphTemplate, AuditResult, AuditFinding } from '@/api/orgGraph';
import { validateGraph, createBuilderAgentSession, streamAuditGraph, invokeBuilderAgent, releaseBuilderAgentSession } from '@/api/orgGraph';
import { analyzeCandidates, applyCandidates, type CandidateItem } from '../lib/graphDoc';
import { diagnoseGraph, auditFindingToIssue, CATEGORY_LABELS, SEVERITY_LABELS, SOURCE_LABELS, type DiagnosisIssue } from '../lib/graphDiagnosis';
import { BuilderAgentChat } from '../shared/BuilderAgentChat';

const { Text } = Typography;

interface Props {
  open: boolean;
  onClose: () => void;
  asset: string;
  template: GraphTemplate;
  currentDocument: GraphDocument;
  onMerged: (document: GraphDocument) => void;
  onLocateNode?: (id: string) => void;
  /** 选中的意图分组节点 ID（AGGREGATE_INTENT），用于按组作用域 */
  groupNodeId?: string;
  /** 打开后自动执行审核补全 */
  autoStart?: boolean;
  /** 材料库取证文本（传递给 BuilderAgentChat 的 fill_gaps） */
  fillSourceText?: string;
}

const NODE_NAMES: Record<string, string> = {
  AGGREGATE_INTENT: '意图分组', INTENT: '具体意图', BUSINESS_OBJECT: '业务对象',
  SLOT: '识别要素', KNOWLEDGE_ANSWER: '知识答案', ACTION: '业务动作',
};
const EDGE_NAMES: Record<string, string> = {
  has_leaf_intent: '归入意图分组', requires_slot: '需要识别要素',
  optional_slot: '可选识别要素', has_knowledge_answer: '关联知识答案',
  acts_on_object: '作用于业务对象', uses_action: '关联业务动作',
};
const NODE_FIELD_LABELS: Record<string, string> = {
  name: '名称', title: '标题', intent_type: '意图类别', domain: '业务领域',
  utterance_view: '典型说法', deliver_type: '交付方式', deliver_target: '交付目标',
  knowledge_answer: '知识答案', parent_intent_id: '所属分组', description: '描述',
};
const STATUS: Record<CandidateItem['status'], { label: string; color: string }> = {
  new: { label: '建议新增', color: 'blue' },
  merge: { label: '补充已有', color: 'green' },
  duplicate: { label: '已存在', color: 'default' },
  conflict: { label: '类型待核对', color: 'orange' },
  endpoint_missing: { label: '连接不完整', color: 'red' },
};
const SEV_HIGHLIGHT: Record<string, string> = { high: '#ff4d4f', medium: '#faad14', low: '#1677ff' };
const SEV_PRIORITY: Record<string, number> = { high: 3, medium: 2, low: 1 };
const CAND_HIGHLIGHT: Record<string, string> = { new: '#1890ff', merge: '#52c41a', conflict: '#faad14', endpoint_missing: '#ff4d4f' };

function nodeName(node: GraphNode): string { return String(node.properties.name || node.properties.title || node.id); }
function list(value: unknown): string[] { return Array.isArray(value) ? value.filter((item) => typeof item === 'string').slice(0, 4) : []; }

/** 描述修复方案的具体内容，让用户明确"处理"的是什么 */
function describeFix(fixData: CandidateItem[]): string {
  const newNodes = fixData.filter((c) => c.kind === 'node' && c.status === 'new').length;
  const mergeNodes = fixData.filter((c) => c.kind === 'node' && c.status === 'merge').length;
  const newEdges = fixData.filter((c) => c.kind === 'edge' && c.status === 'new').length;
  const parts: string[] = [];
  if (newNodes) parts.push(`新增 ${newNodes} 个节点`);
  if (mergeNodes) parts.push(`补充 ${mergeNodes} 个节点字段`);
  if (newEdges) parts.push(`新增 ${newEdges} 条关系`);
  return parts.length > 0 ? parts.join('、') : '应用修复';
}

/**
 * 兜底差异提取：当 analyzeCandidates 返回 0 条 actionable 时，
 * 直接对比 AI 返回文档与当前文档，提取有新增/变更内容的节点和边作为候选。
 */
function extractDiffCandidates(base: GraphDocument, ai: GraphDocument): CandidateItem[] {
  const candidates: CandidateItem[] = [];
  const baseNodeMap = new Map(base.nodes.map((n) => [n.id, n]));
  const baseEdgeSet = new Set(base.edges.map((e) => `${e.source}|${e.target}|${e.type}`));

  ai.nodes.forEach((aiNode) => {
    const existing = baseNodeMap.get(aiNode.id);
    if (!existing) {
      candidates.push({ kind: 'node', status: 'new', item: aiNode });
      return;
    }
    const hasNewContent = Object.keys(aiNode.properties || {}).some((k) => {
      const aiVal = aiNode.properties[k];
      const oldVal = existing.properties[k];
      if (Array.isArray(aiVal) && Array.isArray(oldVal)) {
        return aiVal.length > oldVal.length;
      }
      if (Array.isArray(aiVal) && !oldVal) {
        return aiVal.length > 0;
      }
      return (aiVal !== undefined && aiVal !== null && aiVal !== '')
        && (oldVal === undefined || oldVal === null || oldVal === '');
    });
    if (hasNewContent) {
      candidates.push({
        kind: 'node', status: 'merge', item: aiNode, existingId: existing.id,
        message: 'AI 补充了缺失字段或扩展内容',
      });
    }
  });

  ai.edges.forEach((aiEdge) => {
    const triple = `${aiEdge.source}|${aiEdge.target}|${aiEdge.type}`;
    if (!baseEdgeSet.has(triple)) {
      const srcExists = baseNodeMap.has(aiEdge.source) || candidates.some((c) => c.kind === 'node' && c.item.id === aiEdge.source);
      const tgtExists = baseNodeMap.has(aiEdge.target) || candidates.some((c) => c.kind === 'node' && c.item.id === aiEdge.target);
      if (srcExists && tgtExists) {
        candidates.push({ kind: 'edge', status: 'new', item: aiEdge });
      } else {
        candidates.push({ kind: 'edge', status: 'endpoint_missing', item: aiEdge, message: 'AI 建议的关系连接了不存在的节点' });
      }
    }
  });

  return candidates;
}

// ── 分批处理工具（避免大规模图谱导致 Agent 上下文溢出） ──
const UTTERANCE_BATCH_SIZE = 10;  // 语义说法补全每批最多 10 个意图
const FULL_BATCH_SIZE = 15;       // 全面补全每批最多 15 个节点

/** 创建子文档：只包含指定节点及其之间的边 */
function createSubDocument(doc: GraphDocument, nodeIds: Set<string>): GraphDocument {
  const nodes = doc.nodes.filter((n) => nodeIds.has(n.id));
  const edges = doc.edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));
  return { nodes, edges };
}

/**
 * 按意图分组提取子图：以 AGGREGATE_INTENT 为根，
 * 包含其所有子意图（has_leaf_intent）及子意图关联的要素、答案、对象、动作节点。
 */
function extractGroupSubDocument(doc: GraphDocument, groupNodeId: string): GraphDocument {
  const groupNode = doc.nodes.find((n) => n.id === groupNodeId);
  if (!groupNode) return doc;

  const nodeIds = new Set<string>([groupNodeId]);

  // 1. 找到 has_leaf_intent 边连接的子意图
  doc.edges
    .filter((e) => e.type === 'has_leaf_intent' && (e.source === groupNodeId || e.target === groupNodeId))
    .forEach((e) => {
      const childId = e.source === groupNodeId ? e.target : e.source;
      nodeIds.add(childId);
    });

  // 也通过 parent_intent_id 属性找子意图（兼容无边的情况）
  doc.nodes
    .filter((n) => n.type === 'INTENT' && n.properties.parent_intent_id === groupNodeId)
    .forEach((n) => nodeIds.add(n.id));

  // 2. 找子意图关联的其他节点（要素、答案、对象、动作）
  const childEdges = doc.edges.filter((e) =>
    nodeIds.has(e.source) || nodeIds.has(e.target)
  );
  childEdges.forEach((e) => {
    // 只加入子意图的下游节点，不把其他 AGGREGATE_INTENT 拉进来
    if (nodeIds.has(e.source) && !nodeIds.has(e.target)) {
      const targetNode = doc.nodes.find((n) => n.id === e.target);
      if (targetNode && targetNode.type !== 'AGGREGATE_INTENT') {
        nodeIds.add(e.target);
      }
    } else if (nodeIds.has(e.target) && !nodeIds.has(e.source)) {
      const sourceNode = doc.nodes.find((n) => n.id === e.source);
      if (sourceNode && sourceNode.type !== 'AGGREGATE_INTENT') {
        nodeIds.add(e.source);
      }
    }
  });

  return createSubDocument(doc, nodeIds);
}

/** 合并多个 AI 返回的文档：节点按 ID 合并（AI 新字段/数组增量合并），边去重 */
function mergeAIDocuments(docs: GraphDocument[]): GraphDocument {
  const nodeMap = new Map<string, GraphNode>();
  const edgeSet = new Set<string>();
  const edges: GraphEdge[] = [];
  for (const doc of docs) {
    for (const node of doc.nodes) {
      const existing = nodeMap.get(node.id);
      if (existing) {
        const mergedProps = { ...existing.properties };
        for (const [k, v] of Object.entries(node.properties || {})) {
          if (v == null || v === '') continue;
          const oldVal = mergedProps[k];
          if (Array.isArray(v) && Array.isArray(oldVal)) {
            mergedProps[k] = [...new Set([...oldVal, ...v])];
          } else if (Array.isArray(v) && !oldVal) {
            mergedProps[k] = v;
          } else if (!oldVal) {
            mergedProps[k] = v;
          }
        }
        nodeMap.set(node.id, { ...existing, properties: mergedProps });
      } else {
        nodeMap.set(node.id, node);
      }
    }
    for (const edge of doc.edges) {
      const key = `${edge.source}|${edge.target}|${edge.type}`;
      if (!edgeSet.has(key)) { edgeSet.add(key); edges.push(edge); }
    }
  }
  return { nodes: [...nodeMap.values()], edges };
}

/** 从 Agent 调用结果中解析图谱文档（修复贪婪正则，从宽到窄尝试） */
function parseAgentDocument(result: { status: string; reply: string; document?: unknown }): GraphDocument | null {
  if (result.document) return result.document as GraphDocument;
  const firstBrace = result.reply.indexOf('{');
  if (firstBrace >= 0) {
    for (let last = result.reply.lastIndexOf('}'); last > firstBrace; last = result.reply.lastIndexOf('}', last - 1)) {
      try {
        const parsed = JSON.parse(result.reply.slice(firstBrace, last + 1));
        if (parsed.document) return parsed.document as GraphDocument;
      } catch { /* try narrower */ }
    }
  }
  return null;
}

export function AiAssistDrawer({ open, onClose, asset, template, currentDocument, onMerged, onLocateNode, groupNodeId, autoStart, fillSourceText }: Props) {
  // ── Tab 切换 ──
  const [tab, setTab] = useState<'diagnose' | 'suggest' | 'agent'>('diagnose');

  // ── 按组作用域：选中 AGGREGATE_INTENT 时只处理本组子图 ──
  const groupNode = groupNodeId ? currentDocument.nodes.find((n) => n.id === groupNodeId && n.type === 'AGGREGATE_INTENT') : null;
  const groupName = groupNode ? nodeName(groupNode) : '';
  /** 实际交给 AI 处理的文档：有分组时只含本组子图，否则全量 */
  const scopeDoc = useMemo(() => {
    if (!groupNodeId) return currentDocument;
    return extractGroupSubDocument(currentDocument, groupNodeId);
  }, [currentDocument, groupNodeId]);

  // ── 诊断相关状态 ──
  const [diagnosisIssues, setDiagnosisIssues] = useState<DiagnosisIssue[] | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);
  const [auditing, setAuditing] = useState(false);
  const [auditProgress, setAuditProgress] = useState<{ current: number; total: number; step: string } | null>(null);
  const [auditResult, setAuditResult] = useState<AuditResult | null>(null);
  const [expandedCategory, setExpandedCategory] = useState<string | null>(null);
  const [issueApplied, setIssueApplied] = useState<Set<string>>(new Set());
  const [validationError, setValidationError] = useState('');

  // ── AI 补全相关状态 ──
  const [generating, setGenerating] = useState(false);
  const [genStep, setGenStep] = useState('');
  const [batchProgress, setBatchProgress] = useState<{ current: number; total: number; step: string } | null>(null);
  const [applying, setApplying] = useState(false);
  const [candidates, setCandidates] = useState<CandidateItem[] | null>(null);
  const [excluded, setExcluded] = useState<Record<number, boolean>>({});
  const [lastApplied, setLastApplied] = useState('');
  const [suggestError, setSuggestError] = useState('');

  // ── 补全候选项状态 ──

  const names = useMemo(() => {
    const map = new Map(scopeDoc.nodes.map((node) => [node.id, nodeName(node)]));
    candidates?.forEach((candidate) => {
      if (candidate.kind === 'node') map.set(candidate.item.id, nodeName(candidate.item as GraphNode));
    });
    return map;
  }, [scopeDoc, candidates]);
  const selectedNodeIds = useMemo(() => {
    const ids = new Set(scopeDoc.nodes.map((node) => node.id));
    candidates?.forEach((candidate, index) => {
      if (candidate.kind === 'node' && candidate.status === 'new' && !excluded[index]) ids.add(candidate.item.id);
    });
    return ids;
  }, [scopeDoc, candidates, excluded]);
  const included = useMemo(() => (candidates || []).filter((candidate, index) => {
    if (excluded[index] || !['new', 'merge'].includes(candidate.status)) return false;
    if (candidate.kind === 'edge') {
      const edge = candidate.item as GraphEdge;
      return selectedNodeIds.has(edge.source) && selectedNodeIds.has(edge.target);
    }
    return true;
  }), [candidates, excluded, selectedNodeIds]);
  const actionableCount = candidates?.filter((item) => item.status === 'new' || item.status === 'merge').length || 0;

  const diagnosisStats = useMemo(() => {
    if (!diagnosisIssues) return null;
    const active = diagnosisIssues.filter((i) => !issueApplied.has(i.id));
    const cats = { format: 0, normative: 0, semantic: 0 };
    let high = 0;
    let autoFixable = 0;
    let fromAI = 0;
    let fromRules = 0;
    active.forEach((i) => {
      cats[i.category]++;
      if (i.severity === 'high') high++;
      if (i.fixData) autoFixable++;
      if (i.source === 'sem' || i.source === 'det') fromAI++;
      else fromRules++;
    });
    return { ...cats, total: active.length, high, autoFixable, fromAI, fromRules, fixed: issueApplied.size };
  }, [diagnosisIssues, issueApplied]);

  // ── 画布选中联动：诊断问题时定位画布节点（每次诊断只自动定位一次，SSE 批次不重复触发） ──
  const autoLocatedRef = useRef(false);
  useEffect(() => {
    if (!diagnosisIssues || diagnosisIssues.length === 0) return;
    if (autoLocatedRef.current) return;
    const highIssue = diagnosisIssues.find((i) => i.severity === 'high' && i.nodeIds.length > 0);
    if (highIssue && onLocateNode) {
      autoLocatedRef.current = true;
      onLocateNode(highIssue.nodeIds[0]);
    }
  }, [diagnosisIssues]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 诊断操作：Phase 1 规则秒出 + Phase 2 SSE 流式后端审核 ──
  async function runDiagnosis() {
    setDiagnosing(true);
    setAuditing(false);
    setAuditProgress(null);
    setAuditResult(null);
    setIssueApplied(new Set());
    setValidationError('');
    autoLocatedRef.current = false;

    // Phase 1: 客户端规则诊断（即时）
    const result = diagnoseGraph(scopeDoc, template);
    setDiagnosisIssues(result.issues);
    const firstCat = result.issues.find((i) => i.severity === 'high')?.category || result.issues[0]?.category || null;
    setExpandedCategory(firstCat);
    setDiagnosing(false);

    if (result.issues.length === 0) {
      message.info(groupName ? `「${groupName}」规则诊断未发现问题，正在启动 AI 深度语义分析…` : '规则诊断未发现问题，正在启动 AI 深度语义分析…');
    } else {
      message.info(groupName ? `「${groupName}」规则诊断发现 ${result.issues.length} 个问题，AI 语义分析并行运行…` : `规则诊断发现 ${result.issues.length} 个问题，AI 语义分析并行运行…`);
    }

    // Phase 2: SSE 流式后端审核（渐进式推送发现）
    setAuditing(true);
    setAuditProgress({ current: 0, total: 0, step: '正在连接审核服务…' });
    let sessionId: string | null = null;
    let streamHadError = false;
    try {
      const session = await createBuilderAgentSession(asset, scopeDoc);
      sessionId = session.sessionId;

      await streamAuditGraph(sessionId, asset, scopeDoc, {
        onProgress: (current, total, step) => setAuditProgress({ current, total, step }),
        onFindings: (det, sem, batch) => {
          const newIssues = [
            ...det.map((f, i) => auditFindingToIssue(f, i + batch * 1000, 'det')),
            ...sem.map((f, i) => auditFindingToIssue(f, i + batch * 1000 + 500, 'sem')),
          ];
          setDiagnosisIssues((prev) => [...(prev || []), ...newIssues]);
          if (det.length + sem.length > 0) {
            message.success(`批次 ${batch} 完成：+${det.length + sem.length} 条发现`);
          }
        },
        onMerged: (det, sem) => {
          const mergedIssues = [
            ...det.map((f, i) => auditFindingToIssue(f, i, 'det')),
            ...sem.map((f, i) => auditFindingToIssue(f, i + 10000, 'sem')),
          ];
          setDiagnosisIssues((prev) => {
            const clientIssues = (prev || []).filter((i) => i.source === 'client');
            return [...clientIssues, ...mergedIssues];
          });
          // 保留 merged findings 引用，供 onDone 构建 auditResult 使用（SSE done 事件只有计数）
          setAuditResult({ deterministic: det, semantic: sem, stats: { nodes: 0, edges: 0, deterministic: det.length, coverage: 'full' }, llm: 'ok' });
        },
        onDone: (summary) => {
          if (summary) {
            // onMerged 已将完整 findings 写入 diagnosisIssues；这里用 stats 计数 + 保留 merged findings 引用
            setAuditResult((prev) => ({
              deterministic: prev?.deterministic || [],
              semantic: prev?.semantic || [],
              stats: {
                nodes: summary.nodes,
                edges: summary.edges,
                deterministic: summary.deterministic,
                coverage: summary.coverage as 'full' | 'partial' | 'batched',
                batches: summary.batches,
              },
              llm: streamHadError ? 'llm_unavailable' : 'ok',
            }));
            const batchInfo = summary.coverage === 'batched' ? `（分批 ${summary.batches} 批并行）` : '';
            message.success(`AI 语义分析完成：规则 ${summary.deterministic} 条 + 语义 ${summary.semantic} 条${batchInfo}`);
          }
        },
        onWarning: (msg) => message.warning(msg),
        onError: (msg) => { streamHadError = true; message.error('审核出错：' + msg); },
      });
    } catch {
      message.warning('AI 语义分析服务不可用，仅显示规则诊断结果');
    } finally {
      if (sessionId) releaseBuilderAgentSession(sessionId).catch(() => {});
      setAuditing(false);
      setAuditProgress(null);
    }
  }

  async function applyIssueFix(issue: DiagnosisIssue) {
    if (!issue.fixData || issue.fixData.length === 0) {
      message.info('此问题需人工处理，无法一键修复');
      return;
    }
    setApplying(true); setValidationError('');
    try {
      const next = applyCandidates(scopeDoc, issue.fixData);
      const validation = await validateGraph(asset, next);
      if (!validation.valid) {
        const first = [...validation.asset.errors, ...validation.template.errors][0];
        setValidationError(`修复未写入：${first?.message || '校验未通过'}`);
        return;
      }
      onMerged(next);
      setIssueApplied((prev) => new Set(prev).add(issue.id));
      message.success(`已修复：${issue.title}`);
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : '修复失败');
    } finally { setApplying(false); }
  }

  async function applyAllFixes() {
    if (!diagnosisIssues) return;
    const fixable = diagnosisIssues.filter(
      (i) => i.fixData && i.fixData.length > 0 && !issueApplied.has(i.id),
    );
    if (!fixable.length) { message.info('没有可自动修复的问题'); return; }
    setApplying(true); setValidationError('');
    try {
      const allFixData: CandidateItem[] = fixable.flatMap((i) => i.fixData!);
      const next = applyCandidates(scopeDoc, allFixData);
      const validation = await validateGraph(asset, next);
      if (!validation.valid) {
        const first = [...validation.asset.errors, ...validation.template.errors][0];
        setValidationError(`批量修复未写入：${first?.message || '校验未通过'}`);
        return;
      }
      onMerged(next);
      const fixedIds = new Set(issueApplied);
      fixable.forEach((i) => fixedIds.add(i.id));
      setIssueApplied(fixedIds);
      message.success(`已批量修复 ${fixable.length} 个问题`);
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : '批量修复失败');
    } finally { setApplying(false); }
  }

  function locateIssue(issue: DiagnosisIssue) {
    if (issue.nodeIds.length > 0 && onLocateNode) {
      onLocateNode(issue.nodeIds[0]);
    }
  }

  async function autoScanAndSuggest() {
    setGenerating(true);
    setCandidates(null);
    setExcluded({});
    setValidationError('');
    setLastApplied('');
    setSuggestError('');
    setBatchProgress(null);

    let sessionId: string | null = null;
    try {
      setGenStep('正在创建 AI 会话…');
      const session = await createBuilderAgentSession(asset, scopeDoc);
      sessionId = session.sessionId;

      const scopeHint = groupName ? `\n\n**当前作用域：意图分组「${groupName}」**（只包含该组下的意图及关联节点）` : '';
      const basePrompt = `请对当前图谱执行 AI 审核补全（complement_graph）。${scopeHint}

**补全重点（优先级从高到低）：**

1. **语义说法补全（最重要）**：针对每个意图节点，生成最匹配该意图的真实用户问法。
   - 每个意图至少 5-8 条典型说法，覆盖不同表达方式（口语化、正式、简略、完整）
   - 说法要基于业务场景，不要生硬翻译意图名称
   - 区分 scope_in（正面匹配）和 scope_out（易混淆但不应匹配的说法）
   - 对于容易混淆的意图，补充 disambiguation_hints
   - 这是语义召回的基础，直接决定意图识别效果

2. **意图节点完整性**：检查 intent_type、domain、deliver_type 等关键属性是否缺失

3. **关系补全**：检查意图与要素、知识答案、业务对象之间的边是否完整

4. **新增节点**：基于业务逻辑发现缺失的意图或要素节点

先做深度语义审核，然后基于审核发现生成针对性补全建议。补全结果请以完整图谱文档返回。`;

      let aiDoc: GraphDocument | null = null;
      let allAuditFindings: AuditFinding[] = [];

      if (scopeDoc.nodes.length <= FULL_BATCH_SIZE) {
        // ── 单次调用（图谱规模小） ──
        setGenStep('AI 正在审核并生成补全建议（约 30~60 秒）…');
        const result = await invokeBuilderAgent(sessionId, basePrompt, asset, scopeDoc);
        if (result.status === 'error') {
          setSuggestError('Agent 执行出错：' + result.reply);
          return;
        }
        aiDoc = parseAgentDocument(result);
        if (!aiDoc) {
          setSuggestError('AI 审核补全完成，但未返回图谱文档。Agent 回复：' + result.reply.slice(0, 200));
          return;
        }
        const auditData = result.audit as unknown;
        if (Array.isArray(auditData)) allAuditFindings = auditData as AuditFinding[];
        else if (auditData && typeof auditData === 'object') {
          const res = auditData as AuditResult;
          allAuditFindings = [...(res.deterministic || []), ...(res.semantic || [])];
        }
      } else {
        // ── 分批处理（节点数 > 阈值，避免 Agent 上下文溢出） ──
        const batches: GraphNode[][] = [];
        for (let i = 0; i < scopeDoc.nodes.length; i += FULL_BATCH_SIZE) {
          batches.push(scopeDoc.nodes.slice(i, i + FULL_BATCH_SIZE));
        }
        const aiDocs: GraphDocument[] = [];
        const errors: string[] = [];

        for (let i = 0; i < batches.length; i++) {
          const batchNodes = batches[i];
          const batchNodeIds = new Set(batchNodes.map((n) => n.id));
          const subDoc = createSubDocument(scopeDoc, batchNodeIds);
          const batchPrompt = `${basePrompt}

本批次包含 ${batchNodes.length} 个节点。`;

          setGenStep(`正在处理第 ${i + 1}/${batches.length} 批（${batchNodes.length} 个节点）…`);
          setBatchProgress({ current: i, total: batches.length, step: `第 ${i + 1} 批（${batchNodes.length} 个节点）` });

          try {
            const result = await invokeBuilderAgent(sessionId, batchPrompt, asset, subDoc);
            if (result.status === 'error') {
              errors.push(`第 ${i + 1} 批出错：${result.reply.slice(0, 100)}`);
            } else {
              const batchDoc = parseAgentDocument(result);
              if (batchDoc) aiDocs.push(batchDoc);
              else errors.push(`第 ${i + 1} 批未返回图谱文档`);
              const auditData = result.audit as unknown;
              if (Array.isArray(auditData)) allAuditFindings.push(...(auditData as AuditFinding[]));
              else if (auditData && typeof auditData === 'object') {
                const res = auditData as AuditResult;
                allAuditFindings.push(...(res.deterministic || []), ...(res.semantic || []));
              }
            }
          } catch (e) {
            errors.push(`第 ${i + 1} 批异常：${e instanceof Error ? e.message : String(e)}`);
          }
        }

        setBatchProgress({ current: batches.length, total: batches.length, step: '正在合并结果…' });

        if (aiDocs.length === 0) {
          setSuggestError('AI 审核补全全部批次失败：' + errors.join('；'));
          return;
        }
        aiDoc = mergeAIDocuments(aiDocs);
        if (errors.length > 0) {
          message.warning(`${errors.length} 批处理失败，已合并成功的 ${aiDocs.length} 批结果`);
        }
      }

      setGenStep('正在分析差异并生成候选项…');
      setBatchProgress(null);
      const newCandidates = analyzeCandidates(scopeDoc, aiDoc);
      const actionable = newCandidates.filter((c) => c.status === 'new' || c.status === 'merge');

      if (actionable.length === 0) {
        const fallbackCandidates = extractDiffCandidates(scopeDoc, aiDoc);
        if (fallbackCandidates.length > 0) {
          setCandidates(fallbackCandidates);
          message.success(groupName ? `「${groupName}」补全完成，生成 ${fallbackCandidates.length} 条建议（从差异提取）` : `AI 审核补全完成，生成 ${fallbackCandidates.length} 条建议（从差异提取）`);
        } else {
          setCandidates(newCandidates);
          message.info(groupName ? `「${groupName}」补全完成，未发现可补充内容（可能已完整）` : 'AI 审核补全完成，但未发现可补充的内容（可能图谱已完整）');
        }
      } else {
        setCandidates(newCandidates);
        message.success(groupName ? `「${groupName}」补全完成：${actionable.length} 条可操作建议` : `AI 审核补全完成：${actionable.length} 条可操作建议`);
      }

      if (allAuditFindings.length > 0) {
        const issues = allAuditFindings.map((f, i) => auditFindingToIssue(f, i, 'sem'));
        autoLocatedRef.current = false;
        setDiagnosisIssues(issues);
        setAuditResult({ deterministic: [], semantic: allAuditFindings, stats: { nodes: scopeDoc.nodes.length, edges: scopeDoc.edges.length, deterministic: 0, coverage: 'full' }, llm: 'ok' });
      }
    } catch (error) {
      setSuggestError('AI 审核补全失败：' + (error instanceof Error ? error.message : '未知错误'));
    } finally {
      if (sessionId) {
        releaseBuilderAgentSession(sessionId).catch(() => {});
      }
      setGenerating(false);
      setGenStep('');
      setBatchProgress(null);
    }
  }

  // ── 语义说法补全 + V4 精度字段生成：utterance_view / scope_in / scope_out / disambiguation_hints
  //    + aliases / recallTerms / recallTermSets / negativeExamples / semanticPriority ──
  // 意图节点数超过 UTTERANCE_BATCH_SIZE 时自动分批，避免 Agent 上下文溢出
  async function scanUtterancesOnly() {
    setGenerating(true);
    setCandidates(null);
    setExcluded({});
    setValidationError('');
    setLastApplied('');
    setSuggestError('');
    setBatchProgress(null);

    let sessionId: string | null = null;
    try {
      setGenStep('正在创建 AI 会话…');
      const session = await createBuilderAgentSession(asset, scopeDoc);
      sessionId = session.sessionId;

      const intentNodes = scopeDoc.nodes.filter((n) => n.type === 'INTENT' || n.type === 'AGGREGATE_INTENT');
      const allIntentNames = intentNodes.map((n) => `${n.id}: ${nodeName(n)}`).join('、');

      const scopeHint = groupName ? `\n\n**当前作用域：意图分组「${groupName}」**（只包含该组下的意图）` : '';
      const basePrompt = `请对当前图谱执行**语义说法补全与 V4 精度字段生成**。${scopeHint}

这是补全工作的最高优先级。针对每个意图节点，你需要：

1. **审查 utterance_view（典型说法）**：
   - 每个意图至少 5-8 条说法，覆盖口语化、正式、简略、完整等不同表达
   - 说法必须基于真实业务场景，不要机械翻译意图名称
   - 例：意图"查询订单" → "我的订单到哪了"、"帮我看看订单状态"、"订单物流"、"我买的东西发货了吗"

2. **补充 scope_in（正面匹配范围）**：
   - 与 utterance_view 保持一致，用于语义召回

3. **补充 scope_out（排除匹配）**：
   - 找出容易与本意图混淆但不应匹配的说法
   - 例：意图"查询订单" scope_out → "我想下单"、"帮我取消订单"

4. **补充 disambiguation_hints（消歧提示）**：
   - 对于名称相似、容易混淆的意图，给出消歧关键词

5. **生成 aliases（别名列表，≥3 条，V4GraphAdapter 精确匹配+110/包含+75）**：
   - 每个意图至少 3 个别名，长度 2~24 字，不含连续 3 位以上数字
   - 别名是该意图的不同表述方式，用于精确匹配召回
   - 例：意图"查询账户余额" → "查余额"、"余额查询"、"账户余额"

6. **生成 recallTerms（召回关键词，≥2 条，每条+65）**：
   - 与意图相关的关键词，用于语义召回增强
   - 例：意图"查询账户余额" → "账户"、"余额"、"实时余额"

7. **生成 negativeExamples（负例，≥2 条，每条-120 排除误召回）**：
   - 容易与本意图混淆但属于其他意图的查询
   - 例：意图"查询账户余额" → "查交易明细"、"查理财产品"

8. **保留已有说法和字段**，只做增量补充，不要删除或修改已有内容

请返回补全后的完整图谱文档。`;

      let aiDoc: GraphDocument | null = null;

      if (intentNodes.length <= UTTERANCE_BATCH_SIZE) {
        // ── 单次调用（图谱规模小） ──
        setGenStep('AI 正在为每个意图生成语义说法与 V4 精度字段（约 30~60 秒）…');
        const result = await invokeBuilderAgent(sessionId, basePrompt, asset, scopeDoc);
        if (result.status === 'error') {
          setSuggestError('Agent 执行出错：' + result.reply);
          return;
        }
        aiDoc = parseAgentDocument(result);
        if (!aiDoc) {
          setSuggestError('语义说法补全完成，但未返回图谱文档。Agent 回复：' + result.reply.slice(0, 200));
          return;
        }
      } else {
        // ── 分批处理（意图节点数 > 阈值，避免 Agent 上下文溢出） ──
        const batches: GraphNode[][] = [];
        for (let i = 0; i < intentNodes.length; i += UTTERANCE_BATCH_SIZE) {
          batches.push(intentNodes.slice(i, i + UTTERANCE_BATCH_SIZE));
        }
        const aiDocs: GraphDocument[] = [];
        const errors: string[] = [];

        for (let i = 0; i < batches.length; i++) {
          const batchNodes = batches[i];
          const batchNodeIds = new Set(batchNodes.map((n) => n.id));
          const subDoc = createSubDocument(scopeDoc, batchNodeIds);
          const batchPrompt = `${basePrompt}

本批次包含 ${batchNodes.length} 个意图节点。其他意图名称（用于消歧参考）：${allIntentNames}`;

          setGenStep(`正在处理第 ${i + 1}/${batches.length} 批（${batchNodes.length} 个意图）…`);
          setBatchProgress({ current: i, total: batches.length, step: `第 ${i + 1} 批（${batchNodes.length} 个意图）` });

          try {
            const result = await invokeBuilderAgent(sessionId, batchPrompt, asset, subDoc);
            if (result.status === 'error') {
              errors.push(`第 ${i + 1} 批出错：${result.reply.slice(0, 100)}`);
            } else {
              const batchDoc = parseAgentDocument(result);
              if (batchDoc) aiDocs.push(batchDoc);
              else errors.push(`第 ${i + 1} 批未返回图谱文档`);
            }
          } catch (e) {
            errors.push(`第 ${i + 1} 批异常：${e instanceof Error ? e.message : String(e)}`);
          }
        }

        setBatchProgress({ current: batches.length, total: batches.length, step: '正在合并结果…' });

        if (aiDocs.length === 0) {
          setSuggestError('语义说法补全全部批次失败：' + errors.join('；'));
          return;
        }
        aiDoc = mergeAIDocuments(aiDocs);
        if (errors.length > 0) {
          message.warning(`${errors.length} 批处理失败，已合并成功的 ${aiDocs.length} 批结果`);
        }
      }

      setGenStep('正在分析说法变更…');
      setBatchProgress(null);
      // 只保留意图节点的 merge 候选（聚焦说法变更）
      const allCandidates = analyzeCandidates(scopeDoc, aiDoc);
      const utteranceCandidates = allCandidates.filter((c) => {
        if (c.kind !== 'node') return false;
        const node = c.item as GraphNode;
        return node.type === 'INTENT' && (c.status === 'merge' || c.status === 'new');
      });

      if (utteranceCandidates.length === 0) {
        // fallback: 从差异提取
        const fallback = extractDiffCandidates(scopeDoc, aiDoc).filter((c) => {
          if (c.kind !== 'node') return false;
          const node = c.item as GraphNode;
          return node.type === 'INTENT';
        });
        if (fallback.length > 0) {
          setCandidates(fallback);
          message.success(`语义说法补全完成，发现 ${fallback.length} 个意图的说法变更`);
        } else {
          setCandidates([]);
          message.info('语义说法补全完成，但未发现说法变更（可能说法已充分）');
        }
      } else {
        setCandidates(utteranceCandidates);
        message.success(`语义说法补全完成，${utteranceCandidates.length} 个意图的说法已更新`);
      }
    } catch (error) {
      setSuggestError('语义说法补全失败：' + (error instanceof Error ? error.message : '未知错误'));
    } finally {
      if (sessionId) {
        releaseBuilderAgentSession(sessionId).catch(() => {});
      }
      setGenerating(false);
      setGenStep('');
      setBatchProgress(null);
    }
  }

  async function apply() {
    if (!included.length) { message.info('还没有选中可写入的建议'); return; }
    setApplying(true); setValidationError('');
    try {
      const next = applyCandidates(scopeDoc, included);
      const addedNodes = next.nodes.length - scopeDoc.nodes.length;
      const addedEdges = next.edges.length - scopeDoc.edges.length;
      if (!addedNodes && !addedEdges && !included.some((item) => item.status === 'merge')) {
        message.info('选中的建议没有产生图谱修改'); return;
      }
      const validation = await validateGraph(asset, next);
      if (!validation.valid) {
        const first = [...validation.asset.errors, ...validation.template.errors][0];
        setValidationError(`尚未写入草稿：${first?.message || '图谱校验未通过'}。请核对建议的类型、必填内容和连接关系。`);
        return;
      }
      onMerged(next);
      setLastApplied(`已写入当前画布：新增 ${addedNodes} 个节点、${addedEdges} 条关系。画布"保存"持久化。`);
      setCandidates(null); setExcluded({});
      if (diagnosisIssues) {
        const fixedIds = new Set(issueApplied);
        const nodeIds = new Set(included.filter((c) => c.kind === 'node').map((c) => (c.item as GraphNode).id));
        diagnosisIssues.forEach((issue) => {
          if (issue.fixData && issue.fixData.some((f) => f.kind === 'node' && nodeIds.has((f.item as GraphNode).id))) {
            fixedIds.add(issue.id);
          }
        });
        setIssueApplied(fixedIds);
      }
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : '校验失败，建议未写入草稿');
    } finally { setApplying(false); }
  }

  // autoStart: 打开后自动切到补全 tab 并执行审核补全
  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (open && autoStart && !autoStartedRef.current) {
      autoStartedRef.current = true;
      setTab('suggest');
      autoScanAndSuggest();
    }
    if (!open) {
      autoStartedRef.current = false;
    }
  }, [open, autoStart]);

  // ── 渲染：Drawer 弹出（参考 IntentTrialDrawer 模式） ──
  // 底部固定操作栏显隐：审核 tab 有可修复项 / 补全 tab 有候选建议
  const footerVisible =
    (tab === 'diagnose' && !!diagnosisStats && diagnosisStats.autoFixable > 0) ||
    (tab === 'suggest' && !!candidates && candidates.length > 0);

  return (
    <Drawer
      title={<span><BulbOutlined style={{ marginRight: 6, color: '#1677ff' }} /> {groupName ? `AI 辅助 · ${groupName}` : 'AI 辅助 · 全图'}</span>}
      width={560}
      open={open}
      onClose={onClose}
      extra={
        <Segmented
          size="small"
          value={tab}
          onChange={(v) => setTab(v as typeof tab)}
          options={[
            { label: '审核本组', value: 'diagnose' },
            { label: '补全本组', value: 'suggest' },
            { label: 'AI 对话', value: 'agent' },
          ]}
        />
      }
      styles={{ body: { padding: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' } }}
    >
      {/* Tab 内容：常驻挂载（切换不丢状态），display 切换 + 各自独立滚动 */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>

        {/* ════════════ 1. 审核本组 ════════════ */}
        <div style={{ position: 'absolute', inset: 0, overflowY: 'auto', padding: 12, display: tab === 'diagnose' ? 'block' : 'none' }}>
        <div style={{ border: '1px solid #e0e7ff', background: '#f5f7ff', borderRadius: 10, padding: '10px 12px', marginBottom: 12 }}>
          <Text strong style={{ fontSize: 13 }}><AuditOutlined /> {groupName ? `审核「${groupName}」` : '全图审核'}</Text>
          <Text type="secondary" style={{ display: 'block', fontSize: 11, lineHeight: 1.5, marginTop: 4 }}>
            ① 规则诊断（即时）· ② AI 深度语义审查（30~60 秒）
          </Text>
        </div>

        <Button type="primary" block icon={<AuditOutlined />} loading={auditing} onClick={runDiagnosis} style={{ marginBottom: 10 }}>
          一键诊断（规则 + AI 语义）
        </Button>

        {/* SSE 流式进度指示器 */}
        {auditing && auditProgress && (
          <div style={{ marginBottom: 10, padding: '8px 10px', borderRadius: 8, background: '#f0f5ff', border: '1px solid #adc6ff' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <Spin size="small" />
              <Text strong style={{ fontSize: 12 }}>
                {auditProgress.total > 0 ? `${auditProgress.current}/${auditProgress.total} 批` : '连接中…'}
              </Text>
              {auditProgress.total > 0 && auditProgress.current > 0 && (
                <Tag color="blue" style={{ margin: 0 }}>{Math.round((auditProgress.current / auditProgress.total) * 100)}%</Tag>
              )}
            </div>
            <Text type="secondary" style={{ fontSize: 11 }}>{auditProgress.step}</Text>
            {auditProgress.total > 0 && (
              <div style={{ marginTop: 4, height: 3, background: '#e7eaf0', borderRadius: 2, overflow: 'hidden' }}>
                <div style={{ width: `${(auditProgress.current / auditProgress.total) * 100}%`, height: '100%', background: '#1677ff', transition: 'width 0.3s ease' }} />
              </div>
            )}
          </div>
        )}

        {/* AI 审计结果摘要 */}
        {auditResult && !auditing && <div style={{ marginBottom: 10, padding: '6px 8px', borderRadius: 8, background: auditResult.llm === 'ok' ? '#f6ffed' : '#fffbe6', border: `1px solid ${auditResult.llm === 'ok' ? '#b7eb8f' : '#ffe58f'}` }}>
          <Space size={4} wrap>
            <Tag color={auditResult.llm === 'ok' ? 'green' : 'orange'} style={{ margin: 0 }}>
              {auditResult.llm === 'ok' ? 'AI 语义分析完成' : auditResult.llm === 'parse_error' ? 'AI 语义解析失败' : 'LLM 不可用'}
            </Tag>
            <Text style={{ fontSize: 11 }}>规则 {auditResult.deterministic.length} 条</Text>
            <Text style={{ fontSize: 11 }}>语义 {auditResult.semantic.length} 条</Text>
            {auditResult.stats.coverage === 'batched' && auditResult.stats.batches && <Tag color="blue" style={{ margin: 0 }}>分批 {auditResult.stats.batches} 批</Tag>}
          </Space>
        </div>}

        {validationError && <Alert type="error" showIcon message={validationError} style={{ marginBottom: 10 }} />}

        {diagnosing && <div style={{ textAlign: 'center', padding: 30 }}><Spin tip="正在扫描图谱结构…"><div style={{ padding: 8 }} /></Spin></div>}

        {diagnosisIssues && !diagnosing && (<>
          {/* 统计面板 */}
          {diagnosisStats!.total === 0 && !auditing ? <Alert type="success" showIcon
            message="图谱状态良好"
            description="规则诊断和 AI 语义审查均未发现问题。"
            style={{ marginBottom: 10 }} />
          : <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
            {(['format', 'normative', 'semantic'] as const).map((cat) => {
              const count = diagnosisStats![cat];
              if (count === 0) return null;
              const meta = CATEGORY_LABELS[cat];
              return <div key={cat} onClick={() => setExpandedCategory(expandedCategory === cat ? null : cat)}
                style={{ flex: 1, border: `1px solid ${expandedCategory === cat ? meta.color === 'red' ? '#ffa39e' : meta.color === 'orange' ? '#ffd591' : '#91d5ff' : '#e7eaf0'}`,
                  borderRadius: 8, padding: '6px 8px', cursor: 'pointer', background: expandedCategory === cat ? '#fff' : '#fafbfc' }}>
                <Text strong style={{ fontSize: 12 }}>{meta.icon} {meta.label}</Text>
                <div style={{ marginTop: 2 }}><Tag color={meta.color} style={{ margin: 0 }}>{count}</Tag></div>
              </div>;
            })}
          </div>}

          {/* 问题列表 */}
          {diagnosisIssues
            .filter((i) => !expandedCategory || i.category === expandedCategory)
            .sort((a, b) => {
              const aApplied = issueApplied.has(a.id) ? 1 : 0;
              const bApplied = issueApplied.has(b.id) ? 1 : 0;
              if (aApplied !== bApplied) return aApplied - bApplied;
              return SEV_PRIORITY[b.severity] - SEV_PRIORITY[a.severity];
            })
            .map((issue) => {
            const sev = SEVERITY_LABELS[issue.severity];
            const applied = issueApplied.has(issue.id);
            const nodeNamesById = issue.nodeIds.map((id) => {
              const n = scopeDoc.nodes.find((x) => x.id === id);
              return n ? nodeName(n) : id;
            });
            return <div key={issue.id} style={{
              border: `1px solid ${applied ? '#b7eb8f' : issue.source === 'sem' ? '#d3adf7' : issue.severity === 'high' ? '#ffccc7' : '#ffe7ba'}`,
              background: applied ? '#f6ffed' : issue.source === 'sem' ? '#faf5ff' : '#fff',
              borderRadius: 8, padding: '8px 10px', marginBottom: 8,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 6 }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <Space size={3} wrap>
                    <Tag color={sev.color} style={{ margin: 0 }}>{sev.label}</Tag>
                    {issue.source !== 'client' && <Tag color={SOURCE_LABELS[issue.source].color} style={{ margin: 0 }}>{SOURCE_LABELS[issue.source].label}</Tag>}
                    <Text strong style={{ fontSize: 12 }}>{issue.title}</Text>
                  </Space>
                  <Text type="secondary" style={{ display: 'block', fontSize: 11, marginTop: 4, lineHeight: 1.4 }}>
                    {issue.description}
                  </Text>
                  {nodeNamesById.length > 0 && <div style={{ marginTop: 3 }}>
                    <Space size={3} wrap>
                      {nodeNamesById.slice(0, 4).map((name, i) => <Tag key={i} style={{ margin: 0, fontSize: 10 }}>{name}</Tag>)}
                      {nodeNamesById.length > 4 && <Text type="secondary" style={{ fontSize: 10 }}>等 {nodeNamesById.length} 个</Text>}
                    </Space>
                  </div>}
                  <div style={{ marginTop: 4, padding: '4px 6px', background: '#f0f5ff', borderRadius: 4, fontSize: 11 }}>
                    <Text type="secondary" style={{ fontSize: 10 }}>建议：</Text>
                    <Text style={{ fontSize: 11 }}>{issue.suggestion}</Text>
                  </div>
                </div>
                {applied ? <Tag color="green" style={{ margin: 0, flexShrink: 0 }}>已修复</Tag>
                  : <Space size={4} direction="vertical" style={{ flexShrink: 0, alignItems: 'flex-end' }}>
                  {issue.fixData && issue.fixData.length > 0
                    && <Button size="small" type="primary" loading={applying} onClick={() => applyIssueFix(issue)}>应用修复方案</Button>}
                  {issue.fixData && issue.fixData.length > 0
                    && <Text type="secondary" style={{ fontSize: 10 }}>将{describeFix(issue.fixData)}</Text>}
                  {issue.nodeIds.length > 0 && onLocateNode
                    && <Button size="small" type={issue.fixData ? 'link' : 'default'} style={{ padding: issue.fixData ? 0 : undefined, fontSize: 11 }} onClick={() => locateIssue(issue)}>定位到画布</Button>}
                  {(!issue.fixData || issue.fixData.length === 0) && (!issue.nodeIds || issue.nodeIds.length === 0)
                    && <Text type="secondary" style={{ fontSize: 10, fontStyle: 'italic' }}>需在画布上手动修改</Text>}
                </Space>}
              </div>
            </div>;
          })}

        </>)}

        {!diagnosisIssues && !diagnosing && <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="点击上方按钮运行诊断"
          style={{ padding: '24px 0' }}
        />}
        </div>

        {/* ════════════ 2. 补全本组 ════════════ */}
        <div style={{ position: 'absolute', inset: 0, overflowY: 'auto', padding: 12, display: tab === 'suggest' ? 'block' : 'none' }}>
        <div style={{ border: '1px solid #dbeafe', background: '#f6faff', borderRadius: 10, padding: '10px 12px', marginBottom: 10 }}>
          <Text strong style={{ fontSize: 13 }}><ThunderboltOutlined /> {groupName ? `补全「${groupName}」` : '全图补全'}</Text>
          <Text type="secondary" style={{ display: 'block', fontSize: 11, lineHeight: 1.5, marginTop: 4 }}>
            语义说法补全是重点：为每个意图生成最匹配的用户问法，直接决定意图识别召回率
          </Text>
        </div>

        <Space direction="vertical" style={{ width: '100%', marginBottom: 10 }}>
          <Button type="primary" block icon={<MessageOutlined />} loading={generating} onClick={scanUtterancesOnly}>
            语义说法 + V4 精度字段补全
          </Button>
          <Button block icon={<ThunderboltOutlined />} loading={generating} onClick={autoScanAndSuggest}>
            全面补全（说法 + 节点 + 关系）
          </Button>
        </Space>

        {/* 进度反馈 */}
        {generating && genStep && (
          <div style={{ marginBottom: 10, padding: '8px 10px', borderRadius: 8, background: '#f0f5ff', border: '1px solid #adc6ff' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: batchProgress ? 4 : 0 }}>
              <Spin size="small" />
              <Text strong style={{ fontSize: 12 }}>{genStep}</Text>
              {batchProgress && batchProgress.total > 0 && (
                <Tag color="blue" style={{ margin: 0 }}>
                  {batchProgress.current}/{batchProgress.total} 批 · {Math.round((batchProgress.current / batchProgress.total) * 100)}%
                </Tag>
              )}
            </div>
            {batchProgress && (
              <>
                <Text type="secondary" style={{ fontSize: 11 }}>{batchProgress.step}</Text>
                {batchProgress.total > 0 && (
                  <div style={{ marginTop: 4, height: 3, background: '#e7eaf0', borderRadius: 2, overflow: 'hidden' }}>
                    <div style={{ width: `${(batchProgress.current / batchProgress.total) * 100}%`, height: '100%', background: '#1677ff', transition: 'width 0.3s ease' }} />
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* 持久化错误提示 */}
        {suggestError && !generating && <Alert type="error" showIcon message={suggestError} style={{ marginBottom: 10 }} closable onClose={() => setSuggestError('')} />}

        {lastApplied && <Alert type="success" showIcon message={lastApplied} style={{ marginBottom: 10 }} />}

        {candidates && !generating && <div style={{ marginTop: 8 }}>
          {candidates.length > 0 && <><div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
            <Text strong style={{ fontSize: 13 }}>{groupName ? `审阅「${groupName}」的建议` : '审阅模式 · AI 建议修改'}</Text>
            <Text type="secondary" style={{ fontSize: 11 }}>待审核 {actionableCount} · 已采纳 {included.length} · 已拒绝 {actionableCount - included.length}</Text>
          </div>
          <div style={{ marginBottom: 8, padding: '5px 10px', background: '#f0f5ff', borderRadius: 6, border: '1px solid #adc6ff' }}>
            <Text type="secondary" style={{ fontSize: 11 }}>
              绿色标记 = AI 新增内容。逐项审核后，点击底部「确认写入草稿」生效
            </Text>
          </div></>}
          {!candidates.length && <div style={{ border: '1px dashed #d5e0ed', borderRadius: 8, padding: 12 }}>
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="未发现可补充内容" style={{ margin: 0 }} />
          </div>}
          {candidates.map((candidate, index) => {
            const item = candidate.item;
            const node = candidate.kind === 'node' ? item as GraphNode : null;
            const edge = candidate.kind === 'edge' ? item as GraphEdge : null;
            const blockedByNode = !!edge && (!selectedNodeIds.has(edge.source) || !selectedNodeIds.has(edge.target));
            const selectable = ['new', 'merge'].includes(candidate.status) && !blockedByNode;
            const selected = selectable && !excluded[index];
            const heading = node ? nodeName(node) : `${names.get(edge!.source) || edge!.source} → ${names.get(edge!.target) || edge!.target}`;
            const typeLabel = node ? NODE_NAMES[node.type] || node.type : EDGE_NAMES[edge!.type] || '关联关系';
            // merge 候选：找出 AI 补充/变更的字段
            const mergedFields = node && candidate.status === 'merge' && candidate.existingId
              ? (() => {
                  const existing = scopeDoc.nodes.find((n) => n.id === candidate.existingId);
                  if (!existing) return [] as string[];
                  return Object.keys(node.properties || {})
                    .filter((k) => {
                      const aiVal = node.properties[k];
                      const oldVal = existing.properties[k];
                      if (Array.isArray(aiVal) && Array.isArray(oldVal)) return aiVal.length > oldVal.length;
                      if (Array.isArray(aiVal) && (!oldVal)) return aiVal.length > 0;
                      return (aiVal !== undefined && aiVal !== null && aiVal !== '')
                        && (oldVal === undefined || oldVal === null || oldVal === '');
                    })
                    .map((k) => NODE_FIELD_LABELS[k] || k);
                })()
              : [];
            // merge 候选：计算 utterance_view / scope_in / scope_out 的已有 vs 新增
            const utteranceDiff = node && candidate.status === 'merge' && candidate.existingId
              ? (() => {
                  const existing = scopeDoc.nodes.find((n) => n.id === candidate.existingId);
                  if (!existing) return null;
                  const fields = ['utterance_view', 'scope_in', 'scope_out'] as const;
                  return fields.map((field) => {
                    const oldArr = list(existing.properties[field]).map(String);
                    const newArr = list(node.properties[field]).map(String);
                    const added = newArr.filter((v) => !oldArr.includes(v));
                    if (added.length === 0) return null;
                    return { field, oldCount: oldArr.length, added, newCount: newArr.length };
                  }).filter(Boolean) as { field: string; oldCount: number; added: string[]; newCount: number }[];
                })()
              : null;
            // Word-style color coding: green for new, blue for merge
            const accentColor = candidate.status === 'new' ? '#52c41a' : candidate.status === 'merge' ? '#1890ff' : '#e7eaf0';
            const hasLeftAccent = candidate.status === 'new' || candidate.status === 'merge';
            return <div key={`${item.id}-${index}`} style={{
              border: `1px solid ${selected ? accentColor : '#e7eaf0'}`,
              borderLeft: hasLeftAccent ? `4px solid ${accentColor}` : undefined,
              background: selected ? (candidate.status === 'new' ? '#f6ffed' : '#f0f8ff') : '#fff',
              borderRadius: 8, padding: '8px 10px', marginBottom: 7,
              opacity: selectable && !selected ? 0.55 : 1,
              transition: 'opacity 0.2s, border-color 0.2s',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <Space size={4} wrap>
                    <Text strong style={{ fontSize: 12 }}>{heading}</Text>
                    <Tag style={{ margin: 0, fontSize: 10 }}>{typeLabel}</Tag>
                    <Tag color={STATUS[candidate.status].color} style={{ margin: 0 }}>
                      {candidate.status === 'new' ? '新增' : candidate.status === 'merge' ? '补充' : STATUS[candidate.status].label}
                    </Tag>
                    {selectable && <Tag color={selected ? 'green' : 'default'} style={{ margin: 0, fontSize: 10 }}>
                      {selected ? '已采纳' : '已拒绝'}
                    </Tag>}
                  </Space>
                  {node?.type === 'INTENT' && <Text type="secondary" style={{ display: 'block', fontSize: 10, marginTop: 3 }}>
                    {node.properties.intent_type ? `意图类别：${String(node.properties.intent_type)}　` : ''}
                    {node.properties.domain ? `业务领域：${String(node.properties.domain)}` : ''}
                  </Text>}
                  {utteranceDiff && utteranceDiff.length > 0
                    ? utteranceDiff.map((diff) => <div key={diff.field} style={{
                        marginTop: 4, padding: '6px 8px', background: '#fafafa', borderRadius: 6, border: '1px solid #f0f0f0',
                      }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                        <Text strong style={{ fontSize: 11 }}>{NODE_FIELD_LABELS[diff.field] || diff.field}</Text>
                        <Text type="secondary" style={{ fontSize: 10 }}>{diff.oldCount} 条 → {diff.newCount} 条（+{diff.added.length}）</Text>
                      </div>
                      <div style={{ marginTop: 3 }}>
                        {diff.added.map((v, i) => <span key={i} style={{
                          display: 'inline-block', background: diff.field === 'scope_out' ? '#fff7e6' : '#f6ffed',
                          border: `1px solid ${diff.field === 'scope_out' ? '#ffd591' : '#b7eb8f'}`, borderRadius: 3,
                          padding: '1px 6px', margin: '2px 4px 2px 0', fontSize: 10,
                          color: diff.field === 'scope_out' ? '#d46b08' : '#389e0d', fontWeight: 500,
                        }}>+ {v}</span>)}
                      </div>
                    </div>)
                    : !!node && list(node.properties.utterance_view).length > 0 && candidate.status === 'new' && <div style={{
                        marginTop: 3, padding: '4px 6px', background: '#f6ffed', borderRadius: 4, border: '1px solid #b7eb8f',
                      }}>
                      <Text style={{ fontSize: 10, color: '#389e0d', fontWeight: 600 }}>新增说法：</Text>
                      {list(node.properties.utterance_view).map((v, i) => <span key={i} style={{
                        display: 'inline-block', background: '#d9f7be', borderRadius: 3, padding: '1px 6px',
                        margin: '2px 4px 2px 0', fontSize: 10,
                      }}>+ {v}</span>)}
                    </div>}
                  {mergedFields.length > 0 && <div style={{ marginTop: 3, padding: '4px 6px', background: '#f6ffed', borderRadius: 4, border: '1px solid #b7eb8f' }}>
                    <Text style={{ fontSize: 10, color: '#389e0d', fontWeight: 600 }}>AI 补充字段：</Text>
                    {mergedFields.map((f, i) => <span key={i} style={{
                      display: 'inline-block', background: '#d9f7be', borderRadius: 3, padding: '1px 6px',
                      margin: '2px 4px 2px 0', fontSize: 10, color: '#389e0d',
                    }}>+ {f}</span>)}
                  </div>}
                  {(candidate.message || blockedByNode) && <Text type="secondary" style={{ display: 'block', fontSize: 10, marginTop: 3 }}>
                    {blockedByNode ? '所连接的节点未采纳，此关系不会写入' : candidate.message}
                  </Text>}
                </div>
                {selectable && <Button size="small" type={selected ? 'default' : 'primary'}
                  onClick={() => setExcluded((state) => ({ ...state, [index]: !state[index] }))}>
                  {selected ? '拒绝' : '采纳'}
                </Button>}
              </div>
            </div>;
          })}
        </div>}

        {!candidates && !generating && !suggestError && <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="点击上方按钮，AI 将审核图谱并生成补全建议"
          style={{ padding: '24px 0' }}
        />}
        </div>

        {/* ════════════ 3. Agent 对话 ════════════ */}
        <div style={{ position: 'absolute', inset: 0, display: tab === 'agent' ? 'flex' : 'none', flexDirection: 'column' }}>
          <BuilderAgentChat asset={asset} document={currentDocument} active={tab === 'agent'} open={open} onGenerated={onMerged} fillSourceText={fillSourceText} />
        </div>
      </div>

      {/* 底部固定操作栏：批量修复 / 写入草稿（不再埋在长列表末尾） */}
      {footerVisible && (
        <div style={{ flexShrink: 0, borderTop: '1px solid #e5e6eb', padding: '8px 12px', background: '#fafbfc' }}>
          {tab === 'diagnose' ? (
            <div>
              <Button size="small" type="primary" ghost block loading={applying} onClick={applyAllFixes}>
                一键应用全部修复方案（{diagnosisStats!.autoFixable} 个可修复）
              </Button>
              {diagnosisStats!.total - diagnosisStats!.autoFixable > 0 && (
                <Text type="secondary" style={{ display: 'block', fontSize: 10, marginTop: 4, textAlign: 'center' }}>
                  其余 {diagnosisStats!.total - diagnosisStats!.autoFixable} 条需在画布上手动修改
                </Text>
              )}
            </div>
          ) : (
            <div>
              <Button type="primary" block icon={<CheckOutlined />} loading={applying} disabled={!included.length} onClick={apply}>
                确认写入草稿（已采纳 {included.length} 项）
              </Button>
              <Text type="secondary" style={{ display: 'block', fontSize: 10, marginTop: 4, textAlign: 'center' }}>
                 采纳的建议经整图校验后写入草稿，校验失败则不生效
              </Text>
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
}
