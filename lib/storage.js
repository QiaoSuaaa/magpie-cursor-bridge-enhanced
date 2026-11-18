import fs from 'node:fs';
import path from 'node:path';
import {pipeline} from 'node:stream/promises';
import {atomic} from './settings.js';

const disk = fs.promises;
const sqliteHeader = Buffer.from('SQLite format 3\0');

function absoluteDirectory(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) {
    throw new Error('Storage directory must be an absolute path');
  }
  // A Windows path rooted only at \\ or / still depends on the current drive.
  if (process.platform === 'win32' && /^[\\/]$/.test(path.parse(value).root)) {
    throw new Error('Storage directory must include a drive or UNC share');
  }
  return path.resolve(value);
}

export function resolveDataDir(root) {
  root = absoluteDirectory(root);
  const file = path.join(root, 'storage.json');
  let info;
  try { info = fs.lstatSync(file); } catch (error) {
    if (error.code === 'ENOENT') return path.join(root, 'data');
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('storage.json must be a regular file');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid storage.json');
  return config.data_dir === undefined ? path.join(root, 'data') : absoluteDirectory(config.data_dir);
}

export function databasePath(dataDir) {
  return path.join(absoluteDirectory(dataDir), 'bridge.db');
}

async function stat(file) {
  try { return await disk.lstat(file); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// Check every existing ancestor, including junctions on Windows. realpath also
// resolves aliases such as drive-letter case and short names before comparison.
async function directoryPath(dir) {
  const parent = path.dirname(dir);
  const file = parent === dir ? dir : path.join(await directoryPath(parent), path.basename(dir));
  const info = await stat(file);
  if (info?.isSymbolicLink()) throw new Error(`Symbolic links are not allowed: ${file}`);
  if (info && !info.isDirectory()) throw new Error(`Storage path is not a directory: ${file}`);
  return info ? disk.realpath(file) : file;
}

function contains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

async function tree(dir, relative = '', entries = []) {
  for (const name of await disk.readdir(path.join(dir, relative))) {
    const entry = path.join(relative, name);
    const file = path.join(dir, entry);
    const info = await disk.lstat(file);
    if (info.isSymbolicLink()) throw new Error(`Symbolic links are not allowed: ${file}`);
    if (!info.isDirectory() && !info.isFile()) throw new Error(`Unsupported storage entry: ${file}`);
    entries.push({relative: entry, directory: info.isDirectory(), mode: info.mode & 0o777});
    if (info.isDirectory()) await tree(dir, entry, entries);
  }
  return entries;
}

async function mkdir(dir, created) {
  const info = await stat(dir);
  if (info) {
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Unsafe storage directory: ${dir}`);
    return;
  }
  await mkdir(path.dirname(dir), created);
  await disk.mkdir(dir, {mode: 0o700});
  created.push({file: dir, info: await disk.lstat(dir), directory: true});
}

// Never recursively remove a destination. Preserve pre-existing directories,
// newly arriving user files, and entries that no longer have our file identity.
async function cleanup(created) {
  const errors = [];
  for (const entry of [...created].reverse()) {
    try {
      const info = await stat(entry.file);
      if (!info || info.dev !== entry.info.dev || info.ino !== entry.info.ino || info.isSymbolicLink()) continue;
      if (entry.directory) await disk.rmdir(entry.file);
      else await disk.unlink(entry.file);
    } catch (error) {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) errors.push(error);
    }
  }
  return errors;
}

async function copyFile(source, target, mode, created) {
  // Open exclusively before streaming so even an interrupted copy is owned and
  // tracked, while a file created by somebody else can never be overwritten.
  const output = await disk.open(target, 'wx', mode);
  try {
    created.push({file: target, info: await output.stat(), directory: false});
    await pipeline(fs.createReadStream(source), output.createWriteStream());
  } finally {
    await output.close();
  }
}

async function hasDatabase(dir) {
  const file = databasePath(dir);
  const info = await stat(file);
  if (!info?.isFile() || info.isSymbolicLink()) return false;
  const input = await disk.open(file, 'r');
  try {
    const header = Buffer.alloc(sqliteHeader.length);
    const {bytesRead} = await input.read(header, 0, header.length, 0);
    return bytesRead === header.length && header.equals(sqliteHeader);
  } finally {
    await input.close();
  }
}

async function save(root, target) {
  const file = path.join(root, 'storage.json');
  const temp = `${file}.${process.pid}.tmp`;
  // atomic() uses this temporary name. Reserve it exclusively to avoid touching
  // an existing user file or following a pre-existing temporary-file symlink.
  const handle = await disk.open(temp, 'wx', 0o600);
  const owned = [];
  try {
    owned.push({file: temp, info: await handle.stat(), directory: false});
  } finally {
    await handle.close();
  }
  try {
    atomic(file, `${JSON.stringify({data_dir: target}, null, 2)}\n`);
  } catch (error) {
    const errors = await cleanup(owned);
    if (errors.length) throw new AggregateError([error, ...errors], 'Could not remove storage configuration temporary file');
    throw error;
  }
}

// The caller must stop all storage writers/read tasks and serialize migrations.
// Source data is retained. Only the final atomic configuration write activates
// the destination; WAL/SHM and every other regular source file are copied as-is.
export async function migrateStorage(root, target) {
  root = await directoryPath(absoluteDirectory(root));
  const source = await directoryPath(resolveDataDir(root));
  target = await directoryPath(absoluteDirectory(target));
  if (path.relative(source, target) === '') return {mode: 'unchanged', dataDir: source};
  if (contains(source, target) || contains(target, source)) {
    throw new Error('Source and target storage directories must not contain one another');
  }

  const existing = await stat(target) ? await tree(target) : [];
  const mode = existing.length ? 'switched' : 'copied';
  if (mode === 'switched' && !await hasDatabase(target)) {
    throw new Error('Target directory is not empty and has no valid bridge.db SQLite header');
  }
  const entries = mode === 'copied' && await stat(source) ? await tree(source) : [];
  const created = [];
  try {
    await mkdir(target, created);
    for (const entry of entries) {
      const destination = path.join(target, entry.relative);
      if (entry.directory) {
        await disk.mkdir(destination, {mode: entry.mode});
        created.push({file: destination, info: await disk.lstat(destination), directory: true});
      } else {
        await copyFile(path.join(source, entry.relative), destination, entry.mode, created);
      }
    }
    await mkdir(root, created);
    await save(root, target);
    return {mode, dataDir: target};
  } catch (error) {
    const errors = await cleanup(created);
    if (errors.length) throw new AggregateError([error, ...errors], 'Storage migration failed and cleanup was incomplete');
    throw error;
  }
}
