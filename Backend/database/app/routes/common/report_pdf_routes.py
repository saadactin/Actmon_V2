"""
Download a report as a REAL PDF — one endpoint, all four DB engines.

Why this exists: the Reports page's "Download PDF" button used to call
`window.print()`, which hands the browser the whole app (nav bar included) and
produces a screenshot-like page dump rather than a document. Meanwhile the
scheduled-report email has always built a genuine fpdf2 document — vector text,
styled section headers, real tables, page footers — via each engine's own
`generate_<engine>_pdf()`. That generator was simply unreachable from the UI
because nothing served it over HTTP. This route closes that gap: same data, same
generator, now downloadable.

Deliberately one shared module rather than a near-identical route in each
engine's own routes file — the four `*_report_email_service` modules already
expose the same two functions under different names, so the only per-engine
difference is which pair to call.
"""
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.models.connection_model import ConnectionMaster

router = APIRouter(prefix="/api/v1", tags=["report-pdf"])


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _mysql():
    from app.services.mysql import mysql_report_email_service as s
    return s._collect_report_data, s.generate_mysql_pdf, True


def _postgres():
    from app.services.postgres import postgres_report_email_service as s
    return s._collect_report_data, s.generate_postgres_pdf, False


def _mssql():
    from app.services.mssql import mssql_report_email_service as s
    return s._collect_report_data, s.generate_mssql_pdf, False


def _oracle():
    from app.services.oracle import oracle_report_email_service as s
    return s._collect_report_data, s.generate_oracle_pdf, False


# engine slug -> (loader, db_type in connection_master, filename stem)
# Both "postgres-report" and "pg-report" are accepted: the frontend's shared
# ReportShell builds its URLs from ENGINE.reportPrefix, which says "pg" for
# PostgreSQL while every backend route says "postgres".
_ENGINES = {
    "mysql":    (_mysql,    "mysql",      "MySQL"),
    "postgres": (_postgres, "postgresql", "PostgreSQL"),
    "pg":       (_postgres, "postgresql", "PostgreSQL"),
    "mssql":    (_mssql,    "mssql",      "SQLServer"),
    "oracle":   (_oracle,   "oracle",     "Oracle"),
}


def _self_base_url(request: Request) -> str:
    """The app's own origin, taken from the socket it is actually listening on
    rather than a hardcoded port. The report collectors fetch this app's own
    monitoring endpoints over HTTP, so this has to be right — the scheduled-email
    path hardcodes http://localhost:8000, which silently collects nothing on any
    deployment not using that port."""
    server = request.scope.get("server") or ("127.0.0.1", 8000)
    return f"http://127.0.0.1:{server[1]}"


@router.get("/{engine}-report/{conn_id}/pdf")
def download_report_pdf(
    engine: str,
    conn_id: int,
    request: Request,
    report_period: str = Query("live"),
    db: Session = Depends(get_db),
):
    entry = _ENGINES.get(engine.lower())
    if not entry:
        raise HTTPException(404, f"Unknown report engine '{engine}'")
    loader, db_type, stem = entry

    try:
        collect, generate, collector_takes_period = loader()
    except ImportError as exc:
        raise HTTPException(500, f"Report service unavailable: {exc}")

    conn = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == conn_id, ConnectionMaster.db_type == db_type
    ).first()
    if not conn:
        raise HTTPException(404, "Connection not found")

    base_url = _self_base_url(request)
    data = (collect(conn_id, base_url, report_period) if collector_takes_period
            else collect(conn_id, base_url))

    db_label = conn.connection_name or f"{stem} DB #{conn_id}"
    try:
        pdf_bytes = generate(
            db_label, report_period, data,
            conn_host=conn.host, conn_db=conn.database_name,
        )
    except ImportError as exc:
        # fpdf2 is imported lazily inside the generators. The email path
        # swallows this and sends without an attachment; a download has no
        # such fallback — an empty response would look like a broken button,
        # so say plainly what is missing.
        raise HTTPException(500, f"PDF library not installed on the server (fpdf2): {exc}")
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(500, f"PDF generation failed: {exc}")

    safe_name = "".join(c if c.isalnum() or c in "-_" else "_" for c in db_label)
    filename = f"{stem}_Report_{safe_name}_{report_period}.pdf"
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
