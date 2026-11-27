import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import platform, {cursorGlobalStorageFor, cursorWorkspaceStorageFor, cursorSettingsFor} from '../lib/platform.js';
import {execFileSync} from 'node:child_process';
import {
  cursorStorePaths,
  readStoreOverview,
  listWorkspaces,
  listComposers,
  readComposer,
  readSessionSizes,
  readKvValue,
  scanCategory,
  previewComposers,
  deleteComposers,
  vacuumStore,
  cursorRunning,
  CATEGORIES,
  OFFICIAL_ACTIONS
} from '../control/cursor-store.js';

// The fixture mirrors Cursor's own schema. Like database.test.js, seeding and
// inspection go through the sqlite3 CLI; Windows without it skips because the
// Magpie bun:sqlite fallback is unreachable from the Node test runner.
const SQLITE = platform.current.sqlite3();
const SKIP = SQLITE ? false : '需要 sqlite3 可执行文件';

const MAIN_A = '11111111-1111-4111-8111-111111111111';
const MAIN_B = '22222222-2222-4222-8222-222222222222';
const SUB_C = '33333333-3333-4333-8333-333333333333';
const WORKSPACE_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const WORKSPACE_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function sql(dbPath, statement) {
  return execFileSync(SQLITE, [dbPath], {input: statement, encoding: 'utf8'});
}

function query(dbPath, statement) {
  return execFileSync(SQLITE, ['-json', '-readonly', dbPath, statement], {encoding: 'utf8'});
}

function fakeStore(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-store-'));
  // Linux resolves Cursor's user dir from XDG_CONFIG_HOME before the home
  // argument, and Windows from APPDATA. Without this every fixture would land
  // in the same real database (the Ubuntu CI job caught exactly that).
  const saved = {};
  for (const key of ['XDG_CONFIG_HOME', 'APPDATA', 'LOCALAPPDATA']) saved[key] = process.env[key];
  if (process.platform === 'win32') {
    process.env.APPDATA = path.join(home, 'AppData', 'Roaming');
    process.env.LOCALAPPDATA = path.join(home, 'AppData', 'Local');
  } else if (process.platform !== 'darwin') {
    process.env.XDG_CONFIG_HOME = path.join(home, 'xdg-config');
  }
  t.after(() => {
    fs.rmSync(home, {recursive: true, force: true});
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
  const globalStorage = cursorGlobalStorageFor(home);
  const workspaceStorage = cursorWorkspaceStorageFor(home);
  fs.mkdirSync(globalStorage, {recursive: true});
  fs.mkdirSync(path.join(workspaceStorage, WORKSPACE_A), {recursive: true});
  fs.mkdirSync(path.join(workspaceStorage, WORKSPACE_B), {recursive: true});
  fs.writeFileSync(path.join(workspaceStorage, WORKSPACE_A, 'workspace.json'),
    JSON.stringify({folder: 'file:///Users/test/Code/alpha'}));
  fs.writeFileSync(path.join(workspaceStorage, WORKSPACE_B, 'workspace.json'),
    JSON.stringify({folder: 'file:///Users/test/Code/beta'}));
  const stateDb = path.join(globalStorage, 'state.vscdb');
  const bubble = (composerId, bubbleId, type, text, createdAt) => {
    const value = JSON.stringify({type, text, createdAt, toolResults: type === 2 ? [{}, {}] : []});
    return `INSERT INTO cursorDiskKV (key, value) VALUES ('bubbleId:${composerId}:${bubbleId}', '${value.replaceAll("'", "''")}');`;
  };
  const toolCall = (composerId, callId, name, target, createdAt) => {
    const value = JSON.stringify({
      type: 2,
      createdAt,
      toolFormerData: {name, status: 'completed', params: JSON.stringify({targetFile: target})}
    });
    return `INSERT INTO cursorDiskKV (key, value) VALUES ('bubbleId:${composerId}:${callId}', '${value.replaceAll("'", "''")}');`;
  };
  sql(stateDb, `
CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER, recency INTEGER, checkpointAt INTEGER, value TEXT, subagentTypeName TEXT);
CREATE INDEX idx_composerHeaders_1 ON composerHeaders (recency, composerId);
CREATE INDEX idx_composerHeaders_0 ON composerHeaders (workspaceId, isSubagent, isArchived, recency);

INSERT INTO composerHeaders VALUES ('${MAIN_A}', '${WORKSPACE_A}', 1000, 5000, 0, 0, 5000, 0, '{"name":"Alpha 会话","unifiedMode":"agent"}', NULL);
INSERT INTO composerHeaders VALUES ('${MAIN_B}', '${WORKSPACE_B}', 2000, 4000, 0, 0, 4000, 0, '{"name":"Beta 会话","unifiedMode":"chat"}', NULL);
INSERT INTO composerHeaders VALUES ('${SUB_C}', '${WORKSPACE_A}', 3000, 3000, 0, 1, 3000, 0, '{"name":"子代理任务","unifiedMode":"agent","subagentTypeName":"search"}', 'search');
INSERT INTO composerHeaders VALUES ('44444444-4444-4444-8444-444444444444', '${WORKSPACE_B}', 500, 500, 1, 0, 500, 0, '{"unifiedMode":"chat"}', NULL);

INSERT INTO cursorDiskKV (key, value) VALUES ('composerData:${MAIN_A}', '{"composerId":"${MAIN_A}","name":"Alpha 会话"}');
INSERT INTO cursorDiskKV (key, value) VALUES ('composerData:${MAIN_B}', '{"composerId":"${MAIN_B}"}');
INSERT INTO cursorDiskKV (key, value) VALUES ('composerData:${SUB_C}', '{"composerId":"${SUB_C}"}');
${bubble(MAIN_A, 'ffffffff-0000-4000-8000-000000000003', 2, '第三条', 3000)}
${bubble(MAIN_A, 'aaaaaaaa-0000-4000-8000-000000000002', 1, '第二条', 2000)}
${bubble(MAIN_A, '00000000-0000-4000-8000-000000000001', 1, '第一条', 1000)}
${bubble(SUB_C, '88888888-0000-4000-8000-000000000001', 2, '子代理回复', 1000)}
${bubble(MAIN_A, 'aaaaaaaa-0000-4000-8000-000000000002/s:0', 2, '第二条流式快照', 1500)}
${toolCall(MAIN_A, 'call_0001', 'read_file_v2', '/tmp/a.md', 2500)}
INSERT INTO cursorDiskKV (key, value) VALUES ('checkpointId:${MAIN_A}:cp1', 'checkpoint-body');
INSERT INTO cursorDiskKV (key, value) VALUES ('codeBlockDiff:${MAIN_A}:1', 'diff-body');
INSERT INTO cursorDiskKV (key, value) VALUES ('agentKv:blob:88888888aaaa', '${'blob'.repeat(500)}');
INSERT INTO cursorDiskKV (key, value) VALUES ('agentKv:blob:8aaaaaaaacccc', '${'blob'.repeat(500)}');
INSERT INTO cursorDiskKV (key, value) VALUES ('trashRow:unclassified', 'misc');
INSERT INTO ItemTable (key, value) VALUES ('workbench.panel.aichat.view', '{"layout":"right"}');
`);
  return {home, globalStorage, workspaceStorage, stateDb};
}

test('cursor paths follow the platform layout', () => {
  assert.equal(cursorSettingsFor('/home/u', 'darwin'), path.posix.join('/home/u', 'Library', 'Application Support', 'Cursor', 'User', 'settings.json'));
  assert.equal(cursorGlobalStorageFor('/home/u', 'darwin'), path.posix.join('/home/u', 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage'));
  // Pass an explicit environment: GitHub's Linux runners export
  // XDG_CONFIG_HOME, which would otherwise win over the /home/u argument.
  assert.equal(
    cursorWorkspaceStorageFor('/home/u', 'linux', {XDG_CONFIG_HOME: '/home/u/.config'}),
    path.posix.join('/home/u', '.config', 'Cursor', 'User', 'workspaceStorage')
  );
  assert.equal(
    cursorWorkspaceStorageFor('/home/u', 'linux', {}),
    path.posix.join('/home/u', '.config', 'Cursor', 'User', 'workspaceStorage')
  );
  assert.equal(
    cursorGlobalStorageFor('C:\\Users\\u', 'win32', {APPDATA: 'C:\\Users\\u\\AppData\\Roaming'}),
    path.win32.join('C:\\Users\\u\\AppData\\Roaming', 'Cursor', 'User', 'globalStorage')
  );
});

test('cursorStorePaths resolves state.vscdb beside globalStorage', () => {
  const paths = cursorStorePaths('/home/u');
  assert.equal(path.dirname(paths.stateDb), paths.globalStorage);
  assert.match(paths.stateDb, /state\.vscdb$/);
});

test('workspaceStorage maps workspace ids to folders', {skip: SKIP}, (t) => {
  const store = fakeStore(t);
  const workspaces = listWorkspaces(store.workspaceStorage);
  assert.equal(workspaces.length, 2);
  const alpha = workspaces.find((entry) => entry.id === WORKSPACE_A);
  assert.equal(alpha.folder, '/Users/test/Code/alpha');
  assert.equal(alpha.name, 'alpha');
});

test('overview reports file, pages and composer counts', {skip: SKIP}, async (t) => {
  const store = fakeStore(t);
  const data = await readStoreOverview(store.stateDb, {workspaceRoot: store.workspaceStorage});
  assert.equal(data.exists, true);
  assert.ok(data.file.size > 0);
  assert.equal(data.page.pageSize > 0, true);
  assert.equal(data.composers.total, 4);
  assert.equal(data.composers.subagents, 1);
  assert.equal(data.composers.archived, 1);
  assert.equal(data.composers.workspaces, 2);
  assert.equal(data.workspaces, 2);
  assert.ok(data.tables.includes('cursorDiskKV'));
});

test('overview degrades when the database is missing', async () => {
  const missing = path.join(os.tmpdir(), 'cursor-store-missing', 'state.vscdb');
  const data = await readStoreOverview(missing);
  assert.equal(data.exists, false);
  assert.equal(data.composers, null);
});

test('session list filters by kind and workspace', {skip: SKIP}, async (t) => {
  const store = fakeStore(t);
  const main = await listComposers(store.stateDb, {kind: 'main'});
  assert.equal(main.supported, true);
  assert.equal(main.total, 2);
  assert.deepEqual(main.sessions.map((row) => row.id), [MAIN_A, MAIN_B]);
  assert.equal(main.sessions[0].name, 'Alpha 会话');

  const subagents = await listComposers(store.stateDb, {kind: 'subagent'});
  assert.deepEqual(subagents.sessions.map((row) => row.id), [SUB_C]);
  assert.equal(subagents.sessions[0].subagent, true);

  const archived = await listComposers(store.stateDb, {kind: 'archived'});
  assert.equal(archived.total, 1);
  assert.equal(archived.sessions[0].archived, true);

  const alpha = await listComposers(store.stateDb, {kind: 'all', workspaceId: WORKSPACE_A});
  assert.deepEqual(alpha.sessions.map((row) => row.id).sort(), [MAIN_A, SUB_C].sort());

  const paged = await listComposers(store.stateDb, {kind: 'all', offset: 1, limit: 2});
  assert.equal(paged.sessions.length, 2);
  assert.equal(paged.total, 4);
});

test('session list filters by activity window', {skip: SKIP}, async (t) => {
  const store = fakeStore(t);
  const recent = await listComposers(store.stateDb, {kind: 'all', since: 3500});
  assert.deepEqual(recent.sessions.map((row) => row.id), [MAIN_A, MAIN_B]);

  const window = await listComposers(store.stateDb, {kind: 'all', since: 2500, until: 4500});
  assert.deepEqual(window.sessions.map((row) => row.id), [MAIN_B, SUB_C]);

  const older = await listComposers(store.stateDb, {kind: 'all', until: 1000});
  assert.deepEqual(older.sessions.map((row) => row.id), ['44444444-4444-4444-8444-444444444444']);

  // Malformed bounds are dropped instead of reaching the SQL text.
  const all = await listComposers(store.stateDb, {kind: 'all', since: "0 OR 1=1"});
  assert.equal(all.total, 4);
});

test('session detail orders messages by time, not key', {skip: SKIP}, async (t) => {
  const store = fakeStore(t);
  const data = await readComposer(store.stateDb, {id: MAIN_A});
  assert.equal(data.name, 'Alpha 会话');
  assert.equal(data.messageCount, 3);
  assert.deepEqual(data.messages.map((message) => message.preview), ['第一条', '第二条', '第三条']);
  assert.equal(data.messages[0].type, 1);
  assert.deepEqual(data.messages.map((message) => message.kind), ['message', 'message', 'message']);
  assert.ok(data.messageBytes > 0);
  assert.equal(data.composerBytes > 0, true);
  const page = await readComposer(store.stateDb, {id: MAIN_A, offset: 1, limit: 1});
  assert.equal(page.messages.length, 1);
  assert.equal(page.messages[0].preview, '第二条');
  await assert.rejects(() => readComposer(store.stateDb, {id: "x'; DROP TABLE t"}), /composerId 不合法/);
});

test('session sizes cover composer data and bubbles', {skip: SKIP}, async (t) => {
  const store = fakeStore(t);
  const data = await readSessionSizes(store.stateDb, [MAIN_A, SUB_C, "x' OR 1=1"]);
  // The size covers every row in the key range: chat messages, tool calls and
  // streamed fragments all occupy bytes on disk.
  assert.equal(data.sizes[MAIN_A].messages, 5);
  assert.ok(data.sizes[MAIN_A].bytes > 0);
  assert.equal(data.sizes[SUB_C].messages, 1);
  assert.equal(data.sizes["x' OR 1=1"], undefined);

  // The second call is served from the per-session cache with the same values.
  const again = await readSessionSizes(store.stateDb, [MAIN_A]);
  assert.deepEqual(again.sizes[MAIN_A], data.sizes[MAIN_A]);

  // A composer without bubbles still reports its composerData bytes.
  const unknown = await readSessionSizes(store.stateDb, ['44444444-4444-4444-8444-444444444444']);
  assert.equal(unknown.sizes['44444444-4444-4444-8444-444444444444'].messages, 0);
  assert.equal(typeof unknown.sizes['44444444-4444-4444-8444-444444444444'].bytes, 'number');
});

test('streamed fragments and tool calls stay out of the default list', {skip: SKIP}, async (t) => {
  const store = fakeStore(t);
  const data = await readComposer(store.stateDb, {id: MAIN_A});
  assert.equal(data.messageCount, 3);
  assert.equal(data.toolCount, 1);
  assert.equal(data.fragmentCount, 1);
  assert.equal(data.listTotal, 3);
  assert.deepEqual(data.messages.map((message) => message.kind), ['message', 'message', 'message']);

  const withTools = await readComposer(store.stateDb, {id: MAIN_A, includeTools: true});
  assert.equal(withTools.listTotal, 4);
  assert.deepEqual(withTools.messages.map((message) => message.preview),
    ['第一条', '第二条', 'a.md', '第三条']);
  const tool = withTools.messages.find((message) => message.kind === 'tool');
  assert.equal(tool.toolName, 'read_file_v2');
  assert.equal(tool.toolStatus, 'completed');
  assert.equal(tool.action, 'read');
  assert.equal(tool.verb, '读取');
  assert.equal(tool.target, 'a.md');
  assert.match(tool.preview, /a\.md/);
});

test('a closed Cursor store stays browsable and deletable', {skip: SKIP}, async (t) => {
  const store = fakeStore(t);
  // Cursor keeps state.vscdb in WAL mode and removes the -wal/-shm sidecars
  // when it exits; -readonly cannot recreate the shared memory, which used to
  // make the panel fail exactly when deleting was allowed. Every read below
  // runs against that end state.
  sql(store.stateDb, 'PRAGMA journal_mode=WAL; PRAGMA wal_checkpoint(TRUNCATE);');
  fs.rmSync(`${store.stateDb}-wal`, {force: true});
  fs.rmSync(`${store.stateDb}-shm`, {force: true});

  const data = await readStoreOverview(store.stateDb, {workspaceRoot: store.workspaceStorage});
  assert.equal(data.exists, true);
  assert.equal(data.composers.total, 4);
  assert.equal(data.page.journalMode, 'wal');

  const list = await listComposers(store.stateDb, {kind: 'main'});
  assert.deepEqual(list.sessions.map((row) => row.id), [MAIN_A, MAIN_B]);
  const detail = await readComposer(store.stateDb, {id: MAIN_A});
  assert.equal(detail.messageCount, 3);
  const scan = await scanCategory(store.stateDb, {category: 'messages', mode: 'exact'});
  assert.ok(scan.rows > 0);

  // The whole delete flow — preview included — works while Cursor is closed.
  const preview = await previewComposers(store.stateDb, [MAIN_A]);
  assert.equal(preview.kinds.composerHeaders.rows, 1);
  const deleted = await deleteComposers(store.stateDb, [MAIN_A]);
  assert.ok(deleted.totalRows >= 8);
  const remaining = await listComposers(store.stateDb, {kind: 'all'});
  assert.equal(remaining.total, 3);
});

test('session list filters by naming and mode', {skip: SKIP}, async (t) => {
  const store = fakeStore(t);
  const unnamed = await listComposers(store.stateDb, {kind: 'all', named: 'unnamed'});
  assert.deepEqual(unnamed.sessions.map((row) => row.id), ['44444444-4444-4444-8444-444444444444']);
  const named = await listComposers(store.stateDb, {kind: 'all', named: 'named'});
  assert.equal(named.total, 3);
  const agent = await listComposers(store.stateDb, {kind: 'all', mode: 'agent'});
  assert.deepEqual(agent.sessions.map((row) => row.id).sort(), [MAIN_A, SUB_C].sort());
  const chat = await listComposers(store.stateDb, {kind: 'all', mode: 'chat'});
  assert.deepEqual(chat.sessions.map((row) => row.id), [MAIN_B, '44444444-4444-4444-8444-444444444444']);
});

test('single values are read with a server-side cap', {skip: SKIP}, async (t) => {
  const store = fakeStore(t);
  const blob = await readKvValue(store.stateDb, {key: 'agentKv:blob:88888888aaaa'});
  assert.equal(blob.found, true);
  assert.equal(blob.table, 'cursorDiskKV');
  assert.equal(blob.truncated, false);

  const tiny = await readKvValue(store.stateDb, {key: 'agentKv:blob:88888888aaaa', maxBytes: 1024});
  assert.equal(tiny.truncated, true);
  assert.ok(tiny.text.length <= 1024);

  const settings = await readKvValue(store.stateDb, {key: 'workbench.panel.aichat.view'});
  assert.equal(settings.found, true);
  assert.equal(settings.table, 'ItemTable');
  assert.match(settings.text, /layout/);

  const fragment = await readKvValue(store.stateDb, {key: `bubbleId:${MAIN_A}:aaaaaaaa-0000-4000-8000-000000000002/s:0`});
  assert.equal(fragment.found, true);
  assert.equal(fragment.truncated, false);

  const missing = await readKvValue(store.stateDb, {key: 'composerData:missing'});
  assert.equal(missing.found, false);
  await assert.rejects(() => readKvValue(store.stateDb, {key: "bubbleId:x' OR '1'='1"}), /key 含有非法字符/);
});

test('category scans count rows and bytes', {skip: SKIP}, async (t) => {
  const store = fakeStore(t);
  const blobs = await scanCategory(store.stateDb, {category: 'agentBlobs', mode: 'exact'});
  assert.equal(blobs.rows, 2);
  assert.ok(blobs.bytes > 600);
  assert.equal(blobs.sampled, false);

  const messages = await scanCategory(store.stateDb, {category: 'messages', mode: 'exact'});
  assert.equal(messages.rows, 6);
  assert.ok(messages.bytes > 0);

  const diffs = await scanCategory(store.stateDb, {category: 'diffs'});
  assert.equal(diffs.rows, 1);

  const item = await scanCategory(store.stateDb, {category: 'itemTable'});
  assert.equal(item.rows, 1);
  assert.ok(item.bytes > 0);

  await assert.rejects(() => scanCategory(store.stateDb, {category: 'nope'}), /未知的统计类别/);
});

test('heavy categories sample one hex bucket and scale by sixteen', {skip: SKIP}, async (t) => {
  const store = fakeStore(t);
  // Fixture keys live in the '8' bucket only, so the estimate must scale the
  // sampled rows back to the full set.
  const estimate = await scanCategory(store.stateDb, {category: 'agentBlobs', mode: 'estimate'});
  assert.equal(estimate.sampled, true);
  assert.equal(estimate.rows, 2 * 16);
  const exact = await scanCategory(store.stateDb, {category: 'agentBlobs', mode: 'exact'});
  assert.equal(exact.rows, 2);
});

test('delete preview counts every row that belongs to the conversation', {skip: SKIP}, async (t) => {
  const store = fakeStore(t);
  const preview = await previewComposers(store.stateDb, [MAIN_A]);
  assert.deepEqual(preview.ids, [MAIN_A]);
  assert.equal(preview.kinds.exact.rows, 1);
  assert.equal(preview.kinds.bubbleId.rows, 5);
  assert.equal(preview.kinds.checkpointId.rows, 1);
  assert.equal(preview.kinds.codeBlockDiff.rows, 1);
  assert.equal(preview.kinds.composerHeaders.rows, 1);
  assert.ok(preview.totalBytes > 0);
  assert.equal(preview.headers, 1);
});

test('delete removes only the selected conversation', {skip: SKIP}, async (t) => {
  const store = fakeStore(t);
  const result = await deleteComposers(store.stateDb, [MAIN_A]);
  assert.ok(result.totalRows >= 8);

  const leftovers = JSON.parse(query(store.stateDb, `SELECT key FROM cursorDiskKV WHERE key LIKE '%${MAIN_A}%';`) || '[]');
  assert.deepEqual(leftovers, []);
  const header = JSON.parse(query(store.stateDb, `SELECT COUNT(*) AS n FROM composerHeaders WHERE composerId = '${MAIN_A}';`));
  assert.equal(header[0].n, 0);

  // Neighbouring conversations are untouched.
  const sub = await readComposer(store.stateDb, {id: SUB_C});
  assert.equal(sub.messageCount, 1);
  const beta = await listComposers(store.stateDb, {kind: 'all'});
  assert.equal(beta.total, 3);

  await assert.rejects(() => deleteComposers(store.stateDb, []), /未选择会话/);
  await assert.rejects(() => deleteComposers(store.stateDb, ['x\'; DROP TABLE t']), /composerId 不合法/);
});

test('vacuum rewrites the database and reports the size change', {skip: SKIP}, async (t) => {
  const store = fakeStore(t);
  await deleteComposers(store.stateDb, [MAIN_A, MAIN_B, SUB_C]);
  const result = await vacuumStore(store.stateDb);
  assert.ok(result.after > 0);
  assert.ok(result.after <= result.before);
  assert.ok(result.elapsedMs >= 0);
});

test('cursorRunning always resolves to a boolean', async () => {
  assert.equal(typeof await cursorRunning(), 'boolean');
});

test('every category declares prefixes or a table', () => {
  for (const category of CATEGORIES) {
    assert.ok(category.id && category.label, `category ${category.id} needs a label`);
    assert.ok(Array.isArray(category.prefixes) || category.table, `category ${category.id} needs prefixes`);
  }
  assert.equal(OFFICIAL_ACTIONS.length, 3);
  for (const action of OFFICIAL_ACTIONS) {
    assert.match(action.command, /^developer\./);
    assert.ok(action.palette);
  }
});