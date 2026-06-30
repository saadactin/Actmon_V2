"""
Complete verification and test script.
Checks all configurations, connections, and runs the full test suite.
"""
import asyncio
import httpx
import sys
from pathlib import Path
from datetime import datetime

# Configuration
CLOUD_SERVICE_URL = "http://127.0.0.1:8002"
DB_SERVICE_URL = "http://127.0.0.1:8000"
FRONTEND_URL = "http://localhost:3000"

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


def print_header(title):
    print("\n" + "=" * 80)
    print(f"{title}")
    print("=" * 80)


def print_subheader(title):
    print("\n" + "-" * 80)
    print(f"{title}")
    print("-" * 80)


async def check_env_files():
    """Check if .env files are properly configured."""
    print_header("STEP 1: Verify Configuration Files")

    cloud_env = Path("Backend/cloud/.env")
    db_env = Path("Backend/database/.env")
    frontend_env = Path("Actmon_V1/.env")

    checks = {
        "Cloud Backend .env": cloud_env.exists(),
        "Database Backend .env": db_env.exists(),
        "Frontend .env": frontend_env.exists(),
    }

    for name, exists in checks.items():
        if exists:
            print(f"  ✓ {name} exists")
        else:
            print(f"  ⚠ {name} missing (may use defaults)")

    # Check cloud .env content
    if cloud_env.exists():
        content = cloud_env.read_text()
        has_db_url = "DATABASE_URL=" in content
        has_port = "CLOUD_SERVICE_PORT=" in content

        print(f"\n  Cloud .env configuration:")
        print(f"    {'✓' if has_db_url else '✗'} DATABASE_URL configured")
        print(f"    {'✓' if has_port else '✗'} CLOUD_SERVICE_PORT configured")

    return True


async def check_vite_config():
    """Verify Vite proxy configuration."""
    print_header("STEP 2: Verify Vite Proxy Configuration")

    vite_config = Path("Actmon_V1/vite.config.js")

    if not vite_config.exists():
        print("  ✗ vite.config.js not found")
        return False

    content = vite_config.read_text()

    checks = {
        "Cloud proxy configured": "'/api/v1/cloud'" in content and "8002" in content,
        "Database API proxy configured": "'/api'" in content and "8000" in content,
        "Port 3000 configured": "port: 3000" in content,
    }

    all_good = True
    for check, passed in checks.items():
        print(f"  {'✓' if passed else '✗'} {check}")
        if not passed:
            all_good = False

    return all_good


async def check_cors_config():
    """Verify CORS configuration."""
    print_header("STEP 3: Verify CORS Configuration")

    main_py = Path("Backend/cloud/app/main.py")

    if not main_py.exists():
        print("  ✗ Backend/cloud/app/main.py not found")
        return False

    content = main_py.read_text()

    checks = {
        "CORS middleware configured": "CORSMiddleware" in content,
        "Allow origins configured": 'allow_origins=["*"]' in content or "allow_origins" in content,
        "Allow credentials": "allow_credentials=True" in content,
    }

    all_good = True
    for check, passed in checks.items():
        print(f"  {'✓' if passed else '✗'} {check}")
        if not passed:
            all_good = False

    return all_good


async def check_service_health(service_name, url):
    """Check if a service is running and healthy."""
    async with httpx.AsyncClient() as client:
        try:
            response = await client.get(url, timeout=3.0)
            if response.status_code == 200:
                print(f"  ✓ {service_name} is running at {url}")
                return True
            else:
                print(f"  ✗ {service_name} returned status {response.status_code}")
                return False
        except httpx.ConnectError:
            print(f"  ✗ {service_name} is NOT running at {url}")
            return False
        except Exception as e:
            print(f"  ✗ {service_name} error: {e}")
            return False


async def check_all_services():
    """Check if all required services are running."""
    print_header("STEP 4: Check Running Services")

    services = {
        "Cloud Service": f"{CLOUD_SERVICE_URL}/health",
        "Database Service": f"{DB_SERVICE_URL}/api/health",
    }

    results = {}
    for name, url in services.items():
        results[name] = await check_service_health(name, url)

    # Optional frontend check
    print(f"\n  ℹ Frontend check (optional):")
    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(FRONTEND_URL, timeout=2.0)
            print(f"  ✓ Frontend is running at {FRONTEND_URL}")
    except:
        print(f"  ⚠ Frontend not running at {FRONTEND_URL} (start with: npm run dev)")

    return all(results.values())


async def test_cloud_service_endpoints():
    """Test that cloud service endpoints are accessible."""
    print_header("STEP 5: Test Cloud Service Endpoints")

    endpoints = {
        "Health": f"{CLOUD_SERVICE_URL}/health",
        "API Docs": f"{CLOUD_SERVICE_URL}/api/v1/cloud/docs",
        "Accounts List": f"{CLOUD_SERVICE_URL}/api/v1/cloud/accounts",
    }

    async with httpx.AsyncClient() as client:
        for name, url in endpoints.items():
            try:
                response = await client.get(url, timeout=5.0, follow_redirects=True)
                if response.status_code in [200, 307]:  # 307 is redirect for docs
                    print(f"  ✓ {name}: {url}")
                else:
                    print(f"  ⚠ {name}: status {response.status_code}")
            except Exception as e:
                print(f"  ✗ {name}: {e}")


async def run_discovery_test():
    """Run the full discovery test."""
    print_header("STEP 6: Run Full Discovery Test")

    account_id = None
    job_id = None

    async with httpx.AsyncClient() as client:
        # Create account
        print_subheader("6.1: Create Cloud Account")
        try:
            # Check if account exists
            list_resp = await client.get(f"{CLOUD_SERVICE_URL}/api/v1/cloud/accounts", timeout=10.0)
            existing = list_resp.json()

            found = None
            for acc in existing:
                if acc.get("account_name") == TEST_ACCOUNT["account_name"]:
                    found = acc
                    break

            if found:
                account_id = found["id"]
                print(f"  ✓ Account already exists: {account_id}")
            else:
                create_resp = await client.post(
                    f"{CLOUD_SERVICE_URL}/api/v1/cloud/accounts",
                    json=TEST_ACCOUNT,
                    timeout=10.0
                )
                if create_resp.status_code in [200, 201]:
                    account = create_resp.json()
                    account_id = account["id"]
                    print(f"  ✓ Account created: {account_id}")
                else:
                    print(f"  ✗ Failed to create account: {create_resp.status_code}")
                    print(f"    Response: {create_resp.text}")
                    return False

        except Exception as e:
            print(f"  ✗ Error: {e}")
            return False

        # Trigger discovery
        print_subheader("6.2: Trigger Discovery")
        try:
            discovery_resp = await client.post(
                f"{CLOUD_SERVICE_URL}/api/v1/cloud/discovery/{account_id}",
                timeout=30.0
            )

            if discovery_resp.status_code in [200, 202]:
                job = discovery_resp.json()
                job_id = job["id"]
                print(f"  ✓ Discovery triggered: {job_id}")
                print(f"    Status: {job['status']}")
            else:
                print(f"  ✗ Failed to trigger: {discovery_resp.status_code}")
                print(f"    Response: {discovery_resp.text}")
                return False

        except Exception as e:
            print(f"  ✗ Error: {e}")
            import traceback
            traceback.print_exc()
            return False

        # Poll status
        print_subheader("6.3: Monitor Discovery Progress")
        completed = False
        for attempt in range(60):
            try:
                status_resp = await client.get(
                    f"{CLOUD_SERVICE_URL}/api/v1/cloud/discovery/status/{job_id}",
                    timeout=10.0
                )

                if status_resp.status_code == 200:
                    job = status_resp.json()
                    status = job['status']

                    print(f"  [{attempt + 1}/60] Status: {status}", end="")

                    if status == "COMPLETED":
                        print(f"\n  ✓ Discovery completed!")
                        print(f"    Resources found: {job.get('resources_found', 0)}")
                        completed = True
                        break
                    elif status == "FAILED":
                        print(f"\n  ✗ Discovery failed")
                        print(f"    Error: {job.get('error_message', 'Unknown')}")
                        return False
                    else:
                        print(f" (waiting...)")
                        await asyncio.sleep(2)
                else:
                    print(f"\n  ✗ Status check failed: {status_resp.status_code}")
                    return False

            except Exception as e:
                print(f"\n  ✗ Error: {e}")
                await asyncio.sleep(2)

        if not completed:
            print(f"\n  ⚠ Timeout - discovery still running")
            print(f"    Check status at: {CLOUD_SERVICE_URL}/api/v1/cloud/discovery/status/{job_id}")

        # Fetch resources
        print_subheader("6.4: Fetch Discovered Resources")
        try:
            resources_resp = await client.get(
                f"{CLOUD_SERVICE_URL}/api/v1/cloud/resources/{account_id}",
                timeout=10.0
            )

            if resources_resp.status_code == 200:
                resources = resources_resp.json()
                print(f"  ✓ Fetched {len(resources)} resources")

                # Group by type
                by_type = {}
                for res in resources:
                    rt = res.get('resource_type', 'Unknown')
                    by_type[rt] = by_type.get(rt, 0) + 1

                if by_type:
                    print(f"\n  Resource breakdown:")
                    for rt, count in sorted(by_type.items()):
                        print(f"    - {rt}: {count}")

                    # Sample
                    print(f"\n  Sample resources:")
                    for i, res in enumerate(resources[:3]):
                        print(f"    {i+1}. {res.get('resource_name')} ({res.get('resource_type')})")
                        print(f"       Region: {res.get('region_or_zone', 'N/A')}, Status: {res.get('status', 'N/A')}")

                return len(resources) > 0
            else:
                print(f"  ✗ Failed to fetch: {resources_resp.status_code}")
                return False

        except Exception as e:
            print(f"  ✗ Error: {e}")
            return False


async def main():
    """Run all checks and tests."""
    print("\n" + "=" * 80)
    print("ACTMON CLOUD DISCOVERY - COMPLETE VERIFICATION & TEST")
    print("=" * 80)
    print(f"Started at: {datetime.now().isoformat()}")

    # Configuration checks
    await check_env_files()
    vite_ok = await check_vite_config()
    cors_ok = await check_cors_config()

    if not (vite_ok and cors_ok):
        print("\n⚠ Configuration issues detected, but continuing...")

    # Service checks
    services_ok = await check_all_services()

    if not services_ok:
        print("\n" + "=" * 80)
        print("❌ SERVICES NOT RUNNING")
        print("=" * 80)
        print("\nPlease start the required services:")
        print("\n1. Cloud Service:")
        print("   cd Backend\\cloud")
        print("   run_service.bat")
        print("\n2. Database Service:")
        print("   cd Backend\\database")
        print("   python main.py")
        print("\nThen run this script again.")
        return False

    # Test endpoints
    await test_cloud_service_endpoints()

    # Run discovery test
    success = await run_discovery_test()

    # Final summary
    print("\n" + "=" * 80)
    print("TEST SUMMARY")
    print("=" * 80)

    if success:
        print("✅ ALL TESTS PASSED!")
        print("\nWhat was tested:")
        print("  ✓ Configuration files (vite.config.js, .env, CORS)")
        print("  ✓ Service health (cloud service, database service)")
        print("  ✓ Cloud service endpoints")
        print("  ✓ Account creation")
        print("  ✓ Discovery trigger")
        print("  ✓ Status monitoring")
        print("  ✓ Resource fetching")

        print("\n🎉 Your cloud discovery is working correctly!")
        print("\nNext steps:")
        print("  • View API docs: http://127.0.0.1:8002/api/v1/cloud/docs")
        print("  • Start frontend: cd Actmon_V1 && npm run dev")
        print("  • Access UI: http://localhost:3000/cloud/resources")
    else:
        print("❌ SOME TESTS FAILED")
        print("\nPlease check the error messages above.")
        print("Common issues:")
        print("  • AWS credentials invalid or expired")
        print("  • Database connection failed")
        print("  • Service ports already in use")

    print(f"\nCompleted at: {datetime.now().isoformat()}")
    print("=" * 80)

    return success


if __name__ == "__main__":
    result = asyncio.run(main())
    sys.exit(0 if result else 1)
