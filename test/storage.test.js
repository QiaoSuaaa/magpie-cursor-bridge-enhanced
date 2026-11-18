import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {databasePath, migrateStorage, resolveDataDir} from '../lib/storage.js';

const sqlite = Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(84)]);
const setup = (t) => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-bridge-storage-')));
  t.after(() => fs.rmSync(base, {recursive: true, force: true}));
  const root = path.join(base, 'plugin');
  const source = path.join(root, 'data');
  const target = path.join(base, 'target');
  fs.mkdirSync(root);
  return {base, root, source, target, config: path.join(root, 'storage.json')};
};
const put = (file, content = '') => {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, content);
};
const seed = (dir) => {
  put(databasePath(dir), sqlite);
  put(path.join(dir, 'bridge.db-wal'), Buffer.from([0, 1, 255, 42]));
  put(path.join(dir, 'bridge.db-shm'), Buffer.alloc(32768, 7));
  put(path.join(dir, 'nested', 'logs', 'engine.log'), 'source log\n');
  fs.mkdirSync(path.join(dir, 'empty'));
};
const snapshot = (dir) => {
  const result = {};
  const visit = (relative) => {
    for (const name of fs.readdirSync(path.join(dir, relative)).sort()) {
      const entry = path.join(relative, name);
      if (fs.lstatSync(path.join(dir, entry)).isDirectory()) {
        result[entry] = null;
        visit(entry);
      } else {
        result[entry] = fs.readFileSync(path.join(dir, entry));
      }
    }
  };
  visit('');
  return result;
};
const failCommit = (t, config, beforeFailure = () => {}) => {
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === config) {
      beforeFailure();
      throw Object.assign(new Error('injected configuration commit failure'), {code: 'EIO'});
    }
    return rename(from, to);
  });
};

test('resolves only absolute configured paths and defaults without creating files', (t) => {
  const {root, target, config} = setup(t);
  assert.equal(resolveDataDir(root), path.join(root, 'data'));
  assert.deepEqual(fs.readdirSync(root), []);
  put(config, '{}');
  assert.equal(resolveDataDir(root), path.join(root, 'data'));
  put(config, JSON.stringify({data_dir: path.join(target, '..', 'chosen')}));
  assert.equal(resolveDataDir(root), path.join(path.dirname(target), 'chosen'));
  for (const data_dir of ['relative', '', null, 12, false, [], {}]) {
    put(config, JSON.stringify({data_dir}));
    assert.throws(() => resolveDataDir(root), /absolute/);
  }
  for (const invalid of ['{broken', 'null', '[]', '"path"']) {
    put(config, invalid);
    assert.throws(() => resolveDataDir(root));
  }
  assert.throws(() => resolveDataDir('relative'), /absolute/);
});

test('database path is always bridge.db, with no old-name fallback', (t) => {
  const {root} = setup(t);
  assert.equal(databasePath(root), path.join(root, 'bridge.db'));
  assert.throws(() => databasePath('relative'), /absolute/);
});

test('copies all data asynchronously, including WAL, SHM, nested and empty directories', async (t) => {
  const {root, source, target, config} = setup(t);
  seed(source);
  const original = snapshot(source);
  const result = await migrateStorage(root, target);
  assert.deepEqual(result, {mode: 'copied', dataDir: target});
  assert.deepEqual(snapshot(target), original);
  assert.deepEqual(snapshot(source), original);
  assert.deepEqual(JSON.parse(fs.readFileSync(config, 'utf8')), {data_dir: target});
  assert.equal(resolveDataDir(root), target);
  assert.equal(fs.existsSync(`${config}.${process.pid}.tmp`), false);
});

test('uses the configured source and accepts a sibling sharing its name prefix', async (t) => {
  const {base, root, config} = setup(t);
  const source = path.join(base, 'chosen');
  const target = path.join(base, 'chosen-copy');
  seed(source);
  put(config, JSON.stringify({data_dir: source}));
  assert.equal((await migrateStorage(root, target)).mode, 'copied');
  assert.deepEqual(snapshot(target), snapshot(source));
});

test('a missing source initializes an empty target and can create a missing plugin root', async (t) => {
  const {root, source, target} = setup(t);
  fs.rmdirSync(root);
  assert.deepEqual(await migrateStorage(root, target), {mode: 'copied', dataDir: target});
  assert.deepEqual(fs.readdirSync(target), []);
  assert.equal(fs.existsSync(source), false);
  assert.equal(resolveDataDir(root), target);
});

test('copies into an existing empty target', async (t) => {
  const {root, source, target} = setup(t);
  seed(source);
  fs.mkdirSync(target);
  const identity = fs.statSync(target).ino;
  assert.equal((await migrateStorage(root, target)).mode, 'copied');
  assert.equal(fs.statSync(target).ino, identity);
  assert.deepEqual(snapshot(target), snapshot(source));
});

test('switches to an existing database without copying or changing either directory', async (t) => {
  const {root, source, target} = setup(t);
  seed(source);
  put(databasePath(target), Buffer.concat([sqlite, Buffer.from('different target data')]));
  put(path.join(target, 'personal.txt'), 'keep');
  const beforeSource = snapshot(source);
  const beforeTarget = snapshot(target);
  assert.deepEqual(await migrateStorage(root, target), {mode: 'switched', dataDir: target});
  assert.deepEqual(snapshot(source), beforeSource);
  assert.deepEqual(snapshot(target), beforeTarget);
  assert.equal(resolveDataDir(root), target);
});

test('unchanged paths do not create or rewrite configuration or inspect data', async (t) => {
  const {root, source, config} = setup(t);
  assert.deepEqual(await migrateStorage(root, path.join(source, '..', 'data')), {mode: 'unchanged', dataDir: source});
  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.existsSync(config), false);
  fs.mkdirSync(source);
  put(config, JSON.stringify({data_dir: source}, null, 4));
  const original = fs.readFileSync(config, 'utf8');
  assert.equal((await migrateStorage(root, source)).mode, 'unchanged');
  assert.equal(fs.readFileSync(config, 'utf8'), original);
});

test('rejects ancestors and descendants before copying or switching', async (t) => {
  const {root, source, config} = setup(t);
  seed(source);
  put(databasePath(root), sqlite);
  const original = snapshot(root);
  for (const target of [root, path.join(source, 'child'), path.join(source, 'deep', 'child')]) {
    await assert.rejects(migrateStorage(root, target), /must not contain/);
    assert.deepEqual(snapshot(root), original);
    assert.equal(fs.existsSync(config), false);
  }
});

test('rejects nonempty targets without a bridge.db SQLite header and leaves them intact', async (t) => {
  const fixtures = [
    ['unrelated file', (dir) => put(path.join(dir, 'personal.txt'), 'keep')],
    ['old database name', (dir) => put(path.join(dir, 'cursor-bridge.db'), sqlite)],
    ['empty database', (dir) => put(databasePath(dir))],
    ['wrong header', (dir) => put(databasePath(dir), Buffer.alloc(100))],
    ['truncated header', (dir) => put(databasePath(dir), sqlite.subarray(0, 15))],
    ['database is directory', (dir) => fs.mkdirSync(databasePath(dir), {recursive: true})],
    ['empty subdirectory', (dir) => fs.mkdirSync(path.join(dir, 'empty'), {recursive: true})]
  ];
  for (const [name, fill] of fixtures) {
    await t.test(name, async (t) => {
      const {root, source, target, config} = setup(t);
      seed(source);
      fill(target);
      const before = snapshot(target);
      await assert.rejects(migrateStorage(root, target), /not empty.*bridge\.db/);
      assert.deepEqual(snapshot(target), before);
      assert.equal(fs.existsSync(config), false);
    });
  }
});

test('rejects relative paths, files and invalid configured sources', async (t) => {
  const {base, root, source, target, config} = setup(t);
  for (const value of ['relative', '', null, 1]) await assert.rejects(migrateStorage(root, value), /absolute/);
  put(target, 'a file');
  await assert.rejects(migrateStorage(root, target), /not a directory/);
  fs.unlinkSync(target);
  put(source, 'a source file');
  await assert.rejects(migrateStorage(root, target), /not a directory/);
  fs.unlinkSync(source);
  put(config, JSON.stringify({data_dir: 'relative'}));
  await assert.rejects(migrateStorage(root, target), /absolute/);
  assert.deepEqual(fs.readdirSync(base).sort(), ['plugin']);
});

test('rejects directory symlinks in source, target, and their ancestors', async (t) => {
  const fixtures = ['source root', 'source child', 'target root', 'target child', 'target ancestor', 'source ancestor'];
  for (const location of fixtures) {
    await t.test(location, async (t) => {
      const {base, root, source, target, config} = setup(t);
      const outside = path.join(base, 'outside');
      seed(outside);
      const linked = path.join(base, 'linked');
      let destination = target;
      if (location === 'source root') {
        fs.symlinkSync(outside, source, 'junction');
      } else if (location === 'source child') {
        seed(source);
        fs.symlinkSync(outside, path.join(source, 'link'), 'junction');
      } else if (location === 'target root') {
        fs.symlinkSync(outside, target, 'junction');
      } else if (location === 'target child') {
        seed(target);
        fs.symlinkSync(outside, path.join(target, 'link'), 'junction');
      } else {
        fs.symlinkSync(outside, linked, 'junction');
        if (location === 'target ancestor') destination = path.join(linked, 'new');
        else put(config, JSON.stringify({data_dir: path.join(linked, 'nested')}));
      }
      const before = snapshot(outside);
      const configBefore = fs.existsSync(config) ? fs.readFileSync(config, 'utf8') : null;
      await assert.rejects(migrateStorage(root, destination), /Symbolic links/);
      assert.deepEqual(snapshot(outside), before);
      assert.equal(fs.existsSync(config) ? fs.readFileSync(config, 'utf8') : null, configBefore);
    });
  }
});

test('rejects a symlinked storage configuration instead of reading through it', async (t) => {
  const {base, root, target, config} = setup(t);
  const elsewhere = path.join(base, 'elsewhere.json');
  put(elsewhere, JSON.stringify({data_dir: target}));
  try { fs.symlinkSync(elsewhere, config, 'file'); } catch (error) {
    if (error.code !== 'EPERM') throw error;
    t.skip('Creating file symlinks requires permission on this Windows host');
    return;
  }
  assert.throws(() => resolveDataDir(root), /regular file/);
  await assert.rejects(migrateStorage(root, target), /regular file/);
});

test('copy failure removes only created data and never switches configuration', async (t) => {
  const {root, source, target, config} = setup(t);
  seed(source);
  fs.mkdirSync(target);
  const before = snapshot(source);
  const createReadStream = fs.createReadStream;
  let copies = 0;
  t.mock.method(fs, 'createReadStream', (...args) => {
    if (++copies === 2) throw new Error('injected copy failure');
    return createReadStream(...args);
  });
  await assert.rejects(migrateStorage(root, target), /injected copy failure/);
  assert.ok(copies >= 2);
  assert.deepEqual(fs.readdirSync(target), []);
  assert.deepEqual(snapshot(source), before);
  assert.equal(fs.existsSync(config), false);
});

test('failed atomic commit restores the old selection and removes new target parents and temporary config', async (t) => {
  const {base, root, source, config} = setup(t);
  seed(source);
  const original = JSON.stringify({data_dir: source}, null, 4);
  put(config, original);
  const target = path.join(base, 'new-parent', 'new-target');
  const before = snapshot(source);
  failCommit(t, config, () => {
    assert.deepEqual(snapshot(target), before);
    assert.equal(resolveDataDir(root), source);
  });
  await assert.rejects(migrateStorage(root, target), /injected configuration commit failure/);
  assert.equal(fs.existsSync(path.join(base, 'new-parent')), false);
  assert.deepEqual(snapshot(source), before);
  assert.equal(fs.readFileSync(config, 'utf8'), original);
  assert.equal(fs.existsSync(`${config}.${process.pid}.tmp`), false);
});

test('failed switch never deletes or modifies existing target data', async (t) => {
  const {root, source, target, config} = setup(t);
  seed(source);
  seed(target);
  put(path.join(target, 'personal.txt'), 'keep');
  const before = snapshot(target);
  failCommit(t, config);
  await assert.rejects(migrateStorage(root, target), /injected configuration commit failure/);
  assert.deepEqual(snapshot(target), before);
  assert.equal(resolveDataDir(root), source);
  assert.equal(fs.existsSync(config), false);
});

test('rollback preserves user files arriving in newly created directories', async (t) => {
  const {root, source, target, config} = setup(t);
  seed(source);
  const personal = path.join(target, 'nested', 'logs', 'personal.txt');
  failCommit(t, config, () => put(personal, 'new user data'));
  await assert.rejects(migrateStorage(root, target), /injected configuration commit failure/);
  assert.deepEqual(snapshot(target), {
    nested: null,
    [path.join('nested', 'logs')]: null,
    [path.join('nested', 'logs', 'personal.txt')]: Buffer.from('new user data')
  });
  assert.equal(resolveDataDir(root), source);
});

test('exclusive file creation preserves a target file arriving during copy', async (t) => {
  const {root, source, target, config} = setup(t);
  seed(source);
  const destination = databasePath(target);
  const open = fs.promises.open;
  t.mock.method(fs.promises, 'open', async (file, flags, ...args) => {
    if (file === destination && flags === 'wx') put(destination, 'user file');
    return open.call(fs.promises, file, flags, ...args);
  });
  await assert.rejects(migrateStorage(root, target), {code: 'EEXIST'});
  assert.deepEqual(snapshot(target), {'bridge.db': Buffer.from('user file')});
  assert.equal(fs.existsSync(config), false);
});

test('pre-existing atomic temporary files are never overwritten or removed', async (t) => {
  const {root, source, target, config} = setup(t);
  seed(source);
  const temp = `${config}.${process.pid}.tmp`;
  put(temp, 'user-owned temporary file');
  await assert.rejects(migrateStorage(root, target), {code: 'EEXIST'});
  assert.equal(fs.readFileSync(temp, 'utf8'), 'user-owned temporary file');
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.existsSync(config), false);
  assert.equal(resolveDataDir(root), source);
});
