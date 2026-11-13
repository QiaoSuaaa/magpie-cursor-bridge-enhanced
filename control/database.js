import fs from 'node:fs';
import {execFile} from 'node:child_process';
import platform from '../lib/platform.js';

// bridge.db belongs to the native engine. The control console only reads it
// through the system sqlite3 binary: no npm dependency, no long-lived handle in
// the Magpie process, and the same tool a user would reach for by hand.
//
// Sizes are content bytes (UTF-8 bytes: length(CAST(... AS BLOB))), not file pages.
// A full dbstat walk costs ~45s on a multi-GB database and would freeze the
// panel; "file size minus content bytes" is reported separately as index and
// free-page overhead.
const QUERY_TIMEOUT = 60000;
const CLEANUP_TIMEOUT = 300000;
const VACUUM_TIMEOUT = 900000;

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
    requires: ['data']
  },
  blob_edges: {
    category: 'content',
    label: '内容块引用',
    size: 'SUM(length(parent_blob_id) + length(child_blob_id) + length(CAST(field_name AS BLOB)))',
    requires: ['parent_blob_id', 'child_blob_id', 'field_name']
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

function quoteIdent(name) {
  return `"${String(name).replaceAll('"', '""')}"`;
}

function quoteText(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlite(dbPath, sql, {readonly = false, json = false, timeout = QUERY_TIMEOUT, busyTimeout = 0} = {}) {
  const args = [];
  if (readonly) args.push('-readonly');
  if (json) args.push('-json');
  // A .timeout dot-command emits no rows; PRAGMA busy_timeout would add a
  // JSON array of its own and break the single-result convention below.
  if (busyTimeout) args.push('-cmd', `.timeout ${busyTimeout}`);
  args.push('-batch', dbPath, sql);
  const binary = platform.current.sqlite3();
  if (!binary) return Promise.reject(new Error('未找到 sqlite3 可执行文件；请安装 sqlite3 后重试'));
  return new Promise((resolve, reject) => {
    execFile(binary, args, {encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024}, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || '').trim();
        reject(new Error(detail || String(error.message || error)));
        return;
      }
      resolve(String(stdout || ''));
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

function canMeasure(name, columns) {
  const meta = TABLES[name];
  if (!meta?.size) return false;
  if (!columns) return true;
  const available = columns.get(name);
  return !!available && meta.requires.every((column) => available.has(column));
}

async function tableStats(dbPath, tables, columns) {
  if (!tables.length) return [];
  const parts = tables.map((name) => {
    const bytes = canMeasure(name, columns) ? `COALESCE(${TABLES[name].size}, 0)` : '0';
    return `SELECT ${quoteText(name)} AS t, COUNT(*) AS rows, ${bytes} AS bytes FROM ${quoteIdent(name)}`;
  });
  const rows = parseJson(await sqlite(dbPath, `${parts.join('\nUNION ALL\n')};`, {readonly: true, json: true}));
  return rows.map((row) => ({
    name: String(row.t || ''),
    rows: Number(row.rows) || 0,
    bytes: Number(row.bytes) || 0,
    measured: canMeasure(String(row.t || ''), columns)
  }));
}

async function recentConversations(dbPath, tables) {
  if (!tables.includes('conversations') || !tables.includes('messages')) return [];
  const rows = parseJson(await sqlite(dbPath, `
SELECT c.conversation_id AS id,
       c.updated_at_ms AS updated,
       COALESCE(m.count, 0) AS messages,
       COALESCE(m.bytes, 0) AS bytes
FROM conversations c
LEFT JOIN (
  SELECT conversation_id, COUNT(*) AS count, SUM(length(CAST(payload_json AS BLOB))) AS bytes
  FROM messages GROUP BY conversation_id
) m ON m.conversation_id = c.conversation_id
ORDER BY c.updated_at_ms DESC
LIMIT 12;`, {readonly: true, json: true}));
  return rows.map((row) => ({
    id: String(row.id || ''),
    updated: Number(row.updated) || 0,
    messages: Number(row.messages) || 0,
    bytes: Number(row.bytes) || 0
  }));
}

async function dailyMessages(dbPath, tables) {
  if (!tables.includes('messages')) return [];
  const rows = parseJson(await sqlite(dbPath, `
SELECT date(created_at_ms / 1000, 'unixepoch', 'localtime') AS day,
       COUNT(*) AS count,
       COALESCE(SUM(length(CAST(payload_json AS BLOB))), 0) AS bytes
FROM messages
GROUP BY day
ORDER BY day DESC
LIMIT 7;`, {readonly: true, json: true}));
  return rows.map((row) => ({
    day: String(row.day || ''),
    count: Number(row.count) || 0,
    bytes: Number(row.bytes) || 0
  }));
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

export async function readDatabase(dbPath) {
  if (!fs.existsSync(dbPath)) {
    return {exists: false, path: dbPath, file: fileSummary(dbPath), totals: {rows: 0, bytes: 0}};
  }
  const tables = await listTables(dbPath);
  // Column introspection is fast and gates the size query; the other reads
  // then run alongside the expensive content-byte scan.
  const columns = await tableColumns(dbPath);
  const [page, conversations, days, stats] = await Promise.all([
    pageInfo(dbPath),
    recentConversations(dbPath, tables),
    dailyMessages(dbPath, tables),
    tableStats(dbPath, tables, columns)
  ]);
  const categories = groupCategories(stats);
  const totals = stats.reduce((sum, entry) => ({
    rows: sum.rows + entry.rows,
    bytes: sum.bytes + entry.bytes
  }), {rows: 0, bytes: 0});
  return {
    exists: true,
    path: dbPath,
    file: fileSummary(dbPath),
    page,
    totals,
    categories,
    conversations,
    days
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

function buildSessionsScript(days, tables) {
  const cutoff = Date.now() - days * 86400000;
  const doomed = '(SELECT conversation_id FROM _doomed)';
  const runScope = `(SELECT run_id FROM runs WHERE conversation_id IN ${doomed})`;
  const roundScope = `(SELECT round_id FROM tool_rounds WHERE run_id IN ${runScope})`;
  const statements = [
    'PRAGMA foreign_keys=ON;',
    'PRAGMA defer_foreign_keys=ON;',
    'BEGIN IMMEDIATE;',
    'CREATE TEMP TABLE _counts(t TEXT PRIMARY KEY, n INTEGER NOT NULL);',
    `CREATE TEMP TABLE _doomed AS SELECT conversation_id FROM conversations WHERE updated_at_ms < ${cutoff};`,
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

function buildTracesScript(tables) {
  const statements = [
    'PRAGMA foreign_keys=ON;',
    'BEGIN IMMEDIATE;',
    'CREATE TEMP TABLE _counts(t TEXT PRIMARY KEY, n INTEGER NOT NULL);'
  ];
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
  statements.push('COMMIT;', 'SELECT t, n FROM _counts ORDER BY t;', 'DROP TABLE _counts;');
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

export async function cleanDatabase(dbPath, {scope = 'traces', olderThanDays = 3, vacuum = true} = {}) {
  if (!['traces', 'sessions', 'all', 'vacuum'].includes(scope)) {
    throw new Error(`未知的清理范围：${scope || '空'}`);
  }
  if (!fs.existsSync(dbPath)) throw new Error('数据库尚未创建，暂无可清理的数据');
  if (scope === 'sessions' && (!Number.isInteger(olderThanDays) || olderThanDays < 1 || olderThanDays > 3650)) {
    throw new Error('保留天数需为 1–3650 的整数');
  }
  const started = Date.now();
  const before = sizes(dbPath);
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
  const after = sizes(dbPath);
  return {
    scope,
    vacuumed,
    counts,
    before,
    after,
    reclaimed: Math.max(0, before.total - after.total),
    durationMs: Date.now() - started
  };
}
