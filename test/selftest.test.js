import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {runSelfTest, tcpReachable, checkProxyTls} from '../control/selftest.js';

const temp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-bridge-selftest-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
};

test('tcpReachable distinguishes open and closed ports', async (t) => {
  const server = net.createServer((socket) => socket.end());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(() => new Promise((resolve) => server.close(resolve)));
  assert.equal(await tcpReachable('127.0.0.1', port, 1000), true);
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await tcpReachable('127.0.0.1', port, 500), false);
});

test('checkProxyTls reports a rejected CONNECT without hanging', async (t) => {
  const server = net.createServer((socket) => {
    socket.once('data', () => socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await assert.rejects(
    checkProxyTls({proxy: `http://127.0.0.1:${port}`, caFile: path.join(temp(t), 'ca.crt'), timeoutMs: 2000}),
    /CONNECT 返回 403/
  );
});

test('a healthy stack passes every layered check', async (t) => {
  const dataDir = temp(t);
  fs.mkdirSync(path.join(dataDir, 'ca'), {recursive: true});
  fs.writeFileSync(path.join(dataDir, 'ca', 'ca.crt'), 'test');
  let clock = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith('/models')) return {ok: true, json: async () => ({data: [{id: 'group/opus'}]})};
    if (url.endsWith('/chat/completions')) return {ok: true, json: async () => ({choices: [{message: {content: 'BRIDGE_OK'}}]})};
    throw new Error(`unexpected ${url}`);
  };
  const result = await runSelfTest({
    installation: {version: '0.2.27'},
    connection: {enabled: true, gateway: 'http://127.0.0.1:3425/v1', key: 'test', model: 'group/opus'},
    runtime: {state: 'connected', pid: 42, proxy: 'http://127.0.0.1:58160'},
    dataDir,
    gatewayBase: 'http://127.0.0.1:3425',
    includeModel: true,
    alive: () => true,
    tcp: async () => true,
    proxyTls: async () => ({subject: 'Cursor BYOK Local CA'}),
    fetchImpl,
    now: () => (clock += 10)
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.checks.map((check) => check.id), ['installation', 'connection', 'runtime', 'proxy', 'tls', 'gateway', 'model']);
  assert.ok(result.checks.every((check) => check.ok && !check.skipped));
});

test('a disconnected stack fails the affected checks and skips the model on request', async (t) => {
  const dataDir = temp(t);
  const result = await runSelfTest({
    installation: {version: '0.2.27'},
    connection: null,
    runtime: {state: 'disconnected'},
    dataDir,
    includeModel: false,
    alive: () => false,
    tcp: async () => false,
    proxyTls: async () => { throw new Error('not reached'); },
    fetchImpl: async () => { throw new Error('not reached'); }
  });
  assert.equal(result.ok, false);
  const failed = result.checks.filter((check) => !check.ok).map((check) => check.id);
  assert.deepEqual(failed, ['connection', 'runtime', 'proxy', 'tls', 'gateway']);
  assert.equal(result.checks.find((check) => check.id === 'model').skipped, true);
});
