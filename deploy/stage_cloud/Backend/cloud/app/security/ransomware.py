"""Ransomware resilience posture — a configuration review, and it says so.

**This is not malware detection and must never be presented as it.** Nothing
here inspects a file, a process or a signature. What it does is ask, of every
data store in the account, whether the controls that decide *how bad a
ransomware incident gets* are configured: can an attacker overwrite the data,
can the previous version be recovered, is there a copy the attacker cannot
reach. Those are answerable from configuration, and they are what an operator
can actually change before an incident.

Calling that "ransomware protection" would be the lie. The category name, the
API field and the UI heading all say *resilience posture*, and `assessed_by`
below names the exact rule that decided each control so a reader can follow it
back to the provider field it came from.

**Four control states, and only one of them is good news.**

    FAILING       a rule assessed this control and it does not hold.
    HOLDING       a rule assessed this control and it does hold.
    UNDETERMINED  a rule ran and could not tell — the field was not collected
                  for this resource.
    NOT_ASSESSED  no rule covers this control at all, because nothing collects
                  the data it would need.

The last two are the reason this module exists in its current form. Object Lock,
MFA Delete and backup policy are the controls that most decide whether a
ransomware incident is a bad afternoon or a company-ending event, and **none of
them is collected by any scanner here**. A posture view that silently omitted
them would score an account as resilient on the strength of versioning alone.
So they are declared, listed, and reported as NOT_ASSESSED with the reason — a
visible hole rather than an invisible one.

For the same reason there is no resilience *score*. Averaging two assessed
controls and three unassessable ones produces a number whose main property is
that it looks like knowledge. The counts are reported instead.
"""
from __future__ import annotations

from typing import Any, Dict, List, NamedTuple, Optional, Sequence, Tuple

from app.security import registry as reg
from app.security.model import (
    AWS, AZURE, OCI, UNKNOWN, VULNERABLE, severity_rank,
)

# ── Control states ───────────────────────────────────────────────────────────
FAILING = "FAILING"
HOLDING = "HOLDING"
UNDETERMINED = "UNDETERMINED"
NOT_ASSESSED = "NOT_ASSESSED"

STATE_LABEL: Dict[str, str] = {
    FAILING: "Not configured",
    HOLDING: "Configured",
    UNDETERMINED: "Could not be determined",
    NOT_ASSESSED: "Not assessed — data not collected",
}

# Only FAILING is actionable today; only HOLDING is good news. The other two
# are gaps in what this product can see, and are counted separately so they can
# never be mistaken for either.
STATE_ORDER: Tuple[str, ...] = (FAILING, UNDETERMINED, NOT_ASSESSED, HOLDING)


class Control(NamedTuple):
    """One thing that decides how recoverable a ransomware incident is."""

    control_id: str
    title: str
    why: str
    # Rule ids that assess this control. Empty means nothing does, and
    # `not_assessable_reason` must then say why.
    assessed_by: Tuple[str, ...] = ()
    not_assessable_reason: Optional[str] = None

    def to_dict(self) -> dict:
        return {
            "control_id": self.control_id,
            "title": self.title,
            "why": self.why,
            "assessed_by": list(self.assessed_by),
            "not_assessable_reason": self.not_assessable_reason,
        }


CONTROLS: Tuple[Control, ...] = (
    Control(
        "PUBLIC_WRITE_PREVENTED",
        "Data store is not publicly writable",
        "A bucket the internet can write to does not need an attacker to "
        "obtain credentials first — encrypting its contents is an anonymous "
        "operation. This is the one control whose absence makes every other "
        "one moot.",
        assessed_by=(
            "AWS_S3_PUBLIC_ACCESS_NOT_BLOCKED",
            "OCI_BUCKET_PUBLIC_ACCESS",
            "AZURE_STORAGE_BLOB_PUBLIC_ACCESS",
        ),
    ),
    Control(
        "VERSIONING_ENABLED",
        "Previous object versions are retained",
        "Versioning is what turns 'every object was overwritten' into 'every "
        "object has a previous version'. Without it an in-place encryption pass "
        "is unrecoverable from the store itself.",
        assessed_by=(
            "AWS_S3_VERSIONING_DISABLED",
            "OCI_BUCKET_VERSIONING_DISABLED",
        ),
    ),
    Control(
        "ENCRYPTION_AT_REST",
        "Data is encrypted at rest",
        "Encryption does not prevent ransomware — the attacker encrypts data "
        "that is already encrypted. It is listed because it decides whether the "
        "SECOND half of a modern ransomware incident works: exfiltration "
        "followed by a threat to publish.",
        assessed_by=(
            "AWS_S3_ENCRYPTION_DISABLED",
            "AWS_RDS_ENCRYPTION_DISABLED",
            "OCI_VOLUME_ENCRYPTION_NOT_CUSTOMER_MANAGED",
        ),
    ),
    Control(
        "IMMUTABLE_RETENTION",
        "An immutable retention policy is configured",
        "Object Lock, OCI retention rules and Azure immutable blob policies "
        "make an object undeletable for a fixed period even by an "
        "administrator. It is the only control on this list that survives a "
        "fully compromised control plane.",
        not_assessable_reason=(
            "No scanner collects Object Lock configuration (AWS), retention "
            "rules (OCI) or immutability policies (Azure). This control is "
            "therefore unassessed, not passing — and because it is the one that "
            "holds when credentials are lost, treat its status as unknown "
            "rather than assuming it from the others."
        ),
    ),
    Control(
        "MFA_DELETE",
        "MFA is required to delete a version",
        "MFA Delete stops a stolen credential, on its own, from removing the "
        "version history that versioning created.",
        not_assessable_reason=(
            "MFA Delete state is returned by the S3 versioning API but is not "
            "collected by the scanner, and the equivalent does not exist on "
            "Azure or OCI. Not assessed on any provider."
        ),
    ),
    Control(
        "BACKUP_CONFIGURED",
        "A backup exists outside the primary store",
        "Every control above protects the store from within. A backup in a "
        "separate account or tenancy is what survives the store being lost "
        "entirely, including by an administrator who is no longer you.",
        not_assessable_reason=(
            "Backup policy, vault membership and last-successful-backup time "
            "are not collected for any provider. AZURE_DB_NO_GEO_REDUNDANT_"
            "BACKUP assesses geo-redundancy for one database type only, which "
            "is replication rather than backup, so it is not cited here."
        ),
    ),
    Control(
        "RECOVERY_POINT_VERIFIED",
        "A recovery point has been tested",
        "An untested backup is a hypothesis. This is the control that separates "
        "estates that recovered from estates that discovered their backups were "
        "incomplete during the incident.",
        not_assessable_reason=(
            "Restore testing is an operational record, not a cloud "
            "configuration field. Nothing in a provider API reports it, so it "
            "cannot be assessed from inventory by this or any similar product."
        ),
    ),
)

CONTROLS_BY_ID: Dict[str, Control] = {c.control_id: c for c in CONTROLS}

# Resource types whose loss is a data-loss event. Taken from the topology
# vocabulary rather than restated, so a type added there is covered here.
from app.topology.model import CATEGORY_DATABASE, CATEGORY_STORAGE, NODE_CATEGORY

DATA_STORE_TYPES = frozenset(
    t for t, c in NODE_CATEGORY.items() if c in (CATEGORY_STORAGE, CATEGORY_DATABASE)
)


class ResourcePosture(NamedTuple):
    resource_id: Optional[str]
    resource_key: Optional[str]
    resource_name: Optional[str]
    resource_type: Optional[str]
    region: Optional[str]
    # control_id -> {state, findings[], reason}
    controls: Dict[str, Dict[str, Any]]

    @property
    def failing(self) -> int:
        return sum(1 for c in self.controls.values() if c["state"] == FAILING)

    def to_dict(self) -> dict:
        return {
            "resource_id": self.resource_id,
            "resource_key": self.resource_key,
            "resource_name": self.resource_name,
            "resource_type": self.resource_type,
            "region": self.region,
            "controls": self.controls,
            "failing": self.failing,
        }


def _state_for(
    control: Control,
    provider: str,
    resource_type: str,
    findings_for_resource: Sequence[Any],
) -> Dict[str, Any]:
    """One control's state on one resource, with the findings that decided it."""
    if not control.assessed_by:
        return {
            "state": NOT_ASSESSED,
            "label": STATE_LABEL[NOT_ASSESSED],
            "findings": [],
            "reason": control.not_assessable_reason,
        }

    relevant = [
        f for f in findings_for_resource
        if getattr(f, "rule_id", None) in control.assessed_by
    ]
    confirmed = [f for f in relevant if getattr(f, "verdict", None) == VULNERABLE]
    if confirmed:
        return {
            "state": FAILING,
            "label": STATE_LABEL[FAILING],
            "findings": [_finding_brief(f) for f in confirmed],
            "reason": None,
        }

    undetermined = [f for f in relevant if getattr(f, "verdict", None) == UNKNOWN]
    if undetermined:
        return {
            "state": UNDETERMINED,
            "label": STATE_LABEL[UNDETERMINED],
            "findings": [_finding_brief(f) for f in undetermined],
            "reason": "A rule assessed this control and could not reach a verdict.",
        }

    # No finding either way. That is only good news if a rule for this control
    # actually dispatches to this resource type — otherwise nothing looked, and
    # "no finding" means "no check", which is the opposite of passing.
    #
    # `rules_for` is the same provider-and-type keyed lookup the engine uses, so
    # this cannot conclude that an AWS rule covered an OCI bucket.
    dispatched = {r.rule_id for r in reg.rules_for(provider, resource_type)}
    if dispatched & set(control.assessed_by):
        return {
            "state": HOLDING,
            "label": STATE_LABEL[HOLDING],
            "findings": [],
            "reason": None,
        }
    return {
        "state": NOT_ASSESSED,
        "label": STATE_LABEL[NOT_ASSESSED],
        "findings": [],
        "reason": (
            f"No rule assesses this control for {provider} {resource_type}. "
            "The absence of a finding here is the absence of a check."
        ),
    }


def _finding_brief(f) -> Dict[str, Any]:
    return {
        "finding_key": getattr(f, "fingerprint", None),
        "rule_id": getattr(f, "rule_id", None),
        "title": getattr(f, "title", None),
        "severity": getattr(f, "severity", None),
        "verdict": getattr(f, "verdict", None),
    }


def posture(
    *, provider: str, resources: Sequence[Any], findings: Sequence[Any],
) -> Dict[str, Any]:
    """Resilience posture for every data store in the account.

    Pure. Takes the resources and the findings the engine already produced, so
    this view and the Findings tab cannot disagree about whether a bucket has
    versioning — they are the same row.
    """
    by_resource: Dict[str, List[Any]] = {}
    for f in findings:
        key = getattr(f, "resource_key", None) or str(getattr(f, "resource_id", "") or "")
        if key:
            by_resource.setdefault(key, []).append(f)

    stores = [
        r for r in resources
        if (getattr(r, "resource_type", None) or "") in DATA_STORE_TYPES
    ]

    postures: List[ResourcePosture] = []
    for r in stores:
        rkey = getattr(r, "provider_resource_id", None) or str(getattr(r, "id", "") or "")
        rtype = getattr(r, "resource_type", "") or ""
        mine = by_resource.get(rkey, []) + by_resource.get(str(getattr(r, "id", "")), [])
        postures.append(ResourcePosture(
            resource_id=str(getattr(r, "id", "") or "") or None,
            resource_key=rkey,
            resource_name=getattr(r, "resource_name", None),
            resource_type=rtype,
            region=getattr(r, "region_or_zone", None),
            controls={
                c.control_id: _state_for(c, provider, rtype, mine) for c in CONTROLS
            },
        ))

    # Worst first: most failing controls, then by name so the order is stable.
    postures.sort(key=lambda p: (-p.failing, p.resource_name or ""))

    totals: Dict[str, Dict[str, int]] = {}
    for c in CONTROLS:
        counts = {s: 0 for s in STATE_ORDER}
        for p in postures:
            counts[p.controls[c.control_id]["state"]] += 1
        totals[c.control_id] = counts

    return {
        "provider": provider,
        "is_configuration_review": True,
        "disclaimer": (
            "This is a configuration review of recovery controls, not malware "
            "detection. Nothing here inspects files, processes or signatures. "
            "It reports whether the controls that decide how recoverable a "
            "ransomware incident would be are configured."
        ),
        "controls": [c.to_dict() for c in CONTROLS],
        "control_totals": totals,
        "state_labels": STATE_LABEL,
        "state_order": list(STATE_ORDER),
        "resources": [p.to_dict() for p in postures],
        "data_stores": len(postures),
        "stores_with_a_failing_control": sum(1 for p in postures if p.failing),
        "assessable_controls": sum(1 for c in CONTROLS if c.assessed_by),
        "unassessable_controls": sum(1 for c in CONTROLS if not c.assessed_by),
        "no_score_note": (
            f"{sum(1 for c in CONTROLS if not c.assessed_by)} of {len(CONTROLS)} "
            "controls cannot be assessed from collected data, so no resilience "
            "score is produced. Averaging what is known with what is not would "
            "yield a number whose main property is looking like knowledge."
        ),
    }
