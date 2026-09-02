'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TPL = path.join(__dirname, '..', 'templates', 'poe-watchdog.sh.tpl');

function render(vars) {
  const all = {
    GATEWAY_IP: '10.0.0.1', SECONDARY_IP: '', FAIL_LIMIT: 5, RECOVER_OK: 2, AP_FAIL_LIMIT: 3, CYCLE_COOLDOWN: 600,
    EXCLUDE_PORTS: '', REBOOT_CRON: '0 4 * * 0', DEVICE_NAME: 'test', DEVICE_IP: '10.0.0.2',
    RENDERED_AT: 'test', PROTECTED_MACS: '', ALLOWED_MACS: '', ...vars,
  };
  let out = fs.readFileSync(TPL, 'utf8');
  for (const [k, v] of Object.entries(all)) out = out.split('{{' + k + '}}').join(String(v));
  return out;
}

// Runs `body` in bash with the rendered script sourced in library mode and a
// fake switch: config.boot with eth1..eth4 on 24v, MAC table from `mactbl`.
function harness(vars, mactbl, body) {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-'));
  const script = path.join(t, 'poe-watchdog.sh');
  fs.writeFileSync(script, render(vars));
  fs.writeFileSync(path.join(t, 'config.boot'), [
    'interfaces {', '    ethernet eth0 {', '    }',
    ...['eth1', 'eth2', 'eth3', 'eth4'].flatMap((p) => [`    ethernet ${p} {`, '        poe {', '            output 24v', '        }', '    }']),
    '}', ''].join('\n'));
  fs.writeFileSync(path.join(t, 'mactbl'), mactbl.join('\n') + '\n');
  const pre = `
export STATE="${t}/state" PERSIST="${t}/persist" CONFIG_BOOT="${t}/config.boot" POE_WATCHDOG_LIB=1
source "${script}"
mac_table() { cat "${t}/mactbl"; }
poe_set() { echo "$1 $2" >> "${t}/poe_calls"; }
log() { :; }
POE_OFF_SECS=0
UPLINK_PORT="$(detect_uplink_port)"
PROTECTED_PORTS="$(detect_protected_ports)"
ALLOWED_PORTS="$(detect_allowed_ports)"
`;
  const r = spawnSync('bash', ['-c', pre + body], { encoding: 'utf8' });
  const calls = fs.existsSync(path.join(t, 'poe_calls')) ? fs.readFileSync(path.join(t, 'poe_calls'), 'utf8').trim().split('\n') : [];
  const allowed = fs.existsSync(path.join(t, 'persist', 'allowed-ports')) ? fs.readFileSync(path.join(t, 'persist', 'allowed-ports'), 'utf8').trim().split('\n').filter(Boolean) : [];
  return { stdout: r.stdout.trim(), stderr: r.stderr.trim(), status: r.status, calls, allowed };
}

const TABLE = ['eth1 44:d9:e7:00:00:01', 'eth2 f0:9f:c2:00:00:02', 'eth3 00:11:22:33:44:55'];

test('rendered script parses (bash -n) and has no weekly-ap-cycle mode', () => {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-'));
  const p = path.join(t, 's.sh');
  fs.writeFileSync(p, render({ ALLOWED_MACS: 'aa:bb:cc:dd:ee:ff' }));
  const r = spawnSync('bash', ['-n', p], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const src = fs.readFileSync(p, 'utf8');
  assert.ok(!/weekly-ap-cycle|mode_weekly_ap_cycle|STAGGER_SECS/.test(src));
  assert.ok(/cycle-mac/.test(src) && /apmap\)/.test(src));
});

test('empty ALLOWED_MACS keeps legacy behaviour: all 24v ports managed', () => {
  const r = harness({}, TABLE, 'managed_ports');
  assert.deepStrictEqual(r.stdout.split('\n'), ['eth1', 'eth2', 'eth3', 'eth4']);
  assert.deepStrictEqual(r.allowed, []);
});

test('non-empty ALLOWED_MACS: only ports where an allowed MAC was seen are managed, and the learning persists', () => {
  const r = harness({ ALLOWED_MACS: '44:d9:e7:00:00:01 f0:9f:c2:00:00:02' }, TABLE, 'managed_ports');
  assert.deepStrictEqual(r.stdout.split('\n'), ['eth1', 'eth2']);
  assert.deepStrictEqual(r.allowed.sort(), ['eth1', 'eth2']);
});

test('EXCLUDE_PORTS still wins over the whitelist', () => {
  const r = harness({ ALLOWED_MACS: '44:d9:e7:00:00:01 f0:9f:c2:00:00:02', EXCLUDE_PORTS: 'eth2' }, TABLE, 'managed_ports');
  assert.deepStrictEqual(r.stdout.split('\n'), ['eth1']);
});

test('apmap prints the persisted map', () => {
  const r = harness({}, TABLE, 'update_apmap eth1 44:d9:e7:00:00:01 10.0.0.9 1700000000; mode_apmap');
  assert.strictEqual(r.stdout, 'eth1 44:d9:e7:00:00:01 10.0.0.9 1700000000');
});

test('cycle-mac: cycles a known managed port, exit 2 for unknown MAC, exit 3 for unmanaged port', () => {
  const vars = { ALLOWED_MACS: '44:d9:e7:00:00:01 f0:9f:c2:00:00:02', EXCLUDE_PORTS: 'eth2' };
  const ok = harness(vars, TABLE, '( mode_cycle_mac 44:D9:E7:00:00:01 ); echo "rc=$?"');
  assert.match(ok.stdout, /cycled eth1[\s\S]*rc=0/);
  assert.deepStrictEqual(ok.calls, ['eth1 off', 'eth1 24v']);
  const unknown = harness(vars, TABLE, '( mode_cycle_mac de:ad:be:ef:00:00 ); echo "rc=$?"');
  assert.match(unknown.stdout, /unknown mac de:ad:be:ef:00:00[\s\S]*rc=2/);
  const unmanaged = harness(vars, TABLE, '( mode_cycle_mac f0:9f:c2:00:00:02 ); echo "rc=$?"');
  assert.match(unmanaged.stdout, /port eth2 not managed[\s\S]*rc=3/);
  assert.deepStrictEqual(unmanaged.calls, []);
});
