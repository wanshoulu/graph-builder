/** One recommendation derived from current evidence, independent of historical activity. */
export function taskOverview(v:{running:boolean;caseCount:number;baselineCurrent:boolean;hasBaseline:boolean;pendingCount:number;adoptableCount:number;drift:boolean}){
 const scoreAvailable=v.baselineCurrent;
 if(v.running)return {status:'正在优化',action:'runs',label:'查看运行进展',hint:'任务正在后台运行。查看当前代次、候选分支与评测进度；离开此页后仍会继续。',scoreAvailable};
 if(!v.caseCount)return {status:'等待准备题目',action:'data',label:'准备评测题目',hint:'导入带有预期识别结果的题目，系统才能判断优化前后是否有改善。也可以先保存任务，稍后准备。',scoreAvailable:false};
 if(v.drift)return {status:'题目发生变化',action:'data',label:'检查评测题目',hint:'评测题目与此前记录不一致，历史结果暂不可比较。请先检查数据并确认新的评测范围。',scoreAvailable:false};
 if(!v.baselineCurrent)return {status:v.hasBaseline?'需要重新评测':'尚未评测',action:'baseline',label:v.hasBaseline?'重新评测当前版本':'评测当前识别效果',hint:v.hasBaseline?'图谱、题目或评测方式已变化。先重新测量当前版本，才能判断后续方案是否更好。':'先测量当前版本的识别效果并找出错误，再配置优化任务。评测会调用模型服务，请留意耗时与用量。',scoreAvailable:false};
 if(v.pendingCount)return {status:'有方案待审阅',action:'review',label:'审阅改进方案',hint:v.adoptableCount?`${v.pendingCount} 个方案待处理，其中 ${v.adoptableCount} 个满足当前采纳条件。对比改善与退化后再决定。`:`${v.pendingCount} 个方案待处理，尚无可直接采纳的方案。查看评测状态、重新验证或拒绝方案。`,scoreAvailable};
 return {status:'可以开始优化',action:'propose',label:'配置新一轮优化',hint:'根据识别错误生成多个改进方向，逐代评测并保留有效方案。先设置运行上限和采纳方式。',scoreAvailable};
}
