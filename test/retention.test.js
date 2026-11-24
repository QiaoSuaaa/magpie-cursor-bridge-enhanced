import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {runRetentionWorker, retentionArguments, RETENTION_TIMEOUT_MS} from '../lib/retention.js';

// The supervisor must stay responsive while retention runs; the worker is the
// only place bun:sqlite executes. These tests pin the spawn contract and the
// result/error handling without starting a real runtime.
function fakeChild({close = 0, stdout = '', stderr = '', onKill = null} = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 777;
  child.kill = (signal) => { onKill?.(signal); return true; };
  process.nextTick(() => {
    if (stdout) child.stdout.write(stdout);
    if (stderr) child.stderr.write(stderr);
    child.stdout.end();
    child.stderr.end();
    if (close !== null) child.emit('close', close);
  });
  return child;
}

test('retention runs in a separate runtime process and returns its JSON result', async () => {
  const calls = [];
  let child = null;
  const result = await runRetentionWorker({
    runtime: 'C:\\runtime.exe',
    bridge: 'C:\\release\\bridge.js',
    root: 'C:\\state',
    tracesDays: 7,
    sessionsDays: 3,
    spawnImpl: (command, args, options) => {
      calls.push({command, args, options});
      child = fakeChild({stdout: JSON.stringify({calls: 2, traces: 1, sessions: 0, batches: 1})});
      return child;
    }
  });
  assert.deepEqual(result, {calls: 2, traces: 1, sessions: 0, batches: 1});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'C:\\runtime.exe');
  assert.deepEqual(calls[0].args, ['C:\\release\\bridge.js', 'retain', 'C:\\state', '7', '3']);
  assert.equal(calls[0].options.env.CURSOR_BRIDGE_ROOT, 'C:\\state');
  assert.equal(calls[0].timeout, undefined);
});

test('retention arguments are exactly the bridge retain contract', () => {
  assert.deepEqual(
    retentionArguments({bridge: 'b.js', root: '/state', tracesDays: 0, sessionsDays: 0}),
    ['b.js', 'retain', '/state', '0', '0']
  );
});

test('a worker failure is reported with its stderr instead of stalling the loop', async () => {
  await assert.rejects(
    runRetentionWorker({
      runtime: 'runtime', bridge: 'bridge.js', root: '/state', tracesDays: 7,
      spawnImpl: () => fakeChild({close: 1, stderr: 'database is locked'})
    }),
    /database is locked/
  );
});

test('an invalid worker result is rejected', async () => {
  await assert.rejects(
    runRetentionWorker({
      runtime: 'runtime', bridge: 'bridge.js', root: '/state', tracesDays: 7,
      spawnImpl: () => fakeChild({stdout: 'not json'})
    }),
    /无效结果/
  );
});

test('a hung worker is killed after the timeout', async (t) => {
  const kills = [];
  // The worker's timer is unref'd so it can never keep the supervisor alive;
  // the test keeps the event loop open long enough for it to fire.
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  await assert.rejects(
    runRetentionWorker({
      runtime: 'runtime', bridge: 'bridge.js', root: '/state', tracesDays: 7,
      timeoutMs: 20,
      spawnImpl: () => fakeChild({close: null, onKill: (signal) => kills.push(signal)})
    }),
    /超时/
  );
  assert.deepEqual(kills, ['SIGKILL']);
  assert.equal(RETENTION_TIMEOUT_MS, 10 * 60 * 1000);
});