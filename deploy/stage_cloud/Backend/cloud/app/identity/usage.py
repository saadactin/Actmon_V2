"""Permission usage: what a principal was granted against what it actually did.

Reads the Event Log this platform already collects (`cloud_events`) and joins
it to the grants the evaluator derived. The output is a utilization picture per
principal, and the whole module is built around one rule from §35:

    Absence of an event is not evidence of absence of use.

So nothing here ever returns "unused". It returns NOT_OBSERVED, in two
confidence levels, always carrying the window it searched and how many events
that window held. A reader who cannot see the window cannot distinguish a
well-evidenced finding from a log that started yesterday, and the UI is given
no way to render the first number without the second.

**Why there is no "1,284 permissions granted" figure.** The obvious headline is
granted-actions versus used-actions, and producing it requires expanding `s3:*`
into every S3 action — which needs a complete provider action catalog this
platform does not hold. Printing a number derived from a partial catalog would
be a fabricated denominator, and every percentage computed from it would
inherit the fabrication. What is counted instead is exact and checkable:

*   how many granted STATEMENTS (action patterns) the principal holds,
*   how many distinct actions were observed,
*   which patterns had no observed action under them at all.

That last list is the right-sizing candidate set, and it is defensible because
every entry is a pattern whose entire coverage went unexercised in a stated
window.

**Provider coverage is unequal and is reported as such.**

*   **AWS** — CloudTrail management events map cleanly: `eventSource` +
    `eventName` is `s3:GetObject`. Data events (object-level S3, DynamoDB item
    calls, Lambda invokes) are off by default, so those actions carry
    LOW confidence by construction via `DATA_PLANE_BLIND`.
*   **Azure** — Activity Log `operationName` IS the RBAC operation string, so
    control-plane correlation is exact. Data-plane operations do not appear in
    the Activity Log at all; they need per-resource diagnostic settings, so
    DataActions are UNKNOWN unless those were configured.
*   **OCI** — the audit event carries a cloud-event type
    (`com.oraclecloud.virtualnetwork.createvcn`), NOT a policy verb and
    resource-family. Oracle publishes no complete mapping from one to the
    other, so this module maps the service segment to a resource family where
    it can and returns UNKNOWN where it cannot. It never guesses a verb: doing
    so would let a `read` event retire a `manage` grant.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple

from app.identity.capability import classify_action, covers
from app.identity.model import (
    AWS, AZURE, DATA_PLANE_BLIND, OCI, USAGE_NOT_OBSERVED_HIGH, USAGE_NOT_OBSERVED_LOW,
    USAGE_OBSERVED, USAGE_UNKNOWN, normalize_provider,
)

# Below this, a window is too short for "not observed" to mean much. A
# fortnight of quiet on a monthly batch job is not evidence of anything.
MIN_HIGH_CONFIDENCE_DAYS = 30
# And a window with almost nothing in it says nothing either, however long.
MIN_HIGH_CONFIDENCE_EVENTS = 100

_AWS_SOURCE_RE = re.compile(r"^([a-z0-9\-]+)\.amazonaws\.com$", re.IGNORECASE)
_OCI_EVENT_RE = re.compile(r"^com\.oraclecloud\.([a-z0-9\-]+)\.", re.IGNORECASE)

# OCI service segment → policy resource family. Partial on purpose: an entry is
# added only where the mapping is unambiguous. Everything else returns None and
# becomes UNKNOWN, which is the correct answer rather than a plausible guess.
OCI_SERVICE_FAMILY: Dict[str, str] = {
    "virtualnetwork": "virtual-network-family",
    "computeapi": "instance-family",
    "compute": "instance-family",
    "objectstorage": "object-family",
    "blockvolume": "volume-family",
    "filestorage": "file-family",
    "database": "database-family",
    "autonomousdatabase": "autonomous-database-family",
    "identitycontrolplane": "users",
    "identity": "users",
    "loadbalancer": "load-balancers",
    "vault": "vaults",
    "keymanagementservice": "keys",
    "logging": "log-groups",
    "oke": "cluster-family",
    "containerengine": "cluster-family",
}


@dataclass
class ObservedAction:
    """One action a principal was seen performing, aggregated over the window."""

    action: str
    event_count: int = 0
    success_count: int = 0
    first_seen: Optional[datetime] = None
    last_seen: Optional[datetime] = None
    regions: Set[str] = field(default_factory=set)
    resources: Set[str] = field(default_factory=set)

    def observe(self, *, when: Optional[datetime], succeeded: bool,
                region: Optional[str], resource: Optional[str]) -> None:
        self.event_count += 1
        if succeeded:
            self.success_count += 1
        if when:
            if self.first_seen is None or when < self.first_seen:
                self.first_seen = when
            if self.last_seen is None or when > self.last_seen:
                self.last_seen = when
        if region:
            self.regions.add(region)
        if resource:
            self.resources.add(resource)


@dataclass
class Window:
    """The observation period, carried with every conclusion drawn from it."""

    start: datetime
    end: datetime
    days: int
    events_in_window: int = 0
    source_available: bool = True
    source_note: Optional[str] = None

    @classmethod
    def trailing(cls, days: int, *, end: Optional[datetime] = None) -> "Window":
        finish = end or datetime.now(timezone.utc)
        return cls(start=finish - timedelta(days=days), end=finish, days=days)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "start": self.start.isoformat(),
            "end": self.end.isoformat(),
            "days": self.days,
            "events_in_window": self.events_in_window,
            "source_available": self.source_available,
            "source_note": self.source_note,
        }


def normalize_event_action(
    provider: str,
    *,
    api_operation: Optional[str] = None,
    event_name: Optional[str] = None,
    event_source: Optional[str] = None,
) -> Optional[str]:
    """Turn an Event Log row into the permission string a policy would name.

    Returns None when the provider's audit record cannot be mapped to a
    permission — which is the honest answer for most OCI events and is what
    keeps an unmappable event from being silently counted as usage of
    something.
    """
    prov = normalize_provider(provider)

    if prov == AWS:
        # The adapter writes `s3.amazonaws.com:GetObject`; IAM spells it `s3:GetObject`.
        raw = api_operation or ""
        if ":" in raw:
            source, _, name = raw.partition(":")
        else:
            source, name = (event_source or ""), (event_name or raw)
        if not name:
            return None
        match = _AWS_SOURCE_RE.match(source.strip())
        service = match.group(1) if match else source.strip().rstrip(".")
        service = service.split(".")[0]
        if not service:
            return None
        # A handful of services have an IAM prefix that differs from the host.
        service = {"monitoring": "cloudwatch", "email": "ses"}.get(service, service)
        return f"{service}:{name.strip()}"

    if prov == AZURE:
        # `operationName` is already the RBAC operation string.
        operation = (api_operation or event_name or "").strip()
        return operation or None

    if prov == OCI:
        raw = (api_operation or "").strip()
        match = _OCI_EVENT_RE.match(raw)
        if not match:
            return None
        family = OCI_SERVICE_FAMILY.get(match.group(1).lower())
        if not family:
            return None
        # The verb is deliberately NOT inferred. The resource family is the
        # most that can be said truthfully, and the caller treats a
        # family-only observation as evidence about the family, not the verb.
        return f"?:{family}"

    return None


def aggregate_events(
    provider: str, events: Iterable[Any],
) -> Tuple[Dict[str, ObservedAction], int, int]:
    """Fold Event Log rows into per-action observations.

    Returns `(observations, total_events, unmappable_events)`. The third number
    is reported to the user: a principal with 4,000 events of which 3,900 could
    not be mapped to a permission has effectively no usable usage data, and
    hiding that would make its NOT_OBSERVED rows look far stronger than they are.
    """
    out: Dict[str, ObservedAction] = {}
    total = 0
    unmappable = 0
    for event in events or []:
        total += 1
        get = (lambda k: event.get(k)) if isinstance(event, dict) \
            else (lambda k: getattr(event, k, None))
        action = normalize_event_action(
            provider,
            api_operation=get("api_operation"),
            event_name=get("event_name"),
            event_source=get("event_source"),
        )
        if not action:
            unmappable += 1
            continue
        status = (get("status") or "").upper()
        obs = out.get(action)
        if obs is None:
            obs = out[action] = ObservedAction(action=action)
        obs.observe(
            when=get("timestamp"),
            succeeded=status not in ("FAILURE", "FAILED", "DENIED", "ERROR"),
            region=get("region"),
            resource=get("resource_id") or get("resource_name"),
        )
    return out, total, unmappable


def classify_usage(
    provider: str,
    action_or_pattern: str,
    *,
    observed: bool,
    window: Window,
    is_wildcard: bool = False,
) -> Tuple[str, Optional[str]]:
    """The usage state for one grant, plus the reason for its confidence.

    The reason is not decoration: it is the sentence shown beside the row, and
    it is what stops someone deleting an S3 permission because the data-event
    trail they never enabled recorded no use of it.
    """
    if observed:
        return USAGE_OBSERVED, None

    prov = normalize_provider(provider) or provider

    if not window.source_available:
        return USAGE_UNKNOWN, (
            window.source_note
            or "No audit data is collected for this account, so no conclusion can be "
               "drawn from the absence of events."
        )

    if prov == OCI:
        return USAGE_UNKNOWN, (
            "OCI audit events identify a cloud-event type, not a policy verb and "
            "resource family. This platform cannot map them to a permission "
            "precisely enough to say a grant went unused."
        )

    blind = DATA_PLANE_BLIND.get(prov, ())
    for blind_action in blind:
        if covers(prov, action_or_pattern, blind_action) or \
                action_or_pattern.lower() == blind_action.lower():
            return USAGE_NOT_OBSERVED_LOW, (
                f"{blind_action} is a data-plane operation. It is not recorded by "
                "default — AWS needs CloudTrail data events, Azure needs per-resource "
                "diagnostic settings — so no event is the expected result whether or "
                "not the permission is used."
            )

    if window.days < MIN_HIGH_CONFIDENCE_DAYS:
        return USAGE_NOT_OBSERVED_LOW, (
            f"The observation window is {window.days} days, shorter than the "
            f"{MIN_HIGH_CONFIDENCE_DAYS} days needed to cover monthly and quarterly "
            "activity."
        )

    if window.events_in_window < MIN_HIGH_CONFIDENCE_EVENTS:
        return USAGE_NOT_OBSERVED_LOW, (
            f"Only {window.events_in_window} events were recorded for this account in "
            f"{window.days} days. That is too few for an absence to be meaningful."
        )

    if is_wildcard:
        return USAGE_NOT_OBSERVED_HIGH, (
            f"No action matching this pattern was observed in {window.days} days "
            f"({window.events_in_window} events analysed)."
        )

    return USAGE_NOT_OBSERVED_HIGH, (
        f"The audit log covers this action type and recorded "
        f"{window.events_in_window} events in {window.days} days, none of them this "
        "action."
    )


def correlate(
    provider: str,
    *,
    granted_patterns: Sequence[str],
    observations: Dict[str, ObservedAction],
    window: Window,
    unmappable_events: int = 0,
) -> Dict[str, Any]:
    """Join grants to observed usage. The per-identity utilization picture.

    Every returned row carries the window, so no caller can render a count
    without the period it was counted over.
    """
    prov = normalize_provider(provider) or provider
    observed_actions = sorted(observations)

    pattern_rows: List[Dict[str, Any]] = []
    for pattern in granted_patterns:
        matched = [a for a in observed_actions if covers(prov, pattern, a)]
        is_wildcard = "*" in pattern or pattern.endswith(":*")
        state, reason = classify_usage(prov, pattern, observed=bool(matched),
                                       window=window, is_wildcard=is_wildcard)
        events = sum(observations[a].event_count for a in matched)
        last = max((observations[a].last_seen for a in matched
                    if observations[a].last_seen), default=None)
        pattern_rows.append({
            "pattern": pattern,
            "capability": classify_action(prov, pattern),
            "usage_state": state,
            "confidence_reason": reason,
            "observed_actions": matched,
            "observed_action_count": len(matched),
            "event_count": events,
            "last_observed_at": last.isoformat() if last else None,
            "window": window.to_dict(),
        })

    action_rows: List[Dict[str, Any]] = []
    for action in observed_actions:
        obs = observations[action]
        action_rows.append({
            "action": action,
            "capability": classify_action(prov, action),
            "usage_state": USAGE_OBSERVED,
            "event_count": obs.event_count,
            "success_count": obs.success_count,
            "first_observed_at": obs.first_seen.isoformat() if obs.first_seen else None,
            "last_observed_at": obs.last_seen.isoformat() if obs.last_seen else None,
            "regions": sorted(obs.regions),
            "distinct_resources": len(obs.resources),
            "window": window.to_dict(),
        })

    unexercised = [r for r in pattern_rows if r["usage_state"] != USAGE_OBSERVED]
    high_conf = [r for r in unexercised if r["usage_state"] == USAGE_NOT_OBSERVED_HIGH]

    return {
        "window": window.to_dict(),
        "granted_pattern_count": len(granted_patterns),
        "observed_action_count": len(observed_actions),
        "exercised_pattern_count": len(pattern_rows) - len(unexercised),
        "unexercised_pattern_count": len(unexercised),
        "high_confidence_unexercised_count": len(high_conf),
        "unmappable_events": unmappable_events,
        "unmappable_note": (
            f"{unmappable_events} event(s) in the window could not be mapped to a "
            "permission and were excluded from this analysis."
        ) if unmappable_events else None,
        "patterns": pattern_rows,
        "actions": action_rows,
        # Only this list may seed a right-sizing proposal. Named explicitly so
        # no caller can mistake the broader `unexercised` set for it.
        "removal_candidates": [r["pattern"] for r in high_conf],
        "utilization_note": (
            "Counts are of granted policy statements and of distinct observed "
            "actions. This platform does not expand wildcards into a full provider "
            "action catalog, so no granted-action total is shown — a percentage "
            "derived from a partial catalog would be meaningless."
        ),
    }


def utilization_percent(summary: Dict[str, Any]) -> Optional[float]:
    """Share of granted patterns that were exercised, or None if unknowable.

    None when there are no patterns, or when the window carries no usable
    audit data — in which case there is no honest number to show and the UI
    renders a dash.
    """
    total = summary.get("granted_pattern_count") or 0
    if not total:
        return None
    window = summary.get("window") or {}
    if not window.get("source_available", True):
        return None
    return round(100.0 * (summary.get("exercised_pattern_count") or 0) / total, 1)
