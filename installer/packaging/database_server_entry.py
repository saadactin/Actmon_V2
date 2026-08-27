"""PyInstaller entry point for the ActMon database backend.

main.py itself only defines `app` (it's normally run via `uvicorn main:app`), and
that string-based module lookup doesn't resolve inside a frozen executable — this
imports the ASGI app object directly instead, and reads host/port from the
environment so the installer can configure it per-deployment without a rebuild.
"""
import os
import sys

# When frozen, PyInstaller unpacks alongside this script; main.py needs to be
# importable from here exactly like it is when run from the real source tree.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from main import app  # noqa: E402

if __name__ == "__main__":
    import uvicorn

    host = os.environ.get("ACTMON_BIND_HOST", "127.0.0.1")
    port = int(os.environ.get("ACTMON_BIND_PORT", "8003"))
    uvicorn.run(app, host=host, port=port, workers=1)
