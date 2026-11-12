'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {normalizeCases}=require('../routes/rsi-task-dataset');
const {validateGold,scoreIntentCase}=require('../routes/rsi-case-scoring');
const {scoreEngineCase}=require('../routes/rsi-scoring-runtime');
const negative={case_id:'out-of-domain',query:'请播放一首歌',intent_shape:'negative_intent',expected_intents:[]};
test('an imported out-of-domain case reaches the real evaluator with empty expected intents',async()=>{
 const imported=normalizeCases([negative],{intent_nodes:[]});let calls=0;
 const row=await scoreEngineCase(imported.cases[0],async()=>{calls++;return{final_result:null,understanding:{clarification:{needed:false}}};});
 assert.equal(calls,1);assert.equal(row.strict,true);assert.equal(row.resultType,'correct');
});
test('out-of-domain scoring rejects any business task or business clarification option',()=>{
 assert.equal(scoreIntentCase(negative,{final_result:{intent_id:'business'}}).strict,false);
 assert.equal(scoreIntentCase(negative,{understanding:{tasks:[{intent_id:'business'}]}}).strict,false);
 assert.equal(scoreIntentCase(negative,{understanding:{clarification:{needed:true,question:'哪项业务',options:[{intent_id:'business'}]}}}).strict,false);
 assert.equal(scoreIntentCase(negative,{understanding:{clarification:{needed:true,question:'请补充您的问题',options:[]}}}).strict,true);
});
test('ambiguous legacy negative gold cannot silently change the rejection contract',()=>{
 assert.throws(()=>validateGold({...negative,expected_intents:['blocked']}),/negative|负例/);
 assert.throws(()=>validateGold({...negative,expected_tasks:[{intent_id:'business'}]}),/negative|负例/);
 assert.throws(()=>validateGold({...negative,intent_shape:'single_intent'}),/non-empty/);
});
