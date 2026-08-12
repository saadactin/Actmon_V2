"""Database Diagnosis Center routes — live service/port/error checks via the agent."""
from fastapi import APIRouter, Body, Depends
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.models.connection_model import ConnectionMaster
from app.services.common import db_diagnose_service as svc
from app.services.common import pg_diagnose_service as pgsvc
from app.services.common import diagnose_engine as eng
from app.services.common import diagnose_orchestrate_service as orch
from app.services.common import diagnose_ai_service as ai_svc
from app.services.common import diagnosis_history_service as hist

router = APIRouter(prefix="/api/v1/databases", tags=["Database Diagnosis"])


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# ── Real-time, step-by-step diagnosis engine (all engines) ──────────────────
@router.get("/{conn_id}/diagnose/plan", summary="Unified, selectable check catalogue for this engine (System/Network/Database/Logs) — nothing here runs until /diagnose/check/{id} is called")
def route_plan(conn_id: int, db: Session = Depends(get_db)):
    rec = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
    if not rec:
        return {"status": "error", "error": "Connection not found"}
    os_plan = eng.plan(rec.db_type, conn_id, db)
    checks = os_plan["checks"] + orch.db_checks_plan(rec.db_type)
    return {"status": "success", "engine": os_plan["engine"], "checks": checks}


@router.get("/{conn_id}/diagnose/connect", summary="Detect & establish the best connection method")
def route_connect(conn_id: int, db: Session = Depends(get_db)):
    return eng.detect(conn_id, db)


@router.get("/{conn_id}/diagnose/context", summary="DB info + latest journal/log errors (screen context)")
def route_context(conn_id: int, db: Session = Depends(get_db)):
    return eng.context(conn_id, db)


@router.get("/{conn_id}/diagnose/check/{check_id}", summary="Run ONE diagnostic check (real-time step)")
def route_check(conn_id: int, check_id: str, db: Session = Depends(get_db)):
    return orch.run_check_safe(conn_id, check_id, db)


@router.post("/{conn_id}/diagnose/rca", summary="Correlate step results into a root cause (after all checks)")
def route_rca(conn_id: int, payload: dict = Body(...), db: Session = Depends(get_db)):
    return {"status": "success", "rca": orch.get_rca(conn_id, payload.get("results") or [], db)}


def _is_pg(conn_id: int, db: Session) -> bool:
    rec = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
    return bool(rec and (rec.db_type or "").lower() in ("postgresql", "postgres"))


@router.get("/{conn_id}/diagnose", summary="Live diagnosis for a database connection")
def route_diagnose(conn_id: int, db: Session = Depends(get_db)):
    # PostgreSQL gets the deep, comprehensive engine; other engines use the generic one.
    if _is_pg(conn_id, db):
        return pgsvc.pg_deep_diagnose(conn_id, db)
    return svc.diagnose(conn_id, db)


# ── Diagnosis Window — the shared cross-technology UI's entry points ────────
@router.get("/{conn_id}/diagnose/overview", summary="Passive snapshot only — header, summary, host/OS health, timeline (no live probe; run checks explicitly for service/connectivity/database data)")
def route_overview(conn_id: int, db: Session = Depends(get_db)):
    return orch.get_overview(conn_id, db)


@router.post("/{conn_id}/diagnose/ai-analysis", summary="ActmonAI analysis over the real evidence bundle already collected")
def route_ai_analysis(conn_id: int, payload: dict = Body(...), db: Session = Depends(get_db)):
    return {"status": "success", "ai": ai_svc.analyze(payload)}


@router.post("/{conn_id}/diagnose/report", summary="Generate the diagnostic report (text) from the checks already run")
def route_report_generate(conn_id: int, payload: dict = Body(default={}), db: Session = Depends(get_db)):
    text_report = orch.build_report(conn_id, db, payload.get("results") or [], payload.get("ai"))
    return {"status": "success", "report": text_report}


@router.get("/{conn_id}/diagnose/report", summary="Download the RCA report (text) — legacy/simple form, no live checks")
def route_report(conn_id: int, db: Session = Depends(get_db)):
    text_report = orch.build_report(conn_id, db)
    fname = f"actmon-diagnosis-conn{conn_id}.txt"
    return Response(text_report, media_type="text/plain",
                    headers={"Content-Disposition": f'attachment; filename="{fname}"'})


@router.post("/{conn_id}/diagnose/start-service", summary="Start the DB service on the host (via agent)")
def route_start_service(conn_id: int, db: Session = Depends(get_db)):
    return svc.start_service(conn_id, db)


# Start/stop/restart is NOT duplicated here — the Diagnosis page calls the
# existing, already password-gated + audited `/os-servers/{server_id}/service-action`
# route directly (server_id/unit come from the "service" check's result), then
# records the outcome via /diagnose/history/{run_id}/action below.


# ── Diagnostic History — a run exists only once the admin has actually run a
# check (never on merely opening the page); see diagnosis_history_service.py ──

@router.get("/{conn_id}/diagnose/history", summary="Previous diagnosis runs for this connection")
def route_history_list(conn_id: int, db: Session = Depends(get_db)):
    return {"status": "success", "runs": hist.list_runs(conn_id, db)}


@router.get("/{conn_id}/diagnose/history/{run_id}", summary="One previous diagnosis run in full")
def route_history_get(conn_id: int, run_id: int, db: Session = Depends(get_db)):
    run = hist.get_run(run_id, db)
    if not run:
        return {"status": "error", "error": "Run not found"}
    return {"status": "success", "run": run}


@router.post("/{conn_id}/diagnose/history/start", summary="Start a new diagnosis-history run — called once, on the first check the admin runs in a session")
def route_history_start(conn_id: int, db: Session = Depends(get_db)):
    header = orch.get_overview(conn_id, db).get("header") or {}
    return {"status": "success", "run_id": hist.start_run(conn_id, header, db)}


@router.post("/{conn_id}/diagnose/history/{run_id}/check", summary="Record one executed check into the run")
def route_history_record_check(conn_id: int, run_id: int, payload: dict = Body(...), db: Session = Depends(get_db)):
    hist.record_check(run_id, payload, db)
    return {"status": "success"}


@router.post("/{conn_id}/diagnose/history/{run_id}/rca", summary="Record the computed root-cause analysis into the run")
def route_history_record_rca(conn_id: int, run_id: int, payload: dict = Body(...), db: Session = Depends(get_db)):
    hist.record_rca(run_id, payload, db)
    return {"status": "success"}


@router.post("/{conn_id}/diagnose/history/{run_id}/ai", summary="Record the ActmonAI analysis into the run")
def route_history_record_ai(conn_id: int, run_id: int, payload: dict = Body(...), db: Session = Depends(get_db)):
    hist.record_ai(run_id, payload, db)
    return {"status": "success"}


@router.post("/{conn_id}/diagnose/history/{run_id}/action", summary="Record a confirmed recovery action performed into the run")
def route_history_record_action(conn_id: int, run_id: int, payload: dict = Body(...), db: Session = Depends(get_db)):
    hist.record_action(run_id, payload.get("action"), payload.get("unit"), payload.get("result"), db)
    return {"status": "success"}
