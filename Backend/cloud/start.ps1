################################################################################
# ACTMON Cloud Discovery Microservice — Startup Script (PowerShell)
################################################################################
# Run from:  Backend\cloud\
# Pre-reqs:  pip install -r requirements.txt
#            PostgreSQL running with actmon DB and migration_user access

param(
    # 8001, not 8002: the frontend proxies /api/v1/cloud to 127.0.0.1:8001
    # (Actmon_V1/vite.config.js), matching the CLOUD_SERVICE_PORT default.
    [int]$Port = 8001,
    [switch]$NoDev
)

# ── Ensure we're in the right directory ──────────────────────────────────────
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

# ── Activate a venv if present — prefer this service's OWN venv
#    (Backend\cloud\venv) over a shared repo-root venv, since only the local
#    one is guaranteed to have this service's requirements.txt installed.
#    Silently finding neither used to fall through to a bare 'uvicorn' call
#    that failed with "not recognized" — now it's an explicit, loud error. ───
$localVenvActivate  = Join-Path $root "venv\Scripts\Activate.ps1"
$sharedVenvActivate = Join-Path $root "..\..\venv\Scripts\Activate.ps1"

if (Test-Path $localVenvActivate) {
    Write-Host "[CLOUD] Activating local venv (Backend\cloud\venv)..." -ForegroundColor Cyan
    & $localVenvActivate
} elseif (Test-Path $sharedVenvActivate) {
    Write-Host "[CLOUD] Activating shared venv (..\..\venv)..." -ForegroundColor Cyan
    & $sharedVenvActivate
} else {
    Write-Host "[CLOUD] ERROR: no venv found at .\venv or ..\..\venv." -ForegroundColor Red
    Write-Host "[CLOUD] Run: python -m venv venv; .\venv\Scripts\pip install -r requirements.txt" -ForegroundColor Red
    exit 1
}

# ── Start FastAPI Server ──────────────────────────────────────────────────────
Write-Host "[CLOUD] Starting FastAPI on port $Port ..." -ForegroundColor Cyan

# Invoke via 'python -m uvicorn' rather than bare 'uvicorn' — robust even if
# activation didn't put Scripts\ on PATH for some reason.
if ($NoDev) {
    python -m uvicorn app.main:app --host 0.0.0.0 --port $Port --workers 2
} else {
    python -m uvicorn app.main:app --host 0.0.0.0 --port $Port --reload --log-level info
}
