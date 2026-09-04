"""Re-apply the current classification rules to change rows already on file.

The change log stores the pillar, severity, direction and summary that the rules
produced at write time. When a rule is corrected, existing rows keep the old
verdict — so a finding known to be wrong stays on the page.

This re-runs classify_field_change / describe_field_change over stored rows and
updates only those derived columns. The observed facts (which field moved, from
what to what, when, and on which resource) are never touched: those were real
observations and are not ours to rewrite.

Usage:
    python tests/reclassify_drift.py            # report what would change
    python tests/reclassify_drift.py --apply    # write the corrections
"""
from __future__ import annotations

import asyncio
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from sqlalchemy import select

from app.models.cloud_account import CloudAccount  # noqa: F401
from app.models.drift import CloudResourceChange
from app.models.resource import CloudResource  # noqa: F401
from app.utils.drift_rules import (
    CHANGE_MODIFIED,
    classify_field_change,
    describe_field_change,
)

APPLY = "--apply" in sys.argv

# The stored values are already rendered strings ("-" for empty, "2 items" for a
# collection). Re-classifying from those is lossy in general, but it is exact for
# the case this exists to fix: whether one side was unreadable. "-" is what
# render_value emits for None/empty, and the sentinels are stored verbatim.
_EMPTY_RENDERED = {"-", "", "(empty)"}


def _unrender(value: str | None):
    """Best-effort inverse of render_value, for classification purposes only."""
    if value is None or value.strip() in _EMPTY_RENDERED:
        return None
    return value


async def main() -> None:
    from app.core.database import AsyncSessionLocal

    async with AsyncSessionLocal() as db:
        rows = list((await db.execute(
            select(CloudResourceChange)
            .where(CloudResourceChange.change_type == CHANGE_MODIFIED)
            .order_by(CloudResourceChange.detected_at)
        )).scalars().all())

        print(f"{len(rows)} MODIFIED row(s) on file\n")
        changed = 0
        for r in rows:
            if not r.field_path:
                continue
            old = _unrender(r.old_value)
            new = _unrender(r.new_value)
            pillars, severity, direction = classify_field_change(r.field_path, old, new)
            summary = describe_field_change(
                r.resource_type, r.field_path, old, new, direction
            )
            before = (r.severity, r.direction, tuple(r.impact or ()))
            after = (severity, direction, tuple(pillars))
            # Only the verdict is compared. The summary is regenerated from
            # values that were ALREADY rendered once, so re-rendering them is
            # lossy ("1 item" cannot be turned back into the original list) —
            # rewriting a summary whose verdict did not change would replace
            # accurate original text with a worse approximation.
            if before == after:
                continue
            changed += 1
            print(f"  {r.resource_type}/{r.resource_name} {r.field_path}")
            print(f"    {r.old_value} -> {r.new_value}")
            print(f"    was: {before[0]:8s} {str(before[1]):10s} {list(before[2])}")
            print(f"    now: {after[0]:8s} {str(after[1]):10s} {list(after[2])}")
            if APPLY:
                r.severity = severity
                r.direction = direction
                r.impact = pillars
                r.summary = summary
            print()

        if APPLY and changed:
            await db.commit()
            print(f"APPLIED: {changed} row(s) re-classified.")
        elif changed:
            print(f"DRY RUN: {changed} row(s) would change. Re-run with --apply.")
        else:
            print("Every row already matches the current rules.")


asyncio.run(main())
