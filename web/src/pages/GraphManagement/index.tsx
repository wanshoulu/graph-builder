/**
 * 图谱管理 — AI Harbor 图谱资产的资产生命周期管理
 *
 * 能力对标业界产品（Neo4j Aura / Stardog / GraphDB / TigerGraph）：
 * - Table / Card 双视图切换（参考 Neo4j Aura 实例卡片 + Stardog Studio 表格视图）
 * - 多维筛选：关键词 + 来源(内置/自建) + 状态(已发布/有草稿/未发布) + 模板（参考 GraphDB Workbench）
 * - 可排序列 + 分页（参考 Stardog Studio）
 * - 批量操作：批量删除自建资产（参考 Knowledge Hub 批量操作）
 * - 行级操作菜单：进入构建 / 详情 / 复制ID / 导出 / 删除
 * - 统计卡片：总数 + 内置 + 自建 + 已发布 + 草稿待发布 + 总节点 + 总边
 *
 * 与图谱构建通过 /knowledge/graph/builder?asset= 深链互通
 */
import { useNavigate } from 'react-router-dom';
import { Badge, Button, Card, Col, Dropdown, Empty, Input, List, Modal, Pagination, Popconfirm, Row, Segmented, Select, Space, Spin, Table, Tag, Tooltip, Typography, message } from 'antd';
import {
  ApartmentOutlined, AppstoreOutlined, AuditOutlined, BarsOutlined, CheckOutlined, CloseOutlined, CopyOutlined, DatabaseOutlined,
  DeleteOutlined, DownloadOutlined, ExportOutlined, EyeOutlined, HistoryOutlined, PlusOutlined, SearchOutlined,
  UnorderedListOutlined,
} from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { decidePublishRequest, deleteAsset, exportGraphToSource, listAssets, listPublishRequests, loadGraph, type GraphAsset, type PublishRequest } from '@/api/orgGraph';
import { knowledgeHubApi, type GraphPublicationInput } from '@/api/knowledgeHub';
import { AssetDetailDrawer } from './AssetDetailDrawer';
import { RegisterAssetModal } from './RegisterAssetModal';
import {
  assetHealth, DEFAULT_FILTERS, filterAndSortAssets, fmtDate, fmtNum,
  getTemplateIds, paginate, type FilterParams,
} from './lib';

const { Title, Text } = Typography;

type ViewMode = 'table' | 'card';

const GraphManagementPage: React.FC = () => {
  const navigate = useNavigate();
  const [assets, setAssets] = useState<GraphAsset[]>([]);
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState<FilterParams>(DEFAULT_FILTERS);
  const [viewMode, setViewMode] = useState<ViewMode>('table');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [detail, setDetail] = useState<GraphAsset | null>(null);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [approvalLoading, setApprovalLoading] = useState(false);
  const [allRequests, setAllRequests] = useState<{ assetId: string; assetName: string; request: PublishRequest }[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setAssets(await listAssets());
    } catch (e) {
      message.error(e instanceof Error ? e.message : '加载资产列表失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // 预加载全局 pending 审批数量（用于 Badge 展示）
  useEffect(() => { if (assets.length > 0) loadApprovalCenter(); /* eslint-disable-next-line */ }, [assets.length]);

  const filtered = useMemo(() => filterAndSortAssets(assets, filters), [assets, filters]);
  // 页码钳制：删除/筛选后 assets 变少，page 可能超出总页数导致空页
  const safePage = Math.min(page, Math.max(1, Math.ceil(filtered.length / pageSize)));
  const paged = useMemo(() => paginate(filtered, safePage, pageSize), [filtered, safePage, pageSize]);
  const templateOptions = useMemo(() => getTemplateIds(assets), [assets]);

  const stats = useMemo(() => {
    const totalNodes = assets.reduce((s, a) => s + (a.activeStats?.nodes ?? 0), 0);
    const totalEdges = assets.reduce((s, a) => s + (a.activeStats?.edges ?? 0), 0);
    return {
      total: assets.length,
      builtin: assets.filter((a) => a.builtin !== false).length,
      custom: assets.filter((a) => a.builtin === false).length,
      published: assets.filter((a) => a.hasPublished).length,
      draft: assets.filter((a) => a.hasDraft).length,
      totalNodes,
      totalEdges,
    };
  }, [assets]);

  // 筛选变化时重置页码
  const updateFilters = (patch: Partial<FilterParams>) => {
    setFilters((prev) => ({ ...prev, ...patch }));
    setPage(1);
    setSelectedIds([]);
  };

  function confirmDelete(asset: GraphAsset) {
    let input = '';
    Modal.confirm({
      title: `删除资产「${asset.name}」？`,
      content: (
        <div>
          <div style={{ marginBottom: 8 }}>将删除：注册表条目、全部草稿、全部已发布版本文件与模板文件，<Text type="danger" strong>不可恢复</Text>。</div>
          <div style={{ marginBottom: 4 }}>请输入 assetId <Text code>{asset.assetId}</Text> 以确认：</div>
          <Input onChange={(e) => { input = e.target.value; }} placeholder={asset.assetId} />
        </div>
      ),
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        if (input !== asset.assetId) {
          message.warning('assetId 不匹配，请输入 ' + asset.assetId + ' 以确认');
          return Promise.reject(new Error('assetId 不匹配'));
        }
        try {
          await deleteAsset(asset.assetId);
          message.success(`资产 ${asset.assetId} 已删除`);
          setDetail(null);
          load();
        } catch (e) {
          message.error(e instanceof Error ? e.message : '删除失败');
          return Promise.reject(e instanceof Error ? e : new Error('删除失败'));
        }
      },
    });
  }

  function confirmBatchDelete() {
    const targets = assets.filter((a) => selectedIds.includes(a.assetId) && a.builtin === false);
    if (targets.length === 0) {
      message.warning('选中资产中无可删除的自建资产（内置资产不可删除）');
      return;
    }
    Modal.confirm({
      title: `批量删除 ${targets.length} 个自建资产？`,
      content: (
        <div>
          <div style={{ marginBottom: 8 }}>以下资产将被删除，<Text type="danger" strong>不可恢复</Text>：</div>
          {targets.map((t) => (
            <div key={t.assetId} style={{ fontSize: 12, marginBottom: 2 }}>
              <Text code>{t.assetId}</Text> {t.name}
            </div>
          ))}
        </div>
      ),
      okText: '批量删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        let ok = 0, fail = 0;
        for (const t of targets) {
          try {
            await deleteAsset(t.assetId);
            ok++;
          } catch {
            fail++;
          }
        }
        if (ok > 0) message.success(`成功删除 ${ok} 个资产`);
        if (fail > 0) message.error(`${fail} 个资产删除失败`);
        setSelectedIds([]);
        load();
      },
    });
  }

  function copyAssetId(assetId: string) {
    navigator.clipboard.writeText(assetId).then(
      () => message.success(`已复制：${assetId}`),
      () => message.error('复制失败'),
    );
  }

  // ── 导出图谱到外部数据源 ──
  async function handleExport(a: GraphAsset) {
    setExporting(true);
    try {
      const doc = await loadGraph(a.assetId);
      const result = await exportGraphToSource(a.assetId, doc);
      message.success(`导出完成：${result.stats.intent_nodes} 意图节点 / ${result.stats.supporting_nodes} 支撑节点 / ${result.stats.edges} 边`);
    } catch (e) {
      message.error(e instanceof Error ? e.message : '导出失败');
    } finally {
      setExporting(false);
    }
  }

  // ── 全局发布审批中心：聚合所有资产的 pending 审批 ──
  async function loadApprovalCenter() {
    setApprovalLoading(true);
    try {
      const results = await Promise.all(
        assets.map(async (a) => {
          try {
            const r = await listPublishRequests(a.assetId);
            return r.requests.map((req) => ({ assetId: a.assetId, assetName: a.name + (a.name_en ? ' / ' + a.name_en : ''), request: req }));
          } catch { return []; }
        }),
      );
      setAllRequests(results.flat().filter((r) => r.request.status === 'pending'));
    } catch (e) {
      message.error(e instanceof Error ? e.message : '加载审批列表失败');
    } finally {
      setApprovalLoading(false);
    }
  }

  /** 审批通过后注册进 Knowledge Hub（与 AssetDetailDrawer 审批路径一致；失败仅告警不阻断） */
  async function registerHubPublication(assetId: string, published: { version: string; stats: { nodes: number; edges: number }; contentDigest: string }) {
    const a = assets.find((x) => x.assetId === assetId);
    if (!a) return;
    const input: GraphPublicationInput = {
      assetId,
      version: published.version,
      name: a.name,
      name_en: a.name_en,
      description: a.description,
      domain: String(assetId).slice(0, 160),
      templateId: a.templateId,
      templateVersion: a.templateVersion,
      nodeCount: published.stats.nodes,
      edgeCount: published.stats.edges,
      contentDigest: published.contentDigest,
      runtimeRef: `/api/org-graph/load?asset=${encodeURIComponent(assetId)}&version=${encodeURIComponent(published.version)}`,
    };
    try {
      await knowledgeHubApi.registerGraphPublication(
        input,
        `graph:${assetId.slice(0, 50)}:${published.version.slice(0, 30)}:${published.contentDigest}`,
      );
      message.success('Knowledge Hub 已注册该图谱版本');
    } catch {
      message.warning('图谱版本已发布，但 Knowledge Hub 注册失败，可在 AI 辅助建图页重试注册');
    }
  }

  async function handleApprove(assetId: string, requestId: string) {
    try {
      const r = await decidePublishRequest(assetId, requestId, true);
      const pub = r.published;
      message.success(`审批通过，已按快照发布 ${pub?.version ?? ''}`);
      if (pub?.version && pub.stats && pub.contentDigest) {
        await registerHubPublication(assetId, { version: pub.version, stats: pub.stats, contentDigest: pub.contentDigest });
      }
      setAllRequests((prev) => prev.filter((x) => x.request.id !== requestId));
      load();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '审批失败');
    }
  }

  async function handleReject(assetId: string, requestId: string) {
    try {
      await decidePublishRequest(assetId, requestId, false);
      message.success('已拒绝');
      setAllRequests((prev) => prev.filter((r) => r.request.id !== requestId));
      load();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '操作失败');
    }
  }

  // 行级操作菜单
  const rowMenuItems = (a: GraphAsset): MenuProps['items'] => [
    { key: 'build', icon: <ExportOutlined />, label: '进入构建', onClick: () => navigate(`/knowledge/graph/builder?asset=${encodeURIComponent(a.assetId)}`) },
    { key: 'detail', icon: <HistoryOutlined />, label: '查看详情', onClick: () => setDetail(a) },
    { key: 'export', icon: <DownloadOutlined />, label: '导出图谱', disabled: exporting, onClick: () => handleExport(a) },
    { type: 'divider' },
    { key: 'copyId', icon: <CopyOutlined />, label: '复制 assetId', onClick: () => copyAssetId(a.assetId) },
    ...(a.builtin === false
      ? [{ key: 'delete', icon: <DeleteOutlined />, danger: true, label: '删除资产', onClick: () => confirmDelete(a) }]
      : []),
  ];

  // ── Table 列定义 ──
  const columns = [
    {
      title: '资产名称',
      key: 'name',
      width: 220,
      sorter: false,
      render: (_: unknown, a: GraphAsset) => (
        <Space size={4} wrap>
          <Text strong>{a.name}</Text>
          {a.name_en && <Text type="secondary" style={{ fontSize: 12 }}>/ {a.name_en}</Text>}
          <Tag color={a.builtin === false ? 'green' : 'blue'} style={{ marginRight: 0 }}>{a.builtin === false ? '自建' : '内置'}</Tag>
          {a.hasDraft && <Tag color="orange" style={{ marginRight: 0 }}>草稿</Tag>}
        </Space>
      ),
    },
    {
      title: 'assetId',
      key: 'assetId',
      width: 160,
      render: (id: string) => <Text code style={{ fontSize: 12 }}>{id}</Text>,
      dataIndex: 'assetId',
    },
    {
      title: '模板',
      key: 'template',
      width: 180,
      render: (_: unknown, a: GraphAsset) => (
        <Tooltip title={`${a.templateId} · ${a.templateVersion}`}>
          <Text type="secondary" style={{ fontSize: 12 }}>{a.templateId}</Text>
        </Tooltip>
      ),
    },
    {
      title: '健康',
      key: 'health',
      width: 100,
      render: (_: unknown, a: GraphAsset) => {
        const h = assetHealth(a);
        return <Tooltip title={h.tooltip}><Tag color={h.color} style={{ marginRight: 0 }}>{h.label}</Tag></Tooltip>;
      },
    },
    {
      title: '活跃版本',
      key: 'active',
      width: 160,
      render: (_: unknown, a: GraphAsset) => a.activeStats ? (
        <Space size={2} style={{ fontSize: 12 }}>
          <Text>{fmtNum(a.activeStats.nodes)} 节点</Text>
          <Text type="secondary">/</Text>
          <Text>{fmtNum(a.activeStats.edges)} 边</Text>
        </Space>
      ) : <Text type="secondary" style={{ fontSize: 12 }}>-</Text>,
    },
    {
      title: '版本数',
      key: 'versionCount',
      width: 80,
      align: 'center' as const,
      render: (_: unknown, a: GraphAsset) => <Tag color={a.hasPublished ? 'green' : 'default'} style={{ marginRight: 0 }}>{a.versionCount ?? 0}</Tag>,
    },
    {
      title: '类型',
      key: 'types',
      width: 120,
      render: (_: unknown, a: GraphAsset) => (
        <Space size={2} style={{ fontSize: 12 }}>
          <Tag style={{ marginRight: 0 }}>{a.nodeTypes.length} 节点</Tag>
          <Tag style={{ marginRight: 0 }}>{a.edgeTypes.length} 边</Tag>
        </Space>
      ),
    },
    {
      title: '最近发布',
      key: 'latestPublishedAt',
      width: 120,
      render: (_: unknown, a: GraphAsset) => <Text type="secondary" style={{ fontSize: 12 }}>{fmtDate(a.latestPublishedAt)}</Text>,
    },
    {
      title: '操作',
      key: 'actions',
      width: 120,
      fixed: 'right' as const,
      render: (_: unknown, a: GraphAsset) => (
        <Space size={4}>
          <Button size="small" type="primary" ghost icon={<ExportOutlined />} onClick={() => navigate(`/knowledge/graph/builder?asset=${encodeURIComponent(a.assetId)}`)}>构建</Button>
          <Dropdown menu={{ items: rowMenuItems(a) }} trigger={['click']}>
            <Button size="small" icon={<UnorderedListOutlined />} />
          </Dropdown>
        </Space>
      ),
    },
  ];

  // ── 统计卡片 ──
  const statCards = [
    { title: '资产总数', value: stats.total, icon: <ApartmentOutlined />, bg: '#e6f4ff', border: '#91caff', color: '#1677ff' },
    { title: '内置资产', value: stats.builtin, icon: <DatabaseOutlined />, bg: '#f6ffed', border: '#b7eb8f', color: '#52c41a' },
    { title: '自建资产', value: stats.custom, icon: <PlusOutlined />, bg: '#f9f0ff', border: '#d3adf7', color: '#722ed1' },
    { title: '已发布', value: stats.published, icon: <EyeOutlined />, bg: '#fff7e6', border: '#ffd591', color: '#fa8c16' },
    { title: '草稿待发布', value: stats.draft, icon: <HistoryOutlined />, bg: '#fff1f0', border: '#ffa39e', color: '#cf1322' },
    { title: '总节点数', value: stats.totalNodes, icon: <ApartmentOutlined />, bg: '#e6fffb', border: '#87e8de', color: '#08979c' },
    { title: '总边数', value: stats.totalEdges, icon: <BarsOutlined />, bg: '#f0f5ff', border: '#adc6ff', color: '#2f54eb' },
  ];

  return (
    <div>
      {/* 标题栏 */}
      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <div>
          <Title level={4} style={{ marginBottom: 4 }}><DatabaseOutlined style={{ color: '#1677ff', marginRight: 8 }} />图谱管理</Title>
          <Text type="secondary">图谱资产管理：注册 · 版本历史 · 回滚 · 草稿管理 · 质量监控 · 批量操作 · 导出 · 审批</Text>
        </div>
        <Space>
          <Badge count={allRequests.length} offset={[-4, 4]}>
            <Button icon={<AuditOutlined />} onClick={() => { setApprovalOpen(true); loadApprovalCenter(); }}>发布审批中心</Button>
          </Badge>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setRegisterOpen(true)}>新建图谱</Button>
        </Space>
      </div>

      {/* 统计卡片 */}
      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        {statCards.map((c) => (
          <Col key={c.title} flex="1 1 0" style={{ minWidth: 140 }}>
            <Card size="small" style={{ background: c.bg, border: `1px solid ${c.border}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ color: c.color, fontSize: 20 }}>{c.icon}</span>
                <div>
                  <div style={{ fontSize: 11, color: '#86909c' }}>{c.title}</div>
                  <div style={{ fontSize: 22, fontWeight: 600, color: c.color, lineHeight: 1.2 }}>{fmtNum(c.value)}</div>
                </div>
              </div>
            </Card>
          </Col>
        ))}
      </Row>

      {/* 筛选栏 + 视图切换 */}
      <Card size="small" styles={{ body: { padding: '12px 16px' } }} style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <Space wrap>
            <Input
              allowClear
              prefix={<SearchOutlined style={{ color: '#999' }} />}
              placeholder="名称 / assetId"
              style={{ width: 200 }}
              value={filters.keyword}
              onChange={(e) => updateFilters({ keyword: e.target.value })}
            />
            <Select
              style={{ width: 120 }}
              value={filters.source}
              onChange={(v) => updateFilters({ source: v })}
              options={[
                { value: 'all', label: '全部来源' },
                { value: 'builtin', label: '内置' },
                { value: 'custom', label: '自建' },
              ]}
            />
            <Select
              style={{ width: 120 }}
              value={filters.status}
              onChange={(v) => updateFilters({ status: v })}
              options={[
                { value: 'all', label: '全部状态' },
                { value: 'published', label: '已发布' },
                { value: 'draft', label: '有草稿' },
                { value: 'stale', label: '未发布' },
              ]}
            />
            {templateOptions.length > 0 && (
              <Select
                style={{ width: 180 }}
                placeholder="按模板筛选"
                allowClear
                value={filters.templateId || undefined}
                onChange={(v) => updateFilters({ templateId: v || '' })}
                options={templateOptions.map((t) => ({ value: t.id, label: t.label }))}
              />
            )}
            <Select
              style={{ width: 130 }}
              value={filters.sortField}
              onChange={(v) => updateFilters({ sortField: v })}
              options={[
                { value: 'latestPublishedAt', label: '按发布时间' },
                { value: 'createdAt', label: '按创建时间' },
                { value: 'name', label: '按名称' },
                { value: 'versionCount', label: '按版本数' },
                { value: 'activeNodes', label: '按节点规模' },
                { value: 'nodeTypes', label: '按类型数' },
              ]}
            />
            <Button
              size="small"
              type={filters.sortOrder === 'desc' ? 'primary' : 'default'}
              onClick={() => updateFilters({ sortOrder: filters.sortOrder === 'desc' ? 'asc' : 'desc' })}
            >
              {filters.sortOrder === 'desc' ? '↓ 降序' : '↑ 升序'}
            </Button>
          </Space>
          <Space>
            {selectedIds.length > 0 && (
              <Button danger icon={<DeleteOutlined />} onClick={confirmBatchDelete}>
                批量删除({selectedIds.length})
              </Button>
            )}
            <Segmented
              size="small"
              value={viewMode}
              onChange={(v) => setViewMode(v as ViewMode)}
              options={[
                { value: 'table', icon: <BarsOutlined />, label: '表格' },
                { value: 'card', icon: <AppstoreOutlined />, label: '卡片' },
              ]}
            />
          </Space>
        </div>
        <div style={{ marginTop: 8, fontSize: 12, color: '#86909c' }}>
          共 {filtered.length} / {assets.length} 个资产{selectedIds.length > 0 ? `，已选 ${selectedIds.length} 个` : ''}
        </div>
      </Card>

      {/* 列表内容 */}
      <Card size="small" styles={{ body: { padding: 0 } }}>
        {loading ? <Spin style={{ display: 'block', textAlign: 'center', padding: 48 }} /> : filtered.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={filters.keyword ? '无匹配资产' : '暂无资产'} style={{ padding: 48 }} />
        ) : viewMode === 'table' ? (
          <>
            <Table<GraphAsset>
              rowKey="assetId"
              columns={columns}
              dataSource={paged}
              pagination={false}
              size="small"
              scroll={{ x: 1200 }}
              rowSelection={{
                selectedRowKeys: selectedIds,
                onChange: (keys) => setSelectedIds(keys.map(String)),
                getCheckboxProps: (a) => ({ disabled: a.builtin !== false }),
              }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '8px 16px' }}>
              <Pagination
                size="small"
                current={safePage}
                pageSize={pageSize}
                total={filtered.length}
                showSizeChanger
                showTotal={(t) => `共 ${t} 个资产`}
                pageSizeOptions={[10, 20, 50]}
                onChange={(p, ps) => { setPage(p); setPageSize(ps); }}
              />
            </div>
          </>
        ) : (
          <>
            <Row gutter={[12, 12]} style={{ padding: 12 }}>
              {paged.map((a) => {
                const h = assetHealth(a);
                return (
                  <Col key={a.assetId} xs={24} sm={12} md={8} lg={6}>
                    <Card
                      size="small"
                      hoverable
                      style={{
                        border: selectedIds.includes(a.assetId) ? '2px solid #1677ff' : '1px solid #f0f0f0',
                        cursor: 'pointer',
                      }}
                      onClick={() => setDetail(a)}
                      actions={[
                        <Tooltip key="build" title="进入构建">
                          <ExportOutlined onClick={(e) => { e.stopPropagation(); navigate(`/knowledge/graph/builder?asset=${encodeURIComponent(a.assetId)}`); }} />
                        </Tooltip>,
                        <Tooltip key="detail" title="查看详情">
                          <HistoryOutlined />
                        </Tooltip>,
                        <Tooltip key="copy" title="复制ID">
                          <CopyOutlined onClick={(e) => { e.stopPropagation(); copyAssetId(a.assetId); }} />
                        </Tooltip>,
                        ...(a.builtin === false ? [
                          <Tooltip key="del" title="删除">
                            <DeleteOutlined onClick={(e) => { e.stopPropagation(); confirmDelete(a); }} style={{ color: '#ff4d4f' }} />
                          </Tooltip>,
                        ] : []),
                      ]}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                        <Text strong>{a.name}</Text>
                        {a.name_en && <Text type="secondary" style={{ fontSize: 12, marginLeft: 6 }}>/ {a.name_en}</Text>}
                        <Tag color={a.builtin === false ? 'green' : 'blue'} style={{ marginRight: 0 }}>{a.builtin === false ? '自建' : '内置'}</Tag>
                      </div>
                      <div style={{ fontSize: 12, color: '#86909c', marginBottom: 8 }}>
                        <Text code style={{ fontSize: 11 }}>{a.assetId}</Text>
                      </div>
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8 }}>
                        <Tag color={h.color} style={{ marginRight: 0 }}>{h.label}</Tag>
                        <Tag style={{ marginRight: 0 }}>{a.versionCount ?? 0} 版本</Tag>
                        <Tag style={{ marginRight: 0 }}>{a.nodeTypes.length}+{a.edgeTypes.length} 类型</Tag>
                      </div>
                      {a.activeStats && (
                        <div style={{ fontSize: 11, color: '#4e5969' }}>
                          {fmtNum(a.activeStats.nodes)} 节点 · {fmtNum(a.activeStats.edges)} 边
                        </div>
                      )}
                      <div style={{ fontSize: 11, color: '#c9cdd4', marginTop: 4 }}>
                        {a.description || fmtDate(a.latestPublishedAt)}
                      </div>
                    </Card>
                  </Col>
                );
              })}
            </Row>
            <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '8px 16px' }}>
              <Pagination
                size="small"
                current={safePage}
                pageSize={pageSize}
                total={filtered.length}
                showSizeChanger
                showTotal={(t) => `共 ${t} 个资产`}
                pageSizeOptions={[12, 24, 48]}
                onChange={(p, ps) => { setPage(p); setPageSize(ps); }}
              />
            </div>
          </>
        )}
      </Card>

      {/* 全局发布审批中心 */}
      <Modal
        title={<Space><AuditOutlined />发布审批中心<Badge count={allRequests.length} /></Space>}
        open={approvalOpen}
        onCancel={() => setApprovalOpen(false)}
        footer={<Button onClick={() => setApprovalOpen(false)}>关闭</Button>}
        width={680}
        destroyOnHidden
      >
        {approvalLoading ? <Spin style={{ display: 'block', textAlign: 'center', padding: 48 }} /> : allRequests.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前无待审批的发布申请。启用 REQUIRE_PUBLISH_APPROVAL 后，草稿发布需先提交审批" style={{ padding: 48 }} />
        ) : (
          <List
            size="small"
            dataSource={allRequests}
            renderItem={(item) => (
              <List.Item
                style={{ padding: '8px 0' }}
                actions={[
                  <Popconfirm key="ok" title="通过并发布？" description="按提交时的快照发布为新版本（非当前草稿）" okText="通过" cancelText="取消" onConfirm={() => handleApprove(item.assetId, item.request.id)}>
                    <Button size="small" type="primary" ghost icon={<CheckOutlined />}>通过</Button>
                  </Popconfirm>,
                  <Popconfirm key="no" title="拒绝该申请？" okText="拒绝" okType="danger" cancelText="取消" onConfirm={() => handleReject(item.assetId, item.request.id)}>
                    <Button size="small" danger icon={<CloseOutlined />}>拒绝</Button>
                  </Popconfirm>,
                ]}
              >
                <div style={{ width: '100%' }}>
                  <Space size={6} wrap>
                    <Tag color="orange" style={{ marginRight: 0 }}>待审批</Tag>
                    <Text strong>{item.assetName}</Text>
                    <Text code style={{ fontSize: 11 }}>{item.assetId}</Text>
                  </Space>
                  <div style={{ marginTop: 4 }}>
                    <Space size={6} wrap>
                      <Text type="secondary" style={{ fontSize: 12 }}>申请ID: <Text code style={{ fontSize: 11 }}>{item.request.id}</Text></Text>
                      <Text type="secondary" style={{ fontSize: 12 }}>{item.request.stats.nodes} 节点 / {item.request.stats.edges} 边</Text>
                      <Text type="secondary" style={{ fontSize: 12 }}>{new Date(item.request.createdAt).toLocaleString('zh-CN')}</Text>
                    </Space>
                  </div>
                  {item.request.note && <div><Text type="secondary" style={{ fontSize: 12 }}>说明：{item.request.note}</Text></div>}
                </div>
              </List.Item>
            )}
          />
        )}
      </Modal>

      <AssetDetailDrawer asset={detail} onClose={() => setDetail(null)} onChanged={load} />
      <RegisterAssetModal open={registerOpen} onClose={() => setRegisterOpen(false)} onCreated={() => load()} />
    </div>
  );
};

export default GraphManagementPage;
