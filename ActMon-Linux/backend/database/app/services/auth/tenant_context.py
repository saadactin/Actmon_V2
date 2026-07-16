"""
Tenant context dependency — resolves the caller's org_id from the JWT so data
endpoints can scope reads/writes to one company.

  ctx = {"org_id": int|None, "role_id": int|None, "is_super": bool}

Super admin = role_id 1 in org 1 → sees every org (org_id filter skipped).
No / invalid token (internal or agent callers) → treated as unrestricted so
existing non-UI integrations keep working.
"""
from typing import Optional

from fastapi import Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

from app.services.auth import access_control_service as svc

_bearer = HTTPBearer(auto_error=False)


def tenant_ctx(credentials: Optional[HTTPAuthorizationCredentials] = Depends(_bearer)) -> dict:
    if not credentials:
        return {"org_id": None, "role_id": None, "is_super": True}
    try:
        claims = svc.decode_token(credentials.credentials)
    except Exception:
        return {"org_id": None, "role_id": None, "is_super": True}
    org_id = claims.get("org_id")
    role_id = claims.get("role_id")
    is_super = (role_id == 1 and org_id == 1)
    return {"org_id": org_id, "role_id": role_id, "is_super": is_super}


def scope_org_id(ctx: dict) -> Optional[int]:
    """org_id to filter reads by, or None for 'all orgs' (super / no token)."""
    return None if ctx.get("is_super") else ctx.get("org_id")


def create_org_id(ctx: dict) -> int:
    """org_id to stamp on newly created rows. Super admin / unknown → org 1."""
    if ctx.get("is_super"):
        return 1
    return ctx.get("org_id") or 1
