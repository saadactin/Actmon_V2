"""
Host network configuration + firewall IP allow/block, over the agent channel
(SSH fallback for SSH-registered hosts). Linux only (nftables 'inet actmon' table).

  svc_net_config  → parse `ip link/addr`, routes, DNS into structured JSON
  svc_fw_list     → current ActMon allow/deny rules (with nft handles for delete)
  svc_fw_add      → allow or deny a source IP / CIDR
  svc_fw_del      → remove a rule by its nft handle
"""
import ipaddress
import re
import shlex

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.os_server_model import OsServer
from app.services.agent import agent_fs_service
from app.services.os_server.fs_browse_service import _resolve_ssh, _ssh_output


def _get(server_id: int, db: Session) -> OsServer:
    srv = db.query(OsServer).filter(OsServer.id == server_id).first()
    if not srv:
        raise HTTPException(status_code=404, detail="Server not found")
    # Windows is supported through the agent channel; only reject Windows with no agent.
    if (srv.os_type or "").lower().startswith("win") and (srv.collector or "") != "agent":
        raise HTTPException(status_code=400, detail="Editing network config & firewall runs through the ActMon agent. This Windows host has no agent — install it to enable these actions.")
    return srv


def _is_win(srv: OsServer) -> bool:
    return (srv.os_type or "").lower().startswith("win")


def _valid_ip(v: str) -> str:
    """Accept a plain IP or CIDR; reject anything else (this reaches a shell)."""
    v = (v or "").strip()
    try:
        if "/" in v:
            ipaddress.ip_network(v, strict=False)
        else:
            ipaddress.ip_address(v)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"'{v}' is not a valid IP address or CIDR.")
    return v


# op → (agent op, agent arg, ssh command)
def _run(srv: OsServer, db: Session, agent_op: str, agent_arg: str, ssh_cmd: str) -> str:
    is_agent = (srv.collector or "") == "agent" and srv.agent_token
    if is_agent:
        raw = agent_fs_service.request(srv.agent_token, agent_op, agent_arg)
        if raw is not None:
            return raw.decode("utf-8", errors="replace")
        if _resolve_ssh(srv, db):
            return _ssh_output(srv, db, ssh_cmd).decode("utf-8", errors="replace")
        raise HTTPException(status_code=504, detail="This host's agent is an older build that doesn't support live network configuration yet. Update it once (re-run the installer, or `sudo systemctl restart actmon-agent`) — newer agents self-update automatically.")
    if _resolve_ssh(srv, db):
        return _ssh_output(srv, db, ssh_cmd).decode("utf-8", errors="replace")
    raise HTTPException(status_code=400, detail="This host has no agent and no SSH credentials configured.")


# ── IP configuration ────────────────────────────────────────────────────────
_NETCFG_SSH = ("ip -o link; echo '---ADDR---'; ip -o addr; echo '---ROUTES---'; ip route; "
               "echo '---DNS---'; grep -E '^(nameserver|search)' /etc/resolv.conf 2>/dev/null || true")


def _win_netcfg_from_snapshot(srv: OsServer) -> dict:
    """Windows hosts have no interactive net channel, but the agent's infra snapshot
    already carries interfaces/gateway/DNS/routes — serve IP configuration from it."""
    import json
    if not srv.last_infra_json:
        raise HTTPException(status_code=503, detail="Waiting for the agent to report network configuration — ensure it is running.")
    try:
        d = json.loads(srv.last_infra_json)
    except (ValueError, TypeError):
        raise HTTPException(status_code=500, detail="Stored snapshot is unreadable.")
    def _as_list(v):
        if v is None:
            return []
        return v if isinstance(v, list) else [v]

    ifaces = [{"iface": i.get("iface"), "state": i.get("state", "?"), "mac": i.get("mac"),
               "addresses": _as_list(i.get("addresses"))} for i in _as_list(d.get("interfaces"))]
    dns = d.get("dns") if isinstance(d.get("dns"), dict) else {}
    return {
        "interfaces": ifaces,
        "routes": _as_list(d.get("routes")),
        "gateway": d.get("gateway"),
        "dns": {"nameservers": _as_list(dns.get("nameservers")), "search": dns.get("search")},
        "source": "agent snapshot",
    }


def svc_net_config(server_id: int, db: Session) -> dict:
    srv = db.query(OsServer).filter(OsServer.id == server_id).first()
    if not srv:
        raise HTTPException(status_code=404, detail="Server not found")
    if (srv.os_type or "").lower().startswith("win"):
        return _win_netcfg_from_snapshot(srv)
    raw = _run(srv, db, "netcfg", "", _NETCFG_SSH)
    link_part, _, rest = raw.partition("---ADDR---")
    addr_part, _, rest2 = rest.partition("---ROUTES---")
    route_part, _, dns_part = rest2.partition("---DNS---")

    # interfaces: name → {state, mac, addresses[]}
    ifaces: dict[str, dict] = {}
    for ln in link_part.splitlines():
        m = re.search(r"^\d+:\s+([^:@]+).*?state\s+(\w+)", ln)
        if m:
            name = m.group(1).strip()
            mac = re.search(r"link/\w+\s+([0-9a-f:]{17})", ln)
            ifaces[name] = {"iface": name, "state": m.group(2), "mac": mac.group(1) if mac else None, "addresses": []}
    for ln in addr_part.splitlines():
        m = re.search(r"^\d+:\s+(\S+)\s+inet6?\s+(\S+)", ln)
        if m:
            ifaces.setdefault(m.group(1), {"iface": m.group(1), "state": "?", "mac": None, "addresses": []})
            ifaces[m.group(1)]["addresses"].append(m.group(2))

    routes = [r.strip() for r in route_part.splitlines() if r.strip()]
    gateway = next((r.split()[2] for r in routes if r.startswith("default") and "via" in r), None)
    nameservers = [l.split()[1] for l in dns_part.splitlines() if l.startswith("nameserver") and len(l.split()) > 1]
    search = next((" ".join(l.split()[1:]) for l in dns_part.splitlines() if l.startswith("search")), None)

    return {
        "interfaces": list(ifaces.values()),
        "routes": routes,
        "gateway": gateway,
        "dns": {"nameservers": nameservers, "search": search},
        "source": "agent" if (srv.collector or "") == "agent" else "ssh",
    }


_NETFILES_SSH = (
    "for f in /etc/network/interfaces /etc/network/interfaces.d/* "
    "/etc/netplan/*.yaml /etc/netplan/*.yml /etc/resolv.conf /etc/hosts /etc/hostname "
    "/etc/systemd/network/*.network /etc/nsswitch.conf /etc/hosts.allow /etc/hosts.deny "
    "/etc/dhcp/dhclient.conf /etc/sysconfig/network "
    "/etc/sysconfig/network-scripts/ifcfg-* /etc/NetworkManager/system-connections/*; do "
    "[ -e \"$f\" ] && echo FILE:$f; done 2>/dev/null; "
    "for u in networking systemd-networkd NetworkManager systemd-resolved; do "
    "systemctl is-active $u >/dev/null 2>&1 && echo UNIT:$u; done"
)

# Human labels for known network config files.
_FILE_LABELS = {
    "/etc/network/interfaces": "Interfaces (ifupdown)",
    "/etc/resolv.conf": "DNS resolver (resolv.conf)",
    "/etc/hosts": "Static hosts",
    "/etc/hostname": "Hostname",
    "/etc/nsswitch.conf": "Name service switch",
    "/etc/hosts.allow": "TCP wrappers — allow",
    "/etc/hosts.deny": "TCP wrappers — deny",
    "/etc/dhcp/dhclient.conf": "DHCP client",
    "/etc/sysconfig/network": "Network (sysconfig)",
    r"C:\Windows\System32\drivers\etc\hosts": "Hosts file",
    r"C:\Windows\System32\drivers\etc\lmhosts.sam": "LMHOSTS (sample)",
    r"C:\Windows\System32\drivers\etc\networks": "Networks",
    r"C:\Windows\System32\drivers\etc\protocol": "Protocols",
    r"C:\Windows\System32\drivers\etc\services": "Services (ports)",
}


def _label_for(p: str) -> str:
    """A human label for a config file path (handles the wildcard families)."""
    lbl = _FILE_LABELS.get(p)
    if lbl:
        return lbl
    low = p.lower()
    base = p.rsplit("\\", 1)[-1] if "\\" in p else p.rsplit("/", 1)[-1]
    if "netplan" in low:
        return f"Netplan ({base})"
    if p.endswith(".network"):
        return f"systemd-networkd ({base})"
    if "network-scripts/ifcfg-" in low:
        return f"Interface {p.rsplit('ifcfg-', 1)[-1]}"
    if "networkmanager/system-connections" in low:
        return f"NetworkManager: {base}"
    if "interfaces.d" in low:
        return f"interfaces.d: {base}"
    return base


def svc_net_files(server_id: int, db: Session) -> dict:
    """Detect editable network config files + which networking service is active."""
    srv = _get(server_id, db)
    win = _is_win(srv)
    raw = _run(srv, db, "netfiles", "", _NETFILES_SSH)
    files, units, seen = [], [], set()
    for ln in raw.splitlines():
        ln = ln.strip()
        if ln.startswith("FILE:"):
            p = ln[5:]
            if p in seen:
                continue
            seen.add(p)
            files.append({"path": p, "label": _label_for(p)})
        elif ln.startswith("UNIT:"):
            # Windows service names are used as-is; Linux systemd units get a .service suffix.
            units.append(ln[5:] if win else ln[5:] + ".service")
    return {"files": files, "net_units": units,
            "source": "agent" if (srv.collector or "") == "agent" else "ssh"}


# ── Firewall (nftables inet actmon) ──────────────────────────────────────────
_FW_LIST_SSH = "nft -a list chain inet actmon input 2>&1 || echo NOCHAIN"


def _parse_fw(raw: str) -> list[dict]:
    rules = []
    for ln in raw.splitlines():
        m = re.search(r"ip saddr\s+(\S+)\s+(accept|drop).*handle\s+(\d+)", ln)
        if m:
            rules.append({"ip": m.group(1), "action": "allow" if m.group(2) == "accept" else "block",
                          "handle": m.group(3)})
    return rules


def _parse_fw_win(raw: str) -> list[dict]:
    """Windows agent emits 'WINFW|<display name>|<Allow|Block>|<remote ip>' per rule.
    The rule's display name doubles as its delete handle."""
    rules = []
    for ln in raw.splitlines():
        if not ln.startswith("WINFW|"):
            continue
        parts = ln.split("|", 3)
        if len(parts) >= 4:
            _, name, act, ip = parts
            rules.append({"ip": (ip or "Any").strip(),
                          "action": "allow" if act.strip().lower() == "allow" else "block",
                          "handle": name.strip()})
    return rules


def _fw_parse(srv: OsServer, raw: str) -> list[dict]:
    return _parse_fw_win(raw) if _is_win(srv) else _parse_fw(raw)


def svc_fw_list(server_id: int, db: Session) -> dict:
    srv = _get(server_id, db)
    raw = _run(srv, db, "fwctl", "list", _FW_LIST_SSH)
    return {
        "configured": True if _is_win(srv) else ("NOCHAIN" not in raw),
        "rules": _fw_parse(srv, raw),
        "source": "agent" if (srv.collector or "") == "agent" else "ssh",
    }


def svc_fw_add(server_id: int, ip: str, action: str, db: Session) -> dict:
    srv = _get(server_id, db)
    ip = _valid_ip(ip)
    if action not in ("allow", "block"):
        raise HTTPException(status_code=400, detail="action must be 'allow' or 'block'.")
    verb = "accept" if action == "allow" else "drop"
    pos = "insert" if action == "allow" else "add"   # allow wins → insert at top
    ssh_cmd = (
        "sh -c '"
        "nft list table inet actmon >/dev/null 2>&1 || { nft add table inet actmon; "
        "nft \"add chain inet actmon input { type filter hook input priority -10; policy accept; }\"; }; "
        f"nft {pos} rule inet actmon input ip saddr {shlex.quote(ip)} {verb}; "
        "nft -a list chain inet actmon input'"
    )
    raw = _run(srv, db, "fwctl", f"add:{action}:{ip}", ssh_cmd)
    return {"status": "success", "rules": _fw_parse(srv, raw)}


def svc_fw_del(server_id: int, handle: str, db: Session) -> dict:
    srv = _get(server_id, db)
    if _is_win(srv):
        # handle is the rule's display name — no nft; the agent removes it by name.
        raw = _run(srv, db, "fwctl", f"del:{handle}", "")
        return {"status": "success", "rules": _parse_fw_win(raw)}
    if not str(handle).isdigit():
        raise HTTPException(status_code=400, detail="Invalid rule handle.")
    ssh_cmd = f"sh -c 'nft delete rule inet actmon input handle {handle}; nft -a list chain inet actmon input'"
    raw = _run(srv, db, "fwctl", f"del:{handle}:", ssh_cmd)
    return {"status": "success", "rules": _parse_fw(raw)}
