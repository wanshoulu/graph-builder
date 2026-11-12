/**
 * 候选方案并列对比表（对标 Opik trial table / GEPA candidate pool）：
 * 一行一方案、一列一指标，横向比较三关成绩；行展开看完整详情（复用 ProposalCard）。
 * delta 只相对「该方案评估时」的基线（baselineAtEval）；旧档案无当时基线则不显示对比。
 */
import { useState } from "react";
import { Alert, Button, Drawer, Spin, Table, Tag, Tooltip, Typography } from "antd";
import { baselineForDelta, canAdopt, deltaNode, rsiRequest, STATUS_META, type RsiState } from "./rsiShared";
import { ProposalCard } from "./RsiCureCard";
import { COLOR, TYPE } from "./rsiDesign";
import { RsiCandidateDiff } from "./RsiCandidateDiff";
import { candidateComparisonRows, type CandidateDiff } from "./rsiCandidateEvidence";
import { currentTaskId } from "./rsiTaskContext";

type ArchiveEntry = RsiState["archive"][number];

const STATUS_RANK: Record<string, number> = { passed: 0, adopted: 1, proposed: 2, gated: 3 };

function scoreCell(base: number | undefined | null, now: number | undefined) {
  if (now === undefined || now === null) {
    return <Typography.Text style={{ fontSize: TYPE.small, color: COLOR.textSecondary }}>未验证</Typography.Text>;
  }
  if (base === undefined || base === null) {
    return (
      <span style={{ fontSize: TYPE.small, fontVariantNumeric: "tabular-nums" }}>
        <b style={{ color: COLOR.textPrimary }}>{now}%</b>{" "}
        <Typography.Text type="secondary" style={{ fontSize: TYPE.micro }}>（无当时基线）</Typography.Text>
      </span>
    );
  }
  return (
    <span style={{ fontSize: TYPE.small, fontVariantNumeric: "tabular-nums" }}>
      <b style={{ color: COLOR.textPrimary }}>{now}%</b> {deltaNode(base, now)}
    </span>
  );
}

export function RsiCandidatesTable(props: {
  state: RsiState;
  busy: string;
  onEvaluateOne: (id: string) => void;
  onVerifyEngine: (p: ArchiveEntry) => void;
  onAdopt: (p: ArchiveEntry) => void;
  onReject: (p: ArchiveEntry) => void;
}) {
  const [selectedIds, setSelectedIds] = useState<React.Key[]>([]);
  const [diffOpen, setDiffOpen] = useState(false);
  const [diff, setDiff] = useState<CandidateDiff | null>(null);
  const [diffError, setDiffError] = useState('');
  const [diffBusy, setDiffBusy] = useState(false);
  const { state, busy, onEvaluateOne, onVerifyEngine, onAdopt, onReject } = props;
  const openDiff = async (p: ArchiveEntry) => {
    const taskId = state.taskId || currentTaskId();
    setDiff(null); setDiffError(''); setDiffOpen(true); setDiffBusy(true);
    try { setDiff(await rsiRequest<CandidateDiff>(`/candidate-diff?id=${encodeURIComponent(p.id)}`, undefined, taskId)); }
    catch (e) { setDiffError((e as Error).message); }
    finally { setDiffBusy(false); }
  };
  // 可采纳统一判定上下文（10-15 审核 P0-2）：与后端 runAdopt 闸门同口径
  const adoptCtx = { currentVersion: state.currentVersion, currentEngineRev: state.currentEngineRev ?? state.baseline?.engineRev ?? null, baselineFresh: state.scoreValidity?.current !== false && !state.baseline?.stale && !!state.baseline && state.baseline.version === state.currentVersion };
  const rows = state.archive
    .filter((p) => p.status !== "rejected")
    .sort((x, y) =>
      (STATUS_RANK[x.status] ?? 9) - (STATUS_RANK[y.status] ?? 9) ||
      (y.heldoutScores?.strict_pct ?? -1) - (x.heldoutScores?.strict_pct ?? -1),
    );
  // 待拍板分诊（10-17 用户反馈：首页徽标 N 待拍板，点进来找不到拍板处）：
  // passed 候选分两类——可直接采纳 vs 证据过期需重测，各自点名，进来第一眼就知道该处理谁
  const passedRows = rows.filter((p) => p.status === "passed");
  const adoptable = passedRows.filter((p) => canAdopt(p, adoptCtx).ok);
  const stalePassed = passedRows.filter((p) => !canAdopt(p, adoptCtx).ok);

  if (!rows.length) return null;

  const columns = [
    {
      title: "方案",
      key: "plan",
      render: (_: unknown, p: ArchiveEntry) => (
        <div style={{ minWidth: 180 }}>
          <Tag style={{ marginBottom: 2, borderRadius: 4 }}>{p.opLabel}</Tag>
          <div style={{ fontSize: TYPE.small, color: COLOR.textPrimary }}>
            {p.proposal.type === "bundle"
              ? <>完整候选资产{p.candidateHash ? <Typography.Text code style={{ fontSize: TYPE.micro, marginLeft: 4 }}>{p.candidateHash.slice(0, 12)}</Typography.Text> : null}</>
              : <>针对「{p.targetName || p.proposal.target}」</>}
            <Typography.Text style={{ fontSize: TYPE.micro, display: "block", color: COLOR.textSecondary }}>
              {(p.createdAt || "").replace("T", " ").slice(5, 16)}
            </Typography.Text>
          </div>
        </div>
      ),
    },
    {
      title: "状态",
      key: "status",
      render: (_: unknown, p: ArchiveEntry) => {
        const meta = STATUS_META[p.status] || STATUS_META.proposed;
        return (
          <>
            <Tag color={meta.color} style={{ borderRadius: 4 }}>{meta.label}</Tag>
            {p.status === "passed" && (() => {
              const adopt = canAdopt(p, adoptCtx);
              return adopt.ok
                ? <Tooltip title={adopt.reason}><Tag color="blue" style={{ borderRadius: 4 }}>可采纳</Tag></Tooltip>
                : <Tooltip title={adopt.reason}><Tag color="orange" style={{ borderRadius: 4 }}>暂不可采纳</Tag></Tooltip>;
            })()}
            {p.staleEngine && (
              <Tooltip title="该方案的成绩产自旧版评测引擎，与当前口径不可比——重新评测后方可采纳">
                <Tag color="orange" style={{ borderRadius: 4 }}>旧引擎口径</Tag>
              </Tooltip>
            )}
            {!p.staleEngine && p.status === "proposed" && (p.pendingHours ?? 0) >= 24 && (
              <Tooltip title={`悬置 ${p.pendingHours} 小时未验证，当时的对比基线可能已失效`}>
                <Tag color="orange" style={{ borderRadius: 4 }}>悬置 {p.pendingHours}h</Tag>
              </Tooltip>
            )}
            {p.paretoOptimal && (
              <Tooltip title="在所有通过验证的方案里，没有任何一个其他方案在三类题上都比它好——多维综合最优（帕累托前沿）">
                <Tag color="gold" style={{ borderRadius: 4 }}>多维最优</Tag>
              </Tooltip>
            )}
          </>
        );
      },
    },
    {
      title: "练习题·部分得分率",
      key: "train",
      render: (_: unknown, p: ArchiveEntry) => <>{scoreCell(baselineForDelta(p)?.trainRelaxed, p.trainScores?.relaxed_pct)}<div>n={p.trainScores?.total ?? "未记录"}</div></>,
    },
    {
      title: "隐藏考题·完全正确率",
      key: "heldStrict",
      render: (_: unknown, p: ArchiveEntry) => <>{scoreCell(baselineForDelta(p)?.heldStrict, p.heldoutScores?.strict_pct)}<div>n={p.heldoutScores?.total ?? "未记录"}</div></>,
    },
    {
      title: "隐藏考题·部分得分率",
      key: "heldRelaxed",
      render: (_: unknown, p: ArchiveEntry) => scoreCell(baselineForDelta(p)?.heldRelaxed, p.heldoutScores?.relaxed_pct),
    },
    {
      title: "",
      key: "ops",
      width: 96,
      render: (_: unknown, p: ArchiveEntry) => <Button size="small" aria-label={`查看候选 ${p.id} 的父子资产与逐题差异`} onClick={e => { e.stopPropagation(); openDiff(p); }}>父子差异</Button>,
    },
  ];

  return (<>
    {(adoptable.length > 0 || stalePassed.length > 0) && (
      <Alert
        style={{ marginBottom: 12 }}
        type={adoptable.length > 0 ? "success" : "warning"}
        showIcon
        message={adoptable.length > 0
          ? `${adoptable.length} 个方案已过四关，等你拍板：展开对应行，确认 AI 理由后点「采纳」`
          : `${stalePassed.length} 个方案曾通过验证，但证据已过期（题库/切分/引擎口径变化）——展开后「重新评测」刷新证据，或「拒绝」清理`}
        description={adoptable.length > 0 && stalePassed.length > 0
          ? `另有 ${stalePassed.length} 个曾通过的方案证据过期，需要重新评测后才能采纳。`
          : undefined}
      />
    )}
    <Alert type="info" showIcon message="勾选最多两个候选并列比较；父子差异提供资产字段与逐题回退证据。" style={{ marginBottom: 12 }} />
    {selectedIds.length > 0 && <Table size="small" rowKey="id" dataSource={candidateComparisonRows(rows.filter(p => selectedIds.includes(p.id)))} pagination={false} scroll={{ x: 800 }} columns={[{ title: '候选', dataIndex: 'name' }, { title: '训练完全正确率', dataIndex: 'train' }, { title: '验证完全正确率', dataIndex: 'heldout' }, { title: '父版本', dataIndex: 'version' }, { title: '实验', dataIndex: 'runId' }, { title: '门禁', dataIndex: 'gate' }]} title={() => '候选并列比较：口径或样本量不同时不可直接计算收益'} style={{ marginBottom: 16 }} />}
    <Drawer open={diffOpen} onClose={() => setDiffOpen(false)} title={`父子资产与逐题差异${diff ? ` · ${diff.candidate.id}` : ''}`} width="min(100vw, 960px)">
      {diffBusy && <Spin tip="加载保存的证据…" />}{diffError && <Alert type="error" showIcon message={diffError} />}{diff && <RsiCandidateDiff data={diff} />}
    </Drawer>
    <Table<ArchiveEntry>
      size="small"
      style={{ marginBottom: 16, borderRadius: 10, overflow: "hidden", border: `1px solid ${COLOR.border}` }}
      rowKey="id"
      // antd 的 AbstractCheckboxProps 类型漏了 aria-* 透传字段（运行时合法透传到 DOM）——
      // 仅在本处对返回值放宽 any，避免整表类型噪音
      rowSelection={{ selectedRowKeys: selectedIds, onChange: keys => setSelectedIds(keys.slice(-2)), getCheckboxProps: (p: ArchiveEntry) => ({ "aria-label": `选择候选 ${p.id} 进行比较` }) as never }}
      columns={columns}
      dataSource={rows}
      scroll={{ x: "max-content" }}
      pagination={{ pageSize: 8, hideOnSinglePage: true, showSizeChanger: false }}
      expandable={{
        expandedRowRender: (p) => (
          <div style={{ background: COLOR.bg, padding: "6px 10px" }}>
            <ProposalCard p={p} busy={busy} adoptCtx={adoptCtx} onEvaluateOne={onEvaluateOne} onVerifyEngine={onVerifyEngine} onAdopt={onAdopt} onReject={onReject} />
          </div>
        ),
        rowExpandable: () => true,
        expandRowByClick: true,
      }}
      title={() => (
        <Typography.Text style={{ fontSize: TYPE.micro, color: COLOR.textSecondary }}>
          本轮全部候选方案并列对比（含未通过与已采纳，已拒绝的除外）。± 数值 = 该方案单独验证时相对「当时改前成绩」的变化；点任意一行展开看 AI 理由与操作。
        </Typography.Text>
      )}
    />
  </>);
}
