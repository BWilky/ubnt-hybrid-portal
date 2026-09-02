#!/usr/bin/env bash
# ubnt-hybrid-portal installer / updater for Debian-family systems (Raspberry Pi OS).
#
#   curl -fsSL https://raw.githubusercontent.com/BWilky/ubnt-hybrid-portal/main/install.sh | sudo bash
#
# First run: installs Node.js if needed, downloads the latest release to
# /opt/ubnt-hybrid-portal, walks you through a short config wizard (UISP
# URL/token, portal password, port, and optionally the UniFi URL and API key;
# no SSH passwords -- those are entered in the web UI and never stored), and
# sets up a systemd service. Re-running the same command updates in place,
# keeping your config.json and device state.

set -euo pipefail

REPO="BWilky/ubnt-hybrid-portal"
APP_DIR="/opt/ubnt-hybrid-portal"
SERVICE="ubnt-hybrid-portal"
RUN_USER="poeportal"

say()  { printf '\033[1;33m==>\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "please run with sudo: curl -fsSL .../install.sh | sudo bash"
command -v apt-get >/dev/null || die "this installer supports apt-based systems (Raspberry Pi OS / Debian / Ubuntu)"

# --- Node.js >= 18 -----------------------------------------------------------
node_major() { node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))' 2>/dev/null || echo 0; }

if ! command -v node >/dev/null || [ "$(node_major)" -lt 18 ]; then
  say "Installing Node.js (from apt)..."
  apt-get update -qq
  apt-get install -y -qq nodejs npm curl ca-certificates >/dev/null
  if [ "$(node_major)" -lt 18 ]; then
    say "apt's Node.js is too old — installing Node 20 from NodeSource..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
    apt-get install -y -qq nodejs >/dev/null
  fi
fi
say "Node.js $(node -v) OK"

# --- fetch latest release ----------------------------------------------------
TAG="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null \
       | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1 || true)"
if [ -n "$TAG" ]; then REF_PATH="tags/$TAG"; else REF_PATH="heads/main"; fi
say "Downloading $REPO @ ${TAG:-main} ..."

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "https://github.com/$REPO/archive/refs/$REF_PATH.tar.gz" \
  | tar -xz -C "$TMP" --strip-components=1

# --- install / update files (preserve config.json + state/) -------------------
# stop the service during the swap so it never serves half-replaced files
systemctl stop "$SERVICE" 2>/dev/null || true
mkdir -p "$APP_DIR"
if command -v rsync >/dev/null; then
  rsync -a --delete \
    --exclude config.json --exclude 'state/' --exclude node_modules \
    "$TMP"/ "$APP_DIR"/
else
  (cd "$TMP" && find . -type f ! -name config.json | while read -r f; do
     mkdir -p "$APP_DIR/$(dirname "$f")"; cp "$f" "$APP_DIR/$f"; done)
fi
mkdir -p "$APP_DIR/state"

say "Installing npm dependencies..."
(cd "$APP_DIR" && npm install --omit=dev --no-audit --no-fund --loglevel=error)

# --- first-run config wizard ---------------------------------------------------
ask() { # ask "prompt" "default" -> REPLY
  local prompt="$1" def="$2"
  if [ -r /dev/tty ]; then
    read -r -p "$prompt${def:+ [$def]}: " REPLY < /dev/tty || REPLY=""
  else
    REPLY=""
  fi
  REPLY="${REPLY:-$def}"
}

if [ ! -f "$APP_DIR/config.json" ]; then
  if [ -r /dev/tty ]; then
    say "First-time setup — a few questions (SSH device passwords are NOT asked; enter those in the web UI):"
    ask "UISP URL (e.g. https://uisp.example.com)" ""
    UISP_URL="$REPLY"
    ask "UISP API token (UISP → Settings → Users → API tokens)" ""
    UISP_TOKEN="$REPLY"
    ask "Portal web login password (username will be 'admin')" "change-me"
    PORTAL_PASS="$REPLY"
    ask "Portal port" "8090"
    PORTAL_PORT="$REPLY"
    ask "UniFi controller URL (optional, e.g. https://unifi.example.com:11443; blank to skip)" ""
    UNIFI_URL="$REPLY"
    UNIFI_KEY=""
    if [ -n "$UNIFI_URL" ]; then
      ask "UniFi Network Integration API key (Settings → Control Plane → Integrations)" ""
      UNIFI_KEY="$REPLY"
    fi
  else
    say "No terminal available — writing a template config; edit $APP_DIR/config.json afterwards."
    UISP_URL="https://unms.example.com"; UISP_TOKEN="PASTE-UISP-API-TOKEN-HERE"
    PORTAL_PASS="change-me"; PORTAL_PORT="8090"
    UNIFI_URL=""; UNIFI_KEY=""
  fi

  UISP_URL="$UISP_URL" UISP_TOKEN="$UISP_TOKEN" PORTAL_PASS="$PORTAL_PASS" PORTAL_PORT="$PORTAL_PORT" \
  UNIFI_URL="$UNIFI_URL" UNIFI_KEY="$UNIFI_KEY" \
  node -e '
    const fs = require("fs");
    const cfg = JSON.parse(fs.readFileSync(process.argv[1] + "/config.example.json", "utf8"));
    cfg.portal.bind = "0.0.0.0";
    cfg.portal.port = parseInt(process.env.PORTAL_PORT, 10) || 8090;
    cfg.portal.authPass = process.env.PORTAL_PASS;
    cfg.uisp.url = process.env.UISP_URL;
    cfg.uisp.apiToken = process.env.UISP_TOKEN;
    if (process.env.UNIFI_URL) { cfg.unifi.url = process.env.UNIFI_URL; cfg.unifi.apiKey = process.env.UNIFI_KEY || cfg.unifi.apiKey; }
    fs.writeFileSync(process.argv[1] + "/config.json", JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  ' "$APP_DIR"
  say "Wrote $APP_DIR/config.json (mode 600)"
else
  say "Keeping existing config.json"
fi

# --- service user + systemd ----------------------------------------------------
id "$RUN_USER" >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin -d "$APP_DIR" "$RUN_USER"
chown -R "$RUN_USER":"$(id -gn "$RUN_USER")" "$APP_DIR"
chmod 600 "$APP_DIR/config.json"

cat > "/etc/systemd/system/$SERVICE.service" <<EOF
[Unit]
Description=UBNT hybrid PoE portal (UISP inventory + EdgeOS SSH watchdog deploy)
After=network-online.target
Wants=network-online.target

[Service]
User=$RUN_USER
WorkingDirectory=$APP_DIR
ExecStart=$(command -v node) server.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "$SERVICE" >/dev/null
systemctl restart "$SERVICE"
sleep 1
systemctl is-active --quiet "$SERVICE" || die "service failed to start — check: journalctl -u $SERVICE -n 50"

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
PORT="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1]+"/config.json","utf8")).portal.port)' "$APP_DIR")"
say "Done! Open http://${IP:-<this-host>}:$PORT  (login: admin / the password you chose)"
say "Then click 'SSH: login required' in the header to enter your device credentials (memory-only),"
say "'Sync from UISP', and 'Deploy to all'."
say "Update later by re-running the same install command. Logs: journalctl -u $SERVICE -f"
