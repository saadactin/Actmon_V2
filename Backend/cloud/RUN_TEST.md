# Quick Start Guide - Cloud Discovery Test

## 🚀 Fast Track (Windows)

### 1. Prerequisites Check
- [ ] PostgreSQL is running on localhost:5432
- [ ] Python 3.9+ is installed
- [ ] Database `actmon` exists with user `migration_user`

### 2. One-Time Setup

```bash
# Navigate to cloud backend directory
cd Backend\cloud

# Install dependencies (if not done)
pip install -r requirements.txt
pip install httpx  # For testing
```

### 3. Quick AWS Credentials Test

```bash
# Test AWS credentials first (takes 30 seconds)
python quick_aws_test.py
```

**Expected Output:**
- ✓ Credentials are valid
- Shows your AWS account details
- Lists sample resources (EC2, S3, RDS, Lambda)

### 4. Start Cloud Service

**Option A: Using batch file**
```bash
run_service.bat
```

**Option B: Manual**
```bash
python -m uvicorn app.main:app --reload --port 8002
```

Service will start at: **http://127.0.0.1:8002**
API Docs at: **http://127.0.0.1:8002/api/v1/cloud/docs**

### 5. Run Full Discovery Test

Open a NEW terminal:

```bash
cd Backend\cloud
python test_discovery.py
```

This will:
1. ✓ Check service health
2. ✓ Create test AWS account
3. ✓ Trigger discovery job
4. ✓ Poll until complete
5. ✓ Fetch all resources
6. ✓ Test frontend endpoint

**Expected Duration:** 1-3 minutes (depending on AWS resources)

---

## 📊 Test Account Details

```json
{
  "provider": "AWS",
  "account_name": "my-aws-account",
  "aws_access_key_id": "YOUR_AWS_ACCESS_KEY_HERE",
  "aws_secret_access_key": "YOUR_AWS_SECRET_KEY_HERE",
  "region": "ap-south-1",
  "aws_account_id": "YOUR_AWS_ACCOUNT_ID"
}
```

---

## 🧪 Manual Testing Options

### Option 1: Using Swagger UI (Recommended)

1. Open: **http://127.0.0.1:8002/api/v1/cloud/docs**
2. Expand `Cloud Accounts` → `POST /api/v1/cloud/accounts`
3. Click "Try it out"
4. Paste the test account JSON
5. Click "Execute"
6. Copy the returned `account_id`
7. Go to `Discovery` → `POST /api/v1/cloud/discovery/{account_id}`
8. Enter the `account_id` and execute
9. Monitor with `GET /api/v1/cloud/discovery/status/{job_id}`

### Option 2: Using cURL

**Create Account:**
```bash
curl -X POST http://127.0.0.1:8002/api/v1/cloud/accounts \
  -H "Content-Type: application/json" \
  -d @- << 'EOF'
{
  "provider": "AWS",
  "account_name": "my-aws-account",
  "aws_access_key_id": "YOUR_AWS_ACCESS_KEY_HERE",
  "aws_secret_access_key": "YOUR_AWS_SECRET_KEY_HERE",
  "aws_account_id": "YOUR_AWS_ACCOUNT_ID",
  "region": "ap-south-1",
  "environment": "Development",
  "auth_mode": "Access Key",
  "auto_discovery_enabled": true
}
EOF
```

**Trigger Discovery:**
```bash
# Replace {account_id} with the ID from previous response
curl -X POST http://127.0.0.1:8002/api/v1/cloud/discovery/{account_id}
```

**Check Status:**
```bash
# Replace {job_id} with the ID from discovery response
curl http://127.0.0.1:8002/api/v1/cloud/discovery/status/{job_id}
```

**Get Resources:**
```bash
curl http://127.0.0.1:8002/api/v1/cloud/resources/{account_id}
```

### Option 3: Using Frontend

1. Start frontend: `cd Actmon_V1 && npm run dev`
2. Open: **http://localhost:3000**
3. Navigate to "Cloud" → "Resources"
4. You should see the discovered resources

---

## 🔍 What Gets Discovered

The scanner will discover these AWS resources:

- **EC2 Instances** - All instances across all regions
- **RDS Databases** - MySQL, PostgreSQL, etc.
- **S3 Buckets** - All buckets (global)
- **Lambda Functions** - All functions per region
- **EKS Clusters** - Kubernetes clusters
- **Load Balancers** - ALB/NLB/ELB

For each resource, it captures:
- Resource ID and name
- Type and region
- Status (running/stopped/etc.)
- Configuration details
- Tags
- Estimated monthly cost (if available)

---

## 📁 File Structure

```
Backend/cloud/
├── app/
│   ├── main.py                    # FastAPI app entry point
│   ├── providers/aws/
│   │   ├── aws_auth.py           # AWS authentication
│   │   └── aws_scanner.py        # Resource discovery logic
│   ├── services/
│   │   └── discovery_service.py  # Discovery orchestration
│   └── workers/
│       └── discovery_worker.py   # Background job runner
├── .env                          # Configuration
├── requirements.txt              # Python dependencies
├── quick_aws_test.py            # Quick credential test ⭐
├── test_discovery.py            # Full integration test ⭐
├── run_service.bat              # Windows startup script ⭐
├── RUN_TEST.md                  # This file ⭐
└── TEST_INSTRUCTIONS.md         # Detailed documentation
```

---

## ❗ Troubleshooting

### Service won't start
```bash
# Check if port 8002 is in use
netstat -ano | findstr :8002

# Check PostgreSQL connection
psql -U migration_user -d actmon -h localhost
```

### "Network Error" when triggering discovery
- Ensure service is running on port 8002
- Check logs in the terminal where you ran `run_service.bat`
- Verify `.env` has correct `DATABASE_URL`

### AWS credentials failing
```bash
# Run quick test first
python quick_aws_test.py

# Common issues:
# - Credentials expired
# - No IAM permissions for describe operations
# - Wrong region specified
```

### Discovery completes but no resources found
- Check if the AWS account actually has resources in `ap-south-1`
- Try a different region with known resources
- Verify IAM permissions (see TEST_INSTRUCTIONS.md)

### Frontend shows empty
- Ensure Vite proxy is configured (check `vite.config.js`)
- Backend must be on port 8002
- Frontend must be on port 3000
- Check browser console for errors

---

## 🎯 Expected Test Results

### ✅ Success Criteria

After running `python test_discovery.py`, you should see:

1. ✓ Service health check passes
2. ✓ Account created with UUID
3. ✓ Discovery job triggered
4. ✓ Job status progresses: PENDING → RUNNING → COMPLETED
5. ✓ Resources found > 0
6. ✓ Frontend endpoint returns data

### 📈 Performance Benchmarks

- Account creation: < 500ms
- Discovery trigger: < 100ms
- Discovery scan: 30s - 3min (depends on # of regions & resources)
- Resource fetch: < 500ms

---

## 🔐 Security Notes

- Credentials are encrypted at rest using Fernet encryption
- Encryption key is auto-generated on first run
- Never commit `.env` file with real credentials
- Use IAM roles with minimal read-only permissions

---

## 📚 Additional Documentation

- **TEST_INSTRUCTIONS.md** - Comprehensive testing guide
- **API Docs** - http://127.0.0.1:8002/api/v1/cloud/docs
- **Database Schema** - See `app/models/` directory

---

## 🎉 What's Next?

After successful testing:

1. ✅ AWS discovery works
2. ➡️ Add Azure account (change provider to "AZURE")
3. ➡️ Add OCI account (change provider to "ORACLE")
4. ➡️ Test scheduled auto-discovery
5. ➡️ Implement cost tracking
6. ➡️ Add resource filtering in UI

---

## 💬 Need Help?

If you encounter issues:

1. Check the service logs (terminal where service is running)
2. Check database logs
3. Review TEST_INSTRUCTIONS.md for detailed troubleshooting
4. Check API docs for endpoint specifications
5. Review AWS CloudTrail for authentication issues

---

## 🚀 Quick Commands Cheat Sheet

```bash
# Start service
cd Backend\cloud && run_service.bat

# Quick test credentials
python quick_aws_test.py

# Full integration test
python test_discovery.py

# View API docs
start http://127.0.0.1:8002/api/v1/cloud/docs

# Check service health
curl http://127.0.0.1:8002/health

# List accounts
curl http://127.0.0.1:8002/api/v1/cloud/accounts
```

---

**Good luck! 🎯**
