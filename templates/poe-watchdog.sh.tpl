#!/bin/bash
#
# MANAGED BY poe-watchdog-portal -- local edits will be overwritten on next deploy
# rendered for: {{DEVICE_NAME}} ({{DEVICE_IP}}) at {{RENDERED_AT}}
#
# poe-watchdog.sh -- Dynamic PoE watchdog for EdgeRouter X SFP (EdgeOS)
#
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
#
# What "check" does:
#   1. Discovers which PoE ports have a Ubiquiti AP behind them (MAC table
#      OUI match) and remembers port -> MAC -> IP in /config/user-data. Only
#      ports carrying a whitelisted UniFi AP MAC are managed when ALLOWED_MACS is set.
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

EXCLUDE_PORTS="{{EXCLUDE_PORTS}}" # space-separated, e.g. "eth4" - never touch these

# Backhaul radio MACs (airMAX/Wave/PtP, from UISP via the portal). Any port
# where one of these is ever seen is permanently off-limits: never cut,
# never cycled. Refreshed on every portal sync + deploy.
PROTECTED_MACS="{{PROTECTED_MACS}}"

# UniFi access-point MACs (from the UniFi controller via the portal). This is a
# strict whitelist: a PoE port is only ever monitored or cycled once one of
# these MACs has been seen on it (learned persistently). Empty = nothing is
# managed.
ALLOWED_MACS="{{ALLOWED_MACS}}"

# ---------------------------------------------------------------------------
#                     internals - no need to edit below
# ---------------------------------------------------------------------------

CFGWRAP=/opt/vyatta/sbin/vyatta-cfg-cmd-wrapper
STATE=${STATE:-/var/run/poe-watchdog}             # tmpfs: counters, cleared on reboot
PERSIST=${PERSIST:-/config/user-data/poe-watchdog}  # survives reboot & fw upgrade
CONFIG_BOOT=${CONFIG_BOOT:-/config/config.boot}
APMAP="$PERSIST/ap-map"                 # lines: ethX mac ip epoch-lastseen
STATICMAP="$PERSIST/static-map"         # optional manual lines: ethX mac
PORTEVENTS="$PERSIST/port-events"       # ethN action history: epoch port action reason source
SYSNET=${SYSNET:-/sys/class/net}        # overridable for tests
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

# Persist the running config to config.boot. Guarded by callers so it never
# runs while the watchdog has PoE cut.
poe_save() {
    sg vyattacfg -c "$CFGWRAP begin; $CFGWRAP save; $CFGWRAP end" >/dev/null 2>&1
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

# --- uplink port auto-protection ---------------------------------------------
# The port through which we reach GATEWAY_IP must NEVER be cut — cutting it
# would sever this device's own uplink (e.g. a Wave/airMAX backhaul radio
# powered by our PoE) and lock the site out. Detected via the gateway's MAC in
# the switch table and cached persistently so it survives outages and reboots.
detect_uplink_port() {
    local gwmac p
    gwmac=$(ip neigh show 2>/dev/null | awk -v g="$GATEWAY_IP" '$1 == g { print tolower($5); exit }')
    if [ -n "$gwmac" ]; then
        p=$(mac_table | awk -v m="$gwmac" '$2 == m { print $1; exit }')
        [ -n "$p" ] && echo "$p" > "$PERSIST/uplink-port"
    fi
    cat "$PERSIST/uplink-port" 2>/dev/null
}

# --- protected ports: backhaul radios are off-limits, always -----------------
# A port is protected the moment a PROTECTED_MACS entry is seen on it, and
# stays protected forever (persistent, additive) — even while the radio is
# dark and its MAC absent from the table.
detect_protected_ports() {
    local m p tbl
    tbl=$(mac_table)
    for m in $PROTECTED_MACS; do
        p=$(echo "$tbl" | awk -v m="$m" '$2 == m { print $1; exit }')
        if [ -n "$p" ] && ! grep -qx "$p" "$PERSIST/protected-ports" 2>/dev/null; then
            echo "$p" >> "$PERSIST/protected-ports"
            log "port $p carries backhaul radio $m -> permanently protected"
        fi
    done
    sort -u "$PERSIST/protected-ports" 2>/dev/null | tr '\n' ' '
}

# --- allowed ports: the UniFi AP whitelist ------------------------------------
# Mirror of detect_protected_ports: a port joins the allowed set the moment an
# ALLOWED_MACS entry (or a static-map entry) is seen on it, and stays allowed
# (persistent, additive). Only consulted when ALLOWED_MACS is non-empty.
detect_allowed_ports() {
    local m p tbl
    [ -n "$ALLOWED_MACS" ] || return 0
    tbl=$(mac_table)
    [ -f "$STATICMAP" ] && tbl="$tbl
$(cat "$STATICMAP")"
    for m in $ALLOWED_MACS; do
        p=$(echo "$tbl" | awk -v m="$m" '$2 == m { print $1; exit }')
        if [ -n "$p" ] && ! grep -qx "$p" "$PERSIST/allowed-ports" 2>/dev/null; then
            echo "$p" >> "$PERSIST/allowed-ports"
            log "port $p carries whitelisted AP $m -> allowed for monitoring"
        fi
    done
    sort -u "$PERSIST/allowed-ports" 2>/dev/null | tr '\n' ' '
}

# --- which ports are we allowed to manage? ----------------------------------
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
        mac=$(echo "$tbl" | awk -v p="$port" '$1 == p { print $2; exit }')
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
        log_event "$p" cut "uplink down" watchdog
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
        log_event "$p" restore "uplink up" watchdog
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
                log_event "$port" cycle "AP unreachable" watchdog
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
            [ -f "$PERSIST/manual-off/$p" ] && continue
            poe_set "$p" 24v
            healed=1
        done < "$PERSIST/cut_ports"
        rm -f "$PERSIST/cut_ports"
    fi
    for f in "$PERSIST"/cycling.*; do
        [ -f "$f" ] || continue
        p="$(basename "$f" | cut -d. -f2)"
        if [ -f "$PERSIST/manual-off/$p" ]; then
            rm -f "$f"
            continue
        fi
        poe_set "$p" 24v
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

mode_apmap() {
    cat "$APMAP"
}

mode_ports() {
    local p dir carrier speed mac rxb txb rxe txe lastEpoch lastAction
    local managed=" $(managed_ports | tr '\n' ' ') "
    local tbl; tbl=$(mac_table)
    for dir in $(ls -d "$SYSNET"/eth* 2>/dev/null | sort -t h -k2 -n); do
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
        lastEpoch=$(awk -v pp="$p" '$2 == pp { e=$1 } END { print (e ? e : "-") }' "$PORTEVENTS" 2>/dev/null)
        lastAction=$(awk -v pp="$p" '$2 == pp { a=$3 } END { print (a ? a : "-") }' "$PORTEVENTS" 2>/dev/null)
        [ -n "$lastEpoch" ] || lastEpoch="-"
        [ -n "$lastAction" ] || lastAction="-"
        printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
            "$p" "$carrier" "$speed" "$(poe_cfg "$p")" "$(poe_live "$p")" "$mac" \
            "$rxb" "$txb" "$rxe" "$txe" "$(port_flags "$p" "$managed")" "$lastEpoch" "$lastAction"
    done
}

mode_port_events() {  # [ethN]
    [ -f "$PORTEVENTS" ] || return 0
    if [ -n "${1:-}" ]; then awk -v pp="$1" '$2 == pp' "$PORTEVENTS"; else cat "$PORTEVENTS"; fi
}

mode_cycle_mac() {  # cycle-mac aa:bb:cc:dd:ee:ff
    local mac p
    mac=$(echo "${1:-}" | tr 'A-Z' 'a-z')
    [ -n "$mac" ] || { echo "usage: $0 cycle-mac <mac>"; exit 1; }
    p=$(awk -v m="$mac" '$2 == m { print $1; exit }' "$APMAP")
    [ -n "$p" ] || p=$(mac_table | awk -v m="$mac" '$2 == m { print $1; exit }')
    if [ -z "$p" ]; then echo "unknown mac $mac"; exit 2; fi
    case " $(managed_ports | tr '\n' ' ') " in
        *" $p "*) ;;
        *) echo "port $p not managed"; exit 3 ;;
    esac
    log "portal requested PoE cycle of $p ($mac)"
    poe_cycle "$p"
    echo "cycled $p"
}

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
    echo "== never touched =="
    echo "uplink port     : ${UPLINK_PORT:-unknown}"
    echo "protected ports : ${PROTECTED_PORTS:-none} (backhaul radios)"
    echo "excluded ports  : ${EXCLUDE_PORTS:-none} (manual)"
    if [ -n "$ALLOWED_MACS" ]; then
        echo "whitelist       : $(echo $ALLOWED_MACS | wc -w) allowed MACs, allowed ports: ${ALLOWED_PORTS:-none yet}"
    else
        echo "whitelist       : none (nothing managed)"
    fi
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
# POE_WATCHDOG_LIB=1 lets tests source the functions without running anything.
if [ "${POE_WATCHDOG_LIB:-0}" != "1" ]; then
    MODE="${1:-check}"

    # resolve the port sets once per run (functions need mac_table)
    UPLINK_PORT="$(detect_uplink_port)"
    PROTECTED_PORTS="$(detect_protected_ports)"
    ALLOWED_PORTS="$(detect_allowed_ports)"

    case "$MODE" in
        status|apmap|ports|port-events) ;;   # read-only, no lock
        cycle-mac|cycle-port|poe-set)
            exec 200> "$LOCK"
            flock -w 90 200 || { echo "busy"; exit 4; } ;;
        *)
            exec 200> "$LOCK"
            flock -n 200 || { log "another instance is running, skipping ($MODE)"; exit 0; } ;;
    esac

    case "$MODE" in
        check)         mode_check ;;
        weekly-reboot) mode_weekly_reboot ;;
        status)        mode_status ;;
        apmap)         mode_apmap ;;
        ports)         mode_ports ;;
        port-events)   mode_port_events "${2:-}" ;;
        cycle-mac)     mode_cycle_mac "${2:-}" ;;
        cycle-port)    mode_cycle_port "${2:-}" ;;
        poe-set)       mode_poe_set "${2:-}" "${3:-}" ;;
        *) echo "usage: $0 {check|weekly-reboot|status|apmap|ports|port-events [ethN]|cycle-mac <mac>|cycle-port <ethN>|poe-set <ethN> off|24v}"; exit 1 ;;
    esac
fi
