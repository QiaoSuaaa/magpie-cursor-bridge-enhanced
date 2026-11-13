import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  pathsFor,
  magpieConfigDirFor,
  connectionFilesFor,
  cursorSettingsFor,
  cursorDirFor,
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
  const fallback = pathsFor('/home/u', 'linux', {});
  assert.equal(fallback.config, path.posix.join('/home/u', '.config', 'magpie-cursor-bridge'));
  assert.equal(fallback.share, path.posix.join('/home/u', '.local', 'share', 'magpie-cursor-bridge'));
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

test('windows autostart uses the per-user Startup folder', () => {
  assert.equal(pathsFor('/home/u', 'linux', {}).autostart, null);
  assert.equal(
    pathsFor('/Users/u', 'darwin', {}).autostart,
    path.posix.join('/Users/u', 'Library', 'LaunchAgents', 'local.magpie.cursor-bridge.plist')
  );
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
  assert.deepEqual(
    connectionFilesFor('/home/u', 'linux', {XDG_CONFIG_HOME: '/xdg/c'}),
    ['/xdg/c/magpie-cursor-bridge/connection.json']
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

test('capability probes stay null when the platform cannot provide them', () => {
  const empty = {PATH: '', PATHEXT: '.EXE'};
  assert.equal(sqlite3For({plat: 'win32', environment: empty}), null);
  assert.equal(bashFor({plat: 'win32', environment: empty}), null);
});
