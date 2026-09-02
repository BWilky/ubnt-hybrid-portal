# UniFi access points: pane, rolling weekly reboot, and PoE whitelist

Date: 2026-09-01
Status: approved design, awaiting implementation plan
Depends on: the CoreUI light-theme UI rebuild (`2026-09-01-coreui-light-ui-design.md`) — the new pane slots into that sidebar.

## Goal

1. Show every UniFi access point in a new "Access points" pane.
2. Reboot the AP fleet once per cycle through the UniFi restart command: random order, up to 3 APs in flight, only inside a configured weekly window, round robin across windows until every AP has been done, then reshuffle. APs that UniFi reports offline fall back to a PoE power-cycle of their ER-X port.
3. Use the UniFi AP MAC list as a strict whitelist on the ER-X watchdog: only ports where a UniFi AP has been seen are ever monitored or PoE-cycled.
4. Retire the per-switch `weekly-ap-cycle` cron so APs are not rebooted twice.

## Non-goals

- No UniFi username/password login; API key only.
- No per-AP schedule or per-AP window; one fleet-wide window.
- No manual MAC allow list beyond UniFi APs (strict whitelist was chosen).
- No changes to how the watchdog decides an *uplink* is down; only which ports it is allowed to act on.
- No multi-site support: the first site returned by the Integration API is used. (The controller has one site.)

## Facts established against the real controller

- UniFi OS Server at `https://unifi.barnabaslanding.com:11443`, Network application 10.6.x, one site.
- Integration API: `GET /proxy/network/integration/v1/info`, `/sites`, `/sites/{siteId}/devices?limit=200`, `/sites/{siteId}/devices/{deviceId}`, `/sites/{siteId}/devices/{deviceId}/statistics/latest`, `POST /sites/{siteId}/devices/{deviceId}/actions` with body `{ "action": "RESTART" }`. Auth header `X-API-KEY`. Self-signed certificate.
- Device list fields: `id, name, model, macAddress, ipAddress, state (ONLINE|OFFLINE|…), features (['accessPoint'] | ['switching']), firmwareVersion, firmwareUpdatable, interfaces`. Statistics: `uptimeSec, lastHeartbeatAt, cpuUtilizationPct, memoryUtilizationPct`.
- No uplink switch or port information for APs behind third-party switches. Port mapping must come from the ER-X MAC tables, which the watchdog already learns into `/config/user-data/poe-watchdog/ap-map`.
- Fleet today: 64 APs (5 offline), 5 UniFi switches, 1 gateway.

## Configuration

`config.json` gains:

```json
"unifi": {
  "url": "https://unifi.example.com:11443",
  "apiKey": "PASTE-NETWORK-INTEGRATION-API-KEY",
  "allowSelfSigned": true,
  "refreshMinutes": 5,
  "reboot": {
    "enabled": false,
    "day": 3,
    "start": "02:00",
    "hours": 3,
    "concurrency": 3,
    "timeoutMinutes": 8
  }
}
```

- `day` is 0 (Sunday) to 6, Pi local time. `start` is `HH:MM`. `hours` is the window length.
- `config.example.json` documents the section. `install.sh`'s wizard asks two more questions, UniFi URL and API key, both optional; blank skips and leaves the section with placeholder values, in which case the AP pane shows a "UniFi not configured" alert and the scheduler stays off.
- `unifi.reboot` and `unifi.refreshMinutes` are editable from Settings; url/apiKey are file-only like the UISP token.
- `defaults.AP_CYCLE_CRON` is removed from `config.example.json`, from the template, and from `PUT /api/settings` handling. Existing `config.json` files that still contain it are tolerated: the key is ignored and dropped on the next settings save.

## Server components

### `lib/unifi.js` (new)

- `getSiteId(cfg)`: first site id from `/sites`, cached in module memory for the process lifetime.
- `listAccessPoints(cfg)`: devices with `features` including `accessPoint`, normalised to `{ id, name, model, mac (lowercase), ip, state, online (state === 'ONLINE'), firmware }`. Handles `limit`/`offset` paging if `totalCount` exceeds one page.
- `getUptime(cfg, id)`: `statistics/latest` → `{ uptimeSec, lastHeartbeatAt }`; returns `null` on 4xx/5xx instead of throwing (offline APs have no fresh stats).
- `restart(cfg, id)`: POST RESTART; resolves on 2xx, throws with the response body text otherwise.
- Same fetch/TLS style as `lib/uisp.js` (`allowSelfSigned` → `rejectUnauthorized: false`).

### AP inventory (in `server.js`)

- State file gains `aps: { [mac]: ap }`, `apsSyncedAt`, `allowedMacs: [mac]`, and `apPorts: { [switchKey]: { [mac]: port } }` (learned from switches, see below).
- `syncAps()`: calls `listAccessPoints`, merges into `state.aps` preserving portal-owned fields per AP (`skip`, `lastReboot`, `rebootHistory`), sets `state.allowedMacs` to the sorted MAC list, saves state, logs the count. Runs on `POST /api/sync` (after the UISP pull; a UniFi failure logs a warning and does not fail the sync), on `POST /api/aps/sync`, and on a timer every `unifi.refreshMinutes` (0 disables).
- `renderScript()` adds `ALLOWED_MACS: state.allowedMacs.join(' ')` to the template variables. A changed AP list therefore changes the rendered hash and existing drift detection flags every switch.

### Learned port map

- `lib/ssh.js` `checkStatus()` and `deploy()` additionally run `sudo <script> apmap` when the script is installed and store the parsed result as `dev.apPorts = { [mac]: 'ethN' }`. `apmap` output is one `ethN mac ip epoch` line per learned AP (the persisted `ap-map` file, unchanged format).
- `state.apPorts[switchKey]` is that per-switch map; `findApPort(mac)` searches all switches and returns `{ switchKey, port }` or `null`.

### Rolling reboot scheduler (`lib/apscheduler.js`, new, pure logic + a thin driver in `server.js`)

Pure functions (unit-tested with `node --test`, no dependencies):

- `inWindow(now, reboot)` → boolean. Window is `[start, start + hours)` on `day`, local time. A window that crosses midnight is handled by comparing minutes-since-window-start.
- `buildQueue(aps, rng)` → array of MACs, excluding `skip: true`, shuffled with the supplied `rng` (tests pass a seeded rng; production passes `Math.random`).
- `nextActions(sched, aps, now, cfg)` → `{ start: [mac], finished: [{ mac, result }], updated: sched }`: pops from the queue while `inFlight` count is below `concurrency`; marks in-flight entries finished when their AP is confirmed back (below) or when `now - startedAt` exceeds `timeoutMinutes`.

Driver (in `server.js`, `setInterval` every 30 s):

1. If `unifi.reboot.enabled` is false or `!inWindow(now)`: if anything is in flight, keep polling it to completion (a restart already issued is allowed to finish past the window end); otherwise return.
2. If the queue is empty and nothing is in flight: `queue = buildQueue(...)`, `cycleStartedAt = now`. Log "AP reboot cycle started (N queued)".
3. For each MAC returned in `start`:
   - AP online in the last inventory → `unifi.restart(id)`, record `inFlight[mac] = { startedAt: now, method: 'unifi', uptimeBefore }`.
   - AP offline → `findApPort(mac)`. If found and SSH auth is available → run `sudo <script> cycle-mac <mac>` on that switch; record `method: 'poe'`. If not found or no SSH auth → log a warning, record the AP as `result: 'skipped-unknown-port' | 'skipped-no-ssh'`, and push the MAC to the back of the queue so it is retried in a later window of the same cycle at most once; a second skip finishes it with that result.
   - Any thrown error → `result: 'error: <message>'`, finished immediately.
4. Confirmation: on each tick, for every in-flight entry, refresh `listAccessPoints` once (one call for all) and `getUptime` for in-flight APs. Back = `state === 'ONLINE'` and (`uptimeSec < (now - startedAt) + 120` or `uptimeBefore` was null). Result `ok`.
5. Finished entries write `state.aps[mac].lastReboot = { at, method, result }` and append to a capped (10) `rebootHistory`. Everything is logged at info (ok) or warn (timeout/skip/error).
6. `state.apReboot = { queue, inFlight, cycleStartedAt, lastCycleCompletedAt }` is persisted after every change so a portal restart resumes where it was. In-flight entries older than `timeoutMinutes` at startup are finished as `timeout`.

### API

| route | purpose |
|---|---|
| `GET /api/aps` | `{ aps: [...], syncedAt, configured: bool, reboot: { enabled, window, queueLength, inFlight: [mac], cycleStartedAt, lastCycleCompletedAt, nextWindowAt } }` |
| `POST /api/aps/sync` | run `syncAps()` now |
| `POST /api/aps/:mac/reboot` | manual reboot: same online/offline decision as the scheduler, outside the window, not counted in the queue. 409 if that AP is already in flight. |
| `PUT /api/aps/:mac` | body `{ skip: bool }` |
| `GET/PUT /api/settings` | gain `unifi: { refreshMinutes, reboot: {...} }`; PUT validates day 0–6, `HH:MM`, hours 1–24, concurrency 1–10, timeoutMinutes 2–30 |

`nextWindowAt` is computed by the scheduler module (`nextWindowStart(now, reboot)`), also unit-tested.

## Watchdog template changes (`templates/poe-watchdog.sh.tpl`)

- New variable block `ALLOWED_MACS="{{ALLOWED_MACS}}"` with a comment explaining the whitelist.
- New `detect_allowed_ports()`: mirrors `detect_protected_ports()` — any port where an `ALLOWED_MACS` entry is seen is appended once to `$PERSIST/allowed-ports`; returns the persisted set. Also consults `$STATICMAP` lines so a manual static mapping still works.
- `managed_ports()`: when `ALLOWED_MACS` is non-empty, a port must be in the allowed set to be returned (in addition to the existing exclusions). When `ALLOWED_MACS` is empty, behaviour is unchanged (legacy OUI mode) so a portal without UniFi configured keeps working; `status` prints which mode is active.
- New mode `apmap`: `cat "$APMAP"` (machine-readable for the portal).
- New mode `cycle-mac <mac>`: looks the MAC up in `$APMAP`, then in `mac_table` as a fallback; if found and the port is in `managed_ports`, calls `poe_cycle` on it and exits 0; exits 2 with "unknown mac" or 3 with "port not managed" otherwise. Takes the same lock as `check`.
- `mode_weekly_ap_cycle` and the `STAGGER_SECS` variable are removed; the usage line is updated.
- `mode_status` gains a line `whitelist        : N allowed MACs, allowed ports: ...` or `whitelist        : none (legacy OUI mode)`.

## Deploy / check changes (`lib/ssh.js`)

- `deploy()` scheduler block: drop the three `weekly-ap-cycle` `set` lines and add `delete system task-scheduler task weekly-ap-cycle` before commit (delete of a missing node is tolerated: it is run as a separate `|| true` step so the commit still happens).
- `checkStatus()` `scheduled` becomes true only when both `poe-watchdog` and `weekly-reboot` appear in the crontab and `weekly-ap-cycle` does not; otherwise the device shows "in sync, no scheduler" (amber) until redeployed, which is the existing signal for a scheduler mismatch.
- Both functions fetch `apmap` as described above.

## UI (extends the CoreUI rebuild)

### Sidebar
- New item "Access points" (`#/aps`) between Devices and Settings, with the `cil-wifi-signal-4` icon or the closest available in the sprite.

### Access points view
- Alert at top when `configured` is false: "UniFi is not configured. Add `unifi.url` and `unifi.apiKey` to config.json."
- Stat cards: Access points, Online, Offline, Rebooted last 7 days.
- Schedule strip (a small card): enabled/disabled badge, window text ("Wednesdays 02:00 for 3 h, 3 at a time"), queue remaining, in-flight names, next window time, and a link to Settings.
- Toolbar: search (name/MAC/IP/model), state filter (all/online/offline/skipped), "Sync from UniFi" button, synced-at text.
- Table: State badge, Name, Model, MAC (mono), IP (mono), Firmware, Last reboot (time + method + result badge), Actions.
  - Actions: **Reboot now** (confirm via a small Bootstrap modal, then POST), **Skip weekly reboot** toggle (a form-switch in the row). Rows in flight show a spinner badge and the Reboot button disabled.
- Auto-refresh the view every 30 s while it is visible.

### Settings view
- New card "UniFi": refresh interval, and "Weekly AP reboot" fields: enabled switch, day select, start time input, hours, concurrency, timeout. Saved with the existing Save button. Help text notes that offline APs get a PoE cut via their switch and need SSH auth.
- `AP_CYCLE_CRON` no longer appears in fleet defaults.

### Logs
- No UI change; scheduler activity appears through the existing log.

## Error handling

- UniFi unreachable: `syncAps` logs a warning; the pane shows the last known list with a stale badge and the synced-at time; the scheduler does not start a new cycle and does not issue restarts while the last sync is older than 2 × `refreshMinutes` (in-flight confirmations still poll).
- Restart call fails: recorded as `error`, next AP proceeds.
- PoE fallback fails (SSH error, unknown port): recorded and logged as above; never retried more than once per cycle.
- Portal restart mid-window: state is persisted; the driver resumes on the next tick.
- Invalid settings values: 400 with a message; nothing saved.

## Security

- API key lives only in `config.json` (mode 600, gitignored), never returned by any API or logged. `GET /api/settings` returns `unifi.configured: true/false`, not the key.
- The PoE fallback uses the existing SSH credential model (memory-only or key file).

## Testing

- `node --test test/apscheduler.test.js`: `inWindow` (inside, before, after, midnight crossing, wrong day), `nextWindowStart`, `buildQueue` (skip excluded, seeded shuffle deterministic, every MAC exactly once), `nextActions` (respects concurrency, times out, finishes confirmed entries, refills only when queue and in-flight are empty).
- `node --test test/unifi.test.js`: `listAccessPoints` normalisation and paging against a stubbed fetch.
- Template: render with a non-empty and an empty `ALLOWED_MACS` and run `bash -n`; a shell test that sources the script's functions with a faked `mac_table` and asserts `managed_ports` filtering and `cycle-mac` exit codes (2 unknown, 3 not managed).
- Manual: AP pane against the real controller; **Reboot now** on one AP chosen by the user, confirming the row goes in flight and returns `ok`; Settings round trip; drift shows amber on all switches after the first `ALLOWED_MACS` render and clears after deploy; `status` on one switch shows the whitelist line and the learned allowed ports.
