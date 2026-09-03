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

// Build a fake /sys/class/net tree: ports = { eth1: { carrier:'1', speed:'1000',
// rx_bytes, tx_bytes, rx_errors, tx_errors } , ... }
function sysnet(dir, ports) {
  const root = path.join(dir, 'sysnet');
  for (const [p, f] of Object.entries(ports)) {
    const d = path.join(root, p);
    fs.mkdirSync(path.join(d, 'statistics'), { recursive: true });
    fs.writeFileSync(path.join(d, 'carrier'), (f.carrier ?? '0') + '\n');
    fs.writeFileSync(path.join(d, 'speed'), (f.speed ?? '-1') + '\n');
    for (const s of ['rx_bytes', 'tx_bytes', 'rx_errors', 'tx_errors']) {
      fs.writeFileSync(path.join(d, 'statistics', s), String(f[s] ?? 0) + '\n');
    }
  }
  return root;
}

// Run `body` with the script sourced in library mode, a fake switch config,
// a fake MAC table, and a fake SYSNET tree.
function portsHarness(vars, mactbl, ports, body) {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-'));
  const script = path.join(t, 'poe-watchdog.sh');
  fs.writeFileSync(script, render(vars));
  fs.writeFileSync(path.join(t, 'config.boot'), [
    'interfaces {', '    ethernet eth0 {', '    }',
    ...['eth1', 'eth2', 'eth3', 'eth4'].flatMap((p) => [`    ethernet ${p} {`, '        poe {', '            output 24v', '        }', '    }']),
    '}', ''].join('\n'));
  fs.writeFileSync(path.join(t, 'mactbl'), mactbl.join('\n') + '\n');
  const root = sysnet(t, ports);
  const pre = `
export STATE="${t}/state" PERSIST="${t}/persist" CONFIG_BOOT="${t}/config.boot" SYSNET="${root}" POE_WATCHDOG_LIB=1
source "${script}"
mac_table() { cat "${t}/mactbl"; }
poe_set() { echo "$1 $2" >> "${t}/poe_calls"; }
poe_cfg() { case "$1" in eth0) echo none ;; *) echo 24v ;; esac; }
poe_live() { echo on; }
log() { :; }
UPLINK_PORT="$(detect_uplink_port)"
PROTECTED_PORTS="$(detect_protected_ports)"
ALLOWED_PORTS="$(detect_allowed_ports)"
`;
  const r = spawnSync('bash', ['-c', pre + body], { encoding: 'utf8' });
  return { stdout: r.stdout.trim(), stderr: r.stderr.trim(), status: r.status, dir: t };
}

const PTABLE = ['eth1 44:d9:e7:00:00:01', 'eth2 f0:9f:c2:00:00:02'];
const PORTS = {
  eth0: { carrier: '1', speed: '1000' },
  eth1: { carrier: '1', speed: '1000', rx_bytes: 100, tx_bytes: 200, rx_errors: 1, tx_errors: 0 },
  eth2: { carrier: '0', speed: '-1' },
};

test('ports mode: one line per ethN with link, speed, poe, mac, counters, flags', () => {
  const r = portsHarness({ ALLOWED_MACS: '44:d9:e7:00:00:01 f0:9f:c2:00:00:02' }, PTABLE, PORTS, 'mode_ports');
  const rows = Object.fromEntries(r.stdout.split('\n').map((l) => [l.split('\t')[0], l.split('\t')]));
  // eth1: up, 1000, poe 24v, live on, mac, counters, flags include allowed+managed
  assert.deepStrictEqual(rows.eth1.slice(0, 10),
    ['eth1', 'up', '1000', '24v', 'on', '44:d9:e7:00:00:01', '100', '200', '1', '0']);
  assert.match(rows.eth1[10], /allowed/);
  assert.match(rows.eth1[10], /managed/);
  // eth2 is down: link down, speed '-', mac '-' (nothing learned while down is fine)
  assert.strictEqual(rows.eth2[1], 'down');
  assert.strictEqual(rows.eth2[2], '-');
  // eth0 has no poe
  assert.strictEqual(rows.eth0[3], 'none');
  // lastEventEpoch/lastEventAction are separate trailing columns; none logged yet
  assert.strictEqual(rows.eth1.length, 13);
  assert.strictEqual(rows.eth1[11], '-');
  assert.strictEqual(rows.eth1[12], '-');
});

test('ports mode: lastEventEpoch and lastEventAction are separate columns for a logged event', () => {
  const r = portsHarness({ ALLOWED_MACS: '44:d9:e7:00:00:01 f0:9f:c2:00:00:02' }, PTABLE, PORTS,
    'log_event eth1 cut "x" watchdog; mode_ports');
  const eth1 = r.stdout.split('\n').map((l) => l.split('\t')).find((c) => c[0] === 'eth1');
  assert.strictEqual(eth1.length, 13);
  assert.match(eth1[11], /^\d+$/);
  assert.strictEqual(eth1[12], 'cut');
});

test('ports mode: manual-off port shows the flag and is not managed', () => {
  const r = portsHarness({ ALLOWED_MACS: '44:d9:e7:00:00:01 f0:9f:c2:00:00:02' }, PTABLE, PORTS,
    'mkdir -p "$PERSIST/manual-off"; touch "$PERSIST/manual-off/eth1"; ALLOWED_PORTS="$(detect_allowed_ports)"; mode_ports');
  const eth1 = r.stdout.split('\n').map((l) => l.split('\t')).find((c) => c[0] === 'eth1');
  assert.match(eth1[10], /manual-off/);
  assert.doesNotMatch(eth1[10], /(^|,)managed(,|$)/);
});

test('empty ALLOWED_MACS: no port is managed (OUI fallback removed)', () => {
  const r = portsHarness({ ALLOWED_MACS: '' }, PTABLE, PORTS, 'managed_ports');
  assert.strictEqual(r.stdout, '');
});

test('port-events prints logged events, newest last, filterable by port', () => {
  const r = portsHarness({}, PTABLE, PORTS,
    'log_event eth1 cut "uplink down" watchdog; log_event eth2 cycle manual portal; mode_port_events eth1');
  assert.match(r.stdout, /eth1 cut/);
  assert.doesNotMatch(r.stdout, /eth2/);
});

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

test('empty ALLOWED_MACS: no port managed (OUI fallback removed)', () => {
  const r = harness({}, TABLE, 'managed_ports');
  assert.strictEqual(r.stdout, '');
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
