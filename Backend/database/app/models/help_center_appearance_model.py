from datetime import datetime

from sqlalchemy import Column, Integer, String, DateTime
from sqlalchemy.dialects.postgresql import JSONB

from app.database.base import Base


class HelpCenterAppearance(Base):
    """Singleton row — the documentation library looks the same for every
    viewer in every org, so (unlike most tables in this app) there is
    deliberately no org_id/user_id here, matching MonitoringSettings' own
    singleton convention.

    `config` is a single JSONB blob rather than one typed column per field:
    the Help Center appearance spec has 40+ nested fields (theme preset,
    per-category colors, per-engine colors, card/grid/typography/sidebar
    settings, …) that will keep growing, and a flat column-per-field schema
    would need a migration for every new one. The frontend owns the
    visually-authoritative default shape (`helpAppearanceConfig.js`) and
    deep-merges it under whatever this table returns, so this row can start
    as `{}` and never needs its own copy of the full default object — see
    the route module for the merge behavior.
    """
    __tablename__ = "help_center_appearance"

    id         = Column(Integer, primary_key=True, autoincrement=True)
    config     = Column(JSONB, nullable=False, default=dict)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    updated_by = Column(String(200), nullable=True)
