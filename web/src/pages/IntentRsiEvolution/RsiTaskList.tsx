/**
 * RSI 任务列表页：进入工具先选任务，点击卡片进入详情；支持新建任务（评审阶段 C）。
 * 数据来源：GET /api/intent-rsi/tasks（只读聚合）+ POST /tasks/create + POST /tasks/switch。
 * 设计沿用「墨 · 线 · 蓝」纪律：卡片式任务入口 + 状态徽标 + 关键读数，与 rsiDesign 同一套变量。
 */
import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Card, Dropdown, Form, Input, Modal, Radio, Select, Space, Spin, Switch, Tag, Typography, Upload, message } from "antd";
import {
  ArrowRightOutlined, BankOutlined, EnvironmentOutlined, ExperimentOutlined,
  CheckCircleOutlined, ClockCircleOutlined, LoadingOutlined, PlusOutlined, PlayCircleOutlined, UploadOutlined,
} from "@ant-design/icons";
import { rsiRequest } from "./rsiShared";
import { CreateTaskModal } from "./RsiCreateTaskModal";
import { createTaskPayload } from "./rsiTaskContext";
import { COLOR, GRADIENT, SHADOW, TYPE } from "./rsiDesign";

export interface RsiTaskSummary {
  id: string;
  name: string;
  kind: "evolvable" | "readonly";
  description: string;
  targetGraph: string | null;
  currentVersion: string | null;
  caseCount: number;
  testCount: number;
  baselineStrict: number | null;
  baselineRelaxed: number | null;
  baselineCurrent: boolean;
  bestStrict: number | null;
  candidates: { total: number; pendingReview: number };
  rounds: number;
  adoptedVersions: number;
  running: boolean;
  active: boolean;
  updatedAt: string | null;
  engineRev: { engineSha: string; protoRev: number; engineMode: string } | null;
  calibrationStatus?: string;
  status?: string; statusLabel?: string;
  archived?: boolean;
}

interface BasesInfoLight {
  snapshots: { id: string; label: string }[];
  manifestVersions?: { versionId: string; name: string; status: string | null; stage?: string | null; intentCount?: number | null; imported: boolean }[];
  /** 10-17 更名：这是图谱注册表（来源归属），不是引擎清单；engines 为兼容别名 */
  sourceGraphs?: { id: string; engine: string; label: string; sublabel: string | null; engineVersion?: string | null; intentCount?: number | null }[];
  engines?: { id: string; engine: string; label: string; sublabel: string | null }[];
  evalDatasets?: { datasetId: string; name: string; graph: string | null; graphVersionId?: string | null; caseCount: number; shapeCounts?: Record<string, number>; createdAt?: string | null }[];
}

const SHAPE_LABELS: Record<string, string> = {
  single_intent: '单意图', SINGLE_INTENT: '单意图',
  multi_intent: '多意图', MULTI_INTENT: '多意图',
  ambiguous_intent: '模糊', AMBIGUOUS: '模糊',
  negative_intent: '负例', NEGATIVE: '负例',
};

/** 题型分布摘要：{single_intent:12,multi_intent:3} → "单意图 12 · 多意图 3" */
function shapeSummary(shapeCounts?: Record<string, number>): string {
  if (!shapeCounts) return '';
  const parts = Object.entries(shapeCounts).filter(([, n]) => n > 0)
    .map(([shape, n]) => `${SHAPE_LABELS[shape] || shape} ${n}`);
  return parts.length ? parts.join(' · ') : '';
}

const KIND_META: Record<string, { icon: React.ReactNode; color: string; badge: string }> = {
  evolvable: { icon: <BankOutlined />, color: "#2a78d6", badge: "可进化" },
  readonly: { icon: <EnvironmentOutlined />, color: "#7a6ff0", badge: "只读记录" },
};

function StatusTag({ task }: { task: RsiTaskSummary }) {
  if (task.status && task.status !== 'running') return <Tag color={task.status === 'failed' || task.status === 'error' ? 'error' : task.status === 'awaiting_human' ? 'gold' : undefined}>{task.statusLabel || ({ stopped: '已停止', interrupted: '运行中断 · 可恢复', awaiting_human: '待采纳', completed: '已完成', error: '运行失败', failed: '运行失败', idle: '空闲' } as Record<string, string>)[task.status] || task.status}</Tag>;
  if (task.running) return <Tag color="processing" icon={<LoadingOutlined />} style={{ borderRadius: 6 }}>运行中</Tag>;
  if (task.kind === "readonly") {
    return task.calibrationStatus === "done"
      ? <Tag color="green" icon={<CheckCircleOutlined />} style={{ borderRadius: 6 }}>校准完成</Tag>
      : <Tag style={{ borderRadius: 6 }}><ClockCircleOutlined /> 空闲</Tag>;
  }
  if (task.candidates.pendingReview > 0) {
    return <Tag color="gold" icon={<ClockCircleOutlined />} style={{ borderRadius: 6 }}>{task.candidates.pendingReview} 个方案待审阅</Tag>;
  }
  return <Tag color="default" style={{ borderRadius: 6 }}><ClockCircleOutlined /> 空闲</Tag>;
}

/** 任务行：列表形式（用户反馈卡片太占空间），一行一任务：名称+徽标 / 关键读数 / 底图版本 / 操作 */
function TaskRow({ task, onOpen, onContinue, onChanged }: { task: RsiTaskSummary; onOpen: (id: string) => void; onContinue: (id: string) => void; onChanged:()=>void }) {
  const meta = KIND_META[task.kind] || KIND_META.evolvable;
  return (
    <div
      role="group"
      aria-label={`${task.name}，${task.running ? '运行中' : task.statusLabel || task.status || '空闲'}`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 18,
        padding: "14px 20px",
        borderRadius: 10,
        border: `1px solid ${task.active ? meta.color : COLOR.border}`,
        boxShadow: task.active ? `0 0 0 1px ${meta.color}` : "none",
        background: "#fff",
        cursor: "default",
        transition: "box-shadow .15s",
        flexWrap: "wrap",
      }}
    >
      {/* 名称 + 徽标 */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 260, flex: "2 1 260px" }}>
        <span style={{
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          width: 30, height: 30, borderRadius: 8, background: `${meta.color}14`, color: meta.color, fontSize: 15, flexShrink: 0,
        }}>{meta.icon}</span>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <Typography.Text strong style={{ fontSize: 14.5, fontWeight: 620, color: COLOR.textPrimary }}>{task.name}</Typography.Text>
            
            {task.candidates.pendingReview > 0 && <Tag color="gold" style={{ borderRadius: 6, marginRight: 0 }}>{task.candidates.pendingReview} 待审阅</Tag>}
          </div>
          <Typography.Text type="secondary" style={{ fontSize: TYPE.micro, display: "block", maxWidth: 420, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {task.description}
          </Typography.Text>
        </div>
      </div>
      {/* 关键读数（横排紧凑） */}
      <div style={{ display: "flex", gap: 26, flex: "1 1 300px", justifyContent: "flex-start" }}>
        <div style={{ minWidth: 76 }}>
          <div style={{ fontSize: 17, fontWeight: 650, color: COLOR.textPrimary, fontVariantNumeric: "tabular-nums", lineHeight: 1.25 }}>
            {task.bestStrict != null ? `${task.bestStrict}%` : "—"}
          </div>
          <Typography.Text type="secondary" style={{ fontSize: TYPE.micro }}>
            {task.kind === "evolvable" ? (task.baselineCurrent ? "当前成绩" : "待重新评测") : "最新正确率"}
          </Typography.Text>
        </div>
        <div style={{ minWidth: 64 }}>
          <div style={{ fontSize: 17, fontWeight: 650, color: COLOR.textPrimary, fontVariantNumeric: "tabular-nums", lineHeight: 1.25 }}>
            {task.caseCount}{false && <span style={{ fontSize: 11, color: COLOR.textSecondary, fontWeight: 400 }}> +{task.testCount}</span>}
          </div>
          <Typography.Text type="secondary" style={{ fontSize: TYPE.micro }}>题库</Typography.Text>
        </div>
        <div style={{ minWidth: 52 }}>
          <div style={{ fontSize: 17, fontWeight: 650, color: COLOR.textPrimary, fontVariantNumeric: "tabular-nums", lineHeight: 1.25 }}>
            {task.rounds}
          </div>
          <Typography.Text type="secondary" style={{ fontSize: TYPE.micro }}>
            {task.kind === "evolvable" ? "已完成代数" : "调参版本"}
          </Typography.Text>
        </div>
        <div style={{ minWidth: 52 }}>
          <div style={{ fontSize: 17, fontWeight: 650, color: COLOR.textPrimary, fontVariantNumeric: "tabular-nums", lineHeight: 1.25 }}>
            {task.kind === "evolvable" ? task.candidates.total : task.adoptedVersions}
          </div>
          <Typography.Text type="secondary" style={{ fontSize: TYPE.micro }}>
            {task.kind === "evolvable" ? "改进方案" : "已采纳"}
          </Typography.Text>
        </div>
      </div>
      {/* 底图版本 + 时间 */}
      <div style={{ minWidth: 190, flex: "0 1 190px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Tag style={{ borderRadius: 6, background: COLOR.bg, maxWidth: 170, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginRight: 0 }}>{task.targetGraph || "—"}</Tag>
        </div>
        <Typography.Text type="secondary" style={{ fontSize: TYPE.micro }}>
          {task.currentVersion ? `${task.currentVersion}` : "—"}{task.updatedAt ? ` · ${task.updatedAt.slice(5, 16).replace("T", " ")}` : ""}
        </Typography.Text>
      </div>
      {/* 状态 + 操作 */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: "auto", flexShrink: 0 }}>
        {task.archived && <Tag>已归档</Tag>}
        <StatusTag task={task} />
        <Button type="link" size="small" style={{ padding: 0 }} aria-label={`打开任务 ${task.name}`} onClick={e => { e.stopPropagation(); onOpen(task.id); }}>
          {task.running ? "查看进展" : "打开任务"} <ArrowRightOutlined />
        </Button>
        {task.kind==='evolvable'&&<Dropdown trigger={['click']} menu={{items:[{key:'rename',label:'重命名任务'},{key:'archive',label:task.archived?'恢复任务':'归档任务'}],onClick:({key})=>{
          if(key==='rename'){let name=task.name;Modal.confirm({title:'重命名任务',content:<Input aria-label="新的任务名称" defaultValue={task.name} maxLength={40} onChange={e=>{name=e.target.value;}}/>,okText:'保存',cancelText:'取消',onOk:async()=>{if(!name.trim()){message.error('请输入任务名称');throw new Error('名称为空');}await rsiRequest('/tasks/update',{name:name.trim()},task.id);onChanged();}});}
          else Modal.confirm({title:task.archived?'恢复此任务？':'归档此任务？',content:task.archived?'恢复后重新显示在任务列表。':'归档后从默认列表隐藏，题目、运行记录与成果全部保留，可随时恢复。',okText:task.archived?'恢复':'归档',cancelText:'取消',onOk:async()=>{await rsiRequest('/tasks/update',{archived:!task.archived},task.id);onChanged();}});
        }}}><Button size="small" aria-label={`管理任务 ${task.name}`}>管理</Button></Dropdown>}
      </div>
    </div>
  );
}

/** 新建任务弹窗：按评审 8.1「六个问题」分节——任务定义 → 迭代底图 → 评测题库 → 切分封存 → 来源归属。
 *  10-17 名称对齐：底图/数据集/来源归属三处图谱名统一用 manifest version_name + 意图数口径。 */
export function RsiTaskList({ onOpenTask }: { onOpenTask: (id: string) => void }) {
  const [tasks, setTasks] = useState<RsiTaskSummary[] | null>(null);
  const [error, setError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [snapshots, setSnapshots] = useState<{ id: string; label: string }[]>([]);
  const [manifestVersions, setManifestVersions] = useState<BasesInfoLight["manifestVersions"]>([]);
  const [sourceGraphs, setSourceGraphs] = useState<NonNullable<BasesInfoLight["sourceGraphs"]>>([]);
  const [evalDatasets, setEvalDatasets] = useState<BasesInfoLight["evalDatasets"]>([]);
  const [assetsLoading,setAssetsLoading]=useState(true),[assetsError,setAssetsError]=useState(''),[assetsReload,setAssetsReload]=useState(0);

  const refresh = useCallback(async () => {
    try {
      const r = await rsiRequest<{ tasks: RsiTaskSummary[] }>("/tasks");
      setTasks(r.tasks);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  // 底图/来源归属/评测集清单（新建任务配置用）：与自动建图、图谱管理、图谱评测同一套数据源。
  // 10-17 名称对齐：sourceGraphs 是图谱注册表（来源归属），不再冒名"引擎"。
  useEffect(() => {
    setAssetsLoading(true);setAssetsError('');
    rsiRequest<BasesInfoLight>("/bases").then(b => {
      setSnapshots(b.snapshots || []);
      setManifestVersions(b.manifestVersions || []);
      setSourceGraphs(b.sourceGraphs || b.engines || []);
      setEvalDatasets(b.evalDatasets || []);
    }).catch(e => setAssetsError(e.message || '暂时无法加载业务图谱与题目')).finally(()=>setAssetsLoading(false));
  }, [assetsReload]);
  // 运行中的任务 5s 轮询刷新状态徽标
  useEffect(() => {
    if (!tasks?.some(t => t.running)) return;
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [tasks?.some(t => t.running), refresh]);

  // Opening a task changes only this tab's URL; it never changes a server-global task.
  const continueTask = onOpenTask;
  const openTask = onOpenTask;
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const visibleTasks = tasks?.filter(t => `${t.name} ${t.description} ${t.id}`.toLowerCase().includes(search.toLowerCase()))
    .filter(t=>statusFilter==='archived'?t.archived===true:!t.archived)
    .filter(t => statusFilter === 'all' || (statusFilter === 'running' ? t.running : statusFilter === 'review' ? t.candidates.pendingReview > 0 : !t.running));

  const evolvableTasks = visibleTasks?.filter(t => t.kind === "evolvable") || [];
  const readonlyTasks = visibleTasks?.filter(t => t.kind === "readonly") || [];

  return (
    <div>
      {/* 头部横幅 + 新建按钮 */}
      <div style={{
        border: `1px solid ${COLOR.border}`,
        borderRadius: 14,
        background: GRADIENT.heroBg,
        padding: "28px 32px",
        marginBottom: 20,
        boxShadow: SHADOW.heroCard,
        position: "relative",
        overflow: "hidden",
        display: "flex",
        alignItems: "center",
        gap: 16,
        flexWrap: "wrap",
      }}>
        <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: GRADIENT.accent }} />
        <div style={{ flex: "1 1 480px" }}>
          <Typography.Title level={4} style={{ marginTop: 0, marginBottom: 8, color: COLOR.textPrimary, fontSize: 18, fontWeight: 650 }}>
            <ExperimentOutlined style={{ marginRight: 8, color: "#2a78d6" }} />管理识别优化任务
          </Typography.Title>
          <Typography.Text style={{ fontSize: TYPE.body, color: COLOR.textSecondary, lineHeight: 1.7 }}>
            选择业务图谱，用评测题目找出识别问题，再审阅AI提出的改进。每个任务独立保存，不会自动修改线上图谱。
          </Typography.Text>
        </div>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          size="large"
          onClick={() => setCreateOpen(true)}
          style={{ borderRadius: 10, fontWeight: 600 }}
        >
          新建任务
        </Button>
      </div>

      <Space wrap style={{ marginBottom: 16 }}>
        <Input.Search aria-label="搜索任务" placeholder="搜索任务名、描述或 ID" allowClear value={search} onChange={e => setSearch(e.target.value)} style={{ width: 280, maxWidth: '100%' }} />
        <Select aria-label="按任务状态筛选" value={statusFilter} onChange={setStatusFilter} style={{ width: 160 }} options={[{ value: 'archived', label: '已归档' }, { value: 'all', label: '全部状态' }, { value: 'running', label: '运行中' }, { value: 'review', label: '待审阅' }, { value: 'idle', label: '未运行' }]} />
        {tasks && <Typography.Text type="secondary">{visibleTasks?.length} / {tasks.length} 个任务</Typography.Text>}
      </Space>
      {tasks && !visibleTasks?.length && tasks.length > 0 && <Alert type="info" message="没有匹配的任务，请调整搜索或筛选。" style={{ marginBottom: 16 }} />}
      {error && (
        <Card style={{ borderRadius: 12, marginBottom: 16 }}>
          <Typography.Text type="danger">任务列表加载失败：{error}（请确认 graph-builder 服务在运行）</Typography.Text>
        </Card>
      )}
      {!tasks && !error && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 12, padding: "72px 0", color: COLOR.textTertiary }}>
          <Spin />
          <Typography.Text type="secondary" style={{ fontSize: TYPE.body }}>正在加载任务列表…</Typography.Text>
        </div>
      )}
      {tasks && (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {evolvableTasks.map(t => <TaskRow key={t.id} task={t} onOpen={openTask} onContinue={continueTask} onChanged={refresh} />)}
          </div>
          {readonlyTasks.length > 0 && (
            <>
              <Typography.Text type="secondary" style={{ display: "block", fontSize: TYPE.small, margin: "18px 0 10px" }}>
                参考记录（只读）
              </Typography.Text>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {readonlyTasks.map(t => <TaskRow key={t.id} task={t} onOpen={openTask} onContinue={continueTask} onChanged={refresh} />)}
              </div>
            </>
          )}
          {tasks.length === 0 && (
            <Card style={{ borderRadius: 12, textAlign: "center", padding: 32 }}>
              <Typography.Text type="secondary">还没有进化任务——点右上角「新建任务」开始</Typography.Text>
            </Card>
          )}
        </>
      )}

      <CreateTaskModal
        open={createOpen}
        snapshots={snapshots}
        manifestVersions={manifestVersions || []}
        sourceGraphs={sourceGraphs}
        assetsLoading={assetsLoading}
        assetsError={assetsError}
        onRetryAssets={()=>setAssetsReload(v=>v+1)}
        evalDatasets={evalDatasets || []}
        onClose={() => setCreateOpen(false)}
        onCreated={async (id) => { setCreateOpen(false); await refresh(); onOpenTask(id); }}
        onImported={async (snapshotId) => {
          // 本地图谱导入成功：刷新快照清单（弹窗内部已回填底图选择）
          try {
            const b = await rsiRequest<BasesInfoLight>("/bases");
            setSnapshots(b.snapshots || []);
            setManifestVersions(b.manifestVersions || []);
          } catch { /* 刷新失败不阻塞 */ }
        }}
      />
    </div>
  );
}
