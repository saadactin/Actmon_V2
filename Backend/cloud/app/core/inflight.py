"""Long-running background work alive in THIS process, and how it is run.

Sweeps run as asyncio tasks inside the web process. Anything that restarts the
process (a deploy, a crash, or the dev server's auto-reload when a .py file is
saved) kills them mid-sweep, and the next startup can only mark them
"Interrupted: the service restarted". Between 12 and 23 Oct 2026 that was the
cause of every FAILED account refresh: the service ran `uvicorn --reload`, an
OCI sweep takes about 90 minutes, and code was being edited the whole time.

Two readers:
  - `dev_server.py` asks `GET /health/inflight` before it reloads, and holds
    the reload while anything here is running.
  - The account header says how the service is run (`service_info`), so a
    refresh started under a bare `--reload` comes with a warning instead of a
    surprise.
"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timezone
from typing import Any, Dict, List

# Imported from app.main, so this is within a second or two of process start.
STARTED_AT = datetime.now(timezone.utc)

# Set by dev_server.py before it spawns the worker; the worker inherits it.
RELOAD_GUARD_ENV = "ACTMON_RELOAD_GUARD"

RELOAD_OFF = "off"
RELOAD_GUARDED = "guarded"
RELOAD_UNGUARDED = "unguarded"


def reload_mode() -> str:
    """How code changes reach this process.

    `unguarded` is plain `uvicorn --reload`: saving any watched .py file
    restarts the worker immediately and kills whatever it is running.
    `guarded` is dev_server.py, which holds the restart until in-flight work
    finishes. The worker of a `--reload` run is a multiprocessing spawn child,
    and spawn copies the parent's argv into it, so `--reload` is visible here.
    """
    if os.getenv(RELOAD_GUARD_ENV) == "1":
        return RELOAD_GUARDED
    if "--reload" in sys.argv or os.getenv("UVICORN_RELOAD", "").lower() in ("1", "true", "yes"):
        return RELOAD_UNGUARDED
    return RELOAD_OFF


def service_info() -> Dict[str, Any]:
    return {"started_at": STARTED_AT.isoformat(), "auto_reload": reload_mode()}


def inflight() -> List[Dict[str, str]]:
    """Every background task a restart would kill, by kind.

    Read from the task registries the services already keep (strong references
    so the loop cannot garbage-collect a running sweep). The service runs ONE
    worker (see start.ps1), so this process's registries are the whole picture.
    """
    from app.services import account_refresh_service, discovery_service, event_collector
    from app.workers import discovery_worker

    registries = (
        ("refresh", account_refresh_service._running),
        ("discovery", discovery_service._running_tasks),
        # Cost prewarm and, after a plain scan, the detached cost ingestion.
        ("cost", discovery_worker._warm_tasks),
        ("events", event_collector._running),
    )
    return [
        {"kind": kind, "name": task.get_name()}
        for kind, tasks in registries
        for task in list(tasks)
        if not task.done()
    ]
