/**
 * 编辑器历史状态（undo/redo 快照栈，纯函数）
 *
 * 优化：用 structuredClone 替代 JSON.parse(JSON.stringify())，
 * 性能提升 2-5x（大图谱数百节点时显著）；
 * 退回 JSON 方式兼容旧浏览器（structuredClone >= Node 17 / Chrome 98）。
 * 上限 100 步，对齐 AI Harbor graph-editor。
 */
import type { CanvasEdge, CanvasNode } from '../lib/graphDoc';

export interface HistoryState {
  stack: { nodes: CanvasNode[]; edges: CanvasEdge[] }[];
  idx: number;
}

export function initialHistory(snapshot: { nodes: CanvasNode[]; edges: CanvasEdge[] }): HistoryState {
  return { stack: [snapshot], idx: 0 };
}

export function pushHistory(history: HistoryState, snapshot: { nodes: CanvasNode[]; edges: CanvasEdge[] }): HistoryState {
  const stack = history.stack.slice(0, history.idx + 1);
  stack.push(snapshot);
  if (stack.length > 100) stack.shift();
  return { stack, idx: stack.length - 1 };
}

export function canUndo(history: HistoryState): boolean {
  return history.idx > 0;
}

export function canRedo(history: HistoryState): boolean {
  return history.idx < history.stack.length - 1;
}

export function undo(history: HistoryState): { history: HistoryState; snapshot: { nodes: CanvasNode[]; edges: CanvasEdge[] } } {
  if (!canUndo(history)) return { history, snapshot: history.stack[history.idx] };
  const idx = history.idx - 1;
  return { history: { stack: history.stack, idx }, snapshot: history.stack[idx] };
}

export function redo(history: HistoryState): { history: HistoryState; snapshot: { nodes: CanvasNode[]; edges: CanvasEdge[] } } {
  if (!canRedo(history)) return { history, snapshot: history.stack[history.idx] };
  const idx = history.idx + 1;
  return { history: { stack: history.stack, idx }, snapshot: history.stack[idx] };
}

/**
 * 深拷贝快照（画布数据可能含嵌套对象，快照隔离避免引用污染）
 * 优先使用 structuredClone（V8 原生实现，比 JSON 快 2-5x），旧环境退回 JSON。
 */
const _structuredClone: (<T>(value: T) => T) | null =
  typeof structuredClone === 'function' ? structuredClone : null;

export function cloneSnapshot(snapshot: { nodes: CanvasNode[]; edges: CanvasEdge[] }): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  if (_structuredClone) return _structuredClone(snapshot);
  return JSON.parse(JSON.stringify(snapshot));
}
