# Device port view, manual PoE control, and uplink-loss escalation

Date: 2026-09-03
Status: approved design, awaiting implementation plan
Depends on: UniFi AP pane and whitelist (`2026-09-01-unifi-ap-reboot-whitelist-design.md`), shipped in v1.2.0.

## Goal

1. Replace the per-device "watchdog status" modal and the "Overrides" dialog with a full device page at `#/devices/<key>` that shows every ER-X port UISP-style, lets the user click a port to see what is on it, its traffic, its watchdog flags and history, and act on it.
2. Give the portal safe manual control of PoE per port: exclude/include from the watchdog, cycle now, persistent off/on, and reboot the UniFi AP behind the port.
3. Make the watchdog strictly UniFi-driven: with an empty whitelist it manages nothing. Remove the legacy Ubiquiti-OUI fallback.
4. Escalate while an uplink stays down: repeated PoE re-cycles of managed ports, then one router reboot, then continued re-cycles. Never leave a locked-up ER-X waiting for a human.
5. Poll port data with minimal SSH load: live while a device page is open, in the background every 30 minutes otherwise, never two switches at once.

## Non-goals

- No writes to UISP or UniFi beyond the existing AP restart.
- No per-port bandwidth graphs; two-sample rates and raw counters only.
- No changes to how the uplink is detected (gateway MAC in the MAC table).
- No multi-switch topology reasoning beyond the rule that a switch only ever reboots itself.

## Safety invariants (must hold after every task)

- **PoE always returns on power cycle.** The watchdog cuts and restores PoE with `commit` only, never `save`, and deploy refuses to `save` while any port is cut. A manually-off port is the only PoE-off state that is saved to `config.boot`.
- **The uplink port is never cut, cycled, excluded, or switched off**, enforced in the UI (disabled controls), the server (400), and the script (exit 3).
- **Protected ports (UISP backhaul radios) are never cut or cycled** by the watchdog. Manual cycle of a protected port is refused too.
- **Empty whitelist manages nothing.** No OUI fallback.
- **Manual-off ports are invisible to the watchdog**: not managed, not cut, not restored, not healed at boot, not re-cycled by escalation. Only a manual "on" clears the marker.
- **A switch only reboots itself**, and at most once per outage.
- **No two SSH sessions to the fleet at once from the poller**, and every remote argument is validated by regex before interpolation (`^eth\d+$`, MAC regex, `off|24v`).

## On-switch script (`templates/poe-watchdog.sh.tpl`)

### New template variables

| Variable | Default | Meaning |
|---|---|---|
| `ESCALATE_CYCLES` | 3 | re-cycles of managed ports while the uplink stays down before the reboot rung |
| `ESCALATE_REBOOT` | 1 | 1 = reboot the router once per outage after `ESCALATE_CYCLES` failed re-cycles; 0 = never |

Both live in `config.defaults` and are overridable per device like the others.

### New persistent files under `$PERSIST`

- `manual-off/ethN` — marker: PoE on this port was switched off deliberately from the portal.
- `port-events` — `epoch port action reason source` lines, newest last, trimmed to the last 200. Actions: `cut`, `restore`, `cycle`, `manual-off`, `manual-on`, `escalate-cycle`, `reboot`. Source: `watchdog` or `portal`.

### New state files under `$STATE` (tmpfs, cleared on reboot)

- `outage_cycles` — number of escalation re-cycles done in the current outage.

And under `$PERSIST` (must survive the reboot it records):

- `outage_rebooted` — exists once the reboot rung has fired in this outage; removed when the uplink recovers.

### New modes

`ports` (read-only, no lock). One tab-separated line per `ethN` interface present in `/sys/class/net`, in numeric order:

```
port  link  speed  poeCfg  poeLive  mac  rxBytes  txBytes  rxErr  txErr  flags  lastEventEpoch  lastEventAction
```

- `link`: `up|down` from `/sys/class/net/ethN/carrier`.
- `speed`: Mbps from `/sys/class/net/ethN/speed`, `-` when down.
- `poeCfg`: `24v|off|48v|pthru|none` from the running config (`$CFGWRAP show interfaces ethernet ethN poe output`), `none` when the port has no PoE (eth0 on ER-X, the SFP).
- `poeLive`: `on|off|-` from `ubnt-hal`/`ubnt-hal-e` PoE status when available, else `-`.
- `mac`: first MAC seen on the port from `mac_table`, `-` if none.
- Counters from `/sys/class/net/ethN/statistics/{rx_bytes,tx_bytes,rx_errors,tx_errors}`.
- `flags`: comma list from `uplink,protected,excluded,allowed,managed,manual-off,cut,sfp`; `-` when empty.
- Last event from `port-events` for this port, `- -` when none.

`port-events [ethN]` (read-only, no lock): prints `port-events` lines, filtered to the port when given.

`poe-set ethN off|24v` (takes the lock like `cycle-mac`): refuses the uplink port (exit 3, `port ethN is the uplink`) and eth0/SFP with no PoE (exit 3). `off`: commit, save, create `manual-off/ethN`, log event `manual-off`. `24v`: commit, save, remove the marker, log `manual-on`. Prints `set ethN off|24v`, exit 0.

`cycle-port ethN` (takes the lock): refuses uplink and protected ports (exit 3) and ports with `poeCfg` other than `24v` (exit 3). Otherwise `poe_cycle`, log event `cycle` with source `portal`, print `cycled ethN`, exit 0. Unmanaged ports are allowed; this is a deliberate manual action.

Exit code 4 `busy` when the lock is held, as today.

### Changed behaviour

- `managed_ports`: returns nothing when `ALLOWED_MACS` is empty; excludes any port with a `manual-off` marker. The `UBNT_OUIS` table, `is_ubnt_oui`, and the legacy branch are deleted.
- `boot_heal`: skips ports with a `manual-off` marker.
- Every cut, restore, and cycle the watchdog performs appends a `port-events` line with source `watchdog`.
- `mode_status` gains a line `escalation     : N/ESCALATE_CYCLES re-cycles, reboot yes|no|done` during an outage.

### Escalation ladder (in `mode_check`, uplink-down branch)

1. `FAIL_LIMIT` consecutive failed checks: cut managed ports (existing).
2. While still down: every `CYCLE_COOLDOWN` seconds after the cut (or the previous re-cycle), re-cycle all managed ports (`poe_cycle` each, sequentially), increment `outage_cycles`, event `escalate-cycle`.
3. When `outage_cycles >= ESCALATE_CYCLES`, `ESCALATE_REBOOT=1`, and `outage_rebooted` does not exist: log `UPLINK DOWN: escalation exhausted, rebooting router`, event `reboot`, create `outage_rebooted` **in `$PERSIST`** (see below), then `reboot`.
4. After the reboot rung, or when `ESCALATE_REBOOT=0`, continue step 2 indefinitely.

The once-per-outage guard is `$PERSIST/outage_rebooted` because `$STATE` is lost on reboot. `mode_check` deletes it on the first check where the uplink is healthy for `RECOVER_OK` checks (the same point that restores PoE). A reboot never fires while any `$PERSIST/cycling.*` breadcrumb exists (a manual cycle is in progress).

With defaults (`FAIL_LIMIT` 5, `CYCLE_COOLDOWN` 600, `ESCALATE_CYCLES` 3) the reboot happens roughly 35 minutes into an outage.

## SSH layer (`lib/ssh.js`)

New exports, each validating arguments before building the command:

- `parsePorts(text) → [{ port, link, speed, poeCfg, poeLive, mac, rxBytes, txBytes, rxErr, txErr, flags: [], lastEvent: { at, action } | null }]`
- `getPorts(cfg, creds, host)` → `parsePorts` of `sudo REMOTE_PATH ports`.
- `getPortEvents(cfg, creds, host, port?)` → `[{ at, port, action, reason, source }]`.
- `setPoe(cfg, creds, host, port, mode)` with `mode ∈ {off, 24v}`; rejects with the script's message on non-zero exit.
- `cyclePort(cfg, creds, host, port)`.
- `PORT_RE = /^eth\d+$/` used by all four.

## Port poller (`lib/portpoller.js`)

Pure scheduling plus a thin driver, unit-tested like `apscheduler`.

- One queue, one worker. Jobs: `{ key, priority: 'live'|'background' }`. `live` jobs go to the front. A key already queued is not queued twice; a `live` request upgrades a queued `background` job.
- Background: each device is due `backgroundMinutes` after its last successful read (any priority). Due devices are enqueued at most one per tick; the tick runs every 60 s.
- The worker pauses while a fleet Check or Deploy is running (server sets a flag) and while `ssh.haveAuth()` is false.
- Each read stores `dev.ports` (array from `parsePorts`, enriched, see below), `dev.portsAt`, and computes `rateRx`/`rateTx` bytes per second per port from the previous sample when the previous sample is under 5 minutes old; otherwise rates are `null`.
- Failures store `dev.portsError` and reschedule the device normally.

`config.portal.ports = { backgroundMinutes: 30, liveSeconds: 15 }`; `backgroundMinutes` 0 disables background polling. Editable in Settings.

## Server (`server.js`)

Enrichment when storing a snapshot: for each port with a `mac`, attach `ap: { name, model, online, firmware, id }` when the MAC is in `state.aps`; attach `radio: true` when it is in `state.protectedMacs`.

Routes (all behind the existing basic auth; write routes require SSH auth and return 428 without it):

| Route | Behaviour |
|---|---|
| `GET /api/devices/:key/ports` | `{ ports, portsAt, portsError, stale }`; `?live=1` enqueues a `live` read and waits for it (up to 20 s) before responding |
| `GET /api/devices/:key/ports/:port/events` | `{ events }` via `getPortEvents` (live SSH) |
| `POST /api/devices/:key/ports/:port/poe` body `{ mode }` | `setPoe`, then a `live` refresh; 400 for the uplink port or bad mode |
| `POST /api/devices/:key/ports/:port/cycle` | `cyclePort`, then a `live` refresh; 400 for uplink/protected |
| `PUT /api/devices/:key/ports/:port/exclude` body `{ excluded }` | edits `dev.overrides.EXCLUDE_PORTS` (space-separated set), 400 for the uplink port, marks `dev.lastCheck.inSync = false` so the row shows drift until deployed |

The uplink port for a device is `dev.ports.find(p => p.flags.includes('uplink'))`. When no snapshot exists yet, write routes that need the uplink check return 409 `no port snapshot yet; refresh first`.

`GET /api/devices` rows gain `portsSummary: [{ port, link, poeLive, flags }]` for the mini strip.

Settings: `PUT /api/settings` accepts `ports.backgroundMinutes` (0–1440) and `ports.liveSeconds` (5–120); `defaults` accepts `ESCALATE_CYCLES` (0–20) and `ESCALATE_REBOOT` (0|1).

## UI

### Device page `#/devices/<key>`

- Header: name, site, IP, model, UISP online dot, check/deploy badges, Check / Deploy / dropdown actions (same handlers as the list), back link.
- Port strip: one square per port from the snapshot, numbered. Fill: green ≥1000 Mbps, amber <1000, grey link down, hatched `poeCfg` none. Glyphs: bolt = PoE live on, struck bolt = manual-off, red ring = `cut`, shield = uplink or protected. Title tooltip = one-line summary. Click selects.
- Selected port card: link/speed, PoE config and live, MAC; AP block (name, model, online, firmware, link to `#/aps` filtered by name) or "UISP backhaul radio" or "unknown device"; traffic: RX/TX rate when available, byte and error counters; flags as badges; actions: Include/Exclude toggle (with "needs deploy" hint while drifted), Cycle now, PoE off / PoE on, Reboot AP (only when an online AP is present). Every action opens a confirm dialog naming the port and what is plugged in. Uplink and protected ports show the controls disabled with the reason.
- Port history: last 50 events for the selected port, newest first: time, action, reason, source.
- Overrides card: the existing form, including the two new escalation fields.
- Watchdog card: the existing status text and recent log lines, with a Refresh button.
- Live refresh every `liveSeconds` while on the page, "updated Ns ago" text, stopped on leaving.
- Both old dialogs (watchdog status, overrides) are removed; the row dropdown items now route to the device page.

### Device list

Each row gets a mini port strip from `portsSummary`; clicking the device name or the strip opens the device page.

### Settings

New "Ports" card: background poll minutes, live refresh seconds. Defaults card gains `ESCALATE_CYCLES` and `ESCALATE_REBOOT` (checkbox).

## Error handling

- SSH failure on a live read: card shows the last snapshot with a red "stale, last error: …" note; actions stay enabled (they open their own session).
- Script exit 3/4 on an action: toast with the script's message; nothing changes.
- No UniFi configured or never synced: banner on the device page "UniFi not configured, whitelist empty, watchdog is passive".
- Reboot rung fires: the portal's next check sees a short uptime and the `reboot` event; the device page history shows "router rebooted by watchdog".

## Testing

- `test/watchdog.test.js` (existing harness): `ports` line shape for a faked `/sys/class/net` tree; empty whitelist → `managed_ports` empty; manual-off port excluded from `managed_ports` and skipped by `boot_heal`; `poe-set` refuses uplink (3) and writes/removes the marker; `cycle-port` refuses protected (3) and cycles an unmanaged 24v port; events file trimmed to 200; escalation: after `ESCALATE_CYCLES` re-cycles the reboot hook is called once and not again within the outage (reboot is a stubbed function in the harness).
- `test/ssh-parse.test.js`: `parsePorts` with a full line, a down port, an SFP line, junk lines; `PORT_RE` guard rejects `eth1; reboot`.
- `test/portpoller.test.js`: live jumps queue; no duplicate keys; live upgrades background; due computation; pause flag; rate math including the 5-minute cutoff.
- Manual: device page against the Pi on one switch (ERX-AppleGate): strip renders, click a port, exclude/include round-trip shows drift then clears after Deploy, cycle an unmanaged port, PoE off then on on a spare port with the marker visible in `status`, Reboot AP on Unifi-ApplegateEast.

## Rollout

- Deploy to all after release: the template changed, every switch shows drift until deployed.
- `EXCLUDE_PORTS` per-device values are unchanged by this work.
- Existing switches with an OUI-learned allowed-ports file keep it; the file is additive and still only consulted when `ALLOWED_MACS` is non-empty.
