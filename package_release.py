#!/usr/bin/env python3
"""
Package a LEAN ActMon release to hand to a client.

Copies the project to an output folder, excluding everything that gets installed
fresh at the client site (venv, node_modules, __pycache__, caches) and everything
secret or machine-specific (.env, logs). The client's `python install.py` recreates
all of it. The `.env.example` template IS kept.

    python package_release.py                 -> ../ActMon-release/
    python package_release.py --out DIR       -> custom folder
    python package_release.py --zip           -> also make ActMon-release.zip
    python package_release.py --publish       -> publish Backend/database/install/downloads/ActMon-Windows.zip

Never touches your working tree; it only reads.
"""
import argparse
import os
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent

# Directories excluded anywhere in the tree (recreated by the installer).
SKIP_DIRS = {
    "venv", ".venv", "env", "ENV", "node_modules", "__pycache__", ".git",
    ".pytest_cache", ".mypy_cache", ".ruff_cache", ".idea", ".vscode",
    ".parcel-cache", ".cache", "htmlcov", ".claude", "actmon_logs",
    ".next", "coverage",
}
# File suffixes / exact names excluded anywhere.
SKIP_SUFFIX = (".pyc", ".pyo", ".log", ".egg-info", ".wixpdb")
SKIP_EXACT = {".env", ".DS_Store", "Thumbs.db", "backend.log", "npm-debug.log"}


def _ignore(dir_path, names):
    drop = set()
    for n in names:
        full = Path(dir_path) / n
        if full.is_dir():
            if n in SKIP_DIRS:
                drop.add(n)
        else:
            if n in SKIP_EXACT or n.endswith(SKIP_SUFFIX):
                drop.add(n)
            # keep .env.example; drop other .env.* just in case
            elif n.startswith(".env") and n != ".env.example":
                drop.add(n)
    return drop


def _dir_size(path):
    total = 0
    for dp, _dn, fn in os.walk(path):
        for f in fn:
            try:
                total += (Path(dp) / f).stat().st_size
            except OSError:
                pass
    return total


def _human(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


def main():
    ap = argparse.ArgumentParser(description="Package a lean ActMon release")
    ap.add_argument("--out", default=str(ROOT.parent / "ActMon-release"),
                    help="output folder (default: ../ActMon-release)")
    ap.add_argument("--zip", action="store_true", help="also create a .zip archive")
    ap.add_argument("--publish", action="store_true",
                    help="publish the Windows app zip for /api/v1/download/actmon/windows")
    flags = ap.parse_args()

    out = Path(flags.out).resolve()
    if out == ROOT or ROOT in out.parents:
        print("ERROR: output folder must be OUTSIDE the project (avoid recursive copy).")
        sys.exit(1)

    print(f"Packaging release from:\n  {ROOT}\ninto:\n  {out}\n")
    if out.exists():
        print(f"  removing existing {out} ...")
        shutil.rmtree(out)
    shutil.copytree(ROOT, out, ignore=_ignore)

    # tidy: ensure no stray real .env slipped in
    for env in out.rglob(".env"):
        try:
            env.unlink()
        except OSError:
            pass

    size = _dir_size(out)
    files = sum(len(fn) for _dp, _dn, fn in os.walk(out))
    print(f"  copied {files} files  ({_human(size)})")
    print(f"  excluded: {', '.join(sorted(SKIP_DIRS))}")

    archive = None
    if flags.zip or flags.publish:
        archive = shutil.make_archive(str(out), "zip", root_dir=str(out.parent), base_dir=out.name)
        print(f"  zip: {archive}  ({_human(Path(archive).stat().st_size)})")

    if flags.publish:
        publish_dir = ROOT / "Backend" / "database" / "install" / "downloads"
        publish_dir.mkdir(parents=True, exist_ok=True)
        target = publish_dir / "ActMon-Windows.zip"
        shutil.copy2(archive, target)
        print(f"  published app download: {target}  ({_human(target.stat().st_size)})")

    print("\nDone. Hand the folder (or zip) to the client. They then:")
    print("  1. edit Backend/database/.env  (copy from .env.example)")
    print("  2. run  python install.py")


if __name__ == "__main__":
    main()
