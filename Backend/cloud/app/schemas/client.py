"""Request bodies for clients, organisation onboarding and client reports."""
from __future__ import annotations

import uuid
from typing import Dict, List, Optional

from pydantic import BaseModel, Field


class ClientIn(BaseModel):
    name: str
    code: Optional[str] = None
    description: Optional[str] = None
    contact_emails: List[str] = Field(default_factory=list)
    notes: Optional[str] = None


class ClientPatch(BaseModel):
    """Every field optional; only the ones sent are changed."""

    name: Optional[str] = None
    code: Optional[str] = None
    description: Optional[str] = None
    contact_emails: Optional[List[str]] = None
    notes: Optional[str] = None


class AssignAccountsIn(BaseModel):
    account_ids: List[uuid.UUID]


# ── Organisation onboarding ──────────────────────────────────────────────────
class OrgCredentialsIn(BaseModel):
    """The one connection an organisation is listed through.

    Never stored as-is and never echoed back: onboarding copies what each
    member needs into that member's own encrypted credentials.
    """

    provider: str                       # "AWS" | "Azure"
    # AWS — keys of the management account (or a delegated administrator).
    access_key_id: Optional[str] = None
    secret_access_key: Optional[str] = None
    session_token: Optional[str] = None
    region: str = "us-east-1"
    role_name: str = "OrganizationAccountAccessRole"
    external_id: Optional[str] = None
    # Azure — a service principal with Reader on each subscription (or on a
    # management group above them).
    tenant_id: Optional[str] = None
    client_id: Optional[str] = None
    client_secret: Optional[str] = None
    management_group_id: Optional[str] = None


class OnboardIn(OrgCredentialsIn):
    # AWS account ids or Azure subscription ids, as returned by discover.
    members: List[str]
    target_client_id: Optional[uuid.UUID] = None
    environment: str = "Production"
    # Prefixed to each member's own name ("KOEL - " + "Prod-EBS").
    name_prefix: Optional[str] = None
    start_discovery: bool = False


# ── Client reports ───────────────────────────────────────────────────────────
class ReportScheduleIn(BaseModel):
    enabled: bool = False
    day_of_month: int = Field(3, ge=1, le=28)
    send_time: str = "09:00"
    timezone: str = "Asia/Kolkata"
    recipients: Dict[str, List[str]] = Field(
        default_factory=lambda: {"to": [], "cc": [], "bcc": []})
    sections: Optional[List[str]] = None


class GenerateReportIn(BaseModel):
    # "YYYY-MM"; defaults to the last complete month.
    period: Optional[str] = None
    # Queue the e-mail to the schedule's recipients as well (needs reports:manage).
    send: bool = False
