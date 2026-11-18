import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {atomic} from '../lib/settings.js';

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
