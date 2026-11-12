'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// 只放「真的决定一道题怎么被打分」的文件。策略记忆、提案生成这类模块不参与打分，
// 一旦进指纹，改一次记忆逻辑就把全部历史测量判为不可比——10-30 实测三次改
// routes/rsi-strategy.js 让 engineSha 连续变了三次（00512c→8d8d92→44bdd2），
// 策略因此每次重启都失忆、重测时重复搜索。想改打分口径请改 protoRev。
const DEPENDENCIES = [
  'routes/intent-evaluator-v2.js', 'routes/intent-evaluator-graphs.js',
  'routes/rsi-runtime-profile.js', 'scripts/rsi-engine-score.js',
  'routes/rsi-scoring-runtime.js', 'routes/rsi-case-scoring.js',
  'routes/rsi-learning.js',
  'tools/intent-graph-schema.js', 'data/graphs/intent-faq-seed.json',
];
// Stat every dependency on every call; reuse bytes only while its identity and
// timestamps are unchanged. Edits, atomic replacement, deletion and creation
// invalidate immediately, including edits that preserve file size/mtime.
const sourceCache = new Map();
function readOptional(file) {
  try {
    const stat = fs.statSync(file, { bigint: true });
    const stamp = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
    const cached = sourceCache.get(file);
    if (cached?.stamp === stamp) return cached.source;
    const source = fs.readFileSync(file, 'utf8');
    if (sourceCache.size > 512) sourceCache.clear();
    sourceCache.set(file, { stamp, source });
    return source;
  } catch (error) {
    sourceCache.delete(file);
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}
const PUBLIC_ENV = new Set(['INTENT_LLM_ROUTE', 'INTENT_LLM_MODEL', 'INTENT_EMBEDDING_ROUTE', 'AI_HARBOR_INTERNAL_URL']);
const ROUTE_FIELDS = new Set(['host', 'path', 'model', 'provider', 'dim', 'batchSize']);
// Read only literal route descriptors; never execute a config/fixture or call
// getKey. Tokenizing first keeps strings/comments inside getters out of this
// projection, so rotating credentials cannot enter even the hash preimage.
function routingConfig(source, env) {
  if (source == null) return { status: 'missing' };
  const tokens = [...source.matchAll(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|\|\||[^\s]/g)]
    .map(match => match[0]).filter(token => !token.startsWith('//') && !token.startsWith('/*'));
  const value = token => /^['"]/.test(token || '') ? token.slice(1, -1).replace(/\\(['"\\])/g, '$1') : /^\d/.test(token || '') ? Number(token) : null;
  const registry = tokens.findIndex((token, i) => token === 'API_ROUTES' && ['=', ':'].includes(tokens[i + 1]) && tokens[i + 2] === '{');
  if (registry < 0) return { status: 'unrecognized' };
  const routes = {};
  let i = registry + 3;
  while (i < tokens.length && tokens[i] !== '}') {
    const name = value(tokens[i]) ?? tokens[i];
    if (tokens[i + 1] !== ':' || tokens[i + 2] !== '{') { i++; continue; }
    i += 3;
    let depth = 1;
    const fields = {};
    while (i < tokens.length && depth) {
      const key = value(tokens[i]) ?? tokens[i];
      if (depth === 1 && ROUTE_FIELDS.has(key) && tokens[i + 1] === ':') {
        let selected = value(tokens[i + 2]);
        if (tokens[i + 2] === 'process' && tokens[i + 3] === '.' && tokens[i + 4] === 'env' && tokens[i + 5] === '.') {
          const envKey = tokens[i + 6];
          selected = PUBLIC_ENV.has(envKey) ? env[envKey] || (tokens[i + 7] === '||' ? value(tokens[i + 8]) : null) : null;
        }
        fields[key] = selected;
      }
      if (tokens[i] === '{') depth++;
      else if (tokens[i] === '}') depth--;
      i++;
    }
    routes[name] = fields;
    if (tokens[i] === ',') i++;
  }
  return routes;
}

function engineRevision(env = process.env, root = path.join(__dirname, '..')) {
  const hash = crypto.createHash('sha256');
  for (const file of DEPENDENCIES) {
    const source = readOptional(path.join(root, file));
    hash.update(JSON.stringify([file, source == null ? 'missing' : 'present', source]));
  }
  // Route/model identity matters, but secret values never enter fingerprints.
  const gateway = !!env.AI_BANK_AGENT_RUNTIME_TOKEN_FILE;
  hash.update(`internalGateway=${gateway}`);
  for (const key of PUBLIC_ENV) hash.update(JSON.stringify([key, env[key] || 'default']));
  hash.update(JSON.stringify(routingConfig(readOptional(path.join(root, 'config/api-keys.js')), env)));
  const online = gateway || ['QWEN_KEY', 'DEEPSEEK_KEY', 'KIMI_KEY', 'GLM_KEY', 'VOLCANO_KEY'].some(k => !!env[k]);
  // Protocol 3 changes task-instance and clarification quality scoring. Results
  // from protocol 2 are stale; never compare or promote across revisions.
  return { engineSha: hash.digest('hex').slice(0, 12), protoRev: 3,
    engineMode: `${online ? 'online' : 'offline-deterministic'}${env.INTENT_ENGINE_CONSUME_DECLARATIONS === '1' ? '+decl' : ''}` };
}
module.exports = { engineRevision };
