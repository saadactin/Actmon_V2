"""Saved Resources views — list, save, update, delete.

The only interesting part is validation. A saved view holds a filter set that
the query layer will later be asked to execute, so it is checked against that
layer's own vocabulary on the way in AND on the way out:

  * on the way in, so a view cannot be saved that would fail when applied;
  * on the way out, because the vocabulary can change after a view is stored.
    A filter that no longer exists is dropped and reported, rather than taken
    to the query layer where it would raise and make the whole view unusable.

Dropping is the right failure here: a view that opens with four of its five
filters and says so is more useful than one that refuses to open at all.
"""
from __future__ import annotations

import logging
import uuid
from typing import Any, Dict, List, Optional, Sequence, Tuple

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.resource_view import UNATTRIBUTED, SavedResourceView
from app.repository.resource_query_repo import (
    GROUP_FIELDS, SORT_FIELDS, QueryValidationError, build_query,
)

logger = logging.getLogger("cloud_svc.resource_views")

ALL_SCOPE = "ALL"

# Filter keys a view may carry. Deliberately the query layer's own parameter
# names, so a saved view is literally a stored request rather than a second
# dialect that has to be translated.
FILTER_KEYS: Tuple[str, ...] = (
    "q", "provider", "type", "category", "region", "status", "risk",
    "environment", "owner", "resource_group", "compartment", "attachment",
    "has_tags", "tag_key", "tag_value", "missing_tag", "has_cost",
    "cost_min", "cost_max", "has_findings", "stale", "include_defaults",
)

MAX_NAME = 120
MAX_VIEWS_PER_OWNER = 100


class ViewValidationError(ValueError):
    def __init__(self, field: str, message: str) -> None:
        super().__init__(message)
        self.field_name = field


class ResourceViewService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    # ── Read ─────────────────────────────────────────────────────────────────
    async def list_views(
        self, owner: str, scope: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """Views this caller can use here.

        A view saved against one account is offered in that account and in the
        cross-account view, never against a different account — the filters
        would apply but the answer would be about the wrong estate.
        """
        stmt = select(SavedResourceView).order_by(SavedResourceView.name)
        rows = list((await self.db.execute(stmt)).scalars().all())

        def visible(view: SavedResourceView) -> bool:
            if owner and view.owner and view.owner != owner:
                # Views are per-owner today. Sharing is a product decision
                # nobody has made, and guessing it here would expose one
                # person's saved queries to everyone.
                return False
            if scope is None:
                return True
            if view.scope == ALL_SCOPE or scope == ALL_SCOPE:
                return True
            return view.scope == scope

        return [self._serialize(v) for v in rows if visible(v)]

    async def get(self, view_id: uuid.UUID) -> Optional[SavedResourceView]:
        return (await self.db.execute(
            select(SavedResourceView).where(SavedResourceView.id == view_id)
        )).scalar_one_or_none()

    # ── Write ────────────────────────────────────────────────────────────────
    async def save(
        self,
        *,
        owner: str,
        name: str,
        scope: str,
        filters: Dict[str, Any],
        description: Optional[str] = None,
        columns: Optional[Sequence[str]] = None,
        sort: Optional[str] = None,
        direction: Optional[str] = None,
        group_by: Optional[str] = None,
    ) -> Dict[str, Any]:
        clean_name = (name or "").strip()
        if not clean_name:
            raise ViewValidationError("name", "A saved view needs a name.")
        if len(clean_name) > MAX_NAME:
            raise ViewValidationError(
                "name", f"A view name may be at most {MAX_NAME} characters."
            )

        owner_key = owner or UNATTRIBUTED
        clean_filters, dropped = self._validate_filters(filters)
        if dropped:
            raise ViewValidationError(
                "filters",
                "These filters are not recognised: " + ", ".join(sorted(dropped)),
            )
        if sort and sort not in SORT_FIELDS:
            raise ViewValidationError("sort", f"{sort!r} is not a sortable field.")
        if group_by and group_by not in GROUP_FIELDS:
            raise ViewValidationError("group_by", f"{group_by!r} is not a group field.")
        if direction and direction.lower() not in ("asc", "desc"):
            raise ViewValidationError("dir", "Direction must be asc or desc.")

        existing = (await self.db.execute(
            select(SavedResourceView).where(
                SavedResourceView.owner == owner_key,
                SavedResourceView.name == clean_name,
            )
        )).scalar_one_or_none()

        if existing is None:
            count = len(await self.list_views(owner_key))
            if count >= MAX_VIEWS_PER_OWNER:
                raise ViewValidationError(
                    "name",
                    f"You already have {MAX_VIEWS_PER_OWNER} saved views; delete one first.",
                )
            existing = SavedResourceView(owner=owner_key, name=clean_name)
            self.db.add(existing)

        existing.description = description
        existing.scope = scope or ALL_SCOPE
        existing.filters = clean_filters
        existing.columns = list(columns) if columns else None
        existing.sort = sort
        existing.direction = (direction or "").lower() or None
        existing.group_by = group_by

        await self.db.flush()
        await self.db.commit()
        await self.db.refresh(existing)
        return self._serialize(existing)

    async def delete(self, view_id: uuid.UUID, owner: str) -> bool:
        view = await self.get(view_id)
        if view is None:
            return False
        if view.owner and owner and view.owner != owner:
            raise ViewValidationError("id", "That view belongs to someone else.")
        await self.db.delete(view)
        await self.db.commit()
        return True

    # ── Internals ────────────────────────────────────────────────────────────
    def _validate_filters(
        self, filters: Optional[Dict[str, Any]]
    ) -> Tuple[Dict[str, Any], List[str]]:
        """Keep the filters the query layer understands; name the rest."""
        given = filters if isinstance(filters, dict) else {}
        clean: Dict[str, Any] = {}
        dropped: List[str] = []
        for key, value in given.items():
            if key not in FILTER_KEYS:
                dropped.append(key)
                continue
            if value is None or value == [] or value == "":
                continue
            clean[key] = value

        # Build it once for real. This is what turns "these key names look
        # plausible" into "the query layer accepts this exact request", and it
        # is why an invalid status or risk level is refused at save time rather
        # than the first time someone opens the view.
        if clean:
            try:
                build_query(account_ids=[], assessed_account_ids=[], **clean)
            except QueryValidationError as exc:
                raise ViewValidationError(exc.field_name or "filters", str(exc))
        return clean, dropped

    def _serialize(self, view: SavedResourceView) -> Dict[str, Any]:
        stored = view.filters if isinstance(view.filters, dict) else {}
        usable, dropped = {}, []
        for key, value in stored.items():
            (usable.__setitem__(key, value) if key in FILTER_KEYS
             else dropped.append(key))
        return {
            "id": str(view.id),
            "name": view.name,
            "description": view.description,
            "owner": view.owner or None,
            "scope": view.scope,
            "filters": usable,
            # Named, not hidden. A view that quietly lost a filter would return
            # more rows than it used to and look like it still worked.
            "dropped_filters": sorted(dropped),
            "columns": view.columns,
            "sort": view.sort,
            "dir": view.direction,
            "group_by": view.group_by,
            "created_at": view.created_at.isoformat() if view.created_at else None,
            "updated_at": view.updated_at.isoformat() if view.updated_at else None,
        }
