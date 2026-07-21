# ActMon — Production Deployment (Ubuntu)

Target: **Ubuntu 24.04 / x86_64** (e.g. `tjarsrv02`), host **20.219.250.110**.

The bundle ships **only source + the prebuilt UI** — no `node_modules`, no `venv`,
no `.env`. The installer creates the venv, installs Python deps, provisions
PostgreSQL, seeds the app, and registers services. **No Node.js is needed** on the
server (the UI is already built to static files).

## Bundle layout
```
ActMon-Linux-<date>/
  frontend/           prebuilt UI (static — served by nginx)
  backend/
    database/         FastAPI app + install/ (schema.sql, config seed, db_setup.py)
    cloud/            Cloud Discovery microservice (optional)
    actmon_logs/      ClickHouse logs adapter (optional store)
  deploy/
    install.sh        the installer
    actmon-api.service, actmon-cloud.service, nginx-actmon.conf, .env.production
  DEPLOY.md           this file
```

## Deploy (5 steps)
The server is reached over SSH on a **custom port** (not the default 22). Set it once:
```bash
SSH_PORT=<your-ssh-port>        # e.g. 2222 — the port your server listens on
SSH_USER=<your-ssh-user>        # e.g. azureuser
HOST=20.219.250.110

# 1. copy the bundle to the server  (scp uses -P, uppercase)
scp -P "$SSH_PORT" ActMon-Linux.zip "$SSH_USER@$HOST:/tmp/"

# 2. connect  (ssh uses -p, lowercase) and unzip
ssh -p "$SSH_PORT" "$SSH_USER@$HOST"
sudo apt-get install -y unzip
cd /tmp && unzip -o ActMon-Linux.zip && cd ActMon-Linux

# 3. run the installer (as root)
sudo bash deploy/install.sh
#    override host/org if needed:
#    sudo APP_HOST=20.219.250.110 ORG_NAME="Acme Corp" bash deploy/install.sh

# 4. open the app
#    http://20.219.250.110/    → first-run wizard creates the Super Admin

# 5. Azure NSG: allow inbound TCP 80 (the app) — and TCP $SSH_PORT (SSH) if not already
```
> The **SSH port** only affects how you copy/connect to the server (steps 1–2).
> The app itself is served by nginx on **port 80** at `http://20.219.250.110/`.
> To also serve the app on a non-standard web port, run the installer with
> `APP_WEB_PORT=<port>` (see `install.sh`) and open `http://20.219.250.110:<port>/`.

## What the installer does (safe & idempotent)
- apt: `python3-venv python3-pip postgresql nginx unixodbc unixodbc-dev libpq-dev`
- creates system user `actmon` and `/opt/actmon`
- venv at `/opt/actmon/venv`, installs `backend/database/requirements.txt` (+ cloud)
- PostgreSQL: a **dedicated `actmon` role** (superuser — required for extensions,
  `session_replication_role`, `CREATE DATABASE`) and the **`actmon` database**.
  It does not touch any other database.
- runs `install/db_setup.py` → schema, permission bits, modules, full page_master
  route registry, status_master, organization #1, Super Admin role #1 with FULL
  page permissions.
- writes `/opt/actmon/backend/database/.env` with an auto-generated DB password
  and `JWT_SECRET` (file mode 600).
- systemd: `actmon-api` (uvicorn :8000), `actmon-cloud` (uvicorn :8001, optional).
- nginx: site for `20.219.250.110` serving the UI and proxying `/api` → :8000,
  `/api/v1/cloud` → :8001, and the terminal websocket. Existing sites are untouched.

## Operate
```bash
systemctl status actmon-api actmon-cloud     # health
journalctl -u actmon-api -f                  # backend logs
systemctl restart actmon-api                 # after a config change
```
Credentials & config live in `/opt/actmon/backend/database/.env`.

## Optional — Logs metrics store (ClickHouse)
The **Logs → Database Logs** metrics store uses ClickHouse. It is *not* installed
here; the Logs page shows "store offline" until you provide one. To enable, install
ClickHouse (native pkg or Docker) reachable at `localhost:8123` and restart
`actmon-api` (see `ACTMON_LOGS_CH_*` env vars in `actmon_logs/core.py`).

## Update later
Rebuild the UI (`npm run build`) + re-package, copy the new bundle, then:
```bash
sudo rsync -a --delete frontend/ /opt/actmon/frontend/
sudo rsync -a backend/ /opt/actmon/backend/ --exclude database/.env
sudo /opt/actmon/venv/bin/pip install -r /opt/actmon/backend/database/requirements.txt
sudo /opt/actmon/venv/bin/python /opt/actmon/backend/database/install/db_setup.py   # idempotent migrations/seed
sudo systemctl restart actmon-api actmon-cloud && sudo systemctl reload nginx
```
