
from app.services.ssh_service import (
    execute_ssh_command
)

# =====================================================
# SSH CONFIG
# =====================================================

SSH_USERNAME = "actmon"

SSH_PASSWORD = "Actmon@123"

SSH_PORT = 22


# =====================================================
# MYSQL PORT CHECK
# =====================================================

def check_mysql_port(
    host,
    mysql_port=3306
):

    command = (
        f'netstat -ano | findstr :{mysql_port}'
    )

    result = execute_ssh_command(
        host=host,
        port=SSH_PORT,
        username=SSH_USERNAME,
        password=SSH_PASSWORD,
        command=command
    )

    return result


# =====================================================
# MYSQL PROCESS CHECK
# =====================================================

def check_mysql_process(
    host
):

    command = (
        'tasklist | findstr mysqld'
    )

    result = execute_ssh_command(
        host=host,
        port=SSH_PORT,
        username=SSH_USERNAME,
        password=SSH_PASSWORD,
        command=command
    )

    return result


# =====================================================
# MYSQL DATABASE HEALTH CHECK
# =====================================================

def check_mysql_database_health(
    host,
    username,
    password,
    database_name,
    mysql_port=3306
):

    command = (
        f'mysql -u {username} '
        f'-p"{password}" '
        f'-h {host} '
        f'-P {mysql_port} '
        f'-e "SELECT 1;"'
    )

    result = execute_ssh_command(
        host=host,
        port=SSH_PORT,
        username=SSH_USERNAME,
        password=SSH_PASSWORD,
        command=command
    )

    return result


# =====================================================
# MYSQL SERVICE STATUS CHECK
# =====================================================

def check_mysql_service_status(
    host
):

    command = (
        'sc query MySQL80'
    )

    result = execute_ssh_command(
        host=host,
        port=SSH_PORT,
        username=SSH_USERNAME,
        password=SSH_PASSWORD,
        command=command
    )

    return result


# =====================================================
# MYSQL ERROR LOG CHECK
# =====================================================

def get_latest_mysql_error_logs(
    host,
    lines=50
):

    command = (
        r'powershell "Get-Content '
        r'\"C:\ProgramData\MySQL\MySQL Server 8.0\Data\*.err\" '
        rf'-Tail {lines} | Out-String"'
    )

    result = execute_ssh_command(
        host=host,
        port=SSH_PORT,
        username=SSH_USERNAME,
        password=SSH_PASSWORD,
        command=command
    )

    return result


# =====================================================
# MYSQL SERVICE RUNNING VALIDATION
# =====================================================

def is_mysql_running(
    host
):

    result = check_mysql_service_status(
        host
    )

    if (
        result["status"] == "success"
        and "RUNNING" in result["output"]
    ):

        return True

    return False


# =====================================================
# FULL MYSQL HEALTH SUMMARY
# =====================================================

def get_mysql_health_summary(
    host,
    db_username,
    db_password,
    database_name
):

    summary = {}

    # SERVICE STATUS
    service_result = check_mysql_service_status(
        host
    )

    summary["service_status"] = (
        service_result
    )

    # PORT CHECK
    port_result = check_mysql_port(
        host
    )

    summary["port_status"] = (
        port_result
    )

    # PROCESS CHECK
    process_result = check_mysql_process(
        host
    )

    summary["process_status"] = (
        process_result
    )

    # DATABASE HEALTH
    db_result = check_mysql_database_health(
        host=host,
        username=db_username,
        password=db_password,
        database_name=database_name
    )

    summary["database_health"] = (
        db_result
    )

    return summary

# =====================================================
# GET MYSQL PORT PID
# =====================================================

def get_mysql_port_pid(
    host,
    mysql_port=3306
):

    command = (
        f'netstat -ano | findstr :{mysql_port}'
    )

    result = execute_ssh_command(
        host=host,
        port=SSH_PORT,
        username=SSH_USERNAME,
        password=SSH_PASSWORD,
        command=command
    )

    if result["status"] != "success":

        return None

    output = result["output"]

    lines = output.splitlines()

    for line in lines:

        if "LISTENING" in line:

            parts = line.split()

            pid = parts[-1]

            return pid

    return None

