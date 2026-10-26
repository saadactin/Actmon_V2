"""CPU history: PROCNOW parsing (current per-process CPU) and the ClickHouse write. Run: pytest tests/test_cpu_history.py"""
from app.services.clickhouse import cpu_history_service as ch
from app.services.os_server import infra_detail_service as inf


def test_procnow_parses_current_cpu_and_drops_exited():
    raw = ("3486623 22.0 clickhouse 22.4  856 2634763 clickhouse-serv\n"
           "2075866 18.0 actmon_b1  3.3   57    6574 uvicorn\n"
           "99 4.0\n"                                   # exited before the ps lookup — no detail
           "1699991 2.0 www-data  0.0    1   42324 nginx: worker process\n")
    rows = inf._parse_procnow(raw)
    assert [r["pid"] for r in rows] == [3486623, 2075866, 1699991]
    assert rows[0] == {"pid": 3486623, "cpu": 22.0, "user": "clickhouse", "mem": 22.4, "threads": 856, "running_s": 2634763, "command": "clickhouse-serv"}
    assert rows[2]["command"] == "nginx: worker process"


def test_bundle_has_procnow_section():
    assert "@@PROCNOW@@" in inf.LINUX_COLLECTOR_BUNDLE and "/proc/[0-9]*/stat" in inf.LINUX_COLLECTOR_BUNDLE


class FakeCli:
    def __init__(self):
        self.inserts = []

    def command(self, sql):
        pass

    def insert(self, table, rows, column_names):
        self.inserts.append((table, rows, column_names))


def test_write_cpu_linux_uses_procs_now_not_lifetime_ps(monkeypatch):
    cli = FakeCli()
    monkeypatch.setattr(ch, "_client", lambda: cli)
    monkeypatch.setattr(ch, "_ready", False)
    parsed = {"system": {"os": "Ubuntu 24.04"}, "load": {"one": 1.0, "five": 1.1, "fifteen": 1.2},
              "cpu_detail": {"busy_pct": 30.0, "user_pct": 20.0, "system_pct": 8.0, "iowait_pct": 1.0, "irq_pct": 0.5,
                             "steal_pct": 0.5, "idle_pct": 70.0, "context_switches_per_s": 1000.0, "interrupts_per_s": 500.0, "runnable_tasks": 3},
              "processes": [{"pid": "1", "cpu": 99, "command": "lifetime-average"}],
              "procs_now": [{"pid": 7, "cpu": 12.5, "user": "oracle", "mem": 1.0, "threads": 4, "running_s": 60, "command": "ora_pmon"}]}
    assert ch.write_cpu(5, parsed) == "ok"
    (ht, hrows, hcols), (pt, prow, pcols) = cli.inserts
    host = dict(zip(hcols, hrows[0]))
    assert ht == ch.HOST_T and host["user_pct"] == 20.0 and host["load5"] == 1.1 and host["runnable"] == 3 and host["platform"] == "linux"
    procs = [dict(zip(pcols, r)) for r in prow]
    assert pt == ch.PROC_T and [p["name"] for p in procs] == ["ora_pmon"] and procs[0]["cpu_pct"] == 12.5


def test_write_cpu_skips_without_cpu_split(monkeypatch):
    monkeypatch.setattr(ch, "_client", lambda: (_ for _ in ()).throw(AssertionError("must not connect")))
    assert ch.write_cpu(5, {"cpu_detail": None}) == "skipped"


# ── on-demand process detail ─────────────────────────────────────────────────
import os as _os
from app.services.os_server import process_detail_service as pd

_FIX = open(_os.path.join(_os.path.dirname(__file__), "fixtures_linux_procdetail.txt"), encoding="utf-8").read()


def test_process_detail_parses_real_proc_output():
    r = pd.parse_linux(_FIX, full=True)
    assert r["exists"] and r["ppid"] == 3486616 and r["exe"] == "/usr/bin/clickhouse" and r["cwd"] == "/"
    assert r["threads"] > 100 and r["cpu_time_s"] > 1000 and r["context_switches"] > 0 and r["start_time_epoch"] > 1.7e9
    kinds = {f["target"]: f["count"] for f in r["open_files"]}
    assert kinds["socket"] > 10 and "pipe" in kinds and r["open_files_count"] >= sum(kinds.values()) - 5


def test_process_detail_without_execute_right_masks_and_hides_files():
    r = pd.parse_linux(_FIX, full=False)
    assert "open_files" not in r and r["open_files_count"] > 0 and r["command_masked"] is True


def test_mask_secrets():
    m = pd.mask_secrets("sqlplus system/Secr3t@ORCL --password=abc mongodb://u:pw@h/db PGPASSWORD token=xyz")
    assert "Secr3t" not in m and "abc" not in m and ":pw@" not in m and "xyz" not in m and "sqlplus system/******@ORCL" in m


def test_pid_is_integer_in_command():
    import pytest
    with pytest.raises(ValueError):
        pd.linux_command("1; rm -rf /")
    assert "/proc/42;" in pd.linux_command(42)


def test_gone_process():
    assert pd.parse_linux("@@GONE@@\n", True) == {"exists": False}


def test_process_cpu_is_share_of_whole_host():
    rows = inf._share_of_host([{"cpu": 200.0}, {"cpu": 50.0}, {"cpu": 410.0}], {"per_core": [{}, {}, {}, {}]})
    assert [r["cpu"] for r in rows] == [50.0, 12.5, 100.0]        # 4 cores: 2 busy cores = 50%, never above 100%
    assert inf._share_of_host([{"cpu": 5}], None) == [{"cpu": 5}]   # no core count: untouched


def test_procnow_new_format_splits_user_kernel_and_parent():
    raw = "2198127 62.0 50.0 12.0       1 actmon_b1   3.1   52    2398 uvicorn\n3486623 48.0 32.0 16.0 3486616 clickhouse 24.6 857 2640849 clickhouse-serv\n"
    rows = inf._share_of_host(inf._parse_procnow(raw), {"per_core": [{}, {}]})
    assert rows[0] == {"pid": 2198127, "cpu": 31.0, "cpu_user": 25.0, "cpu_kernel": 6.0, "ppid": 1, "user": "actmon_b1", "mem": 3.1,
                       "threads": 52, "running_s": 2398, "command": "uvicorn", "cpu_scale": "host"}
    assert rows[1]["ppid"] == 3486616 and rows[1]["cpu_user"] + rows[1]["cpu_kernel"] == rows[1]["cpu"]
