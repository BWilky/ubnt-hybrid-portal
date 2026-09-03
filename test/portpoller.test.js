'use strict';
const test = require('node:test');
const assert = require('node:assert');
const P = require('../lib/portpoller');

test('enqueue: live jumps the queue, upgrades a queued background, dedups', () => {
  const s = P.emptyQueue();
  assert.strictEqual(P.enqueue(s, 'a', 'background'), true);
  assert.strictEqual(P.enqueue(s, 'b', 'background'), true);
  assert.strictEqual(P.enqueue(s, 'a', 'background'), false);       // dup
  assert.strictEqual(P.enqueue(s, 'b', 'live'), true);             // upgrade
  assert.deepStrictEqual(s.pending.map((j) => j.key), ['b', 'a']); // live b at front
  assert.strictEqual(s.pending[0].priority, 'live');
  assert.strictEqual(P.enqueue(s, 'c', 'live'), true);
  assert.deepStrictEqual(s.pending.map((j) => j.key), ['c', 'b', 'a']);
});

test('dueForBackground: never-read and stale keys, excluding pending', () => {
  const s = P.emptyQueue();
  s.last = { a: 1000, b: 100000 };
  P.enqueue(s, 'c', 'background');
  const due = P.dueForBackground(s, ['a', 'b', 'c', 'd'], 200000, 60000);
  // a: 200000-1000 > 60000 stale; b: 200000-100000 > 60000 stale; c pending; d never read
  assert.deepStrictEqual(due.sort(), ['a', 'b', 'd']);
});

test('nextJob shifts the front and recordRead stamps last', () => {
  const s = P.emptyQueue();
  P.enqueue(s, 'a', 'live');
  assert.deepStrictEqual(P.nextJob(s), { key: 'a', priority: 'live' });
  assert.strictEqual(P.nextJob(s), null);
  P.recordRead(s, 'a', 5000);
  assert.strictEqual(s.last.a, 5000);
});

test('rate: bytes/sec within window, null when too far apart or missing', () => {
  const prev = { at: 1000, ports: [{ port: 'eth1', rxBytes: 100 }] };
  const cur = { at: 2000, ports: [{ port: 'eth1', rxBytes: 300 }] };
  assert.strictEqual(P.rate(prev, cur, 'eth1', 'rxBytes'), 200); // 200 bytes / 1 s
  assert.strictEqual(P.rate(null, cur, 'eth1', 'rxBytes'), null);
  const old = { at: 2000 - 6 * 60000, ports: [{ port: 'eth1', rxBytes: 0 }] };
  assert.strictEqual(P.rate(old, cur, 'eth1', 'rxBytes'), null);  // > 5 min
});
