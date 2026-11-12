import type { EvolveRun } from './rsiShared';
import {reasoningRuns} from './rsiReasoningViewModel';
import './rsiReasoning.css';
export function RsiReasoningReview({runs}:{runs:EvolveRun[]}){
 const records=reasoningRuns(runs);if(!records.length)return null;
 return <section className="rsi-reasoning" aria-label="模型诊断与实验决策">
  <header><div><h3>模型诊断与实验决策</h3><p>假设来自模型，效果来自实际实验。训练探针、完整评测和搜索策略分别记录。</p></div></header>
  {records.map((run,index)=><details key={run.id} open={index===0} className="rsi-reasoning-run"><summary>运行 {run.id} · 模型请求 {run.modelCalls??'未记录'} · 训练探针 {run.probeCalls??'未记录'} 次 · 完整评测 {run.metricCalls??'未记录'} 次</summary>
   {run.rounds.map(round=><article key={round.gen} data-reasoning-generation={round.gen}>
    <div className="rsi-reasoning-title"><h4>第 {round.gen} 代</h4><span>{round.status}</span></div>
    {round.error&&<p className="rsi-reasoning-error">{round.error}；未用规则输出冒充模型决策。</p>}
    {!round.error&&round.repaired&&<p className="rsi-reasoning-probe">首版计划未通过契约校验，已按错误反馈自修复一次后通过。</p>}
    <div className="rsi-reasoning-stage"><b>1 · 诊断假设（待实验验证）</b><p>{round.summary}</p>{round.hypotheses.map(h=><div key={h.id} className="rsi-reasoning-hypothesis"><strong>{h.id} · {h.cause}</strong><p>训练证据：{h.evidenceCaseIds.join('、')}<br/>验证方式：{h.probe}</p></div>)}</div>
    <div className="rsi-reasoning-stage"><b>2 · 实验计划与实际执行</b>{!round.experiments.length?<p>本代没有待执行实验。</p>:round.experiments.map(e=><div className="rsi-reasoning-experiment" key={e.id}><div><strong>{e.id} · {e.targetName}</strong><span>{e.status}</span></div><p>父代 {e.parentId} · 假设 {e.hypothesisId} · {e.kind==='diagnostic'?'诊断实验':'改进实验'}</p><p>{e.instruction}</p><p>训练探针：{e.caseIds.join('、')}；正确对照：{e.controlCaseIds.join('、')||'未设置'}<br/>成功条件：{e.successCriterion}</p>{e.probeCount!=null&&<p className="rsi-reasoning-probe">实际探针 {e.probeCount} 题 · {e.probeReason}。探针结果不等于全量精度。</p>}{e.changes.length>0&&<details><summary>逐题探针变化</summary><ul>{e.changes.map(c=><li key={c.case_id}>{c.case_id}：{c.change==='improved'?'修复':c.change==='regressed'?'退化':'完全正确状态未变'}（{c.before.resultType||'未记录'} → {c.after.resultType||'未记录'}）</li>)}</ul></details>}{e.error&&<p className="rsi-reasoning-error">{e.error}</p>}</div>)}</div>
    <div className="rsi-reasoning-stage rsi-reasoning-decision"><b>3 · 复盘与下一步：{round.decision}</b><p>{round.reason}</p>{round.focus.length>0&&<p>下一步训练重点：{round.focus.join('、')}</p>}{round.rejected.length>0&&<p>否定的假设：{round.rejected.join('、')}</p>}</div>
    {round.evidence.length>0&&<details className="rsi-reasoning-evidence"><summary>查看模型收到的训练证据（不含隐藏集）</summary>{round.evidence.map((e,i)=><div key={`${e.case_id}-${i}`}><strong>{e.case_id} · {e.query}</strong><p>{e.strict?'正确对照':'训练坏例'} · {e.resultType}</p><pre>{JSON.stringify(e.evidence,null,2)}</pre></div>)}</details>}
   </article>)}
  </details>)}
 </section>;
}
