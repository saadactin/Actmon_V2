"""
ActMon AI — intent-classification shadow log.

Records what the production (Groq) intent classifier decided for each chat turn, so a
local classifier can be scored against it OFFLINE on real questions. This module only
appends one JSON line per turn; it never calls a second model, never changes the intent
the route uses, and never raises into the request.

Off unless BOTH are set in the API environment (Backend/database/.env):
    ACTMON_INTENT_SHADOW=1
    ACTMON_INTENT_SHADOW_LOG=/u01/actmon-ai/shadow/intent_shadow.jsonl

Recorded per turn: UTC time, the message, the last 4 history turns (what classify() sees),
the page context, Groq's raw classification, the intent the route went on to use (after
keyword_fallback / timeout fallback), and how long classification took. Not recorded: user
id, org id, token, session id, IP, or any answer text beyond the history classify() sees.
"""
import json
import logging
import os
import threading
from datetime import datetime, timezone

log = logging.getLogger("actmon_ai.intent_shadow")

_LOCK = threading.Lock()
_MAX_BYTES = 50 * 1024 * 1024   # stop appending at 50 MB — a shadow log is a sample, not an archive
_MAX_TEXT = 1000                 # per message / history turn


def enabled() -> bool:
    return (os.getenv("ACTMON_INTENT_SHADOW", "").strip().lower() in ("1", "true", "yes", "on")
            and bool(os.getenv("ACTMON_INTENT_SHADOW_LOG", "").strip()))


def _turns(history) -> list:
    out = []
    for h in (history or [])[-4:]:
        role = h.role if hasattr(h, "role") else (h or {}).get("role")
        content = h.content if hasattr(h, "content") else (h or {}).get("content")
        out.append({"role": str(role or "")[:20], "content": str(content or "")[:_MAX_TEXT]})
    return out


def record(message, history, context, groq_intent, final_intent, classify_ms, timed_out=False) -> None:
    """Append one line. Silent no-op when disabled; swallows every error."""
    if not enabled():
        return
    path = os.getenv("ACTMON_INTENT_SHADOW_LOG", "").strip()
    try:
        if os.path.exists(path) and os.path.getsize(path) >= _MAX_BYTES:
            return
        row = {
            "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "message": str(message or "")[:_MAX_TEXT],
            "history": _turns(history),
            "context": {k: v for k, v in (context or {}).items() if k in ("page", "db_type", "connection_id")},
            "groq": groq_intent,
            "final": final_intent,
            "classify_ms": round(float(classify_ms), 1) if classify_ms is not None else None,
            "timed_out": bool(timed_out),
        }
        line = json.dumps(row, ensure_ascii=False, default=str)
        with _LOCK, open(path, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception as e:  # noqa: BLE001 — the shadow log must never affect a chat turn
        log.debug("intent shadow log skipped: %s", e)
