import fs from 'node:fs';
import os from 'node:os';
import {execFile} from 'node:child_process';
import path from 'node:path';
import platform from '../lib/platform.js';
import {sqlite, quoteText} from './database.js';

// Cursor's own state.vscdb on this machine is tens of gigabytes, so every
// query here is chosen for its access path:
//
//  - composerHeaders is a real table with (recency, composerId) and
//    (workspaceId, ...) indexes; the whole table is ~13 MB, so the session
//    list is a bounded indexed read.
//  - one conversation is `composerData:<id>` plus a key range
//    `bubbleId:<id>:`; both are primary-key seeks/ranges (milliseconds).
//  - byte totals cannot avoid reading value pages. Cursor solves this with a
//    forked worker and a 900 s timeout; here the same scan is explicit,
//    per-category, and cached, never triggered by merely opening the panel.
//
// Read paths open the database with -readonly. SQLite in WAL mode lets a
// reader coexist with Cursor's writer, so browsing works while Cursor runs.
// Writes (conversation delete, VACUUM) are explicit, confirmed actions and
// are refused while a Cursor process is alive.
const FAST_TIMEOUT = 15000;
const SCAN_TIMEOUT = 600000;
const MESSAGE_CAP = 1500;
const VALUE_LIMIT = 512 * 1024;
const SESSION_LIMIT = 100;
const SESSION_PAGE = 50;

// The category prefixes mirror Cursor's storageSizeScanMain so the panel and
// Cursor's built-in breakdown describe the same rows. `heavy` marks the two
// categories whose totals need a full value scan; everything else finishes in
// seconds.
export const CATEGORIES = [
  {id: 'agentBlobs', label: 'Agent 内容块', hint: 'agentKv:blob:* · 工具结果与对话状态', prefixes: ['agentKv:blob:'], heavy: true},
  {id: 'agentCheckpoints', label: 'Agent 检查点', hint: 'agentKv:checkpoint:* / bubbleCheckpoint:*', prefixes: ['agentKv:checkpoint:', 'agentKv:bubbleCheckpoint:']},
  {id: 'agentArtifacts', label: 'Agent 产物', hint: 'agentKv:artifact:*', prefixes: ['agentKv:artifact:']},
  {id: 'chats', label: '会话数据', hint: 'composerData、请求上下文与 sidecar', prefixes: ['composerData:', 'composerConversationState:', 'composerConvHeaders:', 'messageRequestContext:'], heavy: true},
  {id: 'messages', label: '消息正文', hint: 'bubbleId:*', prefixes: ['bubbleId:'], heavy: true},
  {id: 'checkpoints', label: '文件检查点', hint: 'checkpointId:*', prefixes: ['checkpointId:'], heavy: true},
  {id: 'diffs', label: '代码差异', hint: 'codeBlockDiff / inlineDiff', prefixes: ['codeBlockPartialInlineDiffFates:', 'codeBlockDiff:', 'inlineDiffUndoRedo', 'inlineDiff']},
  {id: 'cloudAgents', label: '云端代理缓存', hint: 'bcCachedDetails / cloudAgent', prefixes: ['bcCachedDetails:', 'cloudAgent:']},
  {id: 'itemTable', label: '设置与索引', hint: 'ItemTable 中的 VS Code / Cursor 键值', table: 'ItemTable'}
];

// Cursor ships these as Developer commands; the panel links to them instead
// of reimplementing the reference analysis behind agent blob GC.
export const OFFICIAL_ACTIONS = [
  {
    id: 'deleteOldChats',
    title: '删除旧聊天',
    command: 'developer.deleteOldChats',
    palette: 'Developer: Delete Old Chats',
    hint: '按天数删除旧会话与消息；仍在工作区会话列表中的聊天会被保护。'
  },
  {
    id: 'gcAgentKvBlobs',
    title: '回收 Agent 内容块',
    command: 'developer.gcAgentKvBlobs',
    palette: 'Developer: GC Agent KV Blobs',
    hint: '遍历活跃会话，删除未被引用的 agent blob、检查点与产物。'
  },
  {
    id: 'reclaimFreeSpace',
    title: '回收空闲页',
    command: 'developer.reclaimFreeSpace',
    palette: 'Developer: Reclaim Free Space',
    hint: '执行增量回收与 WAL checkpoint；剩余空间由数据库重写返还给系统。'
  }
];

export function cursorStorePaths(home = os.homedir()) {
  const globalStorage = platform.current.cursorGlobalStorage(home);
  const workspaceStorage = platform.current.cursorWorkspaceStorage(home);
  return {globalStorage, workspaceStorage, stateDb: path.join(globalStorage, 'state.vscdb')};
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
    return {exists: true, size: info.size, updated: info.mtime.toISOString()};
  } catch {
    return {exists: false, size: 0, updated: null};
  }
}

function sidecars(stateDb) {
  const wal = fileInfo(`${stateDb}-wal`);
  const shm = fileInfo(`${stateDb}-shm`);
  return {wal: wal.size, shm: shm.size};
}

// composerId is a UUID, workspaceId a bare hex hash. Both are embedded in
// SQL through quoteText, but rejecting quotes and wildcards up front keeps a
// bad query from ever being built.
function safeId(value, label = 'id') {
  const text = String(value || '');
  if (!/^[0-9A-Za-z._-]{1,96}$/.test(text)) throw new Error(`${label} 不合法`);
  return text;
}

// Time filters arrive as epoch milliseconds from the panel. Values outside
// 1970–2100 are treated as "no bound" rather than trusted into the SQL.
function safeTimestamp(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number < 4102444800000 ? Math.floor(number) : 0;
}

function safeKey(value) {
  const text = String(value || '');
  if (text.length < 3 || text.length > 300) throw new Error('key 长度不合法');
  // Printable ASCII only; quotes, backslashes and GLOB wildcards are the only
  // characters that could alter the generated SQL and real keys never contain
  // them. Streamed bubble snapshots do carry '/s:<n>' suffixes, so '/' and the
  // base64 alphabet (+ =) must stay valid.
  if (!/^[\x21-\x7E]+$/.test(text) || /['"\\*?[\]]/.test(text)) {
    throw new Error('key 含有非法字符');
  }
  return text;
}

function globLiteral(prefix) {
  return String(prefix).replaceAll('[', '[[]').replaceAll('*', '[*]').replaceAll('?', '[?]');
}

function fileTables(stateDb) {
  return sqlite(stateDb, "SELECT name FROM sqlite_master WHERE type = 'table';", {
    readonly: true,
    json: true,
    timeout: FAST_TIMEOUT,
    busyTimeout: 5000
  }).then((text) => new Set(parseJson(text).map((row) => String(row.name || ''))));
}

function readWorkspaceFolder(directory) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(directory, 'workspace.json'), 'utf8'));
    const uri = typeof raw?.folder === 'string' ? raw.folder : '';
    if (!uri) return '';
    const plain = uri.replace(/^file:\/\//, '');
    try {
      return decodeURIComponent(plain);
    } catch {
      return plain;
    }
  } catch {
    return '';
  }
}

// 117 workspaces on a mature install; each workspace.json is a few hundred
// bytes, so the whole map is cheaper than caching it.
export function listWorkspaces(workspaceRoot) {
  if (!workspaceRoot) return [];
  let entries;
  try {
    entries = fs.readdirSync(workspaceRoot, {withFileTypes: true});
  } catch {
    return [];
  }
  const workspaces = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const folder = readWorkspaceFolder(path.join(workspaceRoot, entry.name));
    workspaces.push({id: entry.name, folder, name: folder ? path.basename(folder) || folder : entry.name});
  }
  return workspaces.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export async function readStoreOverview(stateDb, {workspaceRoot} = {}) {
  const file = fileInfo(stateDb);
  if (!file.exists) {
    return {exists: false, path: stateDb, file: {...file, wal: 0, shm: 0}, composers: null, page: null, tables: []};
  }
  const tables = await fileTables(stateDb);
  const hasHeaders = tables.has('composerHeaders');
  const headerStats = hasHeaders
    ? parseJson(await sqlite(stateDb, `
SELECT COUNT(*) AS composers,
       COALESCE(SUM(isSubagent), 0) AS subagents,
       COALESCE(SUM(isArchived), 0) AS archived,
       COUNT(DISTINCT workspaceId) AS workspaces,
       MIN(createdAt) AS firstCreated,
       MAX(lastUpdatedAt) AS lastUpdated
FROM composerHeaders;`, {readonly: true, json: true, timeout: FAST_TIMEOUT, busyTimeout: 5000}))[0] || {}
    : {};
  const page = parseJson(await sqlite(stateDb, `
SELECT (SELECT page_size FROM pragma_page_size) AS pageSize,
       (SELECT page_count FROM pragma_page_count) AS pageCount,
       (SELECT freelist_count FROM pragma_freelist_count) AS freelistCount,
       (SELECT journal_mode FROM pragma_journal_mode) AS journalMode;`,
  {readonly: true, json: true, timeout: FAST_TIMEOUT, busyTimeout: 5000}))[0] || {};
  const extras = sidecars(stateDb);
  const pageSize = Number(page.pageSize) || 4096;
  const pageCount = Number(page.pageCount) || 0;
  return {
    exists: true,
    path: stateDb,
    file: {exists: true, size: file.size, updated: file.updated, wal: extras.wal, shm: extras.shm},
    free: storeFreeSpace(stateDb),
    page: {
      pageSize,
      pageCount,
      totalBytes: pageSize * pageCount,
      freelistCount: Number(page.freelistCount) || 0,
      journalMode: typeof page.journalMode === 'string' ? page.journalMode : null
    },
    composers: hasHeaders ? {
      total: Number(headerStats.composers) || 0,
      subagents: Number(headerStats.subagents) || 0,
      archived: Number(headerStats.archived) || 0,
      workspaces: Number(headerStats.workspaces) || 0,
      firstCreated: Number(headerStats.firstCreated) || null,
      lastUpdated: Number(headerStats.lastUpdated) || null
    } : null,
    tables: [...tables].sort(),
    workspaces: workspaceRoot ? listWorkspaces(workspaceRoot).length : null
  };
}
export async function listComposers(stateDb, {workspaceId = '', kind = 'all', named = 'all', mode = '', since = 0, until = 0, offset = 0, limit = SESSION_PAGE} = {}) {
  const tables = await fileTables(stateDb);
  if (!tables.has('composerHeaders')) {
    return {supported: false, total: 0, offset: 0, limit: SESSION_PAGE, sessions: []};
  }
  const where = [];
  if (workspaceId) where.push(`workspaceId = ${quoteText(safeId(workspaceId, 'workspaceId'))}`);
  if (kind === 'main') where.push('isSubagent = 0 AND isArchived = 0');
  else if (kind === 'subagent') where.push('isSubagent = 1');
  else if (kind === 'archived') where.push('isArchived = 1');
  if (named === 'named') where.push("COALESCE(json_extract(value, '$.name'), '') != ''");
  else if (named === 'unnamed') where.push("COALESCE(json_extract(value, '$.name'), '') = ''");
  if (['agent', 'chat', 'multitask'].includes(mode)) {
    where.push(`json_extract(value, '$.unifiedMode') = ${quoteText(mode)}`);
  }
  // A handful of migrated rows carry lastUpdatedAt = 0; they fall back to
  // createdAt so older conversations stay visible in a time window.
  const activity = 'COALESCE(NULLIF(lastUpdatedAt, 0), createdAt)';
  const sinceMs = safeTimestamp(since);
  const untilMs = safeTimestamp(until);
  if (sinceMs) where.push(`${activity} >= ${sinceMs}`);
  if (untilMs) where.push(`${activity} <= ${untilMs}`);
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const size = Math.max(1, Math.min(SESSION_LIMIT, Number(limit) || SESSION_PAGE));
  const start = Math.max(0, Number(offset) || 0);
  const options = {readonly: true, json: true, timeout: FAST_TIMEOUT, busyTimeout: 5000};
  const [rows, totals] = await Promise.all([
    sqlite(stateDb, `
SELECT composerId, workspaceId, createdAt, lastUpdatedAt, isSubagent, isArchived,
       json_extract(value, '$.name') AS name,
       json_extract(value, '$.unifiedMode') AS mode
FROM composerHeaders
${clause}
ORDER BY recency DESC
LIMIT ${size} OFFSET ${start};`, options),
    sqlite(stateDb, `SELECT COUNT(*) AS total FROM composerHeaders ${clause};`, options)
  ]);
  return {
    supported: true,
    total: Number(parseJson(totals)[0]?.total) || 0,
    offset: start,
    limit: size,
    sessions: parseJson(rows).map((row) => ({
      id: String(row.composerId || ''),
      workspaceId: String(row.workspaceId || ''),
      name: String(row.name || ''),
      mode: String(row.mode || ''),
      createdAt: Number(row.createdAt) || 0,
      lastUpdatedAt: Number(row.lastUpdatedAt) || 0,
      subagent: Number(row.isSubagent) === 1,
      archived: Number(row.isArchived) === 1
    }))
  };
}

// Cursor renders a tool step as one line: a completed-state verb plus a
// compact target (file name, glob, pattern, command). The mapping below
// mirrors its toolStatusText/agent-conversation-phrase-copy sources so the
// panel reads the same way instead of dumping toolFormerData JSON.
const TOOL_ACTIONS = {
  read_file: 'read', read_file_v2: 'read', read_file_v3: 'read',
  edit_file: 'edit', edit_file_v2: 'edit', reapply: 'edit', apply_patch: 'edit',
  delete_file: 'delete',
  run_terminal_command: 'shell', run_terminal_command_v2: 'shell', write_shell_stdin: 'shell',
  glob_file_search: 'search', file_search: 'search', codebase_search: 'search',
  semantic_search_full: 'search', read_semsearch_files: 'search',
  ripgrep_search: 'grep', ripgrep_raw_search: 'grep', grep_search: 'grep',
  list_dir: 'list', list_dir_v2: 'list',
  task: 'task', task_v2: 'task', await_task: 'task',
  ask_question: 'ask',
  web_search: 'web', web_fetch: 'fetch',
  read_lints: 'lints',
  update_todos: 'todos', read_todos: 'todos', update_current_step: 'step',
  create_plan: 'plan',
  call_mcp_tool: 'mcp', get_mcp_tools: 'mcp', list_mcp_resources: 'mcp', read_mcp_resource: 'mcp'
};

const TOOL_VERBS = {
  read: ['读取中', '读取', '尝试读取'],
  edit: ['编辑中', '编辑', '尝试编辑'],
  delete: ['删除中', '删除', '尝试删除'],
  shell: ['执行中', '执行命令', '尝试执行'],
  search: ['搜索中', '搜索文件', '尝试搜索'],
  grep: ['搜索中', '搜索内容', '尝试搜索'],
  list: ['读取中', '列出目录', '尝试列出'],
  task: ['执行中', '子代理', '子代理未完成'],
  ask: ['提问中', '提问', '提问未完成'],
  web: ['搜索中', '搜索网页', '尝试搜索'],
  fetch: ['抓取中', '抓取网页', '尝试抓取'],
  lints: ['读取中', '读取诊断', '尝试读取'],
  todos: ['更新中', '更新待办', '更新待办未完成'],
  step: ['更新中', '更新进度', '更新进度未完成'],
  plan: ['编写中', '制定计划', '制定计划未完成'],
  mcp: ['调用中', 'MCP 调用', 'MCP 调用未完成'],
  other: ['执行中', '执行', '执行未完成']
};

function stripAnsi(text) {
  return String(text || '')
    .replace(/\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[@-_]/g, '');
}

function toolAction(name) {
  const key = String(name || '').toLowerCase();
  if (TOOL_ACTIONS[key]) return TOOL_ACTIONS[key];
  if (key.startsWith('mcp') || key.includes('_mcp_')) return 'mcp';
  if (key.startsWith('read_file')) return 'read';
  if (key.startsWith('edit_file')) return 'edit';
  if (key.startsWith('run_terminal')) return 'shell';
  if (key.includes('search') || key.includes('grep')) return 'search';
  if (key.startsWith('list_dir')) return 'list';
  if (key.startsWith('task')) return 'task';
  return 'other';
}

function basenameOf(value) {
  const parts = String(value || '').replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

function oneLine(text, max = 90) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function toolTarget(action, params) {
  switch (action) {
    case 'read': {
      const file = basenameOf(params.targetFile || params.path || params.relativeWorkspacePath);
      if (!file) return '';
      if (params.offset !== undefined && params.limit !== undefined) {
        return `${file} L${params.offset}-${Number(params.offset) + Number(params.limit)}`;
      }
      return file;
    }
    case 'edit':
    case 'delete':
      return basenameOf(params.relativeWorkspacePath || params.targetFile || params.path);
    case 'shell':
      return oneLine(params.command, 100);
    case 'search':
      return oneLine(params.globPattern || params.query || params.searchTerm || params.targetDirectory, 90);
    case 'grep': {
      const pattern = oneLine(params.pattern, 60);
      const path = basenameOf(params.path);
      return path ? `${pattern} in ${path}` : pattern;
    }
    case 'list':
      return oneLine(params.targetDirectory || params.directoryPath, 90);
    case 'task':
      return oneLine(params.description || params.prompt, 80);
    case 'ask':
      return oneLine(params.title || params.question, 80);
    case 'web':
      return oneLine(params.searchTerm || params.query, 80);
    case 'fetch':
      return oneLine(params.url, 100);
    case 'lints':
      return basenameOf(params.path || params.file);
    case 'mcp':
      return oneLine(params.toolName || params.name || params.server || params.tool, 60);
    default:
      return '';
  }
}

function toolResultText(tool) {
  const result = parseMaybeJson(tool.result);
  if (!result) return typeof tool.result === 'string' ? stripAnsi(tool.result) : '';
  if (typeof result.output === 'string') return stripAnsi(result.output);
  if (typeof result.content === 'string') return result.content;
  if (typeof result.stdout === 'string') return stripAnsi(result.stdout);
  return JSON.stringify(result);
}

function parseMaybeJson(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try { return JSON.parse(value); } catch { return null; }
}

function clip(text, max = 400) {
  const value = String(text || '');
  return {text: value.slice(0, max), truncated: value.length > max};
}

// Two kinds of rows live under `bubbleId:<composerId>:`: chat messages (UUID
// ids, body in `text` / `codeBlocks`) and agent tool calls (`call_*` ids, body
// in `toolFormerData`). Streamed `/s:<n>` snapshots are filtered in SQL before
// this runs; they duplicate the final message and would flood the list.
function summarizeBubble(key, raw) {
  const text = String(raw ?? '');
  const tail = key.slice(key.lastIndexOf(':') + 1);
  const isToolId = tail.startsWith('call_');
  const bytes = Buffer.byteLength(text);
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* keep raw */ }
  if (!parsed) {
    const body = clip(text);
    return {
      key,
      kind: isToolId ? 'tool' : 'message',
      type: null,
      createdAt: 0,
      bytes,
      preview: body.text,
      truncated: body.truncated,
      thinking: 0,
      toolName: '',
      toolStatus: ''
    };
  }
  const tool = parsed.toolFormerData && typeof parsed.toolFormerData === 'object' ? parsed.toolFormerData : null;
  const createdAt = Number(parsed.createdAt) || Number(parsed.startedAtMs) || 0;
  if (tool) {
    const params = parseMaybeJson(tool.params) || {};
    const toolName = String(tool.name || '');
    const status = String(tool.status || '');
    const action = toolAction(toolName);
    const verbs = TOOL_VERBS[action] || TOOL_VERBS.other;
    const verb = status === 'error' || status === 'cancelled' ? verbs[2] : (status === 'completed' ? verbs[1] : verbs[0]);
    const target = toolTarget(action, params);
    return {
      key,
      kind: 'tool',
      type: parsed.type ?? null,
      createdAt,
      bytes,
      preview: target,
      truncated: false,
      thinking: 0,
      toolName,
      toolStatus: status,
      action,
      verb,
      target,
      paramsPreview: clip(JSON.stringify(params, null, 2), 500).text,
      resultPreview: clip(toolResultText(tool), 700).text
    };
  }
  let body = '';
  if (typeof parsed.text === 'string') body = parsed.text;
  // Assistant messages often carry the visible answer in codeBlocks when
  // `text` is empty; old conversations keep tool output in toolResults.
  if (!body && Array.isArray(parsed.codeBlocks)) {
    body = parsed.codeBlocks.map((block) => String(block?.content || '')).filter(Boolean).join('\n');
  }
  if (!body && Array.isArray(parsed.toolResults)) {
    body = parsed.toolResults.map((item) => String(item?.content || item?.text || '')).filter(Boolean).join('\n');
  }
  const clipped = clip(body);
  return {
    key,
    kind: 'message',
    type: parsed.type ?? null,
    createdAt,
    bytes,
    preview: clipped.text,
    truncated: clipped.truncated,
    thinking: Array.isArray(parsed.allThinkingBlocks) ? parsed.allThinkingBlocks.length : 0,
    toolName: '',
    toolStatus: ''
  };
}

// One conversation is a composerData row plus a primary-key range of bubbles.
// Bubbles are read in a single bounded batch (1,500 rows ≈ 12 MB on mature
// sessions) because bubble keys are random UUIDs: paging by key would scramble
// the chronological order that createdAt provides.
export async function readComposer(stateDb, {id, offset = 0, limit = 30, includeTools = false} = {}) {
  const composerId = safeId(id, 'composerId');
  const tables = await fileTables(stateDb);
  if (!tables.has('composerHeaders')) throw new Error('当前 Cursor 版本没有 composerHeaders 表，无法读取会话');
  if (!tables.has('cursorDiskKV')) throw new Error('当前 Cursor 版本没有 cursorDiskKV 表，无法读取会话');
  const options = {readonly: true, json: true, timeout: FAST_TIMEOUT, busyTimeout: 5000};
  const headerRows = parseJson(await sqlite(stateDb, `
SELECT composerId, workspaceId, createdAt, lastUpdatedAt, isSubagent, isArchived,
       json_extract(value, '$.name') AS name,
       json_extract(value, '$.unifiedMode') AS mode
FROM composerHeaders WHERE composerId = ${quoteText(composerId)};`, options));
  const header = headerRows[0];
  if (!header) throw new Error('会话不存在或已删除');
  const dataRows = parseJson(await sqlite(stateDb, `
SELECT length(value) AS bytes
FROM cursorDiskKV WHERE key = ${quoteText(`composerData:${composerId}`)};`, options));
  const lo = quoteText(`bubbleId:${composerId}:`);
  const hi = quoteText(`bubbleId:${composerId};`);
  // `/s:<n>` rows are streamed snapshots of a message that also has a final
  // row; they are counted but never listed. `call_*` rows are agent tool
  // calls and only join the list when the panel asks for them.
  const bubbleRows = parseJson(await sqlite(stateDb, `
SELECT key, value FROM cursorDiskKV
WHERE key >= ${lo} AND key < ${hi} AND key NOT LIKE '%/s:%'
ORDER BY key
LIMIT ${MESSAGE_CAP + 1};`, {...options, timeout: 30000, maxBuffer: 96 * 1024 * 1024}));
  const fragmentRows = parseJson(await sqlite(stateDb, `
SELECT COUNT(*) AS n FROM cursorDiskKV
WHERE key >= ${lo} AND key < ${hi} AND key LIKE '%/s:%';`, options));
  const truncated = bubbleRows.length > MESSAGE_CAP;
  const all = bubbleRows.slice(0, MESSAGE_CAP)
    .map((row) => summarizeBubble(String(row.key || ''), row.value));
  const chat = all.filter((item) => item.kind === 'message');
  const tools = all.filter((item) => item.kind === 'tool');
  const list = (includeTools ? all : chat)
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || a.key.localeCompare(b.key));
  const start = Math.max(0, Number(offset) || 0);
  // The panel asks for the whole (capped) list once and renders it lazily;
  // the 100-row ceiling only existed for the old server-side pager.
  const size = Math.max(1, Math.min(MESSAGE_CAP, Number(limit) || 30));
  const total = (items) => items.reduce((sum, item) => sum + item.bytes, 0);
  return {
    id: composerId,
    name: String(header.name || ''),
    workspaceId: String(header.workspaceId || ''),
    mode: String(header.mode || ''),
    createdAt: Number(header.createdAt) || 0,
    lastUpdatedAt: Number(header.lastUpdatedAt) || 0,
    subagent: Number(header.isSubagent) === 1,
    archived: Number(header.isArchived) === 1,
    composerBytes: Number(dataRows[0]?.bytes) || 0,
    messageCount: chat.length,
    messageBytes: total(chat),
    toolCount: tools.length,
    toolBytes: total(tools),
    fragmentCount: Number(fragmentRows[0]?.n) || 0,
    truncated,
    offset: start,
    limit: size,
    listTotal: list.length,
    messages: list.slice(start, start + size)
  };
}

// The session list needs a per-row size and composerHeaders carries none.
// Each session is still a bounded primary-key range, so the visible page is
// one UNION ALL statement: 50 sessions × (bubble range + composerData row) in
// a single child process. A session's bytes only change while its
// conversation is active, so results are cached per session.
const SIZE_TTL = 5 * 60 * 1000;
const SIZE_LIMIT = 50;
const sizeCache = new Map();

export async function readSessionSizes(stateDb, ids) {
  const requested = [...new Set((Array.isArray(ids) ? ids : []).map((id) => String(id || '')))]
    .filter((id) => /^[0-9A-Za-z._-]{1,96}$/.test(id))
    .slice(0, SIZE_LIMIT);
  if (!requested.length) return {sizes: {}};
  const info = fileInfo(stateDb);
  const sizes = {};
  const missing = [];
  for (const id of requested) {
    const entry = sizeCache.get(`${stateDb}|${id}`);
    if (entry
      && Date.now() - entry.at < SIZE_TTL
      && Math.abs((info.size || 0) - entry.fileSize) < SCAN_SIZE_DRIFT) {
      sizes[id] = entry.value;
    } else {
      missing.push(id);
    }
  }
  if (!missing.length) return {sizes};
  const parts = [];
  for (const id of missing) {
    const lo = quoteText(`bubbleId:${id}:`);
    const hi = quoteText(`bubbleId:${id};`);
    parts.push(`SELECT ${quoteText(id)} AS id, COUNT(*) AS messages, COALESCE(SUM(LENGTH(key) + COALESCE(LENGTH(value), 0)), 0) AS bytes FROM cursorDiskKV WHERE key >= ${lo} AND key < ${hi}`);
    parts.push(`SELECT ${quoteText(id)} AS id, 0 AS messages, COALESCE(LENGTH(value), 0) AS bytes FROM cursorDiskKV WHERE key = ${quoteText(`composerData:${id}`)}`);
  }
  const rows = parseJson(await sqlite(stateDb, `${parts.join('\nUNION ALL\n')};`, {
    readonly: true,
    json: true,
    timeout: 60000,
    busyTimeout: 5000
  }));
  for (const row of rows) {
    const id = String(row.id || '');
    if (!id) continue;
    const entry = sizes[id] || {messages: 0, bytes: 0};
    entry.messages += Number(row.messages) || 0;
    entry.bytes += Number(row.bytes) || 0;
    sizes[id] = entry;
  }
  for (const id of missing) {
    const value = sizes[id] || {messages: 0, bytes: 0};
    sizes[id] = value;
    sizeCache.set(`${stateDb}|${id}`, {at: Date.now(), fileSize: info.size || 0, value});
  }
  return {sizes};
}

// A single row, truncated on the server. The summary list never ships whole
// message bodies; this endpoint is what "展开原文" calls.
export async function readKvValue(stateDb, {key, maxBytes = VALUE_LIMIT} = {}) {
  const safe = safeKey(key);
  const cap = Math.max(1024, Math.min(VALUE_LIMIT, Number(maxBytes) || VALUE_LIMIT));
  const options = {readonly: true, json: true, timeout: FAST_TIMEOUT, busyTimeout: 5000, maxBuffer: 32 * 1024 * 1024};
  for (const table of ['cursorDiskKV', 'ItemTable']) {
    const rows = parseJson(await sqlite(stateDb, `
SELECT key, length(value) AS bytes, substr(CAST(value AS TEXT), 1, ${cap}) AS chunk
FROM ${table} WHERE key = ${quoteText(safe)};`, options));
    const row = rows[0];
    if (!row) continue;
    const bytes = Number(row.bytes) || 0;
    return {
      found: true,
      table,
      key: String(row.key || safe),
      bytes,
      truncated: bytes > cap,
      text: String(row.chunk ?? '')
    };
  }
  return {found: false, key: safe, bytes: 0, truncated: false, text: ''};
}

// Cursor writes this file continuously, so mtime would invalidate every
// cached scan within seconds. The cache is time-bounded instead, and only a
// gross size change (1 GB) drops it early — these totals guide decisions, not
// accounting.
// ---- 写操作（删除 / 压缩） ----
//
// Deleting a conversation means removing every row that belongs to it:
// composerData / composerConversationState / composerConvHeaders (exact keys),
// bubbleId: / checkpointId: / messageRequestContext: (key ranges) and the
// composerHeaders row that makes Cursor list it. Agent blobs are never touched
// here: their references are Cursor's private business and its own GC handles
// them.
const WRITE_TIMEOUT = 120000;
const VACUUM_TIMEOUT = 1800000;
const DELETE_LIMIT = 100;
// Key families scoped to one composer. `inlineDiff:*` is keyed by workspace
// id, not composer id, so it stays out of a conversation delete.
const SESSION_RANGES = ['bubbleId', 'checkpointId', 'messageRequestContext', 'codeBlockDiff', 'codeBlockPartialInlineDiffFates'];

function normalizeComposerIds(ids) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).map((id) => String(id || '')))]
    .filter(Boolean);
  if (!list.length) throw new Error('未选择会话');
  if (list.length > DELETE_LIMIT) throw new Error(`一次最多删除 ${DELETE_LIMIT} 个会话`);
  return list.map((id) => safeId(id, 'composerId'));
}

function quoteList(values) {
  return values.map((value) => quoteText(value)).join(',');
}

function exactKeys(id) {
  return [
    `composerData:${id}`,
    `composerConversationState:${id}`,
    `composerConvHeaders:${id}`
  ];
}

function rangeClauses(prefix, id) {
  return `key >= ${quoteText(`${prefix}:${id}:`)} AND key < ${quoteText(`${prefix}:${id};`)}`;
}

// Returns true when a Cursor window process is alive. Writes against a live
// Cursor are refused: it keeps composer state in memory and would rewrite the
// rows we just deleted.
export function cursorRunning() {
  return new Promise((resolve) => {
    const done = (value) => resolve(value);
    try {
      if (platform.IS_WIN) {
        execFile('tasklist', ['/FI', 'IMAGENAME eq Cursor.exe', '/NH'], {timeout: 5000, windowsHide: true}, (error, stdout) => {
          done(!error && /cursor\.exe/i.test(String(stdout || '')));
        });
        return;
      }
      const pattern = platform.IS_DARWIN ? 'Cursor.app/Contents/MacOS/Cursor' : 'cursor';
      execFile('pgrep', ['-f', pattern], {timeout: 5000}, (error, stdout) => {
        done(!error && String(stdout || '').trim().length > 0);
      });
    } catch {
      done(false);
    }
  });
}

export async function previewComposers(stateDb, ids) {
  const list = normalizeComposerIds(ids);
  const exact = [];
  const ranges = Object.fromEntries(SESSION_RANGES.map((prefix) => [prefix, []]));
  for (const id of list) {
    exact.push(...exactKeys(id));
    for (const prefix of Object.keys(ranges)) ranges[prefix].push(rangeClauses(prefix, id));
  }
  const parts = [
    `SELECT 'exact' AS kind, COUNT(*) AS n, COALESCE(SUM(LENGTH(key) + COALESCE(LENGTH(value), 0)), 0) AS bytes FROM cursorDiskKV WHERE key IN (${quoteList(exact)})`
  ];
  for (const [prefix, clauses] of Object.entries(ranges)) {
    parts.push(`SELECT ${quoteText(prefix)} AS kind, COUNT(*) AS n, COALESCE(SUM(LENGTH(key) + COALESCE(LENGTH(value), 0)), 0) AS bytes FROM cursorDiskKV WHERE ${clauses.join(' OR ')}`);
  }
  parts.push(`SELECT 'composerHeaders' AS kind, COUNT(*) AS n, 0 AS bytes FROM composerHeaders WHERE composerId IN (${quoteList(list)})`);
  const rows = parseJson(await sqlite(stateDb, `${parts.join('\nUNION ALL\n')};`, {
    readonly: true,
    json: true,
    timeout: 60000,
    busyTimeout: 5000
  }));
  const kinds = {};
  let totalRows = 0;
  let totalBytes = 0;
  for (const row of rows) {
    const kind = String(row.kind || '');
    const n = Number(row.n) || 0;
    const bytes = Number(row.bytes) || 0;
    kinds[kind] = {rows: n, bytes};
    totalRows += n;
    totalBytes += bytes;
  }
  return {ids: list, kinds, totalRows, totalBytes, headers: kinds.composerHeaders?.rows || 0};
}

export async function deleteComposers(stateDb, ids, {busyTimeout = 15000} = {}) {
  const list = normalizeComposerIds(ids);
  const preview = await previewComposers(stateDb, list);
  const statements = ['BEGIN IMMEDIATE;'];
  for (const id of list) {
    statements.push(`DELETE FROM cursorDiskKV WHERE key IN (${quoteList(exactKeys(id))});`);
    for (const prefix of SESSION_RANGES) {
      statements.push(`DELETE FROM cursorDiskKV WHERE ${rangeClauses(prefix, id)};`);
    }
    statements.push(`DELETE FROM ItemTable WHERE key = ${quoteText(`workbench.panel.composerChatViewPane.${id}.hidden`)};`);
  }
  statements.push(`DELETE FROM composerHeaders WHERE composerId IN (${quoteList(list)});`);
  statements.push('COMMIT;');
  const started = Date.now();
  await sqlite(stateDb, statements.join('\n'), {timeout: WRITE_TIMEOUT, busyTimeout});
  return {...preview, elapsedMs: Date.now() - started};
}

// Reclaiming disk after deletes needs a full rewrite: freelist pages stay
// inside the file otherwise. Callers must ensure Cursor is closed.
export async function vacuumStore(stateDb, {busyTimeout = 15000} = {}) {
  const before = fileInfo(stateDb);
  const started = Date.now();
  await sqlite(stateDb, 'VACUUM;', {timeout: VACUUM_TIMEOUT, busyTimeout});
  const after = fileInfo(stateDb);
  return {
    before: before.size,
    after: after.size,
    saved: Math.max(0, before.size - after.size),
    elapsedMs: Date.now() - started
  };
}

// A delete invalidates every byte total and per-session size we cached.
export function clearStoreCaches() {
  scanCache.clear();
  scanPending.clear();
  sizeCache.clear();
}

// VACUUM rewrites the whole database, so the temp space is roughly its size.
export function storeFreeSpace(stateDb) {
  try {
    const stats = fs.statfsSync(path.dirname(stateDb));
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

const SCAN_TTL = 2 * 60 * 1000;
const SCAN_SIZE_DRIFT = 1024 * 1024 * 1024;
const scanCache = new Map();
const scanPending = new Map();

export async function scanCategory(stateDb, {category, mode = 'estimate'} = {}) {
  const meta = CATEGORIES.find((entry) => entry.id === category);
  if (!meta) throw new Error(`未知的统计类别：${category || '空'}`);
  const started = Date.now();
  const options = {readonly: true, json: true, timeout: SCAN_TIMEOUT, busyTimeout: 5000};
  const tables = await fileTables(stateDb);
  if (meta.table) {
    if (!tables.has(meta.table)) {
      return {id: meta.id, label: meta.label, rows: 0, bytes: 0, sampled: false, elapsedMs: 0, mode: 'exact'};
    }
    const row = parseJson(await sqlite(stateDb,
      `SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(key) + COALESCE(LENGTH(value), 0)), 0) AS bytes FROM ${meta.table};`, options))[0] || {};
    return {id: meta.id, label: meta.label, rows: Number(row.n) || 0, bytes: Number(row.bytes) || 0, sampled: false, elapsedMs: Date.now() - started, mode: 'exact'};
  }
  if (!tables.has('cursorDiskKV')) {
    return {id: meta.id, label: meta.label, rows: 0, bytes: 0, sampled: false, elapsedMs: 0, mode: 'exact'};
  }
  // Heavy categories default to a 1/16 hex bucket: one sixteenth of the rows
  // costs 12–25 s instead of several minutes. Small categories are cheap
  // enough that sampling would only add error.
  const exact = mode === 'exact' || !meta.heavy;
  const clauses = meta.prefixes.map((prefix) => {
    const glob = globLiteral(prefix) + (exact ? '*' : '8*');
    return `key GLOB ${quoteText(glob)}`;
  });
  const row = parseJson(await sqlite(stateDb, `
SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(key) + COALESCE(LENGTH(value), 0)), 0) AS bytes
FROM cursorDiskKV WHERE ${clauses.join(' OR ')};`, options))[0] || {};
  const factor = exact ? 1 : 16;
  return {
    id: meta.id,
    label: meta.label,
    rows: (Number(row.n) || 0) * factor,
    bytes: (Number(row.bytes) || 0) * factor,
    sampled: !exact,
    elapsedMs: Date.now() - started,
    mode: exact ? 'exact' : 'estimate'
  };
}

// Identical scans share one child process; results stay valid for a couple of
// minutes so repeated clicks never re-walk billions of rows.
export async function scanCategoryCached(stateDb, {category, mode = 'estimate'} = {}) {
  const info = fileInfo(stateDb);
  const cacheKey = `${stateDb}|${category}|${mode}`;
  const cached = scanCache.get(cacheKey);
  if (cached
    && Date.now() - cached.at < SCAN_TTL
    && Math.abs((info.size || 0) - cached.size) < SCAN_SIZE_DRIFT) {
    return {...cached.data, cached: true};
  }
  if (scanPending.has(cacheKey)) return scanPending.get(cacheKey);
  const promise = scanCategory(stateDb, {category, mode})
    .then((data) => {
      scanCache.set(cacheKey, {at: Date.now(), size: info.size || 0, data});
      for (const [key, entry] of scanCache) {
        if (Date.now() - entry.at > SCAN_TTL) scanCache.delete(key);
      }
      return data;
    })
    .finally(() => scanPending.delete(cacheKey));
  scanPending.set(cacheKey, promise);
  return promise;
}
