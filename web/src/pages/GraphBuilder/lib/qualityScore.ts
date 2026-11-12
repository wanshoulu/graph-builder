/**
 * 图谱质量评分系统（纯函数，无副作用）
 *
 * 基于诊断结果 + 图结构指标，计算 0-100 综合质量分。
 * 四个维度：
 *   1. 格式完整性 (30%) — 必填字段、占位名、空值
 *   2. 结构规范性 (25%) — 孤立节点、重复命名、枢纽超载、自环
 *   3. 语义充分性 (25%) — 意图覆盖、交付配置、槽位连接
 *   4. 图连通性   (20%) — 联通子图比、边节点比、平均度
 */
import type { GraphDocument, GraphTemplate } from '@/api/orgGraph';
import { diagnoseGraph, type DiagnosisResult, type Severity } from './graphDiagnosis';
import { findConnectedComponents } from './graphAlgorithms';
import type { CanvasNode, CanvasEdge } from './graphDoc';

export interface QualityDimension {
  name: string;
  score: number;        // 0-100
  weight: number;       // 权重百分比
  issues: number;       // 问题数
  highSeverity: number; // 高严重度问题数
  detail: string;       // 评分说明
}

export interface QualityScore {
  overall: number;       // 0-100 综合分
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  dimensions: QualityDimension[];
  recommendations: string[];
  diagnosis: DiagnosisResult;
}

/** 严重度权重：high 扣分最多 */
const SEVERITY_PENALTY: Record<Severity, number> = {
  high: 15,
  medium: 8,
  low: 3,
};

/** 最低分 0，最高分 100 */
function clamp(v: number): number {
  return Math.max(0, Math.min(100, Math.round(v)));
}

/** 计算维度分数：基准 100，按问题数和严重度扣分 */
function dimensionScore(issues: DiagnosisResult['issues'], category: string): { score: number; issues: number; highSeverity: number } {
  const catIssues = issues.filter((i) => i.category === category);
  const highCount = catIssues.filter((i) => i.severity === 'high').length;
  let penalty = 0;
  for (const issue of catIssues) {
    penalty += SEVERITY_PENALTY[issue.severity];
  }
  // 高严重度问题额外惩罚
  if (highCount > 5) penalty += (highCount - 5) * 5;
  return { score: clamp(100 - penalty), issues: catIssues.length, highSeverity: highCount };
}

/** 计算图连通性分数 */
function connectivityScore(document: GraphDocument): { score: number; detail: string } {
  if (document.nodes.length === 0) {
    return { score: 0, detail: '空图谱' };
  }

  const canvasNodes: CanvasNode[] = document.nodes.map(n => ({ id: n.id, data: n.properties || {}, position: { x: n.x || 0, y: n.y || 0 } }));
  const canvasEdges: CanvasEdge[] = document.edges.map(e => ({ id: e.id, source: e.source, target: e.target, label: e.type, data: e.properties || {} }));

  // 联通子图
  const componentsResult = findConnectedComponents(canvasNodes, canvasEdges);
  const largestRatio = componentsResult.components.length > 0
    ? componentsResult.largestSize / document.nodes.length
    : 0;

  // 边节点比（理想 1.0-2.0）
  const edgeNodeRatio = document.nodes.length > 0 ? document.edges.length / document.nodes.length : 0;

  // 孤立节点比例
  const connectedNodeIds = new Set<string>();
  document.edges.forEach(e => {
    connectedNodeIds.add(e.source);
    connectedNodeIds.add(e.target);
  });
  const orphanRatio = (document.nodes.length - connectedNodeIds.size) / document.nodes.length;

  // 评分计算
  let score = 100;
  let detail = '';

  // 联通性：最大联通子图占比越高越好
  if (largestRatio < 0.3) { score -= 30; detail = '图极度分散'; }
  else if (largestRatio < 0.5) { score -= 20; detail = '联通性较差'; }
  else if (largestRatio < 0.7) { score -= 10; detail = '联通性一般'; }
  else if (largestRatio < 0.9) { score -= 5; detail = '联通性良好'; }
  else { detail = '联通性优秀'; }

  // 边节点比
  if (edgeNodeRatio < 0.3) { score -= 15; detail += '，关系过少'; }
  else if (edgeNodeRatio < 0.5) { score -= 8; }
  else if (edgeNodeRatio > 3.0) { score -= 5; detail += '，关系过密'; }

  // 孤立节点
  if (orphanRatio > 0.3) { score -= 15; detail += `，孤立节点 ${(orphanRatio * 100).toFixed(0)}%`; }
  else if (orphanRatio > 0.1) { score -= 8; }
  else if (orphanRatio > 0) { score -= 3; }

  return { score: clamp(score), detail };
}

/** 分数转等级 */
function scoreToGrade(score: number): QualityScore['grade'] {
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 60) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

/** 生成改进建议 */
function generateRecommendations(dimensions: QualityDimension[], diagnosis: DiagnosisResult): string[] {
  const recs: string[] = [];

  // 按维度分数排序，优先处理低分维度
  const sorted = [...dimensions].sort((a, b) => a.score - b.score);
  for (const dim of sorted) {
    if (dim.score < 70 && dim.highSeverity > 0) {
      recs.push(`【${dim.name}】有 ${dim.highSeverity} 个高优先级问题需立即处理（当前 ${dim.score} 分）`);
    }
  }

  // 可自动修复的问题
  const autoFixable = diagnosis.issues.filter(i => i.fixData && i.fixData.length > 0);
  if (autoFixable.length > 0) {
    recs.push(`可自动修复 ${autoFixable.length} 个问题（通过 AI 辅助 → 审核修复）`);
  }

  // 高严重度问题 top 3
  const topHigh = diagnosis.issues
    .filter(i => i.severity === 'high')
    .slice(0, 3)
    .map(i => i.title);
  for (const t of topHigh) {
    recs.push(`高优：${t}`);
  }

  return recs.slice(0, 6);
}

/**
 * 计算图谱质量评分
 * @param document 图谱文档
 * @param template 图谱模板
 */
export function computeQualityScore(
  document: GraphDocument,
  template: GraphTemplate,
): QualityScore {
  const diagnosis = diagnoseGraph(document, template);

  // 维度1：格式完整性
  const fmt = dimensionScore(diagnosis.issues, 'format');
  const formatDim: QualityDimension = {
    name: '格式完整性',
    score: fmt.score,
    weight: 30,
    issues: fmt.issues,
    highSeverity: fmt.highSeverity,
    detail: fmt.issues === 0 ? '所有必填字段完整' : `${fmt.issues} 个格式问题（${fmt.highSeverity} 高优）`,
  };

  // 维度2：结构规范性
  const norm = dimensionScore(diagnosis.issues, 'normative');
  const normDim: QualityDimension = {
    name: '结构规范性',
    score: norm.score,
    weight: 25,
    issues: norm.issues,
    highSeverity: norm.highSeverity,
    detail: norm.issues === 0 ? '图结构规范良好' : `${norm.issues} 个规范问题（${norm.highSeverity} 高优）`,
  };

  // 维度3：语义充分性
  const sem = dimensionScore(diagnosis.issues, 'semantic');
  const semDim: QualityDimension = {
    name: '语义充分性',
    score: sem.score,
    weight: 25,
    issues: sem.issues,
    highSeverity: sem.highSeverity,
    detail: sem.issues === 0 ? '语义表达充分' : `${sem.issues} 个语义问题（${sem.highSeverity} 高优）`,
  };

  // 维度4：图连通性
  const conn = connectivityScore(document);
  const connIssues = diagnosis.issues.filter(i => i.category === 'normative' && i.fixType === 'manual').length;
  const connDim: QualityDimension = {
    name: '图连通性',
    score: conn.score,
    weight: 20,
    issues: connIssues,
    highSeverity: 0,
    detail: conn.detail,
  };

  const dimensions = [formatDim, normDim, semDim, connDim];

  // 加权综合分
  const overall = clamp(
    formatDim.score * (formatDim.weight / 100) +
    normDim.score * (normDim.weight / 100) +
    semDim.score * (semDim.weight / 100) +
    connDim.score * (connDim.weight / 100),
  );

  const recommendations = generateRecommendations(dimensions, diagnosis);

  return {
    overall,
    grade: scoreToGrade(overall),
    dimensions,
    recommendations,
    diagnosis,
  };
}
