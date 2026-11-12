import { Button, Tag, Typography } from 'antd';
import { ArrowRightOutlined } from '@ant-design/icons';
import { OP_ACTION, FAMILY_INFO, type RsiState } from './rsiShared';
import { taskOverview } from './rsiTaskOverviewModel';
import { COLOR, MetricCard, SectionTitle } from './rsiDesign';
import './rsiTaskOverview.css';

type RecallMetrics = NonNullable<NonNullable<RsiState['baseline']>['recallMetrics']>;
type AdjudicationMetrics = NonNullable<NonNullable<RsiState['baseline']>['adjudicationMetrics']>;
function RecallPrecisionPanel({recall}: {recall: RecallMetrics | null}){
 if(!recall||!recall.total) return null;
 const ch=recall.channels;
 if(!ch) return null;
 const channels=[
  {key:'lexical',label:'关键词召回',hit:ch.lexical?.hit1??0,pct:ch.lexical?.top1_pct??0,color:'#52c41a'},
  {key:'vector',label:'向量召回',hit:ch.vector?.hit1??0,pct:ch.vector?.top1_pct??0,color:'#1890ff'},
  {key:'subgraph',label:'图召回',hit:ch.subgraph?.hit1??0,pct:ch.subgraph?.top1_pct??0,color:'#722ed1'},
  {key:'final',label:'最终精度',hit:ch.final?.hit1??0,pct:ch.final?.top1_pct??0,color:'#fa8c16'},
 ];
 return <section className="rsi-recall-panel"><SectionTitle hint={`各召回通道 top-1 命中率 · 共 ${recall.total} 题`}>多路召回精度</SectionTitle>
  <div className="rsi-recall-bars">{channels.map(c=><div className="rsi-recall-row" key={c.key}>
   <div className="rsi-recall-label"><span>{c.label}</span><b>{c.pct.toFixed(1)}%</b><small>{c.hit}/{recall.total}</small></div>
   <div className="rsi-recall-track" role="progressbar" aria-label={c.label} aria-valuenow={c.pct} aria-valuemin={0} aria-valuemax={100}><i style={{width:`${Math.max(0,Math.min(100,c.pct))}%`,background:c.color}}/></div>
  </div>)}</div>
 </section>;
}
function AdjudicationPanel({adj}: {adj: AdjudicationMetrics | null}){
 if(!adj||!adj.total) return null;
 const cells=[{label:'LLM 触发空间',value:`${adj.triggered_pct.toFixed(1)}%`,sub:`${adj.triggered}/${adj.total} 题`,color:adj.triggered_pct>30?'#fa8c16':'#8c8c8c'},
  {label:'潜在修复',value:`+${adj.potential_fixes_pct.toFixed(1)}%`,sub:`${adj.potential_fixes} 题`,color:'#52c41a'},
  {label:'潜在退步风险',value:`-${adj.potential_regressions_pct.toFixed(1)}%`,sub:`${adj.potential_regressions} 题`,color:'#ff4d4f'},
  {label:'净增益估计',value:`${adj.net_gain_estimate>=0?'+':''}${adj.net_gain_estimate} 题`,sub:adj.net_gain_estimate>0?'值得接入 LLM 裁决':adj.net_gain_estimate===0?'增益有限':'可能得不偿失',color:adj.net_gain_estimate>0?'#52c41a':adj.net_gain_estimate<0?'#ff4d4f':'#8c8c8c'}];
 return <section className="rsi-adjudication-panel"><SectionTitle hint="LLM 裁决介入空间评估 · 基于引擎触发条件离线推导">模型裁决精度</SectionTitle>
  <div className="rsi-adjudication-grid">{cells.map(c=><div className="rsi-adjudication-cell" key={c.label}><span className="rsi-adjudication-label">{c.label}</span><b style={{color:c.color}}>{c.value}</b><small>{c.sub}</small></div>)}</div>
 </section>;
}

export function RsiTaskOverview({state,baselineCurrent,pendingCount,adoptableCount,busy,onAction,onSection}:{
 state:RsiState;baselineCurrent:boolean;pendingCount:number;adoptableCount:number;busy:string;
 onAction:(key:string)=>void;onSection:(key:string)=>void;
}){
 const s=state.split,b=state.baseline,total=s.trainCount+s.heldoutCount+(s.testCount||0);
 const view=taskOverview({running:!!state.evolveRunning,caseCount:total,hasBaseline:!!b,baselineCurrent,pendingCount,adoptableCount,drift:!!state.integrity.drift});
 const act=()=>view.action==='data'?onSection('data'):view.action==='runs'?onSection('runs'):onAction(view.action);
 const completedRuns=state.evolveRuns||[],lastRun=state.activeEvolution||completedRuns[completedRuns.length-1];
 const runLabel=state.evolveRunning?'正在运行':lastRun?({stopped:'已停止',interrupted:'已中断',error:'运行失败',complete:'已结束',completed:'已结束',done:'已结束',awaiting_human:'等待审阅',no_adopt:'未产生可采纳方案',running:'已中断'}[lastRun.status||'']||'已有运行记录'):'尚未运行';
 const adopted=state.archive.filter(p=>p.status==='adopted').length;
 // 分题型分数（识别效果卡用，从 baseline.goal.byShape 取）
 const byShape=b?.goal?.byShape||[];
 const shapeLabel:Record<string,string>={single_intent:'单意图',multi_intent:'多意图',ambiguous_intent:'模糊意图'};
 return <div className="rsi-overview">
  <section className="rsi-next-action" aria-labelledby="rsi-next-title">
   <div className="rsi-next-copy">
    <div className="rsi-next-eyebrow"><span>任务状态</span><Tag color={state.evolveRunning?'processing':baselineCurrent?'blue':'gold'}>{view.status}</Tag></div>
    <h2 id="rsi-next-title">{state.evolveRunning?'正在寻找更好的识别方案':view.action==='baseline'?'先确认当前版本的识别效果':view.action==='data'?'先准备可用于判断效果的题目':view.action==='review'?'查看改进证据，再决定是否采纳':'用当前错误启动下一轮改进'}</h2>
    <p>{view.hint}</p>
    {view.action==='baseline'&&b&&<details className="rsi-evidence-note"><summary>为什么旧成绩不能继续使用？</summary><p>{state.scoreValidity?.reasons?.join('；')||state.scoreValidity?.reason||'当前版本与历史评测证据不一致。重新评测后才可恢复效果比较和方案采纳。'}</p></details>}
   </div>
   <Button type="primary" size="large" icon={<ArrowRightOutlined />} loading={!!busy&&view.action===busy} disabled={!!busy&&view.action!==busy} onClick={act}>{view.label}</Button>
  </section>

  <div className="rsi-summary-grid">
   <MetricCard
     title={state.goal?`当前识别效果 · 目标 ${state.goal.target}%`:'当前识别效果'}
     value={view.scoreAvailable&&b?b.scores.all.strict_pct:'待评测'}
     suffix={view.scoreAvailable&&b?'%':undefined}
     precision={1}
     color={COLOR.strict}
     accent={view.scoreAvailable}
     emphasis="hero"
     sub={view.scoreAvailable&&b?`优化题与验证题共 ${b.scores.all.total} 道，按完全正确计分。`:b?`历史参考 ${b.scores.all.strict_pct.toFixed(1)}%，不代表当前效果。`:'评测后显示正确率与识别错误。'}
     extra={<>
       {state.goal&&<div style={{marginBottom:8}}>{state.goal.met?<Tag color="green">已达标</Tag>:state.goal.missingCases!=null?<>距目标还差 <b>{state.goal.missingCases}</b> 题（{state.goal.gapPts}pp）；现有手段估算上限 {state.goal.ceilingPct}%{state.goal.reachable===false&&<Tag color="orange" style={{marginLeft:6}}>需扩动作空间</Tag>}</>:'评测后显示与目标的差距'}</div>}
       {byShape.length>0&&<div style={{display:'flex',gap:12,flexWrap:'wrap',marginBottom:8}}>
         {byShape.map(sh=>(<span key={sh.shape} style={{fontSize:12,color:COLOR.textSecondary}}>
           {shapeLabel[sh.shape]||sh.shape} <b style={{color:COLOR.textPrimary,fontVariantNumeric:'tabular-nums'}}>{sh.correct}/{sh.total}</b>
           {sh.failed>0&&<span style={{color:COLOR.bad,marginLeft:4}}>×{sh.failed}</span>}
         </span>))}
       </div>}
       {!!state.goal?.byFamily?.length&&<div style={{fontSize:12,opacity:.75,marginBottom:8}}>主要缺口：{state.goal.byFamily.slice(0,2).map(f=>`${f.label} ${f.count} 题`).join(' · ')}</div>}
       <Button type="link" onClick={()=>onSection('data')}>查看评测与题目</Button>
     </>}
   />
   <MetricCard
     title="等待审阅"
     value={pendingCount}
     suffix=" 个方案"
     color={pendingCount>0?COLOR.warning:COLOR.textTertiary}
     accent={pendingCount>0}
     sub={pendingCount?`${adoptableCount} 个可采纳 · ${pendingCount-adoptableCount} 个需验证或处理。`:'优化产生的方案会在这里等待审阅。'}
     extra={<Button type="link" onClick={()=>onSection('candidates')}>查看改进方案</Button>}
   />
   <MetricCard
     title={state.evolveRunning?'当前运行':'最近一次运行'}
     value={runLabel}
     color={state.evolveRunning?COLOR.accent:COLOR.textTertiary}
     accent={!!state.evolveRunning}
     sub={state.evolveRunning?'运行进度以服务端记录为准。':lastRun?'运行结束或中断均不代表方案已采纳。':'配置运行上限后，才会开始生成与验证方案。'}
     extra={<Button type="link" onClick={()=>onSection('runs')}>{lastRun||state.evolveRunning?'查看运行记录与 DAG':'了解运行记录'}</Button>}
   />
  </div>

  {(b?.recallMetrics||b?.adjudicationMetrics)&&<div className="rsi-dashboard-metrics-grid">
   {b?.recallMetrics&&<RecallPrecisionPanel recall={b.recallMetrics}/>}
   {b?.adjudicationMetrics&&<AdjudicationPanel adj={b.adjudicationMetrics}/>}
  </div>}

  {/* ── 搜索空间与策略洞察：已探索/已证否/有杠杆/未尝试 ── */}
  {(() => {
    const strat = state.strategy;
    if (!strat || strat.error || (strat.candidateCount === 0 && strat.runCount === 0)) return null;
    const nextActions = state.goal?.nextActions || [];
    const leverage = (strat.leverage || []).filter(l => l.failedCases > 0);
    const deadOps = strat.deadOperators || [];
    const untriedOps = strat.untriedOperators || [];
    const opLabel = (key: string) => strat.operators?.find(o => o.operator === key)?.label || OP_ACTION[key] || key;
    return <section className="rsi-strategy-insight">
      <SectionTitle hint="从历史运行折叠出的搜索空间状态：哪些改法有效、哪些被证否、还有哪些没试过。">搜索空间与策略洞察</SectionTitle>

      <div className="rsi-strategy-stats">
        <span><b>{strat.measuredCount}</b> 已测候选</span>
        <span><b>{strat.promotedCount}</b> 已采纳</span>
        <span><b>{deadOps.length}</b> 已证否算子</span>
        <span><b>{untriedOps.length}</b> 未尝试算子</span>
      </div>

      {/* 下一步最该试什么 */}
      <div className="rsi-strategy-block">
        <h4>下一步最该试什么</h4>
        {nextActions.length > 0 ? nextActions.map((a, i) => (
          <div key={i} className="rsi-strategy-row">
            <span className="rsi-strat-fam">{a.label}</span>
            <span>预计修 <b>{a.expectedFixes}</b> 题</span>
            {a.winRate != null && <span>最优动作胜率 {(a.winRate * 100).toFixed(0)}%</span>}
            {a.fixableBy && <span className="rsi-strat-fix">用 {a.fixableBy}</span>}
          </div>
        )) : <p className="rsi-strategy-empty">{state.goal?.met ? '已达标，无待修复缺口' : '所有失败族已穷尽探索或无可回收空间'}</p>}
      </div>

      {/* 杠杆：每族可回收空间 */}
      {leverage.length > 0 && (
        <div className="rsi-strategy-block">
          <h4>可回收空间（按失败族）</h4>
          {leverage.slice(0, 5).map((l, i) => (
            <div key={i} className="rsi-strategy-row">
              <span className="rsi-strat-fam">{FAMILY_INFO[l.family]?.name || l.family}</span>
              <span>失败 <b>{l.failedCases}</b> 题</span>
              <span>回收率 <b>{(l.rate * 100).toFixed(0)}%</b></span>
              <span>预计修 <b>{l.expectedFixes}</b> 题</span>
              {l.exhausted ? <Tag color="default">已穷尽</Tag> : l.remainingOperators.length > 0
                ? <Tag color="blue">有 {l.remainingOperators.length} 个可用动作</Tag>
                : <Tag color="orange">无可用动作</Tag>}
            </div>
          ))}
        </div>
      )}

      {/* 已证否/未尝试算子 */}
      {(deadOps.length > 0 || untriedOps.length > 0) && (
        <div className="rsi-strategy-ops">
          {deadOps.length > 0 && <div className="rsi-strategy-op-group"><span className="rsi-strat-op-label">已证否</span>{deadOps.map(op => <Tag key={op} color="red">{opLabel(op)}</Tag>)}</div>}
          {untriedOps.length > 0 && <div className="rsi-strategy-op-group"><span className="rsi-strat-op-label">未尝试</span>{untriedOps.map(op => <Tag key={op} color="blue">{opLabel(op)}</Tag>)}</div>}
        </div>
      )}

      {/* 策略摘要 */}
      {strat.digest && <div className="rsi-strategy-digest">{strat.digest}</div>}
    </section>;
  })()}

  <section className="rsi-task-scope">
   <div className="rsi-scope-heading"><h3>本任务优化什么</h3><Button type="link" onClick={()=>onSection('settings')}>查看任务设置</Button></div>
   <dl><div><dt>业务图谱</dt><dd>{state.baseGraph.label}</dd></div><div><dt>实验版本</dt><dd>{state.currentVersion}{adopted>0?` · 历史已采纳 ${adopted} 个方案`:''}</dd></div><div><dt>评测题目</dt><dd>{total} 道 <span>优化 {s.trainCount} · 验证 {s.heldoutCount} · 最终验收 {s.testCount||0}</span></dd></div></dl>
   <details className="rsi-workflow-help"><summary>优化任务如何完成？</summary><ol><li>准备题目并评测当前版本，找出识别错误。</li><li>配置优化范围、运行上限和采纳方式，系统生成多个候选并逐代验证；在运行记录中查看 DAG。</li><li>比较改善与退化，决定采纳或拒绝。人工采纳仅更新本任务的实验版本。</li><li>收尾时对独立题目做最终验收，再到成果页导出资产与证据。{s.testCount?'':'本任务没有独立验收题，需先准备数据。'}生产发布需要在目标环境另行完成。</li></ol></details>
  </section>
  <div className="rsi-overview-footer"><span>已采纳的实验版本还需要最终验收与导出，才能交付给后续使用方。</span><Button onClick={()=>onSection('results')}>查看成果与交付</Button>{baselineCurrent&&!state.evolveRunning&&view.action!=='propose'&&<Button onClick={()=>onAction('propose')} disabled={!!busy}>配置新一轮优化</Button>}</div>
 </div>;
}
