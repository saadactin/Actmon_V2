"""The monthly client report: gather, render, store, and (optionally) e-mail.

**Everything comes from this service's own tables.** Billing from
`cloud_cost_facts`, posture from the published assessments, findings and
compliance from the Security Center, certificates from the credential
inventory, changes from the drift log, alerts from `cloud_alerts`. Nothing
calls a provider API at generation time — a report produced at 09:00 on the
3rd must not depend on a rate-limited billing API answering at that moment,
and a report that does not match what the product shows is worse than none.

**What a report is honest about:**

* Money is per currency and never converted or summed across currencies.
* A month whose billing is incomplete says so ("21 of 31 days"), and one still
  carrying provisional rows says so too — providers restate for days after
  month end, which is why the default schedule day is the 3rd.
* Posture is the assessment published closest to the end of the period, and
  the report says which one it used. Findings, compliance and certificates are
  the CURRENT state at generation (the product keeps no daily snapshot of
  them), and are labelled that way rather than passed off as month-end.
* Every gap that could make a number wrong is listed under "Data gaps".

**The e-mail storm rule.** A scheduled report's row, the schedule's advance and
its queued e-mail are written in one transaction, and the partial unique index
on (client_id, period) WHERE trigger='schedule' makes a second scheduled report
for the same period impossible to insert. A failure after the commit can never
cause a resend, because the only thing after the commit is logging.
"""
from __future__ import annotations

import base64
import calendar
import hashlib
import logging
import re
import uuid
from datetime import date, datetime, time, timedelta, timezone
from typing import Any, Dict, List, Optional, Sequence, Tuple

from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import undefer

from app.models.alert import CloudAlert
from app.models.client import (
    DELIVERY_FAILED_TO_QUEUE, DELIVERY_NO_RECIPIENTS, DELIVERY_NOT_READY,
    DELIVERY_NOT_REQUESTED, DELIVERY_QUEUED, DELIVERY_TOO_LARGE, REPORT_FAILED,
    REPORT_GENERATED, SECTIONS, TRIGGER_MANUAL, TRIGGER_SCHEDULE, CloudClient,
    CloudClientReport, CloudClientReportSchedule,
)
from app.models.cloud_account import CloudAccount
from app.models.cost_fact import PROVISIONAL, CloudCostFact
from app.models.credential_inventory import (
    COLLECT_NOT_SUPPORTED, COLLECT_OK, CloudCredentialObject, CloudCredentialSource,
)
from app.models.drift import CloudResourceChange
from app.models.security_finding import CloudSecurityAssessment, CloudSecurityFinding
from app.security.model import (
    ACTIVE_FINDING_STATUSES, SEVERITIES, VULNERABLE, normalize_provider, severity_rank,
)
from app.services.alerts.notifier import valid_email
from app.services.client_service import ClientError
from app.services.cost_money import NOT_COMPARABLE, Change, percent_change

logger = logging.getLogger("cloud_svc.client_reports")

# SMTP servers commonly refuse messages much above 10-25 MB, and base64 adds a
# third. A report is a few hundred KB; this is a guard, not a target.
MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024
KEEP_REPORTS_PER_CLIENT = 36
CERT_HORIZON_DAYS = 60
_TIME_RE = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")


# ── Periods and schedule arithmetic (pure) ───────────────────────────────────
def period_bounds(period: Optional[str], today: date) -> Tuple[str, date, date]:
    """`(YYYY-MM, first day, first day of the next month)`.

    Defaults to the last COMPLETE month. The current month is refused: a
    report is a statement about a closed period, and "August so far" printed
    as "August" would be the kind of number this product exists not to print.
    """
    if not period:
        first_this = today.replace(day=1)
        start = (first_this - timedelta(days=1)).replace(day=1)
    else:
        m = re.match(r"^(\d{4})-(\d{2})$", period.strip())
        if not m or not 1 <= int(m.group(2)) <= 12:
            raise ClientError("The period must look like 2026-08.", field="period")
        start = date(int(m.group(1)), int(m.group(2)), 1)
    end = (start + timedelta(days=32)).replace(day=1)
    if start >= today.replace(day=1):
        raise ClientError(
            f"{start.strftime('%B %Y')} has not finished yet; a report covers a complete "
            "month.", field="period")
    return start.strftime("%Y-%m"), start, end


def _zone(tz_name: str):
    from zoneinfo import ZoneInfo

    try:
        return ZoneInfo(tz_name)
    except Exception as exc:  # noqa: BLE001
        raise ClientError(f"Unknown time zone {tz_name!r}.", field="timezone") from exc


def next_run_after(now: datetime, *, day_of_month: int, send_time: str,
                   tz_name: str) -> datetime:
    """The next moment (UTC) the schedule is due: `day_of_month` at
    `send_time` local time, strictly after `now`."""
    zone = _zone(tz_name)
    hh, mm = (int(x) for x in send_time.split(":"))
    local_now = now.astimezone(zone)
    year, month = local_now.year, local_now.month
    for _ in range(3):
        candidate = datetime.combine(date(year, month, day_of_month), time(hh, mm),
                                     tzinfo=zone)
        if candidate > local_now:
            return candidate.astimezone(timezone.utc)
        month += 1
        if month == 13:
            year, month = year + 1, 1
    raise RuntimeError("unreachable: a monthly schedule always has a next run")


def due_period(run_at: datetime, tz_name: str) -> str:
    """The period a run at `run_at` reports on: the month before it, in the
    schedule's own time zone (a 00:30 IST run on the 1st is still 'last
    month' even though it is the previous day in UTC)."""
    local = run_at.astimezone(_zone(tz_name)).date()
    return (local.replace(day=1) - timedelta(days=1)).strftime("%Y-%m")


# ── Money formatting for the PDF (pure) ──────────────────────────────────────
def fmt_money(amount: Optional[float], currency: Optional[str]) -> str:
    """ISO code, never a symbol (the PDF's built-in fonts have no rupee sign),
    and Indian digit grouping for INR, which is how its readers count."""
    if amount is None:
        return "NA"
    code = (currency or "").upper() or "?"
    neg = amount < 0
    whole, frac = f"{abs(amount):.2f}".split(".")
    if code == "INR" and len(whole) > 3:
        head, tail = whole[:-3], whole[-3:]
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        whole = ",".join(groups + [tail])
    else:
        whole = f"{int(whole):,}"
    return f"{'-' if neg else ''}{code} {whole}.{frac}"


class ClientReportService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def _client(self, client_id: uuid.UUID) -> CloudClient:
        client = await self.db.get(CloudClient, client_id)
        if client is None:
            raise ClientError("Client not found.", status=404)
        return client

    # ── Schedule ────────────────────────────────────────────────────────────
    async def get_schedule(self, client_id: uuid.UUID) -> Dict[str, Any]:
        await self._client(client_id)
        sched = await self.db.get(CloudClientReportSchedule, client_id)
        if sched is None:
            return {**CloudClientReportSchedule(
                client_id=client_id, enabled=False, day_of_month=3, send_time="09:00",
                timezone="Asia/Kolkata", recipients={"to": [], "cc": [], "bcc": []},
                sections=list(SECTIONS)).to_dict(), "saved": False,
                "delivery": await self._delivery()}
        return {**sched.to_dict(), "saved": True, "delivery": await self._delivery()}

    async def save_schedule(self, client_id: uuid.UUID, data: Dict[str, Any], *,
                            actor: Optional[str]) -> Dict[str, Any]:
        await self._client(client_id)
        day = int(data.get("day_of_month") or 3)
        if not 1 <= day <= 28:
            raise ClientError("Choose a day between 1 and 28 (every month has one).",
                              field="day_of_month")
        send_time = (data.get("send_time") or "09:00").strip()
        if not _TIME_RE.match(send_time):
            raise ClientError("The time must look like 09:00.", field="send_time")
        tz_name = (data.get("timezone") or "Asia/Kolkata").strip()
        _zone(tz_name)
        recipients: Dict[str, List[str]] = {}
        for kind in ("to", "cc", "bcc"):
            out, seen = [], set()
            for raw in (data.get("recipients") or {}).get(kind) or []:
                addr = (raw or "").strip()
                if not addr:
                    continue
                if not valid_email(addr):
                    raise ClientError(f"{addr!r} is not a valid e-mail address.",
                                      field="recipients")
                if addr.lower() not in seen:
                    seen.add(addr.lower())
                    out.append(addr)
            recipients[kind] = out
        sections = [s for s in (data.get("sections") or SECTIONS) if s in SECTIONS]
        if not sections:
            raise ClientError("Choose at least one section.", field="sections")
        enabled = bool(data.get("enabled"))
        if enabled and not recipients["to"]:
            raise ClientError("A schedule that e-mails needs at least one To address.",
                              field="recipients")

        sched = await self.db.get(CloudClientReportSchedule, client_id)
        if sched is None:
            sched = CloudClientReportSchedule(client_id=client_id)
            self.db.add(sched)
        sched.enabled = enabled
        sched.day_of_month = day
        sched.send_time = send_time
        sched.timezone = tz_name
        sched.recipients = recipients
        sched.sections = sections
        sched.updated_by = actor
        sched.next_run_at = (next_run_after(datetime.now(timezone.utc), day_of_month=day,
                                            send_time=send_time, tz_name=tz_name)
                             if enabled else None)
        await self.db.commit()
        return {**sched.to_dict(), "saved": True, "delivery": await self._delivery()}

    async def _delivery(self) -> Dict[str, Any]:
        from app.services.alerts.notifier import delivery_status

        try:
            return await delivery_status(self.db)
        except Exception as exc:  # noqa: BLE001
            return {"ready": False, "blockers": [{"code": "unreadable", "message": str(exc)}]}

    # ── Reads ───────────────────────────────────────────────────────────────
    async def list_reports(self, client_id: uuid.UUID, *, limit: int = 24) -> Dict[str, Any]:
        await self._client(client_id)
        rows = (await self.db.execute(
            select(CloudClientReport).where(CloudClientReport.client_id == client_id)
            .order_by(CloudClientReport.generated_at.desc()).limit(limit)
        )).scalars().all()
        return {"reports": [r.to_dict() for r in rows]}

    async def _report_with_pdf(self, client_id: uuid.UUID,
                               report_id: uuid.UUID) -> Optional[CloudClientReport]:
        # The PDF column is deferred (listing must not load every PDF), so it is
        # loaded explicitly here: an implicit lazy load is an error under
        # asyncio, not a slow query.
        return (await self.db.execute(
            select(CloudClientReport).options(undefer(CloudClientReport.pdf))
            .where(CloudClientReport.id == report_id,
                   CloudClientReport.client_id == client_id)
        )).scalar_one_or_none()

    async def pdf(self, client_id: uuid.UUID, report_id: uuid.UUID) -> Tuple[str, bytes]:
        client = await self._client(client_id)
        row = await self._report_with_pdf(client_id, report_id)
        if row is None:
            raise ClientError("Report not found.", status=404)
        if not row.pdf:
            raise ClientError("This report has no PDF (its generation failed).", status=404)
        return self.filename(client, row.period), bytes(row.pdf)

    @staticmethod
    def filename(client: CloudClient, period: str) -> str:
        slug = re.sub(r"[^A-Za-z0-9]+", "-", client.code or client.name).strip("-") or "client"
        return f"Actmon-Cloud-Report-{slug}-{period}.pdf"

    async def preview(self, client_id: uuid.UUID, period: Optional[str]) -> Dict[str, Any]:
        client = await self._client(client_id)
        label, start, end = period_bounds(period, datetime.now(timezone.utc).date())
        sched = await self.db.get(CloudClientReportSchedule, client_id)
        sections = list(sched.sections) if sched and sched.sections else list(SECTIONS)
        return await self.build_data(client, label, start, end, sections)

    # ── Assembly ────────────────────────────────────────────────────────────
    async def build_data(self, client: CloudClient, period: str, start: date, end: date,
                         sections: Sequence[str]) -> Dict[str, Any]:
        now = datetime.now(timezone.utc)
        accounts = (await self.db.execute(
            select(CloudAccount).where(CloudAccount.client_id == client.id)
            .order_by(CloudAccount.account_name))).scalars().all()
        ids = [a.id for a in accounts]
        start_dt = datetime.combine(start, time(0), tzinfo=timezone.utc)
        end_dt = datetime.combine(end, time(0), tzinfo=timezone.utc)
        prev_start = (start - timedelta(days=1)).replace(day=1)
        days_in_period = (end - start).days

        rows: Dict[uuid.UUID, Dict[str, Any]] = {
            a.id: {
                "account_id": str(a.id), "account_name": a.account_name,
                "provider": normalize_provider(a.provider) or a.provider,
                "environment": a.environment,
                "last_discovery": a.last_discovery.isoformat() if a.last_discovery else None,
                "gaps": [],
            } for a in accounts}

        if ids and "cost" in sections:
            await self._cost(rows, ids, start, end, prev_start, days_in_period)
        if ids and ("security" in sections or "compliance" in sections):
            await self._security(rows, ids, end_dt, sections)
        if ids and "certificates" in sections:
            await self._certificates(rows, ids, now)
        if ids and "changes" in sections:
            await self._changes(rows, ids, start_dt, end_dt)
        if ids and "alerts" in sections:
            await self._alerts(rows, ids, start_dt, end_dt)

        # Freshness gaps that can make any number above wrong.
        for a in accounts:
            r = rows[a.id]
            if not a.last_discovery:
                r["gaps"].append("The inventory has never been scanned.")
            elif a.last_discovery < end_dt - timedelta(days=7):
                r["gaps"].append(
                    f"The inventory was last scanned on {a.last_discovery.strftime('%d %b %Y')},"
                    " more than a week before the end of the period.")

        ordered = [rows[a.id] for a in accounts]
        return {
            "client": {"id": str(client.id), "name": client.name, "code": client.code},
            "period": period,
            "period_label": start.strftime("%B %Y"),
            "period_start": start.isoformat(),
            "period_end": end.isoformat(),
            "days_in_period": days_in_period,
            "generated_at": now.isoformat(),
            "sections": list(sections),
            "accounts": ordered,
            "totals": _totals(ordered),
            "notes": [
                "Spend is what each provider billed, per currency, from Actmon's stored "
                "billing history. Currencies are never converted or added together.",
                "Posture is the latest assessment published before the period ended. "
                "Findings, compliance and certificates show the state when this report "
                "was generated.",
                "Compliance references are informative cross-walks to published control "
                "text. They are not a certification or an audit opinion.",
            ],
        }

    async def _cost(self, rows, ids, start, end, prev_start, days_in_period) -> None:
        stmt = (select(CloudCostFact.account_id, CloudCostFact.currency,
                       func.sum(CloudCostFact.amount).filter(
                           CloudCostFact.billing_date >= start),
                       func.sum(CloudCostFact.amount).filter(
                           CloudCostFact.billing_date < start),
                       func.count(func.distinct(CloudCostFact.billing_date)).filter(
                           CloudCostFact.billing_date >= start),
                       func.count().filter(and_(CloudCostFact.billing_date >= start,
                                                CloudCostFact.finality == PROVISIONAL)))
                .where(CloudCostFact.account_id.in_(ids),
                       CloudCostFact.billing_date >= prev_start,
                       CloudCostFact.billing_date < end)
                .group_by(CloudCostFact.account_id, CloudCostFact.currency))
        for r in rows.values():
            r["cost"] = {"period": {}, "previous": {}, "change": {}, "days_covered": 0,
                         "days_in_period": days_in_period, "provisional_records": 0,
                         "top_services": [], "has_data": False}
        for aid, cur, amount, prev, days, provisional in (await self.db.execute(stmt)).all():
            c = rows[aid]["cost"]
            code = cur or "UNKNOWN"
            if amount is not None:
                c["period"][code] = round(float(amount), 2)
                c["has_data"] = True
            if prev is not None:
                c["previous"][code] = round(float(prev), 2)
            c["days_covered"] = max(c["days_covered"], int(days or 0))
            c["provisional_records"] += int(provisional or 0)

        for aid, r in rows.items():
            c = r["cost"]
            partial = c["has_data"] and c["days_covered"] < days_in_period
            for code in sorted(set(c["period"]) | set(c["previous"])):
                # Part of a month against a whole one reads as a fall that
                # never happened (or, the other way round, as growth).
                c["change"][code] = _not_comparable(
                    code, f"Billing covers {c['days_covered']} of {days_in_period} days of the "
                          "period, so it is not comparable with the previous month."
                ) if partial else percent_change(
                    c["period"].get(code), c["previous"].get(code),
                    current_currency=code, previous_currency=code).to_dict()
            if not c["has_data"]:
                r["gaps"].append("No billing data is stored for this period.")
            elif c["days_covered"] < days_in_period:
                r["gaps"].append(
                    f"Billing covers {c['days_covered']} of {days_in_period} days of the "
                    "period, so the total is incomplete.")
            if c["provisional_records"]:
                r["gaps"].append(
                    "Some of the period's billing is still provisional — the provider may "
                    "yet restate it.")

        top = (select(CloudCostFact.account_id, CloudCostFact.service, CloudCostFact.currency,
                      func.sum(CloudCostFact.amount).label("amt"))
               .where(CloudCostFact.account_id.in_(ids), CloudCostFact.billing_date >= start,
                      CloudCostFact.billing_date < end)
               .group_by(CloudCostFact.account_id, CloudCostFact.service,
                         CloudCostFact.currency))
        per: Dict[uuid.UUID, List[Tuple[str, str, float]]] = {}
        for aid, service, cur, amt in (await self.db.execute(top)).all():
            if amt is None:
                continue
            per.setdefault(aid, []).append((service or "Unattributed", cur or "UNKNOWN",
                                            round(float(amt), 2)))
        for aid, items in per.items():
            items.sort(key=lambda x: -x[2])
            rows[aid]["cost"]["top_services"] = [
                {"service": s, "currency": c, "amount": a} for s, c, a in items[:5]]

    async def _security(self, rows, ids, end_dt, sections) -> None:
        for aid in ids:
            r = rows[aid]
            before = (await self.db.execute(
                select(CloudSecurityAssessment).where(
                    CloudSecurityAssessment.account_id == aid,
                    CloudSecurityAssessment.finished_at < end_dt)
                .order_by(CloudSecurityAssessment.finished_at.desc()).limit(1)
            )).scalar_one_or_none()
            used, basis = before, "end_of_period"
            if used is None:
                used = (await self.db.execute(
                    select(CloudSecurityAssessment)
                    .where(CloudSecurityAssessment.account_id == aid)
                    .order_by(CloudSecurityAssessment.finished_at.desc()).limit(1)
                )).scalar_one_or_none()
                basis = "latest"
            if used is None:
                r["security"] = None
                r["gaps"].append("The account has never been security-assessed.")
            else:
                r["security"] = {
                    "score": used.score, "grade": used.grade,
                    "score_reliable": used.score_reliable,
                    "coverage_pct": used.coverage_pct, "outcome": used.outcome,
                    "assessed_at": used.finished_at.isoformat(), "basis": basis,
                }
                if basis == "latest":
                    r["gaps"].append("No assessment was published before the period ended; "
                                     "the posture shown is from after it.")
                if used.outcome != "COMPLETE":
                    r["gaps"].append("The assessment used was partial — some scopes could not "
                                     "be read — so its figures may understate findings.")

            findings = (await self.db.execute(
                select(CloudSecurityFinding).where(
                    CloudSecurityFinding.account_id == aid,
                    CloudSecurityFinding.status.in_(list(ACTIVE_FINDING_STATUSES)),
                    CloudSecurityFinding.verdict == VULNERABLE))).scalars().all()
            counts = {s: 0 for s in SEVERITIES}
            for f in findings:
                if f.severity in counts:
                    counts[f.severity] += 1
            findings = sorted(findings, key=lambda f: (severity_rank(f.severity),
                                                       f.title or ""))
            r["findings"] = counts
            r["top_findings"] = [
                {"severity": f.severity, "title": f.title,
                 "resource": f.resource_name or f.resource_type or "account-wide",
                 "affected": f.affected_count}
                for f in findings[:6]]

            if "compliance" in sections:
                from app.services.security_center_service import SecurityCenterService

                try:
                    comp = await SecurityCenterService(self.db).compliance(
                        aid, include_diff=False)
                    r["compliance"] = [
                        {"framework": fw, "label": s.get("label"),
                         "full_name": s.get("full_name"),
                         "passed": s["controls_passed"], "failed": s["controls_failed"],
                         "partial": s["controls_partial"], "unknown": s["controls_unknown"],
                         "assessed": s["controls_assessed"],
                         "declared": s["controls_declared"],
                         # "Assessed of applicable" needs both: a control that
                         # does not apply is not one we failed to assess.
                         "not_evaluated": s["controls_not_evaluated"],
                         "not_applicable": s["controls_not_applicable"],
                         "pass_rate": s["control_pass_rate"],
                         "coverage": s["assessment_coverage"]}
                        for fw, s in comp["frameworks"].items()]
                except Exception as exc:  # noqa: BLE001
                    logger.warning("Compliance for report failed on %s: %s", aid, exc)
                    r["compliance"] = None
                    r["gaps"].append("Compliance could not be computed for this account.")

    async def _certificates(self, rows, ids, now) -> None:
        horizon = now + timedelta(days=CERT_HORIZON_DAYS)
        objs = (await self.db.execute(
            select(CloudCredentialObject).where(
                CloudCredentialObject.account_id.in_(ids),
                CloudCredentialObject.enabled.is_distinct_from(False),
                CloudCredentialObject.expires_at.is_not(None),
                CloudCredentialObject.expires_at < horizon)
            .order_by(CloudCredentialObject.expires_at))).scalars().all()
        for r in rows.values():
            r["certificates"] = []
        for o in objs:
            rows[o.account_id]["certificates"].append({
                "name": o.name or o.object_key, "kind": o.kind,
                "container": o.container_name, "region": o.region,
                "expires_at": o.expires_at.isoformat(),
                "days_left": round((o.expires_at - now).total_seconds() / 86400.0, 1),
                "in_use": o.in_use, "managed_renewal": o.managed_renewal,
            })
        failing = (await self.db.execute(
            select(CloudCredentialSource.account_id, func.count())
            .where(CloudCredentialSource.account_id.in_(ids),
                   CloudCredentialSource.status.notin_([COLLECT_OK, COLLECT_NOT_SUPPORTED]))
            .group_by(CloudCredentialSource.account_id))).all()
        tried = dict((await self.db.execute(
            select(CloudCredentialSource.account_id, func.count())
            .where(CloudCredentialSource.account_id.in_(ids))
            .group_by(CloudCredentialSource.account_id))).all())
        for aid, n in failing:
            rows[aid]["gaps"].append(
                f"{n} certificate or secret store(s) could not be read, so the list may be "
                "incomplete.")
        # A store read in full can still hold certificates that would not parse;
        # the collector counts them on the store rather than dropping them.
        unparsed: Dict[uuid.UUID, int] = {}
        for aid, container in (await self.db.execute(
                select(CloudCredentialSource.account_id, CloudCredentialSource.container)
                .where(CloudCredentialSource.account_id.in_(ids),
                       CloudCredentialSource.status == COLLECT_OK))).all():
            n = int((container or {}).get("unreadable_certificates") or 0)
            if n:
                unparsed[aid] = unparsed.get(aid, 0) + n
        for aid, n in unparsed.items():
            rows[aid]["gaps"].append(
                f"{n} certificate(s) could not be parsed, so their expiry is unknown and they "
                "are not listed.")
        for aid in ids:
            if not tried.get(aid):
                rows[aid]["gaps"].append("Certificates and secrets have not been collected "
                                         "for this account yet.")

    async def _changes(self, rows, ids, start_dt, end_dt) -> None:
        for r in rows.values():
            r["changes"] = {"total": 0, "by_severity": {}}
        for aid, sev, n in (await self.db.execute(
                select(CloudResourceChange.account_id, CloudResourceChange.severity,
                       func.count())
                .where(CloudResourceChange.account_id.in_(ids),
                       CloudResourceChange.detected_at >= start_dt,
                       CloudResourceChange.detected_at < end_dt)
                .group_by(CloudResourceChange.account_id,
                          CloudResourceChange.severity))).all():
            ch = rows[aid]["changes"]
            ch["by_severity"][sev or "UNKNOWN"] = int(n)
            ch["total"] += int(n)

    async def _alerts(self, rows, ids, start_dt, end_dt) -> None:
        for r in rows.values():
            r["alerts"] = {"opened": 0, "resolved": 0}
        for aid, n in (await self.db.execute(
                select(CloudAlert.account_id, func.count())
                .where(CloudAlert.account_id.in_(ids), CloudAlert.created_at >= start_dt,
                       CloudAlert.created_at < end_dt, CloudAlert.state != "PENDING")
                .group_by(CloudAlert.account_id))).all():
            rows[aid]["alerts"]["opened"] = int(n)
        for aid, n in (await self.db.execute(
                select(CloudAlert.account_id, func.count())
                .where(CloudAlert.account_id.in_(ids), CloudAlert.resolved_at >= start_dt,
                       CloudAlert.resolved_at < end_dt)
                .group_by(CloudAlert.account_id))).all():
            rows[aid]["alerts"]["resolved"] = int(n)

    # ── Generate / send ─────────────────────────────────────────────────────
    async def generate(self, client_id: uuid.UUID, period: Optional[str], *, send: bool,
                       actor: Optional[str], trigger: str = TRIGGER_MANUAL,
                       schedule: Optional[CloudClientReportSchedule] = None,
                       commit: bool = True) -> Dict[str, Any]:
        """Build, render and store one report; optionally queue its e-mail.

        Nothing is committed until the row, the schedule's bookkeeping (when
        `schedule` is given) and the queued e-mail are all in the session — one
        transaction, so it happens once or not at all.
        """
        client = await self._client(client_id)
        label, start, end = period_bounds(period, datetime.now(timezone.utc).date())
        sched = schedule or await self.db.get(CloudClientReportSchedule, client_id)
        sections = list(sched.sections) if sched and sched.sections else list(SECTIONS)

        report = CloudClientReport(client_id=client_id, period=label, period_start=start,
                                   period_end=end, trigger=trigger, requested_by=actor)
        try:
            data = await self.build_data(client, label, start, end, sections)
            from app.services.client_report_pdf import render

            pdf = render(data)
            report.pdf = pdf
            report.pdf_bytes = len(pdf)
            report.sha256 = hashlib.sha256(pdf).hexdigest()
            report.summary = {"totals": data["totals"], "accounts": [
                {k: a.get(k) for k in ("account_id", "account_name", "provider",
                                       "security", "findings")}
                for a in data["accounts"]]}
            report.status = REPORT_GENERATED
        except ClientError:
            raise
        except Exception as exc:  # noqa: BLE001 — recorded, not raised
            logger.exception("Report generation failed for client %s", client_id)
            report.status = REPORT_FAILED
            report.error = str(exc)[:2000]

        report.delivery_status = DELIVERY_NOT_REQUESTED
        self.db.add(report)
        await self.db.flush()

        if send and report.status == REPORT_GENERATED:
            await self._queue(report, client, sched)

        await self._prune(client_id)
        if commit:
            await self.db.commit()
        return report.to_dict()

    async def send(self, client_id: uuid.UUID, report_id: uuid.UUID, *,
                   actor: Optional[str]) -> Dict[str, Any]:
        client = await self._client(client_id)
        report = await self._report_with_pdf(client_id, report_id)
        if report is None:
            raise ClientError("Report not found.", status=404)
        if report.status != REPORT_GENERATED:
            raise ClientError("Only a successfully generated report can be sent.")
        sched = await self.db.get(CloudClientReportSchedule, client_id)
        await self._queue(report, client, sched)
        await self.db.commit()
        return report.to_dict()

    async def _queue(self, report: CloudClientReport, client: CloudClient,
                     sched: Optional[CloudClientReportSchedule]) -> None:
        """Queue the e-mail on the caller's transaction. Records why when it
        cannot — never raises for a delivery problem."""
        from app.services.alerts.notifier import queue_email

        rec = (sched.recipients if sched else None) or {}
        to = list(rec.get("to") or [])
        cc = list(rec.get("cc") or [])
        bcc = list(rec.get("bcc") or [])
        if not to:
            report.delivery_status = DELIVERY_NO_RECIPIENTS
            report.delivery_message = ("No To address is configured on this client's report "
                                       "schedule.")
            return
        delivery = await self._delivery()
        if not delivery.get("ready"):
            report.delivery_status = DELIVERY_NOT_READY
            report.delivery_message = "; ".join(
                b.get("message", "") for b in delivery.get("blockers") or []) or \
                "E-mail delivery is not set up."
            return
        pdf = bytes(report.pdf or b"")
        if len(pdf) > MAX_ATTACHMENT_BYTES:
            report.delivery_status = DELIVERY_TOO_LARGE
            report.delivery_message = (f"The PDF is {len(pdf) // 1024} KB, above the "
                                       f"{MAX_ATTACHMENT_BYTES // (1024 * 1024)} MB limit.")
            return

        period_label = datetime.strptime(report.period, "%Y-%m").strftime("%B %Y")
        subject = f"{client.name} — cloud report for {period_label}"
        totals = (report.summary or {}).get("totals") or {}
        spend = ", ".join(fmt_money(v, k) for k, v in (totals.get("spend") or {}).items()) \
            or "no billing data stored"
        partial = totals.get("spend_incomplete") or []
        if partial and totals.get("spend"):
            spend += " (incomplete: " + "; ".join(
                f"{p['account']} billed {p['days_covered']} of {p['days_in_period']} days"
                for p in partial) + ")"
        f = totals.get("findings") or {}
        lines = [
            f"The {period_label} cloud report for {client.name} is attached.",
            f"Spend in the period: {spend}.",
            f"Open confirmed findings: {f.get('CRITICAL', 0)} critical, {f.get('HIGH', 0)} high.",
            f"Certificates and secrets expiring within {CERT_HORIZON_DAYS} days or expired: "
            f"{totals.get('certificates', 0)}.",
            "Figures are drawn from Actmon's stored provider data; see the report's Data gaps "
            "section for anything incomplete.",
        ]
        text_body = "\n\n".join(lines)
        html_body = "".join(f"<p>{_html(line)}</p>" for line in lines)
        ok, message = await queue_email(
            self.db, subject=subject, html_body=html_body, text_body=text_body,
            to=to, cc=cc, bcc=bcc,
            context={"AlertName": "Client cloud report", "ServerName": client.name},
            attachments=[{
                "filename": self.filename(client, report.period),
                "content_type": "application/pdf",
                "content_b64": base64.b64encode(pdf).decode("ascii"),
            }],
            source="cloud_client_report",
        )
        if ok:
            report.delivery_status = DELIVERY_QUEUED
            report.delivery_queued_at = datetime.now(timezone.utc)
            report.delivered_to = {"to": to, "cc": cc, "bcc": bcc}
            report.delivery_message = (f"{message} Queued, not yet sent: the database "
                                       "service's dispatcher delivers it and records the "
                                       "outcome in notification history.")
        else:
            report.delivery_status = DELIVERY_FAILED_TO_QUEUE
            report.delivery_message = message

    async def _prune(self, client_id: uuid.UUID) -> None:
        old = (await self.db.execute(
            select(CloudClientReport.id).where(CloudClientReport.client_id == client_id)
            .order_by(CloudClientReport.generated_at.desc()).offset(KEEP_REPORTS_PER_CLIENT)
        )).scalars().all()
        if old:
            from sqlalchemy import delete

            await self.db.execute(delete(CloudClientReport).where(
                CloudClientReport.id.in_(list(old))))


def _html(s: str) -> str:
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def _totals(accounts: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    spend: Dict[str, float] = {}
    previous: Dict[str, float] = {}
    findings = {s: 0 for s in SEVERITIES}
    certs = changes = opened = resolved = 0
    for a in accounts:
        for k, v in ((a.get("cost") or {}).get("period") or {}).items():
            spend[k] = round(spend.get(k, 0.0) + v, 2)
        for k, v in ((a.get("cost") or {}).get("previous") or {}).items():
            previous[k] = round(previous.get(k, 0.0) + v, 2)
        for s in SEVERITIES:
            findings[s] += (a.get("findings") or {}).get(s, 0)
        certs += len(a.get("certificates") or [])
        changes += (a.get("changes") or {}).get("total", 0)
        opened += (a.get("alerts") or {}).get("opened", 0)
        resolved += (a.get("alerts") or {}).get("resolved", 0)
    # The month-over-month change is LIKE FOR LIKE: only accounts billed in the
    # currency in both months, with a complete current month, count. Totals
    # across the whole group would report an account connected mid-month as
    # growth — the live TOR subscription, first billed in August, turned a
    # 1.4% fall on the one comparable account into "+12.2%".
    change: Dict[str, Any] = {}
    basis: Dict[str, Any] = {}
    for code in sorted(set(spend) | set(previous)):
        cur = prev = 0.0
        included: List[str] = []
        excluded: List[Dict[str, str]] = []
        for a in accounts:
            c = a.get("cost") or {}
            now_v = (c.get("period") or {}).get(code)
            before_v = (c.get("previous") or {}).get(code)
            if now_v is None and before_v is None:
                continue
            name = a.get("account_name")
            if now_v is None:
                excluded.append({"account": name, "reason": "no billing in the period"})
            elif before_v is None:
                excluded.append({"account": name,
                                 "reason": "no billing in the previous month"})
            elif (c.get("days_covered") or 0) < (c.get("days_in_period") or 0):
                excluded.append({"account": name, "reason": (
                    f"billed {c.get('days_covered')} of {c.get('days_in_period')} days")})
            else:
                cur += now_v
                prev += before_v
                included.append(name)
        change[code] = percent_change(
            round(cur, 2), round(prev, 2), current_currency=code, previous_currency=code
        ).to_dict() if included else _not_comparable(
            code, "No account was billed in this currency for both complete months.")
        basis[code] = {"included": included, "excluded": excluded}
    incomplete = [
        {"account": a.get("account_name"), "days_covered": c.get("days_covered"),
         "days_in_period": c.get("days_in_period")}
        for a in accounts for c in [a.get("cost") or {}]
        if c.get("has_data") and (c.get("days_covered") or 0) < (c.get("days_in_period") or 0)]
    return {"accounts": len(accounts), "spend": spend, "previous_spend": previous,
            "spend_change": change, "spend_change_basis": basis,
            "spend_incomplete": incomplete, "findings": findings, "certificates": certs,
            "changes": changes, "alerts_opened": opened, "alerts_resolved": resolved,
            "accounts_with_gaps": sum(1 for a in accounts if a.get("gaps"))}


def _not_comparable(code: str, reason: str) -> Dict[str, Any]:
    """A change that cannot be stated, in the same shape as a real one."""
    return Change(NOT_COMPARABLE, currency=code, reason=reason).to_dict()
