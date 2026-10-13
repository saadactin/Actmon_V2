"""Correlated security incidents — several signals about one subject.

A findings list answers "what is wrong". It does not answer "is anything
happening", because the four facts that together describe an incident arrive in
four different tabs: the port is open (Security), the host is reachable
(Exposure), something is on a path to the data (Attack Paths), and a principal
has been failing authorization against it all morning (Event Log). Each is
unremarkable alone. Together they are the thing you get paged for.

This module joins them on a **shared subject** — a resource, or a principal —
and nothing else. That constraint is what keeps it honest.

**Correlation is not causation, and this module never claims otherwise.** That
an exposed VM has a CRITICAL finding and that a principal failed authorization
near it are two true statements about the same resource. They may be one
attack or two coincidences, and nothing in the audit trail distinguishes them.
So an incident states what co-occurs, shows the timeline, and leaves the
inference to the person reading it — `correlation_basis` on every incident says
exactly which field was used to join, so a reader can reject the join if it is
spurious. The alternative, a confident "ACTIVE BREACH DETECTED" banner derived
from the same evidence, is how a security product teaches people to ignore it.

**Two signals of DIFFERENT kinds are required.** Three findings on one bucket
are three findings, not an incident — grouping them would just be the findings
list with extra words. The threshold is deliberately about kind rather than
count: a finding plus a detection is a story; ten findings are a backlog.

**Severity is the worst contributing signal, never a sum.** An incident of one
CRITICAL and three MEDIUMs is CRITICAL. Adding them would produce a number
larger than anything that is actually true, and the whole point of this view is
to be more trustworthy than the parts, not louder.
"""
from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from typing import Any, Dict, List, NamedTuple, Optional, Sequence, Tuple

from app.security.model import CRITICAL, HIGH, INFO, LOW, MEDIUM, severity_rank

# ── Signal kinds ─────────────────────────────────────────────────────────────
SIGNAL_FINDING = "finding"
SIGNAL_DETECTION = "detection"
SIGNAL_ATTACK_PATH = "attack_path"
SIGNAL_EXPOSURE = "exposure"

SIGNAL_LABEL: Dict[str, str] = {
    SIGNAL_FINDING: "Security finding",
    SIGNAL_DETECTION: "Behavioural detection",
    SIGNAL_ATTACK_PATH: "Attack path",
    SIGNAL_EXPOSURE: "Internet exposure",
}

# Joining on a resource is strong: the provider's own identifier matched.
# Joining on a principal is weaker — it says the same actor touched both, which
# is ordinary for an administrator. Stated so a reader can weigh it.
BASIS_RESOURCE = "resource"
BASIS_ACTOR = "actor"

BASIS_MEANING: Dict[str, str] = {
    BASIS_RESOURCE: (
        "These signals name the same resource, matched on the provider's own "
        "identifier. The join is exact."
    ),
    BASIS_ACTOR: (
        "These signals name the same principal. That is ordinary for an "
        "administrator with broad duties — treat the grouping as a prompt to "
        "look, not as evidence the activities are related."
    ),
}


class Signal(NamedTuple):
    kind: str
    title: str
    severity: str
    at: Optional[datetime]
    ref: Optional[str]            # finding fingerprint, detection id, path id
    detail: Optional[str] = None
    payload: Dict[str, Any] = {}

    def to_dict(self) -> dict:
        return {
            "kind": self.kind,
            "kind_label": SIGNAL_LABEL.get(self.kind, self.kind),
            "title": self.title,
            "severity": self.severity,
            "at": self.at.isoformat() if self.at else None,
            "ref": self.ref,
            "detail": self.detail,
            "payload": self.payload,
        }


class Incident(NamedTuple):
    subject_kind: str             # BASIS_RESOURCE | BASIS_ACTOR
    subject_id: str
    subject_name: Optional[str]
    subject_type: Optional[str]
    signals: List[Signal]

    @property
    def severity(self) -> str:
        """The worst contributing signal. Never a sum."""
        if not self.signals:
            return INFO
        return min((s.severity for s in self.signals), key=severity_rank)

    @property
    def kinds(self) -> List[str]:
        return sorted({s.kind for s in self.signals})

    @property
    def incident_id(self) -> str:
        raw = f"{self.subject_kind}|{self.subject_id}|{'|'.join(sorted(s.ref or s.title for s in self.signals))}"
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]

    def to_dict(self) -> dict:
        timed = [s for s in self.signals if s.at]
        timed.sort(key=lambda s: s.at)
        return {
            "incident_id": self.incident_id,
            "subject_kind": self.subject_kind,
            "subject_id": self.subject_id,
            "subject_name": self.subject_name,
            "subject_type": self.subject_type,
            "severity": self.severity,
            "signal_kinds": self.kinds,
            "signal_count": len(self.signals),
            "signals": [s.to_dict() for s in self.signals],
            "timeline": [s.to_dict() for s in timed],
            "timeline_available": bool(timed),
            "timeline_note": (
                None if timed else
                "No contributing signal carries a timestamp, so these cannot be "
                "ordered. Findings record when they were first detected, not "
                "when the condition began."
            ),
            "correlation_basis": self.subject_kind,
            "correlation_meaning": BASIS_MEANING[self.subject_kind],
            "not_causal": (
                "These signals concern the same "
                f"{'resource' if self.subject_kind == BASIS_RESOURCE else 'principal'}. "
                "That they co-occur is a fact; that they are related is an "
                "inference this product does not make for you."
            ),
            "summary": _summarise(self),
        }


def _summarise(inc: "Incident") -> str:
    """A sentence describing what co-occurs — descriptive, never accusatory."""
    parts: List[str] = []
    by_kind: Dict[str, int] = {}
    for s in inc.signals:
        by_kind[s.kind] = by_kind.get(s.kind, 0) + 1
    for kind in (SIGNAL_EXPOSURE, SIGNAL_FINDING, SIGNAL_ATTACK_PATH, SIGNAL_DETECTION):
        n = by_kind.get(kind)
        if not n:
            continue
        label = SIGNAL_LABEL[kind].lower()
        parts.append(f"{n} {label}{'s' if n > 1 else ''}")
    subject = inc.subject_name or inc.subject_id
    return (
        f"{', '.join(parts)} concern {subject}."
        if parts else f"Signals concerning {subject}."
    )


# ── Building signals from each source ────────────────────────────────────────


def _finding_signal(f) -> Signal:
    return Signal(
        kind=SIGNAL_FINDING,
        title=getattr(f, "title", None) or getattr(f, "rule_id", "Finding"),
        severity=(getattr(f, "severity", None) or MEDIUM),
        at=getattr(f, "first_detected_at", None),
        ref=getattr(f, "fingerprint", None),
        detail=getattr(f, "rule_id", None),
        payload={
            "rule_id": getattr(f, "rule_id", None),
            "category": getattr(f, "category", None),
            "verdict": getattr(f, "verdict", None),
            "status": getattr(f, "status", None),
        },
    )


def _detection_signal(d: Dict[str, Any]) -> Signal:
    at = d.get("first_seen")
    parsed: Optional[datetime] = None
    if isinstance(at, str):
        try:
            parsed = datetime.fromisoformat(at)
        except ValueError:
            parsed = None
    return Signal(
        kind=SIGNAL_DETECTION,
        title=d.get("title") or d.get("detector_id") or "Detection",
        severity=d.get("severity") or MEDIUM,
        at=parsed,
        ref=d.get("detection_id"),
        detail=d.get("detector_id"),
        payload={
            "detector_id": d.get("detector_id"),
            "actor_id": d.get("actor_id"),
            "actor_name": d.get("actor_name"),
            "event_count": d.get("event_count"),
            "occurrences": d.get("occurrences"),
        },
    )


def _path_signal(p: Dict[str, Any]) -> Signal:
    risk = p.get("risk") or {}
    return Signal(
        kind=SIGNAL_ATTACK_PATH,
        title=f"Attack path to {(p.get('target') or {}).get('name') or 'a data store'}",
        severity=risk.get("band") or MEDIUM,
        at=None,                       # paths are derived, not observed at a time
        ref=p.get("path_id"),
        detail=p.get("path_class_label"),
        payload={
            "path_id": p.get("path_id"),
            "length": p.get("length"),
            "confidence": p.get("confidence"),
            "points": risk.get("points"),
        },
    )


def _exposure_signal(e) -> Signal:
    ports = [op.label for op in (getattr(e, "open_ports", None) or [])][:8]
    worst = None
    try:
        from app.security import ports as portcat
        worst = portcat.worst_of(getattr(e, "open_ports", None) or [])
    except Exception:  # noqa: BLE001
        worst = None
    return Signal(
        kind=SIGNAL_EXPOSURE,
        title="Reachable from the internet",
        severity=worst or MEDIUM,
        at=None,
        ref=getattr(e, "resource_key", None),
        detail=", ".join(ports) if ports else None,
        payload={
            "verdict": getattr(e, "verdict", None),
            "open_ports": ports,
            "public_addresses": list(getattr(e, "public_addresses", None) or []),
        },
    )


# ── Correlation ──────────────────────────────────────────────────────────────


def _resource_keys(obj) -> List[str]:
    """Every identifier this object might be joined on.

    The attribute names differ by source and that difference caused a real bug:
    a SIGNAL (a finding, an exposure) carries `resource_key` / `resource_id`,
    while an inventory ROW carries `provider_resource_id` / `id`. Reading only
    the first pair meant the alias map never learned a resource's provider id,
    so a finding keyed on the ARM id and an attack path keyed on the row id
    landed in two buckets — `cygnus-vpn` appeared twice in the live list, once
    under each. Both naming conventions are read here, so one resource is one
    subject whichever side produced the signal.
    """
    out = []
    for attr in ("resource_key", "resource_id", "provider_resource_id", "id"):
        v = getattr(obj, attr, None)
        if v:
            out.append(str(v))
    return out


def correlate(
    *,
    findings: Sequence[Any] = (),
    detections: Sequence[Dict[str, Any]] = (),
    attack_paths: Sequence[Dict[str, Any]] = (),
    exposures: Sequence[Any] = (),
    resources: Sequence[Any] = (),
    min_signal_kinds: int = 2,
) -> Dict[str, Any]:
    """Group signals that concern the same resource or principal.

    Pure. Everything passed in has already been computed by the subsystem that
    owns it, so an incident cannot disagree with the tab it came from.
    """
    # One resource is known by several identifiers — the provider's own id, the
    # inventory row's UUID, and whatever the event log recorded — and signals
    # arrive keyed on different ones. Bucketing on the raw key split a single
    # VM into two incidents on live data (`cygnus-vpn` appeared once under its
    # ARM id and once under its row id), which double-counts the estate's worst
    # findings and makes the list untrustworthy at a glance.
    #
    # So every known alias collapses to one canonical key, chosen as the
    # inventory row id because that is what the UI routes on.
    canonical: Dict[str, str] = {}
    names: Dict[str, Tuple[Optional[str], Optional[str]]] = {}
    for r in resources:
        aliases = _resource_keys(r)
        if not aliases:
            continue
        key = str(getattr(r, "id", "") or "") or aliases[0]
        for alias in set(aliases):
            canonical[alias] = key
        names[key] = (getattr(r, "resource_name", None),
                      getattr(r, "resource_type", None))

    buckets: Dict[Tuple[str, str], List[Signal]] = {}

    def add(kind: str, key: str, signal: Signal) -> None:
        if not key:
            return
        # An identifier the inventory does not know (an event naming a resource
        # that has since been deleted) stays as itself rather than being
        # dropped — it is still a real subject, just one with no row.
        resolved = canonical.get(str(key), str(key)) if kind == BASIS_RESOURCE else str(key)
        buckets.setdefault((kind, resolved), []).append(signal)

    # ── resource-keyed signals ──
    for f in findings:
        sig = _finding_signal(f)
        for k in _resource_keys(f):
            add(BASIS_RESOURCE, k, sig)

    for e in exposures:
        if getattr(e, "verdict", None) != "EXPOSED":
            continue
        sig = _exposure_signal(e)
        for k in (getattr(e, "resource_key", None), getattr(e, "resource_id", None)):
            if k:
                add(BASIS_RESOURCE, str(k), sig)

    for p in attack_paths:
        sig = _path_signal(p)
        # Every resource on the route, so a host in the middle of a path shows
        # the path among its signals rather than only the endpoints.
        for node in (p.get("nodes") or []):
            for k in (node.get("id"), node.get("resource_id")):
                if k:
                    add(BASIS_RESOURCE, str(k), sig)

    for d in detections:
        sig = _detection_signal(d)
        # A detection joins to resources through the events that produced it.
        touched = {
            ev.get("resource_id") for ev in (d.get("events") or [])
            if ev.get("resource_id")
        }
        for k in touched:
            add(BASIS_RESOURCE, str(k), sig)
        if d.get("actor_id") or d.get("actor_name"):
            add(BASIS_ACTOR, str(d.get("actor_id") or d.get("actor_name")), sig)

    # ── build incidents ──
    incidents: List[Incident] = []
    for (basis, key), signals in buckets.items():
        unique: Dict[str, Signal] = {}
        for s in signals:
            unique[f"{s.kind}|{s.ref or s.title}"] = s
        sigs = list(unique.values())
        if len({s.kind for s in sigs}) < min_signal_kinds:
            continue
        name, rtype = names.get(key, (None, None))
        if basis == BASIS_ACTOR:
            name = next((s.payload.get("actor_name") for s in sigs
                         if s.payload.get("actor_name")), key)
            rtype = "Principal"
        incidents.append(Incident(
            subject_kind=basis, subject_id=key, subject_name=name,
            subject_type=rtype, signals=sigs,
        ))

    incidents.sort(key=lambda i: (
        severity_rank(i.severity), -len(i.signals), i.subject_name or i.subject_id))

    by_sev: Dict[str, int] = {}
    for i in incidents:
        by_sev[i.severity] = by_sev.get(i.severity, 0) + 1

    return {
        "incidents": [i.to_dict() for i in incidents],
        "total": len(incidents),
        "by_severity": by_sev,
        "min_signal_kinds": min_signal_kinds,
        "signal_kinds": SIGNAL_LABEL,
        "inputs": {
            "findings": len(findings),
            "detections": len(detections),
            "attack_paths": len(attack_paths),
            "exposed_resources": sum(
                1 for e in exposures if getattr(e, "verdict", None) == "EXPOSED"),
        },
        "method": (
            f"Signals are grouped when they name the same resource or the same "
            f"principal. An incident requires at least {min_signal_kinds} "
            f"DIFFERENT kinds of signal — several findings on one resource are "
            f"findings, not an incident. Severity is the worst contributing "
            f"signal, never a sum."
        ),
        "not_causal": (
            "Co-occurrence is reported; causation is not inferred. Every "
            "incident states the field it was joined on so a spurious grouping "
            "can be recognised and dismissed."
        ),
        "empty_means": (
            "No subject carried two different kinds of signal. That is a normal "
            "and good result; it does not mean the individual findings are "
            "resolved."
        ),
    }
