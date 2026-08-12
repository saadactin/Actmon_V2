"""
Database Agent Monitoring routes — the checks catalogue/runner and real-event
timeline behind the Database Agent page (Agents module). Nothing here runs on
a schedule; every check executes only when POSTed explicitly.
"""
from datetime import datetime

from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.models.connection_model import ConnectionMaster
from app.models.db_check_run_model import DbCheckRun
from app.services.common import db_agent_checks as checks

router = APIRouter(prefix="/api/v1/agents/db-agent", tags=["Database Agent Monitoring"])


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _rollup(conn_id: int, check_id: str, tech: str, db: Session) -> dict:
    last = (
        db.query(DbCheckRun)
        .filter(DbCheckRun.connection_id == conn_id, DbCheckRun.check_id == check_id)
        .order_by(DbCheckRun.checked_at.desc())
        .first()
    )
    last_success = (
        db.query(DbCheckRun)
        .filter(DbCheckRun.connection_id == conn_id, DbCheckRun.check_id == check_id, DbCheckRun.status == "passed")
        .order_by(DbCheckRun.checked_at.desc())
        .first()
    )
    last_failure = (
        db.query(DbCheckRun)
        .filter(DbCheckRun.connection_id == conn_id, DbCheckRun.check_id == check_id, DbCheckRun.status == "failed")
        .order_by(DbCheckRun.checked_at.desc())
        .first()
    )
    failure_count = (
        db.query(DbCheckRun)
        .filter(DbCheckRun.connection_id == conn_id, DbCheckRun.check_id == check_id, DbCheckRun.status == "failed")
        .count()
    )
    if not last:
        return {
            "status": "never_run", "last_run": None, "duration_ms": None,
            "last_success_at": None, "last_failure_at": None, "failure_count": 0,
            "output": None, "error": None, "permission_issue": None,
        }
    return {
        "status": last.status,
        "last_run": last.checked_at.isoformat() if last.checked_at else None,
        "duration_ms": last.duration_ms,
        "last_success_at": last_success.checked_at.isoformat() if last_success and last_success.checked_at else None,
        "last_failure_at": last_failure.checked_at.isoformat() if last_failure and last_failure.checked_at else None,
        "failure_count": failure_count,
        "output": last.output,
        "error": last.error,
        # Re-derived from the persisted error rather than stored redundantly —
        # the classifier is cheap and this keeps db_check_runs a plain result log.
        "permission_issue": checks._permission_issue(tech, last.error or ""),
    }


@router.get("/{conn_id}/info", summary="The connection's own identity fields — host/port/database/instance — for the Database Agent page's Top Status section")
def route_connection_info(conn_id: int, db: Session = Depends(get_db)):
    rec = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
    if not rec:
        return {"status": "error", "error": "Connection not found"}
    return {
        "status": "success",
        "connection_name": rec.connection_name,
        "db_type": rec.db_type,
        "host": rec.host,
        "port": rec.port,
        "database_name": rec.database_name,
        "instance_name": rec.instance_name,
        "service_name": rec.service_name,
        "sid": rec.sid,
    }


@router.get("/{conn_id}/checks", summary="The check catalogue for this connection's technology, with each check's last-run rollup — nothing here executes anything")
def route_list_checks(conn_id: int, db: Session = Depends(get_db)):
    rec = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
    if not rec:
        return {"status": "error", "error": "Connection not found"}
    catalog = checks.catalog_for(rec.db_type)
    if not catalog:
        return {"status": "success", "supported": False, "checks": []}
    out = []
    for c in catalog:
        out.append({**c, **_rollup(conn_id, c["id"], rec.db_type, db)})
    return {"status": "success", "supported": True, "checks": out}


@router.post("/{conn_id}/checks/{check_id}/run", summary="Run ONE check now (explicit action only — never scheduled) and persist the result")
def route_run_check(conn_id: int, check_id: str, db: Session = Depends(get_db)):
    result = checks.run_check(conn_id, check_id, db)
    if result.get("status") == "error":
        return {"status": "error", "error": result.get("error")}
    db.add(DbCheckRun(
        connection_id=conn_id, check_id=check_id, status=result["status"],
        duration_ms=result.get("duration_ms"), output=result.get("output"), error=result.get("error"),
    ))
    db.commit()
    return {"status": "success", "check": result}


@router.get("/{conn_id}/checks/{check_id}/history", summary="Past runs of one check, most recent first — real db_check_runs rows only")
def route_check_history(conn_id: int, check_id: str, db: Session = Depends(get_db)):
    rows = (
        db.query(DbCheckRun)
        .filter(DbCheckRun.connection_id == conn_id, DbCheckRun.check_id == check_id)
        .order_by(DbCheckRun.checked_at.desc())
        .limit(25)
        .all()
    )
    return {
        "status": "success",
        "runs": [
            {
                "checked_at": r.checked_at.isoformat() if r.checked_at else None,
                "status": r.status,
                "duration_ms": r.duration_ms,
                "output": r.output,
                "error": r.error,
            }
            for r in rows
        ],
    }


@router.get("/{conn_id}/timeline", summary="Real monitoring events only — agent enrollment, connectivity notifications, and check history; no invented steps")
def route_timeline(conn_id: int, db: Session = Depends(get_db)):
    rec = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
    if not rec:
        return {"status": "error", "error": "Connection not found"}

    events = []

    agent_row = db.execute(text(
        "SELECT agent_name, created_at, status FROM agents WHERE db_connection_id = :c LIMIT 1"
    ), {"c": conn_id}).first()
    agent_name = agent_row.agent_name if agent_row else None
    if agent_row and agent_row.created_at:
        events.append({"label": "Agent Started", "timestamp": agent_row.created_at.isoformat(), "detail": agent_row.agent_name})

    if agent_name:
        notif_rows = db.execute(text(
            "SELECT message, severity, created_at FROM agent_notifications "
            "WHERE agent_name = :n ORDER BY created_at DESC LIMIT 20"
        ), {"n": agent_name}).fetchall()
        for n in notif_rows:
            events.append({
                "label": "Warning" if n.severity == "warning" else ("Critical" if n.severity == "critical" else "Notice"),
                "timestamp": n.created_at.isoformat() if n.created_at else None,
                "detail": n.message,
            })

    check_rows = (
        db.query(DbCheckRun)
        .filter(DbCheckRun.connection_id == conn_id)
        .order_by(DbCheckRun.checked_at.desc())
        .limit(20)
        .all()
    )
    for r in check_rows:
        label = "Check Successful" if r.status == "passed" else ("Check Failed" if r.status == "failed" else "Check Run")
        events.append({
            "label": label,
            "timestamp": r.checked_at.isoformat() if r.checked_at else None,
            "detail": f"{r.check_id}: {r.error or r.output or r.status}",
        })

    events.sort(key=lambda e: e["timestamp"] or "", reverse=True)
    return {"status": "success", "events": events}
