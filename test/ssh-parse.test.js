'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseApmap, cronScheduled, cycleMac } = require('../lib/ssh');

test('parseApmap maps lowercase MAC to port and ignores junk', () => {
  const txt = 'eth1 44:D9:E7:00:00:01 10.0.0.9 1700000000\neth3 f0:9f:c2:00:00:02 - 1700000001\n\nnot a line\n';
  assert.deepStrictEqual(parseApmap(txt), { '44:d9:e7:00:00:01': 'eth1', 'f0:9f:c2:00:00:02': 'eth3' });
  assert.deepStrictEqual(parseApmap(''), {});
});

test('cronScheduled requires check + weekly-reboot and forbids weekly-ap-cycle', () => {
  const P = '/config/scripts/poe-watchdog.sh';
  const good = `*/1 * * * * root ${P}\n0 4 * * 0 root ${P} weekly-reboot\n`;
  const legacy = good + `30 4 * * 3 root ${P} weekly-ap-cycle\n`;
  const noReboot = `*/1 * * * * root ${P}\n`;
  assert.strictEqual(cronScheduled(good), true);
  assert.strictEqual(cronScheduled(legacy), false);
  assert.strictEqual(cronScheduled(noReboot), false);
  assert.strictEqual(cronScheduled(''), false);
});

test('cycleMac rejects an invalid MAC before opening a connection', async () => {
  await assert.rejects(
    cycleMac({ ssh: {} }, { username: 'u', password: 'p' }, '10.0.0.1', 'a; reboot #'),
    /invalid MAC/
  );
});
