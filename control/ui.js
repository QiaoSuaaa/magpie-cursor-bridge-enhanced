(() => {
  'use strict';

  const TOKEN = window.__BRIDGE_TOKEN__ || '';
  const PORT = window.__BRIDGE_PORT__ || location.port;
  const $ = (id) => document.getElementById(id);
  const tokenHeader = 'x-magpiebridge-token';
  const STATES = {
    connected: {label: '已连接', kind: 'connected'},
    disconnected: {label: '未连接', kind: 'idle'},
    paused: {label: '已暂停', kind: 'paused'},
    error: {label: '错误', kind: 'error'},
    stopped: {label: '已停止', kind: 'idle'}
  };
  const MODES = {default: '默认模式', lite: '轻量模式'};

  let busy = null;
  let settingsFilled = false;
  let pollTimer = null;
  let lastOverview = null;
  let dbData = null;
  let dbLoading = false;
  let pendingClean = null;
  let cleaning = false;

  function applyTheme() {
    const params = new URLSearchParams(location.search);
    const theme = params.get('theme');
    document.documentElement.dataset.theme = theme === 'dark' || theme === 'light'
      ? theme
      : (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const raw = params.get('tokens');
    if (!raw) return;
    try {
      const bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
      const tokens = JSON.parse(new TextDecoder().decode(bytes));
      for (const [key, value] of Object.entries(tokens)) {
        if (value) document.documentElement.style.setProperty(`--magpie-${key}`, String(value));
      }
    } catch { /* keep the built-in palette */ }
  }

  async function api(pathname, {method = 'GET', body} = {}) {
    const response = await fetch(pathname, {
      method,
      headers: {'content-type': 'application/json', [tokenHeader]: TOKEN},
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store'
    });
    let data = null;
    try { data = await response.json(); } catch {}
    if (!response.ok || !data || data.ok === false) {
      throw new Error(data?.error || `HTTP ${response.status}`);
    }
    return data;
  }

  function timeText(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  function shorten(value, most = 44) {
    const text = String(value || '');
    return text.length > most ? `…${text.slice(-(most - 1))}` : text;
  }

  function bytes(value) {
    if (!Number.isFinite(value)) return '—';
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
    return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  function setBusy(value) {
    for (const id of ['start', 'status', 'restart']) $(id).disabled = value;
    $('busy').hidden = !value;
    updateDbControls();
  }

  function numberText(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n.toLocaleString('zh-CN') : '—';
  }

  function dbTable(headers, rows) {
    const table = document.createElement('table');
    table.className = 'db-table';
    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const text of headers) {
      const th = document.createElement('th');
      th.textContent = text;
      headRow.append(th);
    }
    head.append(headRow);
    const body = document.createElement('tbody');
    for (const cells of rows) {
      const row = document.createElement('tr');
      for (const cell of cells) {
        const td = document.createElement('td');
        if (cell && typeof cell === 'object') {
          td.textContent = String(cell.text ?? '');
          if (cell.mono) td.className = 'mono';
          if (cell.title) td.title = cell.title;
        } else {
          td.textContent = String(cell ?? '');
        }
        row.append(td);
      }
      body.append(row);
    }
    table.append(head, body);
    return table;
  }

  function updateDbControls() {
    const unavailable = cleaning || dbLoading || !!busy || !dbData?.exists;
    for (const button of document.querySelectorAll('[data-clean]')) button.disabled = unavailable;
    if ($('dbRefresh')) $('dbRefresh').disabled = cleaning || dbLoading;
    if ($('cleanDays')) $('cleanDays').disabled = cleaning;
    if ($('dbVacuum')) $('dbVacuum').disabled = cleaning;
    if ($('dbConfirmType')) $('dbConfirmType').disabled = cleaning;
    if ($('dbConfirmGo')) {
      $('dbConfirmGo').disabled = cleaning || !pendingClean
        || (pendingClean.scope === 'all' && $('dbConfirmType').value.trim() !== '清空全部');
    }
    if ($('dbConfirmCancel')) $('dbConfirmCancel').disabled = cleaning;
  }

  function notice(message, kind = 'ok') {
    const box = $('notice');
    if (!message) { box.hidden = true; box.textContent = ''; return; }
    box.hidden = false;
    box.dataset.kind = kind;
    box.textContent = message;
  }

  function item(label, value, {mono = false, tone = '', title = ''} = {}) {
    const wrap = document.createElement('div');
    wrap.className = 'item';
    const key = document.createElement('span');
    key.className = 'k';
    key.textContent = label;
    const val = document.createElement('span');
    val.className = `v${mono ? ' mono' : ''}${tone ? ` ${tone}` : ''}`;
    val.textContent = value;
    if (title) val.title = title;
    wrap.append(key, val);
    return wrap;
  }

  function render(overview, {quiet = false} = {}) {
    lastOverview = overview;
    const runtime = overview.runtime;
    const state = STATES[runtime?.state] || {label: runtime?.state || '未运行', kind: 'idle'};
    $('dot').dataset.state = state.kind === 'idle' ? 'unknown' : state.kind;
    $('port').textContent = PORT;
    const model = runtime?.model || overview.connection?.model || '';
    const models = runtime?.models ?? overview.connection?.models ?? 0;
    $('stateText').textContent = runtime
      ? `${state.label}${model ? ` · ${model}` : ''}${models ? ` · ${models} 个模型` : ''}`
      : (overview.connection?.exists ? '后台未运行' : '尚未连接');

    const warning = runtime?.warning || runtime?.reason || '';
    if (warning) notice(warning, runtime?.state === 'error' ? 'error' : 'warning');
    else if (!quiet || $('notice').dataset.kind === 'warning') notice('');

    const configuredMode = runtime?.mode || overview.settings?.values?.runMode || 'default';
    const engineMode = runtime?.engineMode || null;
    const switching = engineMode && engineMode !== configuredMode;
    const engineModeText = MODES[engineMode || configuredMode] || configuredMode;
    const databaseText = engineMode === 'lite'
      ? '内存 · 不落盘'
      : (overview.database ? `${bytes(overview.database.size)} · bridge.db` : '未创建');

    const grid = $('overview');
    grid.replaceChildren(
      item('版本', overview.version || overview.installation?.version || '—', {mono: true}),
      item('运行模式', `${engineModeText}${switching ? ' · 切换中' : ''}`, {tone: switching ? 'warn' : ''}),
      item('数据库', databaseText, {tone: engineMode === 'lite' ? 'ok' : ''}),
      item('后台监视器', overview.supervisor.alive
        ? `运行中 · PID ${overview.supervisor.pid}`
        : '未运行', {tone: overview.supervisor.alive ? 'ok' : 'warn'}),
      item('LaunchAgent', overview.launchAgent.registered
        ? (overview.launchAgent.state || '已加载')
        : '未加载', {tone: overview.launchAgent.registered ? 'ok' : 'warn'}),
      item('原生引擎', overview.engine.alive
        ? `运行中 · PID ${overview.engine.pid}`
        : '未运行', {tone: overview.engine.alive ? 'ok' : 'warn'}),
      item('代理端口', runtime?.proxy || '—', {mono: true}),
      item('后端端口', runtime?.backend || '—', {mono: true}),
      item('当前模型', model || '—'),
      item('模型数', models ? String(models) : '—'),
      item('状态更新', timeText(runtime?.updated)),
      item('安装时间', timeText(overview.installation?.installed)),
      item('release', overview.installation?.release ? shorten(overview.installation.release) : '—', {mono: true, title: overview.installation?.release || ''}),
      item('控制服务', `PID ${overview.control.pid} · ${overview.control.uptime}s`, {mono: true})
    );

    if (!settingsFilled && overview.settings?.values) {
      fillSettings(overview.settings.values);
      settingsFilled = true;
    }
  }

  function fillSettings(values) {
    if (values?.runMode !== undefined) $('runMode').value = values.runMode;
    if (values?.subagentMode !== undefined) $('subagentMode').value = values.subagentMode;
    for (const key of ['refreshSeconds', 'gatewayGraceSeconds', 'logLimitMB']) {
      if (values?.[key] !== undefined) $(key).value = values[key];
    }
  }

  async function loadStatus({quiet = false} = {}) {
    try {
      const data = await api('/api/status');
      render(data.overview, {quiet});
    } catch (error) {
      if (!quiet) notice(`读取状态失败：${error.message}`, 'error');
      $('dot').dataset.state = 'error';
      $('stateText').textContent = '控制服务不可达';
    }
  }

  function output(text, kind = '') {
    const box = $('output');
    box.hidden = false;
    box.dataset.kind = kind;
    box.textContent = text;
  }

  async function runAction(action) {
    if (busy) return;
    busy = action;
    setBusy(true);
    const label = {start: '启动', status: '状态', restart: '重启'}[action];
    const command = action === 'status'
      ? 'bash setup.command status'
      : (action === 'restart' ? 'launchctl bootout + 杀掉后台进程 + bash setup.command' : 'bash setup.command');
    output(`$ ${command}\n执行中…`);
    notice('');
    try {
      const result = await api('/api/action', {method: 'POST', body: {action}});
      const text = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
      output(`${result.ok ? '[成功]' : '[失败]'} ${result.error || ''}\n${text || '（无输出）'}`.trim(), result.ok ? '' : 'error');
      if (result.overview) render(result.overview);
      if (result.ok) notice(`${label}完成`, 'ok');
    } catch (error) {
      output(`[失败] ${error.message}`, 'error');
      notice(`${label}失败：${error.message}`, 'error');
    } finally {
      busy = null;
      setBusy(false);
      loadStatus({quiet: true});
    }
  }

  async function saveSettings(event) {
    event.preventDefault();
    const beforeMode = lastOverview?.settings?.values?.runMode;
    const beforeSubagentMode = lastOverview?.settings?.values?.subagentMode;
    const body = {
      runMode: $('runMode').value,
      subagentMode: $('subagentMode').value,
      refreshSeconds: Number($('refreshSeconds').value),
      gatewayGraceSeconds: Number($('gatewayGraceSeconds').value),
      logLimitMB: Number($('logLimitMB').value)
    };
    try {
      const result = await api('/api/settings', {method: 'POST', body});
      fillSettings(result.settings);
      settingsFilled = true;
      const modeHint = beforeMode && beforeMode !== result.settings.runMode
        ? '运行模式已变更，引擎将在数秒内自动重启，当前对话可能中断一次；'
        : '';
      const subagentHint = beforeSubagentMode && beforeSubagentMode !== result.settings.subagentMode
        ? '子代理模式已变更，引擎将在数秒内自动重启，下一次 Task 调用生效；'
        : '';
      $('settingsHint').textContent = `已保存：${modeHint}${subagentHint}同步间隔与容错下一轮生效，日志上限下次后台启动生效`;
      loadStatus({quiet: true});
    } catch (error) {
      $('settingsHint').textContent = `保存失败：${error.message}`;
    }
  }

  function renderDatabase(data) {
    dbData = data;
    $('dbState').textContent = data.exists ? bytes(data.file.db) : '未创建';
    if (!data.exists) {
      $('dbHint').textContent = '数据库尚未创建；轻量模式下引擎不写 bridge.db，因此没有可清理的内容。';
      $('dbSummary').hidden = true;
      $('dbCategories').replaceChildren();
      $('dbConversations').hidden = true;
      $('dbDaysBox').hidden = true;
      $('cleanCallsHint').textContent = '暂无数据库文件';
      updateDbControls();
      return;
    }
    const overhead = Math.max(0, data.file.db - data.totals.bytes);
    $('dbHint').textContent = `统计完成 · 表内数据按内容字节计算，索引与空闲页计入「索引与空闲」`;
    $('dbSummary').replaceChildren(
      item('数据库文件', bytes(data.file.db), {mono: true, title: data.path}),
      item('WAL / SHM', `${bytes(data.file.wal)} / ${bytes(data.file.shm)}`, {mono: true}),
      item('表内数据', bytes(data.totals.bytes), {mono: true}),
      item('索引与空闲', `约 ${bytes(overhead)}`, {mono: true}),
      item('总行数', numberText(data.totals.rows), {mono: true}),
      item('空闲页', numberText(data.page?.freelistCount), {mono: true}),
      item('页大小', data.page?.pageSize ? `${numberText(data.page.pageSize)} B` : '—', {mono: true}),
      item('最近写入', timeText(data.file.updated))
    );
    $('dbSummary').hidden = false;

    const categories = document.createElement('div');
    categories.className = 'db-categories';
    for (const category of data.categories || []) {
      if (!category.tables.length) continue;
      const box = document.createElement('div');
      box.className = 'db-cat';
      const head = document.createElement('div');
      head.className = 'db-cat-head';
      const title = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = category.label;
      const hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = category.hint;
      title.append(name, hint);
      const total = document.createElement('span');
      total.className = 'db-cat-total';
      total.textContent = `${category.measured ? bytes(category.bytes) : '—'} · ${numberText(category.rows)} 行`;
      head.append(title, total);
      box.append(head, dbTable(['表', '行数', '数据体积'], category.tables.map((table) => [
        {text: table.label, title: table.name},
        numberText(table.rows),
        table.measured ? bytes(table.bytes) : '—'
      ])));
      categories.append(box);
    }
    $('dbCategories').replaceChildren(categories);

    const conversations = data.conversations || [];
    $('dbConversations').hidden = !conversations.length;
    if (conversations.length) {
      $('dbConvHint').textContent = `最近 ${conversations.length} 个会话，按更新时间排序`;
      $('dbConvBody').replaceChildren(dbTable(['会话', '更新时间', '消息', '数据体积'], conversations.map((conversation) => [
        {text: conversation.id.slice(0, 8), title: conversation.id, mono: true},
        timeText(conversation.updated),
        numberText(conversation.messages),
        bytes(conversation.bytes)
      ])));
    }

    const days = data.days || [];
    $('dbDaysBox').hidden = !days.length;
    if (days.length) {
      $('dbDaysBody').replaceChildren(dbTable(['日期', '消息数', '数据体积'], days.map((day) => [
        {text: day.day, mono: true},
        numberText(day.count),
        bytes(day.bytes)
      ])));
    }

    const rows = new Map();
    for (const category of data.categories || []) {
      for (const table of category.tables) rows.set(table.name, table);
    }
    const calls = rows.get('llm_calls')?.rows || 0;
    const traces = rows.get('cursor_run_traces')?.rows || 0;
    $('cleanCallsHint').textContent = `模型调用 ${numberText(calls)} 条 · 请求追踪 ${numberText(traces)} 条`;
    updateDbControls();
  }

  async function loadDatabase({force = false, quiet = false} = {}) {
    if (dbLoading) return;
    dbLoading = true;
    $('dbState').textContent = '统计中…';
    if (!quiet) $('dbHint').textContent = '正在统计数据库内容（数据库越大耗时越久）…';
    updateDbControls();
    try {
      const data = await api(`/api/database${force ? '?refresh=1' : ''}`);
      renderDatabase(data.database);
    } catch (error) {
      $('dbState').textContent = '统计失败';
      $('dbHint').textContent = `统计失败：${error.message}`;
      if (!quiet) notice(`数据库统计失败：${error.message}`, 'error');
    } finally {
      dbLoading = false;
      updateDbControls();
    }
  }

  function cleanupPlan(scope) {
    const days = Number($('cleanDays').value) || 3;
    const vacuum = scope === 'vacuum' || $('dbVacuum').checked;
    const rows = new Map();
    for (const category of dbData?.categories || []) {
      for (const table of category.tables) rows.set(table.name, table);
    }
    const calls = rows.get('llm_calls')?.rows || 0;
    const traces = rows.get('cursor_run_traces')?.rows || 0;
    const conversations = rows.get('conversations')?.rows || 0;
    let text = '';
    if (scope === 'traces') {
      text = `将删除 ${numberText(calls)} 条模型调用日志与 ${numberText(traces)} 条请求追踪记录。`;
    } else if (scope === 'sessions') {
      text = `将删除 ${days} 天前未更新的会话及其消息、检查点、运行和工具调用记录；blob 内容会保留。`;
    } else if (scope === 'vacuum') {
      text = '不删除数据，仅执行 VACUUM 压缩数据库并回收空闲页。';
    } else {
      text = `将删除 ${numberText(conversations)} 个会话及其全部消息、检查点、运行记录、调用日志与 blob 内容。模型配置与服务设置保留，此操作不可撤销。`;
    }
    const running = lastOverview?.engine?.alive || lastOverview?.supervisor?.alive;
    if (running) text += ' 清理前会短暂暂停桥接，完成后自动重启，当前对话可能中断一次。';
    if (vacuum) {
      text += ' 将执行 VACUUM 回收磁盘空间。';
    } else {
      text += ' 未勾选压缩：删除后的空间会被后续写入复用，文件不会立即缩小。';
    }
    return {scope, days, vacuum, text};
  }

  function refreshCleanupPlan() {
    if (!pendingClean || cleaning) return;
    const scope = pendingClean.scope;
    const typed = $('dbConfirmType').value;
    pendingClean = cleanupPlan(scope);
    $('dbConfirmText').textContent = pendingClean.text;
    $('dbConfirmType').value = typed;
    updateDbControls();
  }

  function showCleanupConfirm(scope) {
    if (!dbData?.exists || cleaning) return;
    pendingClean = cleanupPlan(scope);
    $('dbConfirmText').textContent = pendingClean.text;
    $('dbConfirmTypeWrap').hidden = scope !== 'all';
    $('dbConfirmType').value = '';
    $('dbConfirmHint').textContent = '';
    $('dbConfirm').hidden = false;
    updateDbControls();
  }

  async function executeCleanup() {
    const plan = pendingClean;
    if (!plan || cleaning) return;
    if (plan.scope === 'all' && $('dbConfirmType').value.trim() !== '清空全部') return;
    cleaning = true;
    busy = '数据库清理';
    setBusy(true);
    $('dbConfirmHint').textContent = plan.vacuum ? '正在清理并压缩，桥接会短暂重启…' : '正在清理…';
    notice('');
    try {
      const result = await api('/api/database/cleanup', {
        method: 'POST',
        body: {scope: plan.scope, olderThanDays: plan.days, vacuum: plan.vacuum}
      });
      const cleanup = result.cleanup;
      const released = cleanup.reclaimed > 0 ? `，释放 ${bytes(cleanup.reclaimed)}` : '';
      if (result.restart && !result.restart.ok) {
        notice(`数据库已清理（${bytes(cleanup.before.total)} → ${bytes(cleanup.after.total)}${released}），但桥接重启失败：${result.restart.error || '未知错误'}`, 'error');
      } else {
        const restarted = result.restart?.ok ? '，桥接已重启' : '';
        notice(`清理完成：${bytes(cleanup.before.total)} → ${bytes(cleanup.after.total)}${released}${restarted}。`, 'ok');
      }
      pendingClean = null;
      $('dbConfirm').hidden = true;
      loadStatus({quiet: true});
      loadDatabase({force: true, quiet: true});
    } catch (error) {
      $('dbConfirmHint').textContent = `清理失败：${error.message}`;
      notice(`清理失败：${error.message}`, 'error');
    } finally {
      cleaning = false;
      busy = null;
      setBusy(false);
    }
  }

  function wire() {
    for (const [id, action] of [['start', 'start'], ['status', 'status'], ['restart', 'restart']]) {
      $(id).addEventListener('click', () => runAction(action));
    }
    $('refresh').addEventListener('click', () => loadStatus());
    $('dbCard').addEventListener('toggle', () => {
      if ($('dbCard').open && !dbData && !cleaning) loadDatabase();
      tellSize();
    });
    $('dbRefresh').addEventListener('click', () => loadDatabase({force: true}));
    for (const button of document.querySelectorAll('[data-clean]')) {
      button.addEventListener('click', () => showCleanupConfirm(button.dataset.clean));
    }
    $('cleanDays').addEventListener('change', refreshCleanupPlan);
    $('dbVacuum').addEventListener('change', refreshCleanupPlan);
    $('dbConfirmType').addEventListener('input', updateDbControls);
    $('dbConfirmGo').addEventListener('click', executeCleanup);
    $('dbConfirmCancel').addEventListener('click', () => {
      pendingClean = null;
      $('dbConfirm').hidden = true;
      $('dbConfirmHint').textContent = '';
      updateDbControls();
    });
    $('settingsForm').addEventListener('submit', saveSettings);
    $('resetSettings').addEventListener('click', () => {
      const defaults = lastOverview?.settings?.defaults || {runMode: 'default', subagentMode: 'async', refreshSeconds: 15, gatewayGraceSeconds: 60, logLimitMB: 4};
      fillSettings(defaults);
      $('settingsHint').textContent = '已填入默认值，点击「保存」后生效';
    });
    for (const button of document.querySelectorAll('[data-target]')) {
      button.addEventListener('click', async () => {
        try {
          await api('/api/open', {method: 'POST', body: {target: button.dataset.target}});
        } catch (error) {
          notice(`打开失败：${error.message}`, 'error');
        }
      });
    }
    $('back').addEventListener('click', () => {
      if (history.length > 1) history.back();
      else notice('请回到 Magpie 的 Agents 面板修改控制端口', 'warning');
    });
  }

  function tellSize() {
    try {
      parent.postMessage({
        magpie: 1,
        method: 'size',
        params: {height: Math.ceil(document.documentElement.getBoundingClientRect().height)}
      }, '*');
    } catch { /* not inside the panel */ }
  }

  function startPolling() {
    clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (document.visibilityState === 'visible' && !busy) loadStatus({quiet: true});
    }, 5000);
  }

  applyTheme();
  wire();
  loadStatus();
  startPolling();
  if ('ResizeObserver' in window) new ResizeObserver(tellSize).observe(document.documentElement);
  addEventListener('load', tellSize);
  setTimeout(tellSize, 0);
  setTimeout(tellSize, 300);
})();
