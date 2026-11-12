/**
 * 图谱管理 — 纯函数库（可测试）
 */
import type { GraphStatus, GraphAsset } from '@/api/orgGraph';

export interface VersionTimelineItem {
  version: string;
  publishedAt: string;
  note?: string;
  nodes?: number;
  edges?: number;
  isActive: boolean;
  /** active 版本不可删除/不可重复设为 active */
  canDelete: boolean;
  canSetActive: boolean;
}

/** 版本时间线：按发布时间倒序，标记 active 与可操作性（回滚语义 = 切 active 指针） */
export function buildVersionTimeline(status: GraphStatus): VersionTimelineItem[] {
  const active = status.activeVersion;
  return [...(status.versions || [])]
    .sort((a, b) => (a.published_at < b.published_at ? 1 : -1))
    .map((v) => ({
      version: v.version,
      publishedAt: v.published_at,
      note: v.note,
      nodes: v.stats?.nodes,
      edges: v.stats?.edges,
      isActive: v.version === active,
      canDelete: v.version !== active,
      canSetActive: v.version !== active,
    }));
}

/** 草稿相对回滚的漂移：草稿最后保存早于最近一次回滚 → 发布该草稿会把回滚掉的内容重新发上去 */
export function draftRollbackDrift(status: GraphStatus | null | undefined): { from: string | null; to: string; at: string } | null {
  const draftAt = status?.draft?.updated_at;
  const rollbacks = status?.rollbacks || [];
  if (!draftAt || rollbacks.length === 0) return null;
  const last = rollbacks[rollbacks.length - 1];
  return new Date(draftAt).getTime() < new Date(last.at).getTime() ? last : null;
}

/** assetId 合法性（与后端 ASSET_ID_PATTERN 一致） */
export function isValidAssetId(assetId: string): boolean {
  return /^[a-z][a-z0-9-]{2,63}$/.test(assetId);
}

/** 列表过滤（名称/ID 不区分大小写包含匹配） */
export function filterAssets<T extends { assetId: string; name: string; name_en?: string }>(assets: T[], keyword: string): T[] {
  const key = keyword.trim().toLowerCase();
  if (!key) return assets;
  return assets.filter((a) => a.assetId.toLowerCase().includes(key) || a.name.toLowerCase().includes(key) || (a.name_en?.toLowerCase().includes(key) ?? false));
}

// ── 多维筛选 ──

export type AssetStatus = 'all' | 'published' | 'draft' | 'stale';
export type AssetSource = 'all' | 'builtin' | 'custom';
export type SortField = 'name' | 'createdAt' | 'latestPublishedAt' | 'versionCount' | 'nodeTypes' | 'activeNodes';
export type SortOrder = 'asc' | 'desc';

export interface FilterParams {
  keyword: string;
  status: AssetStatus;
  source: AssetSource;
  templateId: string; // '' = 全部
  sortField: SortField;
  sortOrder: SortOrder;
}

export const DEFAULT_FILTERS: FilterParams = {
  keyword: '',
  status: 'all',
  source: 'all',
  templateId: '',
  sortField: 'latestPublishedAt',
  sortOrder: 'desc',
};

/** 多维筛选 + 排序 */
export function filterAndSortAssets(assets: GraphAsset[], params: FilterParams): GraphAsset[] {
  let result = filterAssets(assets, params.keyword);

  if (params.source === 'builtin') {
    result = result.filter((a) => a.builtin !== false);
  } else if (params.source === 'custom') {
    result = result.filter((a) => a.builtin === false);
  }

  if (params.status === 'published') {
    result = result.filter((a) => a.hasPublished);
  } else if (params.status === 'draft') {
    result = result.filter((a) => a.hasDraft);
  } else if (params.status === 'stale') {
    result = result.filter((a) => !a.hasPublished && !a.hasDraft);
  }

  if (params.templateId) {
    result = result.filter((a) => a.templateId === params.templateId);
  }

  const dir = params.sortOrder === 'asc' ? 1 : -1;
  const sorted = [...result].sort((a, b) => {
    switch (params.sortField) {
      case 'name':
        const cmp = a.name.localeCompare(b.name, 'zh-CN');
        return (cmp !== 0 ? cmp : (a.name_en ?? '').localeCompare(b.name_en ?? '', 'en')) * dir;
      case 'createdAt':
        return ((a.createdAt || '') < (b.createdAt || '') ? -1 : 1) * dir;
      case 'latestPublishedAt':
        return ((a.latestPublishedAt || '') < (b.latestPublishedAt || '') ? -1 : 1) * dir;
      case 'versionCount':
        return ((a.versionCount ?? 0) - (b.versionCount ?? 0)) * dir;
      case 'nodeTypes':
        return (a.nodeTypes.length - b.nodeTypes.length) * dir;
      case 'activeNodes':
        return ((a.activeStats?.nodes ?? 0) - (b.activeStats?.nodes ?? 0)) * dir;
      default:
        return 0;
    }
  });

  return sorted;
}

/** 前端分页 */
export function paginate<T>(items: T[], page: number, pageSize: number): T[] {
  const start = (page - 1) * pageSize;
  return items.slice(start, start + pageSize);
}

/** 计算资产总规模（节点+边） */
export function assetScale(a: GraphAsset): number {
  return (a.activeStats?.nodes ?? 0) + (a.activeStats?.edges ?? 0);
}

/** 格式化数字（带千分位） */
export function fmtNum(n: number | undefined | null): string {
  if (n == null) return '-';
  return n.toLocaleString('zh-CN');
}

/** 格式化日期 */
export function fmtDate(s: string | null | undefined): string {
  if (!s) return '-';
  const d = new Date(s);
  if (isNaN(d.getTime())) return '-';
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

/** 计算资产健康状态：有草稿待发布=warning，已发布=success，无版本=default */
export function assetHealth(a: GraphAsset): { color: string; label: string; tooltip: string } {
  if (a.hasDraft) return { color: 'warning', label: '草稿待发布', tooltip: '存在未发布的草稿' };
  if (a.hasPublished) return { color: 'success', label: '已发布', tooltip: `当前版本 ${a.activeVersion ?? '-'}` };
  return { color: 'default', label: '未发布', tooltip: '尚未发布任何版本' };
}

/** 获取所有模板ID（去重） */
export function getTemplateIds(assets: GraphAsset[]): { id: string; label: string }[] {
  const map = new Map<string, string>();
  for (const a of assets) {
    if (!map.has(a.templateId)) map.set(a.templateId, `${a.templateId} · ${a.templateVersion}`);
  }
  return Array.from(map.entries()).map(([id, label]) => ({ id, label }));
}
