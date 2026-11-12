# 部署指南

## 环境要求

- Node.js ≥ 18（开发验证版本：22.x）
- 无外部数据库依赖——模板、草稿、版本、批次、RSI 状态全部 JSON 文件存储
- 建图侧前端为仓库内静态 HTML，无构建步骤、无外部 CDN；`tools/vendor/` 已包含 vis-network / G6 / d3
- RSI V2 工作台是仓库内已构建好的 React SPA（`web/dist/`），`npm start` 直接托管，无需在部署机上构建
- **可选**：Python 3.11 + `services/rsi-agent/requirements.txt`（openjiuwen 0.1.19 等）——仅 `agent` 决策模式需要，不装也能用 `rules`/`model` 模式与全部只读界面

## 本地运行

```bash
npm install
npm start          # 默认 127.0.0.1:3013
```

打开 <http://127.0.0.1:3013/> —— 根路径 302 到 `/tools/index.html`。

启动自检：`curl http://127.0.0.1:3013/api/health` → `{"ok":true,"service":"graph-builder",...}`，响应里含 6 组 API 前缀、`rsiAgent` 地址与 `spa` 是否已构建；`curl -I http://127.0.0.1:3013/` 应返回 `302 Location: /tools/index.html`。

改端口：`PORT=4013 npm start`。改监听地址：`HOST=0.0.0.0 npm start`（**仅在已配置认证与网络访问控制时使用**）。

### 只用 Node 就能打开的 RSI 界面

```bash
curl http://127.0.0.1:3013/api/intent-rsi/state   # 首次访问自动从种子初始化 default/v1/main
# 浏览器：/intent-rsi（V2 工作台）  ·  /tools/intent-rsi-lab.html（V1 实验台）
```

### 需要 `agent` 决策模式时，启动 Python Agent

```bash
cd services/rsi-agent && pip install -r requirements.txt
RSI_AGENT_API_BASE_URL=http://127.0.0.1:3013/api/intent-rsi/agent \
  uvicorn app.main:app --host 0.0.0.0 --port 18132
# 另一个终端（仓库根）：RSI_AGENT_URL=http://127.0.0.1:18132 npm start
```

**两端地址必须互指**：Node 用 `RSI_AGENT_URL` 找 Agent，Agent 用 `RSI_AGENT_API_BASE_URL` 回调 Node 的 `/agent/*` 工具桥。容器部署时这两个值都要换成服务名，不能写 `localhost`。

## 环境变量

### 必读

| 变量 | 默认 | 说明 |
|------|------|------|
| `PORT` | `3013` | 监听端口；避开 AI Harbor `:3000` 与其余已拆分工作台 |
| `HOST` | `127.0.0.1` | 监听地址，默认仅本机可访问 |
| `SKIP_AUTH` | `true` | **生产环境必须设为 `false`**，否则任何人免登录获得 admin 权限 |
| `DEEPSEEK_KEY` / `QWEN_KEY` / `KIMI_KEY` / `GLM_KEY` / `VOLCANO_KEY` | 无 | 模型密钥，至少配一个才有 AI 能力；RSI 的有效基线也需要；支持 `.env` 文件 |

### 可选（建图侧）

| 变量 | 默认 | 说明 |
|------|------|------|
| `DEV_MODE` | `true` | 允许无密钥降级运行 |
| `KNOWLEDGE_INTAKE_DIR` | `<repo>/data/knowledge-intake` | 摄入批次存储目录 |
| `REQUIRE_PUBLISH_APPROVAL` | `false` | 发布需审批（入 publish-requests 队列） |
| `JWT_SECRET` | 无 | `SKIP_AUTH=false` 时必配 |
| `TRIAL_AGENT_URL` | 无 | 意图试算外部代理（未启动时相关端点降级） |
| `BUILDER_AGENT_URL` | `http://graph-builder-agent:18131` | 构建代理（无可不配，相关功能降级） |

### 可选（RSI 侧）

| 变量 | 默认 | 说明 |
|------|------|------|
| `INTENT_RSI_DIR` | `<repo>/data/rsi` | RSI 状态/版本/快照/任务根目录 |
| `RSI_AGENT_URL` | `http://rsi-agent:18132` | Node → Python Agent；本机演示设 `http://127.0.0.1:18132` |
| `RSI_AGENT_API_BASE_URL` | `http://127.0.0.1:3013/api/intent-rsi/agent` | Agent → Node 工具桥；**仅在启动 Python Agent 时生效** |
| `INTENT_LLM_ROUTE` | `qwen3.7-flash` | 评测引擎默认对话路由（见 `config/api-keys.js`） |
| `INTENT_EMBEDDING_ROUTE` | `text-embedding-v4` | 向量召回路由 |
| `RSI_SCORING_MAX_CONCURRENCY` | `8` | 评分子进程并发上限 |
| `RSI_AGENT_MODEL_{NAME,BASE_URL,API_KEY,PROVIDER}` | `qwen-plus` 或 `deepseek-chat` | Agent 侧模型；`QWEN_KEY` / `DEEPSEEK_KEY` 可兜底 |
| `RSI_AGENT_PORT` / `RSI_AGENT_MAX_ITERATIONS` | `18132` / `56` | Agent 端口与迭代预算 |

完整清单见 `.env.example` 与 [RSI V2 架构说明](intent-rsi-v2-architecture.md#环境变量与端口)。

## 生产部署要点

1. **认证**：`SKIP_AUTH=false` + `JWT_SECRET=<强随机>`；前端登录后携带 JWT。默认 `SKIP_AUTH=true` 只为本机开箱体验。RSI 的采纳/回滚写端点同样需要纳入访问控制。
2. **网络边界**：默认绑定 `127.0.0.1`。对外提供服务时改 `HOST` 并在反向代理层做 TLS、认证与限流，不要把免鉴权服务直接暴露到公网；`:18132` 的 Python Agent 只应允许 Node 服务访问。
3. **密钥**：通过容器 secrets / K8s Secret 注入，不要写进镜像。Python Agent 与 Node 各自读自己进程的密钥。
4. **数据持久化**：把 `data/` 挂载为卷——模板随仓库走，图谱草稿/版本/批次与 `data/rsi/` 是运行期状态。
5. **备份**：备份 `data/graphs/org/`（图谱资产）、`data/knowledge-intake/`（在途批次）与 `data/rsi/{versions,snapshots,tasks,artifacts}`（版本链与资产谱系）。`data/rsi/{checkpoints,drafts,logs}` 可重建。
6. **长请求**：分块抽取单请求最长约 11 分钟；RSI 自动进化是 SSE 长连接，`server.js` 已设 `requestTimeout=30min` / `headersTimeout=65s`。反代需调大 `proxy_read_timeout`（建议 ≥1800s）并关闭缓冲。
7. **静态资源**：`/tools/*`、`/docs/*`、`/assets/*` 由 `server.js` 直接托管，无需额外 Web 服务器；`/intent-rsi` 等非 API 路径回退到 `web/dist/index.html`。
8. **无密钥时的 RSI 行为**：评分子进程仍能跑完打分，但向量/模型通道降级会让 `/baseline` 返回 400「本次测量不作为方案收益或无收益的证据」。要出有效结论必须先配模型密钥。

### Docker 示例（Node 服务）

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
ENV NODE_ENV=production SKIP_AUTH=false HOST=0.0.0.0
EXPOSE 3013
CMD ["node", "server.js"]
```

### Docker Compose（含可选 rsi-agent）

```yaml
services:
  graph-builder:
    build: .
    ports: ["3013:3013"]
    environment:
      DEEPSEEK_KEY: ${DEEPSEEK_KEY}
      QWEN_KEY: ${QWEN_KEY}
      JWT_SECRET: ${JWT_SECRET}
      RSI_AGENT_URL: http://rsi-agent:18132
    volumes:
      - gb-data:/app/data
    depends_on:
      - rsi-agent

  rsi-agent:
    build: ./services/rsi-agent       # 自带 Dockerfile，EXPOSE 18132
    environment:
      RSI_AGENT_API_BASE_URL: http://graph-builder:3013/api/intent-rsi/agent
      QWEN_KEY: ${QWEN_KEY}
      DEEPSEEK_KEY: ${DEEPSEEK_KEY}
    volumes:
      - rsi-checkpoints:/app/checkpoints
    # 不对外发布端口，只允许 Node 服务访问

volumes:
  gb-data:
  rsi-checkpoints:
```

> 不需要 `agent` 决策模式时，删掉 `rsi-agent` 服务与 `RSI_AGENT_URL` 即可，其余功能不受影响。compose 里的服务名必须同时出现在两端地址环境变量中。

### Nginx 反代（独立站点）

```nginx
server {
    listen 443 ssl;
    server_name graph-builder.example.com;

    location / {
        proxy_pass http://127.0.0.1:3013;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 1800s;     # 分块抽取 + RSI 自动进化 SSE
        proxy_http_version 1.1;
        proxy_set_header Connection '';
        proxy_buffering off;          # SSE / 进度轮询
    }
}
```

> Nginx 层不需要再做原单体的 `/ontomind/wiki/api/ → /api/` 前缀改写；历史 `web/dist` 产物写死的该前缀由 `server.js` 在分发前就地归一化。重新构建 `web/dist`（源码已改为 `BASE="/api"`）后，这段兼容分支可以删掉。

## 升级与数据迁移

- 模板升级：替换 `data/graph-builder-templates/*.json` 后重启；已发布版本文件不可变，草稿首次保存时会自动补 `template_ref`。注意 `template.intent.v2.json` 是 RSI 评测引擎的 schema 基准，替换前先跑 `tools/intent-graph-schema.js` 的 `checkTemplateAlignment()`。
- 代码升级：无 schema migration 概念——校验器在读取时即时校验，不兼容会给出明确错误清单。
- RSI 数据升级：`rsi-state.json` / `active-task.json` 可删，首次访问会由 `initState()` 从种子重建；但 `versions/`、`snapshots/`、`artifacts/`、`tasks/` 是历史证据，删除即丢失成绩轨迹与资产谱系。
- 引擎指纹变更：改 `routes/intent-evaluator-v2.js` 等参与指纹的文件会换 `engineSha`，跨指纹历史成绩不可比，需重新跑基线（这是设计行为）。
- 前端升级：直接替换 `tools/*.html` 与 `tools/vendor/`；改 `web/src/` 后需 `npm run build:web` 重建 `web/dist/`。给图片/脚本换新文件名或加版本号查询串，避免 CDN 缓存旧版。
