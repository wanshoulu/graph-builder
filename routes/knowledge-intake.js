'use strict';

/**
 * 知识导入与审核工作台 — 服务端路由（/api/knowledge-intake/*）
 *
 * 定位：图谱构建的前置工序。业务人员按《意图图谱知识导入模板》填写 Excel
 * （三张分表或「一体化填写」单表，二选一，系统按 schema 归并成一棵业务树），
 * 本模块完成：多 sheet 解析 → 契约校验 → 候选知识层 → 人工审核（业务域→子域→意图→说法 一棵树）→
 * LLM 扩展问补全 → 审核通过后合并进意图图谱草稿（复用 org-graph 的 load/validate/save 与发布审批流）。
 *
 * 存储：data/knowledge-intake/<batchId>/batch.json（目录即索引，与 graphs/org 惯例一致）。
 * 状态语义（两段式，v3 起：必须区分「业务侧/AI 建议」与「平台人工确认」，不能混）：
 *   pending（待确认）→ 默认。Excel 的 启用/生效/已审核 只是业务侧编写状态（存 sourceStatus 留参考），
 *                      LLM 高置信度也只是 AI 建议（存 autoApproved 标志），两者都不等于平台确认；
 *   approved（已确认）→ 只能由审核人在平台上显式确认（review approve）产生，可入图；
 *   rejected（驳回）→ 不入图仅留痕；Excel 的 停用/驳回 落这里，审核人可重审拉回。
 *
 * LLM 补全：代理 graph-builder-agent（openjiuwen 底座）的 POST /v1/utterance-expansion，
 * 生成的扩展问以「LLM生成 + 置信度 + pending + autoApproved/autoRejected 建议标志」落入候选层等待人工确认。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const XLSX = require('xlsx');
const formidable = require('formidable');
const { authenticate } = require('../middleware/auth');
const { callLLMJson } = require('../tools/llm-client');

const INTAKE_DIR = process.env.KNOWLEDGE_INTAKE_DIR || path.join(__dirname, '..', 'data', 'knowledge-intake');
const BUILDER_AGENT_URL = (process.env.BUILDER_AGENT_URL || 'http://graph-builder-agent:18131').replace(/\/+$/, '');

const FUNC_SHEET = '1-业务功能分类';
const INTENT_SHEET = '2-意图清单';
const UTTER_SHEET = '3-说法库';
// 一体化填写（可选）：不想分三张表时，一张平铺表一行一条说法，系统按 schema 归并成业务树
const FLAT_SHEET = '一体化填写';

const CLIENT_CLASSES = ['个人客户', '对公客户', '小微客户', '不区分'];
const SECURITY_LEVELS = ['L1-公开', 'L2-内部', 'L3-敏感', 'L4-机密'];
const FUNC_STATUSES = ['启用', '停用'];
const INTENT_TYPES = ['查询', '办理', '管理', '咨询', '投诉', '营销', '取消', '转账', '还款'];
const ANSWER_FORMS = ['话术答复', '数据卡片', '跳转办理', '转人工'];
const HEAT_LEVELS = ['P0-高频', 'P1-中频', 'P2-低频'];
const INTENT_STATUSES = ['草稿', '生效', '停用'];
const UTTER_KINDS = ['标问', '扩展问'];
const UTTER_SOURCES = ['人工编写', '存量导入', '客服挖掘', 'LLM生成'];
const UTTER_STATUSES = ['已审核', '候选', '驳回'];

// ── 意图图谱架构 schema 对齐枚举（与前端 constants.tsx 同步） ──
const DOMAINS = ['首页', '账户管理', '转账服务', '支付管理', '信用卡', '贷款服务', '财富管理', '网点服务', '权益服务', '民生服务', '生活服务', '金融助手', '客户专享', '企业服务'];
const ACTIONS = ['ASK-询问', 'QUERY-查询', 'DO-执行', 'CHANGE-变更', 'CANCEL-取消', 'HELP-帮助', 'TRANSFER-转账', 'REPAY-还款'];
const SOURCE_ACTIONS = ['QUERY-查询', 'CREATE-创建', 'UPDATE-更新', 'APPLY-申请', 'EXPLAIN-说明'];
const EXECUTION_MODES = ['read-execute-读执行', 'confirm-required-确认后执行', 'knowledge-only-知识应答', 'multi_intent-多意图'];
const RISK_LEVELS = ['L0-无风险', 'L1-低风险', 'L2-中风险', 'L3-高风险'];
const READINESS_LEVELS = ['ready-就绪', 'planned-规划中'];
const LIFECYCLES = ['active-活跃', 'inactive-非活跃', 'deprecated-已废弃'];
const ORCHESTRATION_MODES = ['deterministic-确定式', 'agent-智能体'];
const BOOLEAN_ENUMS = ['true-是', 'false-否'];
const TASK_MODES = ['single-单意图', 'multi-多意图', 'batch-批量'];

// Excel 业务口径 → 意图图谱 intent_type 枚举（ASK/QUERY/DO/CHANGE/CANCEL/HELP/TRANSFER/REPAY）
const INTENT_TYPE_MAP = { 查询: 'QUERY', 办理: 'DO', 管理: 'CHANGE', 咨询: 'ASK', 投诉: 'HELP', 营销: 'ASK', 取消: 'CANCEL', 转账: 'TRANSFER', 还款: 'REPAY' };
// 答案形态 → 意图图谱 fulfillment_kind 枚举（unconfigured/answer/query/menu/skill/workflow/agent）
// 数据卡片=查询结果渲染故归 query；跳转办理=跳功能菜单/页面故归 menu；转人工=人工坐席接管，agent 为枚举中最近项
const FULFILLMENT_KIND_MAP = { 话术答复: 'answer', 数据卡片: 'query', 跳转办理: 'menu', 转人工: 'agent' };

// 从 VALUE-LABEL 格式中提取 VALUE 部分（如 'read-execute-读执行' → 'read-execute'）
function parseEnumValue(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  // 匹配已知的 V4.1 枚举前缀（字母/下划线/连字符词组），后面跟 '-' 和中文。
  // 枚举合法值见模板（如 execution_mode: read-execute / confirm-required / knowledge-only / multi_intent），
  // 前缀本身含 '-'，因此先用完整候选匹配，再退回单段匹配。
  const known = ['read-execute', 'confirm-required', 'knowledge-only', 'multi_intent'];
  for (const cand of known) {
    if (s === cand || s.startsWith(cand + '-')) return cand;
  }
  const m = s.match(/^([a-z_]+)-/);
  return m ? m[1] : s;
}
// 执行模式 → fulfillment_kind 推导（当 answerForm 未填时回退使用）
function deriveFulfillmentKind(execMode, answerForm) {
  if (answerForm && FULFILLMENT_KIND_MAP[answerForm]) return FULFILLMENT_KIND_MAP[answerForm];
  const v = parseEnumValue(execMode);
  if (v === 'knowledge-only') return 'answer';
  if (v === 'read-execute') return 'query';
  if (v === 'confirm-required') return 'skill';
  if (v === 'multi_intent') return 'workflow';
  return 'unconfigured';
}
// intent_type → action_code 映射（V4.1 ACTION_CODES）
const ACTION_CODE_MAP = { ASK: 'ask', QUERY: 'query', DO: 'apply', CHANGE: 'change', CANCEL: 'cancel', HELP: 'guide', TRANSFER: 'transfer', REPAY: 'repay' };
// Excel 状态 → 候选层状态（两段式：业务侧「已审核」只是参考排位，一律进待确认，人工在平台上确认才算数）
const FUNC_STATUS_MAP = { 启用: 'pending', 停用: 'rejected' };
const INTENT_STATUS_MAP = { 生效: 'pending', 草稿: 'pending', 停用: 'rejected' };
const UTTER_STATUS_MAP = { 已审核: 'pending', 候选: 'pending', 驳回: 'rejected' };
// sourceStatus 属于这三个的业务侧「已编写确认」口径，前端据此显示「Excel已审核」参考标签并排前
const BIZ_CONFIRMED_SOURCE = new Set(['启用', '生效', '已审核']);

const MAX_PATH_SEGMENTS = 4;
const MAX_EXPAND_INTENTS = 5;
const MAX_EXPAND_COUNT = 10;
const MAX_CONFLICT_INTENTS = 10;
const EXPAND_TIMEOUT_MS = 120000;
// 置信度分层路由（调研：Label Studio / Kili 的 confidence-based routing）：
// ≥ AUTO_APPROVE 自动通过进候选入图池；< AUTO_REJECT 自动挂起；中间带留给人工
const AUTO_APPROVE_CONFIDENCE = Number(process.env.KI_AUTO_APPROVE_CONFIDENCE || 0.9);
const AUTO_REJECT_CONFIDENCE = Number(process.env.KI_AUTO_REJECT_CONFIDENCE || 0.5);

function classifyConfidence(confidence) {
  const value = Number(confidence);
  if (Number.isFinite(value) && value >= AUTO_APPROVE_CONFIDENCE) {
    return { status: 'approved', note: 'AI 建议通过：置信度 ' + value + ' ≥ ' + AUTO_APPROVE_CONFIDENCE + '，待人工确认' };
  }
  if (Number.isFinite(value) && value < AUTO_REJECT_CONFIDENCE) {
    return { status: 'rejected', note: 'AI 建议驳回：置信度 ' + value + ' < ' + AUTO_REJECT_CONFIDENCE + '，需人工复查' };
  }
  return { status: 'pending', note: '' };
}

// 旧批次数据迁移：v3 之前 Excel 已审核/LLM 自动通过会直接落 status=approved，
// 与两段式语义冲突。读取时统一归一：没有真人审核记录的 approved 一律降回 pending。
function normalizeBatchStatuses(batch) {
  let demoted = 0;
  ['functions', 'intents', 'utterances'].forEach((kind) => {
    ((batch.rows && batch.rows[kind]) || []).forEach((row) => {
      if (row.status === 'approved' && (!row.reviewedBy || row.reviewedBy === 'auto')) {
        row.status = 'pending';
        demoted += 1;
      }
    });
  });
  return demoted;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function sha12(text) {
  return crypto.createHash('sha1').update(String(text), 'utf8').digest('hex').slice(0, 12);
}

function fail(code, message, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode || 400;
  throw error;
}

function sendJson(res, statusCode, value) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json;charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

function readJsonBody(req, maxBytes) {
  const limit = Number(maxBytes || 8 * 1024 * 1024);
  return new Promise((resolve, reject) => {
    const parts = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) reject(Object.assign(new Error('请求体过大'), { code: 'REQUEST_TOO_LARGE', statusCode: 413 }));
      parts.push(chunk);
    });
    req.on('end', () => {
      try {
        const body = Buffer.concat(parts).toString('utf8');
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(Object.assign(new Error('JSON 请求体无效'), { code: 'REQUEST_JSON_INVALID', statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

// ── 候选层存储 ──────────────────────────────────────────────────────────────

function assertBatchId(batchId) {
  if (!/^[A-Za-z0-9-]{6,64}$/.test(String(batchId || ''))) {
    fail('KNOWLEDGE_INTAKE_BATCH_ID_INVALID', '批次 ID 不合法', 400);
  }
  return batchId;
}

function batchPath(batchId) {
  return path.join(INTAKE_DIR, assertBatchId(batchId), 'batch.json');
}

function journalPath(batchId) {
  return path.join(INTAKE_DIR, assertBatchId(batchId), 'apply-journal.json');
}

function loadBatch(batchId) {
  try {
    const batch = JSON.parse(fs.readFileSync(batchPath(batchId), 'utf8'));
    normalizeBatchStatuses(batch);
    return batch;
  } catch (error) {
    if (error.code === 'KNOWLEDGE_INTAKE_BATCH_NOT_FOUND') throw error;
    fail('KNOWLEDGE_INTAKE_BATCH_NOT_FOUND', '批次不存在：' + batchId, 404);
  }
}

function saveBatch(batch) {
  const dir = path.join(INTAKE_DIR, batch.batchId);
  ensureDir(dir);
  // 在线编辑写频升高：临时文件 + 原子替换，避免进程中断留下半个 batch.json
  const file = path.join(dir, 'batch.json');
  const tmp = file + '.tmp-' + crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(tmp, JSON.stringify(batch, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function listBatches() {
  ensureDir(INTAKE_DIR);
  return fs.readdirSync(INTAKE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      try {
        const batch = JSON.parse(fs.readFileSync(path.join(INTAKE_DIR, entry.name, 'batch.json'), 'utf8'));
        normalizeBatchStatuses(batch);
        return summarizeBatch(batch);
      } catch (error) {
        return { batchId: entry.name, broken: true, message: error.message };
      }
    })
    .sort((a, b) => String(b.importedAt || '').localeCompare(String(a.importedAt || '')));
}

function summarizeBatch(batch) {
  const counts = {};
  ['functions', 'intents', 'utterances'].forEach((kind) => {
    const rows = (batch.rows && batch.rows[kind]) || [];
    counts[kind] = { total: rows.length, approved: 0, pending: 0, rejected: 0 };
    rows.forEach((row) => {
      if (counts[kind][row.status] !== undefined) counts[kind][row.status] += 1;
    });
  });
  return {
    batchId: batch.batchId,
    fileName: batch.fileName,
    importedBy: batch.importedBy,
    importedAt: batch.importedAt,
    domain: batch.domain || '',
    srcBatchId: batch.srcBatchId || '',
    counts,
    hasJournal: fs.existsSync(journalPath(batch.batchId)),
    revisions: { total: (batch.revisions || []).length, open: revisionOpenCount(batch) },
  };
}

// ── 修订（track changes）：一次 AI/人工动作产生的变更集，修订审阅面板逐条采纳/放弃 ──
// op:'add'（AI 增补，落 pending 行，采纳=人工确认生效）；op:'modify'（人工编辑审计，保存前已弹 diff 确认）
function createRevision(batch, type, title, changes, createdBy) {
  batch.revisions = batch.revisions || [];
  const revision = {
    revId: 'rev-' + crypto.randomBytes(6).toString('hex'),
    type,
    title,
    createdAt: new Date().toISOString(),
    createdBy: createdBy || '',
    changes: (changes || []).map((change) => Object.assign({ resolution: 'pending' }, change)),
  };
  batch.revisions.push(revision);
  return revision;
}

function revisionOpenCount(batch) {
  return (batch.revisions || []).filter((rev) => (rev.changes || []).some((change) => change.resolution === 'pending')).length;
}

// 行改名/迁移会重算内容寻址 rowId：修订里的引用同步换新，避免修订审阅悬空
function remapRevisionRowIds(batch, idMoves) {
  const moveMap = new Map((idMoves || []).map((m) => [m.oldId, m.newId]));
  if (!(batch.revisions || []).length || !moveMap.size) return;
  batch.revisions.forEach((rev) => {
    (rev.changes || []).forEach((change) => {
      if (moveMap.has(change.rowId)) change.rowId = moveMap.get(change.rowId);
    });
  });
}

function allRows(batch) {
  const rows = batch.rows || {};
  // rowType = 候选层行类别（functions/intents/utterances），不与说法行自身的 kind（标问/扩展问）冲突
  return ['functions', 'intents', 'utterances'].flatMap((kind) => (rows[kind] || []).map((row) => Object.assign({}, row, { rowType: kind })));
}

/**
 * 骨架树（三步法第 1 步的主审核视图，一体化）：业务域 → 子域 → 意图 → 说法。
 * 说法是意图的叶子节点——功能/意图/说法在同一棵树上一次审完，不再分表分页签；
 * 意图节点同时带 utteranceCount 供折叠态总览。status 过滤在构建前生效。
 * 挂不上父节点的意图/说法进 orphans（业务上=骨架有洞，需人工处理）。
 */
function buildBatchTree(batch, statusFilter) {
  const matches = (status) => !statusFilter || status === statusFilter;
  // Pass 1 用全量行建树：父子挂接与孤儿判定只看数据本身。
  // 若按视图先过滤，确认过的中层节点会让其待审子级"消失"成孤儿——逐层审核流程下这是致命的。
  const funcs = (batch.rows && batch.rows.functions || []).slice().sort((a, b) => a.path.localeCompare(b.path));
  const intents = batch.rows && batch.rows.intents || [];
  const utterances = batch.rows && batch.rows.utterances || [];

  const nodeByPath = new Map();
  const roots = [];
  funcs.forEach((row) => {
    const node = {
      key: row.rowId,
      rowId: row.rowId,
      rowType: 'functions',
      name: row.name || row.path.split('/').pop(),
      path: row.path,
      status: row.status,
      sourceStatus: row.sourceStatus || '',
      bizConfirmed: BIZ_CONFIRMED_SOURCE.has(row.sourceStatus),
      children: [],
    };
    nodeByPath.set(row.path, node);
    const segments = row.path.split('/');
    const parent = segments.length > 1 ? nodeByPath.get(segments.slice(0, -1).join('/')) : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
  });

  const funcPaths = new Set(funcs.map((row) => row.path));
  const uttCountByRef = new Map();
  utterances.forEach((row) => {
    if (!matches(row.status)) return;
    uttCountByRef.set(row.intentRef, (uttCountByRef.get(row.intentRef) || 0) + 1);
  });

  const orphans = [];
  const intentNodeByRef = new Map();
  const refSet = new Set(intents.map((row) => row.ref));
  intents.forEach((row) => {
    const node = {
      key: row.rowId,
      rowId: row.rowId,
      rowType: 'intents',
      name: row.name,
      path: row.ref,
      intentType: row.intentType,
      status: row.status,
      sourceStatus: row.sourceStatus || '',
      bizConfirmed: BIZ_CONFIRMED_SOURCE.has(row.sourceStatus),
      aiSuggested: !!row.autoApproved,
      conflict: row.conflict ? row.conflict.verdict : undefined,
      utteranceCount: uttCountByRef.get(row.ref) || 0,
      children: [],
    };
    const parent = nodeByPath.get(row.funcPath);
    if (parent && funcPaths.has(row.funcPath)) parent.children.push(node);
    else orphans.push(Object.assign({ reason: '所属功能不在本批次：' + row.funcPath }, node));
    intentNodeByRef.set(row.ref, node);
  });
  utterances.forEach((row) => {
    const parent = intentNodeByRef.get(row.intentRef);
    if (parent) {
      parent.children.push({
        key: row.rowId,
        rowId: row.rowId,
        rowType: 'utterances',
        name: row.text,
        path: row.intentRef,
        kind: row.kind,
        source: row.source,
        confidence: row.confidence,
        status: row.status,
        sourceStatus: row.sourceStatus || '',
        bizConfirmed: BIZ_CONFIRMED_SOURCE.has(row.sourceStatus),
        aiSuggested: !!row.autoApproved,
        conflict: row.conflict ? row.conflict.verdict : undefined,
        children: [],
      });
      return;
    }
    if (!refSet.has(row.intentRef)) {
      orphans.push({
        key: row.rowId,
        rowId: row.rowId,
        rowType: 'utterances',
        name: row.text,
        path: row.intentRef,
        status: row.status,
        sourceStatus: row.sourceStatus || '',
        reason: '所属意图不在本批次：' + row.intentRef,
      });
    }
  });

  // Pass 2：视图过滤 = 保留命中行及其祖先链；未命中但有命中后代的祖先标 contextOnly（前端置灰、不进审核队列）
  if (statusFilter) {
    const prune = (node) => {
      node.children = node.children.filter(prune);
      const hit = matches(node.status);
      if (!hit && node.children.length) node.contextOnly = true;
      return hit || node.children.length > 0;
    };
    for (let i = roots.length - 1; i >= 0; i--) if (!prune(roots[i])) roots.splice(i, 1);
    for (let i = orphans.length - 1; i >= 0; i--) if (!matches(orphans[i].status)) orphans.splice(i, 1);
  }

  return {
    batchId: batch.batchId,
    roots,
    orphans,
    counts: summarizeBatch(batch).counts,
    assist: summarizeAssist(batch),
  };
}

// ── AI 骨架助手（三步法第 1 步：查漏/语义去重/规范化/歧义标注，全部是建议，人工裁决） ──

const ASSIST_KINDS = ['gaps', 'duplicates', 'naming', 'ambiguities'];
const ASSIST_LABEL = { gaps: '查漏建议', duplicates: '疑似重复', naming: '命名规范', ambiguities: '歧义风险' };

// ── 节点级字段内容审核（Word 式逐字段审核）：字段定义与前端 detail-fields.ts 同源 ──

const NODE_REVIEW_FIELDS = {
  functions: [
    { key: 'name', label: '功能名称', hint: '需与功能全路径末段一致' },
    { key: 'path', label: '功能全路径', hint: '点分路径' },
    { key: 'description', label: '业务描述', hint: '至少10字，按三段式写：面向谁+做什么+产出什么' },
    { key: 'domain', label: '业务域', hint: '该功能所属的业务大类', options: DOMAINS },
    { key: 'menuKey', label: '菜单键', hint: '系统定位菜单页面的标识，点分格式' },
    { key: 'clientClass', label: '客户分类', hint: '面向的客户类型', options: ['个人客户', '对公客户', '小微客户', '不区分'] },
    { key: 'securityLevel', label: '安全分级', hint: '信息密级分级（L1-L4），与意图的风险等级是不同维度', options: ['L1-公开', 'L2-内部', 'L3-敏感', 'L4-机密'] },
    { key: 'department', label: '责任部门', hint: '负责维护该功能的团队' },
    { key: 'status', label: '业务状态', readKey: 'sourceStatus', hint: '业务侧的启用/停用状态，不等于平台确认', options: ['启用', '停用'] },
    { key: 'note', label: '备注', hint: '补充说明' },
  ],
  intents: [
    // 基本定义
    { key: 'name', label: '意图名称', hint: '面向用户视角命名，体现用户要做什么' },
    { key: 'ref', label: '意图标识', hint: '意图的唯一编码，点分格式如 xxx.yyy_zzz。留空时系统自动按路径和名称生成' },
    { key: 'funcPath', label: '所属功能全路径', hint: '需已登记的功能路径，点分格式' },
    { key: 'domain', label: '业务域', hint: '该意图所属的业务大类。系统按此匹配用户当前所在页面', options: DOMAINS },
    { key: 'menuKey', label: '所属菜单键', hint: '所属菜单的标识，点分格式。系统通过此值定位用户所在页面' },
    { key: 'action', label: '动作类型', hint: '该意图的动作类型：询问ASK、查询QUERY、执行DO、变更CHANGE、取消CANCEL、帮助HELP、转账TRANSFER、还款REPAY', options: ACTIONS },
    { key: 'sourceAction', label: '来源动作', hint: '该意图的来源动作类型：查询选QUERY、创建选CREATE、更新选UPDATE、申请选APPLY、说明选EXPLAIN', options: SOURCE_ACTIONS },
    { key: 'intentType', label: '业务意图类型', hint: '业务侧的意图分类口径', options: ['查询', '办理', '管理', '咨询', '投诉', '营销', '取消', '转账', '还款'] },
    { key: 'description', label: '业务描述', hint: '至少10字，按三段式写：面向谁+做什么+产出什么' },
    { key: 'goal', label: '用户目标', hint: '用户想达到的目的，一句话描述。留空时系统用业务描述代替' },
    // 召回素材
    { key: 'aliases', label: '别名列表', hint: '用户可能说的各种说法，逗号分隔，至少3个。必须围绕当前意图的实际业务编写，覆盖正式名称、口语说法、场景化表达' },
    { key: 'recallTerms', label: '召回关键词', hint: '单个关键词，逗号分隔。与别名互补，适合更短的表达。必须围绕当前意图的业务关键词' },
    { key: 'recallTermSets', label: '多词组合', hint: '多个词的组合，分号分隔组，组内逗号分隔词。当用户同时说出多个词时优先匹配。必须围绕当前意图的业务场景' },
    { key: 'negativeExamples', label: '排除说法', hint: '不应匹配到该意图的说法，逗号分隔。列出最易混淆但不应命中的查询。必须针对当前意图的易混淆场景' },
    { key: 'semanticPriority', label: '优先级权重', hint: '0-100的数字，值越大越优先。当多个意图都能匹配时，优先级高的排前面' },
    // 触发条件
    { key: 'triggerScene', label: '触发场景', hint: '描述意图在什么场景下被触发' },
    // 服务边界
    { key: 'scopeIn', label: '范围边界-包含', hint: '明确该意图覆盖的范围' },
    { key: 'scopeOut', label: '范围边界-排除', hint: '明确该意图不覆盖的范围' },
    { key: 'confusableIntents', label: '易混意图', hint: '容易混淆的其他意图名称，分号分隔' },
    { key: 'disambiguationHints', label: '消歧提示', hint: '帮助系统区分相似意图的补充说明' },
    // 执行契约
    { key: 'executionMode', label: '执行模式', hint: '该意图的执行方式：读执行=直接返回结果，确认后执行=需用户确认才操作，知识应答=返回知识内容，多意图=复合意图编排', options: EXECUTION_MODES },
    { key: 'riskLevel', label: '风险等级', hint: '涉及资金操作应选L2以上，纯查询通常L0或L1', options: RISK_LEVELS },
    { key: 'readiness', label: '就绪状态', hint: '控制该意图是否可执行：就绪=可执行，模拟=用假数据回复，规划中=暂不执行', options: READINESS_LEVELS },
    { key: 'requiredSlots', label: '必需参数', hint: '执行该意图必须收集的信息，逗号分隔' },
    { key: 'capabilityBindings', label: '系统能力绑定', hint: '对接的系统功能标识，逗号分隔。填了才能实际调用系统执行' },
    { key: 'roles', label: '涉及角色', hint: '逗号分隔，如 持卡人,收款人' },
    { key: 'businessObjects', label: '涉及业务对象', hint: '该意图涉及的业务对象，逗号分隔' },
    { key: 'businessObjectId', label: '业务对象标识', hint: '与上面业务对象一一对应的编码，逗号分隔' },
    { key: 'keySlots', label: '关键要素', hint: '该意图的关键信息要素，用业务语言描述' },
    { key: 'answerForm', label: '答案形态', hint: '回复用户的形式：话术答复=文字回复，数据卡片=结构化展示，跳转办理=跳转到操作页，转人工=交给客服', options: ['话术答复', '数据卡片', '跳转办理', '转人工'] },
    { key: 'heat', label: '热度', hint: 'P0高频/P1中频/P2低频，用于排序和资源分配', options: ['P0-高频', 'P1-中频', 'P2-低频'] },
    // 策略配置
    { key: 'taskPolicyShapes', label: '结果展示形式', hint: '执行结果的展示形式，逗号分隔' },
    { key: 'taskPolicyMode', label: '任务模式', hint: '单次能处理的意图数：单意图=一次一个，多意图=可同时处理多个，批量=批量处理', options: TASK_MODES },
    { key: 'taskPolicyMaxTasks', label: '最大任务数', hint: '单次最多处理的任务数，通常1-5' },
    { key: 'contextPolicyRetain', label: '追问保留上下文', hint: '用户追问时是否保留之前的对话上下文', options: BOOLEAN_ENUMS },
    { key: 'contextPolicySwitch', label: '允许中途切换', hint: '执行过程中是否允许用户切换到另一个意图', options: BOOLEAN_ENUMS },
    { key: 'contextPolicyResumable', label: '中断后可恢复', hint: '中断后是否可以恢复之前的操作', options: BOOLEAN_ENUMS },
    { key: 'responsePolicy', label: '响应策略', hint: '回复策略，如返回查询结果或跳转菜单' },
    { key: 'orchestrationMode', label: '编排模式', hint: '确定式=按固定流程执行，智能体=由AI自主决策执行路径', options: ORCHESTRATION_MODES },
    // 治理信息
    { key: 'status', label: '业务状态', readKey: 'sourceStatus', hint: '业务侧的审核状态（草稿/生效/停用），不等于平台确认', options: ['草稿', '生效', '停用'] },
    { key: 'lifecycle', label: '生命周期', hint: '该意图的当前阶段：活跃=正常使用，规划中=计划但未实现，已废弃=不再使用，已下线=完全停用', options: LIFECYCLES },
    { key: 'semanticVersion', label: '语义版本', hint: '版本号，如1.0.0。用于追踪变更' },
    { key: 'owner', label: '负责团队', hint: '负责维护该意图的团队' },
    { key: 'sourceChannel', label: '来源渠道', hint: '该意图的来源渠道' },
    { key: 'sourceMenuId', label: '来源菜单ID', hint: '来源菜单的标识' },
    { key: 'sourceActionId', label: '来源动作ID', hint: '来源动作的标识' },
    { key: 'code', label: '意图编码', hint: '业务侧编码（选填）' },
    { key: 'note', label: '备注', hint: '补充说明' },
  ],
  utterances: [
    { key: 'text', label: '说法文本', hint: '用户真实表达，2~50字，标问=作为精确匹配素材，扩展问=补充更多表达帮助召回' },
    { key: 'kind', label: '说法类型', hint: '标问=作为精确匹配素材，扩展问=补充更多表达帮助召回', options: ['标问', '扩展问'] },
    { key: 'intentRef', label: '意图标识', hint: '需已登记的意图ref，点分格式' },
    { key: 'source', label: '来源', hint: '说法的来源渠道', options: ['人工编写', '存量导入', '客服挖掘', 'LLM生成'] },
    { key: 'confidence', label: '置信度', hint: '0-1的数字，表示这条说法的可靠程度，仅作参考' },
    { key: 'status', label: '业务状态', readKey: 'sourceStatus', hint: '业务侧审核状态（已审核/候选/驳回），不等于平台确认', options: ['已审核', '候选', '驳回'] },
    { key: 'reviewNote', label: '审核意见', hint: '业务状态为驳回时必填' },
    { key: 'note', label: '备注', hint: '补充说明' },
  ],
};

const NODE_TYPE_LABEL = { functions: '功能', intents: '意图', utterances: '说法' };

// 分组映射：groupKey → 字段 key 列表（与前端 detail-fields.ts 一致）
const NODE_REVIEW_GROUPS = {
  functions: {
    base: ['name', 'path', 'description', 'domain', 'menuKey'],
    scope: ['clientClass', 'securityLevel', 'department'],
    gov: ['status', 'note'],
  },
  intents: {
    base: ['name', 'ref', 'funcPath', 'domain', 'menuKey', 'action', 'sourceAction', 'intentType', 'description', 'goal'],
    recall: ['aliases', 'recallTerms', 'recallTermSets', 'negativeExamples', 'semanticPriority'],
    trigger: ['triggerScene'],
    boundary: ['scopeIn', 'scopeOut', 'confusableIntents', 'disambiguationHints'],
    contract: ['executionMode', 'riskLevel', 'readiness', 'requiredSlots', 'capabilityBindings', 'roles', 'businessObjects', 'businessObjectId', 'keySlots', 'answerForm', 'heat'],
    strategy: ['taskPolicyShapes', 'taskPolicyMode', 'taskPolicyMaxTasks', 'contextPolicyRetain', 'contextPolicySwitch', 'contextPolicyResumable', 'responsePolicy', 'orchestrationMode'],
    gov: ['status', 'lifecycle', 'semanticVersion', 'owner', 'sourceChannel', 'sourceMenuId', 'sourceActionId', 'code', 'note'],
  },
  utterances: {
    content: ['text', 'kind', 'note'],
    intent: ['intentRef'],
    origin: ['source', 'confidence'],
    review: ['status', 'reviewNote'],
  },
};

function assistId(kind, payload) {
  const key = kind === 'gaps' ? payload.path + payload.name
    : kind === 'naming' ? payload.ref + payload.suggestion
    : kind === 'duplicates' || kind === 'ambiguities' ? payload.refs.slice().sort().join('|')
    : JSON.stringify(payload);
  return 'sa-' + sha12(kind + ' ' + key);
}

function summarizeAssist(batch) {
  const items = (batch.skeletonAssist && batch.skeletonAssist.items) || [];
  const byKind = {};
  ASSIST_KINDS.forEach((kind) => { byKind[kind] = { total: 0, open: 0, accepted: 0, dismissed: 0 }; });
  items.forEach((item) => {
    if (!byKind[item.kind]) return;
    byKind[item.kind].total += 1;
    if (item.status === 'suggested') byKind[item.kind].open += 1;
    else if (item.status === 'accepted') byKind[item.kind].accepted += 1;
    else if (item.status === 'dismissed') byKind[item.kind].dismissed += 1;
  });
  return { generatedAt: batch.skeletonAssist ? batch.skeletonAssist.generatedAt : null, total: items.length, byKind };
}

function buildSkeletonForAssist(batch) {
  const uttCountByRef = new Map();
  (batch.rows.utterances || []).forEach((row) => {
    uttCountByRef.set(row.intentRef, (uttCountByRef.get(row.intentRef) || 0) + 1);
  });
  const intentsByPath = new Map();
  (batch.rows.intents || []).forEach((row) => {
    if (!intentsByPath.has(row.funcPath)) intentsByPath.set(row.funcPath, []);
    intentsByPath.get(row.funcPath).push({
      ref: row.ref,
      name: row.name,
      description: row.description || '',
      intentType: row.intentType || '',
      triggerScene: row.triggerScene || '',
      scopeIn: row.scopeIn || '',
      scopeOut: row.scopeOut || '',
      roles: row.roles || '',
      executionMode: row.executionMode || '',
      riskLevel: row.riskLevel || '',
      orchestrationMode: row.orchestrationMode || '',
      lifecycle: row.lifecycle || '',
      readiness: row.readiness || '',
      utteranceCount: uttCountByRef.get(row.ref) || 0,
    });
  });
  const functions = (batch.rows.functions || []).map((row) => ({
    path: row.path,
    description: row.description || '',
    intents: intentsByPath.get(row.path) || [],
  }));
  return { functions };
}

/**
 * 采纳 AI 建议时落到候选层的变更（仍全部进 pending，等人工在树上确认——两段式不破）：
 *   gaps(intent) → 新建意图行；gaps(subdomain) → 新建功能行；
 *   naming → 重命名意图行并重接其说法 ref；
 *   duplicates(merge) → 说法从重复意图重接到主意图，重复意图行置驳回；
 *   ambiguities → 仅记录裁决（边界改写由人工在骨架上完成）。
 */
function applyAssistSuggestion(batch, item, reviewedBy, now) {
  const payload = item.payload;
  if (item.kind === 'gaps' && payload.type === 'intent') {
    const ref = payload.path + '/' + payload.name;
    if ((batch.rows.intents || []).some((row) => row.ref === ref)) return { applied: false, reason: '同名意图已存在' };
    const row = {
      rowId: 'i-' + sha12(ref),
      name: payload.name,
      funcPath: payload.path,
      ref,
      intentType: '查询',
      description: payload.description || payload.reason || 'AI 建议补充的意图',
      businessObjects: '',
      keySlots: '',
      triggerScene: '',
      scopeIn: '',
      scopeOut: '',
      roles: '',
      answerForm: '话术答复',
      heat: 'P2-低频',
      executionMode: 'read-execute-读执行',
      riskLevel: 'L0-无风险',
      orchestrationMode: 'deterministic-确定式',
      lifecycle: 'active-活跃',
      readiness: 'ready-就绪',
      status: 'pending',
      sourceStatus: 'AI建议新增',
      aiSuggested: true,
      code: '',
      note: 'AI 骨架助手查漏建议：' + (payload.reason || ''),
      generatedAt: now,
    };
    batch.rows.intents = batch.rows.intents || [];
    batch.rows.intents.push(row);
    return { applied: true, created: row.rowId };
  }
  if (item.kind === 'gaps' && payload.type === 'subdomain') {
    const path = payload.path.includes('/') ? payload.path : payload.path;
    if ((batch.rows.functions || []).some((row) => row.path === path)) return { applied: false, reason: '同名功能已存在' };
    const segments = path.split('/');
    const row = {
      rowId: 'f-' + sha12(path),
      path,
      name: segments[segments.length - 1],
      description: payload.description || payload.reason || 'AI 建议补充的子域',
      clientClass: '个人客户',
      securityLevel: 'L2-内部',
      department: '',
      status: 'pending',
      sourceStatus: 'AI建议新增',
      aiSuggested: true,
      note: 'AI 骨架助手查漏建议：' + (payload.reason || ''),
      generatedAt: now,
    };
    batch.rows.functions = batch.rows.functions || [];
    batch.rows.functions.push(row);
    return { applied: true, created: row.rowId };
  }
  if (item.kind === 'naming') {
    const row = (batch.rows.intents || []).find((r) => r.ref === payload.ref);
    if (!row) return { applied: false, reason: '意图行不存在（可能已被处理）' };
    const oldName = row.name;
    const newRef = row.funcPath + '/' + payload.suggestion;
    if ((batch.rows.intents || []).some((r) => r.ref === newRef && r.rowId !== row.rowId)) {
      return { applied: false, reason: '目标名称已存在' };
    }
    row.aiRenamedFrom = oldName;
    row.name = payload.suggestion;
    row.ref = newRef;
    row.rowId = 'i-' + sha12(newRef);
    (batch.rows.utterances || []).forEach((u) => {
      if (u.intentRef === payload.ref) {
        u.intentRef = newRef;
        u.rowId = 'u-' + sha12(newRef + ' ' + u.kind + ' ' + u.text);
      }
    });
    return { applied: true, renamed: row.rowId };
  }
  if (item.kind === 'duplicates' && payload.suggestion === 'merge') {
    const [primaryRef, dupRef] = payload.refs;
    const primary = (batch.rows.intents || []).find((r) => r.ref === primaryRef);
    const dup = (batch.rows.intents || []).find((r) => r.ref === dupRef);
    if (!primary || !dup) return { applied: false, reason: '意图行不存在（可能已被处理）' };
    (batch.rows.utterances || []).forEach((u) => {
      if (u.intentRef === dupRef) {
        u.intentRef = primaryRef;
        u.rowId = 'u-' + sha12(primaryRef + ' ' + u.kind + ' ' + u.text);
      }
    });
    dup.status = 'rejected';
    dup.reviewedBy = reviewedBy;
    dup.reviewedAt = now;
    dup.reviewNote = '与「' + primary.name + '」语义重复，AI 建议合并，说法已并入该意图';
    return { applied: true, mergedInto: primaryRef, rejected: dup.rowId };
  }
  return { applied: true, recorded: true };
}

/**
 * 第 1 步验收报告（确定性本地计算，不依赖 LLM）：覆盖度 / 边界 / 命名 / 完整性 / 语义一致性。
 * 前四维 0~100 分 + 问题清单；分数 = 有问题的骨架单元占比的补数。
 * 一致性聚合 LLM 冲突预检的落盘结果（row.conflict）：跑过预检才计分；一条都没跑时
 * score=null，不计入综合分与 ready，只提示先跑预检——避免高分报告掩盖未做的冲突检查。
 */
function buildAcceptanceReport(batch) {
  const functions = batch.rows.functions || [];
  const intents = batch.rows.intents || [];
  const utterances = batch.rows.utterances || [];

  const uttsByRef = new Map();
  utterances.forEach((row) => {
    if (!uttsByRef.has(row.intentRef)) uttsByRef.set(row.intentRef, []);
    uttsByRef.get(row.intentRef).push(row);
  });
  const intentsByPath = new Map();
  intents.forEach((row) => {
    if (!intentsByPath.has(row.funcPath)) intentsByPath.set(row.funcPath, []);
    intentsByPath.get(row.funcPath).push(row);
  });

  const dimension = (issues, unitCount) => ({
    score: unitCount ? Math.max(0, Math.round((1 - issues.length / unitCount) * 100)) : 100,
    issues,
  });

  // 覆盖度：叶子功能无意图；意图无标问；意图说法不足
  const leafPaths = functions.filter((row) => !functions.some((other) => other.path !== row.path && other.path.startsWith(row.path + '/'))).map((row) => row.path);
  const coverageIssues = [];
  leafPaths.forEach((path) => {
    if (!intentsByPath.has(path)) coverageIssues.push({ level: 'error', unit: path, message: '叶子功能下没有任何意图' });
  });
  intents.forEach((row) => {
    const list = uttsByRef.get(row.ref) || [];
    if (!list.some((u) => u.kind === '标问')) coverageIssues.push({ level: 'warn', unit: row.ref, message: '意图没有标问' });
    else if (list.length < 5) coverageIssues.push({ level: 'info', unit: row.ref, message: `说法仅 ${list.length} 条（建议 ≥5）` });
  });
  const coverageUnits = leafPaths.length + intents.length || 1;

  // 边界：范围边界两列缺失；同名/包含关系意图未互指排除
  const boundaryIssues = [];
  intents.forEach((row) => {
    if (!(row.scopeOut || '').trim()) boundaryIssues.push({ level: 'warn', unit: row.ref, message: '「范围边界-排除」为空：写不出排除内容的意图往往边界过宽' });
    if (!(row.scopeIn || '').trim()) boundaryIssues.push({ level: 'info', unit: row.ref, message: '「范围边界-包含」为空' });
    if (!(row.triggerScene || '').trim()) boundaryIssues.push({ level: 'info', unit: row.ref, message: '触发场景为空' });
  });
  intents.forEach((row) => {
    intents.forEach((other) => {
      if (other.ref <= row.ref) return;
      const nameAlike = row.name.includes(other.name) || other.name.includes(row.name);
      const sameParent = row.funcPath === other.funcPath;
      if (nameAlike && sameParent && !(row.scopeOut || '').includes(other.name) && !(other.scopeOut || '').includes(row.name)) {
        boundaryIssues.push({ level: 'warn', unit: row.ref, message: `与「${other.name}」名称相近且未在排除列互指，疑似边界含混` });
      }
    });
  });
  const boundaryUnits = intents.length || 1;

  // 命名：动宾短语（动词白名单开头）；黑话/字母数字；同名跨路径；过长
  const NAMING_VERBS = ['查询', '办理', '修改', '申请', '设置', '开通', '关闭', '取消', '订阅', '投诉', '咨询', '管理', '兑换', '领取', '还款', '转账', '汇款', '注销', '挂失', '解挂', '开户', '销户', '签约', '解约', '绑定', '解绑', '认证', '激活', '领取', '购买', '赎回', '定制', '推荐', '提醒', '反馈', '申诉', '预约', '变更', '解除', '打印', '下载', '复制', '分享'];
  const namingIssues = [];
  const nameCount = new Map();
  intents.forEach((row) => nameCount.set(row.name, (nameCount.get(row.name) || 0) + 1));
  intents.forEach((row) => {
    if (!NAMING_VERBS.some((verb) => row.name.startsWith(verb))) {
      namingIssues.push({ level: 'error', unit: row.ref, message: `「${row.name}」不是动宾短语（查询××/办理××/修改××…），业务人员看不懂它管什么` });
    }
    if (/[A-Za-z0-9]/.test(row.name)) namingIssues.push({ level: 'warn', unit: row.ref, message: `「${row.name}」含字母/数字/内部黑话` });
    if (row.name.length > 12) namingIssues.push({ level: 'info', unit: row.ref, message: `「${row.name}」超过 12 字，考虑拆分或简化` });
    if (nameCount.get(row.name) > 1) namingIssues.push({ level: 'error', unit: row.ref, message: `意图名「${row.name}」在多个功能下重复` });
  });
  const namingUnits = intents.length || 1;

  // 完整性：必填字段缺失/描述过短/说法重复挂载
  const completenessIssues = [];
  functions.forEach((row) => {
    if ((row.description || '').length < 20) completenessIssues.push({ level: 'warn', unit: row.path, message: '功能业务描述过短（三段式写全）' });
    if (!row.department) completenessIssues.push({ level: 'info', unit: row.path, message: '责任部门为空' });
  });
  intents.forEach((row) => {
    if ((row.description || '').length < 20) completenessIssues.push({ level: 'warn', unit: row.ref, message: '意图业务描述过短（三段式写全）' });
    if (!row.answerForm) completenessIssues.push({ level: 'error', unit: row.ref, message: '答案形态缺失' });
  });
  const textOwner = new Map();
  utterances.forEach((row) => {
    if (textOwner.has(row.text) && textOwner.get(row.text) !== row.intentRef) {
      completenessIssues.push({ level: 'error', unit: row.intentRef, message: `说法「${row.text}」同时挂在多个意图下（歧义）` });
    } else {
      textOwner.set(row.text, row.intentRef);
    }
  });

  // 跨意图别名去重：同一说法被多个意图认领时全部丢弃（歧义说法交给下游裁决层）
  const aliasOwner = new Map();
  intents.forEach((row) => {
    const list = (row.aliases || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    list.forEach((alias) => {
      if (aliasOwner.has(alias) && aliasOwner.get(alias) !== row.ref) {
        completenessIssues.push({ level: 'error', unit: row.ref, message: `别名「${alias}」同时出现在多个意图下（歧义，应删除或交给下游裁决）` });
      } else {
        aliasOwner.set(alias, row.ref);
      }
    });
  });

  // 描述唯一性：active 意图描述跨意图重复会稀释向量空间
  const descOwners = new Map();
  intents.forEach((row) => {
    const desc = (row.description || '').trim();
    if (!desc) return;
    if (!descOwners.has(desc)) descOwners.set(desc, []);
    descOwners.get(desc).push(row.ref);
  });
  descOwners.forEach((refs, desc) => {
    if (refs.length > 1) {
      refs.forEach((ref) => {
        completenessIssues.push({ level: 'warn', unit: ref, message: `描述跨意图重复（稀释向量空间）：「${desc.slice(0, 30)}...」` });
      });
    }
  });

  // 操作家族覆盖：含办理/管理属性的意图必须包含操作型说法
  const OP_PATTERNS = ['怎么开通', '怎么办理', '怎么申请', '怎么设置', '怎么取消', '怎么关闭', '怎么开通', '如何开通', '如何办理', '如何申请', '如何设置', '如何取消'];
  intents.forEach((row) => {
    const intentType = (row.intentType || '').trim();
    if (intentType === '办理' || intentType === '管理') {
      const list = (row.aliases || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean);
      const hasOp = list.some((alias) => OP_PATTERNS.some((pat) => alias.includes(pat)));
      if (!hasOp && list.length > 0) {
        completenessIssues.push({ level: 'warn', unit: row.ref, message: `${intentType}类意图缺少操作型说法（怎么开通/怎么办理/怎么申请等），别名全是查询态` });
      }
    }
  });

  // 别名长度约束：2-24 字，无连续 3 位以上数字
  intents.forEach((row) => {
    const list = (row.aliases || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    list.forEach((alias) => {
      if (alias.length < 2 || alias.length > 24) {
        completenessIssues.push({ level: 'info', unit: row.ref, message: `别名「${alias}」长度${alias.length}字，不在2-24字范围` });
      }
      if (/\d{3,}/.test(alias)) {
        completenessIssues.push({ level: 'info', unit: row.ref, message: `别名「${alias}」含连续3位以上数字，影响匹配精度` });
      }
    });
  });

  const completenessUnits = functions.length + intents.length || 1;

  // 一致性：聚合语义冲突预检结果（预检按需跑，只有 conflict 落盘的说法参与本维）
  const consistencyIssues = [];
  let conflictChecked = 0;
  let conflictHits = 0;
  utterances.forEach((row) => {
    if (!row.conflict) return;
    conflictChecked += 1;
    if (row.conflict.verdict === 'conflict') {
      conflictHits += 1;
      consistencyIssues.push({
        level: 'error',
        unit: row.intentRef,
        message: `说法「${row.text}」与「${row.conflict.suspect || '已有说法'}」语义冲突：${row.conflict.reason || '业务语义打架，需人工裁决'}`,
      });
    }
  });
  const consistency = conflictChecked
    ? dimension(consistencyIssues, conflictChecked)
    : { score: null, issues: [{ level: 'warn', unit: '', message: '尚未运行语义冲突预检：本报告不含冲突维度，先到审核工作台跑一次预检' }] };

  // V4.1 合规性：检查 V4.1 新增字段在候选层行中的覆盖情况
  const v41Issues = [];
  const V41_INTENT_FIELDS = [
    { key: 'intentType', label: '意图类型', level: 'error' },
    { key: 'executionMode', label: '执行方式', level: 'error' },
    { key: 'riskLevel', label: '风险等级', level: 'warn' },
    { key: 'orchestrationMode', label: '编排模式', level: 'warn' },
    { key: 'lifecycle', label: '生命周期', level: 'info' },
    { key: 'readiness', label: '就绪状态', level: 'info' },
  ];
  intents.forEach((row) => {
    V41_INTENT_FIELDS.forEach((f) => {
      if (!row[f.key]) {
        v41Issues.push({ level: f.level, unit: row.ref, message: `V4.1 字段「${f.label}」未填写` });
      }
    });
    // 检查 requiredSlots：执行类意图应有 slot 定义
    if (['办理', '管理', '转账', '还款'].includes((row.intentType || '').trim()) && !row.requiredSlots) {
      v41Issues.push({ level: 'warn', unit: row.ref, message: '执行类意图未填写信息收集项（requiredSlots）' });
    }
    // 检查 capabilityBindings：执行类意图应有能力绑定
    if (['办理', '管理', '转账', '还款'].includes((row.intentType || '').trim()) && !row.capabilityBindings) {
      v41Issues.push({ level: 'warn', unit: row.ref, message: '执行类意图未填写系统能力绑定（capabilityBindings）' });
    }
  });
  const v41Units = intents.length || 1;

  // 模板契约预检：把「本次已确认行」按入图规则离线合并进当前图谱草稿，跑真实模板校验。
  // 目的：让验收报告的「可提交入图」与 preview-apply 的校验结果同源——验收绿 ≈ 入图能过，
  // 避免「验收 95 分 → 入图被 schema 错误拦住」的口径断层（预检失败只降分提示，不阻断预览）。
  let templateCheck = null;
  try {
    const approvedRows = {
      functions: functions.filter((row) => row.status === 'approved'),
      intents: intents.filter((row) => row.status === 'approved'),
      utterances: utterances.filter((row) => row.status === 'approved'),
    };
    if (approvedRows.functions.length || approvedRows.intents.length || approvedRows.utterances.length) {
      const templatePath = path.join(__dirname, '..', 'data', 'graph-builder-templates', 'intent-graph.json');
      const currentDoc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'graphs', 'org', 'intent', 'drafts', 'org-graph-draft.json'), 'utf8'));
      const merged = applyToIntakeDocument(currentDoc, approvedRows, batch.batchId, new Date().toISOString());
      const { validateGraph: runTemplateValidation } = require('../tools/x6-graph-template-validator');
      const templateObj = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
      const result = runTemplateValidation(templateObj, merged.document);
      templateCheck = { valid: result.valid, errors: result.errors };
      if (!result.valid) {
        result.errors.slice(0, 5).forEach((e) => {
          v41Issues.push({ level: 'error', unit: '', message: '模板契约预检：' + (e.message || e.code) + '（' + (e.code || '') + '）' });
        });
        if (result.errors.length > 5) v41Issues.push({ level: 'error', unit: '', message: '模板契约预检：还有 ' + (result.errors.length - 5) + ' 个校验错误，详见预览入图结果' });
      }
    } else {
      templateCheck = { valid: null, errors: [], note: '暂无已确认条目，预检跳过' };
    }
  } catch (error) {
    // 预检是增强能力：草稿缺失/读取失败时不影响验收报告主流程
    templateCheck = { valid: null, errors: [], note: '预检不可用：' + error.message };
  }

  const dims = {
    coverage: dimension(coverageIssues, coverageUnits),
    boundary: dimension(boundaryIssues, boundaryUnits),
    naming: dimension(namingIssues, namingUnits),
    completeness: dimension(completenessIssues, completenessUnits),
    consistency,
    v41: dimension(v41Issues, v41Units),
  };
  const scored = Object.values(dims).filter((d) => d.score !== null);
  const overall = Math.round(scored.reduce((sum, d) => sum + d.score, 0) / scored.length);
  const weakest = Math.min(...scored.map((d) => d.score));
  // 口径与文案一致：各维（一致性未预检时不计）全部 ≥90 才算可提交（均分够但短板明显时不能亮绿）
  const ready = weakest >= 90;
  const label = ready ? '可提交入图' : overall >= 70 ? '接近可用，先清问题项' : '不达标，需人工补齐骨架';
  return {
    batchId: batch.batchId,
    generatedAt: new Date().toISOString(),
    overall,
    ready,
    weakestDimension: ready ? null : Object.keys(dims).find((key) => dims[key].score === weakest) || null,
    label,
    dimensions: Object.fromEntries(Object.entries(dims).map(([key, value]) => [key, { ...value, label: { coverage: '覆盖度', boundary: '边界', naming: '命名', completeness: '完整性', consistency: '语义一致性', v41: 'V4.1合规性' }[key], ...(key === 'consistency' ? { checked: conflictChecked, conflicts: conflictHits } : {}) }])),
    templateCheck,
    counts: summarizeBatch(batch).counts,
    assist: summarizeAssist(batch),
  };
}

// ── Excel 解析与契约校验 ────────────────────────────────────────────────────

function sheetToRows(workbook, sheetName, columns) {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) fail('KNOWLEDGE_INTAKE_SHEET_MISSING', '缺少工作表「' + sheetName + '」', 400);
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  if (!matrix.length) return [];
  const headers = matrix[0].map((h) => String(h || '').trim());
  const index = {};
  columns.forEach((col) => {
    const at = headers.indexOf(col.name);
    if (at >= 0) index[col.key] = at;
  });
  const missing = columns.filter((col) => col.required && index[col.key] === undefined).map((col) => col.name);
  if (missing.length) {
    fail('KNOWLEDGE_INTAKE_COLUMNS_MISSING', '工作表「' + sheetName + '」缺少列：' + missing.join('、'), 400);
  }
  return matrix.slice(1).map((cells, offset) => {
    const row = { rowNumber: offset + 2 };
    columns.forEach((col) => {
      if (index[col.key] === undefined) {
        row[col.key] = '';
        return;
      }
      const value = cells[index[col.key]];
      row[col.key] = value === null || value === undefined ? '' : String(value).trim();
    });
    return row;
  }).filter((row) => columns.some((col) => row[col.key] !== ''));
}

const FUNC_COLUMNS = [
  { key: 'path', name: '功能全路径', required: true },
  { key: 'name', name: '功能名称', required: false },
  { key: 'description', name: '业务描述', required: true },
  { key: 'domain', name: '业务域', required: false },
  { key: 'menuKey', name: '菜单键', required: false },
  { key: 'clientClass', name: '客户分类', required: true },
  { key: 'securityLevel', name: '安全分级', required: true },
  { key: 'department', name: '责任部门', required: true },
  { key: 'status', name: '状态', required: true },
  { key: 'note', name: '备注', required: false },
];
const INTENT_COLUMNS = [
  { key: 'name', name: '意图名称', required: true },
  { key: 'funcPath', name: '所属功能全路径', required: true },
  { key: 'domain', name: '业务域', required: false },
  { key: 'menuKey', name: '所属菜单键', required: false },
  { key: 'action', name: '动作类型', required: false },
  { key: 'sourceAction', name: '来源动作', required: false },
  { key: 'intentType', name: '业务意图类型', required: true },
  { key: 'description', name: '业务描述', required: true },
  { key: 'goal', name: '用户目标', required: false },
  { key: 'aliases', name: '别名列表', required: false },
  { key: 'recallTerms', name: '召回关键词', required: false },
  { key: 'recallTermSets', name: '召回词组', required: false },
  { key: 'negativeExamples', name: '负例查询', required: false },
  { key: 'semanticPriority', name: '语义优先级', required: false },
  { key: 'triggerScene', name: '触发场景', required: false },
  { key: 'scopeIn', name: '范围边界-包含', required: false },
  { key: 'scopeOut', name: '范围边界-排除', required: false },
  { key: 'roles', name: '涉及角色', required: false },
  { key: 'confusableIntents', name: '易混意图', required: false },
  { key: 'disambiguationHints', name: '消歧提示', required: false },
  { key: 'executionMode', name: '执行模式', required: false },
  { key: 'riskLevel', name: '风险等级', required: false },
  { key: 'readiness', name: '就绪状态', required: false },
  { key: 'requiredSlots', name: '必需槽位', required: false },
  { key: 'capabilityBindings', name: '能力绑定', required: false },
  { key: 'businessObjects', name: '涉及业务对象', required: false },
  { key: 'businessObjectId', name: '业务对象标识', required: false },
  { key: 'keySlots', name: '关键要素', required: false },
  { key: 'answerForm', name: '答案形态', required: true },
  { key: 'heat', name: '热度', required: true },
  { key: 'taskPolicyShapes', name: '支持任务形态', required: false },
  { key: 'taskPolicyMode', name: '任务模式', required: false },
  { key: 'taskPolicyMaxTasks', name: '最大任务数', required: false },
  { key: 'contextPolicyRetain', name: '澄清保留上下文', required: false },
  { key: 'contextPolicySwitch', name: '允许意图切换', required: false },
  { key: 'contextPolicyResumable', name: '可恢复', required: false },
  { key: 'responsePolicy', name: '响应策略', required: false },
  { key: 'orchestrationMode', name: '编排模式', required: false },
  { key: 'status', name: '状态', required: true },
  { key: 'lifecycle', name: '生命周期', required: false },
  { key: 'semanticVersion', name: '语义版本', required: false },
  { key: 'owner', name: '负责团队', required: false },
  { key: 'sourceChannel', name: '来源渠道', required: false },
  { key: 'sourceMenuId', name: '来源菜单ID', required: false },
  { key: 'sourceActionId', name: '来源动作ID', required: false },
  { key: 'code', name: '意图编码（选填）', required: false },
  { key: 'note', name: '备注', required: false },
];
const UTTER_COLUMNS = [
  { key: 'intentRef', name: '意图标识', required: true },
  { key: 'kind', name: '说法类型', required: true },
  { key: 'text', name: '说法文本', required: true },
  { key: 'source', name: '来源', required: true },
  { key: 'confidence', name: '置信度', required: false },
  { key: 'status', name: '状态', required: true },
  { key: 'reviewNote', name: '审核意见', required: false },
  { key: 'note', name: '备注', required: false },
];
// 一体化填写：只要求「功能全路径」列必填，其余列留空时按就近向下填充/默认值归并
const FLAT_COLUMNS = [
  { key: 'path', name: '功能全路径', required: true },
  { key: 'fname', name: '功能名称', required: false },
  { key: 'fdesc', name: '功能描述', required: false },
  { key: 'clientClass', name: '客户分类', required: false },
  { key: 'securityLevel', name: '安全分级', required: false },
  { key: 'department', name: '责任部门', required: false },
  { key: 'fstatus', name: '功能状态', required: false },
  { key: 'fdomain', name: '功能业务域', required: false },
  { key: 'fmenuKey', name: '功能菜单键', required: false },
  { key: 'iname', name: '意图名称', required: false },
  { key: 'idomain', name: '意图业务域', required: false },
  { key: 'imenuKey', name: '意图菜单键', required: false },
  { key: 'iaction', name: '动作类型', required: false },
  { key: 'isourceAction', name: '来源动作', required: false },
  { key: 'intentType', name: '意图类型', required: false },
  { key: 'idesc', name: '意图描述', required: false },
  { key: 'igoal', name: '用户目标', required: false },
  { key: 'triggerScene', name: '触发场景', required: false },
  { key: 'scopeIn', name: '范围边界-包含', required: false },
  { key: 'scopeOut', name: '范围边界-排除', required: false },
  { key: 'roles', name: '涉及角色', required: false },
  { key: 'iconfusable', name: '易混意图', required: false },
  { key: 'disambiguationHints', name: '消歧提示', required: false },
  { key: 'businessObjects', name: '涉及业务对象', required: false },
  { key: 'keySlots', name: '关键要素', required: false },
  { key: 'answerForm', name: '答案形态', required: false },
  { key: 'heat', name: '热度', required: false },
  { key: 'aliases', name: '别名列表', required: false },
  { key: 'recallTerms', name: '召回关键词', required: false },
  { key: 'recallTermSets', name: '召回词组', required: false },
  { key: 'negativeExamples', name: '负例查询', required: false },
  { key: 'semanticPriority', name: '语义优先级', required: false },
  { key: 'executionMode', name: '执行模式', required: false },
  { key: 'riskLevel', name: '风险等级', required: false },
  { key: 'readiness', name: '就绪状态', required: false },
  { key: 'requiredSlots', name: '必需槽位', required: false },
  { key: 'capabilityBindings', name: '能力绑定', required: false },
  { key: 'businessObjectId', name: '业务对象标识', required: false },
  { key: 'taskPolicyShapes', name: '支持任务形态', required: false },
  { key: 'taskPolicyMode', name: '任务模式', required: false },
  { key: 'taskPolicyMaxTasks', name: '最大任务数', required: false },
  { key: 'contextPolicyRetain', name: '澄清保留上下文', required: false },
  { key: 'contextPolicySwitch', name: '允许意图切换', required: false },
  { key: 'contextPolicyResumable', name: '可恢复', required: false },
  { key: 'responsePolicy', name: '响应策略', required: false },
  { key: 'orchestrationMode', name: '编排模式', required: false },
  { key: 'lifecycle', name: '生命周期', required: false },
  { key: 'semanticVersion', name: '语义版本', required: false },
  { key: 'owner', name: '负责团队', required: false },
  { key: 'sourceChannel', name: '来源渠道', required: false },
  { key: 'sourceMenuId', name: '来源菜单ID', required: false },
  { key: 'sourceActionId', name: '来源动作ID', required: false },
  { key: 'istatus', name: '意图状态', required: false },
  { key: 'kind', name: '说法类型', required: false },
  { key: 'text', name: '说法文本', required: false },
  { key: 'source', name: '说法来源', required: false },
  { key: 'confidence', name: '置信度', required: false },
  { key: 'ustatus', name: '说法状态', required: false },
  { key: 'note', name: '备注', required: false },
];

/**
 * 一体化表 → 三张标准表（复用同一套契约校验与候选层，不产生第二套语义）：
 *   功能属性/意图属性在该实体第一行填写即可，向下填充到该实体所有行；
 *   只有功能路径的行 = 只登记功能；带说法文本的行 = 一条说法。
 * 缺枚举列时给业务默认值；描述类必填缺失交给 validateSheets 按行报错（带行号）。
 */
// 回导审核结论：平台确认状态列只有业务明确勾选（已确认/已驳回）才成为待采纳标记；
// 「待确认」或空白不产生标记。导入本身不改变两段式状态，采纳由单独的人工动作完成。
function reviewMarkOf(row) {
  const label = String(row.confirmState || '').trim();
  const status = label === '已确认' ? 'approved' : label === '已驳回' ? 'rejected' : '';
  return status ? { status, note: String(row.reviewNote2 || '').trim() } : null;
}

function flatToRaw(rows) {
  const FUNC_ATTRS = [['fname', 'name'], ['fdesc', 'description'], ['clientClass', 'clientClass'], ['securityLevel', 'securityLevel'], ['department', 'department'], ['fdomain', 'domain'], ['fmenuKey', 'menuKey'], ['fstatus', 'status']];
  const INTENT_ATTRS = [['idomain', 'domain'], ['imenuKey', 'menuKey'], ['iaction', 'action'], ['isourceAction', 'sourceAction'], ['intentType', 'intentType'], ['idesc', 'description'], ['igoal', 'goal'], ['aliases', 'aliases'], ['recallTerms', 'recallTerms'], ['recallTermSets', 'recallTermSets'], ['negativeExamples', 'negativeExamples'], ['semanticPriority', 'semanticPriority'], ['triggerScene', 'triggerScene'], ['scopeIn', 'scopeIn'], ['scopeOut', 'scopeOut'], ['roles', 'roles'], ['iconfusable', 'confusableIntents'], ['disambiguationHints', 'disambiguationHints'], ['executionMode', 'executionMode'], ['riskLevel', 'riskLevel'], ['readiness', 'readiness'], ['requiredSlots', 'requiredSlots'], ['capabilityBindings', 'capabilityBindings'], ['businessObjects', 'businessObjects'], ['businessObjectId', 'businessObjectId'], ['keySlots', 'keySlots'], ['answerForm', 'answerForm'], ['heat', 'heat'], ['taskPolicyShapes', 'taskPolicyShapes'], ['taskPolicyMode', 'taskPolicyMode'], ['taskPolicyMaxTasks', 'taskPolicyMaxTasks'], ['contextPolicyRetain', 'contextPolicyRetain'], ['contextPolicySwitch', 'contextPolicySwitch'], ['contextPolicyResumable', 'contextPolicyResumable'], ['responsePolicy', 'responsePolicy'], ['orchestrationMode', 'orchestrationMode'], ['lifecycle', 'lifecycle'], ['semanticVersion', 'semanticVersion'], ['owner', 'owner'], ['sourceChannel', 'sourceChannel'], ['sourceMenuId', 'sourceMenuId'], ['sourceActionId', 'sourceActionId'], ['istatus', 'status']];
  const funcByPath = new Map();
  const funcOrder = [];
  const intentByRef = new Map();
  const intentOrder = [];
  const utterances = [];
  let lastIntentRef = null;
  let srcBatchId = '';
  rows.forEach((row) => {
    const path = String(row.path || '').trim();
    if (!srcBatchId && String(row.srcBatch || '').trim()) srcBatchId = String(row.srcBatch).trim();
    let func = funcByPath.get(path);
    if (!func) {
      func = { rowNumber: row.rowNumber, path };
      funcOrder.push(path);
      funcByPath.set(path, func);
    }
    FUNC_ATTRS.forEach(([from, to]) => {
      if (func[to] === undefined && String(row[from] || '').trim()) func[to] = String(row[from]).trim();
    });
    const iname = String(row.iname || '').trim();
    if (!iname && !String(row.text || '').trim()) {
      const fm = reviewMarkOf(row); // 纯功能登记行：结论归功能本身
      if (fm) func._review = fm;
      return;
    }
    let ref;
    if (iname) {
      ref = path + '/' + iname;
      let intent = intentByRef.get(ref);
      if (!intent) {
        intent = { rowNumber: row.rowNumber, name: iname, funcPath: path };
        intentOrder.push(ref);
        intentByRef.set(ref, intent);
      }
      INTENT_ATTRS.forEach(([from, to]) => {
        if (intent[to] === undefined && String(row[from] || '').trim()) intent[to] = String(row[from]).trim();
      });
      lastIntentRef = ref;
      if (!String(row.text || '').trim()) {
        // 意图登记行（无说法文本）：结论归意图；带文本的行结论归该行说法
        const im = reviewMarkOf(row);
        if (im) intent._review = im;
      }
    } else if (lastIntentRef && lastIntentRef.startsWith(path + '/')) {
      // 只写说法文本的行继承上一个意图（同功能路径内向下填充）
      ref = lastIntentRef;
    } else {
      // 无意图可继承时故意给出非法标识，让契约校验按行报错（而不是静默丢数据）
      ref = path + '/';
    }
    const text = String(row.text || '').trim();
    if (!text) return;
    const um = reviewMarkOf(row);
    utterances.push({
      rowNumber: row.rowNumber,
      intentRef: ref,
      kind: String(row.kind || '').trim() || '扩展问',
      text,
      source: String(row.source || '').trim() || '人工编写',
      confidence: row.confidence,
      status: String(row.ustatus || '').trim() || '候选',
      reviewNote: '',
      ...(um ? { _review: um } : {}),
      note: row.note || '',
    });
  });
  const functions = funcOrder.map((path) => {
    const f = funcByPath.get(path);
    return {
      rowNumber: f.rowNumber,
      path,
      name: f.name || path.split('/').pop(),
      description: f.description || '',
      domain: f.domain || '',
      menuKey: f.menuKey || '',
      clientClass: f.clientClass || '不区分',
      securityLevel: f.securityLevel || 'L2-内部',
      department: f.department || '',
      status: f.status || '启用',
      note: '',
      ...(f._review ? { _review: f._review } : {}),
    };
  });
  const intents = intentOrder.map((ref) => {
    const it = intentByRef.get(ref);
    return {
      rowNumber: it.rowNumber,
      name: it.name,
      funcPath: it.funcPath,
      domain: it.domain || '',
      menuKey: it.menuKey || '',
      action: it.action || '',
      sourceAction: it.sourceAction || '',
      intentType: it.intentType || '查询',
      description: it.description || '',
      goal: it.goal || '',
      aliases: it.aliases || '',
      recallTerms: it.recallTerms || '',
      recallTermSets: it.recallTermSets || '',
      negativeExamples: it.negativeExamples || '',
      semanticPriority: it.semanticPriority || '',
      businessObjects: it.businessObjects || '',
      businessObjectId: it.businessObjectId || '',
      keySlots: it.keySlots || '',
      triggerScene: it.triggerScene || '',
      scopeIn: it.scopeIn || '',
      scopeOut: it.scopeOut || '',
      roles: it.roles || '',
      confusableIntents: it.confusableIntents || '',
      disambiguationHints: it.disambiguationHints || '',
      executionMode: it.executionMode || '',
      riskLevel: it.riskLevel || '',
      readiness: it.readiness || '',
      requiredSlots: it.requiredSlots || '',
      capabilityBindings: it.capabilityBindings || '',
      answerForm: it.answerForm || '',
      heat: it.heat || 'P2-低频',
      taskPolicyShapes: it.taskPolicyShapes || '',
      taskPolicyMode: it.taskPolicyMode || '',
      taskPolicyMaxTasks: it.taskPolicyMaxTasks || '',
      contextPolicyRetain: it.contextPolicyRetain || '',
      contextPolicySwitch: it.contextPolicySwitch || '',
      contextPolicyResumable: it.contextPolicyResumable || '',
      responsePolicy: it.responsePolicy || '',
      orchestrationMode: it.orchestrationMode || '',
      status: it.status || '生效',
      lifecycle: it.lifecycle || '',
      semanticVersion: it.semanticVersion || '',
      owner: it.owner || '',
      sourceChannel: it.sourceChannel || '',
      sourceMenuId: it.sourceMenuId || '',
      sourceActionId: it.sourceActionId || '',
      code: '',
      note: '',
      ...(it._review ? { _review: it._review } : {}),
    };
  });
  return { functions, intents, utterances, srcBatchId };
}

function parseConfidence(value) {
  if (value === '' || value === null || value === undefined) return null;
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0 || num > 1) return NaN;
  return num;
}

/**
 * 单行模板契约校验：validateSheets（Excel 导入）与在线行编辑（POST/PATCH rows）共用同一套规则文案。
 * ctx 携带跨行状态：seenPaths 已登记功能路径 / seenIntents 已登记意图 ref / intentRefSet 说法可引用的 ref /
 * seenTextByIntent・textOwnerIntent・biaowenCount 说法文本簿记。说法分支按既有语义写入文本簿记（被拒行同样占用文本槽）；
 * seenPaths/seenIntents/intentRefSet 的登记由调用方在行通过后执行。返回 { errors, warnings }，warnings 仅含 message。
 */
// 易混意图列：分号分隔的意图名称列表（软引用，入图时解析不到的丢弃并计数）
function splitConfusable(value) {
  return String(value || '').split(/[;；]/).map((s) => s.trim()).filter(Boolean);
}

function collectRowErrors(kind, row, ctx) {
  const errors = [];
  const warnings = [];
  if (kind === 'functions') {
    const segments = row.path.split('/').filter(Boolean);
    if (!row.path) errors.push('功能全路径为空');
    if (segments.length > MAX_PATH_SEGMENTS) errors.push('功能路径超过 ' + MAX_PATH_SEGMENTS + ' 段');
    if (!row.path || row.path.startsWith('/') || row.path.endsWith('/') || row.path.includes('//')) errors.push('功能路径存在空段');
    if (ctx.seenPaths.has(row.path)) errors.push('功能路径重复');
    if (segments.length > 1) {
      const parent = segments.slice(0, -1).join('/');
      if (!ctx.seenPaths.has(parent)) errors.push('上级功能路径未登记：' + parent);
    }
    if (!row.name) errors.push('功能名称为空');
    if (row.name && row.path && row.path.split('/').pop() !== row.name) errors.push('功能名称与路径末段不一致');
    if ((row.description || '').length < 10) errors.push('业务描述过短（至少 10 字，按三段式写全）');
    if (!CLIENT_CLASSES.includes(row.clientClass)) errors.push('客户分类不在枚举内：' + row.clientClass);
    if (!SECURITY_LEVELS.includes(row.securityLevel)) errors.push('安全分级不在枚举内：' + row.securityLevel);
    if (!row.department) errors.push('责任部门为空');
    if (!FUNC_STATUSES.includes(row.status)) errors.push('状态不在枚举内：' + row.status);
  } else if (kind === 'intents') {
    const ref = row.funcPath + '/' + row.name;
    if (!row.name) errors.push('意图名称为空');
    if (!row.funcPath) errors.push('所属功能全路径为空');
    if (row.funcPath && !ctx.seenPaths.has(row.funcPath)) errors.push('功能路径未登记：' + row.funcPath);
    if (ctx.seenIntents.has(ref)) errors.push('同一功能路径下意图名称重复');
    if (!INTENT_TYPES.includes(row.intentType)) errors.push('意图类型不在枚举内：' + row.intentType);
    if ((row.description || '').length < 10) errors.push('业务描述过短（至少 10 字，按三段式写全）');
    if (!ANSWER_FORMS.includes(row.answerForm)) errors.push('答案形态不在枚举内：' + row.answerForm);
    if (!HEAT_LEVELS.includes(row.heat)) errors.push('热度不在枚举内：' + row.heat);
    if (!INTENT_STATUSES.includes(row.status)) errors.push('状态不在枚举内：' + row.status);
    // 新增枚举字段校验（选填，填了就必须在合法值内）
    if (row.domain && !DOMAINS.includes(row.domain)) errors.push('业务域不在枚举内：' + row.domain);
    if (row.action && !ACTIONS.includes(row.action)) errors.push('动作类型不在枚举内：' + row.action);
    if (row.sourceAction && !SOURCE_ACTIONS.includes(row.sourceAction)) errors.push('来源动作不在枚举内：' + row.sourceAction);
    if (row.executionMode && !EXECUTION_MODES.includes(row.executionMode)) errors.push('执行模式不在枚举内：' + row.executionMode);
    if (row.riskLevel && !RISK_LEVELS.includes(row.riskLevel)) errors.push('风险等级不在枚举内：' + row.riskLevel);
    if (row.readiness && !READINESS_LEVELS.includes(row.readiness)) errors.push('就绪状态不在枚举内：' + row.readiness);
    if (row.lifecycle && !LIFECYCLES.includes(row.lifecycle)) errors.push('生命周期不在枚举内：' + row.lifecycle);
    if (row.orchestrationMode && !ORCHESTRATION_MODES.includes(row.orchestrationMode)) errors.push('编排模式不在枚举内：' + row.orchestrationMode);
    if (row.taskPolicyMode && !TASK_MODES.includes(row.taskPolicyMode)) errors.push('任务模式不在枚举内：' + row.taskPolicyMode);
    if (row.contextPolicyRetain && !BOOLEAN_ENUMS.includes(row.contextPolicyRetain)) errors.push('澄清保留上下文不在枚举内：' + row.contextPolicyRetain);
    if (row.contextPolicySwitch && !BOOLEAN_ENUMS.includes(row.contextPolicySwitch)) errors.push('允许意图切换不在枚举内：' + row.contextPolicySwitch);
    if (row.contextPolicyResumable && !BOOLEAN_ENUMS.includes(row.contextPolicyResumable)) errors.push('可恢复不在枚举内：' + row.contextPolicyResumable);
    // 易混意图是软引用（写意图名称），未登记不阻断导入，但提醒填写者核对——入图时解析不到会丢弃
    splitConfusable(row.confusableIntents).forEach((name) => {
      if (ctx.intentNameSet && !ctx.intentNameSet.has(name)) {
        warnings.push({ message: '易混意图「' + name + '」未在本批次登记，请核对名称（入图时解析不到会丢弃）' });
      }
    });
  } else if (kind === 'utterances') {
    if (!row.intentRef) errors.push('意图标识为空');
    if (row.intentRef && !ctx.intentRefSet.has(row.intentRef)) errors.push('意图标识未登记：' + row.intentRef);
    if (!UTTER_KINDS.includes(row.kind)) errors.push('说法类型不在枚举内：' + row.kind);
    const text = row.text;
    if (!text || text.length < 2 || text.length > 50) errors.push('说法文本长度需在 2~50 字之间');
    if (!UTTER_SOURCES.includes(row.source)) errors.push('来源不在枚举内：' + row.source);
    if (!UTTER_STATUSES.includes(row.status)) errors.push('状态不在枚举内：' + row.status);
    if (row.status === '驳回' && !(row.reviewNote || '').trim()) errors.push('驳回必须填写审核意见');
    const confidence = parseConfidence(row.confidence);
    if (Number.isNaN(confidence)) errors.push('置信度必须是 0~1 的数值');
    if (text && row.intentRef) {
      const key = row.intentRef + ' ' + text;
      if (ctx.seenTextByIntent.has(key)) errors.push('同一意图下说法文本重复');
      if (ctx.textOwnerIntent.has(text) && ctx.textOwnerIntent.get(text) !== row.intentRef) {
        warnings.push({ message: '说法「' + text + '」同时挂在多个意图下（歧义），请人工复核' });
      }
      ctx.seenTextByIntent.set(key, true);
      if (!ctx.textOwnerIntent.has(text)) ctx.textOwnerIntent.set(text, row.intentRef);
      if (row.kind === '标问') ctx.biaowenCount.set(row.intentRef, (ctx.biaowenCount.get(row.intentRef) || 0) + 1);
    }
  }
  return { errors, warnings };
}

// 在线行编辑用：以现有批次构建跨行上下文做单行校验；excludeRowId 让被编辑行不与自己比较
function validateRow(kind, row, batch, excludeRowId) {
  const ctx = { seenPaths: new Set(), seenIntents: new Set(), intentRefSet: new Set(), seenTextByIntent: new Map(), textOwnerIntent: new Map(), biaowenCount: new Map(), intentNameSet: new Set() };
  ['functions', 'intents', 'utterances'].forEach((k) => {
    ((batch.rows && batch.rows[k]) || []).forEach((r) => {
      if (excludeRowId && r.rowId === excludeRowId) return;
      if (k === 'functions') {
        ctx.seenPaths.add(r.path);
      } else if (k === 'intents') {
        ctx.seenIntents.add(r.ref);
        ctx.intentRefSet.add(r.ref);
        if (r.name) ctx.intentNameSet.add(r.name);
      } else if (r.text && r.intentRef) {
        ctx.seenTextByIntent.set(r.intentRef + ' ' + r.text, true);
        if (!ctx.textOwnerIntent.has(r.text)) ctx.textOwnerIntent.set(r.text, r.intentRef);
      }
    });
  });
  return collectRowErrors(kind, row, ctx);
}

// ── 在线行编辑辅助（POST/PATCH/DELETE rows 共用） ───────────────────────────

const ROW_INPUT_FIELDS = {
  functions: ['path', 'name', 'description', 'domain', 'menuKey', 'clientClass', 'securityLevel', 'department', 'status', 'note'],
  intents: [
    'name', 'funcPath', 'intentType', 'description', 'goal',
    // 基本定义
    'domain', 'menuKey', 'action', 'sourceAction',
    // 召回素材
    'aliases', 'recallTerms', 'recallTermSets', 'negativeExamples', 'semanticPriority',
    // 触发条件
    'triggerScene',
    // 服务边界
    'scopeIn', 'scopeOut', 'confusableIntents', 'disambiguationHints',
    // 执行契约
    'executionMode', 'riskLevel', 'readiness', 'requiredSlots', 'capabilityBindings',
    'roles', 'businessObjects', 'keySlots', 'businessObjectId', 'answerForm', 'heat',
    // 策略配置
    'taskPolicyShapes', 'taskPolicyMode', 'taskPolicyMaxTasks',
    'contextPolicyRetain', 'contextPolicySwitch', 'contextPolicyResumable',
    'responsePolicy', 'orchestrationMode',
    // 治理信息
    'status', 'lifecycle', 'semanticVersion', 'owner',
    'sourceChannel', 'sourceMenuId', 'sourceActionId', 'code', 'note',
  ],
  utterances: ['intentRef', 'kind', 'text', 'source', 'confidence', 'status', 'reviewNote', 'note'],
};

// 数值字段不做 String 转换，保持原始类型
const ROW_NUMERIC_FIELDS = new Set(['confidence', 'semanticPriority', 'taskPolicyMaxTasks']);

// 在线编辑的行输入归一化：外部输入一律转字符串（数值字段除外），缺失字段按空串参与校验（与 Excel 空单元格同语义）
function normalizeRowInput(kind, input) {
  const row = {};
  (ROW_INPUT_FIELDS[kind] || []).forEach((f) => {
    const value = input ? input[f] : undefined;
    row[f] = value === undefined || value === null ? '' : (ROW_NUMERIC_FIELDS.has(f) ? value : String(value).trim());
  });
  return row;
}

// rowId 与 Excel 导入同一生成器：functions=path / intents=funcPath+'/'+name / utterances=intentRef+' '+kind+' '+text
function rowIdentityKey(kind, row) {
  if (kind === 'functions') return row.path;
  if (kind === 'intents') return row.funcPath + '/' + row.name;
  return row.intentRef + ' ' + row.kind + ' ' + row.text;
}

function rowIdFor(kind, row) {
  const prefix = kind === 'functions' ? 'f-' : kind === 'intents' ? 'i-' : 'u-';
  return prefix + sha12(rowIdentityKey(kind, row));
}

function findRow(batch, kind, rowId) {
  return (batch.rows[kind] || []).find((row) => row.rowId === rowId) || null;
}

// 两段式底线：任何在线编辑都使既有确认失效（溯源字段保留，确认字段清空）
function demoteForEdit(row) {
  if (row.status !== 'approved') return false;
  row.status = 'pending';
  row.reviewedBy = '';
  row.reviewedAt = '';
  row.reviewNote = '';
  return true;
}

// 存量行的 sourceStatus 可能是 AI 建议口径（AI建议通过等），不在业务枚举内时回落默认值
const KIND_DEFAULT_STATUS = { functions: '启用', intents: '草稿', utterances: '候选' };
function businessStatusOrDefault(kind, value) {
  const enums = { functions: FUNC_STATUSES, intents: INTENT_STATUSES, utterances: UTTER_STATUSES };
  return (enums[kind] || []).includes(value) ? value : KIND_DEFAULT_STATUS[kind];
}

/**
 * 模板契约校验（对齐模板 Sheet4 白话规则的服务端硬校验）。
 * 返回每张表的 validRows / rejected / warnings；错误行不入候选层，随响应报告。
 */
function validateSheets(raw) {
  const warnings = [];
  const rejected = [];
  const reject = (row, errors) => rejected.push({ sheet: currentSheet, rowNumber: row.rowNumber, errors });
  let currentSheet = '';
  const ctx = { seenPaths: new Set(), seenIntents: new Set(), intentRefSet: new Set(), seenTextByIntent: new Map(), textOwnerIntent: new Map(), biaowenCount: new Map(), intentNameSet: new Set((raw.intents || []).map((r) => r.name).filter(Boolean)) };

  currentSheet = FUNC_SHEET;
  const funcRows = [];
  raw.functions.forEach((row) => {
    const { errors } = collectRowErrors('functions', row, ctx);
    if (errors.length) { reject(row, errors); return; }
    ctx.seenPaths.add(row.path);
    funcRows.push({
      rowId: 'f-' + sha12(row.path),
      path: row.path,
      name: row.name,
      description: row.description,
      clientClass: row.clientClass,
      securityLevel: row.securityLevel,
      department: row.department,
      status: FUNC_STATUS_MAP[row.status] || 'pending',
      sourceStatus: row.status,
      note: row.note,
      ...(row._review ? { _review: row._review } : {}),
    });
  });

  currentSheet = INTENT_SHEET;
  const intentRows = [];
  raw.intents.forEach((row) => {
    const { errors, warnings: rowWarnings } = collectRowErrors('intents', row, ctx);
    rowWarnings.forEach((w) => warnings.push({ sheet: currentSheet, rowNumber: row.rowNumber, message: w.message }));
    if (errors.length) { reject(row, errors); return; }
    const ref = row.funcPath + '/' + row.name;
    ctx.seenIntents.add(ref);
    ctx.intentRefSet.add(ref);
    intentRows.push({
      rowId: 'i-' + sha12(ref),
      name: row.name,
      funcPath: row.funcPath,
      ref,
      intentType: row.intentType,
      description: row.description,
      goal: row.goal || '',
      confusableIntents: row.confusableIntents || '',
      businessObjects: row.businessObjects,
      keySlots: row.keySlots,
      triggerScene: row.triggerScene,
      scopeIn: row.scopeIn,
      scopeOut: row.scopeOut,
      roles: row.roles,
      answerForm: row.answerForm,
      heat: row.heat,
      status: INTENT_STATUS_MAP[row.status] || 'pending',
      sourceStatus: row.status,
      code: row.code,
      note: row.note,
      ...(row._review ? { _review: row._review } : {}),
    });
  });

  currentSheet = UTTER_SHEET;
  const utterRows = [];
  raw.utterances.forEach((row) => {
    const { errors, warnings: rowWarnings } = collectRowErrors('utterances', row, ctx);
    rowWarnings.forEach((w) => warnings.push({ sheet: currentSheet, rowNumber: row.rowNumber, message: w.message }));
    if (errors.length) { reject(row, errors); return; }
    const confidence = parseConfidence(row.confidence);
    utterRows.push({
      rowId: 'u-' + sha12(row.intentRef + ' ' + row.kind + ' ' + row.text),
      intentRef: row.intentRef,
      kind: row.kind,
      text: row.text,
      source: row.source,
      confidence: confidence === null ? null : Math.round(confidence * 100) / 100,
      status: UTTER_STATUS_MAP[row.status] || 'pending',
      sourceStatus: row.status,
      reviewNote: row.reviewNote,
      note: row.note,
      ...(row._review ? { _review: row._review } : {}),
    });
  });
  ctx.intentRefSet.forEach((ref) => {
    const count = ctx.biaowenCount.get(ref) || 0;
    if (count === 0) warnings.push({ sheet: UTTER_SHEET, rowNumber: 0, message: '意图「' + ref + '」没有标问' });
    if (count > 1) warnings.push({ sheet: UTTER_SHEET, rowNumber: 0, message: '意图「' + ref + '」有 ' + count + ' 条标问，入图时只取第一条' });
  });

  const route = (rows) => ({
    total: rows.length,
    approved: rows.filter((r) => r.status === 'approved').length,
    pending: rows.filter((r) => r.status === 'pending').length,
    rejected: rows.filter((r) => r.status === 'rejected').length,
  });
  return {
    warnings,
    rejected,
    sheets: {
      functions: funcRows,
      intents: intentRows,
      utterances: utterRows,
    },
    routed: {
      functions: route(funcRows),
      intents: route(intentRows),
      utterances: route(utterRows),
    },
  };
}

function parseWorkbook(filePath) {
  const workbook = XLSX.readFile(filePath);
  const available = workbook.SheetNames.join('、');
  // 三种填写格式：多表格式（gitcode 8-Sheet）优先；三张分表次之；一体化填写兜底
  if (workbook.Sheets['功能树'] || workbook.Sheets['场景声明']) {
    const raw = multiSheetToRaw(workbook);
    return { raw, available, mode: 'multi-sheet' };
  }
  if (!workbook.Sheets[FUNC_SHEET] && workbook.Sheets[FLAT_SHEET]) {
    // 一并解析导出追加的审核列（平台确认状态/平台审核意见/批次标识）：
    // 只产出待采纳的 _review 标记，导入本身仍全部「待确认」，两段式不破
    const flatRows = sheetToRows(workbook, FLAT_SHEET, FLAT_COLUMNS.concat(EXPORT_EXTRA_COLUMNS));
    const raw = flatToRaw(flatRows);
    return { raw, available, mode: 'flat' };
  }
  const raw = {
    functions: sheetToRows(workbook, FUNC_SHEET, FUNC_COLUMNS),
    intents: sheetToRows(workbook, INTENT_SHEET, INTENT_COLUMNS),
    utterances: sheetToRows(workbook, UTTER_SHEET, UTTER_COLUMNS),
  };
  return { raw, available, mode: 'standard' };
}

// 多表格式（gitcode 8-Sheet）→ raw 适配器
function multiSheetToRaw(wb) {
  const sceneTypeMap = { '查询': '查询', '办理': '办理', '问答': '咨询', '修改': '管理', '撤销': '取消', '转账': '转账', '还款': '还款', '帮助': '投诉' };
  const execModeMap = { '直接执行': 'read-execute-读执行', '需确认': 'confirm-required-确认后执行', '仅回答': 'knowledge-only-知识应答', '多意图': 'multi_intent-多意图' };
  const fulfillMap = { '调接口': '话术答复', '技能编排': '话术答复', '工作流': '话术答复', '智能体': '转人工', '页面直达': '跳转办理', '话术答复': '话术答复', '数据卡片': '数据卡片' };
  const riskLevelMap = { 'L0': 'L0-无风险', 'L1': 'L1-低风险', 'L2': 'L2-中风险', 'L3': 'L3-高风险' };

  const msGet = (row, idx) => (idx == null || idx < 0) ? '' : String(row[idx] || '').trim();
  const msCol = (headers, names) => { for (const n of names) { const i = headers.indexOf(n); if (i >= 0) return i; } return -1; };
  const msSheet = (names) => { for (const n of names) { for (const sn of wb.SheetNames) { if (sn.indexOf(n) >= 0 || n.indexOf(sn) >= 0) return wb.Sheets[sn]; } } return null; };
  const msRows = (sheet) => { if (!sheet) return []; const r = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' }); return r.length < 2 ? [] : r.slice(1).filter((row) => row.join('').trim()); };
  const msHeaders = (sheet) => { if (!sheet) return []; const r = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' }); return r.length < 1 ? [] : r[0].map((h) => String(h || '').trim()); };

  // ── 1. 功能树 → functions raw ──
  const funcSheet = msSheet(['功能树', '功能列表', '功能']);
  const fH = msHeaders(funcSheet);
  const cFName = msCol(fH, ['功能名称', '功能', '名称']);
  const cFParent = msCol(fH, ['上级功能', '上级', '父功能']);
  const cFPath = msCol(fH, ['App菜单路径', '菜单路径', '路径']);
  const cFDesc = msCol(fH, ['业务说明', '说明', '描述']);
  const cFScopeIn = msCol(fH, ['范围内关键词', '范围内']);
  const cFScopeOut = msCol(fH, ['范围外关键词', '范围外']);
  const cFBizObj = msCol(fH, ['业务对象', '对象']);
  const funcRows = msRows(funcSheet);
  const funcByPath = {};
  const pathByName = {};
  funcRows.forEach((r) => {
    const name = msGet(r, cFName); if (!name) return;
    const parent = msGet(r, cFParent);
    const path = msGet(r, cFPath) || (parent ? parent + '/' + name : name);
    pathByName[name] = path;
    funcByPath[path] = { path, name: name, description: msGet(r, cFDesc), scopeIn: msGet(r, cFScopeIn), scopeOut: msGet(r, cFScopeOut), businessObjects: msGet(r, cFBizObj), clientClass: '不区分', securityLevel: 'L2-内部', department: '待补充', status: '启用' };
  });

  // ── 2. 场景声明 → intents raw ──
  const sceneSheet = msSheet(['场景声明', '场景', '意图声明']);
  const sH = msHeaders(sceneSheet);
  const cSFunc = msCol(sH, ['功能名称', '功能', '关联功能']);
  const cSType = msCol(sH, ['场景类型', '类型']);
  const cSDesc = msCol(sH, ['场景描述', '描述']);
  const cSGoal = msCol(sH, ['用户目标', '目标']);
  const cSExec = msCol(sH, ['执行方式', '执行模式']);
  const cSConfirm = msCol(sH, ['需要确认', '是否确认']);
  const cSRisk = msCol(sH, ['风险等级', '风险']);
  const sceneRows = msRows(sceneSheet);
  const intentByRef = {};
  const intentRows = [];
  sceneRows.forEach((r) => {
    const sfunc = msGet(r, cSFunc); if (!sfunc) return;
    const stype = msGet(r, cSType) || '查询';
    const path = pathByName[sfunc] || sfunc;
    const iname = sfunc + '-' + stype;
    const ref = path + '/' + iname;
    const bizIntentType = sceneTypeMap[stype] || '查询';
    const intent = {
      name: iname, funcPath: path,
      intentType: bizIntentType,
      description: msGet(r, cSDesc),
      goal: msGet(r, cSGoal),
      executionMode: execModeMap[msGet(r, cSExec)] || '',
      riskLevel: riskLevelMap[msGet(r, cSRisk)] || 'L0-无风险',
      answerForm: '话术答复',
      triggerScene: stype,
      scopeIn: funcByPath[path] ? funcByPath[path].scopeIn : '',
      scopeOut: funcByPath[path] ? funcByPath[path].scopeOut : '',
      businessObjects: funcByPath[path] ? funcByPath[path].businessObjects : '',
      aliases: '', recallTerms: '', negativeExamples: '', recallTermSets: '',
      requiredSlots: '', capabilityBindings: '', confusableIntents: '', disambiguationHints: '',
      heat: 'P2-低频', status: '生效',
      lifecycle: 'active-活跃', readiness: 'ready-就绪', orchestrationMode: 'deterministic-确定式',
    };
    intentByRef[ref] = intent;
    intentRows.push(intent);
  });

  // ── 3. 说法素材 → utterances + aliases/recallTerms 回填 ──
  const uttSheet = msSheet(['说法素材', '说法', '语料']);
  const uH = msHeaders(uttSheet);
  const cUFunc = msCol(uH, ['功能名称', '功能', '关联功能']);
  const cUType = msCol(uH, ['场景类型', '类型']);
  const cUKind = msCol(uH, ['素材类型', '类型']);
  const cUContent = msCol(uH, ['素材内容', '内容', '说法']);
  const uttRows = msRows(uttSheet);
  const utterances = [];
  uttRows.forEach((r) => {
    const ufunc = msGet(r, cUFunc); const utype = msGet(r, cUType);
    const ukind = msGet(r, cUKind); const ucontent = msGet(r, cUContent);
    if (!ufunc || !ucontent) return;
    const path = pathByName[ufunc] || ufunc;
    const iname = ufunc + '-' + (utype || '查询');
    const ref = path + '/' + iname;
    const intent = intentByRef[ref];
    if (intent) {
      const kindLower = ukind.toLowerCase();
      if (kindLower.indexOf('负例') >= 0) {
        intent.negativeExamples = (intent.negativeExamples ? intent.negativeExamples + ',' : '') + ucontent;
      } else if (kindLower.indexOf('召回词') >= 0 || kindLower.indexOf('关键词') >= 0) {
        intent.recallTerms = (intent.recallTerms ? intent.recallTerms + ',' : '') + ucontent;
      } else if (kindLower.indexOf('词组') >= 0) {
        intent.recallTermSets = (intent.recallTermSets ? intent.recallTermSets + ',' : '') + ucontent;
      } else {
        intent.aliases = (intent.aliases ? intent.aliases + ',' : '') + ucontent;
      }
    }
    // 负例和召回词不作为说法行导入，只回填到意图的 negativeExamples/recallTerms
    if (ukind.indexOf('负例') < 0 && ukind.toLowerCase().indexOf('召回词') < 0 && ukind.toLowerCase().indexOf('关键词') < 0 && ukind.indexOf('词组') < 0) {
      utterances.push({ intentRef: ref, funcPath: path, iname, text: ucontent, kind: (ukind.indexOf('标') >= 0 || ukind.indexOf('标准') >= 0) ? '标问' : '扩展问', source: '存量导入', confidence: '', status: '候选' });
    }
  });

  // ── 4. 信息收集项 → requiredSlots 回填 ──
  const slotSheet = msSheet(['信息收集项', '收集项', '槽位']);
  const slH = msHeaders(slotSheet);
  const cSlFunc = msCol(slH, ['功能名称', '功能']);
  const cSlType = msCol(slH, ['场景类型', '类型']);
  const cSlName = msCol(slH, ['收集项名称', '名称', '槽位名称']);
  const slotRows = msRows(slotSheet);
  slotRows.forEach((r) => {
    const slfunc = msGet(r, cSlFunc); const sltype = msGet(r, cSlType);
    const slname = msGet(r, cSlName); if (!slfunc || !slname) return;
    const path = pathByName[slfunc] || slfunc;
    const iname = slfunc + '-' + (sltype || '查询');
    const ref = path + '/' + iname;
    const intent = intentByRef[ref];
    if (intent) {
      intent.requiredSlots = (intent.requiredSlots ? intent.requiredSlots + ',' : '') + slname;
    }
  });

  // ── 5. 系统能力 → capabilityBindings + answerForm 回填 ──
  const capSheet = msSheet(['系统能力', '能力', '系统对接']);
  const capH = msHeaders(capSheet);
  const cCFunc = msCol(capH, ['关联功能', '功能']);
  const cCType = msCol(capH, ['关联场景', '场景']);
  const cCName = msCol(capH, ['能力名称', '名称', '能力']);
  const cCMethod = msCol(capH, ['落地方式', '方式']);
  const capRows = msRows(capSheet);
  capRows.forEach((r) => {
    const cfunc = msGet(r, cCFunc); const ctype = msGet(r, cCType);
    const cname = msGet(r, cCName); const cmethod = msGet(r, cCMethod);
    if (!cfunc || !cname) return;
    const path = pathByName[cfunc] || cfunc;
    const iname = cfunc + '-' + (ctype || '查询');
    const ref = path + '/' + iname;
    const intent = intentByRef[ref];
    if (intent) {
      intent.capabilityBindings = (intent.capabilityBindings ? intent.capabilityBindings + ',' : '') + cname;
      if (cmethod && fulfillMap[cmethod]) intent.answerForm = fulfillMap[cmethod];
    }
  });

  // ── 6. 易混淆关系 → confusableIntents + disambiguationHints 回填 ──
  const confSheet = msSheet(['易混淆关系', '混淆关系', '易混淆']);
  const cfH = msHeaders(confSheet);
  const cCfFuncA = msCol(cfH, ['功能A', '功能1']);
  const cCfTypeA = msCol(cfH, ['场景A', '场景1']);
  const cCfFuncB = msCol(cfH, ['功能B', '功能2']);
  const cCfTypeB = msCol(cfH, ['场景B', '场景2']);
  const cCfHint = msCol(cfH, ['消歧提示', '提示', '消歧']);
  const cCfReason = msCol(cfH, ['混淆原因', '原因']);
  const confRows = msRows(confSheet);
  confRows.forEach((r) => {
    const fA = msGet(r, cCfFuncA); const tA = msGet(r, cCfTypeA);
    const fB = msGet(r, cCfFuncB); const tB = msGet(r, cCfTypeB);
    const hint = msGet(r, cCfHint); const reason = msGet(r, cCfReason);
    if (!fA || !fB) return;
    const pathA = pathByName[fA] || fA; const inameA = fA + '-' + (tA || '查询');
    const pathB = pathByName[fB] || fB; const inameB = fB + '-' + (tB || '查询');
    const intentA = intentByRef[pathA + '/' + inameA];
    const intentB = intentByRef[pathB + '/' + inameB];
    if (intentA) {
      intentA.confusableIntents = (intentA.confusableIntents ? intentA.confusableIntents + ',' : '') + inameB;
      if (hint) intentA.disambiguationHints = (intentA.disambiguationHints ? intentA.disambiguationHints + ',' : '') + hint;
    }
    if (intentB) {
      intentB.confusableIntents = (intentB.confusableIntents ? intentB.confusableIntents + ',' : '') + inameA;
      if (hint) intentB.disambiguationHints = (intentB.disambiguationHints ? intentB.disambiguationHints + ',' : '') + hint;
    }
  });

  // ── 组装 raw ──
  const functions = Object.keys(funcByPath).map((path) => funcByPath[path]);
  return { functions, intents: intentRows, utterances };
}

// ── 入图合并（纯函数，供测试） ──────────────────────────────────────────────

function utteranceOrderedList(rows) {
  const biaowen = rows.filter((r) => r.kind === '标问').map((r) => r.text);
  const others = rows.filter((r) => r.kind !== '标问').map((r) => r.text);
  const seen = new Set();
  return biaowen.concat(others).filter((text) => {
    if (seen.has(text)) return false;
    seen.add(text);
    return true;
  });
}

/**
 * 将候选层通过审核的行合并进意图图谱文档。
 * 合并策略（可重复执行）：
 *   功能路径 → AGGREGATE_INTENT 链（同名节点复用，不重建）；
 *   意图 → INTENT 节点（同名复用，仅合并说法），新建时挂 has_leaf_intent 边；
 *   说法 → 合并进 utterance_view（标问优先、去重）。
 * 返回值除合并后文档与统计外，还带：
 *   changes — 人类可读的变更清单（供应用前预览）；
 *   journal — 本次新建的节点/边/说法清单（供批次回滚，id 均为内容确定性 id）。
 */
function applyToIntakeDocument(document, approved, batchId, now) {
  const doc = document && typeof document === 'object' ? document : {};
  const nodes = Array.isArray(doc.nodes) ? doc.nodes : [];
  const edges = Array.isArray(doc.edges) ? doc.edges : [];
  const changes = [];
  const journal = { aggregates: [], intents: [], edges: [], utterances: [] };
  const stats = {
    aggregatesCreated: 0,
    aggregatesReused: 0,
    intentsCreated: 0,
    intentsReused: 0,
    utterancesAdded: 0,
    edgesCreated: 0,
    skipped: [],
    confusableUnresolved: [],
  };
  // 多值列按逗号/分号均可分隔（模板列提示为「逗号分隔」，兼容旧数据的分号写法）
  const splitList = (value) => String(value || '').split(/[;；,，]/).map((s) => s.trim()).filter(Boolean);

  const aggByName = new Map();
  nodes.forEach((node) => {
    if (node && node.type === 'AGGREGATE_INTENT' && node.properties && node.properties.name) {
      if (!aggByName.has(node.properties.name)) aggByName.set(node.properties.name, node);
    }
  });

  const provenance = () => ({ source: 'knowledge-intake', sourceBatch: batchId, appliedAt: now });

  function ensureEdge(type, source, target) {
    const exists = edges.some((e) => e && e.type === type && e.source === source && e.target === target);
    if (exists) return false;
    edges.push({
      id: 'edge:ki:' + sha12([type, source, target].join(' ')),
      type,
      source,
      target,
      properties: {},
      provenance: provenance(),
    });
    stats.edgesCreated += 1;
    journal.edges.push(edges[edges.length - 1].id);
    return true;
  }

  // 1. 功能路径 → 聚合意图链（按段数从浅到深，保证父链先建）
  const aggIdByPath = new Map();
  const aggIdByPrefix = new Map();
  const countedReused = new Set();
  const funcRows = (approved.functions || []).slice().sort((a, b) => a.path.split('/').length - b.path.split('/').length);
  funcRows.forEach((row) => {
    const segments = row.path.split('/').filter(Boolean);
    let parent = null;
    segments.forEach((segment, index) => {
      const prefixPath = segments.slice(0, index + 1).join('/');
      let node = aggByName.get(segment);
      if (!node) {
        node = {
          id: 'agg:intake:' + sha12(prefixPath),
          type: 'AGGREGATE_INTENT',
          properties: {
            name: segment,
            domain: segments[0],
            modeling_role: index === 0 ? 'domain_root' : '',
            goal: index === segments.length - 1 ? row.description : '',
            description: index === segments.length - 1 ? row.description : '',
            scope_in: [],
            scope_out: [],
            boundary_note: '',
          },
          provenance: provenance(),
        };
        nodes.push(node);
        aggByName.set(segment, node);
        stats.aggregatesCreated += 1;
        changes.push({ kind: 'aggregate', action: 'create', name: prefixPath });
        journal.aggregates.push(node.id);
      } else if (!countedReused.has(node.id)) {
        countedReused.add(node.id);
        stats.aggregatesReused += 1;
        changes.push({ kind: 'aggregate', action: 'reuse', name: segment });
      }
      if (parent && parent.id !== node.id) ensureEdge('is_child_of', node.id, parent.id);
      parent = node;
      aggIdByPrefix.set(prefixPath, node.id);
      if (index === segments.length - 1) aggIdByPath.set(row.path, node.id);
    });
  });

  // 2. 说法按意图标识分组
  const utterancesByIntent = new Map();
  (approved.utterances || []).forEach((row) => {
    if (!utterancesByIntent.has(row.intentRef)) utterancesByIntent.set(row.intentRef, []);
    utterancesByIntent.get(row.intentRef).push(row);
  });

  function mergeUtterances(intentNode, rows, existingIntent) {
    const props = intentNode.properties || (intentNode.properties = {});
    const list = Array.isArray(props.utterance_view) ? props.utterance_view : [];
    const ordered = utteranceOrderedList(rows);
    const addedTexts = [];
    ordered.forEach((text) => {
      if (!list.some((u) => String(u) === text)) {
        list.push(text);
        addedTexts.push(text);
        stats.utterancesAdded += 1;
      }
    });
    props.utterance_view = list;
    if (addedTexts.length) {
      journal.utterances.push({ nodeId: intentNode.id, texts: addedTexts });
      if (existingIntent) {
        addedTexts.forEach((text) => changes.push({ kind: 'utterance', action: 'add', name: text, detail: intentNode.properties.name }));
      }
    }
  }

  // 3. 意图 → INTENT 节点（同名复用仅并说法；否则新建并挂父链）
  // 易混意图是意图名称软引用：能解析到本图或本批次意图名的才入图，解析不到的丢弃并计数（导入端已有警告）
  const knownIntentNames = new Set(
    nodes
      .filter((n) => n && n.type === 'INTENT' && n.properties && n.properties.name)
      .map((n) => n.properties.name)
  );
  (approved.intents || []).forEach((row) => {
    if (row.name) knownIntentNames.add(row.name);
  });
  const createdIntentRows = [];
  (approved.intents || []).forEach((row) => {
    const parentAggId = aggIdByPath.get(row.funcPath);
    if (!parentAggId) {
      stats.skipped.push({ kind: 'intent', ref: row.ref, reason: '功能路径未通过本次导入的功能行解析' });
      return;
    }
    const utterRows = utterancesByIntent.get(row.ref) || [];
    const existing = nodes.find((n) => n && n.type === 'INTENT' && n.properties && n.properties.name === row.name);
    if (existing) {
      mergeUtterances(existing, utterRows, true);
      ensureEdge('has_leaf_intent', parentAggId, existing.id);
      stats.intentsReused += 1;
      changes.push({ kind: 'intent', action: 'reuse', name: row.name, ref: row.ref });
      return;
    }
    const mappedType = INTENT_TYPE_MAP[row.intentType] || 'ASK';
    const execModeValue = parseEnumValue(row.executionMode);
    const answerForm = row.answerForm || '';
    const fulfillmentKind = deriveFulfillmentKind(row.executionMode, answerForm);
    const lifecycleValue = parseEnumValue(row.lifecycle) || 'active';
    const readinessValue = parseEnumValue(row.readiness) || 'ready';
    const orchModeValue = parseEnumValue(row.orchestrationMode) || 'single';
    const confusables = splitConfusable(row.confusableIntents).filter((nm) => nm !== row.name);
    const resolvedConfusables = confusables.filter((nm) => {
      if (knownIntentNames.has(nm)) return true;
      stats.confusableUnresolved.push(nm);
      return false;
    });
    const objectList = splitList(row.businessObjects);
    // 条件必填补齐（模板 metadata.conditional_requirements）：
    //   answer → 至少 answer_text/answer_ref 之一；confirm-required → requires_confirmation；
    //   query/menu/skill/workflow/agent → 各自 _ref 必填；read-execute → capabilities/query_ref/api_or_workflow_id 任一。
    // 无真实绑定引用时按校验器既有约定写 mock: 占位（产生 MOCK_FULFILLMENT_REFERENCE 警告而非错误，发布前替换）。
    const execModeResolved = execModeValue || (mappedType === 'ASK' || mappedType === 'HELP' ? 'knowledge-only' : 'confirm-required');
    const capabilityList = splitList(row.capabilityBindings);
    const slotList = splitList(row.requiredSlots);
    let fulfillmentResolved = fulfillmentKind;
    let refPlaceholder = null;
    if (fulfillmentResolved === 'query') refPlaceholder = { key: 'query_ref', value: 'mock:query:' + row.ref };
    else if (fulfillmentResolved === 'menu') refPlaceholder = { key: 'menu_ref', value: row.funcPath };
    else if (fulfillmentResolved === 'skill') refPlaceholder = { key: 'skill_ref', value: 'mock:skill:' + row.ref };
    else if (fulfillmentResolved === 'workflow') refPlaceholder = { key: 'workflow_ref', value: 'mock:workflow:' + row.ref };
    else if (fulfillmentResolved === 'agent') refPlaceholder = { key: 'agent_ref', value: 'mock:agent:' + row.ref };
    else if (fulfillmentResolved === 'unconfigured' && execModeResolved === 'read-execute') {
      // 读执行但未配置交付：落地为 query + mock 引用，保证 conditional 必填可满足
      fulfillmentResolved = 'query';
      refPlaceholder = { key: 'query_ref', value: 'mock:query:' + row.ref };
    }
    const node = {
      id: 'intent:intake:' + sha12(row.ref),
      type: 'INTENT',
      properties: {
        name: row.name,
        intent_type: mappedType,
        action_code: ACTION_CODE_MAP[mappedType] || 'ask',
        domain: row.funcPath.split('/')[0],
        parent_intent_id: parentAggId,
        is_executable_leaf: mappedType === 'DO' || mappedType === 'CHANGE' || mappedType === 'CANCEL' || mappedType === 'TRANSFER' || mappedType === 'REPAY',
        is_knowledge_intent: mappedType === 'ASK' || mappedType === 'QUERY' || mappedType === 'HELP',
        goal: row.goal || row.description,
        description: row.description,
        scope_in: splitList(row.scopeIn),
        scope_out: splitList(row.scopeOut),
        confusable_intents: resolvedConfusables,
        utterance_view: utteranceOrderedList(utterRows),
        object_view: objectList,
        tb_object_name: objectList[0] || '',
        fulfillment_kind: fulfillmentResolved,
        execution_mode: execModeResolved,
        lifecycle: lifecycleValue,
        readiness: readinessValue,
        orchestration_mode: orchModeValue,
        risk_level: parseEnumValue(row.riskLevel) || 'L0',
        scenes: JSON.stringify([{
          intentType: mappedType,
          userGoal: row.goal || row.description || row.name,
          triggerScene: row.triggerScene || '',
          faq: [],
        }]),
      },
      provenance: provenance(),
    };
    // 条件必填字段（依赖 fulfillmentResolved/answerText，节点主体之后补写）
    if (fulfillmentResolved === 'answer') {
      node.properties.answer_text = row.goal || row.description || row.name;
    }
    if (refPlaceholder) {
      node.properties[refPlaceholder.key] = refPlaceholder.value;
    }
    if (execModeResolved === 'confirm-required') {
      node.properties.requires_confirmation = true;
    }
    if (execModeResolved === 'read-execute' && capabilityList.length) {
      node.properties.capabilities = capabilityList;
    }
    nodes.push(node);
    stats.intentsCreated += 1;
    createdIntentRows.push(row);
    changes.push({ kind: 'intent', action: 'create', name: row.name, ref: row.ref });
    journal.intents.push(node.id);
    stats.utterancesAdded += utterancesByIntent.has(row.ref)
      ? node.properties.utterance_view.length
      : 0;
    ensureEdge('has_leaf_intent', parentAggId, node.id);

    // V4.1: 创建 SLOT 节点 + requires_slot 边（类型名对齐 intent-graph 模板：小写 + SLOT 需 data_type 必填）
    const slots = slotList.filter(Boolean);
    slots.forEach((slotName) => {
      const slotId = 'slot:intake:' + sha12(row.ref + ':' + slotName);
      if (!nodes.find((n) => n.id === slotId)) {
        nodes.push({
          id: slotId, type: 'SLOT',
          properties: { name: slotName, data_type: 'string' },
          provenance: provenance(),
        });
        journal.slots = journal.slots || [];
        journal.slots.push(slotId);
      }
      ensureEdge('requires_slot', node.id, slotId);
    });

    // V4.1: 系统能力绑定 → INTENT.capabilities tags（模板无 CAPABILITY 节点类型/HANDLED_BY 边，
    // 引用以「capability:<名称>」形式进能力引用列，配合 query_ref/skill_ref 等 mock 占位表达绑定意图）
    capabilityList.forEach((capName) => {
      const capRef = 'capability:' + capName;
      if (!node.properties.capabilities) node.properties.capabilities = [];
      if (!node.properties.capabilities.includes(capRef)) node.properties.capabilities.push(capRef);
      if (node.properties.fulfillment_kind === 'skill' && capabilityList.indexOf(capName) === 0) {
        node.properties.skill_ref = capRef;
      }
    });

    // V4.1: 创建 confusable_with 边（小写对齐模板）
    resolvedConfusables.forEach((confusableName) => {
      const otherIntent = nodes.find((n) => n.type === 'INTENT' && n.properties.name === confusableName);
      if (otherIntent) {
        ensureEdge('confusable_with', node.id, otherIntent.id);
      }
    });
  });

  // 4. 聚合意图范围边界 = 本次新建意图 scope 的逐级并集（父链同步累积；复用节点不写，保证重复应用幂等）
  createdIntentRows.forEach((row) => {
    const ins = splitList(row.scopeIn);
    const outs = splitList(row.scopeOut);
    if (!ins.length && !outs.length) return;
    const segments = row.funcPath.split('/').filter(Boolean);
    segments.forEach((_, index) => {
      const aggId = aggIdByPrefix.get(segments.slice(0, index + 1).join('/'));
      if (!aggId || !journal.aggregates.includes(aggId)) return;
      const agg = nodes.find((n) => n && n.id === aggId);
      if (!agg || !agg.properties) return;
      ins.forEach((v) => { if (!agg.properties.scope_in.includes(v)) agg.properties.scope_in.push(v); });
      outs.forEach((v) => { if (!agg.properties.scope_out.includes(v)) agg.properties.scope_out.push(v); });
    });
  });

  return {
    document: Object.assign({}, doc, { nodes, edges }),
    stats,
    changes,
    journal,
  };
}

/**
 * 按入图日志回滚：删除本次新增的说法/边，新建节点在无其他边引用时移除（被引用则保留并报告）。
 * 纯函数，供测试。
 */
function rollbackFromDocument(document, journal) {
  const doc = document && typeof document === 'object' ? document : {};
  const safeJournal = journal && typeof journal === 'object' ? journal : {};
  let nodes = Array.isArray(doc.nodes) ? doc.nodes.slice() : [];
  let edges = Array.isArray(doc.edges) ? doc.edges.slice() : [];
  const removed = { aggregates: 0, intents: 0, edges: 0, utterances: 0 };
  const kept = [];

  (safeJournal.utterances || []).forEach((entry) => {
    const node = nodes.find((n) => n && n.id === entry.nodeId);
    if (!node || !node.properties || !Array.isArray(node.properties.utterance_view)) return;
    const removeSet = new Set((entry.texts || []).map(String));
    const before = node.properties.utterance_view.length;
    node.properties.utterance_view = node.properties.utterance_view.filter((u) => !removeSet.has(String(u)));
    removed.utterances += before - node.properties.utterance_view.length;
  });

  const edgeIds = new Set(safeJournal.edges || []);
  const beforeEdges = edges.length;
  edges = edges.filter((e) => !e || !edgeIds.has(e.id));
  removed.edges = beforeEdges - edges.length;

  // 回滚节点候选：aggregates/intents/slots（capabilities 已并入 INTENT.capabilities tags，不再独立建节点）
  const removeCandidates = new Set([...(safeJournal.intents || []), ...(safeJournal.aggregates || []), ...(safeJournal.slots || [])]);
  if (removeCandidates.size) {
    const referenced = new Set();
    edges.forEach((e) => {
      if (e) { referenced.add(e.source); referenced.add(e.target); }
    });
    nodes = nodes.filter((node) => {
      if (!node || !removeCandidates.has(node.id)) return true;
      if (referenced.has(node.id)) { kept.push(node.id); return true; }
      if (node.type === 'INTENT') removed.intents += 1; else removed.aggregates += 1;
      return false;
    });
  }

  return { document: Object.assign({}, doc, { nodes, edges }), removed, kept };
}

// ── loopback 调用 org-graph（复用其 load/validate/save 与文件锁） ────────────

function loopbackRequest(method, apiPath, bodyObj, authHeader) {
  return new Promise((resolve, reject) => {
    const payload = bodyObj === undefined || bodyObj === null
      ? null
      : Buffer.from(JSON.stringify(bodyObj), 'utf8');
    const headers = {};
    if (authHeader) headers.Authorization = authHeader;
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }
    const request = http.request({
      host: '127.0.0.1',
      port: Number(process.env.PORT || 3000),
      path: apiPath,
      method,
      headers,
      timeout: 30000,
    }, (response) => {
      const parts = [];
      response.on('data', (chunk) => parts.push(chunk));
      response.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch (error) { /* 非 JSON */ }
        const ok = response.statusCode >= 200 && response.statusCode < 300;
        if (ok && parsed && parsed.success !== false) {
          resolve(parsed.data !== undefined ? parsed.data : parsed);
          return;
        }
        const message = parsed && parsed.error && parsed.error.message
          ? parsed.error.message
          : '图谱服务返回 ' + response.statusCode;
        reject(Object.assign(new Error(message), {
          code: (parsed && parsed.error && parsed.error.code) || 'KNOWLEDGE_INTAKE_GRAPH_BACKEND',
          statusCode: response.statusCode,
        }));
      });
    });
    request.on('timeout', () => request.destroy(Object.assign(new Error('图谱服务响应超时'), { code: 'KNOWLEDGE_INTAKE_GRAPH_TIMEOUT' })));
    request.on('error', reject);
    if (payload) request.end(payload); else request.end();
  });
}

// ── LLM 扩展问补全（代理 graph-builder-agent /v1/utterance-expansion） ──────

function callBuilderAgent(agentPath, bodyObj) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(bodyObj), 'utf8');
    const request = http.request(BUILDER_AGENT_URL + agentPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
      timeout: EXPAND_TIMEOUT_MS,
    }, (response) => {
      const parts = [];
      response.on('data', (chunk) => parts.push(chunk));
      response.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch (error) { /* */ }
        if (response.statusCode >= 200 && response.statusCode < 300 && parsed) {
          resolve(parsed);
          return;
        }
        reject(Object.assign(new Error('扩展问服务返回 ' + response.statusCode), { code: 'KNOWLEDGE_INTAKE_EXPAND_BACKEND' }));
      });
    });
    request.on('timeout', () => request.destroy(Object.assign(new Error('扩展问服务响应超时'), { code: 'KNOWLEDGE_INTAKE_EXPAND_TIMEOUT' })));
    request.on('error', reject);
    request.end(payload);
  });
}

function parseExpandRequest(row, seeds, count) {
  return {
    intentId: row.rowId,
    name: row.name,
    description: row.description,
    intentType: row.intentType,
    seedUtterances: seeds.slice(0, 30),
    count,
  };
}

// ── 路由分发 ────────────────────────────────────────────────────────────────

async function parseUpload(req) {
  const form = new formidable.IncomingForm({
    uploadDir: fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-intake-')),
    keepExtensions: true,
    maxFileSize: 32 * 1024 * 1024,
  });
  return new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => {
      if (err) reject(Object.assign(new Error('文件上传解析失败：' + err.message), { code: 'KNOWLEDGE_INTAKE_UPLOAD_INVALID' }));
      else resolve({ fields, files });
    });
  });
}

function pickUploadFile(files) {
  const candidate = files.file || files.fileupload || files.xlsx || (files[Object.keys(files)[0]] || null);
  if (!candidate) fail('KNOWLEDGE_INTAKE_FILE_REQUIRED', '请上传 Excel 文件（字段名 file）', 400);
  return Array.isArray(candidate) ? candidate[0] : candidate;
}

function routeBatchItems(pathname, query, body) {
  const parts = pathname.split('/').filter(Boolean); // ['api','knowledge-intake','batches',':id',...]
  const batchId = parts[3];
  const action = parts.slice(4).join('/');
  return { batchId, action, query, body };
}

// 预览与入图共用的合并计算：取已审核行 → loopback 加载图谱 → 纯函数合并 → 校验（不落盘）
async function computeApply(batch, asset, wanted, authHeader) {
  const pick = (rows) => (rows || []).filter((row) => {
    if (row.status !== 'approved') return false;
    return !wanted.size || wanted.has(row.rowId);
  });
  const approved = {
    functions: pick(batch.rows.functions),
    intents: pick(batch.rows.intents),
    utterances: pick(batch.rows.utterances),
  };
  const hasSomething = approved.functions.length || approved.intents.length || approved.utterances.length;
  if (!hasSomething) fail('KNOWLEDGE_INTAKE_NOTHING_APPROVED', '批次内没有「人工已确认」的条目，请先在平台上确认后再入图', 400);
  const source = await loopbackRequest('GET', '/api/org-graph/load?asset=' + encodeURIComponent(asset), undefined, authHeader);
  const merged = applyToIntakeDocument(source, approved, batch.batchId, new Date().toISOString());
  const validation = await loopbackRequest('POST', '/api/org-graph/validate', { asset, document: merged.document }, authHeader);
  return { approved, merged, validation };
}

/**
 * LLM 扩展问补全落行（纯函数，expand-utterances 与单测共用）：
 * 新说法一律 pending（两段式），置信度分层只产出建议标志；同时登记一条 utterance-expansion 修订
 * （op:'add'、resolution:'pending'），修订审阅面板逐条采纳（=人工确认生效）/放弃（=驳回留痕）。
 */
function applyExpansionResults(batch, intentRows, backendResults, count, now) {
  const existingTexts = new Set((batch.rows.utterances || []).map((row) => row.intentRef + ' ' + row.text));
  const addedByIntent = {};
  const changes = [];
  let autoApproved = 0;
  let autoRejected = 0;
  (backendResults || []).forEach((result) => {
    const row = intentRows.find((r) => r.rowId === result.intentId);
    if (!row || result.status !== 'ok') return;
    let added = 0;
    (result.utterances || []).slice(0, count).forEach((item) => {
      const text = String(item.text || '').trim();
      if (!text || text.length < 2 || text.length > 50) return;
      const key = row.ref + ' ' + text;
      if (existingTexts.has(key)) return;
      existingTexts.add(key);
      let confidence = Number(item.confidence);
      if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) confidence = 0.8;
      batch.rows.utterances.push({
        rowId: 'u-' + sha12(row.ref + ' LLM ' + text + ' ' + now),
        intentRef: row.ref,
        kind: '扩展问',
        text,
        source: 'LLM生成',
        confidence: Math.round(confidence * 100) / 100,
        status: 'pending',
        sourceStatus: '候选',
        reviewNote: '',
        note: 'LLM 扩写，待业务确认',
        generatedAt: now,
      });
      const created = batch.rows.utterances[batch.rows.utterances.length - 1];
      const tier = classifyConfidence(created.confidence);
      // 两段式：AI 建议 ≠ 人工确认。行状态统一 pending，置信度分层只产出建议标志供审核人分诊
      created.status = 'pending';
      created.sourceStatus = tier.status === 'approved' ? 'AI建议通过' : tier.status === 'rejected' ? 'AI建议驳回' : '候选';
      if (tier.status === 'approved') {
        created.autoApproved = true;
        created.reviewedBy = 'auto';
        created.reviewedAt = now;
        created.reviewNote = tier.note;
        autoApproved += 1;
      } else if (tier.status === 'rejected') {
        created.autoRejected = true;
        created.reviewedBy = 'auto';
        created.reviewedAt = now;
        created.reviewNote = tier.note;
        autoRejected += 1;
      }
      changes.push({
        rowId: created.rowId,
        rowType: 'utterances',
        op: 'add',
        label: text,
        confidence: created.confidence,
        sourceStatus: created.sourceStatus,
        autoApproved: !!created.autoApproved,
        autoRejected: !!created.autoRejected,
      });
      added += 1;
    });
    addedByIntent[result.intentId] = added;
  });
  const totalAdded = changes.length;
  const revision = totalAdded
    ? createRevision(batch, 'utterance-expansion', 'LLM 扩展问补全（' + totalAdded + ' 条）', changes)
    : null;
  return { added: totalAdded, addedByIntent, autoApproved, autoRejected, revision };
}

// review 端点与修订 resolve 共用：按 rowId 批量写审核结论（两段式中「人」的落点）
function applyReviewAction(batch, itemIds, action, note, reviewedBy, now) {
  const idSet = itemIds instanceof Set ? itemIds : new Set(itemIds);
  const nextStatus = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'pending';
  let updated = 0;
  ['functions', 'intents', 'utterances'].forEach((kind) => {
    (batch.rows[kind] || []).forEach((row) => {
      if (!idSet.has(row.rowId)) return;
      row.status = nextStatus;
      row.reviewNote = note;
      row.reviewedAt = now;
      row.reviewedBy = reviewedBy;
      updated += 1;
    });
  });
  return { updated, nextStatus };
}

async function handleRequest(req, res, pathname, url, body) {
  const query = url.searchParams;

  // ── 导入（multipart）──
  if (req.method === 'POST' && pathname === '/api/knowledge-intake/import') {
    const { files } = await parseUpload(req);
    const file = pickUploadFile(files);
    const filePath = file.filepath || file.path;
    let parsed;
    try {
      parsed = parseWorkbook(filePath);
    } catch (error) {
      if (error.code && String(error.code).startsWith('KNOWLEDGE_INTAKE_')) throw error;
      fail('KNOWLEDGE_INTAKE_WORKBOOK_INVALID', 'Excel 解析失败：' + error.message, 400);
    }
    const outcome = validateSheets(parsed.raw);
    const hasValid = outcome.sheets.functions.length || outcome.sheets.intents.length || outcome.sheets.utterances.length;
    if (!hasValid) fail('KNOWLEDGE_INTAKE_NOTHING_VALID', '没有可导入的合法数据行，请修正后重试', 400);
    // 导出表回带业务审核结论（_review 标记）：只统计上报，状态仍全部「待确认」，采纳是导入后的独立人工动作
    const markedRows = ['functions', 'intents', 'utterances']
      .flatMap((kind) => outcome.sheets[kind] || [])
      .filter((row) => row && row._review);
    const reviewMeta = {
      marked: markedRows.length,
      approved: markedRows.filter((row) => row._review.status === 'approved').length,
      rejected: markedRows.filter((row) => row._review.status === 'rejected').length,
    };
    const srcBatchId = parsed.mode === 'flat' ? String(parsed.raw.srcBatchId || '') : '';
    const batchId = 'ki-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + crypto.randomBytes(4).toString('hex');
    const batch = {
      batchId,
      fileName: file.originalFilename || file.newFilename || 'import.xlsx',
      importedBy: (req.user && req.user.username) || 'unknown',
      importedAt: new Date().toISOString(),
      templateSheets: parsed.mode === 'flat'
        ? { flat: FLAT_SHEET }
        : { functions: FUNC_SHEET, intents: INTENT_SHEET, utterances: UTTER_SHEET },
      rejected: outcome.rejected,
      warnings: outcome.warnings,
      rows: outcome.sheets,
      srcBatchId,
    };
    saveBatch(batch);
    try { fs.rmSync(path.dirname(filePath), { recursive: true, force: true }); } catch (e) { /* 临时目录清理失败可忽略 */ }
    return {
      batchId,
      fileName: batch.fileName,
      importedAt: batch.importedAt,
      importMode: parsed.mode,
      routed: outcome.routed,
      rejected: outcome.rejected,
      warnings: outcome.warnings,
      reviewMeta,
      srcBatchId,
    };
  }

  // ── 批次列表 ──
  if (req.method === 'GET' && pathname === '/api/knowledge-intake/batches') {
    return { batches: listBatches() };
  }

  // ── 新建空白批次（v4：在线编辑入口，不依赖 Excel 也能开始建知识） ──
  if (req.method === 'POST' && pathname === '/api/knowledge-intake/batches') {
    const batchId = 'ki-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + crypto.randomBytes(4).toString('hex');
    const batch = {
      batchId,
      fileName: String((body && body.name) || '').trim() || '在线新建',
      importedBy: (req.user && req.user.username) || 'unknown',
      importedAt: new Date().toISOString(),
      templateSheets: { functions: FUNC_SHEET, intents: INTENT_SHEET, utterances: UTTER_SHEET },
      rejected: [],
      warnings: [],
      rows: { functions: [], intents: [], utterances: [] },
    };
    saveBatch(batch);
    return summarizeBatch(batch);
  }

  // ── 批次级操作 ──
  if (pathname.startsWith('/api/knowledge-intake/batches/')) {
    const routed = routeBatchItems(pathname, query, body);
    const batchId = routed.batchId;

    if (req.method === 'GET' && !routed.action) {
      const batch = loadBatch(batchId);
      return summarizeBatch(batch);
    }

    // ── 批次元信息编辑（L0 领域名：审核队列根节点按图谱领域展示，可重命名） ──
    if (req.method === 'PATCH' && !routed.action) {
      const batch = loadBatch(batchId);
      const domain = String((body && body.domain) || '').trim();
      if (!domain) fail('KNOWLEDGE_INTAKE_DOMAIN_REQUIRED', '领域名不能为空', 400);
      if (domain.length > 50) fail('KNOWLEDGE_INTAKE_DOMAIN_TOO_LONG', '领域名不超过 50 字', 400);
      batch.domain = domain;
      saveBatch(batch);
      return summarizeBatch(batch);
    }

    if (req.method === 'GET' && routed.action === 'items') {
      const batch = loadBatch(batchId);
      const kind = query.get('kind') || 'all';
      const status = query.get('status') || 'all';
      const q = (query.get('q') || '').trim();
      let rows = allRows(batch);
      if (['functions', 'intents', 'utterances'].includes(kind)) rows = rows.filter((row) => row.rowType === kind);
      if (['approved', 'pending', 'rejected'].includes(status)) rows = rows.filter((row) => row.status === status);
      if (q) {
        rows = rows.filter((row) => {
          const haystack = [row.path, row.name, row.ref, row.text, row.description, row.intentRef]
            .filter(Boolean).join(' ');
          return haystack.includes(q);
        });
      }
      if (query.get('sort') === 'confidence') {
        // 按不确定性排序（调研结论：最没把握的先审）；无置信度的人工条目排最前
        rows = rows.slice().sort((a, b) => (Number(a.confidence) || -1) - (Number(b.confidence) || -1));
      }
      return {
        batchId,
        fileName: batch.fileName,
        total: rows.length,
        items: rows,
        warnings: batch.warnings || [],
        rejected: batch.rejected || [],
      };
    }

    if (req.method === 'GET' && routed.action === 'tree') {
      const batch = loadBatch(batchId);
      const status = query.get('status') || 'all';
      const filtered = ['approved', 'pending', 'rejected'].includes(status) ? status : '';
      return Object.assign(buildBatchTree(batch, filtered), { status: filtered || 'all' });
    }

    if (req.method === 'GET' && routed.action === 'revisions') {
      const batch = loadBatch(batchId);
      const findLive = (rowId) => findRow(batch, 'functions', rowId) || findRow(batch, 'intents', rowId) || findRow(batch, 'utterances', rowId);
      const revisions = (batch.revisions || []).slice().reverse().map((rev) => Object.assign({}, rev, {
        changes: (rev.changes || []).map((change) => {
          const live = findLive(change.rowId);
          return Object.assign({}, change, { liveStatus: live ? live.status : null, stale: !live });
        }),
      }));
      return { batchId, open: revisionOpenCount(batch), revisions };
    }

    if (req.method === 'POST' && routed.action === 'review') {
      const body = routed.body;
      const action = String(body.action || '');
      if (!['approve', 'reject', 'reset'].includes(action)) {
        fail('KNOWLEDGE_INTAKE_ACTION_INVALID', 'action 必须是 approve / reject / reset', 400);
      }
      const note = String(body.note || '').trim();
      if (action === 'reject' && !note) fail('KNOWLEDGE_INTAKE_REVIEW_NOTE_REQUIRED', '驳回必须填写审核意见', 400);
      const itemIds = new Set(Array.isArray(body.itemIds) ? body.itemIds.map(String) : []);
      if (!itemIds.size) fail('KNOWLEDGE_INTAKE_ITEMS_REQUIRED', '请提供 itemIds', 400);
      const batch = loadBatch(batchId);
      const now = new Date().toISOString();
      const reviewedBy = (req.user && req.user.username) || 'unknown';
      const { updated, nextStatus } = applyReviewAction(batch, itemIds, action, note, reviewedBy, now);
      if (!updated) fail('KNOWLEDGE_INTAKE_ITEMS_NOT_FOUND', '没有匹配到可审核的条目', 404);
      saveBatch(batch);
      return { batchId, updated, status: nextStatus };
    }

    // ── 修订审阅：逐条采纳（=人工确认，行生效）/ 放弃（=驳回留痕，默认意见「放弃修订」） ──
    if (req.method === 'POST' && routed.action.startsWith('revisions/')) {
      const rest = routed.action.slice('revisions/'.length);
      const hit = rest.match(/^(rev-[0-9a-f]+)\/resolve$/);
      if (!hit) fail('KNOWLEDGE_INTAKE_ROUTE_NOT_FOUND', '修订路由不合法：' + rest, 404);
      const body = routed.body || {};
      const reqChanges = Array.isArray(body.changes) ? body.changes : [];
      if (!reqChanges.length) fail('KNOWLEDGE_INTAKE_CHANGES_REQUIRED', '请提供 changes', 400);
      reqChanges.forEach((change) => {
        if (!change || !['accept', 'reject'].includes(change.action)) {
          fail('KNOWLEDGE_INTAKE_ACTION_INVALID', 'change.action 必须是 accept / reject', 400);
        }
      });
      const batch = loadBatch(batchId);
      const revision = (batch.revisions || []).find((rev) => rev.revId === hit[1]);
      if (!revision) fail('KNOWLEDGE_INTAKE_REVISION_NOT_FOUND', '修订不存在：' + hit[1], 404);
      const now = new Date().toISOString();
      const reviewedBy = (req.user && req.user.username) || 'unknown';
      const acceptIds = reqChanges.filter((change) => change.action === 'accept').map((change) => String(change.rowId));
      const rejectIds = reqChanges.filter((change) => change.action === 'reject').map((change) => String(change.rowId));
      const reviewed = {
        approved: acceptIds.length ? applyReviewAction(batch, acceptIds, 'approve', '', reviewedBy, now).updated : 0,
        rejected: rejectIds.length ? applyReviewAction(batch, rejectIds, 'reject', String(body.note || '').trim() || '放弃修订', reviewedBy, now).updated : 0,
      };
      const wantedByRow = new Map();
      acceptIds.forEach((id) => wantedByRow.set(id, 'accepted'));
      rejectIds.forEach((id) => wantedByRow.set(id, 'rejected'));
      let resolved = 0;
      (revision.changes || []).forEach((change) => {
        const wanted = wantedByRow.get(change.rowId);
        if (!wanted || change.resolution !== 'pending') return;
        const live = findRow(batch, 'functions', change.rowId) || findRow(batch, 'intents', change.rowId) || findRow(batch, 'utterances', change.rowId);
        change.resolution = live ? wanted : 'rejected';
        change.note = live ? (wanted === 'rejected' ? String(body.note || '').trim() || '放弃修订' : '') : '行已不存在';
        change.resolvedBy = reviewedBy;
        change.resolvedAt = now;
        resolved += 1;
      });
      if (!resolved) fail('KNOWLEDGE_INTAKE_REVISION_NOTHING_TO_RESOLVE', '没有可裁决的修订条目（可能均已处理）', 400);
      saveBatch(batch);
      return { batchId, revId: revision.revId, reviewed, resolved, revision };
    }

    // ── 采纳业务审核结论（导出表回导的 _review 标记）：显式人工动作，两段式的「人」在这一步出现 ──
    if (req.method === 'POST' && routed.action === 'apply-review') {
      const batch = loadBatch(batchId);
      const now = new Date().toISOString();
      const reviewedBy = ((req.user && req.user.username) || 'unknown') + '（Excel回导）';
      const applied = { approved: 0, rejected: 0 };
      ['functions', 'intents', 'utterances'].forEach((kind) => {
        (batch.rows[kind] || []).forEach((row) => {
          if (!row._review || !['approved', 'rejected'].includes(row._review.status)) return;
          row.status = row._review.status;
          row.reviewNote = row._review.note || '';
          row.reviewedAt = now;
          row.reviewedBy = reviewedBy;
          applied[row._review.status] += 1;
          delete row._review;
        });
      });
      if (!applied.approved && !applied.rejected) {
        fail('KNOWLEDGE_INTAKE_NO_REVIEW_MARKS', '该批次没有待采纳的业务审核结论', 400);
      }
      // 未标记父级的保守推导：直接下级全部已确认 → 确认；存在任何未确认 → 保持待确认交人工
      const derived = { intents: 0, functions: 0 };
      const uttsByRef = new Map();
      (batch.rows.utterances || []).forEach((u) => {
        const list = uttsByRef.get(u.intentRef) || [];
        list.push(u);
        uttsByRef.set(u.intentRef, list);
      });
      (batch.rows.intents || []).forEach((it) => {
        if (it.status !== 'pending') return;
        const kids = uttsByRef.get(it.ref) || [];
        if (kids.length && kids.every((u) => u.status === 'approved')) {
          it.status = 'approved';
          it.reviewedAt = now;
          it.reviewedBy = reviewedBy;
          it.reviewNote = '业务回导推导：全部说法已确认';
          derived.intents += 1;
        }
      });
      const intentsByPath = new Map();
      (batch.rows.intents || []).forEach((it) => {
        const list = intentsByPath.get(it.funcPath) || [];
        list.push(it);
        intentsByPath.set(it.funcPath, list);
      });
      // 深路径先推导：子功能先确认，父功能才能看到「直接下级全部已确认」
      (batch.rows.functions || []).slice()
        .sort((a, b) => String(b.path || '').split('/').length - String(a.path || '').split('/').length)
        .forEach((f) => {
          if (f.status !== 'pending') return;
          const kids = intentsByPath.get(f.path) || [];
          const subs = (batch.rows.functions || []).filter((x) => {
            const idx = String(x.path || '').lastIndexOf('/');
            return idx > 0 && x.path.slice(0, idx) === f.path;
          });
          const total = kids.length + subs.length;
          if (total && kids.every((it) => it.status === 'approved') && subs.every((s) => s.status === 'approved')) {
            f.status = 'approved';
            f.reviewedAt = now;
            f.reviewedBy = reviewedBy;
            f.reviewNote = '业务回导推导：下级全部已确认';
            derived.functions += 1;
          }
        });
      saveBatch(batch);
      return { batchId, applied, derived };
    }

    // ── 合并批次：把来源批次的行并回本批次（rowIdentityKey 去重，人工结论随行搬迁） ──
    if (req.method === 'POST' && routed.action === 'merge') {
      const sourceId = assertBatchId(String((routed.body && routed.body.sourceId) || ''));
      if (sourceId === batchId) fail('KNOWLEDGE_INTAKE_MERGE_SOURCE_INVALID', '来源批次不能是本批次', 400);
      const target = loadBatch(batchId);
      const source = loadBatch(sourceId);
      const now = new Date().toISOString();
      const reviewedBy = ((req.user && req.user.username) || 'unknown') + '（Excel合并）';
      const added = {};
      const updated = {};
      ['functions', 'intents', 'utterances'].forEach((kind) => {
        const keyOf = (row) => rowIdentityKey(kind, row);
        const index = new Map((target.rows[kind] || []).map((row) => [keyOf(row), row]));
        added[kind] = 0;
        updated[kind] = 0;
        (source.rows[kind] || []).forEach((sr) => {
          const t = index.get(keyOf(sr));
          if (t) {
            // 已存在：只搬来源的人工结论（已确认/已驳回），来源的待确认不覆盖目标的人工状态
            if (sr.status === 'approved' || sr.status === 'rejected') {
              if (t.status !== sr.status || (sr.reviewNote && sr.reviewNote !== t.reviewNote)) {
                t.status = sr.status;
                t.reviewNote = sr.reviewNote || '';
                t.reviewedAt = now;
                t.reviewedBy = reviewedBy;
                updated[kind] += 1;
              }
            }
          } else {
            target.rows[kind].push(sr);
            index.set(keyOf(sr), sr);
            added[kind] += 1;
          }
        });
      });
      fs.rmSync(path.join(INTAKE_DIR, sourceId), { recursive: true, force: true });
      saveBatch(target);
      return { batchId, sourceBatchId: sourceId, added, updated, sourceDeleted: true };
    }

    // ── 在线行编辑：新建 / 修改 / 删除（v4：Excel 之外的日常编辑通道，与导入同一套校验规则） ──
    if (req.method === 'POST' && routed.action === 'rows') {
      const payload = routed.body;
      const rowType = String(payload.rowType || '');
      if (!['functions', 'intents', 'utterances'].includes(rowType)) {
        fail('KNOWLEDGE_INTAKE_ROW_TYPE_INVALID', 'rowType 必须是 functions / intents / utterances', 400);
      }
      const batch = loadBatch(batchId);
      const row = normalizeRowInput(rowType, payload.row);
      const { errors, warnings: rowWarnings } = validateRow(rowType, row, batch, null);
      if (errors.length) fail('KNOWLEDGE_INTAKE_ROW_INVALID', '行校验未通过：' + errors.join('；'), 422);
      row.rowId = rowIdFor(rowType, row);
      if (findRow(batch, rowType, row.rowId)) fail('KNOWLEDGE_INTAKE_ROW_DUPLICATE', '相同内容的条目已存在：' + row.rowId, 409);
      // 两段式：在线编辑只产出待确认；业务侧状态值留 sourceStatus 供排前复核
      row.sourceStatus = row.status;
      row.status = 'pending';
      if (rowType === 'utterances') {
        const confidence = parseConfidence(row.confidence);
        row.confidence = confidence === null ? null : Math.round(confidence * 100) / 100;
      }
      if (rowType === 'intents') row.ref = row.funcPath + '/' + row.name;
      batch.rows[rowType].push(row);
      saveBatch(batch);
      return { batchId, rowType, row, warnings: rowWarnings.map((w) => w.message) };
    }

    if (req.method === 'PATCH' && routed.action.startsWith('rows/')) {
      const rowId = routed.action.slice('rows/'.length);
      const payload = routed.body || {};
      const batch = loadBatch(batchId);
      const kinds = ['functions', 'intents', 'utterances'];
      const kind = kinds.find((k) => findRow(batch, k, rowId));
      if (!kind) fail('KNOWLEDGE_INTAKE_ROW_NOT_FOUND', '条目不存在：' + rowId, 404);
      const original = findRow(batch, kind, rowId);
      // PATCH 语义：仅覆盖请求里出现的字段；业务状态初值取 sourceStatus（存量行的 status 是平台状态）
      const base = {};
      ROW_INPUT_FIELDS[kind].forEach((f) => {
        const value = f === 'status' ? original.sourceStatus : original[f];
        base[f] = value === undefined || value === null ? '' : value;
      });
      const mergedInput = Object.assign({}, base);
      ROW_INPUT_FIELDS[kind].forEach((f) => {
        if (payload.row && payload.row[f] !== undefined) mergedInput[f] = payload.row[f];
      });
      if (!(payload.row && payload.row.status !== undefined)) {
        mergedInput.status = businessStatusOrDefault(kind, mergedInput.status);
      }
      const updated = normalizeRowInput(kind, mergedInput);
      const { errors, warnings: rowWarnings } = validateRow(kind, updated, batch, rowId);
      if (errors.length) fail('KNOWLEDGE_INTAKE_ROW_INVALID', '行校验未通过：' + errors.join('；'), 422);
      const newRowId = rowIdFor(kind, updated);
      if (newRowId !== rowId) {
        const clash = kinds.some((k) => (batch.rows[k] || []).some((r) => r !== original && r.rowId === newRowId));
        if (clash) fail('KNOWLEDGE_INTAKE_ROW_DUPLICATE', '目标标识已存在，无法变更：' + newRowId, 409);
      }
      const cascaded = { functions: 0, intents: 0, utterances: 0 };
      const moves = [];
      const idMoves = [];
      const now = new Date().toISOString();
      const username = (req.user && req.user.username) || 'unknown';
      if (kind === 'functions' && rowIdentityKey(kind, updated) !== rowIdentityKey(kind, original)) {
        const oldPath = original.path;
        const newPath = updated.path;
        const movedFunctions = [{ row: original, from: oldPath, to: newPath }];
        batch.rows.functions.forEach((r) => {
          if (r !== original && r.path.startsWith(oldPath + '/')) {
            movedFunctions.push({ row: r, from: r.path, to: newPath + r.path.slice(oldPath.length) });
          }
        });
        const movingIds = new Set(movedFunctions.map((m) => m.row.rowId));
        movedFunctions.forEach((m) => {
          const hit = batch.rows.functions.find((r) => !movingIds.has(r.rowId) && r.rowId === 'f-' + sha12(m.to));
          if (hit) fail('KNOWLEDGE_INTAKE_ROW_DUPLICATE', '目标路径已有功能，无法移动：' + m.to, 409);
        });
        const movedIntents = [];
        batch.rows.intents.forEach((r) => {
          if (movedFunctions.some((m) => m.from === r.funcPath)) movedIntents.push({ row: r, to: '' });
        });
        movedIntents.forEach((m) => {
          m.to = movedFunctions.find((x) => x.from === m.row.funcPath).to;
          const targetRef = m.to + '/' + m.row.name;
          const hit = batch.rows.intents.find((r) => r !== m.row && r.rowId === 'i-' + sha12(targetRef));
          if (hit) fail('KNOWLEDGE_INTAKE_ROW_DUPLICATE', '目标位置已有意图，无法移动：' + targetRef, 409);
        });
        const refByOld = new Map(movedIntents.map((m) => [m.row.ref, m.to + '/' + m.row.name]));
        const movedUtterances = [];
        batch.rows.utterances.forEach((r) => {
          if (refByOld.has(r.intentRef)) movedUtterances.push({ row: r, to: refByOld.get(r.intentRef) });
        });
        movedUtterances.forEach((m) => {
          const targetId = 'u-' + sha12(m.to + ' ' + m.row.kind + ' ' + m.row.text);
          const hit = batch.rows.utterances.find((r) => r !== m.row && r.rowId === targetId);
          if (hit) fail('KNOWLEDGE_INTAKE_ROW_DUPLICATE', '目标位置已有说法，无法移动：' + m.row.text, 409);
        });
        moves.push(() => movedFunctions.forEach((m) => {
          const oldId = m.row.rowId;
          m.row.path = m.to;
          m.row.rowId = 'f-' + sha12(m.to);
          idMoves.push({ oldId, newId: m.row.rowId });
          if (m.row !== original && demoteForEdit(m.row)) cascaded.functions += 1;
        }));
        moves.push(() => movedIntents.forEach((m) => {
          const oldId = m.row.rowId;
          m.row.funcPath = m.to;
          m.row.ref = m.to + '/' + m.row.name;
          m.row.rowId = 'i-' + sha12(m.row.ref);
          idMoves.push({ oldId, newId: m.row.rowId });
          if (demoteForEdit(m.row)) cascaded.intents += 1;
        }));
        moves.push(() => movedUtterances.forEach((m) => {
          const oldId = m.row.rowId;
          m.row.intentRef = m.to;
          m.row.rowId = 'u-' + sha12(m.to + ' ' + m.row.kind + ' ' + m.row.text);
          idMoves.push({ oldId, newId: m.row.rowId });
          if (demoteForEdit(m.row)) cascaded.utterances += 1;
        }));
      } else if (kind === 'intents' && rowIdentityKey(kind, updated) !== rowIdentityKey(kind, original)) {
        const fromRef = original.funcPath + '/' + original.name;
        const toRef = updated.funcPath + '/' + updated.name;
        const movedUtterances = [];
        batch.rows.utterances.forEach((r) => {
          if (r.intentRef === fromRef) movedUtterances.push({ row: r, to: toRef });
        });
        movedUtterances.forEach((m) => {
          const targetId = 'u-' + sha12(m.to + ' ' + m.row.kind + ' ' + m.row.text);
          const hit = batch.rows.utterances.find((r) => r !== m.row && r.rowId === targetId);
          if (hit) fail('KNOWLEDGE_INTAKE_ROW_DUPLICATE', '目标位置已有说法，无法迁移：' + m.row.text, 409);
        });
        moves.push(() => movedUtterances.forEach((m) => {
          const oldId = m.row.rowId;
          m.row.intentRef = m.to;
          m.row.rowId = 'u-' + sha12(m.to + ' ' + m.row.kind + ' ' + m.row.text);
          idMoves.push({ oldId, newId: m.row.rowId });
          if (demoteForEdit(m.row)) cascaded.utterances += 1;
        }));
      }

      // 校验与冲突检查全部通过后落盘：先级联重定位，再更新本体
      moves.forEach((apply) => apply());
      const wasApproved = original.status === 'approved';
      const prevStatus = original.status;
      Object.assign(original, updated);
      original.rowId = newRowId;
      original.sourceStatus = updated.status;
      original.status = prevStatus;
      if (kind === 'intents') original.ref = original.funcPath + '/' + original.name;
      if (kind === 'utterances') {
        const confidence = parseConfidence(original.confidence);
        original.confidence = confidence === null ? null : Math.round(confidence * 100) / 100;
      }
      // 修订审计：人工编辑留痕（保存前前端已弹 diff 确认，此处记录实际生效的字段级变更）
      const editChanges = [];
      ROW_INPUT_FIELDS[kind].forEach((field) => {
        const before = base[field] === undefined || base[field] === null ? '' : String(base[field]);
        const after = updated[field] === undefined || updated[field] === null ? '' : String(updated[field]);
        if (before !== after) {
          editChanges.push({ rowId: newRowId, rowType: kind, op: 'modify', field, before, after, resolution: 'accepted', resolvedBy: username, resolvedAt: now });
        }
      });
      if (editChanges.length) {
        const titleOf = kind === 'functions' ? (updated.path || '') : kind === 'intents' ? (updated.funcPath + '/' + updated.name) : (updated.text || '');
        createRevision(batch, 'row-edit', '人工编辑「' + titleOf + '」', editChanges, username);
      }
      demoteForEdit(original);
      if (newRowId !== rowId) idMoves.push({ oldId: rowId, newId: newRowId });
      if (idMoves.length) remapRevisionRowIds(batch, idMoves);
      saveBatch(batch);
      return { batchId, rowType: kind, row: original, demoted: wasApproved, cascaded, warnings: rowWarnings.map((w) => w.message) };
    }

    if (req.method === 'DELETE' && routed.action.startsWith('rows/')) {
      const rowId = routed.action.slice('rows/'.length);
      const batch = loadBatch(batchId);
      const kinds = ['functions', 'intents', 'utterances'];
      const kind = kinds.find((k) => findRow(batch, k, rowId));
      if (!kind) fail('KNOWLEDGE_INTAKE_ROW_NOT_FOUND', '条目不存在：' + rowId, 404);
      const deleted = { functions: 0, intents: 0, utterances: 0 };
      if (kind === 'functions') {
        const root = findRow(batch, 'functions', rowId);
        const doomedPaths = new Set(batch.rows.functions
          .filter((r) => r.path === root.path || r.path.startsWith(root.path + '/'))
          .map((r) => r.path));
        const doomedRefs = new Set(batch.rows.intents.filter((r) => doomedPaths.has(r.funcPath)).map((r) => r.ref));
        deleted.functions = doomedPaths.size;
        deleted.intents = doomedRefs.size;
        deleted.utterances = batch.rows.utterances.filter((r) => doomedRefs.has(r.intentRef)).length;
        batch.rows.functions = batch.rows.functions.filter((r) => !doomedPaths.has(r.path));
        batch.rows.intents = batch.rows.intents.filter((r) => !doomedRefs.has(r.ref));
        batch.rows.utterances = batch.rows.utterances.filter((r) => !doomedRefs.has(r.intentRef));
      } else if (kind === 'intents') {
        const root = findRow(batch, 'intents', rowId);
        deleted.intents = 1;
        deleted.utterances = batch.rows.utterances.filter((r) => r.intentRef === root.ref).length;
        batch.rows.intents = batch.rows.intents.filter((r) => r.ref !== root.ref);
        batch.rows.utterances = batch.rows.utterances.filter((r) => r.intentRef !== root.ref);
      } else {
        deleted.utterances = 1;
        batch.rows.utterances = batch.rows.utterances.filter((r) => r.rowId !== rowId);
      }
      saveBatch(batch);
      return { batchId, deleted };
    }

    if (req.method === 'POST' && routed.action === 'expand-utterances') {
      const body = routed.body;
      const count = Math.min(Math.max(Number(body.count) || 5, 1), MAX_EXPAND_COUNT);
      const batch = loadBatch(batchId);
      const wanted = new Set(Array.isArray(body.intentItemIds) ? body.intentItemIds.map(String) : []);
      const intentRows = (batch.rows.intents || []).filter((row) => !wanted.size || wanted.has(row.rowId));
      if (!intentRows.length) fail('KNOWLEDGE_INTAKE_INTENTS_REQUIRED', '批次内没有可补全的意图', 400);
      if (intentRows.length > MAX_EXPAND_INTENTS) intentRows.length = MAX_EXPAND_INTENTS;
      const seedsByRef = new Map();
      (batch.rows.utterances || []).forEach((row) => {
        if (!seedsByRef.has(row.intentRef)) seedsByRef.set(row.intentRef, []);
        seedsByRef.get(row.intentRef).push(row.text);
      });
      const requestIntents = intentRows.map((row) => parseExpandRequest(row, seedsByRef.get(row.ref) || [], count));
      let backend;
      try {
        backend = await callBuilderAgent('/v1/utterance-expansion', { intents: requestIntents });
      } catch (error) {
        fail(error.code || 'KNOWLEDGE_INTAKE_EXPAND_FAILED', 'LLM 补全失败：' + error.message, 502);
      }
      const now = new Date().toISOString();
      const outcome = applyExpansionResults(batch, intentRows, backend.results || [], count, now);
      saveBatch(batch);
      return {
        batchId,
        requested: requestIntents.length,
        added: outcome.added,
        addedByIntent: outcome.addedByIntent,
        autoApproved: outcome.autoApproved,
        autoRejected: outcome.autoRejected,
        thresholds: { autoApprove: AUTO_APPROVE_CONFIDENCE, autoReject: AUTO_REJECT_CONFIDENCE },
        errors: (backend.results || []).filter((r) => r.status !== 'ok'),
        revision: outcome.revision ? { revId: outcome.revision.revId, createdAt: outcome.revision.createdAt, changes: outcome.revision.changes } : null,
      };
    }

    if (req.method === 'POST' && routed.action === 'preview-apply') {
      const body = routed.body;
      const asset = String(body.asset || 'intent-graph');
      const batch = loadBatch(batchId);
      const wanted = new Set(Array.isArray(body.itemIds) ? body.itemIds.map(String) : []);
      // 预览与入图共用同一份合并计算，杜绝两套逻辑漂移
      const { merged, validation } = await computeApply(batch, asset, wanted, req.headers.authorization || '');
      const valid = !!(validation && validation.valid);
      const CAP = 300;
      return {
        batchId,
        asset,
        valid,
        stats: merged.stats,
        validation,
        changes: merged.changes.slice(0, CAP),
        changesTotal: merged.changes.length,
        changesTruncated: merged.changes.length > CAP,
        skipped: merged.stats.skipped,
      };
    }

    if (req.method === 'POST' && routed.action === 'apply') {
      const body = routed.body;
      const asset = String(body.asset || 'intent-graph');
      const batch = loadBatch(batchId);
      const wanted = new Set(Array.isArray(body.itemIds) ? body.itemIds.map(String) : []);
      const { merged, validation } = await computeApply(batch, asset, wanted, req.headers.authorization || '');
      const valid = !!(validation && validation.valid);
      if (!valid) {
        return { batchId, asset, applied: false, saved: false, stats: merged.stats, validation };
      }
      await loopbackRequest('POST', '/api/org-graph/save', { asset, document: merged.document }, req.headers.authorization || '');
      fs.writeFileSync(journalPath(batchId), JSON.stringify({
        batchId,
        asset,
        appliedAt: new Date().toISOString(),
        stats: merged.stats,
        journal: merged.journal,
      }, null, 2), 'utf8');
      return {
        batchId,
        asset,
        applied: true,
        saved: true,
        stats: merged.stats,
        validation,
        rollbackable: true,
        hint: '已写入图谱草稿，请到图谱构建页复核后走发布审批；如需撤销可在本页回滚本次入图',
      };
    }

    if (req.method === 'POST' && routed.action === 'rollback') {
      const body = routed.body;
      const asset = String(body.asset || 'intent-graph');
      const journalFile = journalPath(batchId);
      if (!fs.existsSync(journalFile)) fail('KNOWLEDGE_INTAKE_NO_JOURNAL', '该批次没有入图记录，无法回滚', 404);
      let recorded;
      try {
        recorded = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
      } catch (error) {
        fail('KNOWLEDGE_INTAKE_JOURNAL_CORRUPT', '入图记录损坏：' + error.message, 500);
      }
      if (recorded.asset && recorded.asset !== asset) {
        fail('KNOWLEDGE_INTAKE_ASSET_MISMATCH', '入图记录针对资产「' + recorded.asset + '」，与请求的「' + asset + '」不一致', 400);
      }
      const authHeader = req.headers.authorization || '';
      const source = await loopbackRequest('GET', '/api/org-graph/load?asset=' + encodeURIComponent(asset), undefined, authHeader);
      const result = rollbackFromDocument(source, recorded.journal || {});
      const validation = await loopbackRequest('POST', '/api/org-graph/validate', { asset, document: result.document }, authHeader);
      const valid = !!(validation && validation.valid);
      if (!valid) {
        return { batchId, asset, rolledBack: false, saved: false, removed: result.removed, kept: result.kept, validation };
      }
      await loopbackRequest('POST', '/api/org-graph/save', { asset, document: result.document }, authHeader);
      try { fs.rmSync(journalFile, { force: true }); } catch (error) { /* 清理失败不影响回滚结果 */ }
      return {
        batchId,
        asset,
        rolledBack: true,
        saved: true,
        appliedAt: recorded.appliedAt,
        removed: result.removed,
        kept: result.kept,
        validation,
        hint: '已回滚并保存草稿，请到图谱构建页复核',
      };
    }

    if (req.method === 'POST' && routed.action === 'check-conflicts') {
      const body = routed.body;
      const batch = loadBatch(batchId);
      const wanted = new Set(Array.isArray(body.itemIds) ? body.itemIds.map(String) : []);
      const pendingUtterances = (batch.rows.utterances || []).filter((row) => {
        if (row.status !== 'pending') return false;
        return !wanted.size || wanted.has(row.rowId);
      });
      if (!pendingUtterances.length) fail('KNOWLEDGE_INTAKE_NOTHING_TO_CHECK', '批次内没有待审核的说法可预检', 400);
      const intentByRef = new Map((batch.rows.intents || []).map((row) => [row.ref, row]));
      const otherIntents = (batch.rows.intents || []).map((row) => ({ name: row.name, description: row.description }));
      const seedsByRef = new Map();
      (batch.rows.utterances || []).forEach((row) => {
        if (!seedsByRef.has(row.intentRef)) seedsByRef.set(row.intentRef, []);
        seedsByRef.get(row.intentRef).push(row.text);
      });
      const candidatesByRef = new Map();
      pendingUtterances.forEach((row) => {
        if (!candidatesByRef.has(row.intentRef)) candidatesByRef.set(row.intentRef, []);
        candidatesByRef.get(row.intentRef).push({ utteranceId: row.rowId, text: row.text });
      });
      const requests = [];
      candidatesByRef.forEach((candidates, ref) => {
        const intentRow = intentByRef.get(ref);
        if (!intentRow) return;
        if (requests.length >= MAX_CONFLICT_INTENTS) return;
        requests.push({
          intentId: ref,
          name: intentRow.name,
          description: intentRow.description,
          seedUtterances: (seedsByRef.get(ref) || []).slice(0, 30),
          candidateUtterances: candidates,
          otherIntents,
        });
      });
      if (!requests.length) fail('KNOWLEDGE_INTAKE_INTENT_ROWS_MISSING', '说法所属意图不在本批次，无法预检', 400);
      let backend;
      try {
        backend = await callBuilderAgent('/v1/utterance-conflict-check', { intents: requests });
      } catch (error) {
        fail(error.code || 'KNOWLEDGE_INTAKE_CONFLICT_BACKEND', '语义冲突预检失败：' + error.message, 502);
      }
      const now = new Date().toISOString();
      const verdictByUtterance = new Map();
      (backend.results || []).forEach((result) => {
        if (result.status !== 'ok') return;
        (result.verdicts || []).forEach((verdict) => {
          if (verdict && verdict.utteranceId) verdictByUtterance.set(String(verdict.utteranceId), verdict);
        });
      });
      let conflicts = 0;
      pendingUtterances.forEach((row) => {
        const verdict = verdictByUtterance.get(row.rowId);
        if (!verdict) return;
        row.conflict = {
          verdict: verdict.verdict === 'conflict' ? 'conflict' : 'fit',
          suspect: String(verdict.suspect || ''),
          reason: String(verdict.reason || ''),
          checkedAt: now,
        };
        if (row.conflict.verdict === 'conflict') conflicts += 1;
      });
      saveBatch(batch);
      return {
        batchId,
        requested: requests.length,
        checked: verdictByUtterance.size,
        conflicts,
        errors: (backend.results || []).filter((r) => r.status !== 'ok'),
      };
    }

    if (req.method === 'POST' && routed.action === 'skeleton-assist') {
      const batch = loadBatch(batchId);
      const skeleton = buildSkeletonForAssist(batch);
      if (!skeleton.functions.length) fail('KNOWLEDGE_INTAKE_SKELETON_EMPTY', '批次内没有功能骨架，无法评审', 400);
      let backend;
      try {
        backend = await callBuilderAgent('/v1/skeleton-assist', { product: String((routed.body && routed.body.product) || '手机银行个人业务'), functions: skeleton.functions });
      } catch (error) {
        fail(error.code || 'KNOWLEDGE_INTAKE_ASSIST_BACKEND', '骨架助手调用失败：' + error.message, 502);
      }
      const now = new Date().toISOString();
      const items = [];
      ASSIST_KINDS.forEach((kind) => {
        (backend[kind] || []).forEach((payload) => {
          items.push({ id: assistId(kind, payload), kind, payload, status: 'suggested' });
        });
      });
      batch.skeletonAssist = { generatedAt: now, items };
      saveBatch(batch);
      const summary = summarizeAssist(batch);
      return { batchId, generatedAt: now, ...summary.byKind, total: items.length };
    }

    if (req.method === 'GET' && routed.action === 'skeleton-assist') {
      const batch = loadBatch(batchId);
      const grouped = {};
      ASSIST_KINDS.forEach((kind) => { grouped[kind] = { label: ASSIST_LABEL[kind], items: [] }; });
      ((batch.skeletonAssist && batch.skeletonAssist.items) || []).forEach((item) => {
        if (grouped[item.kind]) grouped[item.kind].items.push(item);
      });
      return { batchId, generatedAt: batch.skeletonAssist ? batch.skeletonAssist.generatedAt : null, summary: summarizeAssist(batch), grouped };
    }

    if (req.method === 'POST' && routed.action === 'skeleton-assist/action') {
      const body = routed.body;
      const action = String(body.action || '');
      if (!['accept', 'dismiss'].includes(action)) {
        fail('KNOWLEDGE_INTAKE_ACTION_INVALID', 'action 必须是 accept / dismiss', 400);
      }
      const ids = new Set(Array.isArray(body.ids) ? body.ids.map(String) : []);
      if (!ids.size) fail('KNOWLEDGE_INTAKE_ITEMS_REQUIRED', '请提供 ids', 400);
      const batch = loadBatch(batchId);
      const now = new Date().toISOString();
      const reviewedBy = (req.user && req.user.username) || 'unknown';
      const results = [];
      (batch.skeletonAssist && batch.skeletonAssist.items || []).forEach((item) => {
        if (!ids.has(item.id)) return;
        if (action === 'dismiss') {
          item.status = 'dismissed';
          item.decidedAt = now;
          item.decidedBy = reviewedBy;
          results.push({ id: item.id, applied: false, dismissed: true });
          return;
        }
        const outcome = applyAssistSuggestion(batch, item, reviewedBy, now);
        item.status = outcome.applied === false ? 'suggested' : 'accepted';
        item.decidedAt = now;
        item.decidedBy = reviewedBy;
        if (outcome.applied === false) item.blockReason = outcome.reason;
        results.push({ id: item.id, ...outcome });
      });
      if (!results.length) fail('KNOWLEDGE_INTAKE_ITEMS_NOT_FOUND', '没有匹配到的建议条目', 404);
      saveBatch(batch);
      const blocked = results.filter((r) => r.applied === false && !r.dismissed).length;
      return { batchId, updated: results.length, blocked, results };
    }

    // ── 节点级字段内容审核（Word 式逐字段审核）：直接调用 LLM，审核当前节点各字段内容质量 ──
    if (req.method === 'POST' && routed.action === 'node-review') {
      const body = routed.body || {};
      const rowId = String(body.rowId || '');
      const rowType = String(body.rowType || '');
      const groupKey = String(body.groupKey || '');
      if (!rowId || !rowType) fail('KNOWLEDGE_INTAKE_PARAM_REQUIRED', 'rowId 和 rowType 必填', 400);
      if (!['functions', 'intents', 'utterances'].includes(rowType)) {
        fail('KNOWLEDGE_INTAKE_ROWTYPE_INVALID', 'rowType 必须是 functions/intents/utterances', 400);
      }

      const batch = loadBatch(batchId);
      const rows = (batch.rows && batch.rows[rowType]) || [];
      const row = rows.find(function (r) { return r.rowId === rowId; });
      if (!row) fail('KNOWLEDGE_INTAKE_ROW_NOT_FOUND', '未找到行：' + rowId, 404);

      var allFieldDefs = NODE_REVIEW_FIELDS[rowType];
      var typeLabel = NODE_TYPE_LABEL[rowType];

      // 按 groupKey 过滤字段：只审核指定分组的字段
      var fieldDefs;
      if (groupKey && NODE_REVIEW_GROUPS[rowType] && NODE_REVIEW_GROUPS[rowType][groupKey]) {
        var groupFieldKeys = NODE_REVIEW_GROUPS[rowType][groupKey];
        fieldDefs = allFieldDefs.filter(function (f) { return groupFieldKeys.includes(f.key); });
      } else {
        fieldDefs = allFieldDefs;
      }

      // 组装字段值清单（含字段说明和枚举字段的合法值提示）
      var fieldLines = fieldDefs.map(function (f) {
        var raw = row[f.readKey || f.key];
        var val = (raw === undefined || raw === null) ? '' : String(raw).trim();
        var line = '- ' + f.label + '（' + f.key + '）：' + (val || '（空）');
        if (f.hint) line += '  | 说明：' + f.hint;
        if (f.options && f.options.length) {
          line += '  [合法值：' + f.options.join('/') + ']';
        }
        return line;
      }).join('\n');

      // 提取节点关键上下文信息，帮助 LLM 理解当前审核的是什么节点
      var nodeName = row.name || row.text || '';
      var nodeDesc = row.description || '';
      var nodeFuncPath = row.funcPath || row.path || '';
      var nodeIntentRef = row.intentRef || '';
      var nodeAction = row.action || '';
      var nodeDomain = row.domain || '';
      var contextLine = '当前审核节点：' + nodeName;
      if (nodeFuncPath) contextLine += ' | 功能路径：' + nodeFuncPath;
      if (nodeDesc) contextLine += ' | 描述：' + nodeDesc;
      if (nodeIntentRef) contextLine += ' | 归属意图：' + nodeIntentRef;
      if (nodeAction) contextLine += ' | 动作类型：' + nodeAction;
      if (nodeDomain) contextLine += ' | 业务域：' + nodeDomain;

      var systemPrompt = '你是银行业务知识图谱审核专家。你的审核目标是：确保每个意图节点的字段内容能够最大化意图识别精度——即用户用各种说法表达时，系统能准确匹配到正确意图、避免误匹配到错误意图。'
        + '你必须严格结合当前节点的实际业务场景来审核每一个字段，为空字段生成的新值必须围绕该特定意图的业务含义编写。'
        + '你还需要对照图谱 Schema 的质量标准来判断字段内容是否达标。'
        + '审核意见必须用业务人员能理解的通俗语言表达。'
        + '输出严格 JSON，不输出任何解释文字或 markdown 标记。';

      var prompt = [
        '请逐字段审核以下' + typeLabel + '节点的字段内容质量。审核的核心目标是提升意图识别精度。',
        '',
        '═══════════════════════════════════════════',
        '当前审核节点上下文（所有审核意见必须基于此上下文）',
        '═══════════════════════════════════════════',
        contextLine,
        '',
        '请先仔细阅读上面的节点信息，理解该意图/功能的具体业务含义，然后再逐字段审核。',
        '为空字段生成的新值必须围绕该特定意图的业务场景编写，禁止使用其他意图的通用示例。',
        '',
        '═══════════════════════════════════════════',
        '节点类型：' + typeLabel + '（' + rowType + '）',
        '═══════════════════════════════════════════',
        '字段内容（每个字段附有 |说明 和 [合法值]，newValue 必须从合法值中选取）：',
        fieldLines,
        '',
        '═══════════════════════════════════════════',
        '图谱 Schema 质量标准（审核时对照判断）',
        '═══════════════════════════════════════════',
        '以下质量标准来自意图图谱架构 Schema，审核时请对照判断字段内容是否满足：',
        '',
        '【召回素材——直接影响意图识别精度】',
        '1. 别名列表（aliases）：',
        '   - 精确匹配=110分（最高权重），子串匹配=75分',
        '   - 至少3个，应覆盖正式名称、口语说法、场景化表达',
        '   - 质量直接决定精确召回率，不同意图不应共享相同别名（会导致歧义）',
        '   - 【词群家族覆盖】同一目标下用户会用不同词群表达（如查交易类：交易/流水/明细/进出账/消费记录/账目各算一个家族），',
        '     条目要摊开覆盖各家族，禁止一半以上挤在同一批同义词里',
        '   - 【操作家族覆盖】若该意图含办理/管理/设置属性，必须包含"怎么开通/怎么办理/怎么申请/怎么设置/怎么取消"等操作型说法，',
        '     否则模型会顺着已有别名全写成查询态',
        '   - 【菜单名/动作名禁入】不得照抄菜单名/动作名/页面标题作为别名（会造成跨意图模板串扰）',
        '   - 【说法长度约束】每条 2-24 字，无连续 3 位以上数字，不含具体卡号/金额/日期占位符',
        '   - 【跨意图标志性词汇隔离】不得包含其他意图标志性词汇（如转账类不出现"账单"，账单类不出现"转账"）',
        '2. 召回关键词（recallTerms）：',
        '   - 单个关键词命中=90分，每项2-40字符',
        '   - 与别名互补，覆盖更短的关键表达',
        '3. 多词组合（recallTermSets）：',
        '   - 全部词命中=100分（高于单关键词）',
        '   - 每组2-4个词，组内逗号分隔，组间分号分隔',
        '   - 适合需要多个关键词组合才能确定的意图',
        '4. 排除说法（negativeExamples）：',
        '   - 命中=负160分（扣分绝对值超过任何正向加分）',
        '   - 是降低误召回的最强手段，应列出最易混淆但不应命中的查询',
        '   - 不应与别名或召回关键词重叠',
        '5. 优先级权重（semanticPriority）：',
        '   - 0-100整数，仅在多词组合命中时才生效',
        '   - 当多个意图都能匹配时，优先级高的排前面',
        '',
        '【执行契约——影响意图能否正确执行】',
        '6. 执行模式（executionMode）：',
        '   - 知识应答类时，必需参数和系统能力绑定必须为空',
        '   - 读执行类且就绪状态为就绪时，系统能力绑定必须非空',
        '7. 风险等级（riskLevel）：纯查询通常L0-L1，涉及资金操作L2以上',
        '8. 就绪状态（readiness）：规划中时不应绑定具体系统能力',
        '',
        '【描述唯一性——防止向量空间稀释】',
        '9. 意图描述（description）：',
        '   - 描述必须跨意图唯一，禁止使用共享模板文案（如"该功能属于XX领域的手机银行功能"）',
        '   - 描述重复会稀释向量空间，导致语义召回时多个意图互相干扰',
        '   - 审核时如发现描述为通用模板套话，应标记为 incomplete 并给出贴合具体业务的唯一描述',
        '',
        '【说法（utterances）——扩展问可以多条】',
        '10. 标问=作为精确匹配的基准说法，每个意图1条',
        '   扩展问=补充更多用户表达变体，可以多条，越多越容易匹配到用户的实际问法',
        '   说法文本应与所属意图的召回素材语义相关',
        '',
        '═══════════════════════════════════════════',
        '审核要求',
        '═══════════════════════════════════════════',
        '1. 逐一检查每个字段的内容质量，关注以下问题类型：',
        '   - missing（缺失）：必填字段为空或仅有占位符',
        '   - incomplete（不完整）：内容过于简短或缺少关键信息',
        '   - inaccurate（不准确）：内容与银行业务常识不符或存在事实错误',
        '   - inconsistent（不一致）：字段之间互相矛盾',
        '   - style（规范）：命名不规范、描述未按三段式编写、用词不专业、格式不符合字段说明中的要求',
        '2. 只对有问题的字段给出审核意见，没有问题的字段不要输出',
        '3. issue 要简明说明问题所在，用业务人员能看懂的语言',
        '4. newValue 必须是该字段修改后的完整新值，用户点击采纳后会直接替换该字段内容，所以必须是可直接使用的最终内容',
        '5. 枚举字段（标注了 [合法值] 的字段）的 newValue 必须从合法值中选取',
        '6. suggestion 是对修改的简要说明（为什么改、改了什么），不是新的字段内容',
        '7. 不要对内容正确的字段给出建议或微调，只对确有问题的字段给出审核意见',
        '8. newValue 不能与当前字段值相同，如果无法给出更好的值则不要输出该条建议',
        '9. 格式校验：字段说明中标注了格式要求的，newValue 必须严格遵循该格式',
        '10. 跨字段一致性校验：',
        '    - 功能名称需与功能全路径末段一致',
        '    - 业务域需与功能路径首段匹配',
        '    - 菜单键需与业务域前缀一致',
        '    - 动作类型需与业务描述语义一致（查询类意图不应标为执行）',
        '    - 风险等级需与执行模式匹配（不可用类不应标L0，读执行类通常L0-L1）',
        '    - 就绪状态为规划中时不应绑定具体系统能力',
        '    - 业务对象标识需与业务对象一一对应',
        '    - 召回素材组不应有重复内容',
        '    - 排除说法不应与别名或召回关键词重叠',
        '    - 消歧提示应对应易混意图中的歧义场景',
        '    - 任务模式为单意图时最大任务数应为1',
        '11. 【最重要】newValue 内容必须与当前节点的实际业务场景一致：',
        '    - 仔细阅读上方的当前审核节点信息，理解该意图的具体业务含义',
        '    - 为空字段生成的新值必须围绕该特定意图的业务场景编写',
        '    - 例如：审核查询产品风险等级意图时，别名应写该理财是R几的,产品风险等级,这个产品稳不稳,会不会亏,风险评估',
        '    - 例如：审核转账意图时，召回关键词应写转账,汇款,转钱,转给',
        '    - 禁止使用与当前意图无关的通用银行示例作为 newValue',
        '12. 【关键】字段说明（|说明：后的文字）仅用于理解字段含义和格式要求，其中的示例仅为格式参考，',
        '    绝对不可将字段说明中的示例直接复制为 newValue。newValue 必须基于当前审核节点的实际业务内容生成。',
        '13. 【别名质量深度审核】审核 aliases 时，除基本数量检查外，还需检查：',
        '    - 词群家族覆盖：别名是否覆盖了用户常用的不同词群表达（如交易/流水/明细/进出账），',
        '      若一半以上是同一词群的同义词，应标记 incomplete 并补充其他词群',
        '    - 操作家族覆盖：若该意图含办理/管理/设置属性，别名是否包含"怎么开通/怎么办理/怎么申请"等操作型说法，',
        '      若全是查询态表达，应标记 incomplete 并补充操作型说法',
        '    - 菜单名/动作名混入：别名中是否有照抄菜单名/页面标题的条目，若有应标记 style 并建议替换为用户自然说法',
        '    - 跨意图标志性词汇混入：别名中是否出现其他意图的标志性词汇（如账单类意图出现"转账"），若有应标记 inaccurate',
        '    - 说法长度：别名条目是否在 2-24 字范围内，是否有连续 3 位以上数字，若有应标记 style',
        '14. 【描述唯一性审核】审核 description 时，需检查：',
        '    - 描述是否为通用模板套话（如"该功能属于XX领域的手机银行功能"），若是应标记 incomplete',
        '    - 描述必须贴合当前意图的具体业务含义，与其他意图区分开',
        '',
        '输出格式（严格 JSON，不要 markdown 代码块）：',
        '{"reviews":[{"field":"字段key","issueType":"missing|incomplete|inaccurate|inconsistent|style","issue":"问题描述","suggestion":"修改说明","newValue":"该字段修改后的完整新值","severity":"error|warning|info"}]}',
        '如果没有发现问题，输出：{"reviews":[]}',
      ].join('\n');

      var llmRaw;
      try {
        llmRaw = await callLLMJson(prompt, systemPrompt, { maxTokens: 12000 });
      } catch (error) {
        fail(error.code || 'KNOWLEDGE_INTAKE_NODE_REVIEW_LLM', 'AI 审核服务调用失败：' + error.message, 502);
      }

      // 解析 LLM 返回的 JSON（可能包裹在 markdown 代码块中）
      var cleaned = String(llmRaw || '').replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
      var parsed;
      try {
        parsed = JSON.parse(cleaned);
      } catch (e) {
        fail('KNOWLEDGE_INTAKE_NODE_REVIEW_PARSE', 'AI 审核结果解析失败', 502);
      }

      var rawReviews = Array.isArray(parsed.reviews) ? parsed.reviews : (Array.isArray(parsed) ? parsed : []);
      var validFieldKeys = new Set(fieldDefs.map(function (f) { return f.key; }));
      var now = new Date().toISOString();
      var items = [];

      rawReviews.forEach(function (rv) {
        var field = String(rv.field || '').trim();
        if (!field || !validFieldKeys.has(field)) return; // 丢弃字段名不匹配的
        var fieldDef = fieldDefs.find(function (f) { return f.key === field; });
        var issue = String(rv.issue || rv.problem || '').trim();
        var suggestion = String(rv.suggestion || rv.suggest || '').trim();
        var newValue = String(rv.newValue || rv.new_value || rv.value || '').trim();
        if (!issue && !suggestion) return;
        // 枚举字段：newValue 必须在合法值范围内，否则丢弃 newValue
        if (fieldDef && fieldDef.options && fieldDef.options.length && newValue) {
          if (!fieldDef.options.includes(newValue)) {
            newValue = '';
          }
        }
        // newValue 与当前值相同则丢弃（无法提供更好的值）
        var currentVal = row[fieldDef.readKey || fieldDef.key];
        currentVal = (currentVal === undefined || currentVal === null) ? '' : String(currentVal).trim();
        if (newValue && newValue === currentVal) {
          newValue = '';
        }
        // 没有 newValue 也没有 issue 的跳过
        if (!newValue && !issue) return;
        var severity = ['error', 'warning', 'info'].includes(String(rv.severity || '').trim()) ? String(rv.severity).trim() : 'warning';
        var issueType = String(rv.issueType || rv.type || 'style').trim();
        items.push({
          id: 'nr-' + sha12(rowId + field + issueType + suggestion),
          kind: 'node-review',
          payload: {
            field: field,
            fieldLabel: (fieldDef || {}).label || field,
            issueType: issueType,
            issue: issue,
            suggestion: suggestion,
            newValue: newValue,
            severity: severity,
          },
          status: 'suggested',
        });
      });

      return { batchId: batchId, rowId: rowId, rowType: rowType, items: items, generatedAt: now };
    }

    if (req.method === 'GET' && routed.action === 'acceptance') {
      const batch = loadBatch(batchId);
      return buildAcceptanceReport(batch);
    }

    if (req.method === 'DELETE' && !routed.action) {
      const batchId2 = assertBatchId(batchId);
      const dir = path.join(INTAKE_DIR, batchId2);
      if (!fs.existsSync(dir)) fail('KNOWLEDGE_INTAKE_BATCH_NOT_FOUND', '批次不存在：' + batchId2, 404);
      fs.rmSync(dir, { recursive: true, force: true });
      return { batchId: batchId2, deleted: true };
    }
  }

  fail('KNOWLEDGE_INTAKE_ROUTE_NOT_FOUND', '接口不存在：' + req.method + ' ' + pathname, 404);
}

// ── 导出：一体化填写大表（一行一条说法，功能/意图属性就近向下填充），业务人员可查看审核并回导 ──

// 导出在模板列之后追加的审核列：默认回导只认模板列、这些列忽略；
// 回导方显式「采纳业务审核结论」时，批次标识/意图标识用于对回原批次，确认状态+意见落库为人工审核记录
const EXPORT_EXTRA_COLUMNS = [
  { key: 'confirmState', name: '平台确认状态' },
  { key: 'iref', name: '意图标识' },
  { key: 'reviewNote2', name: '平台审核意见' },
  { key: 'srcBatch', name: '批次标识' },
];
const CONFIRM_LABELS = { approved: '已确认', pending: '待确认', rejected: '已驳回' };

function exportFlatRows(batch) {
  const blankRow = () => {
    const r = {};
    FLAT_COLUMNS.concat(EXPORT_EXTRA_COLUMNS).forEach((c) => { r[c.key] = ''; });
    r.srcBatch = batch.batchId;
    return r;
  };
  const biz = (kind, row) => businessStatusOrDefault(kind, row.sourceStatus || row.status);
  const funcs = (batch.rows && batch.rows.functions || []).slice().sort((a, b) => String(a.path || '').localeCompare(String(b.path || '')));
  const intents = batch.rows && batch.rows.intents || [];
  const intentsByFunc = new Map();
  intents.forEach((it) => {
    const list = intentsByFunc.get(it.funcPath) || [];
    list.push(it);
    intentsByFunc.set(it.funcPath, list);
  });
  const uttsByRef = new Map();
  (batch.rows && batch.rows.utterances || []).forEach((u) => {
    const list = uttsByRef.get(u.intentRef) || [];
    list.push(u);
    uttsByRef.set(u.intentRef, list);
  });
  const out = [];
  const fillUtterance = (r, u) => {
    r.kind = u.kind || '标问';
    r.text = u.text || '';
    r.source = u.source || '';
    r.confidence = u.confidence === null || u.confidence === undefined ? '' : String(u.confidence);
    r.ustatus = biz('utterances', u);
    r.note = u.note || '';
    r.confirmState = CONFIRM_LABELS[u.status] || '待确认';
    r.iref = u.intentRef || '';
    r.reviewNote2 = u.reviewNote || '';
  };
  funcs.forEach((f) => {
    const myIntents = (intentsByFunc.get(f.path) || []).slice().sort((a, b) => String(a.ref || '').localeCompare(String(b.ref || '')));
    if (!myIntents.length) {
      // 纯功能登记行（无意图）：flatToRaw 支持回导
      const r = blankRow();
      r.path = f.path;
      r.fname = f.name || '';
      r.fdesc = f.description || '';
      r.clientClass = f.clientClass || '';
      r.securityLevel = f.securityLevel || '';
      r.department = f.department || '';
      r.fstatus = biz('functions', f);
      r.fdomain = f.domain || '';
      r.fmenuKey = f.menuKey || '';
      r.note = f.note || '';
      r.confirmState = CONFIRM_LABELS[f.status] || '待确认';
      r.reviewNote2 = f.reviewNote || '';
      out.push(r);
      return;
    }
    myIntents.forEach((it) => {
      // 意图定义行（说法文本为空时仅登记意图，flatToRaw 支持回导）
      const r = blankRow();
      r.path = f.path;
      r.fname = f.name || '';
      r.fdesc = f.description || '';
      r.clientClass = f.clientClass || '';
      r.securityLevel = f.securityLevel || '';
      r.department = f.department || '';
      r.fstatus = biz('functions', f);
      r.fdomain = f.domain || '';
      r.fmenuKey = f.menuKey || '';
      r.iname = it.name || '';
      r.intentType = it.intentType || '';
      r.idesc = it.description || '';
      r.igoal = it.goal || '';
      r.triggerScene = it.triggerScene || '';
      r.scopeIn = it.scopeIn || '';
      r.scopeOut = it.scopeOut || '';
      r.roles = it.roles || '';
      r.iconfusable = it.confusableIntents || '';
      r.businessObjects = it.businessObjects || '';
      r.keySlots = it.keySlots || '';
      r.answerForm = it.answerForm || '';
      r.heat = it.heat || '';
      r.aliases = it.aliases || '';
      r.recallTerms = it.recallTerms || '';
      r.recallTermSets = it.recallTermSets || '';
      r.negativeExamples = it.negativeExamples || '';
      r.semanticPriority = it.semanticPriority || '';
      r.disambiguationHints = it.disambiguationHints || '';
      r.executionMode = it.executionMode || '';
      r.riskLevel = it.riskLevel || '';
      r.readiness = it.readiness || '';
      r.requiredSlots = it.requiredSlots || '';
      r.capabilityBindings = it.capabilityBindings || '';
      r.businessObjectId = it.businessObjectId || '';
      r.taskPolicyShapes = it.taskPolicyShapes || '';
      r.taskPolicyMode = it.taskPolicyMode || '';
      r.taskPolicyMaxTasks = it.taskPolicyMaxTasks || '';
      r.contextPolicyRetain = it.contextPolicyRetain || '';
      r.contextPolicySwitch = it.contextPolicySwitch || '';
      r.contextPolicyResumable = it.contextPolicyResumable || '';
      r.responsePolicy = it.responsePolicy || '';
      r.orchestrationMode = it.orchestrationMode || '';
      r.lifecycle = it.lifecycle || '';
      r.semanticVersion = it.semanticVersion || '';
      r.owner = it.owner || '';
      r.sourceChannel = it.sourceChannel || '';
      r.sourceMenuId = it.sourceMenuId || '';
      r.sourceActionId = it.sourceActionId || '';
      r.istatus = biz('intents', it);
      r.idomain = it.domain || '';
      r.imenuKey = it.menuKey || '';
      r.iaction = it.action || '';
      r.isourceAction = it.sourceAction || '';
      r.note = it.note || '';
      r.iref = it.ref || `${it.funcPath}/${it.name}`;
      r.confirmState = CONFIRM_LABELS[it.status] || '待确认';
      r.reviewNote2 = it.reviewNote || '';
      const utts = uttsByRef.get(it.ref) || [];
      if (!utts.length) {
        out.push(r);
        return;
      }
      utts.forEach((u, j) => {
        // 功能/意图属性只在第一行填，其余行留空 = 向下填充语义；全路径每行都带（回导的挂接键）
        const ur = j === 0 ? r : blankRow();
        ur.path = f.path;
        fillUtterance(ur, u);
        if (j > 0) ur.iref = u.intentRef || '';
        out.push(ur);
      });
    });
  });
  return out;
}

function buildBatchExport(batchId) {
  const batch = loadBatch(batchId);
  const columns = FLAT_COLUMNS.concat(EXPORT_EXTRA_COLUMNS);
  const header = columns.map((c) => c.name);
  const rows = exportFlatRows(batch).map((r) => columns.map((c) => r[c.key] || ''));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([header, ...rows]), FLAT_SHEET);
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const name = String(batch.domain || batch.fileName || batchId).replace(/[\\/:*?"<>|]/g, '-');
  return { buffer, fileName: `${name}-一体化填写.xlsx` };
}

function buildBlankTemplate() {
  var wb = XLSX.utils.book_new();
  var addDV = function (ws, options, ci, rowCount) {
    ws['!dataValidation'] = ws['!dataValidation'] || [];
    ws['!dataValidation'].push({
      type: 'list', allowBlank: true, showInputMessage: true, showErrorMessage: true,
      formula1: '"' + options.join(',') + '"',
      sqref: XLSX.utils.encode_cell({ r: 1, c: ci }) + ':' + XLSX.utils.encode_cell({ r: rowCount, c: ci }),
    });
  };
  var makeSheet = function (headers, options, widths) {
    var ws = XLSX.utils.aoa_to_sheet([headers]);
    ws['!cols'] = headers.map(function (_, i) { return { wch: widths ? widths[i] : 16 }; });
    if (options) {
      Object.keys(options).forEach(function (ci) {
        addDV(ws, options[ci], parseInt(ci, 10), 500);
      });
    }
    return ws;
  };

  // Sheet 1: 填表说明
  var instData = [
    ['意图图谱知识采集模板 — 填表说明'],
    [''],
    ['本模板包含 7 张数据表，请按顺序填写：'],
    ['1. 功能树 — 填写银行的业务功能层级结构'],
    ['2. 场景声明 — 为每个功能声明用户意图场景（查询/办理/修改/撤销/转账/还款/帮助等）'],
    ['3. 说法素材 — 填写用户可能的说法（标准别名、口语变体、召回词、负例）'],
    ['4. 信息收集项 — 填写执行场景需要收集的信息槽位（如金额、日期、账户等）'],
    ['5. 常见问答 — 填写常见问题及标准答案'],
    ['6. 系统能力 — 填写意图的落地实现方式（调接口/技能编排/工作流/智能体/页面直达）'],
    ['7. 易混淆关系 — 填写容易混淆的意图对及消歧提示'],
    [''],
    ['注意事项：'],
    ['• 场景类型下拉选项：查询、办理、问答、修改、撤销、转账、还款、帮助'],
    ['• 执行方式下拉选项：直接执行、需确认、仅回答、多意图'],
    ['• 落地方式下拉选项：调接口、技能编排、工作流、智能体、页面直达、话术答复'],
    ['• 风险等级下拉选项：L0(无风险)、L1(低风险)、L2(中风险)、L3(高风险)'],
    ['• 功能名称和场景类型是各表之间的关联键，请保持一致'],
    ['• 示例行仅供参考，请删除后填写实际数据'],
  ];
  var ws1 = XLSX.utils.aoa_to_sheet(instData);
  ws1['!cols'] = [{ wch: 80 }];
  XLSX.utils.book_append_sheet(wb, ws1, '填表说明');

  // Sheet 2: 功能树
  var fHeaders = ['序号', '功能名称', '层级', '上级功能', 'App菜单路径', '业务说明', '范围内关键词', '范围外关键词', '导航词', '业务对象', '有无用户意图', '备注'];
  var ws2 = makeSheet(fHeaders, { 2: ['领域', '分类', '功能'], 10: ['有', '无'] }, [6, 20, 8, 20, 30, 40, 30, 30, 20, 20, 12, 20]);
  // 示例行
  XLSX.utils.sheet_add_aoa(ws2, [
    [1, '账户管理', '领域', '', '账户管理', '面向个人客户的账户开立、信息维护与余额查询等业务', '开户,销户,账户信息', '贷款,理财', '账户管理', '账户', '无', ''],
    [2, '余额查询', '功能', '账户管理', '账户管理/余额查询', '客户查询名下账户的当前余额与可用余额', '余额,账户余额', '明细,流水', '查余额', '账户', '有', ''],
    [3, '转账', '功能', '', '转账', '客户向他人银行账户发起资金转账交易', '转账,汇款', '理财,缴费', '转账', '账户', '有', ''],
  ], { origin: 'A2' });
  XLSX.utils.book_append_sheet(wb, ws2, '功能树');

  // Sheet 3: 场景声明
  var sHeaders = ['功能名称', '场景类型', '场景描述', '用户目标', '适用渠道', '执行方式', '需要确认', '风险等级', '备注'];
  var ws3 = makeSheet(sHeaders, { 1: ['查询', '办理', '问答', '修改', '撤销', '转账', '还款', '帮助'], 5: ['直接执行', '需确认', '仅回答', '多意图'], 6: ['是', '否'], 7: ['L0', 'L1', 'L2', 'L3'] }, [20, 10, 40, 30, 15, 12, 10, 10, 20]);
  XLSX.utils.sheet_add_aoa(ws3, [
    ['余额查询', '查询', '客户查询名下账户的当前余额与可用余额，支持多币种', '了解账户余额', 'APP,微信', '直接执行', '否', 'L0', ''],
    ['转账', '转账', '客户向他人银行账户发起资金转账交易', '完成转账操作', 'APP', '需确认', '是', 'L2', ''],
  ], { origin: 'A2' });
  XLSX.utils.book_append_sheet(wb, ws3, '场景声明');

  // Sheet 4: 说法素材
  var uHeaders = ['功能名称', '场景类型', '素材类型', '素材内容', '备注'];
  var ws4 = makeSheet(uHeaders, { 1: ['查询', '办理', '问答', '修改', '撤销', '转账', '还款', '帮助'], 2: ['标准别名', '口语变体', '召回词', '负例', '词组'] }, [20, 10, 12, 30, 20]);
  XLSX.utils.sheet_add_aoa(ws4, [
    ['余额查询', '查询', '标准别名', '查余额', ''],
    ['余额查询', '查询', '口语变体', '我还有多少钱', ''],
    ['余额查询', '查询', '召回词', '余额', ''],
    ['余额查询', '查询', '负例', '查贷款余额', '不属于本场景'],
  ], { origin: 'A2' });
  XLSX.utils.book_append_sheet(wb, ws4, '说法素材');

  // Sheet 5: 信息收集项
  var slHeaders = ['功能名称', '场景类型', '收集项序号', '收集项名称', '值类型', '是否必填', '追问话术', '原话关键词', '备注'];
  var ws5 = makeSheet(slHeaders, { 1: ['查询', '办理', '问答', '修改', '撤销', '转账', '还款', '帮助'], 4: ['文本', '金额', '日期', '手机号', '身份证号', '账号', '枚举'], 5: ['是', '否'] }, [20, 10, 10, 15, 10, 8, 25, 15, 20]);
  XLSX.utils.sheet_add_aoa(ws5, [
    ['转账', '转账', 1, '收款人', '文本', '是', '请问收款人姓名是？', '收款人', ''],
    ['转账', '转账', 2, '转账金额', '金额', '是', '请问转多少钱？', '金额', ''],
  ], { origin: 'A2' });
  XLSX.utils.book_append_sheet(wb, ws5, '信息收集项');

  // Sheet 6: 常见问答
  var qHeaders = ['序号', '关联功能', '关联场景', '问题', '答案', '备注'];
  var ws6 = makeSheet(qHeaders, null, [6, 20, 10, 40, 50, 20]);
  XLSX.utils.sheet_add_aoa(ws6, [
    [1, '余额查询', '查询', '每天可以查几次余额？', '余额查询没有次数限制，您可以随时查询。', ''],
  ], { origin: 'A2' });
  XLSX.utils.book_append_sheet(wb, ws6, '常见问答');

  // Sheet 7: 系统能力
  var cHeaders = ['序号', '关联功能', '关联场景', '能力名称', '落地方式', '对接系统/接口', '是否写操作', '风险等级', '备注'];
  var ws7 = makeSheet(cHeaders, { 4: ['调接口', '技能编排', '工作流', '智能体', '页面直达', '话术答复'], 6: ['是', '否'], 7: ['L0', 'L1', 'L2', 'L3'] }, [6, 20, 10, 20, 12, 25, 10, 10, 20]);
  XLSX.utils.sheet_add_aoa(ws7, [
    [1, '余额查询', '查询', '余额查询接口', '调接口', '核心系统/余额查询API', '否', 'L0', ''],
    [2, '转账', '转账', '转账交易', '调接口', '核心系统/转账API', '是', 'L3', ''],
  ], { origin: 'A2' });
  XLSX.utils.book_append_sheet(wb, ws7, '系统能力');

  // Sheet 8: 易混淆关系
  var cfHeaders = ['功能A', '场景A', '功能B', '场景B', '消歧提示', '混淆原因', '备注'];
  var ws8 = makeSheet(cfHeaders, { 1: ['查询', '办理', '问答', '修改', '撤销', '转账', '还款', '帮助'], 3: ['查询', '办理', '问答', '修改', '撤销', '转账', '还款', '帮助'] }, [20, 10, 20, 10, 30, 30, 20]);
  XLSX.utils.sheet_add_aoa(ws8, [
    ['余额查询', '查询', '明细查询', '查询', '余额查总额，明细查明细', '都涉及查询余额相关', ''],
  ], { origin: 'A2' });
  XLSX.utils.book_append_sheet(wb, ws8, '易混淆关系');

  var buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  return { buffer, fileName: '意图图谱知识采集模板.xlsx' };
}

function handleKnowledgeIntakeRequest(req, res) {
  if (!req.pathname || !req.pathname.startsWith('/api/knowledge-intake/')) return false;
  // 空白模板下载
  if (req.method === 'GET' && req.pathname === '/api/knowledge-intake/template') {
    (async () => {
      try {
        if (!authenticate(req, res)) return;
        const file = buildBlankTemplate();
        res.writeHead(200, {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(file.fileName),
          'Content-Length': file.buffer.length,
        });
        res.end(file.buffer);
      } catch (error) {
        const statusCode = error.statusCode || 500;
        if (statusCode >= 500) console.error('[knowledge-intake]', error);
        sendJson(res, statusCode, {
          success: false,
          error: { code: error.code || 'KNOWLEDGE_INTAKE_INTERNAL', message: error.message },
        });
      }
    })();
    return true;
  }
  // 导出：二进制响应，不走 JSON 封装
  if (req.method === 'GET' && /^\/api\/knowledge-intake\/batches\/[^/]+\/export$/.test(req.pathname)) {
    (async () => {
      try {
        if (!authenticate(req, res)) return;
        const batchId = decodeURIComponent(req.pathname.split('/')[4] || '');
        const file = buildBatchExport(batchId);
        res.writeHead(200, {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(file.fileName),
          'Content-Length': file.buffer.length,
        });
        res.end(file.buffer);
      } catch (error) {
        const statusCode = error.statusCode || 500;
        if (statusCode >= 500) console.error('[knowledge-intake]', error);
        sendJson(res, statusCode, {
          success: false,
          error: { code: error.code || 'KNOWLEDGE_INTAKE_INTERNAL', message: error.message },
        });
      }
    })();
    return true;
  }
  (async () => {
    try {
      if (!authenticate(req, res)) return;
      const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
      const pathname = req.pathname;
      let body = {};
      if ((req.method === 'POST' || req.method === 'PATCH') && pathname !== '/api/knowledge-intake/import') {
        body = await readJsonBody(req);
      }
      const data = await handleRequest(req, res, pathname, url, body);
      sendJson(res, 200, { success: true, data });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      if (statusCode >= 500) console.error('[knowledge-intake]', error);
      sendJson(res, statusCode, {
        success: false,
        error: { code: error.code || 'KNOWLEDGE_INTAKE_INTERNAL', message: error.message },
      });
    }
  })();
  return true;
}

module.exports = {
  handleKnowledgeIntakeRequest,
  validateSheets,
  validateRow,
  applyToIntakeDocument,
  rollbackFromDocument,
  classifyConfidence,
  buildBatchTree,
  normalizeBatchStatuses,
  buildAcceptanceReport,
  applyAssistSuggestion,
  buildSkeletonForAssist,
  applyExpansionResults,
  applyReviewAction,
  createRevision,
  remapRevisionRowIds,
  revisionOpenCount,
  parseWorkbook,
  flatToRaw,
  exportFlatRows,
  buildBatchExport,
  buildBlankTemplate,
  multiSheetToRaw,
  sheetToRows,
  INTENT_TYPE_MAP,
  FULFILLMENT_KIND_MAP,
  splitConfusable,
  UTTER_STATUS_MAP,
  FUNC_STATUS_MAP,
  INTENT_STATUS_MAP,
  AUTO_APPROVE_CONFIDENCE,
  AUTO_REJECT_CONFIDENCE,
  FUNC_SHEET,
  INTENT_SHEET,
  UTTER_SHEET,
  FLAT_SHEET,
};
