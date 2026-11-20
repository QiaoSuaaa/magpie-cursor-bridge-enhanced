import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MARKER,
  WRAPPER_NAME,
  envText,
  envFileFor,
  writeAgentEnv,
  removeAgentEnv,
  wrapperText,
  wrapperPathFor,
  installWrapper,
  removeWrapper,
  shellConfigFor,
  shellHookStatus,
  installShellHook,
  removeShellHook,
  agentExecutable,
  agentStatus
} from '../lib/cursor-agent.js';
import {cursorAgentCompatibility, CURSOR_AGENT_TESTED} from '../lib/compatibility.js';

function workspace(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-bridge-agent-'));
  t.after(() => fs.rmSync(base, {recursive: true, force: true}));
  return {base, home: path.join(base, 'home'), root: path.join(base, 'root')};
}

test('envText exports the proxy and CA for POSIX shells', () => {
  const text = envText({proxy: 'http://127.0.0.1:58160', caPath: "/tmp/it's/ca.crt"}, 'darwin');
  assert.match(text, /export HTTPS_PROXY='http:\/\/127\.0\.0\.1:58160'/);
  assert.match(text, /export NODE_EXTRA_CA_CERTS='\/tmp\/it'\\''s\/ca\.crt'/);
});

test('envText uses set for cmd.exe', () => {
  const text = envText({proxy: 'http://127.0.0.1:58160', caPath: 'C:\\ca\\ca.crt'}, 'win32');
  assert.match(text, /set "HTTPS_PROXY=http:\/\/127\.0\.0\.1:58160"/);
  assert.match(text, /set "NODE_EXTRA_CA_CERTS=C:\\ca\\ca\.crt"/);
});

test('envText stays empty without a proxy so the wrapper falls back to direct', () => {
  assert.equal(envText({}, 'darwin'), '');
  assert.equal(envText({caPath: '/tmp/ca.crt'}, 'win32'), '');
});

test('writeAgentEnv and removeAgentEnv round-trip', (t) => {
  const {root} = workspace(t);
  const file = writeAgentEnv(root, {proxy: 'http://127.0.0.1:58160', caPath: '/tmp/ca.crt'});
  assert.equal(file, envFileFor(root));
  assert.match(fs.readFileSync(file, 'utf8'), /HTTPS_PROXY/);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
  removeAgentEnv(root);
  assert.equal(fs.existsSync(file), false);
});

test('wrapperText sources the env file and execs the official CLI', () => {
  const text = wrapperText({root: '/tmp/root', plat: 'darwin'});
  assert.match(text, new RegExp(MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(text, /ENV_FILE='\/tmp\/root\/agent-env'/);
  assert.match(text, /\. "\$ENV_FILE"/);
  assert.match(text, /exec cursor-agent "\$@"/);
});

test('wrapperText for Windows calls the CMD env file', () => {
  const text = wrapperText({root: 'C:\\root', plat: 'win32'});
  assert.match(text, /^@echo off\r\n/);
  assert.match(text, /call "C:\\root\\agent-env\.cmd"/);
  assert.match(text, /cursor-agent %\*/);
});

test('installWrapper prefers ~/.local/bin when it is on PATH', (t) => {
  const {home, root} = workspace(t);
  const localBin = path.join(home, '.local', 'bin');
  fs.mkdirSync(localBin, {recursive: true});
  const result = installWrapper({root, home, environment: {PATH: [localBin, '/usr/bin'].join(path.delimiter)}});
  assert.equal(result.path, path.join(localBin, WRAPPER_NAME));
  assert.equal(result.onPath, true);
  assert.match(fs.readFileSync(result.path, 'utf8'), new RegExp(MARKER.slice(2)));
});

test('installWrapper falls back to the install root when no PATH directory is usable', (t) => {
  const {home, root} = workspace(t);
  const result = installWrapper({root, home, environment: {PATH: ''}});
  assert.equal(result.path, path.join(root, 'bin', WRAPPER_NAME));
  assert.equal(result.onPath, false);
});

test('installWrapper refuses to overwrite a file it did not create', (t) => {
  const {home, root} = workspace(t);
  const target = wrapperPathFor(root, home, process.platform, {PATH: ''});
  fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.writeFileSync(target, '#!/bin/sh\necho mine\n');
  assert.throws(() => installWrapper({root, home, environment: {PATH: ''}}), /不是桥接生成的/);
});

test('removeWrapper leaves foreign files and removes generated ones', (t) => {
  const {home, root} = workspace(t);
  const target = wrapperPathFor(root, home, process.platform, {PATH: ''});
  fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.writeFileSync(target, '#!/bin/sh\necho mine\n');
  assert.deepEqual(removeWrapper({root, home, environment: {PATH: ''}}), {removed: false, path: target});
  assert.equal(fs.existsSync(target), true);

  fs.writeFileSync(target, `${MARKER}\n`);
  assert.deepEqual(removeWrapper({root, home, environment: {PATH: ''}}), {removed: true, path: target});
  assert.equal(fs.existsSync(target), false);
});

test('agentExecutable finds cursor-agent on PATH', (t) => {
  if (process.platform === 'win32') return;
  const {base, home} = workspace(t);
  const bin = path.join(base, 'bin');
  fs.mkdirSync(bin, {recursive: true});
  const executable = path.join(bin, 'cursor-agent');
  fs.writeFileSync(executable, '#!/bin/sh\necho 2026.11.19-f005e9d\n');
  fs.chmodSync(executable, 0o755);
  assert.equal(agentExecutable({home, environment: {PATH: bin}}), executable);
});

test('agentStatus reports a missing CLI without throwing', (t) => {
  const {home, root} = workspace(t);
  const status = agentStatus({root, home, environment: {PATH: ''}});
  assert.equal(status.installed, false);
  assert.equal(status.version, null);
  assert.equal(status.compatibility.status, 'unknown');
  assert.equal(status.wrapperInstalled, false);
  assert.equal(status.envReady, false);
});

test('shell config follows SHELL and ZDOTDIR', () => {
  assert.equal(shellConfigFor({home: '/home/u', plat: 'darwin', environment: {SHELL: '/bin/bash'}}), path.posix.join('/home/u', '.bashrc'));
  assert.equal(shellConfigFor({home: '/home/u', plat: 'darwin', environment: {SHELL: '/bin/zsh'}}), path.posix.join('/home/u', '.zshrc'));
  assert.equal(shellConfigFor({home: '/home/u', plat: 'darwin', environment: {SHELL: '/bin/zsh', ZDOTDIR: '/zdot'}}), path.posix.join('/zdot', '.zshrc'));
  assert.equal(shellConfigFor({home: '/home/u', plat: 'darwin', environment: {SHELL: '/usr/bin/fish'}}), null);
  assert.equal(shellConfigFor({home: 'C:\\Users\\u', plat: 'win32', environment: {}}), null);
});

test('shell config prefers an existing bashrc when SHELL is unset', (t) => {
  const {home} = workspace(t);
  fs.mkdirSync(home, {recursive: true});
  fs.writeFileSync(path.join(home, '.bashrc'), '');
  assert.equal(shellConfigFor({home, plat: 'darwin', environment: {}}), path.join(home, '.bashrc'));
  fs.writeFileSync(path.join(home, '.zshrc'), '');
  assert.equal(shellConfigFor({home, plat: 'darwin', environment: {}}), path.join(home, '.zshrc'));
});

test("shell hook is idempotent and keeps the user's rc content", (t) => {
  const {base} = workspace(t);
  const file = path.join(base, 'shellrc');
  fs.writeFileSync(file, '# user config\nexport PATH="$PATH:/x"\n');
  const first = installShellHook({root: '/tmp/root', file});
  assert.equal(first.supported, true);
  assert.equal(first.installed, true);
  assert.equal(first.changed, true);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /# >>> cursor-bridge >>>/);
  assert.match(text, /cursor-agent\(\) \{/);
  assert.match(text, /command cursor-agent "\$@"/);
  assert.match(text, /export PATH="\$PATH:\/x"/);

  const second = installShellHook({root: '/tmp/root', file});
  assert.equal(second.changed, false);
  assert.equal((text.match(/# >>> cursor-bridge >>>/g) || []).length, 1);
});

test('removeShellHook deletes only the managed block', (t) => {
  const {base} = workspace(t);
  const file = path.join(base, 'shellrc');
  fs.writeFileSync(file, '# user config\nexport PATH="$PATH:/x"\n');
  installShellHook({root: '/tmp/root', file});
  assert.equal(shellHookStatus({file}).installed, true);
  const result = removeShellHook({file});
  assert.equal(result.removed, true);
  const text = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(text, /cursor-bridge/);
  assert.match(text, /export PATH="\$PATH:\/x"/);
  assert.equal(shellHookStatus({file}).installed, false);
  // Removing twice is a no-op rather than an error.
  assert.equal(removeShellHook({file}).removed, false);
});

test('cursor-agent compatibility uses its own tested build', () => {
  const tested = cursorAgentCompatibility('2026.11.19-f005e9d');
  assert.equal(tested.status, 'tested');
  assert.equal(tested.range, CURSOR_AGENT_TESTED.label);
  const older = cursorAgentCompatibility('2026.11.18-abc');
  assert.equal(older.status, 'older');
  const newer = cursorAgentCompatibility('2026.11.20-abc');
  assert.equal(newer.status, 'newer');
  assert.equal(cursorAgentCompatibility(null).status, 'unknown');
});
