"""
Host-level monitoring for every node of an Oracle RAC cluster, from the one
agent that is installed.

The cluster already tells us where its instances run — GV$INSTANCE.HOST_NAME —
so the other nodes do not need discovering by hand and do not need an agent of
their own. The node the agent sits on is collected directly; every other node
is collected by having that same agent run the collector over SSH.

The collector is not a second implementation. It is LINUX_COLLECTOR_BUNDLE from
infra_detail_service — the exact script the SSH and agent-push paths already
use — so a remote node parses through the same parse_linux() and comes out in
the same shape as a host ActMon monitors directly. Divergence here would mean
two sets of numbers that quietly disagree.

Security posture, which is the part worth being explicit about:

  * BatchMode=yes. SSH never prompts for a password; it fails instead. Nothing
    here collects, stores or transmits a credential, and a host without key
    auth set up is reported as unreachable rather than interrogated.
  * StrictHostKeyChecking=yes. Host-key verification is preserved, not waived.
    An unknown host fails with a remedy rather than being trusted on sight —
    `accept-new` would have been the convenient choice and it is exactly the
    one that makes a first connection unauthenticated.
  * Hostnames and usernames are validated against a strict character set before
    they reach a command line. HOST_NAME is attacker-controllable by anyone who
    can set it in the database, so it is never interpolated unchecked.
  * Read-only throughout. The remote command is the collector and nothing else.

Every failure is a reported state, never an exception that empties the tab.
"""

import base64
import os
import re
import shlex
import threading
import time

from sqlalchemy.orm import Session

from app.services.os_server.infra_detail_service import (
    LINUX_COLLECTOR_BUNDLE, _live_cols_from_snapshot, parse_linux,
)

# Hostnames and usernames that reach a command line must look like hostnames and
# usernames. GV$INSTANCE.HOST_NAME comes from the database, so it is input.
_SAFE_HOST = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,253}$")
_SAFE_USER = re.compile(r"^[A-Za-z0-9._][A-Za-z0-9._-]{0,31}$")

_SSH_CONNECT_TIMEOUT = 8      # seconds for the TCP/auth phase
_AGENT_TIMEOUT = 50           # whole job, including the collector run
_CACHE_TTL = 60               # SSH per 15s dashboard refresh would be abusive

_CACHE = {}
_CACHE_LOCK = threading.Lock()


def _short(host: str) -> str:
    """Compare hosts on their short name: GV$INSTANCE may report an FQDN while
    `hostname` reports the short form, or the other way round."""
    return (host or "").strip().split(".")[0].lower()


def _agent_shell(token: str, cmd: str, timeout: int = _AGENT_TIMEOUT):
    """Run a command on the agent host. Returns (exit_code, text), or
    (None, None) when the agent did not answer at all."""
    from app.services.agent import agent_fs_service
    raw = agent_fs_service.request(token, "shell", cmd, timeout=timeout)
    if raw is None:
        return None, None
    txt = raw.decode("utf-8", "replace")
    code = 0
    if txt.startswith("EXIT:"):
        head, _, rest = txt.partition("\n")
        try:
            code = int(head[5:].strip())
        except Exception:
            code = 0
        txt = rest
    return code, txt


def _remote_command(user: str, host: str, inner: str) -> str:
    """An SSH invocation that cannot be talked into prompting for a password and
    cannot be talked out of checking the host key.

    The payload is base64'd rather than quoted. The collector bundle is full of
    single quotes and `$`, and every layer between here and the remote shell
    would get a chance to mangle them; base64 has neither.
    """
    payload = base64.b64encode(inner.encode("utf-8")).decode("ascii")
    remote = f"echo {payload} | base64 -d | sh"
    return (
        "ssh -o BatchMode=yes "
        "-o StrictHostKeyChecking=yes "
        "-o NumberOfPasswordPrompts=0 "
        f"-o ConnectTimeout={_SSH_CONNECT_TIMEOUT} "
        f"{shlex.quote(f'{user}@{host}')} {shlex.quote(remote)}"
    )


def _classify_ssh_failure(code, text):
    """Turn SSH's stderr into something the reader can act on.

    A monitoring page that says "connection failed" has told the reader what
    they already knew. Each of these is a different job for a different person.
    """
    t = (text or "").lower()
    if code is None:
        return ("agent_no_answer",
                "The agent on the local node did not answer in time.",
                "Check that the ActMon agent service is running on the node that has it installed.")
    if "permission denied" in t and "publickey" in t:
        return ("ssh_auth",
                "SSH refused the key — passwordless access is not set up for this user.",
                "From the agent's node, as the same user the agent runs as: ssh-copy-id "
                "<user>@<node>, then confirm `ssh -o BatchMode=yes <user>@<node> true` succeeds. "
                "ActMon never supplies a password.")
    if "host key verification failed" in t or "no matching host key" in t:
        return ("ssh_hostkey",
                "The remote host key is not trusted on the agent's node.",
                "Verify the key out of band, then add it to the agent user's known_hosts. "
                "Host-key checking is deliberately not disabled.")
    if "could not resolve hostname" in t or "name or service not known" in t:
        return ("dns",
                "The hostname GV$INSTANCE reports does not resolve from the agent's node.",
                "Add the node to DNS or /etc/hosts on the agent's node, or correct "
                "HOST_NAME if the instance reports a name that is not routable.")
    if "connection timed out" in t or "no route to host" in t or "connection refused" in t:
        return ("network",
                "The agent's node cannot reach SSH on the other node.",
                "Check that port 22 is open between the cluster nodes and that sshd is running.")
    if "command not found" in t and "ssh" in t:
        return ("no_ssh_client",
                "There is no ssh client on the node where the agent runs.",
                "Install the OpenSSH client package on that node.")
    if "not granted" in t or "permission" in t and "agent" in t:
        return ("agent_permission",
                "The agent is not allowed to run commands.",
                "Grant this agent the remote-command permission in Agents → permissions.")
    return ("unknown",
            "The collector did not return usable output from this node.",
            (text or "").strip()[:300] or "No output and no error was returned.")


def _resolve_ssh_user(token: str):
    """Who to SSH as.

    An explicit override wins; otherwise it is whoever the agent itself runs
    as, read off the host rather than guessed. Hardcoding a username would be
    wrong in the ordinary case and silently wrong in every other deployment.
    """
    override = (os.environ.get("ACTMON_RAC_SSH_USER") or "").strip()
    if override:
        return (override, "configured") if _SAFE_USER.match(override) else (None, "invalid")
    code, out = _agent_shell(token, "id -un", timeout=20)
    if code is None:
        return None, "agent_no_answer"
    user = (out or "").strip().splitlines()[0].strip() if (out or "").strip() else ""
    if user and _SAFE_USER.match(user):
        return user, "agent_user"
    return None, "unknown"


def _collect(token: str, user, host, local: bool):
    """Run the shared collector on one node and parse it. Returns
    (parsed_or_None, failure_or_None)."""
    if local:
        cmd = LINUX_COLLECTOR_BUNDLE
    else:
        if not _SAFE_HOST.match(host or ""):
            return None, ("bad_hostname",
                          f"GV$INSTANCE reports a host name this cannot safely use: {host!r}.",
                          "Correct HOST_NAME for that instance, or set ACTMON_RAC_SSH_USER and "
                          "a resolvable name.")
        if not user:
            return None, ("no_user",
                          "Could not determine which Linux user to connect as.",
                          "Set ACTMON_RAC_SSH_USER on the ActMon server to the account that has "
                          "passwordless SSH to the other cluster nodes.")
        cmd = _remote_command(user, host, LINUX_COLLECTOR_BUNDLE)

    try:
        code, out = _agent_shell(token, cmd)
    except Exception as exc:  # noqa: BLE001 — a refused permission arrives here
        return None, _classify_ssh_failure(1, str(exc))

    if code is None:
        return None, _classify_ssh_failure(None, "")
    # The collector always emits its first marker. Its absence means the shell
    # never got that far — an SSH failure, not a parse problem.
    if "@@SYS@@" not in (out or ""):
        return None, _classify_ssh_failure(code, out)
    try:
        return parse_linux(out, hostname=host), None
    except Exception as exc:  # noqa: BLE001
        return None, ("parse", "The node answered but its output could not be parsed.", str(exc)[:200])


_IPV4 = re.compile(r"^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$")


def _primary_ip(parsed):
    """The node's own address, from the collector's interface list.

    Loopback and link-local are skipped: neither identifies a host to anything
    else on the network, and 127.0.0.1 would make every node look like the
    same machine to anything that matches on address.
    """
    for iface in (parsed or {}).get("interfaces") or []:
        for addr in iface.get("addresses") or []:
            ip = str(addr or "").split("/")[0].strip()
            if _IPV4.match(ip) and not ip.startswith(("127.", "169.254.")):
                return ip
    return None


def _node_payload(n, parsed, failure, source, host_is_local):
    """One node's row: Oracle facts always, host facts when they could be read."""
    row = {
        # Oracle-side, straight from GV$INSTANCE — present even when the host
        # is unreachable, because the instance may be perfectly healthy.
        "instance_number":   n.get("instance_number"),
        "instance_name":     n.get("instance_name"),
        "host_name":         n.get("host_name"),
        "instance_status":   n.get("instance_status"),
        "database_status":   n.get("database_status"),
        "active_state":      n.get("active_state"),
        "active_sessions":   n.get("active_sessions"),
        "blocking_sessions": n.get("blocking_sessions"),
        "thread":            n.get("thread"),
        # How this node's host metrics were obtained, so the reader can tell a
        # directly-monitored node from one reached over SSH.
        "source":            source,
        "is_agent_host":     host_is_local,
        "host_reachable":    parsed is not None,
    }
    if parsed:
        live = _live_cols_from_snapshot(parsed)
        sysinfo = parsed.get("system") or {}
        row.update({
            "os":           sysinfo.get("os"),
            "kernel":       sysinfo.get("kernel"),
            "hostname":     sysinfo.get("hostname"),
            "architecture": sysinfo.get("architecture"),
            "uptime":       parsed.get("uptime"),
            "cpu_pct":      parsed.get("cpu_pct"),
            "load":         parsed.get("load"),
            "memory":       parsed.get("memory"),
            "filesystems":  parsed.get("filesystems"),
            "ip_address":   _primary_ip(parsed),
            "cpu_usage":    live.get("cpu_usage"),
            "ram_usage":    live.get("ram_usage"),
            "disk_usage":   live.get("disk_usage"),
        })
    else:
        reason, detail, remedy = failure
        row.update({"failure_reason": reason, "failure_detail": detail, "remedy": remedy})
    return row


def _build(conn_id: int, db: Session):
    from app.services.oracle.oracle_monitoring_service import oracle_rac_nodes

    rac = oracle_rac_nodes(conn_id, db)
    nodes = rac.get("nodes") or []
    if not nodes:
        return {"status": "success", "is_rac": False, "nodes": [], "errors": [],
                "error": rac.get("error")}

    # The agent that already monitors this connection. No second agent is
    # installed and none is asked for.
    try:
        from app.services.common.db_proxy_service import agent_host_for_conn
        agent_row = agent_host_for_conn(conn_id, db)
    except Exception:  # noqa: BLE001
        agent_row = None
    token = getattr(agent_row, "token", None)

    if not token:
        return {
            "status": "success", "is_rac": rac.get("is_rac", len(nodes) > 1),
            "agent_present": False,
            "nodes": [_node_payload(n, None,
                                    ("no_agent",
                                     "This connection is not monitored through an agent.",
                                     "Host metrics for the cluster nodes need an agent on one of "
                                     "them; the Oracle-side figures below come from the database."),
                                    "none", False)
                      for n in nodes],
            "errors": [],
        }

    # Which node is the agent actually on? Asked, not assumed — the connection's
    # host may be a SCAN address, a VIP, or simply a different name.
    code, out = _agent_shell(token, "hostname", timeout=20)
    agent_host = (out or "").strip().splitlines()[0].strip() if (out or "").strip() else ""
    agent_short = _short(agent_host)

    ssh_user, user_source = _resolve_ssh_user(token)

    results, errors = [], []
    for n in nodes:
        host = n.get("host_name") or ""
        is_local = bool(agent_short) and _short(host) == agent_short
        parsed, failure = _collect(token, ssh_user, host, local=is_local)
        source = "agent" if is_local else "ssh-via-agent"
        if failure:
            errors.append(f"{host or 'node'}: {failure[0]}")
        results.append(_node_payload(n, parsed, failure, source, is_local))

    return {
        "status": "success",
        "is_rac": rac.get("is_rac", len(nodes) > 1),
        "agent_present": True,
        "agent_host": agent_host or None,
        "ssh_user": ssh_user,
        "ssh_user_source": user_source,
        "nodes": results,
        "nodes_total": len(results),
        "hosts_reachable": sum(1 for r in results if r.get("host_reachable")),
        "errors": errors,
    }


def oracle_rac_node_hosts(conn_id: int, db: Session):
    """Per-node host metrics for a RAC cluster, cached briefly.

    The RAC tab refreshes every 15 seconds. Opening an SSH connection to every
    remote node at that rate would be a sustained load on the cluster for no
    extra information — host metrics do not move meaningfully in 15 seconds —
    so the result is held for a minute and shared by every caller.
    """
    now = time.time()
    with _CACHE_LOCK:
        hit = _CACHE.get(conn_id)
        if hit and hit[0] > now:
            return hit[1]

    try:
        payload = _build(conn_id, db)
    except Exception as exc:  # noqa: BLE001 — never empty the tab
        payload = {"status": "error", "error": str(exc)[:300], "nodes": [], "errors": []}

    # Cache BEFORE registering: sync_rac_hosts reads this same function, and
    # the populated cache is what stops that becoming a second collection.
    with _CACHE_LOCK:
        _CACHE[conn_id] = (now + _CACHE_TTL, payload)

    # Register the nodes as hosts from the same pass that collected them.
    # Doing this only in the collector cycle meant the RAC tab showed both
    # nodes while the servers page still showed one, for however long it took
    # that cycle to come round — the data was in hand and unused.
    if payload.get("nodes"):
        try:
            from app.services.oracle.oracle_rac_registration_service import sync_rac_hosts
            payload["registration"] = sync_rac_hosts(conn_id, db)
        except Exception as exc:  # noqa: BLE001 — never fail the tab over this
            payload["registration"] = {"errors": [str(exc)[:200]]}

    return payload
