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
import time
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
            dbtype = (getattr(conn, "db_type", "") or "").lower()
            if not any(k in dbtype for k in _DIRECT_CAPABLE):
                # Server has no driver for this engine (oracle/mssql) and can't reach
                # the agent host's localhost — a direct try would only mislead.
                raise RuntimeError("The agent on the DB host did not answer in time.")
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


# ── Agent-routing engine shim ─────────────────────────────────────────────────
# Lets any service that does `_engine(conn).connect().execute(text(sql))` work
# transparently against an agent-hosted DB (localhost on the DB host, which the
# backend can't reach). Only agent-linked connections use it; direct connections
# get their real engine back, so their behaviour is 100% unchanged.

# Per-agent capability cache: once an agent proves it can't answer dbquery for a
# connection (old bash agent, offline, or unsupported engine like Oracle), we stop
# routing through it and go direct for a while — so one slow probe, not one per query.
_AGENT_CAP = {}                 # token -> (capable: bool, checked_at_monotonic: float)
_AGENT_CAP_TTL = 120.0
_AGENT_QUERY_TIMEOUT = 25       # seconds to wait for the agent before falling back.
# Must comfortably exceed a cold DB connect on the agent host: Oracle thin-mode connect
# (esp. XE) can take several seconds, and the agent opens a fresh connection per query.
# An 8s cap made the first V$ query time out → agent cached "incapable" → the rest of
# the Oracle dashboard fell back to server-direct (No module named oracledb).


def _agent_query_meta(token, conn, sql, timeout=_AGENT_QUERY_TIMEOUT):
    """Run one query on the host agent; return (rows, columns), or (None, None) if the
    agent didn't answer (caller falls back to direct). Raises on a DB-side error."""
    from app.services.agent import agent_fs_service
    payload = json.dumps({
        "db_type": (conn.db_type or "").lower(), "host": conn.host or "127.0.0.1",
        "port": conn.port or 0, "user": conn.username or "", "password": conn.password or "",
        "database": conn.database_name or "", "sql": sql,
    })
    raw = agent_fs_service.request(token, "dbquery", payload, timeout=timeout)
    if raw is None:
        return None, None
    try:
        data = json.loads(raw.decode("utf-8", errors="replace"))
    except Exception as e:  # noqa: BLE001
        raise RuntimeError("agent returned malformed result: %s" % e)
    if isinstance(data, dict) and data.get("error"):
        raise RuntimeError(data["error"])
    return [tuple(r) for r in (data.get("rows") or [])], list(data.get("columns") or [])


def _render_sql(clause, params):
    """Inline bound params for the agent path (the agent takes raw SQL). Used only for
    the handful of parametrised internal dashboard queries."""
    sql = clause if isinstance(clause, str) else str(clause)
    if params:
        for k, v in params.items():
            if v is None:
                rep = "NULL"
            elif isinstance(v, (int, float)):
                rep = str(v)
            else:
                rep = "'" + str(v).replace("'", "''") + "'"
            # replace :key not part of a longer identifier
            sql = sql.replace(":" + k, rep)
    return sql


class _AgentRow(tuple):
    """A tuple that also behaves like a SQLAlchemy Row: positional (r[0]), attribute
    (r.colname), and r._mapping (dict). Lets dashboard code that uses any of these work
    unchanged over agent-routed results."""
    def __new__(cls, values, cols):
        self = super().__new__(cls, values)
        self._cols = list(cols or [])
        return self
    @property
    def _mapping(self):
        return dict(zip(self._cols, self))
    def keys(self):
        return self._cols
    def __getattr__(self, name):
        try:
            return self[self._cols.index(name)]
        except (ValueError, IndexError):
            raise AttributeError(name)


class _AgentMappings:
    def __init__(self, rows):
        self._rows = rows
    def all(self):
        return [r._mapping for r in self._rows]
    def first(self):
        return self._rows[0]._mapping if self._rows else None
    def __iter__(self):
        return (r._mapping for r in self._rows)


class _AgentResult:
    """Quacks like a SQLAlchemy Result across the API the dashboards use."""
    def __init__(self, rows, cols):
        self._cols = list(cols or [])
        self._rows = [_AgentRow(r, self._cols) for r in (rows or [])]
    def fetchall(self):
        return self._rows
    def fetchone(self):
        return self._rows[0] if self._rows else None
    def first(self):
        return self._rows[0] if self._rows else None
    def scalar(self):
        return self._rows[0][0] if self._rows and len(self._rows[0]) else None
    def scalar_one_or_none(self):
        return self.scalar()
    def scalar_one(self):
        return self.scalar()
    def keys(self):
        return self._cols
    def mappings(self):
        return _AgentMappings(self._rows)
    def __iter__(self):
        return iter(self._rows)
    @property
    def rowcount(self):
        return len(self._rows)


class _NoOpTx:
    """Stand-in for a SQLAlchemy transaction — the agent commits each statement itself."""
    def __enter__(self):
        return self
    def __exit__(self, *a):
        return False
    def commit(self):
        pass
    def rollback(self):
        pass


# Engines the ActMon server can query directly (drivers installed in the venv).
# For anything else (oracle, mssql, …) a "direct fallback" is guaranteed to fail
# with a confusing "No module named …" — and even with drivers, the server cannot
# reach a DB living on the agent host's localhost. So for those engines we NEVER
# fall back: we surface a clear agent-side error instead.
_DIRECT_CAPABLE = ("mysql", "maria", "postgre", "pg")


def _can_go_direct(conn):
    dbtype = (getattr(conn, "db_type", "") or "").lower()
    return any(k in dbtype for k in _DIRECT_CAPABLE)


class _AgentConnection:
    def __init__(self, token, conn, direct_factory):
        self._token = token
        self._conn = conn
        self._direct_factory = direct_factory
        self._fallback = None
    def execution_options(self, **kw):
        # No-op: the agent runs each statement autonomously (autocommit). Some code
        # sets isolation_level="AUTOCOMMIT" for DDL — safe to ignore, agent commits.
        return self
    def begin(self):
        return _NoOpTx()
    def commit(self):
        pass
    def rollback(self):
        pass
    def _direct_execute(self, clause, params):
        if self._fallback is None:
            self._fallback = self._direct_factory().connect()
        stmt = clause if not isinstance(clause, str) else text(clause)
        return self._fallback.execute(stmt, params or {})
    def execute(self, clause, params=None):
        # Skip the agent entirely if it recently proved incapable (fast path → direct).
        # Only meaningful for engines the server can actually query itself.
        cap = _AGENT_CAP.get(self._token)
        if cap and not cap[0] and (time.monotonic() - cap[1]) < _AGENT_CAP_TTL and _can_go_direct(self._conn):
            return self._direct_execute(clause, params)
        sql = _render_sql(clause, params)
        try:
            rows, cols = _agent_query_meta(self._token, self._conn, sql)
        except RuntimeError as e:
            msg = str(e).lower()
            # ONLY a missing engine driver on the agent warrants a direct fallback —
            # and only for engines the server itself can query.
            if ("unsupported db_type" in msg or "no module named" in msg) and _can_go_direct(self._conn):
                return self._direct_execute(clause, params)
            # Everything else (auth failed, connect refused, SQL error) is a REAL answer
            # from the agent about the target DB — surface it so the user sees the cause,
            # instead of masking it by querying the server's own localhost.
            raise
        if rows is None:                        # agent never answered (timeout/offline)
            # Don't downgrade an agent that has ALREADY proven capable — one slow query
            # must not shunt the rest of the dashboard onto the (wrong) server-direct path.
            prev = _AGENT_CAP.get(self._token)
            if not (prev and prev[0]):
                _AGENT_CAP[self._token] = (False, time.monotonic())
            if _can_go_direct(self._conn):
                return self._direct_execute(clause, params)
            # Oracle/MSSQL etc.: a direct attempt would just mislead ("No module named…").
            raise RuntimeError(
                "The agent on the DB host did not answer in time. Check that the ActMon "
                "agent is online on that host (Agents page), then refresh.")
        _AGENT_CAP[self._token] = (True, time.monotonic())
        return _AgentResult(rows, cols)
    def close(self):
        if self._fallback is not None:
            try: self._fallback.close()
            except Exception: pass  # noqa: BLE001
    def __enter__(self):
        return self
    def __exit__(self, *a):
        self.close()
        return False


class _AgentEngine:
    def __init__(self, token, conn, direct_factory):
        self._token = token
        self._conn = conn
        self._direct_factory = direct_factory
    def connect(self):
        return _AgentConnection(self._token, self._conn, self._direct_factory)
    def dispose(self):
        pass


class _ConnView:
    """A lightweight view of a ConnectionMaster with an overridden database_name — lets a
    per-database engine (e.g. PostgreSQL iterating every DB) route through the agent and
    connect to THAT specific database locally on the agent host."""
    def __init__(self, base, dbname):
        self.id = getattr(base, "id", None)
        self.db_type = getattr(base, "db_type", None)
        self.host = getattr(base, "host", None)
        self.port = getattr(base, "port", None)
        self.username = getattr(base, "username", None)
        self.password = getattr(base, "password", None)
        self.database_name = dbname
        self.ssl_mode = getattr(base, "ssl_mode", None)


def conn_view(base, dbname):
    return _ConnView(base, dbname)


def engine_for(conn, direct_factory):
    """Engine-like object for a ConnectionMaster. Agent-linked connection → routes
    queries through the agent; otherwise returns direct_factory() (the caller's real
    engine, unchanged). `direct_factory` is a 0-arg callable building the real engine."""
    from app.database.connection import SessionLocal
    s = SessionLocal()
    try:
        host = agent_host_for_conn(getattr(conn, "id", None), s)
    finally:
        s.close()
    if host and getattr(host, "token", None):
        return _AgentEngine(host.token, conn, direct_factory)
    return direct_factory()


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
