/**
 * 模板库抽屉（P1）：
 *   Tab 1 — 节点模板：从右键"存为节点模板"保存，点击即插入预设节点
 *   Tab 2 — 子图模板：从右键"存为子图模板"保存，点击即插入整块子图
 *   Tab 3 — 边规则：可视化展示模板的边类型约束（source_types → target_types）
 * 存储位置：localStorage（跨资产共享）
 */
import { Drawer, Tabs, Empty, Button, Tag, Popconfirm, Tooltip } from 'antd';
import { message } from '@/utils/antdStatic';
import { DeleteOutlined, PlusOutlined, NodeIndexOutlined, ApartmentOutlined, ShareAltOutlined } from '@ant-design/icons';
import { useMemo } from 'react';
import type { GraphTemplate } from '@/api/orgGraph';
import type { CanvasNode, CanvasEdge } from '../lib/graphDoc';

/* ── 类型定义 ── */

export interface SavedNodeTemplate {
  id: string;
  name: string;
  nodeType: string;
  properties: Record<string, unknown>;
  createdAt: number;
}

export interface SavedSubgraphTemplate {
  id: string;
  name: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  createdAt: number;
}

/* ── localStorage 读写 ── */

const NODE_TPL_KEY = 'gb_graph_node_templates';
const SUBGRAPH_TPL_KEY = 'gb_graph_subgraph_templates';

export function loadNodeTemplates(): SavedNodeTemplate[] {
  try { return JSON.parse(localStorage.getItem(NODE_TPL_KEY) || '[]'); } catch { return []; }
}

export function saveNodeTemplate(t: SavedNodeTemplate) {
  const list = loadNodeTemplates();
  list.unshift(t);
  localStorage.setItem(NODE_TPL_KEY, JSON.stringify(list.slice(0, 100)));
}

export function removeNodeTemplate(id: string) {
  const list = loadNodeTemplates().filter(t => t.id !== id);
  localStorage.setItem(NODE_TPL_KEY, JSON.stringify(list));
}

export function loadSubgraphTemplates(): SavedSubgraphTemplate[] {
  try { return JSON.parse(localStorage.getItem(SUBGRAPH_TPL_KEY) || '[]'); } catch { return []; }
}

export function saveSubgraphTemplate(t: SavedSubgraphTemplate) {
  const list = loadSubgraphTemplates();
  list.unshift(t);
  localStorage.setItem(SUBGRAPH_TPL_KEY, JSON.stringify(list.slice(0, 30)));
}

export function removeSubgraphTemplate(id: string) {
  const list = loadSubgraphTemplates().filter(t => t.id !== id);
  localStorage.setItem(SUBGRAPH_TPL_KEY, JSON.stringify(list));
}

/* ── 内部字段（保存节点模板时排除） ── */
const INTERNAL_FIELDS = new Set(['id', 'nodeType', 'nodeColor', 'provenance', 'review_status']);

/** 从节点 data 中提取可复用的属性 */
export function extractNodeProperties(data: Record<string, unknown>): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (!INTERNAL_FIELDS.has(k)) props[k] = v;
  }
  return props;
}

/* ── 组件 ── */

interface TemplateLibraryDrawerProps {
  open: boolean;
  onClose: () => void;
  template: GraphTemplate;
  nodeTemplates: SavedNodeTemplate[];
  subgraphTemplates: SavedSubgraphTemplate[];
  onInsertNode: (nodeType: string, properties: Record<string, unknown>) => void;
  onInsertSubgraph: (nodes: CanvasNode[], edges: CanvasEdge[]) => void;
  onDeleteNodeTemplate: (id: string) => void;
  onDeleteSubgraphTemplate: (id: string) => void;
}

export function TemplateLibraryDrawer({
  open,
  onClose,
  template,
  nodeTemplates,
  subgraphTemplates,
  onInsertNode,
  onInsertSubgraph,
  onDeleteNodeTemplate,
  onDeleteSubgraphTemplate,
}: TemplateLibraryDrawerProps) {
  const nodeTypeSet = useMemo(() => new Set(template.node_types.map(t => t.type)), [template]);
  const edgeTypeColors = useMemo(() => {
    const palette = ['#5B8FF9','#5AD8A6','#5D7092','#F6BD16','#E8684A','#6DC8EC','#9270CA','#FF9D4D'];
    const m: Record<string, string> = {};
    template.edge_types.forEach((et, i) => { m[et.type] = palette[i % palette.length]; });
    return m;
  }, [template]);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="模板库"
      width={480}
      placement="right"
    >
      <Tabs
        defaultActiveKey="node"
        items={[
          {
            key: 'node',
            label: `节点模板 (${nodeTemplates.length})`,
            children: (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {nodeTemplates.length === 0 ? (
                  <Empty description="暂无节点模板。右键节点 → 存为节点模板" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                ) : (
                  nodeTemplates.map(tpl => {
                    const typeExists = nodeTypeSet.has(tpl.nodeType);
                    const propKeys = Object.keys(tpl.properties).filter(k => tpl.properties[k]);
                    return (
                      <div
                        key={tpl.id}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px',
                          border: '1px solid #e5e6eb', borderRadius: 8, background: '#fff',
                          opacity: typeExists ? 1 : 0.5,
                        }}
                      >
                        <span style={{
                          display: 'inline-block', width: 10, height: 10, borderRadius: '50%',
                          background: '#5B8FF9', flexShrink: 0,
                        }} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {tpl.name}
                          </div>
                          <div style={{ fontSize: 11, color: '#86909c', display: 'flex', gap: 6, marginTop: 2 }}>
                            <Tag style={{ fontSize: 10, lineHeight: '16px', margin: 0, padding: '0 4px' }}>{tpl.nodeType}</Tag>
                            <span>{propKeys.length} 个属性</span>
                            {!typeExists && <span style={{ color: '#e5484d' }}>当前模板无此类型</span>}
                          </div>
                        </div>
                        <Tooltip title={typeExists ? '插入节点' : '当前模板不支持此类型'}>
                          <Button
                            size="small"
                            type="primary"
                            icon={<PlusOutlined />}
                            disabled={!typeExists}
                            onClick={() => {
                              onInsertNode(tpl.nodeType, tpl.properties);
                              message.success(`已从模板创建 ${tpl.nodeType} 节点`);
                            }}
                          />
                        </Tooltip>
                        <Popconfirm title="删除此模板？" onConfirm={() => onDeleteNodeTemplate(tpl.id)}>
                          <Button size="small" danger icon={<DeleteOutlined />} />
                        </Popconfirm>
                      </div>
                    );
                  })
                )}
              </div>
            ),
          },
          {
            key: 'subgraph',
            label: `子图模板 (${subgraphTemplates.length})`,
            children: (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {subgraphTemplates.length === 0 ? (
                  <Empty description="暂无子图模板。选中多个节点 → 右键 → 存为子图模板" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                ) : (
                  subgraphTemplates.map(tpl => (
                    <div
                      key={tpl.id}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px',
                        border: '1px solid #e5e6eb', borderRadius: 8, background: '#fff',
                      }}
                    >
                      <ApartmentOutlined style={{ color: '#5B8FF9', flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {tpl.name}
                        </div>
                        <div style={{ fontSize: 11, color: '#86909c', display: 'flex', gap: 8, marginTop: 2 }}>
                          <span><NodeIndexOutlined /> {tpl.nodes.length} 节点</span>
                          <span><ShareAltOutlined /> {tpl.edges.length} 边</span>
                        </div>
                      </div>
                      <Button
                        size="small"
                        type="primary"
                        icon={<PlusOutlined />}
                        onClick={() => {
                          onInsertSubgraph(tpl.nodes, tpl.edges);
                          message.success(`已插入子图（${tpl.nodes.length} 节点 · ${tpl.edges.length} 边）`);
                        }}
                      />
                      <Popconfirm title="删除此模板？" onConfirm={() => onDeleteSubgraphTemplate(tpl.id)}>
                        <Button size="small" danger icon={<DeleteOutlined />} />
                      </Popconfirm>
                    </div>
                  ))
                )}
              </div>
            ),
          },
          {
            key: 'edgeRules',
            label: `边规则 (${template.edge_types.length})`,
            children: (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {template.edge_types.map(et => (
                  <div
                    key={et.type}
                    style={{
                      border: '1px solid #e5e6eb', borderRadius: 8, padding: '10px 12px',
                      borderLeft: `3px solid ${edgeTypeColors[et.type] || '#5B8FF9'}`,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                      <span style={{ fontWeight: 600, fontSize: 13 }}>{et.label}</span>
                      <Tag style={{ fontSize: 10, margin: 0, padding: '0 4px' }}>{et.type}</Tag>
                    </div>
                    <div style={{ fontSize: 12, color: '#4e5969', display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <div>
                        <span style={{ color: '#86909c' }}>源类型：</span>
                        {et.source_types.length > 0 ? et.source_types.map(t => (
                          <Tag key={t} style={{ fontSize: 10, margin: '2px 2px 0 0', padding: '0 4px' }}>{t}</Tag>
                        )) : <span style={{ color: '#c9cdd4' }}>不限</span>}
                      </div>
                      <div>
                        <span style={{ color: '#86909c' }}>目标类型：</span>
                        {et.target_types.length > 0 ? et.target_types.map(t => (
                          <Tag key={t} style={{ fontSize: 10, margin: '2px 2px 0 0', padding: '0 4px' }}>{t}</Tag>
                        )) : <span style={{ color: '#c9cdd4' }}>不限</span>}
                      </div>
                      {et.fields.length > 0 && (
                        <div>
                          <span style={{ color: '#86909c' }}>属性：</span>
                          {et.fields.map(f => (
                            <Tag key={f.key} style={{ fontSize: 10, margin: '2px 2px 0 0', padding: '0 4px' }}>
                              {f.label}{f.required ? '*' : ''}
                            </Tag>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ),
          },
        ]}
      />
    </Drawer>
  );
}
