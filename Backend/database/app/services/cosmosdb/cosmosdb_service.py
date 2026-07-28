"""
Azure Cosmos DB — connection CRUD + live metadata/document browsing, SQL (Core)
API only for now (the `api_type` field is stored and shown in the UI so
MongoDB/Cassandra/Gremlin/Table API support can be added later without a
schema change — each would get its own client builder + service functions
alongside these, dispatched by `conn.cloud_api_type`).

Deliberately uses ONLY the account endpoint + primary key — no Azure AD App
Registration / Service Principal anywhere. Every property, statistic, and
metric here comes from the Cosmos SDK itself (container/database reads,
throughput reads, and response headers Cosmos already returns on ordinary
calls), or from ActMon's own query-activity log (see cosmos_query_log_model).
Anything that genuinely requires Azure Monitor / Log Analytics is reported as
"Not Available with Current Credentials" rather than faked.
"""
import base64
import math
import time
from datetime import datetime

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.connection_model import ConnectionMaster
from app.models.connection_schema import CosmosDBConnectionCreate
from app.models.cosmos_query_log_model import CosmosQueryLog
from app.services.common.crypto_service import encrypt_secret, decrypt_secret

PROVIDER = "azure_cosmos"
SLOW_QUERY_THRESHOLD_MS = 500


def _not_found():
    raise HTTPException(status_code=404, detail="Azure Cosmos DB connection not found")


def _get_conn(connection_id: int, db: Session) -> ConnectionMaster:
    conn = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == connection_id, ConnectionMaster.db_type == "cosmosdb",
    ).first()
    if not conn:
        _not_found()
    return conn


def _log_call(db: Session, connection_id: int, operation: str, detail: str, start: float,
               error: str = None, request_charge: float = None, result_value: float = None,
               storage_bytes: float = None, activity_id: str = None):
    """Record timing/RU-cost/success for a call OUR backend makes to this
    connection — never for calls made by anything else, and never adds a
    Cosmos request of its own. A logging failure must not break the real
    request, so this is fully isolated in its own try/except.

    When `error` is the actual exception object (not just a string), its class
    name and HTTP status code (present on azure.cosmos's CosmosHttpResponseError)
    are captured too — real structured error data, no parsing/guessing needed."""
    try:
        entry = CosmosQueryLog(
            connection_id=connection_id,
            operation=operation,
            detail=(detail or "")[:500],
            duration_ms=int((time.time() - start) * 1000),
            request_charge=round(request_charge, 2) if request_charge is not None else None,
            result_value=result_value,
            storage_bytes=storage_bytes,
            activity_id=activity_id,
            error_type=(type(error).__name__ if error is not None else None),
            http_status_code=(getattr(error, "status_code", None) if error is not None else None),
            success=error is None,
            error_message=(str(error)[:2000] if error else None),
        )
        db.add(entry)
        db.commit()
    except Exception:
        db.rollback()


class _ResponseCapture:
    """response_hook target — accumulates RU charge across every call it's
    passed to (cross-partition queries invoke it once per partition/page, so
    summing gives the true total RU cost of the whole operation) and keeps
    the most recent headers dict around for parsing quota/usage/partition
    stats Cosmos returns natively (no Azure Monitor involved), plus the most
    recent x-ms-activity-id for support/diagnostics correlation."""
    def __init__(self):
        self.total_rc = 0.0
        self.last_headers = {}
        self.last_activity_id = None

    def __call__(self, headers, body=None):
        # Cosmos's SDK doesn't call every response_hook with the same arity —
        # some code paths (e.g. get_database_account) invoke it with just the
        # headers, others (queries, container reads) pass headers + body.
        try:
            self.total_rc += float(headers.get("x-ms-request-charge", 0) or 0)
        except (TypeError, ValueError):
            pass
        self.last_headers = headers or {}
        aid = (headers or {}).get("x-ms-activity-id")
        if aid:
            self.last_activity_id = aid


def _parse_usage_header(value: str) -> dict:
    """Parses Cosmos's `x-ms-resource-usage` / `x-ms-resource-quota` headers,
    e.g. 'collectionSize=2055091;documentsSize=1535723;documentsCount=1969753'."""
    out = {}
    if not value:
        return out
    for part in value.split(";"):
        if "=" in part:
            k, v = part.split("=", 1)
            try:
                out[k] = int(v)
            except ValueError:
                out[k] = v
    return out


def _sample_document_fields(container_client, cap: "_ResponseCapture", limit: int = 15) -> dict:
    """Reads a real, bounded sample of actual documents (not just container
    metadata) and summarizes per-field presence/null-rate/observed types —
    genuine content analysis for Actmon AI to reason about (schema drift,
    always-null fields, unexpected types), never fabricated. Deliberately
    small and capped: enough for real signal without a full container scan."""
    docs = list(container_client.query_items(
        query=f"SELECT TOP {int(limit)} * FROM c",
        enable_cross_partition_query=True, response_hook=cap,
    ))
    field_stats = {}
    for d in docs:
        for k, v in d.items():
            if k.startswith("_"):
                continue
            info = field_stats.setdefault(k, {"present": 0, "null": 0, "types": set()})
            info["present"] += 1
            if v is None:
                info["null"] += 1
            else:
                info["types"].add(type(v).__name__)
    fields = [
        {"field": k, "present_in_sample": s["present"], "null_count": s["null"], "types": sorted(s["types"])}
        for k, s in field_stats.items()
    ]
    return {"sample_size": len(docs), "fields": fields}


def _ai_json_call(prompt: str, ai_engine, max_attempts: int = 2) -> dict:
    """Calls the AI engine and parses a JSON object out of its response,
    retrying once if the model returns malformed JSON (occasionally drops the
    quotes around a value despite explicit instructions) before giving up —
    the caller sees a clean exception only after every attempt fails."""
    import json as _json
    import re as _re
    last_err = None
    for _ in range(max_attempts):
        raw = ai_engine.chat_once([{"role": "user", "content": prompt}])
        match = _re.search(r"\{.*\}", raw, _re.DOTALL)
        try:
            return _json.loads(match.group(0) if match else raw)
        except Exception as e:
            last_err = e
    raise last_err


def _cloud_config(request: CosmosDBConnectionCreate) -> dict:
    return {
        "preferred_region": request.preferred_region,
        "consistency_level": request.consistency_level,
        "connection_timeout_sec": request.connection_timeout_sec or 30,
        "ssl_enabled": request.ssl_enabled if request.ssl_enabled is not None else True,
        "proxy": request.proxy,
        "custom_headers": request.custom_headers,
        "description": request.description,
        "resource_group": request.resource_group,
        "subscription_id": request.subscription_id,
    }


def _to_public_dict(conn: ConnectionMaster) -> dict:
    """Connection row for API responses — never includes the decrypted keys."""
    cfg = conn.cloud_config or {}
    return {
        "id": conn.id,
        "connection_name": conn.connection_name,
        "db_type": conn.db_type,
        "cloud_provider": conn.cloud_provider,
        "api_type": conn.cloud_api_type,
        "account_name": (conn.cloud_account_name or "").strip() or None,
        "endpoint": conn.cloud_endpoint,
        # .strip() guards against stray leading/trailing whitespace typed into
        # the Add Connection form (Cosmos rejects "db name with a leading
        # space" as not-found — this silently fixes it for existing rows too).
        "database_name": (conn.database_name or "").strip(),
        "container_name": (conn.cloud_container_name or "").strip(),
        "partition_key": conn.cloud_partition_key,
        "has_secondary_key": bool(conn.cloud_secondary_key_enc),
        "preferred_region": cfg.get("preferred_region"),
        "consistency_level": cfg.get("consistency_level"),
        "connection_timeout_sec": cfg.get("connection_timeout_sec"),
        "ssl_enabled": cfg.get("ssl_enabled"),
        "description": cfg.get("description"),
        "resource_group": cfg.get("resource_group"),
        "subscription_id": cfg.get("subscription_id"),
    }


def _cosmos_client_class():
    try:
        from azure.cosmos import CosmosClient
        return CosmosClient
    except ImportError:
        raise HTTPException(
            status_code=500,
            detail="azure-cosmos package is not installed on this server. "
                    "Run: pip install -r requirements.txt (or: pip install azure-cosmos)",
        )


def _client_for(conn: ConnectionMaster):
    CosmosClient = _cosmos_client_class()
    key = decrypt_secret(conn.cloud_primary_key_enc)
    if not key:
        raise HTTPException(status_code=400, detail="Connection has no usable primary key")
    return CosmosClient(url=conn.cloud_endpoint, credential=key,
                         connection_timeout=(conn.cloud_config or {}).get("connection_timeout_sec", 30))


# ── CRUD ─────────────────────────────────────────────────────────────

def list_connections(db: Session, org_id=None):
    query = db.query(ConnectionMaster).filter(ConnectionMaster.db_type == "cosmosdb")
    if org_id is not None:
        query = query.filter(ConnectionMaster.org_id == org_id)
    return {"status": "success", "data": [_to_public_dict(c) for c in query.all()]}


def create_connection(request: CosmosDBConnectionCreate, db: Session, org_id=1):
    if not request.primary_key:
        raise HTTPException(status_code=400, detail="Primary Key is required")
    try:
        conn = ConnectionMaster(
            db_type="cosmosdb",
            org_id=org_id,
            connection_name=request.connection_name,
            database_name=request.database_name.strip(),
            cloud_provider=PROVIDER,
            cloud_api_type=request.api_type or "sql",
            cloud_account_name=(request.account_name or "").strip() or None,
            cloud_endpoint=request.endpoint,
            cloud_primary_key_enc=encrypt_secret(request.primary_key),
            cloud_secondary_key_enc=encrypt_secret(request.secondary_key),
            cloud_container_name=request.container_name.strip(),
            cloud_partition_key=request.partition_key,
            cloud_config=_cloud_config(request),
        )
        db.add(conn)
        db.commit()
        db.refresh(conn)
        return {"status": "success", "message": "Azure Cosmos DB connection created successfully", "data": _to_public_dict(conn)}
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(e))


def get_connection(connection_id: int, db: Session):
    conn = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == connection_id, ConnectionMaster.db_type == "cosmosdb",
    ).first()
    if not conn:
        _not_found()
    return {"status": "success", "data": _to_public_dict(conn)}


def update_connection(connection_id: int, request: CosmosDBConnectionCreate, db: Session):
    conn = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == connection_id, ConnectionMaster.db_type == "cosmosdb",
    ).first()
    if not conn:
        _not_found()
    try:
        conn.connection_name = request.connection_name
        conn.database_name = request.database_name.strip()
        conn.cloud_api_type = request.api_type or "sql"
        conn.cloud_account_name = (request.account_name or "").strip() or None
        conn.cloud_endpoint = request.endpoint
        if request.primary_key:
            conn.cloud_primary_key_enc = encrypt_secret(request.primary_key)
        if request.secondary_key:
            conn.cloud_secondary_key_enc = encrypt_secret(request.secondary_key)
        conn.cloud_container_name = request.container_name.strip()
        conn.cloud_partition_key = request.partition_key
        conn.cloud_config = _cloud_config(request)
        db.commit()
        db.refresh(conn)
        return {"status": "success", "message": "Azure Cosmos DB connection updated successfully", "data": _to_public_dict(conn)}
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(e))


def delete_connection(connection_id: int, db: Session):
    conn = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == connection_id, ConnectionMaster.db_type == "cosmosdb",
    ).first()
    if not conn:
        _not_found()
    db.delete(conn)
    db.commit()
    return {"status": "success", "message": "Azure Cosmos DB connection deleted successfully"}


def test_connection(connection_id: int, db: Session):
    """Re-test an already-saved connection (used by the connection list's 'Test' action)."""
    conn = _get_conn(connection_id, db)
    client = _client_for(conn)
    start = time.time()
    cap = _ResponseCapture()
    try:
        props = client.get_database_account(response_hook=cap)
        _log_call(db, connection_id, "test_connection", "", start, request_charge=cap.total_rc, activity_id=cap.last_activity_id)
        return {"status": "success", "message": "Connection successful", "consistency_policy": props.ConsistencyPolicy}
    except Exception as e:
        _log_call(db, connection_id, "test_connection", "", start, error=e)
        raise HTTPException(status_code=400, detail=f"Azure Cosmos DB connection failed: {e}")


# ── Live browsing (SQL / Core API) ──────────────────────────────────

def list_databases(connection_id: int, db: Session):
    conn = _get_conn(connection_id, db)
    client = _client_for(conn)
    start = time.time()
    cap = _ResponseCapture()
    try:
        dbs = [{"id": d["id"]} for d in client.list_databases(response_hook=cap)]
        _log_call(db, connection_id, "list_databases", "", start, request_charge=cap.total_rc, activity_id=cap.last_activity_id)
        return {"status": "success", "data": dbs}
    except Exception as e:
        _log_call(db, connection_id, "list_databases", "", start, error=e)
        raise HTTPException(status_code=400, detail=f"Failed to list databases: {e}")


def list_containers(connection_id: int, database_id: str, db: Session):
    """Metadata only — partition key / indexing policy / TTL come free from
    list_containers() itself, and get_throughput() is a control-plane offer
    read (doesn't touch partition data). Deliberately does NOT run a
    SELECT COUNT(1) or any other data-plane query here: a cross-partition scan
    on every page load would burn RU and hit every physical partition just to
    show a number nobody asked for. Full container detail (storage, real
    estimated doc count, autoscale, analytical store, etc.) lives in
    get_container_details(), fetched only when a container is actually opened."""
    conn = _get_conn(connection_id, db)
    client = _client_for(conn)
    start = time.time()
    cap = _ResponseCapture()
    try:
        db_client = client.get_database_client(database_id)
        out = []
        for c in db_client.list_containers(response_hook=cap):
            container_client = db_client.get_container_client(c["id"])
            item = {
                "id": c["id"],
                "partition_key": (c.get("partitionKey") or {}).get("paths", []),
                "indexing_policy": c.get("indexingPolicy"),
                "default_ttl": c.get("defaultTtl"),
                "throughput_ru": None,
            }
            try:
                item["throughput_ru"] = container_client.get_throughput(response_hook=cap).offer_throughput
            except Exception:
                pass  # serverless accounts have no provisioned throughput
            out.append(item)
        _log_call(db, connection_id, "list_containers", database_id, start, request_charge=cap.total_rc, activity_id=cap.last_activity_id)
        return {"status": "success", "data": out}
    except Exception as e:
        _log_call(db, connection_id, "list_containers", database_id, start, error=e)
        raise HTTPException(status_code=400, detail=f"Failed to list containers: {e}")


def get_container_details(connection_id: int, database_id: str, container_id: str, db: Session):
    """Every real property/statistic obtainable from the endpoint+key alone:
    indexing policy, unique keys, conflict resolution, computed properties,
    analytical store status, throughput (+ autoscale detection), and —
    critically — real storage size and estimated document count, both read
    straight from Cosmos's own `x-ms-resource-usage` response header via a
    single lightweight container.read() call. No Azure Monitor involved."""
    conn = _get_conn(connection_id, db)
    client = _client_for(conn)
    start = time.time()
    cap = _ResponseCapture()
    try:
        db_client = client.get_database_client(database_id)
        container_client = db_client.get_container_client(container_id)

        props = container_client.read(
            populate_quota_info=True,
            populate_partition_key_range_statistics=True,
            response_hook=cap,
        )
        usage = _parse_usage_header(cap.last_headers.get("x-ms-resource-usage", ""))
        quota = _parse_usage_header(cap.last_headers.get("x-ms-resource-quota", ""))

        throughput_ru = None
        is_autoscale = False
        try:
            tp = container_client.get_throughput(response_hook=cap)
            if tp.auto_scale_max_throughput:
                throughput_ru = tp.auto_scale_max_throughput
                is_autoscale = True
            else:
                throughput_ru = tp.offer_throughput
        except Exception:
            pass  # serverless — no provisioned offer to read

        doc_count = usage.get("documentsCount")
        if doc_count == -1:
            doc_count = None  # Cosmos returns -1 when this counter isn't tracked for the container

        analytical_ttl = props.get("analyticalStorageTtl")

        # Roughly matches Microsoft's own published partitioning guidance —
        # labeled as an estimate, never presented as an exact live count (which
        # would require enumerating physical partition key ranges, not exposed
        # by the public SDK surface).
        storage_gb = (usage.get("documentsSize") or 0) / (1024 ** 3)
        est_partitions = max(1, math.ceil(max((throughput_ru or 0) / 10000, storage_gb / 50)))

        result = {
            "id": props.get("id"),
            "partition_key": (props.get("partitionKey") or {}).get("paths", []),
            "default_ttl": props.get("defaultTtl"),
            "analytical_store_enabled": analytical_ttl is not None,
            "analytical_store_ttl": analytical_ttl,
            "indexing_policy": props.get("indexingPolicy"),
            "unique_key_policy": props.get("uniqueKeyPolicy"),
            "conflict_resolution_policy": props.get("conflictResolutionPolicy"),
            "computed_properties": props.get("computedProperties"),
            "throughput_ru": throughput_ru,
            "is_autoscale": is_autoscale,
            "estimated_document_count": doc_count,
            "data_size_bytes": usage.get("documentsSize"),
            "collection_size_bytes": usage.get("collectionSize"),
            "quota_collection_size_bytes": quota.get("collectionSize"),
            "estimated_physical_partitions": est_partitions,
            "last_refreshed": datetime.utcnow().isoformat(),
        }
        _log_call(db, connection_id, "container_details", f"{database_id}/{container_id}", start,
                   request_charge=cap.total_rc, result_value=doc_count,
                   storage_bytes=usage.get("documentsSize"), activity_id=cap.last_activity_id)
        return {"status": "success", "data": result}
    except Exception as e:
        _log_call(db, connection_id, "container_details", f"{database_id}/{container_id}", start, error=e)
        raise HTTPException(status_code=400, detail=f"Failed to get container details: {e}")


def get_document_stats(connection_id: int, database_id: str, container_id: str, db: Session):
    """Real newest/oldest document via two cheap TOP-1 queries ordered by the
    system `_ts` property (already indexed by default — no full scan). Average
    document size / largest document are NOT derivable this way without a full
    container scan, so they're reported as unavailable rather than estimated
    from a small, misleading sample."""
    conn = _get_conn(connection_id, db)
    client = _client_for(conn)
    start = time.time()
    cap = _ResponseCapture()
    try:
        container_client = client.get_database_client(database_id).get_container_client(container_id)

        newest = list(container_client.query_items(
            query="SELECT TOP 1 * FROM c ORDER BY c._ts DESC",
            enable_cross_partition_query=True, response_hook=cap,
        ))
        oldest = list(container_client.query_items(
            query="SELECT TOP 1 * FROM c ORDER BY c._ts ASC",
            enable_cross_partition_query=True, response_hook=cap,
        ))

        result = {
            "newest_document": newest[0] if newest else None,
            "oldest_document": oldest[0] if oldest else None,
        }
        _log_call(db, connection_id, "document_stats", f"{database_id}/{container_id}", start, request_charge=cap.total_rc, activity_id=cap.last_activity_id)
        return {"status": "success", "data": result}
    except Exception as e:
        _log_call(db, connection_id, "document_stats", f"{database_id}/{container_id}", start, error=e)
        raise HTTPException(status_code=400, detail=f"Failed to get document stats: {e}")


def get_database_summary(connection_id: int, database_id: str, db: Session):
    """Per-database rollup for the Databases tab — container count, total
    (summed) documents/storage/throughput. Iterates containers via the same
    cheap container.read(populate_quota_info=True) used in
    get_container_details(); capped at 50 containers per database to keep this
    bounded — flagged via `container_count_capped` if a database has more."""
    conn = _get_conn(connection_id, db)
    client = _client_for(conn)
    start = time.time()
    cap = _ResponseCapture()
    try:
        db_client = client.get_database_client(database_id)
        containers = list(db_client.list_containers(response_hook=cap))
        capped = containers[:50]

        total_docs = 0
        total_storage = 0
        total_ru = 0
        doc_count_partial = False
        for c in capped:
            container_client = db_client.get_container_client(c["id"])
            try:
                container_client.read(populate_quota_info=True, response_hook=cap)
                usage = _parse_usage_header(cap.last_headers.get("x-ms-resource-usage", ""))
                dc = usage.get("documentsCount")
                if dc is not None and dc != -1:
                    total_docs += dc
                else:
                    doc_count_partial = True
                total_storage += usage.get("documentsSize") or 0
            except Exception:
                doc_count_partial = True
            try:
                tp = container_client.get_throughput(response_hook=cap)
                total_ru += (tp.auto_scale_max_throughput or tp.offer_throughput or 0)
            except Exception:
                pass

        result = {
            "database": database_id,
            "container_count": len(containers),
            "container_count_capped": len(containers) > 50,
            "total_documents": total_docs,
            "total_documents_partial": doc_count_partial,
            "storage_bytes": total_storage,
            "throughput_ru": total_ru,
            "status": "reachable",
        }
        _log_call(db, connection_id, "database_summary", database_id, start, request_charge=cap.total_rc, activity_id=cap.last_activity_id)
        return {"status": "success", "data": result}
    except Exception as e:
        _log_call(db, connection_id, "database_summary", database_id, start, error=e)
        raise HTTPException(status_code=400, detail=f"Failed to get database summary: {e}")


def browse_items(connection_id: int, database_id: str, container_id: str, db: Session,
                  limit: int = 25, continuation_token: str | None = None, sort_recent: bool = False,
                  filter_query: str | None = None):
    conn = _get_conn(connection_id, db)
    client = _client_for(conn)
    start = time.time()
    cap = _ResponseCapture()
    try:
        container_client = client.get_database_client(database_id).get_container_client(container_id)
        token = base64.b64decode(continuation_token).decode() if continuation_token else None
        # _ts is a system property Cosmos stamps on every document with its last
        # write time — ordering by it (same query cost as SELECT *) is how we
        # show "recently modified" for free, no separate audit/history feature needed.
        if filter_query:
            query = filter_query
        elif sort_recent:
            query = "SELECT * FROM c ORDER BY c._ts DESC"
        else:
            query = "SELECT * FROM c"
        pager = container_client.query_items(
            query=query, enable_cross_partition_query=True, max_item_count=limit, response_hook=cap,
        ).by_page(token)
        items = next(pager, [])
        items = list(items)
        next_token = pager.continuation_token
        _log_call(db, connection_id, "browse_items", f"{database_id}/{container_id}", start, request_charge=cap.total_rc, activity_id=cap.last_activity_id)
        return {
            "status": "success",
            "data": items,
            "continuation_token": base64.b64encode(next_token.encode()).decode() if next_token else None,
        }
    except Exception as e:
        _log_call(db, connection_id, "browse_items", f"{database_id}/{container_id}", start, error=e)
        raise HTTPException(status_code=400, detail=f"Failed to browse items: {e}")


def get_document_count(connection_id: int, database_id: str, container_id: str, db: Session):
    """Opt-in exact-count fallback — never called automatically anywhere in
    this app. A cross-partition SELECT VALUE COUNT(1) has a real RU cost and
    touches every physical partition, so this only runs when a user
    explicitly clicks 'Get Exact Count' (used when the free estimated count
    from get_container_details() is unavailable or they want to double-check
    it)."""
    conn = _get_conn(connection_id, db)
    client = _client_for(conn)
    start = time.time()
    cap = _ResponseCapture()
    try:
        container_client = client.get_database_client(database_id).get_container_client(container_id)
        result = list(container_client.query_items(
            query="SELECT VALUE COUNT(1) FROM c", enable_cross_partition_query=True, response_hook=cap,
        ))
        count = result[0] if result else 0
        _log_call(db, connection_id, "document_count", f"{database_id}/{container_id}", start,
                   request_charge=cap.total_rc, result_value=count, activity_id=cap.last_activity_id)
        return {"status": "success", "count": count}
    except Exception as e:
        _log_call(db, connection_id, "document_count", f"{database_id}/{container_id}", start, error=e)
        raise HTTPException(status_code=400, detail=f"Count failed: {e}")


def _activity_row(r: CosmosQueryLog) -> dict:
    return {
        "id": r.id,
        "operation": r.operation,
        "detail": r.detail,
        "duration_ms": r.duration_ms,
        "request_charge": r.request_charge,
        "activity_id": r.activity_id,
        "success": r.success,
        "error_type": r.error_type,
        "http_status_code": r.http_status_code,
        "error_message": r.error_message,
        "created_at": r.created_at.isoformat() if r.created_at else None,
    }


def get_activity(connection_id: int, db: Session, limit: int = 200):
    """Query count / avg response time / slow queries / success-failure /
    connection status / error logs / RU trend / document-growth trend — all
    derived from calls OUR OWN backend already made (see _log_call), so this
    needs no Azure Monitor, no Log Analytics, and adds zero new load on the
    Cosmos account."""
    _get_conn(connection_id, db)  # 404s if the connection doesn't exist
    rows = (
        db.query(CosmosQueryLog)
        .filter(CosmosQueryLog.connection_id == connection_id)
        .order_by(CosmosQueryLog.created_at.desc())
        .limit(limit)
        .all()
    )
    total = len(rows)
    success_count = sum(1 for r in rows if r.success)
    failure_count = total - success_count
    durations = [r.duration_ms for r in rows if r.duration_ms is not None]
    avg_response_ms = round(sum(durations) / len(durations), 1) if durations else None
    slow = sorted([r for r in rows if (r.duration_ms or 0) > SLOW_QUERY_THRESHOLD_MS], key=lambda r: -(r.duration_ms or 0))
    errors = [r for r in rows if not r.success]
    last = rows[0] if rows else None

    ops = {}
    for r in rows:
        ops[r.operation] = ops.get(r.operation, 0) + 1
    operations = [{"type": k, "count": v} for k, v in sorted(ops.items(), key=lambda kv: -kv[1])]

    reversed_rows = list(reversed(rows))
    response_time_trend = [
        {"t": r.created_at.isoformat(), "v": r.duration_ms} for r in reversed_rows if r.duration_ms is not None
    ]
    request_charge_trend = [
        {"t": r.created_at.isoformat(), "v": r.request_charge} for r in reversed_rows if r.request_charge is not None
    ]
    document_growth = [
        {"t": r.created_at.isoformat(), "v": r.result_value} for r in reversed_rows
        if r.operation in ("container_details", "document_count") and r.result_value is not None
    ]
    storage_growth = [
        {"t": r.created_at.isoformat(), "v": r.storage_bytes} for r in reversed_rows
        if r.operation == "container_details" and r.storage_bytes is not None
    ]
    # ActMon only ever reads from a connected Cosmos DB account (browsing,
    # querying, metadata reads) — it never writes documents, so every logged
    # operation is a read. Shown as-is rather than inventing a write count.
    read_write_split = {"read": total, "write": 0}

    return {
        "status": "success",
        "query_count": total,
        "avg_response_ms": avg_response_ms,
        "success_count": success_count,
        "failure_count": failure_count,
        "connection_status": "connected" if (last and last.success) else ("error" if last else "unknown"),
        "slow_query_threshold_ms": SLOW_QUERY_THRESHOLD_MS,
        "slow_queries": [_activity_row(r) for r in slow[:20]],
        "error_logs": [_activity_row(r) for r in errors[:20]],
        "recent": [_activity_row(r) for r in rows[:30]],
        "operations": operations,
        "response_time_trend": response_time_trend[-50:],
        "request_charge_trend": request_charge_trend[-50:],
        "document_growth": document_growth[-50:],
        "storage_growth": storage_growth[-50:],
        "read_write_split": read_write_split,
    }


def get_ai_analysis(connection_id: int, database_id: str, container_id: str, db: Session):
    """Actmon AI — a structured health/optimization report built from real data:
    container details, indexing policy, throughput, recent activity/slow-
    queries/errors, an actual bounded sample of real documents (field/type/null
    patterns — not just container metadata), and the real list of sibling
    containers in the same database for honest scope context. Deliberately
    slower than a metadata-only report (a real document sample is a genuine
    data-plane query) — accepted in exchange for a report that reflects what
    was actually inspected rather than guessing from aggregates alone. Never
    mentions the underlying model/provider name; gracefully degrades if the AI
    engine isn't configured rather than failing the whole page."""
    conn = _get_conn(connection_id, db)

    try:
        details = get_container_details(connection_id, database_id, container_id, db)["data"]
    except HTTPException as e:
        details = {"error": e.detail}

    activity = get_activity(connection_id, db, limit=200)

    try:
        sibling_containers = [c["id"] for c in list_containers(connection_id, database_id, db)["data"]]
    except HTTPException:
        sibling_containers = []

    doc_sample = {"sample_size": 0, "fields": []}
    sample_start = time.time()
    try:
        client = _client_for(conn)
        container_client = client.get_database_client(database_id).get_container_client(container_id)
        cap = _ResponseCapture()
        doc_sample = _sample_document_fields(container_client, cap, limit=15)
        _log_call(db, connection_id, "ai_document_sample", f"{database_id}/{container_id}", sample_start,
                   request_charge=cap.total_rc, result_value=doc_sample["sample_size"], activity_id=cap.last_activity_id)
    except Exception as e:
        _log_call(db, connection_id, "ai_document_sample", f"{database_id}/{container_id}", sample_start, error=e)
        # Sampling is an enrichment, not a hard requirement — a failed sample
        # (e.g. an empty container) must not block the rest of the report.

    import os
    try:
        from app.services.chatbot import ai_engine
    except ImportError:
        return {
            "status": "success",
            "available": False,
            "reason": "Actmon AI engine is not installed on this server.",
        }
    if not os.getenv("GROQ_API_KEY", ""):
        return {
            "status": "success",
            "available": False,
            "reason": "Actmon AI is not configured on this server.",
        }

    prompt = f"""You are Actmon AI, analyzing an Azure Cosmos DB container for the ActMon monitoring platform.
Never mention any underlying model or provider name — you are always "Actmon AI".

Database: {database_id}
All containers found in this database: {sibling_containers}
Container analyzed in depth: {container_id}
Partition key: {details.get('partition_key')}
Provisioned throughput: {details.get('throughput_ru')} RU/s ({'autoscale' if details.get('is_autoscale') else 'manual'})
Estimated document count: {details.get('estimated_document_count')}
Data size (bytes): {details.get('data_size_bytes')}
Estimated physical partitions: {details.get('estimated_physical_partitions')}
Indexing policy: {details.get('indexing_policy')}
Analytical store enabled: {details.get('analytical_store_enabled')}

Real document sample — {doc_sample['sample_size']} actual documents read from this container just now.
Per-field stats across that sample (field name, how many sampled docs had it, how many of those were null, observed value types):
{doc_sample['fields']}
Use this to spot real schema issues: fields that are always null (candidates to stop indexing), inconsistent types across documents, or fields present in some documents but not others.

Recent activity (last {activity.get('query_count')} logged calls):
- Avg response time: {activity.get('avg_response_ms')} ms
- Success/Failure: {activity.get('success_count')}/{activity.get('failure_count')}
- Slow queries (> {activity.get('slow_query_threshold_ms')}ms): {len(activity.get('slow_queries', []))}
- Recent errors: {[e.get('error_message') for e in activity.get('error_logs', [])[:5]]}

Respond with ONLY a JSON object (no markdown, no commentary) with EXACTLY these keys:
{{
  "checks_performed": [<string>, ...],
  "health_score": <0-100 integer>,
  "problems_detected": [<string>, ...],
  "performance_analysis": "<string>",
  "storage_analysis": "<string>",
  "partition_analysis": "<string>",
  "index_analysis": "<string>",
  "cost_optimization_suggestions": [<string>, ...],
  "recommended_actions": [<string>, ...],
  "expected_performance_improvement": "<string>"
}}

"checks_performed" must plainly and specifically list what was actually inspected for this report — e.g. how many containers exist in the database and which ones, how many real documents were sampled from {container_id}, that the indexing policy/throughput/recent activity log were reviewed. Be concrete and honest; never claim to have checked something not listed above.

"index_analysis" must be written in plain, jargon-free English for someone who has never used a database before. Explain, specifically for THIS container's actual indexing policy above: (1) what its current indexing setup does in one or two plain sentences, (2) the concrete BENEFIT of that setup (what it makes fast/cheap), (3) the concrete DOWNSIDE or trade-off of that setup (what it makes slow/expensive, or any risk), and (4) whether the real document sample suggests anything is misconfigured (e.g. an indexed field that's always null, or an excluded field the app likely queries by). Avoid restating raw JSON; translate it into consequences a non-technical reader would understand."""

    try:
        parsed = _ai_json_call(prompt, ai_engine)
        return {"status": "success", "available": True, "data": parsed}
    except Exception as e:
        return {
            "status": "success",
            "available": False,
            "reason": f"Actmon AI analysis could not be generated: {e}",
        }


def get_error_ai_analysis(connection_id: int, log_id: int, db: Session):
    """On-demand Actmon AI explanation for one logged row — used by both the
    Error Logs tab (a real failure) and the Slow Queries tab (a real call that
    succeeded but crossed the slow-query threshold). Scoped to a single row
    (never a batch job over the whole history) so this stays cheap and fast —
    an "Analyze" click per row, not an automatic AI call for every entry."""
    _get_conn(connection_id, db)  # 404s if the connection doesn't exist
    row = (
        db.query(CosmosQueryLog)
        .filter(CosmosQueryLog.id == log_id, CosmosQueryLog.connection_id == connection_id)
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail="Log entry not found")

    import os
    try:
        from app.services.chatbot import ai_engine
    except ImportError:
        return {"status": "success", "available": False, "reason": "Actmon AI engine is not installed on this server."}
    if not os.getenv("GROQ_API_KEY", ""):
        return {"status": "success", "available": False, "reason": "Actmon AI is not configured on this server."}

    if row.success:
        situation = (
            f"This call SUCCEEDED but was flagged as a SLOW QUERY — it took {row.duration_ms} ms, "
            f"above the {SLOW_QUERY_THRESHOLD_MS} ms threshold. There is no error; explain likely reasons for the "
            f"latency/RU cost and how to speed it up."
        )
        field_guidance = """- summary: one plain sentence stating this was a slow-but-successful call and roughly how much slower than normal
- root_cause: 2-4 plain-English sentences (no jargon; briefly explain any technical term you use) on the likely reason(s) this
  specific call was slow/expensive, e.g. it scanned across partitions instead of one, it filtered on a field with no index so
  Cosmos had to check every document, it returned a very large number of results, or it was a one-off cold start
- suggested_fix: 2-3 concrete, actionable, step-by-step optimization suggestions a developer could actually apply"""
    else:
        situation = "This call FAILED with a real Azure Cosmos DB error. Explain what actually caused it."
        field_guidance = """- summary: one plain sentence stating what went wrong in the simplest possible terms
- root_cause: 2-4 plain-English sentences (no jargon; briefly explain any technical term you use) on what actually caused
  this specific error and why Cosmos DB responded this way
- suggested_fix: 2-3 concrete, actionable, step-by-step sentences on how to fix or avoid it"""

    prompt = f"""You are Actmon AI, explaining one real Azure Cosmos DB call captured by the ActMon monitoring platform, to someone
who may not be a database expert. Never mention any underlying model or provider name — you are always "Actmon AI". Write in plain,
jargon-free English throughout; if you must use a technical term (RU, partition, index, etc.) briefly explain what it means inline.

{situation}

Operation: {row.operation}
Target (database/container or query detail): {row.detail}
Success: {row.success}
Error type (SDK exception class, if any): {row.error_type}
HTTP status code (if any): {row.http_status_code}
Duration: {row.duration_ms} ms
Request charge: {row.request_charge} RU
Raw error message (if any): {row.error_message}

Field guidance:
{field_guidance}

Respond with ONLY a valid JSON object — no markdown, no commentary, no code fences. Every value MUST be a properly double-quoted
JSON string; never write a bare/unquoted value. Do not put a literal line break inside a string — write it as one continuous line.
Respond with EXACTLY this shape:
{{
  "summary": "<string>",
  "root_cause": "<string>",
  "suggested_fix": "<string>"
}}"""

    try:
        parsed = _ai_json_call(prompt, ai_engine)
        return {"status": "success", "available": True, "data": parsed}
    except Exception as e:
        return {"status": "success", "available": False, "reason": f"Actmon AI analysis could not be generated: {e}"}


def test_inline(payload: dict):
    """Validate credentials BEFORE saving — used by the Add Connection wizard's
    'Test Connection' button. Also detects/confirms which database + container
    are reachable, matching the 'validate credentials → detect API → fetch
    databases → fetch containers' flow described for this feature."""
    CosmosClient = _cosmos_client_class()
    from azure.cosmos.exceptions import CosmosHttpResponseError
    endpoint = payload.get("endpoint")
    key = payload.get("primary_key")
    if not endpoint or not key:
        raise HTTPException(status_code=400, detail="Endpoint and Primary Key are required")
    try:
        client = CosmosClient(url=endpoint, credential=key, connection_timeout=payload.get("connection_timeout_sec") or 30)
        client.get_database_account()  # cheapest real round-trip that proves the key+endpoint are valid

        database_name = payload.get("database_name")
        container_name = payload.get("container_name")
        detail = "Connection successful."
        if database_name:
            try:
                db_client = client.get_database_client(database_name)
                db_client.read()
                detail += f" Database '{database_name}' found."
                if container_name:
                    container_client = db_client.get_container_client(container_name)
                    container_client.read()
                    detail += f" Container '{container_name}' found."
            except CosmosHttpResponseError as e:
                detail += f" (Warning: {e.message if hasattr(e, 'message') else e})"
        return {"status": "success", "message": detail}
    except CosmosHttpResponseError as e:
        raise HTTPException(status_code=400, detail=f"Azure Cosmos DB connection failed: {e.message if hasattr(e, 'message') else e}")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Azure Cosmos DB connection failed: {e}")
