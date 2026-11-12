# RSI 易用性整理与概览改版 · 2026-10-27

## 用户应当先看到什么

原概览把正式版本成绩、历史活动、业务拆解、引擎比较、候选 DAG、代际直方图与操作入口同时铺开。虽然能力齐全，却要求用户先理解实验机制，才能判断任务状态。此次按决策顺序重新组织，已部署至用户访问的 `localhost:17386`。

1. **现在效果怎样、是否可信。** 当前有效完全正确率、目标与评测范围；历史成绩失效时明确显示“待重测”。
2. **最近发生了什么。** 最新一次运行状态、采纳结果和对应详情入口；“未采纳新版本”不等于断言所有候选均无提升。
3. **接下来做什么。** 根据运行状态、题目准备、成绩有效性和待审阅方案给出一个主操作。概览页隐藏顶部竞争操作。

该任务当前显示“待重测”，历史参考 100.0%，最近一次运行“已结束 / 未采纳新版本”，17 道封存题尚未独立验收。这些事实不能混写成“当前已达到 100% 并验收通过”。

曲线、同引擎对照、资产×引擎矩阵、分题型与分业务表现、候选 DAG、代际直方图全部保留在“查看效果与演进分析”，默认关闭，打开后才挂载和请求业务证据。历史明细与累计活动继续按需展开。导航调整为：概览 → 评测题目 → 优化运行 → 方案审阅 → 成绩与交付 → 设置，原 URL 参数保持兼容。

实际巡查其他页签后，进一步收起了四类补充内容：运行页的累计用量与系统日志；方案页重复铺开的错误归因/建议卡片；可选的提案指令优化；题目页的模型自查与引擎对照。主流程、证据过期提示、采纳限制和运行降级提示继续直接显示。补充内容仅在打开时挂载，关闭不影响后台任务或父层轮询。

## 部署与实测

- 90 项相关前端测试通过，包含补充区打开前不挂载子组件的检查。`npx tsc -b` 与生产构建通过。独立代码复核未发现重要新增回归。
- 已部署到 nginx 实际 SPA 目录及根目录；最终 HTTP 页面入口为 `index-CTW1JY2b.js`。
- 最终 17386 浏览器实测默认概览可见约 1.677 秒。这是单次本地测量，不是延迟保证。
- 实际浏览器确认默认未挂载复杂分析、未请求业务详情；展开后保留十次历史实测，历史 v4/E1 的 77.5% 与最新历史 100% 没有混淆，矩阵与题型联动正常。
- “查看本次运行”保留精确 runId。1500px 桌面、800px 平板、390px 手机没有整体横向溢出；已查看默认与展开截图，无页面脚本错误。
- 最终巡查五个业务页签；题目/运行/方案页补充区默认不挂载，打开与关闭均可用，未发生脚本错误或写操作；逐题表实际显示 71 道训练/验证题，17 道终测保持封存。
- 本轮没有运行模型优化、付费评测或最终验收，没有改任务数据。未以界面改版代替精度提升实验。

证据归档：`reports/intent-rsi-usability-20261027/`。

## 仍需继续改进的范围

本次整理概览、运行、方案和题目页的展示层级，不能据此宣称整套 RSI 已没有问题。设置及展开的分析仍有较多实验细节；后续应围绕“失败依据 → 修改内容 → 同条件复测 → 采纳/淘汰原因”继续贯通，并以实际使用验证。引擎与资产可同时进化，收益解释必须保留评测上下文，不能把跨引擎观察到的涨分全部算作图谱贡献。当前泛化与稳定性仍需封存测试和重复实验来证明。

当前“按需”指组件挂载和业务证据请求，图表模块仍是静态导入，并未进一步拆分下载。构建仍提示较大公共分包；弱网络首次加载还有优化空间。

以下保留设计与实现说明。

The task overview should help a user decide what to do next without first interpreting the complete experiment history. The requested curves, business breakdowns and candidate lineage remain available.

## Design

- The default page answers three questions: what is the current recognition effect, what happened in the latest optimization, and what is the recommended next action.
- Current score validity comes from the existing `baselineCurrent` contract. Expired scores show “待重测”. Historical reference scores and independent acceptance records remain separate from that current result.
- The latest run uses the newest saved run, with the active checkpoint taking precedence for the same run ID. No adoption is described as “未采纳新版本”; it is not used to infer that no candidate ever improved.
- “查看效果与演进分析” opens the original joint asset/engine curve, same-engine comparison, measured combination matrix, synchronized type performance, business performance, candidate DAG and generation histogram. These components mount only after opening, so business evidence is not requested on the default page. Closing unmounts the analysis.
- The historical version table and adoption record remain a second disclosure within analysis. Cumulative task activity is a compact, separately expandable summary.
- Tabs follow the work order: overview, questions, optimization runs, proposal review, results/delivery, settings. Existing URL section keys are unchanged. The overview’s global header action is hidden so its single recommendation has clear priority. Exact-run drill-down continues through `onRun`.

The visual treatment extends the existing blue/slate interface: white content, #182b41 primary text, #526477 supporting text, #2878bb actions and #e0e7ef dividers. Desktop places current effect and latest result side by side; phone layouts stack them, with the primary action spanning the available width. The decision area remains quiet; charts are available on demand.

## Alternatives considered

Keeping every chart on the initial page preserved immediate visibility but retained the reading and loading burden. Splitting charts into new routes would increase navigation and require broader workflow changes. A single explicit analysis disclosure preserves existing capability with a smaller, reviewable change.

## Verification

- A new SSR regression failed against the former overview because it did not present the latest optimization answer. It now verifies stale current score versus historical 100%, the next measurement action, 17 sealed questions, closed analysis and absence of mounted chart sections.
- Existing real-component SSR coverage now targets the exported analysis component, retaining assertions for engine/asset evidence boundaries, old comparable readings, missing type coverage, business section and the experiment workspace.
- 29 focused overview/evidence/evolution tests passed. `tsc --noEmit --pretty false` passed. The integrating agent owns the full suite, production build and deployed QA.
- Read-only dev browser review at 1500 and 390 px found no page errors or horizontal page overflow. Default and expanded screenshots were inspected. No business request occurred before expanding. Development StrictMode caused the expected repeated effect after expansion.

Artifacts: `D:/project/Trae/artifacts/rsi-usability-20261027/dev-{desktop,mobile,analysis-desktop,analysis-mobile}.png`, `dev-review.json`, and `dev-preview.cjs`.

No task data was changed and no model operation or final exam was run. The sealed test set remains outside optimization.
