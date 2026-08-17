from datetime import datetime

from sqlalchemy import Column, Integer, String, DateTime, ForeignKey
from app.database.base import Base


class OracleTopologyLink(Base):
    """Links a Data Guard primary's ConnectionMaster row to each of its standby
    (or far-sync, or cascaded-standby) ConnectionMaster rows. RAC needs no such
    table — GV$INSTANCE discovers every node from a single connection — but
    Data Guard standbys are genuinely separate databases/connections, and
    ConnectionMaster has no relationships of its own, so this is the minimum
    join table needed to answer "who are this primary's standbys" without an
    opaque JSON blob (alerts/dashboards/topology rendering all need to query
    this relationally, not just store it)."""

    __tablename__ = "oracle_topology_links"

    id = Column(Integer, primary_key=True, autoincrement=True)
    connection_id = Column(Integer, ForeignKey("connection_master.id"), nullable=False, index=True)
    peer_connection_id = Column(Integer, ForeignKey("connection_master.id"), nullable=False, index=True)
    # 'standby' = connection_id is upstream of peer_connection_id (peer receives redo from connection_id)
    # 'far_sync' = peer_connection_id is a far-sync intermediary
    # 'cascaded_standby' = peer_connection_id receives redo from connection_id, which is itself a standby
    link_type = Column(String(50), nullable=False, default="standby")
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
