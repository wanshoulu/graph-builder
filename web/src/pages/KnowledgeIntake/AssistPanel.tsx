/**
 * AI 骨架助手抽屉（四件套：查漏 / 疑似重复 / 命名规范 / 歧义风险）
 * 每条建议 = AI 的理由 + 建议动作，裁决权在人；采纳后的变更仍以「待确认」进入骨架（两段式不破）
 */
import { Alert, Button, Collapse, Drawer, Empty, Space, Tag, Typography } from "antd";
import { AimOutlined, CheckOutlined, CloseOutlined, RobotOutlined, ThunderboltOutlined } from "@ant-design/icons";
import type { AssistGetResult, AssistItem, AssistKind } from "@/api/knowledgeIntake";
import { ASSIST_KIND_META, ASSIST_STATUS_META } from "./constants";

const { Text } = Typography;

/** 建议条目 → 骨架树定位标识（gaps 指向父功能路径，其余指向意图 ref） */
export function assistLocateUnit(item: AssistItem): string | undefined {
  const p = item.payload;
  if (item.kind === "gaps") return p.path;
  return p.ref || (p.refs || [])[0];
}

function assistItemView(
  item: AssistItem,
  deciding: boolean,
  onDecide: (action: "accept" | "dismiss", item: AssistItem) => void,
  onLocate?: (item: AssistItem) => void,
) {
  const p = item.payload;
  const decided = item.status !== "suggested";
  const locatable = !!assistLocateUnit(item);
  return (
    <div
      key={item.id}
      style={{ padding: "8px 0", borderBottom: "1px dashed #f0f0f0", opacity: decided ? 0.65 : 1 }}
    >
      <Space direction="vertical" size={4} style={{ width: "100%" }}>
        <Space wrap size={6}>
          {(() => {
            if (item.kind === "gaps") {
              return p.type === "subdomain"
                ? <Text strong>补充子域「{p.path}」</Text>
                : <Text strong>补充意图「{p.name}」→ {p.path}</Text>;
            }
            if (item.kind === "duplicates") {
              return <Text strong>「{(p.refs || [])[0]}」≈「{(p.refs || [])[1]}」建议合并</Text>;
            }
            if (item.kind === "naming") {
              return <Text strong>改名：{p.ref?.split("/").pop()} → {p.suggestion}</Text>;
            }
            return <Text strong>{(p.refs || []).join(" 与 ")} 语义重叠</Text>;
          })()}
          <Tag color={ASSIST_STATUS_META[item.status].color} style={{ marginInlineEnd: 0 }}>
            {ASSIST_STATUS_META[item.status].label}
          </Tag>
        </Space>
        <Text type="secondary">
          {item.kind === "gaps" && (p.description || "")}
          {item.kind === "gaps" && p.reason ? `（理由：${p.reason}）` : ""}
          {item.kind === "duplicates" && `理由：${p.reason || "名称/语义相近"}`}
          {item.kind === "naming" && `问题：${p.issue || "命名不规范"}`}
          {item.kind === "ambiguities" && `重叠点：${p.overlap || "边界含混"}${p.suggestion ? `；建议：${p.suggestion}` : ""}`}
        </Text>
        {item.kind === "duplicates" && (
          <Text type="secondary" style={{ fontSize: 12 }}>采纳后：说法并入主意图，重复意图行转「已驳回」留痕</Text>
        )}
        {item.kind === "naming" && (
          <Text type="secondary" style={{ fontSize: 12 }}>采纳后：意图改名并自动重接其说法，仍为「待确认」</Text>
        )}
        {item.blockReason && <Text type="danger" style={{ fontSize: 12 }}>上次采纳被挡：{item.blockReason}</Text>}
        {!decided && (
          <Space size={8}>
            <Button type="primary" size="small" icon={<CheckOutlined />} loading={deciding} onClick={() => onDecide("accept", item)}>
              采纳
            </Button>
            <Button size="small" icon={<CloseOutlined />} loading={deciding} onClick={() => onDecide("dismiss", item)}>
              忽略
            </Button>
            {locatable && onLocate && (
              <Button type="link" size="small" icon={<AimOutlined />} style={{ padding: 0 }} onClick={() => onLocate(item)}>
                定位
              </Button>
            )}
          </Space>
        )}
        {decided && item.decidedBy && (
          <Text type="secondary" style={{ fontSize: 12 }}>{item.decidedBy} 于 {item.decidedAt?.slice(0, 16).replace("T", " ")} 裁决</Text>
        )}
      </Space>
    </div>
  );
}

interface AssistDrawerProps {
  open: boolean;
  onClose: () => void;
  data: AssistGetResult | null;
  running: boolean;
  deciding: string[];
  onRun: () => void;
  onDecide: (action: "accept" | "dismiss", item: AssistItem) => void;
  /** 「定位」：跳到骨架审核定位建议指向的节点 */
  onLocate?: (item: AssistItem) => void;
}

export function AssistDrawer({ open, onClose, data, running, deciding, onRun, onDecide, onLocate }: AssistDrawerProps) {
  return (
    <Drawer
      title={
        <Space>
          <RobotOutlined />
          AI 骨架助手（建议 · 人工裁决）
        </Space>
      }
      width={620}
      open={open}
      onClose={onClose}
      footer={
        <Space>
          <Button type="primary" icon={<ThunderboltOutlined />} loading={running} onClick={onRun}>
            {data?.summary.total ? "重新评审骨架" : "AI 评审当前骨架"}
          </Button>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {data?.generatedAt ? `上次评审：${data.generatedAt.slice(0, 16).replace("T", " ")}` : "还没有评审过"}
          </Text>
        </Space>
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="AI 只给建议，不做决定：采纳后变更仍以「待确认」进入骨架，必须人工确认才会入图"
      />
      {!data || data.summary.total === 0 ? (
        <Empty
          description={
            <Space direction="vertical" size={2}>
              <Text>还没有 AI 建议</Text>
              <Text type="secondary">点右下角按钮，让 AI 对照骨架做一次查漏 / 去重 / 规范化 / 歧义标注</Text>
            </Space>
          }
        />
      ) : (
        <Collapse
          defaultActiveKey={(Object.keys(data.grouped) as AssistKind[]).filter((k) => data.grouped[k].items.length)}
          items={(Object.keys(data.grouped) as AssistKind[]).map((kind) => {
            const group = data.grouped[kind];
            const meta = ASSIST_KIND_META[kind];
            const stat = data.summary.byKind[kind];
            return {
              key: kind,
              label: (
                <Space size={6}>
                  <Tag color={meta.color} style={{ marginInlineEnd: 0 }}>{meta.label}</Tag>
                  <Text>{group.items.length} 条</Text>
                  {stat.open > 0 && <Tag color="blue" style={{ marginInlineEnd: 0 }}>{stat.open} 条待裁决</Tag>}
                  {stat.accepted > 0 && <Tag color="green" style={{ marginInlineEnd: 0 }}>已采纳 {stat.accepted}</Tag>}
                  <Text type="secondary" style={{ fontSize: 12 }}>{meta.hint}</Text>
                </Space>
              ),
              children: group.items.length ? (
                <>{group.items.map((item) => assistItemView(item, deciding.includes(item.id), onDecide, onLocate))}</>
              ) : (
                <Text type="secondary">AI 未发现此类问题</Text>
              ),
            };
          })}
        />
      )}
    </Drawer>
  );
}
