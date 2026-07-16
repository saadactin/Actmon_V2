"""
Metrics pipeline — orchestrator of the two telemetry tiers.
===========================================================

  every metric sample ──► redis_store_service        (HOT: latest + 1h ring + indexes)
                            │ displaced previous-latest…
                            └─► metrics_history_service (COLD: per-module/tech
                                                          ClickHouse tables)

This module owns only:
  • classification — kind (infra|database) + tech (mysql|oracle|…) + conn_id
  • record()       — the hand-off between the tiers ("last-in-first")
  • the AgentMetric insert hook (zero call-site changes)
  • thin delegates for live/browse/history/status

Tier implementations live in their own service folders:
  app/services/redis/redis_store_service.py           (hot tier)
  app/services/clickhouse/metrics_history_service.py  (history tier)

Config (env):  METRICS_PIPELINE_ENABLED  default true (master switch)
"""

import os
import time
import logging

from app.services.redis import redis_store_service as redis_store
from app.services.clickhouse import metrics_history_service as metrics_history

logger = logging.getLogger("metrics_pipeline")

_ENABLED = os.getenv("METRICS_PIPELINE_ENABLED", "true").strip().lower() not in ("0", "false", "no", "off")

# Numeric fields carried through the pipeline (mirror of AgentMetric).
_FIELDS = metrics_history.FIELDS


# ── Classification (kind + tech + conn_id) ─────────────────────────────────────

_TECH_MAP = {
    "mysql": "mysql", "mariadb": "mysql",
    "postgresql": "postgresql", "postgres": "postgresql",
    "mssql": "mssql", "sql server": "mssql", "sqlserver": "mssql",
    "oracle": "oracle", "oracle db": "oracle",
    "mongodb": "mongodb", "mongo": "mongodb",
    "clickhouse": "clickhouse",
}

_KIND_CACHE = {}          # agent_name -> (kind, tech, conn_id, cached_at_monotonic)
_KIND_TTL = 300.0


def classify(db_type):
    """(kind, tech) from an agent's db_type. Host/blank → infra; known DB → database."""
    t = (db_type or "").strip().lower()
    if not t or t == "host":
        return "infra", "host"
    tech = _TECH_MAP.get(t)
    if tech:
        return "database", tech
    return "database", t          # unknown engine: still a database, keep its name


def _classify_cached(agent_name, connection=None):
    """Resolve (kind, tech, conn_id) for an agent, caching for 5 min. When called from
    the insert hook we get the live SQLAlchemy connection — use it for a cheap lookup.
    conn_id = the database connection this agent monitors (0 for host/infra agents)."""
    now = time.monotonic()
    hit = _KIND_CACHE.get(agent_name)
    if hit and (now - hit[3]) < _KIND_TTL:
        return hit[0], hit[1], hit[2]
    db_type, conn_id = None, 0
    if connection is not None:
        try:
            row = connection.exec_driver_sql(
                "SELECT db_type, db_connection_id FROM agents WHERE agent_name = %s LIMIT 1",
                (agent_name,)
            ).first()
            if row:
                db_type = row[0]
                conn_id = int(row[1] or 0)
        except Exception:  # noqa: BLE001 — classification must never break the insert
            db_type, conn_id = None, 0
    kind, tech = classify(db_type)
    _KIND_CACHE[agent_name] = (kind, tech, conn_id, now)
    return kind, tech, conn_id


# ── Public API ─────────────────────────────────────────────────────────────────

def record(agent_name, metrics, kind=None, tech=None, conn_id=None, _connection=None):
    """Record one metrics sample for an agent. Called on EVERY AgentMetric insert
    (agent pushes + collector cycles). Never raises."""
    if not _ENABLED or not agent_name:
        return
    try:
        if not kind or not tech:
            kind, tech, resolved_conn = _classify_cached(agent_name, _connection)
            if conn_id is None:
                conn_id = resolved_conn
        sample = {"ts": time.time(), "kind": kind, "tech": tech, "agent": agent_name,
                  "conn_id": int(conn_id or 0)}
        for f in _FIELDS:
            v = metrics.get(f) if isinstance(metrics, dict) else getattr(metrics, f, None)
            if v is not None:
                sample[f] = float(v)
        # HOT tier: store; get back the displaced previous-latest…
        prev = redis_store.store_sample(agent_name, sample)
        # …and let it settle into the HISTORY tier ("last-in-first").
        if prev:
            metrics_history.flush_sample(agent_name, prev)
    except Exception as e:  # noqa: BLE001
        logger.debug("[metrics_pipeline] record: %s", e)


def live(agent_name, limit=240):
    """Newest-first hot samples (Redis ring). [] when the hot tier is off."""
    return redis_store.live(agent_name, limit)


def browse(kind=None, tech=None):
    """Hot-tier category view: agents grouped by (kind, tech) with latest sample."""
    return redis_store.browse(kind, tech)


def history(agent_name=None, minutes=60, kind=None, tech=None, conn_id=None):
    """History from the per-module/tech ClickHouse tables (newest first)."""
    return metrics_history.history(agent_name=agent_name, minutes=minutes,
                                   kind=kind, tech=tech, conn_id=conn_id)


def status():
    """Health of both tiers, for the UI/status endpoint."""
    ch_ok = metrics_history.is_up()
    return {"enabled": _ENABLED,
            "redis": redis_store.is_up(),
            "clickhouse": ch_ok,
            "tables": metrics_history.list_tables() if ch_ok else [],
            "ring_size": redis_store.RING_SIZE,
            "ch_ttl_days": metrics_history.TTL_DAYS}


# ── Stable facts (versions, database lists, config limits …) ──────────────────
# Stored ONCE — in POSTGRESQL (durable, always-on; survives Redis restarts) — and
# rewritten only when the freshly-collected value differs from the stored checksum.
# Drift appends to the PG change-log (primary audit) and to ClickHouse when it's
# available (bonus long-horizon copy).

from app.services.clickhouse import stable_changes_service as stable_changes

# Scalar facts worth tracking (first occurrence wins while scanning a payload).
_STABLE_SCALAR_KEYS = (
    "version", "product_version", "product_level", "edition",
    "instance_name", "db_name", "server_name", "db_unique_name",
    "log_mode", "open_mode", "database_status", "archiver",
    "max_connections", "max_sessions", "cpu_count", "cpu_cores",
    "sga_target_mb", "pga_target_mb", "physical_mem_mb",
    "database_count", "charset", "collation", "data_directory",
)
# List-of-named-things facts → stored as a sorted name list (order-insensitive).
_STABLE_LIST_KEYS = ("databases", "tablespaces")

# snapshot_type prefix → technology (snapshot names are per-engine already).
_SNAP_TECH = {"mysql": "mysql", "pg": "postgresql", "oracle": "oracle",
              "mssql": "mssql", "mongodb": "mongodb", "clickhouse": "clickhouse"}


def extract_stable_facts(payload, _out=None, _depth=0):
    """Generic scan of a dashboard snapshot for stable facts. Engine-agnostic:
    walks the dict (3 levels deep), picks known scalar keys and name-lists."""
    out = _out if _out is not None else {}
    if _depth > 3 or not isinstance(payload, dict):
        return out
    for k, v in payload.items():
        lk = str(k).lower()
        if lk in _STABLE_SCALAR_KEYS and lk not in out and isinstance(v, (str, int, float)) and v not in ("", None):
            out[lk] = v
        elif lk in _STABLE_LIST_KEYS and lk not in out and isinstance(v, list) and v:
            names = []
            for item in v:
                if isinstance(item, dict):
                    n = item.get("name") or item.get("db_name") or item.get("database")
                    if n:
                        names.append(str(n))
                elif isinstance(item, str):
                    names.append(item)
            if names:
                out[lk] = ", ".join(sorted(set(names)))
        elif isinstance(v, dict):
            extract_stable_facts(v, out, _depth + 1)
    return out


def _facts_diff(old, new):
    """Field-level changes: [{field, old, new}] — additions, removals, edits."""
    changes = []
    for k in sorted(set(old) | set(new)):
        ov, nv = old.get(k), new.get(k)
        if ov != nv:
            changes.append({"field": k,
                            "old": None if ov is None else str(ov)[:500],
                            "new": None if nv is None else str(nv)[:500]})
    return changes


def record_stable(agent_name, facts, kind="database", tech=None, conn_id=0, db=None):
    """Sync stable facts against POSTGRESQL: no write when unchanged (the normal
    case); on drift, update the stored row and append the field-level diff to the
    PG change-log (+ ClickHouse when available). Never raises."""
    if not _ENABLED or not facts:
        return None
    import hashlib
    import json as _json
    owns_session = db is None
    try:
        from app.models.agent_model import AgentStableFact, AgentStableChange
        if owns_session:
            from app.database.connection import SessionLocal
            db = SessionLocal()
        canon = _json.dumps(facts, sort_keys=True, default=str)
        sha = hashlib.sha1(canon.encode("utf-8")).hexdigest()
        row = db.query(AgentStableFact).filter(
            AgentStableFact.agent_name == agent_name).first()
        if row and row.sha == sha:
            return None                              # identical — store nothing
        if row:
            try:
                old = _json.loads(row.facts)
            except Exception:  # noqa: BLE001
                old = {}
            changes = _facts_diff(old, facts)
            row.facts, row.sha = canon, sha
            row.kind, row.tech, row.conn_id = kind, tech or "", int(conn_id or 0)
        else:
            changes = []                             # first-ever store — no diff to log
            db.add(AgentStableFact(agent_name=agent_name, kind=kind, tech=tech or "",
                                   conn_id=int(conn_id or 0), facts=canon, sha=sha))
        for c in changes:
            db.add(AgentStableChange(agent_name=agent_name, kind=kind, tech=tech or "",
                                     conn_id=int(conn_id or 0), field=c["field"],
                                     old_value=c["old"], new_value=c["new"]))
        if owns_session:
            db.commit()
        else:
            db.flush()      # borrowed session: the caller owns the commit
        if changes:
            logger.info("[metrics_pipeline] stable change on '%s': %s",
                        agent_name, [c["field"] for c in changes])
            try:                                     # bonus long-horizon copy
                stable_changes.log_changes(agent_name, changes, kind, tech, conn_id)
            except Exception:  # noqa: BLE001
                pass
        return changes
    except Exception as e:  # noqa: BLE001
        logger.debug("[metrics_pipeline] record_stable: %s", e)
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass
        return None
    finally:
        if owns_session and db is not None:
            db.close()


def stable_from_snapshot(agent_name, connection_id, snapshot_type, payload, db=None):
    """Choke-point feeder: called whenever a dashboard snapshot is stored. Only the
    main *_dashboard snapshots carry the stable facts — others are ignored."""
    if not _ENABLED or "dashboard" not in (snapshot_type or ""):
        return
    try:
        facts = extract_stable_facts(payload)
        if not facts:
            return
        tech = _SNAP_TECH.get((snapshot_type or "").split("_", 1)[0], "unknown")
        record_stable(agent_name, facts, kind="database", tech=tech,
                      conn_id=connection_id or 0, db=db)
    except Exception as e:  # noqa: BLE001
        logger.debug("[metrics_pipeline] stable_from_snapshot: %s", e)


def stable(agent_name):
    """Current stable facts for an agent — read from PostgreSQL (always-on)."""
    import json as _json
    try:
        from app.database.connection import SessionLocal
        from app.models.agent_model import AgentStableFact
        s = SessionLocal()
        try:
            row = s.query(AgentStableFact).filter(
                AgentStableFact.agent_name == agent_name).first()
            if not row:
                return {}
            return {"facts": _json.loads(row.facts), "kind": row.kind, "tech": row.tech,
                    "conn_id": row.conn_id, "updated_at": str(row.updated_at)}
        finally:
            s.close()
    except Exception as e:  # noqa: BLE001
        logger.debug("[metrics_pipeline] stable: %s", e)
        return {}


def stable_history(agent_name=None, minutes=1440, kind=None, tech=None):
    """Change log from PostgreSQL (what changed, old → new, when), newest first."""
    try:
        from app.database.connection import SessionLocal
        from app.models.agent_model import AgentStableChange
        s = SessionLocal()
        try:
            import datetime as _dt
            q = s.query(AgentStableChange).filter(
                AgentStableChange.ts > _dt.datetime.now(_dt.timezone.utc)
                - _dt.timedelta(minutes=int(minutes)))
            if agent_name:
                q = q.filter(AgentStableChange.agent_name == agent_name)
            if kind:
                q = q.filter(AgentStableChange.kind == kind)
            if tech:
                q = q.filter(AgentStableChange.tech == tech)
            rows = q.order_by(AgentStableChange.ts.desc()).limit(2000).all()
            return [{"ts": str(r.ts), "agent": r.agent_name, "kind": r.kind,
                     "tech": r.tech, "conn_id": r.conn_id, "field": r.field,
                     "old_value": r.old_value, "new_value": r.new_value} for r in rows]
        finally:
            s.close()
    except Exception as e:  # noqa: BLE001
        logger.debug("[metrics_pipeline] stable_history: %s", e)
        return []


# ── Auto-hook: every AgentMetric INSERT flows through the pipeline ─────────────
# One registration, zero call-site changes: agent pushes, collector cycles — all of
# them create AgentMetric rows, so all of them feed Redis/ClickHouse automatically.

def register_hooks():
    try:
        from sqlalchemy import event
        from app.models.agent_model import AgentMetric

        @event.listens_for(AgentMetric, "after_insert")
        def _on_metric_insert(mapper, connection, target):  # noqa: ANN001
            record(target.agent_name, target, _connection=connection)

        logger.info("[metrics_pipeline] AgentMetric hook registered (Redis hot tier + ClickHouse history)")
    except Exception as e:  # noqa: BLE001
        logger.warning("[metrics_pipeline] hook registration failed: %s", e)
