"""The alert policy engine: which findings cross a threshold worth telling someone.

Before this, alerting was one hard-coded rule evaluated inside the discovery
worker — `STOPPED_INSTANCE_ATTACHED_STORAGE`, a cost condition. Nothing
connected security findings to alerts at all, so on the live estate **82
CRITICAL findings on AWS and 68 on OCI produced zero alerts**, including
world-open RDP on four security groups and 24 OCI security lists permitting SSH
from 0.0.0.0/0. The alert feed's 38 entries were all about idle disks.

The separation this module maintains, from §46:

    A FINDING answers  "what is wrong?"
    An ALERT answers   "did that cross a threshold worth interrupting someone?"

They are not the same and must not be one row. A finding can be open for 15
days with 15 detections and produce exactly one alert, notified once. That is
why a policy has a `threshold_kind` rather than just an on/off switch, and why
`cooldown_minutes` lives on the policy rather than being hard-coded.

**Threshold evaluation is deliberately stateless here.** `evaluate()` takes the
findings and the policy rows and returns intents; the caller does the writing.
That keeps the interesting logic testable without a database, which is what
makes the "4 findings with threshold 5 → no alert, 5 → alert, 6 → same alert"
test cheap enough to actually exist.

**Auto-resolution is never done from an incomplete assessment.** The rule that
protects the inventory prune and the storage alerts protects this too: if the
sweep could not enumerate every scope, a finding's absence may mean "failed to
list", and closing a real alert on that basis tells the user a problem is
solved when it is not.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, NamedTuple, Optional, Sequence, Set

from app.models.security_finding import (
    THRESHOLD_ANY_NEW, THRESHOLD_CONSECUTIVE, THRESHOLD_DURATION,
    THRESHOLD_FINDING_COUNT, THRESHOLD_KINDS, THRESHOLD_PERCENTAGE,
    THRESHOLD_RESOURCE_COUNT, THRESHOLD_SCORE_BELOW, THRESHOLD_SEVERITY,
)
from app.security import ports as portcat
from app.security.model import (
    ACTIVE_FINDING_STATUSES, CAT_ENCRYPTION, CAT_EXPOSURE, CAT_IAM, CRITICAL, HIGH,
    MEDIUM, VULNERABLE, severity_rank,
)

logger = logging.getLogger("cloud_svc.security.policies")


class AlertIntent(NamedTuple):
    """"An alert should exist for this" — the caller persists it.

    `dedupe_key` is what makes a recurring condition one alert instead of one
    per assessment. It is scoped by account + policy + subject, so two accounts
    with the same problem get their own alerts and one account's fix does not
    close the other's.
    """

    dedupe_key: str
    policy_id: Optional[str]
    policy_name: str
    severity: str
    title: str
    details: str
    # The finding this alert is about, when it is about exactly one. Threshold
    # kinds that aggregate (count, percentage, score) have no single finding and
    # carry the matched set in context instead.
    finding_fingerprint: Optional[str]
    resource_name: Optional[str]
    resource_type: Optional[str]
    resource_id: Optional[str]
    context: Dict[str, Any]
    notify: bool
    cooldown_minutes: int


def _f(finding, name, default=None):
    """Read a field from either an ORM row or a plain dict."""
    if isinstance(finding, dict):
        return finding.get(name, default)
    return getattr(finding, name, default)


def _matches(policy, finding) -> bool:
    """Whether a policy's selectors match a finding.

    Every selector is AND-ed, and an empty selector means "don't care". So the
    default `{}` policy matches everything, and each populated field narrows.
    """
    verdicts = policy.match_verdicts or [VULNERABLE]
    if _f(finding, "verdict") not in verdicts:
        return False
    if _f(finding, "status") not in ACTIVE_FINDING_STATUSES:
        return False

    if policy.providers and _f(finding, "provider") not in policy.providers:
        return False
    if policy.rule_ids and _f(finding, "rule_id") not in policy.rule_ids:
        return False
    if policy.categories and _f(finding, "category") not in policy.categories:
        return False
    if policy.resource_types and _f(finding, "resource_type") not in policy.resource_types:
        return False
    if policy.min_severity:
        if severity_rank(_f(finding, "severity")) > severity_rank(policy.min_severity):
            return False
    if policy.ports:
        port = _finding_port(finding)
        if port is None or port not in policy.ports:
            return False
    return True


def _finding_port(finding) -> Optional[int]:
    """The port an exposure finding is about, from its evidence.

    Read out of evidence rather than parsed from the title: a title is
    presentation and changes; evidence is the data the verdict was derived from.
    """
    ev = _f(finding, "evidence") or {}
    port_block = ev.get("port")
    if isinstance(port_block, dict):
        p = port_block.get("port")
        return int(p) if isinstance(p, int) else None
    return None


def _age_hours(finding, now: datetime) -> Optional[float]:
    first = _f(finding, "first_detected_at")
    if not isinstance(first, datetime):
        return None
    if first.tzinfo is None:
        first = first.replace(tzinfo=timezone.utc)
    return (now - first).total_seconds() / 3600.0


def evaluate(
    *,
    policies: Sequence[Any],
    findings: Sequence[Any],
    account_id: str,
    account_name: Optional[str] = None,
    provider: Optional[str] = None,
    score: Optional[int] = None,
    resource_counts: Optional[Dict[str, int]] = None,
    newly_opened: Optional[Set[str]] = None,
    now: Optional[datetime] = None,
) -> List[AlertIntent]:
    """Which alerts should exist right now, given these findings.

    Returns an intent for every condition that is true RIGHT NOW, not only for
    the ones that just became true. That distinction is what makes
    auto-resolution safe: the caller closes alerts whose condition is absent
    from the returned set, so an intent list that omitted persisting conditions
    would read as "everything was fixed".

    `newly_opened` is the set of fingerprints this assessment opened for the
    first time (or reopened). It is recorded on the intent for context; whether
    to *notify* is decided separately by `should_notify`.
    """
    now = now or datetime.now(timezone.utc)
    newly_opened = newly_opened or set()
    intents: List[AlertIntent] = []
    acct_label = account_name or account_id
    by_policy = {str(p.id): p for p in policies}

    for policy in policies:
        if not policy.enabled:
            continue
        if policy.account_id is not None and str(policy.account_id) != str(account_id):
            continue
        if policy.threshold_kind not in THRESHOLD_KINDS:
            logger.warning("Policy %s has unknown threshold kind %r; skipping.",
                           policy.name, policy.threshold_kind)
            continue

        # The score threshold is about the account, not about any finding.
        if policy.threshold_kind == THRESHOLD_SCORE_BELOW:
            if score is None or score >= policy.threshold_value:
                continue
            intents.append(AlertIntent(
                dedupe_key=f"POLICY:{policy.policy_key or policy.id}:{account_id}",
                policy_id=str(policy.id), policy_name=policy.name,
                severity=policy.alert_severity or HIGH,
                title=policy.name,
                details=(f"[{acct_label}] Security score is {score}, below the configured "
                         f"threshold of {policy.threshold_value:g}."),
                finding_fingerprint=None, resource_name=None, resource_type=None,
                resource_id=None,
                context={"score": score, "threshold": policy.threshold_value,
                         "policy": policy.name},
                notify=policy.notify, cooldown_minutes=policy.cooldown_minutes,
            ))
            continue

        matched = [f for f in findings if _matches(policy, f)]
        if not matched:
            continue

        kind = policy.threshold_kind
        threshold = policy.threshold_value

        # ── Per-finding thresholds: one alert per finding ────────────────────
        if kind in (THRESHOLD_ANY_NEW, THRESHOLD_SEVERITY, THRESHOLD_CONSECUTIVE,
                    THRESHOLD_DURATION):
            for f in matched:
                fp = _f(f, "fingerprint")
                # THRESHOLD_ANY_NEW deliberately does NOT gate on newly_opened
                # here. It describes when to START alerting, not how long the
                # alert should exist — and the caller resolves alerts whose
                # condition is absent from a complete run. Gating intent
                # creation on "new" made the second assessment produce no
                # intents at all, so every one of the 160 alerts from the first
                # run was auto-resolved as though the problems had been fixed.
                # `should_notify(just_opened=...)` is what keeps a persisting
                # condition from re-notifying.
                if kind == THRESHOLD_CONSECUTIVE:
                    if (_f(f, "detection_count") or 1) < threshold:
                        continue
                if kind == THRESHOLD_DURATION:
                    age = _age_hours(f, now)
                    if age is None or age < threshold:
                        continue
                intents.append(_finding_intent(policy, f, acct_label, now, kind,
                                               threshold, newly_opened))
            continue

        # ── Aggregate thresholds: one alert for the whole condition ─────────
        if kind == THRESHOLD_FINDING_COUNT:
            actual, unit = len(matched), "finding(s)"
        elif kind == THRESHOLD_RESOURCE_COUNT:
            actual = len({_f(f, "resource_key") or _f(f, "resource_id") or
                          _f(f, "fingerprint") for f in matched})
            unit = "resource(s)"
        elif kind == THRESHOLD_PERCENTAGE:
            affected = len({_f(f, "resource_key") or _f(f, "resource_id") for f in matched})
            total = _population(policy, resource_counts)
            if not total:
                # No denominator means no percentage. Reporting 100% because the
                # count is unknown would be an invented statistic.
                continue
            actual = round(100.0 * affected / total, 1)
            unit = f"% of {total} resource(s)"
        else:
            continue

        if actual < threshold:
            continue

        worst = min((_f(f, "severity") for f in matched), key=severity_rank)
        intents.append(AlertIntent(
            dedupe_key=f"POLICY:{policy.policy_key or policy.id}:{account_id}",
            policy_id=str(policy.id), policy_name=policy.name,
            severity=policy.alert_severity or worst,
            title=policy.name,
            details=(f"[{acct_label}] {actual}{'' if unit.startswith('%') else ' '}{unit} "
                     f"match '{policy.name}', at or above the threshold of "
                     f"{threshold:g}. Worst severity: {worst}."),
            finding_fingerprint=None,
            resource_name=None, resource_type=None, resource_id=None,
            context={
                "policy": policy.name, "threshold_kind": kind,
                "threshold": threshold, "actual": actual,
                "matched_count": len(matched),
                "worst_severity": worst,
                "sample": [
                    {"fingerprint": _f(f, "fingerprint"),
                     "title": _f(f, "title"),
                     "resource_name": _f(f, "resource_name"),
                     "severity": _f(f, "severity")}
                    for f in matched[:20]
                ],
            },
            notify=policy.notify, cooldown_minutes=policy.cooldown_minutes,
        ))

    return _dedupe_per_finding(intents, by_policy)


def specificity(policy) -> int:
    """How narrowly a policy is targeted. Higher wins a per-finding contest.

    Exists because the built-in policies deliberately overlap. "New critical
    security finding" is a catch-all whose job is that nothing critical is ever
    silent, while "Internet-reachable RDP" says something specific about a
    specific port. A world-open RDP finding matches both, and on the first live
    run that produced two alerts for one problem — same resource, same evidence,
    two rows to acknowledge.

    Counting populated selectors rather than using a hand-assigned priority
    keeps this true for policies a user creates later, without asking them to
    reason about a precedence number.
    """
    score = 0
    for attr in ("rule_ids", "categories", "resource_types", "providers", "ports",
                 "match_verdicts"):
        values = getattr(policy, attr, None)
        if values:
            # A tighter list is more specific: naming one rule beats naming ten.
            score += 10 + max(0, 5 - len(values))
    if getattr(policy, "min_severity", None):
        score += 3
    if getattr(policy, "account_id", None):
        # An account-scoped policy is a deliberate local override and should win
        # over a global default.
        score += 20
    return score


def _dedupe_per_finding(intents: List[AlertIntent],
                        by_policy: Dict[str, Any]) -> List[AlertIntent]:
    """At most one alert per finding, from the most specific matching policy.

    Aggregate intents (count / percentage / score thresholds) have no single
    finding and pass through untouched — they are statements about the account,
    not about one resource, and collapsing them would lose them.
    """
    best: Dict[str, AlertIntent] = {}
    passthrough: List[AlertIntent] = []
    for intent in intents:
        if not intent.finding_fingerprint:
            passthrough.append(intent)
            continue
        fp = intent.finding_fingerprint
        current = best.get(fp)
        if current is None:
            best[fp] = intent
            continue
        a = specificity(by_policy.get(intent.policy_id))
        b = specificity(by_policy.get(current.policy_id))
        if a > b or (a == b and severity_rank(intent.severity)
                     < severity_rank(current.severity)):
            best[fp] = intent
    return passthrough + list(best.values())


def _population(policy, resource_counts: Optional[Dict[str, int]]) -> int:
    """Denominator for a percentage threshold: the count of resources the policy
    is scoped to, or all resources when it names no type."""
    if not resource_counts:
        return 0
    if policy.resource_types:
        return sum(resource_counts.get(t, 0) for t in policy.resource_types)
    return sum(resource_counts.values())


def _finding_intent(policy, f, acct_label: str, now: datetime,
                    kind: str, threshold: float,
                    newly_opened: Optional[Set[str]] = None) -> AlertIntent:
    fp = _f(f, "fingerprint")
    reason = {
        THRESHOLD_ANY_NEW: "newly detected",
        THRESHOLD_SEVERITY: f"at or above {policy.min_severity or 'the configured severity'}",
        THRESHOLD_CONSECUTIVE: (f"seen in {_f(f, 'detection_count')} consecutive "
                                f"assessments (threshold {threshold:g})"),
        THRESHOLD_DURATION: (f"open for {(_age_hours(f, now) or 0):.0f}h "
                             f"(threshold {threshold:g}h)"),
    }.get(kind, kind)

    port = _finding_port(f)
    return AlertIntent(
        # Per-finding dedupe: the policy AND the finding, so the same finding
        # under two policies produces two alerts (they may have different
        # audiences) but one policy never produces two for one finding.
        dedupe_key=f"POLICY:{policy.policy_key or policy.id}:{fp}",
        policy_id=str(policy.id), policy_name=policy.name,
        severity=policy.alert_severity or _f(f, "severity") or MEDIUM,
        title=f"{policy.name}: {_f(f, 'title')}",
        details=(f"[{acct_label}] {_f(f, 'title')}"
                 + (f" on {_f(f, 'resource_name')}" if _f(f, "resource_name") else "")
                 + f" — {reason}. {(_f(f, 'description') or '')[:400]}"),
        finding_fingerprint=fp,
        resource_name=_f(f, "resource_name"),
        resource_type=_f(f, "resource_type"),
        resource_id=(str(_f(f, "resource_id")) if _f(f, "resource_id") else None),
        context={
            "policy": policy.name,
            "threshold_kind": kind,
            "threshold": threshold,
            "rule_id": _f(f, "rule_id"),
            "rule_version": _f(f, "rule_version"),
            "finding_fingerprint": fp,
            "severity": _f(f, "severity"),
            "category": _f(f, "category"),
            "confidence": _f(f, "confidence"),
            "resource_key": _f(f, "resource_key"),
            "port": port,
            "compliance": _f(f, "compliance"),
            "first_detected_at": (_f(f, "first_detected_at").isoformat()
                                  if isinstance(_f(f, "first_detected_at"), datetime)
                                  else None),
            "detection_count": _f(f, "detection_count"),
            "newly_opened_this_run": fp in (newly_opened or set()),
        },
        notify=policy.notify, cooldown_minutes=policy.cooldown_minutes,
    )


def should_notify(alert, intent: AlertIntent, *, just_opened: bool,
                  now: Optional[datetime] = None) -> bool:
    """Whether to send a notification, as opposed to merely recording the alert.

    Sends on the two transitions that carry information — first open, and
    reopen after a resolve — plus a severity escalation. Everything else is a
    recurrence, and a recurrence is what turns a monitoring tool into a mail
    filter rule. §34.
    """
    if not intent.notify:
        return False
    if just_opened:
        return True
    now = now or datetime.now(timezone.utc)

    # Escalation is news even mid-alert: MEDIUM becoming CRITICAL means the
    # situation changed, and silently overwriting the severity would hide it.
    prev = getattr(alert, "severity", None)
    if prev and severity_rank(intent.severity) < severity_rank(prev):
        return True

    last = getattr(alert, "last_notified_at", None) or getattr(alert, "created_at", None)
    if not isinstance(last, datetime):
        return False
    if last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)
    return (now - last) >= timedelta(minutes=max(1, intent.cooldown_minutes))


# ═════════════════════════════════════════════════════════════════════════════
# Built-in default policies (§28)
# ═════════════════════════════════════════════════════════════════════════════
#
# Seeded on startup, keyed by `policy_key` so a redeploy updates rather than
# duplicates. An operator may disable or retune any of them; only the fields
# they have not touched are refreshed (see the repository's seed method).
#
# They are account-agnostic (`account_id=None`) on purpose: a newly onboarded
# account is covered from its first scan, rather than from whenever someone
# remembers to create policies for it.

DEFAULT_POLICIES: List[Dict[str, Any]] = [
    {
        "policy_key": "critical_finding",
        "name": "New critical security finding",
        "description": ("Any newly detected CRITICAL finding, whatever its category. The "
                        "catch-all that guarantees nothing critical is silent."),
        "min_severity": CRITICAL,
        "threshold_kind": THRESHOLD_ANY_NEW,
        "threshold_value": 1,
        "alert_severity": CRITICAL,
        "cooldown_minutes": 60,
    },
    {
        "policy_key": "public_rdp",
        "name": "Internet-reachable RDP",
        "description": ("A resource with a public address permits TCP/3389 from the whole "
                        "internet. Public RDP is the most common initial-access vector in "
                        "ransomware incident reports."),
        "categories": [CAT_EXPOSURE],
        "ports": sorted(portcat.RDP_PORTS),
        "threshold_kind": THRESHOLD_ANY_NEW,
        "threshold_value": 1,
        "alert_severity": CRITICAL,
        "cooldown_minutes": 60,
    },
    {
        "policy_key": "public_ssh",
        "name": "Internet-reachable SSH",
        "description": ("A resource with a public address permits TCP/22 from the whole "
                        "internet."),
        "categories": [CAT_EXPOSURE],
        "ports": sorted(portcat.SSH_PORTS),
        "threshold_kind": THRESHOLD_ANY_NEW,
        "threshold_value": 1,
        "alert_severity": HIGH,
        "cooldown_minutes": 120,
    },
    {
        "policy_key": "public_database",
        "name": "Internet-reachable database",
        "description": ("A database or data-store port is reachable from the whole "
                        "internet. The worst class of exposure: these services answer "
                        "queries, so no further exploit is needed."),
        "categories": [CAT_EXPOSURE],
        "ports": sorted(portcat.DATA_PORTS),
        "threshold_kind": THRESHOLD_ANY_NEW,
        "threshold_value": 1,
        "alert_severity": CRITICAL,
        "cooldown_minutes": 30,
    },
    {
        "policy_key": "all_ports_open",
        "name": "All ports open to the internet",
        "description": "A rule opens every port, or every protocol, from 0.0.0.0/0.",
        "rule_ids": ["EXPOSURE_ALL_PORTS_WORLD_OPEN"],
        "threshold_kind": THRESHOLD_ANY_NEW,
        "threshold_value": 1,
        "alert_severity": CRITICAL,
        "cooldown_minutes": 60,
    },
    {
        "policy_key": "iam_escalation",
        "name": "Privilege escalation path",
        "description": ("An identity can grant itself further access. Distinct from broad "
                        "access: escalation is unbounded, so every other limit on that "
                        "identity is advisory."),
        "rule_ids": ["AWS_IAM_ROLE_ESCALATION", "OCI_IAM_POLICY_ESCALATION",
                     "AZURE_RBAC_ESCALATION"],
        "threshold_kind": THRESHOLD_ANY_NEW,
        "threshold_value": 1,
        "alert_severity": CRITICAL,
        "cooldown_minutes": 60,
    },
    {
        "policy_key": "tenancy_wide_admin",
        "name": "Tenancy-wide or subscription-wide administrator",
        "description": ("A principal holds full control over an entire subscription, "
                        "account or tenancy."),
        "rule_ids": ["OCI_IAM_POLICY_TENANCY_ADMIN", "AZURE_RBAC_SUBSCRIPTION_OWNER",
                     "AWS_IAM_ROLE_WILDCARD_FULL"],
        "threshold_kind": THRESHOLD_ANY_NEW,
        "threshold_value": 1,
        "alert_severity": CRITICAL,
        "cooldown_minutes": 120,
    },
    {
        "policy_key": "encryption_disabled",
        "name": "Encryption at rest disabled",
        "description": ("A database or storage resource stores data without encryption at "
                        "rest."),
        "categories": [CAT_ENCRYPTION],
        "min_severity": HIGH,
        "threshold_kind": THRESHOLD_ANY_NEW,
        "threshold_value": 1,
        "alert_severity": HIGH,
        "cooldown_minutes": 240,
    },
    {
        "policy_key": "public_storage",
        "name": "Publicly accessible storage",
        "description": ("A bucket or storage account permits anonymous access, or does not "
                        "block it."),
        "rule_ids": ["AWS_S3_PUBLIC_ACCESS_NOT_BLOCKED", "OCI_BUCKET_PUBLIC_ACCESS",
                     "AZURE_STORAGE_BLOB_PUBLIC_ACCESS"],
        "threshold_kind": THRESHOLD_ANY_NEW,
        "threshold_value": 1,
        "alert_severity": CRITICAL,
        "cooldown_minutes": 120,
    },
    {
        "policy_key": "exposure_volume",
        "name": "Multiple internet-exposed resources",
        "description": ("Five or more distinct resources are internet-reachable on a "
                        "non-web port. Catches a systemic misconfiguration that "
                        "per-finding policies would report as many small problems."),
        "categories": [CAT_EXPOSURE],
        "threshold_kind": THRESHOLD_RESOURCE_COUNT,
        "threshold_value": 5,
        "alert_severity": HIGH,
        "cooldown_minutes": 720,
    },
    {
        "policy_key": "critical_unresolved_24h",
        "name": "Critical finding unresolved for 24 hours",
        "description": ("A CRITICAL finding has been open for more than a day. The "
                        "follow-up to the initial alert, for when the first one was "
                        "missed."),
        "min_severity": CRITICAL,
        "threshold_kind": THRESHOLD_DURATION,
        "threshold_value": 24,
        "alert_severity": HIGH,
        "cooldown_minutes": 1440,
    },
    {
        "policy_key": "score_below_70",
        "name": "Security score below 70",
        "description": ("The account's overall score has fallen below 70. Only fires when "
                        "the score is reliable — an account with too little coverage to "
                        "score has no number to compare, and alerting on that would be "
                        "alerting on a scanner problem under a security label."),
        "threshold_kind": THRESHOLD_SCORE_BELOW,
        "threshold_value": 70,
        "alert_severity": HIGH,
        "cooldown_minutes": 1440,
    },
    {
        "policy_key": "exposure_undetermined",
        "name": "Internet exposure could not be determined",
        "description": ("An internet-facing resource could not be evaluated. Deliberately "
                        "separate from the confirmed-exposure policies and at MEDIUM: "
                        "this is a collection or permission problem, which usually needs a "
                        "different person than a firewall change."),
        "rule_ids": ["EXPOSURE_UNDETERMINED"],
        "match_verdicts": ["UNKNOWN"],
        "threshold_kind": THRESHOLD_ANY_NEW,
        "threshold_value": 1,
        "alert_severity": MEDIUM,
        "cooldown_minutes": 1440,
    },
]


def _selfcheck() -> None:
    problems: List[str] = []
    keys = set()
    for p in DEFAULT_POLICIES:
        key = p.get("policy_key")
        if not key:
            problems.append(f"default policy {p.get('name')!r} has no policy_key")
        elif key in keys:
            problems.append(f"duplicate policy_key {key!r}")
        keys.add(key)
        if p["threshold_kind"] not in THRESHOLD_KINDS:
            problems.append(f"{key}: unknown threshold kind {p['threshold_kind']!r}")
        if not (p.get("description") or "").strip():
            problems.append(f"{key}: no description")
        # Every rule_id a default policy names must exist, or the policy is a
        # no-op that looks configured.
        from app.security.registry import RULES
        for rid in p.get("rule_ids") or []:
            if rid not in RULES:
                problems.append(f"{key}: names unknown rule_id {rid!r}")
    if problems:
        raise RuntimeError(
            "Default alert policies are inconsistent:\n  - " + "\n  - ".join(problems))


_selfcheck()
