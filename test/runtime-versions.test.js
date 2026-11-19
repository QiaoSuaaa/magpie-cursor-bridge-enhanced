import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeVersions} from '../control/server.js';

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
