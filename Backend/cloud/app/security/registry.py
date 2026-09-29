"""The security rule registry: every condition this product checks, declared once.

Dispatch is keyed on **(provider, resource_type)**, never on resource_type
alone. That is not a stylistic preference — it is the fix for a live bug. Three
resource type names are used by more than one cloud:

    APIGateway            AWS + OCI
    NetworkSecurityGroup  Azure + OCI
    Function              OCI (AWS calls its own LambdaFunction)

The old engine branched on `if rtype == "APIGateway":` inside one loop, so
OCI's rule ran against AWS resources. On the live AWS account that produced
three findings titled *"OCI API Gateway Is Publicly Accessible"* — for AWS API
Gateways, whose config carries only `{protocol, target}` and no
`endpoint_type` at all. The rule read `config.get("endpoint_type", "PUBLIC")`,
so an **absent** field became a MEDIUM finding, which then passed both
compliance gates and was cited against PCI Req 1.4. A fabricated control
violation, on the wrong cloud, from data that was never collected.

Both halves of that are structurally impossible here:

* A rule declares its provider and the registry will not hand it another
  provider's resources. `_selfcheck()` refuses to import if a rule declares a
  resource type its own provider's scanner never produces.
* An evaluator returns a **verdict**, and `UNKNOWN` is a first-class outcome.
  `_flag_if(...)` and `_bool_field(...)` below make "absent means unknown" the
  path of least resistance, so the next rule anyone adds gets it right by
  default rather than by remembering to.

Every rule also declares its remediation in provider-specific terms, because
"improve security" is not a remediation, and the compliance controls it
assesses live in controls.py keyed by these `rule_id`s.

**Rule versions.** Bump `version` whenever the *meaning* of a rule changes, so
a finding whose severity or logic shifted is explainable rather than mysterious
("why did this go from HIGH to INFO last Tuesday?"). Several rules below start
at 2.0 precisely because their meaning changed in this rewrite — the
public-IP rules in particular, which used to assert exposure and now only
report attack surface.
"""
from __future__ import annotations

import ipaddress
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, NamedTuple, Optional, Tuple

from app.security import ports as portcat
from app.security.model import (
    AWS, AZURE, CAT_CONFIGURATION, CAT_COST, CAT_DATA_PROTECTION, CAT_ENCRYPTION,
    CAT_EXPOSURE, CAT_GOVERNANCE, CAT_IAM, CAT_MAINTENANCE,
    CAT_NETWORKING, CAT_PERFORMANCE, CAT_RESILIENCE, CATEGORIES, CONF_HIGH,
    CONF_LOW, CONF_MEDIUM, CONF_UNKNOWN, COV_CREDENTIALS, COV_ENCRYPTION, COV_EXPOSURE,
    COV_IAM, COV_NETWORK,
    CRITICAL, HIGH, INFO, LOW, MEDIUM, NOT_SCANNED, OCI, SAFE,
    SEVERITIES, UNKNOWN, VULNERABLE,
)

# ── What an evaluator receives and returns ───────────────────────────────────


class Ctx(NamedTuple):
    """Everything a rule may look at. Deliberately narrow: a rule that needs
    the whole database is a rule that belongs in the engine, not the registry.

    `index` maps provider_resource_id -> resource for the relationship walks
    (a NIC's NSG, a subnet's security lists). `by_type` is the same inventory
    grouped, for the account-level rules that need to know whether any
    resource of a kind exists before claiming NOT_APPLICABLE.
    """

    resource: Any
    provider: str
    config: Dict[str, Any]
    raw: Dict[str, Any]
    tags: Dict[str, Any]
    index: Dict[str, Any]
    by_type: Dict[str, List[Any]]


class Outcome(NamedTuple):
    """A rule's conclusion about one resource.

    `detail` is appended to the rule's static description so the finding reads
    about *this* resource ("13 inbound rules") rather than the rule in the
    abstract. `discriminator` splits several findings of one rule on one
    resource — one per open port, say — so each resolves independently.
    """

    verdict: str
    evidence: Dict[str, Any] = {}
    detail: str = ""
    severity: Optional[str] = None      # override the rule's declared severity
    confidence: Optional[str] = None
    discriminator: Optional[str] = None
    # Why the verdict is UNKNOWN. Shown verbatim; this is what turns "could not
    # determine" from a shrug into an actionable statement about a scanner gap.
    unknown_reason: Optional[str] = None


# A rule returns one Outcome, several, or None for "does not apply".
Evaluator = Callable[[Ctx], Any]


@dataclass(frozen=True)
class SecurityRule:
    rule_id: str
    version: str
    provider: str
    resource_types: Tuple[str, ...]
    title: str
    severity: str
    category: str
    description: str          # what the rule checks, in general terms
    rationale: str            # WHY it matters — never generic
    remediation: str          # provider-specific and actionable
    evaluate: Optional[Evaluator] = None
    confidence: str = CONF_HIGH
    # Collapse N findings into one with a drill-down list (§53). Used only by
    # the tag rule, which would otherwise be 550 of an account's 606 findings.
    aggregate: bool = False
    # Which coverage dimension this rule's UNKNOWNs count against (§57).
    coverage: Optional[str] = None
    # True for rules produced by the exposure/IAM analysers rather than by a
    # per-resource evaluator. They live here so rule_version, remediation and
    # control mapping work identically for every finding in the system.
    synthetic: bool = False

    @property
    def key(self) -> str:
        return f"{self.rule_id}@{self.version}"


# ── Small helpers that make the safe thing the easy thing ────────────────────

_WORLD_CIDRS = {"0.0.0.0/0", "::/0"}
# Azure's source_address_prefix accepts service-tag-like tokens meaning
# "anywhere on the internet" in place of a CIDR.
_AZURE_WORLD_TOKENS = {"*", "internet", "any"}


def is_world_open(value: Optional[str]) -> bool:
    """Whether a rule's source scope is the entire internet.

    Shared by every provider's rules and by the exposure analyser, so "what
    counts as the whole internet" is decided once.
    """
    if not value:
        return False
    v = str(value).strip()
    if v in _WORLD_CIDRS or v.lower() in _AZURE_WORLD_TOKENS:
        return True
    try:
        return ipaddress.ip_network(v, strict=False).prefixlen == 0
    except ValueError:
        return False


def _bool_field(config: Dict[str, Any], key: str) -> Optional[bool]:
    """Read a tri-state boolean: True, False, or None for absent/unusable.

    The whole point is that `None` is returned rather than coerced. A rule that
    writes `config.get("is_public", False)` cannot tell a genuinely private
    resource from one whose privacy was never reported.
    """
    if key not in config:
        return None
    v = config[key]
    if isinstance(v, bool):
        return v
    if isinstance(v, str):
        s = v.strip().lower()
        if s in ("true", "enabled", "yes", "on", "1"):
            return True
        if s in ("false", "disabled", "no", "off", "0"):
            return False
    return None


def _unknown(reason: str, **evidence) -> Outcome:
    return Outcome(
        verdict=UNKNOWN, evidence=evidence, confidence=CONF_UNKNOWN,
        unknown_reason=reason,
    )


def _flag_if(condition: Optional[bool], *, unknown_reason: str,
             detail: str = "", severity: Optional[str] = None,
             confidence: Optional[str] = None, **evidence) -> Outcome:
    """The standard three-way return.

    `condition is None` -> UNKNOWN, never SAFE. That single line is the
    difference between "this storage account does not allow public blob
    access" and "nobody ever asked whether it does".
    """
    if condition is None:
        return _unknown(unknown_reason, **evidence)
    if condition:
        return Outcome(verdict=VULNERABLE, evidence=evidence, detail=detail,
                       severity=severity, confidence=confidence)
    return Outcome(verdict=SAFE, evidence=evidence)


def _private_ip(ip: Optional[str]) -> Optional[bool]:
    """None when the address is absent or unparseable — an unparseable address
    is not evidence of a public one."""
    if not ip:
        return None
    try:
        return ipaddress.ip_address(str(ip).strip()).is_private
    except ValueError:
        return None


# ═════════════════════════════════════════════════════════════════════════════
# AWS
# ═════════════════════════════════════════════════════════════════════════════


def _aws_sg_world_open_port(ctx: Ctx, port: int) -> Any:
    """Is `port` reachable from 0.0.0.0/0 or ::/0 through this security group?

    Reads raw_data.IpPermissions because the normalized config only keeps a
    COUNT of inbound rules. If raw_data has no IpPermissions key the answer is
    UNKNOWN: an empty rule list and an uncollected rule list look identical in
    a count, and only one of them is safe.
    """
    perms = ctx.raw.get("IpPermissions")
    if perms is None:
        return _unknown(
            "The security group's inbound rules (IpPermissions) were not captured in the "
            "stored provider response, so its exposure cannot be evaluated.",
            checked_port=port,
        )
    if not isinstance(perms, list):
        return _unknown("Stored IpPermissions is not a rule list.", checked_port=port)

    for perm in perms:
        if not isinstance(perm, dict):
            continue
        sources = [r.get("CidrIp") for r in perm.get("IpRanges") or [] if isinstance(r, dict)]
        sources += [r.get("CidrIpv6") for r in perm.get("Ipv6Ranges") or [] if isinstance(r, dict)]
        world = [s for s in sources if is_world_open(s)]
        if not world:
            continue
        proto = str(perm.get("IpProtocol") or "").lower()
        lo, hi = perm.get("FromPort"), perm.get("ToPort")
        covers = (
            proto == "-1"                                    # every protocol, every port
            or (lo is None and hi is None and proto in ("tcp", "udp"))
            or (lo is not None and hi is not None and lo <= port <= hi)
        )
        if covers:
            return Outcome(
                verdict=VULNERABLE,
                detail=f"Source {world[0]} covers port {port} (protocol {proto or 'any'}).",
                evidence={
                    "port": port, "protocol": proto or "any",
                    "from_port": lo, "to_port": hi,
                    "source_cidrs": world,
                    "rule": {k: perm.get(k) for k in
                             ("IpProtocol", "FromPort", "ToPort") if k in perm},
                },
            )
    return Outcome(verdict=SAFE, evidence={"checked_port": port, "rules_examined": len(perms)})


def _aws_sg_ssh(ctx: Ctx):
    return _aws_sg_world_open_port(ctx, 22)


def _aws_sg_rdp(ctx: Ctx):
    return _aws_sg_world_open_port(ctx, 3389)


def _aws_sg_default(ctx: Ctx):
    name = (ctx.resource.resource_name or "")
    return _flag_if(
        name == "default",
        unknown_reason="Security group name unavailable.",
        detail="This is the VPC's default security group.",
        group_name=name, vpc_id=ctx.config.get("vpc_id"),
    )


def _not_yet_collected(field_name: str) -> Outcome:
    """The field this rule reads is collected by the current scanner but not by
    the one that produced this row — the answer arrives with the next scan.
    NOT_SCANNED rather than UNKNOWN: nothing is wrong with the provider data,
    it simply has not been asked for yet."""
    return Outcome(
        verdict=NOT_SCANNED, confidence=CONF_UNKNOWN,
        unknown_reason=(f"'{field_name}' is collected from the next discovery scan "
                        "onward; this resource was last scanned before that."),
    )


def _aws_sg_default_allows_traffic(ctx: Ctx):
    """CIS: the default security group of every VPC restricts all traffic —
    i.e. has no inbound and no outbound rule at all. Different from
    AWS_SG_DEFAULT_IN_USE, which asks whether anything is attached to it."""
    if (ctx.resource.resource_name or "") != "default":
        return None
    inbound = ctx.raw.get("IpPermissions")
    outbound = ctx.raw.get("IpPermissionsEgress")
    if inbound is None or outbound is None:
        return _unknown("The default security group's rules were not captured in the "
                        "stored provider response.", vpc_id=ctx.config.get("vpc_id"))
    return _flag_if(
        bool(inbound) or bool(outbound), unknown_reason="",
        detail=(f"The default security group has {len(inbound)} inbound and "
                f"{len(outbound)} outbound rule(s); it should have none."),
        vpc_id=ctx.config.get("vpc_id"), inbound_rules=len(inbound),
        outbound_rules=len(outbound),
    )


def _aws_ec2_imdsv2(ctx: Ctx):
    opts = ctx.raw.get("MetadataOptions")
    if not isinstance(opts, dict) or "HttpTokens" not in opts:
        return _unknown("The instance's metadata options were not captured.")
    if str(opts.get("HttpEndpoint") or "").lower() == "disabled":
        # No metadata service at all is stricter than IMDSv2 — nothing to flag.
        return Outcome(verdict=SAFE, evidence={"http_endpoint": "disabled"})
    tokens = str(opts.get("HttpTokens") or "").lower()
    return _flag_if(
        tokens != "required", unknown_reason="",
        detail=f"HttpTokens is '{tokens or 'unset'}'; IMDSv1 requests are still accepted.",
        http_tokens=tokens or None, http_endpoint=opts.get("HttpEndpoint"),
    )


def _aws_sg_rule_count(ctx: Ctx):
    n = ctx.config.get("inbound_rules")
    if not isinstance(n, int):
        return _unknown("Inbound rule count not recorded for this security group.")
    return _flag_if(
        n >= 3,
        unknown_reason="",
        detail=f"{n} inbound rules are attached.",
        inbound_rules=n, threshold=3,
    )


def _aws_s3_public_access(ctx: Ctx):
    """S3 Public Access Block.

    The scanner sets this to None on ANY exception from
    `get_public_access_block` — which conflates two genuinely different
    situations: the bucket has no PAB configuration (really is unblocked) and
    the caller was denied permission to read it. Because those are
    indistinguishable in the stored data, None is UNKNOWN. Only an explicitly
    reported configuration with a false flag is a confirmed finding.
    """
    pab = ctx.config.get("public_access_block")
    if pab is None:
        return _unknown(
            "Public Access Block configuration is absent from the stored inventory. The "
            "scanner records None both when a bucket has no PAB configuration and when "
            "s3:GetBucketPublicAccessBlock was denied, so this cannot be resolved without "
            "a successful re-scan.",
        )
    if not isinstance(pab, dict):
        return _unknown("Stored Public Access Block value is not a configuration object.")

    off = [k for k in ("BlockPublicAcls", "IgnorePublicAcls",
                       "BlockPublicPolicy", "RestrictPublicBuckets")
           if pab.get(k) is not True]
    return _flag_if(
        bool(off),
        unknown_reason="",
        detail=f"Not enabled: {', '.join(off)}." if off else "",
        public_access_block=pab, disabled_settings=off,
    )


def _aws_s3_encryption(ctx: Ctx):
    enc = ctx.config.get("encryption")
    if "encryption" not in ctx.config:
        return _unknown("Default-encryption state was not collected for this bucket.")
    if enc is None or str(enc).strip().lower() in ("", "none", "disabled"):
        return Outcome(verdict=VULNERABLE, evidence={"encryption": enc},
                       detail="No default server-side encryption rule is configured.")
    return Outcome(verdict=SAFE, evidence={"encryption": enc})


def _aws_s3_versioning(ctx: Ctx):
    v = ctx.config.get("versioning")
    if "versioning" not in ctx.config or v is None:
        return _unknown("Versioning state was not collected for this bucket.")
    return _flag_if(
        str(v).strip().lower() != "enabled",
        unknown_reason="",
        detail=f"Versioning is {v}.",
        versioning=v,
    )


def _aws_rds_encryption(ctx: Ctx):
    return _flag_if(
        _bool_field(ctx.config, "storage_encrypted") is False
        if "storage_encrypted" in ctx.config else None,
        unknown_reason="Storage-encryption state was not collected for this instance.",
        detail="Storage encryption is disabled.",
        storage_encrypted=ctx.config.get("storage_encrypted"),
        engine=ctx.config.get("engine"),
    )


def _aws_rds_public(ctx: Ctx):
    return _flag_if(
        _bool_field(ctx.config, "publicly_accessible"),
        unknown_reason="Public-accessibility state was not collected for this instance.",
        detail="The instance is marked publicly accessible, so it resolves to a public "
               "address and is reachable from anywhere its security group permits.",
        publicly_accessible=ctx.config.get("publicly_accessible"),
        endpoint=ctx.resource.ip_address,
    )


def _aws_dynamodb_key(ctx: Ctx):
    """An absent SSEDescription means the AWS-owned default key, which is real
    encryption — hence INFO, not a vulnerability. But it is only meaningful if
    DescribeTable data was actually stored; with no raw_data at all we know
    nothing."""
    # An empty dict is not evidence that DescribeTable ran — it is evidence that
    # nothing was stored. Only a populated response can support the inference
    # "no SSEDescription means the AWS-owned default key".
    if not isinstance(ctx.resource.raw_data, dict) or not ctx.resource.raw_data:
        return _unknown("DescribeTable response was not stored for this table, so the "
                        "absence of an SSEDescription proves nothing about its key.")
    has_sse = "SSEDescription" in ctx.resource.raw_data
    return _flag_if(
        not has_sse,
        unknown_reason="",
        detail="No SSEDescription is present, which means the table uses the default "
               "AWS-owned key rather than a customer-managed KMS key.",
        sse_description=ctx.resource.raw_data.get("SSEDescription"),
    )


_DEPRECATED_RUNTIMES = (
    "python2.7", "python3.6", "python3.7", "python3.8",
    "nodejs10.x", "nodejs12.x", "nodejs14.x", "nodejs16.x",
    "ruby2.5", "ruby2.7", "dotnetcore2.1", "dotnetcore3.1", "go1.x", "java8",
)


def _aws_lambda_runtime(ctx: Ctx):
    rt = ctx.config.get("runtime")
    if not rt:
        return _unknown("Runtime was not collected for this function.")
    hit = next((d for d in _DEPRECATED_RUNTIMES if d == str(rt).strip().lower()), None)
    return _flag_if(
        hit is not None,
        unknown_reason="",
        detail=f"Runtime {rt} is deprecated or past end-of-support.",
        runtime=rt, matched=hit,
    )


def _aws_lambda_memory(ctx: Ctx):
    m = ctx.config.get("memory_mb")
    if not isinstance(m, int):
        return _unknown("Memory allocation was not collected for this function.")
    return _flag_if(
        m < 256, unknown_reason="",
        detail=f"{m} MB allocated. CPU is allocated proportionally to memory on Lambda, "
               f"so a low setting also limits CPU.",
        memory_mb=m, threshold=256,
    )


def _aws_iam_long_session(ctx: Ctx):
    d = ctx.config.get("max_session_duration")
    if not isinstance(d, int):
        return _unknown("Maximum session duration was not collected for this role.")
    return _flag_if(
        d > 43200, unknown_reason="",
        detail=f"Sessions may last up to {d // 3600}h.",
        max_session_duration=d, threshold_seconds=43200,
    )


def _aws_subnet_auto_public_ip(ctx: Ctx):
    return _flag_if(
        _bool_field(ctx.config, "public_ip_on_launch"),
        unknown_reason="Auto-assign-public-IP setting was not collected for this subnet.",
        detail="Instances launched here receive a public IP automatically, so a workload "
               "becomes internet-facing without anyone choosing that explicitly.",
        public_ip_on_launch=ctx.config.get("public_ip_on_launch"),
        is_default_subnet=ctx.config.get("is_default"),
        cidr=ctx.config.get("cidr_block"),
    )


def _aws_instance_public_ip(ctx: Ctx):
    """Attack-surface note, NOT an exposure verdict.

    v1 of this rule was HIGH and read "is directly reachable from the
    internet", which is simply not what a public IP means — reachability
    depends on the security group. Real reachability is decided by
    exposure.py, which walks the rule set. This rule now records the surface
    at INFO and says so.
    """
    ip = ctx.config.get("public_ip") or ctx.resource.ip_address
    priv = _private_ip(ip)
    if priv is None:
        return Outcome(verdict=SAFE, evidence={"public_ip": None}) if not ip else _unknown(
            "Address could not be parsed, so it cannot be classified as public or private.",
            address=ip,
        )
    return _flag_if(
        not priv, unknown_reason="",
        detail=f"Public address {ip}. Whether anything is actually reachable on it "
               f"depends on the attached security groups — see Internet Exposure.",
        public_ip=ip,
    )


def _aws_instance_stopped(ctx: Ctx):
    st = (ctx.resource.status or "").strip().lower()
    if not st:
        return _unknown("Instance state was not collected.")
    return _flag_if(
        st in ("stopped", "stopping"), unknown_reason="",
        detail=f"State is {st}; attached EBS volumes continue to bill.",
        status=st,
    )


def _aws_elb_listeners(ctx: Ctx):
    """Declared and honest: the AWS scanner stores scheme, type, VPC, subnets,
    security groups, backends and target groups for a load balancer, but never
    calls DescribeListeners. So TLS policy and protocol cannot be assessed, and
    this rule reports NOT_SCANNED for every load balancer rather than passing
    a control it never examined."""
    return Outcome(
        verdict=NOT_SCANNED,
        evidence={"collected_keys": sorted(ctx.config.keys())},
        unknown_reason="The discovery scanner does not call DescribeListeners, so listener "
                       "protocol and TLS policy are not in the inventory.",
    )



# AWS IAM wildcard grants.
#
# `config.broad_access` is computed during discovery by
# app/providers/aws/iam_policy.py from the role's attached and inline policy
# documents, as entries like "s3:full", "ec2:write", "iam:full". Wildcards are
# summarised there rather than expanded — a role with `Action: "*"` grants
# hundreds of thousands of individual permissions and listing them is noise, so
# the breadth is the finding.
#
# Three separate rules rather than one with a severity switch, because they are
# genuinely different problems and an operator filters on them differently:
# escalation is unbounded, full is broad-and-destructive, write is broad.

_IAM_ESCALATION_SERVICES = frozenset({"iam", "sts", "organizations"})


def _aws_broad_access(ctx: Ctx) -> Optional[List[str]]:
    """The role's wildcard grants, or None when the policy documents were never
    collected — which must not read as "this role has no wildcards"."""
    if "broad_access" not in ctx.config and "accessible_resources" not in ctx.config:
        return None
    ba = ctx.config.get("broad_access")
    return [str(g) for g in ba] if isinstance(ba, list) else []


def _aws_iam_full_admin(ctx: Ctx):
    """`*:*` — every action on every resource. Owned by this rule alone; the
    escalation and wildcard rules skip `*:full` so one administrator role is
    one finding, not three."""
    grants = _aws_broad_access(ctx)
    if grants is None:
        return _unknown(
            "This role's policy documents were not collected, so its permissions could "
            "not be analysed."
        )
    return _flag_if(
        "*:full" in grants, unknown_reason="",
        detail="The role is allowed every action on every resource (Action \"*\", "
               "Resource \"*\") — full administrator access to the account.",
        all_grants=sorted(grants),
    )


def _aws_iam_escalation(ctx: Ctx):
    grants = _aws_broad_access(ctx)
    if grants is None:
        return _unknown(
            "This role's policy documents were not collected, so its permissions could "
            "not be analysed."
        )
    # "*:write" (write on every service) includes IAM; "*:full" is reported by
    # the full-administrator rule instead.
    hits = sorted({g for g in grants
                   if g.split(":")[0].lower() in _IAM_ESCALATION_SERVICES
                   or g.lower() == "*:write"})
    return _flag_if(
        bool(hits), unknown_reason="",
        detail=f"Wildcard grants over identity services: {', '.join(hits)}.",
        wildcard_grants=hits, all_grants=sorted(grants),
        scoped_grant_count=len(ctx.config.get("accessible_resources") or []),
    )


def _aws_iam_wildcard_full(ctx: Ctx):
    grants = _aws_broad_access(ctx)
    if grants is None:
        return _unknown(
            "This role's policy documents were not collected, so its permissions could "
            "not be analysed."
        )
    full = sorted({g for g in grants if g.lower().endswith(":full")})
    # Escalation and `*:*` are reported by their own rules; do not double-count.
    full = [g for g in full if g.split(":")[0].lower() not in _IAM_ESCALATION_SERVICES
            and not g.startswith("*:")]
    if not full:
        return Outcome(verdict=SAFE, evidence={"all_grants": sorted(grants)})
    return Outcome(
        verdict=VULNERABLE,
        severity=CRITICAL if len(full) >= 3 else HIGH,
        detail=(f"Full read+write+delete access to {len(full)} service(s) with no resource "
                f"constraint: {', '.join(full)}."),
        evidence={"wildcard_grants": full, "all_grants": sorted(grants),
                  "scoped_grant_count": len(ctx.config.get("accessible_resources") or [])},
    )


def _aws_iam_wildcard_write(ctx: Ctx):
    grants = _aws_broad_access(ctx)
    if grants is None:
        return _unknown(
            "This role's policy documents were not collected, so its permissions could "
            "not be analysed."
        )
    write = sorted({
        g for g in grants
        if g.lower().endswith(":write")
        and g.split(":")[0].lower() not in _IAM_ESCALATION_SERVICES
        and not g.startswith("*:")      # all-service write is escalation
    })
    return _flag_if(
        bool(write), unknown_reason="",
        detail=f"Unconstrained write access to {len(write)} service(s): {', '.join(write)}.",
        wildcard_grants=write, all_grants=sorted(grants),
    )


# ═════════════════════════════════════════════════════════════════════════════
# AZURE
# ═════════════════════════════════════════════════════════════════════════════
#
# Azure NSG rules are evaluated in priority order (lowest number first) and CAN
# deny — unlike AWS security groups and OCI NSGs, which are allow-only. So a
# world-open Allow may be shadowed by a higher-priority Deny, and reporting the
# Allow without checking would be a false positive.


def _azure_ingress_rules(config: Dict[str, Any]) -> Optional[List[Dict[str, Any]]]:
    r = config.get("ingress_rules")
    if r is None:
        return None
    return [x for x in r if isinstance(x, dict)] if isinstance(r, list) else None


def _azure_port_spans(rule: Dict[str, Any]) -> List[Tuple[Optional[int], Optional[int]]]:
    """Normalize Azure's two port fields into (min, max) spans.

    `destination_port_range` is a single value; `destination_port_ranges` is a
    list; either may be "*" (every port) or "lo-hi".
    """
    raw: List[str] = []
    many = rule.get("destination_port_ranges")
    if isinstance(many, list):
        raw.extend(str(x) for x in many if x is not None)
    one = rule.get("destination_port_range")
    if one is not None:
        raw.append(str(one))
    if not raw:
        raw = ["*"]

    spans: List[Tuple[Optional[int], Optional[int]]] = []
    for r in raw:
        r = r.strip()
        if r == "*":
            spans.append((None, None))
        elif "-" in r:
            lo, _, hi = r.partition("-")
            try:
                spans.append((int(lo), int(hi)))
            except ValueError:
                continue
        else:
            try:
                spans.append((int(r), int(r)))
            except ValueError:
                continue
    return spans


def _span_covers(span: Tuple[Optional[int], Optional[int]], port: int) -> bool:
    lo, hi = span
    if lo is None or hi is None:
        return True
    return lo <= port <= hi


def azure_port_verdict(rules: List[Dict[str, Any]], port: int) -> Tuple[str, Optional[Dict], str]:
    """Priority-correct answer for one port: is it world-open on this NSG?

    Returns (verdict, deciding_rule, confidence).

    Inbound rules are sorted by priority ascending — Azure's own evaluation
    order — and the FIRST rule that both matches the port and has an
    internet-scoped source decides. This is what makes a Deny at priority 100
    correctly shadow an Allow at 300, which the previous implementation could
    only do for exactly-equal port ranges and otherwise got wrong.

    Confidence is HIGH: sorting by priority and taking the first match is
    exactly the provider's algorithm for a single port. (Breadth across a whole
    range is a harder question, and `azure_open_ports` handles that separately
    with a stated approximation.)
    """
    inbound = [
        r for r in rules
        if str(r.get("direction") or "Inbound").strip().lower() == "inbound"
    ]
    inbound.sort(key=lambda r: r.get("priority") if isinstance(r.get("priority"), int) else 65535)

    for rule in inbound:
        proto = str(rule.get("protocol") or "*").strip().lower()
        if proto not in ("*", "any", "tcp", "6"):
            # UDP/ICMP rules cannot govern a TCP management port.
            continue
        if not is_world_open(rule.get("source_address_prefix")):
            # A rule scoped to a specific CIDR does not decide the internet's
            # access; keep looking at lower-priority rules.
            continue
        if not any(_span_covers(s, port) for s in _azure_port_spans(rule)):
            continue
        access = str(rule.get("access") or "").strip().lower()
        if access == "deny":
            return SAFE, rule, CONF_HIGH
        if access == "allow":
            return VULNERABLE, rule, CONF_HIGH
    # No internet-scoped rule matched. Azure NSGs end in an implicit
    # DenyAllInbound, so this is a genuine SAFE.
    return SAFE, None, CONF_HIGH


def _azure_nsg_port_rule(ctx: Ctx, port: int, service: str):
    rules = _azure_ingress_rules(ctx.config)
    if rules is None:
        return _unknown(
            "This network security group's rules are not in the stored inventory, so its "
            "exposure cannot be evaluated. The account's resources were collected by an "
            "earlier scanner version that did not record NSG rules; a successful re-scan "
            "would resolve it.",
            checked_port=port, collected_keys=sorted(ctx.config.keys()),
        )
    verdict, rule, conf = azure_port_verdict(rules, port)
    if verdict != VULNERABLE:
        return Outcome(verdict=SAFE, evidence={"checked_port": port,
                                               "rules_examined": len(rules)})
    return Outcome(
        verdict=VULNERABLE, confidence=conf,
        detail=(f"Rule '{rule.get('name') or 'unnamed'}' at priority {rule.get('priority')} "
                f"allows {service} from {rule.get('source_address_prefix')}."),
        evidence={
            "port": port, "service": service, "rule": rule,
            "priority": rule.get("priority"),
            "source_address_prefix": rule.get("source_address_prefix"),
            "evaluation": "Inbound rules sorted by ascending priority; this is the "
                          "first internet-scoped rule matching the port.",
        },
    )


def _azure_nsg_ssh(ctx: Ctx):
    return _azure_nsg_port_rule(ctx, 22, "SSH")


def _azure_nsg_rdp(ctx: Ctx):
    return _azure_nsg_port_rule(ctx, 3389, "RDP")


def _azure_nsg_rule_count(ctx: Ctx):
    """The correctly-labelled replacement for what the live system reported as
    'OCI NSG Has Many Ingress Rules' on 20 Azure network security groups."""
    rules = _azure_ingress_rules(ctx.config)
    if rules is None:
        return _unknown(
            "NSG rules are not in the stored inventory for this resource.",
            collected_keys=sorted(ctx.config.keys()),
        )
    n = len(rules)
    return _flag_if(
        n >= 5, unknown_reason="",
        detail=f"{n} inbound rules are defined.",
        ingress_rule_count=n, threshold=5,
    )


def _azure_storage_blob_public(ctx: Ctx):
    return _flag_if(
        _bool_field(ctx.config, "allow_blob_public_access"),
        unknown_reason="The allowBlobPublicAccess setting is not in the stored inventory "
                       "for this storage account.",
        detail="allowBlobPublicAccess is enabled at the account level, so any container "
               "in it may be set to anonymous read.",
        allow_blob_public_access=ctx.config.get("allow_blob_public_access"),
        kind=ctx.config.get("kind"),
    )


def _azure_storage_secure_transfer(ctx: Ctx):
    if "enable_https_traffic_only" not in ctx.config:
        return _not_yet_collected("enable_https_traffic_only")
    v = _bool_field(ctx.config, "enable_https_traffic_only")
    return _flag_if(
        None if v is None else (v is False),
        unknown_reason="The storage account did not report whether secure transfer is "
                       "required.",
        detail="Secure transfer is not required, so the account accepts plain HTTP.",
        enable_https_traffic_only=v,
    )


def _azure_storage_min_tls(ctx: Ctx):
    if "minimum_tls_version" not in ctx.config:
        return _not_yet_collected("minimum_tls_version")
    v = ctx.config.get("minimum_tls_version")
    if not v:
        return _unknown("The storage account did not report a minimum TLS version.")
    return _flag_if(
        str(v).upper().replace(".", "_") in ("TLS1_0", "TLS1_1"), unknown_reason="",
        detail=f"The minimum TLS version is {v}; clients may still negotiate TLS 1.0/1.1.",
        minimum_tls_version=v,
    )


def _azure_vm_public_ip(ctx: Ctx):
    """Attack surface only — see _aws_instance_public_ip. v2 demoted this from
    HIGH, because on the live Azure Production account it produced 25 HIGH
    findings asserting internet reachability for VMs whose NSG rules were never
    collected."""
    ip = ctx.resource.ip_address
    priv = _private_ip(ip)
    if priv is None:
        if not ip:
            return Outcome(verdict=SAFE, evidence={"public_ip": None})
        return _unknown("Address could not be parsed.", address=ip)
    return _flag_if(
        not priv, unknown_reason="",
        detail=f"Public address {ip}. Actual reachability depends on the NSGs applied to "
               f"its NICs and subnet — see Internet Exposure.",
        public_ip=ip,
    )


def _azure_vm_stopped(ctx: Ctx):
    st = (ctx.config.get("power_state") or ctx.resource.status or "").strip().lower()
    if not st:
        return _unknown("Power state was not collected for this VM.")
    return _flag_if(
        "deallocat" in st or "stopped" in st, unknown_reason="",
        detail=f"Power state is {st}. A stopped (not deallocated) VM still bills for "
               f"compute; a deallocated one still bills for its managed disks.",
        power_state=st,
    )


def _azure_db_public_network(ctx: Ctx):
    return _flag_if(
        _bool_field(ctx.config, "public_network_access"),
        unknown_reason="The publicNetworkAccess setting is not in the stored inventory "
                       "for this server.",
        detail="Public network access is enabled, so the server has a public endpoint "
               "and is reachable from outside the virtual network subject only to its "
               "firewall rules.",
        public_network_access=ctx.config.get("public_network_access"),
        version=ctx.config.get("version"), tier=ctx.config.get("tier"),
    )


def _azure_db_geo_backup(ctx: Ctx):
    v = _bool_field(ctx.config, "geo_redundant_backup")
    if v is None:
        return _unknown("Geo-redundant backup setting was not collected for this server.")
    return _flag_if(
        not v, unknown_reason="",
        detail=f"Geo-redundant backup is disabled; retention is "
               f"{ctx.config.get('backup_retention_days', 'unknown')} day(s) in a single region.",
        geo_redundant_backup=ctx.config.get("geo_redundant_backup"),
        backup_retention_days=ctx.config.get("backup_retention_days"),
        high_availability_mode=ctx.config.get("high_availability_mode"),
    )


def _azure_sql_tde(ctx: Ctx):
    """Transparent Data Encryption state is genuinely not collected. The old
    engine handled this by simply having no check, which is defensible but
    invisible — a reader could not tell whether Azure SQL had passed an
    encryption check or never been given one. NOT_SCANNED says it out loud and
    counts against encryption coverage."""
    return Outcome(
        verdict=NOT_SCANNED,
        evidence={"collected_keys": sorted(ctx.config.keys())},
        unknown_reason="Transparent Data Encryption state is not collected by the Azure "
                       "scanner (it requires the databases/transparentDataEncryption "
                       "sub-resource), so encryption at rest cannot be assessed.",
    )


# ═════════════════════════════════════════════════════════════════════════════
# OCI
# ═════════════════════════════════════════════════════════════════════════════
#
# OCI NSGs and Security Lists are both allow-only with an implicit default
# deny, so one matching allow rule is a complete answer — the same reasoning
# as AWS. Both mechanisms are evaluated because a subnet may be governed by
# either or both, and traffic needs only one of them to permit it.


def _oci_rule_covers_port(rule: Dict[str, Any], port: int) -> Optional[bool]:
    """Does this OCI ingress rule expose `port`? None when the rule's shape is
    unrecognised, so it is never silently treated as harmless."""
    if rule.get("source_type") not in (None, "CIDR_BLOCK"):
        return False        # service gateway / NSG source — not the internet
    if not is_world_open(rule.get("source")):
        return False
    proto = str(rule.get("protocol") or "").strip().lower()
    if proto in ("all", "*"):
        return True
    if proto not in ("6", "tcp"):
        return False        # UDP (17) / ICMP (1) cannot expose a TCP port
    pr = rule.get("port_range")
    if pr is None:
        # TCP with no port range means every TCP port.
        return True
    if not isinstance(pr, dict):
        return None
    lo, hi = pr.get("min"), pr.get("max")
    if lo is None or hi is None:
        return True
    try:
        return int(lo) <= port <= int(hi)
    except (TypeError, ValueError):
        return None


def _oci_ingress_port_rule(ctx: Ctx, port: int, service: str, mechanism: str):
    rules = ctx.config.get("ingress_rules")
    if not isinstance(rules, list):
        return _unknown(
            f"This {mechanism}'s ingress rules are not in the stored inventory.",
            checked_port=port,
        )
    unresolved = 0
    for rule in rules:
        if not isinstance(rule, dict):
            continue
        hit = _oci_rule_covers_port(rule, port)
        if hit is None:
            unresolved += 1
            continue
        if hit:
            return Outcome(
                verdict=VULNERABLE,
                detail=(f"An ingress rule allows {service} from {rule.get('source')} "
                        f"(protocol {rule.get('protocol')})."),
                evidence={
                    "port": port, "service": service, "mechanism": mechanism,
                    "rule": rule, "source": rule.get("source"),
                    "is_stateless": rule.get("is_stateless"),
                },
            )
    if unresolved:
        return _unknown(
            f"{unresolved} of {len(rules)} ingress rules had an unrecognised port "
            f"specification, so {service} exposure cannot be ruled out.",
            checked_port=port, unresolved_rules=unresolved,
        )
    return Outcome(verdict=SAFE, evidence={"checked_port": port,
                                           "rules_examined": len(rules),
                                           "mechanism": mechanism})


def _oci_nsg_ssh(ctx: Ctx):
    return _oci_ingress_port_rule(ctx, 22, "SSH", "network security group")


def _oci_nsg_rdp(ctx: Ctx):
    return _oci_ingress_port_rule(ctx, 3389, "RDP", "network security group")


def _oci_seclist_ssh(ctx: Ctx):
    return _oci_ingress_port_rule(ctx, 22, "SSH", "security list")


def _oci_seclist_rdp(ctx: Ctx):
    return _oci_ingress_port_rule(ctx, 3389, "RDP", "security list")


def _oci_rule_count(ctx: Ctx, mechanism: str):
    rules = ctx.config.get("ingress_rules")
    if not isinstance(rules, list):
        return _unknown(f"Ingress rules are not in the stored inventory for this {mechanism}.")
    n = len(rules)
    return _flag_if(
        n >= 5, unknown_reason="",
        detail=f"{n} ingress rules are defined.",
        ingress_rule_count=n, threshold=5, mechanism=mechanism,
        is_default=ctx.config.get("is_default"),
    )


def _oci_nsg_rule_count(ctx: Ctx):
    return _oci_rule_count(ctx, "network security group")


def _oci_seclist_rule_count(ctx: Ctx):
    return _oci_rule_count(ctx, "security list")


# OCI policy grammar: "allow <subject-kind> <subject> to <verb> <resource> in <scope>"
import re  # noqa: E402  (kept beside the only regex in the module)

# `any-user` and `any-group` name no subject — the statement reads
# "allow any-user to manage all-resources in tenancy" — so the subject group is
# optional. An earlier version required at least one character there, which
# meant the single most dangerous statement in the OCI policy language failed to
# parse and was reported as "grammar not recognised" rather than as a CRITICAL
# finding.
_OCI_STMT = re.compile(
    r"^\s*allow\s+"
    r"(?P<subject_kind>group|dynamic-group|any-user|any-group|service)"
    r"(?:\s+(?P<subject>[\w'\-,{}. ]+?))?\s+to\s+"
    r"(?P<verb>manage|use|read|inspect|\{[^}]*\})\s+"
    r"(?P<resource>[\w-]+)\s+"
    r"in\s+(?P<scope>tenancy|compartment\s+[\w'\"./-]+)",
    re.IGNORECASE,
)

# Managing any of these lets an identity grant itself everything else, which is
# a different and worse problem than merely having broad access.
_OCI_ESCALATION_RESOURCES = frozenset({
    "policies", "groups", "users", "dynamic-groups", "domains", "all-resources",
})


def _parse_oci_statement(stmt: str) -> Optional[Dict[str, Any]]:
    m = _OCI_STMT.match((stmt or "").strip())
    if not m:
        return None
    scope = m.group("scope").lower()
    return {
        "subject_kind": m.group("subject_kind").lower(),
        # None for any-user / any-group, which name no subject. Rendered as the
        # subject kind so a finding reads "to any-user" rather than "to None".
        "subject": (m.group("subject") or m.group("subject_kind")).strip(),
        "verb": m.group("verb").lower().strip("{}"),
        "resource": m.group("resource").lower(),
        "scope": "tenancy" if scope == "tenancy" else "compartment",
        "raw": stmt,
    }


def _oci_policy_statements(ctx: Ctx) -> Tuple[List[Dict], int]:
    raw = ctx.config.get("statements")
    if not isinstance(raw, list):
        return [], 0
    parsed, unparsed = [], 0
    for s in raw:
        p = _parse_oci_statement(s if isinstance(s, str) else "")
        if p:
            parsed.append(p)
        else:
            unparsed += 1
    return parsed, unparsed


def _oci_policy_escalation(ctx: Ctx):
    parsed, unparsed = _oci_policy_statements(ctx)
    if not parsed and not unparsed:
        return _unknown("Policy statements are not in the stored inventory.")
    hits = [p for p in parsed
            if p["verb"] == "manage" and p["resource"] in _OCI_ESCALATION_RESOURCES]
    if hits:
        return Outcome(
            verdict=VULNERABLE,
            detail=(f"{len(hits)} statement(s) grant manage over identity objects "
                    f"({', '.join(sorted({h['resource'] for h in hits}))})."),
            evidence={"statements": hits, "unparsed_statements": unparsed},
        )
    if unparsed and not parsed:
        return _unknown(
            f"None of this policy's {unparsed} statement(s) matched the known OCI policy "
            "grammar, so its grants were not interpreted rather than guessed at.",
            unparsed_statements=unparsed,
        )
    return Outcome(verdict=SAFE, evidence={"statements_parsed": len(parsed),
                                           "unparsed_statements": unparsed})


def _oci_policy_tenancy_admin(ctx: Ctx):
    parsed, unparsed = _oci_policy_statements(ctx)
    if not parsed and not unparsed:
        return _unknown("Policy statements are not in the stored inventory.")
    hits = [p for p in parsed
            if p["verb"] == "manage" and p["resource"] == "all-resources"
            and p["scope"] == "tenancy"]
    if hits:
        anyuser = [h for h in hits if h["subject_kind"] == "any-user"]
        return Outcome(
            verdict=VULNERABLE,
            severity=CRITICAL,
            detail=("Grants manage over all-resources across the entire tenancy"
                    + (" to any-user (unauthenticated or any principal)." if anyuser
                       else f" to {', '.join(sorted({h['subject'] for h in hits}))}.")),
            evidence={"statements": hits, "any_user": bool(anyuser),
                      "unparsed_statements": unparsed},
        )
    return Outcome(verdict=SAFE, evidence={"statements_parsed": len(parsed)})


def _oci_policy_broad_manage(ctx: Ctx):
    parsed, unparsed = _oci_policy_statements(ctx)
    if not parsed and not unparsed:
        return _unknown("Policy statements are not in the stored inventory.")
    hits = [
        p for p in parsed
        if p["verb"] == "manage" and p["scope"] == "tenancy"
        and (p["resource"].endswith("-family") or p["resource"] == "all-resources")
        and p["resource"] not in _OCI_ESCALATION_RESOURCES
    ]
    if hits:
        return Outcome(
            verdict=VULNERABLE,
            detail=(f"Tenancy-wide manage over "
                    f"{', '.join(sorted({h['resource'] for h in hits}))}."),
            evidence={"statements": hits, "unparsed_statements": unparsed},
        )
    return Outcome(verdict=SAFE, evidence={"statements_parsed": len(parsed)})


def _oci_bucket_public(ctx: Ctx):
    pa = ctx.config.get("public_access_type")
    if pa is None:
        return _unknown("Public-access type was not collected for this bucket.")
    return _flag_if(
        str(pa) != "NoPublicAccess", unknown_reason="",
        detail=f"Public access type is {pa}.",
        public_access_type=pa, namespace=ctx.config.get("namespace"),
    )


def _oci_oke_public_endpoint(ctx: Ctx):
    ec = ctx.config.get("endpoint_config")
    if not isinstance(ec, dict) or "is_public_ip_enabled" not in ec:
        return _unknown("Endpoint configuration was not collected for this cluster.")
    return _flag_if(
        _bool_field(ec, "is_public_ip_enabled"), unknown_reason="",
        detail="The Kubernetes API server has a public endpoint.",
        endpoint_config=ec, kubernetes_version=ctx.config.get("kubernetes_version"),
    )


def _oci_apigw_public(ctx: Ctx):
    """The rule whose v1 fabricated three findings on AWS.

    Two independent fixes: it is registered only for OCI (so AWS API Gateways
    never reach it), and an absent `endpoint_type` returns UNKNOWN instead of
    defaulting to "PUBLIC".
    """
    et = ctx.config.get("endpoint_type")
    if et is None:
        return _unknown(
            "Endpoint type was not collected for this gateway, so whether it is public "
            "cannot be determined. It is not assumed to be public.",
            collected_keys=sorted(ctx.config.keys()),
        )
    return _flag_if(
        str(et).strip().upper() == "PUBLIC", unknown_reason="",
        detail=f"Endpoint type is {et}. Confirm that every deployment on this gateway "
               f"enforces an authorizer.",
        endpoint_type=et,
    )


def _oci_compute_public_ip(ctx: Ctx):
    ip = ctx.config.get("public_ip") or ctx.resource.ip_address
    priv = _private_ip(ip)
    if priv is None:
        if not ip:
            return Outcome(verdict=SAFE, evidence={"public_ip": None})
        return _unknown("Address could not be parsed.", address=ip)
    return _flag_if(
        not priv, unknown_reason="",
        detail=f"Public address {ip}. Actual reachability depends on the NSGs and security "
               f"lists governing its subnet — see Internet Exposure.",
        public_ip=ip, subnet_id=ctx.config.get("subnet_id"),
    )


def _oci_default_seclist_open(ctx: Ctx):
    """CIS OCI: the default security list restricts all traffic except ICMP.
    A default list with a non-ICMP ingress rule from 0.0.0.0/0 fails (the
    stock default list opens TCP 22 to the world, which is the usual hit)."""
    if ctx.config.get("is_default") is not True:
        return None
    rules = ctx.config.get("ingress_rules")
    if rules is None:
        return _unknown("The default security list's ingress rules are not in the "
                        "stored inventory.")
    open_rules = [r for r in rules if isinstance(r, dict)
                  and is_world_open(r.get("source"))
                  and str(r.get("protocol") or "") != "1"]      # "1" = ICMP
    return _flag_if(
        bool(open_rules), unknown_reason="",
        detail=(f"{len(open_rules)} non-ICMP ingress rule(s) from 0.0.0.0/0 on the VCN's "
                "default security list."),
        vcn_id=ctx.config.get("vcn_id"),
        rules=[{"protocol": r.get("protocol"), "port_range": r.get("port_range"),
                "source": r.get("source")} for r in open_rules[:20]],
    )


# The resource kinds Oracle's own CIS reference checker counts for "no
# resources in the root compartment" (cis_reports.py, 3.1.1): networks,
# compute, storage and databases. IAM objects live in the root by design.
_OCI_ROOT_COMPARTMENT_TYPES = (
    "VCN", "ComputeInstance", "BlockVolume", "BootVolume", "FileSystem",
    "ObjectStorageBucket", "AutonomousDatabase", "DbSystem",
)


def _oci_in_root_compartment(ctx: Ctx):
    meta = getattr(ctx.resource, "metadata_", None) or {}
    cid = meta.get("compartment_id") if isinstance(meta, dict) else None
    if not cid:
        return _unknown("The resource's compartment was not recorded.")
    return _flag_if(
        str(cid).startswith("ocid1.tenancy."), unknown_reason="",
        detail="The resource lives in the tenancy's root compartment.",
        compartment_id=cid,
    )


def _oci_compute_legacy_imds(ctx: Ctx):
    if "legacy_imds_disabled" not in ctx.config:
        return _not_yet_collected("legacy_imds_disabled")
    v = _bool_field(ctx.config, "legacy_imds_disabled")
    return _flag_if(
        None if v is None else (v is False),
        unknown_reason="The instance did not report whether its legacy metadata "
                       "endpoints are disabled.",
        detail="The legacy (v1) instance metadata endpoints are still enabled.",
        legacy_imds_disabled=v,
    )


def _oci_compute_large(ctx: Ctx):
    o = ctx.config.get("ocpus")
    if not isinstance(o, (int, float)):
        return _unknown("OCPU count was not collected for this instance.")
    return _flag_if(
        o >= 16, unknown_reason="",
        detail=f"{o} OCPUs ({ctx.config.get('shape') or 'unknown shape'}).",
        ocpus=o, shape=ctx.config.get("shape"), threshold=16,
    )


def _oci_adb_autoscale(ctx: Ctx):
    v = _bool_field(ctx.config, "is_auto_scaling_enabled")
    if v is None:
        return _unknown("Auto-scaling state was not collected for this database.")
    return _flag_if(
        not v, unknown_reason="",
        detail=f"Auto-scaling is disabled with "
               f"{ctx.config.get('cpu_core_count', 'unknown')} core(s) allocated.",
        is_auto_scaling_enabled=v, cpu_core_count=ctx.config.get("cpu_core_count"),
    )


def _oci_function_timeout(ctx: Ctx):
    t = ctx.config.get("timeout_in_seconds")
    if not isinstance(t, int):
        return _unknown("Timeout was not collected for this function.")
    return _flag_if(
        t > 300, unknown_reason="",
        detail=f"Timeout is {t}s.",
        timeout_in_seconds=t, threshold=300,
    )


def _oci_subnet_public(ctx: Ctx):
    v = _bool_field(ctx.config, "is_public")
    if v is None:
        return _unknown("Subnet public/private setting was not collected.")
    return _flag_if(
        v, unknown_reason="",
        detail="Instances launched in this subnet can receive public IP addresses.",
        is_public=v, cidr_block=ctx.config.get("cidr_block"),
    )


def _oci_volume_customer_key(ctx: Ctx):
    """OCI encrypts all block storage by default with an Oracle-managed key, so
    the absence of a Vault key is not a vulnerability — it is a control
    preference. INFO, and only when the field was actually collected.

    Note the empty-string case: the scanner writes "" rather than null for
    "no Vault key", so a falsy-but-present value is a real answer, while an
    absent key is not.

    The distinction between the two negative outcomes matters here. FileSystem
    records `kms_key_id`; BlockVolume and BootVolume do not, because the OCI
    scanner never requests it for them. That is a property of the scanner, not
    of any individual volume — so it is NOT_SCANNED, which the engine reports
    once per rule, rather than UNKNOWN, which it would report 133 times for the
    live tenancy's volumes and which would read as 133 separate problems.
    """
    if "kms_key_id" not in ctx.config:
        return Outcome(
            verdict=NOT_SCANNED,
            evidence={"collected_keys": sorted(ctx.config.keys())},
            unknown_reason=(
                f"The OCI scanner does not collect kms_key_id for "
                f"{ctx.resource.resource_type}, so whether a customer-managed Vault key "
                "is assigned cannot be determined. Block and boot volumes are always "
                "encrypted; only the key ownership is unknown."
            ),
        )
    key = ctx.config.get("kms_key_id")
    return _flag_if(
        not key, unknown_reason="",
        detail="Encrypted with an Oracle-managed key rather than a customer-managed "
               "Vault key.",
        kms_key_id=key or None,
    )


# ═════════════════════════════════════════════════════════════════════════════
# Cross-provider
# ═════════════════════════════════════════════════════════════════════════════

_REQUIRED_TAGS = ("Name", "Environment", "Owner")
# Types where an ownership tag is not a meaningful expectation: they are either
# implicitly named by their parent, or they are provider-managed.
_TAG_EXEMPT_TYPES = frozenset({
    "SecurityGroup", "SecurityList", "NetworkSecurityGroup", "VPC", "VCN",
    "IAMRole", "IAMPolicy", "IAMGroup", "RouteTable", "DhcpOptions",
    "Subnet", "NetworkInterface", "PublicIP", "DrgAttachment", "VirtualCircuit",
})


def _missing_tags(ctx: Ctx):
    if ctx.resource.resource_type in _TAG_EXEMPT_TYPES:
        return None
    if ctx.tags is None:
        return _unknown("Tags were not collected for this resource.")
    present = {str(k).strip().lower() for k in ctx.tags}
    missing = [t for t in _REQUIRED_TAGS if t.lower() not in present]
    if not missing:
        return Outcome(verdict=SAFE, evidence={"tags": sorted(ctx.tags)})
    return Outcome(
        verdict=VULNERABLE,
        detail=f"Missing: {', '.join(missing)}.",
        evidence={"missing_tags": missing, "present_tags": sorted(ctx.tags)},
    )


# ═════════════════════════════════════════════════════════════════════════════
# The registry
# ═════════════════════════════════════════════════════════════════════════════

_R: List[SecurityRule] = [

    # ── AWS ──────────────────────────────────────────────────────────────────
    SecurityRule(
        rule_id="AWS_SG_SSH_WORLD_OPEN", version="2.0", provider=AWS,
        resource_types=("SecurityGroup",),
        title="Security group allows SSH from the entire internet",
        severity=CRITICAL, category=CAT_NETWORKING, evaluate=_aws_sg_ssh,
        coverage=COV_NETWORK,
        description="An inbound rule permits TCP/22 from 0.0.0.0/0 or ::/0.",
        rationale=portcat.CATALOG[22].why,
        remediation=(
            "Replace the 0.0.0.0/0 source with the specific CIDR ranges that need shell "
            "access, or remove the rule entirely and reach instances through AWS Systems "
            "Manager Session Manager, which needs no inbound rule at all:\n"
            "  aws ec2 revoke-security-group-ingress --group-id <sg-id> \\\n"
            "      --protocol tcp --port 22 --cidr 0.0.0.0/0"
        ),
    ),
    SecurityRule(
        rule_id="AWS_SG_RDP_WORLD_OPEN", version="1.0", provider=AWS,
        resource_types=("SecurityGroup",),
        title="Security group allows RDP from the entire internet",
        severity=CRITICAL, category=CAT_NETWORKING, evaluate=_aws_sg_rdp,
        coverage=COV_NETWORK,
        description="An inbound rule permits TCP/3389 from 0.0.0.0/0 or ::/0.",
        rationale=portcat.CATALOG[3389].why,
        remediation=(
            "Remove the world-open RDP rule and restrict it to a VPN or bastion CIDR:\n"
            "  aws ec2 revoke-security-group-ingress --group-id <sg-id> \\\n"
            "      --protocol tcp --port 3389 --cidr 0.0.0.0/0\n"
            "Prefer Fleet Manager Remote Desktop through Systems Manager, which requires "
            "no inbound rule."
        ),
    ),
    SecurityRule(
        rule_id="AWS_SG_DEFAULT_IN_USE", version="1.1", provider=AWS,
        resource_types=("SecurityGroup",),
        title="Default VPC security group is in use",
        severity=MEDIUM, category=CAT_CONFIGURATION, evaluate=_aws_sg_default,
        description="The security group named 'default', created automatically with the VPC.",
        rationale=(
            "The default group's rules apply to anything launched without an explicit "
            "group, so a change to it silently affects unrelated workloads, and its "
            "allow-all-from-itself rule means every instance using it can reach every "
            "other one."
        ),
        remediation=(
            "Create purpose-specific security groups per application tier and move "
            "workloads onto them. AWS Foundational Security Best Practices recommends "
            "leaving the default group with no rules at all."
        ),
    ),
    SecurityRule(
        rule_id="AWS_SG_DEFAULT_ALLOWS_TRAFFIC", version="1.0", provider=AWS,
        resource_types=("SecurityGroup",), evaluate=_aws_sg_default_allows_traffic,
        title="Default security group does not restrict all traffic",
        severity=LOW, category=CAT_NETWORKING, coverage=COV_NETWORK, aggregate=True,
        description="A VPC's default security group still has inbound or outbound rules.",
        rationale=(
            "Every VPC's default group ships allowing all traffic between its members and "
            "all outbound traffic. Anything launched without an explicit group lands in it "
            "and inherits that, so emptying it is what makes 'forgot to choose a group' "
            "fail closed instead of open."
        ),
        remediation=(
            "Remove every rule from the default group of each VPC (it cannot be deleted):\n"
            "  aws ec2 revoke-security-group-ingress --group-id <sg> --ip-permissions "
            "\"$(aws ec2 describe-security-groups --group-ids <sg> "
            "--query SecurityGroups[0].IpPermissions)\"\n"
            "and the same with revoke-security-group-egress. Move anything attached to it "
            "onto a purpose-built group first."
        ),
    ),
    SecurityRule(
        rule_id="AWS_SG_PERMISSIVE_RULE_COUNT", version="2.0", provider=AWS,
        resource_types=("SecurityGroup",),
        title="Security group has many inbound rules",
        severity=MEDIUM, category=CAT_CONFIGURATION, confidence=CONF_LOW,
        evaluate=_aws_sg_rule_count,
        description="Three or more inbound rules are attached to this security group.",
        rationale=(
            "A count is an indicator, not a vulnerability: a group with eight tightly "
            "scoped rules is fine and one with a single 0.0.0.0/0 rule is not. It is "
            "reported at low confidence because rule breadth, not rule count, is what "
            "matters — the world-open checks above are the authoritative ones."
        ),
        remediation=(
            "Review the rule list and consolidate or remove any that are no longer "
            "needed:  aws ec2 describe-security-groups --group-ids <sg-id>"
        ),
    ),
    SecurityRule(
        rule_id="AWS_S3_PUBLIC_ACCESS_NOT_BLOCKED", version="2.0", provider=AWS,
        resource_types=("S3Bucket",),
        title="S3 bucket does not block public access",
        severity=CRITICAL, category=CAT_DATA_PROTECTION, evaluate=_aws_s3_public_access,
        coverage=COV_ENCRYPTION,
        description="One or more Public Access Block settings are not enabled.",
        rationale=(
            "Public Access Block is the backstop that prevents an ACL or bucket policy — "
            "possibly added later, possibly by someone else — from exposing the bucket. "
            "Without it, a single misapplied policy makes the contents world-readable, "
            "which is the most common cause of large cloud data leaks."
        ),
        remediation=(
            "Enable all four settings on the bucket, and ideally at the account level so "
            "new buckets inherit them:\n"
            "  aws s3api put-public-access-block --bucket <name> \\\n"
            "      --public-access-block-configuration \\\n"
            "      BlockPublicAcls=true,IgnorePublicAcls=true,\\\n"
            "BlockPublicPolicy=true,RestrictPublicBuckets=true"
        ),
    ),
    SecurityRule(
        rule_id="AWS_S3_ENCRYPTION_DISABLED", version="1.0", provider=AWS,
        resource_types=("S3Bucket",),
        title="S3 bucket has no default encryption",
        severity=HIGH, category=CAT_ENCRYPTION, evaluate=_aws_s3_encryption,
        coverage=COV_ENCRYPTION,
        description="No default server-side encryption rule is configured.",
        rationale=(
            "Without a default rule, an object uploaded by a client that does not ask for "
            "encryption is stored in plaintext, and nothing in the upload path fails to "
            "warn anyone."
        ),
        remediation=(
            "Set default encryption (SSE-S3 at minimum, SSE-KMS where key control is "
            "needed):\n"
            "  aws s3api put-bucket-encryption --bucket <name> \\\n"
            "      --server-side-encryption-configuration '{\"Rules\":[{\"ApplyServer"
            "SideEncryptionByDefault\":{\"SSEAlgorithm\":\"AES256\"}}]}'"
        ),
    ),
    SecurityRule(
        rule_id="AWS_S3_VERSIONING_DISABLED", version="1.0", provider=AWS,
        resource_types=("S3Bucket",),
        title="S3 bucket versioning is not enabled",
        severity=LOW, category=CAT_DATA_PROTECTION, evaluate=_aws_s3_versioning,
        description="Versioning is suspended or was never enabled.",
        rationale=(
            "Without versioning, an overwrite or delete is unrecoverable — including one "
            "performed by ransomware or by a mistaken sync command."
        ),
        remediation=(
            "  aws s3api put-bucket-versioning --bucket <name> \\\n"
            "      --versioning-configuration Status=Enabled\n"
            "Consider also enabling MFA delete for buckets holding irreplaceable data."
        ),
    ),
    SecurityRule(
        rule_id="AWS_RDS_ENCRYPTION_DISABLED", version="1.1", provider=AWS,
        resource_types=("RDSInstance",),
        title="RDS instance storage is not encrypted",
        severity=HIGH, category=CAT_ENCRYPTION, evaluate=_aws_rds_encryption,
        coverage=COV_ENCRYPTION,
        description="Storage encryption at rest is disabled for this instance.",
        rationale=(
            "Unencrypted RDS storage means the underlying volumes, and every automated "
            "snapshot taken from them, are readable by anyone who obtains them."
        ),
        remediation=(
            "Encryption cannot be enabled in place. Take a snapshot, copy it with "
            "--kms-key-id, and restore the copy:\n"
            "  aws rds create-db-snapshot --db-instance-identifier <id> \\\n"
            "      --db-snapshot-identifier <snap>\n"
            "  aws rds copy-db-snapshot --source-db-snapshot-identifier <snap> \\\n"
            "      --target-db-snapshot-identifier <snap>-enc --kms-key-id <key>\n"
            "  aws rds restore-db-instance-from-db-snapshot ..."
        ),
    ),
    SecurityRule(
        rule_id="AWS_RDS_PUBLICLY_ACCESSIBLE", version="1.0", provider=AWS,
        resource_types=("RDSInstance",),
        title="RDS instance is publicly accessible",
        severity=CRITICAL, category=CAT_NETWORKING, evaluate=_aws_rds_public,
        coverage=COV_NETWORK,
        description="The instance is flagged publicly accessible, so its endpoint "
                    "resolves to a public address.",
        rationale=(
            "A publicly accessible database is reachable from any network its security "
            "group permits — and the security group is then the only thing between the "
            "internet and the data."
        ),
        remediation=(
            "  aws rds modify-db-instance --db-instance-identifier <id> \\\n"
            "      --no-publicly-accessible --apply-immediately\n"
            "Reach the database from inside the VPC, or through a bastion or VPN."
        ),
    ),
    SecurityRule(
        rule_id="AWS_DYNAMODB_AWS_OWNED_KEY", version="1.1", provider=AWS,
        resource_types=("DynamoDBTable",),
        title="DynamoDB table uses the default AWS-owned key",
        severity=INFO, category=CAT_ENCRYPTION, evaluate=_aws_dynamodb_key,
        coverage=COV_ENCRYPTION,
        description="No SSEDescription is present, indicating the AWS-owned default key.",
        rationale=(
            "The table IS encrypted — this is not a gap in protection. What the AWS-owned "
            "key does not give you is key rotation you control, an audit trail of key use, "
            "or the ability to revoke access by disabling the key."
        ),
        remediation=(
            "For tables holding regulated or sensitive data, switch to a customer-managed "
            "key:\n"
            "  aws dynamodb update-table --table-name <name> \\\n"
            "      --sse-specification Enabled=true,SSEType=KMS,KMSMasterKeyId=<key>"
        ),
    ),
    SecurityRule(
        rule_id="AWS_IAM_ROLE_LONG_SESSION", version="1.1", provider=AWS,
        resource_types=("IAMRole",),
        title="IAM role allows very long sessions",
        severity=MEDIUM, category=CAT_IAM, evaluate=_aws_iam_long_session,
        coverage=COV_IAM,
        description="Maximum session duration exceeds 12 hours.",
        rationale=(
            "Temporary credentials are only meaningfully temporary if they expire. A "
            "leaked set from a long-session role stays usable for the rest of that window, "
            "and revoking it means editing the role's policy, not waiting for a timeout."
        ),
        remediation=(
            "  aws iam update-role --role-name <name> --max-session-duration 3600\n"
            "One to four hours suits interactive roles; automation should request a "
            "shorter duration explicitly at AssumeRole time."
        ),
    ),
    SecurityRule(
        rule_id="AWS_LAMBDA_DEPRECATED_RUNTIME", version="1.1", provider=AWS,
        resource_types=("LambdaFunction",),
        title="Lambda function uses a deprecated runtime",
        severity=HIGH, category=CAT_MAINTENANCE, evaluate=_aws_lambda_runtime,
        description="The function's runtime is past end-of-support.",
        rationale=(
            "A deprecated runtime stops receiving security patches for the language "
            "runtime and its bundled libraries, and AWS eventually blocks both updates "
            "and invocations — so this becomes an availability problem as well."
        ),
        remediation=(
            "Test against a supported runtime and update:\n"
            "  aws lambda update-function-configuration --function-name <name> \\\n"
            "      --runtime python3.12\n"
            "Check the AWS Lambda runtime deprecation schedule for the cut-off date."
        ),
    ),
    SecurityRule(
        rule_id="AWS_LAMBDA_LOW_MEMORY", version="1.1", provider=AWS,
        resource_types=("LambdaFunction",),
        title="Lambda function has low memory allocation",
        severity=INFO, category=CAT_PERFORMANCE, evaluate=_aws_lambda_memory,
        description="Less than 256 MB is allocated.",
        rationale=(
            "Lambda allocates CPU in proportion to memory, so a low setting caps compute "
            "as well. This is a cost/latency trade-off rather than a security matter, and "
            "it does not affect the security score."
        ),
        remediation=(
            "Measure with AWS Lambda Power Tuning before changing it — more memory is "
            "often cheaper overall, because the function finishes sooner:\n"
            "  aws lambda update-function-configuration --function-name <name> "
            "--memory-size 512"
        ),
    ),
    SecurityRule(
        rule_id="AWS_SUBNET_AUTO_PUBLIC_IP", version="1.0", provider=AWS,
        resource_types=("Subnet",),
        title="Subnet auto-assigns public IP addresses",
        severity=MEDIUM, category=CAT_CONFIGURATION, evaluate=_aws_subnet_auto_public_ip,
        coverage=COV_NETWORK,
        description="MapPublicIpOnLaunch is enabled for this subnet.",
        rationale=(
            "Any instance launched here becomes internet-facing by default, so a workload "
            "gains a public address because of where it was placed rather than because "
            "anyone decided it should have one."
        ),
        remediation=(
            "  aws ec2 modify-subnet-attribute --subnet-id <id> --no-map-public-ip-on-launch\n"
            "Place workloads that need outbound access only in a private subnet behind a "
            "NAT gateway."
        ),
    ),
    SecurityRule(
        rule_id="AWS_EC2_IMDSV2_NOT_REQUIRED", version="1.0", provider=AWS,
        resource_types=("EC2Instance",), evaluate=_aws_ec2_imdsv2,
        title="EC2 instance does not require IMDSv2",
        severity=MEDIUM, category=CAT_CONFIGURATION,
        description="The instance metadata service still accepts IMDSv1 (session-less) "
                    "requests.",
        rationale=(
            "IMDSv1 answers any HTTP GET from the instance, which is what lets a "
            "server-side request forgery bug in an application read the instance role's "
            "temporary credentials. IMDSv2 requires a session token obtained with a PUT, "
            "which such bugs cannot usually issue."
        ),
        remediation=(
            "  aws ec2 modify-instance-metadata-options --instance-id <id> "
            "--http-tokens required --http-endpoint enabled\n"
            "Check first that the software on the instance uses a current AWS SDK; very "
            "old SDKs only speak IMDSv1."
        ),
    ),
    SecurityRule(
        rule_id="AWS_EC2_PUBLIC_IP", version="2.0", provider=AWS,
        resource_types=("EC2Instance",),
        title="EC2 instance has a public IP address",
        severity=INFO, category=CAT_EXPOSURE, evaluate=_aws_instance_public_ip,
        coverage=COV_NETWORK,
        description="The instance has a routable public address. This records attack "
                    "surface; it is not a finding that anything is reachable.",
        rationale=(
            "A public IP is a precondition for exposure, not exposure itself — what "
            "decides reachability is the security group. This is INFO so that it stays "
            "visible for inventory purposes without competing with the exposure analysis "
            "that actually walks the rules. (v1 of this rule reported HIGH and claimed "
            "direct internet reachability, which was not supported by the data it read.)"
        ),
        remediation=(
            "If the instance does not need to be internet-facing, remove the public "
            "address and place it behind a load balancer or NAT gateway. Otherwise "
            "confirm on the Internet Exposure tab that only intended ports are open."
        ),
    ),
    SecurityRule(
        rule_id="AWS_EC2_STOPPED", version="1.1", provider=AWS,
        resource_types=("EC2Instance",),
        title="EC2 instance is stopped but still incurring storage cost",
        severity=MEDIUM, category=CAT_COST, evaluate=_aws_instance_stopped,
        description="The instance is stopped; its EBS volumes continue to bill.",
        rationale=(
            "A stopped instance costs nothing for compute but its volumes bill in full, "
            "and a long-stopped instance is usually one nobody owns any more."
        ),
        remediation=(
            "Create an AMI and terminate the instance if it is no longer needed:\n"
            "  aws ec2 create-image --instance-id <id> --name <name>\n"
            "  aws ec2 terminate-instances --instance-ids <id>"
        ),
    ),
    SecurityRule(
        rule_id="AWS_ELB_INSECURE_LISTENER", version="1.0", provider=AWS,
        resource_types=("LoadBalancer",),
        title="Load balancer listener protocol not assessed",
        severity=INFO, category=CAT_ENCRYPTION, evaluate=_aws_elb_listeners,
        coverage=COV_ENCRYPTION,
        description="Listener protocol and TLS policy are not collected by the scanner.",
        rationale=(
            "Whether a load balancer terminates plain HTTP, and which TLS policy it "
            "negotiates, is the control that protects data in transit at the edge. It is "
            "reported as not scanned rather than passed, because a control nobody looked "
            "at must not count as satisfied."
        ),
        remediation=(
            "Until the scanner collects listeners, check manually:\n"
            "  aws elbv2 describe-listeners --load-balancer-arn <arn>\n"
            "Every production listener should be HTTPS/TLS with a modern policy "
            "(ELBSecurityPolicy-TLS13-1-2-2021-06 or later), with HTTP redirecting to it."
        ),
    ),

    # ── Azure ────────────────────────────────────────────────────────────────
    SecurityRule(
        rule_id="AZURE_NSG_SSH_WORLD_OPEN", version="1.0", provider=AZURE,
        resource_types=("NetworkSecurityGroup",),
        title="Network security group allows SSH from the entire internet",
        severity=CRITICAL, category=CAT_NETWORKING, evaluate=_azure_nsg_ssh,
        coverage=COV_NETWORK,
        description="An inbound Allow rule permits TCP/22 from Internet, * or 0.0.0.0/0, "
                    "and no higher-priority Deny rule shadows it.",
        rationale=portcat.CATALOG[22].why,
        remediation=(
            "Change the rule's source to your VPN or bastion prefix, or delete it:\n"
            "  az network nsg rule update -g <rg> --nsg-name <nsg> -n <rule> \\\n"
            "      --source-address-prefixes <your-cidr>\n"
            "Azure Bastion removes the need for any inbound SSH rule."
        ),
    ),
    SecurityRule(
        rule_id="AZURE_NSG_RDP_WORLD_OPEN", version="1.0", provider=AZURE,
        resource_types=("NetworkSecurityGroup",),
        title="Network security group allows RDP from the entire internet",
        severity=CRITICAL, category=CAT_NETWORKING, evaluate=_azure_nsg_rdp,
        coverage=COV_NETWORK,
        description="An inbound Allow rule permits TCP/3389 from Internet, * or "
                    "0.0.0.0/0, and no higher-priority Deny rule shadows it.",
        rationale=portcat.CATALOG[3389].why,
        remediation=(
            "Restrict or remove the rule:\n"
            "  az network nsg rule update -g <rg> --nsg-name <nsg> -n <rule> \\\n"
            "      --source-address-prefixes <your-cidr>\n"
            "Use Azure Bastion, or just-in-time VM access in Defender for Cloud, instead "
            "of a standing inbound RDP rule."
        ),
    ),
    SecurityRule(
        rule_id="AZURE_NSG_PERMISSIVE_RULE_COUNT", version="1.0", provider=AZURE,
        resource_types=("NetworkSecurityGroup",),
        title="Network security group has many inbound rules",
        severity=MEDIUM, category=CAT_CONFIGURATION, confidence=CONF_LOW,
        evaluate=_azure_nsg_rule_count, coverage=COV_NETWORK,
        description="Five or more inbound rules are defined on this NSG.",
        rationale=(
            "An indicator only, at low confidence — breadth matters, not count. This rule "
            "exists chiefly because Azure NSGs previously had NO rule of their own and "
            "were being reported by OCI's check, under an OCI title."
        ),
        remediation=(
            "  az network nsg rule list -g <rg> --nsg-name <nsg> -o table\n"
            "Consolidate overlapping rules and delete ones no longer in use."
        ),
    ),
    SecurityRule(
        rule_id="AZURE_STORAGE_BLOB_PUBLIC_ACCESS", version="1.1", provider=AZURE,
        resource_types=("StorageAccount",),
        title="Storage account allows public blob access",
        severity=MEDIUM, category=CAT_DATA_PROTECTION,
        evaluate=_azure_storage_blob_public,
        description="allowBlobPublicAccess is enabled at the account level.",
        rationale=(
            "This setting is the account-wide gate: with it enabled, any container can be "
            "switched to anonymous read access by anyone with container-level permissions. "
            "Disabling it makes that impossible regardless of container settings."
        ),
        remediation=(
            "  az storage account update -g <rg> -n <account> "
            "--allow-blob-public-access false\n"
            "Serve genuinely public content through a CDN or user-delegation SAS instead."
        ),
    ),
    SecurityRule(
        rule_id="AZURE_STORAGE_SECURE_TRANSFER_DISABLED", version="1.0", provider=AZURE,
        resource_types=("StorageAccount",), evaluate=_azure_storage_secure_transfer,
        title="Storage account does not require secure transfer",
        severity=MEDIUM, category=CAT_ENCRYPTION, coverage=COV_ENCRYPTION,
        description="'Secure transfer required' (supportsHttpsTrafficOnly) is disabled.",
        rationale=(
            "With secure transfer off the account accepts requests over plain HTTP, so an "
            "account key or SAS token sent by a misconfigured client travels in clear "
            "text and can be replayed by anyone on the path."
        ),
        remediation=(
            "  az storage account update -g <rg> -n <account> --https-only true\n"
            "Check first that no client still calls the account over http:// — they will "
            "be refused once this is on."
        ),
    ),
    SecurityRule(
        rule_id="AZURE_STORAGE_MIN_TLS_BELOW_1_2", version="1.0", provider=AZURE,
        resource_types=("StorageAccount",), evaluate=_azure_storage_min_tls,
        title="Storage account accepts TLS older than 1.2",
        severity=MEDIUM, category=CAT_ENCRYPTION, coverage=COV_ENCRYPTION,
        description="The account's minimum TLS version is below 1.2.",
        rationale=(
            "TLS 1.0 and 1.1 have known weaknesses and are deprecated by the IETF; a floor "
            "below 1.2 lets a client or an attacker in the path negotiate them."
        ),
        remediation=(
            "  az storage account update -g <rg> -n <account> --min-tls-version TLS1_2\n"
            "Azure Monitor's storage logs show whether any client still negotiates an "
            "older version before the floor is raised."
        ),
    ),
    SecurityRule(
        rule_id="AZURE_DB_PUBLIC_NETWORK_ACCESS", version="1.0", provider=AZURE,
        resource_types=("PostgreSQLServer", "MySQLServer", "SQLServer", "CosmosDB"),
        title="Database server allows public network access",
        severity=HIGH, category=CAT_NETWORKING, evaluate=_azure_db_public_network,
        coverage=COV_NETWORK,
        description="publicNetworkAccess is Enabled, so the server has a public endpoint.",
        rationale=(
            "With public network access enabled the server is reachable from outside the "
            "virtual network, and its firewall rule list becomes the only barrier — one "
            "'allow Azure services' or 0.0.0.0 entry away from being internet-facing."
        ),
        remediation=(
            "Disable public access and use a private endpoint:\n"
            "  az postgres flexible-server update -g <rg> -n <server> "
            "--public-access Disabled\n"
            "  az network private-endpoint create ...\n"
            "If public access must stay, confirm no firewall rule spans 0.0.0.0."
        ),
    ),
    SecurityRule(
        rule_id="AZURE_DB_NO_GEO_REDUNDANT_BACKUP", version="1.0", provider=AZURE,
        resource_types=("PostgreSQLServer", "MySQLServer"),
        title="Database server has no geo-redundant backup",
        severity=LOW, category=CAT_RESILIENCE, evaluate=_azure_db_geo_backup,
        description="Geo-redundant backup is disabled, so backups exist in one region only.",
        rationale=(
            "A single-region backup shares its fate with the region holding the primary. "
            "For a regional outage or a region-wide mistake, there is nothing to restore "
            "from elsewhere."
        ),
        remediation=(
            "Geo-redundancy is selected at creation time for Flexible Server and cannot "
            "be changed in place — plan a restore into a new geo-redundant server:\n"
            "  az postgres flexible-server create ... --geo-redundant-backup Enabled\n"
            "Meanwhile consider raising retention:  --backup-retention 35"
        ),
    ),
    SecurityRule(
        rule_id="AZURE_VM_PUBLIC_IP", version="2.0", provider=AZURE,
        resource_types=("VirtualMachine",),
        title="Virtual machine has a public IP address",
        severity=INFO, category=CAT_EXPOSURE, evaluate=_azure_vm_public_ip,
        coverage=COV_NETWORK,
        description="The VM has a routable public address. Attack surface, not a "
                    "reachability verdict.",
        rationale=(
            "v1 of this rule was HIGH and asserted internet reachability. On the live "
            "Azure Production account that produced 25 HIGH findings for VMs whose NSG "
            "rules had never been collected — an assertion the data could not support. "
            "Reachability is decided by the exposure analyser, which walks NIC and subnet "
            "NSGs and reports UNKNOWN when it cannot."
        ),
        remediation=(
            "If the VM does not need to be internet-facing, dissociate the public IP and "
            "reach it through Azure Bastion:\n"
            "  az network nic ip-config update -g <rg> --nic-name <nic> \\\n"
            "      -n <ipconfig> --remove PublicIpAddress"
        ),
    ),
    SecurityRule(
        rule_id="AZURE_VM_STOPPED", version="1.1", provider=AZURE,
        resource_types=("VirtualMachine",),
        title="Virtual machine is stopped or deallocated",
        severity=MEDIUM, category=CAT_COST, evaluate=_azure_vm_stopped,
        description="The VM is not running; disks continue to bill.",
        rationale=(
            "Azure distinguishes Stopped (still billing for compute) from Deallocated "
            "(compute released). Either way the managed disks bill in full, and a "
            "long-stopped VM is usually unowned."
        ),
        remediation=(
            "Deallocate rather than stop if it must be kept:\n"
            "  az vm deallocate -g <rg> -n <vm>\n"
            "If it is no longer needed, capture an image and delete it along with its disks."
        ),
    ),
    SecurityRule(
        rule_id="AZURE_SQL_TDE_NOT_COLLECTED", version="1.0", provider=AZURE,
        resource_types=("SQLDatabase",),
        title="Azure SQL encryption at rest not assessed",
        severity=INFO, category=CAT_ENCRYPTION, evaluate=_azure_sql_tde,
        coverage=COV_ENCRYPTION,
        description="Transparent Data Encryption state is not collected by the scanner.",
        rationale=(
            "TDE is the control protecting Azure SQL data at rest. It is enabled by "
            "default on databases created since 2017, but 'probably on by default' is not "
            "an assessment — so this reports NOT_SCANNED and counts against encryption "
            "coverage rather than quietly passing."
        ),
        remediation=(
            "Verify manually until the scanner collects it:\n"
            "  az sql db tde show -g <rg> -s <server> -d <database>\n"
            "Expect status Enabled; consider a customer-managed key for regulated data."
        ),
    ),

    # ── OCI ──────────────────────────────────────────────────────────────────
    SecurityRule(
        rule_id="OCI_NSG_SSH_WORLD_OPEN", version="1.0", provider=OCI,
        resource_types=("NetworkSecurityGroup",),
        title="Network security group allows SSH from the entire internet",
        severity=CRITICAL, category=CAT_NETWORKING, evaluate=_oci_nsg_ssh,
        coverage=COV_NETWORK,
        description="An ingress rule permits TCP/22 from 0.0.0.0/0.",
        rationale=portcat.CATALOG[22].why,
        remediation=(
            "Narrow the rule's source CIDR, or remove it and use OCI Bastion:\n"
            "  oci network nsg rules update --nsg-id <ocid> --security-rules file://rules.json\n"
            "OCI NSGs are allow-only with a default deny, so removing the rule is "
            "sufficient — no explicit deny is needed."
        ),
    ),
    SecurityRule(
        rule_id="OCI_NSG_RDP_WORLD_OPEN", version="1.0", provider=OCI,
        resource_types=("NetworkSecurityGroup",),
        title="Network security group allows RDP from the entire internet",
        severity=CRITICAL, category=CAT_NETWORKING, evaluate=_oci_nsg_rdp,
        coverage=COV_NETWORK,
        description="An ingress rule permits TCP/3389 from 0.0.0.0/0.",
        rationale=portcat.CATALOG[3389].why,
        remediation=(
            "Remove or narrow the rule:\n"
            "  oci network nsg rules remove --nsg-id <ocid> --security-rule-ids <id>\n"
            "Reach Windows instances through OCI Bastion or a jump host in a private subnet."
        ),
    ),
    SecurityRule(
        rule_id="OCI_SECLIST_SSH_WORLD_OPEN", version="1.0", provider=OCI,
        resource_types=("SecurityList",),
        title="Security list allows SSH from the entire internet",
        severity=CRITICAL, category=CAT_NETWORKING, evaluate=_oci_seclist_ssh,
        coverage=COV_NETWORK,
        description="An ingress rule permits TCP/22 from 0.0.0.0/0.",
        rationale=(
            portcat.CATALOG[22].why
            + " A security list applies to every VNIC in every subnet that references it, "
            "so one permissive rule can expose an entire tier at once."
        ),
        remediation=(
            "Edit the security list's ingress rules:\n"
            "  oci network security-list update --security-list-id <ocid> \\\n"
            "      --ingress-security-rules file://rules.json\n"
            "Note that the VCN's default security list ships with a world-open SSH rule, "
            "so a subnet left on the default is exposed unless it was edited."
        ),
    ),
    SecurityRule(
        rule_id="OCI_SECLIST_RDP_WORLD_OPEN", version="1.0", provider=OCI,
        resource_types=("SecurityList",),
        title="Security list allows RDP from the entire internet",
        severity=CRITICAL, category=CAT_NETWORKING, evaluate=_oci_seclist_rdp,
        coverage=COV_NETWORK,
        description="An ingress rule permits TCP/3389 from 0.0.0.0/0.",
        rationale=(
            portcat.CATALOG[3389].why
            + " A security list applies to every VNIC in every subnet that references it."
        ),
        remediation=(
            "  oci network security-list update --security-list-id <ocid> \\\n"
            "      --ingress-security-rules file://rules.json"
        ),
    ),
    SecurityRule(
        rule_id="OCI_NSG_PERMISSIVE_RULE_COUNT", version="2.0", provider=OCI,
        resource_types=("NetworkSecurityGroup",),
        title="Network security group has many ingress rules",
        severity=MEDIUM, category=CAT_CONFIGURATION, confidence=CONF_LOW,
        evaluate=_oci_nsg_rule_count, coverage=COV_NETWORK,
        description="Five or more ingress rules are defined on this NSG.",
        rationale=(
            "An indicator only, at low confidence. v1 was HIGH severity and — because it "
            "dispatched on resource type alone — also fired against 20 Azure NSGs under "
            "an OCI title."
        ),
        remediation=(
            "  oci network nsg rules list --nsg-id <ocid>\n"
            "Consolidate overlapping rules and remove ones no longer needed."
        ),
    ),
    SecurityRule(
        rule_id="OCI_SECURITY_LIST_PERMISSIVE_RULE_COUNT", version="1.0", provider=OCI,
        resource_types=("SecurityList",),
        title="Security list has many ingress rules",
        severity=MEDIUM, category=CAT_CONFIGURATION, confidence=CONF_LOW,
        evaluate=_oci_seclist_rule_count, coverage=COV_NETWORK,
        description="Five or more ingress rules are defined on this security list.",
        rationale=(
            "Low confidence, and included mainly for coverage: the live OCI tenancy has "
            "49 security lists and only 2 NSGs, so a rule that checked NSGs alone examined "
            "4% of the access controls actually in force."
        ),
        remediation=(
            "  oci network security-list get --security-list-id <ocid>\n"
            "Prefer NSGs for new workloads — they attach to VNICs rather than whole "
            "subnets, which makes their blast radius easier to reason about."
        ),
    ),
    SecurityRule(
        rule_id="OCI_IAM_POLICY_TENANCY_ADMIN", version="2.0", provider=OCI,
        resource_types=("IAMPolicy",),
        title="Policy grants manage over all resources tenancy-wide",
        severity=CRITICAL, category=CAT_IAM, evaluate=_oci_policy_tenancy_admin,
        coverage=COV_IAM,
        description="A statement reads 'allow ... to manage all-resources in tenancy'.",
        rationale=(
            "This is unrestricted administrative control of the entire tenancy — every "
            "compartment, every resource, including the ability to remove the audit "
            "configuration. If the subject is any-user, no authentication is required at "
            "all."
        ),
        remediation=(
            "Replace with least-privilege statements scoped to a compartment and a "
            "resource family:\n"
            "  allow group Ops to manage instance-family in compartment Dev\n"
            "Keep at most one break-glass administrators group, and audit its use."
        ),
    ),
    SecurityRule(
        rule_id="OCI_IAM_POLICY_ESCALATION", version="1.0", provider=OCI,
        resource_types=("IAMPolicy",),
        title="Policy allows managing identity objects (privilege escalation)",
        severity=CRITICAL, category=CAT_IAM, evaluate=_oci_policy_escalation,
        coverage=COV_IAM,
        description="A statement grants manage over policies, groups, users, "
                    "dynamic-groups or domains.",
        rationale=(
            "An identity that can rewrite policy can grant itself anything else, so every "
            "other restriction on it is advisory. This is materially different from merely "
            "broad access and is reported separately for that reason."
        ),
        remediation=(
            "Restrict identity administration to a single dedicated group, scoped to the "
            "identity domain, and require MFA for it. Remove 'manage policies' from any "
            "workload or automation group."
        ),
    ),
    SecurityRule(
        rule_id="OCI_IAM_POLICY_BROAD_MANAGE", version="1.0", provider=OCI,
        resource_types=("IAMPolicy",),
        title="Policy grants tenancy-wide manage over a resource family",
        severity=HIGH, category=CAT_IAM, evaluate=_oci_policy_broad_manage,
        coverage=COV_IAM,
        description="A statement grants manage over a *-family across the whole tenancy.",
        rationale=(
            "Tenancy-wide manage crosses every compartment boundary, which defeats the "
            "isolation compartments exist to provide — a development group can delete "
            "production resources."
        ),
        remediation=(
            "Scope the statement to the compartments that need it:\n"
            "  allow group Dev to manage instance-family in compartment Dev\n"
            "Add a `where` clause if only specific operations are required."
        ),
    ),
    SecurityRule(
        rule_id="OCI_BUCKET_PUBLIC_ACCESS", version="1.1", provider=OCI,
        resource_types=("ObjectStorageBucket",),
        title="Object storage bucket allows public access",
        severity=HIGH, category=CAT_DATA_PROTECTION, evaluate=_oci_bucket_public,
        description="Public access type is not NoPublicAccess.",
        rationale=(
            "ObjectRead or ObjectReadWithoutList lets anyone on the internet fetch "
            "objects without credentials. Bucket listing may be disabled, but object "
            "names are frequently guessable or discoverable elsewhere."
        ),
        remediation=(
            "  oci os bucket update --bucket-name <name> --public-access-type NoPublicAccess\n"
            "Serve genuinely public content through pre-authenticated requests with an "
            "expiry, so access can be revoked."
        ),
    ),
    SecurityRule(
        rule_id="OCI_OKE_PUBLIC_ENDPOINT", version="1.1", provider=OCI,
        resource_types=("OKECluster",),
        title="Kubernetes API endpoint is public",
        severity=HIGH, category=CAT_NETWORKING, evaluate=_oci_oke_public_endpoint,
        coverage=COV_NETWORK,
        description="The cluster's API server has a public IP enabled.",
        rationale=(
            "The Kubernetes API is the cluster's control plane: it can create workloads, "
            "read secrets and change RBAC. A public endpoint puts that behind "
            "authentication alone, with no network barrier."
        ),
        remediation=(
            "Move to a private endpoint and reach it through OCI Bastion or a jump host. "
            "If it must stay public, restrict the NSG on the API endpoint to known CIDRs "
            "and confirm the cluster is not running with a permissive default "
            "ClusterRoleBinding."
        ),
    ),
    SecurityRule(
        rule_id="OCI_APIGW_PUBLIC_ENDPOINT", version="2.0", provider=OCI,
        resource_types=("APIGateway",),
        title="API gateway has a public endpoint",
        severity=MEDIUM, category=CAT_NETWORKING, evaluate=_oci_apigw_public,
        description="The gateway's endpoint type is PUBLIC.",
        rationale=(
            "A public gateway is a normal and often intended configuration — the risk is a "
            "deployment on it with no authorizer, which turns the gateway into an "
            "unauthenticated front door to a backend service."
        ),
        remediation=(
            "Attach a JWT or custom authorizer to every deployment:\n"
            "  oci api-gateway deployment update --deployment-id <ocid> "
            "--specification file://spec.json\n"
            "Use a PRIVATE endpoint type for gateways serving internal consumers only."
        ),
    ),
    SecurityRule(
        rule_id="OCI_DEFAULT_SECLIST_WORLD_OPEN", version="1.0", provider=OCI,
        resource_types=("SecurityList",), evaluate=_oci_default_seclist_open,
        title="Default security list allows non-ICMP traffic from the internet",
        severity=LOW, category=CAT_NETWORKING, coverage=COV_NETWORK,
        description="A VCN's default security list has an ingress rule from 0.0.0.0/0 for a "
                    "protocol other than ICMP.",
        rationale=(
            "Every subnet created without an explicit security list inherits the default "
            "one, and the stock default opens TCP 22 to the internet. Tightening it makes "
            "an unconfigured subnet closed rather than open."
        ),
        remediation=(
            "Remove the world-open non-ICMP ingress rules from each VCN's default security "
            "list, and give subnets purpose-built security lists or NSGs:\n"
            "  oci network security-list update --security-list-id <ocid> "
            "--ingress-security-rules '<rules without 0.0.0.0/0 TCP/UDP>'"
        ),
    ),
    SecurityRule(
        rule_id="OCI_RESOURCE_IN_ROOT_COMPARTMENT", version="1.0", provider=OCI,
        resource_types=_OCI_ROOT_COMPARTMENT_TYPES, evaluate=_oci_in_root_compartment,
        title="Resources created in the root compartment",
        severity=LOW, category=CAT_GOVERNANCE, aggregate=True,
        description="Networks, compute, storage or databases sit directly in the tenancy's "
                    "root compartment.",
        rationale=(
            "Compartments are OCI's unit of access control and isolation. Anything in the "
            "root can only be governed by tenancy-wide policy, so granting a team access "
            "to it means granting access to everything else there as well."
        ),
        remediation=(
            "Create compartments per workload or environment and move the resources:\n"
            "  oci <service> <resource> change-compartment --<resource>-id <ocid> "
            "--compartment-id <target>\n"
            "Then scope policies to those compartments rather than the tenancy."
        ),
    ),
    SecurityRule(
        rule_id="OCI_COMPUTE_LEGACY_IMDS_ENABLED", version="1.0", provider=OCI,
        resource_types=("ComputeInstance",), evaluate=_oci_compute_legacy_imds,
        title="Compute instance still serves the legacy metadata endpoint",
        severity=MEDIUM, category=CAT_CONFIGURATION,
        description="The instance's legacy (v1) instance metadata service endpoints are "
                    "enabled.",
        rationale=(
            "The v1 metadata endpoints answer unauthenticated GET requests, the same "
            "property that makes AWS IMDSv1 a target for server-side request forgery. "
            "The v2 endpoints require a header such requests do not usually carry."
        ),
        remediation=(
            "  oci compute instance update --instance-id <ocid> "
            "--instance-options '{\"areLegacyImdsEndpointsDisabled\": true}'\n"
            "Recent Oracle-provided images use v2 already; older agents may need updating."
        ),
    ),
    SecurityRule(
        rule_id="OCI_COMPUTE_PUBLIC_IP", version="2.0", provider=OCI,
        resource_types=("ComputeInstance",),
        title="Compute instance has a public IP address",
        severity=INFO, category=CAT_EXPOSURE, evaluate=_oci_compute_public_ip,
        coverage=COV_NETWORK,
        description="The instance has a routable public address. Attack surface, not a "
                    "reachability verdict.",
        rationale=(
            "A public IP is a precondition for exposure, not exposure itself. v1 reported "
            "this at HIGH and claimed direct internet reachability without consulting any "
            "NSG or security list."
        ),
        remediation=(
            "If the instance need not be internet-facing, move it to a private subnet and "
            "front it with a load balancer or NAT gateway. Otherwise confirm on the "
            "Internet Exposure tab that only intended ports are reachable."
        ),
    ),
    SecurityRule(
        rule_id="OCI_SUBNET_PUBLIC", version="1.0", provider=OCI,
        resource_types=("Subnet",),
        title="Subnet is public",
        severity=INFO, category=CAT_CONFIGURATION, evaluate=_oci_subnet_public,
        coverage=COV_NETWORK,
        description="The subnet permits public IP assignment.",
        rationale=(
            "Normal and necessary for load balancer and bastion subnets. Recorded so that "
            "a database or application instance found in a public subnet is visible as a "
            "placement question."
        ),
        remediation=(
            "Public subnets are appropriate for internet-facing tiers. Confirm that only "
            "resources intended to be reachable are placed here; a subnet's public/private "
            "setting cannot be changed after creation, so this means moving the resource."
        ),
    ),
    SecurityRule(
        rule_id="OCI_VOLUME_ENCRYPTION_NOT_CUSTOMER_MANAGED", version="1.0", provider=OCI,
        resource_types=("BlockVolume", "BootVolume", "FileSystem"),
        title="Storage uses an Oracle-managed encryption key",
        severity=INFO, category=CAT_ENCRYPTION, evaluate=_oci_volume_customer_key,
        coverage=COV_ENCRYPTION,
        description="No Vault (KMS) key is assigned, so the Oracle-managed default is used.",
        rationale=(
            "The volume IS encrypted at rest — this is not a protection gap. What an "
            "Oracle-managed key does not provide is rotation you control, an audit trail "
            "of key use, or the ability to make data unreadable by disabling a key."
        ),
        remediation=(
            "Assign a Vault key for regulated data:\n"
            "  oci bv volume update --volume-id <ocid> --kms-key-id <key-ocid>\n"
            "Existing data is re-encrypted in the background."
        ),
    ),
    SecurityRule(
        rule_id="OCI_ADB_AUTOSCALING_DISABLED", version="1.1", provider=OCI,
        resource_types=("AutonomousDatabase",),
        title="Autonomous Database auto-scaling is disabled",
        severity=LOW, category=CAT_RESILIENCE, evaluate=_oci_adb_autoscale,
        description="Auto-scaling is off, fixing the database at its base core count.",
        rationale=(
            "Without auto-scaling the database cannot absorb a traffic spike, so load "
            "that would have been served slowly is instead served with errors — an "
            "availability rather than a confidentiality concern."
        ),
        remediation=(
            "  oci db autonomous-database update --autonomous-database-id <ocid> \\\n"
            "      --is-auto-scaling-enabled true\n"
            "Auto-scaling permits up to 3x the base OCPU count and bills only what is used."
        ),
    ),
    SecurityRule(
        rule_id="OCI_FUNCTION_LONG_TIMEOUT", version="1.1", provider=OCI,
        resource_types=("Function",),
        title="Function has a long timeout",
        severity=MEDIUM, category=CAT_PERFORMANCE, evaluate=_oci_function_timeout,
        description="The timeout exceeds 300 seconds.",
        rationale=(
            "A long timeout lets a hung invocation hold resources and bill for the full "
            "window, and masks a performance problem that would otherwise surface as an "
            "error. Not a security matter, so it does not affect the security score."
        ),
        remediation=(
            "  oci fn function update --function-id <ocid> --timeout-in-seconds 60\n"
            "Set it to the observed p99 duration plus a margin."
        ),
    ),
    SecurityRule(
        rule_id="OCI_COMPUTE_LARGE_SHAPE", version="1.1", provider=OCI,
        resource_types=("ComputeInstance",),
        title="Large compute instance — review sizing",
        severity=INFO, category=CAT_COST, evaluate=_oci_compute_large,
        description="The instance has 16 or more OCPUs.",
        rationale=(
            "Informational. A large shape is not a problem in itself; it is worth "
            "confirming against utilisation because it is one of the largest single line "
            "items on a cloud bill."
        ),
        remediation=(
            "Check CPU utilisation in OCI Monitoring over 30 days and resize if "
            "consistently below 30%:\n"
            "  oci compute instance update --instance-id <ocid> --shape-config '{\"ocpus\":8}'"
        ),
    ),

    # ── Cross-provider ───────────────────────────────────────────────────────
    SecurityRule(
        rule_id="GOVERNANCE_MISSING_OWNERSHIP_TAGS", version="2.0", provider="*",
        resource_types=("*",),
        title="Resources are missing ownership tags",
        severity=LOW, category=CAT_GOVERNANCE, evaluate=_missing_tags,
        aggregate=True,
        description="Name, Environment or Owner tags are absent.",
        rationale=(
            "An untagged resource has no identifiable owner, which is what turns an "
            "incident into an archaeology exercise and leaves cost unattributable. It is "
            "a real problem and it is hygiene, not a control failure — so it is "
            "aggregated into one finding per account with a drill-down, and its total "
            "contribution to the security score is capped. v1 emitted one finding per "
            "resource, which was 550 of one live account's 606 findings and drove the "
            "score to zero on its own."
        ),
        remediation=(
            "Apply the tags, then prevent recurrence with policy:\n"
            "  AWS   — a tag-policy SCP, or required tags in the provisioning pipeline\n"
            "  Azure — Azure Policy 'Require a tag on resources' (deny effect)\n"
            "  OCI   — a tag namespace with a default value on the compartment"
        ),
    ),
]


# ── Synthetic rules: findings produced by the analysers, not by evaluators ───
# They are declared here so that rule_version, remediation text, category and
# compliance mapping work identically for an exposure finding and a config
# finding. The engine constructs them; there is no per-resource evaluator.

_SYNTHETIC: List[SecurityRule] = [
    SecurityRule(
        rule_id="EXPOSURE_MANAGEMENT_PORT_WORLD_OPEN", version="1.0", provider="*",
        resource_types=("*",), synthetic=True,
        title="Internet-reachable remote management port",
        severity=CRITICAL, category=CAT_EXPOSURE, coverage=COV_EXPOSURE,
        description="A resource with a public address permits inbound traffic from the "
                    "entire internet on a remote-management port.",
        rationale=(
            "Unlike a permissive rule on its own, this is a confirmed path: a public "
            "address, and a rule that actually governs it allowing the whole internet in. "
            "Management ports grant interactive control of the host."
        ),
        remediation=(
            "Restrict the rule's source to a VPN or bastion range, or remove public "
            "exposure entirely and use the provider's session service — AWS Systems "
            "Manager Session Manager, Azure Bastion, or OCI Bastion — none of which need "
            "an inbound rule."
        ),
    ),
    SecurityRule(
        rule_id="EXPOSURE_DATA_PORT_WORLD_OPEN", version="1.0", provider="*",
        resource_types=("*",), synthetic=True,
        title="Internet-reachable database or data-store port",
        severity=CRITICAL, category=CAT_EXPOSURE, coverage=COV_EXPOSURE,
        description="A resource with a public address permits inbound traffic from the "
                    "entire internet on a database or data-store port.",
        rationale=(
            "The worst class of exposure. A reachable database answers queries — no "
            "further exploit is needed — and several of these services ship with no "
            "authentication enabled by default."
        ),
        remediation=(
            "Remove the public rule immediately; a database should never accept "
            "connections from 0.0.0.0/0. Place it in a private subnet and reach it from "
            "the application tier, a VPN, or a bastion. Then rotate credentials and "
            "review access logs, on the assumption that it was found."
        ),
    ),
    SecurityRule(
        rule_id="EXPOSURE_ALL_PORTS_WORLD_OPEN", version="1.0", provider="*",
        resource_types=("*",), synthetic=True,
        title="Every port reachable from the entire internet",
        severity=CRITICAL, category=CAT_EXPOSURE, coverage=COV_EXPOSURE,
        description="A rule opens all ports, or all protocols, from 0.0.0.0/0 to a "
                    "resource with a public address.",
        rationale=(
            "Whatever is listening on the host is reachable, including services nobody "
            "knows are running. An allow-all rule also defeats the purpose of every other "
            "rule on the same resource."
        ),
        remediation=(
            "Replace the allow-all rule with explicit per-port rules for the services "
            "that genuinely need to be public, and nothing else."
        ),
    ),
    SecurityRule(
        rule_id="EXPOSURE_PORT_WORLD_OPEN", version="1.0", provider="*",
        resource_types=("*",), synthetic=True,
        title="Internet-reachable port",
        severity=MEDIUM, category=CAT_EXPOSURE, coverage=COV_EXPOSURE,
        description="A resource with a public address permits inbound traffic from the "
                    "entire internet on a port that is not a well-known service.",
        rationale=(
            "An attacker scanning the address space does not limit themselves to "
            "well-known port numbers. An open port with an unidentified service behind it "
            "is worth confirming was intended."
        ),
        remediation=(
            "Identify what is listening on the port and either restrict the source range "
            "or close it. If it fronts a web service, put it behind a load balancer or "
            "WAF rather than exposing the instance directly."
        ),
    ),
    SecurityRule(
        rule_id="EXPOSURE_UNDETERMINED", version="1.0", provider="*",
        resource_types=("*",), synthetic=True,
        title="Internet exposure could not be determined",
        severity=MEDIUM, category=CAT_EXPOSURE, confidence=CONF_UNKNOWN,
        coverage=COV_EXPOSURE,
        description="The resource is internet-facing, but the rules governing it could "
                    "not be resolved from the stored inventory.",
        rationale=(
            "This finding exists because the alternative is worse. A resource whose rules "
            "cannot be resolved used to be skipped silently, so 49 Azure VMs — 25 with "
            "public addresses — produced 'No internet exposure found'. An unresolved "
            "resource is reported as unresolved."
        ),
        remediation=(
            "Re-run discovery for this account and confirm it completes without scope "
            "failures. If the account's credentials lack network read permissions, grant "
            "them: Microsoft.Network/networkInterfaces/read and "
            "networkSecurityGroups/read for Azure, ec2:DescribeSecurityGroups for AWS, "
            "or the equivalent OCI network inspect policy."
        ),
    ),
    SecurityRule(
        rule_id="AWS_IAM_ROLE_ESCALATION", version="1.0", provider=AWS,
        resource_types=("IAMRole",), evaluate=_aws_iam_escalation,
        title="IAM role can modify IAM itself (privilege escalation)",
        severity=CRITICAL, category=CAT_IAM, coverage=COV_IAM,
        description="The role holds a wildcard grant over the iam service.",
        rationale=(
            "A role that can write IAM can grant itself every other permission, so any "
            "other limit on it is advisory. This is a different and worse problem than "
            "broad access, and is reported separately for that reason."
        ),
        remediation=(
            "Remove iam:* and grant only the specific actions needed (typically "
            "iam:PassRole for a narrow set of roles). Where genuine IAM administration is "
            "required, use a dedicated role with a permissions boundary and MFA."
        ),
    ),
    SecurityRule(
        rule_id="AWS_IAM_ROLE_FULL_ADMIN", version="1.0", provider=AWS,
        resource_types=("IAMRole",), evaluate=_aws_iam_full_admin,
        title="IAM role has full administrator access (*:*)",
        severity=CRITICAL, category=CAT_IAM, coverage=COV_IAM,
        description="A policy attached to the role allows every action on every resource.",
        rationale=(
            "Action \"*\" on Resource \"*\" is the AdministratorAccess shape: it can read and "
            "delete every resource, disable logging, and change IAM itself. Until this "
            "rule existed such a role summarised to no grants at all and every IAM check "
            "reported it clean — the one role that most needed a finding had none."
        ),
        remediation=(
            "Confirm the role genuinely needs full administration. If not, replace the "
            "policy with the specific services and actions in use — IAM Access Analyzer "
            "can generate one from CloudTrail history:\n"
            "  aws accessanalyzer start-policy-generation --policy-generation-details "
            "principalArn=<role-arn>\n"
            "If it does, restrict who may assume it (trust policy conditions, MFA) and "
            "prefer short sessions."
        ),
    ),
    SecurityRule(
        rule_id="AWS_IAM_ROLE_WILDCARD_FULL", version="1.0", provider=AWS,
        resource_types=("IAMRole",), evaluate=_aws_iam_wildcard_full,
        title="IAM role has full wildcard access to one or more services",
        severity=HIGH, category=CAT_IAM, coverage=COV_IAM,
        description="The role grants read, write and delete over an entire service with "
                    "no resource constraint.",
        rationale=(
            "A service-wide wildcard means every current and future resource of that "
            "service, in every region — including ones created after the grant was "
            "reviewed. Delete permission makes it a availability risk as well as a "
            "confidentiality one."
        ),
        remediation=(
            "Replace <service>:* with the specific actions in use, and add a Resource "
            "constraint. IAM Access Analyzer can generate a least-privilege policy from "
            "the role's CloudTrail history:\n"
            "  aws accessanalyzer start-policy-generation --policy-generation-details "
            "principalArn=<role-arn>"
        ),
    ),
    SecurityRule(
        rule_id="AWS_IAM_ROLE_WILDCARD_WRITE", version="1.0", provider=AWS,
        resource_types=("IAMRole",), evaluate=_aws_iam_wildcard_write,
        title="IAM role has wildcard write access to one or more services",
        severity=MEDIUM, category=CAT_IAM, coverage=COV_IAM,
        description="The role grants unconstrained write access over an entire service.",
        rationale=(
            "Write access without a resource constraint permits modification of any "
            "resource in the service, which is enough to disrupt a workload even without "
            "read access to its data."
        ),
        remediation=(
            "Scope the write actions to the specific resources the workload owns, using "
            "an ARN pattern or a tag condition in the Resource element."
        ),
    ),
    # ── Azure RBAC ───────────────────────────────────────────────────────────
    # Constructed from cloud_identity_grants by identity.py, not from
    # cloud_resources — a role assignment is not infrastructure. Severity turns
    # on the role's real `actions` list rather than on a recognised role GUID,
    # so a custom role with the same power is caught too.
    SecurityRule(
        rule_id="AZURE_RBAC_SUBSCRIPTION_OWNER", version="1.0", provider=AZURE,
        resource_types=("*",), synthetic=True,
        title="Principal holds full control over the entire subscription",
        severity=CRITICAL, category=CAT_IAM, coverage=COV_IAM,
        description="A role granting the wildcard action '*' is assigned at subscription "
                    "or management-group scope.",
        rationale=(
            "This is unrestricted control of everything in the subscription, including "
            "the ability to grant further access, delete resource locks and remove "
            "diagnostic settings. Owner assignments at subscription scope should be rare, "
            "few and human — a service principal holding one is a standing compromise of "
            "the whole subscription if its secret leaks."
        ),
        remediation=(
            "Move the assignment down to the narrowest scope that works, and prefer a "
            "purpose-built role over Owner:\n"
            "  az role assignment delete --assignee <principal> --role Owner \\\n"
            "      --scope /subscriptions/<sub>\n"
            "  az role assignment create --assignee <principal> --role Contributor \\\n"
            "      --scope /subscriptions/<sub>/resourceGroups/<rg>\n"
            "Where subscription-level Owner is genuinely needed, put it behind Privileged "
            "Identity Management with approval and an expiry rather than standing access."
        ),
    ),
    SecurityRule(
        rule_id="AZURE_RBAC_ESCALATION", version="1.0", provider=AZURE,
        resource_types=("*",), synthetic=True,
        title="Principal can grant itself further access (privilege escalation)",
        severity=CRITICAL, category=CAT_IAM, coverage=COV_IAM,
        description="The assigned role includes Microsoft.Authorization write actions, so "
                    "the holder can create role assignments.",
        rationale=(
            "A principal that can write role assignments can grant itself Owner, so every "
            "other limit on it is advisory. This is reported separately from broad access "
            "because it is a different class of problem: broad access is bounded by what "
            "was granted, escalation is not bounded at all."
        ),
        remediation=(
            "Remove the assignment, or replace the role with one that has no "
            "Microsoft.Authorization/*/write action:\n"
            "  az role assignment delete --assignee <principal> --scope <scope>\n"
            "Where delegated access management is required, use 'Role Based Access "
            "Control Administrator', which is constrained by a condition limiting which "
            "roles it may assign."
        ),
    ),
    SecurityRule(
        rule_id="AZURE_RBAC_BROAD_WRITE", version="1.0", provider=AZURE,
        resource_types=("*",), synthetic=True,
        title="Principal has broad write access at subscription scope",
        severity=HIGH, category=CAT_IAM, coverage=COV_IAM,
        description="A role with unconstrained write actions (Contributor-equivalent) is "
                    "assigned at subscription or management-group scope.",
        rationale=(
            "Write access across a whole subscription is enough to delete production "
            "resources, change network rules and disable logging. It cannot grant further "
            "access — which is what separates it from Owner — but it can destroy or "
            "expose everything already there."
        ),
        remediation=(
            "Scope the assignment to the resource groups the principal actually works in:\n"
            "  az role assignment create --assignee <principal> --role Contributor \\\n"
            "      --scope /subscriptions/<sub>/resourceGroups/<rg>\n"
            "then remove the subscription-scoped one."
        ),
    ),
    SecurityRule(
        rule_id="AZURE_RBAC_EXTERNAL_PRINCIPAL_PRIVILEGED", version="1.0", provider=AZURE,
        resource_types=("*",), synthetic=True,
        title="External or guest principal holds privileged access",
        severity=HIGH, category=CAT_IAM, coverage=COV_IAM,
        description="A principal outside this tenant's own directory objects (guest user "
                    "or foreign group) holds a role with broad write or full control.",
        rationale=(
            "An external principal's lifecycle is not controlled by this tenant: it is not "
            "covered by the organisation's joiner-mover-leaver process, so access granted "
            "to it can outlive the relationship that justified it. Combined with broad "
            "write or full control, that is standing third-party access to the "
            "subscription."
        ),
        remediation=(
            "Confirm the external relationship is current and the access is still needed:\n"
            "  az role assignment list --assignee <principal> --all -o table\n"
            "Prefer Azure Lighthouse for delegated partner administration, which is "
            "auditable and revocable in one step, over direct guest assignments."
        ),
    ),
    SecurityRule(
        rule_id="AZURE_RBAC_NOT_COLLECTED", version="2.0", provider=AZURE,
        resource_types=("*",), synthetic=True,
        title="Azure RBAC role assignments not collected",
        severity=INFO, category=CAT_IAM, confidence=CONF_UNKNOWN, coverage=COV_IAM,
        description="No identity review is possible for this subscription because role "
                    "assignments are not in the inventory.",
        rationale=(
            "Reported as an explicit gap rather than an empty result. An empty identity "
            "review reads as 'no over-permissioned identities', which is a claim this "
            "product has no basis for making about Azure."
        ),
        remediation=(
            "Until the scanner collects assignments, review manually:\n"
            "  az role assignment list --all --include-inherited -o table\n"
            "Look for Owner or Contributor at subscription scope, and for assignments to "
            "service principals that should be scoped to a resource group."
        ),
    ),
]

# ── Certificates, secrets and keys ───────────────────────────────────────────
# Synthetic: produced by security/credentials.py from the credential inventory,
# not by a per-resource evaluator. Declared here so version, remediation and
# control mapping work exactly as for every other finding.
from app.security import credentials as _cx  # noqa: E402

_CREDENTIAL_RULES: List[SecurityRule] = [
    SecurityRule(
        rule_id=_cx.CERT_EXPIRED, version="1.0", provider="*", resource_types=("*",),
        synthetic=True, title="Certificate has expired",
        severity=HIGH, category=CAT_ENCRYPTION, coverage=COV_CREDENTIALS,
        description="A TLS certificate is past its validity end date.",
        rationale=(
            "An expired certificate that is still served breaks every client that "
            "validates it — browsers, API clients, mobile apps — and teaches users to "
            "click through certificate warnings. PCI-DSS 4.2.1 requires certificates used "
            "to protect data in transit to be confirmed valid and not expired."
        ),
        remediation=(
            "Renew or re-issue the certificate and redeploy it where it is used, then "
            "delete the expired one. Per store:\n"
            "  AWS ACM:        aws acm describe-certificate --certificate-arn <arn>  "
            "(re-request or re-import)\n"
            "  Azure Key Vault: az keyvault certificate create / import --vault-name <v>\n"
            "  OCI:            renew in Certificates, or upload a new one to the load "
            "balancer and switch the listener to it."
        ),
    ),
    SecurityRule(
        rule_id=_cx.CERT_EXPIRING_SOON, version="1.0", provider="*", resource_types=("*",),
        synthetic=True, title="Certificate expires within 30 days",
        severity=LOW, category=CAT_ENCRYPTION, coverage=COV_CREDENTIALS,
        description="A TLS certificate is still valid but reaches its end date soon.",
        rationale=(
            "Operational, not a control failure: the certificate is valid today. It is "
            "reported because renewal takes lead time (validation, change windows, "
            "deploying to every listener) and because provider-managed renewal should "
            "already have happened this close to expiry — if it has not, it is stuck."
        ),
        remediation=(
            "Renew now and schedule the deployment. For a provider-managed certificate "
            "that has not renewed, check why: ACM usually needs its DNS validation "
            "record restored; a Key Vault certificate needs its issuer reachable.\n"
            "To be paged ahead of time, add an alert rule on 'Certificate or secret "
            "expiry' with the window your team needs."
        ),
    ),
    SecurityRule(
        rule_id=_cx.AWS_IAM_SERVER_CERT_EXPIRED, version="1.0", provider=AWS,
        resource_types=("*",), synthetic=True,
        title="Expired SSL/TLS certificate stored in IAM",
        severity=HIGH, category=CAT_ENCRYPTION, coverage=COV_CREDENTIALS,
        description="An IAM server certificate is past its expiration date.",
        rationale=(
            "IAM server certificates are never renewed by AWS. One that is expired can be "
            "deployed to a load balancer or CloudFront by mistake, and there is no reason "
            "to keep it. CIS AWS Foundations recommends removing every expired one."
        ),
        remediation=(
            "  aws iam list-server-certificates\n"
            "  aws iam delete-server-certificate --server-certificate-name <name>\n"
            "Prefer ACM for new certificates: it renews them."
        ),
    ),
    SecurityRule(
        rule_id=_cx.SECRET_EXPIRED, version="1.0", provider="*", resource_types=("*",),
        synthetic=True, title="Secret or key has expired but is still enabled",
        severity=MEDIUM, category=CAT_ENCRYPTION, coverage=COV_CREDENTIALS,
        description="A secret or key is past the expiry date set on it and remains enabled.",
        rationale=(
            "An expiry date is a statement that the value should no longer be trusted. "
            "Depending on the store, clients are then refused it (OCI can block retrieval; "
            "Key Vault keys refuse operations) or keep using a credential everyone agreed "
            "was retired — both are worse than rotating on time."
        ),
        remediation=(
            "Rotate the value and set a new expiry, or disable the object if nothing uses "
            "it:\n"
            "  az keyvault secret set --vault-name <v> -n <name> --value <new> "
            "--expires <date>\n"
            "  OCI: create a new secret version, or update the secret's expiry rule."
        ),
    ),
    SecurityRule(
        rule_id=_cx.SECRET_EXPIRING_SOON, version="1.0", provider="*", resource_types=("*",),
        synthetic=True, title="Secret or key expires within 30 days",
        severity=LOW, category=CAT_ENCRYPTION, coverage=COV_CREDENTIALS,
        description="A secret or key reaches the expiry date set on it soon.",
        rationale=(
            "Operational: nothing is wrong yet. Rotating before the date avoids an "
            "application finding out at run time."
        ),
        remediation=(
            "Rotate the value and move its expiry forward before the date, and update "
            "every consumer to read the new version."
        ),
    ),
    SecurityRule(
        rule_id=_cx.AZURE_KEYVAULT_RBAC_KEY_NO_EXPIRY, version="1.0", provider=AZURE,
        resource_types=("*",), synthetic=True,
        title="Key Vault keys without an expiration date (RBAC vault)",
        severity=LOW, category=CAT_ENCRYPTION, coverage=COV_CREDENTIALS,
        description="Enabled keys in a vault using Azure RBAC have no expiry set.",
        rationale=(
            "A key without an expiry is used indefinitely, so a compromised or "
            "superseded key never ages out. CIS Azure recommends an expiration date on "
            "every key."
        ),
        remediation=(
            "  az keyvault key set-attributes --vault-name <v> -n <key> --expires <date>\n"
            "Pair it with a rotation policy so a new version is created before the date."
        ),
    ),
    SecurityRule(
        rule_id=_cx.AZURE_KEYVAULT_POLICY_KEY_NO_EXPIRY, version="1.0", provider=AZURE,
        resource_types=("*",), synthetic=True,
        title="Key Vault keys without an expiration date (access-policy vault)",
        severity=LOW, category=CAT_ENCRYPTION, coverage=COV_CREDENTIALS,
        description="Enabled keys in a vault using access policies have no expiry set.",
        rationale=(
            "A key without an expiry is used indefinitely, so a compromised or "
            "superseded key never ages out. CIS Azure recommends an expiration date on "
            "every key, and lists access-policy vaults separately."
        ),
        remediation=(
            "  az keyvault key set-attributes --vault-name <v> -n <key> --expires <date>\n"
            "Consider moving the vault to the Azure RBAC permission model."
        ),
    ),
    SecurityRule(
        rule_id=_cx.AZURE_KEYVAULT_RBAC_SECRET_NO_EXPIRY, version="1.0", provider=AZURE,
        resource_types=("*",), synthetic=True,
        title="Key Vault secrets without an expiration date (RBAC vault)",
        severity=LOW, category=CAT_ENCRYPTION, coverage=COV_CREDENTIALS,
        description="Enabled secrets in a vault using Azure RBAC have no expiry set.",
        rationale=(
            "Secrets with no expiry are the ones nobody rotates. An expiration date makes "
            "the rotation obligation visible and alertable. CIS Azure recommends one on "
            "every secret."
        ),
        remediation=(
            "  az keyvault secret set-attributes --vault-name <v> -n <secret> "
            "--expires <date>"
        ),
    ),
    SecurityRule(
        rule_id=_cx.AZURE_KEYVAULT_POLICY_SECRET_NO_EXPIRY, version="1.0", provider=AZURE,
        resource_types=("*",), synthetic=True,
        title="Key Vault secrets without an expiration date (access-policy vault)",
        severity=LOW, category=CAT_ENCRYPTION, coverage=COV_CREDENTIALS,
        description="Enabled secrets in a vault using access policies have no expiry set.",
        rationale=(
            "Secrets with no expiry are the ones nobody rotates. CIS Azure recommends an "
            "expiration date on every secret, and lists access-policy vaults separately."
        ),
        remediation=(
            "  az keyvault secret set-attributes --vault-name <v> -n <secret> "
            "--expires <date>"
        ),
    ),
    SecurityRule(
        rule_id=_cx.AZURE_KEYVAULT_NOT_RECOVERABLE, version="1.0", provider=AZURE,
        resource_types=("*",), synthetic=True,
        title="Key Vault is not protected against permanent deletion",
        severity=MEDIUM, category=CAT_ENCRYPTION, coverage=COV_CREDENTIALS,
        description="Purge protection is not enabled (or soft delete is off) on the vault.",
        rationale=(
            "Without purge protection a deleted vault or key can be purged immediately — "
            "by an attacker or by mistake — and every disk or database encrypted with a "
            "key in it becomes unreadable for good. Soft delete alone can be undone by "
            "purging."
        ),
        remediation=(
            "  az keyvault update -g <rg> -n <vault> --enable-purge-protection true\n"
            "Purge protection cannot be turned off again once on, which is the point."
        ),
    ),
    SecurityRule(
        rule_id=_cx.AWS_SECRETSMANAGER_ROTATION_DISABLED, version="1.0", provider=AWS,
        resource_types=("*",), synthetic=True,
        title="Secrets Manager secret has automatic rotation disabled",
        severity=LOW, category=CAT_ENCRYPTION, coverage=COV_CREDENTIALS,
        confidence=CONF_MEDIUM,
        description="Automatic rotation is not configured for a Secrets Manager secret.",
        rationale=(
            "A credential that never rotates stays valid for as long as anyone who ever "
            "saw it keeps a copy. Secrets owned by another AWS service rotate through that "
            "service and are not reported."
        ),
        remediation=(
            "  aws secretsmanager rotate-secret --secret-id <arn> "
            "--rotation-lambda-arn <fn> --rotation-rules AutomaticallyAfterDays=30\n"
            "For RDS credentials, prefer managing the master password in Secrets Manager "
            "through RDS, which rotates it for you."
        ),
    ),
    SecurityRule(
        rule_id=_cx.SECRET_ROTATION_OVERDUE, version="1.0", provider="*", resource_types=("*",),
        synthetic=True, title="Secret rotation is enabled but overdue",
        severity=MEDIUM, category=CAT_ENCRYPTION, coverage=COV_CREDENTIALS,
        description="Rotation is configured, but the last rotation is older than its "
                    "interval allows.",
        rationale=(
            "A failing rotation is worse than none: everyone believes the credential is "
            "rotated. It usually means the rotation function or the target system "
            "rejected the change."
        ),
        remediation=(
            "Check the rotation's last error and run it once by hand:\n"
            "  AWS: aws secretsmanager describe-secret --secret-id <arn>; then "
            "aws secretsmanager rotate-secret --secret-id <arn>\n"
            "  OCI: check the secret's rotation status in Vault and the target system "
            "details."
        ),
    ),
    SecurityRule(
        rule_id=_cx.CREDENTIAL_STORE_NOT_READ, version="1.0", provider="*",
        resource_types=("*",), synthetic=True,
        title="Certificate or secret store could not be read",
        severity=MEDIUM, category=CAT_ENCRYPTION, coverage=COV_CREDENTIALS,
        confidence=CONF_UNKNOWN,
        description="One or more certificate, secret or key stores refused or failed the "
                    "listing, so their contents were not checked.",
        rationale=(
            "Reported as an explicit gap rather than an empty result: 'no certificate "
            "expiring' over a vault that refused us is not a statement this product can "
            "make. Objects read on an earlier successful attempt are kept, and their "
            "findings stay open, until the store is readable again."
        ),
        remediation=(
            "Grant the missing permission named in the finding — Key Vault Reader on the "
            "vault (or 'List' in its access policy), acm:ListCertificates / "
            "secretsmanager:ListSecrets on AWS, 'inspect certificate-family / "
            "secret-family' on OCI — or allow this network through the vault firewall."
        ),
    ),
]

_SYNTHETIC.extend(_CREDENTIAL_RULES)

RULES: Dict[str, SecurityRule] = {r.rule_id: r for r in (_R + _SYNTHETIC)}

# Dispatch table: (provider, resource_type) -> rules. Built once at import.
#
# Membership is decided by `evaluate is not None`, NOT by which list above a
# rule was declared in. Those two can disagree — three AWS IAM rules were
# originally declared in the synthetic list and later given evaluators — and
# when they disagreed, the rules had evaluators, passed the self-check, and
# were never dispatched to anything. A rule that silently never runs is the
# exact failure this registry exists to prevent, so the flag that matters is
# the one that determines behaviour.
_BY_TARGET: Dict[Tuple[str, str], List[SecurityRule]] = {}
_UNIVERSAL: List[SecurityRule] = []

for _r_ in RULES.values():
    if _r_.evaluate is None:
        continue
    if _r_.provider == "*" and _r_.resource_types == ("*",):
        _UNIVERSAL.append(_r_)
        continue
    _provs = [AWS, AZURE, OCI] if _r_.provider == "*" else [_r_.provider]
    for _p_ in _provs:
        for _t_ in _r_.resource_types:
            _BY_TARGET.setdefault((_p_, _t_), []).append(_r_)


def rules_for(provider: str, resource_type: str) -> List[SecurityRule]:
    """Every rule that applies to this resource — and nothing else.

    The single most important line in this module: a lookup keyed by BOTH
    provider and type, so `("AWS", "APIGateway")` and `("OCI", "APIGateway")`
    are different keys with different rules.
    """
    return _BY_TARGET.get((provider, resource_type), []) + _UNIVERSAL


def by_id(rule_id: str) -> Optional[SecurityRule]:
    return RULES.get(rule_id)


def evaluable_rules() -> List[SecurityRule]:
    """Rules with an evaluator — the ones the engine runs per resource."""
    return [r for r in RULES.values() if r.evaluate is not None]


def synthetic_rules() -> List[SecurityRule]:
    """Rules the analysers construct findings for, with no per-resource
    evaluator (exposure verdicts, Azure RBAC grants)."""
    return [r for r in RULES.values() if r.evaluate is None]


# ── Import-time self-check ───────────────────────────────────────────────────
# A registry that silently contains a broken rule is worse than one that
# refuses to load: the broken rule's control shows PASS forever, because
# nothing ever evaluated it and nothing ever said so.

# What each provider's scanner actually produces.
#
# AWS and OCI are closed sets: their scanners write `"resource_type": "..."`
# as literals, so the list can be verified by reading them, and a rule aimed
# at a type outside it can never fire. That makes a hard failure the right
# response — a rule that silently never runs leaves its compliance control
# reporting PASS forever.
#
# **Azure is deliberately open-ended.** Its scanner falls back to a generic ARM
# resource walk that derives the type name from the ARM type itself, so the
# live tenancy contains 57 distinct Azure types including AppService,
# VirtualNetwork, NATGateway, PrivateEndpoint and RecoveryVault — none of which
# appear as literals anywhere in the scanner source. Enumerating them here
# would be a snapshot that goes stale the first time someone deploys a service
# nobody anticipated, and would then reject a perfectly good new rule. So the
# unknown-type check below covers AWS and OCI only, and Azure's set is recorded
# as documentation of what the *dedicated* scanner paths emit.
KNOWN_TYPES: Dict[str, frozenset] = {
    AWS: frozenset({
        "APIGateway", "BedrockAgent", "BedrockKnowledgeBase", "BedrockModel",
        "DynamoDBTable", "EBSVolume", "EC2Instance", "EKSCluster",
        "ElastiCacheMemcached", "ElastiCacheRedis", "IAMRole", "LambdaFunction",
        "LoadBalancer", "RDSInstance", "RedshiftCluster", "S3Bucket",
        "SecurityGroup", "Subnet", "VPC",
    }),
    OCI: frozenset({
        "APIGateway", "AnalyticsInstance", "AutonomousDatabase", "BlockVolume",
        "BootVolume", "ComputeInstance", "DbSystem", "DhcpOptions", "DrgAttachment",
        "FileSystem", "Function", "IAMGroup", "IAMPolicy", "LoadBalancer",
        "MySQLDbSystem", "NetworkLoadBalancer", "NetworkSecurityGroup", "NoSQLTable",
        "OKECluster",
        "ObjectStorageBucket", "RouteTable", "SecurityList", "Subnet", "VCN",
        "VirtualCircuit", "WebAppFirewall", "Compartment",
    }),
}

# Documentation only — see the note above. Not used by the self-check.
AZURE_DEDICATED_TYPES: frozenset = frozenset({
    "AKSCluster", "CosmosDB", "ManagedDisk", "MySQLServer", "NetworkInterface",
    "NetworkSecurityGroup", "PostgreSQLServer", "PublicIP", "RedisCache",
    "SQLDatabase", "SQLServer", "StorageAccount", "Subnet", "VirtualMachine",
})


def _selfcheck() -> None:
    problems: List[str] = []

    for rid, rule in RULES.items():
        if rule.rule_id != rid:
            problems.append(f"{rid}: rule_id does not match its registry key")
        if rule.severity not in SEVERITIES:
            problems.append(f"{rid}: unknown severity {rule.severity!r}")
        if rule.category not in CATEGORIES:
            problems.append(f"{rid}: category {rule.category!r} is not in the closed set")
        if rule.provider != "*" and rule.provider not in (AWS, AZURE, OCI):
            problems.append(f"{rid}: unknown provider {rule.provider!r}")
        if not rule.synthetic and rule.evaluate is None:
            problems.append(f"{rid}: non-synthetic rule has no evaluator")
        if rule.synthetic and rule.evaluate is not None:
            problems.append(f"{rid}: synthetic rule must not have an evaluator")
        for field_name in ("title", "description", "rationale", "remediation"):
            if not (getattr(rule, field_name) or "").strip():
                problems.append(f"{rid}: {field_name} is empty")
        # "Improve security" is not a remediation. Enforce a floor so the next
        # rule added cannot ship without a real one.
        if len(rule.remediation) < 40:
            problems.append(f"{rid}: remediation is too short to be actionable")
        # A rule aimed at a type its own provider never produces can never run.
        if rule.provider in KNOWN_TYPES and rule.resource_types != ("*",):
            unknown = [t for t in rule.resource_types if t not in KNOWN_TYPES[rule.provider]]
            if unknown:
                problems.append(
                    f"{rid}: declares {unknown} which the {rule.provider} scanner "
                    f"never produces"
                )

    # Every control's rule references must exist, or the control silently
    # reports NOT_EVALUATED and looks like a coverage gap rather than a typo.
    from app.security import controls as _controls
    for cid in _controls.all_assessing_rule_ids():
        if cid not in RULES:
            problems.append(f"controls.py cites unknown rule_id {cid!r}")

    if problems:
        raise RuntimeError(
            "Security rule registry is inconsistent:\n  - " + "\n  - ".join(problems)
        )


_selfcheck()
