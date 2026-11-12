import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Drawer, Empty, Input, InputNumber, Segmented, Select, Space, Spin, Steps, Tag, Typography } from 'antd';
import { AimOutlined, BulbOutlined, PlusOutlined, RobotOutlined, SendOutlined, SettingOutlined } from '@ant-design/icons';
import type { DraftTrialCandidate, DraftTrialCapabilities, DraftTrialPolicy, DraftTrialResult, DraftTrialSegment, FixSuggestion, GraphDocument, SuggestFixResult } from '@/api/orgGraph';
import { addUtterance, checkTrialAgentHealth, createTrialAgentSession, getDraftTrialCapabilities, invokeTrialAgent, releaseTrialAgentSession, suggestFix, trialIntentGraph } from '@/api/orgGraph';
import type { TrialAgentHealth } from '@/api/orgGraph';

const { Text } = Typography;
const EXAMPLES = ['转账限额怎么查', '查转账限额，再修改转账提醒', '转账'];
const DEFAULT_POLICY: DraftTrialPolicy = {
  strategy: 'hybrid', model: 'auto', topK: 5, matchThreshold: 55, clarifyThreshold: 40, ambiguityMargin: 9,
};
const KIND_LABEL: Record<string, string> = {
  answer: '知识答案', query: '实时查询', menu: '功能菜单', skill: 'Skill',
  workflow: 'Workflow', agent: 'Agent', unconfigured: '尚未配置',
};
const ACTION_LABEL: Record<string, string> = {
  ASK: '咨询', QUERY: '查询', DO: '办理', CHANGE: '修改', CANCEL: '取消', HELP: '引导',
};

interface Props {
  open: boolean;
  onClose: () => void;
  document: GraphDocument;
  onLocate: (id: string) => void;
  onUpdateDocument: (document: GraphDocument) => void;
}

function stageLabel(stage: string, ok: string): { text: string; color: string } {
  if (stage === 'ok') return { text: `${ok}完成`, color: 'success' };
  if (stage === 'skipped') return { text: `${ok}未启用`, color: 'default' };
  if (stage === 'user_confirmation') return { text: '用户已确认', color: 'processing' };
  if (stage === 'unavailable') return { text: `${ok}未配置`, color: 'warning' };
  return { text: `${ok}降级`, color: 'warning' };
}
function orderedCandidates(segment: DraftTrialSegment): DraftTrialCandidate[] {
  if (!segment.selectedId) return segment.candidates;
  const selected = segment.candidates.find((c) => c.id === segment.selectedId);
  if (!selected) return segment.candidates;
  return [selected, ...segment.candidates.filter((c) => c.id !== segment.selectedId)];
}

function ScoreChip({ label, score, color }: { label: string; score: number | null; color: string }) {
  if (score === null) return null;
  return <span style={{ fontSize: 10, padding: '1px 5px', borderRadius: 3, background: color, color: '#fff', fontWeight: 600, whiteSpace: 'nowrap' }}>{label} {score}</span>;
}

function ShapeCard({ result }: { result: DraftTrialResult }) {
  const shapePath = result.shape === 'multi_intent' ? ['多意图', '拆分后分别裁决']
    : result.shape === 'multi_task_same_intent' ? ['多任务同一意图', '多收款人转账', result.status === 'clarify' ? '需确认金额分配' : result.status === 'matched' ? '已命中' : '未可靠命中']
    : ['单意图', result.status === 'clarify' ? '需要澄清' : result.status === 'matched' ? '已命中' : '未可靠命中'];
  return <div style={{ border: '1px solid #dbeafe', borderRadius: 10, padding: '10px 14px', background: '#f6faff', marginBottom: 10 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <Text strong style={{ fontSize: 13 }}>意图形态</Text>
      {shapePath.map((seg, i) => <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        {i > 0 && <span style={{ color: '#b0c4d8' }}>›</span>}
        <Tag color={i === shapePath.length - 1 ? (result.status === 'matched' ? 'success' : result.status === 'clarify' ? 'warning' : 'default') : 'blue'} style={{ margin: 0 }}>{seg}</Tag>
      </span>)}
      {result.model && <Tag style={{ margin: 0 }}>模型：{result.model}</Tag>}
    </div>
    <Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 5, lineHeight: 1.5 }}>{result.reason}</Text>
  </div>;
}

function DecisionFlow({ result }: { result: DraftTrialResult }) {
  const stages = [
    { key: 'local' as const, label: '规则召回', desc: '匹配草稿意图表达、业务对象和动作类型' },
    { key: 'semantic' as const, label: '语义召回', desc: 'Embedding 向量相似度计算' },
    ...(result.policy.strategy === 'hybrid' ? [{ key: 'model' as const, label: '模型裁决', desc: '大模型候选内裁判' }] : []),
  ];
  const hasDegradation = result.stages.semantic.startsWith('degraded:') || result.stages.model.startsWith('degraded:');
  return <div style={{ border: '1px solid #e8edf4', borderRadius: 10, padding: '10px 14px', marginBottom: 10, background: '#fafbfc' }}>
    <Text strong style={{ fontSize: 13, display: 'block', marginBottom: 8 }}>识别链路</Text>
    {stages.map((stage, i) => {
      const value = result.stages[stage.key];
      const meta = stageLabel(value, stage.label);
      const isOk = value === 'ok';
      const isOff = value === 'skipped' || value === 'unavailable';
      return <div key={stage.key} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: i < stages.length - 1 ? 7 : 0 }}>
        <div style={{ width: 22, height: 22, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 600, flexShrink: 0,
          background: isOk ? '#f6ffed' : isOff ? '#f5f5f5' : '#fffbe6',
          border: `1px solid ${isOk ? '#b7eb8f' : isOff ? '#d9d9d9' : '#ffe58f'}`,
          color: isOk ? '#52c41a' : isOff ? '#8c8c8c' : '#faad14' }}>{i + 1}</div>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text strong style={{ fontSize: 12 }}>{stage.label}</Text>
            <Tag color={meta.color} style={{ margin: 0, fontSize: 11 }}>{meta.text}</Tag>
          </div>
          <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 1 }}>{stage.desc}</Text>
        </div>
      </div>;
    })}
    {hasDegradation && <div style={{ marginTop: 8, padding: '5px 10px', background: '#fffbe6', borderRadius: 6, fontSize: 11, color: '#ad6800', lineHeight: 1.5 }}>
      部分识别阶段未完成，结果已按可用阶段降级；请查看候选依据后再决定。
    </div>}
  </div>;
}

function CandidateCard({ candidate, chosen, selected, onSelect, onLocate, onAddUtterance, addingUtterance }: {
  candidate: DraftTrialCandidate;
  chosen: boolean;
  selected: boolean;
  onSelect: () => void;
  onLocate: () => void;
  onAddUtterance?: () => void;
  addingUtterance?: boolean;
}) {
  const evidence = candidate.evidence.filter((e) => !e.startsWith('动作不符'));
  return <div role="button" tabIndex={0} onClick={onSelect} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); } }}
    style={{ border: `1px solid ${chosen ? '#8cc9a4' : selected ? '#b5d3f6' : '#e6eaf0'}`,
    background: chosen ? '#f6fff9' : selected ? '#f7fbff' : '#fff', borderRadius: 10, padding: '11px 12px',
    marginTop: 8, cursor: 'pointer' }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
      <Space size={5} wrap>
        <Text strong>{candidate.name}</Text>
        <Tag style={{ margin: 0 }}>{ACTION_LABEL[candidate.intentType] || candidate.intentType || '未分类'}</Tag>
        {candidate.domain && <Tag color="blue" style={{ margin: 0 }}>{candidate.domain}</Tag>}
        {chosen && <Tag color="success" style={{ margin: 0 }}>本轮命中</Tag>}
      </Space>
      <div style={{ textAlign: 'right', flexShrink: 0 }}>
        <Text strong style={{ color: '#2369a5', fontSize: 15 }}>{candidate.score}</Text>
        <Text type="secondary" style={{ fontSize: 11 }}> 分</Text>
        <div style={{ display: 'flex', gap: 3, justifyContent: 'flex-end', marginTop: 2 }}>
          <ScoreChip label="本地" score={candidate.localScore} color="#3b82f6" />
          <ScoreChip label="语义" score={candidate.semanticScore} color="#8b5cf6" />
        </div>
      </div>
    </div>
    {evidence.length ? <Space size={3} wrap style={{ marginTop: 5 }}>
      {evidence.slice(0, 4).map((e, i) => <Tag key={i} style={{ margin: 0, fontSize: 11, background: '#f5f7fa', border: '1px solid #e8edf4' }}>{e}</Tag>)}
    </Space> : <Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 5 }}>语义候选，仍需核对业务边界</Text>}
    {selected && <div style={{ borderTop: '1px solid #e7edf5', marginTop: 9, paddingTop: 8 }}>
      <Space size={5} wrap>
        <Tag color="blue" style={{ margin: 0 }}>交付：{KIND_LABEL[candidate.fulfillmentKind] || candidate.fulfillmentKind}</Tag>
        {candidate.mock && <Tag color="processing" style={{ margin: 0 }}>演示配置</Tag>}
      </Space>
      {candidate.fulfillmentRef && <Text style={{ display: 'block', fontSize: 12, marginTop: 7, overflowWrap: 'anywhere' }}>目标：{candidate.fulfillmentRef}</Text>}
      {candidate.fulfillmentPreview && <div style={{ marginTop: 5, padding: '7px 10px', background: '#f5f7fa', borderRadius: 6, fontSize: 12, lineHeight: 1.6, overflowWrap: 'anywhere' }}>
        <Text type="secondary" style={{ fontSize: 11 }}>{candidate.fulfillmentKind === 'answer' ? '答案预览' : '结果预览'}</Text>
        <Text style={{ display: 'block', marginTop: 3 }}>{candidate.fulfillmentPreview}</Text>
      </div>}
      {candidate.handoffIssue && <Alert type="warning" message={candidate.handoffIssue} showIcon style={{ marginTop: 8 }} />}
      <Space size={8} style={{ marginTop: 9 }}>
        <Button size="small" icon={<AimOutlined />} onClick={(event) => { event.stopPropagation(); onLocate(); }}>定位图谱节点</Button>
        {onAddUtterance && <Button size="small" icon={<PlusOutlined />} loading={addingUtterance} onClick={(event) => { event.stopPropagation(); onAddUtterance(); }}>加入表达</Button>}
      </Space>
    </div>}
  </div>;
}

export function IntentTrialDrawer({ open, onClose, document, onLocate, onUpdateDocument }: Props) {
  const [mode, setMode] = useState<'instant' | 'agent'>('instant');
  const [query, setQuery] = useState('');
  const [policy, setPolicy] = useState<DraftTrialPolicy>(DEFAULT_POLICY);
  const [capabilities, setCapabilities] = useState<DraftTrialCapabilities | null>(null);
  const [capabilitiesUnavailable, setCapabilitiesUnavailable] = useState(false);
  const [capabilitiesLoading, setCapabilitiesLoading] = useState(false);
  const [history, setHistory] = useState<{ asked: string; result: DraftTrialResult }[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [loading, setLoading] = useState(false);
  const [clarifyLoadingId, setClarifyLoadingId] = useState('');
  const [error, setError] = useState('');
  const [lastQuery, setLastQuery] = useState('');
  const [trialPhase, setTrialPhase] = useState(-1);
  const phaseTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const endRef = useRef<HTMLDivElement>(null);
  const current = history[history.length - 1]?.result;
  const intentCount = document.nodes.filter((node) => node.type === 'INTENT').length;

  // 方案 A：加入表达
  const [addingUtteranceId, setAddingUtteranceId] = useState('');
  // 方案 B：AI 辅助修正
  const [fixInput, setFixInput] = useState('');
  const [fixLoading, setFixLoading] = useState(false);
  const [fixResult, setFixResult] = useState<SuggestFixResult | null>(null);
  const [fixError, setFixError] = useState('');

  // Agent 对话模式
  const [agentHealth, setAgentHealth] = useState<TrialAgentHealth | null>(null);
  const [agentSessionId, setAgentSessionId] = useState('');
  const [agentMessages, setAgentMessages] = useState<{ role: 'user' | 'assistant'; content: string }[]>([]);
  const [agentInput, setAgentInput] = useState('');
  const [agentLoading, setAgentLoading] = useState(false);
  const agentEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setCapabilitiesUnavailable(false);
    setCapabilitiesLoading(true);
    getDraftTrialCapabilities().then((value) => { setCapabilities(value); setPolicy(value.defaultPolicy); })
      .catch(() => { setCapabilities(null); setCapabilitiesUnavailable(true); })
      .finally(() => setCapabilitiesLoading(false));
  }, [open]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [history.length]);
  useEffect(() => () => { phaseTimers.current.forEach(clearTimeout); }, []);

  // Agent 模式：健康检查 + 会话清理
  useEffect(() => {
    if (!open || mode !== 'agent') return;
    if (!agentHealth) {
      checkTrialAgentHealth().then(setAgentHealth).catch(() => setAgentHealth(null));
    }
  }, [open, mode, agentHealth]);

  useEffect(() => { agentEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [agentMessages.length]);

  // Drawer 关闭时释放 Agent 会话
  useEffect(() => {
    if (open) return;
    if (agentSessionId) {
      releaseTrialAgentSession(agentSessionId).catch(() => {});
      setAgentSessionId('');
      setAgentMessages([]);
    }
  }, [open, agentSessionId]);

  function clearPhaseTimers() {
    phaseTimers.current.forEach(clearTimeout);
    phaseTimers.current = [];
  }
  function startPhaseTimers(strategy: string) {
    clearPhaseTimers();
    setTrialPhase(0);
    phaseTimers.current.push(setTimeout(() => setTrialPhase(1), 300));
    phaseTimers.current.push(setTimeout(() => setTrialPhase(2), 800));
    if (strategy === 'hybrid') {
      phaseTimers.current.push(setTimeout(() => setTrialPhase(3), 1500));
    }
  }

  async function submit(input = query, options?: { example?: boolean; choiceId?: string; choiceSegment?: number; asked?: string }) {
    const text = input.trim();
    if (!text || loading) return;
    setError(''); setLoading(true); setLastQuery(text);
    startPhaseTimers(policy.strategy);
    try {
      const contextQuery = !options?.example && !options?.choiceId && current?.status === 'clarify'
        && (current.shape === 'single_intent' || current.shape === 'multi_task_same_intent') ? current.query : undefined;
      const result = await trialIntentGraph(document, text, policy, contextQuery, options?.choiceId, options?.choiceSegment);
      setHistory((items) => [...items.slice(-6), { asked: options?.asked || text, result }]);
      setSelectedId(result.segments[0]?.selectedId || result.segments[0]?.candidates[0]?.id || '');
      setQuery('');
    } catch (failure) { setError(failure instanceof Error ? failure.message : '试问失败，请稍后重试'); }
    finally { clearPhaseTimers(); setTrialPhase(-1); setLoading(false); setClarifyLoadingId(''); }
  }

  // 方案 A：将当前试问表达加入指定意图节点的 utterance_view
  async function handleAddUtterance(nodeId: string, candidateName: string) {
    const asked = lastQuery || history[history.length - 1]?.asked || '';
    if (!asked) return;
    setAddingUtteranceId(nodeId);
    try {
      const result = await addUtterance(document, nodeId, asked);
      onUpdateDocument(result.document);
      // 自动重新试问验证效果
      void submit(asked, { example: true });
    } catch (failure) {
      setError(`加入表达失败：${failure instanceof Error ? failure.message : '未知错误'}`);
    } finally {
      setAddingUtteranceId('');
    }
  }

  // 方案 B：AI 辅助修正
  async function handleSuggestFix() {
    const correction = fixInput.trim();
    if (!correction || fixLoading) return;
    const asked = lastQuery || history[history.length - 1]?.asked || '';
    if (!asked) return;
    setFixLoading(true); setFixError(''); setFixResult(null);
    try {
      const topCandidates = current?.segments[0]?.candidates.slice(0, 3) || [];
      const targetId = selectedId || current?.segments[0]?.selectedId || '';
      const result = await suggestFix(document, asked, correction, topCandidates, targetId || undefined);
      setFixResult(result);
    } catch (failure) {
      setFixError(failure instanceof Error ? failure.message : 'AI 修正建议获取失败');
    } finally {
      setFixLoading(false);
    }
  }

  // 应用 AI 修正建议
  async function applySuggestion(suggestion: FixSuggestion) {
    const node = document.nodes.find((n) => n.id === suggestion.nodeId);
    if (!node) return;
    const props = node.properties || (node.properties = {});
    if (suggestion.type === 'add_utterance') {
      const list = Array.isArray(props.utterance_view) ? props.utterance_view : [];
      const value = suggestion.value || lastQuery;
      if (!list.some((u) => String(u) === value)) {
        props.utterance_view = [...list, value];
      }
    } else if (suggestion.type === 'rename_intent') {
      props.name = suggestion.value;
    } else if (suggestion.type === 'change_action') {
      props.intent_type = suggestion.value;
    } else if (suggestion.type === 'change_object') {
      props.tb_object_name = suggestion.value;
    }
    onUpdateDocument({ ...document });
    setFixResult(null); setFixInput('');
    // 重新试问验证
    const asked = lastQuery || history[history.length - 1]?.asked || '';
    if (asked) void submit(asked, { example: true });
  }

  // Agent 对话：发送消息
  async function handleAgentSend() {
    const text = agentInput.trim();
    if (!text || agentLoading) return;
    setAgentMessages((items) => [...items, { role: 'user', content: text }]);
    setAgentInput('');
    setAgentLoading(true);
    try {
      // 首次发送时创建会话
      let sid = agentSessionId;
      if (!sid) {
        const session = await createTrialAgentSession(document, policy);
        sid = session.sessionId;
        setAgentSessionId(sid);
      }
      const result = await invokeTrialAgent(sid, text, document, policy);
      setAgentMessages((items) => [...items, { role: 'assistant', content: result.reply }]);
    } catch (failure) {
      setAgentMessages((items) => [...items, {
        role: 'assistant',
        content: `出错：${failure instanceof Error ? failure.message : 'Agent 调用失败'}`,
      }]);
    } finally {
      setAgentLoading(false);
    }
  }

  return <Drawer title="AI 评测迭代" width={600} open={open} onClose={onClose}
    extra={<Space>
      <Segmented size="small" value={mode} onChange={(value) => setMode(value as 'instant' | 'agent')}
        options={[{ label: '即时试问', value: 'instant' }, { label: 'Agent 对话', value: 'agent' }]} />
      {mode === 'instant' && <Button size="small" disabled={!history.length} onClick={() => { setHistory([]); setSelectedId(''); setError(''); }}>清空记录</Button>}
    </Space>}>
    <div style={{ border: '1px solid #dbeafe', borderRadius: 10, background: '#f6faff', padding: '12px 14px', marginBottom: 14 }}>
      <Text strong>用当前画布试问 · {intentCount} 个具体意图</Text>
      <Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 4, lineHeight: 1.6 }}>
        未保存的修改也参与识别。可查看单意图、多意图和需要澄清的问题；只预览答案或入口，不执行查询与交易。
      </Text>
    </div>

    {mode === 'agent' && (
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: 'calc(100vh - 220px)' }}>
        {/* Agent 状态提示 */}
        <div style={{ marginBottom: 10 }}>
          {agentHealth ? (
            agentHealth.ready ? <Alert type="success" showIcon message={<span style={{ fontSize: 12 }}>Agent 已就绪 · openjiuwen {agentHealth.version} · {agentHealth.modelName}</span>} />
              : <Alert type="warning" showIcon message={<span style={{ fontSize: 12 }}>Agent 未就绪（{agentHealth.modelConfigured ? 'Checkpointer 初始化中' : '模型未配置'}）</span>} />
          ) : (
            <Space size={4}><Spin size="small" /><Text type="secondary" style={{ fontSize: 12 }}>正在检查 Agent 服务…</Text></Space>
          )}
        </div>
        {/* 消息列表 */}
        <div style={{ flex: 1, overflowY: 'auto', paddingRight: 4 }}>
          {agentMessages.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={
              <span style={{ fontSize: 12 }}>
                <RobotOutlined /> 输入问题开始与 Agent 对话<br />
                Agent 会自动调用试问工具、分析召回结果并给出修正建议
              </span>
            } style={{ marginTop: 50 }} />
          ) : agentMessages.map((msg, i) => (
            <div key={i} style={{
              display: 'flex', justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
              marginBottom: 10,
            }}>
              <div style={{
                maxWidth: '85%', padding: '9px 12px', borderRadius: 10, fontSize: 13, lineHeight: 1.6,
                background: msg.role === 'user' ? '#e8f2ff' : '#f5f7fa',
                whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              }}>{msg.content}</div>
            </div>
          ))}
          {agentLoading && (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <Spin size="small" /><Text type="secondary" style={{ fontSize: 12 }}>Agent 思考中…</Text>
            </div>
          )}
          <div ref={agentEndRef} />
        </div>
        {/* 输入区 */}
        <div style={{ borderTop: '1px solid #edf0f4', paddingTop: 12, marginTop: 8 }}>
          <Input.TextArea value={agentInput} rows={2} maxLength={500} showCount disabled={agentLoading}
            placeholder='输入用户问题，例如「转账限额怎么查」'
            onChange={(e) => setAgentInput(e.target.value)}
            onPressEnter={(e) => { if (!e.shiftKey) { e.preventDefault(); void handleAgentSend(); } }} />
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
            <Button type="primary" icon={<SendOutlined />} loading={agentLoading} disabled={!agentInput.trim()}
              onClick={() => void handleAgentSend()}>发送</Button>
          </div>
        </div>
      </div>
    )}

    {mode === 'instant' && (<>
    <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
      <div style={{ flex: 1 }}><Text type="secondary" style={{ display: 'block', fontSize: 11, marginBottom: 4 }}>识别方式</Text>
        <Select value={policy.strategy} style={{ width: '100%' }} onChange={(strategy) => setPolicy((p) => ({ ...p, strategy }))}
          options={[{ value: 'hybrid', label: '综合识别 · 规则 + 语义 + 模型' }, { value: 'semantic', label: '语义识别 · 规则 + 向量' }, { value: 'rules', label: '快速识别 · 仅草稿规则' }]} /></div>
      <div style={{ width: 150 }}><Text type="secondary" style={{ display: 'block', fontSize: 11, marginBottom: 4 }}>大模型裁决</Text>
        <Select value={policy.model} disabled={policy.strategy !== 'hybrid'} style={{ width: '100%' }}
          onChange={(model) => setPolicy((p) => ({ ...p, model }))}
          options={[{ value: 'auto', label: '自动选择' }, { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' }, { value: 'qwen-plus', label: '通义千问' }, { value: 'off', label: '不使用模型' }]} /></div>
    </div>
    <Text type="secondary" style={{ display: 'block', fontSize: 11, marginBottom: 7 }}>
      {capabilitiesLoading ? <Space size={4}><Spin size="small" />正在检查模型配置…</Space>
        : capabilities ? `语义模型：${capabilities.embedding ? '已配置' : '未配置'}；大模型：${capabilities.models.length ? capabilities.models.join(' / ') : '未配置'}。密钥由服务端管理。`
        : capabilitiesUnavailable ? '模型配置暂时无法读取，试问时将显示具体错误。' : ''}
    </Text>
    <details style={{ border: '1px solid #e8edf4', borderRadius: 8, padding: '7px 10px', marginBottom: 14 }}>
      <summary style={{ cursor: 'pointer', color: '#51637b', fontSize: 12 }}><SettingOutlined /> 本次试问策略</summary>
      <Text type="secondary" style={{ display: 'block', fontSize: 11, margin: '7px 0 10px' }}>仅影响当前试问，不修改已发布引擎。提高命中门槛可减少误命中；提高澄清间距会让相近候选更容易触发追问。</Text>
      <Space size={10} wrap>
        <label style={{ fontSize: 12 }}>命中门槛 <InputNumber min={40} max={85} size="small" value={policy.matchThreshold}
          onChange={(value) => setPolicy((p) => ({ ...p, matchThreshold: value ?? p.matchThreshold }))} /></label>
        <label style={{ fontSize: 12 }}>候选下限 <InputNumber min={25} max={70} size="small" value={policy.clarifyThreshold}
          onChange={(value) => setPolicy((p) => ({ ...p, clarifyThreshold: value ?? p.clarifyThreshold }))} /></label>
        <label style={{ fontSize: 12 }}>澄清间距 <InputNumber min={3} max={25} size="small" value={policy.ambiguityMargin}
          onChange={(value) => setPolicy((p) => ({ ...p, ambiguityMargin: value ?? p.ambiguityMargin }))} /></label>
        <label style={{ fontSize: 12 }}>候选数 <InputNumber min={1} max={10} size="small" value={policy.topK}
          onChange={(value) => setPolicy((p) => ({ ...p, topK: value ?? p.topK }))} /></label>
      </Space>
    </details>

    <Input.TextArea value={query} rows={3} maxLength={500} showCount disabled={loading}
      placeholder={current?.status === 'clarify' ? '继续补充信息，例如“我想办理转账”' : '输入真实用户问题，例如“查转账限额，再修改转账提醒”'}
      onChange={(event) => setQuery(event.target.value)}
      onPressEnter={(event) => { if (!event.shiftKey) { event.preventDefault(); void submit(); } }} />
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10, gap: 8 }}>
      <Space size={5} wrap>{EXAMPLES.map((example) => <Button key={example} size="small" type="link" style={{ paddingInline: 2 }}
        disabled={loading} onClick={() => void submit(example, { example: true })}>{example}</Button>)}</Space>
      <Button type="primary" icon={<SendOutlined />} loading={loading} disabled={!query.trim() || !intentCount}
        onClick={() => void submit()}>{current?.status === 'clarify' ? '继续试问' : '试问'}</Button>
    </div>
    {error && <Alert type="error" showIcon message={error} action={<Button size="small" disabled={loading} onClick={() => void submit(lastQuery)}>重试</Button>} style={{ marginTop: 13 }} />}

    {loading && trialPhase >= 0 && (() => {
      const phases = policy.strategy === 'hybrid'
        ? [{ title: '分析问题', desc: '解析用户输入' }, { title: '规则召回', desc: '匹配草稿意图表达' }, { title: '语义匹配', desc: '向量相似度计算' }, { title: '模型裁决', desc: '大模型综合判断' }]
        : policy.strategy === 'semantic'
          ? [{ title: '分析问题', desc: '解析用户输入' }, { title: '规则召回', desc: '匹配草稿意图表达' }, { title: '语义匹配', desc: '向量相似度计算' }]
          : [{ title: '分析问题', desc: '解析用户输入' }, { title: '规则召回', desc: '匹配草稿意图表达' }];
      return <div style={{ marginTop: 16, padding: '16px 20px', border: '1px solid #e8edf4', borderRadius: 10, background: '#fafbfc' }}>
        <Steps size="small" current={trialPhase} direction="vertical"
          items={phases.map((p, i) => ({
            title: p.title,
            description: i < trialPhase ? p.desc : i === trialPhase ? <Space size={4}><Spin size="small" /><span style={{ fontSize: 11, color: '#8c8c8c' }}>{p.desc}…</span></Space> : p.desc,
            status: i < trialPhase ? 'finish' : i === trialPhase ? 'process' : 'wait',
          }))} />
      </div>;
    })()}

    {!history.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={loading ? '正在识别…' : '输入问题后查看识别过程与结果'} style={{ marginTop: 35 }} />
      : <div style={{ marginTop: 18 }}>
        {history.slice(0, -1).map((turn, index) => <div key={`${index}-${turn.asked}`} style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}><Text style={{ background: '#eef4fa', padding: '7px 10px', borderRadius: 8, fontSize: 12 }}>{turn.asked}</Text></div>
          <Text type="secondary" style={{ display: 'block', fontSize: 11, marginTop: 5 }}>
            {turn.result.shape === 'multi_intent' ? `${turn.result.segments.length} 项意图` : turn.result.shape === 'multi_task_same_intent' ? '多收款人转账' : turn.result.status === 'matched'
              ? `命中：${turn.result.segments[0]?.candidates.find((item) => item.id === turn.result.segments[0]?.selectedId)?.name || '已确认意图'}`
              : turn.result.status === 'clarify' ? '需要澄清' : '未可靠命中'}
          </Text>
        </div>)}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 9 }}>
          <Text style={{ background: '#e8f2ff', padding: '7px 10px', borderRadius: 8 }}>{history[history.length - 1].asked}</Text>
        </div>
        <ShapeCard result={current} />
        <DecisionFlow result={current} />
        {current.segments.map((segment, segmentIndex) => <div key={`${segmentIndex}-${segment.text}`} style={{ marginTop: 4, paddingBottom: 12,
          borderBottom: segmentIndex < current.segments.length - 1 ? '1px solid #edf0f4' : undefined }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
            <Text strong>{current.shape === 'multi_intent' ? `${segmentIndex + 1}. ${segment.text}` : current.shape === 'multi_task_same_intent' ? '转账意图' : '候选意图'}</Text>
            <Tag color={segment.status === 'matched' ? 'success' : segment.status === 'clarify' ? 'warning' : 'default'} style={{ margin: 0 }}>
              {segment.status === 'matched' ? '已命中' : segment.status === 'clarify' ? '待澄清' : '未命中'}
            </Tag>
            {segment.inferredAction && <Tag style={{ margin: 0 }}>{ACTION_LABEL[segment.inferredAction] || segment.inferredAction}</Tag>}
          </div>
          {segment.status !== 'matched' && <Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 4 }}>{segment.reason}</Text>}
          {segment.clarification && <div style={{ marginTop: 7, padding: '7px 10px', background: '#fffbe6', borderRadius: 6, fontSize: 12, color: '#614700', lineHeight: 1.5 }}>{segment.clarification}</div>}
          {orderedCandidates(segment).slice(0, 3).map((candidate) => <CandidateCard key={candidate.id} candidate={candidate}
            selected={selectedId === candidate.id || segment.selectedId === candidate.id} chosen={segment.selectedId === candidate.id}
            onSelect={() => setSelectedId(candidate.id)} onLocate={() => onLocate(candidate.id)}
            onAddUtterance={() => void handleAddUtterance(candidate.id, candidate.name)} addingUtterance={addingUtteranceId === candidate.id} />)}
          {segment.candidates.length > 3 && <details style={{ marginTop: 8 }}><summary style={{ cursor: 'pointer', color: '#64748b', fontSize: 12 }}>
            查看另外 {segment.candidates.length - 3} 个候选
          </summary>{orderedCandidates(segment).slice(3).map((candidate) => <CandidateCard key={candidate.id} candidate={candidate}
            selected={selectedId === candidate.id || segment.selectedId === candidate.id} chosen={segment.selectedId === candidate.id}
            onSelect={() => setSelectedId(candidate.id)} onLocate={() => onLocate(candidate.id)}
            onAddUtterance={() => void handleAddUtterance(candidate.id, candidate.name)} addingUtterance={addingUtteranceId === candidate.id} />)}</details>}
          {segment.status === 'clarify' && <div style={{ marginTop: 9, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {segment.candidates.slice(0, 3).map((candidate) => (
              <div key={candidate.id} role="button" tabIndex={0}
                style={{ border: `1px solid ${clarifyLoadingId === candidate.id ? '#4096ff' : '#ffe58f'}`, borderRadius: 8, padding: '8px 10px', background: clarifyLoadingId === candidate.id ? '#f7fbff' : '#fffbe6', minWidth: 130, maxWidth: 180, cursor: loading ? 'wait' : 'pointer', position: 'relative', flex: 1 }}
                onClick={() => { if (!loading) { setClarifyLoadingId(candidate.id); void submit(current.query, { choiceId: candidate.id, choiceSegment: segmentIndex, asked: `确认：${candidate.name}` }); } }}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (!loading) { setClarifyLoadingId(candidate.id); void submit(current.query, { choiceId: candidate.id, choiceSegment: segmentIndex, asked: `确认：${candidate.name}` }); } } }}>
                <Text strong style={{ fontSize: 12 }}>{candidate.name}</Text>
                <div style={{ marginTop: 2, display: 'flex', gap: 4, alignItems: 'center' }}>
                  <Text style={{ fontSize: 11, color: '#2369a5', fontWeight: 600 }}>{candidate.score} 分</Text>
                  {candidate.localScore > 0 && <span style={{ fontSize: 10, color: '#3b82f6' }}>本地 {candidate.localScore}</span>}
                </div>
                {candidate.clarificationPrompt && <Text type="secondary" style={{ display: 'block', fontSize: 11, marginTop: 2, lineHeight: 1.4 }}>{candidate.clarificationPrompt}</Text>}
                {clarifyLoadingId === candidate.id && <Spin size="small" style={{ position: 'absolute', top: 8, right: 8 }} />}
              </div>
            ))}
          </div>}
        </div>)}
        <Text type="secondary" style={{ display: 'block', fontSize: 11, lineHeight: 1.5, marginTop: 10 }}>
          匹配分用于当前草稿候选排序，不是概率；即使模型给出建议，也只允许选择画布中已有的意图。试问不会执行交付目标。
        </Text>

        {/* 方案 B：AI 辅助修正 */}
        {current && (
          <div style={{ marginTop: 14, padding: '12px 14px', border: '1px solid #e8edf4', borderRadius: 10, background: '#fafbfc' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
              <BulbOutlined style={{ color: '#faad14' }} />
              <Text strong style={{ fontSize: 13 }}>AI 辅助修正</Text>
              <Text type="secondary" style={{ fontSize: 11 }}>召回结果不对？描述期望的修正，AI 帮你分析并给出修改方案</Text>
            </div>
            <Input.TextArea value={fixInput} rows={2} maxLength={300} showCount
              placeholder='例如：应该命中「办理转账汇款」而不是「查询转账记录」'
              disabled={fixLoading}
              onChange={(e) => setFixInput(e.target.value)}
              onPressEnter={(e) => { if (!e.shiftKey) { e.preventDefault(); void handleSuggestFix(); } }} />
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
              <Button size="small" icon={<BulbOutlined />} loading={fixLoading} disabled={!fixInput.trim()}
                onClick={() => void handleSuggestFix()}>分析并建议</Button>
            </div>
            {fixError && <Alert type="error" showIcon message={fixError} style={{ marginTop: 8 }} />}
            {fixResult && (
              <div style={{ marginTop: 10 }}>
                {fixResult.analysis && <Alert type="info" showIcon message={fixResult.analysis} style={{ marginBottom: 8 }} />}
                {fixResult.fallback && <Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 6 }}>AI 暂不可用，已生成基础建议</Text>}
                {fixResult.suggestions.map((suggestion, i) => (
                  <div key={i} style={{ border: '1px solid #d9d9d9', borderRadius: 8, padding: '8px 10px', marginBottom: 6, background: '#fff' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                      <Space size={5} wrap>
                        <Tag color="blue" style={{ margin: 0 }}>{suggestion.label}</Tag>
                        <Text style={{ fontSize: 12 }}>{suggestion.detail}</Text>
                      </Space>
                      <Button size="small" type="primary" onClick={() => void applySuggestion(suggestion)}>应用</Button>
                    </div>
                    {suggestion.value && <Text type="secondary" style={{ display: 'block', fontSize: 11, marginTop: 4 }}>建议值：{suggestion.value}</Text>}
                  </div>
                ))}
                {fixResult.suggestions.length === 0 && <Text type="secondary" style={{ fontSize: 12 }}>AI 未给出修改建议</Text>}
              </div>
            )}
          </div>
        )}

        <div ref={endRef} />
      </div>}
    </>)}
  </Drawer>;
}
