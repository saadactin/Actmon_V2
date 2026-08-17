"""
MySQL Monitoring Report API — one parameterized endpoint for every report
period, per §21's stated preference over duplicating a route per period.
Backed entirely by mysql_report_service.build_report(), the same function the
PDF export (screenshotting this page) and the scheduled-email report both
end up rendering — no separate report data source anywhere (§16, §31, §32).
"""
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.services.mysql import mysql_report_service

router = APIRouter(
    prefix="/api/v1/connections/mysql",
    tags=["MySQL Reports"],
)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@router.get("/{conn_id}/reports")
def get_mysql_report(
    conn_id: int,
    mode: str = Query("live", description="live | 2h | daily | weekly | monthly | custom"),
    from_: str = Query(None, alias="from", description="ISO timestamp — required when mode=custom"),
    to: str = Query(None, description="ISO timestamp — required when mode=custom"),
    db: Session = Depends(get_db),
):
    from_ts = to_ts = None
    if mode == "custom":
        if not from_ or not to:
            raise HTTPException(400, "mode=custom requires both 'from' and 'to' query params")
        try:
            from_ts = datetime.fromisoformat(from_.replace("Z", "+00:00")).replace(tzinfo=None)
            to_ts = datetime.fromisoformat(to.replace("Z", "+00:00")).replace(tzinfo=None)
        except ValueError:
            raise HTTPException(400, "'from'/'to' must be ISO-8601 timestamps")
        if to_ts <= from_ts:
            raise HTTPException(400, "'to' must be after 'from'")
    return mysql_report_service.build_report(conn_id, db, mode=mode, from_ts=from_ts, to_ts=to_ts)
