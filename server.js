'use strict';

/**
 * graph-builder — 模板驱动的知识图谱构建工具链 + RSI 意图进化实验台（独立服务 + 独立前端）
 *
 * 从 AI Harbor / OntoMind 单体剥离后的独立部署入口：
 *   - 门户：tools/*.html（单文件应用，无框架、无外部 CDN），根路径 302 到 /tools/index.html
 *   - RSI V2 工作台：web/dist/ 的 React SPA，/intent-rsi 等路由由 SPA 兜底接管
 *   - 后端：routes/* 五组路由 + RSI 调度层（含 /agent/* 工具桥）
 *   - Agent：services/rsi-agent（Python / openjiuwen DeepAgent + SKILL.prompt），独立进程 :18132
 *   - 数据：JSON 文件即契约，无数据库
 *
 * 路由族：
 *   /api/knowledge-intake/*          Excel 摄入 → 评审 → 预检 → 应用 → 回滚
 *   /api/org-graph/*                 图谱资产管理：模板/草稿/抽取/校验/发布/质量审计
 *   /api/intent-graph/*              意图图谱编辑器：版本/schema/加载/校验/导出
 *   /api/intent-graph-autobuild/*    自动建图：候选/生成/任务/合并（+ /api/intent-graph/release）
 *   /api/intent-rsi/*                RSI 意图进化：状态/基线/提案/评测/门禁/自动进化 + /agent/* 工具桥
 *   /api/graph/data                  展示页用的图谱数据（默认内置 demo）
 *   /ontomind/wiki/api/*             兼容层：历史构建产物写死的 RSI 前缀，内部重写为 /api/*
 *
 * 设计约定（沿用原单体）：入口把 req.url 解析为 req.pathname 挂到请求对象上，
 * 每个路由处理器自检前缀。SKIP_AUTH=true 时免登录。
 *
 * 环境变量：
 *   PORT            监听端口（默认 3013，避开 AI Harbor 3000 与其余独立工作台）
 *   HOST            监听地址（默认 127.0.0.1，仅本机可访问、无鉴权）
 *   SKIP_AUTH       "true" 跳过 JWT 认证（默认 true；生产务必设 false 并配 JWT_SECRET）
 *   DEV_MODE        "true" 时允许无 env 密钥时使用占位（默认 true）
 *   INTENT_RSI_DIR  RSI 数据目录（默认 ./data/rsi）
 *   RSI_AGENT_URL   Python Agent 地址（默认 http://rsi-agent:18132；本机演示设 127.0.0.1:18132）
 *   其余见 .env.example
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
const { handleIntentRsiRequest } = require('./routes/intent-rsi');
const { handleGraphBuilderToolsRequest } = require('./routes/graph-builder-tools');

const PORT = Number(process.env.PORT || 3013);
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = __dirname;
const TOOLS_ROOT = path.join(ROOT, 'tools');
const DOC_ROOT = path.join(ROOT, 'docs');
const DATA_ROOT = path.join(ROOT, 'data');
const GRAPHS_DIR = path.join(DATA_ROOT, 'graphs');
const WEB_DIST = path.join(ROOT, 'web', 'dist');
const WEB_ASSETS = path.join(WEB_DIST, 'assets');

// 历史 dist 的「图谱应用」子菜单仍指向单体工具页，独立仓没有这些页面。
const LEGACY_TOOL_PAGES = new Set([
  '/tools/knowledge-qa.html',
  '/tools/credit-risk-agent.html',
  '/tools/schedule-agent.html',
  '/tools/smart-marketing/',
]);

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
  // 历史 RSI V2 构建产物把 BASE 写死为 /ontomind/wiki/api（单体 nginx 前缀）。
  // 独立仓没有该前缀的网关，这里在分发前就地归一化，让 dist 零改动可用；
  // 源码 web/src/pages/IntentRsiEvolution/rsiShared.tsx 已改为 /api，重新构建后不依赖本兼容层。
  const LEGACY_API_PREFIX = '/ontomind/wiki/api/';
  if (req.url.startsWith(LEGACY_API_PREFIX)) {
    req.url = '/api/' + req.url.slice(LEGACY_API_PREFIX.length);
  }

  const u = new URL(req.url, `http://${HOST}:${PORT}`);
  req.pathname = decodeURIComponent(u.pathname);
  const p = req.pathname;

  // 健康检查
  if (p === '/healthz' || p === '/api/health') {
    return sendJson(res, 200, {
      ok: true, service: 'graph-builder', version: '1.1.0',
      port: PORT, time: new Date().toISOString(),
      routes: ['/api/knowledge-intake/*', '/api/org-graph/*', '/api/intent-graph/*',
        '/api/intent-graph-autobuild/*', '/api/intent-rsi/*', '/api/graph-builder/tools/*', '/api/graph/data'],
      rsiAgent: process.env.RSI_AGENT_URL || 'http://rsi-agent:18132',
      spa: fs.existsSync(path.join(WEB_DIST, 'index.html')),
    });
  }

  // 根路径落到统一工作台（OntoMind 图谱构建 SPA，/auto-build /builder /intake /evaluation /management /intent-rsi）
  if (p === '/' || p === '/index.html') {
    res.writeHead(302, { Location: '/auto-build' });
    return res.end();
  }
  if (p === '/favicon.ico' || p === '/vite.svg') {
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
  // RSI 意图进化：35 个端点含 /agent/* 工具桥与 /auto-evolve SSE 长连接
  if (p.startsWith('/api/intent-rsi')) return handleIntentRsiRequest(req, res);
  // 逐节点/逐边 AI 字段审核（SPA builder 的 AI 辅助面板用）
  if (p.startsWith('/api/graph-builder/tools/')) return handleGraphBuilderToolsRequest(req, res);
  if (p === '/api/graph/data') return serveGraphData(res, u.searchParams);

  // 历史 dist 保留的单体工具页链接统一回落门户，避免点进去 404。
  // 源码 web/src/main.tsx 已换成本仓页面，重新 npm run build 后本段可删。
  if (LEGACY_TOOL_PAGES.has(p)) {
    res.writeHead(302, { Location: '/tools/index.html' });
    return res.end();
  }

  // 静态资源：只开放 data/graphs 与样例 CSV，不暴露摄入批次等运行期数据
  if (p.startsWith('/tools/')) return serveStatic(res, p, '/tools/', TOOLS_ROOT);
  if (p.startsWith('/docs/')) return serveStatic(res, p, '/docs/', DOC_ROOT);
  if (p.startsWith('/data/graphs/') || p.startsWith('/data/graph-builder-samples/')) {
    return serveStatic(res, p, '/data/', DATA_ROOT);
  }
  if (p.startsWith('/assets/')) return serveStatic(res, p, '/assets/', WEB_ASSETS);

  // React SPA（RSI V2 工作台）：非 API、非静态资源的 GET 一律回退到 index.html
  if (req.method === 'GET' && !p.startsWith('/api/') && fs.existsSync(path.join(WEB_DIST, 'index.html'))) {
    return serveFile(res, path.join(WEB_DIST, 'index.html'));
  }

  return sendJson(res, 404, {
    ok: false,
    error: 'NOT_FOUND',
    hint: '入口 /tools/index.html；RSI 工作台 /intent-rsi；API 前缀 /api/knowledge-intake/*、/api/org-graph/*、/api/intent-graph/*、/api/intent-graph-autobuild/*、/api/intent-rsi/*；文档 /docs/',
  });
});

// 长任务超时：Node 18+ 默认 requestTimeout=5min 会掐死 RSI 自动进化 / 校准子进程。
// 各 RSI 端点自带守卫，这里放开服务器级限制（沿用原单体口径）。
server.requestTimeout = 30 * 60 * 1000;
server.headersTimeout = 65 * 1000;

server.listen(PORT, HOST, () => {
  console.log(`[graph-builder] http://${HOST}:${PORT}  →  统一工作台 /auto-build（SPA）· 辅助导航 /tools/index.html`);
  console.log(`[graph-builder] RSI 工作台           →  /intent-rsi （V2 SPA）/ /tools/intent-rsi-lab.html（V1 实验台）`);
  console.log(`[graph-builder] RSI Agent            →  ${process.env.RSI_AGENT_URL || 'http://rsi-agent:18132'}`);
  console.log(`[graph-builder] SKIP_AUTH=${process.env.SKIP_AUTH} DEV_MODE=${process.env.DEV_MODE}`);
});

module.exports = server;
