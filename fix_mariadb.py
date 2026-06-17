import paramiko, time, sys

HOST = "192.168.56.101"
PORT = 22
SSH_USER = "suyash"
SSH_PASS = "Actin@#2931"

def read_shell(shell, wait=2.5):
    time.sleep(wait)
    out = ""
    while shell.recv_ready():
        out += shell.recv(65536).decode("utf-8", errors="ignore")
    return out

def run(shell, cmd, wait=2.5):
    shell.send(cmd + "\n")
    return read_shell(shell, wait)

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, port=PORT, username=SSH_USER, password=SSH_PASS, timeout=10)
print("✓ SSH connected to", HOST)

shell = client.invoke_shell(width=220, height=50)
read_shell(shell, 2.0)   # drain login banner

# ─── Open sudo mariadb as root ───────────────────────────────────────────────
print("\n[1] Opening MariaDB as root via sudo...")
out = run(shell, f"echo '{SSH_PASS}' | sudo -S mariadb -u root 2>&1", wait=4)
if "MariaDB" not in out:
    # try without -S (already root or different sudo)
    print("   First attempt output:", out[-200:])
    out = run(shell, "sudo mariadb -u root", wait=3)
    if "[sudo]" in out or "password" in out.lower():
        run(shell, SSH_PASS, wait=2)
        out = read_shell(shell, 2)
print("   MariaDB prompt:", "YES" if "MariaDB" in out else "NO — output: " + out[-200:])

# ─── Check secure_file_priv ──────────────────────────────────────────────────
print("\n[2] Checking secure_file_priv...")
out = run(shell, "SHOW VARIABLES LIKE 'secure_file_priv';", wait=2)
print(out.strip()[-400:])
sfp_empty = "| secure_file_priv |  |" in out or "| secure_file_priv |" in out

# ─── Check current grants ────────────────────────────────────────────────────
print("\n[3] Current grants for ActmonDB1...")
out = run(shell, "SHOW GRANTS FOR 'ActmonDB1'@'%';", wait=2)
print(out.strip()[-500:])
has_file = "FILE" in out

# ─── Grant FILE privilege ─────────────────────────────────────────────────────
if not has_file:
    print("\n[4] Granting FILE privilege...")
    out = run(shell, "GRANT FILE ON *.* TO 'ActmonDB1'@'%';", wait=2)
    print(out.strip()[-200:])
    out = run(shell, "FLUSH PRIVILEGES;", wait=2)
    print("FLUSH:", out.strip()[-150:])
else:
    print("\n[4] FILE privilege already granted — skipping")

# ─── Fix secure_file_priv if not empty ───────────────────────────────────────
sfp_out = run(shell, "SHOW VARIABLES LIKE 'secure_file_priv';", wait=2)
if "| secure_file_priv |" in sfp_out:
    # Extract value
    for line in sfp_out.split('\n'):
        if 'secure_file_priv' in line:
            parts = [p.strip() for p in line.split('|') if p.strip()]
            if len(parts) >= 2:
                sfp_val = parts[1]
                print(f"\n[5] secure_file_priv = '{sfp_val}'")
                if sfp_val and sfp_val != "NULL":
                    print("   ⚠ secure_file_priv is set — need to clear it in config")
                    # Show the config file
                    shell.send("exit\n")
                    time.sleep(0.5)
                    out2 = run(shell, "sudo grep -r 'secure_file_priv' /etc/mysql/ 2>/dev/null", wait=2)
                    print("   Config grep:", out2.strip()[-300:])

                    # Find the right config file and fix it
                    out3 = run(shell, "sudo ls /etc/mysql/mariadb.conf.d/", wait=2)
                    print("   Config files:", out3.strip()[-200:])
                    out4 = run(shell, r"sudo grep -l 'secure.file.priv\|mysqld' /etc/mysql/mariadb.conf.d/*.cnf 2>/dev/null | head -1", wait=2)
                    cnf_file = out4.strip().split('\n')[-1].strip()
                    if not cnf_file:
                        cnf_file = "/etc/mysql/mariadb.conf.d/50-server.cnf"

                    # Remove or comment out the line
                    fix_cmd = f"sudo sed -i 's/^secure.file.priv.*/#&/' {cnf_file}"
                    out5 = run(shell, fix_cmd, wait=2)
                    print(f"   Commented out in {cnf_file}:", out5.strip()[-200:])

                    # Restart MariaDB
                    out6 = run(shell, "sudo systemctl restart mariadb", wait=6)
                    print("   Restart:", out6.strip()[-200:])
                else:
                    print("   ✓ secure_file_priv is empty — no restriction")
                break

# ─── Re-open MariaDB and test LOAD_FILE ──────────────────────────────────────
print("\n[6] Testing LOAD_FILE after fix...")
# Close any existing MariaDB session first
run(shell, "exit", wait=1)
out = run(shell, f"echo '{SSH_PASS}' | sudo -S mariadb -u root 2>&1", wait=4)
if "MariaDB" not in out:
    run(shell, "sudo mariadb -u root", wait=3)

out = run(shell, "SELECT IF(LOAD_FILE('/var/lib/mysql/ActinDB1-slow.log') IS NOT NULL, 'FILE_READ_OK', 'STILL_NULL') AS result;", wait=3)
print(out.strip()[-400:])

# Show first 300 chars of the file if readable
out2 = run(shell, "SELECT LEFT(LOAD_FILE('/var/lib/mysql/ActinDB1-slow.log'), 300) AS preview;", wait=3)
print("\n[7] File preview via LOAD_FILE:")
print(out2.strip()[-500:])

# ─── Verify final grants ─────────────────────────────────────────────────────
print("\n[8] Final grants for ActmonDB1:")
out = run(shell, "SHOW GRANTS FOR 'ActmonDB1'@'%';", wait=2)
print(out.strip()[-500:])

shell.send("exit\n")
client.close()
print("\n✓ All done. Refresh http://localhost:3000/mysql-dashboard/1/slow-queries")
