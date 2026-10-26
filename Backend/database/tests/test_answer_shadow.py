"""Answer shadow log: off by default; when on, the user's streamed answer is byte-identical and one line holds
Groq's answer next to the code-rendered one; never raises. Groq and the tools are faked: no network, no database."""
import json

from app.services.chatbot import answer_render, answer_shadow as sh

FLEET = {"available": True, "as_of": "live", "infra": {"total": 8, "good": 6, "warning": 1, "critical": 1, "health_pct": 75},
         "per_engine": [], "average_resource_usage": {"cpu_avg_pct": 41, "ram_avg_pct": 63, "disk_avg_pct": 57, "hosts_reporting": 7},
         "top_cpu_hosts": [{"host": "app-srv-04", "os_type": "linux", "cpu_pct": 92.0}],
         "active_alerts": {"total": 5, "critical": 2, "warning": 3, "info": 0}}


def test_disabled_by_default(tmp_path, monkeypatch):
    p = tmp_path / "a.jsonl"
    monkeypatch.delenv("ACTMON_ANSWER_SHADOW", raising=False)
    monkeypatch.setenv("ACTMON_ANSWER_SHADOW_LOG", str(p))
    sh.record("q", "fleet", FLEET, "groq text")
    assert not p.exists() and sh.enabled() is False


def test_row_has_both_answers_and_no_raw_values(tmp_path, monkeypatch):
    p = tmp_path / "a.jsonl"
    monkeypatch.setenv("ACTMON_ANSWER_SHADOW", "1")
    monkeypatch.setenv("ACTMON_ANSWER_SHADOW_LOG", str(p))
    secret = {"available": True, "data": {"health_summary": {"connection_usage_pct": 10.0, "current_connections": 3,
              "max_connections": 100, "cache_usage_pct": 99.0}, "process_list": [{"Info": "SELECT * FROM salaries"}]}}
    sh.record("how is db1", "snapshot", secret, "Groq says fine")
    r = json.loads(p.read_text(encoding="utf-8"))
    assert set(r) == {"ts", "message", "route", "available", "shape", "groq_answer", "local_answer", "local_ms"}
    assert r["groq_answer"] == "Groq says fine" and "3 of 100" in r["local_answer"]
    assert "salaries" not in p.read_text(encoding="utf-8")          # raw tool values are never logged
    assert "data.process_list" in r["shape"]                         # only key names


def test_unknown_shape_logs_none_and_broken_path_never_raises(tmp_path, monkeypatch):
    monkeypatch.setenv("ACTMON_ANSWER_SHADOW", "1")
    monkeypatch.setenv("ACTMON_ANSWER_SHADOW_LOG", str(tmp_path / "a.jsonl"))
    sh.record("q", "snapshot", {"available": True, "data": {"foo": 1}}, "x")
    assert json.loads((tmp_path / "a.jsonl").read_text(encoding="utf-8"))["local_answer"] is None
    monkeypatch.setenv("ACTMON_ANSWER_SHADOW_LOG", str(tmp_path / "missing" / "a.jsonl"))
    sh.record("q", "fleet", FLEET, "x")                               # must not raise


def test_render_failure_is_contained(tmp_path, monkeypatch):
    monkeypatch.setenv("ACTMON_ANSWER_SHADOW", "1")
    monkeypatch.setenv("ACTMON_ANSWER_SHADOW_LOG", str(tmp_path / "a.jsonl"))
    monkeypatch.setattr(answer_render, "render", lambda *a, **k: 1 / 0)
    sh.record("q", "fleet", FLEET, "x")
    assert json.loads((tmp_path / "a.jsonl").read_text(encoding="utf-8"))["local_answer"] is None


# ── the route ──────────────────────────────────────────────────────────────────────────

class _Q:
    def filter(self, *a, **k):
        return self

    def all(self):
        return []


class _DB:
    def query(self, *a, **k):
        return _Q()


def _chat(monkeypatch, message="check system health"):
    import asyncio
    from app.routes.chatbot import chatbot_routes as cr
    intent = {"category": "current_state", "module": "dashboard", "engine": None, "resource_hint": None, "action_hint": None}
    monkeypatch.setattr(cr.intent_service, "classify", lambda m, h, c: dict(intent))
    monkeypatch.setattr(cr.tools, "fleet_dashboard", lambda *a, **k: FLEET)

    def fake_stream(messages):
        for t in ("8 hosts, ", "6 healthy."):
            yield "data: " + json.dumps({"type": "token", "text": t}) + "\n\n"
        yield "data: " + json.dumps({"type": "done", "suggestions": [], "actions": []}) + "\n\n"
    monkeypatch.setattr(cr, "stream_chat", fake_stream)
    resp = asyncio.run(cr.chat_stream(cr.ChatRequest(message=message, history=[], context={}), db=_DB(), ctx={"org_id": 1}))

    async def body():
        return b"".join([c if isinstance(c, bytes) else c.encode() async for c in resp.body_iterator])
    return asyncio.run(body()).decode()


def test_route_answer_is_identical_and_both_answers_are_logged(tmp_path, monkeypatch):
    p = tmp_path / "a.jsonl"
    monkeypatch.delenv("ACTMON_INTENT_SHADOW", raising=False)
    monkeypatch.delenv("ACTMON_ANSWER_SHADOW", raising=False)
    off = _chat(monkeypatch)
    monkeypatch.setenv("ACTMON_ANSWER_SHADOW", "1")
    monkeypatch.setenv("ACTMON_ANSWER_SHADOW_LOG", str(p))
    on = _chat(monkeypatch)
    assert on == off and "6 healthy." in on                          # user's stream unchanged
    r = json.loads(p.read_text(encoding="utf-8"))
    assert r["route"] == "fleet" and r["groq_answer"] == "8 hosts, 6 healthy."
    assert "8 total" in r["local_answer"] and r["available"] is True


# ── focus: the local answer leads with what the question names (found in real shadow traffic) ──
FLEET_E = {**FLEET, "per_engine": [
    {"engine": "mysql", "total": 1, "good": 1, "warning": 0, "critical": 0, "unknown": 0},
    {"engine": "postgresql", "total": 4, "good": 2, "warning": 0, "critical": 2, "unknown": 0},
    {"engine": "mongodb", "total": 0, "good": 0, "warning": 0, "critical": 0, "unknown": 0}],
    "agents": {"total": 19, "good": 10, "warning": 0, "critical": 9, "unknown": 0}}


def test_focus_on_named_engine_including_follow_up_wording():
    t = answer_render.render("fleet", FLEET_E, "and postgresql")
    assert t.startswith("**PostgreSQL:** 4 database hosts: 2 healthy, 2 critical")
    assert "**Environment overview**" in t                          # the overview still follows
    assert answer_render.render("fleet", FLEET_E, "how many mysql connection we have").startswith("**MySQL:** 1 database host: 1 healthy")
    assert answer_render.render("fleet", FLEET_E, "any mongodb?").startswith("**MongoDB:** no MongoDB database hosts")


def test_replication_on_fleet_says_it_has_no_replication_data():
    t = answer_render.render("fleet", FLEET_E, "Check replication")
    assert t.startswith("**Replication:** the fleet overview has no replication status")


def test_agents_and_alerts_focus_and_plain_question_unchanged():
    assert answer_render.render("fleet", FLEET_E, "how many agents are offline").startswith("**Agents:** 19 total: 10 online, 9 offline")
    assert answer_render.render("fleet", FLEET_E, "any alerts?").startswith("**Active alerts:** 5 (2 critical, 3 warning)")
    assert answer_render.render("fleet", FLEET_E, "check system health").startswith("**Environment overview**")
    assert answer_render.render("fleet", FLEET_E, "top 5 cpu usage server").startswith("**Hosts by CPU usage**")
