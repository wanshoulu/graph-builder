/**
 * 运行页集中摘要卡（codex 2026-10-18 复审 P1②）：
 * 回答"是否正常、还在做什么"——放在运行记录页顶部，四个读数 + 最近活动。
 * 数字口径都在 note 里说明，不写预计完成时间（没有可靠模型）。
 */
import { Card, List, Tooltip, Typography } from 'antd';
import type { RsiState } from './rsiShared';
import { runSummary } from './rsiRunSummary';
import { COLOR, TYPE } from './rsiDesign';
import { humanize } from './rsiShared';

export function RsiRunSummaryCard({ state }: { state: RsiState }) {
  const { items, recent } = runSummary(state);
  return (
    <Card size="small" style={{ marginBottom: 16 }} title="本次运行概要" extra={<Typography.Text type="secondary" style={{ fontSize: TYPE.micro }}>刷新页面不影响后台运行</Typography.Text>}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
        {items.map(it => (
          <div key={it.label}>
            <Typography.Text type="secondary" style={{ fontSize: TYPE.micro }}>{it.label}</Typography.Text>
            <div style={{ fontSize: 20, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: COLOR.textPrimary, lineHeight: 1.4 }}>
              {it.note ? <Tooltip title={it.note}><span style={{ borderBottom: `1px dashed ${COLOR.gridLine}`, cursor: 'help' }}>{it.value}</span></Tooltip> : it.value}
            </div>
          </div>
        ))}
      </div>
      {recent.length > 0 && (
        <div style={{ marginTop: 12, borderTop: `1px dashed ${COLOR.gridLine}`, paddingTop: 8 }}>
          <Typography.Text type="secondary" style={{ fontSize: TYPE.micro }}>最近活动</Typography.Text>
          <List
            size="small"
            dataSource={recent}
            renderItem={l => (
              <List.Item style={{ padding: '4px 0', fontSize: TYPE.small }}>
                <Typography.Text type="secondary">[{l.at.replace('T', ' ').slice(5, 19)}] {humanize(l.detail)}</Typography.Text>
              </List.Item>
            )}
          />
        </div>
      )}
    </Card>
  );
}
