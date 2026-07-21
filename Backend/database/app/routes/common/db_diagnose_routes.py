"""Database Diagnosis Center routes — live service/port/error checks via the agent."""
from fastapi import APIRouter, Body, Depends
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.models.connection_model import ConnectionMaster
from app.services.common import db_diagnose_service as svc
from app.services.common import pg_diagnose_service as pgsvc
from app.services.common import diagnose_engine as eng

router = APIRouter(prefix="/api/v1/databases", tags=["Database Diagnosis"])


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# ── Real-time, step-by-step diagnosis engine (all engines) ──────────────────
@router.get("/{conn_id}/diagnose/plan", summary="Ordered list of diagnostic checks for this engine")
def route_plan(conn_id: int, db: Session = Depends(get_db)):
    rec = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
    if not rec:
        return {"status": "error", "error": "Connection not found"}
    return {"status": "success", **eng.plan(rec.db_type)}


@router.get("/{conn_id}/diagnose/connect", summary="Detect & establish the best connection method")
def route_connect(conn_id: int, db: Session = Depends(get_db)):
    return eng.detect(conn_id, db)


@router.get("/{conn_id}/diagnose/context", summary="DB info + latest journal/log errors (screen context)")
def route_context(conn_id: int, db: Session = Depends(get_db)):
    return eng.context(conn_id, db)


@router.get("/{conn_id}/diagnose/check/{check_id}", summary="Run ONE diagnostic check (real-time step)")
def route_check(conn_id: int, check_id: str, db: Session = Depends(get_db)):
    return eng.run_check(conn_id, check_id, db)


@router.post("/{conn_id}/diagnose/rca", summary="Correlate step results into a root cause (after all checks)")
def route_rca(conn_id: int, payload: dict = Body(...), db: Session = Depends(get_db)):
    return {"status": "success", "rca": eng.build_rca(conn_id, payload.get("results") or [], db)}


def _is_pg(conn_id: int, db: Session) -> bool:
    rec = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
    return bool(rec and (rec.db_type or "").lower() in ("postgresql", "postgres"))


@router.get("/{conn_id}/diagnose", summary="Live diagnosis for a database connection")
def route_diagnose(conn_id: int, db: Session = Depends(get_db)):
    # PostgreSQL gets the deep, comprehensive engine; other engines use the generic one.
    if _is_pg(conn_id, db):
        return pgsvc.pg_deep_diagnose(conn_id, db)
    return svc.diagnose(conn_id, db)


@router.get("/{conn_id}/diagnose/report", summary="Download the RCA report (text)")
def route_report(conn_id: int, db: Session = Depends(get_db)):
    text_report = pgsvc.build_report(conn_id, db)
    fname = f"actmon-diagnosis-conn{conn_id}.txt"
    return Response(text_report, media_type="text/plain",
                    headers={"Content-Disposition": f'attachment; filename="{fname}"'})


@router.post("/{conn_id}/diagnose/start-service", summary="Start the DB service on the host (via agent)")
def route_start_service(conn_id: int, db: Session = Depends(get_db)):
    return svc.start_service(conn_id, db)
