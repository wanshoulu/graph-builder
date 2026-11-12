'use strict';

/**
 * graph-builder — 模板驱动 · 写入即校验的知识图谱构建工具链（独立服务 + 独立前端）
 *
 * 从 AI Harbor / OntoMind 单体剥离后的独立部署入口：
 *   - 前端：tools/*.html（单文件应用，无框架、无外部 CDN），根路径 302 到 /tools/index.html
 *   - 后端：routes/* 四个路由族，前缀互斥、各自自检
 *   - 数据：JSON 文件即契约，无数据库
 *
 * 路由族：
 *   /api/knowledge-intake/*          Excel 摄入 → 评审 → 预检 → 应用 → 回滚
 *   /api/org-graph/*                 图谱资产管理：模板/草稿/抽取/校验/发布/质量审计
 *   /api/intent-graph/*              意图图谱编辑器：版本/schema/加载/校验/导出
 *   /api/intent-graph-autobuild/*    自动建图：候选/生成/任务/合并（+ /api/intent-graph/release）
 *   /api/graph/data                  展示页用的图谱数据（默认内置 demo）
 *
 * 设计约定（沿用原单体）：入口把 req.url 解析为 req.pathname 挂到请求对象上，
 * 每个路由处理器自检前缀，返回 false 表示"不归我管"。SKIP_AUTH=true 时免登录。
 *
 * 环境变量：
 *   PORT       监听端口（默认 3013，避开 AI Harbor 3000 与其余独立工作台）
 *   HOST       监听地址（默认 127.0.0.1，仅本机可访问、无鉴权）
 *   SKIP_AUTH  "true" 跳过 JWT 认证（默认 true；生产务必设 false 并配 JWT_SECRET）
 *   DEV_MODE   "true" 时允许无 env 密钥时使用占位（默认 true）
 *   KNOWLEDGE_INTAKE_DIR / REQUIRE_PUBLISH_APPROVAL / TRIAL_AGENT_URL / BUILDER_AGENT_URL 见 .env.example
 */

const http = require('http');
const path = require('path');
const fs = require('fs');

process.env.SKIP_AUTH = process.env.SKIP_AUTH || 'true';
process.env.DEV_MODE = process.env.DEV_MODE || 'true';

const { handleOrgGraphRequest } = require('./routes/org-graph');
const { handleKnowledgeIntakeRequest } = require('./routes/knowledge-intake');
const { handleIntentGraphEditorRequest } = require('./routes/intent-graph-editor');
const { handleIntentGraphAutobuildRequest } = require('./routes/intent-graph-autobuild');

const PORT = Number(process.env.PORT || 3013);
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = __dirname;
const TOOLS_ROOT = path.join(ROOT, 'tools');
const DOC_ROOT = path.join(ROOT, 'docs');
const DATA_ROOT = path.join(ROOT, 'data');
const GRAPHS_DIR = path.join(DATA_ROOT, 'graphs');

const MIME = {
  '.html': 'text/html;charset=utf-8',
  '.css': 'text/css;charset=utf-8',
  '.js': 'application/javascript;charset=utf-8',
  '.json': 'application/json;charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.md': 'text/markdown;charset=utf-8',
  '.csv': 'text/csv;charset=utf-8',
  '.txt': 'text/plain;charset=utf-8',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.py': 'text/plain;charset=utf-8',
};

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json;charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, buf) => {
    if (err) return sendJson(res, 404, { ok: false, error: 'NOT_FOUND', path: filePath.replace(ROOT, '') });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

/** 静态目录映射：URL 前缀 → 磁盘目录，禁止路径穿越 */
function serveStatic(res, pathname, urlPrefix, diskRoot) {
  const rel = decodeURIComponent(pathname.slice(urlPrefix.length));
  const abs = path.resolve(diskRoot, rel);
  if (abs !== diskRoot && !abs.startsWith(diskRoot + path.sep)) {
    return sendJson(res, 403, { ok: false, error: 'FORBIDDEN' });
  }
  return serveFile(res, abs);
}

/** 展示页用：从 data/graphs/<id>.json 读取图谱，默认 demo */
function serveGraphData(res, searchParams) {
  const id = (searchParams.get('id') || 'demo').replace(/[^A-Za-z0-9_-]/g, '');
  const file = path.join(GRAPHS_DIR, id + '.json');
  fs.readFile(file, (err, buf) => {
    if (err) {
      return sendJson(res, 404, {
        ok: false,
        error: 'GRAPH_NOT_FOUND',
        hint: '把图谱放到 data/graphs/<id>.json，然后用 /api/graph/data?id=<id> 读取',
      });
    }
    try {
      const data = JSON.parse(buf.toString('utf8'));
      if (!Array.isArray(data.nodes) || !Array.isArray(data.edges)) {
        return sendJson(res, 422, { ok: false, error: 'INVALID_GRAPH_SHAPE', hint: '需要 { title, nodes: [], edges: [] }' });
      }
      res.writeHead(200, { 'Content-Type': 'application/json;charset=utf-8' });
      res.end(buf);
    } catch (e) {
      sendJson(res, 500, { ok: false, error: 'INVALID_JSON', detail: e.message });
    }
  });
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://${HOST}:${PORT}`);
  req.pathname = decodeURIComponent(u.pathname);
  const p = req.pathname;

  // 健康检查
  if (p === '/healthz' || p === '/api/health') {
    return sendJson(res, 200, {
      ok: true, service: 'graph-builder', version: '1.0.0',
      port: PORT, time: new Date().toISOString(),
      routes: ['/api/knowledge-intake/*', '/api/org-graph/*', '/api/intent-graph/*',
        '/api/intent-graph-autobuild/*', '/api/graph/data'],
    });
  }

  // 独立门户：根路径直接落到工具页，避免 readFile 直出相对资源时 404
  if (p === '/' || p === '/index.html') {
    res.writeHead(302, { Location: '/tools/index.html' });
    return res.end();
  }
  if (p === '/favicon.ico') {
    res.writeHead(204);
    return res.end();
  }

  // 路由分发（顺序有意义：/api/intent-graph/release 归 autobuild，必须排在 editor 之前）
  if (p.startsWith('/api/knowledge-intake/')) return handleKnowledgeIntakeRequest(req, res);
  if (p.startsWith('/api/org-graph/')) return handleOrgGraphRequest(req, res);
  if (p.startsWith('/api/intent-graph-autobuild/') || p === '/api/intent-graph/release') {
    return handleIntentGraphAutobuildRequest(req, res);
  }
  if (p.startsWith('/api/intent-graph/')) return handleIntentGraphEditorRequest(req, res);
  if (p === '/api/graph/data') return serveGraphData(res, u.searchParams);

  // 静态资源：只开放 data/graphs 与样例 CSV，不暴露摄入批次等运行期数据
  if (p.startsWith('/tools/')) return serveStatic(res, p, '/tools/', TOOLS_ROOT);
  if (p.startsWith('/docs/')) return serveStatic(res, p, '/docs/', DOC_ROOT);
  if (p.startsWith('/data/graphs/') || p.startsWith('/data/graph-builder-samples/')) {
    return serveStatic(res, p, '/data/', DATA_ROOT);
  }

  return sendJson(res, 404, {
    ok: false,
    error: 'NOT_FOUND',
    hint: '入口 /tools/index.html；API 前缀 /api/knowledge-intake/*、/api/org-graph/*、/api/intent-graph/*、/api/intent-graph-autobuild/*；文档 /docs/',
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[graph-builder] http://${HOST}:${PORT}  →  /tools/index.html`);
  console.log(`[graph-builder] SKIP_AUTH=${process.env.SKIP_AUTH} DEV_MODE=${process.env.DEV_MODE}`);
});

module.exports = server;
