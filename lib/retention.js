import {spawn} from 'node:child_process';

// Background retention used to run inside the supervisor's own runtime process.
// On Windows the supervisor is Bun, and bun:sqlite executes every statement
// synchronously: a prune plus PRAGMA quick_check could block the event loop for
// seconds to minutes. While blocked the supervisor stopped draining the
// engine's stderr pipe, the engine blocked on its next log write, and Cursor's
// turn stalled right after the first conversation (retention runs 60 seconds
// after every start). The worker keeps the supervisor responsive by moving the
// database work into a second copy of the bundled runtime.
//
// The worker is `bridge.js retain <root> <tracesDays> <sessionsDays>`; it prints
// one JSON object and exits, so the supervisor only parses a small result.
export const RETENTION_TIMEOUT_MS = 10 * 60 * 1000;

export function retentionArguments({bridge, root, tracesDays, sessionsDays}) {
  return [bridge, 'retain', root, String(tracesDays), String(sessionsDays)];
}

export function runRetentionWorker({
  runtime,
  bridge,
  root,
  tracesDays = 0,
  sessionsDays = 0,
  timeoutMs = RETENTION_TIMEOUT_MS,
  spawnImpl = spawn,
  environment = process.env
}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(runtime, retentionArguments({bridge, root, tracesDays, sessionsDays}), {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: {...environment, CURSOR_BRIDGE_ROOT: root}
      });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle(value);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      finish(reject, new Error('自动清理子进程超时'));
    }, timeoutMs);
    timer.unref?.();
    // The worker prints only the result, but cap the capture so a runaway
    // import error cannot grow the supervisor's memory.
    child.stdout?.on('data', (chunk) => {
      if (stdout.length < 1024 * 1024) stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 1024 * 1024) stderr += chunk;
    });
    child.once('error', (error) => finish(reject, error));
    child.once('close', (code) => {
      if (code !== 0) {
        finish(reject, new Error(String(stderr || '').trim().slice(0, 1000) || `自动清理子进程退出码 ${code ?? '未知'}`));
        return;
      }
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) || '';
      try {
        finish(resolve, JSON.parse(line));
      } catch {
        finish(reject, new Error('自动清理子进程返回了无效结果'));
      }
    });
  });
}