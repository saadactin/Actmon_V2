"""
Thin, typed client for Patroni's own REST API (default port 8008).

Every write action here (switchover/failover/restart/reload/reinitialize/
pause/resume, and the dynamic-config PATCH) is a documented Patroni endpoint —
Patroni itself validates and safely executes these; this module never shells
out to `patronictl` and never runs arbitrary commands. Read failures and
write failures both come back as a plain `{"error": ...}` dict rather than a
raised exception, so callers (routes) decide the HTTP status — a probe that
fails because the port is closed is not a 500, it's "Patroni not detected".

No retries on ANY call here, especially writes: retrying a switchover/failover
automatically is exactly the kind of silent double-fire a safe HA console must
never do. If a call times out, the caller finds out and decides what to do
next (usually: re-poll status, don't re-fire the action).
"""
import requests

DEFAULT_PORT = 8008
PROBE_TIMEOUT = 2
READ_TIMEOUT = 5
ACTION_TIMEOUT = 10
# switchover/failover block until Patroni finishes the whole operation
# (pause, wait for the candidate to catch up, promote, confirm) — confirmed
# live that a real switchover can genuinely take longer than 10s to respond
# even though it completes successfully; a client-side timeout here must
# never be read as "it failed," only as "we stopped waiting for the answer."
HA_ACTION_TIMEOUT = 45


def _url(host: str, port: int | None, path: str) -> str:
    return f"http://{host}:{port or DEFAULT_PORT}{path}"


def _get(host, port, path, timeout=READ_TIMEOUT):
    try:
        r = requests.get(_url(host, port, path), timeout=timeout)
        if r.status_code >= 400:
            return {"error": f"HTTP {r.status_code}", "detail": _safe_text(r)}
        return r.json() if r.content else {}
    except requests.exceptions.RequestException as e:
        return {"error": str(e)}


def _post(host, port, path, json_body=None, timeout=ACTION_TIMEOUT):
    try:
        r = requests.post(_url(host, port, path), json=json_body or {}, timeout=timeout)
        body = _safe_text(r)
        if r.status_code >= 400:
            return {"error": f"HTTP {r.status_code}", "detail": body}
        return {"ok": True, "status_code": r.status_code, "detail": body}
    except requests.exceptions.RequestException as e:
        return {"error": str(e)}


def _patch(host, port, path, json_body, timeout=ACTION_TIMEOUT):
    try:
        r = requests.patch(_url(host, port, path), json=json_body, timeout=timeout)
        body = _safe_text(r)
        if r.status_code >= 400:
            return {"error": f"HTTP {r.status_code}", "detail": body}
        return r.json() if r.content else {"ok": True}
    except requests.exceptions.RequestException as e:
        return {"error": str(e)}


def _safe_text(r):
    try:
        return r.json()
    except ValueError:
        return r.text[:500]


def probe(host: str, port: int | None = None) -> dict | None:
    """`GET /patroni` with a short timeout. Returns None on ANY failure
    (connection refused, timeout, non-2xx) — the caller treats that as
    "Patroni: Not Detected", never as an error to surface loudly, since a
    plain non-Patroni PostgreSQL host is expected to fail this probe."""
    try:
        r = requests.get(_url(host, port, "/patroni"), timeout=PROBE_TIMEOUT)
        if r.status_code >= 400:
            return None
        return r.json()
    except requests.exceptions.RequestException:
        return None


def get_cluster(host: str, port: int | None = None) -> dict:
    """`GET /cluster` — member list with role/state/timeline/lag. This is the
    live equivalent of `patronictl list`."""
    return _get(host, port, "/cluster")


def get_history(host: str, port: int | None = None) -> list | dict:
    """`GET /history` — native timeline history, the live equivalent of
    `patronictl history`. Returns a list of [timeline, lsn, reason, ts,
    new_leader] rows (Patroni's own shape) or an `{"error": ...}` dict."""
    result = _get(host, port, "/history")
    return result if isinstance(result, list) else result


def get_config(host: str, port: int | None = None) -> dict:
    """`GET /config` — the DCS-stored DYNAMIC configuration (loop_wait, ttl,
    retry_timeout, maximum_lag_on_failover, postgresql.parameters overrides,
    use_slots, use_pg_rewind, ...). This is what `patronictl show-config`
    shows — NOT the static patroni.yml file."""
    return _get(host, port, "/config")


def patch_config(host: str, port: int | None, changes: dict) -> dict:
    """`PATCH /config` — merges `changes` into the existing dynamic config.
    Patroni validates and applies; a null value for a key removes it."""
    return _patch(host, port, "/config", changes)


def switchover(host: str, port: int | None, leader: str, candidate: str, scheduled_at: str | None = None) -> dict:
    body = {"leader": leader, "candidate": candidate}
    if scheduled_at:
        body["scheduled_at"] = scheduled_at
    return _post(host, port, "/switchover", body, timeout=HA_ACTION_TIMEOUT)


def failover(host: str, port: int | None, candidate: str) -> dict:
    return _post(host, port, "/failover", {"candidate": candidate}, timeout=HA_ACTION_TIMEOUT)


def restart(host: str, port: int | None = None, restart_pending: bool = False) -> dict:
    """Patroni-supervised PostgreSQL restart — intentionally NOT the same as
    restarting the Patroni service itself (see host_action_service for that)."""
    body = {"restart_pending": True} if restart_pending else {}
    return _post(host, port, "/restart", body)


def reload(host: str, port: int | None = None) -> dict:
    return _post(host, port, "/reload", {})


def reinitialize(host: str, port: int | None = None, member: str | None = None) -> dict:
    body = {}
    if member:
        body["force"] = False
    return _post(host, port, "/reinitialize", body)


def pause(host: str, port: int | None = None) -> dict:
    return patch_config(host, port, {"pause": True})


def resume(host: str, port: int | None = None) -> dict:
    return patch_config(host, port, {"pause": False})
