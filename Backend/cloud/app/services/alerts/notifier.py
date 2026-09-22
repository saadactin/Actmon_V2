"""Turning a fired alert into a queued email — and being honest about whether
it can be.

This module closes the gap that made cloud alerting silent. The database
service already owns a complete notification pipeline: an SMTP config
(`smtp_configs`), a channel registry (`notification_channels`), a durable queue
with exponential-backoff retries (`notification_queue` + its dispatcher
thread), and a delivery ledger (`notification_history`). None of it needed
rebuilding. What was missing was a *recipient*: `send_via_channel` takes the
address list "ENTIRELY from the firing alert rule's own To/Cc/Bcc — there is no
org-wide default recipient", and a cloud alert had no such field. So
`notification_bridge` dropped the email channel rather than queue a row that
could only fail three times and give up.

`CloudAlertRule.notification_config` and `cloud_alert_recipients` are that
missing field. With them, a cloud alert can supply `recipients_override` on the
queue payload — a key the dispatcher already reads — and email works with no
change to the retry, encryption, history or settings machinery.

**Queued is not delivered.** Everything here reports "queued", never "sent".
The alert's `notification_status` says QUEUED; the dispatcher later writes the
real outcome to `notification_history`, and that is the only place the word
"sent" is earned. The UI shows both, because an alert that fired correctly and
an email that failed to leave the building is a real and common state.
"""
from __future__ import annotations

import json
import logging
import re
from datetime import datetime
from typing import Any, Dict, List, Optional, Sequence, Tuple

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.services.alerts import templates

logger = logging.getLogger("cloud_svc.alerts.notify")

# This deployment is single-tenant per instance — the cloud service has no org
# concept at all — so org_id is always 1, matching the default every DB-side
# model falls back to. Same constant, same reasoning, as notification_bridge.
ORG_ID = 1

# Deliberately permissive: the job here is to catch a typo like "ops@" or a
# stray space, not to re-derive RFC 5321. The SMTP server is the authority on
# whether an address exists, and its refusal is recorded in notification_history.
_EMAIL_RE = re.compile(r"^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]{2,}$")

# Notification lifecycle as this service records it on the alert row.
NOTIFY_QUEUED = "QUEUED"
NOTIFY_SKIPPED_COOLDOWN = "SKIPPED_COOLDOWN"
NOTIFY_SILENCED = "SILENCED"
# Held until quiet hours end — scheduled, not dropped.
NOTIFY_QUIET_HOURS = "QUIET_HOURS"
# Waiting to go out in the next digest, again not dropped.
NOTIFY_DIGEST_PENDING = "DIGEST_PENDING"
NOTIFY_NO_CHANNEL = "NO_CHANNEL"
NOTIFY_ESCALATED = "ESCALATED"
NOTIFY_NO_RECIPIENT = "NO_RECIPIENT"
NOTIFY_NOT_CONFIGURED = "NOT_CONFIGURED"
NOTIFY_CHANNEL_DISABLED = "CHANNEL_DISABLED"
NOTIFY_FAILED_TO_QUEUE = "FAILED_TO_QUEUE"


def valid_email(address: str) -> bool:
    return bool(_EMAIL_RE.match((address or "").strip()))


# ── Recipients ────────────────────────────────────────────────────────────────
async def account_recipients(db: AsyncSession, account_id) -> Dict[str, List[str]]:
    """The account's enabled default recipients, grouped by kind."""
    from sqlalchemy import select

    from app.models.alert_rule import CloudAlertRecipient

    rows = (await db.execute(
        select(CloudAlertRecipient).where(
            CloudAlertRecipient.account_id == account_id,
            CloudAlertRecipient.enabled.is_(True),
        )
    )).scalars().all()
    out: Dict[str, List[str]] = {"to": [], "cc": [], "bcc": []}
    for r in rows:
        out.setdefault(r.kind or "to", []).append(r.email)
    return out


async def resolve_recipients(db: AsyncSession, rule) -> Dict[str, Any]:
    """Who this rule's mail goes to, and where each address came from.

    Rule-level addresses and account defaults are UNIONED rather than one
    replacing the other, unless the rule opts out of defaults. The provenance
    is returned because "why did the finance team get a security alert" needs
    an answer that does not require reading the database by hand.
    """
    own = rule.recipients()
    defaults = (await account_recipients(db, rule.account_id)
                if rule.uses_account_defaults() else {"to": [], "cc": [], "bcc": []})

    merged: Dict[str, List[str]] = {}
    for kind in ("to", "cc", "bcc"):
        seen, combined = set(), []
        for address in list(own.get(kind) or []) + list(defaults.get(kind) or []):
            key = address.strip().lower()
            if key and key not in seen and valid_email(address):
                seen.add(key)
                combined.append(address.strip())
        merged[kind] = combined

    invalid = [
        a for kind in ("to", "cc", "bcc")
        for a in list(own.get(kind) or []) + list(defaults.get(kind) or [])
        if a and not valid_email(a)
    ]

    return {
        **merged,
        "total": sum(len(merged[k]) for k in ("to", "cc", "bcc")),
        "from_rule": own,
        "from_account_defaults": defaults,
        "uses_account_defaults": rule.uses_account_defaults(),
        # Surfaced rather than silently dropped: an address that will never
        # receive anything should be visible on the rule, not a mystery.
        "invalid": invalid,
    }


# ── Delivery readiness ────────────────────────────────────────────────────────
async def delivery_status(db: AsyncSession) -> Dict[str, Any]:
    """Can this installation send email at all, and if not, what is missing.

    Every link in the chain is checked separately and reported separately,
    because "email is not working" is four different problems with four
    different fixes. Read-only — this never enables anything on its own.
    """
    status: Dict[str, Any] = {
        "smtp_configured": False, "smtp": None,
        "channel_enabled": False, "dispatcher_table_present": True,
        "ready": False, "blockers": [],
    }

    try:
        row = (await db.execute(text(
            "SELECT id, name, smtp_host, smtp_port, smtp_tls, sender_email, "
            "       sender_name, is_default, last_test_at, last_test_ok, "
            "       last_test_msg "
            "FROM smtp_configs "
            "ORDER BY is_default DESC NULLS LAST, id ASC LIMIT 1"
        ))).mappings().first()
        if row:
            status["smtp_configured"] = True
            # Note what is NOT here: smtp_user and smtp_password. A username is
            # a credential half and the password is encrypted at rest; neither
            # has any business in an API response.
            status["smtp"] = {
                "name": row["name"], "host": row["smtp_host"],
                "port": row["smtp_port"], "tls": row["smtp_tls"],
                "sender_email": row["sender_email"],
                "sender_name": row["sender_name"],
                "is_default": row["is_default"],
                "last_test_at": _iso(row["last_test_at"]),
                "last_test_ok": row["last_test_ok"],
                "last_test_message": row["last_test_msg"],
            }
        else:
            status["blockers"].append({
                "code": "no_smtp_config",
                "message": "No SMTP server is configured. Add one in "
                           "Settings → Notifications → Email; without it nothing "
                           "can be delivered.",
            })
    except Exception as exc:  # noqa: BLE001
        logger.warning("Could not read smtp_configs: %s", exc)
        status["blockers"].append({
            "code": "smtp_unreadable",
            "message": f"The SMTP configuration table could not be read ({exc}).",
        })

    try:
        enabled = (await db.execute(text(
            "SELECT enabled FROM notification_channels "
            "WHERE org_id = :org AND channel_type = 'email'"
        ), {"org": ORG_ID})).scalar_one_or_none()
        status["channel_enabled"] = bool(enabled)
        if enabled is None:
            status["blockers"].append({
                "code": "channel_missing",
                "message": "The email delivery channel has never been switched "
                           "on. The dispatcher refuses any queued message whose "
                           "channel is not enabled, so alerts would queue and "
                           "then fail.",
                "fixable_here": True,
            })
        elif not enabled:
            status["blockers"].append({
                "code": "channel_disabled",
                "message": "The email delivery channel is switched off, so "
                           "queued alerts will be failed by the dispatcher "
                           "rather than sent.",
                "fixable_here": True,
            })
    except Exception as exc:  # noqa: BLE001
        logger.warning("Could not read notification_channels: %s", exc)
        status["dispatcher_table_present"] = False
        status["blockers"].append({
            "code": "channel_table_missing",
            "message": ("The notification tables owned by the database service "
                        f"could not be read ({exc}). Alert email is delivered by "
                        "that service, so it must be running against the same "
                        "database."),
        })

    status["ready"] = (status["smtp_configured"] and status["channel_enabled"]
                       and status["dispatcher_table_present"])
    return status


async def enable_email_channel(db: AsyncSession, actor: Optional[str]) -> Dict[str, Any]:
    """Switch on the shared email channel, creating its row if absent.

    This writes to a table the database service owns, which is the same thing
    `notification_bridge` already does when it queues. It is exposed because
    the alternative is an Alerts page that can describe the blockage and not
    clear it, and because the row it creates is exactly what Settings →
    Notifications would create. It does NOT touch severity routing or any
    other org-level policy.
    """
    try:
        await db.execute(text(
            "INSERT INTO notification_channels "
            "  (org_id, channel_type, enabled, config, created_at, updated_at) "
            "VALUES (:org, 'email', true, '{}'::jsonb, now(), now()) "
            "ON CONFLICT DO NOTHING"
        ), {"org": ORG_ID})
        # ON CONFLICT DO NOTHING covers a unique index if one exists; the
        # UPDATE covers the case where the row was already there (with or
        # without such an index), so this is idempotent either way.
        await db.execute(text(
            "UPDATE notification_channels SET enabled = true, updated_at = now() "
            "WHERE org_id = :org AND channel_type = 'email'"
        ), {"org": ORG_ID})
        await db.commit()
        logger.info("Email delivery channel enabled by %s", actor or "unknown actor")
        return {"ok": True}
    except Exception as exc:  # noqa: BLE001
        await db.rollback()
        logger.exception("Could not enable the email channel")
        return {"ok": False, "error": str(exc)}


# ── Queueing ──────────────────────────────────────────────────────────────────
async def queue_email(
    db: AsyncSession,
    *,
    subject: str,
    html_body: str,
    text_body: str,
    to: Sequence[str],
    cc: Sequence[str] = (),
    bcc: Sequence[str] = (),
    context: Optional[Dict[str, Any]] = None,
) -> Tuple[bool, str]:
    """Insert one notification_queue row. Returns (queued, message).

    The payload carries `subject`/`html`/`text` alongside `context`. The
    dispatcher's email adapter prefers a pre-rendered body when one is present
    and falls back to the org template otherwise, so cloud alerts get their own
    layout without changing how database-monitoring alerts render.

    Does not commit — the caller owns the transaction, so an alert and its
    notification are written together or not at all.
    """
    to = [a for a in to if a]
    if not to and not cc and not bcc:
        return False, "No recipient addresses were supplied."

    # notification_queue's timestamps are naive DateTime columns on the
    # database service's side (default=datetime.utcnow); a tz-aware value makes
    # asyncpg refuse the bind with "can't subtract offset-naive and
    # offset-aware datetimes".
    now = datetime.utcnow()
    payload = {
        "context": context or {},
        "subject": subject,
        "html": html_body,
        "text": text_body,
        "recipients_override": list(to),
        "cc_override": list(cc),
        "bcc_override": list(bcc),
        "source": "cloud_alerts",
    }
    try:
        await db.execute(text(
            "INSERT INTO notification_queue "
            "(org_id, alert_rule_id, channel_type, payload, status, "
            " attempt_count, max_attempts, next_attempt_at, timeout_seconds, created_at) "
            "VALUES "
            "(:org, NULL, 'email', CAST(:payload AS JSONB), 'pending', "
            " 0, 3, :now, 20, :now)"
        ), {"org": ORG_ID, "payload": json.dumps(payload), "now": now})
        return True, f"Queued for delivery to {len(to)} recipient(s)."
    except Exception as exc:  # noqa: BLE001
        logger.exception("Could not queue an alert email")
        return False, f"The notification queue could not be written: {exc}"


# ── Composing an alert email ──────────────────────────────────────────────────
def _deep_link(base_url: Optional[str], provider: Optional[str],
               account_id: Any, tab: str = "alerts",
               query: Optional[Dict[str, Any]] = None) -> Optional[str]:
    """A link into the app, or None.

    None rather than a guess when the public URL is unset: a "View in Actmon"
    button pointing at a hostname nobody can reach is worse than no button.

    The link carries no authority of its own — it is an ordinary application
    URL, and the server still authorizes the request when it is followed. An
    email recipient who cannot see an account cannot see it by clicking this.
    """
    if not base_url:
        return None
    slug = (provider or "").strip().lower()
    slug = {"amazon": "aws", "microsoft": "azure", "oracle": "oci"}.get(slug, slug)
    if not slug:
        return None
    url = f"{base_url.rstrip('/')}/cloud/{slug}-accounts/{account_id}/{tab}"
    if query:
        from urllib.parse import urlencode

        clean = {k: v for k, v in query.items() if v not in (None, "")}
        if clean:
            url = f"{url}?{urlencode(clean)}"
    return url


def _alert_links(base_url: Optional[str], account, rule,
                 evaluation) -> List[Dict[str, str]]:
    """The set of "go look at this" links for an alert.

    Which links appear depends on the rule's category, because a cost alert and
    a security alert send you to different places. Only links that would land
    somewhere useful are included — an alert with no resource gets no View
    Resource button rather than one that opens an empty filter.
    """
    provider = getattr(account, "provider", None)
    account_id = getattr(rule, "account_id", None) or getattr(account, "id", None)

    def link(label, tab, query=None):
        url = _deep_link(base_url, provider, account_id, tab, query)
        return {"label": label, "url": url} if url else None

    out = [link("View alert", "alerts")]

    category = getattr(rule, "category", None)
    if category == "cost":
        out.append(link("View cost", "cost"))
    elif category == "security":
        out.append(link("View security findings", "security"))
    elif category == "drift":
        out.append(link("View configuration drift", "drift"))
    elif category == "event":
        out.append(link("View event log", "events"))
    elif category in ("resource", "discovery"):
        out.append(link("View resources", "resources"))

    subject = getattr(evaluation, "subject_name", None)
    if subject:
        out.append(link("View resource", "resources", {"q": subject}))

    return [x for x in out if x]


def compose_alert_email(
    *, rule, alert, evaluation, account, condition_human: Optional[str],
    base_url: Optional[str] = None, resolved: bool = False,
    recipients_note: Optional[str] = None,
    timezone_name: Optional[str] = None,
) -> Dict[str, str]:
    """Build the subject and bodies for a triggered or resolved alert."""
    tz = timezone_name or DEFAULT_TIMEZONE
    kind = {
        "security": "Security Alert", "cost": "Cost Alert",
        "resource": "Resource Alert", "drift": "Configuration Drift Alert",
        "event": "Cloud Event Alert", "discovery": "Discovery Alert",
        "platform": "Platform Health Alert",
    }.get(rule.category, "Cloud Alert")
    account_name = getattr(account, "account_name", None) or "this account"

    facts: Dict[str, Any] = {
        "Account": account_name,
        "Provider": getattr(account, "provider", None),
        "Rule": rule.name,
        "Category": kind,
        "Condition": condition_human,
        # Rendered in the installation's timezone with the zone named. A bare
        # "10:42" in an email is read as local time by whoever opens it.
        "Detected": local_time(getattr(alert, "created_at", None), tz),
        "Last observed": local_time(getattr(alert, "last_seen_at", None), tz),
        "Occurrences": getattr(alert, "occurrence_count", None),
        "Current status": getattr(alert, "state", None),
        "Data as of": local_time(evaluation.as_of, tz),
    }
    scope = rule.scope_config or {}
    if scope.get("region"):
        facts["Region"] = scope["region"]
    if scope.get("service"):
        facts["Service"] = scope["service"]
    if scope.get("resource_type"):
        facts["Resource type"] = scope["resource_type"]
    if evaluation.unit and evaluation.unit != "%":
        facts["Currency"] = evaluation.unit

    why = {
        "Expected": (f"{evaluation.operator and _operator_words(evaluation.operator)} "
                     f"{evaluation.threshold_label}").strip()
        if evaluation.threshold is not None else None,
        "Observed": evaluation.observed_label,
        "Result": "Condition met" if not resolved else "Condition no longer met",
        "Detail": evaluation.detail,
    }

    banner = None
    if evaluation.context.get("partial_window"):
        banner = ("This figure covers fewer days than the rule's window, because "
                  "not every day in it has billing records stored yet. The real "
                  "total is at least this much.")
    elif evaluation.context.get("broken_scopes"):
        banner = ("Some audit-log collection scopes could not be read, so the "
                  "count below is a floor rather than a total.")
    if recipients_note:
        banner = f"{banner} {recipients_note}" if banner else recipients_note

    lead = (
        f"The condition on “{rule.name}” is no longer met and this alert has "
        "been resolved."
        if resolved else
        f"A condition you asked to be told about is true in {account_name}."
    )

    links = _alert_links(base_url, account, rule, evaluation)
    body = templates.render(
        title=rule.name,
        severity=rule.severity,
        lead=lead,
        facts=facts,
        why=why,
        samples=evaluation.samples,
        link=links[0]["url"] if links else None,
        link_label=links[0]["label"] if links else "View in Actmon",
        extra_links=links[1:],
        banner=banner,
        resolved=resolved,
    )
    return {
        "subject": templates.subject(
            severity=rule.severity, kind=kind, account=account_name,
            resolved=resolved),
        "html": body["html"],
        "text": body["text"],
    }


def compose_test_email(*, account, base_url: Optional[str] = None,
                       actor: Optional[str] = None,
                       rule=None, evaluation=None,
                       condition_human: Optional[str] = None) -> Dict[str, str]:
    """A clearly-labelled test. Never dressed up as a real incident."""
    account_name = getattr(account, "account_name", None) or "this account"
    facts: Dict[str, Any] = {
        "Account": account_name,
        "Provider": getattr(account, "provider", None),
        "Evaluated at": datetime.utcnow().isoformat() + "Z",
    }
    why = None
    if rule is not None:
        facts["Rule"] = rule.name
        facts["Condition"] = condition_human
    if evaluation is not None:
        why = {
            "Expected": (f"{_operator_words(evaluation.operator)} "
                         f"{evaluation.threshold_label}").strip()
            if evaluation.threshold is not None else None,
            "Observed": evaluation.observed_label,
            "Result": evaluation.state,
            "Detail": evaluation.detail,
        }

    body = templates.render(
        title="Test notification",
        severity="INFO",
        lead=("This is a test message from Actmon's cloud alerting. No cloud "
              "condition has been detected and no alert has been created."),
        facts=facts,
        why=why,
        link=_deep_link(base_url, getattr(account, "provider", None),
                        getattr(account, "id", None)),
        banner=(f"Sent by {actor} to verify email delivery." if actor else None),
        test=True,
    )
    return {
        "subject": templates.subject(
            severity="INFO", kind="Alert Notification", account=account_name,
            test=True),
        "html": body["html"],
        "text": body["text"],
    }


def compose_escalation_email(*, rule, alert, account, base_url=None,
                             timezone_name=None, unacknowledged_for=None):
    """An alert nobody has picked up.

    Deliberately blunt about what it is: not a new problem, an old one that
    nobody has claimed. The severity prefix is kept so filters still work, and
    ESCALATED is added so the reader can tell at a glance that they are the
    second person to be asked.
    """
    tz = timezone_name or DEFAULT_TIMEZONE
    account_name = getattr(account, "account_name", None) or "this account"
    hours = (unacknowledged_for.total_seconds() / 3600.0
             if unacknowledged_for else None)

    body = templates.render(
        title=f"Unacknowledged: {rule.name}",
        severity=rule.severity,
        lead=("This alert has been open and unacknowledged, so it is being "
              "escalated. It is not a new problem — nobody has picked up the "
              "existing one."),
        facts={
            "Account": account_name,
            "Provider": getattr(account, "provider", None),
            "Rule": rule.name,
            "Detected": local_time(getattr(alert, "created_at", None), tz),
            "Last observed": local_time(getattr(alert, "last_seen_at", None), tz),
            "Current status": getattr(alert, "state", None),
            "Occurrences": getattr(alert, "occurrence_count", None),
        },
        why={
            "Unacknowledged for": (f"{hours:.1f} hours" if hours is not None else None),
            "Detail": (alert.details or "")[:400],
        },
        link=_deep_link(base_url, getattr(account, "provider", None),
                        rule.account_id),
        link_label="Acknowledge in Actmon",
        banner="Acknowledging this alert stops further escalation.",
    )
    return {
        "subject": (f"[ESCALATED] [{(rule.severity or 'INFO').upper()}] "
                    f"{BRAND_KIND} — {account_name}"),
        "html": body["html"],
        "text": body["text"],
    }


def compose_digest_email(*, account, items, cadence, since, until,
                         base_url=None, timezone_name=None):
    """One periodic summary for an account.

    Counts by severity first, then the individual lines, because a digest is
    read as "is there anything I need to care about" before it is read as a
    list. CRITICAL never appears here — `policy.decide` sends those
    immediately — and the footer says so, so an empty Critical row is not read
    as "no critical problems".
    """
    tz = timezone_name or DEFAULT_TIMEZONE
    account_name = getattr(account, "account_name", None) or "this account"
    period = "Hourly" if cadence == "hourly_digest" else "Daily"

    by_severity: Dict[str, int] = {}
    for alert, _rule in items:
        key = (alert.severity or "INFO").upper()
        by_severity[key] = by_severity.get(key, 0) + 1

    samples = [
        {"name": (rule.name if rule else alert.anomaly_type),
         "type": alert.severity,
         "detail": (alert.details or "")[:180]}
        for alert, rule in items[:5]
    ]

    body = templates.render(
        title=f"{period} alert digest",
        severity="INFO",
        lead=(f"{len(items)} alert(s) were raised in {account_name} between "
              f"{local_time(since, tz)} and {local_time(until, tz)}."),
        facts={
            "Account": account_name,
            "Provider": getattr(account, "provider", None),
            "Window": f"{local_time(since, tz)} — {local_time(until, tz)}",
        },
        why={sev: by_severity.get(sev) for sev in
             ("HIGH", "MEDIUM", "LOW", "INFO") if by_severity.get(sev)},
        samples=samples,
        link=_deep_link(base_url, getattr(account, "provider", None),
                        getattr(account, "id", None)),
        link_label="View all alerts",
        banner=("Critical alerts are never held for a digest — they are sent "
                "the moment they fire, so none appear here."),
    )
    return {
        "subject": f"[DIGEST] {BRAND_KIND} — {account_name} ({len(items)})",
        "html": body["html"],
        "text": body["text"],
    }


BRAND_KIND = "Actmon Cloud Alerts"


def _operator_words(operator: Optional[str]) -> str:
    from app.services.alerts import catalog

    return catalog.operator_words(operator) if operator else ""


def _iso(value) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, str):
        return value
    try:
        return value.isoformat()
    except AttributeError:
        return str(value)


# ── Timestamps ────────────────────────────────────────────────────────────────
DEFAULT_TIMEZONE = "Asia/Kolkata"


def local_time(value, timezone_name: Optional[str] = None) -> Optional[str]:
    """`17 Sep 2026, 10:42 IST` — never a bare, ambiguous timestamp.

    Everything is stored in UTC; only the rendering is localized. Email needs
    this because it has no browser to ask: a message saying "10:42" with no zone
    is read as local time by whoever opens it, and an on-call engineer three
    hours out is then looking for an incident at the wrong time.

    The zone comes from the installation's configured setting, defaulting to
    Asia/Kolkata to match this deployment — but it is a default, not a hardcode,
    and a naive timestamp is treated as UTC rather than as the reader's zone,
    because that is what the database actually stores.
    """
    if value is None:
        return None
    if isinstance(value, str):
        text = value.strip()
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        try:
            value = datetime.fromisoformat(text)
        except ValueError:
            return str(value)
    if not isinstance(value, datetime):
        return str(value)
    if value.tzinfo is None:
        value = value.replace(tzinfo=_utc())

    zone = (timezone_name or DEFAULT_TIMEZONE).strip()
    try:
        from zoneinfo import ZoneInfo

        local = value.astimezone(ZoneInfo(zone))
    except Exception:  # noqa: BLE001 — an unknown zone must not break an email
        logger.debug("Unknown timezone %r; rendering in UTC.", zone)
        local = value.astimezone(_utc())

    # %Z gives the abbreviation the zone itself reports (IST, UTC, BST), so it
    # stays correct across daylight-saving changes rather than being a label we
    # chose once.
    return local.strftime("%d %b %Y, %H:%M %Z").replace("  ", " ")


def _utc():
    from datetime import timezone as _tz

    return _tz.utc
