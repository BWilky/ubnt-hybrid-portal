#!/bin/bash
#
# MANAGED BY poe-watchdog-portal -- local edits will be overwritten on next deploy
# rendered for: {{DEVICE_NAME}} ({{DEVICE_IP}}) at {{RENDERED_AT}}
#
# poe-watchdog.sh -- Dynamic PoE watchdog for EdgeRouter X SFP (EdgeOS)
#
# Modes:
#   poe-watchdog.sh check           (default; run every 1 min via task-scheduler)
#   poe-watchdog.sh weekly-ap-cycle (staggered PoE cycle of every AP port)
#   poe-watchdog.sh weekly-reboot   (log + reboot the whole router)
#   poe-watchdog.sh status          (show learned APs, counters, state)
#
# What "check" does:
#   1. Discovers which PoE ports have a Ubiquiti AP behind them (MAC table
#      OUI match) and remembers port -> MAC -> IP in /config/user-data.
#   2. Pings the main router (GATEWAY_IP). If it fails FAIL_LIMIT
#      consecutive minutes (default 5), PoE is cut on all managed ports so
#      the APs stop broadcasting a dead SSID.
#   3. When the uplink is healthy again for RECOVER_OK consecutive checks,
#      PoE is restored automatically (self-heal). PoE-off is never saved to
#      config.boot, so a reboot also restores power.
#   4. While the uplink is healthy, each learned AP is pinged. If an AP is
#      unreachable AP_FAIL_LIMIT consecutive checks, only that port is
#      power-cycled (off -> 5s -> 24v), then put in a cooldown.
#
# SAFETY: only ports already configured "poe output 24v" in config.boot are
# ever touched, and they are only ever set to "off" or back to "24v".
#
# ---------------------------------------------------------------------------
#                              EDIT THESE
# ---------------------------------------------------------------------------

GATEWAY_IP="{{GATEWAY_IP}}"
SECONDARY_IP="{{SECONDARY_IP}}" # optional 2nd target (e.g. core switch);
                                # uplink counts as UP if EITHER answers

FAIL_LIMIT={{FAIL_LIMIT}} # consecutive failed checks (~minutes) before cutting PoE
RECOVER_OK={{RECOVER_OK}} # consecutive good checks before restoring PoE
AP_FAIL_LIMIT={{AP_FAIL_LIMIT}} # consecutive failed AP pings before cycling that port
CYCLE_COOLDOWN={{CYCLE_COOLDOWN}} # seconds to leave a port alone after a cycle
BOOT_GRACE=300                  # seconds after boot before doing anything
POE_OFF_SECS=5                  # off-time during a power cycle
STAGGER_SECS=120                # gap between APs during weekly-ap-cycle

EXCLUDE_PORTS="{{EXCLUDE_PORTS}}" # space-separated, e.g. "eth4" - never touch these

# Ubiquiti OUIs (first 3 octets, lowercase). Add more if an AP isn't detected;
# check yours with: ./poe-watchdog.sh status
UBNT_OUIS="00:15:6d 00:27:22 04:18:d6 18:e8:29 24:5a:4c 24:a4:3c 28:70:4e
44:d9:e7 60:22:32 68:d7:9a 70:a7:41 74:83:c2 74:ac:b9 78:8a:20 78:45:58
80:2a:a8 94:2a:6f a4:2b:8c ac:8b:a9 b4:fb:e4 d0:21:f9 d8:b3:70 dc:9f:db
e0:63:da e4:38:83 f0:9f:c2 f4:92:bf f4:e2:c6 fc:ec:da"

# ---------------------------------------------------------------------------
#                     internals - no need to edit below
# ---------------------------------------------------------------------------

CFGWRAP=/opt/vyatta/sbin/vyatta-cfg-cmd-wrapper
STATE=/var/run/poe-watchdog             # tmpfs: counters, cleared on reboot
PERSIST=/config/user-data/poe-watchdog  # survives reboot & fw upgrade
APMAP="$PERSIST/ap-map"                 # lines: ethX mac ip epoch-lastseen
STATICMAP="$PERSIST/static-map"         # optional manual lines: ethX mac
LOCK="$STATE/lock"
TAG=poe-watchdog

mkdir -p "$STATE" "$PERSIST"
touch "$APMAP"

log() { logger -t "$TAG" "$*"; }

# --- tiny file-backed counters ---------------------------------------------
getn()  { local f="$STATE/$1"; [ -f "$f" ] && cat "$f" || echo 0; }
setn()  { echo "$2" > "$STATE/$1"; }
incn()  { setn "$1" $(( $(getn "$1") + 1 )); }

# --- PoE control via config wrapper (never saved to config.boot) -----------
poe_set() {  # poe_set eth3 off|24v
    local ifc="$1" mode="$2"
    sg vyattacfg -c "
        $CFGWRAP begin  >/dev/null 2>&1
        $CFGWRAP set interfaces ethernet $ifc poe output $mode >/dev/null 2>&1
        $CFGWRAP commit >/dev/null 2>&1
        $CFGWRAP end    >/dev/null 2>&1
    "
    log "PoE $ifc -> $mode"
}

poe_cycle() {  # poe_cycle eth3
    # persistent breadcrumb: if we die/reboot mid-cycle, boot_heal restores it
    echo "$1" > "$PERSIST/cycling.$1"
    poe_set "$1" off
    sleep "$POE_OFF_SECS"
    poe_set "$1" 24v
    rm -f "$PERSIST/cycling.$1"
    date +%s > "$STATE/cooldown.$1"
    setn "apfail.$1" 0
}

# --- which ports are we allowed to manage? ----------------------------------
managed_ports() {
    awk '
        /^[[:space:]]+ethernet eth[0-9]+/ { iface=$2 }
        /output 24v/                      { if (iface != "") print iface }
    ' /config/config.boot | sort -u | while read -r p; do
        case " $EXCLUDE_PORTS " in *" $p "*) ;; *) echo "$p" ;; esac
    done
}

# --- switch MAC table: lines of "ethN mac" ----------------------------------
mac_table() {
    local hal
    for hal in /usr/sbin/ubnt-hal /usr/sbin/ubnt-hal-e; do
        [ -x "$hal" ] || continue
        "$hal" getMacTbl 2>/dev/null | awk '
        {
            mac=""; port=""
            for (i=1; i<=NF; i++) {
                if ($i ~ /^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/) mac=tolower($i)
                else if ($i ~ /^[0-9]+$/ && port=="")            port=$i
            }
            if (mac != "" && port != "") print "eth" port, mac
        }'
        return
    done
    # fallback: bridge fdb if ports are members of switch0 (port N -> ethN-1
    # is NOT guaranteed; prefer ubnt-hal or the static-map file)
    brctl showmacs switch0 2>/dev/null | awk '
        $1 ~ /^[0-9]+$/ && $2 ~ /:/ && $3 == "no" { print "eth" ($1 - 1), tolower($2) }'
}

is_ubnt_mac() {
    local oui="${1:0:8}" o
    for o in $UBNT_OUIS; do [ "$oui" = "$o" ] && return 0; done
    return 1
}

ip_for_mac() {
    ip neigh show 2>/dev/null | awk -v m="$1" 'tolower($0) ~ m { print $1; exit }'
}

# --- learn / refresh port -> AP mapping -------------------------------------
discover_aps() {
    local now port mac ip tbl
    now=$(date +%s)
    tbl=$(mac_table)
    [ -f "$STATICMAP" ] && tbl="$tbl
$(cat "$STATICMAP")"

    for port in $(managed_ports); do
        mac=$(echo "$tbl" | awk -v p="$port" '$1 == p { print $2 }' | while read -r m; do
                  is_ubnt_mac "$m" && { echo "$m"; break; }
              done)
        [ -n "$mac" ] || continue
        ip=$(ip_for_mac "$mac")
        if [ -n "$ip" ]; then
            update_apmap "$port" "$mac" "$ip" "$now"
        else
            # keep previously learned IP if we have one
            grep -q "^$port " "$APMAP" || update_apmap "$port" "$mac" "-" "$now"
        fi
    done
}

update_apmap() {  # port mac ip epoch
    local tmp="$APMAP.tmp"
    grep -v "^$1 " "$APMAP" > "$tmp" 2>/dev/null
    echo "$1 $2 $3 $4" >> "$tmp"
    mv "$tmp" "$APMAP"
}

# --- uplink logic ------------------------------------------------------------
host_up() { ping -c 3 -W 2 -q "$1" >/dev/null 2>&1; }

uplink_up() {
    host_up "$GATEWAY_IP" && return 0
    [ -n "$SECONDARY_IP" ] && host_up "$SECONDARY_IP" && return 0
    return 1
}

cut_all_poe() {
    local p
    : > "$STATE/cut_ports"
    for p in $(managed_ports); do
        poe_set "$p" off
        echo "$p" >> "$STATE/cut_ports"
    done
    # persistent copy so a reboot gives these ports a fresh chance (boot_heal)
    cp "$STATE/cut_ports" "$PERSIST/cut_ports"
    log "UPLINK DOWN >= $FAIL_LIMIT checks: PoE cut on: $(tr '\n' ' ' < "$STATE/cut_ports")"
}

restore_all_poe() {
    local p now
    now=$(date +%s)
    while read -r p; do
        [ -n "$p" ] || continue
        poe_set "$p" 24v
        echo "$now" > "$STATE/cooldown.$p"   # let APs boot before watchdogging them
        setn "apfail.$p" 0
    done < "$STATE/cut_ports"
    log "UPLINK RESTORED: PoE re-enabled on all managed ports"
    rm -f "$STATE/cut_ports" "$PERSIST/cut_ports"
    # Persist the healthy (24v) state: an unlucky config save while PoE was
    # cut (e.g. a deploy) may have written "off" to config.boot, which would
    # survive a reboot and blank the managed-ports list. Saving now heals it.
    sg vyattacfg -c "
        $CFGWRAP begin >/dev/null 2>&1
        $CFGWRAP save  >/dev/null 2>&1
        $CFGWRAP end   >/dev/null 2>&1
    "
}

# --- per-AP watchdog ---------------------------------------------------------
check_aps() {
    local port mac ip seen now cd fails
    now=$(date +%s)
    while read -r port mac ip seen; do
        [ -n "$port" ] && [ -n "$ip" ] && [ "$ip" != "-" ] || continue

        # only manage ports still configured for 24v PoE
        managed_ports | grep -qx "$port" || continue

        cd=0
        [ -f "$STATE/cooldown.$port" ] && cd=$(cat "$STATE/cooldown.$port")
        [ $(( now - cd )) -lt "$CYCLE_COOLDOWN" ] && continue

        if ping -c 2 -W 2 -q "$ip" >/dev/null 2>&1; then
            setn "apfail.$port" 0
        else
            incn "apfail.$port"
            fails=$(getn "apfail.$port")
            log "AP $ip ($mac) on $port unreachable ($fails/$AP_FAIL_LIMIT)"
            if [ "$fails" -ge "$AP_FAIL_LIMIT" ]; then
                log "AP on $port dead -> power cycling port"
                poe_cycle "$port"
            fi
        fi
    done < "$APMAP"
}

# --- boot heal: fresh chance after every power cycle --------------------------
# If the box rebooted while WE had PoE cut (or mid power-cycle), restore those
# ports to 24v and save, so a power cycle always recovers the site — even when
# an earlier config save persisted the "off" state. Only ports this script cut
# are touched; ports an admin deliberately disabled are left alone.
boot_heal() {
    [ -f "$STATE/boot_healed" ] && return   # tmpfs marker: once per boot
    touch "$STATE/boot_healed"
    local p healed=0
    if [ -s "$PERSIST/cut_ports" ]; then
        while read -r p; do
            [ -n "$p" ] || continue
            poe_set "$p" 24v
            healed=1
        done < "$PERSIST/cut_ports"
        rm -f "$PERSIST/cut_ports"
    fi
    for f in "$PERSIST"/cycling.*; do
        [ -f "$f" ] || continue
        poe_set "$(basename "$f" | cut -d. -f2)" 24v
        rm -f "$f"
        healed=1
    done
    if [ "$healed" = 1 ]; then
        log "boot heal: PoE restored on ports cut before reboot (fresh chance)"
        sg vyattacfg -c "
            $CFGWRAP begin >/dev/null 2>&1
            $CFGWRAP save  >/dev/null 2>&1
            $CFGWRAP end   >/dev/null 2>&1
        "
    fi
}

# --- modes -------------------------------------------------------------------
mode_check() {
    # give the site a fresh chance right away after a power cycle, then stay
    # quiet until the box (and the APs) have finished booting
    boot_heal
    [ "$(cut -d. -f1 /proc/uptime)" -lt "$BOOT_GRACE" ] && exit 0

    discover_aps

    if uplink_up; then
        setn upfail 0
        incn upok
        if [ -f "$STATE/cut_ports" ] && [ "$(getn upok)" -ge "$RECOVER_OK" ]; then
            restore_all_poe
        fi
        [ -f "$STATE/cut_ports" ] || check_aps
    else
        setn upok 0
        incn upfail
        log "uplink check failed ($(getn upfail)/$FAIL_LIMIT)"
        if [ "$(getn upfail)" -ge "$FAIL_LIMIT" ] && [ ! -f "$STATE/cut_ports" ]; then
            cut_all_poe
        fi
    fi
}

mode_weekly_ap_cycle() {
    local p
    log "weekly AP cycle starting"
    for p in $(managed_ports); do
        poe_cycle "$p"
        log "weekly cycle: $p done, waiting ${STAGGER_SECS}s"
        sleep "$STAGGER_SECS"
    done
    log "weekly AP cycle complete"
}

mode_weekly_reboot() {
    log "weekly scheduled reboot"
    sync
    if [ -x /opt/vyatta/bin/vyatta-op-cmd-wrapper ]; then
        /opt/vyatta/bin/vyatta-op-cmd-wrapper reboot now
    else
        /sbin/reboot
    fi
}

mode_status() {
    echo "== managed PoE ports (configured 'output 24v') =="
    managed_ports
    echo
    echo "== learned APs (port  mac  ip  last-seen) =="
    while read -r port mac ip seen; do
        printf '%-6s %-18s %-16s %s\n' "$port" "$mac" "$ip" \
            "$( [ -n "$seen" ] && date -d "@$seen" 2>/dev/null || echo '?' )"
    done < "$APMAP"
    echo
    echo "== raw MAC table as parsed (verify port numbers!) =="
    mac_table
    echo
    echo "uplink fail count : $(getn upfail)"
    echo "uplink ok count   : $(getn upok)"
    if [ -f "$STATE/cut_ports" ]; then
        echo "PoE CURRENTLY CUT on: $(tr '\n' ' ' < "$STATE/cut_ports")"
    else
        echo "PoE state: normal"
    fi
}

# --- entry -------------------------------------------------------------------
MODE="${1:-check}"

if [ "$MODE" != "status" ]; then
    exec 200> "$LOCK"
    flock -n 200 || { log "another instance is running, skipping ($MODE)"; exit 0; }
fi

case "$MODE" in
    check)           mode_check ;;
    weekly-ap-cycle) mode_weekly_ap_cycle ;;
    weekly-reboot)   mode_weekly_reboot ;;
    status)          mode_status ;;
    *) echo "usage: $0 {check|weekly-ap-cycle|weekly-reboot|status}"; exit 1 ;;
esac
