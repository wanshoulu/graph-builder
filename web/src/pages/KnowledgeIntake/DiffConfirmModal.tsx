/**
 * 编辑保存前的 diff 确认弹窗（Word 修订式：旧值删除线红 → 新值蓝）
 * 仅展示有变化的字段；确认后才真正提交 —— 「修改有痕迹，生效须确认」
 */
import { Empty, Modal, Space, Typography } from "antd";

const { Text } = Typography;

export interface DiffEntry {
  label: string;
  before: string;
  after: string;
}

interface DiffConfirmModalProps {
  open: boolean;
  title?: string;
  entries: DiffEntry[];
  confirmLoading?: boolean;
  onOk: () => void;
  onCancel: () => void;
}

export function DiffConfirmModal({ open, title = "确认修改", entries, confirmLoading, onOk, onCancel }: DiffConfirmModalProps) {
  return (
    <Modal
      open={open}
      title={title}
      okText="确认修改"
      cancelText="再改改"
      okButtonProps={{ danger: false }}
      confirmLoading={confirmLoading}
      onOk={onOk}
      onCancel={onCancel}
      width={520}
    >
      <Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 10 }}>
        以下字段将被修改（删除线为旧值，蓝色为新值），确认后生效并记入修订痕迹：
      </Text>
      {entries.length === 0 ? (
        <Empty description="没有字段变化" imageStyle={{ height: 48 }} />
      ) : (
        <Space direction="vertical" size={8} style={{ width: "100%" }}>
          {entries.map((entry) => (
            <div key={entry.label} style={{ borderLeft: "3px solid #91caff", background: "#f0f7ff", borderRadius: 6, padding: "6px 10px" }}>
              <Text type="secondary" style={{ fontSize: 12, marginInlineEnd: 8 }}>{entry.label}</Text>
              <span style={{ color: "#ef4444", textDecoration: "line-through", wordBreak: "break-all" }}>{entry.before || "（空）"}</span>
              <span style={{ margin: "0 6px", color: "rgba(0,0,0,0.45)" }}>→</span>
              <span style={{ color: "#1677ff", borderBottom: "2px solid #91caff", wordBreak: "break-all" }}>{entry.after || "（空）"}</span>
            </div>
          ))}
        </Space>
      )}
    </Modal>
  );
}
