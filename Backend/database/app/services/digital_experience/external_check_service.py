"""
Digital Experience — external check execution + scheduler.

Runs the network-probe types that need no browser/client SDK: Website
Availability (HTTP/HTTPS), Ping, DNS, TCP Port, UDP Port. Synthetic
Transaction, Page Speed and RUM aren't executed here — they need a headless
browser (Playwright/Chromium) or a client-side beacon SDK + ingestion
endpoint, neither of which exists in this codebase yet, so their wizard
cards stay marked "Soon" rather than faking a result.

Each probe runs on the ActMon server itself (stdlib only — urllib/socket/
subprocess — no new dependency), on its own daemon thread so one slow/hung
target can never block the scheduler tick for every other check.
"""
import platform
import socket
import subprocess
import threading
import time
import urllib.request
import urllib.error
from datetime import datetime

from app.database.connection import SessionLocal
from app.models.external_check_model import ExternalCheck, ExternalCheckResult

CHECK_TYPES = ("website", "ping", "dns", "tcp_port", "udp_port")
DEFAULT_TIMEOUT_SEC = 10


def _cfg(check, key, default=None):
    return (check.config or {}).get(key, default)


def _check_website(check):
    protocol = _cfg(check, "protocol", "https")
    url = check.target if "://" in check.target else f"{protocol}://{check.target}"
    timeout = _cfg(check, "timeout_sec", DEFAULT_TIMEOUT_SEC)
    req = urllib.request.Request(url, headers={"User-Agent": "actmon/1.0 (www.actin.co.in/actmon-observability)"})
    started = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            elapsed_ms = (time.monotonic() - started) * 1000
            body = resp.read(65536).decode("utf-8", errors="replace") if _cfg(check, "string_match") else ""
            match = _cfg(check, "string_match")
            if match and match not in body:
                return "down", elapsed_ms, resp.status, f"Expected text not found: {match!r}"
            return "up", elapsed_ms, resp.status, None
    except urllib.error.HTTPError as e:
        elapsed_ms = (time.monotonic() - started) * 1000
        expected = _cfg(check, "expected_status")
        if expected and e.code == int(expected):
            return "up", elapsed_ms, e.code, None
        return "down", elapsed_ms, e.code, f"HTTP {e.code}"
    except Exception as e:  # noqa: BLE001 — any network failure means "down", not a crash
        return "down", (time.monotonic() - started) * 1000, None, str(e)[:500]


def _check_ping(check):
    # Production runs on Linux (ping -c count -W timeout_sec); Windows' ping.exe
    # uses different flags entirely (-n count, -w timeout_ms) — branching here
    # means this also works for local dev/testing on a Windows machine, not
    # just the deployed server.
    timeout = int(_cfg(check, "timeout_sec", DEFAULT_TIMEOUT_SEC))
    started = time.monotonic()
    try:
        if platform.system() == "Windows":
            cmd = ["ping", "-n", "3", "-w", str(max(1000, timeout * 1000 // 3)), check.target]
        else:
            cmd = ["ping", "-c", "3", "-W", str(max(1, timeout // 3)), check.target]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        elapsed_ms = (time.monotonic() - started) * 1000
        out = (proc.stdout or "") + (proc.stderr or "")
        low = out.lower()
        reachable = proc.returncode == 0 and "100% packet loss" not in low and "100% loss" not in low
        return ("up" if reachable else "down"), elapsed_ms, None, (None if reachable else (out.strip()[:500] or "No reply"))
    except subprocess.TimeoutExpired:
        return "down", (time.monotonic() - started) * 1000, None, "Timed out"
    except Exception as e:  # noqa: BLE001
        return "down", (time.monotonic() - started) * 1000, None, str(e)[:500]


def _check_dns(check):
    started = time.monotonic()
    try:
        socket.gethostbyname(check.target)
        return "up", (time.monotonic() - started) * 1000, None, None
    except socket.gaierror as e:
        return "down", (time.monotonic() - started) * 1000, None, str(e)[:500]
    except Exception as e:  # noqa: BLE001
        return "down", (time.monotonic() - started) * 1000, None, str(e)[:500]


def _check_tcp_port(check):
    timeout = _cfg(check, "timeout_sec", DEFAULT_TIMEOUT_SEC)
    started = time.monotonic()
    try:
        with socket.create_connection((check.target, check.port), timeout=timeout):
            return "up", (time.monotonic() - started) * 1000, None, None
    except Exception as e:  # noqa: BLE001
        return "down", (time.monotonic() - started) * 1000, None, str(e)[:500]


def _check_udp_port(check):
    # UDP is connectionless — there's no handshake to confirm a listener is
    # there. The honest signal available without a protocol-specific payload:
    # send an empty datagram, then briefly wait for either a reply or an ICMP
    # "port unreachable" (raised locally as ConnectionRefusedError). Silence
    # is genuinely ambiguous for UDP, so it's reported as "up" rather than
    # guessed at as down — same open-question every generic UDP checker has.
    timeout = _cfg(check, "timeout_sec", DEFAULT_TIMEOUT_SEC)
    started = time.monotonic()
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.settimeout(timeout)
            s.sendto(b"", (check.target, check.port))
            try:
                s.recvfrom(512)
            except socket.timeout:
                pass
            return "up", (time.monotonic() - started) * 1000, None, None
    except ConnectionRefusedError:
        return "down", (time.monotonic() - started) * 1000, None, "Port unreachable (ICMP)"
    except Exception as e:  # noqa: BLE001
        return "down", (time.monotonic() - started) * 1000, None, str(e)[:500]


_RUNNERS = {
    "website": _check_website,
    "ping": _check_ping,
    "dns": _check_dns,
    "tcp_port": _check_tcp_port,
    "udp_port": _check_udp_port,
}


def run_check_now(check_id: int) -> dict:
    """Execute one check immediately and persist the result — used by both
    the scheduler tick and a manual "Test now" button."""
    db = SessionLocal()
    try:
        check = db.query(ExternalCheck).filter(ExternalCheck.id == check_id).first()
        if not check:
            return {"error": "Check not found"}
        runner = _RUNNERS.get(check.check_type)
        if not runner:
            return {"error": f"Unsupported check type: {check.check_type}"}
        status, response_time_ms, status_code, error_message = runner(check)
        now = datetime.utcnow()
        db.add(ExternalCheckResult(
            check_id=check.id, org_id=check.org_id, checked_at=now,
            status=status, response_time_ms=response_time_ms,
            status_code=status_code, error_message=error_message,
        ))
        check.last_checked_at = now
        check.last_status = status
        check.last_response_time_ms = response_time_ms
        db.commit()
        return {"status": status, "response_time_ms": response_time_ms, "status_code": status_code, "error_message": error_message}
    finally:
        db.close()


_scheduler_started = False
_scheduler_lock = threading.Lock()


def start_external_check_scheduler():
    """Every 30s, run any enabled check whose interval has elapsed since its
    last run. Each due check executes on its own daemon thread so a slow
    target (e.g. a timing-out ping) never delays the others."""
    global _scheduler_started
    with _scheduler_lock:
        if _scheduler_started:
            return
        _scheduler_started = True

    def _loop():
        while True:
            time.sleep(30)
            try:
                db = SessionLocal()
                now = datetime.utcnow()
                due = []
                for c in db.query(ExternalCheck).filter(ExternalCheck.enabled == True).all():  # noqa: E712
                    if c.last_checked_at is None or (now - c.last_checked_at).total_seconds() >= c.interval_seconds:
                        due.append(c.id)
                db.close()
                for check_id in due:
                    threading.Thread(target=run_check_now, args=(check_id,), daemon=True).start()
            except Exception:  # noqa: BLE001 — one bad tick must not kill the loop
                pass

    threading.Thread(target=_loop, daemon=True).start()
