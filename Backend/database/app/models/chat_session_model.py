"""
AI Chat session/message persistence — user-wise ActMon AI conversation history.

Deliberately separate from anything in `services/chatbot/` (intent/knowledge/tools/
ai_engine) — this is pure storage for the chat UI's sidebar/session list/audit view.
It does not participate in the AI pipeline at all; the frontend calls these endpoints
around the existing, unchanged `/chatbot/chat/stream` call to persist what already
streamed, so no Groq/prompt/tool logic is touched by this feature.
"""
from sqlalchemy import Column, Integer, String, Text, Boolean, DateTime, ForeignKey
from app.database.base import Base
from datetime import datetime


class ChatSession(Base):
    """One conversation. `title` starts as a placeholder and is set from the
    first user message once one arrives (see chat_session_service.append_message) —
    no LLM call is used to generate it, this feature does not add AI behavior."""
    __tablename__ = "ai_chat_sessions"

    id            = Column(Integer, primary_key=True, autoincrement=True)
    org_id        = Column(Integer, nullable=False, default=1, index=True)
    user_id       = Column(Integer, nullable=False, index=True)
    title         = Column(String(255), nullable=False, default="New chat")
    status        = Column(String(20), nullable=False, default="active")  # active / deleted (soft)
    last_message  = Column(Text, nullable=True)
    message_count = Column(Integer, nullable=False, default=0)
    created_at    = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at    = Column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)


class ChatMessage(Base):
    """One turn. `role` is 'user' | 'assistant'; `error` marks a turn that
    surfaced an error to the user (matches the widget's own `message.error` flag)."""
    __tablename__ = "ai_chat_messages"

    id          = Column(Integer, primary_key=True, autoincrement=True)
    session_id  = Column(Integer, ForeignKey("ai_chat_sessions.id", ondelete="CASCADE"), nullable=False, index=True)
    role        = Column(String(20), nullable=False)
    content     = Column(Text, nullable=False)
    error       = Column(Boolean, nullable=False, default=False)
    created_at  = Column(DateTime, nullable=False, default=datetime.utcnow, index=True)
