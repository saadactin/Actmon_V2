"""Clients — the organisation a set of cloud accounts belongs to — and the
monthly report each one receives.

Why a table of its own rather than a label on the account: the questions an
operator running several customers' estates actually asks are per customer,
not per account. "What is KOEL spending this month", "which of TOR's
certificates expire before the audit", "send each customer their August
report" — none of those can be answered from a free-text field copied onto
every account row, because the moment two rows spell the name differently the
customer silently becomes two customers.

Three rules this module exists to hold:

* **A client owns no cloud data.** Deleting a client unassigns its accounts
  (`ON DELETE SET NULL` on `cloud_accounts.client_id`); it never deletes an
  account, its inventory, its findings or its billing history. Those belong to
  the account, and an account outliving the client label is the safe
  direction.
* **A scheduled report is produced at most once per client per period.** The
  partial unique index on `cloud_client_reports (client_id, period) WHERE
  trigger = 'schedule'` is the guarantee, not the scheduler's bookkeeping. The
  e-mail storm traced on 2026-09-17 came from exactly that gap: a send that
  succeeded followed by bookkeeping that failed, so the row stayed due and sent
  again every minute. Here the report row, the schedule's advance and the
  queued e-mail are written in ONE transaction, and a second scheduled report
  for the same period cannot be inserted at all.
* **Queued is not delivered.** A report records whether its e-mail was queued;
  whether it left the building is written by the database service's dispatcher
  to `notification_history`, and that is the only place "sent" is earned.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timezone

from sqlalchemy import (
    Boolean, Date, DateTime, ForeignKey, Index, Integer, LargeBinary, String, Text,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

# ── Report lifecycle ─────────────────────────────────────────────────────────
REPORT_GENERATED = "GENERATED"
REPORT_FAILED = "FAILED"

TRIGGER_SCHEDULE = "schedule"
TRIGGER_MANUAL = "manual"

# What happened to a report's e-mail, from this service's side of the queue.
DELIVERY_QUEUED = "QUEUED"
DELIVERY_NOT_REQUESTED = "NOT_REQUESTED"
DELIVERY_NOT_READY = "DELIVERY_NOT_READY"      # SMTP or the e-mail channel is missing
DELIVERY_NO_RECIPIENTS = "NO_RECIPIENTS"
DELIVERY_FAILED_TO_QUEUE = "FAILED_TO_QUEUE"
DELIVERY_TOO_LARGE = "TOO_LARGE"

# The sections a report can carry. Every one is on by default; a schedule can
# drop sections a customer does not want, never add one that has no source.
# (Cost recommendations are deliberately absent: they are derived alongside a
# live billing-API call, and a monthly report must not depend on a rate-limited
# provider answering at 09:00 on the 3rd.)
SECTIONS = ("cost", "security", "compliance", "certificates", "changes", "alerts",
            "data_gaps")


def _now() -> datetime:
    return datetime.now(timezone.utc)


class CloudClient(Base):
    __tablename__ = "cloud_clients"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    # A short code for lists and report headers ("KOEL", "TOR"). Optional, but
    # unique when set, so two clients can never share one.
    code: Mapped[str | None] = mapped_column(String(32), nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Who at the customer this estate is run for. Informational: report
    # recipients are configured on the schedule, deliberately separately, so
    # adding a contact never silently adds someone to an e-mail.
    contact_emails: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_by: Mapped[str | None] = mapped_column(String(256), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now)

    __table_args__ = (
        # Case-insensitive, so "KOEL" and "koel" cannot both exist.
        Index("uq_cloud_clients_name_ci", text("lower(name)"), unique=True),
        Index("uq_cloud_clients_code_ci", text("lower(code)"), unique=True,
              postgresql_where=text("code IS NOT NULL")),
    )

    def to_dict(self) -> dict:
        return {
            "id": str(self.id),
            "name": self.name,
            "code": self.code,
            "description": self.description,
            "contact_emails": list(self.contact_emails or []),
            "notes": self.notes,
            "created_by": self.created_by,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }


class CloudClientReportSchedule(Base):
    """When a client's monthly report is produced, and who receives it.

    One row per client. Created disabled: turning on a schedule is the act that
    starts e-mail leaving the building, so it is never the default.
    """

    __tablename__ = "cloud_client_report_schedules"

    client_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cloud_clients.id", ondelete="CASCADE"),
        primary_key=True)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # Day 1-28 of the month after the period. Defaults to the 3rd because every
    # provider restates billing for a few days after month end; a report built
    # on the 1st would print figures the provider is still revising.
    day_of_month: Mapped[int] = mapped_column(Integer, nullable=False, default=3)
    send_time: Mapped[str] = mapped_column(String(5), nullable=False, default="09:00")
    timezone: Mapped[str] = mapped_column(String(64), nullable=False, default="Asia/Kolkata")
    # {"to": [...], "cc": [...], "bcc": [...]}
    recipients: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    sections: Mapped[list | None] = mapped_column(JSONB, nullable=True)

    next_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True),
                                                         nullable=True)
    # The last period ("2026-08") a SCHEDULED report was produced for. Read with
    # the partial unique index on cloud_client_reports, never instead of it.
    last_period: Mapped[str | None] = mapped_column(String(7), nullable=True)
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True),
                                                         nullable=True)
    last_status: Mapped[str | None] = mapped_column(String(40), nullable=True)
    last_message: Mapped[str | None] = mapped_column(Text, nullable=True)

    updated_by: Mapped[str | None] = mapped_column(String(256), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now)

    __table_args__ = (
        Index("ix_client_report_schedule_due", "enabled", "next_run_at"),
    )

    def to_dict(self) -> dict:
        rec = self.recipients or {}
        return {
            "client_id": str(self.client_id),
            "enabled": bool(self.enabled),
            "day_of_month": self.day_of_month,
            "send_time": self.send_time,
            "timezone": self.timezone,
            "recipients": {k: list(rec.get(k) or []) for k in ("to", "cc", "bcc")},
            "sections": list(self.sections) if self.sections else list(SECTIONS),
            "next_run_at": self.next_run_at.isoformat() if self.next_run_at else None,
            "last_period": self.last_period,
            "last_run_at": self.last_run_at.isoformat() if self.last_run_at else None,
            "last_status": self.last_status,
            "last_message": self.last_message,
            "updated_by": self.updated_by,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }


class CloudClientReport(Base):
    """One generated report: the PDF, the numbers it was built from, and what
    happened to its e-mail."""

    __tablename__ = "cloud_client_reports"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    client_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cloud_clients.id", ondelete="CASCADE"),
        nullable=False, index=True)
    period: Mapped[str] = mapped_column(String(7), nullable=False)       # "2026-08"
    period_start: Mapped[date] = mapped_column(Date, nullable=False)
    period_end: Mapped[date] = mapped_column(Date, nullable=False)       # exclusive
    trigger: Mapped[str] = mapped_column(String(16), nullable=False, default=TRIGGER_MANUAL)
    requested_by: Mapped[str | None] = mapped_column(String(256), nullable=True)

    status: Mapped[str] = mapped_column(String(24), nullable=False, default=REPORT_GENERATED)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Deferred: listing a client's report history must not drag every PDF out
    # of the database to print a table of dates.
    pdf: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True, deferred=True)
    pdf_bytes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # The numbers the PDF was drawn from. Stored so "why did the August report
    # say X" has an answer after the underlying facts are restated.
    summary: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    delivery_status: Mapped[str | None] = mapped_column(String(40), nullable=True)
    delivery_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    delivered_to: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    delivery_queued_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True),
                                                                nullable=True)

    generated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    __table_args__ = (
        Index("ix_client_reports_client_generated", "client_id", "generated_at"),
        # The hard guarantee behind "at most one scheduled report per period".
        Index("uq_client_report_scheduled_period", "client_id", "period",
              unique=True, postgresql_where=text("trigger = 'schedule'")),
    )

    def to_dict(self) -> dict:
        return {
            "id": str(self.id),
            "client_id": str(self.client_id),
            "period": self.period,
            "period_start": self.period_start.isoformat() if self.period_start else None,
            "period_end": self.period_end.isoformat() if self.period_end else None,
            "trigger": self.trigger,
            "requested_by": self.requested_by,
            "status": self.status,
            "error": self.error,
            "pdf_bytes": self.pdf_bytes,
            "sha256": self.sha256,
            "delivery_status": self.delivery_status,
            "delivery_message": self.delivery_message,
            "delivered_to": self.delivered_to,
            "delivery_queued_at": (self.delivery_queued_at.isoformat()
                                   if self.delivery_queued_at else None),
            "generated_at": self.generated_at.isoformat() if self.generated_at else None,
        }
