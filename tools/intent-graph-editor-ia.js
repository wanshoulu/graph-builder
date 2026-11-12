/**
 * 图谱构建器 — 信息架构导航（[IA]，2026-08-25）
 *
 * 左导航注册制渲染：GET /api/org-graph/assets → 「图谱类型」组（模板注册制，加资产零代码出导航项）；
 * 「领域插件」组静态（意图图谱 = 意图 autobuild 专有管线插件）。
 *
 * 切换 = IA.switchGraph(graphId)：
 *   'intent'            → switchDomain('intent')
 *   资产（org-people 等）→ switchDomain('org') 后 OrgAdapter.switchAsset(graphId)（先域后资产，无竞态）
 * 与 #orgAssetSelect 双向同步：select change → 高亮；导航点击 → select 同步（switchAsset 内部设置）。
 */
(function () {
  'use strict';

  var GRAPH_ICONS = { 'org-people': '🏢', 'customer-ecosystem': '🏭' };
  var fallbackAssets = [
    { assetId: 'org-people', name: '员工图谱', templateId: 'org-people', hasPublished: true },
    { assetId: 'customer-ecosystem', name: '客户生态', templateId: 'customer-ecosystem', hasPublished: true },
  ];
  var assets = fallbackAssets;
  var legacyServer = false;

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function currentGraph() {
    if (window.DOMAIN && window.DOMAIN.current === 'org' && window.OrgAdapter && OrgAdapter.state) {
      return OrgAdapter.state.templateId;
    }
    return 'intent';
  }

  function updateCurrentLabel(graphId) {
    var el = document.getElementById('ia-current');
    if (!el) return;
    if (graphId === 'intent') { el.textContent = '🎯 意图图谱'; return; }
    var a = assets.filter(function (x) { return x.assetId === graphId; })[0];
    el.textContent = (GRAPH_ICONS[graphId] || '📦') + ' ' + (a ? a.name : graphId);
  }

  function highlightNav(graphId) {
    document.querySelectorAll('#iaSideNav .ia-nav-item').forEach(function (item) {
      item.classList.toggle('active', item.getAttribute('data-graph') === graphId);
    });
    updateCurrentLabel(graphId);
  }

  function renderNav() {
    var container = document.getElementById('iaNavGraphs');
    if (!container) return;
    var html = '';
    assets.forEach(function (a) {
      html += '<div class="ia-nav-item" id="iaNav-' + a.assetId + '" data-graph="' + esc(a.assetId) + '" onclick="window.IA&&IA.switchGraph(\'' + esc(a.assetId) + '\')">' +
        (GRAPH_ICONS[a.assetId] || '📦') + ' ' + esc(a.name) +
        '<span class="ia-nav-tag">' + (a.hasPublished ? '已发布' : '未发布') + '</span></div>';
    });
    if (legacyServer) {
      html += '<div class="ia-nav-item" style="cursor:default;color:var(--text2);font-size:10px">旧版服务端（静态列表）</div>';
    }
    container.innerHTML = html;
    highlightNav(currentGraph());
  }

  function switchGraph(graphId) {
    if (!graphId || graphId === 'intent') {
      if (window.switchDomain) switchDomain('intent');
      highlightNav('intent');
      return;
    }
    // 资产图谱：先切 org 域再切资产（activate 会重置 select 为旧值，switchAsset 再覆盖，无竞态）
    if (window.switchDomain) switchDomain('org');
    if (window.OrgAdapter) OrgAdapter.switchAsset(graphId);
    highlightNav(graphId);
  }

  // ═══════════════ 阶段功能侧边栏（随 org 四阶段切换；意图域隐藏） ═══════════════
  var STAGE_META = {
    home: { label: '① 数据接入' },
    auto: { label: '② 智能体构建' },
    workbench: { label: '③ 专家精修' },
    publish: { label: '④ 发布' },
  };

  function stageHomeHtml(st) {
    var t = st.template || {};
    var html = '<div class="ia-panel-text">数据接入：粘贴任意内容由智能体识别，或手动指定路径</div>';
    html += '<button class="ia-panel-btn primary" onclick="OrgAdapter.startAuto(\'choose\')">🤖 打开智能体</button>';
    html += '<button class="ia-panel-btn" onclick="OrgAdapter.startAuto(\'signals\')">📋 名册建边</button>';
    html += '<button class="ia-panel-btn" onclick="OrgAdapter.startAuto(\'extract\')">📄 文档抽取</button>';
    html += '<button class="ia-panel-btn" onclick="OrgAdapter.startAuto(\'generate\')">💬 描述生成</button>';
    html += '<div class="ia-panel-text" style="margin-top:6px">模板速查：' +
      (t.node_types ? t.node_types.length : '—') + ' 类节点 / ' + (t.edge_types ? t.edge_types.length : '—') + ' 类边</div>';
    (t.node_types || []).forEach(function (nt) { html += '<span class="ia-panel-chip">' + esc(nt.type) + '</span>'; });
    return html;
  }

  function stageAutoHtml(st) {
    var p = st.autoPayload;
    var html = '<div class="ia-panel-text">智能体抽取任务</div>';
    if (p) {
      html += '<div class="ia-panel-text">' + esc(String(p.summary || '').replace(/<[^>]*>/g, '')) + '</div>';
      html += '<div class="ia-panel-text">待确认 ' + (p.items ? p.items.length : 0) + ' 项</div>';
      html += '<button class="ia-panel-btn" onclick="OrgAdapter.renderPreview()">回到确认队列</button>';
    } else {
      html += '<div class="ia-panel-text">尚无任务。粘贴名册/文档/描述到智能体面板，智能体自动识别并抽取。</div>';
      html += '<button class="ia-panel-btn primary" onclick="OrgAdapter.startAuto(\'choose\')">开始抽取</button>';
    }
    return html;
  }

  function stageWorkbenchHtml(st) {
    var t = st.template || {};
    var d = st.document;
    var html = '<div class="ia-panel-text">' + (d ? d.nodes.length + ' 节点 / ' + d.edges.length + ' 边' : '未加载文档') + '</div>';
    html += '<div class="ia-panel-text">添加节点：</div>';
    (t.node_types || []).forEach(function (nt) {
      html += '<button class="ia-panel-btn" onclick="OrgAdapter.addNodeOf(\'' + esc(nt.type) + '\')">+ ' + esc(nt.label || nt.type) + '</button>';
    });
    return html;
  }

  function stagePublishHtml(st) {
    var s = st.status || {};
    var html = '<div class="ia-panel-text">' + (s.activeVersion ? '当前版本 <b>' + esc(s.activeVersion) + '</b>' : '未发布') +
      (s.versions ? '（共 ' + s.versions.length + ' 版）' : '') + '</div>';
    html += '<button class="ia-panel-btn primary" onclick="document.getElementById(\'btn-validate\').click()">校验</button>';
    html += '<button class="ia-panel-btn" onclick="document.getElementById(\'btn-publish\').click()">发布</button>';
    return html;
  }

  function renderStagePanel(stage) {
    var title = document.getElementById('iaStageTitle');
    var panel = document.getElementById('iaStagePanel');
    if (!title || !panel) return;
    var inOrg = window.DOMAIN && window.DOMAIN.current === 'org';
    if (!inOrg || !STAGE_META[stage]) { title.style.display = 'none'; panel.style.display = 'none'; return; }
    title.style.display = '';
    panel.style.display = '';
    title.textContent = '当前阶段：' + STAGE_META[stage].label;
    var st = (window.OrgAdapter && OrgAdapter.state) || {};
    if (stage === 'home') panel.innerHTML = stageHomeHtml(st);
    else if (stage === 'auto') panel.innerHTML = stageAutoHtml(st);
    else if (stage === 'workbench') panel.innerHTML = stageWorkbenchHtml(st);
    else panel.innerHTML = stagePublishHtml(st);
  }

  // #orgAssetSelect 手动切换 → 导航/徽标同步（与 org 适配器自身监听共存，互不干扰）
  function bindSelectSync() {
    var sel = document.getElementById('orgAssetSelect');
    if (sel) sel.addEventListener('change', function () { highlightNav(sel.value); });
  }

  // /assets 注册制加载（降级：请求失败用内置两资产 + 旧版服务端标记）
  function loadAssets() {
    fetch('/api/org-graph/assets')
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.success && Array.isArray(j.data) && j.data.length) {
          assets = j.data;
        } else {
          legacyServer = true;
        }
      })
      .catch(function () { legacyServer = true; })
      .then(function () { renderNav(); });
  }

  window.IA = {
    switchGraph: switchGraph,
    renderNav: renderNav,
    highlightNav: highlightNav,
    renderStagePanel: renderStagePanel,
    assets: assets,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { bindSelectSync(); loadAssets(); });
  } else {
    bindSelectSync();
    loadAssets();
  }
})();
