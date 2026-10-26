"""
ActMon AI — answer shadow log.

For live-data chat turns, records the answer users actually got (Groq) next to the answer ActMon's own code would
give from the SAME tool result (answer_render.py), so a local answer path can be compared OFFLINE on real
questions. It never changes the streamed answer, never calls a second model, and never raises into the request.

Off unless BOTH are set in the API environment (Backend/database/.env):
    ACTMON_ANSWER_SHADOW=1
    ACTMON_ANSWER_SHADOW_LOG=/u01/actmon-ai/shadow/answer_shadow.jsonl

Recorded per turn: UTC time, the message, the route (fleet / active_alerts / alert_history / history / snapshot),
whether the data was available, the shape keys of the tool result (names only, no values), Groq's answer text and
the code-rendered text (both capped). Not recorded: the raw tool result (it can hold SQL text, process lists and
hostnames), user id, org id, token, session id or IP.
"""
import json
import logging
import os
import threading
import time
from datetime import datetime, timezone

log = logging.getLogger("actmon_ai.answer_shadow")

_LOCK = threading.Lock()
_MAX_BYTES = 50 * 1024 * 1024
_MAX_TEXT = 4000


def enabled() -> bool:
    return (os.getenv("ACTMON_ANSWER_SHADOW", "").strip().lower() in ("1", "true", "yes", "on")
            and bool(os.getenv("ACTMON_ANSWER_SHADOW_LOG", "").strip()))


def _shape(result) -> list:
    if not isinstance(result, dict):
        return []
    keys = sorted(result.keys())
    data = result.get("data")
    if isinstance(data, dict):
        keys += ["data." + k for k in sorted(data.keys())]
    elif isinstance(data, list) and data and isinstance(data[0], dict):
        keys += ["data[]." + k for k in sorted(data[0].keys())]
    return keys[:80]


def render_local(route, result, message):
    """(text or None, milliseconds). Never raises."""
    t0 = time.perf_counter()
    try:
        from app.services.chatbot import answer_render
        text = answer_render.render(route, result, message or "")
    except Exception as e:  # noqa: BLE001
        log.debug("answer render failed: %s", e)
        text = None
    return text, round((time.perf_counter() - t0) * 1000, 3)


def record(message, route, result, groq_text) -> None:
    """Append one line. Silent no-op when disabled; swallows every error."""
    if not enabled():
        return
    path = os.getenv("ACTMON_ANSWER_SHADOW_LOG", "").strip()
    try:
        if os.path.exists(path) and os.path.getsize(path) >= _MAX_BYTES:
            return
        local_text, local_ms = render_local(route, result, message)
        row = {
            "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "message": str(message or "")[:1000],
            "route": route,
            "available": bool(isinstance(result, dict) and result.get("available")),
            "shape": _shape(result),
            "groq_answer": str(groq_text or "")[:_MAX_TEXT],
            "local_answer": None if local_text is None else str(local_text)[:_MAX_TEXT],
            "local_ms": local_ms,
        }
        with _LOCK, open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False, default=str) + "\n")
    except Exception as e:  # noqa: BLE001 — the shadow log must never affect a chat turn
        log.debug("answer shadow log skipped: %s", e)
