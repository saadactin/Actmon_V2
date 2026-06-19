from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import create_engine, text
from urllib.parse import quote_plus

from app.database.connection import SessionLocal
from app.models.connection_model import ConnectionMaster

router = APIRouter(
    prefix="/api/v1/connections/mysql",
    tags=["MySQL Explain"]
)

# SESSION
def get_db():

    db = SessionLocal()

    try:
        yield db

    finally:
        db.close()


# REQUEST MODEL
class ExplainRequest(BaseModel):

    query: str

    database: str | None = None


# EXPLAIN API
@router.post("/{conn_id}/explain")
def explain_query(
    conn_id: int,
    payload: ExplainRequest,
    db: Session = Depends(get_db)
):

    connection = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == conn_id
    ).first()

    if not connection:

        raise HTTPException(
            status_code=404,
            detail="Connection not found"
        )

    pw = quote_plus(connection.password or "")
    mysql_url = (
        f"mysql+pymysql://{connection.username}:"
        f"{pw}@"
        f"{connection.host}:"
        f"{connection.port}/"
        f"{payload.database or connection.database_name}"
    )

    try:

        engine = create_engine(mysql_url)

        explain_query = f"EXPLAIN {payload.query}"

        with engine.connect() as conn:

            result = conn.execute(
                text(explain_query)
            )

            rows = result.mappings().all()

        return {

            "status": "success",

            "data": rows
        }

    except Exception as e:

        return {

            "status": "error",

            "message": str(e)
        }