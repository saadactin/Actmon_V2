from sqlalchemy import Column, DateTime, Integer, String, Text
from sqlalchemy.sql import func

from app.database.base import Base


class AlertComment(Base):
    """A note left on an alert in the Alert Details view.

    Keyed by the alert's SUBJECT (source + metric + message with its numbers stripped), not by the notification
    id: a tablespace that re-alerts at 85.6% after 85.5% gets a new notification row, but it is the same problem,
    so the conversation must carry over.
    """
    __tablename__ = "alert_comments"

    id = Column(Integer, primary_key=True, index=True)
    org_id = Column(Integer, default=1, index=True)
    alert_key = Column(String(600), index=True, nullable=False)
    user_id = Column(Integer, nullable=True)
    username = Column(String(255), nullable=True)
    body = Column(Text, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
