import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {execFile, spawn} from 'node:child_process';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {read as readBridgeSettings, write as writeBridgeSettings, defaults as bridgeDefaults, rules as bridgeRules, modes as bridgeModes, subagentModes as bridgeSubagentModes, settingsFile} from '../lib/bridge-settings.js';

// The control console is served from the Magpie plugin host. It runs the
// same setup.command the user would type in a terminal, so the panel and
// the CLI can never disagree about what "start" or "restart" means.
//
// Security model (mirrors the sandboxed panel that opens it):
//  - loopback only, and the Host header must be this very server;
//  - the page runs in an opaque-origin sandbox, so it needs CORS with
//    Access-Control-Allow-Origin: null and a per-process token;
//  - the token is inline in the HTML only. /api/* without it is refused,
//    which keeps any other opaque-origin frame from driving the bridge.
const TOKEN_HEADER = 'x-magpiebridge-token';
const LABEL = 'local.magpie.cursor-bridge';
const MAX_BODY = 16 * 1024;
const ACTION_TIMEOUT = 180000;

export function paths(repoRoot) {
  // CURSOR_BRIDGE_HOME keeps tests (and a portable copy) away from the real
  // ~/.config; the normal path is always the user's home.
  const home = process.env.CURSOR_BRIDGE_HOME || os.homedir();
  const root = path.join(home, '.config/magpie-cursor-bridge');
  const share = path.join(home, '.local/share/magpie-cursor-bridge');
  return {
    home,
    root,
    share,
    plist: path.join(home, 'Library/LaunchAgents', `${LABEL}.plist`),
    status: path.join(root, 'status.json'),
    installation: path.join(root, 'installation.json'),
    connection: path.join(root, 'connection.json'),
    supervisorPid: path.join(root, 'supervisor.lock/pid'),
    engineLog: path.join(root, 'engine.log'),
    supervisorLog: path.join(root, 'supervisor.log'),
    supervisorError: path.join(root, 'supervisor-error.log'),
    settings: settingsFile(root),
    setup: path.join(repoRoot, 'setup.command'),
    repo: repoRoot
  };
}

const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};
const readPid = (file) => {
  try {
    const value = Number(fs.readFileSync(file, 'utf8').trim());
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch { return null; }
};
const stat = (file) => {
  try {
    const s = fs.statSync(file);
    return {size: s.size, updated: s.mtime.toISOString()};
  } catch { return null; }
};
const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run(command, args, {timeout = 15000} = {}) {
  return new Promise((resolve) => {
    execFile(command, args, {encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024}, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: typeof error?.code === 'number' ? error.code : (error ? null : 0),
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        error: error ? String(error.message || error) : ''
      });
    });
  });
}

async function commandOf(pid) {
  if (!alive(pid)) return '';
  const result = await run('/bin/ps', ['-p', String(pid), '-o', 'command='], {timeout: 5000});
  return result.ok ? result.stdout.trim() : '';
}

async function stopProcess(pid, marker, graceMs) {
  if (!alive(pid)) return false;
  const command = await commandOf(pid);
  if (!command.includes(marker)) return false;
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    try { process.kill(pid, signal); } catch { return false; }
    const until = Date.now() + graceMs;
    while (Date.now() < until) {
      if (!alive(pid)) return true;
      await wait(150);
    }
  }
  return !alive(pid);
}

async function launchAgentState() {
  const domain = `gui/${process.getuid()}`;
  const result = await run('/bin/launchctl', ['print', `${domain}/${LABEL}`], {timeout: 10000});
  if (!result.ok) return {registered: false, state: null, pid: null};
  const state = /state = ([^\n]+)/.exec(result.stdout)?.[1]?.trim() || null;
  const pid = Number(/pid = (\d+)/.exec(result.stdout)?.[1] || 0) || null;
  return {registered: true, state, pid};
}

function safeConnection(repoRoot) {
  const data = readJson(paths(repoRoot).connection);
  if (!data || typeof data !== 'object') return {exists: false};
  return {
    exists: true,
    enabled: data.enabled === true,
    model: typeof data.model === 'string' ? data.model : null,
    models: Array.isArray(data.models) ? data.models.length : 0,
    gateway: typeof data.gateway === 'string' ? data.gateway : null
  };
}

async function overview(repoRoot, port) {
  const p = paths(repoRoot);
  const installation = readJson(p.installation);
  const runtime = readJson(p.status);
  const supervisorPid = readPid(p.supervisorPid);
  const supervisorCommand = supervisorPid ? await commandOf(supervisorPid) : '';
  const enginePid = Number(runtime?.pid) || null;
  const engineCommand = enginePid ? await commandOf(enginePid) : '';
  const agent = await launchAgentState();
  return {
    now: new Date().toISOString(),
    version: typeof installation?.version === 'string' ? installation.version : null,
    installation: installation ? {
      version: installation.version || null,
      installed: installation.installed || null,
      release: installation.release || null,
      source: installation.source || null
    } : null,
    runtime: runtime ? {
      state: runtime.state || null,
      model: runtime.model || null,
      models: Number(runtime.models) || 0,
      proxy: runtime.proxy || null,
      backend: runtime.backend || null,
      pid: Number(runtime.pid) || null,
      updated: runtime.updated || null,
      warning: runtime.warning || null,
      reason: runtime.reason || null
    } : null,
    supervisor: {
      pid: supervisorPid,
      alive: !!supervisorPid && alive(supervisorPid),
      expected: supervisorCommand.includes('bridge.js') && supervisorCommand.includes('supervise')
    },
    engine: {
      pid: enginePid,
      alive: !!enginePid && alive(enginePid),
      expected: engineCommand.includes('cursor-magpie-bridge')
    },
    launchAgent: agent,
    connection: safeConnection(repoRoot),
    database: stat(path.join(p.root, 'data/bridge.db')),
    settings: {
      values: readBridgeSettings(p.root),
      defaults: bridgeDefaults,
      rules: bridgeRules,
      modes: bridgeModes,
      subagentModes: bridgeSubagentModes,
      file: p.settings
    },
    paths: {
      configDir: p.root,
      installDir: p.share,
      plist: p.plist,
      repo: p.repo,
      setup: p.setup
    },
    logs: {
      engine: stat(p.engineLog),
      supervisor: stat(p.supervisorLog),
      error: stat(p.supervisorError)
    },
    control: {port, pid: process.pid, uptime: Math.round(process.uptime())}
  };
}

function capture(child, resolve) {
  let stdout = '';
  let stderr = '';
  let settled = false;
  let timer = null;
  const clip = (text) => text.length > 60000 ? text.slice(-60000) : text;
  const finish = (value) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    resolve({...value, stdout, stderr});
  };
  child.stdout?.on('data', (chunk) => { stdout = clip(stdout + chunk); });
  child.stderr?.on('data', (chunk) => { stderr = clip(stderr + chunk); });
  child.once('error', (error) => finish({ok: false, code: null, error: String(error.message || error)}));
  child.once('close', (code) => finish(code === 0
    ? {ok: true, code: 0, error: ''}
    : {ok: false, code, error: `命令退出码 ${code ?? '未知'}`}));
  timer = setTimeout(() => {
    if (settled) return;
    try { child.kill('SIGTERM'); } catch {}
    finish({ok: false, code: null, error: '命令超时（180 秒）', timedOut: true});
  }, ACTION_TIMEOUT);
}

function runSetup(repoRoot) {
  const p = paths(repoRoot);
  if (!fs.existsSync(p.setup)) {
    return Promise.resolve({ok: false, code: null, stdout: '', stderr: '', error: `找不到 ${p.setup}`});
  }
  return new Promise((resolve) => {
    const child = spawn('/bin/bash', [p.setup, 'setup'], {
      cwd: repoRoot,
      env: {...process.env, TERM: 'dumb'},
      stdio: ['ignore', 'pipe', 'pipe']
    });
    capture(child, resolve);
  });
}

function runStatus(repoRoot) {
  const p = paths(repoRoot);
  if (!fs.existsSync(p.setup)) {
    return Promise.resolve({ok: false, code: null, stdout: '', stderr: '', error: `找不到 ${p.setup}`});
  }
  return new Promise((resolve) => {
    const child = spawn('/bin/bash', [p.setup, 'status'], {
      cwd: repoRoot,
      env: {...process.env, TERM: 'dumb'},
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      resolve({ok: false, code: null, stdout: '', stderr: '', error: '状态命令超时'});
    }, 20000);
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => {
      clearTimeout(timer);
      resolve({ok: false, code: null, stdout, stderr, error: String(error.message || error)});
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0
        ? {ok: true, code: 0, stdout, stderr, error: ''}
        : {ok: false, code, stdout, stderr, error: `命令退出码 ${code ?? '未知'}`});
    });
  });
}

async function stopBridge(repoRoot) {
  const p = paths(repoRoot);
  await run('/bin/launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`], {timeout: 15000});
  const supervisorPid = readPid(p.supervisorPid);
  if (supervisorPid) await stopProcess(supervisorPid, 'bridge.js', 10000);
  const runtime = readJson(p.status);
  const enginePid = Number(runtime?.pid) || null;
  if (enginePid) await stopProcess(enginePid, 'cursor-magpie-bridge', 5000);
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...corsHeaders(res.req)
  });
  res.end(JSON.stringify(body));
}

function corsHeaders(req) {
  const origin = req.headers.origin;
  return {
    'access-control-allow-origin': origin === 'null' ? 'null' : origin || 'null',
    'access-control-allow-headers': `content-type, ${TOKEN_HEADER}`,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'vary': 'Origin'
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('请求不是合法的 JSON')); }
    });
    req.on('error', reject);
  });
}


const here = path.dirname(fileURLToPath(import.meta.url));

export function createControlServer({repoRoot, port, log = console.log}) {
  const token = randomBytes(32).toString('hex');
  const htmlFile = path.join(here, 'ui.html');
  const readAsset = (name, type) => {
    const file = path.join(here, name);
    if (!fs.existsSync(file)) return null;
    return {body: fs.readFileSync(file), type};
  };
  let busy = null;
  let ownPort = port;

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://127.0.0.1:${ownPort}`);
      const host = String(req.headers.host || '').toLowerCase();
      if (host !== `127.0.0.1:${ownPort}` && host !== `localhost:${ownPort}`) {
        res.writeHead(421, {'content-type': 'text/plain; charset=utf-8'});
        return res.end('misdirected request');
      }
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== 'null' && origin !== `http://127.0.0.1:${ownPort}` && origin !== `http://localhost:${ownPort}`) {
        res.writeHead(403, {'content-type': 'text/plain; charset=utf-8'});
        return res.end('origin not allowed');
      }

      if (req.method === 'OPTIONS') {
        res.writeHead(204, {...corsHeaders(req), 'access-control-max-age': '600'});
        return res.end();
      }

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const html = fs.readFileSync(htmlFile, 'utf8')
          .replace('__CONTROL_TOKEN__', token)
          .replace('__CONTROL_PORT__', String(ownPort));
        // A sandboxed frame has an opaque origin, where CSP 'self' matches
        // nothing. Name the loopback sources explicitly or ui.css/ui.js are
        // refused and the page falls back to unstyled HTML with no handlers.
        const origin = `http://127.0.0.1:${ownPort}`;
        const alt = `http://localhost:${ownPort}`;
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'content-security-policy': `default-src 'none'; script-src ${origin} ${alt} 'unsafe-inline'; style-src ${origin} ${alt} 'unsafe-inline'; img-src ${origin} ${alt} data:; connect-src ${origin} ${alt}; font-src ${origin} ${alt}; base-uri 'none'; form-action 'none'; frame-ancestors 'self' wails: http://wails.localhost http://localhost:* http://127.0.0.1:*`
        });
        return res.end(html);
      }

      if (req.method === 'GET' && (url.pathname === '/ui.css' || url.pathname === '/ui.js')) {
        const asset = readAsset(url.pathname.slice(1), url.pathname.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8');
        if (!asset) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, {'content-type': asset.type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff'});
        return res.end(asset.body);
      }

      if (url.pathname.startsWith('/api/')) {
        const got = Buffer.from(String(req.headers[TOKEN_HEADER] || ''));
        const want = Buffer.from(token);
        if (got.length !== want.length || !timingSafeEqual(got, want)) {
          return sendJson(res, 403, {ok: false, error: '控制口令无效'});
        }
      }

      if (req.method === 'GET' && url.pathname === '/api/status') {
        return sendJson(res, 200, {ok: true, overview: await overview(repoRoot, ownPort)});
      }

      if (req.method === 'GET' && url.pathname === '/api/settings') {
        const p = paths(repoRoot);
        return sendJson(res, 200, {ok: true, settings: readBridgeSettings(p.root), defaults: bridgeDefaults, rules: bridgeRules, modes: bridgeModes, subagentModes: bridgeSubagentModes, file: p.settings});
      }

      if (req.method === 'POST' && url.pathname === '/api/settings') {
        const body = await readBody(req);
        const p = paths(repoRoot);
        try {
          const saved = writeBridgeSettings(p.root, body);
          log(`bridge settings saved: ${JSON.stringify(saved)}`);
          return sendJson(res, 200, {ok: true, settings: saved});
        } catch (error) {
          return sendJson(res, 400, {ok: false, error: String(error.message || error)});
        }
      }

      if (req.method === 'POST' && url.pathname === '/api/action') {
        const body = await readBody(req);
        const action = String(body.action || '');
        if (!['start', 'status', 'restart'].includes(action)) {
          return sendJson(res, 400, {ok: false, error: `未知操作：${action || '空'}`});
        }
        if (busy) return sendJson(res, 409, {ok: false, error: `正在执行「${busy}」，请稍候`});
        busy = action;
        log(`control action: ${action}`);
        try {
          let result;
          if (action === 'status') {
            result = await runStatus(repoRoot);
          } else if (action === 'restart') {
            await stopBridge(repoRoot);
            result = await runSetup(repoRoot);
          } else {
            result = await runSetup(repoRoot);
          }
          result.action = action;
          result.overview = await overview(repoRoot, ownPort);
          return sendJson(res, 200, result);
        } finally {
          busy = null;
        }
      }

      if (req.method === 'POST' && url.pathname === '/api/open') {
        const body = await readBody(req);
        const p = paths(repoRoot);
        const targets = {
          config: p.root,
          'engine-log': p.engineLog,
          'supervisor-log': p.supervisorLog,
          'supervisor-error-log': p.supervisorError,
          install: p.share,
          repo: p.repo,
          plist: p.plist
        };
        const target = targets[String(body.target || '')];
        if (!target) return sendJson(res, 400, {ok: false, error: '未知的打开目标'});
        if (!fs.existsSync(target)) return sendJson(res, 404, {ok: false, error: `路径不存在：${target}`});
        const result = await run('/usr/bin/open', [target], {timeout: 10000});
        return sendJson(res, result.ok ? 200 : 500, result.ok ? {ok: true} : {ok: false, error: result.error || '打开失败'});
      }

      res.writeHead(404, {'content-type': 'text/plain; charset=utf-8'});
      res.end('not found');
    } catch (error) {
      log(`control request failed: ${error?.stack || error}`);
      if (!res.headersSent) sendJson(res, 500, {ok: false, error: String(error?.message || error)});
      else res.end();
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      ownPort = server.address().port;
      log(`listening on http://127.0.0.1:${ownPort}`);
      resolve({server, port: ownPort});
    });
  });
}
