from sqlalchemy import Column, Integer, String, Text, Numeric, Boolean, DateTime, ForeignKey
from sqlalchemy.dialects.postgresql import JSONB
from app.database.base import Base
from datetime import datetime


class PostgresPlanComparison(Base):
    """One row = one 'test this hint' run from the Query Plan Analysis
    feature — the original plan, the hinted plan, and (when EXPLAIN ANALYZE
    was explicitly requested) the real before/after execution times. This is
    a durable comparison log, not a job: nothing here is ever re-executed
    automatically — a row is written once, at the moment the user asked for
    a comparison, and just sits there for later review (see Plan History)."""
    __tablename__ = "postgres_plan_comparisons"

    id = Column(Integer, primary_key=True, index=True)
    org_id = Column(Integer, nullable=False, default=1, index=True)
    conn_id = Column(Integer, ForeignKey("connection_master.id"), nullable=False, index=True)

    database_name = Column(String(200), nullable=True)
    query_text = Column(Text, nullable=False)
    # sha256 of the normalized query text — lets the frontend group repeat
    # comparisons of the "same" query without depending on pg_stat_statements
    # having a queryid for it (a hand-typed query never will).
    query_hash = Column(String(64), nullable=True, index=True)

    hint_text = Column(Text, nullable=True)
    # True only when the user explicitly confirmed EXPLAIN ANALYZE for both
    # sides — a plan-only ("estimated") comparison never sets this.
    analyzed = Column(Boolean, nullable=False, default=False)

    original_plan = Column(JSONB, nullable=True)
    hinted_plan = Column(JSONB, nullable=True)
    original_planning_ms = Column(Numeric, nullable=True)
    original_execution_ms = Column(Numeric, nullable=True)
    hinted_planning_ms = Column(Numeric, nullable=True)
    hinted_execution_ms = Column(Numeric, nullable=True)

    # improved | worse | same | unknown (unknown = estimated-only comparison,
    # where a lower planner cost is never treated as a proven improvement).
    result = Column(String(20), nullable=True)
    warnings = Column(JSONB, nullable=True)
    error_details = Column(Text, nullable=True)

    requested_by = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
