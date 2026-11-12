/**
 * 图谱构建 Agent 对话面板（共享组件）
 *
 * 用于 AiAssistDrawer、AutoBuildPanel 两个场景的 Agent 多轮对话。
 * 基于 openjiuwen graph-builder-agent（skill 包驱动，8 技能）。
 * 技能可 @ 显式调用：点选技能标签或输入 @skill_name，后端强制路由该技能。
 *
 * 对话即建图入口：
 *   - 文本消息 → Agent 按模板 schema 生成/修改图谱，返回结构化文档时给「写入结果区」按钮
 *   - 上传文档 → 服务端解析 → 文档体检（结论上墙）→ 通过则自动分块抽取（实时进度）→ 写入结果区
 *
 * 上传抽取走 REST（checkpoint 断点续跑 + 进度轮询），不走 agent 的 extract skill——
 * 大文档逐块 LLM 由服务端编排更稳，agent 负责其后的质检/修复/改图对话。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Empty, Input, Spin, Tag, Tooltip, Typography, Upload } from 'antd';
import type { InputRef } from 'antd';
import { PaperClipOutlined, RobotOutlined, SendOutlined, ImportOutlined, AppstoreOutlined, CheckCircleOutlined, LoadingOutlined, ClockCircleOutlined } from '@ant-design/icons';
import { message } from '@/utils/antdStatic';
import type { GraphDocument, GraphNode, GraphTemplate, TriageResult } from '@/api/orgGraph';
import {
  checkBuilderAgentHealth,
  createBuilderAgentSession,
  invokeBuilderAgent,
  listBuilderAgentSkills,
  releaseBuilderAgentSession,
  parseDocument,
  documentTriage,
  extractGraph,
  type BuilderAgentHealth,
  type BuilderAgentSkill,
} from '@/api/orgGraph';
import { extractResultToDocument } from '../lib/graphDoc';
import { parseCsvHeaders } from '../lib/tabular';
import type { BuildMaterial } from '../lib/materials';

const { Text } = Typography;

interface BuilderAgentChatProps {
  asset: string;
  document: GraphDocument;
  /** 当前是否激活（父组件用 Segmented 切换时控制） */
  active: boolean;
  /** Drawer/Panel 关闭时父组件通知释放会话 */
  open: boolean;
  /** 目标模板（上传抽取后收敛实体类型用；缺省按原始类型落图） */
  template?: GraphTemplate | null;
  /** Agent 返回结构化图谱（或上传抽取完成）时回调，将文档写入结果区 */
  onGenerated?: (doc: GraphDocument, opts?: { merge?: boolean }) => void;
  /** 上传材料体检通过后入库（材料库：AI 填充取证 + 表格映射入口） */
  onMaterialAdd?: (material: Omit<BuildMaterial, 'id' | 'addedAt'>) => void;
  /** 材料库取证文本（@AI 填充时随 invoke 携带，后端 fill_gaps 缺省取用；父级用 buildFillSourceText 生成） */
  fillSourceText?: string;
  /** 分块抽取进度上抛（null=抽取结束/中断；failed 对象=抽取失败）：父级在右侧结果区展示详细状态卡，聊天流内进度条会随消息滚走 */
  onExtractProgress?: (status: { name: string; completed: number; total: number; startedAt: number; phase?: string; gleanTotal?: number; failed?: boolean; error?: string } | null) => void;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  /** Agent 返回的结构化文档（如果有） */
  document?: GraphDocument;
  /** document 的写入语义：incremental=修改片段须并入结果区；缺省视为完整文档覆盖 */
  mode?: 'create' | 'incremental';
  /** 体检/抽取结果类消息（左侧不带气泡底色差异，用边框强调） */
  kind?: 'system';
}

/** Agent 执行阶段时间线（前端模拟，给用户"在执行"的感知；后端是阻塞式返回无 SSE） */
const AGENT_STEPS = [
  { label: '读取模板 Schema', desc: '加载节点/边类型定义与字段约束', minSec: 1, maxSec: 3 },
  { label: '分析用户意图', desc: '解析需求关键词，匹配模板领域与构建策略', minSec: 3, maxSec: 8 },
  { label: '调用 LLM 生成图谱', desc: '按 Schema 逐节点逐边生成结构化图数据', minSec: 10, maxSec: 30 },
  { label: '解析结构化文档', desc: '校验 JSON 结构、字段类型与必填项', minSec: 2, maxSec: 5 },
  { label: '校验节点与边', desc: '双关校验：边引用合法性、节点完整性', minSec: 2, maxSec: 6 },
  { label: '整理返回结果', desc: '收敛实体类型、生成层级树', minSec: 1, maxSec: 3 },
];

/** 尝试从 reply 文本中提取 JSON 格式的 GraphDocument */
function tryExtractDocument(reply: string): GraphDocument | undefined {
  // Level 0: 直接尝试解析整段文本
  try {
    const parsed = JSON.parse(reply.trim());
    if (parsed && Array.isArray(parsed.nodes) && Array.isArray(parsed.edges)) {
      return parsed as GraphDocument;
    }
  } catch { /* ignore parse error */ }

  // Level 1: 优先匹配 ```json ... ``` 代码块
  const codeBlockMatch = reply.match(/```json\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1].trim());
      if (parsed && Array.isArray(parsed.nodes) && Array.isArray(parsed.edges)) {
        return parsed as GraphDocument;
      }
    } catch { /* ignore parse error */ }
  }

  // Level 2: 提取第一个 { 到最后一个 } 的子串
  const firstBrace = reply.indexOf('{');
  const lastBrace = reply.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const substr = reply.slice(firstBrace, lastBrace + 1);
    try {
      const parsed = JSON.parse(substr);
      if (parsed && Array.isArray(parsed.nodes) && Array.isArray(parsed.edges)) {
        return parsed as GraphDocument;
      }
    } catch { /* ignore parse error */ }
  }

  // Level 3: 提取第一个 [ 到最后一个 ] 的子串（数组格式，尝试组装为 GraphDocument）
  const firstBracket = reply.indexOf('[');
  const lastBracket = reply.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    const substr = reply.slice(firstBracket, lastBracket + 1);
    try {
      const parsed = JSON.parse(substr);
      if (Array.isArray(parsed)) {
        const nodes = parsed.filter((n) => n && typeof n === 'object' && 'id' in (n as Record<string, unknown>));
        if (nodes.length > 0) {
          return { nodes: nodes as GraphNode[], edges: [] } as GraphDocument;
        }
      }
    } catch { /* ignore parse error */ }
  }

  return undefined;
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function triageMessage(fileName: string, triage: TriageResult): { text: string; blocked: boolean } {
  const { profile, structure, relevance, plan, recommendation } = triage;
  const lines: string[] = [`【文档体检】${fileName}`];
  lines.push(`· ${profile.chars.toLocaleString()} 字符 · ${profile.lines} 行${profile.tableLikeRatio >= 0.5 ? ` · 表格特征 ${(profile.tableLikeRatio * 100).toFixed(0)}%` : ''}`);
  const bestSheet = (structure || []).filter((s) => s.match && s.match.score >= 0.3);
  bestSheet.forEach((s) => {
    lines.push(`· 表格「${s.name}」${s.rows} 行 × ${s.headers.length} 列，与模板字段匹配 ${s.match!.matchedCount}/${s.match!.headerCount}`);
  });
  if (relevance?.relevant != null) {
    lines.push(`· 相关性：${relevance.relevant === true ? '✓ 与模板相关' : '✗ 与模板相关性低'}${relevance.contentTypes ? `（识别为 ${relevance.contentTypes}）` : ''}`);
  }
  if (recommendation.mode === 'reject') {
    lines.push('结论：体检不通过，已拦截（0 次 LLM 调用）：');
    recommendation.reasons.forEach((r) => lines.push(`  · ${r}`));
    lines.push('请更换或修复文档后重新上传。');
    return { text: lines.join('\n'), blocked: true };
  }
  lines.push(`· 成本预估：${plan.llmCalls} 次 LLM 调用 · 约 ${Math.max(1, Math.round(plan.estSeconds / 60))} 分钟`);
  if (recommendation.mode === 'low_relevance') {
    lines.push('结论：内容与模板相关性低，请确认材料正确；若继续抽取质量可能不佳。');
  } else if (recommendation.mode === 'suggest_tabular') {
    lines.push('结论：识别出结构化表格——规整表格用 LLM 抽取可能漏列。材料已存入材料库，点材料条目上的「表格映射」可把列确定性映射为图谱（0 次 LLM 调用、不漏列）。');
  } else {
    lines.push('结论：体检通过，开始分块抽取。');
  }
  return { text: lines.join('\n'), blocked: false };
}

export function BuilderAgentChat({ asset, document, active, open, template, onGenerated, onMaterialAdd, fillSourceText, onExtractProgress }: BuilderAgentChatProps) {
  const [health, setHealth] = useState<BuilderAgentHealth | null>(null);
  const [skills, setSkills] = useState<BuilderAgentSkill[]>([]);
  const [sessionId, setSessionId] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  /** @ 提及菜单：输入 @ 时弹出技能选择 */
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionIndex, setMentionIndex] = useState(0);
  const mentionRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(false);
  const [parsing, setParsing] = useState(false);
  /** 上传抽取进度（null = 未在抽取） */
  const [extracting, setExtracting] = useState<{ name: string; completed: number; total: number; phase?: string } | null>(null);
  /** Agent 执行计时器（秒） */
  const [agentElapsed, setAgentElapsed] = useState(0);
  /** Agent 当前阶段索引（动态轮播，给用户"在执行"的感知） */
  const [agentStepIdx, setAgentStepIdx] = useState(0);
  const agentTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<InputRef>(null);
  // 上抛回调走 ref：抽取是长流程，闭包持旧 prop 也不会丢父级最新处理
  const extractProgressRef = useRef(onExtractProgress);
  extractProgressRef.current = onExtractProgress;
  useEffect(() => () => extractProgressRef.current?.(null), []);

  // 切换到 Agent 模式时检查健康状态 + 拉取技能清单（@ 点选面板）
  useEffect(() => {
    if (!active) return;
    checkBuilderAgentHealth()
      .then(setHealth)
      .catch(() => setHealth(null));
    listBuilderAgentSkills()
      .then((r) => setSkills(r.skills || []))
      .catch(() => setSkills([]));
  }, [active]);

  // @ 提及：过滤技能列表
  const filteredSkills = useMemo(() => {
    if (!mentionOpen) return [];
    const q = mentionQuery.toLowerCase();
    return skills.filter(s => s.name.toLowerCase().includes(q) || s.label.toLowerCase().includes(q));
  }, [mentionOpen, mentionQuery, skills]);

  // 处理输入变化：检测 @ 触发提及菜单
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setInput(val);
    // 检测光标前最近的 @
    const caret = e.target.selectionStart ?? val.length;
    const before = val.slice(0, caret);
    const atMatch = before.match(/@([a-zA-Z_\u4e00-\u9fa5]*)$/);
    if (atMatch) {
      setMentionOpen(true);
      setMentionQuery(atMatch[1]);
      setMentionIndex(0);
    } else {
      setMentionOpen(false);
    }
  };

  // 选中某个技能 → 插入 @skill_name 到输入
  const insertMention = (skill: BuilderAgentSkill) => {
    const textarea = (inputRef.current as unknown as { resizableTextArea?: { textArea?: HTMLTextAreaElement } } | null)?.resizableTextArea?.textArea;
    const caret = textarea?.selectionStart ?? input.length;
    const before = input.slice(0, caret);
    const after = input.slice(caret);
    // 替换 @query 为 @skill_name
    const newBefore = before.replace(/@([a-zA-Z_\u4e00-\u9fa5]*)$/, `@${skill.name} `);
    setInput(newBefore + after);
    setMentionOpen(false);
    inputRef.current?.focus();
  };

  // 点击外部关闭提及菜单
  useEffect(() => {
    if (!mentionOpen) return;
    const handler = (e: MouseEvent) => {
      if (mentionRef.current && !mentionRef.current.contains(e.target as Node)) {
        setMentionOpen(false);
      }
    };
    window.document.addEventListener('mousedown', handler);
    return () => window.document.removeEventListener('mousedown', handler);
  }, [mentionOpen]);

  // Agent 执行计时器：loading 期间每秒 tick，推进阶段轮播
  useEffect(() => {
    if (!loading) {
      if (agentTimerRef.current) { clearInterval(agentTimerRef.current); agentTimerRef.current = null; }
      return;
    }
    setAgentElapsed(0);
    setAgentStepIdx(0);
    agentTimerRef.current = setInterval(() => {
      setAgentElapsed((prev) => {
        const next = prev + 1;
        // 根据已用时间推算当前阶段（用各步骤 maxSec 累加为切换阈值）
        let threshold = 0;
        for (let i = 0; i < AGENT_STEPS.length; i++) {
          threshold += AGENT_STEPS[i].maxSec;
          if (next < threshold) { setAgentStepIdx(i); break; }
          if (i === AGENT_STEPS.length - 1) setAgentStepIdx(i); // 最后一步
        }
        return next;
      });
    }, 1000);
    return () => { if (agentTimerRef.current) { clearInterval(agentTimerRef.current); agentTimerRef.current = null; } };
  }, [loading]);

  // 消息列表自动滚动到底部
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, extracting, agentElapsed, agentStepIdx]);

  // Drawer/Panel 关闭时释放会话
  useEffect(() => {
    if (!open && sessionId) {
      releaseBuilderAgentSession(sessionId).catch(() => {});
      setSessionId('');
      setMessages([]);
      setInput('');
    }
  }, [open, sessionId]);

  // 组件卸载（页面路由切换）时释放会话，避免服务端会话泄漏
  useEffect(() => {
    return () => {
      if (sessionId) releaseBuilderAgentSession(sessionId).catch(() => {});
    };
  }, [sessionId]);

  const busy = loading || parsing || extracting !== null;

  function pushMessage(msg: ChatMessage) {
    setMessages((items) => [...items, msg]);
  }

  // ── 上传文档：解析 → 体检 → 通过则自动分块抽取 → 写入结果区 ──
  async function handleUpload(file: File) {
    if (busy) return;
    const lower = file.name.toLowerCase();
    setParsing(true);
    try {
      let text: string;
      let sheets: { name: string; headers: string[]; rows: number }[] | null = null;
      let parseNote = '';
      if (/\.(docx|pdf|xlsx|xls)$/.test(lower)) {
        const buf = await file.arrayBuffer();
        const parsed = await parseDocument(file.name, { base64: arrayBufferToBase64(buf) });
        text = parsed.text;
        sheets = parsed.sheets;
        parseNote = parsed.truncated
          ? `（${parsed.format} 格式，提取 ${parsed.totalLength.toLocaleString()} 字符，超出 ${parsed.maxChars} 字符上限的部分已截断，建议拆分文档）`
          : `（${parsed.format} 格式，提取 ${parsed.totalLength.toLocaleString()} 字符）`;
      } else {
        text = await file.text();
        parseNote = `（${text.length.toLocaleString()} 字符）`;
      }
      pushMessage({ role: 'user', content: `上传文档：${file.name} ${parseNote}` });
      if (!text.trim()) {
        pushMessage({ role: 'assistant', kind: 'system', content: '✗ 解析后没有可用文本，请检查文档内容。' });
        return;
      }
      // CSV 纯文本没有 sheets 结构：客户端解析表头合成 sheets，让表头↔模板匹配能识别表格数据模式
      let triageSheets = sheets;
      if (!triageSheets && /\.csv$/i.test(file.name)) {
        try {
          const parsed = parseCsvHeaders(text);
          if (parsed.headers.length >= 2) triageSheets = [{ name: 'CSV', headers: parsed.headers, rows: parsed.rowCount }];
        } catch { /* 非 CSV 内容 → 走普通抽取 */ }
      }
      const triage = await documentTriage(asset, text, triageSheets);
      const { text: triageText, blocked } = triageMessage(file.name, triage);
      pushMessage({ role: 'assistant', kind: 'system', content: triageText });
      if (blocked) return;

      // 体检通过 → 材料入库（AI 填充取证 + 表格映射入口；抽取失败也不丢材料）
      onMaterialAdd?.({
        name: file.name,
        chars: text.length,
        text,
        sheets: sheets && sheets.length > 0 ? (sheets as BuildMaterial['sheets']) : null,
        triageMode: triage.recommendation.mode,
      });

      // 表格数据模式：不自动跑 LLM 抽取（规整表格用映射确定性建图，避免漏列白烧 token）
      if (triage.recommendation.mode === 'suggest_tabular') {
        setExtracting(null);
        return;
      }

      // 体检通过 → 自动分块抽取（REST，checkpoint 断点续跑 + 进度轮询）
      const startedAt = Date.now();
      setExtracting({ name: file.name, completed: 0, total: 0 });
      extractProgressRef.current?.({ name: file.name, completed: 0, total: 0, startedAt, phase: undefined });
      try {
        const raw = await extractGraph(asset, text, file.name, undefined, {
          jobId: `ej-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          onProgress: (completed, total, phase, gleanTotal) => {
            setExtracting({ name: file.name, completed, total, phase });
            extractProgressRef.current?.({ name: file.name, completed, total, startedAt, phase, gleanTotal });
          },
        });
        setExtracting(null);
        extractProgressRef.current?.(null);
        const resume = raw.resume;
        const resumeNote = resume && resume.fromCache > 0 ? `，断点续跑复用 ${resume.fromCache} 块缓存` : '';
        const failedNote = resume && resume.failed > 0 ? `；有 ${resume.failed} 个分块失败，结果可能不完整（重新上传同一文档会自动续跑补齐）` : '';
        const doc = template
          ? extractResultToDocument(raw, template)
          : extractResultToDocument(raw, { template_id: 'raw', template_version: '0', name: 'raw', node_types: [], edge_types: [], validation_rules: {} });
        if (doc.nodes.length === 0 && doc.edges.length === 0) {
          // 0 实体不是成功：静默合并空产物会被「进入审核精修」落草稿盖掉真实草稿
          pushMessage({
            role: 'assistant',
            kind: 'system',
            content: `⚠ 抽取完成，但 ${resume ? resume.total : '?'} 块${resumeNote}${failedNote}均未抽出任何实体，本次不产生图谱改动。\n常见原因：内容是表格/清单类结构，文本抽取抓不到——建议把材料转成表格后走「表格映射」确定性建图；或补充更叙述性的材料再试。`,
          });
          return;
        }
        pushMessage({
          role: 'assistant',
          kind: 'system',
          content: `✓ 抽取完成：${doc.nodes.length} 节点 / ${doc.edges.length} 边（${resume ? resume.total : '?'} 块${resumeNote}）${failedNote}\n图谱已合并入右侧结果区。可以继续对话修改，例如"质检当前图谱""给每个节点补充描述"。`,
        });
        // 标记来源文件名，供草稿保存与审核精修时识别图谱来源
        onGenerated?.({ ...doc, metadata: { ...(doc.metadata || {}), sourceFileName: file.name } }, { merge: true });
      } catch (e) {
        setExtracting(null);
        extractProgressRef.current?.({ name: file.name, completed: 0, total: 0, startedAt, failed: true, error: e instanceof Error ? e.message : '未知错误' });
        pushMessage({
          role: 'assistant',
          kind: 'system',
          content: `✗ 抽取失败：${e instanceof Error ? e.message : '未知错误'}\n已完成部分已缓存——重新上传同一文档将从断点续跑，无需重头抽取。`,
        });
      }
    } catch (e) {
      pushMessage({ role: 'assistant', kind: 'system', content: `✗ 文档解析失败：${e instanceof Error ? e.message : '未知错误'}` });
    } finally {
      setParsing(false);
    }
  }

  async function handleSend() {
    const text = input.trim();
    if (!text || busy) return;
    // @ 显式技能：消息以 @skill_name 开头时剥离 token、强制路由该技能
    const mention = text.match(/^@([a-zA-Z_][a-zA-Z0-9_]*)\s*/);
    const explicitSkill = mention?.[1];
    const body = (mention ? text.slice(mention[0].length) : text).trim() || (explicitSkill ? '请执行该技能' : '');
    if (!body) return;
    pushMessage({ role: 'user', content: text });
    setInput('');
    setLoading(true);
    try {
      let sid = sessionId;
      if (!sid) {
        const session = await createBuilderAgentSession(asset, document);
        sid = session.sessionId;
        setSessionId(sid);
      }
      const result = await invokeBuilderAgent(sid, body, asset, document, explicitSkill, fillSourceText);
      // 优先使用 result.document，其次尝试从 reply 中提取 JSON
      const doc = result.document || tryExtractDocument(result.reply);
      // audit/complement 等工具按协议让 LLM 把 JSON 原文作为回复——裸 JSON 气泡不可读，
      // 此时用结构化 summary 展示，产物细节走下方按钮/质检卡
      let display = result.reply;
      if (/^\s*[\[{]/.test(display) && result.summary) {
        display = result.summary;
      }
      pushMessage({
        role: 'assistant',
        content: display,
        document: doc,
        mode: result.mode,
      });
    } catch (failure) {
      pushMessage({
        role: 'assistant',
        content: `出错：${failure instanceof Error ? failure.message : 'Agent 调用失败'}`,
      });
    } finally {
      setLoading(false);
    }
  }

  function handleClear() {
    if (sessionId) {
      releaseBuilderAgentSession(sessionId).catch(() => {});
      setSessionId('');
    }
    setMessages([]);
  }

  if (health && !health.ready) {
    return (
      <Alert
        type="warning"
        showIcon
        message="AI 辅助建图 Agent 未就绪"
        description={health.modelConfigured
          ? 'Agent 正在初始化，请稍后重试'
          : 'Agent 的 LLM 模型未配置，请联系管理员检查环境变量 BUILDER_AGENT_MODEL_*'}
        style={{ margin: '12px 0' }}
      />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {health?.ready && (
        <div style={{ marginBottom: 8 }}>
          <Tag color="green" icon={<RobotOutlined />}>Agent 就绪</Tag>
          <Text type="secondary" style={{ fontSize: 11 }}>
            模型：{health.modelName} · 对话生成 / 上传文档建图 / 质检修复
          </Text>
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0', minHeight: 200 }}>
        {messages.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <span style={{ whiteSpace: 'pre-wrap', fontSize: 12, color: '#86909c' }}>
                {'直接开始：\n· 输入描述，如"帮我生成一个转账意图图谱"\n· 点 📎 上传文档，体检通过后自动分块抽取\n· 点下方技能标签 @ 点选，一键调用质检 / 填充 / 消解等能力'}
              </span>
            }
            style={{ padding: '40px 0' }}
          />
        ) : (
          messages.map((msg, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
                marginBottom: 10,
              }}
            >
              <div
                style={{
                  maxWidth: '88%',
                  padding: '8px 12px',
                  borderRadius: 10,
                  background: msg.role === 'user' ? '#e6f4ff' : msg.kind === 'system' ? '#fffbe6' : '#f6ffed',
                  border: `1px solid ${msg.role === 'user' ? '#91caff' : msg.kind === 'system' ? '#ffe58f' : '#b7eb8f'}`,
                  whiteSpace: 'pre-wrap',
                  fontSize: 13,
                  lineHeight: 1.6,
                }}
              >
                {msg.content}
                {msg.document && onGenerated && (
                  <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px dashed #d9d9d9' }}>
                    <Button
                      size="small"
                      type="primary"
                      icon={<ImportOutlined />}
                      onClick={() => onGenerated(msg.document!, msg.mode === 'incremental' ? { merge: true } : undefined)}
                    >
                      {msg.mode === 'incremental' ? '并入结果区（+' : '写入结果区（'}{msg.document.nodes?.length || 0} 节点 / {msg.document.edges?.length || 0} 边）
                    </Button>
                  </div>
                )}
              </div>
            </div>
          ))
        )}
        {loading && (
          <div style={{ maxWidth: '88%', marginBottom: 10 }}>
            {/* 步骤时间线 */}
            <div style={{ background: '#f6f8fa', borderRadius: 8, padding: '10px 14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                <LoadingOutlined style={{ fontSize: 14, color: '#1677ff' }} />
                <Text style={{ fontSize: 13, fontWeight: 500, color: '#1677ff' }}>
                  {AGENT_STEPS[agentStepIdx]?.label || 'Agent 执行中'}
                </Text>
                <Tag style={{ fontSize: 11, marginInlineEnd: 0, lineHeight: '18px' }} color="blue">
                  {agentStepIdx + 1}/{AGENT_STEPS.length}
                </Tag>
                <Text type="secondary" style={{ fontSize: 11, marginLeft: 'auto' }}>
                  <ClockCircleOutlined style={{ marginRight: 2 }} />
                  {agentElapsed}s
                </Text>
              </div>
              {/* 当前步骤描述 */}
              {AGENT_STEPS[agentStepIdx]?.desc && (
                <Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 8, paddingLeft: 20 }}>
                  {AGENT_STEPS[agentStepIdx].desc}
                </Text>
              )}
              {/* 整体进度条（基于步骤完成度） */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <div style={{ flex: 1, height: 4, background: '#e8e8e8', borderRadius: 2, overflow: 'hidden' }}>
                  <div style={{
                    width: `${Math.round(((agentStepIdx + 0.5) / AGENT_STEPS.length) * 100)}%`,
                    height: '100%', background: '#1677ff', borderRadius: 2,
                    transition: 'width 0.5s ease',
                  }} />
                </div>
                <Text type="secondary" style={{ fontSize: 10, flexShrink: 0 }}>
                  {Math.round(((agentStepIdx + 0.5) / AGENT_STEPS.length) * 100)}%
                </Text>
              </div>
              {/* 各步骤状态行 */}
              {AGENT_STEPS.map((step, i) => {
                const done = i < agentStepIdx;
                const current = i === agentStepIdx;
                return (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0', opacity: done || current ? 1 : 0.35 }}>
                    {done ? (
                      <CheckCircleOutlined style={{ fontSize: 12, color: '#52c41a' }} />
                    ) : current ? (
                      <LoadingOutlined style={{ fontSize: 12, color: '#1677ff' }} />
                    ) : (
                      <ClockCircleOutlined style={{ fontSize: 12, color: '#d9d9d9' }} />
                    )}
                    <Text style={{ fontSize: 11, color: done ? '#52c41a' : current ? '#1677ff' : '#86909c' }}>
                      {step.label}
                    </Text>
                    {done && (
                      <Text type="secondary" style={{ fontSize: 10, marginLeft: 'auto' }}>
                        ~{step.maxSec}s
                      </Text>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      {skills.length > 0 && (
        <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', padding: '6px 0', borderTop: '1px solid #f0f2f7' }}>
          <AppstoreOutlined style={{ fontSize: 12, color: '#86909c' }} />
          <Text type="secondary" style={{ fontSize: 11, marginRight: 2 }}>技能点选</Text>
          {skills.map((s) => (
            <Tooltip key={s.name} title={`@${s.name} · ${s.description}（点选后输入需求，直接发送即执行）`} mouseEnterDelay={0.15}>
              <Tag
                color="geekblue"
                style={{ cursor: busy ? 'not-allowed' : 'pointer', marginInlineEnd: 0, fontSize: 11, lineHeight: '18px' }}
                onClick={() => {
                  if (busy) return;
                  setInput((prev) => (prev.includes(`@${s.name}`) ? prev : `@${s.name} ${prev}`.trimStart()));
                  inputRef.current?.focus();
                }}
              >
                @{s.label}
              </Tag>
            </Tooltip>
          ))}
        </div>
      )}

      <div style={{ borderTop: '1px solid #f0f0f0', paddingTop: 10, display: 'flex', gap: 8 }}>
        <div style={{ flex: 1, position: 'relative' }}>
        <Input.TextArea
          ref={inputRef}
          rows={2}
          value={input}
          onChange={handleInputChange}
          placeholder="描述你的需求…（Ctrl+Enter 发送；@ 或点技能标签可显式调用）"
          maxLength={2000}
          onPressEnter={(e) => {
            // 提及菜单打开且有匹配项时 Enter 选中当前项；无匹配项时放行（正常发送）
            if (mentionOpen && filteredSkills.length > 0) {
              e.preventDefault();
              if (filteredSkills[mentionIndex]) insertMention(filteredSkills[mentionIndex]);
              return;
            }
            if (mentionOpen && filteredSkills.length === 0) {
              setMentionOpen(false);
            }
            if (e.ctrlKey) handleSend();
          }}
          onKeyDown={(e) => {
            if (!mentionOpen || filteredSkills.length === 0) return;
            if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIndex(i => Math.min(i + 1, filteredSkills.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIndex(i => Math.max(i - 1, 0)); }
            else if (e.key === 'Escape') { setMentionOpen(false); }
          }}
          disabled={busy}
        />
        {/* @ 提及弹出菜单 */}
        {mentionOpen && filteredSkills.length > 0 && (
          <div ref={mentionRef} style={{
            position: 'absolute', bottom: '100%', left: 0, right: 0,
            maxHeight: 240, overflowY: 'auto',
            background: '#fff', border: '1px solid #d9d9d9', borderRadius: 8,
            boxShadow: '0 -4px 12px rgba(0,0,0,0.12)', zIndex: 1050, padding: 4, marginBottom: 4,
          }}>
            {filteredSkills.map((s, i) => (
              <div
                key={s.name}
                onClick={() => insertMention(s)}
                style={{
                  padding: '6px 12px', cursor: 'pointer', borderRadius: 4,
                  background: i === mentionIndex ? '#e6f4ff' : 'transparent',
                  fontWeight: i === mentionIndex ? 600 : 400,
                }}
                onMouseEnter={() => setMentionIndex(i)}
              >
                <Tag color="blue" style={{ marginRight: 6 }}>{s.name}</Tag>
                {s.label}
              </div>
            ))}
          </div>
        )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <Upload
            accept=".txt,.md,.csv,.docx,.pdf,.xlsx,.xls"
            multiple={false}
            showUploadList={false}
            beforeUpload={(file) => {
              handleUpload(file).catch((e) => message.error(e instanceof Error ? e.message : '上传处理失败'));
              return false;
            }}
            disabled={busy}
          >
            <Button icon={<PaperClipOutlined />} disabled={busy} title="上传文档建图（txt/md/csv/docx/pdf/xlsx，体检通过后自动抽取）" />
          </Upload>
          <Button
            type="primary"
            icon={<SendOutlined />}
            loading={loading}
            disabled={!input.trim() || busy}
            onClick={handleSend}
          >
            发送
          </Button>
          {messages.length > 0 && (
            <Button size="small" onClick={handleClear} disabled={busy}>
              清空
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
