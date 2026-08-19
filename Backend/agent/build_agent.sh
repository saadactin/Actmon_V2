#!/usr/bin/env bash
# Build the ActMon Windows agent: actmon-agent.exe (PyInstaller) → actmon-agent.msi (WiX).
# Run from Backend/agent on a Windows host with Python available.
# WiX 3.11 binaries are expected under wix/wix311 (see build_agent.sh output for the download URL).
#
# Builds from an ISOLATED virtualenv (.venv-build), not whatever Python happens to be
# on PATH — PyInstaller bundles anything reachable from the interpreter's site-packages,
# so building against a shared/dev Python that also has unrelated heavy packages
# installed (torch, numpy, scipy, ...) silently balloons the exe from ~20MB to 270MB+.
# The venv is created once and reused; delete .venv-build to force a clean rebuild.
set -euo pipefail
cd "$(dirname "$0")"

VENV=.venv-build
if [ ! -f "$VENV/Scripts/python.exe" ]; then
  echo "[0/3] Creating isolated build venv ($VENV) ..."
  python -m venv "$VENV"
  "$VENV/Scripts/python.exe" -m pip install --quiet --upgrade pip
  "$VENV/Scripts/python.exe" -m pip install --quiet \
    pyinstaller pymysql psycopg2-binary pymssql oracledb pymongo clickhouse-driver \
    cryptography pywin32
fi
PY="$VENV/Scripts/python.exe"

echo "[1/3] Building actmon-agent.exe ..."
"$PY" -m PyInstaller --onefile --name actmon-agent --distpath dist --workpath build --specpath build \
  --hidden-import pymysql --collect-submodules pymysql \
  --hidden-import psycopg2 --hidden-import pymssql --collect-submodules pymssql \
  --hidden-import oracledb --collect-submodules oracledb \
  --hidden-import pymongo --collect-submodules pymongo \
  --hidden-import clickhouse_driver --collect-submodules clickhouse_driver \
  --collect-all cryptography \
  --hidden-import win32timezone --hidden-import win32serviceutil \
  --hidden-import win32service --hidden-import win32event --hidden-import servicemanager \
  actmon_agent.py

WIX=wix/wix311
if [ ! -x "$WIX/candle.exe" ]; then
  echo "WiX not found. Download and extract:"
  echo "  curl -sSL -o wix/wix311-binaries.zip https://github.com/wixtoolset/wix3/releases/download/wix3112rtm/wix311-binaries.zip"
  echo "  unzip -o wix/wix311-binaries.zip -d wix/wix311"
  exit 1
fi

echo "[2/3] Compiling WiX ..."
"$WIX/candle.exe" -nologo -arch x64 -dAgentExe="dist/actmon-agent.exe" -dLicenseRtf="wix/license.rtf" \
  -ext WixUtilExtension -ext WixUIExtension -out wix/product.wixobj wix/product.wxs

echo "[3/3] Linking MSI ..."
"$WIX/light.exe" -nologo -ext WixUtilExtension -ext WixUIExtension -out dist/actmon-agent.msi wix/product.wixobj

echo "Done -> dist/actmon-agent.msi"
