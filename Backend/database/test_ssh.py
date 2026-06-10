from app.services.ssh_service import (
    execute_ssh_command
)

# REMOVE INVALID VARIABLE
remove_result = execute_ssh_command(
    host="localhost",
    port=22,
    username="actmon",
    password="Actmon@123",
    command=r'powershell "(Get-Content \"C:\ProgramData\MySQL\MySQL Server 8.0\my.ini\") | Where-Object { $_ -notmatch \"abcd==1;\" } | Set-Content \"C:\ProgramData\MySQL\MySQL Server 8.0\my.ini\""'
)

print("REMOVE RESULT:")
print(remove_result)


# START MYSQL
start_result = execute_ssh_command(
    host="localhost",
    port=22,
    username="actmon",
    password="Actmon@123",
    command="net start MySQL80"
)

print("\nSTART RESULT:")
print(start_result)


# VERIFY STATUS
status_result = execute_ssh_command(
    host="localhost",
    port=22,
    username="actmon",
    password="Actmon@123",
    command="sc query MySQL80"
)

print("\nSTATUS RESULT:")
print(status_result)