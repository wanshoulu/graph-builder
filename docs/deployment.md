# 部署指南

## 环境要求

- Node.js ≥ 18（开发验证版本：22.x）
- 无外部数据库依赖——模板、草稿、版本、批次全部 JSON 文件存储
- 前端为仓库内静态 HTML，无构建步骤、无 npm 打包、无外部 CDN；`tools/vendor/` 已包含 vis-network / G6 / d3

## 本地运行

```bash
npm install
npm start          # 默认 127.0.0.1:3013
```

打开 <http://127.0.0.1:3013/> —— 根路径 302 到 `/tools/index.html`。

启动自检：`curl http://127.0.0.1:3013/api/health` → `{"ok":true,"service":"graph-builder",...}`；`curl -I http://127.0.0.1:3013/` 应返回 `302 Location: /tools/index.html`。

改端口：`PORT=4013 npm start`。改监听地址：`HOST=0.0.0.0 npm start`（**仅在已配置认证与网络访问控制时使用**）。

## 环境变量

### 必读

| 变量 | 默认 | 说明 |
|------|------|------|
| `PORT` | `3013` | 监听端口；避开 AI Harbor `:3000` 与其余已拆分工作台 |
| `HOST` | `127.0.0.1` | 监听地址，默认仅本机可访问 |
| `SKIP_AUTH` | `true` | **生产环境必须设为 `false`**，否则任何人免登录获得 admin 权限 |
| `DEEPSEEK_KEY` / `QWEN_KEY` / `KIMI_KEY` / `GLM_KEY` / `VOLCANO_KEY` | 无 | 模型密钥，至少配一个才有 AI 能力；支持 `.env` 文件 |

### 可选

| 变量 | 默认 | 说明 |
|------|------|------|
| `DEV_MODE` | `true` | 允许无密钥降级运行 |
| `KNOWLEDGE_INTAKE_DIR` | `<repo>/data/knowledge-intake` | 摄入批次存储目录 |
| `REQUIRE_PUBLISH_APPROVAL` | `false` | 发布需审批（入 publish-requests 队列） |
| `JWT_SECRET` | 无 | `SKIP_AUTH=false` 时必配 |
| `TRIAL_AGENT_URL` | 无 | 意图试算外部代理（未启动时相关端点降级） |
| `BUILDER_AGENT_URL` | `http://graph-builder-agent:18131` | 构建代理（无可不配，相关功能降级） |

## 生产部署要点

1. **认证**：`SKIP_AUTH=false` + `JWT_SECRET=<强随机>`；前端登录后携带 JWT。默认 `SKIP_AUTH=true` 只为本机开箱体验。
2. **网络边界**：默认绑定 `127.0.0.1`。对外提供服务时改 `HOST` 并在反向代理层做 TLS、认证与限流，不要把免鉴权服务直接暴露到公网。
3. **密钥**：通过容器 secrets / K8s Secret 注入，不要写进镜像。
4. **数据持久化**：把 `data/` 挂载为卷——模板随仓库走，图谱草稿/版本/批次是运行期状态。
5. **备份**：备份 `data/graphs/org/`（图谱资产）与 `data/knowledge-intake/`（在途批次）。
6. **长请求**：分块抽取单请求最长约 11 分钟，反代需调大 `proxy_read_timeout`（建议 ≥900s），SSE/进度轮询接口关闭缓冲。
7. **静态资源**：`/tools/*` 与 `/docs/*` 由 `server.js` 直接托管，无需额外 Web 服务器；`POST /api/graph-builder/tools/*` 等写端点应单独做访问控制。

### Docker 示例

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

```yaml
# docker-compose 片段
services:
  graph-builder:
    build: .
    ports: ["3013:3013"]
    environment:
      DEEPSEEK_KEY: ${DEEPSEEK_KEY}
      JWT_SECRET: ${JWT_SECRET}
    volumes:
      - gb-data:/app/data
volumes:
  gb-data:
```

### Nginx 反代（独立站点）

```nginx
server {
    listen 443 ssl;
    server_name graph-builder.example.com;

    location / {
        proxy_pass http://127.0.0.1:3013;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 900s;      # 分块抽取长请求
        proxy_http_version 1.1;
        proxy_set_header Connection '';
        proxy_buffering off;          # SSE / 进度轮询
    }
}
```

> 本项目已独立部署，不再需要原单体里 `/ontomind/wiki/api/` → `/api/` 的同源前缀改写；路径均为本站根路径。

## 升级与数据迁移

- 模板升级：替换 `data/graph-builder-templates/*.json` 后重启；已发布版本文件不可变，草稿首次保存时会自动补 `template_ref`。
- 代码升级：无 schema migration 概念——校验器在读取时即时校验，不兼容会给出明确错误清单。
- 前端升级：直接替换 `tools/*.html` 与 `tools/vendor/`，无缓存破坏时给图片/脚本加版本号查询串。
