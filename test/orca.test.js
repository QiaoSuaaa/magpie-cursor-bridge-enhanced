import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {orcaDataPathFor, orcaStatus, injectOrca, removeOrca, readOrcaData} from '../lib/orca.js';
import {wrapperPathFor} from '../lib/cursor-agent.js';

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
