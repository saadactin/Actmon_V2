#!/usr/bin/env bash
# Build actmon-agent.rpm via rpmbuild (through WSL, or natively on RHEL/Fedora).
# On WSL Ubuntu install rpmbuild once:  wsl -u root apt-get install -y rpm
# Output: dist/actmon-agent.rpm
set -euo pipefail
if command -v rpmbuild >/dev/null 2>&1; then
  bash "$(cd "$(dirname "$0")" && pwd)/linux/rpm/build.sh"
else
  WINP="$(cd "$(dirname "$0")" && pwd -W)"
  MNT="/mnt/$(printf '%s' "$WINP" | sed -E 's#^([A-Za-z]):#\L\1#; s#\\#/#g')"
  MSYS_NO_PATHCONV=1 wsl bash "$MNT/linux/rpm/build.sh"
fi
