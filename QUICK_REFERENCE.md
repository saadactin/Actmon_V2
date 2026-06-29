# 🚀 ACTMON Quick Reference

## Current Status (Based on Your Logs)

| Service | Port | Status | Action Needed |
|---------|------|--------|---------------|
| Frontend | 3001 | ✅ **RUNNING** | None |
| Database Backend | 8000 | ❌ **NOT RUNNING** | **START NOW!** |
| Cloud Backend | 8002 | ❌ NOT RUNNING | Optional |

---

## ⚡ Quick Commands

### Start Database Backend (FIXES YOUR ERRORS!)
```bash
cd Backend\database
start_service.bat
```

### Start Cloud Backend (Optional)
```bash
cd Backend\cloud
run_service.bat
```

### Start All Services at Once
```bash
start_all.bat
```

### Check Service Status
```bash
python check_services.py
```

---

## 🐛 Your Current Errors

```
[vite] http proxy error: /api/v1/agents/notifications/?limit=50
Error: connect ECONNREFUSED 127.0.0.1:8000
```

```
[vite] http proxy error: /api/v1/auth/me
Error: connect ECONNREFUSED 127.0.0.1:8000
```

**Why?** Database backend (port 8000) is not running.

**Fix?** Start it: `cd Backend\database && start_service.bat`

---

## ✅ What I Fixed

1. **JSX Syntax Error** in `MongoDBDashboard.jsx`
   - Changed `running > 1s` to `running &gt; 1s`
   - Warning will disappear after save

2. **Created Startup Scripts**
   - `Backend/database/start_service.bat` - Database backend
   - `Backend/cloud/run_service.bat` - Cloud backend
   - `start_all.bat` - Start everything

3. **Service Checker**
   - `check_services.py` - Check what's running

---

## 📂 File Structure

```
ACTMON V1/
├── start_all.bat                    ⭐ Start all services
├── check_services.py                ⭐ Check status
├── START_ALL_SERVICES.md            📖 Detailed guide
├── QUICK_REFERENCE.md               📖 This file
│
├── Backend/
│   ├── database/
│   │   ├── start_service.bat        ⭐ Start database backend
│   │   └── main.py                  Main app (port 8000)
│   │
│   └── cloud/
│       ├── run_service.bat          ⭐ Start cloud backend
│       ├── test_discovery.py        🧪 Test cloud discovery
│       ├── verify_and_test.py       🧪 Full test suite
│       ├── START_HERE.md            📖 Cloud test guide
│       └── app/main.py              Main app (port 8002)
│
└── Actmon_V1/
    ├── package.json
    └── vite.config.js               Proxy config (correct ✅)
```

---

## 🔗 Service URLs

### After Starting Services

| Service | URL | Documentation |
|---------|-----|---------------|
| Frontend | http://localhost:3001 | Main UI |
| Database API | http://127.0.0.1:8000/docs | Swagger UI |
| Cloud API | http://127.0.0.1:8002/api/v1/cloud/docs | Swagger UI |

### Health Checks

```bash
# Database backend
curl http://127.0.0.1:8000/api/health

# Cloud backend  
curl http://127.0.0.1:8002/health

# Or use browser
```

---

## 🎯 Most Common Issues

### 1. Frontend errors "ECONNREFUSED 127.0.0.1:8000"
**Problem:** Database backend not running  
**Solution:** `cd Backend\database && start_service.bat`

### 2. "Port already in use"
**Problem:** Service already running  
**Solution:** Kill process or use different port

### 3. "Module not found" errors
**Problem:** Dependencies not installed  
**Solution:** 
```bash
cd Backend\database
pip install -r requirements.txt
```

### 4. Cloud discovery "Network Error"
**Problem:** Cloud backend not running  
**Solution:** `cd Backend\cloud && run_service.bat`

---

## 📋 Service Dependencies

```
PostgreSQL (5432) ─→ Database Backend (8000) ─→ Frontend (3001)
                                              ↗
                     Cloud Backend (8002) ────┘
```

**Required:**
- PostgreSQL database
- Database backend (port 8000)
- Frontend (port 3001)

**Optional:**
- Cloud backend (port 8002) - only for cloud features

---

## 🔥 Emergency Commands

### Kill All Python Services
```bash
taskkill /F /IM python.exe
```

### Kill Specific Port
```bash
# Find process on port 8000
netstat -ano | findstr :8000

# Kill it (replace PID)
taskkill /F /PID <PID>
```

### Restart Everything
```bash
# Close all terminals, then:
start_all.bat
```

---

## ✅ Startup Checklist

1. [ ] PostgreSQL is running
2. [ ] Database backend started (port 8000) **← MOST IMPORTANT!**
3. [ ] Cloud backend started (port 8002) - if needed
4. [ ] Frontend started (port 3001) - you have this
5. [ ] No ECONNREFUSED errors
6. [ ] Can access http://localhost:3001

---

## 🧪 Testing

### Test Database Backend
```bash
curl http://127.0.0.1:8000/api/health
```

### Test Cloud Discovery (After starting services)
```bash
cd Backend\cloud
python verify_and_test.py
```

### Check All Services
```bash
python check_services.py
```

---

## 📖 Documentation Files

- **START_ALL_SERVICES.md** - Complete service startup guide
- **Backend/cloud/START_HERE.md** - Cloud discovery test guide
- **Backend/cloud/CONFIGURATION_CHECK.md** - Config verification
- **Backend/cloud/TEST_INSTRUCTIONS.md** - Detailed testing guide

---

## 🎯 Next Steps

1. **Fix immediate issue:**
   ```bash
   cd Backend\database
   start_service.bat
   ```

2. **Verify it works:**
   ```bash
   python check_services.py
   ```

3. **Check frontend:**
   - Refresh http://localhost:3001
   - Errors should be gone!

4. **Optional - Test cloud discovery:**
   - Start cloud backend
   - Run test suite
   - See Backend/cloud/START_HERE.md

---

## 💡 Pro Tips

- Keep all service terminals open to see logs
- Use `check_services.py` frequently
- Bookmark http://127.0.0.1:8000/docs for API testing
- Use `start_all.bat` for one-click startup
- Check git status before making changes

---

**Need help? Check START_ALL_SERVICES.md for detailed explanations!**
