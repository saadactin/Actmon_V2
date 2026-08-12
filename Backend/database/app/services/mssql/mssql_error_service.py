import datetime
import re
from fastapi import HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import create_engine, text
from urllib.parse import quote_plus

from app.models.connection_model import ConnectionMaster
from app.services.mssql.mssql_ai_analysis import analyze_mssql_error


def _get_conn_or_404(connection_id: int, db: Session) -> ConnectionMaster:
    connection = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == connection_id,
        ConnectionMaster.db_type == "mssql",
    ).first()
    if not connection:
        raise HTTPException(status_code=404, detail="MSSQL connection not found")
    return connection


def _engine(connection: ConnectionMaster):
    from app.services.common import db_proxy_service
    return db_proxy_service.engine_for(connection, lambda: create_engine(
        f"mssql+pyodbc://{connection.username}:{quote_plus(connection.password)}"
        f"@{connection.host}:{connection.port}/{connection.database_name or 'master'}"
        f"?driver=ODBC+Driver+17+for+SQL+Server",
        echo=False,
    ))


def analyze_error(connection_id: int, error_data: dict, db: Session):
    connection = _get_conn_or_404(connection_id, db)
    try:
        engine = _engine(connection)
        analysis = analyze_mssql_error(
            error_message=error_data.get("error_message", ""),
            error_code=error_data.get("error_code", ""),
            engine=engine,
        )
        return {
            "status": "success",
            "data": {
                "analysis": analysis,
                "timestamp": datetime.datetime.now().isoformat(),
            },
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


def get_error_logs(connection_id: int, limit: int, db: Session):
    """Reads the real SQL Server error log via xp_readerrorlog — the actual
    instance error log, not a DMV (sys.dm_exec_query_stats has no error
    columns at all; that query could never have returned real data)."""
    connection = _get_conn_or_404(connection_id, db)
    try:
        engine = _engine(connection)
        with engine.connect() as conn:
            result = conn.execute(text("EXEC xp_readerrorlog 0, 1"))
            rows = [dict(row._mapping) for row in result.fetchall()]
        # xp_readerrorlog returns the current log oldest-first; take the most recent `limit`.
        recent = list(reversed(rows[-limit:]))
        logs = []
        for r in recent:
            msg = r.get("Text") or ""
            sev = "ERROR" if re.search(r"\b(error|fail(ed)?|severity\s*1[6-9]|severity\s*2\d)\b", msg, re.I) \
                else "WARNING" if re.search(r"\bwarning\b", msg, re.I) else "INFO"
            logs.append({"timestamp": r.get("LogDate"), "message": msg, "severity": sev,
                         "process_info": r.get("ProcessInfo")})
        return {"status": "success", "data": logs, "source": "xp_readerrorlog"}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


def get_metrics(connection_id: int, db: Session):
    connection = _get_conn_or_404(connection_id, db)
    try:
        engine = _engine(connection)
        with engine.connect() as conn:
            cpu_data = conn.execute(text("""
                SELECT SUM(total_worker_time) / 1000000 as cpu_seconds
                FROM sys.dm_exec_query_stats
            """)).fetchone()

            memory_data = conn.execute(text("""
                SELECT SUM(total_physical_reads) as physical_reads,
                       SUM(total_logical_reads) as logical_reads
                FROM sys.dm_exec_query_stats
            """)).fetchone()

        return {
            "status": "success",
            "data": {
                "cpu_seconds": cpu_data[0] or 0,
                "physical_reads": memory_data[0] or 0,
                "logical_reads": memory_data[1] or 0,
            },
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
