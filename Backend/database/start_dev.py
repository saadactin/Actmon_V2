"""
Development server with auth bypass.
Starts on port 8000 and disables authentication.
"""
import uvicorn
import sys
import os

# Set environment flag to bypass auth
os.environ["BYPASS_AUTH"] = "true"

if __name__ == "__main__":
    print("=" * 70)
    print("ACTMON Database Backend - Development Mode")
    print("=" * 70)
    print("Port: 8000")
    print("Auth: BYPASSED (Development Only!)")
    print("API Docs: http://127.0.0.1:8000/docs")
    print("=" * 70)
    print()

    try:
        uvicorn.run(
            "main:app",
            host="0.0.0.0",
            port=8000,
            reload=True,
            log_level="info"
        )
    except OSError as e:
        if "10013" in str(e) or "permission" in str(e).lower():
            print("\n❌ ERROR: Port 8000 is blocked by Windows!")
            print("\nTry these solutions:")
            print("1. Run as Administrator")
            print("2. Or use a different port:")
            print("   python start_dev.py --port 8001")
            sys.exit(1)
        raise
