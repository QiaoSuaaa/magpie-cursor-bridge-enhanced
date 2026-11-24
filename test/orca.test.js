import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {orcaDataPathFor, orcaStatus, injectOrca, removeOrca, reconcileOrca, readOrcaData} from '../lib/orca.js';
import {wrapperPathFor, installWrapper} from '../lib/cursor-agent.js';

function workspace(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-bridge-orca-'));
  t.after(() => fs.rmSync(base, {recursive: true, force: true}));
  return {base, home: path.join(base, 'home'), root: path.join(base, 'root')};
}

function writeOrca(t, home, data, plat = process.platform, environment = {}) {
  const file = orcaDataPathFor({home, plat, environment});
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

const ENV = {PATH: ''};

test('orca config path follows each platform layout', () => {
  assert.equal(
    orcaDataPathFor({home: '/Users/u', plat: 'darwin', environment: {}}),
    path.posix.join('/Users/u', 'Library', 'Application Support', 'orca', 'orca-data.json')
  );
  assert.equal(
    orcaDataPathFor({home: '/home/u', plat: 'linux', environment: {XDG_CONFIG_HOME: '/xdg'}}),
    path.posix.join('/xdg', 'orca', 'orca-data.json')
  );
  assert.equal(
    orcaDataPathFor({home: 'C:\\Users\\u', plat: 'win32', environment: {APPDATA: 'C:\\Roaming'}}),
    path.win32.join('C:\\Roaming', 'orca', 'orca-data.json')
  );
});

test('missing orca config is reported without creating one', (t) => {
  const {home, root} = workspace(t);
  const status = orcaStatus({home, root, running: false, environment: ENV});
  assert.equal(status.installed, false);
  assert.equal(status.injected, false);
  assert.equal(fs.existsSync(status.path), false);
});

test('injectOrca points the cursor agent at the wrapper and keeps other settings', (t) => {
  const {home, root} = workspace(t);
  const file = writeOrca(t, home, {
    settings: {
      agentCmdOverrides: {claude: '/opt/claude-wrapper'},
      agentDefaultEnv: {goose: {GOOSE_MODE: 'auto'}},
      someOtherSetting: 42
    },
    unrelated: true
  });
  const result = injectOrca({home, root, running: false, environment: ENV});
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  const data = readOrcaData(file);
  const wrapper = wrapperPathFor(root, home, process.platform, ENV);
  assert.equal(data.settings.agentCmdOverrides.cursor, wrapper);
  assert.equal(data.settings.agentCmdOverrides.claude, '/opt/claude-wrapper');
  assert.deepEqual(data.settings.agentDefaultEnv, {goose: {GOOSE_MODE: 'auto'}});
  assert.equal(data.settings.someOtherSetting, 42);
  assert.equal(data.unrelated, true);

  const again = injectOrca({home, root, running: false, environment: ENV});
  assert.equal(again.ok, true);
  assert.equal(again.changed, false);
});

test('injectOrca refuses to replace a user-configured override', (t) => {
  const {home, root} = workspace(t);
  writeOrca(t, home, {settings: {agentCmdOverrides: {cursor: '/usr/local/bin/my-cursor'}}});
  const result = injectOrca({home, root, running: false, environment: ENV});
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'foreign-override');
  assert.equal(result.previous, '/usr/local/bin/my-cursor');
  assert.equal(readOrcaData(result.path).settings.agentCmdOverrides.cursor, '/usr/local/bin/my-cursor');
});

test('injectOrca refuses while Orca is running', (t) => {
  const {home, root} = workspace(t);
  writeOrca(t, home, {settings: {}});
  const result = injectOrca({home, root, running: true, environment: ENV});
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'running');
});

test('removeOrca only removes the wrapper override', (t) => {
  const {home, root} = workspace(t);
  const file = writeOrca(t, home, {settings: {agentCmdOverrides: {claude: '/opt/claude'}}});
  injectOrca({home, root, running: false, environment: ENV});
  const result = removeOrca({home, root, running: false, environment: ENV});
  assert.equal(result.ok, true);
  assert.equal(result.removed, true);
  const data = readOrcaData(file);
  assert.equal(data.settings.agentCmdOverrides.cursor, undefined);
  assert.equal(data.settings.agentCmdOverrides.claude, '/opt/claude');

  // A foreign override is left alone even when a removal is requested.
  writeOrca(t, home, {settings: {agentCmdOverrides: {cursor: '/usr/local/bin/my-cursor'}}});
  const foreign = removeOrca({home, root, running: false, environment: ENV});
  assert.equal(foreign.ok, true);
  assert.equal(foreign.removed, false);
  assert.equal(readOrcaData(file).settings.agentCmdOverrides.cursor, '/usr/local/bin/my-cursor');
});

test('a malformed orca file is never overwritten', (t) => {
  const {home, root} = workspace(t);
  const file = orcaDataPathFor({home, plat: process.platform, environment: ENV});
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, '{broken');
  const result = injectOrca({home, root, running: false, environment: ENV});
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing');
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});

test('reconcileOrca skips a missing orca config and never creates one', (t) => {
  const {home, root} = workspace(t);
  const result = reconcileOrca({home, root, running: false, environment: ENV, takeover: 'on'});
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'missing');
  assert.equal(result.changed, false);
  assert.equal(fs.existsSync(result.path), false);
});

test('reconcileOrca applies the stored intent when Orca is closed', (t) => {
  const {home, root} = workspace(t);
  installWrapper({root, home, environment: ENV});
  writeOrca(t, home, {settings: {agentCmdOverrides: {claude: '/opt/claude'}}});
  const on = reconcileOrca({home, root, running: false, environment: ENV, takeover: 'on'});
  assert.equal(on.ok, true);
  assert.equal(on.changed, true);
  assert.equal(on.injected, true);
  assert.equal(on.takeover, 'on');
  assert.equal(readOrcaData(on.path).settings.agentCmdOverrides.cursor, wrapperPathFor(root, home, process.platform, ENV));

  const off = reconcileOrca({home, root, running: false, environment: ENV, takeover: 'off'});
  assert.equal(off.ok, true);
  assert.equal(off.changed, true);
  assert.equal(off.injected, false);
  assert.equal(off.takeover, 'off');
  assert.equal(readOrcaData(off.path).settings.agentCmdOverrides.cursor, undefined);
});

test('reconcileOrca defers changes while Orca is running', (t) => {
  const {home, root} = workspace(t);
  installWrapper({root, home, environment: ENV});
  const file = writeOrca(t, home, {settings: {}});
  const on = reconcileOrca({home, root, running: true, environment: ENV, takeover: 'on'});
  assert.equal(on.ok, true);
  assert.equal(on.pending, 'running');
  assert.equal(readOrcaData(file).settings.agentCmdOverrides?.cursor, undefined);

  injectOrca({home, root, running: false, environment: ENV});
  const off = reconcileOrca({home, root, running: true, environment: ENV, takeover: 'off'});
  assert.equal(off.ok, true);
  assert.equal(off.pending, 'running');
  assert.equal(readOrcaData(file).settings.agentCmdOverrides.cursor, wrapperPathFor(root, home, process.platform, ENV));
});

test('reconcileOrca leaves a user-configured override alone', (t) => {
  const {home, root} = workspace(t);
  const file = writeOrca(t, home, {settings: {agentCmdOverrides: {cursor: '/usr/local/bin/my-cursor'}}});
  const result = reconcileOrca({home, root, running: false, environment: ENV, takeover: 'on'});
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'foreign-override');
  assert.equal(result.changed, false);
  assert.equal(readOrcaData(file).settings.agentCmdOverrides.cursor, '/usr/local/bin/my-cursor');
});

test('reconcileOrca never injects a wrapper that is not installed', (t) => {
  const {home, root} = workspace(t);
  const file = writeOrca(t, home, {settings: {}});
  const result = reconcileOrca({home, root, running: false, environment: ENV, takeover: 'on'});
  assert.equal(result.reason, 'wrapper-missing');
  assert.equal(result.changed, false);
  assert.equal(readOrcaData(file).settings.agentCmdOverrides, undefined);
});

test('orca identity follows the installed wrapper, not the caller PATH', {skip: process.platform === 'win32'}, (t) => {
  const {home, root} = workspace(t);
  const localBin = path.join(home, '.local', 'bin');
  const shellEnv = {PATH: [localBin, '/usr/bin', '/bin'].join(path.delimiter)};
  installWrapper({root, home, environment: shellEnv});
  const installed = path.join(localBin, 'cursor-agent-bridge');
  const file = writeOrca(t, home, {settings: {agentCmdOverrides: {cursor: installed}}});

  // The supervisor starts from launchd/systemd with a minimal PATH, so it
  // would name <root>/bin/... if identity were derived from PATH. The file on
  // disk must win: the same override is still recognised as ours.
  const minimal = {PATH: '/usr/bin:/bin'};
  const status = orcaStatus({home, root, environment: minimal, running: false, takeover: 'on'});
  assert.equal(status.injected, true);
  assert.equal(status.foreignOverride, false);
  assert.equal(status.wrapperInstalled, true);
  assert.equal(status.wrapper, installed);

  const off = reconcileOrca({home, root, environment: minimal, running: false, takeover: 'off'});
  assert.equal(off.changed, true);
  assert.equal(off.injected, false);
  assert.equal(readOrcaData(file).settings.agentCmdOverrides.cursor, undefined);

  const on = reconcileOrca({home, root, environment: minimal, running: false, takeover: 'on'});
  assert.equal(on.changed, true);
  assert.equal(readOrcaData(file).settings.agentCmdOverrides.cursor, installed);
});
