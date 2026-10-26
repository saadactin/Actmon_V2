"""
Tests for the Oracle RMAN backup decision layer.

Run with:  pytest tests/test_oracle_rman_findings.py -v

`build_findings` and `build_summary` are pure functions of the readings taken
from the V$ views, so the whole "is this instance actually recoverable"
judgement can be exercised without an Oracle instance.

The test that matters most is the first one: a healthy instance must produce
NO findings. A panel that always has something to say is a panel nobody reads,
so every rule here has to stay silent when things are fine.
"""
import pytest

from app.services.oracle.oracle_rman_service import build_findings, build_summary


# ── readings for an instance with nothing wrong with it ────────────────────

HEALTHY_DB = {"log_mode": "ARCHIVELOG", "database_role": "PRIMARY"}
HEALTHY_CONFIG = [
    {"name": "CONTROLFILE AUTOBACKUP", "value": "ON"},
    {"name": "RETENTION POLICY", "value": "TO RECOVERY WINDOW OF 14 DAYS"},
]
HEALTHY_COVERAGE = [
    {"file_num": 1, "tablespace_name": "SYSTEM", "last_backup": "2026-10-08 02:00:00", "age_days": 0.2},
]
NO_UNBACKED_ARCHIVELOGS = {"count": 0, "mb": 0.0, "oldest": ""}
HEALTHY_FRA = {"configured": True, "pct_used": 42.0, "used_gb": 42, "limit_gb": 100, "reclaimable_gb": 10}


def job(input_type="DB FULL", status="COMPLETED", age_hours=6.0, **kw):
    j = {
        "input_type": input_type, "status": status, "age_hours": age_hours,
        "start_time": "2026-10-08 01:00:00", "end_time": "2026-10-08 02:00:00",
        "session_key": 101,
    }
    j.update(kw)
    return j


def healthy(**overrides):
    """Keyword-overridable healthy reading set, so each test changes one thing."""
    args = {
        "db_facts": HEALTHY_DB,
        "jobs": [job(), job("ARCHIVELOG", age_hours=2)],
        "config": HEALTHY_CONFIG,
        "hot_files": [],
        "coverage": HEALTHY_COVERAGE,
        "archivelogs": NO_UNBACKED_ARCHIVELOGS,
        "fra": HEALTHY_FRA,
    }
    args.update(overrides)
    return build_findings(**args)


def titles(findings):
    return [f["title"] for f in findings]


# ── the property the whole panel rests on ──────────────────────────────────

def test_healthy_instance_produces_no_findings():
    assert healthy() == []


def test_healthy_summary_reports_ok():
    jobs = [job(), job("ARCHIVELOG", age_hours=2)]
    s = build_summary(HEALTHY_DB, jobs, [], HEALTHY_COVERAGE,
                      NO_UNBACKED_ARCHIVELOGS, HEALTHY_FRA, [])
    assert s["worst_severity"] == "ok"
    assert s["last_db_backup"] is not None
    assert s["last_archivelog"] is not None
    assert s["failed_7d"] == 0
    assert s["running"] == 0


# ── recovery exposures ─────────────────────────────────────────────────────

def test_noarchivelog_mode_is_critical_and_sorts_first():
    f = healthy(db_facts={"log_mode": "NOARCHIVELOG"})
    assert any("NOARCHIVELOG" in t for t in titles(f))
    assert f[0]["severity"] == "critical"


def test_no_backup_on_record():
    assert any("ever been recorded" in t for t in titles(healthy(jobs=[])))


def test_archivelog_only_backups_are_not_a_database_backup():
    f = healthy(jobs=[job("ARCHIVELOG", age_hours=2)])
    assert any("No completed database backup" in t for t in titles(f))


@pytest.mark.parametrize("age_days,severity", [(9, "high"), (20, "critical")])
def test_stale_database_backup_escalates_with_age(age_days, severity):
    f = healthy(jobs=[job(age_hours=24 * age_days)])
    stale = next(x for x in f if "days old" in x["title"])
    assert stale["severity"] == severity
    assert f"{float(age_days)} days old" in stale["title"]


def test_incrementals_with_no_full_backup():
    assert any("Only incremental" in t for t in titles(healthy(jobs=[job("DB INCR")])))


def test_recent_failure_is_reported():
    f = healthy(jobs=[job(), job(status="FAILED", age_hours=10)])
    assert any("failed in the last 7 days" in t for t in titles(f))


def test_old_failure_is_not_reported_as_recent():
    f = healthy(jobs=[job(), job(status="FAILED", age_hours=24 * 30)])
    assert not any("failed in the last 7 days" in t for t in titles(f))


def test_datafiles_stuck_in_hot_backup_mode():
    f = healthy(hot_files=[{"file_name": "/u01/sys.dbf", "hours_open": 31.5}])
    hot = next(x for x in f if "hot backup mode" in x["title"])
    assert hot["severity"] == "critical"
    assert "/u01/sys.dbf" in hot["evidence"]


def test_datafile_never_backed_up():
    never = HEALTHY_COVERAGE + [
        {"file_num": 7, "tablespace_name": "USERS", "last_backup": "", "age_days": None},
    ]
    f = healthy(coverage=never)
    assert any("never been backed up" in t for t in titles(f))


@pytest.mark.parametrize("count,severity", [(5, "medium"), (120, "high")])
def test_unbacked_archivelogs_scale_with_count(count, severity):
    f = healthy(archivelogs={"count": count, "mb": 10.0, "oldest": "2026-10-01 00:00:00"})
    entry = next(x for x in f if "not yet backed up" in x["title"])
    assert entry["severity"] == severity


def test_stale_archivelog_backup():
    f = healthy(jobs=[job(), job("ARCHIVELOG", age_hours=50)])
    assert any("archivelog backup is 50" in t for t in titles(f))


@pytest.mark.parametrize("pct,severity", [(88.0, "high"), (97.0, "critical")])
def test_full_fra_escalates(pct, severity):
    f = healthy(fra={"configured": True, "pct_used": pct, "used_gb": pct,
                     "limit_gb": 100, "reclaimable_gb": 2})
    entry = next(x for x in f if "Fast Recovery Area" in x["title"])
    assert entry["severity"] == severity


def test_unconfigured_fra_is_not_reported_as_full():
    f = healthy(fra={"configured": False, "pct_used": 0})
    assert not any("Fast Recovery Area" in t for t in titles(f))


# ── the default-means-off trap ─────────────────────────────────────────────

def test_absent_autobackup_row_reads_as_off():
    """v$rman_configuration records only NON-default settings, so no row means
    the default — and the default for controlfile autobackup is OFF. Treating
    the absence as "unknown" would be the comfortable answer and the wrong one."""
    f = healthy(config=[{"name": "RETENTION POLICY", "value": "TO REDUNDANCY 2"}])
    assert any("autobackup is off" in t for t in titles(f))


def test_explicit_autobackup_off_is_caught():
    f = healthy(config=[{"name": "CONTROLFILE AUTOBACKUP", "value": "OFF"},
                        {"name": "RETENTION POLICY", "value": "TO REDUNDANCY 2"}])
    assert any("autobackup is off" in t for t in titles(f))


def test_retention_policy_none():
    f = healthy(config=[{"name": "CONTROLFILE AUTOBACKUP", "value": "ON"},
                        {"name": "RETENTION POLICY", "value": "TO NONE"}])
    assert any("NONE" in t for t in titles(f))


# ── ordering and summary arithmetic ────────────────────────────────────────

def test_findings_come_back_worst_first():
    never = HEALTHY_COVERAGE + [
        {"file_num": 7, "tablespace_name": "USERS", "last_backup": "", "age_days": None},
    ]
    f = build_findings(
        {"log_mode": "NOARCHIVELOG"},
        [job(), job(status="FAILED", age_hours=2)],
        [{"name": "RETENTION POLICY", "value": "TO NONE"}],
        [{"file_name": "/u01/a.dbf", "hours_open": 3}],
        never,
        {"count": 5, "mb": 10.0, "oldest": ""},
        HEALTHY_FRA,
    )
    rank = {"critical": 0, "high": 1, "medium": 2, "low": 3}
    severities = [x["severity"] for x in f]
    assert severities == sorted(severities, key=lambda s: rank[s])


def test_summary_counts_and_picks_the_right_last_backup():
    never = HEALTHY_COVERAGE + [
        {"file_num": 7, "tablespace_name": "USERS", "last_backup": "", "age_days": None},
    ]
    jobs = [job(), job(status="FAILED", age_hours=2), job(status="RUNNING", age_hours=0)]
    s = build_summary({"log_mode": "NOARCHIVELOG"}, jobs,
                      [{"file_name": "/u01/a.dbf", "hours_open": 3}], never,
                      {"count": 5, "mb": 10.0, "oldest": ""}, HEALTHY_FRA,
                      [{"severity": "critical"}])
    assert s["failed_7d"] == 1
    assert s["running"] == 1
    assert s["datafiles"] == 2
    assert s["datafiles_never"] == 1
    assert s["hot_backup_files"] == 1
    assert s["worst_severity"] == "critical"
    # The tile must show a backup that actually completed, not the failed or
    # still-running job that happens to be newer.
    assert s["last_db_backup"]["status"] == "COMPLETED"


# ── a failed read is not a negative finding ────────────────────────────────
#
# These exist because of a real bug. v$rman_backup_job_details was queried with
# an INCREMENTAL_LEVEL column it does not have, the query died with ORA-00904,
# and the panel reported "No RMAN backup has ever been recorded" and
# "Last DB backup: Never" about an instance it had just failed to read.
#
# A monitoring product stating a confident negative about a reading it could
# not take is worse than one that says nothing.

def test_unreadable_jobs_does_not_claim_no_backup_exists():
    f = healthy(jobs=[], unavailable={"jobs"})
    assert not any("ever been recorded" in t for t in titles(f)), \
        "an unread job history must never be reported as 'no backup has ever been recorded'"
    assert any("could not be read" in t for t in titles(f))


def test_unreadable_jobs_suppresses_every_job_derived_rule():
    """Stale-backup, failure-count and archivelog-age rules all read the same
    view. If it did not answer, none of them has a basis."""
    f = healthy(jobs=[], unavailable={"jobs"})
    for phrase in ("days old", "failed in the last 7 days", "Only incremental",
                   "archivelog backup is", "No completed database backup"):
        assert not any(phrase in t for t in titles(f)), f"{phrase!r} fired without a job history"


def test_summary_reports_unknown_not_never_when_jobs_unreadable():
    s = build_summary(HEALTHY_DB, [], [], HEALTHY_COVERAGE,
                      NO_UNBACKED_ARCHIVELOGS, HEALTHY_FRA, [], {"jobs"})
    assert s["available"]["jobs"] is False
    # None is what the UI turns into "Unknown". A populated tile here would be
    # the same lie in a different place.
    assert s["last_db_backup"] is None
    assert s["last_archivelog"] is None


@pytest.mark.parametrize("key,phrase", [
    ("coverage", "per-datafile backup coverage"),
    ("archivelogs", "archivelogs awaiting backup"),
    ("hot_backup", "hot backup mode"),
    ("database", "archivelog mode"),
])
def test_each_unreadable_reading_says_so(key, phrase):
    f = healthy(unavailable={key})
    said = [t for t in titles(f) if "Could not" in t and phrase in t]
    assert said, f"no 'could not read' finding for {key}: {titles(f)}"


def test_unreadable_coverage_does_not_claim_datafiles_are_unprotected():
    never = [{"file_num": 7, "tablespace_name": "USERS", "last_backup": "", "age_days": None}]
    f = healthy(coverage=never, unavailable={"coverage"})
    assert not any("never been backed up" in t for t in titles(f))


def test_unreadable_config_does_not_assume_autobackup_is_off():
    """The default-means-off rule is only sound when the view was read. With no
    reading at all, an empty config list says nothing about autobackup."""
    f = healthy(config=[], unavailable={"config"})
    assert not any("autobackup is off" in t for t in titles(f))


def test_readable_but_empty_config_still_reports_autobackup_off():
    """The counterpart: an empty list from a view that DID answer still means
    every setting is at its default, and that default is OFF."""
    f = healthy(config=[])
    assert any("autobackup is off" in t for t in titles(f))
