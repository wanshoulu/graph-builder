/**
 * 画布视觉信息注入（编辑/展示两种模式共用）：模板色 + 显示名兜底 + 度数 + 领域色条。
 * 从 ManualBuilderPanel 抽出（展示模式复用同一套视觉语义）。
 */
import { nodeDisplayName, type CanvasGraph } from './graphDoc';
import type { EditorSchema } from './templateSchema';

/** 领域配色（泳道背景 + 节点色条一致）：转账服务蓝、财富管理绿、总根紫；未知领域用紫系兜底 */
export const DOMAIN_TINTS: Record<string, string> = {
  '转账服务': '#165dff',
  '财富管理': '#00b42a',
  '手机银行': '#722ed1',
};
export const DOMAIN_TINT_FALLBACK = '#7b61ff';

/** 注入视觉信息：模板色 / 显示名兜底 / 度数（节点尺寸用）/ 领域色条；加载时一次性计算 */
export function applyCanvasVisuals(canvas: CanvasGraph, schema: EditorSchema): CanvasGraph {
  const degree = new Map<string, number>();
  canvas.edges.forEach((e) => {
    degree.set(e.source, (degree.get(e.source) || 0) + 1);
    degree.set(e.target, (degree.get(e.target) || 0) + 1);
  });
  return {
    ...canvas,
    nodes: canvas.nodes.map((n) => {
      const data = { ...n.data };
      if (!data.nodeColor) data.nodeColor = schema.nodeColors[String(data.nodeType || '')] || '#5B8FF9';
      if (!data.name && !data.title) {
        const label = nodeDisplayName(n);
        if (label && label !== n.id) data.name = label;
      }
      data.degree = degree.get(n.id) || 0;
      const domain = String(data.domain || '');
      if (domain && !data.domainTint) data.domainTint = DOMAIN_TINTS[domain] || DOMAIN_TINT_FALLBACK;
      return { ...n, data };
    }),
  };
}
