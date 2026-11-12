/**
 * 草稿历史抽屉：列出自动归档的草稿快照（覆盖时自动留档，保留最近 30 份），支持一键恢复。
 * 背景：intent-graph 草稿曾被小图自动保存覆盖，历史留档 + 骤减防线是本次事故的兜底措施。
 */
import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Drawer, Popconfirm, Space, Table, Tag, Typography } from 'antd';
import { HistoryOutlined, UndoOutlined } from '@ant-design/icons';
import { message } from '@/utils/antdStatic';
import type { DraftHistoryItem } from '@/api/orgGraph';
import { draftHistory, restoreDraft } from '@/api/orgGraph';

const { Text } = Typography;

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

interface DraftHistoryDrawerProps {
  open: boolean;
  asset: string;
  onClose: () => void;
  /** 恢复成功后回调（父组件负责重新加载草稿） */
  onRestored: () => void;
}

export function DraftHistoryDrawer({ open, asset, onClose, onRestored }: DraftHistoryDrawerProps) {
  const [items, setItems] = useState<DraftHistoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [restoring, setRestoring] = useState('');

  const load = useCallback(async () => {
    if (!asset) return;
    setLoading(true);
    setError('');
    try {
      const res = await draftHistory(asset);
      setItems(res.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载草稿历史失败');
    } finally {
      setLoading(false);
    }
  }, [asset]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  async function handleRestore(item: DraftHistoryItem) {
    if (!asset) return;
    setRestoring(item.file);
    try {
      const res = await restoreDraft(asset, item.file);
      message.success(`已恢复 ${res.nodes} 节点 / ${res.edges} 边；恢复前的草稿已归档为 ${res.previousArchivedAs}`);
      onClose();
      onRestored();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '恢复失败');
    } finally {
      setRestoring('');
    }
  }

  const columns = [
    {
      title: '保存时间',
      dataIndex: 'savedAt',
      width: 170,
      render: (iso: string) => <Text code style={{ fontSize: 12 }}>{formatTime(iso)}</Text>,
    },
    {
      title: '规模',
      key: 'scale',
      width: 150,
      render: (_: unknown, record: DraftHistoryItem) => (
        <Space size={4}>
          <Tag color="blue">{record.nodes} 节点</Tag>
          <Tag color="geekblue">{record.edges} 边</Tag>
        </Space>
      ),
    },
    { title: '大小', dataIndex: 'bytes', width: 80, render: (b: number) => formatBytes(b) },
    {
      title: '操作',
      key: 'action',
      width: 90,
      render: (_: unknown, record: DraftHistoryItem) => (
        <Popconfirm
          title="恢复这份草稿快照？"
          description="当前草稿会先自动归档，不会被删除。"
          okText="恢复"
          cancelText="取消"
          onConfirm={() => handleRestore(record)}
        >
          <Button size="small" icon={<UndoOutlined />} loading={restoring === record.file}>恢复</Button>
        </Popconfirm>
      ),
    },
  ];

  return (
    <Drawer
      title={<Space><HistoryOutlined /> 草稿历史{asset ? ` · ${asset}` : ''}</Space>}
      placement="right"
      width={620}
      open={open}
      onClose={onClose}
      extra={<Button size="small" onClick={load} loading={loading}>刷新</Button>}
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="草稿每次被覆盖修改前会自动归档一份快照（保留最近 30 份）。若草稿被误覆盖（如自动保存了小图），可在此恢复。"
      />
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} action={<Button size="small" onClick={load}>重试</Button>} />}
      <Table
        rowKey="file"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={items}
        pagination={{ pageSize: 10, showSizeChanger: false, showTotal: (t) => `共 ${t} 份快照` }}
        locale={{ emptyText: '暂无草稿历史（草稿首次保存或内容未变化时不会产生归档）' }}
      />
    </Drawer>
  );
}
