"""
MongoDB Atlas integration — validation, secret handling, Atlas API error mapping, data-plane reads, org scoping.

No real Atlas is contacted: pymongo is replaced by a fake client and `requests.request` by a stub.
Run with:  pytest tests/test_mongoatlas.py -v
"""
import base64
import os
from types import SimpleNamespace

import pytest

os.environ.setdefault("ACTMON_ENCRYPTION_KEY", base64.b64encode(os.urandom(32)).decode())

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402
from sqlalchemy.pool import StaticPool  # noqa: E402

from app.models.connection_model import ConnectionMaster  # noqa: E402
from app.routes.auth.auth_routes import current_claims  # noqa: E402
from app.routes.mongoatlas import atlas_routes  # noqa: E402
from app.services.auth import permission_guard  # noqa: E402
from app.services.mongoatlas import atlas_service as svc  # noqa: E402

PID = "5f1e2d3c4b5a69788796a5b4"
URI = "mongodb+srv://appuser:S3cret!pw@cluster0.ab1cd.mongodb.net/?retryWrites=true"
PRIV = "11111111-2222-3333-4444-555555555555"


def req(**kw):
    base = dict(connection_name="Prod Atlas", environment="Production", auth_method="uri", connection_uri=URI,
                host=None, username=None, password=None, auth_source=None, database_name=None, project_label="Payments",
                project_id=None, api_public_key=None, api_private_key=None, remove_api_key=False, monitoring_scope=[])
    base.update(kw)
    return atlas_routes.AtlasConnIn(**base)


# ── fakes ────────────────────────────────────────────────────────────────────

class FakeDB:
    def __init__(self, stats):
        self.stats = stats

    def command(self, name, *a, **k):
        return self.stats

    def list_collections(self):
        return [{"name": "orders", "type": "collection"}, {"name": "v_orders", "type": "view"}]

    def __getitem__(self, coll):
        return SimpleNamespace(aggregate=lambda p: iter([{"storageStats": {"count": 42, "size": 4096, "storageSize": 8192, "totalIndexSize": 1024, "nindexes": 2}}]))


class FakeAdmin:
    def __init__(self, ss, fail=None):
        self.ss, self.fail = ss, fail

    def command(self, name, *a, **k):
        if self.fail and name in self.fail:
            raise self.fail[name]
        if name == "ping":
            return {"ok": 1}
        if name == "buildInfo":
            return {"version": "7.0.12"}
        if name == "hello":
            return {"setName": "atlas-abc-shard-0", "isWritablePrimary": True}
        if name == "serverStatus":
            return self.ss
        if name == "listDatabases":
            return {"databases": [{"name": "shop", "sizeOnDisk": 100}, {"name": "admin"}, {"name": "local"}]}
        if name == "currentOp":
            return {"inprog": [{"opid": 1, "op": "query", "ns": "shop.orders", "secs_running": 3, "microsecs_running": 3_000_000,
                                "planSummary": "COLLSCAN", "command": {"filter": {"email": "someone@example.com"}}}]}
        raise AssertionError(name)


class FakeClient:
    def __init__(self, ss=None, fail=None):
        self.admin = FakeAdmin(ss or {"opcounters": {"query": 10, "insert": 5}, "connections": {"current": 7}, "uptime": 100, "version": "7.0.12"}, fail)

    def __getitem__(self, name):
        return FakeDB({"collections": 3, "objects": 1000, "dataSize": 2048, "storageSize": 4096, "indexSize": 512, "indexes": 4})

    def close(self):
        pass


# ── validation & secrets ─────────────────────────────────────────────────────

def test_validate_requires_fields_per_method():
    assert svc.validate(req()) == []
    assert any("URI" in e for e in svc.validate(req(connection_uri="")))
    assert any("mongodb+srv://" in e for e in svc.validate(req(connection_uri="http://x")))
    errs = svc.validate(req(auth_method="credentials", connection_uri=None, host="mongodb+srv://c0.x.net/db"))
    assert any("host name" in e for e in errs) and any("username" in e for e in errs) and any("password" in e for e in errs)
    errs = svc.validate(req(auth_method="api_key", connection_uri=None, project_id="nothex"))
    assert any("Project ID" in e for e in errs) and any("public key" in e for e in errs)


def test_serialize_never_contains_secrets():
    c = svc.apply(ConnectionMaster(id=5, cloud_config={}), req(project_id=PID, api_public_key="abcdwxyz", api_private_key=PRIV))
    out = repr(svc.serialize(c))
    assert "S3cret" not in out and PRIV not in out and "mongodb+srv" not in out and "abcdwxyz" not in out
    s = svc.serialize(c)
    assert s["host"] == "cluster0.ab1cd.mongodb.net" and s["has_uri"] and s["has_api_key"] and s["api_public_key"] == "abcd…"
    assert c.cloud_primary_key_enc and PRIV not in c.cloud_primary_key_enc   # stored encrypted


def test_edit_with_blank_secrets_keeps_stored_ones():
    c = svc.apply(ConnectionMaster(id=5, cloud_config={}), req(project_id=PID, api_public_key="pubkey12", api_private_key=PRIV))
    enc = c.cloud_primary_key_enc
    assert svc.validate(req(connection_uri="", project_id=PID), existing=c) == []
    svc.apply(c, req(connection_uri="", project_id=PID))
    assert c.connection_uri == URI and c.cloud_primary_key_enc == enc and c.cloud_config["api_public_key"] == "pubkey12"


def test_redact_strips_uri_credentials_and_secrets():
    c = svc.apply(ConnectionMaster(id=5, cloud_config={}), req(project_id=PID, api_public_key="pk", api_private_key=PRIV))
    msg = svc._redact(f"failed {URI} with key {PRIV}", c)
    assert "S3cret" not in msg and PRIV not in msg and "***@" in msg


# ── Atlas API ────────────────────────────────────────────────────────────────

def _api_conn():
    return svc.apply(ConnectionMaster(id=9, cloud_config={}), req(auth_method="api_key", connection_uri=None, project_id=PID,
                                                                    api_public_key="pubkey12", api_private_key=PRIV))


@pytest.mark.parametrize("status,kind", [(401, "auth"), (403, "permission"), (404, "config")])
def test_api_errors_are_classified(monkeypatch, status, kind):
    import requests
    monkeypatch.setattr(requests, "request", lambda *a, **k: SimpleNamespace(status_code=status, content=b"{}", text="", json=lambda: {"detail": "x"}))
    r = svc.test_api(_api_conn())
    assert r["ok"] is False and r["kind"] == kind and PRIV not in r["message"]


def test_api_clusters_health_and_cache(monkeypatch):
    calls = []

    def fake(method, url, **k):
        calls.append(url)
        if url.endswith(f"/groups/{PID}"):
            body = {"name": "Payments"}
        else:
            body = {"results": [
                {"name": "prod", "stateName": "IDLE", "mongoDBVersion": "7.0", "clusterType": "REPLICASET",
                 "replicationSpecs": [{"regionConfigs": [{"providerName": "AWS", "regionName": "AP_SOUTH_1", "electableSpecs": {"instanceSize": "M30", "diskSizeGB": 80}}]}]},
                {"name": "stage", "stateName": "UPDATING", "replicationSpecs": []},
                {"name": "dev", "stateName": "IDLE", "paused": True, "replicationSpecs": []}]}
        return SimpleNamespace(status_code=200, content=b"x", json=lambda: body)

    import requests
    monkeypatch.setattr(requests, "request", fake)
    c = _api_conn()
    svc.drop_cache(c.id)
    out = svc.api_clusters(c)
    by = {x["name"]: x for x in out["clusters"]}
    assert out["project"] == "Payments"
    assert by["prod"]["health"] == "healthy" and by["prod"]["tier"] == "M30" and by["prod"]["regions"] == ["AP_SOUTH_1"]
    assert by["stage"]["health"] == "warning" and by["dev"]["health"] == "warning"
    n = len(calls)
    svc.api_clusters(c)
    assert len(calls) == n            # second read served from the cache


def test_api_rate_limit_is_retried(monkeypatch):
    seq = iter([429, 200])
    import requests
    monkeypatch.setattr(requests, "request", lambda *a, **k: SimpleNamespace(status_code=next(seq), content=b"x", json=lambda: {"name": "P"}))
    monkeypatch.setattr(svc.time, "sleep", lambda s: None)
    assert svc.test_api(_api_conn())["ok"] is True


def test_without_api_key_sections_are_unavailable_not_invented():
    c = svc.apply(ConnectionMaster(id=3, cloud_config={}), req())
    for fn in (svc.api_clusters, svc.api_alerts, svc.api_backups, svc.api_security):
        r = fn(c)
        assert r["available"] is False and r["requires"] == "api_key"


# ── data plane ───────────────────────────────────────────────────────────────

def test_data_plane_overview_and_sampling(monkeypatch):
    c = svc.apply(ConnectionMaster(id=77, cloud_config={}), req())
    svc.drop_cache(77)
    clients = iter([FakeClient({"opcounters": {"query": 100, "insert": 10}, "connections": {"current": 5}, "uptime": 100}),
                    FakeClient({"opcounters": {"query": 400, "insert": 40}, "connections": {"current": 6}, "uptime": 130})])
    monkeypatch.setattr(svc, "_mongo", lambda conn: next(clients))
    t = iter([1000.0, 1000.0, 1030.0, 1030.0])
    monkeypatch.setattr(svc.time, "time", lambda: next(t))
    a = svc.dp_overview(c)
    svc.dp_overview(c)
    assert a["totals"]["databases"] == 1 and a["totals"]["collections"] == 3 and a["totals"]["documents"] == 1000
    series = svc.sampled_series(77)
    assert len(series) == 1 and series[0]["reads"] == 10.0 and series[0]["inserts"] == 1.0   # (400-100)/30, (40-10)/30


def test_current_ops_never_returns_query_values(monkeypatch):
    c = svc.apply(ConnectionMaster(id=78, cloud_config={}), req())
    monkeypatch.setattr(svc, "_mongo", lambda conn: FakeClient())
    out = svc.dp_current_ops(c)
    assert out["ops"][0]["plan"] == "COLLSCAN" and "someone@example.com" not in repr(out)


def test_collections_reject_system_and_bad_names(monkeypatch):
    c = svc.apply(ConnectionMaster(id=79, cloud_config={}), req())
    monkeypatch.setattr(svc, "_mongo", lambda conn: FakeClient())
    with pytest.raises(Exception):
        svc.dp_collections(c, "admin")
    with pytest.raises(Exception):
        svc.dp_collections(c, "a$b")
    out = svc.dp_collections(c, "shop")
    assert out["collections"][0]["count"] == 42


def test_data_plane_errors_are_classified(monkeypatch):
    from pymongo import errors as pe
    c = svc.apply(ConnectionMaster(id=80, cloud_config={}), req())
    for exc, kind in [(pe.OperationFailure("bad auth", code=18), "auth"), (pe.ServerSelectionTimeoutError("timed out"), "network"),
                      (pe.ConfigurationError("The DNS query name does not exist"), "config")]:
        monkeypatch.setattr(svc, "_mongo", lambda conn, e=exc: FakeClient(fail={"ping": e}))
        r = svc.test_data_plane(c)
        assert r["ok"] is False and r["kind"] == kind and "S3cret" not in r["message"]


# ── routes: test-before-save, org scoping, no secrets ────────────────────────

@pytest.fixture
def api(monkeypatch):
    eng = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    ConnectionMaster.__table__.create(eng)
    Session = sessionmaker(bind=eng)
    app = FastAPI()
    app.include_router(atlas_routes.router)
    claims = {"org_id": 2, "role_id": 3, "user_id": 1}

    def get_db():
        s = Session()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[atlas_routes.get_db] = get_db
    app.dependency_overrides[current_claims] = lambda: claims
    app.dependency_overrides[permission_guard._get_db] = get_db
    monkeypatch.setattr(permission_guard, "check_permission", lambda *a, **k: None)
    state = {"ok": True}
    monkeypatch.setattr(svc, "test_data_plane", lambda conn: {"ok": state["ok"], "kind": None if state["ok"] else "auth", "message": "Authentication failed", "version": "7.0"})
    return TestClient(app), claims, state, Session


def test_create_refuses_failed_test_and_never_echoes_secrets(api):
    client, claims, state, _ = api
    body = req().model_dump() if hasattr(req(), "model_dump") else req().dict()
    state["ok"] = False
    r = client.post("/api/v1/connections/mongoatlas/", json=body)
    assert r.status_code == 400 and client.get("/api/v1/connections/mongoatlas/").json() == []
    state["ok"] = True
    r = client.post("/api/v1/connections/mongoatlas/", json=body)
    assert r.status_code == 200 and "S3cret" not in r.text and "mongodb+srv" not in r.text
    lst = client.get("/api/v1/connections/mongoatlas/")
    assert len(lst.json()) == 1 and "S3cret" not in lst.text


def test_other_org_cannot_see_or_touch_connection(api):
    client, claims, state, Session = api
    body = req().model_dump() if hasattr(req(), "model_dump") else req().dict()
    cid = client.post("/api/v1/connections/mongoatlas/", json=body).json()["connection"]["id"]
    claims["org_id"] = 7
    assert client.get("/api/v1/connections/mongoatlas/").json() == []
    for m, path in [("get", ""), ("get", "/overview"), ("delete", ""), ("post", "/test")]:
        assert getattr(client, m)(f"/api/v1/connections/mongoatlas/{cid}{path}").status_code == 404
    claims.update(org_id=1, role_id=1)           # super admin sees every org
    assert client.get(f"/api/v1/connections/mongoatlas/{cid}").status_code == 200
