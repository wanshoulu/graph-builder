/**
 * 条目详情：在线编辑表单 + 同意图上下文（v4：保存走 PATCH，编辑使既有确认失效——服务端两段式兜底）
 * 拆成三块复用：DetailMeta（状态与上下文）/ DetailForm（编辑表单）/ DetailReviewActions（人工确认动作）
 * —— 网格 Tab 用 DetailDrawer（抽屉），骨架审核 Tab 在右栏内嵌同样的三块
 */
import { useEffect, useState } from "react";
import { Alert, Button, Card, Drawer, Form, Input, Select, Space, Tag, Typography } from "antd";
import { CheckOutlined, CloseOutlined, RollbackOutlined, SaveOutlined } from "@ant-design/icons";
import type { FormInstance } from "antd";
import type { IntakeItem, IntakeRowInput } from "@/api/knowledgeIntake";
import {
  ANSWER_FORM_VALUES,
  CLIENT_CLASS_VALUES,
  FUNC_STATUS_VALUES,
  HEAT_VALUES,
  INTENT_TYPE_COLOR,
  INTENT_TYPE_VALUES,
  INTENT_STATUS_VALUES,
  SECURITY_LEVEL_VALUES,
  UTTER_KIND_VALUES,
  UTTER_SOURCE_VALUES,
  UTTER_STATUS_VALUES,
  statusTag,
  toOptions,
} from "./constants";

const { Text } = Typography;

function renderFields(rowType: IntakeItem["rowType"]) {
  if (rowType === "functions") {
    return (
      <>
        <Form.Item label="功能全路径" name="path" rules={[{ required: true, message: "功能全路径必填" }]}>
          <Input placeholder="如：财富管理/账户查询" />
        </Form.Item>
        <Form.Item label="功能名称" name="name" rules={[{ required: true, message: "功能名称必填（需与路径末段一致）" }]}>
          <Input />
        </Form.Item>
        <Form.Item label="业务描述" name="description" rules={[{ min: 10, message: "至少 10 字，按三段式写全" }]}>
          <Input.TextArea rows={2} />
        </Form.Item>
        <Form.Item label="客户分类" name="clientClass"><Select options={toOptions(CLIENT_CLASS_VALUES)} /></Form.Item>
        <Form.Item label="安全分级" name="securityLevel"><Select options={toOptions(SECURITY_LEVEL_VALUES)} /></Form.Item>
        <Form.Item label="责任部门" name="department" rules={[{ required: true, message: "责任部门必填" }]}>
          <Input placeholder="如：数字金融部" />
        </Form.Item>
        <Form.Item label="业务状态" name="status" extra="业务侧口径（启用/停用），不等于平台确认">
          <Select options={toOptions(FUNC_STATUS_VALUES)} />
        </Form.Item>
        <Form.Item label="备注" name="note"><Input /></Form.Item>
      </>
    );
  }
  if (rowType === "intents") {
    return (
      <>
        <Form.Item label="意图名称" name="name" rules={[{ required: true, message: "意图名称必填" }]}>
          <Input />
        </Form.Item>
        <Form.Item label="所属功能全路径" name="funcPath" rules={[{ required: true, message: "所属功能必填（需已登记）" }]}>
          <Input placeholder="如：财富管理/账户查询" />
        </Form.Item>
        <Form.Item label="意图类型" name="intentType"><Select options={toOptions(INTENT_TYPE_VALUES)} /></Form.Item>
        <Form.Item label="业务描述" name="description" rules={[{ min: 10, message: "至少 10 字，按三段式写全" }]}>
          <Input.TextArea rows={2} />
        </Form.Item>
        <Form.Item label="用户目标" name="goal" extra="入图 goal 字段；留空时以业务描述充">
          <Input.TextArea rows={2} placeholder="如：确认本人账户实时余额" />
        </Form.Item>
        <Form.Item label="触发场景" name="triggerScene"><Input /></Form.Item>
        <Form.Item label="范围边界-包含" name="scopeIn"><Input.TextArea rows={2} /></Form.Item>
        <Form.Item label="范围边界-排除" name="scopeOut"><Input.TextArea rows={2} /></Form.Item>
        <Form.Item label="易混意图" name="confusableIntents" extra="分号分隔其他意图名称，如：查询转账限额；入图时解析不到的丢弃">
          <Input placeholder="如：查询转账限额;修改转账限额" />
        </Form.Item>
        <Form.Item label="涉及角色" name="roles"><Input /></Form.Item>
        <Form.Item label="涉及业务对象" name="businessObjects"><Input /></Form.Item>
        <Form.Item label="关键要素" name="keySlots"><Input /></Form.Item>
        <Form.Item label="答案形态" name="answerForm"><Select options={toOptions(ANSWER_FORM_VALUES)} /></Form.Item>
        <Form.Item label="热度" name="heat"><Select options={toOptions(HEAT_VALUES)} /></Form.Item>
        <Form.Item label="业务状态" name="status" extra="业务侧口径（草稿/生效/停用），不等于平台确认">
          <Select options={toOptions(INTENT_STATUS_VALUES)} />
        </Form.Item>
        <Form.Item label="意图编码" name="code"><Input /></Form.Item>
        <Form.Item label="备注" name="note"><Input /></Form.Item>
      </>
    );
  }
  return (
    <>
      <Form.Item label="意图标识" name="intentRef" rules={[{ required: true, message: "意图标识必填（需已登记）" }]}>
        <Input placeholder="如：财富管理/账户查询/查询账户余额" />
      </Form.Item>
      <Form.Item label="说法类型" name="kind"><Select options={toOptions(UTTER_KIND_VALUES)} /></Form.Item>
      <Form.Item label="说法文本" name="text" rules={[{ required: true, min: 2, max: 50, message: "长度需在 2~50 字之间" }]}>
        <Input.TextArea rows={2} />
      </Form.Item>
      <Form.Item label="来源" name="source"><Select options={toOptions(UTTER_SOURCE_VALUES)} /></Form.Item>
      <Form.Item label="置信度" name="confidence" extra="0~1 的数值，仅作 AI 建议参考">
        <Input placeholder="留空表示人工编写" />
      </Form.Item>
      <Form.Item label="业务状态" name="status" extra="业务侧口径（已审核/候选/驳回），不等于平台确认">
        <Select options={toOptions(UTTER_STATUS_VALUES)} />
      </Form.Item>
      <Form.Item label="审核意见" name="reviewNote" extra="业务状态为「驳回」时必填">
        <Input.TextArea rows={2} />
      </Form.Item>
      <Form.Item label="备注" name="note"><Input /></Form.Item>
    </>
  );
}

/** 状态行 + 意图上下文 + 同意图说法列表 */
export function DetailMeta({ item, intentContext, siblings }: { item: IntakeItem; intentContext: IntakeItem | null; siblings: IntakeItem[] }) {
  return (
    <Space direction="vertical" size={12} style={{ width: "100%" }}>
      <Space>
        {statusTag(item.status)}
        {item.sourceStatus && <Tag>业务状态：{item.sourceStatus}</Tag>}
        {item.rowType === "intents" && item.ref && <Tag style={{ marginInlineEnd: 0 }}>{item.ref}</Tag>}
      </Space>

      {item.rowType === "utterances" && (
        intentContext ? (
          <Card size="small" title="所属意图上下文">
            <Space direction="vertical" size={2}>
              <Space wrap>
                <Text strong>{intentContext.name}</Text>
                {intentContext.intentType && <Tag color={INTENT_TYPE_COLOR[intentContext.intentType] || "default"}>{intentContext.intentType}</Tag>}
                <Tag>{intentContext.answerForm}</Tag>
                <Tag>{intentContext.heat}</Tag>
              </Space>
              <Text type="secondary">{intentContext.description}</Text>
            </Space>
          </Card>
        ) : (
          <Alert type="warning" showIcon message="未找到该说法挂接的意图（可能导入时该意图行未入库）" />
        )
      )}

      {(item.rowType === "utterances" || item.rowType === "intents") && (
        <Card size="small" title={`同一意图下的全部说法（${siblings.length}）`}>
          <Space direction="vertical" size={4} style={{ width: "100%" }}>
            {siblings.length === 0 && <Text type="secondary">该意图还没有说法（可用「LLM 补全扩展问」生成）</Text>}
            {siblings.map((sib) => (
              <Space
                key={sib.rowId}
                wrap
                style={{
                  padding: "2px 6px",
                  background: sib.rowId === item.rowId ? "#e6f4ff" : undefined,
                  borderRadius: 4,
                  width: "100%",
                }}
              >
                <Tag color={sib.kind === "标问" ? "blue" : "default"}>{sib.kind}</Tag>
                <Text strong={sib.rowId === item.rowId}>{sib.text}</Text>
                <Text type="secondary">{sib.source}{sib.confidence != null ? ` · ${sib.confidence.toFixed(2)}` : ""}</Text>
                {statusTag(sib.status)}
              </Space>
            ))}
          </Space>
        </Card>
      )}
    </Space>
  );
}

/** 编辑表单 + 保存（编辑已确认行走服务端降级） */
export function DetailForm({
  form, item, saving, onSave,
}: {
  form: FormInstance;
  item: IntakeItem;
  saving: boolean;
  onSave: (rowId: string, patch: IntakeRowInput) => Promise<string>;
}) {
  const [saveError, setSaveError] = useState("");

  useEffect(() => {
    setSaveError("");
    // 表单的「业务状态」取业务口径；item.status 是平台口径（approved/pending/rejected），不能回填表单
    if (item) form.setFieldsValue({ ...item, status: item.sourceStatus ?? item.status });
  }, [item?.rowId, item, form]);

  const handleSave = async () => {
    if (!item) return;
    const patch = (await form.validateFields()) as IntakeRowInput;
    setSaveError(await onSave(item.rowId, patch));
  };

  return (
    <>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="直接修改字段后保存；改名/改路径会自动重挂子级（如意图改名，其说法跟随迁移），且平台确认状态会失效退回待确认。"
      />
      <Form form={form} layout="vertical" size="small">
        {renderFields(item.rowType)}
      </Form>
      {saveError && <Alert type="error" showIcon style={{ marginBottom: 12 }} message={saveError} />}
      <Space>
        <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={handleSave}>
          保存修改
        </Button>
        {item.status === "approved" && (
          <Text type="secondary" style={{ fontSize: 12 }}>已确认行保存后会退回「待确认」</Text>
        )}
      </Space>
    </>
  );
}

/** 人工确认动作（两段式：approved 只能经 review 端点产生） */
export function DetailReviewActions({
  item, onReview, onReject,
}: {
  item: IntakeItem;
  onReview: (action: "approve" | "reject" | "reset", note: string, ids: string[]) => void;
  onReject: (ids: string[]) => void;
}) {
  return (
    <Space>
      {item.status !== "approved" && (
        <Button type="primary" ghost icon={<CheckOutlined />} onClick={() => onReview("approve", "", [item.rowId])}>
          确认
        </Button>
      )}
      {item.status === "rejected" ? (
        <Button icon={<RollbackOutlined />} onClick={() => onReview("reset", "", [item.rowId])}>
          撤回重审
        </Button>
      ) : (
        <Button danger icon={<CloseOutlined />} onClick={() => onReject([item.rowId])}>
          驳回
        </Button>
      )}
    </Space>
  );
}

interface DetailDrawerProps {
  item: IntakeItem | null;
  intentContext: IntakeItem | null;
  siblings: IntakeItem[];
  saving: boolean;
  /** 保存编辑：返回空串表示成功，否则返回可内联展示的错误信息 */
  onSave: (rowId: string, patch: IntakeRowInput) => Promise<string>;
  onClose: () => void;
  onReview: (action: "approve" | "reject" | "reset", note: string, ids: string[]) => void;
  onReject: (ids: string[]) => void;
}

export function DetailDrawer({ item, intentContext, siblings, saving, onSave, onClose, onReview, onReject }: DetailDrawerProps) {
  const [form] = Form.useForm();
  const rowType = item?.rowType;

  return (
    <Drawer
      title={item ? "条目详情 · 查看 / 编辑" : "条目详情"}
      width={560}
      open={!!item}
      onClose={onClose}
      destroyOnHidden
      footer={
        item && (
          <Space style={{ width: "100%", justifyContent: "space-between" }}>
            <DetailReviewActions item={item} onReview={onReview} onReject={onReject} />
            <Text type="secondary" style={{ fontSize: 12 }}>
              {item.status === "approved" ? "已确认行保存后会退回「待确认」" : ""}
            </Text>
          </Space>
        )
      }
    >
      {item && rowType && (
        <Space direction="vertical" size={16} style={{ width: "100%" }}>
          <DetailMeta item={item} intentContext={intentContext} siblings={siblings} />
          <DetailForm form={form} item={item} saving={saving} onSave={onSave} />
        </Space>
      )}
    </Drawer>
  );
}
