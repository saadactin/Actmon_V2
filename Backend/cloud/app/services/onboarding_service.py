"""Onboard a whole AWS organisation or Azure tenant in one pass.

Two steps, deliberately separate:

1. **discover** lists the members and probes each for real access. It stores
   nothing — the credentials are used for the listing and dropped.
2. **onboard** creates one ordinary cloud account per chosen member. Each is
   authenticated exactly as "Add Account" would authenticate it, and each is
   committed on its own, so member 7 failing never rolls back members 1-6 and
   the response says which were created, skipped and refused.

What onboarding never does:

* It never stores the organisation-level connection as an account of its own,
  and never scans a member with the management account's own permissions — an
  AWS member is stored with the role to assume INTO it.
* It never creates a second account for a member that is already connected.
  "Already connected" is decided by the provider's own id
  (`provider_account_id`), not by name, so a renamed account is still
  recognised.
* It never starts more than `MAX_DISCOVERY_STARTS` scans at once. A scan of one
  AWS account takes 15-23 minutes here and the network is known to drop
  connections under load; forty concurrent sweeps would degrade all of them.
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.client import CloudClient
from app.models.cloud_account import CloudAccount
from app.schemas.client import OnboardIn, OrgCredentialsIn
from app.services.cloud_account_service import (
    CloudAccountService, backfill_provider_account_ids,
)
from app.utils.encryption import encrypt_credentials

logger = logging.getLogger("cloud_svc.onboarding")

MAX_DISCOVERY_STARTS = 5
MAX_MEMBERS_PER_REQUEST = 200


class OnboardingError(ValueError):
    def __init__(self, message: str, *, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


def _provider_key(provider: str) -> str:
    p = (provider or "").strip().upper()
    if p in ("AWS", "AMAZON"):
        return "AWS"
    if p in ("AZURE", "MICROSOFT"):
        return "AZURE"
    raise OnboardingError(
        f"Organisation onboarding supports AWS Organizations and Azure tenants, not "
        f"{provider!r}. An OCI tenancy is already one account covering every "
        "compartment — add it from Add Account.")


def _require(payload: OrgCredentialsIn, *names: str) -> None:
    missing = [n for n in names if not (getattr(payload, n, None) or "").strip()]
    if missing:
        raise OnboardingError("Missing: " + ", ".join(missing) + ".")


def _aws_base(payload: OrgCredentialsIn) -> Dict[str, Any]:
    _require(payload, "access_key_id", "secret_access_key")
    return {"access_key_id": payload.access_key_id.strip(),
            "secret_access_key": payload.secret_access_key.strip(),
            "session_token": (payload.session_token or "").strip() or None,
            "region": (payload.region or "us-east-1").strip()}


def _azure_base(payload: OrgCredentialsIn) -> Dict[str, Any]:
    _require(payload, "tenant_id", "client_id", "client_secret")
    return {"tenant_id": payload.tenant_id.strip(), "client_id": payload.client_id.strip(),
            "client_secret": payload.client_secret.strip()}


class OnboardingService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def _connected(self, provider: str) -> Dict[str, Dict[str, Any]]:
        """provider id (lower-cased) -> the account already connected for it."""
        # Fill ids for older rows first (local decryption only), so an Azure
        # subscription added before provider_account_id existed is recognised.
        try:
            await backfill_provider_account_ids(self.db)
            await self.db.commit()
        except Exception as exc:  # noqa: BLE001 — recognition degrades, never blocks
            await self.db.rollback()
            logger.warning("provider_account_id backfill failed: %s", exc)
        stored = "Azure" if provider == "AZURE" else "AWS"
        rows = (await self.db.execute(
            select(CloudAccount).where(CloudAccount.provider.ilike(stored)))).scalars().all()
        return {a.provider_account_id.lower(): {"account_id": str(a.id),
                                                 "account_name": a.account_name}
                for a in rows if a.provider_account_id}

    # ── discover ────────────────────────────────────────────────────────────
    async def discover(self, payload: OrgCredentialsIn) -> Dict[str, Any]:
        provider = _provider_key(payload.provider)
        loop = asyncio.get_running_loop()
        if provider == "AWS":
            from app.providers.aws.aws_organizations import list_members

            base = _aws_base(payload)
            role = (payload.role_name or "").strip() or "OrganizationAccountAccessRole"
            listing = await loop.run_in_executor(
                None, lambda: list_members(base, role_name=role,
                                           external_id=(payload.external_id or None)))
            raw = listing.get("members") or []
            members = [{
                "member_id": m["account_id"], "name": m.get("name"),
                "detail": m.get("email"), "state": m.get("state"),
                "is_management_account": m.get("is_management_account"),
                "access": m.get("access") or {},
            } for m in raw]
        else:
            from app.providers.azure.azure_tenant import list_subscriptions

            base = _azure_base(payload)
            listing = await loop.run_in_executor(
                None, lambda: list_subscriptions(
                    base, management_group_id=(payload.management_group_id or None)))
            members = []
            for s in listing.get("subscriptions") or []:
                access = s.get("access") or {}
                members.append({
                    "member_id": s["subscription_id"], "name": s.get("display_name"),
                    "detail": s.get("tenant_id"), "state": s.get("state"),
                    "is_management_account": False,
                    "access": {
                        "can_access": bool(access.get("inventory")),
                        "inventory": access.get("inventory"),
                        "cost": access.get("cost"),
                        "identity": access.get("identity"),
                        "probed": access.get("probed"),
                        "detail": access.get("detail"),
                    },
                })

        connected = await self._connected(provider)
        for m in members:
            existing = connected.get((m["member_id"] or "").lower())
            m["already_connected"] = existing
            state = (m.get("state") or "").upper()
            if existing:
                m["selectable"], m["reason"] = False, (
                    f"Already connected as {existing['account_name']}.")
            elif state not in ("ACTIVE", "ENABLED"):
                m["selectable"], m["reason"] = False, f"The member is {m.get('state')}."
            elif not (m.get("access") or {}).get("can_access"):
                m["selectable"] = False
                m["reason"] = ((m.get("access") or {}).get("detail")
                               or "Access could not be confirmed.")
            else:
                m["selectable"], m["reason"] = True, None

        # Whatever the provider said, nothing credential-shaped goes back out.
        info = {k: v for k, v in listing.items()
                if k not in ("members", "subscriptions")}
        return {
            "provider": "AWS" if provider == "AWS" else "Azure",
            **info,
            "members": members,
            "summary": {
                "total": len(members),
                "selectable": sum(1 for m in members if m["selectable"]),
                "already_connected": sum(1 for m in members if m["already_connected"]),
                "no_access": sum(1 for m in members
                                 if not m["already_connected"] and not m["selectable"]),
            },
        }

    # ── onboard ─────────────────────────────────────────────────────────────
    async def onboard(self, payload: OnboardIn, *, actor: Optional[str]) -> Dict[str, Any]:
        provider = _provider_key(payload.provider)
        wanted = list(dict.fromkeys(m.strip() for m in payload.members if m and m.strip()))
        if not wanted:
            raise OnboardingError("Choose at least one member to onboard.")
        if len(wanted) > MAX_MEMBERS_PER_REQUEST:
            raise OnboardingError(
                f"At most {MAX_MEMBERS_PER_REQUEST} members per request.")
        if payload.target_client_id and await self.db.get(
                CloudClient, payload.target_client_id) is None:
            raise OnboardingError("The chosen client does not exist.", status=404)

        # Re-list rather than trusting the browser's copy: names, states and the
        # organisation's identity come from the provider at onboarding time.
        listing = await self.discover(payload)
        if listing.get("status") not in (None, "Collected"):
            raise OnboardingError(listing.get("error") or "The organisation could not be listed.",
                                  status=400)
        by_id = {(m["member_id"] or "").lower(): m for m in listing["members"]}
        base = _aws_base(payload) if provider == "AWS" else _azure_base(payload)
        role = (payload.role_name or "").strip() or "OrganizationAccountAccessRole"
        prefix = (payload.name_prefix or "").strip()
        now = datetime.now(timezone.utc).isoformat()
        results: List[Dict[str, Any]] = []
        created_ids: List[uuid.UUID] = []

        for member_id in wanted:
            member = by_id.get(member_id.lower())
            if member is None:
                results.append({"member_id": member_id, "outcome": "not_found",
                                "detail": "Not in the organisation listing."})
                continue
            # From here on, the provider's own spelling of the id — never the
            # caller's. A subscription id typed in upper case must not be
            # stored in credentials the SDK compares case-sensitively.
            member_id = member["member_id"]
            if member.get("already_connected"):
                results.append({"member_id": member_id, "outcome": "skipped",
                                "detail": member["reason"],
                                "account_id": member["already_connected"]["account_id"]})
                continue

            name = f"{prefix}{member.get('name') or member_id}".strip()[:255]
            if provider == "AWS":
                from app.providers.aws.aws_organizations import member_credentials

                raw_member = {"account_id": member_id,
                              "is_caller_account": (member.get("access") or {}).get(
                                  "access_mode") == "direct_keys"}
                creds = member_credentials(base, raw_member, role_name=role,
                                           external_id=(payload.external_id or None))
                stored_provider, region = "AWS", base["region"]
                auth_mode = "AssumeRole" if creds.get("role_arn") else "API_Keys"
                source = {"kind": "aws_organization",
                          "organization_id": (listing.get("organization") or {}).get("id"),
                          "management_account_id": (listing.get("organization") or {}).get(
                              "management_account_id"),
                          "member_account_id": member_id,
                          "role_name": role if creds.get("role_arn") else None}
            else:
                from app.providers.azure.azure_tenant import member_credentials

                creds = member_credentials(base, member_id)
                stored_provider, region, auth_mode = "Azure", base["tenant_id"], "API_Keys"
                source = {"kind": "azure_tenant", "tenant_id": base["tenant_id"],
                          "management_group_id": payload.management_group_id or None,
                          "subscription_id": member_id}
            source.update({"onboarded_at": now, "onboarded_by": actor})

            try:
                learned = await CloudAccountService._validate_credentials(
                    stored_provider, creds)
            except Exception as exc:  # noqa: BLE001 — reported per member
                results.append({"member_id": member_id, "outcome": "failed",
                                "detail": f"Authentication failed: {str(exc)[:400]}"})
                continue

            account = CloudAccount(
                account_name=name, provider=stored_provider,
                environment=payload.environment or "Production",
                tenant_or_region=region, auth_mode=auth_mode, auto_discovery=True,
                credentials_enc=encrypt_credentials(creds),
                client_id=payload.target_client_id,
                provider_account_id=(learned or member_id).lower()
                if provider == "AZURE" else (learned or member_id),
                onboarding_source=source,
            )
            self.db.add(account)
            try:
                await self.db.commit()
            except Exception as exc:  # noqa: BLE001
                await self.db.rollback()
                results.append({"member_id": member_id, "outcome": "failed",
                                "detail": f"Could not be saved: {str(exc)[:300]}"})
                continue
            created_ids.append(account.id)
            results.append({"member_id": member_id, "outcome": "created",
                            "account_id": str(account.id), "account_name": name})

        started: List[str] = []
        not_started = 0
        if payload.start_discovery and created_ids:
            from app.repository.discovery_repo import DiscoveryRepository
            from app.services.discovery_service import _launch_scan

            disco = DiscoveryRepository(self.db)
            for aid in created_ids[:MAX_DISCOVERY_STARTS]:
                job = await disco.create_job(aid)
                await self.db.commit()
                _launch_scan(job.id, aid)
                started.append(str(aid))
            not_started = max(0, len(created_ids) - MAX_DISCOVERY_STARTS)

        return {
            "provider": listing["provider"],
            "results": results,
            "summary": {
                "created": sum(1 for r in results if r["outcome"] == "created"),
                "skipped": sum(1 for r in results if r["outcome"] == "skipped"),
                "failed": sum(1 for r in results if r["outcome"] in ("failed", "not_found")),
            },
            "discovery_started": started,
            "discovery_not_started": not_started,
            "note": (f"Discovery was started for {len(started)} account(s). "
                     f"{not_started} more were created without a scan, to avoid running "
                     "many sweeps at once — start them from each account."
                     if not_started else None),
        }
