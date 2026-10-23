"""Run the cloud service with auto-reload that waits for running sweeps.

Usage (from Backend/cloud):
    venv\\Scripts\\python.exe dev_server.py                # 127.0.0.1:8001
    venv\\Scripts\\python.exe dev_server.py --host 0.0.0.0 --port 8001

Why this exists: `uvicorn --reload` restarts the worker the moment any watched
.py file is saved, and account refreshes and discovery scans run as tasks
inside that worker. Every save during a refresh killed it. Between 12 and 23
Oct 2026 all five FAILED refreshes were "Interrupted: the service restarted";
an OCI sweep takes about 90 minutes, so while code was being edited one almost
never finished.

This keeps uvicorn's own reloader and changes two things:

  1. When files change while the worker reports background work
     (GET /health/inflight), the restart is HELD until that work finishes.
     Changes keep collecting meanwhile and are applied in one reload. The log
     says what it is waiting for.
  2. Only app/ is watched. Saving a test, a probe script or this file no
     longer restarts the service; nothing outside app/ is imported by it.

To reload immediately anyway, create a file named `.reload-now` here:
    New-Item .reload-now

Run it with a console: a terminal, or `Start-Process -WindowStyle Hidden`
WITHOUT -RedirectStandardOutput. On Windows uvicorn restarts the worker by
sending it Ctrl+C, which needs a console; launched without one, the first
reload hangs (plain `uvicorn --reload` does the same).
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from uvicorn.config import Config
from uvicorn.server import Server
from uvicorn.supervisors import ChangeReload

HERE = Path(__file__).resolve().parent
FORCE_FILE = HERE / ".reload-now"

# A worker that accepts connections but does not answer is either busy for a
# moment (a blocking call on the loop) or hung. Hold for this long, then
# reload: a hung worker is exactly what a reload fixes.
UNANSWERED_GRACE_S = 45
PROBE_TIMEOUT_S = 3

logger = logging.getLogger("uvicorn.error")


class GuardedReload(ChangeReload):
    """uvicorn's file-watching reloader, holding restarts while work runs."""

    def __init__(self, config, target, sockets, *, probe_url: str) -> None:
        super().__init__(config, target, sockets)
        self.reloader_name = f"{self.reloader_name} (guarded)"
        self.probe_url = probe_url
        self.pending: set[Path] = set()
        self.held_for: tuple[str, ...] = ()
        self.unanswered_since: float | None = None

    def should_restart(self) -> list[Path] | None:
        # The watcher yields at least every 5s even with no changes, so a held
        # reload is re-checked on that cadence.
        changes = super().should_restart()
        if changes:
            self.pending.update(changes)
        if not self.pending:
            return None

        if FORCE_FILE.exists():
            FORCE_FILE.unlink(missing_ok=True)
            logger.warning("%s found: reloading now, whatever is running.", FORCE_FILE.name)
            return self._release()

        busy = self._busy()
        if busy:
            names = tuple(sorted(busy))
            if names != self.held_for:
                logger.warning(
                    "Holding reload of %d changed file(s) while %d background job(s) "
                    "run: %s. It applies when they finish; create %s to reload now.",
                    len(self.pending), len(names), ", ".join(names), FORCE_FILE.name,
                )
                self.held_for = names
            return None

        if self.held_for:
            logger.warning("Background work finished; applying the held reload.")
        return self._release()

    def _release(self) -> list[Path]:
        changed = sorted(self.pending)
        self.pending.clear()
        self.held_for = ()
        self.unanswered_since = None
        return changed

    def _busy(self) -> list[str]:
        """What the worker is running, or [] when there is nothing to protect."""
        # A dead worker (say, a syntax error in the file just saved) runs
        # nothing, and the reload is what brings it back.
        if not self.process.is_alive():
            return []
        try:
            with urllib.request.urlopen(self.probe_url, timeout=PROBE_TIMEOUT_S) as resp:
                body = json.load(resp)
        except urllib.error.HTTPError:
            # Answering, but without this endpoint: older code, nothing to ask.
            self.unanswered_since = None
            return []
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            now = time.monotonic()
            if self.unanswered_since is None:
                self.unanswered_since = now
            if now - self.unanswered_since < UNANSWERED_GRACE_S:
                return ["worker not answering yet"]
            logger.warning("Worker has not answered for %ds; reloading.", UNANSWERED_GRACE_S)
            return []
        self.unanswered_since = None
        # Refresh and scan tasks are already named "refresh:<id>" and
        # "discovery:<id>"; the rest have asyncio's "Task-12" and need the kind.
        return [
            name if name.startswith(f"{kind}:") else f"{kind}:{name}"
            for kind, name in ((str(i.get("kind")), str(i.get("name")))
                               for i in body.get("inflight") or [])
        ]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=int(os.getenv("CLOUD_SERVICE_PORT", "8001")))
    parser.add_argument("--log-level", default="info")
    args = parser.parse_args()

    os.chdir(HERE)
    # Inherited by the worker, which then reports "guarded" to the account
    # header instead of warning that a save will kill a refresh.
    os.environ["ACTMON_RELOAD_GUARD"] = "1"

    config = Config(
        "app.main:app", host=args.host, port=args.port, log_level=args.log_level,
        reload=True, reload_dirs=[str(HERE / "app")],
    )
    # The same sequence uvicorn.run() uses for --reload, with the guarded
    # supervisor in place of ChangeReload.
    sock = config.bind_socket()
    server = Server(config=config)
    GuardedReload(
        config, target=server.run, sockets=[sock],
        probe_url=f"http://127.0.0.1:{args.port}/health/inflight",
    ).run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
