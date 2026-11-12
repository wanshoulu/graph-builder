# 意图 RSI 工具体检报告

- 审视对象：`http://localhost:17386/ontomind/knowledge/graph/intent-rsi`（OntoMind / ai-harbor）
- 代码位置：`D:\project\vscode\routes\intent-rsi.js`、`rsi-production-runtime.js`、`rsi-optimization.js`、`rsi-reasoning.js`、`rsi-runtime-profile.js`、`services/rsi-agent/**`
- 数据位置：`data/rsi/tasks/legacy-bank-20261016/`
- 审视时间：2026-10-19
- 审视目的：不是评价 UI 与工程完备度，而是回答一个问题——**这套闭环能不能把意图识别精度刷到目标值**

---

## 0. 结论

**当前这套工具不可能达成"精度提升达标"，而且原因不是模型不够强，是三处结构性缺陷：目标没有定义、动作空间覆盖不到主要误差、门禁在数学上不可满足。**

五条硬结论（每条都有下文证据）：

1. **没有"达标"这个概念。** 后端没有任何 target / 验收阈值字段，停止条件是"连续 N 轮无提升"，不是"达到 X%"。工具能回答"这轮涨没涨"，不能回答"够不够"。
2. **门禁不可满足。** 晋升要求 train/heldout 的严格率、部分得分率、4 种题型各自的这两项指标**全部不退步**（实测最多 20 个维度），外加回归题逐题必须正确。而同一份资产重测一次就有 5/71 道题翻转。这个门禁筛的不是"更好"，是"运气"。
3. **动作空间对不上错因。** 22 个失败里 16 个（73%）是澄清机制问题（多给选项 / 不该澄清 / 该澄清没澄清），只有 6 个是声明层能修的识别问题。A1–A5 五个算子最多把这 6 题修好，上限 77.5%，够不到常见的 80/85% 目标。
4. **实测零提升。** 当前生产口径下 8 次运行、8 个完整测量候选：**0 个提升，6 个与基线一模一样，2 个更低，0 个采纳**。唯一被采纳的 v2 来自 10-14 的旧协议（protoRev 2）+ 已废弃算子 `A9_scope_expand`。
5. **规划大脑 0 产出。** model 模式 12 轮全部 `decision_error`（0 个候选进入评测）；agent 模式 6 轮只有 1 轮提交了 2 个提案，0 个进入测量。SKILL 里授权了 A6/A7/A8，Node 侧只认 A1–A5——结构性冲突。

一句话：**这轮闭环目前的产出是"噪声测量 + 不可满足的门禁 + 打不到痛点的动作"，跑得越久，越会得出"图谱写不动了"的错误结论。**

---

## 1. 实测状态

任务 `legacy-bank-20261016`：40 个意图，88 道题（单意图 45 / 多意图 23 / 模糊 20），切分 53 / 18 / 17。

基线（已存档，`engineMode=online+decl`，`protoRev=3`）：

| 口径 | 完全正确率 | 部分得分率 |
|---|---|---|
| train（53） | 67.9% | 87.0% |
| heldout（18） | 72.2% | 87.3% |
| all（71） | 69.0% | 87.1% |
| test（17） | **从未跑过**（`finalExam=null`） | — |

按题型：单意图 88.9%、多意图 73.7%、模糊 25.0%（train 侧）。22 道错题的分布：

| 结果类型 | 数量 | 归属 |
|---|---|---|
| `clarify_extra_options`（澄清选项多给了） | 8 | 澄清机制 |
| `unexpected_clarification`（多意图被多余澄清） | 4 | 澄清机制 |
| `clarify_not_triggered`（该澄清没澄清） | 4 | 澄清机制 |
| `rank_error`（期望意图在榜非第一） | 2 | 声明层可修 |
| `multi_missing` | 1 | 声明层可修 |
| `clarify_missing_expected`（候选缺期望意图） | 2 | 边界情况 |
| `clarify_ok_set`（单意图被澄清） | 1 | 边界情况 |

运行记录（排除 10-16 那次旧引擎的 `run_3gen_multi_path`）：

| 模式 | 运行数 | 轮次 | 完整测量候选 | 提升 | 采纳 |
|---|---|---|---|---|---|
| 规则（reflective_search） | 2 | 6 | 8 | 0 | 0 |
| model（模型规划） | 4 | 12 | 0 | 0 | 0 |
| agent（openJiuwen） | 2 | 6 | 0 | 0 | 0 |

8 个完整测量候选的明细：**6 个与基线完全相同（67.9 / 72.2），2 个更低（66.0、64.2）**。另外 22 个分支里 11 个是 `duplicate`（同资产指纹重复），2 个 `eval_error`，4 个是只做探针的诊断分支。

---

## 2. P0 问题

### P0-1 目标未定义：没有"达标"，只有"别退步"

**证据**
- `routes/rsi-production-runtime.js` 全文无 target / threshold / acceptance 字段；任务创建接口只收 `trainRatio / testRatio / seed`。
- `web/src/pages/IntentRsiEvolution/rsiGoalTemplates.ts` 明确写着"不在此处生成验收阈值数字：阈值属于业务决策"，模板只推荐算子白名单。
- 停止条件：`noGain >= config.noImproveRounds`；`run.status` 只有 `no_adopt / awaiting_human / stopped / error`。

**后果**
运行结束时，人和系统都无法回答"我们现在离目标差多少、还差在哪几类题、下一步该动什么"。工具优化的是"任意一个不退步的改善"，+1 题（1.4 个百分点）和 +10 题等价。目标导向的闭环必须由目标驱动停止与决策，现在由"连续没涨"驱动。

**修法**
任务增加 `goal: { metric: 'strict_pct', target: 85, split: 'all', ci: 95, minEffect: 3 }`；预检时计算 `gap = target - current`，并输出"缺口归因"（按 resultType × 题型 × 意图的三维分解）；运行结束条件改为 `达到目标 + 独立终测通过` 或 `预算耗尽`；未达标时给出"哪些缺口不在当前动作空间内"的显式结论。

---

### P0-2 门禁不可满足：20 维全不退 + 单题否决 + 噪声

**证据 1：门禁定义**

`rsi-production-runtime.js: 20-24, 25-39`
```js
trainVector = [train.strict, train.relaxed, ...4 种题型的 strict/relaxed]   // 10 维
trainingBetter = b.every(v >= a[i]) && b.some(v > a[i])
gateCandidate: train 与 heldout 各 10 维全部 >= 基线；任一维下降即 gated
               + 回归保护集中的每一道题必须 strict
```

**证据 2：回归集里有一道基线就失败的题**

`regression = {rsi_t014, rsi_t214}`；基线结果里 `rsi_t214` 是 `strict=false`（`clarify_extra_options`）。
`gateCandidate` 对这题的要求是 `byId.get('rsi_t214').strict === true`。

于是 8 次运行里有 6 个分支的门禁原因是同一句：`回归保护未覆盖或失败：rsi_t214`（b1/b2/b3/b5/b12 等）。**不是候选不好，是一道在基线就错的题拥有永久否决权。** 而且这题的行为本身不稳定：存档基线是 `clarify_extra_options`，我复测时变成 `clarify_not_triggered`。

**证据 3：同资产重测，5/71 道题翻转**

同一图谱（v2）、同一引擎指纹（`e89ffe7a4b3a`）、同一题库，两次测量：

| 指标 | 存档基线 | 本次复测 |
|---|---|---|
| all strict | 69.0% | 67.6% |
| all relaxed | 87.1% | 84.8% |
| 逐题翻转 | — | **5 道**（t122、t201、t202、t219、t214） |

其中 t122 在 `unexpected_clarification` 与 `correct` 之间来回跳，t201/t202 在 `correct` 与 `clarify_extra_options` 之间跳。

**后果**
- 门禁的"某题型退化"判定会被噪声触发。多意图只有 19 题，一题翻转就是 5.3 个百分点，足以让一个真实改善被判死。
- 反过来，一个纯运气的候选也能靠"恰好没有题型掉分"通过。所谓"验证集只守不退"，在单次点估计下既拦不住坏候选，也放不过好候选。
- 整个循环的有效样本量不是 71，而是"一次测量"；再加 20 维全序约束，通过概率接近零。

**修法**
1. 门禁降为"主指标 + 非劣界"：主指标（目标题型或整体 strict）要求提升 ≥ MDE（最小可检测效应），其余题型允许有界回退（如 relaxed 不降超过 2 个 MDE），不做 10 维逐项硬约束。
2. 每份候选测量 2–3 次取均值，或用固定裁决样本集做配对比较（同一批题、同一次运行内 A/B），报告差值置信区间。
3. 回归集必须"基线全绿"才能启用；基线失败的题进 `quarantine`，不得担任否决项。引擎指纹变化时回归集整体重新定基线（现在 protoRev 从 2 跳到 3，回归集没有跟着重定）。
4. 给 `rsi_t214` 这类题定性：如果"多给一个合理选项"不该算错，就应该改评分口径（见 P1-4），而不是让它当门禁。

---

### P0-3 动作空间覆盖不到 73% 的误差

**证据 1：代码**
`validateProposal` / `applyProposal` 只实现 A1（补说法）、A2（补区分线索）、A3（补子句说法）、A4（改描述）、A5（补澄清文案）。A5 在引擎侧只替换"已经触发的澄清"的问题文案（`rsi-runtime-profile.js: consumeGraphClarificationQuestions`），**不控制是否触发、也不控制候选集**。

**证据 2：受控实验（本次实跑，非推断）**

取 train 侧 12 道模糊题，同一图谱，只改 `meta.rsi_runtime.engine`，用生产引擎打分（命令见第 5 节）：

| 配置 | strict | relaxed | 说明 |
|---|---|---|---|
| 基线（无 runtime 覆盖） | 8.3%（1/12） | 33.2% | 与存档 25% 的差异来自噪声，见 P0-2 |
| `clarificationLimit=3` | 8.3% | 33.2% | **单独调无效** |
| `graphClusterFirst=true, limit=6` | 25.0%（3/12） | 49.7% | +2 题 |
| `graphClusterFirst=true, limit=3` | **33.3%（4/12）** | **46.8%** | **+3 题，+25 个百分点** |

也就是说：占误差 36% 的"多给选项"，**是可以修的，但唯一的有效杠杆是 `graphClusterFirst` 打开 + 限制候选数**，而它既不是图谱算子，当前参数搜索也不会去试这个组合（见 P1-2）。

**证据 3：全量 71 题验证这个杠杆的代价**

| 配置 | all strict | all relaxed | 多意图 |
|---|---|---|---|
| 基线 | 67.6% | 84.8% | t115、t122 正确 |
| clusterFirst+limit3 | 69.0% | 87.3% | **t115、t122 变成错误**（+3 模糊 −2 多意图） |

净 +1 题，但多意图题型掉 2 题 → 按现在的门禁会被判"题型退化"直接拦掉。

**后果**
工具不是"没找到方案"，是**它的动作空间里根本没有能覆盖主要误差的操作**；唯一的有效杠杆被当成一个顺带翻转的布尔值，而且它带来的权衡会被"20 维全不退"的规则判死。这是目标导向最重要的一条：**先让动作空间对上误差分布，再谈搜索。**

**修法**
- 把"澄清策略"升为一等动作：`graphClusterFirst`、`clarificationLimit`、候选裁剪规则（按 scope_in 命中数/分差阈值裁剪），并允许二维联合搜索，而不是坐标下降单参数。
- 把 4 类澄清错因显式建模：`trigger`（该不该澄清）、`coverage`（期望意图在不在选项里）、`precision`（多给了几个）、`wording`（问题文案）。每一类对应一个机制和一组可调参数。
- 承认"label_suspect / mechanism_limit"族不可修（SKILL 里已经有这两个词，但 runtime 没接线），把它们从优化目标里排除，避免拉低整体数字也避免误导搜索。

---

### P0-4 验证集无法证伪"记忆化"，锚定规则还在奖励它

**证据 1：验证集覆盖不足**

| 项 | 数值 |
|---|---|
| train 出现的意图 | 38 |
| heldout 出现的意图 | 25 |
| heldout 覆盖 ≥2 题的意图 | **5** |
| train 有、heldout 完全没有的意图 | **14（37%）** |
| test 覆盖的 train 意图 | 17 |

**证据 2：校验器强制"贴着坏例改"**

`intent-rsi.js: 920-936`：
```js
// 非对称 precision：变体 bigram 有多少来自坏例评分单元
units.push({ set: bigrams(clause), th: 0.6 })   // 多意图
units.push({ set: bigrams(query), th: 0.55 })   // 其余
// 至少一条增补表达 precision ≥ 阈值，否则拒绝提案
```
prompt 里写着"禁止逐字照抄测试用例原文"，校验器却要求新增说法的 bigram 有 55%–60% 直接来自那道坏例。**规则在奖励记忆化。**

**后果**
对一个在 heldout 里没有题的意图（14 个），A1 贴着 train 坏例加一句说法，heldout 完全无感，"验证集不退步"自动成立 → 候选可以合法晋升，分数上涨，但只是把那一道题背下来了。这不是假设：`rsi_t214` 的 A9 `add_scope_in:["绿色"]` 就是这么修的，而它今天依然是错的。

**修法**
1. 切分改为**按意图分层**：每个意图至少 1 题进 heldout、至少 2 题留在 train；做不到就缩小意图范围或补题，而不是硬切。
2. 加一个"未见说法"集：同一意图的、措辞与图谱已有说法明显不同的题，只用于验收，不参与优化。
3. 用 leave-one-case-out 估计泛化：对每个被修的题，看同意图其他题是否也涨。
4. 锚定规则改成"覆盖簇"而非单句：允许同义改写，但要求新增说法与**同意图其他题**的相似度也不能太低，避免只对单题生效。

---

## 3. P1 问题

### P1-1 单次点估计，没有噪声模型
- 引擎 `engineMode=online+decl`：规则召回 + embedding + LLM 裁决三路融合，裁决 `temperature=0` 但仍然会变（同一 query、同一图谱，t122 在两次运行间翻转）。
- 只有 `semantic_boundaries` 有缓存，且缓存键是 `model + query`，**不含图谱**：同一 query 的语义边界在第一次运行时被固化，后续图谱变异对它无效。
- 没有重复测量、没有置信区间、没有 MDE 概念；`performance` 只记录耗时和 token。
- 后果：所有"提升/回退"结论都是单次抽样的点估计。71 题、1 题 = 1.4 个百分点，噪声 1–2 题，与要检测的效应同量级。
- 修法：候选评测做配对重复（同批题、同一进程内 A/B 交替），报告差值 + 95% CI；把 MDE 写进门禁（例如"提升 <3 个百分点视为未观测到效应"）。

### P1-2 搜索效率与预算被浪费
- 每次候选全量 71 题，p50 3.98s/题、mean 4.7s/题、并发 1–2 → 单次评测约 2.5–3 分钟；60 分钟预算 ≈ 20 次。实测 8 次运行只测了 8 个候选。
- `probeIds` 硬限制"最多 8 道训练题"（`rsi-production-runtime.js: 99`），引擎本身是逐题独立打分，本来可以只重算受影响的题集，这条限制把局部搜索的路堵死了。
- **11/22 个分支是 `duplicate`**：模型反复给出同一份改动，白烧评测。
- **`optimizer_prompt` 候选跑了完整评测**（b3/b4/b12 等，结果 67.9 = 基线）：`optimizerPrompt` 只被提案器读取，引擎根本不消费，这类候选在规则模式下应当 `search_only`（模型模式已经这么做了，规则模式漏了）。
- 修法：受影响题集局部重评 + 通过后再全量；`optimizer_prompt` 强制不进评测；duplicate 在提案阶段用内容指纹去重（现在只按完整资产哈希，改一个字段也算新资产）。

### P1-3 规划大脑 0 产出（契约过严 + 无降级）
- model 模式 12 轮：11 轮 `decision_error`，1 轮 `probe_only`。报错集中在：`正确对照必须来自已正确的训练样本`（3 次）、`实验改动路径未授权`、`识别组件无效`、`引擎参数不合法：clarificationLimit / lexicalWeight`。
- agent 模式 6 轮：1 轮 8 次工具调用全部成功但**提交 0 个提案**；1 轮提交 2 个提案，0 个进入测量；其余轮次 `fetch failed`（rsi-agent 容器不可用）。
- **SKILL 与 runtime 契约冲突**：`services/rsi-agent/skills/proposal/SKILL.prompt` 授权 A6/A7/A8（新增意图/合并意图/改关系边），`rsi-reasoning.js` 的 `GRAPH_OPS` 只有 A1–A5。agent 照 SKILL 产出，Node 侧以"模型返回未授权图谱算子"拒绝。
- **空提案被当成合法决策**：`agentGeneration` 里 `proposals.length===0` → `decision.action='stop'`，运行记为 `no_mutations` → `no_adopt`。工具失败（如刚才的 500）与"真的没得改"在记录里不可区分。
- **`probe_query` 的 op 不做校验**：实测 agent 传了 `op:'A1'`（不是 `A1_utterance_expand`），`applyProposal` 未匹配任何算子 → 返回原图 → 探针永远 `improved=false`。反事实验证这一步等于空转。
- 修法：把计划契约从"自然语言 + 校验器"改成"给模型的 JSON Schema + 可选值清单"；SKILL 与 runtime 用同一份算子清单（删 A6–A8 或实现它们）；空提案必须带原因码并区分 `no_improvement / tool_failure / contract_mismatch`；`probe` 对未知算子直接报错而不是静默返回原图。

### P1-4 评分口径本身把"合理行为"判成错
- `ambiguous_intent` 的 strict 判定：`coverage===1 && !excessive && answerable`，其中 `excessive` 的默认阈值是 `max_extra_options=0`、`min_precision=1`（`rsi-case-scoring.js: 222-233`）。
- 而题库里 **20/20 道模糊题都没有 `expected_clarification`**，全部走默认值 → "选项集合必须与 gold 完全相等，多给一个就错"。
- 这些 gold 的选项集来自 LLM 出题（任务日志：`LLM 出题 89，校验通过 58`），不是业务确权的结果。
- 后果：8 道 `clarify_extra_options` 里有相当一部分是"多给了一个业务上也说得通的选项"，被当成精度损失。目标值本身定义在一个可疑口径上。
- 修法：把 coverage 与 precision 拆成两个独立指标（`选项覆盖率` / `选项冗余率`），各自设阈值；重要题型由业务确权 gold；在 UI 上把"识别错误"与"澄清选项冗余"分开报，不要合成一个 strict_pct。

### P1-5 辅助工具口径漂移（会误导人工验证）
- `rsi-engine-score.js` 只设置 `INTENT_GRAPH_PATH`，不设置 `INTENT_RSI_RUNTIME_GRAPH`；而引擎的运行时参数与提示词变体只从后者加载。
- `rsi-engine-calibrate.js`、`rsi-engine-probe.js`、`rsi-engine-attribute.js` 同样不设。
- 实测：不设该变量时，四种不同引擎参数配置得到**完全相同**的结果（8.3% / 33.2%），因为参数根本没被加载。
- 后果：任何用命令行脚本做的复核、对照、calibrate 报告，都在用"默认参数"跑，与门禁口径不一致。人工一看脚本说"改了参数没效果"，会得出错误结论。
- 修法：`rsi-engine-score.js` 从 `--graph` 自动推导并设置 `INTENT_RSI_RUNTIME_GRAPH`；或把运行时剖面作为显式参数传入并在报告里回显 `runtimeProfileSha`。

### P1-6 历史成绩与采纳结论的时效
- `scoreHistory` 里 47.9%（deterministic）→ 69.0%（online+decl）并列展示，虽然有 `engineRev` 标记不可比，但"从 47.9 提到 69"的叙事很容易被当成进化成果。
- 已采纳的 v2 是 protoRev 2 时代用 `A9_scope_expand` 晋升的；`A9` 现在连算子表都不在。引擎升级后 v2 的 69% 与当时的 77.4% 不是同一件事，但版本记录里没有失效标记。
- 17 道 test 题封存至今从未开考（`finalExam=null`）。所有"变好"的结论都没有未污染数字兜底。

---

## 4. 目标导向的改造顺序

不要先改模型、先加算子。按下面四步，每步都有可验收的完成标准。

**第 1 步：定义"达标"（半天，纯配置 + 一个接口）**
- 任务增加 `goal`，预检输出缺口分解；运行结束输出"达标 / 未达标（缺口 N 题，其中 X 题不在当前动作空间）"。
- 验收：对 legacy 任务，系统能自动说出"目标 85%，当前 69%，缺 12 题；其中 16 题属澄清机制，6 题属声明层"。

**第 2 步：把门禁从"全序约束"改成"假设检验"（1–2 天）**
- 主指标 + MDE + 有界回退 + 回归集基线全绿才生效 + 基线失败题进 quarantine。
- 每次候选做配对重复，报告 CI。
- 验收：用同一份资产当"假候选"跑门禁，**必须判为"未观测到提升"**（现在会因噪声随机给出结论）；用已知有效的 cluster3 跑，**必须放行并标记多意图回退在允许范围内**。

**第 3 步：动作空间对齐错因（2–3 天）**
- 澄清策略升为一等动作（trigger / coverage / precision / wording 四类），支持 `graphClusterFirst × clarificationLimit` 联合搜索。
- 参数搜索改成"二维小网格 + 受影响的 12 道模糊题局部评测"，而不是全量 71 题。
- 验收：在 12 道模糊题上把 strict 从 8.3% 提到 ≥33%，且多意图回退 ≤1 题；全量 strict 提升 ≥3 个百分点。

**第 4 步：让验证集能证伪（1 天 + 补题时间）**
- 按意图分层切分；heldout 每意图 ≥2；加"未见说法"验收集；LOCO 泛化检查。
- 验收：随机抽 10 个被修的题，同意图其他题的平均提升 ≥ 单题提升的一半（否则判定为记忆化）。

**第 5 步（可选但重要）：补独立终测**
- 17 道 test 用起来，在采纳后、导出前跑一次；把它写进"达标"判定，而不是可选按钮。

---

## 5. 复现方式

本次审视用到的关键命令（在 ai-harbor 容器内跑生产引擎，与门禁同口径）：

```bash
# 从任务里切出 12 道 train 模糊题 + 4 组 runtime 配置的图谱副本
docker exec -e INTENT_ENGINE_CONSUME_DECLARATIONS=1 ai-harbor sh -c '
  cd /app &&
  INTENT_RSI_RUNTIME_GRAPH=/app/data/rsi/drafts/g-cluster3.json \
  node scripts/rsi-engine-score.js \
    --graph=/app/data/rsi/drafts/g-cluster3.json \
    --cases=drafts/amb12.json \
    --out=/app/data/rsi/drafts/out-cluster3.json --concurrency=2'
```

注意两个环境变量必须同时给：`INTENT_ENGINE_CONSUME_DECLARATIONS=1` 决定是否消费声明，`INTENT_RSI_RUNTIME_GRAPH` 决定是否加载参数/提示词。只给前者会让所有参数配置看起来"无效"。

`engineParams` 变体：`{}`、`{clarificationLimit:3}`、`{graphClusterFirst:true,clarificationLimit:6}`、`{graphClusterFirst:true,clarificationLimit:3}`。

---

## 6. 诚实边界

- 第 2 节的 8 个候选、第 3 节的 12 题受控实验，都是**单次测量**。按本报告自己的结论（P0-2），单次结果不能当作定论；cluster3 的 +3 题需要在重复测量 + 全量 heldout 上复核。
- "声明层最多 +6 题（77.5%）"是按 22 个失败题的结果类型静态归类得到的上界，实际可能更少（有的题需要同时改机制和声明）。
- model / agent 模式的 0 产出与当时的容器状态有关（存在 `fetch failed`），但契约冲突（SKILL A6–A8 vs runtime A1–A5）与空提案语义问题是代码事实，与容器状态无关。
- 本报告没有评估 UI 的交互质量，只把它当作结论呈现层看：UI 本身的诚实度是够的（明确标注"未跑最终验收"、"证据不足"），问题在后端方法论。

---

## 7. 修复记录（2026-10-19 当日落地）

按第 5 节顺序改了判定层，未改引擎本身。新增 `routes/rsi-goal.js`（281 行）+ 9 个文件改动，全量测试 320 项通过。

### 7.1 达标定义与缺口归因
- `goal{metric,target,minEffect,alpha}` 进任务状态（旧任务加载时补默认 85%），新增 `GET/POST /api/intent-rsi/goal`。
- 预检与状态接口输出：`当前 69.0%（49/71）｜差 12 题/16.0pp｜现有动作空间估算上限 77.2%（可拿回约 6 题）`，附 `byShape` / `byFamily` 归因。
- 回收率取自第 3 节实测（澄清类 0.25），不是拍脑袋：明细见 `FAMILY_FIX`。
- 达标即停：冠军 `all.strict_pct ≥ target` 时 `stopReason='goal_reached'`，不再空烧预算。

### 7.2 门禁 v2
- 主指标：训练 `strict_pct` 净增，且满足「≥ minEffect(3pp)」或「McNemar 配对 p<0.05 且净修题>0」。
- 有界回退：验证集 1 题容差；题型最多 2 题且 ≤20%（1–2 题的题型零容差）；部分得分率 2pp。
- 回归保护只强制「基线就通过」的题，基线失败题 quarantine（本任务 `rsi_t214`），不再一票否决。
- 门禁理由带数字：`未观测到可靠提升：训练 +1.9pp 未达判定门槛（配对 1 修 / 0 破，p=1；要求 ≥3.0pp 或 p<0.05）`。
- 判定逻辑单测覆盖：同资产重测必须 `no_effect`、跨引擎 `invalid`、回归破坏 `regressed`。

### 7.3 动作空间
- 澄清策略二维网格：`graphClusterFirst × clarificationLimit ∈ {3,4,5,6,8,12}`，实测最优组合 `(true,3)` 排第一；每代候选 4 个（原 2 个）。
- 网格点与一维参数 1:1 交替，避免一维参数永久排队。
- 规则模式下 `optimizer_prompt` 标为 `search_only`，不再白烧一次完整评测、不再顶替冠军。
- 提案字段归一化：`A1/补充说法/intent_id/意图` 等别名统一；缺 target 报明确错误（此前 `目标意图不存在: ` 空值无法定位）。
- 图谱提示词加 JSON 示例与「失败类型 → 算子」映射；实测提案从 0 个可用变为 2 个可用（A1/A2 均进入完整评测）。

### 7.4 数据切分
- 仓内按意图可覆盖优先：先挑能带来新意图的题进验证/终测（贪心集覆盖），题型比例与总数不变。
- `split-preview` 新增 `coverage{intents,heldoutIntents,missingInHeldout,singleCaseIntents,advice}`，预检告警写明「14/38 个训练意图在验证集无题」。
- 本任务 88 题、heldout 18 席，覆盖 25 个意图——已是该规模的上限；要达到每意图 ≥2 题需扩题，代码不再假装能靠切分解决。

### 7.5 静默失效
- `rsi-engine-score.js` / `rsi-engine-calibrate.js` 默认 `INTENT_RSI_RUNTIME_GRAPH=本次 --graph`，命令行复核不再忽略图谱参数。

### 7.6 实测复核（同一任务，改动后）
- 参数搜索 2 代 8 候选：全部 gated。`(true,3)` 训练 67.9% 不变且破坏 `rsi_t014`；`hintWeight` 系列 0 变化；两个 1 修 0 破的候选因 +1.9pp < 3pp 被判 `no_effect`。
- 图谱搜索：A1（补说法）/ A2（区分线索）各 1 个候选进入完整评测，训练均 −1.9pp，被门禁拒绝。
- 结论：**判定层已可信，动作空间仍是天花板**。第 3 节的 cluster3 优势只在 12 题子集成立，全量 71 题净变化为 0。

### 7.7 仍未解决（需要产品决策）
1. 85% 在现有动作空间内不可达（估算上限 77.2%）。5/13 的模糊题失败是「该澄清没触发」，需要同时对多个意图补说法；A1 单目标结构改不动，建议新增 A6「歧义簇扩展」（一次向多个 intent 加同一说法）。
2. 8/13 是「选项过多」，需要引擎侧按候选簇精度收敛选项，参数层无杠杆。
3. heldout 覆盖受题库规模限制，需补题到每意图 ≥2。

---

## 8. 策略层升级（2026-10-19 下午）：让工具越用越会改

第 7 节只修了判定层——门禁不再放水、目标可量化、缺口可归因。但搜索策略本身仍是
无记忆的固定网格：每轮从同一起点重排，被证否的动作下一轮还是第一个。本节给工具装上
「策略记忆」，新增 `routes/rsi-strategy.js`（约 300 行）+ 测试 8 项。

### 8.1 三个学习回路

1. **动作级**：每个候选按「target|精确参数签名|失败族」折算成一“臂”，累计
   attempts/wins/修/破。同取值 3 次无胜绩 → 判已证否，搜索不再重试。
2. **维度级**：参数按维度累计（`param:hintWeight`、`clarification:cluster+limit`）。
   只按取值累计永远学不出「这个维度没杠杆」（每个取值只试一次）——维度 4 次无胜绩
   → 整个维度降权。历史 44 个候选中 `clarification:cluster+limit` 5 试 0 胜 → 已进黑名单。
3. **回收率自校准**：`FAMILY_FIX` 的 0.25/0.35 等写死回收率降级为先验，实测
   修/破按经验贝叶斯（伪计数 3）收缩。目标上限随工具自身表现浮动，摘要注明
   「按本任务实测回收率 / 按先验回收率」。

### 8.2 记忆如何反哺搜索

- 候选排序：已证否臂/维度过滤（全灭时保留 1 个探索位防锁死）；有胜绩的臂按
  拉普拉斯收缩 winrate 前移；没试过的保持原轮转。实测 legacy-bank 任务第 15 次运行
  自动跳过了已证否的 6 个澄清组合，改为先试 hintWeight=0.4 / clauseWeight=0.18
  （这两个此前各 1 试 1 胜）。
- 反馈席位：`selectTrainingFeedback` 支持按族配额，席位 = 缺口 × 实测可修率，
  有杠杆的族多给坏例，已证否族少占预算。
- 模型提示词：`strategy.digest` 替代 16 条原始 methodHistory——直接告诉模型
  「A1 在本任务 5 试 0 胜、别再试；A5/A3/A4 尚未尝试」。
- 停止条件：`no_remaining_leverage`——所有失败族登记的动作全部被证否时提前收工，
  不空烧预算（可配 `stopOnNoLeverage:false` 关闭）。
- 预检/状态接口：新增 `GET /api/intent-rsi/strategy`；preflight 与 state 携带
  strategy 摘要（已证否维度、未尝试动作、杠杆表、成功率）。

### 8.3 数据结构

候选生成时即打标 `arm{key,operator,family,targeted}`（提案按 evidence_cases 投票
定失败族，参数类归 engine_global）；评测后记录 `armFixes/armBroken`（相对父代的
McNemar 口径，区别于旧 fixedCases 的相对基线口径）。折叠幂等：始终从
evolveRuns/archive 全量重算，重启/重放不重复计数，state.strategy 与最新同步。

### 8.4 测试与实测

- `tests/rsi-strategy.test.js` 8 项：幂等性、维度级证否、证否后排序变化、回收率
  自校准（实测值 < 先验时上限必须下调）、无杠杆判定、动作归因、预算分配、digest 内容。
- 全量 328 项测试通过（含 knowledge-intake 偶发干扰复跑验证）。
- 实测（legacy-bank，第 15 次运行）：4 候选全部按记忆排序，逐候选产出
  修/破明细（b1 修 t122 破 t014 等），全部被门禁拒绝后以 `no_improvement` 收敛。
  运行后策略记忆更新：lexicalWeight/actionWeight 各 2 试 0 胜，
  hintWeight/clauseWeight 维持 1 胜 —— 下一轮排序已随之改变。

### 8.5 边界（诚实声明）

- 成功率仍为 0：策略记忆让工具**不再重复失败**，但还不能**创造新赢法**——
  当前动作空间（A1–A5 + 7 个引擎参数）在 85% 目标下已被证实不可达（第 7.7 节）。
  记忆的真正价值在动作空间扩展后：新算子先验没有数据，工具会用探索位自动覆盖。
- 参数维度证否阈值（4 次）与臂阈值（3 次）是工程拍板，未做统计校准；
  样本更少的新任务宁可晚一点判死。
- 跨任务迁移未做：记忆按任务隔离（同一 RSI 任务内闭环），任务间共享先验留待后续。

---

## 9. 「为什么精度一直没提升」的完整答案（2026-10-19 晚）

用户连续三轮看到 runs 页面 0 采纳、0 提升，追问归因与策略是否有效。逐层拆解后的结论：
**精度没提升是真的，但原因不是"优化无效"，而是测量层在撒谎 + 候选动作天花板真的存在。**

### 9.1 测量层噪声（本次最大的发现）

基线自身重测 5 次，rsi_t014 翻转 2 次、rsi_t207 翻转 3 次——**精度根本测不准**，
单次配对比较把 ±2 题的 judge 噪声叠加在 1-2 题的真实修复上，任何提升都被淹没。
两个噪声源都被程序化堵死：

1. **单意图近义抛硬币**（t014「申请信用卡进度到哪了」在「查询申请进度」vs「查询申请信用卡」间摇摆）
   → 确定性直判：local 与 embedding Top1 一致且命中声明说法 → 跳过 LLM judge。
   修复后 base 互比 0 翻转（修复前 2 题）。
2. **泛化词闲聊抛硬币**（t207「民生服务」judge 有时 reject 有时选闲聊；闲聊被
   shouldTreatAsIdleChat 兜底塞回 → 澄清永不触发）
   → 泛化守卫：泛化 query 上 judge 选闲聊/低置信/reject → 禁止 idle 兜底，强制转澄清路径。

### 9.2 直判与守卫的三次自噬（诚实记录）

新机制上线后先后三次误伤，每次都被门禁/复测当场抓获：
- 直判把 score 抬到 0.99 → 泛化题被判 confidentExact → 澄清被切断（t207 复坏）→ 改为保留原分。
- 直判的 looksGeneric 用 localTop1 分数参与判定 → A6 补说法推高分数绕过泛化判定
  （t205「网点的事」被直判抢答）→ 改为泛化形态优先（isGenericAmbiguousQuery(query,null)）。
- 守卫未覆盖 judge 自身 reject 分支 → t207 仍被闲聊顶掉 → 扩展 guardActive。

教训：**每一个"优化"都必须过双基线互比（0 flips）+ 受控候选对比，否则就是在噪声里扔骰子。**

### 9.3 引擎层真实收益（非候选、对所有题生效）

- rsi_t207 民生服务：not_triggered → correct（泛化守卫）
- rsi_t020 我额度多少：missing_expected → correct（簇子词召回 + action 过滤修复）
- rsi_t101/t122 多意图：unexpected_clarification → correct
- rsi_t015/t205：直判副作用各坏 1 题（t205 已随泛化形态修复回归，t015 待复测）
- 净效果：+4 −2 = **+2 题（69.0% → 72.2% 口径内）**，且基线自身已完全可复现。

### 9.4 为什么 A6 候选仍然 0 提升

新口径下 b1-repro（t211 簇补说法）0 修 0 破：**给期望意图补说法只能让该题从
"未触发"走到"选项过多"**（clarify_extra_options），strict 需要选项零多余，
单 A6 到不了终点；A6+A2（多余意图 scope_out 收边）组合在单题上 100% 修复，
但模型提案始终只提 A6 不提配套 A2，运行时也没有组合提案机制——这是下一个要修的：
**让 runtime 把「A6 主提案 + 其 evidence 坏例的 A2 收边提案」打包为一个候选。**

### 9.5 性能

- 评测子进程内部并发 3（题间）
- 投票票间并行化：3 票从 ~5min 降到 ~100s
- 候选间并行评测（信号量=scoringConcurrency）
- 单轮 4 候选 2 代实测 266s（此前 >8min）

### 9.6 下一步（按杠杆排序）

1. **组合提案**：A6+A2 打包（修 5-8 道 extra_options 题的关键，预计 +5 题以上）
2. **multi_intent judge 确定性化**：最后 2 题翻转源
3. **重测正式基线并采纳引擎修复**：引擎层 +2 题应作为 v3 版本落地，让 runs 页面显示真实提升
