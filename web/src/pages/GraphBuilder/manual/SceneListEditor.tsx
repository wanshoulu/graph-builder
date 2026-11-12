/**
 * V4.1 结构化场景卡片编辑器（intent-graph-v4 的 properties.scenes 字段专用）
 *
 * scenes 在模板中声明为 multiline（JSON 字符串，x6 FIELD_TYPES 约束），
 * 本组件按 key 特判接管渲染：卡片列表 ↔ JSON 字符串双向序列化，贴合 PropertyPanel onFieldChange 流。
 * 校验反馈：服务端 v4-graph-validator 为权威（§11），这里做即时轻量提示（重复 scene_type、别名计数）。
 */
import { useMemo, type ReactNode } from 'react';
import { Alert, Button, Collapse, Empty, Input, Popconfirm, Select, Space, Tag, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';

const { Text } = Typography;

export const SCENE_TYPES = ['ASK', 'QUERY', 'DO', 'CHANGE', 'CANCEL', 'HELP', 'TRANSFER', 'REPAY'];
export const EXECUTION_MODES = ['read-execute', 'confirm-required', 'knowledge-only', 'multi_intent', 'navigation-only', 'unavailable'];
export const ANSWER_TYPES = ['faq', 'rag'];
export const ANSWER_POLICIES = ['direct_answer_or_recommend_entry', 'single_best'];
const KNOWLEDGE_SCENE_TYPES = ['ASK', 'HELP'];
const TASK_SCENE_TYPES = ['QUERY', 'DO', 'CHANGE', 'CANCEL', 'TRANSFER', 'REPAY'];
const DEFAULT_MODE_BY_TYPE: Record<string, string> = {
  QUERY: 'read-execute', DO: 'confirm-required', CHANGE: 'confirm-required',
  CANCEL: 'confirm-required', ASK: 'knowledge-only', HELP: 'knowledge-only',
};

type Scene = Record<string, unknown>;
type Obj = Record<string, unknown>;

function asObj(value: unknown): Obj {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...(value as Obj) } : {};
}

/** 轻量标签列表输入（回车添加，× 删除；ResourceRegistryDrawer 复用） */
export function MiniTags({ value, onChange, onFocusChange, placeholder, readOnly }: {
  value: unknown;
  onChange: (v: string[]) => void;
  onFocusChange: (f: boolean) => void;
  placeholder?: string;
  readOnly?: boolean;
}) {
  const tags: string[] = Array.isArray(value) ? value.map(String) : [];
  return (
    <Space direction="vertical" size={2} style={{ width: '100%' }}>
      {tags.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {tags.map((t, i) => (
            <Tag key={i} closable={!readOnly} onClose={() => onChange(tags.filter((_, j) => j !== i))} style={{ margin: 0 }}>{t}</Tag>
          ))}
        </div>
      )}
      <Input
        size="small"
        disabled={readOnly}
        placeholder={placeholder || '输入后回车添加'}
        onFocus={() => onFocusChange(true)}
        onBlur={() => onFocusChange(false)}
        onPressEnter={(e) => {
          const v = (e.target as HTMLInputElement).value.trim();
          if (v && tags.indexOf(v) < 0) { onChange([...tags, v]); (e.target as HTMLInputElement).value = ''; }
        }}
      />
    </Space>
  );
}

function Field({ label, required, children, hint }: { label: string; required?: boolean; children: ReactNode; hint?: string }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ marginBottom: 2 }}>
        <Text style={{ fontSize: 12 }}>{label}{required ? <span style={{ color: '#f53f3f' }}> *</span> : null}</Text>
        {hint ? <Text type="secondary" style={{ fontSize: 11, marginLeft: 6 }}>{hint}</Text> : null}
      </div>
      {children}
    </div>
  );
}

/** JSON 文本字段（失焦时尝试反序列化；非法 JSON 保留原文并标红提示） */
function JsonField({ label, value, onChange, onFocusChange, rows }: {
  label: string;
  value: unknown;
  onChange: (v: unknown) => void;
  onFocusChange: (f: boolean) => void;
  rows?: number;
}) {
  const text = value === undefined || value === null || value === '' ? '' : (typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  return (
    <Field label={label}>
      <Input.TextArea
        rows={rows || 4}
        value={text}
        style={{ fontSize: 11, fontFamily: 'Consolas, monospace' }}
        onFocus={() => onFocusChange(true)}
        onBlur={() => onFocusChange(false)}
        onChange={(e) => onChange(e.target.value)}
        placeholder='{"slots": [], "clarificationOrder": []}'
        status={text.trim() && (() => { try { JSON.parse(text); return undefined; } catch { return 'error'; } })()}
      />
    </Field>
  );
}

/** 序列化前清洗：空字符串/空数组字段不输出，保持文件干净 */
function cleanScene(scene: Scene): Scene {
  const out: Scene = {};
  Object.keys(scene).forEach((k) => {
    const v = scene[k];
    if (v === undefined || v === null || v === '') return;
    if (typeof v === 'object' && !Array.isArray(v)) {
      const nested = cleanScene(asObj(v));
      if (Object.keys(nested).length > 0) out[k] = nested;
      return;
    }
    if (Array.isArray(v) && v.length === 0) return;
    out[k] = v;
  });
  return out;
}

function SceneCard({ scene, index, dupType, readOnly, onFocusChange, onPatch, onDelete }: {
  scene: Scene;
  index: number;
  dupType: boolean;
  readOnly?: boolean;
  onFocusChange: (f: boolean) => void;
  onPatch: (patch: Scene) => void;
  onDelete: () => void;
}) {
  const sceneType = String(scene.scene_type || '');
  const sem = asObj(scene.semantic_definition);
  const retrieval = asObj(scene.retrieval_profile);
  const task = asObj(scene.task_binding);
  const knowledge = asObj(scene.knowledge_binding);
  const execution = asObj(scene.execution_binding);
  const bindings = asObj(scene.bindings);
  const isKnowledge = KNOWLEDGE_SCENE_TYPES.indexOf(sceneType) >= 0;
  const isTask = TASK_SCENE_TYPES.indexOf(sceneType) >= 0;

  const patchSem = (patch: Obj) => onPatch({ semantic_definition: { ...sem, ...patch } });
  const patchRetrieval = (patch: Obj) => onPatch({ retrieval_profile: { ...retrieval, ...patch } });
  const patchExecution = (patch: Obj) => onPatch({ execution_binding: { ...execution, ...patch } });

  const aliases = Array.isArray(retrieval.aliases) ? retrieval.aliases as string[] : [];
  const advancedPayload: Obj = {};
  if (task.slotContract !== undefined) advancedPayload.slotContract = task.slotContract;
  if (task.skillBinding !== undefined) advancedPayload.skillBinding = task.skillBinding;
  if (scene.decision_policy !== undefined) advancedPayload.decision_policy = scene.decision_policy;
  if (retrieval.viewWeights !== undefined) advancedPayload.viewWeights = retrieval.viewWeights;
  if (retrieval.recallTermSets !== undefined) advancedPayload.recallTermSets = retrieval.recallTermSets;

  return (
    <Collapse
      size="small"
      style={{ marginBottom: 8 }}
      className="v4-scene-card"
      items={[{
        key: String(index),
        label: (
          <Space size={6} wrap>
            <Tag color={isKnowledge ? 'purple' : isTask ? 'blue' : 'default'} style={{ marginRight: 0 }}>{sceneType || '未设类型'}</Tag>
            <Text style={{ fontSize: 12 }}>{String(sem.description || '').slice(0, 24) || '（未填描述）'}</Text>
            <Tag style={{ marginRight: 0 }} color={aliases.length >= 3 ? 'green' : 'red'}>{aliases.length} 别名</Tag>
            {dupType && <Tag color="red">重复 scene_type</Tag>}
          </Space>
        ),
        extra: readOnly ? undefined : (
          <Popconfirm title="删除该场景？" onConfirm={(e) => { e?.stopPropagation(); onDelete(); }} okText="删除" cancelText="取消">
            <Button size="small" danger type="text" icon={<DeleteOutlined />} onClick={(e) => e.stopPropagation()} />
          </Popconfirm>
        ),
        children: (
          <div>
            <Space size={8} wrap style={{ marginBottom: 8 }}>
              <Field label="scene_type" required hint={isKnowledge ? '问答场景' : isTask ? '任务场景' : undefined}>
                <Select
                  size="small" style={{ width: 140 }} disabled={readOnly}
                  value={sceneType || undefined}
                  placeholder="选择场景类型"
                  options={SCENE_TYPES.map((t) => ({ value: t, label: t }))}
                  onChange={(v) => {
                    const next: Scene = { ...scene, scene_type: v };
                    const semNext = { ...sem, intentType: v };
                    // 切类型时补默认执行模式；问答/任务互斥块清理
                    if (!next.execution_binding || !asObj(next.execution_binding).executionMode) {
                      next.execution_binding = { ...execution, executionMode: DEFAULT_MODE_BY_TYPE[String(v)] || 'read-execute' };
                    }
                    if (KNOWLEDGE_SCENE_TYPES.indexOf(String(v)) >= 0) {
                      delete next.task_binding;
                      next.bindings = { ...bindings, capabilities: [] };
                    }
                    if (TASK_SCENE_TYPES.indexOf(String(v)) >= 0) delete next.knowledge_binding;
                    onPatch({ ...next, semantic_definition: semNext });
                  }}
                />
              </Field>
              <Field label="executionMode" hint="默认由类型推导">
                <Select
                  size="small" style={{ width: 150 }} disabled={readOnly}
                  value={execution.executionMode ? String(execution.executionMode) : undefined}
                  placeholder="执行模式"
                  options={EXECUTION_MODES.map((m) => ({ value: m, label: m }))}
                  onChange={(v) => patchExecution({ executionMode: v })}
                />
              </Field>
              <Field label="readiness">
                <Select
                  size="small" style={{ width: 110 }} disabled={readOnly} allowClear
                  value={execution.readiness ? String(execution.readiness) : undefined}
                  placeholder="就绪状态"
                  options={[{ value: 'ready', label: 'ready' }, { value: 'planned', label: 'planned' }]}
                  onChange={(v) => patchExecution({ readiness: v || '' })}
                />
              </Field>
            </Space>
            <Field label="userGoal（用户目标）">
              <Input size="small" disabled={readOnly} value={String(sem.userGoal || '')}
                onFocus={() => onFocusChange(true)} onBlur={() => onFocusChange(false)}
                onChange={(e) => patchSem({ userGoal: e.target.value })} placeholder="一句话：用户想达成什么" />
            </Field>
            <Field label="description（场景描述）" required hint="≥8 字，全图唯一">
              <Input.TextArea rows={2} disabled={readOnly} value={String(sem.description || '')}
                onFocus={() => onFocusChange(true)} onBlur={() => onFocusChange(false)}
                onChange={(e) => patchSem({ description: e.target.value })}
                style={{ fontSize: 12 }} />
            </Field>
            <Field label="aliases（场景别名）" required hint={`${aliases.length}/≥3 条，全图唯一`}>
              <MiniTags value={aliases} onFocusChange={onFocusChange} readOnly={readOnly}
                onChange={(v) => patchRetrieval({ aliases: v })} placeholder="本场景的用户说法，回车添加" />
            </Field>
            <Field label="recallTerms（召回词）">
              <MiniTags value={retrieval.recallTerms} onFocusChange={onFocusChange} readOnly={readOnly}
                onChange={(v) => patchRetrieval({ recallTerms: v })} placeholder="单个关键词，子串命中" />
            </Field>
            <Field label="negativeExamples（负例）" hint="建议 ≥2，同功能其他场景说法互配">
              <MiniTags value={retrieval.negativeExamples} onFocusChange={onFocusChange} readOnly={readOnly}
                onChange={(v) => patchRetrieval({ negativeExamples: v })} placeholder="长得像但不该命中的话" />
            </Field>
            <Field label="confusableIntents（易混场景）" hint="节点id#场景 记法">
              <MiniTags value={sem.confusableIntents} onFocusChange={onFocusChange} readOnly={readOnly}
                onChange={(v) => patchSem({ confusableIntents: v })} placeholder="如 ccb.wealth.fund.trade#QUERY" />
            </Field>
            <Field label="disambiguationHints（消歧提示）">
              <MiniTags value={sem.disambiguationHints} onFocusChange={onFocusChange} readOnly={readOnly}
                onChange={(v) => patchSem({ disambiguationHints: v })} placeholder="每条一句话，给裁判模型" />
            </Field>
            {isKnowledge && (
              <>
                <Field label="knowledge_binding.answerRefs" required hint="FAQ 唯一引用源">
                  <MiniTags value={knowledge.answerRefs} onFocusChange={onFocusChange} readOnly={readOnly}
                    onChange={(v) => onPatch({ knowledge_binding: { ...knowledge, answerRefs: v } })} placeholder="faq.xxx，回车添加" />
                </Field>
                <Space size={8} wrap>
                  <Field label="answerType">
                    <Select size="small" style={{ width: 90 }} disabled={readOnly} allowClear
                      value={knowledge.answerType ? String(knowledge.answerType) : undefined}
                      options={ANSWER_TYPES.map((t) => ({ value: t, label: t }))}
                      onChange={(v) => onPatch({ knowledge_binding: { ...knowledge, answerType: v || '' } })} />
                  </Field>
                  <Field label="answerPolicy">
                    <Select size="small" style={{ width: 240 }} disabled={readOnly} allowClear
                      value={knowledge.answerPolicy ? String(knowledge.answerPolicy) : undefined}
                      options={ANSWER_POLICIES.map((t) => ({ value: t, label: t }))}
                      onChange={(v) => onPatch({ knowledge_binding: { ...knowledge, answerPolicy: v || '' } })} />
                  </Field>
                </Space>
              </>
            )}
            {isTask && (
              <>
                <Space size={8} wrap>
                  <Field label="actionCode" required hint="小写，不可与 scene_type 混用">
                    <Input size="small" style={{ width: 110 }} disabled={readOnly} value={String(task.actionCode || '')}
                      onFocus={() => onFocusChange(true)} onBlur={() => onFocusChange(false)}
                      onChange={(e) => onPatch({ task_binding: { ...task, actionCode: e.target.value.toLowerCase() } })} placeholder="query/apply…" />
                  </Field>
                  <Field label="apiOrWorkflowId">
                    <Input size="small" style={{ width: 200 }} disabled={readOnly} value={String(execution.apiOrWorkflowId || '')}
                      onFocus={() => onFocusChange(true)} onBlur={() => onFocusChange(false)}
                      onChange={(e) => patchExecution({ apiOrWorkflowId: e.target.value })} placeholder="须在能力表可解析" />
                  </Field>
                </Space>
                <Field label="bindings.capabilities（能力引用）" required hint="须在资源注册表可解析">
                  <MiniTags value={bindings.capabilities} onFocusChange={onFocusChange} readOnly={readOnly}
                    onChange={(v) => onPatch({ bindings: { ...bindings, capabilities: v } })} placeholder="capability id，回车添加" />
                </Field>
                <Field label="bindings.policies（策略引用）">
                  <MiniTags value={bindings.policies} onFocusChange={onFocusChange} readOnly={readOnly}
                    onChange={(v) => onPatch({ bindings: { ...bindings, policies: v } })} placeholder="policy id" />
                </Field>
              </>
            )}
            <Collapse
              size="small" ghost
              items={[{
                key: 'adv',
                label: <Text type="secondary" style={{ fontSize: 11 }}>高级：slotContract / skillBinding / 策略块 / 视图权重</Text>,
                children: (
                  <div>
                    <JsonField label="task_binding.slotContract（槽位契约）" value={advancedPayload.slotContract} rows={6}
                      onFocusChange={onFocusChange}
                      onChange={(v) => {
                        let parsed: unknown = v;
                        try { parsed = JSON.parse(String(v)); } catch { /* 保留原文，服务端校验报错 */ }
                        onPatch({ task_binding: { ...task, slotContract: parsed } });
                      }} />
                    <JsonField label="task_binding.skillBinding（技能绑定）" value={advancedPayload.skillBinding} rows={3}
                      onFocusChange={onFocusChange}
                      onChange={(v) => {
                        let parsed: unknown = v;
                        try { parsed = JSON.parse(String(v)); } catch { /* 保留原文 */ }
                        onPatch({ task_binding: { ...task, skillBinding: parsed } });
                      }} />
                    <JsonField label="decision_policy（策略块）" value={advancedPayload.decision_policy} rows={3}
                      onFocusChange={onFocusChange}
                      onChange={(v) => {
                        let parsed: unknown = v;
                        try { parsed = JSON.parse(String(v)); } catch { /* 保留原文 */ }
                        onPatch({ decision_policy: parsed });
                      }} />
                    <JsonField label="retrieval_profile.viewWeights（视图权重）" value={advancedPayload.viewWeights} rows={3}
                      onFocusChange={onFocusChange}
                      onChange={(v) => {
                        let parsed: unknown = v;
                        try { parsed = JSON.parse(String(v)); } catch { /* 保留原文 */ }
                        patchRetrieval({ viewWeights: parsed });
                      }} />
                    <JsonField label="retrieval_profile.recallTermSets（词组）" value={advancedPayload.recallTermSets} rows={3}
                      onFocusChange={onFocusChange}
                      onChange={(v) => {
                        let parsed: unknown = v;
                        try { parsed = JSON.parse(String(v)); } catch { /* 保留原文 */ }
                        patchRetrieval({ recallTermSets: parsed });
                      }} />
                  </div>
                ),
              }]}
            />
          </div>
        ),
      }]}
    />
  );
}

export interface SceneListEditorProps {
  value: unknown;
  onChange: (v: string) => void;
  onFocusChange: (f: boolean) => void;
  readOnly?: boolean;
}

/** scenes JSON 字符串 ↔ 场景卡列表 */
export function SceneListEditor({ value, onChange, onFocusChange, readOnly }: SceneListEditorProps) {
  const { scenes, parseError } = useMemo(() => {
    const raw = String(value ?? '').trim();
    if (!raw) return { scenes: [] as Scene[], parseError: '' };
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return { scenes: [], parseError: 'scenes 必须是 JSON 数组' };
      return { scenes: parsed as Scene[], parseError: '' };
    } catch (e) {
      return { scenes: [], parseError: 'JSON 解析失败：' + (e instanceof Error ? e.message : String(e)) };
    }
  }, [value]);

  const writeScenes = (next: Scene[]) => {
    onChange(JSON.stringify(next.map(cleanScene)));
  };

  const patchScene = (i: number, patch: Scene) => {
    const next = scenes.map((s, j) => (j === i ? { ...s, ...patch } : s));
    writeScenes(next);
  };

  const typeCounts = new Map<string, number>();
  scenes.forEach((s) => {
    const t = String(s.scene_type || '');
    typeCounts.set(t, (typeCounts.get(t) || 0) + 1);
  });

  if (parseError) {
    return (
      <div>
        <Alert type="error" showIcon message="场景 JSON 无法解析" description={<Text style={{ fontSize: 11 }}>{parseError}（服务端校验也会拦截；可在此直接修正原文）</Text>} />
        <Input.TextArea rows={6} value={String(value ?? '')} disabled={readOnly}
          onFocus={() => onFocusChange(true)} onBlur={() => onFocusChange(false)}
          onChange={(e) => onChange(e.target.value)} style={{ fontSize: 11, fontFamily: 'Consolas, monospace', marginTop: 8 }} />
      </div>
    );
  }

  return (
    <div>
      {scenes.length === 0 && (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<Text type="secondary" style={{ fontSize: 12 }}>尚无场景：查询/办理/问答意图以场景声明在功能节点上（schema 文档 8.2）</Text>} />
      )}
      {scenes.map((scene, i) => (
        <SceneCard
          key={i}
          scene={scene}
          index={i}
          dupType={typeCounts.get(String(scene.scene_type || ''))! > 1}
          readOnly={readOnly}
          onFocusChange={onFocusChange}
          onPatch={(patch) => patchScene(i, patch)}
          onDelete={() => writeScenes(scenes.filter((_, j) => j !== i))}
        />
      ))}
      {!readOnly && (
        <Button
          size="small" type="dashed" block icon={<PlusOutlined />}
          onClick={() => writeScenes([...scenes, {
            scene_type: 'QUERY',
            semantic_definition: { intentType: 'QUERY', description: '' },
            retrieval_profile: { aliases: [] },
            execution_binding: { executionMode: 'read-execute' },
          }])}
        >
          添加场景
        </Button>
      )}
    </div>
  );
}
