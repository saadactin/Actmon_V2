"""
Tests for registering RAC nodes as host records.

Run with:  pytest tests/test_oracle_rac_registration.py -v

An in-memory SQLite database stands in for Postgres; only OsServer and
ConnectionMaster are exercised, and neither uses anything dialect-specific.

The rules worth protecting are the restraints, not the happy path: never
register a node nothing was collected from, never overwrite what a human
configured, never delete.
"""
import datetime

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database.base import Base
from app.models.connection_model import ConnectionMaster
from app.models.os_server_model import DatabaseInstance, OsServer
from app.services.oracle import oracle_rac_registration_service as reg


@pytest.fixture
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine, tables=[
        OsServer.__table__, ConnectionMaster.__table__, DatabaseInstance.__table__,
    ])
    session = sessionmaker(bind=engine)()
    session.add(ConnectionMaster(
        id=11, org_id=1, connection_name="KPATCH", db_type="oracle",
        host="10.240.72.239", environment="Production",
    ))
    session.commit()
    try:
        yield session
    finally:
        session.close()


def node(instance, host, ip, reachable=True, local=False, **kw):
    n = {
        "instance_name": instance, "host_name": host, "hostname": host,
        "ip_address": ip, "host_reachable": reachable, "is_agent_host": local,
        "cpu_usage": "8%", "ram_usage": "68%", "disk_usage": "88%",
        "uptime": "up 5 days, 3 hours", "os": "Oracle Linux Server 8.8",
    }
    if not reachable:
        n.update({"failure_reason": "ssh_auth", "cpu_usage": None, "ram_usage": None,
                  "disk_usage": None, "uptime": None, "os": None, "ip_address": None})
    n.update(kw)
    return n


def feed(monkeypatch, nodes, is_rac=True):
    monkeypatch.setattr(
        "app.services.oracle.oracle_rac_host_service.oracle_rac_node_hosts",
        lambda conn_id, d: {"status": "success", "is_rac": is_rac, "nodes": nodes},
    )


BOTH = [
    node("KCDB1", "koebomebspatdb01", "10.240.72.239", local=True),
    node("KCDB2", "koebomebspatdb02", "10.240.72.240"),
]


# ── the happy path ─────────────────────────────────────────────────────────

def test_both_nodes_become_hosts_in_one_cluster(db, monkeypatch):
    feed(monkeypatch, BOTH)
    report = reg.sync_rac_hosts(11, db)

    rows = db.query(OsServer).all()
    assert len(rows) == 2
    assert {r.cluster_name for r in rows} == {"KPATCH"}
    assert {r.node_type for r in rows} == {reg.RAC_NODE_TYPE}
    # Not 'Standalone' plus a cluster name is exactly what makes the servers
    # page group them instead of listing them separately.
    assert all(r.node_type != "Standalone" and r.cluster_name for r in rows)
    assert len(report["synced"]) == 2


def test_metrics_are_carried_onto_the_host_record(db, monkeypatch):
    feed(monkeypatch, BOTH)
    reg.sync_rac_hosts(11, db)
    r = db.query(OsServer).filter(OsServer.hostname == "koebomebspatdb02").one()
    assert (r.cpu_usage, r.ram_usage, r.disk_usage) == ("8%", "68%", "88%")
    assert r.uptime == "up 5 days, 3 hours"
    assert r.status == "Connected"
    assert "Oracle" in (r.database_services or [])


def test_the_agent_node_is_marked_differently_from_its_peer(db, monkeypatch):
    feed(monkeypatch, BOTH)
    reg.sync_rac_hosts(11, db)
    by_host = {r.hostname: r for r in db.query(OsServer).all()}
    assert by_host["koebomebspatdb01"].collector == "agent"
    assert by_host["koebomebspatdb02"].collector == "rac-peer"


def test_running_twice_updates_rather_than_duplicates(db, monkeypatch):
    feed(monkeypatch, BOTH)
    reg.sync_rac_hosts(11, db)
    feed(monkeypatch, [
        node("KCDB1", "koebomebspatdb01", "10.240.72.239", local=True, cpu_usage="11%"),
        node("KCDB2", "koebomebspatdb02", "10.240.72.240", cpu_usage="14%"),
    ])
    reg.sync_rac_hosts(11, db)

    assert db.query(OsServer).count() == 2
    assert db.query(OsServer).filter(OsServer.hostname == "koebomebspatdb02").one().cpu_usage == "14%"


def test_an_existing_standalone_row_is_adopted_not_duplicated(db, monkeypatch):
    """Node 1 already exists as a standalone host. It must become a cluster
    member, not gain a twin."""
    db.add(OsServer(org_id=1, server_name="KPATCH", hostname="koebomebspatdb01",
                    ip_address="10.240.72.239", node_type="Standalone",
                    collector="agent", database_services=["Oracle"]))
    db.commit()

    feed(monkeypatch, BOTH)
    reg.sync_rac_hosts(11, db)

    assert db.query(OsServer).count() == 2
    adopted = db.query(OsServer).filter(OsServer.hostname == "koebomebspatdb01").one()
    assert adopted.node_type == reg.RAC_NODE_TYPE
    assert adopted.cluster_name == "KPATCH"


def test_a_host_recorded_under_its_fqdn_is_matched_on_the_short_name(db, monkeypatch):
    db.add(OsServer(org_id=1, server_name="node1",
                    hostname="koebomebspatdb01.ebsdb.nprd.oraclevcn.com",
                    ip_address="10.240.72.239", node_type="Standalone"))
    db.commit()
    feed(monkeypatch, BOTH)
    reg.sync_rac_hosts(11, db)
    assert db.query(OsServer).count() == 2


# ── the restraints ─────────────────────────────────────────────────────────

def test_an_unreachable_node_is_not_registered(db, monkeypatch):
    """A card reading 'Connected' because a row exists, when nothing was ever
    collected from that host, is worse than no card."""
    feed(monkeypatch, [
        node("KCDB1", "koebomebspatdb01", "10.240.72.239", local=True),
        node("KCDB2", "koebomebspatdb02", None, reachable=False),
    ])
    report = reg.sync_rac_hosts(11, db)

    assert db.query(OsServer).count() == 1
    assert db.query(OsServer).one().hostname == "koebomebspatdb01"
    assert any("koebomebspatdb02" in s for s in report["skipped"])


def test_a_single_instance_is_never_registered_as_a_cluster(db, monkeypatch):
    feed(monkeypatch, [node("KCDB1", "koebomebspatdb01", "10.240.72.239", local=True)],
         is_rac=False)
    report = reg.sync_rac_hosts(11, db)
    assert db.query(OsServer).count() == 0
    assert "not a RAC cluster" in report["skipped"]


def test_a_hand_entered_address_is_never_overwritten(db, monkeypatch):
    """Someone typed this. It is their configuration, not ours to correct."""
    db.add(OsServer(org_id=1, server_name="node2", hostname="koebomebspatdb02",
                    ip_address="192.168.50.7", ssh_username="oracle",
                    node_type="Standalone"))
    db.commit()
    feed(monkeypatch, BOTH)
    reg.sync_rac_hosts(11, db)

    r = db.query(OsServer).filter(OsServer.hostname == "koebomebspatdb02").one()
    assert r.ip_address == "192.168.50.7"
    assert r.ssh_username == "oracle"
    # Cluster membership IS derived every cycle, so that much is owned here.
    assert r.cluster_name == "KPATCH"


def test_nothing_is_ever_deleted(db, monkeypatch):
    """A node that leaves the cluster stops being updated and ages out; its
    history is not removed by a background job."""
    feed(monkeypatch, BOTH)
    reg.sync_rac_hosts(11, db)
    feed(monkeypatch, [node("KCDB1", "koebomebspatdb01", "10.240.72.239", local=True),
                       node("KCDB3", "koebomebspatdb03", "10.240.72.241")])
    reg.sync_rac_hosts(11, db)

    hosts = {r.hostname for r in db.query(OsServer).all()}
    assert "koebomebspatdb02" in hosts
    assert "koebomebspatdb03" in hosts


def test_a_node_with_no_usable_address_is_skipped(db, monkeypatch):
    feed(monkeypatch, [
        node("KCDB1", "koebomebspatdb01", "10.240.72.239", local=True),
        node("KCDB2", "koebomebspatdb02", None),
    ])
    reg.sync_rac_hosts(11, db)
    assert db.query(OsServer).count() == 1


def test_a_collection_failure_never_raises(db, monkeypatch):
    monkeypatch.setattr(
        "app.services.oracle.oracle_rac_host_service.oracle_rac_node_hosts",
        lambda conn_id, d: (_ for _ in ()).throw(RuntimeError("agent gone")),
    )
    report = reg.sync_rac_hosts(11, db)
    assert report["errors"]
    assert db.query(OsServer).count() == 0


def test_the_cluster_takes_the_connection_name(db, monkeypatch):
    feed(monkeypatch, BOTH)
    reg.sync_rac_hosts(11, db)
    assert {r.cluster_name for r in db.query(OsServer).all()} == {"KPATCH"}


def test_new_rows_are_named_by_hostname_not_instance(db, monkeypatch):
    """These are host records, sat beside hosts named by hostname. One card
    reading koebomebspatdb01 next to one reading KCDB2 is the same cluster
    described two different ways."""
    feed(monkeypatch, BOTH)
    reg.sync_rac_hosts(11, db)
    assert {r.server_name for r in db.query(OsServer).all()} == {
        "koebomebspatdb01", "koebomebspatdb02"}


# ── the database side of the card ──────────────────────────────────────────

def test_an_open_instance_reports_running(db, monkeypatch):
    """Without a DatabaseInstance row the card can only say 'Unknown' about an
    instance GV$INSTANCE has just reported OPEN."""
    from app.models.os_server_model import DatabaseInstance
    feed(monkeypatch, [
        node("KCDB1", "koebomebspatdb01", "10.240.72.239", local=True, instance_status="OPEN"),
        node("KCDB2", "koebomebspatdb02", "10.240.72.78", instance_status="OPEN"),
    ])
    reg.sync_rac_hosts(11, db)

    insts = db.query(DatabaseInstance).all()
    assert len(insts) == 2
    assert {i.db_type for i in insts} == {"Oracle"}
    assert {i.status for i in insts} == {"Running"}


def test_a_mounted_instance_is_not_reported_as_running(db, monkeypatch):
    """MOUNTED is a real state that is NOT open for business. A card reading
    'DB Running' over it would be worse than saying nothing."""
    from app.models.os_server_model import DatabaseInstance
    feed(monkeypatch, [
        node("KCDB1", "koebomebspatdb01", "10.240.72.239", local=True, instance_status="OPEN"),
        node("KCDB2", "koebomebspatdb02", "10.240.72.78", instance_status="MOUNTED"),
    ])
    reg.sync_rac_hosts(11, db)

    by_server = {r.id: r.hostname for r in db.query(OsServer).all()}
    got = {by_server[i.server_id]: i.status for i in db.query(DatabaseInstance).all()}
    assert got["koebomebspatdb01"] == "Running"
    assert got["koebomebspatdb02"] == "Degraded"


def test_instance_rows_are_updated_not_duplicated(db, monkeypatch):
    from app.models.os_server_model import DatabaseInstance
    feed(monkeypatch, [
        node("KCDB1", "koebomebspatdb01", "10.240.72.239", local=True, instance_status="OPEN"),
        node("KCDB2", "koebomebspatdb02", "10.240.72.78", instance_status="OPEN"),
    ])
    reg.sync_rac_hosts(11, db)
    reg.sync_rac_hosts(11, db)
    assert db.query(DatabaseInstance).count() == 2
