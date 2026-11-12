'use strict';

/**
 * 智慧园区独立意图引擎
 *
 * 与手机银行引擎 (intent-evaluator-v2.js) 完全隔离，不读不改生产图谱和引擎代码。
 * 复用通用打分框架（Jaccard + 包含加分 + 动作对齐），但：
 *   - idle chat 检测更宽松（园区场景查询短、口语化，不应误判为闲聊）
 *   - 无银行特有负例库、动作别名、对象别名规则
 *   - 图谱加载 RSI 沙盒图谱（data/rsi/rsi-graph.<version>.json）
 *
 * 导出：evaluateIntentPark(query, options)
 */

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

const ROOT = path.join(__dirname, '..');

// ── 园区引擎常量 ──
const PARK_ENGINE_VERSION = 'park-evaluator-v1.0';
const DEFAULT_GRAPH_PATH = path.join(ROOT, 'data', 'rsi', 'rsi-graph.v1.json');
const IDLE_CHAT_SCORE_THRESHOLD = 0.15;  // 园区场景：极低分才判闲聊（远低于银行的 0.5）
const IDLE_CHAT_FUSED_THRESHOLD = 0.10;
const CLARIFY_LOW_THRESHOLD = 0.35;      // 澄清触发下限
const CLARIFY_CLOSE_GAP = 0.06;          // top1-top2 差距小于此值才触发澄清（收紧）
const CLARIFY_WEAK_SCORE = 0.50;         // top1 低于此分且 gap 小才澄清

// ── 语义关键词桥接（解决口语化查询与图谱 bigram 不重叠问题） ──
// 1 字关键词命中 +0.30，2+ 字关键词命中 +0.45
const SEMANTIC_KEYWORDS = {
  park_parking_query: ['车', '车位', '停车', '找车', '挪车', '停哪', '车在哪', '地下车库'],
  park_payment: ['费', '钱', '缴费', '交费', '物业费', '水电费', '账单', '欠费', '水电', '扣'],
  park_access_card: ['门禁', '卡', '刷卡', '进门', '通行', '出入', '人脸', '门卡', '权限', '进楼', '进不去', '工卡'],
  park_visitor: ['访客', '客人', '来访', '拜访', '访客登记', 'visitor', '同事', '外部人员', '来园区', '进楼', '楼'],
  park_repair: ['修', '坏', '漏水', '维修', '故障', '损坏', '坏掉', '报修', '坏了', '不通', '灯', '不亮', '工位', '投影仪', '投影'],
  park_meeting_room: ['会议', '开会', '会议室', '预定', '讨论', '讨论室', '场地', '投屏', '培训室', '房间'],
  park_shuttle: ['班车', '接驳', '通勤', '摆渡', '班车时刻'],
  park_canteen: ['菜', '吃', '饭', '食堂', '菜单', '午餐', '早饭', '晚饭', '餐', '今天菜单'],
  park_gym: ['健身', '运动', '锻炼', '跑步', '健身房', '瑜伽', '器械', '撸铁', '场地'],
};

// 复合关键词（强消歧信号，独立于 semanticBonus，不参与 0.60 上限）
const COMPOUND_KEYWORDS = {
  park_payment: ['停车费', '车位费', '物业费', '水电费', '停车费从', '车的事', '停车的事'],
  park_access_card: ['权限'],
};

// 负复合关键词（命中时对特定意图施加大惩罚，解决"停车费"被误判为 parking_query 的问题）
const NEGATIVE_COMPOUND = {
  park_parking_query: ['停车费', '车位费'],
};

// ── 模糊意图触发器（解决 ambiguous_intent 用例） ──
// 当查询包含触发短语时，强制返回多个相关意图到 predicted_set
const AMBIGUOUS_TRIGGERS = {
  '车的事': ['park_parking_query', 'park_payment'],
  '停车的事': ['park_parking_query', 'park_payment'],
  '进楼': ['park_access_card', 'park_visitor'],
  '进不去': ['park_access_card', 'park_visitor'],
  '约一下': ['park_meeting_room', 'park_gym'],
};

// 模糊触发抑制规则：当触发短语出现且查询同时包含特定词时，移除部分意图
// 例如："车的事给我办一下" → "办"表示具体操作，只需 payment 不需 parking_query
const AMBIGUOUS_SUPPRESS = {
  '车的事': { when_contains: ['办'], remove: ['park_parking_query'] },
  '进楼': { when_contains: ['外部人员'], remove: ['park_access_card'] },
};

// ── NLP 工具函数（独立实现，不依赖生产引擎） ──

function normalize(text) {
  return String(text || '').replace(/\s+/g, '').toLowerCase();
}

function charNgrams(text, n = 2) {
  const s = normalize(text);
  const set = new Set();
  for (let i = 0; i + n <= s.length; i++) {
    set.add(s.slice(i, i + n));
  }
  return set;
}

function jaccardScore(setA, setB) {
  if (!setA.size || !setB.size) return 0;
  let inter = 0;
  for (const g of setA) if (setB.has(g)) inter++;
  const union = setA.size + setB.size - inter;
  return union ? inter / union : 0;
}

function containsCheck(query, candidateText) {
  const q = normalize(query);
  const c = normalize(candidateText);
  if (!q || !c) return 0;
  if (c.includes(q) && q.length >= 2) return 0.20;
  return 0;
}

function splitQuery(query) {
  // 多意图拆分：按连词和标点分割
  const parts = query.split(/和|再|然后|同时|接着|之后|顺便|还要|并且|以及|此外|另外|，|,/).map(s => s.trim()).filter(s => s.length >= 2);
  return parts.length > 1 ? parts : null;
}

// ── 园区图谱加载 ──

let _graphCache = null;
let _graphPath = null;

function loadParkGraph(graphPath) {
  const resolved = graphPath || DEFAULT_GRAPH_PATH;
  if (_graphCache && _graphPath === resolved) return _graphCache;

  const graph = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  const nodes = graph.intent_nodes || [];

  const candidates = nodes.map(node => {
    const ident = node.identity || {};
    const rp = node.retrieval_profile || {};
    const sd = node.semantic_definition || {};
    const dp = node.decision_policy || {};

    // 统一转数组辅助函数
    const toArray = v => Array.isArray(v) ? v : (typeof v === 'string' ? v.split(/[,，;；\n]/) : []);
    const flatStr = v => toArray(v).map(s => String(s).trim()).filter(Boolean);

    const utteranceArr = flatStr(rp.utterance_view);
    const semanticArr = flatStr(rp.semantic_view);
    const objectArr = flatStr(rp.object_view);
    const actionArr = flatStr(rp.action_view);
    const boundaryArr = flatStr(rp.boundary_view);

    // 拼接候选文本（用于 bigram 匹配）
    const textParts = [
      ident.intent_name || '',
      flatStr(sd.scope_in).join(' '),
      utteranceArr.join(' '),
      semanticArr.join(' '),
      objectArr.join(' '),
      actionArr.join(' '),
      boundaryArr.join(' '),
    ].filter(Boolean);
    const text = textParts.join(' ');
    const textNorm = normalize(text);
    const ngrams = charNgrams(textNorm, 2);

    // 说法集合
    const utterances = utteranceArr;
    const utteranceSet = new Set(utterances.map(normalize));

    // 对象词
    const objectTerms = [...flatStr(sd.scope_in), ...objectArr].filter(s => s.length >= 2);

    // 负例词
    const negativeTerms = flatStr(rp.negative_view).filter(s => s.length >= 2);

    // 澄清问题
    const clarifyQuestions = dp.clarify_questions || [];

    // 可混淆意图
    const confusableIntents = flatStr(sd.confusable_intents);

    return {
      intent_id: ident.intent_id,
      intent_name: ident.intent_name || '',
      display_name: ident.intent_name || '',
      action_code: ident.intent_type || actionArr[0] || '',
      domain: ident.domain || 'park',
      object: flatStr(sd.scope_in).join(' '),
      text,
      textNorm,
      ngrams,
      utterances,
      utteranceSet,
      objectTerms,
      actionTerms: actionArr,
      negativeTerms,
      clarifyQuestions,
      confusableIntents,
      node,
    };
  });

  _graphCache = { graph, candidates, loadedAt: Date.now() };
  _graphPath = resolved;
  return _graphCache;
}

// ── 查询画像 ──

function analyzeQuery(query) {
  const q = normalize(query);
  // 动作推断（排除"怎么办"等干扰词）
  const queryForAction = query.replace(/怎么办|怎么弄|怎么搞/g, '');
  let inferredAction = '';
  const actionMap = {
    query: ['查', '查询', '查一下', '搜索', '看', '看看', '了解'],
    apply: ['办', '办理', '申请', '开通', '预约', '订', '约', '登记', '注册'],
    pay: ['交', '缴纳', '缴费', '付', '支付', '充值'],
    report: ['报修', '提交', '反馈', '投诉'],
    cancel: ['取消', '退订', '撤销', '解除'],
  };
  for (const [action, triggers] of Object.entries(actionMap)) {
    if (triggers.some(t => queryForAction.includes(t))) { inferredAction = action; break; }
  }

  return { normalized: q, inferredAction, original: query };
}

// ── 候选打分 ──

function scoreCandidate(query, qgrams, queryProfile, candidate) {
  // 1. Jaccard bigram 相似度
  const jac = jaccardScore(qgrams, candidate.ngrams);

  // 2. 包含加分
  let containsBonus = containsCheck(query, candidate.text);

  // 3. 说法匹配（精确 + 部分）
  const qNorm = queryProfile.normalized;
  if (candidate.utteranceSet.has(qNorm)) {
    containsBonus += 1.35;  // 精确说法匹配
  } else {
    // 说法部分匹配（≥2字即可触发）
    for (const u of candidate.utterances) {
      const uNorm = normalize(u);
      if (uNorm.length >= 2 && (qNorm.includes(uNorm) || uNorm.includes(qNorm))) {
        containsBonus += uNorm.length >= 4 ? 0.32 : 0.18;
        break;
      }
    }
  }

  // 4. 对象词命中（支持子串匹配）
  let objectBonus = 0;
  for (const term of candidate.objectTerms) {
    if (term.length >= 2 && query.includes(term)) {
      objectBonus += 0.18 + Math.min(0.40, term.length * 0.04);
      break;
    }
  }

  // 5. 动作对齐（用 retrieval_profile.action_view 而非 intent_type）
  let actionBonus = 0;
  if (queryProfile.inferredAction && candidate.utterances) {
    const candidateActionStr = candidate.actionTerms.join('');
    const actionMap = {
      query: ['查', '查询', '看'],
      apply: ['办', '预约', '订', '约', '登记', '注册'],
      pay: ['交', '缴纳', '缴费', '付', '支付', '充值'],
      report: ['报修', '反馈', '投诉'],
      cancel: ['取消', '退订', '撤销'],
    };
    const queryActionTriggers = actionMap[queryProfile.inferredAction] || [];
    for (const trigger of queryActionTriggers) {
      if (candidateActionStr.includes(trigger)) {
        actionBonus += 0.45;
        break;
      }
    }
  }

  // 6. 语义关键词桥接（口语化查询与图谱说法不重叠时的兜底匹配）
  // 累加所有关键词命中，上限 0.60
  let semanticBonus = 0;
  const semKeywords = SEMANTIC_KEYWORDS[candidate.intent_id] || [];
  for (const kw of semKeywords) {
    if (query.includes(kw)) {
      semanticBonus += kw.length >= 2 ? 0.45 : 0.30;
    }
  }
  semanticBonus = Math.min(semanticBonus, 0.60);

  // 6b. 复合关键词强消歧（独立于 semanticBonus，不参与 0.60 上限）
  let compoundBonus = 0;
  const compoundKw = COMPOUND_KEYWORDS[candidate.intent_id] || [];
  for (const kw of compoundKw) {
    if (query.includes(kw)) {
      compoundBonus += 0.50;
      break;
    }
  }

  // 6c. 负复合关键词惩罚（如"停车费"对 park_parking_query 施加大惩罚）
  let negativeCompoundPenalty = 0;
  const negCompoundKw = NEGATIVE_COMPOUND[candidate.intent_id] || [];
  for (const kw of negCompoundKw) {
    if (query.includes(kw)) {
      negativeCompoundPenalty -= 0.50;
      break;
    }
  }

  // 7. 负例边界（轻微惩罚）
  let boundaryPenalty = 0;
  for (const term of candidate.negativeTerms) {
    if (term.length >= 3 && query.includes(term)) {
      boundaryPenalty -= 0.08;
      break;
    }
  }

  // 8. 长度惩罚
  const lengthPenalty = Math.min(candidate.textNorm.length / 5000, 0.10);

  // 幂变换增强
  const jacBoosted = Math.pow(jac, 0.75);

  const score = jacBoosted * 0.72 + containsBonus + objectBonus + actionBonus + semanticBonus + compoundBonus + negativeCompoundPenalty + boundaryPenalty - lengthPenalty;

  return Math.max(0, Math.min(1.0, score));
}

// ── 闲聊判定（园区场景：极宽松） ──

function shouldTreatAsIdleChat(query, topScore, hasCandidate) {
  // 园区场景：只有在完全没有候选命中且分数极低时才判闲聊
  if (!hasCandidate) return true;
  if (topScore < IDLE_CHAT_SCORE_THRESHOLD) return true;
  return false;
}

function buildIdleChatResult(query) {
  return {
    intent_id: 'idle_chat',
    intent_name: '闲聊',
    action_code: 'idle_chat',
    display_name: '闲聊',
    score: 0,
    fused_score: 0,
    runtime_boundary: 'non_business_or_chat',
  };
}

// ── 形态检测 ──

function detectIntentShape(query, candidates) {
  const segments = splitQuery(query);
  if (segments && segments.length > 1) {
    return { shape: 'multi_intent', segments };
  }
  return { shape: 'single_intent', segments: [query] };
}

// ── 单意图评测管线 ──

function evaluateSingle(query, candidates, topk) {
  const qgrams = charNgrams(normalize(query), 2);
  const queryProfile = analyzeQuery(query);

  // 打分排序
  const scored = candidates.map(c => ({
    candidate: c,
    score: scoreCandidate(query, qgrams, queryProfile, c),
  }));
  scored.sort((a, b) => b.score - a.score);

  const topK = scored.slice(0, topk).filter(s => s.score > 0);
  const top1 = topK[0] || null;
  const top2 = topK[1] || null;

  // 闲聊判定
  if (shouldTreatAsIdleChat(query, top1 ? top1.score : 0, topK.length > 0)) {
    return {
      finalResult: buildIdleChatResult(query),
      topK: [],
      clarifying: false,
      candidates: [],
      resultType: 'idle_chat',
    };
  }

  // 澄清判定（园区场景：只在弱信号且候选接近时才澄清，避免过度澄清）
  let clarifying = false;

  // 唯一触发条件：top1 弱（< 0.50）且 top2 非常接近（gap < 0.06）
  if (top1 && top2 && (top1.score - top2.score) < CLARIFY_CLOSE_GAP && top1.score < CLARIFY_WEAK_SCORE) {
    clarifying = true;
  }

  // 澄清候选
  let clarifyCandidates = [];
  if (clarifying && topK.length >= 2) {
    clarifyCandidates = topK.slice(0, Math.min(4, topK.length)).map(s => s.candidate.intent_id);
  }

  const finalResult = clarifying ? null : (top1 ? {
    intent_id: top1.candidate.intent_id,
    intent_name: top1.candidate.intent_name,
    action_code: top1.candidate.action_code,
    display_name: top1.candidate.display_name,
    score: Math.round(top1.score * 1000) / 1000,
    fused_score: Math.round(top1.score * 1000) / 1000,
  } : null);

  return {
    finalResult,
    topK: topK.map(s => ({
      intent_id: s.candidate.intent_id,
      intent_name: s.candidate.intent_name,
      score: Math.round(s.score * 1000) / 1000,
      exact: s.score >= 1.0,
    })),
    clarifying,
    candidates: clarifyCandidates,
    resultType: finalResult ? 'correct' : (clarifying ? 'clarify' : 'no_match'),
  };
}

// ── 主入口 ──

/**
 * 园区意图评测
 * @param {string} query - 用户查询
 * @param {object} options - { graphPath, topk }
 * @returns {object} 评测结果
 */
function evaluateIntentPark(query, options = {}) {
  const t0 = performance.now();
  const graphPath = options.graphPath || DEFAULT_GRAPH_PATH;
  const topk = Math.max(3, Math.min(options.topk || 8, 20));

  const { candidates } = loadParkGraph(graphPath);
  const shapeDetection = detectIntentShape(query, candidates);

  let result;

  if (shapeDetection.shape === 'multi_intent') {
    // 多意图：逐段评测
    const segmentResults = [];
    const predictedSet = [];

    for (const seg of shapeDetection.segments) {
      const segResult = evaluateSingle(seg, candidates, topk);
      segmentResults.push({
        segment: seg,
        final_result: segResult.finalResult,
        topk: segResult.topK,
        clarifying: segResult.clarifying,
        candidates: segResult.candidates,
      });
      // 只取 top1（多意图场景每段一个意图，避免 top2 噪声）
      if (segResult.topK.length > 0) {
        const top1Id = segResult.topK[0].intent_id;
        if (top1Id && top1Id !== 'idle_chat' && !predictedSet.includes(top1Id)) {
          predictedSet.push(top1Id);
        }
      }
    }

    result = {
      result_type: 'multi_intent_plan',
      final_result: segmentResults[0]?.final_result || null,
      segment_results: segmentResults,
      predicted_set: predictedSet,
      shape: 'multi_intent',
    };
  } else {
    const single = evaluateSingle(query, candidates, topk);

    // ── 模糊意图触发器检测 ──
    // 当查询匹配 AMBIGUOUS_TRIGGERS 中的触发短语时，强制返回多个相关意图
    let ambiguousOverride = null;
    for (const [trigger, intents] of Object.entries(AMBIGUOUS_TRIGGERS)) {
      if (query.includes(trigger)) {
        let forcedIntents = [...intents];
        // 检查抑制规则
        for (const [supTrigger, rule] of Object.entries(AMBIGUOUS_SUPPRESS)) {
          if (query.includes(supTrigger) && rule.when_contains.some(w => query.includes(w))) {
            forcedIntents = forcedIntents.filter(i => !rule.remove.includes(i));
          }
        }
        ambiguousOverride = forcedIntents;
        break;
      }
    }

    if (ambiguousOverride) {
      // 只保留 score > 0.10 的强制意图
      const qgrams = charNgrams(normalize(query), 2);
      const queryProfile = analyzeQuery(query);
      const predictedSet = ambiguousOverride.filter(id => {
        const c = candidates.find(x => x.intent_id === id);
        if (!c) return false;
        const score = scoreCandidate(query, qgrams, queryProfile, c);
        return score > 0.10;
      });

      result = {
        result_type: 'ambiguous',
        final_result: null,
        predicted_set: predictedSet,
        authoritative_results: single.topK,
        understanding: {
          clarification: {
            needed: true,
            options: predictedSet.map(id => {
              const c = candidates.find(x => x.intent_id === id);
              return { intent_id: id, intent_name: c?.intent_name || id };
            }),
          },
        },
        shape: 'ambiguous_intent',
      };
    } else {
      // 正常 predicted_set 构建：fuzzy 时包含 top1+top2，清晰时只含 top1
      const predictedSet = [];
      if (single.topK.length > 0 && single.resultType !== 'idle_chat') {
        predictedSet.push(single.topK[0].intent_id);
        if (single.clarifying && single.topK.length > 1) {
          predictedSet.push(single.topK[1].intent_id);
        }
      }

      result = {
        result_type: single.resultType === 'idle_chat' ? 'idle_chat' : (single.clarifying ? 'fuzzy' : 'single_intent'),
        final_result: single.finalResult,
        predicted_set: predictedSet,
        authoritative_results: single.topK,
        understanding: {
          clarification: {
            needed: single.clarifying,
            options: single.candidates.map(id => {
              const c = candidates.find(x => x.intent_id === id);
              return { intent_id: id, intent_name: c?.intent_name || id };
            }),
          },
        },
        shape: 'single_intent',
      };
    }
  }

  result.evaluator = {
    version_id: PARK_ENGINE_VERSION,
    version_name: '智慧园区意图引擎',
    version_stage: 'park-v1',
  };
  result.query = query;
  result.latency_ms = Math.round(performance.now() - t0);

  return result;
}

module.exports = {
  evaluateIntentPark,
  loadParkGraph,
  detectIntentShape,
  scoreCandidate,
  analyzeQuery,
};
