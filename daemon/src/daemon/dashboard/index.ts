/**
 * 只读 dashboard(M4 观测线):零构建静态单页,vanilla JS,零依赖,不引
 * 图表库。由 http.ts 的 GET 白名单(`/`)以字符串常量直接服务 —— 嵌进 TS
 * 导出常量跟随仓库零依赖风格,测试可控(内容断言直接 import)。
 *
 * 只读边界:页面只消费 task.list / approvals.list / budget.status /
 * capabilities.list(观测面)与 GET /events/stream(SSE 事件流),不做任何
 * 写操作按钮。token 经输入框存 localStorage(页面自管),EventSource 用
 * `?token=` 兜底鉴权(仅 localhost 监听前提下可用,见 http.ts 注释)。
 */

export const DASHBOARD_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>neoba dashboard</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0 16px 32px;
    font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
    background: #f6f6f4; color: #1d1d1b;
  }
  header { display: flex; align-items: baseline; gap: 12px; padding: 14px 0 8px; flex-wrap: wrap; }
  h1 { font-size: 18px; margin: 0; }
  h2 { font-size: 14px; margin: 0 0 8px; color: #555; text-transform: uppercase; letter-spacing: .04em; }
  #conn { font-size: 12px; padding: 2px 8px; border-radius: 10px; background: #ddd; }
  #conn.live { background: #bfe3bf; } #conn.err { background: #f3c1c1; }
  #auth { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding-bottom: 12px; border-bottom: 1px solid #ddd; }
  #token { flex: 1 1 260px; max-width: 460px; padding: 5px 8px; border: 1px solid #bbb; border-radius: 4px; font: inherit; }
  button { padding: 5px 12px; border: 1px solid #999; border-radius: 4px; background: #fff; cursor: pointer; font: inherit; }
  button:hover { background: #eee; }
  #err { color: #a11; font-size: 12px; }
  main { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 14px; }
  section { background: #fff; border: 1px solid #ddd; border-radius: 6px; padding: 12px; min-width: 0; }
  #events-pane { grid-column: 1 / -1; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th, td { text-align: left; padding: 3px 6px; border-bottom: 1px solid #eee; word-break: break-all; }
  th { color: #666; font-weight: 600; }
  code, pre { font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
  .badge { display: inline-block; padding: 0 6px; border-radius: 8px; font-size: 11px; background: #e8e8e8; }
  .badge.completed, .badge.granted { background: #cdeccd; }
  .badge.failed, .badge.denied { background: #f3c1c1; }
  .badge.running, .badge.waiting_approval { background: #f5e2b8; }
  .badge.paused, .badge.cancelled, .badge.created { background: #d8ddec; }
  .meter { height: 8px; background: #eee; border-radius: 4px; overflow: hidden; }
  .meter > div { height: 100%; background: #7aa8e0; }
  .meter.hot > div { background: #d98f4b; }
  .meter.over > div { background: #c65353; }
  .empty { color: #888; font-size: 12px; }
  #eventLog { max-height: 320px; overflow-y: auto; background: #14161a; color: #cfd6dd;
    padding: 8px 10px; border-radius: 4px; font: 12px ui-monospace, Consolas, monospace; }
  #eventLog div { padding: 1px 0; word-break: break-all; }
  #eventLog .t { color: #7fb0e8; }
  #eventLog .ts { color: #6b7683; }
  @media (prefers-color-scheme: dark) {
    body { background: #17181a; color: #d8d8d4; }
    section { background: #1f2124; border-color: #333; }
    #token { background: #17181a; color: inherit; border-color: #555; }
    button { background: #2a2d31; color: inherit; border-color: #555; }
    button:hover { background: #35393e; }
    #conn { background: #333; }
    th { color: #999; } th, td { border-color: #2b2e32; }
    .badge { background: #3a3d42; } .badge.completed, .badge.granted { background: #2c4a2c; }
    .badge.failed, .badge.denied { background: #55302f; } .badge.running, .badge.waiting_approval { background: #52422a; }
    .meter { background: #333; }
  }
</style>
</head>
<body>
<header>
  <h1>neoba dashboard</h1>
  <span id="conn">未连接</span>
  <span id="err"></span>
</header>
<div id="auth">
  <input id="token" type="password" placeholder="daemon token(bootstrap 或 session.init 签发的会话 token)" autocomplete="off">
  <button id="save">保存并连接</button>
  <button id="refresh">刷新</button>
  <span class="empty">token 只存本浏览器 localStorage;SSE 经 /events/stream?token= 鉴权</span>
</div>
<main>
  <section id="tasks-pane">
    <h2>任务</h2>
    <table><thead><tr><th>task</th><th>状态</th><th>preset</th><th>principal</th><th>intent</th></tr></thead>
    <tbody id="taskRows"></tbody></table>
  </section>
  <section id="presets-pane">
    <h2>preset 概览(按任务聚合)</h2>
    <div id="presetList" class="empty">—</div>
  </section>
  <section id="approvals-pane">
    <h2>审批队列(pending)</h2>
    <div id="approvalList" class="empty">—</div>
  </section>
  <section id="budgets-pane">
    <h2>预算水位</h2>
    <div id="budgetList" class="empty">—</div>
  </section>
  <section id="events-pane">
    <h2>事件流(SSE /events/stream;先重放后实时)</h2>
    <div id="eventLog"></div>
  </section>
</main>
<script>
(function () {
  'use strict';
  var TOKEN_KEY = 'neoba.dashboard.token';
  var MAX_LOG_LINES = 200;
  var es = null;

  function $(id) { return document.getElementById(id); }
  function esc(text) {
    return String(text).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function token() { return localStorage.getItem(TOKEN_KEY) || ''; }
  function setConn(state, text) {
    var el = $('conn');
    el.className = state;
    el.textContent = text;
  }
  function fail(message) { $('err').textContent = message; }

  function rpc(method, params) {
    return fetch('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + token() },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: method, params: params || {} })
    }).then(function (res) { return res.json(); }).then(function (body) {
      if (body.error) throw new Error(method + ': ' + body.error.code + ' ' + (body.error.message || ''));
      return body.result;
    });
  }

  // ---- SSE:先重放后实时;断线 3s 重连 -------------------------------
  function connectStream() {
    if (es !== null) { es.close(); es = null; }
    es = new EventSource('/events/stream?token=' + encodeURIComponent(token()));
    es.onopen = function () { setConn('live', 'SSE 已连接'); fail(''); };
    es.onerror = function () {
      setConn('err', 'SSE 断开,3s 后重连');
      if (es !== null) { es.close(); es = null; }
      setTimeout(function () { if (token()) connectStream(); }, 3000);
    };
    es.onmessage = function (ev) { appendEvent(ev.data); };
    // 服务端按 event: <type> 帧;统一走 addEventListener 捕获全部类型。
    ['sandbox.created', 'sandbox.started', 'sandbox.execed', 'sandbox.destroyed',
     'sandbox.queued', 'sandbox.acquired', 'sandbox.released',
     'grant.granted', 'grant.revoked', 'artifact.published', 'artifact.gc',
     'node.started', 'node.completed', 'node.failed',
     'tool_inventory', 'usage',
     'budget.warning', 'budget.exceeded', 'approval.requested', 'approval.decided',
     'correction', 'daemon.started', 'daemon.recovered'
    ].forEach(function (type) {
      es.addEventListener(type, function (ev) { appendEvent(ev.data); });
    });
  }

  function appendEvent(data) {
    if (!data) return;
    var log = $('eventLog');
    var line = document.createElement('div');
    try {
      var e = JSON.parse(data);
      var p = e.principal || {};
      var ns = [p.tenant, p.session, p.task, p.agent].filter(function (x) { return x; }).join('/');
      line.innerHTML = '<span class="ts">' + esc((e.ts || '').replace('T', ' ').slice(0, 19)) + '</span> ' +
        '<span class="t">' + esc(e.type) + '</span> #' + esc(e.seq) + ' ' + esc(ns) +
        ' <code>' + esc(JSON.stringify(e.payload)).slice(0, 160) + '</code>';
    } catch (err) {
      line.textContent = String(data).slice(0, 200);
    }
    log.insertBefore(line, log.firstChild);
    while (log.childElementCount > MAX_LOG_LINES) log.removeChild(log.lastChild);
  }

  // ---- 观测面刷新(全部只读 RPC) ------------------------------------
  function statusBadge(status) { return '<span class="badge ' + esc(status) + '">' + esc(status) + '</span>'; }

  function refresh() {
    if (!token()) { fail('先填 token'); return; }
    rpc('task.list').then(function (result) {
      var tasks = result.tasks || [];
      $('taskRows').innerHTML = tasks.map(function (t) {
        return '<tr><td><code>' + esc(t.taskId) + '</code></td>' +
          '<td>' + statusBadge(t.status) + '</td>' +
          '<td>' + esc(t.preset) + '</td>' +
          '<td>' + esc((t.tenant || '') + '/' + (t.session || '-')) + '</td>' +
          '<td>' + esc(String(t.intent || '').slice(0, 60)) + '</td></tr>';
      }).join('') || '<tr><td colspan="5" class="empty">无任务</td></tr>';
      // preset 概览:按任务聚合计数(只读观测,不引新 RPC)
      var byPreset = {};
      tasks.forEach(function (t) { byPreset[t.preset] = (byPreset[t.preset] || 0) + 1; });
      var names = Object.keys(byPreset).sort();
      $('presetList').className = '';
      $('presetList').innerHTML = names.length === 0 ? '<span class="empty">无任务</span>' : names.map(function (name) {
        return '<div><span class="badge">' + esc(name) + '</span> ' + byPreset[name] + ' 个任务</div>';
      }).join('');
      // 预算:running/paused 任务逐个 budget.status
      var interesting = tasks.filter(function (t) { return t.status === 'running' || t.status === 'paused'; });
      return Promise.all(interesting.map(function (t) {
        return rpc('budget.status', { task_id: t.taskId }).then(function (r) {
          return { taskId: t.taskId, budget: r.budget };
        }).catch(function () { return { taskId: t.taskId, budget: null }; });
      }));
    }).then(function (rows) {
      if (!rows) return;
      var shown = rows.filter(function (r) { return r.budget; });
      $('budgetList').className = '';
      $('budgetList').innerHTML = shown.length === 0 ? '<span class="empty">无在途预算</span>' : shown.map(function (r) {
        var b = r.budget;
        var pct = b.limit_tokens > 0 ? Math.min(100, Math.round(100 * b.observed_tokens / b.limit_tokens)) : 0;
        var cls = b.level === 'hard' ? 'over' : (b.level === 'soft' ? 'hot' : '');
        return '<div style="margin-bottom:8px"><code>' + esc(r.taskId) + '</code> ' +
          '<span class="badge">' + esc(b.level) + '</span> ' +
          esc(b.observed_tokens) + ' / ' + esc(b.limit_tokens) + ' tok' +
          '<div class="meter ' + cls + '"><div style="width:' + pct + '%"></div></div></div>';
      }).join('');
      fail('');
    }).catch(function (err) { fail(String(err.message || err).slice(0, 200)); });

    rpc('approvals.list', { status: 'pending' }).then(function (result) {
      var approvals = result.approvals || [];
      $('approvalList').className = '';
      $('approvalList').innerHTML = approvals.length === 0 ? '<span class="empty">队列为空</span>' : approvals.map(function (r) {
        return '<div style="margin-bottom:6px"><code>' + esc(r.reqId) + '</code> → <code>' + esc(r.agentId) + '</code> ' +
          statusBadge(r.status || 'pending') + '</div>';
      }).join('');
    }).catch(function () { /* 未接审批台账等:静默,主刷新已有错误位 */ });
  }

  $('save').addEventListener('click', function () {
    localStorage.setItem(TOKEN_KEY, $('token').value.trim());
    fail('');
    refresh();
    connectStream();
  });
  $('refresh').addEventListener('click', refresh);

  var saved = token();
  if (saved) { $('token').value = saved; refresh(); connectStream(); }
  else { setConn('', '未配置 token'); }
})();
</script>
</body>
</html>
`;
