import { Alert, Descriptions, Table, Tag, Typography } from 'antd';
import type { CandidateDiff } from './rsiCandidateEvidence';
import { behaviorSummary, BEHAVIOR_EXAMPLES_LIMIT } from './rsiBehaviorSummary';
const detail = (value: unknown) => value == null ? '未记录' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);

const CHANGE_TAG: Record<string, { color: string; label: string }> = {
  fixed: { color: 'green', label: '修好' },
  clarified: { color: 'green', label: '会澄清了' },
  regressed: { color: 'red', label: '新回退' },
  broken: { color: 'red', label: '改坏' },
};

/** Accessible evidence tables also provide a text alternative to graph-only comparison. */
export function RsiCandidateDiff({ data }: { data: CandidateDiff }) {
  // P1③（codex 10-18）：审阅第一眼=具体行为变化；参数 diff/hash/协议折叠为证据
  const behavior = behaviorSummary(data);
  const examples = behavior.changes.slice(0, BEHAVIOR_EXAMPLES_LIMIT);
  const more = behavior.changes.length - examples.length;
  return <div>
    {behavior.sufficient
      ? <Alert showIcon type="success" message="评测上下文有效，可对照下面的行为变化做决定" style={{ marginBottom: 16 }} />
      : <Alert showIcon type="warning" message="证据不足，谨慎采纳" description={behavior.insufficientReason || '该候选的上下文已过期或不完整，请重新评测'} style={{ marginBottom: 16 }} />}

    {/* ── 行为变化例卡（置顶）：原来怎样 → 现在怎样 ── */}
    <Typography.Title level={5} style={{ marginBottom: 8 }}>识别行为变了什么</Typography.Title>
    {behavior.changes.length === 0
      ? <Typography.Paragraph type="secondary">没有可确认的逐题行为变化{behavior.counts.unchanged > 0 ? `——${behavior.counts.unchanged} 道题改前后判分一致` : ''}。方案改动是否有效，请结合下方分数与门禁结论判断。</Typography.Paragraph>
      : <div style={{ display: 'grid', gap: 6, marginBottom: 8 }}>
          {examples.map(c => (
            <div key={c.caseId} style={{ border: `1px solid ${c.kind === 'regressed' ? '#ffd6d6' : '#d6e8d6'}`, borderLeft: `3px solid ${c.kind === 'regressed' ? '#d03b3b' : '#0ca30c'}`, borderRadius: 8, padding: '6px 10px' }}>
              <Tag color={CHANGE_TAG[c.kind]?.color || 'default'} style={{ borderRadius: 4, marginRight: 8 }}>{CHANGE_TAG[c.kind]?.label || c.kind}</Tag>
              <Typography.Text style={{ fontSize: 13 }}>{c.title}</Typography.Text>
              <div><Typography.Text type="secondary" style={{ fontSize: 12 }}>例句「{c.query}」</Typography.Text></div>
            </div>
          ))}
          {more > 0 && <Typography.Text type="secondary" style={{ fontSize: 12 }}>还有 {more} 条行为变化，见下方逐题表格。</Typography.Text>}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            汇总：改善 {behavior.counts.improved} · 回退 {behavior.counts.regressed} · 不变 {behavior.counts.unchanged}{behavior.counts.unmeasured ? ` · 无父代证据 ${behavior.counts.unmeasured}` : ''}
          </Typography.Text>
        </div>}

    {/* ── 证据区（折叠）：参数 diff、hash、评分协议按审阅优先级放后 ── */}
    <Typography.Paragraph>
      <details>
        <summary style={{ cursor: 'pointer', fontWeight: 600, padding: '6px 0' }}>证据：父子资产差异 · {data.changes.length} 处（点开查看参数级改动）</summary>
        <Descriptions column={1} size="small" style={{ marginTop: 8 }} items={[{ key: 'parent', label: '父资产', children: data.parents.join('、') || '未记录' }, { key: 'context', label: '评测上下文', children: <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{detail(data.context)}</pre> }, { key: 'gate', label: '门禁证据', children: <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{detail(data.gate)}</pre> }]} />
        <Table size="small" rowKey={(r, i) => `${r.path}-${i}`} dataSource={data.changes} scroll={{ x: 600 }} pagination={{ pageSize: 8 }} columns={[{ title: '字段', dataIndex: 'path' }, { title: '父资产', dataIndex: 'before', render: v => <pre style={{ whiteSpace: 'pre-wrap', maxWidth: 360 }}>{detail(v)}</pre> }, { title: '候选资产', dataIndex: 'after', render: v => <pre style={{ whiteSpace: 'pre-wrap', maxWidth: 360 }}>{detail(v)}</pre> }]} />
      </details>
    </Typography.Paragraph>

    <Typography.Paragraph>
      <details open={!behavior.sufficient}>
        <summary style={{ cursor: 'pointer', fontWeight: 600, padding: '6px 0' }}>证据：逐题判分对比 · n={data.caseChanges.length}</summary>
        <Typography.Paragraph type="secondary" style={{ marginTop: 8 }}>训练与验证证据来自保存的父子评测记录；不读取独立 test 题内容。父代记录缺失时标为「无父代证据」——不计入改善或回退，也不补造解释（U13 整改）。</Typography.Paragraph>
        <Table size="small" rowKey="case_id" dataSource={data.caseChanges} scroll={{ x: 700 }} pagination={{ pageSize: 10 }} columns={[{ title: '题号', dataIndex: 'case_id' }, { title: '问题', dataIndex: 'query' }, { title: '题型', dataIndex: 'shape' }, { title: '父代判分', render: (_, r) => r.before ? `${r.before.strict === true ? '正确' : r.before.strict === false ? '未完全正确' : '未记录'} · ${r.before.resultType || ''}` : '无父代证据' }, { title: '候选判分', render: (_, r) => r.after ? `${r.after.strict === true ? '正确' : r.after.strict === false ? '未完全正确' : '未记录'} · ${r.after.resultType || ''}` : '未记录' }, { title: '变化', dataIndex: 'change', render: (v, r) => <Tag color={v === 'improved' ? 'green' : v === 'regressed' ? 'red' : undefined}>{({ improved: '改善', regressed: '回退', unchanged: '不变', unmeasured: '无父代证据' } as Record<string, string>)[v] || v}{v === 'unmeasured' ? '' : r?.before ? '' : '（父代记录缺失）'}</Tag> }]} />
      </details>
    </Typography.Paragraph>
  </div>;
}
