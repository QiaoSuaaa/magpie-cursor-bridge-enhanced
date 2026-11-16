import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import {version} from '../version.js';

// Layered self-test. It verifies the pieces that can fail independently:
// installation, Magpie connection, engine liveness, the local proxy port, the
// MITM certificate path, the gateway catalogue and (opt-in) one tiny model
// request. The Cursor Bidi/RunSSE round-trip itself stays in the native
// engine's smoke example; this test tells the user which layer broke without
// requiring a Cursor conversation.
const PROMPT = 'Reply with exactly BRIDGE_OK. Do not call any tools.';
const USER_AGENT = `cursor-magpie-bridge/${version}-selftest`;

export function tcpReachable(host, port, timeoutMs = 3000, connect = net.connect) {
  return new Promise((resolve) => {
    const socket = connect({host, port});
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* already closed */ }
      resolve(value);
    };
    socket.setTimeout?.(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

export function checkProxyTls({proxy, caFile, host = 'api2.cursor.sh', timeoutMs = 8000, connect = net.connect, secureConnect = tls.connect, readFile = fs.readFileSync} = {}) {
  return new Promise((resolve, reject) => {
    const proxyUrl = new URL(proxy);
    let settled = false;
    let buffer = Buffer.alloc(0);
    const socket = connect({host: proxyUrl.hostname, port: Number(proxyUrl.port) || 80});
    const timer = setTimeout(() => fail(new Error('代理 CONNECT 超时')), timeoutMs);
    function fail(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch { /* already closed */ }
      reject(error);
    }
    socket.once('error', fail);
    socket.once('connect', () => {
      socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`);
    });
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      socket.off('data', onData);
      const head = buffer.subarray(0, end).toString('latin1');
      const status = /^HTTP\/1\.[01] (\d+)/.exec(head);
      if (!status || status[1] !== '200') {
        fail(new Error(`代理 CONNECT 返回 ${status ? status[1] : '未知状态'}`));
        return;
      }
      const leftover = buffer.subarray(end + 4);
      if (leftover.length) socket.unshift(leftover);
      let secure;
      try {
        secure = secureConnect({socket, servername: host, ca: readFile(caFile)});
      } catch (error) {
        fail(error);
        return;
      }
      secure.once('secureConnect', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const cert = secure.getPeerCertificate?.() || {};
        try { secure.end(); } catch { /* already closed */ }
        resolve({subject: cert.subject?.CN || '', issuer: cert.issuer?.CN || ''});
      });
      secure.once('error', fail);
    };
    socket.on('data', onData);
  });
}

async function fetchJson(fetchImpl, url, options, timeoutMs) {
  const response = await fetchImpl(url, {...options, signal: AbortSignal.timeout(timeoutMs)});
  let body = null;
  try { body = await response.json(); } catch { /* non-JSON error page */ }
  return {response, body};
}

export async function runSelfTest({
  installation,
  connection,
  runtime,
  dataDir,
  gatewayBase,
  includeModel = true,
  alive = (pid) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  },
  fetchImpl = fetch,
  tcp = tcpReachable,
  proxyTls = checkProxyTls,
  now = () => Date.now()
} = {}) {
  const checks = [];
  const add = async (id, label, task) => {
    const started = now();
    try {
      const detail = await task();
      checks.push({id, label, ok: true, detail: String(detail || '通过'), durationMs: now() - started});
    } catch (error) {
      checks.push({id, label, ok: false, detail: String(error?.message || error), durationMs: now() - started});
    }
  };
  const gateway = connection?.gateway || (gatewayBase ? `${gatewayBase.replace(/\/$/, '')}/v1` : null);

  await add('installation', '插件版本', () => {
    if (!installation?.version) throw new Error('找不到 installation.json；请先运行 setup.command');
    return installation.version;
  });

  await add('connection', 'Magpie 连接', () => {
    if (!connection?.enabled) throw new Error('尚未在 Magpie 中连接模型');
    if (!connection.model || !connection.key || !connection.gateway) throw new Error('connection.json 缺少模型、密钥或网关地址');
    return connection.model;
  });

  await add('runtime', '后台与引擎', () => {
    if (runtime?.state !== 'connected') throw new Error(`状态为 ${runtime?.state || '未知'}，不是 connected`);
    if (!Number.isInteger(runtime.pid) || !alive(runtime.pid)) throw new Error('原生引擎未运行');
    return `PID ${runtime.pid}`;
  });

  await add('proxy', '代理端口', async () => {
    if (!runtime?.proxy) throw new Error('status.json 中没有代理地址');
    const url = new URL(runtime.proxy);
    if (!(await tcp(url.hostname, Number(url.port) || 80, 3000))) throw new Error(`无法连接 ${url.host}`);
    return url.host;
  });

  await add('tls', 'MITM 证书链路', async () => {
    if (!runtime?.proxy) throw new Error('代理未运行');
    const caFile = path.join(dataDir, 'ca', 'ca.crt');
    if (!fs.existsSync(caFile)) throw new Error(`找不到本机 CA：${caFile}`);
    const info = await proxyTls({proxy: runtime.proxy, caFile});
    return `TLS 通过${info?.subject ? `（${info.subject}）` : ''}`;
  });

  await add('gateway', 'Magpie 网关', async () => {
    if (!gateway) throw new Error('找不到 Magpie 网关地址');
    if (!connection?.key) throw new Error('缺少 Magpie 网关密钥');
    const {response, body} = await fetchJson(fetchImpl, `${gateway.replace(/\/$/, '')}/models`, {
      headers: {Authorization: `Bearer ${connection.key}`, 'User-Agent': USER_AGENT}
    }, 8000);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!Array.isArray(body?.data)) throw new Error('模型目录格式无效');
    if (connection.model && !body.data.some((entry) => entry?.id === connection.model)) {
      throw new Error(`当前模型 ${connection.model} 不在目录中`);
    }
    return `${body.data.length} 个模型`;
  });

  if (includeModel) {
    await add('model', '模型请求', async () => {
      if (!gateway || !connection?.key || !connection.model) throw new Error('缺少网关、密钥或模型');
      const started = now();
      const {response, body} = await fetchJson(fetchImpl, `${gateway.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {'content-type': 'application/json', Authorization: `Bearer ${connection.key}`, 'User-Agent': USER_AGENT},
        body: JSON.stringify({model: connection.model, messages: [{role: 'user', content: PROMPT}], max_tokens: 8, stream: false})
      }, 30000);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = body?.choices?.[0]?.message?.content ?? '';
      if (!/BRIDGE_OK/i.test(text)) throw new Error(`返回内容异常：${String(text).slice(0, 120) || '空'}`);
      return `${Math.round(now() - started)}ms · ${String(text).trim().slice(0, 40)}`;
    });
  } else {
    checks.push({id: 'model', label: '模型请求', ok: true, skipped: true, detail: '未勾选，未发送模型请求', durationMs: 0});
  }

  return {
    ok: checks.every((check) => check.skipped || check.ok),
    generated: new Date().toISOString(),
    includeModel,
    checks
  };
}
