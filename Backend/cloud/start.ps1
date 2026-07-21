################################################################################
# ACTMON Cloud Discovery Microservice — Startup Script (PowerShell)
################################################################################
# Run from:  Backend\cloud\
# Pre-reqs:  pip install -r requirements.txt
#            PostgreSQL running with actmon DB and migration_user access

param(
    [int]$Port = 8002,
    [switch]$NoDev
)

# ── Ensure we're in the right directory ──────────────────────────────────────
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

# ── Activate venv if present ─────────────────────────────────────────────────
$venvActivate = Join-Path $root "..\..\venv\Scripts\Activate.ps1"
if (Test-Path $venvActivate) {
    Write-Host "[CLOUD] Activating shared venv..." -ForegroundColor Cyan
    & $venvActivate
}

# ── Start FastAPI Server ──────────────────────────────────────────────────────
Write-Host "[CLOUD] Starting FastAPI on port $Port ..." -ForegroundColor Cyan

if ($NoDev) {
    uvicorn app.main:app --host 0.0.0.0 --port $Port --workers 2
} else {
    uvicorn app.main:app --host 0.0.0.0 --port $Port --reload --log-level info
}
