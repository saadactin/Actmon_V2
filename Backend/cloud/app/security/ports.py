"""The one place that decides whether an open port matters, and how much.

Previously this table lived inside exposure_service.py, which meant the rule
that flags "SSH open to the world" and the alert policy that pages someone
about it could disagree about whether port 22 is HIGH or CRITICAL. Now every
consumer — exposure analysis, the risky-port alert policies, the UI legend —
reads the same catalog.

Severity here answers one specific question: *if the whole internet can reach
this port, how bad is that?* It is not a judgement about the service in
general. Postgres on a private subnet is fine; Postgres on 0.0.0.0/0 is a
data breach waiting for someone to notice, which is why 5432 is CRITICAL while
443 is INFO.

The distinction that earns the catalog its keep is **DATA_PORTS**. A database
reachable from the internet is categorically worse than a management port,
because the management port at least expects to be attacked and usually wants
a key, while the database will happily answer a query. The alert policies use
this set directly (§28 Policy 5).
"""
from __future__ import annotations

from typing import Dict, List, NamedTuple, Optional, Tuple

from app.security.model import CRITICAL, HIGH, INFO, MEDIUM


class PortInfo(NamedTuple):
    port: int
    service: str
    severity: str
    # Short reason, shown verbatim in the finding's rationale. An analyst
    # reading "3389 RDP CRITICAL" should not have to infer why.
    why: str


# ── Remote management / shell ────────────────────────────────────────────────
_MANAGEMENT: Tuple[PortInfo, ...] = (
    PortInfo(22, "SSH", HIGH,
             "Interactive shell access. Exposed SSH is the most-scanned port on the internet "
             "and the entry point for credential-stuffing and key-brute-force campaigns."),
    PortInfo(23, "Telnet", CRITICAL,
             "Telnet transmits credentials in cleartext and has no transport security at all. "
             "There is no configuration in which public Telnet is acceptable."),
    PortInfo(3389, "RDP", CRITICAL,
             "Full interactive desktop access to a Windows host. Public RDP is the single most "
             "common initial-access vector in ransomware incident reports."),
    PortInfo(5900, "VNC", CRITICAL,
             "Remote desktop with frequently-absent or weak authentication; many VNC servers "
             "accept a connection with no password at all."),
    PortInfo(5985, "WinRM", HIGH,
             "Windows Remote Management — remote command execution, unencrypted on this port."),
    PortInfo(5986, "WinRM (HTTPS)", HIGH,
             "Windows Remote Management — remote command execution over TLS."),
    PortInfo(135, "MS-RPC / DCOM", HIGH,
             "RPC endpoint mapper. Historically a rich source of remote-code-execution "
             "vulnerabilities and should never face the internet."),
    PortInfo(139, "NetBIOS", HIGH,
             "Legacy Windows name/session service. Leaks host and share information."),
    PortInfo(445, "SMB", CRITICAL,
             "Windows file sharing. The vector for EternalBlue and the worm families built on "
             "it; internet-facing SMB is treated as compromised by most responders."),
)

# ── Databases and data stores ───────────────────────────────────────────────
# Every entry here is CRITICAL when world-open. These services answer queries;
# an attacker who reaches one does not need a further exploit to read data.
_DATA: Tuple[PortInfo, ...] = (
    PortInfo(1433, "Microsoft SQL Server", CRITICAL,
             "Relational database. Directly queryable once reachable."),
    PortInfo(1521, "Oracle DB Listener", CRITICAL,
             "Relational database listener. Directly queryable once reachable."),
    PortInfo(3306, "MySQL / MariaDB", CRITICAL,
             "Relational database. Directly queryable once reachable."),
    PortInfo(5432, "PostgreSQL", CRITICAL,
             "Relational database. Directly queryable once reachable."),
    PortInfo(27017, "MongoDB", CRITICAL,
             "Document database. Historically shipped with no authentication by default; "
             "public MongoDB instances are routinely mass-harvested."),
    PortInfo(6379, "Redis", CRITICAL,
             "In-memory store with no authentication by default and a command set that can "
             "write files — public Redis is frequently escalated to remote code execution."),
    PortInfo(9200, "Elasticsearch HTTP", CRITICAL,
             "Search index with a full REST API and no authentication in the default "
             "distribution. Public clusters are a well-known source of mass data leaks."),
    PortInfo(9300, "Elasticsearch transport", HIGH,
             "Inter-node cluster transport. Should never be reachable outside the cluster."),
    PortInfo(11211, "Memcached", HIGH,
             "Unauthenticated cache, and a large UDP amplification vector for DDoS reflection."),
    PortInfo(5984, "CouchDB", HIGH,
             "Document database with an HTTP API."),
    PortInfo(2379, "etcd", CRITICAL,
             "Cluster configuration store — commonly holds Kubernetes secrets in plaintext."),
    PortInfo(9092, "Kafka", HIGH,
             "Message broker. Public access allows reading and injecting stream data."),
    PortInfo(5672, "AMQP / RabbitMQ", HIGH,
             "Message broker. Public access allows reading and injecting queue messages."),
    PortInfo(1025, "MongoDB (alt)", HIGH,
             "Alternate MongoDB port, used when the default is already bound. Carries "
             "the same risk as 27017 and is scanned almost as often."),
    PortInfo(7000, "Cassandra", HIGH,
             "Cassandra's inter-node gossip and replication port. It should never leave "
             "the cluster's own subnet; public exposure allows a rogue node to join."),
    PortInfo(9042, "Cassandra CQL", CRITICAL,
             "Wide-column store query interface. Directly queryable once reachable."),
)

# ── File transfer and directory ─────────────────────────────────────────────
_TRANSFER: Tuple[PortInfo, ...] = (
    PortInfo(21, "FTP", HIGH,
             "Cleartext file transfer, including credentials. Anonymous FTP is common."),
    PortInfo(20, "FTP data", MEDIUM,
             "FTP's data channel. Open to the internet it indicates an active FTP "
             "service, whose control channel on port 21 carries credentials in "
             "cleartext."),
    PortInfo(69, "TFTP", HIGH,
             "Trivial FTP has no authentication whatsoever."),
    PortInfo(2049, "NFS", HIGH,
             "Network file system. Public NFS exports frequently allow unauthenticated reads."),
    PortInfo(389, "LDAP", HIGH,
             "Directory service, cleartext. Exposes the identity structure of the organisation."),
    PortInfo(636, "LDAPS", MEDIUM,
             "Directory service over TLS. Still exposes the directory to the internet."),
    PortInfo(88, "Kerberos", HIGH,
             "Authentication service. Public exposure enables offline ticket cracking."),
)

# ── Mail ─────────────────────────────────────────────────────────────────────
_MAIL: Tuple[PortInfo, ...] = (
    PortInfo(25, "SMTP", MEDIUM,
             "Mail transfer. Expected to be public on a mail server; on anything else it "
             "suggests an open relay or a compromised host sending spam."),
    PortInfo(110, "POP3", MEDIUM, "Mail retrieval, cleartext credentials."),
    PortInfo(143, "IMAP", MEDIUM, "Mail retrieval, cleartext credentials."),
    PortInfo(465, "SMTPS", INFO, "Mail submission over TLS — normal on a mail server."),
    PortInfo(587, "SMTP submission", INFO, "Mail submission — normal on a mail server."),
    PortInfo(993, "IMAPS", INFO, "Mail retrieval over TLS — normal on a mail server."),
    PortInfo(995, "POP3S", INFO, "Mail retrieval over TLS — normal on a mail server."),
)

# ── Infrastructure and orchestration ────────────────────────────────────────
_INFRA: Tuple[PortInfo, ...] = (
    PortInfo(53, "DNS", MEDIUM,
             "Name service. A public resolver is an amplification vector; a public "
             "authoritative server is normal."),
    PortInfo(161, "SNMP", HIGH,
             "Device management. Default community strings are still widespread and expose "
             "the full device configuration."),
    PortInfo(623, "IPMI", CRITICAL,
             "Out-of-band server management — power control and console below the OS."),
    PortInfo(2375, "Docker API (plain)", CRITICAL,
             "Unauthenticated Docker daemon. Equivalent to root on the host."),
    PortInfo(2376, "Docker API (TLS)", HIGH,
             "Docker daemon over TLS. Still full container control if a cert leaks."),
    PortInfo(6443, "Kubernetes API", HIGH,
             "Cluster control plane. Public exposure is common but must be paired with "
             "strong authentication and, ideally, an IP allow-list."),
    PortInfo(10250, "Kubelet API", CRITICAL,
             "Node agent. Historically allowed unauthenticated command execution in pods."),
    PortInfo(4444, "Metasploit / misc", HIGH,
             "Common default listener for reverse shells and post-exploitation tooling."),
)

# ── Web ──────────────────────────────────────────────────────────────────────
# INFO, not because they are safe, but because a public web port is the normal,
# intended configuration for most workloads. Flagging every 443 as a finding is
# how a security tool trains its users to ignore it.
_WEB: Tuple[PortInfo, ...] = (
    PortInfo(80, "HTTP", INFO,
             "Web traffic. Expected to be public; note that plain HTTP offers no transport "
             "encryption, so it is worth confirming a redirect to HTTPS exists."),
    PortInfo(443, "HTTPS", INFO, "Web traffic over TLS. Expected to be public."),
    PortInfo(8080, "HTTP alternate", MEDIUM,
             "Non-standard web port. Frequently an admin console, a debug endpoint or an "
             "application server that was never meant to be public."),
    PortInfo(8443, "HTTPS alternate", MEDIUM,
             "Non-standard web port over TLS. Frequently an admin console."),
    PortInfo(8000, "HTTP dev server", MEDIUM,
             "Conventional development-server port; rarely intended to be internet-facing."),
    PortInfo(3000, "HTTP dev server", MEDIUM,
             "Conventional development-server port; rarely intended to be internet-facing."),
    PortInfo(5000, "HTTP dev server", MEDIUM,
             "Conventional development-server port; rarely intended to be internet-facing."),
    PortInfo(9090, "Prometheus / admin", MEDIUM,
             "Metrics or admin interface — exposes internal topology and often has no auth."),
    PortInfo(15672, "RabbitMQ management", HIGH,
             "Broker management console, with well-known default credentials."),
)

_ALL: Tuple[PortInfo, ...] = _MANAGEMENT + _DATA + _TRANSFER + _MAIL + _INFRA + _WEB

CATALOG: Dict[int, PortInfo] = {p.port: p for p in _ALL}

# Sets the alert-policy engine consumes directly, so a policy called "public
# database" and this catalog can never drift apart.
DATA_PORTS = frozenset(p.port for p in _DATA)
MANAGEMENT_PORTS = frozenset(p.port for p in _MANAGEMENT)
WEB_PORTS = frozenset(p.port for p in _WEB)

# Named policy targets (§28). Kept here rather than in policies.py because the
# port numbers are the catalog's business.
SSH_PORTS = frozenset({22})
RDP_PORTS = frozenset({3389})

# Above this many ports in one rule, listing them individually is noise; the
# range itself is the finding.
_RANGE_SUMMARY_THRESHOLD = 12
# A range this wide is effectively "everything", regardless of the exact bounds.
_RANGE_CRITICAL_SPAN = 50


class OpenPort(NamedTuple):
    """One decomposed, classified consequence of a world-open rule."""

    port: Optional[int]              # None for a summarised range
    service: Optional[str]
    severity: str
    why: str
    port_range: Optional[Tuple[int, int]] = None

    @property
    def label(self) -> str:
        if self.port is not None:
            return f"{self.port}" + (f" ({self.service})" if self.service else "")
        if self.port_range:
            return f"{self.port_range[0]}-{self.port_range[1]}"
        return self.service or "all ports"

    def to_dict(self) -> dict:
        return {
            "port": self.port,
            "service": self.service,
            "severity": self.severity,
            "why": self.why,
            "port_range": list(self.port_range) if self.port_range else None,
            "label": self.label,
        }


def describe(port: int) -> Optional[PortInfo]:
    return CATALOG.get(port)


ALL_PORTS = OpenPort(
    port=None, service="ALL PORTS", severity=CRITICAL,
    why=("Every TCP and UDP port is reachable from the entire internet. Whatever is "
         "listening on this host is reachable, including services the owner may not "
         "know are running."),
    port_range=(0, 65535),
)


def classify_range(pmin: Optional[int], pmax: Optional[int]) -> List[OpenPort]:
    """Decompose one world-open port range into the findings worth naming.

    The reason this is not simply "return the range": a rule opening 22-3389
    contains SSH, MSSQL, MySQL and RDP. Reporting it as a single "3368 ports"
    entry technically states the risk while completely burying it. So known
    ports inside the range are named individually and the remainder is
    summarised, which is what lets an analyst see "RDP" in a list of hundreds.
    """
    if pmin is None and pmax is None:
        return [ALL_PORTS]
    if pmin is None or pmax is None:
        # Half-open is not a thing either provider reports; treat as unknown
        # breadth rather than inventing a bound.
        return [ALL_PORTS]
    if pmin > pmax:
        pmin, pmax = pmax, pmin
    if pmin <= 0 and pmax >= 65535:
        return [ALL_PORTS]

    named = [
        OpenPort(port=info.port, service=info.service, severity=info.severity, why=info.why)
        for p, info in sorted(CATALOG.items())
        if pmin <= p <= pmax
    ]

    span = pmax - pmin + 1
    if span == 1:
        if named:
            return named
        # A single unrecognised port is still a finding — an attacker does not
        # restrict themselves to well-known numbers — but a modest one.
        return [OpenPort(
            port=pmin, service=None, severity=MEDIUM,
            why=("This port is open to the entire internet. It is not a well-known service, "
                 "so confirm what is listening on it and whether it should be public."),
        )]

    # A wide range: keep the named ports AND add a summary, because "22 (SSH)"
    # alone would understate that 3,000 other ports are also open.
    unnamed = span - len(named)
    if unnamed > 0:
        sev = CRITICAL if span > _RANGE_CRITICAL_SPAN else HIGH
        named.append(OpenPort(
            port=None,
            service=f"{unnamed} further port{'s' if unnamed != 1 else ''}",
            severity=sev,
            why=(f"Ports {pmin}-{pmax} are open to the entire internet ({span} ports). A range "
                 "this wide almost never reflects an intended rule and exposes whatever "
                 "happens to be listening."),
            port_range=(pmin, pmax),
        ))
    return named


def protocol_only(protocol: str) -> OpenPort:
    """A rule that opens a whole protocol with no port concept (ICMP, and
    AWS's `-1` meaning every protocol)."""
    proto = (protocol or "ip").lower()
    if proto in ("1", "icmp", "icmpv6", "58"):
        return OpenPort(
            port=None, service="ICMP", severity=INFO,
            why=("ICMP is reachable from the internet. This allows host discovery and "
                 "traceroute but does not itself expose a service."),
        )
    return OpenPort(
        port=None, service=f"{proto} (all ports)", severity=CRITICAL,
        why=(f"Protocol {proto} is open on every port to the entire internet."),
    )


def worst_of(open_ports: List[OpenPort]) -> Optional[str]:
    from app.security.model import worst_severity
    return worst_severity([p.severity for p in open_ports])


def dedupe(open_ports: List[OpenPort]) -> List[OpenPort]:
    """Two security groups can both open 22; the resource is exposed once."""
    seen = set()
    out: List[OpenPort] = []
    for p in open_ports:
        key = (p.port, p.service, p.port_range)
        if key in seen:
            continue
        seen.add(key)
        out.append(p)
    return out
