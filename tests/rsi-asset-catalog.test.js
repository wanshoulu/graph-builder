'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
test('large snapshot discovery returns its readable header without loading the graph body',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rsi-catalog-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'snapshot.json');fs.writeFileSync(file,JSON.stringify({meta:{version_id:'bank-v2',rsi_source_name:'Business graph',rsi_imported_at:'2026-10-17'},intent_nodes:[{payload:'x'.repeat(2*1024*1024)}]}));
 const {readSnapshotInfo}=require('../routes/rsi-asset-catalog');
 const original=fs.readFileSync;fs.readFileSync=(p,...args)=>{if(p===file)throw new Error('full graph read forbidden on catalog path');return original(p,...args);};t.after(()=>{fs.readFileSync=original;});
 const info=readSnapshotInfo(file);assert.equal(info.label,'Business graph');assert.equal(info.importedAt,'2026-10-17');assert.equal(info.intents,null);
});
test('small snapshot discovery keeps a measured node count and safe filename fallback',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rsi-catalog-small-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'short.json');fs.writeFileSync(file,JSON.stringify({intent_nodes:[{},{}]}));
 const info=require('../routes/rsi-asset-catalog').readSnapshotInfo(file);assert.equal(info.label,'short');assert.equal(info.intents,2);
});

test('manifest active_default wins over stale status labels and is listed first',()=>{
 const {manifestCatalog}=require('../routes/rsi-asset-catalog');
 const versions=manifestCatalog({active_default:'new',versions:[{version_id:'old',status:'active_default',version_name:'Old'},{version_id:'new',version_name:'Current'}]},()=>false);
 assert.equal(versions[0].versionId,'new');assert.equal(versions[0].status,'active_default');assert.notEqual(versions[1].status,'active_default');
});
