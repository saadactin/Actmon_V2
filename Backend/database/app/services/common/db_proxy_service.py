"""
DB access router.

For a connection that belongs to an *agent-monitored* host, the database usually
listens on that host's localhost — which the ActMon backend cannot reach directly.
This routes the query through that host's agent (the agent runs where the DB lives,
so its 'localhost' is the right one). Standalone connections at a reachable IP keep
using a direct SQLAlchemy connection.

    runner = make_runner(conn, db)      # conn: ConnectionMaster row
    rows = runner("SHOW GLOBAL STATUS") # -> list[tuple]
    runner.via                          # 'agent' or 'direct'
"""
import json
import logging
from urllib.parse import quote_plus

from sqlalchemy import create_engine, text
from sqlalchemy.pool import NullPool

logger = logging.getLogger("db_proxy")


def agent_host_for_conn(conn_id, db):
    """Return the enrolled agent host (token/hostname) linked to this connection via
    database_instances, or None if the connection isn't tied to an agent host."""
    if not conn_id:
        return None
    return db.execute(text(
        "SELECT s.agent_token AS token, s.hostname AS hostname "
        "FROM database_instances di JOIN os_servers s ON s.id = di.server_id "
        "WHERE di.connection_id = :c AND s.collector = 'agent' "
        "AND s.agent_token IS NOT NULL AND s.agent_token <> '' LIMIT 1"
    ), {"c": conn_id}).first()


def _agent_dbquery(token, conn, sql):
    """Run one query on the host agent. Returns list[tuple], None if the agent didn't
    answer (caller should fall back to direct), or raises on a DB-side error."""
    from app.services.agent import agent_fs_service
    payload = json.dumps({
        "db_type": (conn.db_type or "").lower(),
        "host": conn.host or "127.0.0.1",
        "port": conn.port or 0,
        "user": conn.username or "",
        "password": conn.password or "",
        "database": conn.database_name or "",
        "sql": sql,
    })
    raw = agent_fs_service.request(token, "dbquery", payload)
    if raw is None:
        return None
    try:
        data = json.loads(raw.decode("utf-8", errors="replace"))
    except Exception as e:  # noqa: BLE001
        raise RuntimeError("agent returned malformed result: %s" % e)
    if isinstance(data, dict) and data.get("error"):
        raise RuntimeError(data["error"])
    return [tuple(r) for r in (data.get("rows") or [])]


def _mysql_url(conn):
    enc = quote_plus(conn.password) if conn.password else ""
    user = conn.username or ""
    pw = ":%s" % enc if conn.password else ""
    auth = "%s%s@" % (user, pw) if (user or pw) else ""
    return "mysql+pymysql://%s%s:%s/%s" % (auth, conn.host, conn.port, conn.database_name or "")


def _postgres_url(conn):
    enc = quote_plus(conn.password or "")
    ssl = conn.ssl_mode or "prefer"
    return "postgresql://%s:%s@%s:%s/%s?sslmode=%s" % (
        conn.username, enc, conn.host, conn.port, conn.database_name or "postgres", ssl)


def _direct_engine(conn):
    dbtype = (conn.db_type or "").lower()
    if dbtype in ("postgres", "postgresql"):
        url = _postgres_url(conn)
    else:
        url = _mysql_url(conn)
    return create_engine(url, connect_args={"connect_timeout": 10}, poolclass=NullPool)


def make_runner(conn, db):
    """Return q(sql) -> list[tuple]. Routes through the host agent when the connection
    belongs to an agent host (falling back to direct if the agent is unreachable),
    otherwise connects directly. `q.via` is 'agent' or 'direct'."""
    host = agent_host_for_conn(getattr(conn, "id", None), db)

    if host:
        _direct = {"engine": None}

        def _direct_q(sql):
            if _direct["engine"] is None:
                _direct["engine"] = _direct_engine(conn)
            with _direct["engine"].connect() as c:
                res = c.execute(text(sql))
                return [tuple(r) for r in res.fetchall()]

        def q(sql):
            rows = _agent_dbquery(host.token, conn, sql)
            if rows is not None:
                return rows
            logger.warning("[db_proxy] agent '%s' unreachable for conn %s — direct fallback",
                           host.hostname, getattr(conn, "id", "?"))
            return _direct_q(sql)

        q.via = "agent"
        return q

    engine_box = {"engine": None}

    def q(sql):
        if engine_box["engine"] is None:
            engine_box["engine"] = _direct_engine(conn)
        with engine_box["engine"].connect() as c:
            res = c.execute(text(sql))
            return [tuple(r) for r in res.fetchall()]

    q.via = "direct"
    return q


def check_connectivity(conn, db):
    """Lightweight 'can we reach this DB?' probe (via agent or direct). Returns
    (ok: bool, detail: str, via: str)."""
    try:
        runner = make_runner(conn, db)
        dbtype = (conn.db_type or "").lower()
        probe = "SELECT version()" if dbtype in ("postgres", "postgresql") else "SELECT VERSION()"
        rows = runner(probe)
        ver = (rows[0][0] if rows and rows[0] else "?")
        return True, str(ver), getattr(runner, "via", "direct")
    except Exception as e:  # noqa: BLE001
        return False, str(e), "agent" if agent_host_for_conn(getattr(conn, "id", None), db) else "direct"
