# 🚀 ACTMON - Start All Services

## Current Issue

Your **Frontend is running on port 3001** but the **Database Backend (port 8000) is NOT running**.

Error: `ECONNREFUSED 127.0.0.1:8000` means the frontend can't connect to the database backend.

---

## ✅ Quick Fix (3 Terminals)

### Terminal 1: Database Backend (Port 8000) ⚠️ **MISSING - START THIS!**

```bash
cd Backend\database
start_service.bat
```

**What it does:**
- Starts the main database API service
- Handles: MySQL, PostgreSQL, MongoDB, MSSQL, Oracle connections
- Provides: `/api/v1/auth`, `/api/v1/agents`, `/api/v1/connections`, etc.
- **This is what your frontend needs!**

---

### Terminal 2: Cloud Backend (Port 8002) - Optional for Cloud Features

```bash
cd Backend\cloud
run_service.bat
```

**What it does:**
- Cloud discovery service for AWS/Azure/OCI
- Only needed if testing cloud resource discovery
- Provides: `/api/v1/cloud/*` endpoints

---

### Terminal 3: Frontend (Port 3001) ✅ **ALREADY RUNNING**

```bash
cd Actmon_V1
npm run dev
```

Your frontend is already running, but it can't function without the database backend!

---

## 🔍 Check Service Status

Run this to see what's running:

```bash
python check_services.py
```

**Expected output:**
```
======================================================================
ACTMON Service Status Check
======================================================================
Time: 2026-06-15 18:40:00

Frontend (Vite)          ✅ RUNNING            http://localhost:3001
Database Backend         ❌ NOT RUNNING        http://127.0.0.1:8000/api/health
Cloud Backend            ❌ NOT RUNNING        http://127.0.0.1:8002/health

======================================================================
⚠️  SOME SERVICES DOWN (1/3 running)

Services to start:
  • Database Backend: cd Backend\database && start_service.bat
  • Cloud Backend: cd Backend\cloud && run_service.bat
======================================================================
```

---

## 📊 Service Dependencies

```
Frontend (3001)
    ↓
    ├─→ Database Backend (8000) ⚠️ REQUIRED FOR MAIN FEATURES
    │   ├─ Auth endpoints (/api/v1/auth)
    │   ├─ Database connections
    │   ├─ Monitoring data
    │   ├─ Agents & notifications
    │   └─ Terminal/SSH features
    │
    └─→ Cloud Backend (8002) 🔵 OPTIONAL (only for cloud features)
        ├─ Cloud account management
        ├─ Resource discovery
        └─ Cost tracking
```

---

## ❗ Why Your Frontend is Failing

The errors you see:

```
[vite] http proxy error: /api/v1/agents/notifications/?limit=50
Error: connect ECONNREFUSED 127.0.0.1:8000
```

**This means:**
- Frontend is trying to call `/api/v1/agents/notifications`
- Vite proxy forwards it to `http://127.0.0.1:8000`
- **Port 8000 is not responding** (service not running)
- Connection refused

**Solution:** Start the database backend service!

---

## 🛠️ Step-by-Step Fix

### Step 1: Start Database Backend

Open a **new terminal** (keep frontend running):

```bash
cd "c:\Users\SaadSayyed\Desktop\ACTMON V1\Backend\database"
start_service.bat
```

Wait for:
```
INFO:     Uvicorn running on http://0.0.0.0:8000 (Press CTRL+C to quit)
INFO:     Started reloader process
```

### Step 2: Verify It's Running

In another terminal:
```bash
curl http://127.0.0.1:8000/api/health
```

Should return: `{"status": "healthy"}`

### Step 3: Refresh Frontend

Go back to your browser at `http://localhost:3001` and refresh.

The errors should stop!

---

## 🔧 Startup Script (All Services at Once)

Create `start_all.bat` in project root:

```batch
@echo off
echo Starting ACTMON Services...
echo.

start "Database Backend" cmd /k "cd Backend\database && start_service.bat"
timeout /t 3 /nobreak >nul

start "Cloud Backend" cmd /k "cd Backend\cloud && run_service.bat"
timeout /t 3 /nobreak >nul

start "Frontend" cmd /k "cd Actmon_V1 && npm run dev"

echo.
echo All services starting in separate windows...
echo Close this window when done.
```

Then just run: `start_all.bat`

---

## 📋 Port Reference

| Service | Port | Status | Required? |
|---------|------|--------|-----------|
| Frontend | 3001 | ✅ Running | Yes |
| Database Backend | 8000 | ❌ **Not Running** | **YES - START THIS!** |
| Cloud Backend | 8002 | ❌ Not Running | Optional |
| PostgreSQL | 5432 | ? | Yes (for database backend) |

---

## 🐛 JSX Error Fixed

I also fixed the JSX syntax error in `MongoDBDashboard.jsx`:

**Before:**
```jsx
(running > 1s)  // ❌ Invalid - '>' not allowed in JSX
```

**After:**
```jsx
(running &gt; 1s)  // ✅ Fixed - HTML entity
```

The warning should disappear after you save the file (HMR will reload).

---

## ✅ Checklist

- [ ] PostgreSQL database is running
- [ ] Database backend started (port 8000) **← DO THIS NOW!**
- [ ] Cloud backend started (port 8002) - optional
- [x] Frontend running (port 3001) - already running
- [x] JSX syntax error fixed
- [ ] All services responding
- [ ] No more ECONNREFUSED errors

---

## 🎯 Summary

**Your Problem:** Database backend (port 8000) is not running.

**Your Solution:** 
```bash
cd Backend\database
start_service.bat
```

**Result:** Frontend will connect successfully, no more proxy errors!

---

## 🔗 Quick Links After Starting Services

- **Frontend:** http://localhost:3001
- **Database API Docs:** http://127.0.0.1:8000/docs
- **Cloud API Docs:** http://127.0.0.1:8002/api/v1/cloud/docs
- **Health Checks:**
  - Database: http://127.0.0.1:8000/api/health
  - Cloud: http://127.0.0.1:8002/health

---

**Start the database backend now, and your errors will disappear!** 🚀
