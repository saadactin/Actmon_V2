#!/usr/bin/env bash
# Builds actmon-agent.rpm. Runs inside WSL (needs the 'rpm' package) or natively
# on RHEL/Fedora. Self-locates: payload comes from ../common, spec from this folder.
# Output: Backend/agent/dist/actmon-agent.rpm
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"            # Backend/agent/linux/rpm
COMMON="$HERE/../common"
AGENT_ROOT="$(cd "$HERE/../.." && pwd)"          # Backend/agent
[ -f "$HERE/actmon-agent.spec" ]      || { echo "spec not found in $HERE"; exit 1; }
[ -f "$AGENT_ROOT/actmon_agent.py" ]  || { echo "actmon_agent.py not found in $AGENT_ROOT"; exit 1; }
[ -f "$COMMON/actmon-agent.service" ] || { echo "systemd unit not found in $COMMON"; exit 1; }
command -v rpmbuild >/dev/null 2>&1 || { echo "rpmbuild not found — install 'rpm' (apt) or 'rpm-build' (dnf)."; exit 3; }

TOP=/tmp/actmon-rpm-build
rm -rf "$TOP"; mkdir -p "$TOP/SOURCES" "$TOP/SPECS" "$TOP/BUILD" "$TOP/RPMS" "$TOP/SRPMS"
cp "$AGENT_ROOT/actmon_agent.py"   "$TOP/SOURCES/actmon_agent.py"
cp "$COMMON/actmon-agent.service"  "$TOP/SOURCES/actmon-agent.service"
cp "$HERE/actmon-agent.spec"       "$TOP/SPECS/actmon-agent.spec"
sed -i 's/\r$//' "$TOP/SOURCES/actmon-agent.service" "$TOP/SPECS/actmon-agent.spec"

rpmbuild -bb --define "_topdir $TOP" "$TOP/SPECS/actmon-agent.spec"
mkdir -p "$AGENT_ROOT/dist"
cp "$TOP"/RPMS/noarch/actmon-agent-*.rpm "$AGENT_ROOT/dist/actmon-agent.rpm"
echo "Built: $AGENT_ROOT/dist/actmon-agent.rpm"
rpm -qip "$AGENT_ROOT/dist/actmon-agent.rpm" 2>/dev/null | sed -n '1,12p' || true
