'use strict';
const fs=require('node:fs'),path=require('node:path');
const HEADER_BYTES=64*1024;
function readSnapshotInfo(file){
 const stat=fs.statSync(file),size=Math.min(stat.size,HEADER_BYTES),buffer=Buffer.alloc(size),fd=fs.openSync(file,'r');
 try{fs.readSync(fd,buffer,0,size,0);}finally{fs.closeSync(fd);}
 const text=buffer.toString('utf8'),id=path.basename(file,'.json');
 const stringField=name=>{const match=text.match(new RegExp('"'+name+'"\\s*:\\s*("(?:\\\\.|[^"\\\\])*")'));try{return match?JSON.parse(match[1]):null;}catch(_){return null;}};
 let count=null;if(stat.size<=HEADER_BYTES){try{const graph=JSON.parse(text);if(Array.isArray(graph.intent_nodes))count=graph.intent_nodes.length;}catch(_){}}
 return {id,label:stringField('rsi_source_name')||stringField('version_id')||id,intents:count,importedAt:stringField('rsi_imported_at')};
}
function manifestCatalog(manifest,imported){
 return (manifest.versions||[]).map(v=>({versionId:v.version_id,name:v.business_name||v.display_name||v.version_name||v.version_id,
  status:v.version_id===manifest.active_default?'active_default':v.status==='active_default'?'historical':v.status||null,
  stage:v.stage||null,graphFile:v.graph_file||null,intentCount:v.intent_count??v.summary?.intent_nodes??null,imported:imported(v.version_id)}))
  .sort((a,b)=>Number(b.status==='active_default')-Number(a.status==='active_default'));
}
module.exports={readSnapshotInfo,manifestCatalog};
