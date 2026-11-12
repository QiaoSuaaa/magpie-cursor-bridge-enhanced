import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {defaults, normalize, read, settingsFile, write} from '../lib/bridge-settings.js';

const setup = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-bridge-settings-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
};

test('missing or malformed bridge settings fall back to defaults', (t) => {
  const root = setup(t);
  assert.deepEqual(read(root), defaults);
  fs.writeFileSync(settingsFile(root), '{"refreshSeconds": 0, "logLimitMB": "x"}');
  assert.deepEqual(read(root), defaults);
});

test('out-of-range values fall back per key when read', (t) => {
  const root = setup(t);
  fs.writeFileSync(settingsFile(root), JSON.stringify({refreshSeconds: 30, gatewayGraceSeconds: 9999, logLimitMB: 8}));
  assert.deepEqual(read(root), {refreshSeconds: 30, gatewayGraceSeconds: defaults.gatewayGraceSeconds, logLimitMB: 8});
});

test('writes validate strictly, round-trip and keep the file private', (t) => {
  const root = setup(t);
  assert.throws(() => write(root, {refreshSeconds: 1}), /5–300/);
  const saved = write(root, {refreshSeconds: 30, gatewayGraceSeconds: 120, logLimitMB: 8});
  assert.deepEqual(saved, {refreshSeconds: 30, gatewayGraceSeconds: 120, logLimitMB: 8});
  assert.deepEqual(read(root), saved);
  assert.equal(fs.statSync(settingsFile(root)).mode & 0o777, 0o600);
  assert.deepEqual(normalize({}), defaults);
});
