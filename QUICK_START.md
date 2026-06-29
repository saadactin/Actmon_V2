# 🚀 ACTMON Quick Start - Auth Bypassed

## ⚡ Start Services (2 Commands)

### Terminal 1: Database Backend
```bash
cd Backend\database
start_service.bat
```

**Expected:**
```
Starting service on port 8000 (Development Mode - Auth Bypassed)...
WARNING: Authentication is BYPASSED for development!

INFO:     Uvicorn running on http://0.0.0.0:8000 (Press CTRL+C to quit)
```

### Terminal 2: Cloud Backend (Optional)
```bash
cd Backend\cloud
run_service.bat
```

**Expected:**
```
INFO:     Uvicorn running on http://0.0.0.0:8002 (Press CTRL+C to quit)
```

### Terminal 3: Frontend (Already Running on 3001)
```bash
# Already running - just refresh browser!
http://localhost:3001
```

---

## ✅ What I Fixed

1. **✅ Auth Bypass** - Added `BYPASS_AUTH=true` environment variable
   - `/api/v1/auth/me` now returns admin user without token
   - Frontend won't get 401 errors anymore

2. **✅ Port Configuration** - Using port 8000 (not 8001)
   - Frontend expects 8000
   - Created `start_dev.py` with better error handling

3. **✅ Health Endpoint** - Added `/api/health`
   - For service monitoring

4. **✅ JSX Syntax Error** - Fixed MongoDB dashboard

5. **✅ FERNET_KEY** - Fixed cloud service encryption

---

## 🎯 If Port 8000 is Blocked

### Option 1: Run as Administrator
Right-click PowerShell → "Run as Administrator"

### Option 2: Kill Process on Port 8000
```powershell
# Find process
netstat -ano | findstr :8000

# Kill it (replace PID)
taskkill /F /PID <PID>
```

### Option 3: Use Different Port
Edit `start_dev.py` line 26:
```python
port=8001,  # Change from 8000 to 8001
```

Then edit `vite.config.js` to match:
```javascript
'/api': {
  target: 'http://127.0.0.1:8001',  // Change to 8001
```

---

## 🔍 Verify Services

Open browser or use curl:

```bash
# Database backend health
http://127.0.0.1:8000/api/health

# Auth check (bypassed - returns admin)
http://127.0.0.1:8000/api/v1/auth/me

# Cloud backend health
http://127.0.0.1:8002/health

# Frontend
http://localhost:3001
```

---

## 🎉 Expected Result

After starting the database backend:

1. ✅ Frontend loads without errors
2. ✅ No more "ECONNREFUSED 127.0.0.1:8000" errors
3. ✅ No more "401 Unauthorized" errors
4. ✅ You're logged in as admin automatically
5. ✅ All features work

---

## 📋 Current Service Status

| Service | Port | Status | Auth |
|---------|------|--------|------|
| Frontend | 3001 | ✅ Running | Bypassed |
| Database Backend | 8000 | ⏳ Start Now! | **Bypassed** ✅ |
| Cloud Backend | 8002 | ✅ Running | N/A |

---

## 🐛 Troubleshooting

### Error: "Port 8000 is blocked"
**Solution:** Run PowerShell as Administrator

### Error: "Module not found"
```bash
cd Backend\database
pip install -r requirements.txt
```

### Frontend still shows login screen
1. Clear browser cache (Ctrl+Shift+Delete)
2. Hard refresh (Ctrl+F5)
3. Check browser console for errors

### Auth still required
1. Make sure `BYPASS_AUTH=true` is set
2. Restart the backend service
3. Check the startup message shows "Auth Bypassed"

---

## 🔒 Re-Enable Auth (Production)

When you want auth back:

1. Stop the service
2. Remove `BYPASS_AUTH=true` from start_service.bat
3. Restart

Default credentials:
- Username: `admin`
- Password: `admin123`

---

## 📖 Next Steps

Once both services are running:

1. **Test Database Features:**
   - Add database connections
   - Monitor performance
   - View dashboards

2. **Test Cloud Discovery:**
   - Go to `/cloud/resources`
   - Add AWS account
   - Trigger discovery
   - See `Backend/cloud/START_HERE.md`

3. **Check API Docs:**
   - Database: http://127.0.0.1:8000/docs
   - Cloud: http://127.0.0.1:8002/api/v1/cloud/docs

---

**Start the database backend now and your app will work! 🚀**
