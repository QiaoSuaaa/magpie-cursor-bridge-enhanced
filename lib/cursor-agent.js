import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import platform from './platform.js';
import {cursorAgentCompatibility} from './compatibility.js';

// cursor-agent is the CLI sibling of the Cursor IDE. It does not read the IDE's
// settings.json, so the bridge cannot route it with http.proxy; the only
// injection point is the HTTPS_PROXY environment variable. This module owns the
// two artifacts that make that injection durable:
//
//   agent-env        a tiny shell/CMD file the supervisor rewrites whenever the
//                    proxy port changes (and removes when the bridge stops);
//   cursor-agent-bridge
//                    a wrapper that sources agent-env and then execs the real
//                    cursor-agent. The official binary is never modified, so an
//                    upgrade or `cursor-agent login` keeps working unchanged.
//
// The wrapper name is deliberately different from `cursor-agent`: exec-ing the
// same name would resolve to the wrapper again and recurse.
export const ENV_FILE = 'agent-env';
export const ENV_FILE_WIN = 'agent-env.cmd';
export const WRAPPER_NAME = 'cursor-agent-bridge';
export const ENTRY_NAME = 'cursor-agent';
export const ENTRY_BACKUP = 'cursor-agent-official';
// Only files that carry this marker are ever overwritten or deleted.
export const MARKER = '# Managed by Cursor Bridge';
// Shell hooks use their own begin/end markers so the block can be replaced or
// removed without touching anything else in the user's rc file.
export const HOOK_BEGIN = '# >>> cursor-bridge >>>';
export const HOOK_END = '# <<< cursor-bridge <<<';

const joinFor = (plat) => (plat === 'win32' ? path.win32 : path.posix);
const isWin = (plat) => plat === 'win32';

function quotePosix(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function envFileFor(root, plat = platform.platform) {
  return joinFor(plat).join(root, isWin(plat) ? ENV_FILE_WIN : ENV_FILE);
}

// A POSIX env file is sourced by the wrapper; a Windows one is CALLed. Both
// only export what the supervisor actually knows: writing NODE_EXTRA_CA_CERTS
// before the CA exists would make Node refuse to start at all.
export function envText({proxy, caPath} = {}, plat = platform.platform) {
  const lines = [];
  if (!proxy) return '';
  if (isWin(plat)) {
    lines.push(`set "HTTPS_PROXY=${proxy}"`);
    if (caPath) lines.push(`set "NODE_EXTRA_CA_CERTS=${caPath}"`);
  } else {
    lines.push(`export HTTPS_PROXY=${quotePosix(proxy)}`);
    if (caPath) lines.push(`export NODE_EXTRA_CA_CERTS=${quotePosix(caPath)}`);
  }
  return `${lines.join('\n')}\n`;
}

export function writeAgentEnv(root, {proxy, caPath} = {}, plat = platform.platform) {
  const file = envFileFor(root, plat);
  const text = envText({proxy, caPath}, plat);
  if (!text) {
    removeAgentEnv(root, plat);
    return null;
  }
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  fs.writeFileSync(file, text, {mode: 0o600});
  try { fs.chmodSync(file, 0o600); } catch { /* best effort outside POSIX */ }
  return file;
}

export function removeAgentEnv(root, plat = platform.platform) {
  try { fs.rmSync(envFileFor(root, plat), {force: true}); } catch { /* already gone */ }
}

// The wrapper is generated at runtime rather than shipped: stage() excludes
// bin/ from the release payload, and the env file path belongs to the install
// root, which is only known once the supervisor is running.
export function wrapperDirFor(root, home = os.homedir(), plat = platform.platform, environment = process.env) {
  const p = joinFor(plat);
  if (isWin(plat)) return p.join(root, 'bin');
  // ~/.local/bin is the convention both Cursor and most CLI installers use;
  // only prefer it when it is already on PATH, otherwise the link would be
  // invisible to the user's shell.
  const localBin = p.join(home, '.local', 'bin');
  const dirs = String(environment.PATH || '').split(p.delimiter).map((dir) => p.normalize(dir)).filter(Boolean);
  return dirs.includes(p.normalize(localBin)) ? localBin : p.join(root, 'bin');
}

export function wrapperPathFor(root, home = os.homedir(), plat = platform.platform, environment = process.env) {
  const p = joinFor(plat);
  return p.join(wrapperDirFor(root, home, plat, environment), isWin(plat) ? `${WRAPPER_NAME}.cmd` : WRAPPER_NAME);
}

function samePath(left, right, plat) {
  const p = joinFor(plat);
  const a = p.normalize(String(left || ''));
  const b = p.normalize(String(right || ''));
  return isWin(plat) ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// setup decides where to install the wrapper from the PATH it inherits, while
// launchd/systemd and Magpie start with a minimal PATH. The same bridge can
// therefore compute different wrapper paths in different processes, so
// identity must come from the files on disk, not from the caller's PATH.
export function wrapperCandidatesFor(root, home = os.homedir(), plat = platform.platform) {
  const p = joinFor(plat);
  if (isWin(plat)) return [p.join(root, 'bin', `${WRAPPER_NAME}.cmd`)];
  return [
    p.join(home, '.local', 'bin', WRAPPER_NAME),
    p.join(root, 'bin', WRAPPER_NAME)
  ];
}

export function installedWrapperFor(root, home = os.homedir(), plat = platform.platform) {
  return wrapperCandidatesFor(root, home, plat).find((candidate) => readMarker(candidate)) || null;
}

// A path counts as ours when the file carries the marker, or when the file is
// gone but sits where setup installs it (another caller may name the other
// candidate). A file the user created themselves is never ours.
export function isBridgeWrapper(file, {root, home = os.homedir(), plat = platform.platform} = {}) {
  if (!file || typeof file !== 'string') return false;
  if (readMarker(file)) return true;
  try { fs.statSync(file); return false; } catch { /* missing file */ }
  return wrapperCandidatesFor(root, home, plat).some((candidate) => samePath(candidate, file, plat));
}

export function wrapperText({root, plat = platform.platform}) {
  const envFile = envFileFor(root, plat);
  if (isWin(plat)) {
    // CRLF keeps cmd.exe from mis-parsing the marker comment.
    return `@echo off\r\nrem ${MARKER.slice(2)}\r\nif exist "${envFile}" call "${envFile}"\r\ncursor-agent %*\r\n`;
  }
  return `#!/bin/sh\n${MARKER}\nENV_FILE=${quotePosix(envFile)}\n[ -f "$ENV_FILE" ] && . "$ENV_FILE"\nexec cursor-agent "$@"\n`;
}

function readMarker(file) {
  try { return fs.readFileSync(file, 'utf8').includes(MARKER); } catch { return false; }
}

// A same-name shell function is the only way to make plain `cursor-agent`
// pick up the proxy without replacing the official binary: `command
// cursor-agent` bypasses the function and calls the real executable. It only
// applies to interactive shells, which is exactly where a user types the CLI;
// scripts and IDE integrations keep their own environment.
export function shellConfigFor({home = os.homedir(), plat = platform.platform, environment = process.env} = {}) {
  if (isWin(plat)) return null;
  const p = joinFor(plat);
  const shell = String(environment.SHELL || '');
  if (shell.endsWith('/bash')) return p.join(home, '.bashrc');
  // fish has different function syntax; do not write a POSIX block into it.
  if (shell.endsWith('/fish')) return null;
  const dir = environment.ZDOTDIR ? p.join(environment.ZDOTDIR) : home;
  const zshrc = p.join(dir, '.zshrc');
  // setup also runs from a service/launcher where SHELL is unset; prefer an
  // rc file that already exists instead of creating a zshrc for a bash user.
  if (!shell) {
    const bashrc = p.join(home, '.bashrc');
    try { if (!fs.existsSync(zshrc) && fs.existsSync(bashrc)) return bashrc; } catch { /* fall through */ }
  }
  return zshrc;
}

export function shellHookText({root, home = os.homedir(), plat = platform.platform, environment = process.env} = {}) {
  const envFile = envFileFor(root, plat);
  return [
    HOOK_BEGIN,
    '# Managed by Cursor Bridge: route cursor-agent through the local bridge.',
    'cursor-agent() {',
    `  ENV_FILE=${quotePosix(envFile)}`,
    '  [ -f "$ENV_FILE" ] && . "$ENV_FILE"',
    '  command cursor-agent "$@"',
    '}',
    HOOK_END
  ].join('\n');
}

function withoutHook(text) {
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`\\n?${escape(HOOK_BEGIN)}[\\s\\S]*?${escape(HOOK_END)}\\n?`, 'g');
  return text.replace(pattern, '\n');
}

export function shellHookStatus({home = os.homedir(), plat = platform.platform, environment = process.env, file = null} = {}) {
  const target = file || shellConfigFor({home, plat, environment});
  if (!target) return {supported: false, path: null, installed: false};
  let installed = false;
  try { installed = fs.readFileSync(target, 'utf8').includes(HOOK_BEGIN); } catch { /* rc file may not exist yet */ }
  return {supported: true, path: target, installed};
}

export function installShellHook({root, home = os.homedir(), plat = platform.platform, environment = process.env, file = null} = {}) {
  const target = file || shellConfigFor({home, plat, environment});
  if (!target) return {supported: false, path: null, installed: false};
  let current = '';
  try { current = fs.readFileSync(target, 'utf8'); } catch { /* create it below */ }
  // Replacing an existing block makes the switch idempotent and lets an
  // upgrade refresh the env path without duplicating the function.
  const base = withoutHook(current).replace(/\n+$/, '');
  const next = `${base ? `${base}\n\n` : ''}${shellHookText({root, plat, environment})}\n`;
  fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.writeFileSync(target, next, {mode: 0o644});
  return {supported: true, path: target, installed: true, changed: next !== current};
}

export function removeShellHook({home = os.homedir(), plat = platform.platform, environment = process.env, file = null} = {}) {
  const target = file || shellConfigFor({home, plat, environment});
  if (!target) return {supported: false, path: null, removed: false};
  let current;
  try { current = fs.readFileSync(target, 'utf8'); } catch { return {supported: true, path: target, removed: false}; }
  if (!current.includes(HOOK_BEGIN)) return {supported: true, path: target, removed: false};
  const next = withoutHook(current).replace(/\n{3,}/g, '\n\n');
  fs.writeFileSync(target, next, {mode: 0o644});
  return {supported: true, path: target, removed: true};
}

// Some launchers (notably Orca's chat) spawn the CLI by its bare name and
// ignore every per-agent setting, so the only reliable injection point is the
// PATH entry itself. Replacing ~/.local/bin/cursor-agent keeps the official
// executable untouched: it is renamed to cursor-agent-official and the wrapper
// execs it after loading agent-env. A CLI self-update recreates the symlink,
// which setup detects and repairs by running installEntry again.
export function entryPathsFor({home = os.homedir(), plat = platform.platform, environment = process.env} = {}) {
  if (isWin(plat)) return null;
  const p = joinFor(plat);
  const dir = p.join(home, '.local', 'bin');
  return {dir, entry: p.join(dir, ENTRY_NAME), backup: p.join(dir, ENTRY_BACKUP)};
}

export function entryWrapperText({root, plat = platform.platform}) {
  const envFile = envFileFor(root, plat);
  return [
    '#!/bin/sh',
    MARKER,
    `ENV_FILE=${quotePosix(envFile)}`,
    '[ -f "$ENV_FILE" ] && . "$ENV_FILE"',
    'OFFICIAL="$(dirname "$0")/cursor-agent-official"',
    '[ -x "$OFFICIAL" ] || OFFICIAL=cursor-agent',
    'exec "$OFFICIAL" "$@"'
  ].join('\n') + '\n';
}

function entryIsWrapper(file) {
  try { return fs.readFileSync(file, 'utf8').includes(MARKER); } catch { return false; }
}

export function entryStatus({home = os.homedir(), plat = platform.platform, environment = process.env} = {}) {
  const paths = entryPathsFor({home, plat, environment});
  if (!paths) return {supported: false, installed: false, entry: null, backup: null};
  return {
    supported: true,
    entry: paths.entry,
    backup: paths.backup,
    installed: entryIsWrapper(paths.entry),
    entryPresent: fs.existsSync(paths.entry),
    officialPresent: fs.existsSync(paths.backup)
  };
}

export function installEntry({root, home = os.homedir(), plat = platform.platform, environment = process.env} = {}) {
  const paths = entryPathsFor({home, plat, environment});
  if (!paths) return {supported: false, installed: false};
  const {entry, backup} = paths;
  if (!fs.existsSync(entry)) {
    // There is nothing to intercept: the CLI is not installed in the
    // conventional location, or a previous install already moved it.
    return {supported: true, installed: false, reason: 'missing', path: entry};
  }
  if (entryIsWrapper(entry)) {
    return {supported: true, installed: true, path: entry, backup, changed: false, officialPresent: fs.existsSync(backup)};
  }
  // The entry is the official launcher (usually a symlink into the versioned
  // install). Move it aside so the wrapper can take its name.
  if (fs.existsSync(backup)) fs.rmSync(backup, {force: true});
  fs.renameSync(entry, backup);
  fs.writeFileSync(entry, entryWrapperText({root, plat}), {mode: 0o755});
  try { fs.chmodSync(entry, 0o755); } catch { /* best effort */ }
  return {supported: true, installed: true, path: entry, backup, changed: true, officialPresent: true};
}

export function removeEntry({home = os.homedir(), plat = platform.platform, environment = process.env} = {}) {
  const paths = entryPathsFor({home, plat, environment});
  if (!paths) return {supported: false, removed: false};
  const {entry, backup} = paths;
  if (!entryIsWrapper(entry)) return {supported: true, removed: false, path: entry};
  if (!fs.existsSync(backup)) return {supported: true, removed: false, path: entry, reason: 'missing-backup'};
  fs.rmSync(entry, {force: true});
  fs.renameSync(backup, entry);
  return {supported: true, removed: true, path: entry};
}

export function installWrapper({root, home = os.homedir(), plat = platform.platform, environment = process.env} = {}) {
  const target = wrapperPathFor(root, home, plat, environment);
  if (fs.existsSync(target) && !readMarker(target)) {
    throw new Error(`已存在同名文件且不是桥接生成的：${target}`);
  }
  fs.mkdirSync(path.dirname(target), {recursive: true, mode: 0o700});
  fs.writeFileSync(target, wrapperText({root, plat}), {mode: 0o755});
  if (!isWin(plat)) {
    try { fs.chmodSync(target, 0o755); } catch { /* best effort */ }
  }
  const dirs = String(environment.PATH || '').split(joinFor(plat).delimiter)
    .map((dir) => joinFor(plat).normalize(dir)).filter(Boolean);
  return {path: target, onPath: dirs.includes(joinFor(plat).normalize(path.dirname(target)))};
}

export function removeWrapper({root, home = os.homedir(), plat = platform.platform, environment = process.env} = {}) {
  const target = wrapperPathFor(root, home, plat, environment);
  // A file the user created themselves must survive uninstall untouched.
  if (!readMarker(target)) return {removed: false, path: target};
  try {
    fs.rmSync(target, {force: true});
    return {removed: true, path: target};
  } catch {
    return {removed: false, path: target};
  }
}

// Cursor's installer links `cursor-agent` into ~/.local/bin, but a custom or
// portable install may only have the versioned directory. PATH wins; the
// versioned fallback keeps a fresh login shell working.
export function agentExecutable({home = os.homedir(), plat = platform.platform, environment = process.env} = {}) {
  const found = platform.findExecutable(isWin(plat) ? ['cursor-agent.exe', 'cursor-agent.cmd', 'cursor-agent'] : ['cursor-agent'], {plat, environment});
  if (found) return found;
  const p = joinFor(plat);
  const versions = p.join(home, '.local', 'share', 'cursor-agent', 'versions');
  try {
    const entries = fs.readdirSync(versions)
      .filter((name) => /^\d{4}\.\d{2}\.\d{2}/.test(name))
      .sort()
      .reverse();
    for (const name of entries) {
      const candidate = p.join(versions, name, isWin(plat) ? 'cursor-agent.exe' : 'cursor-agent');
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch { /* no versioned install */ }
  return null;
}

// --version starts a full Node process (~1 s), and the console polls status
// every few seconds, so the answer is cached briefly.
let versionCache = {key: '', at: 0, value: null};
export function agentVersion(executable, {timeout = 8000} = {}) {
  if (!executable) return null;
  if (versionCache.key === executable && Date.now() - versionCache.at < 60000) return versionCache.value;
  let value = null;
  try {
    const result = spawnSync(executable, ['--version'], {encoding: 'utf8', timeout, windowsHide: true});
    const text = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
    const match = text.match(/\d{4}\.\d{2}\.\d{2}(?:-[0-9a-z]+)?/i);
    value = match ? match[0] : (text ? text.split(/\s+/)[0] : null);
  } catch { /* report "not detected" instead of failing the console */ }
  versionCache = {key: executable, at: Date.now(), value};
  return value;
}

function shellCommand({proxy, caPath, plat}) {
  if (!proxy) return '';
  if (isWin(plat)) {
    return `set "HTTPS_PROXY=${proxy}"${caPath ? ` && set "NODE_EXTRA_CA_CERTS=${caPath}"` : ''} && cursor-agent`;
  }
  return `HTTPS_PROXY=${quotePosix(proxy)}${caPath ? ` NODE_EXTRA_CA_CERTS=${quotePosix(caPath)}` : ''} cursor-agent`;
}

export function agentStatus({root, home = os.homedir(), plat = platform.platform, environment = process.env, proxy = null, caPath = null} = {}) {
  const executable = agentExecutable({home, plat, environment});
  const version = agentVersion(executable);
  const compatibility = cursorAgentCompatibility(version);
  const envFile = envFileFor(root, plat);
  // Report the wrapper that actually exists; another process may have
  // installed it under a candidate this process' PATH would not choose.
  const installedWrapper = installedWrapperFor(root, home, plat);
  const wrapperFile = installedWrapper || wrapperPathFor(root, home, plat, environment);
  const wrapperInstalled = !!installedWrapper;
  let envReady = false;
  try { envReady = fs.statSync(envFile).size > 0; } catch { /* bridge stopped */ }
  const p = joinFor(plat);
  const dirs = String(environment.PATH || '').split(p.delimiter).map((dir) => p.normalize(dir)).filter(Boolean);
  return {
    installed: !!executable,
    executable,
    version,
    compatibility,
    envFile,
    envReady,
    proxy,
    caPath,
    wrapperFile,
    wrapperInstalled,
    wrapperOnPath: wrapperInstalled && dirs.includes(p.normalize(path.dirname(wrapperFile))),
    // Shown verbatim in the console: the wrapper when present, otherwise the
    // one-off environment prefix so a user can try it before installing.
    command: wrapperInstalled ? WRAPPER_NAME : shellCommand({proxy, caPath, plat}),
    oneShot: shellCommand({proxy, caPath, plat}),
    shellHook: shellHookStatus({home, plat, environment}),
    entry: entryStatus({home, plat, environment})
  };
}
