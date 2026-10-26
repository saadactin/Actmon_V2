"""
ActMon AI - code-rendered answers for live-data chat routes (answer shadow mode).

Builds the answer text straight from the tool result the chat route already fetched: no model, so it takes
microseconds and cannot state a value that is not in the data. Used ONLY by answer_shadow.py, which logs this
text next to the answer users actually got; it never changes what a user sees.

render(route, result, question) -> str | None. None = shape not recognised (nothing is logged as an answer).
Routes: fleet, active_alerts, alert_history, history, snapshot (tool shapes: services/chatbot/tools.py).
"""


_SEV_ORDER = {"critical": 0, "warning": 1, "info": 2}


def _n(v):
    """Numbers as the tools give them: floats without a needless .0; strings like '52%' kept as they are."""
    if isinstance(v, float):
        return f"{v:.1f}".rstrip("0").rstrip(".")
    return str(v)


def unavailable(r):
    reason = (r.get("reason") or "").strip()
    return "I don't have current data for that." + (f" {reason}" if reason else "")


_ENGINE_WORDS = {"mysql": ("mysql", "mariadb"), "postgresql": ("postgres", "postgresql"), "oracle": ("oracle",),
                 "mssql": ("mssql", "sql server", "sqlserver"), "mongodb": ("mongo",), "clickhouse": ("clickhouse",)}
_ENGINE_LABEL = {"mysql": "MySQL", "postgresql": "PostgreSQL", "oracle": "Oracle", "mssql": "SQL Server",
                 "mongodb": "MongoDB", "clickhouse": "ClickHouse"}


def _focus(r, q):
    """Lines answering the specific topic the question names, from the same fleet data; [] if it names none.
    The fleet rollup holds no replication status, so a replication question is told so plainly."""
    out = []
    for e in r.get("per_engine") or []:
        if any(w in q for w in _ENGINE_WORDS.get(e.get("engine"), ())):
            lab = _ENGINE_LABEL.get(e["engine"], e["engine"])
            if not e.get("total"):
                out.append(f"**{lab}:** no {lab} database hosts are monitored.")
            else:
                parts = [f"{e.get(k, 0)} {k}" for k in ("good", "warning", "critical", "unknown") if e.get(k)]
                out.append(f"**{lab}:** {e['total']} database host{'s' * (e['total'] != 1)}: "
                           + ", ".join(parts).replace(" good", " healthy"))
    if "replicat" in q:
        out.append("**Replication:** the fleet overview has no replication status. "
                   "Name a database (for example \"replication on <name>\") to see its replication details.")
    if "agent" in q and r.get("agents"):
        ag = r["agents"]
        out.append(f"**Agents:** {ag.get('total', 0)} total: {ag.get('good', 0)} online, {ag.get('critical', 0)} offline")
    if "alert" in q and r.get("active_alerts"):
        al = r["active_alerts"]
        out.append(f"**Active alerts:** {al.get('total', 0)} ({al.get('critical', 0)} critical, {al.get('warning', 0)} warning)")
    return out


def fleet(r, question=""):
    if "infra" not in r and "per_engine" not in r:
        return None
    q = question.lower()
    focus = _focus(r, q)
    if focus:
        return "\n".join(focus + ["", "---", "", fleet(r, "") or ""]).rstrip()
    L = []
    inf = r.get("infra") or {}
    top = r.get("top_cpu_hosts") or []
    if top and any(w in q for w in ("top", "most", "highest", "busiest", "heaviest")) and "cpu" in q:
        L = ["**Hosts by CPU usage** (live)", ""] + [f"{i}. {h['host']}: {_n(h.get('cpu_pct'))}%" for i, h in enumerate(top, 1)]
        return "\n".join(L)
    icon = "🔴" if inf.get("critical") else ("🟡" if inf.get("warning") else "🟢")
    L += ["**Environment overview** (live)", "",
          f"{icon} Hosts: {inf.get('total', 0)} total: {inf.get('good', 0)} healthy, {inf.get('warning', 0)} warning, "
          f"{inf.get('critical', 0)} critical" + (f" ({inf['health_pct']}% healthy)" if "health_pct" in inf else "")]
    dbs = r.get("databases_by_host")
    if dbs and dbs.get("total"):
        L.append(f"- Database hosts: {dbs['total']} total: {dbs.get('good', 0)} healthy, {dbs.get('warning', 0)} warning, "
                 f"{dbs.get('critical', 0)} critical" + (f", {dbs['unknown']} unknown" if dbs.get("unknown") else ""))
    for e in r.get("per_engine") or []:
        if e.get("total"):
            bad = [f"{e[k]} {k}" for k in ("warning", "critical", "unknown") if e.get(k)]
            L.append(f"  - {e['engine']}: {e['total']}" + (f" ({', '.join(bad)})" if bad else " (all healthy)"))
    ag = r.get("agents")
    if ag and ag.get("total"):
        L.append(f"- Agents: {ag['total']} total: {ag.get('good', 0)} online" + (f", {ag['critical']} offline" if ag.get("critical") else ""))
    res = r.get("average_resource_usage") or {}
    if res.get("hosts_reporting"):
        L.append(f"- Average across {res['hosts_reporting']} reporting hosts: CPU {res.get('cpu_avg_pct')}%, "
                 f"RAM {res.get('ram_avg_pct')}%, disk {res.get('disk_avg_pct')}%")
    if top:
        L.append("- Highest CPU: " + ", ".join(f"{h['host']} {_n(h.get('cpu_pct'))}%" for h in top[:3]))
    al = r.get("active_alerts") or {}
    if "total" in al:
        L.append(f"- Active alerts: {al['total']}" + (f" ({al.get('critical', 0)} critical, {al.get('warning', 0)} warning)" if al["total"] else ""))
    return "\n".join(L)


def active_alerts(r):
    items = r.get("data")
    if not isinstance(items, list) or (items and "rule" not in items[0]):
        return None
    if not items:
        return "🟢 **No alerts are firing** right now."
    items = sorted(items, key=lambda a: _SEV_ORDER.get(str(a.get("severity")).lower(), 3))
    crit = sum(str(a.get("severity")).lower() == "critical" for a in items)
    warn = sum(str(a.get("severity")).lower() == "warning" for a in items)
    L = [f"{'🔴' if crit else '🟡'} **{len(items)} alert{'s' * (len(items) != 1)} firing**: {crit} critical, {warn} warning", ""]
    L += [f"- **{str(a.get('severity')).capitalize()}** · {a.get('server')} · {a.get('rule')}: "
          f"{_n(a.get('value'))} (threshold {_n(a.get('threshold'))})" for a in items[:20]]
    if len(items) > 20:
        L.append(f"- …and {len(items) - 20} more on the Alerts page")
    return "\n".join(L)


def alert_history(r):
    items = r.get("data")
    if not isinstance(items, list) or (items and "alert_name" not in items[0]):
        return None
    if not items:
        return "No alert notifications were recorded in the history."
    L = [f"**Recent alert notifications** (latest {len(items)}, newest first)", ""]
    L += [f"- {a.get('sent_at')} · {str(a.get('severity')).capitalize()} · {a.get('server_name')} · {a.get('alert_name')}"
          + (f" ({a.get('status')})" if a.get("status") else "") for a in items[:20]]
    return "\n".join(L)


_HIST_FIELDS = [("host_cpu", "Host CPU", "%"), ("host_memory", "Host memory", "%"), ("host_disk", "Host disk", "%"),
                ("db_cpu", "DB CPU", "%"), ("active_sessions", "Active sessions", ""), ("connections_used", "Connections used", ""),
                ("cache_hit_pct", "Cache hit", "%"), ("qps", "Queries/s", ""), ("tps", "Transactions/s", "")]


def history(r):
    rows = r.get("data")
    if not isinstance(rows, list) or not rows or "ts" not in rows[0]:
        return None
    rows = sorted(rows, key=lambda x: x["ts"])
    L = [f"**History from {rows[0]['ts']} to {rows[-1]['ts']} UTC** ({len(rows)} samples)", "",
         "| Metric | Latest | Min | Avg | Max |", "| --- | --- | --- | --- | --- |"]
    for key, label, unit in _HIST_FIELDS:
        vals = [float(x[key]) for x in rows if isinstance(x.get(key), (int, float))]
        if not vals:
            continue
        f = lambda v: _n(round(v, 1)) + unit  # noqa: E731
        L.append(f"| {label} | {f(vals[-1])} | {f(min(vals))} | {f(sum(vals) / len(vals))} | {f(max(vals))} |")
    return "\n".join(L) if len(L) > 4 else None


def _render_basic(route, result, question=""):
    if not isinstance(result, dict):
        return None
    if not result.get("available", False):
        return unavailable(result)
    fn = {"fleet": lambda: fleet(result, question), "active_alerts": lambda: active_alerts(result),
          "alert_history": lambda: alert_history(result), "history": lambda: history(result)}.get(route)
    return fn() if fn else None


NOTE = "_Live values. ActMon has no single health verdict for a database, so none is given._"


def _l(label, value, suffix=""):
    return None if value in (None, "", "None") else f"- {label}: {value}{suffix}"


def engine_of(d):
    conn, hs = d.get("connection") or {}, d.get("health_summary") or {}
    if "oracle_deployment_type" in conn or "sga_used_pct" in hs:
        return "oracle"
    if "sql_cpu_pct" in hs or "edition" in hs:
        return "mssql"
    if "wt_cache_hit_pct" in hs or "replica_set" in hs:
        return "mongodb"
    if "parts_count" in hs or "merge_queue_size" in hs:
        return "clickhouse"
    if str(hs.get("storage_engine", "")).lower() == "postgresql":
        return "postgresql"
    if "connection_usage_pct" in hs:
        return "mysql"
    return None


def database(d):
    eng = engine_of(d)
    if not eng:
        return None
    hs = d.get("health_summary") or {}
    name = (d.get("connection") or {}).get("name") or "this database"
    failed = d.get("failed_metrics")
    failed_list = failed if isinstance(failed, list) else None

    def pct(key):
        v = hs.get(key)
        if v is None:
            return None
        if eng == "oracle" and v == 0:
            stem = key.replace("_pct", "").replace("_used", "").split("_")[0]
            if failed_list is None:
                return "0% (may not have been read)"
            if any(stem in str(f).lower() for f in failed_list):
                return "not read"
        return f"{_n(v)}%"

    L = [f"**{name}** ({eng}" + (f" {hs['version']}" if hs.get("version") else "") + ")", ""]
    if eng in ("mysql", "postgresql"):
        conns = f"{hs.get('current_connections')} of {hs.get('max_connections')}" if hs.get("max_connections") else hs.get("current_connections")
        L += [_l("Connections", conns, f" ({pct('connection_usage_pct')})" if hs.get("connection_usage_pct") is not None else ""),
              _l("Cache hit ratio", pct("cache_usage_pct")), _l("Replication", hs.get("replication_state")),
              _l("Uptime", hs.get("uptime")), _l("Databases", hs.get("total_databases")),
              _l("Total size", f"{hs['total_size_gb']} GB" if hs.get("total_size_gb") is not None else None),
              _l("Slow queries (server counter since start)", (d.get("query_stats") or {}).get("Slow_queries"))]
    elif eng == "oracle":
        sess = f"{hs.get('active_sessions')} active of {hs.get('max_sessions')}" if hs.get("max_sessions") else None
        L += [_l("Instance status", hs.get("status")), _l("Host CPU", pct("host_cpu_pct")), _l("DB CPU", pct("db_cpu_pct")),
              _l("Sessions", sess, f" ({pct('session_pct')})" if sess and hs.get("session_pct") is not None else ""),
              _l("SGA used", pct("sga_used_pct")), _l("PGA used", pct("pga_used_pct")),
              _l("Buffer cache hit", pct("buffer_cache_hit_pct")), _l("Library cache hit", pct("library_cache_hit_pct")),
              _l("Log mode", hs.get("log_mode")), _l("Database size", f"{hs['db_size_gb']} GB" if hs.get("db_size_gb") is not None else None)]
        if failed_list:
            L.append(f"- Not read this time: {', '.join(map(str, failed_list))}")
    elif eng == "mssql":
        ple = hs.get("page_life_expectancy")
        L += [_l("Host CPU", pct("host_cpu_pct")), _l("SQL Server CPU", pct("sql_cpu_pct")), _l("Host memory used", pct("memory_usage_pct")),
              _l("Connections used", pct("connection_pct")), _l("Buffer cache hit", pct("buffer_cache_hit_pct")),
              _l("Page life expectancy", ple, " s" if ple is not None else ""), _l("Replication", hs.get("replication_state")),
              _l("Uptime", hs.get("uptime_str"))]
    elif eng == "mongodb":
        cc = hs.get("current_connections")
        L += [_l("Connections", cc, f" ({pct('connection_pct')})" if cc is not None and hs.get("connection_pct") is not None else ""),
              _l("Replication", hs.get("replication_state")), _l("WiredTiger cache hit", pct("wt_cache_hit_pct")),
              _l("WiredTiger cache used", pct("wt_cache_pct")),
              _l("Resident memory", f"{hs['memory_resident_mb']} MB" if hs.get("memory_resident_mb") is not None else None),
              _l("Uptime", hs.get("uptime_str"))]
    elif eng == "clickhouse":
        du = d.get("disk_usage") if isinstance(d.get("disk_usage"), dict) else {}
        rep = hs.get("replication_enabled")
        L += [_l("Memory used", pct("memory_usage_pct")), _l("Disk used", f"{_n(du['used_pct'])}%" if du.get("used_pct") is not None else None),
              _l("Active queries", hs.get("active_queries")), _l("Queries/s", hs.get("queries_per_second")),
              _l("Parts", hs.get("parts_count")), _l("Merge queue", hs.get("merge_queue_size")),
              _l("Replication", None if rep is None else ("enabled" if rep else "disabled")), _l("Uptime", hs.get("uptime_str"))]
    L = [x for x in L if x is not None]
    if len(L) <= 2:
        return None
    return "\n".join(L + ["", NOTE])


def host(d):
    if "cpu_pct" not in d and not isinstance(d.get("memory"), dict):
        return None
    h = d.get("host") or {}
    name = h.get("server_name") or h.get("hostname") or (d.get("system") or {}).get("hostname") or "this host"
    mem = d.get("memory") if isinstance(d.get("memory"), dict) else {}
    load = d.get("load") if isinstance(d.get("load"), dict) else {}
    L = [f"**{name}**" + (f" ({h['os_type']})" if h.get("os_type") else ""), "",
         _l("CPU", f"{_n(d['cpu_pct'])}%" if d.get("cpu_pct") is not None else None),
         _l("Memory", f"{_n(mem['used_pct'])}% ({mem.get('used_mb')} of {mem.get('total_mb')} MB)" if mem.get("used_pct") is not None else None),
         _l("Load average", f"{load.get('one')} / {load.get('five')} / {load.get('fifteen')}" if load else None),
         _l("Uptime", d.get("uptime"))]
    fs = d.get("filesystems")
    if isinstance(fs, list):
        L += [f"- Disk {f.get('mount')}: {f.get('use_pct')}" for f in fs if isinstance(f, dict)]
    elif isinstance(fs, str):
        L.append(f"- Filesystems: {fs} (see the host page for each mount)")
    L = [x for x in L if x is not None]
    return "\n".join(L) if len(L) > 2 else None


def render_snapshot(result):
    if not isinstance(result, dict):
        return None
    if not result.get("available", False):
        return unavailable(result)
    d = result.get("data")
    if not isinstance(d, dict):
        return None
    return database(d) if "health_summary" in d else host(d)


def render(route, result, question=""):
    if route == "snapshot":
        return render_snapshot(result)
    return _render_basic(route, result, question)
