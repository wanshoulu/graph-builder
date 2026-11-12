/**
 * 意图图谱自动构建 — 前端 overlay 适配器（意图领域）
 *
 * 入口：编辑器顶栏「🤖 自动构建」按钮 → 全屏 overlay（#intentAutoView）
 * 流程：候选选择（menu-tree intent_candidate/semantic_aggregation）
 *   → SSE 批量生成（XHR onprogress 解析，dry_run 调试模式）
 *   → 表格式预览（不进 G6，规避大图渲染慢）
 *   → 并入当前编辑器图 S.graph（按 intent_id 去重）→ renderAll() 一次
 *
 * 约定：overlay 打开期间不销毁 S.g6（避免大图重建）；键盘事件经 capture 拦截不再冒泡，
 *       意图 inline JS 零改动。全局暴露 window.IntentAutoBuild = { open, close, state }。
 */
(function () {
  'use strict';
  if (window.IntentAutoBuild) return; // 防重复加载

  var state = {
    open: false,
    built: false,
    candidates: [], selected: {}, // node_id -> true
    role: 'intent_candidate', domain: '', q: '', page: 1, pageSize: 50, total: 0,
    generating: false, jobId: null, lastJob: null, // {job_id, total, done, failed_count, produced}
    produced: [], pkg: null, xhr: null,
  };

  // ── DOM 构建（惰性，首次 open 时注入 #intentAutoView）──

  function buildDOM() {
    if (state.built) return;
    state.built = true;
    var host = document.getElementById('intentAutoView');
    if (!host) return;
    host.innerHTML = [
      '<style>',
      '#intentAutoView{position:fixed;inset:0;z-index:50;background:#f1f5f9;overflow:hidden;font-family:inherit;}',
      '#intentAutoView *{box-sizing:border-box;}',
      '#intentAutoView .iab-header{display:flex;align-items:center;gap:10px;padding:10px 16px;background:#fff;border-bottom:1px solid #e2e8f0;}',
      '#intentAutoView .iab-title{font-weight:600;font-size:14px;color:#0f172a;}',
      '#intentAutoView .iab-job{font-size:11px;color:#64748b;}',
      '#intentAutoView .iab-spacer{flex:1;}',
      '#intentAutoView .iab-btn{border:1px solid #cbd5e1;background:#fff;color:#334155;padding:5px 12px;border-radius:6px;font-size:12px;cursor:pointer;}',
      '#intentAutoView .iab-btn:hover{border-color:#94a3b8;}',
      '#intentAutoView .iab-btn:disabled{opacity:.45;cursor:not-allowed;}',
      '#intentAutoView .iab-btn-pri{background:#7c3aed;border-color:#7c3aed;color:#fff;}',
      '#intentAutoView .iab-btn-pri:hover{border-color:#6d28d9;}',
      '#intentAutoView .iab-btn-pri:disabled{background:#c4b5fd;border-color:#c4b5fd;}',
      '#intentAutoView .iab-body{display:flex;height:calc(100% - 45px);}',
      '#intentAutoView .iab-left{width:44%;display:flex;flex-direction:column;border-right:1px solid #e2e8f0;background:#fff;}',
      '#intentAutoView .iab-filters{display:flex;gap:6px;padding:10px 12px;border-bottom:1px solid #e2e8f0;flex-wrap:wrap;align-items:center;}',
      '#intentAutoView .iab-filters select,#intentAutoView .iab-filters input{border:1px solid #cbd5e1;border-radius:6px;padding:4px 8px;font-size:12px;background:#fff;}',
      '#intentAutoView .iab-list{flex:1;overflow-y:auto;padding:6px 0;}',
      '#intentAutoView .iab-row{display:flex;align-items:flex-start;gap:8px;padding:6px 12px;border-bottom:1px solid #f1f5f9;font-size:12px;cursor:pointer;}',
      '#intentAutoView .iab-row:hover{background:#f8fafc;}',
      '#intentAutoView .iab-row input{margin-top:2px;}',
      '#intentAutoView .iab-name{font-weight:600;color:#0f172a;}',
      '#intentAutoView .iab-meta{color:#64748b;font-size:11px;margin-top:2px;}',
      '#intentAutoView .iab-pager{display:flex;gap:8px;align-items:center;padding:8px 12px;border-top:1px solid #e2e8f0;font-size:12px;color:#475569;}',
      '#intentAutoView .iab-right{flex:1;display:flex;flex-direction:column;min-width:0;}',
      '#intentAutoView .iab-gen{padding:12px 16px;border-bottom:1px solid #e2e8f0;display:flex;flex-direction:column;gap:8px;}',
      '#intentAutoView .iab-gen-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:12px;color:#334155;}',
      '#intentAutoView .iab-gen-row label{display:flex;align-items:center;gap:4px;}',
      '#intentAutoView .iab-gen-row input[type=number]{width:56px;border:1px solid #cbd5e1;border-radius:6px;padding:3px 6px;font-size:12px;}',
      '#intentAutoView .iab-bar{height:8px;background:#e2e8f0;border-radius:4px;overflow:hidden;}',
      '#intentAutoView .iab-bar-fill{height:100%;width:0;background:#7c3aed;transition:width .25s;}',
      '#intentAutoView .iab-log{max-height:150px;overflow-y:auto;background:#0f172a;color:#cbd5e1;border-radius:6px;padding:8px 10px;font-family:Consolas,monospace;font-size:11px;}',
      '#intentAutoView .iab-log .err{color:#f87171;}',
      '#intentAutoView .iab-log .ok{color:#4ade80;}',
      '#intentAutoView .iab-preview{flex:1;overflow-y:auto;padding:12px 16px;}',
      '#intentAutoView .iab-summary{font-size:12px;color:#334155;margin-bottom:8px;}',
      '#intentAutoView .iab-group{margin-bottom:12px;}',
      '#intentAutoView .iab-group-title{font-weight:600;font-size:12px;color:#7c3aed;margin:6px 0;}',
      '#intentAutoView .iab-prow{display:flex;align-items:center;gap:8px;padding:4px 8px;border-bottom:1px solid #f1f5f9;font-size:12px;}',
      '#intentAutoView .iab-prow input{flex-shrink:0;}',
      '#intentAutoView .iab-tag{display:inline-block;padding:1px 6px;border-radius:4px;font-size:10px;margin-right:4px;background:#e0e7ff;color:#4338ca;}',
      '#intentAutoView .iab-tag.t-ASK{background:#fef3c7;color:#92400e;}',
      '#intentAutoView .iab-tag.t-DO{background:#fce7f3;color:#9d174d;}',
      '#intentAutoView .iab-tag.t-QUERY{background:#e0f2fe;color:#075985;}',
      '#intentAutoView .iab-merge-row{padding:10px 0;}',
      '#intentAutoView .iab-empty{color:#94a3b8;font-size:12px;padding:20px;text-align:center;}',
      '</style>',
      '<div class="iab-header">',
      '  <span class="iab-title">🤖 意图图谱自动构建 <span style="font-weight:400;color:#64748b">— 菜单树数据 → LLM 七段意图节点</span></span>',
      '  <span class="iab-job" id="iab-job"></span>',
      '  <span class="iab-spacer"></span>',
      '  <button class="iab-btn" id="iab-resume" style="display:none">↻ 继续上次任务</button>',
      '  <button class="iab-btn" id="iab-retry" style="display:none">重试失败批</button>',
      '  <button class="iab-btn" id="iab-close">✕ 关闭</button>',
      '</div>',
      '<div class="iab-body">',
      '  <div class="iab-left">',
      '    <div class="iab-filters">',
      '      <select id="iab-role"><option value="intent_candidate">意图候选 (650)</option><option value="semantic_aggregation">语义聚合 (18)</option></select>',
      '      <select id="iab-domain"><option value="">全部领域</option></select>',
      '      <input id="iab-q" placeholder="🔍 关键词筛选" style="width:140px">',
      '      <button class="iab-btn" id="iab-search">搜索</button>',
      '      <span style="flex:1"></span>',
      '      <button class="iab-btn" id="iab-selectall">本页全选</button>',
      '      <button class="iab-btn" id="iab-clear">清空</button>',
      '    </div>',
      '    <div class="iab-list" id="iab-list"><div class="iab-empty">加载候选中...</div></div>',
      '    <div class="iab-pager">',
      '      <button class="iab-btn" id="iab-prev">‹ 上一页</button>',
      '      <span id="iab-pageinfo">-</span>',
      '      <button class="iab-btn" id="iab-next">下一页 ›</button>',
      '      <span style="flex:1"></span>',
      '      <span id="iab-selcount" style="color:#7c3aed;font-weight:600">已选 0</span>',
      '    </div>',
      '  </div>',
      '  <div class="iab-right">',
      '    <div class="iab-gen">',
      '      <div class="iab-gen-row">',
      '        <label>批大小 <input type="number" id="iab-batch" value="10" min="1" max="20"></label>',
      '        <label>并发 <input type="number" id="iab-conc" value="2" min="1" max="4"></label>',
      '        <label><input type="checkbox" id="iab-dryrun" checked> dry_run 模板调试（不调 LLM）</label>',
      '        <span style="flex:1"></span>',
      '        <button class="iab-btn iab-btn-pri" id="iab-start">▶ 开始生成</button>',
      '      </div>',
      '      <div class="iab-bar"><div class="iab-bar-fill" id="iab-barfill"></div></div>',
      '      <div class="iab-gen-row" style="color:#64748b" id="iab-progress">未开始</div>',
      '      <div class="iab-log" id="iab-log"></div>',
      '    </div>',
      '    <div class="iab-preview" id="iab-preview"><div class="iab-empty">生成完成后在此预览并选择并入编辑器的节点</div></div>',
      '  </div>',
      '</div>',
    ].join('\n');
    bindEvents();
  }

  // ── 事件绑定 ──

  function bindEvents() {
    $('iab-close').addEventListener('click', close);
    $('iab-search').addEventListener('click', function() { state.page = 1; loadCandidates(); });
    $('iab-q').addEventListener('keydown', function(e) { if (e.key === 'Enter') { state.page = 1; loadCandidates(); } });
    $('iab-role').addEventListener('change', function() { state.role = this.value; state.page = 1; state.selected = {}; updateSelCount(); loadCandidates(); });
    $('iab-domain').addEventListener('change', function() { state.domain = this.value; state.page = 1; state.selected = {}; updateSelCount(); loadCandidates(); });
    $('iab-prev').addEventListener('click', function() { if (state.page > 1) { state.page--; loadCandidates(); } });
    $('iab-next').addEventListener('click', function() { if (state.page * state.pageSize < state.total) { state.page++; loadCandidates(); } });
    $('iab-selectall').addEventListener('click', function() {
      state.candidates.forEach(function(c) { state.selected[c.node_id] = true; });
      renderList(); updateSelCount();
    });
    $('iab-clear').addEventListener('click', function() { state.selected = {}; renderList(); updateSelCount(); });
    $('iab-start').addEventListener('click', startGeneration);
    $('iab-resume').addEventListener('click', resumeGeneration);
    $('iab-retry').addEventListener('click', retryFailures);
    // 键盘事件 capture 拦截：阻止编辑器 document keydown（Delete/Ctrl+C 等）作用于画布
    document.getElementById('intentAutoView').addEventListener('keydown', function(e) { e.stopPropagation(); }, true);
  }

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ── 候选加载 ──

  function loadCandidates() {
    var q = 'role=' + encodeURIComponent(state.role) +
      '&domain=' + encodeURIComponent(state.domain) +
      '&q=' + encodeURIComponent(state.q) +
      '&page=' + state.page + '&pageSize=' + state.pageSize;
    fetch('/api/intent-graph-autobuild/candidates?' + q)
      .then(function(r) { return r.json(); })
      .then(function(j) {
        if (!j.success) { renderListError(j.error); return; }
        state.candidates = j.data.items;
        state.total = j.data.total;
        $('iab-pageinfo').textContent = '第 ' + j.data.page + ' 页 / 共 ' + Math.ceil(j.data.total / j.data.pageSize) + ' 页 · ' + j.data.total + ' 个候选';
        renderList();
      })
      .catch(function(e) { renderListError(e.message); });
  }

  function renderListError(msg) {
    $('iab-list').innerHTML = '<div class="iab-empty">加载失败: ' + esc(msg) + '</div>';
  }

  function renderList() {
    var list = $('iab-list');
    if (!state.candidates.length) { list.innerHTML = '<div class="iab-empty">无候选（可切换筛选条件）</div>'; return; }
    var html = '';
    state.candidates.forEach(function(c) {
      var checked = state.selected[c.node_id] ? ' checked' : '';
      html += '<div class="iab-row" data-id="' + esc(c.node_id) + '">' +
        '<input type="checkbox"' + checked + ' data-id="' + esc(c.node_id) + '">' +
        '<div><div class="iab-name">' + esc(c.node_name) + '</div>' +
        '<div class="iab-meta">' + esc(c.domain) + ' · ' + esc(c.path) +
        (c.trigger_texts.length ? ' · 触发词:' + esc(c.trigger_texts.slice(0, 3).join('/')) : '') + '</div></div></div>';
    });
    list.innerHTML = html;
    list.querySelectorAll('input[type=checkbox]').forEach(function(cb) {
      cb.addEventListener('change', function() {
        var id = cb.getAttribute('data-id');
        if (cb.checked) state.selected[id] = true; else delete state.selected[id];
        updateSelCount();
      });
    });
  }

  function updateSelCount() {
    $('iab-selcount').textContent = '已选 ' + Object.keys(state.selected).length;
  }

  // ── SSE 生成（XHR onprogress 解析 data: 事件）──

  function postSSE(path, body, onEvent, onFinish) {
    var xhr = new XMLHttpRequest();
    xhr.open('POST', path, true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.setRequestHeader('Accept', 'text/event-stream');
    var buffer = '';
    xhr.onprogress = function() {
      var text = xhr.responseText;
      buffer += text.slice(lastLen);
      lastLen = text.length;
      var parts = buffer.split('\n\n');
      buffer = parts.pop();
      parts.forEach(function(p) {
        var m = p.match(/^data: (.+)$/m);
        if (!m) return;
        try { onEvent(JSON.parse(m[1])); } catch(e) {}
      });
    };
    var lastLen = 0;
    xhr.onload = function() {
      if (buffer) {
        var m = buffer.match(/^data: (.+)$/m);
        if (m) { try { onEvent(JSON.parse(m[1])); } catch(e) {} }
      }
      onFinish();
    };
    xhr.onerror = function() { onFinish(); };
    xhr.send(JSON.stringify(body));
    state.xhr = xhr;
    return xhr;
  }

  function logLine(text, cls) {
    var log = $('iab-log');
    var div = document.createElement('div');
    if (cls) div.className = cls;
    div.textContent = text;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  function startGeneration() {
    var ids = Object.keys(state.selected);
    if (!ids.length) { logLine('请先在左侧勾选候选节点', 'err'); return; }
    if (state.generating) { logLine('已有任务进行中', 'err'); return; }
    var body = {
      candidate_ids: ids,
      batch_size: parseInt($('iab-batch').value, 10) || 10,
      concurrency: parseInt($('iab-conc').value, 10) || 2,
      dry_run: $('iab-dryrun').checked,
    };
    runGeneration(body);
  }

  function retryFailures() {
    if (state.generating) return;
    var failedIds = [];
    (state.lastJob && state.lastJob.failures || []).forEach(function(f) {
      failedIds = failedIds.concat(f.candidate_ids);
    });
    if (!failedIds.length) { logLine('没有失败批次', 'err'); return; }
    $('iab-retry').style.display = 'none';
    runGeneration({ candidate_ids: failedIds, batch_size: 10, concurrency: 2, dry_run: $('iab-dryrun').checked });
  }

  function resumeGeneration() {
    if (state.generating) return;
    var body = { batch_size: parseInt($('iab-batch').value, 10) || 10, concurrency: parseInt($('iab-conc').value, 10) || 2 };
    runGeneration(body, true);
  }

  function runGeneration(body, isResume) {
    state.generating = true;
    state.produced = [];
    state.pkg = null;
    state.lastJob = null;
    $('iab-start').disabled = true;
    $('iab-retry').disabled = true;
    $('iab-resume').disabled = true;
    $('iab-barfill').style.width = '0%';
    $('iab-progress').textContent = '任务启动中...';
    $('iab-preview').innerHTML = '<div class="iab-empty">生成中...（dry_run 模板化 / 关闭开关后走 LLM 批量）</div>';
    logLine('── 开始生成（' + (body.dry_run ? 'dry_run' : 'LLM') + '）──');

    var path = isResume ? '/api/intent-graph-autobuild/job/' + state.jobId + '/resume'
                        : '/api/intent-graph-autobuild/generate';
    postSSE(path, body, function(evt) {
      if (evt.type === 'job') {
        state.jobId = evt.job_id;
        try { localStorage.setItem('iab-autobuild-job', evt.job_id); } catch(e) {}
        $('iab-job').textContent = '任务 ' + evt.job_id + ' · 菜单树 ' + (evt.menu_tree_version || '');
      } else if (evt.type === 'batch_start') {
        logLine('批次 ' + (evt.batch_index + 1) + ' 开始（' + evt.candidate_ids.length + ' 节点）');
      } else if (evt.type === 'node') {
        state.produced.push(evt.intent_node);
      } else if (evt.type === 'batch_done') {
        logLine('批次 ' + (evt.batch_index + 1) + ' 完成：+' + evt.produced + ' 节点 / ' + evt.edges + ' 建议边（' + evt.duration_ms + 'ms）', 'ok');
      } else if (evt.type === 'batch_failed') {
        logLine('批次 ' + (evt.batch_index + 1) + ' 失败：' + evt.error + (evt.retrying ? '（重试中...）' : ''), 'err');
      } else if (evt.type === 'progress') {
        var pct = evt.total ? Math.round(evt.done * 100 / evt.total) : 0;
        $('iab-barfill').style.width = pct + '%';
        $('iab-progress').textContent = '进度 ' + evt.done + '/' + evt.total + ' · 已生成 ' + evt.produced + ' · 失败 ' + evt.failed_count;
        state.lastJob = evt;
      } else if (evt.type === 'done') {
        state.lastJob = evt.summary;
        logLine('完成：' + evt.summary.produced + ' 节点 / 失败 ' + evt.summary.failed_count, 'ok');
      } else if (evt.type === 'error') {
        logLine('错误：' + evt.message, 'err');
      }
    }, function() {
      state.generating = false;
      $('iab-start').disabled = false;
      $('iab-retry').disabled = false;
      $('iab-resume').disabled = false;
      if (state.lastJob && state.lastJob.failures && state.lastJob.failures.length) {
        $('iab-retry').style.display = '';
      }
      if (state.lastJob) loadPreview();
    });
  }

  // ── 预览与并入 ──

  function loadPreview() {
    fetch('/api/intent-graph-autobuild/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id: state.jobId }),
    }).then(function(r) { return r.json(); })
      .then(function(j) {
        if (!j.success || !j.package) {
          $('iab-preview').innerHTML = '<div class="iab-empty">预览失败: ' + esc(j.error || '未知错误') + '</div>';
          return;
        }
        state.pkg = j.package;
        renderPreview(j);
      })
      .catch(function(e) {
        $('iab-preview').innerHTML = '<div class="iab-empty">预览失败: ' + esc(e.message) + '</div>';
      });
  }

  function renderPreview(j) {
    var pkg = j.package;
    var v = j.validation || {};
    var byDomain = {};
    pkg.intent_nodes.forEach(function(n) {
      var d = n.identity.domain || '(未分类)';
      if (!byDomain[d]) byDomain[d] = [];
      byDomain[d].push(n);
    });
    var html = '<div class="iab-summary">' +
      '生成 <b>' + pkg.intent_nodes.length + '</b> 叶子 / <b>' + pkg.aggregate_intents.length + '</b> 聚合 / <b>' + pkg.edges.length + '</b> 边' +
      ' · 校验 <b>' + (v.valid ? '通过' : v.errors.length + ' 错误') + '</b>' +
      (v.warnings && v.warnings.length ? ' · ' + v.warnings.length + ' 警告' : '') +
      ' · 模型 ' + esc(pkg.meta.autobuild_info && pkg.meta.autobuild_info.llm_model) + '</div>';
    Object.keys(byDomain).sort().forEach(function(domain) {
      html += '<div class="iab-group"><div class="iab-group-title">' + esc(domain) + ' (' + byDomain[domain].length + ')</div>';
      byDomain[domain].forEach(function(n) {
        var id = n.identity;
        var tb = n.task_binding;
        html += '<div class="iab-prow">' +
          '<input type="checkbox" checked data-id="' + esc(id.intent_id) + '">' +
          '<span class="iab-tag t-' + esc(id.intent_type) + '">' + esc(id.intent_type) + '</span>' +
          '<span class="iab-name" style="width:150px;flex-shrink:0">' + esc(id.intent_name) + '</span>' +
          '<span class="iab-meta" style="flex:1">' + esc((tb && tb.action ? tb.action.action_code : '') + ' · ' + (tb && tb.business_object ? tb.business_object.object_name : '')) + '</span>' +
          '<span class="iab-meta">' + esc(id.parent_intent_id || '') + '</span></div>';
      });
      html += '</div>';
    });
    html += '<div class="iab-merge-row"><button class="iab-btn iab-btn-pri" id="iab-merge">⬇ 并入编辑器画布</button> ' +
      '<span class="iab-meta" style="color:#64748b;font-size:11px">并入后请用顶栏 ✓校验 / ⬇导出 走专家流程</span></div>';
    $('iab-preview').innerHTML = html;
    $('iab-merge').addEventListener('click', mergeIntoEditor);
  }

  function supportingId(n) {
    return n.object_id || n.action_id || n.slot_id || n.state_id || n.risk_id || n.knowledge_id || n.answer_id || n.runtime_boundary_id || n.id;
  }

  function mergeIntoEditor() {
    if (!state.pkg) return;
    var pkg = state.pkg;
    var checked = {};
    document.querySelectorAll('#iab-preview input[data-id]').forEach(function(cb) {
      if (cb.checked) checked[cb.getAttribute('data-id')] = true;
    });
    if (!Object.keys(checked).length) { logLine('请至少勾选一个节点', 'err'); return; }

    // 确保 S.graph 骨架存在（编辑器 createBlank 同构）
    if (!window.S) { logLine('编辑器状态 S 不可用', 'err'); return; }
    if (!S.graph || !S.graph.intent_nodes) S.graph = (typeof createBlank === 'function') ? createBlank() : { intent_nodes: [], aggregate_intents: [], supporting_nodes: {}, edges: [] };
    S.graph.aggregate_intents = S.graph.aggregate_intents || [];
    S.graph.intent_nodes = S.graph.intent_nodes || [];
    S.graph.edges = S.graph.edges || [];
    S.graph.supporting_nodes = S.graph.supporting_nodes || {};
    ['business_objects', 'actions', 'slots', 'states', 'risks', 'knowledge_answers', 'runtime_boundaries'].forEach(function(k) {
      S.graph.supporting_nodes[k] = S.graph.supporting_nodes[k] || [];
    });

    var stats = { agg: 0, leaf: 0, sup: 0, edge: 0, skipLeaf: 0 };
    var seenLeaf = {}, seenAgg = {}, seenSup = {}, seenEdge = {};
    S.graph.intent_nodes.forEach(function(n) { if (n.identity && n.identity.intent_id) seenLeaf[n.identity.intent_id] = true; });
    S.graph.aggregate_intents.forEach(function(n) { if (n.intent_id) seenAgg[n.intent_id] = true; });
    ['business_objects', 'actions', 'slots', 'states', 'risks', 'knowledge_answers', 'runtime_boundaries'].forEach(function(k) {
      S.graph.supporting_nodes[k].forEach(function(n) {
        var id = supportingId(n);
        if (id) seenSup[k + ':' + id] = true;
      });
    });
    S.graph.edges.forEach(function(e) {
      if (e.from && e.type && e.to) seenEdge[e.from + '|' + e.type + '|' + e.to] = true;
    });

    pkg.aggregate_intents.forEach(function(n) {
      if (n.intent_id && !seenAgg[n.intent_id]) { S.graph.aggregate_intents.push(n); seenAgg[n.intent_id] = true; stats.agg++; }
    });
    pkg.intent_nodes.forEach(function(n) {
      var id = n.identity && n.identity.intent_id;
      if (!id || !checked[id]) return;
      if (seenLeaf[id]) { stats.skipLeaf++; return; }
      S.graph.intent_nodes.push(n); seenLeaf[id] = true; stats.leaf++;
    });
    var supKeys = { business_objects: true, actions: true, slots: true, states: true, risks: true, knowledge_answers: true, runtime_boundaries: true };
    Object.keys(supKeys).forEach(function(k) {
      (pkg.supporting_nodes[k] || []).forEach(function(n) {
        var id = supportingId(n);
        if (!id || seenSup[k + ':' + id]) return;
        S.graph.supporting_nodes[k].push(n); seenSup[k + ':' + id] = true; stats.sup++;
      });
    });
    pkg.edges.forEach(function(e) {
      var from = e.from || e.source, to = e.to || e.target;
      var key = from + '|' + e.type + '|' + to;
      if (seenEdge[key]) return;
      S.graph.edges.push(e); seenEdge[key] = true; stats.edge++;
    });

    S.dirty = true;
    if (typeof setBadge === 'function') setBadge('warn', '已并入 ' + stats.leaf + ' 个自动生成意图（聚合 ' + stats.agg + ' / 支撑节点 ' + stats.sup + ' / 边 ' + stats.edge + '），待校验');
    logLine('并入完成：叶子 +' + stats.leaf + '（跳过重复 ' + stats.skipLeaf + '）· 聚合 +' + stats.agg + ' · 支撑 +' + stats.sup + ' · 边 +' + stats.edge, 'ok');
    close();
    if (typeof renderAll === 'function') renderAll();
  }

  // ── open / close ──

  function open() {
    if (window.DOMAIN && DOMAIN.current !== 'intent') return;
    buildDOM();
    state.open = true;
    document.getElementById('intentAutoView').style.display = 'block';
    // 领域下拉（复用 /schema domains）
    var domSel = $('iab-domain');
    if (domSel.options.length <= 1) {
      fetch('/api/intent-graph/schema').then(function(r) { return r.json(); }).then(function(j) {
        (j.domains || []).forEach(function(d) {
          var opt = document.createElement('option');
          opt.value = d; opt.textContent = d;
          domSel.appendChild(opt);
        });
      }).catch(function() {});
    }
    loadCandidates();
    // 上次任务恢复入口
    var lastId = null;
    try { lastId = localStorage.getItem('iab-autobuild-job'); } catch(e) {}
    if (lastId) {
      state.jobId = lastId;
      fetch('/api/intent-graph-autobuild/job/' + lastId).then(function(r) { return r.json(); }).then(function(j) {
        if (j.success && j.data && j.data.done < j.data.total) {
          state.lastJob = j.data;
          $('iab-job').textContent = '上次任务 ' + lastId + ' 未完成（' + j.data.done + '/' + j.data.total + '）';
          $('iab-resume').style.display = '';
        }
      }).catch(function() {});
    }
    updateSelCount();
  }

  function close() {
    if (state.generating) {
      if (!confirm('生成进行中，关闭将中断任务（已完成的批次保留在服务端检查点，可继续上次任务）。确定关闭？')) return;
      if (state.xhr) state.xhr.abort();
      state.generating = false;
    }
    state.open = false;
    document.getElementById('intentAutoView').style.display = 'none';
  }

  window.IntentAutoBuild = { open: open, close: close, state: state };
})();
