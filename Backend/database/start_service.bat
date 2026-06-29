@echo off
echo Starting ACTMON Database Service...
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
echo Starting service on port 8000 (Development Mode - Auth Bypassed)...
echo API will be available at: http://127.0.0.1:8000
echo API Docs: http://127.0.0.1:8000/docs
echo.
echo WARNING: Authentication is BYPASSED for development!
echo.

set BYPASS_AUTH=true
python start_dev.py
