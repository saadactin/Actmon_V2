"""
Quick service status checker for ACTMON.
Checks if all required services are running.
"""
import asyncio
import httpx
from datetime import datetime

SERVICES = {
    "Frontend (Vite)": "http://localhost:3001",
    "Database Backend": "http://127.0.0.1:8000/api/health",
    "Cloud Backend": "http://127.0.0.1:8002/health",
}

async def check_service(name, url):
    """Check if a service is responding."""
    async with httpx.AsyncClient() as client:
        try:
            response = await client.get(url, timeout=3.0)
            if response.status_code == 200:
                return True, "✅ RUNNING"
            else:
                return False, f"⚠️  Status {response.status_code}"
        except httpx.ConnectError:
            return False, "❌ NOT RUNNING"
        except Exception as e:
            return False, f"❌ ERROR: {str(e)[:30]}"

async def main():
    print("=" * 70)
    print("ACTMON Service Status Check")
    print("=" * 70)
    print(f"Time: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")

    results = []
    for name, url in SERVICES.items():
        running, status = await check_service(name, url)
        results.append((name, url, running, status))
        print(f"{name:25} {status:20} {url}")

    print("\n" + "=" * 70)

    running_count = sum(1 for _, _, running, _ in results if running)
    total_count = len(results)

    if running_count == total_count:
        print(f"✅ ALL SERVICES RUNNING ({running_count}/{total_count})")
    else:
        print(f"⚠️  SOME SERVICES DOWN ({running_count}/{total_count} running)")
        print("\nServices to start:")
        for name, url, running, _ in results:
            if not running:
                if "Database" in name:
                    print(f"  • {name}: cd Backend\\database && start_service.bat")
                elif "Cloud" in name:
                    print(f"  • {name}: cd Backend\\cloud && run_service.bat")
                elif "Frontend" in name:
                    print(f"  • {name}: cd Actmon_V1 && npm run dev")

    print("=" * 70)

if __name__ == "__main__":
    asyncio.run(main())
