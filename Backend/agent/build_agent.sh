#!/usr/bin/env bash
# Build the ActMon Windows agent: actmon-agent.exe (PyInstaller) → actmon-agent.msi (WiX).
# Run from Backend/agent on a Windows host with Python (psutil, pyinstaller) available.
# WiX 3.11 binaries are expected under wix/wix311 (see build_agent.sh output for the download URL).
set -euo pipefail
cd "$(dirname "$0")"

echo "[1/3] Building actmon-agent.exe ..."
python -m PyInstaller --onefile --name actmon-agent --distpath dist --workpath build --specpath build \
  --hidden-import pymysql --collect-submodules pymysql \
  --hidden-import psycopg2 --hidden-import pymssql --collect-submodules pymssql \
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
"$WIX/candle.exe" -nologo -arch x64 -dAgentExe="dist/actmon-agent.exe" -ext WixUtilExtension -out wix/product.wixobj wix/product.wxs

echo "[3/3] Linking MSI ..."
"$WIX/light.exe" -nologo -ext WixUtilExtension -out dist/actmon-agent.msi wix/product.wixobj

echo "Done -> dist/actmon-agent.msi"
