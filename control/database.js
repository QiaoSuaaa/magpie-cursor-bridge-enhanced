import fs from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {execFile} from 'node:child_process';
import platform from '../lib/platform.js';
import {redact} from './diagnostics.js';

// bridge.db belongs to the native engine. The control console only reads it
// through the system sqlite3 binary: no npm dependency, no long-lived handle in
// the Magpie process, and the same tool a user would reach for by hand.
//
// Reads prefer SQLITE_OPEN_READONLY (`-readonly`). A WAL database that lost its
// -shm file cannot be opened that way: only a read-write connection may create
// the shared-memory file, so the first statement fails with SQLITE_CANTOPEN.
// Cursor deletes state.vscdb-wal/-shm when it exits cleanly, which made every
// read fail exactly when deletion was allowed. sqlite() therefore falls back to
// a read-write connection carrying `PRAGMA query_only = ON`: it creates the
// sidecars but rejects every write, so read callers keep the read-only
// guarantee without asking the user to start Cursor first.
//
// Sizes are content bytes (UTF-8 bytes: length(CAST(... AS BLOB))), not file pages.
// A full dbstat walk costs ~45s on a multi-GB database and would freeze the
// panel; "file size minus content bytes" is reported separately as index and
// free-page overhead.
//
// A normal pass reads messages once and skips the heavy blob-body sums; the
// explicit "deep" pass adds those at the cost of scanning every blob.
const QUERY_TIMEOUT = 60000;
const CLEANUP_TIMEOUT = 300000;
const VACUUM_TIMEOUT = 900000;
const BACKUP_KEEP = 3;

// The schema is owned by the engine and may grow between releases. Known
// tables are grouped for humans; anything new lands in "其他表" so it still
// shows up instead of vanishing from the panel.
const TABLES = {
  conversations: {
    category: 'sessions',
    label: '会话',
    size: "SUM(length(CAST(conversation_id AS BLOB)) + length(CAST(COALESCE(active_run_id, '') AS BLOB)))",
    requires: ['conversation_id', 'active_run_id']
  },
  messages: {
    category: 'sessions',
    label: '消息',
    size: 'SUM(length(CAST(payload_json AS BLOB)))',
    requires: ['payload_json']
  },
  input_anchors: {
    category: 'sessions',
    label: '输入锚点',
    size: 'SUM(length(CAST(conversation_id AS BLOB)) + length(CAST(input_id AS BLOB)))',
    requires: ['conversation_id', 'input_id']
  },
  conversation_checkpoints: {
    category: 'checkpoints',
    label: '检查点',
    size: 'SUM(length(state_digest))',
    requires: ['state_digest']
  },
  checkpoint_messages: {
    category: 'checkpoints',
    label: '检查点消息映射',
    size: 'SUM(length(CAST(conversation_id AS BLOB)) + length(CAST(message_id AS BLOB)))',
    requires: ['conversation_id', 'message_id']
  },
  runs: {
    category: 'runs',
    label: '代理运行',
    size: "SUM(length(CAST(turn_usage_json AS BLOB)) + length(CAST(COALESCE(failure_summary, '') AS BLOB)) + length(CAST(COALESCE(failure_category, '') AS BLOB)) + length(CAST(COALESCE(subagent_kind, '') AS BLOB)) + length(CAST(COALESCE(parent_run_id, '') AS BLOB)) + length(CAST(COALESCE(cursor_request_id, '') AS BLOB)))",
    requires: ['turn_usage_json', 'failure_summary', 'failure_category', 'subagent_kind', 'parent_run_id', 'cursor_request_id']
  },
  tool_rounds: {
    category: 'runs',
    label: '工具轮次',
    size: 'SUM(length(CAST(assistant_json AS BLOB)))',
    requires: ['assistant_json']
  },
  tool_round_calls: {
    category: 'runs',
    label: '工具调用',
    size: "SUM(length(CAST(arguments_json AS BLOB)) + length(CAST(COALESCE(result_content, '') AS BLOB)) + length(CAST(COALESCE(argument_error, '') AS BLOB)) + length(CAST(call_id AS BLOB)) + length(CAST(model_call_id AS BLOB)))",
    requires: ['arguments_json', 'result_content', 'argument_error', 'call_id', 'model_call_id']
  },
  llm_calls: {
    category: 'telemetry',
    label: '模型调用',
    size: "SUM(length(CAST(COALESCE(usage_json, '') AS BLOB)) + length(CAST(COALESCE(error_message, '') AS BLOB)) + length(CAST(COALESCE(finish_reason, '') AS BLOB)))",
    requires: ['usage_json', 'error_message', 'finish_reason']
  },
  llm_call_requests: {
    category: 'telemetry',
    label: '调用请求体',
    size: 'SUM(byte_count)',
    requires: ['byte_count']
  },
  llm_call_response_chunks: {
    category: 'telemetry',
    label: '响应分片',
    size: 'SUM(byte_count)',
    requires: ['byte_count']
  },
  cursor_run_traces: {
    category: 'telemetry',
    label: 'Cursor 请求追踪',
    size: "SUM(length(CAST(COALESCE(error_message, '') AS BLOB)))",
    requires: ['error_message']
  },
  cursor_run_trace_artifacts: {
    category: 'telemetry',
    label: '追踪附件',
    size: 'SUM(length(CAST(metadata_json AS BLOB)))',
    requires: ['metadata_json']
  },
  blobs: {
    category: 'content',
    label: '内容块',
    size: 'SUM(length(data))',
    requires: ['data'],
    // Reading every blob body is the most expensive part of a statistics run
    // (>1 GB on mature installs); only the "deep" pass measures it.
    heavy: true
  },
  blob_edges: {
    category: 'content',
    label: '内容块引用',
    size: 'SUM(length(parent_blob_id) + length(child_blob_id) + length(CAST(field_name AS BLOB)))',
    requires: ['parent_blob_id', 'child_blob_id', 'field_name'],
    heavy: true
  },
  model_configs: {
    category: 'config',
    label: '模型配置',
    size: null
  },
  service_settings: {
    category: 'config',
    label: '服务设置',
    size: null
  },
  _sqlx_migrations: {
    category: 'config',
    label: '数据库迁移',
    size: null
  }
};

const CATEGORIES = [
  {id: 'sessions', label: '会话与消息', hint: '对话元数据与消息正文，清理后可释放主要空间'},
  {id: 'checkpoints', label: '检查点与快照', hint: '每轮对话的检查点及消息映射'},
  {id: 'runs', label: '运行与工具调用', hint: 'Agent 运行、工具轮次与工具调用记录'},
  {id: 'telemetry', label: '请求调用日志', hint: '模型调用与 Cursor 请求追踪，属于日常诊断数据'},
  {id: 'content', label: '内容存储（blob）', hint: '检查点引用的内容块与引用关系，引擎只增不删'},
  {id: 'config', label: '配置与系统', hint: '模型目录、服务设置与迁移记录，不参与清理'},
  {id: 'other', label: '其他表', hint: '未识别的新表，仅展示与统计'}
];

const CATEGORY_BY_ID = new Map(CATEGORIES.map((entry) => [entry.id, entry]));
const KNOWN_TABLES = new Set(Object.keys(TABLES));

export function quoteIdent(name) {
  return `"${String(name).replaceAll('"', '""')}"`;
}

export function quoteText(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

// Windows usually has no sqlite3 on PATH. Magpie runs this module inside its
// own Bun, which carries SQLite in-process, so the panel keeps working without
// asking the user to install anything. macOS keeps the CLI path byte-for-byte.
async function bunSqlite(dbPath, sql, {readonly = false, json = false, busyTimeout = 0, queryOnly = false} = {}) {
  const {Database} = await import('bun:sqlite');
  const database = new Database(dbPath, {readonly, create: !readonly});
  try {
    if (busyTimeout) database.exec(`PRAGMA busy_timeout = ${Math.max(0, Number(busyTimeout) || 0)}`);
    if (queryOnly) database.exec('PRAGMA query_only = ON');
    // Generated scripts never embed ';' in a literal: split them and collect
    // the rows of the report SELECT that closes a cleanup script.
    const statements = String(sql).split(';').map((part) => part.trim()).filter(Boolean);
    let rows = [];
    for (const statement of statements) {
      if (/^(SELECT|WITH|PRAGMA)\b/i.test(statement)) {
        const result = database.query(statement).all();
        if (/^(SELECT|WITH)\b/i.test(statement)) rows = result;
      } else {
        database.exec(statement);
      }
    }
    return json ? JSON.stringify(rows) : '';
  } finally {
    try { database.close(); } catch { /* already closed */ }
  }
}

// `maxBuffer` is exposed for callers that legitimately read large rows (the
// Cursor state store returns whole message bodies); the bridge statistics
// queries never come close to the default.
function runSqlite(dbPath, sql, {readonly = false, json = false, timeout = QUERY_TIMEOUT, busyTimeout = 0, maxBuffer = 16 * 1024 * 1024, queryOnly = false} = {}) {
  const binary = platform.current.sqlite3();
  if (!binary) {
    if (process.versions.bun) return bunSqlite(dbPath, sql, {readonly, json, busyTimeout, queryOnly});
    return Promise.reject(new Error('未找到 sqlite3 可执行文件；请安装 sqlite3 后重试（Magpie 内置运行时下会自动使用内置 SQLite）'));
  }
  const args = [];
  if (readonly) args.push('-readonly');
  if (json) args.push('-json');
  // A .timeout dot-command emits no rows; PRAGMA busy_timeout would add a
  // JSON array of its own and break the single-result convention below.
  if (busyTimeout) args.push('-cmd', `.timeout ${busyTimeout}`);
  if (queryOnly) args.push('-cmd', 'PRAGMA query_only = ON');
  args.push('-batch', dbPath, sql);
  return new Promise((resolve, reject) => {
    execFile(binary, args, {encoding: 'utf8', timeout, maxBuffer, windowsHide: true}, (error, stdout, stderr) => {
      if (error) {
        // Keep the execFile error object: `killed` and `code` tell a timeout
        // apart from a SQLite refusal, and stderr carries the real message.
        const detail = String(stderr || '').trim();
        if (detail) error.message = detail;
        reject(error);
        return;
      }
      resolve(String(stdout || ''));
    });
  });
}

function cantOpen(error) {
  return /unable to open database file|SQLITE_CANTOPEN/i.test(String(error?.message || error));
}

function shmPresent(dbPath) {
  try {
    return fs.statSync(`${dbPath}-shm`).isFile();
  } catch {
    return false;
  }
}

// Databases already known to need the query_only fallback. A panel load issues
// several queries; without this every one would fail once before retrying. The
// next call returns to plain -readonly as soon as Cursor runs again and its
// -shm file reappears.
const queryOnlyPaths = new Set();

// A read-only connection can return SQLITE_BUSY while the -wal/-shm pair is
// being created (the first read after Cursor exits) or checkpointed. The lock
// is transient, but the CLI fails on the first attempt unless a timeout is set;
// the Cursor panel issues several queries at once, so without a default the
// cold start was flaky (about one failure in eight runs of readDatabase()).
const READ_ONLY_BUSY_TIMEOUT = 5000;

function dbFilePresent(dbPath) {
  try {
    return fs.statSync(dbPath).isFile();
  } catch {
    return false;
  }
}

// A read-write retry is only safe when the first attempt failed for the WAL
// sidecar reason. A killed child is a timeout, not a refusal: retrying would
// double the wait. A missing path must never reach the read-write opener
// because the CLI and bun:sqlite would create an empty database exactly where
// Cursor keeps its state.
function mayRetryReadWrite(dbPath, error) {
  if (error?.killed || error?.code === 'ETIMEDOUT') return false;
  return dbFilePresent(dbPath);
}

export function sqlite(dbPath, sql, options = {}) {
  const readonly = options.readonly === true;
  const settings = readonly && options.busyTimeout === undefined
    ? {...options, busyTimeout: READ_ONLY_BUSY_TIMEOUT}
    : options;
  const fallback = {readonly: false, queryOnly: true};
  if (readonly && queryOnlyPaths.has(dbPath)) {
    // Cursor is running again (-shm reappeared) or the database was removed:
    // forget the shortcut and let the plain read-only attempt decide.
    if (shmPresent(dbPath) || !dbFilePresent(dbPath)) {
      queryOnlyPaths.delete(dbPath);
    } else {
      return runSqlite(dbPath, sql, {...settings, ...fallback});
    }
  }
  return runSqlite(dbPath, sql, settings).catch((error) => {
    if (!readonly || !cantOpen(error) || !mayRetryReadWrite(dbPath, error)) throw error;
    return runSqlite(dbPath, sql, {...settings, ...fallback})
      .then((output) => {
        queryOnlyPaths.add(dbPath);
        return output;
      });
  });
}

function parseJson(text) {
  try {
    const value = JSON.parse(text || '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function fileInfo(file) {
  try {
    const info = fs.statSync(file);
    return {size: info.size, updated: info.mtime.toISOString()};
  } catch {
    return {size: 0, updated: null};
  }
}

function sizes(dbPath) {
  const db = fileInfo(dbPath);
  const wal = fileInfo(`${dbPath}-wal`);
  const shm = fileInfo(`${dbPath}-shm`);
  return {db, wal, shm, total: db.size + wal.size + shm.size};
}

// VACUUM INTO writes a consistent, compact snapshot including committed WAL
// content; copying the file directly could miss rows still in the WAL. The
// caller stops the engine first, so there is no concurrent writer.
async function backupDatabase(dbPath, directory, scope, keepBackups) {
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(directory, `bridge-${stamp}-${scope}-${randomBytes(4).toString('hex')}.db`);
  await sqlite(dbPath, `VACUUM INTO ${quoteText(file)};`, {timeout: VACUUM_TIMEOUT, busyTimeout: 15000});
  const size = fs.statSync(file).size;
  const keep = Math.max(1, Number(keepBackups) || BACKUP_KEEP);
  const backups = fs.readdirSync(directory)
    .filter((name) => name.startsWith('bridge-') && name.endsWith('.db'))
    .map((name) => ({name, at: fs.statSync(path.join(directory, name)).mtimeMs}))
    .sort((a, b) => b.at - a.at || b.name.localeCompare(a.name));
  const pruned = [];
  for (const entry of backups.slice(keep)) {
    try { fs.unlinkSync(path.join(directory, entry.name)); pruned.push(entry.name); } catch { /* in use */ }
  }
  return {file, size, pruned};
}

async function quickCheck(dbPath) {
  try {
    const rows = parseJson(await sqlite(dbPath, 'PRAGMA quick_check;', {readonly: true, json: true, timeout: CLEANUP_TIMEOUT}));
    const values = rows.map((row) => String(row.quick_check || 'unknown'));
    if (!values.length) return 'unknown';
    return values.every((value) => value === 'ok') ? 'ok' : values.join('; ');
  } catch (error) {
    return `unavailable: ${error.message}`;
  }
}

async function listTables(dbPath) {
  const rows = parseJson(await sqlite(dbPath,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name;",
    {readonly: true, json: true}));
  return rows.map((row) => String(row.name || '')).filter(Boolean);
}

async function tableColumns(dbPath) {
  try {
    const rows = parseJson(await sqlite(dbPath,
      "SELECT m.name AS t, p.name AS c FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table';",
      {readonly: true, json: true}));
    const columns = new Map();
    for (const row of rows) {
      const name = String(row.t || '');
      if (!name) continue;
      if (!columns.has(name)) columns.set(name, new Set());
      columns.get(name).add(String(row.c || ''));
    }
    return columns;
  } catch {
    // Introspection is best-effort; without it the panel falls back to counts.
    return null;
  }
}

function canMeasure(name, columns, deep = true) {
  const meta = TABLES[name];
  if (!meta?.size) return false;
  if (meta.heavy && !deep) return false;
  if (!columns) return true;
  const available = columns.get(name);
  return !!available && meta.requires.every((column) => available.has(column));
}

async function tableStats(dbPath, tables, columns, {deep = false} = {}) {
  if (!tables.length) return [];
  const parts = tables.map((name) => {
    const bytes = canMeasure(name, columns, deep) ? `COALESCE(${TABLES[name].size}, 0)` : '0';
    return `SELECT ${quoteText(name)} AS t, COUNT(*) AS rows, ${bytes} AS bytes FROM ${quoteIdent(name)}`;
  });
  const rows = parseJson(await sqlite(dbPath, `${parts.join('\nUNION ALL\n')};`, {readonly: true, json: true}));
  return rows.map((row) => ({
    name: String(row.t || ''),
    rows: Number(row.rows) || 0,
    bytes: Number(row.bytes) || 0,
    measured: canMeasure(String(row.t || ''), columns, deep)
  }));
}

// One pass over messages feeds the table totals, the per-day chart and the
// per-conversation list. Three separate GROUP BY scans used to read the same
// payload column three times on multi-GB databases.
function canGroupMessages(tables, columns) {
  if (!tables.includes('messages')) return false;
  const available = columns?.get('messages');
  if (!available) return true;
  return available.has('created_at_ms') && available.has('payload_json');
}

async function messageGroups(dbPath, tables, columns) {
  if (!canGroupMessages(tables, columns)) return {totals: null, days: [], conversations: []};
  const rows = parseJson(await sqlite(dbPath, `
SELECT conversation_id AS id,
       date(created_at_ms / 1000, 'unixepoch', 'localtime') AS day,
       COUNT(*) AS count,
       COALESCE(SUM(length(CAST(payload_json AS BLOB))), 0) AS bytes
FROM messages
GROUP BY id, day;`, {readonly: true, json: true}));
  const dayTotals = new Map();
  const conversationTotals = new Map();
  let totalRows = 0;
  let totalBytes = 0;
  for (const row of rows) {
    const count = Number(row.count) || 0;
    const bytes = Number(row.bytes) || 0;
    totalRows += count;
    totalBytes += bytes;
    const day = String(row.day || '');
    if (day) {
      const entry = dayTotals.get(day) || {day, count: 0, bytes: 0};
      entry.count += count;
      entry.bytes += bytes;
      dayTotals.set(day, entry);
    }
    const id = String(row.id || '');
    if (id) {
      const entry = conversationTotals.get(id) || {id, count: 0, bytes: 0};
      entry.count += count;
      entry.bytes += bytes;
      conversationTotals.set(id, entry);
    }
  }
  let updated = new Map();
  if (tables.includes('conversations')) {
    try {
      const rows = parseJson(await sqlite(dbPath,
        'SELECT conversation_id AS id, updated_at_ms AS updated FROM conversations;',
        {readonly: true, json: true}));
      updated = new Map(rows.map((row) => [String(row.id || ''), Number(row.updated) || 0]));
    } catch { /* the conversation list is best-effort */ }
  }
  return {
    totals: {rows: totalRows, bytes: totalBytes},
    days: [...dayTotals.values()].sort((a, b) => (a.day < b.day ? 1 : -1)).slice(0, 7),
    conversations: [...conversationTotals.values()]
      .map((entry) => ({id: entry.id, updated: updated.get(entry.id) || 0, messages: entry.count, bytes: entry.bytes}))
      .sort((a, b) => b.updated - a.updated)
      .slice(0, 12)
  };
}

async function pageInfo(dbPath) {
  const rows = parseJson(await sqlite(dbPath, `
SELECT (SELECT page_size FROM pragma_page_size) AS pageSize,
       (SELECT page_count FROM pragma_page_count) AS pageCount,
       (SELECT freelist_count FROM pragma_freelist_count) AS freelistCount,
       (SELECT journal_mode FROM pragma_journal_mode) AS journalMode;`, {readonly: true, json: true}));
  const row = rows[0] || {};
  return {
    pageSize: Number(row.pageSize) || null,
    pageCount: Number(row.pageCount) || null,
    freelistCount: Number(row.freelistCount) || 0,
    journalMode: typeof row.journalMode === 'string' ? row.journalMode : null
  };
}

function groupCategories(stats) {
  const byName = new Map(stats.map((entry) => [entry.name, entry]));
  const used = new Set();
  const categories = [];
  for (const category of CATEGORIES) {
    const names = category.id === 'other'
      ? stats.filter((entry) => !KNOWN_TABLES.has(entry.name)).map((entry) => entry.name)
      : Object.keys(TABLES).filter((name) => TABLES[name].category === category.id);
    const tables = names.filter((name) => byName.has(name)).map((name) => {
      used.add(name);
      const entry = byName.get(name);
      return {
        name,
        label: TABLES[name]?.label || name,
        rows: entry.rows,
        bytes: entry.bytes,
        measured: entry.measured
      };
    });
    if (!tables.length) continue;
    categories.push({
      id: category.id,
      label: category.label,
      hint: category.hint,
      measured: tables.some((table) => table.measured),
      rows: tables.reduce((sum, table) => sum + table.rows, 0),
      bytes: tables.reduce((sum, table) => sum + table.bytes, 0),
      tables
    });
  }
  // Defensive: a table missing from both the known map and sqlite_master
  // should never disappear from the report.
  const leftovers = stats.filter((entry) => !used.has(entry.name));
  if (leftovers.length) {
    const other = categories.find((entry) => entry.id === 'other');
    const tables = leftovers.map((entry) => ({
      name: entry.name,
      label: entry.name,
      rows: entry.rows,
      bytes: entry.bytes,
      measured: entry.measured
    }));
    if (other) {
      other.tables.push(...tables);
      other.measured = other.measured || tables.some((table) => table.measured);
      other.rows += tables.reduce((sum, table) => sum + table.rows, 0);
      other.bytes += tables.reduce((sum, table) => sum + table.bytes, 0);
    } else {
      categories.push({
        id: 'other',
        ...CATEGORY_BY_ID.get('other'),
        measured: tables.some((table) => table.measured),
        rows: tables.reduce((sum, table) => sum + table.rows, 0),
        bytes: tables.reduce((sum, table) => sum + table.bytes, 0),
        tables
      });
    }
  }
  return categories;
}

function fileSummary(dbPath) {
  const value = sizes(dbPath);
  return {
    db: value.db.size,
    wal: value.wal.size,
    shm: value.shm.size,
    total: value.total,
    updated: value.db.updated
  };
}

// Recent calls are a bounded, indexed read (llm_calls_created): the console
// needs the model, latency, tokens and failure reason, not the request bodies.
export async function readRecentCalls(dbPath, {limit = 25, errorsOnly = false} = {}) {
  if (!fs.existsSync(dbPath)) return {exists: false, calls: [], truncated: false};
  const cap = Math.max(1, Math.min(200, Number(limit) || 25));
  const tables = new Set(await listTables(dbPath));
  if (!tables.has('llm_calls')) return {exists: true, calls: [], truncated: false};
  const where = errorsOnly ? "WHERE status != 'completed' OR COALESCE(error_message, '') != ''" : '';
  const full = `SELECT call_id, run_id, conversation_id, model_id, display_name, model_hash, provider_type,
                       request_type, status, finish_reason, created_at_ms, duration_ms, ttft_ms,
                       input_tokens, output_tokens, total_tokens, cache_read_tokens, reasoning_tokens,
                       http_status, error_kind, error_message
                FROM llm_calls ${where} ORDER BY created_at_ms DESC LIMIT ${cap};`;
  const minimal = `SELECT call_id, run_id, conversation_id, status, finish_reason, created_at_ms, error_message
                   FROM llm_calls ${where} ORDER BY created_at_ms DESC LIMIT ${cap};`;
  let rows;
  try {
    rows = parseJson(await sqlite(dbPath, full, {readonly: true, json: true, timeout: QUERY_TIMEOUT}));
  } catch {
    // Older engine schemas lack the newer telemetry columns; the basic
    // identity/status/error columns have been present since the first release.
    rows = parseJson(await sqlite(dbPath, minimal, {readonly: true, json: true, timeout: QUERY_TIMEOUT}));
  }
  return {
    exists: true,
    truncated: rows.length >= cap,
    calls: rows.map((row) => {
      const error = [row.error_kind, row.error_message].filter(Boolean).join(': ');
      return {
        id: String(row.call_id || ''),
        run: String(row.run_id || ''),
        conversation: String(row.conversation_id || ''),
        model: String(row.display_name || row.model_id || row.model_hash || '—'),
        provider: String(row.provider_type || ''),
        requestType: String(row.request_type || ''),
        status: String(row.status || ''),
        finish: String(row.finish_reason || ''),
        created: Number(row.created_at_ms) || 0,
        durationMs: Number(row.duration_ms) || 0,
        ttftMs: Number(row.ttft_ms) || null,
        inputTokens: Number(row.input_tokens) || 0,
        outputTokens: Number(row.output_tokens) || 0,
        totalTokens: Number(row.total_tokens) || 0,
        cacheReadTokens: Number(row.cache_read_tokens) || 0,
        reasoningTokens: Number(row.reasoning_tokens) || 0,
        httpStatus: Number(row.http_status) || null,
        error: redact(error).slice(0, 500)
      };
    })
  };
}

export async function extractCursorAuthToken(home) {
  const dbPath = path.join(path.dirname(platform.current.cursorSettings(home)), 'globalStorage', 'state.vscdb');
  if (!fs.existsSync(dbPath)) throw new Error('未找到 Cursor 状态数据库，请确认已安装并登录 Cursor');
  const rows = parseJson(await sqlite(dbPath, "SELECT key, value FROM ItemTable WHERE key IN ('cursorAuth/accessToken', 'cursorAuth/cachedEmail');", {readonly: true, json: true, timeout: 10000, busyTimeout: 5000}));
  const values = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  const token = values['cursorAuth/accessToken'];
  if (typeof token !== 'string' || !token.trim()) throw new Error('未找到 Cursor Access Token，请先在 Cursor 中登录');
  return {token: token.trim(), email: values['cursorAuth/cachedEmail'] || ''};
}

export async function readDatabase(dbPath, {deep = false} = {}) {
  if (!fs.existsSync(dbPath)) {
    return {exists: false, path: dbPath, file: fileSummary(dbPath), totals: {rows: 0, bytes: 0}, deep};
  }
  const tables = await listTables(dbPath);
  // Column introspection is fast and tells us whether one grouped scan over
  // messages can replace both the table totals and the two report queries.
  const columns = await tableColumns(dbPath);
  const grouped = canGroupMessages(tables, columns);
  const [page, messages, stats] = await Promise.all([
    pageInfo(dbPath),
    messageGroups(dbPath, tables, columns),
    tableStats(dbPath, grouped ? tables.filter((name) => name !== 'messages') : tables, columns, {deep})
  ]);
  const entries = stats.slice();
  if (grouped && messages.totals) {
    entries.push({name: 'messages', rows: messages.totals.rows, bytes: messages.totals.bytes, measured: true});
  }
  const categories = groupCategories(entries);
  const totals = entries.reduce((sum, entry) => ({
    rows: sum.rows + entry.rows,
    bytes: sum.bytes + entry.bytes
  }), {rows: 0, bytes: 0});
  return {
    exists: true,
    path: dbPath,
    file: fileSummary(dbPath),
    page,
    deep,
    totals,
    categories,
    conversations: messages.conversations,
    days: messages.days
  };
}

function countRows(statements, table, where = '', available) {
  if (available && !available.has(table)) return;
  statements.push(`INSERT OR REPLACE INTO _counts SELECT ${quoteText(table)}, COUNT(*) FROM ${quoteIdent(table)}${where ? ` WHERE ${where}` : ''};`);
}

function deleteRows(statements, table, where = '', available) {
  if (available && !available.has(table)) return;
  statements.push(`DELETE FROM ${quoteIdent(table)}${where ? ` WHERE ${where}` : ''};`);
}

function buildSessionsScript(days, tables, limit = 0) {
  const cutoff = Date.now() - days * 86400000;
  // Retention runs while the engine keeps writing, so each pass removes a
  // bounded number of conversations and commits; the next pass continues.
  const cap = Number.isInteger(limit) && limit > 0 ? ` LIMIT ${limit}` : '';
  const doomed = '(SELECT conversation_id FROM _doomed)';
  const runScope = `(SELECT run_id FROM runs WHERE conversation_id IN ${doomed})`;
  const roundScope = `(SELECT round_id FROM tool_rounds WHERE run_id IN ${runScope})`;
  const statements = [
    'PRAGMA foreign_keys=ON;',
    'PRAGMA defer_foreign_keys=ON;',
    'BEGIN IMMEDIATE;',
    'CREATE TEMP TABLE _counts(t TEXT PRIMARY KEY, n INTEGER NOT NULL);',
    `CREATE TEMP TABLE _doomed AS SELECT conversation_id FROM conversations WHERE updated_at_ms < ${cutoff}${cap};`,
    "INSERT OR REPLACE INTO _counts SELECT 'conversations', COUNT(*) FROM _doomed;"
  ];
  countRows(statements, 'messages', `conversation_id IN ${doomed}`, tables);
  countRows(statements, 'conversation_checkpoints', `conversation_id IN ${doomed}`, tables);
  countRows(statements, 'checkpoint_messages', `conversation_id IN ${doomed}`, tables);
  countRows(statements, 'input_anchors', `conversation_id IN ${doomed}`, tables);
  countRows(statements, 'runs', `conversation_id IN ${doomed}`, tables);
  countRows(statements, 'tool_rounds', `run_id IN ${runScope}`, tables);
  countRows(statements, 'tool_round_calls', `round_id IN ${roundScope}`, tables);

  // Children first: the engine enables foreign_keys, and checkpoint_messages
  // also points at messages, so the delete order carries the integrity.
  deleteRows(statements, 'tool_round_calls', `round_id IN ${roundScope}`, tables);
  deleteRows(statements, 'tool_rounds', `run_id IN ${runScope}`, tables);
  deleteRows(statements, 'runs', `conversation_id IN ${doomed}`, tables);
  deleteRows(statements, 'checkpoint_messages', `conversation_id IN ${doomed}`, tables);
  deleteRows(statements, 'input_anchors', `conversation_id IN ${doomed}`, tables);
  deleteRows(statements, 'conversation_checkpoints', `conversation_id IN ${doomed}`, tables);
  deleteRows(statements, 'messages', `conversation_id IN ${doomed}`, tables);
  deleteRows(statements, 'conversations', `conversation_id IN ${doomed}`, tables);
  statements.push('COMMIT;', 'SELECT t, n FROM _counts ORDER BY t;', 'DROP TABLE _counts;', 'DROP TABLE _doomed;');
  return statements.join('\n');
}

function appendOrphanTraceBlobCleanup(statements, tables) {
  if (!tables.has('cursor_run_trace_artifacts') || !tables.has('blobs')) return;
  // Index blob_id before deleting from blobs so SQLite's foreign-key check on
  // cursor_run_trace_artifacts does not scan the entire artifacts table.
  statements.push('CREATE INDEX IF NOT EXISTS cursor_run_trace_artifacts_blob ON cursor_run_trace_artifacts(blob_id);');
  const filters = ['SELECT blob_id FROM _trace_blobs', 'EXCEPT SELECT blob_id FROM cursor_run_trace_artifacts'];
  if (tables.has('blob_edges')) {
    filters.push('EXCEPT SELECT parent_blob_id FROM blob_edges', 'EXCEPT SELECT child_blob_id FROM blob_edges');
  }
  statements.push(
    `CREATE TEMP TABLE _orphan_blobs AS ${filters.join(' ')};`,
    "INSERT OR REPLACE INTO _counts SELECT 'blobs', COUNT(*) FROM _orphan_blobs;",
    'DELETE FROM blobs WHERE blob_id IN (SELECT blob_id FROM _orphan_blobs);'
  );
}

function buildTracesScript(tables) {
  const collectBlobs = tables.has('cursor_run_trace_artifacts') && tables.has('blobs');
  const statements = [
    'PRAGMA foreign_keys=ON;',
    'BEGIN IMMEDIATE;',
    'CREATE TEMP TABLE _counts(t TEXT PRIMARY KEY, n INTEGER NOT NULL);'
  ];
  if (collectBlobs) {
    statements.push(
      'CREATE TEMP TABLE _trace_blobs(blob_id BLOB PRIMARY KEY);',
      'INSERT OR IGNORE INTO _trace_blobs SELECT blob_id FROM cursor_run_trace_artifacts;'
    );
  }
  countRows(statements, 'llm_calls', '', tables);
  countRows(statements, 'llm_call_requests', '', tables);
  countRows(statements, 'llm_call_response_chunks', '', tables);
  countRows(statements, 'cursor_run_traces', '', tables);
  countRows(statements, 'cursor_run_trace_artifacts', '', tables);
  deleteRows(statements, 'llm_call_requests', '', tables);
  deleteRows(statements, 'llm_call_response_chunks', '', tables);
  deleteRows(statements, 'llm_calls', '', tables);
  deleteRows(statements, 'cursor_run_trace_artifacts', '', tables);
  deleteRows(statements, 'cursor_run_traces', '', tables);
  appendOrphanTraceBlobCleanup(statements, tables);
  statements.push('COMMIT;', 'SELECT t, n FROM _counts ORDER BY t;', 'DROP TABLE _counts;');
  if (collectBlobs) statements.push('DROP TABLE _trace_blobs;', 'DROP TABLE _orphan_blobs;');
  return statements.join('\n');
}

// Online retention: old call logs and traces are diagnostics, so they can be
// deleted in bounded transactions while the engine keeps running. The temp
// tables select one batch first; children are removed before their parents so
// foreign keys stay valid without relying on ON DELETE CASCADE.
function buildRetentionTracesScript(tables, cutoff, limit) {
  const cap = Number.isInteger(limit) && limit > 0 ? ` LIMIT ${limit}` : '';
  const collectBlobs = tables.has('cursor_run_trace_artifacts') && tables.has('blobs');
  const calls = tables.has('llm_calls')
    ? `CREATE TEMP TABLE _calls AS SELECT call_id FROM llm_calls WHERE created_at_ms < ${cutoff}${cap};`
    : 'CREATE TEMP TABLE _calls(call_id TEXT);';
  const traces = tables.has('cursor_run_traces')
    ? `CREATE TEMP TABLE _traces AS SELECT request_id FROM cursor_run_traces WHERE received_at_ms < ${cutoff}${cap};`
    : 'CREATE TEMP TABLE _traces(request_id TEXT);';
  const statements = [
    'PRAGMA foreign_keys=ON;',
    'PRAGMA defer_foreign_keys=ON;',
    'BEGIN IMMEDIATE;',
    'CREATE TEMP TABLE _counts(t TEXT PRIMARY KEY, n INTEGER NOT NULL);',
    calls,
    traces,
    "INSERT OR REPLACE INTO _counts SELECT 'llm_calls', COUNT(*) FROM _calls;",
    "INSERT OR REPLACE INTO _counts SELECT 'cursor_run_traces', COUNT(*) FROM _traces;"
  ];
  if (collectBlobs) {
    statements.push(
      'CREATE TEMP TABLE _trace_blobs(blob_id BLOB PRIMARY KEY);',
      'INSERT OR IGNORE INTO _trace_blobs SELECT blob_id FROM cursor_run_trace_artifacts WHERE request_id IN (SELECT request_id FROM _traces);'
    );
  }
  deleteRows(statements, 'llm_call_requests', 'call_id IN (SELECT call_id FROM _calls)', tables);
  deleteRows(statements, 'llm_call_response_chunks', 'call_id IN (SELECT call_id FROM _calls)', tables);
  deleteRows(statements, 'llm_calls', 'call_id IN (SELECT call_id FROM _calls)', tables);
  deleteRows(statements, 'cursor_run_trace_artifacts', 'request_id IN (SELECT request_id FROM _traces)', tables);
  deleteRows(statements, 'cursor_run_traces', 'request_id IN (SELECT request_id FROM _traces)', tables);
  appendOrphanTraceBlobCleanup(statements, tables);
  statements.push('COMMIT;', 'SELECT t, n FROM _counts ORDER BY t;', 'DROP TABLE _counts;', 'DROP TABLE _calls;', 'DROP TABLE _traces;');
  if (collectBlobs) statements.push('DROP TABLE _trace_blobs;', 'DROP TABLE _orphan_blobs;');
  return statements.join('\n');
}

function buildAllScript(tables) {
  // Dependency order for a full reset. Config tables (model_configs,
  // service_settings, _sqlx_migrations) are deliberately absent.
  const order = [
    'tool_round_calls',
    'tool_rounds',
    'runs',
    'checkpoint_messages',
    'input_anchors',
    'conversation_checkpoints',
    'messages',
    'conversations',
    'llm_call_requests',
    'llm_call_response_chunks',
    'llm_calls',
    'cursor_run_trace_artifacts',
    'cursor_run_traces',
    'blob_edges',
    'blobs'
  ];
  const statements = [
    'PRAGMA foreign_keys=ON;',
    'PRAGMA defer_foreign_keys=ON;',
    'BEGIN IMMEDIATE;',
    'CREATE TEMP TABLE _counts(t TEXT PRIMARY KEY, n INTEGER NOT NULL);'
  ];
  for (const table of order) countRows(statements, table, '', tables);
  for (const table of order) deleteRows(statements, table, '', tables);
  statements.push('COMMIT;', 'SELECT t, n FROM _counts ORDER BY t;', 'DROP TABLE _counts;');
  return statements.join('\n');
}

function buildCleanupScript(scope, days, tables) {
  if (scope === 'sessions') return buildSessionsScript(days, tables);
  if (scope === 'traces') return buildTracesScript(tables);
  return buildAllScript(tables);
}

export async function cleanDatabase(dbPath, {scope = 'traces', olderThanDays = 3, vacuum = true, backup = false, backupDir = path.join(path.dirname(dbPath), 'backups'), keepBackups = BACKUP_KEEP} = {}) {
  if (!['traces', 'sessions', 'all', 'vacuum'].includes(scope)) {
    throw new Error(`未知的清理范围：${scope || '空'}`);
  }
  if (!fs.existsSync(dbPath)) throw new Error('数据库尚未创建，暂无可清理的数据');
  if (scope === 'sessions' && (!Number.isInteger(olderThanDays) || olderThanDays < 1 || olderThanDays > 3650)) {
    throw new Error('保留天数需为 1–3650 的整数');
  }
  const started = Date.now();
  const before = sizes(dbPath);
  // A destructive scope may be irreversible; the backup is written before any
  // DELETE runs so a failed cleanup still leaves the original data recoverable.
  const backupResult = backup && scope !== 'vacuum'
    ? await backupDatabase(dbPath, backupDir, scope, keepBackups)
    : null;
  const counts = {};
  if (scope !== 'vacuum') {
    const tables = new Set(await listTables(dbPath));
    if (!tables.has('conversations') && scope === 'sessions') {
      throw new Error('数据库缺少会话表，无法按天清理');
    }
    const output = await sqlite(dbPath, buildCleanupScript(scope, olderThanDays, tables), {
      json: true,
      timeout: CLEANUP_TIMEOUT,
      busyTimeout: 15000
    });
    for (const row of parseJson(output)) {
      const name = String(row.t || '');
      if (name) counts[name] = Number(row.n) || 0;
    }
  }
  let vacuumed = false;
  if (vacuum || scope === 'vacuum') {
    // VACUUM rewrites the whole file and needs an exclusive lock. The caller
    // stops the bridge first, so the only connection is this CLI process.
    await sqlite(dbPath,
      'PRAGMA wal_checkpoint(TRUNCATE);\nVACUUM;\nPRAGMA wal_checkpoint(TRUNCATE);',
      {timeout: VACUUM_TIMEOUT, busyTimeout: 15000});
    vacuumed = true;
  }
  const check = await quickCheck(dbPath);
  const after = sizes(dbPath);
  return {
    scope,
    vacuumed,
    backup: backupResult,
    check,
    counts,
    before,
    after,
    reclaimed: Math.max(0, before.total - after.total),
    durationMs: Date.now() - started
  };
}

// Automatic retention used by the supervisor. It never stops the engine and
// never vacuums: bounded deletes in short transactions keep WAL writers
// moving, and the freed pages are reused by later writes. Manual cleanup
// remains the way to reclaim disk space.
export async function pruneDatabase(dbPath, {tracesDays = 0, sessionsDays = 0, batchSize = 200, busyTimeout = 15000, maxBatches = 50, check = true} = {}) {
  const result = {
    exists: fs.existsSync(dbPath),
    at: new Date().toISOString(),
    calls: 0,
    traces: 0,
    blobs: 0,
    sessions: 0,
    batches: 0,
    durationMs: 0,
    check: null,
    error: null
  };
  if (!result.exists) return result;
  if (!(Number(tracesDays) > 0) && !(Number(sessionsDays) > 0)) return result;
  const started = Date.now();
  const tables = new Set(await listTables(dbPath));
  const batch = Math.max(1, Math.min(2000, Number(batchSize) || 200));
  const passes = Math.max(1, Math.min(200, Number(maxBatches) || 50));
  const run = async (script) => {
    if (!script) return {};
    const output = await sqlite(dbPath, script, {json: true, timeout: CLEANUP_TIMEOUT, busyTimeout});
    const counts = {};
    for (const row of parseJson(output)) {
      const name = String(row.t || '');
      if (name) counts[name] = Number(row.n) || 0;
    }
    result.batches += 1;
    return counts;
  };
  try {
    if (Number(tracesDays) > 0) {
      const cutoff = Date.now() - Number(tracesDays) * 86400000;
      for (let pass = 0; pass < passes; pass += 1) {
        const counts = await run(buildRetentionTracesScript(tables, cutoff, batch));
        const calls = counts.llm_calls || 0;
        const traces = counts.cursor_run_traces || 0;
        result.calls += calls;
        result.traces += traces;
        result.blobs += counts.blobs || 0;
        if (!calls && !traces) break;
      }
    }
    if (Number(sessionsDays) > 0 && tables.has('conversations')) {
      for (let pass = 0; pass < passes; pass += 1) {
        const counts = await run(buildSessionsScript(Number(sessionsDays), tables, batch));
        const deleted = counts.conversations || 0;
        result.sessions += deleted;
        if (!deleted) break;
      }
    }
  } catch (error) {
    result.error = String(error?.message || error);
  }
  try { await sqlite(dbPath, 'PRAGMA optimize;', {busyTimeout, timeout: QUERY_TIMEOUT}); } catch { /* best effort */ }
  // quick_check scans the whole database; the background worker skips it
  // because it would keep the database busy far longer than the deletes
  // themselves. Manual cleanup keeps verifying the result.
  if (check) result.check = await quickCheck(dbPath);
  result.durationMs = Date.now() - started;
  return result;
}
