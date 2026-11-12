/**
 * 自动建图质检面板：确定性质检报告（schema 合规 / 模板覆盖 / 内容质量 三维评分）
 * 卡片常驻结果区，抽屉展示发现清单与类型覆盖明细；「AI 填充」入口由父组件注入。
 */
import { Alert, Button, Card, Descriptions, Drawer, Empty, Progress, Space, Spin, Table, Tag, Tooltip, Typography } from 'antd';
import { ApartmentOutlined, ReloadOutlined, SafetyCertificateOutlined, ThunderboltOutlined } from '@ant-design/icons';
import type { FillApplied, QualityReport } from '@/api/orgGraph';

const { Text } = Typography;

const SCORE_COLOR = (score: number) => (score >= 90 ? '#52c41a' : score >= 75 ? '#1677ff' : score >= 60 ? '#faad14' : '#ff4d4f');
const SEVERITY_COLOR: Record<string, string> = { error: 'red', warning: 'orange', medium: 'orange', ok: 'green', high: 'red', low: 'blue', info: 'blue', critical: 'red' };

interface QualityCardProps {
  report: QualityReport | null;
  loading: boolean;
  filling: boolean;
  resolving: boolean;
  /** 执行中状态文案（填充/消解等） */
  statusText?: string;
  /** 可填充的占位缺口数（0 时按钮禁用） */
  placeholderCount: number;
  /** 材料库文档数（AI 填充前置依赖，0 时按钮禁用） */
  materialsCount?: number;
  /** 质检失败错误文案（report 为空时展示） */
  error?: string;
  onFill: () => void;
  onResolve: () => void;
  onOpenDetail: () => void;
  onRetry?: () => void;
}

export function QualityCard({ report, loading, filling, resolving, statusText, placeholderCount, materialsCount, error, onFill, onResolve, onOpenDetail, onRetry }: QualityCardProps) {
  if (loading) {
    return (
      <Card size="small" style={{ marginBottom: 12 }}>
        <Space><Spin size="small" /><Text type="secondary">正在生成质检报告…</Text></Space>
      </Card>
    );
  }
  if (filling || resolving) {
    return (
      <Card size="small" style={{ marginBottom: 12, borderColor: '#91caff' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Spin size="small" />
          <Text type="secondary" style={{ fontSize: 12 }}>
            {statusText || (filling ? '正在从材料原文取证填充缺口…' : '正在消解重复实体…')}
          </Text>
        </div>
      </Card>
    );
  }
  if (!report && error) {
    return (
      <Card size="small" style={{ marginBottom: 12, borderColor: '#ffccc7' }}>
        <Alert
          type="error"
          showIcon
          message="质检报告生成失败"
          description={error}
          action={onRetry ? <Button size="small" icon={<ReloadOutlined />} onClick={onRetry}>重试</Button> : undefined}
        />
      </Card>
    );
  }
  if (!report) return null;
  const { summary } = report;
  const statItem = (label: string, value: React.ReactNode, accent?: string) => (
    <div key={label}>
      <div style={{ fontSize: 17, fontWeight: 600, lineHeight: '24px', color: accent }}>{value}</div>
      <div style={{ fontSize: 11, color: '#86909c', marginTop: 1 }}>{label}</div>
    </div>
  );
  return (
    <div
      data-testid="quality-card"
      style={{
        marginBottom: 12, padding: '16px 20px', borderRadius: 10,
        border: '1px solid #e6ebf5',
        background: 'linear-gradient(120deg, #f5f7ff 0%, #f2fbf7 100%)',
        display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap',
      }}
    >
      <Tooltip title={report.dimensions.map((d) => `${d.label} ${(d.weight * 100).toFixed(0)}%`).join(' + ')}>
        <div style={{ textAlign: 'center', flexShrink: 0 }}>
          <Progress
            type="circle"
            percent={summary.score}
            size={84}
            format={(p) => (
              <span>
                <span style={{ fontSize: 20, fontWeight: 600, color: SCORE_COLOR(summary.score) }}>{p}</span>
                <br />
                <span style={{ fontSize: 11, color: '#86909c' }}>{summary.grade}</span>
              </span>
            )}
            strokeColor={SCORE_COLOR(summary.score)}
          />
          <div style={{ fontSize: 11, color: '#86909c', marginTop: 4 }}>综合质检评分</div>
        </div>
      </Tooltip>
      <div style={{ width: 1, alignSelf: 'stretch', background: '#e3e8f2' }} />
      <div style={{ flex: 1, minWidth: 280, display: 'flex', flexDirection: 'column', gap: 9 }}>
        {report.dimensions.map((d) => {
          const findings = d.items.filter((i) => i.severity !== 'ok').length;
          return (
            <div key={d.key} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ width: 8, height: 8, borderRadius: 4, background: SCORE_COLOR(d.score), flexShrink: 0 }} />
              <span style={{ fontSize: 12, width: 72, color: '#4e5969', flexShrink: 0 }}>{d.label}</span>
              <Progress percent={d.score} size="small" style={{ flex: 1, marginBottom: 0 }} strokeColor={SCORE_COLOR(d.score)} showInfo={false} />
              <span style={{ fontSize: 13, fontWeight: 600, width: 28, textAlign: 'right' }}>{d.score}</span>
              <Tag color={findings > 0 ? 'orange' : 'green'} style={{ fontSize: 11, marginRight: 0, borderRadius: 4 }}>
                {findings > 0 ? `${findings} 项发现` : '无发现'}
              </Tag>
            </div>
          );
        })}
        {summary.errorCount > 0 && (
          <Tag color="red" style={{ alignSelf: 'flex-start', borderRadius: 4 }}>{summary.errorCount} 个 schema 错误</Tag>
        )}
      </div>
      <div style={{ display: 'flex', gap: 22, flexShrink: 0 }}>
        {statItem('节点', summary.nodeCount)}
        {statItem('边', summary.edgeCount)}
        {statItem('发现', summary.findingCount, summary.findingCount > 0 ? '#fa8c16' : undefined)}
        {statItem('占位字段', summary.placeholderCount, summary.placeholderCount > 0 ? '#fa8c16' : undefined)}
      </div>
      <Space direction="vertical" size={8} style={{ width: 150, flexShrink: 0 }}>
        <Button block size="small" icon={<SafetyCertificateOutlined />} onClick={onOpenDetail}>质检详情</Button>
        <Tooltip title={placeholderCount === 0 ? '没有待填充的占位字段' : (!materialsCount || materialsCount === 0) ? '请先上传材料，AI 从原文取证填充（不编造）' : '从原文材料取证填充占位/空必填字段，无依据不编造'}>
          <Button block size="small" type="primary" ghost icon={<ThunderboltOutlined />} loading={filling} disabled={placeholderCount === 0 || !materialsCount || materialsCount === 0} onClick={onFill}>
            AI 填充{placeholderCount > 0 ? ` ${placeholderCount}` : ''}
          </Button>
        </Tooltip>
        <Tooltip title="确定性合并同名（忽略全角/空白/尾标点差异）同类型重复节点，边自动重定向，不经 LLM">
          <Button block size="small" icon={<ApartmentOutlined />} loading={resolving} onClick={onResolve}>
            实体消解
          </Button>
        </Tooltip>
      </Space>
    </div>
  );
}

interface QualityDrawerProps {
  open: boolean;
  report: QualityReport | null;
  fills: FillApplied[];
  onClose: () => void;
}

export function QualityDrawer({ open, report, fills, onClose }: QualityDrawerProps) {
  return (
    <Drawer title="质检报告详情" width={560} open={open} onClose={onClose}>
      {!report ? <Empty /> : (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Descriptions size="small" column={3} bordered>
            <Descriptions.Item label="总分"><Text strong style={{ color: SCORE_COLOR(report.summary.score) }}>{report.summary.score}</Text>（{report.summary.grade}）</Descriptions.Item>
            <Descriptions.Item label="节点 / 边">{report.summary.nodeCount} / {report.summary.edgeCount}</Descriptions.Item>
            <Descriptions.Item label="占位字段">{report.summary.placeholderCount}</Descriptions.Item>
          </Descriptions>
          {report.dimensions.map((d) => (
            <div key={d.key}>
              <Space size={8} style={{ marginBottom: 6 }}>
                <Text strong>{d.label}</Text>
                <Tag color={SCORE_COLOR(d.score)}>{d.score} 分</Tag>
                <Text type="secondary" style={{ fontSize: 11 }}>权重 {(d.weight * 100).toFixed(0)}%</Text>
              </Space>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
                {d.items.length === 0 ? (
                  <li><Text type="secondary">暂无发现</Text></li>
                ) : d.items.map((item, i) => (
                  <li key={i} style={{ marginBottom: 2 }}>
                    <Tag color={SEVERITY_COLOR[item.severity] || 'default'} style={{ fontSize: 11 }}>{item.severity}</Tag>
                    {item.message}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <div>
            <Text strong style={{ display: 'block', marginBottom: 6 }}>类型覆盖明细</Text>
            <Table
              size="small"
              pagination={false}
              dataSource={report.coverage.nodeTypes.map((t) => ({ key: `n-${t.type}`, kind: '节点', ...t }))}
              columns={[
                { title: '类别', dataIndex: 'kind', width: 60 },
                { title: '类型', dataIndex: 'label', render: (_: unknown, r: { label: string; type: string }) => `${r.label}（${r.type}）` },
                { title: '数量', dataIndex: 'count', width: 70, render: (v: number) => (v === 0 ? <Tag color="orange">0</Tag> : v) },
              ]}
            />
            <Table
              size="small"
              pagination={false}
              style={{ marginTop: 8 }}
              dataSource={report.coverage.edgeTypes.map((t) => ({ key: `e-${t.type}`, kind: '关系', ...t }))}
              columns={[
                { title: '类别', dataIndex: 'kind', width: 60 },
                { title: '类型', dataIndex: 'label', render: (_: unknown, r: { label: string; type: string }) => `${r.label}（${r.type}）` },
                { title: '数量', dataIndex: 'count', width: 70, render: (v: number) => (v === 0 ? <Tag color="orange">0</Tag> : v) },
              ]}
            />
          </div>
          {(report.coverage.missingNodeTypes.length > 0 || report.coverage.missingEdgeTypes.length > 0) && (
            <div>
              <Text strong style={{ display: 'block', marginBottom: 6 }}>缺失类型（模板要求但图谱中未出现）</Text>
              {report.coverage.missingNodeTypes.length > 0 && (
                <div style={{ marginBottom: 4 }}>
                  <Text type="secondary" style={{ fontSize: 12, marginRight: 6 }}>节点：</Text>
                  {report.coverage.missingNodeTypes.map((t) => <Tag key={t} color="red" style={{ marginBottom: 2 }}>{t}</Tag>)}
                </div>
              )}
              {report.coverage.missingEdgeTypes.length > 0 && (
                <div>
                  <Text type="secondary" style={{ fontSize: 12, marginRight: 6 }}>关系：</Text>
                  {report.coverage.missingEdgeTypes.map((t) => <Tag key={t} color="red" style={{ marginBottom: 2 }}>{t}</Tag>)}
                </div>
              )}
            </div>
          )}
          {report.placeholders && report.placeholders.length > 0 && (
            <div>
              <Text strong style={{ display: 'block', marginBottom: 6 }}>占位字段明细（{report.placeholders.length}）</Text>
              <Table
                size="small"
                pagination={false}
                dataSource={report.placeholders.map((p, i) => ({ key: i, ...p }))}
                columns={[
                  { title: '节点', dataIndex: 'nodeId', ellipsis: true },
                  { title: '类型', dataIndex: 'nodeType', width: 100 },
                  { title: '字段', dataIndex: 'fieldLabel', width: 110 },
                  { title: '当前值', dataIndex: 'current', ellipsis: true, render: (v: string) => v || '—' },
                ]}
              />
            </div>
          )}
          {fills.length > 0 && (
            <div>
              <Text strong style={{ display: 'block', marginBottom: 6 }}>最近一次 AI 填充（{fills.length} 项）</Text>
              <Table
                size="small"
                pagination={false}
                dataSource={fills.map((f, i) => ({ key: i, ...f }))}
                columns={[
                  { title: '节点', dataIndex: 'nodeLabel', ellipsis: true },
                  { title: '字段', dataIndex: 'field', width: 100 },
                  { title: '填充前', dataIndex: 'before', ellipsis: true, render: (v: string) => v || '—' },
                  { title: '填充值', dataIndex: 'value', ellipsis: true, render: (v: unknown) => String(Array.isArray(v) ? v.join('、') : v) },
                  { title: '原文依据', dataIndex: 'evidence', ellipsis: true },
                ]}
              />
            </div>
          )}
        </Space>
      )}
    </Drawer>
  );
}
