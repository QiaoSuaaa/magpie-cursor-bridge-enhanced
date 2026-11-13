import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createControlServer} from './server.js';
import platform from '../lib/platform.js';

// Magpie loads this Bun module as the plugin's server side and keeps it for
// the life of the app. That makes it the one place that can still answer when
// the bridge supervisor is down, which is exactly when the panel's "start"
// button is needed. The service binds 127.0.0.1 only.
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PORT = 3580;
const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'package.json'), 'utf8'));
// The descriptor a plain ZIP install registers only carries the plugin parts;
// setup.command stays in the package it was installed from.
function sourceRoot() {
  try {
    const location = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'control-location.json'), 'utf8'));
    const candidate = location?.source;
    // macOS runs setup.command; Windows runs install.js through the host
    // runtime, so either entry points at the package this came from.
    if (candidate && (fs.existsSync(path.join(candidate, 'setup.command')) || fs.existsSync(path.join(candidate, 'install.js')))) {
      return candidate;
    }
  } catch { /* registered from the package itself */ }
  return pluginRoot;
}
const repoRoot = sourceRoot();

// The port poll runs every two seconds; re-parsing plugins.json each time is
// wasted work, so cache the resolved entry until the file identity changes.
let pluginEntryCache = {signature: '', value: null};
function pluginEntry() {
  try {
    const file = path.join(platform.current.magpieConfigDir(), 'plugins.json');
    const info = fs.statSync(file);
    const signature = `${info.mtimeMs}:${info.size}:${info.ino}`;
    if (pluginEntryCache.signature === signature) return pluginEntryCache.value;
    const list = JSON.parse(fs.readFileSync(file, 'utf8')).plugins || [];
    const value = list.find((entry) => {
      const spec = String(entry?.spec || '');
      return spec && path.resolve(spec) === pluginRoot;
    }) || list.find((entry) => String(entry?.spec || '').includes(manifest.name)) || null;
    pluginEntryCache = {signature, value};
    return value;
  } catch {
    pluginEntryCache = {signature: '', value: null};
    return null;
  }
}

function validPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : null;
}

function optionPort() {
  return validPort(pluginEntry()?.options?.controlPort);
}

let current = null;
let desired = DEFAULT_PORT;
let binding = false;
let stopped = false;
let lastError = '';

async function ensure(log) {
  if (stopped || current || binding || !desired) return;
  binding = true;
  const port = desired;
  try {
    const started = await createControlServer({repoRoot, port, log});
    if (stopped || port !== desired) {
      await new Promise((resolve) => started.server.close(resolve));
      return;
    }
    current = started;
    lastError = '';
    log(`control console: http://127.0.0.1:${started.port}`);
  } catch (error) {
    const reason = String(error?.code || error?.message || error);
    if (reason !== lastError) {
      lastError = reason;
      log(`control port ${port} is unavailable (${reason}); retrying every 2s`);
    }
  } finally {
    binding = false;
  }
}

function changePort(port, log) {
  if (port === desired) return;
  desired = port;
  log(`control port -> ${port}`);
  if (current) {
    const old = current;
    current = null;
    old.server.closeAllConnections?.();
    old.server.close(() => {});
  }
}

export default {
  id: 'cursor-bridge-control',
  server: async (_input, options = {}) => {
    const log = (message) => console.log(`[cursor-bridge-control] ${message}`);
    desired = optionPort() || validPort(options.controlPort) || DEFAULT_PORT;
    const tick = setInterval(() => {
      const next = optionPort();
      if (next) changePort(next, log);
      ensure(log);
    }, 2000);
    tick.unref?.();
    ensure(log);
    process.once('exit', () => {
      stopped = true;
      clearInterval(tick);
      try { current?.server.close(); } catch {}
    });
    return {};
  }
};
