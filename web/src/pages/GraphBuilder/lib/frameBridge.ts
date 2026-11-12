const TRUSTED_GRAPH_MESSAGE_TYPES = new Set([
  'graphReady',
  'graphLoaded',
  'graphError',
  'nodeSelected',
  'edgeSelected',
  'addNodeRequest',
  'connectRequest',
  'connectToCanvasRequest',
  'contextMenu',
  'dragEnd',
  'selectionChanged',
  // 导出 PNG：iframe 回传截图（base64）或失败原因
  'imageData',
  'imageError',
]);

export function frameOrigin(src: string, baseUrl: string): string {
  return new URL(src, baseUrl).origin;
}

export function isTrustedFrameMessage(
  event: { source: unknown; origin: string; data: unknown },
  expectedSource: unknown,
  expectedOrigin: string,
): boolean {
  if (!expectedSource || event.source !== expectedSource || event.origin !== expectedOrigin) return false;
  if (!event.data || typeof event.data !== 'object') return false;
  const type = (event.data as { type?: unknown }).type;
  return typeof type === 'string' && TRUSTED_GRAPH_MESSAGE_TYPES.has(type);
}

export function postFrameMessage(
  target: { postMessage: (message: unknown, targetOrigin: string) => void } | null | undefined,
  message: unknown,
  targetOrigin: string,
  ready: boolean,
): boolean {
  if (!ready || !target) return false;
  target.postMessage(message, targetOrigin);
  return true;
}
