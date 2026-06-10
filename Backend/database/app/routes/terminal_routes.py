import asyncio
import re

import paramiko
from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.models.os_server_model import OsServer

router = APIRouter(prefix="/api/v1/terminal", tags=["Terminal"])

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


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# ══════════════════════════════════════════════════════════════
#  WEBSOCKET — real PTY terminal  (invoke_shell)
# ══════════════════════════════════════════════════════════════

@router.websocket("/ws/{server_id}")
async def terminal_websocket(websocket: WebSocket, server_id: int):
    """Full interactive PTY via WebSocket.
    Frontend sends UTF-8 keystrokes; backend forwards to paramiko PTY channel.
    Resize events are sent as the special prefix: \\x00resize:<cols>,<rows>
    """
    # Accept WebSocket FIRST — this prevents silent 1006 on any later error.
    try:
        await websocket.accept()
    except Exception:
        return

    async def send(msg: str):
        try:
            await websocket.send_text(msg)
        except Exception:
            pass

    async def close(code: int = 1000):
        try:
            await websocket.close(code=code)
        except Exception:
            pass

    # Load server from DB
    try:
        db = SessionLocal()
        try:
            server = db.query(OsServer).filter(OsServer.id == server_id).first()
        finally:
            db.close()
    except Exception as e:
        await send(f"\x1b[31mDatabase error: {e}\x1b[0m\r\n")
        await close()
        return

    if not server:
        await send(f"\x1b[31mServer ID {server_id} not found in database.\x1b[0m\r\n")
        await close(4004)
        return

    if not server.ssh_username:
        await send(
            "\x1b[31mSSH credentials not configured for this server.\x1b[0m\r\n"
            "\x1b[90mEdit the server and add SSH username / password.\x1b[0m\r\n"
        )
        await close(4000)
        return

    await send(
        f"\x1b[90mConnecting to \x1b[1m{server.server_name}\x1b[0m\x1b[90m"
        f" ({server.ip_address}:{server.ssh_port or 22})…\x1b[0m\r\n"
    )

    # Run the blocking paramiko connect in a thread executor
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        await send("\x1b[31mNo running event loop — please restart the backend.\x1b[0m\r\n")
        await close()
        return

    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())

    def do_connect():
        ssh.connect(
            hostname=server.ip_address,
            port=server.ssh_port or 22,
            username=server.ssh_username,
            password=server.ssh_password or "",
            timeout=15,
            banner_timeout=15,
        )
        ch = ssh.invoke_shell(term="xterm-256color", width=220, height=50)
        ch.setblocking(False)
        return ch

    try:
        channel = await loop.run_in_executor(None, do_connect)
    except paramiko.AuthenticationException:
        await send("\x1b[31mSSH Authentication Failed — check username / password.\x1b[0m\r\n")
        await close()
        return
    except paramiko.ssh_exception.NoValidConnectionsError:
        await send(
            f"\x1b[31mCannot reach {server.ip_address}:{server.ssh_port or 22}\x1b[0m\r\n"
            "\x1b[90mCheck that the server is online and SSH is running.\x1b[0m\r\n"
        )
        await close()
        return
    except OSError as e:
        await send(f"\x1b[31mNetwork error: {e}\x1b[0m\r\n")
        await close()
        return
    except Exception as e:
        msg = str(e) if str(e) else type(e).__name__
        await send(f"\x1b[31mConnection failed: {msg}\x1b[0m\r\n")
        await close()
        return

    done = asyncio.Event()

    async def ssh_to_ws():
        try:
            while not done.is_set():
                if channel.recv_ready():
                    data = channel.recv(4096)
                    if data:
                        try:
                            await websocket.send_bytes(data)
                        except Exception:
                            break
                if channel.exit_status_ready() or channel.closed:
                    try:
                        await websocket.send_text("\r\n\x1b[90m[Remote session closed]\x1b[0m\r\n")
                    except Exception:
                        pass
                    break
                await asyncio.sleep(0.02)
        except Exception:
            pass
        finally:
            done.set()

    reader = asyncio.create_task(ssh_to_ws())

    try:
        while not done.is_set():
            try:
                msg = await asyncio.wait_for(websocket.receive_text(), timeout=0.05)
                if msg.startswith("\x00resize:"):
                    try:
                        _, dims = msg.split(":", 1)
                        cols, rows = map(int, dims.split(","))
                        channel.resize_pty(width=cols, height=rows)
                    except Exception:
                        pass
                else:
                    try:
                        channel.send(msg)
                    except Exception:
                        break
            except asyncio.TimeoutError:
                continue
            except WebSocketDisconnect:
                break
            except Exception:
                break
    finally:
        done.set()
        reader.cancel()
        try:
            channel.close()
        except Exception:
            pass
        try:
            ssh.close()
        except Exception:
            pass


# ══════════════════════════════════════════════════════════════
#  LEGACY exec_command endpoint (non-interactive commands)
# ══════════════════════════════════════════════════════════════

class ExecuteRequest(BaseModel):
    server_id: int
    command: str


@router.post("/execute")
def execute_command(request: ExecuteRequest, db: Session = Depends(get_db)):
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
