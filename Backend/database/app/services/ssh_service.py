import paramiko
from datetime import datetime


def execute_ssh_command(
    host,
    port,
    username,
    password,
    command
):

    started_at = datetime.now().isoformat(
        timespec="seconds"
    )

    ssh = paramiko.SSHClient()

    ssh.set_missing_host_key_policy(
        paramiko.AutoAddPolicy()
    )

    try:

        ssh.connect(
            hostname=host,
            port=port,
            username=username,
            password=password,
            timeout=10
        )

        stdin, stdout, stderr = ssh.exec_command(command)

        output = stdout.read().decode()

        error = stderr.read().decode()

        ended_at = datetime.now().isoformat(
            timespec="seconds"
        )

        ssh.close()

        return {
            "status": "success",
            "command": command,
            "started_at": started_at,
            "ended_at": ended_at,
            "output": output,
            "error": error
        }

    except Exception as e:

        ended_at = datetime.now().isoformat(
            timespec="seconds"
        )

        return {
            "status": "error",
            "command": command,
            "started_at": started_at,
            "ended_at": ended_at,
            "message": str(e)
        }
