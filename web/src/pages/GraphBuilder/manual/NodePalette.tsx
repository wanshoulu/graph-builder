/**
 * 节点类型调色板（画布左侧纵条）——对齐 AI Harbor intent-graph-editor 的 node-palette 拖放建节点：
 *   类型列表从模板 node_types 推导（色块 + 标签）；
 *   拖到画布 = 在落点建节点；单击 = 在视口中心建节点。
 *   拖出即带模板默认值，用户只需修改差异部分。
 */
import { Tooltip } from 'antd';
import type { GraphTemplate } from '@/api/orgGraph';

export const NODE_TYPE_MIME = 'application/x-node-type';

interface NodePaletteProps {
  template: GraphTemplate;
  nodeColors: Record<string, string>;
  onAddNode: (type: string, position?: { x: number; y: number }) => void;
}

export function NodePalette({ template, nodeColors, onAddNode }: NodePaletteProps) {
  return (
    <div
      style={{
        display: 'flex', flexDirection: 'column', gap: 4, padding: '6px 4px',
        borderRight: '1px solid #e5e6eb', background: '#fafafa', overflowY: 'auto',
        minWidth: 52, maxWidth: 52,
      }}
    >
      {template.node_types.map((t) => (
        <Tooltip
          key={t.type}
          title={
            <div style={{ lineHeight: 1.6 }}>
              <div style={{ fontWeight: 600 }}>{t.type}</div>
              <div style={{ fontSize: 11, opacity: 0.8 }}>{t.label}</div>
              <div style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>拖到画布在落点建节点</div>
              <div style={{ fontSize: 11, opacity: 0.6 }}>单击在视口中心建节点</div>
            </div>
          }
          placement="right"
        >
          <div
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(NODE_TYPE_MIME, t.type);
              e.dataTransfer.effectAllowed = 'copy';
            }}
            onClick={() => onAddNode(t.type)}
            style={{
              width: 44, minHeight: 44, borderRadius: 6,
              background: nodeColors[t.type] || '#5B8FF9',
              color: '#fff', display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center',
              fontSize: 10, fontWeight: 600, cursor: 'grab',
              border: '1px solid rgba(0,0,0,.1)', userSelect: 'none',
              padding: '2px 0', gap: 1, flexShrink: 0,
            }}
          >
            <span style={{ fontSize: 14, fontWeight: 700, lineHeight: 1 }}>{t.label.slice(0, 2)}</span>
            <span style={{ fontSize: 8, opacity: 0.85, lineHeight: 1, maxWidth: 40, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {t.type.length > 6 ? t.type.slice(0, 5) + '…' : t.type}
            </span>
          </div>
        </Tooltip>
      ))}
    </div>
  );
}
