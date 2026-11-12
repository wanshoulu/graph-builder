/**
 * 资产详情抽屉 — 概览（元数据/草稿/版本时间线）/ 内容浏览 / 版本对比 / 审计日志
 */
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Col, Collapse, Descriptions, Divider, Drawer, Empty, Form, Input, List, Modal, Popconfirm, Row, Space, Spin, Statistic, Tabs, Tag, Timeline, Typography, message } from 'antd';
import { CheckCircleOutlined, DeleteOutlined, EditOutlined, ExportOutlined, HistoryOutlined, PartitionOutlined, RollbackOutlined, SafetyCertificateOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { useEffect, useState } from 'react';
import {
  auditGraph,
  decidePublishRequest,
  deleteVersion,
  discardDraft,
  fetchAssetAudit,
  getLatestPublished,
  getStatus,
  getTemplate,
  listPublishRequests,
  loadGraph,
  setActiveVersion,
  updateAsset,
  type AssetLatest,
  type AuditEntry,
  type AuditFinding,
  type AuditResult,
  type GraphAsset,
  type GraphStatus,
  type GraphTemplate,
  type PublishRequest,
} from '@/api/orgGraph';
import { buildVersionTimeline, draftRollbackDrift } from './lib';
import { ContentBrowser } from './ContentBrowser';
import { DiffView } from './DiffView';
import { knowledgeHubApi, type GraphPublicationInput } from '@/api/knowledgeHub';

const { Text, Paragraph } = Typography;

interface AssetDetailDrawerProps {
  asset: GraphAsset | null;
  onClose: () => void;
  /** 元数据变更后刷新列表 */
  onChanged: () => void;
}

const AUDIT_ACTION_LABEL: Record<string, string> = {
  publish: '发布版本',
  rollback: '回滚',
  discard_draft: '放弃草稿',
  delete_version: '删除版本',
  publish_requested: '提交发布申请',
  publish_approved: '审批通过',
  publish_rejected: '审批拒绝',
};

/** 回滚确认（from → to 摘要展示） */
function confirmRollback(asset: GraphAsset, status: GraphStatus | null, version: string, onOk: () => void | Promise<void>) {
  const from = status?.activeVersion || '（无）';
  const note = status?.versions.find((v) => v.version === version)?.note;
  Modal.confirm({
    title: '确认切换 active 版本？',
    content: (
      <div>
        <div>{asset.name}：{from} → {version}</div>
        {note && <Text type="secondary" style={{ fontSize: 12 }}>目标版本说明：{note}</Text>}
        <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>历史版本不重写，回滚事件记录在 manifest，可再次切换。</Text>
      </div>
    ),
    okText: '切换',
    cancelText: '取消',
    onOk,
  });
}

/** 质量审计发现项 */
function FindingItem({ finding }: { finding: AuditFinding }) {
  const sevColor = finding.severity === 'high' ? 'red' : finding.severity === 'medium' ? 'orange' : 'blue';
  const sevLabel = finding.severity === 'high' ? '高' : finding.severity === 'medium' ? '中' : '低';
  return (
    <List.Item style={{ padding: '6px 0' }}>
      <div style={{ width: '100%' }}>
        <Space size={6} wrap>
          <Tag color={sevColor} style={{ marginRight: 0 }}>{sevLabel}</Tag>
          <Tag style={{ marginRight: 0 }}>{finding.category}</Tag>
          {finding.node_ids.length > 0 && <Text type="secondary" style={{ fontSize: 12 }}>影响 {finding.node_ids.length} 节点</Text>}
          {finding.edge_ids.length > 0 && <Text type="secondary" style={{ fontSize: 12 }}>影响 {finding.edge_ids.length} 边</Text>}
        </Space>
        <div style={{ marginTop: 4 }}><Text style={{ fontSize: 13 }}>{finding.issue}</Text></div>
        <div><Text type="secondary" style={{ fontSize: 12 }}>建议：{finding.suggestion}</Text></div>
      </div>
    </List.Item>
  );
}

export function AssetDetailDrawer({ asset, onClose, onChanged }: AssetDetailDrawerProps) {
  const navigate = useNavigate();
  const [status, setStatus] = useState<GraphStatus | null>(null);
  const [latest, setLatest] = useState<AssetLatest | null>(null);
  const [audit, setAudit] = useState<AuditEntry[] | null>(null);
  const [requests, setRequests] = useState<PublishRequest[] | null>(null);
  const [activeTab, setActiveTab] = useState('overview');
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [form] = Form.useForm();
  const [template, setTemplate] = useState<GraphTemplate | null>(null);
  const [auditResult, setAuditResult] = useState<AuditResult | null>(null);
  const [auditLoading, setAuditLoading] = useState(false);

  useEffect(() => {
    if (!asset) { setStatus(null); setLatest(null); setAudit(null); setRequests(null); setTemplate(null); setAuditResult(null); setEditing(false); setActiveTab('overview'); return; }
    setLoading(true);
    getStatus(asset.assetId)
      .then(setStatus)
      .catch((e) => message.error(e instanceof Error ? e.message : '加载状态失败'))
      .finally(() => setLoading(false));
    getLatestPublished(asset.assetId).then(setLatest).catch(() => setLatest(null));
    getTemplate(asset.assetId).then(setTemplate).catch(() => setTemplate(null));
  }, [asset]);

  // 审计日志 / 审批列表懒加载：切到对应标签时拉取
  useEffect(() => {
    if (!asset || activeTab !== 'audit' || audit) return;
    fetchAssetAudit(asset.assetId).then((r) => setAudit(r.auditLog)).catch((e) => message.error(e instanceof Error ? e.message : '加载审计日志失败'));
  }, [asset, activeTab, audit]);

  useEffect(() => {
    if (!asset || activeTab !== 'approval' || requests) return;
    listPublishRequests(asset.assetId).then((r) => setRequests(r.requests)).catch((e) => message.error(e instanceof Error ? e.message : '加载审批列表失败'));
  }, [asset, activeTab, requests]);

  if (!asset) return null;
  const currentAsset = asset;
  const refreshStatus = () => getStatus(currentAsset.assetId).then(setStatus).catch(() => undefined);
  // 版本状态变化后统一刷新：active 版本（消费端 graphId）、审计缓存、列表统计
  const refreshAfterVersionChange = () => {
    refreshStatus();
    getLatestPublished(currentAsset.assetId).then(setLatest).catch(() => setLatest(null));
    setAudit(null);
    setRequests(null);
    onChanged();
  };
  const timeline = status ? buildVersionTimeline(status) : [];
  const drift = draftRollbackDrift(status);
  const hasPublished = !!status?.activeVersion;
  // 版本切换时强制重挂载内容视图，避免陈旧数据
  const contentKey = `${asset.assetId}:${status?.activeVersion ?? 'none'}`;

  const openBuilder = (version?: string) => {
    const query = version ? `?asset=${encodeURIComponent(currentAsset.assetId)}&version=${encodeURIComponent(version)}` : `?asset=${encodeURIComponent(currentAsset.assetId)}`;
    navigate(`/knowledge/graph/builder${query}`);
  };

  async function doSaveMeta() {
    let values: { name?: string; description?: string };
    try { values = await form.validateFields(); } catch { return; }
    try {
      await updateAsset(currentAsset.assetId, values);
      message.success('元数据已更新');
      setEditing(false);
      onChanged();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '更新失败');
    }
  }

  function doSetActive(version: string) {
    confirmRollback(currentAsset, status, version, async () => {
      try {
        await setActiveVersion(currentAsset.assetId, version);
        message.success(`已切换 active 到 ${version}（回滚事件已记录）`);
        refreshAfterVersionChange();
      } catch (e) {
        message.error(e instanceof Error ? e.message : '切换失败');
      }
    });
  }

  async function doDeleteVersion(version: string) {
    try {
      await deleteVersion(currentAsset.assetId, version);
      message.success(`版本 ${version} 已删除`);
      refreshAfterVersionChange();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '删除失败');
    }
  }

  async function doDiscardDraft() {
    try {
      const r = await discardDraft(currentAsset.assetId);
      message.success(r.hadDraft ? '草稿已放弃' : '本无草稿');
      refreshAfterVersionChange();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '操作失败');
    }
  }

  async function doDecide(requestId: string, approve: boolean) {
    try {
      const r = await decidePublishRequest(currentAsset.assetId, requestId, approve);
      message.success(approve ? `审批通过，已按快照发布 ${r.published?.version ?? ''}` : `申请 ${requestId} 已拒绝`);
      const pub = r.published;
      if (approve && pub?.contentDigest) {
        await registerHubPublication({ version: pub.version, stats: pub.stats, contentDigest: pub.contentDigest });
      }
      refreshAfterVersionChange();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '审批操作失败');
    }
  }

  /** 审批发布成功后注册进 Knowledge Hub（复制 GraphBuilder 模式；失败仅告警，不阻断发布） */
  async function registerHubPublication(published: { version: string; stats: { nodes: number; edges: number }; contentDigest: string }) {
    const input: GraphPublicationInput = {
      assetId: currentAsset.assetId,
      version: published.version,
      name: currentAsset.name,
      description: currentAsset.description,
      domain: String(currentAsset.assetId).slice(0, 160),
      templateId: currentAsset.templateId,
      templateVersion: currentAsset.templateVersion,
      nodeCount: published.stats.nodes,
      edgeCount: published.stats.edges,
      contentDigest: published.contentDigest,
      runtimeRef: `/api/org-graph/load?asset=${encodeURIComponent(currentAsset.assetId)}&version=${encodeURIComponent(published.version)}`,
    };
    try {
      await knowledgeHubApi.registerGraphPublication(
        input,
        `graph:${currentAsset.assetId.slice(0, 50)}:${published.version.slice(0, 30)}:${published.contentDigest}`,
      );
      message.success('Knowledge Hub 已注册该图谱版本');
    } catch {
      message.warning('图谱版本已发布，但 Knowledge Hub 注册失败，可在 AI 辅助建图页重试注册');
    }
  }

  async function runAudit() {
    if (!currentAsset) return;
    setAuditLoading(true);
    setAuditResult(null);
    try {
      const doc = await loadGraph(currentAsset.assetId);
      const result = await auditGraph(currentAsset.assetId, doc);
      setAuditResult(result);
      const total = result.deterministic.length + result.semantic.length;
      message.success(total === 0 ? '质量审计完成，未发现问题' : `质量审计完成，发现 ${total} 个问题`);
    } catch (e) {
      message.error(e instanceof Error ? e.message : '质量审计失败');
    } finally {
      setAuditLoading(false);
    }
  }

  const overviewTab = (
    <>
      {/* 元数据区 */}
      {!editing ? (
        <>
          <Space direction="vertical" size={2} style={{ width: '100%' }}>
            <Text type="secondary" style={{ fontSize: 12 }}>assetId</Text>
            <Text copyable code>{asset.assetId}</Text>
            {asset.description ? <Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>{asset.description}</Paragraph> : <Text type="secondary">暂无描述</Text>}
          </Space>
          <Space style={{ marginTop: 12 }} wrap>
            <Button size="small" icon={<EditOutlined />} onClick={() => { form.setFieldsValue({ name: asset.name, description: asset.description || '' }); setEditing(true); }}>编辑元数据</Button>
            <Button size="small" type="primary" ghost icon={<ExportOutlined />} onClick={() => openBuilder()}>进入构建</Button>
            {asset.createdAt && <Text type="secondary" style={{ fontSize: 12 }}>创建于 {new Date(asset.createdAt).toLocaleString('zh-CN')}</Text>}
          </Space>
        </>
      ) : (
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="显示名" rules={[{ required: true, message: '名称不能为空' }]}><Input /></Form.Item>
          <Form.Item name="description" label="描述"><Input.TextArea rows={2} /></Form.Item>
          <Space>
            <Button type="primary" size="small" onClick={doSaveMeta}>保存</Button>
            <Button size="small" onClick={() => setEditing(false)}>取消</Button>
          </Space>
        </Form>
      )}

      <Divider orientation="left" orientationMargin={0}><Text type="secondary" style={{ fontSize: 12 }}>模板</Text></Divider>
      <Space size={6} wrap>
        <Tag>{asset.templateId} · {asset.templateVersion}</Tag>
        <Tag color="geekblue">{asset.nodeTypes.length} 节点类型</Tag>
        <Tag color="cyan">{asset.edgeTypes.length} 边类型</Tag>
      </Space>

      {/* 已发布版本与消费端 */}
      <Divider orientation="left" orientationMargin={0}><Text type="secondary" style={{ fontSize: 12 }}>已发布（消费端）</Text></Divider>
      {latest ? (
        <Space size={24} wrap>
          <Statistic title="active 版本" value={latest.version} valueStyle={{ fontSize: 18 }} />
          <Statistic title="规模" valueRender={() => <Text>{latest.stats.nodes} 节点 / {latest.stats.edges} 边</Text>} valueStyle={{ fontSize: 14 }} />
          <div>
            <Text type="secondary" style={{ fontSize: 12 }}>消费端 graphId（knowledge-qa 当前使用）</Text>
            <div><Text copyable code style={{ fontSize: 12 }}>{latest.graphId}</Text></div>
            <Text type="secondary" style={{ fontSize: 12 }}>发布于 {new Date(latest.publishedAt).toLocaleString('zh-CN')}</Text>
          </div>
        </Space>
      ) : (
        <Alert type="warning" showIcon message="尚无已发布版本，消费端（知识问答）不可用；请构建后发布" />
      )}

      {/* 草稿区 */}
      <Divider orientation="left" orientationMargin={0}><Text type="secondary" style={{ fontSize: 12 }}>草稿</Text></Divider>
      {status?.draft ? (
        <Space direction="vertical" size={4} style={{ width: '100%' }}>
          <Space size={6}>
            <Tag color="orange">{status.draft.nodes} 节点 / {status.draft.edges} 边</Tag>
            {status.draft.updated_at && <Text type="secondary" style={{ fontSize: 12 }}>更新于 {new Date(status.draft.updated_at).toLocaleString('zh-CN')}</Text>}
          </Space>
          {drift && (
            <Alert
              type="warning"
              showIcon
              message="草稿保存于最近一次回滚之前"
              description={`最近回滚 ${drift.from || '（无）'} → ${drift.to}（${new Date(drift.at).toLocaleString('zh-CN')}）发生在草稿最后保存之后；发布当前草稿会把回滚掉的内容重新发布。请先在构建页核对差异。`}
            />
          )}
          <Space>
            <Button size="small" onClick={() => openBuilder()}>编辑草稿</Button>
            <Popconfirm
              title="放弃草稿？"
              description="未发布的草稿内容将不可恢复（已发布版本不受影响）"
              okText="放弃"
              okType="danger"
              cancelText="取消"
              onConfirm={doDiscardDraft}
            >
              <Button size="small" danger icon={<DeleteOutlined />}>放弃草稿</Button>
            </Popconfirm>
          </Space>
        </Space>
      ) : <Text type="secondary">无草稿</Text>}

      {/* 版本时间线 */}
      <Divider orientation="left" orientationMargin={0}>
        <Space size={4}><Text type="secondary" style={{ fontSize: 12 }}>版本历史</Text><Tag style={{ fontSize: 11 }}>{timeline.length} 个版本</Tag></Space>
      </Divider>
      {timeline.length ? (
        <Timeline
          items={timeline.map((v) => ({
            dot: v.isActive ? <CheckCircleOutlined style={{ color: '#52c41a', fontSize: 16 }} /> : undefined,
            children: (
              <div>
                <Space size={6} wrap>
                  <Text strong style={{ fontSize: 13 }}>{v.version}</Text>
                  {v.isActive && <Tag color="green" style={{ marginRight: 0 }}>active</Tag>}
                  {v.nodes !== undefined && <Tag style={{ marginRight: 0 }}>{v.nodes} 节点 / {v.edges} 边</Tag>}
                </Space>
                <div>
                  <Text type="secondary" style={{ fontSize: 12 }}>{new Date(v.publishedAt).toLocaleString('zh-CN')}</Text>
                  {v.note && <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>{v.note}</Text>}
                </div>
                <Space size={4} style={{ marginTop: 4 }}>
                  {v.canSetActive && (
                    <Button size="small" icon={<RollbackOutlined />} onClick={() => doSetActive(v.version)}>设为 active（回滚）</Button>
                  )}
                  <Button size="small" type="link" style={{ padding: 0 }} onClick={() => openBuilder(v.version)}>查看</Button>
                  {v.canDelete && (
                    <Popconfirm
                      title={`删除版本 ${v.version}？`}
                      description="版本文件将被删除且不可恢复"
                      okText="删除"
                      okType="danger"
                      cancelText="取消"
                      onConfirm={() => doDeleteVersion(v.version)}
                    >
                      <Button size="small" type="link" danger style={{ padding: 0 }}>删除</Button>
                    </Popconfirm>
                  )}
                </Space>
              </div>
            ),
          }))}
        />
      ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="从未发布过版本" style={{ margin: '12px 0' }} />}

      {/* 回滚事件 */}
      {status?.rollbacks && status.rollbacks.length > 0 && (
        <>
          <Divider orientation="left" orientationMargin={0}><Text type="secondary" style={{ fontSize: 12 }}>回滚记录</Text></Divider>
          <List
            size="small"
            dataSource={[...status.rollbacks].reverse()}
            renderItem={(r) => (
              <List.Item style={{ padding: '4px 0' }}>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {new Date(r.at).toLocaleString('zh-CN')}：{r.from || '（无）'} → {r.to}
                </Text>
              </List.Item>
            )}
          />
        </>
      )}
    </>
  );

  // ── Schema Tab：模板定义（节点类型 / 边类型 / 字段 / 校验规则 / 布局配置）──
  const schemaTab = template ? (
    <>
      <Descriptions size="small" column={1} bordered style={{ marginBottom: 12 }}>
        <Descriptions.Item label="模板ID">{template.template_id}</Descriptions.Item>
        <Descriptions.Item label="版本">{template.template_version}</Descriptions.Item>
        <Descriptions.Item label="名称">{template.name}</Descriptions.Item>
        {template.description && <Descriptions.Item label="描述">{template.description}</Descriptions.Item>}
      </Descriptions>

      <Divider orientation="left" orientationMargin={0}>
        <Space size={4}><PartitionOutlined /><Text type="secondary" style={{ fontSize: 12 }}>节点类型（{template.node_types.length}）</Text></Space>
      </Divider>
      <Collapse
        size="small"
        items={template.node_types.map((nt) => ({
          key: nt.type,
          label: <Space size={4}><Tag color="blue" style={{ marginRight: 0 }}>{nt.type}</Tag><Text strong>{nt.label}</Text></Space>,
          children: (
            <div>
              {nt.style && (nt.style.color || nt.style.shape) && (
                <Space size={6} style={{ marginBottom: 8 }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>样式：</Text>
                  {nt.style.color && <Tag style={{ marginRight: 0 }}>{nt.style.color}</Tag>}
                  {nt.style.shape && <Tag style={{ marginRight: 0 }}>{nt.style.shape}</Tag>}
                </Space>
              )}
              <Text type="secondary" style={{ fontSize: 12 }}>字段（{nt.fields.length}）</Text>
              <List
                size="small"
                dataSource={nt.fields}
                renderItem={(f) => (
                  <List.Item style={{ padding: '4px 0' }}>
                    <Space size={6} wrap>
                      <Text code style={{ fontSize: 12 }}>{f.key}</Text>
                      <Tag style={{ marginRight: 0 }}>{f.type}</Tag>
                      {f.required && <Tag color="red" style={{ marginRight: 0 }}>必填</Tag>}
                      <Text style={{ fontSize: 12 }}>{f.label}</Text>
                      {f.options && f.options.length > 0 && <Text type="secondary" style={{ fontSize: 11 }}>[{f.options.join(', ')}]</Text>}
                    </Space>
                  </List.Item>
                )}
              />
            </div>
          ),
        }))}
      />

      <Divider orientation="left" orientationMargin={0}>
        <Space size={4}><PartitionOutlined /><Text type="secondary" style={{ fontSize: 12 }}>边类型（{template.edge_types.length}）</Text></Space>
      </Divider>
      <Collapse
        size="small"
        items={template.edge_types.map((et) => ({
          key: et.type,
          label: <Space size={4}><Tag color="cyan" style={{ marginRight: 0 }}>{et.type}</Tag><Text strong>{et.label}</Text></Space>,
          children: (
            <div>
              <Space size={6} style={{ marginBottom: 8 }}>
                <Text type="secondary" style={{ fontSize: 12 }}>连接关系：</Text>
                <Text style={{ fontSize: 12 }}>{et.source_types.join(' | ')}</Text>
                <Text>→</Text>
                <Text style={{ fontSize: 12 }}>{et.target_types.join(' | ')}</Text>
              </Space>
              {et.fields.length > 0 && (
                <>
                  <Text type="secondary" style={{ fontSize: 12 }}>字段（{et.fields.length}）</Text>
                  <List
                    size="small"
                    dataSource={et.fields}
                    renderItem={(f) => (
                      <List.Item style={{ padding: '4px 0' }}>
                        <Space size={6} wrap>
                          <Text code style={{ fontSize: 12 }}>{f.key}</Text>
                          <Tag style={{ marginRight: 0 }}>{f.type}</Tag>
                          {f.required && <Tag color="red" style={{ marginRight: 0 }}>必填</Tag>}
                          <Text style={{ fontSize: 12 }}>{f.label}</Text>
                        </Space>
                      </List.Item>
                    )}
                  />
                </>
              )}
            </div>
          ),
        }))}
      />

      {Object.keys(template.validation_rules).length > 0 && (
        <>
          <Divider orientation="left" orientationMargin={0}><Text type="secondary" style={{ fontSize: 12 }}>校验规则</Text></Divider>
          <Space wrap>
            {Object.entries(template.validation_rules).map(([rule, enabled]) => (
              <Tag key={rule} color={enabled ? 'green' : 'default'} style={{ marginRight: 4 }}>
                {enabled ? '✓' : '✗'} {rule}
              </Tag>
            ))}
          </Space>
        </>
      )}

      {template.layout && (
        <>
          <Divider orientation="left" orientationMargin={0}><Text type="secondary" style={{ fontSize: 12 }}>布局配置</Text></Divider>
          <Descriptions size="small" column={1}>
            {template.layout.tree_edges && Array.isArray(template.layout.tree_edges) && template.layout.tree_edges.length > 0 && (
              <Descriptions.Item label="树骨架边">{template.layout.tree_edges.map((e) => typeof e === 'string' ? e : e.type).join(', ')}</Descriptions.Item>
            )}
            {template.layout.tree_parent && <Descriptions.Item label="父节点端">{template.layout.tree_parent}</Descriptions.Item>}
            {template.layout.default_layout && <Descriptions.Item label="默认布局">{template.layout.default_layout}</Descriptions.Item>}
            {template.layout.initial_collapse_depth !== undefined && <Descriptions.Item label="初始折叠深度">{template.layout.initial_collapse_depth}</Descriptions.Item>}
            {template.layout.default_hidden_edges && template.layout.default_hidden_edges.length > 0 && (
              <Descriptions.Item label="默认隐藏边">{template.layout.default_hidden_edges.join(', ')}</Descriptions.Item>
            )}
          </Descriptions>
        </>
      )}
    </>
  ) : <Spin style={{ display: 'block', textAlign: 'center', padding: 24 }} />;

  // ── 质量审计 Tab：规则检查 + LLM 语义审查 ──
  const qualityTab = (
    <Space direction="vertical" style={{ width: '100%' }} size={12}>
      <Alert type="info" showIcon message="质量审计包含确定性规则检查（秒出）和 LLM 语义审查（需调用大模型）" />
      <Button type="primary" icon={<ThunderboltOutlined />} loading={auditLoading} onClick={runAudit}>
        运行质量审计
      </Button>

      {auditResult && (
        <>
          <Row gutter={16}>
            <Col span={6}><Statistic title="节点数" value={auditResult.stats.nodes} /></Col>
            <Col span={6}><Statistic title="边数" value={auditResult.stats.edges} /></Col>
            <Col span={6}>
              <Statistic title="规则发现问题" value={auditResult.deterministic.length} valueStyle={{ color: auditResult.deterministic.length > 0 ? '#cf1322' : '#3f8600' }} />
            </Col>
            <Col span={6}>
              <Statistic title="语义发现问题" value={auditResult.semantic.length} valueStyle={{ color: auditResult.semantic.length > 0 ? '#cf1322' : '#3f8600' }} />
            </Col>
          </Row>

          {auditResult.llm !== 'ok' && (
            <Alert type="warning" showIcon message={`LLM 语义审查状态：${auditResult.llm}（仅展示规则检查结果）`} />
          )}

          {auditResult.deterministic.length > 0 && (
            <>
              <Divider orientation="left" orientationMargin={0}><Text type="secondary" style={{ fontSize: 12 }}>规则检查发现（{auditResult.deterministic.length}）</Text></Divider>
              <List size="small" dataSource={auditResult.deterministic} renderItem={(f, i) => <FindingItem key={i} finding={f} />} />
            </>
          )}

          {auditResult.semantic.length > 0 && (
            <>
              <Divider orientation="left" orientationMargin={0}><Text type="secondary" style={{ fontSize: 12 }}>语义审查发现（{auditResult.semantic.length}）</Text></Divider>
              <List size="small" dataSource={auditResult.semantic} renderItem={(f, i) => <FindingItem key={i} finding={f} />} />
            </>
          )}

          {auditResult.deterministic.length === 0 && auditResult.semantic.length === 0 && (
            <Alert type="success" showIcon message="未发现质量问题" />
          )}
        </>
      )}
    </Space>
  );

  return (
    <Drawer
      title={<Space><HistoryOutlined />{asset.name}<Tag color={asset.builtin ? 'blue' : 'green'}>{asset.builtin ? '内置' : '自建'}</Tag></Space>}
      open={!!asset}
      onClose={onClose}
      width={720}
      destroyOnHidden
    >
      {loading && !status ? <Spin style={{ display: 'block', textAlign: 'center', padding: 40 }} /> : (
        <Tabs
          activeKey={activeTab}
          onChange={setActiveTab}
          items={[
            { key: 'overview', label: '概览', children: overviewTab },
            { key: 'schema', label: <Space size={2}><PartitionOutlined />Schema</Space>, children: schemaTab },
            {
              key: 'content', label: '内容浏览',
              children: hasPublished
                ? <ContentBrowser key={contentKey} asset={asset} />
                : <Alert type="info" showIcon message="发布版本后可浏览内容" />,
            },
            {
              key: 'diff', label: '版本对比',
              children: timeline.length >= 2
                ? <DiffView key={contentKey} asset={asset} versions={status!.versions} />
                : <Alert type="info" showIcon message="至少需要两个已发布版本才能对比" />,
            },
            { key: 'quality', label: <Space size={2}><SafetyCertificateOutlined />质量审计</Space>, children: qualityTab },
            {
              key: 'approval', label: '发布审批',
              children: requests === null
                ? <Spin style={{ display: 'block', textAlign: 'center', padding: 24 }} />
                : requests.length === 0
                  ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无发布申请。启用 REQUIRE_PUBLISH_APPROVAL 后，草稿发布需先提交审批" style={{ padding: 24 }} />
                  : (
                    <List
                      size="small"
                      dataSource={requests}
                      renderItem={(rq) => (
                        <List.Item
                          style={{ padding: '8px 0' }}
                          actions={rq.status === 'pending' ? [
                            <Popconfirm key="ok" title="通过并发布？" description="按提交时的快照发布为新版本（非当前草稿）" okText="通过" cancelText="取消" onConfirm={() => doDecide(rq.id, true)}>
                              <Button size="small" type="primary" ghost>通过</Button>
                            </Popconfirm>,
                            <Popconfirm key="no" title="拒绝该申请？" okText="拒绝" okType="danger" cancelText="取消" onConfirm={() => doDecide(rq.id, false)}>
                              <Button size="small" danger>拒绝</Button>
                            </Popconfirm>,
                          ] : undefined}
                        >
                          <div style={{ width: '100%' }}>
                            <Space size={6} wrap>
                              <Tag color={rq.status === 'pending' ? 'orange' : rq.status === 'approved' ? 'green' : 'red'} style={{ marginRight: 0 }}>
                                {rq.status === 'pending' ? '待审批' : rq.status === 'approved' ? '已通过' : '已拒绝'}
                              </Tag>
                              <Text code style={{ fontSize: 12 }}>{rq.id}</Text>
                              <Text type="secondary" style={{ fontSize: 12 }}>{rq.stats.nodes} 节点 / {rq.stats.edges} 边</Text>
                              <Text type="secondary" style={{ fontSize: 12 }}>{new Date(rq.createdAt).toLocaleString('zh-CN')}</Text>
                              {rq.decidedAt && <Text type="secondary" style={{ fontSize: 12 }}>处理于 {new Date(rq.decidedAt).toLocaleString('zh-CN')}</Text>}
                            </Space>
                            {rq.note ? <div><Text type="secondary" style={{ fontSize: 12 }}>说明：{rq.note}</Text></div> : null}
                          </div>
                        </List.Item>
                      )}
                    />
                  ),
            },
            {
              key: 'audit', label: '审计日志',
              children: audit === null
                ? <Spin style={{ display: 'block', textAlign: 'center', padding: 24 }} />
                : audit.length === 0
                  ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无操作记录（发布/回滚/删除等操作会记录在此）" style={{ padding: 24 }} />
                  : (
                    <List
                      size="small"
                      dataSource={audit}
                      renderItem={(entry) => (
                        <List.Item style={{ padding: '6px 0' }}>
                          <div style={{ width: '100%' }}>
                            <Space size={6} wrap>
                              <Tag color={entry.action.includes('reject') ? 'red' : entry.action.includes('approve') || entry.action === 'publish' ? 'green' : 'blue'} style={{ marginRight: 0 }}>
                                {AUDIT_ACTION_LABEL[entry.action] ?? entry.action}
                              </Tag>
                              <Text type="secondary" style={{ fontSize: 12 }}>{new Date(entry.at).toLocaleString('zh-CN')}</Text>
                              {entry.version && <Text style={{ fontSize: 12 }}>{entry.version}</Text>}
                              {entry.from !== undefined && entry.from !== null && <Text style={{ fontSize: 12 }}>{entry.from} → {entry.to}</Text>}
                              {entry.requestId && <Text type="secondary" code style={{ fontSize: 11 }}>{entry.requestId}</Text>}
                              {entry.stats && <Text type="secondary" style={{ fontSize: 12 }}>{entry.stats.nodes} 节点 / {entry.stats.edges} 边</Text>}
                            </Space>
                            {entry.note ? <div><Text type="secondary" style={{ fontSize: 12 }}>{String(entry.note)}</Text></div> : null}
                          </div>
                        </List.Item>
                      )}
                    />
                  ),
            },
          ]}
        />
      )}
    </Drawer>
  );
}
