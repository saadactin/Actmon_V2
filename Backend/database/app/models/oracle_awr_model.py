from datetime import datetime

from sqlalchemy import Column, Integer, String, Float, DateTime, Text, ForeignKey
from app.database.base import Base


class OracleAwrReport(Base):
    """One uploaded AWR HTML report, parsed and summarized.

    Scoped to an organisation. AWR data describes a database, not a cloud
    account, so this is not tied to CloudAccount; the link to a monitored
    ConnectionMaster row is optional, because the report names its own
    database and many are pulled from databases not registered here.
    """

    __tablename__ = "oracle_awr_reports"

    id = Column(Integer, primary_key=True, autoincrement=True)
    org_id = Column(Integer, nullable=False, index=True, default=1)
    connection_id = Column(Integer, ForeignKey("connection_master.id"), nullable=True, index=True)  # optional link to a monitored DB

    batch_id = Column(String(64), nullable=True, index=True)  # groups files from one batch upload
    original_filename = Column(String(500), nullable=False)
    stored_path = Column(String(1000), nullable=False)
    file_size_bytes = Column(Integer, nullable=True)
    file_sha256 = Column(String(64), nullable=True, index=True)  # duplicate-upload detection

    db_name = Column(String(200), nullable=True)
    instance_name = Column(String(200), nullable=True)
    instance_number = Column(String(20), nullable=True)
    host_name = Column(String(300), nullable=True)
    begin_snap = Column(String(50), nullable=True)
    end_snap = Column(String(50), nullable=True)
    begin_time = Column(DateTime, nullable=True)
    end_time = Column(DateTime, nullable=True)
    elapsed_minutes = Column(Float, nullable=True)
    db_time_minutes = Column(Float, nullable=True)

    status = Column(String(20), nullable=False, default="PENDING")  # PENDING|PARSED|FAILED
    error_message = Column(Text, nullable=True)

    high_findings = Column(Integer, default=0)
    medium_findings = Column(Integer, default=0)
    low_findings = Column(Integer, default=0)

    uploaded_by = Column(String(200), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    parsed_at = Column(DateTime, nullable=True)


class OracleAwrFinding(Base):
    """A single rule-engine finding produced from one parsed AWR report."""

    __tablename__ = "oracle_awr_findings"

    id = Column(Integer, primary_key=True, autoincrement=True)
    report_id = Column(Integer, ForeignKey("oracle_awr_reports.id"), nullable=False, index=True)

    severity = Column(String(20), nullable=False)  # HIGH|MEDIUM|LOW|INFO
    category = Column(String(100), nullable=False)
    title = Column(String(500), nullable=False)
    evidence = Column(Text, nullable=True)
    recommendation = Column(Text, nullable=True)
