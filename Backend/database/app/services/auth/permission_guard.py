"""
Backend RBAC enforcement — a FastAPI dependency wrapping the same
page-scoped-bitmask permission model `access_control_service.py` already
implements for the frontend (`validate_access`, `get_permission_catalog`).

Until now, permission bits (view/add/edit/delete/execute/export/restart/...)
were only ever checked client-side (`usePermissions.js`'s `canHere()`) — no
backend route enforced them, so a permission the UI hid was still reachable
by calling the API directly. This closes that gap for whichever routes
opt in via `Depends(require_permission(page_url, action))`.

`page_url` is always the literal `page_master.page_url` pattern for the
route being protected (e.g. "/infra/:id") — never derived from the live
request path. `validate_access()`'s lookup is an exact SQL string match,
while the frontend's own `usePermissions.js` (`toRe()`) turns that same
stored pattern into a regex to match a resolved path like "/infra/1". A
backend route already knows statically which page it belongs to, so it
passes the same literal pattern the DB actually stores — no need to teach
the backend query to do :param regex matching too.

Lives in its own module (not inside `access_control_service.py`) to avoid a
circular import: `auth_routes.py` imports `access_control_service` as
`svc`, and `current_claims` (the bearer-token dependency) lives in
`auth_routes.py` — this module imports `current_claims` from there, so it
cannot itself be imported back into `access_control_service.py`.
"""
from fastapi import Depends, HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.routes.auth.auth_routes import current_claims
from app.services.auth.access_control_service import validate_access


def _get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def check_permission(claims: dict, db: Session, page_url: str, action: str) -> None:
    """The actual check, as a plain function — for the handful of routes
    where the required action depends on the request BODY (e.g. one
    /service-action endpoint handling start/stop with 'execute' and restart
    with 'restart'), so it can't be resolved as a static per-route
    dependency before that body is parsed. Raises HTTPException; returns
    nothing on success. `require_permission()` below is a thin Depends()
    wrapper around this for the common (static, body-independent) case."""
    bit = db.execute(
        text(
            "SELECT permission_value FROM permission "
            "WHERE lower(permission_name) = lower(:name) AND is_active = true LIMIT 1"
        ),
        {"name": action},
    ).scalar()
    if bit is None:
        # A typo'd action name is a bug in the route, not a real 403 —
        # fail loudly rather than silently letting everyone through.
        raise HTTPException(status_code=500, detail=f"Unknown permission action '{action}'")

    result = validate_access(db, claims["org_id"], claims["role_id"], page_url, required=int(bit))
    if not result["allowed"]:
        raise HTTPException(
            status_code=403,
            detail=f"You don't have '{action}' permission on {page_url}",
        )


def require_permission(page_url: str, action: str = "view"):
    """FastAPI dependency factory for the common case: the action needed is
    fixed for this route, known up front. Stacks alongside whatever else a
    route already depends on (e.g. the existing password re-auth checks) —
    it only adds the RBAC gate, it doesn't replace anything."""

    def _check(claims: dict = Depends(current_claims), db: Session = Depends(_get_db)):
        check_permission(claims, db, page_url, action)
        return claims

    return _check
