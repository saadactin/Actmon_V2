"""Contextual risk: what a finding's declared severity means for *this* resource.

A rule's `severity` is a statement about a condition in the abstract — "an
unencrypted database is HIGH". It is deliberately context-free, because the
rule cannot see the estate. That is the right design for a rule and the wrong
answer for an operator, who has two unencrypted databases and one afternoon.

This module answers the second question without corrupting the first.

**Severity is never mutated.** `base_severity` is what the rule said and keeps
saying. `contextual_band` is a separate value computed here, carrying the
arithmetic that produced it. Both travel together to the UI. The alternative —
rewriting severity in place — was rejected because it destroys the only stable
thing a finding has: two scans, same condition, same severity. An operator who
sees HIGH become CRITICAL with no record of why has been given a worse product,
not a better one.

**A factor requires confirmed evidence, in both directions.** This is the rule
that does the most work here. Amplifying on missing data invents risk; damping
on missing data invents safety, which is worse, and is exactly the failure the
exposure analyser was built to avoid (`UNKNOWN` is not `PROTECTED`). So:

* `EXPOSED` with a resolved path  -> amplifier, carrying the path as evidence.
* `PROTECTED` with a non-empty `evaluated_controls` -> dampener.
* `PROTECTED` with nothing evaluated, or `UNKNOWN`, or no exposure record at
  all -> a NEUTRAL factor worth zero that states what was missing.

A NEUTRAL factor is not noise. It is the difference between "we checked and
this database is unreachable" and "we never resolved this database's NICs", and
the UI prints both rather than letting the second masquerade as the first.

**Dampening is clamped.** Confirmed-private cannot push a finding more than one
band below the rule's own severity. A CRITICAL on a private subnet is still at
least HIGH, because "nothing reaches it today" is a statement about today's
network, not about the finding. When the clamp binds, it says so in
`clamp_applied`, so the floor is visible rather than silently swallowing points.

**The arithmetic is the product.** `base_points`, every factor's signed `delta`,
`adjusted_points` and the band thresholds all ship to the caller. The brief
asks that every risk adjustment be explainable; the honest reading of that is
that the UI should be able to re-derive the number itself, so nothing here is
computed anywhere the caller cannot see.
"""
from __future__ import annotations

from typing import Any, Dict, List, NamedTuple, Optional, Sequence, Tuple

from app.security import ports as portcat
from app.security.model import (
    CRITICAL, EXPOSED, HIGH, INFO, LOW, MEDIUM, PROTECTED, SEVERITIES,
)

# ── Points ───────────────────────────────────────────────────────────────────
# Each base sits just above its own band floor, so a finding with no confirmed
# context at all reproduces its declared severity exactly. That property is
# tested (`verify_contextual_risk.py`) and is what makes "contextual risk" safe
# to show beside severity rather than instead of it: with no evidence, the two
# agree by construction.
BASE_POINTS: Dict[str, int] = {
    CRITICAL: 90,
    HIGH: 65,
    MEDIUM: 40,
    LOW: 18,
    INFO: 5,
}

# (floor, band), highest first.
_BANDS: Tuple[Tuple[int, str], ...] = (
    (85, CRITICAL),
    (60, HIGH),
    (35, MEDIUM),
    (12, LOW),
    (0, INFO),
)

POINTS_MIN = 0
POINTS_MAX = 120


def band_for(points: float) -> str:
    for floor, band in _BANDS:
        if points >= floor:
            return band
    return INFO


def band_thresholds() -> List[Dict[str, Any]]:
    """The thresholds, for the UI to draw the scale it is placing a value on."""
    return [{"band": band, "min_points": floor} for floor, band in _BANDS]


# ── Factor direction ─────────────────────────────────────────────────────────
AMPLIFIER = "AMPLIFIER"
DAMPENER = "DAMPENER"
NEUTRAL = "NEUTRAL"   # recorded, worth zero: states what could not be confirmed


class RiskFactor(NamedTuple):
    """One named, evidenced reason the contextual risk differs from the base.

    `delta` is signed points. A NEUTRAL factor's delta is always 0 — it exists
    so the UI can show "internet reachability: could not be determined" in the
    same list as the factors that did move the number, rather than leaving the
    operator to guess whether absence meant safe or unchecked.
    """

    factor_id: str
    label: str
    direction: str
    delta: int
    explanation: str
    evidence: Dict[str, Any]
    source: str          # which analyser produced the evidence

    def to_dict(self) -> dict:
        return {
            "factor_id": self.factor_id,
            "label": self.label,
            "direction": self.direction,
            "delta": self.delta,
            "explanation": self.explanation,
            "evidence": self.evidence,
            "source": self.source,
        }


class RiskContext(NamedTuple):
    """The full, re-derivable calculation behind one finding's contextual band."""

    base_severity: str
    base_points: int
    factors: List[RiskFactor]
    adjusted_points: int
    contextual_band: str
    clamp_applied: Optional[str]
    # False when nothing could be confirmed either way; the band then equals
    # the base severity and the UI should say so rather than implying analysis.
    determined: bool

    @property
    def moved(self) -> bool:
        return self.contextual_band != self.base_severity

    def to_dict(self) -> dict:
        return {
            "base_severity": self.base_severity,
            "base_points": self.base_points,
            "factors": [f.to_dict() for f in self.factors],
            "amplifiers": [f.to_dict() for f in self.factors if f.direction == AMPLIFIER],
            "dampeners": [f.to_dict() for f in self.factors if f.direction == DAMPENER],
            "undetermined": [f.to_dict() for f in self.factors if f.direction == NEUTRAL],
            "adjusted_points": self.adjusted_points,
            "contextual_band": self.contextual_band,
            "clamp_applied": self.clamp_applied,
            "determined": self.determined,
            "moved": self.moved,
            "thresholds": band_thresholds(),
        }


# ── Factor catalogue ─────────────────────────────────────────────────────────
# Weights are declared here, once, so they are reviewable as a set rather than
# scattered through the functions that apply them. They are deliberately coarse:
# a model whose weights look precise invites the reader to believe a precision
# the inputs do not have.
F_INTERNET_REACHABLE = "INTERNET_REACHABLE"
F_NOT_REACHABLE = "NOT_INTERNET_REACHABLE"
F_REACHABILITY_UNKNOWN = "REACHABILITY_UNDETERMINED"
F_MANAGEMENT_PORT = "MANAGEMENT_PORT_WORLD_OPEN"
F_DATA_PORT = "DATA_PORT_WORLD_OPEN"
F_ALL_PORTS = "ALL_PORTS_WORLD_OPEN"
F_PUBLIC_ADDRESS = "PUBLIC_ADDRESS_PRESENT"
F_PRIVILEGED_IDENTITY = "PRIVILEGED_IDENTITY_ATTACHED"
F_IDENTITY_UNKNOWN = "IDENTITY_NOT_COLLECTED"
F_PRODUCTION = "PRODUCTION_ENVIRONMENT"
F_NON_PRODUCTION = "NON_PRODUCTION_ENVIRONMENT"
F_ENVIRONMENT_UNKNOWN = "ENVIRONMENT_UNTAGGED"
F_ON_ATTACK_PATH = "ON_CONFIRMED_ATTACK_PATH"
F_BLAST_RADIUS = "LARGE_BLAST_RADIUS"

WEIGHTS: Dict[str, int] = {
    F_INTERNET_REACHABLE: 25,
    F_NOT_REACHABLE: -20,
    F_MANAGEMENT_PORT: 20,
    F_DATA_PORT: 18,
    F_ALL_PORTS: 25,
    F_PUBLIC_ADDRESS: 5,
    F_PRIVILEGED_IDENTITY: 15,
    F_PRODUCTION: 10,
    F_NON_PRODUCTION: -8,
    F_ON_ATTACK_PATH: 20,
    F_BLAST_RADIUS: 8,
}

# A finding produced by the exposure analyser already *is* the statement
# "this is reachable from the internet". Adding a reachability amplifier on top
# counts the same evidence twice and was the first thing to go wrong when this
# model was prototyped: public-RDP findings landed at 135 points, pinning the
# whole band scale to its ceiling and making every other CRITICAL look equal.
_EXPOSURE_INTRINSIC_PREFIXES = ("EXPOSURE_",)

# Resources where a large blast radius is a property of the resource's job
# rather than a risk signal. A VCN is connected to everything by definition;
# counting that as an amplifier makes every network finding CRITICAL.
_BLAST_RADIUS_EXEMPT_TYPES = frozenset({
    "VCN", "VPC", "VirtualNetwork", "Subnet", "RouteTable", "InternetGateway",
    "ResourceGroup", "Compartment", "AvailabilityDomain",
})

_BLAST_RADIUS_THRESHOLD = 12

# Tag values that *confirm* an environment. Anything else is untagged as far as
# this model is concerned — guessing "prd-db-01 is production" from a name is
# exactly the kind of inference the data-integrity rules forbid.
_PROD_TOKENS = frozenset({"prod", "production", "prd", "live"})
_NONPROD_TOKENS = frozenset({
    "dev", "development", "test", "testing", "qa", "uat", "stage", "staging",
    "sandbox", "demo", "lab",
})

_ENV_TAG_KEYS = ("environment", "env", "stage", "tier", "lifecycle")


def environment_of(tags: Optional[Dict[str, Any]]) -> Tuple[Optional[str], Optional[str]]:
    """(classification, evidence_tag) from tags alone, or (None, None).

    Returns the tag that decided it so the UI can cite it. Case-insensitive on
    both key and value; a tag whose value is not a recognised token is treated
    as absent rather than as a third environment, because `Environment=Core`
    tells this model nothing it can act on.
    """
    if not isinstance(tags, dict):
        return None, None
    lowered = {str(k).strip().lower(): v for k, v in tags.items()}
    for key in _ENV_TAG_KEYS:
        if key not in lowered:
            continue
        value = str(lowered[key] or "").strip().lower()
        if value in _PROD_TOKENS:
            return "PRODUCTION", f"{key}={lowered[key]}"
        if value in _NONPROD_TOKENS:
            return "NON_PRODUCTION", f"{key}={lowered[key]}"
    return None, None


# ── Inputs ───────────────────────────────────────────────────────────────────


class ResourceContext(NamedTuple):
    """Everything the model may consider about one resource.

    Every field is Optional and `None` means "not collected", never a default.
    Callers build this from real analyser output, so a `False` here can never
    be the accidental product of a `.get(key, False)`.
    """

    resource_key: Optional[str] = None
    resource_type: Optional[str] = None
    tags: Optional[Dict[str, Any]] = None
    exposure: Optional[Any] = None              # security.exposure.Exposure
    privileged_identities: Optional[Sequence[Any]] = None  # identity.IdentityRisk
    identity_collected: bool = True
    attack_path_ids: Optional[Sequence[str]] = None
    blast_radius: Optional[int] = None


def _exposure_factors(exposure, *, intrinsic: bool) -> List[RiskFactor]:
    """Reachability and open-port factors, or the neutral record of their absence."""
    if exposure is None:
        return [RiskFactor(
            factor_id=F_REACHABILITY_UNKNOWN,
            label="Internet reachability not determined",
            direction=NEUTRAL, delta=0,
            explanation=(
                "No exposure record was produced for this resource, so the model "
                "cannot say whether the internet can reach it. This is not the "
                "same as it being private."
            ),
            evidence={"reason": "no_exposure_record"},
            source="exposure analyser",
        )]

    verdict = getattr(exposure, "verdict", None)
    factors: List[RiskFactor] = []

    if verdict == EXPOSED:
        if not intrinsic:
            path = [h.to_dict() for h in (getattr(exposure, "path", None) or [])]
            factors.append(RiskFactor(
                factor_id=F_INTERNET_REACHABLE,
                label="Reachable from the internet",
                direction=AMPLIFIER, delta=WEIGHTS[F_INTERNET_REACHABLE],
                explanation=(
                    "The exposure analyser resolved a complete path from the public "
                    "internet to this resource. An attacker does not need a foothold "
                    "elsewhere in the estate to begin."
                ),
                evidence={
                    "verdict": verdict,
                    "public_addresses": list(getattr(exposure, "public_addresses", []) or []),
                    "path": path,
                    "evaluated_controls": list(getattr(exposure, "evaluated_controls", []) or []),
                },
                source="exposure analyser",
            ))
        factors.extend(_open_port_factors(exposure))

    elif verdict == PROTECTED:
        controls = list(getattr(exposure, "evaluated_controls", []) or [])
        if controls:
            factors.append(RiskFactor(
                factor_id=F_NOT_REACHABLE,
                label="Not reachable from the internet",
                direction=DAMPENER, delta=WEIGHTS[F_NOT_REACHABLE],
                explanation=(
                    "Every inbound path the analyser could resolve was checked and "
                    "closed. Exploiting this condition requires an existing foothold "
                    "inside the account."
                ),
                evidence={"verdict": verdict, "evaluated_controls": controls},
                source="exposure analyser",
            ))
        else:
            # PROTECTED with nothing consulted is the signature of a resolution
            # failure, not of a closed network. Damping on it would invent safety.
            factors.append(RiskFactor(
                factor_id=F_REACHABILITY_UNKNOWN,
                label="Internet reachability not determined",
                direction=NEUTRAL, delta=0,
                explanation=(
                    "The resource was reported as not reachable, but no rule set was "
                    "actually consulted to reach that conclusion, so it is not "
                    "treated as evidence of a closed network."
                ),
                evidence={"verdict": verdict, "evaluated_controls": []},
                source="exposure analyser",
            ))

    else:  # UNKNOWN / NOT_APPLICABLE / anything unrecognised
        factors.append(RiskFactor(
            factor_id=F_REACHABILITY_UNKNOWN,
            label="Internet reachability not determined",
            direction=NEUTRAL, delta=0,
            explanation=(
                getattr(exposure, "unknown_reason", None)
                or "The analyser could not resolve this resource's inbound paths."
            ),
            evidence={
                "verdict": verdict,
                "unknown_reason": getattr(exposure, "unknown_reason", None),
            },
            source="exposure analyser",
        ))

    addrs = list(getattr(exposure, "public_addresses", []) or [])
    if addrs and verdict != EXPOSED:
        factors.append(RiskFactor(
            factor_id=F_PUBLIC_ADDRESS,
            label="Holds a public address",
            direction=AMPLIFIER, delta=WEIGHTS[F_PUBLIC_ADDRESS],
            explanation=(
                "The resource has a routable public address. On its own this is "
                "attack surface rather than confirmed reachability — a firewall may "
                "still close every port — so it counts for little."
            ),
            evidence={"public_addresses": addrs},
            source="exposure analyser",
        ))

    return factors


def _open_port_factors(exposure) -> List[RiskFactor]:
    """At most one factor per port class, carrying the ports that justified it."""
    open_ports = list(getattr(exposure, "open_ports", []) or [])
    if not open_ports:
        return []

    out: List[RiskFactor] = []
    whole_range = [p for p in open_ports if p.port is None and not p.port_range]
    if whole_range:
        out.append(RiskFactor(
            factor_id=F_ALL_PORTS,
            label="Every port open to the internet",
            direction=AMPLIFIER, delta=WEIGHTS[F_ALL_PORTS],
            explanation=(
                "A rule exposes the whole port range to the internet, so every "
                "service this host runs — now and in future — is reachable."
            ),
            evidence={"open_ports": [p.to_dict() for p in whole_range]},
            source="port classifier",
        ))

    mgmt = [p for p in open_ports if p.port in portcat.MANAGEMENT_PORTS]
    if mgmt:
        out.append(RiskFactor(
            factor_id=F_MANAGEMENT_PORT,
            label="Administrative port open to the internet",
            direction=AMPLIFIER, delta=WEIGHTS[F_MANAGEMENT_PORT],
            explanation=(
                "A management port is world-open, so the resource is directly "
                "exposed to credential attacks against an interactive login."
            ),
            evidence={"ports": [p.to_dict() for p in mgmt]},
            source="port classifier",
        ))

    data = [p for p in open_ports if p.port in portcat.DATA_PORTS]
    if data:
        out.append(RiskFactor(
            factor_id=F_DATA_PORT,
            label="Database port open to the internet",
            direction=AMPLIFIER, delta=WEIGHTS[F_DATA_PORT],
            explanation=(
                "A database listener is world-open. Reaching stored data needs no "
                "lateral movement — the port is the path."
            ),
            evidence={"ports": [p.to_dict() for p in data]},
            source="port classifier",
        ))
    return out


_IDENTITY_EVIDENCE_FIELDS = (
    "rule_id", "principal_name", "principal_type", "role_name", "scope",
    "detail", "title", "severity", "resource_name",
)


def _identity_evidence(item: Any) -> Dict[str, Any]:
    """Read one privileged-identity record, whichever shape the caller has.

    Callers pass either an `identity.IdentityRisk` (the analyser's own tuple)
    or a plain dict assembled from stored findings. A `getattr`-only reader
    silently returned None for every field of a dict, which rendered an
    amplifier with an evidence block full of nulls — present in the total,
    unsupported on screen. Reading both shapes keeps the evidence honest
    whichever path produced it.
    """
    if isinstance(item, dict):
        return {k: item.get(k) for k in _IDENTITY_EVIDENCE_FIELDS if k in item}
    return {
        k: getattr(item, k) for k in _IDENTITY_EVIDENCE_FIELDS if hasattr(item, k)
    }


def _identity_factors(ctx: ResourceContext) -> List[RiskFactor]:
    if not ctx.identity_collected:
        return [RiskFactor(
            factor_id=F_IDENTITY_UNKNOWN,
            label="Attached identity privilege not collected",
            direction=NEUTRAL, delta=0,
            explanation=(
                "Role and policy data was not collected for this account, so the "
                "model cannot tell whether this resource carries a privileged "
                "identity. Absence of a privileged role has not been established."
            ),
            evidence={"reason": "identity_not_collected"},
            source="identity analyser",
        )]

    risks = list(ctx.privileged_identities or [])
    if not risks:
        return []
    return [RiskFactor(
        factor_id=F_PRIVILEGED_IDENTITY,
        label="Privileged identity attached",
        direction=AMPLIFIER, delta=WEIGHTS[F_PRIVILEGED_IDENTITY],
        explanation=(
            "An identity attached to this resource holds broad or administrative "
            "permissions, so compromising the resource yields those permissions "
            "rather than only the host."
        ),
        evidence={
            "identities": [_identity_evidence(r) for r in risks[:10]],
            "count": len(risks),
        },
        source="identity analyser",
    )]


def _environment_factor(ctx: ResourceContext) -> List[RiskFactor]:
    classification, evidence_tag = environment_of(ctx.tags)
    if classification == "PRODUCTION":
        return [RiskFactor(
            factor_id=F_PRODUCTION,
            label="Production resource",
            direction=AMPLIFIER, delta=WEIGHTS[F_PRODUCTION],
            explanation="Tagged as production, so impact lands on live service and real data.",
            evidence={"tag": evidence_tag},
            source="resource tags",
        )]
    if classification == "NON_PRODUCTION":
        return [RiskFactor(
            factor_id=F_NON_PRODUCTION,
            label="Non-production resource",
            direction=DAMPENER, delta=WEIGHTS[F_NON_PRODUCTION],
            explanation=(
                "Tagged as a non-production environment. This lowers priority, not "
                "the defect — non-production estates routinely hold copies of "
                "production data and share identities with it."
            ),
            evidence={"tag": evidence_tag},
            source="resource tags",
        )]
    return [RiskFactor(
        factor_id=F_ENVIRONMENT_UNKNOWN,
        label="Environment not tagged",
        direction=NEUTRAL, delta=0,
        explanation=(
            "No recognised environment tag, so the model does not assume either "
            "way. It does not guess from the resource name."
        ),
        evidence={"keys_checked": list(_ENV_TAG_KEYS)},
        source="resource tags",
    )]


def _graph_factors(ctx: ResourceContext) -> List[RiskFactor]:
    out: List[RiskFactor] = []
    paths = list(ctx.attack_path_ids or [])
    if paths:
        out.append(RiskFactor(
            factor_id=F_ON_ATTACK_PATH,
            label="On a confirmed attack path",
            direction=AMPLIFIER, delta=WEIGHTS[F_ON_ATTACK_PATH],
            explanation=(
                "This resource is a step on at least one path the attack-path engine "
                "traced from an internet entry point, so the finding is reachable in "
                "sequence rather than only in isolation."
            ),
            evidence={"attack_path_ids": paths[:20], "count": len(paths)},
            source="attack-path engine",
        ))

    radius = ctx.blast_radius
    rtype = ctx.resource_type or ""
    if (
        radius is not None
        and radius >= _BLAST_RADIUS_THRESHOLD
        and rtype not in _BLAST_RADIUS_EXEMPT_TYPES
    ):
        out.append(RiskFactor(
            factor_id=F_BLAST_RADIUS,
            label="Large blast radius",
            direction=AMPLIFIER, delta=WEIGHTS[F_BLAST_RADIUS],
            explanation=(
                f"{radius} other resources depend on or connect to this one, so its "
                "compromise or failure propagates well beyond itself."
            ),
            evidence={"connected_resources": radius, "threshold": _BLAST_RADIUS_THRESHOLD},
            source="topology graph",
        ))
    return out


# ── The model ────────────────────────────────────────────────────────────────


def assess(
    base_severity: str,
    ctx: ResourceContext,
    *,
    rule_id: Optional[str] = None,
) -> RiskContext:
    """Compute the contextual band for one finding on one resource.

    Pure: same inputs, same output, no I/O. That is what lets the tests assert
    exact point totals instead of asserting "roughly higher".
    """
    severity = (base_severity or "").upper()
    if severity not in BASE_POINTS:
        severity = MEDIUM
    base = BASE_POINTS[severity]

    intrinsic = bool(rule_id) and str(rule_id).startswith(_EXPOSURE_INTRINSIC_PREFIXES)

    factors: List[RiskFactor] = []
    factors.extend(_exposure_factors(ctx.exposure, intrinsic=intrinsic))
    factors.extend(_identity_factors(ctx))
    factors.extend(_environment_factor(ctx))
    factors.extend(_graph_factors(ctx))

    total = base + sum(f.delta for f in factors)
    total = max(POINTS_MIN, min(POINTS_MAX, total))

    # Dampening floor: confirmed-private may lower priority by at most one band.
    clamp: Optional[str] = None
    base_index = SEVERITIES.index(severity)
    floor_index = min(base_index + 1, len(SEVERITIES) - 1)
    floor_band = SEVERITIES[floor_index]
    floor_points = BASE_POINTS[floor_band]
    if total < floor_points:
        clamp = (
            f"Dampeners would have placed this below {floor_band}. A finding is held "
            f"at most one band under its declared severity ({severity}), because a "
            f"closed network today is not a fixed defect."
        )
        total = floor_points

    determined = any(f.direction in (AMPLIFIER, DAMPENER) for f in factors)

    return RiskContext(
        base_severity=severity,
        base_points=base,
        factors=factors,
        adjusted_points=int(total),
        contextual_band=band_for(total),
        clamp_applied=clamp,
        determined=determined,
    )
