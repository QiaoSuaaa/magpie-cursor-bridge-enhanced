import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import platform from './platform.js';
import {wrapperPathFor} from './cursor-agent.js';

// Orca (the Electron IDE) launches its Cursor chat as an ACP process:
// `cursor-agent --disable-auto-update acp`, spawned directly without a login
// shell. A shell function therefore never runs, and the process inherits
// Orca's own environment (no HTTPS_PROXY). Orca does expose
// `agentCmdOverrides`, so the durable fix is to point the cursor agent at the
// same wrapper the terminal uses: the wrapper reads agent-env, which the
// supervisor keeps in sync with the live proxy port.
//
// Orca rewrites orca-data.json on exit, so an install made while Orca is
// running would be overwritten. The installer only writes when Orca is not
// running and otherwise tells the user to quit Orca and run setup again.
export const ORCA_FILE = 'orca-data.json';

const joinFor = (plat) => (plat === 'win32' ? path.win32 : path.posix);
const isWin = (plat) => plat === 'win32';

export function orcaDataPathFor({home = os.homedir(), plat = platform.platform, environment = process.env} = {}) {
  const p = joinFor(plat);
  if (isWin(plat)) {
    const roaming = environment.APPDATA || p.join(home, 'AppData', 'Roaming');
    return p.join(roaming, 'orca', ORCA_FILE);
  }
  if (plat === 'linux') {
    return p.join(environment.XDG_CONFIG_HOME || p.join(home, '.config'), 'orca', ORCA_FILE);
  }
  return p.join(home, 'Library', 'Application Support', 'orca', ORCA_FILE);
}

export function readOrcaData(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeOrcaData(file, data) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temp = `${file}.bridge.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`);
  // Re-read before replacing: a half-written or foreign file must never be
  // installed as the user's Orca state.
  JSON.parse(fs.readFileSync(temp, 'utf8'));
  fs.renameSync(temp, file);
}

export function orcaRunning({plat = platform.platform, exec = spawnSync} = {}) {
  if (isWin(plat)) {
    const result = exec('tasklist', ['/FI', 'IMAGENAME eq Orca.exe', '/NH'], {encoding: 'utf8', windowsHide: true});
    return /Orca\.exe/i.test(`${result.stdout || ''}`);
  }
  const result = exec('pgrep', ['-f', isWin(plat) ? 'Orca.exe' : 'Orca.app/Contents/MacOS/Orca'], {encoding: 'utf8', windowsHide: true});
  return result.status === 0 && String(result.stdout || '').trim().length > 0;
}

function overrideFor(data) {
  return data?.settings?.agentCmdOverrides?.cursor ?? null;
}

export function orcaStatus({home = os.homedir(), root, plat = platform.platform, environment = process.env, running = null} = {}) {
  const file = orcaDataPathFor({home, plat, environment});
  const data = readOrcaData(file);
  const wrapper = root ? wrapperPathFor(root, home, plat, environment) : null;
  const override = overrideFor(data);
  return {
    supported: true,
    // A missing orca-data.json simply means Orca is not installed (or never
    // started); it is not an error for setup.
    installed: !!data,
    path: file,
    wrapper,
    injected: !!wrapper && override === wrapper,
    foreignOverride: !!override && override !== wrapper,
    running: running === null ? orcaRunning({plat}) : running
  };
}

export function injectOrca({home = os.homedir(), root, plat = platform.platform, environment = process.env, running = null} = {}) {
  const file = orcaDataPathFor({home, plat, environment});
  const data = readOrcaData(file);
  if (!data) return {ok: false, reason: 'missing', path: file};
  const wrapper = wrapperPathFor(root, home, plat, environment);
  const current = overrideFor(data);
  // An idempotent re-run is safe even while Orca is open: there is nothing to
  // write, so the in-memory state cannot be lost on exit.
  if (current === wrapper) return {ok: true, path: file, wrapper, changed: false};
  if ((running === null ? orcaRunning({plat}) : running)) return {ok: false, reason: 'running', path: file};
  // Never replace a command the user configured themselves.
  if (current && current !== wrapper) return {ok: false, reason: 'foreign-override', path: file, previous: current};
  data.settings ??= {};
  data.settings.agentCmdOverrides ??= {};
  data.settings.agentCmdOverrides.cursor = wrapper;
  writeOrcaData(file, data);
  return {ok: true, path: file, wrapper, changed: current !== wrapper};
}

export function removeOrca({home = os.homedir(), root, plat = platform.platform, environment = process.env, running = null} = {}) {
  const file = orcaDataPathFor({home, plat, environment});
  const data = readOrcaData(file);
  if (!data) return {ok: false, reason: 'missing', path: file};
  if ((running === null ? orcaRunning({plat}) : running)) return {ok: false, reason: 'running', path: file};
  const wrapper = wrapperPathFor(root, home, plat, environment);
  if (overrideFor(data) !== wrapper) return {ok: true, path: file, removed: false};
  delete data.settings.agentCmdOverrides.cursor;
  writeOrcaData(file, data);
  return {ok: true, path: file, removed: true};
}
