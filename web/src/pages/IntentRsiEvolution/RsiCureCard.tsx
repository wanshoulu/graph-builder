/**
 * 病因→处方联动视图：按算子码（A1-A5）把「图谱弱点族」与「AI 改进方案」归为同组卡片。
 * 方案不显式引用弱点族 id，只能按 suggested_op ↔ proposal.type 间接归组；两边都可能为空。
 *
 * 视觉纪律：卡片本体一律中性白底，状态只用左侧 3px 色条表达（不再用整卡色底），
 * 与主页面「墨 · 线 · 蓝」一致。
 */
import { Alert, Button, Card, Collapse, List, Popconfirm, Space, Tag, Tooltip, Typography } from "antd";
import { ThunderboltOutlined } from "@ant-design/icons";
import {
  baselineForDelta, canAdopt, deltaNode, FAMILY_INFO, GATE_NAME, humanize, infoTitle, OP_ACTION, proposalChanges, sampleLines, STATUS_META,
  type RsiAttribution, type RsiState,
} from "./rsiShared";
import { COLOR, RULE, SHADOW, ProgressBar, TYPE } from "./rsiDesign";
import type { EngineRev } from "./rsiShared";

type ArchiveEntry = RsiState["archive"][number];

const CURE_STATUS_ORDER: Record<string, number> = { proposed: 0, passed: 1, gated: 2, adopted: 3, rejected: 4 };

/** 状态 → 左侧色条；中性态不外露彩色 */
function statusBar(status: string) {
  if (status === "passed") return COLOR.good;
  if (status === "gated") return COLOR.danger;
  if (status === "adopted") return COLOR.accent;
  return COLOR.gridLine;
}

export interface CureGroup {
  op: string; // A1..A6、combo 或 "_tail"（无对应病因的长尾方案）
  families: RsiAttribution[];
  cures: ArchiveEntry[];
}

export function groupCure(state: RsiState): CureGroup[] {
  const map = new Map<string, CureGroup>();
  for (const f of state.baseline?.attributions || []) {
    const op = f.suggested_op || "_tail";
    if (!map.has(op)) map.set(op, { op, families: [], cures: [] });
    map.get(op)!.families.push(f);
  }
  const assigned = new Set<string>();
  for (const p of state.archive) {
    const op = p.proposal.type;
    if (op === "combo") {
      // combo 是组合提案，归入独立的 combo 组而非按 suggested_op 匹配
      if (!map.has("combo")) map.set("combo", { op: "combo", families: [], cures: [] });
      map.get("combo")!.cures.push(p);
      assigned.add(p.id);
    } else if (map.has(op)) {
      map.get(op)!.cures.push(p);
      assigned.add(p.id);
    }
  }
  const groups = [...map.values()];
  groups.sort((a, b) => {
    const sa = a.families.reduce((n, f) => n + f.count, 0);
    const sb = b.families.reduce((n, f) => n + f.count, 0);
    return sb - sa;
  });
  const leftover = state.archive.filter((p) => !assigned.has(p.id));
  if (leftover.length) groups.push({ op: "_tail", families: [], cures: leftover });
  for (const g of groups) g.cures.sort((x, y) => (CURE_STATUS_ORDER[x.status] ?? 9) - (CURE_STATUS_ORDER[y.status] ?? 9));
  return groups;
}

function FamilyRow(props: {
  f: RsiAttribution;
  maxCount: number;
  open: boolean;
  onToggle: () => void;
}) {
  const { f, maxCount, open, onToggle } = props;
  const info = FAMILY_INFO[f.family] || { name: f.family, desc: f.note };
  return (
    <div style={{ marginBottom: 4, borderBottom: `1px solid ${RULE}` }}>
      <div
        onClick={onToggle}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-label={`${info.name}，考错 ${f.count} 题，${open ? "收起" : "展开"}错题`}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); } }}
        style={{
          display: "flex", alignItems: "center", gap: 12, marginBottom: 8,
          cursor: "pointer", padding: "6px 8px", margin: "0 -8px 8px", borderRadius: 8,
          transition: "background 0.15s ease",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = COLOR.bg; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
      >
        <Typography.Text style={{ width: 220, fontSize: TYPE.small }} ellipsis={{ tooltip: `${info.desc}。示例：${humanize(f.note)}` }}>{info.name}</Typography.Text>
        <div style={{ flex: 1 }}><ProgressBar value={Math.round((100 * f.count) / Math.max(maxCount, 1))} color={COLOR.accent} height={6} /></div>
        <Tooltip title="这类弱点在本轮考试中考错的题目数量">
          <Typography.Text strong style={{ width: 24, textAlign: "right", fontVariantNumeric: "tabular-nums", fontSize: TYPE.small }}>{f.count}</Typography.Text>
        </Tooltip>
        <Typography.Text type="secondary" style={{ fontSize: TYPE.micro, width: 48, textAlign: "right" }}>{open ? "收起" : "看错题"}</Typography.Text>
      </div>
      {open && (
        <div style={{ background: COLOR.bg, borderRadius: 8, padding: "10px 14px", marginBottom: 10 }}>
          {(f.samples || []).map((s) => (
            <div key={s.case_id} style={{ padding: "6px 0", borderBottom: `1px dashed ${COLOR.gridDash}` }}>
              <Typography.Text strong style={{ fontSize: TYPE.small }}>「{s.query}」</Typography.Text>
              {s.shape === "multi_intent" && <Tag style={{ marginLeft: 6, fontSize: 11 }}>复合句</Tag>}
              {s.shape === "ambiguous_intent" && <Tag style={{ marginLeft: 6, fontSize: 11 }}>模糊提问</Tag>}
              {(s.expectedNames || []).length > 0 && (
                <Typography.Text type="secondary" style={{ fontSize: TYPE.small }}> 正确答案：「{(s.expectedNames || []).join("、")}」</Typography.Text>
              )}
              {sampleLines(s)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ProposalCard(props: {
  p: ArchiveEntry;
  busy: string;
  /** 可采纳统一判定上下文（10-15 审核 P0-2）：所有采纳入口与后端闸门同口径 */
  adoptCtx: { currentVersion: string; currentEngineRev?: EngineRev | null; baselineFresh?: boolean };
  onEvaluateOne: (id: string) => void;
  onVerifyEngine: (p: ArchiveEntry) => void;
  onAdopt: (p: ArchiveEntry) => void;
  onReject: (p: ArchiveEntry) => void;
}) {
  const { p, busy, adoptCtx, onEvaluateOne, onVerifyEngine, onAdopt, onReject } = props;
  const meta = STATUS_META[p.status] || STATUS_META.proposed;
  // 统一可采纳判定（与后端 runAdopt 闸门逐条对齐），不再只看 engineCheck.ok
  const adopt = canAdopt(p, adoptCtx);
  return (
    <div
      style={{
        background: "#fff",
        border: `1px solid ${COLOR.border}`,
        borderLeft: `3px solid ${statusBar(p.status)}`,
        borderRadius: 10,
        padding: "14px 16px",
        marginBottom: 8,
        boxShadow: SHADOW.card,
      }}
    >
      <Space size={8} wrap style={{ marginBottom: 6 }}>
        <Tag style={{ marginRight: 0, borderRadius: 4 }}>{p.opLabel}</Tag>
        <Tag color={meta.color} style={{ borderRadius: 4 }}>{meta.label}</Tag>
        {p.paretoOptimal && (
          <Tooltip title="在所有通过验证的方案里，这个方案没有任何一个其他方案在三类题上都比它好——多维综合最优">
            <Tag color="gold" style={{ borderRadius: 4 }}>多维最优</Tag>
          </Tooltip>
        )}
        {/* bundle/combo 是完整候选资产或组合提案，没有单一 target——显示资产标识而非空模板（10-15 审核 P1） */}
        {p.proposal.type === "bundle" ? (
          <Typography.Text strong style={{ fontSize: TYPE.body }}>完整候选资产{p.candidateHash ? <Typography.Text code style={{ fontSize: TYPE.micro, marginLeft: 6 }}>{p.candidateHash.slice(0, 12)}</Typography.Text> : null}</Typography.Text>
        ) : p.proposal.type === "combo" ? (
          <Typography.Text strong style={{ fontSize: TYPE.body }}>组合提案（{(p.proposal.parts as Array<{ type?: string }> || []).length} 个子操作）{p.candidateHash ? <Typography.Text code style={{ fontSize: TYPE.micro, marginLeft: 6 }}>{p.candidateHash.slice(0, 12)}</Typography.Text> : null}</Typography.Text>
        ) : (
          <Typography.Text strong style={{ fontSize: TYPE.body }}>针对意图「{p.targetName || p.proposal.target}」</Typography.Text>
        )}
        <Typography.Text type="secondary" style={{ fontSize: TYPE.micro }}>
          {(p.createdAt || "").replace("T", " ").slice(11, 19)}{p.evidenceQueries && p.evidenceQueries.length ? ` · 依据错题：${p.evidenceQueries.slice(0, 2).join("；")}` : ""}
        </Typography.Text>
      </Space>

      {p.proposal.motivation && (
        <Typography.Paragraph type="secondary" style={{ marginBottom: 6, fontSize: TYPE.small, lineHeight: 1.7 }}>
          AI 的理由：{humanize(p.proposal.motivation)}
        </Typography.Paragraph>
      )}

      <Typography.Paragraph code style={{ marginBottom: 8, fontSize: TYPE.small, whiteSpace: "pre-wrap", lineHeight: 1.7 }}>
        {proposalChanges(p)}
      </Typography.Paragraph>

      {p.status === "passed" && (p.fixedCases || []).length > 0 && (
        <Tooltip title="验证时这些错题被修好了；采纳后会持续盯守它们，防止后续改动让它们再错">
          <Tag style={{ marginBottom: 6, borderRadius: 4 }}>验证中修好了 {(p.fixedCases || []).length} 道错题，采纳后持续盯守</Tag>
        </Tooltip>
      )}

      {p.trainScores && (() => {
        const base = baselineForDelta(p);
        return (
          <Space size={18} wrap style={{ marginBottom: 6, fontSize: TYPE.small }}>
            <span>优化题部分得分率 <b style={{ fontVariantNumeric: "tabular-nums" }}>{p.trainScores.relaxed_pct}%</b> {base && p.trainScores ? deltaNode(base.trainRelaxed, p.trainScores.relaxed_pct) : null}</span>
            {p.heldoutScores && <span>隐藏考完全正确率 <b style={{ fontVariantNumeric: "tabular-nums" }}>{p.heldoutScores.strict_pct}%</b> {base ? deltaNode(base.heldStrict, p.heldoutScores.strict_pct) : null}</span>}
            {p.heldoutScores && <span>隐藏考部分得分率 <b style={{ fontVariantNumeric: "tabular-nums" }}>{p.heldoutScores.relaxed_pct}%</b> {base ? deltaNode(base.heldRelaxed, p.heldoutScores.relaxed_pct) : null}</span>}
            <Typography.Text type="secondary" style={{ fontSize: TYPE.micro }}>
              （该方案单独验证时，相对当时改前成绩{base ? ` · 当时基线 ${base.version}` : " · 旧档案无当时基线，不显示对比"}）
            </Typography.Text>
          </Space>
        );
      })()}

      {p.gate && p.status !== "adopted" && (
        <Alert
          style={{ marginTop: 4 }}
          type={p.status === "passed" ? (adopt.ok ? "success" : "warning") : "warning"}
          showIcon={false}
          message={`${p.status === "passed"
            ? (adopt.ok ? "✓ 验证通过，可以采纳" : `⚠ 前三关通过，暂不可采纳：${adopt.reason}`)
            : `⛔ ${GATE_NAME[p.gate.stage] || p.gate.stage}未通过`}${p.status !== "passed" && p.gate.reason ? `：${humanize(p.gate.reason)}` : ""}`}
        />
      )}
      {p.status === "adopted" && <Alert style={{ marginTop: 4 }} type="success" message={`✓ 已采纳，图谱更新为 ${p.adoptedAs || "新版本"}`} />}

      {(p.status === "passed" || (p.status === "gated" && p.gate?.stage === "engine")) && (
        <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {p.engineCheck ? (
            <Typography.Text style={{ fontSize: TYPE.small, color: p.engineCheck.ok ? COLOR.good : COLOR.danger }}>
              {/* 兼容两种口径：旧沙盒环有 current/draft 分数；生产环只回 {ok, engineRev}（评审 F03） */}
              {p.engineCheck.ok ? "✓ 第四关·生产引擎复核通过" : "✗ 第四关·生产引擎复核未通过"}
              {(p.engineCheck as { current?: { strict_pct: number }; draft?: { strict_pct: number }; caseCount?: number }).current && (p.engineCheck as { draft?: { strict_pct: number } }).draft
                ? `：引擎完全正确率 ${(p.engineCheck as { current: { strict_pct: number } }).current.strict_pct}% → ${(p.engineCheck as { draft: { strict_pct: number } }).draft.strict_pct}%（${(p.engineCheck as { caseCount?: number }).caseCount ?? "?"} 条真引擎实测）`
                : p.engineCheck.ok ? "：生产引擎复核确认无回退" : "：生产引擎复核发现回退或异常"}
            </Typography.Text>
          ) : (
            <Typography.Text type="secondary" style={{ fontSize: TYPE.micro }}>第四关·生产引擎复核：还没做——采纳前用「当前 vs 草案」同场引擎对比再确认一次无回退</Typography.Text>
          )}
          <Button size="small" loading={busy === `eng-${p.id}`} onClick={() => onVerifyEngine(p)}>
            {p.engineCheck ? "重新复核" : "引擎复核"}
          </Button>
        </div>
      )}

      <Space size={8} style={{ marginTop: 10 }}>
        {p.status === "proposed" && <Button size="small" type="primary" loading={busy === `eval-${p.id}`} onClick={() => onEvaluateOne(p.id)}>验证此方案</Button>}
        {p.status === "passed" && (
          <Popconfirm title="采纳这个方案？" description="图谱将更新为新版本，当前成绩需要重新测试。" onConfirm={() => onAdopt(p)} okText="采纳" cancelText="取消" disabled={!adopt.ok}>
            <Tooltip title={adopt.ok ? "已过四关，可采纳" : adopt.reason}>
              <Button size="small" type="primary" ghost loading={busy === `adopt-${p.id}`} disabled={!adopt.ok}>采纳</Button>
            </Tooltip>
          </Popconfirm>
        )}
        {(p.status === "proposed" || p.status === "passed" || p.status === "gated") && (
          <Button size="small" loading={busy === `reject-${p.id}`} onClick={() => onReject(p)}>拒绝</Button>
        )}
      </Space>
    </div>
  );
}

export function RsiCureGroups(props: {
  state: RsiState;
  busy: string;
  openFamily: string;
  setOpenFamily: (f: string) => void;
  onPropose: () => void;
  onEvaluateOne: (id: string) => void;
  onVerifyEngine: (p: ArchiveEntry) => void;
  onAdopt: (p: ArchiveEntry) => void;
  onReject: (p: ArchiveEntry) => void;
}) {
  const { state, busy, openFamily, setOpenFamily, onPropose, onEvaluateOne, onVerifyEngine, onAdopt, onReject } = props;
  const groups = groupCure(state);
  const maxCount = Math.max(1, ...(state.baseline?.attributions || []).map((f) => f.count));
  // 可采纳判定上下文：当前版本 + 当前引擎指纹（与后端闸门同源，10-15 审核 P0-2）
  const adoptCtx = { currentVersion: state.currentVersion, currentEngineRev: state.baseline?.engineRev ?? null, baselineFresh: !!state.baseline && state.baseline.version === state.currentVersion };

  if (!groups.length) {
    return (
      <Card size="small" style={{ marginBottom: 16 }}>
        <Typography.Text type="secondary" style={{ fontSize: TYPE.body }}>还没有弱点也没有方案——先「测当前水平」考一轮，错题会自动归纳成弱点。</Typography.Text>
      </Card>
    );
  }

  return (
    <div style={{ marginBottom: 16 }}>
      {groups.map((g) => {
        const isTail = g.op === "_tail";
        const totalWrong = g.families.reduce((n, f) => n + f.count, 0);
        const familyNames = g.families.map((f) => FAMILY_INFO[f.family]?.name || f.family).join("、");
        const opName = OP_ACTION[g.op] || (isTail ? "" : g.op);
        const activeCures = g.cures.filter((p) => p.status === "proposed" || p.status === "passed");
        const historyCures = g.cures.filter((p) => p.status === "gated" || p.status === "rejected");
        const mainCures = g.cures.filter((p) => p.status !== "gated" && p.status !== "rejected");
        const title = isTail
          ? `待审阅的改进建议（${g.cures.length} 个，针对未被归纳的弱点）`
          : g.families.length > 0 && g.cures.length === 0
            ? `病因：${familyNames}（考砸 ${totalWrong} 题）——还没开方`
            : g.families.length > 0
              ? `病因：${familyNames}（考砸 ${totalWrong} 题）→ 处方 ${g.cures.length} 个`
              : `处方：${opName}（${g.cures.length} 个）`;
        return (
          <Card
            key={g.op}
            size="small"
            style={{ marginBottom: 12 }}
            title={<span style={{ fontSize: TYPE.body, fontWeight: 600 }}>{title}</span>}
            extra={
              g.families.length > 0 && g.cures.length === 0 ? (
                <Button size="small" type="primary" ghost icon={<ThunderboltOutlined />} loading={busy === "propose"} onClick={onPropose}>让 AI 开方</Button>
              ) : undefined
            }
          >
            {g.families.map((f) => (
              <FamilyRow
                key={f.family}
                f={f}
                maxCount={maxCount}
                open={openFamily === f.family}
                onToggle={() => setOpenFamily(openFamily === f.family ? "" : f.family)}
              />
            ))}
            {g.families.length > 0 && mainCures.length > 0 && (
              <Typography.Text type="secondary" style={{ display: "block", margin: "8px 0 4px", fontSize: TYPE.micro }}>针对这类弱点，AI 开出了 {mainCures.length} 个处方：</Typography.Text>
            )}
            {mainCures.length > 0 && (
              <List
                dataSource={mainCures}
                locale={{ emptyText: " " }}
                renderItem={(p) => (
                  <ProposalCard p={p} busy={busy} adoptCtx={adoptCtx} onEvaluateOne={onEvaluateOne} onVerifyEngine={onVerifyEngine} onAdopt={onAdopt} onReject={onReject} />
                )}
              />
            )}
            {historyCures.length > 0 && (
              <Collapse
                ghost
                size="small"
                items={[{
                  key: "history",
                  label: <Typography.Text type="secondary" style={{ fontSize: TYPE.micro }}>历史未通过方案 {historyCures.length} 个（默认折叠，点击展开复盘）</Typography.Text>,
                  children: (
                    <List
                      dataSource={historyCures}
                      locale={{ emptyText: " " }}
                      renderItem={(p) => (
                        <ProposalCard p={p} busy={busy} adoptCtx={adoptCtx} onEvaluateOne={onEvaluateOne} onVerifyEngine={onVerifyEngine} onAdopt={onAdopt} onReject={onReject} />
                      )}
                    />
                  ),
                }]}
              />
            )}
            {activeCures.length === 0 && g.families.length > 0 && g.cures.length > 0 && (
              <Typography.Text type="secondary" style={{ fontSize: TYPE.micro }}>这类弱点的方案都已处理完（采纳或拒绝）。</Typography.Text>
            )}
          </Card>
        );
      })}
    </div>
  );
}
