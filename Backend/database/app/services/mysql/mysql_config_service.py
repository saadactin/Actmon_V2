import os

from app.services.os_server.ssh_service import (
    execute_ssh_command
)

# ActMon's own dedicated OS account for these maintenance operations — read
# from .env (ACTMON_MYSQL_SSH_USERNAME/_PASSWORD) instead of a source literal.
# The fallback below matches the account this app has always shipped with, so
# existing installs keep working with zero config changes required; set the
# env vars to override it, and rotate the actual OS account's password on any
# host where this default was ever used (it's in git history either way).
SSH_USERNAME = os.getenv("ACTMON_MYSQL_SSH_USERNAME", "actmon")
SSH_PASSWORD = os.getenv("ACTMON_MYSQL_SSH_PASSWORD", "Actmon@123")

MYSQL_CONFIG_PATH = (
    r"C:\ProgramData\MySQL\MySQL Server 8.0\my.ini"
)


def backup_mysql_config(host):

    command = (
        rf'powershell "$ts=Get-Date -Format yyyyMMdd-HHmmss; '
        rf'Copy-Item -LiteralPath \"{MYSQL_CONFIG_PATH}\" '
        rf'-Destination \"{MYSQL_CONFIG_PATH}.$ts.bak\" -Force"'
    )

    return execute_ssh_command(
        host=host,
        port=22,
        username=SSH_USERNAME,
        password=SSH_PASSWORD,
        command=command
    )


def remove_mysql_variable(
    host,
    variable
):

    command = rf'''powershell "$path=\"{MYSQL_CONFIG_PATH}\"; $name=[regex]::Escape(\"{variable}\".Split('=')[0].Trim()); $lines=Get-Content -LiteralPath $path; $filtered=$lines | Where-Object {{ $_ -notmatch \"^\s*$name\s*=\" }}; Set-Content -LiteralPath $path -Value $filtered"'''

    return execute_ssh_command(
        host=host,
        port=22,
        username=SSH_USERNAME,
        password=SSH_PASSWORD,
        command=command
    )
