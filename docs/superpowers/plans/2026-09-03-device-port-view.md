# Device Port View, Manual PoE Control, and Uplink-Loss Escalation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-device watchdog-status and overrides modals with a full device page that shows every ER-X port UISP-style, lets the user click a port to inspect and control it (exclude/include, cycle, persistent PoE off/on, reboot the AP behind it), make the watchdog strictly UniFi-whitelist driven, add an uplink-loss escalation ladder, and poll port data with minimal SSH load.

**Architecture:** The on-switch bash script (`templates/poe-watchdog.sh.tpl`) gains machine-readable `ports` and `port-events` modes and manual `poe-set`/`cycle-port` modes, drops the legacy OUI fallback, and adds an escalation ladder. `lib/ssh.js` gains a port parser and four port operations. A new pure-logic `lib/portpoller.js` schedules SSH reads so no two switches are read at once. `server.js` enriches port data with UniFi-AP and backhaul-radio identity and exposes port routes. The CoreUI vanilla-JS frontend gains a device page at `#/devices/<key>`.

**Tech Stack:** Node 18+ (`node:test`, `node:assert`, ssh2), Express 4, bash (EdgeOS/vbash), CoreUI 5 / Bootstrap 5 vanilla JS. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-03-device-port-view-design.md`

**Base branch:** start from `main` at or after v1.2.2 (commit `ff1e19e`).

## Global Constraints

- **PoE always returns on power cycle.** The watchdog cuts/restores PoE with `commit` only, never `save`; deploy refuses to `save` while `/var/run/poe-watchdog/cut_ports` exists. A manually-off port (`$PERSIST/manual-off/ethN`) is the ONLY saved PoE-off state.
- **EdgeOS config over SSH uses `;`-separated `vyatta-cfg-cmd-wrapper` statements in one shell — never `&&`, never `( … )` subshells** (the wrapper keys its session to the shell; `&&` aborts on benign non-zero; subshells lose the session). The conditional save is `if [ ! -f … ]; then W save; fi`.
- **The uplink port is never cut, cycled, excluded, or switched off** — enforced in UI, server (400/409), and script (exit 3).
- **Protected ports (UISP backhaul radios) are never cut or cycled.** Manual cycle of a protected port is refused (exit 3).
- **Empty `ALLOWED_MACS` manages nothing.** The `UBNT_OUIS` table and OUI fallback are deleted.
- **Manual-off ports are invisible to the watchdog**: not managed, not cut, not restored, not healed at boot, not escalation-cycled. Only a manual "on" clears the marker.
- **A switch only reboots itself, at most once per outage** (`$PERSIST/outage_rebooted`).
- **All remote arguments are regex-validated before interpolation**: `PORT_RE = /^eth\d+$/`, MAC regex, `mode ∈ {off,24v}`.
- Tests run with `npm test` (`node --test test/*.test.js`), no new dependencies. The suite currently passes 27; each task states the new expected total.
- All user-supplied strings pass through `esc()` before `innerHTML`. No CDN.
- Do not bump `package.json` version, tag, or push. The user releases with a local gitignored script.

## Local test environment

`config.json` (gitignored) has a real UniFi controller; read-only calls are fine. `state/devices.json` mirrors `state/seed.json`; restore it after any browser test with `cp state/seed.json state/devices.json`. Start the server with `node server.js`; port `127.0.0.1:8090` must be free (if `lsof -nP -i :8090` shows a PID you did not start, report it, do not kill it). **Never run `poe-set`, `cycle-port`, `cycle-mac`, or any reboot against a real switch except in Task 8, and there only on the single spare port / switch the user names.** The bash tests use a harness that sources the rendered script in library mode (`POE_WATCHDOG_LIB=1`) with faked `/sys/class/net`, `mac_table`, and `poe_set`; they never touch hardware.

---

### Task 1: Watchdog template — `ports` and `port-events` modes, strict whitelist, manual-off awareness

**Files:**
- Modify: `templates/poe-watchdog.sh.tpl`
- Modify: `test/watchdog.test.js`

**Interfaces:**
- Produces: modes `ports` (tab-separated `port link speed poeCfg poeLive mac rxBytes txBytes rxErr txErr flags lastEventEpoch lastEventAction` per `ethN`, read-only, no lock) and `port-events [ethN]` (prints `$PERSIST/port-events` lines, optionally filtered). Helpers `poe_cfg ethN`, `poe_live ethN`, `port_flags ethN`, `log_event port action reason source`. `managed_ports` excludes `manual-off` ports and returns nothing when `ALLOWED_MACS` is empty (OUI fallback removed). Test-only env overrides already exist: `STATE`, `PERSIST`, `CONFIG_BOOT`, `POE_WATCHDOG_LIB=1`; this task adds `SYSNET` (defaults `/sys/class/net`) so the harness can fake port sysfs, and `PORTEVENTS="$PERSIST/port-events"`.

- [ ] **Step 1: Write the failing tests**

Add to `test/watchdog.test.js`. The existing `harness(vars, mactbl, body)` sources the script in library mode; extend it to build a fake `SYSNET` tree and export `PORTEVENTS`. Add this near the top of the file (after the existing `harness` definition), then the tests:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/watchdog.test.js`
Expected: FAIL — `mode_ports`, `mode_port_events`, `log_event`, `poe_cfg`/`poe_live` (as script functions) do not exist; `managed_ports` with empty `ALLOWED_MACS` still returns ports (legacy branch present).

- [ ] **Step 3: Add the mode list, PORTEVENTS/SYSNET, and drop the OUI table**

In `templates/poe-watchdog.sh.tpl`:

Replace the `# Modes:` block to add the new modes:

```bash
# Modes:
#   poe-watchdog.sh check           (default; run every 1 min via task-scheduler)
#   poe-watchdog.sh weekly-reboot   (log + reboot the whole router)
#   poe-watchdog.sh status          (show learned APs, counters, state)
#   poe-watchdog.sh apmap           (machine-readable learned port map)
#   poe-watchdog.sh ports           (machine-readable per-port table, for the portal)
#   poe-watchdog.sh port-events [ethN]  (per-port action history)
#   poe-watchdog.sh cycle-mac <mac> (PoE-cycle the port carrying <mac>)
#   poe-watchdog.sh cycle-port <ethN>   (portal: PoE-cycle a specific port)
#   poe-watchdog.sh poe-set <ethN> off|24v  (portal: persistent manual PoE)
```

After the `APMAP=`/`STATICMAP=` lines add:

```bash
PORTEVENTS="$PERSIST/port-events"       # ethN action history: epoch port action reason source
SYSNET=${SYSNET:-/sys/class/net}        # overridable for tests
```

Delete the `UBNT_OUIS="..."` assignment (all continuation lines) and the `is_ubnt_oui()` function.

- [ ] **Step 4: Add the port helpers, event log, and read modes**

After `poe_cycle()` add PoE-inspection helpers (the harness overrides these, but production needs them):

```bash
# PoE config for a port from the running config: 24v|off|48v|pthru|none.
poe_cfg() {
    local out
    out=$(sudo $CFGWRAP show interfaces ethernet "$1" poe output 2>/dev/null | awk '{print $NF}')
    case "$out" in 24v|48v|off) echo "$out" ;; pthru|passthrough) echo pthru ;; *) echo none ;; esac
}

# Live PoE delivery state if the HAL reports it: on|off|-.
poe_live() {
    local hal p
    for hal in /usr/sbin/ubnt-hal /usr/sbin/ubnt-hal-e; do
        [ -x "$hal" ] || continue
        p=$("$hal" getPortPower "${1#eth}" 2>/dev/null | tr 'A-Z' 'a-z')
        case "$p" in *on*|*enable*|*24*|*48*) echo on; return ;; *off*|*disable*) echo off; return ;; esac
    done
    echo -
}
```

After `update_apmap()` add the event log and flags helper:

```bash
# Append a per-port action to the event log (trimmed to the last 200).
log_event() {  # port action reason source
    local port="$1" action="$2" reason="$3" source="${4:-watchdog}"
    echo "$(date +%s) $port $action ${reason:-} $source" >> "$PORTEVENTS"
    tail -n 200 "$PORTEVENTS" > "$PORTEVENTS.tmp" 2>/dev/null && mv "$PORTEVENTS.tmp" "$PORTEVENTS"
}

# Comma list of flags for a port, or '-'.
port_flags() {  # port managed-list
    local p="$1" managed="$2" f=""
    case " $UPLINK_PORT " in *" $p "*) f="$f,uplink" ;; esac
    case " $PROTECTED_PORTS " in *" $p "*) f="$f,protected" ;; esac
    case " $EXCLUDE_PORTS " in *" $p "*) f="$f,excluded" ;; esac
    case " $ALLOWED_PORTS " in *" $p "*) f="$f,allowed" ;; esac
    case "$managed" in *" $p "*) f="$f,managed" ;; esac
    [ -f "$PERSIST/manual-off/$p" ] && f="$f,manual-off"
    [ -f "$STATE/cut_ports" ] && grep -qx "$p" "$STATE/cut_ports" 2>/dev/null && f="$f,cut"
    [ "$p" = eth5 ] && f="$f,sfp"
    echo "${f#,}" | sed 's/^$/-/'
}
```

Add the read modes near `mode_apmap`:

```bash
mode_ports() {
    local p dir carrier speed mac rxb txb rxe txe last
    local managed=" $(managed_ports | tr '\n' ' ') "
    local tbl; tbl=$(mac_table)
    for dir in "$SYSNET"/eth*; do
        [ -d "$dir" ] || continue
        p=$(basename "$dir")
        carrier=$([ "$(cat "$dir/carrier" 2>/dev/null)" = "1" ] && echo up || echo down)
        speed=$(cat "$dir/speed" 2>/dev/null)
        { [ "$carrier" = up ] && [ "${speed:-0}" -gt 0 ] 2>/dev/null; } || speed="-"
        mac=$(echo "$tbl" | awk -v pp="$p" '$1 == pp { print $2; exit }'); [ -n "$mac" ] || mac="-"
        rxb=$(cat "$dir/statistics/rx_bytes" 2>/dev/null || echo 0)
        txb=$(cat "$dir/statistics/tx_bytes" 2>/dev/null || echo 0)
        rxe=$(cat "$dir/statistics/rx_errors" 2>/dev/null || echo 0)
        txe=$(cat "$dir/statistics/tx_errors" 2>/dev/null || echo 0)
        last=$(awk -v pp="$p" '$2 == pp { e=$1; a=$3 } END { print (e ? e" "a : "- -") }' "$PORTEVENTS" 2>/dev/null)
        [ -n "$last" ] || last="- -"
        printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
            "$p" "$carrier" "$speed" "$(poe_cfg "$p")" "$(poe_live "$p")" "$mac" \
            "$rxb" "$txb" "$rxe" "$txe" "$(port_flags "$p" "$managed")" "$last"
    done
}

mode_port_events() {  # [ethN]
    [ -f "$PORTEVENTS" ] || return 0
    if [ -n "${1:-}" ]; then awk -v pp="$1" '$2 == pp' "$PORTEVENTS"; else cat "$PORTEVENTS"; fi
}
```

- [ ] **Step 5: Make the whitelist strict and manual-off-aware**

Replace `managed_ports()` with (drops the legacy OUI branch, adds manual-off exclusion):

```bash
managed_ports() {
    [ -n "$ALLOWED_MACS" ] || return 0          # empty whitelist manages nothing
    awk '
        /^[[:space:]]+ethernet eth[0-9]+/ { iface=$2 }
        /output 24v/                      { if (iface != "") print iface }
    ' "$CONFIG_BOOT" | sort -u | while read -r p; do
        case " $EXCLUDE_PORTS $UPLINK_PORT $PROTECTED_PORTS " in *" $p "*) continue ;; esac
        case " $ALLOWED_PORTS " in *" $p "*) ;; *) continue ;; esac
        [ -f "$PERSIST/manual-off/$p" ] && continue
        echo "$p"
    done
}
```

In `discover_aps()`, replace the `is_ubnt_mac`/OUI filter with taking the first MAC on the port (the whitelist already gates which ports are managed):

```bash
        mac=$(echo "$tbl" | awk -v p="$port" '$1 == p { print $2; exit }')
```

(Delete the `is_ubnt_mac`/`while read` OUI block. `is_ubnt_mac` and `ip_for_mac` — keep `ip_for_mac`; delete `is_ubnt_mac` if now unused.)

- [ ] **Step 6: Wire the modes and run the tests**

In the entry block `case "$MODE"`, add read-only (no-lock) cases alongside `status|apmap`:

```bash
        status|apmap|ports|port-events) ;;   # read-only, no lock
```

and dispatch:

```bash
        ports)         mode_ports ;;
        port-events)   mode_port_events "${2:-}" ;;
```

Run: `npm test`
Expected: `pass 31 / fail 0` (27 + 4 new). If `bash` on macOS lacks a tool the harness uses, the harness never runs the entry block, so only the sourced functions matter.

- [ ] **Step 7: Commit**

```bash
git add templates/poe-watchdog.sh.tpl test/watchdog.test.js
git commit -m "Watchdog: ports + port-events modes, strict whitelist, manual-off awareness; drop OUI fallback"
```

---

### Task 2: Watchdog template — `poe-set` and `cycle-port` modes, event logging on watchdog actions

**Files:**
- Modify: `templates/poe-watchdog.sh.tpl`
- Modify: `test/watchdog.test.js`

**Interfaces:**
- Produces: modes `poe-set ethN off|24v` (persistent manual PoE: commit+save, writes/removes `$PERSIST/manual-off/ethN`, exit 0 `set ethN off|24v`, exit 3 for uplink/no-PoE port) and `cycle-port ethN` (exit 0 `cycled ethN`, exit 3 uplink/protected/non-24v). Both take the lock (exit 4 `busy`). Watchdog `cut_all_poe`/`restore_all_poe`/`check_aps` now call `log_event`.
- Consumes: `log_event`, `poe_cfg`, `port_flags`, `managed_ports` from Task 1.

- [ ] **Step 1: Write the failing tests**

Add to `test/watchdog.test.js`:

```js
test('poe-set off: writes the manual-off marker and saves; on: removes it', () => {
  const r = portsHarness({ ALLOWED_MACS: '44:d9:e7:00:00:01' }, PTABLE, PORTS,
    '( mode_poe_set eth1 off ); echo "rc=$?"; ls "$PERSIST/manual-off" 2>/dev/null');
  assert.match(r.stdout, /set eth1 off[\s\S]*rc=0[\s\S]*eth1/);
  const r2 = portsHarness({ ALLOWED_MACS: '44:d9:e7:00:00:01' }, PTABLE, PORTS,
    'mkdir -p "$PERSIST/manual-off"; touch "$PERSIST/manual-off/eth1"; ( mode_poe_set eth1 24v ); echo "rc=$?"; ls "$PERSIST/manual-off" 2>/dev/null | wc -l | tr -d " "');
  assert.match(r2.stdout, /set eth1 24v[\s\S]*rc=0[\s\S]*\n0$/);
});

test('poe-set refuses the uplink port (exit 3)', () => {
  const r = portsHarness({ ALLOWED_MACS: '44:d9:e7:00:00:01' }, ['eth3 aa:bb:cc:00:00:aa'],
    { ...PORTS, eth3: { carrier: '1', speed: '1000' } },
    'UPLINK_PORT=eth3; ( mode_poe_set eth3 off ); echo "rc=$?"');
  assert.match(r.stdout, /uplink[\s\S]*rc=3/);
});

test('cycle-port cycles a managed 24v port and logs the event; refuses protected (exit 3)', () => {
  const ok = portsHarness({ ALLOWED_MACS: '44:d9:e7:00:00:01 f0:9f:c2:00:00:02' }, PTABLE, PORTS,
    '( mode_cycle_port eth1 ); echo "rc=$?"; mode_port_events eth1');
  assert.match(ok.stdout, /cycled eth1[\s\S]*rc=0[\s\S]*eth1 cycle/);
  const prot = portsHarness({ ALLOWED_MACS: '44:d9:e7:00:00:01' }, PTABLE, PORTS,
    'PROTECTED_PORTS=eth1; ( mode_cycle_port eth1 ); echo "rc=$?"');
  assert.match(prot.stdout, /protected[\s\S]*rc=3/);
});

test('cut_all_poe logs a cut event per port', () => {
  const r = portsHarness({ ALLOWED_MACS: '44:d9:e7:00:00:01 f0:9f:c2:00:00:02' }, PTABLE, PORTS,
    'cut_all_poe; mode_port_events');
  assert.match(r.stdout, /eth1 cut/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/watchdog.test.js`
Expected: FAIL — `mode_poe_set`, `mode_cycle_port` undefined; `cut_all_poe` does not log events.

- [ ] **Step 3: Add the manual modes**

After `mode_cycle_mac()` add:

```bash
mode_poe_set() {  # poe-set ethN off|24v
    local p="$1" mode="${2:-}"
    [ -n "$p" ] && { [ "$mode" = off ] || [ "$mode" = 24v ]; } || { echo "usage: $0 poe-set <ethN> off|24v"; exit 1; }
    case " $UPLINK_PORT " in *" $p "*) echo "port $p is the uplink"; exit 3 ;; esac
    [ "$(poe_cfg "$p")" = none ] && { echo "port $p has no PoE"; exit 3; }
    mkdir -p "$PERSIST/manual-off"
    if [ "$mode" = off ]; then
        poe_set "$p" off
        touch "$PERSIST/manual-off/$p"
        log_event "$p" manual-off "" portal
    else
        poe_set "$p" 24v
        rm -f "$PERSIST/manual-off/$p"
        log_event "$p" manual-on "" portal
    fi
    poe_save         # persist so a reboot keeps a manual off (and clears a manual on)
    echo "set $p $mode"
}

mode_cycle_port() {  # cycle-port ethN
    local p="$1"
    [ -n "$p" ] || { echo "usage: $0 cycle-port <ethN>"; exit 1; }
    case " $UPLINK_PORT " in *" $p "*) echo "port $p is the uplink"; exit 3 ;; esac
    case " $PROTECTED_PORTS " in *" $p "*) echo "port $p is protected"; exit 3 ;; esac
    [ "$(poe_cfg "$p")" = 24v ] || { echo "port $p is not 24v PoE"; exit 3; }
    log "portal requested PoE cycle of $p"
    log_event "$p" cycle "manual" portal
    poe_cycle "$p"
    echo "cycled $p"
}
```

Add a `poe_save` helper next to `poe_set` (uses the `;`-separated, no-subshell idiom from the Global Constraints):

```bash
# Persist the running config to config.boot. Guarded by callers so it never
# runs while the watchdog has PoE cut.
poe_save() {
    sg vyattacfg -c "$CFGWRAP begin; $CFGWRAP save; $CFGWRAP end" >/dev/null 2>&1
}
```

- [ ] **Step 4: Log watchdog PoE actions**

In `cut_all_poe()`, inside the `for p` loop after `poe_set "$p" off`, add `log_event "$p" cut "uplink down" watchdog`.
In `restore_all_poe()`, inside the `while read` loop after `poe_set "$p" 24v`, add `log_event "$p" restore "uplink up" watchdog`.
In `check_aps()`, after `poe_cycle "$port"` (the dead-AP branch), add `log_event "$port" cycle "AP unreachable" watchdog`.

In `boot_heal()`, make the manual-off marker win over healing: at the top of the loop that re-enables ports from `$PERSIST/cut_ports` (and the `cycling.*` breadcrumb loop), skip a port whose marker exists — `[ -f "$PERSIST/manual-off/$p" ] && continue`. This keeps a deliberate manual-off from being undone by a reboot.

- [ ] **Step 5: Wire the modes**

In the entry block, add `cycle-port|poe-set` to the lock-taking group (same as `cycle-mac`):

```bash
        cycle-mac|cycle-port|poe-set)
            exec 200> "$LOCK"
            flock -w 90 200 || { echo "busy"; exit 4; } ;;
```

and dispatch:

```bash
        cycle-port)    mode_cycle_port "${2:-}" ;;
        poe-set)       mode_poe_set "${2:-}" "${3:-}" ;;
```

Update the usage string at the bottom to include `cycle-port <ethN>` and `poe-set <ethN> off|24v`.

- [ ] **Step 6: Run the tests**

Run: `npm test`
Expected: `pass 35 / fail 0` (31 + 4 new).

- [ ] **Step 7: Commit**

```bash
git add templates/poe-watchdog.sh.tpl test/watchdog.test.js
git commit -m "Watchdog: poe-set + cycle-port manual modes, event logging on watchdog PoE actions"
```

---

### Task 3: Watchdog template — uplink-loss escalation ladder

**Files:**
- Modify: `templates/poe-watchdog.sh.tpl`
- Modify: `test/watchdog.test.js`

**Interfaces:**
- Produces: template variables `{{ESCALATE_CYCLES}}` (default 3) and `{{ESCALATE_REBOOT}}` (default 1); escalation state `$STATE/outage_cycles`, guard `$PERSIST/outage_rebooted`; `mode_status` gains an `escalation` line during an outage. The reboot action is a `do_reboot` function so the harness can stub it.
- Consumes: `cut_all_poe`, `managed_ports`, `poe_cycle`, `log_event`, `getn`/`setn` from earlier tasks.

- [ ] **Step 1: Write the failing tests**

Add to `test/watchdog.test.js`. `render()` must supply the two new vars (add them to its defaults):

```js
// in render()'s `all` defaults object, add:
//   ESCALATE_CYCLES: 3, ESCALATE_REBOOT: 1,
```

Tests:

```js
test('escalation: re-cycles managed ports each cooldown, then reboots once, then stops rebooting', () => {
  const r = portsHarness({ ALLOWED_MACS: '44:d9:e7:00:00:01 f0:9f:c2:00:00:02', ESCALATE_CYCLES: 2, ESCALATE_REBOOT: 1, CYCLE_COOLDOWN: 0 },
    PTABLE, PORTS, `
    do_reboot() { echo "REBOOT" >> "${'${'}dir:-/tmp}/reboots" 2>/dev/null; echo REBOOT; }
    setn upfail 5; : > "$STATE/cut_ports"; echo eth1 > "$STATE/cut_ports"; echo eth2 >> "$STATE/cut_ports"
    escalate; echo "cycles=$(getn outage_cycles)"
    escalate; echo "cycles=$(getn outage_cycles)"
    escalate; echo "after=$(getn outage_cycles) rebooted=$([ -f "$PERSIST/outage_rebooted" ] && echo yes || echo no)"
    escalate`);
  // 2 re-cycles bump the counter to 2, the 3rd escalate reboots once
  assert.match(r.stdout, /cycles=1[\s\S]*cycles=2/);
  assert.match(r.stdout, /rebooted=yes/);
  assert.strictEqual((r.stdout.match(/REBOOT/g) || []).length, 1, 'reboots exactly once per outage');
});

test('escalation with ESCALATE_REBOOT=0 never reboots', () => {
  const r = portsHarness({ ALLOWED_MACS: '44:d9:e7:00:00:01', ESCALATE_CYCLES: 1, ESCALATE_REBOOT: 0, CYCLE_COOLDOWN: 0 },
    PTABLE, PORTS, `
    do_reboot() { echo REBOOT; }
    : > "$STATE/cut_ports"; echo eth1 > "$STATE/cut_ports"
    escalate; escalate; escalate`);
  assert.doesNotMatch(r.stdout, /REBOOT/);
});

test('escalation never reboots while a manual cycle breadcrumb exists', () => {
  const r = portsHarness({ ALLOWED_MACS: '44:d9:e7:00:00:01', ESCALATE_CYCLES: 0, ESCALATE_REBOOT: 1, CYCLE_COOLDOWN: 0 },
    PTABLE, PORTS, `
    do_reboot() { echo REBOOT; }
    : > "$STATE/cut_ports"; echo eth1 > "$STATE/cut_ports"; touch "$PERSIST/cycling.eth1"
    escalate`);
  assert.doesNotMatch(r.stdout, /REBOOT/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/watchdog.test.js`
Expected: FAIL — `escalate`, `do_reboot`, `{{ESCALATE_CYCLES}}` unset.

- [ ] **Step 3: Add the variables**

After the `CYCLE_COOLDOWN=` line in the template variables block add:

```bash
ESCALATE_CYCLES={{ESCALATE_CYCLES}}   # re-cycles of managed ports before the reboot rung
ESCALATE_REBOOT={{ESCALATE_REBOOT}}   # 1 = reboot the router once per outage after the re-cycles
```

- [ ] **Step 4: Add the escalation function and reboot hook**

Before `mode_check()` add:

```bash
do_reboot() { reboot; }   # separated so tests can stub it

# Called each check while the uplink is still down AND PoE is already cut.
# Re-cycles managed ports on a cooldown, then reboots the router once.
escalate() {
    local now cd
    now=$(date +%s)
    cd=$(getn escalate_at)
    [ $(( now - cd )) -ge "$CYCLE_COOLDOWN" ] || return 0
    setn escalate_at "$now"

    if [ "$(getn outage_cycles)" -lt "$ESCALATE_CYCLES" ]; then
        incn outage_cycles
        log "escalation: re-cycling managed ports ($(getn outage_cycles)/$ESCALATE_CYCLES)"
        local p
        for p in $(managed_ports); do poe_cycle "$p"; log_event "$p" escalate-cycle "uplink still down" watchdog; done
        return 0
    fi

    # re-cycles exhausted
    if [ "$ESCALATE_REBOOT" = 1 ] && [ ! -f "$PERSIST/outage_rebooted" ]; then
        # never reboot mid manual cycle
        for f in "$PERSIST"/cycling.*; do [ -f "$f" ] && return 0; done
        log "UPLINK DOWN: escalation exhausted, rebooting router"
        log_event - reboot "escalation exhausted" watchdog
        touch "$PERSIST/outage_rebooted"
        do_reboot
    fi
}
```

- [ ] **Step 5: Call escalate from mode_check and clear state on recovery**

In `mode_check()`, uplink-down branch, after the `cut_all_poe` `if` block add:

```bash
        [ -f "$STATE/cut_ports" ] && escalate
```

In the uplink-up recovery branch, where `restore_all_poe` runs, after it clear the outage guards:

```bash
            setn outage_cycles 0
            rm -f "$PERSIST/outage_rebooted" "$STATE/escalate_at"
```

- [ ] **Step 6: Status line**

In `mode_status()`, after the whitelist line add:

```bash
    if [ -f "$STATE/cut_ports" ]; then
        echo "escalation      : $(getn outage_cycles)/$ESCALATE_CYCLES re-cycles, reboot $([ "$ESCALATE_REBOOT" = 1 ] && ([ -f "$PERSIST/outage_rebooted" ] && echo done || echo armed) || echo off)"
    fi
```

- [ ] **Step 7: Run the tests**

Run: `npm test`
Expected: `pass 38 / fail 0` (35 + 3 new).

- [ ] **Step 8: Commit**

```bash
git add templates/poe-watchdog.sh.tpl test/watchdog.test.js
git commit -m "Watchdog: uplink-loss escalation ladder (re-cycle then one router reboot)"
```

---

### Task 4: SSH layer — port table parser and port operations

**Files:**
- Modify: `lib/ssh.js`
- Modify: `server.js` (`renderScript` supplies the two new escalation vars; `config.example.json` and defaults)
- Modify: `config.example.json`
- Create: `test/ports-parse.test.js`

**Interfaces:**
- Produces: `PORT_RE = /^eth\d+$/`; `parsePorts(text) → [{ port, link, speed, poeCfg, poeLive, mac, rxBytes, txBytes, rxErr, txErr, flags: [], lastEvent: { at, action } | null }]`; `getPorts(cfg, creds, host)`; `getPortEvents(cfg, creds, host, port?)` → `[{ at, port, action, reason, source }]`; `setPoe(cfg, creds, host, port, mode)`; `cyclePort(cfg, creds, host, port)`. Numeric fields are Numbers; `lastEvent.at` is epoch ms.
- Consumes: `withConn`, `exec`, `REMOTE_PATH` (existing).

- [ ] **Step 1: Write the failing tests**

Create `test/ports-parse.test.js`:

```js
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
```

Add to `test/ssh-parse.test.js` a guard test:

```js
const { PORT_RE } = require('../lib/ssh');
test('PORT_RE rejects injection and accepts ethN', () => {
  assert.ok(PORT_RE.test('eth1'));
  assert.ok(!PORT_RE.test('eth1; reboot'));
  assert.ok(!PORT_RE.test('../etc'));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/ports-parse.test.js`
Expected: FAIL — `parsePorts is not a function`.

- [ ] **Step 3: Implement in `lib/ssh.js`**

Add the constant near `MAC_RE`:

```js
const PORT_RE = /^eth\d+$/;
```

Add the parser after `parseApmap`:

```js
// One tab-separated `ports` line per port -> normalised objects.
function parsePorts(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const c = raw.split('\t');
    if (c.length < 12 || !PORT_RE.test(c[0])) continue;
    const num = (v) => (v === '-' || v === '' ? null : Number(v));
    out.push({
      port: c[0],
      link: c[1] === 'up' ? 'up' : 'down',
      speed: num(c[2]),
      poeCfg: c[3],
      poeLive: c[4],
      mac: c[5] === '-' ? '' : c[5].toLowerCase(),
      rxBytes: Number(c[6]) || 0,
      txBytes: Number(c[7]) || 0,
      rxErr: Number(c[8]) || 0,
      txErr: Number(c[9]) || 0,
      flags: c[10] === '-' ? [] : c[10].split(','),
      lastEvent: c[11] === '-' ? null : { at: Number(c[11]) * 1000, action: c[12] || '' },
    });
  }
  return out;
}
```

Add the operations before `pooledMap`:

```js
async function getPorts(cfg, creds, host) {
  return withConn(cfg, creds, host, async (conn) => {
    const r = await exec(conn, `sudo ${REMOTE_PATH} ports 2>/dev/null`);
    return parsePorts(r.stdout);
  });
}

async function getPortEvents(cfg, creds, host, port) {
  if (port !== undefined && !PORT_RE.test(port)) throw new Error('invalid port');
  return withConn(cfg, creds, host, async (conn) => {
    const r = await exec(conn, `sudo ${REMOTE_PATH} port-events ${port || ''} 2>/dev/null`);
    // line: `epoch port action [reason words...] source`. reason may be empty
    // (4 fields), so require >= 4, not >= 5. port is ethN or '-' (reboot event).
    return String(r.stdout || '').split('\n').map((l) => l.trim().split(/\s+/))
      .filter((a) => a.length >= 4 && (PORT_RE.test(a[1]) || a[1] === '-'))
      .map((a) => ({ at: Number(a[0]) * 1000, port: a[1], action: a[2], reason: a.slice(3, -1).join(' '), source: a[a.length - 1] }));
  });
}

async function setPoe(cfg, creds, host, port, mode) {
  if (!PORT_RE.test(port)) throw new Error('invalid port');
  if (mode !== 'off' && mode !== '24v') throw new Error('invalid mode');
  return withConn(cfg, creds, host, async (conn) => {
    const r = await exec(conn, `sudo ${REMOTE_PATH} poe-set ${port} ${mode} 2>&1`);
    if (r.code !== 0) throw new Error(`poe-set on ${host}: ${(r.stdout || r.stderr || '').trim() || 'exit ' + r.code}`);
    return r.stdout.trim();
  });
}

async function cyclePort(cfg, creds, host, port) {
  if (!PORT_RE.test(port)) throw new Error('invalid port');
  return withConn(cfg, creds, host, async (conn) => {
    const r = await exec(conn, `sudo ${REMOTE_PATH} cycle-port ${port} 2>&1`);
    if (r.code !== 0) throw new Error(`cycle-port on ${host}: ${(r.stdout || r.stderr || '').trim() || 'exit ' + r.code}`);
    return r.stdout.trim();
  });
}
```

Update the export line to add `PORT_RE, parsePorts, getPorts, getPortEvents, setPoe, cyclePort`.

- [ ] **Step 4: Render the escalation vars and update the example config**

In `server.js` `renderScript()`, after the `ALLOWED_MACS` line the vars object already spreads `cfg.defaults`/overrides, so `ESCALATE_CYCLES`/`ESCALATE_REBOOT` flow through automatically **once they exist in `cfg.defaults`**. Add them to `config.example.json` `defaults`:

```json
    "ESCALATE_CYCLES": 3,
    "ESCALATE_REBOOT": 1,
```

and after the startup `delete cfg.defaults.AP_CYCLE_CRON;` line add defaults so old configs render them:

```js
if (cfg.defaults.ESCALATE_CYCLES === undefined) cfg.defaults.ESCALATE_CYCLES = 3;
if (cfg.defaults.ESCALATE_REBOOT === undefined) cfg.defaults.ESCALATE_REBOOT = 1;
```

- [ ] **Step 5: Run tests and syntax check**

Run: `npm test && node --check server.js && node --check lib/ssh.js`
Expected: `pass 41 / fail 0` (38 + 2 ports-parse + 1 PORT_RE; watchdog count unchanged). No syntax errors.

- [ ] **Step 6: Commit**

```bash
git add lib/ssh.js server.js config.example.json test/ports-parse.test.js test/ssh-parse.test.js
git commit -m "SSH: parsePorts + getPorts/getPortEvents/setPoe/cyclePort with PORT_RE guard; render escalation vars"
```

---

### Task 5: Port poller — one-at-a-time SSH read scheduler

**Files:**
- Create: `lib/portpoller.js`
- Create: `test/portpoller.test.js`

**Interfaces:**
- Produces:
  - `emptyQueue() → { pending: [], last: {} }` (`last[key]` = epoch ms of the last successful read)
  - `enqueue(state, key, priority) → boolean` (true if added/upgraded; `live` goes to the front and upgrades a queued `background`; duplicates ignored)
  - `dueForBackground(state, keys, now, backgroundMs) → [key]` (keys whose `last` is older than `backgroundMs` or never read, not already pending)
  - `nextJob(state) → { key, priority } | null` (shift the front)
  - `recordRead(state, key, now)` (set `last[key]`)
  - `rate(prevSample, curSample, field) → number | null` (bytes/sec between two `{ at, ports }` samples when < 5 min apart, else null)
- Consumes: nothing (pure). The driver in `server.js` (Task 6) owns SSH and the flag that pauses polling during fleet Check/Deploy.

- [ ] **Step 1: Write the failing tests**

Create `test/portpoller.test.js`:

```js
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
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/portpoller.test.js`
Expected: FAIL — `Cannot find module '../lib/portpoller'`.

- [ ] **Step 3: Implement `lib/portpoller.js`**

```js
'use strict';
// Pure scheduling for per-switch SSH port reads. No I/O: server.js owns the
// worker, the clock, and the SSH calls. Guarantees at most one read in flight
// (the worker pulls one job at a time) and lets an open device page jump ahead
// of the 30-minute background sweep.

const RATE_WINDOW_MS = 5 * 60 * 1000;

function emptyQueue() {
  return { pending: [], last: {} };
}

// Add a job, or upgrade a queued background job to live. Returns whether the
// queue changed. `live` jobs sit at the front (most-recent live first).
function enqueue(state, key, priority = 'background') {
  const existing = state.pending.find((j) => j.key === key);
  if (existing) {
    if (priority === 'live' && existing.priority !== 'live') {
      state.pending = state.pending.filter((j) => j.key !== key);
      state.pending.unshift({ key, priority: 'live' });
      return true;
    }
    return false;
  }
  if (priority === 'live') state.pending.unshift({ key, priority: 'live' });
  else state.pending.push({ key, priority: 'background' });
  return true;
}

function dueForBackground(state, keys, now, backgroundMs) {
  const pending = new Set(state.pending.map((j) => j.key));
  return keys.filter((k) => !pending.has(k) && (state.last[k] === undefined || now - state.last[k] >= backgroundMs));
}

function nextJob(state) {
  return state.pending.shift() || null;
}

function recordRead(state, key, now) {
  state.last[key] = now;
}

function rate(prev, cur, port, field) {
  if (!prev || !cur) return null;
  const dt = cur.at - prev.at;
  if (dt <= 0 || dt > RATE_WINDOW_MS) return null;
  const a = (prev.ports.find((p) => p.port === port) || {})[field];
  const b = (cur.ports.find((p) => p.port === port) || {})[field];
  if (a == null || b == null || b < a) return null;   // counter reset → null
  return Math.round(((b - a) / dt) * 1000);
}

module.exports = { emptyQueue, enqueue, dueForBackground, nextJob, recordRead, rate };
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: `pass 45 / fail 0` (41 + 4).

- [ ] **Step 5: Commit**

```bash
git add lib/portpoller.js test/portpoller.test.js
git commit -m "Port poller: pure one-at-a-time SSH read scheduler with rate math"
```

---

### Task 6: Server — port routes, enrichment, poller driver, settings

**Files:**
- Modify: `server.js`

**Interfaces:**
- Consumes: `ssh.getPorts/getPortEvents/setPoe/cyclePort/haveAuth`, `portpoller`, `state.aps`, `state.protectedMacs`.
- Produces routes:
  - `GET /api/devices/:key/ports` → `{ ports, portsAt, portsError, stale }`; `?live=1` runs a queued read first (waits ≤ 20 s)
  - `GET /api/devices/:key/ports/:port/events` → `{ events }`
  - `POST /api/devices/:key/ports/:port/poe` `{ mode }` → `{ ok, result }` (400 uplink/bad mode, 409 no snapshot, 428 no auth)
  - `POST /api/devices/:key/ports/:port/cycle` → `{ ok, result }` (400 uplink/protected, 409 no snapshot, 428 no auth)
  - `PUT /api/devices/:key/ports/:port/exclude` `{ excluded }` → `{ ok, excluded, overrides }` (400 uplink)
  - `GET /api/devices` rows gain `portsSummary`
  - `GET/PUT /api/settings` gain `ports: { backgroundMinutes, liveSeconds }`
- State: `state.portsPoll` (poller queue, not persisted — rebuilt empty on load); `dev.ports`, `dev.portsAt`, `dev.portsError`, per-port `rateRx`/`rateTx` computed on store.

- [ ] **Step 1: Requires, config defaults, enrichment, driver**

Near the other requires: `const portpoller = require('./lib/portpoller');`

After the state-load block add:

```js
cfg.portal.ports = { backgroundMinutes: 30, liveSeconds: 15, ...(cfg.portal.ports || {}) };
const portsPoll = portpoller.emptyQueue();
const portSamples = {};          // key -> { at, ports } previous sample, for rates
let fleetBusy = false;           // set true during fleetRun so polling pauses
```

Add enrichment + read helper before `// --- express`:

```js
// Attach UniFi-AP / backhaul-radio identity and traffic rates to a fresh read.
function enrichPorts(dev, ports, now) {
  const prev = portSamples[dev.key];
  const sample = { at: now, ports };
  for (const p of ports) {
    if (p.mac && state.aps[p.mac]) {
      const a = state.aps[p.mac];
      p.ap = { id: a.id, name: a.name, model: a.model, online: a.online, firmware: a.firmware };
    } else if (p.mac && (state.protectedMacs || []).includes(p.mac)) {
      p.radio = true;
    }
    p.rateRx = portpoller.rate(prev, sample, p.port, 'rxBytes');
    p.rateTx = portpoller.rate(prev, sample, p.port, 'txBytes');
  }
  portSamples[dev.key] = sample;
  return ports;
}

async function readPorts(dev) {
  const now = Date.now();
  try {
    const ports = await ssh.getPorts(cfg, sshCreds, dev.ip);
    dev.ports = enrichPorts(dev, ports, now);
    dev.portsAt = new Date(now).toISOString();
    dev.portsError = null;
  } catch (e) {
    dev.portsError = e.message;
  } finally {
    portpoller.recordRead(portsPoll, dev.key, now);
  }
  saveState();
  return dev.ports;
}

let portWorkerRunning = false;
async function portWorkerTick() {
  if (portWorkerRunning) return;
  if (fleetBusy || !ssh.haveAuth(cfg, sshCreds)) return;
  const job = portpoller.nextJob(portsPoll);
  if (!job) {
    const mins = Number(cfg.portal.ports.backgroundMinutes || 0);
    if (mins > 0) {
      const due = portpoller.dueForBackground(portsPoll, Object.keys(state.devices), Date.now(), mins * 60000);
      if (due[0]) portpoller.enqueue(portsPoll, due[0], 'background');
    }
    return;
  }
  portWorkerRunning = true;
  try {
    const dev = state.devices[job.key];
    if (dev) await readPorts(dev);
  } finally {
    portWorkerRunning = false;
  }
}

// Queue a live read and wait (bounded) for it to land.
async function liveRead(dev, timeoutMs = 20000) {
  portpoller.enqueue(portsPoll, dev.key, 'live');
  const started = Date.now();
  const before = dev.portsAt;
  while (Date.now() - started < timeoutMs) {
    await portWorkerTick();
    if (dev.portsAt !== before || dev.portsError) return;
    await new Promise((r) => setTimeout(r, 500));
  }
}

const portsSummary = (dev) => (dev.ports || []).map((p) => ({ port: p.port, link: p.link, poeLive: p.poeLive, flags: p.flags }));
const uplinkPort = (dev) => ((dev.ports || []).find((p) => (p.flags || []).includes('uplink')) || {}).port;
```

- [ ] **Step 2: Routes**

After the AP routes add:

```js
// --- device ports --------------------------------------------------------------
app.get('/api/devices/:key/ports', async (req, res) => {
  const dev = state.devices[req.params.key];
  if (!dev) return res.status(404).json({ error: 'unknown device' });
  if (req.query.live === '1') {
    if (!ssh.haveAuth(cfg, sshCreds)) return res.status(428).json({ error: 'SSH credentials not set' });
    await liveRead(dev);
  }
  const mins = Number(cfg.portal.ports.backgroundMinutes || 0);
  const stale = mins > 0 && dev.portsAt && Date.now() - new Date(dev.portsAt) > 2 * mins * 60000;
  res.json({ ports: dev.ports || [], portsAt: dev.portsAt || null, portsError: dev.portsError || null, stale: !!stale });
});

app.get('/api/devices/:key/ports/:port/events', async (req, res) => {
  const dev = state.devices[req.params.key];
  if (!dev) return res.status(404).json({ error: 'unknown device' });
  if (!ssh.haveAuth(cfg, sshCreds)) return res.status(428).json({ error: 'SSH credentials not set' });
  if (!ssh.PORT_RE.test(req.params.port)) return res.status(400).json({ error: 'invalid port' });
  try { res.json({ events: await ssh.getPortEvents(cfg, sshCreds, dev.ip, req.params.port) }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

app.post('/api/devices/:key/ports/:port/poe', async (req, res) => {
  const dev = state.devices[req.params.key];
  if (!dev) return res.status(404).json({ error: 'unknown device' });
  if (!ssh.haveAuth(cfg, sshCreds)) return res.status(428).json({ error: 'SSH credentials not set' });
  const port = req.params.port;
  const mode = (req.body || {}).mode;
  if (!ssh.PORT_RE.test(port) || (mode !== 'off' && mode !== '24v')) return res.status(400).json({ error: 'bad port or mode' });
  if (!dev.ports) return res.status(409).json({ error: 'no port snapshot yet; refresh first' });
  if (port === uplinkPort(dev)) return res.status(400).json({ error: 'refusing the uplink port' });
  try {
    const result = await ssh.setPoe(cfg, sshCreds, dev.ip, port, mode);
    await liveRead(dev);
    log.info('manual PoE set', { device: dev.name, port, mode });
    res.json({ ok: true, result });
  } catch (e) { res.status(422).json({ ok: false, error: e.message }); }
});

app.post('/api/devices/:key/ports/:port/cycle', async (req, res) => {
  const dev = state.devices[req.params.key];
  if (!dev) return res.status(404).json({ error: 'unknown device' });
  if (!ssh.haveAuth(cfg, sshCreds)) return res.status(428).json({ error: 'SSH credentials not set' });
  const port = req.params.port;
  if (!ssh.PORT_RE.test(port)) return res.status(400).json({ error: 'invalid port' });
  if (!dev.ports) return res.status(409).json({ error: 'no port snapshot yet; refresh first' });
  const p = dev.ports.find((x) => x.port === port) || {};
  if (port === uplinkPort(dev) || (p.flags || []).includes('protected')) return res.status(400).json({ error: 'refusing uplink/protected port' });
  try {
    const result = await ssh.cyclePort(cfg, sshCreds, dev.ip, port);
    await liveRead(dev);
    log.info('manual PoE cycle', { device: dev.name, port });
    res.json({ ok: true, result });
  } catch (e) { res.status(422).json({ ok: false, error: e.message }); }
});

app.put('/api/devices/:key/ports/:port/exclude', (req, res) => {
  const dev = state.devices[req.params.key];
  if (!dev) return res.status(404).json({ error: 'unknown device' });
  const port = req.params.port;
  if (!ssh.PORT_RE.test(port)) return res.status(400).json({ error: 'invalid port' });
  if (port === uplinkPort(dev)) return res.status(400).json({ error: 'refusing the uplink port' });
  dev.overrides = dev.overrides || {};
  const set = new Set(String(dev.overrides.EXCLUDE_PORTS || cfg.defaults.EXCLUDE_PORTS || '').split(/\s+/).filter(Boolean));
  const excluded = !!(req.body || {}).excluded;
  if (excluded) set.add(port); else set.delete(port);
  dev.overrides.EXCLUDE_PORTS = [...set].join(' ');
  if (dev.lastCheck) dev.lastCheck.inSync = false;    // drift until deployed
  saveState();
  log.info('port exclude updated', { device: dev.name, port, excluded });
  res.json({ ok: true, excluded, overrides: dev.overrides });
});
```

- [ ] **Step 3: Rows, settings, worker start**

In the `GET /api/devices` handler, add `portsSummary: portsSummary(d)` to each row object.

In `GET /api/settings` response add `ports: cfg.portal.ports`. In `PUT /api/settings`, destructure `ports: portsIn`, and in the validate-first block add:

```js
  if (portsIn && typeof portsIn === 'object') {
    const bg = Math.max(0, Math.min(1440, parseInt(portsIn.backgroundMinutes, 10) || 0));
    const live = Math.max(5, Math.min(120, parseInt(portsIn.liveSeconds, 10) || 15));
    cfg.portal.ports = { backgroundMinutes: bg, liveSeconds: live };
    disk.portal = { ...(disk.portal || {}), ports: cfg.portal.ports };
  }
```

In `fleetRun`, set `fleetBusy = true;` at the start and `fleetBusy = false;` in a `finally`.

In the `app.listen` callback add: `setInterval(portWorkerTick, 5000);`

- [ ] **Step 4: Verify (read-only against the real controller)**

```bash
node --check server.js && npm test
node server.js & sleep 2
curl -s "http://127.0.0.1:8090/api/settings" | python3 -c "import sys,json;print('ports',json.load(sys.stdin)['ports'])"
# device key from seed:
KEY=$(python3 -c "import json;print(list(json.load(open('state/seed.json'))['devices'])[0])")
curl -s "http://127.0.0.1:8090/api/devices/$KEY/ports" | python3 -c "import sys,json;d=json.load(sys.stdin);print('ports',len(d['ports']),'err',d['portsError'])"
kill %1
cp state/seed.json state/devices.json
```

Expected: `ports {'backgroundMinutes': 30, 'liveSeconds': 15}`; the ports call returns `ports 0 err None` for a seed device with no real switch (no live read requested), or an error string if `?live=1` — do not pass `live`. **Do not POST to poe/cycle.** Restore state.

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "Server: device port routes, UniFi/radio enrichment, one-at-a-time poller, ports settings"
```

---

### Task 7: UI — device page, port strip, settings ports card, list mini-strip

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/app.css`

**Interfaces:**
- Consumes: `GET /api/devices/:key/ports`, `.../events`, `POST .../poe`, `.../cycle`, `PUT .../exclude`, `POST /api/aps/:mac/reboot`, extended `/api/settings`; helpers `$`,`$$`,`icon`,`esc`,`fmtTime`,`api`,`toast`,`dlg`,`busy`,`fieldHtml`, router `VIEWS`/`route()`, `rowHtml`, `openOverrides`, `showStatus`.
- Produces: view `#/devices/<key>` via a `device` route; `renderDevicePage(key)`, `renderPortStrip`, `selectPort`; Settings ids `#portsBg #portsLive`.

- [ ] **Step 1: Router — support `#/devices/<key>`**

In `public/app.js`, change `currentView()` so a device key after `devices/` still resolves to the `devices` view but is captured:

```js
function routeParam() {
  const m = location.hash.match(/^#\/devices\/([^/?]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
```

In `route()`, after computing `name`, branch: if `name === 'devices'` and `routeParam()` is set, call `renderDevicePage(routeParam())` and show `#view-device` instead of `#view-devices`. Add `#view-device` to the `$$('.view')` hide loop set. Manage a `DEVPAGE_TIMER` like `APS_TIMER`: clear it on every route; when on a device page, `DEVPAGE_TIMER = setInterval(() => refreshDevicePage(), (settingsLiveSeconds||15)*1000)`.

- [ ] **Step 2: Markup**

In `public/index.html`, after the Devices `</section>` add a device-page section (structure only; rows are rendered by JS):

```html
    <section id="view-device" class="view" hidden>
      <a href="#/devices" class="small d-inline-block mb-2">&larr; All devices</a>
      <div id="devHeader" class="mb-3"></div>
      <div class="card mb-3"><div class="card-body">
        <div class="small text-uppercase text-body-secondary mb-2">Ports</div>
        <div id="portStrip" class="d-flex flex-wrap gap-2"></div>
        <div class="small text-body-secondary mt-2" id="portStripMeta"></div>
      </div></div>
      <div id="portDetail" class="mb-3"></div>
      <div class="row g-3">
        <div class="col-lg-6"><div class="card"><div class="card-header fw-semibold">Overrides</div>
          <div class="card-body" id="devOverrides"></div></div></div>
        <div class="col-lg-6"><div class="card"><div class="card-header d-flex justify-content-between">
          <span class="fw-semibold">Watchdog status</span><button class="btn btn-sm btn-outline-secondary" id="devWdRefresh" type="button">Refresh</button></div>
          <div class="card-body"><pre class="small mb-0" id="devWdStatus" style="white-space:pre-wrap"></pre></div></div></div>
      </div>
    </section>
```

In the Settings section, inside the existing card column, add a Ports card before `#settingsSaved`:

```html
          <div class="card mb-4">
            <div class="card-header fw-semibold">Ports</div>
            <div class="card-body">
              <label class="form-label small" for="portsBg">Background poll (minutes, 0 = off)</label>
              <input class="form-control form-control-sm mono mb-3" id="portsBg" inputmode="numeric" autocomplete="off">
              <label class="form-label small" for="portsLive">Live refresh on device page (seconds)</label>
              <input class="form-control form-control-sm mono" id="portsLive" inputmode="numeric" autocomplete="off">
            </div>
          </div>
```

- [ ] **Step 3: CSS**

Append to `public/app.css`:

```css
.port-sq { width:44px;height:44px;border-radius:6px;border:2px solid transparent;display:flex;align-items:center;justify-content:center;font-size:.72rem;font-weight:600;cursor:pointer;position:relative;background:var(--cui-tertiary-bg) }
.port-sq.link-1000 { background:#d1e7dd } .port-sq.link-slow { background:#fff3cd } .port-sq.link-down { background:var(--cui-secondary-bg);color:var(--cui-secondary-color) }
.port-sq.nopoe { background-image:repeating-linear-gradient(45deg,transparent,transparent 4px,rgba(0,0,0,.06) 4px,rgba(0,0,0,.06) 8px) }
.port-sq.cut { border-color:var(--cui-danger) } .port-sq.sel { outline:3px solid var(--cui-primary);outline-offset:1px }
.port-sq .glyph { position:absolute;bottom:1px;right:2px;font-size:.6rem }
```

- [ ] **Step 4: Device page JS**

Add before `// --- header:` (uses existing `DEVICES` list cache — confirm `loadDevices` stores devices in a module variable; if not, fetch `/api/devices` in `renderDevicePage`). Full section:

```js
let DEVPAGE_TIMER = null;
let DEVPAGE = { key: null, ports: [], sel: null };

async function renderDevicePage(key) {
  DEVPAGE.key = key;
  const list = await api('GET', '/api/devices');
  const dev = (list.devices ? Object.values(list.devices) : list).find((d) => d.key === key);
  if (!dev) { location.hash = '#/devices'; return; }
  DEVPAGE.dev = dev;
  $('#devHeader').innerHTML = `<h2 class="h4 mb-0">${esc(dev.name)}</h2>
    <div class="small text-body-secondary">${esc(dev.site || '')} · ${esc(dev.ip)} · ${esc(dev.model || '')}</div>`;
  $('#devOverrides').innerHTML = overridesFormHtml(dev);      // reuse the fields from openOverrides
  wireOverridesForm(dev);
  await refreshDevicePage();
  loadDevWatchdog(dev);
}

async function refreshDevicePage() {
  if (!DEVPAGE.key) return;
  const r = await api('GET', `/api/devices/${DEVPAGE.key}/ports?live=1`).catch((e) => ({ ports: [], portsError: e.message }));
  DEVPAGE.ports = r.ports || [];
  $('#portStripMeta').textContent = r.portsError ? 'stale — ' + r.portsError
    : r.portsAt ? 'updated ' + fmtTime(r.portsAt) : 'no data yet';
  renderPortStrip();
  if (DEVPAGE.sel) renderPortDetail(DEVPAGE.sel);
}

function renderPortStrip() {
  $('#portStrip').innerHTML = DEVPAGE.ports.map((p) => {
    const link = p.link !== 'up' ? 'link-down' : p.speed >= 1000 ? 'link-1000' : 'link-slow';
    const cls = ['port-sq', link, p.poeCfg === 'none' ? 'nopoe' : '', (p.flags || []).includes('cut') ? 'cut' : '', DEVPAGE.sel === p.port ? 'sel' : ''].join(' ');
    const glyph = (p.flags || []).includes('manual-off') ? '⌀' : p.poeLive === 'on' ? '⚡' : (p.flags || []).includes('uplink') || (p.flags || []).includes('protected') ? '🛡' : '';
    return `<div class="${cls}" data-port="${esc(p.port)}" title="${esc(portSummary(p))}">${esc(p.port.replace('eth', ''))}<span class="glyph">${glyph}</span></div>`;
  }).join('');
}

function portSummary(p) {
  return `${p.port} ${p.link}${p.speed ? ' ' + p.speed : ''} poe:${p.poeCfg}/${p.poeLive} ${p.mac || 'no mac'} [${(p.flags || []).join(',') || '-'}]`;
}

$('#portStrip').addEventListener('click', (ev) => {
  const sq = ev.target.closest('[data-port]');
  if (!sq) return;
  DEVPAGE.sel = sq.dataset.port;
  renderPortStrip();
  renderPortDetail(DEVPAGE.sel);
});

function renderPortDetail(port) {
  const p = DEVPAGE.ports.find((x) => x.port === port);
  if (!p) { $('#portDetail').innerHTML = ''; return; }
  const isUplink = (p.flags || []).includes('uplink');
  const isProt = (p.flags || []).includes('protected');
  const excluded = (p.flags || []).includes('excluded');
  const who = p.ap ? `<span class="badge text-bg-${p.ap.online ? 'success' : 'danger'}">AP ${esc(p.ap.name)}</span> ${esc(p.ap.model)} · fw ${esc(p.ap.firmware || '?')}`
    : p.radio ? '<span class="badge text-bg-secondary">UISP backhaul radio</span>'
    : p.mac ? 'unknown device ' + esc(p.mac) : 'nothing learned';
  const rate = (b) => b == null ? '—' : b > 1e6 ? (b / 1e6).toFixed(1) + ' MB/s' : b > 1e3 ? (b / 1e3).toFixed(1) + ' kB/s' : b + ' B/s';
  $('#portDetail').innerHTML = `<div class="card"><div class="card-body">
    <div class="d-flex flex-wrap gap-3 mb-2">
      <div><div class="small text-body-secondary">Link</div>${esc(p.link)}${p.speed ? ' · ' + p.speed + ' Mbps' : ''}</div>
      <div><div class="small text-body-secondary">PoE</div>${esc(p.poeCfg)} / ${esc(p.poeLive)}</div>
      <div><div class="small text-body-secondary">MAC</div><span class="mono">${esc(p.mac || '—')}</span></div>
      <div><div class="small text-body-secondary">RX / TX</div>${rate(p.rateRx)} / ${rate(p.rateTx)}</div>
      <div><div class="small text-body-secondary">Errors</div>${p.rxErr} / ${p.txErr}</div>
    </div>
    <div class="mb-2">${who}</div>
    <div class="mb-3">${(p.flags || []).map((f) => `<span class="badge text-bg-light border me-1">${esc(f)}</span>`).join('') || '<span class="text-body-secondary">no flags</span>'}</div>
    <div class="d-flex flex-wrap gap-2">
      ${isUplink || isProt ? `<span class="small text-body-secondary">${isUplink ? 'Uplink' : 'Protected'} port — actions disabled</span>` : `
      <div class="form-check form-switch"><input class="form-check-input" type="checkbox" id="pExclude" ${excluded ? 'checked' : ''}><label class="form-check-label small" for="pExclude">Exclude from watchdog</label></div>
      <button class="btn btn-sm btn-outline-primary" id="pCycle" ${p.poeCfg !== '24v' ? 'disabled' : ''}>Cycle now</button>
      <button class="btn btn-sm btn-outline-secondary" id="pPoe">${(p.flags || []).includes('manual-off') ? 'PoE on' : 'PoE off'}</button>
      ${p.ap && p.ap.online ? `<button class="btn btn-sm btn-outline-primary" id="pReboot">Reboot AP</button>` : ''}`}
    </div>
    <div id="portEvents" class="small mt-3"></div>
  </div></div>`;
  wirePortActions(p);
  loadPortEvents(port);
}
```

- [ ] **Step 5: Port actions**

```js
function wirePortActions(p) {
  const ex = $('#pExclude');
  if (ex) ex.onchange = async () => {
    try { await api('PUT', `/api/devices/${DEVPAGE.key}/ports/${p.port}/exclude`, { excluded: ex.checked });
      toast(ex.checked ? 'Excluded — deploy to apply' : 'Included — deploy to apply'); }
    catch (e) { toast(e.message, { variant: 'danger', ms: 6000 }); }
    refreshDevicePage();
  };
  const cyc = $('#pCycle');
  if (cyc) cyc.onclick = () => confirmPortAction(p, 'cycle', `PoE-cycle ${p.port}?`,
    `This powers ${whatsOn(p)} off and back on. It will drop for a few minutes.`);
  const poe = $('#pPoe');
  if (poe) { const off = !(p.flags || []).includes('manual-off');
    poe.onclick = () => confirmPortAction(p, 'poe', `${off ? 'Cut' : 'Restore'} PoE on ${p.port}?`,
      `${off ? 'Powers off' : 'Powers on'} ${whatsOn(p)}. This persists across reboots until changed.`, { mode: off ? 'off' : '24v' }); }
  const rb = $('#pReboot');
  if (rb && p.ap) rb.onclick = () => confirmApReboot(p.ap);   // reuse the AP-page confirm
}

function whatsOn(p) { return p.ap ? `AP ${p.ap.name}` : p.mac ? `device ${p.mac}` : `port ${p.port}`; }

function confirmPortAction(p, kind, title, body, extra) {
  dlg.open(title, `<p>${esc(body)}</p><div class="text-end">
    <button class="btn btn-outline-secondary me-2" data-coreui-dismiss="modal">Cancel</button>
    <button class="btn btn-primary" id="paGo">Confirm</button></div>`, { size: '' });
  $('#paGo').onclick = async (ev) => {
    busy(ev.currentTarget, true);
    try {
      const url = kind === 'cycle' ? `/api/devices/${DEVPAGE.key}/ports/${p.port}/cycle` : `/api/devices/${DEVPAGE.key}/ports/${p.port}/poe`;
      const r = await api('POST', url, extra);
      dlg.close(); toast(`${p.port}: ${r.result || 'done'}`, { variant: 'success' });
    } catch (e) { toast(`${p.port}: ${e.message}`, { variant: 'danger', ms: 8000 }); }
    busy(ev.currentTarget, false);
    refreshDevicePage();
  };
}

async function loadPortEvents(port) {
  try {
    const r = await api('GET', `/api/devices/${DEVPAGE.key}/ports/${port}/events`);
    const ev = (r.events || []).slice(-50).reverse();
    $('#portEvents').innerHTML = ev.length ? '<div class="text-body-secondary mb-1">Recent events</div>' + ev.map((e) =>
      `${esc(fmtTime(new Date(e.at).toISOString()))} — <strong>${esc(e.action)}</strong> ${esc(e.reason || '')} <span class="text-body-secondary">(${esc(e.source)})</span>`).join('<br>') : '';
  } catch { $('#portEvents').innerHTML = ''; }
}

async function loadDevWatchdog(dev) {
  $('#devWdStatus').textContent = 'loading…';
  try { const r = await api('GET', `/api/devices/${dev.key}/watchdog`); $('#devWdStatus').textContent = r.status + '\n\n' + (r.logs || ''); }
  catch (e) { $('#devWdStatus').textContent = e.message; }
  $('#devWdRefresh').onclick = () => loadDevWatchdog(dev);
}
```

Extract the overrides form markup used by the old modal into `overridesFormHtml(dev)` and `wireOverridesForm(dev)` so both the (removed) modal and the page can use it; make `openOverrides` and the device page call the shared helpers. Add the two new fields `ESCALATE_CYCLES` and `ESCALATE_REBOOT` to that form.

- [ ] **Step 6: Row navigation, settings, remove old modals**

In `rowHtml(d)`, make the device name a link to `#/devices/${encodeURIComponent(d.key)}` and append a mini strip: `(d.portsSummary||[]).map(...)` small squares. In `act()`, change the `status` and `overrides` dropdown actions to `location.hash = '#/devices/' + encodeURIComponent(d.key)`. Delete `showStatus` and the `openOverrides` modal wrapper (keep the shared form helpers). Remove the now-unused status modal markup from `index.html` if present.

In `loadSettings()`, after the unifi fields add `$('#portsBg').value = (s.ports||{}).backgroundMinutes ?? 30; $('#portsLive').value = (s.ports||{}).liveSeconds ?? 15;`. In the settings submit body add `ports: { backgroundMinutes: $('#portsBg').value.trim(), liveSeconds: $('#portsLive').value.trim() }`. Store `liveSeconds` in a module var the device timer reads.

- [ ] **Step 7: Verify in the browser**

Start the server (real controller). Because the seed devices are not reachable, port reads error — that is fine for layout; use the Pi only in Task 8. Confirm at `http://127.0.0.1:8090/#/devices`:
- A device name links to `#/devices/<key>`; the device page renders header, an (empty or error) port strip, Overrides and Watchdog cards.
- Settings shows the Ports card; changing Background poll to `0` and saving returns ok; a non-numeric live value clamps.
- Console has no errors; no external requests.
Restore `state/devices.json` from seed afterwards.

- [ ] **Step 8: Commit**

```bash
git add public/index.html public/app.js public/app.css
git commit -m "UI: device page with port strip, per-port detail/actions/history, ports settings; retire status/overrides modals"
```

---

### Task 8: Integration check on the Pi (one spare port, one switch)

This task is verification only and needs the branch released and the Pi updated (the user does the release and install). It also needs the user to name one switch and one **spare** 24V PoE port on it that is safe to power-cycle and toggle, plus confirmation to Check/Deploy that switch. If any input is missing, do the parts that are safe and report exactly what was skipped.

- [ ] **Step 1: Ask the user** for the switch, the spare port, and permission. Record the answer.

- [ ] **Step 2: Deploy + strict-whitelist sanity.** Deploy the named switch. Open its device page: the port strip renders all ports; the uplink shows a shield and disabled actions; a port carrying a UniFi AP shows the AP badge; the SFP shows `sfp`. `status` (watchdog card) shows the whitelist line and, during no outage, no escalation line.

- [ ] **Step 3: Manual PoE on the spare port** (only with permission). Cycle the spare port: confirm dialog names what is on it; toast shows `cycled ethN`; the event history gains a `cycle (portal)` row. Then PoE off the spare port: the square shows the manual-off glyph, `status` lists it as manual-off, and `managed_ports` no longer includes it (visible as the `managed` flag disappearing). Then PoE on: the marker clears. Verify each with a fresh refresh.

- [ ] **Step 4: Exclude round-trip.** Toggle Exclude on a non-uplink port: the device row/badge shows drift; Deploy; the drift clears and the port shows the `excluded` flag.

- [ ] **Step 5: Report** the observed results, including anything skipped and why. Do NOT test the escalation reboot against real hardware; note that it is covered by unit tests only.

---

## Self-review notes

- **Spec coverage:** ports/port-events modes (T1), manual poe-set/cycle-port + event logging (T2), escalation ladder incl. once-per-outage reboot guard in `$PERSIST` (T3), SSH parser+ops with PORT_RE guard (T4), one-at-a-time poller + rate math (T5), routes/enrichment/settings/worker (T6), device page + strip + actions + history + list mini-strip + retire modals (T7), live check (T8). Safety invariants: uplink/protected refusal at UI+server+script (T2/T6/T7), empty whitelist manages nothing (T1), manual-off invisible to watchdog + boot_heal (T1/T2 — **boot_heal skip is specified in the spec; add it in T2 Step 4** alongside the event logging: in `boot_heal`, before re-enabling a port, `[ -f "$PERSIST/manual-off/$p" ] && continue`), `;`-not-`&&` config idiom reused in `poe_save` (T2).
- **Type consistency:** port object shape `{ port, link, speed, poeCfg, poeLive, mac, rxBytes, txBytes, rxErr, txErr, flags[], lastEvent, ap?, radio?, rateRx, rateTx }` is produced by `parsePorts` (T4), enriched in `server.js` (T6), and read by the UI (T7). `ports` line column order in the template (T1) matches `parsePorts` indices (T4) exactly: port,link,speed,poeCfg,poeLive,mac,rx,tx,rxErr,txErr,flags,lastEpoch,lastAction. Poller job shape `{ key, priority }` (T5) used by the driver (T6).
- **Boot-heal manual-off:** folded into T2 Step 4 (see above) so the manual-off invariant holds end to end.
