/**
 * 大图预览弹窗：G6 v5 力导向渲染（类型配色/度数大小/邻接聚焦），替代 vis-network 简版预览
 */
import { Modal } from 'antd';
import type { GraphDocument, GraphTemplate } from '@/api/orgGraph';
import { G6PreviewCanvas } from './G6PreviewCanvas';

interface GraphPreviewModalProps {
  open: boolean;
  title?: string;
  document: GraphDocument | null;
  /** 模板（类型配色与主标签字段依据；缺省用节点 name） */
  template?: GraphTemplate | null;
  onClose: () => void;
}

export function GraphPreviewModal({ open, title, document, template, onClose }: GraphPreviewModalProps) {
  return (
    <Modal
      open={open}
      title={title || '图谱预览'}
      onCancel={onClose}
      footer={null}
      width={960}
      destroyOnHidden
    >
      <div style={{ height: 560 }}>
        {open && <G6PreviewCanvas document={document} template={template} height={520} />}
      </div>
    </Modal>
  );
}
