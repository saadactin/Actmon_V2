"""Merge one report's "SQL ordered by …" lists into one row per sql_id.

SQL text is untrusted report content: it is kept only as a short preview for
display. It is never executed, logged, or sent to the LLM.
"""
from __future__ import annotations

import re

from .parser import ProductionAWRParser

_num = ProductionAWRParser._to_float

# section title -> {our field: AWR column key}
_LISTS = {
    "sql ordered by elapsed time": ("elapsed", {"elapsed_s": "elapsed_time_s", "executions": "executions",
                                                 "elapsed_per_exec_s": "elapsed_time_per_exec_s", "pct_db_time": "total",
                                                 "cpu_pct": "cpu", "io_pct": "io"}),
    "sql ordered by cpu time": ("cpu", {"cpu_s": "cpu_time_s", "executions": "executions", "elapsed_s": "elapsed_time_s",
                                         "cpu_pct": "cpu", "io_pct": "io"}),
    "sql ordered by gets": ("gets", {"buffer_gets": "buffer_gets", "gets_per_exec": "gets_per_exec",
                                      "executions": "executions", "elapsed_s": "elapsed_time_s"}),
    "sql ordered by reads": ("reads", {"physical_reads": "physical_reads", "reads_per_exec": "reads_per_exec",
                                        "executions": "executions", "elapsed_s": "elapsed_time_s"}),
    "sql ordered by parse calls": ("parse", {"parse_calls": "parse_calls", "executions": "executions"}),
    "sql ordered by executions": ("execs", {"executions": "executions", "rows_processed": "rows_processed",
                                             "elapsed_s": "elapsed_time_s"}),
    "sql ordered by version count": ("versions", {"version_count": "version_count"}),
}
_SQL_ID = re.compile(r"^[0-9a-z]{13}$")


def _preview(text: str | None) -> str | None:
    if not text:
        return None
    return re.sub(r"\s+", " ", text)[:120]


def sql_profile(parser: ProductionAWRParser) -> dict[str, dict]:
    sections = parser._extract_tables()
    out: dict[str, dict] = {}
    for title, (tag, fields) in _LISTS.items():
        rows = sections.get(title) or []
        for row in rows[:50]:
            sql_id = (row.get("sql_id") or "").strip()
            if not _SQL_ID.match(sql_id):
                continue
            rec = out.setdefault(sql_id, {"sql_id": sql_id, "lists": []})
            if tag not in rec["lists"]:
                rec["lists"].append(tag)
            for field, col in fields.items():
                value = _num(row.get(col))
                if value is not None and rec.get(field) is None:
                    rec[field] = value
            rec.setdefault("module", (row.get("sql_module") or "")[:200] or None)
            if not rec.get("text_preview"):
                rec["text_preview"] = _preview(row.get("sql_text"))
    for rec in out.values():
        if rec.get("elapsed_per_exec_s") is None and rec.get("elapsed_s") and rec.get("executions"):
            rec["elapsed_per_exec_s"] = rec["elapsed_s"] / rec["executions"]
        rec["lists"] = ",".join(rec["lists"])
    return out
