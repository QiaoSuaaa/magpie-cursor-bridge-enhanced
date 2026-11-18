import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createControlServer, paths} from '../control/server.js';
import {read, write} from '../lib/bridge-settings.js';
import platform from '../lib/platform.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

async function fixture(t, options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-features-'));
  const keys = ['CURSOR_BRIDGE_HOME', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.CURSOR_BRIDGE_HOME = home;
  process.env.APPDATA = path.join(home, 'roaming');
  process.env.LOCALAPPDATA = path.join(home, 'local');
  process.env.XDG_CONFIG_HOME = path.join(home, 'config');
  process.env.XDG_DATA_HOME = path.join(home, 'share');
  const p = paths(repoRoot);
  fs.mkdirSync(p.data, {recursive: true});
  fs.writeFileSync(p.status, JSON.stringify({state: 'connected', pid: process.pid}));
  fs.writeFileSync(p.database, Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(100)]));
  fs.writeFileSync(path.join(p.data, 'bridge.db-wal'), 'test-wal');
  fs.mkdirSync(path.join(p.data, 'ca'));
  fs.writeFileSync(path.join(p.data, 'ca', 'ca.key'), 'test-only-key');
  const instance = await createControlServer({repoRoot, port: 0, log: () => {}, ...options});
  t.after(async () => {
    await new Promise((resolve) => instance.server.close(resolve));
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    fs.rmSync(home, {recursive: true, force: true});
  });
  const base = `http://127.0.0.1:${instance.port}`;
  const html = await (await fetch(base)).text();
  const token = html.match(/__BRIDGE_TOKEN__="([0-9a-f]{64})"/)[1];
  const request = async (route, body) => {
    const response = await fetch(`${base}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {'x-magpiebridge-token': token, 'content-type': 'application/json'},
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return {status: response.status, data: await response.json()};
  };
  return {home, p, request};
}

test('migration stops writers, blocks competing requests, copies all data and restarts', async (t) => {
  let release;
  let stopped;
  const stopping = new Promise((resolve) => { stopped = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const events = [];
  const {home, p, request} = await fixture(t, {
    stop: async () => { events.push('stop'); stopped(); await gate; },
    start: async () => { events.push('start'); return {ok: true}; }
  });
  const destination = path.join(home, 'portable');
  const migration = request('/api/storage/migrate', {targetDir: destination});
  await stopping;
  assert.equal((await request('/api/storage/migrate', {targetDir: path.join(home, 'other')})).status, 409);
  assert.equal((await request('/api/database')).status, 409);
  assert.equal((await request('/api/calls')).status, 409);
  assert.equal(fs.existsSync(destination), false, 'copy waits for the writer to stop');
  release();
  const result = await migration;
  assert.equal(result.status, 200);
  assert.equal(result.data.mode, 'copied');
  assert.deepEqual(events, ['stop', 'start']);
  assert.equal(paths(repoRoot).data, result.data.dataDir);
  assert.deepEqual(fs.readFileSync(path.join(destination, 'bridge.db')), fs.readFileSync(p.database));
  assert.equal(fs.readFileSync(path.join(destination, 'bridge.db-wal'), 'utf8'), 'test-wal');
  assert.equal(fs.readFileSync(path.join(destination, 'ca', 'ca.key'), 'utf8'), 'test-only-key');
  assert.ok(fs.existsSync(p.database), 'original database is retained');
  assert.equal(paths(repoRoot).diagnostics, path.join(result.data.dataDir, 'diagnostics'));
  const diagnostic = await request('/api/diagnostics', {});
  assert.equal(diagnostic.status, 200);
  assert.equal(path.dirname(diagnostic.data.file), paths(repoRoot).diagnostics);
  assert.ok(fs.existsSync(diagnostic.data.file));
  assert.equal(fs.existsSync(path.join(p.data, 'diagnostics')), false, 'new diagnostics use the migrated directory');
});

test('failed migration preserves the current directory and restores running state', async (t) => {
  const events = [];
  const {home, p, request} = await fixture(t, {
    stop: async () => { events.push('stop'); },
    start: async () => { events.push('start'); return {ok: true}; }
  });
  const destination = path.join(home, 'occupied');
  fs.mkdirSync(destination);
  fs.writeFileSync(path.join(destination, 'user.txt'), 'keep');
  const result = await request('/api/storage/migrate', {targetDir: destination});
  assert.equal(result.status, 500);
  assert.deepEqual(events, ['stop', 'start']);
  assert.equal(paths(repoRoot).data, p.data);
  assert.equal(fs.readFileSync(path.join(destination, 'user.txt'), 'utf8'), 'keep');
  assert.equal((await request('/api/storage/migrate', {targetDir: 'relative/path'})).status, 400);
});

test('partial settings preserve Tab secrets while APIs and diagnostics omit them', async (t) => {
  const logs = [];
  const {p, request} = await fixture(t, {log: (text) => logs.push(text)});
  write(p.root, {tabToken: 'test-only-cursor-token'});
  const saved = await request('/api/settings', {refreshSeconds: 20});
  assert.equal(saved.status, 200);
  assert.equal(read(p.root).tabToken, 'test-only-cursor-token');
  assert.equal(saved.data.settings.tabTokenConfigured, true);
  assert.doesNotMatch(JSON.stringify(saved.data), /test-only-cursor-token/);
  assert.doesNotMatch(logs.join('\n'), /test-only-cursor-token/);
  const status = await request('/api/status');
  assert.doesNotMatch(JSON.stringify(status.data), /test-only-cursor-token/);
  const settings = await request('/api/settings');
  assert.doesNotMatch(JSON.stringify(settings.data), /test-only-cursor-token/);
  const diagnostics = await request('/api/diagnostics');
  assert.doesNotMatch(JSON.stringify(diagnostics.data), /test-only-cursor-token/);
  const official = await request('/api/settings', {tabMode: 'official'});
  if (platform.engineSupportsTab(repoRoot)) {
    assert.equal(official.status, 200);
    assert.equal(official.data.settings.tabMode, 'official');
    assert.equal(read(p.root).tabToken, 'test-only-cursor-token');
    assert.doesNotMatch(JSON.stringify(official.data), /test-only-cursor-token/);
  } else {
    assert.equal(official.status, 400);
  }
});
