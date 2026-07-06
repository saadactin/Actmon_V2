# RPM spec for the ActMon Host Agent (RHEL/CentOS/Oracle Linux/Fedora/SUSE).
# Build:  rpmbuild -bb --define "_topdir <builddir>" actmon-agent.spec
# (see linux/rpm/build.sh — it stages sources and invokes rpmbuild)
Name:           actmon-agent
Version:        1.1.0
Release:        1%{?dist}
Summary:        ActMon Host Monitoring Agent
License:        Proprietary
BuildArch:      noarch
%global debug_package %{nil}

%description
Lightweight agent that collects host CPU/memory and full infrastructure metrics
and pushes them to the ActMon monitoring platform. Runs as a systemd service.
The installer accepts ACTMON_ACCESS_TOKEN / ACTMON_URL from the environment to
configure and start the service in one step.

%install
install -d -m 755 %{buildroot}/usr/lib/actmon
install -d -m 755 %{buildroot}/usr/lib/systemd/system
install -m 755 %{_sourcedir}/actmon-agent.sh %{buildroot}/usr/lib/actmon/actmon-agent.sh
install -m 644 %{_sourcedir}/actmon-agent.service %{buildroot}/usr/lib/systemd/system/actmon-agent.service

%files
/usr/lib/actmon/actmon-agent.sh
/usr/lib/systemd/system/actmon-agent.service

# $1 = 1 → fresh install, $1 = 2 → upgrade
%post
systemctl daemon-reload || true
# Accept token/url from the install command environment:
#   ACTMON_ACCESS_TOKEN=<tok> ACTMON_URL=<url> yum localinstall -y ./actmon-agent.rpm   (as root)
# An env-provided token ALWAYS wins: reinstalling with a new token must
# replace a stale/placeholder config, not silently keep it.
if [ -n "${ACTMON_ACCESS_TOKEN:-}" ]; then
    mkdir -p /etc/actmon
    printf 'ACTMON_ACCESS_TOKEN=%s\nACTMON_URL=%s\n' "$ACTMON_ACCESS_TOKEN" "${ACTMON_URL:-}" > /etc/actmon/agent.conf
    chmod 600 /etc/actmon/agent.conf
fi
if [ -f /etc/actmon/agent.conf ]; then
    systemctl enable --now actmon-agent.service || true
    systemctl restart actmon-agent.service || true
else
    echo "ActMon Agent installed. Create /etc/actmon/agent.conf with:"
    echo "  ACTMON_ACCESS_TOKEN=<token>"
    echo "  ACTMON_URL=<url>"
    echo "then run: systemctl enable --now actmon-agent"
fi

# $1 = 0 → erase, $1 = 1 → upgrade (new package already installed)
%preun
if [ "$1" = "0" ]; then
    systemctl disable --now actmon-agent.service || true
fi

%postun
systemctl daemon-reload || true
if [ "$1" = "0" ]; then
    rm -rf /etc/actmon || true
fi
