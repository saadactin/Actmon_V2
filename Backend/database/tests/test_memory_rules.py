"""Memory recommendation rule catalogue. Run: pytest tests/test_memory_rules.py"""
from app.services.os_server import memory_rules as mr

GB = 1073741824


def base(**cur):
    c = {"n": 100, "first_t": 0, "last_t": 3600_000, "total": 64 * GB, "avail_min": 30 * GB, "avail_avg": 32 * GB,
         "used_max": 50, "used_avg": 45, "pr_max": 40, "pr_avg": 30, "platform": "linux", "cached_avg": 10 * GB,
         "psi_some_avg": 0.0, "psi_some_max": 0.0, "psi_full_max": 0.0, "swapin_avg": 0, "major_avg": 0,
         "swap_total": 8 * GB, "swap_used_max": 0, "commit_max": 20 * GB, "commit_limit": 80 * GB}
    c.update(cur)
    return {"stats": {"current": c, "previous": {"used_avg": c["used_avg"]}}, "threshold": 75.0,
            "above_threshold": {"seconds": 0}, "events": [], "leaks": [], "consumers": []}


def rules(a):
    return [r["rule"] for r in mr.evaluate(a, 60)]


def test_healthy_host_says_so_with_evidence():
    out = mr.evaluate(base(), 60)
    assert [r["rule"] for r in out] == ["MEM-000"] and "minimum available 30.0 GB" in out[0]["evidence"]


def test_low_available_is_critical_below_5_percent_with_commands():
    out = mr.evaluate(base(avail_min=2 * GB), 60)
    r = next(x for x in out if x["rule"] == "MEM-001")
    assert r["severity"] == "Critical" and "3.1% of 64.0 GB" in r["evidence"] and any("MemAvailable" in c for c in r["commands"])
    assert out[0]["rule"] == "MEM-001"          # most severe first


def test_psi_swapin_and_commit():
    a = base(psi_some_avg=12, psi_some_max=30, psi_full_max=11, swapin_avg=150, swapin_max=900, commit_max=79 * GB)
    got = rules(a)
    assert {"MEM-003", "MEM-004", "MEM-007"} <= set(got)
    r = {x["rule"]: x for x in mr.evaluate(a, 60)}
    assert r["MEM-003"]["severity"] == "Critical" and r["MEM-004"]["severity"] == "High" and r["MEM-007"]["severity"] == "Warning"   # Linux: only under strict overcommit


def test_sustained_pressure_and_growth():
    a = base(used_avg=80)
    a["stats"]["previous"]["used_avg"] = 60
    a["above_threshold"]["seconds"] = 3000
    got = rules(a)
    assert "MEM-002" in got and "MEM-008" in got


def test_oracle_dominant_consumer_gets_oracle_guidance():
    a = base()
    a["consumers"] = [{"name": "ora_dbw0_kcdb1", "mem_pct_avg": 62.0, "ws_max": 40 * GB, "instances": 40}, {"name": "java", "mem_pct_avg": 3.0}]
    r = next(x for x in mr.evaluate(a, 60) if x["rule"] == "MEM-009")
    assert r["engine"] == "Oracle Database" and "HugePages" in r["actions"][0] and any("v$sgainfo" in c for c in r["commands"])


def test_windows_uses_windows_rules_and_commands():
    a = base(platform="windows", pages_avg=3000, pages_max=9000, avail_min=3 * GB)
    out = {x["rule"]: x for x in mr.evaluate(a, 60)}
    assert out["MEM-005"]["severity"] == "High" and "MEM-004" not in out
    assert all("Get-" in c for c in out["MEM-001"]["commands"])


def test_cache_false_alarm_is_explained():
    out = mr.evaluate(base(used_max=92, avail_min=16 * GB, cached_avg=30 * GB), 60)
    assert [r["rule"] for r in out] == ["MEM-012"]


def test_catalogue_covers_every_rule():
    assert {c[0] for c in mr.CATALOGUE} == {f"MEM-{i:03d}" for i in range(1, 14)}


def test_oracle_sga_shared_memory_is_recognised():
    a = base(used_avg=88, used_max=92, avail_min=2.4 * GB)
    a["consumers"] = [{"name": n, "mem_pct_avg": 1.2} for n in ("ds_agent", "oracle_73901_dc", "ora_w007_dcdb", "java")]
    out = {x["rule"]: x for x in mr.evaluate(a, 60)}
    r = out["MEM-013"]
    assert "Oracle SGA" in r["condition"] and "HugePages" in r["actions"][1] and any("v$sgainfo" in c for c in r["commands"])
    assert r["severity"] == "Warning"
