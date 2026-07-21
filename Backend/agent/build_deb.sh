#!/usr/bin/env bash
# Build actmon-agent.deb via WSL's dpkg-deb. Run from anywhere.
# Invokes linux/deb/build.sh by absolute /mnt path (MSYS path-conversion disabled).
# Output: dist/actmon-agent.deb
set -euo pipefail
WINP="$(cd "$(dirname "$0")" && pwd -W)"                         # E:/ACTMON V1/Backend/agent
MNT="/mnt/$(printf '%s' "$WINP" | sed -E 's#^([A-Za-z]):#\L\1#; s#\\#/#g')"
MSYS_NO_PATHCONV=1 wsl bash "$MNT/linux/deb/build.sh"
