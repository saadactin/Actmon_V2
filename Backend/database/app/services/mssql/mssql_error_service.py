import datetime
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
    return create_engine(
        f"mssql+pyodbc://{connection.username}:{quote_plus(connection.password)}"
        f"@{connection.host}:{connection.port}/{connection.database_name or 'master'}"
        f"?driver=ODBC+Driver+17+for+SQL+Server",
        echo=False,
    )


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
    connection = _get_conn_or_404(connection_id, db)
    try:
        engine = _engine(connection)
        with engine.connect() as conn:
            result = conn.execute(text(f"""
                SELECT TOP {limit}
                    error_number,
                    severity,
                    message,
                    log_date
                FROM sys.dm_exec_query_stats
                ORDER BY log_date DESC
            """))
            logs = [dict(row) for row in result.fetchall()]
        return {"status": "success", "data": logs}
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
