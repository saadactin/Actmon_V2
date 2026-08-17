"""
Oracle topology configuration — the registration-time deployment-type
selection (§1) and the Data-Guard primary↔standby links (§9, §13) a single
ConnectionMaster row cannot express on its own. RAC needs neither of these:
GV$INSTANCE already discovers every RAC node from the one registered
connection (see oracle_monitoring_service.oracle_rac_nodes).
"""
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.connection_model import ConnectionMaster
from app.models.oracle_topology_model import OracleTopologyLink

VALID_DEPLOYMENT_TYPES = ("standalone", "rac", "data_guard", "rac_dg")
VALID_LINK_TYPES = ("standby", "far_sync", "cascaded_standby")


def _get_oracle_conn_or_404(conn_id: int, db: Session) -> ConnectionMaster:
    conn = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == conn_id, ConnectionMaster.db_type == "oracle"
    ).first()
    if not conn:
        raise HTTPException(status_code=404, detail="Oracle connection not found")
    return conn


VALID_ROLES = ("primary", "standby", "farsync", "unknown")


def set_deployment_type(conn_id: int, deployment_type: str, db: Session, role: str = None) -> dict:
    """`role` distinguishes the Data-Guard-specific manual choices (Data Guard
    Primary vs Standby, RAC + Data Guard Primary vs Standby) — deployment_type
    alone (standalone|rac|data_guard|rac_dg) doesn't carry which side of a
    Data Guard pair this connection is; that's ConnectionMaster.oracle_role,
    the same column the collector's role-transition detection maintains."""
    if deployment_type not in VALID_DEPLOYMENT_TYPES:
        raise HTTPException(status_code=400, detail=f"deployment_type must be one of {VALID_DEPLOYMENT_TYPES}")
    if role is not None and role not in VALID_ROLES:
        raise HTTPException(status_code=400, detail=f"role must be one of {VALID_ROLES}")
    conn = _get_oracle_conn_or_404(conn_id, db)
    conn.oracle_deployment_type = deployment_type
    if role is not None:
        conn.oracle_role = role
    db.commit()
    return {"status": "success", "connection_id": conn_id,
            "oracle_deployment_type": deployment_type, "oracle_role": conn.oracle_role}


def link_peer(connection_id: int, peer_connection_id: int, link_type: str, db: Session) -> dict:
    if link_type not in VALID_LINK_TYPES:
        raise HTTPException(status_code=400, detail=f"link_type must be one of {VALID_LINK_TYPES}")
    if connection_id == peer_connection_id:
        raise HTTPException(status_code=400, detail="A connection cannot be linked to itself")
    _get_oracle_conn_or_404(connection_id, db)
    _get_oracle_conn_or_404(peer_connection_id, db)

    existing = db.query(OracleTopologyLink).filter(
        OracleTopologyLink.connection_id == connection_id,
        OracleTopologyLink.peer_connection_id == peer_connection_id,
    ).first()
    if existing:
        existing.link_type = link_type
        db.commit()
        db.refresh(existing)
        return _to_dict(existing)

    link = OracleTopologyLink(connection_id=connection_id, peer_connection_id=peer_connection_id, link_type=link_type)
    db.add(link)
    db.commit()
    db.refresh(link)
    return _to_dict(link)


def unlink_peer(link_id: int, db: Session) -> dict:
    link = db.query(OracleTopologyLink).filter(OracleTopologyLink.id == link_id).first()
    if not link:
        raise HTTPException(status_code=404, detail="Topology link not found")
    db.delete(link)
    db.commit()
    return {"status": "success", "deleted": link_id}


def list_peers(connection_id: int, db: Session) -> dict:
    """Returns both directions: connections this one points AT (its
    downstream standbys/far-sync) and the connection that points at it (its
    upstream primary, if this row IS a standby) — a cascaded standby needs
    both to render its real position in the chain (§13)."""
    _get_oracle_conn_or_404(connection_id, db)

    downstream = db.query(OracleTopologyLink).filter(OracleTopologyLink.connection_id == connection_id).all()
    upstream = db.query(OracleTopologyLink).filter(OracleTopologyLink.peer_connection_id == connection_id).all()

    def _peer_summary(peer_id):
        peer = db.query(ConnectionMaster).filter(ConnectionMaster.id == peer_id).first()
        if not peer:
            return {"id": peer_id, "name": None, "host": None, "port": None}
        return {"id": peer.id, "name": peer.connection_name, "host": peer.host, "port": peer.port,
                "oracle_role": peer.oracle_role}

    return {
        "status": "success",
        "downstream": [{**_to_dict(l), "peer": _peer_summary(l.peer_connection_id)} for l in downstream],
        "upstream": [{**_to_dict(l), "peer": _peer_summary(l.connection_id)} for l in upstream],
    }


def _to_dict(link: OracleTopologyLink) -> dict:
    return {
        "id": link.id, "connection_id": link.connection_id,
        "peer_connection_id": link.peer_connection_id, "link_type": link.link_type,
    }
