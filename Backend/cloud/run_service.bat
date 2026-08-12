@echo off
echo Starting ACTMON Cloud Discovery Service...
echo.

cd /d %~dp0

echo Activating virtual environment...
if exist venv\Scripts\activate.bat (
    call venv\Scripts\activate.bat
) else (
    echo Virtual environment not found. Creating one...
    python -m venv venv
    call venv\Scripts\activate.bat
    echo Installing dependencies...
    pip install -r requirements.txt
)

echo.
rem 8001, not 8002: the frontend proxies /api/v1/cloud to 127.0.0.1:8001
rem (Actmon_V1/vite.config.js), matching the CLOUD_SERVICE_PORT default.
echo Starting service on port 8001...
echo API Docs will be available at: http://127.0.0.1:8001/api/v1/cloud/docs
echo.

python -m uvicorn app.main:app --reload --port 8001 --host 0.0.0.0
