import fs from 'node:fs';

// Log tailing and redaction live here so the control API and the diagnostics
// bundle share one implementation. Logs are local, but they can contain
// gateway keys and Authorization headers copied from failed requests, so every
// byte that leaves the panel passes through redact().
const MAX_LINES = 2000;
const DEFAULT_BYTES = 512 * 1024;
const MAX_BYTES = 2 * 1024 * 1024;

export function tailFile(file, {lines = 200, maxBytes = DEFAULT_BYTES} = {}) {
  const cap = Math.min(MAX_LINES, Math.max(1, Number(lines) || 200));
  const limit = Math.min(MAX_BYTES, Math.max(4096, Number(maxBytes) || DEFAULT_BYTES));
  let info;
  try {
    info = fs.statSync(file);
  } catch {
    return {exists: false, text: '', lines: 0, size: 0, updated: null, truncated: false};
  }
  if (!info.isFile()) {
    return {exists: false, text: '', lines: 0, size: 0, updated: null, truncated: false};
  }
  const start = Math.max(0, info.size - limit);
  const length = info.size - start;
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(file, 'r');
  try {
    if (length) fs.readSync(fd, buffer, 0, length, start);
  } finally {
    fs.closeSync(fd);
  }
  let text = buffer.toString('utf8');
  // A tail that starts mid-line would show a partial record; drop it.
  if (start > 0) {
    const newline = text.indexOf('\n');
    text = newline >= 0 ? text.slice(newline + 1) : '';
  }
  const all = text.split(/\r?\n/);
  if (all.length && all[all.length - 1] === '') all.pop();
  const selected = all.slice(-cap);
  return {
    exists: true,
    text: selected.join('\n'),
    lines: selected.length,
    size: info.size,
    updated: info.mtime.toISOString(),
    truncated: start > 0 || all.length > cap
  };
}

export function redact(text) {
  return String(text ?? '')
    .replace(/(authorization\s*:\s*bearer\s+)[^\s"',}]+/gi, '$1[redacted]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/=-]{8,}/gi, '$1[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-[redacted]')
    .replace(/"(api[_-]?key|access[_-]?token|tab[_-]?token|token|secret|password|key)"\s*:\s*"[^"]*"/gi, '"$1":"[redacted]"')
    .replace(/\b(api[_-]?key|access[_-]?token|tab[_-]?token|token|secret|password|key)\b\s*[:=]\s*([^\s"',}]+)/gi, '$1=[redacted]');
}

const HINTS = [
  {
    id: 'certificate',
    pattern: /requires an already trusted CA|unknown certificate|certificate verify failed|certutil/i,
    label: '证书信任',
    hint: '桥接证书尚未受信任。重新运行 setup.command；Windows 在控制台点「启动」并确认一次管理员授权。'
  },
  {
    id: 'port',
    pattern: /EADDRINUSE|address already in use/i,
    label: '端口占用',
    hint: '代理端口或控制端口被其他进程占用。关闭重复的桥接实例，或在 Magpie 面板修改控制端口。'
  },
  {
    id: 'gateway',
    pattern: /Magpie gateway unavailable|ECONNREFUSED|HTTP 401|unauthorized|invalid api key/i,
    label: 'Magpie 网关',
    hint: 'Magpie 网关不可达或鉴权失败。确认 Magpie 正在运行，并在 Agents 页面重新连接模型。'
  },
  {
    id: 'protocol',
    pattern: /not part of the captured protocol|BidiAppend contains no AgentClientMessage|failed to decode|decode error/i,
    label: '协议不匹配',
    hint: 'Cursor 私有协议与当前桥接不匹配。升级到最新桥接；若刚升级 Cursor，先回退 Cursor 或等待适配。'
  },
  {
    id: 'stalled',
    pattern: /connection stalled|stalled/i,
    label: '连接停滞',
    hint: '下行长时间没有数据。检查 engine.log 中是否有上行解码或网关错误，必要时重启后台。'
  },
  {
    id: 'timeout',
    pattern: /startup timed out|timed out/i,
    label: '启动超时',
    hint: '原生引擎未在 30 秒内就绪。查看 engine.log 的证书、端口与模型配置错误。'
  },
  {
    id: 'proxy',
    pattern: /Cursor proxy settings changed externally|代理设置由其他程序/i,
    label: '代理被改动',
    hint: 'Cursor 的 http.proxy 被其他程序修改。关闭冲突的代理工具，并在 Magpie 中断开后重新连接。'
  }
];

export function classify(text) {
  const source = String(text ?? '');
  return HINTS.filter((rule) => rule.pattern.test(source)).map(({id, label, hint}) => ({id, label, hint}));
}
