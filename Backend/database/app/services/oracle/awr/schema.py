"""Pydantic data structures for a parsed AWR report.

Ported from the standalone oracle-awr-analyzer project's
app/models/awr_schema.py — the shape is a reasonable, engine-agnostic
representation of the AWR sections that matter for diagnostics (header,
load profile, instance efficiency, top wait events, top SQL), so it is
reused as-is rather than redesigned.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class AWRHeader(BaseModel):
    db_name: str = "UNKNOWN"
    db_id: str | None = None
    instance_name: str | None = None
    instance_number: str | None = None
    host_name: str | None = None
    platform: str | None = None
    begin_snap: str | None = None
    end_snap: str | None = None
    elapsed_minutes: float | None = None


class AWRMetric(BaseModel):
    name: str
    value: float | None = None
    unit: str | None = None
    raw_value: str | None = None
    context: dict[str, Any] = Field(default_factory=dict)


class AWREvent(BaseModel):
    name: str
    waits: float | None = None
    time_seconds: float | None = None
    avg_wait_ms: float | None = None
    percent_db_time: float | None = None
    wait_class: str | None = None
    raw: dict[str, str] = Field(default_factory=dict)


class AWRSQLStat(BaseModel):
    sql_id: str | None = None
    sql_text: str | None = None
    elapsed_time_seconds: float | None = None
    cpu_time_seconds: float | None = None
    executions: float | None = None
    buffer_gets: float | None = None
    disk_reads: float | None = None
    parse_calls: float | None = None
    raw: dict[str, str] = Field(default_factory=dict)


class AWRReport(BaseModel):
    header: AWRHeader = Field(default_factory=AWRHeader)
    load_profile: list[AWRMetric] = Field(default_factory=list)
    instance_efficiency: list[AWRMetric] = Field(default_factory=list)
    top_wait_events: list[AWREvent] = Field(default_factory=list)
    sql_by_elapsed_time: list[AWRSQLStat] = Field(default_factory=list)
    sql_by_cpu_time: list[AWRSQLStat] = Field(default_factory=list)
    raw_sections: dict[str, list[dict[str, str]]] = Field(default_factory=dict)
    parsed_at: datetime = Field(default_factory=datetime.utcnow)


class DiagnosticFinding(BaseModel):
    severity: str
    category: str
    title: str
    evidence: str
    recommendation: str
