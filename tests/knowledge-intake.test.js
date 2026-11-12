/**
 * 知识导入与审核工作台 单测
 * - validateSheets：模板契约校验（错误行不入候选层、歧义 warning）
 * - applyToIntakeDocument：入图合并（同名复用/标问优先/幂等）
 * - handleKnowledgeIntakeRequest：multipart 导入 → 候选层 → 审核 → 删除
 * 用法: node --test tests/knowledge-intake.test.js
 */
'use strict';

process.env.SKIP_AUTH = 'true';
process.env.KNOWLEDGE_INTAKE_DIR = require('node:fs').mkdtempSync(
  require('node:path').join(require('node:os').tmpdir(), 'knowledge-intake-test-')
);

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const XLSX = require('xlsx');
const {
  handleKnowledgeIntakeRequest,
  validateSheets,
  validateRow,
  applyToIntakeDocument,
} = require('../routes/knowledge-intake');

// ── 契约校验（纯函数） ───────────────────────────────────────────────────────

function validRaw() {
  return {
    functions: [
      { rowNumber: 2, path: '财富管理', name: '财富管理', description: '面向个人客户的财富管理业务域，含账户、持仓与交易服务', clientClass: '个人客户', securityLevel: 'L2-内部', department: '财富管理部', status: '启用', note: '' },
      { rowNumber: 3, path: '财富管理/账户查询', name: '账户查询', description: '查询本人账户余额、明细与持仓的服务', clientClass: '个人客户', securityLevel: 'L2-内部', department: '财富管理部', status: '启用', note: '' },
    ],
    intents: [
      { rowNumber: 2, name: '查询账户余额', funcPath: '财富管理/账户查询', intentType: '查询', description: '客户询问余额时的查询意图，返回实时余额卡片，明细查询见查询交易明细', businessObjects: '账户', keySlots: '账户', answerForm: '数据卡片', heat: 'P0-高频', status: '生效', code: '', note: '' },
    ],
    utterances: [
      { rowNumber: 2, intentRef: '财富管理/账户查询/查询账户余额', kind: '标问', text: '查询账户余额', source: '人工编写', confidence: '', status: '已审核', reviewNote: '', note: '' },
      { rowNumber: 3, intentRef: '财富管理/账户查询/查询账户余额', kind: '扩展问', text: '我卡里还有多少钱', source: '客服挖掘', confidence: 0.9, status: '候选', reviewNote: '', note: '' },
    ],
  };
}

test('validateSheets：合法数据全部通过；Excel 已审核只是业务侧状态，一律进待确认（两段式）', () => {
  const outcome = validateSheets(validRaw());
  assert.equal(outcome.rejected.length, 0, JSON.stringify(outcome.rejected));
  assert.equal(outcome.sheets.functions.length, 2);
  assert.equal(outcome.sheets.intents.length, 1);
  assert.equal(outcome.sheets.utterances.length, 2);
  // 两段式：Excel「已审核/生效/启用」≠ 平台确认，统一 pending，原值留 sourceStatus 供排前复核
  assert.equal(outcome.sheets.utterances[0].status, 'pending');
  assert.equal(outcome.sheets.utterances[0].sourceStatus, '已审核');
  assert.equal(outcome.sheets.intents[0].status, 'pending');
  assert.equal(outcome.sheets.intents[0].sourceStatus, '生效');
  assert.equal(outcome.sheets.functions[0].status, 'pending');
  assert.equal(outcome.sheets.functions[1].sourceStatus, '启用');
  assert.equal(outcome.sheets.utterances[1].status, 'pending');
  assert.equal(outcome.routed.functions.pending, 2);
  assert.equal(outcome.routed.functions.approved, 0);
});

test('validateSheets：功能路径缺上级、重复、超深、末段不一致被拒', () => {
  const raw = validRaw();
  raw.functions.push(
    { rowNumber: 4, path: '贷款/用款还款', name: '用款还款', description: '贷款用款与还款办理服务域', clientClass: '个人客户', securityLevel: 'L2-内部', department: '信贷部', status: '启用', note: '' },
    { rowNumber: 5, path: '财富管理', name: '重复域', description: '与已有功能路径重复的行', clientClass: '个人客户', securityLevel: 'L2-内部', department: '财富管理部', status: '启用', note: '' },
    { rowNumber: 6, path: 'A/B/C/D/E', name: 'E', description: '超过四段的深层路径', clientClass: '个人客户', securityLevel: 'L2-内部', department: '财富管理部', status: '启用', note: '' },
  );
  const outcome = validateSheets(raw);
  const byRow = Object.fromEntries(outcome.rejected.map((r) => [r.rowNumber, r.errors.join('|')]));
  assert.match(byRow[4] || '', /上级功能路径未登记/);
  assert.match(byRow[5] || '', /功能路径重复/);
  assert.match(byRow[6] || '', /超过 4 段/);
  assert.equal(outcome.sheets.functions.length, 2);
});

test('validateSheets：意图标识未登记、同意图重复说法、驳回无意见被拒', () => {
  const raw = validRaw();
  raw.utterances.push(
    { rowNumber: 4, intentRef: '财富管理/账户查询/不存在的意图', kind: '扩展问', text: '查余额', source: '人工编写', confidence: '', status: '候选', reviewNote: '', note: '' },
    { rowNumber: 5, intentRef: '财富管理/账户查询/查询账户余额', kind: '扩展问', text: '我卡里还有多少钱', source: '人工编写', confidence: '', status: '候选', reviewNote: '', note: '' },
    { rowNumber: 6, intentRef: '财富管理/账户查询/查询账户余额', kind: '扩展问', text: '余额多少', source: '人工编写', confidence: '', status: '驳回', reviewNote: '', note: '' },
  );
  const outcome = validateSheets(raw);
  const byRow = Object.fromEntries(outcome.rejected.map((r) => [r.rowNumber, r.errors.join('|')]));
  assert.match(byRow[4] || '', /意图标识未登记/);
  assert.match(byRow[5] || '', /说法文本重复/);
  assert.match(byRow[6] || '', /驳回必须填写审核意见/);
  assert.equal(outcome.sheets.utterances.length, 2);
});

test('validateSheets：跨意图重复说法给 warning 不拒绝；无标问给 warning', () => {
  const raw = validRaw();
  raw.intents.push(
    { rowNumber: 3, name: '查询交易明细', funcPath: '财富管理/账户查询', intentType: '查询', description: '查询本人账户历史交易明细的意图，返回流水列表', businessObjects: '账户', keySlots: '账户,时间段', answerForm: '数据卡片', heat: 'P0-高频', status: '生效', code: '', note: '' },
  );
  raw.utterances.push(
    { rowNumber: 4, intentRef: '财富管理/账户查询/查询账户余额', kind: '扩展问', text: '看看流水', source: '人工编写', confidence: '', status: '候选', reviewNote: '', note: '' },
    { rowNumber: 5, intentRef: '财富管理/账户查询/查询交易明细', kind: '标问', text: '看看流水', source: '人工编写', confidence: '', status: '候选', reviewNote: '', note: '' },
    { rowNumber: 6, intentRef: '财富管理/账户查询/查询交易明细', kind: '扩展问', text: '最近交易记录', source: '人工编写', confidence: '', status: '候选', reviewNote: '', note: '' },
  );
  const outcome = validateSheets(raw);
  assert.equal(outcome.rejected.length, 0, JSON.stringify(outcome.rejected));
  assert.ok(outcome.warnings.some((w) => /多个意图/.test(w.message)), JSON.stringify(outcome.warnings));
});

// ── 入图合并（纯函数） ───────────────────────────────────────────────────────

function graphDoc() {
  return {
    nodes: [
      { id: 'agg:root:wealth', type: 'AGGREGATE_INTENT', properties: { name: '财富管理', domain: '财富管理' }, provenance: { source: 'starter' } },
      { id: 'intent:existing-balance', type: 'INTENT', properties: { name: '查询账户余额', intent_type: 'QUERY', utterance_view: ['查询账户余额', '余额是多少'] }, provenance: { source: 'starter' } },
    ],
    edges: [
      { id: 'edge:existing-1', type: 'has_leaf_intent', source: 'agg:root:wealth', target: 'intent:existing-balance', properties: {}, provenance: { source: 'starter' } },
    ],
  };
}

function approvedSet() {
  return {
    functions: [
      { rowId: 'f-1', path: '财富管理/账户查询', name: '账户查询', description: '查询本人账户余额、明细与持仓的服务' },
    ],
    intents: [
      { rowId: 'i-1', ref: '财富管理/账户查询/查询账户余额', name: '查询账户余额', funcPath: '财富管理/账户查询', intentType: '查询', description: '客户询问余额时的查询意图' },
      { rowId: 'i-2', ref: '财富管理/账户查询/办理定期存款', name: '办理定期存款', funcPath: '财富管理/账户查询', intentType: '办理', description: '客户办理整存整取定期存款的意图' },
    ],
    utterances: [
      { rowId: 'u-1', intentRef: '财富管理/账户查询/查询账户余额', kind: '扩展问', text: '我卡里还有多少钱' },
      { rowId: 'u-2', intentRef: '财富管理/账户查询/查询账户余额', kind: '扩展问', text: '余额是多少' },
      { rowId: 'u-3', intentRef: '财富管理/账户查询/办理定期存款', kind: '标问', text: '办理定期存款' },
      { rowId: 'u-4', intentRef: '财富管理/账户查询/办理定期存款', kind: '扩展问', text: '存一笔定期' },
    ],
  };
}

test('applyToIntakeDocument：复用同名聚合与意图、新建链与说法、标问优先', () => {
  const first = applyToIntakeDocument(graphDoc(), approvedSet(), 'ki-test-1', '2026-09-18T00:00:00Z');
  const stats = first.stats;
  assert.equal(stats.aggregatesCreated, 1, '只新建 账户查询 聚合');
  assert.equal(stats.aggregatesReused, 1, '复用 财富管理 聚合');
  assert.equal(stats.intentsReused, 1);
  assert.equal(stats.intentsCreated, 1);

  const doc = first.document;
  const deposit = doc.nodes.find((n) => n.properties.name === '办理定期存款');
  assert.ok(deposit, '新意图已创建');
  assert.equal(deposit.intent_type !== undefined ? deposit.intent_type : deposit.properties.intent_type, 'DO');
  assert.equal(deposit.provenance.source, 'knowledge-intake');
  assert.equal(deposit.provenance.sourceBatch, 'ki-test-1');
  assert.equal(deposit.properties.utterance_view[0], '办理定期存款', '标问排第一');
  assert.ok(deposit.properties.utterance_view.includes('存一笔定期'));

  // 新建 is_child_of：账户查询 → 财富管理；has_leaf_intent：账户查询 → 办理定期存款
  const childAgg = doc.nodes.find((n) => n.type === 'AGGREGATE_INTENT' && n.properties.name === '账户查询');
  assert.ok(doc.edges.some((e) => e.type === 'is_child_of' && e.source === childAgg.id && e.target === 'agg:root:wealth'));
  assert.ok(doc.edges.some((e) => e.type === 'has_leaf_intent' && e.target === deposit.id));

  // 已有意图仅并说法且去重（余额是多少 已存在，只加 我卡里还有多少钱）
  const balance = doc.nodes.find((n) => n.id === 'intent:existing-balance');
  assert.deepEqual(balance.properties.utterance_view, ['查询账户余额', '余额是多少', '我卡里还有多少钱']);
});

test('applyToIntakeDocument：重复 apply 幂等，不产生重复节点/边/说法', () => {
  const once = applyToIntakeDocument(graphDoc(), approvedSet(), 'ki-test-2', '2026-09-18T00:00:00Z');
  const twice = applyToIntakeDocument(once.document, approvedSet(), 'ki-test-2', '2026-09-18T01:00:00Z');
  assert.equal(twice.stats.aggregatesCreated, 0);
  assert.equal(twice.stats.intentsCreated, 0);
  assert.equal(twice.stats.utterancesAdded, 0);
  assert.equal(twice.stats.edgesCreated, 0);
  assert.equal(twice.document.nodes.length, once.document.nodes.length);
  assert.equal(twice.document.edges.length, once.document.edges.length);
});

// ── 入图 schema 对齐（fulfillment/tb_object_name/goal/易混意图/聚合 scope） ──

test('applyToIntakeDocument：答案形态→fulfillment_kind 四枚举全映射，未知回落 unconfigured', () => {
  const cases = { 话术答复: 'answer', 数据卡片: 'query', 跳转办理: 'menu', 转人工: 'agent' };
  for (const [answerForm, expected] of Object.entries(cases)) {
    const approved = approvedSet();
    approved.intents = [approved.intents[1]];
    approved.intents[0] = { ...approved.intents[0], answerForm };
    approved.utterances = approved.utterances.filter((u) => u.intentRef === approved.intents[0].ref);
    const { document } = applyToIntakeDocument(graphDoc(), approved, 'ki-test-fulfill', '2026-09-20T00:00:00Z');
    const deposit = document.nodes.find((n) => n.properties.name === '办理定期存款');
    assert.equal(deposit.properties.fulfillment_kind, expected, answerForm);
  }
  const approved = approvedSet();
  approved.intents = [approved.intents[1]];
  approved.intents[0] = { ...approved.intents[0], answerForm: '' };
  approved.utterances = approved.utterances.filter((u) => u.intentRef === approved.intents[0].ref);
  const { document } = applyToIntakeDocument(graphDoc(), approved, 'ki-test-fulfill', '2026-09-20T00:00:00Z');
  const deposit = document.nodes.find((n) => n.properties.name === '办理定期存款');
  assert.equal(deposit.properties.fulfillment_kind, 'unconfigured');
});

test('applyToIntakeDocument：tb_object_name 取业务对象首项，goal 优先用户目标列、缺省回落业务描述', () => {
  const approved = approvedSet();
  approved.intents[1] = { ...approved.intents[1], goal: '把一笔钱存成定期获利', businessObjects: '定期存单;账户' };
  const { document } = applyToIntakeDocument(graphDoc(), approved, 'ki-test-goal', '2026-09-20T00:00:00Z');
  const deposit = document.nodes.find((n) => n.properties.name === '办理定期存款');
  assert.equal(deposit.properties.tb_object_name, '定期存单');
  assert.equal(deposit.properties.goal, '把一笔钱存成定期获利');
  assert.equal(deposit.properties.description, '客户办理整存整取定期存款的意图');

  const approved2 = approvedSet();
  const { document: doc2 } = applyToIntakeDocument(graphDoc(), approved2, 'ki-test-goal2', '2026-09-20T00:00:00Z');
  const deposit2 = doc2.nodes.find((n) => n.properties.name === '办理定期存款');
  assert.equal(deposit2.properties.goal, '客户办理整存整取定期存款的意图', '无用户目标列时回落业务描述');
});

test('applyToIntakeDocument：易混意图按名称解析入图，未知名丢弃并计数，不把自身算易混', () => {
  const approved = approvedSet();
  approved.intents[1] = { ...approved.intents[1], confusableIntents: '查询账户余额;不存在的意图;办理定期存款' };
  const { document, stats } = applyToIntakeDocument(graphDoc(), approved, 'ki-test-confusable', '2026-09-20T00:00:00Z');
  const deposit = document.nodes.find((n) => n.properties.name === '办理定期存款');
  assert.deepEqual(deposit.properties.confusable_intents, ['查询账户余额']);
  assert.deepEqual(stats.confusableUnresolved, ['不存在的意图']);

  // 图里既有意图名也可解析（graphDoc 的 starter 意图与批次意图同名，这里验证跨源解析）
  const approved2 = approvedSet();
  approved2.intents[1] = { ...approved2.intents[1], confusableIntents: ' 查询账户余额 ； 另一个意图 ' };
  const { document: doc2, stats: stats2 } = applyToIntakeDocument(graphDoc(), approved2, 'ki-test-confusable2', '2026-09-20T00:00:00Z');
  const deposit2 = doc2.nodes.find((n) => n.properties.name === '办理定期存款');
  assert.deepEqual(deposit2.properties.confusable_intents, ['查询账户余额'], '中英文分号与首尾空白都能切干净');
  assert.deepEqual(stats2.confusableUnresolved, ['另一个意图']);
});

test('applyToIntakeDocument：聚合意图 scope 逐级并集，复用节点不写保证幂等', () => {
  const approved = approvedSet();
  approved.intents[0] = { ...approved.intents[0], scopeIn: '本人实时余额', scopeOut: '他行卡余额' }; // 复用意图：scope 不并入聚合
  approved.intents[1] = { ...approved.intents[1], scopeIn: '整存整取;定期本金', scopeOut: '他行卡余额;零存整取' };
  approved.intents.push({ rowId: 'i-3', ref: '财富管理/账户查询/办理通知存款', name: '办理通知存款', funcPath: '财富管理/账户查询', intentType: '办理', description: '客户办理通知存款业务的意图', scopeIn: '通知存款' });
  const first = applyToIntakeDocument(graphDoc(), approved, 'ki-test-scope', '2026-09-20T00:00:00Z');
  const agg = first.document.nodes.find((n) => n.type === 'AGGREGATE_INTENT' && n.properties.name === '账户查询');
  assert.deepEqual(agg.properties.scope_in.slice().sort(), ['定期本金', '整存整取', '通知存款'], '只并新建意图的 scope');
  assert.ok(!agg.properties.scope_in.includes('本人实时余额'), '复用意图的 scope 不并入（不覆盖既有数据口径）');
  assert.deepEqual(agg.properties.scope_out.slice().sort(), ['他行卡余额', '零存整取'], '子意图并集去重');
  // 父链上的 财富管理 聚合是复用节点（starter），scope 不被覆盖
  const root = first.document.nodes.find((n) => n.id === 'agg:root:wealth');
  assert.deepEqual(root.properties.scope_in, undefined);

  // 重复应用：意图全部走复用分支，scope 不再追加
  const twice = applyToIntakeDocument(first.document, approved, 'ki-test-scope', '2026-09-20T01:00:00Z');
  const agg2 = twice.document.nodes.find((n) => n.properties.name === '账户查询');
  assert.equal(agg2.properties.scope_in.length, 3);
  assert.equal(agg2.properties.scope_out.length, 2);
});

test('validateSheets：易混意图未在本批次登记给 warning 不拒绝；新列 goal/confusableIntents 进候选层', () => {
  const raw = validRaw();
  raw.intents[0] = { ...raw.intents[0], goal: '确认本人账户实时余额', confusableIntents: '查询交易明细;不存在的意图' };
  raw.intents.push(
    { rowNumber: 3, name: '查询交易明细', funcPath: '财富管理/账户查询', intentType: '查询', description: '查询本人账户历史交易明细的意图，返回流水列表', businessObjects: '账户', keySlots: '账户,时间段', answerForm: '数据卡片', heat: 'P0-高频', status: '生效', code: '', note: '' },
  );
  const outcome = validateSheets(raw);
  assert.equal(outcome.rejected.length, 0, JSON.stringify(outcome.rejected));
  assert.ok(outcome.warnings.some((w) => /易混意图「不存在的意图」未在本批次登记/.test(w.message)), JSON.stringify(outcome.warnings));
  assert.ok(!outcome.warnings.some((w) => /易混意图「查询交易明细」/.test(w.message)), '已登记的易混意图不告警');
  assert.equal(outcome.sheets.intents[0].goal, '确认本人账户实时余额');
  assert.equal(outcome.sheets.intents[0].confusableIntents, '查询交易明细;不存在的意图');
});

// ── HTTP：multipart 导入 → 候选层 → 审核 → 删除 ─────────────────────────────

function mockReq(method, url, body, contentType) {
  const payload = body === undefined ? null : (Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), 'utf8'));
  return {
    method,
    url,
    pathname: url.split('?')[0],
    headers: Object.assign(
      { host: 'localhost' },
      contentType ? { 'content-type': contentType } : {},
      payload ? { 'content-length': String(payload.length) } : {}
    ),
    pause() {},
    resume() {},
    on(event, callback) {
      if (event === 'data') {
        if (payload) process.nextTick(() => callback(payload));
        return this;
      }
      if (event === 'end') { process.nextTick(callback); return this; }
      return this;
    },
  };
}

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    writeHead(code) { this.statusCode = code; },
    end(data) { this.body = data; },
  };
}

function call(method, pathname, body, contentType) {
  const res = mockRes();
  const handled = handleKnowledgeIntakeRequest(mockReq(method, pathname, body, contentType), res);
  assert.equal(handled, true, '路由应被 knowledge-intake 处理: ' + method + ' ' + pathname);
  return new Promise((resolve) => {
    setTimeout(() => {
      let parsed = null;
      try { parsed = JSON.parse(res.body || '{}'); } catch (e) { parsed = { raw: res.body }; }
      resolve({ statusCode: res.statusCode, body: parsed });
    }, 80);
  });
}

function buildWorkbookBuffer() {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['功能全路径', '功能名称', '业务描述', '客户分类', '安全分级', '责任部门', '状态', '备注'],
    ['财富管理', '财富管理', '面向个人客户的财富管理业务域，含账户、持仓与交易服务', '个人客户', 'L2-内部', '财富管理部', '启用', ''],
    ['财富管理/账户查询', '账户查询', '查询本人账户余额、明细与持仓的服务', '个人客户', 'L2-内部', '财富管理部', '启用', ''],
  ]), '1-业务功能分类');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['意图名称', '所属功能全路径', '业务意图类型', '业务描述', '涉及业务对象', '关键要素', '答案形态', '热度', '状态', '意图编码（选填）', '备注'],
    ['查询账户余额', '财富管理/账户查询', '查询', '客户询问余额时的查询意图，返回实时余额卡片', '账户', '账户', '数据卡片', 'P0-高频', '生效', '', ''],
    ['余额错误申诉', '财富管理/不存在的功能', '查询', '客户对余额展示有异议时的申诉意图', '账户', '', '转人工', 'P2-低频', '草稿', '', ''],
  ]), '2-意图清单');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['意图标识', '说法类型', '说法文本', '来源', '置信度', '状态', '审核意见', '备注'],
    ['财富管理/账户查询/查询账户余额', '标问', '查询账户余额', '人工编写', '', '已审核', '', ''],
    ['财富管理/账户查询/查询账户余额', '扩展问', '我卡里还有多少钱', '客服挖掘', 0.88, '候选', '', '月频次 142'],
    ['财富管理/账户查询/不存在的意图', '扩展问', '孤儿说法', '人工编写', '', '候选', '', ''],
  ]), '3-说法库');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function multipartBody(buffer) {
  const boundary = '----kitest' + Date.now();
  const head = Buffer.from(
    '--' + boundary + '\r\n' +
    'Content-Disposition: form-data; name="file"; filename="test-import.xlsx"\r\n' +
    'Content-Type: application/octet-stream\r\n\r\n',
    'utf8'
  );
  const tail = Buffer.from('\r\n--' + boundary + '--\r\n', 'utf8');
  return { body: Buffer.concat([head, buffer, tail]), contentType: 'multipart/form-data; boundary=' + boundary };
}

test('import：合法行入候选层（全部待确认）、错误行随响应报告不入库', async () => {
  const mp = multipartBody(buildWorkbookBuffer());
  const result = await call('POST', '/api/knowledge-intake/import', mp.body, mp.contentType);
  assert.equal(result.statusCode, 200, resText(result));
  assert.equal(result.body.success, true);
  const data = result.body.data;
  assert.match(data.batchId, /^ki-\d{8}-[0-9a-f]{8}$/);
  // 两段式：Excel 的 启用/生效/已审核 全部落「待确认」，平台人工确认后才算 approved
  assert.equal(data.routed.functions.pending, 2);
  assert.equal(data.routed.functions.approved, 0);
  assert.equal(data.routed.intents.pending, 1, '生效意图 → 待确认');
  assert.equal(data.routed.intents.approved, 0);
  assert.equal(data.rejected.length, 2, '意图（上级未登记）与说法（标识未登记）各拒一行');
  assert.ok(data.rejected.every((r) => r.errors.length));
  globalThis.__kitBatchId = data.batchId;
});

test('items：按 kind/status 过滤候选层条目', async () => {
  const batchId = globalThis.__kitBatchId;
  const utterPending = await call('GET', '/api/knowledge-intake/batches/' + batchId + '/items?kind=utterances&status=pending');
  assert.equal(utterPending.statusCode, 200, resText(utterPending));
  assert.equal(utterPending.body.data.total, 2, 'Excel 已审核标问 + 候选扩展问都在待确认队列');
  assert.equal(utterPending.body.data.items[0].sourceStatus, '已审核');

  const all = await call('GET', '/api/knowledge-intake/batches/' + batchId + '/items');
  assert.equal(all.body.data.total, 5, '2 功能 + 1 意图 + 2 说法');
});

test('tree：业务域→子域→意图骨架树，说法折叠计数，孤儿单独报告', async () => {
  const batchId = globalThis.__kitBatchId;
  const tree = (await call('GET', '/api/knowledge-intake/batches/' + batchId + '/tree')).body.data;
  assert.equal(tree.roots.length, 1);
  const domain = tree.roots[0];
  assert.equal(domain.name, '财富管理');
  assert.equal(domain.rowType, 'functions');
  assert.equal(domain.children.length, 1);
  const sub = domain.children[0];
  assert.equal(sub.name, '账户查询');
  const intent = sub.children[0];
  assert.equal(intent.name, '查询账户余额');
  assert.equal(intent.rowType, 'intents');
  assert.equal(intent.utteranceCount, 2, '说法折叠为计数');
  assert.equal(intent.status, 'pending');
  assert.equal(intent.sourceStatus, '生效');
  assert.equal(intent.bizConfirmed, true, 'Excel 生效 → 业务侧已确认参考标志');
  // 一体化审核：说法直接是意图的叶子节点，一棵树审完三类行
  assert.equal(intent.children.length, 2);
  const leaf = intent.children[0];
  assert.equal(leaf.rowType, 'utterances');
  assert.equal(leaf.kind, '标问');
  assert.equal(leaf.name, '查询账户余额');
  assert.equal(leaf.status, 'pending');
  // 导入契约校验已拦截上级未登记的行，合法批次全树无孤儿（孤儿只在人工改状态后出现，纯函数测试覆盖）
  assert.equal(tree.orphans.length, 0);
  // status 过滤：只看已确认时树为空
  const confirmed = (await call('GET', '/api/knowledge-intake/batches/' + batchId + '/tree?status=approved')).body.data;
  assert.equal(confirmed.roots.length, 0);
  assert.equal(confirmed.status, 'approved');
});

test('review：批量通过；驳回缺审核意见 400；reset 可撤回', async () => {
  const batchId = globalThis.__kitBatchId;
  const items = (await call('GET', '/api/knowledge-intake/batches/' + batchId + '/items?kind=utterances&status=pending')).body.data.items;
  const rowId = items[0].rowId;

  const noNote = await call('POST', '/api/knowledge-intake/batches/' + batchId + '/review', { action: 'reject', itemIds: [rowId] });
  assert.equal(noNote.statusCode, 400);
  assert.equal(noNote.body.error.code, 'KNOWLEDGE_INTAKE_REVIEW_NOTE_REQUIRED');

  const approved = await call('POST', '/api/knowledge-intake/batches/' + batchId + '/review', { action: 'approve', itemIds: [rowId] });
  assert.equal(approved.statusCode, 200, resText(approved));
  assert.equal(approved.body.data.updated, 1);

  const after = (await call('GET', '/api/knowledge-intake/batches/' + batchId + '/items?kind=utterances&status=approved')).body.data;
  assert.equal(after.total, 1, '只有平台人工确认的行才是 approved（Excel 已审核不算）');
  const reviewedRow = after.items[0];
  assert.equal(reviewedRow.text, '查询账户余额', '确认的是队列第一条（Excel 已审核标问排前）');
  assert.equal(reviewedRow.reviewedBy, 'dev');

  // 确认后骨架树（已确认视图）：已确认说法命中，其功能/意图祖先链以背景节点（contextOnly）保留定位
  const tree = (await call('GET', '/api/knowledge-intake/batches/' + batchId + '/tree?status=approved')).body.data;
  let hits = 0;
  const walkHits = (nodes) => nodes.forEach((n) => { if (!n.contextOnly) hits++; walkHits(n.children); });
  walkHits(tree.roots);
  assert.equal(hits, 1, '已确认视图只命中那条已确认说法，其余全是背景祖先');
  assert.equal(tree.roots.length, 1, '祖先链以背景节点保留，树不为空');
  assert.equal(tree.counts.utterances.approved, 1, '计数跨过滤生效：已确认说法 1 条');

  const reset = await call('POST', '/api/knowledge-intake/batches/' + batchId + '/review', { action: 'reset', itemIds: [rowId] });
  assert.equal(reset.body.data.status, 'pending');
});

test('review：未知条目 404、非法 action 400', async () => {
  const batchId = globalThis.__kitBatchId;
  const missing = await call('POST', '/api/knowledge-intake/batches/' + batchId + '/review', { action: 'approve', itemIds: ['u-nothing'] });
  assert.equal(missing.statusCode, 404);
  const badAction = await call('POST', '/api/knowledge-intake/batches/' + batchId + '/review', { action: 'destroy', itemIds: ['u-1'] });
  assert.equal(badAction.statusCode, 400);
});

test('batches：列表包含批次摘要；删除批次后消失', async () => {
  const batchId = globalThis.__kitBatchId;
  const list = await call('GET', '/api/knowledge-intake/batches');
  const found = list.body.data.batches.find((b) => b.batchId === batchId);
  assert.ok(found, '批次在列表中');
  assert.equal(found.counts.functions.total, 2);

  const del = await call('DELETE', '/api/knowledge-intake/batches/' + batchId);
  assert.equal(del.statusCode, 200, resText(del));
  const after = await call('GET', '/api/knowledge-intake/batches');
  assert.ok(!after.body.data.batches.find((b) => b.batchId === batchId));

  const gone = await call('GET', '/api/knowledge-intake/batches/' + batchId + '/items');
  assert.equal(gone.statusCode, 404);
});

test('import：空工作簿/缺 sheet 返回 400 明确错误', async () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['随便'], ['x']]), 'Sheet1');
  const mp = multipartBody(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  const result = await call('POST', '/api/knowledge-intake/import', mp.body, mp.contentType);
  assert.equal(result.statusCode, 400);
  assert.equal(result.body.error.code, 'KNOWLEDGE_INTAKE_SHEET_MISSING');
});

function resText(result) {
  return JSON.stringify(result.body);
}

// ── v2：置信度分层路由 / 变更预览 / 回滚日志 ────────────────────────────────

const {
  rollbackFromDocument,
  classifyConfidence,
  AUTO_APPROVE_CONFIDENCE,
  AUTO_REJECT_CONFIDENCE,
} = require('../routes/knowledge-intake');

test('classifyConfidence：高置信 AI 建议通过、中间带人工、低置信 AI 建议驳回（建议 ≠ 确认）', () => {
  assert.equal(AUTO_APPROVE_CONFIDENCE, 0.9);
  assert.equal(AUTO_REJECT_CONFIDENCE, 0.5);
  assert.equal(classifyConfidence(0.95).status, 'approved');
  assert.equal(classifyConfidence(0.9).status, 'approved', '边界值 ≥ 阈值建议通过');
  assert.equal(classifyConfidence(0.7).status, 'pending');
  assert.equal(classifyConfidence(0.5).status, 'pending', '边界值 < 阈值才建议驳回，0.5 属中间带');
  assert.equal(classifyConfidence(0.3).status, 'rejected');
  assert.equal(classifyConfidence(Number.NaN).status, 'pending', '非数值一律进人工队列');
  assert.ok(classifyConfidence(0.3).note.includes('AI 建议驳回'), classifyConfidence(0.3).note);
  assert.ok(classifyConfidence(0.95).note.includes('待人工确认'), '建议通过也要人工确认');
});

test('applyToIntakeDocument：changes 预览清单与 journal 回滚日志', () => {
  const first = applyToIntakeDocument(graphDoc(), approvedSet(), 'ki-test-journal', '2026-09-18T02:00:00Z');
  assert.ok(Array.isArray(first.changes));
  assert.ok(Array.isArray(first.journal.edges));

  // changes：人类可读，覆盖新建/复用两类动作
  const aggCreate = first.changes.find((c) => c.kind === 'aggregate' && c.action === 'create');
  assert.equal(aggCreate.name, '财富管理/账户查询');
  const aggReuse = first.changes.find((c) => c.kind === 'aggregate' && c.action === 'reuse');
  assert.equal(aggReuse.name, '财富管理');
  const intentCreate = first.changes.find((c) => c.kind === 'intent' && c.action === 'create');
  assert.equal(intentCreate.name, '办理定期存款');
  const intentReuse = first.changes.find((c) => c.kind === 'intent' && c.action === 'reuse');
  assert.equal(intentReuse.name, '查询账户余额');
  const utterAdd = first.changes.filter((c) => c.kind === 'utterance' && c.action === 'add');
  assert.ok(utterAdd.some((c) => c.name === '我卡里还有多少钱' && c.detail === '查询账户余额'));

  // journal：内容确定性 id，可用于回滚
  assert.equal(first.journal.aggregates.length, first.stats.aggregatesCreated);
  assert.equal(first.journal.intents.length, first.stats.intentsCreated);
  assert.equal(first.journal.edges.length, first.stats.edgesCreated);
  const balanceEntry = first.journal.utterances.find((entry) => entry.nodeId === 'intent:existing-balance');
  assert.deepEqual(balanceEntry.texts, ['我卡里还有多少钱'], '复用意图只记本次新增的说法');
});

test('rollbackFromDocument：apply 后回滚恢复原图（节点/边/说法）', () => {
  const baseline = graphDoc();
  const baselineNodeCount = baseline.nodes.length;
  const baselineEdgeCount = baseline.edges.length;
  const first = applyToIntakeDocument(baseline, approvedSet(), 'ki-test-rollback', '2026-09-18T03:00:00Z');
  assert.ok(first.document.nodes.length > baselineNodeCount);

  const result = rollbackFromDocument(first.document, first.journal);
  assert.equal(result.document.nodes.length, baselineNodeCount, '新建聚合+意图已移除');
  assert.equal(result.document.edges.length, baselineEdgeCount, '新建边已移除');
  assert.equal(result.removed.aggregates, first.stats.aggregatesCreated);
  assert.equal(result.removed.intents, first.stats.intentsCreated);
  assert.equal(result.removed.edges, first.stats.edgesCreated);
  assert.equal(result.removed.utterances, 1, '只统计从存活节点删除的说法（新建意图的说法随节点整体移除）');
  assert.deepEqual(result.kept, [], '无外部引用时全部移除');

  const balance = result.document.nodes.find((n) => n.id === 'intent:existing-balance');
  assert.deepEqual(balance.properties.utterance_view, ['查询账户余额', '余额是多少'], '回滚后说法还原');

  // 回滚可重复执行（幂等）
  const again = rollbackFromDocument(result.document, first.journal);
  assert.equal(again.document.nodes.length, baselineNodeCount);
  assert.equal(again.removed.utterances, 0);
});

test('rollbackFromDocument：被外部边引用的新建节点保留并报告', () => {
  const first = applyToIntakeDocument(graphDoc(), approvedSet(), 'ki-test-kept', '2026-09-18T04:00:00Z');
  const deposit = first.document.nodes.find((n) => n.properties.name === '办理定期存款');
  // 模拟入图后其他工序又给新意图挂了边
  first.document.edges.push({ id: 'edge:external', type: 'related_to', source: 'intent:existing-balance', target: deposit.id, properties: {}, provenance: { source: 'manual' } });
  const result = rollbackFromDocument(first.document, first.journal);
  assert.deepEqual(result.kept, [deposit.id]);
  assert.equal(result.removed.intents, 0);
  assert.ok(result.document.nodes.find((n) => n.id === deposit.id), '节点保留');
  assert.ok(!result.document.edges.some((e) => e.id.startsWith('edge:ki:')), '本次新建的边仍全部移除');
});

// ── HTTP：preview-apply / rollback 的守卫分支 ────────────────────────────────

function buildAllRejectedWorkbookBuffer() {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['功能全路径', '功能名称', '业务描述', '客户分类', '安全分级', '责任部门', '状态', '备注'],
    ['贷款', '贷款', '贷款业务的顶层域，含用款与还款服务', '个人客户', 'L2-内部', '信贷部', '停用', ''],
  ]), '1-业务功能分类');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['意图名称', '所属功能全路径', '业务意图类型', '业务描述', '涉及业务对象', '关键要素', '答案形态', '热度', '状态', '意图编码（选填）', '备注'],
    ['办理提前还款', '贷款/不存在的功能', '办理', '客户申请提前偿还房贷的办理意图', '贷款', '', '跳转办理', 'P1-中频', '草稿', '', ''],
  ]), '2-意图清单');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['意图标识', '说法类型', '说法文本', '来源', '置信度', '状态', '审核意见', '备注'],
    ['贷款/办理提前还款', '标问', '办理提前还款', '人工编写', '', '驳回', '暂不收录', ''],
  ]), '3-说法库');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

test('preview-apply：没有已审核条目 400（在触达图谱服务前拦截）；rollback：无入图记录 404', async () => {
  const mp = multipartBody(buildAllRejectedWorkbookBuffer());
  const imported = await call('POST', '/api/knowledge-intake/import', mp.body, mp.contentType);
  assert.equal(imported.statusCode, 200, resText(imported));
  const batchId = imported.body.data.batchId;
  assert.ok(batchId);

  const preview = await call('POST', '/api/knowledge-intake/batches/' + batchId + '/preview-apply', { asset: 'intent-graph' });
  assert.equal(preview.statusCode, 400);
  assert.equal(preview.body.error.code, 'KNOWLEDGE_INTAKE_NOTHING_APPROVED');

  const apply = await call('POST', '/api/knowledge-intake/batches/' + batchId + '/apply', { asset: 'intent-graph' });
  assert.equal(apply.statusCode, 400);

  const rollback = await call('POST', '/api/knowledge-intake/batches/' + batchId + '/rollback', { asset: 'intent-graph' });
  assert.equal(rollback.statusCode, 404);
  assert.equal(rollback.body.error.code, 'KNOWLEDGE_INTAKE_NO_JOURNAL');

  await call('DELETE', '/api/knowledge-intake/batches/' + batchId);
});

test('batches：摘要带 hasJournal 标记（未入图批次为 false）', async () => {
  const list = await call('GET', '/api/knowledge-intake/batches');
  assert.ok(list.body.data.batches.every((b) => b.hasJournal === false || typeof b.hasJournal === 'boolean'));
});

// ── v3：两段式状态机 / 旧数据迁移 / 入图守卫 ────────────────────────────────

const { buildBatchTree, normalizeBatchStatuses } = require('../routes/knowledge-intake');

test('buildBatchTree：纯函数构建骨架树 + status 过滤 + bizConfirmed/AI 建议标志', () => {
  const batch = {
    batchId: 'ki-tree',
    rows: {
      functions: [
        { rowId: 'f-1', path: '财富管理', name: '财富管理', status: 'pending', sourceStatus: '启用' },
        { rowId: 'f-2', path: '财富管理/账户查询', name: '账户查询', status: 'approved', sourceStatus: '启用', reviewedBy: 'dev' },
      ],
      intents: [
        { rowId: 'i-1', ref: '财富管理/账户查询/查询账户余额', name: '查询账户余额', funcPath: '财富管理/账户查询', intentType: '查询', status: 'pending', sourceStatus: '生效', autoApproved: true },
        { rowId: 'i-2', ref: '财富管理/未知功能/孤儿意图', name: '孤儿意图', funcPath: '财富管理/未知功能', status: 'pending', sourceStatus: '草稿' },
      ],
      utterances: [
        { rowId: 'u-1', intentRef: '财富管理/账户查询/查询账户余额', text: '查询账户余额', status: 'pending' },
        { rowId: 'u-2', intentRef: '财富管理/账户查询/查询账户余额', text: '余额多少', status: 'pending' },
        { rowId: 'u-3', intentRef: '财富管理/不存在意图', text: '孤儿说法', status: 'pending' },
      ],
    },
  };
  const tree = buildBatchTree(batch, '');
  assert.equal(tree.roots.length, 1);
  assert.equal(tree.roots[0].children[0].bizConfirmed === undefined || typeof tree.roots[0].bizConfirmed === 'boolean', true);
  const sub = tree.roots[0].children[0];
  assert.equal(sub.status, 'approved', '人工确认过的功能节点带 approved');
  const intent = sub.children[0];
  assert.equal(intent.aiSuggested, true, 'LLM 建议标志透出');
  assert.equal(intent.utteranceCount, 2);
  assert.equal(tree.orphans.length, 2, '孤儿意图 + 孤儿说法');
  assert.ok(tree.orphans.some((o) => o.rowType === 'intents'));
  assert.ok(tree.orphans.some((o) => o.rowType === 'utterances'));

  const onlyConfirmed = buildBatchTree(batch, 'approved');
  assert.equal(onlyConfirmed.roots.length, 1);
  assert.equal(onlyConfirmed.roots[0].children.length, 1, '已确认子域保留');
  assert.equal(onlyConfirmed.roots[0].contextOnly, true, '待确认根域作为背景祖先保留');
  assert.equal(onlyConfirmed.roots[0].children[0].contextOnly, undefined, '命中节点不带背景标志');
  assert.equal(onlyConfirmed.roots[0].children[0].children.length, 0, '未命中的意图/说法分支被剪掉');
  assert.equal(onlyConfirmed.counts.intents.pending, 2, '计数不受树过滤影响');

  // 回归：待确认视图里，已确认中层功能下的待审意图/说法必须仍可见（挂在该功能的背景节点下），不得扫进孤儿
  const onlyPending = buildBatchTree(batch, 'pending');
  assert.equal(onlyPending.roots.length, 1);
  const ctxFunc = onlyPending.roots[0].children[0];
  assert.equal(ctxFunc.status, 'approved');
  assert.equal(ctxFunc.contextOnly, true, '已确认中层功能以待审子级的背景节点保留');
  assert.equal(ctxFunc.children[0].name, '查询账户余额');
  assert.equal(ctxFunc.children[0].children.length, 2, '待审说法仍挂在意图下');
  assert.equal(onlyPending.orphans.length, 2, '真孤儿（功能/意图缺失）才进孤儿列表');
});

test('normalizeBatchStatuses：v3 之前的 Excel 已审核/LLM 自动通过降回待确认，人工确认保留', () => {
  const batch = {
    rows: {
      functions: [{ rowId: 'f-1', status: 'approved', sourceStatus: '启用' }],
      intents: [{ rowId: 'i-1', status: 'approved', reviewedBy: 'dev' }],
      utterances: [
        { rowId: 'u-1', status: 'approved', reviewedBy: 'auto', autoApproved: true },
        { rowId: 'u-2', status: 'approved', reviewedBy: 'zhang' },
        { rowId: 'u-3', status: 'rejected' },
        { rowId: 'u-4', status: 'pending' },
      ],
    },
  };
  const demoted = normalizeBatchStatuses(batch);
  assert.equal(demoted, 2, '功能行 + LLM 自动通过行降级');
  assert.equal(batch.rows.functions[0].status, 'pending');
  assert.equal(batch.rows.intents[0].status, 'approved', '真人审核过的保留确认');
  assert.equal(batch.rows.utterances[0].status, 'pending', 'auto 只是 AI 建议');
  assert.equal(batch.rows.utterances[1].status, 'approved');
  assert.equal(batch.rows.utterances[2].status, 'rejected');
});

test('两段式守卫：纯 Excel 导入（未人工确认）不能直接预览/入图', async () => {
  const mp = multipartBody(buildWorkbookBuffer());
  const imported = await call('POST', '/api/knowledge-intake/import', mp.body, mp.contentType);
  assert.equal(imported.statusCode, 200, resText(imported));
  const batchId = imported.body.data.batchId;

  const preview = await call('POST', '/api/knowledge-intake/batches/' + batchId + '/preview-apply', { asset: 'intent-graph' });
  assert.equal(preview.statusCode, 400);
  assert.equal(preview.body.error.code, 'KNOWLEDGE_INTAKE_NOTHING_APPROVED');
  assert.match(preview.body.error.message, /人工已确认/);

  // 全部确认后守卫放行（继续会触达图谱服务，单测环境只验证守卫翻转）
  const items = (await call('GET', '/api/knowledge-intake/batches/' + batchId + '/items')).body.data.items;
  const confirmable = items.filter((row) => row.rowType !== 'utterances' || !row.intentRef.includes('不存在'));
  const reviewed = await call('POST', '/api/knowledge-intake/batches/' + batchId + '/review', { action: 'approve', itemIds: confirmable.map((row) => row.rowId) });
  assert.equal(reviewed.statusCode, 200, resText(reviewed));
  assert.equal(reviewed.body.data.status, 'approved');

  await call('DELETE', '/api/knowledge-intake/batches/' + batchId);
});

// ── v4：一体化填写单表导入 + 一体化骨架树 ───────────────────────────────────

const { flatToRaw } = require('../routes/knowledge-intake');

test('flatToRaw：单表归并三类行，属性就近填充，说法行继承上一意图，跨功能无意图可继承时报错', () => {
  const raw = flatToRaw([
    { rowNumber: 2, path: '财富管理', fname: '财富管理', fdesc: '财富管理业务域的完整三段式描述示例', clientClass: '个人客户', securityLevel: 'L2-内部', department: '财富管理部', fstatus: '启用', iname: '查询理财产品', intentType: '查询', idesc: '客户查询在售理财产品的意图描述示例', answerForm: '数据卡片', heat: 'P0-高频', istatus: '生效', kind: '标问', text: '查询理财产品' },
    { rowNumber: 3, path: '财富管理', text: '有什么理财可以买' },
    { rowNumber: 4, path: '财富管理', iname: '查询理财产品', text: '看看在售理财' },
    { rowNumber: 5, path: '贷款', text: '没有意图名称的说法' },
  ]);
  assert.equal(raw.functions.length, 2);
  assert.equal(raw.functions[0].department, '财富管理部', '功能属性从第一行填充');
  assert.equal(raw.intents.length, 1);
  assert.equal(raw.intents[0].answerForm, '数据卡片', '意图属性就近填充');
  assert.equal(raw.utterances.length, 4);
  assert.equal(raw.utterances[0].kind, '标问');
  assert.equal(raw.utterances[1].kind, '扩展问', '说法类型缺省扩展问');
  assert.equal(raw.utterances[1].intentRef, '财富管理/查询理财产品', '说法行继承上一意图');
  assert.equal(raw.utterances[3].intentRef, '贷款/', '跨功能且无意图 → 非法标识交给契约校验报错');

  const outcome = validateSheets(raw);
  assert.equal(outcome.rejected.length, 2, JSON.stringify(outcome.rejected));
  assert.ok(outcome.rejected.some((r) => r.errors.some((e) => /意图标识未登记/.test(e))));
  assert.equal(outcome.sheets.functions.length, 1, '贷款 行描述过短被拒');
  assert.equal(outcome.sheets.utterances.length, 3);
});

test('import：一体化单表工作簿直接导入，与三张分表同一候选层语义', async () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['功能全路径', '功能名称', '功能描述', '客户分类', '安全分级', '责任部门', '功能状态', '意图名称', '意图类型', '意图描述', '答案形态', '热度', '意图状态', '说法类型', '说法文本', '说法来源', '说法状态'],
    ['财富管理', '财富管理', '面向个人客户的财富管理业务域，含产品与持仓服务', '个人客户', 'L2-内部', '财富管理部', '启用', '查询理财产品', '查询', '客户查询在售理财产品的意图，返回产品列表', '数据卡片', 'P0-高频', '生效', '标问', '查询理财产品', '人工编写', '已审核'],
    ['财富管理', '', '', '', '', '', '', '', '', '', '', '', '', '', '有什么理财可以买', '人工编写', '候选'],
    ['财富管理/账户查询', '账户查询', '查询本人账户余额、明细与持仓的服务', '个人客户', 'L2-内部', '财富管理部', '启用', '查询账户余额', '查询', '客户询问余额时的查询意图，返回实时余额', '数据卡片', 'P0-高频', '生效', '标问', '查询账户余额', '人工编写', '已审核'],
  ]), '一体化填写');
  const mp = multipartBody(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  const result = await call('POST', '/api/knowledge-intake/import', mp.body, mp.contentType);
  assert.equal(result.statusCode, 200, resText(result));
  assert.equal(result.body.data.importMode, 'flat');
  assert.equal(result.body.data.routed.functions.pending, 2);
  assert.equal(result.body.data.routed.intents.pending, 2);
  assert.equal(result.body.data.routed.utterances.pending, 3, '含继承行，Excel 已审核说法也只是待确认');

  const tree = (await call('GET', '/api/knowledge-intake/batches/' + result.body.data.batchId + '/tree')).body.data;
  assert.equal(tree.roots.length, 1);
  const domain = tree.roots[0];
  const sub = domain.children.find((c) => c.rowType === 'functions');
  const intent = domain.children.find((c) => c.rowType === 'intents');
  assert.equal(sub.name, '账户查询', '功能子域节点');
  assert.equal(intent.name, '查询理财产品', '意图直接挂在域根（一体化表 funcPath=财富管理）');
  assert.equal(intent.children.length, 2, '说法是意图叶子节点（标问 + 继承的扩展问）');
  assert.ok(intent.children.every((c) => c.rowType === 'utterances'));
  const intent2 = sub.children.find((c) => c.rowType === 'intents');
  assert.equal(intent2.name, '查询账户余额');
  assert.equal(intent2.children.length, 1);

  await call('DELETE', '/api/knowledge-intake/batches/' + result.body.data.batchId);
});

// ── v3.5：AI 骨架助手（建议应用）+ 第 1 步验收报告 ──────────────────────────

const { buildAcceptanceReport, applyAssistSuggestion } = require('../routes/knowledge-intake');

function assistBatch() {
  return {
    batchId: 'ki-assist',
    rows: {
      functions: [
        { rowId: 'f-1', path: '财富管理', name: '财富管理', description: '财富管理业务域的顶层描述，覆盖产品与持仓服务', clientClass: '个人客户', securityLevel: 'L2-内部', department: '财富管理部', status: 'pending', sourceStatus: '启用' },
        { rowId: 'f-2', path: '财富管理/产品服务', name: '产品服务', description: '产品服务子功能的完整三段式描述，覆盖查询与交易', clientClass: '个人客户', securityLevel: 'L2-内部', department: '财富管理部', status: 'pending', sourceStatus: '启用' },
        { rowId: 'f-3', path: '财富管理/空的子域', name: '空的子域', description: '挂了一个意图但同名重复的子功能，用于测命名与边界检查逻辑', clientClass: '个人客户', securityLevel: 'L2-内部', department: '财富管理部', status: 'pending', sourceStatus: '启用' },
        { rowId: 'f-4', path: '财富管理/产品服务/费率服务', name: '费率服务', description: '这个叶子功能没有任何意图，用于测覆盖度检查逻辑的叶子判定', clientClass: '个人客户', securityLevel: 'L2-内部', department: '财富管理部', status: 'pending', sourceStatus: '启用' },
      ],
      intents: [
        { rowId: 'i-1', name: '查询理财产品', funcPath: '财富管理/产品服务', ref: '财富管理/产品服务/查询理财产品', intentType: '查询', description: '客户想了解在售理财、基金产品时的查询意图，系统返回产品列表', businessObjects: '理财产品', keySlots: '', triggerScene: '客户想了解可买产品时', scopeIn: '在售产品列表查询', scopeOut: '持仓查询见「查询我的持仓」', roles: '客户', answerForm: '数据卡片', heat: 'P0-高频', status: 'pending', sourceStatus: '生效' },
        { rowId: 'i-2', name: '查询理财产品', funcPath: '财富管理/空的子域', ref: '财富管理/空的子域/查询理财产品', intentType: '查询', description: '与 i-1 同名且非规范场景的重复意图，用于测命名与边界检查', businessObjects: '', keySlots: '', triggerScene: '', scopeIn: '', scopeOut: '', roles: '', answerForm: '', heat: 'P2-低频', status: 'pending', sourceStatus: '草稿' },
        { rowId: 'i-3', name: '理财QR', funcPath: '财富管理/产品服务', ref: '财富管理/产品服务/理财QR', intentType: '查询', description: '内部黑话命名的意图，非动宾短语，用于测命名规范检查逻辑', businessObjects: '', keySlots: '', triggerScene: '', scopeIn: '', scopeOut: '', roles: '', answerForm: '话术答复', heat: 'P2-低频', status: 'pending', sourceStatus: '草稿' },
      ],
      utterances: [
        { rowId: 'u-1', intentRef: '财富管理/产品服务/查询理财产品', kind: '标问', text: '查询理财产品', status: 'pending' },
        { rowId: 'u-2', intentRef: '财富管理/产品服务/查询理财产品', kind: '扩展问', text: '有什么理财可以买', status: 'pending' },
        { rowId: 'u-3', intentRef: '财富管理/产品服务/理财QR', kind: '扩展问', text: '看看理财', status: 'pending' },
      ],
    },
  };
}

test('buildAcceptanceReport：各维打分并抓出覆盖/边界/命名/完整性问题（一致性未预检不计分）', () => {
  const report = buildAcceptanceReport(assistBatch());
  const dims = report.dimensions;
  assert.ok(report.overall < 90, '有问题的批次不该高分：' + report.overall);
  // 覆盖度：费率服务 叶子无意图
  assert.ok(dims.coverage.issues.some((i) => i.unit === '财富管理/产品服务/费率服务' && /没有任何意图/.test(i.message)));
  // 覆盖度：理财QR 无标问；查询理财产品 说法不足 5 条
  assert.ok(dims.coverage.issues.some((i) => /没有标问/.test(i.message) && i.unit.includes('理财QR')));
  assert.ok(dims.coverage.issues.some((i) => /说法仅 2 条/.test(i.message)));
  // 边界：理财QR 排除列为空；同名互指缺失
  assert.ok(dims.boundary.issues.some((i) => /排除.*为空/.test(i.message)));
  // 命名：理财QR 非动宾 + 含字母
  assert.ok(dims.naming.issues.some((i) => /不是动宾短语/.test(i.message) && i.unit.includes('理财QR')));
  assert.ok(dims.naming.issues.some((i) => /字母\/数字/.test(i.message)));
  assert.ok(dims.naming.issues.some((i) => /多个功能下重复/.test(i.message)), '同名意图被抓');
  // 完整性：i-2 答案形态缺失
  assert.ok(dims.completeness.issues.some((i) => /答案形态缺失/.test(i.message)));
  assert.ok(typeof dims.coverage.score === 'number' && dims.coverage.score <= 100);
  // 一致性：该批次没跑过冲突预检 → score=null 不拉低综合分，仅提醒
  assert.equal(dims.consistency.score, null);
  assert.ok(dims.consistency.issues.some((i) => /尚未运行语义冲突预检/.test(i.message)));
  assert.equal(dims.consistency.checked, 0);
  const scoredEntries = Object.entries(dims).filter(([, d]) => d.score !== null);
  const overallExpected = Math.round(scoredEntries.reduce((s, [, d]) => s + d.score, 0) / scoredEntries.length);
  assert.equal(report.overall, overallExpected, '综合分 = 已检维度的均分');
  // 口径：ready 与「可提交入图」标签必须看各维最低分（均分够但短板明显时不能亮绿）
  assert.equal(report.ready, false);
  const weakestExpected = scoredEntries.sort((a, b) => a[1].score - b[1].score)[0][0];
  assert.equal(report.weakestDimension, weakestExpected);
  assert.ok(!/可提交/.test(report.label), '有短板的批次不得标「可提交入图」：' + report.label);
});

test('buildAcceptanceReport：各维全 ≥90（含预检全 fit）时 ready=true 且标签为可提交入图', () => {
  const clean = {
    batchId: 'ki-clean',
    rows: {
      functions: [
        { rowId: 'f-1', path: '个人金融', name: '个人金融', status: 'approved', description: '面向个人客户的存取款、支付结算等基础金融服务，是功能网中的业务域。', department: '个人金融部' },
      ],
      intents: [
        { rowId: 'i-1', funcPath: '个人金融', ref: '个人金融/查询账户余额', name: '查询账户余额', status: 'approved', description: '查询名下账户的当前余额与可用余额，支持多币种与定期账户。', answerForm: '数据卡片', intentType: '查询', scopeIn: '本人名下账户', scopeOut: '不含他行账户', triggerScene: '客户询问余额时', executionMode: 'read-execute', riskLevel: 'L0', orchestrationMode: 'single', lifecycle: 'active', readiness: 'ready' },
      ],
      utterances: [
        { rowId: 'u-1', intentRef: '个人金融/查询账户余额', kind: '标问', text: '查询账户余额', status: 'approved' },
        { rowId: 'u-2', intentRef: '个人金融/查询账户余额', kind: '扩展问', text: '看看我的余额', status: 'approved' },
        { rowId: 'u-3', intentRef: '个人金融/查询账户余额', kind: '扩展问', text: '我的账户还有多少钱', status: 'approved' },
        { rowId: 'u-4', intentRef: '个人金融/查询账户余额', kind: '扩展问', text: '查一下余额', status: 'approved' },
        { rowId: 'u-5', intentRef: '个人金融/查询账户余额', kind: '扩展问', text: '账户余额是多少', status: 'approved' },
      ],
    },
  };
  const report = buildAcceptanceReport(clean);
  assert.equal(report.ready, true, JSON.stringify(report.dimensions));
  assert.equal(report.label, '可提交入图');
  assert.equal(report.weakestDimension, null);
  // 预检过且全部 fit：一致性 100 分，不挡 ready
  clean.rows.utterances.forEach((u) => {
    u.conflict = { verdict: 'fit', suspect: '', reason: '', checkedAt: '2026-09-20T00:00:00.000Z' };
  });
  const checkedReport = buildAcceptanceReport(clean);
  assert.equal(checkedReport.dimensions.consistency.score, 100, JSON.stringify(checkedReport.dimensions.consistency));
  assert.equal(checkedReport.dimensions.consistency.checked, 5);
  assert.equal(checkedReport.dimensions.consistency.conflicts, 0);
  assert.equal(checkedReport.ready, true);
  assert.equal(checkedReport.label, '可提交入图');
});

test('buildAcceptanceReport：语义冲突聚合一致性维（conflict 扣分并出问题项）', () => {
  const batch = assistBatch();
  batch.rows.utterances[0].conflict = { verdict: 'conflict', suspect: '查询理财行情', reason: '都在问理财行情怎么查', checkedAt: '2026-09-20T00:00:00.000Z' };
  batch.rows.utterances[1].conflict = { verdict: 'fit', suspect: '', reason: '', checkedAt: '2026-09-20T00:00:00.000Z' };
  const report = buildAcceptanceReport(batch);
  const dim = report.dimensions.consistency;
  assert.equal(dim.score, 50, JSON.stringify(dim));
  assert.equal(dim.checked, 2);
  assert.equal(dim.conflicts, 1);
  assert.equal(dim.label, '语义一致性');
  assert.ok(
    dim.issues.some((i) => i.level === 'error' && i.unit === '财富管理/产品服务/查询理财产品' && /语义冲突/.test(i.message) && /查询理财行情/.test(i.message) && /都在问理财行情怎么查/.test(i.message)),
    JSON.stringify(dim.issues),
  );
  assert.ok(report.ready === false);
});

test('applyAssistSuggestion：查漏建行 / 重命名重接说法 / 合并去重（全部落 pending）', () => {
  const now = '2026-09-18T05:00:00Z';

  const gapBatch = assistBatch();
  const gap = applyAssistSuggestion(gapBatch, { kind: 'gaps', payload: { type: 'intent', path: '财富管理/产品服务', name: '查询产品费率', description: '客户想了解产品费率', reason: '高频缺口' } }, 'dev', now);
  assert.equal(gap.applied, true);
  const created = gapBatch.rows.intents.find((r) => r.name === '查询产品费率');
  assert.equal(created.status, 'pending', 'AI 建议新增行也必须人工确认');
  assert.equal(created.sourceStatus, 'AI建议新增');
  assert.equal(created.aiSuggested, true);
  // 重复采纳同一条 → 拒绝
  assert.equal(applyAssistSuggestion(gapBatch, { kind: 'gaps', payload: { type: 'intent', path: '财富管理/产品服务', name: '查询产品费率' } }, 'dev', now).applied, false);

  const nameBatch = assistBatch();
  const renamed = applyAssistSuggestion(nameBatch, { kind: 'naming', payload: { ref: '财富管理/产品服务/理财QR', issue: '黑话', suggestion: '查询理财资讯' } }, 'dev', now);
  assert.equal(renamed.applied, true);
  const renamedRow = nameBatch.rows.intents.find((r) => r.name === '查询理财资讯');
  assert.ok(renamedRow, '重命名生效');
  assert.equal(renamedRow.aiRenamedFrom, '理财QR');
  assert.ok(nameBatch.rows.utterances.every((u) => u.intentRef !== '财富管理/产品服务/理财QR'), '说法 ref 已重接');
  assert.ok(nameBatch.rows.utterances.some((u) => u.intentRef === '财富管理/产品服务/查询理财资讯'));

  const dupBatch = assistBatch();
  const merged = applyAssistSuggestion(dupBatch, { kind: 'duplicates', payload: { refs: ['财富管理/产品服务/查询理财产品', '财富管理/空的子域/查询理财产品'], reason: '同名同义', suggestion: 'merge' } }, 'dev', now);
  assert.equal(merged.applied, true);
  const dupRow = dupBatch.rows.intents.find((r) => r.ref === '财富管理/空的子域/查询理财产品');
  assert.equal(dupRow.status, 'rejected', '重复意图被驳回');

  // ambiguities：仅记录
  const amb = applyAssistSuggestion(assistBatch(), { kind: 'ambiguities', payload: { refs: ['a', 'b'], overlap: 'x', suggestion: 'y' } }, 'dev', now);
  assert.equal(amb.applied, true && amb.recorded, true);
});

test('skeleton-assist/action HTTP：写入建议后采纳与忽略，重复采纳被挡', async () => {
  const mp = multipartBody(buildWorkbookBuffer());
  const imported = await call('POST', '/api/knowledge-intake/import', mp.body, mp.contentType);
  const batchId = imported.body.data.batchId;
  assert.ok(batchId);
  // 直接在磁盘写入建议（单测不调 LLM）
  const fs = require('node:fs');
  const batchFile = path.join(process.env.KNOWLEDGE_INTAKE_DIR, batchId, 'batch.json');
  const disk = JSON.parse(fs.readFileSync(batchFile, 'utf8'));
  disk.skeletonAssist = {
    generatedAt: '2026-09-18T06:00:00Z',
    items: [
      { id: 'sa-gap1', kind: 'gaps', payload: { type: 'intent', path: '财富管理/账户查询', name: '查询交易明细', description: '客户查询历史交易明细', reason: '账户查询下缺明细类意图' }, status: 'suggested' },
      { id: 'sa-name1', kind: 'naming', payload: { ref: '财富管理/账户查询/查询账户余额', issue: '过长', suggestion: '查余额' }, status: 'suggested' },
    ],
  };
  fs.writeFileSync(batchFile, JSON.stringify(disk), 'utf8');

  const stored = (await call('GET', '/api/knowledge-intake/batches/' + batchId + '/skeleton-assist')).body.data;
  assert.equal(stored.grouped.gaps.items.length, 1);
  assert.equal(stored.grouped.naming.items.length, 1);
  assert.equal(stored.summary.total, 2);

  // 采纳查漏 → 新建 pending 意图行；忽略命名
  const accept = await call('POST', '/api/knowledge-intake/batches/' + batchId + '/skeleton-assist/action', { action: 'accept', ids: ['sa-gap1'] });
  assert.equal(accept.statusCode, 200, resText(accept));
  assert.equal(accept.body.data.updated, 1);
  const dismiss = await call('POST', '/api/knowledge-intake/batches/' + batchId + '/skeleton-assist/action', { action: 'dismiss', ids: ['sa-name1'] });
  assert.equal(dismiss.body.data.updated, 1);

  const intents = (await call('GET', '/api/knowledge-intake/batches/' + batchId + '/items?kind=intents')).body.data.items;
  const added = intents.find((row) => row.name === '查询交易明细');
  assert.ok(added, '查漏建议落地为新意图行');
  assert.equal(added.status, 'pending');
  assert.equal(added.sourceStatus, 'AI建议新增');

  // 重复采纳 → blocked
  const again = await call('POST', '/api/knowledge-intake/batches/' + batchId + '/skeleton-assist/action', { action: 'accept', ids: ['sa-gap1'] });
  assert.equal(again.body.data.blocked, 1);

  // 验收报告可取且维度齐全
  const acceptance = (await call('GET', '/api/knowledge-intake/batches/' + batchId + '/acceptance')).body.data;
  assert.ok(['coverage', 'boundary', 'naming', 'completeness'].every((k) => typeof acceptance.dimensions[k].score === 'number'));
  assert.ok(typeof acceptance.overall === 'number');

  await call('DELETE', '/api/knowledge-intake/batches/' + batchId);
});

// ── v4 在线编辑：空白批次 + 行级 CRUD（validateRow 与导入共用同一套规则） ─────

const GRID_FUNC = (path, name) => ({
  path, name,
  description: '在线编辑生成的功能描述，用于网格自测（不少于10字）',
  clientClass: '个人客户', securityLevel: 'L2-内部', department: '财富管理部', status: '启用', note: '',
});
const GRID_INTENT = (name, funcPath) => ({
  name, funcPath, intentType: '查询',
  description: '在线编辑生成的意图描述，用于网格自测（不少于10字）',
  businessObjects: '', keySlots: '', triggerScene: '', scopeIn: '', scopeOut: '', roles: '',
  answerForm: '话术答复', heat: 'P1-中频', status: '生效', code: '', note: '',
});
const GRID_UTTER = (intentRef, kind, text) => ({
  intentRef, kind, text, source: '人工编写', confidence: '', status: '已审核', reviewNote: '', note: '',
});

test('validateRow：单行校验复用导入规则文案，excludeRowId 避免自比较误报', () => {
  const batch = { rows: validateSheets(validRaw()).sheets };
  const ok = validateRow('functions', GRID_FUNC('财富管理/定期存款', '定期存款'), batch, null);
  assert.deepEqual(ok.errors, [], JSON.stringify(ok.errors));
  const dup = validateRow('functions', GRID_FUNC('财富管理', '财富管理'), batch, null);
  assert.match(dup.errors.join('|'), /功能路径重复/);
  const edited = validateRow('functions', GRID_FUNC('财富管理', '财富管理'), batch, batch.rows.functions[0].rowId);
  assert.deepEqual(edited.errors, [], '排除自身后同路径不再判重');
  const utterDup = validateRow('utterances', GRID_UTTER('财富管理/账户查询/查询账户余额', '标问', '查询账户余额'), batch, null);
  assert.match(utterDup.errors.join('|'), /同一意图下说法文本重复/);
});

test('在线编辑：空白批次 + 行 CRUD + 两段式降级 + 级联重接/删除', async () => {
  const created = await call('POST', '/api/knowledge-intake/batches', { name: '网格自测批次' });
  assert.equal(created.statusCode, 200, resText(created));
  const bid = created.body.data.batchId;
  assert.match(bid, /^ki-\d{8}-[0-9a-f]{8}$/);
  assert.equal(created.body.data.fileName, '网格自测批次');
  assert.equal(created.body.data.counts.functions.total, 0, '空白批次三类行均为 0');

  const f1 = await call('POST', '/api/knowledge-intake/batches/' + bid + '/rows', { rowType: 'functions', row: GRID_FUNC('财富管理', '财富管理') });
  assert.equal(f1.statusCode, 200, resText(f1));
  assert.equal(f1.body.data.row.status, 'pending', '在线编辑只产出待确认（两段式）');
  assert.equal(f1.body.data.row.sourceStatus, '启用', '业务侧状态留 sourceStatus');
  const f2 = await call('POST', '/api/knowledge-intake/batches/' + bid + '/rows', { rowType: 'functions', row: GRID_FUNC('财富管理/账户查询', '账户查询') });
  assert.equal(f2.statusCode, 200, resText(f2));
  const i1 = await call('POST', '/api/knowledge-intake/batches/' + bid + '/rows', { rowType: 'intents', row: GRID_INTENT('查询账户余额', '财富管理/账户查询') });
  assert.equal(i1.statusCode, 200, resText(i1));
  const u1 = await call('POST', '/api/knowledge-intake/batches/' + bid + '/rows', { rowType: 'utterances', row: GRID_UTTER('财富管理/账户查询/查询账户余额', '标问', '查询账户余额') });
  assert.equal(u1.statusCode, 200, resText(u1));
  assert.equal(u1.body.data.row.sourceStatus, '已审核', '在线填写的已审核同样只是业务口径');

  const badFunc = await call('POST', '/api/knowledge-intake/batches/' + bid + '/rows', { rowType: 'functions', row: Object.assign(GRID_FUNC('财富管理/坏行', '坏行'), { description: '太短' }) });
  assert.equal(badFunc.statusCode, 422);
  assert.equal(badFunc.body.error.code, 'KNOWLEDGE_INTAKE_ROW_INVALID');
  assert.match(badFunc.body.error.message, /业务描述过短/);
  const badRef = await call('POST', '/api/knowledge-intake/batches/' + bid + '/rows', { rowType: 'utterances', row: GRID_UTTER('财富管理/账户查询/不存在', '扩展问', '没挂上的说法') });
  assert.equal(badRef.statusCode, 422);
  assert.match(badRef.body.error.message, /意图标识未登记/);
  const dupUtter = await call('POST', '/api/knowledge-intake/batches/' + bid + '/rows', { rowType: 'utterances', row: GRID_UTTER('财富管理/账户查询/查询账户余额', '扩展问', '查询账户余额') });
  assert.equal(dupUtter.statusCode, 422);
  assert.match(dupUtter.body.error.message, /同一意图下说法文本重复/);
  const dupFunc = await call('POST', '/api/knowledge-intake/batches/' + bid + '/rows', { rowType: 'functions', row: GRID_FUNC('财富管理', '财富管理') });
  assert.equal(dupFunc.statusCode, 422);
  assert.match(dupFunc.body.error.message, /功能路径重复/);

  // 确认意图与说法 → 改非身份字段：确认失效但 rowId 不变
  await call('POST', '/api/knowledge-intake/batches/' + bid + '/review', { action: 'approve', itemIds: [i1.body.data.row.rowId, u1.body.data.row.rowId] });
  const patched = await call('PATCH', '/api/knowledge-intake/batches/' + bid + '/rows/' + i1.body.data.row.rowId, { row: { description: '改过的意图描述，依然足够长（不少于10字）' } });
  assert.equal(patched.statusCode, 200, resText(patched));
  assert.equal(patched.body.data.demoted, true, '编辑使确认失效');
  assert.equal(patched.body.data.row.status, 'pending');
  assert.equal(patched.body.data.row.reviewedBy, '', '确认人清空，溯源保留');
  assert.equal(patched.body.data.row.sourceStatus, '生效');
  assert.equal(patched.body.data.row.rowId, i1.body.data.row.rowId, '非身份字段变更不改 rowId');

  // 改意图名称 → rowId 再生成 + 说法级联重接（rowId 与 Excel 导入同一生成器）+ 级联降级
  await call('POST', '/api/knowledge-intake/batches/' + bid + '/review', { action: 'approve', itemIds: [patched.body.data.row.rowId, u1.body.data.row.rowId] });
  const renamed = await call('PATCH', '/api/knowledge-intake/batches/' + bid + '/rows/' + patched.body.data.row.rowId, { row: { name: '余额查询' } });
  assert.equal(renamed.statusCode, 200, resText(renamed));
  assert.notEqual(renamed.body.data.row.rowId, patched.body.data.row.rowId);
  assert.equal(renamed.body.data.row.ref, '财富管理/账户查询/余额查询');
  assert.equal(renamed.body.data.cascaded.utterances, 1, '子说法被级联重接');
  const utterAfter = (await call('GET', '/api/knowledge-intake/batches/' + bid + '/items?kind=utterances')).body.data.items[0];
  assert.equal(utterAfter.intentRef, '财富管理/账户查询/余额查询');
  const crypto = require('node:crypto');
  const expectedUId = 'u-' + crypto.createHash('sha1').update('财富管理/账户查询/余额查询 标问 查询账户余额', 'utf8').digest('hex').slice(0, 12);
  assert.equal(utterAfter.rowId, expectedUId, '重接后 rowId 与导入生成器一致');
  assert.equal(utterAfter.status, 'pending', '级联重接使说法确认失效');
  assert.equal(renamed.body.data.row.status, 'pending');

  // 校验失败的 PATCH：422 且不落盘（原行保持 approved）
  await call('POST', '/api/knowledge-intake/batches/' + bid + '/review', { action: 'approve', itemIds: [renamed.body.data.row.rowId] });
  const badPatch = await call('PATCH', '/api/knowledge-intake/batches/' + bid + '/rows/' + renamed.body.data.row.rowId, { row: { intentType: '不存在类型' } });
  assert.equal(badPatch.statusCode, 422);
  const stillApproved = (await call('GET', '/api/knowledge-intake/batches/' + bid + '/items?kind=intents&status=approved')).body.data;
  assert.equal(stillApproved.total, 1, '校验失败的 PATCH 不落盘');

  const delIntent = await call('DELETE', '/api/knowledge-intake/batches/' + bid + '/rows/' + renamed.body.data.row.rowId);
  assert.equal(delIntent.statusCode, 200, resText(delIntent));
  assert.deepEqual(delIntent.body.data.deleted, { functions: 0, intents: 1, utterances: 1 });
  const afterIntent = (await call('GET', '/api/knowledge-intake/batches/' + bid + '/items')).body.data;
  assert.equal(afterIntent.total, 2, '只剩两个功能行');

  const delFunc = await call('DELETE', '/api/knowledge-intake/batches/' + bid + '/rows/' + f1.body.data.row.rowId);
  assert.equal(delFunc.statusCode, 200, resText(delFunc));
  assert.deepEqual(delFunc.body.data.deleted, { functions: 2, intents: 0, utterances: 0 });
  const empty = (await call('GET', '/api/knowledge-intake/batches/' + bid + '/items')).body.data;
  assert.equal(empty.total, 0);

  await call('DELETE', '/api/knowledge-intake/batches/' + bid);
});

test('在线编辑：存量子批次与网格批次互不干扰，原子写不留临时文件', async () => {
  const created = await call('POST', '/api/knowledge-intake/batches', {});
  const bid = created.body.data.batchId;
  assert.equal(created.body.data.fileName, '在线新建', '未命名批次给默认名');
  const dir = require('node:fs').readdirSync(require('node:path').join(process.env.KNOWLEDGE_INTAKE_DIR, bid));
  assert.ok(dir.includes('batch.json'), 'batch.json 落盘');
  assert.ok(!dir.some((f) => f.includes('.tmp-')), '原子写不留临时文件');
  await call('DELETE', '/api/knowledge-intake/batches/' + bid);
});

test('批次领域（L0 根节点名）：PATCH 可命名并持久化，空名拒绝', async () => {
  const created = await call('POST', '/api/knowledge-intake/batches', {});
  const bid = created.body.data.batchId;
  assert.equal(created.body.data.domain, '', '新批次领域默认空（前端回退显示）');

  const renamed = await call('PATCH', '/api/knowledge-intake/batches/' + bid, { domain: '  手机银行  ' });
  assert.equal(renamed.statusCode, 200, resText(renamed));
  assert.equal(renamed.body.data.domain, '手机银行', '领域名去首尾空格后保存');

  const reread = await call('GET', '/api/knowledge-intake/batches/' + bid);
  assert.equal(reread.body.data.domain, '手机银行', '领域名持久化（重读仍在）');

  const empty = await call('PATCH', '/api/knowledge-intake/batches/' + bid, { domain: '   ' });
  assert.equal(empty.statusCode, 400);
  assert.match(resText(empty), /领域名不能为空/);

  await call('DELETE', '/api/knowledge-intake/batches/' + bid);
});

test('export：一体化大表（一行一条说法+审核列），业务可审、且可原样回导', async () => {
  const mp0 = multipartBody(buildWorkbookBuffer());
  const seeded = await call('POST', '/api/knowledge-intake/import', mp0.body, mp0.contentType);
  assert.equal(seeded.statusCode, 200, resText(seeded));
  const batchId = seeded.body.data.batchId;

  const res = await call('GET', '/api/knowledge-intake/batches/' + batchId + '/export');
  assert.equal(res.statusCode, 200, resText(res));
  const raw = res.body.raw;
  assert.ok(Buffer.isBuffer(raw), '响应是二进制');
  assert.equal(raw.slice(0, 2).toString(), 'PK', 'xlsx 是 zip 容器');

  const wb = XLSX.read(raw, { type: 'buffer' });
  assert.ok(wb.SheetNames.includes('一体化填写'), '单表工作簿');
  const matrix = XLSX.utils.sheet_to_json(wb.Sheets['一体化填写'], { header: 1, defval: '' });
  const headers = matrix[0];
  assert.ok(headers.includes('功能全路径') && headers.includes('说法文本'));
  assert.ok(headers.includes('平台确认状态') && headers.includes('平台审核意见'), '模板列之后追加审核列（回导自动忽略）');
  const at = (name) => headers.indexOf(name);
  const dataRows = matrix.slice(1);
  assert.equal(dataRows.length, 3, '纯功能行 1 + 意图首说法行 1 + 第二条说法行 1');

  const funcRow = dataRows.find((r) => r[at('功能全路径')] === '财富管理' && !r[at('说法文本')]);
  assert.ok(funcRow, '纯功能登记行（无意图的功能）');
  const firstUtt = dataRows.find((r) => r[at('说法文本')] === '查询账户余额');
  assert.equal(firstUtt[at('意图名称')], '查询账户余额', '首条说法行带意图定义');
  assert.equal(firstUtt[at('平台确认状态')], '待确认');
  const secondUtt = dataRows.find((r) => r[at('说法文本')] === '我卡里还有多少钱');
  assert.equal(secondUtt[at('功能全路径')], '财富管理/账户查询', '后续说法行也带全路径（回导挂接键）');
  assert.equal(secondUtt[at('意图名称')], '', '后续说法行意图属性留空（向下填充语义）');
  assert.equal(secondUtt[at('置信度')], '0.88');

  // 回导：导出表原样导入，全部合法入库（rejected 为 0）
  const mp = multipartBody(raw);
  const re = await call('POST', '/api/knowledge-intake/import', mp.body, mp.contentType);
  assert.equal(re.statusCode, 200, resText(re));
  assert.equal(re.body.data.routed.functions.total, 2);
  assert.equal(re.body.data.routed.intents.total, 1);
  assert.equal(re.body.data.routed.utterances.total, 2);
  assert.equal(re.body.data.rejected.length, 0, '导出表回导零拒绝');
  await call('DELETE', '/api/knowledge-intake/batches/' + re.body.data.batchId);
  await call('DELETE', '/api/knowledge-intake/batches/' + batchId);
});

test('回导闭环：导出表带审核结论与批次标识，采纳后合并回原批次（两段式不破）', async () => {
  // 原批次 A：导入模板 → 平台人工确认两条说法、驳回顶层功能
  const mpA = multipartBody(buildWorkbookBuffer());
  const seeded = await call('POST', '/api/knowledge-intake/import', mpA.body, mpA.contentType);
  assert.equal(seeded.statusCode, 200, resText(seeded));
  const batchA = seeded.body.data.batchId;
  const utts = (await call('GET', '/api/knowledge-intake/batches/' + batchA + '/items?kind=utterances')).body.data.items;
  const funcs = (await call('GET', '/api/knowledge-intake/batches/' + batchA + '/items?kind=functions')).body.data.items;
  const topFunc = funcs.find((f) => f.path === '财富管理');
  assert.ok(topFunc);
  const ap1 = await call('POST', '/api/knowledge-intake/batches/' + batchA + '/review', { action: 'approve', itemIds: utts.map((u) => u.rowId) });
  assert.equal(ap1.statusCode, 200, resText(ap1));
  const rj1 = await call('POST', '/api/knowledge-intake/batches/' + batchA + '/review', { action: 'reject', itemIds: [topFunc.rowId], note: '域名待商榷' });
  assert.equal(rj1.statusCode, 200, resText(rj1));

  // 导出 → 表内带结论列与批次标识
  const ex = await call('GET', '/api/knowledge-intake/batches/' + batchA + '/export');
  assert.equal(ex.statusCode, 200, resText(ex));

  // 回导：结论只成为待采纳标记（导入本身全部待确认），批次标识指回 A
  const mpB = multipartBody(ex.body.raw);
  const seededB = await call('POST', '/api/knowledge-intake/import', mpB.body, mpB.contentType);
  assert.equal(seededB.statusCode, 200, resText(seededB));
  const meta = seededB.body.data.reviewMeta;
  assert.equal(meta.approved, 2, '两条说法的已确认标记');
  assert.equal(meta.rejected, 1, '顶层功能的已驳回标记');
  assert.equal(seededB.body.data.srcBatchId, batchA, '批次标识指回原批次');
  const batchB = seededB.body.data.batchId;
  assert.equal(seededB.body.data.routed.utterances.pending, 2, '导入本身不产生已确认（两段式）');
  assert.equal(seededB.body.data.routed.functions.pending, 2, '功能状态列是业务口径（启用）；平台驳回只存在于结论标记');

  // 采纳（显式人工动作）：结论落库 + 未标记父级保守推导
  const ap = await call('POST', '/api/knowledge-intake/batches/' + batchB + '/apply-review', {});
  assert.equal(ap.statusCode, 200, resText(ap));
  assert.equal(ap.body.data.applied.approved, 2);
  assert.equal(ap.body.data.applied.rejected, 1);
  assert.equal(ap.body.data.derived.intents, 1, '意图按「全部说法已确认」推导');
  assert.equal(ap.body.data.derived.functions, 1, '只推导子功能（顶层已被人工驳回，不覆盖）');

  // 合并回原批次：结论搬迁、相同行不重复、来源批次删除
  const mg = await call('POST', '/api/knowledge-intake/batches/' + batchA + '/merge', { sourceId: batchB });
  assert.equal(mg.statusCode, 200, resText(mg));
  assert.equal(mg.body.data.updated.utterances, 0, 'A 的说法本就已确认，状态相同不重复搬迁');
  assert.equal(mg.body.data.updated.intents, 1, '意图在 A 还是待确认，搬回导出的已确认');
  assert.equal(mg.body.data.updated.functions, 1);
  assert.equal(mg.body.data.added.utterances, 0, '相同说法不重复入批次');
  assert.equal(mg.body.data.sourceDeleted, true);

  // 原批次最终状态：人工驳回保留、其余按回导结论就位
  const funcs2 = (await call('GET', '/api/knowledge-intake/batches/' + batchA + '/items?kind=functions')).body.data.items;
  const ftop = funcs2.find((f) => f.path === '财富管理');
  const fsub = funcs2.find((f) => f.path === '财富管理/账户查询');
  assert.equal(ftop.status, 'rejected');
  assert.equal(ftop.reviewNote, '域名待商榷', '人工驳回与意见不被回导覆盖');
  assert.equal(fsub.status, 'approved');
  const intents2 = (await call('GET', '/api/knowledge-intake/batches/' + batchA + '/items?kind=intents')).body.data.items;
  assert.equal(intents2[0].status, 'approved');
  const utts2 = (await call('GET', '/api/knowledge-intake/batches/' + batchA + '/items?kind=utterances')).body.data.items;
  assert.ok(utts2.every((u) => u.status === 'approved'));

  // 来源批次已删除；无标记时 apply-review 拒绝
  const gone = await call('GET', '/api/knowledge-intake/batches/' + batchB);
  assert.equal(gone.statusCode, 404);
  const noMarks = await call('POST', '/api/knowledge-intake/batches/' + batchA + '/apply-review', {});
  assert.equal(noMarks.statusCode, 400);
  await call('DELETE', '/api/knowledge-intake/batches/' + batchA);
});

// ── 修订审阅（track changes）：AI 增补待确认、采纳=人工确认生效、放弃=驳回留痕 ──

const {
  applyExpansionResults,
  applyReviewAction,
  createRevision,
  remapRevisionRowIds,
  revisionOpenCount,
} = require('../routes/knowledge-intake');

function injectBatch(batchId, mutate) {
  const fs = require('node:fs');
  const batchFile = path.join(process.env.KNOWLEDGE_INTAKE_DIR, batchId, 'batch.json');
  const disk = JSON.parse(fs.readFileSync(batchFile, 'utf8'));
  mutate(disk);
  fs.writeFileSync(batchFile, JSON.stringify(disk), 'utf8');
}

test('applyExpansionResults：新说法落 pending + 建议标志，登记 utterance-expansion 修订（pending）', () => {
  const now = '2026-09-22T03:00:00Z';
  const batch = { batchId: 't-expand', rows: validateSheets(validRaw()).sheets };
  const intentRow = batch.rows.intents[0];
  const outcome = applyExpansionResults(batch, [intentRow], [
    {
      intentId: intentRow.rowId,
      status: 'ok',
      utterances: [
        { text: '余额还剩多少', confidence: 0.95 },
        { text: '查询账户余额', confidence: 0.9 },  // 与存量重复 → 去重
        { text: 'x', confidence: 0.5 },              // 长度不足 → 丢弃
        { text: '帮我看下卡里的余额情况', confidence: 0.3 },
      ],
    },
    { intentId: 'i-不存在', status: 'ok', utterances: [{ text: '不该出现的说法', confidence: 0.9 }] },
  ], 5, now);

  assert.equal(outcome.added, 2, '去重与长度过滤后新增 2 条');
  assert.equal(outcome.addedByIntent[intentRow.rowId], 2);
  const created = batch.rows.utterances.filter((row) => row.source === 'LLM生成');
  assert.equal(created.length, 2);
  assert.ok(created.every((row) => row.status === 'pending'), '两段式：AI 增补一律待确认');
  const hi = created.find((row) => row.text === '余额还剩多少');
  assert.equal(hi.sourceStatus, 'AI建议通过');
  assert.equal(hi.autoApproved, true);
  assert.equal(hi.reviewedBy, 'auto', '置信度分层只产建议标志，不是人工确认');
  const lo = created.find((row) => row.text === '帮我看下卡里的余额情况');
  assert.equal(lo.sourceStatus, 'AI建议驳回');
  assert.equal(lo.autoRejected, true);

  const revision = outcome.revision;
  assert.ok(revision && revision.revId.startsWith('rev-'));
  assert.equal(revision.type, 'utterance-expansion');
  assert.equal(revision.changes.length, 2);
  assert.ok(revision.changes.every((change) => change.op === 'add' && change.resolution === 'pending'));
  assert.equal(revisionOpenCount(batch), 1);
  assert.equal(outcome.autoApproved, 1);
  assert.equal(outcome.autoRejected, 1);
});

test('applyReviewAction：批量写审核结论（review 与修订 resolve 共用）', () => {
  const batch = { batchId: 't-review', rows: validateSheets(validRaw()).sheets };
  const ids = batch.rows.utterances.map((row) => row.rowId);
  const { updated, nextStatus } = applyReviewAction(batch, ids, 'approve', '', 'dev', '2026-09-22T03:00:00Z');
  assert.equal(updated, 2);
  assert.equal(nextStatus, 'approved');
  assert.ok(batch.rows.utterances.every((row) => row.status === 'approved' && row.reviewedBy === 'dev'));
  // 修订模型可直接挂进批次
  createRevision(batch, 'row-edit', '人工编辑「x」', [{ rowId: ids[0], rowType: 'utterances', op: 'modify', field: 'text', before: 'a', after: 'b', resolution: 'accepted' }], 'dev');
  assert.equal(batch.revisions.length, 1);
  assert.equal(revisionOpenCount(batch), 0, 'accepted 变更不算 open');
});

test('revisions HTTP：GET 附 liveStatus/stale；resolve 采纳/放弃/stale 兜底；摘要带计数', async () => {
  const created = await call('POST', '/api/knowledge-intake/batches', { name: '修订审阅测试' });
  const batchId = created.body.data.batchId;
  injectBatch(batchId, (disk) => {
    disk.rows.utterances.push(
      { rowId: 'u-rev1', intentRef: 'r1', kind: '扩展问', text: '生成说法A', source: 'LLM生成', confidence: 0.9, status: 'pending', sourceStatus: 'AI建议通过' },
      { rowId: 'u-rev2', intentRef: 'r1', kind: '扩展问', text: '生成说法B', source: 'LLM生成', confidence: 0.4, status: 'pending', sourceStatus: 'AI建议驳回' },
    );
    disk.revisions = [{
      revId: 'rev-abc123',
      type: 'utterance-expansion',
      title: 'LLM 扩展问补全（3 条）',
      createdAt: '2026-09-22T03:00:00Z',
      createdBy: 'auto',
      changes: [
        { rowId: 'u-rev1', rowType: 'utterances', op: 'add', label: '生成说法A', resolution: 'pending' },
        { rowId: 'u-rev2', rowType: 'utterances', op: 'add', label: '生成说法B', resolution: 'pending' },
        { rowId: 'u-gone', rowType: 'utterances', op: 'add', label: '已删行', resolution: 'pending' },
      ],
    }];
  });

  const list = (await call('GET', '/api/knowledge-intake/batches/' + batchId + '/revisions')).body.data;
  assert.equal(list.open, 1, 'open 计含 pending 变更的修订条数');
  assert.equal(list.revisions.length, 1);
  assert.equal(list.revisions[0].changes.filter((change) => change.resolution === 'pending').length, 3);
  const staleChange = list.revisions[0].changes.find((change) => change.rowId === 'u-gone');
  assert.equal(staleChange.stale, true, '行已删除的 change 标 stale');
  assert.equal(staleChange.liveStatus, null);
  assert.equal(list.revisions[0].changes.find((change) => change.rowId === 'u-rev1').liveStatus, 'pending');

  const resolved = await call('POST', '/api/knowledge-intake/batches/' + batchId + '/revisions/rev-abc123/resolve', {
    changes: [
      { rowId: 'u-rev1', action: 'accept' },
      { rowId: 'u-rev2', action: 'reject' },
      { rowId: 'u-gone', action: 'accept' },
    ],
  });
  assert.equal(resolved.statusCode, 200, resText(resolved));
  assert.equal(resolved.body.data.reviewed.approved, 1);
  assert.equal(resolved.body.data.reviewed.rejected, 1);
  assert.equal(resolved.body.data.resolved, 3, 'stale 行也一并裁决');
  const revision = resolved.body.data.revision;
  const acc = revision.changes.find((change) => change.rowId === 'u-rev1');
  assert.equal(acc.resolution, 'accepted');
  const rej = revision.changes.find((change) => change.rowId === 'u-rev2');
  assert.equal(rej.resolution, 'rejected');
  const gone = revision.changes.find((change) => change.rowId === 'u-gone');
  assert.equal(gone.resolution, 'rejected', 'stale 行兜底为放弃');
  assert.equal(gone.note, '行已不存在');

  const items = (await call('GET', '/api/knowledge-intake/batches/' + batchId + '/items?kind=utterances')).body.data.items;
  const byId = Object.fromEntries(items.map((row) => [row.rowId, row]));
  assert.equal(byId['u-rev1'].status, 'approved', '采纳=人工确认，行生效');
  assert.equal(byId['u-rev1'].reviewedBy, 'dev');
  assert.equal(byId['u-rev2'].status, 'rejected', '放弃=驳回留痕');
  assert.equal(byId['u-rev2'].reviewNote, '放弃修订', '未填意见时给默认意见');

  const after = (await call('GET', '/api/knowledge-intake/batches/' + batchId + '/revisions')).body.data;
  assert.equal(after.open, 0);
  const summary = (await call('GET', '/api/knowledge-intake/batches')).body.data.batches.find((batch) => batch.batchId === batchId);
  assert.deepEqual(summary.revisions, { total: 1, open: 0 }, '批次摘要带修订计数');

  const again = await call('POST', '/api/knowledge-intake/batches/' + batchId + '/revisions/rev-abc123/resolve', {
    changes: [{ rowId: 'u-rev1', action: 'accept' }],
  });
  assert.equal(again.statusCode, 400, '无 pending 可裁决 → 400');
  const missing = await call('POST', '/api/knowledge-intake/batches/' + batchId + '/revisions/rev-zzzzzz/resolve', {
    changes: [{ rowId: 'u-rev1', action: 'accept' }],
  });
  assert.equal(missing.statusCode, 404);
  await call('DELETE', '/api/knowledge-intake/batches/' + batchId);
});

test('PATCH 行编辑自动记 row-edit 审计修订（accepted 态）', async () => {
  const created = await call('POST', '/api/knowledge-intake/batches', { name: '编辑审计测试' });
  const batchId = created.body.data.batchId;
  injectBatch(batchId, (disk) => {
    disk.rows.functions.push({ rowId: 'f-root-audit', path: '财富管理', name: '财富管理', description: '编辑审计测试所需的根功能域占位描述', clientClass: '个人客户', securityLevel: 'L2-内部', department: '财富管理部', status: 'pending', sourceStatus: '启用' });
  });
  const added = await call('POST', '/api/knowledge-intake/batches/' + batchId + '/rows', {
    rowType: 'functions',
    row: GRID_FUNC('财富管理/编辑审计域', '编辑审计域'),
  });
  assert.equal(added.statusCode, 200, resText(added));
  const rowId = added.body.data.row.rowId;

  const patched = await call('PATCH', '/api/knowledge-intake/batches/' + batchId + '/rows/' + rowId, {
    row: { description: '修改后的功能业务描述，长度也满足模板契约要求' },
  });
  assert.equal(patched.statusCode, 200, resText(patched));

  const list = (await call('GET', '/api/knowledge-intake/batches/' + batchId + '/revisions')).body.data;
  const audit = list.revisions.find((rev) => rev.type === 'row-edit');
  assert.ok(audit, 'PATCH 自动记审计修订');
  const change = audit.changes.find((item) => item.field === 'description');
  assert.ok(change, '仅记录有变化的字段');
  assert.equal(change.before, '在线编辑生成的功能描述，用于网格自测（不少于10字）');
  assert.equal(change.after, '修改后的功能业务描述，长度也满足模板契约要求');
  assert.equal(change.resolution, 'accepted', '人工编辑保存前已弹 diff 确认，落库即生效');
  assert.equal(change.resolvedBy, 'dev');
  assert.equal(list.open, 0, '审计修订不计 open');
  assert.equal(list.revisions.filter((rev) => rev.type === 'row-edit').length, 1, '无变化字段不产生空审计');
  await call('DELETE', '/api/knowledge-intake/batches/' + batchId);
});

test('功能改名级联后，open 修订里的说法 rowId 同步 remap（不悬空）', async () => {
  const created = await call('POST', '/api/knowledge-intake/batches', { name: '级联 remap 测试' });
  const batchId = created.body.data.batchId;
  injectBatch(batchId, (disk) => {
    disk.rows.functions.push(
      { rowId: 'f-root-mv', path: '财富管理', name: '财富管理', description: '级联重定位测试所需的根功能域占位描述', clientClass: '个人客户', securityLevel: 'L2-内部', department: '财富管理部', status: 'pending', sourceStatus: '启用' },
      { rowId: 'f-p1', path: '财富管理/迁移域', name: '迁移域', description: '级联重定位测试用的功能描述十字', clientClass: '个人客户', securityLevel: 'L2-内部', department: '财富管理部', status: 'pending', sourceStatus: '启用' },
    );
    disk.rows.intents.push({ rowId: 'i-p1', name: '迁移意图', funcPath: '财富管理/迁移域', ref: '财富管理/迁移域/迁移意图', intentType: '查询', description: '级联重定位测试用的意图描述', answerForm: '话术答复', heat: 'P1-中频', status: 'pending', sourceStatus: '候选' });
    disk.rows.utterances.push({ rowId: 'u-old-utterance', intentRef: '财富管理/迁移域/迁移意图', kind: '扩展问', text: '迁移的说法文本', source: 'LLM生成', confidence: 0.9, status: 'pending', sourceStatus: 'AI建议通过' });
    disk.revisions = [{
      revId: 'rev-cascade1',
      type: 'utterance-expansion',
      title: 'LLM 扩展问补全（1 条）',
      createdAt: '2026-09-22T03:00:00Z',
      createdBy: 'auto',
      changes: [{ rowId: 'u-old-utterance', rowType: 'utterances', op: 'add', label: '迁移的说法文本', resolution: 'pending' }],
    }];
  });

  const patched = await call('PATCH', '/api/knowledge-intake/batches/' + batchId + '/rows/f-p1', {
    row: { path: '财富管理/迁移域2', name: '迁移域2' },
  });
  assert.equal(patched.statusCode, 200, resText(patched));

  const list = (await call('GET', '/api/knowledge-intake/batches/' + batchId + '/revisions')).body.data;
  const change = list.revisions[0].changes[0];
  assert.notEqual(change.rowId, 'u-old-utterance', 'rowId 已 remap');
  assert.equal(change.stale, false, 'remap 后行仍可寻址');
  assert.equal(change.liveStatus, 'pending');
  await call('DELETE', '/api/knowledge-intake/batches/' + batchId);
});
