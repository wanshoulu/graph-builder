'use strict';
// Human review only. The optimization context continues to use its training
// allowlist; sealed test cases never enter this response, even by explicit ID.
const finite=n=>typeof n==='number'&&Number.isFinite(n)?n:null;
const sameRev=(a,b)=>!!a?.engineSha&&!!b?.engineSha&&Number.isFinite(a.protoRev)&&Number.isFinite(b.protoRev)&&!!a.engineMode&&['engineSha','protoRev','engineMode'].every(k=>a[k]===b[k]);
const sameContext=(a,b)=>!!a?.casesSha256&&!!a?.splitSha256&&a.casesSha256===b?.casesSha256&&a.splitSha256===b?.splitSha256&&sameRev(a.engineRev,b.engineRev);
function buildCaseReview({state,cases,graph,source,caseId,baselineCurrent=false}){
 const train=new Set(state.split?.train||[]),held=new Set(state.split?.heldout||[]),sealed=new Set(state.split?.test||[]);
 const allowed=cases.filter(c=>!sealed.has(c.case_id)&&(train.has(c.case_id)||held.has(c.case_id)));
 if(caseId&&!allowed.some(c=>c.case_id===caseId))throw Object.assign(new Error('题目不存在或属于封存终测'),{statusCode:404});
 const names=new Map((graph.intent_nodes||[]).map(n=>[n.identity?.intent_id,n.identity?.intent_name]));
 const display=ids=>ids.map(id=>names.get(id)||id);
 const before=source?.before,after=source?.after||state.baseline;
 const comparable=!!before&&sameContext(before.context,after?.context)&&sameRev(before.scores?.engineRev||before.context?.engineRev,after?.scores?.engineRev||after?.context?.engineRev);
 const b=new Map((before?.results||[]).map(r=>[r.case_id,r])),a=new Map((after?.results||[]).map(r=>[r.case_id,r]));
 const result=row=>{
  if(!row)return null;
  const raw=row.predictedSet||row.engine_pred_set||row.predicted?.candidates||row.engine_candidates||[];
  const ids=[...new Set([row.predicted?.top1||row.engine_top1,...raw.map(x=>typeof x==='string'?x:x?.intent_id)].filter(Boolean))];
  return {strict:typeof row.strict==='boolean'?row.strict:null,relaxed:finite(row.relaxed),resultType:row.resultType||null,predictedNames:display(ids),clarifying:row.predicted?.clarifying??row.engine_clarifying??null};
 };
 return {source:source?.id||'current',label:source?.label||`当前版本 ${state.currentVersion}`,version:after?.version||state.currentVersion,at:after?.at||null,baselineCurrent,comparable,sealedTestCount:sealed.size,
  rows:allowed.filter(c=>!caseId||c.case_id===caseId).map(c=>{const old=b.get(c.case_id),row=a.get(c.case_id);return {
   caseId:c.case_id,query:c.query,shape:c.intent_shape,split:train.has(c.case_id)?'train':'heldout',
   expectedNames:display([...new Set(c.expected_intents||c.expected_tasks?.map(t=>t.intent_id)||[])]),result:result(row),before:result(old),
   change:comparable&&typeof old?.strict==='boolean'&&typeof row?.strict==='boolean'?old.strict===row.strict?'unchanged':row.strict?'fixed':'regressed':'unavailable',
   ...(caseId?{expectedTasks:c.expected_tasks||null,evidence:row?.evidence||null,diagnosis:row?.diagnosis||null,beforeEvidence:old?.evidence||null}:{}),
  };}),
 };
}
module.exports={buildCaseReview};
