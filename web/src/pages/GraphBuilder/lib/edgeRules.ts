/**
 * 连线规则（纯函数，可单测）—— 全部从模板 edge_types 端点约束推导，不硬编码类型组合
 * （对齐 AI Harbor intent-graph-editor 的三态连线体验，但规则来源是模板声明而非 12 条硬编码映射）：
 *   0 候选 → 取消连线并提示；1 候选 → 智能直连；多候选 → 弹模态选型。
 */
import type { GraphTemplate } from '@/api/orgGraph';
import type { CanvasEdge } from './graphDoc';

/** 端点类型匹配：约束为空数组 = 不限端点（保守放行）；否则必须包含 */
function endpointMatches(list: string[] | undefined, type: string): boolean {
  if (!list || list.length === 0) return true;
  return list.indexOf(type) >= 0;
}

/** 两端节点类型 → 合法边类型候选（按模板声明顺序返回） */
export function suggestEdgeTypes(template: GraphTemplate, srcType: string, tgtType: string): string[] {
  return template.edge_types
    .filter((e) => endpointMatches(e.source_types, srcType) && endpointMatches(e.target_types, tgtType))
    .map((e) => e.type);
}

/** 指定边类型是否满足端点约束（validateEdgeType 的通用化版本） */
export function canConnect(template: GraphTemplate, srcType: string, tgtType: string, edgeType: string): boolean {
  const def = template.edge_types.find((e) => e.type === edgeType);
  if (!def) return false;
  return endpointMatches(def.source_types, srcType) && endpointMatches(def.target_types, tgtType);
}

/** 边三元组去重（source,target,type 相同视为重复，对齐旧编辑器 S.edge dedup） */
export function findEdgeByTriple(
  edges: CanvasEdge[],
  source: string,
  target: string,
  edgeType: string,
): CanvasEdge | undefined {
  return edges.find((e) => e.source === source && e.target === target && String(e.data.edgeType || '') === edgeType);
}

/** 边类型推荐结果 */
export interface EdgeTypeRecommendation {
  type: string;
  score: number;       // 0-100 匹配度
  reason: string;      // 推荐理由
}

/**
 * 智能边类型推荐：基于节点名称、类型、属性对候选边类型进行语义排序
 * 评分维度：
 *   1. 边类型 label 与节点名称关键词重叠（+30 分/词）
 *   2. 边类型 description 包含源/目标节点类型关键词（+20 分）
 *   3. 模板中边类型的声明顺序（越靠前越可能是主关系，+10/位差）
 *   4. 边类型有 label（命名规范，+5 分）
 */
export function rankEdgeTypes(
  template: GraphTemplate,
  candidates: string[],
  srcName: string,
  tgtName: string,
  srcType: string,
  tgtType: string,
): EdgeTypeRecommendation[] {
  // 分词函数：中文按字、英文按单词
  const tokenize = (s: string): string[] => {
    if (!s) return [];
    const lower = s.toLowerCase();
    const tokens: string[] = [];
    // 英文单词
    const enWords = lower.match(/[a-z]{2,}/g) || [];
    tokens.push(...enWords);
    // 中文字符（2-4字滑窗）
    const cnChars = lower.match(/[\u4e00-\u9fa5]/g) || [];
    for (let i = 0; i < cnChars.length; i++) {
      tokens.push(cnChars[i]);
      if (i + 1 < cnChars.length) tokens.push(cnChars[i] + cnChars[i + 1]);
    }
    return tokens;
  };

  const srcTokens = new Set(tokenize(srcName));
  const tgtTokens = new Set(tokenize(tgtName));
  const allNodeTokens = new Set([...srcTokens, ...tgtTokens, ...tokenize(srcType), ...tokenize(tgtType)]);

  const results: EdgeTypeRecommendation[] = candidates.map((type, idx) => {
    const def = template.edge_types.find(e => e.type === type);
    if (!def) return { type, score: 0, reason: '' };

    let score = 0;
    const reasons: string[] = [];

    // 1. 边类型 label 与节点名称关键词重叠
    const labelTokens = tokenize(def.label || '');
    const typeTokens = tokenize(type);
    const edgeTokens = new Set([...labelTokens, ...typeTokens]);
    let overlap = 0;
    edgeTokens.forEach(t => {
      if (srcTokens.has(t) || tgtTokens.has(t)) overlap++;
    });
    if (overlap > 0) {
      score += Math.min(overlap * 30, 60);
      reasons.push(`名称匹配(${overlap}个关键词)`);
    }

    // 2. 边类型 label 包含节点类型关键词
    const labelStr = (def.label || '').toLowerCase();
    let typeMatch = 0;
    [srcType, tgtType].forEach(t => {
      if (t && labelStr.includes(t.toLowerCase())) typeMatch++;
    });
    if (typeMatch > 0) {
      score += typeMatch * 20;
      reasons.push(`类型约束匹配`);
    }

    // 3. 模板声明顺序（越靠前越优先，最多+20）
    const orderScore = Math.max(0, 20 - idx * 3);
    score += orderScore;
    if (orderScore > 10) reasons.push(`模板主关系`);

    // 4. 有 label 命名规范
    if (def.label && def.label !== type) {
      score += 5;
    }

    // 5. 端点约束精确度：约束不为空 = 更精确 = 更高分
    if (def.source_types && def.source_types.length > 0) score += 5;
    if (def.target_types && def.target_types.length > 0) score += 5;

    score = Math.min(score, 100);
    return { type, score, reason: reasons.join('、') || '默认推荐' };
  });

  // 按分数降序排序
  results.sort((a, b) => b.score - a.score);
  return results;
}
