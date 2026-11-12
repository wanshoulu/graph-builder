'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const {buildReasoningContext,validatePlan,validateReflection,evaluateProbe,captureEvidence,reflectionContext}=require('../routes/rsi-reasoning');
const row=(id,strict=false)=>({case_id:id,query:id,shape:'ambiguous_intent',strict,relaxed:strict?1:0,resultType:strict?'correct':'clarify_extra_options',expected:['i1'],engine_top1:'i2',diagnosis:{missing:[],extra:['i2']}});
const ctx=()=>buildReasoningContext({generation:1,trainIds:['t','ok'],parents:[{id:'b0',graph:{intent_nodes:[]},rows:[row('t'),row('ok',true),{...row('heldout'),query:'HIDDEN_ANSWER'}]}],targets:['graph','engine'],remaining:{modelCalls:10,probeCalls:4,metricCalls:2},protectedIds:['t']});
const plan=()=>({summary:'检验候选簇扩展是否导致多余澄清选项',diagnoses:[{id:'h1',cause:'候选簇扩展可能引入无关动作',evidenceCaseIds:['t'],probe:'只切换图谱候选簇策略，其他条件保持不变'}],experiments:[{id:'e1',hypothesisId:'h1',parentId:'b0',target:'engine',kind:'improvement',caseIds:['t'],controlCaseIds:['ok'],parameters:{graphClusterFirst:false},instruction:'只切换候选簇优先策略，检查训练坏例的多余选项是否减少。',successCriterion:'修好训练坏例且正确对照不退化'}],decision:{action:'continue',reason:'先用单变量探针验证候选扩展假设'}});

test('reasoning context contains only allowlisted training evidence, including controls and missing trace status',()=>{
 const c=ctx();assert.doesNotMatch(JSON.stringify(c),/HIDDEN_ANSWER|heldout/);assert.equal(c.parents[0].cases.find(x=>x.case_id==='t').evidence.status,'unobserved');assert.equal(c.parents[0].cases.find(x=>x.case_id==='ok').strict,true);
 assert.ok(c.capabilities.graphOperators.A5_clarify.includes('文案'));
});
test('plan rejects hidden case references, unknown parents and unsupported targets',()=>{
 assert.equal(validatePlan(plan(),ctx()).experiments[0].id,'e1');
 for(const mutate of [p=>p.experiments[0].caseIds=['heldout'],p=>p.experiments[0].parentId='other',p=>p.experiments[0].target='engine_code',p=>p.diagnoses[0].evidenceCaseIds=['heldout']]){const p=plan();mutate(p);assert.throws(()=>validatePlan(p,ctx()));}
});
test('numeric corrections remain within executor bounds and retain correction notes',()=>{
 const p=plan();p.experiments[0].parameters={clarificationLimit:999};
 const e=validatePlan(p,ctx()).experiments[0];assert.equal(e.parameters.clarificationLimit,12);assert.ok(e.parameterAdjustments.length>0);
 for(const parameters of [{unknown_parameter:5},{clarificationLimit:'not a number'}]){const invalid=plan();invalid.experiments[0].parameters=parameters;assert.throws(()=>validatePlan(invalid,ctx()),/合法参数/);}
});

test('improvement experiments cannot target only already correct rows',()=>{
 const p=plan();p.experiments[0].caseIds=['ok'];p.experiments[0].controlCaseIds=[];
 assert.throws(()=>validatePlan(p,ctx()),/失败训练题/);
 p.experiments[0].kind='diagnostic';
 assert.equal(validatePlan(p,ctx()).experiments[0].caseIds[0],'ok');
});
test('a stop is a recorded model decision, invalid or missing plans never become a default rule plan',()=>{
 const p=plan();p.experiments=[];p.decision={action:'stop',reason:'现有训练证据不足以支持新实验，停止避免重复调用'};assert.equal(validatePlan(p,ctx()).decision.action,'stop');
 assert.throws(()=>validatePlan([],ctx()));
 const repaired=validatePlan({...plan(),diagnoses:[]},ctx());
 assert.equal(repaired.decision.action,'continue');assert.equal(repaired.diagnoses.length,1);
 assert.ok(Array.isArray(repaired.planAdjustments)&&repaired.planAdjustments.some(s=>s.includes('diagnoses')));
});
test('probe requires complete unique training rows, rejects positive control regression and distinguishes diagnostics',()=>{
 const e=plan().experiments[0], before=[row('t'),row('ok',true)];
 assert.equal(evaluateProbe(e,before,[row('t',true),row('ok',true)]).promote,true);
 assert.equal(evaluateProbe(e,before,[row('t',true),row('ok')]).promote,false);
 assert.equal(evaluateProbe(e,before,before).promote,false);
 assert.throws(()=>evaluateProbe(e,before,[row('t',true),row('t',true)]));
 assert.equal(evaluateProbe({...e,kind:'diagnostic'},before,[row('t',true),row('ok',true)]).promote,false);
});
test('reflection sees measured training changes without validation scores, gate reasons or hidden samples',()=>{
 const c=reflectionContext({plan:plan(),trainIds:['t','ok'],trials:[{id:'b1',target:'engine',experimentId:'e1',status:'gated',gateReason:'heldout HIDDEN_ANSWER failed',before:[row('t'),row('heldout')],after:[row('t',true),row('heldout')],scores:{heldout:{strict_pct:100}}}]});
 assert.doesNotMatch(JSON.stringify(c),/HIDDEN_ANSWER|heldout|gateReason|gated/);assert.ok(JSON.stringify(c).includes('improved'));
 assert.equal(validateReflection({decision:'revise',reason:'训练坏例仍有不同机制，需要换路径验证',nextFocusCaseIds:['t'],rejectedHypothesisIds:['h1']},ctx(),plan()).decision,'revise');
 assert.throws(()=>validateReflection({decision:'continue',reason:'继续',nextFocusCaseIds:['heldout']},ctx(),plan()));
});
test('capture per-query evidence preserves real routes and stage details without copying API secrets',()=>{
 const e=captureEvidence({methods:{local:{top:[{intent_id:'i1',score:1}]},embedding:{candidates:[],error:'failed'},llm_judge:{decision_trace:{steps:[{step:'candidate_merge',conclusion:'候选合并完成',data:{count:1,api_key:'SECRET'}}]}}},understanding:{cardinality:'single_intent'}});
 assert.equal(e.routes.lexical.rows[0].intent_id,'i1');assert.equal(e.routes.vector.status,'error');assert.equal(e.routes.subgraph.status,'unavailable');assert.equal(e.stages[0].step,'candidate_merge');assert.doesNotMatch(JSON.stringify(e),/SECRET|api_key/);
});

test('A6 is advertised and executable in model plans with the same authority as other graph operators',()=>{
 const c=ctx(),p=plan();
 assert.match(c.capabilities.graphOperators.A6_ambiguity_cluster_expand,/歧义/);
 Object.assign(p.experiments[0],{target:'graph',operator:'A6_ambiguity_cluster_expand'});
 assert.equal(validatePlan(p,c).experiments[0].operator,'A6_ambiguity_cluster_expand');
});

test('training observations distinguish recalled expected intents from excess clarification options and expose competitors',()=>{
 const failed={...row('t'),expected:['i1','i2'],engine_candidates:['i1','i2','extra'],engine_clarifying:true,
 evidence:{status:'recorded',routes:{lexical:{status:'completed',rows:[{intent_id:'i1'},{intent_id:'i2'}]}},stages:[{step:'deepseek_judge',data:{decision_mode:'deterministic_agree'}}]}};
 const c=buildReasoningContext({generation:1,trainIds:['t'],parents:[{id:'b0',graph:{intent_nodes:['i1','i2','extra'].map(intent_id=>({identity:{intent_id}}))},rows:[failed]}],targets:['graph'],remaining:{}});
 const observed=c.parents[0].cases[0].observations;
 assert.deepEqual(observed.recall.expectedSeen,['i1','i2']);
 assert.deepEqual(observed.recall.notObservedExpectedIds,[]);
 assert.deepEqual(observed.clarification.extraOptionIds,['extra']);
 assert.equal(observed.decision.bypassedJudge,true);
 assert.ok(c.parents[0].graph.some(n=>n.identity.intent_id==='extra'));
});

test('absent route evidence is unknown rather than proof of missing recall',()=>{
 const observed=ctx().parents[0].cases.find(r=>r.case_id==='t').observations;
 assert.equal(observed.recall.status,'unobserved');
 assert.equal(observed.recall.notObservedExpectedIds,null);
});

test('probe gain must occur on targeted bad cases rather than relaxed score drift on a correct control',()=>{
 const e=plan().experiments[0],before=[row('t'),{...row('ok',true),relaxed:0.7}];
 assert.equal(evaluateProbe(e,before,[row('t'),{...row('ok',true),relaxed:0.9}]).promote,false);
});

test('correct controls sharing an intent with failures are selected before unrelated easy cases',()=>{
 const unrelated=Array.from({length:9},(_,i)=>({...row('ok'+i,true),expected:['unrelated'+i]}));
 const related={...row('related',true),shape:'multi_intent',expected:['i1','other']};
 const input=buildReasoningContext({generation:1,trainIds:['t',...unrelated.map(r=>r.case_id),'related'],parents:[{id:'b0',graph:{intent_nodes:[]},rows:[row('t'),...unrelated,related]}],targets:['graph'],remaining:{}});
 assert.ok(input.parents[0].controlEligibleCaseIds.includes('related'));
});

test('training evidence remains intact when compacted again for probe reflection and next generation',()=>{
 const {trainingRow}=require('../routes/rsi-reasoning');
 const original={...row('t'),engine_top1:'wrong',engine_pred_set:['wrong'],engine_clarifying:true,engine_candidates:['i1','wrong'],
  evidence:{status:'recorded',routes:{lexical:{status:'completed',rows:[{intent_id:'i1'}]}}}};
 const once=trainingRow(original),again=trainingRow(once);
 assert.deepEqual(again.predicted,['wrong']);assert.equal(again.top1,'wrong');
 assert.deepEqual(again.observations,once.observations);
});

test('composite evidence preserves separate child recall errors and judge decisions',()=>{
 const failed={methods:{local:{top:[{intent_id:'a'}]},embedding:{degraded:true,error:'unavailable',top:[]},llm_judge:{decision_mode:'deterministic_agree',decision_trace:{steps:[]}}},understanding:{clarification:{needed:false}}};
 const successful={methods:{local:{top:[{intent_id:'b'}]},embedding:{top:[{intent_id:'b'}]},llm_judge:{decision_mode:'candidate_judge',decision_trace:{steps:[]}}},understanding:{clarification:{needed:false}}};
 const evidence=captureEvidence({segment_results:[{segment_index:1,query:'子句甲',...failed},{segment_index:2,query:'子句乙',...successful}],methods:{embedding:{top:[{intent_id:'b'}]}}});
 assert.equal(evidence.segments[0].evidence.routes.vector.status,'error');
 assert.equal(evidence.segments[1].evidence.routes.vector.status,'completed');
 assert.equal(evidence.segments[0].evidence.decision.mode,'deterministic_agree');
 assert.equal(evidence.routes.vector.status,'partial');
});

test('program-selected controls use actually correct related training cases and record rejected model choices',()=>{
 const p=plan();p.experiments[0].controlCaseIds=['t'];
 const selected=validatePlan(p,ctx()).experiments[0];
 assert.deepEqual(selected.controlCaseIds,['ok']);
 assert.deepEqual(selected.controlSelection.rejected,['t']);
 assert.deepEqual(selected.controlSelection.requested,['t']);
 assert.equal(selected.caseIds[0],'t');
 const broken=evaluateProbe(selected,[row('t'),row('ok',true)],[row('t',true),row('ok')]);
 assert.equal(broken.promote,false);
});

test('a diagnosis may cite its full visible training family while each executable probe remains bounded',()=>{
 const c=ctx(),p=plan();
 const more=Array.from({length:9},(_,i)=>({...c.parents[0].cases[0],case_id:'family'+i}));
 c.parents[0].cases.push(...more);p.diagnoses[0].evidenceCaseIds=more.map(r=>r.case_id);
 assert.equal(validatePlan(p,c).diagnoses[0].evidenceCaseIds.length,9);
 p.experiments[0].caseIds=more.map(r=>r.case_id);
 assert.throws(()=>validatePlan(p,c),/数量|最多|8道/);
});

test('reasoning graph keeps query-relevant declarations without flooding the model with every generated alias',()=>{
 const aliases=Array.from({length:500},(_,i)=>'无关模板说法'+i);
 aliases.push('当前目标业务的具体表达');
 const c=buildReasoningContext({generation:1,trainIds:['t'],parents:[{id:'b0',rows:[{...row('t'),query:'当前目标业务的具体表达'}],graph:{intent_nodes:[{identity:{intent_id:'i1'},retrieval_profile:{utterance_view:aliases},semantic_definition:{scope_out:['排除业务'],disambiguation_hints:['区分规则']}}]}}],targets:['graph'],remaining:{}});
 const node=c.parents[0].graph[0];
 assert.ok(node.retrieval_profile.utterance_view.length<=12);
 assert.ok(node.retrieval_profile.utterance_view.includes('当前目标业务的具体表达'));
 assert.deepEqual(node.semantic_definition.scope_out,['排除业务']);
});

test('planner and reflection bound repeated trace text while preserving causal observations and original records',()=>{
 const measured={...row('t'),evidence:{status:'recorded',decision:{mode:'degraded_fusion'},routes:{vector:{status:'error',rows:[]}},stages:Array.from({length:24},()=>({step:'deepseek_judge',conclusion:'trace '.repeat(1000),data:{degraded:true}}))}};
 const c=buildReasoningContext({generation:2,trainIds:['t'],parents:[{id:'b0',rows:[measured],graph:{intent_nodes:[]}}],targets:['graph'],remaining:{},previous:[{trials:[{changes:[{case_id:'t',before:measured,after:measured}]}]}]});
 assert.ok(JSON.stringify(c).length<18000);
 assert.equal(c.parents[0].cases[0].evidence.routes.vector.status,'error');
 assert.equal(c.parents[0].cases[0].evidence.decision.mode,'degraded_fusion');
 assert.equal(measured.evidence.stages[0].conclusion.length,6000);
});
