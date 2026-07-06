"""
Filesystem browser for infrastructure hosts (SolarWinds-style storage drill-down).

Flow: filesystems → click mount → list folders/files → click file → view content.
Transport is SSH (the agent is push-only and cannot answer interactive browsing).
For agent-collected hosts without SSH creds the API reports needs_ssh so the UI
can offer a one-time "add SSH credentials" form (saved on the OsServer row).
"""
import shlex
import socket

import paramiko
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.os_server_model import OsServer

_MAX_READ = 64 * 1024   # file preview cap (bytes)


def _get_server(server_id: int, db: Session) -> OsServer:
    srv = db.query(OsServer).filter(OsServer.id == server_id).first()
    if not srv:
        raise HTTPException(status_code=404, detail="Server not found")
    return srv


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


def _run(ssh, cmd: str, timeout: int = 12) -> str:
    _, out, _ = ssh.exec_command(cmd, timeout=timeout)
    return out.read().decode("utf-8", errors="replace")


def _check_path(path: str) -> str:
    p = (path or "/").strip()
    if not p.startswith("/") or "\n" in p or "\r" in p or "\x00" in p:
        raise HTTPException(status_code=400, detail="Invalid path.")
    return p


def _needs_ssh_payload(srv: OsServer) -> dict:
    return {
        "needs_ssh": True,
        "collector": srv.collector,
        "message": "File browsing needs SSH credentials for this host (the agent is push-only). "
                   "Add them once below — they are stored on this server entry.",
    }


def svc_fs_list(server_id: int, path: str, db: Session) -> dict:
    """Directory listing: folders first, then files (name, size, modified, perms)."""
    srv = _get_server(server_id, db)
    if (srv.os_type or "").lower().startswith("win"):
        raise HTTPException(status_code=400, detail="File browsing is currently supported for Linux hosts only.")
    creds = _resolve_ssh(srv, db)
    if not creds:
        return _needs_ssh_payload(srv)
    p = _check_path(path)
    q = shlex.quote(p)
    ssh = _connect(creds)
    try:
        # -H resolves the target when the PATH ITSELF is a symlink (e.g. /bin → usr/bin)
        raw = _run(ssh, f"ls -lAH --time-style=long-iso -- {q} 2>&1")
        if raw.lstrip().startswith("ls:"):
            err = raw.strip().splitlines()[0]
            if "Permission denied" in err:
                raise HTTPException(status_code=400, detail=f"Permission denied reading {p} as the SSH user.")
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
        return {"path": p, "parent": parent, "entries": entries, "count": len(entries), "source": "ssh"}
    finally:
        ssh.close()


def svc_fs_read(server_id: int, path: str, db: Session) -> dict:
    """Read the first 64 KB of a file for the viewer (text only; binary flagged)."""
    srv = _get_server(server_id, db)
    if (srv.os_type or "").lower().startswith("win"):
        raise HTTPException(status_code=400, detail="File browsing is currently supported for Linux hosts only.")
    creds = _resolve_ssh(srv, db)
    if not creds:
        return _needs_ssh_payload(srv)
    p = _check_path(path)
    q = shlex.quote(p)
    ssh = _connect(creds)
    try:
        size_raw = _run(ssh, f"stat -Lc %s -- {q} 2>&1").strip()   # -L → size of the TARGET for symlinks
        if not size_raw.isdigit():
            raise HTTPException(status_code=400, detail=size_raw.splitlines()[0] if size_raw else "Cannot stat file.")
        size = int(size_raw)
        _, out, _ = ssh.exec_command(f"head -c {_MAX_READ} -- {q}", timeout=15)
        blob = out.read()
        binary = b"\x00" in blob
        content = "" if binary else blob.decode("utf-8", errors="replace")
        return {
            "path": p, "size": size, "read_bytes": len(blob),
            "truncated": size > len(blob), "binary": binary, "content": content,
            "source": "ssh",
        }
    finally:
        ssh.close()
