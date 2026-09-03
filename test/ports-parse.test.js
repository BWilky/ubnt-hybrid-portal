'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parsePorts } = require('../lib/ssh');

const line = (a) => a.join('\t');

test('parsePorts: full row, down row, sfp row, junk', () => {
  const txt = [
    line(['eth1', 'up', '1000', '24v', 'on', '44:d9:e7:00:00:01', '100', '200', '1', '0', 'allowed,managed', '1700000000', 'cut']),
    line(['eth2', 'down', '-', '24v', 'off', '-', '0', '0', '0', '0', '-', '-', '-']),
    line(['eth5', 'up', '1000', 'none', '-', '-', '5', '6', '0', '0', 'sfp,uplink', '-', '-']),
    'garbage line',
    '',
  ].join('\n');
  const p = parsePorts(txt);
  assert.strictEqual(p.length, 3);
  assert.deepStrictEqual(p[0], {
    port: 'eth1', link: 'up', speed: 1000, poeCfg: '24v', poeLive: 'on',
    mac: '44:d9:e7:00:00:01', rxBytes: 100, txBytes: 200, rxErr: 1, txErr: 0,
    flags: ['allowed', 'managed'], lastEvent: { at: 1700000000000, action: 'cut' },
  });
  assert.strictEqual(p[1].speed, null);          // '-' → null
  assert.deepStrictEqual(p[1].flags, []);        // '-' → []
  assert.strictEqual(p[1].lastEvent, null);
  assert.deepStrictEqual(p[2].flags, ['sfp', 'uplink']);
});

test('parsePorts tolerates empty input', () => {
  assert.deepStrictEqual(parsePorts(''), []);
});
