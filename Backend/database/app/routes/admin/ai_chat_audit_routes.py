"""
Super Admin → AI Chat Sessions audit — read-only, RBAC-gated view across users'
conversations. Separate from the per-user `chat_session_routes.py` (which enforces
OWNERSHIP for a normal user's own sessions) — this file enforces a PERMISSION BIT
instead, via the same `permission_guard.require_permission` dependency every other
RBAC-gated route in this app already uses (never bypassed, never frontend-only).

A non-super admin holding this permission only ever sees their OWN org's sessions,
even if they pass a different `org_id` query param — only the true super admin
(role_id 1 in org 1, the same convention used everywhere else in this app) can
cross org boundaries.
"""
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.services.auth.permission_guard import require_permission
from app.services.chatbot import chat_session_service as svc

router = APIRouter(prefix="/api/v1/admin/ai-chat-sessions", tags=["Admin — AI Chat Audit"])

AI_CHAT_SESSIONS_PAGE = "/ai-chat-sessions"


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _is_super(claims: dict) -> bool:
    return claims.get("role_id") == 1 and claims.get("org_id") == 1


@router.get("")
def list_chat_sessions(
    user_id: Optional[int] = None,
    org_id: Optional[int] = None,
    q: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    db: Session = Depends(get_db),
    claims: dict = Depends(require_permission(AI_CHAT_SESSIONS_PAGE, "view")),
):
    effective_org_id = org_id if _is_super(claims) else claims.get("org_id")
    df = datetime.fromisoformat(date_from) if date_from else None
    dt = datetime.fromisoformat(date_to) if date_to else None
    data = svc.admin_list_sessions(db, org_id=effective_org_id, user_id=user_id, search=q,
                                    date_from=df, date_to=dt)
    return {"data": data}


@router.get("/{session_id}/messages")
def get_chat_session_messages(
    session_id: int,
    db: Session = Depends(get_db),
    claims: dict = Depends(require_permission(AI_CHAT_SESSIONS_PAGE, "view")),
):
    from app.models.chat_session_model import ChatSession

    session = db.query(ChatSession).filter(ChatSession.id == session_id).first()
    if not session:
        raise HTTPException(status_code=404, detail="Conversation not found")
    if not _is_super(claims) and session.org_id != claims.get("org_id"):
        raise HTTPException(status_code=404, detail="Conversation not found")

    messages = svc.admin_get_messages(db, session_id)
    return {
        "session": {"id": session.id, "title": session.title, "user_id": session.user_id, "org_id": session.org_id},
        "messages": [
            {"id": m.id, "role": m.role, "content": m.content, "error": m.error,
             "created_at": m.created_at.isoformat() if m.created_at else None}
            for m in messages
        ],
    }
