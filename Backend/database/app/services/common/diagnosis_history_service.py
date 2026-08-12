"""
Diagnosis History — a run is created only when the administrator actually
executes the first check of a Diagnosis session (never on merely opening the
page), then updated as RCA/AI/actions happen. See app/models/diagnosis_run_model.py.
"""
from datetime import datetime

from sqlalchemy.orm import Session

from app.models.diagnosis_run_model import DiagnosisRun


def start_run(conn_id: int, header: dict, db: Session) -> int:
    row = DiagnosisRun(
        connection_id=conn_id,
        status=(header or {}).get("current_status"),
        severity=(header or {}).get("severity"),
        checks_run=[],
        actions_performed=[],
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row.id


def record_check(run_id: int, check_result: dict, db: Session) -> None:
    row = db.query(DiagnosisRun).filter(DiagnosisRun.id == run_id).first()
    if not row:
        return
    checks = list(row.checks_run or [])
    checks.append({
        "id": check_result.get("id"),
        "title": check_result.get("title"),
        "status": check_result.get("status"),
    })
    row.checks_run = checks
    db.commit()


def record_rca(run_id: int, rca: dict, db: Session) -> None:
    row = db.query(DiagnosisRun).filter(DiagnosisRun.id == run_id).first()
    if not row:
        return
    row.root_cause = (rca or {}).get("primary_cause") or (rca or {}).get("reason")
    row.confidence = (rca or {}).get("confidence")
    row.finished_at = datetime.utcnow()
    db.commit()


def record_ai(run_id: int, ai: dict, db: Session) -> None:
    row = db.query(DiagnosisRun).filter(DiagnosisRun.id == run_id).first()
    if not row:
        return
    row.ai_summary = ai
    db.commit()


def record_action(run_id: int, action: str, unit: str, result: str, db: Session) -> None:
    row = db.query(DiagnosisRun).filter(DiagnosisRun.id == run_id).first()
    if not row:
        return
    actions = list(row.actions_performed or [])
    actions.append({
        "action": action, "unit": unit, "result": result,
        "at": datetime.utcnow().isoformat(),
    })
    row.actions_performed = actions
    db.commit()


def list_runs(conn_id: int, db: Session, limit: int = 50) -> list:
    rows = (
        db.query(DiagnosisRun)
        .filter(DiagnosisRun.connection_id == conn_id)
        .order_by(DiagnosisRun.started_at.desc())
        .limit(limit)
        .all()
    )
    return [_to_summary(r) for r in rows]


def get_run(run_id: int, db: Session) -> dict | None:
    row = db.query(DiagnosisRun).filter(DiagnosisRun.id == run_id).first()
    if not row:
        return None
    return {
        **_to_summary(row),
        "ai_summary": row.ai_summary,
    }


def _to_summary(row: DiagnosisRun) -> dict:
    return {
        "id": row.id,
        "connection_id": row.connection_id,
        "started_at": row.started_at.isoformat() if row.started_at else None,
        "finished_at": row.finished_at.isoformat() if row.finished_at else None,
        "status": row.status,
        "severity": row.severity,
        "checks_run": row.checks_run or [],
        "root_cause": row.root_cause,
        "confidence": row.confidence,
        "actions_performed": row.actions_performed or [],
    }
