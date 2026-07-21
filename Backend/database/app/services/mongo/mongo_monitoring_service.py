import json
import math
import os

from fastapi import HTTPException
from pymongo import MongoClient
from sqlalchemy.orm import Session
from urllib.parse import quote_plus

from app.models.connection_model import ConnectionMaster


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _direct_mongo_client(conn):
    if conn.connection_uri:
        return MongoClient(conn.connection_uri, serverSelectionTimeoutMS=5000)
    pw = quote_plus(conn.password or "")
    proto_raw = conn.mongo_protocol or "mongodb"
    protocol = proto_raw.split("://")[0] if "://" in proto_raw else proto_raw
    auth = f"{conn.username}:{pw}@" if conn.username else ""
    auth_source = f"?authSource={conn.auth_source}" if conn.auth_source else ""
    replica = f"&replicaSet={conn.replica_set}" if conn.replica_set else ""
    return MongoClient(
        f"{protocol}://{auth}{conn.host}:{conn.port}/{conn.database_name or ''}{auth_source}{replica}",
        serverSelectionTimeoutMS=5000,
    )


def _mongo_client(conn):
    """Agent-hosted MongoDB (localhost on the DB box) → route every command through
    that host's agent (pymongo-shaped proxy over the dbquery channel); standalone
    MongoDB keeps the direct client unchanged."""
    from app.services.mongo.mongo_agent_proxy import mongo_client_for
    return mongo_client_for(conn, lambda: _direct_mongo_client(conn))


def _format_uptime(seconds):
    seconds = int(seconds)
    days = seconds // 86400
    hours = (seconds % 86400) // 3600
    minutes = (seconds % 3600) // 60
    parts = []
    if days:
        parts.append(f"{days}d")
    if hours:
        parts.append(f"{hours}h")
    parts.append(f"{minutes}m")
    return " ".join(parts)


def _safe_float(val):
    try:
        f = float(val)
        if math.isnan(f) or math.isinf(f):
            return 0.0
        return f
    except Exception:
        return 0.0


def _safe_int(val):
    try:
        return int(val)
    except Exception:
        return 0


def _get_conn_or_404(conn_id: int, db: Session):
    conn = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == conn_id,
        ConnectionMaster.db_type == "mongodb",
    ).first()
    if not conn:
        raise HTTPException(status_code=404, detail="Connection not found")
    return conn


def _infer_bson_type(val) -> str:
    import datetime as _dt
    if val is None:                          return "null"
    if isinstance(val, bool):               return "boolean"
    if isinstance(val, int):                return "int"
    if isinstance(val, float):              return "double"
    if isinstance(val, str):                return "string"
    if isinstance(val, _dt.datetime):       return "date"
    if isinstance(val, (bytes, bytearray)): return "binData"
    if isinstance(val, list):               return "array"
    if isinstance(val, dict):               return "object"
    return type(val).__name__


def _flatten_doc(doc, prefix="", max_depth=3) -> dict:
    out = {}
    if not isinstance(doc, dict) or max_depth <= 0:
        return out
    for k, v in doc.items():
        key = f"{prefix}.{k}" if prefix else k
        if isinstance(v, dict) and max_depth > 1:
            out.update(_flatten_doc(v, key, max_depth - 1))
        else:
            out[key] = v
    return out


# ---------------------------------------------------------------------------
# 1. Main Dashboard
# ---------------------------------------------------------------------------

def get_dashboard(conn_id: int, db: Session):
    from app.utils.agent_cache import get_snapshot as _get_snap
    _cached = _get_snap(conn_id, "mongo_dashboard", db)
    if _cached is not None:
        return _cached
    conn = _get_conn_or_404(conn_id, db)
    mc = None
    try:
        mc = _mongo_client(conn)
        admin_db = mc.admin

        server_status  = admin_db.command("serverStatus")
        build_info     = admin_db.command("buildInfo")
        db_list_result = admin_db.command("listDatabases")

        version        = build_info.get("version", "unknown")
        uptime_seconds = server_status.get("uptime", 0)
        uptime_str     = _format_uptime(uptime_seconds)
        host           = server_status.get("host", conn.host)
        pid            = server_status.get("pid", 0)
        process        = server_status.get("process", "mongod")

        storage_engine = "WiredTiger"
        try:
            storage_engine = server_status.get("storageEngine", {}).get("name", "WiredTiger")
        except Exception:
            pass

        conns_raw            = server_status.get("connections", {})
        current_connections  = conns_raw.get("current", 0)
        available_connections = conns_raw.get("available", 0)
        total_created        = conns_raw.get("totalCreated", 0)
        total_possible       = current_connections + available_connections
        connection_pct       = round(
            (current_connections / total_possible * 100) if total_possible > 0 else 0.0, 2
        )

        opcounters_raw = server_status.get("opcounters", {})
        opcounters = {
            "insert":  opcounters_raw.get("insert", 0),
            "query":   opcounters_raw.get("query", 0),
            "update":  opcounters_raw.get("update", 0),
            "delete":  opcounters_raw.get("delete", 0),
            "getmore": opcounters_raw.get("getmore", 0),
            "command": opcounters_raw.get("command", 0),
        }
        operations_total = sum(opcounters.values())

        mem_raw = server_status.get("mem", {})
        memory  = {
            "resident": mem_raw.get("resident", 0),
            "virtual":  mem_raw.get("virtual", 0),
            "mapped":   mem_raw.get("mapped", 0),
        }

        wt_raw           = server_status.get("wiredTiger", {}).get("cache", {})
        wt_bytes_in_cache = wt_raw.get("bytes currently in the cache", 0)
        wt_max_bytes      = wt_raw.get("maximum bytes configured", 1)
        wt_dirty_bytes    = wt_raw.get("tracked dirty bytes in the cache", 0)
        wt_pages_read     = wt_raw.get("pages read into cache", 0)
        wt_pages_written  = wt_raw.get("pages written from cache", 0)
        wt_pages_req      = wt_raw.get("pages requested from cache", 1)
        wt_unmod_evicted  = wt_raw.get("unmodified pages evicted", 0)
        wt_cache_pct      = round(wt_bytes_in_cache / max(wt_max_bytes, 1) * 100, 2)
        wt_cache_hit_pct  = 0.0
        try:
            wt_app_read_from_disk = wt_raw.get("pages read into cache", 0)
            wt_cache_hit_pct = round(
                max(0.0, 100.0 - (wt_app_read_from_disk / max(wt_pages_req, 1)) * 100), 2
            )
        except Exception:
            pass

        wired_tiger_cache = {
            "bytes_currently_in_cache":    wt_bytes_in_cache,
            "maximum_bytes_configured":     wt_max_bytes,
            "tracked_dirty_bytes_in_cache": wt_dirty_bytes,
            "pages_read_into_cache":        wt_pages_read,
            "pages_written_from_cache":     wt_pages_written,
            "pages_requested_from_cache":   wt_pages_req,
            "unmodified_pages_evicted":     wt_unmod_evicted,
            "cache_used_mb":                round(wt_bytes_in_cache / 1024 / 1024, 2),
            "cache_max_mb":                 round(wt_max_bytes / 1024 / 1024, 2),
            "dirty_bytes_mb":               round(wt_dirty_bytes / 1024 / 1024, 2),
            "cache_pct":                    wt_cache_pct,
            "cache_hit_pct":                wt_cache_hit_pct,
        }

        network_raw = server_status.get("network", {})
        network = {
            "bytesIn":     network_raw.get("bytesIn", 0),
            "bytesOut":    network_raw.get("bytesOut", 0),
            "numRequests": network_raw.get("numRequests", 0),
        }

        global_lock_raw = server_status.get("globalLock", {})
        global_lock = {
            "totalTime": global_lock_raw.get("totalTime", 0),
            "currentQueue": {
                "total":   global_lock_raw.get("currentQueue", {}).get("total", 0),
                "readers": global_lock_raw.get("currentQueue", {}).get("readers", 0),
                "writers": global_lock_raw.get("currentQueue", {}).get("writers", 0),
            },
            "activeClients": {
                "total":   global_lock_raw.get("activeClients", {}).get("total", 0),
                "readers": global_lock_raw.get("activeClients", {}).get("readers", 0),
                "writers": global_lock_raw.get("activeClients", {}).get("writers", 0),
            },
        }

        repl_raw = server_status.get("repl", {})
        if repl_raw:
            if repl_raw.get("ismaster"):
                replication_state = "PRIMARY"
            elif repl_raw.get("secondary"):
                replication_state = "SECONDARY"
            else:
                replication_state = "UNKNOWN"
        else:
            replication_state = "STANDALONE"
        replica_set = repl_raw.get("setName", "")

        replica_members = []
        oplog_info = {}
        try:
            rs_status = admin_db.command("replSetGetStatus")
            replica_members = rs_status.get("members", [])
            for m in replica_members:
                for k in list(m.keys()):
                    if hasattr(m[k], "isoformat"):
                        m[k] = m[k].isoformat()
                    elif not isinstance(m[k], (str, int, float, bool, type(None), list, dict)):
                        m[k] = str(m[k])
        except Exception:
            pass

        databases = []
        total_collections = 0
        for db_info in db_list_result.get("databases", []):
            entry = {
                "name":       db_info.get("name", ""),
                "sizeOnDisk": db_info.get("sizeOnDisk", 0),
                "empty":      db_info.get("empty", False),
            }
            try:
                db_obj   = mc[entry["name"]]
                stats    = db_obj.command("dbStats")
                coll_cnt = stats.get("collections", 0)
                entry["collections_count"] = coll_cnt
                entry["objects"]       = stats.get("objects", 0)
                entry["avg_obj_size"]  = round(_safe_float(stats.get("avgObjSize", 0)), 2)
                entry["data_size_mb"]  = round(_safe_float(stats.get("dataSize", 0)) / 1024 / 1024, 2)
                entry["index_size_mb"] = round(_safe_float(stats.get("indexSize", 0)) / 1024 / 1024, 2)
                total_collections += coll_cnt
            except Exception:
                entry["collections_count"] = 0
                entry["objects"]       = 0
                entry["avg_obj_size"]  = 0.0
                entry["data_size_mb"]  = 0.0
                entry["index_size_mb"] = 0.0
            databases.append(entry)

        total_databases = len(databases)

        health_summary = {
            "version":               version,
            "uptime_str":            uptime_str,
            "uptime_seconds":        uptime_seconds,
            "host":                  host,
            "pid":                   pid,
            "process":               process,
            "storage_engine":        storage_engine,
            "total_databases":       total_databases,
            "total_collections":     total_collections,
            "current_connections":   current_connections,
            "available_connections": available_connections,
            "connection_pct":        connection_pct,
            "replication_state":     replication_state,
            "replica_set":           replica_set,
            "memory_resident_mb":    memory["resident"],
            "memory_virtual_mb":     memory["virtual"],
            "operations_total":      operations_total,
            "wt_cache_pct":          wt_cache_pct,
            "wt_cache_hit_pct":      wt_cache_hit_pct,
        }

        return {
            "status": "success",
            "connection": {
                "id":       conn.id,
                "name":     conn.connection_name,
                "host":     conn.host,
                "port":     conn.port,
                "database": conn.database_name,
            },
            "health_summary":    health_summary,
            "server_info":       health_summary,
            "connections": {
                "current":      current_connections,
                "available":    available_connections,
                "totalCreated": total_created,
            },
            "opcounters":        opcounters,
            "memory":            memory,
            "wired_tiger_cache": wired_tiger_cache,
            "wired_tiger":       wired_tiger_cache,
            "network":           network,
            "global_lock":       global_lock,
            "databases":         databases,
            "repl_status": {
                "setName":   repl_raw.get("setName", ""),
                "ismaster":  repl_raw.get("ismaster", False),
                "secondary": repl_raw.get("secondary", False),
                "hosts":     repl_raw.get("hosts", []),
                "state":     replication_state,
                "members":   replica_members,
            },
            "gauges": {
                "connection_pct":            connection_pct,
                "memory_pct":                0.0,
                "op_rate":                   operations_total,
                "wired_tiger_cache_hit_pct": wt_cache_hit_pct,
                "wt_cache_pct":              wt_cache_pct,
            },
            "oplog_info": oplog_info,
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"MongoDB dashboard error: {str(e)}")
    finally:
        if mc:
            try:
                mc.close()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# 2. Current Operations
# ---------------------------------------------------------------------------

def get_ops(conn_id: int, db: Session):
    from app.utils.agent_cache import get_snapshot as _get_snap
    _cached = _get_snap(conn_id, "mongo_ops", db)
    if _cached is not None:
        return _cached
    conn = _get_conn_or_404(conn_id, db)
    mc = None
    try:
        mc = _mongo_client(conn)
        admin_db = mc.admin

        ops   = []
        error = None
        try:
            result = admin_db.command("currentOp")
            for op in result.get("inprog", []):
                query_str = ""
                try:
                    cmd = op.get("command", op.get("query", op.get("originatingCommand", {})))
                    query_str = json.dumps(cmd, default=str)[:400]
                except Exception:
                    query_str = str(op.get("command", ""))[:400]

                lock_stats = {}
                try:
                    for ltype, ldata in (op.get("locks") or {}).items():
                        lock_stats[ltype] = ldata
                except Exception:
                    pass

                secs      = op.get("secs_running", 0)
                microsecs = op.get("microsecs_running", 0)

                ops.append({
                    "opid":              str(op.get("opid", "")),
                    "type":              op.get("type", ""),
                    "ns":                op.get("ns", ""),
                    "secs_running":      secs,
                    "microsecs_running": microsecs,
                    "op":                op.get("op", ""),
                    "query":             query_str,
                    "client":            op.get("client", ""),
                    "desc":              op.get("desc", ""),
                    "waitingForLock":    op.get("waitingForLock", False),
                    "lockStats":         lock_stats,
                    "active":            op.get("active", False),
                    "planSummary":       op.get("planSummary", ""),
                    "numYields":         op.get("numYields", 0),
                    "appName":           op.get("appName", ""),
                })
        except Exception as e:
            error = str(e)

        active_count  = sum(1 for o in ops if o.get("active"))
        waiting_count = sum(1 for o in ops if o.get("waitingForLock"))
        slow_count    = sum(1 for o in ops if (o.get("secs_running", 0) or 0) > 1)

        return {
            "status":        "success",
            "ops":           ops,
            "total":         len(ops),
            "active_count":  active_count,
            "waiting_count": waiting_count,
            "slow_count":    slow_count,
            "error":         error,
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"MongoDB ops error: {str(e)}")
    finally:
        if mc:
            try:
                mc.close()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# 3. Profiler
# ---------------------------------------------------------------------------

def get_profiler(conn_id: int, db: Session):
    conn = _get_conn_or_404(conn_id, db)
    mc = None
    try:
        mc = _mongo_client(conn)
        admin_db = mc.admin

        db_list_result = admin_db.command("listDatabases")
        system_dbs = {"admin", "local", "config"}
        user_dbs = [
            d["name"] for d in db_list_result.get("databases", [])
            if d["name"] not in system_dbs
        ]

        all_profile_ops  = []
        profiler_levels  = {}
        errors           = []

        for db_name in user_dbs:
            db_obj = mc[db_name]
            try:
                profile_status = db_obj.command("profile", -1)
                level = profile_status.get("was", 0)
                profiler_levels[db_name] = level

                if level >= 1:
                    try:
                        cursor = (
                            db_obj["system.profile"]
                            .find({})
                            .sort("ts", -1)
                            .limit(100)
                        )
                        for doc in cursor:
                            cmd = doc.get("command", doc.get("query", {}))
                            try:
                                cmd_str = json.dumps(cmd, default=str)[:400]
                            except Exception:
                                cmd_str = str(cmd)[:400]

                            ts = doc.get("ts", "")
                            if hasattr(ts, "isoformat"):
                                ts = ts.isoformat()

                            all_profile_ops.append({
                                "db":             db_name,
                                "op":             doc.get("op", ""),
                                "ns":             doc.get("ns", ""),
                                "millis":         doc.get("millis", 0),
                                "ts":             str(ts),
                                "nreturned":      doc.get("nreturned", 0),
                                "nscanned":       doc.get("nscanned", doc.get("docsExamined", 0)),
                                "ninserted":      doc.get("ninserted", 0),
                                "nModified":      doc.get("nModified", 0),
                                "keysExamined":   doc.get("keysExamined", 0),
                                "docsExamined":   doc.get("docsExamined", 0),
                                "keyUpdates":     doc.get("keyUpdates", 0),
                                "writeConflicts": doc.get("writeConflicts", 0),
                                "planSummary":    doc.get("planSummary", ""),
                                "command":        cmd_str,
                                "client":         doc.get("client", ""),
                                "user":           doc.get("user", ""),
                                "responseLength": doc.get("responseLength", 0),
                                "numYield":       doc.get("numYield", 0),
                            })
                    except Exception as e2:
                        errors.append(f"Error reading system.profile for {db_name}: {str(e2)}")
            except Exception as e:
                errors.append(f"Cannot get profiler level for {db_name}: {str(e)}")

        all_profile_ops.sort(key=lambda x: x.get("millis", 0), reverse=True)

        return {
            "status":          "success",
            "ops":             all_profile_ops,
            "total":           len(all_profile_ops),
            "profiler_levels": profiler_levels,
            "errors":          errors,
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"MongoDB profiler error: {str(e)}")
    finally:
        if mc:
            try:
                mc.close()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# 4. Slow Operations
# ---------------------------------------------------------------------------

def get_slow_operations(conn_id: int, db: Session):
    conn = _get_conn_or_404(conn_id, db)
    mc = None
    try:
        mc = _mongo_client(conn)
        admin_db = mc.admin

        current_ops = []
        try:
            current_op = admin_db.command("currentOp", {"active": True})
            for op in current_op.get("inprog", []):
                secs = op.get("secs_running", 0) or 0
                if secs > 0:
                    try:
                        cmd = op.get("command", op.get("query", {}))
                        cmd_str = json.dumps(cmd, default=str)[:300]
                    except Exception:
                        cmd_str = ""
                    current_ops.append({
                        "source":            "currentOp",
                        "opid":              str(op.get("opid", "")),
                        "type":              op.get("type", ""),
                        "ns":                op.get("ns", ""),
                        "secs_running":      secs,
                        "microsecs_running": op.get("microsecs_running", 0),
                        "op":                op.get("op", ""),
                        "query":             cmd_str,
                        "client":            op.get("client", ""),
                        "desc":              op.get("desc", ""),
                        "waitingForLock":    op.get("waitingForLock", False),
                        "planSummary":       op.get("planSummary", ""),
                    })
        except Exception:
            pass

        profile_ops       = []
        profiling_enabled = False
        try:
            db_list_result = admin_db.command("listDatabases")
            system_dbs = {"admin", "local", "config"}
            user_dbs = [
                d["name"] for d in db_list_result.get("databases", [])
                if d["name"] not in system_dbs
            ]
            for db_name in user_dbs:
                try:
                    db_obj        = mc[db_name]
                    profile_level = db_obj.command("profile", -1)
                    if profile_level.get("was", 0) >= 1:
                        profiling_enabled = True
                        cursor = (
                            db_obj["system.profile"]
                            .find({"millis": {"$gt": 100}})
                            .sort("ts", -1)
                            .limit(50)
                        )
                        for doc in cursor:
                            try:
                                cmd = doc.get("command", doc.get("query", {}))
                                cmd_str = json.dumps(cmd, default=str)[:300]
                            except Exception:
                                cmd_str = ""
                            ts = doc.get("ts", "")
                            if hasattr(ts, "isoformat"):
                                ts = ts.isoformat()
                            profile_ops.append({
                                "source":       "profiler",
                                "ts":           str(ts),
                                "ns":           doc.get("ns", ""),
                                "op":           doc.get("op", ""),
                                "millis":       doc.get("millis", 0),
                                "nreturned":    doc.get("nreturned", 0),
                                "keysExamined": doc.get("keysExamined", 0),
                                "docsExamined": doc.get("docsExamined", 0),
                                "planSummary":  doc.get("planSummary", ""),
                                "query":        cmd_str,
                                "client":       doc.get("client", ""),
                                "user":         doc.get("user", ""),
                            })
                except Exception:
                    pass
        except Exception:
            pass

        all_ops = current_ops + profile_ops
        all_ops.sort(key=lambda x: x.get("millis", x.get("secs_running", 0) * 1000), reverse=True)

        return {
            "status":       "success",
            "current_ops":  current_ops,
            "profile_ops":  profile_ops,
            "all_ops":      all_ops,
            "total":        len(all_ops),
            "profiling_status": {
                "enabled":    profiling_enabled,
                "was_active": len(current_ops) > 0,
            },
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"MongoDB slow operations error: {str(e)}")
    finally:
        if mc:
            try:
                mc.close()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# 5. Collections
# ---------------------------------------------------------------------------

def get_collections(conn_id: int, db: Session):
    from app.utils.agent_cache import get_snapshot as _get_snap
    _cached = _get_snap(conn_id, "mongo_collections", db)
    if _cached is not None:
        return _cached
    conn = _get_conn_or_404(conn_id, db)
    mc = None
    try:
        mc = _mongo_client(conn)
        admin_db = mc.admin

        db_list_result = admin_db.command("listDatabases")
        databases = []
        errors    = []

        for db_info in db_list_result.get("databases", []):
            db_name = db_info.get("name", "")
            db_obj  = mc[db_name]
            db_entry = {
                "name":        db_name,
                "sizeOnDisk":  db_info.get("sizeOnDisk", 0),
                "collections": [],
            }
            try:
                coll_names = db_obj.list_collection_names()
                for coll_name in coll_names:
                    try:
                        stats       = db_obj.command("collStats", coll_name)
                        coll_options = db_obj.get_collection(coll_name).options()
                        db_entry["collections"].append({
                            "name":                coll_name,
                            "count":               stats.get("count", 0),
                            "size":                stats.get("size", 0),
                            "size_mb":             round(_safe_float(stats.get("size", 0)) / 1024 / 1024, 4),
                            "storageSize":         stats.get("storageSize", 0),
                            "storage_size_mb":     round(_safe_float(stats.get("storageSize", 0)) / 1024 / 1024, 4),
                            "avgObjSize":          stats.get("avgObjSize", 0),
                            "nindexes":            stats.get("nindexes", 0),
                            "totalIndexSize":      stats.get("totalIndexSize", 0),
                            "total_index_size_mb": round(_safe_float(stats.get("totalIndexSize", 0)) / 1024 / 1024, 4),
                            "capped":              stats.get("capped", False),
                            "max":                 stats.get("max", 0),
                            "maxSize":             stats.get("maxSize", 0),
                            "validator":           bool(coll_options.get("validator")),
                            "readConcernLevel":    coll_options.get("readConcern", {}).get("level", ""),
                        })
                    except Exception as e:
                        errors.append(f"{db_name}.{coll_name}: {str(e)}")
            except Exception as e:
                errors.append(f"Cannot list collections in {db_name}: {str(e)}")
            databases.append(db_entry)

        total_collections = sum(len(d["collections"]) for d in databases)
        total_docs        = sum(c["count"] for d in databases for c in d["collections"])

        return {
            "status":            "success",
            "databases":         databases,
            "total_collections": total_collections,
            "total_docs":        total_docs,
            "errors":            errors,
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"MongoDB collections error: {str(e)}")
    finally:
        if mc:
            try:
                mc.close()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# 6. Indexes
# ---------------------------------------------------------------------------

def get_indexes(conn_id: int, db: Session):
    from app.utils.agent_cache import get_snapshot as _get_snap
    _cached = _get_snap(conn_id, "mongo_indexes", db)
    if _cached is not None:
        return _cached
    conn = _get_conn_or_404(conn_id, db)
    mc = None
    try:
        mc = _mongo_client(conn)
        admin_db = mc.admin

        db_list_result = admin_db.command("listDatabases")
        all_indexes    = []
        errors         = []

        for db_info in db_list_result.get("databases", []):
            db_name = db_info.get("name", "")
            db_obj  = mc[db_name]
            try:
                coll_names = db_obj.list_collection_names()
            except Exception as e:
                errors.append(f"Cannot list collections in {db_name}: {str(e)}")
                continue

            for coll_name in coll_names:
                try:
                    index_info = db_obj[coll_name].index_information()

                    index_stats = {}
                    try:
                        pipeline = [{"$indexStats": {}}]
                        for stat in db_obj[coll_name].aggregate(pipeline):
                            idx_name   = stat.get("name", "")
                            accesses   = stat.get("accesses", {})
                            last_access = accesses.get("since")
                            if hasattr(last_access, "isoformat"):
                                last_access = last_access.isoformat()
                            index_stats[idx_name] = {
                                "ops":         accesses.get("ops", 0),
                                "last_access": str(last_access) if last_access else None,
                            }
                    except Exception:
                        pass

                    idx_sizes = {}
                    try:
                        cstats    = db_obj.command("collStats", coll_name)
                        idx_sizes = cstats.get("indexSizes", {})
                    except Exception:
                        pass

                    for idx_name, idx_spec in index_info.items():
                        stat     = index_stats.get(idx_name, {})
                        accesses = stat.get("ops", 0)
                        last_acc = stat.get("last_access")
                        all_indexes.append({
                            "db":                  db_name,
                            "collection":          coll_name,
                            "ns":                  f"{db_name}.{coll_name}",
                            "name":                idx_name,
                            "key":                 idx_spec.get("key", {}),
                            "unique":              idx_spec.get("unique", False),
                            "sparse":              idx_spec.get("sparse", False),
                            "background":          idx_spec.get("background", False),
                            "expireAfterSeconds":  idx_spec.get("expireAfterSeconds"),
                            "size":                idx_sizes.get(idx_name, 0),
                            "accesses":            _safe_int(accesses),
                            "last_access":         last_acc,
                            "unused":              _safe_int(accesses) == 0 and idx_name != "_id_",
                        })
                except Exception as e:
                    errors.append(f"{db_name}.{coll_name}: {str(e)}")

        unused = [i for i in all_indexes if i["unused"]]

        return {
            "status":         "success",
            "indexes":        all_indexes,
            "total":          len(all_indexes),
            "unused_count":   len(unused),
            "unused_indexes": unused,
            "errors":         errors,
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"MongoDB indexes error: {str(e)}")
    finally:
        if mc:
            try:
                mc.close()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# 7. Replication
# ---------------------------------------------------------------------------

def get_replication(conn_id: int, db: Session):
    from app.utils.agent_cache import get_snapshot as _get_snap
    _cached = _get_snap(conn_id, "mongo_replication", db)
    if _cached is not None:
        return _cached
    conn = _get_conn_or_404(conn_id, db)
    mc = None
    try:
        mc = _mongo_client(conn)
        admin_db = mc.admin

        server_status = admin_db.command("serverStatus")
        repl_raw      = server_status.get("repl", {})

        rs_status = None
        rs_error  = None
        try:
            rs_status = admin_db.command("replSetGetStatus")
        except Exception as e:
            rs_error = str(e)

        if rs_status is None:
            return {
                "status":         "success",
                "is_replica_set": False,
                "set_name":       "",
                "state":          "STANDALONE",
                "members":        [],
                "oplog":          {},
                "replication_lag": [],
                "error":          rs_error,
            }

        set_name  = rs_status.get("set", "")
        my_state  = rs_status.get("myState", 0)
        state_map = {
            1: "PRIMARY", 2: "SECONDARY", 3: "RECOVERING", 4: "STARTUP2",
            5: "UNKNOWN", 6: "ARBITER",   7: "DOWN",       8: "ROLLBACK", 9: "REMOVED",
        }
        my_state_str = state_map.get(my_state, f"STATE_{my_state}")

        members         = []
        primary_optime  = None
        for m in rs_status.get("members", []):
            state_val = m.get("state", 6)
            state_str = state_map.get(state_val, f"STATE_{state_val}")

            optime    = m.get("optime", {})
            optime_ts = None
            if isinstance(optime, dict):
                optime_ts = optime.get("ts")
            elif hasattr(optime, "time"):
                optime_ts = optime

            optime_date = m.get("optimeDate")
            if hasattr(optime_date, "isoformat"):
                optime_date = optime_date.isoformat()

            last_hb      = m.get("lastHeartbeatMessage", "")
            last_hb_recv = m.get("lastHeartbeatRecv")
            if hasattr(last_hb_recv, "isoformat"):
                last_hb_recv = last_hb_recv.isoformat()

            if state_val == 1:
                primary_optime = optime_ts

            members.append({
                "id":                   m.get("_id", 0),
                "name":                 m.get("name", ""),
                "health":               m.get("health", 0),
                "state":                state_val,
                "stateStr":             state_str,
                "uptime":               m.get("uptime", 0),
                "optime":               str(optime_ts) if optime_ts else "",
                "optimeDate":           str(optime_date) if optime_date else "",
                "lastHeartbeatMessage": last_hb,
                "lastHeartbeatRecv":    str(last_hb_recv) if last_hb_recv else "",
                "configVersion":        m.get("configVersion", 0),
                "self":                 m.get("self", False),
                "priority":             m.get("priority", 1),
                "votes":                m.get("votes", 1),
                "lag":                  0,
                "syncingTo":            m.get("syncingTo", ""),
                "syncSourceHost":       m.get("syncSourceHost", ""),
            })

        replication_lag = []
        if primary_optime is not None:
            try:
                primary_ts = primary_optime.time if hasattr(primary_optime, "time") else int(str(primary_optime).split(" ")[0])
                for m in members:
                    if m["stateStr"] == "SECONDARY":
                        sec_ts = 0
                        try:
                            raw_ts = m["optime"]
                            if " " in str(raw_ts):
                                sec_ts = int(str(raw_ts).split(" ")[0])
                        except Exception:
                            pass
                        lag    = max(0, primary_ts - sec_ts)
                        m["lag"] = lag
                        replication_lag.append({"member": m["name"], "lag_seconds": lag})
            except Exception:
                pass

        oplog_info = {}
        try:
            local_db    = mc["local"]
            oplog_stats = local_db.command("collStats", "oplog.rs")
            first_doc   = local_db["oplog.rs"].find_one(sort=[("ts", 1)])
            last_doc    = local_db["oplog.rs"].find_one(sort=[("ts", -1)])
            first_ts = last_ts = None
            if first_doc and "ts" in first_doc:
                first_ts = first_doc["ts"].time if hasattr(first_doc["ts"], "time") else 0
            if last_doc and "ts" in last_doc:
                last_ts = last_doc["ts"].time if hasattr(last_doc["ts"], "time") else 0

            oplog_window_hours = 0.0
            if first_ts and last_ts and last_ts > first_ts:
                oplog_window_hours = round((last_ts - first_ts) / 3600, 2)

            oplog_info = {
                "size":               oplog_stats.get("maxSize", oplog_stats.get("storageSize", 0)),
                "used":               oplog_stats.get("size", 0),
                "size_mb":            round(_safe_float(oplog_stats.get("maxSize", 0)) / 1024 / 1024, 2),
                "used_mb":            round(_safe_float(oplog_stats.get("size", 0)) / 1024 / 1024, 2),
                "first_ts":           first_ts,
                "last_ts":            last_ts,
                "oplog_window_hours": oplog_window_hours,
                "count":              oplog_stats.get("count", 0),
            }
        except Exception as e:
            oplog_info = {"error": str(e)}

        return {
            "status":          "success",
            "is_replica_set":  True,
            "set_name":        set_name,
            "state":           my_state_str,
            "members":         members,
            "oplog":           oplog_info,
            "replication_lag": replication_lag,
            "ok":              rs_status.get("ok", 0),
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"MongoDB replication error: {str(e)}")
    finally:
        if mc:
            try:
                mc.close()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# 8. Oplog
# ---------------------------------------------------------------------------

def get_oplog(conn_id: int, db: Session):
    conn = _get_conn_or_404(conn_id, db)
    mc = None
    try:
        mc = _mongo_client(conn)
        local_db = mc["local"]

        # The oplog only exists on a replica set. Detect a standalone server first so the UI
        # can show a clear message instead of confusing zeros.
        set_name = None
        try:
            hello = mc.admin.command("hello")
            set_name = hello.get("setName")
        except Exception:
            try:
                set_name = mc.admin.command("isMaster").get("setName")
            except Exception:
                set_name = None
        if not set_name:
            return {
                "status": "standalone",
                "is_replica_set": False,
                "note": "This MongoDB is running as a standalone server (not a replica set), so it has no oplog. "
                        "The oplog is created only when the server is part of a replica set.",
                "size_bytes": 0, "used_bytes": 0, "size_mb": 0.0, "used_mb": 0.0, "used_pct": 0.0,
                "first_ts": 0, "last_ts": 0, "oplog_window_hours": 0.0, "count": 0,
                "op_types": {}, "recent_entries": [],
            }

        try:
            oplog_stats = local_db.command("collStats", "oplog.rs")
        except Exception as e:
            return {"status": "error", "is_replica_set": True, "error": str(e),
                    "note": "oplog.rs not found — the replica set may not be fully initialised yet."}

        size_bytes = oplog_stats.get("maxSize", oplog_stats.get("storageSize", 0))
        used_bytes = oplog_stats.get("size", 0)
        size_mb    = round(_safe_float(size_bytes) / 1024 / 1024, 2)
        used_mb    = round(_safe_float(used_bytes) / 1024 / 1024, 2)
        used_pct   = round(used_bytes / max(size_bytes, 1) * 100, 2)

        first_doc = local_db["oplog.rs"].find_one(sort=[("ts", 1)])
        last_doc  = local_db["oplog.rs"].find_one(sort=[("ts", -1)])
        first_ts = last_ts = 0
        if first_doc and "ts" in first_doc:
            first_ts = first_doc["ts"].time if hasattr(first_doc["ts"], "time") else 0
        if last_doc and "ts" in last_doc:
            last_ts = last_doc["ts"].time if hasattr(last_doc["ts"], "time") else 0

        oplog_window_hours = 0.0
        if first_ts and last_ts and last_ts > first_ts:
            oplog_window_hours = round((last_ts - first_ts) / 3600, 2)

        op_types = {}
        try:
            pipeline = [{"$group": {"_id": "$op", "count": {"$sum": 1}}}]
            for doc in local_db["oplog.rs"].aggregate(pipeline):
                op_label = {
                    "i": "insert", "u": "update", "d": "delete",
                    "c": "command", "n": "noop", "db": "database",
                }.get(doc["_id"], doc["_id"] or "unknown")
                op_types[op_label] = doc["count"]
        except Exception:
            pass

        recent_entries = []
        try:
            cursor = local_db["oplog.rs"].find({}).sort("ts", -1).limit(50)
            for doc in cursor:
                ts_raw = doc.get("ts")
                ts_val = ts_raw.time if hasattr(ts_raw, "time") else 0
                o2 = doc.get("o2", {})
                recent_entries.append({
                    "ts":   ts_val,
                    "op":   doc.get("op", ""),
                    "ns":   doc.get("ns", ""),
                    "term": doc.get("t", 0),
                    "wall": str(doc.get("wall", "")),
                    "o":    json.dumps(doc.get("o", {}), default=str)[:200],
                    "o2":   json.dumps(o2, default=str)[:100] if o2 else "",
                })
        except Exception:
            pass

        return {
            "status":             "success",
            "is_replica_set":     True,
            "size_bytes":         size_bytes,
            "used_bytes":         used_bytes,
            "size_mb":            size_mb,
            "used_mb":            used_mb,
            "used_pct":           used_pct,
            "first_ts":           first_ts,
            "last_ts":            last_ts,
            "oplog_window_hours": oplog_window_hours,
            "count":              oplog_stats.get("count", 0),
            "op_types":           op_types,
            "recent_entries":     recent_entries,
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"MongoDB oplog error: {str(e)}")
    finally:
        if mc:
            try:
                mc.close()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# 9. Sharding
# ---------------------------------------------------------------------------

def get_sharding(conn_id: int, db: Session):
    conn = _get_conn_or_404(conn_id, db)
    mc = None
    try:
        mc = _mongo_client(conn)
        admin_db = mc.admin

        try:
            server_status = admin_db.command("serverStatus")
            is_mongos = server_status.get("process", "") == "mongos"
        except Exception:
            is_mongos = False

        if not is_mongos:
            try:
                config_db    = mc["config"]
                shards_count = config_db["shards"].count_documents({})
                if shards_count == 0:
                    return {"status": "success", "enabled": False, "process": "mongod"}
            except Exception:
                return {"status": "success", "enabled": False, "process": "mongod"}

        config_db = mc["config"]

        shards = []
        try:
            for shard in config_db["shards"].find():
                shards.append({
                    "id":    shard.get("_id", ""),
                    "host":  shard.get("host", ""),
                    "state": shard.get("state", 1),
                    "tags":  shard.get("tags", []),
                })
        except Exception:
            pass

        sharded_dbs = []
        try:
            for sdb in config_db["databases"].find():
                sharded_dbs.append({
                    "name":        sdb.get("_id", ""),
                    "primary":     sdb.get("primary", ""),
                    "partitioned": sdb.get("partitioned", False),
                })
        except Exception:
            pass

        chunks_per_shard = {}
        try:
            pipeline = [{"$group": {"_id": "$shard", "count": {"$sum": 1}}}]
            for doc in config_db["chunks"].aggregate(pipeline):
                chunks_per_shard[doc["_id"]] = doc["count"]
        except Exception:
            pass

        balancer_status = {}
        try:
            balancer_status = admin_db.command("balancerStatus")
            for k in list(balancer_status.keys()):
                if not isinstance(balancer_status[k], (str, int, float, bool, list, dict, type(None))):
                    balancer_status[k] = str(balancer_status[k])
        except Exception as e:
            balancer_status = {"error": str(e)}

        config_servers = []
        try:
            for cs in config_db["mongos"].find():
                up   = cs.get("up", 0)
                ping = cs.get("ping")
                if hasattr(ping, "isoformat"):
                    ping = ping.isoformat()
                config_servers.append({
                    "id":                 cs.get("_id", ""),
                    "up":                 up,
                    "ping":               str(ping) if ping else "",
                    "advisoryHostFQDNs":  cs.get("advisoryHostFQDNs", []),
                })
        except Exception:
            pass

        return {
            "status":           "success",
            "enabled":          True,
            "process":          "mongos" if is_mongos else "mongod",
            "shards":           shards,
            "shards_count":     len(shards),
            "databases":        sharded_dbs,
            "chunks_per_shard": chunks_per_shard,
            "balancer_status":  balancer_status,
            "config_servers":   config_servers,
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"MongoDB sharding error: {str(e)}")
    finally:
        if mc:
            try:
                mc.close()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# 10. Transactions
# ---------------------------------------------------------------------------

def get_transactions(conn_id: int, db: Session):
    conn = _get_conn_or_404(conn_id, db)
    mc = None
    try:
        mc = _mongo_client(conn)
        admin_db      = mc.admin
        server_status = admin_db.command("serverStatus")
        txn_raw       = server_status.get("transactions", None)

        if txn_raw is None:
            return {
                "status":       "success",
                "available":    False,
                "note":         "Transaction metrics require MongoDB 4.0+",
                "transactions": {},
            }

        transactions = {
            "totalStarted":              txn_raw.get("totalStarted", 0),
            "totalCommitted":             txn_raw.get("totalCommitted", 0),
            "totalAborted":               txn_raw.get("totalAborted", 0),
            "totalContactedParticipants": txn_raw.get("totalContactedParticipants", 0),
            "totalParticipantsAtCommit":  txn_raw.get("totalParticipantsAtCommit", 0),
            "totalRequestsTargeted":      txn_raw.get("totalRequestsTargeted", 0),
            "currentActive":              txn_raw.get("currentActive", 0),
            "currentInactive":            txn_raw.get("currentInactive", 0),
            "currentOpen":                txn_raw.get("currentOpen", 0),
            "currentPrepared":            txn_raw.get("currentPrepared", 0),
        }

        total       = transactions["totalStarted"]
        committed   = transactions["totalCommitted"]
        aborted     = transactions["totalAborted"]
        commit_rate = round(committed / max(total, 1) * 100, 2)
        abort_rate  = round(aborted  / max(total, 1) * 100, 2)

        two_phase = {}
        try:
            two_phase = {k: v for k, v in txn_raw.items() if k.startswith("totalPrepared") or k.startswith("current")}
        except Exception:
            pass

        # Multi-document transactions require a replica set. On a standalone server the counters
        # stay at zero because transactions cannot run — surface that so the UI can explain it.
        set_name = None
        try:
            set_name = mc.admin.command("hello").get("setName")
        except Exception:
            try:
                set_name = mc.admin.command("isMaster").get("setName")
            except Exception:
                set_name = None
        is_rs = bool(set_name)
        note = None
        if not is_rs:
            note = ("This MongoDB is running as a standalone server (not a replica set). Multi-document "
                    "transactions require a replica set, so these counters stay at zero until the server "
                    "is part of a replica set.")
        elif total == 0:
            note = "No multi-document transactions have been recorded yet — the counters will populate once transactions run."

        return {
            "status":         "success",
            "available":      True,
            "is_replica_set": is_rs,
            "note":           note,
            "transactions":   transactions,
            "commit_rate":    commit_rate,
            "abort_rate":     abort_rate,
            "two_phase":      two_phase,
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"MongoDB transactions error: {str(e)}")
    finally:
        if mc:
            try:
                mc.close()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# 11. WiredTiger
# ---------------------------------------------------------------------------

def get_wiredtiger(conn_id: int, db: Session):
    conn = _get_conn_or_404(conn_id, db)
    mc = None
    try:
        mc = _mongo_client(conn)
        admin_db      = mc.admin
        server_status = admin_db.command("serverStatus")
        wt            = server_status.get("wiredTiger", {})

        if not wt:
            return {"status": "success", "available": False, "note": "WiredTiger not in use"}

        cache_raw = wt.get("cache", {})
        cache = {
            "bytes_read_into_cache":           cache_raw.get("bytes read into cache", 0),
            "bytes_written_from_cache":         cache_raw.get("bytes written from cache", 0),
            "pages_read_into_cache":            cache_raw.get("pages read into cache", 0),
            "pages_written_from_cache":         cache_raw.get("pages written from cache", 0),
            "pages_requested_from_cache":       cache_raw.get("pages requested from cache", 0),
            "bytes_currently_in_cache":         cache_raw.get("bytes currently in the cache", 0),
            "maximum_bytes_configured":          cache_raw.get("maximum bytes configured", 1),
            "tracked_dirty_bytes_in_cache":     cache_raw.get("tracked dirty bytes in the cache", 0),
            "unmodified_pages_evicted":         cache_raw.get("unmodified pages evicted", 0),
            "modified_pages_evicted":           cache_raw.get("modified pages evicted", 0),
            "percentage_overhead":              cache_raw.get("percentage overhead", 0),
        }
        max_bytes              = cache["maximum_bytes_configured"] or 1
        used_bytes             = cache["bytes_currently_in_cache"]
        cache["cache_used_pct"] = round(used_bytes / max_bytes * 100, 2)
        cache["cache_used_mb"]  = round(used_bytes / 1024 / 1024, 2)
        cache["cache_max_mb"]   = round(max_bytes  / 1024 / 1024, 2)

        bm_raw        = wt.get("block-manager", {})
        block_manager = {
            "blocks_read":                      bm_raw.get("blocks read", 0),
            "blocks_written":                   bm_raw.get("blocks written", 0),
            "bytes_read":                       bm_raw.get("bytes read", 0),
            "bytes_written":                    bm_raw.get("bytes written", 0),
            "bytes_written_for_checkpoint":     bm_raw.get("bytes written for checkpoint", 0),
            "mapped_bytes_read":                bm_raw.get("mapped bytes read", 0),
            "mapped_blocks_read":               bm_raw.get("mapped blocks read", 0),
        }

        ct_raw                 = wt.get("concurrentTransactions", {})
        concurrent_transactions = {
            "read": {
                "available":    ct_raw.get("read", {}).get("available", 0),
                "out":          ct_raw.get("read", {}).get("out", 0),
                "totalTickets": ct_raw.get("read", {}).get("totalTickets", 0),
            },
            "write": {
                "available":    ct_raw.get("write", {}).get("available", 0),
                "out":          ct_raw.get("write", {}).get("out", 0),
                "totalTickets": ct_raw.get("write", {}).get("totalTickets", 0),
            },
        }

        log_raw   = wt.get("log", {})
        log_stats = {
            "log_records_processed":     log_raw.get("log records processed by log scan", 0),
            "log_bytes_of_payload_data": log_raw.get("log bytes of payload data", 0),
            "log_bytes_written":         log_raw.get("log bytes written", 0),
            "log_flushes":               log_raw.get("log flush operations", 0),
            "log_writes":                log_raw.get("log write operations", 0),
            "log_sync":                  log_raw.get("log sync operations", 0),
            "log_scan_operations":       log_raw.get("log scan operations", 0),
            "records_not_compressed":    log_raw.get("log records not compressed", 0),
        }

        sess_raw      = wt.get("session", {})
        session_stats = {
            "open_cursor_count":     sess_raw.get("open cursor count", 0),
            "open_session_count":    sess_raw.get("open session count", 0),
            "table_compact_failed":  sess_raw.get("table compact failed calls", 0),
            "table_compact_success": sess_raw.get("table compact successful calls", 0),
        }

        txn_raw        = wt.get("transaction", {})
        wt_transactions = {
            "transaction_begins":        txn_raw.get("transaction begins", 0),
            "transaction_checkpoints":   txn_raw.get("transaction checkpoints", 0),
            "transactions_committed":    txn_raw.get("transactions committed", 0),
            "transactions_rolled_back":  txn_raw.get("transactions rolled back", 0),
            "transaction_checkpoint_ms": txn_raw.get("transaction checkpoint currently running", 0),
        }

        return {
            "status":                  "success",
            "available":               True,
            "cache":                   cache,
            "block_manager":           block_manager,
            "concurrent_transactions": concurrent_transactions,
            "log":                     log_stats,
            "session":                 session_stats,
            "transactions":            wt_transactions,
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"MongoDB WiredTiger error: {str(e)}")
    finally:
        if mc:
            try:
                mc.close()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# 12. Users
# ---------------------------------------------------------------------------

def get_users(conn_id: int, db: Session):
    conn = _get_conn_or_404(conn_id, db)
    mc = None
    try:
        mc = _mongo_client(conn)
        admin_db = mc.admin

        db_list_result = admin_db.command("listDatabases")
        all_users      = []
        errors         = []

        for db_info in db_list_result.get("databases", []):
            db_name = db_info.get("name", "")
            db_obj  = mc[db_name]
            try:
                users_result = db_obj.command("usersInfo", 1)
                for user in users_result.get("users", []):
                    uid = user.get("userId", user.get("_id", ""))
                    if hasattr(uid, "hex"):
                        uid = uid.hex
                    all_users.append({
                        "username":   user.get("user", ""),
                        "db":         user.get("db", db_name),
                        "roles": [
                            {"role": r.get("role", ""), "db": r.get("db", "")}
                            for r in user.get("roles", [])
                        ],
                        "userId":     str(uid),
                        "customData": user.get("customData", {}),
                    })
            except Exception as e:
                errors.append(f"Cannot get users from {db_name}: {str(e)}")

        return {
            "status": "success",
            "users":  all_users,
            "total":  len(all_users),
            "errors": errors,
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"MongoDB users error: {str(e)}")
    finally:
        if mc:
            try:
                mc.close()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# 13. Error Logs
# ---------------------------------------------------------------------------

def get_error_logs(conn_id: int, db: Session):
    conn = _get_conn_or_404(conn_id, db)
    mc = None
    try:
        mc = _mongo_client(conn)
        admin_db = mc.admin

        log_lines = []
        source    = "getLog"
        note      = ""
        try:
            log_result = admin_db.command("getLog", "global")
            log_lines  = log_result.get("log", [])
        except Exception as e:
            note = f"getLog unavailable: {str(e)}"

        total_lines  = len(log_lines)
        recent_lines = log_lines[-200:]

        all_logs = []
        for line in recent_lines:
            try:
                entry     = json.loads(line)
                ts_raw    = entry.get("t", {})
                timestamp = ts_raw.get("$date", "") if isinstance(ts_raw, dict) else str(ts_raw)
                severity  = entry.get("s", "I")
                component = entry.get("c", "")
                ctx       = entry.get("ctx", "")
                msg       = entry.get("msg", "")
                attr      = entry.get("attr", {})
                tags      = entry.get("tags", [])
                all_logs.append({
                    "timestamp": timestamp,
                    "severity":  severity,
                    "component": component,
                    "context":   ctx,
                    "message":   msg,
                    "attr":      json.dumps(attr, default=str)[:300] if attr else "",
                    "tags":      tags,
                })
            except Exception:
                all_logs.append({
                    "timestamp": "",
                    "severity":  "I",
                    "component": "RAW",
                    "context":   "",
                    "message":   str(line)[:300],
                    "attr":      "",
                    "tags":      [],
                })

        severe_levels  = {"W", "E", "F"}
        filtered_logs  = [l for l in all_logs if l.get("severity", "I") in severe_levels]
        filtered_count = len(filtered_logs)

        severity_counts = {}
        for l in all_logs:
            s = l.get("severity", "I")
            severity_counts[s] = severity_counts.get(s, 0) + 1

        return {
            "status":          "success",
            "source":          source,
            "all_logs":        all_logs,
            "logs":            filtered_logs,
            "total_lines":     total_lines,
            "filtered_count":  filtered_count,
            "severity_counts": severity_counts,
            "note":            note,
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"MongoDB error logs error: {str(e)}")
    finally:
        if mc:
            try:
                mc.close()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# 14. Collection Analysis
# ---------------------------------------------------------------------------

def get_collection_analysis(conn_id: int, db: Session):
    conn = _get_conn_or_404(conn_id, db)
    mc = None
    try:
        mc = _mongo_client(conn)
        admin_db = mc.admin

        db_list_result = admin_db.command("listDatabases")
        system_dbs = {"admin", "local", "config"}
        user_dbs = [
            d["name"] for d in db_list_result.get("databases", [])
            if d["name"] not in system_dbs
        ]

        collections = []
        errors      = []

        for db_name in user_dbs:
            db_obj = mc[db_name]
            try:
                coll_names = db_obj.list_collection_names()
            except Exception as e:
                errors.append(f"Cannot list collections in {db_name}: {str(e)}")
                continue

            for coll_name in coll_names:
                try:
                    stats      = db_obj.command("collStats", coll_name)
                    index_info = db_obj[coll_name].index_information()

                    scan_ratio = None
                    try:
                        ns = f"{db_name}.{coll_name}"
                        profile_sample = list(
                            db_obj["system.profile"]
                            .find({"ns": ns}, {"nreturned": 1, "docsExamined": 1})
                            .sort("ts", -1)
                            .limit(20)
                        )
                        if profile_sample:
                            total_returned = sum(p.get("nreturned", 0) for p in profile_sample)
                            total_examined = sum(p.get("docsExamined", 0) for p in profile_sample)
                            if total_returned > 0:
                                scan_ratio = round(total_examined / total_returned, 2)
                    except Exception:
                        pass

                    collections.append({
                        "db":                  db_name,
                        "collection":          coll_name,
                        "ns":                  f"{db_name}.{coll_name}",
                        "count":               stats.get("count", 0),
                        "size":                stats.get("size", 0),
                        "size_mb":             round(_safe_float(stats.get("size", 0)) / 1024 / 1024, 4),
                        "storageSize":         stats.get("storageSize", 0),
                        "storage_size_mb":     round(_safe_float(stats.get("storageSize", 0)) / 1024 / 1024, 4),
                        "avgObjSize":          stats.get("avgObjSize", 0),
                        "nindexes":            stats.get("nindexes", 0),
                        "totalIndexSize":      stats.get("totalIndexSize", 0),
                        "total_index_size_mb": round(_safe_float(stats.get("totalIndexSize", 0)) / 1024 / 1024, 4),
                        "capped":              stats.get("capped", False),
                        "index_count":         len(index_info),
                        "indexes":             list(index_info.keys()),
                        "scan_ratio":          scan_ratio,
                    })
                except Exception as e:
                    errors.append(f"{db_name}.{coll_name}: {str(e)}")

        collections.sort(key=lambda x: x["size_mb"], reverse=True)
        top20 = collections[:20]

        total_size_mb = round(sum(c["size_mb"] for c in collections), 2)
        total_indexes = sum(c["index_count"] for c in collections)
        total_docs    = sum(c["count"] for c in collections)
        high_ratio    = [c for c in collections if c["scan_ratio"] is not None and c["scan_ratio"] > 10]

        return {
            "status":      "success",
            "collections": collections,
            "top20_by_size": top20,
            "summary": {
                "total_collections": len(collections),
                "total_size_mb":     total_size_mb,
                "total_indexes":     total_indexes,
                "total_docs":        total_docs,
                "high_scan_ratio":   len(high_ratio),
            },
            "errors": errors,
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"MongoDB collection analysis error: {str(e)}")
    finally:
        if mc:
            try:
                mc.close()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# 15. Groq AI analysis for slow operations
# ---------------------------------------------------------------------------

def analyze_slow_op_groq(conn_id: int, payload, db: Session):
    rec = _get_conn_or_404(conn_id, db)
    try:
        from groq import Groq
        groq_client = Groq(api_key=os.getenv("GROQ_API_KEY", ""))

        prompt = f"""You are a world-class MongoDB DBA expert. Analyze this slow MongoDB operation deeply and return ONLY valid JSON — no markdown, no code blocks.

=== OPERATION CONTEXT ===
Host: {rec.host}:{rec.port or 27017}
Database: {rec.database_name or 'unknown'}
Namespace: {payload.ns}
Operation Type: {payload.op}

=== PERFORMANCE METRICS ===
Duration: {payload.millis:.2f} ms
Documents Examined: {payload.docs_examined:,}
Keys Examined: {payload.keys_examined:,}
Documents Returned: {payload.docs_returned:,}
Query Plan: {payload.plan_summary}
Client: {payload.client}

=== QUERY FILTER ===
{payload.filter_json or '(not available)'}

Return this exact JSON structure:
{{
  "severity": "critical|high|medium|low",
  "severity_reason": "why this severity was assigned",
  "summary": "one-sentence description of what this operation does and why it is slow",
  "root_cause": "detailed root cause — what exactly makes this operation slow",
  "issues": [
    {{
      "type": "COLLSCAN|MISSING_INDEX|UNSELECTIVE_INDEX|LARGE_DOCS_EXAMINED|LOCK_WAIT|SORT_IN_MEMORY|REGEX_NO_INDEX|ARRAY_INDEX|OTHER",
      "collection": "affected collection name or null",
      "description": "detailed description of the issue",
      "severity": "critical|high|medium|low",
      "evidence": "the metric or plan detail that proves this issue"
    }}
  ],
  "index_recommendations": [
    {{
      "collection": "collection_name",
      "fields": {{"field1": 1, "field2": -1}},
      "create_cmd": "db.collection.createIndex({{field1: 1, field2: -1}}, {{background: true}})",
      "reason": "why this index will help",
      "estimated_improvement": "e.g. eliminates collection scan, 99% doc reduction"
    }}
  ],
  "query_optimization": {{
    "applicable": true,
    "suggestions": ["list of query-level changes"],
    "explanation": "what to change and why it will be faster",
    "expected_gain": "e.g. 10x-50x faster"
  }},
  "schema_suggestions": [
    "Any schema or data model changes that would help"
  ],
  "priority_actions": [
    "1. Most impactful thing to do first",
    "2. Second action",
    "3. Third action"
  ],
  "business_impact": "impact on application performance and end users",
  "estimated_overall_improvement": "overall expected improvement after all fixes",
  "validation_queries": [
    "MongoDB shell command to verify the optimization worked"
  ]
}}"""

        response = groq_client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[{"role": "user", "content": prompt}],
            temperature=0.1,
            max_tokens=3000,
        )

        import json as _json
        raw = response.choices[0].message.content.strip()
        if raw.startswith("```"):
            parts = raw.split("```")
            raw = parts[1]
            if raw.startswith("json"):
                raw = raw[4:]
        analysis = _json.loads(raw.strip())
        return {"status": "success", "analysis": analysis}

    except Exception as e:
        return {"status": "error", "error": str(e)}


# ---------------------------------------------------------------------------
# 16. Collection Detail
# ---------------------------------------------------------------------------

def get_collection_detail(conn_id: int, db_name: str, coll_name: str, db: Session):
    conn = _get_conn_or_404(conn_id, db)
    mc = None
    try:
        mc   = _mongo_client(conn)
        mdb  = mc[db_name]
        coll = mdb[coll_name]

        stats = mdb.command("collStats", coll_name)

        indexes = []
        try:
            for iname, iinfo in coll.index_information().items():
                indexes.append({
                    "name":                    iname,
                    "key":                     dict(iinfo.get("key", [])),
                    "unique":                  iinfo.get("unique", False),
                    "sparse":                  iinfo.get("sparse", False),
                    "background":              iinfo.get("background", False),
                    "expireAfterSeconds":      iinfo.get("expireAfterSeconds"),
                    "partialFilterExpression": str(iinfo.get("partialFilterExpression", "")) or None,
                    "create_cmd": "db.{}.createIndex({}, {})".format(
                        coll_name,
                        json.dumps(dict(iinfo.get("key", []))),
                        json.dumps({k: v for k, v in {
                            "name":   iname,
                            "unique": iinfo.get("unique"),
                            "sparse": iinfo.get("sparse"),
                        }.items() if v})
                    ),
                })
        except Exception:
            pass

        schema_fields = {}
        sample_count  = 0
        try:
            sample_docs  = list(coll.aggregate([{"$sample": {"size": 50}}, {"$limit": 50}]))
            sample_count = len(sample_docs)
            for doc in sample_docs:
                for field_path, val in _flatten_doc(doc).items():
                    btype = _infer_bson_type(val)
                    if field_path not in schema_fields:
                        schema_fields[field_path] = {"type": btype, "count": 0, "types": {}}
                    schema_fields[field_path]["count"] += 1
                    schema_fields[field_path]["types"][btype] = schema_fields[field_path]["types"].get(btype, 0) + 1

            schema_fields = dict(sorted(schema_fields.items(), key=lambda x: -x[1]["count"]))
        except Exception:
            pass

        validator = None
        try:
            opts = coll.options()
            if opts.get("validator"):
                validator = str(opts["validator"])[:500]
        except Exception:
            pass

        return {
            "status":       "success",
            "db":           db_name,
            "collection":   coll_name,
            "stats": {
                "count":               stats.get("count", 0),
                "size":                stats.get("size", 0),
                "size_mb":             round(_safe_float(stats.get("size", 0)) / 1048576, 4),
                "storageSize":         stats.get("storageSize", 0),
                "storage_size_mb":     round(_safe_float(stats.get("storageSize", 0)) / 1048576, 4),
                "avgObjSize":          stats.get("avgObjSize", 0),
                "nindexes":            stats.get("nindexes", 0),
                "totalIndexSize":      stats.get("totalIndexSize", 0),
                "total_index_size_mb": round(_safe_float(stats.get("totalIndexSize", 0)) / 1048576, 4),
                "capped":              stats.get("capped", False),
                "max":                 stats.get("max", 0),
                "scaleFactor":         stats.get("scaleFactor", 1),
            },
            "indexes":       indexes,
            "schema_fields": schema_fields,
            "sample_count":  sample_count,
            "validator":     validator,
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Collection detail error: {str(e)}")
    finally:
        if mc:
            try:
                mc.close()
            except Exception:
                pass
