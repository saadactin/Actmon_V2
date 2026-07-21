"""Pydantic schemas for Cloud Account CRUD."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field


# ── Credential sub-schemas ────────────────────────────────────────────────────

class AWSCredentials(BaseModel):
    access_key_id: str
    secret_access_key: str
    session_token: Optional[str] = None
    region: str = "us-east-1"


class AzureCredentials(BaseModel):
    tenant_id: str
    client_id: str
    client_secret: str
    subscription_id: str


class OCICredentials(BaseModel):
    tenancy_ocid: str = Field(alias="oci_tenancy_ocid", default="")
    user_ocid: str = Field(alias="oci_user_ocid", default="")
    fingerprint: str = Field(alias="oci_fingerprint", default="")
    private_key: str = Field(alias="oci_private_key_content", default="")
    passphrase: Optional[str] = Field(alias="oci_passphrase", default=None)
    region: str = "us-ashburn-1"

    model_config = {"populate_by_name": True}


# ── Request schema ────────────────────────────────────────────────────────────

class CloudAccountCreate(BaseModel):
    """Payload sent by the frontend when registering a cloud account."""

    account_name: str
    provider: str  # AWS | Azure | Oracle
    environment: str = "Production"
    tenant_or_region: str
    auth_mode: str = "API_Keys"
    auto_discovery: bool = True

    # AWS
    access_key_id: Optional[str] = None
    secret_access_key: Optional[str] = None
    session_token: Optional[str] = None

    # Azure
    tenant_id: Optional[str] = None
    client_id: Optional[str] = None
    client_secret: Optional[str] = None
    subscription_id: Optional[str] = None

    # OCI
    oci_tenancy_ocid: Optional[str] = None
    oci_user_ocid: Optional[str] = None
    oci_fingerprint: Optional[str] = None
    oci_private_key_content: Optional[str] = None
    oci_passphrase: Optional[str] = None

    def extract_credentials(self) -> dict:
        """Pull provider-specific fields into a credentials dict."""
        p = self.provider.upper()
        if p == "AWS":
            return {
                "access_key_id": self.access_key_id,
                "secret_access_key": self.secret_access_key,
                "session_token": self.session_token,
                "region": self.tenant_or_region,
            }
        if p == "AZURE":
            return {
                "tenant_id": self.tenant_id,
                "client_id": self.client_id,
                "client_secret": self.client_secret,
                "subscription_id": self.subscription_id,
            }
        # OCI / Oracle
        return {
            "tenancy_ocid": self.oci_tenancy_ocid,
            "user_ocid": self.oci_user_ocid,
            "fingerprint": self.oci_fingerprint,
            "private_key": self.oci_private_key_content,
            "passphrase": self.oci_passphrase,
            "region": self.tenant_or_region,
        }


# ── Response schema ───────────────────────────────────────────────────────────

class CloudAccountResponse(BaseModel):
    id: uuid.UUID
    account_name: str
    provider: str
    environment: str
    tenant_or_region: str
    auth_mode: str
    auto_discovery: bool
    last_discovery: Optional[datetime] = None
    created_at: datetime

    model_config = {"from_attributes": True}
