import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import platform from '../lib/platform.js';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readDatabase, readRecentCalls, cleanDatabase, pruneDatabase, extractCursorAuthToken, sqlite} from '../control/database.js';
import {createControlServer} from '../control/server.js';
import {migrateStorage, resolveDataDir, databasePath} from '../lib/storage.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SQLITE = platform.current.sqlite3();
// These tests seed and inspect the fixture through the sqlite3 CLI. Windows
// without sqlite3 falls back to bun:sqlite inside Magpie, which the Node test
// runner cannot reach, so the suite skips instead of failing.
const SKIP = SQLITE ? false : '需要 sqlite3 可执行文件';

const BLOB_A = '00'.repeat(31) + '01';
const BLOB_B = '00'.repeat(31) + '02';

function sql(dbPath, statement) {
  return execFileSync(SQLITE, [dbPath], {input: statement, encoding: 'utf8'});
}

function query(dbPath, statement) {
  return execFileSync(SQLITE, ['-json', '-readonly', dbPath, statement], {encoding: 'utf8'});
}

function fakeDatabase(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-bridge-db-'));
  t.after(() => fs.rmSync(home, {recursive: true, force: true}));
  // Keep the platform layout inside the temporary home: on Windows pathsFor()
  // reads %APPDATA%, not the home directory itself.
  const env = {};
  for (const key of ['APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) env[key] = process.env[key];
  if (process.platform === 'win32') {
    process.env.APPDATA = path.join(home, 'AppData', 'Roaming');
    process.env.LOCALAPPDATA = path.join(home, 'AppData', 'Local');
  } else {
    process.env.XDG_CONFIG_HOME = path.join(home, 'xdg-config');
    process.env.XDG_DATA_HOME = path.join(home, 'xdg-data');
  }
  t.after(() => {
    for (const key of Object.keys(env)) {
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
  });
  const root = platform.pathsFor(home).config;
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, {recursive: true});
  const dbPath = path.join(dataDir, 'bridge.db');
  const now = Date.now();
  const old = now - 10 * 86400000;
  sql(dbPath, `
PRAGMA foreign_keys=ON;
CREATE TABLE conversations(conversation_id TEXT PRIMARY KEY, current_checkpoint_id INTEGER, active_run_id TEXT, updated_at_ms INTEGER NOT NULL);
CREATE TABLE messages(conversation_id TEXT NOT NULL, message_id TEXT NOT NULL, role TEXT NOT NULL, origin TEXT NOT NULL, payload_json TEXT NOT NULL, runtime_event_id TEXT, created_at_ms INTEGER NOT NULL, PRIMARY KEY(conversation_id, message_id), FOREIGN KEY(conversation_id) REFERENCES conversations(conversation_id));
CREATE TABLE conversation_checkpoints(checkpoint_id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL, parent_checkpoint_id INTEGER, state_digest BLOB NOT NULL, created_at_ms INTEGER NOT NULL, UNIQUE(conversation_id, state_digest), FOREIGN KEY(conversation_id) REFERENCES conversations(conversation_id), FOREIGN KEY(parent_checkpoint_id) REFERENCES conversation_checkpoints(checkpoint_id));
CREATE TABLE checkpoint_messages(checkpoint_id INTEGER NOT NULL, ordinal INTEGER NOT NULL, conversation_id TEXT NOT NULL, message_id TEXT NOT NULL, PRIMARY KEY(checkpoint_id, ordinal), UNIQUE(checkpoint_id, message_id), FOREIGN KEY(checkpoint_id) REFERENCES conversation_checkpoints(checkpoint_id), FOREIGN KEY(conversation_id, message_id) REFERENCES messages(conversation_id, message_id));
CREATE TABLE runs(run_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, base_checkpoint_id INTEGER NOT NULL, head_checkpoint_id INTEGER NOT NULL, parent_run_id TEXT, subagent_kind TEXT, status TEXT NOT NULL, turn_usage_json TEXT NOT NULL DEFAULT 'null', failure_category TEXT, failure_summary TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL, cursor_request_id TEXT, FOREIGN KEY(conversation_id) REFERENCES conversations(conversation_id), FOREIGN KEY(base_checkpoint_id) REFERENCES conversation_checkpoints(checkpoint_id), FOREIGN KEY(head_checkpoint_id) REFERENCES conversation_checkpoints(checkpoint_id));
CREATE TABLE tool_rounds(round_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, base_checkpoint_id INTEGER NOT NULL, assistant_json TEXT NOT NULL, status TEXT NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL, FOREIGN KEY(run_id) REFERENCES runs(run_id), FOREIGN KEY(base_checkpoint_id) REFERENCES conversation_checkpoints(checkpoint_id));
CREATE TABLE tool_round_calls(round_id TEXT NOT NULL, call_index INTEGER NOT NULL, call_id TEXT NOT NULL, model_call_id TEXT NOT NULL, arguments_json TEXT NOT NULL, status TEXT NOT NULL, result_content TEXT, result_is_error INTEGER, committed_checkpoint_id INTEGER, completed_at_ms INTEGER, argument_error TEXT, PRIMARY KEY(round_id, call_index), UNIQUE(round_id, call_id), FOREIGN KEY(round_id) REFERENCES tool_rounds(round_id), FOREIGN KEY(committed_checkpoint_id) REFERENCES conversation_checkpoints(checkpoint_id));
CREATE TABLE blobs(blob_id BLOB PRIMARY KEY, data BLOB NOT NULL, created_at_ms INTEGER NOT NULL);
CREATE TABLE blob_edges(parent_blob_id BLOB NOT NULL, child_blob_id BLOB NOT NULL, field_name TEXT NOT NULL, PRIMARY KEY(parent_blob_id, child_blob_id, field_name), FOREIGN KEY(parent_blob_id) REFERENCES blobs(blob_id), FOREIGN KEY(child_blob_id) REFERENCES blobs(blob_id));
CREATE TABLE llm_calls(call_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, conversation_id TEXT NOT NULL, provider_call_index INTEGER NOT NULL DEFAULT 0, model_hash TEXT, provider_type TEXT NOT NULL DEFAULT '', provider_url TEXT NOT NULL DEFAULT '', request_type TEXT NOT NULL DEFAULT '', request_url TEXT NOT NULL DEFAULT '', model_id TEXT NOT NULL DEFAULT '', display_name TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, finish_reason TEXT, created_at_ms INTEGER NOT NULL, request_started_at_ms INTEGER, response_headers_at_ms INTEGER, first_event_at_ms INTEGER, first_text_at_ms INTEGER, finished_at_ms INTEGER, queue_ms INTEGER, ttfb_ms INTEGER, ttft_ms INTEGER, duration_ms INTEGER, input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER, usage_json TEXT, message_count INTEGER NOT NULL DEFAULT 0, tool_count INTEGER NOT NULL DEFAULT 0, request_bytes INTEGER, response_bytes INTEGER NOT NULL DEFAULT 0, stream_event_count INTEGER NOT NULL DEFAULT 0, http_status INTEGER, error_kind TEXT, error_message TEXT, detailed INTEGER NOT NULL DEFAULT 0, reasoning_effort TEXT, fast INTEGER NOT NULL DEFAULT 0, first_valid_response_at_ms INTEGER, ttfr_ms INTEGER);
CREATE TABLE llm_call_requests(call_id TEXT PRIMARY KEY, headers_json TEXT NOT NULL, body_json TEXT NOT NULL, byte_count INTEGER NOT NULL, FOREIGN KEY(call_id) REFERENCES llm_calls(call_id) ON DELETE CASCADE);
CREATE TABLE cursor_run_traces(request_id TEXT PRIMARY KEY, status TEXT NOT NULL, received_at_ms INTEGER NOT NULL);
CREATE TABLE cursor_run_trace_artifacts(request_id TEXT NOT NULL, seq INTEGER NOT NULL, artifact_type TEXT NOT NULL, source TEXT NOT NULL, blob_id BLOB NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}', created_at_ms INTEGER NOT NULL, PRIMARY KEY(request_id, seq), FOREIGN KEY(request_id) REFERENCES cursor_run_traces(request_id) ON DELETE CASCADE, FOREIGN KEY(blob_id) REFERENCES blobs(blob_id));
CREATE TABLE model_configs(model_hash TEXT PRIMARY KEY, api_key TEXT NOT NULL);
CREATE TABLE service_settings(setting_key TEXT PRIMARY KEY, value_json TEXT NOT NULL);

INSERT INTO conversations VALUES ('conv-old', 1, 'run-old', ${old});
INSERT INTO conversations VALUES ('conv-new', 2, 'run-new', ${now});
INSERT INTO messages VALUES ('conv-old', 'msg-old-1', 'user', 'prompt', '{"text":"old one"}', NULL, ${old});
INSERT INTO messages VALUES ('conv-old', 'msg-old-2', 'assistant', 'assistant', '{"text":"old two"}', NULL, ${old});
INSERT INTO messages VALUES ('conv-new', 'msg-new-1', 'user', 'prompt', '{"text":"new"}', NULL, ${now});
INSERT INTO conversation_checkpoints(conversation_id, parent_checkpoint_id, state_digest, created_at_ms) VALUES ('conv-old', NULL, randomblob(32), ${old});
INSERT INTO conversation_checkpoints(conversation_id, parent_checkpoint_id, state_digest, created_at_ms) VALUES ('conv-new', NULL, randomblob(32), ${now});
INSERT INTO checkpoint_messages VALUES (1, 0, 'conv-old', 'msg-old-1');
INSERT INTO checkpoint_messages VALUES (1, 1, 'conv-old', 'msg-old-2');
INSERT INTO checkpoint_messages VALUES (2, 0, 'conv-new', 'msg-new-1');
INSERT INTO runs(run_id, conversation_id, base_checkpoint_id, head_checkpoint_id, status, created_at_ms, updated_at_ms) VALUES ('run-old', 'conv-old', 1, 1, 'completed', ${old}, ${old});
INSERT INTO runs(run_id, conversation_id, base_checkpoint_id, head_checkpoint_id, status, created_at_ms, updated_at_ms) VALUES ('run-new', 'conv-new', 2, 2, 'completed', ${now}, ${now});
UPDATE runs SET turn_usage_json = '{"total":10}' WHERE run_id = 'run-old';
INSERT INTO tool_rounds VALUES ('round-old', 'run-old', 1, '{"text":"round"}', 'settled', ${old}, ${old});
INSERT INTO tool_rounds VALUES ('round-new', 'run-new', 2, '{"text":"round"}', 'settled', ${now}, ${now});
INSERT INTO tool_round_calls(round_id, call_index, call_id, model_call_id, arguments_json, status, result_content, committed_checkpoint_id) VALUES ('round-old', 0, 'call-old', 'model-old', '{}', 'completed', 'result-old', 1);
INSERT INTO tool_round_calls(round_id, call_index, call_id, model_call_id, arguments_json, status, result_content, committed_checkpoint_id) VALUES ('round-new', 0, 'call-new', 'model-new', '{}', 'completed', 'result-new', 2);
INSERT INTO blobs VALUES (X'${BLOB_A}', 'shared content', ${old});
INSERT INTO blobs VALUES (X'${BLOB_B}', 'child content', ${now});
INSERT INTO blob_edges VALUES (X'${BLOB_A}', X'${BLOB_B}', 'root.child');
INSERT INTO llm_calls(call_id, run_id, conversation_id, model_id, display_name, provider_type, request_type, status, finish_reason, usage_json, created_at_ms, duration_ms, ttft_ms, input_tokens, output_tokens, total_tokens, cache_read_tokens, reasoning_tokens, http_status, error_kind, error_message) VALUES ('call-old', 'run-old', 'conv-old', 'group/opus', 'Opus', 'chat', 'chat_completions', 'completed', 'stop', '{"total":10}', ${old}, 1200, 300, 10, 5, 15, 4, 1, 200, NULL, '');
INSERT INTO llm_calls(call_id, run_id, conversation_id, model_id, display_name, provider_type, request_type, status, finish_reason, usage_json, created_at_ms, duration_ms, ttft_ms, input_tokens, output_tokens, total_tokens, cache_read_tokens, reasoning_tokens, http_status, error_kind, error_message) VALUES ('call-new', 'run-new', 'conv-new', 'group/sonnet', 'Sonnet', 'chat', 'chat_completions', 'failed', NULL, '{"total":20}', ${now}, 800, 200, 20, 0, 20, 2, 0, 401, 'gateway', 'HTTP 401 api_key=fake-secret');
INSERT INTO llm_call_requests VALUES ('call-old', '{}', '{}', 128);
INSERT INTO cursor_run_traces VALUES ('trace-1', 'completed', ${now});
INSERT INTO cursor_run_trace_artifacts VALUES ('trace-1', 0, 'request', 'cursor_client', X'${BLOB_B}', '{}', ${now});
INSERT INTO model_configs VALUES ('model', 'secret-api-key');
INSERT INTO service_settings VALUES ('setting', '{"value":1}');
`);
  return {home, dbPath};
}

test('migrated SQLite data retains sessions, content and integrity', {skip: SKIP}, async (t) => {
  const {home, dbPath} = fakeDatabase(t);
  const root = path.dirname(path.dirname(dbPath));
  const destination = path.join(home, 'portable-data');
  const before = query(dbPath, 'SELECT conversation_id FROM conversations ORDER BY conversation_id;');
  await migrateStorage(root, destination);
  const migrated = databasePath(resolveDataDir(root));
  assert.equal(query(migrated, 'SELECT conversation_id FROM conversations ORDER BY conversation_id;'), before);
  assert.equal(query(migrated, 'SELECT hex(data) AS content FROM blobs ORDER BY blob_id;'), query(dbPath, 'SELECT hex(data) AS content FROM blobs ORDER BY blob_id;'));
  assert.equal(execFileSync(SQLITE, ['-readonly', migrated, 'PRAGMA quick_check;'], {encoding: 'utf8'}).trim(), 'ok');
  assert.ok(fs.existsSync(dbPath), 'source database is retained');
});

test('Cursor Tab auth reads only the access token from the isolated profile', {skip: SKIP}, async (t) => {
  const {home} = fakeDatabase(t);
  const state = path.join(path.dirname(platform.current.cursorSettings(home)), 'globalStorage', 'state.vscdb');
  fs.mkdirSync(path.dirname(state), {recursive: true});
  sql(state, "CREATE TABLE ItemTable(key TEXT PRIMARY KEY, value TEXT); INSERT INTO ItemTable VALUES ('cursorAuth/refreshToken', 'refresh-only-test');");
  await assert.rejects(extractCursorAuthToken(home), /Access Token/);
  sql(state, "INSERT INTO ItemTable VALUES ('cursorAuth/accessToken', 'access-only-test'), ('cursorAuth/cachedEmail', 'test@example.com');");
  assert.deepEqual(await extractCursorAuthToken(home), {token: 'access-only-test', email: 'test@example.com'});
});

test('database overview groups tables and reports content sizes', {skip: SKIP}, async (t) => {
  const {dbPath} = fakeDatabase(t);
  const data = await readDatabase(dbPath);
  assert.equal(data.exists, true);
  assert.equal(data.page.pageSize, 4096);
  const categories = Object.fromEntries(data.categories.map((entry) => [entry.id, entry]));
  assert.equal(categories.sessions.tables.find((table) => table.name === 'conversations').rows, 2);
  assert.equal(categories.sessions.tables.find((table) => table.name === 'messages').rows, 3);
  assert.equal(categories.content.tables.find((table) => table.name === 'blobs').rows, 2);
  // The default pass skips blob bodies; only the deep pass measures them.
  assert.equal(categories.content.measured, false);
  assert.equal(categories.config.measured, false);
  assert.equal(data.conversations[0].id, 'conv-new');
  assert.equal(data.conversations.length, 2);
  assert.equal(data.totals.rows, 26);
  assert.equal(data.days.length, 2);
  assert.doesNotMatch(JSON.stringify(data), /secret-api-key/);

  const deep = await readDatabase(dbPath, {deep: true});
  const deepCategories = Object.fromEntries(deep.categories.map((entry) => [entry.id, entry]));
  assert.equal(deep.deep, true);
  assert.equal(deepCategories.content.measured, true);
  assert.ok(deep.totals.bytes > data.totals.bytes, 'deep pass adds blob body bytes');
  assert.equal(deep.totals.rows, data.totals.rows);
});

test('recent calls expose model, latency, tokens and redacted errors', {skip: SKIP}, async (t) => {
  const {dbPath} = fakeDatabase(t);
  const all = await readRecentCalls(dbPath, {limit: 10});
  assert.equal(all.exists, true);
  assert.deepEqual(all.calls.map((call) => call.id), ['call-new', 'call-old']);
  assert.equal(all.calls[0].model, 'Sonnet');
  assert.equal(all.calls[0].status, 'failed');
  assert.equal(all.calls[0].durationMs, 800);
  assert.equal(all.calls[0].totalTokens, 20);
  assert.equal(all.calls[0].httpStatus, 401);
  assert.match(all.calls[0].error, /HTTP 401/);
  assert.doesNotMatch(all.calls[0].error, /fake-secret/);
  assert.match(all.calls[0].error, /\[redacted\]/);
  const errors = await readRecentCalls(dbPath, {errorsOnly: true});
  assert.deepEqual(errors.calls.map((call) => call.id), ['call-new']);
  const missing = await readRecentCalls(path.join(path.dirname(dbPath), 'missing.db'));
  assert.equal(missing.exists, false);
});

test('read-only queries fall back when a WAL database lost its sidecars', {skip: SKIP}, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-bridge-wal-'));
  t.after(() => fs.rmSync(home, {recursive: true, force: true}));
  const dbPath = path.join(home, 'state.vscdb');
  // Cursor leaves its store in WAL mode and removes -wal/-shm on a clean exit;
  // a -readonly opener then cannot create the shared memory and every query
  // fails with SQLITE_CANTOPEN. Reproduce that exact end state.
  sql(dbPath, `
PRAGMA journal_mode=WAL;
CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT);
INSERT INTO kv VALUES ('a', 'alpha'), ('b', 'beta');
PRAGMA wal_checkpoint(TRUNCATE);`);
  fs.rmSync(`${dbPath}-wal`, {force: true});
  fs.rmSync(`${dbPath}-shm`, {force: true});

  const rows = JSON.parse(await sqlite(dbPath, 'SELECT key, value FROM kv ORDER BY key;', {readonly: true, json: true}));
  assert.deepEqual(rows, [{key: 'a', value: 'alpha'}, {key: 'b', value: 'beta'}]);

  // The fallback connection must still refuse writes, and the data file itself
  // must stay untouched (only the sidecars are recreated).
  const before = fs.statSync(dbPath);
  await assert.rejects(
    () => sqlite(dbPath, "INSERT INTO kv VALUES ('c', 'gamma');", {readonly: true}),
    /attempt to write a readonly database|readonly/i
  );
  const after = fs.statSync(dbPath);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);
  const count = JSON.parse(await sqlite(dbPath, 'SELECT COUNT(*) AS n FROM kv;', {readonly: true, json: true}));
  assert.equal(count[0].n, 2);

  // Once the fallback is remembered for this path, a deleted file must still
  // fail instead of being recreated as an empty database.
  fs.rmSync(dbPath, {force: true});
  fs.rmSync(`${dbPath}-wal`, {force: true});
  fs.rmSync(`${dbPath}-shm`, {force: true});
  await assert.rejects(() => sqlite(dbPath, 'SELECT 1;', {readonly: true}), /unable to open database file/i);
  assert.equal(fs.existsSync(dbPath), false);
});

test('read-only fallback never creates a missing database', {skip: SKIP}, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-bridge-missing-'));
  t.after(() => fs.rmSync(home, {recursive: true, force: true}));
  const dbPath = path.join(home, 'state.vscdb');
  await assert.rejects(() => sqlite(dbPath, 'SELECT 1;', {readonly: true}), /unable to open database file/i);
  assert.equal(fs.existsSync(dbPath), false);
});

test('concurrent cold-start reads wait out transient WAL locks', {skip: SKIP}, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-bridge-cold-'));
  t.after(() => fs.rmSync(home, {recursive: true, force: true}));
  const dbPath = path.join(home, 'bridge.db');
  sql(dbPath, `
PRAGMA journal_mode=WAL;
CREATE TABLE conversations(conversation_id TEXT PRIMARY KEY, updated_at_ms INTEGER NOT NULL);
CREATE TABLE messages(conversation_id TEXT, message_id TEXT, payload_json TEXT, created_at_ms INTEGER, PRIMARY KEY(conversation_id, message_id));
INSERT INTO conversations VALUES ('c1', 1);
INSERT INTO messages VALUES ('c1', 'm1', '{}', 1);
PRAGMA wal_checkpoint(TRUNCATE);`);
  // Every round drops the sidecars exactly like a clean Cursor exit, then runs
  // the query shape readDatabase() uses: one schema read followed by three
  // concurrent reads. Without the default busy_timeout some rounds failed with
  // "database is locked" (5) while the sidecars were being recreated.
  const read = (statement) => sqlite(dbPath, statement, {readonly: true, json: true}).then((text) => JSON.parse(text || '[]'));
  for (let round = 0; round < 30; round += 1) {
    fs.rmSync(`${dbPath}-wal`, {force: true});
    fs.rmSync(`${dbPath}-shm`, {force: true});
    await read("SELECT name FROM sqlite_master WHERE type = 'table';");
    const rows = await Promise.all([
      read('SELECT page_count FROM pragma_page_count;'),
      read('SELECT conversation_id, COUNT(*) AS n FROM messages GROUP BY conversation_id;'),
      read('SELECT COUNT(*) AS n FROM conversations;')
    ]);
    assert.equal(rows[1][0].n, 1, `round ${round} lost its rows`);
  }
});

test('session cleanup removes old conversations and keeps shared blobs', {skip: SKIP}, async (t) => {
  const {dbPath} = fakeDatabase(t);
  const result = await cleanDatabase(dbPath, {scope: 'sessions', olderThanDays: 5, vacuum: false});
  assert.equal(result.vacuumed, false);
  assert.equal(result.counts.conversations, 1);
  assert.equal(result.counts.messages, 2);
  assert.equal(result.counts.runs, 1);
  assert.equal(result.counts.tool_rounds, 1);
  assert.equal(result.counts.tool_round_calls, 1);
  assert.equal(result.counts.conversation_checkpoints, 1);
  const remaining = JSON.parse(query(dbPath, 'SELECT conversation_id FROM conversations;'));
  assert.deepEqual(remaining, [{conversation_id: 'conv-new'}]);
  assert.equal(Number(JSON.parse(query(dbPath, 'SELECT COUNT(*) AS n FROM blobs;'))[0].n), 2);
  assert.equal(Number(JSON.parse(query(dbPath, 'SELECT COUNT(*) AS n FROM llm_calls;'))[0].n), 2);
  assert.equal(query(dbPath, 'PRAGMA foreign_key_check;').trim(), '');
});

test('trace cleanup removes call logs but keeps conversations', {skip: SKIP}, async (t) => {
  const {dbPath} = fakeDatabase(t);
  const result = await cleanDatabase(dbPath, {scope: 'traces', vacuum: false});
  assert.equal(result.counts.llm_calls, 2);
  assert.equal(result.counts.llm_call_requests, 1);
  assert.equal(result.counts.cursor_run_traces, 1);
  assert.equal(result.counts.cursor_run_trace_artifacts, 1);
  assert.equal(Number(JSON.parse(query(dbPath, 'SELECT COUNT(*) AS n FROM llm_calls;'))[0].n), 0);
  assert.equal(Number(JSON.parse(query(dbPath, 'SELECT COUNT(*) AS n FROM cursor_run_traces;'))[0].n), 0);
  assert.equal(Number(JSON.parse(query(dbPath, 'SELECT COUNT(*) AS n FROM conversations;'))[0].n), 2);
  assert.equal(query(dbPath, 'PRAGMA foreign_key_check;').trim(), '');
});

test('full cleanup clears runtime data, keeps configuration, then vacuums', {skip: SKIP}, async (t) => {
  const {dbPath} = fakeDatabase(t);
  const result = await cleanDatabase(dbPath, {scope: 'all', vacuum: true});
  assert.equal(result.vacuumed, true);
  assert.equal(result.counts.conversations, 2);
  assert.equal(result.counts.blobs, 2);
  for (const table of ['conversations', 'messages', 'conversation_checkpoints', 'checkpoint_messages', 'runs', 'tool_rounds', 'tool_round_calls', 'blobs', 'blob_edges', 'llm_calls', 'cursor_run_traces', 'cursor_run_trace_artifacts']) {
    const row = JSON.parse(query(dbPath, `SELECT COUNT(*) AS n FROM ${table};`))[0];
    assert.equal(Number(row.n), 0, `${table} should be empty`);
  }
  assert.equal(Number(JSON.parse(query(dbPath, 'SELECT COUNT(*) AS n FROM model_configs;'))[0].n), 1);
  assert.equal(Number(JSON.parse(query(dbPath, 'SELECT COUNT(*) AS n FROM service_settings;'))[0].n), 1);
  assert.equal(query(dbPath, 'PRAGMA foreign_key_check;').trim(), '');
  assert.ok(fs.existsSync(dbPath));
});

test('destructive cleanup writes a recoverable backup and verifies the database', {skip: SKIP}, async (t) => {
  const {dbPath} = fakeDatabase(t);
  const backupDir = path.join(path.dirname(dbPath), 'backups');
  const result = await cleanDatabase(dbPath, {scope: 'sessions', olderThanDays: 5, vacuum: false, backup: true, backupDir});
  assert.equal(result.check, 'ok');
  assert.ok(result.backup?.file);
  assert.ok(fs.existsSync(result.backup.file));
  assert.ok(result.backup.size > 0);
  // The snapshot is taken before the deletes, so the removed conversation is
  // still recoverable from it.
  const rows = JSON.parse(execFileSync(SQLITE, ['-json', '-readonly', result.backup.file, 'SELECT conversation_id FROM conversations ORDER BY conversation_id;'], {encoding: 'utf8'}));
  assert.deepEqual(rows.map((row) => row.conversation_id), ['conv-new', 'conv-old']);
  assert.equal(JSON.parse(query(dbPath, "SELECT conversation_id FROM conversations;"))[0].conversation_id, 'conv-new');
  // Retention keeps only the newest snapshot.
  const again = await cleanDatabase(dbPath, {scope: 'traces', vacuum: false, backup: true, backupDir, keepBackups: 1});
  assert.equal(again.check, 'ok');
  assert.equal(again.backup?.pruned?.length, 1);
  assert.equal(fs.readdirSync(backupDir).length, 1);
});

test('retention prunes old traces and sessions while keeping recent data', {skip: SKIP}, async (t) => {
  const {dbPath} = fakeDatabase(t);
  const old = Date.now() - 20 * 86400000;
  sql(dbPath, `INSERT INTO cursor_run_traces VALUES ('trace-old', 'completed', ${old});`);
  const result = await pruneDatabase(dbPath, {tracesDays: 5, sessionsDays: 5, batchSize: 1});
  assert.equal(result.exists, true);
  assert.equal(result.calls, 1, 'only the old model call is removed');
  assert.equal(result.traces, 1, 'only the old Cursor trace is removed');
  assert.equal(result.sessions, 1, 'only the old conversation is removed');
  assert.equal(result.error, null);
  assert.equal(result.check, 'ok');
  assert.deepEqual(JSON.parse(query(dbPath, 'SELECT conversation_id FROM conversations;')), [{conversation_id: 'conv-new'}]);
  assert.equal(Number(JSON.parse(query(dbPath, "SELECT COUNT(*) AS n FROM llm_calls WHERE call_id = 'call-old';"))[0].n), 0);
  assert.equal(Number(JSON.parse(query(dbPath, "SELECT COUNT(*) AS n FROM llm_calls WHERE call_id = 'call-new';"))[0].n), 1);
  assert.equal(query(dbPath, 'PRAGMA foreign_key_check;').trim(), '');
});

test('retention with both scopes disabled is a no-op', {skip: SKIP}, async (t) => {
  const {dbPath} = fakeDatabase(t);
  const before = Number(JSON.parse(query(dbPath, 'SELECT COUNT(*) AS n FROM llm_calls;'))[0].n);
  const result = await pruneDatabase(dbPath, {tracesDays: 0, sessionsDays: 0});
  assert.equal(result.batches, 0);
  assert.equal(Number(JSON.parse(query(dbPath, 'SELECT COUNT(*) AS n FROM llm_calls;'))[0].n), before);
});

test('cleanup validates its scope and retention window', {skip: SKIP}, async (t) => {
  const {dbPath} = fakeDatabase(t);
  await assert.rejects(cleanDatabase(dbPath, {scope: 'everything'}), /未知的清理范围/);
  await assert.rejects(cleanDatabase(dbPath, {scope: 'sessions', olderThanDays: 0}), /1–3650/);
  await assert.rejects(cleanDatabase(path.join(path.dirname(dbPath), 'missing.db'), {scope: 'traces'}), /尚未创建/);
});

test('control console exposes database stats and cleanup routes', {skip: SKIP}, async (t) => {
  const {home, dbPath} = fakeDatabase(t);
  const root = platform.pathsFor(home).config;
  fs.writeFileSync(path.join(root, 'status.json'), JSON.stringify({
    version: '9.9.9', state: 'connected', updated: '2026-01-01T00:00:01.000Z'
  }));
  const previous = process.env.CURSOR_BRIDGE_HOME;
  process.env.CURSOR_BRIDGE_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.CURSOR_BRIDGE_HOME;
    else process.env.CURSOR_BRIDGE_HOME = previous;
  });
  const {server, port} = await createControlServer({repoRoot, port: 0, log: () => {}});
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const page = await new Promise((resolve, reject) => {
    http.get({host: '127.0.0.1', port, path: '/'}, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
  const token = page.match(/__BRIDGE_TOKEN__="([0-9a-f]{64})"/)[1];
  const headers = {'x-magpiebridge-token': token, 'content-type': 'application/json'};
  const call = (method, pathname, body) => new Promise((resolve, reject) => {
    const req = http.request({host: '127.0.0.1', port, path: pathname, method, headers}, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({status: res.statusCode, body: data}));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });

  const stats = await call('GET', '/api/database');
  assert.equal(stats.status, 200);
  const database = JSON.parse(stats.body).database;
  assert.equal(database.exists, true);
  assert.ok(database.categories.some((entry) => entry.id === 'sessions'));
  assert.ok(database.file.db > 0);
  assert.ok(fs.existsSync(dbPath));

  const calls = JSON.parse((await call('GET', '/api/calls?limit=10')).body);
  assert.equal(calls.ok, true);
  assert.equal(calls.calls.length, 2);
  assert.equal(calls.calls[0].model, 'Sonnet');
  assert.doesNotMatch(calls.calls[0].error, /fake-secret/);

  const bad = await call('POST', '/api/database/cleanup', JSON.stringify({scope: 'nope'}));
  assert.equal(bad.status, 400);

  const cleaned = await call('POST', '/api/database/cleanup', JSON.stringify({scope: 'traces', vacuum: false}));
  assert.equal(cleaned.status, 200);
  const result = JSON.parse(cleaned.body);
  assert.equal(result.ok, true);
  assert.equal(result.cleanup.counts.llm_calls, 2);
  assert.equal(result.cleanup.check, 'ok');
  assert.equal(result.cleanup.backup, null, 'diagnostics cleanup is not backed up by default');
  assert.equal(result.restart, null);

  const backed = await call('POST', '/api/database/cleanup', JSON.stringify({
    scope: 'sessions', olderThanDays: 5, vacuum: false, backup: true
  }));
  assert.equal(backed.status, 200);
  const backedResult = JSON.parse(backed.body);
  assert.equal(backedResult.cleanup.check, 'ok');
  assert.ok(backedResult.cleanup.backup?.file);
  assert.ok(fs.existsSync(backedResult.cleanup.backup.file));
});
