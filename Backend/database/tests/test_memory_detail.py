"""Memory pages: collector parsers (real Linux/Windows output, anonymised) and the pure event/duration logic."""
import json
from pathlib import Path

from app.services.os_server import infra_detail_service as m
from app.services.os_server import memory_service as ms

NL = chr(10)
LINUX = Path(__file__).with_name("fixtures_linux_mem.txt").read_text()


def test_linux_mem_detail_real_sample():
    sec = m._split_sections(LINUX)
    md = m._linux_mem_detail(sec)
    assert md["total_bytes"] == 8128888 * 1024
    assert md["used_bytes"] == md["total_bytes"] - md["available_bytes"]
    assert md["used_pct"] == round(100 * md["used_bytes"] / md["total_bytes"], 1)
    assert md["committed_bytes"] > md["commit_limit_bytes"]          # normal under heuristic overcommit …
    assert md["pressure_score"] == md["used_pct"]                    # … so it is NOT counted as pressure there
    assert md["psi_some_avg10"] == 0.0 and md["overcommit_mode"] == 0
    assert md["page_faults_ps"] == (37076174894 - 37076174563) / 0.5
    procs = m._linux_mem_procs(sec["PROCMEM"], md["total_bytes"])
    assert procs[0]["name"] == "llama-server" and procs[0]["ws_bytes"] == 2678992 * 1024
    assert procs[0]["peak_ws_bytes"] == 2680608 * 1024 and procs[0]["private_bytes"] == 2675708 * 1024
    assert procs[0]["status"] == "Sleeping" and procs[0]["threads"] == 11


def test_linux_strict_overcommit_counts_commit():
    raw = LINUX.replace("overcommit 0", "overcommit 2")
    md = m._linux_mem_detail(m._split_sections(raw))
    assert md["pressure_score"] == 100.0                             # committed > limit in strict mode = real pressure


def test_linux_without_psi_block_keeps_sections_apart():
    body = [b.strip(NL) for b in m._split_sections(LINUX)["MEMX"].split(NL + "--" + NL)]
    md = m._linux_mem_detail({"MEMX": NL.join([body[0], "--", "--", body[2], "--", body[3]])})   # older kernel: no PSI
    assert md["psi_some_avg10"] is None and md["page_faults_ps"] is not None and md["total_bytes"]


def test_windows_mem_detail_and_breakdown_adds_up():
    GB = 1073741824
    ctr = [{"path": f"\\\\h\\memory\\{k}", "inst": "", "v": v} for k, v in {
        "available bytes": 5 * GB, "committed bytes": 20 * GB, "commit limit": 40 * GB, "pool paged bytes": 1 * GB,
        "pool nonpaged bytes": GB // 2, "page faults/sec": 5000, "pages input/sec": 20, "pages/sec": 30,
        "modified page list bytes": GB // 4, "standby cache normal priority bytes": 2 * GB, "standby cache reserve bytes": GB,
        "standby cache core bytes": 0, "free & zero page list bytes": 2 * GB}.items()]
    payload = {"system": {"os": "Windows Server 2019"}, "memory": {"total_mb": 16384, "available_mb": 5120},
               "processes": [], "cpu_counters": ctr,
               "mem_info": {"pagefile_total_mb": 4096, "pagefile_used_mb": 1024, "pagefile_peak_mb": 2048,
                            "installed_bytes": 17 * GB, "visible_bytes": 16 * GB},
               "mem_procs": [{"pid": 4820, "name": "sqlservr", "ws": 8 * GB, "private": 6 * GB, "peak_ws": 9 * GB, "cpu": 12.4,
                              "threads": 24, "user": "NT SERVICE\\MSSQLSERVER", "start": "2026-10-22T03:42:00Z", "status": "Running"}]}
    d = m.parse_windows(json.dumps(payload))
    md, pr = d["mem_detail"], d["mem_procs"]
    assert md["used_bytes"] == 11 * GB and md["used_pct"] == 68.8
    assert md["cached_bytes"] == 3 * GB and md["hardware_reserved_bytes"] == GB
    assert md["swap_total_bytes"] == 4 * GB and md["swap_used_bytes"] == GB
    assert md["major_faults_ps"] == 20 and md["page_faults_ps"] == 5000
    assert md["pressure_score"] == 68.8                              # max(68.8 scarcity, 50 commit)
    # in use (excl. modified) + modified + standby + free + reserved == installed: no double counting
    in_use = md["total_bytes"] - md["available_bytes"] - md["modified_bytes"]
    avail_rest = md["available_bytes"] - md["cached_bytes"] - md["free_bytes"]
    assert in_use + md["modified_bytes"] + md["cached_bytes"] + md["free_bytes"] + avail_rest + md["hardware_reserved_bytes"] == 17 * GB
    assert pr[0]["mem_pct"] == 50.0 and pr[0]["private_bytes"] == 6 * GB and pr[0]["user"] == "NT SERVICE\\MSSQLSERVER"
    assert d["cpu_detail"] is None or "per_core" in d["cpu_detail"]


def test_old_collectors_have_no_memory_detail():
    assert m.parse_windows(json.dumps({"memory": {"total_mb": 1}, "processes": []}))["mem_detail"] is None
    assert m.parse_linux("@@PROCS@@\n 1 root 0 0 init\n")["mem_detail"] is None


def test_events_hysteresis_and_duration():
    s = [(i * 60000, v) for i, v in enumerate([40, 62, 59, 61, 58, 76, 74, 73, 91, 88, 80, 50, 40])]
    ev = ms.events_from(s)
    assert [e["level"] for e in ev] == ["Warning", "High", "Critical", "Info"]   # 59/61/58 wobble: one Warning only
    assert ev[0]["t"] == 60000 and ev[2]["value"] == 91
    secs, first, last = ms.duration_above(s, 75)
    assert secs == 4 * 60 and first == 5 * 60000                    # 76, 91, 88, 80 count; 74 and 73 (< 75) do not


def test_windows_script_fits_the_command_line():
    """The agent runs the collector as powershell -EncodedCommand; Windows caps a command line at 32,767 characters
    (WinError 206 above it — every cycle then fails). Keep real headroom."""
    import base64
    enc = base64.b64encode(m.WINDOWS_COLLECTOR_PS.encode("utf-16-le"))
    assert len(enc) + len("powershell -NoProfile -NonInteractive -EncodedCommand ") < 31000, len(enc)
