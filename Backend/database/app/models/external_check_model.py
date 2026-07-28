from sqlalchemy import Column, Integer, String, Boolean, Text, JSON, DateTime, Float, ForeignKey
from app.database.base import Base
from datetime import datetime


class ExternalCheck(Base):
    """A monitored external target from the "Digital Experience" catalog —
    Website Availability, Ping, DNS, TCP Port, or UDP Port (Synthetic
    Transaction / Page Speed / RUM need a headless browser / client-side SDK
    and aren't modeled here yet). One shared table across check types
    (discriminated by `check_type`) instead of one table per type, matching
    how `connection_master` covers every DB engine — the scheduler, results
    store, and dashboard only need to be built once."""
    __tablename__ = "external_check"

    id = Column(Integer, primary_key=True, index=True)
    org_id = Column(Integer, nullable=False, default=1, index=True)  # tenant scope
    user_id = Column(Integer, nullable=True)                          # creator

    name = Column(String(255), nullable=False)
    check_type = Column(String(30), nullable=False)  # website | ping | dns | tcp_port | udp_port
    target = Column(String(500), nullable=False)     # URL (website) or host/IP (ping/dns/tcp_port/udp_port)
    port = Column(Integer, nullable=True)             # tcp_port / udp_port only

    interval_seconds = Column(Integer, nullable=False, default=300)
    enabled = Column(Boolean, nullable=False, default=True)
    # Type-specific extras: protocol (http/https), locations, expected_status,
    # string_match, timeout_sec, tags — kept generic so adding a config field
    # later doesn't need a migration.
    config = Column(JSON)

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    last_checked_at = Column(DateTime, nullable=True)
    last_status = Column(String(20), nullable=True)      # up | down | unknown
    last_response_time_ms = Column(Float, nullable=True)


class ExternalCheckResult(Base):
    """One executed probe result for an ExternalCheck — the time series behind
    the uptime/response-time history chart."""
    __tablename__ = "external_check_result"

    id = Column(Integer, primary_key=True, index=True)
    check_id = Column(Integer, ForeignKey("external_check.id"), nullable=False, index=True)
    org_id = Column(Integer, nullable=False, default=1, index=True)

    checked_at = Column(DateTime, default=datetime.utcnow, index=True)
    status = Column(String(20), nullable=False)           # up | down
    response_time_ms = Column(Float, nullable=True)
    status_code = Column(Integer, nullable=True)            # HTTP (website) checks only
    error_message = Column(Text, nullable=True)
