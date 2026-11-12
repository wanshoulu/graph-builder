/**
 * 连线候选选型模态：多候选时弹出（单候选智能直连不弹）——对齐 AI Harbor intent-graph-editor
 * 的 openEdgeModalWithNodes「新增边」模态；候选列表来自 lib/edgeRules 的模板推导。
 * Q5: 集成 AI 边类型推荐，按匹配度排序并标注推荐理由。
 */
import { useEffect, useState } from 'react';
import { Modal, Radio, Space, Tag, Tooltip } from 'antd';
import type { GraphTemplate } from '@/api/orgGraph';
import type { EdgeTypeRecommendation } from '../lib/edgeRules';

interface SelectEdgeTypeModalProps {
  open: boolean;
  template: GraphTemplate;
  candidates: string[];
  recommendations?: EdgeTypeRecommendation[];
  sourceName: string;
  targetName: string;
  onClose: () => void;
  onConfirm: (edgeType: string) => void;
}

export function SelectEdgeTypeModal({ open, template, candidates, recommendations, sourceName, targetName, onClose, onConfirm }: SelectEdgeTypeModalProps) {
  const [picked, setPicked] = useState<string>('');

  // 按推荐排序后的候选列表
  const sortedCandidates = recommendations && recommendations.length > 0
    ? recommendations.map(r => r.type)
    : candidates;

  useEffect(() => {
    if (open && sortedCandidates.length) setPicked(sortedCandidates[0]);
  }, [open, sortedCandidates]);

  const edgeTypeName = (type: string) => {
    const def = template.edge_types.find((e) => e.type === type);
    return def ? `${def.label || type}（${type}）` : type;
  };

  const getRecommendation = (type: string) => recommendations?.find(r => r.type === type);

  return (
    <Modal
      open={open}
      title="选择边类型"
      okText="创建边"
      cancelText="取消"
      okButtonProps={{ disabled: !picked }}
      onOk={() => picked && onConfirm(picked)}
      onCancel={onClose}
      width={480}
    >
      <div style={{ fontSize: 12, color: '#4e5969', marginBottom: 10 }}>
        {sourceName} → {targetName}：模板允许 {candidates.length} 种边类型，请选择：
      </div>
      <Radio.Group onChange={(e) => setPicked(e.target.value)} value={picked}>
        <Space direction="vertical">
          {sortedCandidates.map((c) => {
            const rec = getRecommendation(c);
            const isTop = rec && recommendations && recommendations[0].type === c && rec.score > 30;
            return (
              <Radio key={c} value={c}>
                <span>
                  {edgeTypeName(c)}
                  {isTop && (
                    <Tag color="green" style={{ marginLeft: 6, fontSize: 10 }}>
                      推荐 {rec.score}分
                    </Tag>
                  )}
                  {rec && rec.reason && rec.reason !== '默认推荐' && (
                    <Tooltip title={rec.reason}>
                      <Tag style={{ marginLeft: 4, fontSize: 10, color: '#86909c', borderColor: '#d9d9d9' }}>
                        {rec.reason}
                      </Tag>
                    </Tooltip>
                  )}
                </span>
              </Radio>
            );
          })}
        </Space>
      </Radio.Group>
      {recommendations && recommendations.length > 1 && recommendations[0].score > 30 && (
        <div style={{ marginTop: 8, fontSize: 11, color: '#52c41a' }}>
          AI推荐：{edgeTypeName(recommendations[0].type)}（匹配度 {recommendations[0].score}%）
        </div>
      )}
    </Modal>
  );
}
