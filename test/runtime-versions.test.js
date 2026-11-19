import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeVersions, runtimeStatus} from '../control/server.js';

test('stale connected status is invalidated only when both processes are gone', () => {
  const runtime = {state: 'connected', pid: 42, model: 'm'};
  const failed = runtimeStatus(runtime, {supervisorAlive: false, engineAlive: false});
  assert.equal(failed.state, 'error');
  assert.match(failed.reason, /上次连接状态已失效/);
  assert.equal(runtime.state, 'connected');
  for (const health of [{supervisorAlive: true, engineAlive: false}, {supervisorAlive: false, engineAlive: true}, {supervisorAlive: true, engineAlive: true}]) {
    assert.equal(runtimeStatus(runtime, health), runtime);
  }
  assert.equal(runtimeStatus(null, {supervisorAlive: false, engineAlive: false}), null);
  const stopped = {state: 'stopped'};
  assert.equal(runtimeStatus(stopped, {supervisorAlive: false, engineAlive: false}), stopped);
});

const fixture = () => ({
  manifest: {version: '0.2.32'}, installation: {version: '0.2.31'},
  integrity: {engineVersions: {'win32-x64': '0.2.16'}, platforms: {'win32-x64': 'new-hash'}},
  runtime: {pid: 42, version: '0.2.32', runtime: {pid: 42, pluginVersion: '0.2.32', engineVersion: '0.2.16', sha256: 'new-hash'}},
  engineAlive: true, key: 'win32-x64'
});

test('runtime identity distinguishes installed plugin and running engine versions', () => {
  const versions = runtimeVersions(fixture());
  assert.equal(versions.installedPlugin, '0.2.31');
  assert.equal(versions.runningPlugin, '0.2.32');
  assert.equal(versions.runningEngine, '0.2.16');
  assert.equal(versions.state, 'current');
});
test('a binary replacement requires restart even if version strings are unchanged', () => {
  const input = fixture();
  input.runtime.runtime.sha256 = 'old-hash';
  assert.equal(runtimeVersions(input).state, 'restart_required');
});
test('plugin code update also requires restart', () => {
  const input = fixture(); input.runtime.runtime.pluginVersion = '0.2.31';
  assert.equal(runtimeVersions(input).needsRestart, true);
});
test('missing identity and mismatched process identity remain unknown', () => {
  for (const identity of [undefined, {...fixture().runtime.runtime, pid: 99}]) {
    const input = fixture(); input.runtime.runtime = identity;
    const result = runtimeVersions(input);
    assert.equal(result.state, 'unknown');
    assert.equal(result.runningEngine, null);
    assert.equal(result.needsRestart, null);
  }
});
test('dead process does not advertise stale runtime versions', () => {
  const input = fixture(); input.engineAlive = false;
  const result = runtimeVersions(input);
  assert.equal(result.state, 'stopped');
  assert.equal(result.runningEngine, null);
});
