import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Every OS-specific path and command lives here. The rest of the code asks
// this module instead of spelling out /usr/bin/open, %APPDATA% or
// Library/LaunchAgents, so a platform that lacks a capability gets one clear
// answer instead of a ENOENT halfway through an action.
//
// The *For() helpers take platform and environment explicitly so tests can
// cover all three layouts on any host; the exported constants bind them to
// the machine this process actually runs on.
export const platform = process.platform;
export const IS_DARWIN = platform === 'darwin';
export const IS_WIN = platform === 'win32';
export const IS_LINUX = platform === 'linux';

const join = (plat) => (plat === 'win32' ? path.win32 : path.posix);
const exts = (environment, plat) => plat === 'win32'
  ? String(environment.PATHEXT || '.EXE;.CMD;.BAT').split(';').map((ext) => ext.toLowerCase()).filter(Boolean)
  : [''];

function executable(name, {plat = platform, environment = process.env} = {}) {
  const p = join(plat);
  if (p.isAbsolute(name)) {
    try { return fs.statSync(name).isFile() ? name : null; } catch { return null; }
  }
  const dirs = String(environment.PATH || environment.Path || '').split(p.delimiter).filter(Boolean);
  const suffixes = exts(environment, plat);
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const candidate = p.join(dir, name + suffix);
      try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* keep looking */ }
    }
  }
  return null;
}

// Candidate order matters: prefer a well-known absolute path, then PATH.
export function findExecutable(names, options = {}) {
  for (const name of names) {
    const found = executable(name, options);
    if (found) return found;
  }
  return null;
}

export function pathsFor(home, plat = platform, environment = process.env) {
  const p = join(plat);
  if (plat === 'win32') {
    const roaming = environment.APPDATA || p.join(home, 'AppData', 'Roaming');
    const local = environment.LOCALAPPDATA || p.join(home, 'AppData', 'Local');
    const config = p.join(roaming, 'magpie-cursor-bridge');
    // Older builds wrote under the POSIX home (~/.config). Keep reading that
    // directory when it already holds the bridge state instead of silently
    // presenting an empty installation.
    const legacy = p.join(home, '.config', 'magpie-cursor-bridge');
    const configDir = !fs.existsSync(config) && fs.existsSync(legacy) ? legacy : config;
    return {
      config: configDir,
      share: p.join(local, 'magpie-cursor-bridge'),
      plist: null
    };
  }
  if (plat === 'linux') {
    return {
      config: p.join(environment.XDG_CONFIG_HOME || p.join(home, '.config'), 'magpie-cursor-bridge'),
      share: p.join(environment.XDG_DATA_HOME || p.join(home, '.local', 'share'), 'magpie-cursor-bridge'),
      plist: null
    };
  }
  // macOS keeps the historical layout even when XDG_CONFIG_HOME is set:
  // existing installs and the Magpie plugin descriptor point here.
  return {
    config: p.join(home, '.config', 'magpie-cursor-bridge'),
    share: p.join(home, '.local', 'share', 'magpie-cursor-bridge'),
    plist: p.join(home, 'Library', 'LaunchAgents', 'local.magpie.cursor-bridge.plist')
  };
}

export function magpieConfigDirFor(home, plat = platform, environment = process.env) {
  const p = join(plat);
  const base = plat === 'win32'
    ? (environment.APPDATA || p.join(home, 'AppData', 'Roaming'))
    : (environment.XDG_CONFIG_HOME || p.join(home, '.config'));
  return p.join(base, 'magpie');
}

export function cursorSettingsFor(home, plat = platform, environment = process.env) {
  const p = join(plat);
  if (plat === 'win32') {
    return p.join(environment.APPDATA || p.join(home, 'AppData', 'Roaming'), 'Cursor', 'User', 'settings.json');
  }
  if (plat === 'linux') {
    return p.join(environment.XDG_CONFIG_HOME || p.join(home, '.config'), 'Cursor', 'User', 'settings.json');
  }
  return p.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'settings.json');
}

export function cursorDirFor(home, plat = platform, environment = process.env) {
  const p = join(plat);
  if (plat === 'win32') {
    const local = environment.LOCALAPPDATA || p.join(home, 'AppData', 'Local');
    for (const candidate of [p.join(local, 'Programs', 'cursor'), p.join(local, 'Programs', 'Cursor')]) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return p.join(local, 'Programs', 'cursor');
  }
  if (plat === 'linux') {
    for (const candidate of ['/usr/share/cursor', '/opt/cursor', '/opt/Cursor']) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return 'cursor';
  }
  return '/Applications/Cursor.app';
}

export function magpieExecutableFor(home, plat = platform, environment = process.env) {
  const p = join(plat);
  if (plat === 'darwin') return '/Applications/magpie.app/Contents/MacOS/magpie';
  if (plat === 'win32') {
    const local = environment.LOCALAPPDATA || p.join(home, 'AppData', 'Local');
    for (const candidate of [p.join(local, 'Programs', 'magpie', 'magpie.exe'), p.join(local, 'magpie', 'magpie.exe')]) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return executable('magpie', {plat, environment});
  }
  return findExecutable(['/usr/bin/magpie', '/opt/magpie/magpie', 'magpie'], {plat, environment});
}

// Returns the argv prefix that prints a process command line, or null when
// the platform has no supported probe.
export function processCommandFor(pid, {plat = platform, environment = process.env} = {}) {
  if (plat === 'win32') {
    const powershell = findExecutable(['powershell', 'pwsh'], {plat, environment});
    if (!powershell) return null;
    return {
      command: powershell,
      args: ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId = ${Number(pid)}").CommandLine`]
    };
  }
  const ps = findExecutable(['/bin/ps', '/usr/bin/ps', 'ps'], {plat, environment});
  if (!ps) return null;
  return {command: ps, args: ['-p', String(pid), '-o', 'command=']};
}

export function openCommandFor(target, {plat = platform, environment = process.env} = {}) {
  if (plat === 'win32') return {command: 'explorer.exe', args: [target]};
  if (plat === 'linux') {
    const opener = findExecutable(['xdg-open', 'gio'], {plat, environment});
    if (!opener) return null;
    return opener.endsWith('gio') ? {command: opener, args: ['open', target]} : {command: opener, args: [target]};
  }
  const opener = findExecutable(['/usr/bin/open', 'open'], {plat, environment});
  return opener ? {command: opener, args: [target]} : null;
}

export function sqlite3For({plat = platform, environment = process.env} = {}) {
  if (plat === 'win32') return findExecutable(['sqlite3'], {plat, environment});
  return findExecutable(['/usr/bin/sqlite3', '/usr/local/bin/sqlite3', '/opt/homebrew/bin/sqlite3', 'sqlite3'], {plat, environment});
}

export function bashFor({plat = platform, environment = process.env} = {}) {
  if (plat === 'win32') return null;
  return findExecutable(['/bin/bash', '/usr/local/bin/bash', '/usr/bin/bash', 'bash'], {plat, environment});
}

// The service layer exists on macOS (LaunchAgent) and Windows (scheduled
// task). Linux still has no supported service manager here.
export const serviceSupported = IS_DARWIN || IS_WIN;

export const serviceName = 'local.magpie.cursor-bridge';

// The native engine ships per platform; Windows keeps its PE in a subfolder
// so both files can live in one payload without name clashes.
export function enginePathFor(source, plat = platform) {
  const p = join(plat);
  return plat === 'win32'
    ? p.join(source, 'bin', 'win32-x64', 'cursor-magpie-bridge.exe')
    : p.join(source, 'bin', 'cursor-magpie-bridge');
}

export function runtimeNameFor(plat = platform) {
  return plat === 'win32' ? 'runtime.exe' : 'runtime';
}

export const current = {
  platform,
  serviceName,
  enginePath: (source) => enginePathFor(source),
  runtimeName: () => runtimeNameFor(),
  paths: (home = os.homedir()) => pathsFor(home),
  magpieConfigDir: (home = os.homedir()) => magpieConfigDirFor(home),
  cursorSettings: (home = os.homedir()) => cursorSettingsFor(home),
  cursorDir: (home = os.homedir()) => cursorDirFor(home),
  magpieExecutable: (home = os.homedir()) => magpieExecutableFor(home),
  processCommand: (pid) => processCommandFor(pid),
  openCommand: (target) => openCommandFor(target),
  sqlite3: () => sqlite3For(),
  bash: () => bashFor(),
  serviceSupported
};

export default {
  platform,
  IS_DARWIN,
  IS_WIN,
  IS_LINUX,
  serviceSupported,
  serviceName,
  enginePathFor,
  runtimeNameFor,
  findExecutable,
  pathsFor,
  magpieConfigDirFor,
  cursorSettingsFor,
  cursorDirFor,
  magpieExecutableFor,
  processCommandFor,
  openCommandFor,
  sqlite3For,
  bashFor,
  current
};
