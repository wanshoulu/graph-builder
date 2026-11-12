import { Alert, Collapse, Input, Select, Space, Tag, Typography } from 'antd';
import type { ChangeEvent, ReactNode } from 'react';

const { Text } = Typography;

export const FULFILLMENT_FIELDS = new Set([
  'fulfillment_kind', 'answer_text', 'answer_ref', 'query_ref', 'menu_ref',
  'skill_ref', 'workflow_ref', 'agent_ref', 'required_slot_refs',
  'clarification_prompt', 'missing_slot_prompt', 'confirmation_prompt', 'fallback_response',
  'input_mapping_json', 'result_template', 'confirmation_policy',
]);

const MODES = [
  { value: 'unconfigured', label: '暂不配置', hint: '仅定义意图，不绑定交付能力' },
  { value: 'answer', label: '问答', hint: '直接回答或引用知识答案节点' },
  { value: 'query', label: '查询', hint: '调用已注册查询能力' },
  { value: 'menu', label: '功能菜单', hint: '引导到页面或功能入口' },
  { value: 'skill', label: 'Skill', hint: '调用平台 Skill' },
  { value: 'workflow', label: 'Workflow', hint: '启动业务流程' },
  { value: 'agent', label: 'Agent', hint: '交由智能体处理' },
] as const;

const TARGETS: Record<string, { field: string; label: string; placeholder: string; help: string }> = {
  query: { field: 'query_ref', label: '查询能力引用', placeholder: '能力 ID 或受控 HTTPS 地址', help: '运行端负责鉴权、参数绑定和结果呈现。' },
  menu: { field: 'menu_ref', label: '功能菜单引用', placeholder: '菜单 ID 或应用内路径', help: '指向可用的办理入口；不要填写纯展示文案。' },
  skill: { field: 'skill_ref', label: 'Skill 引用', placeholder: '平台 Skill ID', help: '填写 Skill Hub 中稳定的 Skill 标识。' },
  workflow: { field: 'workflow_ref', label: 'Workflow 引用', placeholder: '平台 Workflow ID', help: '填写已发布流程的稳定标识。' },
  agent: { field: 'agent_ref', label: 'Agent 引用', placeholder: '平台 Agent ID', help: '填写可接管该任务的智能体标识。' },
};

export function fulfillmentIssue(data: Record<string, unknown>, referenceNodes: { id: string; type: string; answerText?: string }[] = []): string | null {
  const kind = String(data.fulfillment_kind || 'unconfigured');
  const filled = (key: string) => String(data[key] ?? '').trim().length > 0;
  if (kind === 'answer' && !filled('answer_text') && !filled('answer_ref')) return '请填写直接回答或知识答案引用';
  if (referenceNodes.length && kind === 'answer' && filled('answer_ref') && !referenceNodes.some((node) => node.id === data.answer_ref && node.type === 'KNOWLEDGE_ANSWER')) return '知识答案引用不在当前图谱中';
  if (referenceNodes.length && kind === 'answer' && filled('answer_ref') && !filled('answer_text') && !referenceNodes.some((node) => node.id === data.answer_ref && String(node.answerText || '').trim())) return '引用的知识答案还没有正文';
  if (referenceNodes.length && Array.isArray(data.required_slot_refs) && data.required_slot_refs.some((id) => !referenceNodes.some((node) => node.id === id && node.type === 'SLOT'))) return '必需槽位引用不在当前图谱中';
  const target = TARGETS[kind];
  if (kind !== 'answer' && kind !== 'unconfigured' && !target) return '交付方式无效';
  if (target && !filled(target.field)) return `请填写${target.label}`;
  if (data.confirmation_policy === 'before_execute' && !filled('confirmation_prompt')) return '请填写执行确认话术';
  if (['query', 'skill', 'workflow', 'agent'].includes(kind) && filled('input_mapping_json')) {
    try {
      const mapping = JSON.parse(String(data.input_mapping_json));
      if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping) || Object.values(mapping).some((value) => typeof value !== 'string')) return '输入映射应为“参数名 → 槽位 ID”的 JSON 对象';
      if (referenceNodes.length && Object.values(mapping).some((value) => !referenceNodes.some((node) => node.id === value && node.type === 'SLOT'))) return '输入映射引用了当前图谱中不存在的槽位';
    } catch { return '输入映射不是有效的 JSON'; }
  }
  return null;
}

interface Props {
  data: Record<string, unknown>;
  referenceNodes?: { id: string; type: string; name: string; answerText?: string; contentStatus?: string }[];
  readOnly?: boolean;
  onChange: (field: string, value: unknown) => void;
  onEditing: (editing: boolean) => void;
}

function Field({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return (
    <div style={{ marginTop: 14 }}>
      <Text strong style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>{label}</Text>
      {children}
      {help && <Text type="secondary" style={{ display: 'block', fontSize: 11, lineHeight: 1.5, marginTop: 5 }}>{help}</Text>}
    </div>
  );
}

export function IntentFulfillmentEditor({ data, referenceNodes = [], readOnly, onChange, onEditing }: Props) {
  const kind = String(data.fulfillment_kind || 'unconfigured');
  const issue = fulfillmentIssue(data, referenceNodes);
  const target = TARGETS[kind];
  const targetRef = target ? String(data[target.field] || '') : '';
  const answerNode = referenceNodes.find((node) => node.id === data.answer_ref);
  const isMock = /^mock:|^\/mock\//.test(targetRef) || answerNode?.contentStatus === 'mock' || String(data.answer_text || '').startsWith('【演示】');
  const status = kind === 'unconfigured' ? { label: '未配置', color: 'default' } : issue
    ? { label: '待完善', color: 'warning' } : isMock ? { label: '演示配置', color: 'processing' } : { label: '配置完整', color: 'success' };
  const setText = (field: string) => (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(field, event.target.value);
  const focus = () => onEditing(true);
  const blur = () => onEditing(false);
  const changeKind = (value: string) => {
    onChange('fulfillment_kind', value);
    if (!['query', 'skill', 'workflow', 'agent'].includes(value) && data.confirmation_policy === 'before_execute') onChange('confirmation_policy', 'none');
  };

  return (
    <div style={{ border: '1px solid #dce9f7', borderRadius: 10, background: 'linear-gradient(180deg, #f7fbff 0%, #fff 72%)', padding: '14px 14px 10px', marginBottom: 12 }}>
      <Space size={7} align="center" style={{ marginBottom: 3 }}>
        <span style={{ display: 'inline-block', width: 4, height: 17, borderRadius: 2, background: '#2479db' }} />
        <Text strong style={{ fontSize: 14 }}>识别后的交付</Text>
        <Tag color={status.color} style={{ margin: 0 }}>{status.label}</Tag>
      </Space>
      <Text type="secondary" style={{ display: 'block', fontSize: 11, lineHeight: 1.5 }}>
        语义定义决定识别什么；这里配置识别成功后交付什么。
      </Text>

      <Field label="交付方式">
        <Select
          style={{ width: '100%' }}
          value={kind}
          disabled={readOnly}
          onChange={changeKind}
          options={MODES.map((mode) => ({ value: mode.value, label: mode.label, title: mode.hint }))}
        />
      </Field>

      {kind === 'answer' && <>
        <Field label="直接回答" help="可直接维护答案，也可填写下方知识答案节点 ID；二者至少配置一项。">
          <Input.TextArea rows={4} value={String(data.answer_text ?? '')} placeholder="输入用户可见的回答内容" disabled={readOnly}
            onFocus={focus} onBlur={blur} onChange={setText('answer_text')} />
        </Field>
        <Field label="知识答案引用">
          {referenceNodes.length ? <Select showSearch allowClear style={{ width: '100%' }} value={String(data.answer_ref || '') || undefined}
            placeholder="选择当前图谱中的答案节点" disabled={readOnly}
            optionFilterProp="label"
            options={referenceNodes.filter((node) => node.type === 'KNOWLEDGE_ANSWER').map((node) => ({ value: node.id, label: `${node.name} · ${node.id}` }))}
            onChange={(value) => onChange('answer_ref', value || '')} /> : <Input value={String(data.answer_ref ?? '')}
            placeholder="KNOWLEDGE_ANSWER 节点 ID" disabled={readOnly} onFocus={focus} onBlur={blur} onChange={setText('answer_ref')} />}
        </Field>
        {answerNode?.answerText && <Alert style={{ marginTop: 10, padding: '7px 10px' }} type={answerNode.contentStatus === 'mock' ? 'info' : 'success'}
          showIcon message={answerNode.contentStatus === 'mock' ? '引用答案预览 · 演示内容' : '引用答案预览'}
          description={<Text style={{ fontSize: 11, lineHeight: 1.55 }}>{answerNode.answerText}</Text>} />}
      </>}

      {target && <Field label={target.label} help={target.help}>
        <Input value={String(data[target.field] ?? '')} placeholder={target.placeholder} disabled={readOnly}
          onFocus={focus} onBlur={blur} onChange={setText(target.field)} />
      </Field>}
      {target && Boolean(data.standard_navigation_path) && <Text type="secondary" style={{ display: 'block', fontSize: 11, lineHeight: 1.55, marginTop: 7 }}>
        来源导航（待核实）：{String(data.standard_navigation_path)}
      </Text>}

      {issue && <Alert style={{ marginTop: 12, padding: '6px 9px' }} type="warning" showIcon message={issue} />}
      {!issue && isMock && <Text type="secondary" style={{ display: 'block', fontSize: 11, marginTop: 10 }}>演示内容或 Mock 引用仅供建模展示，运行前需替换或核验。</Text>}

      <Collapse ghost size="small" style={{ marginTop: 8, marginLeft: -8, marginRight: -8 }} items={[{
        key: 'clarification',
        label: <Text strong style={{ fontSize: 12 }}>澄清、补全与兜底</Text>,
        children: <>
          <Field label="意图澄清话术" help="用户表达可对应多个意图时使用。">
            <Input.TextArea rows={2} value={String(data.clarification_prompt ?? '')} placeholder="例如：您是想查询转账记录，还是发起一笔转账？" disabled={readOnly}
              onFocus={focus} onBlur={blur} onChange={setText('clarification_prompt')} />
          </Field>
          <Field label="必需槽位引用" help="填写当前图谱中的 SLOT 节点 ID；槽位自身可配置具体追问。">
            <Select mode={referenceNodes.length ? 'multiple' : 'tags'} showSearch optionFilterProp="label" style={{ width: '100%' }} disabled={readOnly}
              value={Array.isArray(data.required_slot_refs) ? data.required_slot_refs.map(String) : []}
              options={referenceNodes.filter((node) => node.type === 'SLOT').map((node) => ({ value: node.id, label: `${node.name} · ${node.id}` }))}
              placeholder="选择当前图谱中的槽位" onChange={(value) => onChange('required_slot_refs', value)} />
          </Field>
          <Field label="信息补全话术">
            <Input.TextArea rows={2} value={String(data.missing_slot_prompt ?? '')} placeholder="缺少关键条件时如何追问" disabled={readOnly}
              onFocus={focus} onBlur={blur} onChange={setText('missing_slot_prompt')} />
          </Field>
          <Field label="不可用兜底话术">
            <Input.TextArea rows={2} value={String(data.fallback_response ?? '')} placeholder="目标能力不可用时的提示" disabled={readOnly}
              onFocus={focus} onBlur={blur} onChange={setText('fallback_response')} />
          </Field>
        </>,
      }, ...(target && kind !== 'menu' ? [{
        key: 'execution',
        label: <Text strong style={{ fontSize: 12 }}>运行参数与确认</Text>,
        children: <>
          <Field label="输入参数映射" help={'JSON 对象：目标参数名映射到当前图谱的 SLOT 节点 ID。例如 {"accountId":"slot-account"}。'}>
            <Input.TextArea rows={3} value={String(data.input_mapping_json ?? '')} placeholder='{"参数名":"槽位节点 ID"}' disabled={readOnly}
              onFocus={focus} onBlur={blur} onChange={setText('input_mapping_json')} style={{ fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace' }} />
          </Field>
          <Field label="结果呈现模板" help="查询或执行完成后给用户展示的内容模板，由运行端解释变量。">
            <Input.TextArea rows={2} value={String(data.result_template ?? '')} placeholder="例如：查询结果为 {{result}}" disabled={readOnly}
              onFocus={focus} onBlur={blur} onChange={setText('result_template')} />
          </Field>
          <Field label="执行确认策略">
            <Select style={{ width: '100%' }} value={String(data.confirmation_policy || 'none')} disabled={readOnly}
              options={[{ value: 'none', label: '无需额外确认' }, { value: 'before_execute', label: '执行前确认' }]}
              onChange={(value) => onChange('confirmation_policy', value)} />
          </Field>
          {data.confirmation_policy === 'before_execute' && <Field label="执行确认话术">
            <Input.TextArea rows={2} value={String(data.confirmation_prompt ?? '')} placeholder="请用户确认本次操作" disabled={readOnly}
              onFocus={focus} onBlur={blur} onChange={setText('confirmation_prompt')} />
          </Field>}
        </>,
      }] : [])]} />
    </div>
  );
}
