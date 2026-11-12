/**
 * AI 辅助建图（专家画布精修，模板驱动）
 *
 *   🖐 画布编辑器 + AI 辅助确认队列（小规模精修）。
 *   AI 自动建图已拆分为独立页面 /knowledge/graph/auto-build（旧 ?mode=auto 链接自动重定向）。
 *
 * 视图：图谱展示（vis-network iframe，支持完整编辑）。
 * 数据与能力全部复用 AI Harbor /api/org-graph/*（资产注册制 + 双关校验 + 草稿/版本发布）。
 * 防丢：草稿脏标记 + beforeunload 拦截 + 60s 自动保存。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Alert, Button, Card, Form, Input, Modal, Select, Space, Spin, Tag, Typography } from 'antd';
import { message } from '@/utils/antdStatic';
import { CheckCircleOutlined, DiffOutlined, DownloadOutlined, EyeOutlined, FileTextOutlined, HistoryOutlined, RobotOutlined } from '@ant-design/icons';
import type { GraphAsset, GraphDocument, GraphStatus, GraphTemplate } from '@/api/orgGraph';
import { getStatus, getTemplate, isOrgGraphError, listAssets, loadGraph, publishGraph, saveGraph, validateGraph, downloadDraftExcel } from '@/api/orgGraph';
import { GraphDisplayView } from './display/GraphDisplayView';
import { DraftHistoryDrawer } from './shared/DraftHistoryDrawer';
import { GraphPreviewModal } from './shared/GraphPreviewModal';
import { VersionDiffDrawer } from './shared/VersionDiffDrawer';
import { graphDisplayInstanceKey, resolveGraphLoadTarget } from './lib/loadContext';
import { currentIntentTemplateDocument } from './lib/graphDoc';
import { draftRollbackDrift } from '@/pages/GraphManagement/lib';
import { knowledgeHubApi } from '@/api/knowledgeHub';
import type { GraphPublicationInput } from '@/api/knowledgeHub';

const { Title, Paragraph } = Typography;

type HubRegistrationState = 'unknown' | 'registered' | 'pending';

function graphValidationMessage(document: GraphDocument, errors: { message: string; path?: string }[]): string {
  return errors.slice(0, 3).map((error) => {
    const index = Number(error.path?.match(/nodes\[(\d+)\]/)?.[1]);
    const node = Number.isInteger(index) ? document.nodes[index] : undefined;
    return node ? `${String(node.properties.name || node.id)}：${error.message}` : error.message;
  }).join('；');
}

export default function GraphBuilder() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const [assets, setAssets] = useState<GraphAsset[]>([]);
  const [assetId, setAssetId] = useState('');
  const [template, setTemplate] = useState<GraphTemplate | null>(null);
  const [status, setStatus] = useState<GraphStatus | null>(null);
  const drift = draftRollbackDrift(status);
  const [document, setDocument] = useState<GraphDocument | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  const [note, setNote] = useState('');
  /** 图谱名称（草稿/发布统一命名，与 AutoBuildPanel 一致） */
  const [docName, setDocName] = useState('');
  const [version, setVersion] = useState<string | undefined>(undefined);
  /** 草稿脏标记：编辑未保存时拦截离开 + 触发自动保存 */
  const [dirty, setDirty] = useState(false);
  /** 资产列表加载失败（服务不可达 ≠ 无资产，二者提示不同） */
  const [assetsError, setAssetsError] = useState(false);
  const [hubRegistration, setHubRegistration] = useState<HubRegistrationState>('unknown');
  const [hubRegistering, setHubRegistering] = useState(false);
  const [pendingHubRegistration, setPendingHubRegistration] = useState<{
    input: GraphPublicationInput;
    idempotencyKey: string;
  } | null>(null);
  /** 草稿历史抽屉 */
  const [draftHistoryOpen, setDraftHistoryOpen] = useState(false);
  /** 骤减防线拦截：自动保存被 409 拒绝（内存内容远小于磁盘草稿），停止重试等待用户裁决 */
  const [guardBlocked, setGuardBlocked] = useState(false);

  // 兼容旧链接：AI 自动建图已拆分为独立页面（?mode=auto → /knowledge/graph/auto-build，保留其余参数）
  useEffect(() => {
    if (searchParams.get('mode') !== 'auto') return;
    const params = new URLSearchParams(searchParams);
    params.delete('mode');
    const qs = params.toString();
    navigate(`/knowledge/graph/auto-build${qs ? `?${qs}` : ''}`, { replace: true });
  }, [searchParams, navigate]);

  // 深链（图谱管理/门户跳入）：?asset= 初始资产；?version= 首次加载指定版本（仅生效一次）
  const initialAssetRef = useRef(searchParams.get('asset') || '');
  const initialVersionRef = useRef<string | undefined>(searchParams.get('version') || undefined);

  // 资产列表（可重试：服务抖动恢复后无需刷新整页）
  const loadAssets = useCallback(async () => {
    setAssetsError(false);
    try {
      const list = await listAssets();
      setAssets(list);
      if (list.length) setAssetId((prev) => prev || initialAssetRef.current || list[0].assetId);
    } catch (e) {
      setAssetsError(true);
      message.error(e instanceof Error ? e.message : '加载资产失败');
    }
  }, []);

  useEffect(() => {
    loadAssets();
  }, [loadAssets]);

  // 资产切换 → 模板 + 状态 + 文档
  const reloadAsset = useCallback(async (asset: string, loadVersion?: string) => {
    if (!asset) return;
    setLoading(true);
    setHubRegistration('unknown');
    setPendingHubRegistration(null);
    setGuardBlocked(false);
    try {
      const tpl = await getTemplate(asset);
      setTemplate(tpl);
      const st = await getStatus(asset);
      setStatus(st);
      // 加载优先级：深度链接指定版本 > 草稿 > active 版本（编辑器以草稿为准）
      const ver = resolveGraphLoadTarget(st, loadVersion);
      setVersion(ver);
      try {
        if (!ver) throw new Error('当前资产没有草稿或已发布版本');
        const doc = await loadGraph(asset, ver);
        setDocument(doc);
        setDocName(String(doc.metadata?.name || ''));
      } catch {
        setDocument(null);
      }
      setDirty(false);
    } catch (e) {
      message.error(e instanceof Error ? e.message : '加载资产失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!assetId) return;
    reloadAsset(assetId, initialVersionRef.current || undefined);
    initialVersionRef.current = undefined;
  }, [assetId, reloadAsset]);

  /** 深链同步：URL 始终反映当前资产/版本/视图（replace 避免污染历史） */
  const syncDeepLink = useCallback((next: { asset?: string; version?: string | null }) => {
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev);
      if (next.asset !== undefined) params.set('asset', next.asset);
      if (next.version === null) params.delete('version');
      else if (next.version !== undefined && next.version !== null) params.set('version', next.version);
      return params;
    }, { replace: true });
  }, [setSearchParams]);

  /** 编辑回调包装：所有改动统一置脏标记 */
  const handleDocumentChange = useCallback((doc: GraphDocument | null) => {
    setDocument(doc);
    setDirty(true);
  }, []);

  // beforeunload：脏状态下拦截误关/误刷新（浏览器原生确认框）
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  // 自动保存：脏状态每 60s 静默存草稿。定时器不依赖 document 重建（否则连续编辑会不断重置倒计时，永远存不上）；
  // 保存内容取 documentRef 快照，仅当保存期间无新编辑才清脏标记（竞态保护：不误标新编辑为已保存）
  const autoSaveRef = useRef(false);
  const documentRef = useRef<GraphDocument | null>(null);
  useEffect(() => { documentRef.current = document; }, [document]);
  useEffect(() => {
    if (!dirty || !assetId || guardBlocked) return;
    const timer = window.setInterval(async () => {
      if (autoSaveRef.current) return;
      const snapshot = documentRef.current;
      if (!snapshot) return;
      autoSaveRef.current = true;
      try {
        await saveGraph(assetId, currentIntentTemplateDocument(assetId, template, snapshot));
        if (documentRef.current === snapshot) {
          setDirty(false);
          message.info({ content: '已自动保存草稿', duration: 1.5, key: 'auto-save' });
        }
      } catch (e) {
        if (isOrgGraphError(e, 'ORG_GRAPH_DRAFT_SHRINK_GUARD')) {
          // 磁盘草稿远大于本页内存内容（典型：旧页面/过期标签页在自动保存小图）——停止覆盖，让用户刷新或走草稿历史
          setGuardBlocked(true);
          message.error({ content: '自动保存已拦截：本页内容比当前草稿小一半以上，为防误覆盖已停止保存', duration: 6, key: 'auto-save' });
        } else {
          message.warning({ content: '自动保存失败，下次将自动重试；也可手动保存', duration: 3, key: 'auto-save' });
        }
      }
      finally { autoSaveRef.current = false; }
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [dirty, assetId, template, guardBlocked]);

  async function handleSave() {
    if (!document) { message.warning('没有可保存的图谱'); return; }
    setSaving(true);
    try {
      const nextDocument = currentIntentTemplateDocument(assetId, template, document);
      // 写入图谱名称到 metadata（与 AutoBuildPanel 一致）
      if (docName.trim()) {
        nextDocument.metadata = { ...(nextDocument.metadata || {}), name: docName.trim() };
      }
      // 手动保存是用户明确意图，force 绕过骤减防线（旧稿仍会归档可回退）
      await saveGraph(assetId, nextDocument, { force: true });
      setDocument(nextDocument);
      setDirty(false);
      setGuardBlocked(false);
      message.success('草稿已保存');
      setStatus(await getStatus(assetId));
    } catch (e) {
      message.error(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  async function handleValidate() {
    if (!document) { message.warning('没有可校验的图谱'); return; }
    try {
      const nextDocument = currentIntentTemplateDocument(assetId, template, document);
      const v = await validateGraph(assetId, nextDocument);
      if (v.valid) message.success('✓ 双关校验通过');
      else message.error(`校验未通过：${graphValidationMessage(nextDocument, [...v.asset.errors, ...v.template.errors])}`, 8);
    } catch (e) {
      message.error(e instanceof Error ? e.message : '校验失败');
    }
  }

  async function handlePublish() {
    if (!document) return;
    setPublishing(true);
    try {
      const nextDocument = currentIntentTemplateDocument(assetId, template, document);
      // 写入图谱名称到 metadata（与 AutoBuildPanel 一致）
      if (docName.trim()) {
        nextDocument.metadata = { ...(nextDocument.metadata || {}), name: docName.trim() };
      }
      const validation = await validateGraph(assetId, nextDocument);
      if (!validation.valid) {
        message.error(`发布前校验未通过：${graphValidationMessage(nextDocument, [...validation.asset.errors, ...validation.template.errors])}`, 8);
        return;
      }
      const res = await publishGraph(assetId, nextDocument, note.trim());
      if (res.pendingApproval) {
        // 审批模式：内容已固化为发布请求，未产生版本——不做 Hub 注册/深链更新
        message.success(`已提交发布审批（请求 ${res.request?.id || ''}），审批通过后在图谱管理中生效`, 8);
        setDocument(nextDocument);
        setPublishOpen(false);
        setNote('');
        return;
      }
      message.success(`图谱版本 ${res.version} 已发布`);
      setPublishOpen(false);
      setNote('');
      // 回写 nextDocument 到内存：发布时确认的名称会保留到后续草稿保存
      setDocument(nextDocument);
      setDirty(false);
      setHubRegistration('pending');
      // 刷新状态：新版本出现在版本选择器中
      getStatus(assetId).then(setStatus).catch(() => {});
      const selectedAsset = assets.find((asset) => asset.assetId === assetId);
      const domainValue = document.metadata?.domain ?? template?.metadata?.domain ?? assetId;
      const registration = {
        input: {
          assetId,
          version: res.version,
          name: docName.trim() || String(document.metadata?.name || '') || selectedAsset?.name || template?.name || assetId,
          description: selectedAsset?.description || template?.description,
          domain: String(domainValue).slice(0, 160),
          templateId: template?.template_id || selectedAsset?.templateId || assetId,
          templateVersion: template?.template_version || selectedAsset?.templateVersion || '1.0.0',
          nodeCount: res.stats.nodes,
          edgeCount: res.stats.edges,
          contentDigest: res.contentDigest,
          runtimeRef: `/api/org-graph/load?asset=${encodeURIComponent(assetId)}&version=${encodeURIComponent(res.version)}`,
        },
        idempotencyKey: `graph:${assetId.slice(0, 50)}:${res.version.slice(0, 30)}:${res.contentDigest}`,
      } satisfies { input: GraphPublicationInput; idempotencyKey: string };
      let hubRegistered = false;
      try {
        await knowledgeHubApi.registerGraphPublication(registration.input, registration.idempotencyKey);
        hubRegistered = true;
        message.success('Knowledge Hub 已注册该图谱版本');
      } catch {
        message.warning('图谱版本已发布，但 Knowledge Hub 注册失败，可在本页重试注册');
      }
      await reloadAsset(assetId, res.version);
      setHubRegistration(hubRegistered ? 'registered' : 'pending');
      setPendingHubRegistration(hubRegistered ? null : registration);
      syncDeepLink({ version: res.version });
    } catch (e) {
      message.error(e instanceof Error ? e.message : '发布失败');
    } finally {
      setPublishing(false);
    }
  }

  async function handleRetryHubRegistration() {
    if (!pendingHubRegistration || hubRegistering) return;
    setHubRegistering(true);
    try {
      await knowledgeHubApi.registerGraphPublication(
        pendingHubRegistration.input,
        pendingHubRegistration.idempotencyKey,
      );
      setHubRegistration('registered');
      setPendingHubRegistration(null);
      message.success('Knowledge Hub 注册成功');
    } catch {
      message.warning('Knowledge Hub 仍不可用，图谱版本保持已发布、待注册状态');
    } finally {
      setHubRegistering(false);
    }
  }

  async function handleDownloadDraftExcel() {
    try {
      const { blob, fileName } = await downloadDraftExcel(assetId);
      const url = URL.createObjectURL(blob);
      const a = window.document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
      message.success('已下载草稿 Excel');
    } catch (e) {
      message.error(e instanceof Error ? e.message : '下载失败');
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 48px)', minHeight: 480 }}>
      {/* 头部元信息行：标题 + 版本/节点统计 + Hub 状态 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <Title level={4} style={{ margin: 0 }}>AI 辅助建图</Title>
        {dirty && <Tag color="orange">未保存</Tag>}
        {document && (
          <Tag color={version === 'draft' ? 'blue' : 'green'} icon={version === 'draft' ? undefined : <CheckCircleOutlined />}>
            {version === 'draft' ? '草稿' : version}
            {document.metadata?.name ? ` · ${String(document.metadata.name)}` : ''}
            {' · '}{document.nodes.length} 节点 / {document.edges.length} 边
          </Tag>
        )}
        {document?.metadata?.sourceFileName ? (
          <Tag color="geekblue" icon={<FileTextOutlined />} style={{ maxWidth: 360 }} >
            来源：{String(document.metadata.sourceFileName)}
          </Tag>
        ) : null}
        {version && version !== 'draft' && hubRegistration === 'registered' && (
          <Tag color="green">Hub 已注册</Tag>
        )}
        {version && version !== 'draft' && hubRegistration === 'pending' && (
          <Space size={2}>
            <Tag color="orange" style={{ marginRight: 0 }}>Hub 待注册</Tag>
            {pendingHubRegistration && (
              <Button type="link" size="small" loading={hubRegistering} onClick={handleRetryHubRegistration}>
                重试注册
              </Button>
            )}
          </Space>
        )}
      </div>

      {guardBlocked && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 8 }}
          message="自动保存已被拦截（防止小图覆盖大草稿）"
          description="本页面内存中的图谱比磁盘上的当前草稿小一半以上——通常说明本页加载的是过期数据（例如旧标签页）。草稿未被覆盖。请刷新页面加载最新草稿，或在草稿历史中找回其他快照；若确认要保存当前内容，可点「保存草稿」强制覆盖（旧稿会自动归档）。"
          action={
            <Space direction="vertical" size={4}>
              <Button size="small" onClick={() => window.location.reload()}>刷新页面</Button>
              <Button size="small" onClick={() => setDraftHistoryOpen(true)}>草稿历史</Button>
            </Space>
          }
        />
      )}

      {/* 控制行：资产 / 版本 / 模式 */}
      <Space style={{ marginBottom: 8 }} wrap>
        <Select
          style={{ width: 260 }}
          value={assetId || undefined}
          placeholder="选择图谱模板"
          onChange={async (v) => {
            // 切换前把未保存的修改落草稿（force 绕过骤减防线）——防误点丢稿；保存失败则取消切换
            if (dirty && document) {
              try {
                await saveGraph(assetId, currentIntentTemplateDocument(assetId, template, document), { force: true });
                message.info('已自动保存当前草稿后再切换');
              } catch (e) {
                message.error(`保存当前草稿失败，已取消切换：${e instanceof Error ? e.message : '未知错误'}`);
                return;
              }
            }
            setAssetId(v); setDocument(null); setVersion(undefined); setDirty(false); syncDeepLink({ asset: v, version: null });
          }}
          options={assets.map((a) => ({
            value: a.assetId,
            label: `${a.name}${a.name_en ? ' / ' + a.name_en : ''}（${a.nodeTypes.length} 类型 / ${a.edgeTypes.length} 关系）`,
          }))}
        />
        {status && (status.versions.length > 0 || status.draft) && (
          <Select
            style={{ width: 220 }}
            value={version}
            placeholder="选择加载版本"
            allowClear
            onChange={async (v) => {
              if (dirty && document) {
                try {
                  await saveGraph(assetId, currentIntentTemplateDocument(assetId, template, document), { force: true });
                  message.info('已自动保存当前草稿后再切换版本');
                } catch (e) {
                  message.error(`保存当前草稿失败，已取消切换：${e instanceof Error ? e.message : '未知错误'}`);
                  return;
                }
              }
              reloadAsset(assetId, v); syncDeepLink({ version: v || null });
            }}
            options={[
              {
                label: '草稿',
                options: [
                  { value: 'draft', label: `草稿${status.draft?.name ? ' · ' + status.draft.name : ''}${status.draft ? ` (${status.draft.nodes} 节点)` : ''}` },
                ],
              },
              {
                label: '已发布版本',
                options: status.versions.map((v) => ({
                  value: v.version,
                  label: `${v.version}${v.name ? ' · ' + v.name : ''}${v.note ? ' · ' + v.note : ''}`,
                })),
              },
            ]}
          />
        )}
        {status && (status.versions.length > 0 || status.draft) && (
          <Button
            size="small"
            icon={<DiffOutlined />}
            onClick={() => setDiffOpen(true)}
            title="对比两个版本的节点/边变更"
          >
            版本对比
          </Button>
        )}
        {assetId && (
          <Button
            size="small"
            icon={<HistoryOutlined />}
            onClick={() => setDraftHistoryOpen(true)}
            title="草稿覆盖前自动归档的快照，可恢复（保留最近 30 份）"
          >
            草稿历史
          </Button>
        )}
        {document && (
          <Button
            size="small"
            icon={<EyeOutlined />}
            onClick={() => setPreviewOpen(true)}
            title="大图预览：类型配色 + 邻域聚焦（只读）"
          >
            图预览
          </Button>
        )}
        {assetId && (
          <Button
            size="small"
            type="primary"
            ghost
            icon={<RobotOutlined />}
            onClick={() => navigate(`/knowledge/graph/auto-build?asset=${encodeURIComponent(assetId)}`)}
            title="对话/文档/表格自动生成图谱（独立建图模式）"
          >
            AI 自动建图
          </Button>
        )}
      </Space>

      {!template && loading && (
        <div style={{ textAlign: 'center', padding: 48 }}><Spin /></div>
      )}

      {!template && !loading && assetsError && (
        <Card>
          <Alert
            type="error"
            showIcon
            message="图谱资产服务不可达"
            description="AI Harbor 图谱服务（org-graph API）当前无法访问，模板资产列表加载失败。服务恢复后点击重试即可，无需刷新页面。"
            action={<Button size="small" onClick={loadAssets}>重试</Button>}
          />
        </Card>
      )}

      {!template && !loading && !assetsError && (
        <Card>
          <Alert
            type="info"
            showIcon
            message="暂无图谱模板资产"
            description={<>当前没有可用的图谱模板。可先到「图谱管理」注册资产模板（内置组织人员/客户生态/意图图谱等模板可复制），注册后回到此处构建。</>}
          />
        </Card>
      )}

      {template && (
        <GraphDisplayView
          key={graphDisplayInstanceKey(assetId, version, !!document)}
          asset={assetId}
          template={template}
          document={document}
          loading={loading}
          onDocumentChange={handleDocumentChange}
          status={status}
          dirty={dirty}
          saving={saving}
          publishing={publishing}
          onSave={handleSave}
          onValidate={handleValidate}
          onPublish={() => setPublishOpen(true)}
          onDownloadDraftExcel={handleDownloadDraftExcel}
        />
      )}

      <GraphPreviewModal open={previewOpen} document={document} template={template} onClose={() => setPreviewOpen(false)} />

      <VersionDiffDrawer open={diffOpen} onClose={() => setDiffOpen(false)} asset={assetId} status={status} />

      <DraftHistoryDrawer
        open={draftHistoryOpen}
        asset={assetId}
        onClose={() => setDraftHistoryOpen(false)}
        onRestored={() => reloadAsset(assetId, 'draft')}
      />

      <Modal
        title="发布为正式版本"
        open={publishOpen}
        onOk={handlePublish}
        onCancel={() => setPublishOpen(false)}
        okText="发布"
        confirmLoading={publishing}
      >
        <Paragraph type="secondary" style={{ fontSize: 12 }}>
          发布前将执行双关校验（资产校验器 + 模板校验器），校验通过后生成不可变版本并切换为 active。
        </Paragraph>
        {drift && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message="草稿保存于最近一次回滚之前"
            description={`最近回滚 ${drift.from || '（无）'} → ${drift.to} 发生在草稿最后保存之后；发布当前草稿会把回滚掉的内容重新发布。如非有意，请先核对差异。`}
          />
        )}
        <Form layout="vertical">
          <Form.Item label="图谱名称">
            <Input value={docName} onChange={(e) => setDocName(e.target.value)} placeholder="图谱名称（留空自动生成）" />
          </Form.Item>
          <Form.Item label="发布说明">
            <Input.TextArea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="本次发布的内容说明（可选）" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
