from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
import pymongo
from pymongo import MongoClient
from urllib.parse import quote_plus
import json
import math

from app.database.connection import SessionLocal
from app.models.connection_model import ConnectionMaster

router = APIRouter(prefix="/api/v1/connections/mongodb", tags=["MongoDB Monitoring"])


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _mongo_client(conn):
    if conn.connection_uri:
        return MongoClient(conn.connection_uri, serverSelectionTimeoutMS=5000)
    pw = quote_plus(conn.password or "")
    protocol = conn.mongo_protocol or "mongodb"
    auth = f"{conn.username}:{pw}@" if conn.username else ""
    auth_source = f"?authSource={conn.auth_source}" if conn.auth_source else ""
    replica = f"&replicaSet={conn.replica_set}" if conn.replica_set else ""
    return MongoClient(
        f"{protocol}://{auth}{conn.host}:{conn.port}/{conn.database_name or ''}{auth_source}{replica}",
        serverSelectionTimeoutMS=5000
    )


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


# ---------------------------------------------------------------------------
# 1. Monitoring Dashboard
# ---------------------------------------------------------------------------
@router.get("/{conn_id}/monitoring-dashboard")
def monitoring_dashboard(conn_id: int, db: Session = Depends(get_db)):
    conn = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == conn_id,
        ConnectionMaster.db_type == "mongodb"
    ).first()
    if not conn:
        raise HTTPException(status_code=404, detail="Connection not found")

    client = None
    try:
        client = _mongo_client(conn)
        admin_db = client.admin

        server_status = admin_db.command("serverStatus")
        build_info = admin_db.command("buildInfo")
        db_list_result = admin_db.command("listDatabases")

        version = build_info.get("version", "unknown")
        uptime_seconds = server_status.get("uptime", 0)
        uptime_str = _format_uptime(uptime_seconds)
        host = server_status.get("host", conn.host)

        connections = server_status.get("connections", {})
        current_connections = connections.get("current", 0)
        available_connections = connections.get("available", 0)
        total_created = connections.get("totalCreated", 0)
        total_possible = current_connections + available_connections
        connection_pct = round(
            (current_connections / total_possible * 100) if total_possible > 0 else 0.0, 2
        )

        opcounters = server_status.get("opcounters", {})
        operations = {
            "insert": opcounters.get("insert", 0),
            "query": opcounters.get("query", 0),
            "update": opcounters.get("update", 0),
            "delete": opcounters.get("delete", 0),
            "getmore": opcounters.get("getmore", 0),
            "command": opcounters.get("command", 0),
        }
        operations_total = sum(operations.values())

        mem = server_status.get("mem", {})
        memory = {
            "resident": mem.get("resident", 0),
            "virtual": mem.get("virtual", 0),
            "mapped": mem.get("mapped", 0),
        }
        memory_resident_mb = memory["resident"]

        wt_raw = server_status.get("wiredTiger", {}).get("cache", {})
        wired_tiger_cache = {
            "bytes_currently_in_cache": wt_raw.get("bytes currently in the cache", 0),
            "maximum_bytes_configured": wt_raw.get("maximum bytes configured", 0),
            "unmodified_pages_evicted": wt_raw.get("unmodified pages evicted", 0),
            "tracked_dirty_bytes_in_cache": wt_raw.get("tracked dirty bytes in the cache", 0),
            "pages_read_into_cache": wt_raw.get("pages read into cache", 0),
            "pages_written_from_cache": wt_raw.get("pages written from cache", 0),
        }

        repl_raw = server_status.get("repl", {})
        repl_status = {
            "setName": repl_raw.get("setName", ""),
            "ismaster": repl_raw.get("ismaster", False),
            "secondary": repl_raw.get("secondary", False),
            "hosts": repl_raw.get("hosts", []),
        }
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

        network_raw = server_status.get("network", {})
        network = {
            "bytesIn": network_raw.get("bytesIn", 0),
            "bytesOut": network_raw.get("bytesOut", 0),
            "numRequests": network_raw.get("numRequests", 0),
        }

        global_lock = server_status.get("globalLock", {})

        databases = []
        total_databases = 0
        for db_info in db_list_result.get("databases", []):
            entry = {
                "name": db_info.get("name", ""),
                "sizeOnDisk": db_info.get("sizeOnDisk", 0),
                "empty": db_info.get("empty", False),
            }
            try:
                db_obj = client[entry["name"]]
                stats = db_obj.command("dbStats")
                entry["collections_count"] = stats.get("collections", 0)
                entry["objects"] = stats.get("objects", 0)
                entry["avg_obj_size"] = round(_safe_float(stats.get("avgObjSize", 0)), 2)
                entry["data_size_mb"] = round(_safe_float(stats.get("dataSize", 0)) / 1024 / 1024, 2)
                entry["index_size_mb"] = round(_safe_float(stats.get("indexSize", 0)) / 1024 / 1024, 2)
            except Exception:
                entry["collections_count"] = 0
                entry["objects"] = 0
                entry["avg_obj_size"] = 0.0
                entry["data_size_mb"] = 0.0
                entry["index_size_mb"] = 0.0
            databases.append(entry)
            total_databases += 1

        health_summary = {
            "version": version,
            "uptime_str": uptime_str,
            "host": host,
            "total_databases": total_databases,
            "current_connections": current_connections,
            "available_connections": available_connections,
            "connection_pct": connection_pct,
            "replication_state": replication_state,
            "replica_set": replica_set,
            "memory_resident_mb": memory_resident_mb,
            "operations_total": operations_total,
        }

        return {
            "status": "success",
            "health_summary": health_summary,
            "connections": {
                "current": current_connections,
                "available": available_connections,
                "totalCreated": total_created,
            },
            "opcounters": operations,
            "memory": memory,
            "wired_tiger_cache": wired_tiger_cache,
            "repl_status": repl_status,
            "network": network,
            "global_lock": global_lock,
            "databases": databases,
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"MongoDB monitoring dashboard error: {str(e)}")
    finally:
        if client:
            try:
                client.close()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# 2. Slow Operations
# ---------------------------------------------------------------------------
@router.get("/{conn_id}/mongo-slow-operations")
def mongo_slow_operations(conn_id: int, db: Session = Depends(get_db)):
    conn = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == conn_id,
        ConnectionMaster.db_type == "mongodb"
    ).first()
    if not conn:
        raise HTTPException(status_code=404, detail="Connection not found")

    client = None
    try:
        client = _mongo_client(conn)
        admin_db = client.admin

        current_ops = []
        try:
            current_op = admin_db.command("currentOp", {"active": True})
            ops = current_op.get("inprog", [])
            slow_ops = [op for op in ops if op.get("secs_running", 0) > 0]
            for op in slow_ops:
                current_ops.append({
                    "opid": str(op.get("opid", "")),
                    "type": op.get("type", ""),
                    "ns": op.get("ns", ""),
                    "secs_running": op.get("secs_running", 0),
                    "op": op.get("op", ""),
                    "client": op.get("client", ""),
                    "desc": op.get("desc", ""),
                })
        except Exception:
            pass

        profile_ops = []
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
                    db_obj = client[db_name]
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
                            query_shape = ""
                            try:
                                cmd = doc.get("command", doc.get("query", {}))
                                query_shape = str(cmd)[:300]
                            except Exception:
                                pass
                            profile_ops.append({
                                "ts": str(doc.get("ts", "")),
                                "ns": doc.get("ns", ""),
                                "op": doc.get("op", ""),
                                "millis": doc.get("millis", 0),
                                "nreturned": doc.get("nreturned", 0),
                                "keysExamined": doc.get("keysExamined", 0),
                                "docsExamined": doc.get("docsExamined", 0),
                                "query_shape": query_shape,
                            })
                except Exception:
                    pass
        except Exception:
            pass

        return {
            "status": "success",
            "current_ops": current_ops,
            "profile_ops": profile_ops,
            "profiling_status": {
                "was_slow": len(current_ops) > 0,
                "enabled": profiling_enabled,
            },
            "total": len(current_ops) + len(profile_ops),
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"MongoDB slow operations error: {str(e)}")
    finally:
        if client:
            try:
                client.close()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# 3. Error Logs
# ---------------------------------------------------------------------------
@router.get("/{conn_id}/mongo-error-logs")
def mongo_error_logs(conn_id: int, db: Session = Depends(get_db)):
    conn = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == conn_id,
        ConnectionMaster.db_type == "mongodb"
    ).first()
    if not conn:
        raise HTTPException(status_code=404, detail="Connection not found")

    client = None
    try:
        client = _mongo_client(conn)
        admin_db = client.admin

        log_lines = []
        source = "getLog"
        note = ""
        try:
            log_result = admin_db.command("getLog", "global")
            log_lines = log_result.get("log", [])
        except Exception as e:
            note = f"getLog unavailable: {str(e)}"

        total_lines = len(log_lines)
        all_logs = []
        for line in log_lines[-500:]:
            try:
                entry = json.loads(line)
                all_logs.append({
                    "logged": entry.get("t", {}).get("$date", ""),
                    "severity": entry.get("s", "I"),
                    "component": entry.get("c", ""),
                    "context": entry.get("ctx", ""),
                    "message": entry.get("msg", ""),
                    "tags": entry.get("tags", []),
                })
            except Exception:
                all_logs.append({
                    "logged": "",
                    "severity": "I",
                    "component": "RAW",
                    "context": "",
                    "message": str(line)[:300],
                    "tags": [],
                })

        severe_levels = {"W", "E", "F"}
        filtered_logs = [
            log for log in all_logs
            if log.get("severity", "I") in severe_levels
        ]
        filtered_count = len(filtered_logs)

        return {
            "status": "success",
            "source": source,
            "logs": filtered_logs,
            "total_lines": total_lines,
            "filtered_count": filtered_count,
            "note": note,
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"MongoDB error logs error: {str(e)}")
    finally:
        if client:
            try:
                client.close()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# 4. Collection Analysis
# ---------------------------------------------------------------------------
@router.get("/{conn_id}/mongo-collection-analysis")
def mongo_collection_analysis(conn_id: int, db: Session = Depends(get_db)):
    conn = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == conn_id,
        ConnectionMaster.db_type == "mongodb"
    ).first()
    if not conn:
        raise HTTPException(status_code=404, detail="Connection not found")

    client = None
    try:
        client = _mongo_client(conn)
        admin_db = client.admin

        db_list_result = admin_db.command("listDatabases")
        system_dbs = {"admin", "local", "config"}
        user_dbs = [
            d["name"] for d in db_list_result.get("databases", [])
            if d["name"] not in system_dbs
        ]

        collections = []
        errors = []

        for db_name in user_dbs:
            db_obj = client[db_name]
            try:
                coll_names = db_obj.list_collection_names()
            except Exception as e:
                errors.append(f"Could not list collections in {db_name}: {str(e)}")
                continue

            for coll_name in coll_names:
                try:
                    stats = db_obj.command("collStats", coll_name)
                    index_info = db_obj[coll_name].index_information()
                    collections.append({
                        "db": db_name,
                        "collection": coll_name,
                        "count": stats.get("count", 0),
                        "size_mb": round(_safe_float(stats.get("size", 0)) / 1024 / 1024, 2),
                        "avg_obj_size": round(_safe_float(stats.get("avgObjSize", 0)), 0),
                        "total_index_size_mb": round(
                            _safe_float(stats.get("totalIndexSize", 0)) / 1024 / 1024, 2
                        ),
                        "index_count": len(index_info),
                        "indexes": list(index_info.keys()),
                        "capped": stats.get("capped", False),
                    })
                except Exception as e:
                    errors.append(f"Could not get stats for {db_name}.{coll_name}: {str(e)}")

        total_size_mb = round(sum(c["size_mb"] for c in collections), 2)
        total_indexes = sum(c["index_count"] for c in collections)

        summary = {
            "total_collections": len(collections),
            "total_size_mb": total_size_mb,
            "total_indexes": total_indexes,
        }

        return {
            "status": "success",
            "collections": collections,
            "summary": summary,
            "errors": errors,
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"MongoDB collection analysis error: {str(e)}")
    finally:
        if client:
            try:
                client.close()
            except Exception:
                pass
