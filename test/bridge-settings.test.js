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
  assert.deepEqual(read(root), {runMode: 'default', subagentMode: 'async', refreshSeconds: 30, gatewayGraceSeconds: defaults.gatewayGraceSeconds, logLimitMB: 8});
});

test('run mode falls back when read and is rejected strictly', (t) => {
  const root = setup(t);
  fs.writeFileSync(settingsFile(root), JSON.stringify({runMode: 'turbo'}));
  assert.equal(read(root).runMode, 'default');
  assert.throws(() => write(root, {runMode: 'turbo'}), /default 或 lite/);
  assert.deepEqual(normalize({runMode: 'lite'}), {...defaults, runMode: 'lite'});
});

test('subagent mode defaults to async and rejects unknown values strictly', (t) => {
  const root = setup(t);
  fs.writeFileSync(settingsFile(root), JSON.stringify({subagentMode: 'parallel'}));
  assert.equal(read(root).subagentMode, 'async');
  assert.throws(() => write(root, {subagentMode: 'parallel'}), /async 或 sync/);
  assert.deepEqual(normalize({subagentMode: 'sync'}), {...defaults, subagentMode: 'sync'});
});

test('writes validate strictly, round-trip and keep the file private', (t) => {
  const root = setup(t);
  assert.throws(() => write(root, {refreshSeconds: 1}), /5–300/);
  const saved = write(root, {runMode: 'lite', subagentMode: 'sync', refreshSeconds: 30, gatewayGraceSeconds: 120, logLimitMB: 8});
  assert.deepEqual(saved, {runMode: 'lite', subagentMode: 'sync', refreshSeconds: 30, gatewayGraceSeconds: 120, logLimitMB: 8});
  assert.deepEqual(read(root), saved);
  assert.equal(fs.statSync(settingsFile(root)).mode & 0o777, 0o600);
  assert.deepEqual(normalize({}), defaults);
});
