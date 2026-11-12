/**
 * 版本 diff 对比抽屉
 *
 * 选择两个版本（草稿 / 已发布版本），加载两份 GraphDocument，
 * 调用 diffGraphDocuments 纯函数计算差异，在 Drawer 中展示：
 *   - 节点增删改列表（颜色标记 + 变更字段明细）
 *   - 边增删改列表
 *   - 汇总统计
 */
import { useCallback, useEffect, useState } from 'react';
import { Drawer, Select, Spin, Tag, Empty, Button, Space, Typography, Collapse } from 'antd';
import { message } from '@/utils/antdStatic';
import { ArrowRightOutlined, DiffOutlined } from '@ant-design/icons';
import type { GraphDocument, GraphStatus } from '@/api/orgGraph';
import { loadGraph } from '@/api/orgGraph';
import { diffGraphDocuments, type GraphDiffResult } from '../lib/graphDiff';

const { Text } = Typography;

interface VersionDiffDrawerProps {
  open: boolean;
  onClose: () => void;
  asset: string;
  status: GraphStatus | null;
}

interface VersionOption {
  value: string;
  label: string;
}

export function VersionDiffDrawer({ open, onClose, asset, status }: VersionDiffDrawerProps) {
  const [baselineVer, setBaselineVer] = useState<string | undefined>(undefined);
  const [targetVer, setTargetVer] = useState<string | undefined>(undefined);
  const [diffResult, setDiffResult] = useState<GraphDiffResult | null>(null);
  const [comparing, setComparing] = useState(false);

  const versionOptions: VersionOption[] = [
    { value: 'draft', label: '草稿' },
    ...(status?.versions.map((v) => ({
      value: v.version,
      label: `${v.version}${v.note ? ' · ' + v.note : ''}`,
    })) || []),
  ];

  const reset = useCallback(() => {
    setBaselineVer(undefined);
    setTargetVer(undefined);
    setDiffResult(null);
  }, []);

  // 切换资产时重置
  useEffect(() => {
    if (open) reset();
  }, [open, asset, reset]);

  const labelForVer = (ver: string): string => {
    if (ver === 'draft') return '草稿';
    return ver;
  };

  const handleCompare = useCallback(async () => {
    if (!asset || !baselineVer || !targetVer) {
      message.warning('请选择两个版本进行对比');
      return;
    }
    if (baselineVer === targetVer) {
      message.warning('请选择不同的版本');
      return;
    }
    setComparing(true);
    setDiffResult(null);
    try {
      const [baseDoc, targetDoc] = await Promise.all([
        loadGraph(asset, baselineVer),
        loadGraph(asset, targetVer),
      ]);
      const result = diffGraphDocuments(baseDoc, targetDoc, labelForVer(baselineVer), labelForVer(targetVer));
      setDiffResult(result);
    } catch (e) {
      message.error(e instanceof Error ? e.message : '加载版本失败');
    } finally {
      setComparing(false);
    }
  }, [asset, baselineVer, targetVer]);

  const renderChangeValue = (val: unknown): string => {
    if (val === undefined || val === null) return '(空)';
    if (typeof val === 'object') return JSON.stringify(val);
    return String(val);
  };

  const renderNodeEntries = (kind: 'added' | 'removed' | 'modified') => {
    const entries = diffResult?.nodes.filter((n) => n.kind === kind) || [];
    if (entries.length === 0) return null;
    const colorMap = { added: 'green', removed: 'red', modified: 'orange' };
    const labelMap = { added: '新增', removed: '删除', modified: '修改' };
    return (
      <Collapse
        size="small"
        defaultActiveKey={entries.length <= 5 ? [kind] : []}
        style={{ marginBottom: 8 }}
        items={[{
          key: kind,
          label: (
            <Space>
              <Tag color={colorMap[kind]}>{labelMap[kind]}</Tag>
              <Text>{entries.length} 个节点</Text>
            </Space>
          ),
          children: entries.map((entry) => (
            <div key={entry.id} style={{ padding: '4px 0', borderBottom: '1px solid #f0f0f0' }}>
              <Space size={4} wrap>
                <Tag color={colorMap[kind]} style={{ margin: 0 }}>{entry.type || '?'}</Tag>
                <Text strong style={{ fontSize: 12 }}>{entry.label}</Text>
                {entry.kind === 'modified' && entry.changes && (
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    {entry.changes.map((c) => {
                      const label = c.field === '_type' ? '类型' : c.field;
                      return `${label}: ${renderChangeValue(c.oldValue)} → ${renderChangeValue(c.newValue)}`;
                    }).join('，')}
                  </Text>
                )}
              </Space>
            </div>
          )),
        }]}
      />
    );
  };

  const renderEdgeEntries = (kind: 'added' | 'removed' | 'modified') => {
    const entries = diffResult?.edges.filter((e) => e.kind === kind) || [];
    if (entries.length === 0) return null;
    const colorMap = { added: 'green', removed: 'red', modified: 'orange' };
    const labelMap = { added: '新增', removed: '删除', modified: '修改' };
    return (
      <Collapse
        size="small"
        defaultActiveKey={entries.length <= 5 ? [kind] : []}
        style={{ marginBottom: 8 }}
        items={[{
          key: kind,
          label: (
            <Space>
              <Tag color={colorMap[kind]}>{labelMap[kind]}</Tag>
              <Text>{entries.length} 条边</Text>
            </Space>
          ),
          children: entries.map((entry) => (
            <div key={entry.id} style={{ padding: '4px 0', borderBottom: '1px solid #f0f0f0' }}>
              <Space size={4} wrap>
                <Tag color={colorMap[kind]} style={{ margin: 0 }}>{entry.type || '?'}</Tag>
                <Text style={{ fontSize: 12 }}>{entry.source}</Text>
                <ArrowRightOutlined style={{ fontSize: 10, color: '#86909c' }} />
                <Text style={{ fontSize: 12 }}>{entry.target}</Text>
                {entry.kind === 'modified' && entry.changes && (
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    {entry.changes.map((c) => {
                      const label = c.field === '_type' ? '类型' : c.field === '_source' ? '起点' : c.field === '_target' ? '终点' : c.field;
                      return `${label}: ${renderChangeValue(c.oldValue)} → ${renderChangeValue(c.newValue)}`;
                    }).join('，')}
                  </Text>
                )}
              </Space>
            </div>
          )),
        }]}
      />
    );
  };

  const hasNodeDiff = diffResult && (diffResult.stats.nodesAdded + diffResult.stats.nodesRemoved + diffResult.stats.nodesModified > 0);
  const hasEdgeDiff = diffResult && (diffResult.stats.edgesAdded + diffResult.stats.edgesRemoved + diffResult.stats.edgesModified > 0);

  return (
    <Drawer
      title="版本对比"
      open={open}
      onClose={onClose}
      width={560}
      destroyOnHidden
    >
      {/* 版本选择器 */}
      <div style={{ marginBottom: 16 }}>
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Select
              style={{ flex: 1 }}
              size="small"
              placeholder="基线版本（旧）"
              value={baselineVer}
              onChange={setBaselineVer}
              options={versionOptions}
            />
            <ArrowRightOutlined style={{ color: '#86909c' }} />
            <Select
              style={{ flex: 1 }}
              size="small"
              placeholder="目标版本（新）"
              value={targetVer}
              onChange={setTargetVer}
              options={versionOptions}
            />
          </div>
          <Button
            type="primary"
            icon={<DiffOutlined />}
            loading={comparing}
            disabled={!baselineVer || !targetVer || baselineVer === targetVer}
            onClick={handleCompare}
          >
            对比
          </Button>
        </Space>
      </div>

      {comparing && <div style={{ textAlign: 'center', padding: 48 }}><Spin tip="加载版本数据中…" /></div>}

      {!comparing && diffResult && (
        <>
          {/* 汇总统计 */}
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 16,
          }}>
            <div style={{ background: '#f6ffed', border: '1px solid #b7eb8f', borderRadius: 6, padding: '8px 4px', textAlign: 'center' }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: '#389e0d' }}>
                {diffResult.stats.nodesAdded + diffResult.stats.edgesAdded}
              </div>
              <div style={{ fontSize: 11, color: '#5b8c00' }}>新增</div>
            </div>
            <div style={{ background: '#fff2e8', border: '1px solid #ffbb96', borderRadius: 6, padding: '8px 4px', textAlign: 'center' }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: '#d4380d' }}>
                {diffResult.stats.nodesModified + diffResult.stats.edgesModified}
              </div>
              <div style={{ fontSize: 11, color: '#874d00' }}>修改</div>
            </div>
            <div style={{ background: '#fff1f0', border: '1px solid #ffa39e', borderRadius: 6, padding: '8px 4px', textAlign: 'center' }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: '#cf1322' }}>
                {diffResult.stats.nodesRemoved + diffResult.stats.edgesRemoved}
              </div>
              <div style={{ fontSize: 11, color: '#820014' }}>删除</div>
            </div>
          </div>

          {/* 节点明细 */}
          <div style={{ marginBottom: 12 }}>
            <Text strong>节点变更</Text>
            <Tag style={{ marginLeft: 8 }}>
              +{diffResult.stats.nodesAdded} ~{diffResult.stats.nodesModified} -{diffResult.stats.nodesRemoved}
            </Tag>
          </div>
          {hasNodeDiff ? (
            <>
              {renderNodeEntries('added')}
              {renderNodeEntries('removed')}
              {renderNodeEntries('modified')}
            </>
          ) : (
            <Empty description="节点无变更" image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ margin: '8px 0' }} />
          )}

          {/* 边明细 */}
          <div style={{ marginBottom: 12, marginTop: 16 }}>
            <Text strong>边变更</Text>
            <Tag style={{ marginLeft: 8 }}>
              +{diffResult.stats.edgesAdded} ~{diffResult.stats.edgesModified} -{diffResult.stats.edgesRemoved}
            </Tag>
          </div>
          {hasEdgeDiff ? (
            <>
              {renderEdgeEntries('added')}
              {renderEdgeEntries('removed')}
              {renderEdgeEntries('modified')}
            </>
          ) : (
            <Empty description="边无变更" image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ margin: '8px 0' }} />
          )}
        </>
      )}

      {!comparing && !diffResult && (
        <Empty
          description="选择两个版本进行对比"
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          style={{ padding: 48 }}
        />
      )}
    </Drawer>
  );
}
