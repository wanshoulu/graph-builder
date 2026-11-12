'use strict';
// Bounded real-model verification on a separate frozen copy. Never writes the
// source task, changes gold, or adopts its candidate into the source graph.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
process.env.INTENT_ENGINE_CONSUME_DECLARATIONS='1';
const sourceDir=path.join(root,'data/rsi/tasks/legacy-bank-20261016');
const sourceState=JSON.parse(fs.readFileSync(path.join(sourceDir,'state.json'),'utf8'));
const sourceGraphFile=path.join(sourceDir,`rsi-graph.${sourceState.currentVersion}.json`);
const sourceCasesFile=path.join(sourceDir,'cases.imported.json');
const sourceFiles=[path.join(sourceDir,'state.json'),sourceGraphFile,sourceCasesFile];
const digest=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sourceHashes=sourceFiles.map(digest);
const graph=JSON.parse(fs.readFileSync(sourceGraphFile,'utf8'));
const rawCases=JSON.parse(fs.readFileSync(sourceCasesFile,'utf8'));
const cases=Array.isArray(rawCases)?rawCases:rawCases.cases;
const clone=x=>JSON.parse(JSON.stringify(x));
const id='causal-'+new Date().toISOString().replace(/[:.]/g,'-');
const reuseName=process.argv.find(a=>a.startsWith('--reuse='))?.slice(8);
const resumeRun=process.argv.find(a=>a.startsWith('--resume='))?.slice(9);
if(resumeRun&&!/^run_[a-zA-Z0-9_-]+$/.test(resumeRun))throw Error('Invalid checkpoint ID');
if(reuseName&&!/^validation-causal-[a-zA-Z0-9-]+$/.test(reuseName))throw Error('Invalid verification directory');
const dir=path.join(root,'data/rsi',reuseName||'validation-'+id);
fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(path.join(dir,'source-graph.json'),JSON.stringify(graph,null,2));
fs.writeFileSync(path.join(dir,'source-cases.json'),JSON.stringify(cases,null,2));
let state={taskId:id,taskName:'因果修复隔离验证',currentVersion:sourceState.currentVersion,baseGraph:sourceState.baseGraph,
  split:clone(sourceState.split),splitConfig:clone(sourceState.splitConfig),goal:clone(sourceState.goal),regression:clone(sourceState.regression||{}),
  archive:[],stats:{},evolveRuns:[],scoreHistory:[],methodHistory:[],versions:[{version:sourceState.currentVersion}],log:[]};
const {API_ROUTES}=require('../config/api-keys');
const api=require('../routes/intent-rsi').__test;
if(reuseName){
 state=JSON.parse(fs.readFileSync(path.join(dir,'state.json'),'utf8'));
 // Rebuild shape aggregates from the same immutable measured rows, using the
 // production aggregate function rather than the adapter's fallback summary.
 if(state.baseline?.results){const rows=state.baseline.results;state.baseline.scores={engineRev:state.baseline.scores.engineRev,
   train:api.aggregate(rows.filter(r=>state.split.train.includes(r.case_id))),heldout:api.aggregate(rows.filter(r=>state.split.heldout.includes(r.case_id))),all:api.aggregate(rows)};}
}
const {createProductionRuntime}=require('../routes/rsi-production-runtime');
const runtime=createProductionRuntime({root,rsiDir:dir,loadState:()=>clone(state),saveState:s=>{state=clone(s);fs.writeFileSync(path.join(dir,'state.json'),JSON.stringify(s,null,2));},
 loadGraph:()=>clone(graph),readCases:()=>clone(cases),publicState:s=>s,saveVersion:()=>{throw Error('Isolation run does not adopt');},
 applyProposal:api.applyProposal,validateProposal:api.validateProposal,aggregate:api.aggregate,attributeResults:api.attributeResults,extractJsonArray:api.extractJsonArray,
 callLLM:async(...args)=>api.callLLM(...args),
 childEnv:()=>{const env={...process.env};for(const [route,key]of [['qwen-plus','QWEN_KEY'],['deepseek-chat','DEEPSEEK_KEY']])if(!env[key]&&API_ROUTES[route]?.getKey)env[key]=API_ROUTES[route].getKey()||'';return env;}});

(async()=>{
 console.log(JSON.stringify({phase:'start',directory:dir,sourceTask:sourceState.taskId,split:{train:state.split.train.length,heldout:state.split.heldout.length,test:state.split.test.length}}));
 const progress=event=>{if(['plan','probe','evaluate','select','baseline','error','resume'].includes(event.step))console.log(JSON.stringify(event));};
 const run=resumeRun?await runtime.resume(resumeRun,progress):await runtime.evolve({commandId:id,maxRounds:3,noImproveRounds:3,scoringConcurrency:3,strategy:'manual',
  optimization:{targets:['graph'],decisionMode:'model',budget:{maxMetricCalls:5,maxMinutes:12,maxModelCalls:14,maxProbeCalls:12}}},progress);
 const champion=run.branches[run.champion],baseline=run.branches.b0;
 const result={directory:dir,sourceTask:sourceState.taskId,engineRev:run.engineRev,runId:run.id,status:run.status,stopReason:run.stopReason,
  baseline:baseline.scores,champion:{id:run.champion,scores:champion.scores,artifactHash:champion.artifactHash},usage:run.usage,
  sourceUnchanged:sourceFiles.every((file,index)=>digest(file)===sourceHashes[index]),
  sourceAssetsUnchanged:sourceFiles.slice(1).every((file,index)=>digest(file)===sourceHashes[index+1]),
  rounds:run.rounds.map(r=>({generation:r.gen,result:r.result,status:r.reasoning?.status,error:r.reasoning?.error,plan:r.reasoning?.plan,reflection:r.reasoning?.reflection})),
  branches:Object.values(run.branches).map(b=>({id:b.id,parent:b.parent,status:b.status,scores:b.scores,proposal:b.proposal,probe:b.probe,reason:b.gateReason}))};
 fs.writeFileSync(path.join(dir,'summary.json'),JSON.stringify(result,null,2));
 fs.writeFileSync(path.join(root,'data/rsi/causal-verification-latest.json'),JSON.stringify({directory:dir,summary:path.join(dir,'summary.json')},null,2));
 console.log(JSON.stringify({phase:'complete',directory:dir,baseline:result.baseline,champion:result.champion,status:run.status,usage:run.usage,sourceUnchanged:result.sourceUnchanged}));
 if(!result.sourceAssetsUnchanged)throw Error('Source graph or gold changed during verification');
})().catch(error=>{console.error(JSON.stringify({phase:'failed',directory:dir,message:error.message}));process.exitCode=1;});
