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

  let busy = null;
  let settingsFilled = false;
  let pollTimer = null;
  let lastOverview = null;

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

  function setBusy(value) {
    for (const id of ['start', 'status', 'restart']) $(id).disabled = value;
    $('busy').hidden = !value;
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

    const grid = $('overview');
    grid.replaceChildren(
      item('版本', overview.version || overview.installation?.version || '—', {mono: true}),
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
    const body = {
      refreshSeconds: Number($('refreshSeconds').value),
      gatewayGraceSeconds: Number($('gatewayGraceSeconds').value),
      logLimitMB: Number($('logLimitMB').value)
    };
    try {
      const result = await api('/api/settings', {method: 'POST', body});
      fillSettings(result.settings);
      settingsFilled = true;
      $('settingsHint').textContent = '已保存：同步间隔与容错下一轮生效，日志上限下次后台启动生效';
      loadStatus({quiet: true});
    } catch (error) {
      $('settingsHint').textContent = `保存失败：${error.message}`;
    }
  }

  function wire() {
    for (const [id, action] of [['start', 'start'], ['status', 'status'], ['restart', 'restart']]) {
      $(id).addEventListener('click', () => runAction(action));
    }
    $('refresh').addEventListener('click', () => loadStatus());
    $('settingsForm').addEventListener('submit', saveSettings);
    $('resetSettings').addEventListener('click', () => {
      const defaults = lastOverview?.settings?.defaults || {refreshSeconds: 15, gatewayGraceSeconds: 60, logLimitMB: 4};
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
