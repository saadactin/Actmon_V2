################################################################################
# ACTMON Cloud Discovery Microservice — Startup Script (PowerShell)
################################################################################
# Run from:  Backend\cloud\
# Pre-reqs:  .\venv\Scripts\pip install -r requirements.txt
#            PostgreSQL running with actmon DB and migration_user access
#
# Usage:  .\start.ps1            # dev, auto-reload on file changes
#         .\start.ps1 -NoDev     # no reload — use this while scanning
#         .\start.ps1 -Force     # take over the port if something holds it

param(
    # 8001, not 8002: the frontend proxies /api/v1/cloud to 127.0.0.1:8001
    # (Actmon_V1/vite.config.js), matching the CLOUD_SERVICE_PORT default.
    [int]$Port = 8001,
    [switch]$NoDev,
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

# ── Resolve the interpreter EXPLICITLY ────────────────────────────────────────
# Activating a venv and then calling bare `python` is fragile: if activation is
# blocked (execution policy) or doesn't affect the session, `python` silently
# resolves to the SYSTEM interpreter, which starts a server against the wrong
# packages. Calling the venv's python.exe by full path removes that failure mode.
$localPy  = Join-Path $root "venv\Scripts\python.exe"
$sharedPy = Join-Path $root "..\..\venv\Scripts\python.exe"

if (Test-Path $localPy) {
    $py = $localPy
} elseif (Test-Path $sharedPy) {
    $py = $sharedPy
} else {
    Write-Host "[CLOUD] ERROR: no venv interpreter at .\venv or ..\..\venv." -ForegroundColor Red
    Write-Host "[CLOUD] Create one:  python -m venv venv" -ForegroundColor Red
    Write-Host "[CLOUD]              .\venv\Scripts\pip install -r requirements.txt" -ForegroundColor Red
    exit 1
}
Write-Host "[CLOUD] Interpreter: $py" -ForegroundColor Cyan

# ── Refuse to start a second copy on the same port ────────────────────────────
# Windows lets two sockets bind the same port, and then requests land on one of
# them arbitrarily — which shows up in the UI as random ECONNRESETs rather than
# as an obvious "port in use" error. Fail loudly instead.
$held = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($held) {
    $pids = ($held.OwningProcess | Select-Object -Unique)
    if ($Force) {
        foreach ($procId in $pids) {
            Write-Host "[CLOUD] -Force: stopping PID $procId holding port $Port" -ForegroundColor Yellow
            Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Seconds 3
    } else {
        Write-Host "[CLOUD] ERROR: port $Port is already held by PID(s): $($pids -join ', ')" -ForegroundColor Red
        Write-Host "[CLOUD] Running two copies causes random ECONNRESET in the UI." -ForegroundColor Red
        Write-Host "[CLOUD] Re-run with -Force to take the port over." -ForegroundColor Red
        exit 1
    }
}

# ── Start FastAPI ─────────────────────────────────────────────────────────────
# Deliberately ONE worker. This service keeps real state in process memory —
# the cost caches, the provider/token cache, the in-app alert list and the
# discovery task registry. Extra workers each get their OWN copy, so cached
# cost vanishes depending on which worker answers, alerts appear and disappear,
# and a pre-warm helps only one of them. (`--workers 2` here was also a second
# source of duplicate listeners.) Scale with more concurrency inside the
# process, not more processes.
Write-Host "[CLOUD] Starting FastAPI on port $Port (single worker)..." -ForegroundColor Cyan
if ($NoDev) {
    & $py -m uvicorn app.main:app --host 0.0.0.0 --port $Port --log-level info
} else {
    # --reload restarts on file change; it will interrupt an in-flight scan, so
    # prefer -NoDev while a discovery scan is running.
    & $py -m uvicorn app.main:app --host 0.0.0.0 --port $Port --reload --log-level info
}
