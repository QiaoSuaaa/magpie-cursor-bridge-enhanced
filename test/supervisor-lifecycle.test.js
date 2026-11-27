import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {atomic} from '../lib/settings.js';
import {stopBridge} from '../control/server.js';
import platformModule from '../lib/platform.js';

test('cooperative stop exits the real supervisor and releases its lock without starting an engine', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-supervisor-stop-'));
  fs.writeFileSync(path.join(root, 'connection.json'), '{}');
  const watch = fs.promises.watch(root, {signal: AbortSignal.timeout(10000)});
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bridge.js', import.meta.url)), 'supervise'], {
    env: {...process.env, CURSOR_BRIDGE_ROOT: root, CURSOR_BRIDGE_SETTINGS: path.join(root, 'cursor-settings.json')},
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code));
  });
  t.after(async () => {
    await watch.return();
    if (child.exitCode === null) { child.kill('SIGKILL'); await exit; }
    fs.rmSync(root, {recursive: true, force: true});
  });
  for await (const event of watch) {
    try {
      if (JSON.parse(fs.readFileSync(path.join(root, 'status.json'), 'utf8')).state === 'disconnected') break;
    } catch { /* wait until the first complete status file is published */ }
  }
  assert.equal(fs.readFileSync(path.join(root, 'supervisor.lock', 'pid'), 'utf8'), String(child.pid));
  atomic(path.join(root, 'stop-request.json'), JSON.stringify({pid: child.pid}));
  const code = await Promise.race([exit, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('cooperative stop timed out')), 10000);
    timer.unref();
  })]);
  assert.equal(code, 0, stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'status.json'), 'utf8')).state, 'stopped');
  assert.equal(fs.existsSync(path.join(root, 'supervisor.lock')), false);
  assert.equal(fs.existsSync(path.join(root, 'stop-request.json')), false);
  assert.equal(fs.existsSync(path.join(root, 'effective.json')), false, 'no model or native engine is started');
  assert.equal(fs.existsSync(path.join(root, 'cursor-settings.json')), false);
});

test('Windows stopBridge falls back to verified termination only when force is true', {skip: process.platform !== 'win32'}, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-win-stop-'));
  const saved = {
    CURSOR_BRIDGE_HOME: process.env.CURSOR_BRIDGE_HOME,
    APPDATA: process.env.APPDATA,
    LOCALAPPDATA: process.env.LOCALAPPDATA
  };
  process.env.CURSOR_BRIDGE_HOME = home;
  process.env.APPDATA = path.join(home, 'AppData', 'Roaming');
  process.env.LOCALAPPDATA = path.join(home, 'AppData', 'Local');

  const root = platformModule.pathsFor(home).config;
  const lock = path.join(root, 'supervisor.lock');
  fs.mkdirSync(lock, {recursive: true});

  const legacyScript = path.join(home, 'bridge.js');
  fs.writeFileSync(legacyScript, 'setInterval(() => {}, 1000);\n');
  const child = spawn(process.execPath, [legacyScript, 'supervise'], {
    stdio: 'ignore',
    windowsHide: true
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));

  t.after(async () => {
    if (child.exitCode === null) {
      try { child.kill('SIGKILL'); } catch {}
      await exited;
    }
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(home, {recursive: true, force: true});
  });

  fs.writeFileSync(path.join(lock, 'pid'), String(child.pid));

  await assert.rejects(
    () => stopBridge(home, {force: false, graceMs: 300}),
    /后台仍在处理数据，请稍后重试/
  );
  assert.equal(child.exitCode, null, 'non-force stop keeps unresponsive process alive');
  assert.equal(fs.existsSync(path.join(root, 'stop-request.json')), false, 'stale stop-request.json is removed on timeout');

  await stopBridge(home, {force: true, graceMs: 300});
  await exited;
  assert.notEqual(child.exitCode, null, 'force fallback terminates legacy bridge.js supervisor');
  assert.equal(fs.existsSync(lock), false, 'supervisor.lock is cleaned up after forced termination');
  assert.equal(fs.existsSync(path.join(root, 'stop-request.json')), false);
});

