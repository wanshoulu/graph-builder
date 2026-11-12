import type { EvolveRun } from './rsiShared';
const TARGET:Record<string,string>={graph:'图谱',engine:'引擎参数',recognition_prompt:'识别指令',optimizer_prompt:'搜索策略'};
const STATUS:Record<string,string>={planned:'计划已保存',planning:'正在诊断与规划',experiments_complete:'实验已完成',reflecting:'正在复盘',complete:'复盘已保存',stopped:'模型建议停止',error:'模型计划失败',reflection_error:'复盘未完成',search_only:'仅更新搜索策略',probe_rejected:'探针无收益',diagnostic_complete:'诊断探针完成',measured:'已完整评测',duplicate:'重复资产未重测',budget_skipped:'预算不足未执行',generation_error:'生成失败',execution_error:'执行失败',generating:'正在生成修改'};
export function reasoningRuns(runs:EvolveRun[]){
 return runs.filter(run=>run.rounds?.some(r=>r.reasoning)).map(run=>({id:run.id||run.at,modelCalls:run.modelCalls??null,probeCalls:run.probeCalls??null,metricCalls:run.metricCalls??null,
  rounds:run.rounds.filter(r=>r.reasoning).map(r=>{
   const record=r.reasoning!,trials=record.trials||[];
   return {gen:r.gen??r.round,status:STATUS[record.status]||record.status,error:record.error,summary:record.plan?.summary||'模型尚未返回有效计划',repaired:record.repair?.used===true,
    hypotheses:record.plan?.diagnoses||[],evidence:record.input?.parents?.flatMap(p=>p.cases)||[],
    experiments:(record.plan?.experiments||[]).map(e=>{const trial=trials.find(t=>t.experimentId===e.id);return {...e,targetName:TARGET[e.target]||e.target,status:STATUS[trial?.status||'']||'待执行',probeCount:trial?.probe?.count??null,probeReason:trial?.probe?.reason,changes:trial?.probe?.changes||[],error:trial?.error};}),
    decision:record.reflection?({continue:'继续当前方向',revise:'调整策略',stop:'停止搜索'}[record.reflection.decision]):record.plan?.decision.action==='stop'?'停止搜索':'尚未形成复盘决策',
    reason:record.reflection?.reason||record.plan?.decision.reason||'',focus:record.reflection?.nextFocusCaseIds||[],rejected:record.reflection?.rejectedHypothesisIds||[]};})})).reverse();
}
