'use strict';

/*
 * 图谱知识测试集（评测集）确定性引擎 —— 脚本 CLI / REST / MCP / graph-builder-agent 四路共用。
 *
 * 数据来源：data/graphs/org/<asset>/org-graph-manifest.json 的 active_version（builder 页发布的图谱，
 * 权威绑定 {assetId, version, digest}）；digest = canonicalJson(nodes+edges) 的 sha256，
 * 与 services/ai-native-bank/intent-conformance-eval.js 同算法。
 *
 * 派生规则（全部从图声明推导，不引入任何意图专属词表）：
 *   SINGLE_INTENT    每个叶子 INTENT 一例（execute/knowledge 子类），说法取 scope_in，负例取 scope_out
 *                    并解析 negativeIntentIds 溯源；knowledge 期望关联 has_knowledge_answer 的答案节点
 *   MULTI_INTENT     两意图 scope_in 说法用连接词组合：同域/跨域/同对象 ASK+DO（依据 KNOWLEDGE_ANSWER
 *                    boundary_rules「拆成 ASK+DO 组合任务」）/ QUERY+CHANGE
 *   AMBIGUOUS_INTENT A.scope_out 的说法命中 B.scope_in（图声明混淆对，同业务对象优先）+ 多意图共享说法 → clarify
 *   INTENT_SWITCH    两轮：turn1 建立意图 A 上下文，turn2 属于意图 B → 跳转 B
 *   BOUNDARY         scope_out 解析不到任何意图的超范围说法 + RUNTIME_BOUNDARY 闲聊节点
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_ROOT = path.join(__dirname, '..', 'data');
const OUTPUT_DIR = path.join(DATA_ROOT, 'evals');
const DATASET_ID = 'intent-graph-knowledge-eval-v1';
const CONNECTIVES = ['，然后', '，再', '，之后', '，顺便'];
const DEFAULT_LIMITS = {
  multiWithinDomain: 8,
  multiCrossDomain: 8,
  multiAskDo: 4,
  multiQueryChange: 4,
  ambiguous: 30,
  switchCrossDomain: 10,
  switchWithinDomain: 10,
  boundaryOoc: 10,
  positiveUtterances: 4,
  negativeUtterances: 3,
};

class EvalDatasetError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function uniqueStrings(values) {
  return [...new Set((values || []).filter(v => typeof v === 'string' && v.trim()).map(v => v.trim()))];
}

function readAssetId(manifestPath) {
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8')).asset_id || null;
  } catch {
    return null;
  }
}

/** 目录名≠asset_id（如 intent-graph 资产在 intent 目录）：先试直配，再扫一级域与 custom 子目录的 manifest。 */
function resolveManifestPath(asset) {
  const assetId = String(asset || 'intent-graph').trim();
  if (!/^[a-z0-9-]+$/i.test(assetId)) {
    throw new EvalDatasetError('EVAL_ASSET_INVALID', `非法资产 ID：${assetId}`);
  }
  const orgRoot = path.join(DATA_ROOT, 'graphs', 'org');
  const direct = path.join(orgRoot, assetId, 'org-graph-manifest.json');
  if (fs.existsSync(direct) && readAssetId(direct) === assetId) return direct;
  const searchRoots = [orgRoot, path.join(orgRoot, 'custom')];
  for (const searchRoot of searchRoots) {
    if (!fs.existsSync(searchRoot)) continue;
    for (const name of fs.readdirSync(searchRoot).sort()) {
      const candidate = path.join(searchRoot, name, 'org-graph-manifest.json');
      if (fs.existsSync(candidate) && readAssetId(candidate) === assetId) return candidate;
    }
  }
  throw new EvalDatasetError('EVAL_ASSET_NOT_FOUND', `资产 ${assetId} 没有 org-graph-manifest.json`, 404);
}

function loadGraph(asset) {
  const manifestPath = resolveManifestPath(asset);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const version = manifest.active_version;
  const entry = (manifest.versions || []).find(item => item.version === version);
  if (!entry) {
    throw new EvalDatasetError('EVAL_VERSION_NOT_FOUND', `active_version ${version} 不在 manifest versions 中`);
  }
  // 版本文件是 gitignore 的运行期产物：fresh clone 后 manifest（入库）指向的文件不存在，裸 ENOENT 会一路透到 agent
  const versionPath = path.join(path.dirname(manifestPath), entry.file);
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(versionPath, 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw new EvalDatasetError(
        'EVAL_VERSION_FILE_MISSING',
        `active 版本文件缺失：manifest 指向 ${entry.file} 但文件不存在。fresh 部署请先在图谱管理发布一次，或恢复版本文件后再生成测试集`,
        409,
      );
    }
    throw err;
  }
  if (!Array.isArray(doc.nodes) || !Array.isArray(doc.edges)) {
    throw new EvalDatasetError('EVAL_GRAPH_INVALID', '图文档缺少 nodes/edges 数组');
  }
  return { manifest, manifestPath, entry, doc, graphDigest: digest({ nodes: doc.nodes, edges: doc.edges }) };
}

/** 紧凑索引：给 LLM/MCP 看的图概览（不含完整 scope 数组，防止上下文爆炸）。 */
function buildEvalScaffold(asset) {
  const { manifest, entry, doc, graphDigest } = loadGraph(asset);
  const nodes = doc.nodes;
  const intents = nodes.filter(n => n.type === 'INTENT');
  const executable = intents.filter(n => n.properties.is_executable_leaf === true);
  const knowledge = intents.filter(n => n.properties.is_knowledge_intent === true);
  const aggregates = nodes.filter(n => n.type === 'AGGREGATE_INTENT');
  const boundary = nodes.find(n => n.type === 'RUNTIME_BOUNDARY');
  const domains = [...new Set(intents.map(n => n.properties.domain).filter(Boolean))];

  const scopeInOwners = new Map();
  for (const intent of intents) {
    for (const phrase of uniqueStrings(intent.properties.scope_in)) {
      const owners = scopeInOwners.get(phrase) || [];
      owners.push(intent.id);
      scopeInOwners.set(phrase, owners);
    }
  }
  const objectOf = new Map();
  for (const edge of doc.edges) {
    if (edge.type === 'acts_on_object') objectOf.set(edge.source, edge.target);
  }
  const objectMembers = new Map();
  for (const [intentId, obj] of objectOf.entries()) {
    const list = objectMembers.get(obj) || [];
    list.push(intentId);
    objectMembers.set(obj, list);
  }

  let declaredConflicts = 0;
  for (const intent of intents) {
    for (const phrase of uniqueStrings(intent.properties.scope_out)) {
      declaredConflicts += (scopeInOwners.get(phrase) || []).filter(id => id !== intent.id).length;
    }
  }

  return {
    graph: {
      assetId: manifest.asset_id,
      version: entry.version,
      documentId: doc.document_id,
      digest: graphDigest,
      stats: { nodes: nodes.length, edges: doc.edges.length },
    },
    leaves: {
      executable: executable.length,
      knowledge: knowledge.length,
      total: intents.length,
    },
    domains,
    aggregates: aggregates.map(n => ({ id: n.id, name: n.properties.name, domain: n.properties.domain })),
    signals: {
      declaredScopeConflicts: declaredConflicts,
      sharedSurfaces: [...scopeInOwners.values()].filter(ids => ids.length > 1).length,
      sharedObjectFamilies: [...objectMembers.values()].filter(ids => ids.length > 1).length,
      boundary: boundary ? { id: boundary.id, code: boundary.properties.boundary_code } : null,
    },
    derivation: {
      datasetId: DATASET_ID,
      categories: ['SINGLE_INTENT', 'MULTI_INTENT', 'AMBIGUOUS_INTENT', 'INTENT_SWITCH', 'BOUNDARY'],
      utteranceSource: 'scope_in/scope_out 原文（组合仅用连接词语法，无意图专属词表）',
    },
  };
}

function buildCases(doc, options) {
  const limits = { ...DEFAULT_LIMITS, ...(options && options.limits) };
  const nodes = doc.nodes;
  const edges = doc.edges;
  const nameOf = new Map(nodes.map(n => [n.id, n.properties.name]));
  const intents = nodes
    .filter(n => n.type === 'INTENT')
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id));
  const executable = intents.filter(n => n.properties.is_executable_leaf === true);

  const scopeInOwners = new Map();
  for (const intent of intents) {
    for (const phrase of uniqueStrings(intent.properties.scope_in)) {
      const owners = scopeInOwners.get(phrase) || [];
      owners.push(intent.id);
      scopeInOwners.set(phrase, owners);
    }
  }
  const knowledgeAnswerOf = new Map();
  for (const edge of edges) {
    if (edge.type === 'has_knowledge_answer') knowledgeAnswerOf.set(edge.source, edge.target);
  }
  const objectOf = new Map();
  for (const edge of edges) {
    if (edge.type === 'acts_on_object') objectOf.set(edge.source, edge.target);
  }
  const aggregateOf = new Map(nodes.filter(n => n.type === 'AGGREGATE_INTENT').map(n => [n.id, n]));

  const phrasesOf = intent => uniqueStrings(intent.properties.scope_in);
  const contextOf = intent => ({
    domain: intent.properties.domain,
    aggregate: aggregateOf.get(intent.properties.parent_intent_id)
      ? nameOf.get(intent.properties.parent_intent_id)
      : null,
  });
  const pickPhrase = intent => phrasesOf(intent)[0] || intent.properties.name;
  const connective = index => CONNECTIVES[index % CONNECTIVES.length];

  const cases = [];
  const usedCaseIds = new Set();
  const pushCase = item => {
    if (usedCaseIds.has(item.caseId)) return;
    usedCaseIds.add(item.caseId);
    cases.push(item);
  };

  // ---- SINGLE_INTENT：全量叶子覆盖 ----
  for (const intent of intents) {
    const positive = phrasesOf(intent);
    const negatives = uniqueStrings(intent.properties.scope_out).slice(0, limits.negativeUtterances)
      .map(phrase => ({ phrase, negativeIntentIds: scopeInOwners.get(phrase) || [] }));
    const isKnowledge = intent.properties.is_knowledge_intent === true;
    const answerId = knowledgeAnswerOf.get(intent.id) || null;
    pushCase({
      caseId: `single:${intent.id}`,
      category: 'SINGLE_INTENT',
      subcategory: isKnowledge ? 'knowledge' : 'execute',
      query: positive[0],
      turns: [positive[0]],
      pageContext: contextOf(intent),
      intentId: intent.id,
      positiveUtterances: positive.slice(0, limits.positiveUtterances),
      negativeUtterances: negatives,
      expected: isKnowledge
        ? { resolution: 'knowledge_answer', intentId: intent.id, knowledgeAnswerId: answerId }
        : { resolution: 'intent', intentId: intent.id },
      derivation: { sourceNodeIds: [intent.id], fields: ['scope_in', 'scope_out'] },
    });
  }

  // ---- MULTI_INTENT ----
  const multiSeen = new Set();
  let connIdx = 0;
  const pushMulti = (a, b, subcategory, rule) => {
    const key = [a.id, b.id].sort().join('|');
    if (multiSeen.has(key) || a.id === b.id) return;
    multiSeen.add(key);
    const phraseA = pickPhrase(a);
    const phraseB = pickPhrase(b);
    const conn = connective(connIdx++);
    pushCase({
      caseId: `multi:${subcategory}:${a.id}:${b.id}`,
      category: 'MULTI_INTENT',
      subcategory,
      query: `${phraseA}${conn}${phraseB}`,
      turns: [`${phraseA}${conn}${phraseB}`],
      pageContext: contextOf(a),
      expected: {
        resolution: 'multi_intent_plan',
        steps: [
          { order: 1, intentId: a.id },
          { order: 2, intentId: b.id },
        ],
      },
      derivation: { sourceNodeIds: [a.id, b.id], rule },
    });
  };

  const byDomain = new Map();
  for (const intent of executable) {
    const list = byDomain.get(intent.properties.domain) || [];
    list.push(intent);
    byDomain.set(intent.properties.domain, list);
  }
  const domains = [...byDomain.keys()].sort();
  for (let i = 0; i < limits.multiWithinDomain; i += 1) {
    const pool = byDomain.get(domains[i % domains.length]);
    const a = pool[i % pool.length];
    const b = pool[(i + 1 + Math.floor(i / pool.length)) % pool.length];
    pushMulti(a, b, 'within_domain', '同域两个叶子意图组合');
  }
  for (let i = 0; i < limits.multiCrossDomain; i += 1) {
    const d1 = domains[i % domains.length];
    const d2 = domains[(i + 1) % domains.length];
    const a = byDomain.get(d1)[i % byDomain.get(d1).length];
    const b = byDomain.get(d2)[i % byDomain.get(d2).length];
    pushMulti(a, b, 'cross_domain', '跨域两个叶子意图组合');
  }

  const objectMembers = new Map();
  for (const intent of intents) {
    const obj = objectOf.get(intent.id);
    if (!obj) continue;
    const list = objectMembers.get(obj) || [];
    list.push(intent);
    objectMembers.set(obj, list);
  }
  const askDoPairs = [];
  const queryChangePairs = [];
  for (const [, members] of [...objectMembers.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const ask = members.find(n => n.properties.intent_type === 'ASK');
    const doIntent = members.find(n => n.properties.intent_type === 'DO');
    const query = members.find(n => n.properties.intent_type === 'QUERY');
    const change = members.find(n => n.properties.intent_type === 'CHANGE');
    if (ask && doIntent) askDoPairs.push([ask, doIntent]);
    if (query && change) queryChangePairs.push([query, change]);
  }
  askDoPairs.slice(0, limits.multiAskDo).forEach(([ask, doIntent]) => {
    pushMulti(ask, doIntent, 'ask_do', '同一业务对象的咨询+办理组合（KNOWLEDGE_ANSWER boundary_rules: 拆成 ASK + DO 组合任务）');
  });
  queryChangePairs.slice(0, limits.multiQueryChange).forEach(([query, change]) => {
    pushMulti(query, change, 'query_change', '同一业务对象的查询+修改组合');
  });

  // ---- AMBIGUOUS_INTENT ----
  const ambiguousSeen = new Set();
  const ambiguousCount = () => cases.filter(c => c.category === 'AMBIGUOUS_INTENT').length;
  const pushAmbiguous = (phrase, candidateIds, subcategory, rule, hintIds = []) => {
    if (candidateIds.length < 2 || ambiguousSeen.has(phrase)) return;
    ambiguousSeen.add(phrase);
    pushCase({
      caseId: `ambiguous:${subcategory}:${ambiguousSeen.size}`,
      category: 'AMBIGUOUS_INTENT',
      subcategory,
      query: phrase,
      turns: [phrase],
      pageContext: contextOf(intents.find(n => n.id === candidateIds[0])),
      expected: {
        resolution: 'clarify',
        candidateIntentIds: candidateIds,
        disambiguationHintNodeIds: hintIds,
      },
      derivation: { sourceNodeIds: candidateIds, rule },
    });
  };

  const declaredPairs = [];
  for (const a of intents) {
    for (const phrase of uniqueStrings(a.properties.scope_out)) {
      for (const bId of (scopeInOwners.get(phrase) || [])) {
        if (bId === a.id) continue;
        const sameObject = objectOf.get(a.id) && objectOf.get(a.id) === objectOf.get(bId);
        declaredPairs.push({ a, bId, phrase, sameObject: sameObject === true });
      }
    }
  }
  declaredPairs.sort((x, y) => (
    (y.sameObject - x.sameObject)
    || x.a.id.localeCompare(y.a.id)
    || x.bId.localeCompare(y.bId)
    || x.phrase.localeCompare(y.phrase)
  ));
  for (const pair of declaredPairs) {
    if (ambiguousCount() >= limits.ambiguous) break;
    pushAmbiguous(pair.phrase, [pair.a.id, pair.bId], 'declared_scope_conflict',
      'A.scope_out 的说法命中 B.scope_in（图声明的负例边界交叉）',
      [pair.a.id, pair.bId].filter(id => knowledgeAnswerOf.get(id)));
  }
  const sharedPhrases = [...scopeInOwners.entries()]
    .filter(([, ids]) => ids.length > 1)
    .sort(([x], [y]) => x.localeCompare(y));
  for (const [phrase, ids] of sharedPhrases) {
    if (ambiguousCount() >= limits.ambiguous) break;
    pushAmbiguous(phrase, ids.slice().sort(), 'shared_surface', '同一说法被多个意图 scope_in 声明');
  }

  // ---- INTENT_SWITCH ----
  let switchCount = 0;
  const pushSwitch = (a, b, subcategory) => {
    if (a.id === b.id) return;
    const turn1 = pickPhrase(a);
    const turn2 = pickPhrase(b);
    pushCase({
      caseId: `switch:${subcategory}:${a.id}:${b.id}`,
      category: 'INTENT_SWITCH',
      subcategory,
      query: turn2,
      turns: [turn1, turn2],
      pageContext: contextOf(a),
      expected: {
        resolution: 'intent_switch',
        priorIntentId: a.id,
        targetIntentId: b.id,
      },
      derivation: {
        sourceNodeIds: [a.id, b.id],
        rule: 'turn1 建立意图 A 上下文，turn2 属于意图 B，期望跳转到 B',
      },
    });
    switchCount += 1;
  };
  const executablePools = domains.map(domain => byDomain.get(domain));
  for (let i = 0; i < limits.switchCrossDomain; i += 1) {
    const poolA = executablePools[i % executablePools.length];
    const poolB = executablePools[(i + 2) % executablePools.length];
    pushSwitch(poolA[i % poolA.length], poolB[i % poolB.length], 'cross_domain');
  }
  for (let i = 0; switchCount < limits.switchCrossDomain + limits.switchWithinDomain
    && i < limits.switchWithinDomain * 4; i += 1) {
    const pool = executablePools[i % executablePools.length];
    pushSwitch(pool[i % pool.length], pool[(i + 2 + Math.floor(i / pool.length)) % pool.length], 'within_domain');
  }

  // ---- BOUNDARY ----
  const boundaryNode = nodes.find(n => n.type === 'RUNTIME_BOUNDARY');
  const ooc = new Set();
  for (const intent of intents) {
    for (const phrase of uniqueStrings(intent.properties.scope_out)) {
      if (!scopeInOwners.has(phrase)) ooc.add(phrase);
    }
  }
  let oocCount = 0;
  [...ooc].sort().forEach(phrase => {
    if (oocCount >= limits.boundaryOoc) return;
    oocCount += 1;
    pushCase({
      caseId: `boundary:ooc:${oocCount}`,
      category: 'BOUNDARY',
      subcategory: 'out_of_scope',
      query: phrase,
      turns: [phrase],
      pageContext: null,
      expected: {
        resolution: 'boundary',
        boundaryCode: boundaryNode ? boundaryNode.properties.boundary_code : null,
      },
      derivation: {
        sourceNodeIds: boundaryNode ? [boundaryNode.id] : [],
        rule: 'scope_out 中无法解析到任何意图的说法（超范围）',
      },
    });
  });
  if (boundaryNode) {
    pushCase({
      caseId: 'boundary:idle-chat',
      category: 'BOUNDARY',
      subcategory: 'idle_chat',
      query: boundaryNode.properties.name,
      turns: [boundaryNode.properties.name],
      pageContext: null,
      expected: {
        resolution: 'boundary',
        boundaryCode: boundaryNode.properties.boundary_code,
        routeType: boundaryNode.properties.route_type,
      },
      derivation: { sourceNodeIds: [boundaryNode.id], fields: ['boundary_code', 'route_type', 'retrieval_policy'] },
    });
  }

  return cases;
}

function deriveEvalDataset(asset, options) {
  const opts = options || {};
  const { manifest, entry, doc, graphDigest } = loadGraph(asset);
  const cases = buildCases(doc, opts);
  const counts = {};
  for (const item of cases) counts[item.category] = (counts[item.category] || 0) + 1;
  const unsigned = {
    schemaVersion: '1.0',
    datasetId: DATASET_ID,
    coverageKind: 'categorized-scenarios',
    generatedAt: entry.published_at,
    graph: {
      assetId: manifest.asset_id,
      graphId: 'intent-graph',
      version: entry.version,
      documentId: doc.document_id,
      templateId: doc.template_ref && doc.template_ref.id ? doc.template_ref.id : doc.template_ref,
      digest: graphDigest,
    },
    categories: ['SINGLE_INTENT', 'MULTI_INTENT', 'AMBIGUOUS_INTENT', 'INTENT_SWITCH', 'BOUNDARY'],
    counts,
    cases,
    results: null,
  };
  return { dataset: { ...unsigned, digest: digest(unsigned) }, doc };
}

function validateEvalDataset(dataset, doc) {
  const errors = [];
  if (!dataset || typeof dataset !== 'object' || !Array.isArray(dataset.cases)) {
    return { valid: false, errors: [{ code: 'dataset_invalid' }] };
  }
  const intentIds = new Set((doc && doc.nodes || []).filter(n => n.type === 'INTENT').map(n => n.id));
  const nodeIds = new Set((doc && doc.nodes || []).map(n => n.id));
  const caseIds = dataset.cases.map(c => c.caseId);
  const duplicates = [...new Set(caseIds.filter((id, i) => caseIds.indexOf(id) !== i))];
  if (duplicates.length) errors.push({ code: 'duplicate_case_id', details: duplicates });

  const singleCovered = new Set(dataset.cases.filter(c => c.category === 'SINGLE_INTENT').map(c => c.intentId));
  const missing = [...intentIds].filter(id => !singleCovered.has(id));
  if (missing.length) errors.push({ code: 'single_intent_coverage_incomplete', details: missing });

  const unknownIntents = [];
  const unknownNodes = [];
  for (const c of dataset.cases) {
    for (const id of (c.derivation && c.derivation.sourceNodeIds) || []) {
      if (!nodeIds.has(id)) unknownNodes.push({ caseId: c.caseId, id });
    }
    if (c.intentId && !intentIds.has(c.intentId)) unknownIntents.push({ caseId: c.caseId, id: c.intentId });
    for (const step of (c.expected && c.expected.steps) || []) {
      if (!intentIds.has(step.intentId)) unknownIntents.push({ caseId: c.caseId, id: step.intentId });
    }
    for (const id of (c.expected && c.expected.candidateIntentIds) || []) {
      if (!intentIds.has(id)) unknownIntents.push({ caseId: c.caseId, id });
    }
  }
  if (unknownIntents.length) errors.push({ code: 'unknown_intent_id', details: unknownIntents.slice(0, 10) });
  if (unknownNodes.length) errors.push({ code: 'unknown_node_id', details: unknownNodes.slice(0, 10) });

  if (dataset.graph && dataset.graph.digest !== digest({ nodes: doc.nodes, edges: doc.edges })) {
    errors.push({ code: 'graph_digest_mismatch', message: '评测集绑定的图谱 digest 已过期，请重新派生' });
  }
  return { valid: errors.length === 0, errors };
}

function saveEvalDataset(asset, dataset, options) {
  const opts = options || {};
  if (!dataset || !dataset.graph || !dataset.digest) {
    throw new EvalDatasetError('EVAL_DATASET_INVALID', '缺少可保存的评测集（graph/digest）');
  }
  const { doc } = loadGraph(asset);
  const validation = validateEvalDataset(dataset, doc);
  if (!validation.valid) {
    const err = new EvalDatasetError('EVAL_DATASET_INVALID', '评测集校验未通过，拒绝保存', 422);
    err.details = validation.errors;
    throw err;
  }
  const outputDir = opts.outputDir || OUTPUT_DIR;
  fs.mkdirSync(outputDir, { recursive: true });
  const safeName = String(dataset.datasetId || DATASET_ID).replace(/[^a-z0-9.-]/gi, '-');
  const version = String(dataset.graph.version || '').replace(/[^a-z0-9.-]/gi, '');
  const outputPath = path.join(outputDir, `${safeName}.${version || 'unversioned'}.json`);
  fs.writeFileSync(outputPath, `${JSON.stringify(dataset, null, 2)}\n`, 'utf8');
  return { outputPath, counts: dataset.counts, digest: dataset.digest };
}

/**
 * 读取已落盘的评测集全量 JSON（供平台导入桥使用；MCP/agent 路径不得暴露此动作，
 * 否则全量 case 会进入 LLM 上下文，违反上下文安全纪律）。
 */
function loadEvalDataset(asset, options) {
  const opts = options || {};
  const datasetId = String(opts.datasetId || DATASET_ID).replace(/[^a-z0-9.-]/gi, '-');
  const outputDir = opts.outputDir || OUTPUT_DIR;
  if (!fs.existsSync(outputDir)) {
    throw new EvalDatasetError('EVAL_DATASET_NOT_FOUND', `还没有已保存的评测集（目录不存在）：${outputDir}`, 404);
  }
  let fileName;
  if (opts.version) {
    fileName = `${datasetId}.${String(opts.version).replace(/[^a-z0-9.-]/gi, '')}.json`;
    if (!fs.existsSync(path.join(outputDir, fileName))) {
      throw new EvalDatasetError('EVAL_DATASET_NOT_FOUND', `找不到 ${datasetId} 绑定图谱版本 ${opts.version} 的评测集文件`, 404);
    }
  } else {
    const candidates = fs.readdirSync(outputDir)
      .filter(name => name.startsWith(`${datasetId}.`) && name.endsWith('.json'))
      .map(name => ({ name, mtime: fs.statSync(path.join(outputDir, name)).mtimeMs }))
      .sort((x, y) => y.mtime - x.mtime);
    if (!candidates.length) {
      throw new EvalDatasetError('EVAL_DATASET_NOT_FOUND', `目录中没有 ${datasetId} 的评测集文件`, 404);
    }
    fileName = candidates[0].name;
  }
  const outputPath = path.join(outputDir, fileName);
  const dataset = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  if (!dataset || !dataset.graph || !Array.isArray(dataset.cases)) {
    throw new EvalDatasetError('EVAL_DATASET_INVALID', `评测集文件损坏（缺 graph/cases）：${fileName}`, 422);
  }
  return { dataset, outputPath: fileName, counts: dataset.counts, graph: dataset.graph, digest: dataset.digest };
}

/** MCP/REST/Python 工具共用的动作分发：scaffold | derive | validate | save | load。 */
function runEvalDatasetAction(action, args) {
  const a = args || {};
  switch (action) {
    case 'scaffold':
      return buildEvalScaffold(a.asset);
    case 'derive': {
      const { dataset } = deriveEvalDataset(a.asset, a.options);
      return summarize(dataset, a.options);
    }
    case 'validate': {
      const { doc } = loadGraph(a.asset);
      const validation = validateEvalDataset(a.dataset, doc);
      return { ...validation, counts: a.dataset && a.dataset.counts };
    }
    case 'save': {
      const payload = a.dataset || deriveEvalDataset(a.asset, a.options).dataset;
      const saved = saveEvalDataset(a.asset, payload, a);
      return { ...summarize(payload, a.options), saved };
    }
    case 'load':
      return loadEvalDataset(a.asset, a);
    default:
      throw new EvalDatasetError('EVAL_ACTION_UNKNOWN', `未知动作：${action}（支持 scaffold/derive/validate/save/load）`);
  }
}

/** 面向 LLM 的摘要：绑定 + 分类计数 + 每类样例，绝不含全量 case（防上下文爆炸）。 */
function summarize(dataset, options) {
  const perCategory = Math.max(1, Number((options && options.samplePerCategory) || 2));
  const samples = {};
  for (const category of dataset.categories || []) {
    samples[category] = (dataset.cases || [])
      .filter(c => c.category === category)
      .slice(0, perCategory);
  }
  return {
    datasetId: dataset.datasetId,
    graph: dataset.graph,
    counts: dataset.counts,
    totalCases: (dataset.cases || []).length,
    digest: dataset.digest,
    samples,
  };
}

module.exports = {
  DATASET_ID,
  DEFAULT_LIMITS,
  EvalDatasetError,
  canonicalJson,
  digest,
  loadGraph,
  buildEvalScaffold,
  deriveEvalDataset,
  validateEvalDataset,
  saveEvalDataset,
  loadEvalDataset,
  runEvalDatasetAction,
  summarize,
};
