"""
Agent permission catalog — single source of truth for what a host agent is
allowed to do, requested/shown at install time (Add-Agent wizard) and enforced
at job-queue time (agent_fs_service.request()).

Before this existed, the wizard's "Enable host-monitoring" toggle and the MSI's
two PermissionsDlg checkboxes were the only user-facing controls, and neither
actually gated anything downstream (HOSTMONITORING was written to the registry
and never read; the wizard's choice never reached the MSI at all). The agent's
real job channel (list/read/write/regget/regset/runcmd/shell/dbquery/getfile/
putfile/killproc/svcctl incl. reboot/fwctl/netcfg/netfiles/diag/selfupdate) had
zero gating beyond a valid token. This catalog is what's actually enforced now.

Defaults are chosen to match today's real behavior for every op with a
confirmed existing consumer in this codebase, so a normal fresh install doesn't
regress anything already shipped — the value here is visibility plus the
ability to consciously lock a specific agent down, not a silent default
lockdown. `remote_file_write` and `firewall_control` had no confirmed consumer
in the audit that built this catalog and default off; `reboot` has a confirmed
consumer (OS Server's Reboot action) but is deliberately split out of
`service_control` and defaulted off anyway, given its blast radius.
"""

PERMISSION_CATALOG = {
    "host_monitoring": {
        "label": "Host Monitoring",
        "description": "CPU, memory, and disk metrics for the host itself.",
        "ops": ["infra"],
        "default": True,
    },
    "database_access": {
        "label": "Database Access",
        "description": "Agent-proxied database queries and maintenance actions "
                        "(e.g. Storage Health shrink/move) for databases on this host.",
        "ops": ["dbquery"],
        "default": True,
    },
    "remote_diagnostics": {
        "label": "Remote Diagnostics & File Read",
        "description": "Read-only filesystem/registry browsing and OS-level checks — "
                        "powers Diagnose and the Infra File Explorer.",
        "ops": ["list", "read", "regget", "netfiles", "netcfg", "diag"],
        "default": True,
    },
    "remote_command": {
        "label": "Remote Command Execution",
        "description": "Run a command or shell on this host — powers Diagnose's OS "
                        "checks and OS Server's Run Command action.",
        "ops": ["runcmd", "shell"],
        "default": True,
    },
    "process_control": {
        "label": "Process Control",
        "description": "Kill a process by PID — powers OS Server's Kill Process action.",
        "ops": ["killproc"],
        "default": True,
    },
    "service_control": {
        "label": "Service Control",
        "description": "List, start, stop, and restart services — powers OS Server's "
                        "service management (excludes reboot, see below).",
        "ops": ["svcctl"],
        "default": True,
    },
    "self_update": {
        "label": "Agent Self-Update",
        "description": "Let the agent replace its own running code when the server "
                        "publishes a new version. Turning this off means this host "
                        "stops receiving agent fixes until reinstalled by hand.",
        "ops": ["selfupdate"],
        "default": True,
    },
    "remote_file_write": {
        "label": "Remote File Write",
        "description": "Write or overwrite files/registry keys, and transfer files "
                        "to/from this host.",
        "ops": ["write", "regset", "putfile", "getfile"],
        "default": False,
    },
    "firewall_control": {
        "label": "Firewall Control",
        "description": "Add or remove firewall rules on this host.",
        "ops": ["fwctl"],
        "default": False,
    },
    "reboot": {
        "label": "Remote Reboot",
        "description": "Restart the entire host. Split out from Service Control "
                        "deliberately — a full reboot causes downtime for everything "
                        "on the box, not just one service.",
        "ops": [],  # matched specially: op == "svcctl" AND arg == "reboot"
        "default": False,
    },
}

DEFAULT_GRANTED = [key for key, meta in PERMISSION_CATALOG.items() if meta["default"]]

_OP_TO_KEY = {
    op: key
    for key, meta in PERMISSION_CATALOG.items()
    for op in meta["ops"]
}


def permission_for_op(op: str, arg: str = "") -> str | None:
    """Which catalog key gates this op (+ its first argument, for the
    svcctl/reboot special case)? Returns None for an op this catalog doesn't
    recognise — callers should treat that as "no permission required" (e.g.
    ops outside the job channel entirely), not as "denied"."""
    # actmon_agent.py's own reboot check is `(path or "").split(":", 1)[0] == "reboot"`
    # (host_action_service.py also sends plain "reboot" with no colon) — match exactly.
    if op == "svcctl" and str(arg or "").split(":", 1)[0].strip().lower() == "reboot":
        return "reboot"
    return _OP_TO_KEY.get(op)


def parse_granted(granted_permissions) -> set[str] | None:
    """None means unrestricted (grandfathered or never set) — the caller should
    allow everything. A set (possibly empty) means exactly that set is granted."""
    if granted_permissions is None:
        return None
    return {k.strip() for k in str(granted_permissions).split(",") if k.strip()}


def is_allowed(granted_permissions, op: str, arg: str = "") -> bool:
    """The one function both the backend (agent_fs_service.request) and the
    agent's own local check should call. `granted_permissions` is the raw
    comma-separated string (or None) from AgentToken / local agent config."""
    granted = parse_granted(granted_permissions)
    if granted is None:
        return True
    key = permission_for_op(op, arg)
    if key is None:
        return True
    return key in granted
