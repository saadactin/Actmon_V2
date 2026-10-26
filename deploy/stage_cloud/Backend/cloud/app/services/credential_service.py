"""Certificates, secrets and keys: collect, persist, and serve.

Collection runs inside discovery (after the inventory, before the security
assessment, beside identity collection) and on demand. It never raises into
its caller: a refused vault is a recorded source state, which is the useful
output, and a crash is recorded as one.

Two views:

* **account** — every object and every source scope of one account, with the
  expiry buckets the UI files them under.
* **estate** — what expires across many accounts (all of them, or one
  client's), soonest first. This is the list an operations team actually
  watches, and the reason the feature exists.
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Sequence

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.cloud_account import CloudAccount
from app.models.credential_inventory import (
    COLLECT_AUTH_FAILED, COLLECT_NOT_SUPPORTED, COLLECT_OK, KIND_CERTIFICATE, KINDS,
)
from app.models.resource import CloudResource
from app.providers.credential_common import scope_result
from app.repository.credential_repo import CredentialRepository
from app.security import credentials as credx
from app.security.model import AWS, AZURE, OCI, normalize_provider

logger = logging.getLogger("cloud_svc.credentials")

# "replaced": renewed as a new certificate and no longer used (see
# credentials.supersession). Filed apart so "expired" keeps meaning "act on it".
BUCKETS = ("expired", "within_7", "within_30", "within_90", "later", "no_expiry",
           "replaced")


def _oci_load_balancers(rows: Sequence[CloudResource]) -> Dict[str, Any]:
    balancers, cert_ids, all_known = [], set(), True
    for r in rows:
        cfg = r.config or {}
        known = "listener_certificates" in cfg
        all_known = all_known and known
        cert_ids.update(cfg.get("listener_certificate_ids") or [])
        balancers.append({
            "ocid": r.provider_resource_id, "name": r.resource_name,
            "region": r.region_or_zone,
            "certificate_names_in_use": [v for v in (cfg.get("listener_certificates")
                                                     or {}).values() if v],
            "listeners_known": known,
        })
    return {"balancers": balancers, "certificate_ids_in_use": cert_ids,
            "all_listeners_known": all_known and bool(rows)}


class CredentialService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.repo = CredentialRepository(db)

    # ── Collection ──────────────────────────────────────────────────────────
    async def collect(self, account_id: uuid.UUID, *,
                      account: Optional[CloudAccount] = None) -> Dict[str, Any]:
        account = account or await self.db.get(CloudAccount, account_id)
        if account is None:
            raise ValueError(f"Account {account_id} not found")
        prov = normalize_provider(account.provider)
        from app.utils.encryption import decrypt_credentials

        try:
            creds = decrypt_credentials(account.credentials_enc)
        except Exception as exc:  # noqa: BLE001
            results = [scope_result("credentials", "account", COLLECT_AUTH_FAILED,
                                    scope_label="Stored credentials",
                                    error_detail=f"Could not be decrypted: {exc}")]
            return await self._persist(account, prov or account.provider, results)

        loop = asyncio.get_running_loop()
        try:
            if prov == AWS:
                from app.providers.aws import aws_credentials

                results = await loop.run_in_executor(None, aws_credentials.collect, creds)
            elif prov == AZURE:
                from app.providers.azure import azure_credentials

                results = await loop.run_in_executor(None, azure_credentials.collect, creds)
            elif prov == OCI:
                from app.providers.oci import oci_credentials

                lbs = (await self.db.execute(select(CloudResource).where(
                    CloudResource.account_id == account.id,
                    CloudResource.resource_type == "LoadBalancer",
                ))).scalars().all()
                inv = _oci_load_balancers(lbs)
                results = await loop.run_in_executor(
                    None, lambda: oci_credentials.collect(
                        creds, load_balancers=inv["balancers"]))
                # A Certificates-service certificate attached to a load-balancer
                # listener is in use; one not attached anywhere is not — but only
                # if every balancer's listeners were recorded, otherwise "not
                # attached to any we know of" would be a guess.
                for r in results:
                    if r["source"] == "oci:certificates":
                        for item in r["items"]:
                            if item["object_key"] in inv["certificate_ids_in_use"]:
                                item["in_use"] = True
                            elif inv["all_listeners_known"]:
                                item["in_use"] = False
            else:
                results = [scope_result("credentials", "account", COLLECT_NOT_SUPPORTED,
                                        scope_label="Certificates and secrets",
                                        error_detail=f"No collector for {account.provider}.")]
        except Exception as exc:  # noqa: BLE001 — a collector crash is a recorded state
            logger.exception("Credential collection crashed for %s", account.account_name)
            results = [scope_result("credentials", "account", "Unavailable",
                                    scope_label="Certificates and secrets",
                                    error_detail=f"The collector failed: {exc}")]
        return await self._persist(account, prov or account.provider, results)

    async def _persist(self, account: CloudAccount, provider: str,
                       results: List[Dict[str, Any]]) -> Dict[str, Any]:
        objects = ok = failed = 0
        seen_sources_ok = set()
        vault_scopes_ok: Optional[List[str]] = None
        try:
            for r in results:
                count = 0
                if r["status"] == COLLECT_OK:
                    count = await self.repo.replace_scope(
                        account_id=account.id, provider=provider, source=r["source"],
                        scope=r["scope"], specs=r["items"])
                    ok += 1
                    objects += count
                    if r["scope"] != "*":
                        seen_sources_ok.add(r["source"])
                elif r["status"] != COLLECT_NOT_SUPPORTED:
                    failed += 1
                await self.repo.record_source(account_id=account.id, provider=provider,
                                              result=r, item_count=count)
                if r["source"] == "azure:keyvault-vaults" and r["status"] == COLLECT_OK:
                    vault_scopes_ok = [x["scope"] for x in results
                                       if x["source"].startswith("azure:keyvault:")]
            # A vault the (successful) vault listing no longer returns is gone:
            # its sources and objects go with it. Never on a failed listing.
            if vault_scopes_ok is not None:
                await self.repo.forget_scopes(account_id=account.id,
                                              source_prefix="azure:keyvault:",
                                              keep_scopes=vault_scopes_ok)
            for source in seen_sources_ok:
                await self.repo.forget_placeholder(account_id=account.id, source=source)
            await self.db.commit()
        except Exception:
            await self.db.rollback()
            raise
        logger.info("Credential collection for %s: %d scope(s) read, %d failed, %d object(s)",
                    account.account_name, ok, failed, objects)
        return {"account_id": str(account.id), "scopes_ok": ok, "scopes_failed": failed,
                "objects": objects,
                "collected_at": datetime.now(timezone.utc).isoformat()}

    # ── Reads ───────────────────────────────────────────────────────────────
    @staticmethod
    def _row(obj, now: datetime, account_names: Dict[uuid.UUID, str],
             successors: Optional[Dict[str, Dict[str, Any]]] = None) -> Dict[str, Any]:
        d = obj.to_dict()
        succ = (successors or {}).get(obj.object_key)
        d["superseded_by"] = succ
        d["retired"] = credx.is_retired(obj, succ)
        d["bucket"] = ("replaced" if d["retired"]
                       else credx.expiry_bucket(obj.expires_at, now))
        d["days_left"] = (round((obj.expires_at - now).total_seconds() / 86400.0, 1)
                          if obj.expires_at else None)
        d["account_name"] = account_names.get(obj.account_id)
        d["source_label"] = credx.SOURCE_LABEL.get(obj.source, obj.source)
        return d

    async def account_view(self, account_id: uuid.UUID) -> Dict[str, Any]:
        account = await self.db.get(CloudAccount, account_id)
        if account is None:
            raise ValueError("Account not found")
        now = datetime.now(timezone.utc)
        objects = await self.repo.objects([account_id])
        sources = await self.repo.sources([account_id])
        names = {account.id: account.account_name}
        successors = credx.supersession(objects, now)
        rows = [self._row(o, now, names, successors) for o in objects]
        analysis = credx.analyse(provider=normalize_provider(account.provider) or "",
                                 objects=objects, sources=sources, now=now)
        return {
            "account_id": str(account_id),
            "account_name": account.account_name,
            "provider": normalize_provider(account.provider) or account.provider,
            "objects": rows,
            "sources": [dict(s.to_dict(),
                             source_label=credx.SOURCE_LABEL.get(s.source, s.source))
                        for s in sources],
            "summary": _summary(rows, sources),
            "risks": len(analysis.risks),
            "never_collected": not sources,
            "thresholds": {"expiring_days": credx.EXPIRY_WINDOW_DAYS,
                           "urgent_days": credx.URGENT_DAYS},
            "note": ("Certificates, secrets and keys are listed from each provider's own "
                     "stores. Only metadata is read — never a secret value or private "
                     "key. A store that could not be read keeps its last known objects "
                     "and says so; it is never reported as empty."),
        }

    async def estate_view(self, *, account_ids: Optional[Sequence[uuid.UUID]] = None,
                          within_days: int = 90, kinds: Optional[Sequence[str]] = None,
                          include_no_expiry: bool = False,
                          include_replaced: bool = False) -> Dict[str, Any]:
        stmt = select(CloudAccount)
        if account_ids is not None:
            stmt = stmt.where(CloudAccount.id.in_(list(account_ids)))
        accounts = (await self.db.execute(stmt)).scalars().all()
        names = {a.id: a.account_name for a in accounts}
        ids = list(names)
        now = datetime.now(timezone.utc)
        objects = await self.repo.objects(ids)
        sources = await self.repo.sources(ids)
        wanted = set(k.upper() for k in (kinds or KINDS))
        successors = credx.supersession(objects, now)
        rows = []
        for o in objects:
            if o.kind not in wanted or o.enabled is False:
                continue
            if o.expires_at is None:
                if include_no_expiry:
                    rows.append(self._row(o, now, names, successors))
                continue
            if (credx.is_retired(o, successors.get(o.object_key))
                    and not include_replaced):
                continue
            if (o.expires_at - now).total_seconds() / 86400.0 <= within_days:
                rows.append(self._row(o, now, names, successors))
        rows.sort(key=lambda r: (r["days_left"] is None, r["days_left"] or 0))
        per_account = []
        for a in accounts:
            srcs = [s for s in sources if s.account_id == a.id]
            per_account.append({
                "account_id": str(a.id), "account_name": a.account_name,
                "provider": normalize_provider(a.provider) or a.provider,
                "sources_total": len(srcs),
                "sources_failing": sum(1 for s in srcs
                                       if s.status not in (COLLECT_OK, COLLECT_NOT_SUPPORTED)),
                "never_collected": not srcs,
                "last_attempt_at": max((s.last_attempt_at for s in srcs
                                        if s.last_attempt_at), default=None),
            })
        for p in per_account:
            p["last_attempt_at"] = p["last_attempt_at"].isoformat() if p["last_attempt_at"] else None
        all_rows = [self._row(o, now, names, successors)
                    for o in objects if o.enabled is not False]
        return {
            "within_days": within_days,
            "objects": rows[:2000],
            "truncated": len(rows) > 2000,
            "summary": _summary(all_rows, sources),
            "accounts": per_account,
            "generated_at": now.isoformat(),
        }


def _summary(rows: Sequence[Dict[str, Any]], sources: Sequence[Any]) -> Dict[str, Any]:
    by_bucket = {b: 0 for b in BUCKETS}
    by_kind = {k: 0 for k in KINDS}
    for r in rows:
        if r.get("enabled") is False:
            continue
        by_bucket[r["bucket"]] = by_bucket.get(r["bucket"], 0) + 1
        by_kind[r["kind"]] = by_kind.get(r["kind"], 0) + 1
    failing = [s for s in sources if s.status not in (COLLECT_OK, COLLECT_NOT_SUPPORTED)]
    return {
        "by_bucket": by_bucket,
        "by_kind": by_kind,
        "certificates": by_kind.get(KIND_CERTIFICATE, 0),
        # Certificates a valid renewal already covers, whatever their use — the
        # ones still bound stay in their expiry bucket and are counted here too.
        "superseded": sum(1 for r in rows if r.get("superseded_by")
                          and r.get("enabled") is not False),
        "sources_total": len(sources),
        "sources_ok": sum(1 for s in sources if s.status == COLLECT_OK),
        "sources_failing": len(failing),
        "sources_actionable": sum(1 for s in failing
                                  if s.status in ("PermissionDenied", "AuthenticationFailed",
                                                  "BlockedByNetwork")),
        # Certificates a store listed but that would not parse: they have no
        # known expiry and are not in the list above, so they are counted here.
        "certificates_unreadable": sum(int((s.container or {}).get("unreadable_certificates")
                                           or 0) for s in sources if s.status == COLLECT_OK),
    }
