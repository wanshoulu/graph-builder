# 开发与测试指南

## 1. 环境要求

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | ≥ 18（开发验证 22.x） | 唯一硬依赖 |
| Python | 3.x（可选） | 仅重新生成 Excel 模板时需要（openpyxl） |
| 模型 Key | 可选 | 不配也能跑全量测试与离线链路 |

```bash
npm install    # 仅 4 个运行时依赖：xlsx / formidable / jsonwebtoken / mammoth / pdf-parse
npm start      # :3013，浏览器打开 / 或 curl /api/health 自检
```

## 2. 测试（全部离线，不需要任何 API Key）

```bash
# 全量：127 个用例（node:test 内置运行器）
npm test
# 等价：node --test tests/*.test.js

# 契约回归锁（最重要的一组）
npm run test:contract
# tests/knowledge-intake-contract.test.js：
#   正向：摄入合入产物必须 0 校验错误
#   反向：修复前的漂移输出必须仍然报错（防"放宽校验求通过"）
```

测试套件构成：

| 套件 | 覆盖 |
| --- | --- |
| knowledge-intake.test.js | 导入解析、行级校验、评审、修订（自带 tmp 目录，不污染 data/） |
| knowledge-intake-contract.test.js | 模板↔摄入输出契约（双向锁） |
| x6-graph-template-validator.test.js | 校验器三段管线单元 |
| intent-graph-template.test.js | 主模板自洽性 |
| org-graph-*.test.js（5 个） | 资产解析、分块、文档分诊、草稿历史、抽取续跑 |

## 3. 代码放在哪

分层纪律：**routes → services → tools → data，禁止反向依赖**；tools 之间允许横向引用，但必须零路由依赖、`node --test` 可直测。

| 你要改的东西 | 位置 |
| --- | --- |
| 校验规则（枚举、条件必填） | **不是代码**——改 `data/graph-builder-templates/*.json` + 同步契约测试 |
| 新增端点（摄入域） | routes/knowledge-intake.js（该域 HTTP 适配收口） |
| 新增端点（资产域） | routes/org-graph.js |
| 可复用算法/工具 | tools/ 新文件 + 同名 .test.js |
| Excel 模板结构 | docs/gen_excel_template.py → 重新生成 xlsx |
| API 文档 | docs/api.md（端点/列定义/错误码与代码同步是契约纪律，见架构文档 §8） |

## 4. 加一张自己的图谱资产（零代码路径）

**前置认知：这套工具不限于意图图谱。** 仓库内置的 13 张模板覆盖意图、组织人力、客户风控、领域知识、通用底座五类——你的图谱类型（供应链、医疗、设备台账、法规条款……）同理，写一份模板就接入，校验、草稿、版本、发布、审计全复用。注意 `node_types` 里的字段用 `fields` 数组（`{key, label, type, required, default}`，type 支持 string/multiline/tags 等），与 `edge_types` 的 `source_types/target_types` 一起构成校验白名单。抄哪张：要树形骨架抄 `intent-graph-v4.json`，要平面对象关系网抄 `org-people.json`，要从零探索抄 `blank-property-graph.json`。

1. 写模板 JSON 放入 `data/graph-builder-templates/`：`template_id` / `node_types`（含各类型 fields 契约）/ `edge_types` / `metadata.conditional_requirements`（条件必填，可先空）/ `starter_graph`（可为空对象起步）。
2. 在 `data/graph-assets-registry.json` 登记一行：资产 ID → 模板路径 → 草稿路径。
3. `node --test tests/intent-graph-template.test.js` 抄一个模板自洽性用例验证新模板。
4. 完成度自检：`GET /api/org-graph/assets` 能列出新资产 → `/template` 能出元数据 → 空图 save 通过校验 → 从种子或导入开始演进。

需要写代码的只有一种情况：校验引擎缺能力（新字段类型、新条件算子）——改 `tools/x6-graph-template-validator.js` 并补双侧测试。

## 5. 已知工程注意点

- **NUL 字节**：routes/knowledge-intake.js 含 `\x00` 分隔符（rowId 防碰撞，刻意设计）——grep 需 `-a`，**禁用文本工具重写该文件**（会静默损坏分隔符）。
- **validateGraph 参数顺序**：`(template, graph)`——template 在前，与直觉相反（架构文档 §6.1 有标注）。
- **行尾**：仓库无 .gitattributes 强制，Windows 下 CRLF 警告无害；提交前不必处理。
- **测试隔离**：knowledge-intake.test.js 自建 tmp 目录；其余用例只读 data/，不会弄脏仓库状态——跑完测试 `git status` 应保持干净。
