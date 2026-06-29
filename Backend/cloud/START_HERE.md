# 🚀 START HERE - Cloud Discovery Test

## ✅ Configuration Status: VERIFIED

All backend-frontend connections, CORS, proxies, and API endpoints have been **verified and are correct**.

See **[CONFIGURATION_CHECK.md](CONFIGURATION_CHECK.md)** for detailed verification results.

---

## 📋 What You Need

- [x] PostgreSQL running on `localhost:5432`
- [x] Database `actmon` exists
- [x] User `migration_user` with password `StrongPassword123`
- [ ] Python 3.9+ installed
- [ ] Cloud service running on port 8002

---

## 🎯 Quick Start (3 Commands)

### Step 1: Test AWS Credentials (30 seconds)
```bash
cd Backend\cloud
python quick_aws_test.py
```

**Expected:** ✅ Credentials valid, lists sample AWS resources

---

### Step 2: Start Cloud Service
```bash
cd Backend\cloud
run_service.bat
```

**Expected:** Service starts on http://127.0.0.1:8002

Leave this terminal running!

---

### Step 3: Run Discovery Test (New Terminal)
```bash
cd Backend\cloud
python verify_and_test.py
```

**Expected:** All tests pass ✅

---

## 📊 What the Test Does

```
1. Configuration Check
   ├─ ✓ Verify .env files
   ├─ ✓ Check Vite proxy config
   └─ ✓ Verify CORS settings

2. Service Health Check
   ├─ ✓ Cloud service (port 8002)
   └─ ✓ Database service (port 8000)

3. API Endpoint Tests
   ├─ ✓ Health endpoint
   ├─ ✓ API docs endpoint
   └─ ✓ Accounts list endpoint

4. Full Discovery Test
   ├─ ✓ Create AWS account
   ├─ ✓ Trigger discovery
   ├─ ✓ Monitor status (PENDING → RUNNING → COMPLETED)
   └─ ✓ Fetch discovered resources
```

---

## 🎉 Expected Output

```
================================================================================
ACTMON CLOUD DISCOVERY - COMPLETE VERIFICATION & TEST
================================================================================

================================================================================
STEP 1: Verify Configuration Files
================================================================================
  ✓ Cloud Backend .env exists
  ✓ Database Backend .env exists
  ✓ Frontend .env exists

================================================================================
STEP 2: Verify Vite Proxy Configuration
================================================================================
  ✓ Cloud proxy configured
  ✓ Database API proxy configured
  ✓ Port 3000 configured

================================================================================
STEP 3: Verify CORS Configuration
================================================================================
  ✓ CORS middleware configured
  ✓ Allow origins configured
  ✓ Allow credentials

================================================================================
STEP 4: Check Running Services
================================================================================
  ✓ Cloud Service is running at http://127.0.0.1:8002/health
  ✓ Database Service is running at http://127.0.0.1:8000/api/health

================================================================================
STEP 5: Test Cloud Service Endpoints
================================================================================
  ✓ Health: http://127.0.0.1:8002/health
  ✓ API Docs: http://127.0.0.1:8002/api/v1/cloud/docs
  ✓ Accounts List: http://127.0.0.1:8002/api/v1/cloud/accounts

================================================================================
STEP 6: Run Full Discovery Test
================================================================================

6.1: Create Cloud Account
--------------------------------------------------------------------------------
  ✓ Account created: <uuid>

6.2: Trigger Discovery
--------------------------------------------------------------------------------
  ✓ Discovery triggered: <uuid>
    Status: PENDING

6.3: Monitor Discovery Progress
--------------------------------------------------------------------------------
  [1/60] Status: PENDING (waiting...)
  [2/60] Status: RUNNING (waiting...)
  [3/60] Status: RUNNING (waiting...)
  ...
  [N/60] Status: COMPLETED
  ✓ Discovery completed!
    Resources found: XX

6.4: Fetch Discovered Resources
--------------------------------------------------------------------------------
  ✓ Fetched XX resources

  Resource breakdown:
    - EC2Instance: 2
    - S3Bucket: 5
    - RDSInstance: 1
    - LambdaFunction: 3
    ...

  Sample resources:
    1. my-instance (EC2Instance)
       Region: ap-south-1a, Status: running
    2. my-bucket (S3Bucket)
       Region: us-east-1, Status: active
    ...

================================================================================
TEST SUMMARY
================================================================================
✅ ALL TESTS PASSED!

What was tested:
  ✓ Configuration files (vite.config.js, .env, CORS)
  ✓ Service health (cloud service, database service)
  ✓ Cloud service endpoints
  ✓ Account creation
  ✓ Discovery trigger
  ✓ Status monitoring
  ✓ Resource fetching

🎉 Your cloud discovery is working correctly!

Next steps:
  • View API docs: http://127.0.0.1:8002/api/v1/cloud/docs
  • Start frontend: cd Actmon_V1 && npm run dev
  • Access UI: http://localhost:3000/cloud/resources
```

---

## 🔧 Troubleshooting

### Service won't start
```bash
# Check if port is in use
netstat -ano | findstr :8002

# Check PostgreSQL
psql -U migration_user -d actmon -h localhost
```

### AWS credentials error
```bash
# Test credentials first
python quick_aws_test.py

# Check if valid and have permissions
```

### Discovery fails
- Check service logs in the terminal where you ran `run_service.bat`
- Look for authentication or permission errors
- Verify AWS region has resources

### "Network Error" in frontend
- Ensure cloud service is running on port 8002
- Check Vite proxy in `vite.config.js` (already verified ✅)
- Check CORS settings (already verified ✅)

---

## 📁 Available Test Scripts

| Script | Purpose | Duration |
|--------|---------|----------|
| `quick_aws_test.py` | Test AWS credentials only | 30 sec |
| `test_discovery.py` | Full discovery test | 1-3 min |
| `verify_and_test.py` | Config check + full test | 2-4 min |

---

## 🌐 URLs After Starting Services

| Service | URL |
|---------|-----|
| Cloud Service API Docs | http://127.0.0.1:8002/api/v1/cloud/docs |
| Cloud Service Health | http://127.0.0.1:8002/health |
| Database Service | http://127.0.0.1:8000 |
| Frontend (after `npm run dev`) | http://localhost:3000 |

---

## 📦 Test Account (Pre-configured)

```json
{
  "provider": "AWS",
  "account_name": "my-aws-account",
  "aws_access_key_id": "YOUR_AWS_ACCESS_KEY_HERE",
  "region": "ap-south-1",
  "aws_account_id": "YOUR_AWS_ACCOUNT_ID"
}
```

---

## 🎯 What Gets Discovered

- ☁️ **EC2 Instances** - All regions
- 🗄️ **S3 Buckets** - Global
- 🗃️ **RDS Databases** - Per region
- ⚡ **Lambda Functions** - Per region
- ⎈ **EKS Clusters** - Kubernetes
- ⚖️ **Load Balancers** - ALB/NLB

---

## ✅ Configuration Verified

- ✅ **Vite Proxy** - `/api/v1/cloud` → port 8002
- ✅ **CORS** - Allow all origins for development
- ✅ **Environment** - `.env` files configured
- ✅ **API Routes** - All endpoints aligned
- ✅ **Ports** - No conflicts (3000, 8000, 8002, 5432)
- ✅ **Request Flow** - Complete path verified

See **[CONFIGURATION_CHECK.md](CONFIGURATION_CHECK.md)** for full details.

---

## 🚀 Ready to Test!

Everything is configured correctly. Just run:

```bash
# Terminal 1
cd Backend\cloud
run_service.bat

# Terminal 2 (after service starts)
cd Backend\cloud
python verify_and_test.py
```

**Good luck! 🎉**
