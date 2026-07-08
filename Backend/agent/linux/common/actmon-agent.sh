#!/usr/bin/env bash
# ActMon Host Agent (Linux). Runs the SAME collector bundle the SSH path runs and
# pushes the full snapshot to /agents/infra, so the Infrastructure detail UI renders
# identically whether the host is connected via SSH or via this agent.
# Reads ACTMON_ACCESS_TOKEN + ACTMON_URL from env (systemd EnvironmentFile).
# Works with curl OR wget — minimal Debian ships only wget, minimal RHEL only curl.
#
# Besides the 30s infra push, the idle window LONG-POLLS /agents/fs-poll for
# file-browse jobs (Storage → File Explorer in the UI) and answers them locally —
# interactive browsing with no SSH needed. Job line format: "id|op|base64(path)".
set -euo pipefail
: "${ACTMON_ACCESS_TOKEN:?ACTMON_ACCESS_TOKEN must be set}"
: "${ACTMON_URL:?ACTMON_URL must be set}"
INTERVAL="${ACTMON_INTERVAL:-30}"
SELF="${BASH_SOURCE[0]:-$0}"   # own path — used for self-update re-exec
echo "ActMon Agent starting on $(hostname) -> ${ACTMON_URL}"

# HTTP helpers — prefer curl, fall back to wget.
if command -v curl >/dev/null 2>&1; then
  http_get()  { curl -sS -m "${2:-30}" "$1"; }
  http_post() { curl -sS -X POST "$1" -H 'Content-Type: application/json' -d "$2" >/dev/null; }
elif command -v wget >/dev/null 2>&1; then
  http_get()  { wget -qO- -T "${2:-30}" "$1"; }
  http_post() { wget -qO /dev/null --header='Content-Type: application/json' --post-data="$2" "$1"; }
else
  echo "FATAL: neither curl nor wget is installed."; exit 1
fi

# Self-update: pull the canonical agent from the backend; if it changed, replace
# this file and re-exec. New features (ops, collector tweaks) roll out with NO
# reinstall — you install once and the agent keeps itself current. systemd's
# Restart=always plus exec-in-place means no service bounce is needed.
self_update() {
  case "$SELF" in /*) : ;; *) return 0 ;; esac      # only when launched by an absolute path
  [ -w "$SELF" ] || return 0
  local latest tmp
  latest="$(http_get "${ACTMON_URL}/agents/install/actmon-agent.sh" 20 2>/dev/null || true)"
  [ "${#latest}" -lt 400 ] && return 0              # failed / suspiciously small → skip
  case "$latest" in "#!"*bash*|"#!"*sh*) : ;; *) return 0 ;; esac   # must be a shell script
  tmp="${SELF}.new"
  printf '%s' "$latest" > "$tmp" 2>/dev/null || return 0
  if cmp -s "$tmp" "$SELF"; then rm -f "$tmp"; return 0; fi   # unchanged
  chmod 755 "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$SELF" 2>/dev/null || { rm -f "$tmp"; return 0; }
  echo "$(date +%H:%M:%S)  agent self-updated — re-exec"
  exec /bin/bash "$SELF"
}

# Ensure the ActMon nftables table/chain exists (separate from system rules).
fw_ensure() {
  nft list table inet actmon >/dev/null 2>&1 || {
    nft add table inet actmon
    nft 'add chain inet actmon input { type filter hook input priority -10; policy accept; }'
  }
}

# Answer one host job: run the op locally, push output back base64-encoded.
# Ops: list/read/write (file explorer) · netcfg (IP config) · fwctl (allow/block IPs) · svcctl (restart/reboot).
handle_fs_job() {
  local id="$1" op="$2" path_b64="$3" data_b64="$4" path data out
  path="$(printf '%s' "$path_b64" | base64 -d 2>/dev/null || true)"
  data="$(printf '%s' "$data_b64" | base64 -d 2>/dev/null || true)"
  case "$op" in
    list) out="$(ls -lAH --time-style=long-iso -- "$path" 2>&1 || true)" ;;
    read) out="$(printf 'SIZE:%s\n' "$(stat -Lc %s -- "$path" 2>/dev/null || echo -1)"; head -c 65536 -- "$path" 2>/dev/null || true)" ;;
    write)
      # Save a backup, then overwrite the file with the provided content.
      if [ -f "$path" ]; then cp -p -- "$path" "${path}.actmon.bak" 2>/dev/null || true; fi
      if printf '%s' "$data" > "$path" 2>/tmp/actmon_write_err; then out="OK:$(stat -Lc %s -- "$path" 2>/dev/null || echo 0)"
      else out="ERR:$(cat /tmp/actmon_write_err 2>/dev/null)"; fi ;;
    netcfg)
      out="$(ip -o link 2>&1; echo '---ADDR---'; ip -o addr 2>&1; echo '---ROUTES---'; ip route 2>&1; echo '---DNS---'; grep -E '^(nameserver|search)' /etc/resolv.conf 2>/dev/null || true)" ;;
    netfiles)
      # Which network config files exist + which networking service is active.
      # Trailing 'true' keeps the subshell exit 0 (set -e would otherwise kill the job
      # when the last systemctl is-active returns non-zero).
      out="$(for f in /etc/network/interfaces /etc/network/interfaces.d/* \
                       /etc/netplan/*.yaml /etc/netplan/*.yml /etc/resolv.conf /etc/hosts /etc/hostname \
                       /etc/systemd/network/*.network /etc/nsswitch.conf /etc/hosts.allow /etc/hosts.deny \
                       /etc/dhcp/dhclient.conf /etc/sysconfig/network \
                       /etc/sysconfig/network-scripts/ifcfg-* /etc/NetworkManager/system-connections/*; do
                [ -e "$f" ] && echo "FILE:$f"; done 2>/dev/null
             for u in networking systemd-networkd NetworkManager systemd-resolved; do systemctl is-active "$u" >/dev/null 2>&1 && echo "UNIT:$u"; done
             true)" ;;
    fwctl)
      local verb a1 a2
      IFS=':' read -r verb a1 a2 <<< "$path"
      case "$verb" in
        add) fw_ensure
             if [ "$a1" = "allow" ]; then nft insert rule inet actmon input ip saddr "$a2" accept 2>&1 || true
             else nft add rule inet actmon input ip saddr "$a2" drop 2>&1 || true; fi ;;
        del) nft delete rule inet actmon input handle "$a1" 2>&1 || true ;;
      esac
      out="$(nft -a list chain inet actmon input 2>&1 || echo 'NOCHAIN')" ;;
    svcctl)
      # arg: "services" | "start|stop|restart:<unit>" | "reboot"
      local verb unit
      IFS=':' read -r verb unit <<< "$path"
      case "$verb" in
        services) out="$(systemctl list-units --type=service --all --no-legend --no-pager 2>/dev/null | awk 'NR<=400{name=$1; st=$3; d=""; for(i=5;i<=NF;i++) d=d $i " "; print name"|"st"|"d}' || true)" ;;
        start|stop|restart)
                  if systemctl "$verb" "$unit" 2>/tmp/actmon_svc_err; then out="OK:${verb}ed $unit; $(systemctl is-active "$unit" 2>/dev/null)"
                  else out="ERR:$(cat /tmp/actmon_svc_err 2>/dev/null)"; fi ;;
        reboot)   http_post "${ACTMON_URL}/agents/fs-result" "{\"token\":\"${ACTMON_ACCESS_TOKEN}\",\"id\":\"${id}\",\"data_b64\":\"$(printf 'OK:rebooting' | base64 | tr -d '\n')\"}" || true
                  (sleep 2; systemctl reboot) >/dev/null 2>&1 &
                  return ;;
        *)        out="unsupported svcctl verb: $verb" ;;
      esac ;;
    killproc)
      # arg: the PID to force-kill.
      case "$path" in
        *[!0-9]*|"") out="ERR:invalid pid" ;;
        *) if kill -9 "$path" 2>/tmp/actmon_kill_err; then out="OK:killed $path"
           else out="ERR:$(cat /tmp/actmon_kill_err 2>/dev/null)"; fi ;;
      esac ;;
    diag)
      # arg: "ping:<host>" | "port:<host>:<port>" | "dns:<host>"
      local dverb dhost dport
      IFS=':' read -r dverb dhost dport <<< "$path"
      case "$dverb" in
        ping) out="$(ping -c 4 -W 2 "$dhost" 2>&1 || true)" ;;
        port) if command -v nc >/dev/null 2>&1; then out="$(nc -zv -w 3 "$dhost" "$dport" 2>&1 || true)"
              else out="$(timeout 3 bash -c "echo > /dev/tcp/${dhost}/${dport}" 2>/dev/null && echo "OPEN ${dhost}:${dport}" || echo "CLOSED ${dhost}:${dport}")"; fi ;;
        dns)  out="$(getent hosts "$dhost" 2>/dev/null || nslookup "$dhost" 2>&1 || true)" ;;
        *)    out="unsupported diag: $dverb" ;;
      esac ;;
    *)    out="unsupported op: $op" ;;
  esac
  local b64
  b64="$(printf '%s' "$out" | base64 | tr -d '\n')"
  http_post "${ACTMON_URL}/agents/fs-result" \
    "{\"token\":\"${ACTMON_ACCESS_TOKEN}\",\"id\":\"${id}\",\"data_b64\":\"${b64}\"}" || true
}

# Long-poll for jobs until the next infra push is due.
poll_fs_until() {
  local until_ts="$1" now jobs line
  while :; do
    now="$(date +%s)"
    [ "$now" -ge "$until_ts" ] && break
    jobs="$(http_get "${ACTMON_URL}/agents/fs-poll?token=${ACTMON_ACCESS_TOKEN}&hold=12" 20 2>/dev/null || true)"
    [ -z "$jobs" ] && continue
    while IFS='|' read -r id op path_b64 data_b64; do
      [ -n "$id" ] && handle_fs_job "$id" "$op" "$path_b64" "$data_b64"
    done <<< "$jobs"
  done
}

# Fetch the exact collector command the backend expects (no drift vs SSH).
BUNDLE=""
while [ -z "${BUNDLE}" ]; do
  BUNDLE="$(http_get "${ACTMON_URL}/agents/collector/linux" || true)"
  [ -z "${BUNDLE}" ] && { echo "cannot reach backend; retry in 10s"; sleep 10; }
done

while true; do
  # Re-fetch the collector each cycle so backend collector changes apply WITHOUT
  # a restart (keep the previous bundle if the fetch fails).
  nb="$(http_get "${ACTMON_URL}/agents/collector/linux" 20 2>/dev/null || true)"
  [ -n "${nb}" ] && BUNDLE="${nb}"
  raw="$(bash -c "${BUNDLE}" 2>/dev/null || true)"
  b64="$(printf '%s' "${raw}" | base64 | tr -d '\n')"
  http_post "${ACTMON_URL}/agents/infra" \
    "{\"token\":\"${ACTMON_ACCESS_TOKEN}\",\"os_type\":\"linux\",\"raw_b64\":\"${b64}\"}" \
    && echo "$(date +%H:%M:%S)  infra pushed" \
    || echo "$(date +%H:%M:%S)  push failed"
  # Keep the agent current (re-execs if the backend has a newer build).
  self_update || true
  # Spend the wait window answering file-browse jobs instead of sleeping.
  poll_fs_until "$(( $(date +%s) + INTERVAL ))"
done
