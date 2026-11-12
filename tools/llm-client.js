'use strict';

/**
 * 共享 LLM 客户端 — deepseek-chat 优先 → qwen-plus 回退
 *
 * 统一供 org-graph.js / graph-builder-tools.js / intent-graph-autobuild.js 使用，
 * 消除三处重复的 getLLMRoute + callLLMJson 实现。
 */

var https = require('https');
var API_ROUTES = require('../config/api-keys').API_ROUTES;

function getLLMRoute() {
  var route = API_ROUTES['deepseek-chat'];
  var model = 'deepseek-chat';
  if (!route || !route.getKey()) { route = API_ROUTES['qwen-plus']; model = 'qwen-plus'; }
  if (!route || !route.getKey()) return null;
  return { host: String(route.host).replace(/^https?:\/\//, ''), path: route.path, apiKey: route.getKey(), model: model };
}

/**
 * LLM 单轮 JSON 生成
 * @param {string} prompt 用户提示词
 * @param {string} [system] 系统提示词（可选，各调用方可定制默认值）
 * @param {object} [opts] { maxTokens: number } 可覆盖默认 8192
 * @returns {Promise<string>} LLM 返回的文本内容
 */
function callLLMJson(prompt, system, opts) {
  var route = getLLMRoute();
  if (!route) {
    return Promise.reject(Object.assign(
      new Error('未配置 LLM API Key'),
      { code: 'LLM_UNAVAILABLE', statusCode: 503 }
    ));
  }
  var maxTokens = (opts && opts.maxTokens) || 8192;
  var systemPrompt = system || '你是图谱建模专家，输出严格 JSON，不输出任何解释。';
  return new Promise(function(resolve, reject) {
    var body = JSON.stringify({
      model: route.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
      max_tokens: maxTokens,
    });
    var req = https.request({
      hostname: route.host,
      port: 443,
      path: route.path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + route.apiKey,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 180000,
    }, function(res) {
      var data = '';
      res.on('data', function(c) { data += c; });
      res.on('end', function() {
        if (res.statusCode !== 200) {
          reject(new Error('LLM 返回 ' + res.statusCode + ': ' + data.slice(0, 200)));
        } else {
          try {
            var json = JSON.parse(data);
            resolve(json.choices[0].message.content || '');
          } catch (e) { reject(e); }
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', function() { req.destroy(); reject(new Error('LLM 超时')); });
    req.write(body);
    req.end();
  });
}

module.exports = { getLLMRoute, callLLMJson };
