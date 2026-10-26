"""Oracle service drill-down: service → instances → instance → sessions →
session → SQL.

Every level is addressable by ids alone (service name, INST_ID, SID+SERIAL#,
SQL_ID), so a page at any depth can be refreshed or linked and re-read from
the database rather than depending on a row handed over from the previous
page.

Rules that hold at every level:

  * Reads only. Every value a caller supplies reaches Oracle as a bind
    variable, never by string formatting.
  * One failed read does not fail the page. Each section is read on its own;
    a section that could not be read is reported in `errors` and its fields
    are None — which the UI shows as unavailable, never as zero.
  * Service membership is matched the same way the Services tab matches it
    (`_service_keys`): a session or an active-service row belongs to a service
    when any spelling of its name matches, so the drill-down and the table it
    came from cannot disagree about which instances run a service.
  * Bounded: every list is capped and every read is a single snapshot query;
    nothing here polls on its own.
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy.orm import Session

from app.services.oracle.oracle_monitoring_service import (
    _get_conn_or_404,
    _get_engine,
    _rows,
    _safe_int,
    _safe_str,
    _service_keys,
)

SESSION_CAP = 500
SQL_TEXT_CAP = 20000


def _num(v):
    """A number, or None when the database gave none. Unlike _safe_float this
    never turns a missing value into 0."""
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _ts(v):
    if v is None:
        return None
    if isinstance(v, datetime):
        return v.isoformat()
    return str(v)


def _read(engine, sql, params, errors, label):
    try:
        return _rows(engine, sql, params)
    except Exception as e:  # noqa: BLE001 — every failure is reported, not hidden
        errors.append(f"{label}: {e}")
        return None


def _db_domain(engine, errors):
    rows = _read(engine, "SELECT value FROM v$parameter WHERE name = 'db_domain'", None, errors, "db_domain")
    return _safe_str(rows[0].get("VALUE")) if rows else ""


def _matches(keys, *names, db_domain=""):
    for n in names:
        if keys & _service_keys(_safe_str(n), db_domain):
            return True
    return False


def _instances(engine, errors):
    rows = _read(
        engine,
        "SELECT inst_id, instance_number, instance_name, host_name, version, status, "
        "database_status, startup_time, instance_role, parallel, thread# AS thread_no "
        "FROM gv$instance ORDER BY inst_id",
        None, errors, "gv$instance",
    )
    out = []
    for r in rows or []:
        out.append({
            "inst_id": _safe_int(r.get("INST_ID")),
            "instance_number": _safe_int(r.get("INSTANCE_NUMBER")),
            "instance_name": _safe_str(r.get("INSTANCE_NAME")),
            "host_name": _safe_str(r.get("HOST_NAME")),
            "version": _safe_str(r.get("VERSION")),
            "instance_status": _safe_str(r.get("STATUS")),
            "database_status": _safe_str(r.get("DATABASE_STATUS")),
            "startup_time": _ts(r.get("STARTUP_TIME")),
            "instance_role": _safe_str(r.get("INSTANCE_ROLE")),
            "thread": _safe_int(r.get("THREAD_NO")) if r.get("THREAD_NO") is not None else None,
        })
    return out if rows is not None else None


def _database(engine, errors):
    rows = _read(engine, "SELECT name, db_unique_name, database_role, open_mode, cdb FROM v$database",
                 None, errors, "v$database")
    if not rows:
        return None
    r = rows[0]
    return {
        "name": _safe_str(r.get("NAME")),
        "db_unique_name": _safe_str(r.get("DB_UNIQUE_NAME")),
        "database_role": _safe_str(r.get("DATABASE_ROLE")),
        "open_mode": _safe_str(r.get("OPEN_MODE")),
        "cdb": _safe_str(r.get("CDB")),
    }


def _service_row(engine, service, errors):
    """The DBA_SERVICES row for `service`, matched on NAME or NETWORK_NAME,
    case-insensitively. Optional columns are read in a second, tolerant query
    so an older release without them still finds the service."""
    rows = _read(
        engine,
        "SELECT name, network_name, creation_date FROM dba_services "
        "WHERE UPPER(name) = UPPER(:svc) OR UPPER(network_name) = UPPER(:svc)",
        {"svc": service}, errors, "dba_services",
    )
    if not rows:
        return None
    r = rows[0]
    row = {
        "service_name": _safe_str(r.get("NAME")),
        "network_name": _safe_str(r.get("NETWORK_NAME")),
        "creation_date": _ts(r.get("CREATION_DATE")),
    }
    extra = _read(
        engine,
        "SELECT goal, clb_goal, failover_method, failover_type, failover_retries, "
        "failover_delay, dtp, aq_ha_notifications, enabled FROM dba_services WHERE name = :name",
        {"name": row["service_name"]}, [], "dba_services(config)",
    )
    if extra:
        e = extra[0]
        row["config"] = {k.lower(): _safe_str(v) if v is not None else None for k, v in e.items()}
    else:
        row["config"] = None
    return row


def _active_on(engine, keys, db_domain, errors):
    """INST_IDs where the service is registered. None when unreadable."""
    for view, has_inst in (("gv$active_services", True), ("v$active_services", False)):
        cols = "inst_id, name, network_name" if has_inst else "name, network_name"
        rows = _read(engine, f"SELECT {cols} FROM {view}", None, [], view)
        if rows is None:
            continue
        out = set()
        for r in rows:
            if _matches(keys, r.get("NAME"), r.get("NETWORK_NAME"), db_domain=db_domain):
                out.add(_safe_int(r.get("INST_ID")) if has_inst else None)
        return out
    errors.append("active services: neither GV$ACTIVE_SERVICES nor V$ACTIVE_SERVICES could be read")
    return None


def _service_sessions(engine, keys, db_domain, errors, inst_id=None):
    """User sessions of the service, optionally on one instance.

    Filtered in SQL on the candidate spellings so the transfer is bounded;
    the Python match is the authority on membership."""
    # The SQL pre-filter is a LIKE on the shortest spelling, because a
    # session can carry a longer registered form (SYS$<name>.<db_domain>) than
    # DBA_SERVICES holds. '_' in a service name is a LIKE wildcard, which only
    # widens the pre-filter; the Python match below decides membership.
    core = min(keys, key=len) if keys else "__none__"
    binds = {"core": f"%{core}%"}
    where = "type = 'USER' AND UPPER(service_name) LIKE :core"
    if inst_id is not None:
        where += " AND inst_id = :inst"
        binds["inst"] = int(inst_id)
    rows = _read(
        engine,
        "SELECT inst_id, sid, serial# AS serial_no, username, machine, program, module, status, "
        "sql_id, prev_sql_id, event, wait_class, seconds_in_wait, last_call_et, logon_time, "
        "service_name, osuser, blocking_session "
        f"FROM gv$session WHERE {where} ORDER BY inst_id, sid FETCH FIRST {SESSION_CAP * 2} ROWS ONLY",
        binds, errors, "gv$session",
    )
    if rows is None:
        return None, False
    out = []
    for r in rows:
        if not _matches(keys, r.get("SERVICE_NAME"), db_domain=db_domain):
            continue
        out.append({
            "inst_id": _safe_int(r.get("INST_ID")),
            "sid": _safe_int(r.get("SID")),
            "serial": _safe_int(r.get("SERIAL_NO")),
            "username": _safe_str(r.get("USERNAME")) or None,
            "machine": _safe_str(r.get("MACHINE")) or None,
            "program": _safe_str(r.get("PROGRAM")) or None,
            "module": _safe_str(r.get("MODULE")) or None,
            "status": _safe_str(r.get("STATUS")),
            "sql_id": _safe_str(r.get("SQL_ID")) or None,
            "prev_sql_id": _safe_str(r.get("PREV_SQL_ID")) or None,
            "event": _safe_str(r.get("EVENT")) or None,
            "wait_class": _safe_str(r.get("WAIT_CLASS")) or None,
            "seconds_in_wait": _num(r.get("SECONDS_IN_WAIT")),
            "last_call_et": _num(r.get("LAST_CALL_ET")),
            "logon_time": _ts(r.get("LOGON_TIME")),
            "osuser": _safe_str(r.get("OSUSER")) or None,
            "blocking_session": _safe_int(r.get("BLOCKING_SESSION")) if r.get("BLOCKING_SESSION") is not None else None,
        })
    truncated = len(out) > SESSION_CAP or len(rows) >= SESSION_CAP * 2
    return out[:SESSION_CAP], truncated


def summarise_sessions(sessions):
    """Counts per instance and status. Pure."""
    by_inst = {}
    for s in sessions or []:
        d = by_inst.setdefault(s["inst_id"], {"total": 0, "active": 0, "inactive": 0})
        d["total"] += 1
        if (s.get("status") or "").upper() == "ACTIVE":
            d["active"] += 1
        else:
            d["inactive"] += 1
    return by_inst


def top_waits(sessions, limit=8):
    """Current wait events among the given sessions, busiest first. Pure.
    Idle waits are left out: they describe a session doing nothing."""
    agg = {}
    for s in sessions or []:
        if (s.get("wait_class") or "") == "Idle" or not s.get("event"):
            continue
        a = agg.setdefault(s["event"], {"event": s["event"], "wait_class": s.get("wait_class"), "sessions": 0, "max_seconds": 0})
        a["sessions"] += 1
        a["max_seconds"] = max(a["max_seconds"], s.get("seconds_in_wait") or 0)
    return sorted(agg.values(), key=lambda x: (-x["sessions"], -x["max_seconds"]))[:limit]


def service_overall(active_on, inst_ids):
    """online / partial / offline / unknown — the Services tab's rule. Pure."""
    if active_on is None:
        return "unknown"
    ids = set(inst_ids or [])
    if not ids:
        return "online" if active_on else "offline"
    on = set(active_on) & ids
    if on >= ids:
        return "online"
    return "partial" if on else "offline"


def _service_metrics(engine, keys, db_domain, errors, inst_id=None):
    """GV$SERVICEMETRIC's latest interval per instance: elapsed/CPU per call
    and calls per second. Optional — None when the view is not readable."""
    rows = _read(
        engine,
        "SELECT inst_id, service_name, begin_time, end_time, intsize_csec, "
        "elapsedpercall, cpupercall, dbtimepercall, callspersec, dbtimepersec "
        "FROM gv$servicemetric WHERE group_id = 10",
        None, [], "gv$servicemetric",
    )
    if rows is None:
        # Older releases lack some columns; try the common subset once.
        rows = _read(
            engine,
            "SELECT inst_id, service_name, begin_time, end_time, elapsedpercall, cpupercall "
            "FROM gv$servicemetric",
            None, errors, "gv$servicemetric",
        )
    if rows is None:
        return None
    latest = {}
    for r in rows:
        if not _matches(keys, r.get("SERVICE_NAME"), db_domain=db_domain):
            continue
        iid = _safe_int(r.get("INST_ID"))
        if inst_id is not None and iid != int(inst_id):
            continue
        cur = latest.get(iid)
        if cur is None or str(r.get("END_TIME")) > str(cur["end_time"]):
            latest[iid] = {
                "inst_id": iid,
                "begin_time": _ts(r.get("BEGIN_TIME")),
                "end_time": _ts(r.get("END_TIME")),
                # Oracle reports these per-call times in microseconds.
                "elapsed_ms_per_call": (_num(r.get("ELAPSEDPERCALL")) or 0) / 1000 if r.get("ELAPSEDPERCALL") is not None else None,
                "cpu_ms_per_call": (_num(r.get("CPUPERCALL")) or 0) / 1000 if r.get("CPUPERCALL") is not None else None,
                "calls_per_sec": _num(r.get("CALLSPERSEC")),
                "dbtime_per_sec": _num(r.get("DBTIMEPERSEC")),
            }
    return sorted(latest.values(), key=lambda x: x["inst_id"])


def _service_alerts(engine, service, errors):
    """Outstanding server-generated alerts raised on this service object."""
    rows = _read(
        engine,
        "SELECT reason, message_type, message_level, creation_time, object_type, object_name, "
        "suggested_action FROM dba_outstanding_alerts "
        "WHERE object_type = 'SERVICE' AND UPPER(object_name) = UPPER(:svc) "
        "ORDER BY creation_time DESC FETCH FIRST 50 ROWS ONLY",
        {"svc": service}, errors, "dba_outstanding_alerts",
    )
    if rows is None:
        return None
    return [{
        "reason": _safe_str(r.get("REASON")),
        "message_type": _safe_str(r.get("MESSAGE_TYPE")),
        "message_level": _safe_int(r.get("MESSAGE_LEVEL")) if r.get("MESSAGE_LEVEL") is not None else None,
        "creation_time": _ts(r.get("CREATION_TIME")),
        "suggested_action": _safe_str(r.get("SUGGESTED_ACTION")) or None,
    } for r in rows]


def _resolve(conn_id, db, service):
    conn = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)
    errors = []
    svc = _service_row(engine, service, errors)
    return engine, errors, svc


def _not_found(service, errors):
    return {"status": "not_found", "error": f"Service {service!r} is not in DBA_SERVICES.", "errors": errors}


# ── level 2: the service ────────────────────────────────────────────────


def oracle_service_detail(conn_id: int, db: Session, service: str):
    engine, errors, svc = _resolve(conn_id, db, service)
    if svc is None:
        return _not_found(service, errors)
    dom = _db_domain(engine, errors)
    keys = _service_keys(svc["service_name"], dom) | _service_keys(svc["network_name"], dom)

    instances = _instances(engine, errors)
    active_on = _active_on(engine, keys, dom, errors)
    sessions, truncated = _service_sessions(engine, keys, dom, errors)
    counts = summarise_sessions(sessions) if sessions is not None else None

    inst_rows = []
    for i in instances or []:
        c = (counts or {}).get(i["inst_id"], {"total": 0, "active": 0, "inactive": 0}) if counts is not None else None
        inst_rows.append({
            **i,
            "service_status": None if active_on is None else ("active" if i["inst_id"] in active_on else "not_active"),
            "sessions": c,
        })

    return {
        "status": "success",
        "service": svc,
        "database": _database(engine, errors),
        "overall": service_overall(active_on, [i["inst_id"] for i in instances or []]),
        "instances": inst_rows if instances is not None else None,
        "active_instances": len(active_on) if active_on is not None else None,
        "sessions": {
            "total": len(sessions) if sessions is not None else None,
            "active": sum(1 for s in sessions if (s["status"] or "").upper() == "ACTIVE") if sessions is not None else None,
            "truncated": truncated,
        },
        "metrics": _service_metrics(engine, keys, dom, errors),
        "alerts": _service_alerts(engine, svc["service_name"], errors),
        "read_at": datetime.utcnow().isoformat() + "Z",
        "errors": errors,
    }


# ── level 3/4: one instance, as it serves this service ──────────────────


def _sysmetrics(engine, inst_id, errors):
    rows = _read(
        engine,
        "SELECT metric_name, value, metric_unit, end_time FROM gv$sysmetric "
        "WHERE inst_id = :inst AND group_id = 2 AND metric_name IN ("
        "'Host CPU Utilization (%)', 'Database CPU Time Ratio', 'Average Active Sessions', "
        "'Database Wait Time Ratio', 'Executions Per Sec', 'User Transaction Per Sec', "
        "'Physical Reads Per Sec', 'Logical Reads Per Sec', 'Current Logons Count', 'Buffer Cache Hit Ratio')",
        {"inst": int(inst_id)}, errors, "gv$sysmetric",
    )
    if rows is None:
        return None
    return {_safe_str(r.get("METRIC_NAME")): {
        "value": _num(r.get("VALUE")), "unit": _safe_str(r.get("METRIC_UNIT")), "end_time": _ts(r.get("END_TIME")),
    } for r in rows}


def _memory(engine, inst_id, errors):
    out = {}
    sga = _read(engine, "SELECT SUM(bytes) AS b FROM gv$sgastat WHERE inst_id = :inst",
                {"inst": int(inst_id)}, errors, "gv$sgastat")
    out["sga_mb"] = (_num(sga[0].get("B")) or 0) / 1048576 if sga and sga[0].get("B") is not None else None
    pga = _read(engine, "SELECT name, value FROM gv$pgastat WHERE inst_id = :inst "
                "AND name IN ('total PGA allocated', 'aggregate PGA target parameter', 'total PGA inuse')",
                {"inst": int(inst_id)}, errors, "gv$pgastat")
    for r in pga or []:
        key = {"total PGA allocated": "pga_allocated_mb", "aggregate PGA target parameter": "pga_target_mb",
               "total PGA inuse": "pga_inuse_mb"}.get(_safe_str(r.get("NAME")))
        if key and r.get("VALUE") is not None:
            out[key] = _num(r.get("VALUE")) / 1048576
    return out


def oracle_service_instance(conn_id: int, db: Session, service: str, inst_id: int):
    engine, errors, svc = _resolve(conn_id, db, service)
    if svc is None:
        return _not_found(service, errors)
    dom = _db_domain(engine, errors)
    keys = _service_keys(svc["service_name"], dom) | _service_keys(svc["network_name"], dom)

    instances = _instances(engine, errors)
    inst = next((i for i in instances or [] if i["inst_id"] == int(inst_id)), None)
    if instances is not None and inst is None:
        return {"status": "not_found", "error": f"Instance {inst_id} is not in GV$INSTANCE.", "errors": errors}

    active_on = _active_on(engine, keys, dom, errors)
    sessions, truncated = _service_sessions(engine, keys, dom, errors, inst_id=inst_id)
    db_info = _database(engine, errors)

    return {
        "status": "success",
        "service": svc,
        "database": db_info,
        "instance": inst,
        "service_status": None if active_on is None else ("active" if int(inst_id) in active_on else "not_active"),
        # Role is the DATABASE's Data Guard role; shown only when it says something.
        "role": (db_info or {}).get("database_role") or None,
        "sessions": {
            "total": len(sessions) if sessions is not None else None,
            "active": sum(1 for s in sessions if (s["status"] or "").upper() == "ACTIVE") if sessions is not None else None,
            "truncated": truncated,
        },
        "waits": top_waits(sessions) if sessions is not None else None,
        "sysmetrics": _sysmetrics(engine, inst_id, errors),
        "memory": _memory(engine, inst_id, errors),
        "service_metrics": _service_metrics(engine, keys, dom, errors, inst_id=inst_id),
        "read_at": datetime.utcnow().isoformat() + "Z",
        "errors": errors,
    }


# ── level 5: the instance's sessions for this service ───────────────────


def oracle_service_sessions(conn_id: int, db: Session, service: str, inst_id: int):
    engine, errors, svc = _resolve(conn_id, db, service)
    if svc is None:
        return _not_found(service, errors)
    dom = _db_domain(engine, errors)
    keys = _service_keys(svc["service_name"], dom) | _service_keys(svc["network_name"], dom)
    sessions, truncated = _service_sessions(engine, keys, dom, errors, inst_id=inst_id)
    if sessions is None:
        return {"status": "error", "error": "; ".join(errors) or "gv$session could not be read", "errors": errors}
    return {
        "status": "success",
        "service": svc,
        "inst_id": int(inst_id),
        "sessions": sessions,
        "truncated": truncated,
        "cap": SESSION_CAP,
        "read_at": datetime.utcnow().isoformat() + "Z",
        "errors": errors,
    }


# ── level 6: one session ────────────────────────────────────────────────

SESSION_STATS = (
    "CPU used by this session", "session logical reads", "physical reads", "execute count",
    "session pga memory", "session pga memory max",
    "physical read total IO requests", "physical write total IO requests",
    "parse count (total)", "user commits", "user rollbacks", "bytes sent via SQL*Net to client",
    "bytes received via SQL*Net from client", "sorts (disk)", "redo size",
)


def _sql_text(engine, inst_id, sql_id, errors, label):
    if not sql_id:
        return None
    rows = _read(
        engine,
        "SELECT sql_fulltext, sql_text FROM gv$sql WHERE inst_id = :inst AND sql_id = :sid FETCH FIRST 1 ROWS ONLY",
        {"inst": int(inst_id), "sid": sql_id}, errors, label,
    )
    if not rows:
        return None
    full = rows[0].get("SQL_FULLTEXT")
    text = full.read() if hasattr(full, "read") else full
    text = _safe_str(text) or _safe_str(rows[0].get("SQL_TEXT"))
    return text[:SQL_TEXT_CAP] if text else None


def oracle_session_detail(conn_id: int, db: Session, inst_id: int, sid: int, serial: int):
    conn = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)
    errors = []
    rows = _read(
        engine,
        "SELECT inst_id, sid, serial# AS serial_no, username, osuser, machine, program, module, action, "
        "client_info, client_identifier, service_name, status, server, type, sql_id, sql_child_number, "
        "prev_sql_id, event, wait_class, state, seconds_in_wait, wait_time_micro, blocking_session, "
        "blocking_instance, last_call_et, logon_time, sql_exec_start, row_wait_obj# AS row_wait_obj "
        "FROM gv$session WHERE inst_id = :inst AND sid = :sid AND serial# = :serial",
        {"inst": int(inst_id), "sid": int(sid), "serial": int(serial)}, errors, "gv$session",
    )
    if rows is None:
        return {"status": "error", "error": "; ".join(errors), "errors": errors}
    if not rows:
        # SID+SERIAL# together identify one session for its lifetime; gone means ended.
        return {"status": "ended", "error": "This session is no longer connected.", "errors": errors}
    r = rows[0]
    session = {k.lower(): (_ts(v) if isinstance(v, datetime) else v) for k, v in r.items()}
    session["serial"] = _safe_int(r.get("SERIAL_NO"))

    stats_rows = _read(
        engine,
        "SELECT n.name, s.value FROM gv$sesstat s JOIN gv$statname n "
        "ON n.statistic# = s.statistic# AND n.inst_id = s.inst_id "
        "WHERE s.inst_id = :inst AND s.sid = :sid AND n.name IN ("
        + ", ".join(f":n{i}" for i in range(len(SESSION_STATS))) + ")",
        {"inst": int(inst_id), "sid": int(sid), **{f"n{i}": n for i, n in enumerate(SESSION_STATS)}},
        errors, "gv$sesstat",
    )
    stats = {_safe_str(x.get("NAME")): _num(x.get("VALUE")) for x in stats_rows} if stats_rows is not None else None

    return {
        "status": "success",
        "session": session,
        "stats": stats,
        "current_sql": {"sql_id": session.get("sql_id"),
                        "text": _sql_text(engine, inst_id, session.get("sql_id"), errors, "gv$sql(current)")},
        "previous_sql": {"sql_id": session.get("prev_sql_id"),
                         "text": _sql_text(engine, inst_id, session.get("prev_sql_id"), errors, "gv$sql(previous)")},
        "read_at": datetime.utcnow().isoformat() + "Z",
        "errors": errors,
    }


# ── level 7: one SQL statement ──────────────────────────────────────────


def oracle_sql_detail(conn_id: int, db: Session, sql_id: str, inst_id: int | None = None):
    conn = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)
    errors = []
    binds = {"sid": sql_id}
    inst_clause = ""
    if inst_id is not None:
        inst_clause = " AND inst_id = :inst"
        binds["inst"] = int(inst_id)
    rows = _read(
        engine,
        "SELECT inst_id, child_number, plan_hash_value, parsing_schema_name, module, action, "
        "executions, elapsed_time, cpu_time, buffer_gets, disk_reads, rows_processed, fetches, "
        "sorts, parse_calls, first_load_time, last_active_time, optimizer_mode, sql_profile "
        f"FROM gv$sql WHERE sql_id = :sid{inst_clause} ORDER BY inst_id, child_number FETCH FIRST 50 ROWS ONLY",
        binds, errors, "gv$sql",
    )
    if rows is None:
        return {"status": "error", "error": "; ".join(errors), "errors": errors}
    if not rows:
        return {"status": "not_found", "error": f"SQL {sql_id} is not in the shared pool"
                + (f" of instance {inst_id}" if inst_id is not None else "") + " (it may have aged out).",
                "errors": errors}

    children = []
    tot = {"executions": 0, "elapsed_time": 0, "cpu_time": 0, "buffer_gets": 0, "disk_reads": 0, "rows_processed": 0}
    for r in rows:
        c = {
            "inst_id": _safe_int(r.get("INST_ID")),
            "child_number": _safe_int(r.get("CHILD_NUMBER")),
            "plan_hash_value": _safe_str(r.get("PLAN_HASH_VALUE")),
            "parsing_schema": _safe_str(r.get("PARSING_SCHEMA_NAME")) or None,
            "module": _safe_str(r.get("MODULE")) or None,
            "executions": _num(r.get("EXECUTIONS")),
            "elapsed_s": (_num(r.get("ELAPSED_TIME")) or 0) / 1e6,
            "cpu_s": (_num(r.get("CPU_TIME")) or 0) / 1e6,
            "buffer_gets": _num(r.get("BUFFER_GETS")),
            "disk_reads": _num(r.get("DISK_READS")),
            "rows_processed": _num(r.get("ROWS_PROCESSED")),
            "first_load_time": _safe_str(r.get("FIRST_LOAD_TIME")) or None,
            "last_active_time": _ts(r.get("LAST_ACTIVE_TIME")),
            "optimizer_mode": _safe_str(r.get("OPTIMIZER_MODE")) or None,
            "sql_profile": _safe_str(r.get("SQL_PROFILE")) or None,
        }
        children.append(c)
        for k in tot:
            tot[k] += _num(r.get(k.upper())) or 0
    ex = tot["executions"]
    summary = {
        "executions": ex,
        "elapsed_s": tot["elapsed_time"] / 1e6,
        "cpu_s": tot["cpu_time"] / 1e6,
        "buffer_gets": tot["buffer_gets"],
        "disk_reads": tot["disk_reads"],
        "rows_processed": tot["rows_processed"],
        "elapsed_ms_per_exec": (tot["elapsed_time"] / 1000 / ex) if ex else None,
        "buffer_gets_per_exec": (tot["buffer_gets"] / ex) if ex else None,
        "plan_hash_values": sorted({c["plan_hash_value"] for c in children if c["plan_hash_value"]}),
    }
    text = _sql_text(engine, children[0]["inst_id"], sql_id, errors, "gv$sql(text)")
    return {
        "status": "success",
        "sql_id": sql_id,
        "summary": summary,
        "children": children,
        "text": text,
        "text_available": text is not None,
        "read_at": datetime.utcnow().isoformat() + "Z",
        "errors": errors,
    }


# ── session activity: waits, blocking, stored timeline ──────────────────


def oracle_session_activity(conn_id: int, db: Session, inst_id: int, sid: int, serial: int):
    """Per-session waits (GV$SESSION_EVENT, cumulative since logon), blocking
    relationships (GV$SESSION), and the session's stored CPU samples
    (ClickHouse top sessions — present only for cycles where it was among the
    top 5 on its instance). Reads only; every value is a bind."""
    conn = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)
    errors = []
    b = {"inst": int(inst_id), "sid": int(sid)}

    waits = _read(
        engine,
        "SELECT event, wait_class, total_waits, total_timeouts, time_waited_micro, average_wait "
        "FROM gv$session_event WHERE inst_id = :inst AND sid = :sid ORDER BY time_waited_micro DESC FETCH FIRST 30 ROWS ONLY",
        b, errors, "gv$session_event",
    )
    wait_rows = None
    if waits is not None:
        wait_rows = [{
            "event": _safe_str(r.get("EVENT")),
            "wait_class": _safe_str(r.get("WAIT_CLASS")) or None,
            "total_waits": _num(r.get("TOTAL_WAITS")),
            "timeouts": _num(r.get("TOTAL_TIMEOUTS")),
            "time_waited_s": (_num(r.get("TIME_WAITED_MICRO")) or 0) / 1e6 if r.get("TIME_WAITED_MICRO") is not None else None,
        } for r in waits]

    # Who this session waits on, and who waits on it.
    blocker = _read(
        engine,
        "SELECT b.inst_id, b.sid, b.serial# AS serial_no, b.username, b.status, b.event, b.seconds_in_wait "
        "FROM gv$session s JOIN gv$session b ON b.inst_id = NVL(s.blocking_instance, s.inst_id) AND b.sid = s.blocking_session "
        "WHERE s.inst_id = :inst AND s.sid = :sid AND s.serial# = :serial",
        {**b, "serial": int(serial)}, errors, "gv$session (blocker)",
    )
    blocked = _read(
        engine,
        "SELECT inst_id, sid, serial# AS serial_no, username, status, event, seconds_in_wait "
        "FROM gv$session WHERE blocking_instance = :inst AND blocking_session = :sid FETCH FIRST 50 ROWS ONLY",
        b, errors, "gv$session (blocked)",
    )

    def sess(rows):
        if rows is None:
            return None
        return [{"inst_id": _safe_int(r.get("INST_ID")), "sid": _safe_int(r.get("SID")), "serial": _safe_int(r.get("SERIAL_NO")),
                 "username": _safe_str(r.get("USERNAME")) or None, "status": _safe_str(r.get("STATUS")) or None,
                 "event": _safe_str(r.get("EVENT")) or None, "seconds_in_wait": _num(r.get("SECONDS_IN_WAIT"))} for r in rows]

    # Stored CPU samples for exactly this session.
    timeline, last_seen = None, None
    try:
        from app.services.clickhouse import metrics_history_service as mh
        cli = mh.get_client()
        if cli is not None:
            res = cli.query(
                f"SELECT toTimeZone(ts, 'UTC'), cpu_pct, status, sql_id, username, program FROM {mh.CH_DB}.actmon_oracle_top_sessions "
                "WHERE conn_id = %(c)s AND inst_id = %(i)s AND sid = %(s)s AND serial = %(r)s ORDER BY ts LIMIT 5000",
                parameters={"c": int(conn_id), "i": int(inst_id), "s": int(sid), "r": int(serial)}).result_rows
            timeline = [{"t": str(r[0])[:16].replace(" ", "T"), "cpu_pct": r[1], "status": r[2] or None, "sql_id": r[3] or None} for r in res]
            if res:
                r = res[-1]
                last_seen = {"t": str(r[0])[:19], "sql_id": r[3] or None, "username": r[4] or None, "program": r[5] or None, "status": r[2] or None}
    except Exception as e:  # noqa: BLE001
        msg = str(e)
        if "UNKNOWN_TABLE" not in msg and "Unknown table" not in msg:
            errors.append(f"timeline: {e}")
        timeline = timeline if timeline is not None else []

    return {
        "status": "success",
        "waits": wait_rows,
        "blocker": sess(blocker),
        "blocked": sess(blocked),
        "timeline": timeline,
        "last_stored": last_seen,
        "read_at": datetime.utcnow().isoformat() + "Z",
        "errors": errors,
    }
