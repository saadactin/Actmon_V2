from app.services.ssh_service import (
    execute_ssh_command
)

SSH_USERNAME = "actmon"
SSH_PASSWORD = "Actmon@123"

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
