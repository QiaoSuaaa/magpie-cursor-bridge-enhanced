import test from 'node:test';
import assert from 'node:assert/strict';
import {cursorCompatibility, compareVersions, CURSOR_TESTED} from '../lib/compatibility.js';

test('cursor versions inside the tested range are marked tested', () => {
  for (const version of ['3.28.0', '3.28.7', '3.30.8']) {
    const result = cursorCompatibility(version);
    assert.equal(result.status, 'tested', version);
    assert.equal(result.tested, true);
    assert.equal(result.range, CURSOR_TESTED.label);
    assert.equal(result.hint, '');
  }
});

test('versions outside the range are flagged with direction', () => {
  const older = cursorCompatibility('3.27.9');
  assert.equal(older.status, 'older');
  assert.equal(older.tested, false);
  assert.match(older.hint, /低于已实测范围/);
  const newer = cursorCompatibility('3.31.0-insider');
  assert.equal(newer.status, 'newer');
  assert.equal(newer.tested, false);
  assert.match(newer.hint, /高于已实测范围/);
});

test('version comparison orders releases', () => {
  assert.ok(compareVersions('0.2.28', '0.2.27') > 0);
  assert.ok(compareVersions('0.2.27', '0.2.28') < 0);
  assert.equal(compareVersions('0.2.27', '0.2.27'), 0);
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('bad', '0.2.27'), 0);
});

test('missing or malformed versions are unknown', () => {
  for (const version of [null, undefined, '', 'abc', '3.x']) {
    const result = cursorCompatibility(version);
    assert.equal(result.status, 'unknown', String(version));
    assert.equal(result.tested, false);
    assert.match(result.hint, /未检测到/);
  }
});
