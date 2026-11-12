/**
 * 生成结果层级树视图：按模板 layout.tree_edges 声明的树骨架边，把图文档渲染成 antd Tree。
 * 森林顶层（多个聚合意图/孤立节点）统一挂到虚拟根节点下，保证树有唯一入口（仅显示层，不入图文档）。
 * 未声明树骨架边的模板显示 Empty 提示（此时图谱画布是正确视图）。
 */
import { useMemo } from 'react';
import { Empty, Tag, Tree, Typography } from 'antd';
import { ApartmentOutlined } from '@ant-design/icons';
import type { GraphDocument, GraphTemplate } from '@/api/orgGraph';
import { documentToCanvas, nodeDisplayName } from '../lib/graphDoc';
import { buildTreeChildren } from '../lib/layout';
import { treeNodeIdSet } from '../lib/visible';

const { Text } = Typography;

const FALLBACK_PALETTE = ['#1677ff', '#722ed1', '#13c2c2', '#eb2f96', '#fa8c16', '#52c41a', '#2f54eb', '#faad14'];

/** 虚拟根节点 key（真节点 id 不会是这个前缀形态） */
const VIRTUAL_ROOT_KEY = '__graph_root__';

interface TreeDataNode {
  key: string;
  title: React.ReactNode;
  children?: TreeDataNode[];
}

interface ResultTreeViewProps {
  document: GraphDocument;
  template: GraphTemplate;
  height?: number;
}

export function ResultTreeView({ document: doc, template, height = 420 }: ResultTreeViewProps) {
  const treeEdges = template.layout?.tree_edges;
  const treeParent = template.layout?.tree_parent || 'source';

  const { treeData, covered } = useMemo(() => {
    if (!treeEdges || !treeEdges.length) return { treeData: null, covered: 0 };
    const canvas = documentToCanvas(doc);
    const childrenOf = buildTreeChildren(canvas.edges, treeEdges, treeParent);
    const byId = new Map(doc.nodes.map((n) => [n.id, n]));
    const typeColor = new Map<string, string>();
    template.node_types.forEach((t, i) => typeColor.set(t.type, t.style?.color || FALLBACK_PALETTE[i % FALLBACK_PALETTE.length]));
    const childIds = new Set<string>();
    childrenOf.forEach((kids) => kids.forEach((id) => childIds.add(id)));
    const roots = doc.nodes.filter((n) => !childIds.has(n.id)).map((n) => n.id);
    // 防环：访问栈用可变 Set（进栈/出栈），避免每孩子全量拷贝栈的 O(n²)
    const stack = new Set<string>();
    const buildNode = (id: string): TreeDataNode => {
      stack.add(id);
      const node = byId.get(id);
      const label = node ? nodeDisplayName(node, template) : id;
      const type = node?.type || '';
      const kids = (childrenOf.get(id) || []).filter((k) => !stack.has(k)).map((k) => buildNode(k));
      stack.delete(id);
      return {
        key: id,
        title: (
          <span>
            <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: typeColor.get(type) || '#d9d9d9', marginRight: 6 }} />
            {label} <Tag style={{ fontSize: 11, marginRight: 0 }}>{type || '?'}</Tag>
          </span>
        ),
        children: kids.length ? kids : undefined,
      };
    };
    const forest: TreeDataNode[] = roots.map((id) => buildNode(id));
    const virtualRoot: TreeDataNode = {
      key: VIRTUAL_ROOT_KEY,
      title: (
        <span>
          <ApartmentOutlined style={{ color: '#1677ff', marginRight: 6 }} />
          <Text strong style={{ fontSize: 13 }}>{template.name}</Text>
          <Tag color="blue" style={{ fontSize: 11, marginLeft: 8, marginRight: 0 }}>根</Tag>
          <Text type="secondary" style={{ fontSize: 11, marginLeft: 8 }}>{doc.nodes.length} 节点</Text>
        </span>
      ),
      children: forest,
    };
    return { treeData: [virtualRoot], covered: treeNodeIdSet(childrenOf).size + roots.length };
  }, [doc, template, treeEdges, treeParent]);

  if (!treeEdges || !treeEdges.length) {
    return (
      <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Empty description={<Text type="secondary">当前模板未声明树骨架边（layout.tree_edges），请使用「图谱画布」查看</Text>} />
      </div>
    );
  }
  if (!treeData || !treeData.length) {
    return (
      <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Empty description={<Text type="secondary">生成结果中没有树骨架节点</Text>} />
      </div>
    );
  }
  const total = covered || doc.nodes.length;
  return (
    <div style={{ height, overflow: 'auto', border: '1px solid #e6ebf5', borderRadius: 8, padding: '10px 14px', background: '#fbfcfe' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <Text strong style={{ fontSize: 12 }}>树骨架</Text>
        {(treeEdges as (string | { type: string })[]).map((d, i) => {
          const t = typeof d === 'string' ? d : d.type;
          return <Tag key={i} color="blue" style={{ fontSize: 11, borderRadius: 4, marginRight: 0 }}>{t}</Tag>;
        })}
        <Text type="secondary" style={{ fontSize: 12 }}>覆盖 {total} 节点</Text>
      </div>
      {/* height 启用 antd Tree 虚拟滚动：大图（数千节点）全量展开不再整树渲染 */}
      <Tree treeData={treeData} defaultExpandAll blockNode selectable={false} height={Math.max(200, height - 58)} style={{ marginTop: 8 }} />
    </div>
  );
}
