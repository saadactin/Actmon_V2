"""
Agent-routed MongoDB client — a pymongo-shaped proxy over the agent job channel.
================================================================================

For MongoDB living on an agent host's localhost, the backend can't connect
directly. This proxy mimics the (small) pymongo surface the dashboards use and
executes every call as a Mongo COMMAND DOCUMENT through the agent:

    client.admin.command("serverStatus")        → {"serverStatus": 1}
    db.command("collStats", "orders")           → {"collStats": "orders"}
    db.list_collection_names()                  → {"listCollections": 1, nameOnly}
    db[coll].index_information()                → {"listIndexes": coll}
    db[coll].aggregate(pipeline)                → {"aggregate": coll, pipeline, cursor}
    db[coll].find(f).sort(k, d).limit(n)        → {"find": coll, filter, sort, limit}

The agent (actmon_agent._dbquery, mongo branch) runs the document with pymongo on
the DB host and returns the JSON response. Results are JSON-decoded, so BSON
specials (ObjectId, dates) arrive as strings — fine for dashboards.

Standalone (reachable) MongoDB keeps the real MongoClient — behaviour unchanged.
"""

import json
import logging

logger = logging.getLogger("mongo_agent_proxy")

_TIMEOUT = 25


class _AgentCursor:
    """Lazy find/aggregate cursor supporting the .sort().limit() chain + iteration."""
    def __init__(self, run, dbname, coll, mode, filt=None, pipeline=None):
        self._run, self._db, self._coll = run, dbname, coll
        self._mode = mode              # 'find' | 'aggregate'
        self._filter = filt or {}
        self._pipeline = pipeline or []
        self._sort, self._limit = None, 0

    def sort(self, key, direction=1):
        self._sort = {key: int(direction)}
        return self

    def limit(self, n):
        self._limit = int(n)
        return self

    def _execute(self):
        if self._mode == "aggregate":
            cmd = {"aggregate": self._coll, "pipeline": self._pipeline,
                   "cursor": {"batchSize": 500}}
        else:
            cmd = {"find": self._coll, "filter": self._filter,
                   "batchSize": self._limit or 500}
            if self._sort:
                cmd["sort"] = self._sort
            if self._limit:
                cmd["limit"] = self._limit
        res = self._run(self._db, cmd)
        return ((res.get("cursor") or {}).get("firstBatch")) or []

    def __iter__(self):
        return iter(self._execute())

    def __len__(self):
        return len(self._execute())


class _AgentCollection:
    def __init__(self, run, dbname, name):
        self._run, self._db, self.name = run, dbname, name

    def find(self, filt=None, *_a, **_k):
        return _AgentCursor(self._run, self._db, self.name, "find", filt=filt)

    def aggregate(self, pipeline, *_a, **_k):
        return _AgentCursor(self._run, self._db, self.name, "aggregate", pipeline=pipeline)

    def index_information(self):
        res = self._run(self._db, {"listIndexes": self.name})
        out = {}
        for idx in ((res.get("cursor") or {}).get("firstBatch")) or []:
            spec = {k: v for k, v in idx.items() if k not in ("name", "key")}
            spec["key"] = list((idx.get("key") or {}).items())
            out[idx.get("name", "")] = spec
        return out


class _AgentDatabase:
    def __init__(self, run, name):
        self._run, self.name = run, name

    def command(self, cmd, value=None, **kwargs):
        # pymongo semantics: command("name") → {name: 1}; command("name", v) → {name: v}
        if isinstance(cmd, str):
            doc = {cmd: 1 if value is None else value}
        else:
            doc = dict(cmd)
        doc.update(kwargs)
        return self._run(self.name, doc)

    def list_collection_names(self):
        res = self._run(self.name, {"listCollections": 1, "nameOnly": True})
        return [c.get("name") for c in ((res.get("cursor") or {}).get("firstBatch")) or []]

    def __getitem__(self, coll):
        return _AgentCollection(self._run, self.name, coll)


class AgentMongoClient:
    """Mimics the MongoClient surface the dashboards use, over the agent channel."""
    def __init__(self, token, conn):
        self._token = token
        self._conn = conn

    def _run(self, dbname, cmd_doc):
        from app.services.agent import agent_fs_service
        payload = json.dumps({
            "db_type": "mongodb",
            "host": self._conn.host or "127.0.0.1",
            "port": self._conn.port or 27017,
            "user": self._conn.username or "",
            "password": self._conn.password or "",
            "database": dbname or "admin",
            "sql": json.dumps(cmd_doc, default=str),
        })
        raw = agent_fs_service.request(self._token, "dbquery", payload, timeout=_TIMEOUT)
        if raw is None:
            raise RuntimeError("The agent on the DB host did not answer in time. "
                               "Check that it is online (Agents page), then refresh.")
        data = json.loads(raw.decode("utf-8", errors="replace") if isinstance(raw, (bytes, bytearray)) else raw)
        if isinstance(data, dict) and data.get("error"):
            raise RuntimeError(data["error"])
        rows = data.get("rows") or []
        if not rows or not rows[0]:
            return {}
        return json.loads(rows[0][0])

    @property
    def admin(self):
        return _AgentDatabase(self._run, "admin")

    def __getitem__(self, dbname):
        return _AgentDatabase(self._run, dbname)

    def list_database_names(self):
        res = self.admin.command("listDatabases")
        return [d.get("name") for d in res.get("databases", [])]

    def server_info(self):
        return self.admin.command("buildInfo")

    def close(self):
        pass


def mongo_client_for(conn, direct_factory):
    """Agent-linked MongoDB → AgentMongoClient; otherwise the caller's real client."""
    try:
        from app.database.connection import SessionLocal
        from app.services.common.db_proxy_service import agent_host_for_conn
        s = SessionLocal()
        try:
            host = agent_host_for_conn(getattr(conn, "id", None), s)
        finally:
            s.close()
        if host and getattr(host, "token", None):
            return AgentMongoClient(host.token, conn)
    except Exception as e:  # noqa: BLE001 — resolution failure → direct behaviour
        logger.debug("[mongo_agent_proxy] resolution failed: %s", e)
    return direct_factory()
