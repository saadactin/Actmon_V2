"""
AI Chat session API — per-user conversation history for the Chat UI's sidebar.

Every route requires a real signed-in user (`current_claims`, not the permissive
`tenant_ctx` the chat/stream endpoint itself uses) and enforces ownership at the
service layer (`chat_session_service._owned_session`) — a session id that doesn't
belong to the caller 404s rather than 403ing, so its existence can't be probed
either. This file only persists conversations; it never calls Groq or touches the
intent/knowledge/tools pipeline in `services/chatbot/`.
"""
from typing import List, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.routes.auth.auth_routes import current_claims
from app.services.chatbot import chat_session_service as svc

router = APIRouter(prefix="/api/v1/chatbot/sessions", tags=["ActMon AI Chat Sessions"])


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _org_id(claims: dict) -> int:
    """`current_claims` returns the raw decoded token (no `is_super` field —
    that's synthesized by `tenant_ctx`, which this module doesn't use since
    session ownership needs a real signed-in user, not the permissive
    no-token-required default). A session's org_id is just the owner's own org."""
    return claims.get("org_id") or 1


class CreateSessionBody(BaseModel):
    title: Optional[str] = None


class RenameSessionBody(BaseModel):
    title: str


class AppendMessageBody(BaseModel):
    role: str          # "user" | "assistant"
    content: str
    error: bool = False


def _session_out(s) -> dict:
    return {
        "id": s.id, "title": s.title, "status": s.status,
        "last_message": s.last_message, "message_count": s.message_count,
        "created_at": s.created_at.isoformat() if s.created_at else None,
        "updated_at": s.updated_at.isoformat() if s.updated_at else None,
    }


def _message_out(m) -> dict:
    return {
        "id": m.id, "role": m.role, "content": m.content, "error": m.error,
        "created_at": m.created_at.isoformat() if m.created_at else None,
    }


@router.get("")
def list_sessions(q: Optional[str] = None, db: Session = Depends(get_db), claims: dict = Depends(current_claims)):
    rows = svc.list_sessions(db, claims["user_id"], _org_id(claims), search=q)
    return {"sessions": [_session_out(s) for s in rows]}


@router.post("")
def create_session(body: CreateSessionBody, db: Session = Depends(get_db), claims: dict = Depends(current_claims)):
    s = svc.create_session(db, claims["user_id"], _org_id(claims), title=body.title)
    return _session_out(s)


@router.get("/{session_id}")
def get_session(session_id: int, db: Session = Depends(get_db), claims: dict = Depends(current_claims)):
    s, messages = svc.get_session_with_messages(db, session_id, claims["user_id"])
    return {**_session_out(s), "messages": [_message_out(m) for m in messages]}


@router.patch("/{session_id}")
def rename_session(session_id: int, body: RenameSessionBody, db: Session = Depends(get_db),
                    claims: dict = Depends(current_claims)):
    s = svc.rename_session(db, session_id, claims["user_id"], body.title)
    return _session_out(s)


@router.delete("/{session_id}")
def delete_session(session_id: int, db: Session = Depends(get_db), claims: dict = Depends(current_claims)):
    svc.delete_session(db, session_id, claims["user_id"])
    return {"deleted": session_id}


@router.post("/{session_id}/messages")
def append_message(session_id: int, body: AppendMessageBody, db: Session = Depends(get_db),
                    claims: dict = Depends(current_claims)):
    if body.role not in ("user", "assistant"):
        body.role = "assistant"
    m = svc.append_message(db, session_id, claims["user_id"], body.role, body.content, error=body.error)
    return _message_out(m)
