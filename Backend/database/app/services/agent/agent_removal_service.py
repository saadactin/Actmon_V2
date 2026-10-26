"""
Remove an agent from monitoring (Agents page → Remove).

Host agent (db_type 'Host'):
  • revoke its enrollment token (agent_tokens) and unbind the host (os_servers row + its db_instances links),
    so a still-installed agent's next push is rejected ("Unknown agent token") instead of re-registering;
  • drop the databases that agent collected for (agent_db_targets on that token);
  • delete the agents row and its PostgreSQL working data (metrics, sessions, snapshots, notifications, …).
Database agent (generated from a saved connection):
  • delete that connection (exactly what each Database module's own "delete connection" does — a single
    connection_master row), unlink it from hosts' db_instances and agent_db_targets — otherwise "Sync" would
    simply recreate the agent from the connection;
  • delete the agents row and its PostgreSQL working data.
Never touched: ClickHouse history (expires by its TTL), other agents, other hosts' tokens.
plan() returns exactly what remove() will delete, for the confirmation dialog.
"""
from sqlalchemy import or_, text

from app.models.agent_model import Agent, AgentDbTarget, AgentToken
from app.models.connection_model import ConnectionMaster
from app.models.os_server_model import OsServer

# PostgreSQL tables holding per-agent working data, keyed by agent_name
_DATA_TABLES = ("agent_metrics", "agent_sessions", "agent_top_sql", "agent_wait_events", "agent_notifications",
                "agent_oracle_snapshots", "agent_snapshots", "agent_stable_facts", "agent_stable_changes",
                "agent_pending_update")


def _token_filter(model, server):
    conds = []
    if getattr(server, "agent_token_hash", None):
        conds.append(model.token_hash == server.agent_token_hash)
    if getattr(server, "agent_token", None):
        conds.append(model.token == server.agent_token)
    return or_(*conds) if conds else None


def _existing_tables(db):
    rows = db.execute(text("SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' "
                           "AND column_name = 'agent_name' AND table_name = ANY(:t)"), {"t": list(_DATA_TABLES)}).fetchall()
    return [r[0] for r in rows]


def _resolve(agent_id, db, org_id=None):
    agent = db.query(Agent).filter(Agent.id == agent_id).first()
    if not agent:
        return None, None, None
    server = None
    if (agent.db_type or "").lower() == "host":
        q = db.query(OsServer).filter(OsServer.server_name == agent.agent_name)
        server = q.first()
        if server is not None and org_id is not None and getattr(server, "org_id", None) not in (None, org_id):
            return "forbidden", None, None
    conn = None
    if agent.db_connection_id:
        conn = db.query(ConnectionMaster).filter(ConnectionMaster.id == agent.db_connection_id).first()
        if conn is not None and org_id is not None and getattr(conn, "org_id", None) not in (None, org_id):
            return "forbidden", None, None
    return agent, server, conn


def plan(agent_id, db, org_id=None):
    agent, server, conn = _resolve(agent_id, db, org_id)
    if agent == "forbidden" or agent is None:
        return None
    is_host = (agent.db_type or "").lower() == "host"
    out = {"agent_id": agent.id, "agent_name": agent.agent_name, "kind": "host" if is_host else "database",
           "db_type": agent.db_type, "host": None, "tokens": 0, "db_targets": [], "connection": None, "data_rows": {}}
    if is_host and server is not None:
        out["host"] = {"id": server.id, "name": server.server_name, "ip": server.ip_address, "collector": server.collector}
        f = _token_filter(AgentToken, server)
        out["tokens"] = db.query(AgentToken).filter(f).count() if f is not None else 0
        f2 = _token_filter(AgentDbTarget, server)
        if f2 is not None:
            out["db_targets"] = [{"id": t.id, "db_type": t.db_type, "name": t.connection_name, "connection_id": t.connection_id}
                                 for t in db.query(AgentDbTarget).filter(f2).all()]
    if conn is not None:
        out["connection"] = {"id": conn.id, "name": conn.connection_name, "db_type": conn.db_type}
    if agent.db_connection_id:
        # targets by the agent's connection id — even when the connection row itself is already gone, a host agent
        # may still be collecting it from its own target list
        out["db_targets"] = [{"id": t.id, "db_type": t.db_type, "name": t.connection_name, "connection_id": t.connection_id}
                             for t in db.query(AgentDbTarget).filter(AgentDbTarget.connection_id == agent.db_connection_id).all()]
    for t in _existing_tables(db):
        n = db.execute(text(f"SELECT count(*) FROM {t} WHERE agent_name = :n"), {"n": agent.agent_name}).scalar()  # noqa: S608 — fixed table list
        if n:
            out["data_rows"][t] = n
    return out


def remove(agent_id, db, org_id=None, user_id=None):
    p = plan(agent_id, db, org_id)
    if p is None:
        return None
    agent, server, conn = _resolve(agent_id, db, org_id)
    try:
        if server is not None:
            f = _token_filter(AgentToken, server)
            if f is not None:
                db.query(AgentToken).filter(f).delete(synchronize_session=False)
            f2 = _token_filter(AgentDbTarget, server)
            if f2 is not None:
                db.query(AgentDbTarget).filter(f2).delete(synchronize_session=False)
            db.delete(server)            # cascades its db_instances rows
        if agent.db_connection_id:
            db.query(AgentDbTarget).filter(AgentDbTarget.connection_id == agent.db_connection_id).delete(synchronize_session=False)
            db.execute(text("UPDATE database_instances SET connection_id = NULL WHERE connection_id = :c"), {"c": agent.db_connection_id})
        if conn is not None:
            db.delete(conn)
        for t in _existing_tables(db):
            db.execute(text(f"DELETE FROM {t} WHERE agent_name = :n"), {"n": agent.agent_name})  # noqa: S608
        db.delete(agent)
        db.commit()
    except Exception:
        db.rollback()
        raise
    print(f"[agents] removed agent id={p['agent_id']} name={p['agent_name']!r} kind={p['kind']} by user_id={user_id} "
          f"host={bool(p['host'])} tokens={p['tokens']} targets={len(p['db_targets'])} connection={bool(p['connection'])}")
    return {"status": "success", "removed": p}
