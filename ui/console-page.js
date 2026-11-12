(() => {
  'use strict';

  // Magpie's page sandbox has no network of its own: this page only prepares
  // the URL of the plugin's loopback console and navigates to it. Opening it
  // from the agent row's menu or from the sidebar both land here; a menu
  // action for another agent stays on this card and says so.
  const magpie = window.magpie;
  const $ = (id) => document.getElementById(id);
  const DEFAULT_PORT = 3580;
  let theme = {dark: false, lang: 'zh', tokens: {}};
  let options = {};
  let port = DEFAULT_PORT;
  let timer = null;

  const clampPort = (value) => {
    const n = Number(value);
    return Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : null;
  };

  function encodeTokens(tokens) {
    const slim = {};
    for (const [key, value] of Object.entries(tokens || {})) {
      const text = String(value ?? '').trim();
      if (text) slim[key] = text;
    }
    if (!Object.keys(slim).length) return '';
    try { return btoa(unescape(encodeURIComponent(JSON.stringify(slim)))); }
    catch { return ''; }
  }

  function consoleUrl() {
    const params = new URLSearchParams();
    params.set('theme', theme.dark ? 'dark' : 'light');
    const tokens = encodeTokens(theme.tokens);
    if (tokens) params.set('tokens', tokens);
    return `http://127.0.0.1:${port}/?${params}`;
  }

  function armTimeout(candidate) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      $('hint').textContent = `控制服务没有响应（127.0.0.1:${candidate}）。请确认 Magpie 插件已重新加载；若端口被占用，修改端口后重试。`;
      $('tip').textContent = '可修改端口后点击「打开控制台」。';
    }, 6000);
  }

  function openConsole() {
    $('hint').textContent = '正在打开控制台…';
    armTimeout(port);
    location.assign(consoleUrl());
  }

  async function savePort() {
    const next = clampPort($('port').value);
    if (!next) {
      $('hint').textContent = '端口需为 1024–65535 的整数。';
      return;
    }
    if (next === port) {
      openConsole();
      return;
    }
    $('save').disabled = true;
    try {
      options = {...options, controlPort: next};
      if (magpie?.options?.set) await magpie.options.set(options);
      port = next;
      $('hint').textContent = `端口已保存为 ${next}，控制服务约 2 秒后切换。`;
      setTimeout(openConsole, 2300);
    } catch (error) {
      $('hint').textContent = `保存端口失败：${error?.message || error}`;
    } finally {
      $('save').disabled = false;
    }
  }

  (async () => {
    try {
      const ready = await magpie?.ready;
      if (ready) theme = ready;
    } catch { /* keep the light default */ }
    try {
      options = (await magpie?.options?.get?.()) || {};
    } catch { /* options are optional */ }
    // An older build wrote a one-time action here; it has no reader now.
    if (options.pendingAction) {
      const {pendingAction, ...rest} = options;
      options = rest;
      try { await magpie?.options?.set?.(options); } catch {}
    }
    port = clampPort(options.controlPort) || DEFAULT_PORT;
    $('port').value = port;

    // The console's "端口设置" comes back here. The entry it returns to
    // carries this marker, so the page shows the card instead of bouncing
    // straight back into the console.
    let returning = false;
    try {
      returning = history.state?.bridgeConsole === true;
      history.replaceState({...(history.state || {}), bridgeConsole: true}, '', location.href);
    } catch { /* history is optional */ }

    let acted = false;
    if (magpie?.onAction) {
      magpie.onAction(({id, agent}) => {
        acted = true;
        if (id !== 'console') return;
        const label = `${agent?.id || ''} ${agent?.name || ''}`.trim();
        const ours = !label || /cursor-bridge/i.test(label) || /Cursor\s*·\s*Magpie Bridge/i.test(label);
        if (!ours) {
          $('hint').textContent = `这是「${agent?.name || agent?.id}」的菜单；此入口只服务于 Cursor · Magpie Bridge。`;
          $('tip').textContent = '请从 Cursor · Magpie Bridge 那一行的菜单打开。';
          return;
        }
        openConsole();
      });
    }

    $('open').addEventListener('click', openConsole);
    $('save').addEventListener('click', savePort);
    $('port').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') savePort();
    });

    // Sidebar tab: no menu action ever arrives, so open on our own.
    setTimeout(() => {
      if (!acted && !returning) openConsole();
    }, 700);
  })();
})();
