"""
Test script for cloud discovery functionality.
Tests account creation, discovery trigger, and resource fetching with AWS credentials.
"""
import asyncio
import httpx
import json
from datetime import datetime

# Configuration
BASE_URL = "http://127.0.0.1:8002/api/v1"
TEST_ACCOUNT = {
    "provider": "AWS",
    "account_name": "my-aws-account",
    "aws_access_key_id": "YOUR_AWS_ACCESS_KEY_HERE",
    "aws_secret_access_key": "YOUR_AWS_SECRET_KEY_HERE",
    "aws_session_token": "",
    "aws_account_id": "YOUR_AWS_ACCOUNT_ID",
    "region": "ap-south-1",
    "environment": "Development",
    "auth_mode": "Access Key",
    "auto_discovery_enabled": True
}


async def test_health():
    """Test if the cloud service is running."""
    print("=" * 80)
    print("STEP 1: Health Check")
    print("=" * 80)

    async with httpx.AsyncClient() as client:
        try:
            response = await client.get(f"{BASE_URL.replace('/api/v1', '')}/health", timeout=5.0)
            print(f"✓ Service is running: {response.json()}")
            return True
        except Exception as e:
            print(f"✗ Service is not running: {e}")
            print("\nPlease start the cloud service:")
            print("  cd Backend/cloud")
            print("  python -m uvicorn app.main:app --reload --port 8002")
            return False


async def test_create_account():
    """Create a cloud account."""
    print("\n" + "=" * 80)
    print("STEP 2: Create Cloud Account")
    print("=" * 80)

    async with httpx.AsyncClient() as client:
        try:
            # First check if account already exists
            list_response = await client.get(f"{BASE_URL}/cloud/accounts", timeout=10.0)
            existing_accounts = list_response.json()

            # Find if our test account already exists
            for acc in existing_accounts:
                if acc.get("account_name") == TEST_ACCOUNT["account_name"]:
                    print(f"✓ Account already exists: {acc['id']}")
                    return acc["id"]

            # Create new account
            response = await client.post(
                f"{BASE_URL}/cloud/accounts",
                json=TEST_ACCOUNT,
                timeout=10.0
            )

            if response.status_code in [200, 201]:
                account = response.json()
                print(f"✓ Account created successfully")
                print(f"  Account ID: {account['id']}")
                print(f"  Provider: {account['provider']}")
                print(f"  Region: {account.get('region', 'N/A')}")
                return account["id"]
            else:
                print(f"✗ Failed to create account: {response.status_code}")
                print(f"  Response: {response.text}")
                return None

        except Exception as e:
            print(f"✗ Error creating account: {e}")
            return None


async def test_trigger_discovery(account_id: str):
    """Trigger discovery for the account."""
    print("\n" + "=" * 80)
    print("STEP 3: Trigger Discovery")
    print("=" * 80)

    async with httpx.AsyncClient() as client:
        try:
            response = await client.post(
                f"{BASE_URL}/cloud/discovery/{account_id}",
                timeout=30.0
            )

            if response.status_code in [200, 202]:
                job = response.json()
                print(f"✓ Discovery triggered successfully")
                print(f"  Job ID: {job['id']}")
                print(f"  Status: {job['status']}")
                print(f"  Started at: {job.get('started_at', 'N/A')}")
                return job["id"]
            else:
                print(f"✗ Failed to trigger discovery: {response.status_code}")
                print(f"  Response: {response.text}")
                return None

        except Exception as e:
            print(f"✗ Error triggering discovery: {e}")
            import traceback
            traceback.print_exc()
            return None


async def test_poll_status(job_id: str, max_attempts: int = 60):
    """Poll discovery job status until completion or timeout."""
    print("\n" + "=" * 80)
    print("STEP 4: Poll Discovery Status")
    print("=" * 80)

    async with httpx.AsyncClient() as client:
        for attempt in range(max_attempts):
            try:
                response = await client.get(
                    f"{BASE_URL}/cloud/discovery/status/{job_id}",
                    timeout=10.0
                )

                if response.status_code == 200:
                    job = response.json()
                    status = job['status']

                    print(f"  [{attempt + 1}/{max_attempts}] Status: {status}", end="")

                    if status == "COMPLETED":
                        print(f"\n✓ Discovery completed!")
                        print(f"  Resources found: {job.get('resources_found', 0)}")
                        print(f"  Completed at: {job.get('completed_at', 'N/A')}")
                        return True
                    elif status == "FAILED":
                        print(f"\n✗ Discovery failed")
                        print(f"  Error: {job.get('error_message', 'Unknown error')}")
                        return False
                    elif status in ["PENDING", "RUNNING"]:
                        print(f" (waiting...)")
                        await asyncio.sleep(2)
                    else:
                        print(f" (unknown status: {status})")
                        await asyncio.sleep(2)
                else:
                    print(f"\n✗ Failed to get status: {response.status_code}")
                    return False

            except Exception as e:
                print(f"\n✗ Error polling status: {e}")
                await asyncio.sleep(2)

        print(f"\n✗ Timeout waiting for discovery to complete")
        return False


async def test_fetch_resources(account_id: str):
    """Fetch discovered resources."""
    print("\n" + "=" * 80)
    print("STEP 5: Fetch Resources")
    print("=" * 80)

    async with httpx.AsyncClient() as client:
        try:
            # Use the correct resources endpoint with account_id in path
            response = await client.get(
                f"{BASE_URL}/cloud/resources/{account_id}",
                timeout=10.0
            )

            if response.status_code == 200:
                resources = response.json()
                print(f"✓ Fetched {len(resources)} resources")

                # Group by resource type
                by_type = {}
                for res in resources:
                    rt = res.get('resource_type', 'Unknown')
                    by_type[rt] = by_type.get(rt, 0) + 1

                print(f"\nResource breakdown:")
                for rt, count in sorted(by_type.items()):
                    print(f"  - {rt}: {count}")

                # Show first few resources
                print(f"\nSample resources:")
                for i, res in enumerate(resources[:5]):
                    print(f"  {i+1}. {res.get('resource_name')} ({res.get('resource_type')})")
                    print(f"     Region: {res.get('region_or_zone', 'N/A')}")
                    print(f"     Status: {res.get('status', 'N/A')}")

                return resources
            else:
                print(f"✗ Failed to fetch resources: {response.status_code}")
                print(f"  Response: {response.text}")
                return []

        except Exception as e:
            print(f"✗ Error fetching resources: {e}")
            return []


async def test_frontend_inventory(account_id: str):
    """Test the frontend-compatible inventory endpoint."""
    print("\n" + "=" * 80)
    print("STEP 6: Test Frontend Inventory Endpoint")
    print("=" * 80)

    async with httpx.AsyncClient() as client:
        try:
            response = await client.get(
                f"{BASE_URL}/cloud/aws/{account_id}/inventory",
                timeout=10.0
            )

            if response.status_code == 200:
                resources = response.json()
                print(f"✓ Frontend inventory endpoint working: {len(resources)} resources")
                return True
            else:
                print(f"✗ Frontend inventory failed: {response.status_code}")
                print(f"  Response: {response.text}")
                return False

        except Exception as e:
            print(f"✗ Error testing frontend endpoint: {e}")
            return False


async def main():
    """Run all tests."""
    print("\n" + "=" * 80)
    print("ACTMON Cloud Discovery Test Suite")
    print("=" * 80)
    print(f"Started at: {datetime.now().isoformat()}")
    print(f"Testing against: {BASE_URL}")

    # Step 1: Health check
    if not await test_health():
        return

    # Step 2: Create account
    account_id = await test_create_account()
    if not account_id:
        print("\n✗ Cannot proceed without account ID")
        return

    # Step 3: Trigger discovery
    job_id = await test_trigger_discovery(account_id)
    if not job_id:
        print("\n✗ Cannot proceed without job ID")
        return

    # Step 4: Poll status
    success = await test_poll_status(job_id)
    if not success:
        print("\n⚠ Discovery did not complete successfully, but continuing with resource fetch...")

    # Step 5: Fetch resources
    resources = await test_fetch_resources(account_id)

    # Step 6: Test frontend endpoint
    await test_frontend_inventory(account_id)

    # Summary
    print("\n" + "=" * 80)
    print("TEST SUMMARY")
    print("=" * 80)
    print(f"Account ID: {account_id}")
    print(f"Job ID: {job_id}")
    print(f"Resources found: {len(resources)}")
    print(f"Completed at: {datetime.now().isoformat()}")
    print("\nNext steps:")
    print("  1. Check the frontend at: http://localhost:3000/cloud/resources")
    print("  2. View API docs at: http://127.0.0.1:8002/api/v1/cloud/docs")


if __name__ == "__main__":
    asyncio.run(main())
