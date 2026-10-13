"""One summary per account, read from each domain's canonical source.

The client portfolio, a client's page and the monthly report all need the same
handful of numbers per account — resources, posture, open findings, alerts,
certificates, spend. Computing them in three places is how two screens come to
disagree (the Overview once printed 0/F beside a Security Center 35/F). So they
are computed here, once, in a fixed number of grouped queries regardless of how
many accounts are asked for.

What each number is, and is not:

* **Posture** is the latest persisted assessment's score and grade, exactly as
  the Security Center published it. Never recomputed, never averaged across
  accounts — an average of a 35 and a withheld score is a number no account has.
* **Findings** are CONFIRMED (verdict VULNERABLE), ACTIVE findings. Undetermined
  results are counted separately; they are gaps, not risks.
* **Spend** is billed spend from `cloud_cost_facts`, kept per currency. Never
  summed across currencies, and None — not 0 — where no billing history exists.
* **Certificates** count only objects whose store was read at least once.
  "No certificate expiring" is reported alongside how many stores could NOT be
  read, so it cannot be mistaken for a clean bill.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence

from sqlalchemy import and_, func, select, text

from app.models.alert import STATE_ACKNOWLEDGED, STATE_OPEN, CloudAlert
from app.models.cloud_account import CloudAccount
from app.models.cost_fact import CloudCostFact
from app.models.credential_inventory import (
    COLLECT_NOT_SUPPORTED, COLLECT_OK, CloudCredentialObject, CloudCredentialSource,
)
from app.models.discovery_job import DiscoveryJob
from app.models.resource import CloudResource
from app.models.security_finding import CloudSecurityAssessment, CloudSecurityFinding
from app.security import credentials as credx
from app.security.model import (
    ACTIVE_FINDING_STATUSES, NOT_SCANNED, SEVERITIES, UNKNOWN, VULNERABLE,
    normalize_provider,
)

EXPIRY_SOON_DAYS = 30
EXPIRY_HORIZON_DAYS = 90


def month_bounds(today: date) -> Dict[str, date]:
    """This month's first day, next month's, and last month's."""
    this_start = today.replace(day=1)
    prev_start = (this_start - timedelta(days=1)).replace(day=1)
    next_start = (this_start + timedelta(days=32)).replace(day=1)
    return {"this_start": this_start, "prev_start": prev_start, "next_start": next_start}


def _iso(dt) -> Optional[str]:
    return dt.isoformat() if dt else None


async def account_summaries(db, account_ids: Sequence[uuid.UUID], *,
                            now: Optional[datetime] = None) -> Dict[uuid.UUID, Dict[str, Any]]:
    """`{account_id: summary}` for every id given. Unknown ids are omitted."""
    ids = [a for a in account_ids if a]
    if not ids:
        return {}
    now = now or datetime.now(timezone.utc)
    bounds = month_bounds(now.date())

    accounts = (await db.execute(
        select(CloudAccount).where(CloudAccount.id.in_(ids)))).scalars().all()
    out: Dict[uuid.UUID, Dict[str, Any]] = {}
    for a in accounts:
        out[a.id] = {
            "account_id": str(a.id),
            "account_name": a.account_name,
            "provider": normalize_provider(a.provider) or a.provider,
            "environment": a.environment,
            "client_id": str(a.client_id) if a.client_id else None,
            "provider_account_id": a.provider_account_id,
            "onboarding_source": a.onboarding_source,
            "last_discovery": _iso(a.last_discovery),
            "discovery_status": "never_scanned",
            "resources": 0,
            "security": None,
            "findings": {s: 0 for s in SEVERITIES},
            "findings_undetermined": 0,
            "open_alerts": 0,
            "certificates": {"expired": 0, "expiring_soon": 0, "expiring_horizon": 0,
                             "replaced": 0,
                             "tracked": 0, "sources_total": 0, "sources_failing": 0,
                             "window_days": EXPIRY_SOON_DAYS,
                             "horizon_days": EXPIRY_HORIZON_DAYS},
            "cost": {"month_to_date": {}, "previous_month": {}, "mtd_days_covered": 0,
                     "has_history": False, "month": bounds["this_start"].strftime("%Y-%m"),
                     "previous_month_label": bounds["prev_start"].strftime("%Y-%m")},
        }
    ids = list(out)
    if not ids:
        return {}

    # Resources.
    for aid, n in (await db.execute(
            select(CloudResource.account_id, func.count())
            .where(CloudResource.account_id.in_(ids))
            .group_by(CloudResource.account_id))).all():
        out[aid]["resources"] = int(n)

    # Latest discovery job per account.
    rows = (await db.execute(text(
        "SELECT DISTINCT ON (account_id) account_id, status, completed_at, started_at "
        "FROM discovery_jobs WHERE account_id = ANY(:ids) "
        "ORDER BY account_id, started_at DESC NULLS LAST"), {"ids": ids})).all()
    for aid, status, completed, started in rows:
        s = (status or "").upper()
        out[aid]["discovery_status"] = (
            "failed" if s == "FAILED" else "scanning" if s in ("RUNNING", "PENDING")
            else "ok")

    # Latest assessment per account — the published posture, never recomputed.
    rows = (await db.execute(text(
        "SELECT DISTINCT ON (account_id) account_id, score, grade, score_reliable, "
        "coverage_pct, outcome, finished_at FROM cloud_security_assessments "
        "WHERE account_id = ANY(:ids) ORDER BY account_id, finished_at DESC"),
        {"ids": ids})).all()
    for aid, score, grade, reliable, cov, outcome, finished in rows:
        out[aid]["security"] = {
            "score": score, "grade": grade, "score_reliable": bool(reliable),
            "coverage_pct": cov, "outcome": outcome, "assessed_at": _iso(finished),
        }

    # Active findings: confirmed by severity, undetermined as one count.
    for aid, sev, verdict, n in (await db.execute(
            select(CloudSecurityFinding.account_id, CloudSecurityFinding.severity,
                   CloudSecurityFinding.verdict, func.count())
            .where(CloudSecurityFinding.account_id.in_(ids),
                   CloudSecurityFinding.status.in_(list(ACTIVE_FINDING_STATUSES)))
            .group_by(CloudSecurityFinding.account_id, CloudSecurityFinding.severity,
                      CloudSecurityFinding.verdict))).all():
        if verdict == VULNERABLE and sev in out[aid]["findings"]:
            out[aid]["findings"][sev] += int(n)
        elif verdict in (UNKNOWN, NOT_SCANNED):
            out[aid]["findings_undetermined"] += int(n)

    # Open alerts.
    for aid, n in (await db.execute(
            select(CloudAlert.account_id, func.count())
            .where(CloudAlert.account_id.in_(ids),
                   CloudAlert.state.in_([STATE_OPEN, STATE_ACKNOWLEDGED]))
            .group_by(CloudAlert.account_id))).all():
        out[aid]["open_alerts"] = int(n)

    # Certificates, secrets and keys. An unreported enabled flag is not
    # "disabled". Counted in Python, not SQL, because a certificate renewed as
    # a new object and no longer used ("replaced") depends on its siblings —
    # see credentials.supersession — and is not an expiry anyone must act on.
    soon = now + timedelta(days=EXPIRY_SOON_DAYS)
    horizon = now + timedelta(days=EXPIRY_HORIZON_DAYS)
    cred_objects = (await db.execute(select(CloudCredentialObject).where(
        CloudCredentialObject.account_id.in_(ids)))).scalars().all()
    successors = credx.supersession(cred_objects, now)
    for o in cred_objects:
        c = out[o.account_id]["certificates"]
        c["tracked"] += 1
        if o.enabled is False or o.expires_at is None:
            continue
        if o.expires_at < horizon and credx.is_retired(o, successors.get(o.object_key)):
            c["replaced"] += 1
        elif o.expires_at < now:
            c["expired"] += 1
        elif o.expires_at < horizon:
            c["expiring_horizon"] += 1
            if o.expires_at < soon:
                c["expiring_soon"] += 1
    for aid, total, failing in (await db.execute(
            select(
                CloudCredentialSource.account_id, func.count(),
                func.count().filter(CloudCredentialSource.status.notin_(
                    [COLLECT_OK, COLLECT_NOT_SUPPORTED])),
            ).where(CloudCredentialSource.account_id.in_(ids))
            .group_by(CloudCredentialSource.account_id))).all():
        out[aid]["certificates"].update(sources_total=int(total),
                                        sources_failing=int(failing))

    # Spend: this month so far and last month, per currency.
    for aid, cur, mtd, prev, days in (await db.execute(
            select(
                CloudCostFact.account_id, CloudCostFact.currency,
                func.sum(CloudCostFact.amount).filter(
                    CloudCostFact.billing_date >= bounds["this_start"]),
                func.sum(CloudCostFact.amount).filter(and_(
                    CloudCostFact.billing_date >= bounds["prev_start"],
                    CloudCostFact.billing_date < bounds["this_start"])),
                func.count(func.distinct(CloudCostFact.billing_date)).filter(
                    CloudCostFact.billing_date >= bounds["this_start"]),
            ).where(CloudCostFact.account_id.in_(ids),
                    CloudCostFact.billing_date >= bounds["prev_start"])
            .group_by(CloudCostFact.account_id, CloudCostFact.currency))).all():
        cost = out[aid]["cost"]
        cost["has_history"] = True
        key = cur or "UNKNOWN"
        if mtd is not None:
            cost["month_to_date"][key] = round(float(mtd), 2)
        if prev is not None:
            cost["previous_month"][key] = round(float(prev), 2)
        cost["mtd_days_covered"] = max(cost["mtd_days_covered"], int(days or 0))

    return out


def roll_up(summaries: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
    """Totals across a group of account summaries (one client, say).

    Counts add. Money adds only within a currency. Posture does NOT average:
    the group reports its worst reliable score and how many accounts have none.
    """
    rows = list(summaries)
    findings = {s: 0 for s in SEVERITIES}
    by_provider: Dict[str, int] = {}
    mtd: Dict[str, float] = {}
    prev: Dict[str, float] = {}
    certs = {"expired": 0, "expiring_soon": 0, "expiring_horizon": 0, "replaced": 0,
             "tracked": 0,
             "sources_failing": 0, "sources_total": 0}
    worst = None
    unassessed = 0
    unreliable = 0
    for r in rows:
        by_provider[r["provider"]] = by_provider.get(r["provider"], 0) + 1
        for s in SEVERITIES:
            findings[s] += r["findings"].get(s, 0)
        for k in certs:
            certs[k] += r["certificates"].get(k, 0)
        for cur, v in r["cost"]["month_to_date"].items():
            mtd[cur] = round(mtd.get(cur, 0.0) + v, 2)
        for cur, v in r["cost"]["previous_month"].items():
            prev[cur] = round(prev.get(cur, 0.0) + v, 2)
        sec = r.get("security")
        if not sec or sec.get("score") is None:
            unassessed += 1
            continue
        if not sec.get("score_reliable"):
            unreliable += 1
        if worst is None or sec["score"] < worst["score"]:
            worst = {"score": sec["score"], "grade": sec["grade"],
                     "account_id": r["account_id"], "account_name": r["account_name"],
                     "score_reliable": sec.get("score_reliable")}
    return {
        "accounts": len(rows),
        "by_provider": by_provider,
        "resources": sum(r["resources"] or 0 for r in rows),
        "findings": findings,
        "open_alerts": sum(r["open_alerts"] for r in rows),
        "certificates": certs,
        "cost": {"month_to_date": mtd, "previous_month": prev,
                 "currencies": sorted(set(mtd) | set(prev))},
        "worst_posture": worst,
        "accounts_unassessed": unassessed,
        "accounts_unreliable_score": unreliable,
        "note": ("Posture is not averaged across accounts: the worst published score "
                 "is shown, with how many accounts have none. Spend is totalled per "
                 "currency only."),
    }
