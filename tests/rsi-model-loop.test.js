'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createProductionRuntime}=require('../routes/rsi-production-runtime');
const TEST_TMP_ROOT=path.join(__dirname,'..','.tmp-tests');
fs.mkdirSync(TEST_TMP_ROOT,{recursive:true});
const rev={engineSha:'model-loop-fixture',protoRev:3,engineMode:'offline+decl'};
const instruction='对模糊表达只保留动作与对象一致的候选，明确执行请求和规则咨询的边界；信息不足时澄清，不扩大无关业务候选，同时保护已有明确表达。';
function plan(target='engine',kind='diagnostic'){return {summary:'区分候选扩展和裁决边界两个竞争机制，先验证单变量实验',diagnoses:[{id:'h1',cause:'候选扩展可能引入无关动作，边界裁决也可能未正确过滤',evidenceCaseIds:['t'],probe:'先单独切换候选簇，再对比边界指令'}],experiments:[{id:'e1',hypothesisId:'h1',parentId:'b0',target,kind,caseIds:['t'],controlCaseIds:['ok'],parameters:{graphClusterFirst:false},component:'boundary',instruction,successCriterion:'坏例修复且已正确对照保持正确'}],decision:{action:'continue',reason:'训练记录足以支持一个有正确对照的实验'}};}
function fixture(t,model,opts={}){const dir=fs.mkdtempSync(path.join(TEST_TMP_ROOT,'rsi-model-loop-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let graph={meta:{},intent_nodes:[]},state={taskId:'model-test',currentVersion:'v1',versions:[{version:'v1'}],archive:[],regression:{},stats:{},split:{train:['t','t2','ok'],heldout:['h'],test:['secret']},evolveRuns:[],scoreHistory:[]};const calls=[],messages=[];const fixIds=opts.fixIds||['t','t2'];
 const copy=x=>JSON.parse(JSON.stringify(x));
 const runtime=createProductionRuntime({rsiDir:dir,root:dir,defaultDecisionMode:'model',revision:()=>rev,loadGraph:()=>copy(graph),loadState:()=>copy(state),saveState:s=>state=copy(s),saveVersion:()=>{},readCases:()=>['t','t2','ok','h','secret'].map(case_id=>({case_id,query:case_id==='h'?'HIDDEN_VALUE':case_id})),publicState:s=>({...s}),extractJsonArray:JSON.parse,
 callLLM:async msgs=>{messages.push(copy(msgs));return JSON.stringify(await model(msgs,messages.length));},
 scoreGraph:async(g,o)=>{calls.push({ids:o.ids,probe:!!o.probeIds});const fixed=!!g.meta?.rsi_runtime?.prompts?.boundary;const pass=case_id=>!fixIds.includes(case_id)||fixed;const results=o.ids.map(case_id=>({case_id,query:case_id==='h'?'HIDDEN_VALUE':case_id,shape:'ambiguous_intent',strict:pass(case_id),relaxed:pass(case_id)?1:0,resultType:pass(case_id)?'correct':'clarify_extra_options',expected:['i1'],engine_pred_set:['i1'],llm_calls:1,tokens:10}));const agg=rs=>({total:rs.length,strict_pct:rs.length?rs.filter(r=>r.strict).length/rs.length*100:0,relaxed_pct:rs.length?rs.filter(r=>r.strict).length/rs.length*100:0});const bucket=rs=>{const a=agg(rs);return {...a,ambiguous_intent:{...a}};};return {results,scores:{engineRev:rev,train:bucket(results.filter(r=>['t','t2','ok'].includes(r.case_id))),heldout:bucket(results.filter(r=>r.case_id==='h')),all:bucket(results)}};}});
 return {runtime,calls,messages,state:()=>state,dir};}
function stageFixture(t){
 const dir=fs.mkdtempSync(path.join(TEST_TMP_ROOT,'rsi-stage-switch-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 let graph={meta:{},intent_nodes:[]},state={taskId:'stage-test',currentVersion:'v1',versions:[{version:'v1'}],archive:[],regression:{},stats:{},split:{train:['rank','clarify','ok'],heldout:['h'],test:['secret']},evolveRuns:[],scoreHistory:[]};
 const copy=x=>JSON.parse(JSON.stringify(x));let generation=0;
 const rows=ids=>ids.map(case_id=>({case_id,shape:case_id==='clarify'?'ambiguous_intent':'single_intent',strict:!['rank','clarify'].includes(case_id),relaxed:!['rank','clarify'].includes(case_id)?1:0,resultType:case_id==='rank'?'wrong_label':case_id==='clarify'?'clarify_extra_options':'correct',expected:['i1']}));
 const agg=rs=>({total:rs.length,strict_pct:rs.length?100*rs.filter(r=>r.strict).length/rs.length:0,relaxed_pct:rs.length?100*rs.filter(r=>r.strict).length/rs.length:0});
 const runtime=createProductionRuntime({root:dir,rsiDir:dir,defaultDecisionMode:'model',revision:()=>rev,loadGraph:()=>copy(graph),loadState:()=>copy(state),saveState:s=>state=copy(s),saveVersion:()=>{},readCases:()=>['rank','clarify','ok','h','secret'].map(case_id=>({case_id,query:case_id})),publicState:s=>copy(s),extractJsonArray:JSON.parse,
  callLLM:async msgs=>{if(msgs[0].content.includes('研究员')){generation++;const ctx=JSON.parse(msgs[1].content),stage=ctx.forcedStage?.stage||ctx.priority[0].stage,caseId=stage==='clarify_options'?'clarify':'rank';return JSON.stringify({summary:`检验 ${stage}`,diagnoses:[{id:'h1',cause:'当前环节没有按动作和对象边界过滤候选，导致错误结果持续出现',evidenceCaseIds:[caseId],probe:'只调整一个引擎参数并对比坏例与正确对照的逐题结果'}],experiments:[{id:'e1',hypothesisId:'h1',parentId:'b0',target:'engine',kind:'diagnostic',caseIds:[caseId],controlCaseIds:['ok'],parameters:{hintWeight:0.2+generation/100},instruction,successCriterion:'坏例改善且对照不退化',fixesStage:stage,expectedGainCases:1}],decision:{action:'continue',reason:'按当前优先环节验证'}});}if(msgs[0].content.includes('复盘'))return JSON.stringify({decision:generation===2?'stop':'revise',reason:generation===2?'当前环节连续无收益，建议停止':'继续验证服务端指定环节',nextFocusCaseIds:['rank'],rejectedHypothesisIds:['h1']});return '[]';},
  scoreGraph:async(_g,o)=>{const results=rows(o.ids),train=new Set(state.split.train),held=new Set(state.split.heldout);return {results,scores:{engineRev:rev,train:agg(results.filter(r=>train.has(r.case_id))),heldout:agg(results.filter(r=>held.has(r.case_id))),all:agg(results)}};}});
 return {runtime,state:()=>state};
}
test('server switches stage before honoring model stop and executes the forced stage',async t=>{
 const f=stageFixture(t);
 const run=await f.runtime.evolve({maxRounds:2,noImproveRounds:2,optimization:{targets:['engine'],decisionMode:'model'}});
 assert.equal(run.rounds.length,3,JSON.stringify({stopReason:run.stopReason,rounds:run.rounds.map(r=>({result:r.result,error:r.reasoning?.error,attempts:r.reasoning?.planAttempts,plan:r.reasoning?.plan,input:r.reasoning?.input?.priority,reflection:r.reasoning?.reflection}))}));
 assert.equal(run.rounds[2].reasoning.input.forcedStage.stage,'judge_select');
 assert.notEqual(run.stopReason,'model_decision');
});
test('model candidate records adaptive measurement and structured insufficient-evidence gate',async t=>{
 const f=fixture(t,async msgs=>{if(msgs[0].content.includes('研究员'))return plan('recognition_prompt','improvement');if(msgs[0].content.includes('复盘'))return {decision:'stop',reason:'单题变化不足以晋升',nextFocusCaseIds:['t'],rejectedHypothesisIds:['h1']};return [{component:'boundary',text:instruction,motivation:'收紧边界'}];},{fixIds:['t']});
 await f.runtime.evolve({maxRounds:1,optimization:{targets:['recognition_prompt'],maxMetricCalls:12}});
 const entry=f.state().archive[0];
 assert.equal(entry.measurement.confidence,'provisional');
 assert.equal(entry.gate.verdict,'evidence_insufficient');
 assert.equal(entry.adoptability.ok,false);
});
test('model rejects a diagnostic hypothesis then changes the next experiment path using training evidence',async t=>{
 let generation=0;const f=fixture(t,async msgs=>{if(msgs[0].content.includes('研究员'))return plan(++generation===1?'engine':'recognition_prompt',generation===1?'diagnostic':'improvement');if(msgs[0].content.includes('复盘'))return {decision:generation===1?'revise':'stop',reason:generation===1?'参数探针未改变错误，应转向边界裁决假设':'训练探针和全量训练已有改善，停止扩大搜索',nextFocusCaseIds:['t'],rejectedHypothesisIds:generation===1?['h1']:[]};return [{component:'boundary',text:instruction,motivation:'训练t存在多余选项，收紧裁决动作和对象边界'}];});
 const run=await f.runtime.evolve({maxRounds:3,optimization:{targets:['engine','recognition_prompt'],decisionMode:'model'}});
 assert.equal(run.rounds.length,2);assert.equal(run.rounds[0].reasoning.reflection.decision,'revise');assert.equal(run.rounds[1].reasoning.plan.experiments[0].target,'recognition_prompt');assert.equal(run.stopReason,'model_decision');assert.equal(run.champion,'b2');assert.equal(run.totalAdopted,0);
 assert.deepEqual(f.calls.map(c=>c.ids),[['t','t2','ok','h'],['t','t2','ok','h'],['t','t2','ok','h'],['t','ok'],['t','ok'],['t','t2','ok','h'],['t','t2','ok','h'],['t','t2','ok','h'],['t','t2','ok','h'],['t','t2','ok','h'],['t','t2','ok','h'],['t','t2','ok','h']]);assert.doesNotMatch(JSON.stringify(f.messages),/HIDDEN_VALUE|"heldout"|"secret"/);
});
test('invalid model plan never falls back to fixed mutations or evaluates a candidate',async t=>{const f=fixture(t,()=>{const p=plan();p.experiments[0].caseIds=['h'];return p;});const run=await f.runtime.evolve({maxRounds:1,optimization:{targets:['engine']}});assert.equal(f.calls.length,3);assert.equal(run.rounds[0].reasoning.status,'error');assert.equal(run.rounds[0].proposed,0);assert.equal(run.rounds[0].outputScores,null);});

test('unmeasured errors do not consume the measured no-improvement allowance',async t=>{
 const f=fixture(t,()=>{const p=plan();p.experiments[0].caseIds=['h'];return p;});
 const run=await f.runtime.evolve({maxRounds:3,noImproveRounds:1,optimization:{targets:['engine']}});
 assert.equal(run.rounds.length,3);
 assert.equal(run.stopReason,'max_generations');
});
test('optimizer prompt is a search strategy update without a new recognition measurement',async t=>{const f=fixture(t,msgs=>msgs[0].content.includes('研究员')?plan('optimizer_prompt','improvement'):msgs[0].content.includes('复盘')?{decision:'stop',reason:'已记录搜索策略，需比较后续子候选而不是宣称识别涨分',nextFocusCaseIds:['t'],rejectedHypothesisIds:[]}:[{text:instruction,motivation:'优先分析澄清多余选项的机制，避免重复泛化说法'}]);const run=await f.runtime.evolve({maxRounds:1,optimization:{targets:['optimizer_prompt']}});assert.equal(f.calls.length,3);assert.ok(run.searchStrategy?.artifactHash);assert.equal(run.branches.b1.status,'search_only');assert.equal(run.branches.b1.fullScores,undefined);assert.equal(run.rounds[0].result,'search_updated');assert.equal(f.state().archive.length,0);});
test('probe without training improvement does not spend a full candidate evaluation',async t=>{const f=fixture(t,msgs=>msgs[0].content.includes('研究员')?plan('engine','improvement'):{decision:'stop',reason:'训练探针没有收益，停止继续扩大量评测',nextFocusCaseIds:['t'],rejectedHypothesisIds:['h1']});const run=await f.runtime.evolve({maxRounds:1,optimization:{targets:['engine']}});assert.equal(run.metricCalls,3);assert.equal(run.probeCalls,1);assert.equal(f.calls.length,4);assert.equal(run.branches.b1.status,'probe_rejected');});
test('model request budget stops reflection without exceeding its hard limit',async t=>{const f=fixture(t,()=>plan());const run=await f.runtime.evolve({maxRounds:3,optimization:{targets:['engine'],budget:{maxModelCalls:1}}});assert.equal(f.messages.length,1);assert.equal(run.modelCalls,1);assert.equal(run.stopReason,'model_budget');});
test('reused baseline is not charged again as new recognition calls',async t=>{const f=fixture(t,()=>({...plan(),experiments:[],decision:{action:'stop',reason:'训练信息不足，先停止而不新增识别调用'}}));await f.runtime.baseline();const run=await f.runtime.evolve({maxRounds:1,optimization:{targets:['engine']}});assert.equal(run.metricCalls,0);assert.equal(run.usage.recognizerRequests,0);assert.equal(run.usage.recognizerTokens,0);});

test('next model generation receives the actual failed experiment and targeted training changes',async t=>{
 let generation=0,second;
 const f=fixture(t,msgs=>{
  if(msgs[0].content.includes('研究员')){generation++;if(generation===2)second=JSON.parse(msgs[1].content);return plan('engine','improvement');}
  return {decision:generation===1?'revise':'stop',reason:'训练探针没有改变坏例，下一轮需依据实际失败改动提出不同机制',nextFocusCaseIds:['t'],rejectedHypothesisIds:['h1']};
 });
 await f.runtime.evolve({maxRounds:2,optimization:{targets:['engine']}});
 assert.ok(second.previous[0].experiments.some(e=>e.id==='e1'&&e.parameters.graphClusterFirst===false));
 const trial=second.previous[0].trials.find(t=>t.experimentId==='e1');
 assert.ok(trial.changes.some(c=>c.case_id==='t'&&c.change==='unchanged'));
 assert.doesNotMatch(JSON.stringify(second),/HIDDEN_VALUE|"heldout"|"secret"/);
});

test('proposal validation failures reach reflection and the next planner without measured claims',async t=>{
 let generation=0,reflection,second;
 const f=fixture(t,msgs=>{
  if(msgs[0].content.includes('研究员')){generation++;if(generation===2)second=JSON.parse(msgs[1].content);return plan('graph','improvement');}
  if(msgs[0].content.includes('复盘')){reflection=JSON.parse(msgs[1].content);return {decision:generation===1?'revise':'stop',reason:'提案生成缺少必要字段，未执行测量，下一轮先修正结构',nextFocusCaseIds:['t'],rejectedHypothesisIds:[]};}
  return [{type:'A6_ambiguity_cluster_expand',evidence_cases:['t'],motivation:'缺少必要字段的提案'}];
 });
 await f.runtime.evolve({maxRounds:2,optimization:{targets:['graph']}});
 assert.equal(f.calls.length,3);
 assert.match(reflection.trials[0].executionError,/./);
 assert.equal(reflection.trials[0].measurement,'unmeasured');
 assert.ok(second.previous[0].trials[0].error);
});
