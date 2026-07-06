#!/usr/bin/env bash
# ActMon Host Agent (Linux). Runs the SAME collector bundle the SSH path runs and
# pushes the full snapshot to /agents/infra, so the Infrastructure detail UI renders
# identically whether the host is connected via SSH or via this agent.
# Reads ACTMON_ACCESS_TOKEN + ACTMON_URL from env (systemd EnvironmentFile).
# Works with curl OR wget — minimal Debian ships only wget, minimal RHEL only curl.
set -euo pipefail
: "${ACTMON_ACCESS_TOKEN:?ACTMON_ACCESS_TOKEN must be set}"
: "${ACTMON_URL:?ACTMON_URL must be set}"
INTERVAL="${ACTMON_INTERVAL:-30}"
echo "ActMon Agent starting on $(hostname) -> ${ACTMON_URL}"

# HTTP helpers — prefer curl, fall back to wget.
if command -v curl >/dev/null 2>&1; then
  http_get()  { curl -sS "$1"; }
  http_post() { curl -sS -X POST "$1" -H 'Content-Type: application/json' -d "$2" >/dev/null; }
elif command -v wget >/dev/null 2>&1; then
  http_get()  { wget -qO- "$1"; }
  http_post() { wget -qO /dev/null --header='Content-Type: application/json' --post-data="$2" "$1"; }
else
  echo "FATAL: neither curl nor wget is installed."; exit 1
fi

# Fetch the exact collector command the backend expects (no drift vs SSH).
BUNDLE=""
while [ -z "${BUNDLE}" ]; do
  BUNDLE="$(http_get "${ACTMON_URL}/agents/collector/linux" || true)"
  [ -z "${BUNDLE}" ] && { echo "cannot reach backend; retry in 10s"; sleep 10; }
done

while true; do
  raw="$(bash -c "${BUNDLE}" 2>/dev/null || true)"
  b64="$(printf '%s' "${raw}" | base64 | tr -d '\n')"
  http_post "${ACTMON_URL}/agents/infra" \
    "{\"token\":\"${ACTMON_ACCESS_TOKEN}\",\"os_type\":\"linux\",\"raw_b64\":\"${b64}\"}" \
    && echo "$(date +%H:%M:%S)  infra pushed" \
    || echo "$(date +%H:%M:%S)  push failed"
  sleep "${INTERVAL}"
done
