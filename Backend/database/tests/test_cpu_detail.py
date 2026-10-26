"""CPU detail collection (CPU Performance page): parsers for the additive Linux/Windows collector sections.
Linux fixture = real (anonymised) output of the bundle on a 2-vCPU host; Windows sample mirrors the collector JSON."""
import json
from pathlib import Path

from app.services.os_server import infra_detail_service as m

FIX = Path(__file__).with_name("fixtures_linux_cpu.txt").read_text()


def test_linux_cpu_detail_from_real_sample():
    d = m.parse_linux(FIX)
    cd = d["cpu_detail"]
    assert cd["model"] == "AMD EPYC 7763 64-Core Processor"
    assert cd["logical"] == 2 and cd["physical_cores"] == 1 and cd["sockets"] == 1
    assert [c["id"] for c in cd["per_core"]] == [0, 1]
    assert all(0 <= c["pct"] <= 100 for c in cd["per_core"])
    split = cd["user_pct"] + cd["system_pct"] + cd["iowait_pct"] + cd["irq_pct"] + cd["steal_pct"] + cd["idle_pct"]
    assert 99 <= split <= 101                        # the time split covers the whole interval
    assert cd["context_switches_per_s"] > 0 and cd["interrupts_per_s"] > 0
    assert cd["max_mhz"] is None                     # lscpu on this VM reports no MHz: N/A, not guessed
    assert d["processes"][0]["threads"] == 10 and d["processes"][0]["running_s"] == 377


def test_linux_without_new_sections_is_unchanged():
    d = m.parse_linux("@@PROCS@@\n 12 root 5.0 1.0 sshd\n@@END@@\n")
    assert d["cpu_detail"] is None
    assert d["processes"] == [{"pid": "12", "user": "root", "cpu": 5, "mem": 1, "command": "sshd"}]


def test_cpux_rates_and_per_core():
    raw = ("cpu  100 0 50 800 50 0 0 0\ncpu0 50 0 25 400 25 0 0 0\ncpu1 50 0 25 400 25 0 0 0\nctxt 1000\nintr 500\nprocs_running 2\n--\n"
           "cpu  160 0 70 860 60 0 0 0\ncpu0 100 0 35 410 30 0 0 0\ncpu1 60 0 35 450 30 0 0 0\nctxt 2000\nintr 800\nprocs_running 3\n")
    cd = m._parse_cpux(raw)
    assert cd["user_pct"] == 40.0 and cd["system_pct"] == 13.3 and cd["idle_pct"] == 40.0 and cd["iowait_pct"] == 6.7
    assert cd["per_core"] == [{"id": 0, "pct": 80.0}, {"id": 1, "pct": 26.7}]   # (75-15)/75, (75-55)/75
    assert cd["context_switches_per_s"] == 2000.0 and cd["interrupts_per_s"] == 600.0 and cd["runnable_tasks"] == 3


def test_windows_cpu_detail_and_old_agents():
    payload = {
        "system": {"os": "Windows Server 2019"}, "cpu_pct": 22.4, "memory": {"total_mb": 32000},
        "processes": [{"pid": "4820", "user": "", "cpu": 48.2, "mem": 10.1, "command": "sqlservr", "threads": 24, "instances": 1}],
        "cpu_info": {"model": "Intel(R) Xeon(R) Gold 6248R CPU @ 3.00GHz", "max_mhz": 2993, "sockets": 1, "physical_cores": 8, "logical": 16},
        "cpu_counters": [
            {"path": "\\\\h\\processor(0)\\% processor time", "inst": "0", "v": 50.5},
            {"path": "\\\\h\\processor(1)\\% processor time", "inst": "1", "v": 10},
            {"path": "\\\\h\\processor(_total)\\% processor time", "inst": "_total", "v": 30.2},
            {"path": "\\\\h\\processor(_total)\\% privileged time", "inst": "_total", "v": 6.1},
            {"path": "\\\\h\\processor(_total)\\% user time", "inst": "_total", "v": 14.2},
            {"path": "\\\\h\\system\\context switches/sec", "inst": "", "v": 12432},
            {"path": "\\\\h\\processor(_total)\\dpcs queued/sec", "inst": "_total", "v": 3512},
        ],
    }
    d = m.parse_windows(json.dumps(payload))
    cd = d["cpu_detail"]
    assert cd["logical"] == 16 and cd["physical_cores"] == 8 and cd["max_mhz"] == 2993
    assert cd["per_core"] == [{"id": "0", "pct": 50.5}, {"id": "1", "pct": 10.0}]     # _Total is not a core
    assert cd["privileged_pct"] == 6.1 and cd["user_pct"] == 14.2
    assert cd["context_switches_per_s"] == 12432 and cd["dpcs_per_s"] == 3512 and cd["interrupts_per_s"] is None
    assert "cpu_info" not in d and "cpu_counters" not in d
    old = dict(payload); old.pop("cpu_info"); old.pop("cpu_counters")
    assert m.parse_windows(json.dumps(old))["cpu_detail"] is None                     # agents on the old script
