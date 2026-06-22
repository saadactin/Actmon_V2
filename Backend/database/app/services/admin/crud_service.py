"""
Generic Admin CRUD service.

Reads  → a view (vw_*).
Writes → JSONB stored procedures (sp_insert* / sp_update* / sp_delete*).
One implementation drives every master entity; nothing entity-specific here.
"""
import json

from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session


def list_rows(db: Session, view: str, order_by: str, org_id=None) -> list[dict]:
    if org_id is not None:
        rows = db.execute(text(f"SELECT * FROM {view} WHERE org_id = :o ORDER BY {order_by}"),
                          {"o": org_id}).mappings().all()
    else:
        rows = db.execute(text(f"SELECT * FROM {view} ORDER BY {order_by}")).mappings().all()
    return [dict(r) for r in rows]


def get_row(db: Session, view: str, pk: str, pk_val) -> dict:
    row = db.execute(text(f"SELECT * FROM {view} WHERE {pk} = :i"), {"i": pk_val}).mappings().first()
    if not row:
        raise HTTPException(status_code=404, detail="Record not found")
    return dict(row)


def _set_audit_context(db: Session, payload: dict, ctx: dict | None) -> None:
    """Set session vars the audit trigger reads (acting user / ip / agent / org)."""
    ctx = ctx or {}
    # Only a REAL authenticated user_id goes to the audit row (FK to user_master).
    # Unknown → NULL (empty string), never a placeholder id.
    user_id = ctx.get("user_id")
    org_id = ctx.get("org_id") or payload.get("org_id")
    db.execute(text(
        "SELECT set_config('app.user_id', :u, true), set_config('app.ip', :ip, true), "
        "       set_config('app.user_agent', :ua, true), set_config('app.org_id', :o, true)"
    ), {"u": "" if not user_id else str(user_id), "ip": str(ctx.get("ip") or ""),
        "ua": str(ctx.get("user_agent") or "")[:500], "o": "" if org_id is None else str(org_id)})


def call_sp(db: Session, proc: str, payload: dict, ctx: dict | None = None) -> None:
    """CALL a JSONB stored procedure (audit context set first); RAISE → HTTP 400."""
    try:
        _set_audit_context(db, payload, ctx)
        db.execute(text(f"CALL {proc}(CAST(:j AS jsonb))"), {"j": json.dumps(payload, default=str)})
        db.commit()
    except Exception as e:  # noqa: BLE001
        db.rollback()
        diag = getattr(getattr(e, "orig", None), "diag", None)
        detail = getattr(diag, "message_primary", None) if diag else None
        raise HTTPException(status_code=400, detail=detail or "Operation failed")
