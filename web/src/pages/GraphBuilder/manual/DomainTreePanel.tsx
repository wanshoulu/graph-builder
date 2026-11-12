/**
 * 分域层级树（画布左侧导航面板）——对齐 AI Harbor intent-graph-editor 左栏 renderNodeTree：
 *   按 domain 分组 → 树骨架（复用 lib/layout 的 childrenOf）递归渲染；
 *   行点击 = 画布选中定位；hover 行内按钮：加子（新建模态带父）/ 删除（父级确认后级联删边）；
 *   搜索框过滤（按名称模糊匹配，命中行扁平列出）。
 */
import { useMemo, useState } from 'react';
import { Button, Empty, Input, Tooltip } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import type { CanvasNode } from '../lib/graphDoc';

interface DomainTreePanelProps {
  nodes: CanvasNode[];
  /** 树骨架邻接表（ManualBuilderPanel 按模板树边构建） */
  childrenOf: Map<string, string[]>;
  /** 领域配色（与泳道/节点色条一致） */
  domainTints: Record<string, string>;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onAddChild: (parentId: string) => void;
}

export function DomainTreePanel({ nodes, childrenOf, domainTints, onSelect, onDelete, onAddChild }: DomainTreePanelProps) {
  const [query, setQuery] = useState('');

  const byId = useMemo(() => {
    const m = new Map<string, CanvasNode>();
    nodes.forEach((n) => m.set(n.id, n));
    return m;
  }, [nodes]);
  const nameOf = (n: CanvasNode) => String(n.data.name || n.data.title || n.id);

  // 树根 = 有子且无父的骨架节点
  const roots = useMemo(() => {
    const hasParent = new Set<string>();
    childrenOf.forEach((kids) => kids.forEach((k) => hasParent.add(k)));
    return nodes.filter((n) => childrenOf.has(n.id) && !hasParent.has(n.id));
  }, [nodes, childrenOf]);

  // 领域分组（按根出现顺序保序）
  const domains = useMemo(() => {
    const out: { domain: string; roots: CanvasNode[] }[] = [];
    roots.forEach((r) => {
      const d = String(r.data.domain || '其他');
      let g = out.find((x) => x.domain === d);
      if (!g) { g = { domain: d, roots: [] }; out.push(g); }
      g.roots.push(r);
    });
    return out;
  }, [roots]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    const label = (n: CanvasNode) => String(n.data.name || n.data.title || n.id);
    return nodes.filter((n) => label(n).toLowerCase().indexOf(q) >= 0);
  }, [nodes, query]);

  const renderRow = (id: string, depth: number) => {
    const n = byId.get(id);
    if (!n) return null;
    const kids = childrenOf.get(id) || [];
    return (
      <div key={id}>
        <div
          className="dt-row"
          onClick={() => onSelect(id)}
          style={{
            paddingLeft: 6 + depth * 14, paddingRight: 4, height: 26, lineHeight: '26px',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            cursor: 'pointer', borderRadius: 4,
          }}
        >
          <span
            style={{
              fontSize: 12, color: '#1f2937', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
            }}
          >
            {kids.length > 0 ? (depth === 0 ? '📁 ' : '▸ ') : '· '}
            {nameOf(n)}
          </span>
          <span className="dt-actions" style={{ display: 'flex', gap: 0, opacity: 0, transition: 'opacity .15s' }}>
            <Tooltip title="添加子节点">
              <Button size="small" type="text" icon={<PlusOutlined style={{ fontSize: 11 }} />} onClick={(e) => { e.stopPropagation(); onAddChild(id); }} />
            </Tooltip>
            <Tooltip title="删除节点">
              <Button size="small" type="text" danger icon={<DeleteOutlined style={{ fontSize: 11 }} />} onClick={(e) => { e.stopPropagation(); onDelete(id); }} />
            </Tooltip>
          </span>
        </div>
        {kids.map((k) => renderRow(k, depth + 1))}
      </div>
    );
  };

  return (
    <div style={{ padding: '8px 6px', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <style>{`.dt-row:hover { background: #f0f5ff; } .dt-row:hover .dt-actions { opacity: 1 !important; }`}</style>
      <Input
        size="small"
        allowClear
        prefix={<span style={{ fontSize: 11 }}>🔍</span>}
        placeholder="搜索节点…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        style={{ marginBottom: 6 }}
      />
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {filtered ? (
          filtered.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无匹配节点" style={{ marginTop: 24 }} />
          ) : (
            filtered.map((n) => (
              <div
                key={n.id}
                onClick={() => onSelect(n.id)}
                style={{
                  padding: '2px 8px', fontSize: 12, cursor: 'pointer', borderRadius: 4,
                  display: 'flex', gap: 6, alignItems: 'center', overflow: 'hidden',
                }}
              >
                <span style={{ color: '#86909c', fontSize: 10, flexShrink: 0 }}>{String(n.data.domain || '')}</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nameOf(n)}</span>
              </div>
            ))
          )
        ) : roots.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无层级结构" style={{ marginTop: 24 }} />
        ) : (
          domains.map((g) => {
            const count = nodes.filter((n) => String(n.data.domain || '其他') === g.domain).length;
            return (
              <div key={g.domain} style={{ marginBottom: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 6px', fontSize: 11, fontWeight: 600, color: '#4e5969' }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: domainTints[g.domain] || '#7b61ff', display: 'inline-block' }} />
                  {g.domain}
                  <span style={{ color: '#86909c', fontWeight: 400 }}>{count}</span>
                </div>
                {g.roots.map((r) => renderRow(r.id, 0))}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
