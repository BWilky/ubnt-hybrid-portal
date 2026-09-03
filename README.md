# ubnt-hybrid-portal

Lightweight Node.js fleet manager for the ER-X-SFP PoE watchdog script.

- **UISP (UNMS) is the inventory source**: one click pulls every switch
  matching your model filter (name, IP, site, online state). UISP has no
  API for pushing files or running commands on EdgeMax devices, so...
- **SSH is the deploy transport**: the portal renders the watchdog script
  per-device (fleet defaults + per-device overrides), uploads it over
  SFTP, installs it to /config/scripts, verifies the SHA-256, and ensures
  the two task-scheduler entries (1-minute check, weekly reboot) exist —
  idempotently.
- **Drift detection**: "Check" hashes the remote script and compares it to
  what the portal *would* render right now. Change a fleet default or a
  device override and every affected switch immediately shows amber
  "drift detected" until you redeploy.
- **UniFi is the access-point source**: the Network Integration API (API
  key) lists every AP, drives a weekly rolling reboot (random order, a
  few at a time, inside a window you set; offline APs get a PoE cycle
  from their switch instead), and its MAC list is rendered into each
  switch as a strict whitelist of PoE ports the watchdog may manage.

> **Upgrade note:** the UniFi AP whitelist is now **mandatory**. With an
> empty `ALLOWED_MACS` (no UniFi APs synced yet) the watchdog manages
> **nothing** — the legacy Ubiquiti-OUI auto-detect fallback has been
> removed. If you upgraded from a version that relied on OUI detection,
> make sure UniFi is configured and synced so every PoE port has a
> whitelisted AP MAC before the watchdog will manage it again.

- **SSH credentials are never stored**: you enter the fleet admin
  username/password in the web UI (the **SSH: login required** button in
  the header, until credentials or key auth are set). They live only in
  the portal process's memory, are never written to disk, and are
  forgotten on restart. (Optional: configure a private key file in
  config.json instead for unattended use.)

## Install on a Raspberry Pi (or any Debian/Ubuntu box)

One line, run on a Pi that can reach your UISP server and the switches:

```
curl -fsSL https://raw.githubusercontent.com/BWilky/ubnt-hybrid-portal/main/install.sh | sudo bash
```

It installs Node.js if needed, downloads the latest release to
`/opt/ubnt-hybrid-portal`, asks a few questions (UISP URL, UISP API token,
portal login password, port, and optionally a UniFi controller URL and
Integration API key — never an SSH password), and sets up a systemd
service that starts on boot. When it finishes it prints the URL to open.
Re-run the same command any time to update — your config and device
state are kept.

```
journalctl -u ubnt-hybrid-portal -f     # logs
sudo systemctl restart ubnt-hybrid-portal
```

## Manual setup

```
npm install
cp config.example.json config.json   # then edit it
node server.js                       # http://127.0.0.1:8090
```

The web UI is plain HTML/JS on [CoreUI 5](https://coreui.io/) (Bootstrap 5),
vendored through npm and served by the portal itself from `/vendor/…`, so the
Pi needs no internet access to render it.

### config.json

| section | what to set |
|---|---|
| `portal` | port/bind + basic-auth credentials. Keep it bound to a management network or localhost behind a reverse proxy. |
| `uisp.url` / `uisp.apiToken` | UISP → Settings → Users → your user → API tokens. Read access is enough. |
| `uisp.modelMatch` | regex against the UISP model string; default matches ER-X / ERX variants. |
| `ssh` | port/timeout/concurrency only. Credentials come from the web UI at runtime (memory-only). Optionally set `username` + `privateKeyPath` here as an unattended fallback — GUI credentials take precedence. The account must be an EdgeOS admin-level user (sudo). |
| `unifi` | URL + Integration API key (UniFi → Settings → Control Plane → Integrations → Create API Key). `refreshMinutes` and `reboot.*` are editable in the Settings view. |
| `defaults` | fleet-wide watchdog settings: GATEWAY_IP, thresholds, cron spec for the weekly reboot. Any of these can be overridden per device in the UI. |

### SSH credentials

Click **SSH: login required** in the portal header (it reads that until
credentials or key auth are set) and enter the fleet admin
username/password (e.g. `ubnt`). The portal keeps them in RAM only —
nothing is written to disk, and after a portal restart you enter them
again. Every deploy/check/status action uses that one login.

**Recommended: one-click key auth.** In the SSH login dialog, click
"Set up key auth on all devices". The portal generates an ed25519
keypair (stored in `state/`, survives updates), uses your password ONE
time to install the public key on every device, verifies key login
works, then forgets the password permanently. No more re-entering
credentials after restarts, and the admin password is still never
stored. Revoke any time by deleting the `ubnt-hybrid-portal` public key
from the switches.

### Settings & auto-check

**Settings**, a view in the sidebar, edits the fleet-wide defaults
(GATEWAY_IP, thresholds, cron spec) and the drift auto-check interval
(`portal.autoCheckMinutes`, default 15, 0 = off), persisted to
config.json. The auto-check runs **Check all** on that interval
whenever SSH auth is available, and logs the result (see **Logs**, also
a view in the sidebar).

> Set `GATEWAY_IP` to YOUR site's real router IP before deploying —
> if the watchdog can't ping it, it will cut PoE to the APs by design.

**Self-reboot on a sustained outage.** By default, if the uplink stays
down after PoE has been cut, the switch re-cycles its managed ports
every `CYCLE_COOLDOWN` seconds, up to `ESCALATE_CYCLES` times (default
3), and then reboots itself once per outage (`ESCALATE_REBOOT=1`
default). With stock defaults that's roughly **~35 minutes** into an
outage (5 min to the initial cut, then 3 re-cycles 10 minutes apart).
Both `ESCALATE_CYCLES` and `ESCALATE_REBOOT` are fleet defaults and can
be overridden per device.

### Weekly AP reboot

The portal reads the AP list straight from the UniFi controller (not
UISP) via the Network Integration API and reboots them on a rolling
schedule, configured in Settings: a day/time window and a duration
(`reboot.day`/`start`/`hours`), how many reboot concurrently
(`reboot.concurrency`), and a per-AP timeout. At the start of a cycle the
whole non-skipped fleet is queued in random order, and the window drains
a few at a time (`reboot.concurrency`) until either the queue empties or
the window closes; if the window closes first, the queue picks up where
it left off the following week. Once every AP has been done, the queue
is reshuffled for the next window. An AP that's offline when its turn
comes gets a PoE port cycle from its switch instead of a controller
reboot. The old per-switch weekly AP cycle (`AP_CYCLE_CRON`) is retired
— access points are managed centrally from UniFi now, not per-device on
the ER-X.

An AP that is already offline when the whitelist first deploys won't be
in the switch's MAC table yet, so its port isn't "allowed" and a PoE
fallback reports `skipped-unknown-port` until the AP has been seen
online once; the watchdog's static map file (`$PERSIST/static-map`, see
`STATICMAP` in the script template) is the manual override for that
case.

### Device page

Clicking a device opens a per-port view: link state, speed, PoE
delivery, what's plugged in, traffic, and watchdog history for every
port. From there you can manually exclude/include a port from the
watchdog, PoE-cycle it, turn PoE persistently off/on, or reboot the
UniFi AP behind a port. A **Ports** card in Settings controls how
often ports are polled in the background (minutes) and how often the
device page refreshes while it's open (seconds).

### Manual key setup (alternative)

The same thing by hand: generate a key, set `ssh.username`/
`ssh.privateKeyPath` in config.json, and push the key to each switch:

```
ssh-keygen -t ed25519 -f ~/.ssh/poe-portal
# on each ER-X (or via UISP bulk config):
configure
set system login user ubnt authentication public-keys portal type ssh-ed25519
set system login user ubnt authentication public-keys portal key "AAAA...base64..."
commit ; save ; exit
```

## Workflow

1. **Sync from UISP** — pulls/refreshes the switch list. Overrides and
   history are preserved across syncs (keyed by MAC).
2. **Overrides** (per device, from the row's dropdown next to Deploy) —
   set that switch's GATEWAY_IP, excluded ports, thresholds. Blank =
   inherit fleet default. Stagger the cron minutes per device here so
   all twelve don't reboot at 04:00 sharp.
3. **View script** (same dropdown) — preview the exact rendered file
   before it ships.
4. **Deploy** / **Deploy to all** — upload, verify hash, ensure scheduler.
5. **Check all** — run after any config edit, or from cron:
   `curl -u admin:pass -X POST http://127.0.0.1:8090/api/check-all`
6. **Watchdog status** (same dropdown) — live `poe-watchdog.sh status`
   output plus the last 30 watchdog log lines from that switch.

## Notes & limits

- State lives in `state/devices.json` — plain JSON, easy to back up.
- Deploys never touch anything except `/config/scripts/poe-watchdog.sh`
  and the two named task-scheduler tasks. The watchdog's automatic PoE
  cut/restore is commit-only (never saved to `config.boot`, so a power
  cycle also restores it) — the one exception is the device page's
  manual PoE off/on (`poe-set`), which deliberately persists to
  `config.boot` so a manual off survives a reboot.
- If a switch is hard-frozen, SSH fails and the row goes red — which
  makes the portal double as a coarse "which ERX is wedged" board.
- Device SSH passwords are never stored — memory only, gone on restart.
  The remaining secrets on disk (UISP token, portal password, optional
  SSH key file) sit in config.json with mode 600 — still run the portal
  on a management network, not exposed to untrusted clients.
