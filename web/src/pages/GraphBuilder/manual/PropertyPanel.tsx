/**
 * Schema 驱动属性面板（antd）：按选中元素类型过滤分组/字段
 *
 * 数据结构：选中元素 = 画布节点/边（data 平铺字段）。
 * 编辑即更新画布元素 data；必填校验（collectMissingRequired 思路）在保存/发布前执行。
 * ID 只读（改 id 需联动所有边引用，v1 不做）。
 */
import { useEffect, useMemo, useState } from 'react';
import { Button, Collapse, Empty, Input, InputNumber, Select, Space, Tag, Tooltip, Typography } from 'antd';
import { CheckOutlined, CloseOutlined, DeleteOutlined, RobotOutlined, BulbOutlined } from '@ant-design/icons';
import { blockAppliesTo, type EditorBlock, type EditorSchema } from '../lib/templateSchema';
import { FULFILLMENT_FIELDS, IntentFulfillmentEditor } from './IntentFulfillmentEditor';
import { SceneListEditor } from './SceneListEditor';
import type { NodeReviewItem } from '@/api/orgGraph';

const { Text } = Typography;

export interface SelectedElement {
  kind: 'node' | 'edge';
  id: string;
  data: Record<string, unknown>;
}

interface PropertyPanelProps {
  selected: SelectedElement | null;
  schema: EditorSchema | null;
  referenceNodes?: { id: string; type: string; name: string; answerText?: string; contentStatus?: string }[];
  /** 只读展示模式：输入全部禁用、删除按钮隐藏（展示视图用） */
  readOnly?: boolean;
  /** 输入聚焦状态（画布 Backspace/Delete 删除快捷键禁用开关） */
  onEditingInFieldChange: (editing: boolean) => void;
  onFieldChange: (field: string, value: unknown) => void;
  onDelete: () => void;
  /** AI 补全项采纳/拒绝回调 */
  onAiAction?: (field: string, index: number, action: 'accept' | 'reject') => void;
  /** AI 辅助审核编辑（仅 AGGREGATE_INTENT 节点显示，打开整组审核抽屉） */
  onAiAssist?: () => void;
  /** 逐字段 AI 审核：触发对当前选中元素指定分组的字段级审核 */
  onNodeReview?: (groupKey: string, fieldKeys: string[]) => void;
  /** 正在审核的分组 key 集合 */
  nodeReviewRunningGroups?: Set<string>;
  /** 当前选中元素的分组审核建议（按 groupKey → items 索引） */
  reviewItems?: Record<string, NodeReviewItem[]>;
  /** 字段审核建议决策：accept=采纳新值写入字段，ignore=忽略 */
  onDecideReview?: (itemId: string, decision: 'accept' | 'ignore') => void;
}

/** 标签列表输入（回车添加，× 删除；只读时仅展示标签；AI 补充项带徽标可采纳/拒绝） */
function TagsInput({ value, onChange, onFocusChange, readOnly, aiIndices, onAiAction, fieldKey }: {
  value: unknown;
  onChange: (v: string[]) => void;
  onFocusChange: (f: boolean) => void;
  readOnly?: boolean;
  aiIndices?: Set<number>;
  onAiAction?: (field: string, index: number, action: 'accept' | 'reject') => void;
  fieldKey?: string;
}) {
  const tags: string[] = Array.isArray(value) ? value.map(String) : [];
  return (
    <Space direction="vertical" size={4} style={{ width: '100%' }}>
      {tags.map((t, i) => {
        const isAi = aiIndices?.has(i);
        return (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <Tag
              closable={!readOnly}
              onClose={() => onChange(tags.filter((_, j) => j !== i))}
              style={{ marginRight: 0, flex: 1, background: isAi ? '#f0f5ff' : undefined, borderColor: isAi ? '#adc6ff' : undefined }}
            >
              {t}
            </Tag>
            {isAi && !readOnly && onAiAction && fieldKey && (
              <Space size={2}>
                <Tooltip title="采纳（移除 AI 标记，保留内容）">
                  <Button size="small" type="primary" ghost icon={<CheckOutlined />} style={{ minWidth: 24, width: 24, height: 24, padding: 0 }} onClick={() => onAiAction(fieldKey, i, 'accept')} />
                </Tooltip>
                <Tooltip title="拒绝（删除此条）">
                  <Button size="small" danger ghost icon={<CloseOutlined />} style={{ minWidth: 24, width: 24, height: 24, padding: 0 }} onClick={() => onAiAction(fieldKey, i, 'reject')} />
                </Tooltip>
              </Space>
            )}
            {isAi && readOnly && (
              <Tag color="blue" style={{ margin: 0, fontSize: 10, lineHeight: '16px', padding: '0 4px' }}><RobotOutlined /> AI</Tag>
            )}
          </div>
        );
      })}
      {!readOnly && (
        <Input
          size="small"
          placeholder="输入后回车添加"
          onFocus={() => onFocusChange(true)}
          onBlur={() => onFocusChange(false)}
          onPressEnter={(e) => {
            const v = (e.target as HTMLInputElement).value.trim();
            if (v) { onChange([...tags, v]); (e.target as HTMLInputElement).value = ''; }
          }}
        />
      )}
    </Space>
  );
}

function BlockField({ block, value, editing, onChange, readOnly, aiIndices, onAiAction }: {
  block: EditorBlock;
  value: unknown;
  editing: (f: boolean) => void;
  onChange: (v: unknown) => void;
  readOnly?: boolean;
  aiIndices?: Set<number>;
  onAiAction?: (field: string, index: number, action: 'accept' | 'reject') => void;
}) {
  const label = (
    <span>
      {block.label.split(' ')[0]}
      {block.required && <span style={{ color: '#f53f3f' }}> *</span>}
    </span>
  );
  switch (block.type) {
    case 'scenes':
      return (
        <div style={{ marginBottom: 8 }}>
          <Text style={{ fontSize: 12 }}>{label}</Text>
          <SceneListEditor value={value} onFocusChange={editing} readOnly={readOnly} onChange={(v) => onChange(v)} />
        </div>
      );
    case 'textarea':
      return (
        <div style={{ marginBottom: 8 }}>
          <Text style={{ fontSize: 12 }}>{label}</Text>
          <Input.TextArea rows={2} value={String(value ?? '')} disabled={readOnly} onFocus={() => editing(true)} onBlur={() => editing(false)}
            onChange={(e) => onChange(e.target.value)} style={{ fontSize: 12 }} />
        </div>
      );
    case 'tags':
      return (
        <div style={{ marginBottom: 8 }}>
          <Text style={{ fontSize: 12 }}>{label}</Text>
          <TagsInput value={value} onFocusChange={editing} onChange={onChange} readOnly={readOnly} aiIndices={aiIndices} onAiAction={onAiAction} fieldKey={block.key} />
        </div>
      );
    case 'number':
      return (
        <div style={{ marginBottom: 8 }}>
          <Text style={{ fontSize: 12 }}>{label}</Text>
          <InputNumber size="small" style={{ width: '100%' }} disabled={readOnly} value={typeof value === 'number' ? value : undefined}
            onFocus={() => editing(true)} onBlur={() => editing(false)}
            onChange={(v) => onChange(v === null || v === undefined ? undefined : Number(v))} />
        </div>
      );
    case 'date':
      return (
        <div style={{ marginBottom: 8 }}>
          <Text style={{ fontSize: 12 }}>{label}</Text>
          <Input size="small" type="date" value={String(value ?? '')} disabled={readOnly} onFocus={() => editing(true)} onBlur={() => editing(false)}
            onChange={(e) => onChange(e.target.value)} style={{ fontSize: 12 }} />
        </div>
      );
    case 'select':
      return (
        <div style={{ marginBottom: 8 }}>
          <Text style={{ fontSize: 12 }}>{label}</Text>
          <Select size="small" style={{ width: '100%' }} disabled={readOnly} value={value === undefined || value === null ? undefined : String(value)}
            onChange={(v) => onChange(v)}
            options={(block.options || []).map((o) => ({ value: o, label: o }))} />
        </div>
      );
    case 'multiSelect':
      return (
        <div style={{ marginBottom: 8 }}>
          <Text style={{ fontSize: 12 }}>{label}</Text>
          <Select size="small" mode="multiple" style={{ width: '100%' }} disabled={readOnly} value={Array.isArray(value) ? value.map(String) : []}
            onChange={(v) => onChange(v)}
            options={(block.options || []).map((o) => ({ value: o, label: o }))} />
        </div>
      );
    default:
      return (
        <div style={{ marginBottom: 8 }}>
          <Text style={{ fontSize: 12 }}>{label}</Text>
          <Input size="small" value={value === undefined || value === null ? '' : String(value)} disabled={readOnly} onFocus={() => editing(true)} onBlur={() => editing(false)}
            onChange={(e) => onChange(e.target.value)} style={{ fontSize: 12 }} />
        </div>
      );
  }
}

/** 问题类型中文映射（与知识导入 ReviewDetail 保持一致） */
const ISSUE_TYPE_LABEL: Record<string, string> = {
  missing: '内容缺失',
  incomplete: '内容不完整',
  inaccurate: '内容不准确',
  inconsistent: '字段不一致',
  style: '描述应规范',
};

/** 字段级审核建议内联卡片：与知识导入 ReviewDetail.renderInlineSuggestion 样式一致 */
function InlineReviewCard({ item, onDecide, readOnly }: {
  item: NodeReviewItem;
  onDecide?: (itemId: string, decision: 'accept' | 'ignore') => void;
  readOnly?: boolean;
}) {
  const sevColor = item.payload.severity === 'error' ? '#ff4d4f' : item.payload.severity === 'warning' ? '#faad14' : '#1677ff';
  const sevMeta = { color: sevColor, text: ISSUE_TYPE_LABEL[item.payload.issueType] || item.payload.issueType };
  const decided = item.status !== 'suggested';
  return (
    <div style={{
      marginTop: 4,
      padding: '6px 8px',
      borderLeft: `3px solid ${sevMeta.color}`,
      background: `${sevMeta.color}0a`,
      borderRadius: 2,
      fontSize: 12,
      lineHeight: 1.6,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
        <Tag color={sevMeta.color} style={{ marginInlineEnd: 4, flexShrink: 0, fontSize: 11 }}>AI 审核意见 · {sevMeta.text}</Tag>
        <span style={{ color: '#374151', flex: 1 }}>
          {item.payload.issue && <span style={{ display: 'block' }}>{item.payload.issue}</span>}
          {item.payload.newValue ? (
            <span style={{ color: '#1677ff', display: 'block', marginTop: 4, padding: '4px 6px', background: '#1677ff0a', borderRadius: 2 }}>
              <CheckOutlined style={{ marginInlineEnd: 4 }} />
              新内容：{item.payload.newValue}
            </span>
          ) : item.payload.suggestion ? (
            <span style={{ color: '#6b7280', display: 'block', marginTop: 2 }}>{item.payload.suggestion}</span>
          ) : null}
        </span>
      </div>
      {!readOnly && onDecide && !decided && (
        <div style={{ marginTop: 4, display: 'flex', gap: 8 }}>
          <Button size="small" type="link" icon={<CheckOutlined />} style={{ color: '#52c41a', padding: 0, fontSize: 12 }} onClick={() => onDecide(item.id, 'accept')}>
            {item.payload.newValue ? '采纳修改' : '已知悉'}
          </Button>
          <Button size="small" type="link" style={{ color: '#999', padding: 0, fontSize: 12 }} onClick={() => onDecide(item.id, 'ignore')}>
            忽略
          </Button>
        </div>
      )}
      {decided && item.status === 'accepted' && (
        <div style={{ marginTop: 2, fontSize: 11, color: '#52c41a' }}><CheckOutlined /> 已采纳</div>
      )}
      {decided && item.status === 'ignored' && (
        <div style={{ marginTop: 2, fontSize: 11, color: '#999' }}>已忽略</div>
      )}
    </div>
  );
}

export function PropertyPanel({ selected, schema, referenceNodes, readOnly, onEditingInFieldChange, onFieldChange, onDelete, onAiAction, onAiAssist, onNodeReview, nodeReviewRunningGroups, reviewItems, onDecideReview }: PropertyPanelProps) {
  const isIntentGraphNode = selected?.kind === 'node' && selected.data.nodeType === 'INTENT' && schema?.templateId === 'intent-graph';
  const sections = useMemo(() => {
    if (!selected || !schema) return [];
    const kindSchema = selected.kind === 'node' ? schema.node : schema.edge;
    const type = String(selected.data[selected.kind === 'node' ? 'nodeType' : 'edgeType'] || '');
    return kindSchema.sections
      .map((sec) => ({ title: sec.title, blocks: sec.blocks.filter((b) => blockAppliesTo(b, type) && !(isIntentGraphNode && FULFILLMENT_FIELDS.has(b.key))) }))
      .filter((g) => g.blocks.length > 0);
  }, [selected, schema, isIntentGraphNode]);

  const [activeKeys, setActiveKeys] = useState<string[]>(() =>
    isIntentGraphNode ? ['0'] : sections.map((_, i) => String(i)),
  );
  // 切换元素或 sections 变化时重置展开状态
  useEffect(() => {
    setActiveKeys(isIntentGraphNode ? ['0'] : sections.map((_, i) => String(i)));
  }, [selected?.id, sections]);
  // 审核完成后自动展开对应分组，确保审核结果可见
  useEffect(() => {
    if (!reviewItems) return;
    const reviewedKeys = sections
      .map((sec, i) => ({ idx: String(i), reviewed: reviewItems[sec.title] !== undefined }))
      .filter((x) => x.reviewed)
      .map((x) => x.idx);
    if (reviewedKeys.length) {
      setActiveKeys((prev) => {
        const s = new Set(prev);
        reviewedKeys.forEach((k) => s.add(k));
        return s.size === prev.length ? prev : Array.from(s);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewItems]);

  if (!selected) {
    return (
      <div style={{ padding: 16 }}>
        <Empty description={readOnly ? '点击节点或边查看属性' : '点击节点或边编辑属性'} image={Empty.PRESENTED_IMAGE_SIMPLE} />
        <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
          · 单击节点/边 → {readOnly ? '查看' : '编辑'}属性<br />
          · 悬停/选中高亮邻域<br />
          · 滚轮缩放，拖拽平移
        </Text>
      </div>
    );
  }

  const typeTag = selected.data[selected.kind === 'node' ? 'nodeType' : 'edgeType'];
  return (
    <div style={{ padding: '8px 12px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <Text strong style={{ fontSize: 13 }}>{selected.kind === 'node' ? '节点属性' : '边属性'}</Text>
        <Space size={4}>
          {typeTag ? <Tag style={{ marginRight: 0 }}>{String(typeTag)}</Tag> : null}
          {selected.kind === 'node' && selected.data.nodeType === 'AGGREGATE_INTENT' && onAiAssist && (
            <Button size="small" type="primary" ghost icon={<BulbOutlined />} onClick={onAiAssist}>AI整组审核</Button>
          )}
          {!readOnly && <Button size="small" danger icon={<DeleteOutlined />} onClick={onDelete} />}
        </Space>
      </div>
      <Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 8 }}>ID：{selected.id}</Text>
      {(selected.data.provenance as { source?: string } | undefined)?.source && (
        <Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 8 }}>
          来源：{String((selected.data.provenance as { source?: string }).source)}
          {selected.data.review_status ? ` · ${String(selected.data.review_status)}` : ''}
        </Text>
      )}
      {isIntentGraphNode && <IntentFulfillmentEditor
        data={selected.data}
        referenceNodes={referenceNodes}
        readOnly={readOnly}
        onChange={onFieldChange}
        onEditing={onEditingInFieldChange}
      />}
      <Collapse
        key={`${selected.kind}:${String(typeTag)}`}
        activeKey={activeKeys}
        onChange={setActiveKeys}
        size="small"
        items={sections.map((sec, i) => {
          const groupKey = sec.title;
          const groupFieldKeys = sec.blocks.filter((b) => b.key !== 'id').map((b) => b.key);
          const groupReviews = reviewItems?.[groupKey];
          const groupRunning = nodeReviewRunningGroups?.has(groupKey) ?? false;
          const groupReviewed = groupReviews !== undefined;
          const groupHasSuggestions = (groupReviews || []).some((it) => it.status === 'suggested');
          return {
            key: String(i),
            label: (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }} onClick={(e) => e.stopPropagation()}>
                <span>{sec.title}</span>
                {!readOnly && onNodeReview && (
                  <Button
                    size="small"
                    type="text"
                    icon={<BulbOutlined style={{ color: '#1677ff' }} />}
                    loading={groupRunning}
                    onClick={(e) => { e.stopPropagation(); onNodeReview(groupKey, groupFieldKeys); }}
                    style={{ fontSize: 12, padding: '0 4px' }}
                  >
                    AI辅助审核编辑
                  </Button>
                )}
              </div>
            ),
            children: (
              <div>
                {sec.blocks.map((block) => {
                  const isId = block.key === 'id';
                  if (isId) return null;
                  const raw = selected.data.raw as Record<string, unknown> | undefined;
                  const aiPatch = raw?._aiPatch as Record<string, unknown> | undefined;
                  const fieldAi = aiPatch?.[block.key];
                  const aiIndices = Array.isArray(fieldAi) ? new Set(fieldAi as number[]) : undefined;
                  const fieldReviews = (groupReviews || []).filter((it) => it.payload.field === block.key);
                  const visibleBlocks = sec.blocks.filter((b) => b.key !== 'id');
                  const firstVisibleIdx = visibleBlocks.findIndex((b) => b.key === block.key);
                  const showNoIssue = groupReviewed && firstVisibleIdx === 0 && !groupHasSuggestions;
                  return (
                    <div key={block.key}>
                      <BlockField
                        block={block}
                        value={selected.data[block.key]}
                        editing={onEditingInFieldChange}
                        onChange={(v) => onFieldChange(block.key, v)}
                        readOnly={readOnly}
                        aiIndices={aiIndices}
                        onAiAction={onAiAction}
                      />
                      {fieldReviews.map((it) => (
                        <InlineReviewCard key={it.id} item={it} readOnly={readOnly} onDecide={onDecideReview} />
                      ))}
                      {showNoIssue && (
                        <div style={{
                          marginTop: 4,
                          padding: '6px 8px',
                          borderLeft: '3px solid #52c41a',
                          background: '#52c41a0a',
                          borderRadius: 2,
                          fontSize: 12,
                          color: '#52c41a',
                        }}>
                          <CheckOutlined style={{ marginInlineEnd: 4 }} />
                          AI 已审核本组内容，未发现需要修改的问题
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ),
          };
        })}
      />
      {selected.data.raw !== undefined && (
        <Collapse
          style={{ marginTop: 8 }}
          size="small"
          items={[{
            key: 'raw',
            label: '📦 原始数据（raw）',
            children: (
              <pre style={{ maxHeight: 260, overflow: 'auto', fontSize: 10, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                {JSON.stringify(selected.data.raw, null, 2)}
              </pre>
            ),
          }]}
        />
      )}
    </div>
  );
}
