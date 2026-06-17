@echo off
title ACTMON Backend Server
cd /d "E:\ACTMON V1\Backend\database"
echo Starting ACTMON Backend on http://localhost:8000 ...
python -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload
pause
