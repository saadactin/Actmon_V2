"""
Oracle Storage Health — Phase 3 approval/execution service.

Turns one of Phase 2's live findings into a durable, audited job: request ->
approve/reject -> (job runner executes) -> result. Only findings whose
recommended_action is in EXECUTABLE_ACTIONS can ever reach a job row — the
rest (tablespace/datafile management, partition maintenance, continue
monitoring) need a human-supplied parameter this system can't safely infer,
so they stay informational-only (see the Phase 3 plan's "Scope decision").

request_maintenance() re-runs the decision engine live (never trusts a stale
client-supplied finding) and builds proposed_sql from the MATCHED finding's
own object_name — which is itself built from Oracle dictionary data, not
directly from the caller's request string — before it's ever templated into
SQL.
"""

from datetime import datetime, timezone
from decimal import Decimal

from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.connection_model import ConnectionMaster
from app.models.oracle_maintenance_job_model import OracleMaintenanceJob
from app.services.oracle.oracle_storage_decision_service import oracle_storage_findings

EXECUTABLE_ACTIONS = {"shrink_space", "move", "index_maintenance_rebuild"}

ACTIVE_STATUSES = ("pending_approval", "approved", "running")


def _build_proposed_sql(recommended_action, object_name):
    if "." not in object_name:
        raise ValueError(f"object_name must be OWNER.NAME, got: {object_name!r}")
    owner, name = object_name.split(".", 1)
    if recommended_action == "shrink_space":
        return f"ALTER TABLE {owner}.{name} SHRINK SPACE"
    if recommended_action == "move":
        return f"ALTER TABLE {owner}.{name} MOVE"
    if recommended_action == "index_maintenance_rebuild":
        return f"ALTER INDEX {owner}.{name} REBUILD"
    raise ValueError(f"unsupported recommended_action: {recommended_action}")


def _job_to_dict(job: OracleMaintenanceJob) -> dict:
    def _iso(v):
        # Every timestamp column here is set via datetime.utcnow() — genuinely
        # UTC, but naive (no tzinfo), so .isoformat() alone produces a string
        # with no timezone marker. The browser's `new Date(...)` then reads
        # that as LOCAL time instead of UTC, silently shifting every
        # timestamp by the browser's UTC offset (5:30 for IST — exactly the
        # "330m elapsed" bug). Appending "Z" makes it unambiguous.
        return (v.isoformat() + "Z") if v else None

    def _num(v):
        return float(v) if isinstance(v, Decimal) else v

    return {
        "id": job.id, "org_id": job.org_id, "conn_id": job.conn_id,
        "object_type": job.object_type, "object_name": job.object_name,
        "tablespace_name": job.tablespace_name,
        "detected_issue": job.detected_issue, "evidence": job.evidence,
        "recommended_action": job.recommended_action,
        "expected_benefit": job.expected_benefit, "risk": job.risk,
        "proposed_sql": job.proposed_sql,
        "status": job.status,
        "requested_by": job.requested_by, "requested_at": _iso(job.requested_at),
        "approved_by": job.approved_by, "approved_at": _iso(job.approved_at),
        "rejected_by": job.rejected_by, "rejected_at": _iso(job.rejected_at),
        "rejection_reason": job.rejection_reason,
        "start_requested_at": _iso(job.start_requested_at),
        "scheduled_at": _iso(job.scheduled_at),
        "notification_recipients": job.notification_recipients or [],
        "executed_sql": job.executed_sql,
        "execution_started_at": _iso(job.execution_started_at),
        "execution_ended_at": _iso(job.execution_ended_at),
        "before_metrics": job.before_metrics, "after_metrics": job.after_metrics,
        "reclaimed_mb": _num(job.reclaimed_mb), "error_details": job.error_details,
        "created_at": _iso(job.created_at), "updated_at": _iso(job.updated_at),
    }


def request_maintenance(conn_id: int, db: Session, object_type: str, object_name: str, claims: dict):
    conn = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == conn_id, ConnectionMaster.db_type == "oracle"
    ).first()
    if not conn:
        raise HTTPException(status_code=404, detail="Oracle connection not found")

    findings = oracle_storage_findings(conn_id, db).get("findings", [])
    match = next(
        (f for f in findings if f["object_type"] == object_type and f["object_name"] == object_name),
        None,
    )
    if match is None:
        raise HTTPException(
            status_code=400,
            detail="No current finding matches this object — it may no longer be a maintenance candidate.",
        )
    if match["recommended_action"] not in EXECUTABLE_ACTIONS:
        raise HTTPException(
            status_code=400,
            detail=f"'{match['recommended_action']}' requires manual execution outside ACTMON — "
                   "it needs a human-supplied parameter this system can't safely infer.",
        )

    proposed_sql = _build_proposed_sql(match["recommended_action"], match["object_name"])

    job = OracleMaintenanceJob(
        org_id=conn.org_id or 1, conn_id=conn_id,
        object_type=match["object_type"], object_name=match["object_name"],
        tablespace_name=match.get("tablespace_name"),
        detected_issue=match["problem"], evidence=match["evidence"],
        recommended_action=match["recommended_action"],
        expected_benefit=match.get("expected_benefit"), risk=match.get("risk"),
        proposed_sql=proposed_sql,
        status="pending_approval",
        requested_by=claims.get("user_id"),
    )
    db.add(job)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        existing = db.query(OracleMaintenanceJob).filter(
            OracleMaintenanceJob.conn_id == conn_id,
            OracleMaintenanceJob.object_type == object_type,
            OracleMaintenanceJob.object_name == object_name,
            OracleMaintenanceJob.status.in_(ACTIVE_STATUSES),
        ).first()
        if existing:
            detail = f"A maintenance job is already active for this object (job #{existing.id}, status={existing.status})."
        else:
            detail = "A maintenance job is already active for this object."
        raise HTTPException(status_code=409, detail=detail)
    db.refresh(job)
    return _job_to_dict(job)


def approve_maintenance(job_id: int, db: Session, claims: dict):
    job = db.query(OracleMaintenanceJob).filter(OracleMaintenanceJob.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Maintenance job not found")
    if job.status != "pending_approval":
        raise HTTPException(status_code=400, detail=f"Cannot approve a job in status '{job.status}'")
    if job.recommended_action not in EXECUTABLE_ACTIONS:
        raise HTTPException(status_code=400, detail=f"'{job.recommended_action}' is not an executable action")

    job.status = "approved"
    job.approved_by = claims.get("user_id")
    job.approved_at = datetime.utcnow()
    db.commit()
    db.refresh(job)
    return _job_to_dict(job)


def start_maintenance(job_id: int, db: Session, claims: dict, recipients: list = None):
    """Explicit human trigger — approving no longer auto-queues execution.
    The runner only ever picks up an 'approved' job once start_requested_at
    (or a due scheduled_at) is set, so this is the only thing that actually
    sets anything running immediately."""
    job = db.query(OracleMaintenanceJob).filter(OracleMaintenanceJob.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Maintenance job not found")
    if job.status != "approved":
        raise HTTPException(status_code=400, detail=f"Cannot start a job in status '{job.status}'")
    if job.start_requested_at is not None or job.scheduled_at is not None:
        raise HTTPException(status_code=400, detail="This job has already been started or scheduled")

    job.start_requested_at = datetime.utcnow()
    if recipients:
        job.notification_recipients = recipients
    db.commit()
    db.refresh(job)
    return _job_to_dict(job)


def schedule_maintenance(job_id: int, db: Session, claims: dict, scheduled_at: datetime, recipients: list = None):
    """Alternative to start_maintenance: pick a future UTC time instead of
    now. The runner (oracle_maintenance_job_runner.py) picks this up the
    same way once that time arrives."""
    job = db.query(OracleMaintenanceJob).filter(OracleMaintenanceJob.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Maintenance job not found")
    if job.status != "approved":
        raise HTTPException(status_code=400, detail=f"Cannot schedule a job in status '{job.status}'")
    if job.start_requested_at is not None or job.scheduled_at is not None:
        raise HTTPException(status_code=400, detail="This job has already been started or scheduled")

    # Every other timestamp column here is naive UTC (see _job_to_dict's
    # _iso()) — normalize a tz-aware value (Pydantic parses "...Z"/"+HH:MM"
    # into one) to naive UTC before comparing/storing, or this throws
    # comparing offset-naive datetime.utcnow() against an offset-aware value.
    if scheduled_at.tzinfo is not None:
        scheduled_at = scheduled_at.astimezone(timezone.utc).replace(tzinfo=None)
    if scheduled_at <= datetime.utcnow():
        raise HTTPException(status_code=400, detail="Scheduled time must be in the future")

    job.scheduled_at = scheduled_at
    if recipients:
        job.notification_recipients = recipients
    db.commit()
    db.refresh(job)
    return _job_to_dict(job)


def reject_maintenance(job_id: int, db: Session, claims: dict, reason: str = None):
    job = db.query(OracleMaintenanceJob).filter(OracleMaintenanceJob.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Maintenance job not found")
    if job.status != "pending_approval":
        raise HTTPException(status_code=400, detail=f"Cannot reject a job in status '{job.status}'")

    job.status = "rejected"
    job.rejected_by = claims.get("user_id")
    job.rejected_at = datetime.utcnow()
    job.rejection_reason = reason
    db.commit()
    db.refresh(job)
    return _job_to_dict(job)


def list_maintenance_jobs(db: Session, conn_id: int = None, status: str = None):
    q = db.query(OracleMaintenanceJob)
    if conn_id is not None:
        q = q.filter(OracleMaintenanceJob.conn_id == conn_id)
    if status:
        q = q.filter(OracleMaintenanceJob.status == status)
    jobs = q.order_by(OracleMaintenanceJob.created_at.desc()).limit(500).all()
    return {"status": "success", "jobs": [_job_to_dict(j) for j in jobs]}


def list_maintenance_jobs_all(db: Session, status: str = None):
    """Every Oracle maintenance job across every connection — the Maintenance
    Window page's feed. Same shape as list_maintenance_jobs(), with the
    owning connection's name/host attached since nothing else on this page
    scopes to a single connection the way Storage Health does."""
    q = db.query(OracleMaintenanceJob, ConnectionMaster).join(
        ConnectionMaster, ConnectionMaster.id == OracleMaintenanceJob.conn_id
    )
    if status:
        q = q.filter(OracleMaintenanceJob.status == status)
    rows = q.order_by(OracleMaintenanceJob.created_at.desc()).limit(1000).all()
    jobs = []
    for job, conn in rows:
        d = _job_to_dict(job)
        d["connection_name"] = conn.connection_name
        d["connection_host"] = conn.host
        jobs.append(d)
    return {"status": "success", "jobs": jobs}


def get_maintenance_job(job_id: int, db: Session):
    job = db.query(OracleMaintenanceJob).filter(OracleMaintenanceJob.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Maintenance job not found")
    return _job_to_dict(job)
