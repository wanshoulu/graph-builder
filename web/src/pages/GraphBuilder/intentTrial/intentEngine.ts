import type { GraphDocument, GraphNode } from '@/api/orgGraph';

/**
 * Adapted from AI Harbor intent-evaluator-v2's local recall stage.
 * This copy reads the editor's in-memory GraphDocument; it never reads or writes
 * the evaluator's published graph, semantic cache, or model configuration.
 */
export interface IntentTrialCandidate {
  id: string;
  name: string;
  domain: string;
  intentType: string;
  score: number;
  evidence: string[];
  fulfillmentKind: string;
  fulfillmentRef: string;
  fulfillmentPreview: string;
  mock: boolean;
  clarificationPrompt: string;
  handoffIssue: string;
}

export interface IntentTrialResult {
  query: string;
  status: 'matched' | 'clarify' | 'no_match';
  inferredAction: string;
  candidates: IntentTrialCandidate[];
  reason: string;
  engine: 'draft_local_recall';
  intentCount: number;
}

const ACTION_WORDS: Record<string, RegExp> = {
  CANCEL: /取消|撤销|解除|解约|关闭|停用|注销/,
  CHANGE: /修改|调整|变更|更换|设置|调高|调低/,
  QUERY: /^查|查询|查看|查一下|查查|看看|在哪(?:里)?查|怎么查|如何查|明细|记录|余额|进度/,
  ASK: /什么是|是什么|什么意思|为何|为什么|规则|介绍|了解|咨询|如何|怎么|能否|可以吗|手续费|费率|有哪些|多少|？|\?/,
  DO: /我要|我想|帮我|办理|申请|购买|买入|申购|开通|签约|转给|转账|汇款|打钱/,
};

const TARGET_FIELDS: Record<string, string> = {
  query: 'query_ref', menu: 'menu_ref', skill: 'skill_ref',
  workflow: 'workflow_ref', agent: 'agent_ref',
};

function value(input: unknown): string { return typeof input === 'string' ? input.trim() : ''; }
function list(input: unknown): string[] { return Array.isArray(input) ? input.map(value).filter(Boolean) : []; }
function normalize(input: string): string {
  return input.toLowerCase().replace(/打钱/g, '转账').replace(/汇钱/g, '汇款')
    .replace(/[\s，。！？、,.!?：:；;（）()“”"'\-_/]/g, '');
}
function grams(input: string): Set<string> {
  const text = normalize(input);
  if (text.length < 2) return new Set(text ? [text] : []);
  return new Set(Array.from({ length: text.length - 1 }, (_, index) => text.slice(index, index + 2)));
}
function dice(first: string, second: string): number {
  const left = grams(first), right = grams(second);
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  left.forEach((gram) => { if (right.has(gram)) overlap += 1; });
  return 2 * overlap / (left.size + right.size);
}
function inferAction(query: string): string {
  // The evaluator also gates action before ranking: a question about executing
  // a task must not be interpreted as authorization to execute it.
  if (/^(转账|汇款|理财|贷款|还款)$/.test(query.trim())) return '';
  for (const action of ['CANCEL', 'CHANGE', 'QUERY', 'ASK', 'DO']) {
    if (ACTION_WORDS[action].test(query)) return action;
  }
  return '';
}
function bestExpression(query: string, expressions: string[]): { score: number; expression: string; exact: boolean } {
  let best = { score: 0, expression: '', exact: false };
  const normalizedQuery = normalize(query);
  for (const expression of expressions) {
    const normalizedExpression = normalize(expression);
    if (normalizedExpression.length < 2) continue;
    const exact = normalizedQuery === normalizedExpression;
    const contained = normalizedQuery.length >= 4 && normalizedExpression.includes(normalizedQuery);
    const score = exact ? 1 : contained ? 0.83 : dice(normalizedQuery, normalizedExpression);
    if (score > best.score) best = { score, expression, exact };
  }
  return best;
}
function displayFulfillment(node: GraphNode, byId: Map<string, GraphNode>) {
  const p = node.properties;
  const kind = value(p.fulfillment_kind) || 'unconfigured';
  if (kind === 'answer') {
    const answer = byId.get(value(p.answer_ref));
    const preview = value(p.answer_text) || value(answer?.properties.answer_text);
    return { kind, ref: value(p.answer_ref), preview, mock: value(answer?.properties.content_status) === 'mock' || preview.startsWith('【演示】') };
  }
  const ref = value(p[TARGET_FIELDS[kind]]);
  return { kind, ref, preview: value(p.result_template) || value(p.standard_navigation_path), mock: /^mock:|^\/mock\//.test(ref) };
}

export function runIntentTrial(document: GraphDocument, rawQuery: string, topK = 5): IntentTrialResult {
  const query = rawQuery.trim().slice(0, 500);
  const intentNodes = document.nodes.filter((node) => node.type === 'INTENT');
  const inferredAction = inferAction(query);
  const empty = (reason: string): IntentTrialResult => ({ query, status: 'no_match', inferredAction,
    candidates: [], reason, engine: 'draft_local_recall', intentCount: intentNodes.length });
  if (!query) return empty('请输入一句真实用户问题。');
  if (!intentNodes.length) return empty('当前图谱没有可试问的叶子意图。');

  const normalizedQuery = normalize(query);
  const byId = new Map(document.nodes.map((node) => [node.id, node]));
  const ranked = intentNodes.map((node) => {
    const p = node.properties;
    const name = value(p.name) || node.id;
    const intentType = value(p.intent_type);
    const examples = [...list(p.utterance_view), ...list(p.scope_in)];
    const expression = bestExpression(query, examples);
    const nameSimilarity = dice(query, name);
    const primaryObject = value(p.tb_object_name);
    const objectTerms = [primaryObject, ...list(p.object_view)].map(normalize).filter((term) => term.length >= 2);
    const objectHit = objectTerms.filter((term) => normalizedQuery.includes(term)).sort((a, b) => b.length - a.length)[0];
    const partialObject = !objectHit && primaryObject && dice(query, primaryObject) >= 0.25;
    const negative = [...list(p.scope_out), ...list(p.negative_view)]
      .some((term) => normalize(term).length >= 3 && normalizedQuery.includes(normalize(term)));
    const evidence: string[] = [];
    let rawScore = 0;
    if (expression.exact) { rawScore += 0.56; evidence.push(`表达精确命中：${expression.expression}`); }
    else if (expression.score >= 0.36) { rawScore += expression.score * 0.39; evidence.push(`相近表达：${expression.expression}`); }
    if (nameSimilarity >= 0.27) { rawScore += nameSimilarity * 0.22; evidence.push(`意图名称相近：${name}`); }
    if (objectHit) { rawScore += Math.min(0.32, 0.16 + objectHit.length * 0.025); evidence.push(`业务对象：${objectHit}`); }
    else if (partialObject) { rawScore += 0.09; evidence.push(`业务对象部分相近：${primaryObject}`); }
    if (inferredAction) {
      if (intentType === inferredAction || (inferredAction === 'ASK' && intentType === 'HELP')) {
        rawScore += 0.27; evidence.push(`动作一致：${intentType}`);
      } else { rawScore -= 0.28; evidence.push(`动作不符：提问 ${inferredAction} / 意图 ${intentType}`); }
    }
    if (negative) { rawScore -= 0.32; evidence.push('命中排除边界'); }
    // Action alone is not evidence that this business object exists in the draft.
    if (!expression.score && nameSimilarity < 0.27 && !objectHit && !partialObject) rawScore = 0;
    const fulfillment = displayFulfillment(node, byId);
    return {
      id: node.id, name, domain: value(p.domain), intentType,
      score: Math.max(0, Math.min(100, Math.round(rawScore * 100))), evidence,
      fulfillmentKind: fulfillment.kind, fulfillmentRef: fulfillment.ref,
      fulfillmentPreview: fulfillment.preview, mock: fulfillment.mock,
      clarificationPrompt: value(p.clarification_prompt),
      handoffIssue: intentType === 'QUERY' && fulfillment.kind === 'answer'
        ? '查询意图当前交付为知识答案；如需实时数据，应改接查询能力。' : '',
    } satisfies IntentTrialCandidate;
  }).filter((candidate) => candidate.score >= 35).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  const candidates = ranked.slice(0, Math.max(1, Math.min(10, topK)));
  if (!candidates.length) return empty('没有足够的业务对象或表达证据，当前草稿不应强行命中。');
  const margin = candidates[0].score - (candidates[1]?.score || 0);
  const ambiguous = candidates[0].score < 52 || (candidates.length > 1 && margin < 9);
  return { query, status: ambiguous ? 'clarify' : 'matched', inferredAction, candidates,
    reason: ambiguous ? '候选意图接近或证据不足，建议澄清后再决定。' : '首位候选具有明确的表达、对象或动作证据。',
    engine: 'draft_local_recall', intentCount: intentNodes.length };
}
