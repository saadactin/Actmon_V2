"""Oracle Performance Intelligence over stored AWR history (per database).

- recompute(): after an upload/delete/re-analyse, rebuild the database's
  cross-report findings (trend / risk / forecast), score earlier forecasts
  against reports that have since arrived, and store new forecasts.
- read functions: payloads for the Overview, SQL, Wait, Predictions, Capacity,
  Recommendations, History and Alerts tabs. All org-scoped.

Uploaded AWR files are historical: everything here describes the windows the
reports cover. Forecasts are for the windows after the latest report, and the
payloads say how old that report is.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from app.models.oracle_awr_model import (
    OracleAwrFinding, OracleAwrForecast, OracleAwrMetric, OracleAwrReport, OracleAwrSqlStat,
)
from app.services.oracle.awr import history as H
from app.services.oracle.awr.forecast import LEVEL, window_of
from app.services.oracle.oracle_awr_service import _SEVERITY_ORDER, finding_dict

STALE_AFTER_DAYS = 7
FORECAST_METRICS = ("aas", "host_cpu_busy_pct")
_SQL_COLS = ("module", "text_preview", "elapsed_s", "executions", "elapsed_per_exec_s", "pct_db_time", "cpu_s",
             "cpu_pct", "io_pct", "buffer_gets", "gets_per_exec", "physical_reads", "reads_per_exec",
             "parse_calls", "rows_processed", "version_count", "lists")


# ── loading ─────────────────────────────────────────────────────────────────
def _reports(db: Session, org_id: int | None, database_key: str):
    q = db.query(OracleAwrReport).filter(OracleAwrReport.database_key == database_key, OracleAwrReport.status == "PARSED")
    if org_id is not None:
        q = q.filter(OracleAwrReport.org_id == org_id)
    return q.order_by(OracleAwrReport.begin_time.asc().nulls_first(), OracleAwrReport.id.asc()).all()


def load_points(db: Session, org_id: int | None, database_key: str) -> tuple[list, list[dict]]:
    reps = [r for r in _reports(db, org_id, database_key) if r.begin_time]
    ids = [r.id for r in reps]
    metrics, sqls = defaultdict(dict), defaultdict(dict)
    if ids:
        for m in db.query(OracleAwrMetric).filter(OracleAwrMetric.report_id.in_(ids)):
            metrics[m.report_id][m.metric_key] = m.value
        for s in db.query(OracleAwrSqlStat).filter(OracleAwrSqlStat.report_id.in_(ids)):
            sqls[s.report_id][s.sql_id] = {c: getattr(s, c) for c in _SQL_COLS}
    points = [{"report_id": r.id, "begin": r.begin_time, "end": r.end_time, "elapsed_min": r.elapsed_minutes,
               "startup": (r.data_quality or {}).get("instance_startup"),
               "metrics": metrics[r.id], "sql": sqls[r.id]} for r in reps]
    return reps, points


def _freshness(reps) -> dict:
    if not reps:
        return {"latest_report_end": None, "age_days": None, "stale": None}
    latest = max((r.end_time or r.begin_time) for r in reps if r.begin_time)
    age = (datetime.utcnow() - latest).total_seconds() / 86400
    return {"latest_report_end": latest.isoformat(), "age_days": round(age, 1), "stale": age > STALE_AFTER_DAYS,
            "note": ("Uploaded AWR files are historical. Results describe the windows the reports cover; "
                     "forecasts are for the windows after the latest report, not for today.")}


# ── recompute ───────────────────────────────────────────────────────────────
def _score_forecasts(db: Session, org_id: int, database_key: str, reps) -> int:
    """A pending forecast is scored when a report starts within 45 min of its
    target time (same window). Returns how many were scored."""
    pend = db.query(OracleAwrForecast).filter(OracleAwrForecast.database_key == database_key,
                                              OracleAwrForecast.org_id == org_id, OracleAwrForecast.status == "pending").all()
    scored = 0
    for f in pend:
        match = next((r for r in reps if r.begin_time and abs((r.begin_time - f.target_time).total_seconds()) <= 45 * 60), None)
        if not match:
            continue
        m = db.query(OracleAwrMetric).filter(OracleAwrMetric.report_id == match.id, OracleAwrMetric.metric_key == f.metric_key).first()
        if m:
            f.status, f.actual_value, f.actual_report_id = "observed", m.value, match.id
            scored += 1
    return scored


def recompute(db: Session, org_id: int, database_key: str | None) -> dict:
    if not database_key:
        return {"status": "skipped", "reason": "Report has no database identity (no DBID)."}
    reps, points = load_points(db, org_id, database_key)
    scored = _score_forecasts(db, org_id, database_key, reps)

    kept = {f.rule_id: (f.status, f.outcome_note) for f in db.query(OracleAwrFinding).filter(
        OracleAwrFinding.database_key == database_key, OracleAwrFinding.org_id == org_id,
        OracleAwrFinding.source == "statistics") if f.rule_id and (f.status not in (None, "open") or f.outcome_note)}
    db.query(OracleAwrFinding).filter(OracleAwrFinding.database_key == database_key, OracleAwrFinding.org_id == org_id,
                                      OracleAwrFinding.source == "statistics").delete(synchronize_session=False)
    db.query(OracleAwrForecast).filter(OracleAwrForecast.database_key == database_key, OracleAwrForecast.org_id == org_id,
                                       OracleAwrForecast.status == "pending").update({"status": "superseded"})
    if not points:
        db.commit()
        return {"status": "ok", "findings": 0, "forecasts": 0, "scored": scored}

    latest = reps[-1]
    quality = "complete" if len(points) >= 6 else "limited"
    drafts = _history_findings(db, org_id, database_key, reps, points)
    for d in drafts:
        db.add(OracleAwrFinding(org_id=org_id, database_key=database_key, report_id=latest.id, source="statistics",
                                status=kept.get(d["rule_id"], ("open", None))[0],
                                outcome_note=kept.get(d["rule_id"], (None, None))[1],
                                snapshot_start=reps[0].begin_time, snapshot_end=latest.end_time,
                                data_quality=quality, model_version=H.HISTORY_VERSION, **d))

    stored = 0
    for key, fc in H.forecasts(points, FORECAST_METRICS).items():
        if fc["status"] != "ok":
            continue
        bt = fc["backtest"]
        for p in fc["predictions"]:
            db.add(OracleAwrForecast(
                org_id=org_id, database_key=database_key, metric_key=key, model_version=fc["model"],
                method=f"{fc['model']}; {int(LEVEL * 100)}% prediction interval (Student-t)",
                based_on_report_id=latest.id, horizon=p["horizon"], target_time=p["target_time"],
                predicted_value=p["value"], interval_low=p["low"], interval_high=p["high"], interval_level=LEVEL,
                train_points=fc["train_points"], backtest_points=bt["points"], backtest_mae=bt["mae"],
                backtest_rmse=bt["rmse"], naive_mae=bt["naive_mae"], status="pending"))
            stored += 1
    db.commit()
    return {"status": "ok", "findings": len(drafts), "forecasts": stored, "scored": scored}


def _f(rule_id, finding_type, severity, category, title, evidence, *, observed=None, baseline=None, refs=None,
       causes=None, actions=None, method=None, horizon=None, predicted=None, interval=None):
    return dict(rule_id=rule_id[:80], finding_type=finding_type, severity=severity,
                risk_level={"HIGH": "high", "MEDIUM": "medium", "LOW": "low"}.get(severity, "none"),
                category=category, title=title[:500], evidence=evidence,
                recommendation=(actions or [{}])[0].get("action"), observed_metrics=observed, baseline_metrics=baseline,
                evidence_refs=refs or [], probable_causes=causes or [], recommended_actions=actions or [],
                confidence_method=method, forecast_horizon=horizon, predicted_value=predicted, prediction_interval=interval)


def _history_findings(db, org_id, database_key, reps, points) -> list[dict]:
    out = []
    for t in H.trends(points):
        if not t["significant"]:
            continue
        refs = [{"report_id": s["report_id"], "metric_key": t["metric_key"]} for s in t["series"]]
        if t["worsening"]:
            out.append(_f(f"trend:{t['metric_key']}", "trend", "MEDIUM", t["category"].title(),
                          f"{t['label']} is rising across reports",
                          f"{t['label']} rose by about {t['slope_per_day']:+.3g} per day over {t['n']} reports "
                          f"({t['first']:.3g} → {t['latest']:.3g}; p = {t['p_value']:.3f}).",
                          observed={"latest": t["latest"], "slope_per_day": t["slope_per_day"]},
                          baseline={"median": t["median"], "min": t["min"], "max": t["max"]}, refs=refs,
                          causes=["Workload change", "A developing bottleneck — see the matching diagnosis findings"],
                          actions=[{"action": f"Review the reports where {t['label'].lower()} is highest and the SQL that dominates them.",
                                    "rationale": "A sustained rise is a lead indicator before it becomes an incident.",
                                    "validation": "The trend flattens in subsequent uploads.", "rollback": "n/a", "risk": "none"}],
                          method=t["method"] + " (p < 0.05)"))
        else:
            out.append(_f(f"trend:{t['metric_key']}", "trend", "INFO", t["category"].title(),
                          f"{t['label']} is {t['direction']} across reports",
                          f"{t['label']} changed by {t['slope_per_day']:+.3g} per day over {t['n']} reports (p = {t['p_value']:.3f}).",
                          observed={"latest": t["latest"], "slope_per_day": t["slope_per_day"]},
                          baseline={"median": t["median"]}, refs=refs, method=t["method"] + " (p < 0.05)"))

    for a in H.anomalies(points):
        if not a["worse"]:
            continue
        out.append(_f(f"anomaly:{a['metric_key']}", "risk", "MEDIUM", a["category"].title(),
                      f"Abnormal {a['label'].lower()} in the latest report",
                      f"{a['label']} was {a['value']:.3g} vs a median of {a['baseline_median']:.3g} ({a['scope']}, "
                      f"n={a['baseline_n']}; robust z = {a['robust_z']:.1f}).",
                      observed={a["metric_key"]: a["value"]}, baseline={"median": a["baseline_median"], "n": a["baseline_n"]},
                      refs=[{"report_id": a["report_id"], "metric_key": a["metric_key"]}],
                      causes=["An unusual job or workload in this window", "A change deployed before this window"],
                      actions=[{"action": "Compare this report with a normal one of the same window (History & Reports → Compare).",
                                "rationale": "The comparison shows which SQL and waits changed.",
                                "validation": "n/a", "rollback": "n/a", "risk": "none"}],
                      method="Modified z-score (median/MAD), |z| ≥ 3.5"))

    for r in H.sql_regressions(points):
        sev = "HIGH" if r["ratio"] >= 5 else "MEDIUM"
        out.append(_f(f"sql_regression:{r['sql_id']}", "trend", sev, "SQL",
                      f"SQL {r['sql_id']} is {r['ratio']:.1f}× slower per execution",
                      f"{r['sql_id']} ({r['module'] or 'unknown module'}) takes {r['latest_per_exec_s']:.2f} s per execution "
                      f"in the latest report vs a median of {r['baseline_per_exec_s']:.2f} s over {r['baseline_reports']} earlier reports.",
                      observed={"elapsed_per_exec_s": r["latest_per_exec_s"], "executions": r["executions"]},
                      baseline={"median_elapsed_per_exec_s": r["baseline_per_exec_s"], "reports": r["baseline_reports"]},
                      refs=[{"report_id": r["report_id"], "sql_id": r["sql_id"], "section": "SQL ordered by Elapsed Time"}],
                      causes=["Execution plan changed (AWR HTML has no plan hash — check DBA_HIST_SQLSTAT)",
                              "Each execution now processes more rows (e.g. a growing backlog per run)",
                              "Contention or I/O slowing this statement"],
                      actions=[{"action": f"Compare plans of {r['sql_id']} across the snapshots.",
                                "rationale": "A new plan_hash_value with a higher per-execution time confirms a plan regression.",
                                "validation": f"SELECT snap_id, plan_hash_value, elapsed_time_delta/NULLIF(executions_delta,0)/1e6 s_per_exec, "
                                              f"rows_processed_delta/NULLIF(executions_delta,0) rows_per_exec FROM dba_hist_sqlstat "
                                              f"WHERE sql_id='{r['sql_id']}' ORDER BY snap_id;",
                                "rollback": "Diagnostic only — no change.", "risk": "none"},
                               {"action": "If the plan changed, pin the earlier good plan with a SQL plan baseline.",
                                "rationale": "Restores known-good performance while the cause is investigated.",
                                "validation": "Per-execution time returns to the baseline in the next AWR.",
                                "rollback": "DBMS_SPM.DROP_SQL_PLAN_BASELINE for the baseline created.",
                                "risk": "Pinned plans can become wrong as data changes."}],
                      method=f"Latest elapsed/exec ≥ 2× median of earlier reports (≥ 5 executions each)"))

    hits = defaultdict(list)
    for f in db.query(OracleAwrFinding).filter(OracleAwrFinding.database_key == database_key, OracleAwrFinding.org_id == org_id,
                                               OracleAwrFinding.source == "rule", OracleAwrFinding.severity.in_(("HIGH", "MEDIUM"))):
        base = (f.rule_id or "").split(":")[0]
        if base and f.report_id not in hits[base]:
            hits[base].append(f.report_id)
    for b in H.repeated_bottlenecks(hits, len(points)):
        out.append(_f(f"repeated:{b['rule_id']}", "risk", "HIGH" if b["share"] >= 0.9 else "MEDIUM", "Repeated bottleneck",
                      f"'{b['rule_id'].replace('_', ' ')}' recurs in {b['reports']} of {b['of']} reports",
                      f"The same diagnosis fired in {b['share']:.0%} of this database's reports — a standing problem, not an incident.",
                      observed={"reports": b["reports"], "of": b["of"]},
                      refs=[{"report_id": rid, "rule_id": b["rule_id"]} for rid in b["report_ids"]],
                      causes=["A structural cause (configuration, storage or application design) rather than a one-off"],
                      actions=[{"action": "Treat this as a project: fix the root cause named in the matching diagnosis findings.",
                                "rationale": "Recurring problems cost every day they stay.",
                                "validation": "The diagnosis stops firing in new reports.", "rollback": "n/a", "risk": "none"}],
                      method="Same rule HIGH/MEDIUM in ≥ 60% of reports (≥ 4 reports)"))

    pat = H.recurring_pattern(points)
    if pat and pat["recurring"]:
        c = pat["peak_consistency"]
        out.append(_f("pattern:aas_peak_window", "trend", "INFO", "Workload",
                      f"Load peaks every day in the {pat['peak_window']} window",
                      f"The {pat['peak_window']} window was the busiest on {c['days_peak']} of {c['days_compared']} days "
                      f"(median {pat['peak_median']:.1f} active sessions, {pat['ratio_to_other_windows']:.1f}× the other windows).",
                      observed={"profile": pat["profile"]}, refs=[{"metric_key": "aas"}],
                      method="Median by time-of-day window; peak consistent on ≥ 75% of ≥ 3 full days"))
    for b in H.batch_correlation(points):
        out.append(_f(f"batch:{b['module']}", "trend", "LOW", "Workload",
                      f"{'Batch job' if b['batch_like'] else 'Module'} {b['module']} concentrates in the busiest windows",
                      f"Its SQL averages {b['busy_avg_pct_db_time']:.1f}% of DB time in the busiest quarter of windows "
                      f"({', '.join(b['busy_windows'])}) vs {b['other_avg_pct_db_time']:.1f}% elsewhere.",
                      observed=b, refs=[{"module": b["module"]}],
                      causes=["A scheduled job overlapping peak online load"],
                      actions=[{"action": "Check whether this job can run outside the peak window.",
                                "rationale": "Moving batch load off the peak lowers peak active sessions.",
                                "validation": "Peak-window active sessions fall after rescheduling.",
                                "rollback": "Restore the previous schedule.", "risk": "Job completion times change."}],
                      method="Top-quartile-AAS windows vs the rest; ≥ 2× share and ≥ 2% of DB time (≥ 8 reports)"))
    for r in H.restarts(points):
        out.append(_f(f"restart:{r['report_id']}", "trend", "INFO", "Availability", "Instance restarted between reports",
                      f"Instance startup time changed from {r['before']} to {r['after']}; caches were cold after the restart.",
                      refs=[{"report_id": r["report_id"]}], method="Instance startup time compared between consecutive reports"))

    for key, fc in H.forecasts(points, FORECAST_METRICS).items():
        if fc["status"] != "ok":
            continue
        peak = max(fc["predictions"], key=lambda p: p["value"])
        label = H.TRACKED[key][0]
        bt = fc["backtest"]
        out.append(_f(f"forecast:{key}", "forecast", "INFO", "Forecast",
                      f"Forecast {label.lower()}: peak {peak['value']:.1f} in the {peak['horizon']}",
                      f"{fc['model']} predicts {peak['value']:.1f} ({int(LEVEL*100)}% interval {peak['low']:.1f}–{peak['high']:.1f}). "
                      f"Backtest on {bt['points']} past reports: MAE {bt['mae']:.2f}, RMSE {bt['rmse']:.2f}, "
                      f"{bt['coverage']:.0%} of actuals inside the interval; naive last-value MAE {bt['naive_mae']:.2f}"
                      + ("" if fc["beats_naive"] else " — this model does NOT beat the naive forecast.") + ".",
                      observed={"backtest": bt, "model": fc["model"]}, refs=[{"metric_key": key}],
                      method=f"{fc['model']} selected by lowest backtest MAE", horizon=peak["horizon"],
                      predicted=peak["value"], interval={"low": peak["low"], "high": peak["high"], "level": LEVEL}))

    cap = H.capacity(points, reps[-1].num_cpus)
    for name, est in (("host CPU busy reaching 80%", cap["cpu"]["host_busy_pct"]["to_80pct"]),
                      ("active sessions reaching 80% of CPUs", (cap["cpu"]["aas_vs_cpus"] or {}).get("to_80pct_of_cpus"))):
        if est and est.get("status") == "estimated":
            days = est["days_to_threshold"]
            out.append(_f(f"capacity:{name}", "risk" if days <= 90 else "forecast", "HIGH" if days <= 30 else "MEDIUM" if days <= 90 else "INFO",
                          "Capacity", f"At the current rise, {name} in about {days:.0f} days",
                          f"Extrapolated crossing around {est['eta']:%d %b %Y} ({est['method']}).",
                          observed={"latest": est["latest"], "peak": est["peak"], "slope_per_day": est["slope_per_day"]},
                          method=est["method"], horizon=f"{days:.0f} days", predicted=est["threshold"]))
        elif est and est.get("status") == "crossed":
            out.append(_f(f"capacity:{name}", "risk", "HIGH", "Capacity", f"{name.capitalize()} already reached",
                          f"Peak {est['peak']:.1f} ≥ threshold {est['threshold']:.1f}.", method="Observed peak vs threshold"))
    return out


# ── read payloads ───────────────────────────────────────────────────────────
def databases(db: Session, org_id: int | None) -> list[dict]:
    q = db.query(OracleAwrReport).filter(OracleAwrReport.database_key.isnot(None))
    if org_id is not None:
        q = q.filter(OracleAwrReport.org_id == org_id)
    groups = defaultdict(list)
    for r in q:
        groups[r.database_key].append(r)
    out = []
    for key, reps in groups.items():
        parsed = sorted((r for r in reps if r.status == "PARSED" and r.begin_time), key=lambda r: r.begin_time)
        last = parsed[-1] if parsed else reps[-1]
        out.append({"database_key": key, "db_name": last.db_name, "dbid": last.dbid, "instance_number": last.instance_number,
                    "host_name": last.host_name, "release": last.db_release, "is_rac": last.is_rac, "platform": last.platform,
                    "num_cpus": last.num_cpus, "reports": len(reps), "parsed_reports": len(parsed),
                    "first_window": parsed[0].begin_time.isoformat() if parsed else None,
                    "last_window": last.end_time.isoformat() if last.end_time else None,
                    **_freshness(parsed)})
    return sorted(out, key=lambda d: d["last_window"] or "", reverse=True)


def _findings(db, org_id, database_key, **filters):
    q = db.query(OracleAwrFinding).filter(OracleAwrFinding.database_key == database_key)
    if org_id is not None:
        q = q.filter(OracleAwrFinding.org_id == org_id)
    for k, v in filters.items():
        q = q.filter(getattr(OracleAwrFinding, k).in_(v) if isinstance(v, (list, tuple)) else getattr(OracleAwrFinding, k) == v)
    return q.all()


def overview(db: Session, org_id: int | None, database_key: str) -> dict:
    reps, points = load_points(db, org_id, database_key)
    if not reps:
        return {"status": "error", "error": "No parsed reports for this database"}
    latest = points[-1]["metrics"] if points else {}
    all_f = _findings(db, org_id, database_key)
    latest_id = reps[-1].id
    cur = [f for f in all_f if (f.report_id == latest_id and f.source == "rule") or f.source == "statistics"]
    sev = defaultdict(int)
    for f in cur:
        sev[f.severity] += 1
    risks = sorted((f for f in all_f if f.finding_type in ("risk", "trend") and f.severity in ("HIGH", "MEDIUM")
                    and (f.status or "open") != "resolved"), key=lambda f: _SEVERITY_ORDER.get(f.severity, 9))
    top = sorted((f for f in cur if f.finding_type == "diagnosis"), key=lambda f: _SEVERITY_ORDER.get(f.severity, 9))
    keys = ("aas", "db_cpu_per_s", "host_cpu_busy_pct", "db_cpu_util_pct", "log_file_sync_ms", "single_block_read_ms",
            "logical_reads_per_s", "physical_reads_per_s", "executes_per_s", "commits_per_s", "hard_parses_per_s", "sessions_end")
    return {
        "status": "ok", "database": next(d for d in databases(db, org_id) if d["database_key"] == database_key),
        "latest_report": {"id": latest_id, "begin_time": reps[-1].begin_time.isoformat() if reps[-1].begin_time else None,
                          "end_time": reps[-1].end_time.isoformat() if reps[-1].end_time else None,
                          "original_filename": reps[-1].original_filename, "data_quality": reps[-1].data_quality},
        "workload": {k: latest.get(k) for k in keys},
        "severity_distribution": dict(sev),
        "top_findings": [finding_dict(f) for f in top[:5]],
        "current_risks": [finding_dict(f) for f in risks[:8]],
        "history": {k: [{"time": p["begin"].isoformat(), "value": p["metrics"][k], "report_id": p["report_id"]}
                        for p in points if k in p["metrics"]] for k in ("aas", "host_cpu_busy_pct", "db_cpu_per_s")},
        "pattern": H.recurring_pattern(points),
        "freshness": _freshness(reps),
    }


def sql_insights(db: Session, org_id: int | None, database_key: str) -> dict:
    reps, points = load_points(db, org_id, database_key)
    if not points:
        return {"status": "error", "error": "No parsed reports for this database"}
    latest = points[-1]
    def top(key, n=10):
        rows = [{"sql_id": k, **v} for k, v in latest["sql"].items() if v.get(key) is not None]
        return sorted(rows, key=lambda r: -r[key])[:n]
    elapsed_s = (reps[-1].elapsed_minutes or 0) * 60
    return {
        "status": "ok", "report_id": latest["report_id"],
        "ranking": H.sql_ranking(points),
        "regressions": H.sql_regressions(points) if len(points) >= 3 else [],
        "regressions_status": "ok" if len(points) >= 3 else "insufficient",
        "latest": {"by_elapsed": top("elapsed_s"), "by_cpu": top("cpu_s"), "by_gets": top("buffer_gets"),
                   "by_reads": top("physical_reads"), "by_parse_calls": top("parse_calls"),
                   "by_version_count": top("version_count", 5),
                   "frequent_no_rows": [{"sql_id": k, **v, "executions_per_s": (v["executions"] / elapsed_s if elapsed_s else None)}
                                        for k, v in latest["sql"].items() if v.get("rows_processed") == 0 and (v.get("executions") or 0) > 0][:10]},
        "plan_history": {"available": False,
                         "reason": "AWR HTML lists carry no plan hash values; plan regressions need DBA_HIST_SQLSTAT/DBA_HIST_SQL_PLAN."},
        "findings": [finding_dict(f) for f in _findings(db, org_id, database_key, category="SQL")
                     if f.source == "statistics" or f.report_id == latest["report_id"]],
    }


_WAIT_GUIDE = {
    "Commit": "Time sessions wait for their commit to be written to the redo log (log file sync). High values point at redo storage latency or very frequent commits.",
    "User I/O": "Reads of data blocks from disk. Compare latency (ms per read) with volume: fast reads but a high share means SQL reads too much; slow reads mean storage.",
    "Application": "Waits caused by application design — mostly row locks (enq: TX - row lock contention) when sessions update the same rows.",
    "Concurrency": "Internal contention on shared structures (latches, mutexes, buffer busy waits) — often hot blocks or heavy parsing.",
    "CPU": "Time on CPU. Not a wait: a high share is normal for a CPU-bound workload, unless sessions also queue for CPU.",
    "Configuration": "Waits caused by configuration limits (log file switch, free buffer waits). Usually fixable by sizing.",
    "Network": "Time sending data to clients or over database links; usually small.",
    "System I/O": "Background I/O (control files, archiving).",
    "Other": "Miscellaneous waits that fit no other class.",
}


def waits(db: Session, org_id: int | None, database_key: str) -> dict:
    reps, points = load_points(db, org_id, database_key)
    if not points:
        return {"status": "error", "error": "No parsed reports for this database"}
    latest = points[-1]["metrics"]
    classes = sorted(({"wait_class": k.replace("wait_class_", "").replace("_pct", ""), "metric_key": k, "pct_db_time": v}
                      for k, v in latest.items() if k.startswith("wait_class_")), key=lambda r: -r["pct_db_time"])
    names = {m.metric_key: m.label for m in db.query(OracleAwrMetric).filter(OracleAwrMetric.report_id == points[-1]["report_id"],
                                                                         OracleAwrMetric.category == "event")}
    events = sorted(({"event": names.get(k, k), "metric_key": k, "pct_db_time": v} for k, v in latest.items() if k.startswith("event_pct:")),
                    key=lambda r: -r["pct_db_time"])
    for c in classes:
        label = {"user_i_o": "User I/O", "system_i_o": "System I/O", "cpu": "CPU"}.get(c["wait_class"], c["wait_class"].title())
        c["label"], c["guide"] = label, _WAIT_GUIDE.get(label)
        c["history"] = [{"time": p["begin"].isoformat(), "value": p["metrics"][c["metric_key"]], "report_id": p["report_id"]}
                        for p in points if c["metric_key"] in p["metrics"]]
    latency = {k: [{"time": p["begin"].isoformat(), "value": p["metrics"][k], "report_id": p["report_id"]}
                   for p in points if k in p["metrics"]] for k in ("log_file_sync_ms", "single_block_read_ms")}
    trend_rows = [t for t in H.trends(points) if t["category"] == "waits"]
    return {"status": "ok", "report_id": points[-1]["report_id"], "classes": classes, "events": events[:12],
            "latency": latency, "trends": [{k: v for k, v in t.items() if k != "series"} for t in trend_rows],
            "findings": [finding_dict(f) for f in _findings(db, org_id, database_key, category=["Wait Events", "Commit", "I/O", "Concurrency"])
                         if f.source == "statistics" or f.report_id == points[-1]["report_id"]]}


def predictions(db: Session, org_id: int | None, database_key: str) -> dict:
    reps, points = load_points(db, org_id, database_key)
    if not points:
        return {"status": "error", "error": "No parsed reports for this database"}
    fcs = {}
    for key, fc in H.forecasts(points, FORECAST_METRICS).items():
        hist = [{"time": p["begin"].isoformat(), "value": p["metrics"][key], "report_id": p["report_id"], "window": window_of(p["begin"])}
                for p in points if key in p["metrics"]]
        if fc["status"] == "ok":
            fc = {**fc, "predictions": [{**p, "target_time": p["target_time"].isoformat()} for p in fc["predictions"]]}
        fcs[key] = {"label": H.TRACKED[key][0], "history": hist, **fc}
    q = db.query(OracleAwrForecast).filter(OracleAwrForecast.database_key == database_key, OracleAwrForecast.status == "observed")
    if org_id is not None:
        q = q.filter(OracleAwrForecast.org_id == org_id)
    scored = [{"metric_key": f.metric_key, "target_time": f.target_time.isoformat(), "predicted": f.predicted_value,
               "low": f.interval_low, "high": f.interval_high, "actual": f.actual_value, "model": f.model_version,
               "inside_interval": f.interval_low <= f.actual_value <= f.interval_high if f.interval_low is not None else None}
              for f in q.order_by(OracleAwrForecast.target_time)]
    return {"status": "ok", "forecasts": fcs, "trends": [{k: v for k, v in t.items()} for t in H.trends(points)],
            "anomalies": H.anomalies(points), "pattern": H.recurring_pattern(points), "scored_forecasts": scored,
            "freshness": _freshness(reps), "slo": {"available": False,
                                                  "reason": "No SLO thresholds are configured for this database, so SLO breach risk is not computed."}}


def capacity_view(db: Session, org_id: int | None, database_key: str) -> dict:
    reps, points = load_points(db, org_id, database_key)
    if not points:
        return {"status": "error", "error": "No parsed reports for this database"}
    cap = H.capacity(points, reps[-1].num_cpus)
    hist = {k: [{"time": p["begin"].isoformat(), "value": p["metrics"][k]} for p in points if k in p["metrics"]]
            for k in ("host_cpu_busy_pct", "db_cpu_util_pct", "aas", "pga_alloc_mb", "sga_used_mb",
                      "host_mem_used_by_db_pct", "sessions_end", "read_mb_per_s", "write_mb_per_s")}
    return {"status": "ok", "capacity": _jsonable(cap), "history": hist, "num_cpus": reps[-1].num_cpus,
            "host_mem_gb": reps[-1].host_mem_gb, "freshness": _freshness(reps)}


def _jsonable(obj):
    if isinstance(obj, dict):
        return {k: _jsonable(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_jsonable(v) for v in obj]
    return obj.isoformat() if isinstance(obj, datetime) else obj


def recommendations(db: Session, org_id: int | None, database_key: str) -> dict:
    reps = _reports(db, org_id, database_key)
    if not reps:
        return {"status": "error", "error": "No parsed reports for this database"}
    latest_id = reps[-1].id
    rows = [f for f in _findings(db, org_id, database_key)
            if f.recommended_actions and f.severity in ("HIGH", "MEDIUM", "LOW")
            and (f.source in ("statistics", "llm") or f.report_id == latest_id)]
    rows.sort(key=lambda f: (_SEVERITY_ORDER.get(f.severity, 9), 0 if f.finding_type in ("risk", "trend") else 1))
    return {"status": "ok", "report_id": latest_id, "items": [finding_dict(f) for f in rows]}


def compare(db: Session, org_id: int | None, base_id: int, target_id: int) -> dict:
    q = db.query(OracleAwrReport).filter(OracleAwrReport.id.in_((base_id, target_id)), OracleAwrReport.status == "PARSED")
    if org_id is not None:
        q = q.filter(OracleAwrReport.org_id == org_id)
    reps = {r.id: r for r in q}
    if len(reps) != 2:
        return {"status": "error", "error": "Both reports must exist and be parsed"}
    a, b = reps[base_id], reps[target_id]
    warnings = []
    if a.database_key != b.database_key:
        warnings.append("The reports are from different databases — differences reflect two systems, not a change.")
    if a.elapsed_minutes and b.elapsed_minutes and max(a.elapsed_minutes, b.elapsed_minutes) / min(a.elapsed_minutes, b.elapsed_minutes) > 4:
        warnings.append("Window lengths differ by more than 4×; rates are per second, but short windows are noisier.")
    if a.begin_time and b.begin_time and window_of(a.begin_time) != window_of(b.begin_time):
        warnings.append(f"Different times of day ({window_of(a.begin_time)} vs {window_of(b.begin_time)}) — workload may differ by design.")
    ma = {m.metric_key: m for m in db.query(OracleAwrMetric).filter(OracleAwrMetric.report_id == base_id)}
    mb = {m.metric_key: m for m in db.query(OracleAwrMetric).filter(OracleAwrMetric.report_id == target_id)}
    metrics = []
    for k in sorted(set(ma) & set(mb)):
        va, vb = ma[k].value, mb[k].value
        metrics.append({"metric_key": k, "label": mb[k].label, "unit": mb[k].unit, "category": mb[k].category, "base": va,
                        "target": vb, "delta": vb - va, "pct_change": ((vb - va) / va * 100) if va else None})
    sa = {s.sql_id: s for s in db.query(OracleAwrSqlStat).filter(OracleAwrSqlStat.report_id == base_id)}
    sb = {s.sql_id: s for s in db.query(OracleAwrSqlStat).filter(OracleAwrSqlStat.report_id == target_id)}
    sql = []
    for sid in set(sa) | set(sb):
        x, y = sa.get(sid), sb.get(sid)
        sql.append({"sql_id": sid, "module": (y or x).module,
                    "base_per_exec_s": x.elapsed_per_exec_s if x else None, "target_per_exec_s": y.elapsed_per_exec_s if y else None,
                    "base_elapsed_s": x.elapsed_s if x else None, "target_elapsed_s": y.elapsed_s if y else None,
                    "ratio": (y.elapsed_per_exec_s / x.elapsed_per_exec_s) if x and y and x.elapsed_per_exec_s and y.elapsed_per_exec_s else None,
                    "status": "new" if not x else "gone" if not y else "both"})
    sql.sort(key=lambda r: -(r["target_elapsed_s"] or 0))
    def meta(r):
        return {"id": r.id, "original_filename": r.original_filename, "database_key": r.database_key,
                "begin_time": r.begin_time.isoformat() if r.begin_time else None, "elapsed_minutes": r.elapsed_minutes}
    return {"status": "ok", "base": meta(a), "target": meta(b), "warnings": warnings, "metrics": metrics, "sql": sql[:30]}


def update_finding(db: Session, org_id: int | None, finding_id: int, status: str | None, note: str | None) -> dict:
    if status and status not in ("open", "acknowledged", "resolved"):
        return {"status": "error", "error": "status must be open, acknowledged or resolved"}
    q = db.query(OracleAwrFinding).filter(OracleAwrFinding.id == finding_id)
    if org_id is not None:
        q = q.filter(OracleAwrFinding.org_id == org_id)
    f = q.first()
    if not f:
        return {"status": "error", "error": "Finding not found"}
    before = {"status": f.status, "outcome_note": f.outcome_note}
    if status:
        f.status = status
    if note is not None:
        f.outcome_note = note[:4000]
    db.commit()
    return {"status": "ok", "finding": finding_dict(f), "before": before}


def export_rows(db: Session, org_id: int | None, database_key: str) -> list[dict]:
    reps = {r.id: r for r in _reports(db, org_id, database_key)}
    rows = []
    for f in _findings(db, org_id, database_key):
        r = reps.get(f.report_id)
        rows.append({"finding_id": f.id, "finding_type": f.finding_type, "source": f.source, "severity": f.severity,
                     "category": f.category, "title": f.title, "evidence": f.evidence, "recommendation": f.recommendation,
                     "status": f.status, "outcome_note": f.outcome_note, "database_id": f.database_key, "report_id": f.report_id,
                     "report_file": r.original_filename if r else None,
                     "snapshot_start": f.snapshot_start.isoformat() if f.snapshot_start else None,
                     "snapshot_end": f.snapshot_end.isoformat() if f.snapshot_end else None,
                     "confidence_method": f.confidence_method, "model_version": f.model_version})
    return sorted(rows, key=lambda r: (_SEVERITY_ORDER.get(r["severity"], 9), r["category"] or ""))


def awr_alerts(db: Session, org_id: int | None) -> list[dict]:
    """Open HIGH/MEDIUM risk and diagnosis findings from each database's latest
    report — the feed the existing Active Alerts page shows when the opt-in
    'Oracle AWR Risk' rule is enabled. Always labelled as historical."""
    out = []
    for d in databases(db, org_id):
        reps = _reports(db, org_id, d["database_key"])
        if not reps:
            continue
        latest = reps[-1]
        for f in _findings(db, org_id, d["database_key"]):
            if (f.status or "open") != "open" or f.severity not in ("HIGH", "MEDIUM"):
                continue
            if f.source == "rule" and f.report_id != latest.id:
                continue
            window = f"{latest.begin_time:%d %b %H:%M}–{latest.end_time:%H:%M}" if latest.begin_time and latest.end_time else "unknown window"
            out.append({"finding_id": f.id, "database_key": d["database_key"], "db_name": d["db_name"], "host_name": d["host_name"],
                        "severity": f.severity, "finding_type": f.finding_type, "category": f.category, "title": f.title,
                        "message": f"{f.title} — AWR snapshot {window} (uploaded history, not live monitoring)",
                        "snapshot_end": latest.end_time.isoformat() if latest.end_time else None})
    return out
