from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import create_engine, text
from sqlalchemy.exc import SQLAlchemyError
from urllib.parse import quote_plus
import datetime

from app.database.connection import SessionLocal
from app.models.connection_model import ConnectionMaster
from app.services.postgres_ai_analysis import analyze_postgresql_error

router = APIRouter(
    prefix="/api/v1/postgresql",
    tags=["PostgreSQL Error Analysis"]
)

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

# ANALYZE POSTGRESQL ERROR
@router.post("/{connection_id}/analyze-error")
def analyze_postgresql_error_endpoint(
    connection_id: int,
    error_data: dict,
    db: Session = Depends(get_db)
):
    connection = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == connection_id,
        ConnectionMaster.db_type == "postgresql"
    ).first()
    
    if not connection:
        raise HTTPException(status_code=404, detail="PostgreSQL connection not found")
    
    try:
        connection_string = f"postgresql://{connection.username}:{quote_plus(connection.password)}@{connection.host}:{connection.port}/{connection.database_name}"
        engine = create_engine(connection_string, echo=False)
        
        analysis = analyze_postgresql_error(
            error_message=error_data.get("error_message", ""),
            error_code=error_data.get("error_code", ""),
            engine=engine
        )
        
        return {
            "status": "success",
            "data": {
                "analysis": analysis,
                "timestamp": datetime.datetime.now().isoformat()
            }
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

# GET POSTGRESQL ERROR LOGS
@router.get("/{connection_id}/error-logs")
def get_postgresql_error_logs(
    connection_id: int,
    limit: int = 50,
    db: Session = Depends(get_db)
):
    connection = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == connection_id,
        ConnectionMaster.db_type == "postgresql"
    ).first()
    
    if not connection:
        raise HTTPException(status_code=404, detail="PostgreSQL connection not found")
    
    try:
        connection_string = f"postgresql://{connection.username}:{quote_plus(connection.password)}@{connection.host}:{connection.port}/{connection.database_name}"
        engine = create_engine(connection_string, echo=False)
        
        with engine.connect() as conn:
            query = text(f"""
                SELECT 
                    usename,
                    application_name,
                    state,
                    query_start,
                    state_change
                FROM pg_stat_activity
                WHERE state IS NOT NULL
                ORDER BY query_start DESC
                LIMIT {limit}
            """)
            result = conn.execute(query)
            # SQLAlchemy Row objects are not directly convertible with dict(row)
            # use the _mapping attribute to get a mapping of column names to values
            logs = [dict(row._mapping) for row in result.fetchall()]
        
        return {
            "status": "success",
            "data": logs
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

# GET POSTGRESQL PERFORMANCE METRICS
@router.get("/{connection_id}/metrics")
def get_postgresql_metrics(connection_id: int, db: Session = Depends(get_db)):
    connection = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == connection_id,
        ConnectionMaster.db_type == "postgresql"
    ).first()
    
    if not connection:
        raise HTTPException(status_code=404, detail="PostgreSQL connection not found")
    
    try:
        connection_string = f"postgresql://{connection.username}:{quote_plus(connection.password)}@{connection.host}:{connection.port}/{connection.database_name}"
        engine = create_engine(connection_string, echo=False)
        
        with engine.connect() as conn:
            # Get cache hit ratio
            cache_query = text("""
                SELECT
                    sum(heap_blks_read) as heap_read,
                    sum(heap_blks_hit) as heap_hit,
                    sum(heap_blks_hit) / (sum(heap_blks_hit) + sum(heap_blks_read)) as ratio
                FROM pg_statio_user_tables
            """)
            result = conn.execute(cache_query)
            cache_row = result.fetchone()
            
            # Get table sizes
            size_query = text("""
                SELECT
                    schemaname,
                    tablename,
                    pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) as size
                FROM pg_tables
                WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
                ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC
                LIMIT 10
            """)
            result = conn.execute(size_query)
            tables = [dict(row._mapping) for row in result.fetchall()]
        
        return {
            "status": "success",
            "data": {
                "cache_hit_ratio": float(cache_row[2]) if cache_row[2] else 0,
                "top_tables": tables
            }
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
