"""
Filesystem browser for infrastructure hosts (SolarWinds-style storage drill-down).

Flow: filesystems → click mount → list folders/files → click file → view content.

Transport, in order:
  1. AGENT — for agent-connected hosts the browse request goes through the agent
     command channel (agent_fs_service): the agent executes ls/head locally and
     pushes the output back. NO SSH needed.
  2. SSH — for SSH-registered hosts (or as fallback when the agent is offline and
     SSH creds happen to exist).
Only when neither is possible does the API report needs_ssh so the UI can offer
a one-time credentials form.
"""
import shlex
import socket

import paramiko
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.os_server_model import OsServer
from app.services.agent import agent_fs_service

_MAX_READ = 64 * 1024   # file preview cap (bytes)


def _get_server(server_id: int, db: Session) -> OsServer:
    srv = db.query(OsServer).filter(OsServer.id == server_id).first()
    if not srv:
        raise HTTPException(status_code=404, detail="Server not found")
    return srv


def _check_path(path: str) -> str:
    p = (path or "/").strip()
    if "\n" in p or "\r" in p or "\x00" in p:
        raise HTTPException(status_code=400, detail="Invalid path.")
    import re
    # POSIX absolute, or Windows drive ('C:', 'C:\', 'C:/…', '/C:/…'), or UNC.
    if (p.startswith("/") or p.startswith("\\\\")
            or re.match(r"^[A-Za-z]:([\\/].*)?$", p)):
        return p
    raise HTTPException(status_code=400, detail="Invalid path.")


# ──────────────────────────────────────────────────────────────────────────────
# SSH transport
# ──────────────────────────────────────────────────────────────────────────────

def _best_host(srv: OsServer) -> str:
    """Agent-created rows may carry the agent NAME in ip_address (enroll doesn't
    know the IP) — prefer a real dotted IP, then the hostname."""
    import re
    for cand in (srv.ip_address, srv.hostname):
        if cand and re.fullmatch(r"\d{1,3}(\.\d{1,3}){3}", cand.strip()):
            return cand.strip()
    return (srv.hostname or srv.ip_address or "").strip()


def _resolve_ssh(srv: OsServer, db: Session):
    """The server's own creds, else any registered server on the same IP that has them."""
    if srv.ssh_username and srv.ssh_password:
        return _best_host(srv), srv.ssh_port or 22, srv.ssh_username, srv.ssh_password
    twin = (db.query(OsServer)
              .filter(OsServer.ip_address == srv.ip_address,
                      OsServer.id != srv.id,
                      OsServer.ssh_username.isnot(None),
                      OsServer.ssh_password.isnot(None))
              .first())
    if twin:
        return _best_host(twin), twin.ssh_port or 22, twin.ssh_username, twin.ssh_password
    return None


def _connect(creds):
    host, port, user, pwd = creds
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        ssh.connect(hostname=host, port=int(port or 22), username=user, password=pwd, timeout=10)
    except paramiko.AuthenticationException:
        raise HTTPException(status_code=400, detail="SSH authentication failed — check the saved SSH username/password.")
    except (socket.timeout, TimeoutError):
        raise HTTPException(status_code=400, detail=f"SSH timeout — cannot reach {host}:{port}.")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"SSH connection failed: {e}")
    return ssh


def _ssh_output(srv: OsServer, db: Session, cmd: str, timeout: int = 12) -> bytes:
    ssh = _connect(_resolve_ssh(srv, db))
    try:
        _, out, _ = ssh.exec_command(cmd, timeout=timeout)
        return out.read()
    finally:
        ssh.close()


# ──────────────────────────────────────────────────────────────────────────────
# Transport selection — agent first, SSH fallback
# ──────────────────────────────────────────────────────────────────────────────

_LIST_CMD = "ls -lAH --time-style=long-iso -- {q} 2>&1"
# read protocol: first line SIZE:<bytes of target>, then the first 64 KB
_READ_CMD = "printf 'SIZE:%s\\n' \"$(stat -Lc %s -- {q} 2>/dev/null || echo -1)\"; head -c 65536 -- {q}"


def _fetch(srv: OsServer, db: Session, op: str, path: str, data: str = "") -> bytes:
    """Run a browse op on the host via the best transport."""
    is_agent = (srv.collector or "") == "agent" and srv.agent_token
    has_ssh = _resolve_ssh(srv, db) is not None

    if is_agent:
        raw = agent_fs_service.request(srv.agent_token, op, path, data)
        if raw is not None:
            return raw
        # Agent didn't answer — old agent build or offline. SSH as a courtesy fallback.
        if has_ssh:
            return _ssh_output(srv, db, _ssh_cmd(op, path, data))
        raise HTTPException(
            status_code=504,
            detail="This host's agent is an older build that doesn't support file browsing yet. "
                   "Update it once (re-run the installer, or `sudo systemctl restart actmon-agent`) "
                   "— newer agents self-update automatically.")

    if has_ssh:
        return _ssh_output(srv, db, _ssh_cmd(op, path, data))
    return None   # → needs_ssh


def _ssh_cmd(op: str, path: str, data: str) -> str:
    q = shlex.quote(path)
    if op == "write":
        import base64 as _b64
        enc = _b64.b64encode((data or "").encode()).decode()
        return f"sh -c 'cp -p {q} {q}.actmon.bak 2>/dev/null; echo {enc} | base64 -d > {q} && echo OK:$(stat -Lc %s {q})'"
    return (_LIST_CMD if op == "list" else _READ_CMD).format(q=q)


def _needs_ssh_payload(srv: OsServer) -> dict:
    return {
        "needs_ssh": True,
        "collector": srv.collector,
        "message": "File browsing needs SSH credentials for this host. "
                   "Add them once below — they are stored on this server entry.",
    }


# ──────────────────────────────────────────────────────────────────────────────
# Public API
# ──────────────────────────────────────────────────────────────────────────────

def _parse_ls(raw: str, p: str) -> dict:
    if raw.lstrip().startswith("ls:"):
        err = raw.strip().splitlines()[0]
        if "Permission denied" in err:
            raise HTTPException(status_code=400, detail=f"Permission denied reading {p}.")
        if "Not a directory" in err:
            raise HTTPException(status_code=400, detail=f"{p} is a file — open it instead.")
        raise HTTPException(status_code=400, detail=err)
    entries = []
    for line in raw.splitlines():
        parts = line.split(None, 7)
        if len(parts) < 8 or parts[0].startswith("total"):
            continue
        perms, _links, user, group, size, date, time_, name = parts
        kind = "dir" if perms.startswith("d") else ("link" if perms.startswith("l") else "file")
        target = None
        if kind == "link" and " -> " in name:
            name, target = name.split(" -> ", 1)
        entries.append({
            "name": name, "type": kind, "size": int(size) if size.isdigit() else 0,
            "modified": f"{date} {time_}", "perms": perms, "owner": user, "group": group,
            "link_target": target,
        })
    entries.sort(key=lambda e: (e["type"] != "dir", e["name"].lower()))
    parent = "/" if p == "/" else p.rstrip("/").rsplit("/", 1)[0] or "/"
    return {"path": p, "parent": parent, "entries": entries, "count": len(entries)}


def svc_fs_list(server_id: int, path: str, db: Session) -> dict:
    """Directory listing: folders first, then files (name, size, modified, perms)."""
    srv = _get_server(server_id, db)
    if (srv.os_type or "").lower().startswith("win") and (srv.collector or "") != "agent":
        raise HTTPException(status_code=400, detail="File browsing runs through the ActMon agent. This Windows host has no agent — install it to browse files.")
    p = _check_path(path)
    raw = _fetch(srv, db, "list", p)
    if raw is None:
        return _needs_ssh_payload(srv)
    out = _parse_ls(raw.decode("utf-8", errors="replace"), p)
    out["source"] = "agent" if (srv.collector or "") == "agent" else "ssh"
    return out


def svc_fs_read(server_id: int, path: str, db: Session) -> dict:
    """Read the first 64 KB of a file for the viewer (text only; binary flagged)."""
    srv = _get_server(server_id, db)
    if (srv.os_type or "").lower().startswith("win") and (srv.collector or "") != "agent":
        raise HTTPException(status_code=400, detail="File browsing runs through the ActMon agent. This Windows host has no agent — install it to browse files.")
    p = _check_path(path)
    raw = _fetch(srv, db, "read", p)
    if raw is None:
        return _needs_ssh_payload(srv)
    # Protocol: b"SIZE:<n>\n" + content bytes
    header, _, blob = raw.partition(b"\n")
    size = -1
    if header.startswith(b"SIZE:"):
        try:
            size = int(header[5:].strip())
        except ValueError:
            size = -1
    else:                       # unexpected — treat everything as content
        blob = raw
    if size < 0:
        raise HTTPException(status_code=400, detail=f"Cannot read {p} — it may not exist or is not a regular file.")
    binary = b"\x00" in blob
    content = "" if binary else blob.decode("utf-8", errors="replace")
    return {
        "path": p, "size": size, "read_bytes": len(blob),
        "truncated": size > len(blob), "binary": binary, "content": content,
        "source": "agent" if (srv.collector or "") == "agent" else "ssh",
    }


def svc_fs_write(server_id: int, path: str, content: str, db: Session) -> dict:
    """Overwrite a text file with new content (a .actmon.bak backup is kept)."""
    srv = _get_server(server_id, db)
    if (srv.os_type or "").lower().startswith("win") and (srv.collector or "") != "agent":
        raise HTTPException(status_code=400, detail="File editing runs through the ActMon agent. This Windows host has no agent — install it to edit files.")
    p = _check_path(path)
    if len(content or "") > 512 * 1024:
        raise HTTPException(status_code=400, detail="File too large to edit here (512 KB limit).")
    raw = _fetch(srv, db, "write", p, content or "")
    if raw is None:
        return _needs_ssh_payload(srv)
    out = raw.decode("utf-8", errors="replace").strip()
    if out.startswith("OK"):
        return {"status": "success", "path": p, "size": int((out.split(":", 1)[1] or 0)) if ":" in out else None,
                "backup": f"{p}.actmon.bak"}
    raise HTTPException(status_code=400, detail=f"Write failed: {out.replace('ERR:', '') or 'unknown error'}")
