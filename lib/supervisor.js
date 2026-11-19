import {createInterface} from 'node:readline';
import {validate} from './config.js';

// The supervisor is the bridge's state machine: it decides when the native
// engine runs, when it restarts, and when Cursor's proxy must be restored.
// Every side effect is injected so each transition can be tested with a fake
// engine; bridge.js owns process wiring (lock, log rotation, signals).
export function createSupervisor({
  spawnEngine,
  publish,
  readSettings,
  readConnection,
  fetchCatalogue,
  writeEffective,
  applyProxy,
  restoreProxy,
  pruneDatabase = null,
  onPrune = () => {},
  onEngineStderr = () => {},
  onLifecycle = () => {},
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  isEnding = () => false,
  initialProxyPort = '',
  platformName = process.platform,
  engineReadyTimeoutMs = 30000,
  engineStopTimeoutMs = 12000,
  loopIntervalMs = 2000,
  retentionIntervalMs = 6 * 60 * 60 * 1000,
  retentionInitialDelayMs = 60 * 1000
} = {}) {
  let child = null;
  let ready = null;
  let running = false;
  let runningMode = '';
  let runningSubagentMode = '';
  let activeMode = 'default';
  let lastConfig = '';
  let nextRefresh = 0;
  let paused = false;
  let catalogueDownSince = 0;
  let lastModelCount = 0;
  let lastModelPrefs = '';
  let lastEffective = '';
  let preferredProxyPort = initialProxyPort;
  let nextPruneAt = null;
  let pruning = false;
  let prunePending = Promise.resolve();

  // A child that has exited keeps its exitCode/signalCode; a fake process in
  // tests follows the same contract.
  const exited = (proc) => !!proc && (
    (proc.exitCode !== null && proc.exitCode !== undefined)
    || (proc.signalCode !== null && proc.signalCode !== undefined)
  );
  const engineAlive = () => !!(child && running);
  // publish() always carries the configured mode and the engine's running mode,
  // so the control panel can tell "saved but not applied" apart.
  let runtime = null;
  let lifecycle = [];
  const record = (event, reason, details = {}) => {
    const entry = {at: new Date(now()).toISOString(), event, reason, ...details};
    lifecycle = [...lifecycle.slice(-19), entry];
    try { onLifecycle(entry); } catch { /* diagnostics must not interrupt the engine */ }
  };
  const update = (state, extra = {}) => publish(state, {mode: activeMode, engineMode: runningMode || null, runtime, lifecycle, ...extra});

  async function stop(reason = 'shutdown') {
    // Restore before stopping the listener so Cursor does not point at a dead port.
    const old = child;
    if (old) record('stopping', reason, {pid: old.pid});
    child = null;
    runtime = null;
    ready = null;
    running = false;
    runningMode = '';
    runningSubagentMode = '';
    try {
      return await restoreProxy();
    } finally {
      if (old && !exited(old)) {
        try {
          const done = new Promise((resolve) => old.once('exit', resolve));
          old.kill('SIGTERM');
          await Promise.race([done, wait(engineStopTimeoutMs)]);
          if (!exited(old)) {
            old.kill('SIGKILL');
            await new Promise((resolve) => old.once('exit', resolve));
          }
        } catch { /* the process is already gone */ }
      }
    }
  }

  async function start(connection, mode, subagentMode, reason) {
    const serialized = JSON.stringify(connection);
    writeEffective(serialized);
    lastEffective = serialized;
    const engine = spawnEngine({mode, subagentMode, preferredProxyPort});
    runningMode = mode;
    runningSubagentMode = subagentMode;
    child = engine;
    running = true;
    engine.stderr?.on('data', onEngineStderr);
    runtime = {pid: engine.pid, startedAt: new Date(now()).toISOString(), reason, ...engine.bridgeIdentity};
    record('starting', reason, {pid: engine.pid, engineVersion: runtime.engineVersion, pluginVersion: runtime.pluginVersion, sha256: runtime.sha256});
    engine.once('exit', (code, signal) => {
      const unexpected = child === engine;
      record('exited', unexpected ? 'unexpected_exit' : 'requested_stop', {pid: engine.pid, code, signal});
      if (unexpected) {
        running = false;
        runtime = null;
        if (ready) update('error', {reason: `bridge engine exited (${signal || code})`});
      }
    });
    ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('bridge startup timed out')), engineReadyTimeoutMs);
      const finish = (settle, value) => { clearTimeout(timer); settle(value); };
      const lines = createInterface({input: engine.stdout});
      lines.on('line', (line) => {
        try {
          const message = JSON.parse(line);
          if (message.event === 'ready') finish(resolve, message);
        } catch { /* engine diagnostics are not JSON */ }
      });
      engine.once('error', (error) => finish(reject, new Error(`cannot start bridge engine (${error.code || error.message}); this build ships a ${platformName} engine only when its binary matches the platform`)));
      engine.once('exit', (code, signal) => finish(reject, new Error(`bridge engine stopped (${signal || code}); check certificate trust`)));
    });
    try { const url = new URL(ready.proxy); if (url.port) preferredProxyPort = url.port; } catch { /* keep the previous port */ }
    applyProxy(ready.proxy);
    record('ready', reason, {pid: engine.pid});
  }

  async function run() {
    try {
      await restoreProxy();
      while (!isEnding()) {
        const config = readSettings();
        activeMode = config.runMode;
        // Retention is independent of the connection state and must never stall
        // the loop: the prune runs in the background, and the next pass starts
        // only after the previous one settles. Lite mode has no on-disk
        // database, so there is nothing to retain.
        const tracesDays = Number(config.tracesRetentionDays) || 0;
        const sessionsDays = Number(config.sessionsRetentionDays) || 0;
        if (pruneDatabase && !pruning && config.runMode !== 'lite' && (tracesDays > 0 || sessionsDays > 0)) {
          if (nextPruneAt === null) nextPruneAt = now() + retentionInitialDelayMs;
          if (now() >= nextPruneAt) {
            nextPruneAt = now() + retentionIntervalMs;
            pruning = true;
            prunePending = Promise.resolve()
              .then(() => pruneDatabase({tracesDays, sessionsDays}))
              .then((result) => onPrune(result))
              .catch((error) => {
                // A locked or busy database is worth retrying sooner than the
                // normal interval; the console still records the failure.
                nextPruneAt = now() + 60 * 60 * 1000;
                onPrune({at: new Date().toISOString(), error: String(error?.message || error)});
              })
              .finally(() => { pruning = false; });
          }
        }
        try {
          const raw = readConnection();
          const connection = validate(JSON.parse(raw));
          if (!connection) {
            await stop('disconnected');
            update('disconnected');
            paused = false;
            lastConfig = '';
          } else if (paused && raw === lastConfig) {
            update('paused', {reason: 'Cursor 代理设置由其他程序改动；请在 Magpie 中断开后重新连接。'});
          } else {
            const changed = raw !== lastConfig;
            const alive = engineAlive();
            // A saved run mode is applied by restarting the engine once; the
            // supervisor never rewrites effective.json just for a mode switch.
            const modeChanged = alive && runningMode !== config.runMode;
            const subagentModeChanged = alive && runningSubagentMode !== config.subagentMode;
            // Display names and menu order live in bridge-settings.json: a
            // change rewrites effective.json and the engine hot-swaps the
            // catalogue, so neither Cursor nor the running conversation restarts.
            const modelPrefsSignature = JSON.stringify({names: config.modelNames || {}, order: config.modelOrder || [], hidden: config.modelHidden || [], tab: [config.tabMode, config.tabToken, config.tabAddress]});
            const modelPrefsChanged = modelPrefsSignature !== lastModelPrefs;
            if (changed || now() >= nextRefresh || !alive || modeChanged || subagentModeChanged || modelPrefsChanged) {
              let effective = null;
              let failure = null;
              try {
                effective = await fetchCatalogue(connection, config);
              } catch (error) {
                failure = error;
              }
              nextRefresh = now() + config.refreshSeconds * 1000;
              if (failure) {
                // A transient Magpie hiccup must not drop Cursor's proxy: keep the
                // running engine (and its port) and only fall back once the outage
                // is sustained.
                if (!catalogueDownSince) catalogueDownSince = now();
                const downFor = now() - catalogueDownSince;
                if (!engineAlive() || downFor >= config.gatewayGraceSeconds * 1000) throw failure;
                update('connected', {
                  model: connection.model,
                  models: lastModelCount,
                  proxy: ready.proxy,
                  backend: ready.backend,
                  pid: child.pid,
                  warning: `Magpie gateway unavailable for ${Math.round(downFor / 1000)}s: ${failure.message}`
                });
                await wait(2000);
                continue;
              }
              catalogueDownSince = 0;
              if (!engineAlive() || modeChanged || subagentModeChanged) {
                const reason = modeChanged ? 'run_mode_changed' : subagentModeChanged ? 'subagent_mode_changed' : lifecycle.some(entry => entry.event === 'starting') ? 'engine_recovery' : 'initial_start';
                await stop(reason);
                await start(effective, config.runMode, config.subagentMode, reason);
              } else {
                const serialized = JSON.stringify(effective);
                if (serialized !== lastEffective) {
                  writeEffective(serialized);
                  lastEffective = serialized;
                }
              }
              lastConfig = raw;
              paused = false;
              lastModelCount = effective.models.length;
              lastModelPrefs = modelPrefsSignature;
              update('connected', {
                model: connection.model,
                models: effective.models.length,
                proxy: ready.proxy,
                backend: ready.backend,
                pid: child.pid
              });
            }
            try {
              applyProxy(ready.proxy);
            } catch (error) {
              await stop('proxy_changed');
              paused = true;
              lastConfig = raw;
              throw error;
            }
          }
        } catch (error) {
          record('error', 'supervisor_error');
          try { await stop('supervisor_error'); } catch { /* keep the journal for recovery after malformed settings are fixed */ }
          update('error', {reason: error.message});
        }
        if (!isEnding()) await wait(loopIntervalMs);
      }
    } finally {
      // A migration waits for this process to exit before copying SQLite files.
      // Let an online retention writer close its transaction first.
      try {
        await prunePending;
      } finally {
        await stop();
        update('stopped');
      }
    }
  }

  return {run, stop};
}
