"""Certificates, secrets and keys — their metadata, and the health of reading it.

Why a table of its own rather than rows in `cloud_resources`, for the same
reason identity grants have one (see identity_grant.py): these objects are
read through APIs with their own permissions, and that changes what "absent"
means.

An Azure subscription's ARM Reader role lists every Key Vault. It does NOT let
anyone read the certificates inside one: that is a data-plane call, governed by
the vault's own access policy or by a separate role (Key Vault Reader), and it
can also be refused by the vault's firewall. So the same scan routinely sees
the vault and is refused its contents. If those contents lived in the
inventory, the prune that follows a "complete" sweep would delete every
certificate whose vault said 403 — turning "we were not allowed to look" into
"the certificate is gone", which is the partial-scan prune bug over again.

So the unit of trust here is the **source scope** — one (source, scope) pair
such as ("azure:keyvault:certificates", "kv-prod") or ("aws:acm", "ap-south-1"):

* A scope that was read successfully REPLACES its own objects: something no
  longer listed there really was removed or renewed away.
* A scope that failed leaves its objects exactly as they were, and records why
  in `CloudCredentialSource`. Findings computed from those objects therefore
  persist rather than resolve, and the view says "last confirmed 3 days ago,
  last attempt was refused".

Nothing secret is ever stored. Every call used returns metadata — names,
validity dates, rotation settings — and none returns a secret value or a
private key. A public certificate may be parsed to read its dates; the PEM
itself is not kept.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    Boolean, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.cloud_account import CloudAccount  # noqa: F401  (FK target must be registered)

# ── Object kinds ─────────────────────────────────────────────────────────────
KIND_CERTIFICATE = "CERTIFICATE"
KIND_SECRET = "SECRET"
KIND_KEY = "KEY"
KINDS = (KIND_CERTIFICATE, KIND_SECRET, KIND_KEY)

# ── Collection outcomes (same vocabulary as identity collection) ─────────────
COLLECT_OK = "Collected"
COLLECT_PERMISSION_DENIED = "PermissionDenied"
COLLECT_AUTH_FAILED = "AuthenticationFailed"
COLLECT_BLOCKED = "BlockedByNetwork"         # a vault firewall refused this network
COLLECT_UNAVAILABLE = "Unavailable"          # transient, or the endpoint did not answer
COLLECT_NOT_SUPPORTED = "NotSupported"
COLLECT_NEVER_RUN = "NeverRun"

COLLECTION_STATES = (
    COLLECT_OK, COLLECT_PERMISSION_DENIED, COLLECT_AUTH_FAILED, COLLECT_BLOCKED,
    COLLECT_UNAVAILABLE, COLLECT_NOT_SUPPORTED, COLLECT_NEVER_RUN,
)
# Refusals a human must act on (grant a role, open a firewall), as opposed to
# a transient failure the next collection will probably clear on its own.
COLLECTION_ACTIONABLE = frozenset({
    COLLECT_PERMISSION_DENIED, COLLECT_AUTH_FAILED, COLLECT_BLOCKED,
})

COLLECTION_LABEL = {
    COLLECT_OK: "Collected",
    COLLECT_PERMISSION_DENIED: "Permission denied",
    COLLECT_AUTH_FAILED: "Credentials rejected",
    COLLECT_BLOCKED: "Blocked by the store's network rules",
    COLLECT_UNAVAILABLE: "Unavailable",
    COLLECT_NOT_SUPPORTED: "Not supported",
    COLLECT_NEVER_RUN: "Never collected",
}


def _now() -> datetime:
    return datetime.now(timezone.utc)


class CloudCredentialObject(Base):
    """One certificate, secret or key, as its provider describes it."""

    __tablename__ = "cloud_credential_objects"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    account_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cloud_accounts.id", ondelete="CASCADE"),
        nullable=False, index=True)
    provider: Mapped[str] = mapped_column(String(20), nullable=False)

    # Which listing produced it — the unit of replacement (see module docstring).
    source: Mapped[str] = mapped_column(String(64), nullable=False)
    source_scope: Mapped[str] = mapped_column(String(512), nullable=False)

    kind: Mapped[str] = mapped_column(String(16), nullable=False, index=True)
    # The provider's own identifier: an ARN, a Key Vault object id, an OCID, or
    # a composite for objects that have none of their own (a certificate
    # uploaded to an OCI load balancer is "<lb ocid>/certificates/<name>").
    object_key: Mapped[str] = mapped_column(String(1024), nullable=False)
    name: Mapped[str | None] = mapped_column(String(512), nullable=True)

    # Where it lives: the vault, load balancer or gateway that holds it.
    container_name: Mapped[str | None] = mapped_column(String(512), nullable=True)
    container_key: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    region: Mapped[str | None] = mapped_column(String(100), nullable=True)

    # Certificate identity, where the provider reports it.
    subject: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    issuer: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    dns_names: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    key_algorithm: Mapped[str | None] = mapped_column(String(64), nullable=True)

    # Validity. `expires_at` NULL means "no expiry is set" for a secret or key,
    # and "not reported" never — a certificate always has one, and a collector
    # that cannot read it does not store the certificate.
    not_before: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True),
                                                        nullable=True, index=True)
    enabled: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    # The provider's own lifecycle word: ISSUED, EXPIRED, ACTIVE, PENDING_VALIDATION…
    status: Mapped[str | None] = mapped_column(String(64), nullable=True)

    # Renewal and use, where the provider reports them. None = not reported,
    # which the analyser never reads as either answer.
    managed_renewal: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    renewal_status: Mapped[str | None] = mapped_column(String(64), nullable=True)
    in_use: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    in_use_by: Mapped[list | None] = mapped_column(JSONB, nullable=True)

    # Rotation, for secrets that support it (AWS Secrets Manager, OCI Vault).
    rotation_enabled: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    rotation_interval_days: Mapped[int | None] = mapped_column(Integer, nullable=True)
    last_rotated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True),
                                                             nullable=True)
    next_rotation_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True),
                                                              nullable=True)

    # Provider-specific extras (certificate type, vault properties, …).
    details: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    first_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now,
                                                   index=True)

    __table_args__ = (
        UniqueConstraint("account_id", "object_key", name="uq_credential_object_key"),
        Index("ix_credential_objects_scope", "account_id", "source", "source_scope"),
        Index("ix_credential_objects_account_expiry", "account_id", "expires_at"),
    )

    # Fields a collector may supply. Kept here so the repository and the
    # collectors cannot disagree about what a spec contains.
    SPEC_FIELDS = (
        "kind", "object_key", "name", "container_name", "container_key", "region",
        "subject", "issuer", "dns_names", "key_algorithm", "not_before", "expires_at",
        "enabled", "status", "managed_renewal", "renewal_status", "in_use",
        "in_use_by", "rotation_enabled", "rotation_interval_days", "last_rotated_at",
        "next_rotation_at", "details",
    )

    def to_dict(self) -> dict:
        def iso(dt):
            return dt.isoformat() if dt else None

        return {
            "id": str(self.id),
            "account_id": str(self.account_id),
            "provider": self.provider,
            "source": self.source,
            "source_scope": self.source_scope,
            "kind": self.kind,
            "object_key": self.object_key,
            "name": self.name,
            "container_name": self.container_name,
            "container_key": self.container_key,
            "region": self.region,
            "subject": self.subject,
            "issuer": self.issuer,
            "dns_names": list(self.dns_names or []),
            "key_algorithm": self.key_algorithm,
            "not_before": iso(self.not_before),
            "expires_at": iso(self.expires_at),
            "enabled": self.enabled,
            "status": self.status,
            "managed_renewal": self.managed_renewal,
            "renewal_status": self.renewal_status,
            "in_use": self.in_use,
            "in_use_by": list(self.in_use_by or []),
            "rotation_enabled": self.rotation_enabled,
            "rotation_interval_days": self.rotation_interval_days,
            "last_rotated_at": iso(self.last_rotated_at),
            "next_rotation_at": iso(self.next_rotation_at),
            "details": self.details or {},
            "first_seen_at": iso(self.first_seen_at),
            "last_seen_at": iso(self.last_seen_at),
        }


class CloudCredentialSource(Base):
    """Whether one source scope could be read, and if not, exactly why.

    Without this row "no certificates expiring" is ambiguous between "none
    expire" and "we were refused permission to look" — and the ambiguous
    reading is the dangerous one.
    """

    __tablename__ = "cloud_credential_sources"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    account_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cloud_accounts.id", ondelete="CASCADE"),
        nullable=False, index=True)
    provider: Mapped[str] = mapped_column(String(20), nullable=False)
    source: Mapped[str] = mapped_column(String(64), nullable=False)
    scope: Mapped[str] = mapped_column(String(512), nullable=False)
    # A readable name for the scope where one exists ("kv-prod" for a vault id).
    scope_label: Mapped[str | None] = mapped_column(String(512), nullable=True)

    status: Mapped[str] = mapped_column(String(40), nullable=False, default=COLLECT_NEVER_RUN)
    # The provider's own error text, verbatim — paraphrasing it loses which
    # action, at which scope, for which principal.
    error_detail: Mapped[str | None] = mapped_column(Text, nullable=True)
    missing_permission: Mapped[str | None] = mapped_column(String(256), nullable=True)
    # What an operator can do about it, in one sentence.
    remediation: Mapped[str | None] = mapped_column(Text, nullable=True)

    item_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # Properties of the container itself (e.g. a Key Vault's purge protection),
    # read by the analyser's store-level checks.
    container: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    last_attempt_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True),
                                                             nullable=True)
    last_success_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True),
                                                             nullable=True)

    __table_args__ = (
        UniqueConstraint("account_id", "source", "scope", name="uq_credential_source_scope"),
    )

    @property
    def trustworthy(self) -> bool:
        return self.status == COLLECT_OK

    def to_dict(self) -> dict:
        def iso(dt):
            return dt.isoformat() if dt else None

        return {
            "id": str(self.id),
            "account_id": str(self.account_id),
            "provider": self.provider,
            "source": self.source,
            "scope": self.scope,
            "scope_label": self.scope_label or self.scope,
            "status": self.status,
            "status_label": COLLECTION_LABEL.get(self.status, self.status),
            "trustworthy": self.trustworthy,
            "actionable": self.status in COLLECTION_ACTIONABLE,
            "error_detail": self.error_detail,
            "missing_permission": self.missing_permission,
            "remediation": self.remediation,
            "item_count": self.item_count,
            "container": self.container or {},
            "last_attempt_at": iso(self.last_attempt_at),
            "last_success_at": iso(self.last_success_at),
        }
