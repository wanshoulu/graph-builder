/**
 * 五步流程条：备题库 → 测当前水平 → AI 提改进方案 → 逐案验证 → 采纳生效。
 * deriveStep 从实验 state 推导当前所处步骤与推荐动作，纯函数可测试。
 *
 * 本组件不套卡片外壳（由外层「决策锚点」承载），只渲染：轮次 + 步骤条 + 推荐动作。
 * 推荐动作是全页唯一的主 CTA，视觉权重高于其它按钮。
 */
import { Button, Steps, Tag, Typography } from "antd";
import { CaretRightOutlined, ExperimentOutlined, FileAddOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { canAdopt, type BasesInfo, type RsiState } from "./rsiShared";
import { COLOR, RULE, TYPE } from "./rsiDesign";

export interface NextAction { key: string; label: string; icon?: "baseline" | "propose" | "evalall" | "gencases" | "review" }

export interface StepFlowInfo {
  current: number;
  nextAction: NextAction | null;
  nextHint: string;
  blocked: { step: number; reason: string } | null;
}

const STEP_TITLES = ["备题库", "测当前水平", "AI 提改进方案", "逐案验证（四关）", "采纳生效"];

const STEP_DESCRIPTIONS = [
  "优化题 + 验证题，验证题藏起来专防“只会做原题”",
  "把题库考一遍，错题自动归纳成图谱弱点",
  "AI 针对弱点开处方：补说法 / 改描述 / 加澄清…",
  "每个方案过四关：优化题 → 防回退 → 验证题 → 引擎复核",
  "四关全过你才审阅采纳，图谱升级为新版本",
];

export function deriveStep(state: RsiState, bases: BasesInfo | null): StepFlowInfo {
  const b = state.baseline;
  const caseCount = bases?.casesCount ?? state.split.trainCount + state.split.heldoutCount;
  const proposedCount = state.archive.filter((p) => p.status === "proposed").length;
  const adoptableCount = state.archive.filter((p) => canAdopt(p, { currentVersion: state.currentVersion, currentEngineRev: state.currentEngineRev, baselineFresh: !b?.stale }).ok).length;
  // 待审阅/待处置 = passed（四关已过，等人工决策）+ proposed（待验证）。
  // 与后端 /tasks 的 pendingReview 同口径——首页徽标数的就是这个，点进来必须能找到对应入口。
  const pendingReviewCount = state.archive.filter((p) => p.status === "proposed" || p.status === "passed").length;
  // 第 5 步「已采纳」判定（10-15 审核 P0）：versions 恒含初始 v1 条目，用 versions.length>0
  // 判断会让全新实验直接显示"已采纳生效"。只认 archive 中真实的 adopted 记录或 v1 之外的版本。
  const hasAdopted = state.archive.some((p) => p.status === "adopted") || state.versions.some((v) => v.version !== "v1");
  // 基线 freshness（10-15 审核 P1）：版本一致 + 基线时间不早于最近一次引擎口径不同的打分。
  // 引擎变更（指纹不同）后旧基线不再是"当前水平"——此前只比版本会漏掉引擎升级的情况。
  const baselineRev = b?.engineRev ?? null;
  const baselineFresh = !!b && !b.stale && b.version === state.currentVersion
    && !((state.scoreHistory || []).some((h) => h.engineRev && baselineRev
      && (h.engineRev.engineSha !== baselineRev.engineSha || h.engineRev.protoRev !== baselineRev.protoRev || h.engineRev.engineMode !== baselineRev.engineMode)
      && h.at > b.at));

  // 各步完成情况
  const done = [
    caseCount > 0,
    baselineFresh,
    state.archive.length > 0,
    proposedCount === 0, // 没有待验证的即视为本步完成（passed 待采纳归第 5 步决策）
    hasAdopted && baselineFresh,
  ];

  let current = done.findIndex((d) => !d);
  if (current === -1) current = 4;

  let nextAction: NextAction | null = null;
  let nextHint = "";
  if (caseCount === 0) {
    nextAction = { key: "gencases", label: "让 AI 出一套测试题", icon: "gencases" };
    nextHint = "题库是空的：先出题，才能考图谱。";
  } else if (!b) {
    nextAction = { key: "baseline", label: "评测当前识别效果", icon: "baseline" };
    nextHint = "先考出当前水平和弱点，后面的一切都基于这份成绩单。";
  } else if (!baselineFresh) {
    nextAction = { key: "baseline", label: "重新测试当前水平", icon: "baseline" };
    nextHint = "版本、题库或引擎口径已变化，旧成绩不再代表现状——重测一次拿到新成绩单。";
  } else if (state.archive.length === 0) {
    nextAction = { key: "propose", label: "配置并启动多代进化", icon: "propose" };
    nextHint = "先选择优化路径、代际策略与预算，再依据训练错题生成候选。";
  } else if (proposedCount > 0) {
    nextAction = { key: "evalall", label: `验证全部方案（${proposedCount}）`, icon: "evalall" };
    nextHint = "每个方案都要过四关：优化题会做 → 已正确识别的题目不退步 → 验证题不回退 → 引擎复核确认真有效。";
  } else if (adoptableCount > 0) {
    // 有当下就能采纳的方案：给真正可点击的入口，跳到「候选比较」标签页审阅采纳
    nextAction = { key: "review", label: `审阅方案（${adoptableCount} 个方案可采纳）`, icon: "review" };
    nextHint = `${adoptableCount} 个方案已过全部四关，到「候选比较」审阅后点击「采纳」，图谱才升级为新版本。`;
  } else if (pendingReviewCount > 0) {
    // 有待处置方案但当下都不可直接采纳（证据过期/引擎口径变化）：同样给跳转入口，避免首页徽标与详情页断链
    nextAction = { key: "review", label: `去审阅待处置方案（${pendingReviewCount}）`, icon: "review" };
    nextHint = `${pendingReviewCount} 个方案等待处置，但证据已过期（题库/切分/引擎口径变化），到「候选比较」重新评测或拒绝后才能采纳。`;
  } else {
    nextAction = { key: "propose", label: "配置下一次进化实验", icon: "propose" };
    nextHint = "没有可采纳的新改善时保留当前版本；可调整路径与预算继续搜索，不保证每代都提升。";
  }

  const blocked = state.integrity.drift ? { step: 1, reason: "题库在实验中被外部改动过，成绩不可比——建议补充测试题或清空重来重开实验" } : null;
  return { current, nextAction, nextHint, blocked };
}

export function RsiStepFlow(props: {
  info: StepFlowInfo;
  busy: string;
  onAction: (key: string) => void;
  /** 空态引导等场景下隐藏推荐按钮（外层有自己的大按钮） */
  hideAction?: boolean;
  /** 轮次标签，如「第 2 轮进行中」 */
  round?: string;
}) {
  const { info, busy, onAction, hideAction, round } = props;
  const items = STEP_TITLES.map((title, i) => ({
    title,
    description: STEP_DESCRIPTIONS[i],
    status: info.blocked?.step === i ? ("error" as const) : undefined,
  }));
  const iconFor = (a: NextAction) =>
    a.icon === "baseline" ? <CaretRightOutlined /> : a.icon === "propose" ? <ThunderboltOutlined /> : a.icon === "evalall" || a.icon === "review" ? <ExperimentOutlined /> : <FileAddOutlined />;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
        <Typography.Text type="secondary" style={{ fontSize: TYPE.micro }}>
          进化循环：考试 → 开方 → 验证 → 采纳 → 重考进入下一轮；提升以优化题完全正确率且须过引擎复核为准，隐藏考只守不回退，终审看「最终验收」
        </Typography.Text>
        {round && <Tag color="geekblue" style={{ marginLeft: "auto", marginRight: 0 }}>{round}</Tag>}
      </div>

      <Steps size="small" labelPlacement="vertical" current={info.current} items={items} />

      <div style={{ height: 1, background: RULE, margin: "20px 0 16px" }} />

      <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        {info.blocked ? (
          <Typography.Text type="warning" style={{ fontSize: TYPE.body, flex: 1, minWidth: 240 }}>
            {info.blocked.reason}
          </Typography.Text>
        ) : (
          <Typography.Text style={{ fontSize: TYPE.body, color: COLOR.textSecondary, flex: 1, minWidth: 240, lineHeight: 1.7 }}>
            {info.nextHint}
          </Typography.Text>
        )}
        {info.nextAction && !info.blocked && !hideAction && (
          <Button
            type="primary"
            size="middle"
            icon={iconFor(info.nextAction)}
            loading={busy === info.nextAction.key || (info.nextAction.key === "evalall" && busy === "evalall")}
            onClick={() => onAction(info.nextAction!.key)}
            style={{ fontWeight: 500, flexShrink: 0 }}
          >
            {info.nextAction.label}
          </Button>
        )}
      </div>
    </div>
  );
}
