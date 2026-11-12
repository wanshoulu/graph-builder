'use strict';

/**
 * 图谱构建工具 API — /api/graph-builder/tools/*
 *
 * 当前实现：
 *   POST /api/graph-builder/tools/node-review — 逐节点/逐边 AI 字段审核
 *
 * 前端 GraphDisplayView 直接 fetch 此端点（不走 get/post 封装），响应不包裹 {success, data}。
 */

const crypto = require('crypto');
const { callLLMJson } = require('../tools/llm-client');

function sha12(text) {
  return crypto.createHash('sha1').update(String(text), 'utf8').digest('hex').slice(0, 12);
}

function sendJSON(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function parseBody(req) {
  return new Promise(function (resolve, reject) {
    var chunks = [];
    req.on('data', function (c) { chunks.push(c); });
    req.on('end', function () {
      try {
        var raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

/**
 * 将 element.data 中的字段值格式化为 LLM 可读的文本行。
 * fieldKeys 指定要审核的字段列表；如果为空则审核 data 中所有顶层字段。
 */
function buildFieldLines(data, fieldKeys) {
  var keys = (fieldKeys && fieldKeys.length) ? fieldKeys : Object.keys(data || {}).filter(function (k) { return k !== 'raw'; });
  return keys.map(function (key) {
    var raw = data[key];
    var val;
    if (Array.isArray(raw)) {
      val = raw.join(', ');
    } else if (raw && typeof raw === 'object') {
      val = JSON.stringify(raw);
    } else {
      val = (raw === undefined || raw === null) ? '' : String(raw).trim();
    }
    return '- ' + key + '：' + (val || '（空）');
  }).join('\n');
}

/**
 * POST /api/graph-builder/tools/node-review
 *
 * Body: { element: { kind, id, data, source?, target? }, assetId, groupKey, fieldKeys }
 * Response: { items: NodeReviewItem[], generatedAt: string }
 */
async function handleNodeReview(req, res) {
  var body;
  try {
    body = await parseBody(req);
  } catch (e) {
    return sendJSON(res, 400, { error: '请求体解析失败：' + e.message });
  }

  var element = body.element || {};
  var data = element.data || {};
  var elementId = String(element.id || '');
  var kind = String(element.kind || 'node');
  var fieldKeys = Array.isArray(body.fieldKeys) ? body.fieldKeys : [];

  if (!elementId) {
    return sendJSON(res, 400, { error: 'element.id 必填' });
  }

  var fieldLines = buildFieldLines(data, fieldKeys);

  if (!fieldLines) {
    return sendJSON(res, 200, { items: [], generatedAt: new Date().toISOString() });
  }

  // 组装上下文
  var contextParts = ['当前审核元素：' + kind + ' #' + elementId];
  if (data.name) contextParts.push('名称：' + data.name);
  if (data.description) contextParts.push('描述：' + data.description);
  if (data.domain) contextParts.push('业务域：' + data.domain);
  if (element.source && element.target) contextParts.push('连线：' + element.source + ' → ' + element.target);
  var contextLine = contextParts.join(' | ');

  var systemPrompt = '你是银行业务知识图谱审核专家。你的审核目标是：确保每个图谱节点/边的字段内容能够最大化意图识别精度。'
    + '审核意见必须用业务人员能理解的通俗语言表达。'
    + '输出严格 JSON，不输出任何解释文字或 markdown 标记。';

  var prompt = [
    '请逐字段审核以下图谱' + (kind === 'edge' ? '边' : '节点') + '的字段内容质量。',
    '',
    '═══════════════════════════════════════════',
    '当前审核元素上下文',
    '═══════════════════════════════════════════',
    contextLine,
    '',
    '═══════════════════════════════════════════',
    '字段内容：',
    '═══════════════════════════════════════════',
    fieldLines,
    '',
    '═══════════════════════════════════════════',
    '审核要求',
    '═══════════════════════════════════════════',
    '1. 逐一检查每个字段的内容质量，关注以下问题类型：',
    '   - missing（缺失）：必填字段为空或仅有占位符',
    '   - incomplete（不完整）：内容过于简短或缺少关键信息',
    '   - inaccurate（不准确）：内容与银行业务常识不符或存在事实错误',
    '   - inconsistent（不一致）：字段之间互相矛盾',
    '   - style（规范）：命名不规范、用词不专业、格式不符合字段说明中的要求',
  ];

  if (kind === 'edge') {
    prompt = prompt.concat([
      '2. 【边类型语义合理性】检查边的类型与端点节点类型是否匹配：',
      '   - has_child：父→子，端点应为 DOMAIN/CATEGORY/LEAF 层级关系',
      '   - same_as：双向，端点应为同层级同语义的不同表达',
      '   - confusable_with：双向，端点应为语义相近但需区分的不同意图',
      '   - related_to：双向，端点应有关联但非层级非同义',
      '   - 若边类型与端点关系不匹配，应标记 inaccurate',
      '3. 【边方向正确性】has_child 等有向边的 source/target 是否正确（父在 source，子在 target）',
      '4. 【边标签命名规范】边的 label/properties 描述是否准确概括两端关系',
      '5. 【边语义必要性】该边是否确实需要存在（冗余边应标记 style 并建议删除）',
      '6. 只对有问题的字段给出审核意见，没有问题的字段不要输出',
      '7. issue 要简明说明问题所在',
      '8. newValue 必须是该字段修改后的完整新值，用户点击采纳后会直接替换',
      '9. newValue 不能与当前字段值相同',
      '10. 如果没有发现问题，输出：{"reviews":[]}',
    ]);
  } else {
    prompt = prompt.concat([
      '2. 【描述质量审核】description 字段必须包含四要素：',
      '   - 用户角色（谁用）+触发场景（什么时候用）+功能边界（包含/不包含什么）+产出结果（得到什么）',
      '   - 缺少功能边界应标记 incomplete（功能边界决定相邻意图区分度，直接影响语义召回精确率）',
      '   - 描述为通用模板套话应标记 incomplete',
      '3. 【别名维度覆盖审核】aliases/utterance_view 字段必须覆盖四个维度，每个维度至少1条：',
      '   - 直接说法（查X/看X/搜X）——用户最直白的表达',
      '   - 口语化变体（还有多少/剩多少/有没有）——日常口语习惯',
      '   - 场景化表达（工资到账没/退款到了没）——带具体业务场景',
      '   - 操作型表达（怎么查/在哪里看/如何办理）——引导型问句',
      '   - 若≥2个维度缺失，应标记 incomplete 并按缺失维度补充',
      '4. 只对有问题的字段给出审核意见，没有问题的字段不要输出',
      '5. issue 要简明说明问题所在',
      '6. newValue 必须是该字段修改后的完整新值，用户点击采纳后会直接替换',
      '7. newValue 不能与当前字段值相同',
      '8. 如果没有发现问题，输出：{"reviews":[]}',
    ]);
  }

  prompt = prompt.concat([
    '',
    '输出格式（严格 JSON，不要 markdown 代码块）：',
    '{"reviews":[{"field":"字段key","issueType":"missing|incomplete|inaccurate|inconsistent|style","issue":"问题描述","suggestion":"修改说明","newValue":"该字段修改后的完整新值","severity":"error|warning|info"}]}',
  ]).join('\n');

  var llmRaw;
  try {
    llmRaw = await callLLMJson(prompt, systemPrompt, { maxTokens: 12000 });
  } catch (error) {
    return sendJSON(res, 502, { error: 'AI 审核服务调用失败：' + (error.message || '未知错误') });
  }

  var cleaned = String(llmRaw || '').replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  var parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    return sendJSON(res, 502, { error: 'AI 审核结果解析失败' });
  }

  var rawReviews = Array.isArray(parsed.reviews) ? parsed.reviews : (Array.isArray(parsed) ? parsed : []);
  var now = new Date().toISOString();
  var items = [];

  rawReviews.forEach(function (rv) {
    var field = String(rv.field || '').trim();
    if (!field) return;
    var issue = String(rv.issue || rv.problem || '').trim();
    var suggestion = String(rv.suggestion || rv.suggest || '').trim();
    var newValue = String(rv.newValue || rv.new_value || rv.value || '').trim();
    if (!issue && !suggestion) return;

    // newValue 与当前值相同则丢弃
    var currentRaw = data[field];
    var currentVal;
    if (Array.isArray(currentRaw)) {
      currentVal = currentRaw.join(', ');
    } else {
      currentVal = (currentRaw === undefined || currentRaw === null) ? '' : String(currentRaw).trim();
    }
    if (newValue && newValue === currentVal) {
      newValue = '';
    }
    if (!newValue && !issue) return;

    var severity = ['error', 'warning', 'info'].includes(String(rv.severity || '').trim()) ? String(rv.severity).trim() : 'warning';
    var issueType = String(rv.issueType || rv.type || 'style').trim();

    items.push({
      id: 'nr-' + sha12(elementId + field + issueType + (newValue || issue)),
      kind: 'node-review',
      payload: {
        field: field,
        fieldLabel: field,
        issueType: issueType,
        issue: issue,
        suggestion: suggestion,
        newValue: newValue,
        severity: severity,
      },
      status: 'suggested',
    });
  });

  return sendJSON(res, 200, { items: items, generatedAt: now });
}

/**
 * 路由入口：返回 true 表示已接管请求。
 */
function handleGraphBuilderToolsRequest(req, res) {
  var method = req.method;
  var pathname = req.pathname || '';

  if (method === 'POST' && pathname === '/api/graph-builder/tools/node-review') {
    handleNodeReview(req, res);
    return true;
  }

  return false;
}

module.exports = { handleGraphBuilderToolsRequest };
