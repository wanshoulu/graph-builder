/**
 * 注册资产弹窗 — 模板驱动注册（二选一）：
 *   上传模板 JSON：本地模板文件（graph-builder-templates 同构）
 *   复制现有资产：选定源资产，模板整套复制后可自行改造
 */
import { Alert, Form, Input, Modal, Radio, Select, message } from 'antd';
import { useEffect, useState } from 'react';
import { listAssets, registerAsset, type GraphAsset, type GraphTemplate } from '@/api/orgGraph';

interface RegisterAssetModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (assetId: string) => void;
}

type SourceMode = 'upload' | 'copy';

export function RegisterAssetModal({ open, onClose, onCreated }: RegisterAssetModalProps) {
  const [form] = Form.useForm();
  const [mode, setMode] = useState<SourceMode>('copy');
  const [assets, setAssets] = useState<GraphAsset[]>([]);
  const [template, setTemplate] = useState<GraphTemplate | null>(null);
  const [templateName, setTemplateName] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      form.resetFields();
      setMode('copy');
      setTemplate(null);
      setTemplateName('');
      listAssets().then(setAssets).catch(() => setAssets([]));
    }
  }, [open, form]);

  async function handleFile(file: File) {
    try {
      const parsed = JSON.parse(await file.text()) as GraphTemplate;
      if (!Array.isArray(parsed.node_types) || !parsed.node_types.length) throw new Error('模板缺少 node_types 数组');
      if (!Array.isArray(parsed.edge_types)) throw new Error('模板缺少 edge_types 数组');
      setTemplate(parsed);
      setTemplateName(file.name);
    } catch (e) {
      setTemplate(null);
      setTemplateName('');
      message.error(e instanceof Error ? `模板解析失败：${e.message}` : '模板解析失败');
    }
  }

  async function doRegister() {
    let values: { assetId: string; name?: string; description?: string; copyFrom?: string };
    try {
      values = await form.validateFields();
    } catch { return; }
    if (mode === 'upload' && !template) { message.warning('请先选择模板 JSON 文件'); return; }
    setSubmitting(true);
    try {
      await registerAsset({
        assetId: values.assetId,
        name: values.name,
        description: values.description,
        ...(mode === 'upload' ? { template: template! } : { copyFrom: values.copyFrom }),
      });
      message.success(`资产 ${values.assetId} 已注册，可进入 AI 辅助建图开始建图`);
      onCreated(values.assetId);
      onClose();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '注册失败');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      title="注册图谱资产"
      open={open}
      onOk={doRegister}
      onCancel={onClose}
      confirmLoading={submitting}
      okText="注册"
      cancelText="取消"
      width={560}
      destroyOnHidden
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="模板是资产唯一真源"
        description="自建资产使用通用模板校验器与模板推导的抽取 schema；注册后即可在 AI 辅助建图中编辑，可随时发布版本。"
      />
      <Form form={form} layout="vertical">
        <Form.Item label="模板来源">
          <Radio.Group
            value={mode}
            onChange={(e) => setMode(e.target.value as SourceMode)}
            options={[
              { label: '从现有资产复制模板', value: 'copy' },
              { label: '上传模板 JSON', value: 'upload' },
            ]}
            optionType="button"
          />
        </Form.Item>
        {mode === 'copy' ? (
          <Form.Item name="copyFrom" label="源资产" rules={[{ required: true, message: '请选择源资产' }]}>
            <Select
              placeholder="选择要复制模板的资产"
              showSearch
              optionFilterProp="label"
              loading={assets.length === 0}
              options={assets.map((a) => ({ value: a.assetId, label: `${a.name}${a.name_en ? ' / ' + a.name_en : ''}（${a.nodeTypes.length} 类型 / ${a.edgeTypes.length} 关系）` }))}
            />
          </Form.Item>
        ) : (
          <Form.Item label="模板 JSON 文件" required validateStatus={templateName ? 'success' : undefined}>
            <input
              type="file"
              accept="application/json,.json"
              style={{ width: '100%' }}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
            />
            {templateName && <span style={{ fontSize: 12, color: '#52c41a' }}>已解析：{templateName}（{template?.node_types?.length ?? 0} 节点类型 / {template?.edge_types?.length ?? 0} 边类型）</span>}
          </Form.Item>
        )}
        <Form.Item
          name="assetId"
          label="资产 ID（slug）"
          rules={[
            { required: true, message: '请输入资产 ID' },
            { pattern: /^[a-z][a-z0-9-]{2,63}$/, message: '3~64 位，小写字母开头，仅小写字母/数字/连字符' },
          ]}
          extra="全局唯一，注册后不可修改"
        >
          <Input placeholder="如：risk-control-graph" disabled={false} />
        </Form.Item>
        <Form.Item name="name" label="显示名"><Input placeholder="默认取模板名" /></Form.Item>
        <Form.Item name="description" label="描述"><Input.TextArea rows={2} placeholder="可选" /></Form.Item>
      </Form>
    </Modal>
  );
}
