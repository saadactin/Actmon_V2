#!/usr/bin/env bash
# Builds actmon-agent.deb. Runs inside WSL (or any Linux with dpkg-deb).
# Self-locates: payload comes from ../common, package metadata from this folder.
# Stages in /tmp (native ext4 so file modes stick) → output: Backend/agent/dist/actmon-agent.deb
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"            # Backend/agent/linux/deb
COMMON="$HERE/../common"
AGENT_ROOT="$(cd "$HERE/../.." && pwd)"          # Backend/agent
[ -f "$HERE/control" ]                    || { echo "control not found in $HERE"; exit 1; }
[ -f "$AGENT_ROOT/actmon_agent.py" ]      || { echo "actmon_agent.py not found in $AGENT_ROOT"; exit 1; }
[ -f "$COMMON/actmon-agent.service" ]     || { echo "systemd unit not found in $COMMON"; exit 1; }

STAGE="/tmp/actmon-deb-build"
rm -rf "$STAGE"
mkdir -p "$STAGE/pkg/DEBIAN" "$STAGE/pkg/usr/lib/actmon" "$STAGE/pkg/lib/systemd/system"

cp "$HERE/control"                  "$STAGE/pkg/DEBIAN/control"
cp "$HERE/postinst"                 "$STAGE/pkg/DEBIAN/postinst"
cp "$HERE/prerm"                    "$STAGE/pkg/DEBIAN/prerm"
cp "$HERE/postrm"                   "$STAGE/pkg/DEBIAN/postrm"
cp "$COMMON/actmon-agent.service"   "$STAGE/pkg/lib/systemd/system/actmon-agent.service"
cp "$AGENT_ROOT/actmon_agent.py"    "$STAGE/pkg/usr/lib/actmon/actmon_agent.py"
# keep the legacy shell agent too (harmless; the collector still runs via bash)
[ -f "$COMMON/actmon-agent.sh" ] && cp "$COMMON/actmon-agent.sh" "$STAGE/pkg/usr/lib/actmon/actmon-agent.sh"

# Normalise Windows line endings and set package-correct modes.
find "$STAGE/pkg" -type f -exec sed -i 's/\r$//' {} +
chmod 0755 "$STAGE/pkg/DEBIAN/postinst" "$STAGE/pkg/DEBIAN/prerm" "$STAGE/pkg/DEBIAN/postrm"
chmod 0644 "$STAGE/pkg/usr/lib/actmon/actmon_agent.py"
chmod 0644 "$STAGE/pkg/DEBIAN/control" "$STAGE/pkg/lib/systemd/system/actmon-agent.service"

/usr/bin/dpkg-deb --root-owner-group --build "$STAGE/pkg" "$STAGE/actmon-agent.deb"
mkdir -p "$AGENT_ROOT/dist"
cp "$STAGE/actmon-agent.deb" "$AGENT_ROOT/dist/actmon-agent.deb"
echo "Built: $AGENT_ROOT/dist/actmon-agent.deb"
/usr/bin/dpkg-deb --info "$STAGE/actmon-agent.deb" | sed -n '1,16p'
