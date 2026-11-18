import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {defaults, normalize, tabConfig, publicSettings, read, write} from '../lib/bridge-settings.js';
import {redact} from '../control/diagnostics.js';

const temporary = (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-tab-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  return root;
};

test('Tab defaults preserve official Cursor completion and reject incomplete modes', () => {
  assert.equal(defaults.tabMode, 'direct');
  assert.throws(() => normalize({tabMode: 'other'}, {strict: true}), /未知/);
  assert.throws(() => normalize({tabMode: 'official'}, {strict: true}), /Token/);
  assert.throws(() => normalize({tabMode: 'model'}, {strict: true}), /未知/);
  assert.throws(() => normalize({tabMode: 'custom'}, {strict: true}), /端点/);
  for (const tabAddress of ['file:///tmp/tab', 'https://user:secret@example.com', 'https://example.com?token=secret']) {
    assert.throws(() => normalize({tabMode: 'custom', tabAddress}, {strict: true}), /HTTP/);
  }
});

test('Tab settings round-trip and native configuration uses engine field names', (t) => {
  const root = temporary(t);
  write(root, {tabMode: 'official', tabToken: ' test-token '});
  const saved = read(root);
  assert.deepEqual(tabConfig(saved), {mode: 'official', token: 'test-token', address: ''});
  const visible = publicSettings(saved);
  assert.equal(visible.tabTokenConfigured, true);
  assert.equal(visible.tabToken, undefined);
  assert.doesNotMatch(JSON.stringify(visible), /test-token/);
  assert.doesNotMatch(redact(JSON.stringify(saved)), /test-token/);
  assert.equal(tabConfig(normalize({tabMode: 'custom', tabAddress: 'https://example.com'})).address, 'https://example.com');
});
