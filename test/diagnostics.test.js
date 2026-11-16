import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {tailFile, redact, classify} from '../control/diagnostics.js';

const temp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-bridge-diagnostics-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
};

test('tailFile returns the last lines and reports truncation', (t) => {
  const dir = temp(t);
  const file = path.join(dir, 'engine.log');
  fs.writeFileSync(file, Array.from({length: 10}, (_, index) => `line-${index}`).join('\n') + '\n');
  const tail = tailFile(file, {lines: 3});
  assert.equal(tail.exists, true);
  assert.equal(tail.truncated, true);
  assert.equal(tail.lines, 3);
  assert.deepEqual(tail.text.split('\n'), ['line-7', 'line-8', 'line-9']);
  const missing = tailFile(path.join(dir, 'missing.log'));
  assert.equal(missing.exists, false);
  assert.equal(missing.text, '');
});

test('redact hides bearer tokens, api keys and JSON secrets', () => {
  const text = [
    'Authorization: Bearer abcdefghijklmnop',
    '{"key":"fake-secret","model":"m"}',
    'api_key=fake-secret'
  ].join('\n');
  const out = redact(text);
  assert.doesNotMatch(out, /abcdefghijklmnop|fake-secret/);
  assert.match(out, /Authorization: Bearer \[redacted\]/);
  assert.match(out, /"key":"\[redacted\]"/);
  assert.match(out, /"model":"m"/);
  assert.match(out, /api_key=\[redacted\]/);
});

test('classify maps known failures to actionable hints', () => {
  const hints = classify('bridge requires an already trusted CA\nEADDRINUSE\nBidiAppend contains no AgentClientMessage');
  assert.deepEqual(hints.map((hint) => hint.id), ['certificate', 'port', 'protocol']);
  assert.match(hints[0].hint, /setup/);
  assert.deepEqual(classify('all good'), []);
});
