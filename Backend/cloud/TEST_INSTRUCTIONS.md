# Cloud Discovery Test Instructions

## Overview
This document provides step-by-step instructions to test the ACTMON Cloud Discovery functionality with AWS credentials.

## Prerequisites

1. **Python 3.9+** installed
2. **PostgreSQL** database running (configured in `.env`)
3. **AWS Credentials** (provided in test data)

## Test Data

```json
{
  "provider": "AWS",
  "account_name": "my-aws-account",
  "aws_access_key_id": "YOUR_AWS_ACCESS_KEY_HERE",
  "aws_secret_access_key": "YOUR_AWS_SECRET_KEY_HERE",
  "aws_session_token": "",
  "aws_account_id": "YOUR_AWS_ACCOUNT_ID",
  "region": "ap-south-1",
  "environment": "Development",
  "auth_mode": "Access Key",
  "auto_discovery_enabled": true
}
```

## Step-by-Step Testing

### 1. Start the Database Service (if not running)

```bash
cd Backend/database
# Activate your virtual environment
# On Windows:
venv\Scripts\activate
# On Linux/Mac:
source venv/bin/activate

# Start the database service (port 8000)
python main.py
# or
uvicorn main:app --reload --port 8000
```

### 2. Start the Cloud Discovery Service

**Option A: Using the batch file (Windows)**
```bash
cd Backend/cloud
run_service.bat
```

**Option B: Manual startup**
```bash
cd Backend/cloud

# Create and activate virtual environment (if not exists)
python -m venv venv
venv\Scripts\activate  # Windows
source venv/bin/activate  # Linux/Mac

# Install dependencies
pip install -r requirements.txt

# Start the service
python -m uvicorn app.main:app --reload --port 8002 --host 0.0.0.0
```

The service will start on port **8002** and API docs will be available at:
**http://127.0.0.1:8002/api/v1/cloud/docs**

### 3. Start the Frontend (if testing UI)

```bash
cd Actmon_V1
npm install  # if not done already
npm run dev
```

Frontend will be available at: **http://localhost:3000**

### 4. Run the Test Script

Open a new terminal and run:

```bash
cd Backend/cloud
# Activate virtual environment
venv\Scripts\activate  # Windows
source venv/bin/activate  # Linux/Mac

# Install httpx if not already installed
pip install httpx

# Run the test
python test_discovery.py
```

## What the Test Does

The test script performs the following operations:

1. **Health Check** - Verifies the cloud service is running
2. **Create Account** - Adds the AWS test account to the database
3. **Trigger Discovery** - Initiates a background discovery scan
4. **Poll Status** - Monitors the discovery job until completion
5. **Fetch Resources** - Retrieves discovered resources
6. **Test Frontend Endpoint** - Validates the frontend-compatible API

## Expected Output

```
================================================================================
ACTMON Cloud Discovery Test Suite
================================================================================
Started at: 2026-06-12T...
Testing against: http://127.0.0.1:8002/api/v1

================================================================================
STEP 1: Health Check
================================================================================
✓ Service is running: {'status': 'healthy'}

================================================================================
STEP 2: Create Cloud Account
================================================================================
✓ Account created successfully
  Account ID: <uuid>
  Provider: AWS
  Region: ap-south-1

================================================================================
STEP 3: Trigger Discovery
================================================================================
✓ Discovery triggered successfully
  Job ID: <uuid>
  Status: PENDING
  Started at: <timestamp>

================================================================================
STEP 4: Poll Discovery Status
================================================================================
  [1/60] Status: RUNNING (waiting...)
  [2/60] Status: RUNNING (waiting...)
  ...
  [N/60] Status: COMPLETED
✓ Discovery completed!
  Resources found: X
  Completed at: <timestamp>

================================================================================
STEP 5: Fetch Resources
================================================================================
✓ Fetched X resources

Resource breakdown:
  - EC2Instance: 2
  - S3Bucket: 5
  - RDSInstance: 1
  - LambdaFunction: 3
  ...

Sample resources:
  1. my-instance (EC2Instance)
     Region: ap-south-1a
     Status: running
  ...

================================================================================
STEP 6: Test Frontend Inventory Endpoint
================================================================================
✓ Frontend inventory endpoint working: X resources

================================================================================
TEST SUMMARY
================================================================================
Account ID: <uuid>
Job ID: <uuid>
Resources found: X
Completed at: <timestamp>

Next steps:
  1. Check the frontend at: http://localhost:3000/cloud/resources
  2. View API docs at: http://127.0.0.1:8002/api/v1/cloud/docs
```

## Testing from Frontend

1. Navigate to **http://localhost:3000/cloud/resources**
2. You should see the account listed
3. Click on the account to view discovered resources
4. You can trigger a manual discovery from the UI

## Testing via API Docs

1. Navigate to **http://127.0.0.1:8002/api/v1/cloud/docs**
2. Test the following endpoints:

   - `POST /api/v1/cloud/accounts` - Create account
   - `GET /api/v1/cloud/accounts` - List accounts
   - `POST /api/v1/cloud/discovery/{account_id}` - Trigger discovery
   - `GET /api/v1/cloud/discovery/status/{job_id}` - Check status
   - `GET /api/v1/cloud/resources` - Fetch resources
   - `GET /api/v1/cloud/aws/{account_id}/inventory` - Frontend endpoint

## Testing with cURL

### Create Account
```bash
curl -X POST http://127.0.0.1:8002/api/v1/cloud/accounts \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "AWS",
    "account_name": "my-aws-account",
    "aws_access_key_id": "YOUR_AWS_ACCESS_KEY_HERE",
    "aws_secret_access_key": "YOUR_AWS_SECRET_KEY_HERE",
    "aws_account_id": "YOUR_AWS_ACCOUNT_ID",
    "region": "ap-south-1",
    "environment": "Development",
    "auth_mode": "Access Key",
    "auto_discovery_enabled": true
  }'
```

### Trigger Discovery
```bash
curl -X POST http://127.0.0.1:8002/api/v1/cloud/discovery/{account_id}
```

### Check Status
```bash
curl http://127.0.0.1:8002/api/v1/cloud/discovery/status/{job_id}
```

### List Resources
```bash
curl "http://127.0.0.1:8002/api/v1/cloud/resources?account_id={account_id}"
```

## Troubleshooting

### Service won't start
- Check if PostgreSQL is running
- Verify `.env` file has correct database credentials
- Check if port 8002 is available

### "Network Error" in frontend
- Ensure cloud service is running on port 8002
- Check Vite proxy configuration in `vite.config.js`
- Verify CORS settings in `app/main.py`

### Discovery fails
- Check AWS credentials are valid
- Verify region is correct
- Check logs for specific error messages
- Ensure IAM permissions allow resource discovery

### No resources found
- Verify AWS account actually has resources in the specified region
- Check if credentials have read permissions
- Try with a different region

## AWS IAM Permissions Required

The AWS credentials need the following read-only permissions:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ec2:DescribeInstances",
        "ec2:DescribeRegions",
        "rds:DescribeDBInstances",
        "s3:ListAllMyBuckets",
        "s3:GetBucketLocation",
        "lambda:ListFunctions",
        "eks:ListClusters",
        "eks:DescribeCluster",
        "elasticloadbalancing:DescribeLoadBalancers"
      ],
      "Resource": "*"
    }
  ]
}
```

## Database Schema

The cloud service uses the following tables:

- `cloud_accounts` - Stores cloud provider credentials (encrypted)
- `cloud_resources` - Stores discovered resources
- `discovery_jobs` - Tracks discovery job status

## Next Steps

After successful testing:

1. Add more test accounts for Azure and Oracle Cloud
2. Test auto-discovery scheduled jobs
3. Test cost analysis features
4. Test resource filtering and search
5. Validate frontend UI components
