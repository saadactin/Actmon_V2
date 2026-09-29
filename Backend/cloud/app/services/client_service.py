"""Clients: create, rename, delete, assign accounts, and the portfolio view.

A client is a label with consequences — it decides whose monthly report an
account's bill and findings appear in — so the rules here are about keeping
that label unambiguous:

* A name is unique case-insensitively, and so is a code when one is set.
* An account belongs to at most one client. Assigning it to another client
  MOVES it, and the response says it moved and from where, so nobody quietly
  takes an account out of someone else's report.
* Deleting a client deletes its schedule and report history (they are the
  client's own artefacts) and unassigns its accounts. It never deletes an
  account or anything collected for one.
"""
from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Sequence

from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.client import CloudClient, CloudClientReport, CloudClientReportSchedule
from app.models.cloud_account import CloudAccount
from app.services import estate_summary
from app.services.alerts.notifier import valid_email

_CODE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$")


class ClientError(ValueError):
    """A request that cannot be applied, with the field it is about."""

    def __init__(self, message: str, *, field: Optional[str] = None,
                 status: int = 400) -> None:
        super().__init__(message)
        self.field = field
        self.status = status


def _clean_emails(values: Optional[Sequence[str]], field: str) -> List[str]:
    out, seen = [], set()
    for raw in values or []:
        addr = (raw or "").strip()
        if not addr:
            continue
        if not valid_email(addr):
            raise ClientError(f"{addr!r} is not a valid e-mail address.", field=field)
        if addr.lower() not in seen:
            seen.add(addr.lower())
            out.append(addr)
    return out


def _clean_fields(data: Dict[str, Any], *, partial: bool) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    if "name" in data or not partial:
        name = (data.get("name") or "").strip()
        if not name:
            raise ClientError("A client needs a name.", field="name")
        if len(name) > 255:
            raise ClientError("The name is longer than 255 characters.", field="name")
        out["name"] = name
    if "code" in data:
        code = (data.get("code") or "").strip() or None
        if code and not _CODE_RE.match(code):
            raise ClientError(
                "A code is 1-32 letters, digits, '.', '-' or '_', starting with a "
                "letter or digit.", field="code")
        out["code"] = code
    for key in ("description", "notes"):
        if key in data:
            value = (data.get(key) or "").strip() or None
            out[key] = value
    if "contact_emails" in data:
        out["contact_emails"] = _clean_emails(data.get("contact_emails"), "contact_emails")
    return out


class ClientService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    # ── CRUD ────────────────────────────────────────────────────────────────
    async def get(self, client_id: uuid.UUID) -> Optional[CloudClient]:
        return await self.db.get(CloudClient, client_id)

    async def require(self, client_id: uuid.UUID) -> CloudClient:
        client = await self.get(client_id)
        if client is None:
            raise ClientError("Client not found.", status=404)
        return client

    async def _check_unique(self, *, name: Optional[str], code: Optional[str],
                            exclude: Optional[uuid.UUID] = None) -> None:
        if name is not None:
            stmt = select(CloudClient.id).where(func.lower(CloudClient.name) == name.lower())
            if exclude:
                stmt = stmt.where(CloudClient.id != exclude)
            if (await self.db.execute(stmt)).first():
                raise ClientError(f"A client named {name!r} already exists.",
                                  field="name", status=409)
        if code:
            stmt = select(CloudClient.id).where(func.lower(CloudClient.code) == code.lower())
            if exclude:
                stmt = stmt.where(CloudClient.id != exclude)
            if (await self.db.execute(stmt)).first():
                raise ClientError(f"The code {code!r} is already used by another client.",
                                  field="code", status=409)

    async def create(self, data: Dict[str, Any], *, actor: Optional[str]) -> CloudClient:
        fields = _clean_fields(data, partial=False)
        await self._check_unique(name=fields["name"], code=fields.get("code"))
        client = CloudClient(created_by=actor, **fields)
        self.db.add(client)
        try:
            await self.db.flush()
        except IntegrityError as exc:  # a race past the check above
            await self.db.rollback()
            raise ClientError("A client with that name or code already exists.",
                              status=409) from exc
        await self.db.commit()
        return client

    async def update(self, client_id: uuid.UUID, data: Dict[str, Any]) -> CloudClient:
        client = await self.require(client_id)
        fields = _clean_fields(data, partial=True)
        await self._check_unique(name=fields.get("name"), code=fields.get("code"),
                                 exclude=client_id)
        for k, v in fields.items():
            setattr(client, k, v)
        try:
            await self.db.flush()
        except IntegrityError as exc:
            await self.db.rollback()
            raise ClientError("A client with that name or code already exists.",
                              status=409) from exc
        await self.db.commit()
        return client

    async def delete(self, client_id: uuid.UUID) -> Dict[str, Any]:
        client = await self.require(client_id)
        accounts = (await self.db.execute(
            select(CloudAccount.id).where(CloudAccount.client_id == client_id))).scalars().all()
        reports = (await self.db.execute(
            select(func.count()).select_from(CloudClientReport)
            .where(CloudClientReport.client_id == client_id))).scalar_one()
        # Unassign explicitly rather than relying on the FK's SET NULL alone, so
        # the count reported back is the count that actually changed.
        await self.db.execute(update(CloudAccount).where(
            CloudAccount.client_id == client_id).values(client_id=None))
        await self.db.delete(client)
        await self.db.commit()
        return {"deleted": True, "client_id": str(client_id), "name": client.name,
                "accounts_unassigned": len(accounts), "reports_deleted": int(reports)}

    # ── Assignment ──────────────────────────────────────────────────────────
    async def assign_accounts(self, client_id: uuid.UUID,
                              account_ids: Sequence[uuid.UUID]) -> Dict[str, Any]:
        await self.require(client_id)
        wanted = list(dict.fromkeys(account_ids))
        if not wanted:
            raise ClientError("Choose at least one account.", field="account_ids")
        rows = (await self.db.execute(
            select(CloudAccount).where(CloudAccount.id.in_(wanted)))).scalars().all()
        found = {a.id: a for a in rows}
        names = dict((await self.db.execute(
            select(CloudClient.id, CloudClient.name))).all())

        assigned, moved, unchanged = [], [], []
        for aid in wanted:
            account = found.get(aid)
            if account is None:
                continue
            if account.client_id == client_id:
                unchanged.append(str(aid))
                continue
            if account.client_id is not None:
                moved.append({"account_id": str(aid), "account_name": account.account_name,
                              "from_client_id": str(account.client_id),
                              "from_client_name": names.get(account.client_id)})
            else:
                assigned.append(str(aid))
            account.client_id = client_id
        await self.db.commit()
        return {
            "client_id": str(client_id),
            "assigned": assigned,
            "moved": moved,
            "unchanged": unchanged,
            "not_found": [str(a) for a in wanted if a not in found],
        }

    async def unassign_account(self, client_id: uuid.UUID,
                               account_id: uuid.UUID) -> Dict[str, Any]:
        await self.require(client_id)
        account = await self.db.get(CloudAccount, account_id)
        if account is None or account.client_id != client_id:
            raise ClientError("That account is not assigned to this client.", status=404)
        account.client_id = None
        await self.db.commit()
        return {"client_id": str(client_id), "account_id": str(account_id),
                "unassigned": True}

    # ── Reads ───────────────────────────────────────────────────────────────
    async def _accounts_by_client(self) -> Dict[Optional[uuid.UUID], List[uuid.UUID]]:
        grouped: Dict[Optional[uuid.UUID], List[uuid.UUID]] = {}
        for aid, cid in (await self.db.execute(
                select(CloudAccount.id, CloudAccount.client_id))).all():
            grouped.setdefault(cid, []).append(aid)
        return grouped

    async def _latest_reports(self) -> Dict[uuid.UUID, Dict[str, Any]]:
        rows = (await self.db.execute(
            select(CloudClientReport.client_id, CloudClientReport.period,
                   CloudClientReport.generated_at, CloudClientReport.status,
                   CloudClientReport.delivery_status)
            .distinct(CloudClientReport.client_id)
            .order_by(CloudClientReport.client_id, CloudClientReport.generated_at.desc())
        )).all()
        return {cid: {"period": p, "generated_at": g.isoformat() if g else None,
                      "status": s, "delivery_status": d}
                for cid, p, g, s, d in rows}

    async def portfolio(self) -> Dict[str, Any]:
        """Every client side by side, plus the accounts nobody has claimed."""
        clients = (await self.db.execute(
            select(CloudClient).order_by(func.lower(CloudClient.name)))).scalars().all()
        grouped = await self._accounts_by_client()
        all_ids = [aid for ids in grouped.values() for aid in ids]
        summaries = await estate_summary.account_summaries(self.db, all_ids)
        latest = await self._latest_reports()
        schedules = {s.client_id: s for s in (await self.db.execute(
            select(CloudClientReportSchedule))).scalars().all()}

        rows = []
        for c in clients:
            members = [summaries[a] for a in grouped.get(c.id, []) if a in summaries]
            sched = schedules.get(c.id)
            rows.append({
                "client": c.to_dict(),
                "summary": estate_summary.roll_up(members),
                "account_ids": [m["account_id"] for m in members],
                "latest_report": latest.get(c.id),
                "report_schedule": ({"enabled": bool(sched.enabled),
                                     "next_run_at": (sched.next_run_at.isoformat()
                                                     if sched.next_run_at else None)}
                                    if sched else {"enabled": False, "next_run_at": None}),
            })

        unassigned = [summaries[a] for a in grouped.get(None, []) if a in summaries]
        return {
            "clients": rows,
            "unassigned": {
                "summary": estate_summary.roll_up(unassigned),
                "accounts": sorted(unassigned, key=lambda r: r["account_name"].lower()),
            },
            "totals": estate_summary.roll_up(list(summaries.values())),
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "note": ("Posture is never averaged across accounts or clients; each client "
                     "shows its worst published score. Spend is totalled per currency, "
                     "and a currency is never converted into another."),
        }

    async def detail(self, client_id: uuid.UUID) -> Dict[str, Any]:
        client = await self.require(client_id)
        ids = (await self.db.execute(
            select(CloudAccount.id).where(CloudAccount.client_id == client_id)
            .order_by(CloudAccount.account_name))).scalars().all()
        summaries = await estate_summary.account_summaries(self.db, ids)
        accounts = [summaries[a] for a in ids if a in summaries]
        sched = await self.db.get(CloudClientReportSchedule, client_id)
        return {
            "client": client.to_dict(),
            "summary": estate_summary.roll_up(accounts),
            "accounts": accounts,
            "report_schedule": sched.to_dict() if sched else None,
            "latest_report": (await self._latest_reports()).get(client_id),
        }

    async def list_simple(self) -> List[Dict[str, Any]]:
        """Id, name, code and account count — for pickers."""
        counts = dict((await self.db.execute(
            select(CloudAccount.client_id, func.count())
            .where(CloudAccount.client_id.is_not(None))
            .group_by(CloudAccount.client_id))).all())
        clients = (await self.db.execute(
            select(CloudClient).order_by(func.lower(CloudClient.name)))).scalars().all()
        return [{"id": str(c.id), "name": c.name, "code": c.code,
                 "accounts": int(counts.get(c.id, 0))} for c in clients]
