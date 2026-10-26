"""
Every timestamp column in this app is a naive `DateTime` populated via
`datetime.utcnow()` — it IS UTC, but carries no timezone marker. Naive
`datetime.isoformat()` therefore omits the offset entirely (e.g.
"2026-08-10T08:37:12" with no 'Z' or '+00:00'), and a browser doing
`new Date(thatString)` interprets a marker-less date-time string as LOCAL
time, silently shifting the displayed time by the browser's UTC offset.

Use `iso_utc()` wherever a naive-but-actually-UTC datetime is serialized for
an API response, so the frontend parses it correctly.
"""
from datetime import datetime, timezone
from typing import Optional


def iso_utc(dt: Optional[datetime]) -> Optional[str]:
    if dt is None:
        return None
    # Some columns are timezone-AWARE (timestamptz, e.g. agent_notifications.created_at). Appending "Z" to
    # their isoformat() produced "…+05:30Z" — not a valid timestamp. Convert those to UTC first; naive
    # (already-UTC) values are formatted exactly as before.
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt.isoformat() + "Z"
