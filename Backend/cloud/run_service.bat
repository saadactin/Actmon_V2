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
echo Starting service on port 8002...
echo API Docs will be available at: http://127.0.0.1:8002/api/v1/cloud/docs
echo.

python -m uvicorn app.main:app --reload --port 8002 --host 0.0.0.0
