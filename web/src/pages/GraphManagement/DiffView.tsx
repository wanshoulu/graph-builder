/**
 * 版本对比 — 选两个版本，展示节点/边增删改摘要与明细
 * 数据来源：后端 /assets/:id/diff?from=&to=
 */
import { Alert, Select, Space, Spin, Statistic, Table, Tag, Typography, message } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { fetchAssetDiff, type AssetDiff, type GraphAsset } from '@/api/orgGraph';

const { Text } = Typography;

type VersionItem = { version: string };

export function DiffView({ asset, versions }: { asset: GraphAsset; versions: VersionItem[] }) {
  const [from, setFrom] = useState<string>();
  const [to, setTo] = useState<string>();
  const [diff, setDiff] = useState<AssetDiff | null>(null);
  const [loading, setLoading] = useState(false);

  const opts = versions.map((v) => ({ value: v.version, label: v.version }));

  useEffect(() => {
    if (versions.length >= 2) {
      setFrom(versions[0].version);
      setTo(versions[versions.length - 1].version);
    } else if (versions.length === 1) {
      setFrom(versions[0].version);
      setTo(versions[0].version);
    }
  }, [versions]);

  const load = useCallback(async (f?: string, t?: string) => {
    if (!f || !t) return;
    setLoading(true);
    try {
      setDiff(await fetchAssetDiff(asset.assetId, f, t));
    } catch (e) {
      message.error(e instanceof Error ? e.message : '加载对比失败');
    } finally {
      setLoading(false);
    }
  }, [asset.assetId]);

  useEffect(() => { load(from, to); }, [from, to, load]);

  if (versions.length === 0) {
    return <Alert type="info" showIcon message="暂无版本记录" />;
  }

  const entityCols = [
    { title: 'ID', dataIndex: 'id', width: 170, ellipsis: true },
    { title: '类型', dataIndex: 'type', width: 150, render: (t: string) => <Tag style={{ marginRight: 0 }}>{t}</Tag> },
    { title: '名称', dataIndex: 'name', ellipsis: true, render: (n: string) => n || '-' },
  ];
  const edgeCols = [
    { title: 'ID', dataIndex: 'id', width: 170, ellipsis: true },
    { title: '类型', dataIndex: 'type', width: 140, render: (t: string) => <Tag style={{ marginRight: 0 }}>{t}</Tag> },
    { title: '起点', dataIndex: 'source', width: 150, ellipsis: true },
    { title: '终点', dataIndex: 'target', width: 150, ellipsis: true },
  ];

  function DiffTable({ title, cols, rows, color }: { title: string; cols: object[]; rows: object[]; color: string }) {
    if (!rows.length) return null;
    return (
      <div style={{ marginTop: 12 }}>
        <Tag color={color}>{title}（{rows.length}）</Tag>
        <Table
          size="small"
          rowKey="id"
          columns={cols}
          dataSource={rows}
          pagination={rows.length > 10 ? { pageSize: 10, showSizeChanger: false } : false}
          style={{ marginTop: 8 }}
        />
      </div>
    );
  }

  return (
    <div>
      <Space style={{ marginBottom: 16 }} wrap>
        <Text type="secondary" style={{ fontSize: 12 }}>对比</Text>
        <Select value={from} onChange={setFrom} options={opts} style={{ width: 170 }} placeholder="起始版本" />
        <Text type="secondary">→</Text>
        <Select value={to} onChange={setTo} options={opts} style={{ width: 170 }} placeholder="目标版本" />
      </Space>

      {loading && <Spin style={{ display: 'block', textAlign: 'center', padding: 24 }} />}

      {!loading && diff && (
        <>
          <Space size={32} wrap style={{ marginBottom: 8 }}>
            <Statistic title="节点增 / 删 / 改" valueRender={() => (
              <Text>
                <Text type="success" strong>+{diff.summary.nodes.added}</Text>{' '}
                <Text type="danger" strong>-{diff.summary.nodes.removed}</Text>{' '}
                <Text type="warning" strong>~{diff.summary.nodes.changed}</Text>
                <Text type="secondary" style={{ fontSize: 12 }}>（{diff.summary.nodes.from} → {diff.summary.nodes.to}）</Text>
              </Text>
            )} />
            <Statistic title="边增 / 删 / 改" valueRender={() => (
              <Text>
                <Text type="success" strong>+{diff.summary.edges.added}</Text>{' '}
                <Text type="danger" strong>-{diff.summary.edges.removed}</Text>{' '}
                <Text type="warning" strong>~{diff.summary.edges.changed}</Text>
                <Text type="secondary" style={{ fontSize: 12 }}>（{diff.summary.edges.from} → {diff.summary.edges.to}）</Text>
              </Text>
            )} />
          </Space>

          {diff.summary.nodes.added + diff.summary.nodes.removed + diff.summary.nodes.changed + diff.summary.edges.added + diff.summary.edges.removed + diff.summary.edges.changed === 0 && (
            <Alert type="success" showIcon message="两个版本之间无差异" />
          )}

          <DiffTable title="新增节点" cols={entityCols} rows={diff.nodes.added} color="green" />
          <DiffTable title="删除节点" cols={entityCols} rows={diff.nodes.removed} color="red" />
          <DiffTable title="修改节点" cols={entityCols} rows={diff.nodes.changed} color="orange" />
          <DiffTable title="新增边" cols={edgeCols} rows={diff.edges.added} color="green" />
          <DiffTable title="删除边" cols={edgeCols} rows={diff.edges.removed} color="red" />
          <DiffTable title="修改边" cols={edgeCols} rows={diff.edges.changed} color="orange" />
        </>
      )}
    </div>
  );
}
