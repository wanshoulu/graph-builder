/**
 * AI 自动建图面板（单一模式：Agent 对话驱动）
 *
 * 对话即建图入口——用户用自然语言描述需求或直接上传文档材料：
 *   - 文本对话 → graph-builder-agent 调 generate/audit/fix 技能生成与修改图谱
 *   - 上传文档 → 服务端解析 → 文档体检 → 体检通过自动分块抽取（checkpoint 断点续跑 + 实时进度）→ 写入结果区
 *   - 抽取/质检/消解均可在对话中继续触发，产物落右侧结果区（质检评分 + 明细/画布/层级树 + 保存/发布）
 */
import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { Alert, Button, Drawer, Input, Popconfirm, Popover, Progress, Select, Space, Table, Tabs, Tag, Tooltip, Typography } from 'antd';
import { RocketOutlined, SaveOutlined, EyeOutlined, CheckCircleOutlined, CloseCircleOutlined, ThunderboltOutlined, FileTextOutlined, TableOutlined, DeleteOutlined, ClearOutlined, DownloadOutlined, UploadOutlined, DatabaseOutlined } from '@ant-design/icons';
import { message } from '@/utils/antdStatic';
import type { GraphAsset, GraphDocument, GraphTemplate, QualityReport, FillApplied } from '@/api/orgGraph';
import { validateGraph, publishGraph, saveGraph, qualityReport, fillGaps, resolveEntities, isOrgGraphError, graphToIntakeExcel, intakeExcelToGraph, downloadDraftExcel, loadGraph } from '@/api/orgGraph';
import { GraphPreviewModal } from '../shared/GraphPreviewModal';
import { G6PreviewCanvas } from '../shared/G6PreviewCanvas';
import { BuilderAgentChat } from '../shared/BuilderAgentChat';
import { currentIntentTemplateDocument, nodeDisplayName } from '../lib/graphDoc';
import { readRegistries } from '../lib/intentGraphV4';
import { ResourceRegistryDrawer, type V4Registries } from '../shared/ResourceRegistryDrawer';
import { buildFillSourceText, mergeGraphDocuments, type BuildMaterial } from '../lib/materials';
import { ResultTreeView } from './ResultTreeView';
import { QualityCard, QualityDrawer } from './QualityPanel';
import { TabularMappingModal } from './TabularMappingModal';

const { TextArea } = Input;
const { Text } = Typography;

interface AutoBuildPanelProps {
  asset: string;
  template: GraphTemplate | null;
  /** 全部图谱资产（面板内模板选择器数据源） */
  assets?: GraphAsset[];
  /** 面板内切换目标模板（与顶部资产选择同源同步） */
  onAssetChange?: (v: string) => void;
  /** 生成结果回调（供「编辑器精修」跳转） */
  onGenerated?: (document: GraphDocument) => void;
  /** 切换到专家编辑模式（用于审核精修） */
  onSwitchToManual?: () => void;
  /** 用户手动点击目录项切换资产时为 true → 草稿加载后自动展开结果 Drawer；首次自动加载/深链为 false */
  openResultOnLoad?: boolean;
}

const EMPTY_DOCUMENT: GraphDocument = { nodes: [], edges: [] };

export function AutoBuildPanel({ asset, template, assets, onAssetChange, onGenerated, onSwitchToManual, openResultOnLoad }: AutoBuildPanelProps) {
  const [result, setResult] = useState<GraphDocument | null>(null);
  /** 结果区 Drawer（点击目录项或对话生成后展开细节） */
  const [resultDrawerOpen, setResultDrawerOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [registryOpen, setRegistryOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [note, setNote] = useState('');
  const [syncedToDraft, setSyncedToDraft] = useState(false);
  /** 本次会话内已发布的版本号（结果区展示，避免重复发布） */
  const [publishedVersion, setPublishedVersion] = useState<string | null>(null);
  const [validation, setValidation] = useState<{ valid: boolean; errors: string[] } | null>(null);
  // 确定性质检报告 + AI 填充 + 实体消解状态
  const [qc, setQc] = useState<QualityReport | null>(null);
  const [qcLoading, setQcLoading] = useState(false);
  const [qcError, setQcError] = useState<string | undefined>(undefined);
  const [qcOpen, setQcOpen] = useState(false);
  const [filling, setFilling] = useState(false);
  const [fillItems, setFillItems] = useState<FillApplied[]>([]);
  const [resolving, setResolving] = useState(false);
  /** 填充/消解执行中状态文案 + 计时 */
  const [execStatusText, setExecStatusText] = useState('');
  const [execElapsed, setExecElapsed] = useState(0);
  const execTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // 材料库：上传材料的原文留存（AI 填充取证 + 表格映射 + 多文档合并抽取）
  const [materials, setMaterials] = useState<BuildMaterial[]>([]);
  const [tabularMaterial, setTabularMaterial] = useState<BuildMaterial | null>(null);
  // 知识导入 Excel 导出/导入状态
  const [exportingIntake, setExportingIntake] = useState(false);
  const [importingIntake, setImportingIntake] = useState(false);
  const [downloadingDraftExcel, setDownloadingDraftExcel] = useState(false);
  /** 文档名称（草稿命名 + 发布时带入版本记录） */
  const [docName, setDocName] = useState('');
  const intakeFileRef = useRef<HTMLInputElement>(null);
  // 分块抽取详细状态（右侧结果区状态卡数据源；聊天流内进度条会随消息滚走）
  const [extractStatus, setExtractStatus] = useState<{ name: string; completed: number; total: number; startedAt: number; phase?: string; gleanTotal?: number; failed?: boolean; error?: string } | null>(null);
  const [, setClockTick] = useState(0);
  useEffect(() => {
    if (!extractStatus) return;
    const timer = setInterval(() => setClockTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, [extractStatus]);

  // 资产切换 → 加载已有草稿（进入页面即恢复上次产物，syncedToDraft 正确标记为已同步）
  useEffect(() => {
    if (!asset) return;
    let cancelled = false;
    loadGraph(asset)
      .then((draft) => {
        if (cancelled) return;
        if (draft && Array.isArray(draft.nodes) && draft.nodes.length > 0) {
          setResult(draft);
          setDocName((draft.metadata?.name as string) || '');
          setSyncedToDraft(true);
          onGenerated?.(draft);
          // 用户手动点击目录项切换资产 → 自动展开结果 Drawer；首次自动加载不展开
          if (openResultOnLoad) setResultDrawerOpen(true);
        }
      })
      .catch(() => { /* 无草稿不报错 */ });
    return () => { cancelled = true; };
  }, [asset]);

  const nodeColumns = useMemo(() => [
    { title: '名称', dataIndex: 'name', key: 'name', ellipsis: true },
    { title: '类型', dataIndex: 'type', key: 'type', width: 140, render: (t: string) => <Tag>{t}</Tag> },
    { title: '置信度', dataIndex: 'confidence', key: 'confidence', width: 90, render: (c?: number) => (c !== undefined ? c.toFixed(2) : '-') },
    { title: '来源', dataIndex: 'source', key: 'source', width: 200, ellipsis: true },
  ], []);
  const edgeColumns = useMemo(() => [
    { title: '关系', dataIndex: 'type', key: 'type', width: 140, render: (t: string) => <Tag color="blue">{t}</Tag> },
    { title: '源', dataIndex: 'source', key: 'source', ellipsis: true },
    { title: '目标', dataIndex: 'target', key: 'target', ellipsis: true },
    { title: '置信度', dataIndex: 'confidence', key: 'confidence', width: 90, render: (c?: number) => (c !== undefined ? c.toFixed(2) : '-') },
  ], []);

  const nodeRows = useMemo(() => (result?.nodes || []).map((n, i) => ({
    key: i,
    name: nodeDisplayName(n, template || undefined),
    type: n.type,
    confidence: n.confidence,
    source: n.provenance?.sourceDoc || n.provenance?.source || '-',
  })), [result, template]);
  const edgeRows = useMemo(() => {
    const nameOf: Record<string, string> = {};
    (result?.nodes || []).forEach((n) => { nameOf[n.id] = nodeDisplayName(n, template || undefined); });
    return (result?.edges || []).map((e, i) => ({
      key: i,
      type: e.type,
      source: nameOf[e.source] || e.source,
      target: nameOf[e.target] || e.target,
      confidence: e.confidence,
    }));
  }, [result, template]);

  // ── 确定性质检报告（对话产物写入后刷新）；qc 独立单调 seq：新一次质检发起即废弃旧 in-flight 响应，
  //    否则「生成后自动质检」与填充/消解后的手动质检并发时，慢的旧响应会覆盖新报告 ──
  const docSeqRef = useRef(0);
  const qcSeqRef = useRef(0);
  const runQuality = useCallback(async (doc: GraphDocument) => {
    const seq = ++qcSeqRef.current;
    setQcLoading(true);
    setQcError(undefined);
    try {
      const r = await qualityReport(asset, doc);
      if (seq === qcSeqRef.current) setQc(r);
    } catch (e) {
      if (seq === qcSeqRef.current) {
        setQc(null);
        setQcError(e instanceof Error ? e.message : '质检服务暂不可用，请稍后重试');
      }
    } finally {
      if (seq === qcSeqRef.current) setQcLoading(false);
    }
  }, [asset]);

  // ── 对话产物统一出口：agent 返回 / 上传抽取完成 ──
  // opts.merge = 抽取/映射产物并入当前结果（多文档累积建图）；缺省替换（agent 生成的全新图谱）
  const handleDocument = useCallback((doc: GraphDocument, opts?: { merge?: boolean }) => {
    let next = opts?.merge && result ? mergeGraphDocuments(result, doc) : doc;
    // 累积来源文件名（mergeGraphDocuments 浅合并 metadata 时 base 优先，需手动累积新文件名）
    if (opts?.merge && result) {
      const baseSrc = (result.metadata?.sourceFileName as string) || '';
      const incSrc = (doc.metadata?.sourceFileName as string) || '';
      if (incSrc && !baseSrc.split(', ').includes(incSrc)) {
        next = { ...next, metadata: { ...(next.metadata || {}), sourceFileName: baseSrc ? `${baseSrc}, ${incSrc}` : incSrc } };
      }
    }
    const seq = ++docSeqRef.current;
    setResult(next);
    setSyncedToDraft(false);
    // 全新生成（非累积合并）时重置名称，避免沿用上一份草稿的名称
    if (!opts?.merge) setDocName('');
    onGenerated?.(next);
    // 有产物时自动展开结果 Drawer
    setResultDrawerOpen(true);
    try {
      validateGraph(asset, next)
        .then((v) => {
          if (seq !== docSeqRef.current) return;
          setValidation({ valid: v.valid, errors: [...v.asset.errors, ...v.template.errors].map((e) => e.message) });
        })
        .catch(() => { /* 校验服务不可用时不阻塞对话流程 */ });
    } catch { /* 不阻塞 */ }
    runQuality(next);
  }, [asset, onGenerated, runQuality, result]);

  // ── 材料入库（上传体检通过后回调） ──
  const handleMaterialAdd = useCallback((material: Omit<BuildMaterial, 'id' | 'addedAt'>) => {
    setMaterials((list) => [...list, {
      ...material,
      id: `bm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      addedAt: Date.now(),
    }]);
  }, []);

  const handleMaterialRemove = useCallback((id: string) => {
    setMaterials((list) => list.filter((m) => m.id !== id));
  }, []);

  // ── AI 填充：从材料库原文取证补全占位/空必填字段 ──
  const doFill = useCallback(async () => {
    if (!result) return;
    if (materials.length === 0) {
      message.warning('材料库为空——先上传文档材料，AI 才能从原文取证填充（不编造）', 6);
      return;
    }
    setFilling(true);
    setExecElapsed(0);
    setExecStatusText('正在分析缺口字段…');
    execTimerRef.current = setInterval(() => setExecElapsed((t) => t + 1), 1000);
    try {
      const r = await fillGaps(asset, result, buildFillSourceText(materials));
      setExecStatusText(`正在写入 ${r.stats.filled} 个填充结果…`);
      setResult(r.document);
      onGenerated?.(r.document);
      setFillItems(r.fills);
      await runQuality(r.document);
      if (r.stats.filled > 0) {
        message.success(`AI 填充完成：${r.stats.filled}/${r.stats.gaps} 个缺口已从 ${materials.length} 份材料原文取证填充`, 5);
        (r.warnings || []).forEach((w) => message.warning(w, 8));
        if (syncedToDraft) {
          try { await saveGraph(asset, currentIntentTemplateDocument(asset, template, r.document)); } catch { /* 草稿重存失败不阻断，用户可手动保存 */ }
        }
      } else if ((r.warnings || []).length > 0) {
        (r.warnings || []).forEach((w) => message.warning(w, 8));
      } else {
        message.warning(`材料原文中没有可靠依据，未填充任何字段（缺口 ${r.stats.gaps} 个）——不编造是填充的底线`, 6);
      }
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'AI 填充失败');
    } finally {
      setFilling(false);
      setExecStatusText('');
      if (execTimerRef.current) { clearInterval(execTimerRef.current); execTimerRef.current = null; }
    }
  }, [result, asset, template, onGenerated, runQuality, syncedToDraft, materials]);

  // ── 实体消解：确定性合并同名同类型重复节点（零 LLM） ──
  const doResolve = useCallback(async () => {
    if (!result) return;
    setResolving(true);
    setExecElapsed(0);
    setExecStatusText('正在扫描同名重复节点…');
    execTimerRef.current = setInterval(() => setExecElapsed((t) => t + 1), 1000);
    try {
      const r = await resolveEntities(asset, result);
      setExecStatusText(`正在合并 ${r.stats.mergedNodes} 个重复节点…`);
      if (r.merges.length > 0) {
        setResult(r.document);
        onGenerated?.(r.document);
        await runQuality(r.document);
        const detail = r.merges.slice(0, 3).map((m) => `「${m.droppedName}」→「${m.keptName}」`).join('、');
        message.success(`实体消解完成：合并 ${r.stats.mergedNodes} 个重复节点（${detail}${r.merges.length > 3 ? ' 等' : ''}），重定向 ${r.stats.movedEdges} 条边、去除 ${r.stats.droppedEdges} 条自环/重复边`, 7);
        if (syncedToDraft) {
          try { await saveGraph(asset, currentIntentTemplateDocument(asset, template, r.document)); } catch { /* 草稿重存失败不阻断 */ }
        }
      } else {
        message.info('没有发现同名（忽略全角/空白/尾标点）同类型的重复节点，图谱无需消解', 5);
      }
    } catch (e) {
      message.error(e instanceof Error ? e.message : '实体消解失败');
    } finally {
      setResolving(false);
      setExecStatusText('');
      if (execTimerRef.current) { clearInterval(execTimerRef.current); execTimerRef.current = null; }
    }
  }, [result, asset, template, onGenerated, runQuality, syncedToDraft]);

  async function saveDraft() {
    if (!result) return;
    setSaving(true);
    try {
      // intent-graph 资产必须绑定当前模板版本（与专家建图页保存同语义）
      const nextDocument = currentIntentTemplateDocument(asset, template, result);
      // 写入图谱名称到 metadata（与 GraphBuilder 一致）
      if (docName.trim()) {
        nextDocument.metadata = { ...(nextDocument.metadata || {}), name: docName.trim() };
      }
      // 用户显式点击保存：force 绕过骤减防线（旧稿自动归档可回退）
      await saveGraph(asset, nextDocument, { force: true });
      setResult(nextDocument);
      setSyncedToDraft(true);
      message.success('草稿已保存，可在图谱管理中查看');
    } catch (e) {
      message.error(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  async function publish() {
    if (!result) return;
    setPublishing(true);
    try {
      const nextDocument = currentIntentTemplateDocument(asset, template, result);
      // 写入图谱名称到 metadata（与 GraphBuilder 一致）
      if (docName.trim()) {
        nextDocument.metadata = { ...(nextDocument.metadata || {}), name: docName.trim() };
      }
      // 发布前执行双关校验
      const v = await validateGraph(asset, nextDocument);
      if (!v.valid) {
        const errors = [...v.asset.errors, ...v.template.errors];
        message.error(`发布前校验未通过：${errors.slice(0, 3).map((e) => e.message).join('；')}${errors.length > 3 ? ` …还有 ${errors.length - 3} 条` : ''}`, 8);
        setValidation({ valid: false, errors: errors.map((e) => e.message) });
        return;
      }
      const res = await publishGraph(asset, nextDocument, note.trim());
      setResult(nextDocument);
      // 发布只写版本不写草稿：这里真实保存一次草稿，让「草稿已同步」名副其实
      try { await saveGraph(asset, nextDocument); setSyncedToDraft(true); } catch { setSyncedToDraft(false); }
      if (res.pendingApproval) {
        message.success(`已提交发布审批（请求 ${res.request?.id || ''}），管理员审批通过后在图谱管理中发布生效`, 8);
      } else {
        setPublishedVersion(res.version);
        message.success(`已发布 ${res.version}，可在图谱管理中查看版本记录`);
      }
      setValidation({ valid: true, errors: [] });
    } catch (e) {
      message.error(e instanceof Error ? e.message : '发布失败');
    } finally {
      setPublishing(false);
    }
  }

  // ── 图谱 → 知识导入 Excel 导出 ──
  async function exportToIntakeExcel() {
    if (!result || result.nodes.length === 0) {
      message.warning('请先生成图谱内容');
      return;
    }
    setExportingIntake(true);
    try {
      const { blob, fileName } = await graphToIntakeExcel(result);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
      message.success('已导出知识导入 Excel，可在知识导入工具中导入审核');
    } catch (e) {
      message.error(e instanceof Error ? e.message : '导出失败');
    } finally {
      setExportingIntake(false);
    }
  }

  // ── 知识导入 Excel → 图谱导入 ──
  async function importFromIntakeExcel(file: File) {
    setImportingIntake(true);
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          const base64 = dataUrl.split(',')[1] || '';
          resolve(base64);
        };
        reader.onerror = () => reject(new Error('文件读取失败'));
        reader.readAsDataURL(file);
      });
      const res = await intakeExcelToGraph(base64);
      if (res.document && res.document.nodes.length > 0) {
        setResult(res.document);
        setSyncedToDraft(false);
        setPublishedVersion(null);
        onGenerated?.(res.document);
        message.success(`已从 Excel 导入 ${res.stats.functionCount} 个功能、${res.stats.intentCount} 个意图、共 ${res.stats.nodeCount} 个节点`);
      } else {
        message.warning('Excel 中未找到有效数据');
      }
    } catch (e) {
      message.error(e instanceof Error ? e.message : '导入失败');
    } finally {
      setImportingIntake(false);
    }
  }

  // ── 下载资产草稿 Excel（saveDraft 时自动落盘的 schema 合规 Excel） ──
  async function downloadDraftExcelFromAsset() {
    setDownloadingDraftExcel(true);
    try {
      const { blob, fileName } = await downloadDraftExcel(asset);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
      message.success('已下载草稿 Excel');
    } catch (e) {
      message.error(e instanceof Error ? e.message : '下载失败');
    } finally {
      setDownloadingDraftExcel(false);
    }
  }

  // ── 渲染：目标模板信息条（一行收纳，类型详情进 Popover） ──
  const renderTemplateBar = () => {
    if (!template) return null;
    const detail = (
      <div style={{ maxWidth: 540, maxHeight: 380, overflowY: 'auto' }}>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>节点类型（{template.node_types.length}）</div>
        <div style={{ marginBottom: 12 }}>
          {template.node_types.map((t) => {
            const required = (t.fields || []).filter((f) => f.required);
            const fieldList = (t.fields || []).map((f) => `${f.label || f.key}${f.required ? '（必填）' : ''}`).join('、');
            return (
              <Tooltip key={t.type} title={fieldList || t.type}>
                <Tag style={{ marginBottom: 4 }}>
                  {t.label || t.type}{required.length > 0 ? ` · ${required.length}必填` : ''}
                </Tag>
              </Tooltip>
            );
          })}
        </div>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>关系类型（{template.edge_types.length}）</div>
        <div>
          {template.edge_types.map((e) => {
            const endpoints = `${(e.source_types || []).join('/') || '?'} → ${(e.target_types || []).join('/') || '?'}`;
            return (
              <Tooltip key={e.type} title={`${e.type}：${endpoints}`}>
                <Tag color="blue" style={{ marginBottom: 4 }}>{e.label || e.type}</Tag>
              </Tooltip>
            );
          })}
        </div>
        <div style={{ fontSize: 11, color: '#86909c', marginTop: 10 }}>
          生成与抽取严格收敛到以上模板类型（LLM 未知类型由服务端回退）；保存 / 发布前执行双关校验。
        </div>
      </div>
    );
    return (
      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '10px 14px', borderRadius: 12, border: '1px solid #e6ebf5', background: '#fff' }}>
        <Text strong style={{ fontSize: 13 }}>目标模板</Text>
        {assets && assets.length > 0 && onAssetChange ? (
          <Select
            size="small"
            style={{ minWidth: 250 }}
            value={asset}
            onChange={onAssetChange}
            options={assets.map((a) => ({ value: a.assetId, label: `${a.name}${a.name_en ? ' / ' + a.name_en : ''}（${a.assetId}）` }))}
          />
        ) : (
          <Tag color="blue">{template.name}</Tag>
        )}
        <Popover content={detail} placement="bottomLeft" trigger="click">
          <Tag style={{ cursor: 'pointer', marginInlineEnd: 0 }} color="geekblue">
            节点类型 {template.node_types.length} · 关系类型 {template.edge_types.length}
          </Tag>
        </Popover>
        {template.description && (
          <Text type="secondary" style={{ fontSize: 12, flex: 1, minWidth: 200 }} ellipsis>{template.description}</Text>
        )}
        <Tooltip title="下载资产草稿的符合 schema 的 Excel（保存草稿时自动生成）">
          <Button size="small" icon={<DownloadOutlined />} loading={downloadingDraftExcel} onClick={downloadDraftExcelFromAsset}>下载草稿 Excel</Button>
        </Tooltip>
      </div>
    );
  };

  // ── 渲染：材料库条（上传材料的留存与入口） ──
  const TRIAGE_TAG: Record<BuildMaterial['triageMode'], { color: string; label: string }> = {
    extract: { color: 'green', label: '已抽取' },
    suggest_tabular: { color: 'blue', label: '表格数据' },
    low_relevance: { color: 'orange', label: '低相关' },
    reject: { color: 'red', label: '体检未过' },
  };
  const renderMaterials = () => {
    if (materials.length === 0) return null;
    return (
      <div style={{ flexShrink: 0, padding: '10px 14px', borderRadius: 12, border: '1px solid #e6ebf5', background: '#fafcff' }}>
        <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Text strong style={{ fontSize: 13 }}>材料库（{materials.length}）</Text>
          <Text type="secondary" style={{ fontSize: 11 }}>
            材料原文用于 AI 填充取证；表格数据可在「表格映射」里确定性建图（0 次 LLM）
          </Text>
        </div>
        <Space size={8} wrap>
          {materials.map((m) => (
            <div
              key={m.id}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 8, border: '1px solid #e0e8f5', background: '#fff' }}
            >
              <FileTextOutlined style={{ color: '#5b7bb2', fontSize: 13 }} />
              <Tooltip title={`${m.chars.toLocaleString()} 字符`}>
                <Text style={{ fontSize: 12, maxWidth: 180 }} ellipsis>{m.name}</Text>
              </Tooltip>
              <Tag color={TRIAGE_TAG[m.triageMode].color} style={{ fontSize: 11, lineHeight: '16px', marginRight: 0 }}>
                {TRIAGE_TAG[m.triageMode].label}
              </Tag>
              <Button
                size="small"
                type="link"
                icon={<TableOutlined />}
                style={{ fontSize: 12, padding: 0 }}
                onClick={() => setTabularMaterial(m)}
              >
                表格映射
              </Button>
              <Button
                size="small"
                type="text"
                danger
                icon={<DeleteOutlined />}
                style={{ width: 22, height: 22 }}
                onClick={() => handleMaterialRemove(m.id)}
                title="从材料库移除（不影响已生成的图谱）"
              />
            </div>
          ))}
        </Space>
      </div>
    );
  };

  // ── 渲染：分块抽取状态卡（右侧结果区顶部；唯一详细进度展示，剩余时间按完成速率线性外推） ──
  const renderExtractStatusCard = () => {
    if (!extractStatus) return null;
    const { name, completed, total, startedAt, phase, gleanTotal, failed, error } = extractStatus;
    // 失败状态：红色失败卡
    if (failed) {
      return (
        <div style={{
          flexShrink: 0, marginBottom: 10, padding: '12px 16px', borderRadius: 10,
          border: '1px solid #ffa39e', background: '#fff1f0',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <CloseCircleOutlined style={{ color: '#ff4d4f' }} />
            <Text strong style={{ fontSize: 13, color: '#cf1322' }}>抽取失败「{name}」</Text>
            <Tag color="error">失败</Tag>
          </div>
          <div style={{ marginTop: 8 }}>
            <Text style={{ fontSize: 12, color: '#cf1322' }}>{error || '未知错误'}</Text>
          </div>
          <div style={{ marginTop: 6 }}>
            <Text type="secondary" style={{ fontSize: 11 }}>已完成部分已缓存——重新上传同一文档将从断点续跑，无需重头抽取</Text>
          </div>
        </div>
      );
    }
    const fmt = (ms: number) => {
      const s = Math.max(0, Math.round(ms / 1000));
      return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    };
    const elapsedMs = Date.now() - startedAt;
    const isGleaning = phase === 'gleaning';
    // gleaning 阶段 completed 会超过 total（onGleanDone 累加到同一计数器），分阶段计算
    const mainDone = isGleaning ? total : Math.min(completed, total);
    const gleanDone = isGleaning ? completed - total : 0;
    const mainPercent = total > 0 ? Math.min(100, Math.round((mainDone / total) * 100)) : 0;
    const etaMs = mainDone > 0 && mainDone < total ? (elapsedMs / mainDone) * (total - mainDone) : null;
    return (
      <div style={{
        flexShrink: 0, marginBottom: 10, padding: '12px 16px', borderRadius: 10,
        border: `1px solid ${isGleaning ? '#b7eb8f' : '#91caff'}`,
        background: isGleaning ? '#f6ffed' : '#f0f7ff',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <FileTextOutlined style={{ color: isGleaning ? '#52c41a' : '#1677ff' }} />
          <Text strong style={{ fontSize: 13 }}>
            {isGleaning ? '补充抽取' : '分块抽取'}「{name}」
          </Text>
          <Tag color={isGleaning ? 'success' : 'processing'}>
            {total === 0
              ? '分块中…'
              : isGleaning
                ? `主抽取 ${total}/${total} 块 ✓ · 补充扫描 ${gleanDone}${gleanTotal ? `/${gleanTotal}` : ''} 块`
                : `主抽取 ${mainDone}/${total} 块`}
          </Tag>
          <span style={{ flex: 1 }} />
          <Text type="secondary" style={{ fontSize: 12 }}>
            已用时 {fmt(elapsedMs)}{etaMs != null ? ` · 预计还需 ${fmt(etaMs)}` : ''}
          </Text>
        </div>
        <Progress
          percent={isGleaning ? 100 : mainPercent}
          size="small"
          status="active"
          strokeColor={isGleaning ? '#52c41a' : '#1677ff'}
          style={{ marginTop: 8, marginBottom: 4 }}
        />
        <Text type="secondary" style={{ fontSize: 11 }}>
          {isGleaning
            ? '正在对实体不足的块进行二次补充扫描，提升召回率…'
            : '5 路并发抽取 · 已完成块实时落盘缓存，中断后重新上传同一文件将自动续跑'}
        </Text>
      </div>
    );
  };

  // ── 渲染：结果展示 Tabs（明细表格 / 图谱画布 / 层级树） ──
  const renderResultTabs = () => (
    <Tabs
      defaultActiveKey="table"
      items={[
        {
          key: 'table',
          label: '明细表格',
          children: (
            <>
              <div style={{ marginBottom: 6 }}><Text strong style={{ fontSize: 13 }}>节点明细（{nodeRows.length}）</Text></div>
              <Table size="small" columns={nodeColumns} dataSource={nodeRows} pagination={{ pageSize: 6 }} />
              <div style={{ margin: '14px 0 6px' }}><Text strong style={{ fontSize: 13 }}>关系明细（{edgeRows.length}）</Text></div>
              <Table size="small" columns={edgeColumns} dataSource={edgeRows} pagination={{ pageSize: 6 }} />
            </>
          ),
        },
        {
          key: 'canvas',
          label: '图谱画布',
          children: result && template ? <G6PreviewCanvas document={result} template={template} height={420} /> : null,
        },
        {
          key: 'tree',
          label: '层级树',
          children: result && template ? <ResultTreeView document={result} template={template} height={420} /> : null,
        },
      ]}
    />
  );

  // ── 渲染：结果区（对话产物 + 质检 + 保存/发布） ──
  const renderResult = () => result && (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        <Space size={8} wrap>
          <Text strong style={{ fontSize: 14 }}>构建结果</Text>
          <Tag color="blue" style={{ borderRadius: 4 }}>{result.nodes.length} 节点</Tag>
          <Tag color="cyan" style={{ borderRadius: 4 }}>{result.edges.length} 边</Tag>
          {validation && (validation.valid
            ? <Tag color="green" icon={<CheckCircleOutlined />} style={{ borderRadius: 4 }}>双关校验通过</Tag>
            : <Tag color="orange" icon={<CloseCircleOutlined />} style={{ borderRadius: 4 }}>{validation.errors.length} 个校验问题</Tag>)}
          {syncedToDraft && <Tag color="green" style={{ borderRadius: 4 }}>草稿已同步</Tag>}
          {publishedVersion && (
            <Tooltip title="当前内容已发布为正式版本；继续修改后需重新发布">
              <Tag color="purple" icon={<RocketOutlined />} style={{ borderRadius: 4 }}>已发布 {publishedVersion}</Tag>
            </Tooltip>
          )}
        </Space>
        <Space size={8}>
          <Popconfirm
            title="清空当前结果？"
            description="材料库中的材料会保留，可重新映射或抽取。"
            okText="清空"
            cancelText="取消"
            onConfirm={() => { setResult(null); setValidation(null); setQc(null); setFillItems([]); setSyncedToDraft(false); setPublishedVersion(null); setDocName(''); onGenerated?.(EMPTY_DOCUMENT); }}
          >
            <Button size="small" icon={<ClearOutlined />} disabled={saving}>清空结果</Button>
          </Popconfirm>
          <Button size="small" icon={<EyeOutlined />} onClick={() => setPreviewOpen(true)}>图预览</Button>
          {asset === 'intent-graph-v4' && (
            <Tooltip title="资源注册表（能力/FAQ/策略/技能绑定）">
              <Button size="small" icon={<DatabaseOutlined />} onClick={() => setRegistryOpen(true)}>资源注册表</Button>
            </Tooltip>
          )}
            <Tooltip title="将当前图谱导出为知识导入一体化填写 Excel，供业务人员审核">
              <Button size="small" icon={<DownloadOutlined />} loading={exportingIntake} disabled={!result || result.nodes.length === 0} onClick={exportToIntakeExcel}>导出到知识导入</Button>
            </Tooltip>
            <Tooltip title="从知识导入 Excel 生成图谱（一体化填写格式）">
              <Button size="small" icon={<UploadOutlined />} loading={importingIntake} onClick={() => intakeFileRef.current?.click()}>从 Excel 导入</Button>
            </Tooltip>
            <input ref={intakeFileRef} type="file" accept=".xlsx,.xls" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) void importFromIntakeExcel(f); e.target.value = ''; }} />
            {onSwitchToManual && (
              <Button size="small" type="primary" ghost onClick={onSwitchToManual}>进入审核精修</Button>
            )}
        </Space>
      </div>
      {validation && !validation.valid && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={`仍有 ${validation.errors.length} 个校验问题，建议处理后发布`}
          description={(
            <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12 }}>
              {validation.errors.slice(0, 5).map((e, i) => <li key={i}>{e}</li>)}
              {validation.errors.length > 5 && <li>…还有 {validation.errors.length - 5} 条</li>}
            </ul>
          )}
        />
      )}
      <QualityCard
        report={qc}
        loading={qcLoading}
        filling={filling}
        resolving={resolving}
        statusText={execStatusText ? `${execStatusText}（${execElapsed}s）` : undefined}
        placeholderCount={qc?.summary.placeholderCount ?? 0}
        materialsCount={materials.length}
        error={qcError}
        onFill={doFill}
        onResolve={doResolve}
        onOpenDetail={() => setQcOpen(true)}
        onRetry={() => result && runQuality(result)}
      />
      {renderResultTabs()}
    </div>
  );

  // ── 渲染：保存/发布固定底栏（不随结果区滚动，操作动线：生成 → 质检 → 保存/发布） ──
  const renderPublishBar = () => (
    <div style={{ flexShrink: 0, borderTop: '1px solid #f0f2f7', paddingTop: 10, marginTop: 10, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <Input
        size="small"
        style={{ width: 200 }}
        value={docName}
        onChange={(e) => setDocName(e.target.value)}
        placeholder="图谱名称（留空自动生成）"
        prefix={<FileTextOutlined style={{ color: '#999' }} />}
      />
      <Button icon={<SaveOutlined />} loading={saving} disabled={publishing} onClick={saveDraft}>
        {syncedToDraft ? '重新保存草稿' : '保存草稿'}
      </Button>
      <Input
        size="small"
        style={{ width: 200 }}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="发布说明（可选）"
      />
      <Button type="primary" icon={<RocketOutlined />} loading={publishing} disabled={saving} onClick={publish}>
        发布为正式版本
      </Button>
      {publishedVersion && <Text type="secondary" style={{ fontSize: 11 }}>当前内容已发布为 {publishedVersion}</Text>}
    </div>
  );

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
      {renderTemplateBar()}

      {renderMaterials()}

      {/* 对话框占满主区域 */}
      <div
        className="auto-build-pane auto-build-agent-pane"
        style={{
          flex: '1 1 100%', minWidth: 0, minHeight: 0,
          display: 'flex', flexDirection: 'column',
          padding: '12px 14px', borderRadius: 12, border: '1px solid #e6ebf5', background: '#fff',
        }}
      >
        <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, paddingBottom: 8, borderBottom: '1px solid #f0f2f7' }}>
          <div style={{ width: 26, height: 26, borderRadius: 7, background: 'linear-gradient(135deg, #1677ff, #722ed1)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <ThunderboltOutlined style={{ color: '#fff', fontSize: 13 }} />
          </div>
          <Text strong style={{ fontSize: 13 }}>Agent 对话建图</Text>
          <Text type="secondary" style={{ fontSize: 11 }}>描述需求生成 · 上传文档抽取 · 继续对话修改</Text>
          {result && (
            <Button size="small" type="link" icon={<EyeOutlined />} onClick={() => setResultDrawerOpen(true)}>
              查看图谱产物
            </Button>
          )}
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          <BuilderAgentChat
            asset={asset}
            document={result || EMPTY_DOCUMENT}
            template={template}
            active={true}
            open={true}
            onGenerated={handleDocument}
            onMaterialAdd={handleMaterialAdd}
            fillSourceText={materials.length > 0 ? buildFillSourceText(materials) : undefined}
            onExtractProgress={setExtractStatus}
          />
        </div>
      </div>

      {/* 结果区 Drawer：点击目录项或对话生成后展开细节 */}
      <Drawer
        title="图谱产物 · 质检 · 发布"
        placement="right"
        open={resultDrawerOpen}
        onClose={() => setResultDrawerOpen(false)}
        width={560}
        styles={{ body: { padding: 0, display: 'flex', flexDirection: 'column', height: '100%' } }}
      >
        {result && (
          <>
            {renderExtractStatusCard()}
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '12px 14px' }}>{renderResult()}</div>
            <div style={{ flexShrink: 0, padding: '12px 14px', borderTop: '1px solid #e6ebf5' }}>{renderPublishBar()}</div>
          </>
        )}
      </Drawer>

      <GraphPreviewModal open={previewOpen} document={result} template={template} onClose={() => setPreviewOpen(false)} />
      {asset === 'intent-graph-v4' && (
        <ResourceRegistryDrawer
          open={registryOpen}
          onClose={() => setRegistryOpen(false)}
          registries={result ? (readRegistries(result) as unknown as V4Registries) : null}
          onFocusChange={() => undefined}
          onChange={(next) => {
            if (!result) return;
            setResult({ ...result, metadata: { ...(result.metadata || {}), v4ResourceRegistries: next } });
            setSyncedToDraft(false);
          }}
        />
      )}
      <QualityDrawer open={qcOpen} report={qc} fills={fillItems} onClose={() => setQcOpen(false)} />
      <TabularMappingModal
        open={tabularMaterial !== null}
        asset={asset}
        material={tabularMaterial}
        template={template}
        onClose={() => setTabularMaterial(null)}
        onBuilt={(doc, summary) => {
          handleDocument(doc, { merge: true });
          message.info(`映射产物已并入结果区：${summary}`, 4);
        }}
      />
    </div>
  );
}
