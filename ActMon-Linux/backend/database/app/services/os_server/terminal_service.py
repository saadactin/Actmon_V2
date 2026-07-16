import re

import paramiko
from fastapi import HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.models.os_server_model import OsServer

BLOCKED_PATTERNS = [
    "rm -rf /", "mkfs", "dd if=/dev/zero of=/dev/sd",
    ":(){:|:&};:", "chmod -R 777 /", "> /dev/sda", "shred /dev/",
]

INTERACTIVE_HINTS = [
    (re.compile(r"mysql\s+.*-p\s*$|mysql\s+-p\s*$"),
     "mysql requires interactive input. Use: mysql -u root -pPASSWORD (no space after -p), or open the SSH terminal."),
    (re.compile(r"^(vi|vim|nano|emacs|pico)\b"),
     "Editors not supported here. Use the real SSH terminal instead."),
    (re.compile(r"^(less|more)\b"),  "Pagers not supported. Use: cat file | head -100"),
    (re.compile(r"^(top|htop|iotop|iftop)\b"), "Use: top -bn1 | head -20, or the SSH terminal."),
    (re.compile(r"^tail\s+-f\b"),    "Live tail not supported. Use: tail -n 100 /path/to/file"),
    (re.compile(r"^psql\s.*-W\b"),   "Use PGPASSWORD=pass psql ... instead of -W flag"),
    (re.compile(r"^passwd\b"),       "passwd requires interactive input. Use the SSH terminal."),
    (re.compile(r"^su\b"),           "su requires interactive input. Use the SSH terminal."),
    (re.compile(r"^ssh\b"),          "Nested SSH sessions are not supported in exec mode."),
]


class ExecuteRequest(BaseModel):
    server_id: int
    command: str


def svc_execute_command(request: ExecuteRequest, db: Session):
    server = db.query(OsServer).filter(OsServer.id == request.server_id).first()

    if not server:
        raise HTTPException(status_code=404, detail="Server not found")

    if not server.ssh_username or not server.ssh_password:
        raise HTTPException(status_code=400, detail="SSH credentials not configured for this server")

    cmd = request.command.strip()

    for pattern in BLOCKED_PATTERNS:
        if pattern in cmd:
            raise HTTPException(status_code=403, detail=f"Command blocked: '{pattern}'")

    for pattern, hint in INTERACTIVE_HINTS:
        if pattern.search(cmd):
            return {
                "status": "hint",
                "command": cmd,
                "output": "",
                "error": f"[HINT] {hint}",
                "exit_code": -1,
                "server_name": server.server_name,
                "ip_address": server.ip_address,
            }

    try:
        ssh = paramiko.SSHClient()
        ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        ssh.connect(
            hostname=server.ip_address,
            port=server.ssh_port or 22,
            username=server.ssh_username,
            password=server.ssh_password,
            timeout=15,
        )
        stdin, stdout, stderr = ssh.exec_command(cmd, timeout=30)
        output = stdout.read().decode("utf-8", errors="replace")
        error = stderr.read().decode("utf-8", errors="replace")
        exit_code = stdout.channel.recv_exit_status()
        ssh.close()

        return {
            "status": "success",
            "command": cmd,
            "output": output,
            "error": error,
            "exit_code": exit_code,
            "server_name": server.server_name,
            "ip_address": server.ip_address,
        }

    except paramiko.AuthenticationException:
        raise HTTPException(status_code=401, detail="SSH Authentication Failed")
    except paramiko.ssh_exception.NoValidConnectionsError:
        raise HTTPException(status_code=503, detail=f"Cannot connect to {server.ip_address}:{server.ssh_port or 22}")
    except TimeoutError:
        raise HTTPException(status_code=504, detail="Command timed out")
    except Exception as e:
        err_msg = str(e) if str(e) else type(e).__name__
        raise HTTPException(status_code=500, detail=f"SSH Error: {err_msg}")
