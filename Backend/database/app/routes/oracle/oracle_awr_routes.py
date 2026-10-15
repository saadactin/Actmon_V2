"""Oracle AWR Performance Intelligence endpoints.

Reports are scoped to the caller's organisation; linking one to a monitored
Oracle connection is optional (see oracle_awr_service.py's module docstring).
Database-level endpoints are keyed by database_key (DBID, plus instance on RAC).
Literal routes are declared before /{report_id} so they are never shadowed.
"""
from __future__ import annotations

import csv
import io
import logging
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, UploadFile
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.models.admin_models import AuditLog
from app.models.alert_rule_model import AlertRule
from app.services.auth.tenant_context import tenant_ctx, scope_org_id, create_org_id
from app.services.oracle import oracle_awr_analysis, oracle_awr_intel_service as intel, oracle_awr_service

router = APIRouter(prefix="/api/v1/oracle/awr", tags=["Oracle AWR Analyzer"])
log = logging.getLogger("oracle_awr")
AWR_RULE_METRIC = "oracle_awr_risk"


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _uploader(ctx: dict) -> Optional[str]:
    user_id = (ctx or {}).get("user_id")
    return str(user_id) if user_id is not None else None


def _audit(db: Session, ctx: dict, record_id, action: str, data: dict):
    """Best-effort audit trail in the shared audit_log table; never blocks the action."""
    try:
        db.add(AuditLog(org_id=(ctx or {}).get("org_id"), user_id=(ctx or {}).get("user_id"),
                        table_name="oracle_awr_reports", record_id=record_id, action_type=action[:20], new_data=data))
        db.commit()
    except Exception:  # noqa: BLE001
        db.rollback()
        log.warning("audit write failed for %s %s", action, record_id)


def _recompute(db: Session, org_id: int, keys) -> dict:
    out = {}
    for key in {k for k in keys if k}:
        try:
            out[key] = intel.recompute(db, org_id, key)
        except Exception as exc:  # noqa: BLE001 — history must never fail the upload itself
            db.rollback()
            log.exception("history recompute failed for %s", key)
            out[key] = {"status": "error", "error": type(exc).__name__}
    return out


# ── upload ────────────────────────────────────────────────────────────────
@router.post("/upload")
async def upload_awr_report(
    file: UploadFile = File(...),
    connection_id: Optional[int] = Form(None),
    db: Session = Depends(get_db),
    ctx: dict = Depends(tenant_ctx),
):
    org = create_org_id(ctx)
    result = await oracle_awr_service.upload_and_analyze(org, file, _uploader(ctx), db, connection_id=connection_id)
    if result.get("status") == "ok":
        rep = result["report"]
        result["history"] = _recompute(db, org, [rep.get("database_key")])
        _audit(db, ctx, rep["id"], "AWR_UPLOAD", {"file": rep["original_filename"], "status": rep["status"]})
    return result


@router.post("/batch-upload")
async def batch_upload_awr_reports(
    files: list[UploadFile] = File(...),
    connection_id: Optional[int] = Form(None),
    db: Session = Depends(get_db),
    ctx: dict = Depends(tenant_ctx),
):
    org, batch_id, results = create_org_id(ctx), uuid.uuid4().hex, []
    for f in files[:50]:  # bounded: one request never parses more than 50 reports
        result = await oracle_awr_service.upload_and_analyze(org, f, _uploader(ctx), db, connection_id=connection_id, batch_id=batch_id)
        results.append({"filename": f.filename, **result})
    keys = [r["report"].get("database_key") for r in results if r.get("report")]
    parsed = sum(1 for r in results if r.get("report", {}).get("status") == "PARSED")
    _audit(db, ctx, None, "AWR_BATCH_UPLOAD", {"batch_id": batch_id, "files": len(results), "parsed": parsed})
    return {"status": "ok", "batch_id": batch_id, "total": len(results), "succeeded": parsed,
            "failed": len(results) - parsed, "skipped_over_limit": max(0, len(files) - 50),
            "results": results, "history": _recompute(db, org, keys)}


@router.get("/")
def list_awr_reports(connection_id: Optional[int] = None, database_key: Optional[str] = None,
                     db: Session = Depends(get_db), ctx: dict = Depends(tenant_ctx)):
    res = oracle_awr_service.list_reports(scope_org_id(ctx), db, connection_id=connection_id)
    if database_key:
        res["reports"] = [r for r in res["reports"] if r.get("database_key") == database_key]
    return res


# ── database-level intelligence ───────────────────────────────────────────
@router.get("/databases")
def list_databases(db: Session = Depends(get_db), ctx: dict = Depends(tenant_ctx)):
    return {"status": "ok", "databases": intel.databases(db, scope_org_id(ctx))}


@router.get("/databases/{database_key}/overview")
def database_overview(database_key: str, db: Session = Depends(get_db), ctx: dict = Depends(tenant_ctx)):
    return intel.overview(db, scope_org_id(ctx), database_key)


@router.get("/databases/{database_key}/sql")
def database_sql(database_key: str, db: Session = Depends(get_db), ctx: dict = Depends(tenant_ctx)):
    return intel.sql_insights(db, scope_org_id(ctx), database_key)


@router.get("/databases/{database_key}/waits")
def database_waits(database_key: str, db: Session = Depends(get_db), ctx: dict = Depends(tenant_ctx)):
    return intel.waits(db, scope_org_id(ctx), database_key)


@router.get("/databases/{database_key}/predictions")
def database_predictions(database_key: str, db: Session = Depends(get_db), ctx: dict = Depends(tenant_ctx)):
    return intel.predictions(db, scope_org_id(ctx), database_key)


@router.get("/databases/{database_key}/capacity")
def database_capacity(database_key: str, db: Session = Depends(get_db), ctx: dict = Depends(tenant_ctx)):
    return intel.capacity_view(db, scope_org_id(ctx), database_key)


@router.get("/databases/{database_key}/recommendations")
def database_recommendations(database_key: str, db: Session = Depends(get_db), ctx: dict = Depends(tenant_ctx)):
    return intel.recommendations(db, scope_org_id(ctx), database_key)


@router.get("/databases/{database_key}/export")
def database_export(database_key: str, format: str = "csv", db: Session = Depends(get_db), ctx: dict = Depends(tenant_ctx)):
    rows = intel.export_rows(db, scope_org_id(ctx), database_key)
    safe = "".join(c for c in database_key if c.isalnum() or c in "-_") or "database"
    if format == "json":
        import json
        return Response(json.dumps(rows, indent=2), media_type="application/json",
                        headers={"Content-Disposition": f'attachment; filename="awr-findings-{safe}.json"'})
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=list(rows[0].keys()) if rows else ["finding_id"])
    writer.writeheader()
    for r in rows:
        # neutralise spreadsheet formulas: report-derived text must not execute in Excel
        writer.writerow({k: ("'" + v if isinstance(v, str) and v[:1] in "=+-@" else v) for k, v in r.items()})
    return Response(buf.getvalue(), media_type="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="awr-findings-{safe}.csv"'})


@router.post("/databases/{database_key}/recompute")
def database_recompute(database_key: str, db: Session = Depends(get_db), ctx: dict = Depends(tenant_ctx)):
    return _recompute(db, create_org_id(ctx), [database_key]).get(database_key, {"status": "skipped"})


@router.get("/compare")
def compare_reports(base: int, target: int, db: Session = Depends(get_db), ctx: dict = Depends(tenant_ctx)):
    return intel.compare(db, scope_org_id(ctx), base, target)


class FindingUpdate(BaseModel):
    status: Optional[str] = None
    outcome_note: Optional[str] = None


@router.patch("/findings/{finding_id}")
def update_finding(finding_id: int, body: FindingUpdate, db: Session = Depends(get_db), ctx: dict = Depends(tenant_ctx)):
    res = intel.update_finding(db, scope_org_id(ctx), finding_id, body.status, body.outcome_note)
    if res.get("status") == "ok":
        _audit(db, ctx, res["finding"]["report_id"], "AWR_FINDING_UPDATE",
               {"finding_id": finding_id, "before": res["before"], "after": {"status": body.status, "outcome_note": body.outcome_note}})
        res.pop("before", None)
    return res


# ── alerts: AWR risks in the existing Active Alerts feed (opt-in) ─────────
def _awr_rule(db: Session) -> AlertRule | None:
    return db.query(AlertRule).filter(AlertRule.metric == AWR_RULE_METRIC).first()


@router.get("/alerts")
def awr_alerts(db: Session = Depends(get_db), ctx: dict = Depends(tenant_ctx)):
    rule = _awr_rule(db)
    return {"status": "ok", "rule": {"exists": bool(rule), "enabled": bool(rule and rule.enabled), "id": rule.id if rule else None},
            "alerts": intel.awr_alerts(db, scope_org_id(ctx)),
            "note": "These come from uploaded AWR history. They never trigger notifications; enabling the rule only lists them on the Alerts page."}


class RuleToggle(BaseModel):
    enabled: bool


@router.post("/alerts/rule")
def toggle_awr_rule(body: RuleToggle, db: Session = Depends(get_db), ctx: dict = Depends(tenant_ctx)):
    from app.routes.alerts.alert_routes import _seed_if_empty  # keep the default rule set seeding intact
    _seed_if_empty(db)
    rule = _awr_rule(db)
    if not rule:
        rule = AlertRule(name="Oracle AWR Risk", metric=AWR_RULE_METRIC, operator="eq", threshold=1, scope_type="all",
                         severity="warning", duration_seconds=0, cooldown_seconds=600, enabled=body.enabled,
                         org_id=create_org_id(ctx), notification_channel_types=[],
                         description="Lists open HIGH/MEDIUM findings from the latest uploaded AWR report of each database. "
                                     "Historical data — never sends notifications.")
        db.add(rule)
    else:
        rule.enabled = body.enabled
    db.commit()
    _audit(db, ctx, rule.id, "AWR_ALERT_RULE", {"enabled": body.enabled})
    return {"status": "ok", "rule": {"id": rule.id, "enabled": rule.enabled}}


# ── per-report ────────────────────────────────────────────────────────────
@router.get("/{report_id}")
def get_awr_report(report_id: int, db: Session = Depends(get_db), ctx: dict = Depends(tenant_ctx)):
    return oracle_awr_service.get_report(report_id, scope_org_id(ctx), db)


@router.get("/{report_id}/insights")
def get_awr_report_insights(report_id: int, db: Session = Depends(get_db), ctx: dict = Depends(tenant_ctx)):
    return oracle_awr_service.get_report_insights(report_id, scope_org_id(ctx), db)


@router.get("/{report_id}/download")
def download_awr_report(report_id: int, db: Session = Depends(get_db), ctx: dict = Depends(tenant_ctx)):
    row = oracle_awr_service.get_report_file(report_id, scope_org_id(ctx), db)
    if not row:
        return {"status": "error", "error": "Report not found"}
    # attachment, never inline: the upload is untrusted HTML and must not render on this origin.
    return FileResponse(row.stored_path, media_type="text/html", filename=row.original_filename,
                        content_disposition_type="attachment")


@router.post("/{report_id}/reanalyze")
def reanalyze_awr_report(report_id: int, db: Session = Depends(get_db), ctx: dict = Depends(tenant_ctx)):
    res = oracle_awr_service.reanalyze_report(report_id, scope_org_id(ctx), db)
    if res.get("status") == "ok":
        res["history"] = _recompute(db, res["report"].get("org_id") or create_org_id(ctx), [res["report"].get("database_key")])
        _audit(db, ctx, report_id, "AWR_REANALYZE", {"status": res["report"]["status"]})
    return res


@router.delete("/{report_id}")
def delete_awr_report(report_id: int, db: Session = Depends(get_db), ctx: dict = Depends(tenant_ctx)):
    res = oracle_awr_service.delete_report(report_id, scope_org_id(ctx), db)
    if res.get("status") == "ok":
        res["history"] = _recompute(db, res.get("org_id") or create_org_id(ctx), [res.get("database_key")])
        _audit(db, ctx, report_id, "AWR_DELETE", {"file": res.get("original_filename")})
    return res


@router.post("/{report_id}/analyze-groq")
def analyze_awr_groq(report_id: int, db: Session = Depends(get_db), ctx: dict = Depends(tenant_ctx)):
    res = oracle_awr_analysis.analyze_awr_groq(report_id, scope_org_id(ctx), db)
    _audit(db, ctx, report_id, "AWR_AI_ANALYSIS", {"status": res.get("status"), "code": res.get("code"),
                                                   "dropped": res.get("dropped_unsupported"), "model": res.get("model")})
    return res
