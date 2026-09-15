"""Internet exposure: can the internet actually reach this resource, and how?

The question this answers is deliberately narrow and deliberately hard: not
"does it have a public IP" (nearly everything does, and it means nothing on its
own) and not "does a rule look permissive" (a permissive rule on a resource
nothing routes to reaches nothing). It is the conjunction, walked through the
attachment chain the provider itself reported:

    Internet → public address → NIC/VNIC → security group / NSG / security list → resource

Two things are different from the previous implementation, and both were bugs
found by running it against live data.

**Every internet-facing resource gets a verdict.** Previously a resource whose
rule set could not be resolved was `continue`d before the `checked` and
`unknown` counters, so it vanished. On the live Azure Production Account —
49 VMs, 25 with public addresses, whose NICs were collected by an older
scanner that never recorded `public_ip_ids` — that produced
`total_checked: 0, unknown_coverage: 0`, and the UI rendered its clean empty
state: *"No internet exposure found."* The most dangerous possible output. Now
the verdict is UNKNOWN with the reason attached, and UNKNOWN is counted.

**Azure is resolved by exact interval arithmetic, not exact-match comparison.**
Azure NSGs, alone among the three, have explicit Deny rules evaluated in
ascending priority order, so an Allow can be shadowed. The old code compared
port spans for equality — it would notice `Deny 3389` shadowing
`Allow 3389`, but not `Deny 100-200` shadowing part of `Allow 22-3389`, and
marked all range findings "approximate" as a result. `_effective_intervals`
below performs the real computation: walk rules in priority order, subtract
what higher-priority rules already decided, and keep the remainder. That is
Azure's own algorithm, so the answer is exact and reports HIGH confidence —
including the ability to say port 150 is PROTECTED while 22, 80 and 3389 are
EXPOSED on the same NSG.

Provider asymmetry, stated rather than hidden:

* **AWS security groups** and **OCI NSGs and security lists** are allow-only
  with an implicit default deny. One matching allow rule is a complete answer.
* **OCI subnets** may be governed by NSGs, security lists, or both, and traffic
  needs only one of them to permit it — so both are evaluated and merged. Only
  if *neither* resolves is the result UNKNOWN rather than PROTECTED.
* **Azure NSGs** apply at both NIC and subnet level; both are collected and
  merged the same way.
"""
from __future__ import annotations

import ipaddress
import logging
from typing import Any, Dict, Iterable, List, NamedTuple, Optional, Sequence, Tuple

from app.security import ports as portcat
from app.security.model import (
    AWS, AZURE, CONF_HIGH, CONF_MEDIUM, CONF_UNKNOWN, EXPOSED,
    EXPOSURE_NOT_APPLICABLE, EXPOSURE_UNKNOWN, OCI, PROTECTED, severity_rank,
    worst_severity,
)
from app.security.registry import (
    _azure_port_spans, _oci_rule_covers_port, is_world_open,
)

logger = logging.getLogger("cloud_svc.security.exposure")

# Compute resource types that can be internet-facing, per provider. Anything
# else is NOT_APPLICABLE — it has no address of its own to reach.
COMPUTE_TYPES: Dict[str, frozenset] = {
    AWS: frozenset({"EC2Instance", "RDSInstance", "LoadBalancer", "RedshiftCluster"}),
    AZURE: frozenset({"VirtualMachine"}),
    OCI: frozenset({"ComputeInstance", "DbSystem", "LoadBalancer"}),
}


class Hop(NamedTuple):
    """One step of the path from the internet to the resource.

    This is the evidence an analyst reads to check the conclusion: which
    address, through which NIC, governed by which rule set, permitted by which
    rule. A verdict without a path is an assertion.
    """

    kind: str           # public-ip | nic | security-group | nsg | security-list | subnet
    label: str          # human name
    identifier: Optional[str] = None
    detail: Optional[str] = None

    def to_dict(self) -> dict:
        return {"kind": self.kind, "label": self.label,
                "identifier": self.identifier, "detail": self.detail}


class PortVerdict(NamedTuple):
    """A per-port answer, so 'PROTECTED' can be stated about a specific port
    rather than only about a whole resource."""

    port: int
    service: Optional[str]
    verdict: str
    reason: str

    def to_dict(self) -> dict:
        return {"port": self.port, "service": self.service,
                "verdict": self.verdict, "reason": self.reason}


class Exposure(NamedTuple):
    resource_id: str
    resource_key: Optional[str]
    resource_name: Optional[str]
    resource_type: str
    provider: str
    account_id: str
    region: Optional[str]

    verdict: str
    confidence: str
    public_addresses: List[str]
    open_ports: List[portcat.OpenPort]
    port_verdicts: List[PortVerdict]
    path: List[Hop]
    # Names of the rule sets actually consulted. Empty with an UNKNOWN verdict
    # is the signature of a resolution failure.
    evaluated_controls: List[str]
    unknown_reason: Optional[str] = None

    @property
    def severity(self) -> Optional[str]:
        return portcat.worst_of(self.open_ports) if self.open_ports else None

    def to_dict(self) -> dict:
        return {
            "resource_id": self.resource_id,
            "resource_key": self.resource_key,
            "resource_name": self.resource_name,
            "resource_type": self.resource_type,
            "provider": self.provider,
            "account_id": self.account_id,
            "region": self.region,
            "verdict": self.verdict,
            "confidence": self.confidence,
            "severity": self.severity,
            "public_addresses": self.public_addresses,
            "open_ports": [p.to_dict() for p in self.open_ports],
            "port_verdicts": [p.to_dict() for p in self.port_verdicts],
            "path": [h.to_dict() for h in self.path],
            "evaluated_controls": self.evaluated_controls,
            "unknown_reason": self.unknown_reason,
        }


# ═════════════════════════════════════════════════════════════════════════════
# Interval algebra — the core of exact Azure evaluation
# ═════════════════════════════════════════════════════════════════════════════

Interval = Tuple[int, int]
FULL_RANGE: Interval = (0, 65535)


def _normalise(span: Tuple[Optional[int], Optional[int]]) -> Interval:
    lo, hi = span
    if lo is None or hi is None:
        return FULL_RANGE
    lo, hi = int(lo), int(hi)
    if lo > hi:
        lo, hi = hi, lo
    return (max(0, lo), min(65535, hi))


def _subtract(base: Interval, cut: Interval) -> List[Interval]:
    """base minus cut, as zero, one or two intervals."""
    (bl, bh), (cl, ch) = base, cut
    if ch < bl or cl > bh:
        return [base]
    out = []
    if cl > bl:
        out.append((bl, cl - 1))
    if ch < bh:
        out.append((ch + 1, bh))
    return out


def _subtract_all(base: Interval, cuts: Iterable[Interval]) -> List[Interval]:
    parts = [base]
    for cut in cuts:
        nxt: List[Interval] = []
        for p in parts:
            nxt.extend(_subtract(p, cut))
        parts = nxt
        if not parts:
            break
    return parts


def _merge(intervals: Sequence[Interval]) -> List[Interval]:
    if not intervals:
        return []
    ordered = sorted(intervals)
    out = [ordered[0]]
    for lo, hi in ordered[1:]:
        plo, phi = out[-1]
        if lo <= phi + 1:
            out[-1] = (plo, max(phi, hi))
        else:
            out.append((lo, hi))
    return out


def _width(intervals: Sequence[Interval]) -> int:
    return sum(hi - lo + 1 for lo, hi in intervals)


# ═════════════════════════════════════════════════════════════════════════════
# Azure
# ═════════════════════════════════════════════════════════════════════════════

# Protocols evaluated independently: a UDP deny cannot shadow a TCP allow.
_AZURE_PROTOCOLS = ("Tcp", "Udp")


def _azure_rule_protocols(rule: Dict[str, Any]) -> Tuple[str, ...]:
    p = str(rule.get("protocol") or "*").strip().lower()
    if p in ("*", "any"):
        return _AZURE_PROTOCOLS
    if p in ("tcp", "6"):
        return ("Tcp",)
    if p in ("udp", "17"):
        return ("Udp",)
    return ()   # ICMP / ESP / AH have no port concept


def _effective_intervals(
    rules: Sequence[Dict[str, Any]], protocol: str
) -> Tuple[List[Interval], List[Interval]]:
    """Exact Azure resolution for internet-sourced traffic on one protocol.

    Returns (allowed, denied) as disjoint merged interval lists.

    The algorithm is Azure's: inbound rules in ascending priority order, first
    match wins per port. Implemented as interval subtraction — each rule only
    decides the part of its own port range that no higher-priority rule already
    decided — which is what makes partially-overlapping Allow/Deny pairs exact
    instead of approximate.

    Only rules whose source is the whole internet participate. A rule scoped to
    a specific CIDR neither exposes the port to the internet nor protects it
    from the internet, so it must not consume the interval; leaving it out is
    what keeps a lower-priority world-open Allow correctly visible.

    Anything not decided by an explicit rule falls to Azure's implicit
    DenyAllInbound, so it is simply absent from `allowed`.
    """
    inbound = [
        r for r in rules
        if isinstance(r, dict)
        and str(r.get("direction") or "Inbound").strip().lower() == "inbound"
        and is_world_open(r.get("source_address_prefix"))
        and protocol in _azure_rule_protocols(r)
    ]
    inbound.sort(key=lambda r: r["priority"] if isinstance(r.get("priority"), int) else 65535)

    decided: List[Interval] = []
    allowed: List[Interval] = []
    denied: List[Interval] = []

    for rule in inbound:
        access = str(rule.get("access") or "").strip().lower()
        if access not in ("allow", "deny"):
            continue
        for span in _azure_port_spans(rule):
            for part in _subtract_all(_normalise(span), decided):
                (allowed if access == "allow" else denied).append(part)
                decided.append(part)
        decided = _merge(decided)

    return _merge(allowed), _merge(denied)


def azure_open_intervals(rules: Sequence[Dict[str, Any]]) -> Dict[str, Tuple[List[Interval], List[Interval]]]:
    return {proto: _effective_intervals(rules, proto) for proto in _AZURE_PROTOCOLS}


# ═════════════════════════════════════════════════════════════════════════════
# Per-provider resolution
# ═════════════════════════════════════════════════════════════════════════════


def _res(index: Dict[str, Any], key: Optional[str]):
    return index.get(key) if key else None


def _name_of(resource) -> str:
    return getattr(resource, "resource_name", None) or "unnamed"


def _cfg(resource) -> Dict[str, Any]:
    return getattr(resource, "config", None) or {}


def _is_public_address(value: Optional[str]) -> bool:
    if not value:
        return False
    try:
        return not ipaddress.ip_address(str(value).strip()).is_private
    except ValueError:
        return False


def _aws(resource, index) -> Exposure:
    cfg = _cfg(resource)
    addrs = [a for a in (cfg.get("public_ip"), resource.ip_address) if a]
    addrs = [a for a in dict.fromkeys(addrs) if _is_public_address(a) or resource.resource_type == "LoadBalancer"]

    if not addrs:
        return _verdict(resource, EXPOSURE_NOT_APPLICABLE, CONF_HIGH, [], [], [], [], [])

    path = [Hop("public-ip", addrs[0], detail="Public address reported by the provider")]
    sg_ids = [s for s in (cfg.get("security_group_ids") or []) if s]
    if not sg_ids:
        return _verdict(
            resource, EXPOSURE_UNKNOWN, CONF_UNKNOWN, addrs, [], [], path, [],
            reason=("No security group is recorded for this resource, so the rules "
                    "governing its public address could not be resolved. Its exposure is "
                    "unknown — not assumed closed."),
        )

    open_ports: List[portcat.OpenPort] = []
    consulted: List[str] = []
    unresolved: List[str] = []

    for sid in sg_ids:
        sg = _res(index, sid)
        if sg is None:
            unresolved.append(sid)
            continue
        consulted.append(_name_of(sg))
        raw = getattr(sg, "raw_data", None) or {}
        perms = raw.get("IpPermissions")
        if perms is None:
            unresolved.append(sid)
            continue
        found = _aws_sg_open_ports(perms)
        if found:
            path.append(Hop("security-group", _name_of(sg), sid,
                            f"{len(found)} world-open port group(s)"))
        open_ports.extend(found)

    if unresolved and not open_ports:
        return _verdict(
            resource, EXPOSURE_UNKNOWN, CONF_UNKNOWN, addrs, [], [], path, consulted,
            reason=(f"{len(unresolved)} of {len(sg_ids)} security group(s) could not be "
                    "resolved from the stored inventory, so no rule set was available to "
                    "evaluate."),
        )

    open_ports = portcat.dedupe(open_ports)
    verdict = EXPOSED if open_ports else PROTECTED
    conf = CONF_MEDIUM if unresolved else CONF_HIGH
    pv = _port_verdicts_from_open(open_ports, verdict)
    return _verdict(resource, verdict, conf, addrs, open_ports, pv, path, consulted,
                    reason=(f"{len(unresolved)} security group(s) unresolved; the verdict "
                            "reflects only the ones that were available."
                            if unresolved else None))


def _aws_sg_open_ports(perms: Sequence[Any]) -> List[portcat.OpenPort]:
    out: List[portcat.OpenPort] = []
    for perm in perms:
        if not isinstance(perm, dict):
            continue
        sources = [r.get("CidrIp") for r in perm.get("IpRanges") or [] if isinstance(r, dict)]
        sources += [r.get("CidrIpv6") for r in perm.get("Ipv6Ranges") or [] if isinstance(r, dict)]
        if not any(is_world_open(s) for s in sources):
            continue
        proto = str(perm.get("IpProtocol") or "").lower()
        if proto == "-1":
            out.append(portcat.ALL_PORTS)
            continue
        lo, hi = perm.get("FromPort"), perm.get("ToPort")
        if lo is None and hi is None:
            if proto in ("tcp", "udp"):
                out.append(portcat.ALL_PORTS)
            else:
                out.append(portcat.protocol_only(proto))
            continue
        out.extend(portcat.classify_range(lo, hi))
    return out


def _azure(resource, index) -> Exposure:
    """Azure: VM → NICs → public IPs, and NSGs at both NIC and subnet level."""
    cfg = _cfg(resource)
    nic_ids = [n for n in (cfg.get("nic_ids") or []) if n]

    # No nic_ids at all is the Azure-Production case: an older scanner version
    # that never recorded the relationship. If the VM nonetheless reports a
    # public address, it IS internet-facing and must not be filed as
    # NOT_APPLICABLE.
    if not nic_ids:
        if _is_public_address(resource.ip_address):
            return _verdict(
                resource, EXPOSURE_UNKNOWN, CONF_UNKNOWN, [resource.ip_address], [], [],
                [Hop("public-ip", resource.ip_address,
                     detail="Public address reported on the VM record")],
                [],
                reason=("This VM has a public address but no network interface is recorded "
                        "against it, so the NSG rules that govern that address could not be "
                        "resolved. Re-run discovery for this account: its resources were "
                        "collected by a scanner version that did not record NIC "
                        "relationships."),
            )
        return _verdict(
            resource, EXPOSURE_UNKNOWN, CONF_UNKNOWN, [], [], [], [], [],
            reason=("No network interface is recorded against this VM, so neither its "
                    "addresses nor its NSG rules could be resolved. Exposure is unknown."),
        )

    nics = [_res(index, n) for n in nic_ids]
    missing_nics = [n for n, r in zip(nic_ids, nics) if r is None]
    nics = [n for n in nics if n is not None]

    addrs: List[str] = []
    pip_refs: List[str] = []
    path: List[Hop] = []
    nsg_ids: List[str] = []
    subnet_hops: List[Hop] = []

    for nic in nics:
        ncfg = _cfg(nic)
        pips = [p for p in (ncfg.get("public_ip_ids") or []) if p]
        pip_refs.extend(pips)
        for pid in pips:
            pip = _res(index, pid)
            addr = getattr(pip, "ip_address", None) if pip else None
            addrs.append(addr or "attached (address not resolved)")
            path.append(Hop("public-ip", addr or "attached (address not resolved)", pid,
                            "Public IP resource attached to this NIC"))
        if pips:
            path.append(Hop("nic", _name_of(nic), getattr(nic, "provider_resource_id", None),
                            f"private {ncfg.get('private_ip') or 'unknown'}"))
        nid = ncfg.get("network_security_group_id")
        if nid:
            nsg_ids.append(nid)
        for sid in ncfg.get("subnet_ids") or []:
            subnet = _res(index, sid)
            if subnet is None:
                continue
            snid = _cfg(subnet).get("network_security_group_id")
            subnet_hops.append(Hop("subnet", _name_of(subnet), sid,
                                   "subnet-level NSG applies to every NIC in it"
                                   if snid else "no subnet-level NSG"))
            if snid:
                nsg_ids.append(snid)

    # A NIC referencing a public_ip_id IS internet-facing whether or not the
    # address itself resolved — that reference is Azure's own confirmation.
    if not pip_refs:
        if missing_nics:
            return _verdict(
                resource, EXPOSURE_UNKNOWN, CONF_UNKNOWN, [], [], [], path, [],
                reason=(f"{len(missing_nics)} of this VM's network interfaces are not in "
                        "the stored inventory, so whether it has a public address could "
                        "not be determined."),
            )
        return _verdict(resource, EXPOSURE_NOT_APPLICABLE, CONF_HIGH, [], [], [], path, [])

    nsg_ids = list(dict.fromkeys(nsg_ids))
    path.extend(subnet_hops)

    if not nsg_ids:
        return _verdict(
            resource, EXPOSURE_UNKNOWN, CONF_UNKNOWN, addrs, [], [], path, [],
            reason=("This VM is internet-facing but no network security group is attached "
                    "to its NICs or their subnets in the stored inventory. Azure's default "
                    "for a NIC with no NSG is to allow inbound from the internet, so this "
                    "may well be exposed — it is reported as unknown rather than guessed "
                    "in either direction."),
        )

    all_allowed: Dict[str, List[Interval]] = {p: [] for p in _AZURE_PROTOCOLS}
    all_denied: Dict[str, List[Interval]] = {p: [] for p in _AZURE_PROTOCOLS}
    consulted: List[str] = []
    unresolved = 0

    for nid in nsg_ids:
        nsg = _res(index, nid)
        if nsg is None:
            unresolved += 1
            continue
        rules = _cfg(nsg).get("ingress_rules")
        if not isinstance(rules, list):
            unresolved += 1
            continue
        consulted.append(_name_of(nsg))
        for proto in _AZURE_PROTOCOLS:
            allowed, denied = _effective_intervals(rules, proto)
            all_allowed[proto].extend(allowed)
            all_denied[proto].extend(denied)
            if allowed:
                path.append(Hop(
                    "nsg", _name_of(nsg), nid,
                    f"{proto}: {_width(allowed)} port(s) allowed from the internet",
                ))

    if unresolved and not consulted:
        return _verdict(
            resource, EXPOSURE_UNKNOWN, CONF_UNKNOWN, addrs, [], [], path, consulted,
            reason=(f"All {unresolved} network security group(s) referenced by this VM's "
                    "NICs or subnets are missing from the stored inventory, or hold no "
                    "rule list, so no rules were available to evaluate."),
        )

    open_ports: List[portcat.OpenPort] = []
    for proto in _AZURE_PROTOCOLS:
        for lo, hi in _merge(all_allowed[proto]):
            open_ports.extend(portcat.classify_range(lo, hi))
    open_ports = portcat.dedupe(open_ports)

    verdict = EXPOSED if open_ports else PROTECTED
    pv = _azure_port_verdicts(all_allowed, all_denied)
    # Exact interval subtraction in priority order IS Azure's algorithm, so
    # this is high confidence. The one modelled simplification —
    # destination_address_prefix is not collected by the scanner, so a rule
    # scoped to a specific destination is treated as applying — is recorded
    # here rather than silently assumed.
    conf = CONF_MEDIUM if unresolved else CONF_HIGH
    return _verdict(
        resource, verdict, conf, addrs, open_ports, pv, path, consulted,
        reason=(f"{unresolved} referenced NSG(s) unresolved; the verdict reflects only "
                "the ones available." if unresolved else None),
    )


def _azure_port_verdicts(
    allowed: Dict[str, List[Interval]], denied: Dict[str, List[Interval]]
) -> List[PortVerdict]:
    """Per-port answers for the well-known ports, which is what makes an Azure
    result legible: '22 EXPOSED, 150 PROTECTED, 3389 EXPOSED' rather than one
    verdict for a 3,000-port range."""
    out: List[PortVerdict] = []
    for port, info in sorted(portcat.CATALOG.items()):
        a = any(lo <= port <= hi for lo, hi in _merge(allowed["Tcp"]))
        d = any(lo <= port <= hi for lo, hi in _merge(denied["Tcp"]))
        if a:
            out.append(PortVerdict(port, info.service, EXPOSED,
                                   "An internet-scoped Allow rule governs this port and no "
                                   "higher-priority Deny shadows it."))
        elif d:
            out.append(PortVerdict(port, info.service, PROTECTED,
                                   "An internet-scoped Deny rule at a lower priority number "
                                   "shadows any Allow covering this port."))
    return out


def _oci(resource, index) -> Exposure:
    """OCI: NSGs and security lists are independent allow lists — traffic needs
    only one of them to permit it, so both are evaluated and merged."""
    cfg = _cfg(resource)
    addrs = [a for a in (cfg.get("public_ip"), resource.ip_address) if a]
    addrs = [a for a in dict.fromkeys(addrs)]
    is_lb = resource.resource_type in ("LoadBalancer", "NetworkLoadBalancer")
    if is_lb:
        ips = cfg.get("ip_addresses")
        if isinstance(ips, list):
            addrs.extend(str(i) for i in ips if i)
        if cfg.get("is_private") is True:
            return _verdict(resource, EXPOSURE_NOT_APPLICABLE, CONF_HIGH, [], [], [], [], [])
    addrs = [a for a in dict.fromkeys(addrs) if _is_public_address(a)]

    if not addrs:
        return _verdict(resource, EXPOSURE_NOT_APPLICABLE, CONF_HIGH, [], [], [], [], [])

    path = [Hop("public-ip", addrs[0], detail="Public address reported by the provider")]
    nsg_ids = [n for n in (cfg.get("nsg_ids") or []) if n]
    subnet_id = cfg.get("subnet_id")
    seclist_ids: List[str] = []
    subnet = _res(index, subnet_id)
    if subnet is not None:
        seclist_ids = [s for s in (_cfg(subnet).get("security_list_ids") or []) if s]
        path.append(Hop("subnet", _name_of(subnet), subnet_id,
                        f"{len(seclist_ids)} security list(s) apply to this subnet"))
    elif subnet_id:
        path.append(Hop("subnet", "unresolved", subnet_id,
                        "subnet not present in the stored inventory"))

    if not nsg_ids and not seclist_ids:
        return _verdict(
            resource, EXPOSURE_UNKNOWN, CONF_UNKNOWN, addrs, [], [], path, [],
            reason=("Neither a network security group nor a security list could be "
                    "resolved for this resource, so the rules governing its public "
                    "address are unknown. In OCI a subnet always has at least one "
                    "security list, so this indicates a collection gap rather than an "
                    "absence of rules."),
        )

    open_ports: List[portcat.OpenPort] = []
    consulted: List[str] = []
    unresolved = 0

    for ids, kind, mech in ((nsg_ids, "nsg", "network security group"),
                            (seclist_ids, "security-list", "security list")):
        for rid in ids:
            r = _res(index, rid)
            if r is None:
                unresolved += 1
                continue
            rules = _cfg(r).get("ingress_rules")
            if not isinstance(rules, list):
                unresolved += 1
                continue
            consulted.append(_name_of(r))
            found = _oci_open_ports(rules)
            if found:
                path.append(Hop(kind, _name_of(r), rid,
                                f"{len(found)} world-open port group(s) in this {mech}"))
            open_ports.extend(found)

    if unresolved and not consulted:
        return _verdict(
            resource, EXPOSURE_UNKNOWN, CONF_UNKNOWN, addrs, [], [], path, consulted,
            reason=(f"All {unresolved} rule set(s) referenced by this resource are missing "
                    "from the stored inventory."),
        )

    open_ports = portcat.dedupe(open_ports)
    verdict = EXPOSED if open_ports else PROTECTED
    conf = CONF_MEDIUM if unresolved else CONF_HIGH
    return _verdict(
        resource, verdict, conf, addrs, open_ports,
        _port_verdicts_from_open(open_ports, verdict), path, consulted,
        reason=(f"{unresolved} rule set(s) unresolved; the verdict reflects only the ones "
                "available." if unresolved else None),
    )


def _oci_open_ports(rules: Sequence[Any]) -> List[portcat.OpenPort]:
    out: List[portcat.OpenPort] = []
    for rule in rules:
        if not isinstance(rule, dict):
            continue
        if rule.get("source_type") not in (None, "CIDR_BLOCK"):
            continue
        if not is_world_open(rule.get("source")):
            continue
        proto = str(rule.get("protocol") or "").strip().lower()
        if proto in ("all", "*"):
            out.append(portcat.ALL_PORTS)
            continue
        if proto not in ("6", "tcp", "17", "udp"):
            out.append(portcat.protocol_only(proto))
            continue
        pr = rule.get("port_range")
        if not isinstance(pr, dict):
            out.append(portcat.ALL_PORTS)
            continue
        out.extend(portcat.classify_range(pr.get("min"), pr.get("max")))
    return out


def _port_verdicts_from_open(
    open_ports: Sequence[portcat.OpenPort], verdict: str
) -> List[PortVerdict]:
    """AWS and OCI are allow-only, so there is no Deny to report — every named
    open port is EXPOSED and everything else falls to the implicit deny."""
    out = []
    for p in open_ports:
        if p.port is None:
            continue
        out.append(PortVerdict(p.port, p.service, EXPOSED,
                               "An allow rule from 0.0.0.0/0 covers this port; these rule "
                               "sets are allow-only with an implicit default deny."))
    return out


def _verdict(resource, verdict, confidence, addrs, open_ports, port_verdicts,
             path, consulted, reason=None) -> Exposure:
    return Exposure(
        resource_id=str(resource.id),
        resource_key=getattr(resource, "provider_resource_id", None),
        resource_name=resource.resource_name,
        resource_type=resource.resource_type,
        provider=getattr(resource, "_provider", "") or "",
        account_id=str(resource.account_id),
        region=getattr(resource, "region_or_zone", None),
        verdict=verdict,
        confidence=confidence,
        public_addresses=list(addrs),
        open_ports=list(open_ports),
        port_verdicts=list(port_verdicts),
        path=list(path),
        evaluated_controls=list(dict.fromkeys(consulted)),
        unknown_reason=reason,
    )


_RESOLVERS = {AWS: _aws, AZURE: _azure, OCI: _oci}


def analyse(resources: Sequence[Any], provider: str) -> List[Exposure]:
    """One Exposure per in-scope resource. Nothing is dropped.

    Resources whose type cannot be internet-facing are omitted entirely (they
    are NOT_APPLICABLE by definition, and emitting 500 of those would bury the
    handful that matter). Everything of an internet-capable type gets a verdict,
    including UNKNOWN.
    """
    resolver = _RESOLVERS.get(provider)
    if resolver is None:
        return []
    in_scope = COMPUTE_TYPES.get(provider, frozenset())
    index = {
        r.provider_resource_id: r for r in resources
        if getattr(r, "provider_resource_id", None)
    }
    out: List[Exposure] = []
    for r in resources:
        if r.resource_type not in in_scope:
            continue
        try:
            # Stash the provider so _verdict can report it without threading it
            # through every resolver signature.
            setattr(r, "_provider", provider)
            exp = resolver(r, index)
        except Exception:  # noqa: BLE001
            logger.exception("Exposure analysis failed for %s", getattr(r, "id", "?"))
            exp = _verdict(
                r, EXPOSURE_UNKNOWN, CONF_UNKNOWN, [], [], [], [], [],
                reason="Exposure analysis raised an error for this resource; it is "
                       "reported as unknown rather than omitted.",
            )
        if exp.verdict == EXPOSURE_NOT_APPLICABLE:
            continue
        out.append(exp)

    out.sort(key=lambda e: (
        0 if e.verdict == EXPOSED else 1 if e.verdict == EXPOSURE_UNKNOWN else 2,
        severity_rank(e.severity),
        e.resource_name or "",
    ))
    return out


def summarise(exposures: Sequence[Exposure]) -> Dict[str, Any]:
    """Counts the UI can state without doing arithmetic of its own — and the
    flag that decides whether "no exposure found" may be shown at all."""
    exposed = [e for e in exposures if e.verdict == EXPOSED]
    unknown = [e for e in exposures if e.verdict == EXPOSURE_UNKNOWN]
    protected = [e for e in exposures if e.verdict == PROTECTED]
    return {
        "total_evaluated": len(exposures),
        "exposed": len(exposed),
        "protected": len(protected),
        "unknown": len(unknown),
        "by_severity": {
            sev: sum(1 for e in exposed if e.severity == sev)
            for sev in ("CRITICAL", "HIGH", "MEDIUM", "INFO")
        },
        # The UI may only render a clean "no internet exposure found" state
        # when this is true. It exists because the previous implementation
        # rendered exactly that message over 25 unevaluated public VMs.
        "clean_result_trustworthy": not exposed and not unknown and bool(protected),
        "worst_severity": worst_severity([e.severity for e in exposed if e.severity]),
    }
