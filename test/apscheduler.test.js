'use strict';
const test = require('node:test');
const assert = require('node:assert');
const S = require('../lib/apscheduler');

// Wednesday 2026-09-02 is day 3. Local-time constructor avoids TZ surprises.
const local = (y, m, d, h, mi) => new Date(y, m - 1, d, h, mi, 0, 0);
const reboot = { enabled: true, day: 3, start: '02:00', hours: 3, concurrency: 3, timeoutMinutes: 8 };

test('inWindow: inside, before, after, wrong day, midnight crossing', () => {
  assert.strictEqual(S.inWindow(local(2026, 9, 2, 2, 0), reboot), true);
  assert.strictEqual(S.inWindow(local(2026, 9, 2, 4, 59), reboot), true);
  assert.strictEqual(S.inWindow(local(2026, 9, 2, 5, 0), reboot), false);
  assert.strictEqual(S.inWindow(local(2026, 9, 2, 1, 59), reboot), false);
  assert.strictEqual(S.inWindow(local(2026, 9, 3, 3, 0), reboot), false); // Thursday
  const late = { ...reboot, start: '23:00', hours: 3 };               // Wed 23:00 -> Thu 02:00
  assert.strictEqual(S.inWindow(local(2026, 9, 3, 1, 30), late), true);
  assert.strictEqual(S.inWindow(local(2026, 9, 3, 2, 0), late), false);
  assert.strictEqual(S.inWindow(local(2026, 9, 2, 2, 0), { ...reboot, start: 'nonsense' }), false);
});

test('nextWindowStart: current window when open, else next occurrence', () => {
  assert.deepStrictEqual(S.nextWindowStart(local(2026, 9, 2, 3, 0), reboot), local(2026, 9, 2, 2, 0));
  assert.deepStrictEqual(S.nextWindowStart(local(2026, 9, 2, 6, 0), reboot), local(2026, 9, 9, 2, 0));
  assert.deepStrictEqual(S.nextWindowStart(local(2026, 8, 31, 12, 0), reboot), local(2026, 9, 2, 2, 0)); // Monday
  assert.strictEqual(S.nextWindowStart(local(2026, 9, 2, 6, 0), { ...reboot, start: '25:00' }), null);
});

test('buildQueue: excludes skipped, contains every AP once, deterministic with seeded rng', () => {
  const aps = [{ mac: 'a' }, { mac: 'b', skip: true }, { mac: 'c' }, { mac: 'd' }];
  let n = 0;
  const rng = () => ((n += 0.37) % 1);
  const q1 = S.buildQueue(aps, rng);
  n = 0;
  const q2 = S.buildQueue(aps, rng);
  assert.deepStrictEqual([...q1].sort(), ['a', 'c', 'd']);
  assert.deepStrictEqual(q1, q2);
});

test('refillIfEmpty only starts a cycle when queue and inFlight are empty', () => {
  const now = local(2026, 9, 2, 2, 0);
  const s = S.emptySchedule();
  assert.strictEqual(S.refillIfEmpty(s, [{ mac: 'a' }, { mac: 'b' }], now, Math.random), true);
  assert.strictEqual(s.queue.length, 2);
  assert.strictEqual(s.cycleStartedAt, now.toISOString());
  assert.strictEqual(S.refillIfEmpty(s, [{ mac: 'a' }], now, Math.random), false);
  s.queue = [];
  s.inFlight = { a: { startedAt: now.getTime(), method: 'unifi', uptimeBefore: 1 } };
  assert.strictEqual(S.refillIfEmpty(s, [{ mac: 'a' }], now, Math.random), false);
});

test('requeueOnce re-queues a MAC once per cycle and refill resets that', () => {
  const s = S.emptySchedule();
  assert.strictEqual(S.requeueOnce(s, 'x'), true);
  assert.deepStrictEqual(s.queue, ['x']);
  s.queue = [];
  assert.strictEqual(S.requeueOnce(s, 'x'), false);
  S.refillIfEmpty(s, [{ mac: 'x' }], local(2026, 9, 2, 2, 0), Math.random);
  s.queue = [];
  assert.strictEqual(S.requeueOnce(s, 'x'), true);
});

test('nextActions respects concurrency, finishes confirmed and timed-out entries, never mutates input', () => {
  const t0 = local(2026, 9, 2, 2, 0).getTime();
  const sched = {
    ...S.emptySchedule(),
    queue: ['c', 'd', 'e', 'f'],
    inFlight: {
      a: { startedAt: t0, method: 'unifi', uptimeBefore: 999 },
      b: { startedAt: t0 - 9 * 60000, method: 'poe', uptimeBefore: null },
    },
  };
  const snapshot = JSON.stringify(sched);
  const r = S.nextActions(sched, { now: new Date(t0 + 60000), concurrency: 3, timeoutMinutes: 8, isBack: (m) => m === 'a' });
  assert.strictEqual(JSON.stringify(sched), snapshot);
  assert.deepStrictEqual(r.finished.map((f) => [f.mac, f.result]), [['a', 'ok'], ['b', 'timeout']]);
  assert.deepStrictEqual(r.start, ['c', 'd', 'e']);           // 0 in flight after finishing, 3 slots
  assert.deepStrictEqual(r.sched.queue, ['f']);
  assert.deepStrictEqual(r.sched.inFlight, {});
});

test('nextActions with concurrency 0 confirms in-flight but starts nothing', () => {
  const t0 = Date.now();
  const sched = { ...S.emptySchedule(), queue: ['x'], inFlight: { a: { startedAt: t0, method: 'unifi', uptimeBefore: 5 } } };
  const r = S.nextActions(sched, { now: new Date(t0 + 1000), concurrency: 0, timeoutMinutes: 8, isBack: () => true });
  assert.deepStrictEqual(r.start, []);
  assert.deepStrictEqual(r.finished.map((f) => f.mac), ['a']);
  assert.deepStrictEqual(r.sched.queue, ['x']);
});
