/**
 * 审核队列（工作台左栏）：层级导航 + 状态过滤 + 搜索 + 批量选择模式
 * 紧凑树形行（参考线 + 类型图标 + 状态点），挂接缺口组置顶；键盘上下行移动 + Enter 选中（roving tabindex）
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Checkbox, Dropdown, Empty, Input, Tooltip } from "antd";
import {
  AimOutlined,
  DeleteOutlined,
  EditOutlined,
  FolderAddOutlined,
  FolderOutlined,
  MessageOutlined,
  MoreOutlined,
  PartitionOutlined,
  RightOutlined,
  SearchOutlined,
  WarningOutlined,
} from "@ant-design/icons";
import type { IntakeRowType } from "@/api/knowledgeIntake";
import { ROW_TYPE_LABEL } from "./constants";
import {
  collectParentKeys,
  collectSkeletonKeys,
  filterRows,
  rowTitle,
  subtreeIds,
  type QueueView,
  type SheetRow,
} from "./sheet-model";

const TYPE_ICON: Record<IntakeRowType, React.ReactNode> = {
  functions: <FolderOutlined style={{ color: "#64748b", fontSize: 13, flexShrink: 0 }} />,
  intents: <AimOutlined style={{ color: "#8b5cf6", fontSize: 13, flexShrink: 0 }} />,
  utterances: <MessageOutlined style={{ color: "#94a3b8", fontSize: 12, flexShrink: 0 }} />,
};

const STATUS_DOT: Record<string, { color: string; label: string }> = {
  approved: { color: "#22c55e", label: "已确认" },
  pending: { color: "#f59e0b", label: "待确认" },
  rejected: { color: "#ef4444", label: "已驳回" },
};

const VIEW_TABS: { key: QueueView; label: string }[] = [
  { key: "pending", label: "待审核" },
  { key: "approved", label: "已审核" },
  { key: "rejected", label: "已驳回" },
  { key: "blocked", label: "阻断项" },
  { key: "all", label: "全部" },
];

/** 参考线：每个祖先层一条连续竖线 */
function rowGuides(depth: number) {
  return Array.from({ length: depth }, (_, i) => (
    <span key={i} className="kiq-guide">
      <span />
    </span>
  ));
}

export interface ReviewQueueProps {
  rows: SheetRow[];
  loading: boolean;
  view: QueueView;
  onViewChange: (v: QueueView) => void;
  keyword: string;
  onKeywordChange: (v: string) => void;
  selectedRowId: string;
  onSelectRow: (r: SheetRow) => void;
  expanded: React.Key[];
  onExpandedChange: (keys: React.Key[]) => void;
  blockedIds: Set<string>;
  issueCountByRow: Map<string, number>;
  /** 批量模式：勾选 checkbox 才出现 */
  batchMode: boolean;
  batchSelected: React.Key[];
  onBatchSelectedChange: (keys: React.Key[]) => void;
  onCreateChild: (parent: SheetRow, childType: IntakeRowType) => void;
  onExpandPreset: (preset: "skeleton" | "all" | "none") => void;
  /** 外部定位（验收问题/AI 建议）高亮的行，短暂闪烁 */
  flashRowId?: string;
  /** L0 领域名（图谱领域，根节点展示）；空 = 未命名回退 */
  domain?: string;
  /** 根节点菜单：重命名领域 / 新增顶层功能 */
  onRenameDomain?: () => void;
  onCreateRoot?: () => void;
  /** 删除该条目（服务端级联其子级） */
  onDeleteRow?: (r: SheetRow) => void;
  /** 有待裁决修订变更的行 rowId 集合（绿「修订」标记，Word 痕迹入口） */
  pendingRevisionRowIds?: Set<string>;
}

export function ReviewQueue(props: ReviewQueueProps) {
  const {
    rows, loading, view, onViewChange, keyword, onKeywordChange, selectedRowId, onSelectRow,
    expanded, onExpandedChange, blockedIds, issueCountByRow,
    batchMode, batchSelected, onBatchSelectedChange, onCreateChild, onExpandPreset, flashRowId,
    domain, onRenameDomain, onCreateRoot, onDeleteRow, pendingRevisionRowIds,
  } = props;

  const viewRows = useMemo(
    () => filterRows(rows, view, keyword, blockedIds),
    [rows, view, keyword, blockedIds],
  );
  const gaps = viewRows.filter((r) => r.gap);
  const roots = viewRows.filter((r) => !r.gap);
  const visibleCount = useMemo(() => {
    let n = 0;
    const walk = (list: SheetRow[]) => list.forEach((r) => { n += 1; walk(r.children); });
    walk(viewRows);
    return n;
  }, [viewRows]);

  // roving tabindex：活动行索引随 focus 移动，方向键在平铺序列上移动
  const ordered = useMemo(() => {
    const out: SheetRow[] = [];
    const walk = (list: SheetRow[]) => list.forEach((r) => { out.push(r); walk(r.children); });
    walk(viewRows);
    return out;
  }, [viewRows]);
  const listRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  useEffect(() => { setActiveIdx(0); }, [view, keyword, rows]);

  const moveFocus = (delta: number) => {
    const next = Math.min(ordered.length - 1, Math.max(0, activeIdx + delta));
    setActiveIdx(next);
    const el = listRef.current?.querySelector<HTMLElement>(`[data-kiq-index="${next}"]`);
    el?.focus();
  };

  // 根节点：真实层级的树根（顶层功能挂在它下面 depth 1）；不参与选中/n/N
  const totalCount = useMemo(() => {
    let n = 0;
    const walk = (list: SheetRow[]) => list.forEach((r) => { n += 1; walk(r.children); });
    walk(rows);
    return n;
  }, [rows]);
  const rootExpanded = expanded.includes(ROOT_KEY);
  const toggleRoot = () =>
    onExpandedChange(rootExpanded ? expanded.filter((k) => k !== ROOT_KEY) : [...expanded, ROOT_KEY]);
  const domainLabel = (domain || "").trim() || "知识骨架";
  const rootMenu = [
    ...(onCreateRoot ? [{ key: "add-root", icon: <FolderAddOutlined />, label: `新增顶层功能（挂到「${domainLabel}」）` }] : []),
    ...(onRenameDomain ? [{ key: "rename-domain", icon: <EditOutlined />, label: "重命名领域" }] : []),
  ];

  const renderRow = (r: SheetRow, depth: number, index: number) => {
    const dot = STATUS_DOT[r.status] || { color: "#98a2b3", label: r.status };
    const isSelected = r.rowId === selectedRowId;
    const checked = batchSelected.includes(r.rowId);
    const kids = r.children;
    const isExp = expanded.includes(r.rowId);
    const issueN = issueCountByRow.get(r.rowId) || 0;
    const blocked = blockedIds.has(r.rowId);
    // 菜单按层级区分：功能可下挂子功能（路径嵌套）与意图；意图下挂说法；说法无下级
    const childOptions =
      r.rowType === "functions"
        ? [
            { key: "functions", icon: <FolderAddOutlined />, label: `新增子功能（挂到「${r.name}」下）` },
            { key: "intents", icon: <AimOutlined />, label: `新增意图（挂到「${r.name}」下）` },
          ]
        : r.rowType === "intents"
          ? [{ key: "utterances", icon: <MessageOutlined />, label: `新增说法（挂到「${r.name}」下）` }]
          : [];
    const rowMenu = [
      ...childOptions,
      ...(childOptions.length && onDeleteRow ? [{ type: "divider" as const }] : []),
      ...(onDeleteRow
        ? [{
            key: "delete",
            icon: <DeleteOutlined />,
            danger: true,
            label: `删除「${rowTitle(r)}」${r.children.length ? "（级联子级）" : ""}`,
          }]
        : []),
    ];
    return (
      <div
        key={r.rowId}
        data-kiq-index={index}
        role="treeitem"
        aria-selected={isSelected}
        aria-expanded={kids.length ? isExp : undefined}
        tabIndex={index === activeIdx ? 0 : -1}
        className={`kiq-row${isSelected ? " kiq-row-active" : ""}${blocked ? " kiq-row-blocked" : ""}${flashRowId === r.rowId ? " kiq-row-flash" : ""}`}
        onClick={() => onSelectRow(r)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); moveFocus(1); }
          else if (e.key === "ArrowUp") {
            e.preventDefault();
            if (index === 0) rootRef.current?.focus();
            else moveFocus(-1);
          }
          else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelectRow(r); }
          else if (e.key === "ArrowRight" && kids.length && !isExp) onExpandedChange([...expanded, r.rowId]);
          else if (e.key === "ArrowLeft" && kids.length && isExp) onExpandedChange(expanded.filter((k) => k !== r.rowId));
        }}
      >
        {batchMode && (
          <Checkbox
            className="kiq-check"
            checked={checked}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => {
              const on = e.target.checked;
              const ids = subtreeIds(r);
              onBatchSelectedChange(
                on
                  ? Array.from(new Set([...batchSelected, ...ids]))
                  : batchSelected.filter((k) => !ids.includes(String(k))),
              );
            }}
          />
        )}
        {rowGuides(depth)}
        {kids.length ? (
          <span
            className="kiq-chev"
            role="button"
            aria-label={isExp ? "收起" : "展开"}
            style={{ transform: isExp ? "rotate(90deg)" : "rotate(0deg)" }}
            onClick={(e) => {
              e.stopPropagation();
              onExpandedChange(isExp ? expanded.filter((k) => k !== r.rowId) : [...expanded, r.rowId]);
            }}
          >
            <RightOutlined style={{ fontSize: 10 }} />
          </span>
        ) : (
          <span className="kiq-chev-void" />
        )}
        {TYPE_ICON[r.rowType]}
        <span className="kiq-name" title={rowTitle(r)}>{rowTitle(r)}</span>
        {pendingRevisionRowIds?.has(r.rowId) && (
          <Tooltip title="该条目有待确认的修订变更（AI 补全/人工编辑），可在「修订审阅」中采纳或放弃">
            <span
              className="kiq-rev-mark"
              style={{
                fontSize: 11,
                lineHeight: "16px",
                color: "#389e0d",
                background: "#f6ffed",
                border: "1px solid #b7eb8f",
                borderRadius: 4,
                padding: "0 4px",
                flexShrink: 0,
              }}
            >
              修订
            </span>
          </Tooltip>
        )}
        {blocked && <WarningOutlined style={{ color: "#f5222d", fontSize: 11, flexShrink: 0 }} />}
        {issueN > 0 && <span className="kiq-issue-n">{issueN}</span>}
        <span className="kiq-dot" role="img" aria-label={dot.label} title={dot.label} style={{ background: dot.color }} />
        {rowMenu.length > 0 && (
          <Dropdown
            trigger={["click"]}
            menu={{
              items: rowMenu,
              onClick: ({ key, domEvent }) => {
                domEvent.stopPropagation();
                if (key === "delete") onDeleteRow?.(r);
                else onCreateChild(r, key as IntakeRowType);
              },
            }}
          >
            <Button
              className="kiq-more"
              size="small"
              type="text"
              aria-label={`${ROW_TYPE_LABEL[r.rowType]}「${rowTitle(r)}」的更多操作`}
              icon={<MoreOutlined style={{ color: "#98a2b3", fontSize: 12 }} />}
              onClick={(e) => e.stopPropagation()}
            />
          </Dropdown>
        )}
      </div>
    );
  };

  let seq = 0;
  const renderTree = (list: SheetRow[], depth: number): React.ReactNode[] =>
    list.flatMap((r) => {
      const node = renderRow(r, depth, seq);
      seq += 1;
      const kids = expanded.includes(r.rowId) ? renderTree(r.children, depth + 1) : [];
      return [node, ...kids];
    });

  return (
    <div className="kiq" aria-label="审核队列">
      <div className="kiq-toolbar">
        <Input
          size="small"
          allowClear
          prefix={<SearchOutlined style={{ color: "#98a2b3" }} />}
          placeholder="搜索意图名称或关键词"
          value={keyword}
          onChange={(e) => onKeywordChange(e.target.value)}
          aria-label="搜索审核队列"
        />
        <Tooltip title="展开到意图层（说法折叠）/ 全部展开（含说法）/ 全部收起（只看域层）">
          <Dropdown
            trigger={["click"]}
            menu={{
              items: [
                { key: "skeleton", label: "展开到意图层（说法折叠）" },
                { key: "all", label: "全部展开（含说法）" },
                { key: "none", label: "全部收起（只看域层）" },
              ],
              onClick: ({ key }) => onExpandPreset(key as "skeleton" | "all" | "none"),
            }}
          >
            <Button size="small" aria-label="展开层级" icon={<RightOutlined style={{ fontSize: 10 }} />} />
          </Dropdown>
        </Tooltip>
      </div>
      <div className="kiq-tabs" role="tablist" aria-label="队列视图过滤">
        {VIEW_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={view === t.key}
            className={`kiq-tab${view === t.key ? " kiq-tab-on" : ""}`}
            onClick={() => onViewChange(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="kiq-list" ref={listRef} role="tree" aria-label="功能 → 意图 → 说法 层级队列" tabIndex={-1}>
        {ordered.length > 0 && (
          <div
            ref={rootRef}
            role="treeitem"
            aria-expanded={rootExpanded}
            aria-label={`${domainLabel}（展开/收起全部）`}
            tabIndex={0}
            className="kiq-row kiq-root"
            onClick={toggleRoot}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); listRef.current?.querySelector<HTMLElement>('[data-kiq-index="0"]')?.focus(); }
              else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleRoot(); }
              else if (e.key === "ArrowRight" && !rootExpanded) onExpandedChange([...expanded, ROOT_KEY]);
              else if (e.key === "ArrowLeft" && rootExpanded) toggleRoot();
            }}
          >
            <span
              className="kiq-chev"
              style={{ transform: rootExpanded ? "rotate(90deg)" : "rotate(0deg)" }}
            >
              <RightOutlined style={{ fontSize: 10 }} />
            </span>
            <PartitionOutlined style={{ color: "#2878b5", fontSize: 13, flexShrink: 0 }} />
            <span className="kiq-name" title={`${domainLabel} · L0 领域（点击展开/收起）`}>{domainLabel}</span>
            <span className="kiq-root-count">{totalCount}</span>
            {rootMenu.length > 0 && (
              <Dropdown
                trigger={["click"]}
                menu={{
                  items: rootMenu,
                  onClick: ({ key, domEvent }) => {
                    domEvent.stopPropagation();
                    if (key === "add-root") onCreateRoot?.();
                    else if (key === "rename-domain") onRenameDomain?.();
                  },
                }}
              >
                <Button
                  className="kiq-more"
                  size="small"
                  type="text"
                  aria-label={`领域「${domainLabel}」的更多操作`}
                  icon={<MoreOutlined style={{ color: "#98a2b3", fontSize: 12 }} />}
                  onClick={(e) => e.stopPropagation()}
                />
              </Dropdown>
            )}
          </div>
        )}
        {!ordered.length && (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={loading ? "加载中…" : "当前过滤没有条目"}
            style={{ marginTop: 48 }}
          />
        )}
        {gaps.length > 0 && (
          <div className="kiq-gap-group">
            <div className="kiq-gap-head">
              <WarningOutlined style={{ color: "#fa8c16" }} />
              <span>挂接缺口（{gaps.length}）</span>
              <span className="kiq-gap-hint">修改其上级路径或驳回即可消除</span>
            </div>
            {gaps.map((r) => renderRow(r, 0, seq++) )}
          </div>
        )}
        {rootExpanded && renderTree(roots, 1)}
      </div>
      <div className="kiq-foot">
        <span>{visibleCount} 条</span>
        <span className="kiq-foot-hint">↑↓ 移动 · Enter 选中</span>
      </div>
    </div>
  );
}

/** 虚拟树根的展开键：真实层级里所有顶层功能都挂在它下面 */
export const ROOT_KEY = "__root__";

// 展开预设按当前视图计算（保持祖先链完整性由调用方负责传入 rows）；根节点始终随预设给出
export function expansionFor(rows: SheetRow[], preset: "skeleton" | "all" | "none"): React.Key[] {
  if (preset === "none") return [ROOT_KEY];
  const keys = preset === "all" ? collectParentKeys(rows) : collectSkeletonKeys(rows);
  return [ROOT_KEY, ...keys];
}
