"""
Agent file-system command channel.

The host agent is push-only, so interactive browsing works through a small job
queue: the UI request enqueues a job here and WAITS; the agent long-polls
/agents/fs-poll, executes the ls/head locally, and POSTs the output back to
/agents/fs-result, which releases the waiting request.

Jobs live in memory (single backend process). Poll wire format is plain text —
one job per line: "<id>|<op>|<base64 path>" — so the bash agent needs no JSON
parser. Results come back base64-encoded (content may be binary).
"""
import base64
import threading
import time
import uuid

from app.database.connection import SessionLocal
from app.models.agent_model import AgentToken
from app.services.agent import agent_permissions
from app.services.common.credential_encryption_service import credential_encryption

_LOCK = threading.Lock()
_PENDING: dict[str, list[dict]] = {}     # token → [job, …] not yet picked up
_WAITERS: dict[str, dict] = {}           # job_id → {event, result, error}

_REQUEST_TIMEOUT = 20    # seconds the UI request waits for the agent
_POLL_HOLD = 15          # seconds fs-poll long-polls before returning empty

# request() used to have ZERO database dependency (pure in-memory dicts/events)
# before permission-checking was added. Opening a fresh DB session on EVERY
# call here — under a small pool (5 + 10 overflow, see connection.py) and a
# single uvicorn worker — turned out to be a real bottleneck: confirmed live,
# it produced multi-minute hangs on unrelated features (a TCP port-test job)
# that trace back to this new query waiting for a pool connection. Caching
# the lookup means only the FIRST call per token per TTL window touches the
# database at all; every call in between is a plain dict lookup.
_PERM_CACHE: dict[str, tuple] = {}   # token -> (expires_at, granted_permissions)
_PERM_CACHE_TTL = 60                 # seconds — permissions are set once at install, this staleness is fine
_PERM_CACHE_LOCK = threading.Lock()


def _lookup_granted_permissions(token: str):
    now = time.time()
    with _PERM_CACHE_LOCK:
        cached = _PERM_CACHE.get(token)
        if cached and cached[0] > now:
            return cached[1]
    db = SessionLocal()
    try:
        rec = db.query(AgentToken).filter(
            credential_encryption.token_match_filter(AgentToken.token_hash, AgentToken.token, token)
        ).first()
        granted = rec.granted_permissions if rec else None
    finally:
        db.close()
    with _PERM_CACHE_LOCK:
        _PERM_CACHE[token] = (now + _PERM_CACHE_TTL, granted)
    return granted


def _check_permission(token: str, op: str, path: str):
    """Raises RuntimeError if this token's agent wasn't granted the permission
    that gates `op` (see agent_permissions.py). A token with no AgentToken row
    at all (e.g. an AgentDbTarget-only or OsServer-only token) is treated as
    unrestricted here — this is the job channel's own gate, not identity/auth,
    which every caller already checks before reaching this point."""
    granted = _lookup_granted_permissions(token)
    if not agent_permissions.is_allowed(granted, op, path):
        key = agent_permissions.permission_for_op(op, path)
        label = agent_permissions.PERMISSION_CATALOG.get(key, {}).get("label", key)
        raise RuntimeError(f"This agent was not granted the '{label}' permission.")


def request(token: str, op: str, path: str, data: str = "", timeout: int = _REQUEST_TIMEOUT):
    """Enqueue a job for the agent and wait for its answer.
    `data` is an optional payload (e.g. file content for a write).
    Returns raw bytes, or None if the agent didn't answer in time."""
    _check_permission(token, op, path)
    job_id = uuid.uuid4().hex
    waiter = {"event": threading.Event(), "result": None, "error": None}
    with _LOCK:
        _WAITERS[job_id] = waiter
        _PENDING.setdefault(token, []).append({"id": job_id, "op": op, "path": path, "data": data or ""})
    ok = waiter["event"].wait(timeout)
    with _LOCK:
        _WAITERS.pop(job_id, None)
        # If never picked up, drop it from the queue so it can't run later.
        _PENDING[token] = [j for j in _PENDING.get(token, []) if j["id"] != job_id]
    if not ok:
        return None
    if waiter["error"]:
        raise RuntimeError(waiter["error"])
    return waiter["result"]


def poll(token: str, hold: int = _POLL_HOLD) -> str:
    """Agent side: long-poll for jobs. Returns text lines 'id|op|b64path'."""
    deadline = time.time() + max(0, min(hold, 25))
    while True:
        with _LOCK:
            jobs = _PENDING.pop(token, [])
        if jobs:
            # id|op|b64(path)|b64(data)  — data empty for non-write ops
            return "\n".join(
                f"{j['id']}|{j['op']}|{base64.b64encode(j['path'].encode()).decode()}|"
                f"{base64.b64encode((j.get('data') or '').encode()).decode()}"
                for j in jobs
            )
        if time.time() >= deadline:
            return ""
        time.sleep(0.4)


def result(job_id: str, data_b64: str | None, error: str | None = None) -> bool:
    """Agent side: deliver a job's output. Returns False if nobody is waiting."""
    with _LOCK:
        waiter = _WAITERS.get(job_id)
    if not waiter:
        return False
    if error:
        waiter["error"] = error
    else:
        try:
            waiter["result"] = base64.b64decode(data_b64 or "")
        except Exception:
            waiter["error"] = "Agent returned undecodable output."
    waiter["event"].set()
    return True
