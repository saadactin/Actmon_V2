"""Account report builder: saved templates, report history, schedules.

The account Reports tab builds a report from a request (scope, sections,
period, layout). These three tables let that request be kept and repeated:

* **Templates** are named requests without an account, so "Security audit"
  means the same thing on every account. Built-in presets live in code
  (`report_templates.BUILTIN_TEMPLATES`) and are never stored or editable.
* **History** keeps every generated file with the request that produced it
  and a snapshot of its executive summary -- the snapshot is what "Since the
  last report" compares against, so a comparison never re-reads data that has
  since changed.
* **Schedules** produce a report on a weekly or monthly cadence and e-mail it.

The schedule rules are the client-report scheduler's, learned from the
2026-09-17 e-mail storm (a send succeeded, the bookkeeping after it failed,
and the row stayed due -- one e-mail a minute):

* created **disabled**; nothing e-mails until an operator turns it on;
* the report row, the queued e-mail and the schedule's advance are ONE
  transaction;
* a partial unique index on (schedule_id, run_key) WHERE trigger='schedule'
  makes a second report for the same run impossible, whatever the
  bookkeeping does;
* after downtime only the most recent missed run is produced.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timezone

from sqlalchemy import (
    Boolean, Date, DateTime, ForeignKey, Index, Integer, LargeBinary, String, Text, text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

REPORT_GENERATED = "GENERATED"
REPORT_FAILED = "FAILED"

TRIGGER_MANUAL = "manual"
TRIGGER_SCHEDULE = "schedule"

FREQ_WEEKLY = "weekly"
FREQ_MONTHLY = "monthly"
FREQUENCIES = (FREQ_WEEKLY, FREQ_MONTHLY)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value) -> str | None:
    return value.isoformat() if value is not None else None


class CloudReportTemplate(Base):
    """A saved report request, without an account or hand-picked resources."""

    __tablename__ = "cloud_report_templates"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    # {scope:{mode,filters}, sections, date_range:{preset,timezone,start,end}, layout}
    config: Mapped[dict] = mapped_column(JSONB, nullable=False)
    created_by: Mapped[str | None] = mapped_column(String(256), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)

    __table_args__ = (
        Index("uq_cloud_report_templates_name_ci", text("lower(name)"), unique=True),
    )

    def to_dict(self) -> dict:
        return {"id": str(self.id), "name": self.name, "description": self.description,
                "config": self.config, "builtin": False, "created_by": self.created_by,
                "created_at": _iso(self.created_at), "updated_at": _iso(self.updated_at)}


class CloudAccountReportSchedule(Base):
    __tablename__ = "cloud_account_report_schedules"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    account_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cloud_accounts.id", ondelete="CASCADE"),
        nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    frequency: Mapped[str] = mapped_column(String(16), nullable=False, default=FREQ_MONTHLY)
    day_of_week: Mapped[int | None] = mapped_column(Integer, nullable=True)    # 0 = Monday
    day_of_month: Mapped[int | None] = mapped_column(Integer, nullable=True)   # 1..28
    send_time: Mapped[str] = mapped_column(String(5), nullable=False, default="09:00")
    timezone: Mapped[str] = mapped_column(String(64), nullable=False, default="Asia/Kolkata")
    # The request it runs, frozen when saved -- editing a template later does
    # not silently change what a schedule sends.
    config: Mapped[dict] = mapped_column(JSONB, nullable=False)
    template_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    recipients: Mapped[dict | None] = mapped_column(JSONB, nullable=True)   # {to,cc,bcc}

    next_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_status: Mapped[str | None] = mapped_column(String(40), nullable=True)
    last_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    last_report_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    updated_by: Mapped[str | None] = mapped_column(String(256), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)

    __table_args__ = (
        Index("ix_account_report_schedule_due", "enabled", "next_run_at"),
    )

    def to_dict(self) -> dict:
        return {
            "id": str(self.id), "account_id": str(self.account_id), "name": self.name,
            "enabled": self.enabled, "frequency": self.frequency,
            "day_of_week": self.day_of_week, "day_of_month": self.day_of_month,
            "send_time": self.send_time, "timezone": self.timezone, "config": self.config,
            "template_name": self.template_name,
            "recipients": self.recipients or {"to": [], "cc": [], "bcc": []},
            "next_run_at": _iso(self.next_run_at), "last_run_at": _iso(self.last_run_at),
            "last_status": self.last_status, "last_message": self.last_message,
            "last_report_id": str(self.last_report_id) if self.last_report_id else None,
            "updated_by": self.updated_by, "created_at": _iso(self.created_at),
            "updated_at": _iso(self.updated_at),
        }


class CloudAccountReport(Base):
    """One generated report: the file, what produced it, and its summary."""

    __tablename__ = "cloud_account_reports"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    account_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cloud_accounts.id", ondelete="CASCADE"),
        nullable=False, index=True)
    # Not foreign keys: a report outlives the schedule or template that made it.
    schedule_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    run_key: Mapped[str | None] = mapped_column(String(32), nullable=True)
    template_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    title: Mapped[str | None] = mapped_column(String(255), nullable=True)
    trigger: Mapped[str] = mapped_column(String(16), nullable=False, default=TRIGGER_MANUAL)
    requested_by: Mapped[str | None] = mapped_column(String(256), nullable=True)

    status: Mapped[str] = mapped_column(String(16), nullable=False, default=REPORT_GENERATED)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    format: Mapped[str] = mapped_column(String(8), nullable=False)
    filename: Mapped[str | None] = mapped_column(String(255), nullable=True)
    content_type: Mapped[str | None] = mapped_column(String(120), nullable=True)
    # Deferred: listing history must never pull every file into memory.
    content: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True, deferred=True)
    size_bytes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # Set when the file was produced but not kept (over the size limit).
    content_note: Mapped[str | None] = mapped_column(Text, nullable=True)

    request: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    scope_key: Mapped[str | None] = mapped_column(String(64), nullable=True)
    summary: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    period_start: Mapped[date | None] = mapped_column(Date, nullable=True)
    period_end: Mapped[date | None] = mapped_column(Date, nullable=True)
    resources: Mapped[int | None] = mapped_column(Integer, nullable=True)

    delivery_status: Mapped[str | None] = mapped_column(String(40), nullable=True)
    delivery_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    delivered_to: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    delivery_queued_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    generated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    __table_args__ = (
        Index("ix_account_reports_account_generated", "account_id", "generated_at"),
        Index("uq_account_report_schedule_run", "schedule_id", "run_key", unique=True,
              postgresql_where=text("trigger = 'schedule'")),
    )

    def to_dict(self) -> dict:
        return {
            "id": str(self.id), "account_id": str(self.account_id),
            "schedule_id": str(self.schedule_id) if self.schedule_id else None,
            "run_key": self.run_key, "template_name": self.template_name, "title": self.title,
            "trigger": self.trigger, "requested_by": self.requested_by, "status": self.status,
            "error": self.error, "format": self.format, "filename": self.filename,
            "size_bytes": self.size_bytes, "sha256": self.sha256,
            "downloadable": self.size_bytes is not None and self.content_note is None
            and self.status == REPORT_GENERATED,
            "content_note": self.content_note,
            "period_start": _iso(self.period_start), "period_end": _iso(self.period_end),
            "resources": self.resources, "scope_key": self.scope_key,
            "delivery_status": self.delivery_status, "delivery_message": self.delivery_message,
            "delivered_to": self.delivered_to, "delivery_queued_at": _iso(self.delivery_queued_at),
            "generated_at": _iso(self.generated_at),
        }
