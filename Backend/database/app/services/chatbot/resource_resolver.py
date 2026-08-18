"""
ActMon AI — resource resolution with disambiguation.

Replaces `health_tool.find_connection()`'s silent-first-match substring search.
That function returns whichever connection happens to match first in DB
iteration order when two names overlap, and falls back to the frontend
widget's currently-open connection when nothing matches at all — the exact
"never guess" rule the Phase 1 analysis flags as a defect. This module
searches the right table for the requested module (database connection /
infra host / alert rule), and always distinguishes three outcomes so the
caller can ask rather than pick:

  resolved   — exactly one match (or resource_hint was empty but page_context
               supplied one — only wired in for non-conceptual categories by
               the caller, this module doesn't know about categories)
  ambiguous  — 2+ matches, returned as candidates for the caller to list
  not_found  — no match at all
"""
import re

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.connection_model import ConnectionMaster
from app.models.os_server_model import OsServer
from app.models.alert_rule_model import AlertRule


def _tokens(text: str) -> list:
    return [t for t in re.split(r"[^a-z0-9]+", (text or "").lower()) if len(t) >= 3]


def _score_match(hint_l: str, hint_tokens: list, candidate_fields: list) -> int:
    """0 = no match, 1 = weak token overlap, 2 = strong substring match.
    Fields shorter than 3 chars are skipped for the substring check — a raw
    numeric id like "1" is a substring of almost any hint that happens to
    contain that digit (e.g. "Server1"), which produced false-positive
    ambiguous matches when a row's own id was fed into this same check."""
    best = 0
    for field in candidate_fields:
        if not field:
            continue
        field_l = str(field).lower()
        if len(field_l) >= 3 and len(hint_l) >= 3 and (field_l in hint_l or hint_l in field_l):
            best = max(best, 2)
            continue
        for tok in hint_tokens:
            if tok in field_l:
                best = max(best, 1)
    return best


def _id_only(hint_tokens: list):
    """A hint that, once tokenized, is nothing but a single number — e.g. the
    user said "connection 42" or just "42". Matched by exact equality against
    a row's id, never by substring (see _score_match's docstring)."""
    if len(hint_tokens) == 1 and hint_tokens[0].isdigit():
        return hint_tokens[0]
    return None


def _result(outcome: str, resource=None, candidates=None):
    return {"outcome": outcome, "resource": resource, "candidates": candidates or []}


def resolve(db: Session, org_id, resource_hint, module: str, engine=None, page_context: dict = None) -> dict:
    hint = (resource_hint or "").strip()
    if not hint and page_context:
        # Only usable as a fallback when the caller has already decided the
        # category needs a resource and none was named — a conceptual
        # question never reaches this function with page_context as a crutch.
        if module == "database" and page_context.get("connection_id"):
            row = db.query(ConnectionMaster).filter(ConnectionMaster.id == page_context["connection_id"]).first()
            return _result("resolved", _serialize(row, "database")) if row else _result("not_found")
        if module == "infra" and page_context.get("server_id"):
            row = db.query(OsServer).filter(OsServer.id == page_context["server_id"]).first()
            return _result("resolved", _serialize(row, "infra")) if row else _result("not_found")

    # No specific name was given at all — e.g. "mysql", "tell me mysql health",
    # "how is postgres doing" — but the classifier still extracted an ENGINE.
    # This is the common single-word/short follow-up shape and must not fall
    # through to "ask which connection", or a bare engine name loops forever:
    # resolve directly against every connection of that engine — one match
    # resolves, several are ambiguous (ask which), zero is a clear not_found
    # ("no MySQL connection configured"), same three-way contract as a named hint.
    if not hint and engine and module == "database":
        # "mysql" must also match a row stored as "mariadb" — the classifier's
        # engine enum has no separate mariadb value, but the connections table
        # does (same equivalence health_tool.get_live_health already applies).
        engine_l = engine.lower()
        match_types = ("mysql", "mariadb") if engine_l in ("mysql", "mariadb") else (engine_l,)
        q = db.query(ConnectionMaster).filter(func.lower(ConnectionMaster.db_type).in_(match_types))
        if org_id is not None:
            q = q.filter(ConnectionMaster.org_id == org_id)
        rows = q.all()
        if not rows:
            return _result("not_found")
        if len(rows) == 1:
            return _result("resolved", _serialize(rows[0], module))
        return _result("ambiguous", candidates=[_serialize(r, module) for r in rows[:8]])

    if not hint:
        return _result("not_found")

    hint_l = hint.lower()
    hint_tokens = _tokens(hint)
    id_only = _id_only(hint_tokens)

    if module == "database":
        q = db.query(ConnectionMaster)
        if org_id is not None:
            q = q.filter(ConnectionMaster.org_id == org_id)
        rows = q.all()
        if id_only:
            row = next((r for r in rows if str(r.id) == id_only), None)
            if row:
                return _result("resolved", _serialize(row, module))
        if engine:
            rows = [r for r in rows if (r.db_type or "").lower() == engine.lower()] or rows
        scored = [(r, _score_match(hint_l, hint_tokens, [r.connection_name, r.host, r.database_name])) for r in rows]
        return _pick(scored, module)

    if module == "infra":
        q = db.query(OsServer)
        if org_id is not None:
            q = q.filter(OsServer.org_id == org_id)
        rows = q.all()
        if id_only:
            row = next((r for r in rows if str(r.id) == id_only), None)
            if row:
                return _result("resolved", _serialize(row, module))
        scored = [(r, _score_match(hint_l, hint_tokens, [r.server_name, r.hostname, r.ip_address])) for r in rows]
        return _pick(scored, module)

    if module == "alerts":
        q = db.query(AlertRule)
        if org_id is not None:
            q = q.filter(AlertRule.org_id == org_id)
        rows = q.all()
        if id_only:
            row = next((r for r in rows if str(r.id) == id_only), None)
            if row:
                return _result("resolved", _serialize(row, module))
        scored = [(r, _score_match(hint_l, hint_tokens, [r.name, r.metric])) for r in rows]
        return _pick(scored, module)

    return _result("not_found")


def _pick(scored: list, module: str) -> dict:
    strong = [r for r, s in scored if s == 2]
    weak = [r for r, s in scored if s == 1]
    matches = strong or weak
    if not matches:
        return _result("not_found")
    if len(matches) == 1:
        return _result("resolved", _serialize(matches[0], module))
    return _result("ambiguous", candidates=[_serialize(r, module) for r in matches[:8]])


def _serialize(row, module: str) -> dict:
    if module == "database":
        return {"id": row.id, "name": row.connection_name, "db_type": row.db_type, "host": row.host}
    if module == "infra":
        return {"id": row.id, "name": row.server_name, "hostname": row.hostname, "ip_address": row.ip_address}
    if module == "alerts":
        return {"id": row.id, "name": row.name, "metric": row.metric, "severity": row.severity}
    return {"id": getattr(row, "id", None)}
