"""
Scheduled Reports — one place to see and control EVERY report schedule.

Until now schedules could only be listed per-engine AND per-connection
(GET /{engine}-report/schedules/{conn_id}), so there was no way to answer
"what is scheduled to email anyone, anywhere?" — let alone stop it — without
knowing every connection id up front. That is exactly the question you need
answered when mail is going out unexpectedly.

  GET    /api/v1/report-schedules              — every schedule, all engines
  PATCH  /api/v1/report-schedules/{eng}/{id}    — enable / disable one
  DELETE /api/v1/report-schedules/{eng}/{id}    — remove one
  POST   /api/v1/report-schedules/disable-all   — emergency stop-everything

Disabling is preferred over deleting: the scheduler skips disabled rows on its
next tick (within 60s) while the configuration is preserved.
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.models.mysql_report_schedule_model import MysqlReportSchedule
from app.models.postgres_report_schedule_model import PostgresReportSchedule
from app.models.mssql_report_schedule_model import MssqlReportSchedule
from app.models.oracle_report_schedule_model import OracleReportSchedule

router = APIRouter(prefix="/api/v1/report-schedules", tags=["report-schedules"])

# engine key -> (model, human label)
ENGINES = {
    "mysql":      (MysqlReportSchedule,    "MySQL"),
    "postgresql": (PostgresReportSchedule, "PostgreSQL"),
    "mssql":      (MssqlReportSchedule,    "SQL Server"),
    "oracle":     (OracleReportSchedule,   "Oracle"),
}


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


class ToggleBody(BaseModel):
    enabled: bool


def _model_for(engine: str):
    entry = ENGINES.get((engine or "").lower())
    if not entry:
        raise HTTPException(status_code=400,
                            detail=f"Unknown engine '{engine}'. Expected one of: {', '.join(ENGINES)}")
    return entry[0]


def _row_to_dict(engine: str, label: str, r) -> dict:
    import json
    try:
        recipients = json.loads(r.recipient_emails or "[]")
    except Exception:  # noqa: BLE001 — a malformed value must still list
        recipients = [str(r.recipient_emails or "")]
    return {
        "engine": engine, "engine_label": label,
        "id": r.id, "conn_id": r.conn_id, "schedule_name": r.schedule_name,
        "frequency": r.frequency, "hour": r.hour, "minute": r.minute,
        "day_of_week": r.day_of_week, "day_of_month": r.day_of_month,
        "recipients": recipients, "recipient_count": len(recipients),
        "report_period": r.report_period, "enabled": bool(r.enabled),
        "last_sent_at": r.last_sent_at.isoformat() if r.last_sent_at else None,
        "next_run_at": r.next_run_at.isoformat() if r.next_run_at else None,
        "last_status": r.last_status,
        "sender_email": r.sender_email,
    }


@router.get("")
def list_all_schedules(db: Session = Depends(get_db)):
    """Every schedule across every engine. A missing table (engine never used on
    this install) is skipped rather than failing the whole listing."""
    out, errors = [], {}
    for engine, (model, label) in ENGINES.items():
        try:
            for r in db.query(model).order_by(model.id).all():
                out.append(_row_to_dict(engine, label, r))
        except Exception as e:  # noqa: BLE001
            db.rollback()
            errors[engine] = str(e)[:200]
    out.sort(key=lambda s: (not s["enabled"], s["engine"], s["id"]))
    return {
        "schedules": out,
        "total": len(out),
        "enabled_count": sum(1 for s in out if s["enabled"]),
        "errors": errors or None,
    }


@router.patch("/{engine}/{sched_id}")
def toggle_schedule(engine: str, sched_id: int, body: ToggleBody,
                     db: Session = Depends(get_db)):
    model = _model_for(engine)
    row = db.query(model).filter(model.id == sched_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Schedule not found")
    try:
        row.enabled = body.enabled
        db.commit()
        return {"status": "success", "engine": engine, "id": sched_id,
                "enabled": bool(row.enabled),
                "message": ("Enabled — it will run at its next scheduled time."
                            if body.enabled else
                            "Disabled — the scheduler will skip it from its next tick (within 60s).")}
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not update the schedule: {e}")


@router.delete("/{engine}/{sched_id}")
def delete_schedule(engine: str, sched_id: int, db: Session = Depends(get_db)):
    model = _model_for(engine)
    row = db.query(model).filter(model.id == sched_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Schedule not found")
    try:
        db.delete(row)
        db.commit()
        return {"status": "success", "message": "Schedule deleted."}
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not delete the schedule: {e}")


@router.post("/disable-all")
def disable_all(db: Session = Depends(get_db)):
    """Stop every scheduled report at once. Nothing is deleted — each row keeps
    its configuration and can be re-enabled individually."""
    changed = 0
    for _engine, (model, _label) in ENGINES.items():
        try:
            changed += (db.query(model)
                          .filter(model.enabled == True)  # noqa: E712
                          .update({"enabled": False}, synchronize_session=False)) or 0
        except Exception:  # noqa: BLE001 — a missing table shouldn't block the rest
            db.rollback()
    db.commit()
    return {"status": "success", "disabled": changed,
            "message": f"Disabled {changed} schedule(s). The scheduler stops sending within 60 seconds."}
