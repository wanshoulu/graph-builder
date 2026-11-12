/**
 * 知识导入与审核（v5 容器：紧凑页头 + 三栏审核工作台 + 质量验收）
 * 页头回答：哪个批次 / 审核进度 / 是否可入图；工作台承担队列-详情-问题的连续审核循环
 * 两段式底线不变：任何写路径只产出「待确认」，approved 必须经 review 端点人工产生
 * 数据流：工作台自管行数据（三类 items 前端组装）；本容器只持横切状态（审核弹窗/助手/入图/验收），
 * 任何改动数据的外部动作完成后 dataVersion+1 触发工作台整刷
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Alert,
  Badge,
  Button,
  Collapse,
  Drawer,
  Dropdown,
  Form,
  Input,
  message,
  Modal,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
  Upload,
} from "antd";
import {
  ApartmentOutlined,
  CloudUploadOutlined,
  DeleteOutlined,
  DownloadOutlined,
  ExportOutlined,
  FileAddOutlined,
  FileDoneOutlined,
  RollbackOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import {
  knowledgeIntakeApi,
  type AcceptanceReport,
  type ApplyResult,
  type AssistGetResult,
  type AssistItem,
  type ImportResult,
  type IntakeBatchSummary,
  type IntakeItem,
  type IntakeRowInput,
  type IntakeRowType,
  type NodeReviewResult,
  type PreviewApplyResult,
  type RevisionChange,
  type RevisionListResult,
} from "@/api/knowledgeIntake";
import { listAssets, downloadDraftExcel } from "@/api/orgGraph";
import { ROW_TYPE_LABEL } from "./constants";
import { ReviewWorkbench } from "./ReviewWorkbench";
import { assistLocateUnit } from "./AssistPanel";
import { UnifiedReviewPanel } from "./UnifiedReviewPanel";
import { RecallTestPanel } from "./RecallTestPanel";
import { DetailForm } from "./DetailDrawer";
import { CREATE_DRAFT_DEFAULTS } from "./detail-fields";
import { rowTitle, type SheetRow } from "./sheet-model";
import "./knowledgeIntake.css";

const { Text } = Typography;

type WorkTab = "review";

export default function KnowledgeIntake() {
  const navigate = useNavigate();

  // 批次
  const [batches, setBatches] = useState<IntakeBatchSummary[]>([]);
  const [activeBatchId, setActiveBatchId] = useState("");
  const [batchLoading, setBatchLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [exporting, setExporting] = useState(false);

  // 工作区：审核工作台 / 质量验收（就绪与入图在质量区）
  const [activeTab, setActiveTab] = useState<WorkTab>("review");

  // 数据版本：审核动作/编辑保存/采纳建议等横切动作完成后 +1，工作台监听整刷
  const [dataVersion, setDataVersion] = useState(0);
  const bumpVersion = () => setDataVersion((v) => v + 1);

  // 工作台上报的阻断项数量（挂接缺口 + 预检冲突），页头就绪语句用
  const [blockedCount, setBlockedCount] = useState(0);

  // 驳回弹窗（驳回必须填写审核意见）
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectIds, setRejectIds] = useState<string[]>([]);
  const [rejectNote, setRejectNote] = useState("");

  // AI 骨架助手（数据状态保留，入口合并到全局面板）
  const [assistRunning, setAssistRunning] = useState(false);
  const [assistData, setAssistData] = useState<AssistGetResult | null>(null);
  const [nodeReviewData, setNodeReviewData] = useState<NodeReviewResult | null>(null);
  const [assistDeciding, setAssistDeciding] = useState<string[]>([]);

  // 全局AI审核面板（合并质量报告 + 骨架助手 + 修订审阅）
  const [unifiedOpen, setUnifiedOpen] = useState(false);
  const [unifiedRevId, setUnifiedRevId] = useState<string | null>(null);

  // 召回试测（业务人员的「试一试」：输问句看命中意图）
  const [recallOpen, setRecallOpen] = useState(false);

  // 修订审阅数据（全局面板内展示）
  const [revisionData, setRevisionData] = useState<RevisionListResult | null>(null);

  // 在线编辑保存中（工作台分组编辑共用）
  const [saving, setSaving] = useState(false);

  // 在线新建（队列行溢出菜单 → 抽屉表单；平台状态固定 pending，两段式）
  const [createRowType, setCreateRowType] = useState<IntakeRowType | null>(null);
  const [createDraft, setCreateDraft] = useState<IntakeItem | null>(null);
  const [createDrawerOpen, setCreateDrawerOpen] = useState(false);

  // L0 领域（图谱领域，队列根节点名）与行删除
  const [domainOpen, setDomainOpen] = useState(false);
  const [domainValue, setDomainValue] = useState("");
  const [domainSaving, setDomainSaving] = useState(false);
  const [createForm] = Form.useForm();

  // 导出表回导的业务审核结论（导入人显式裁决：采纳=平台人工确认动作）
  type ReviewFlow = {
    newBatchId: string;
    srcBatchId: string;
    meta: { marked: number; approved: number; rejected: number };
    busy: boolean;
  };
  const [reviewFlow, setReviewFlow] = useState<ReviewFlow | null>(null);

  // 应用 / 回滚
  const [assetOptions, setAssetOptions] = useState<{ value: string; label: string }[]>([
    { value: "intent-graph", label: "意图图谱（intent-graph）" },
  ]);
  const [applyAsset, setApplyAsset] = useState("intent-graph");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewResult, setPreviewResult] = useState<PreviewApplyResult | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<ApplyResult | null>(null);
  const [rollingBack, setRollingBack] = useState(false);
  // 本次「应用到图谱」的目标条目：预览时锁定，确认入图用同一批（不勾选 = 全部已确认）
  const [previewIds, setPreviewIds] = useState<string[]>([]);

  // 质量验收
  const [acceptanceData, setAcceptanceData] = useState<AcceptanceReport | null>(null);
  const [acceptanceLoading, setAcceptanceLoading] = useState(false);
  // 验收问题/AI 建议定位：unit（功能全路径或意图 ref）由工作台视图无关解析并选中该行
  const [focusUnit, setFocusUnit] = useState<{ unit: string; nonce: number } | null>(null);

  const activeBatch = batches.find((b) => b.batchId === activeBatchId);

  const refreshBatches = useCallback(async (preferId?: string) => {
    setBatchLoading(true);
    try {
      const data = await knowledgeIntakeApi.listBatches();
      setBatches(data.batches);
      setActiveBatchId((prev) => {
        const want = preferId || prev;
        if (want && data.batches.some((b) => b.batchId === want)) return want;
        return data.batches[0]?.batchId || "";
      });
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setBatchLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshBatches();
    listAssets()
      .then((assets) => {
        if (assets.length) {
          setAssetOptions(assets.map((a) => ({ value: a.assetId, label: `${a.name}${a.name_en ? ' / ' + a.name_en : ''}（${a.assetId}）` })));
        }
      })
      .catch(() => undefined);
  }, [refreshBatches]);

  // 换批次：清建议/验收/入图结果，并预取待裁决建议数（AI 助手徽标用）
  useEffect(() => {
    setApplyResult(null);
    setPreviewResult(null);
    setAssistData(null);
    setAcceptanceData(null);
    setBlockedCount(0);
    setUnifiedOpen(false);
    if (activeBatchId) {
      knowledgeIntakeApi
        .getSkeletonAssist(activeBatchId)
        .then(setAssistData)
        .catch(() => undefined);
    }
  }, [activeBatchId]);

  // 修订列表：换批次 / 数据变化（行编辑会追加审计修订）时重拉
  const refreshRevisions = useCallback(async () => {
    if (!activeBatchId) {
      setRevisionData(null);
      return;
    }
    try {
      setRevisionData(await knowledgeIntakeApi.listRevisions(activeBatchId));
    } catch {
      setRevisionData(null);
    }
  }, [activeBatchId]);

  useEffect(() => {
    void refreshRevisions();
  }, [refreshRevisions, dataVersion]);

  // 待裁决变更的行集合（队列绿「修订」标记）
  const pendingRevisionRowIds = useMemo(() => {
    const ids = new Set<string>();
    (revisionData?.revisions || []).forEach((rev) =>
      rev.changes.forEach((c) => {
        if (c.resolution === "pending") ids.add(c.rowId);
      }),
    );
    return ids;
  }, [revisionData]);

  const revisionOpenCount = revisionData?.open || 0;

  const openRevisions = () => { setUnifiedRevId(null); setUnifiedOpen(true); };

  // AI 补全产生新修订：刷新列表并打开全局面板定位该修订
  const handleRevisionCreated = (revId: string) => {
    void refreshRevisions();
    setUnifiedRevId(revId);
    setUnifiedOpen(true);
  };

  const handleRevisionResolved = () => {
    bumpVersion();
    void refreshBatches(activeBatchId);
  };

  // 待裁决建议数：徽标提醒业务人员还有 AI 建议没处理
  const assistOpenCount = useMemo(
    () => Object.values(assistData?.summary?.byKind || {}).reduce((sum, k) => sum + (k?.open || 0), 0),
    [assistData],
  );

  // AI 建议平铺（工作台右栏按选中行匹配 suggested 项）
  const assistItemsFlat = useMemo(
    () => Object.values(assistData?.grouped || {}).flatMap((g) => g.items),
    [assistData],
  );

  // ── 批次操作 ──

  const handleUpload = async (file: File) => {
    setImporting(true);
    try {
      const data = await knowledgeIntakeApi.importExcel(file);
      setImportResult(data);
      if (data.reviewMeta && data.reviewMeta.marked > 0) {
        // 平台导出的表回带了业务审核结论：交给导入人裁决（结论不自动生效，两段式不破）
        setReviewFlow({ newBatchId: data.batchId, srcBatchId: data.srcBatchId || "", meta: data.reviewMeta, busy: false });
      } else {
        message.success(`导入完成：候选 ${data.routed.functions.total + data.routed.intents.total + data.routed.utterances.total} 条，驳回 ${data.rejected.length} 条`);
      }
      await refreshBatches(data.batchId);
      setActiveTab("review");
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setImporting(false);
    }
    return false;
  };

  const handleCreateBatch = async () => {
    try {
      const batch = await knowledgeIntakeApi.createBatch(createName.trim());
      message.success(`已创建空白批次，到「审核工作台」在线录入`);
      setCreateOpen(false);
      setCreateName("");
      await refreshBatches(batch.batchId);
      setActiveTab("review");
    } catch (error) {
      message.error((error as Error).message);
    }
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const { blob, fileName } = await knowledgeIntakeApi.exportExcel(activeBatchId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
      message.success(`已导出「${fileName}」，可交业务人员离线查看审核`);
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setExporting(false);
    }
  };

  // 采纳导出表回带的业务审核结论（mergeBack = 合并回导出来源批次并删除临时批次）
  const adoptReview = async (mergeBack: boolean) => {
    if (!reviewFlow) return;
    setReviewFlow({ ...reviewFlow, busy: true });
    try {
      const applied = await knowledgeIntakeApi.applyReview(reviewFlow.newBatchId);
      let mergeNote = "";
      if (mergeBack && reviewFlow.srcBatchId) {
        const merged = await knowledgeIntakeApi.mergeBatch(reviewFlow.srcBatchId, reviewFlow.newBatchId);
        const kinds = ["functions", "intents", "utterances"] as const;
        const updated = kinds.reduce((n, k) => n + (merged.updated[k] || 0), 0);
        const added = kinds.reduce((n, k) => n + (merged.added[k] || 0), 0);
        mergeNote = `；合并回原批次：更新 ${updated} 条、新增 ${added} 条，临时批次已删除`;
      }
      message.success(`已采纳业务审核结论：确认 ${applied.applied.approved} 条、驳回 ${applied.applied.rejected} 条${mergeNote}`);
      setReviewFlow(null);
      const targetId = mergeBack && reviewFlow.srcBatchId ? reviewFlow.srcBatchId : reviewFlow.newBatchId;
      await refreshBatches(targetId);
      setActiveTab("review");
    } catch (error) {
      message.error((error as Error).message);
      setReviewFlow((prev) => (prev ? { ...prev, busy: false } : prev));
    }
  };

  const handleDeleteBatch = async () => {
    try {
      await knowledgeIntakeApi.deleteBatch(activeBatchId);
      message.success("批次已删除");
      setImportResult(null);
      await refreshBatches();
    } catch (error) {
      message.error((error as Error).message);
    }
  };

  const handleRollback = async () => {
    setRollingBack(true);
    try {
      const data = await knowledgeIntakeApi.rollback(activeBatchId, applyAsset);
      if (data.rolledBack && data.saved) {
        const keptNote = data.kept.length ? `；${data.kept.length} 个节点因仍被其他边引用而保留` : "";
        message.success(`已回滚本次入图：删除说法 ${data.removed.utterances}、边 ${data.removed.edges}、意图 ${data.removed.intents}、聚合 ${data.removed.aggregates}${keptNote}`);
        setApplyResult(null);
        await refreshBatches();
      } else {
        message.error("回滚后校验未通过，未保存，请联系管理员查看服务端日志");
      }
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setRollingBack(false);
    }
  };

  // 从图谱资产加载草稿 Excel（下载到本地后可导入到批次）
  const handleDownloadDraftExcel = async (assetId: string) => {
    try {
      const { blob, fileName } = await downloadDraftExcel(assetId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
      message.success("已下载图谱草稿 Excel，可导入到当前批次");
    } catch (error) {
      message.error((error as Error).message);
    }
  };

  // ── 审核（两段式：approved 只能经 review 端点人工产生） ──

  const withReview = async (action: "approve" | "reject" | "reset", note = "", ids?: string[]) => {
    const target = ids && ids.length ? ids : [];
    if (!target.length) {
      message.warning("请先勾选条目");
      return;
    }
    try {
      const data = await knowledgeIntakeApi.review(activeBatchId, action, target, note);
      const verb = action === "approve" ? "已确认" : action === "reject" ? "已驳回" : "已撤回重审";
      message.success(`${verb} ${data.updated} 条`);
      setRejectOpen(false);
      setRejectNote("");
      setRejectIds([]);
      bumpVersion();
      await refreshBatches();
    } catch (error) {
      message.error((error as Error).message);
    }
  };

  const startReject = (ids: React.Key[] | string[]) => {
    setRejectIds(ids.map(String));
    setRejectNote("");
    setRejectOpen(true);
  };

  // 验收问题/AI 建议定位：unit（功能全路径或意图 ref）由工作台视图无关解析，
  // 找不到（挂接缺口/已删除）时组件内提示——缺口行本来就置顶在队列上
  const focusIssue = (unit: string) => {
    setActiveTab("review");
    setFocusUnit({ unit, nonce: Date.now() });
  };

  // 修订变更定位：按 rowId 反查行 → 意图/功能落 ref/path，说法落所属意图（绿「修订」chip 引导）
  const locateRevisionChange = async (change: RevisionChange) => {
    try {
      const { items } = await knowledgeIntakeApi.getItems(activeBatchId, { kind: change.rowType });
      const row = items.find((item) => item.rowId === change.rowId);
      if (!row) {
        message.warning("该行已不存在，可在修订审阅中直接放弃该变更");
        return;
      }
      const unit = change.rowType === "utterances" ? row.intentRef || "" : row.ref || row.path || "";
      if (!unit) return;
      setUnifiedOpen(false);
      focusIssue(unit);
    } catch (error) {
      message.error((error as Error).message);
    }
  };

  // AI 建议定位：gaps 指向父功能路径，其余指向意图 ref
  const locateAssist = (item: AssistItem) => {
    const unit = assistLocateUnit(item);
    if (!unit) return;
    setUnifiedOpen(false);
    focusIssue(unit);
  };

  // 验收报告「去补全」：对单个意图跑 LLM 扩展问补全，完成后刷新报告与工作台
  // 意图按 ref 从 items API 找（视图无关）
  const expandSingleIntent = async (unit: string) => {
    try {
      const { items } = await knowledgeIntakeApi.getItems(activeBatchId, { kind: "intents" });
      const row = items.find((item) => item.ref === unit);
      if (!row) {
        message.warning("该意图不在本批次");
        return;
      }
      const data = await knowledgeIntakeApi.expandUtterances(activeBatchId, [row.rowId], 5);
      if (data.added > 0) {
        message.success(`已为该意图生成 ${data.added} 条扩展问（待确认），请在修订审阅中逐条确认`);
        bumpVersion();
        await fetchAcceptance();
        if (data.revision?.revId) handleRevisionCreated(data.revision.revId);
      } else {
        message.info("没有新增扩展问（可能已全部重复）——也可到审核工作台手工补充标问");
      }
      if (data.errors.length) {
        message.warning(`补全失败：${data.errors[0]?.message || data.errors[0]?.status}`);
      }
    } catch (error) {
      message.error((error as Error).message);
    }
  };

  // ── AI 骨架助手（建议由人裁决，两段式不破） ──

  const openAssist = async () => {
    if (!activeBatchId) return;
    setUnifiedRevId(null);
    setUnifiedOpen(true);
    if (!assistData || assistData.batchId !== activeBatchId) {
      try {
        setAssistData(await knowledgeIntakeApi.getSkeletonAssist(activeBatchId));
      } catch (error) {
        message.error((error as Error).message);
      }
    }
  };

  /** 节点级字段内容审核（Word 式逐字段审核）：传入行 ID、行类型、分组 key，AI 审核该分组各字段内容质量 */
  const assistForRow = async (rowId: string, rowType: IntakeRowType, groupKey: string) => {
    if (!activeBatchId) return;
    setAssistRunning(true);
    setNodeReviewData(null);
    try {
      const result = await knowledgeIntakeApi.runNodeReview(activeBatchId, rowId, rowType, groupKey);
      setNodeReviewData(result);
      bumpVersion();
      const suggested = result.items.filter((it) => it.status === "suggested");
      if (suggested.length > 0) {
        message.info(`AI 审核完成：共 ${suggested.length} 条建议，已在字段旁标注`);
      } else {
        message.info("AI 审核完成：未发现需要修改的问题");
      }
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setAssistRunning(false);
    }
  };

  const runAssist = async () => {
    setAssistRunning(true);
    try {
      const result = await knowledgeIntakeApi.runSkeletonAssist(activeBatchId);
      message.success(`AI 骨架评审完成：共 ${result.total} 条建议（查漏 ${result.gaps.total}、疑似重复 ${result.duplicates.total}、命名 ${result.naming.total}、歧义 ${result.ambiguities.total}），等待人工裁决`);
      setAssistData(await knowledgeIntakeApi.getSkeletonAssist(activeBatchId));
      bumpVersion();
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setAssistRunning(false);
    }
  };

  const decideAssist = async (action: "accept" | "dismiss", item: AssistItem) => {
    // node-review：采纳时把 newValue 写入字段并持久化
    if (item.kind === "node-review") {
      if (action === "accept") {
        const newValue = item.payload.newValue;
        const field = item.payload.field;
        const rowId = nodeReviewData?.rowId;
        if (!newValue || !field || !rowId) {
          message.warning("该建议没有可直接采纳的内容，请手动编辑");
          setNodeReviewData((prev) => prev ? {
            ...prev,
            items: prev.items.map((it) =>
              it.id === item.id ? { ...it, status: "accepted" } : it
            ),
          } : prev);
          return;
        }
        try {
          const patch = { [field]: newValue } as IntakeRowInput;
          const err = await saveDetail(rowId, patch);
          if (err) {
            message.error(err);
            return;
          }
          setNodeReviewData((prev) => prev ? {
            ...prev,
            items: prev.items.map((it) =>
              it.id === item.id ? { ...it, status: "accepted" } : it
            ),
          } : prev);
          message.success(`已采纳，${item.payload.fieldLabel || field} 已更新`);
        } catch (error) {
          message.error((error as Error).message);
        }
      } else {
        setNodeReviewData((prev) => prev ? {
          ...prev,
          items: prev.items.map((it) =>
            it.id === item.id ? { ...it, status: "dismissed" } : it
          ),
        } : prev);
        message.success("已忽略该建议");
      }
      return;
    }

    setAssistDeciding((prev) => [...prev, item.id]);
    try {
      const result = await knowledgeIntakeApi.decideSkeletonAssist(activeBatchId, action, [item.id]);
      const outcome = result.results[0];
      if (action === "accept" && outcome && outcome.applied === false) {
        message.warning(`未采纳：${outcome.reason || "不适用"}`);
      } else {
        message.success(action === "accept" ? "已采纳，变更进入骨架待人工确认" : "已忽略该建议");
      }
      setAssistData(await knowledgeIntakeApi.getSkeletonAssist(activeBatchId));
      bumpVersion();
      await refreshBatches();
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setAssistDeciding((prev) => prev.filter((id) => id !== item.id));
    }
  };

  // ── 在线编辑 / 在线新建（分组编辑与新建抽屉共用保存契约：返回空串=成功） ──

  // 保存编辑：返回空串表示成功，否则返回错误信息给编辑处内联展示
  const saveDetail = async (rowId: string, patch: IntakeRowInput): Promise<string> => {
    setSaving(true);
    try {
      const res = await knowledgeIntakeApi.updateRow(activeBatchId, rowId, patch);
      message.success(res.demoted ? "已保存；该行此前的人工确认已失效，退回「待确认」" : "已保存");
      const moved = Object.entries(res.cascaded || {}).filter(([, n]) => n > 0);
      if (moved.length) {
        message.info(`子级已跟随迁移：${moved.map(([k, n]) => `${ROW_TYPE_LABEL[k as IntakeRowType]} ${n}`).join("、")}`);
      }
      bumpVersion();
      await refreshBatches();
      return "";
    } catch (error) {
      return (error as Error).message;
    } finally {
      setSaving(false);
    }
  };

  const startCreate = (rowType: IntakeRowType, parent?: { path?: string; ref?: string; name?: string }) => {
    // 业务状态默认值是字符串口径（启用/生效/候选），与 IntakeItem 的平台状态字段类型不同，这里仅作表单初值
    const draft = {
      rowId: "__new__",
      rowType,
      ...CREATE_DRAFT_DEFAULTS[rowType],
    } as unknown as IntakeItem;
    if (parent && rowType === "functions") draft.path = `${parent.path}/`;
    if (parent && rowType === "intents") draft.funcPath = parent.path || "";
    if (parent && rowType === "utterances") draft.intentRef = parent.ref || "";
    setCreateRowType(rowType);
    setCreateDraft(draft);
    setCreateDrawerOpen(true);
  };

  const handleCreateSave = async (_rowId: string, patch: IntakeRowInput): Promise<string> => {
    if (!createRowType) return "没有要新建的行类型";
    try {
      const res = await knowledgeIntakeApi.createRow(activeBatchId, createRowType, patch);
      message.success(`${ROW_TYPE_LABEL[createRowType]}已创建，进入「待确认」`);
      if (res.warnings.length) message.warning(res.warnings.join("；"));
      setCreateDrawerOpen(false);
      setCreateDraft(null);
      setCreateRowType(null);
      bumpVersion();
      await refreshBatches();
      return "";
    } catch (error) {
      return (error as Error).message;
    }
  };

  const startRenameDomain = () => {
    setDomainValue(activeBatch?.domain || "");
    setDomainOpen(true);
  };

  const handleDomainSave = async () => {
    const domain = domainValue.trim();
    if (!domain) {
      message.warning("领域名不能为空");
      return;
    }
    setDomainSaving(true);
    try {
      await knowledgeIntakeApi.updateBatch(activeBatchId, { domain });
      message.success(`领域已更新为「${domain}」`);
      setDomainOpen(false);
      await refreshBatches();
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setDomainSaving(false);
    }
  };

  const handleDeleteRow = (row: SheetRow) => {
    let cascade = 0;
    const walk = (r: SheetRow) => r.children.forEach((c) => { cascade += 1; walk(c); });
    walk(row);
    Modal.confirm({
      title: `删除「${rowTitle(row)}」？`,
      content: cascade
        ? `将级联删除其下 ${cascade} 条子级（意图/说法）；已入图内容不受影响`
        : "该条目将从批次中删除；已入图内容不受影响",
      okText: "删除",
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          const res = await knowledgeIntakeApi.deleteRow(activeBatchId, row.rowId);
          const total = res.deleted.functions + res.deleted.intents + res.deleted.utterances;
          message.success(`已删除 ${total} 条（含级联子级）`);
          bumpVersion();
          await refreshBatches();
        } catch (error) {
          message.error((error as Error).message);
        }
      },
    });
  };

  // ── 应用到图谱（先预览变更，再确认入图；目标条目在预览时锁定） ──

  const startPreview = async (itemIds: string[]) => {
    setPreviewLoading(true);
    setApplyResult(null);
    try {
      const data = await knowledgeIntakeApi.previewApply(activeBatchId, applyAsset, itemIds);
      setPreviewIds(itemIds);
      setPreviewResult(data);
      setPreviewOpen(true);
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setPreviewLoading(false);
    }
  };

  const confirmApply = async () => {
    setApplying(true);
    try {
      const data = await knowledgeIntakeApi.apply(activeBatchId, applyAsset, previewIds);
      setApplyResult(data);
      setPreviewOpen(false);
      if (data.applied && data.saved) {
        message.success("已写入图谱草稿，可到 AI 辅助建图页复核发布");
        await refreshBatches();
      } else {
        message.error("校验未通过，未写入草稿，请查看详情");
      }
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setApplying(false);
    }
  };

  const fetchAcceptance = useCallback(async () => {
    if (!activeBatchId) return;
    setAcceptanceLoading(true);
    try {
      setAcceptanceData(await knowledgeIntakeApi.getAcceptance(activeBatchId));
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setAcceptanceLoading(false);
    }
  }, [activeBatchId]);

  const openAcceptance = () => {
    setUnifiedRevId(null);
    setUnifiedOpen(true);
    fetchAcceptance();
  };

  // 审核动作/编辑/采纳建议后静默刷新验收报告（右栏问题与页头就绪语句保持新鲜）
  useEffect(() => {
    if (!activeBatchId) return;
    knowledgeIntakeApi
      .getAcceptance(activeBatchId)
      .then(setAcceptanceData)
      .catch(() => undefined);
  }, [activeBatchId, dataVersion]);

  // ── 汇总与就绪判定 ──

  const totals = useMemo(() => {
    const acc = { approved: 0, pending: 0, rejected: 0, total: 0 };
    (["functions", "intents", "utterances"] as IntakeRowType[]).forEach((k) => {
      acc.approved += activeBatch?.counts[k]?.approved ?? 0;
      acc.pending += activeBatch?.counts[k]?.pending ?? 0;
      acc.rejected += activeBatch?.counts[k]?.rejected ?? 0;
    });
    acc.total = acc.approved + acc.pending + acc.rejected;
    return acc;
  }, [activeBatch]);

  const readiness = useMemo(() => {
    if (!activeBatch || activeBatch.broken) return { ok: false, label: "批次不可用" };
    if (totals.total === 0) return { ok: false, label: "暂无条目，先导入或在线录入" };
    if (blockedCount > 0) return { ok: false, label: `${blockedCount} 个阻断项，暂不可应用` };
    if (totals.approved === 0) return { ok: false, label: "还没有已确认条目" };
    if (acceptanceData && !acceptanceData.ready) return { ok: false, label: "质量分未达标，暂不可应用" };
    return { ok: true, label: "已满足应用条件" };
  }, [activeBatch, totals, blockedCount, acceptanceData]);

  const batchMeta = activeBatch
    ? `${activeBatch.fileName} · 导入人 ${activeBatch.importedBy || "—"} · ${activeBatch.importedAt?.slice(0, 16).replace("T", " ") || ""}`
    : "";

  const previewGroups = useMemo(() => {
    if (!previewResult) return [];
    const by = (kind: string) => previewResult.changes.filter((c) => c.kind === kind);
    const renderItem = (list: PreviewApplyResult["changes"], emptyText: string) =>
      list.length ? (
        list.map((c, i) => (
          <div key={i} style={{ padding: "2px 0" }}>
            {c.action === "reuse" ? <Tag color="default">复用</Tag> : <Tag color="green">新建</Tag>}
            <Text strong={c.action === "create"}>{c.name}</Text>
            {c.detail && <Text type="secondary">　→ {c.detail}</Text>}
          </div>
        ))
      ) : (
        <Text type="secondary">{emptyText}</Text>
      );
    return [
      {
        key: "aggregates",
        label: `业务功能聚合（新建 ${previewResult.stats.aggregatesCreated} / 复用 ${previewResult.stats.aggregatesReused}）`,
        children: renderItem(by("aggregate"), "本次不新建也不复用聚合节点"),
      },
      {
        key: "intents",
        label: `意图（新建 ${previewResult.stats.intentsCreated} / 复用 ${previewResult.stats.intentsReused}）`,
        children: renderItem(by("intent"), "本次不新建也不复用意图"),
      },
      {
        key: "utterances",
        label: `合并说法（${previewResult.stats.utterancesAdded} 条）`,
        children: renderItem(by("utterance"), "本次没有合并新说法"),
      },
    ];
  }, [previewResult]);

  const rejectedColumns = [
    { title: "工作表", dataIndex: "sheet", key: "sheet", width: 140 },
    { title: "行号", dataIndex: "rowNumber", key: "rowNumber", width: 70 },
    { title: "错误", dataIndex: "errors", key: "errors", render: (errors: string[]) => errors.join("；") },
  ];

  return (
    <div className="kib-page">
      <header className="kih">
        <h1>知识导入与审核</h1>
        <div className="kih-divider" />
        <div className="kih-batch">
          <Select
            showSearch
            size="small"
            style={{ minWidth: 260 }}
            value={activeBatchId || undefined}
            placeholder="选择批次"
            loading={batchLoading}
            optionFilterProp="label"
            onChange={(v) => { setActiveBatchId(v); setImportResult(null); }}
            options={batches.map((b) => ({
              value: b.batchId,
              label: `${b.fileName} · ${b.importedAt?.slice(5, 16).replace("T", " ") || ""}`,
              disabled: b.broken,
            }))}
          />
          {batchMeta && (
            <Tooltip title={batchMeta}>
              <span className="kih-batch-meta">{batchMeta}</span>
            </Tooltip>
          )}
        </div>
        <div className="kih-progress">
          <span className="kih-progress-label">
            已确认 <Text strong style={{ color: "#15803d" }}>{totals.approved}</Text> / 共 {totals.total} 条
            {totals.rejected > 0 && <span style={{ color: "#b0b8c4" }}>（驳回 {totals.rejected}）</span>}
          </span>
          <ProgressLine approved={totals.approved} total={totals.total} />
        </div>
        <div className={`kih-readiness ${readiness.ok ? "kih-readiness-ok" : "kih-readiness-no"}`}>
          <span aria-hidden>{readiness.ok ? "✓" : "⚠"}</span>
          <span>{readiness.label}</span>
        </div>
        <div className="kih-spacer" />
        <div className="kih-actions">
          <Button icon={<FileAddOutlined />} onClick={() => setCreateOpen(true)}>新建空白批次</Button>
          <Tooltip title="两种填法二选一：三张分表（1-业务功能分类 / 2-意图清单 / 3-说法库），或「一体化填写」单表（一行一条说法，功能/意图属性就近向下填充）。日常增量建议直接在审核工作台在线录入，不必回 Excel。">
            <Upload
              name="file"
              accept=".xlsx"
              multiple={false}
              showUploadList={false}
              beforeUpload={(file) => handleUpload(file)}
            >
              <Button type="primary" icon={<CloudUploadOutlined />} loading={importing}>Excel 批量导入</Button>
            </Upload>
          </Tooltip>
          <Tooltip title="导出一体化填写大表（一行一条说法 + 平台确认状态/审核意见列），供业务人员离线查看审核；改完可原样导入回来">
            <Button icon={<DownloadOutlined />} loading={exporting} disabled={!activeBatchId} onClick={handleExport}>导出 Excel</Button>
          </Tooltip>
          <Tooltip title="输一句用户可能说的话，看会命中批次内哪些意图（按意图声明的要素语义判定）；也可维护回归用例集">
            <Button icon={<ThunderboltOutlined />} disabled={!activeBatchId} onClick={() => setRecallOpen(true)}>召回试测</Button>
          </Tooltip>
          <Button
            icon={<FileDoneOutlined />}
            onClick={openAcceptance}
          >
            <Badge count={(acceptanceData && !acceptanceData.ready ? 1 : 0) + assistOpenCount} size="small" offset={[6, -2]}>
              全局AI审核
            </Badge>
          </Button>
          <Dropdown
            trigger={["click"]}
            menu={{
              items: [
                { key: "builder", icon: <ApartmentOutlined />, label: "前往 AI 辅助建图" },
                { key: "auto-build", icon: <ApartmentOutlined />, label: "前往自动建图（从对话/文档生成）" },
                { type: "divider" },
                {
                  key: "draft-excel",
                  icon: <DownloadOutlined />,
                  label: "从图谱资产加载 Excel",
                  children: assetOptions.map((a) => ({
                    key: `draft-excel-${a.value}`,
                    label: a.label,
                    onClick: () => handleDownloadDraftExcel(a.value),
                  })),
                },
                { type: "divider" },
                { key: "rollback", icon: <RollbackOutlined />, danger: activeBatch?.hasJournal, disabled: !activeBatch?.hasJournal, label: "回滚入图" },
                { key: "delete", icon: <DeleteOutlined />, danger: true, disabled: !activeBatchId, label: "删除批次" },
              ],
              onClick: ({ key }) => {
                if (key === "builder") navigate("/knowledge/graph/builder");
                else if (key === "auto-build") navigate("/knowledge/graph/auto-build");
                else if (key === "rollback") Modal.confirm({
                  title: "回滚该批次上次入图的数据？",
                  content: "将撤销该批次最近一次「应用到图谱」新增的说法、边、意图与聚合（被其他数据引用的节点会保留并提示）",
                  okText: "回滚",
                  okButtonProps: { danger: true },
                  onOk: () => handleRollback(),
                });
                else if (key === "delete") Modal.confirm({
                  title: "删除该批次及其候选条目？",
                  content: "已入图内容不受影响",
                  okText: "删除",
                  okButtonProps: { danger: true },
                  onOk: () => handleDeleteBatch(),
                });
              },
            }}
          >
            <Button aria-label="更多批次操作">更多</Button>
          </Dropdown>
        </div>
      </header>

      {activeBatch?.broken && (
        <div className="kih-sub">
          <Alert type="warning" showIcon message={activeBatch.message || "该批次数据已损坏，不能审核与应用"} />
        </div>
      )}

      {importResult && importResult.batchId === activeBatchId && !activeBatch?.broken && (
        <div className="kih-sub">
          <Space size={32} wrap>
            {(["functions", "intents", "utterances"] as IntakeRowType[]).map((kind) => (
              <Statistic
                key={kind}
                title={ROW_TYPE_LABEL[kind]}
                value={importResult.routed[kind]?.total ?? 0}
                suffix={importResult.routed[kind]?.rejected ? `（驳回 ${importResult.routed[kind].rejected}）` : ""}
              />
            ))}
          </Space>
          {importResult.warnings.length > 0 && (
            <Collapse
              style={{ marginTop: 8 }}
              items={[{
                key: "warnings",
                label: <Text type="warning">复核提醒（{importResult.warnings.length} 条，如歧义说法、缺标问）</Text>,
                children: (
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {importResult.warnings.map((w, i) => <li key={i}>{w.message}</li>)}
                  </ul>
                ),
              }]}
            />
          )}
          {importResult.rejected.length > 0 && (
            <Collapse
              style={{ marginTop: 8 }}
              items={[{
                key: "rejected",
                label: <Text type="danger">错误行明细（{importResult.rejected.length} 条未入库）</Text>,
                children: (
                  <Table
                    size="small"
                    rowKey={(r) => `${r.sheet}-${r.rowNumber}`}
                    columns={rejectedColumns}
                    dataSource={importResult.rejected}
                    pagination={false}
                  />
                ),
              }]}
            />
          )}
        </div>
      )}

      {!batches.length && !batchLoading ? (
        <div className="kwd-empty-state" style={{ flex: 1 }}>
          <div style={{ fontSize: 36, color: "#c9d2dc" }}>📥</div>
          <div style={{ fontSize: 16, color: "#4b5563", fontWeight: 500 }}>还没有批次，先创建一个或导入 Excel</div>
          <Space>
            <Button icon={<FileAddOutlined />} onClick={() => setCreateOpen(true)}>创建空白批次</Button>
            <Upload
              name="file"
              accept=".xlsx"
              multiple={false}
              showUploadList={false}
              beforeUpload={(file) => handleUpload(file)}
            >
              <Button type="primary" icon={<CloudUploadOutlined />} loading={importing}>Excel 批量导入</Button>
            </Upload>
          </Space>
        </div>
      ) : (
        <div className="kwb-host">
          {activeBatchId && (
            <ReviewWorkbench
              batchId={activeBatchId}
              dataVersion={dataVersion}
              saving={saving}
              assistOpenCount={assistOpenCount}
              assistItems={assistItemsFlat}
              nodeReviewItems={nodeReviewData?.items || []}
              assistBusy={assistDeciding.length > 0}
              assistRunning={assistRunning}
              acceptance={acceptanceData}
              focusUnit={focusUnit}
              onFocusHandled={() => setFocusUnit(null)}
              onSummaryRefresh={() => refreshBatches(activeBatchId)}
              onSave={saveDetail}
              onReviewRow={(action, note, ids) => withReview(action, note, ids)}
              onReject={startReject}
              onDecideAssist={decideAssist}
              onAssistForRow={assistForRow}
              onCreateRow={startCreate}
              onExpandIntent={expandSingleIntent}
              onBlockingChange={setBlockedCount}
              domain={activeBatch?.domain || ""}
              onRenameDomain={startRenameDomain}
              onDeleteRow={handleDeleteRow}
              onRevisionCreated={handleRevisionCreated}
              pendingRevisionRowIds={pendingRevisionRowIds}
              revisionOpenCount={revisionOpenCount}
            />
          )}
        </div>
      )}

      <div className="kbn">
        <div style={{ fontSize: 32 }}>🖥️</div>
        <div style={{ fontSize: 16, fontWeight: 500, color: "#4b5563" }}>本工作台为桌面端设计</div>
        <div>知识导入与审核需要在 ≥1024px 宽度的桌面浏览器中使用，请调大窗口后访问。</div>
      </div>

      <Modal
        title="新建空白批次"
        open={createOpen}
        onOk={handleCreateBatch}
        onCancel={() => setCreateOpen(false)}
        okText="创建"
        destroyOnHidden
      >
        <Space direction="vertical" style={{ width: "100%" }} size={8}>
          <Input
            placeholder="批次名称（留空则记为「在线新建」）"
            value={createName}
            maxLength={50}
            onChange={(e) => setCreateName(e.target.value)}
            onPressEnter={handleCreateBatch}
          />
          <Text type="secondary" style={{ fontSize: 12 }}>
            创建后到审核工作台在线录入功能 / 意图 / 说法；Excel 适合首次批量灌入，两种填法二选一。
          </Text>
        </Space>
      </Modal>

      <Modal
        title="重命名领域"
        open={domainOpen}
        onOk={() => void handleDomainSave()}
        confirmLoading={domainSaving}
        onCancel={() => setDomainOpen(false)}
        okText="保存"
        destroyOnHidden
      >
        <Space direction="vertical" style={{ width: "100%" }} size={8}>
          <Input
            placeholder="如：手机银行"
            value={domainValue}
            maxLength={50}
            onChange={(e) => setDomainValue(e.target.value)}
            onPressEnter={() => void handleDomainSave()}
          />
          <Text type="secondary" style={{ fontSize: 12 }}>
            领域是这批知识在审核队列里的 L0 根节点（按图谱领域命名，如「手机银行」）；只改名不改数据，功能/意图/说法的挂接路径不受影响。
          </Text>
        </Space>
      </Modal>

      <Modal
        title="检测到业务审核结论"
        open={!!reviewFlow}
        onCancel={() => setReviewFlow(null)}
        footer={null}
        width={560}
      >
        {reviewFlow && (() => {
          const srcExists = !!reviewFlow.srcBatchId && batches.some((b) => b.batchId === reviewFlow.srcBatchId);
          return (
            <Space direction="vertical" style={{ width: "100%" }} size={12}>
              <Text>
                导入表中带 {reviewFlow.meta.marked} 条业务审核结论（已确认 {reviewFlow.meta.approved}、已驳回 {reviewFlow.meta.rejected}）。
                {srcExists ? "该表导出自本平台批次，可采纳后合并回原批次。" : "未找到导出来源批次（可能已删除），可仅采纳结论保留为新批次。"}
              </Text>
              <Alert
                type="info"
                showIcon
                message="采纳即平台人工确认动作，结论会作为审核记录落库；未标记的功能/意图按「直接下级全部已确认才确认」保守推导，其余留待人工。"
              />
              <Space wrap>
                {srcExists && (
                  <Button type="primary" loading={reviewFlow.busy} onClick={() => void adoptReview(true)}>
                    采纳结论并合并回原批次
                  </Button>
                )}
                <Button loading={reviewFlow.busy} onClick={() => void adoptReview(false)}>
                  仅采纳结论（保留为新批次）
                </Button>
                <Button disabled={reviewFlow.busy} onClick={() => setReviewFlow(null)}>
                  暂不采纳
                </Button>
              </Space>
            </Space>
          );
        })()}
      </Modal>

      <Modal
        title="驳回所选条目"
        open={rejectOpen}
        onOk={() => withReview("reject", rejectNote.trim(), rejectIds)}
        onCancel={() => setRejectOpen(false)}
        okText="驳回"
        okButtonProps={{ danger: true, disabled: !rejectNote.trim() }}
      >
        <Space direction="vertical" style={{ width: "100%" }} size={8}>
          <Alert type="warning" showIcon message={`将驳回 ${rejectIds.length} 条（含其子级），驳回必须填写审核意见`} />
          <Input.TextArea
            rows={3}
            maxLength={200}
            showCount
            placeholder="驳回原因（必填），会显示给录入人"
            value={rejectNote}
            onChange={(e) => setRejectNote(e.target.value)}
          />
        </Space>
      </Modal>

      <Modal
        title="应用前预览：本次将如何变更图谱"
        open={previewOpen}
        onCancel={() => setPreviewOpen(false)}
        width={720}
        footer={[
          <Button key="cancel" onClick={() => setPreviewOpen(false)}>取消</Button>,
          <Button
            key="ok"
            type="primary"
            icon={<ExportOutlined />}
            loading={applying}
            disabled={!previewResult?.valid}
            onClick={confirmApply}
          >
            确认入图
          </Button>,
        ]}
      >
        {previewResult && (
          <Space direction="vertical" size={12} style={{ width: "100%" }}>
            {!previewResult.valid && (
              <Alert
                type="error"
                showIcon
                message="图谱校验未通过，不能入图"
                description={(previewResult.validation?.asset?.errors || []).slice(0, 5).map((e, i) => (
                  <div key={i}>· {e.message}</div>
                ))}
              />
            )}
            <Collapse defaultActiveKey={["intents"]} items={previewGroups} />
            {previewResult.skipped.length > 0 && (
              <Text type="secondary">跳过 {previewResult.skipped.length} 条：{previewResult.skipped[0]?.reason} 等</Text>
            )}
          </Space>
        )}
      </Modal>

      <UnifiedReviewPanel
        open={unifiedOpen}
        onClose={() => { setUnifiedOpen(false); setUnifiedRevId(null); }}
        batchId={activeBatchId || null}
        revId={unifiedRevId}
        acceptanceData={acceptanceData}
        acceptanceLoading={acceptanceLoading}
        approvedCount={totals.approved}
        blockedCount={blockedCount}
        applyAsset={applyAsset}
        assetOptions={assetOptions}
        onApplyAssetChange={setApplyAsset}
        onPreviewApply={startPreview}
        previewLoading={previewLoading}
        applyResult={applyResult}
        onGoBuilder={() => navigate("/knowledge/graph/builder")}
        onFixIssue={focusIssue}
        onExpandIssue={expandSingleIntent}
        assistData={assistData}
        assistRunning={assistRunning}
        assistDeciding={assistDeciding}
        onRunAssist={runAssist}
        onDecideAssist={decideAssist}
        onLocateAssist={locateAssist}
        onRevisionResolved={handleRevisionResolved}
        onLocateRevision={locateRevisionChange}
      />

      <Drawer
        title={createRowType ? `新建${ROW_TYPE_LABEL[createRowType]}` : "在线新建"}
        width={560}
        open={createDrawerOpen}
        onClose={() => { setCreateDrawerOpen(false); setCreateDraft(null); setCreateRowType(null); }}
        destroyOnHidden
      >
        {createDraft && <DetailForm form={createForm} item={createDraft} saving={saving} onSave={handleCreateSave} />}
      </Drawer>

      <RecallTestPanel batchId={activeBatchId} open={recallOpen} onClose={() => setRecallOpen(false)} />
    </div>
  );
}

/** 页头细进度条：已确认占比（绿），驳回占比（红尾迹） */
function ProgressLine({ approved, total }: { approved: number; total: number }) {
  const pct = total ? Math.round((approved / total) * 100) : 0;
  return (
    <div style={{ height: 4, borderRadius: 2, background: "#eef0f3", overflow: "hidden" }} aria-hidden>
      <div style={{ width: `${pct}%`, height: "100%", background: "#22c55e", transition: "width .3s ease" }} />
    </div>
  );
}
