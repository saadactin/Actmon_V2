"""Least-privilege proposals, generated from observed activity.

Produces the §6 artefact: a proposed policy built from what a principal was
actually seen doing, beside the policy it has now, with an explicit diff.

Every proposal this module makes is labelled PROPOSED and NOT APPLIED, and
nothing here touches a provider. Applying is a separate, approved, audited step
(`services/identity_workflow_service.py`), and the separation is the point —
§6 ends with "do not silently modify production IAM".

**Only high-confidence unexercised grants are proposed for removal.** The
input is `usage.correlate`'s `removal_candidates`, which excludes anything
data-plane-blind, anything from a short window, and anything from a window with
too few events. A LOW-confidence unexercised grant is SHOWN in the diff as
"retained — insufficient evidence", so the reviewer can see what was
deliberately not touched and why. A generator that quietly dropped those would
produce a smaller, more impressive diff and break production.

**A proposal is never a complete policy on its own.** It is derived from
observations, and observations cannot show a permission needed by a path that
did not run during the window — a quarterly job, a disaster-recovery runbook,
an error branch. The generated document therefore carries its own caveat block
and the UI renders it, because the person clicking Approve needs to read it.

**Resource scope is narrowed only where the evidence supports it.** If every
observed `s3:GetObject` touched one bucket, proposing that bucket is justified.
If the observations carry no resource identity — and many audit records do not
— the proposal keeps the original resource pattern and says so, rather than
inventing a narrower one that would break the first call it blocks.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple

from app.identity.capability import classify_action
from app.identity.model import (
    AWS, AZURE, OCI, PROPOSED, USAGE_NOT_OBSERVED_HIGH, USAGE_NOT_OBSERVED_LOW,
    USAGE_OBSERVED, USAGE_UNKNOWN, normalize_provider,
)

KEEP = "KEEP"
REMOVE = "REMOVE"
RETAIN_INSUFFICIENT = "RETAIN_INSUFFICIENT_EVIDENCE"
NARROW = "NARROW"

ACTION_LABEL = {
    KEEP: "Keep — observed in use",
    REMOVE: "Remove — not observed, high confidence",
    RETAIN_INSUFFICIENT: "Retain — not observed, but evidence is insufficient",
    NARROW: "Narrow — observed against fewer resources than granted",
}


@dataclass
class DiffEntry:
    """One line of the §6 diff."""

    verdict: str
    pattern: str
    capability: Optional[str] = None
    observed_actions: List[str] = field(default_factory=list)
    event_count: int = 0
    reason: str = ""
    proposed_pattern: Optional[str] = None
    proposed_resource: Optional[str] = None
    current_resource: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "verdict": self.verdict,
            "verdict_label": ACTION_LABEL.get(self.verdict, self.verdict),
            "pattern": self.pattern,
            "capability": self.capability,
            "observed_actions": self.observed_actions,
            "event_count": self.event_count,
            "reason": self.reason,
            "proposed_pattern": self.proposed_pattern,
            "proposed_resource": self.proposed_resource,
            "current_resource": self.current_resource,
        }


def build_diff(
    provider: str,
    *,
    usage_summary: Dict[str, Any],
    resource_patterns_by_action: Optional[Dict[str, str]] = None,
    observed_resources_by_action: Optional[Dict[str, Sequence[str]]] = None,
) -> List[DiffEntry]:
    """Turn a usage summary into a reviewable diff.

    Nothing is dropped: every granted pattern appears exactly once, with a
    verdict and a reason. A reviewer scrolling the diff sees the whole current
    policy, not just the parts being changed.
    """
    prov = normalize_provider(provider) or provider
    current_resources = resource_patterns_by_action or {}
    observed_resources = observed_resources_by_action or {}
    removal = set(usage_summary.get("removal_candidates") or [])

    entries: List[DiffEntry] = []
    for row in usage_summary.get("patterns") or []:
        pattern = row.get("pattern")
        state = row.get("usage_state")
        current_resource = current_resources.get(pattern, "*")
        observed = list(row.get("observed_actions") or [])

        if state == USAGE_OBSERVED:
            narrowed = _narrow_resource(observed, observed_resources, current_resource)
            if narrowed and narrowed != current_resource:
                entries.append(DiffEntry(
                    verdict=NARROW, pattern=pattern, capability=row.get("capability"),
                    observed_actions=observed, event_count=row.get("event_count", 0),
                    current_resource=current_resource, proposed_resource=narrowed,
                    reason=(f"Every observed call touched {narrowed}. The grant "
                            f"currently covers {current_resource}."),
                ))
            else:
                entries.append(DiffEntry(
                    verdict=KEEP, pattern=pattern, capability=row.get("capability"),
                    observed_actions=observed, event_count=row.get("event_count", 0),
                    current_resource=current_resource,
                    reason=(f"{row.get('event_count', 0)} event(s) in the window used "
                            f"{len(observed)} action(s) under this grant."),
                ))
            continue

        if pattern in removal and state == USAGE_NOT_OBSERVED_HIGH:
            entries.append(DiffEntry(
                verdict=REMOVE, pattern=pattern, capability=row.get("capability"),
                current_resource=current_resource,
                reason=row.get("confidence_reason") or
                       "No action under this grant was observed in the window.",
            ))
            continue

        entries.append(DiffEntry(
            verdict=RETAIN_INSUFFICIENT, pattern=pattern,
            capability=row.get("capability"), current_resource=current_resource,
            reason=row.get("confidence_reason") or
                   ("No usable audit evidence covers this grant, so it is kept."),
        ))
    return entries


def _narrow_resource(
    observed_actions: Sequence[str],
    observed_resources: Dict[str, Sequence[str]],
    current: str,
) -> Optional[str]:
    """A narrower resource pattern, only when the evidence actually supports one."""
    if current and current != "*":
        return None
    seen: Set[str] = set()
    for action in observed_actions:
        for resource in observed_resources.get(action, ()):
            if resource:
                seen.add(resource)
    if not seen or len(seen) > 20:
        return None
    if len(seen) == 1:
        return next(iter(seen))
    return None


def generate_policy(
    provider: str,
    *,
    diff: Sequence[DiffEntry],
    policy_name: str = "proposed-least-privilege",
) -> Dict[str, Any]:
    """The proposed policy document, in the provider's own shape.

    Returned alongside a `caveats` block that the UI must render with it. The
    document is inert — it is a proposal, and nothing in this platform applies
    it without an approval.
    """
    prov = normalize_provider(provider) or provider
    kept = [e for e in diff if e.verdict in (KEEP, NARROW, RETAIN_INSUFFICIENT)]
    removed = [e for e in diff if e.verdict == REMOVE]

    if prov == AWS:
        statements = []
        for entry in kept:
            resource = entry.proposed_resource or entry.current_resource or "*"
            statements.append({
                "Sid": f"Allow{_sid(entry.pattern)}",
                "Effect": "Allow",
                "Action": entry.pattern,
                "Resource": resource,
            })
        document: Dict[str, Any] = {"Version": "2012-10-17", "Statement": statements}
    elif prov == AZURE:
        document = {
            "properties": {
                "roleName": policy_name,
                "description": "Proposed least-privilege role, generated from observed "
                               "activity. NOT APPLIED.",
                "permissions": [{
                    "actions": [e.pattern for e in kept],
                    "notActions": [],
                    "dataActions": [],
                    "notDataActions": [],
                }],
            }
        }
    elif prov == OCI:
        document = {
            "name": policy_name,
            "statements": [
                f"Allow group <GROUP> to {e.pattern.replace(':', ' ')} in "
                f"{e.current_resource or 'compartment <COMPARTMENT>'}"
                for e in kept
            ],
        }
    else:
        document = {}

    return {
        "status": PROPOSED,
        "applied": False,
        "provider": prov,
        "policy_name": policy_name,
        "document": document,
        "retained_count": len(kept),
        "removed_count": len(removed),
        "caveats": _caveats(prov, diff),
    }


def _sid(pattern: str) -> str:
    return "".join(ch for ch in pattern.title() if ch.isalnum())[:60] or "Grant"


def _caveats(provider: str, diff: Sequence[DiffEntry]) -> List[str]:
    """What the reviewer must know before approving. Never omitted."""
    out = [
        "This policy is PROPOSED and has NOT been applied. Nothing in this platform "
        "changes a provider policy without an explicit approval.",
        "It is derived from observed activity in a bounded window. A permission used "
        "only by a quarterly job, a disaster-recovery runbook or an error path may not "
        "have been exercised during that window and would be removed by this proposal.",
    ]
    insufficient = [e for e in diff if e.verdict == RETAIN_INSUFFICIENT]
    if insufficient:
        out.append(
            f"{len(insufficient)} grant(s) were NOT proposed for removal despite no "
            "observed use, because the evidence was insufficient — data-plane actions, "
            "a short window, or too few events. They are retained deliberately."
        )
    narrowed = [e for e in diff if e.verdict == NARROW]
    if narrowed:
        out.append(
            f"{len(narrowed)} grant(s) are proposed for a narrower resource scope. "
            "Confirm the narrowed scope covers every environment this identity serves, "
            "not only the one active during the window."
        )
    out.append(
        "Apply this in a non-production account first, or attach it as a permissions "
        "boundary before replacing the policy, so a missing permission surfaces as a "
        "denial you can observe rather than an outage."
    )
    return out


def summarize(diff: Sequence[DiffEntry]) -> Dict[str, Any]:
    """Counts for the proposal header."""
    counts: Dict[str, int] = {}
    for entry in diff:
        counts[entry.verdict] = counts.get(entry.verdict, 0) + 1
    return {
        "total": len(diff),
        "keep": counts.get(KEEP, 0),
        "narrow": counts.get(NARROW, 0),
        "remove": counts.get(REMOVE, 0),
        "retain_insufficient": counts.get(RETAIN_INSUFFICIENT, 0),
        "reduction_percent": (
            round(100.0 * counts.get(REMOVE, 0) / len(diff), 1) if diff else None
        ),
    }


def build_proposal(
    provider: str,
    *,
    identity_name: str,
    usage_summary: Dict[str, Any],
    current_document: Optional[Dict[str, Any]] = None,
    resource_patterns_by_action: Optional[Dict[str, str]] = None,
    observed_resources_by_action: Optional[Dict[str, Sequence[str]]] = None,
) -> Dict[str, Any]:
    """The complete §6 artefact: diff, proposed document, evidence, caveats."""
    diff = build_diff(
        provider, usage_summary=usage_summary,
        resource_patterns_by_action=resource_patterns_by_action,
        observed_resources_by_action=observed_resources_by_action,
    )
    policy = generate_policy(provider, diff=diff,
                             policy_name=f"{identity_name}-least-privilege")
    return {
        "status": PROPOSED,
        "applied": False,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "identity_name": identity_name,
        "provider": normalize_provider(provider) or provider,
        "summary": summarize(diff),
        "diff": [e.to_dict() for e in diff],
        "current_document": current_document,
        "proposed_document": policy["document"],
        "caveats": policy["caveats"],
        # The evidence block is mandatory: §29 requires every recommendation to
        # carry its observation window, and this is where it travels.
        "evidence": {
            "window": usage_summary.get("window"),
            "granted_pattern_count": usage_summary.get("granted_pattern_count"),
            "observed_action_count": usage_summary.get("observed_action_count"),
            "events_in_window": (usage_summary.get("window") or {}).get("events_in_window"),
            "unmappable_events": usage_summary.get("unmappable_events"),
            "removal_candidates": usage_summary.get("removal_candidates"),
        },
    }
