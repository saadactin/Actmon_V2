# -*- coding: utf-8 -*-
"""Redo generation, the alert log and RMAN's job window.

Each of these was checked against the DBA team's own scripts, and each test
pins a place where the obvious query gives a wrong answer on this estate:
gv$log_history doubling every count on RAC, "switches x log size" counting a
half-empty log as full, an alert-log read with no time bound, and an RMAN job
list that let a weekly full backup scroll out of sight.
"""
import os
import sys
from datetime import date

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.services.oracle import oracle_redo_service as redo
from app.services.oracle.oracle_redo_service import build_redo_summary, _nice_size_mb
from app.services.oracle.oracle_rman_service import merge_anchor_jobs

TODAY = date(2026, 10, 13)


# ── redo: the SQL itself ──────────────────────────────────────────────────

class _Recorder:
    def __init__(self, reply=None):
        self.sql, self.params, self.reply = [], [], reply or []

    def __call__(self, engine, sql, params=None):
        self.sql.append(" ".join(sql.split()))
        self.params.append(params or {})
        return self.reply


def test_switches_come_from_v_log_history_not_gv(monkeypatch):
    """The control file is shared, so v$log_history already has every thread.
    gv$log_history asks each instance for that same list — doubling every
    count on two nodes. redo_hour.sql uses gv$."""
    rec = _Recorder()
    monkeypatch.setattr(redo, "_rows", rec)
    redo._switches(object(), 14, [])
    sql = rec.sql[0].lower()
    assert "from v$log_history" in sql
    assert "gv$log_history" not in sql


def test_days_are_truncated_not_round_tripped_through_to_date(monkeypatch):
    rec = _Recorder()
    monkeypatch.setattr(redo, "_rows", rec)
    redo._switches(object(), 14, [])
    assert "trunc(first_time)" in rec.sql[0].lower()
    assert "to_date(first_time)" not in rec.sql[0].lower()


def test_volume_is_measured_from_archived_log_and_deduplicated(monkeypatch):
    """One log is archived once per destination. Without collapsing on
    (thread, sequence, resetlogs) a second destination doubles the volume."""
    rec = _Recorder()
    monkeypatch.setattr(redo, "_rows", rec)
    redo._archived_volume(object(), 14, [])
    sql = rec.sql[0].lower()
    assert "from v$archived_log" in sql
    assert "blocks * block_size" in sql
    assert "group by thread#, sequence#, resetlogs_change#" in sql
    assert "standby_dest = 'no'" in sql


def test_the_window_is_a_bind_not_interpolated(monkeypatch):
    rec = _Recorder()
    monkeypatch.setattr(redo, "_rows", rec)
    redo._switches(object(), 30, [])
    assert rec.params[0] == {"days": 30}
    assert ":days" in rec.sql[0]


def test_a_failed_read_is_none_not_an_empty_history(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("ORA-00942")
    monkeypatch.setattr(redo, "_rows", boom)
    errors = []
    assert redo._switches(object(), 14, errors) is None
    assert errors and "switches" in errors[0]


# ── redo: the summary ─────────────────────────────────────────────────────

def _sw(day, hour, thread, n):
    return {"day": day, "hour": hour, "thread": thread, "switches": n}


SIZES = [{"thread": 1, "groups": 4, "members": 2, "min_mb": 512.0, "max_mb": 512.0},
         {"thread": 2, "groups": 4, "members": 2, "min_mb": 512.0, "max_mb": 512.0}]


def test_heatmap_has_every_day_of_the_window_and_24_hours():
    s = build_redo_summary([_sw("2026-10-12", 9, 1, 3)], None, SIZES, 7, today=TODAY)
    assert len(s["matrix"]) == 7                 # exactly 7 days, today included
    assert all(len(d["hours"]) == 24 for d in s["matrix"])
    assert s["matrix"][-1]["day"] == "2026-10-13"


def test_threads_are_summed_per_hour_and_kept_apart_per_day():
    s = build_redo_summary([_sw("2026-10-12", 9, 1, 3), _sw("2026-10-12", 9, 2, 5)],
                           None, SIZES, 2, today=TODAY)
    day = next(d for d in s["matrix"] if d["day"] == "2026-10-12")
    assert day["hours"][9] == 8
    assert day["by_thread"] == {1: 3, 2: 5}
    assert s["threads"] == [1, 2]


def test_measured_volume_beats_the_estimate():
    vol = [{"day": "2026-10-12", "hour": 9, "thread": 1, "logs": 3, "mb": 700.5}]
    s = build_redo_summary([_sw("2026-10-12", 9, 1, 3)], vol, SIZES, 2, today=TODAY)
    assert s["volume_source"] == "archived"
    day = next(d for d in s["matrix"] if d["day"] == "2026-10-12")
    # 3 switches x 512 MB would be 1536 — the archived figure is what was written.
    assert day["mb_hours"][9] == 700.5


def test_without_archived_logs_volume_is_estimated_and_says_so():
    s = build_redo_summary([_sw("2026-10-12", 9, 1, 3)], [], SIZES, 2, today=TODAY,
                           log_mode="NOARCHIVELOG")
    assert s["volume_source"] == "estimated"
    day = next(d for d in s["matrix"] if d["day"] == "2026-10-12")
    assert day["mb_hours"][9] == 1536.0
    assert any("estimated" in f["title"].lower() for f in s["findings"])


def test_failed_switch_read_produces_no_heatmap_and_a_finding():
    s = build_redo_summary(None, None, SIZES, 7, today=TODAY)
    assert s["matrix"] == []
    assert any("could not be read" in f["title"] for f in s["findings"])


def test_frequent_switching_is_flagged_with_a_size_suggestion():
    s = build_redo_summary([_sw("2026-10-12", 9, 1, 12)], None, SIZES, 2, today=TODAY)
    f = next(f for f in s["findings"] if "switches an hour" in f["title"])
    # 512 MB x 12 / 4 = 1536 -> rounded up to a size a DBA would pick.
    assert s["stats"]["recommended_log_mb"] == 2048
    assert "2048 MB" in f["detail"] and "512 MB" in f["detail"]


def test_switching_within_target_is_not_flagged():
    s = build_redo_summary([_sw("2026-10-12", 9, 1, 3)], None, SIZES, 2, today=TODAY)
    assert not any("switches an hour" in f["title"] for f in s["findings"])
    assert s["stats"]["recommended_log_mb"] is None


def test_the_peak_is_the_busiest_hour_across_threads():
    s = build_redo_summary([_sw("2026-10-11", 2, 1, 4), _sw("2026-10-11", 2, 2, 4),
                            _sw("2026-10-12", 9, 1, 6)], None, SIZES, 3, today=TODAY)
    assert s["stats"]["peak"]["day"] == "2026-10-11"
    assert s["stats"]["peak"]["switches"] == 8
    # Sizing answers to the busiest single thread, which switches its own logs.
    assert s["stats"]["thread_peak"]["switches"] == 6


def test_unequal_log_sizes_are_called_out():
    uneven = [dict(SIZES[0]), {**SIZES[1], "min_mb": 256.0, "max_mb": 256.0}]
    s = build_redo_summary([_sw("2026-10-12", 9, 1, 3)], None, uneven, 2, today=TODAY)
    assert any("not all the same size" in f["title"] for f in s["findings"])


@pytest.mark.parametrize("mb,want", [(300, 512), (1536, 2048), (2048, 2048), (40000, 65536)])
def test_suggested_sizes_are_round_numbers(mb, want):
    assert _nice_size_mb(mb) == want


# ── alert log ─────────────────────────────────────────────────────────────

def test_alert_log_is_time_bounded_ora_filtered_and_named(monkeypatch):
    import app.services.oracle.oracle_monitoring_service as svc
    rec = _Recorder()
    monkeypatch.setattr(svc, "_rows", rec)
    monkeypatch.setattr(svc, "_rows_long", rec)
    monkeypatch.setattr(svc, "_get_conn_or_404", lambda cid, db: object())
    monkeypatch.setattr(svc, "_get_engine", lambda conn: object())
    out = svc.oracle_error_logs(1, None, 24, True)
    first = rec.sql[0].lower()
    assert "numtodsinterval(:hours, 'hour')" in first, "without a time bound the view parses the whole alert log"
    assert "like '%ora-%'" in first
    assert "gv$diag_alert_ext" in first and "gv$instance" in first and "v$database" in first
    assert rec.params[0] == {"hours": 24}
    assert out["window_hours"] == 24 and out["ora_only"] is True


def test_alert_log_never_falls_back_to_v_log(monkeypatch):
    """The old fallback selected instance_number and next_time from v$log —
    columns v$log does not have — and would have shown redo groups as the
    alert log even if it worked."""
    import app.services.oracle.oracle_monitoring_service as svc
    calls = []

    def fail(engine, sql, params=None):
        calls.append(" ".join(sql.split()).lower())
        raise RuntimeError("ORA-00942")
    monkeypatch.setattr(svc, "_rows", fail)
    monkeypatch.setattr(svc, "_rows_long", fail)
    monkeypatch.setattr(svc, "_get_conn_or_404", lambda cid, db: object())
    monkeypatch.setattr(svc, "_get_engine", lambda conn: object())
    out = svc.oracle_error_logs(1, None)
    assert not any("from v$log " in c or c.endswith("from v$log") for c in calls)
    assert out["alert_logs"] == [] and out["source"] == "none"
    assert "could not be read" in out["note"]


def test_ora_codes_are_counted(monkeypatch):
    import app.services.oracle.oracle_monitoring_service as svc
    rows = [{"MESSAGE_TEXT": "ORA-00600: internal error\n", "INST_ID": 1},
            {"MESSAGE_TEXT": "ORA-00600 again, with ORA-01555", "INST_ID": 2},
            {"MESSAGE_TEXT": "TNS-12535: timed out", "INST_ID": 1}]
    first = {"done": False}

    def reply(engine, sql, params=None):
        if not first["done"]:
            first["done"] = True
            return rows
        return []
    monkeypatch.setattr(svc, "_rows", reply)
    monkeypatch.setattr(svc, "_rows_long", reply)
    monkeypatch.setattr(svc, "_get_conn_or_404", lambda cid, db: object())
    monkeypatch.setattr(svc, "_get_engine", lambda conn: object())
    out = svc.oracle_error_logs(1, None)
    assert out["code_counts"] == {"ORA-00600": 2, "ORA-01555": 1, "TNS-12535": 1}
    assert out["alert_logs"][0]["message_text"] == "ORA-00600: internal error", "trailing newline stripped"


def test_the_window_is_clamped(monkeypatch):
    import app.services.oracle.oracle_monitoring_service as svc
    rec = _Recorder()
    monkeypatch.setattr(svc, "_rows", rec)
    monkeypatch.setattr(svc, "_rows_long", rec)
    monkeypatch.setattr(svc, "_get_conn_or_404", lambda cid, db: object())
    monkeypatch.setattr(svc, "_get_engine", lambda conn: object())
    assert svc.oracle_error_logs(1, None, 99999)["window_hours"] == 720


# ── RMAN job window ───────────────────────────────────────────────────────

def _job(key, start, typ="ARCHIVELOG", status="COMPLETED", age=1.0):
    return {"session_key": key, "start_time": start, "input_type": typ,
            "status": status, "age_hours": age, "end_time": start}


def test_an_old_full_backup_is_merged_back_in():
    """A week of half-hourly archivelog jobs used to push the weekly full out of
    a 100-row list — and the page then said no database backup existed."""
    window = [_job(i, f"2026-10-13 {i % 24:02d}:00:00") for i in range(100, 150)]
    anchors = [_job(7, "2026-10-01 01:00:00", "DB FULL", age=290.0)]
    merged = merge_anchor_jobs(window, anchors)
    assert any(j["input_type"] == "DB FULL" for j in merged)
    assert merged[-1]["session_key"] == 7, "still in date order — oldest last"


def test_an_anchor_already_in_the_window_is_not_duplicated():
    window = [_job(5, "2026-10-12 01:00:00", "DB FULL")]
    merged = merge_anchor_jobs(window, [_job(5, "2026-10-12 01:00:00", "DB FULL")])
    assert [j["session_key"] for j in merged] == [5]


def test_rman_history_is_windowed_like_backup_sql():
    import inspect
    from app.services.oracle import oracle_rman_service as rman
    src = inspect.getsource(rman._jobs)
    assert "start_time > SYSDATE - :days" in src
    assert "FETCH FIRST 100 ROWS ONLY" not in src
    anchor_src = inspect.getsource(rman._anchor_jobs)
    assert "'DB FULL', 'DB INCR', 'ARCHIVELOG'" in anchor_src
    assert "ROW_NUMBER() OVER (PARTITION BY input_type" in anchor_src


def test_alert_log_reads_get_a_longer_timeout_than_the_interactive_cap():
    """v$diag_alert_ext parses XML; the 25s agent cap cut it off mid-read."""
    import inspect
    import app.services.oracle.oracle_monitoring_service as svc
    src = inspect.getsource(svc.oracle_error_logs)
    assert src.count("_rows_long(") == 2
    assert "timeout=timeout" in inspect.getsource(svc._rows_long)


def test_the_payload_names_the_db_user_for_the_grant(monkeypatch):
    import app.services.oracle.oracle_monitoring_service as svc

    class C:
        username = "ITC"

    def fail(*a, **k):
        raise RuntimeError("ORA-00942: table or view does not exist")
    monkeypatch.setattr(svc, "_rows", fail)
    monkeypatch.setattr(svc, "_rows_long", fail)
    monkeypatch.setattr(svc, "_get_conn_or_404", lambda cid, db: C())
    monkeypatch.setattr(svc, "_get_engine", lambda conn: object())
    out = svc.oracle_error_logs(1, None)
    assert out["db_user"] == "ITC"
    assert any("ORA-00942" in e for e in out["errors"]), "the real error must reach the page"


def test_stuck_sessions_exclude_background_idle_waits(monkeypatch):
    """Background processes are always ACTIVE and always waiting — on Idle
    events. They are not stuck, and the list must not be made of them."""
    import app.services.oracle.oracle_monitoring_service as svc
    rec = _Recorder()
    monkeypatch.setattr(svc, "_rows", rec)
    monkeypatch.setattr(svc, "_rows_long", _Recorder())
    monkeypatch.setattr(svc, "_get_conn_or_404", lambda cid, db: object())
    monkeypatch.setattr(svc, "_get_engine", lambda conn: object())
    svc.oracle_error_logs(1, None)
    stuck = next(q for q in rec.sql if "from v$session" in q.lower())
    assert "type = 'user'" in stuck.lower()
    assert "wait_class <> 'idle'" in stuck.lower()
