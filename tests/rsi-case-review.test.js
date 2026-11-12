'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {buildCaseReview}=require('../routes/rsi-case-review');
const rev={engineSha:'a',protoRev:3,engineMode:'online+decl'};
const context={casesSha256:'cases',splitSha256:'split',engineRev:rev};
const graph={intent_nodes:[{identity:{intent_id:'a',intent_name:'账户余额'}}]};
const cases=[{case_id:'t',query:'训练问法',intent_shape:'single_intent',expected_intents:['a']},{case_id:'h',query:'验证问法',intent_shape:'single_intent',expected_intents:['a']},{case_id:'secret',query:'SEALED_TEST_QUERY',expected_intents:['SEALED_TEST_GOLD']}];
const state={currentVersion:'v2',split:{train:['t'],heldout:['h'],test:['secret']},baseline:{version:'v2',context,results:[{case_id:'t',strict:true,predicted:{top1:'a'},evidence:{decision:{mode:'deterministic_agree'}}},{case_id:'h',strict:false,relaxed:1,resultType:'rank_error'},{case_id:'secret',strict:true,query:'SEALED_TEST_QUERY'}]}};
test('review lists only training and validation cases without hidden gold or eager traces',()=>{
 const r=buildCaseReview({state,cases,graph,baselineCurrent:true});
 assert.equal(r.rows.length,2);assert.equal(r.sealedTestCount,1);assert.equal(r.rows[0].result.strict,true);
 assert.deepEqual(r.rows[0].expectedNames,['账户余额']);assert.deepEqual(r.rows[0].result.predictedNames,['账户余额']);
 assert.equal(r.rows[0].evidence,undefined);assert.doesNotMatch(JSON.stringify(r),/SEALED_TEST/);
 assert.equal(buildCaseReview({state,cases,graph,caseId:'t'}).rows[0].evidence.decision.mode,'deterministic_agree');
 assert.throws(()=>buildCaseReview({state,cases,graph,caseId:'secret'}),/不存在|封存/);
});
test('history comparisons require complete matching reading contexts and actual saved rows',()=>{
 const before={context,scores:{engineRev:rev},results:[{case_id:'t',strict:false},{case_id:'h',strict:true}]};
 const after={context,scores:{engineRev:rev},results:[{case_id:'t',strict:true},{case_id:'h',strict:false}]};
 const opts={state,cases,graph,source:{id:'run:x',label:'历史运行',before,after}};
 const r=buildCaseReview(opts);assert.equal(r.rows[0].change,'fixed');assert.equal(r.rows[1].change,'regressed');
 const unknown=buildCaseReview({...opts,source:{...opts.source,before:{...before,context:undefined}}});assert.equal(unknown.rows[0].change,'unavailable');
 const changed=buildCaseReview({...opts,source:{...opts.source,after:{...after,context:{...context,engineRev:{...rev,protoRev:4}}}}});assert.equal(changed.comparable,false);
});
test('missing or stale current scores are explicit and never turn absent evidence into a failure',()=>{
 const r=buildCaseReview({state:{...state,baseline:null},cases,graph,baselineCurrent:false});assert.equal(r.rows[0].result,null);assert.equal(r.baselineCurrent,false);
 const stale=buildCaseReview({state,cases,graph,baselineCurrent:false});assert.equal(stale.rows[0].result.strict,true);assert.equal(stale.baselineCurrent,false);
});
