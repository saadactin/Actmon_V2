"""
Fix MariaDB error log access on 192.168.56.101

Run this script when the VM is online.
It will:
1. SSH as suyash, su to root
2. Enable MariaDB error log file at /var/log/mysql/error.log
3. Remove skip_log_error from mysqld_safe config
4. Create /var/log/mysql/ with mysql:adm ownership (so suyash can read via adm group)
5. Add suyash to adm group (for journalctl + log file access)
6. Restart MariaDB
7. Verify the fix
"""
import paramiko, time, sys

HOST      = "192.168.56.101"
PORT      = 22
SSH_USER  = "suyash"
SSH_PASS  = "Actin@#2931"
ROOT_PASS = "Actin@#2931"

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

print(f"Connecting to {HOST}:{PORT} as {SSH_USER}...")
try:
    client.connect(HOST, port=PORT, username=SSH_USER, password=SSH_PASS,
                   timeout=10, look_for_keys=False, allow_agent=False)
    print("✓ Connected")
except Exception as e:
    print(f"✗ SSH failed: {e}")
    sys.exit(1)

shell = client.invoke_shell(width=220, height=50)
time.sleep(1.5)
# drain login banner
while shell.recv_ready():
    shell.recv(65536)

def send(cmd, wait=2.0):
    shell.send(cmd + "\n")
    time.sleep(wait)
    out = b""
    while shell.recv_ready():
        out += shell.recv(65536)
        time.sleep(0.1)
    return out.decode("utf-8", errors="ignore")

# ─── su root ──────────────────────────────────────────────────────────────────
print("\n[1] Switching to root...")
out = send("su - root", wait=1.5)
print("    Prompt:", repr(out[-100:]))

if "password" in out.lower() or "Password" in out:
    out2 = send(ROOT_PASS, wait=2.5)
    print("    After pw:", repr(out2[-150:]))
    if "#" not in out2 and "root@" not in out2.lower():
        print("✗ su root failed — wrong password or su not available")
        sys.exit(1)
    print("✓ Root shell obtained")
else:
    print("    (no password prompt — checking id)")
    out3 = send("id", wait=1)
    if "root" not in out3:
        print("✗ Not root:", out3[-100:])
        sys.exit(1)
    print("✓ Already root")

# ─── Fix 1: Create /var/log/mysql ─────────────────────────────────────────────
print("\n[2] Creating /var/log/mysql with correct ownership...")
out = send("mkdir -p /var/log/mysql && chown mysql:adm /var/log/mysql && chmod 750 /var/log/mysql && ls -la /var/log/ | grep mysql", wait=2)
print("   ", out.strip()[-300:])

# ─── Fix 2: Enable log_error in 50-server.cnf ────────────────────────────────
print("\n[3] Enabling log_error in MariaDB config...")
# Uncomment the log_error line
out = send("sed -i 's|^#log_error = /var/log/mysql/error.log|log_error = /var/log/mysql/error.log|' /etc/mysql/mariadb.conf.d/50-server.cnf", wait=1.5)
# If it was already different, set it directly
out2 = send("grep 'log_error' /etc/mysql/mariadb.conf.d/50-server.cnf | head -3", wait=1)
print("    log_error config:", out2.strip()[-200:])

# If still commented or not there, add it
if "log_error = /var/log/mysql/error.log" not in out2:
    out3 = send("grep -q 'log_error' /etc/mysql/mariadb.conf.d/50-server.cnf || echo 'log_error = /var/log/mysql/error.log' >> /etc/mysql/mariadb.conf.d/50-server.cnf", wait=1)
    print("    Added log_error:", out3.strip()[-100:])

# ─── Fix 3: Remove skip_log_error from 50-mysqld_safe.cnf ───────────────────
print("\n[4] Removing skip_log_error from mysqld_safe config...")
out = send("sed -i 's/^skip_log_error/#skip_log_error/' /etc/mysql/mariadb.conf.d/50-mysqld_safe.cnf && grep 'skip_log_error' /etc/mysql/mariadb.conf.d/50-mysqld_safe.cnf", wait=1.5)
print("    Result:", out.strip()[-200:])

# ─── Fix 4: Add suyash to adm group ─────────────────────────────────────────
print("\n[5] Adding suyash to adm group (for log + journald access)...")
out = send("usermod -aG adm suyash && id suyash", wait=2)
print("   ", out.strip()[-200:])

# ─── Fix 5: Restart MariaDB ──────────────────────────────────────────────────
print("\n[6] Restarting MariaDB...")
out = send("systemctl restart mariadb", wait=5)
print("   ", out.strip()[-200:])
out2 = send("systemctl status mariadb | head -10", wait=2)
print("    Status:", out2.strip()[-300:])

# ─── Fix 6: Check log file was created ───────────────────────────────────────
print("\n[7] Verifying error log file...")
out = send("ls -la /var/log/mysql/error.log 2>/dev/null && head -5 /var/log/mysql/error.log 2>/dev/null", wait=2)
print("   ", out.strip()[-400:])

# ─── Fix 7: Verify suyash can read it ───────────────────────────────────────
print("\n[8] Testing read access for suyash...")
out = send("su - suyash -s /bin/bash -c 'cat /var/log/mysql/error.log | head -3' 2>&1", wait=2)
print("   ", out.strip()[-300:])

send("exit", wait=1)

print("\n✓ Fix applied. Refresh http://localhost:3000/mysql-dashboard/1/error-logs")
print("  Note: suyash needs to re-login for adm group to take effect.")
print("  Or run: newgrp adm  (only for current session)")

client.close()
