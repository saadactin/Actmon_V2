"""
ActMon AI — intent classification.

Replaces `health_tool.detect_health_intent()`'s single 25-keyword boolean flag
(which trips on ANY message containing a word like "health" or "cpu", including
purely conceptual questions) with a real classification step: one small/fast
Groq call that sorts the message into one of the 9 categories the Phase 1
analysis defined, and extracts a module + resource hint so downstream code
knows whether to answer from knowledge, fetch live/historical data, or propose
an action.

Uses `llama-3.1-8b-instant` rather than the 70B model the actual chat answer
uses — classification is a small structured task, and running it on the big
model would double per-turn latency/cost for no accuracy benefit here. Follows
the same prompt-engineered-JSON + json.loads() + graceful-fallback convention
every other Groq call site in this codebase already uses (see
mysql_ai_analysis.py, diagnose_ai_service.py) — no response_format/tool-calling,
since nothing else in this app relies on that.
"""
import json
import logging
import os

log = logging.getLogger("actmon_ai.intent")

CATEGORIES = (
    "conceptual", "current_state", "historical", "analytical",
    "comparison", "recommendation", "config_info", "action", "ambiguous",
)

MODULES = (
    "general", "dashboard", "database", "health", "metrics", "alerts", "logs",
    "slow_query", "cluster_ha", "infra", "agent", "rbac", "config", "cloud",
)

_FALLBACK = {
    "category": "ambiguous",
    "module": "general",
    "engine": None,
    "resource_hint": None,
    "action_hint": None,
}

_SYSTEM = f"""You classify one chat message sent to ActMon AI, a monitoring-platform
assistant. ActMon is NOT a general chatbot and NOT a SQL generator — classify what the
user actually wants so the caller can decide whether to answer from static knowledge,
fetch live/historical monitoring data, or propose a guarded action.

Return ONLY a JSON object, no prose, shaped exactly like:
{{"category": "<one of {", ".join(CATEGORIES)}>",
  "module": "<one of {", ".join(MODULES)}>",
  "engine": "<mysql|postgresql|oracle|mssql|mongodb|clickhouse|null>",
  "resource_hint": "<the specific server/connection/rule name or id mentioned, or null>",
  "action_hint": "<restart_service|kill_process|reboot_host|update_agent|acknowledge_alert|null>"}}

Category definitions:
- conceptual: asks what a TERM or CONCEPT means in general, answerable the same way
  regardless of what's happening right now (e.g. "what is database health?", "what does
  replication lag mean?", "what is CPU utilization?"). The test: would the answer be
  identical yesterday, today, and tomorrow? If yes, it's conceptual.
- current_state: asks about the CURRENT/live state of something — a specific resource
  ("how is PG-Server-1 doing right now?") OR the whole fleet with none named ("how many
  agents are online", "how many databases are monitored", "is the environment healthy",
  "what are the current alerts", "give me a summary of the current environment"). The
  test: would the answer be DIFFERENT depending on what's happening right now? If yes,
  it's current_state (or comparison/analytical/recommendation below), never conceptual —
  do not downgrade a live-state question to conceptual just because no single resource
  was named; a fleet-wide live question still needs module="dashboard" and live data.
- historical: asks about a past time window ("what was CPU yesterday?", "show me last
  week's alerts", "what changed recently" — recent change implies comparing past vs now).
- analytical: asks WHY something is happening / troubleshooting ("why is postgres slow?").
- comparison: asks to compare 2+ resources, INCLUDING "which X is/has the most/least Y"
  with no resource named ("compare CPU across my postgres servers", "which server has
  the highest CPU", "which database is unhealthy", "which database has the highest
  memory usage") — never "ambiguous": "which one" is itself resolvable by ranking live
  data, not a request for clarification.
- recommendation: asks how to fix/improve something, or what to check/investigate
  ("what should I investigate first" — this needs live data to answer well: rank current
  issues, don't just give generic advice), may or may not need live data.
- config_info: asks about configuration/settings, not live monitoring data ("what's my alert
  routing?", "what permissions does the Viewer role have?").
- action: asks to DO something that changes system state (restart, kill, reboot, acknowledge).
- ambiguous: intent or target resource cannot be determined from the message at all (e.g.
  "how's it doing" with no resource named and no fleet-wide framing either) — this is
  for when NEITHER a concept NOR a resource NOR "the whole environment" is identifiable,
  not a catch-all for "no resource was named."

If the message doesn't clearly name a specific server/connection/rule, set resource_hint to null
rather than guessing — the caller will ask the user to clarify. Never invent a resource_hint that
isn't actually in the message.

Module selection — "dashboard" vs a specific module:
- Use "dashboard" for FLEET-WIDE questions with no single named resource: overall
  environment/summary questions ("give me a summary", "is the environment healthy",
  "what should I investigate first"), counts ("how many agents are online", "how many
  databases are monitored"), and comparisons ACROSS many resources ("which server has
  the highest CPU", "which database has the highest memory usage", "which database is
  unhealthy" when no specific one is named). Also use "dashboard" for a question about
  the Dashboard/Monitoring Overview page itself ("what is the Dashboard", "what does the
  Fleet Health widget show").
- Use "database"/"infra"/"agent"/etc. instead of "dashboard" the moment ONE specific
  resource is named or clearly implied ("what is the CPU usage of PostgreSQL server 1",
  "why is PG-Server-1 unhealthy") — resolve and answer for that one resource, not the
  whole fleet.
- A generic conceptual question about a metric or health in general, not tied to the
  Dashboard page specifically ("what does CPU utilization mean", "what is database
  health"), still uses "health"/"metrics"/"general" as before — "dashboard" is for the
  page and the fleet-wide view, not a replacement for those broader concept modules."""


def _client():
    key = os.getenv("GROQ_API_KEY", "")
    if not key:
        return None
    from groq import Groq
    return Groq(api_key=key)


def classify(message: str, history: list = None, context: dict = None) -> dict:
    """Returns a dict shaped like _FALLBACK. Never raises — a missing API key,
    network failure, or malformed model output all fall back to `ambiguous`
    rather than silently defaulting to a data-fetch or an action."""
    client = _client()
    if client is None:
        return dict(_FALLBACK)

    ctx_line = ""
    if context:
        bits = []
        if context.get("db_type"):
            bits.append(f"currently viewing db_type={context['db_type']}")
        if context.get("connection_id"):
            bits.append(f"connection_id={context['connection_id']}")
        if context.get("page"):
            bits.append(f"page={context['page']}")
        if bits:
            ctx_line = "Page context (only use to resolve a resource if the message itself is ambiguous, never override an explicitly named one): " + ", ".join(bits)

    recent = ""
    if history:
        tail = history[-4:]
        recent = "\n".join(f"{h.role if hasattr(h, 'role') else h.get('role')}: {h.content if hasattr(h, 'content') else h.get('content')}" for h in tail)

    user_block = f"{ctx_line}\n\nRecent turns:\n{recent}\n\nMessage to classify: {message}".strip()

    try:
        resp = client.chat.completions.create(
            model="llama-3.1-8b-instant",
            messages=[
                {"role": "system", "content": _SYSTEM},
                {"role": "user", "content": user_block},
            ],
            max_tokens=300,
            temperature=0,
        )
        raw = resp.choices[0].message.content or ""
        start, end = raw.find("{"), raw.rfind("}")
        parsed = json.loads(raw[start:end + 1])
    except Exception as e:
        log.warning("intent classification failed, falling back to ambiguous: %s", e)
        return dict(_FALLBACK)

    category = parsed.get("category")
    if category not in CATEGORIES:
        return dict(_FALLBACK)
    module = parsed.get("module")
    if module not in MODULES:
        module = "general"

    return {
        "category": category,
        "module": module,
        "engine": _clean(parsed.get("engine")),
        "resource_hint": _clean(parsed.get("resource_hint")),
        "action_hint": _clean(parsed.get("action_hint")),
    }


def _clean(value):
    """The 8B model sometimes writes the literal string "null"/"none" instead
    of a real JSON null for an absent field — normalize both that and an
    empty string to Python None so callers never treat "null" as a real hint."""
    if not value or not isinstance(value, str):
        return value or None
    if value.strip().lower() in ("null", "none", "n/a", ""):
        return None
    return value
