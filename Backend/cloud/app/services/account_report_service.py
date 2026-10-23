"""Account report builder: produce-and-keep, templates, history, schedules.

`report_service` builds a dataset; the renderers turn it into a file. This
module is everything around that: one `produce()` used by the Generate button
and by the scheduler alike (so a scheduled report can never differ from the
same request made by hand), the history it writes to, the comparison with the
previous report, saved templates, and schedule arithmetic.

See `app.models.account_report` for the scheduling rules and why they exist.
"""
from __future__ import annotations

import base64
import hashlib
import json
import logging
import re
import uuid
from datetime import date, datetime, time, timedelta, timezone
from typing import Any, Dict, List, Optional, Sequence, Tuple

from pydantic import ValidationError
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import undefer

from app.models.account_report import (
    FREQ_MONTHLY, FREQ_WEEKLY, FREQUENCIES, REPORT_FAILED, REPORT_GENERATED, TRIGGER_MANUAL,
    TRIGGER_SCHEDULE, CloudAccountReport, CloudAccountReportSchedule, CloudReportTemplate,
)
from app.models.client import (
    DELIVERY_FAILED_TO_QUEUE, DELIVERY_NO_RECIPIENTS, DELIVERY_NOT_READY, DELIVERY_NOT_REQUESTED,
    DELIVERY_QUEUED, DELIVERY_TOO_LARGE,
)
from app.schemas.reports import (
    FORMAT_CSV, FORMAT_JSON, FORMAT_PDF, FORMAT_XLSX, SCOPE_RESOURCES,
    ReportDateRange, ReportLayout, ReportRequest, ReportScope, ReportSections,
)
from app.services import report_service as rs

logger = logging.getLogger("cloud_svc.account_reports")

KEEP_REPORTS_PER_ACCOUNT = 30
# A stored file above this is recorded (summary, request, size) but its bytes
# are not kept: a 50 MB JSON in Postgres is a cost, not a feature.
MAX_STORED_BYTES = 15 * 1024 * 1024
# Most SMTP relays refuse much above 10-25 MB, and base64 adds a third.
MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024
_TIME_RE = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")

MEDIA_TYPES = {
    FORMAT_CSV: "text/csv",
    FORMAT_JSON: "application/json",
    FORMAT_PDF: "application/pdf",
    FORMAT_XLSX: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}


class ReportError(Exception):
    def __init__(self, message: str, *, status: int = 400, field: Optional[str] = None):
        super().__init__(message)
        self.message = message
        self.status = status
        self.field = field


# ── Built-in templates ───────────────────────────────────────────────────────

def _sections(**on: bool) -> Dict[str, bool]:
    base = {k: False for k in ReportSections.model_fields}
    base.update({"executive_summary": True, "data_quality": True})
    base.update(on)
    return base


BUILTIN_TEMPLATES: Dict[str, Dict[str, Any]] = {
    "executive-monthly": {
        "name": "Executive monthly",
        "description": "Last month on a few pages: posture, top risks, spend, savings and "
                       "what changed. Summaries only.",
        "config": {"scope": {"mode": "account", "filters": {}},
                   "sections": _sections(security=True, cost=True, recommendations=True,
                                         posture=True, certificates=True),
                   "date_range": {"preset": "last_month"},
                   "layout": {"format": "pdf", "detail_level": "executive"}},
    },
    "security-audit": {
        "name": "Security audit",
        "description": "Every open finding with its fix, compliance by framework, identity "
                       "risk, expiring credentials and configuration changes.",
        "config": {"scope": {"mode": "account", "filters": {}},
                   "sections": _sections(inventory=True, security=True, posture=True,
                                         identity=True, certificates=True, changes=True,
                                         activity=True),
                   "date_range": {"preset": "30d"},
                   "layout": {"format": "pdf", "detail_level": "detailed", "sort_by": "severity"}},
    },
    "cost-review": {
        "name": "Cost review",
        "description": "Billed cost per resource, account spend and its change, anomalies, "
                       "utilization and savings.",
        "config": {"scope": {"mode": "account", "filters": {}},
                   "sections": _sections(cost=True, anomalies=True, utilization=True,
                                         recommendations=True),
                   "date_range": {"preset": "30d"},
                   "layout": {"format": "xlsx", "detail_level": "standard", "sort_by": "cost"}},
    },
    "compliance-evidence": {
        "name": "Compliance evidence",
        "description": "Framework results, the findings behind them with remediation, and "
                       "the period's configuration changes and audit activity.",
        "config": {"scope": {"mode": "account", "filters": {}},
                   "sections": _sections(security=True, posture=True, changes=True,
                                         activity=True, certificates=True),
                   "date_range": {"preset": "last_month"},
                   "layout": {"format": "pdf", "detail_level": "detailed", "group_by": "severity"}},
    },
    "full-assessment": {
        "name": "Full assessment",
        "description": "Every section, every row -- for analysis in a spreadsheet.",
        "config": {"scope": {"mode": "account", "filters": {}},
                   "sections": {k: True for k in ReportSections.model_fields},
                   "date_range": {"preset": "30d"},
                   "layout": {"format": "xlsx", "detail_level": "detailed"}},
    },
}


def builtin_templates() -> List[Dict[str, Any]]:
    return [{"id": f"builtin:{key}", "name": t["name"], "description": t["description"],
             "config": normalize_config(t["config"]), "builtin": True}
            for key, t in BUILTIN_TEMPLATES.items()]


def normalize_config(config: Dict[str, Any]) -> Dict[str, Any]:
    """Validate a saved request (template or schedule) and return it in full,
    canonical form. A saved request has no account and no hand-picked
    resources -- it must mean the same thing on any account."""
    if not isinstance(config, dict):
        raise ReportError("The report settings are missing.", field="config")
    scope = dict(config.get("scope") or {})
    scope.setdefault("mode", "account")   # ReportScope's own default is "resources"
    if scope.get("mode") == SCOPE_RESOURCES:
        raise ReportError("A saved report cannot use hand-picked resources -- they belong to "
                          "one account. Use a filter or the whole account.", field="scope")
    scope.pop("resource_ids", None)
    try:
        out = {
            "scope": ReportScope(**scope).model_dump(mode="json", exclude={"resource_ids"}),
            "sections": ReportSections(**(config.get("sections") or {})).model_dump(),
            "date_range": ReportDateRange(**(config.get("date_range") or {})).model_dump(mode="json"),
            "layout": ReportLayout(**(config.get("layout") or {})).model_dump(mode="json"),
        }
    except ValidationError as exc:
        raise ReportError("; ".join(e.get("msg", "") for e in exc.errors()), field="config") from exc
    out["scope"]["filters"] = rs.clean_filters(out["scope"].get("filters") or {})
    if not any(out["sections"].values()):
        raise ReportError("Choose at least one section.", field="sections")
    return out


def request_from_config(account_id: uuid.UUID, config: Dict[str, Any]) -> ReportRequest:
    cfg = normalize_config(config)
    return ReportRequest(account_id=account_id, **cfg)


# ── Rendering and the comparison ─────────────────────────────────────────────

def render(dataset: Dict[str, Any], layout: ReportLayout) -> bytes:
    from app.services.report_renderers import (
        csv_renderer, json_renderer, pdf_renderer, xlsx_renderer,
    )

    fmt = layout.format
    if fmt == FORMAT_CSV:
        return csv_renderer.build_csv(dataset).encode("utf-8")
    if fmt == FORMAT_JSON:
        return json_renderer.build_json(dataset).encode("utf-8")
    if fmt == FORMAT_PDF:
        return pdf_renderer.build_pdf(dataset, metadata=dataset.get("metadata"),
                                      detail_level=layout.detail_level)
    if fmt == FORMAT_XLSX:
        return xlsx_renderer.build_xlsx(dataset)
    raise ReportError(f"Unsupported format: {fmt}")


def report_slug(account_name: str) -> str:
    """An account name made safe for a Content-Disposition filename."""
    slug = re.sub(r"[^a-z0-9]+", "-", (account_name or "").lower()).strip("-")
    return slug[:60].rstrip("-") or "account"


def scope_key(request: ReportRequest) -> str:
    """Two reports are comparable only when they covered the same thing."""
    scope = request.scope
    basis = {"mode": scope.mode, "filters": rs.clean_filters(scope.filters or {}),
             "ids": sorted(str(i) for i in scope.resource_ids) if scope.mode == SCOPE_RESOURCES else []}
    return hashlib.sha256(json.dumps(basis, sort_keys=True, default=str).encode()).hexdigest()[:32]


# (key, label, lower_is_better). Per-currency maps are compared per currency.
COMPARED_METRICS = (
    ("resources_in_scope", "Resources in scope", None),
    ("critical_or_high", "Critical/high findings", True),
    ("findings_total", "Open security findings", True),
    ("account_level_findings", "Account-level findings", True),
    ("posture_score", "Security posture score", False),
    ("credentials_expired", "Expired certificates/secrets", True),
    ("billed_cost_in_scope", "Billed cost of resources in scope", True),
    ("potential_monthly_savings", "Potential monthly savings", None),
)


def compare_snapshots(previous: Optional[Dict[str, Any]], current: Dict[str, Any], *,
                      previous_meta: Optional[Dict[str, Any]] = None,
                      same_scope: bool = True) -> Optional[Dict[str, Any]]:
    """What moved since the previous report, metric by metric.

    A metric is compared only when BOTH reports measured it: a report that
    did not include security has no finding count, and treating the missing
    number as 0 would announce a drop that never happened. A withheld
    posture score is likewise never compared.
    """
    if not previous:
        return None
    meta = previous_meta or {}
    out: Dict[str, Any] = {"previous_report_id": meta.get("id"),
                           "previous_generated_at": meta.get("generated_at"),
                           "comparable": same_scope, "changes": []}
    if not same_scope:
        out["reason"] = ("The previous report covered a different scope, so its figures are "
                         "not comparable with this one.")
        return out
    for key, label, lower_better in COMPARED_METRICS:
        if key not in previous or key not in current:
            continue
        before, after = previous[key], current[key]
        if isinstance(after, dict) or isinstance(before, dict):
            for code in sorted(set(before or {}) & set(after or {})):
                out["changes"].append(_delta(f"{label} ({code})", before[code], after[code],
                                             lower_better, currency=code))
            continue
        if before is None or after is None:
            continue
        out["changes"].append(_delta(label, before, after, lower_better))
    if not out["changes"]:
        out["reason"] = "The two reports have no measured figure in common."
    return out


def _delta(label: str, before: float, after: float, lower_better: Optional[bool],
           currency: Optional[str] = None) -> Dict[str, Any]:
    diff = round(float(after) - float(before), 2)
    if diff == 0 or lower_better is None:
        trend = "unchanged" if diff == 0 else "changed"
    else:
        trend = "better" if (diff < 0) == lower_better else "worse"
    return {"metric": label, "previous": before, "current": after, "change": diff,
            "currency": currency, "trend": trend}


# ── Produce ──────────────────────────────────────────────────────────────────

async def previous_report(db: AsyncSession, account_id: uuid.UUID,
                          exclude_id: Optional[uuid.UUID] = None) -> Optional[CloudAccountReport]:
    stmt = (select(CloudAccountReport)
            .where(CloudAccountReport.account_id == account_id,
                   CloudAccountReport.status == REPORT_GENERATED,
                   CloudAccountReport.summary.is_not(None))
            .order_by(CloudAccountReport.generated_at.desc()).limit(1))
    if exclude_id is not None:
        stmt = stmt.where(CloudAccountReport.id != exclude_id)
    return (await db.execute(stmt)).scalars().first()


async def attach_comparison(db: AsyncSession, request: ReportRequest,
                            dataset: Dict[str, Any], snapshot: Dict[str, Any]) -> None:
    """Put "Since the last report" into the executive summary (when shown)."""
    try:
        prev = await previous_report(db, request.account_id)
    except Exception as exc:  # noqa: BLE001 -- history is optional context
        logger.warning("Report history unreadable for %s: %s", request.account_id, exc)
        return
    if prev is None:
        return
    since = compare_snapshots(
        prev.summary, snapshot, same_scope=prev.scope_key == scope_key(request),
        previous_meta={"id": str(prev.id), "generated_at": prev.generated_at.isoformat()
                       if prev.generated_at else None})
    summary = dataset.get("sections", {}).get("executive_summary")
    if since and isinstance(summary, dict):
        summary["since_last_report"] = since


async def produce(db: AsyncSession, request: ReportRequest, *, trigger: str = TRIGGER_MANUAL,
                  actor: Optional[str] = None, template_name: Optional[str] = None,
                  keep: bool = True, schedule: Optional[CloudAccountReportSchedule] = None,
                  run_key: Optional[str] = None, commit: bool = True,
                  ) -> Tuple[Optional[CloudAccountReport], bytes, Dict[str, Any]]:
    """Build, render and (when `keep`) store one report.

    Returns (history row or None, file bytes, info). A scheduled run passes
    `commit=False` so its row, its queued e-mail and the schedule's advance
    commit together.
    """
    resource_ids, _total, dataset, snapshot = await rs.build_for_request(db, request)
    if not resource_ids:
        raise ReportError("The selected scope matches no resources.")
    await attach_comparison(db, request, dataset, snapshot)
    now = datetime.now(timezone.utc)
    dataset["metadata"] = request.layout.metadata.model_dump()
    dataset["generated_at"] = now.isoformat()
    content = render(dataset, request.layout)
    fmt = request.layout.format
    filename = (f"{report_slug(dataset['account']['name'])}-"
                f"{report_slug(template_name) + '-' if template_name else ''}assessment-"
                f"{now.strftime('%Y%m%dT%H%M%S')}.{fmt}")
    info = {"filename": filename, "media_type": MEDIA_TYPES[fmt],
            "resources": len(resource_ids)}
    if not keep:
        return None, content, info

    period = dataset.get("period") or {}
    row = CloudAccountReport(
        account_id=request.account_id, schedule_id=schedule.id if schedule else None,
        run_key=run_key, template_name=template_name,
        title=(request.layout.metadata.title or template_name or "Resource assessment")[:255],
        trigger=trigger, requested_by=actor, status=REPORT_GENERATED, format=fmt,
        filename=filename, content_type=MEDIA_TYPES[fmt], size_bytes=len(content),
        sha256=hashlib.sha256(content).hexdigest(),
        request=request.model_dump(mode="json"), scope_key=scope_key(request),
        summary=snapshot, resources=len(resource_ids),
        period_start=date.fromisoformat(period["start"]) if period.get("start") else None,
        period_end=date.fromisoformat(period["end"]) if period.get("end") else None,
        delivery_status=DELIVERY_NOT_REQUESTED, generated_at=now,
    )
    if len(content) > MAX_STORED_BYTES:
        row.content_note = (f"The file was {len(content) // (1024 * 1024)} MB, above the "
                            f"{MAX_STORED_BYTES // (1024 * 1024)} MB kept in history; its summary "
                            "was kept, the file was not.")
    else:
        row.content = content
    db.add(row)
    await db.flush()
    await prune(db, request.account_id)
    if commit:
        await db.commit()
    info["report_id"] = str(row.id)
    return row, content, info


async def record_failure(db: AsyncSession, account_id: uuid.UUID, *, fmt: str,
                         schedule: CloudAccountReportSchedule, run_key: str,
                         error: str, template_name: Optional[str]) -> CloudAccountReport:
    """A scheduled run that could not build still takes its run's slot, so the
    schedule cannot retry it in a loop."""
    row = CloudAccountReport(account_id=account_id, schedule_id=schedule.id, run_key=run_key,
                             template_name=template_name, title=schedule.name,
                             trigger=TRIGGER_SCHEDULE, requested_by="schedule",
                             status=REPORT_FAILED, error=error[:2000], format=fmt,
                             delivery_status=DELIVERY_NOT_REQUESTED)
    db.add(row)
    await db.flush()
    return row


async def prune(db: AsyncSession, account_id: uuid.UUID) -> None:
    old = (await db.execute(
        select(CloudAccountReport.id).where(CloudAccountReport.account_id == account_id)
        .order_by(CloudAccountReport.generated_at.desc()).offset(KEEP_REPORTS_PER_ACCOUNT)
    )).scalars().all()
    if old:
        await db.execute(delete(CloudAccountReport).where(CloudAccountReport.id.in_(old)))


# ── History ──────────────────────────────────────────────────────────────────

async def list_history(db: AsyncSession, account_id: uuid.UUID, limit: int = 50) -> List[Dict[str, Any]]:
    rows = (await db.execute(
        select(CloudAccountReport).where(CloudAccountReport.account_id == account_id)
        .order_by(CloudAccountReport.generated_at.desc()).limit(min(limit, 200))
    )).scalars().all()
    return [r.to_dict() for r in rows]


async def get_with_content(db: AsyncSession, account_id: uuid.UUID,
                           report_id: uuid.UUID) -> Optional[CloudAccountReport]:
    return (await db.execute(
        select(CloudAccountReport).options(undefer(CloudAccountReport.content))
        .where(CloudAccountReport.id == report_id, CloudAccountReport.account_id == account_id)
    )).scalars().first()


async def delete_report(db: AsyncSession, account_id: uuid.UUID, report_id: uuid.UUID) -> bool:
    result = await db.execute(delete(CloudAccountReport).where(
        CloudAccountReport.id == report_id, CloudAccountReport.account_id == account_id))
    await db.commit()
    return bool(result.rowcount)


# ── Templates ────────────────────────────────────────────────────────────────

async def list_templates(db: AsyncSession) -> List[Dict[str, Any]]:
    saved = (await db.execute(select(CloudReportTemplate).order_by(CloudReportTemplate.name))).scalars().all()
    return builtin_templates() + [t.to_dict() for t in saved]


def _template_name(data: Dict[str, Any]) -> str:
    name = (data.get("name") or "").strip()
    if not name:
        raise ReportError("Give the template a name.", field="name")
    if len(name) > 120:
        raise ReportError("Keep the name under 120 characters.", field="name")
    if name.lower() in {t["name"].lower() for t in BUILTIN_TEMPLATES.values()}:
        raise ReportError(f"{name!r} is a built-in template; choose another name.", field="name")
    return name


async def save_template(db: AsyncSession, data: Dict[str, Any], *, actor: Optional[str],
                        template_id: Optional[uuid.UUID] = None) -> Dict[str, Any]:
    from sqlalchemy import func

    name = _template_name(data)
    config = normalize_config(data.get("config") or {})
    clash = (await db.execute(select(CloudReportTemplate.id).where(
        func.lower(CloudReportTemplate.name) == name.lower()))).scalars().first()
    if clash is not None and clash != template_id:
        raise ReportError(f"A template named {name!r} already exists.", field="name", status=409)
    if template_id is None:
        row = CloudReportTemplate(name=name, created_by=actor)
        db.add(row)
    else:
        row = await db.get(CloudReportTemplate, template_id)
        if row is None:
            raise ReportError("Template not found.", status=404)
    row.name = name
    row.description = (data.get("description") or "").strip() or None
    row.config = config
    await db.commit()
    await db.refresh(row)
    return row.to_dict()


async def delete_template(db: AsyncSession, template_id: uuid.UUID) -> bool:
    result = await db.execute(delete(CloudReportTemplate).where(CloudReportTemplate.id == template_id))
    await db.commit()
    return bool(result.rowcount)


# ── Schedule arithmetic (pure) ───────────────────────────────────────────────

def _zone(tz_name: str):
    from zoneinfo import ZoneInfo

    try:
        return ZoneInfo(tz_name)
    except Exception as exc:  # noqa: BLE001
        raise ReportError(f"Unknown time zone {tz_name!r}.", field="timezone") from exc


def next_run_after(now: datetime, *, frequency: str, send_time: str, tz_name: str,
                   day_of_week: Optional[int] = None, day_of_month: Optional[int] = None) -> datetime:
    """The next due moment (UTC) strictly after `now`, computed in the
    schedule's own zone so "09:00 every Monday" stays 09:00 local across DST."""
    zone = _zone(tz_name)
    hh, mm = (int(x) for x in send_time.split(":"))
    local_now = now.astimezone(zone)
    if frequency == FREQ_WEEKLY:
        for offset in range(0, 8):
            day = local_now.date() + timedelta(days=offset)
            if day.weekday() != day_of_week:
                continue
            candidate = datetime.combine(day, time(hh, mm), tzinfo=zone)
            if candidate > local_now:
                return candidate.astimezone(timezone.utc)
        raise RuntimeError("unreachable: a weekly schedule always has a next run")
    year, month = local_now.year, local_now.month
    for _ in range(3):
        candidate = datetime.combine(date(year, month, day_of_month), time(hh, mm), tzinfo=zone)
        if candidate > local_now:
            return candidate.astimezone(timezone.utc)
        month += 1
        if month == 13:
            year, month = year + 1, 1
    raise RuntimeError("unreachable: a monthly schedule always has a next run")


def run_key_for(run_at: datetime, tz_name: str) -> str:
    """The run's identity: its local date. One report per schedule per key."""
    return run_at.astimezone(_zone(tz_name)).date().isoformat()


def plan_run(sched: CloudAccountReportSchedule, now: datetime) -> Dict[str, Any]:
    """Which run to perform now and which overdue runs are being skipped.
    After downtime only the most recent due run is produced -- a month of
    outage must not become four e-mails five minutes apart."""
    kwargs = dict(frequency=sched.frequency, send_time=sched.send_time, tz_name=sched.timezone,
                  day_of_week=sched.day_of_week, day_of_month=sched.day_of_month)
    run_at = sched.next_run_at
    skipped: List[str] = []
    for _ in range(600):
        following = next_run_after(run_at, **kwargs)
        if following > now:
            break
        skipped.append(run_key_for(run_at, sched.timezone))
        run_at = following
    return {"run_at": run_at, "run_key": run_key_for(run_at, sched.timezone),
            "skipped": skipped, "next_run_at": next_run_after(run_at, **kwargs)}


# ── Schedules ────────────────────────────────────────────────────────────────

def _recipients(data: Dict[str, Any]) -> Dict[str, List[str]]:
    from app.services.alerts.notifier import valid_email

    out: Dict[str, List[str]] = {}
    for kind in ("to", "cc", "bcc"):
        seen, clean = set(), []
        raw = (data or {}).get(kind) or []
        if isinstance(raw, str):
            raw = re.split(r"[,;\s]+", raw)
        for addr in raw:
            addr = (addr or "").strip()
            if not addr:
                continue
            if not valid_email(addr):
                raise ReportError(f"{addr!r} is not a valid e-mail address.", field="recipients")
            if addr.lower() not in seen:
                seen.add(addr.lower())
                clean.append(addr)
        out[kind] = clean
    return out


async def list_schedules(db: AsyncSession, account_id: uuid.UUID) -> List[Dict[str, Any]]:
    rows = (await db.execute(
        select(CloudAccountReportSchedule).where(CloudAccountReportSchedule.account_id == account_id)
        .order_by(CloudAccountReportSchedule.created_at)
    )).scalars().all()
    return [r.to_dict() for r in rows]


async def save_schedule(db: AsyncSession, account_id: uuid.UUID, data: Dict[str, Any], *,
                        actor: Optional[str], schedule_id: Optional[uuid.UUID] = None,
                        now: Optional[datetime] = None) -> Dict[str, Any]:
    from app.repository.cloud_account_repo import CloudAccountRepository

    if await CloudAccountRepository(db).get_by_id(account_id) is None:
        raise ReportError("Cloud account not found.", status=404)
    name = (data.get("name") or "").strip()
    if not name:
        raise ReportError("Give the schedule a name.", field="name")
    frequency = data.get("frequency") or FREQ_MONTHLY
    if frequency not in FREQUENCIES:
        raise ReportError(f"Frequency must be one of {FREQUENCIES}.", field="frequency")
    day_of_week = day_of_month = None
    if frequency == FREQ_WEEKLY:
        day_of_week = int(data.get("day_of_week") if data.get("day_of_week") is not None else 0)
        if not 0 <= day_of_week <= 6:
            raise ReportError("Choose a weekday.", field="day_of_week")
    else:
        day_of_month = int(data.get("day_of_month") or 3)
        if not 1 <= day_of_month <= 28:
            raise ReportError("Choose a day between 1 and 28 (every month has one).",
                              field="day_of_month")
    send_time = (data.get("send_time") or "09:00").strip()
    if not _TIME_RE.match(send_time):
        raise ReportError("The time must look like 09:00.", field="send_time")
    tz_name = (data.get("timezone") or "Asia/Kolkata").strip()
    _zone(tz_name)
    recipients = _recipients(data.get("recipients") or {})
    config = normalize_config(data.get("config") or {})
    enabled = bool(data.get("enabled"))
    if enabled and not recipients["to"]:
        raise ReportError("A schedule that e-mails needs at least one To address.",
                          field="recipients")

    if schedule_id is None:
        sched = CloudAccountReportSchedule(account_id=account_id)
        db.add(sched)
    else:
        sched = await db.get(CloudAccountReportSchedule, schedule_id)
        if sched is None or sched.account_id != account_id:
            raise ReportError("Schedule not found.", status=404)
    sched.name = name[:120]
    sched.enabled = enabled
    sched.frequency = frequency
    sched.day_of_week = day_of_week
    sched.day_of_month = day_of_month
    sched.send_time = send_time
    sched.timezone = tz_name
    sched.recipients = recipients
    sched.config = config
    sched.template_name = (data.get("template_name") or None)
    sched.updated_by = actor
    sched.next_run_at = (next_run_after(now or datetime.now(timezone.utc), frequency=frequency,
                                        send_time=send_time, tz_name=tz_name,
                                        day_of_week=day_of_week, day_of_month=day_of_month)
                         if enabled else None)
    await db.commit()
    await db.refresh(sched)
    return sched.to_dict()


async def delete_schedule(db: AsyncSession, account_id: uuid.UUID, schedule_id: uuid.UUID) -> bool:
    result = await db.execute(delete(CloudAccountReportSchedule).where(
        CloudAccountReportSchedule.id == schedule_id,
        CloudAccountReportSchedule.account_id == account_id))
    await db.commit()
    return bool(result.rowcount)


async def delivery_status(db: AsyncSession) -> Dict[str, Any]:
    from app.services.alerts.notifier import delivery_status as _status

    try:
        return await _status(db)
    except Exception as exc:  # noqa: BLE001
        return {"ready": False, "blockers": [{"code": "unreadable", "message": str(exc)}]}


# ── E-mail ───────────────────────────────────────────────────────────────────

def email_lines(account_name: str, schedule_name: str, summary: Dict[str, Any],
                since: Optional[Dict[str, Any]], period: Dict[str, Any]) -> List[str]:
    """The message body: the few figures someone reads before deciding to open
    the attachment, each stated with its basis."""
    from app.services.client_report_service import fmt_money

    lines = [f"The {schedule_name!r} report for {account_name} is attached "
             f"(period {period.get('start')} to {period.get('end')})."]
    if "posture_score" in summary:
        lines.append(f"Security posture: {summary['posture_score']}/100.")
    if "critical_or_high" in summary:
        lines.append(f"Open critical/high security findings: {summary['critical_or_high']}.")
    if summary.get("billed_cost_in_scope"):
        lines.append("Billed cost of the resources in scope: " + ", ".join(
            fmt_money(v, c) for c, v in summary["billed_cost_in_scope"].items()) + ".")
    if summary.get("potential_monthly_savings"):
        lines.append("Potential savings per month: " + ", ".join(
            fmt_money(v, c) for c, v in summary["potential_monthly_savings"].items()) + ".")
    if since and since.get("comparable") and since.get("changes"):
        moved = [c for c in since["changes"] if c["trend"] in ("better", "worse")]
        if moved:
            lines.append("Since the last report: " + "; ".join(
                f"{c['metric']} {c['previous']} -> {c['current']} ({c['trend']})" for c in moved[:5]) + ".")
    lines.append("Figures come from ACTMON's stored provider data; the report's Data Quality "
                 "section names anything incomplete.")
    return lines


async def queue_report_email(db: AsyncSession, row: CloudAccountReport, content: bytes, *,
                             sched: CloudAccountReportSchedule, account_name: str,
                             since: Optional[Dict[str, Any]], period: Dict[str, Any]) -> None:
    """Queue on the caller's transaction. Records why when it cannot -- never
    raises for a delivery problem. Queued is not delivered: the database
    service's dispatcher sends it and records the outcome."""
    from app.services.alerts.notifier import queue_email

    rec = sched.recipients or {}
    to, cc, bcc = list(rec.get("to") or []), list(rec.get("cc") or []), list(rec.get("bcc") or [])
    if not to:
        row.delivery_status = DELIVERY_NO_RECIPIENTS
        row.delivery_message = "No To address is configured on this schedule."
        return
    status = await delivery_status(db)
    if not status.get("ready"):
        row.delivery_status = DELIVERY_NOT_READY
        row.delivery_message = "; ".join(b.get("message", "") for b in status.get("blockers") or []) \
            or "E-mail delivery is not set up."
        return
    if len(content) > MAX_ATTACHMENT_BYTES:
        row.delivery_status = DELIVERY_TOO_LARGE
        row.delivery_message = (f"The file is {len(content) // 1024} KB, above the "
                                f"{MAX_ATTACHMENT_BYTES // (1024 * 1024)} MB attachment limit. "
                                "It is in the account's report history.")
        return
    lines = email_lines(account_name, sched.name, row.summary or {}, since, period)
    ok, message = await queue_email(
        db, subject=f"{account_name} -- {sched.name}",
        html_body="".join(f"<p>{_html(line)}</p>" for line in lines),
        text_body="\n\n".join(lines), to=to, cc=cc, bcc=bcc,
        context={"AlertName": "Cloud account report", "ServerName": account_name},
        attachments=[{"filename": row.filename, "content_type": row.content_type,
                      "content_b64": base64.b64encode(content).decode("ascii")}],
        source="cloud_account_report",
    )
    if ok:
        row.delivery_status = DELIVERY_QUEUED
        row.delivery_queued_at = datetime.now(timezone.utc)
        row.delivered_to = {"to": to, "cc": cc, "bcc": bcc}
        row.delivery_message = (f"{message} Queued, not yet sent: the database service's "
                                "dispatcher delivers it and records the outcome.")
    else:
        row.delivery_status = DELIVERY_FAILED_TO_QUEUE
        row.delivery_message = message


def _html(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


async def run_schedule_now(db: AsyncSession, account_id: uuid.UUID, schedule_id: uuid.UUID, *,
                           actor: Optional[str], send: bool) -> Dict[str, Any]:
    """Produce a schedule's report by hand, optionally e-mailing it. Manual,
    so it neither takes nor advances the schedule's next run."""
    sched = await db.get(CloudAccountReportSchedule, schedule_id)
    if sched is None or sched.account_id != account_id:
        raise ReportError("Schedule not found.", status=404)
    request = request_from_config(account_id, sched.config)
    row, content, info = await produce(db, request, trigger=TRIGGER_MANUAL, actor=actor,
                                       template_name=sched.template_name or sched.name,
                                       commit=False)
    if send:
        dataset_period = {"start": row.period_start.isoformat() if row.period_start else None,
                          "end": row.period_end.isoformat() if row.period_end else None}
        account = await _account_name(db, account_id)
        await queue_report_email(db, row, content, sched=sched, account_name=account,
                                 since=None, period=dataset_period)
    await db.commit()
    return row.to_dict()


async def _account_name(db: AsyncSession, account_id: uuid.UUID) -> str:
    from app.repository.cloud_account_repo import CloudAccountRepository

    account = await CloudAccountRepository(db).get_by_id(account_id)
    return account.account_name if account else str(account_id)
