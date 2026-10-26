"""
MongoDB Atlas monitoring.

Two independent data sources, either or both configured per connection:

  * DATA PLANE — a normal MongoDB connection (an Atlas SRV URI, or host + database user). Gives server status,
    databases / collections / sizes, replica-set state and current operations, read live from the cluster.
  * ATLAS ADMIN API — a project API key (public + private, HTTP digest). Gives clusters, tiers, regions,
    Atlas-computed metric history (CPU, memory, disk, network, opcounters, latency), alerts, backups,
    database users / IP access list and Performance Advisor slow queries.

Nothing here invents a value: a metric the configured access cannot read is returned as `unavailable` with the
reason, and the UI says so.

Secrets: the URI is stored in ConnectionMaster.connection_uri and the password in .password (both EncryptedString
columns); the API private key in cloud_primary_key_enc via the central credential_encryption service. None of the
three is ever returned by an API response or written to a log.
"""
import re
import threading
import time
from collections import deque
from datetime import datetime, timezone
from urllib.parse import quote_plus, urlsplit

from fastapi import HTTPException

from app.models.connection_model import ConnectionMaster
from app.services.common.credential_encryption_service import credential_encryption

DB_TYPE = "mongoatlas"
PROVIDER = "mongo_atlas"
API_BASE = "https://cloud.mongodb.com/api/atlas/v2"
API_ACCEPT = "application/vnd.atlas.2023-01-01+json"
API_TIMEOUT = 20
_MONGO_TIMEOUTS = {"serverSelectionTimeoutMS": 8000, "connectTimeoutMS": 8000, "socketTimeoutMS": 20000}
_URI_RE = re.compile(r"^mongodb(\+srv)?://[^\s]+$")
_PROJECT_RE = re.compile(r"^[0-9a-f]{24}$")
AUTH_METHODS = ("uri", "credentials", "api_key")


# ── config / secrets ──────────────────────────────────────────────────────────

def _cfg(conn):
    return dict(conn.cloud_config or {})


def _api_private_key(conn):
    return credential_encryption.decrypt(conn.cloud_primary_key_enc) if conn.cloud_primary_key_enc else None


def _redact(text, conn=None, extra=()):
    """Error text from drivers can echo a URI; strip any credentials before it reaches a response."""
    s = str(text or "")
    s = re.sub(r"(mongodb(?:\+srv)?://)[^@/\s]+@", r"\1***@", s)
    secrets = list(extra)
    if conn is not None:
        secrets += [conn.password, _api_private_key(conn) if conn.cloud_primary_key_enc else None]
    for sec in secrets:
        if sec and len(sec) >= 4:
            s = s.replace(sec, "***")
    return s[:400]


def _uri_host(uri):
    try:
        return urlsplit(uri).hostname or ""
    except Exception:  # noqa: BLE001
        return ""


def _has_data_plane(conn):
    return bool(conn.connection_uri or conn.host)


def _has_api(conn):
    c = _cfg(conn)
    return bool(c.get("api_public_key") and conn.cloud_primary_key_enc and c.get("project_id"))


def serialize(conn):
    """The ONLY shape a connection leaves the server in — no URI, password or private key."""
    c = _cfg(conn)
    return {
        "id": conn.id,
        "connection_name": conn.connection_name,
        "environment": conn.environment,
        "auth_method": c.get("auth_method"),
        "host": conn.host or _uri_host(conn.connection_uri),
        "has_uri": bool(conn.connection_uri),
        "username": conn.username,
        "has_password": bool(conn.password),
        "database_name": conn.database_name,
        "auth_source": conn.auth_source,
        "project_label": c.get("project_label"),
        "project_id": c.get("project_id"),
        "api_public_key": (c.get("api_public_key") or "")[:4] + "…" if c.get("api_public_key") else None,
        "has_api_key": _has_api(conn),
        "monitoring_scope": c.get("monitoring_scope") or [],
        "status": c.get("last_status") or "unknown",
        "last_checked": c.get("last_checked"),
        "last_error": c.get("last_error"),
        "created_at": c.get("created_at"),
    }


# ── validation ────────────────────────────────────────────────────────────────

def validate(req, existing=None):
    """Returns a list of field errors. `existing` lets an edit keep a stored secret by leaving it blank."""
    errs = []
    if not (req.connection_name or "").strip():
        errs.append("Connection name is required.")
    m = req.auth_method
    if m not in AUTH_METHODS:
        errs.append("Choose an authentication method.")
    if m == "uri":
        uri = (req.connection_uri or "").strip()
        if not uri and not (existing and existing.connection_uri):
            errs.append("Atlas connection URI is required.")
        elif uri and not _URI_RE.match(uri):
            errs.append("The URI must start with mongodb+srv:// or mongodb://.")
    if m == "credentials":
        if not (req.host or "").strip():
            errs.append("Cluster host is required (e.g. cluster0.abcde.mongodb.net).")
        elif "://" in req.host or "/" in req.host:
            errs.append("Enter only the cluster host name, without mongodb+srv:// or a path.")
        if not (req.username or "").strip():
            errs.append("Database username is required.")
        if not req.password and not (existing and existing.password):
            errs.append("Database password is required.")
    wants_api = m == "api_key" or (req.api_public_key or req.api_private_key or req.project_id)
    if wants_api:
        if not _PROJECT_RE.match((req.project_id or "").strip()):
            errs.append("Atlas Project ID must be the 24-character hex id (Project Settings → Project ID).")
        if not (req.api_public_key or "").strip() and not (existing and (existing.cloud_config or {}).get("api_public_key")):
            errs.append("API public key is required.")
        if not req.api_private_key and not (existing and existing.cloud_primary_key_enc):
            errs.append("API private key is required.")
    return errs


def apply(conn, req):
    """Copy a request onto a row. Blank secrets keep the stored value (edit without re-typing)."""
    c = _cfg(conn)
    conn.db_type = DB_TYPE
    conn.cloud_provider = PROVIDER
    conn.connection_name = req.connection_name.strip()
    conn.environment = req.environment or "Production"
    c["auth_method"] = req.auth_method
    c["project_label"] = (req.project_label or "").strip() or None
    c["monitoring_scope"] = list(req.monitoring_scope or [])
    conn.database_name = (req.database_name or "").strip() or None
    conn.auth_source = (req.auth_source or "").strip() or None
    if req.auth_method == "uri":
        if (req.connection_uri or "").strip():
            conn.connection_uri = req.connection_uri.strip()
        conn.host = None
        conn.username = None
        conn.password = None
    elif req.auth_method == "credentials":
        conn.connection_uri = None
        conn.host = req.host.strip()
        conn.username = req.username.strip()
        if req.password:
            conn.password = req.password
    else:  # api_key only — no data plane
        conn.connection_uri = None
        conn.host = None
        conn.username = None
        conn.password = None
    if req.project_id or req.api_public_key or req.api_private_key:
        c["project_id"] = (req.project_id or "").strip()
        if (req.api_public_key or "").strip():          # blank on an edit keeps the stored key
            c["api_public_key"] = req.api_public_key.strip()
        if req.api_private_key:
            conn.cloud_primary_key_enc = credential_encryption.encrypt(req.api_private_key)
    elif req.auth_method != "api_key" and getattr(req, "remove_api_key", False):
        c.pop("project_id", None)
        c.pop("api_public_key", None)
        conn.cloud_primary_key_enc = None
    conn.cloud_config = c
    return conn


# ── data plane (pymongo) ──────────────────────────────────────────────────────

def _mongo(conn):
    from pymongo import MongoClient
    if conn.connection_uri:
        return MongoClient(conn.connection_uri, appname="ActMon", **_MONGO_TIMEOUTS)
    auth = f"{quote_plus(conn.username)}:{quote_plus(conn.password or '')}@" if conn.username else ""
    q = "?retryWrites=true&w=majority" + (f"&authSource={quote_plus(conn.auth_source)}" if conn.auth_source else "")
    return MongoClient(f"mongodb+srv://{auth}{conn.host}/{q}", appname="ActMon", **_MONGO_TIMEOUTS)


def _classify(exc):
    from pymongo import errors as pe
    name = type(exc).__name__
    msg = str(exc)
    if isinstance(exc, pe.OperationFailure) and getattr(exc, "code", None) in (18, 8000):
        return "auth", "Authentication failed — check the database username and password (Atlas → Database Access)."
    if isinstance(exc, pe.ConfigurationError):
        if "DNS" in msg or "resolution" in msg or "srv" in msg.lower():
            return "config", "The cluster host could not be resolved. Check the host name in the URI (Atlas → Connect)."
        return "config", "The connection string is not valid: " + msg
    if isinstance(exc, pe.ServerSelectionTimeoutError) or isinstance(exc, pe.NetworkTimeout):
        # The driver lists one reason per member host ("host:27017: <reason>"); show the first, not a guess.
        why = re.search(r"([A-Za-z0-9.\-]+:\d+): ([^,(]+)", msg)
        detail = f" Driver: {why.group(1)} — {why.group(2).strip()}." if why else ""
        if "SSL" in msg or "handshake" in msg or "closed" in msg.lower():
            hint = ("Atlas closed the connection during TLS — this is what Atlas does when the client IP is not in "
                    "THAT cluster's project IP Access List. Check the URI is for the project that allows 20.219.250.110.")
        else:
            hint = "The cluster did not answer in time. Check the URI host and the project's IP Access List (Atlas → Network Access)."
        return "network", hint + detail
    if isinstance(exc, pe.InvalidURI):
        return "config", "The connection string is not valid."
    if isinstance(exc, pe.OperationFailure):
        return "permission", "The database user is not allowed to run this command."
    return "error", f"{name}: {msg}"


def test_data_plane(conn):
    t0 = time.monotonic()
    cli = None
    try:
        cli = _mongo(conn)
        cli.admin.command("ping")
        info = cli.admin.command("buildInfo")
        hello = cli.admin.command("hello")
        return {"ok": True, "latency_ms": round((time.monotonic() - t0) * 1000, 1), "version": info.get("version"),
                "set_name": hello.get("setName"), "is_primary": hello.get("isWritablePrimary")}
    except Exception as exc:  # noqa: BLE001
        kind, msg = _classify(exc)
        host = conn.host or _uri_host(conn.connection_uri)
        if conn.connection_uri and re.search(r"<(db_)?password>", conn.connection_uri, re.I):
            kind, msg = "config", "The URI still contains the <db_password> placeholder — replace it with the database user's password."
        elif conn.connection_uri and conn.connection_uri.count("@") > 1:
            kind, msg = "config", "The password seems to contain '@'. URL-encode special characters in the URI (@ → %40, : → %3A, / → %2F, # → %23)."
        out = {"ok": False, "kind": kind, "message": _redact(msg, conn)}
        if host:
            out["host"] = host   # which cluster the URI points at — no credentials
        return out
    finally:
        if cli is not None:
            cli.close()


# ── Atlas Admin API ───────────────────────────────────────────────────────────

class AtlasApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def _api(conn, path, params=None, method="GET", body=None, public_key=None, private_key=None, timeout=API_TIMEOUT):
    import requests
    from requests.auth import HTTPDigestAuth
    c = _cfg(conn)
    pub = public_key or c.get("api_public_key")
    priv = private_key or _api_private_key(conn)
    for attempt in range(3):
        try:
            r = requests.request(method, API_BASE + path, params=params, json=body, timeout=timeout,
                                 auth=HTTPDigestAuth(pub, priv),
                                 headers={"Accept": API_ACCEPT, "Content-Type": API_ACCEPT})
        except requests.Timeout:
            raise AtlasApiError(504, "The Atlas Admin API did not answer in time.")
        except requests.RequestException as exc:
            raise AtlasApiError(502, _redact(f"Could not reach the Atlas Admin API: {exc}", extra=(priv,)))
        if r.status_code == 429 and attempt < 2:      # rate limited — wait as long as Atlas asks (capped)
            m = re.search(r"retry after (\d+) seconds", getattr(r, "text", "") or "")
            time.sleep(min(int(m.group(1)) if m else 3 * (attempt + 1), 12))
            continue
        break
    if r.status_code >= 400:
        try:
            j = r.json()
            detail = j.get("detail") or j.get("reason") or r.text
            code = j.get("errorCode")
        except Exception:  # noqa: BLE001
            detail, code = r.text, None
        if r.status_code == 401:
            detail = "The API key was rejected — check the public / private key pair."
        elif r.status_code == 403:
            detail = ("The API key is not allowed to do this. Give it the Project Read Only role (Project Owner "
                      "for acknowledging alerts) and add the ActMon server's IP to the key's API access list.")
        elif code:
            detail = f"{detail} ({code})"
        raise AtlasApiError(r.status_code, _redact(detail, extra=(priv,)))
    return r.json() if r.content else {}


def _paged(conn, path, params=None, limit=500):
    out, page = [], 1
    while True:
        p = dict(params or {}, itemsPerPage=100, pageNum=page)
        j = _api(conn, path, p)
        res = j.get("results", [])
        out += res
        if len(res) < 100 or len(out) >= limit:
            return out[:limit]
        page += 1


def test_api(conn, public_key=None, private_key=None, project_id=None):
    pid = project_id or _cfg(conn).get("project_id")
    try:
        g = _api(conn, f"/groups/{pid}", public_key=public_key, private_key=private_key)
        return {"ok": True, "project_name": g.get("name"), "cluster_count": g.get("clusterCount")}
    except AtlasApiError as exc:
        kind = "auth" if exc.status == 401 else "permission" if exc.status == 403 else \
            "network" if exc.status in (502, 504) else "config" if exc.status == 404 else "error"
        msg = exc.message if exc.status != 404 else "Project not found — check the Project ID."
        return {"ok": False, "kind": kind, "message": msg}


# ── small TTL cache (Atlas API rate limits; dashboard polls) ──────────────────

_CACHE = {}
_CACHE_LOCK = threading.Lock()


_KEY_LOCKS = {}


def cached(key, ttl, fn):
    """TTL cache with single-flight: concurrent callers for the same key wait for ONE fetch instead of each
    calling Atlas (the API allows ~100 requests a minute per project key)."""
    with _CACHE_LOCK:
        hit = _CACHE.get(key)
        if hit and hit[0] > time.monotonic():
            return hit[1]
        lock = _KEY_LOCKS.setdefault(key, threading.Lock())
    with lock:
        with _CACHE_LOCK:
            hit = _CACHE.get(key)
            if hit and hit[0] > time.monotonic():
                return hit[1]
        val = fn()
        with _CACHE_LOCK:
            _CACHE[key] = (time.monotonic() + ttl, val)
        return val


def drop_cache(conn_id):
    with _CACHE_LOCK:
        for k in [k for k in _CACHE if k[0] == conn_id]:
            _CACHE.pop(k, None)
        _SAMPLES.pop(conn_id, None)
        _STORAGE.pop(conn_id, None)


def _need(exc):
    """What to tell the user to fix: the key only when Atlas rejected the key itself."""
    return "api_key_permission" if exc.status in (401, 403) else None


def _unavailable(reason, need=None):
    return {"available": False, "reason": reason, "requires": need}


# ── live samples from the data plane (trend when no API key) ──────────────────
# serverStatus counters are cumulative; two reads give a rate. Kept per connection for an hour so the
# Performance trends have history even without the Admin API. Labelled in the UI as ActMon-sampled.

_SAMPLES = {}


def _record_sample(conn_id, ss):
    oc = ss.get("opcounters", {})
    net = ss.get("network", {})
    s = {"t": time.time(), "query": oc.get("query", 0), "insert": oc.get("insert", 0), "update": oc.get("update", 0),
         "delete": oc.get("delete", 0), "getmore": oc.get("getmore", 0), "command": oc.get("command", 0),
         "bytes_in": net.get("bytesIn", 0), "bytes_out": net.get("bytesOut", 0),
         "conn": ss.get("connections", {}).get("current", 0),
         "lat_r": (ss.get("opLatencies", {}).get("reads") or {}),
         "lat_w": (ss.get("opLatencies", {}).get("writes") or {}),
         "uptime": ss.get("uptime", 0)}
    ring = _SAMPLES.setdefault(conn_id, deque(maxlen=240))
    if ring and s["uptime"] < ring[-1]["uptime"]:      # server restarted — counters reset
        ring.clear()
    if not ring or s["t"] - ring[-1]["t"] >= 10:
        ring.append(s)


_STORAGE = {}


def _record_storage(conn_id, rows):
    ring = _STORAGE.setdefault(conn_id, deque(maxlen=240))
    t = time.time()
    if ring and t - ring[-1]["t"] < 60:
        return
    ring.append({"t": t, "data": sum(r.get("data_size") or 0 for r in rows), "index": sum(r.get("index_size") or 0 for r in rows)})


def sampled_storage(conn_id):
    return [{"ts": datetime.fromtimestamp(x["t"], timezone.utc).isoformat(), "data": x["data"], "index": x["index"]}
            for x in _STORAGE.get(conn_id, [])]


def sampled_series(conn_id):
    ring = list(_SAMPLES.get(conn_id, []))
    out = []
    for a, b in zip(ring, ring[1:]):
        dt = b["t"] - a["t"]
        if dt <= 0:
            continue

        def rate(k):
            return round(max(0, b[k] - a[k]) / dt, 2)

        def lat(k):
            ops = b[k].get("ops", 0) - a[k].get("ops", 0)
            us = b[k].get("latency", 0) - a[k].get("latency", 0)
            return round(us / ops / 1000, 2) if ops > 0 else 0

        out.append({"ts": datetime.fromtimestamp(b["t"], timezone.utc).isoformat(),
                    "reads": rate("query") + rate("getmore"), "inserts": rate("insert"), "updates": rate("update"),
                    "deletes": rate("delete"), "commands": rate("command"),
                    "net_in": rate("bytes_in"), "net_out": rate("bytes_out"), "connections": b["conn"],
                    "read_latency_ms": lat("lat_r"), "write_latency_ms": lat("lat_w")})
    return out


# ── data-plane views ──────────────────────────────────────────────────────────

def dp_overview(conn):
    if not _has_data_plane(conn):
        return _unavailable("This connection has no database access (API key only).", "uri_or_credentials")
    cli = _mongo(conn)
    try:
        out = {"available": True}
        try:
            ss = cli.admin.command("serverStatus")
            _record_sample(conn.id, ss)
            oc = ss.get("opcounters", {})
            out["server"] = {
                "version": ss.get("version"), "host": ss.get("host"), "uptime_sec": ss.get("uptime"),
                "connections": ss.get("connections", {}), "opcounters": oc,
                "mem_mb": ss.get("mem", {}), "network": {k: ss.get("network", {}).get(k) for k in ("bytesIn", "bytesOut", "numRequests")},
                "storage_engine": (ss.get("storageEngine") or {}).get("name"),
                "repl": {k: (ss.get("repl") or {}).get(k) for k in ("setName", "isWritablePrimary", "primary", "hosts")},
            }
        except Exception as exc:  # noqa: BLE001
            out["server"] = _unavailable(_redact(_classify(exc)[1], conn), "clusterMonitor")
        try:
            dbs = cli.admin.command("listDatabases", nameOnly=False).get("databases", [])
        except Exception as exc:  # noqa: BLE001
            dbs = []
            out["databases_error"] = _redact(_classify(exc)[1], conn)
        rows = []
        for d in dbs:
            name = d.get("name")
            if name in ("admin", "local", "config"):
                continue
            row = {"name": name, "size_on_disk": d.get("sizeOnDisk")}
            try:
                st = cli[name].command("dbStats")
                row.update(collections=st.get("collections"), objects=st.get("objects"), data_size=st.get("dataSize"),
                           storage_size=st.get("storageSize"), index_size=st.get("indexSize"), indexes=st.get("indexes"))
            except Exception:  # noqa: BLE001
                pass
            rows.append(row)
        out["databases"] = sorted(rows, key=lambda r: -(r.get("storage_size") or r.get("size_on_disk") or 0))
        _record_storage(conn.id, rows)
        out["totals"] = {
            "databases": len(rows),
            "collections": sum(r.get("collections") or 0 for r in rows),
            "documents": sum(r.get("objects") or 0 for r in rows) if all("objects" in r for r in rows) else None,
            "storage_bytes": sum(r.get("storage_size") or r.get("size_on_disk") or 0 for r in rows),
            "index_bytes": sum(r.get("index_size") or 0 for r in rows),
        }
        return out
    finally:
        cli.close()


def dp_collections(conn, database):
    if not _has_data_plane(conn):
        return _unavailable("This connection has no database access (API key only).", "uri_or_credentials")
    if database in ("admin", "local", "config") or not re.match(r"^[^/\\. \"$]{1,64}$", database or ""):
        raise HTTPException(400, "Invalid database name.")
    cli = _mongo(conn)
    try:
        db = cli[database]
        rows = []
        for c in db.list_collections():
            name, ctype = c.get("name"), c.get("type")
            row = {"name": name, "type": ctype}
            if ctype == "collection":
                try:
                    st = next(db[name].aggregate([{"$collStats": {"storageStats": {}}}]), {}).get("storageStats", {})
                    row.update(count=st.get("count"), size=st.get("size"), storage_size=st.get("storageSize"),
                               index_size=st.get("totalIndexSize"), indexes=st.get("nindexes"),
                               avg_obj_size=st.get("avgObjSize"), capped=st.get("capped"))
                except Exception:  # noqa: BLE001
                    row["stats_unavailable"] = True
            rows.append(row)
        return {"available": True, "database": database,
                "collections": sorted(rows, key=lambda r: -(r.get("storage_size") or 0))}
    finally:
        cli.close()


def dp_indexes(conn, database, collection):
    if not _has_data_plane(conn):
        return _unavailable("This connection has no database access (API key only).", "uri_or_credentials")
    for v in (database, collection):
        if not re.match(r"^[^\\$\"]{1,120}$", v or ""):
            raise HTTPException(400, "Invalid name.")
    cli = _mongo(conn)
    try:
        coll = cli[database][collection]
        usage = {}
        try:
            for s in coll.aggregate([{"$indexStats": {}}]):
                usage[s["name"]] = {"ops": s.get("accesses", {}).get("ops"), "since": str(s.get("accesses", {}).get("since"))}
        except Exception:  # noqa: BLE001
            pass
        return {"available": True, "indexes": [
            {"name": i.get("name"), "key": list((i.get("key") or {}).items()), "unique": bool(i.get("unique")),
             "sparse": bool(i.get("sparse")), "ttl_sec": i.get("expireAfterSeconds"), **(usage.get(i.get("name")) or {})}
            for i in coll.list_indexes()]}
    finally:
        cli.close()


def dp_replication(conn):
    if not _has_data_plane(conn):
        return _unavailable("This connection has no database access (API key only).", "uri_or_credentials")
    cli = _mongo(conn)
    try:
        out = {"available": True}
        try:
            rs = cli.admin.command("replSetGetStatus")
            prim = next((m for m in rs.get("members", []) if m.get("stateStr") == "PRIMARY"), None)
            p_op = prim.get("optimeDate") if prim else None
            out["replica_set"] = {
                "set": rs.get("set"), "members": [{
                    "name": m.get("name"), "state": m.get("stateStr"), "health": m.get("health"),
                    "uptime_sec": m.get("uptime"), "ping_ms": m.get("pingMs"),
                    "lag_sec": (p_op - m["optimeDate"]).total_seconds() if p_op and m.get("optimeDate") and m.get("stateStr") == "SECONDARY" else (0 if m.get("stateStr") == "PRIMARY" else None),
                    "sync_source": m.get("syncSourceHost") or None} for m in rs.get("members", [])]}
        except Exception as exc:  # noqa: BLE001
            out["replica_set"] = _unavailable(_redact(_classify(exc)[1], conn), "clusterMonitor")
        try:
            hello = cli.admin.command("hello")
            if hello.get("msg") == "isdbgrid":
                shards = cli["config"]["shards"].find({}, {"_id": 1, "host": 1, "state": 1})
                bal = cli.admin.command("balancerStatus")
                out["sharding"] = {"sharded": True, "shards": [{"id": s["_id"], "host": s.get("host"), "state": s.get("state")} for s in shards],
                                   "balancer": {"mode": bal.get("mode"), "in_round": bal.get("inBalancerRound")}}
            else:
                out["sharding"] = {"sharded": False}
        except Exception as exc:  # noqa: BLE001
            out["sharding"] = _unavailable(_redact(_classify(exc)[1], conn))
        return out
    finally:
        cli.close()


def dp_current_ops(conn, min_secs=0):
    """Operations running now — op type, namespace, duration only. Query predicates are NOT returned:
    they can hold customer data, and this view is visible to anyone who can open the dashboard."""
    if not _has_data_plane(conn):
        return _unavailable("This connection has no database access (API key only).", "uri_or_credentials")
    cli = _mongo(conn)
    try:
        try:
            ops = cli.admin.command("currentOp", {"active": True, "secs_running": {"$gte": int(min_secs)}}).get("inprog", [])
        except Exception as exc:  # noqa: BLE001
            return _unavailable(_redact(_classify(exc)[1], conn), "inprog / clusterMonitor")
        return {"available": True, "ops": [{
            "opid": o.get("opid"), "op": o.get("op"), "ns": o.get("ns"), "secs": o.get("secs_running"),
            "micros": o.get("microsecs_running"), "client": (o.get("clientMetadata") or {}).get("application", {}).get("name"),
            "plan": o.get("planSummary"), "waiting_lock": o.get("waitingForLock")}
            for o in ops if o.get("op") != "none" and not str(o.get("ns", "")).startswith(("admin.", "local."))][:100]}
    finally:
        cli.close()


# ── Atlas API views ───────────────────────────────────────────────────────────

def _cluster_row(c):
    specs = c.get("replicationSpecs") or []
    regions = [rc for s in specs for rc in (s.get("regionConfigs") or [])]
    first = regions[0] if regions else {}
    # API version 2023-01-01 returns the older cluster shape (providerSettings + regionsConfig) — read both.
    ps = c.get("providerSettings") or {}
    tier = (first.get("electableSpecs") or {}).get("instanceSize") or ps.get("instanceSizeName") or ps.get("effectiveInstanceSizeName")
    provider = first.get("backingProviderName") or first.get("providerName") or ps.get("backingProviderName") or ps.get("providerName")
    region_names = [rc.get("regionName") for rc in regions if rc.get("regionName")] or         [r for s in specs for r in (s.get("regionsConfig") or {})] or ([ps["regionName"]] if ps.get("regionName") else [])
    state = c.get("stateName")
    health = "healthy" if state == "IDLE" and not c.get("paused") else \
        "warning" if state in ("CREATING", "UPDATING", "REPAIRING") or c.get("paused") else "critical"
    return {"name": c.get("name"), "state": state, "paused": c.get("paused"), "health": health,
            "version": c.get("mongoDBVersion"), "type": c.get("clusterType"), "tier": tier, "provider": provider,
            "regions": region_names, "disk_gb": (first.get("electableSpecs") or {}).get("diskSizeGB") or c.get("diskSizeGB"),
            "backup": c.get("backupEnabled") or (c.get("diskBackupEnabled") if "diskBackupEnabled" in c else None),
            "shards": len(specs) if c.get("clusterType") == "SHARDED" else None,
            "termination_protection": c.get("terminationProtectionEnabled"), "created": c.get("createDate"),
            # member hosts, used to match Atlas processes to their cluster (process aliases appear in this string)
            "hosts": re.findall(r"([A-Za-z0-9.\-]+\.mongodb\.net):\d+", (c.get("connectionStrings") or {}).get("standard") or "")}


def api_clusters(conn):
    if not _has_api(conn):
        return _unavailable("Add an Atlas API key to see clusters, tiers and regions.", "api_key")
    pid = _cfg(conn)["project_id"]
    try:
        return cached((conn.id, "clusters"), 120, lambda: {
            "available": True, "project": _api(conn, f"/groups/{pid}").get("name"),
            "clusters": [_cluster_row(c) for c in _paged(conn, f"/groups/{pid}/clusters")]})
    except AtlasApiError as exc:
        return _unavailable(exc.message, _need(exc))


def api_processes(conn):
    pid = _cfg(conn)["project_id"]
    cl = api_clusters(conn)
    owner = {h: c["name"] for c in (cl.get("clusters") or []) for h in c.get("hosts") or []}

    def fetch():
        out = []
        for p in _paged(conn, f"/groups/{pid}/processes"):
            alias = p.get("userAlias") or ""
            out.append({"id": p.get("id"), "host": p.get("hostname"), "port": p.get("port"), "type": p.get("typeName"),
                        "alias": alias, "cluster": owner.get(alias) or owner.get(p.get("hostname")) or alias.split("-shard")[0],
                        "version": p.get("version"), "replica_set": p.get("replicaSetName")})
        return out
    return cached((conn.id, "processes"), 300, fetch)


def _last(series, name):
    pts = [p["v"] for p in ((series or {}).get(name) or {}).get("points", []) if p.get("v") is not None]
    return pts[-1] if pts else None


def api_cluster_usage(conn):
    """Latest CPU / memory / disk / ops per cluster, read off its primary's Atlas measurements. A value Atlas does
    not report for the cluster's tier (M0 has no CPU or memory) is None, shown as a dash, never estimated."""
    if not _has_api(conn):
        return _unavailable("Per-cluster CPU, memory and storage need an Atlas API key.", "api_key")
    cl = api_clusters(conn)
    if not cl.get("available"):
        return cl
    try:
        procs = api_processes(conn)
    except AtlasApiError as exc:
        return _unavailable(exc.message, _need(exc))
    rows = []
    for c in cl["clusters"]:
        mine = [p for p in procs if p["cluster"] == c["name"]]
        prim = next((p for p in mine if p["type"] in ("REPLICA_PRIMARY", "SHARD_PRIMARY", "SHARD_MONGOS")), mine[0] if mine else None)
        row = {"name": c["name"], "health": c["health"], "state": c["state"], "tier": c["tier"],
               "cpu": None, "memory": None, "storage": None, "ops": None, "process": prim["id"] if prim else None}
        if prim:
            m = api_measurements(conn, prim["id"], "1h")
            if m.get("available"):
                sr = m["series"]
                cpu = [v for v in (_last(sr, "SYSTEM_NORMALIZED_CPU_USER"), _last(sr, "SYSTEM_NORMALIZED_CPU_KERNEL")) if v is not None]
                row["cpu"] = round(sum(cpu), 1) if cpu else None
                used, avail = _last(sr, "SYSTEM_MEMORY_USED"), _last(sr, "SYSTEM_MEMORY_AVAILABLE")
                row["memory"] = round(used / (used + avail) * 100, 1) if used is not None and avail else None
                ops = [_last(sr, k) for k in ("OPCOUNTER_QUERY", "OPCOUNTER_INSERT", "OPCOUNTER_UPDATE", "OPCOUNTER_DELETE", "OPCOUNTER_GETMORE", "OPCOUNTER_CMD")]
                row["ops"] = round(sum(v for v in ops if v is not None), 1) if any(v is not None for v in ops) else None
                for dk in m.get("disks") or []:
                    v = _last(dk["series"], "DISK_PARTITION_SPACE_PERCENT_USED")
                    if v is not None:
                        row["storage"] = round(v, 1)
                        break
        rows.append(row)
    return {"available": True, "clusters": rows}


def api_storage_series(conn, process_id, period="1h"):
    """Data and index size over time, summed over the databases Atlas reports for this process."""
    if not _has_api(conn):
        return _unavailable("Storage history needs an Atlas API key.", "api_key")
    if period not in PERIODS:
        period = "1h"
    if not re.match(r"^[A-Za-z0-9.\-]+:\d+$", process_id or ""):
        raise HTTPException(400, "Invalid process id.")
    pid = _cfg(conn)["project_id"]
    per, gran = PERIODS[period]

    def fetch():
        dbs = [d.get("databaseName") for d in _paged(conn, f"/groups/{pid}/processes/{process_id}/databases", limit=30)]
        dbs = [d for d in dbs if d and d not in ("admin", "local", "config")][:15]
        if not dbs:
            return _unavailable("Atlas keeps no per-database storage history for this cluster (free and shared tiers do not report it).")
        by = {}
        for d in dbs:
            j = _api(conn, f"/groups/{pid}/processes/{process_id}/databases/{d}/measurements",
                     params=[("granularity", gran), ("period", per), ("m", "DATABASE_DATA_SIZE"), ("m", "DATABASE_INDEX_SIZE")])
            for m in j.get("measurements", []):
                key = "data" if m["name"] == "DATABASE_DATA_SIZE" else "index"
                for pt in m.get("dataPoints", []):
                    if pt.get("value") is None:
                        continue
                    row = by.setdefault(pt["timestamp"], {"ts": pt["timestamp"]})
                    row[key] = row.get(key, 0) + pt["value"]
        return {"available": True, "source": "atlas", "databases": len(dbs), "series": sorted(by.values(), key=lambda r: r["ts"])}

    try:
        return cached((conn.id, "storage", process_id, period), 120, fetch)
    except AtlasApiError as exc:
        return _unavailable(exc.message, _need(exc))


DB_METRICS = ["DATABASE_COLLECTION_COUNT", "DATABASE_VIEW_COUNT", "DATABASE_OBJECT_COUNT", "DATABASE_DATA_SIZE",
              "DATABASE_STORAGE_SIZE", "DATABASE_INDEX_SIZE", "DATABASE_INDEX_COUNT", "DATABASE_AVERAGE_OBJECT_SIZE"]


def api_database_stats(conn):
    """Per-database counts and sizes from Atlas' own database measurements on each cluster's primary — the same
    numbers dbStats gives, read with the API key alone. Same shape as dp_overview, so every view can use either."""
    if not _has_api(conn):
        return _unavailable("Database counts need an Atlas API key or database access.", "uri_or_credentials")
    cl = api_clusters(conn)
    if not cl.get("available"):
        return cl
    pid = _cfg(conn)["project_id"]
    procs = api_processes(conn)

    def one(cluster, proc, db):
        # 7 days hourly: the latest value for the tables, and the history for the cards' trends and sparklines.
        j = _api(conn, f"/groups/{pid}/processes/{proc}/databases/{db}/measurements",
                 params=[("granularity", "PT1H"), ("period", "P7D")] + [("m", m) for m in DB_METRICS])
        last, hist = {}, {}
        for m in j.get("measurements", []):
            pts = [(pt["timestamp"], pt["value"]) for pt in m.get("dataPoints", []) if pt.get("value") is not None]
            if pts:
                last[m["name"]] = pts[-1][1]
                for ts, v in pts:
                    hist.setdefault(ts, {})[m["name"]] = v
        if not last:
            return None
        cnt = lambda k: int(last[k]) if k in last else None  # noqa: E731
        return {"name": db, "cluster": cluster, "collections": (cnt("DATABASE_COLLECTION_COUNT") or 0) - (cnt("DATABASE_VIEW_COUNT") or 0)
                if "DATABASE_COLLECTION_COUNT" in last else None,
                "objects": cnt("DATABASE_OBJECT_COUNT"), "data_size": last.get("DATABASE_DATA_SIZE"),
                "storage_size": last.get("DATABASE_STORAGE_SIZE"), "index_size": last.get("DATABASE_INDEX_SIZE"),
                "indexes": cnt("DATABASE_INDEX_COUNT"), "avg_obj_size": last.get("DATABASE_AVERAGE_OBJECT_SIZE"),
                "_hist": hist}

    def fetch():
        import concurrent.futures
        jobs, notes = [], []
        for c in cl["clusters"]:
            mine = [x for x in procs if x["cluster"] == c["name"]]
            prim = next((x for x in mine if x["type"] in ("REPLICA_PRIMARY", "SHARD_PRIMARY")), None)
            if not prim:
                notes.append(f"{c['name']}: no primary process reported")
                continue
            try:
                names = [d.get("databaseName") for d in _paged(conn, f"/groups/{pid}/processes/{prim['id']}/databases", limit=60)]
            except AtlasApiError as exc:
                notes.append(f"{c['name']}: {exc.message}")
                continue
            if not names:
                notes.append(f"{c['name']}: Atlas reports no per-database metrics for {c.get('tier') or 'this'} clusters")
            jobs += [(c["name"], prim["id"], n) for n in names if n and n not in ("admin", "local", "config")]
        rows = []
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
            for r in ex.map(lambda a: _safe_one(one, *a), jobs[:120]):
                if r:
                    rows.append(r)
        rows.sort(key=lambda r: -(r.get("storage_size") or 0))
        # Project-wide history: sum every database per hour. A database counts toward an hour only if Atlas
        # reported it then, so "databases a week ago" is a real count, not an assumption.
        by_ts = {}
        for r in rows:
            seen = set()
            for ts, v in sorted(r.pop("_hist").items()):
                # clusters sample at different seconds — group by clock hour, one value per database per hour
                hour = ts[:13] + ":00:00Z"
                if hour in seen:
                    continue
                seen.add(hour)
                b = by_ts.setdefault(hour, {"ts": hour, "databases": 0, "collections": 0, "documents": 0, "storage": 0, "data": 0, "index": 0})
                b["databases"] += 1
                b["collections"] += int(v.get("DATABASE_COLLECTION_COUNT") or 0) - int(v.get("DATABASE_VIEW_COUNT") or 0)
                b["documents"] += int(v.get("DATABASE_OBJECT_COUNT") or 0)
                b["storage"] += v.get("DATABASE_STORAGE_SIZE") or 0
                b["data"] += v.get("DATABASE_DATA_SIZE") or 0
                b["index"] += v.get("DATABASE_INDEX_SIZE") or 0
        history = [b for _, b in sorted(by_ts.items())]
        # the newest hour is often still partial (some databases not yet reported) — drop it rather than show a dip
        while len(history) > 2 and history[-1]["databases"] < history[-2]["databases"]:
            history.pop()
        trends = {}
        if len(history) >= 2:
            now_b = history[-1]

            def ago(hours):
                target = datetime.fromisoformat(now_b["ts"].replace("Z", "+00:00")).timestamp() - hours * 3600
                cand = [b for b in history if datetime.fromisoformat(b["ts"].replace("Z", "+00:00")).timestamp() <= target]
                return cand[-1] if cand else None
            w, dy = ago(24 * 7) or history[0], ago(24)
            trends = {"since": w["ts"], "databases_week": now_b["databases"] - w["databases"],
                      "collections_week": now_b["collections"] - w["collections"],
                      "documents_24h_pct": round((now_b["documents"] - dy["documents"]) / dy["documents"] * 100, 2) if dy and dy["documents"] else None,
                      "storage_24h_pct": round((now_b["storage"] - dy["storage"]) / dy["storage"] * 100, 2) if dy and dy["storage"] else None}
        return {"available": bool(rows), "source": "atlas", "databases": rows, "notes": notes, "history": history, "trends": trends,
                "reason": None if rows else "; ".join(notes) or "Atlas reported no user databases.",
                "totals": {"databases": len(rows), "collections": sum(r.get("collections") or 0 for r in rows),
                           "documents": sum(r.get("objects") or 0 for r in rows) if rows else None,
                           "storage_bytes": sum(r.get("storage_size") or 0 for r in rows),
                           "index_bytes": sum(r.get("index_size") or 0 for r in rows)}}

    try:
        return cached((conn.id, "dbstats"), 900, fetch)
    except AtlasApiError as exc:
        return _unavailable(exc.message, _need(exc))


def _safe_one(fn, *a):
    try:
        return fn(*a)
    except AtlasApiError:
        return None


def api_node_usage(conn):
    """Latest CPU / memory / connections / ops for EVERY process — the per-node cards on Atlas Clusters."""
    if not _has_api(conn):
        return _unavailable("Node metrics need an Atlas API key.", "api_key")
    import concurrent.futures
    procs = api_processes(conn)

    def one(p):
        m = api_measurements(conn, p["id"], "1h")
        if not m.get("available"):
            return {"id": p["id"], "error": m.get("reason")}
        sr = m["series"]
        cpu = [v for v in (_last(sr, "SYSTEM_NORMALIZED_CPU_USER"), _last(sr, "SYSTEM_NORMALIZED_CPU_KERNEL")) if v is not None]
        used, avail = _last(sr, "SYSTEM_MEMORY_USED"), _last(sr, "SYSTEM_MEMORY_AVAILABLE")
        ops = [_last(sr, k) for k in ("OPCOUNTER_QUERY", "OPCOUNTER_INSERT", "OPCOUNTER_UPDATE", "OPCOUNTER_DELETE", "OPCOUNTER_GETMORE", "OPCOUNTER_CMD")]
        disk = next((_last(dk["series"], "DISK_PARTITION_SPACE_PERCENT_USED") for dk in m.get("disks") or []), None)
        newest = max((pt["ts"] for v in sr.values() for pt in v.get("points", []) if pt.get("v") is not None), default=None)
        return {"id": p["id"], "cpu": round(sum(cpu), 1) if cpu else None,
                "memory": round(used / (used + avail) * 100, 1) if used is not None and avail else None,
                "connections": _last(sr, "CONNECTIONS"), "disk": round(disk, 1) if disk is not None else None,
                "ops": round(sum(v for v in ops if v is not None), 1) if any(v is not None for v in ops) else None,
                "last_sample": newest}

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
        nodes = list(ex.map(one, procs))
    return {"available": True, "nodes": nodes}


def api_cost(conn):
    """This project's share of the organisation's pending (current month) invoice. Needs an ORGANISATION key with the
    Organization Billing Viewer role; a project key cannot read billing, and Atlas answers 401."""
    if not _has_api(conn):
        return _unavailable("Cost needs an Atlas API key.", "api_key")
    pid = _cfg(conn)["project_id"]

    def fetch():
        org = _api(conn, f"/groups/{pid}").get("orgId")
        inv = _api(conn, f"/orgs/{org}/invoices/pending")
        items = [i for i in inv.get("lineItems", []) if i.get("groupId") in (None, pid)]
        by_sku, by_cluster = {}, {}
        for i in items:
            cents = i.get("totalPriceCents") or 0
            sku = (i.get("sku") or "OTHER").replace("_", " ").title()
            by_sku[sku] = by_sku.get(sku, 0) + cents
            cl = i.get("clusterName") or "Project"
            by_cluster[cl] = by_cluster.get(cl, 0) + cents
        return {"available": True, "period_start": inv.get("startDate"), "period_end": inv.get("endDate"),
                "project_cents": sum(by_sku.values()), "org_cents": inv.get("amountBilledCents"),
                "by_sku": sorted(({"name": k, "cents": v} for k, v in by_sku.items()), key=lambda r: -r["cents"]),
                "by_cluster": sorted(({"name": k, "cents": v} for k, v in by_cluster.items()), key=lambda r: -r["cents"])}

    try:
        return cached((conn.id, "cost"), 600, fetch)
    except AtlasApiError as exc:
        if exc.status in (401, 403):
            return _unavailable("This API key cannot read billing. Cost & Usage needs an organisation API key with the "
                                "Organization Billing Viewer role.", "billing_role")
        return _unavailable(exc.message, _need(exc))


METRICS = {
    "cpu": ["SYSTEM_NORMALIZED_CPU_USER", "SYSTEM_NORMALIZED_CPU_KERNEL"],
    "memory": ["SYSTEM_MEMORY_USED", "SYSTEM_MEMORY_AVAILABLE", "MEMORY_RESIDENT"],
    "ops": ["OPCOUNTER_QUERY", "OPCOUNTER_INSERT", "OPCOUNTER_UPDATE", "OPCOUNTER_DELETE", "OPCOUNTER_GETMORE", "OPCOUNTER_CMD"],
    "latency": ["OP_EXECUTION_TIME_READS", "OP_EXECUTION_TIME_WRITES", "OP_EXECUTION_TIME_COMMANDS"],
    "connections": ["CONNECTIONS"],
    "network": ["NETWORK_BYTES_IN", "NETWORK_BYTES_OUT"],
    "query": ["QUERY_EXECUTOR_SCANNED", "QUERY_EXECUTOR_SCANNED_OBJECTS", "QUERY_TARGETING_SCANNED_PER_RETURNED"],
}
PERIODS = {"1h": ("PT1H", "PT1M"), "6h": ("PT6H", "PT5M"), "24h": ("P1D", "PT5M"), "7d": ("P7D", "PT1H")}


def api_measurements(conn, process_id, period="1h"):
    if not _has_api(conn):
        return _unavailable("Atlas-computed history (CPU, memory, disk, latency) needs an Atlas API key.", "api_key")
    if period not in PERIODS:
        period = "1h"
    if not re.match(r"^[A-Za-z0-9.\-]+:\d+$", process_id or ""):
        raise HTTPException(400, "Invalid process id.")
    pid = _cfg(conn)["project_id"]
    per, gran = PERIODS[period]
    wanted = [m for ms in METRICS.values() for m in ms]

    def fetch():
        # One unknown name fails the whole request (Atlas renames/retires metrics by tier and version), so drop
        # any name Atlas rejects and ask again rather than losing every chart.
        names = list(wanted)
        rejected = set()   # this request only
        j = {}
        for _ in range(len(wanted)):
            try:
                j = _api(conn, f"/groups/{pid}/processes/{process_id}/measurements",
                         params=[("granularity", gran), ("period", per)] + [("m", m) for m in names])
                break
            except AtlasApiError as exc:
                bad = re.search(r"metric name (\w+)", exc.message or "")
                if exc.status not in (400, 404) or not bad or bad.group(1) not in names:
                    raise
                names.remove(bad.group(1))
                rejected.add(bad.group(1))
        series = {}
        for m in j.get("measurements", []):
            series[m["name"]] = {"units": m.get("units"),
                                 "points": [{"ts": d["timestamp"], "v": d.get("value")} for d in m.get("dataPoints", [])]}
        disks = []
        try:
            for d in _paged(conn, f"/groups/{pid}/processes/{process_id}/disks"):
                dj = _api(conn, f"/groups/{pid}/processes/{process_id}/disks/{d['partitionName']}/measurements",
                          params=[("granularity", gran), ("period", per), ("m", "DISK_PARTITION_SPACE_PERCENT_USED"),
                                  ("m", "DISK_PARTITION_SPACE_USED"), ("m", "DISK_PARTITION_SPACE_FREE")])
                disks.append({"partition": d["partitionName"], "series": {m["name"]: {"units": m.get("units"), "points": [
                    {"ts": p["timestamp"], "v": p.get("value")} for p in m.get("dataPoints", [])]} for m in dj.get("measurements", [])}})
        except AtlasApiError:
            pass
        return {"available": True, "process": process_id, "period": period, "granularity": gran,
                "series": series, "disks": disks, "not_reported": sorted(rejected)}

    try:
        return cached((conn.id, "meas", process_id, period), 120 if period == "1h" else 600, fetch)
    except AtlasApiError as exc:
        return _unavailable(exc.message, _need(exc))


def api_alerts(conn, status="OPEN"):
    if not _has_api(conn):
        return _unavailable("Atlas alerts need an Atlas API key.", "api_key")
    pid = _cfg(conn)["project_id"]
    status = status if status in ("OPEN", "TRACKING", "CLOSED") else "OPEN"
    try:
        rows = cached((conn.id, "alerts", status), 30, lambda: _paged(conn, f"/groups/{pid}/alerts", {"status": status}, limit=300))
    except AtlasApiError as exc:
        return _unavailable(exc.message, _need(exc))
    return {"available": True, "alerts": [{
        "id": a.get("id"), "event": a.get("eventTypeName"), "status": a.get("status"),
        "cluster": a.get("clusterName") or a.get("replicaSetName"), "host": a.get("hostnameAndPort"),
        "metric": (a.get("currentValue") or {}).get("number") if a.get("currentValue") else None,
        "metric_name": a.get("metricName"), "units": (a.get("currentValue") or {}).get("units"),
        "created": a.get("created"), "updated": a.get("updated"), "last_notified": a.get("lastNotified"),
        "acknowledged_until": a.get("acknowledgedUntil"), "acknowledged_by": a.get("acknowledgingUsername"),
        "severity": _alert_severity(a)} for a in rows]}


def _alert_severity(a):
    # Atlas alerts carry no severity of their own; availability events are critical, thresholds are warnings.
    ev = (a.get("eventTypeName") or "").upper()
    if any(k in ev for k in ("NO_PRIMARY", "HOST_DOWN", "CLUSTER_MONGOS_IS_MISSING", "REPLICATION_OPLOG_WINDOW_RUNNING_OUT")):
        return "critical"
    return "warning"


def api_ack_alert(conn, alert_id, hours):
    if not _has_api(conn):
        raise HTTPException(400, "Acknowledging Atlas alerts needs an Atlas API key.")
    if not re.match(r"^[0-9a-f]{24}$", alert_id or ""):
        raise HTTPException(400, "Invalid alert id.")
    pid = _cfg(conn)["project_id"]
    until = datetime.fromtimestamp(time.time() + max(1, min(int(hours), 24 * 30)) * 3600, timezone.utc)
    try:
        _api(conn, f"/groups/{pid}/alerts/{alert_id}", method="PATCH",
             body={"acknowledgedUntil": until.strftime("%Y-%m-%dT%H:%M:%SZ"), "acknowledgementComment": "Acknowledged from ActMon"})
    except AtlasApiError as exc:
        raise HTTPException(exc.status if exc.status < 500 else 502, exc.message)
    drop_cache(conn.id)
    return {"status": "success", "acknowledged_until": until.isoformat()}


def api_backups(conn):
    if not _has_api(conn):
        return _unavailable("Backup snapshots need an Atlas API key.", "api_key")
    pid = _cfg(conn)["project_id"]
    cl = api_clusters(conn)
    if not cl.get("available"):
        return cl

    def fetch():
        out = []
        for c in cl["clusters"]:
            row = {"cluster": c["name"], "backup_enabled": c.get("backup")}
            try:
                snaps = _api(conn, f"/groups/{pid}/clusters/{c['name']}/backup/snapshots", {"itemsPerPage": 20}).get("results", [])
                row["snapshots"] = [{"id": s.get("id"), "created": s.get("createdAt"), "expires": s.get("expiresAt"),
                                     "status": s.get("status"), "type": s.get("snapshotType"), "frequency": s.get("frequencyType"),
                                     "size_bytes": s.get("storageSizeBytes")} for s in snaps]
            except AtlasApiError as exc:
                row["error"] = exc.message
            try:
                sch = _api(conn, f"/groups/{pid}/clusters/{c['name']}/backup/schedule")
                row["policy"] = [{"frequency": i.get("frequencyType"), "interval": i.get("frequencyInterval"),
                                  "retention": f"{i.get('retentionValue')} {i.get('retentionUnit', '').lower()}"}
                                 for p in sch.get("policies", []) for i in p.get("policyItems", [])]
                row["next_snapshot"] = sch.get("nextSnapshot")
            except AtlasApiError:
                pass
            out.append(row)
        return {"available": True, "clusters": out}

    return cached((conn.id, "backups"), 300, fetch)


def api_security(conn):
    if not _has_api(conn):
        return _unavailable("Database users and the IP access list need an Atlas API key.", "api_key")
    pid = _cfg(conn)["project_id"]

    def fetch():
        out = {"available": True}
        try:
            out["users"] = [{"username": u.get("username"), "auth_db": u.get("databaseName"),
                             "roles": [f"{r.get('roleName')}@{r.get('databaseName')}" + (f".{r['collectionName']}" if r.get("collectionName") else "") for r in u.get("roles", [])],
                             "scopes": [s.get("name") for s in u.get("scopes", [])],
                             "auth": "X.509" if u.get("x509Type") not in (None, "NONE") else "AWS IAM" if u.get("awsIAMType") not in (None, "NONE") else
                                     "LDAP" if u.get("ldapAuthType") not in (None, "NONE") else "OIDC" if u.get("oidcAuthType") not in (None, "NONE") else "SCRAM",
                             "expires": u.get("deleteAfterDate")} for u in _paged(conn, f"/groups/{pid}/databaseUsers")]
        except AtlasApiError as exc:
            out["users"] = _unavailable(exc.message)
        try:
            out["access_list"] = [{"entry": a.get("cidrBlock") or a.get("ipAddress") or a.get("awsSecurityGroup"),
                                   "comment": a.get("comment"), "expires": a.get("deleteAfterDate"),
                                   "open_to_world": a.get("cidrBlock") == "0.0.0.0/0"} for a in _paged(conn, f"/groups/{pid}/accessList")]
        except AtlasApiError as exc:
            out["access_list"] = _unavailable(exc.message)
        return out

    return cached((conn.id, "security"), 300, fetch)


def api_slow_queries(conn, process_id, hours=24):
    """Performance Advisor's slow-query log. The raw log line holds the query shape and can hold literal values,
    so only the namespace, duration and counts are returned — not the line itself."""
    if not _has_api(conn):
        return _unavailable("Slow queries come from Atlas Performance Advisor and need an Atlas API key.", "api_key")
    if not re.match(r"^[A-Za-z0-9.\-]+:\d+$", process_id or ""):
        raise HTTPException(400, "Invalid process id.")
    pid = _cfg(conn)["project_id"]
    since = int((time.time() - max(1, min(int(hours), 168)) * 3600) * 1000)
    try:
        j = cached((conn.id, "slow", process_id, hours), 120, lambda: _api(
            conn, f"/groups/{pid}/processes/{process_id}/performanceAdvisor/slowQueryLogs", {"since": since, "nLogs": 200}, timeout=60))
        sugg = cached((conn.id, "sugg", process_id), 600, lambda: _api(
            conn, f"/groups/{pid}/processes/{process_id}/performanceAdvisor/suggestedIndexes", timeout=60))
    except AtlasApiError as exc:
        # Atlas answers 401 here for free / shared clusters (M0, M2, M5, Flex) even with a valid key.
        tiers = [x.get("tier") for x in (api_clusters(conn).get("clusters") or [])]
        if exc.status in (400, 401, 403, 404) and any(str(t or "").upper() in ("M0", "M2", "M5", "FLEX") for t in tiers):
            return _unavailable("Performance Advisor is not available on free and shared clusters (M0 / M2 / M5 / Flex).",
                                "M10+ cluster tier")
        need = "M10+ cluster tier" if exc.status in (400, 404) else _need(exc)
        return _unavailable(exc.message, need)
    rows = []
    for q in j.get("slowQueries", []):
        line = q.get("line") or ""
        m = re.search(r'"durationMillis":(\d+)', line)
        ex = re.search(r'"docsExamined":(\d+)', line)
        rt = re.search(r'"nreturned":(\d+)', line)
        op = re.search(r'"type":"(\w+)"', line) or re.search(r'"command":\{"(\w+)"', line)
        plan = re.search(r'"planSummary":"([^"]+)"', line)
        rows.append({"ns": q.get("namespace"), "duration_ms": int(m.group(1)) if m else None,
                     "docs_examined": int(ex.group(1)) if ex else None, "returned": int(rt.group(1)) if rt else None,
                     "op": op.group(1) if op else None, "plan": (plan.group(1) if plan else None)})
    rows.sort(key=lambda r: -(r["duration_ms"] or 0))
    return {"available": True, "queries": rows,
            "suggested_indexes": [{"ns": s.get("namespace"), "index": s.get("index"), "weight": s.get("weight"),
                                   "impact": s.get("impact")} for s in (sugg.get("content", {}) or {}).get("suggestedIndexes", [])]}
