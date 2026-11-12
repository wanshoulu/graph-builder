/**
 * 意图建模-图谱编辑器 — 组织图谱领域适配器（[multi-domain]）
 *
 * 把组织图谱构建能力（自动构建三件套 + G6 专家工作台 + 发布 pipeline）嵌入意图编辑器：
 *   - 渲染宿主：#orgView 容器（与意图三栏互斥显示）+ 顶栏 #orgBar（org 四视图 tab）
 *   - 意图领域零破坏：意图 inline 脚本仅加了 1 行 keydown 领域守卫（见 intent-graph-editor.html）
 *   - 引擎复用：OrgGraphSignals / OrgGraphModel / KnowledgeBuilderDataImport（UMD，无改动）
 *   - 后端复用：/api/org-graph/*（routes/org-graph.js，零改动）；发布即被日程 Agent 消费
 *
 * 领域切换状态机：
 *   switchDomain('org')   → 暂停意图 G6（S.g6 销毁，S.graph 内存态保留）→ 显示 #orgView → activate()
 *   switchDomain('intent')→ org 销毁 + dirty 自动保存草稿 → 恢复意图三栏 → renderAll() 重建意图 G6
 * 任一时刻最多 1 个 G6 实例。
 */

(function () {
  'use strict';

  // ── 领域全局（head 已声明 var DOMAIN={current:'intent'}；此处补齐切换与适配器入口） ──
  if (!window.DOMAIN) window.DOMAIN = { current: 'intent' };

  // ═══════════════ 意图领域开关（直接操作意图全局 S / renderAll，不修改意图脚本本身） ═══════════════
  var INTENT_ELEMENTS = ['wsPanel', 'resizeHandle1', 'gcanvasPanel', 'resizeHandle2', 'infoPanel'];

  function pauseIntent() {
    if (typeof S !== 'undefined' && S.g6) {
      try { S.g6.destroy(); } catch (e) {}
      S.g6 = null;
    }
    if (typeof S !== 'undefined') {
      S.selNodeId = null;
      S.selEdgeIdx = null;
      S.clipboard = null; // 防 org 领域 Ctrl+V 误触意图剪贴板（undo/redo 已由 keydown 领域守卫屏蔽）
    }
  }

  function resumeIntent() {
    INTENT_ELEMENTS.forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.style.display = '';
    });
    document.getElementById('intentBar').style.display = 'flex';
    document.getElementById('orgBar').style.display = 'none';
    document.getElementById('orgView').style.display = 'none';
    if (typeof renderAll === 'function') renderAll(); // 重建意图 G6（读内存 S.graph，状态完整恢复）
  }

  // ═══════════════ org 领域状态 ═══════════════
  var state = {
    activated: false,     // 首次激活时注入 DOM 并绑定事件
    templateId: 'org-people', // 图谱数据类型（org-people | customer-ecosystem，服务端资产化对应）
    document: null,       // 当前图文档（草稿或加载的版本）
    template: null,       // 当前资产模板（/template?asset=）
    status: null,         // 发布状态（/api/org-graph/status）
    view: 'home',
    autoMode: null,       // 'signals' | 'extract' | 'generate'
    autoPayload: null,    // 预览阶段的并入结果
    g6: null,             // G6 实例（与意图 S.g6 互斥存活）
    selectedNodeId: null,
    selectedEdgeId: null,
    dirty: false,         // 草稿未保存标记
  };

  var NODE_COLORS = { EMPLOYEE: '#2563eb', DEPARTMENT: '#7c3aed', PROJECT: '#0891b2' };
  var EDGE_STYLE = {
    REPORTS_TO: { stroke: '#64748b', lineDash: [4, 3], lineWidth: 1 },
    MEMBER_OF: { stroke: '#64748b', lineDash: [2, 3], lineWidth: 1 },
    PARTICIPATES_IN: { stroke: '#64748b', lineDash: [2, 3], lineWidth: 1 },
  };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ═══════════════ 模板驱动渲染辅助（org-people 与 customer-ecosystem 通用） ═══════════════
  function nodeTypeDef(type) {
    if (!state.template || !Array.isArray(state.template.node_types)) return null;
    return state.template.node_types.filter(function (t) { return t.type === type; })[0] || null;
  }

  function edgeTypeDef(type) {
    if (!state.template || !Array.isArray(state.template.edge_types)) return null;
    return state.template.edge_types.filter(function (t) { return t.type === type; })[0] || null;
  }

  function nodeColor(type) {
    var def = nodeTypeDef(type);
    if (def && def.style && def.style.color) return def.style.color;
    return NODE_COLORS[type] || '#94a3b8';
  }

  // ①数据接入卡片文案按资产切换（三件套/种子/消费说明 + 模板速查）
  function renderHomeCards() {
    var isCust = state.templateId === 'customer-ecosystem';
    if (isCust) {
      $('entry-sig-title').textContent = '① 画像 CSV 名册向导';
      $('entry-sig-desc').textContent = '粘贴对公客户画像 CSV（企业名称/行业/产业链/决策人…）→ 客户 + 决策人 + 任职边生成';
      $('entry-ext-title').textContent = '② 客户 360 文档抽取';
      $('entry-ext-desc').textContent = '粘贴客户 360 分析文档 → LLM 按客户生态 schema 抽取企业/决策人/关系';
      $('entry-gen-title').textContent = '③ 自然语言生成';
      $('entry-gen-desc').textContent = '一句话描述客户生态 → 模板感知智能体生成图谱初稿，逐条确认并入';
      $('entry-generate').style.display = ''; // generate 已泛化（模板感知智能体），所有资产可用
      $('seed-desc').textContent = '从真实数据一键建图：25 家对公客户画像 + 40 条企业关系（test-docs CSV），确定性建图并发布 v1。';
      $('btn-seed').textContent = '生成并发布客户生态种子图谱 v1';
      $('consume-desc').textContent = '发布后版本不可变、可回退。客户生态图谱当前由编辑器与 API 消费（schedule-agent 消费为员工图谱资产，互不影响）。';
    } else {
      $('entry-sig-title').textContent = '① 名册信号建边';
      $('entry-sig-desc').textContent = '上传名册 CSV/JSON → 结构边（汇报/部门/项目）+ 4 信号协作边自动生成';
      $('entry-ext-title').textContent = '② LLM 文档抽取';
      $('entry-ext-desc').textContent = '粘贴组织介绍/通讯录文档 → LLM 抽取实体关系，逐条确认并入';
      $('entry-gen-title').textContent = '③ LLM 自然语言生成';
      $('entry-gen-desc').textContent = '一句话描述组织 → 模板感知智能体生成图谱初稿，校验后可编辑发布';
      $('entry-generate').style.display = '';
      $('seed-desc').textContent = '预置 157 人银行总行 mock 种子图谱（seed 42），一键发布即可被日程 Agent 消费。';
      $('btn-seed').textContent = '生成并发布种子图谱 v1';
      $('consume-desc').textContent = '发布后无需重启服务器：日程管理 Agent 下一次请求即加载最新发布版本（active）。无发布版本时 Agent 回退到 mock 数据。';
    }
    renderTemplateCheat();
  }

  // ①数据接入·模板速查卡：模板驱动渲染（节点必填字段 + 边端点约束摘要）
  function renderTemplateCheat() {
    var box = $('template-cheat');
    if (!box) return;
    if (!state.template) {
      box.innerHTML = '<span class="muted">模板加载中…</span>';
      api('/template').then(function (t) { state.template = t; renderTemplateCheat(); }).catch(function () { box.innerHTML = '<span class="muted">模板加载失败</span>'; });
      return;
    }
    var t = state.template;
    var html = '<div style="display:flex;flex-wrap:wrap;gap:10px">';
    (t.node_types || []).forEach(function (nt) {
      var req = (nt.fields || []).filter(function (f) { return f.required; }).map(function (f) { return f.key; });
      html += '<div class="entry" style="flex:1;min-width:200px">' +
        '<span class="entry-title">' + esc(nt.type) + ' · ' + esc(nt.label || '') + '</span>' +
        '<span class="entry-desc">必填：' + (req.length ? req.join('、') : '—') + '；共 ' + (nt.fields || []).length + ' 字段</span></div>';
    });
    html += '</div><div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px">';
    (t.edge_types || []).forEach(function (et) {
      html += '<span style="background:var(--org-panel2);border:1px solid var(--org-border);border-radius:999px;padding:2px 10px;font-size:12px">' +
        esc(et.type) + '：' + esc((et.source_types || []).join('/')) + ' → ' + esc((et.target_types || []).join('/')) + '</span>';
    });
    html += '</div>';
    box.innerHTML = html;
  }

  // ── 名册向导 step 文案按资产 ──
  function renderSignalsStep() {
    var isCust = state.templateId === 'customer-ecosystem';
    if (isCust) {
      $('step-signals').querySelector('h2').textContent = '① 画像 CSV 名册向导';
      $('step-signals').querySelector('p').innerHTML = '粘贴对公客户画像 CSV（表头：客户编号,企业名称,行业分类,产业链位置,注册资本(万元),员工数,营收区间(万元),企业类型,上市情况,专精特新,资产负债率(%),营收增速(%),成立年份,所在省份,关键决策人,联系方式）或 JSON 数组。列名自动识别。';
      $('input-signals').placeholder = '客户编号,企业名称,行业分类,产业链位置,注册资本(万元),员工数,营收区间(万元),企业类型,上市情况,专精特新,资产负债率(%),营收增速(%),成立年份,所在省份,关键决策人,联系方式\nKH099,示例企业,新能源,中游,10000,500,50000-100000,民企,否,否,50.0,10.0,2015,广东,张三,020-8888XXXX';
    } else {
      $('step-signals').querySelector('h2').textContent = '① 名册信号建边';
      $('step-signals').querySelector('p').innerHTML = '粘贴名册 CSV（表头：id,name,empNo,department,deptName,team,rank,title,skills,managerId,email,phone,location,pinyin,aliases 等）或 JSON 数组。列名自动识别，可在下方映射调整。';
      $('input-signals').placeholder = 'id,name,empNo,department,deptName,team,rank,title,skills,managerId\nemp-001,王伟,A1001,tech,金融科技部,人工智能团队,高级经理,AI工程师,NLP;机器学习,emp-000';
    }
  }

  // ── Toast ──
  var toastTimer = null;
  function toast(msg, kind) {
    var el = $('toast');
    if (!el) return;
    el.textContent = msg;
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.style.display = '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.style.display = 'none'; }, 3200);
  }

  // ── API 封装（自动携带当前资产；服务端默认分支兜底，org-people 零回归） ──
  function api(pathname, opts) {
    opts = opts || {};
    var asset = state.templateId || 'org-people';
    var sep = pathname.indexOf('?') >= 0 ? '&' : '?';
    return fetch('/api/org-graph' + pathname + sep + 'asset=' + encodeURIComponent(asset), {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: opts.body ? JSON.stringify(Object.assign({ asset: asset }, opts.body)) : undefined,
    }).then(function (res) {
      return res.json().then(function (json) {
        if (!res.ok || !json.success) {
          var err = new Error((json.error && json.error.message) || ('HTTP ' + res.status));
          err.code = json.error && json.error.code;
          err.validation = json.validation;
          throw err;
        }
        return json.data;
      });
    });
  }

  // ═══════════════ 四视图 DOM 注入（原 org-graph-builder.html 的 main + toast） ═══════════════
  function buildOrgViewDOM() {
    var html = [
      '<main>',
      '<section id="view-home" class="view active">',
      '  <div class="cards">',
      '    <div class="card card-wide">',
      '      <div class="card-head"><h2>图谱状态</h2><button class="btn btn-sm" id="btn-refresh-status">刷新</button></div>',
      '      <div class="card-body" id="status-body"><span class="muted">加载中…</span></div>',
      '    </div>',
      '    <div class="card">',
      '      <div class="card-head"><h2>① 数据接入</h2></div>',
      '      <div class="card-body auto-entries">',
      '        <div class="entry">',
      '          <div class="entry-title" id="entry-sig-title">① 名册信号建边</div>',
      '          <div class="entry-desc" id="entry-sig-desc">上传名册 CSV/JSON → 结构边（汇报/部门/项目）+ 4 信号协作边自动生成</div>',
      '          <button class="btn" data-auto="signals">开始</button>',
      '        </div>',
      '        <div class="entry">',
      '          <div class="entry-title" id="entry-ext-title">② LLM 文档抽取</div>',
      '          <div class="entry-desc" id="entry-ext-desc">粘贴组织介绍/通讯录文档 → LLM 抽取实体关系，逐条确认并入</div>',
      '          <button class="btn" data-auto="extract">开始</button>',
      '        </div>',
      '        <div class="entry" id="entry-generate">',
      '          <div class="entry-title" id="entry-gen-title">③ LLM 自然语言生成</div>',
      '          <div class="entry-desc" id="entry-gen-desc">一句话描述组织 → LLM 生成图谱初稿，校验后可编辑发布</div>',
      '          <button class="btn" data-auto="generate">开始</button>',
      '        </div>',
      '      </div>',
      '    </div>',
      '    <div class="card">',
      '      <div class="card-head"><h2>种子数据</h2></div>',
      '      <div class="card-body">',
      '        <p class="muted" id="seed-desc">预置 157 人银行总行 mock 种子图谱（seed 42），一键发布即可被日程 Agent 消费。</p>',
      '        <button class="btn btn-warn" id="btn-seed">生成并发布种子图谱 v1</button>',
      '      </div>',
      '    </div>',
      '    <div class="card card-wide">',
      '      <div class="card-head"><h2>模板速查</h2></div>',
      '      <div class="card-body" id="template-cheat"><span class="muted">加载中…</span></div>',
      '    </div>',
      '    <div class="card">',
      '      <div class="card-head"><h2>③ 专家精修</h2></div>',
      '      <div class="card-body">',
      '        <p class="muted">G6 画布三栏工作台：节点/边手工建模、属性编辑、信号边重算。</p>',
      '        <button class="btn" id="btn-goto-workbench">进入工作台</button>',
      '      </div>',
      '    </div>',
      '    <div class="card">',
      '      <div class="card-head"><h2>消费说明</h2></div>',
      '      <div class="card-body">',
      '        <p class="muted" id="consume-desc">发布后无需重启服务器：日程管理 Agent 下一次请求即加载最新发布版本（active）。无发布版本时 Agent 回退到 mock 数据。</p>',
      '      </div>',
      '    </div>',
      '  </div>',
      '</section>',

      '<section id="view-auto" class="view">',
      '  <div class="wizard">',
      '    <div class="wizard-step" id="step-choose">',
      '      <h2>② 智能体构建</h2>',
      '      <p class="muted">粘贴任意内容——名册 CSV、客户文档、自然语言描述均可；智能体自动识别内容类型，抽取实体与关系，逐条确认后并入草稿。</p>',
      '      <textarea id="input-agent" rows="8" placeholder="示例1（名册）：&#10;id,name,empNo,department,deptName,team,title&#10;emp-001,王伟,A1001,tech,金融科技部,人工智能团队,高级工程师&#10;&#10;示例2（文档）：&#10;金融科技部下属人工智能团队，团队负责人李强（工号A0001），成员包括王伟（NLP专家）、张敏……手机银行改版项目由王伟、张敏参与……&#10;&#10;示例3（描述）：&#10;一家小型金融科技公司，CEO 张总管理研发部（李工、王工）和产品部（刘经理）……"></textarea>',
      '      <div class="muted" id="agent-detect">智能体识别：—（粘贴内容后自动识别）</div>',
      '      <div class="wizard-actions">',
      '        <button class="btn btn-primary" id="btn-agent-run">开始抽取</button>',
      '        <button class="btn btn-ghost" data-auto="signals">名册建边</button>',
      '        <button class="btn btn-ghost" data-auto="extract">文档抽取</button>',
      '        <button class="btn btn-ghost" data-auto="generate">描述生成</button>',
      '      </div>',
      '    </div>',
      '    <div class="wizard-step" id="step-signals" style="display:none">',
      '      <h2>① 名册信号建边</h2>',
      '      <p class="muted">粘贴名册 CSV（表头：id,name,empNo,department,deptName,team,rank,title,skills,managerId,email,phone,location,pinyin,aliases 等）或 JSON 数组。列名自动识别，可在下方映射调整。</p>',
      '      <textarea id="input-signals" rows="10" placeholder="id,name,empNo,department,deptName,team,rank,title,skills,managerId&#10;emp-001,王伟,A1001,tech,金融科技部,人工智能团队,高级经理,AI工程师,NLP;机器学习,emp-000"></textarea>',
      '      <div class="mapped-fields" id="mapped-fields"></div>',
      '      <div class="wizard-actions">',
      '        <button class="btn" id="btn-signals-preview">预览建边结果</button>',
      '        <button class="btn btn-ghost" data-goto="choose">返回</button>',
      '      </div>',
      '    </div>',
      '    <div class="wizard-step" id="step-extract" style="display:none">',
      '      <h2>② LLM 文档抽取</h2>',
      '      <p class="muted">粘贴组织介绍/通讯录文档（文本），LLM 按组织 schema 抽取员工/部门/项目与关系。</p>',
      '      <textarea id="input-extract" rows="10" placeholder="示例：金融科技部下属人工智能团队，团队负责人李强（工号A0001），成员包括王伟（NLP专家）、张敏……手机银行改版项目由王伟、张敏参与……"></textarea>',
      '      <div class="wizard-actions">',
      '        <button class="btn" id="btn-extract-run">开始抽取</button>',
      '        <button class="btn btn-ghost" data-goto="choose">返回</button>',
      '      </div>',
      '      <div id="extract-progress" class="muted" style="display:none">LLM 抽取中（约 20-60 秒）…</div>',
      '    </div>',
      '    <div class="wizard-step" id="step-generate" style="display:none">',
      '      <h2>③ LLM 自然语言生成</h2>',
      '      <p class="muted">一句话描述组织，LLM 生成图谱初稿（schema 约束 + 校验报告）。</p>',
      '      <textarea id="input-generate" rows="6" placeholder="示例：一家小型金融科技公司，CEO 张总管理研发部（李工、王工）和产品部（刘经理），研发部负责智能投顾项目……"></textarea>',
      '      <div class="wizard-actions">',
      '        <button class="btn" id="btn-generate-run">生成初稿</button>',
      '        <button class="btn btn-ghost" data-goto="choose">返回</button>',
      '      </div>',
      '      <div id="generate-progress" class="muted" style="display:none">LLM 生成中（约 30-90 秒）…</div>',
      '    </div>',
      '    <div class="wizard-step" id="step-preview" style="display:none">',
      '      <h2 id="preview-title">预览确认</h2>',
      '      <div id="preview-summary" class="summary"></div>',
      '      <div id="preview-list" class="preview-list"></div>',
      '      <div class="wizard-actions">',
      '        <button class="btn btn-primary" id="btn-preview-merge">确认并入草稿</button>',
      '        <button class="btn btn-ghost" id="btn-preview-discard">放弃</button>',
      '      </div>',
      '    </div>',
      '  </div>',
      '</section>',

      '<section id="view-workbench" class="view">',
      '  <div class="workbench">',
      '    <aside class="panel-left">',
      '      <div class="panel-head">',
      '        <h3>节点</h3>',
      '        <div class="panel-tools" id="node-add-buttons"></div>',
      '      </div>',
      '      <div class="panel-body" id="node-tree"></div>',
      '    </aside>',
      '    <div class="canvas-wrap">',
      '      <div class="canvas-toolbar">',
      '        <span class="muted" id="wb-stats"></span>',
      '        <span class="spacer"></span>',
      '        <button class="btn btn-sm" id="btn-recalc">重算信号边</button>',
      '        <button class="btn btn-sm btn-primary" id="btn-save-draft">保存草稿</button>',
      '      </div>',
      '      <div id="g6-canvas"></div>',
      '    </div>',
      '    <aside class="panel-right">',
      '      <div class="panel-head"><h3 id="inspector-title">检查器</h3></div>',
      '      <div class="panel-body" id="inspector"><span class="muted">点击画布节点或从边表选择边进行编辑</span></div>',
      '      <div class="panel-head edge-head"><h3>协作边表</h3><button class="btn btn-sm" id="btn-add-collab">+协作边</button></div>',
      '      <div class="panel-body edge-table" id="edge-table"></div>',
      '    </aside>',
      '  </div>',
      '</section>',

      '<section id="view-publish" class="view">',
      '  <div class="publish">',
      '    <div class="card card-wide">',
      '      <div class="card-head"><h2>发布新版本</h2></div>',
      '      <div class="card-body">',
      '        <label class="field-label">变更说明</label>',
      '        <input type="text" id="publish-note" placeholder="如：新增零售业务部 3 名员工、调整协作边权重">',
      '        <div class="publish-actions">',
      '          <button class="btn" id="btn-validate">校验</button>',
      '          <button class="btn btn-primary" id="btn-publish">发布</button>',
      '        </div>',
      '        <div id="validation-report" class="validation-report"></div>',
      '      </div>',
      '    </div>',
      '    <div class="card card-wide">',
      '      <div class="card-head"><h2>版本历史</h2></div>',
      '      <div class="card-body" id="version-list"><span class="muted">加载中…</span></div>',
      '    </div>',
      '  </div>',
      '</section>',
      '</main>',
      '<div id="toast" class="toast" style="display:none"></div>',
    ].join('');
    $('orgView').innerHTML = html;
  }

  // ═══════════════ 视图切换 ═══════════════
  function switchView(view) {
    state.view = view;
    document.querySelectorAll('#orgBar .org-tab').forEach(function (t) {
      t.classList.toggle('active', t.dataset.view === view);
    });
    document.querySelectorAll('#orgView .view').forEach(function (v) {
      v.classList.toggle('active', v.id === 'view-' + view);
    });
    if (view === 'home') { renderHomeCards(); refreshStatus(); }
    if (view === 'workbench') initWorkbench();
    if (view === 'publish') refreshPublish();
    if (window.IA) IA.renderStagePanel(view); // [IA] 阶段功能侧边栏随视图切换
  }

  // ═══════════════ 总览 ═══════════════
  function refreshStatus() {
    api('/status').then(function (s) {
      state.status = s;
      $('hdr-version').textContent = s.activeVersion || '未发布';
      $('hdr-version').style.display = s.activeVersion ? '' : 'none';
      var html = '';
      if (s.activeVersion) {
        var active = s.versions.filter(function (v) { return v.version === s.activeVersion; })[0] || {};
        html += '<p>当前版本 <b style="color:var(--org-accent)">' + esc(s.activeVersion) + '</b>' +
          '（' + (active.stats ? active.stats.nodes + ' 节点 / ' + active.stats.edges + ' 边' : '') + '）</p>' +
          '<p class="muted">发布于 ' + esc(active.published_at || '') + (active.note ? ' · ' + esc(active.note) : '') + '</p>';
      } else {
        html += '<p class="muted">尚无发布版本。可先用种子数据一键发布，或走自动构建/专家工作台。</p>';
      }
      html += '<p class="muted" style="margin-top:8px">' +
        (s.draft ? '草稿：' + s.draft.nodes + ' 节点 / ' + s.draft.edges + ' 边（' + esc(s.draft.updated_at || '') + '）'
                 : '草稿：无（工作台从空文档或已发布版本开始）') + '</p>';
      $('status-body').innerHTML = html;
      if (window.IA) IA.renderStagePanel(state.view); // [IA] 发布/状态面板数据刷新
    }).catch(function (e) { $('status-body').innerHTML = '<span style="color:var(--org-danger)">' + esc(e.message) + '</span>'; });
  }

  // ═══════════════ 向导 ═══════════════
  var WIZARD_STEPS = ['choose', 'signals', 'extract', 'generate', 'preview'];
  function showStep(step) {
    WIZARD_STEPS.forEach(function (s) {
      $('step-' + s).style.display = s === step ? '' : 'none';
    });
  }

  function startAuto(mode) {
    state.autoMode = mode;
    state.autoPayload = null;
    switchView('auto');
    if (mode === 'signals') { renderSignalsStep(); showStep('signals'); }
    else if (mode === 'extract') showStep('extract');
    else if (mode === 'generate') showStep('generate');
    else showStep('choose');
  }

  // 智能体内容类型识别：名册（表格/JSON）→ signals；短自然语言描述 → generate；长文本 → extract
  // 表格判定收紧：须多行 + 首行半角分隔符 + 表头关键词——中文文档句子里的逗号/「工号」字样不算表格
  function detectInputType(text) {
    var t = String(text || '').trim();
    if (!t) return null;
    var lines = t.split('\n').filter(function (l) { return l.trim(); });
    var firstLine = lines[0].trim();
    var looksTable = (t[0] === '[' && t[t.length - 1] === ']') ||
      (lines.length >= 2 && /[,;\t]/.test(firstLine) && /(name|姓名|企业名称|客户名称|empno|工号|id|编号)/i.test(firstLine));
    if (looksTable) return 'signals';
    if (t.length <= 150 && !/\n\s*\n/.test(t)) return 'generate';
    return 'extract';
  }

  var AGENT_MODE_LABEL = {
    signals: '名册数据 → 信号建边',
    extract: '文档文本 → LLM 抽取实体关系',
    generate: '自然语言描述 → 生成图谱初稿',
  };

  function parseRoster(text) {
    var trimmed = String(text || '').trim();
    if (!trimmed) throw new Error('请输入名册数据');
    if (trimmed[0] === '[') {
      var arr = JSON.parse(trimmed);
      if (!Array.isArray(arr)) throw new Error('JSON 必须是数组');
      return arr;
    }
    return KnowledgeBuilderDataImport.parseCsv(trimmed);
  }

  var FIELD_ALIASES = {
    id: ['id', '员工id', '工号', 'empno', 'employeeid'],
    name: ['name', '姓名', '名字'],
    empNo: ['empno', '工号', '员工编号'],
    pinyin: ['pinyin', '拼音'],
    aliases: ['aliases', '别名', '习惯叫法'],
    department: ['department', 'dept', '部门编码', '部门id', 'deptid'],
    deptName: ['deptname', '部门', '部门名称'],
    team: ['team', '团队'],
    rank: ['rank', '职级'],
    title: ['title', '职位', '岗位'],
    skills: ['skills', '技能', 'skill'],
    location: ['location', '办公地点', '地点'],
    email: ['email', '邮箱'],
    phone: ['phone', '电话', '手机'],
    managerId: ['managerid', 'manager', '上级id', '直属上级', '汇报给'],
    status: ['status', '状态'],
    onboardDate: ['onboarddate', '入职日期', '入职时间'],
  };

  var CUSTOMER_FIELD_ALIASES = {
    customerCode: ['客户编号', 'customercode', 'customerid', 'id'],
    name: ['企业名称', 'name', '客户名称', '公司名称'],
    industry: ['行业分类', 'industry', '行业'],
    chainPosition: ['产业链位置', 'chainposition', '产业链'],
    registeredCapital: ['注册资本(万元)', '注册资本', 'registeredcapital'],
    employeeCount: ['员工数', 'employeecount', '员工人数'],
    revenueRange: ['营收区间(万元)', 'revenueRange', 'revenues', '营收区间', '营收'],
    companyType: ['企业类型', 'companytype'],
    listed: ['上市情况', 'listed', '上市'],
    specialNew: ['专精特新', 'specialnew'],
    assetLiabilityRatio: ['资产负债率(%)', '资产负债率', 'assetliabilityratio'],
    revenueGrowth: ['营收增速(%)', '营收增速', 'revenuegrowth'],
    foundedYear: ['成立年份', 'foundedyear'],
    province: ['所在省份', 'province', '省份'],
    decisionMaker: ['关键决策人', '决策人', 'decisionmaker'],
    contact: ['联系方式', 'contact', '电话', 'phone'],
  };

  function currentFieldAliases() {
    return state.templateId === 'customer-ecosystem' ? CUSTOMER_FIELD_ALIASES : FIELD_ALIASES;
  }

  function mapColumns(rows) {
    var header = rows[0] || {};
    var keys = Object.keys(header).map(function (k) { return String(k).trim().toLowerCase(); });
    var mapping = {};
    Object.keys(currentFieldAliases()).forEach(function (field) {
      var aliases = currentFieldAliases()[field];
      for (var i = 0; i < keys.length; i++) {
        if (aliases.indexOf(keys[i]) >= 0) { mapping[field] = Object.keys(header)[i]; break; }
      }
    });
    return mapping;
  }

  function splitList(v) {
    if (Array.isArray(v)) return v.map(String);
    return String(v || '').split(/[;,，、|]/).map(function (s) { return s.trim(); }).filter(Boolean);
  }

  function rowsToEmployees(rows, mapping) {
    return rows.map(function (row, i) {
      function get(field, def) {
        var col = mapping[field];
        if (!col || row[col] == null || row[col] === '') return def;
        return row[col];
      }
      return {
        id: String(get('id', 'emp-' + (i + 1))).trim(),
        empNo: String(get('empNo', '')).trim(),
        name: String(get('name', '')).trim(),
        pinyin: String(get('pinyin', '')).trim(),
        aliases: splitList(get('aliases', [])),
        department: String(get('department', '')).trim(),
        deptName: String(get('deptName', '')).trim(),
        team: String(get('team', '')).trim(),
        rank: String(get('rank', '')).trim(),
        title: String(get('title', '')).trim(),
        skills: splitList(get('skills', [])),
        location: String(get('location', '')).trim(),
        email: String(get('email', '')).trim(),
        phone: String(get('phone', '')).trim(),
        managerId: get('managerId', null) ? String(get('managerId', '')).trim() : null,
        status: String(get('status', 'active')).trim(),
        onboardDate: String(get('onboardDate', '')).trim(),
      };
    }).filter(function (e) { return e.name; });
  }

  // 客户生态：画像 CSV 行 → 客户记录（含决策人/联系方式）
  function rowsToCustomers(rows, mapping) {
    return rows.map(function (row) {
      function get(field, def) {
        var col = mapping[field];
        if (!col || row[col] == null || row[col] === '') return def;
        return row[col];
      }
      return {
        customerCode: String(get('customerCode', '')).trim(),
        name: String(get('name', '')).trim(),
        industry: String(get('industry', '')).trim(),
        chainPosition: String(get('chainPosition', '')).trim(),
        registeredCapital: String(get('registeredCapital', '')).trim(),
        employeeCount: String(get('employeeCount', '')).trim(),
        revenueRange: String(get('revenueRange', '')).trim(),
        companyType: String(get('companyType', '')).trim(),
        listed: String(get('listed', '')).trim(),
        specialNew: String(get('specialNew', '')).trim(),
        assetLiabilityRatio: String(get('assetLiabilityRatio', '')).trim(),
        revenueGrowth: String(get('revenueGrowth', '')).trim(),
        foundedYear: String(get('foundedYear', '')).trim(),
        province: String(get('province', '')).trim(),
        decisionMaker: String(get('decisionMaker', '')).trim(),
        contact: String(get('contact', '')).trim(),
      };
    }).filter(function (c) { return c.name; });
  }

  // 客户生态名册预览：CUSTOMER 节点 upsert + 决策人 PERSON + WORK_FOR 边（无信号算法，直接结构并入）
  function runCustomerRosterPreview(rows, mapping) {
    var customers = rowsToCustomers(rows, mapping);
    if (!customers.length) throw new Error('没有解析出有效客户行');
    var current = ensureDraft();
    var nodeById = {};
    current.nodes.forEach(function (n) { nodeById[n.id] = n; });
    var beforeIds = {};
    current.nodes.forEach(function (n) { beforeIds[n.id] = true; });
    var newNodes = 0, updated = 0;

    customers.forEach(function (c, i) {
      var id = 'cust:' + (c.customerCode || 'r' + (i + 1));
      if (!nodeById[id]) newNodes++; else updated++;
      nodeById[id] = {
        id: id, type: 'CUSTOMER',
        properties: {
          name: c.name, customerCode: c.customerCode, industry: c.industry, chainPosition: c.chainPosition,
          registeredCapital: c.registeredCapital, employeeCount: c.employeeCount, revenueRange: c.revenueRange,
          companyType: c.companyType, listed: c.listed, specialNew: c.specialNew,
          assetLiabilityRatio: c.assetLiabilityRatio, revenueGrowth: c.revenueGrowth,
          foundedYear: c.foundedYear, province: c.province, isBankCustomer: true, tags: [],
        },
      };
      if (c.decisionMaker) {
        var pid = 'person:' + (c.customerCode || 'r' + (i + 1)) + '-1';
        if (!nodeById[pid]) newNodes++;
        nodeById[pid] = { id: pid, type: 'PERSON', properties: { name: c.decisionMaker, title: '关键决策人', phone: c.contact, customerCode: c.customerCode } };
      }
    });

    var edgeKey = {};
    current.edges.forEach(function (e) { edgeKey[e.source + '|' + e.type + '|' + e.target] = true; });
    var edges = current.edges.slice();
    var newEdges = 0;
    customers.forEach(function (c, i) {
      if (!c.decisionMaker) return;
      var id = 'cust:' + (c.customerCode || 'r' + (i + 1));
      var pid = 'person:' + (c.customerCode || 'r' + (i + 1)) + '-1';
      var key = pid + '|WORK_FOR|' + id;
      if (edgeKey[key]) return;
      edges.push({ id: 'edge-x' + (edges.length + 1), type: 'WORK_FOR', source: pid, target: id, properties: { weight: 9, relationType: '关键决策人', origin: 'roster' } });
      newEdges++;
    });

    var doc = Object.assign({}, current, {
      nodes: Object.keys(nodeById).map(function (k) { return nodeById[k]; }),
      edges: edges,
    });
    state.autoPayload = {
      mode: 'signals',
      document: doc,
      summary: '解析 ' + customers.length + ' 家客户；新增节点 ' + newNodes + '（更新 ' + updated + '），新增任职边 ' + newEdges + ' 条',
      items: customers.slice(0, 50).map(function (c, i) {
        var id = 'cust:' + (c.customerCode || 'r' + (i + 1));
        return { kind: 'node', label: c.name + (c.decisionMaker ? ' · 决策人 ' + c.decisionMaker : ''), tag: beforeIds[id] ? 'update' : 'create', tagText: beforeIds[id] ? '已有' : '新建', checked: true };
      }),
    };
    renderPreview();
  }

  // ── 信号建边预览（org-people）/ 画像名册向导（customer-ecosystem） ──
  function runSignalsPreview() {
    var rows = parseRoster($('input-signals').value);
    var mapping = mapColumns(rows);
    if (!mapping.name) throw new Error('未识别到名称列（' + (state.templateId === 'customer-ecosystem' ? '企业名称/name' : 'name/姓名') + '）——请检查表头');
    var chips = Object.keys(currentFieldAliases()).map(function (f) {
      return '<span class="chip ' + (mapping[f] ? 'ok' : 'bad') + '">' + f + (mapping[f] ? ' ← ' + esc(mapping[f]) : '（缺）') + '</span>';
    }).join('');
    $('mapped-fields').innerHTML = chips;
    if (state.templateId === 'customer-ecosystem') { runCustomerRosterPreview(rows, mapping); return; }
    if (!mapping.id) throw new Error('未识别到 id 列（id/工号）——请检查表头');

    var employees = rowsToEmployees(rows, mapping);
    if (!employees.length) throw new Error('没有解析出有效员工行');

    var current = ensureDraft();
    // 全量重算：既有员工（从当前文档转换）+ 新员工合并计算信号边（mergeAutoEdges 为整体替换语义）
    var existing = OrgGraphModel.convertToConsumerGraph(current);
    var allEmployees = existing.employees.concat(employees);
    var company = { employees: allEmployees, projects: existing.projects, interactions: existing.interactions };
    var structural = OrgGraphSignals.buildStructuralEdges(allEmployees, existing.projects);
    var collab = OrgGraphSignals.buildOrgGraph(company).edges;

    var merged = OrgGraphSignals.mergeAutoEdges(current, collab, structural);

    // 节点 upsert：mergeAutoEdges 只管边，员工/部门节点在此并入（新 id 追加、已有 id 属性覆盖）
    var nodeById = {};
    merged.nodes.forEach(function (n) { nodeById[n.id] = n; });
    employees.forEach(function (e) {
      nodeById[e.id] = {
        id: e.id, type: 'EMPLOYEE',
        properties: {
          name: e.name, empNo: e.empNo, pinyin: e.pinyin, aliases: e.aliases,
          department: e.department, deptName: e.deptName, team: e.team, rank: e.rank,
          title: e.title, skills: e.skills, location: e.location, email: e.email,
          phone: e.phone, status: e.status, onboardDate: e.onboardDate,
        },
      };
    });
    employees.forEach(function (e) {
      // 部门编码与员工 id 撞名时跳过（边端点类型校验会兜底报告）
      if (e.department && e.deptName && !nodeById[e.department] && e.id !== e.department) {
        nodeById[e.department] = { id: e.department, type: 'DEPARTMENT', properties: { name: e.deptName, parent: '' } };
      }
    });
    merged.nodes = Object.keys(nodeById).map(function (k) { return nodeById[k]; });

    // 预览摘要：节点/边变化
    var beforeNodeIds = {};
    current.nodes.forEach(function (n) { beforeNodeIds[n.id] = true; });
    var newNodes = merged.nodes.filter(function (n) { return !beforeNodeIds[n.id]; });
    var deptNodes = newNodes.filter(function (n) { return n.type === 'DEPARTMENT'; });
    var newEdges = merged.edges.length - current.edges.length;

    state.autoPayload = {
      mode: 'signals',
      document: merged,
      summary: '解析 ' + employees.length + ' 名员工；新增节点 ' + newNodes.length +
        '（含部门 ' + deptNodes.length + '），边净增 ' + newEdges + ' 条（自动协作边 ' + collab.length + ' 条、结构边 ' + structural.length + ' 条）',
      items: employees.slice(0, 50).map(function (e) {
        return { kind: 'node', label: e.name + (e.deptName ? ' · ' + e.deptName : ''), tag: beforeNodeIds[e.id] ? 'update' : 'create', tagText: beforeNodeIds[e.id] ? '已有' : '新建', checked: true };
      }),
    };
    renderPreview();
  }

  // ── 文档抽取 ──
  function runExtract() {
    var content = $('input-extract').value.trim();
    if (!content) { toast('请粘贴文档内容', 'err'); return; }
    $('extract-progress').style.display = '';
    api('/extract', { method: 'POST', body: { content: content } }).then(function (result) {
      $('extract-progress').style.display = 'none';
      var current = ensureDraft();
      var matches = matchExtracted(current, result.entities, result.relations);
      state.autoPayload = {
        mode: 'extract',
        matches: matches,
        summary: 'LLM 抽取实体 ' + result.entities.length + ' 个（' +
          matches.entities.filter(function (m) { return m.action === 'update'; }).length + ' 命中已有）、关系 ' +
          result.relations.length + ' 条（' + matches.relations.filter(function (m) { return m.action === 'new'; }).length + ' 条可新建）',
        items: buildExtractItems(matches),
      };
      renderPreview();
    }).catch(function (e) {
      $('extract-progress').style.display = 'none';
      toast('抽取失败：' + e.message, 'err');
    });
  }

  function matchExtracted(doc, entities, relations) {
    var nameToNode = {};
    doc.nodes.forEach(function (n) {
      var props = n.properties || {};
      if (n.type === 'EMPLOYEE') {
        if (props.name) nameToNode[String(props.name).toLowerCase()] = n;
        (props.aliases || []).forEach(function (a) { nameToNode[String(a).toLowerCase()] = n; });
      } else {
        if (props.name) nameToNode[String(props.name).toLowerCase()] = n;
      }
    });
    var entMatches = entities.map(function (e) {
      var hit = nameToNode[String(e.name).toLowerCase()];
      return { entity: e, action: hit ? 'update' : 'create', node: hit || null };
    });
    var entNameToMatch = {};
    entMatches.forEach(function (m) { entNameToMatch[String(m.entity.name).toLowerCase()] = m; });
    var existingEdges = {};
    doc.edges.forEach(function (e) { existingEdges[e.source + '||' + e.target + '||' + e.type] = true; });
    var relMatches = relations.map(function (r) {
      var s = entNameToMatch[String(r.source).toLowerCase()];
      var t = entNameToMatch[String(r.target).toLowerCase()];
      if (!s || !t) return { relation: r, action: 'skip', reason: '端点实体未抽取到' };
      var srcId = s.node ? s.node.id : 'new:' + s.entity.name;
      var tgtId = t.node ? t.node.id : 'new:' + t.entity.name;
      var key = srcId + '||' + tgtId + '||' + r.type;
      if (existingEdges[key]) return { relation: r, action: 'exists' };
      return { relation: r, action: 'new' };
    });
    return { entities: entMatches, relations: relMatches };
  }

  function buildExtractItems(matches) {
    var items = [];
    matches.entities.forEach(function (m) {
      items.push({
        kind: 'entity', match: m, checked: true,
        label: m.entity.name + '（' + m.entity.type + '）' + (m.entity.description ? ' — ' + m.entity.description.slice(0, 40) : ''),
        tag: m.action, tagText: m.action === 'update' ? '并入现有' : '新建',
      });
    });
    matches.relations.forEach(function (m) {
      items.push({
        kind: 'relation', match: m, checked: m.action === 'new',
        label: m.relation.source + ' → ' + m.relation.type + ' → ' + m.relation.target,
        tag: m.action === 'new' ? 'create' : 'skip',
        tagText: m.action === 'new' ? '新边' : (m.action === 'exists' ? '已存在' : '跳过'),
      });
    });
    return items;
  }

  // ── 自然语言生成 ──
  function runGenerate() {
    var description = $('input-generate').value.trim();
    if (!description) { toast('请输入组织描述', 'err'); return; }
    $('generate-progress').style.display = '';
    api('/generate', { method: 'POST', body: { description: description } }).then(function (result) {
      $('generate-progress').style.display = 'none';
      var doc = result.document;
      var v = result.validation;
      var assetCheck = v.asset || v.org || { valid: false, errors: [] };
      state.autoPayload = {
        mode: 'generate',
        document: doc,
        summary: 'LLM 生成 ' + doc.nodes.length + ' 节点 / ' + doc.edges.length + ' 边；' +
          '组织校验 ' + (assetCheck.valid ? '<span style="color:var(--org-ok)">通过</span>' : '<b style="color:var(--org-danger)">' + assetCheck.errors.length + ' 错误</b>') +
          '，模板校验 ' + (v.template.valid ? '<span style="color:var(--org-ok)">通过</span>' : '<b style="color:var(--org-danger)">' + v.template.errors.length + ' 错误</b>'),
        items: buildGenerateItems(result),
      };
      renderPreview();
    }).catch(function (e) {
      $('generate-progress').style.display = 'none';
      toast('生成失败：' + e.message, 'err');
    });
  }

  function buildGenerateItems(result) {
    var items = [{ kind: 'info', label: '生成初稿将整体替换当前草稿（原草稿被覆盖）', tag: 'skip', tagText: '注意', checked: false }];
    result.document.nodes.slice(0, 100).forEach(function (n) {
      items.push({ kind: 'node', label: n.type + '：' + ((n.properties || {}).name || n.id), tag: 'create', tagText: '新', checked: true });
    });
    return items;
  }

  // ── 预览渲染 ──
  function renderPreview() {
    var payload = state.autoPayload;
    if (!payload) return;
    $('preview-title').textContent = payload.mode === 'signals' ? '信号建边预览' : (payload.mode === 'extract' ? '抽取结果确认' : '生成初稿预览');
    $('preview-summary').innerHTML = payload.summary;
    var listHtml = payload.items.map(function (item, i) {
      return '<div class="preview-item"><label><input type="checkbox" data-idx="' + i + '"' +
        (item.checked ? ' checked' : '') + '> ' + esc(item.label) + '</label><span class="tag tag-' + item.tag + '">' + esc(item.tagText) + '</span></div>';
    }).join('');
    $('preview-list').innerHTML = listHtml || '<span class="muted">无内容</span>';
    showStep('preview');
    if (window.IA) IA.renderStagePanel(state.view); // [IA] 智能体任务状态刷新
  }

  // ── 确认并入草稿 ──
  function applyMerge() {
    var payload = state.autoPayload;
    if (!payload) return;
    if (payload.mode === 'signals' || payload.mode === 'generate') {
      state.document = payload.document;
      // 先落草稿再切工作台（saveDraft 异步，工作台 init 会从服务端重新加载草稿）
      saveDraft('自动构建并入（' + payload.mode + '）').then(function () { switchView('workbench'); });
      return;
    }
    // extract：按勾选逐条并入
    var checked = {};
    document.querySelectorAll('#preview-list input[type=checkbox]').forEach(function (cb) {
      checked[Number(cb.dataset.idx)] = cb.checked;
    });
    var doc = ensureDraft();
    var matches = payload.matches;
    var seq = 0;
    var newIdOf = {};
    payload.items.forEach(function (item, idx) {
      if (!checked[idx]) return;
      if (item.kind === 'entity') {
        var m = item.match;
        if (m.action === 'create') {
          var type = m.entity.type;
          if (!nodeTypeDef(type)) return; // 仅并入模板声明的节点类型
          var prefix = { EMPLOYEE: 'emp-x', DEPARTMENT: 'dept-x', PROJECT: 'prj-x', CUSTOMER: 'cust-x', PERSON: 'person-x' }[type] || (type.toLowerCase() + '-x');
          var id = prefix + (++seq);
          newIdOf[m.entity.name] = id;
          doc.nodes.push({ id: id, type: type, properties: { name: m.entity.name } });
        }
      } else if (item.kind === 'relation') {
        var rm = item.match;
        if (rm.action !== 'new') return;
        var sId = rm.relation.source && newIdOf[rm.relation.source] ? newIdOf[rm.relation.source] : resolveNodeId(doc, rm.relation.source);
        var tId = newIdOf[rm.relation.target] || resolveNodeId(doc, rm.relation.target);
        if (!sId || !tId) return;
        var sn = nodeById(doc, sId); var tn = nodeById(doc, tId);
        if (!sn || !tn) return;
        if (rm.relation.type === 'COLLABORATES') {
          doc.edges.push({
            id: 'edge-x' + (doc.edges.length + 1), type: 'COLLABORATES', source: sId, target: tId,
            properties: { weight: Math.round((rm.relation.confidence || 0.7) * 10), signals: ['llm_extract'], origin: 'auto' },
          });
        } else {
          // 模板边端点类型校验（org-people 与 customer-ecosystem 通用）
          var edgeDef = edgeTypeDef(rm.relation.type);
          if (!edgeDef) return;
          if (edgeDef.source_types.indexOf(sn.type) < 0 || edgeDef.target_types.indexOf(tn.type) < 0) return;
          doc.edges.push({
            id: 'edge-x' + (doc.edges.length + 1), type: rm.relation.type, source: sId, target: tId,
            properties: { weight: Math.max(1, Math.min(10, Math.round((rm.relation.confidence || 0.7) * 10))), relationType: 'llm_extract', origin: 'llm_extract' },
          });
        }
      }
    });
    state.document = doc;
    saveDraft('文档抽取并入（' + matches.entities.filter(function (m) { return m.action === 'create'; }).length + ' 新建实体）').then(function () { switchView('workbench'); });
  }

  function nodeById(doc, id) {
    return doc.nodes.filter(function (n) { return n.id === id; })[0] || null;
  }
  function resolveNodeId(doc, name) {
    var key = String(name).toLowerCase();
    var hit = doc.nodes.filter(function (n) {
      var p = n.properties || {};
      if (String(p.name || '').toLowerCase() === key) return true;
      if (n.type === 'EMPLOYEE' && (p.aliases || []).some(function (a) { return String(a).toLowerCase() === key; })) return true;
      return false;
    })[0];
    return hit ? hit.id : null;
  }

  // ═══════════════ 草稿管理 ═══════════════
  function ensureDraft() {
    if (state.document) return state.document;
    state.document = OrgGraphModel.createOrgDocument({ name: '组织图谱草稿', source: 'builder' });
    return state.document;
  }

  function saveDraft(note) {
    var doc = ensureDraft();
    return api('/save', { method: 'POST', body: { document: doc } }).then(function () {
      state.dirty = false;
      $('hdr-draft').style.display = 'none';
      toast('草稿已保存' + (note ? '（' + note + '）' : ''));
    }).catch(function (e) { toast('保存失败：' + e.message, 'err'); });
  }

  function loadWorkingDocument() {
    // /load 无参数时服务端按 草稿 → active 版本 回退；都没有 → null（空文档起步）
    return api('/load').then(function (doc) { return doc; }).catch(function () { return null; });
  }

  // ═══════════════ 专家工作台 ═══════════════
  var wbLoaded = false;
  function initWorkbench() {
    if (wbLoaded) { resizeCanvas(); return; }
    wbLoaded = true;
    var ready = state.document ? Promise.resolve() : loadWorkingDocument().then(function (doc) {
      if (doc) state.document = doc;
    });
    ready.then(function () {
      ensureDraft();
      if (!state.template) {
        api('/template').then(function (t) { state.template = t; renderWorkbench(); }).catch(function (e) { toast('模板加载失败：' + e.message, 'err'); });
      } else {
        renderWorkbench();
      }
    }).catch(function (e) { toast('工作台加载失败：' + e.message, 'err'); });
  }

  function renderWorkbench() {
    updateNodeAddButtons();
    // 客户生态无信号算法：隐藏重算信号边（模板驱动边编辑走检查器）
    $('btn-recalc').style.display = state.templateId === 'org-people' ? '' : 'none';
    $('btn-add-collab').textContent = state.templateId === 'org-people' ? '+协作边' : '+边';
    renderNodeTree();
    renderEdgeTable();
    renderG6();
    updateWbStats();
  }

  // 按模板节点类型重建「+节点」按钮（绑定全局 OrgAdapter.addNodeOf）
  function updateNodeAddButtons() {
    var types = ['EMPLOYEE', 'DEPARTMENT', 'PROJECT'];
    var labels = { EMPLOYEE: '+员工', DEPARTMENT: '+部门', PROJECT: '+项目', CUSTOMER: '+客户', PERSON: '+决策人' };
    if (state.template && Array.isArray(state.template.node_types)) {
      types = state.template.node_types.map(function (t) { return t.type; });
    }
    $('node-add-buttons').innerHTML = types.map(function (type) {
      return '<button class="btn btn-sm" onclick="OrgAdapter.addNodeOf(\'' + esc(type) + '\')" title="新增' + (labels[type] || type) + '">' + (labels[type] || ('+' + type)) + '</button>';
    }).join('');
  }

  function updateWbStats() {
    var doc = ensureDraft();
    $('wb-stats').textContent = doc.nodes.length + ' 节点 / ' + doc.edges.length + ' 边' + (state.dirty ? ' · 未保存' : '');
  }

  function renderNodeTree() {
    var doc = ensureDraft();
    var groups = {};
    doc.nodes.forEach(function (n) { (groups[n.type] = groups[n.type] || []).push(n); });
    var html = '';
    Object.keys(groups).forEach(function (type) {
      var list = groups[type];
      if (!list.length) return;
      html += '<div class="node-tree-group"><h4>' + type + '（' + list.length + '）</h4>';
      list.forEach(function (n) {
        var name = (n.properties || {}).name || n.id;
        html += '<div class="node-tree-item" data-node="' + esc(n.id) + '"><span class="dot" style="background:' + nodeColor(type) + '"></span>' + esc(name) + '</div>';
      });
      html += '</div>';
    });
    $('node-tree').innerHTML = html;
    document.querySelectorAll('#orgView .node-tree-item').forEach(function (el) {
      el.addEventListener('click', function () {
        var id = el.dataset.node;
        selectNode(id);
        focusNode(id);
      });
    });
  }

  function renderEdgeTable() {
    var doc = ensureDraft();
    // COLLABORATES 排前（老语义：协作边表主表）；其余类型按模板附后
    var collabs = doc.edges.filter(function (e) { return e.type === 'COLLABORATES'; });
    var others = doc.edges.filter(function (e) { return e.type !== 'COLLABORATES'; });
    var nameOf = {};
    doc.nodes.forEach(function (n) { nameOf[n.id] = (n.properties || {}).name || n.id; });
    function row(e) {
      var p = e.properties || {};
      var origin = p.origin || 'auto';
      return '<div class="edge-row" data-edge="' + esc(e.id) + '">' +
        esc(nameOf[e.source] || e.source) + ' ↔ ' + esc(nameOf[e.target] || e.target) +
        ' <span class="w">' + (p.weight != null ? p.weight : '—') + '</span>' +
        '<span class="origin origin-' + esc(origin) + '">' + esc(origin) + '</span>' +
        (e.type !== 'COLLABORATES' ? '<span class="muted" style="font-size:10px;margin-left:4px">[' + esc(e.type) + ']</span>' : '') + '</div>';
    }
    var html = collabs.map(row).join('');
    if (others.length) {
      html += '<div class="node-tree-group" style="margin-top:6px"><h4>结构边（' + others.length + '）</h4></div>' + others.map(row).join('');
    }
    $('edge-table').innerHTML = html || '<span class="muted">暂无边</span>';
    document.querySelectorAll('#orgView .edge-row').forEach(function (el) {
      el.addEventListener('click', function () { selectEdge(el.dataset.edge); });
    });
  }

  // ── G6 渲染 ──
  function renderG6() {
    var doc = ensureDraft();
    var el = $('g6-canvas');
    if (state.g6) { try { state.g6.destroy(); } catch (e) {} state.g6 = null; }
    el.innerHTML = '';
    var w = el.clientWidth || 800;
    var h = el.clientHeight || 500;

    var nodes = doc.nodes.map(function (n) {
      var props = n.properties || {};
      return {
        id: n.id,
        data: { name: props.name || n.id, type: n.type },
        style: {
          fill: nodeColor(n.type),
          stroke: '#0f172a',
          lineWidth: 1.5,
          size: n.type === 'EMPLOYEE' || n.type === 'PERSON' ? 26 : 34,
          labelText: props.name || n.id,
          labelFontSize: 8.5,
          labelPlacement: 'bottom',
          labelOffsetY: 3,
          labelMaxWidth: 64,
          labelWordWrap: true,
        },
      };
    });
    var edges = doc.edges.map(function (e, i) {
      if (e.type === 'COLLABORATES') {
        var wgt = ((e.properties || {}).weight) || 1;
        return {
          id: e.id || 'e' + i, source: e.source, target: e.target,
          style: { stroke: wgt >= 6 ? '#f5222d' : (wgt >= 3 ? '#fa8c16' : '#94a3b8'), lineWidth: 0.5 + wgt / 4, opacity: 0.7 },
        };
      }
      // 非协作边：模板边颜色优先，否则回退旧硬编码样式
      var def = edgeTypeDef(e.type);
      var stroke = def && def.style && def.style.color ? def.style.color : (EDGE_STYLE[e.type] || { stroke: '#64748b' }).stroke;
      return { id: e.id || 'e' + i, source: e.source, target: e.target, style: { stroke: stroke, lineWidth: 1 } };
    });

    try {
      state.g6 = new G6.Graph({
        container: 'g6-canvas',
        width: w,
        height: h,
        data: { nodes: nodes, edges: edges },
        layout: { type: 'd3-force', manyBody: { strength: -120 }, collide: { radius: 55 }, link: { distance: 75 }, center: { x: w / 2, y: h / 2 } },
        node: { style: {} },
        edge: { style: {} },
        behaviors: ['drag-canvas', 'zoom-canvas', 'drag-element'],
      });
      state.g6.render();
      state.g6.on('node:click', function (evt) {
        var id = evt.target && evt.target.id;
        if (id) selectNode(id);
      });
      [400, 1200, 2400].forEach(function (delay) {
        setTimeout(function () {
          if (!state.g6) return;
          try { state.g6.fitView({ padding: 30 }); } catch (e) {}
        }, delay);
      });
    } catch (e) {
      el.innerHTML = '<div style="padding:80px 0;text-align:center;color:var(--org-danger)">图谱渲染失败: ' + esc(e.message) + '</div>';
      state.g6 = null;
    }
  }

  function resizeCanvas() {
    if (!state.g6) return;
    if (window.DOMAIN && DOMAIN.current !== 'org') return; // [multi-domain hook] 仅 org 领域响应
    var el = $('g6-canvas');
    try { state.g6.setSize(el.clientWidth || 800, el.clientHeight || 500); } catch (e) {}
  }

  function focusNode(id) {
    if (!state.g6) return;
    try { state.g6.focusElement(id, { animation: { duration: 300 } }); } catch (e) {}
  }

  // ── 检查器（节点/边编辑） ──
  function selectNode(id) {
    state.selectedNodeId = id;
    state.selectedEdgeId = null;
    var doc = ensureDraft();
    var n = nodeById(doc, id);
    if (!n) return;
    var props = n.properties || {};
    var fieldsHtml;
    var def = nodeTypeDef(n.type);
    if (def && Array.isArray(def.fields) && def.fields.length) {
      // 模板驱动：string/number/date/url → 文本；boolean → 勾选；tags → 分号文本
      fieldsHtml = def.fields.map(function (f) {
        var label = f.label || f.key;
        if (f.type === 'boolean') {
          return '<label class="field-label">' + esc(label) + '</label>' +
            '<input type="checkbox" data-field="' + esc(f.key) + '" data-kind="boolean"' + (props[f.key] === true ? ' checked' : '') + '>';
        }
        if (f.type === 'tags') {
          return '<label class="field-label">' + esc(label) + '（分号分隔）</label>' +
            '<input type="text" data-field="' + esc(f.key) + '" data-kind="tags" value="' + esc((props[f.key] || []).join('; ')) + '">';
        }
        return '<label class="field-label">' + esc(label) + '</label>' +
          '<input type="text" data-field="' + esc(f.key) + '" value="' + esc(props[f.key] || '') + '">';
      }).join('');
    } else {
      // 无模板兜底（旧硬编码路径）
      if (n.type === 'EMPLOYEE') {
        var textFields = ['name', 'empNo', 'pinyin', 'department', 'deptName', 'team', 'rank', 'title', 'location', 'email', 'phone', 'status', 'onboardDate'];
        var listFields = ['aliases', 'skills'];
        fieldsHtml = textFields.map(function (f) {
          return '<label class="field-label">' + f + '</label><input type="text" data-field="' + f + '" value="' + esc(props[f] || '') + '">';
        }).join('') + listFields.map(function (f) {
          return '<label class="field-label">' + f + '（分号分隔）</label><input type="text" data-field="' + f + '" data-kind="tags" value="' + esc((props[f] || []).join('; ')) + '">';
        }).join('');
      } else {
        fieldsHtml = '<label class="field-label">name</label><input type="text" data-field="name" value="' + esc(props.name || '') + '">';
        if (n.type === 'DEPARTMENT') {
          fieldsHtml += '<label class="field-label">parent</label><input type="text" data-field="parent" value="' + esc(props.parent || '') + '">';
        }
      }
    }
    $('inspector-title').textContent = '节点：' + (props.name || n.id) + '（' + n.type + '）';
    $('inspector').innerHTML =
      '<div class="inspector-form">' + fieldsHtml +
      '<div class="row2"><button class="btn btn-primary" id="insp-save">应用修改</button>' +
      '<button class="btn btn-danger" id="insp-delete">删除节点</button></div></div>';
    $('insp-save').addEventListener('click', function () {
      document.querySelectorAll('#inspector input[data-field]').forEach(function (input) {
        var f = input.dataset.field;
        if (input.dataset.kind === 'boolean') {
          n.properties[f] = input.checked;
        } else if (input.dataset.kind === 'tags') {
          n.properties[f] = input.value.split(/[;,，、]/).map(function (s) { return s.trim(); }).filter(Boolean);
        } else {
          n.properties[f] = input.value.trim();
        }
      });
      state.dirty = true;
      markDirty();
      renderWorkbench();
      toast('节点属性已更新（记得保存草稿）');
    });
    $('insp-delete').addEventListener('click', function () {
      if (!confirm('删除节点 ' + (props.name || n.id) + ' 及其所有关联边？')) return;
      doc.nodes = doc.nodes.filter(function (x) { return x.id !== id; });
      doc.edges = doc.edges.filter(function (e) { return e.source !== id && e.target !== id; });
      state.dirty = true;
      markDirty();
      renderWorkbench();
      toast('节点已删除（记得保存草稿）');
    });
  }

  function selectEdge(id) {
    state.selectedEdgeId = id;
    state.selectedNodeId = null;
    var doc = ensureDraft();
    var e = doc.edges.filter(function (x) { return x.id === id; })[0];
    if (!e) return;
    if (e.type !== 'COLLABORATES') { selectGenericEdge(e, doc); return; }
    var p = e.properties || {};
    var nameOf = {};
    doc.nodes.forEach(function (n) { nameOf[n.id] = (n.properties || {}).name || n.id; });
    var signalsList = ['report', 'member_overlap', 'adamic_adar', 'skill_affinity', 'recent_collab', 'llm_extract'];
    var signalChecks = signalsList.map(function (s) {
      return '<label><input type="checkbox" data-sig="' + s + '"' + ((p.signals || []).indexOf(s) >= 0 ? ' checked' : '') + '> ' + s + '</label>';
    }).join(' ');
    $('inspector-title').textContent = '协作边：' + (nameOf[e.source] || e.source) + ' ↔ ' + (nameOf[e.target] || e.target);
    $('inspector').innerHTML =
      '<div class="inspector-form">' +
      '<label class="field-label">weight（0-10）</label><input type="number" min="0" max="10" step="0.1" id="insp-weight" value="' + (p.weight != null ? p.weight : 1) + '">' +
      '<label class="field-label">origin</label><select id="insp-origin">' +
      ['auto', 'manual', 'expert'].map(function (o) { return '<option value="' + o + '"' + ((p.origin || 'auto') === o ? ' selected' : '') + '>' + o + '</option>'; }).join('') +
      '</select>' +
      '<label class="field-label">signals</label><div style="font-size:12px">' + signalChecks + '</div>' +
      '<div class="row2"><button class="btn btn-primary" id="insp-save">应用修改</button>' +
      '<button class="btn btn-danger" id="insp-delete">删除边</button></div></div>';
    $('insp-save').addEventListener('click', function () {
      p.weight = Number($('insp-weight').value) || 1;
      p.origin = $('insp-origin').value;
      p.signals = signalsList.filter(function (s) { return document.querySelector('#inspector input[data-sig="' + s + '"]').checked; });
      state.dirty = true;
      markDirty();
      renderWorkbench();
      toast('边属性已更新（记得保存草稿）');
    });
    $('insp-delete').addEventListener('click', function () {
      doc.edges = doc.edges.filter(function (x) { return x.id !== id; });
      state.dirty = true;
      markDirty();
      renderWorkbench();
      $('inspector').innerHTML = '<span class="muted">边已删除</span>';
      toast('边已删除（记得保存草稿）');
    });
  }

  function markDirty() {
    $('hdr-draft').style.display = '';
    $('hdr-draft').textContent = '草稿未保存';
  }

  // ── 通用边编辑（非 COLLABORATES：模板边字段 weight/relationType/origin） ──
  function selectGenericEdge(e, doc) {
    var p = e.properties || {};
    var nameOf = {};
    doc.nodes.forEach(function (n) { nameOf[n.id] = (n.properties || {}).name || n.id; });
    var def = edgeTypeDef(e.type);
    var label = def && def.label ? def.label : e.type;
    $('inspector-title').textContent = '边：' + (nameOf[e.source] || e.source) + ' → ' + (nameOf[e.target] || e.target) + '（' + label + '）';
    $('inspector').innerHTML =
      '<div class="inspector-form">' +
      '<label class="field-label">weight（0-10）</label><input type="number" min="0" max="10" step="0.1" id="insp-weight" value="' + (p.weight != null ? p.weight : 1) + '">' +
      '<label class="field-label">relationType（原始关联标签）</label><input type="text" id="insp-reltype" value="' + esc(p.relationType || '') + '">' +
      '<label class="field-label">origin</label><select id="insp-origin">' +
      ['auto', 'manual', 'expert', 'seed:csv', 'roster', 'llm_extract'].map(function (o) { return '<option value="' + o + '"' + ((p.origin || 'auto') === o ? ' selected' : '') + '>' + o + '</option>'; }).join('') +
      '</select>' +
      '<div class="row2"><button class="btn btn-primary" id="insp-save">应用修改</button>' +
      '<button class="btn btn-danger" id="insp-delete">删除边</button></div></div>';
    $('insp-save').addEventListener('click', function () {
      p.weight = Number($('insp-weight').value) || 1;
      p.relationType = $('insp-reltype').value.trim();
      p.origin = $('insp-origin').value;
      state.dirty = true;
      markDirty();
      renderWorkbench();
      toast('边属性已更新（记得保存草稿）');
    });
    $('insp-delete').addEventListener('click', function () {
      doc.edges = doc.edges.filter(function (x) { return x.id !== e.id; });
      state.dirty = true;
      markDirty();
      renderWorkbench();
      $('inspector').innerHTML = '<span class="muted">边已删除</span>';
      toast('边已删除（记得保存草稿）');
    });
  }

  // ── 新增节点/边 ──
  function addNode(type) {
    var doc = ensureDraft();
    var def = nodeTypeDef(type);
    var props = {};
    if (def && Array.isArray(def.fields)) {
      var NEW_NAMES = { EMPLOYEE: '新员工', DEPARTMENT: '新部门', PROJECT: '新项目', CUSTOMER: '新客户', PERSON: '新决策人' };
      def.fields.forEach(function (f) {
        if (f.key === 'name') props.name = NEW_NAMES[type] || ('新' + type);
        else if (f.type === 'tags') props[f.key] = [];
        else if (f.type === 'boolean') props[f.key] = f.default === true;
        else props[f.key] = f.default || '';
      });
    } else {
      props = type === 'EMPLOYEE' ? { name: '新员工', status: 'active' } : { name: '新' + ({ DEPARTMENT: '部门', PROJECT: '项目' })[type] };
    }
    var id = type.toLowerCase().replace(/_/g, '-') + '-new-' + (Date.now() % 100000);
    doc.nodes.push({ id: id, type: type, properties: props });
    state.dirty = true;
    markDirty();
    renderWorkbench();
    selectNode(id);
    toast('已新增节点，请在右侧编辑属性');
  }

  // 全局入口（动态按钮 onclick 使用）
  function addNodeOf(type) { addNode(type); }

  function addCollabEdge() {
    if (state.templateId === 'customer-ecosystem') { addGenericEdge(); return; }
    var doc = ensureDraft();
    var emps = doc.nodes.filter(function (n) { return n.type === 'EMPLOYEE'; });
    if (emps.length < 2) { toast('至少需要 2 名员工节点', 'err'); return; }
    var nameOf = {};
    doc.nodes.forEach(function (n) { nameOf[n.id] = (n.properties || {}).name || n.id; });
    var opts = emps.map(function (n) { return '<option value="' + esc(n.id) + '">' + esc(nameOf[n.id]) + '</option>'; }).join('');
    $('inspector-title').textContent = '新增协作边';
    $('inspector').innerHTML =
      '<div class="inspector-form">' +
      '<label class="field-label">源员工</label><select id="new-edge-src">' + opts + '</select>' +
      '<label class="field-label">目标员工</label><select id="new-edge-tgt">' + opts + '</select>' +
      '<label class="field-label">weight（0-10）</label><input type="number" id="new-edge-w" min="0" max="10" step="0.1" value="5">' +
      '<button class="btn btn-primary" id="insp-save">创建边</button></div>';
    $('insp-save').addEventListener('click', function () {
      var src = $('new-edge-src').value;
      var tgt = $('new-edge-tgt').value;
      if (src === tgt) { toast('不允许自环边', 'err'); return; }
      doc.edges.push({
        id: 'edge-x' + (doc.edges.length + 1), type: 'COLLABORATES', source: src, target: tgt,
        properties: { weight: Number($('new-edge-w').value) || 5, signals: [], origin: 'manual' },
      });
      state.dirty = true;
      markDirty();
      renderWorkbench();
      toast('协作边已创建（manual，重算信号边不会被替换）');
    });
  }

  // 通用新增边（模板边类型下拉 + 端点类型过滤）
  function addGenericEdge() {
    var doc = ensureDraft();
    var defs = state.template && Array.isArray(state.template.edge_types) ? state.template.edge_types : [];
    if (!defs.length) { toast('模板未加载，无法新建边', 'err'); return; }
    var nameOf = {};
    doc.nodes.forEach(function (n) { nameOf[n.id] = (n.properties || {}).name || n.id; });

    function renderOptions(def) {
      var srcNodes = doc.nodes.filter(function (n) { return def.source_types.indexOf(n.type) >= 0; });
      var tgtNodes = doc.nodes.filter(function (n) { return def.target_types.indexOf(n.type) >= 0; });
      var srcOpts = srcNodes.map(function (n) { return '<option value="' + esc(n.id) + '">' + esc(nameOf[n.id]) + '</option>'; }).join('');
      var tgtOpts = tgtNodes.map(function (n) { return '<option value="' + esc(n.id) + '">' + esc(nameOf[n.id]) + '</option>'; }).join('');
      $('new-edge-src').innerHTML = srcOpts || '<option value="">（无可用源节点）</option>';
      $('new-edge-tgt').innerHTML = tgtOpts || '<option value="">（无可用目标节点）</option>';
    }

    var typeOpts = defs.map(function (d) { return '<option value="' + esc(d.type) + '">' + esc(d.label || d.type) + '</option>'; }).join('');
    $('inspector-title').textContent = '新增边（' + (state.template.name || '') + '）';
    $('inspector').innerHTML =
      '<div class="inspector-form">' +
      '<label class="field-label">边类型</label><select id="new-edge-type">' + typeOpts + '</select>' +
      '<label class="field-label">源节点</label><select id="new-edge-src"></select>' +
      '<label class="field-label">目标节点</label><select id="new-edge-tgt"></select>' +
      '<label class="field-label">weight（0-10）</label><input type="number" id="new-edge-w" min="0" max="10" step="0.1" value="5">' +
      '<label class="field-label">relationType（原始标签，可空）</label><input type="text" id="new-edge-rel" placeholder="如：子公司 / 关键决策人">' +
      '<button class="btn btn-primary" id="insp-save">创建边</button></div>';
    var typeSel = $('new-edge-type');
    function currentDef() { return defs.filter(function (d) { return d.type === typeSel.value; })[0]; }
    renderOptions(currentDef());
    typeSel.addEventListener('change', function () { renderOptions(currentDef()); });
    $('insp-save').addEventListener('click', function () {
      var def = currentDef();
      var src = $('new-edge-src').value;
      var tgt = $('new-edge-tgt').value;
      if (!src || !tgt) { toast('源/目标节点不可用（按端点类型过滤）', 'err'); return; }
      if (src === tgt) { toast('不允许自环边', 'err'); return; }
      doc.edges.push({
        id: 'edge-x' + (doc.edges.length + 1), type: def.type, source: src, target: tgt,
        properties: { weight: Number($('new-edge-w').value) || 5, relationType: $('new-edge-rel').value.trim(), origin: 'manual' },
      });
      state.dirty = true;
      markDirty();
      renderWorkbench();
      toast('边已创建（manual）');
    });
  }

  // ── 重算信号边 ──
  function recalcSignals() {
    var doc = ensureDraft();
    // 全量数据重算（项目/协作热度信号不能丢）：manual/expert 边由 mergeAutoEdges 保留
    var converted = OrgGraphModel.convertToConsumerGraph(doc);
    var company = { employees: converted.employees, projects: converted.projects, interactions: converted.interactions };
    var collab = OrgGraphSignals.buildOrgGraph(company).edges;
    var structural = [];
    var before = { auto: 0, kept: 0 };
    doc.edges.forEach(function (e) {
      var p = e.properties || {};
      if (e.type === 'COLLABORATES') {
        if (p.origin === 'manual' || p.origin === 'expert') before.kept++;
        else before.auto++;
      }
    });
    var merged = OrgGraphSignals.mergeAutoEdges(doc, collab, structural);
    var after = { auto: 0, kept: 0 };
    merged.edges.forEach(function (e) {
      var p = e.properties || {};
      if (e.type === 'COLLABORATES') {
        if (p.origin === 'manual' || p.origin === 'expert') after.kept++;
        else after.auto++;
      }
    });
    if (!confirm('重算信号边：auto 边 ' + before.auto + ' → ' + after.auto + ' 条（manual/expert ' + before.kept + ' 条保留）。确认应用？')) return;
    state.document = merged;
    state.dirty = true;
    markDirty();
    renderWorkbench();
    toast('信号边已重算（manual/expert 保留）');
  }

  // ═══════════════ 发布 ═══════════════
  function refreshPublish() {
    $('validation-report').innerHTML = '';
    api('/status').then(function (s) {
      state.status = s;
      var html = '';
      (s.versions || []).slice().reverse().forEach(function (v) {
        html += '<div class="version-row"><span class="ver">' + esc(v.version) + '</span>' +
          '<span class="muted">' + (v.stats ? v.stats.nodes + ' 节点 / ' + v.stats.edges + ' 边' : '') + '</span>' +
          '<span class="note">' + esc(v.note || '') + '</span>' +
          (v.version === s.activeVersion ? '<span class="active-flag">● 当前</span>' : '') +
          (v.version !== s.activeVersion ? '<button class="btn btn-sm" data-rollback="' + esc(v.version) + '">回退到此版</button>' : '') +
          '</div>';
      });
      $('version-list').innerHTML = html || '<span class="muted">暂无版本</span>';
      document.querySelectorAll('[data-rollback]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var ver = btn.dataset.rollback;
          if (!confirm('回退：加载 ' + ver + ' 为草稿，校验后需重新发布为新版本。继续？')) return;
          api('/load?version=' + encodeURIComponent(ver)).then(function (doc) {
            state.document = doc;
            state.dirty = true;
            markDirty();
            toast(ver + ' 已加载为草稿，请在校验通过后发布');
            switchView('workbench');
          }).catch(function (e) { toast('加载失败：' + e.message, 'err'); });
        });
      });
    }).catch(function (e) { $('version-list').innerHTML = '<span style="color:var(--org-danger)">' + esc(e.message) + '</span>'; });
  }

  function runValidate() {
    var doc = ensureDraft();
    api('/validate', { method: 'POST', body: { document: doc } }).then(function (r) {
      // 服务端资产化后校验报告字段为 asset（旧版为 org），兼容读取
      var assetCheck = r.asset || r.org || { errors: [], warnings: [] };
      var html = '';
      if (r.valid) {
        html += '<div class="ok-line">✓ 校验通过，可以发布</div>';
      } else {
        (assetCheck.errors || []).forEach(function (e) { html += '<div class="err-line">✗ [' + esc(e.code) + '] ' + esc(e.message) + '</div>'; });
        (r.template.errors || []).forEach(function (e) { html += '<div class="err-line">✗ [模板] ' + esc(e.message) + '</div>'; });
      }
      (assetCheck.warnings || []).forEach(function (w) { html += '<div class="warn-line">⚠ ' + esc(w.message) + '</div>'; });
      (r.template.warnings || []).forEach(function (w) { html += '<div class="warn-line">⚠ [模板] ' + esc(w.message) + '</div>'; });
      $('validation-report').innerHTML = html;
      return r;
    }).catch(function (e) { $('validation-report').innerHTML = '<div class="err-line">' + esc(e.message) + '</div>'; });
  }

  function runPublish() {
    var doc = ensureDraft();
    var note = $('publish-note').value.trim();
    var isCust = state.templateId === 'customer-ecosystem';
    api('/publish', { method: 'POST', body: { document: doc, note: note } }).then(function (r) {
      toast('发布成功：' + r.version + (isCust ? '' : '（日程 Agent 下次请求即消费）'), 'ok');
      $('publish-note').value = '';
      refreshPublish();
      refreshStatus();
    }).catch(function (e) {
      if (e.validation) {
        var html = '';
        var assetCheck = e.validation.asset || e.validation.org || { errors: [] };
        (assetCheck.errors || []).forEach(function (x) { html += '<div class="err-line">✗ [' + esc(x.code) + '] ' + esc(x.message) + '</div>'; });
        (e.validation.template.errors || []).forEach(function (x) { html += '<div class="err-line">✗ [模板] ' + esc(x.message) + '</div>'; });
        $('validation-report').innerHTML = html;
      }
      toast('发布失败：' + e.message, 'err');
    });
  }

  function runSeed() {
    var isCust = state.templateId === 'customer-ecosystem';
    var msg = isCust
      ? '从真实数据（25 家对公客户画像 + 40 条企业关系 CSV）生成客户生态种子图谱并发布为 v1？'
      : '生成 mock 种子图谱（157 人银行总行）并发布为 v1？';
    if (!confirm(msg)) return;
    api('/seed', { method: 'POST' }).then(function (r) {
      if (r.seeded) toast('种子图谱已发布：' + r.version, 'ok');
      else toast('已有发布版本（' + r.activeVersion + '），跳过', 'err');
      refreshStatus();
      refreshPublish();
    }).catch(function (e) { toast('种子发布失败：' + e.message, 'err'); });
  }

  // ═══════════════ 事件绑定（首次激活时执行一次） ═══════════════
  function bindEventsOnce() {
    document.querySelectorAll('#orgBar .org-tab').forEach(function (t) {
      t.addEventListener('click', function () { switchView(t.dataset.view); });
    });
    document.querySelectorAll('#orgView [data-auto]').forEach(function (b) {
      b.addEventListener('click', function () { startAuto(b.dataset.auto); });
    });
    document.querySelectorAll('#orgView [data-goto]').forEach(function (b) {
      b.addEventListener('click', function () { showStep(b.dataset.goto); });
    });
    $('btn-refresh-status').addEventListener('click', refreshStatus);
    $('btn-goto-workbench').addEventListener('click', function () { switchView('workbench'); });
    $('btn-seed').addEventListener('click', runSeed);

    $('btn-signals-preview').addEventListener('click', function () {
      try { runSignalsPreview(); } catch (e) { toast('解析失败：' + e.message, 'err'); }
    });
    // 智能体：粘贴任意内容 → 自动识别类型 → 一键执行（内容灌入对应步骤输入框，复用三件套管线与确认队列）
    $('input-agent').addEventListener('input', function () {
      var mode = detectInputType(this.value);
      $('agent-detect').textContent = '智能体识别：' + (mode ? AGENT_MODE_LABEL[mode] : '—（粘贴内容后自动识别）');
    });
    $('btn-agent-run').addEventListener('click', function () {
      var text = $('input-agent').value.trim();
      if (!text) { toast('请粘贴内容', 'err'); return; }
      var mode = detectInputType(text);
      if (!mode) { toast('无法识别内容类型', 'err'); return; }
      if (mode === 'signals') {
        $('input-signals').value = text;
        startAuto('signals');
        try { runSignalsPreview(); } catch (e) { toast(e.message, 'err'); }
      } else if (mode === 'extract') {
        $('input-extract').value = text;
        startAuto('extract');
        runExtract();
      } else {
        $('input-generate').value = text;
        startAuto('generate');
        runGenerate();
      }
    });
    $('btn-extract-run').addEventListener('click', runExtract);
    $('btn-generate-run').addEventListener('click', runGenerate);
    $('btn-preview-merge').addEventListener('click', applyMerge);
    $('btn-preview-discard').addEventListener('click', function () { showStep('choose'); });

    // 「+节点」按钮由 renderWorkbench 按模板动态重建（OrgAdapter.addNodeOf）
    $('btn-add-collab').addEventListener('click', addCollabEdge);
    $('btn-recalc').addEventListener('click', recalcSignals);
    $('btn-save-draft').addEventListener('click', function () { saveDraft(); });
    window.addEventListener('resize', resizeCanvas);

    $('btn-validate').addEventListener('click', runValidate);
    $('btn-publish').addEventListener('click', runPublish);

    // 图谱数据类型切换（员工图谱 / 客户生态）
    $('orgAssetSelect').addEventListener('change', function () { switchAsset(this.value); });
  }

  // ═══════════════ 数据类型切换（资产切换：草稿落当前资产 → 状态重置 → 新资产加载） ═══════════════
  function switchAsset(newId) {
    newId = newId || 'org-people';
    if (newId === state.templateId) return;
    // 1. 当前资产脏草稿先落盘（api 自动带当前 asset）
    if (state.dirty && state.document) {
      api('/save', { method: 'POST', body: { document: state.document } }).catch(function () {});
      state.dirty = false;
      $('hdr-draft').style.display = 'none';
    }
    // 2. 销毁 G6 + 重置状态
    if (state.g6) { try { state.g6.destroy(); } catch (e) {} state.g6 = null; }
    state.templateId = newId;
    $('orgAssetSelect').value = newId;
    state.document = null;
    state.template = null;
    state.status = null;
    state.autoMode = null;
    state.autoPayload = null;
    state.selectedNodeId = null;
    state.selectedEdgeId = null;
    wbLoaded = false;
    // 3. 回总览 + 按新资产加载工作文档
    switchView('home');
    loadWorkingDocument().then(function (doc) { if (doc) state.document = doc; }).catch(function () {});
  }

  // ═══════════════ 领域激活/停用 ═══════════════
  function activate() {
    if (!state.activated) {
      buildOrgViewDOM();
      bindEventsOnce();
      state.activated = true;
    }
    $('orgAssetSelect').value = state.templateId;
    switchView(state.view); // 恢复上次视图（home 会 refreshStatus；workbench 会 initWorkbench）
    // 每次激活重新预加载工作文档（deactivate 时已自动保存草稿，此处加载最新服务端状态）
    loadWorkingDocument().then(function (doc) { if (doc) state.document = doc; }).catch(function () {});
  }

  function deactivate() {
    if (state.g6) {
      try { state.g6.destroy(); } catch (e) {}
      state.g6 = null;
    }
    if (state.dirty && state.document) {
      // 防未保存丢失：org 草稿服务端持久化，自动保存零成本
      api('/save', { method: 'POST', body: { document: state.document } }).then(function () {
        state.dirty = false;
        $('hdr-draft').style.display = 'none';
      }).catch(function () { /* 保存失败不阻塞切换 */ });
    }
  }

  // ═══════════════ 领域切换 ═══════════════
  function switchDomain(name) {
    if (!name || name === DOMAIN.current) return;
    if (name === 'org') {
      DOMAIN.current = 'org';
      pauseIntent();
      INTENT_ELEMENTS.forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.style.display = 'none';
      });
      document.getElementById('intentBar').style.display = 'none';
      document.getElementById('orgBar').style.display = 'flex';
      document.getElementById('orgView').style.display = 'block';
      // domain-switch 按钮已由 IA 左导航取代（2026-08-25）——null 守卫防按钮删除后 TypeError
      var btnIntent = document.getElementById('domainIntent');
      if (btnIntent) btnIntent.classList.remove('active');
      var btnOrg = document.getElementById('domainOrg');
      if (btnOrg) btnOrg.classList.add('active');
      activate();
    } else if (name === 'intent') {
      deactivate();
      DOMAIN.current = 'intent';
      document.getElementById('orgView').style.display = 'none';
      document.getElementById('orgBar').style.display = 'none';
      var btnOrgEl = document.getElementById('domainOrg');
      if (btnOrgEl) btnOrgEl.classList.remove('active');
      var btnIntentEl = document.getElementById('domainIntent');
      if (btnIntentEl) btnIntentEl.classList.add('active');
      resumeIntent();
      if (window.IA) IA.renderStagePanel(null); // [IA] 意图域隐藏阶段功能面板
    }
  }

  // ── 暴露全局（CDP/手工调试用） ──
  window.switchDomain = switchDomain;
  window.OrgAdapter = {
    state: state,
    activate: activate,
    deactivate: deactivate,
    switchView: switchView,
    switchAsset: switchAsset,
    addNodeOf: addNodeOf,
    startAuto: startAuto,
    showStep: showStep,
    renderPreview: renderPreview,
  };
})();
