"""
"Is the ActMon agent SERVICE actually running?" — asked over the agent's own
job channel, with no SSH involved.

The agent is push-only and reaches us by long-polling /agents/fs-poll. That poll
loop only exists while the service is up, so the two directions are NOT
symmetric — and getting that wrong is what made this report false negatives:

  * agent answered → PROOF the service is running. Liveness comes from the fact
    of a reply, never from whether we could parse it. An unparseable answer (an
    older agent replying "unsupported op: shell", or unreadable output) still
    means alive; it was previously scored running=False, so demonstrably healthy
    hosts were labelled "Service Stopped".
  * agent silent → AMBIGUOUS, not proof of anything. A stopped service, an
    uninstalled agent, a powered-off host, blocked egress, and simply a loaded
    host missing the probe window all look identical from here. So silence is
    cross-checked against the agent's own heartbeat: if it reported data
    recently it was demonstrably running then, and the verdict is "running but
    its push is lagging/failing" (`unconfirmed`) rather than "stopped".

Only silence PLUS no recent data is reported as `inactive`.

A host with no agent token (SSH-collected) has no channel to ask on, so it is
reported `checked: False` / `no-agent` and the caller keeps whatever the
heartbeat rule decided — never a fabricated state.
"""
import logging
import os
import re

from sqlalchemy import text

logger = logging.getLogger("agent_service_state")

# Service identifiers created by the installers:
#   Linux  — Backend/agent/linux/common/actmon-agent.service  (systemd unit)
#   Windows— Backend/agent/wix/product.wxs  <ServiceInstall Name="ActMonAgent">
LINUX_UNIT = "actmon-agent"
WINDOWS_SERVICE = "ActMonAgent"

# The probe runs off-thread (never inside the reaper's pass), so it can afford to
# wait properly. 6s proved far too tight: a loaded Windows host whose agent is
# mid-collection can miss that window and get reported "not running" while it is
# demonstrably alive. The agent's own job long-poll holds ~15s, so the timeout
# has to exceed one full poll cycle to be meaningful at all.
PROBE_TIMEOUT_SEC = int(os.getenv("AGENT_SVC_PROBE_TIMEOUT_SECS", "20"))
# If the agent reported data more recently than this, treat a silent probe as
# "running but lagging" rather than "stopped" — it demonstrably ran that recently.
RECENT_REPORT_SEC = int(os.getenv("AGENT_SVC_RECENT_REPORT_SECS", "1800"))   # 30 min

# systemd ActiveState values that mean the unit is genuinely serving.
_UP_STATES = {"active", "reloading"}
_KNOWN_LINUX = _UP_STATES | {"inactive", "failed", "activating", "deactivating"}
_WIN_UP = {"running"}
_KNOWN_WIN = _WIN_UP | {"stopped", "paused", "startpending", "stoppending",
                        "continuepending", "pausepending"}
# `sc query` STATE codes — the numeric code is the reliable field to key on
# (the adjacent word is localized on non-English Windows, the number never is).
_SC_STATE_CODES = {
    "1": "stopped", "2": "startpending", "3": "stoppending",
    "4": "running", "5": "continuepending", "6": "pausepending", "7": "paused",
}
_SC_STATE_RE = re.compile(r"^\s*STATE\s*:\s*(\d+)", re.MULTILINE)
# `schtasks /query /TN <name> /FO LIST` prints "Status:  Running|Ready|Disabled"
# — used when the agent is installed as a scheduled task rather than a service.
_SCHTASK_STATUS_RE = re.compile(r"^\s*Status\s*:\s*(\S+)", re.MULTILINE)
# A registered task that isn't currently executing, and a disabled one, are both
# "installed but not serving" — distinct from a stopped service.
_WIN_TASK_NOT_RUNNING = {"task-ready", "task-disabled"}


def _is_windows(os_type):
    return "win" in (os_type or "").lower()


def _last_heartbeat_age(agent_name: str, db):
    """Seconds since this agent last successfully reported, or None."""
    try:
        row = db.execute(text(
            "SELECT EXTRACT(EPOCH FROM (now() - last_heartbeat)) FROM agents WHERE agent_name = :n"),
            {"n": agent_name}).first()
        return float(row[0]) if row and row[0] is not None else None
    except Exception:  # noqa: BLE001
        return None


def resolve_agent_host(agent_name: str, db):
    """Find the os_servers row backing this agent, for either shape:
      * host agent  — agents.agent_name matches os_servers.hostname
      * db agent    — agents.db_connection_id → database_instances → os_servers
    Returns a row with (agent_token, os_type, hostname) or None.
    """
    row = db.execute(text(
        "SELECT s.agent_token, s.os_type, s.hostname FROM os_servers s "
        "WHERE s.hostname = :n AND s.agent_token IS NOT NULL LIMIT 1"
    ), {"n": agent_name}).first()
    if row:
        return row
    return db.execute(text(
        "SELECT s.agent_token, s.os_type, s.hostname FROM agents a "
        "JOIN database_instances di ON di.connection_id = a.db_connection_id "
        "JOIN os_servers s ON s.id = di.server_id "
        "WHERE a.agent_name = :n AND s.agent_token IS NOT NULL LIMIT 1"
    ), {"n": agent_name}).first()


def _parse_state(raw: str, windows: bool) -> str:
    """Normalize the service manager's own word for the state.

    Windows goes through `sc query` (see probe() for why, not PowerShell), whose
    output is a multi-line block — so the whole text is scanned for the STATE
    code rather than only inspecting the first line.
    """
    text_all = (raw or "").strip()
    low_all = text_all.lower()

    if windows:
        # A service STATE line is the strongest signal — take it if present.
        m = _SC_STATE_RE.search(text_all)
        if m:
            return _SC_STATE_CODES.get(m.group(1), "unknown")
        # No service. Fall back to the scheduled-task installation, whose
        # `schtasks /FO LIST` output carries a "Status:" line. A long-running
        # agent task reads "Running"; "Ready" means registered but not
        # currently executing (so the agent process is NOT up right now).
        m2 = _SCHTASK_STATUS_RE.search(text_all)
        if m2:
            st = m2.group(1).strip().lower()
            if st.startswith("running"):
                return "running"
            if st.startswith("ready"):
                return "task-ready"
            if st.startswith("disabled"):
                return "task-disabled"
            return "unknown"

    # Uninstalled / never installed — neither a service nor a task answered.
    # (Checked AFTER the positive signals above: on a task-installed host the
    # `sc` half legitimately reports 1060 while the task half is healthy, so
    # matching 1060 first would misreport a working agent as not-installed.)
    if ("could not be found" in low_all or "no such service" in low_all
            or "cannot find any service" in low_all or "1060" in low_all
            or "does not exist as an installed service" in low_all
            or "cannot find the file specified" in low_all):
        return "not-installed"

    if windows:
        # Fall through: also accept a bare Get-Service word, in case a future
        # caller pipes PowerShell output in here.
        first = low_all.splitlines()[0].strip() if low_all else ""
        return first if first in _KNOWN_WIN else "unknown"

    first = low_all.splitlines()[0].strip() if low_all else ""
    return first if first in _KNOWN_LINUX else "unknown"


def probe(agent_name: str, db, timeout: int = PROBE_TIMEOUT_SEC) -> dict:
    """Ask the agent about its own service. Never raises — callers run this in
    status paths where an exception must not break the pass."""
    try:
        host = resolve_agent_host(agent_name, db)
    except Exception as e:  # noqa: BLE001
        logger.debug("[agent_svc] host lookup failed for %s: %s", agent_name, e)
        return {"checked": False, "state": "unknown", "running": None,
                "detail": "Could not resolve the host for this agent."}

    if not host or not host.agent_token:
        return {"checked": False, "state": "no-agent", "running": None,
                "detail": "This host is not agent-collected, so there is no agent service to check."}

    windows = _is_windows(host.os_type)
    # The agent's `shell` op runs `cmd /c <cmd>` on Windows and `bash -c` on Linux
    # (see _shell in actmon_agent.py) — NOT PowerShell. Sending PowerShell syntax
    # here made cmd.exe return a parse error, which read back as state 'unknown'
    # even though the agent had answered perfectly. `sc query` is native to
    # cmd.exe, needs no PowerShell (so it also can't be blocked by an execution
    # policy), and its numeric STATE code is locale-independent.
    # On Windows the agent may be installed EITHER as a service (the MSI's
    # <ServiceInstall Name="ActMonAgent">) OR as a SYSTEM scheduled task of the
    # same name (the script/self-heal install path). Querying only the service
    # made `sc query` return 1060 "does not exist as an installed service" on
    # task-installed hosts — reported as not-installed/stopped even though the
    # agent was demonstrably alive and pushing data every 15s. Ask about both
    # and let _parse_state prefer whichever actually answers. `&` runs both
    # under cmd /c regardless of the first one's exit code.
    cmd = (f"sc query \"{WINDOWS_SERVICE}\" & schtasks /query /TN \"{WINDOWS_SERVICE}\" /FO LIST"
           if windows else
           f"systemctl is-active {LINUX_UNIT} 2>&1 || true")

    try:
        from app.services.common.db_diagnose_service import _agent_shell
        _code, out = _agent_shell(host.agent_token, cmd, timeout=timeout)
    except Exception as e:  # noqa: BLE001 — a channel error is still "did not answer"
        logger.debug("[agent_svc] channel error for %s: %s", agent_name, e)
        out = None

    label = WINDOWS_SERVICE if windows else LINUX_UNIT
    where = host.hostname or agent_name

    if out is None:
        # We could not confirm. Silence is genuinely AMBIGUOUS — a stopped
        # service, an uninstalled agent, a powered-off host and blocked egress
        # all look identical from here, and a busy host can simply miss a short
        # probe window. So cross-check the agent's own heartbeat before making
        # a claim: if it reported recently, the service was demonstrably running
        # then, and asserting "not running" would be wrong.
        age = _last_heartbeat_age(agent_name, db)
        if age is not None and age < RECENT_REPORT_SEC:
            mins = int(age // 60)
            return {
                "checked": True, "state": "unconfirmed", "running": None,
                "detail": (f"The ActMon agent service ({label}) did not answer this check, but "
                           f"{where} reported data "
                           f"{('%d min' % mins) if mins else 'less than a minute'} ago — so the "
                           f"service is running and its data push is lagging or failing, rather "
                           f"than being stopped. Check the agent log on the host."),
            }
        return {
            "checked": True, "state": "inactive", "running": False,
            "detail": (f"The ActMon agent service ({label}) is not running on {where} — it did "
                       f"not respond and has sent no data recently. Start it with "
                       + (f"`Start-Service {WINDOWS_SERVICE}`" if windows
                          else f"`sudo systemctl start {LINUX_UNIT}`") + "."),
        }

    # ── The agent ANSWERED. That alone proves the service is running: a stopped
    # service cannot poll for jobs or reply to them. This used to be decided
    # solely by whether the state string parsed, so an answer we couldn't parse
    # (notably an older agent replying "unsupported op: shell") was reported as
    # running=False — i.e. "Service Stopped" for a host that was demonstrably
    # alive. Liveness now comes from the reply itself; the parsed state only
    # adds detail on top.
    text_out = out or ""
    if "unsupported op" in text_out.lower():
        return {
            "checked": True, "state": "running-unverified", "running": True,
            "detail": (f"The ActMon agent on {where} is running (it answered), but it is an older "
                       f"build that cannot report its own service state. Update the agent to get "
                       f"the full check."),
        }

    state = _parse_state(text_out, windows)
    if state == "not-installed":
        # Answered, yet reports its own service missing — contradictory, so
        # report it as-is rather than resolving it one way or the other.
        return {"checked": True, "state": "not-installed", "running": True,
                "detail": (f"The ActMon agent on {where} answered, but reports the service "
                           f"({label}) as not installed — the process may be running outside "
                           f"the service manager.")}
    if state in (_WIN_UP if windows else _UP_STATES):
        return {"checked": True, "state": state, "running": True,
                "detail": f"The ActMon agent service ({label}) is running."}
    if state in _WIN_TASK_NOT_RUNNING:
        # Installed as a scheduled task, but not currently executing. Say "task"
        # rather than "service" — telling someone to Start-Service here would
        # fail, since no service of that name exists on this host.
        word = "disabled" if state == "task-disabled" else "registered but not currently running"
        return {"checked": True, "state": state, "running": False,
                "detail": (f"The ActMon agent on {where} is installed as a scheduled task "
                           f"({label}), and that task is {word}. Start it with "
                           f"`schtasks /Run /TN {label}`"
                           + (" (and re-enable it in Task Scheduler)" if state == "task-disabled" else "") + ".")}
    if state == "unknown":
        return {"checked": True, "state": "running-unverified", "running": True,
                "detail": (f"The ActMon agent on {where} is running (it answered), but its "
                           f"service-state output could not be read.")}
    # A real non-running state from the service manager, reported by a live agent.
    return {"checked": True, "state": state, "running": False,
            "detail": f"The ActMon agent service ({label}) reports '{state}' on {where}."}
