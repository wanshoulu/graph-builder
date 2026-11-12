export function matchingDatasets<T extends {graphVersionId?:string|null}>(base:string|undefined,datasets:T[]):T[]{
  if(!base||base==='seed')return [];
  const id=base.slice(base.indexOf(':')+1);
  return datasets.filter(d=>d.graphVersionId===id);
}
export function validateSetupStep(step:number,v:Record<string,unknown>,hasFile:boolean):string|null{
  if(step===0){if(!String(v.name||'').trim())return '请给任务起一个能说明业务问题的名称';if(!v.base)return '请选择要改善识别效果的业务图谱';}
  if(step===1){if(!v.casesSource)return '请选择如何准备评测题目';if(v.casesSource==='file'&&!hasFile)return '请先选择评测题目文件';if(v.casesSource==='dataset'&&!v.evalDatasetId)return '请选择一套已有评测题目';}
  return null;
}
export function setupNextAction(caseCount:number,baselineCurrent:boolean,running:boolean):string{
  return running?'查看运行进展':!caseCount?'准备评测题目':!baselineCurrent?'评测当前识别效果':'启动优化';
}
