"""
AI Chat session/message persistence service.

Pure storage + ownership enforcement — no Groq/AI calls here at all. The frontend
calls these functions (via chat_session_routes.py) around the existing, unchanged
`/chatbot/chat/stream` endpoint: create/open a session, persist the user's message,
stream the answer through the untouched AI pipeline, then persist the assistant's
final text once the stream completes.

Ownership is enforced here, not just filtered in the frontend: every read/write on
a specific session goes through `_owned_session()`, which 404s if the row doesn't
belong to the caller — a user can never reach another user's session by guessing
or reusing an id, regardless of what the UI shows.
"""
from datetime import datetime

from fastapi import HTTPException
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.models.chat_session_model import ChatSession, ChatMessage

_TITLE_MAX = 60


def _title_from(text: str) -> str:
    t = " ".join((text or "").split())
    if not t:
        return "New chat"
    return t[:_TITLE_MAX] + "…" if len(t) > _TITLE_MAX else t


def create_session(db: Session, user_id: int, org_id: int, title: str = None) -> ChatSession:
    s = ChatSession(org_id=org_id, user_id=user_id, title=(title or "New chat").strip()[:255] or "New chat")
    db.add(s)
    db.commit()
    db.refresh(s)
    return s


def _owned_session(db: Session, session_id: int, user_id: int) -> ChatSession:
    s = (
        db.query(ChatSession)
        .filter(ChatSession.id == session_id, ChatSession.user_id == user_id, ChatSession.status == "active")
        .first()
    )
    if not s:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return s


def list_sessions(db: Session, user_id: int, org_id: int, search: str = None) -> list:
    q = db.query(ChatSession).filter(
        ChatSession.user_id == user_id, ChatSession.org_id == org_id, ChatSession.status == "active",
    )
    if search:
        like = f"%{search}%"
        matching_ids = (
            db.query(ChatMessage.session_id)
            .join(ChatSession, ChatMessage.session_id == ChatSession.id)
            .filter(ChatSession.user_id == user_id, ChatMessage.content.ilike(like))
            .subquery()
        )
        q = q.filter(or_(ChatSession.title.ilike(like), ChatSession.id.in_(matching_ids)))
    return q.order_by(ChatSession.updated_at.desc()).all()


def get_session_with_messages(db: Session, session_id: int, user_id: int) -> tuple:
    s = _owned_session(db, session_id, user_id)
    messages = (
        db.query(ChatMessage)
        .filter(ChatMessage.session_id == session_id)
        .order_by(ChatMessage.created_at.asc())
        .all()
    )
    return s, messages


def rename_session(db: Session, session_id: int, user_id: int, title: str) -> ChatSession:
    s = _owned_session(db, session_id, user_id)
    clean = (title or "").strip()[:255]
    if clean:
        s.title = clean
        db.commit()
        db.refresh(s)
    return s


def delete_session(db: Session, session_id: int, user_id: int) -> None:
    s = _owned_session(db, session_id, user_id)
    s.status = "deleted"
    db.commit()


def append_message(db: Session, session_id: int, user_id: int, role: str, content: str, error: bool = False) -> ChatMessage:
    s = _owned_session(db, session_id, user_id)
    m = ChatMessage(session_id=session_id, role=role, content=content or "", error=error)
    db.add(m)
    s.message_count = (s.message_count or 0) + 1
    s.last_message = (content or "")[:500]
    s.updated_at = datetime.utcnow()
    if s.message_count == 1 and role == "user":
        s.title = _title_from(content)
    db.commit()
    db.refresh(m)
    return m


# ── Super Admin audit ─────────────────────────────────────────────────────────

def admin_list_sessions(db: Session, org_id: int = None, user_id: int = None, search: str = None,
                         date_from=None, date_to=None, limit: int = 300) -> list:
    from app.models.admin_models import UserMaster, OrganizationMaster

    q = (
        db.query(ChatSession, UserMaster.user_name, OrganizationMaster.org_name)
        .join(UserMaster, ChatSession.user_id == UserMaster.user_id)
        .join(OrganizationMaster, ChatSession.org_id == OrganizationMaster.org_id)
        .filter(ChatSession.status == "active")
    )
    if org_id is not None:
        q = q.filter(ChatSession.org_id == org_id)
    if user_id is not None:
        q = q.filter(ChatSession.user_id == user_id)
    if date_from is not None:
        q = q.filter(ChatSession.created_at >= date_from)
    if date_to is not None:
        q = q.filter(ChatSession.created_at <= date_to)
    if search:
        like = f"%{search}%"
        matching_ids = db.query(ChatMessage.session_id).filter(ChatMessage.content.ilike(like)).subquery()
        q = q.filter(or_(ChatSession.title.ilike(like), UserMaster.user_name.ilike(like),
                          ChatSession.id.in_(matching_ids)))

    rows = q.order_by(ChatSession.updated_at.desc()).limit(limit).all()
    return [
        {
            "id": s.id, "user_id": s.user_id, "user_name": uname,
            "org_id": s.org_id, "org_name": oname,
            "title": s.title, "last_message": s.last_message, "message_count": s.message_count,
            "created_at": s.created_at.isoformat() if s.created_at else None,
            "updated_at": s.updated_at.isoformat() if s.updated_at else None,
        }
        for s, uname, oname in rows
    ]


def admin_get_messages(db: Session, session_id: int) -> list:
    """No ownership check — the caller (route) already gated this behind the
    admin RBAC permission before reaching here."""
    return (
        db.query(ChatMessage)
        .filter(ChatMessage.session_id == session_id)
        .order_by(ChatMessage.created_at.asc())
        .all()
    )
