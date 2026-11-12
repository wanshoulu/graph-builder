# API 参考

基础地址：`http://127.0.0.1:3013`（`PORT` / `HOST` 可改）。前端页面、SPA 构建产物与架构图同样由该服务托管：`/tools/*`、`/docs/*`、`/assets/*`；`/intent-rsi` 等非 API 路径回退到 `web/dist/index.html`；根路径 302 到 `/tools/index.html`。历史构建产物写死的 `/ontomind/wiki/api/*` 会在分发前被归一化到 `/api/*`。
认证：`SKIP_AUTH=true`（默认开发模式）免认证；生产模式带 `Authorization: Bearer <JWT>`。
通用响应：`{ "ok": true, ... }` 或 `{ "ok": false, "error": "..." }`；部分路由族沿用 `{success, data}` / `{success, error}` 壳，以各端点实际返回为准。

## 系统端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/healthz`、`/api/health` | 健康检查：服务版本、端口、6 组 API 前缀、`rsiAgent` 地址、`spa` 是否已构建 |
| GET | `/api/graph/data?id=demo` | 展示页图谱数据，读 `data/graphs/{id}.json`（id 仅允许字母数字 `_` `-`） |
| GET | `/docs/*` | 仓库 docs 静态资源 |
| GET | `/assets/*` | `web/dist/assets/` 静态资源（React SPA 构建产物） |
| GET | `/ontomind/wiki/api/*` | 兼容层：归一化到 `/api/*`，供历史 `web/dist` 的 RSI 请求使用 |

---

## Knowledge Intake — 知识摄入 `/api/knowledge-intake/*`

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/template` | 下载标准填报 Excel 模板（xlsx 二进制） |
| POST | `/import` | 上传 Excel 创建批次（multipart，字段名 `file`） |
| GET | `/batches` | 批次列表 |
| GET | `/batches/{id}` | 批次详情 |
| GET | `/batches/{id}/tree` | 功能→意图→说法树（含每行状态与 AI assist 建议） |
| POST | `/batches/{id}/review` | 批量评审 `{action: approve\|reject\|reset, itemIds: [rowId], note}` |
| POST | `/batches/{id}/items` | 行明细 |
| POST | `/batches/{id}/skeleton-assist` | AI 骨架辅助（映射建议） |
| POST | `/batches/{id}/expand-utterances` | AI 扩问补全 |
| POST | `/batches/{id}/node-review` | AI 节点审查 |
| POST | `/batches/{id}/check-conflicts` | 冲突检测 |

---

## Org Graph — 图谱资产 `/api/org-graph/*`

> 资产（asset）= 一份模板绑定的图谱实例。内置 13 张业务模板 + 1 张 RSI 引擎 schema 基准、五类图谱（意图/组织人力/客户风控/领域知识/通用），全部端点对任何模板通用；上传模板 + 注册即可接入新图谱类型，无专用端点。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/assets` | 资产列表（含模板版本、节点/边类型） |
| GET | `/status?asset=` | 资产状态（activeVersion、版本历史、节点边统计） |
| GET | `/template?asset=` | 模板元数据 |
| GET | `/load?asset=&kind=draft\|published` | 加载草稿或已发布版本 |
| POST | `/save` | 保存草稿 `{asset, document}`（自动盖 template_ref） |
| POST | `/publish` | 发布 `{asset, document, note}`（校验通过才发版；`REQUIRE_PUBLISH_APPROVAL=true` 时入审批队列） |
| GET | `/draft-history?asset=` | 草稿历史 |
| POST | `/draft-restore` | 恢复历史草稿 |
| POST | `/parse-document` | 文档解析（docx/pdf/txt/md/xlsx） |
| POST | `/document-triage` | 文档分诊（模板匹配度评估） |
| POST | `/extract` | 分块 LLM 抽取（长文档自动分块） |
| GET | `/extract-progress?job=` | 抽取进度 |
| POST | `/fill-gaps` | 缺口填充建议 |
| POST | `/resolve-entities` | 实体消歧对齐 |
| POST | `/import` / `/export` | 图谱导入导出（v2.1 兼容） |
| POST | `/intake-excel-to-graph` | 摄入 Excel → 图谱文档 |
| POST | `/graph-to-intake-excel` | 图谱文档 → 摄入 Excel（反向） |
| POST | `/from-tabular` | 结构化表格 → 图谱（CSV/JSON 表头映射，零 LLM 确定性） |
| POST | `/seed` | 种子起步：一键灌入内置数据（org-people 157 人 mock / customer-ecosystem 真实画像），已有版本时返回 already |
| `/builder-agent/*` | 代理 | 代理到 openjiuwen graph-builder-agent（8 技能，对话建图）；`BUILDER_AGENT_URL` 配置目标 |
| POST | `/trial` | 意图试算（向量+词法双通道裁决） |
| POST | `/trial/add-utterance` | 试算补充说法 |
| POST | `/audit` | 质量审计 `{asset, document}`：确定性规则 + LLM 语义审查 |
| POST | `/eval-dataset` | 生成评测数据集 |

### 校验器直用（编程接口）

```js
const { validateGraph } = require('./tools/x6-graph-template-validator');
const template = require('./data/graph-builder-templates/intent-graph.json');
const report = validateGraph(template, graphDocument);   // 参数顺序：template 在前
// report.valid: boolean; report.errors: [{code, path, message}]
```

### 主要错误码（摄入与资产）

| 错误码 | 含义 |
|--------|------|
| `KNOWLEDGE_INTAKE_SHEET_MISSING` | 缺工作表 |
| `KNOWLEDGE_INTAKE_COLUMNS_MISSING` | 缺必需列 |
| `KNOWLEDGE_INTAKE_NOTHING_VALID` | 无合法数据行 |
| `KNOWLEDGE_INTAKE_ITEMS_REQUIRED` | review 未提供 itemIds |
| `KNOWLEDGE_INTAKE_BATCH_NOT_FOUND` | 批次不存在 |
| `ORG_GRAPH_ROUTE_NOT_FOUND` | 路径不存在 |
| `ORG_GRAPH_DOCUMENT_REQUIRED` | publish 缺 document |
| `MISSING_KEY` | 模型 key 未配置（AI 功能） |

---

## Intent Graph — 编辑器与自动建图

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/POST | `/api/intent-graph/*` | 版本列表、schema、加载、校验、创建、导出 |
| POST | `/api/intent-graph-autobuild/*` | 候选、生成、任务、合并（自动建图） |
| POST | `/api/intent-graph/release` | 发布桥接（归 autobuild 路由族） |

---

## Intent RSI — 意图进化 `/api/intent-rsi/*`

> 完整链路、决策模式与设计取舍见 [RSI V2 架构说明](intent-rsi-v2-architecture.md)。本表是端点清单。
> **任务化约定**：所有写请求必须带 `taskId`（query / body）或 `X-RSI-Task-Id` 请求头，否则返回 400「任务写请求必须提供 taskId 或 X-RSI-Task-Id」；且该任务必须已由 `POST /tasks/create` 创建，否则返回 404「任务不存在」。干净 clone 首次 `GET /state` 会自动从种子初始化 `default` 任务。

### 状态与只读查询

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/state` | 全局状态：当前版本、题库切分、基线、目标、策略台账、成绩轨迹、档案、校准状态 |
| GET | `/bases` | 候选底图（种子 / 快照 / 图谱版本清单） |
| GET | `/optimization-capabilities` | 多路径优化能力注册表（targets / methods / defaults / features） |
| GET | `/asset-lineage` | 资产谱系 DAG（bundle 摘要 + parents 边集） |
| GET | `/strategy` | 策略记忆摘要（胜率、算子、失败族、杠杆） |
| GET | `/goal` | 当前达标目标与缺口归因 |
| GET | `/case-review` | 用例复核视图 |
| GET | `/tasks` | 任务列表（含只读的 `park` 参考记录） |
| GET | `/park-history` | 园区引擎调参轨迹 |
| GET | `/run-trace` | 运行轨迹（需带对应 run 参数；无匹配时 404） |
| GET | `/export` | 导出当前任务状态与档案 |

### 评测与提案

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/baseline` | 跑当前基线（spawn `scripts/rsi-engine-score.js`，成绩带引擎指纹） |
| POST | `/propose` | 生成改进提案 |
| POST | `/manual-proposal` | 手工提交提案 |
| POST | `/evaluate-proposal` | 评测单个提案（走四关门禁） |
| POST | `/bundle-evaluate` | 融合候选评测 |
| POST | `/engine-param-search` | 引擎参数候选搜索 |
| POST | `/adopt` | 采纳通过门禁的提案，落版本链 |
| POST | `/reject` | 拒绝提案 |
| POST | `/rollback` | 回滚到历史版本 |
| POST | `/calibrate` | 引擎校准（spawn 校准子进程） |
| POST | `/park-calibrate` | 园区引擎校准 |
| POST | `/reset` | 重置当前任务 |
| POST | `/split-preview` | 题库切分预览 |
| POST | `/gen-cases` | 生成/补充评测题 |
| POST | `/import-snapshot` / `/import-graph-file` / `/import-eval-dataset` | 导入快照、图谱文件、评测题库 |
| POST | `/switch-base` | 切换底图 |

### 自动进化（SSE 长连接，`server.requestTimeout=30min`）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/auto-evolve` | 启动自动进化；`decisionMode` 可为 `rules` / `model` / `agent`；响应 `text/event-stream` |
| POST | `/auto-evolve-resume` | 从断点恢复（带 `runId`） |
| POST | `/auto-evolve-stop` | 请求停止（不因前端断连而自动停止） |
| GET | `/preflight` | 启动前检查 |
| GET | `/candidate-diff` | 候选差异 |
| POST | `/goal-update` | 更新达标目标 |

### 任务管理

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/tasks/create` | 新建任务 `{name, description?, base?}`，返回 task id |
| POST | `/tasks/switch` | 切换活动任务 `{id}` |
| POST | `/tasks/update` | 改名称/说明/归档状态 |
| POST | `/tasks/delete` | 删除任务（`park` 只读任务不可删） |

### Agent 工具桥（供 Python rsi-agent 回读，只读）

| 路径 | 说明 |
|------|------|
| `/agent/weaknesses` | 当前失败族与错题摘要 |
| `/agent/badcases` | 坏例明细 |
| `/agent/search` | 意图检索 |
| `/agent/intent` | 单意图详情 |
| `/agent/probe` | 反事实探针：真应用草案 + 引擎复测 |

> 无运行中的 Agent 代次时工具桥返回 500「Agent 工具桥未开放（无运行中的 Agent 代次）」，属预期降级。

### RSI 侧典型响应与降级

| 场景 | 表现 |
|------|------|
| 未带 taskId 的写请求 | 400 `任务写请求必须提供 taskId 或 X-RSI-Task-Id` |
| 引用不存在的任务 | 404 `任务不存在: <id>` |
| 无模型密钥跑 `/baseline` | 400「模型或召回通道调用失败/降级，本次测量不作为方案收益或无收益的证据」；评分子进程仍能跑完打分，但证据被门禁作废 |
| `rules` 模式未注入 propose 服务 | 400「rules 决策模式需要注入 propose 服务」 |
| 无 Agent 代次访问 `/agent/*` | 500「Agent 工具桥未开放」 |

Python Agent 自身端点（`http://127.0.0.1:18132`）：`/health`、`/v1/skills/{task_type}`、`/v1/rsi/status`、`/v1/rsi/prompt-current`、`/v1/rsi/optimize-prompt`、`/v1/rsi/analyze`、`/v1/rsi/experience/{record,search,recent}`、`/v1/tasks/{propose,attribute}`。
