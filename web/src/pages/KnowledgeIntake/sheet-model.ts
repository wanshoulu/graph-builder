/**
 * 审核工作台数据模型（纯函数，无 React 依赖——node --test 可直接跑）
 * 层级组装规则与服务端 buildBatchTree 同源：功能按 path 前缀嵌套（父先于子）、意图挂 funcPath、说法挂 intentRef
 */
import type { IntakeItem, IntakeRowType } from "@/api/knowledgeIntake";

/** 工作台行 = 原始条目 + 组装出的层级子级行 + 挂接缺口标记 */
export interface SheetRow extends IntakeItem {
  children: SheetRow[];
  /** 层级深度（根功能 0） */
  depth: number;
  /** 有值 = 该行没挂上父级（所属功能/意图未登记），置顶展示提醒先修 */
  gap?: string;
}

export function buildSheet(items: IntakeItem[]): SheetRow[] {
  const functions = items.filter((r) => r.rowType === "functions");
  const intents = items.filter((r) => r.rowType === "intents");
  const utterances = items.filter((r) => r.rowType === "utterances");
  const byPath = new Map<string, SheetRow>();
  const roots: SheetRow[] = [];
  const gaps: SheetRow[] = [];
  [...functions]
    .sort((a, b) => (a.path || "").localeCompare(b.path || ""))
    .forEach((f) => {
      const segs = (f.path || "").split("/");
      let parent: SheetRow | undefined;
      for (let i = segs.length - 1; i >= 1 && !parent; i--) {
        parent = byPath.get(segs.slice(0, i).join("/"));
      }
      const row: SheetRow = { ...f, children: [], depth: parent ? parent.depth + 1 : 0 };
      byPath.set(f.path || "", row);
      (parent ? parent.children : roots).push(row);
    });
  const intentByRef = new Map<string, SheetRow>();
  intents.forEach((it) => {
    const parent = it.funcPath ? byPath.get(it.funcPath) : undefined;
    const row: SheetRow = { ...it, children: [], depth: parent ? parent.depth + 1 : 0 };
    if (it.ref) intentByRef.set(it.ref, row);
    if (parent) parent.children.push(row);
    else gaps.push({ ...row, gap: it.funcPath ? `所属功能「${it.funcPath}」未登记` : "缺少所属功能路径" });
  });
  utterances.forEach((u) => {
    const parent = u.intentRef ? intentByRef.get(u.intentRef) : undefined;
    const row: SheetRow = { ...u, children: [], depth: parent ? parent.depth + 1 : 0 };
    if (parent) parent.children.push(row);
    else gaps.push({ ...row, gap: u.intentRef ? `所属意图「${u.intentRef}」未登记` : "缺少所属意图标识" });
  });
  return [...gaps, ...roots];
}

export function flattenRows(rows: SheetRow[]): { flatById: Map<string, SheetRow>; parentOf: Map<string, string>; ordered: SheetRow[] } {
  const byId = new Map<string, SheetRow>();
  const par = new Map<string, string>();
  const ordered: SheetRow[] = [];
  const walk = (list: SheetRow[], parentKey: string) =>
    list.forEach((r) => {
      byId.set(r.rowId, r);
      par.set(r.rowId, parentKey);
      ordered.push(r);
      walk(r.children, r.rowId);
    });
  walk(rows, "");
  return { flatById: byId, parentOf: par, ordered };
}

export function collectParentKeys(rows: SheetRow[]): React.Key[] {
  return rows.flatMap((r) => (r.children.length ? [r.rowId, ...collectParentKeys(r.children)] : []));
}

/** 只展开功能行：功能整棵骨架 + 意图可见，说法折叠（审核单元是功能/意图） */
export function collectSkeletonKeys(rows: SheetRow[]): React.Key[] {
  return rows.flatMap((r) => (r.children.length && r.rowType === "functions" ? [r.rowId, ...collectSkeletonKeys(r.children)] : []));
}

/** 整块含子级（确认/驳回的级联语义） */
export function subtreeIds(r: SheetRow): string[] {
  return [r.rowId, ...r.children.flatMap(subtreeIds)];
}

export function ancestorChain(rowId: string, parentOf: Map<string, string>): React.Key[] {
  const chain: React.Key[] = [];
  let p = parentOf.get(rowId);
  while (p) {
    chain.push(p);
    p = parentOf.get(p);
  }
  return chain;
}

export type QueueView = "pending" | "approved" | "rejected" | "blocked" | "all";

/** 状态×搜索视图过滤：命中行 + 祖先链保留；blocked = 自身或子树内有阻断（缺口/冲突） */
export function filterRows(rows: SheetRow[], view: QueueView, keyword: string, blockedIds: Set<string>): SheetRow[] {
  const kw = keyword.trim();
  const hit = (r: SheetRow) =>
    !kw ||
    [r.path, r.name, r.ref, r.text, r.description, r.intentRef, r.funcPath, r.kind, r.source, r.department].some(
      (v) => String(v || "").includes(kw),
    );
  const statusOk = (r: SheetRow) => {
    if (view === "all") return true;
    if (view === "blocked") return blockedIds.has(r.rowId);
    return r.status === view;
  };
  const walk = (list: SheetRow[]): SheetRow[] =>
    list
      .map((r) => {
        const children = walk(r.children);
        return (statusOk(r) && hit(r)) || children.length ? { ...r, children } : null;
      })
      .filter(Boolean) as SheetRow[];
  return walk(rows);
}

/** 阻断行集合：挂接缺口行 + 预检冲突说法行；祖先会在 filterRows 中凭子树命中而保留 */
export function collectBlockedIds(rows: SheetRow[]): Set<string> {
  const out = new Set<string>();
  const walk = (list: SheetRow[]) =>
    list.forEach((r) => {
      if (r.gap || r.conflict?.verdict === "conflict") out.add(r.rowId);
      walk(r.children);
    });
  walk(rows);
  return out;
}

/** 行展示名：功能/意图用 name，说法用 text */
export function rowTitle(r: SheetRow): string {
  return r.rowType === "utterances" ? r.text || "（无文本）" : r.name || r.path || "（未命名）";
}

/** 审核序列的「下一项」：视图内从当前行之后找第一个 pending 行；找不到则从头找（跳过当前行） */
export function nextPendingRow(ordered: SheetRow[], currentId: string): SheetRow | null {
  const idx = ordered.findIndex((r) => r.rowId === currentId);
  for (let i = idx + 1; i < ordered.length; i += 1) {
    if (ordered[i].status === "pending") return ordered[i];
  }
  for (let i = 0; i < ordered.length; i += 1) {
    if (ordered[i].rowId !== currentId && ordered[i].status === "pending") return ordered[i];
  }
  return null;
}

export function countByStatus(rows: SheetRow[]): Record<IntakeRowType, { total: number; approved: number; pending: number; rejected: number }> {
  const blank = () => ({ total: 0, approved: 0, pending: 0, rejected: 0 });
  const acc: Record<IntakeRowType, ReturnType<typeof blank>> = {
    functions: blank(), intents: blank(), utterances: blank(),
  };
  const walk = (list: SheetRow[]) =>
    list.forEach((r) => {
      const c = acc[r.rowType];
      if (!c) return;
      c.total += 1;
      if (r.status === "approved" || r.status === "pending" || r.status === "rejected") c[r.status] += 1;
      walk(r.children);
    });
  walk(rows);
  return acc;
}

/** 验收问题的归属键：功能 path / 意图 ref / 说法挂的 intentRef，加祖先链（选中说法也能看到其意图的问题） */
export function resolveKeysForRow(row: SheetRow, parentOf: Map<string, string>, flatById: Map<string, SheetRow>): Set<string> {
  const keys = new Set<string>(
    [row.rowId, row.ref || "", row.intentRef || "", row.path || "", row.funcPath || ""].filter(Boolean),
  );
  let p = parentOf.get(row.rowId);
  while (p) {
    const pr = flatById.get(p);
    if (pr) {
      if (pr.ref) keys.add(pr.ref);
      if (pr.path) keys.add(pr.path);
    }
    p = parentOf.get(p);
  }
  return keys;
}

export interface AcceptanceIssueLike {
  level: "error" | "warn" | "info";
  unit: string;
  message: string;
}

export function issuesForRow(
  row: SheetRow,
  parentOf: Map<string, string>,
  flatById: Map<string, SheetRow>,
  issues: AcceptanceIssueLike[],
): AcceptanceIssueLike[] {
  const keys = resolveKeysForRow(row, parentOf, flatById);
  return issues.filter((i) => keys.has(i.unit));
}

/** 与选中行相关的 AI 骨架建议：payload.ref/refs 或 path 前缀匹配（含祖先功能 path） */
export interface AssistItemLike {
  id: string;
  payload: { type?: string; path?: string; ref?: string; refs?: string[] };
}

export function assistForRow(row: SheetRow, parentOf: Map<string, string>, flatById: Map<string, SheetRow>, items: AssistItemLike[]): AssistItemLike[] {
  const keys = resolveKeysForRow(row, parentOf, flatById);
  return items.filter((it) => {
    if (it.payload.ref && keys.has(it.payload.ref)) return true;
    if (it.payload.refs?.some((r) => keys.has(r))) return true;
    const p = it.payload.path;
    if (!p) return false;
    for (const k of keys) {
      if (k && (String(k) === p || String(k).startsWith(`${p}/`))) return true;
    }
    return false;
  });
}
