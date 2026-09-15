"""SQLAlchemy ORM model for `cloud_events` — the unified cloud audit trail.

This is the control-plane record: who called which management API, against
which resource, from where, and what the provider answered. It is NOT an
application log. Every row originates from AWS CloudTrail, Azure Activity Log
or OCI Audit, and the provider's own payload is kept verbatim in `raw_event`.

Three properties are load-bearing and everything else follows from them:

1.  **Append-only.** An audit trail the application can rewrite is not an audit
    trail. There is no update path in the repository, no PATCH/PUT/DELETE
    route, and (see app/main.py) a database trigger rejects UPDATE outright and
    rejects DELETE unless the retention pruner has explicitly declared itself
    for that one transaction.

2.  **Normalized without lossy translation.** The flat columns are the common
    schema the UI queries and indexes; `provider_metadata` holds the fields
    that only exist for one provider (an ARN, a claims bag, an OCI compartment
    path) and `raw_event` holds the untouched original. Nothing is dropped just
    because the other two providers have no equivalent.

3.  **Absent means absent.** A column is NULL when the provider did not supply
    the value — never a placeholder, never inferred. AWS reports a source IP;
    OCI reports a previous state; Azure reports neither consistently. The UI
    renders NULL as "Not available", which is the true answer.

Deduplication is a uniqueness constraint, not a scan: the same provider event
retrieved by two overlapping polls collides on
(account_id, provider_event_id) and the second insert is discarded. That id is
the provider's own — CloudTrail `eventID`, Azure `eventDataId`, OCI `eventId`
— and only falls back to a content hash when a provider omits it (see
app/events/adapters/base.py).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

# Importing the parent makes this model self-sufficient rather than dependent
# on import order; cloud_account does not import this module, so no cycle.
from app.models.cloud_account import CloudAccount  # noqa: F401

# JSONB that stores Python None as SQL NULL rather than as the JSON literal
# `null`. Without `none_as_null`, SQLAlchemy writes `'null'::jsonb` — a real
# JSON value — so `WHERE change_after IS NULL` is FALSE for a column that was
# set to None, and every SQL-level null check on a JSON column silently returns
# the wrong rows. Confirmed on live data: all 68 collected Azure events matched
# `change_after IS NOT NULL` while genuinely carrying no state change.
#
# The ORM read path is unaffected either way (JSON null deserializes back to
# Python None), which is exactly why this is worth pinning down in the column
# type: it is invisible from the application and wrong only in SQL.
_NULLABLE_JSONB = JSONB(none_as_null=True)


# ── Vocabulary ────────────────────────────────────────────────────────────────
# Kept here rather than in the route layer so the writer, the reader and the
# validator all agree on one list. Anything outside these is a bug in an
# adapter, not a new value to be silently accepted.

STATUS_SUCCESS = "Success"
STATUS_FAILED = "Failed"
STATUS_DENIED = "Denied"
STATUS_PARTIAL = "Partial"
STATUS_UNKNOWN = "Unknown"
EVENT_STATUSES = (
    STATUS_SUCCESS, STATUS_FAILED, STATUS_DENIED, STATUS_PARTIAL, STATUS_UNKNOWN,
)

RISK_INFO = "INFO"
RISK_LOW = "LOW"
RISK_MEDIUM = "MEDIUM"
RISK_HIGH = "HIGH"
RISK_CRITICAL = "CRITICAL"
RISK_LEVELS = (RISK_INFO, RISK_LOW, RISK_MEDIUM, RISK_HIGH, RISK_CRITICAL)
# Ordinal, for "risk >= HIGH" style filtering. Postgres cannot order a varchar
# by our semantics, so that comparison is expressed as an IN over this ranking.
RISK_ORDER = {level: i for i, level in enumerate(RISK_LEVELS)}

CATEGORIES = (
    "Authentication", "Authorization", "Configuration", "ResourceManagement",
    "Network", "Security", "DataAccess", "IAM", "Compute", "Storage",
    "Database", "Monitoring", "Logging", "Billing", "Other",
)

ACTIONS = (
    "Create", "Update", "Delete", "Read", "Login", "Logout", "Attach", "Detach",
    "Start", "Stop", "Reboot", "Modify", "Authorize", "Revoke", "Enable",
    "Disable", "Associate", "Disassociate", "Invoke", "Deploy", "Scale",
    "Other",
)

# What kind of principal acted. The distinction between a person and a machine
# is the single most misread field in an audit trail, so it is a first-class
# column with a closed vocabulary rather than a free-text label.
ACTOR_HUMAN = "Human"
ACTOR_SERVICE_PRINCIPAL = "ServicePrincipal"
ACTOR_IAM_ROLE = "IAMRole"
ACTOR_SERVICE_ACCOUNT = "ServiceAccount"
ACTOR_CLOUD_SERVICE = "CloudService"
ACTOR_AUTOMATED = "AutomatedProcess"
ACTOR_ROOT = "RootAccount"
ACTOR_UNKNOWN = "Unknown"
ACTOR_TYPES = (
    ACTOR_HUMAN, ACTOR_SERVICE_PRINCIPAL, ACTOR_IAM_ROLE, ACTOR_SERVICE_ACCOUNT,
    ACTOR_CLOUD_SERVICE, ACTOR_AUTOMATED, ACTOR_ROOT, ACTOR_UNKNOWN,
)

ACCESS_METHODS = (
    "Console", "CLI", "SDK", "API", "Terraform", "CloudFormation", "Service",
    "Automation", "Unknown",
)


class CloudEvent(Base):
    __tablename__ = "cloud_events"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    account_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("cloud_accounts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    provider: Mapped[str] = mapped_column(String(20), nullable=False, index=True)

    # The provider's own unique id for this event — the deduplication key.
    provider_event_id: Mapped[str] = mapped_column(String(256), nullable=False)

    # ── When ─────────────────────────────────────────────────────────────────
    # Always UTC. `timestamp` is the provider's own event time; `ingested_at`
    # is ours, and the gap between them is the ingestion latency the UI reports
    # rather than hides.
    timestamp: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, index=True
    )
    ingested_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), index=True
    )
    # Only some providers report when THEY received it (Azure's
    # submissionTimestamp). NULL where they do not.
    provider_received_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    # ── What ─────────────────────────────────────────────────────────────────
    event_name: Mapped[str] = mapped_column(String(256), nullable=False, index=True)
    # The provider's service/namespace: "ec2.amazonaws.com", "Microsoft.Network",
    # "objectstorage".
    event_source: Mapped[str | None] = mapped_column(String(256), nullable=True, index=True)
    # Full API operation string, which for Azure is the only precise form
    # ("Microsoft.Network/networkSecurityGroups/securityRules/write").
    api_operation: Mapped[str | None] = mapped_column(String(512), nullable=True)
    http_method: Mapped[str | None] = mapped_column(String(10), nullable=True)
    event_category: Mapped[str] = mapped_column(String(40), nullable=False, index=True)
    action: Mapped[str] = mapped_column(String(20), nullable=False, index=True)
    status: Mapped[str] = mapped_column(String(20), nullable=False, index=True)
    risk_level: Mapped[str] = mapped_column(String(20), nullable=False, index=True)
    # Why the classifier landed on that risk — the rule that matched. Makes a
    # CRITICAL defensible instead of a label the reader has to take on trust.
    risk_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Read-only calls dwarf everything else in volume and are the first thing a
    # reader wants out of the way, so this is stored and indexed, not derived.
    read_only: Mapped[bool | None] = mapped_column(Boolean, nullable=True, index=True)
    # The provider's own category, kept because Azure's ("Administrative",
    # "ServiceHealth", "Policy") does not map onto ours without loss.
    provider_category: Mapped[str | None] = mapped_column(String(60), nullable=True, index=True)

    # ── Who ──────────────────────────────────────────────────────────────────
    actor_id: Mapped[str | None] = mapped_column(String(512), nullable=True, index=True)
    actor_name: Mapped[str | None] = mapped_column(String(512), nullable=True, index=True)
    actor_email: Mapped[str | None] = mapped_column(String(320), nullable=True, index=True)
    actor_type: Mapped[str] = mapped_column(
        String(30), nullable=False, default=ACTOR_UNKNOWN, index=True
    )
    actor_role: Mapped[str | None] = mapped_column(String(512), nullable=True)
    actor_auth_method: Mapped[str | None] = mapped_column(String(120), nullable=True)
    # The chain that led to this call — AWS role assumption, an SSO federation
    # hop. A list of {type, name, id} steps, outermost first, so the human
    # behind an assumed role is recoverable. Empty when the provider is silent.
    actor_chain: Mapped[list | None] = mapped_column(_NULLABLE_JSONB, nullable=True)

    # ── Where (cloud context) ────────────────────────────────────────────────
    account_ref: Mapped[str | None] = mapped_column(String(256), nullable=True, index=True)
    subscription_id: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    tenant_id: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    tenancy_id: Mapped[str | None] = mapped_column(String(256), nullable=True, index=True)
    compartment_id: Mapped[str | None] = mapped_column(String(256), nullable=True, index=True)
    compartment_name: Mapped[str | None] = mapped_column(String(256), nullable=True)
    resource_group: Mapped[str | None] = mapped_column(String(256), nullable=True, index=True)
    region: Mapped[str | None] = mapped_column(String(80), nullable=True, index=True)

    # ── Which resource ───────────────────────────────────────────────────────
    resource_id: Mapped[str | None] = mapped_column(String(1024), nullable=True, index=True)
    resource_name: Mapped[str | None] = mapped_column(String(512), nullable=True, index=True)
    resource_type: Mapped[str | None] = mapped_column(String(120), nullable=True, index=True)
    # One event can touch several resources (CloudTrail `resources`), so the
    # primary one gets the indexed columns and the rest live here.
    resources: Mapped[list | None] = mapped_column(_NULLABLE_JSONB, nullable=True)

    # ── Where from (network) ─────────────────────────────────────────────────
    source_ip: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    user_agent: Mapped[str | None] = mapped_column(Text, nullable=True)
    access_method: Mapped[str | None] = mapped_column(String(30), nullable=True, index=True)
    # Geolocation is NOT derived from the IP anywhere in this system. None of
    # the three providers report it, and guessing a country from an address is
    # exactly the fabrication this feature forbids. The column exists so a real
    # GeoIP source, if one is ever added, has somewhere to land.
    source_location: Mapped[str | None] = mapped_column(String(160), nullable=True)

    # ── Request correlation ──────────────────────────────────────────────────
    request_id: Mapped[str | None] = mapped_column(String(256), nullable=True, index=True)
    correlation_id: Mapped[str | None] = mapped_column(String(256), nullable=True, index=True)
    session_id: Mapped[str | None] = mapped_column(String(256), nullable=True)
    trace_id: Mapped[str | None] = mapped_column(String(256), nullable=True)

    # ── Result ───────────────────────────────────────────────────────────────
    http_status: Mapped[int | None] = mapped_column(Integer, nullable=True)
    error_code: Mapped[str | None] = mapped_column(String(256), nullable=True, index=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)

    # ── What changed ─────────────────────────────────────────────────────────
    # Populated ONLY from a provider that genuinely reports prior state (OCI
    # Audit's stateChange). AWS reports the parameters that were *requested*,
    # which is not a before/after pair; that lands in
    # provider_metadata.request_parameters instead. Presenting it as "before"
    # would invent a previous state nobody ever observed.
    change_before: Mapped[dict | None] = mapped_column(_NULLABLE_JSONB, nullable=True)
    change_after: Mapped[dict | None] = mapped_column(_NULLABLE_JSONB, nullable=True)
    changed_fields: Mapped[list | None] = mapped_column(_NULLABLE_JSONB, nullable=True)

    # ── Provider-specific ────────────────────────────────────────────────────
    provider_metadata: Mapped[dict | None] = mapped_column(_NULLABLE_JSONB, nullable=True)
    raw_event: Mapped[dict | None] = mapped_column(_NULLABLE_JSONB, nullable=True)
    # True when redaction touched the payload, so the UI can say the raw event
    # is redacted rather than let a reader assume they see everything.
    redacted: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    # Seconds between the provider's event time and our ingest. Stored rather
    # than computed on read so the observability endpoint can aggregate it
    # without a full table scan.
    ingestion_latency_s: Mapped[float | None] = mapped_column(Float, nullable=True)

    __table_args__ = (
        # Deduplication. Scoped to the account because the same tenancy could
        # legitimately be registered twice and each registration is its own
        # collection scope.
        UniqueConstraint("account_id", "provider_event_id", name="uq_cloud_events_provider_id"),
        # The default feed: newest first for one account.
        Index("ix_cloud_events_account_ts", "account_id", "timestamp"),
        # Cross-account feed, and the window filter's driving index.
        Index("ix_cloud_events_provider_ts", "provider", "timestamp"),
        # "everything this principal did" — the top investigation path.
        Index("ix_cloud_events_actor_ts", "actor_name", "timestamp"),
        # "everything that happened to this resource" — the Config Drift link.
        Index("ix_cloud_events_resource_ts", "resource_id", "timestamp"),
        # The high-risk feed the summary cards read.
        Index("ix_cloud_events_risk_ts", "risk_level", "timestamp"),
        # Related-event lookup by correlation.
        Index("ix_cloud_events_correlation", "correlation_id"),
    )

    # ── Serialization ────────────────────────────────────────────────────────

    def to_row(self) -> dict:
        """The list/table shape: enough for a row and its badges, no payloads.

        Deliberately excludes raw_event and provider_metadata — a 500-row page
        of CloudTrail payloads is megabytes of JSON the table never renders.
        """
        return {
            "id": str(self.id),
            "account_id": str(self.account_id),
            "provider": self.provider,
            "provider_event_id": self.provider_event_id,
            "timestamp": iso_utc(self.timestamp),
            "ingested_at": iso_utc(self.ingested_at),
            "event_name": self.event_name,
            "event_source": self.event_source,
            "api_operation": self.api_operation,
            "event_category": self.event_category,
            "action": self.action,
            "status": self.status,
            "risk_level": self.risk_level,
            "read_only": self.read_only,
            "actor_name": self.actor_name,
            "actor_email": self.actor_email,
            "actor_type": self.actor_type,
            "resource_id": self.resource_id,
            "resource_name": self.resource_name,
            "resource_type": self.resource_type,
            "account_ref": self.account_ref,
            "subscription_id": self.subscription_id,
            "compartment_name": self.compartment_name,
            "resource_group": self.resource_group,
            "region": self.region,
            "source_ip": self.source_ip,
            "access_method": self.access_method,
            "error_code": self.error_code,
            "has_change": bool(self.change_before or self.change_after),
        }

    def to_detail(self, *, include_raw: bool = True) -> dict:
        """The full drawer shape.

        `include_raw=False` is what a caller without raw-payload permission
        gets: the structured view stays intact and the payload is simply
        absent, rather than the whole event being refused.
        """
        detail = self.to_row()
        detail.update(
            {
                "provider_received_at": iso_utc(self.provider_received_at),
                "ingestion_latency_s": self.ingestion_latency_s,
                "http_method": self.http_method,
                "provider_category": self.provider_category,
                "risk_reason": self.risk_reason,
                "actor": {
                    "id": self.actor_id,
                    "name": self.actor_name,
                    "email": self.actor_email,
                    "type": self.actor_type,
                    "role": self.actor_role,
                    "authentication_method": self.actor_auth_method,
                    "chain": self.actor_chain or [],
                },
                "resource": {
                    "id": self.resource_id,
                    "name": self.resource_name,
                    "type": self.resource_type,
                    "region": self.region,
                    "account": self.account_ref,
                    "subscription": self.subscription_id,
                    "tenant": self.tenant_id,
                    "tenancy": self.tenancy_id,
                    "compartment_id": self.compartment_id,
                    "compartment": self.compartment_name,
                    "resource_group": self.resource_group,
                    "additional": self.resources or [],
                },
                "source": {
                    "ip": self.source_ip,
                    "user_agent": self.user_agent,
                    "access_method": self.access_method,
                    "location": self.source_location,
                },
                "request": {
                    "request_id": self.request_id,
                    "correlation_id": self.correlation_id,
                    "session_id": self.session_id,
                    "trace_id": self.trace_id,
                },
                "result": {
                    "status": self.status,
                    "http_status": self.http_status,
                    "error_code": self.error_code,
                    "error_message": self.error_message,
                },
                "change": {
                    "before": self.change_before,
                    "after": self.change_after,
                    "changed_fields": self.changed_fields or [],
                    # Says out loud that a missing diff is the provider's
                    # silence, not our omission.
                    "available": bool(self.change_before or self.change_after),
                },
                "provider_metadata": self.provider_metadata or {},
                "redacted": self.redacted,
            }
        )
        if include_raw:
            detail["raw_event"] = self.raw_event
        return detail


def iso_utc(value: datetime | None) -> str | None:
    """ISO-8601 with an explicit offset.

    Postgres hands back tz-aware values, but a row built in Python and never
    round-tripped can be naive. Those are UTC by construction everywhere in
    this feature, so stamping UTC is a correction, not an assumption — and it
    keeps the frontend from parsing a naive string as local time.
    """
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.isoformat()
