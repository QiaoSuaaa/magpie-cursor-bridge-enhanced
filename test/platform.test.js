import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  pathsFor,
  systemdUnitFor,
  enginePathFor,
  magpieConfigDirFor,
  connectionFilesFor,
  cursorSettingsFor,
  cursorArgvFor,
  nssDatabaseFor,
  cursorDirFor,
  cursorVersionFrom,
  sqlite3For,
  bashFor
} from '../lib/platform.js';

const win = path.win32;

test('paths follow the macOS layout and keep XDG ignored there', () => {
  const layout = pathsFor('/Users/u', 'darwin', {XDG_CONFIG_HOME: '/xdg'});
  assert.equal(layout.config, path.posix.join('/Users/u', '.config', 'magpie-cursor-bridge'));
  assert.equal(layout.share, path.posix.join('/Users/u', '.local', 'share', 'magpie-cursor-bridge'));
  assert.equal(layout.plist, path.posix.join('/Users/u', 'Library', 'LaunchAgents', 'local.magpie.cursor-bridge.plist'));
});

test('paths follow XDG on linux', () => {
  const layout = pathsFor('/home/u', 'linux', {XDG_CONFIG_HOME: '/xdg/c', XDG_DATA_HOME: '/xdg/d'});
  assert.equal(layout.config, '/xdg/c/magpie-cursor-bridge');
  assert.equal(layout.share, '/xdg/d/magpie-cursor-bridge');
  assert.equal(layout.plist, null);
  assert.equal(layout.systemdUnit, '/xdg/c/systemd/user/local.magpie.cursor-bridge.service');
  assert.equal(layout.autostart, layout.systemdUnit);
  const fallback = pathsFor('/home/u', 'linux', {});
  assert.equal(fallback.config, path.posix.join('/home/u', '.config', 'magpie-cursor-bridge'));
  assert.equal(fallback.share, path.posix.join('/home/u', '.local', 'share', 'magpie-cursor-bridge'));
  assert.equal(fallback.systemdUnit, path.posix.join('/home/u', '.config', 'systemd', 'user', 'local.magpie.cursor-bridge.service'));
});

test('paths follow APPDATA on windows', () => {
  const environment = {
    APPDATA: win.join('C:', 'Users', 'u', 'AppData', 'Roaming'),
    LOCALAPPDATA: win.join('C:', 'Users', 'u', 'AppData', 'Local')
  };
  const layout = pathsFor(win.join('C:', 'Users', 'u'), 'win32', environment);
  assert.equal(layout.config, win.join(environment.APPDATA, 'magpie-cursor-bridge'));
  assert.equal(layout.share, win.join(environment.LOCALAPPDATA, 'magpie-cursor-bridge'));
  assert.equal(layout.plist, null);
  assert.equal(
    layout.autostart,
    win.join(environment.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'local.magpie.cursor-bridge.vbs')
  );
});

test('magpie config directory follows each platform', () => {
  assert.equal(magpieConfigDirFor('/Users/u', 'darwin', {}), path.posix.join('/Users/u', '.config', 'magpie'));
  assert.equal(magpieConfigDirFor('/home/u', 'linux', {XDG_CONFIG_HOME: '/xdg/c'}), '/xdg/c/magpie');
  // Magpie reports `~/.config/magpie` through `magpie data` on Windows too;
  // %APPDATA%\magpie is only honored when that directory already exists.
  assert.equal(
    magpieConfigDirFor(win.join('C:', 'Users', 'u'), 'win32', {APPDATA: win.join('C:', 'AppData', 'Roaming')}),
    win.join('C:', 'Users', 'u', '.config', 'magpie')
  );
});

test('autostart follows each platform service manager', () => {
  // Linux uses a systemd user unit as both the runtime definition and the
  // login entry; macOS keeps its LaunchAgent plist.
  assert.equal(
    pathsFor('/home/u', 'linux', {}).autostart,
    path.posix.join('/home/u', '.config', 'systemd', 'user', 'local.magpie.cursor-bridge.service')
  );
  assert.equal(
    pathsFor('/Users/u', 'darwin', {}).autostart,
    path.posix.join('/Users/u', 'Library', 'LaunchAgents', 'local.magpie.cursor-bridge.plist')
  );
});

test('engine payload follows each platform architecture', () => {
  assert.equal(enginePathFor('/pkg', 'linux', 'x64'), '/pkg/bin/linux-x64/cursor-magpie-bridge');
  assert.equal(enginePathFor('/pkg', 'linux', 'arm64'), '/pkg/bin/linux-arm64/cursor-magpie-bridge');
  // macOS arm64 keeps the historical single-file path; Intel ships beside it.
  assert.equal(enginePathFor('/pkg', 'darwin', 'arm64'), '/pkg/bin/cursor-magpie-bridge');
  assert.equal(enginePathFor('/pkg', 'darwin', 'x64'), '/pkg/bin/darwin-x64/cursor-magpie-bridge');
  assert.equal(enginePathFor('/pkg', 'win32'), win.join('/pkg', 'bin', 'win32-x64', 'cursor-magpie-bridge.exe'));
  assert.equal(systemdUnitFor('/home/u', 'linux', {XDG_CONFIG_HOME: '/xdg/c'}), '/xdg/c/systemd/user/local.magpie.cursor-bridge.service');
  assert.equal(systemdUnitFor('/Users/u', 'darwin', {}), null);
});

test('linux certificate trust lives entirely in the user profile', () => {
  assert.equal(cursorArgvFor('/home/u', 'linux', {}), path.posix.join('/home/u', '.config', 'Cursor', 'argv.json'));
  assert.equal(cursorArgvFor('/home/u', 'linux', {XDG_CONFIG_HOME: '/xdg/c'}), '/xdg/c/Cursor/argv.json');
  assert.equal(cursorArgvFor('/Users/u', 'darwin', {}), null);
  assert.equal(nssDatabaseFor('/home/u', 'linux'), path.posix.join('/home/u', '.pki', 'nssdb'));
  assert.equal(nssDatabaseFor('/Users/u', 'darwin'), null);
});

test('windows connection lookup also reads the agent sandbox fallback', () => {
  const home = win.join('C:', 'Users', 'u');
  const environment = {APPDATA: win.join('C:', 'Users', 'u', 'AppData', 'Roaming')};
  assert.deepEqual(connectionFilesFor(home, 'win32', environment), [
    win.join(environment.APPDATA, 'magpie-cursor-bridge', 'connection.json'),
    win.join(home, '.config', 'magpie-cursor-bridge', 'connection.json')
  ]);
  assert.deepEqual(
    connectionFilesFor('/Users/u', 'darwin', {}),
    [path.posix.join('/Users/u', '.config', 'magpie-cursor-bridge', 'connection.json')]
  );
  // Magpie's sandbox always expands ~ and writes under ~/.config, so that
  // historical path wins; XDG is only a fallback for a moved profile.
  assert.deepEqual(
    connectionFilesFor('/home/u', 'linux', {XDG_CONFIG_HOME: '/xdg/c'}),
    ['/home/u/.config/magpie-cursor-bridge/connection.json', '/xdg/c/magpie-cursor-bridge/connection.json']
  );
  assert.deepEqual(
    connectionFilesFor('/home/u', 'linux', {}),
    ['/home/u/.config/magpie-cursor-bridge/connection.json']
  );
});

test('cursor settings and install directory follow each platform', () => {
  assert.equal(
    cursorSettingsFor('/Users/u', 'darwin', {}),
    path.posix.join('/Users/u', 'Library', 'Application Support', 'Cursor', 'User', 'settings.json')
  );
  assert.equal(
    cursorSettingsFor('/home/u', 'linux', {XDG_CONFIG_HOME: '/xdg/c'}),
    '/xdg/c/Cursor/User/settings.json'
  );
  assert.equal(
    cursorSettingsFor(win.join('C:', 'Users', 'u'), 'win32', {APPDATA: win.join('C:', 'Roaming')}),
    win.join('C:', 'Roaming', 'Cursor', 'User', 'settings.json')
  );
  assert.equal(cursorDirFor('/Users/u', 'darwin', {}), '/Applications/Cursor.app');
  assert.equal(
    cursorDirFor(win.join('C:', 'Users', 'u'), 'win32', {LOCALAPPDATA: win.join('C:', 'Local')}),
    win.join('C:', 'Local', 'Programs', 'cursor')
  );
  assert.equal(cursorDirFor('/home/u', 'linux', {}), 'cursor');
});

test('cursor version is read from the macOS and Windows/Linux layouts', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-bridge-version-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const mac = path.join(dir, 'Cursor.app');
  fs.mkdirSync(path.join(mac, 'Contents', 'Resources', 'app'), {recursive: true});
  fs.writeFileSync(path.join(mac, 'Contents', 'Resources', 'app', 'package.json'), JSON.stringify({version: '3.30.20'}));
  assert.equal(cursorVersionFrom(mac), '3.30.20');
  const flat = path.join(dir, 'cursor');
  fs.mkdirSync(path.join(flat, 'resources', 'app'), {recursive: true});
  fs.writeFileSync(path.join(flat, 'resources', 'app', 'package.json'), JSON.stringify({version: '3.29.1'}));
  assert.equal(cursorVersionFrom(flat), '3.29.1');
  assert.equal(cursorVersionFrom(path.join(dir, 'missing')), null);
});

test('capability probes stay null when the platform cannot provide them', () => {
  const empty = {PATH: '', PATHEXT: '.EXE'};
  assert.equal(sqlite3For({plat: 'win32', environment: empty}), null);
  assert.equal(bashFor({plat: 'win32', environment: empty}), null);
});
