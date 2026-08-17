from sqlalchemy import Column, Integer, BigInteger, String, Boolean, DateTime, Text, ForeignKey
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.sql import func

from app.database.base import Base


class PatroniConfigHistory(Base):
    """One row per config change applied THROUGH ActMon (dynamic config PATCH or
    static patroni.yml write) — not a universal record of every possible external
    edit. `before_content`/`after_content` hold the dynamic-config JSON or the
    (already secret-masked) static YAML text, whichever `target` is. Never
    contains an unmasked secret — masking happens before this row is written,
    the same as before anything is returned to the browser."""

    __tablename__ = "patroni_config_history"

    id              = Column(BigInteger, primary_key=True, autoincrement=True)
    org_id          = Column(Integer, nullable=False, default=1)
    conn_id         = Column(Integer, nullable=False, index=True)
    os_server_id    = Column(Integer, ForeignKey("os_servers.id"), nullable=True)
    user_id         = Column(Integer, nullable=True)
    target          = Column(String(20), nullable=False)   # 'dynamic' | 'static_file'
    before_content  = Column(JSONB)
    after_content   = Column(JSONB)
    restarted       = Column(Boolean, default=False)
    rollback_of     = Column(BigInteger, ForeignKey("patroni_config_history.id"), nullable=True)
    result          = Column(String(20), nullable=False, default="applied")  # applied | rolled_back | failed
    applied_at      = Column(DateTime, nullable=False, server_default=func.current_timestamp())
