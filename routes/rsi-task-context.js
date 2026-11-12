'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const storage = new AsyncLocalStorage();
const TASK_ID_RE = /^[a-z0-9][a-z0-9-]{2,47}$/;
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
function fromRequest(req, fallback) {
  const url = new URL(req.url || req.pathname, 'http://localhost');
  const query = url.searchParams.get('taskId');
  const header = req.headers?.['x-rsi-task-id'];
  if (query && header && query !== header) throw fail('taskId 与 X-RSI-Task-Id 不一致');
  const explicit = query || header;
  if (explicit && !TASK_ID_RE.test(explicit)) throw fail('无效 taskId');
  const global = ['/tasks/create', '/tasks/switch', '/tasks/delete', '/import-snapshot', '/import-graph-file', '/split-preview'].some(p => url.pathname === '/api/intent-rsi' + p);
  const writes = !['GET', 'HEAD'].includes(req.method) || /\/auto-evolve(-resume)?$/.test(url.pathname);
  if (writes && !global && !explicit) throw fail('任务写请求必须提供 taskId 或 X-RSI-Task-Id');
  return { taskId: explicit || fallback(), explicit: !!explicit, expectedRevision: req.headers?.['x-rsi-revision'] };
}
module.exports = { run: (ctx, fn) => storage.run(ctx, fn), current: () => storage.getStore(), fromRequest, fail };
