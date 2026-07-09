#!/usr/bin/env python3
"""
ActMon one-command installer  (Windows / Linux / Ubuntu / macOS)

    python install.py

Runs, in order:
  1. Preflight   - detect OS; verify Python >= 3.10, Node.js + npm, and that a
                   .env exists (created from .env.example on first run).
  2. Backend     - create the Python venv and `pip install -r requirements.txt`.
  3. Frontend    - `npm install` in the React app.
  4. Database    - run install/db_setup.py under the venv: create the database,
                   apply schema, seed app config, create org #1 + Super Admin role,
                   grant that role every page. (Admin employee + user are created by
                   the first-run browser wizard.)
  5. Summary     - print + write install.log with everything created.

Only the Python standard library is used, so it runs on a fresh machine before any
dependency is installed. Re-running is safe (each phase is idempotent).

Flags:  --skip-deps  --skip-frontend  --skip-db  --db-only  --yes
"""
import argparse
import json
import os
import platform
import shutil
import socket
import subprocess
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BACKEND = ROOT / "Backend" / "database"
FRONTEND = ROOT / "Actmon_V1"
VENV = BACKEND / "venv"
IS_WIN = os.name == "nt"
LOG_LINES = []

# ── console helpers (strict ASCII — Windows consoles are cp1252) ──────────────
def _p(msg=""):
    print(msg, flush=True)
    LOG_LINES.append(msg)


def banner(title):
    _p("")
    _p("=" * 68)
    _p("  " + title)
    _p("=" * 68)


def ok(msg):    _p("  [ OK ] " + msg)
def info(msg):  _p("  [info] " + msg)
def warn(msg):  _p("  [warn] " + msg)
def fail(msg):  _p("  [FAIL] " + msg)


def die(msg):
    fail(msg)
    _write_log()
    sys.exit(1)


def _write_log():
    try:
        (ROOT / "install.log").write_text("\n".join(LOG_LINES) + "\n", encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass


# ── subprocess helper ─────────────────────────────────────────────────────────
def run(cmd, cwd=None, what=""):
    """Stream a subprocess; return True on success. Records a summary line."""
    info((what or " ".join(str(c) for c in cmd)) + " ...")
    try:
        proc = subprocess.run(cmd, cwd=str(cwd) if cwd else None)
    except FileNotFoundError as e:
        fail(f"command not found: {e}")
        return False
    if proc.returncode != 0:
        fail(f"{what or cmd[0]} exited with code {proc.returncode}")
        return False
    return True


def read_env():
    """Parse Backend/database/.env into a dict (best-effort; installer reads DB host/port)."""
    cfg = {}
    env = BACKEND / ".env"
    if env.is_file():
        for line in env.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                cfg[k.strip()] = v.strip()
    return cfg


def db_reachable(host, port, timeout=4):
    try:
        with socket.create_connection((host, int(port)), timeout=timeout):
            return True
    except Exception:  # noqa: BLE001
        return False


def venv_python():
    return VENV / ("Scripts/python.exe" if IS_WIN else "bin/python")


def npm_cmd(args):
    # On Windows npm is npm.cmd → must go through cmd.exe.
    return (["cmd", "/c", "npm"] + args) if IS_WIN else ["npm"] + args


# ── phases ──────────────────────────────────────────────────────────────────
def preflight():
    banner("1/5  Preflight")
    info(f"OS: {platform.system()} {platform.release()} ({platform.machine()})")

    v = sys.version_info
    info(f"Python: {v.major}.{v.minor}.{v.micro}")
    if (v.major, v.minor) < (3, 10):
        die("Python 3.10+ is required. Install it and re-run: python install.py")
    ok("Python version OK")

    if not BACKEND.is_dir():
        die(f"Backend folder not found at {BACKEND}")
    if not FRONTEND.is_dir():
        die(f"Frontend folder not found at {FRONTEND}")
    ok("Project layout OK")

    node = shutil.which("node")
    npm = shutil.which("npm") or shutil.which("npm.cmd")
    if node:
        try:
            nv = subprocess.run([node, "-v"], capture_output=True, text=True).stdout.strip()
            major = int(nv.lstrip("v").split(".")[0]) if nv else 0
            if major and major < 18:
                warn(f"Node.js {nv} found - version 18+ is recommended. Update Node for a smooth frontend build.")
            else:
                ok(f"Node.js {nv or 'present'}")
        except Exception:  # noqa: BLE001
            ok("Node.js present")
    else:
        warn("Node.js not found - the frontend step will be skipped. Install Node 18+ and re-run.")
    if npm:
        ok("npm present")
    elif node:
        warn("npm not found on PATH")

    ensure_env()

    # DB server reachability (early, clear failure before we spend time on deps).
    env = read_env()
    host, port = env.get("DB_HOST", "localhost"), env.get("DB_PORT", "5432")
    if db_reachable(host, port):
        ok(f"PostgreSQL reachable at {host}:{port}")
    else:
        warn(f"PostgreSQL not reachable at {host}:{port} - start it (and check .env) "
             f"before the database step, or it will fail.")

    return {"node": bool(node), "npm": bool(npm)}


def ensure_env():
    env = BACKEND / ".env"
    example = BACKEND / ".env.example"
    if env.is_file():
        ok(".env present")
        return
    if example.is_file():
        shutil.copyfile(example, env)
        warn(".env was missing - created it from .env.example. "
             "Review Backend/database/.env (DB credentials) before continuing.")
    else:
        die("No .env or .env.example in Backend/database. Cannot determine DB settings.")


def setup_backend():
    banner("2/5  Backend dependencies (Python venv)")
    if not VENV.is_dir():
        if not run([sys.executable, "-m", "venv", str(VENV)], what="create venv"):
            die("Could not create the Python virtual environment.")
        ok(f"created venv at {VENV}")
    else:
        ok("venv already present")
    vpy = venv_python()
    if not vpy.is_file():
        die(f"venv python not found at {vpy}")
    run([str(vpy), "-m", "pip", "install", "--upgrade", "pip"], what="upgrade pip")
    req = BACKEND / "requirements.txt"
    if not req.is_file():
        die(f"requirements.txt not found at {req}")
    if not run([str(vpy), "-m", "pip", "install", "-r", str(req)], what="pip install -r requirements.txt"):
        die("Backend dependency install failed.")
    ok("backend dependencies installed")


def setup_frontend(flags):
    banner("3/5  Frontend dependencies (npm)")
    if not (shutil.which("npm") or shutil.which("npm.cmd")):
        warn("npm not available - skipping. Run 'npm install' in Actmon_V1 later.")
        return False
    if not run(npm_cmd(["install"]), cwd=FRONTEND, what="npm install"):
        warn("npm install failed - you can retry with 'npm install' in Actmon_V1.")
        return False
    ok("frontend dependencies installed")
    return True


def setup_database():
    banner("4/5  Database provisioning")
    vpy = venv_python()
    if not vpy.is_file():
        die("venv python missing - run without --skip-deps first.")
    script = BACKEND / "install" / "db_setup.py"
    if not script.is_file():
        die(f"db_setup.py not found at {script}")
    # Stream output live while capturing the SUMMARY_JSON line.
    proc = subprocess.Popen([str(vpy), "install/db_setup.py"], cwd=str(BACKEND),
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    summary = None
    for line in proc.stdout:
        line = line.rstrip("\n")
        if line.startswith("SUMMARY_JSON:"):
            try:
                summary = json.loads(line[len("SUMMARY_JSON:"):])
            except Exception:  # noqa: BLE001
                pass
        else:
            _p("  " + line)
    proc.wait()
    if proc.returncode != 0:
        die("Database provisioning failed (see errors above). Check .env DB credentials "
            "and that PostgreSQL is running.")
    ok("database provisioning complete")
    return summary


def final_summary(summary, fe_ok, flags):
    banner("5/5  Summary")
    if summary:
        _p(f"  Database          : {summary.get('database')}")
        _p(f"  Tables/views      : {summary.get('tables')}")
        _p(f"  Permission bits   : {summary.get('permissions')}")
        _p(f"  Modules           : {summary.get('modules')}")
        _p(f"  Pages (routes)    : {summary.get('pages')}")
        _p(f"  Roles             : {summary.get('roles')}  (Super Admin = role #1)")
        _p(f"  Permission grants : {summary.get('grants')}  "
           f"(Super Admin -> {summary.get('super_admin_pages')} pages, full access)")
        _p(f"  Users / Employees : {summary.get('users')} / {summary.get('employees')}  "
           f"(created in the first-run wizard)")
    _p("")
    _p("  Backend deps      : installed" if not flags.skip_deps else "  Backend deps      : skipped")
    _p("  Frontend deps     : " + ("installed" if fe_ok else ("skipped" if flags.skip_frontend else "not installed")))
    _p("")
    _p("  Next steps:")
    _p("    1. Start the backend :  cd Backend/database  &&  " +
       ("venv\\Scripts\\python -m uvicorn main:app --host 0.0.0.0 --port 8000" if IS_WIN
        else "venv/bin/python -m uvicorn main:app --host 0.0.0.0 --port 8000"))
    _p("    2. Start the frontend:  cd Actmon_V1  &&  npm run dev")
    _p("    3. Open http://localhost:3000  -> the first-run wizard creates your")
    _p("       Super Admin employee + user (email required).")
    _p("")
    ok("ActMon installation finished.")
    _write_log()
    _p("")
    _p("  Full log written to install.log")


def main():
    ap = argparse.ArgumentParser(description="ActMon one-command installer")
    ap.add_argument("--skip-deps", action="store_true", help="skip backend venv/pip")
    ap.add_argument("--skip-frontend", action="store_true", help="skip npm install")
    ap.add_argument("--skip-db", action="store_true", help="skip database provisioning")
    ap.add_argument("--db-only", action="store_true", help="only provision the database")
    ap.add_argument("--yes", action="store_true", help="non-interactive (assume yes)")
    flags = ap.parse_args()
    if flags.db_only:
        flags.skip_deps = flags.skip_frontend = True

    _p("ActMon Installer  -  " + datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
    pre = preflight()
    if flags.skip_frontend:
        flags.skip_frontend = True

    if not flags.skip_deps:
        setup_backend()
    else:
        banner("2/5  Backend dependencies")
        info("skipped (--skip-deps)")

    fe_ok = False
    if not flags.skip_frontend:
        fe_ok = setup_frontend(flags)
    else:
        banner("3/5  Frontend dependencies")
        info("skipped (--skip-frontend)")

    summary = None
    if not flags.skip_db:
        summary = setup_database()
    else:
        banner("4/5  Database provisioning")
        info("skipped (--skip-db)")

    final_summary(summary, fe_ok, flags)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        die("Interrupted.")
