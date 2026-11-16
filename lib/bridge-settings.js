import fs from 'node:fs';
import path from 'node:path';

// User-editable bridge parameters. They live beside the other runtime state so
// the supervisor (bridge.js) and the control panel read the same file. Every
// read tolerates a missing or malformed file and falls back to the defaults;
// only an explicit write from the control panel is validated strictly.
export const defaults = Object.freeze({
  runMode: 'default',
  subagentMode: 'async',
  refreshSeconds: 15,
  gatewayGraceSeconds: 60,
  logLimitMB: 4,
  // Model id -> display name. Only the name handed to Cursor changes; ids keep
  // driving routing and billing.
  modelNames: Object.freeze({})
});

export const MODEL_NAME_LIMIT = 80;
export const MODEL_NAME_MAX_ENTRIES = 200;

// Run modes are intentionally a closed set: the native engine switches its
// storage strategy from this value, so an unknown mode must never fall through
// to a half-configured state.
export const modes = Object.freeze({
  default: '默认模式',
  lite: '轻量模式'
});

// Subagent modes decide how Task calls reach the client. `async` keeps the
// model's own run_in_background intent and lets the bridge wake the parent when
// the subagent finishes; `sync` forces run_in_background=false so the parent
// turn waits for an inline result.
export const subagentModes = Object.freeze({
  async: '异步后台（默认）',
  sync: '同步阻塞'
});

export const rules = Object.freeze({
  refreshSeconds: {min: 5, max: 300, step: 1, label: '模型目录同步间隔（秒）'},
  gatewayGraceSeconds: {min: 10, max: 600, step: 1, label: '网关断线容错（秒）'},
  logLimitMB: {min: 1, max: 64, step: 1, label: '引擎日志上限（MB）'}
});

export function settingsFile(root) {
  return path.join(root, 'bridge-settings.json');
}

// A map shaped like {"group/opus": "Opus 4.5"} is the only accepted form.
// Empty values mean "remove the override", so clearing an input and saving is
// how a user returns that model to Magpie's own name.
function normalizeModelNames(raw, strict) {
  if (raw === undefined || raw === null || raw === '') return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    if (strict) throw new Error('模型显示名需为「模型 ID → 名称」的对象');
    return {};
  }
  const out = {};
  let count = 0;
  for (const [rawId, rawName] of Object.entries(raw)) {
    const id = typeof rawId === 'string' ? rawId.trim() : '';
    if (!id) {
      if (strict) throw new Error('模型显示名的模型 ID 不能为空');
      continue;
    }
    if (typeof rawName !== 'string') {
      if (strict) throw new Error(`模型 ${id} 的显示名需为文本`);
      continue;
    }
    const name = rawName.trim();
    if (!name) continue;
    if (name.length > MODEL_NAME_LIMIT) {
      if (strict) throw new Error(`模型 ${id} 的显示名不能超过 ${MODEL_NAME_LIMIT} 个字符`);
      continue;
    }
    if (count >= MODEL_NAME_MAX_ENTRIES) {
      if (strict) throw new Error(`模型显示名最多 ${MODEL_NAME_MAX_ENTRIES} 条`);
      break;
    }
    out[id] = name;
    count += 1;
  }
  return out;
}

// Applied right before the catalogue goes to the engine, so the Cursor menu
// shows the custom name while every request still carries the original id.
export function applyModelNames(models, modelNames = {}) {
  return models.map((model) => {
    const custom = modelNames?.[model.id];
    return custom ? {...model, name: custom} : model;
  });
}

export function normalize(input, {strict = false} = {}) {
  const out = {};
  const mode = input?.runMode;
  if (mode === undefined || mode === null || mode === '') {
    out.runMode = defaults.runMode;
  } else if (Object.hasOwn(modes, mode)) {
    out.runMode = mode;
  } else if (strict) {
    throw new Error(`运行模式需为 ${Object.keys(modes).join(' 或 ')}`);
  } else {
    out.runMode = defaults.runMode;
  }
  const subagentMode = input?.subagentMode;
  if (subagentMode === undefined || subagentMode === null || subagentMode === '') {
    out.subagentMode = defaults.subagentMode;
  } else if (Object.hasOwn(subagentModes, subagentMode)) {
    out.subagentMode = subagentMode;
  } else if (strict) {
    throw new Error(`子代理模式需为 ${Object.keys(subagentModes).join(' 或 ')}`);
  } else {
    out.subagentMode = defaults.subagentMode;
  }
  for (const [key, rule] of Object.entries(rules)) {
    const raw = input?.[key];
    if (raw === undefined || raw === null || raw === '') {
      out[key] = defaults[key];
      continue;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < rule.min || value > rule.max) {
      if (strict) throw new Error(`${rule.label}需为 ${rule.min}–${rule.max} 的整数`);
      out[key] = defaults[key];
      continue;
    }
    out[key] = value;
  }
  out.modelNames = normalizeModelNames(input?.modelNames, strict);
  return out;
}

export function read(root) {
  try {
    return normalize(JSON.parse(fs.readFileSync(settingsFile(root), 'utf8')));
  } catch {
    return {...defaults, modelNames: {}};
  }
}

export function write(root, input) {
  const value = normalize(input, {strict: true});
  fs.mkdirSync(root, {recursive: true, mode: 0o700});
  const file = settingsFile(root);
  const temp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(temp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
  return value;
}
