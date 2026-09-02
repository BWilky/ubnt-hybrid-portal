const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeFileAtomic } = require('../lib/fsutil');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-'));
  return path.join(dir, 'config.json');
}

test('writes content and applies mode', () => {
  const f = tmpFile();
  writeFileAtomic(f, '{"a":1}\n', { mode: 0o600 });
  assert.strictEqual(fs.readFileSync(f, 'utf8'), '{"a":1}\n');
  assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
});

test('leaves no temp file behind', () => {
  const f = tmpFile();
  writeFileAtomic(f, 'x');
  assert.deepStrictEqual(fs.readdirSync(path.dirname(f)), ['config.json']);
});

test('keeps the existing file intact when the write fails', () => {
  const f = tmpFile();
  fs.writeFileSync(f, 'original');
  const realWrite = fs.writeSync;
  fs.writeSync = () => { const e = new Error('ENOSPC: no space left on device, write'); e.code = 'ENOSPC'; throw e; };
  try {
    assert.throws(() => writeFileAtomic(f, 'replacement'), /ENOSPC/);
  } finally {
    fs.writeSync = realWrite;
  }
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'original');
  assert.deepStrictEqual(fs.readdirSync(path.dirname(f)), ['config.json']);
});
