'use strict';
const fs = require('node:fs');

const ENGINE_PARAMETERS = {
  lexicalWeight: [0.1, 2], actionWeight: [0, 2], hintWeight: [0, 1], clauseWeight: [0, 1],
  negativePenalty: [0, 2], clarificationLimit: [2, 12], graphClusterFirst: 'boolean',
  // 沉淀自人工引擎优化的通用行为开关：parameter_search 可按任务探索开关组合
  actionPrefixStrip: 'boolean', colloquialSuffixNorm: 'boolean',
  wholeExpressionMatch: 'boolean', shortCoreSubstring: 'boolean',
  // 图召回通道权重：control how strongly subgraph expansion contributes to ranking
  graphWeight: [0, 1], graphSeedFloor: [0, 1], graphRowFloor: [0, 0.8],
  graphConfusableWeight: [0, 1], graphObjectWeight: [0, 1], graphActionWeight: [0, 1], graphSiblingWeight: [0, 1],
};
function normalizeProfile(raw = {}) {
  const prompts = {}, engine = {};
  for (const [key, text] of Object.entries(raw.prompts || {})) {
    if (!['judge', 'shape', 'boundary'].includes(key) || typeof text !== 'string' || text.length > 12000) throw new Error('识别指令组件或长度不合法');
    prompts[key] = text;
  }
  for (const [key, val] of Object.entries(raw.engine || {})) {
    const bounds = ENGINE_PARAMETERS[key];
    if (!bounds || (bounds === 'boolean' ? typeof val !== 'boolean' : !Number.isFinite(val) || val < bounds[0] || val > bounds[1])) throw new Error(`引擎参数不合法：${key}`);
    if (key === 'clarificationLimit' && !Number.isInteger(val)) throw new Error('澄清候选数量必须是整数');
    engine[key] = val;
  }
  const optimizerPrompt = raw.optimizerPrompt || '';
  if (typeof optimizerPrompt !== 'string' || optimizerPrompt.length > 16000) throw new Error('优化器指令不合法');
  return { prompts, engine, optimizerPrompt };
}
function loadRuntimeProfile(graphPath) {
  if (!graphPath) return normalizeProfile();
  const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
  return normalizeProfile(graph.meta?.rsi_runtime || {});
}
function runtimeParameter(profile, name, fallback) { return profile.engine[name] ?? fallback; }
/** 读取布尔行为开关，默认 true（保留已验证有效的行为） */
function runtimeFlag(profile, name) { return profile?.engine?.[name] ?? true; }
function runtimeInstruction(profile, component) { return profile.prompts[component] || ''; }
// Shared complete utterances are the executable contract of A6. Compare the
// whole expression, never a substring: a specific request must not inherit the
// ambiguity of a broad phrase that happens to share its business noun.
function declaredAmbiguityCandidates(query, candidates, limit = 12, profile = null) {
  const useWhole = runtimeFlag(profile, 'wholeExpressionMatch');
  const normalize = value => String(value || '').trim().replace(/[，。！？!?\s]+$/g, '')
    .replace(/^(?:帮我|麻烦|请|我要|我想|给我)+/, '')
    .replace(/^(?:查询|查看|查|看看|看)(?:一下|下)/, '$1');
  const q = normalize(query);
  // 守卫拦的是无业务内容的口癖句（如「查一下」归一后只剩动词，长度<2）。
  // A6 是整句全等契约：图谱显式声明共享说法（如「办卡」）本身即模糊信号，
  // 不能再用「剥掉动词后的残留长度」拦截——那会把合法双字业务词误杀（rsi_t216）。
  if (q.length < 2) return [];
  const seen = new Set();
  const matches = candidates.filter(c => {
    if (!c.intent_id || seen.has(c.intent_id)) return false;
    const sd = c.node?.semantic_definition || {};
    if ((sd.scope_out || []).some(s => normalize(s) === q)) return false;
    const hit = useWhole
      ? (c.node?.retrieval_profile?.utterance_view || []).some(s => normalize(s) === q)
      : (c.node?.retrieval_profile?.utterance_view || []).some(s => normalize(s).includes(q) || q.includes(normalize(s)));
    if (hit) seen.add(c.intent_id);
    return hit;
  });
  if (matches.length < 2) return [];
  return matches.slice(0, limit).map(c => ({ label: c.intent_name || c.eval_label, display_label: c.intent_name || c.eval_label,
    intent_id: c.intent_id, value: c.intent_id, intent_name: c.intent_name, action_code: c.action_code,
    source: 'graph.shared_utterance' }));
}
function graphClarificationCandidates(query, candidates, limit = 6, profile = null) {
  const useActionStrip = runtimeFlag(profile, 'actionPrefixStrip');
  const useSuffixNorm = runtimeFlag(profile, 'colloquialSuffixNorm');
  const useShortCore = runtimeFlag(profile, 'shortCoreSubstring');
  let core = String(query || '').replace(/^(帮我|我想|我要|请|麻烦|给我)+/, '')
    .replace(/怎么弄|的事|查询|查看|看看|办理|修改|设置|开通|关闭|取消|查下|查|看|办|改|开|关|一下|的|我的|怎么|如何/g, '').trim();
  // 口语后缀：「工资单」→「单子」是同一业务词的口语形，剥掉「子」再匹配；
  // 剥完剩单字（单/协议这类业务字）时用「X单/X子」双形态匹配，不因单字放弃召回。
  let cores = [core];
  if (useSuffixNorm && /子$/.test(core)) cores.unshift(core.replace(/子$/, ''));
  // 指示词（这个/那个/哪一个）是用户显式表达模糊的信号，不是放弃召回的理由：
  // 「查绿色那个」剥掉「那个」后剩「绿色」，仍可对图谱声明词做子串召回（rsi_t217）。
  core = core.replace(/这个|那个|哪一个/g, '').trim();
  cores = cores.map(c => c.replace(/这个|那个|哪一个/g, '').trim()).filter(Boolean);
  if (core.length < 2) return [];
  const action = /修改|设置|改/.test(query) ? ['change'] : /查询|查看|查|看看/.test(query) ? ['query', 'ask'] : [];
  // 词形扩展：泛化说法（查单子/查协议）与意图声明（查工资单详情/查询我的协议）之间存在
  // 子词关系——精短语剥掉「我的」等修饰成分后，命中某意图 scope_in 词的**内部连续子串**即算同簇。
  // 要求连续子串（如「单」⊂「工资单」，「协议」⊂「我的协议」）而不是单字，控制误召。
  // action_code 缺失的意图（RSI 子图常见）不应因「查」字被整簇过滤——只过滤 action 已知且不匹配的。
  const actionOk = c => !action.length || c.action_code == null || action.includes(c.action_code);
  const hitText = (c) => {
    const sd = c.node?.semantic_definition || {};
    const words = [...(sd.scope_in || []), c.intent_name || '', c.eval_label || '', c.object || ''].filter(Boolean);
    // 意图自己声明了「这类说法不归我管」（scope_out 命中坏例核心词）→ 不入簇。
    // 这是 A2 边界声明在澄清簇上的消费点：声明有出口，搜索才会用它收敛选项。
    const outs = sd.scope_out || [];
    // scope_out 语义是「这个说法不归我」：只有当声明项**剥掉动作前缀后等于核心词**才排除
    //（查单子→单子 ✓），「云网点」≠「网点」这种名词复合词不排除——否则会把
    //「查询网点详情」这类期望意图误伤出簇（rsi_t205 实测教训）。
    const stripAction = o => useActionStrip ? o.replace(/^(帮我|请|麻烦|我要|我想|查一下|查下|查|办一下|办|办理)/, '') : o;
    const excluded = cores.some(cc => outs.some(o => o && stripAction(o) === cc));
    if (excluded) return false;
    return cores.some(cc => words.some(w => w.includes(cc)));
  };
  const matches = candidates.filter(c => hitText(c) && actionOk(c));
  if (useShortCore && matches.length < 2 && core.length <= 3) {
    // 短核心词的子串召回：core 出现在 scope_in/intent_name 词的任意位置即入簇。
    // 词表来自意图自身的声明（不是全文），误召风险可控；簇仍受 limit 截断。
    const seen = new Set(matches.map(c => c.intent_id));
    for (const c of candidates) {
      if (seen.has(c.intent_id)) continue;
      if (hitText(c) && actionOk(c)) { matches.push(c); seen.add(c.intent_id); }
    }
  }
  return matches.slice(0, limit).map(c => ({ label: c.intent_name || c.eval_label, display_label: c.intent_name || c.eval_label,
    value: c.intent_id, intent_id: c.intent_id, intent_name: c.intent_name, action_code: c.action_code, rank: 900 }));
}

// A5 supplies wording, never the decision to interrupt. Only questions already
// selected by production ambiguity checks can consume a declaration, and only
// from candidates represented by that question (or its selected slot intent).
function consumeGraphClarificationQuestions(questions, finalResult, candidates = []) {
  return (questions || []).map(question => {
    if (!['generic_ambiguous_intent', 'non_leaf_intent', 'llm_slot_clarification'].includes(question.type)) return question;
    const options = question.options || [];
    const active = new Set(options.map(o => o.intent_id || o.value).filter(Boolean));
    if (!active.size && finalResult?.intent_id) active.add(finalResult.intent_id);
    const relevant = candidates.filter(c => active.has(c.intent_id));
    const terms = relevant.flatMap(c => [c.object, c.intent_name, c.eval_label,
      ...(c.node?.semantic_definition?.scope_in || [])]).filter(t => typeof t === 'string' && t.trim().length >= 2);
    const declared = relevant.flatMap(c => (c.node?.decision_policy?.clarify_questions || [])
      .filter(text => typeof text === 'string' && text.length <= 500)
      .map(text => ({ text: text.trim(), candidate: c })));
    const chosen = declared.find(({ text }) => /[?？]|哪|是否|还是|多少|什么|如何|请.*(?:提供|确认|选择)/.test(text)
      && terms.some(t => text.includes(t))
      && !candidates.some(c => c.intent_id?.length >= 5 && text.includes(c.intent_id)));
    if (chosen) return { ...question, question: chosen.text,
      source: 'graph.decision_policy.clarify_questions', source_intent_id: chosen.candidate.intent_id };
    if (options.length >= 2 && question.type === 'generic_ambiguous_intent') {
      const labels = [...new Set(options.map(o => o.display_label || o.label || o.intent_name).filter(Boolean))];
      if (labels.length >= 2) return { ...question, question: `您想办理哪一项：${labels.join('、')}？`, source: 'candidate_options' };
    }
    return question;
  });
}
module.exports = { ENGINE_PARAMETERS, normalizeProfile, loadRuntimeProfile, runtimeParameter, runtimeFlag, runtimeInstruction, declaredAmbiguityCandidates, graphClarificationCandidates, consumeGraphClarificationQuestions };
