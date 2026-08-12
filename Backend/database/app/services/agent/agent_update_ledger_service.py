"""
Agent upgrade ledger — proves an update landed instead of assuming it did.

Pushing an update used to be fire-and-forget: the server queued a `selfupdate`
job, the UI said "update scheduled", and nothing ever checked whether the new
build actually came up. A silently-failed upgrade (msiexec error, checksum
mismatch, service that never restarted) was indistinguishable from success.

This records the intent — "agent X should be on version Y" — and closes the loop
against what the agent itself reports afterwards, via either its boot ping or its
next infra push.

Deliberate design points:

* `GRACE_SECONDS` — an infra push already in flight when the update was issued
  carries the OLD version and would otherwise instantly fail the upgrade. Reports
  arriving within the grace window are ignored rather than judged.
* `TIMEOUT_SECONDS` is evaluated lazily on read, not by a background sweeper.
  One less thread, and a stale row costs nothing until someone looks at it.
* An agent reporting a version *different* from the expected one is
  `version_mismatch`, NOT `completed` — an upgrade that ran and produced the
  wrong build is a failure that has to be visible, not rounded up to success.
"""
import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import text
from sqlalchemy.orm import Session

logger = logging.getLogger("agent_update_ledger")

# Ignore version reports that arrive within this window of the push — they are
# almost certainly from a cycle that started before the upgrade was issued.
GRACE_SECONDS = 300      # 5 min
# No confirmation after this long => the upgrade is considered to have failed.
TIMEOUT_SECONDS = 1200   # 20 min

OPEN_STATES = ("pending", "installing")


def _now():
    return datetime.now(timezone.utc)


def issue(db: Session, agent_name: str, expected_version: str,
          from_version: str = None, issued_by: int = None) -> dict:
    """Record that an upgrade to `expected_version` has just been pushed.

    Any older open row for this agent is closed as superseded first, so a
    re-push never leaves two rows both claiming to be the live attempt.
    """
    db.execute(text(
        "UPDATE agent_pending_update SET status='superseded', "
        "detail=COALESCE(detail,'') || ' (superseded by a newer push)' "
        "WHERE agent_name=:n AND status = ANY(:open)"),
        {"n": agent_name, "open": list(OPEN_STATES)})
    db.execute(text(
        "INSERT INTO agent_pending_update "
        "(agent_name, expected_version, from_version, status, issued_at, issued_by) "
        "VALUES (:n, :ev, :fv, 'pending', now(), :by)"),
        {"n": agent_name, "ev": expected_version or None,
         "fv": from_version or None, "by": issued_by})
    db.commit()
    logger.info("[update] issued %s -> %s (from %s)", agent_name, expected_version, from_version)
    return {"status": "pending", "expected_version": expected_version}


def mark_delivered(db: Session, agent_name: str, detail: str = None) -> None:
    """The agent accepted the job (MSI scheduled / source swapped)."""
    db.execute(text(
        "UPDATE agent_pending_update SET status='installing', delivered_at=now(), "
        "detail=:d WHERE agent_name=:n AND status='pending'"),
        {"n": agent_name, "d": detail})
    db.commit()


def mark_failed(db: Session, agent_name: str, reason: str) -> None:
    """The agent reported the attempt failed outright (checksum, msiexec, …)."""
    db.execute(text(
        "UPDATE agent_pending_update SET status='failed', confirmed_at=now(), detail=:d "
        "WHERE agent_name=:n AND status = ANY(:open)"),
        {"n": agent_name, "d": (reason or "")[:2000], "open": list(OPEN_STATES)})
    db.commit()


def record_version(db: Session, agent_name: str, reported_version: str) -> None:
    """Called whenever an agent tells us its version (boot ping / infra push).

    Always stamps agents.agent_version, then closes any open ledger row this
    report resolves. Never raises — this sits on the ingest hot path.
    """
    if not agent_name:
        return
    try:
        db.execute(text(
            "UPDATE agents SET agent_version=:v, agent_version_seen_at=now() "
            "WHERE agent_name=:n"),
            {"v": (reported_version or None), "n": agent_name})

        row = db.execute(text(
            "SELECT id, expected_version, issued_at FROM agent_pending_update "
            "WHERE agent_name=:n AND status = ANY(:open) "
            # id DESC, not issued_at DESC — the most recently INSERTED row is the
            # live attempt. Ordering on a timestamp column lets clock skew (or a
            # backdated row) silently resolve to an older attempt instead.
            "ORDER BY id DESC LIMIT 1"),
            {"n": agent_name, "open": list(OPEN_STATES)}).first()
        if not row:
            db.commit()
            return

        pu_id, expected, issued_at = row
        if issued_at and (_now() - issued_at).total_seconds() < GRACE_SECONDS \
                and (reported_version or "") != (expected or ""):
            # Still inside the grace window and not yet the new version — this is
            # very likely a pre-update cycle reporting late. Don't judge it.
            db.commit()
            return

        if expected and (reported_version or "") == expected:
            new_status, detail = "completed", None
        elif expected:
            new_status = "version_mismatch"
            detail = (f"Upgrade finished but the agent reports {reported_version or 'no version'}, "
                      f"not the expected {expected}.")
        else:
            # No target recorded (older push) — any report closes it.
            new_status, detail = "completed", None

        db.execute(text(
            "UPDATE agent_pending_update SET status=:s, confirmed_at=now(), "
            "confirmed_version=:cv, detail=COALESCE(:d, detail) WHERE id=:id"),
            {"s": new_status, "cv": (reported_version or None), "d": detail, "id": pu_id})
        db.commit()
        logger.info("[update] %s -> %s (reported %s, expected %s)",
                    agent_name, new_status, reported_version, expected)
    except Exception as e:  # noqa: BLE001 — version reporting must never break ingest
        db.rollback()
        logger.warning("[update] record_version failed for %s: %s", agent_name, e)


def status_for(db: Session, agent_name: str) -> dict:
    """Latest ledger state for one agent, timing out stale rows lazily on read."""
    row = db.execute(text(
        "SELECT id, expected_version, from_version, status, detail, issued_at, "
        "delivered_at, confirmed_at, confirmed_version "
        # id DESC for the same reason as in record_version above.
        "FROM agent_pending_update WHERE agent_name=:n ORDER BY id DESC LIMIT 1"),
        {"n": agent_name}).first()
    if not row:
        return {"has_update": False}

    (pu_id, expected, from_v, status, detail, issued_at,
     delivered_at, confirmed_at, confirmed_v) = row

    if status in OPEN_STATES and issued_at and \
            (_now() - issued_at).total_seconds() > TIMEOUT_SECONDS:
        status = "timed_out"
        detail = (detail or "") + (
            f" No confirmation within {TIMEOUT_SECONDS // 60} minutes — the agent never "
            f"reported back on the new version.")
        try:
            db.execute(text(
                "UPDATE agent_pending_update SET status='timed_out', detail=:d WHERE id=:id"),
                {"d": detail.strip(), "id": pu_id})
            db.commit()
        except Exception:  # noqa: BLE001
            db.rollback()

    return {
        "has_update": True, "status": status,
        "expected_version": expected, "from_version": from_v,
        "confirmed_version": confirmed_v, "detail": (detail or "").strip() or None,
        "issued_at": issued_at.isoformat() if issued_at else None,
        "delivered_at": delivered_at.isoformat() if delivered_at else None,
        "confirmed_at": confirmed_at.isoformat() if confirmed_at else None,
    }
