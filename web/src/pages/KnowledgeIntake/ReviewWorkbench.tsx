/**
 * 三栏审核工作台：左队列（导航/过滤/批量）+ 中详情（读/编/审）+ 右问题（阻断/验收/AI 建议）
 * 数据装载与服务端 buildBatchTree 同源（buildSheet）；dataVersion 变化整刷；确认/驳回后自动跳到下一个待审
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Dropdown, message, Tooltip } from "antd";
import {
  CheckOutlined,
  CloseOutlined,
  CloudOutlined,
  FileDoneOutlined,
  ReloadOutlined,
  RobotOutlined,
  WarningOutlined,
} from "@ant-design/icons";
import { knowledgeIntakeApi } from "@/api/knowledgeIntake";
import type { AcceptanceIssue, AcceptanceReport, AssistItem, IntakeItem, IntakeRowInput, IntakeRowType } from "@/api/knowledgeIntake";
import { ReviewQueue, expansionFor, ROOT_KEY } from "./ReviewQueue";
import { ReviewDetail } from "./ReviewDetail";
import { ReviewIssues } from "./ReviewIssues";
import {
  ancestorChain,
  assistForRow,
  buildSheet,
  collectBlockedIds,
  collectSkeletonKeys,
  filterRows,
  flattenRows,
  issuesForRow,
  nextPendingRow,
  rowTitle,
  subtreeIds,
  type QueueView,
  type SheetRow,
} from "./sheet-model";

export interface ReviewWorkbenchProps {
  batchId: string;
  dataVersion: number;
  saving: boolean;
  assistOpenCount: number;
  /** 全部 AI 建议（含已裁决）；面板内只展示 suggested */
  assistItems: AssistItem[];
  /** 节点级字段审核结果（Word 式逐字段审核） */
  nodeReviewItems?: AssistItem[];
  assistBusy: boolean;
  assistRunning?: boolean;
  acceptance: AcceptanceReport | null;
  focusUnit: { unit: string; nonce: number } | null;
  onFocusHandled: () => void;
  onSummaryRefresh: () => void;
  onSave: (rowId: string, patch: IntakeRowInput) => Promise<string>;
  onReviewRow: (action: "approve" | "reject" | "reset", note: string, ids: string[]) => void;
  onReject: (ids: React.Key[] | string[]) => void;
  onDecideAssist: (action: "accept" | "dismiss", item: AssistItem) => void;
  /** 节点级字段内容审核：传入行 ID、行类型、分组 key，AI 审核该分组各字段内容质量 */
  onAssistForRow: (rowId: string, rowType: IntakeRowType, groupKey: string) => void;
  onCreateRow: (rowType: IntakeRowType, parent: { path?: string; ref?: string } | undefined) => void;
  onExpandIntent: (ref: string) => void;
  onBlockingChange: (n: number) => void;
  /** L0 领域名（图谱领域，根节点展示与重命名） */
  domain: string;
  onRenameDomain: () => void;
  onDeleteRow: (row: SheetRow) => void;
  /** AI 补全产生了新修订：父级打开审阅抽屉定位到它 */
  onRevisionCreated: (revId: string) => void;
  /** 存在待裁决修订变更的行 rowId 集合（队列绿「修订」标记） */
  pendingRevisionRowIds: Set<string>;
  /** 待审修订数（页头 Badge） */
  revisionOpenCount: number;
}

export function ReviewWorkbench(props: ReviewWorkbenchProps) {
  const {
    batchId, dataVersion, saving, assistOpenCount, assistItems, nodeReviewItems, assistBusy, assistRunning, acceptance,
    focusUnit, onFocusHandled, onSummaryRefresh, onSave, onReviewRow, onReject,
    onDecideAssist, onAssistForRow, onCreateRow, onExpandIntent, onBlockingChange,
    domain, onRenameDomain, onDeleteRow,
    onRevisionCreated, pendingRevisionRowIds, revisionOpenCount,
  } = props;

  const [rows, setRows] = useState<SheetRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<QueueView>("pending");
  const [keyword, setKeyword] = useState("");
  const [expanded, setExpanded] = useState<React.Key[]>([ROOT_KEY]);
  const [selectedRowId, setSelectedRowId] = useState("");
  const [batchMode, setBatchMode] = useState(false);
  const [batchSelected, setBatchSelected] = useState<React.Key[]>([]);
  const [expanding, setExpanding] = useState(false);
  const [checking, setChecking] = useState(false);
  const [flashId, setFlashId] = useState("");
  const [assistTriggered, setAssistTriggered] = useState(false);
  const [assistTriggeredGroup, setAssistTriggeredGroup] = useState<string | null>(null);

  const rowsRef = useRef<SheetRow[]>([]);
  const selIdRef = useRef("");
  const advanceRef = useRef(false);
  const refreshRef = useRef<() => Promise<void>>(async () => {});

  const flat = useMemo(() => flattenRows(rows), [rows]);
  const flatRef = useRef(flat);
  flatRef.current = flat;

  const selectedRow = selectedRowId ? flat.flatById.get(selectedRowId) || null : null;

  // 切换行时重置 AI 内联审核触发状态
  useEffect(() => {
    setAssistTriggered(false);
    setAssistTriggeredGroup(null);
  }, [selectedRowId]);

  const blockedIds = useMemo(() => collectBlockedIds(rows), [rows]);

  const refresh = useCallback(async () => {
    if (!batchId) return;
    const prevFlat = flattenRows(rowsRef.current);
    const prevSel = selIdRef.current;
    setLoading(true);
    try {
      const [f, i, u] = await Promise.all([
        knowledgeIntakeApi.getItems(batchId, { kind: "functions" }),
        knowledgeIntakeApi.getItems(batchId, { kind: "intents" }),
        knowledgeIntakeApi.getItems(batchId, { kind: "utterances" }),
      ]);
      const items: IntakeItem[] = [...f.items, ...i.items, ...u.items];
      const sheet = buildSheet(items);
      const nextFlat = flattenRows(sheet);
      rowsRef.current = sheet;
      setRows(sheet);
      setExpanded((prev) => {
        const alive = prev.filter((k) => k === ROOT_KEY || nextFlat.flatById.has(String(k)));
        return alive.length > 1 ? alive : [ROOT_KEY, ...collectSkeletonKeys(sheet)];
      });
      // 确认/驳回成功后自动推进到下一个待审（推进仅在行状态真的变化时触发，取消弹窗不误跳）
      const oldRow = prevSel ? prevFlat.flatById.get(prevSel) : undefined;
      const newRow = prevSel ? nextFlat.flatById.get(prevSel) : undefined;
      if (advanceRef.current && oldRow?.status === "pending" && newRow && newRow.status !== "pending") {
        const nxt = nextPendingRow(nextFlat.ordered, prevSel);
        if (nxt) {
          advanceRef.current = false;
          selIdRef.current = nxt.rowId;
          setSelectedRowId(nxt.rowId);
          return;
        }
      }
      advanceRef.current = false;
      if (prevSel && nextFlat.flatById.has(prevSel)) return;
      const firstPending = nextFlat.ordered.find((r) => r.status === "pending");
      const fallback = (firstPending || nextFlat.ordered[0])?.rowId || "";
      selIdRef.current = fallback;
      setSelectedRowId(fallback);
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, [batchId]);

  refreshRef.current = refresh;

  // 换批次：清选择/过滤/批量态，重建队列
  useEffect(() => {
    selIdRef.current = "";
    setSelectedRowId("");
    setBatchSelected([]);
    setKeyword("");
    setView("pending");
    setBatchMode(false);
    setExpanded([ROOT_KEY]);
    rowsRef.current = [];
    void refresh();
  }, [batchId, refresh]);

  // 外部横切动作（审核/编辑/采纳建议）后的兼容刷新
  useEffect(() => {
    if (dataVersion > 0) void refreshRef.current();
  }, [dataVersion]);

  // 阻断项数量上报（页头就绪语句用）
  useEffect(() => {
    onBlockingChange(blockedIds.size);
  }, [blockedIds, onBlockingChange]);

  // 验收问题/AI 建议定位：unit（功能全路径或意图 ref）视图无关解析 → 展开祖先 + 选中 + 高亮
  useEffect(() => {
    if (!focusUnit) return;
    const unit = focusUnit.unit;
    const { flatById, ordered, parentOf } = flatRef.current;
    const target =
      ordered.find((r) => r.ref === unit) ||
      ordered.find((r) => r.path === unit) ||
      ordered.find((r) => r.path && unit && r.path.startsWith(`${unit}/`)) ||
      ordered.find((r) => r.intentRef === unit) ||
      rowsRef.current.find((r) => r.gap && (r.funcPath === unit || r.intentRef === unit));
    if (target && flatById.has(target.rowId)) {
      setExpanded((prev) =>
        Array.from(new Set([ROOT_KEY, ...prev, ...ancestorChain(target.rowId, parentOf)])),
      );
      selIdRef.current = target.rowId;
      setSelectedRowId(target.rowId);
      setFlashId(target.rowId);
      window.setTimeout(() => setFlashId(""), 1800);
    } else {
      message.warning(`定位失败：「${unit}」不在当前批次（可能已删除）`);
    }
    onFocusHandled();
  }, [focusUnit, onFocusHandled]);

  // 选中行移动后滚入可视区（不打断用户手动滚动）
  useEffect(() => {
    if (!selectedRowId) return;
    document.querySelector(".kiq-row-active")?.scrollIntoView({ block: "nearest" });
  }, [selectedRowId]);

  const viewRows = useMemo(
    () => filterRows(rows, view, keyword, blockedIds),
    [rows, view, keyword, blockedIds],
  );

  const orderedSeq = flat.ordered;
  const pos = useMemo(() => {
    const n = orderedSeq.findIndex((r) => r.rowId === selectedRowId);
    return n >= 0 ? { n: n + 1, total: orderedSeq.length } : null;
  }, [orderedSeq, selectedRowId]);

  const crumb = useMemo(() => {
    if (!selectedRow) return "";
    const chain = ancestorChain(selectedRow.rowId, flat.parentOf)
      .map((k) => flat.flatById.get(String(k)))
      .filter(Boolean)
      .map((r) => rowTitle(r as SheetRow));
    return [chain.reverse().join(" / "), rowTitle(selectedRow)].filter(Boolean).join(" / ");
  }, [selectedRow, flat]);

  const siblingUtterances = useMemo(() => {
    if (!selectedRow) return [];
    const list =
      selectedRow.rowType === "utterances"
        ? (flat.flatById.get(flat.parentOf.get(selectedRow.rowId) || "")?.children || [])
        : selectedRow.children;
    return list
      .filter((r) => r.rowType === "utterances" && r.rowId !== selectedRow.rowId)
      .map((r) => ({ rowId: r.rowId, text: r.text || "", status: r.status }));
  }, [selectedRow, flat]);

  const flatIssues = useMemo<AcceptanceIssue[]>(() => {
    if (!acceptance) return [];
    return Object.values(acceptance.dimensions).flatMap((d) => d.issues);
  }, [acceptance]);

  const selectedIssues = useMemo(
    () => (selectedRow ? issuesForRow(selectedRow, flat.parentOf, flat.flatById, flatIssues) : []),
    [selectedRow, flat, flatIssues],
  );

  const selectedAssist = useMemo(() => {
    const open = assistItems.filter((it) => it.status === "suggested");
    return selectedRow ? (assistForRow(selectedRow, flat.parentOf, flat.flatById, open) as AssistItem[]) : [];
  }, [selectedRow, flat, assistItems]);

  const conflictItems = useMemo(() => {
    if (!selectedRow) return [];
    const out: { rowId: string; text: string; reason: string }[] = [];
    const walk = (r: SheetRow) => {
      if (r.conflict?.verdict === "conflict") {
        out.push({ rowId: r.rowId, text: r.text || rowTitle(r), reason: r.conflict.reason });
      }
      r.children.forEach(walk);
    };
    walk(selectedRow);
    return out;
  }, [selectedRow]);

  // 队列徽标：验收问题按 unit 归属 + 冲突/缺口
  const issueCountByRow = useMemo(() => {
    const m = new Map<string, number>();
    const add = (id: string) => m.set(id, (m.get(id) || 0) + 1);
    flatIssues.forEach((iss) => {
      const hit = flat.ordered.find(
        (r) => (r.ref && r.ref === iss.unit) || (r.path && r.path === iss.unit) || (r.intentRef && r.intentRef === iss.unit),
      );
      if (hit) add(hit.rowId);
    });
    blockedIds.forEach((id) => add(id));
    return m;
  }, [flatIssues, flat, blockedIds]);

  // ── 审核动作 ──

  const doApprove = (ids: string[]) => {
    advanceRef.current = true;
    onReviewRow("approve", "", ids);
  };
  const doReject = (ids: React.Key[] | string[]) => {
    advanceRef.current = true;
    onReject(ids);
  };
  const doReset = (ids: string[]) => {
    advanceRef.current = false;
    onReviewRow("reset", "", ids);
  };

  const selectRow = (r: SheetRow) => {
    selIdRef.current = r.rowId;
    setSelectedRowId(r.rowId);
    if (batchMode) return;
    const chain = ancestorChain(r.rowId, flat.parentOf);
    setExpanded((prev) => (chain.some((k) => prev.includes(k)) ? prev : [ROOT_KEY, ...prev, ...chain]));
  };

  const navigateSeq = (delta: number) => {
    if (!orderedSeq.length) return;
    const idx = orderedSeq.findIndex((r) => r.rowId === selectedRowId);
    const next = Math.min(orderedSeq.length - 1, Math.max(0, (idx < 0 ? 0 : idx) + delta));
    selectRow(orderedSeq[next]);
  };

  // ── AI 工具：LLM 补全 / 冲突预检（对象选择契约与原表一致：勾选优先，否则当前视图） ──

  const targetIntentIds = () => {
    const fromSel = batchSelected
      .map((k) => flat.flatById.get(String(k)))
      .filter((r): r is SheetRow => !!r && r.rowType === "intents")
      .map((r) => r.rowId);
    if (fromSel.length) return fromSel;
    const all: string[] = [];
    const walk = (list: SheetRow[]) =>
      list.forEach((r) => {
        if (r.rowType === "intents") all.push(r.rowId);
        walk(r.children);
      });
    walk(viewRows);
    return all;
  };

  const targetUtteranceIds = () => {
    const selIntentIds = new Set(targetIntentIds());
    const intentRowById = new Map(flat.ordered.filter((r) => r.rowType === "intents").map((r) => [r.rowId, r]));
    const refs = new Set(
      [...selIntentIds].map((id) => intentRowById.get(id)?.ref || "").filter(Boolean),
    );
    const out: string[] = [];
    const walk = (list: SheetRow[]) =>
      list.forEach((r) => {
        if (r.rowType === "utterances" && r.status === "pending" && refs.has(r.intentRef || "")) out.push(r.rowId);
        walk(r.children);
      });
    walk(viewRows);
    return out;
  };

  const handleExpandUtterances = async () => {
    const ids = targetIntentIds();
    if (!ids.length) {
      message.warning("当前视图没有可补全的意图");
      return;
    }
    setExpanding(true);
    try {
      const data = await knowledgeIntakeApi.expandUtterances(batchId, ids, 5);
      if (data.added > 0) {
        const autoNote = data.autoApproved || data.autoRejected
          ? `；其中 ${data.autoApproved || 0} 条高置信（≥${data.thresholds?.autoApprove ?? 0.9}）带「AI建议」标签，${data.autoRejected || 0} 条低置信（<${data.thresholds?.autoReject ?? 0.5}）建议复查`
          : "，全部进入待确认";
        message.success(`LLM 已生成 ${data.added} 条扩展问${autoNote}，已挂在对应意图下，请在修订审阅中确认`);
        await refresh();
        onSummaryRefresh();
        if (data.revision?.revId) onRevisionCreated(data.revision.revId);
      } else {
        message.info("没有新增扩展问（可能已全部重复）");
      }
      if (data.errors.length) {
        message.warning(`${data.errors.length} 个意图补全失败`);
      }
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setExpanding(false);
    }
  };

  const handleCheckConflicts = async () => {
    const ids = targetUtteranceIds();
    if (!ids.length) {
      message.warning("当前视图没有待确认的说法可预检");
      return;
    }
    setChecking(true);
    try {
      const data = await knowledgeIntakeApi.checkConflicts(batchId, ids);
      if (data.conflicts > 0) {
        message.warning(`预检完成：${data.conflicts} 条说法疑似挂错意图，已标「冲突」，请优先复核`);
      } else {
        message.success(`预检完成：${data.checked} 条说法均与所属意图匹配`);
      }
      await refresh();
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setChecking(false);
    }
  };

  const exitBatch = () => {
    setBatchMode(false);
    setBatchSelected([]);
  };

  const handleExpandPreset = (preset: "skeleton" | "all" | "none") => {
    setExpanded(expansionFor(rows, preset));
  };

  return (
    <div className="kwb">
      <div className="kwb-tools">
        <Button
          size="small"
          type={batchMode ? "primary" : "text"}
          icon={<CheckOutlined />}
          onClick={() => (batchMode ? exitBatch() : setBatchMode(true))}
        >
          批量选择
        </Button>
        {blockedIds.size > 0 && (
          <Button
            size="small"
            type="text"
            icon={<WarningOutlined style={{ color: "#f5222d" }} />}
            onClick={() => setView("blocked")}
          >
            阻断项 {blockedIds.size}
          </Button>
        )}
        <span style={{ flex: 1 }} />
        <Tooltip title="重新加载本批次数据">
          <Button size="small" type="text" aria-label="刷新" icon={<ReloadOutlined />} onClick={() => void refresh()} />
        </Tooltip>
        <Dropdown
          trigger={["click"]}
          menu={{
            items: [
              { key: "expand", icon: <CloudOutlined />, label: "LLM 补全扩展问" },
              { key: "conflict", icon: <CloseOutlined />, label: "语义冲突预检" },
            ],
            onClick: ({ key }) => {
              if (key === "expand") void handleExpandUtterances();
              else if (key === "conflict") void handleCheckConflicts();
            },
          }}
        >
          <Button size="small" icon={<RobotOutlined style={{ color: "#2878b5" }} />} loading={expanding || checking}>
            AI 助手
          </Button>
        </Dropdown>
      </div>
      <div className="kwb-main">
        <ReviewQueue
          rows={rows}
          loading={loading}
          view={view}
          onViewChange={setView}
          keyword={keyword}
          onKeywordChange={setKeyword}
          selectedRowId={selectedRowId}
          onSelectRow={selectRow}
          expanded={expanded}
          onExpandedChange={setExpanded}
          blockedIds={blockedIds}
          issueCountByRow={issueCountByRow}
          batchMode={batchMode}
          batchSelected={batchSelected}
          onBatchSelectedChange={setBatchSelected}
          onCreateChild={(parent, childType) => onCreateRow(childType, parent)}
          onExpandPreset={handleExpandPreset}
          flashRowId={flashId}
          domain={domain}
          onRenameDomain={onRenameDomain}
          onCreateRoot={() => onCreateRow("functions", undefined)}
          onDeleteRow={onDeleteRow}
          pendingRevisionRowIds={pendingRevisionRowIds}
        />
        <ReviewDetail
          row={selectedRow}
          pos={pos}
          crumb={crumb}
          saving={saving}
          siblingUtterances={siblingUtterances}
          onPrev={() => navigateSeq(-1)}
          onNext={() => navigateSeq(1)}
          onApprove={doApprove}
          onReject={doReject}
          onReset={doReset}
          onSaveEdit={onSave}
          onAiAssist={selectedRow ? (groupKey: string) => {
            setAssistTriggered(true);
            setAssistTriggeredGroup(groupKey);
            onAssistForRow(selectedRow.rowId, selectedRow.rowType, groupKey);
          } : undefined}
          aiAssistBusy={expanding || assistBusy || assistRunning}
          assistItems={assistTriggered ? (nodeReviewItems || []).filter((it) => it.status === "suggested") : []}
          assistTriggeredGroup={assistTriggeredGroup}
          onDecideAssist={onDecideAssist}
        />
        <ReviewIssues
          row={selectedRow ? { rowId: selectedRow.rowId, rowType: selectedRow.rowType, reviewNote: selectedRow.reviewNote } : null}
          issues={selectedIssues}
          conflictItems={conflictItems}
          gapNote={selectedRow?.gap}
          assistItems={selectedAssist}
          assistBusy={assistBusy}
          onDecideAssist={onDecideAssist}
          onLocate={(unit) => {
            const target =
              flat.ordered.find((r) => r.ref === unit) ||
              flat.ordered.find((r) => r.path === unit) ||
              flat.ordered.find((r) => r.intentRef === unit);
            if (target) selectRow(target);
            else message.warning(`定位失败：「${unit}」不在当前批次`);
          }}
          onExpandUtterances={(rowId) => {
            const r = flat.flatById.get(rowId);
            if (r?.ref) onExpandIntent(r.ref);
          }}
        />
        {batchMode && batchSelected.length > 0 && (
          <div className="kwb-batchbar">
            <span className="kwb-batchbar-count">已选 {batchSelected.length} 条（含子级）</span>
            <Button
              size="small"
              type="primary"
              icon={<CheckOutlined />}
              onClick={() => {
                onReviewRow("approve", "", batchSelected.map(String));
                exitBatch();
              }}
            >
              确认所选
            </Button>
            <Button size="small" danger icon={<CloseOutlined />} onClick={() => doReject(batchSelected)}>
              驳回所选
            </Button>
            <Button size="small" onClick={() => doReset(batchSelected.map(String))}>
              撤回重审
            </Button>
            <Button size="small" type="text" aria-label="退出批量模式" icon={<CloseOutlined />} onClick={exitBatch} />
          </div>
        )}
      </div>
    </div>
  );
}
