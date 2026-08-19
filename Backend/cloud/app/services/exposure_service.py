"""Internet-exposure analysis — which compute resources are actually reachable
from the public internet, on which ports, and through which security rule.

This is deliberately not "has a public IP" (that alone is nearly meaningless —
half of every cloud account has one) and not "security group looks permissive"
(a permissive rule on a resource with no public IP reaches nothing). It is the
AND of both, walked through the real attachment chain recorded by the
topology-oriented scanner fields: instance -> NIC/VNIC -> security group/NSG ->
rule -> is the source the whole internet.

Correctness notes, stated rather than hidden:

* AWS Security Groups and OCI NSGs have no explicit "deny" — every rule is an
  allow, default-deny otherwise — so a single matching allow rule is a complete
  answer for those two providers.
* Azure NSGs DO have explicit deny rules evaluated in priority order (lowest
  number first), so an allow can be shadowed by a higher-priority deny. This
  module accounts for an EXACT-match deny at a lower priority number, but does
  not perform full interval subtraction across partially-overlapping port
  ranges — that is a much harder problem for a small accuracy gain. Findings
  from Azure are marked with this limitation in `confidence`.
* OCI subnets can be secured by NSGs, Security Lists, or both at once — traffic
  needs only one of them to allow it, so both are evaluated and merged for a
  compute instance. Only if NEITHER resolves at all is the result UNKNOWN
  rather than "safe": a false "protected" verdict is worse than admitting a
  scanner gap.
"""
from __future__ import annotations

import ipaddress
import logging
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger("cloud_svc.exposure")

SEVERITY_CRITICAL = "CRITICAL"
SEVERITY_HIGH = "HIGH"
SEVERITY_MEDIUM = "MEDIUM"
SEVERITY_INFO = "INFO"

# port -> (service name, severity if opened to the whole internet)
_RISK_PORTS: Dict[int, Tuple[str, str]] = {
    23: ("Telnet", SEVERITY_CRITICAL),
    21: ("FTP", SEVERITY_HIGH),
    22: ("SSH", SEVERITY_HIGH),
    135: ("RPC/DCOM", SEVERITY_HIGH),
    139: ("NetBIOS", SEVERITY_HIGH),
    445: ("SMB", SEVERITY_CRITICAL),
    1433: ("MSSQL", SEVERITY_CRITICAL),
    1521: ("Oracle DB", SEVERITY_CRITICAL),
    2049: ("NFS", SEVERITY_HIGH),
    3306: ("MySQL", SEVERITY_CRITICAL),
    3389: ("RDP", SEVERITY_CRITICAL),
    5432: ("PostgreSQL", SEVERITY_CRITICAL),
    5900: ("VNC", SEVERITY_CRITICAL),
    5984: ("CouchDB", SEVERITY_HIGH),
    5985: ("WinRM", SEVERITY_HIGH),
    5986: ("WinRM (SSL)", SEVERITY_HIGH),
    6379: ("Redis", SEVERITY_CRITICAL),
    9092: ("Kafka", SEVERITY_HIGH),
    9200: ("Elasticsearch", SEVERITY_CRITICAL),
    11211: ("Memcached", SEVERITY_HIGH),
    27017: ("MongoDB", SEVERITY_CRITICAL),
}
# Expected to be public — informational, not a finding on its own.
_WEB_PORTS = {80: "HTTP", 443: "HTTPS"}

_WORLD_CIDRS = {"0.0.0.0/0", "::/0"}
# Azure source_address_prefix accepts these service-tag-like strings meaning
# "anywhere on the internet", in addition to real CIDRs.
_AZURE_WORLD_TOKENS = {"*", "internet", "any"}


def _is_world_open(cidr_or_token: Optional[str]) -> bool:
    if not cidr_or_token:
        return False
    v = cidr_or_token.strip()
    if v in _WORLD_CIDRS or v.lower() in _AZURE_WORLD_TOKENS:
        return True
    try:
        net = ipaddress.ip_network(v, strict=False)
        # A /0 network under any notation is the whole address space.
        return net.prefixlen == 0
    except ValueError:
        return False


def _classify_port_range(pmin: Optional[int], pmax: Optional[int]) -> List[Dict[str, Any]]:
    """One open rule can span a port range; break it into the findings worth
    naming individually (well-known risky/web ports) plus a summary for the
    rest of the range, so "22-3389 open" doesn't hide the RDP port inside a
    single generic entry."""
    if pmin is None or pmax is None:
        return [{"port": None, "service": "ALL PORTS", "severity": SEVERITY_CRITICAL}]
    if pmin == 0 and pmax >= 65535:
        return [{"port": None, "service": "ALL PORTS", "severity": SEVERITY_CRITICAL}]

    hits = []
    for port, (svc, sev) in _RISK_PORTS.items():
        if pmin <= port <= pmax:
            hits.append({"port": port, "service": svc, "severity": sev})
    for port, svc in _WEB_PORTS.items():
        if pmin <= port <= pmax:
            hits.append({"port": port, "service": svc, "severity": SEVERITY_INFO})

    span = pmax - pmin + 1
    if not hits:
        # A single, otherwise-unremarkable port is still worth flagging — an
        # attacker doesn't need a "well-known" port to find something running.
        if span == 1:
            hits.append({"port": pmin, "service": None, "severity": SEVERITY_MEDIUM})
        else:
            sev = SEVERITY_CRITICAL if span > 50 else SEVERITY_HIGH
            hits.append({
                "port": None, "port_range": [pmin, pmax],
                "service": f"{span} ports", "severity": sev,
            })
    return hits


# ── per-provider rule normalisation ────────────────────────────────────────

def _aws_open_ports(sg_config: Dict[str, Any], raw: Dict[str, Any]) -> List[Dict[str, Any]]:
    """AWS Security Group: every rule is an allow (default-deny otherwise), so
    a single matching rule is a complete answer."""
    found = []
    for perm in (raw or {}).get("IpPermissions", []):
        sources = [r.get("CidrIp") for r in perm.get("IpRanges", [])]
        sources += [r.get("CidrIpv6") for r in perm.get("Ipv6Ranges", [])]
        if not any(_is_world_open(s) for s in sources):
            continue
        proto = (perm.get("IpProtocol") or "").lower()
        if proto == "-1":
            found.extend(_classify_port_range(None, None))
            continue
        pmin, pmax = perm.get("FromPort"), perm.get("ToPort")
        if pmin is None and pmax is None:
            # ICMP or a protocol with no ports (whole protocol is reachable).
            found.append({"port": None, "service": f"{proto or 'ip'} (any)",
                          "severity": SEVERITY_MEDIUM})
            continue
        found.extend(_classify_port_range(pmin, pmax))
    return found


def _oci_open_ports(nsg_config: Dict[str, Any]) -> List[Dict[str, Any]]:
    """OCI NSG: also allow-only, same reasoning as AWS."""
    found = []
    for rule in (nsg_config or {}).get("ingress_rules") or []:
        if rule.get("source_type") != "CIDR_BLOCK" or not _is_world_open(rule.get("source")):
            continue
        proto = str(rule.get("protocol") or "").lower()
        if proto == "all":
            found.extend(_classify_port_range(None, None))
            continue
        pr = rule.get("port_range")
        if not pr:
            # tcp/udp with no port_range means every port of that protocol;
            # icmp (protocol "1") has no ports at all.
            if proto in ("6", "17", "tcp", "udp"):
                found.extend(_classify_port_range(None, None))
            else:
                found.append({"port": None, "service": "ICMP", "severity": SEVERITY_INFO})
            continue
        found.extend(_classify_port_range(pr.get("min"), pr.get("max")))
    return found


def _azure_port_spans(rule: Dict[str, Any]) -> List[Tuple[Optional[int], Optional[int]]]:
    spans = []
    ranges = list(rule.get("destination_port_ranges") or [])
    single = rule.get("destination_port_range")
    if single:
        ranges.append(single)
    for r in ranges or ["*"]:
        r = str(r)
        if r == "*":
            spans.append((None, None))
        elif "-" in r:
            a, b = r.split("-", 1)
            try:
                spans.append((int(a), int(b)))
            except ValueError:
                continue
        else:
            try:
                spans.append((int(r), int(r)))
            except ValueError:
                continue
    return spans


def _azure_open_ports(nsg_config: Dict[str, Any]) -> Tuple[List[Dict[str, Any]], bool]:
    """Azure NSG: rules are evaluated in priority order (lower number first)
    and CAN deny. A world-open Allow is reported UNLESS an exact-match Deny
    sits at a lower priority number for the same port span and source scope.
    Partial-range overlaps between an Allow and a Deny are not resolved —
    returns `exact_match_only=True` so the caller can mark those findings
    lower-confidence.
    """
    rules = sorted(
        (nsg_config or {}).get("ingress_rules") or [],
        key=lambda r: r.get("priority") if r.get("priority") is not None else 65535,
    )
    denies = [r for r in rules if (r.get("access") or "").lower() == "deny"]
    found: List[Dict[str, Any]] = []
    approximate = False

    for rule in rules:
        if (rule.get("access") or "").lower() != "allow":
            continue
        if not _is_world_open(rule.get("source_address_prefix")):
            continue
        for pmin, pmax in _azure_port_spans(rule):
            shadowed = any(
                (d.get("priority") or 0) < (rule.get("priority") or 0)
                and _is_world_open(d.get("source_address_prefix"))
                and _azure_port_spans(d) == [(pmin, pmax)]
                for d in denies
            )
            if shadowed:
                continue
            if pmin is None or (pmax or 0) - (pmin or 0) > 0:
                approximate = True
            found.extend(_classify_port_range(pmin, pmax))
    return found, approximate


# ── main entry point ────────────────────────────────────────────────────────

def _dedupe_hits(hits: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    seen = set()
    out = []
    for h in hits:
        key = (h.get("port"), h.get("service"), tuple(h.get("port_range") or ()))
        if key in seen:
            continue
        seen.add(key)
        out.append(h)
    return out


_SEVERITY_RANK = {SEVERITY_CRITICAL: 0, SEVERITY_HIGH: 1, SEVERITY_MEDIUM: 2, SEVERITY_INFO: 3}


def compute_exposure(resources: List[Any]) -> Dict[str, Any]:
    """Returns exposed compute resources, worst-first, plus scan coverage
    stats so an empty result can be told apart from "nothing was checkable".
    """
    by_id: Dict[str, Any] = {r.provider_resource_id: r for r in resources if r.provider_resource_id}

    exposed: List[Dict[str, Any]] = []
    checked = 0
    unknown = 0

    for r in resources:
        rtype = r.resource_type
        config = r.config or {}

        if rtype == "EC2Instance":
            public_ip = config.get("public_ip")
            if not public_ip:
                continue
            checked += 1
            sg_ids = config.get("security_group_ids") or []
            hits, confidence = [], "high"
            for sgid in sg_ids:
                sg = by_id.get(sgid)
                if sg:
                    hits.extend(_aws_open_ports(sg.config or {}, sg.raw_data or {}))
            if not sg_ids:
                unknown += 1
                confidence = "unknown — no security group recorded"
            via = [by_id[i].resource_name for i in sg_ids if i in by_id]

        elif rtype == "ComputeInstance":  # OCI
            public_ip = config.get("public_ip")
            if not public_ip:
                continue
            checked += 1
            nsg_ids = config.get("nsg_ids") or []
            # A subnet with no NSG attached is still governed by its Security
            # List(s) — the older, subnet-level mechanism NSGs were added
            # alongside rather than replacing. Both are independently-enforced
            # allow lists (traffic needs only one to permit it), so both count.
            subnet = by_id.get(config.get("subnet_id"))
            seclist_ids = (subnet.config or {}).get("security_list_ids") or [] if subnet else []
            hits = []
            for nid in nsg_ids:
                nsg = by_id.get(nid)
                if nsg:
                    hits.extend(_oci_open_ports(nsg.config or {}))
            for sid in seclist_ids:
                seclist = by_id.get(sid)
                if seclist:
                    hits.extend(_oci_open_ports(seclist.config or {}))
            if not nsg_ids and not seclist_ids:
                unknown += 1
                confidence = "unknown — no NSG or Security List resolved for this instance"
            else:
                confidence = "high"
            via = [by_id[i].resource_name for i in (nsg_ids + seclist_ids) if i in by_id]

        elif rtype == "VirtualMachine":  # Azure
            nic_ids = config.get("nic_ids") or []
            # A NIC referencing a public_ip_id IS internet-facing regardless of
            # whether we resolve the address — that reference is Azure's own
            # confirmation a public IP is attached. The address itself lives on
            # the PublicIP resource, not the NIC or the VM, so resolve it there
            # for display, but a scanner gap in resolving it must not read as
            # "this VM has no public IP".
            nics = [by_id[n] for n in nic_ids if n in by_id]
            pip_ids = [pid for nic in nics for pid in (nic.config or {}).get("public_ip_ids") or []]
            if not pip_ids:
                continue
            public_ip = next(
                (by_id[pid].ip_address for pid in pip_ids if pid in by_id and by_id[pid].ip_address),
                "attached (address not resolved)",
            )
            checked += 1
            hits, approximate = [], False
            nsg_ids = set()
            for nic in nics:
                nid = (nic.config or {}).get("network_security_group_id")
                if nid:
                    nsg_ids.add(nid)
                # A subnet-level NSG applies to every NIC in that subnet too.
                for sid in (nic.config or {}).get("subnet_ids") or []:
                    subnet = by_id.get(sid)
                    snid = (subnet.config or {}).get("network_security_group_id") if subnet else None
                    if snid:
                        nsg_ids.add(snid)
            for nid in nsg_ids:
                nsg = by_id.get(nid)
                if nsg:
                    found, approx = _azure_open_ports(nsg.config or {})
                    hits.extend(found)
                    approximate = approximate or approx
            if not nsg_ids:
                unknown += 1
                confidence = "unknown — no NSG attached to this VM's NIC or subnet"
            else:
                confidence = ("approximate — Azure deny-rule overlap across partial "
                              "port ranges is not fully modelled" if approximate else "high")
            via = [by_id[i].resource_name for i in nsg_ids if i in by_id]

        else:
            continue

        hits = _dedupe_hits(hits)
        if not hits:
            continue  # public IP exists but nothing world-open was found

        hits.sort(key=lambda h: _SEVERITY_RANK.get(h["severity"], 9))
        worst = hits[0]["severity"]
        exposed.append({
            "resource_id": str(r.id),
            "resource_name": r.resource_name,
            "resource_type": rtype,
            "account_id": str(r.account_id),
            # By this point `public_ip` is always a real string — every branch
            # above `continue`s when it's falsy.
            "public_ip": public_ip,
            "open_ports": hits,
            "via": via,
            "severity": worst,
            "confidence": confidence,
        })

    exposed.sort(key=lambda e: _SEVERITY_RANK.get(e["severity"], 9))
    return {
        "exposed_resources": exposed,
        "total_exposed": len(exposed),
        "total_checked": checked,
        "unknown_coverage": unknown,
        "by_severity": {
            sev: sum(1 for e in exposed if e["severity"] == sev)
            for sev in (SEVERITY_CRITICAL, SEVERITY_HIGH, SEVERITY_MEDIUM, SEVERITY_INFO)
        },
    }


def exposure_to_findings(report: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Fold the worst exposures into the main security-findings feed, in the
    same shape run_security_scan already produces, so they affect the score."""
    out = []
    for e in report["exposed_resources"]:
        ports = ", ".join(
            (str(h["port"]) if h.get("port") else h.get("service") or "range")
            for h in e["open_ports"][:4]
        )
        out.append({
            "resource_id": e["resource_id"],
            "resource_name": e["resource_name"],
            "resource_type": e["resource_type"],
            "severity": e["severity"],
            "title": f"Internet-Exposed: {e['open_ports'][0].get('service') or 'Open Port'}",
            "description": (
                f"'{e['resource_name']}' has public IP {e['public_ip']} and allows inbound "
                f"traffic from the entire internet on {ports} via {', '.join(e['via']) or 'an unnamed rule'}."
            ),
            "recommendation": "Restrict the source CIDR to known IP ranges, or remove public exposure and front this resource with a bastion/VPN/load balancer.",
            "category": "Networking",
        })
    return out
