'use strict';
// Training-only evidence contracts. The model proposes experiments; this module
// validates authority and measurements, never assigns its own accuracy scores.
const {ENGINE_PARAMETERS}=require('./rsi-runtime-profile');
const {stageMetrics}=require('./rsi-metrics');
const GRAPH_OPERATORS=Object.freeze({
 A1_utterance_expand:'补充单意图说法；add_utterances；影响召回，不直接删澄清选项',
 A2_disambiguation:'区分线索add_hints、排除边界add_scope_out、易混淆意图confusable；影响排序和候选边界',
 A3_clause_expansion:'补充子句表达add_clause_views；影响召回，不修改切分代码',
 A4_description_rewrite:'改语义描述new_description；影响语义证据，不修改引擎规则',
 A5_clarify:'只修改已触发澄清的问题文案add_clarify_question，不控制触发与候选范围',
 A6_ambiguity_cluster_expand:'歧义簇共同说法；targets为2至6个图谱意图ID，add_utterances为这些意图共用的完整模糊表达；引擎根据共同声明触发澄清并限定选项，不用于明确的单意图或多意图表达',
 combo:'多算子叠加修复；parts数组共2至4项、不允许嵌套，有两种形态：A6（或A1）主提案加1至3个A2_disambiguation收边，或2至3个作用于不同意图的A2_disambiguation叠加；作为一个完整候选实际测量',
});
const GRAPH_OPS=Object.keys(GRAPH_OPERATORS);
const GRAPH_PROPOSAL_FIELDS=Object.freeze({
 A1_utterance_expand:{target:'一个现有意图ID',add_utterances:'新增完整说法字符串数组'},
 A2_disambiguation:{target:'一个现有意图ID',add_hints:'区分线索字符串数组（可选）',add_scope_out:'排除的用户表达字符串数组，不能填意图ID（可选）',confusable:'易混淆意图ID（可选）；至少有一项实际改动'},
 A3_clause_expansion:{target:'一个现有意图ID',add_clause_views:'新增子句表达字符串数组'},
 A4_description_rewrite:{target:'一个现有意图ID',new_description:'完整新语义描述字符串'},
 A5_clarify:{target:'一个现有意图ID',add_clarify_question:'可回答的澄清问题字符串'},
 A6_ambiguity_cluster_expand:{targets:'2至6个现有意图ID的数组',add_utterances:'这些意图共享的完整模糊表达字符串数组'},
 combo:{parts:'2至4个完整子提案的数组：A6（或A1）主提案加1至3个A2，或2至3个不同意图的A2'},
});
const CASE_SHAPES=['single_intent','multi_intent','ambiguous_intent','negative_intent'];
// 失败题按题型轮转均衡取样：各题型队列轮流出题直到取满，不让列表顺序决定规划
// 视野——否则模糊题占多时规划只盯模糊意图（单/多意图、负例必须同步进入诊断）。
function balanceByShape(rows,cap){
 const queues=[...CASE_SHAPES.map(s=>rows.filter(r=>r.shape===s)),rows.filter(r=>!CASE_SHAPES.includes(r.shape))].filter(q=>q.length);
 const chosen=[];let turn=0;
 while(chosen.length<cap&&queues.some(q=>q.length)){const q=queues[turn%queues.length];if(q.length)chosen.push(q.shift());turn++;}
 return chosen;
}
const clone=x=>JSON.parse(JSON.stringify(x));
const text=(x,max=2000)=>typeof x==='string'?x.slice(0,max):'';
const unique=xs=>[...new Set(xs)];
const list=(v)=>Array.isArray(v)?v:[];
function rows(value){return list(value).slice(0,12).map((r,i)=>({intent_id:r.intent_id||r.intentId||'',name:text(r.display_name||r.intent_name||r.title,120),rank:i+1,score:r.score??r.local_score??null,similarity:r.similarity??r.embedding_score??null,support:r.support??null,evidence:list(r.evidence).slice(0,8).map(x=>text(x,120))}));}
function captureEvidence(res={},depth=0){
 const m=res.methods||{},bank=m.bank,explicit=bank?.recallChannels;
 const channel=(key,source)=>explicit?.[key]?{status:explicit[key].status,rows:rows(explicit[key].candidates),reason:text(explicit[key].reason,300)}:
  source?{status:source.error||source.degraded?'error':'completed',rows:rows(source.top||source.candidates),reason:source.skipped?'本轮跳过':''}:{status:'unobserved',rows:[]};
 const safeData=d=>Object.fromEntries(Object.entries(d||{}).filter(([k,v])=>['count','candidate_count','fallback_count','needed','reason','rule','selected_id','selected_source','decision_mode','selected_rank','boundary_override','boundary_reason','top1_score','weak','cardinality','shape','repaired','degraded'].includes(k)&&['string','boolean','number'].includes(typeof v)).map(([k,v])=>[k,typeof v==='string'?text(v,500):v]));
 const segments=depth===0?list(res.segment_results).slice(0,8).map((s,i)=>({index:s.segment_index||i+1,query:text(s.query,500),evidence:captureEvidence(s,depth+1)})):[];
 const routes={lexical:channel('lexical',m.local),vector:channel('vector',m.embedding),subgraph:explicit?.subgraph?channel('subgraph'):m.graph?channel('subgraph',m.graph):bank?{status:'unobserved',rows:[]}:{status:'unavailable',rows:[],reason:'v2没有独立子图检索'}};
 for(const key of ['lexical','vector','subgraph'])if(segments.length){const statuses=segments.map(s=>s.evidence.routes[key].status);routes[key].status=statuses.every(s=>s==='completed')?'completed':statuses.some(s=>s==='completed')?'partial':statuses.some(s=>s==='error')?'error':'unobserved';}
 return {schema:1,status:'recorded',routes,...(segments.length?{segments}:{}),decision:{mode:m.llm_judge?.decision_mode||null},
  shape:res.understanding?.cardinality||bank?.shape||null,
  stages:list(m.llm_judge?.decision_trace?.steps).slice(0,24).map(s=>({step:text(s.step,80),conclusion:text(s.conclusion,600),data:safeData(s.data)})),
  clarification:{needed:res.understanding?.clarification?.needed===true,options:rows(res.understanding?.clarification?.options||res.understanding?.clarification?.questions?.flatMap(q=>q.options||[]))}};
}
// Observations describe measured stages, not a hard-coded root-cause verdict.
// A missing trace cannot prove a recall miss, and final option sets are not recall rankings.
function observeTrainingRow(r){
 if(r.observations&&!Object.hasOwn(r,'engine_candidates')&&!Object.hasOwn(r,'engine_top1'))return clone(r.observations);
 const evidence=r.evidence||{},routes=Object.values(evidence.routes||{}).filter(c=>c.status==='completed');
 const recalled=unique(routes.flatMap(c=>list(c.rows).map(c=>c.intent_id)).filter(Boolean));
 const expected=list(r.expected),options=unique(list(r.engine_candidates||r.predicted?.candidates||evidence.clarification?.options).map(c=>typeof c==='string'?c:c.intent_id||c.value).filter(Boolean));
 const decision=list(evidence.stages).find(s=>s.step==='deepseek_judge');
 const mode=evidence.decision?.mode||decision?.data?.decision_mode||(/跳过 LLM|跳过.*裁决/.test(decision?.conclusion||'')?'deterministic_agree':null);
 const needed=r.engine_clarifying??r.predicted?.clarifying??evidence.clarification?.needed??null;
 return {recall:{status:routes.length?'observed':'unobserved',expectedSeen:expected.filter(id=>recalled.includes(id)),
  notObservedExpectedIds:routes.length?expected.filter(id=>!recalled.includes(id)):null,observedCandidateIds:recalled},
  clarification:{needed,optionIds:options,missingExpectedIds:needed===true?expected.filter(id=>!options.includes(id)):null,extraOptionIds:options.filter(id=>!expected.includes(id))},
  decision:{mode,bypassedJudge:mode==='deterministic_agree'}};
}
function trainingRow(r){return {case_id:r.case_id,query:text(r.query,1000),shape:r.shape,strict:r.strict===true,relaxed:Number.isFinite(r.relaxed)?r.relaxed:0,resultType:r.resultType,
 expected:list(r.expected),predicted:list(r.engine_pred_set||r.predictedSet||(Array.isArray(r.predicted)?r.predicted:[])),top1:r.engine_top1||r.predicted?.top1||r.top1||null,
 diagnosis:clone(r.diagnosis||{}),observations:observeTrainingRow(r),evidence:r.evidence?clone(r.evidence):{status:'unobserved',reason:'历史测量未保存阶段证据，不能推断实际执行过程'}};}
// Full measured rows stay in readings/checkpoints. Planning needs bounded stage
// evidence, otherwise before/after traces multiply the context every generation.
function planningRow(r){
 const row=trainingRow(r);
 const compact=(e,depth=0)=>({...e,
  routes:Object.fromEntries(Object.entries(e.routes||{}).map(([key,route])=>[key,{...route,rows:list(route.rows).slice(0,4).map(c=>({...c,evidence:list(c.evidence).slice(0,3)}))}])),
  stages:list(e.stages).filter(s=>/judge|boundary|shape|clarification|composite/.test(s.step)).slice(-6).map(s=>({...s,conclusion:text(s.conclusion,180)})),
  ...(e.segments?{segments:depth<1?e.segments.slice(0,6).map(s=>({...s,evidence:compact(s.evidence||{},depth+1)})):[]}:{}),
 });
 row.evidence=compact(row.evidence);return row;
}
function historicalRow(r){const row=trainingRow(r),e=row.evidence;
 row.evidence={status:e.status,decision:e.decision,shape:e.shape,routes:Object.fromEntries(Object.entries(e.routes||{}).map(([key,route])=>[key,{status:route.status,reason:text(route.reason,160)}])),
  segments:list(e.segments).slice(0,6).map(s=>({index:s.index,query:s.query,decision:s.evidence?.decision,routes:Object.fromEntries(Object.entries(s.evidence?.routes||{}).map(([k,v])=>[k,{status:v.status}]))}))};return row;}
function compactGraph(graph,caseRows){
 const refs=new Set(caseRows.flatMap(r=>[...r.expected,...r.predicted,r.top1,...r.observations.clarification.optionIds,...r.observations.recall.observedCandidateIds].filter(Boolean)));
 const queryTokens=new Set(caseRows.flatMap(r=>{const q=String(r.query||'');return Array.from({length:Math.max(0,q.length-1)},(_,i)=>q.slice(i,i+2));}));
 const relevant=(values,limit)=>list(values).filter(v=>typeof v==='string').map((v,index)=>({v,index,score:Array.from(queryTokens).reduce((sum,t)=>sum+Number(v.includes(t)),0)}))
  .sort((a,b)=>b.score-a.score||a.index-b.index).slice(0,limit).map(item=>text(item.v,500));
 return list(graph?.intent_nodes).filter(n=>refs.has(n.identity?.intent_id)).slice(0,40).map(n=>{
  const rp=n.retrieval_profile||{},sd=n.semantic_definition||{},dp=n.decision_policy||{};
  return {identity:{intent_id:n.identity.intent_id,intent_name:n.identity.intent_name,intent_type:n.identity.intent_type},
   retrieval_profile:{utterance_view:relevant(rp.utterance_view,12),clause_view:relevant(rp.clause_view,6),object_view:relevant(rp.object_view,6),action_view:relevant(rp.action_view,6)},
   semantic_definition:{description:text(sd.description,400),user_goal:text(sd.user_goal,200),scope_in:relevant(sd.scope_in,10),scope_out:relevant(sd.scope_out,8),
    disambiguation_hints:relevant(sd.disambiguation_hints,8),confusable_intents:list(sd.confusable_intents).slice(0,12)},
   decision_policy:{clarify_questions:relevant(dp.clarify_questions,4)}};
 });
}
const compactTrainingGraph=(graph,caseRows)=>compactGraph(graph,caseRows.map(trainingRow));
function buildReasoningContext({generation,trainIds,parents,targets,remaining,protectedIds=[],previous=[],ops=[],operatorStats={},caseStats={},goalTarget,partialGains=[]}={}){
 const allowed=new Set(trainIds),protectedSet=new Set(protectedIds.filter(id=>allowed.has(id)));
 const stageTarget=Number.isFinite(Number(goalTarget))?Number(goalTarget):85;
 // 分层指标：把全量评测行拆成「题型精度 / 召回通道 / 澄清 / 裁决」四组，并给出按可救题数
 // 排序的短板表。规划器据此定点优化，而不是凭印象挑方向（此前 5 轮全部打错短板）。
 const metricsOf=rows=>{const m=stageMetrics(rows||[],{target:stageTarget});return {overall:m.overall,byShape:m.byShape,deficits:(m.deficits||[]).slice(0,4),channels:m.channels,clarification:m.clarification||null,judge:m.judge||null,recall:m.recall||null,summary:m.summary};};
 const primaryMetrics=metricsOf(parents[0]?.rows);
 return {schema:1,generation,targets:[...targets],ops,remaining:clone(remaining),maxExperiments:4,operatorStats:clone(operatorStats),caseStats:clone(caseStats),
  // 顶层短板表：每轮必须先读它，再从 deficits 里选 1-2 项作为本轮攻击目标
  stageMetrics:{goalTarget:stageTarget,...primaryMetrics},
  priority:primaryMetrics.deficits.slice(0,3).map((d,i)=>({rank:i+1,stage:d.stage,label:d.label,caseCount:d.caseCount,gainPts:d.gainPts,actions:d.actions})),
  // capabilities 只描述本次授权的 targets——上一版无条件列出 optimizer_prompt 描述，
  // 模型会照着选未授权路径，被 validatePlan 以「实验改动路径未授权」整体拒收（10-19 实跑 3/3 拒）
  capabilities:{...(list(targets).includes('engine')?{engineParameters:ENGINE_PARAMETERS}:{}),...(list(targets).includes('graph')?{graphOperators:Object.fromEntries(Object.entries(GRAPH_OPERATORS).filter(([op])=>!ops.length||ops.includes(op)))}:{}),...(list(targets).includes('recognition_prompt')?{recognitionComponents:['judge','shape','boundary']}:{}),...(list(targets).includes('optimizer_prompt')?{optimizer_prompt:'只改变后续搜索策略，不能声称新增识别精度'}:{}),unsupported:['engine_code','model_training','fusion']},
  parents:parents.map(p=>{const all=p.rows.filter(r=>allowed.has(r.case_id)),fail=all.filter(r=>!r.strict),controls=all.filter(r=>r.strict);
   const refs=new Set(fail.flatMap(r=>[...list(r.expected),...list(r.engine_candidates),r.engine_top1].filter(Boolean)));
   const relevance=r=>list(r.expected).filter(id=>refs.has(id)).length*2+(r.shape==='multi_intent'?1:0);
   controls.sort((a,b)=>relevance(b)-relevance(a));
   const ordered=[...fail.filter(r=>protectedSet.has(r.case_id)),...fail.filter(r=>!protectedSet.has(r.case_id))];
   const shapeStats=Object.fromEntries(CASE_SHAPES.map(s=>[s,{total:all.filter(r=>r.shape===s).length,failed:fail.filter(r=>r.shape===s).length}]));
   const chosen=balanceByShape(ordered,20).concat(controls.slice(0,8)).map(planningRow);
   // 执行路径画像：哪些题的裁决阶段真的跑了 LLM judge、哪些被引擎直接复用（bypassedJudge）。
   // 改 judge 指令只能作用于前者；这个画像既是给规划器的证据，也是 validatePlan 的前置判定依据。
   const decisionOf=r=>r.observations?.decision||r.evidence?.decision||{};
   const judgeObserved=all.filter(r=>decisionOf(r).mode!=null);
   const judgeEligible=judgeObserved.filter(r=>!decisionOf(r).bypassedJudge);
   const bypassedFailed=ordered.filter(r=>decisionOf(r).bypassedJudge===true).map(r=>r.case_id);
   return {id:p.id,assetHash:p.assetHash||null,cases:chosen,failureShapeStats:shapeStats,graph:compactGraph(p.graph,chosen),runtime:clone(p.graph?.meta?.rsi_runtime||{}),protectedCaseIds:chosen.filter(r=>protectedSet.has(r.case_id)).map(r=>r.case_id),controlEligibleCaseIds:chosen.filter(r=>r.strict).map(r=>r.case_id),
    executionPath:{judge:{observed:judgeObserved.length,ran:judgeEligible.length,bypassed:judgeObserved.length-judgeEligible.length,
      eligibleCaseIds:judgeEligible.filter(r=>!r.strict).map(r=>r.case_id).slice(0,8),bypassedFailedCaseIds:bypassedFailed.slice(0,8)}},
    stageMetrics:(()=>{const m=metricsOf(p.rows);return {overall:m.overall,byShape:m.byShape,deficits:m.deficits.slice(0,2),summary:m.summary};})()};}),
  // 12-04 部分增益台账（跨 run）：净修复>0、零破坏、仅因「净修复≥2」被门禁拦下的候选。
  // 规划层必须把它们叠加成纯 A2 组合，而不是丢掉或原样重提。
  partialGains:(Array.isArray(partialGains)?partialGains:[]).slice(-4),
  // Only previously validated planner summaries are accepted here. No score or
  // gate object is copied from the caller's complete experiment state.
  previous:previous.slice(-3).map(r=>({generation:r.generation,summary:text(r.summary),decision:r.decision,reason:text(r.reason),nextFocusCaseIds:list(r.nextFocusCaseIds).filter(id=>allowed.has(id)),error:text(r.error,600),
   experiments:list(r.experiments).slice(0,4).map(e=>({id:e.id,target:e.target,operator:e.operator,component:e.component,parameters:clone(e.parameters||{}),instruction:text(e.instruction),caseIds:list(e.caseIds).filter(id=>allowed.has(id))})),
   trials:list(r.trials).slice(0,8).map(t=>({experimentId:t.experimentId,status:t.status,error:text(t.executionError||t.error,500),variant:t.variant||null,
    changes:list(t.changes).filter(c=>allowed.has(c.case_id)).sort((a,b)=>Number(b.change!=='unchanged')-Number(a.change!=='unchanged')).slice(0,12).map(c=>({case_id:c.case_id,change:c.change,before:c.before?historicalRow(c.before):null,after:c.after?historicalRow(c.after):null}))}))}))};
}
function requireText(v,label,min=8){if(typeof v!=='string'||v.trim().length<min||v.length>6000)throw Error(label+'缺少具体内容');return v.trim();}
function ids(v,allowed,label,max=8){if(!Array.isArray(v)||v.length>max||v.some(id=>typeof id!=='string'||!allowed.has(id))||new Set(v).size!==v.length)throw Error(label+'引用了不可用训练证据或超出数量');return [...v];}
function validatePlan(raw,ctx){
 if(!raw||Array.isArray(raw)||typeof raw!=='object')throw Error('模型计划必须是JSON对象');
 const summary=requireText(raw.summary,'诊断摘要');
 // decision 结构容错：实测模型常把决策写成 "decision":"continue"、或在顶层写 action、
 // 或塞进 decision.decision。单个字段形状不对不该报废整代（本轮 gen1 就是这样 0 提案）。
 const rawDecision=raw.decision&&typeof raw.decision==='object'?raw.decision:{};
 // decision 形状容错再加固（10-30 实跑 run_52f5：模型既没写 action 也没写对别名，两代都被
 // 「计划决策必须为continue或stop」判死，整代 0 提案）。决策缺失不再否决整代：
 // 先认同义词，认不出就按「是否提交了实验」推断，并把推断写进 planAdjustments 留痕。
 const normalizeDecision=v=>{if(typeof v!=='string')return null;const t=v.trim().toLowerCase();
  if(['continue','proceed','go','run','optimize','evolve','continue_evolution','继续','继续优化'].includes(t))return 'continue';
  if(['stop','halt','finish','done','end','converge','stop_evolution','停止','收敛'].includes(t))return 'stop';
  return null;};
 const planAdjustments=[];
 let action=[rawDecision.action,typeof raw.decision==='string'?raw.decision:null,raw.action,rawDecision.decision,rawDecision.verdict,raw.verdict]
  .map(normalizeDecision).find(Boolean)||null;
 const rawExperiments=Array.isArray(raw.experiments)?raw.experiments:[];
 if(!action){
  action=rawExperiments.length?'continue':'stop';
  planAdjustments.push(`计划未给出合法的 decision.action（实收 ${text(JSON.stringify(raw.decision??raw.action??null),90)}），按${rawExperiments.length?`已提交 ${rawExperiments.length} 个实验`:'没有实验'}推断为 ${action}`);
 }
 if(action==='stop'&&rawExperiments.length){action='continue';planAdjustments.push('计划声明 stop 但同时提交了实验，按 continue 执行');}
 const reasonRaw=[rawDecision.reason,raw.reason].find(v=>typeof v==='string'&&v.trim().length>=8);
 const decision={action,reason:reasonRaw?reasonRaw.trim():summary};
 const allIds=new Set(ctx.parents.flatMap(p=>p.cases.map(r=>r.case_id)));
 // 字段名同样容错：模型常写 hypotheses/rootCauses 而不是 diagnoses
 let hypotheses=list(raw.diagnoses||raw.hypotheses||raw.rootCauses).slice(0,6);
 if(action==='continue'&&!hypotheses.length&&rawExperiments.length){
  // 模型给了可执行实验却漏了假设：用实验自带的 hypothesisId/caseIds 反推，而不是整代报废
  for(const e of rawExperiments){
   const hid=typeof e?.hypothesisId==='string'&&e.hypothesisId.trim()?e.hypothesisId.trim():'h1';
   if(hypotheses.some(h=>h&&h.id===hid))continue;
   const ev=list(e?.caseIds).filter(id=>typeof id==='string'&&allIds.has(id)).slice(0,8);
   if(!ev.length)continue;
   hypotheses.push({id:/^[a-zA-Z0-9_-]{1,40}$/.test(hid)?hid:'h1',cause:text(e.instruction||summary,400),evidenceCaseIds:ev,
    probe:'按该实验的训练探针变化判断根因是否成立',confidence:null});
  }
  if(hypotheses.length)planAdjustments.push('计划缺少 diagnoses，已按实验的 hypothesisId 与 caseIds 反推根因假设');
 }
 if(action==='continue'&&!hypotheses.length){action='stop';decision.action='stop';
  planAdjustments.push('计划既没有可验证的根因假设、也没有可引用的实验证据，按 stop 处理');}
 const seen=new Set();
 // probe 类型适配（10-31 实跑 gen2/gen3 两代报废根因）：模型常把 probe 写成对象
 // （含 target/instruction/caseIds 的完整实验规格），内容完全有效，只是类型不符。
 // 序列化成可读描述即可，不丢失信息；空对象/空串才报错。
 const probeText=v=>{
  if(typeof v==='string')return v;
  if(v&&typeof v==='object'){
   const parts=[v.instruction,v.probe,v.description,v.method].find(x=>typeof x==='string'&&x.trim().length>=8);
   if(parts)return String(parts).trim();
   const brief=[v.target,v.component,v.operator].filter(Boolean).join(':');
   return brief?`按 ${brief} 实验的训练探针变化判断根因是否成立`:'';
  }
  return '';
 };
 const diagnoses=hypotheses.map(h=>{if(typeof h.id!=='string'||!/^[a-zA-Z0-9_-]{1,40}$/.test(h.id)||seen.has(h.id))throw Error('假设ID重复或无效');seen.add(h.id);
  const evidenceCaseIds=ids(h.evidenceCaseIds,allIds,'诊断',allIds.size);if(!evidenceCaseIds.length)throw Error('诊断没有训练证据');
  const probe=probeText(h.probe);if(probe)planAdjustments.push(`假设${h.id}的 probe 是对象/非字符串，已按其内容转为描述`);
  return {id:h.id,cause:requireText(h.cause,'根因假设'),evidenceCaseIds,probe:probe||'按该实验的训练探针变化判断根因是否成立',confidence:Number.isFinite(h.confidence)?Math.max(0,Math.min(1,h.confidence)):null};});
 if(!Array.isArray(raw.experiments)||raw.experiments.length>ctx.maxExperiments||(action==='continue'&&!raw.experiments.length)||(action==='stop'&&raw.experiments.length))throw Error('实验数量或停止计划不合法');
 const expIds=new Set(),experiments=[];
 for(const e of raw.experiments){
  // 逐实验隔离（10-30 实跑：engine 实验漏了 parameters，整代卡在「参数实验缺少实际参数对象」，
  // 自修复两次都救不回，graph/prompt 实验一起报废）。单个实验不合规只剔除该实验并留痕，
  // 不否决同代其余实验——否则一个字段就烧掉整代预算。
  try{
  if(typeof e.id!=='string'||!/^[a-zA-Z0-9_-]{1,40}$/.test(e.id)||expIds.has(e.id))throw Error('实验ID重复或无效');expIds.add(e.id);
  if(!seen.has(e.hypothesisId)){
   // 假设引用写错/写漏不该连坐实验：只有一个假设时直接挂过去并留痕
   if(diagnoses.length===1){planAdjustments.push(`实验${e.id}的假设引用${text(e.hypothesisId,24)||'缺失'}不存在，已挂到唯一假设${diagnoses[0].id}`);e.hypothesisId=diagnoses[0].id;}
   else throw Error('实验没有合法假设引用');
  }
  const parent=ctx.parents.find(p=>p.id===e.parentId);if(!parent)throw Error('实验父代未授权');
  // 越权路径剔除留痕而非整计划否决：一次越权不该烧掉整轮进化预算（自修复两次都救不回，实证于10-28轮4）
  if(!ctx.targets.includes(e.target)){planAdjustments.push(`剔除实验${e.id}：改动路径${text(e.target,20)||'缺失'}不在本次授权targets内`);continue;}
  const allowed=new Set(parent.cases.map(r=>r.case_id)),caseIds=ids(e.caseIds,allowed,'实验'),requestedControls=ids(e.controlCaseIds||[],allowed,'对照');
  if(!caseIds.length)throw Error('每次训练探针需1至8道题');
  // 对照超额自动裁剪（10-31 实跑 gen2 整代报废根因）：指引要求打包 3-6 道坏例，模型照做
  // 了，但 6 案例 + 4 对照 = 10 超过 8 题上限，两个实验双双报废。案例题是实验主体，
  // 按原顺序保留；对照是可选增强，超限就从尾部裁掉并留痕，不否决实验。
  const SLOT=8;
  let trimmed=0;
  while(unique([...caseIds,...requestedControls]).length>SLOT&&requestedControls.length){requestedControls.pop();trimmed++;}
  if(trimmed)planAdjustments.push(`实验${e.id}的对照题超出8题上限，已裁掉 ${trimmed} 道（案例题全保留）`);
  // Selecting positive controls is an executor obligation. A model's false
  // claim that a failing row is a correct control cannot make it one, or cancel
  // every otherwise valid experiment. Keep an explicit selection audit.
  const invalidControls=requestedControls.filter(id=>!parent.cases.find(r=>r.case_id===id)?.strict||caseIds.includes(id));
  let controlCaseIds=requestedControls.filter(id=>!invalidControls.includes(id));
  if(!controlCaseIds.length){
   const references=new Set(parent.cases.filter(r=>caseIds.includes(r.case_id)).flatMap(r=>[...list(r.expected),...list(r.predicted),...list(r.observations?.clarification?.optionIds)]));
   const relevance=r=>list(r.expected).filter(id=>references.has(id)).length*2+(r.shape==='multi_intent'?1:0);
   controlCaseIds=parent.cases.filter(r=>r.strict&&!caseIds.includes(r.case_id)).sort((a,b)=>relevance(b)-relevance(a)).slice(0,Math.min(2,8-caseIds.length)).map(r=>r.case_id);
  }
  // 回归保护题自动补入探针对照：保护集中的通过题若不在探针覆盖范围，
  // 碰撞式退化要等到完整评测才暴露——浪费 budget（P2-8）。
  // 执行层把它们强制补入对照，探针即可前置拦截退化，避免无效完整评测。
  if(list(parent.protectedCaseIds).length){
   const covered=new Set([...caseIds,...controlCaseIds]);
   const protectedControls=parent.cases.filter(r=>r.strict&&list(parent.protectedCaseIds).includes(r.case_id)&&!covered.has(r.case_id)).map(r=>r.case_id);
   if(protectedControls.length){const slots=8-unique([...caseIds,...controlCaseIds]).length;controlCaseIds=[...controlCaseIds,...protectedControls.slice(0,Math.max(0,slots))];}
  }
  if(!['improvement','diagnostic'].includes(e.kind))throw Error('实验必须区分诊断和改进');
  if(e.kind==='improvement'&&!caseIds.some(id=>parent.cases.find(r=>r.case_id===id)?.strict===false))throw Error('改进实验必须至少针对一道父代失败训练题；正确题只能作为对照或诊断');
  // 12-04 计划层算子推断：图谱实验常把算子名只写在 instruction 散文里而漏 operator 字段，
  // 执行层就退化成「全部图谱算子可选」，变异模型随手给一个别的算子（实测 A2 指令被写成
  // A6 簇扩展、整代 propose_fail）。从指令里识别算子名并回填，让下游只允许该算子。
  if(e.target==='graph'&&!e.operator){
   const instr=typeof e.instruction==='string'?e.instruction:'';
   const byShort={A1:'A1_utterance_expand',A2:'A2_disambiguation',A3:'A3_clause_expansion',A4:'A4_description_rewrite',A5:'A5_clarify',A6:'A6_ambiguity_cluster_expand'};
   const fullName=['A2_disambiguation','A6_ambiguity_cluster_expand','A1_utterance_expand','A3_clause_expansion','A4_description_rewrite','A5_clarify'].find(op=>instr.includes(op));
   const short=(instr.match(/A[1-6]/)||[])[0];
   const guess=fullName||byShort[short];
   if(guess&&GRAPH_OPS.includes(guess)&&(!ctx.ops.length||ctx.ops.includes(guess))){e.operator=guess;planAdjustments.push(`实验${e.id}未声明operator，已按指令中的算子名推断为${guess}`);}
  }
  if(e.target==='graph'&&e.operator&&(!GRAPH_OPS.includes(e.operator)||(ctx.ops.length&&!ctx.ops.includes(e.operator))))throw Error('图谱算子未授权');
  if(e.target==='recognition_prompt'&&!['judge','shape','boundary'].includes(e.component)){
   // 组件缺失/非法不再整计划报废：先按指令关键词推断，推断不出则取本次授权的第一个组件，
   // 并留痕（10-30 实跑 gen2 因指令里没有任何关键词，两次自修复都救不回，整代 0 提案）。
   const instruction=typeof e.instruction==='string'?e.instruction:'';
   const fallback=list(ctx.recognitionComponents)[0]||'judge';
   const keyword=/澄清|边界|排除|范围|触发/.test(instruction)?'boundary':/单意图|多意图|数量|复合|切分|模糊|选项/.test(instruction)?'shape':/得分|排序|裁决|置信|打分/.test(instruction)?'judge':null;
   const guess=keyword||fallback;
   planAdjustments.push(`实验${e.id}未给出合法识别组件（${text(e.component,20)||'缺失'}），已${keyword?'按指令关键词推断':'回退到本次授权组件'}为${guess}`);
   e.component=guess;
  }
  // 执行路径前置判定（10-30 Codex 审计 P0）：145 个可观察样本里有 43 个的裁决阶段被引擎
  // 直接复用（bypassedJudge），判 judge 指令改不到这些题——模板写得再好也不会被执行。
  // 改在生成实验前就判定：目标题全部绕开 judge 就剔除该实验并说明，部分绕开就从 caseIds 剔除。
  if(e.target==='recognition_prompt'&&e.component==='judge'){
   const bypassedOf=id=>{const row=parent.cases.find(c=>c.case_id===id);const d=row?.observations?.decision||row?.evidence?.decision||{};return d.bypassedJudge===true;};
   const bypassed=caseIds.filter(bypassedOf);
   if(bypassed.length){
    const eligible=caseIds.filter(id=>!bypassedOf(id));
    if(!eligible.length)throw Error(`judge 指令改不到这些题：${caseIds.join('、')} 的裁决阶段被引擎跳过（bypassedJudge），改动不在执行路径上；请改用图谱 A2 或引擎参数，或换裁决实际执行过的失败题`);
    planAdjustments.push(`实验${e.id}目标题 ${bypassed.join('、')} 的裁决被跳过，judge 指令对它们无效，已从 caseIds 剔除`);
    caseIds.length=0;caseIds.push(...eligible);
   }
  }
  let parameters,parameterNotes=null;
  if(e.target==='engine'){
   const raw=e.parameters&&typeof e.parameters==='object'&&!Array.isArray(e.parameters)?e.parameters:null;
   if(!raw||!Object.keys(raw).length)throw Error('参数实验缺少实际参数对象');
   // 容错校验：模型常用字符串数字、轻微越界或塞入未知键，逐键修正并留痕，
   // 不再因单键不合法否决整个引擎实验（10-19 实跑两次自修复均未救回）。
   const coerced={},notes=[];
   for(const [key,val] of Object.entries(raw)){
    const bounds=ENGINE_PARAMETERS[key];
    if(!bounds){notes.push(`忽略未知参数${key}`);continue;}
    if(bounds==='boolean'){if(typeof val==='boolean')coerced[key]=val;else if(val==='true'||val===1)coerced[key]=true;else if(val==='false'||val===0)coerced[key]=false;else notes.push(`忽略非布尔参数${key}`);continue;}
    const num=typeof val==='number'?val:Number(val);
    if(!Number.isFinite(num)){notes.push(`忽略非数值参数${key}`);continue;}
    const clamped=Math.max(bounds[0],Math.min(bounds[1],num));
    const value=key==='clarificationLimit'?Math.round(clamped):Number(clamped.toFixed(4));
    if(value!==num)notes.push(`${key}已从${val}夹取到${value}`);
    coerced[key]=value;
   }
   if(!Object.keys(coerced).length)throw Error(`参数实验没有合法参数：${notes.join('；')||'全部参数不合法'}`);
   if(notes.length)parameterNotes=notes;
   parameters=coerced;
  }
  // 分层指标定向：记录本实验攻的是哪个环节、预期救回几题。取值不合法只留痕不否决，
  // 避免又回到「单字段不合规 → 整代报废」的老问题，但方向偏离会在结论里暴露。
  const stageValues=new Set((ctx.priority||[]).map(p=>p.stage));
  const topStages=new Set((ctx.priority||[]).slice(0,2).map(p=>p.stage));
  let fixesStage=null;
  if(typeof e.fixesStage==='string'&&e.fixesStage.trim()){
   const s=e.fixesStage.trim();
   if(s==='diagnostic'||stageValues.has(s))fixesStage=s;
   else planAdjustments.push(`实验${e.id}声明的环节${text(s,24)}不在本轮短板表内，已忽略该声明`);
   if(fixesStage&&fixesStage!=='diagnostic'&&!topStages.has(fixesStage))planAdjustments.push(`实验${e.id}攻的是${fixesStage}，不在最短板前两名（${[...topStages].join('/')||'无'}），请确认前两名确实不可达`);
  }
  const expectedGainCases=Number.isFinite(Number(e.expectedGainCases))?Math.max(0,Math.round(Number(e.expectedGainCases))):null;
  const experiment={id:e.id,hypothesisId:e.hypothesisId,parentId:e.parentId,target:e.target,kind:e.kind,caseIds,controlCaseIds,
   controlSelection:{source:'program_training_evidence',requested:requestedControls,rejected:invalidControls,added:controlCaseIds.filter(id=>!requestedControls.includes(id))},
   instruction:requireText(e.instruction,'实验修改指令',15),successCriterion:requireText(e.successCriterion,'实验成功条件'),
   ...(fixesStage?{fixesStage}:{}),...(expectedGainCases!=null?{expectedGainCases}:{}),
   ...(parameters?{parameters}:{}),...(parameterNotes?{parameterAdjustments:parameterNotes}:{}),...(e.target==='graph'&&e.operator?{operator:e.operator}:{}),...(e.target==='recognition_prompt'?{component:e.component}:{}),maxCandidates:Math.max(1,Math.min(2,Number.isInteger(e.maxCandidates)?e.maxCandidates:1))};
  experiments.push(experiment);
  }catch(err){ planAdjustments.push(`剔除实验${typeof e?.id==='string'?e.id:'?'}：${err.message}`); }
 }
 if(action==='continue'&&!experiments.length)throw Error(planAdjustments.length?`全部实验均未通过执行契约（${planAdjustments.join('；')}），需重新提案`:'计划没有合法实验');
 // planAdjustments 供执行留痕并随 plan 进入反射上下文，越权剔除对模型透明
 return {schema:1,summary,diagnoses,experiments,decision,...(planAdjustments.length?{planAdjustments}:{})};
}
function evaluateProbe(experiment,before,after){
 const wanted=unique([...experiment.caseIds,...experiment.controlCaseIds]);
 if(after.length!==wanted.length||new Set(after.map(r=>r.case_id)).size!==wanted.length||after.some(r=>!wanted.includes(r.case_id)||['engine_error','invalid_gold'].includes(r.resultType)))throw Error('训练探针缺题、重复或包含引擎错误');
 const previous=new Map(before.map(r=>[r.case_id,r]));if(wanted.some(id=>!previous.has(id)))throw Error('训练探针缺少同父代对照');
 const changes=after.map(r=>({case_id:r.case_id,before:{strict:previous.get(r.case_id).strict,relaxed:previous.get(r.case_id).relaxed,resultType:previous.get(r.case_id).resultType},after:{strict:r.strict,relaxed:r.relaxed,resultType:r.resultType},change:!previous.get(r.case_id).strict&&r.strict?'improved':previous.get(r.case_id).strict&&!r.strict?'regressed':'unchanged'}));
 const regressed=changes.filter(c=>c.change==='regressed'),gain=changes.some(c=>experiment.caseIds.includes(c.case_id)&&!c.before.strict&&(c.change==='improved'||(Number.isFinite(c.after.relaxed)&&c.after.relaxed>(c.before.relaxed||0))));
 // 类别级判定（10-31）：打包 3-6 道同类坏例后，「目标题全无变化」才说明机制没触达；
	 // 目标题出现任何 strict/relaxed 收益即晋级，零退化是硬前提。
	 // 单题「零变化」不再靠抽样猜测强制晋级：探针没有证据就不花完整评测预算（证据不足≠机制无效）。
	 const targetIds=new Set(experiment.caseIds);
	 const targetRows=changes.filter(c=>targetIds.has(c.case_id)&&!c.before.strict);
	 const allTargetsUntouched=targetRows.length>0&&targetRows.every(c=>c.change==='unchanged');
	 // 晋级只认目标题证据，且只属于改进实验：diagnostic 只验证机制触达，
	 // 其探针收益由运行时记为 diagnostic_complete，不直接消耗完整评测预算
	 return {kind:'training_probe',count:after.length,promote:experiment.kind!=='diagnostic'&&(gain||!allTargetsUntouched)&&!regressed.length,
	  reason:regressed.length?'训练正确对照出现退化':experiment.kind==='diagnostic'?'诊断实验只验证机制触达，不直接晋级完整评测':gain?'训练探针出现收益，进入完整评测':allTargetsUntouched?'打包目标题全部无变化，机制未触达，跳过完整评测':'目标题有 relaxed 变化或部分收益，进入完整评测',changes,results:after.map(trainingRow)};
}
function reflectionContext({plan,trainIds,trials}){
 const allowed=new Set(trainIds);
 return {schema:1,plan:clone(plan),trials:trials.map(t=>{
  const before=new Map(list(t.before).filter(r=>allowed.has(r.case_id)).map(r=>[r.case_id,r]));
  const after=list(t.after).filter(r=>allowed.has(r.case_id));
  const focus=new Set(list(plan.experiments).filter(e=>e.id===t.experimentId).flatMap(e=>[...list(e.caseIds),...list(e.controlCaseIds)]));
  const selected=after.filter(r=>focus.has(r.case_id)||!before.has(r.case_id)||before.get(r.case_id).strict!==r.strict||before.get(r.case_id).relaxed!==r.relaxed);
  // 反射上下文只含训练侧证据：heldout/门禁字段一律不进入，模型不能从复盘读到隐藏集信息
  return {id:t.id,target:t.target,experimentId:t.experimentId,measurement:t.measurement||'unmeasured',executionError:t.executionError?(typeof t.executionError==='string'?text(t.executionError,600):'实验执行失败，未取得完整训练测量'):null,
   variant:t.variant||null,kindUpgrade:t.kindUpgrade||null,
   unchangedOtherCases:after.length-selected.length,
   changes:selected.map(r=>({case_id:r.case_id,before:before.has(r.case_id)?historicalRow(before.get(r.case_id)):null,after:historicalRow(r),change:!before.get(r.case_id)?.strict&&r.strict?'improved':before.get(r.case_id)?.strict&&!r.strict?'regressed':'unchanged'}))};})};
}
function validateReflection(raw,ctx,plan){
 if(!raw||!['continue','revise','stop'].includes(raw.decision))throw Error('复盘决策必须为continue、revise或stop');
 const allowed=new Set(ctx.parents.flatMap(p=>p.cases.map(r=>r.case_id)));
 const rejected=new Set(plan.diagnoses.map(h=>h.id));
 return {decision:raw.decision,reason:requireText(raw.reason,'复盘依据'),nextFocusCaseIds:ids(raw.nextFocusCaseIds||[],allowed,'下一步重点'),rejectedHypothesisIds:ids(raw.rejectedHypothesisIds||[],rejected,'否定的假设',6)};
}
function parseObject(raw){if(typeof raw!=='string')throw Error('模型未返回文本');const clean=raw.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');return JSON.parse(clean);}
const PLAN_SYSTEM=[
 '你是基于证据的意图进化研究员。只使用提供的训练案例、执行证据和授权能力；不得猜测隐藏集、改金标、编造测量。缺少阶段证据必须承认未知。',
 '【方向必须由分层指标决定】stageMetrics 是本次评测的分环节精度：overall 是总达标缺口；byShape 是单意图/多意图/模糊意图/负例各自精度与 gapCases；channels 是词法/向量/子图各通道的召回率；clarification 是澄清触发率、选项覆盖与越界；judge 是裁决执行率；priority 是已按「修好能救回几题」排序的最短板。本轮必须从 priority 的 rank 1-2 里选攻击目标——这是硬约束：如果只攻 rank 3 之后（或 priority 之外的环节），等于绕开最大缺口，必须在该实验的 rationale 里写明前两名为什么在本轮不可达（例如授权 targets 里没有能改变该环节的算子），否则该实验视为无方向。若输入带 forcedStage，说明上一环节已连续多代无收益，本轮必须以该 stage 为主攻目标，并且不得再提该环节已被探针否证的同一机制（要换机制或换算子）。',
 '【算子和环节必须匹配，否则是无效方向】fixesStage 决定可用动作，不能跨环节套用：judge_rank / judge_select（排序与裁决错）只能用 recognition_prompt:judge、graph:A2_disambiguation、engine 的打分权重或 negativePenalty——用澄清类（A5/A6）或召回类（A1/A3/A4）修排序错一定无效；clarify_trigger 用 A6 歧义簇 / A2 补歧义信号 / clarificationLimit；clarify_options 用 A6 补簇成员 / A2 scope_out / boundary；clarify_question 用 A5 问法；recall 用 A1/A3/A4；composite_split 用 A3 子句 / subclause_min；composite_over 用 A2 scope_out / subclause_min 提高；negative_guard 用 A2 排斥边界 / boundary。每个实验的 instruction 也要写清它改的是该环节的哪个机制。每个实验必须声明 fixesStage（只能取 priority 里出现过的 stage 值，或 diagnostic）与 expectedGainCases（预期修好的训练坏例数，整数，按 deficits.caseCount 与实际机制估）；diagnoses 必须引用该环节的坏例 case_id；禁止提出无法对应任何短板环节的「通用增强」实验。优先选 priority.actions 里排在第一位的动作，它通常是该环节最直接的机制。',
 '【执行路径前置判定：改不在执行路径上的部件必然零效果】parents[].executionPath 给出裁决阶段的真实执行情况：judge.ran 是裁决真的跑了 LLM 的题数，judge.bypassed 是引擎直接复用确定性结果、根本没进 judge 的题数。recognition_prompt:judge 实验只能选 judge.eligibleCaseIds 里的坏例；若你要打的题出现在 judge.bypassedFailedCaseIds 里，说明这些题的 judge 阶段被跳过，改 judge 指令对它们一段都不会执行——这类题只能靠 graph:A2_disambiguation（改候选与边界）或 engine 参数（改打分）来修。被剔除的这类实验会以「judge 指令改不到这些题」记入 planAdjustments，不要重复提交。',
 '先逐题核对observations：recall.expectedSeen表示实际召回已出现的期望意图，notObservedExpectedIds只是已保存榜单中未观察到的ID，不是完整召回缺失证明；clarification.optionIds是最终澄清选项，不是带分数的召回排名；decision.bypassedJudge为true时裁决指令没有执行。已召回但未澄清或选项过多，应检验触发、选项组织和边界，而非断言召回不足。',
'【通道轮换，禁止单通道垄断（10-31）】如果上一代全部实验都是同一 target（例如全是 recognition_prompt），本轮必须至少一个实验换通道（graph 或 engine）——同一通道连续改写措辞只会产生边际差异极小的候选。同一优先环节允许多通道并进：judge_rank 既可用提示词改裁决规则，也可用 graph:A2 改候选区分度（改分数证据）、engine 改打分权重（改输入排序）；提示词只能改「怎么选」，图谱和引擎改「选什么」——当排序错误源于分数本身拉不开差距时，只有后两者有效。',
'【提示词必须可泛化，禁止为单题定制（10-31）】recognition_prompt 的指令必须是建立在意图语义、边界与证据类型上的通用判定规则；不得引用具体测试题原文、不得写「当query是X时选Y」这类逐题规则。为训练题定制的规则在验证集/全量必然回退（实测某候选按题定制规则：训练+2pp 但全量修1破3被门禁拒绝）。写完指令自检：这条规则换一道同机制的题还成立吗？',
 '依据capabilities选择能改变失败阶段的动作。共同完整模糊表达可以用A6声明候选歧义簇；A5只改已触发的问题文案。避免同一短语粗暴加强竞争意图后破坏复合句。previous给出实际实验参数、指令及训练前后变化：说明支持/否定哪个假设，提出不同的下一步；不得把重复实验当新探索。',
 '只输出一个JSON对象，严格使用以下字段名：summary；diagnoses数组，每项id、cause、evidenceCaseIds、probe（可证伪实验）、confidence；experiments数组，每项id、hypothesisId、parentId、target、kind(improvement或diagnostic)、caseIds、controlCaseIds、instruction、successCriterion、fixesStage、expectedGainCases、maxCandidates(1或2)。',
 'engine实验必须含parameters实际参数对象，键名、类型、取值范围遵守engineParameters；recognition_prompt必须含component，只能取judge/shape/boundary中本次授权的值；graph实验可含operator且只能取graphOperators的键名；optimizer_prompt只改搜索策略。',
 '图谱实验的执行契约（违反会被判无效、浪费该实验名额）：A6_ambiguity_cluster_expand 必须在instruction里点名2至6个已存在的意图ID作为歧义簇成员，并说明这些意图共享的那一个模糊说法；combo 有两种合法形态，不允许嵌套combo、不允许把其他算子塞进combo：形态一「1个A6（或1个A1）主提案 + 1至3个A2_disambiguation收边」，用于需要先声明歧义范围再收边的场景；形态二「2至3个A2_disambiguation」，每个A2必须作用于不同意图、各自补齐具体线索，用于把多个「单独修1题、过不了净修复门禁」的部分增益叠成一个候选——当某个A2算子反复 probePromoted 却 fullPassed=0 时优先用形态二。A6的增补说法必须是证据坏例原话的轻度泛化变体，不能凭空造词。A2_disambiguation 必须至少包含 add_hints、add_scope_out、confusable 三者之一，只写"增强区分"而不给具体线索会被判无效。engine实验必须给出真实参数键值，不能只写instruction。若目标机制改不动，宁可在diagnoses里写清证据并把该实验改为diagnostic，也不要为了凑数写一个违反契约的提案。',
 '最多4个实验，每个caseIds与controlCaseIds合计最多8道训练题。caseIds引用目标训练坏例；controlCaseIds是可选的正确对照建议，只能取父代controlEligibleCaseIds；执行器会据真实strict结果选择相关正确对照并记录controlSelection，失败题不会被当成正确对照。parents中的protectedCaseIds是历史回归保护题（曾因实验退化被记入保护集），执行器会自动把它们补入探针对照以前置检测碰撞式退化——你不需要手动声明，但应避免改动可能波及这些题的机制。experiment.target只能取targets数组，targets之外的路径会被执行器直接剔除并浪费该实验名额；parentId只能取parents.id；禁止unsupported或未授权路径。',
 '【实验必须打包同类坏例，单题实验没有统计意义（10-31 硬约束）】一个改动机制（同一段指令/同一批图谱编辑/同一组引擎参数）天然作用于「一类」失败题，不是一道题。caseIds 只写 1 道题是常见错误：探针在该题上恰好无变化就会把整个机制误判为无效（实测 6 个实验 4 个这样被浪费），即使晋级，1 修 2 破的随机波动也必然被门禁拒绝。正确做法：从 priority 环节的坏例中挑 3-6 道同机制失败的题打包进一个实验——注意算术：caseIds 3-6 题 + 对照题合计不得超过 8 题，打包 5-6 道坏例时 controlCaseIds 只给 2 道（或不给，执行器会自动选相关正确对照）；fixesStage 相同且 instruction 描述同一机制的实验只允许提交一个（重复提交同类单题实验会被拒绝）。successCriterion 写类别级标准（如「6 道排序错误题中 ≥3 道期望意图置顶」），不写单题标准。真正的 diagnostic 实验（验证机制是否触达）才允许只打 1-2 题，且 kind 必须标 diagnostic。',
 '【部分增益必须叠加，不能因为差一题就丢掉】partialGains 列出上一代「净修复>0、零破坏、仅因净修复未达2题被门禁拦截」的候选：这些改动已被实测证明能修好 caseIds 里的题。下一轮硬要求：若 partialGains 非空且这些目标题仍在失败集中，至少一个实验必须把它们的改动与另一组实验的收边叠加成形态二纯 A2 combo（parts 覆盖不同意图、合计2至3个），让净修复达到≥2；不得把这些已修好的点单独重提（单独重提必然再次被同一门禁拒绝）。若两个部分增益的意图互不重叠，直接合并它们的 A2 parts；若重叠，保留证据题更多的一组，并给另一组失败意图补一个新的 A2 子提案。',
 'operatorStats是跨运行算子漏斗（只统计≥3题打包的探针与完整评测；更早的小样本记录不可靠已剔除）。probePromoted 是训练坏例上的探针晋级次数，只是弱信号；fullPassed/fullEvaluated 才是完整评测通过门禁的真实战绩，两档必须分开读：①fullEvaluated≥2 且 fullPassed=0 的算子，说明单独作用时增益不足以过门禁——再不能单独重提，要么换作用机制、要么与其他 probePromoted>0 的算子组合成纯 A2 combo 一次过门禁；②probePromoted≥3 但 fullPassed=0 的算子属于「方向对、力度不够」，不要因它被拒就彻底弃用，改用组合叠加；③只有 fullPassed>0 才算真正有效。probed≥3 且 probePromoted=0 的算子近期无实测收益：再提案必须换作用机制并写明与既往尝试的具体差异。caseStats是训练题的探针历史（probed被探次数/probePromoted曾晋级）。probed≥2且probePromoted=0的题目说明既有机制已证否：继续针对该题必须声明新的作用机制或更换目标题，不得做相似度高的重复提案。',
 'decision 必须是对象：{"action":"continue"或"stop","reason":"本轮攻哪个环节、预计各拿回几题"}（不要写成字符串，也不要省略 action）；停止时experiments为空。实验组合要集中火力而不是平均铺开：全部实验只服务 priority 的 rank 1-2 环节（首选 rank 1），同一环节允许给 2-3 个机制不同的方案并行验证（例如同时试图谱说法扩展与引擎阈值），这样探针才能区分是机制错了还是方向错了；不同实验的 fixesStage 与作用机制必须真不同，禁止换措辞重提（duplicateWatch 会按指纹拒绝）。只有 rank 1 已被明确证明在本轮不可达时，才把实验额度分给 rank 2。targets 未授权的类别不可选；每个实验仍须有可测量作用机制，信息不足先设计诊断实验。说明预期改变的阶段，不把训练探针等同于泛化成绩。'
].join('');
const REFLECT_SYSTEM='你是实验复盘与下一轮策略决策者。输入只有训练侧实测变化；无测量不能宣称有收益。比较证据与原假设，说明支持、否定或仍未知；不要重复失败路径。只输出JSON对象：decision(continue/revise/stop)、reason(简洁具体决策依据)、nextFocusCaseIds(只能引用输入中的训练ID)、rejectedHypothesisIds(只能引用已有假设ID)。正确对照退化需明确说明，单次训练收益不代表验证或终测提升。';
const PLAN_REPAIR_SYSTEM='你是计划修复器。前一次模型计划违反了执行契约，error 给出确切原因。只修正违法之处，其余内容原样保留；不得借机改变实验方向或编造新测量。修正后输出完整 JSON 计划（字段与原契约完全一致）：experiment.target只能取targets中的值；controlCaseIds只能取controlEligibleCaseIds中的id（可为空数组）；recognition_prompt实验必须含component字段，从recognitionComponents中选最贴合其instruction的一项补上；graph实验的operator只能取graphOperators的键名；engine实验的parameters每个键必须存在于engineParameters且数值/布尔落在给定区间内（数值直接写数字，不要写成字符串），clarificationLimit必须为整数；experiment.caseIds的每道题必须出现在对应父代的cases里，1至8道；假设引用的evidenceCaseIds同理；summary、instruction、successCriterion保持具体文字。';
module.exports={GRAPH_OPERATORS,GRAPH_PROPOSAL_FIELDS,captureEvidence,observeTrainingRow,trainingRow,compactTrainingGraph,buildReasoningContext,validatePlan,validateReflection,evaluateProbe,reflectionContext,parseObject,PLAN_SYSTEM,REFLECT_SYSTEM,PLAN_REPAIR_SYSTEM};
