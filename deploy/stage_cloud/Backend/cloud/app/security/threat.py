"""Behavioural threat detection over the Event Log.

Every detector here runs on `cloud_events` — the audit trail the Event Log tab
already collects and normalises across CloudTrail, Azure Activity Log and OCI
Audit. There is no second ingestion path, for the same reason the attack-path
engine walks the existing topology graph: two subsystems with two opinions
about what happened is worse than one with a stated gap.

**A detector declares the fields it needs, and is switched off when they are
absent.** This is not defensive coding, it is the difference between a product
that reports "no impossible-travel detected" and one that admits it cannot
detect impossible travel. On the live estate `source_location` is populated on
**0 of 18,935 events**, so the geo detector below can never fire — and saying
so is the only honest thing to do with it. `availability()` reports, per
detector, whether its inputs exist, so an empty detection list can be read
correctly.

**Detections are not findings and are not alerts.** A detection says "this
sequence of recorded events matches this pattern". It carries every contributing
event so the operator can read the trail and decide. It deliberately does not
assert intent: `CreateUser` followed by `CreateAccessKey` followed by
`AttachUserPolicy` is exactly what an administrator onboarding a colleague does,
and exactly what an attacker establishing persistence does. The detector names
the pattern and shows the evidence; the human supplies the judgement. Severity
reflects *how much damage the pattern could do if malicious*, never a claim
about whether it is.

**Grouping is by actor, and events without one are excluded and counted.**
Roughly 40% of live events carry no `actor_id` (service-internal operations
mostly), and quietly folding them into one anonymous bucket would invent a
very busy principal that does not exist.
"""
from __future__ import annotations

import re
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, Iterable, List, NamedTuple, Optional, Sequence, Tuple

from app.security.model import CRITICAL, HIGH, INFO, LOW, MEDIUM

# ── Event field predicates ───────────────────────────────────────────────────
# A detector matches events with these. Kept declarative so a detector reads as
# a description of the pattern rather than as a loop.


class Match(NamedTuple):
    """A predicate over one event. All stated conditions must hold."""

    actions: Tuple[str, ...] = ()
    statuses: Tuple[str, ...] = ()
    actor_types: Tuple[str, ...] = ()
    risk_levels: Tuple[str, ...] = ()
    categories: Tuple[str, ...] = ()
    # Matched case-insensitively against `event_name`. Cross-cloud by design:
    # the same intent is spelled CreateUser on AWS and OCI and
    # `Microsoft.Authorization/roleAssignments/write` on Azure.
    name_pattern: Optional[str] = None

    def test(self, ev) -> bool:
        if self.actions and (getattr(ev, "action", None) or "") not in self.actions:
            return False
        if self.statuses and (getattr(ev, "status", None) or "") not in self.statuses:
            return False
        if self.actor_types and (getattr(ev, "actor_type", None) or "") not in self.actor_types:
            return False
        if self.risk_levels and (getattr(ev, "risk_level", None) or "") not in self.risk_levels:
            return False
        if self.categories and (getattr(ev, "event_category", None) or "") not in self.categories:
            return False
        if self.name_pattern:
            name = getattr(ev, "event_name", None) or ""
            if not re.search(self.name_pattern, name, re.IGNORECASE):
                return False
        return True


# ── Detector declarations ────────────────────────────────────────────────────

THRESHOLD = "threshold"
SEQUENCE = "sequence"
PRESENCE = "presence"


class Stage(NamedTuple):
    """One step of a sequence detector."""

    key: str
    label: str
    match: Match


class Detector(NamedTuple):
    detector_id: str
    title: str
    kind: str
    severity: str
    rationale: str
    recommended_action: str
    # Event fields without which this detector cannot run at all.
    requires: Tuple[str, ...] = ("actor_id",)
    window_minutes: int = 60
    # THRESHOLD / PRESENCE
    match: Optional[Match] = None
    threshold: int = 1
    # SEQUENCE
    stages: Tuple[Stage, ...] = ()

    def to_dict(self) -> dict:
        return {
            "detector_id": self.detector_id,
            "title": self.title,
            "kind": self.kind,
            "severity": self.severity,
            "rationale": self.rationale,
            "recommended_action": self.recommended_action,
            "requires": list(self.requires),
            "window_minutes": self.window_minutes,
            "threshold": self.threshold,
            "stages": [{"key": s.key, "label": s.label} for s in self.stages],
        }


# Identity-mutating operations, spelled for all three clouds.
_P_CREATE_IDENTITY = r"(CreateUser|AddUser|CreateServicePrincipal|users/write|CreateIdentity|CreateGroup)"
_P_CREATE_CREDENTIAL = r"(CreateAccessKey|UploadApiKey|CreateSecret|CreateAuthToken|addPassword|AddKey|CreateCredential|regenerate)"
_P_GRANT = r"(AttachUserPolicy|AttachRolePolicy|PutUserPolicy|CreatePolicy|AddUserToGroup|roleAssignments/write|UpdatePolicy|UpdateGroup)"
_P_LOGGING_OFF = r"(StopLogging|DeleteTrail|DeleteDiagnosticSetting|diagnosticSettings/delete|UpdateConfiguration.*disable|DeleteLogGroup)"
_P_SECURITY_OFF = r"(DisableSecurityHub|DeleteDetector|DisableMacie|securitySolutions/delete|DeleteAlarm|DeleteSecurityRule)"

DETECTORS: Tuple[Detector, ...] = (
    Detector(
        detector_id="REPEATED_AUTH_FAILURE",
        title="Repeated authorization failures by one principal",
        kind=THRESHOLD,
        severity=MEDIUM,
        match=Match(statuses=("Failed", "Denied")),
        threshold=8,
        window_minutes=15,
        rationale=(
            "A burst of denied or failed calls from one principal is what both "
            "credential stuffing and a misconfigured deployment look like. The "
            "distinction is in which operations were attempted, which is why "
            "every contributing event is attached rather than just a count."
        ),
        recommended_action=(
            "Read the attached events. If the denied operations are unrelated to "
            "the principal's job, treat the credential as compromised and rotate "
            "it. If they are a deployment retrying, fix the permission."
        ),
    ),
    Detector(
        detector_id="MASS_DELETION",
        title="High-volume deletion by one principal",
        kind=THRESHOLD,
        severity=HIGH,
        match=Match(actions=("Delete",)),
        threshold=15,
        window_minutes=60,
        rationale=(
            "Bulk deletion is the destructive half of a ransomware or "
            "retaliation incident, and it is also what a decommissioning script "
            "looks like. What distinguishes them is whether the principal "
            "normally deletes anything, and whether backups went with it."
        ),
        recommended_action=(
            "Confirm the deletions were intended. Check whether any attached "
            "event targets a backup, snapshot or vault — deleting recovery "
            "points alongside primary data is the signature that separates an "
            "incident from a cleanup."
        ),
    ),
    Detector(
        detector_id="ROOT_ACCOUNT_ACTIVITY",
        title="Root or tenancy-administrator activity",
        kind=PRESENCE,
        severity=HIGH,
        match=Match(actor_types=("RootAccount",)),
        threshold=1,
        window_minutes=1440,
        requires=("actor_type",),
        rationale=(
            "The root principal should be used for the handful of operations "
            "that genuinely require it and nothing else. Routine root activity "
            "means either that day-to-day work runs as root, or that someone "
            "else has the credential."
        ),
        recommended_action=(
            "Confirm each use was one of the operations that require root. "
            "Move everything else to a named principal with a scoped role, and "
            "ensure the root credential has MFA and no access keys."
        ),
    ),
    Detector(
        detector_id="PRIVILEGE_ESCALATION_SEQUENCE",
        title="Identity created, credentialed and granted permissions",
        kind=SEQUENCE,
        severity=HIGH,
        window_minutes=1440,
        stages=(
            Stage("identity", "A principal was created",
                  Match(name_pattern=_P_CREATE_IDENTITY)),
            Stage("credential", "A credential was issued to it",
                  Match(name_pattern=_P_CREATE_CREDENTIAL)),
            Stage("grant", "Permissions were attached",
                  Match(name_pattern=_P_GRANT)),
        ),
        rationale=(
            "This is the canonical persistence sequence — and it is also exactly "
            "what onboarding a colleague looks like. The pattern is reported "
            "because it is the shape worth reviewing, NOT because it is "
            "evidence of an attack. Judge it on whether the actor had reason to "
            "do it and whether a change record exists."
        ),
        recommended_action=(
            "Match the sequence to a change request. If none exists, disable "
            "the created principal and revoke its credential before "
            "investigating — a persistence mechanism left live while it is "
            "being investigated is a persistence mechanism."
        ),
    ),
    Detector(
        detector_id="LOGGING_DISABLED",
        title="Audit logging altered or disabled",
        kind=PRESENCE,
        severity=CRITICAL,
        match=Match(name_pattern=_P_LOGGING_OFF),
        threshold=1,
        window_minutes=1440,
        rationale=(
            "Disabling the audit trail has no legitimate routine purpose and is "
            "the standard precursor to activity someone does not want recorded. "
            "It also degrades every other detector here, which is why it is the "
            "one pattern rated CRITICAL on a single occurrence."
        ),
        recommended_action=(
            "Re-enable logging immediately, then review what happened in the "
            "window during which it was off — treat that period as unmonitored "
            "rather than as quiet."
        ),
    ),
    Detector(
        detector_id="SECURITY_CONTROL_DISABLED",
        title="A security control was deleted or disabled",
        kind=PRESENCE,
        severity=HIGH,
        match=Match(name_pattern=_P_SECURITY_OFF),
        threshold=1,
        window_minutes=1440,
        rationale=(
            "Detectors, alarms and security rules are removed during legitimate "
            "re-architecture and during attacks. Either way the control is gone "
            "and the estate is less observable than its documentation claims."
        ),
        recommended_action=(
            "Confirm the removal was intended and that an equivalent control "
            "replaced it. If not, restore it."
        ),
    ),
    Detector(
        detector_id="CRITICAL_RISK_BURST",
        title="Several critical-risk operations in quick succession",
        kind=THRESHOLD,
        severity=MEDIUM,
        # CRITICAL only, deliberately. The first version matched HIGH as well
        # and fired 55 times on one live Azure subscription in a month, because
        # the Event Log's classifier rates 22% of all events HIGH — a burst of
        # ten of them in half an hour is an ordinary working morning. CRITICAL
        # is 171 of 18,935 events estate-wide, which is the rarity this
        # detector assumed it was matching.
        match=Match(risk_levels=(CRITICAL,)),
        threshold=5,
        window_minutes=30,
        rationale=(
            "The Event Log already rates each operation's risk. A cluster of "
            "critical-risk operations by one principal in half an hour is worth "
            "a look even when no individual one is alarming — the pattern is "
            "the signal, not any single event."
        ),
        recommended_action=(
            "Review the attached events as a group. A burst that corresponds to "
            "a deployment is expected; one that does not is worth tracing to a "
            "change record."
        ),
    ),
    Detector(
        detector_id="IMPOSSIBLE_TRAVEL",
        title="One principal active from two distant locations",
        kind=THRESHOLD,
        severity=HIGH,
        match=Match(),
        threshold=2,
        window_minutes=60,
        # Declared and permanently unavailable on this data — see availability().
        requires=("actor_id", "source_location"),
        rationale=(
            "Two sign-ins from locations further apart than the elapsed time "
            "allows means at least one did not come from the account holder. "
            "It is among the strongest single signals of credential theft."
        ),
        recommended_action=(
            "Not available. Populating `source_location` on collected events "
            "would enable this detector; nothing else about it needs building."
        ),
    ),
)

DETECTORS_BY_ID: Dict[str, Detector] = {d.detector_id: d for d in DETECTORS}


# ── Results ──────────────────────────────────────────────────────────────────


class Detection(NamedTuple):
    detector_id: str
    title: str
    severity: str
    actor_id: Optional[str]
    actor_name: Optional[str]
    actor_type: Optional[str]
    first_seen: datetime
    last_seen: datetime
    event_count: int
    events: List[Dict[str, Any]]
    evidence: Dict[str, Any]
    # How many separate windows this actor tripped the same detector in. One
    # detection per (detector, actor) rather than per window: on a live Azure
    # subscription the per-window form produced 103 rows from 6 principals,
    # which is a list nobody reads. The occurrences are preserved in
    # `evidence["occurrences"]` so nothing is lost but the repetition.
    occurrences: int = 1

    @property
    def detection_id(self) -> str:
        """Stable for the same actor, detector and window start."""
        import hashlib
        raw = f"{self.detector_id}|{self.actor_id}|{self.first_seen.isoformat()}"
        return hashlib.sha256(raw.encode()).hexdigest()[:24]

    def to_dict(self) -> dict:
        d = DETECTORS_BY_ID.get(self.detector_id)
        return {
            "detection_id": self.detection_id,
            "detector_id": self.detector_id,
            "title": self.title,
            "severity": self.severity,
            "actor_id": self.actor_id,
            "actor_name": self.actor_name,
            "actor_type": self.actor_type,
            "first_seen": self.first_seen.isoformat(),
            "last_seen": self.last_seen.isoformat(),
            "event_count": self.event_count,
            "occurrences": self.occurrences,
            "events": self.events,
            "evidence": self.evidence,
            "rationale": d.rationale if d else None,
            "recommended_action": d.recommended_action if d else None,
            "window_minutes": d.window_minutes if d else None,
            "not_an_accusation": (
                "This is a pattern match over recorded events, not a judgement "
                "about intent. Read the events before acting."
            ),
        }


def _event_brief(ev) -> Dict[str, Any]:
    return {
        "event_id": str(getattr(ev, "id", "") or ""),
        "timestamp": _ts(ev).isoformat(),
        "event_name": getattr(ev, "event_name", None),
        "action": getattr(ev, "action", None),
        "status": getattr(ev, "status", None),
        "risk_level": getattr(ev, "risk_level", None),
        "resource_name": getattr(ev, "resource_name", None),
        "resource_id": getattr(ev, "resource_id", None),
        "source_ip": getattr(ev, "source_ip", None),
        "region": getattr(ev, "region", None),
    }


def _ts(ev) -> datetime:
    t = getattr(ev, "timestamp", None)
    if t is None:
        return datetime.min.replace(tzinfo=timezone.utc)
    if t.tzinfo is None:
        return t.replace(tzinfo=timezone.utc)
    return t


# ── Availability ─────────────────────────────────────────────────────────────


def availability(events: Sequence[Any]) -> Dict[str, Dict[str, Any]]:
    """Per detector: can it run on THIS event set, and if not, why not.

    Computed from the data rather than declared, so a field that stops being
    collected switches its detectors off visibly instead of making them
    silently barren.
    """
    total = len(events)
    filled: Dict[str, int] = {}
    for field in ("actor_id", "actor_type", "source_ip", "source_location",
                  "status", "action", "event_name", "risk_level"):
        filled[field] = sum(
            1 for e in events if getattr(e, field, None) not in (None, "")
        )

    out: Dict[str, Dict[str, Any]] = {}
    for d in DETECTORS:
        missing = [f for f in d.requires if filled.get(f, 0) == 0]
        out[d.detector_id] = {
            "available": not missing and total > 0,
            "missing_fields": missing,
            "field_coverage": {
                f: {"filled": filled.get(f, 0), "total": total,
                    "pct": round(100.0 * filled.get(f, 0) / total, 1) if total else None}
                for f in d.requires
            },
            "reason": (
                None if (not missing and total > 0) else
                ("No events have been collected for this account."
                 if total == 0 else
                 f"Not available: {', '.join(missing)} is not populated on any "
                 f"collected event, so this detector can never fire. An empty "
                 f"result for it means 'not detectable', not 'nothing happened'.")
            ),
        }
    return out


# ── The engine ───────────────────────────────────────────────────────────────


def _by_actor(events: Sequence[Any]) -> Tuple[Dict[str, List[Any]], int]:
    """(actor -> events sorted by time, events with no actor).

    Events without an actor are counted and dropped rather than pooled: one
    anonymous bucket would look like a single extremely busy principal and
    would trip every threshold detector on the list.
    """
    grouped: Dict[str, List[Any]] = defaultdict(list)
    anonymous = 0
    for e in events:
        actor = getattr(e, "actor_id", None) or getattr(e, "actor_name", None)
        if not actor:
            anonymous += 1
            continue
        grouped[str(actor)].append(e)
    for v in grouped.values():
        v.sort(key=_ts)
    return grouped, anonymous


def _actor_fields(evs: Sequence[Any]) -> Tuple[Optional[str], Optional[str], Optional[str]]:
    for e in evs:
        return (
            getattr(e, "actor_id", None),
            getattr(e, "actor_name", None),
            getattr(e, "actor_type", None),
        )
    return None, None, None


def _threshold_detections(d: Detector, grouped: Dict[str, List[Any]]) -> List[Detection]:
    """Sliding window over one actor's matching events."""
    out: List[Detection] = []
    window = timedelta(minutes=d.window_minutes)
    for actor, evs in grouped.items():
        hits = [e for e in evs if d.match and d.match.test(e)]
        if len(hits) < d.threshold:
            continue
        # Earliest window that reaches the threshold; then skip past it so one
        # long burst is one detection rather than one per event.
        i = 0
        while i < len(hits):
            j = i
            while j < len(hits) and _ts(hits[j]) - _ts(hits[i]) <= window:
                j += 1
            span = hits[i:j]
            if len(span) >= d.threshold:
                aid, aname, atype = _actor_fields(span)
                out.append(Detection(
                    detector_id=d.detector_id, title=d.title, severity=d.severity,
                    actor_id=aid, actor_name=aname, actor_type=atype,
                    first_seen=_ts(span[0]), last_seen=_ts(span[-1]),
                    event_count=len(span),
                    events=[_event_brief(e) for e in span[:50]],
                    evidence={
                        "threshold": d.threshold,
                        "window_minutes": d.window_minutes,
                        "matched_events": len(span),
                        "distinct_operations": sorted({
                            getattr(e, "event_name", "") or "" for e in span})[:20],
                        "distinct_source_ips": sorted({
                            getattr(e, "source_ip", None) or "" for e in span
                        } - {""})[:10],
                        "events_truncated": len(span) > 50,
                    },
                ))
                i = j
            else:
                i += 1
    return out


def _presence_detections(d: Detector, grouped: Dict[str, List[Any]]) -> List[Detection]:
    """One detection per actor per window for a pattern that matters once."""
    out: List[Detection] = []
    window = timedelta(minutes=d.window_minutes)
    for actor, evs in grouped.items():
        hits = [e for e in evs if d.match and d.match.test(e)]
        if not hits:
            continue
        bucket: List[Any] = []
        for e in hits:
            if bucket and _ts(e) - _ts(bucket[0]) > window:
                out.append(_presence_one(d, bucket))
                bucket = []
            bucket.append(e)
        if bucket:
            out.append(_presence_one(d, bucket))
    return out


def _presence_one(d: Detector, span: List[Any]) -> Detection:
    aid, aname, atype = _actor_fields(span)
    return Detection(
        detector_id=d.detector_id, title=d.title, severity=d.severity,
        actor_id=aid, actor_name=aname, actor_type=atype,
        first_seen=_ts(span[0]), last_seen=_ts(span[-1]),
        event_count=len(span),
        events=[_event_brief(e) for e in span[:50]],
        evidence={
            "window_minutes": d.window_minutes,
            "matched_events": len(span),
            "distinct_operations": sorted({
                getattr(e, "event_name", "") or "" for e in span})[:20],
            "events_truncated": len(span) > 50,
        },
    )


def _sequence_detections(d: Detector, grouped: Dict[str, List[Any]]) -> List[Detection]:
    """Stages matched IN ORDER by one actor inside the window.

    Order matters: a grant followed by an identity creation is not an
    escalation sequence, it is two unrelated administrative acts. Requiring the
    order is what keeps this from firing on any busy IAM day.
    """
    out: List[Detection] = []
    window = timedelta(minutes=d.window_minutes)
    for actor, evs in grouped.items():
        idx = 0
        matched: List[Tuple[Stage, Any]] = []
        for e in evs:
            if idx >= len(d.stages):
                break
            stage = d.stages[idx]
            if not stage.match.test(e):
                continue
            if matched and _ts(e) - _ts(matched[0][1]) > window:
                # Too late to belong to this attempt; restart from this event.
                matched = []
                idx = 0
                if not d.stages[0].match.test(e):
                    continue
                stage = d.stages[0]
            matched.append((stage, e))
            idx += 1
        if len(matched) == len(d.stages):
            span = [e for _, e in matched]
            aid, aname, atype = _actor_fields(span)
            out.append(Detection(
                detector_id=d.detector_id, title=d.title, severity=d.severity,
                actor_id=aid, actor_name=aname, actor_type=atype,
                first_seen=_ts(span[0]), last_seen=_ts(span[-1]),
                event_count=len(span),
                events=[_event_brief(e) for e in span],
                evidence={
                    "window_minutes": d.window_minutes,
                    "stages": [
                        {"key": s.key, "label": s.label,
                         "event_name": getattr(e, "event_name", None),
                         "at": _ts(e).isoformat()}
                        for s, e in matched
                    ],
                    "elapsed_minutes": round(
                        (_ts(span[-1]) - _ts(span[0])).total_seconds() / 60.0, 1),
                },
            ))
    return out


_SEV_RANK = {CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4}


def _collapse(windows: Sequence[Detection]) -> List[Detection]:
    """One detection per (detector, actor), summarising every window it tripped.

    The per-window form is the honest raw output and the wrong thing to render:
    six principals failing authorization on six mornings became 47 rows, and a
    list of 47 near-identical MEDIUMs is read as noise and then ignored
    entirely — including the one that mattered. Collapsing keeps every window
    as evidence while putting one row per principal in front of the operator.
    """
    buckets: Dict[Tuple[str, Optional[str]], List[Detection]] = defaultdict(list)
    for w in windows:
        buckets[(w.detector_id, w.actor_id or w.actor_name)].append(w)

    out: List[Detection] = []
    for (_detector, _actor), group in buckets.items():
        group.sort(key=lambda x: x.first_seen)
        head = group[0]
        total_events = sum(g.event_count for g in group)
        merged_ops = sorted({
            op for g in group
            for op in (g.evidence.get("distinct_operations") or [])
        })[:25]
        merged_ips = sorted({
            ip for g in group
            for ip in (g.evidence.get("distinct_source_ips") or [])
        })[:15]
        evidence = dict(head.evidence)
        evidence.update({
            "occurrences": len(group),
            "total_events": total_events,
            "distinct_operations": merged_ops or evidence.get("distinct_operations"),
            "distinct_source_ips": merged_ips or evidence.get("distinct_source_ips"),
            "occurrence_windows": [
                {"first_seen": g.first_seen.isoformat(),
                 "last_seen": g.last_seen.isoformat(),
                 "event_count": g.event_count}
                for g in group[:30]
            ],
        })
        out.append(head._replace(
            first_seen=group[0].first_seen,
            last_seen=max(g.last_seen for g in group),
            event_count=total_events,
            occurrences=len(group),
            # Keep the evidence from the largest window, which is the one most
            # worth reading first.
            events=max(group, key=lambda g: g.event_count).events,
            evidence=evidence,
        ))
    return out


def detect(events: Sequence[Any]) -> Dict[str, Any]:
    """Run every available detector. Pure: no I/O, no mutation."""
    avail = availability(events)
    grouped, anonymous = _by_actor(events)

    windows: List[Detection] = []
    for d in DETECTORS:
        if not avail[d.detector_id]["available"]:
            continue
        if d.kind == THRESHOLD:
            windows.extend(_threshold_detections(d, grouped))
        elif d.kind == PRESENCE:
            windows.extend(_presence_detections(d, grouped))
        elif d.kind == SEQUENCE:
            windows.extend(_sequence_detections(d, grouped))

    detections = _collapse(windows)

    detections.sort(key=lambda x: (
        _SEV_RANK.get(x.severity, 9), -x.event_count, x.detector_id))

    by_detector: Dict[str, int] = {}
    by_severity: Dict[str, int] = {}
    for x in detections:
        by_detector[x.detector_id] = by_detector.get(x.detector_id, 0) + 1
        by_severity[x.severity] = by_severity.get(x.severity, 0) + 1

    unavailable = [k for k, v in avail.items() if not v["available"]]
    return {
        "detections": [x.to_dict() for x in detections],
        "total": len(detections),
        "total_windows": len(windows),
        "by_detector": by_detector,
        "by_severity": by_severity,
        "detectors": [d.to_dict() for d in DETECTORS],
        "availability": avail,
        "unavailable_detectors": unavailable,
        "events_considered": len(events),
        "events_without_actor": anonymous,
        "events_without_actor_note": (
            f"{anonymous} of {len(events)} events carry no actor and were "
            "excluded. Detectors group by principal, and pooling unattributed "
            "events would invent one extremely busy principal."
        ) if anonymous else None,
        "empty_means": (
            "No pattern matched the events collected in this window."
            if not unavailable else
            f"No pattern matched, but {len(unavailable)} detector(s) could not "
            "run at all — see `availability`."
        ),
    }
