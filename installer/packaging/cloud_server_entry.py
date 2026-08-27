"""PyInstaller entry point for the ActMon cloud backend (app.main:app)."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app.main import app  # noqa: E402

if __name__ == "__main__":
    import uvicorn

    host = os.environ.get("ACTMON_BIND_HOST", "127.0.0.1")
    port = int(os.environ.get("ACTMON_BIND_PORT", "8004"))
    uvicorn.run(app, host=host, port=port, workers=1)
