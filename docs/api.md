# API 参考

基础地址：`http://127.0.0.1:3013`（`PORT` / `HOST` 可改）。前端页面与架构图同样由该服务托管：`/tools/*`、`/docs/*`；根路径 302 到 `/tools/index.html`。
认证：`SKIP_AUTH=true`（默认开发模式）免认证；生产模式带 `Authorization: Bearer <JWT>`。
通用响应：`{ "success": true, "data": ... }` 或 `{ "success": false, "error": { "code", "message" } }`。

## 系统端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/healthz` | 健康检查 `{ok, service, time}` |
| GET | `/docs/*` | 仓库 docs 静态资源 |

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
| POST | `/batches/{id}/merge` | 批次合并 |
| POST | `/batches/{id}/preview-apply` | **预检**：内存合入草稿→真实模板校验，不落盘 |
| POST | `/batches/{id}/apply` | 应用到草稿（自动快照，可回滚） |
| POST | `/batches/{id}/rollback` | 回滚本次 apply |
| GET | `/batches/{id}/revisions` | 修订历史 |

### preview-apply / apply 响应要点

```json
{
  "batchId": "ki-2026xxxx-xxxx",
  "applied": true,
  "saved": true,
  "rollbackable": true,
  "stats": { "aggregatesCreated": 3, "intentsCreated": 1, "edgesCreated": 3, "skipped": [] },
  "validation": { "valid": true, "errors": [] }
}
```

`validation.valid=false` 时 **apply 被阻断**（服务端强制，不信任前端）。

### Excel 格式（三工作表）

| 工作表 | 必填列 |
|--------|--------|
| `1-业务功能分类` | 功能全路径（`父/子` 斜杠分级，需先父后子）、功能名称（=路径末段）、业务描述（≥10字）、客户分类（枚举）、安全分级（L1-L4）、责任部门、状态（启用/停用） |
| `2-意图清单` | 意图名称、所属功能全路径（须已登记）、业务意图类型（查询/办理/管理/咨询/投诉/营销/取消/转账/还款）、业务描述、答案形态（话术答复/数据卡片/跳转办理/转人工）、热度（P0/P1/P2）、状态（草稿/生效/停用）；选填执行模式（read-execute-读执行 等4枚举） |
| `3-说法库` | 意图标识、说法类型、说法文本、来源、状态 |

---

## Org Graph — 图谱资产 `/api/org-graph/*`

> 资产（asset）= 一份模板绑定的图谱实例。内置 13 张模板、五类图谱（意图/组织人力/客户风控/领域知识/通用），全部端点对任何模板通用；上传模板 + 注册即可接入新图谱类型，无专用端点。

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

### 主要错误码

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
