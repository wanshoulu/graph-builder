/**
 * V4.1 资源注册表抽屉（intent-graph-v4 专用）：capabilities / faqs / policies / skillBindings 四表 CRUD。
 *
 * 数据存 document.metadata.v4ResourceRegistries（资源不入图，schema 文档 §10）；
 * 变更后由调用方触发既有校验链路（悬空引用 = 校验第 9 条）。
 */
import { useEffect, useMemo, type ReactNode } from 'react';
import { Button, Collapse, Drawer, Input, Popconfirm, Select, Space, Tabs, Tag, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { MiniTags } from '../manual/SceneListEditor';
import { V4_CAPABILITY_KINDS } from '../lib/intentGraphV4';

const { Text } = Typography;

type Obj = Record<string, unknown>;
export interface V4Registries {
  capabilities: Obj[];
  faqs: Obj[];
  policies: Obj[];
  skillBindings: Obj[];
}

const RISK_LEVELS = ['L0', 'L1', 'L2', 'L3'];

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div style={{ marginBottom: 6 }}>
      <Text style={{ fontSize: 11, display: 'block', marginBottom: 2 }}>
        {label}{hint ? <Text type="secondary" style={{ fontSize: 10, marginLeft: 4 }}>{hint}</Text> : null}
      </Text>
      {children}
    </div>
  );
}

interface EntryEditorProps {
  entry: Obj;
  readOnly?: boolean;
  onFocusChange: (f: boolean) => void;
  onPatch: (patch: Obj) => void;
}

function CapabilitiesEntry({ entry, readOnly, onFocusChange, onPatch }: EntryEditorProps) {
  const providerText = entry.provider === undefined || entry.provider === null ? '' : (typeof entry.provider === 'string' ? entry.provider : JSON.stringify(entry.provider, null, 2));
  return (
    <div>
      <Space size={8} wrap>
        <Field label="id" hint="引用键，全表唯一"><Input size="small" style={{ width: 220 }} disabled={readOnly} value={String(entry.id || '')} onFocus={() => onFocusChange(true)} onBlur={() => onFocusChange(false)} onChange={(e) => onPatch({ id: e.target.value })} placeholder="ccb.fund.subscription.query" /></Field>
        <Field label="title"><Input size="small" style={{ width: 160 }} disabled={readOnly} value={String(entry.title || '')} onFocus={() => onFocusChange(true)} onBlur={() => onFocusChange(false)} onChange={(e) => onPatch({ title: e.target.value })} /></Field>
        <Field label="kind">
          <Select size="small" style={{ width: 120 }} disabled={readOnly} value={entry.kind ? String(entry.kind) : undefined} placeholder="载体"
            options={V4_CAPABILITY_KINDS.map((k) => ({ value: k, label: k }))}
            onChange={(v) => onPatch({ kind: v })} />
        </Field>
        <Field label="riskLevel">
          <Select size="small" style={{ width: 76 }} disabled={readOnly} value={entry.riskLevel ? String(entry.riskLevel) : undefined} placeholder="L?"
            options={RISK_LEVELS.map((k) => ({ value: k, label: k }))}
            onChange={(v) => onPatch({ riskLevel: v })} />
        </Field>
        <Field label="writeOperation">
          <Select size="small" style={{ width: 86 }} disabled={readOnly} value={typeof entry.writeOperation === 'boolean' ? String(entry.writeOperation) : undefined} placeholder="bool"
            options={[{ value: 'true', label: 'true' }, { value: 'false', label: 'false' }]}
            onChange={(v) => onPatch({ writeOperation: v === 'true' })} />
        </Field>
        <Field label="exposure">
          <Select size="small" style={{ width: 150 }} disabled={readOnly} value={entry.exposure ? String(entry.exposure) : undefined} placeholder="暴露面"
            options={[{ value: 'model-callable', label: 'model-callable' }, { value: 'internal', label: 'internal' }]}
            onChange={(v) => onPatch({ exposure: v })} />
        </Field>
      </Space>
      <Field label="schemaDigest" hint="model-callable 必填（契约 sha256）">
        <Input size="small" disabled={readOnly} value={String(entry.schemaDigest || '')} onFocus={() => onFocusChange(true)} onBlur={() => onFocusChange(false)} onChange={(e) => onPatch({ schemaDigest: e.target.value })} placeholder="sha256:…" />
      </Field>
      <Field label="provider" hint="按 kind：mcp-tool→protocol/serverId/toolName；skill→entry；workflow→workflowId；agent→agentId/endpoint；menu-nav→route">
        <Input.TextArea rows={3} disabled={readOnly} value={providerText} style={{ fontSize: 11, fontFamily: 'Consolas, monospace' }}
          onFocus={() => onFocusChange(true)} onBlur={() => onFocusChange(false)}
          onChange={(e) => {
            let parsed: unknown = e.target.value;
            try { parsed = JSON.parse(e.target.value); } catch { /* 保留原文 */ }
            onPatch({ provider: parsed });
          }} />
      </Field>
    </div>
  );
}

function FaqEntry({ entry, readOnly, onFocusChange, onPatch }: EntryEditorProps) {
  return (
    <div>
      <Space size={8} wrap>
        <Field label="id" hint="knowledge_binding.answerRefs 引用键"><Input size="small" style={{ width: 220 }} disabled={readOnly} value={String(entry.id || '')} onFocus={() => onFocusChange(true)} onBlur={() => onFocusChange(false)} onChange={(e) => onPatch({ id: e.target.value })} placeholder="faq.fund.subscription.rule" /></Field>
        <Field label="updatedAt"><Input size="small" style={{ width: 120 }} disabled={readOnly} value={String(entry.updatedAt || '')} onFocus={() => onFocusChange(true)} onBlur={() => onFocusChange(false)} onChange={(e) => onPatch({ updatedAt: e.target.value })} placeholder="2026-09-26" /></Field>
      </Space>
      <Field label="question"><Input size="small" disabled={readOnly} value={String(entry.question || '')} onFocus={() => onFocusChange(true)} onBlur={() => onFocusChange(false)} onChange={(e) => onPatch({ question: e.target.value })} /></Field>
      <Field label="answer"><Input.TextArea rows={3} disabled={readOnly} value={String(entry.answer || '')} style={{ fontSize: 12 }} onFocus={() => onFocusChange(true)} onBlur={() => onFocusChange(false)} onChange={(e) => onPatch({ answer: e.target.value })} /></Field>
    </div>
  );
}

function PolicyEntry({ entry, readOnly, onFocusChange, onPatch }: EntryEditorProps) {
  return (
    <div>
      <Space size={8} wrap>
        <Field label="id"><Input size="small" style={{ width: 220 }} disabled={readOnly} value={String(entry.id || '')} onFocus={() => onFocusChange(true)} onBlur={() => onFocusChange(false)} onChange={(e) => onPatch({ id: e.target.value })} placeholder="pol.investment.risk-survey" /></Field>
        <Field label="title"><Input size="small" style={{ width: 200 }} disabled={readOnly} value={String(entry.title || '')} onFocus={() => onFocusChange(true)} onBlur={() => onFocusChange(false)} onChange={(e) => onPatch({ title: e.target.value })} /></Field>
      </Space>
      <Field label="rules（规则条目）">
        <MiniTags value={entry.rules} onFocusChange={onFocusChange} readOnly={readOnly} onChange={(v) => onPatch({ rules: v })} placeholder="给执行前校验用的规则，回车添加" />
      </Field>
    </div>
  );
}

function SkillBindingEntry({ entry, readOnly, onFocusChange, onPatch }: EntryEditorProps) {
  return (
    <Space size={8} wrap>
      <Field label="skillId" hint="task_binding.skillBinding.skillId 引用键，全表唯一"><Input size="small" style={{ width: 220 }} disabled={readOnly} value={String(entry.skillId || '')} onFocus={() => onFocusChange(true)} onBlur={() => onFocusChange(false)} onChange={(e) => onPatch({ skillId: e.target.value })} placeholder="skill.fund-subscription" /></Field>
      <Field label="title"><Input size="small" style={{ width: 160 }} disabled={readOnly} value={String(entry.title || '')} onFocus={() => onFocusChange(true)} onBlur={() => onFocusChange(false)} onChange={(e) => onPatch({ title: e.target.value })} /></Field>
      <Field label="version"><Input size="small" style={{ width: 100 }} disabled={readOnly} value={String(entry.version || '')} onFocus={() => onFocusChange(true)} onBlur={() => onFocusChange(false)} onChange={(e) => onPatch({ version: e.target.value })} /></Field>
      <Field label="digest"><Input size="small" style={{ width: 200 }} disabled={readOnly} value={String(entry.digest || '')} onFocus={() => onFocusChange(true)} onBlur={() => onFocusChange(false)} onChange={(e) => onPatch({ digest: e.target.value })} placeholder="sha256:…" /></Field>
      <Field label="entry"><Input size="small" style={{ width: 220 }} disabled={readOnly} value={String(entry.entry || '')} onFocus={() => onFocusChange(true)} onBlur={() => onFocusChange(false)} onChange={(e) => onPatch({ entry: e.target.value })} placeholder="skill://fund-subscription" /></Field>
    </Space>
  );
}

export interface ResourceRegistryDrawerProps {
  open: boolean;
  onClose: () => void;
  registries: V4Registries | null;
  readOnly?: boolean;
  onFocusChange?: (f: boolean) => void;
  onChange: (next: V4Registries) => void;
}

const TABLES: { key: keyof V4Registries; label: string; emptyHint: string }[] = [
  { key: 'capabilities', label: '能力 capabilities', emptyHint: '菜单直达/MCP 工具/技能/工作流/智能体统一登记' },
  { key: 'faqs', label: '问答 faqs', emptyHint: 'ASK/HELP 场景 knowledge_binding.answerRefs 引用' },
  { key: 'policies', label: '策略 policies', emptyHint: '风控约束（执行前校验）' },
  { key: 'skillBindings', label: '技能绑定 skillBindings', emptyHint: 'V4.1 域路由用技能元数据' },
];

export function ResourceRegistryDrawer({ open, onClose, registries, readOnly, onFocusChange, onChange }: ResourceRegistryDrawerProps) {
  const safe = useMemo<V4Registries>(() => registries || { capabilities: [], faqs: [], policies: [], skillBindings: [] }, [registries]);
  const focus = onFocusChange || (() => undefined);

  useEffect(() => { if (!open) focus(false); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const renderTable = (key: keyof V4Registries) => {
    const rows = safe[key];
    const EntryComp = key === 'capabilities' ? CapabilitiesEntry : key === 'faqs' ? FaqEntry : key === 'policies' ? PolicyEntry : SkillBindingEntry;
    const idOf = (r: Obj) => String(r.id || r.skillId || '');
    const idKey = key === 'skillBindings' ? 'skillId' : 'id';
    const blank: Obj = key === 'capabilities'
      ? { id: '', title: '', kind: 'mcp-tool', riskLevel: 'L1', writeOperation: false, exposure: 'model-callable', provider: { protocol: 'mcp', serverId: '', toolName: '' } }
      : key === 'faqs' ? { id: '', question: '', answer: '' }
      : key === 'policies' ? { id: '', title: '', rules: [] }
      : { skillId: '', title: '', version: '', digest: '', entry: '' };
    return (
      <div>
        {rows.length === 0 && <Text type="secondary" style={{ fontSize: 12 }}>暂无条目：{TABLES.find((t) => t.key === key)?.emptyHint}</Text>}
        <Collapse
          size="small"
          items={rows.map((entry, i) => ({
            key: String(i),
            label: (
              <Space size={6}>
                <Tag style={{ marginRight: 0 }}>{String(entry.kind || (key === 'faqs' ? 'faq' : key === 'policies' ? 'policy' : 'skill'))}</Tag>
                <Text style={{ fontSize: 12 }}>{idOf(entry) || <Text type="secondary">（未填 id）</Text>}</Text>
              </Space>
            ),
            extra: readOnly ? undefined : (
              <Popconfirm title="删除该条目？" onConfirm={(e) => { e?.stopPropagation(); onChange({ ...safe, [key]: rows.filter((_, j) => j !== i) }); }} okText="删除" cancelText="取消">
                <Button size="small" danger type="text" icon={<DeleteOutlined />} onClick={(e) => e.stopPropagation()} />
              </Popconfirm>
            ),
            children: (
              <EntryComp
                entry={entry}
                readOnly={readOnly}
                onFocusChange={focus}
                onPatch={(patch) => onChange({ ...safe, [key]: rows.map((r, j) => (j === i ? { ...r, ...patch } : r)) })}
              />
            ),
          }))}
        />
        {!readOnly && (
          <Button size="small" type="dashed" block icon={<PlusOutlined />}
            onClick={() => onChange({ ...safe, [key]: [...rows, { ...blank, [idKey]: '' }] })}>
            添加{TABLES.find((t) => t.key === key)?.label}
          </Button>
        )}
      </div>
    );
  };

  return (
    <Drawer
      title="资源注册表（不入图，存文档 metadata）"
      open={open}
      onClose={onClose}
      width={640}
      destroyOnClose={false}
    >
      <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 12 }}>
        场景 bindings.capabilities / policies、knowledge_binding.answerRefs、task_binding.skillBinding.skillId 引用的资源在这里登记；
        每个引用 id 必须可解析（校验第 9 条，禁止发布悬空引用）。
      </Text>
      <Tabs
        size="small"
        items={TABLES.map((t) => ({
          key: t.key,
          label: `${t.label} ${safe[t.key].length > 0 ? `(${safe[t.key].length})` : ''}`,
          children: renderTable(t.key),
        }))}
      />
    </Drawer>
  );
}
