"""Dormant identities and credential age.

Two questions that look like one and are not:

*   **Is this principal still in use?** Answered from last-used metadata the
    provider reports, corroborated by the Event Log.
*   **Is this credential still in use?** A principal can be busy while one of
    its three access keys has never been touched, and the stale key is the
    finding.

The governing rule, from §8 and §35, is the same for both:

    Do not classify something as dormant if the provider does not expose
    sufficient last-used information.

So `DORMANCY_UNKNOWN` is a first-class answer and is returned far more often
than one might like — Azure in particular reports no last-sign-in for a service
principal without Entra ID P1 and a Graph permission this platform usually does
not hold. Reporting those as dormant would produce a list of hundreds of
"unused" service principals that are in fact running production, and the first
person to act on it would cause an outage. Reporting them as UNKNOWN produces a
coverage gap with a named permission to fix it, which is true and actionable.

**Never-used is a provider assertion, not our inference.** AWS states that an
access key has never been used by returning no `LastUsedDate`; that is
`DORMANCY_NEVER_USED`. A key whose last-used date simply was not collected is
`DORMANCY_UNKNOWN`. Collapsing the two would turn a data gap into a deletion
recommendation.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Sequence, Tuple

from app.identity.model import (
    ACTOR_GROUP, ACTOR_HUMAN, ACTOR_WORKLOAD, CRED_ACTIVE, CRED_EXPIRED, CRED_INACTIVE,
    DEFAULT_DORMANT_DAYS, DORMANCY_ACTIVE, DORMANCY_DORMANT, DORMANCY_NEVER_USED,
    DORMANCY_UNKNOWN, MFA_DISABLED, MFA_ENABLED, MFA_NOT_APPLICABLE, MFA_UNKNOWN,
    PRIV_ADMIN, PRIV_PRIVILEGED, RECO_DELETE, RECO_DISABLE, RECO_INVESTIGATE,
    RECO_NONE, RECO_ROTATE, days_between,
)

# Credential age thresholds, in days. Not a security verdict on their own — a
# 400-day-old key that is actively used is an operational risk, not a breach —
# so they feed a recommendation, never a severity directly.
KEY_AGE_WARN_DAYS = 90
KEY_AGE_HIGH_DAYS = 365
KEY_UNUSED_WARN_DAYS = 30
KEY_UNUSED_HIGH_DAYS = 90


@dataclass
class DormancyVerdict:
    """Why a principal or credential was called dormant, active or unknown."""

    state: str
    days_since_use: Optional[int] = None
    last_used_at: Optional[datetime] = None
    source: Optional[str] = None
    threshold_days: int = DEFAULT_DORMANT_DAYS
    reason: str = ""
    evidence: Dict[str, Any] = None  # type: ignore[assignment]

    def to_dict(self) -> Dict[str, Any]:
        return {
            "state": self.state,
            "days_since_use": self.days_since_use,
            "last_used_at": self.last_used_at.isoformat() if self.last_used_at else None,
            "source": self.source,
            "threshold_days": self.threshold_days,
            "reason": self.reason,
            "evidence": self.evidence or {},
        }


def assess_identity(
    *,
    actor_class: str,
    last_used_at: Optional[datetime],
    last_used_source: Optional[str],
    provider_reports_last_used: bool,
    event_last_seen: Optional[datetime] = None,
    event_log_covers_identity: bool = True,
    created_at: Optional[datetime] = None,
    threshold_days: int = DEFAULT_DORMANT_DAYS,
    now: Optional[datetime] = None,
) -> DormancyVerdict:
    """Is this principal dormant?

    `provider_reports_last_used` is the switch that keeps this honest. When the
    provider has no last-used concept for this identity type, no amount of
    silence in our own event log makes "dormant" a safe claim — the principal
    may be used through a path we do not collect.
    """
    moment = now or datetime.now(timezone.utc)

    if actor_class == ACTOR_GROUP:
        return DormancyVerdict(
            state=DORMANCY_UNKNOWN, threshold_days=threshold_days,
            reason="A group is a container. Its own last-used date is not a "
                   "meaningful signal; assess its members instead.",
        )

    # The best evidence available, preferring the provider's own statement.
    best = last_used_at
    source = last_used_source or ("provider" if last_used_at else None)
    if event_last_seen and (best is None or event_last_seen > best):
        best, source = event_last_seen, "event log"

    if best is None:
        if provider_reports_last_used and event_log_covers_identity:
            # Both sources work and neither has ever seen it used.
            return DormancyVerdict(
                state=DORMANCY_NEVER_USED, threshold_days=threshold_days,
                source="provider + event log",
                reason="The provider reports no last-used date and no event for this "
                       "principal appears in the collected audit trail.",
                evidence={"created_at": created_at.isoformat() if created_at else None},
            )
        missing = []
        if not provider_reports_last_used:
            missing.append("the provider does not report a last-used date for this "
                           "identity type")
        if not event_log_covers_identity:
            missing.append("the audit trail for this account does not cover this "
                           "principal")
        return DormancyVerdict(
            state=DORMANCY_UNKNOWN, threshold_days=threshold_days,
            reason="Cannot determine: " + "; ".join(missing) + ".",
        )

    days = days_between(best, moment)
    if days is not None and days >= threshold_days:
        return DormancyVerdict(
            state=DORMANCY_DORMANT, days_since_use=days, last_used_at=best,
            source=source, threshold_days=threshold_days,
            reason=f"Last used {days} days ago, which exceeds the {threshold_days}-day "
                   f"threshold.",
        )
    return DormancyVerdict(
        state=DORMANCY_ACTIVE, days_since_use=days, last_used_at=best, source=source,
        threshold_days=threshold_days,
        reason=f"Used {days} days ago." if days is not None else "Recently used.",
    )


def assess_credential(
    *,
    credential_kind: str,
    status: str,
    created_at: Optional[datetime],
    last_used_at: Optional[datetime],
    never_used: Optional[bool],
    expires_at: Optional[datetime] = None,
    sibling_active_count: int = 1,
    identity_privilege: Optional[str] = None,
    now: Optional[datetime] = None,
) -> Dict[str, Any]:
    """Age, usage and a disposition for one credential.

    The disposition is advisory. Nothing in this platform acts on it without an
    explicit approval, which is why DELETE can be recommended at all — the
    recommendation and the act are separated by a workflow (§30).
    """
    moment = now or datetime.now(timezone.utc)
    age_days = days_between(created_at, moment)
    unused_days = days_between(last_used_at, moment)

    signals: List[str] = []
    recommendation = RECO_NONE
    reason_parts: List[str] = []

    inactive = (status or "").upper() in (CRED_INACTIVE, "INACTIVE", "DISABLED")
    expired = bool(expires_at and expires_at < moment)

    if expired:
        signals.append("EXPIRED")
        recommendation = RECO_DELETE
        reason_parts.append("The credential has passed its expiry date.")

    if never_used is True:
        signals.append("NEVER_USED")
        if age_days is not None and age_days >= KEY_UNUSED_WARN_DAYS:
            recommendation = RECO_DELETE if not inactive else RECO_DELETE
            reason_parts.append(
                f"Created {age_days} days ago and the provider reports it has never "
                "been used."
            )
        else:
            reason_parts.append(
                "The provider reports it has never been used, but it is recent enough "
                "that it may not have been deployed yet."
            )
            recommendation = RECO_NONE
    elif last_used_at is None:
        # No last-used date AND the provider did not say "never". Unknown.
        signals.append("LAST_USE_UNKNOWN")
        reason_parts.append(
            "No last-used date is available for this credential, so its activity "
            "cannot be assessed."
        )
        recommendation = RECO_INVESTIGATE
    elif unused_days is not None:
        if unused_days >= KEY_UNUSED_HIGH_DAYS:
            signals.append(f"UNUSED_{KEY_UNUSED_HIGH_DAYS}D")
            recommendation = RECO_DISABLE
            reason_parts.append(f"Not used in {unused_days} days.")
        elif unused_days >= KEY_UNUSED_WARN_DAYS:
            signals.append(f"UNUSED_{KEY_UNUSED_WARN_DAYS}D")
            recommendation = RECO_ROTATE if recommendation == RECO_NONE else recommendation
            reason_parts.append(f"Not used in {unused_days} days.")

    if age_days is not None:
        if age_days >= KEY_AGE_HIGH_DAYS:
            signals.append("OLD_CREDENTIAL")
            if recommendation in (RECO_NONE,):
                recommendation = RECO_ROTATE
            reason_parts.append(f"It is {age_days} days old.")
        elif age_days >= KEY_AGE_WARN_DAYS:
            signals.append("ROTATION_DUE")
            if recommendation == RECO_NONE:
                recommendation = RECO_ROTATE
            reason_parts.append(f"It is {age_days} days old, past the "
                                f"{KEY_AGE_WARN_DAYS}-day rotation point.")

    if sibling_active_count > 1:
        signals.append("MULTIPLE_ACTIVE_KEYS")
        reason_parts.append(
            f"The identity has {sibling_active_count} active credentials of this kind; "
            "more than one active key at a time usually means a rotation was started "
            "and not finished."
        )

    if inactive and recommendation in (RECO_ROTATE, RECO_DISABLE):
        recommendation = RECO_DELETE
        reason_parts.append("It is already disabled, so removing it costs nothing.")

    if identity_privilege in (PRIV_ADMIN, PRIV_PRIVILEGED) and signals:
        reason_parts.append(
            "The identity holding it has privileged permissions, so a stale credential "
            "here is a larger exposure than the age alone suggests."
        )

    return {
        "credential_kind": credential_kind,
        "status": status,
        "age_days": age_days,
        "unused_days": unused_days,
        "never_used": never_used,
        "expired": expired,
        "signals": signals,
        "recommendation": recommendation,
        "recommendation_reason": " ".join(reason_parts) or None,
        # Stated so the UI never renders an age as 0 when it is simply unknown.
        "age_known": age_days is not None,
        "last_use_known": last_used_at is not None or never_used is True,
    }


def assess_mfa(
    *,
    actor_class: str,
    provider_reports_mfa: bool,
    mfa_devices: Optional[Sequence[Any]] = None,
    mfa_enabled: Optional[bool] = None,
) -> Tuple[str, Dict[str, Any]]:
    """The MFA state for a principal, and the evidence behind it (§10).

    A workload is NOT_APPLICABLE, never "disabled". That single distinction is
    what keeps the MFA gap list short enough to act on.
    """
    if actor_class in (ACTOR_WORKLOAD, ACTOR_GROUP):
        return MFA_NOT_APPLICABLE, {
            "reason": "This is a workload identity; it has no interactive sign-in, so "
                      "multi-factor authentication does not apply to it.",
        }
    if not provider_reports_mfa:
        return MFA_UNKNOWN, {
            "reason": "The provider did not report MFA registration for this identity. "
                      "This is a data gap, not a finding.",
        }
    if mfa_enabled is True or (mfa_devices and len(mfa_devices) > 0):
        return MFA_ENABLED, {
            "device_count": len(mfa_devices) if mfa_devices else None,
            "reason": "At least one MFA device is registered.",
        }
    if mfa_enabled is False or mfa_devices == []:
        return MFA_DISABLED, {
            "device_count": 0,
            "reason": "The provider reports no registered MFA device for this identity.",
        }
    return MFA_UNKNOWN, {
        "reason": "MFA registration could not be determined for this identity.",
    }


# ── Break-glass detection (§11) ──────────────────────────────────────────────
# SHAPE, not designation. This platform cannot know that an account is the
# officially sanctioned emergency account, so everything here produces
# "potential", and the finding text says so.
BREAK_GLASS_NAME_HINTS = (
    "break-glass", "breakglass", "break_glass", "emergency", "firecall",
    "fire-call", "glassbreak", "root-recovery", "recovery-admin",
)


def break_glass_signals(
    *,
    name: Optional[str],
    privilege_level: Optional[str],
    dormancy: Optional[str],
    mfa_state: Optional[str],
    actor_class: str,
    credential_count: int = 0,
) -> Tuple[bool, List[Dict[str, str]]]:
    """Does this principal look like an emergency-access account?

    Returns `(potential, signals)`. A single name hint is not enough on its
    own — plenty of accounts are called `emergency-deploy` and are used daily —
    so the shape has to agree: administrative, human, and rarely or never used.
    """
    signals: List[Dict[str, str]] = []
    lowered = (name or "").lower()

    name_hit = any(hint in lowered for hint in BREAK_GLASS_NAME_HINTS)
    if name_hit:
        signals.append({
            "signal": "NAME",
            "detail": f"The name {name!r} matches a common emergency-account convention.",
        })

    admin = privilege_level in (PRIV_ADMIN,)
    if admin:
        signals.append({
            "signal": "ADMINISTRATIVE",
            "detail": "It holds administrative permissions.",
        })

    unused = dormancy in (DORMANCY_DORMANT, DORMANCY_NEVER_USED)
    if unused:
        signals.append({
            "signal": "RARELY_USED",
            "detail": "It is dormant or has never been used, which is the expected "
                      "pattern for an account reserved for emergencies.",
        })

    potential = bool(name_hit and admin) or bool(admin and unused and
                                                 actor_class == ACTOR_HUMAN)
    if potential and mfa_state == MFA_DISABLED:
        signals.append({
            "signal": "NO_MFA",
            "detail": "No MFA is registered. An emergency account is the one that most "
                      "needs it, because it is the one used under pressure.",
        })
    if potential and credential_count:
        signals.append({
            "signal": "HAS_LONG_LIVED_CREDENTIAL",
            "detail": f"It holds {credential_count} long-lived credential(s). An "
                      "emergency account that can be used without an interactive "
                      "sign-in is harder to monitor.",
        })
    return potential, signals


def recommended_break_glass_controls() -> List[Dict[str, str]]:
    """The controls §11 asks to be shown beside a potential emergency account."""
    return [
        {"control": "MFA", "why": "It is used under pressure, which is when a stolen "
                                  "password is most likely to be used too."},
        {"control": "Alert on every use", "why": "Use should be rare and always "
                                                 "deliberate, so each one is worth a page."},
        {"control": "Documented ownership", "why": "Someone must be accountable for a "
                                                   "standing administrative credential."},
        {"control": "Restricted use policy", "why": "A written trigger condition stops "
                                                    "it becoming a convenience account."},
        {"control": "Periodic verification", "why": "An emergency credential that does "
                                                    "not work in the emergency is worse "
                                                    "than none."},
        {"control": "No long-lived API credential", "why": "An interactive-only account "
                                                           "cannot be used silently by "
                                                           "automation."},
    ]
