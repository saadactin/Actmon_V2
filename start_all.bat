@echo off
title ACTMON - Starting All Services
color 0A

echo.
echo ================================================================================
echo   ACTMON - Starting All Services
echo ================================================================================
echo.

cd /d "%~dp0"

echo [1/3] Starting Database Backend (Port 8000)...
start "ACTMON - Database Backend" cmd /k "cd Backend\database && start_service.bat"
timeout /t 3 /nobreak >nul

echo [2/3] Starting Cloud Backend (Port 8002)...
start "ACTMON - Cloud Backend" cmd /k "cd Backend\cloud && run_service.bat"
timeout /t 3 /nobreak >nul

echo [3/3] Starting Frontend (Port 3001)...
start "ACTMON - Frontend" cmd /k "cd Actmon_V1 && npm run dev"

echo.
echo ================================================================================
echo   All services are starting in separate windows...
echo ================================================================================
echo.
echo   Database Backend: http://127.0.0.1:8000
echo   Cloud Backend:    http://127.0.0.1:8002
echo   Frontend:         http://localhost:3001
echo.
echo   Check status: python check_services.py
echo.
echo   Press any key to close this window (services will keep running)
echo ================================================================================
pause >nul
