'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
// Keep source bytes, never mutable parsed objects: callers own their state.
const stateSources = new Map();
const pendingSources = new Map();
let stateSourceBytes = 0;
// 单文件缓存上限：fresh-bank 任务 state 已达 91MB，64MB 上限会让它永远不缓存，
// 每个请求都经 gRPC-FUSE 冷读 ~10s（lineage/bases 因此撞前端 30s 超时）。
const SOURCE_CACHE_LIMIT = 256 * 1024 * 1024;
const sourceStamp=stat=>[stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(':');
function rememberSource(file,stamp,source){
  const previous=stateSources.get(file),bytes=Buffer.byteLength(source);
  if(previous){stateSourceBytes-=previous.bytes;stateSources.delete(file);}
  if(bytes>SOURCE_CACHE_LIMIT)return;
  while(stateSources.size&&stateSourceBytes+bytes>SOURCE_CACHE_LIMIT){const oldest=stateSources.keys().next().value;stateSourceBytes-=stateSources.get(oldest).bytes;stateSources.delete(oldest);}
  stateSources.set(file,{stamp,source,bytes});stateSourceBytes+=bytes;
}
async function readStateJsonAsync(file,attempt=0){
  let stat;
  try{stat=await fs.promises.stat(file,{bigint:true});}
  catch(error){const old=stateSources.get(file);if(old){stateSourceBytes-=old.bytes;stateSources.delete(file);}throw error;}
  const stamp=sourceStamp(stat),previous=stateSources.get(file);
  if(previous?.stamp===stamp)return JSON.parse(previous.source);
  const key=file+':'+stamp;
  let pending=pendingSources.get(key);
  if(!pending){pending=(async()=>{
    const source=await fs.promises.readFile(file,'utf8');
    const latest=await fs.promises.stat(file,{bigint:true});
    if(sourceStamp(latest)!==stamp)return null;
    // Validate before caching bytes; each caller receives its own parsed object.
    JSON.parse(source);rememberSource(file,stamp,source);return source;
  })();pendingSources.set(key,pending);const clear=()=>{if(pendingSources.get(key)===pending)pendingSources.delete(key);};pending.then(clear,clear);}
  const source=await pending;
  if(source===null){if(attempt<2)return readStateJsonAsync(file,attempt+1);throw Object.assign(new Error('任务正在更新，请重新读取'),{statusCode:409});}
  return JSON.parse(source);
}
function readStateJson(file) {
  let stat;
  try { stat = fs.statSync(file, { bigint: true }); }
  catch (error) {
    const previous = stateSources.get(file);
    if (previous) { stateSourceBytes -= previous.bytes; stateSources.delete(file); }
    throw error;
  }
  const stamp = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
  const previous = stateSources.get(file);
  if (previous?.stamp === stamp) return JSON.parse(previous.source);
  const source = fs.readFileSync(file, 'utf8');
  const value = JSON.parse(source), bytes = Buffer.byteLength(source);
  if (previous) { stateSourceBytes -= previous.bytes; stateSources.delete(file); }
  if (bytes <= SOURCE_CACHE_LIMIT) {
    while (stateSources.size && stateSourceBytes + bytes > SOURCE_CACHE_LIMIT) {
      const oldest = stateSources.keys().next().value;
      stateSourceBytes -= stateSources.get(oldest).bytes; stateSources.delete(oldest);
    }
    stateSources.set(file, { stamp, source, bytes }); stateSourceBytes += bytes;
  }
  return value;
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
  // compact 落盘：2 空格缩进会把 state 膨胀 3 倍（91MB→30MB），gRPC-FUSE 冷读时间同样省 3 倍
    try { const fd = fs.openSync(temp, 'wx'); try { fs.writeFileSync(fd, JSON.stringify(value), 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } fs.renameSync(temp, file); } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
function preserveTask(previous, fresh, preserveSplit = false) {
  for (const key of ['taskId', 'taskName', 'taskDesc', 'createdAt', 'engineRef', 'revision','archived','archivedAt']) if (previous[key] !== undefined) fresh[key] = previous[key];
  if (preserveSplit && previous.split && (previous.split.train?.length || 0) + (previous.split.heldout?.length || 0) + (previous.split.test?.length || 0) > 0) fresh.split = structuredClone(previous.split);
  return fresh;
}
module.exports = { writeJson, preserveTask, readStateJson, readStateJsonAsync };
