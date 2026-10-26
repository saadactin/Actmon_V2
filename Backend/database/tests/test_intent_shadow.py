"""Intent shadow log: off by default, one well-formed line when on, never raises."""
import json

from app.services.chatbot import intent_shadow as sh

GROQ = {"category": "current_state", "module": "database", "engine": "oracle", "resource_hint": "DB1", "action_hint": None}


class Turn:
    def __init__(self, role, content):
        self.role, self.content = role, content


def test_disabled_by_default_writes_nothing(tmp_path, monkeypatch):
    p = tmp_path / "s.jsonl"
    monkeypatch.delenv("ACTMON_INTENT_SHADOW", raising=False)
    monkeypatch.setenv("ACTMON_INTENT_SHADOW_LOG", str(p))
    sh.record("hi", [], {}, GROQ, GROQ, 12.3)
    assert not p.exists()


def test_flag_without_path_is_off(monkeypatch):
    monkeypatch.setenv("ACTMON_INTENT_SHADOW", "1")
    monkeypatch.delenv("ACTMON_INTENT_SHADOW_LOG", raising=False)
    assert sh.enabled() is False
    sh.record("hi", [], {}, GROQ, GROQ, 1.0)   # no error


def test_enabled_appends_one_line_with_only_the_listed_fields(tmp_path, monkeypatch):
    p = tmp_path / "s.jsonl"
    monkeypatch.setenv("ACTMON_INTENT_SHADOW", "1")
    monkeypatch.setenv("ACTMON_INTENT_SHADOW_LOG", str(p))
    hist = [Turn("user", f"t{i}") for i in range(6)]
    ctx = {"page": "/oracle-dashboard/5", "db_type": "oracle", "connection_id": 5, "token": "secret"}
    final = {**GROQ, "category": "historical"}
    sh.record("why is DB1 slow", hist, ctx, GROQ, final, 812.345, timed_out=False)
    sh.record("second", [], None, GROQ, GROQ, None)
    rows = [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines()]
    assert len(rows) == 2
    r = rows[0]
    assert set(r) == {"ts", "message", "history", "context", "groq", "final", "classify_ms", "timed_out"}
    assert r["message"] == "why is DB1 slow"
    assert [h["content"] for h in r["history"]] == ["t2", "t3", "t4", "t5"]   # last 4, as classify() sees
    assert r["context"] == {"page": "/oracle-dashboard/5", "db_type": "oracle", "connection_id": 5}  # no other keys
    assert r["groq"] == GROQ and r["final"]["category"] == "historical"
    assert r["classify_ms"] == 812.3
    assert rows[1]["context"] == {} and rows[1]["classify_ms"] is None


def test_long_text_is_truncated(tmp_path, monkeypatch):
    p = tmp_path / "s.jsonl"
    monkeypatch.setenv("ACTMON_INTENT_SHADOW", "1")
    monkeypatch.setenv("ACTMON_INTENT_SHADOW_LOG", str(p))
    sh.record("x" * 5000, [{"role": "assistant", "content": "y" * 5000}], {}, GROQ, GROQ, 1)
    r = json.loads(p.read_text(encoding="utf-8"))
    assert len(r["message"]) == 1000 and len(r["history"][0]["content"]) == 1000


def test_unwritable_path_never_raises(tmp_path, monkeypatch):
    monkeypatch.setenv("ACTMON_INTENT_SHADOW", "1")
    monkeypatch.setenv("ACTMON_INTENT_SHADOW_LOG", str(tmp_path / "no_such_dir" / "s.jsonl"))
    sh.record("hi", [], {}, GROQ, GROQ, 1.0)   # must not raise


def test_stops_at_size_cap(tmp_path, monkeypatch):
    p = tmp_path / "s.jsonl"
    p.write_text("x\n", encoding="utf-8")
    monkeypatch.setenv("ACTMON_INTENT_SHADOW", "1")
    monkeypatch.setenv("ACTMON_INTENT_SHADOW_LOG", str(p))
    monkeypatch.setattr(sh, "_MAX_BYTES", 1)
    sh.record("hi", [], {}, GROQ, GROQ, 1.0)
    assert p.read_text(encoding="utf-8") == "x\n"


# ── the route: the shadow log never changes what the user gets ──────────────────────

class _FakeQuery:
    def filter(self, *a, **k):
        return self

    def all(self):
        return []


class _FakeDB:
    def query(self, *a, **k):
        return _FakeQuery()


def _run_chat(monkeypatch, classify, message="hmm"):
    import asyncio
    from app.routes.chatbot import chatbot_routes as cr

    monkeypatch.setattr(cr.intent_service, "classify", classify)
    payload = cr.ChatRequest(message=message, history=[], context={"page": "/dashboard"})
    resp = asyncio.run(cr.chat_stream(payload, db=_FakeDB(), ctx={"org_id": 1}))

    async def body():
        return b"".join([c if isinstance(c, bytes) else c.encode() async for c in resp.body_iterator])
    return asyncio.run(body()).decode()


def test_route_logs_groq_and_final_intent_and_reply_is_unchanged(tmp_path, monkeypatch):
    p = tmp_path / "s.jsonl"
    amb = {"category": "ambiguous", "module": "general", "engine": None, "resource_hint": None, "action_hint": None}
    monkeypatch.delenv("ACTMON_INTENT_SHADOW", raising=False)
    off = _run_chat(monkeypatch, lambda m, h, c: dict(amb))
    monkeypatch.setenv("ACTMON_INTENT_SHADOW", "1")
    monkeypatch.setenv("ACTMON_INTENT_SHADOW_LOG", str(p))
    on = _run_chat(monkeypatch, lambda m, h, c: dict(amb))
    assert on == off and '"type": "clarify"' in on          # same reply with the log on or off
    row = json.loads(p.read_text(encoding="utf-8"))
    assert row["message"] == "hmm" and row["groq"] == amb and row["final"] == amb
    assert row["context"] == {"page": "/dashboard"} and row["timed_out"] is False and row["classify_ms"] >= 0


def test_route_records_the_keyword_fallback_as_final(tmp_path, monkeypatch):
    p = tmp_path / "s.jsonl"
    monkeypatch.setenv("ACTMON_INTENT_SHADOW", "1")
    monkeypatch.setenv("ACTMON_INTENT_SHADOW_LOG", str(p))
    amb = {"category": "ambiguous", "module": "general", "engine": None, "resource_hint": None, "action_hint": None}
    from app.routes.chatbot import chatbot_routes as cr
    # Stop right after the log line: the dashboard branch would call tools/Groq.
    monkeypatch.setattr(cr.tools, "fleet_dashboard", lambda *a, **k: {"available": False, "reason": "test"})
    monkeypatch.setattr(cr, "_llm_stream", lambda messages, shadow=None: cr._sse_stream({"type": "done", "suggestions": [], "actions": []}))
    _run_chat(monkeypatch, lambda m, h, c: dict(amb), message="mysql health")
    row = json.loads(p.read_text(encoding="utf-8"))
    assert row["groq"]["category"] == "ambiguous"
    assert row["final"]["category"] == "current_state" and row["final"]["engine"] == "mysql"   # keyword_fallback's upgrade


def test_route_survives_a_broken_log_path(tmp_path, monkeypatch):
    amb = {"category": "ambiguous", "module": "general", "engine": None, "resource_hint": None, "action_hint": None}
    monkeypatch.setenv("ACTMON_INTENT_SHADOW", "1")
    monkeypatch.setenv("ACTMON_INTENT_SHADOW_LOG", str(tmp_path / "missing" / "s.jsonl"))
    assert '"type": "clarify"' in _run_chat(monkeypatch, lambda m, h, c: dict(amb))


def test_route_marks_a_classifier_timeout(tmp_path, monkeypatch):
    import time
    p = tmp_path / "s.jsonl"
    monkeypatch.setenv("ACTMON_INTENT_SHADOW", "1")
    monkeypatch.setenv("ACTMON_INTENT_SHADOW_LOG", str(p))
    from app.routes.chatbot import chatbot_routes as cr
    monkeypatch.setattr(cr, "_INTENT_TIMEOUT", 0.2)
    out = _run_chat(monkeypatch, lambda m, h, c: time.sleep(1.0) or {}, message="hmm")
    row = json.loads(p.read_text(encoding="utf-8"))
    assert row["timed_out"] is True and row["groq"]["category"] == "ambiguous"
    assert '"type": "clarify"' in out
