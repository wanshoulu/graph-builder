/**
 * 个人风控智能体 — 图谱工具层（Skill Tools）
 *
 * 设计原则（业界惯例：计算不交给 LLM）：
 *   LLM = 意图理解 + 工具编排 + 话术组织
 *   本层 = 确定性图算法（环检测/连通分量/多头统计/风险传播），实时读取图谱
 *
 * 图数据源：AI Harbor /api/org-graph/load?asset=personal-credit-risk（TTL 缓存 30s，图谱更新后自动生效）
 * 每个工具返回 { summary, entities, data }：
 *   summary  —— 给 LLM 的结论摘要（中文）
 *   entities —— 涉及的图谱实体名（供前端召回高亮）
 *   data     —— 结构化明细（供 LLM 引用）
 */
'use strict';

const HARBOR = 'http://127.0.0.1:' + (process.env.PORT || 3000);
const ASSET = 'personal-credit-risk';
const CACHE_TTL_MS = 30 * 1000;

let cache = { at: 0, doc: null, loading: null };

async function loadGraph() {
  if (cache.doc && Date.now() - cache.at < CACHE_TTL_MS) return cache.doc;
  /* 并发去重：缓存 Promise，避免同 TTL 窗口内多个工具同时触发重复 HTTP 请求 */
  if (cache.loading) return cache.loading;
  cache.loading = (async function () {
    const res = await fetch(HARBOR + '/api/org-graph/load?asset=' + ASSET);
    const j = await res.json();
    if (!res.ok || j.success === false) throw new Error('图谱加载失败: ' + ((j.error && j.error.message) || res.status));
    const doc = j.data || j;
    const nodeMap = {};
    (doc.nodes || []).forEach(function (n) { nodeMap[n.id] = n; });
    const adj = [];
    const radj = [];
    (doc.edges || []).forEach(function (e) {
      if (!nodeMap[e.source] || !nodeMap[e.target]) return;
      (adj[e.source] = adj[e.source] || []).push({ e: e, n: nodeMap[e.target] });
      (radj[e.target] = radj[e.target] || []).push({ e: e, n: nodeMap[e.source] });
    });
    cache = { at: Date.now(), doc: { nodes: doc.nodes || [], edges: doc.edges || [], nodeMap: nodeMap, adj: adj, radj: radj }, loading: null };
    return cache.doc;
  })();
  try {
    return await cache.loading;
  } finally {
    cache.loading = null;
  }
}

function P(n, k) { return (n && n.properties && n.properties[k]) != null ? n.properties[k] : ''; }
function nameOf(n) { return P(n, 'name') || (n ? n.id : '?'); }
function findBorrower(g, name) {
  const key = String(name || '').trim();
  return (g.nodes || []).find(function (n) {
    return n.type === 'BORROWER' && (nameOf(n) === key || String(P(n, 'customerCode')).toLowerCase() === key.toLowerCase());
  }) || null;
}
function neighbors(g, id) { return (g.adj[id] || []).concat(g.radj[id] || []); }

// ── 工具实现 ──────────────────────────────────────────────

// 1. 客户检索（姓名/客户号/标签模糊）
function searchCustomers(g, args) {
  const kw = String(args.keyword || '').trim().toLowerCase();
  if (!kw) return { summary: 'keyword 不能为空', entities: [], data: [] };
  const hits = g.nodes.filter(function (n) {
    if (n.type !== 'BORROWER') return false;
    return nameOf(n).toLowerCase().indexOf(kw) >= 0
      || String(P(n, 'customerCode')).toLowerCase().indexOf(kw) >= 0
      || (P(n, 'tags') || []).join(',').toLowerCase().indexOf(kw) >= 0;
  });
  return {
    summary: hits.length ? ('匹配到 ' + hits.length + ' 名借款人：' + hits.map(function (n) { return nameOf(n) + '(' + P(n, 'customerCode') + ')'; }).join('、')) : '没有匹配的借款人',
    entities: hits.map(nameOf),
    data: hits.map(function (n) { return { name: nameOf(n), code: P(n, 'customerCode'), tags: P(n, 'tags') || [] }; }),
  };
}

// 2. 客户全景画像（一跳邻居按关系分组）
function getCustomerProfile(g, args) {
  const b = findBorrower(g, args.name);
  if (!b) return { summary: '未找到借款人：' + args.name + '（可先调 search_customers）', entities: [], data: null };
  const groups = { 亲属: [], 任职单位: [], 关联企业: [], 资产: [], 贷款: [], 对外担保: [], 被担保: [], 共用联系方式: [], 风险标签: [] };
  const ents = [nameOf(b)];
  neighbors(g, b.id).forEach(function (x) {
    const t = x.e.type; const o = x.n;
    const nm = nameOf(o);
    if (t === 'IS_RELATIVE_OF') { groups.亲属.push(nm + '(' + (x.e.properties.relationDetail || '') + ')'); ents.push(nm); }
    else if (t === 'WORKS_AT') groups.任职单位.push(nm + '·' + (x.e.properties.title || ''));
    else if (t === 'IS_LEGAL_REP_OF') { groups.关联企业.push(nm + '(法人)'); ents.push(nm); }
    else if (t === 'SHAREHOLDER_OF') { groups.关联企业.push(nm + '(' + (x.e.properties.sharePercent || '?') + '%)'); ents.push(nm); }
    else if (t === 'OWNS_ASSET') { groups.资产.push(nm + '(' + P(o, 'valueWan') + '万,' + (x.e.properties.ownershipShare || 100) + '%)'); ents.push(nm); }
    else if (t === 'HAS_LOAN') { groups.贷款.push(P(o, 'name') + ':' + P(o, 'lender') + ' 余额' + P(o, 'balanceWan') + '万【' + P(o, 'status') + '】'); }
    else if (t === 'GUARANTEES') { groups.对外担保.push('为' + nm + '担保' + (x.e.properties.amountWan || '?') + '万'); ents.push(nm); }
    else if (t === 'SHARED_CONTACT') { groups.共用联系方式.push('与' + nm + '共用' + (x.e.properties.sharedType || '联系方式')); ents.push(nm); }
    else if (t === 'LABELED') { groups.风险标签.push(nm + '(' + P(o, 'severity') + ')'); ents.push(nm); }
  });
  // 被担保（GUARANTEES 入边）
  (g.radj[b.id] || []).forEach(function (x) {
    if (x.e.type === 'GUARANTEES') { groups.被担保.push(nameOf(x.n) + '为其担保' + (x.e.properties.amountWan || '?') + '万'); ents.push(nameOf(x.n)); }
  });
  // 贷款的逾期与抵押补全（按 loan ID 匹配，不依赖数组顺序）
  var loanInfo = {}; /* loanId → { text, overdues: [], secured: [] } */
  (g.adj[b.id] || []).forEach(function (x) {
    if (x.e.type !== 'HAS_LOAN') return;
    var L = x.n;
    loanInfo[L.id] = { text: groups.贷款[groups.贷款.length - 1] || '', overdues: [], secured: [] };
    (g.adj[L.id] || []).forEach(function (y) {
      if (y.e.type === 'HAS_OVERDUE') loanInfo[L.id].overdues.push(P(y.n, 'level') + (P(y.n, 'cured') ? '(已结清)' : '(未结清)'));
      if (y.e.type === 'SECURED_BY') loanInfo[L.id].secured.push(nameOf(y.n) + '(' + (y.e.properties.lienRank || 1) + '押)');
    });
  });
  /* 按 groups.贷款 顺序回写，安全匹配 */
  var loanIdx = 0;
  (g.adj[b.id] || []).forEach(function (x) {
    if (x.e.type !== 'HAS_LOAN') return;
    var info = loanInfo[x.n.id];
    if (!info || loanIdx >= groups.贷款.length) return;
    if (info.overdues.length) groups.贷款[loanIdx] += ' ⏰' + info.overdues.join(',');
    if (info.secured.length) groups.贷款[loanIdx] += ' 抵押:' + info.secured.join('、');
    loanIdx++;
  });
  const profile = {
    姓名: nameOf(b), 客户号: P(b, 'customerCode'), 年龄段: P(b, 'ageRange'), 职业: P(b, 'occupation'),
    年收入区间万元: P(b, 'incomeRange'), 近6月征信查询: P(b, 'creditQueryCount'), 近12月逾期: P(b, 'overdueCount12m'),
    在贷机构数: P(b, 'activeLoanOrgs'), 城市: P(b, 'province'), 标签: P(b, 'tags') || [],
  };
  const parts = Object.keys(groups).filter(function (k) { return groups[k].length; })
    .map(function (k) { return k + ': ' + groups[k].join('；'); });
  return {
    summary: '【' + nameOf(b) + '】征信查询' + P(b, 'creditQueryCount') + '次/在贷' + P(b, 'activeLoanOrgs') + '家/标签:' + ((P(b, 'tags') || []).join(',') || '无') + '。' + (parts.join('。') || '无关联记录'),
    entities: ents.filter(function (v, i, a) { return a.indexOf(v) === i; }),
    data: { profile: profile, relations: groups },
  };
}

// 3. 担保环检测（GUARANTEES 有向环，DFS 三色标记 + 环去重）
function findGuaranteeCycles(g) {
  const color = {}; const stack = []; const onStack = {}; const cycles = []; const seen = {};
  function dfs(u) {
    color[u] = 1; stack.push(u); onStack[u] = true;
    (g.adj[u] || []).forEach(function (x) {
      if (x.e.type !== 'GUARANTEES') return;
      const v = x.n.id;
      if (color[v] === 1) {
        const idx = stack.indexOf(v);
        const cyc = stack.slice(idx).map(function (id) { return g.nodeMap[id]; });
        const key = cyc.map(nameOf).sort().join('|');
        if (!seen[key]) { seen[key] = true; cycles.push(cyc); }
      } else if (color[v] === undefined) dfs(v);
    });
    stack.pop(); onStack[u] = false; color[u] = 2;
  }
  g.nodes.forEach(function (n) { if (n.type === 'BORROWER' && color[n.id] === undefined) dfs(n.id); });
  const ents = [];
  const data = cycles.map(function (cyc) {
    cyc.forEach(function (n) { ents.push(nameOf(n)); });
    // 环内每人的逾期/失联状态
    const members = cyc.map(function (n) {
      let state = [];
      neighbors(g, n.id).forEach(function (x) {
        if (x.e.type === 'LABELED') state.push(nameOf(x.n));
        if (x.e.type === 'HAS_LOAN') {
          (g.adj[x.n.id] || []).forEach(function (y) { if (y.e.type === 'HAS_OVERDUE') state.push(P(y.n, 'level') + '逾期'); });
        }
      });
      return { name: nameOf(n), 状态: state.join(',') || '正常' };
    });
    return { ring: cyc.map(nameOf).join(' → ') + ' → ' + nameOf(cyc[0]), members: members };
  });
  return {
    summary: data.length ? ('检测到 ' + data.length + ' 个担保环：' + data.map(function (c) { return c.ring; }).join('；')) : '未检测到担保环',
    entities: ents.filter(function (v, i, a) { return a.indexOf(v) === i; }),
    data: data,
  };
}

// 4. 多头借贷检测（lender 去重计数 + 余额合计；name 可选，缺省全量扫描）
function detectMultiHead(g, args) {
  const THRESHOLD = 3;
  function calc(b) {
    const lenders = {}; let balance = 0; const loans = [];
    (g.adj[b.id] || []).forEach(function (x) {
      if (x.e.type !== 'HAS_LOAN') return;
      const L = x.n; const lender = P(L, 'lender');
      if (P(L, 'status') === '结清') return;
      lenders[lender] = true; balance += Number(P(L, 'balanceWan')) || 0;
      loans.push(P(L, 'name') + '@' + lender + ':' + P(L, 'balanceWan') + '万');
    });
    return { name: nameOf(b), orgs: Object.keys(lenders).length, balanceWan: Math.round(balance * 10) / 10, queries: P(b, 'creditQueryCount'), loans: loans };
  }
  let rows = [];
  if (args && args.name) {
    const b = findBorrower(g, args.name);
    if (!b) return { summary: '未找到借款人：' + args.name, entities: [], data: [] };
    rows = [calc(b)];
  } else {
    rows = g.nodes.filter(function (n) { return n.type === 'BORROWER'; }).map(calc);
  }
  const flagged = rows.filter(function (r) { return r.orgs >= THRESHOLD; }).sort(function (a, b2) { return b2.orgs - a.orgs; });
  return {
    summary: flagged.length
      ? ('在贷机构 ≥' + THRESHOLD + ' 家的多头借贷客户 ' + flagged.length + ' 名：' + flagged.map(function (r) { return r.name + '(' + r.orgs + '家,' + r.balanceWan + '万,查询' + r.queries + '次)'; }).join('、'))
      : (args && args.name ? (rows[0].name + ' 在贷 ' + rows[0].orgs + ' 家，未达多头阈值(' + THRESHOLD + ')') : '无在贷机构 ≥' + THRESHOLD + ' 家的客户'),
    entities: flagged.map(function (r) { return r.name; }),
    data: flagged.length ? flagged : rows,
  };
}

// 5. 团伙欺诈识别（SHARED_CONTACT 连通分量 ≥2）
function detectFraudRings(g) {
  const parent = {};
  function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
  function uni(a, b) { a = find(a); b = find(b); if (a !== b) parent[a] = b; }
  g.nodes.forEach(function (n) { parent[n.id] = n.id; });
  const sharedPairs = [];
  g.edges.forEach(function (e) {
    if (e.type === 'SHARED_CONTACT') { uni(e.source, e.target); sharedPairs.push(e); }
  });
  const groups = {};
  g.nodes.forEach(function (n) {
    if (n.type !== 'BORROWER') return;
    const root = find(n.id);
    (groups[root] = groups[root] || []).push(n);
  });
  const ents = [];
  const data = [];
  Object.keys(groups).forEach(function (root) {
    if (groups[root].length < 2) return;
    const members = groups[root].map(function (n) {
      ents.push(nameOf(n));
      const tags = (P(n, 'tags') || []).join(',');
      return { name: nameOf(n), 标签: tags || '无' };
    });
    const shares = sharedPairs.filter(function (e) { return find(e.source) === root; })
      .map(function (e) { return nameOf(g.nodeMap[e.source]) + '↔' + nameOf(g.nodeMap[e.target]) + ' 共用' + (e.properties.sharedType || '联系方式') + '(' + (e.properties.sharedValue || '') + ')'; });
    // 共同任职单位
    const employers = {};
    groups[root].forEach(function (n) {
      (g.adj[n.id] || []).forEach(function (x) { if (x.e.type === 'WORKS_AT') employers[nameOf(x.n)] = (employers[nameOf(x.n)] || 0) + 1; });
    });
    const commonEmp = Object.keys(employers).filter(function (k) { return employers[k] >= 2; });
    commonEmp.forEach(function (k) { ents.push(k); });
    data.push({ members: members, shared: shares, commonEmployer: commonEmp });
  });
  return {
    summary: data.length
      ? ('识别到 ' + data.length + ' 个疑似团伙：' + data.map(function (d) {
          return d.members.map(function (m) { return m.name; }).join('/') + (d.commonEmployer.length ? '（同任职于' + d.commonEmployer.join('、') + '）' : '');
        }).join('；'))
      : '未发现共用联系方式的团伙信号',
    entities: ents.filter(function (v, i, a) { return a.indexOf(v) === i; }),
    data: data,
  };
}

// 6. 家族/企业关联链
function traceFamilyBusiness(g, args) {
  const b = findBorrower(g, args.name);
  if (!b) return { summary: '未找到借款人：' + args.name, entities: [], data: null };
  const ents = [nameOf(b)];
  const family = []; const companies = [];
  (g.radj[b.id] || []).concat(g.adj[b.id] || []).forEach(function (x) {
    if (x.e.type === 'IS_RELATIVE_OF' && x.n.type !== 'BORROWER') {
      const rel = { name: nameOf(x.n), relation: x.e.properties.relationDetail || '', roles: [] };
      ents.push(rel.name);
      (g.adj[x.n.id] || []).forEach(function (y) {
        if (y.e.type === 'IS_LEGAL_REP_OF') { rel.roles.push(nameOf(y.n) + ' 法人'); ents.push(nameOf(y.n)); }
        if (y.e.type === 'SHAREHOLDER_OF') { rel.roles.push(nameOf(y.n) + ' ' + (y.e.properties.sharePercent || '?') + '%'); ents.push(nameOf(y.n)); }
        if (y.e.type === 'GUARANTEES') { rel.roles.push('为' + nameOf(y.n) + '担保' + (y.e.properties.amountWan || '?') + '万'); }
      });
      family.push(rel);
    }
  });
  // 本人在企业的角色
  (g.adj[b.id] || []).forEach(function (x) {
    if (x.e.type === 'WORKS_AT' && x.n.type === 'COMPANY') { companies.push(nameOf(x.n) + '(' + (x.e.properties.title || '') + ')'); ents.push(nameOf(x.n)); }
    if (x.e.type === 'SHAREHOLDER_OF') { companies.push(nameOf(x.n) + ' 持股' + (x.e.properties.sharePercent || '?') + '%'); ents.push(nameOf(x.n)); }
    if (x.e.type === 'IS_LEGAL_REP_OF') { companies.push(nameOf(x.n) + ' 法人'); ents.push(nameOf(x.n)); }
  });
  return {
    summary: '【' + nameOf(b) + '】家族：' + (family.map(function (f) { return f.name + '(' + f.relation + (f.roles.length ? '，' + f.roles.join('，') : '') + ')'; }).join('；') || '无记录')
      + '。企业关联：' + (companies.join('；') || '无'),
    entities: ents.filter(function (v, i, a) { return a.indexOf(v) === i; }),
    data: { family: family, companies: companies },
  };
}

// 7. 风险标签传播（N 跳邻居的风险标签，含传播路径）
function propagateRisk(g, args) {
  const depth = Math.min(3, Math.max(1, Number(args.depth) || 2));
  const b = findBorrower(g, args.name);
  if (!b) return { summary: '未找到借款人：' + args.name, entities: [], data: [] };
  const visited = {}; visited[b.id] = 0;
  let frontier = [b.id];
  for (let d = 1; d <= depth; d++) {
    const next = [];
    frontier.forEach(function (id) {
      neighbors(g, id).forEach(function (x) {
        if (visited[x.n.id] === undefined) { visited[x.n.id] = d; next.push(x.n.id); }
      });
    });
    frontier = next;
  }
  const ents = [nameOf(b)];
  const hits = [];
  Object.keys(visited).forEach(function (id) {
    const n = g.nodeMap[id];
    (g.adj[id] || []).forEach(function (x) {
      if (x.e.type === 'LABELED') {
        hits.push({ risk: nameOf(x.n), severity: P(x.n, 'severity') || '中', holder: nameOf(n), hop: visited[id], path: nameOf(b) + (visited[id] > 0 ? ' —' + visited[id] + '跳→ ' + nameOf(n) : '(本人)') });
        ents.push(nameOf(n)); ents.push(nameOf(x.n));
      }
    });
  });
  const self = hits.filter(function (h) { return h.hop === 0; });
  const nearby = hits.filter(function (h) { return h.hop > 0; });
  return {
    summary: '【' + nameOf(b) + '】本人标签：' + (self.map(function (h) { return h.risk; }).join('、') || '无')
      + '；' + depth + ' 跳内关联风险：' + (nearby.length ? nearby.map(function (h) { return h.holder + '(' + h.hop + '跳)·' + h.risk; }).join('、') : '无'),
    entities: ents.filter(function (v, i, a) { return a.indexOf(v) === i; }),
    data: hits,
  };
}

// 8. 逾期与代偿链（本人贷款→逾期→担保人）
function getOverdueChain(g, args) {
  const b = findBorrower(g, args.name);
  if (!b) return { summary: '未找到借款人：' + args.name, entities: [], data: [] };
  const ents = [nameOf(b)];
  const chain = [];
  (g.adj[b.id] || []).forEach(function (x) {
    if (x.e.type !== 'HAS_LOAN') return;
    const L = x.n;
    (g.adj[L.id] || []).forEach(function (y) {
      if (y.e.type !== 'HAS_OVERDUE') return;
      const item = { loan: P(L, 'name'), lender: P(L, 'lender'), balanceWan: P(L, 'balanceWan'), overdue: P(y.n, 'name') + '/' + P(y.n, 'level') + (P(y.n, 'cured') ? '/已结清' : '/未结清'), guarantors: [] };
      (g.radj[b.id] || []).forEach(function (z) {
        if (z.e.type === 'GUARANTEES') { item.guarantors.push(nameOf(z.n) + '(' + (z.e.properties.amountWan || '?') + '万)'); ents.push(nameOf(z.n)); }
      });
      chain.push(item);
    });
  });
  // 本人作为担保人：被担保人逾期 → 本人代偿风险
  const contingent = [];
  (g.adj[b.id] || []).forEach(function (x) {
    if (x.e.type !== 'GUARANTEES') return;
    const ob = x.n;
    (g.adj[ob.id] || []).forEach(function (y) {
      if (y.e.type !== 'HAS_LOAN') return;
      (g.adj[y.n.id] || []).forEach(function (z) {
        if (z.e.type === 'HAS_OVERDUE' && !P(z.n, 'cured')) {
          contingent.push({ 被担保人: nameOf(ob), 贷款: P(y.n, 'name'), 逾期: P(z.n, 'name'), 担保金额: x.e.properties.amountWan || '?' });
          ents.push(nameOf(ob));
        }
      });
    });
  });
  return {
    summary: '【' + nameOf(b) + '】自身逾期 ' + chain.length + ' 笔' + (chain.length ? '（' + chain.map(function (c) { return c.lender + ' ' + c.overdue; }).join('；') + '）' : '')
      + (contingent.length ? '；存在担保代偿风险：' + contingent.map(function (c) { return '为' + c.被担保人 + '担保的' + c.贷款 + '已逾期'; }).join('、') : '；无担保代偿风险'),
    entities: ents.filter(function (v, i, a) { return a.indexOf(v) === i; }),
    data: { own: chain, contingent: contingent },
  };
}

// ── 工具注册表（LLM function-calling 定义 + 执行器）──
const TOOL_DEFS = [
  {
    type: 'function', function: {
      name: 'search_customers',
      description: '按姓名/客户号/标签关键词检索借款人。回答涉及具体客户的问题前，先用它确认客户存在（返回客户全名与客户号）',
      parameters: { type: 'object', properties: { keyword: { type: 'string', description: '姓名/客户号/标签关键词' } }, required: ['keyword'] },
    },
  },
  {
    type: 'function', function: {
      name: 'get_customer_profile',
      description: '获取借款人全景画像：基本属性、征信概览、亲属、任职、企业、资产、贷款明细（含逾期/抵押）、担保、共用联系方式、风险标签',
      parameters: { type: 'object', properties: { name: { type: 'string', description: '借款人姓名或客户号' } }, required: ['name'] },
    },
  },
  {
    type: 'function', function: {
      name: 'find_guarantee_cycles',
      description: '全图担保环检测（互保闭环），返回每个环的成员及其逾期/风险状态。适用于"担保环/互保"类问题',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function', function: {
      name: 'detect_multi_head',
      description: '多头借贷检测：在贷机构去重数、余额合计、征信查询次数。传 name 查单人，不传查全量（返回所有在贷机构≥3家的客户）',
      parameters: { type: 'object', properties: { name: { type: 'string', description: '借款人姓名（可选，缺省全量扫描）' } } },
    },
  },
  {
    type: 'function', function: {
      name: 'detect_fraud_rings',
      description: '团伙欺诈识别：基于"共用手机号/设备/地址"关系做连通分量聚类，输出疑似团伙成员、共用内容与共同任职单位',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function', function: {
      name: 'trace_family_business',
      description: '家族与企业关联链：亲属关系、亲属在家族企业的角色（法人/持股/担保）、本人企业任职持股。适用于"家族共债/关联企业"类问题',
      parameters: { type: 'object', properties: { name: { type: 'string', description: '借款人姓名或客户号' } }, required: ['name'] },
    },
  },
  {
    type: 'function', function: {
      name: 'propagate_risk',
      description: '关联风险传播：查询借款人本人及 N 跳关联人的风险标签（如"二度关联里谁有黑名单"）',
      parameters: { type: 'object', properties: { name: { type: 'string', description: '借款人姓名或客户号' }, depth: { type: 'integer', description: '传播跳数 1-3，默认 2' } }, required: ['name'] },
    },
  },
  {
    type: 'function', function: {
      name: 'get_overdue_chain',
      description: '逾期与代偿链：本人逾期贷款明细 + 作为担保人的被担保人逾期（或有负债）。适用于"逾期/代偿/处置"类问题',
      parameters: { type: 'object', properties: { name: { type: 'string', description: '借款人姓名或客户号' } }, required: ['name'] },
    },
  },
];

const TOOL_IMPLS = {
  search_customers: searchCustomers,
  get_customer_profile: getCustomerProfile,
  find_guarantee_cycles: findGuaranteeCycles,
  detect_multi_head: detectMultiHead,
  detect_fraud_rings: detectFraudRings,
  trace_family_business: traceFamilyBusiness,
  propagate_risk: propagateRisk,
  get_overdue_chain: getOverdueChain,
};

/** 执行工具（by name）→ { ok, result, durationMs } */
async function executeTool(name, args) {
  const t0 = Date.now();
  const impl = TOOL_IMPLS[name];
  if (!impl) return { ok: false, result: { summary: '未知工具: ' + name, entities: [], data: null }, durationMs: 0 };
  try {
    const g = await loadGraph();
    const result = impl(g, args || {});
    return { ok: true, result: result, durationMs: Date.now() - t0 };
  } catch (e) {
    return { ok: false, result: { summary: '工具执行失败: ' + e.message, entities: [], data: null }, durationMs: Date.now() - t0 };
  }
}

module.exports = { TOOL_DEFS, executeTool, loadGraph };
