/**
 * 内容浏览 — 实体检索 + 类型分布 + 单实体详情（属性/关联边/邻居）
 * 数据口径：资产 active 版本（后端 /assets/:id/content、/assets/:id/entities/:nodeId）
 */
import { Card, Empty, Input, List, Select, Space, Spin, Table, Tag, Typography, message } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useState } from 'react';
import { fetchAssetContent, fetchEntityDetail, type AssetContentPage, type EntityDetail, type GraphAsset } from '@/api/orgGraph';

const { Text } = Typography;

const PAGE_SIZE = 20;

export function ContentBrowser({ asset }: { asset: GraphAsset }) {
  const [data, setData] = useState<AssetContentPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [nodeType, setNodeType] = useState<string | undefined>();
  const [page, setPage] = useState(0);
  const [detail, setDetail] = useState<EntityDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const load = useCallback(async (q: string, type: string | undefined, offset: number) => {
    setLoading(true);
    try {
      setData(await fetchAssetContent(asset.assetId, { q: q || undefined, type, limit: PAGE_SIZE, offset }));
    } catch (e) {
      message.error(e instanceof Error ? e.message : '加载内容失败');
    } finally {
      setLoading(false);
    }
  }, [asset.assetId]);

  useEffect(() => { load('', undefined, 0); }, [load]);

  function search(q = keyword, type = nodeType, offset = 0) {
    setPage(offset);
    load(q, type, offset);
  }

  async function openEntity(nodeId: string) {
    setDetailLoading(true);
    try {
      setDetail(await fetchEntityDetail(asset.assetId, nodeId));
    } catch (e) {
      message.error(e instanceof Error ? e.message : '加载实体失败');
    } finally {
      setDetailLoading(false);
    }
  }

  const typeOptions = data ? Object.entries(data.typeCounts).sort((a, b) => b[1] - a[1]) : [];

  return (
    <div>
      <Space style={{ marginBottom: 12 }} wrap>
        <Input
          allowClear
          prefix={<SearchOutlined style={{ color: '#999' }} />}
          placeholder="按名称 / 属性搜索实体"
          style={{ width: 220 }}
          onPressEnter={() => search()}
          onChange={(e) => setKeyword(e.target.value)}
          onClear={() => { setKeyword(''); search(''); }}
        />
        <Select
          allowClear
          placeholder="全部类型"
          style={{ minWidth: 180 }}
          value={nodeType}
          onChange={(v) => { setNodeType(v); search(keyword, v); }}
          options={typeOptions.map(([t, c]) => ({ value: t, label: `${t}（${c}）` }))}
        />
        <Text type="secondary" style={{ fontSize: 12 }}>
          {data ? `版本 ${data.version} · 共 ${data.total} 实体${keyword || nodeType ? ` / 命中 ${data.matched}` : ''}` : ''}
        </Text>
      </Space>

      <Table<{ id: string; type: string; properties: Record<string, unknown> }>
        size="small"
        rowKey="id"
        loading={loading}
        dataSource={data?.nodes ?? []}
        pagination={{
          pageSize: PAGE_SIZE,
          total: data?.matched ?? 0,
          current: Math.floor(page / PAGE_SIZE) + 1,
          showSizeChanger: false,
          onChange: (p) => search(keyword, nodeType, (p - 1) * PAGE_SIZE),
        }}
        onRow={(record: { id: string }) => ({ onClick: () => openEntity(record.id), style: { cursor: 'pointer' } })}
        columns={[
          { title: 'ID', dataIndex: 'id', width: 170, ellipsis: true },
          { title: '类型', dataIndex: 'type', width: 150, render: (t: string) => <Tag style={{ marginRight: 0 }}>{t}</Tag> },
          {
            title: '名称',
            key: 'name',
            ellipsis: true,
            render: (_: unknown, r: { properties: Record<string, unknown> }) => (
              <Text>{(r.properties?.name ?? r.properties?.title ?? r.properties?.label ?? '-') as string}</Text>
            ),
          },
        ]}
      />

      {detailLoading && <Spin style={{ display: 'block', textAlign: 'center', padding: 16 }} />}
      {detail && !detailLoading && (
        <Card size="small" title={<Space size={6}><Text strong>{detail.node.id}</Text><Tag>{detail.node.type}</Tag><Text type="secondary" style={{ fontSize: 12 }}>度 {detail.degree}</Text></Space>} style={{ marginTop: 12 }}>
          <List
            size="small"
            dataSource={Object.entries(detail.node.properties || {})}
            locale={{ emptyText: '无属性' }}
            renderItem={([k, v]) => (
              <List.Item style={{ padding: '2px 0' }}>
                <Text type="secondary" code style={{ fontSize: 12 }}>{k}</Text>
                <Text style={{ fontSize: 12, marginLeft: 8 }}>{String(v)}</Text>
              </List.Item>
            )}
          />
          <div style={{ marginTop: 8 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>关联边（前 10 条 / 共 {detail.degree}）</Text>
            <List
              size="small"
              dataSource={detail.edges.slice(0, 10)}
              renderItem={(e) => {
                const outgoing = e.source === detail.node.id;
                const other = detail.neighbors.find((n) => n.id === (outgoing ? e.target : e.source));
                return (
                  <List.Item style={{ padding: '2px 0' }}>
                    <Text style={{ fontSize: 12 }}>
                      {outgoing ? '→' : '←'} <Tag style={{ marginRight: 4 }}>{e.type}</Tag>
                      {other ? `${other.id}${(other.properties?.name as string) ? `（${other.properties?.name as string}）` : ''}` : (outgoing ? e.target : e.source)}
                    </Text>
                  </List.Item>
                );
              }}
            />
          </div>
        </Card>
      )}
      {!loading && data && data.matched === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无匹配实体" style={{ padding: 24 }} />}
    </div>
  );
}
