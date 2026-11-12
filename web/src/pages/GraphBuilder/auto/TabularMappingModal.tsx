/**
 * 表格映射建图模态（材料库 × from-tabular 确定性路径，零 LLM）
 *
 * 材料 = CSV 文本 或 xlsx sheet（含行数据）→ 表头映射到模板节点字段 → 确定性建图。
 * 表头字段映射自动建议（exact/partial），可手工调整；关系映射为可选高级项。
 */
import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Collapse, Empty, Modal, Select, Space, Tag, Typography } from 'antd';
import { PlusOutlined, DeleteOutlined, TableOutlined } from '@ant-design/icons';
import { message } from '@/utils/antdStatic';
import type { GraphDocument, GraphTemplate, TabularEdgeMapping, TabularNodeMapping } from '@/api/orgGraph';
import { buildFromTabular } from '@/api/orgGraph';
import { parseCsvHeaders } from '../lib/tabular';
import { autoSuggestFieldMap, sheetRowsToJson, suggestNameColumn, type BuildMaterial } from '../lib/materials';

const { Text } = Typography;

interface TabularMappingModalProps {
  open: boolean;
  asset: string;
  material: BuildMaterial | null;
  template: GraphTemplate | null;
  onClose: () => void;
  /** 确定性建图成功后回调（父组件合并入结果区并质检） */
  onBuilt: (doc: GraphDocument, summary: string) => void;
}

interface NodeMappingDraft {
  nodeType: string;
  nameColumn: string;
  fieldMap: Record<string, string>;
}

interface EdgeMappingDraft {
  edgeType: string;
  sourceNodeType: string;
  targetNodeType: string;
  sourceColumn: string;
  targetColumn: string;
}

/** 材料可用数据表：xlsx sheet（带行数据）或 CSV 文本（客户端解析表头） */
function materialTables(material: BuildMaterial | null): { name: string; headers: string[]; rowCount: number; data: string[][] | null; truncated?: boolean }[] {
  if (!material) return [];
  if (material.sheets && material.sheets.length > 0) {
    return material.sheets
      .filter((s) => s.headers.length > 0 && Array.isArray(s.data) && s.data.length > 0)
      .map((s) => ({ name: `Sheet「${s.name}」`, headers: s.headers, rowCount: s.data?.length || 0, data: s.data || [], truncated: !!s.dataTruncated }));
  }
  if (material.text.trim()) {
    try {
      const parsed = parseCsvHeaders(material.text);
      if (parsed.headers.length > 0) {
        return [{ name: 'CSV 数据', headers: parsed.headers, rowCount: parsed.rowCount, data: null }];
      }
    } catch { /* 非 CSV 文本 → 空表 */ }
  }
  return [];
}

/** 表头匹配数最高的节点类型（默认选中项：表头能命中字段最多的类型最可能是用户要的实体） */
function bestNodeTypeFor(headers: string[], template: GraphTemplate): string {
  let best = template.node_types[0]?.type || '';
  let bestScore = -1;
  (template.node_types || []).forEach((t) => {
    const score = Object.keys(autoSuggestFieldMap(headers, t.fields || [])).length;
    if (score > bestScore) { bestScore = score; best = t.type; }
  });
  return best;
}

export function TabularMappingModal({ open, asset, material, template, onClose, onBuilt }: TabularMappingModalProps) {
  const tables = useMemo(() => materialTables(material), [material]);
  const [tableIdx, setTableIdx] = useState(0);
  const [nodeMappings, setNodeMappings] = useState<NodeMappingDraft[]>([]);
  const [edgeMappings, setEdgeMappings] = useState<EdgeMappingDraft[]>([]);
  const [building, setBuilding] = useState(false);

  const table = tables[tableIdx] || null;
  const nodeTypeMap = useMemo(() => {
    const m = new Map<string, { label: string; fields: GraphTemplate['node_types'][number]['fields'] }>();
    (template?.node_types || []).forEach((t) => m.set(t.type, { label: t.label || t.type, fields: t.fields || [] }));
    return m;
  }, [template]);

  // 按指定 sheet 的表头重算映射建议：切 sheet 后旧表头的映射全部失效，必须重算而不是沿用
  const remapForTable = (idx: number) => {
    if (!template) return;
    const t = tables[idx];
    if (!t) { setNodeMappings([]); setEdgeMappings([]); return; }
    const headers = t.headers;
    const firstType = bestNodeTypeFor(headers, template);
    const fields = (template.node_types.find((x) => x.type === firstType)?.fields || []) as never;
    setNodeMappings([{
      nodeType: firstType,
      nameColumn: suggestNameColumn(headers),
      fieldMap: autoSuggestFieldMap(headers, fields),
    }]);
    setEdgeMappings([]);
  };

  // 材料变化时初始化：默认第一张表 + 主实体映射自动建议
  useEffect(() => {
    if (!open || tables.length === 0 || !template) { setNodeMappings([]); setEdgeMappings([]); return; }
    setTableIdx(0);
    remapForTable(0);
  }, [open, material, template]); // eslint-disable-line react-hooks/exhaustive-deps

  // 切 sheet：重算映射建议（旧 sheet 的列名映射对新 sheet 无意义）
  useEffect(() => {
    if (!open) return;
    remapForTable(tableIdx);
  }, [tableIdx]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!material || !template) return null;
  const tpl: GraphTemplate = template;

  function updateNodeMapping(idx: number, patch: Partial<NodeMappingDraft>) {
    setNodeMappings((list) => list.map((m, i) => (i === idx ? { ...m, ...patch } : m)));
  }

  function addNodeMapping() {
    if (!table) return;
    // 优先选未使用的类型里表头匹配数最高的；无未用类型时取匹配最高的
    const unused = tpl.node_types.filter((t) => !nodeMappings.some((m) => m.nodeType === t.type));
    const pool = unused.length > 0 ? unused : tpl.node_types;
    const nextType = bestNodeTypeFor(table.headers, { node_types: pool } as GraphTemplate);
    setNodeMappings((list) => [...list, {
      nodeType: nextType,
      nameColumn: suggestNameColumn(table.headers),
      fieldMap: autoSuggestFieldMap(table.headers, (nodeTypeMap.get(nextType)?.fields || []) as never),
    }]);
  }

  function buildPayload(): { format: 'csv' | 'json'; content: string; nodeMappings: TabularNodeMapping[]; edgeMappings: TabularEdgeMapping[] } | null {
    if (!table || !material) return null;
    const nm: TabularNodeMapping[] = nodeMappings
      .filter((m) => m.nodeType && m.nameColumn)
      .map((m) => ({ nodeType: m.nodeType, nameColumn: m.nameColumn, fieldMap: m.fieldMap }));
    const em: TabularEdgeMapping[] = edgeMappings
      .filter((m) => m.edgeType && m.sourceNodeType && m.targetNodeType && m.sourceColumn && m.targetColumn)
      .map((m) => ({ ...m }));
    if (table.data) {
      return { format: 'json', content: sheetRowsToJson(table.headers, table.data), nodeMappings: nm, edgeMappings: em };
    }
    return { format: 'csv', content: material.text, nodeMappings: nm, edgeMappings: em };
  }

  async function handleBuild() {
    const payload = buildPayload();
    if (!payload || !material) return;
    if (!payload.nodeMappings.length) {
      message.warning('每个实体映射需要选择节点类型和名称列');
      return;
    }
    setBuilding(true);
    try {
      const r = await buildFromTabular(asset, payload);
      const errors = [...r.validation.asset.errors, ...r.validation.template.errors];
      const skipped = r.stats.skippedNodes + r.stats.skippedEdges;
      const summary = `表格映射建图完成：${r.stats.nodeCount} 节点 / ${r.stats.edgeCount} 边${skipped ? `（跳过 ${skipped} 行无法解析）` : ''}`;
      if (r.stats.nodeCount === 0 && r.stats.edgeCount === 0) {
        message.warning(`映射后没有产出任何节点/边，请检查名称列与字段映射是否正确${errors.length ? `；校验问题：${errors[0].message}` : ''}`, 6);
        return;
      }
      message.success(summary, 5);
      onBuilt(r.document, summary);
      onClose();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '表格映射建图失败');
    } finally {
      setBuilding(false);
    }
  }

  return (
    <Modal
      open={open}
      title={<Space size={8}><TableOutlined /> 表格映射建图（确定性 · 0 次 LLM 调用）</Space>}
      onCancel={onClose}
      width={820}
      footer={[
        <Button key="cancel" onClick={onClose}>取消</Button>,
        <Button key="build" type="primary" loading={building} onClick={handleBuild} disabled={tables.length === 0 || nodeMappings.length === 0}>
          映射建图
        </Button>,
      ]}
    >
      {tables.length === 0 ? (
        <Empty description="该材料没有可映射的表格数据（需要 xlsx sheet 或 CSV 表头行）" style={{ padding: '24px 0' }} />
      ) : (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Space size={8} wrap>
            <Text type="secondary" style={{ fontSize: 12 }}>数据表：</Text>
            <Select
              size="small"
              style={{ minWidth: 220 }}
              value={tableIdx}
              onChange={(v) => setTableIdx(v)}
              options={tables.map((t, i) => ({ value: i, label: `${t.name}（${t.rowCount} 行 × ${t.headers.length} 列）` }))}
            />
            {table?.truncated && <Tag color="orange">行数超上限，仅加载前 {table.rowCount} 行</Tag>}
            {material.name && <Tag>{material.name}</Tag>}
          </Space>

          <div>
            <Space size={8} style={{ marginBottom: 6 }}>
              <Text strong style={{ fontSize: 13 }}>实体映射</Text>
              <Button size="small" icon={<PlusOutlined />} onClick={addNodeMapping}>添加实体映射</Button>
            </Space>
            {nodeMappings.map((m, idx) => {
              const fields = nodeTypeMap.get(m.nodeType)?.fields || [];
              return (
                <div key={idx} style={{ border: '1px solid #e6ebf5', borderRadius: 8, padding: '10px 12px', marginBottom: 8 }}>
                  <Space size={8} wrap style={{ width: '100%' }}>
                    <Select
                      size="small"
                      style={{ minWidth: 200 }}
                      value={m.nodeType}
                      onChange={(v) => updateNodeMapping(idx, {
                        nodeType: v,
                        fieldMap: autoSuggestFieldMap(table!.headers, (nodeTypeMap.get(v)?.fields || []) as never),
                      })}
                      options={(template.node_types || []).map((t) => ({ value: t.type, label: `${t.label || t.type}（${t.type}）` }))}
                    />
                    <Text type="secondary" style={{ fontSize: 12 }}>名称列</Text>
                    <Select
                      size="small"
                      style={{ minWidth: 160 }}
                      value={m.nameColumn || undefined}
                      onChange={(v) => updateNodeMapping(idx, { nameColumn: v })}
                      placeholder="选择名称列"
                      options={table!.headers.map((h) => ({ value: h, label: h }))}
                    />
                    {nodeMappings.length > 1 && (
                      <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => setNodeMappings((list) => list.filter((_, i) => i !== idx))} />
                    )}
                  </Space>
                  <div style={{ marginTop: 8 }}>
                    <Text type="secondary" style={{ fontSize: 12 }}>字段映射（自动建议，可修改）：</Text>
                    <div style={{ marginTop: 4 }}>
                      {fields.length === 0 ? (
                        <Text type="secondary" style={{ fontSize: 12 }}>该类型无字段</Text>
                      ) : (
                        fields.map((f) => (
                          <Space key={f.key} size={4} wrap style={{ marginRight: 12, marginBottom: 4 }}>
                            <Select
                              size="small"
                              style={{ minWidth: 150 }}
                              value={m.fieldMap[f.key]}
                              allowClear
                              placeholder={`不映射（${f.required ? '必填' : '可选'}）`}
                              onChange={(v) => {
                                const next = { ...m.fieldMap };
                                if (v) next[f.key] = v; else delete next[f.key];
                                updateNodeMapping(idx, { fieldMap: next });
                              }}
                              options={table!.headers.map((h) => ({ value: h, label: h }))}
                            />
                            <Tag
                              style={{ fontSize: 11 }}
                              title={f.type === 'enum' && f.options?.length ? `可选值：${f.options.join(' / ')}` : undefined}
                            >
                              {f.label || f.key}{f.required ? ' *' : ''}{f.type === 'enum' && f.options?.length ? `（${f.options.slice(0, 3).join('/')}${f.options.length > 3 ? '…' : ''}）` : ''}
                            </Tag>
                          </Space>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <Collapse
            ghost
            items={[{
              key: 'edges',
              label: <Text type="secondary" style={{ fontSize: 12 }}>关系映射（可选，{edgeMappings.length} 条）</Text>,
              children: (
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  {edgeMappings.map((m, idx) => (
                    <Space key={idx} size={6} wrap>
                      <Select
                        size="small"
                        style={{ minWidth: 140 }}
                        value={m.edgeType || undefined}
                        placeholder="关系类型"
                        onChange={(v) => setEdgeMappings((list) => list.map((x, i) => (i === idx ? { ...x, edgeType: v } : x)))}
                        options={(template.edge_types || []).map((e) => ({ value: e.type, label: e.label || e.type }))}
                      />
                      <Select
                        size="small"
                        style={{ minWidth: 150 }}
                        value={m.sourceNodeType || undefined}
                        placeholder="源实体类型"
                        onChange={(v) => setEdgeMappings((list) => list.map((x, i) => (i === idx ? { ...x, sourceNodeType: v } : x)))}
                        options={(template.node_types || []).map((t) => ({ value: t.type, label: t.label || t.type }))}
                      />
                      <Text type="secondary" style={{ fontSize: 11 }}>源列</Text>
                      <Select
                        size="small"
                        style={{ minWidth: 110 }}
                        value={m.sourceColumn || undefined}
                        placeholder="源列"
                        onChange={(v) => setEdgeMappings((list) => list.map((x, i) => (i === idx ? { ...x, sourceColumn: v } : x)))}
                        options={table!.headers.map((h) => ({ value: h, label: h }))}
                      />
                      <Select
                        size="small"
                        style={{ minWidth: 150 }}
                        value={m.targetNodeType || undefined}
                        placeholder="目标实体类型"
                        onChange={(v) => setEdgeMappings((list) => list.map((x, i) => (i === idx ? { ...x, targetNodeType: v } : x)))}
                        options={(template.node_types || []).map((t) => ({ value: t.type, label: t.label || t.type }))}
                      />
                      <Text type="secondary" style={{ fontSize: 11 }}>目标列</Text>
                      <Select
                        size="small"
                        style={{ minWidth: 110 }}
                        value={m.targetColumn || undefined}
                        placeholder="目标列"
                        onChange={(v) => setEdgeMappings((list) => list.map((x, i) => (i === idx ? { ...x, targetColumn: v } : x)))}
                        options={table!.headers.map((h) => ({ value: h, label: h }))}
                      />
                      <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => setEdgeMappings((list) => list.filter((_, i) => i !== idx))} />
                    </Space>
                  ))}
                  <Button
                    size="small"
                    icon={<PlusOutlined />}
                    onClick={() => setEdgeMappings((list) => [...list, {
                      edgeType: template.edge_types[0]?.type || '',
                      sourceNodeType: nodeMappings[0]?.nodeType || '',
                      targetNodeType: nodeMappings[0]?.nodeType || '',
                      sourceColumn: '', targetColumn: '',
                    }])}
                  >
                    添加关系映射
                  </Button>
                  <Alert type="info" showIcon style={{ fontSize: 12 }} message="关系端点按（实体类型 + 名称列的值）在已映射实体中解析；值找不到对应实体时该行关系跳过。" />
                </Space>
              ),
            }]}
          />
        </Space>
      )}
    </Modal>
  );
}
