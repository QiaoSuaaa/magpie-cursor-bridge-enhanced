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
      plist: null,
      systemdUnit: null,
      autostart: startupEntryFor(plat, home, environment)
    };
  }
  if (plat === 'linux') {
    return {
      config: p.join(environment.XDG_CONFIG_HOME || p.join(home, '.config'), 'magpie-cursor-bridge'),
      share: p.join(environment.XDG_DATA_HOME || p.join(home, '.local', 'share'), 'magpie-cursor-bridge'),
      plist: null,
      systemdUnit: systemdUnitFor(home, plat, environment),
      autostart: systemdUnitFor(home, plat, environment)
    };
  }
  // macOS keeps the historical layout even when XDG_CONFIG_HOME is set:
  // existing installs and the Magpie plugin descriptor point here.
  const plist = p.join(home, 'Library', 'LaunchAgents', 'local.magpie.cursor-bridge.plist');
  return {
    config: p.join(home, '.config', 'magpie-cursor-bridge'),
    share: p.join(home, '.local', 'share', 'magpie-cursor-bridge'),
    plist,
    systemdUnit: null,
    autostart: plist
  };
}

// Linux keeps both the runtime and its autostart entry in one object: a
// systemd user unit. `systemctl --user enable` links it into default.target,
// and the same file is what the installer rewrites on upgrade.
export function systemdUnitFor(home, plat = platform, environment = process.env) {
  if (plat !== 'linux') return null;
  const p = join(plat);
  const config = environment.XDG_CONFIG_HOME || p.join(home, '.config');
  return p.join(config, 'systemd', 'user', `${serviceName}.service`);
}

// Windows has no user-level service manager that a normal account may write
// to: `schtasks /Create /SC ONLOGON` needs an elevated prompt, which the
// console's Start button cannot answer. A launcher script in the user's own
// Startup folder starts the supervisor at logon without any elevation, and
// the installer runs the same script once to start it now. macOS keeps its
// LaunchAgent plist; Linux uses a systemd user unit.
export function startupEntryFor(plat = platform, home = os.homedir(), environment = process.env) {
  const p = join(plat);
  if (plat === 'win32') {
    const roaming = environment.APPDATA || p.join(home, 'AppData', 'Roaming');
    return p.join(roaming, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', `${serviceName}.vbs`);
  }
  if (plat === 'darwin') return p.join(home, 'Library', 'LaunchAgents', `${serviceName}.plist`);
  if (plat === 'linux') return systemdUnitFor(home, plat, environment);
  return null;
}

export function magpieConfigDirFor(home, plat = platform, environment = process.env) {
  const p = join(plat);
  // Magpie itself keeps its files in <config-home>/magpie on every OS. On
  // Windows that is %USERPROFILE%\.config\magpie (`magpie data` reports it),
  // not %APPDATA%\magpie: reading the wrong directory made the installer miss
  // an existing registration and register a duplicate plugin. Fall back to
  // %APPDATA%\magpie only for a hypothetical build that writes there.
  if (plat === 'win32') {
    const natural = p.join(environment.XDG_CONFIG_HOME || p.join(home, '.config'), 'magpie');
    const roaming = p.join(environment.APPDATA || p.join(home, 'AppData', 'Roaming'), 'magpie');
    return !fs.existsSync(natural) && fs.existsSync(roaming) ? roaming : natural;
  }
  const base = environment.XDG_CONFIG_HOME || p.join(home, '.config');
  return p.join(base, 'magpie');
}

// Magpie's agent sandbox hides `process`, so agent-platform.js cannot tell it
// is on Windows and falls back to the historical `~/.config` path; Magpie then
// writes connection.json there. The supervisor keeps its state in %APPDATA%,
// so on Windows it has to look in both places. Elsewhere one path is enough.
export function connectionFilesFor(home, plat = platform, environment = process.env) {
  const p = join(plat);
  if (plat === 'win32') {
    const roaming = p.join(environment.APPDATA || p.join(home, 'AppData', 'Roaming'), 'magpie-cursor-bridge', 'connection.json');
    const fallback = p.join(home, '.config', 'magpie-cursor-bridge', 'connection.json');
    return [roaming, fallback];
  }
  if (plat === 'linux') {
    // Magpie's sandbox cannot read process.env, so agent-platform.js always
    // expands `~` and writes under ~/.config even when XDG_CONFIG_HOME points
    // elsewhere. That historical path therefore wins; the XDG one is only a
    // fallback for a profile that was moved there by hand.
    const historical = p.join(home, '.config', 'magpie-cursor-bridge', 'connection.json');
    const preferred = p.join(environment.XDG_CONFIG_HOME || p.join(home, '.config'), 'magpie-cursor-bridge', 'connection.json');
    return preferred === historical ? [historical] : [historical, preferred];
  }
  return [p.join(pathsFor(home, plat, environment).config, 'connection.json')];
}

// Cursor keeps its user-level files together: settings.json, the global
// key-value store (globalStorage/state.vscdb) and the per-workspace stores.
// One helper keeps those three paths from drifting apart across platforms.
export function cursorUserDirFor(home, plat = platform, environment = process.env) {
  const p = join(plat);
  if (plat === 'win32') {
    return p.join(environment.APPDATA || p.join(home, 'AppData', 'Roaming'), 'Cursor', 'User');
  }
  if (plat === 'linux') {
    return p.join(environment.XDG_CONFIG_HOME || p.join(home, '.config'), 'Cursor', 'User');
  }
  return p.join(home, 'Library', 'Application Support', 'Cursor', 'User');
}

export function cursorSettingsFor(home, plat = platform, environment = process.env) {
  return join(plat).join(cursorUserDirFor(home, plat, environment), 'settings.json');
}

// globalStorage/state.vscdb holds chats, messages and agent blobs; it grows
// with every conversation. workspaceStorage/<hash>/workspace.json maps a
// composer's workspaceId back to the project folder.
export function cursorGlobalStorageFor(home, plat = platform, environment = process.env) {
  return join(plat).join(cursorUserDirFor(home, plat, environment), 'globalStorage');
}

export function cursorWorkspaceStorageFor(home, plat = platform, environment = process.env) {
  return join(plat).join(cursorUserDirFor(home, plat, environment), 'workspaceStorage');
}

// Linux trust has two user-level homes and both need a path here:
//  - Cursor reads `certificate-authority` from <config-home>/Cursor/argv.json;
//  - Chromium falls back to the per-user NSS database in ~/.pki/nssdb, which
//    the installer updates with `certutil -A` when nss-tools is present.
export function cursorArgvFor(home, plat = platform, environment = process.env) {
  if (plat !== 'linux') return null;
  const p = join(plat);
  return p.join(environment.XDG_CONFIG_HOME || p.join(home, '.config'), 'Cursor', 'argv.json');
}

export function nssDatabaseFor(home, plat = platform) {
  if (plat !== 'linux') return null;
  return join(plat).join(home, '.pki', 'nssdb');
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

// Cursor ships its version in the Electron app package. macOS uses
// Contents/Resources/app, Windows/Linux use resources/app. A missing or
// malformed file is not fatal: the console simply shows "未检测到".
export function cursorVersionFrom(directory) {
  if (!directory) return null;
  for (const relative of ['Contents/Resources/app/package.json', 'resources/app/package.json']) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(directory, relative), 'utf8'));
      if (typeof manifest.version === 'string' && /^\d+\.\d+\.\d+/.test(manifest.version)) return manifest.version;
    } catch { /* try the next layout */ }
  }
  return null;
}

export function cursorVersionFor(home, plat = platform, environment = process.env) {
  return cursorVersionFrom(cursorDirFor(home, plat, environment));
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
  return findExecutable([
    p.join(home, '.local', 'bin', 'magpie'),
    '/usr/local/bin/magpie',
    '/usr/bin/magpie',
    '/opt/magpie/magpie',
    'magpie'
  ], {plat, environment});
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

// `systemctl --user` is the service owner on Linux. The probe only answers
// whether the binary exists; whether the user manager is reachable is decided
// by actually running it, because a container can ship systemctl without a
// running user instance.
export function systemctlFor({plat = platform, environment = process.env} = {}) {
  if (plat !== 'linux') return null;
  return findExecutable(['/usr/bin/systemctl', '/bin/systemctl', 'systemctl'], {plat, environment});
}

// The Windows Startup folder is the primary autostart location because it
// needs no elevation, but security software sometimes blocks scripts there.
// The per-user Run key is the fallback: same user, same no-elevation rule.
export const windowsRunKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

export function regExecutableFor({plat = platform, environment = process.env} = {}) {
  if (plat !== 'win32') return null;
  const p = join(plat);
  const systemRoot = environment.SystemRoot || environment.windir || 'C:\\Windows';
  return findExecutable([p.join(systemRoot, 'System32', 'reg.exe'), 'reg'], {plat, environment});
}

export function sqlite3For({plat = platform, environment = process.env} = {}) {
  if (plat === 'win32') return findExecutable(['sqlite3'], {plat, environment});
  return findExecutable(['/usr/bin/sqlite3', '/usr/local/bin/sqlite3', '/opt/homebrew/bin/sqlite3', 'sqlite3'], {plat, environment});
}

export function bashFor({plat = platform, environment = process.env} = {}) {
  if (plat === 'win32') return null;
  return findExecutable(['/bin/bash', '/usr/local/bin/bash', '/usr/bin/bash', 'bash'], {plat, environment});
}

// The service layer exists on macOS (LaunchAgent), Windows (hidden launcher in
// the user's Startup folder) and Linux (systemd user unit with a detached
// fallback when no user manager answers).
export const serviceSupported = IS_DARWIN || IS_WIN || IS_LINUX;

export const serviceName = 'local.magpie.cursor-bridge';

// The native engine ships per platform. Windows and Linux keep their binaries
// in per-architecture subfolders; macOS arm64 keeps the historical single-file
// layout so older packages stay readable, while Intel ships from bin/darwin-x64.
export function enginePathFor(source, plat = platform, arch = process.arch) {
  const p = join(plat);
  if (plat === 'win32') return p.join(source, 'bin', 'win32-x64', 'cursor-magpie-bridge.exe');
  if (plat === 'linux') return p.join(source, 'bin', `linux-${arch}`, 'cursor-magpie-bridge');
  if (plat === 'darwin' && arch === 'x64') return p.join(source, 'bin', 'darwin-x64', 'cursor-magpie-bridge');
  return p.join(source, 'bin', 'cursor-magpie-bridge');
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
  autostartEntry: (home = os.homedir()) => startupEntryFor(platform, home, process.env),
  systemdUnit: (home = os.homedir()) => systemdUnitFor(home),
  cursorSettings: (home = os.homedir()) => cursorSettingsFor(home),
  cursorGlobalStorage: (home = os.homedir()) => cursorGlobalStorageFor(home),
  cursorWorkspaceStorage: (home = os.homedir()) => cursorWorkspaceStorageFor(home),
  cursorArgv: (home = os.homedir()) => cursorArgvFor(home),
  nssDatabase: (home = os.homedir()) => nssDatabaseFor(home),
  connectionFiles: (home = os.homedir()) => connectionFilesFor(home),
  cursorDir: (home = os.homedir()) => cursorDirFor(home),
  cursorVersion: (home = os.homedir()) => cursorVersionFor(home),
  magpieExecutable: (home = os.homedir()) => magpieExecutableFor(home),
  processCommand: (pid) => processCommandFor(pid),
  openCommand: (target) => openCommandFor(target),
  systemctl: () => systemctlFor(),
  sqlite3: () => sqlite3For(),
  bash: () => bashFor(),
  reg: () => regExecutableFor(),
  serviceSupported
};

export default {
  platform,
  IS_DARWIN,
  IS_WIN,
  IS_LINUX,
  serviceSupported,
  serviceName,
  windowsRunKey,
  regExecutableFor,
  enginePathFor,
  runtimeNameFor,
  findExecutable,
  pathsFor,
  startupEntryFor,
  systemdUnitFor,
  magpieConfigDirFor,
  connectionFilesFor,
  cursorSettingsFor,
  cursorGlobalStorageFor,
  cursorWorkspaceStorageFor,
  cursorUserDirFor,
  cursorArgvFor,
  nssDatabaseFor,
  cursorDirFor,
  cursorVersionFrom,
  cursorVersionFor,
  magpieExecutableFor,
  processCommandFor,
  openCommandFor,
  systemctlFor,
  sqlite3For,
  bashFor,
  current
};
