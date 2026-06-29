# ✅ Authentication Bypass - Complete Guide

## 🎯 What Was Fixed

Authentication is now **fully bypassed** in development mode for both frontend and backend.

---

## 🔧 Changes Made

### Backend (Database Service)

1. **✅ Modified:** `Backend/database/app/routes/auth_routes.py`
   - Added `BYPASS_AUTH` environment check
   - Returns admin user without requiring token

2. **✅ Created:** `Backend/database/start_dev.py`
   - Development server with auth bypass enabled
   - Better error handling for port issues

3. **✅ Updated:** `Backend/database/start_service.bat`
   - Sets `BYPASS_AUTH=true` environment variable
   - Uses `start_dev.py` instead of direct uvicorn

4. **✅ Added:** `/api/health` endpoint in `main.py`

### Frontend

1. **✅ Modified:** `Actmon_V1/src/auth/ProtectedRoute.jsx`
   - Auto-login in development mode when `VITE_BYPASS_AUTH=true`
   - Creates fake admin token automatically
   - Skips all auth checks

2. **✅ Created:** `Actmon_V1/.env`
   - Sets `VITE_BYPASS_AUTH=true`

3. **✅ Created:** `Actmon_V1/src/components/DevModeBanner.jsx`
   - Visual warning banner for dev mode

4. **✅ Updated:** `Actmon_V1/src/components/layout/AppShell.jsx`
   - Shows dev mode banner

---

## 🚀 How To Start

### Step 1: Restart Frontend (IMPORTANT!)

**You MUST restart Vite to load the new .env file!**

```bash
# Stop current Vite (Ctrl+C)
# Then restart:
cd Actmon_V1
npm run dev
```

**Why?** Vite only loads `.env` files at startup. The `VITE_BYPASS_AUTH` variable won't work without restart!

### Step 2: Start Database Backend

```bash
cd Backend\database
start_service.bat
```

**Expected output:**
```
Starting service on port 8000 (Development Mode - Auth Bypassed)...
WARNING: Authentication is BYPASSED for development!

INFO:     Uvicorn running on http://0.0.0.0:8000
```

### Step 3: Open Browser

```
http://localhost:3001
```

**You should now:**
- ✅ Skip the login screen entirely
- ✅ Go straight to dashboard
- ✅ Be logged in as admin automatically
- ✅ See orange "Development Mode" banner at top

---

## ✅ What You'll See

### Development Mode Banner
```
┌────────────────────────────────────────────────────────┐
│ ⚠️  Development Mode - Authentication Bypassed  ⚠️       │
└────────────────────────────────────────────────────────┘
```

### Auto-Login Console Message
```
[DEV] Auto-login: Bypassing authentication
```

### Automatic Admin Access
- Username: admin
- Role: Admin
- Full permissions
- No password required

---

## 🔍 How It Works

### Frontend Flow
```
1. Page loads
2. ProtectedRoute checks for token
3. Sees VITE_BYPASS_AUTH=true
4. Creates fake admin token
5. Saves to localStorage
6. Redirects to dashboard
7. Shows dev banner
```

### Backend Flow
```
1. Request hits /api/v1/auth/me
2. Checks BYPASS_AUTH env variable
3. If true, returns admin user
4. Skips token validation entirely
```

---

## 🐛 Troubleshooting

### Still Seeing Login Screen?

**Problem:** Frontend .env not loaded  
**Solution:** **RESTART Vite!** (Stop with Ctrl+C, then `npm run dev`)

### Check if bypass is enabled:
1. Open browser console (F12)
2. Type: `import.meta.env.VITE_BYPASS_AUTH`
3. Should return: `"true"`
4. If undefined, restart Vite!

### Backend Still Requires Auth?

**Check environment variable:**
```bash
# In the terminal where backend is running:
echo %BYPASS_AUTH%
```

Should output: `true`

If not, restart backend:
```bash
cd Backend\database
start_service.bat
```

### Port 8000 Blocked?

**Option 1:** Run PowerShell as Administrator

**Option 2:** Kill the process
```bash
netstat -ano | findstr :8000
taskkill /F /PID <PID>
```

**Option 3:** Use different port (see QUICK_START.md)

---

## 🔒 Re-Enable Authentication

### For Production

1. **Frontend:** Delete or comment out in `Actmon_V1/.env`
   ```env
   # VITE_BYPASS_AUTH=true
   ```

2. **Backend:** Remove from `Backend/database/start_service.bat`
   ```batch
   REM set BYPASS_AUTH=true
   ```

3. **Restart both services**

4. **Use default credentials:**
   - Username: `admin`
   - Password: `admin123`

---

## 📊 Current Status

| Component | Status | Details |
|-----------|--------|---------|
| Frontend Auth | ✅ Bypassed | Auto-login as admin |
| Backend Auth | ✅ Bypassed | Returns admin without token |
| Dev Banner | ✅ Shown | Visual warning |
| Port 8000 | ⏳ Start | Run start_service.bat |
| Port 3001 | ⏳ Restart | **MUST RESTART VITE!** |

---

## ⚠️ IMPORTANT: Restart Vite!

**The frontend changes won't work until you restart Vite!**

```bash
# Stop Vite (Ctrl+C in the terminal where it's running)

# Start again:
cd Actmon_V1
npm run dev
```

**Why?**
- Vite loads `.env` files only at startup
- The `VITE_BYPASS_AUTH` variable doesn't exist in running process
- `ProtectedRoute` checks for this variable
- Without restart, it won't find it!

---

## 🎉 Expected Result

After restarting Vite and starting backend:

1. ✅ Open http://localhost:3001
2. ✅ Login screen is bypassed
3. ✅ Automatically logged in as admin
4. ✅ Orange dev banner visible
5. ✅ Dashboard loads immediately
6. ✅ All features accessible

---

**Don't forget to RESTART VITE! It's required for the .env changes to take effect!** 🔄
