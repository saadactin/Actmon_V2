from app.services.ssh_service import (
    execute_ssh_command
)

SSH_USERNAME = "actmon"
SSH_PASSWORD = "Actmon@123"


def restart_mysql_service(host):

    return execute_ssh_command(
        host=host,
        port=22,
        username=SSH_USERNAME,
        password=SSH_PASSWORD,
        command="powershell Restart-Service MySQL80"
    )


def start_mysql_service(host):

    return execute_ssh_command(
        host=host,
        port=22,
        username=SSH_USERNAME,
        password=SSH_PASSWORD,
        command="net start MySQL80"
    )


def stop_mysql_service(host):

    return execute_ssh_command(
        host=host,
        port=22,
        username=SSH_USERNAME,
        password=SSH_PASSWORD,
        command="net stop MySQL80"
    )


def get_mysql_service_status(host):

    return execute_ssh_command(
        host=host,
        port=22,
        username=SSH_USERNAME,
        password=SSH_PASSWORD,
        command="sc query MySQL80"
    )
    
    
   
# =====================================================
# KILL PROCESS BY PID
# =====================================================

def kill_process_by_pid(
    host,
    pid
):

    command = (
        f'taskkill /PID {pid} /F'
    )

    return execute_ssh_command(
        host=host,
        port=22,
        username=SSH_USERNAME,
        password=SSH_PASSWORD,
        command=command
    )

