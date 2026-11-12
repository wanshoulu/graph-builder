'use strict';
/**
 * 图召回通道（RSI 与 v2 引擎共用）。
 * 不依赖外部图数据库进程：直接使用意图图谱节点自身携带的关系做子图扩展召回。
 * 关系来源：
 *   ① confusable_intents —— 显式混淆边（A2 算子写入的优化杠杆）
 *   ② 共享业务对象 object_view
 *   ③ 共享动作 action_view
 *   ④ 同一父节点（兄弟意图）
 * 高频通用词（如“查询/查看/财富管理”）按文档频率过滤，避免邻接退化成全连接。
 */

const RELATION_WEIGHTS = Object.freeze({
  confusable: 1.0,
  shared_object: 0.85,
  shared_action: 0.7,
  sibling: 0.55,
});

const RELATION_LABELS = Object.freeze({
  confusable: '声明混淆',
  shared_object: '共享业务对象',
  shared_action: '共享动作',
  sibling: '同级兄弟意图',
});

const norm = value => String(value == null ? '' : value).trim().toLowerCase();
const list = value => (Array.isArray(value) ? value : []);

function nodeTokenBuckets(node) {
  const rp = node.retrieval_profile || {};
  const sd = node.semantic_definition || {};
  return {
    objects: list(rp.object_view).map(norm).filter(Boolean),
    actions: list(rp.action_view).map(norm).filter(Boolean),
    confusable: list(sd.confusable_intents).map(item => String(item || '').trim()).filter(Boolean),
    parent: String((node.identity && node.identity.parent_intent_id) || '').trim(),
  };
}

/** 按文档频率过滤通用词：保留真正能区分意图的关系词。 */
function pruneByFrequency(bucket, nodeCount, maxRatio) {
  const out = new Map();
  const limit = Math.max(4, Math.floor(nodeCount * (maxRatio == null ? 0.2 : maxRatio)));
  for (const [token, ids] of bucket) {
    if (ids.length >= 2 && ids.length <= limit) out.set(token, ids);
  }
  return out;
}

/**
 * 构建图索引。入参可以是 {intent_nodes} 图谱，也可以是节点数组。
 * 返回 {byId, byObject, byAction, byParent, confusable, nodeCount, edgeCount}
 */
function buildGraphIndex(graphOrNodes) {
  const nodes = Array.isArray(graphOrNodes)
    ? graphOrNodes
    : list(graphOrNodes && graphOrNodes.intent_nodes);
  const byId = new Map();
  const rawObject = new Map();
  const rawAction = new Map();
  const byParent = new Map();
  const confusable = new Map();
  for (const node of nodes) {
    const id = node && node.identity && node.identity.intent_id;
    if (!id) continue;
    byId.set(id, node);
    const buckets = nodeTokenBuckets(node);
    for (const token of buckets.objects) {
      if (!rawObject.has(token)) rawObject.set(token, []);
      rawObject.get(token).push(id);
    }
    for (const token of buckets.actions) {
      if (!rawAction.has(token)) rawAction.set(token, []);
      rawAction.get(token).push(id);
    }
    if (buckets.parent) {
      if (!byParent.has(buckets.parent)) byParent.set(buckets.parent, []);
      byParent.get(buckets.parent).push(id);
    }
    for (const other of buckets.confusable) {
      if (!byId.has(other) && !nodes.some(item => item.identity && item.identity.intent_id === other)) continue;
      if (!confusable.has(id)) confusable.set(id, new Set());
      confusable.get(id).add(other);
      if (!confusable.has(other)) confusable.set(other, new Set());
      confusable.get(other).add(id);
    }
  }
  const byObject = pruneByFrequency(rawObject, byId.size);
  const byAction = pruneByFrequency(rawAction, byId.size);
  let edgeCount = 0;
  for (const bucket of [byObject, byAction]) {
    for (const ids of bucket.values()) edgeCount += ids.length - 1;
  }
  for (const ids of confusable.values()) edgeCount += ids.size;
  for (const ids of byParent.values()) edgeCount += ids.length >= 2 ? ids.length : 0;
  return { byId, byObject, byAction, byParent, confusable, nodeCount: byId.size, edgeCount };
}

/** 收集某意图的全部图关系邻居：Map<neighborId, {relation, weight}>，同邻居保留最强关系。 */
function neighborsOf(index, intentId) {
  const out = new Map();
  const push = (other, relation, weight) => {
    if (!other || other === intentId || !index.byId.has(other)) return;
    const prev = out.get(other);
    if (!prev || prev.weight < weight) out.set(other, { relation, weight });
  };
  for (const other of index.confusable.get(intentId) || []) push(other, 'confusable', RELATION_WEIGHTS.confusable);
  for (const ids of index.byObject.values()) {
    if (ids.includes(intentId)) for (const other of ids) push(other, 'shared_object', RELATION_WEIGHTS.shared_object);
  }
  for (const ids of index.byAction.values()) {
    if (ids.includes(intentId)) for (const other of ids) push(other, 'shared_action', RELATION_WEIGHTS.shared_action);
  }
  const parent = ((index.byId.get(intentId) || {}).identity || {}).parent_intent_id;
  const siblings = parent ? index.byParent.get(parent) : null;
  if (siblings && siblings.length >= 2 && siblings.length <= 8) {
    for (const other of siblings) push(other, 'sibling', RELATION_WEIGHTS.sibling);
  }
  return out;
}

/**
 * 子图扩展召回：从已有高置信候选出发，沿图关系扩展 1 跳邻居。
 * seeds: [{intent_id, score}]
 * 返回 [{intent_id, intent_name, score, rank, relation, evidence, via}]
 */
function graphRecall(seeds, index, options) {
  const opts = options || {};
  const limit = Math.max(1, Math.min(Number(opts.limit) || 4, 8));
  const minSeedScore = Number.isFinite(opts.minSeedScore) ? opts.minSeedScore : 0.3;
  const minScore = Number.isFinite(opts.minScore) ? opts.minScore : 0.2;
  const weights = opts.relationWeights || RELATION_WEIGHTS;
  const hop2Decay = Number.isFinite(opts.hop2Decay) ? opts.hop2Decay : 0;
  const best = new Map();
  const seedIds = new Set(list(seeds).map(s => s && s.intent_id).filter(Boolean));

  function collectNeighbors(seedList, scoreScale) {
    for (const seed of seedList) {
      const id = seed && seed.intent_id;
      const seedScore = Number(seed && seed.score);
      if (!id || !index.byId.has(id) || !Number.isFinite(seedScore) || seedScore < minSeedScore) continue;
      for (const [otherId, edge] of neighborsOf(index, id)) {
        if (seedIds.has(otherId)) continue;
        const weight = weights[edge.relation] || edge.weight;
        const score = Math.min(1, seedScore) * weight * scoreScale;
        if (score < minScore) continue;
        const prev = best.get(otherId);
        if (!prev || prev.score < score) {
          best.set(otherId, {
            intent_id: otherId,
            intent_name: (index.byId.get(otherId).identity || {}).intent_name || otherId,
            score,
            relation: edge.relation,
            via: id,
            support: new Set([id, ...((prev && prev.viaSeeds) || [])]).size,
            viaSeeds: [id, ...((prev && prev.viaSeeds) || [])],
            evidence: ['graph:' + edge.relation],
          });
        } else if (!prev.viaSeeds.includes(id)) {
          prev.support += 1;
          prev.viaSeeds.push(id);
        }
      }
    }
  }

  // 第 1 跳：从词法高置信种子扩展
  collectNeighbors(list(seeds), 1);
  // 第 2 跳：从第 1 跳结果中取 top 3 再扩展一跳（衰减 hop2Decay）
  const hop1Top = Array.from(best.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  collectNeighbors(hop1Top, hop2Decay);

  return Array.from(best.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((row, i) => ({
      intent_id: row.intent_id,
      intent_name: row.intent_name,
      score: Math.round(row.score * 1000) / 1000,
      rank: i + 1,
      relation: row.relation,
      relation_label: RELATION_LABELS[row.relation] || row.relation,
      via: row.via,
      support: row.support,
      evidence: row.evidence,
    }));
}

module.exports = { RELATION_WEIGHTS, RELATION_LABELS, buildGraphIndex, neighborsOf, graphRecall };
