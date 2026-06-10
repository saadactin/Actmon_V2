"""
Generic test-connection endpoint — called by the frontend before saving.
POST /api/v1/connections/test/{db_type}
"""
from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel
from sqlalchemy import create_engine, text
from sqlalchemy.exc import SQLAlchemyError
from urllib.parse import quote_plus

router = APIRouter(prefix="/api/v1/connections/test", tags=["Test Connection"])


class TestRequest(BaseModel):
    connection_name: Optional[str] = ""
    host: str
    port: int
    username: Optional[str] = ""
    password: Optional[str] = ""
    database_name: Optional[str] = ""
    ssl_mode: Optional[str] = None
    service_name: Optional[str] = None
    sid: Optional[str] = None
    auth_source: Optional[str] = None
    replica_set: Optional[str] = None


def _ok(info: str):
    return {"status": "success", "message": f"Connection successful. {info}".strip()}


def _fail(detail: str):
    from fastapi import HTTPException
    raise HTTPException(status_code=400, detail=detail)


# ── MySQL ──────────────────────────────────────────────────────
@router.post("/mysql")
def test_mysql(req: TestRequest):
    pw = quote_plus(req.password or "")
    db_part = req.database_name.strip() if req.database_name else ""

    def _try(db: str):
        url = f"mysql+pymysql://{req.username}:{pw}@{req.host}:{req.port}/{db}"
        eng = create_engine(url, connect_args={"connect_timeout": 5})
        with eng.connect() as conn:
            row = conn.execute(text("SELECT VERSION()")).fetchone()
            return row[0] if row else "?"

    try:
        ver = _try(db_part)
        msg = f"MySQL {ver}"
        if db_part:
            msg += f" — connected to '{db_part}'"
        return _ok(msg)
    except SQLAlchemyError as e:
        raw = _clean(e)
        # If a specific DB was given and it failed, retry without DB to distinguish
        # "can't connect at all" from "DB doesn't exist / no permission"
        if db_part:
            try:
                ver2 = _try("")
                _fail(
                    f"Server reachable (MySQL {ver2}) but database '{db_part}' failed: {raw}. "
                    f"Leave 'Database Name' blank or use a valid database on this server."
                )
            except Exception:
                pass
        _fail(f"MySQL connection failed: {raw}")
    except Exception as e:
        _fail(f"Error: {_clean(e)}")


# ── PostgreSQL ─────────────────────────────────────────────────
@router.post("/postgresql")
def test_postgresql(req: TestRequest):
    pw = quote_plus(req.password or "")
    ssl = req.ssl_mode or "prefer"
    url = f"postgresql+psycopg2://{req.username}:{pw}@{req.host}:{req.port}/{req.database_name or 'postgres'}"
    try:
        eng = create_engine(url, connect_args={"connect_timeout": 5, "sslmode": ssl})
        with eng.connect() as conn:
            row = conn.execute(text("SELECT VERSION()")).fetchone()
            ver = str(row[0])[:60] if row else "?"
        return _ok(ver)
    except SQLAlchemyError as e:
        _fail(f"PostgreSQL connection failed: {_clean(e)}")
    except Exception as e:
        _fail(f"Error: {_clean(e)}")


# ── MSSQL ──────────────────────────────────────────────────────
@router.post("/mssql")
def test_mssql(req: TestRequest):
    pw = quote_plus(req.password or "")
    db_specified = (req.database_name or "").strip()

    def _try_pyodbc(db: str):
        url = (
            f"mssql+pyodbc://{req.username}:{pw}@{req.host}:{req.port}/{db}"
            f"?driver=ODBC+Driver+17+for+SQL+Server&timeout=5&TrustServerCertificate=yes"
        )
        eng = create_engine(url, fast_executemany=True)
        with eng.connect() as conn:
            row = conn.execute(text("SELECT @@VERSION")).fetchone()
            return str(row[0])[:100] if row else "?"

    def _try_pymssql(db: str):
        url = f"mssql+pymssql://{req.username}:{pw}@{req.host}:{req.port}/{db}?timeout=5"
        eng = create_engine(url)
        with eng.connect() as conn:
            row = conn.execute(text("SELECT @@VERSION")).fetchone()
            return str(row[0])[:100] if row else "?"

    last_error = ""
    for db in ([db_specified, "master"] if db_specified else ["master"]):
        for _try in [_try_pyodbc, _try_pymssql]:
            try:
                ver = _try(db)
                msg = ver
                if db_specified and db == db_specified:
                    msg += f" — connected to '{db_specified}'"
                elif db_specified and db == "master":
                    msg += f" — server reachable but database '{db_specified}' not accessible; connected to master"
                return _ok(msg)
            except Exception as e:
                raw = _clean(e)
                last_error = raw
                # If it's an auth error (18456), no point retrying different DBs
                if "18456" in raw or "Login failed" in raw:
                    _fail(
                        f"SQL Server login failed (Error 18456). "
                        f"Check: (1) SQL Server has Mixed Mode Authentication enabled, "
                        f"(2) user '{req.username}' exists in SQL Server logins, "
                        f"(3) password is correct. "
                        f"In SSMS: Security → Logins → right-click server → Properties → Security → 'SQL Server and Windows Authentication mode'."
                    )

    _fail(f"MSSQL connection failed: {last_error}")


# ── MongoDB ────────────────────────────────────────────────────
@router.post("/mongodb")
def test_mongodb(req: TestRequest):
    try:
        import pymongo
        auth = f"{req.username}:{quote_plus(req.password or '')}@" if req.username else ""
        rs = f"?replicaSet={req.replica_set}" if req.replica_set else ""
        auth_src = req.auth_source or "admin"
        uri = f"mongodb://{auth}{req.host}:{req.port}/{req.database_name or ''}{rs}"
        client = pymongo.MongoClient(uri, authSource=auth_src, serverSelectionTimeoutMS=5000)
        info = client.server_info()
        client.close()
        return _ok(f"MongoDB {info.get('version', '?')}")
    except Exception as e:
        _fail(f"MongoDB connection failed: {_clean(e)}")


# ── Oracle ─────────────────────────────────────────────────────
@router.post("/oracle")
def test_oracle(req: TestRequest):
    try:
        pw = quote_plus(req.password or "")
        dsn = req.service_name or req.sid or req.database_name or req.host
        url = f"oracle+cx_oracle://{req.username}:{pw}@{req.host}:{req.port}/?service_name={dsn}"
        eng = create_engine(url, connect_args={"timeout": 5})
        with eng.connect() as conn:
            row = conn.execute(text("SELECT BANNER FROM v$version WHERE ROWNUM=1")).fetchone()
            ver = str(row[0])[:80] if row else "?"
        return _ok(ver)
    except SQLAlchemyError as e:
        _fail(f"Oracle connection failed: {_clean(e)}")
    except Exception as e:
        _fail(f"Error: {_clean(e)}")


# ── ClickHouse ─────────────────────────────────────────────────
@router.post("/clickhouse")
def test_clickhouse(req: TestRequest):
    try:
        pw = quote_plus(req.password or "")
        url = f"clickhouse+http://{req.username}:{pw}@{req.host}:{req.port}/{req.database_name or 'default'}"
        eng = create_engine(url)
        with eng.connect() as conn:
            row = conn.execute(text("SELECT version()")).fetchone()
            ver = str(row[0]) if row else "?"
        return _ok(f"ClickHouse {ver}")
    except SQLAlchemyError as e:
        _fail(f"ClickHouse connection failed: {_clean(e)}")
    except Exception as e:
        _fail(f"Error: {_clean(e)}")


def _clean(e: Exception) -> str:
    """Return a short, readable error string from a SQLAlchemy or pymysql exception."""
    # SQLAlchemy wraps pymysql/psycopg2 errors. The real cause is in e.__cause__ or e.orig
    orig = getattr(e, 'orig', None) or getattr(e, '__cause__', None)
    if orig:
        return str(orig)[:300]

    msg = str(e)
    # Strip the SQLAlchemy docs URL noise that appears after \n
    if '\n' in msg:
        msg = msg.split('\n')[0].strip()
    # Strip leading "(pymysql.err.OperationalError) " etc.
    import re
    match = re.match(r'^\([^)]+\)\s*(.*)', msg)
    if match:
        msg = match.group(1).strip()
    return msg[:300]
