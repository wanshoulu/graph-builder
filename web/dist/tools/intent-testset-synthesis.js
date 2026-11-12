/**
 * 意图测试集合成引擎（唯一实现，多入口共用）。
 *
 * 设计原则（2026-09-22，与 tools/eval-dataset-tools.js 确定性派生引擎互补）：
 * - 期望权威在图谱：expected（命中意图/意图对/澄清候选/OOS）全部由图谱结构确定性构造；
 *   LLM 只合成 query 的自然表面形（风格/扰动），绝不决定期望。
 * - 上下文安全：意图卡只带紧凑字段（≤5 条说法/≤3 条负例），全量 case 永不进 LLM 上下文。
 * - 采样可复现：mulberry32 种子化随机，同 inventory+options 产出同一采样计划。
 *
 * 三大类：SINGLE_INTENT（execute/knowledge × 风格轴）、MULTI_INTENT（within_domain/
 * cross_domain/ask_do/query_change，LLM 自然融合）、AMBIGUOUS_INTENT（declared_scope_conflict/
 * shared_surface/underspecified/vague/oos）。
 */

const crypto = require('node:crypto');

const SYNTHESIZE_PATH = '/v1/testset-synthesize';
const BATCH_SIZE = 12;
const MAX_QUERY_LEN = 80;
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY = 2000;

const STYLE_LABELS = {
  colloquial: '口语化',
  ellipsis: '省略式',
  detail: '具体参数',
  polite: '礼貌措辞',
  typo: '错字扰动',
  compound: '多条件叠加',
  indirect: '间接指代',
};
const DEFAULT_STYLES = ['colloquial', 'ellipsis', 'detail', 'polite'];

/** 难度轴：仅作用于单意图表面形（多/模糊目标本身结构难度已够，不参与分轴）。
 *  难度通过风格包落地——期望仍由图谱确定性构造，LLM 只按风格包合成问法。 */
const DIFFICULTY_LEVELS = ['easy', 'medium', 'hard', 'super'];
const DIFFICULTY_LABELS = { easy: '易', medium: '中', hard: '难', super: '超难' };
const DIFFICULTY_STYLE_PACKS = {
  easy: ['colloquial', 'detail'],
  medium: ['ellipsis', 'polite'],
  hard: ['typo', 'compound'],
  super: ['typo', 'indirect', 'compound'],
};

const AMBIGUOUS_SUBCATEGORIES = ['declared', 'shared', 'underspecified', 'vague', 'oos'];
const MULTI_SUBCATEGORIES = ['within_domain', 'cross_domain', 'ask_do', 'query_change'];

function sha1(text) {
  return crypto.createHash('sha1').update(String(text), 'utf8').digest('hex');
}

function mulberry32(seedInt) {
  let a = seedInt >>> 0;
  return function next() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle(list, rng) {
  const copy = list.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function normalizeUtterance(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function charBigrams(text) {
  const s = normalizeUtterance(text);
  const out = new Set();
  for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
  return out;
}

function isCleanText(text) {
  return typeof text === 'string' && !text.includes('�') && !/[<>]/.test(text);
}

function dedupeStrings(values) {
  return [...new Set(values.map(s => String(s).trim()).filter(Boolean))];
}

function cardOf(intent) {
  return {
    intentId: intent.intentId,
    name: intent.name,
    intentType: intent.intentType || '',
    domain: intent.domain || '',
    utterances: dedupeStrings(intent.utterances || []).slice(0, 5),
    negatives: dedupeStrings(intent.negatives || []).slice(0, 3),
  };
}

/** ───────────────────────── 采样计划（确定性，0 LLM） ───────────────────────── */

function buildSamplingPlan(inventory, options) {
  const opts = {
    singleCount: 10,
    multiCount: 8,
    ambiguousCount: 8,
    ambiguousMix: { declared: true, shared: true, underspecified: true, vague: true, oos: true },
    domains: [],
    perTargetCount: 3,
    styles: DEFAULT_STYLES,
    seed: '',
    difficultyMix: null,
    multiQuota: null,
    confusableBias: false,
    ...(options || {}),
  };
  const perTargetCount = Math.max(1, Math.min(parseInt(opts.perTargetCount, 10) || 3, 5));
  const styles = (opts.styles || []).filter(s => STYLE_LABELS[s]);
  const styleAxis = styles.length ? styles : DEFAULT_STYLES;
  const count = key => Math.max(0, Math.min(parseInt(opts[key], 10) || 0, 80));
  const wantSingle = count('singleCount');
  const wantMulti = count('multiCount');
  const wantAmbiguous = count('ambiguousCount');

  // 难度分槽：权重展开成槽序列，单意图目标按槽轮替取（难度, 风格）对；不同目标错位起步保证覆盖
  const difficultyMix = opts.difficultyMix && typeof opts.difficultyMix === 'object' ? opts.difficultyMix : null;
  let slotPlan = null;
  if (difficultyMix) {
    const expanded = [];
    for (const level of DIFFICULTY_LEVELS) {
      const weight = Math.max(0, Math.min(parseInt(difficultyMix[level], 10) || 0, 200));
      for (let k = 0; k < weight; k += 1) expanded.push(level);
    }
    if (expanded.length) {
      let styleCursor = 0;
      slotPlan = expanded.map(level => ({
        difficulty: level,
        style: DIFFICULTY_STYLE_PACKS[level][styleCursor++ % DIFFICULTY_STYLE_PACKS[level].length],
      }));
    }
  }

  // 多意图配额：默认固定比例，可整体覆盖（键缺省仍回落比例）
  const MULTI_RATIO = { within_domain: 0.4, cross_domain: 0.3, ask_do: 0.15, query_change: 0.15 };
  const multiQuota = {};
  for (const sub of MULTI_SUBCATEGORIES) {
    const override = opts.multiQuota && opts.multiQuota[sub] !== undefined ? parseInt(opts.multiQuota[sub], 10) : NaN;
    multiQuota[sub] = Number.isFinite(override) ? Math.max(0, Math.min(override, 80)) : Math.ceil(wantMulti * MULTI_RATIO[sub]);
  }

  const domainFilter = new Set(opts.domains || []);
  let intents = inventory.intents.filter(i => {
    if (domainFilter.size && !domainFilter.has(i.domain)) return false;
    return Array.isArray(i.utterances) && (i.utterances.length || i.name);
  });
  const byId = new Map(inventory.intents.map(i => [i.intentId, i]));
  const rng = mulberry32(parseInt(sha1(sha1(opts.seed || 'x') + intents.length + wantSingle + wantMulti + wantAmbiguous + perTargetCount).slice(0, 8), 16));

  const targets = [];

  // ---- SINGLE_INTENT：随机叶子，executable/knowledge 轮替 ----
  const singlePool = seededShuffle(intents, rng);
  let execCursor = 0;
  let singleMade = 0;
  for (let i = 0; i < wantSingle && singlePool.length; i += 1) {
    const wantExec = i % 2 === 0;
    let pick = null;
    for (let step = 0; step < singlePool.length * 2 && !pick; step += 1) {
      const cand = singlePool[(execCursor + step) % singlePool.length];
      const unused = !targets.some(t => t.category === 'SINGLE_INTENT' && t.intent.intentId === cand.intentId);
      if (unused && (wantExec ? cand.isExecutable : cand.isKnowledge)) {
        pick = cand;
        execCursor = (execCursor + step + 1) % singlePool.length;
      }
    }
    for (let step = 0; step < singlePool.length && !pick; step += 1) {
      const cand = singlePool[(execCursor + step) % singlePool.length];
      if (!targets.some(t => t.category === 'SINGLE_INTENT' && t.intent.intentId === cand.intentId)) {
        pick = cand;
        execCursor = (execCursor + step + 1) % singlePool.length;
      }
    }
    if (!pick) break;
    const slotStyles = [];
    const difficultySlots = [];
    for (let s = 0; s < perTargetCount; s += 1) {
      const slot = slotPlan ? slotPlan[(singleMade * perTargetCount + s) % slotPlan.length] : null;
      slotStyles.push(slot ? slot.style : styleAxis[s % styleAxis.length]);
      difficultySlots.push(slot ? slot.difficulty : '');
    }
    targets.push({
      targetId: `single:${pick.intentId}`,
      kind: 'single',
      category: 'SINGLE_INTENT',
      subcategory: pick.isKnowledge ? 'knowledge' : 'execute',
      intent: cardOf(pick),
      count: perTargetCount,
      styles: slotStyles,
      ...(slotPlan ? { difficultySlots } : {}),
    });
    singleMade += 1;
  }

  // ---- MULTI_INTENT：与确定性引擎同规则采样对，LLM 负责融合成自然句 ----
  const executable = intents.filter(i => i.isExecutable);
  const multiSeen = new Set();
  const pushMulti = (a, b, subcategory) => {
    if (!a || !b || a.intentId === b.intentId) return false;
    const key = [a.intentId, b.intentId].sort().join('|');
    if (multiSeen.has(key)) return false;
    multiSeen.add(key);
    targets.push({
      targetId: `multi:${subcategory}:${a.intentId}:${b.intentId}`,
      kind: 'multi',
      category: 'MULTI_INTENT',
      subcategory,
      intents: [cardOf(a), cardOf(b)],
      count: 1,
      styles: ['colloquial'],
    });
    return true;
  };
  const byDomain = new Map();
  for (const intent of executable) {
    const list = byDomain.get(intent.domain) || [];
    list.push(intent);
    byDomain.set(intent.domain, list);
  }
  const domains = [...byDomain.keys()].sort();
  const objectMembers = new Map();
  for (const intent of intents) {
    if (!intent.object) continue;
    const list = objectMembers.get(intent.object) || [];
    list.push(intent);
    objectMembers.set(intent.object, list);
  }
  const shuffledDomains = seededShuffle(domains, rng);
  let made = 0;
  // 近义优先：同一对象上的意图对最容易互混，先耗尽同对象对再随机补同域对
  if (opts.confusableBias) {
    for (const group of seededShuffle([...objectMembers.values()], rng)) {
      if (made >= multiQuota.within_domain) break;
      const execMembers = group.filter(i => i.isExecutable);
      for (let x = 0; x < execMembers.length && made < multiQuota.within_domain; x += 1) {
        for (let y = x + 1; y < execMembers.length && made < multiQuota.within_domain; y += 1) {
          if (pushMulti(execMembers[x], execMembers[y], 'within_domain')) made += 1;
        }
      }
    }
  }
  for (let round = 0; round < 24 && made < multiQuota.within_domain; round += 1) {
    const domain = shuffledDomains[round % Math.max(shuffledDomains.length, 1)];
    const pool = byDomain.get(domain) || [];
    if (pool.length >= 2) {
      const a = pool[Math.floor(rng() * pool.length)];
      const b = pool[Math.floor(rng() * pool.length)];
      if (pushMulti(a, b, 'within_domain')) made += 1;
    }
  }
  made = 0;
  for (let round = 0; round < 24 && made < multiQuota.cross_domain && shuffledDomains.length >= 2; round += 1) {
    const d1 = shuffledDomains[round % shuffledDomains.length];
    const d2 = shuffledDomains[(round + 1) % shuffledDomains.length];
    const a = (byDomain.get(d1) || [])[Math.floor(rng() * Math.max((byDomain.get(d1) || []).length, 0))];
    const b = (byDomain.get(d2) || [])[Math.floor(rng() * Math.max((byDomain.get(d2) || []).length, 0))];
    if (pushMulti(a, b, 'cross_domain')) made += 1;
  }
  const fillTypedPairs = (want, firstType, secondType, subcategory) => {
    let filled = 0;
    const members = [...objectMembers.values()].sort((x, y) => x[0].intentId.localeCompare(y[0].intentId));
    const shuffled = seededShuffle(members, rng);
    for (const group of shuffled) {
      if (filled >= want) break;
      const a = group.find(n => n.intentType === firstType);
      const b = group.find(n => n.intentType === secondType);
      if (a && b && pushMulti(a, b, subcategory)) filled += 1;
    }
    return filled;
  };
  fillTypedPairs(multiQuota.ask_do, 'ASK', 'DO', 'ask_do');
  fillTypedPairs(multiQuota.query_change, 'QUERY', 'CHANGE', 'query_change');

  // ---- AMBIGUOUS_INTENT：图声明优先（declared/shared），再补 underspecified/vague/oos ----
  const utteranceOwners = new Map();
  for (const intent of intents) {
    for (const phrase of dedupeStrings(intent.utterances)) {
      const key = normalizeUtterance(phrase);
      if (!key) continue;
      const owners = utteranceOwners.get(key) || [];
      owners.push(intent);
      utteranceOwners.set(key, owners);
    }
  }
  const ambSeen = new Set();
  const pushAmbiguous = (target) => {
    if (ambSeen.has(target.targetId)) return;
    ambSeen.add(target.targetId);
    targets.push(target);
  };
  const ambQuota = { declared: 0, shared: 0, underspecified: 0, vague: 0, oos: 0 };
  if (wantAmbiguous > 0) {
    const enabled = AMBIGUOUS_SUBCATEGORIES.filter(s => (opts.ambiguousMix || {})[s] !== false);
    for (let i = 0; i < wantAmbiguous; i += 1) {
      ambQuota[enabled[i % enabled.length]] += 1;
    }
  }
  const cardPair = (a, b) => [cardOf(a), cardOf(b)];
  let declaredMade = 0;
  const intentList = seededShuffle(intents, rng);
  for (const a of intentList) {
    if (declaredMade >= ambQuota.declared) break;
    for (const neg of dedupeStrings(a.negatives)) {
      if (declaredMade >= ambQuota.declared) break;
      const owners = utteranceOwners.get(normalizeUtterance(neg)) || [];
      const b = owners.find(o => o.intentId !== a.intentId);
      if (!b) continue;
      pushAmbiguous({
        targetId: `ambiguous:declared:${a.intentId}:${b.intentId}`,
        kind: 'ambiguous_declared',
        category: 'AMBIGUOUS_INTENT',
        subcategory: 'declared',
        intents: cardPair(a, b),
        sharedPhrase: neg,
        count: 1,
        styles: ['colloquial'],
      });
      declaredMade += 1;
    }
  }
  let sharedMade = 0;
  for (const [key, owners] of [...utteranceOwners.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
    if (sharedMade >= ambQuota.shared) break;
    if (owners.length < 2) continue;
    pushAmbiguous({
      targetId: `ambiguous:shared:${sha1(key).slice(0, 10)}`,
      kind: 'ambiguous_shared',
      category: 'AMBIGUOUS_INTENT',
      subcategory: 'shared',
      intents: owners.slice(0, 3).map(cardOf),
      sharedPhrase: owners[0].utterances.find(u => normalizeUtterance(u) === key) || '',
      count: 1,
      styles: ['colloquial'],
    });
    sharedMade += 1;
  }
  const underspecifiedPool = seededShuffle(intents.filter(i => i.isExecutable && (i.intentType === 'DO' || i.intentType === 'CHANGE') && i.object), rng);
  for (let i = 0; i < ambQuota.underspecified && i < underspecifiedPool.length; i += 1) {
    const intent = underspecifiedPool[i];
    pushAmbiguous({
      targetId: `ambiguous:underspecified:${intent.intentId}`,
      kind: 'underspecified',
      category: 'AMBIGUOUS_INTENT',
      subcategory: 'underspecified',
      intents: [cardOf(intent)],
      count: 1,
      styles: ['colloquial'],
    });
  }
  const domainFlavors = seededShuffle(domains.length ? domains : (inventory.domains || []), rng);
  for (let i = 0; i < ambQuota.vague; i += 1) {
    pushAmbiguous({
      targetId: `ambiguous:vague:${i + 1}`,
      kind: 'vague',
      category: 'AMBIGUOUS_INTENT',
      subcategory: 'vague',
      intents: [],
      domainFlavor: domainFlavors[i % Math.max(domainFlavors.length, 1)] || '',
      count: 1,
      styles: ['colloquial'],
    });
  }
  for (let i = 0; i < ambQuota.oos; i += 1) {
    pushAmbiguous({
      targetId: `ambiguous:oos:${i + 1}`,
      kind: 'oos',
      category: 'AMBIGUOUS_INTENT',
      subcategory: 'oos',
      intents: [],
      count: 1,
      styles: ['colloquial'],
    });
  }

  const summary = {
    totalTargets: targets.length,
    byCategory: {
      SINGLE_INTENT: targets.filter(t => t.category === 'SINGLE_INTENT').length,
      MULTI_INTENT: targets.filter(t => t.category === 'MULTI_INTENT').length,
      AMBIGUOUS_INTENT: targets.filter(t => t.category === 'AMBIGUOUS_INTENT').length,
    },
    ambiguousBySubcategory: targets
      .filter(t => t.category === 'AMBIGUOUS_INTENT')
      .reduce((acc, t) => { acc[t.subcategory] = (acc[t.subcategory] || 0) + 1; return acc; }, {}),
    multiBySubcategory: targets
      .filter(t => t.category === 'MULTI_INTENT')
      .reduce((acc, t) => { acc[t.subcategory] = (acc[t.subcategory] || 0) + 1; return acc; }, {}),
    byDifficulty: slotPlan
      ? targets
        .filter(t => t.kind === 'single')
        .reduce((acc, t) => {
          for (const level of t.difficultySlots) acc[level] = (acc[level] || 0) + 1;
          return acc;
        }, {})
      : null,
    expectedCases: targets.reduce((sum, t) => sum + t.count, 0),
  };
  return {
    planId: sha1(JSON.stringify({ opts: { ...opts, seed: opts.seed || '' }, summary })),
    createdAt: new Date().toISOString(),
    graph: inventory.graph,
    options: { ...opts, perTargetCount, styles: styleAxis },
    targets,
    summary,
  };
}

/** ───────────────────────── agent 请求分批 ───────────────────────── */

function buildAgentRequests(plan, batchSize) {
  const size = Math.max(1, Math.min(batchSize || BATCH_SIZE, 16));
  const requests = [];
  for (let i = 0; i < plan.targets.length; i += size) {
    requests.push({
      batchIndex: requests.length,
      total: Math.ceil(plan.targets.length / size),
      targets: plan.targets.slice(i, i + size),
    });
  }
  return requests;
}

/** ───────────────────────── 合成结果校验 + case 组装 ───────────────────────── */

function pickStyle(text, target, index) {
  const styles = target.styles && target.styles.length ? target.styles : DEFAULT_STYLES;
  return styles[index % styles.length];
}

function buildExpected(target, text) {
  switch (target.kind) {
    case 'single':
      return {
        resolution: 'intent',
        intentId: target.intent.intentId,
        intentName: target.intent.name,
        intentType: target.intent.intentType,
        note: target.subcategory === 'knowledge' ? 'knowledge_answer' : '',
      };
    case 'multi':
      return {
        resolution: 'multi_intent',
        subcategory: target.subcategory,
        steps: target.intents.map((card, idx) => ({ order: idx + 1, intentId: card.intentId, intentName: card.name })),
      };
    case 'ambiguous_declared':
    case 'ambiguous_shared':
      return {
        resolution: 'clarify',
        subcategory: target.subcategory,
        candidateIntentIds: target.intents.map(c => c.intentId),
        candidateNames: target.intents.map(c => c.name),
      };
    case 'underspecified':
      return {
        resolution: 'intent',
        intentId: target.intents[0].intentId,
        intentName: target.intents[0].name,
        note: 'slot_missing：意图可识别但关键参数缺失，期望澄清补槽',
      };
    case 'vague':
      return { resolution: 'clarify', note: '无明确意图指向，期望澄清或引导' };
    case 'oos':
      return { resolution: 'idle_chat', note: '超出手机银行助手范围' };
    default:
      return { resolution: 'unknown' };
  }
}

function applySynthesisResults(inventory, plan, results, options) {
  const allowSeedFallback = !!(options && options.allowSeedFallback);
  const list = Array.isArray(results) ? results : [];
  const byTargetId = new Map(list.map(r => [r.targetId, r]));
  const cases = [];
  const failed = [];
  const seenQuery = new Set();
  const targetSeedIndex = new Map();
  const targetGroundIndex = new Map();
  for (const target of plan.targets) {
    const seeds = [];
    const cards = (target.intents || []).concat(target.intent ? [target.intent] : []);
    for (const card of cards) {
      for (const phrase of (card.utterances || []).concat(card.negatives || [])) seeds.push(normalizeUtterance(phrase));
    }
    if (target.sharedPhrase) seeds.push(normalizeUtterance(target.sharedPhrase));
    targetSeedIndex.set(target.targetId, new Set(seeds));
    // 词汇接地：单意图问法应与期望意图的已知说法/名称有字符二元组交集，零交集=疑似幻觉表面形
    if (target.kind === 'single' && target.intent) {
      const ground = charBigrams(target.intent.name);
      for (const phrase of dedupeStrings(target.intent.utterances || [])) {
        for (const gram of charBigrams(phrase)) ground.add(gram);
      }
      if (ground.size) targetGroundIndex.set(target.targetId, ground);
    }
  }

  for (const target of plan.targets) {
    const result = byTargetId.get(target.targetId);
    const seedSet = targetSeedIndex.get(target.targetId);
    const texts = result && result.status === 'ok'
      ? (result.utterances || []).map(u => (typeof u === 'string' ? u : u.text || '')).filter(Boolean)
      : [];
    if (!texts.length) {
      failed.push({ targetId: target.targetId, kind: target.kind, reason: (result && result.status === 'error' && result.message) || 'empty' });
      continue;
    }
    let accepted = 0;
    texts.forEach((rawText, idx) => {
      const text = String(rawText).trim();
      const key = normalizeUtterance(text);
      const style = (result.utterances && result.utterances[idx] && result.utterances[idx].style) || pickStyle(text, target, idx);
      if (!isCleanText(text) || text.length < 2 || text.length > MAX_QUERY_LEN) return;
      if (seedSet.has(key) && !(allowSeedFallback && style === 'seed_fallback')) return;
      if (seenQuery.has(key)) return;
      seenQuery.add(key);
      accepted += 1;
      const ground = targetGroundIndex.get(target.targetId);
      const suspect = ground && normalizeUtterance(text).length >= 4
        && ![...charBigrams(text)].some(g => ground.has(g)) ? 'no_lexical_ground' : '';
      const difficulty = (target.difficultySlots && target.difficultySlots[idx]) || '';
      cases.push({
        caseId: `${target.targetId}#${idx + 1}`,
        category: target.category,
        subcategory: target.subcategory,
        query: text,
        style,
        ...(difficulty ? { difficulty } : {}),
        ...(suspect ? { suspect } : {}),
        expected: buildExpected(target, text),
        derivation: {
          sourceIntentIds: (target.intents || []).map(c => c.intentId),
          graphVersion: (inventory.graph && inventory.graph.version) || '',
          targetId: target.targetId,
        },
      });
    });
    if (!accepted) failed.push({ targetId: target.targetId, kind: target.kind, reason: 'all_synthesized_rejected' });
  }

  const stats = {
    total: cases.length,
    byCategory: {},
    byStyle: {},
    byDifficulty: {},
    suspectCount: 0,
    failedCount: failed.length,
    targetCount: plan.targets.length,
  };
  for (const c of cases) {
    stats.byCategory[`${c.category}/${c.subcategory}`] = (stats.byCategory[`${c.category}/${c.subcategory}`] || 0) + 1;
    stats.byStyle[c.style] = (stats.byStyle[c.style] || 0) + 1;
    if (c.difficulty) stats.byDifficulty[c.difficulty] = (stats.byDifficulty[c.difficulty] || 0) + 1;
    if (c.suspect) stats.suspectCount += 1;
  }
  return {
    // seed 兜底与 LLM 合成必须不同 id：同 plan 两次生成互不覆盖（caseId 稳定，跨集仍可对齐对比）
    datasetId: `testset-${sha1(plan.planId + (allowSeedFallback ? 'seed:' : '') + cases.length).slice(0, 12)}`,
    createdAt: new Date().toISOString(),
    graph: inventory.graph,
    planId: plan.planId,
    cases,
    failed,
    stats,
  };
}

/** ───────────────────────── 测试用例库投影（POST /api/test-cases 载荷） ───────────────────────── */

const RESULT_TYPE_OF_RESOLUTION = {
  intent: 'single_intent',
  multi_intent: 'multi_intent_plan',
  clarify: 'clarify',
  idle_chat: 'idle_chat',
};

function expectedDisplay(expected) {
  if (!expected) return '';
  if (expected.candidateNames && expected.candidateNames.length) return `澄清候选：${[...new Set(expected.candidateNames)].join(' / ')}`;
  if (Array.isArray(expected.steps)) return expected.steps.map(s => s.intentName).join(' + ');
  return expected.intentName || expected.note || '';
}

function toTestCaseRows(dataset) {
  return dataset.cases.map(c => ({
    query: c.query,
    result_type: RESULT_TYPE_OF_RESOLUTION[c.expected.resolution] || '',
    final_intent: expectedDisplay(c.expected),
    action_code: '',
    business_object: '',
    latency_ms: 0,
    eval_mode: 'single',
    session_id: '',
    turn_index: 0,
    tags: `${c.category}/${c.subcategory}${c.difficulty ? `/${c.difficulty}` : ''}/generated`,
    source: 'batch_import',
    full_response: { expected: c.expected, derivation: c.derivation, style: c.style, datasetId: dataset.datasetId, generatedBy: 'intent-testset-synthesis' },
  }));
}

/** ───────────────────────── 上下文安全摘要（MCP/日志出口） ───────────────────────── */

function summarizeDataset(dataset, samplesPerCategory) {
  const n = Math.max(0, Math.min(samplesPerCategory || 2, 5));
  const byCategory = {};
  for (const c of dataset.cases) {
    const key = `${c.category}/${c.subcategory}`;
    if (!byCategory[key]) byCategory[key] = { count: 0, samples: [] };
    byCategory[key].count += 1;
    if (byCategory[key].samples.length < n) byCategory[key].samples.push({ query: c.query, expected: expectedDisplay(c.expected) });
  }
  return {
    datasetId: dataset.datasetId,
    graph: dataset.graph,
    total: dataset.cases.length,
    byCategory,
    failedCount: dataset.failed.length,
  };
}

/** ───────────────────────── 编排：分批调用 agent + 组装 ───────────────────────── */

function buildTargetPrompt(target) {
  const cardText = c => `- ${c.name}${c.intentType ? `（类型 ${c.intentType}）` : ''}${c.domain ? `，域 ${c.domain}` : ''}${c.object ? `，对象 ${c.object}` : ''}｜已有说法：${(c.utterances || []).join(' / ') || '无'}`;
  switch (target.kind) {
    case 'single':
      return [
        `为手机银行意图「${target.intent.name}」生成 ${target.count} 条用户可能说的问法。`,
        target.intent.utterances.length ? `已有说法（禁止重复、禁止同义复读）：${target.intent.utterances.join(' / ')}` : '（无已有说法，可参考意图名称与业务对象）',
        target.intent.negatives.length ? `以下说法属于其他意图的边界（禁止生成相近的）：${target.intent.negatives.join(' / ')}` : '',
        `风格要求（每条对应一种）：${target.styles.map(s => STYLE_LABELS[s] || s).join('、')}；每条 2~40 字；不要输出意图名称本身。`,
      ].filter(Boolean).join('\n');
    case 'multi':
      return [
        `生成 1 条把下面两个手机银行意图合并在同一句话里的自然问法（模拟用户一次提两个诉求）：`,
        target.intents.map(cardText).join('\n'),
        `要求：一句话同时包含两个诉求，顺序为先「${target.intents[0].name}」后「${target.intents[1].name}」；用自然的顺承或并列衔接（如"…之后顺便…"），不要机械拼接；30 字以内；不得逐字复用已有说法。`,
      ].join('\n');
    case 'ambiguous_declared':
    case 'ambiguous_shared':
      return [
        `生成 1 条会让手机银行助手无法判断该归到哪个意图的用户问法。`,
        `候选意图（语义上有交叉）：\n${target.intents.map(cardText).join('\n')}`,
        target.sharedPhrase ? `参考歧义说法（可在此基础上口语化改写，但不要原样输出）：${target.sharedPhrase}` : '',
        `要求：这句话对两个候选意图都说得通，模棱两可；15 字以内；不要出现任何候选意图的完整名称。`,
      ].filter(Boolean).join('\n');
    case 'underspecified': {
      const card = target.intents[0];
      return [
        `生成 1 条「意图明确但缺少关键参数」的用户问法（用户说了想做什么，但没给必要信息，助手必须追问）。`,
        `意图：${cardText(card)}`,
        `要求：包含任务动词但省略关键参数（如金额、账号、日期、期次等）；10 字以内。`,
      ].join('\n');
    }
    case 'vague':
      return [
        `生成 1 条没有明确业务意图的用户问法（指代不明、诉求含糊，助手无法直接执行，只能反问澄清）。${target.domainFlavor ? `可模糊涉及「${target.domainFlavor}」域的话题但不要点破具体业务。` : ''}`,
        `要求：口语化、像随口一说；12 字以内；不得包含任何具体业务对象或动作。`,
      ].join('\n');
    case 'oos':
      return [
        `生成 1 条明显超出手机银行 App 助手服务范围的用户问法（如天气、写文章、闲聊、订机票等生活/办公场景）。`,
        `要求：12 字以内；不要涉及银行账户、转账、理财、客服等行内业务。`,
      ].join('\n');
    default:
      return `为 ${target.targetId} 生成 ${target.count} 条测试问法。`;
  }
}

async function callSynthesizeBatch(agentBase, request, fetchImpl, timeoutMs) {
  const url = `${agentBase.replace(/\/$/, '')}${SYNTHESIZE_PATH}`;
  const body = JSON.stringify({ targets: request.targets });
  const timeout = timeoutMs || 180000;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await (fetchImpl || fetch)(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.error) throw new Error(typeof json.error === 'string' ? json.error : `agent ${res.status}`);
      return json;
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_DELAY * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * 编排入口：plan → 分批 → agent 合成 → 校验组装。
 * options.fetchImpl / options.now 仅测试注入。
 * priorResults（Map 或对象 targetId→result）：已完成的合成结果直接复用，只为剩余目标发请求（断点续跑）。
 */
async function generateDataset({ plan, inventory, agentBase, fetchImpl, concurrency = 4, onBatchDone, fallbackToSeed = true, priorResults }) {
  if (!agentBase) throw new Error('GRAPH_BUILDER_AGENT_URL 未配置');
  const prior = priorResults instanceof Map
    ? priorResults
    : new Map(Object.entries(priorResults || {}));
  const resumed = [...prior.values()];
  const pendingTargets = plan.targets.filter(t => !prior.has(t.targetId));
  const subPlan = pendingTargets.length === plan.targets.length ? plan : { ...plan, targets: pendingTargets };
  const requests = buildAgentRequests(subPlan);
  const results = [];
  const batchErrors = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, 8)) }, async () => {
    while (cursor < requests.length) {
      const request = requests[cursor];
      cursor += 1;
      try {
        const json = await callSynthesizeBatch(agentBase, request, fetchImpl);
        for (const r of (json.results || [])) results.push(r);
      } catch (err) {
        batchErrors.push(String(err.message || err));
      }
      if (typeof onBatchDone === 'function') {
        // okIndex：已成功合成的新结果（targetId→result），供调用方每批落盘断点进度（崩溃后续跑）
        const okIndex = {};
        for (const r of results) if (r && r.status === 'ok' && r.targetId) okIndex[r.targetId] = r;
        onBatchDone({ done: request.batchIndex + 1, total: request.total, okIndex });
      }
    }
  });
  await Promise.all(workers);

  let dataset = applySynthesisResults(inventory, plan, [...resumed, ...results]);
  if (fallbackToSeed && !dataset.cases.length && batchErrors.length) {
    dataset = buildSeedFallbackDataset(inventory, plan);
  }
  dataset.batchErrors = batchErrors;
  dataset.fallbackUsed = Boolean(batchErrors.length) && dataset.cases.length > 0
    && dataset.cases.every(c => c.style === 'seed_fallback');
  dataset.totalTargets = plan.targets.length;
  dataset.pendingTargets = pendingTargets.length;
  dataset.resumedTargets = resumed.filter(r => r && r.status === 'ok').length;
  dataset.resultIndex = Object.fromEntries([...resumed, ...results]
    .filter(r => r && r.status === 'ok' && r.targetId)
    .map(r => [r.targetId, r]));
  return dataset;
}

/** 兜底：LLM 全挂时退化为种子说法直用（保证管线可用，样式标记 seed_fallback） */
function buildSeedFallbackDataset(inventory, plan) {
  const rows = [];
  for (const target of plan.targets) {
    if (target.kind !== 'single' && target.kind !== 'multi') continue;
    if (target.kind === 'single') {
      const seeds = target.intent.utterances.length ? target.intent.utterances : [target.intent.name];
      rows.push({ targetId: target.targetId, status: 'ok', utterances: seeds.slice(0, target.count).map(text => ({ text, style: 'seed_fallback' })) });
    } else {
      const a = (target.intents[0].utterances[0] || target.intents[0].name);
      const b = (target.intents[1].utterances[0] || target.intents[1].name);
      rows.push({ targetId: target.targetId, status: 'ok', utterances: [{ text: `${a}，然后${b}`, style: 'seed_fallback' }] });
    }
  }
  return applySynthesisResults(inventory, plan, rows, { allowSeedFallback: true });
}

module.exports = {
  SYNTHESIZE_PATH,
  STYLE_LABELS,
  DEFAULT_STYLES,
  DIFFICULTY_LEVELS,
  DIFFICULTY_LABELS,
  DIFFICULTY_STYLE_PACKS,
  AMBIGUOUS_SUBCATEGORIES,
  MULTI_SUBCATEGORIES,
  MAX_QUERY_LEN,
  buildSamplingPlan,
  buildAgentRequests,
  applySynthesisResults,
  toTestCaseRows,
  summarizeDataset,
  buildTargetPrompt,
  callSynthesizeBatch,
  generateDataset,
  buildSeedFallbackDataset,
  expectedDisplay,
  normalizeUtterance,
  isCleanText,
};
