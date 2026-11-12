/**
 * 新建节点模态（双击画布 / 右键画布「在此添加节点」/ 树面板「加子」共用）
 * ——对齐 AI Harbor intent-graph-editor 的 openAddNodeModal 动态必填字段：
 *   类型下拉（模板 node_types）+ 该类型 required 字段动态表单；
 *   可选字段取模板 default，确认时合并为 properties 交给父级建节点。
 */
import { useEffect, useMemo, useState } from 'react';
import { Input, Modal, Select, Tag } from 'antd';
import type { GraphTemplate } from '@/api/orgGraph';

interface AddNodeModalProps {
  open: boolean;
  template: GraphTemplate;
  /** 初始类型（父节点加子时按目标类型预选） */
  initialType?: string;
  /** 父节点 id（创建后由父级按树边类型自动连边） */
  parentId?: string;
  position?: { x: number; y: number };
  onClose: () => void;
  onCreate: (type: string, properties: Record<string, unknown>, parentId?: string) => void;
}

export function AddNodeModal({ open, template, initialType, parentId, position, onClose, onCreate }: AddNodeModalProps) {
  const [nodeType, setNodeType] = useState<string>('');
  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    setNodeType(initialType || (template.node_types[0] && template.node_types[0].type) || '');
    setValues({});
  }, [open, initialType, template]);

  const nt = useMemo(() => template.node_types.find((t) => t.type === nodeType), [template, nodeType]);
  // 名称类必填字段优先排最前（主标签先填）；enum/boolean 取 default 不渲染输入
  const requiredFields = useMemo(() => {
    const fields = (nt?.fields || []).filter((f) => f.required);
    return fields
      .map((f) => ({ f, input: f.type === 'string' || f.type === 'multiline' || f.type === 'url' }))
      .sort((a, b) => ((b.f.key === 'name') ? 1 : 0) - ((a.f.key === 'name') ? 1 : 0));
  }, [nt]);

  const missing = requiredFields.some(({ f, input }) => input && !String(values[f.key] || '').trim());

  function handleOk() {
    if (!nt || missing) return;
    const properties: Record<string, unknown> = {};
    // 全部字段（含可选）取模板 default，再叠加输入值
    nt.fields.forEach((f) => {
      if (f.default !== undefined && f.default !== null && f.default !== '') properties[f.key] = f.default;
    });
    requiredFields.forEach(({ f, input }) => {
      if (input && String(values[f.key] || '').trim()) properties[f.key] = String(values[f.key]).trim();
    });
    onCreate(nt.type, properties, parentId);
  }

  return (
    <Modal
      open={open}
      title={parentId ? `添加子节点（挂到 ${parentId} 下）` : '新建节点'}
      okText="创建"
      cancelText="取消"
      okButtonProps={{ disabled: !nt || missing }}
      onOk={handleOk}
      onCancel={onClose}
      width={420}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 4 }}>
        <div>
          <Tag color="blue">节点类型</Tag>
          <Select
            style={{ width: '100%', marginTop: 4 }}
            value={nodeType || undefined}
            onChange={(v: string) => { setNodeType(v); setValues({}); }}
            options={template.node_types.map((t) => ({ value: t.type, label: `${t.type} · ${t.label}` }))}
          />
        </div>
        {requiredFields.filter(({ input }) => input).map(({ f }) => (
          <div key={f.key}>
            <Tag color={f.key === 'name' ? 'green' : 'default'}>{f.label} *</Tag>
            <Input
              style={{ marginTop: 4 }}
              placeholder={f.label}
              value={values[f.key] || ''}
              onChange={(e) => setValues((prev) => ({ ...prev, [f.key]: e.target.value }))}
              onPressEnter={handleOk}
            />
          </div>
        ))}
        {position && (
          <div style={{ fontSize: 11, color: '#86909c' }}>落点：({Math.round(position.x)}, {Math.round(position.y)})</div>
        )}
      </div>
    </Modal>
  );
}
