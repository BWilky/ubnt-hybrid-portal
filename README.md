# ubnt-hybrid-portal

Lightweight Node.js fleet manager for the ER-X-SFP PoE watchdog script.

- **UISP (UNMS) is the inventory source**: one click pulls every switch
  matching your model filter (name, IP, site, online state). UISP has no
  API for pushing files or running commands on EdgeMax devices, so...
- **SSH is the deploy transport**: the portal renders the watchdog script
  per-device (fleet defaults + per-device overrides), uploads it over
  SFTP, installs it to /config/scripts, verifies the SHA-256, and ensures
  the three task-scheduler entries (1-minute check, weekly AP cycle,
  weekly reboot) exist — idempotently.
- **Drift detection**: "Check" hashes the remote script and compares it to
  what the portal *would* render right now. Change a fleet default or a
  device override and every affected switch immediately shows amber
  "drift detected" until you redeploy.

- **SSH credentials are never stored**: you enter the fleet admin
  username/password in the web UI ("SSH login" in the header). They live
  only in the portal process's memory, are never written to disk, and are
  forgotten on restart. (Optional: configure a private key file in
  config.json instead for unattended use.)

## Install on a Raspberry Pi (or any Debian/Ubuntu box)

One line, run on a Pi that can reach your UISP server and the switches:

```
curl -fsSL https://raw.githubusercontent.com/BWilky/ubnt-hybrid-portal/main/install.sh | sudo bash
```

It installs Node.js if needed, downloads the latest release to
`/opt/ubnt-hybrid-portal`, asks four questions (UISP URL, UISP API token,
portal login password, port — never an SSH password), and sets up a
systemd service that starts on boot. When it finishes it prints the URL
to open. Re-run the same command any time to update — your config and
device state are kept.

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

### config.json

| section | what to set |
|---|---|
| `portal` | port/bind + basic-auth credentials. Keep it bound to a management network or localhost behind a reverse proxy. |
| `uisp.url` / `uisp.apiToken` | UISP → Settings → Users → your user → API tokens. Read access is enough. |
| `uisp.modelMatch` | regex against the UISP model string; default matches ER-X / ERX variants. |
| `ssh` | port/timeout/concurrency only. Credentials come from the web UI at runtime (memory-only). Optionally set `username` + `privateKeyPath` here as an unattended fallback — GUI credentials take precedence. The account must be an EdgeOS admin-level user (sudo). |
| `defaults` | fleet-wide watchdog settings: GATEWAY_IP, thresholds, cron specs for the weekly reboot / AP cycle. Any of these can be overridden per device in the UI. |

### SSH credentials

Click **SSH login** in the portal header and enter the fleet admin
username/password (e.g. `ubnt`). The portal keeps them in RAM only —
nothing is written to disk, and after a portal restart you enter them
again. Every deploy/check/status action uses that one login.

### Optional: key-based fallback instead

If you'd rather not enter credentials after each restart, generate one
key for the portal, set `ssh.username`/`ssh.privateKeyPath` in
config.json, and push the key to each switch once:

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
2. **Config** (per device) — set that switch's GATEWAY_IP, excluded
   ports, thresholds. Blank = inherit fleet default. Stagger the cron
   minutes per device here so all twelve don't reboot at 04:00 sharp.
3. **Script** — preview the exact rendered file before it ships.
4. **Deploy** / **Deploy to all** — upload, verify hash, ensure scheduler.
5. **Check drift on all** — run after any config edit, or from cron:
   `curl -u admin:pass -X POST http://127.0.0.1:8090/api/check-all`
6. **Status** — live `poe-watchdog.sh status` output plus the last 30
   watchdog log lines from that switch.

## Notes & limits

- State lives in `state/devices.json` — plain JSON, easy to back up.
- Deploys never touch anything except `/config/scripts/poe-watchdog.sh`
  and the three named task-scheduler tasks. PoE port config is untouched.
- If a switch is hard-frozen, SSH fails and the row goes red — which
  makes the portal double as a coarse "which ERX is wedged" board.
- Device SSH passwords are never stored — memory only, gone on restart.
  The remaining secrets on disk (UISP token, portal password, optional
  SSH key file) sit in config.json with mode 600 — still run the portal
  on a management network, not exposed to untrusted clients.
