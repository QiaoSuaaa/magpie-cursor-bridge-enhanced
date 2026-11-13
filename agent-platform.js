// Magpie's agent sandbox only resolves modules beside agent.js and rejects
// node: builtins, so this file uses globals only — no imports. If the host
// hides process, fall back to the historical macOS layout; Magpie expands a
// leading ~ in the config path.
const env = globalThis.process?.env || {};
const platform = globalThis.process?.platform || 'darwin';
const home = env.HOME || env.USERPROFILE || '~';
const join = (...parts) => parts.filter(Boolean).join('/').replace(/\/{2,}/g, '/');
const local = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
const roaming = env.APPDATA || join(home, 'AppData', 'Roaming');

export const cursorDir = platform === 'linux'
  ? 'cursor'
  : (platform === 'win32' ? join(local, 'Programs', 'cursor') : '/Applications/Cursor.app');

export const connectionFile = platform === 'win32'
  ? join(roaming, 'magpie-cursor-bridge', 'connection.json')
  : join(home, '.config', 'magpie-cursor-bridge', 'connection.json');
