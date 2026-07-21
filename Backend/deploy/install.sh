#!/usr/bin/env bash
# ============================================================================
# ActMon - production installer for Ubuntu (tested target: Ubuntu 24.04 / x86_64)
#
# Safe & idempotent. It ONLY:
#   * installs required apt packages (python venv, postgresql, nginx, odbc libs)
#   * creates a dedicated 'actmon' system user + /opt/actmon
#   * creates a dedicated 'actmon' PostgreSQL role + 'actmon' database
#   * seeds schema + masters + access-control + Super Admin role (db_setup.py)
#   * installs Python deps into a private venv (NO node/npm needed - UI is prebuilt)
#   * registers systemd services + an nginx site for this host
#
# It does NOT touch other databases, other nginx sites, or the firewall.
# Run as root from the unzipped bundle:   sudo bash deploy/install.sh
# ============================================================================
set -euo pipefail

# ---- configuration (override via env before running) -----------------------
APP_HOST="${APP_HOST:-20.219.250.110}"     # public IP / hostname of this server
APP_WEB_PORT="${APP_WEB_PORT:-80}"         # public web port nginx serves the UI on
APP_DIR="${APP_DIR:-/opt/actmon}"
DB_NAME="${DB_NAME:-actmon}"
DB_USER="${DB_USER:-actmon}"
SVC_USER="${SVC_USER:-actmon}"
ORG_NAME="${ORG_NAME:-Your Company}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@yourcompany.com}"
API_PORT=8000
CLOUD_PORT=8001

log(){ echo -e "\n\033[1;36m==> $*\033[0m"; }
ok(){ echo -e "\033[1;32m  [OK] $*\033[0m"; }

if [ "$(id -u)" -ne 0 ]; then echo "Please run as root:  sudo bash deploy/install.sh"; exit 1; fi
BUNDLE="$(cd "$(dirname "$0")/.." && pwd)"    # bundle root (parent of deploy/)
[ -d "$BUNDLE/frontend" ] && [ -d "$BUNDLE/backend/database" ] || { echo "Run this from inside the unzipped ActMon bundle."; exit 1; }

log "ActMon install on $APP_HOST  (bundle: $BUNDLE)"

# ---- 1. system packages -----------------------------------------------------
log "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y python3-venv python3-pip postgresql nginx unixodbc unixodbc-dev libpq-dev curl openssl
ok "apt packages ready"

# ---- 2. service user + app dir ---------------------------------------------
id -u "$SVC_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$SVC_USER"
mkdir -p "$APP_DIR"
log "Copying application files to $APP_DIR"
cp -r "$BUNDLE/frontend" "$APP_DIR/frontend"
cp -r "$BUNDLE/backend"  "$APP_DIR/backend"
ok "files copied"

# ---- 3. python venv + deps --------------------------------------------------
log "Creating Python venv + installing dependencies"
python3 -m venv "$APP_DIR/venv"
"$APP_DIR/venv/bin/pip" install --upgrade pip wheel >/dev/null
"$APP_DIR/venv/bin/pip" install -r "$APP_DIR/backend/database/requirements.txt"
[ -f "$APP_DIR/backend/cloud/requirements.txt" ] && "$APP_DIR/venv/bin/pip" install -r "$APP_DIR/backend/cloud/requirements.txt" || true
ok "python deps installed"

# ---- 4. PostgreSQL role (dedicated, superuser for setup) --------------------
log "Configuring PostgreSQL role '$DB_USER'"
systemctl enable --now postgresql
DB_PASS="$(openssl rand -hex 16)"
ROLE_EXISTS="$(sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" || true)"
if [ "$ROLE_EXISTS" = "1" ]; then
  sudo -u postgres psql -c "ALTER ROLE $DB_USER WITH LOGIN SUPERUSER PASSWORD '$DB_PASS';" >/dev/null
else
  sudo -u postgres psql -c "CREATE ROLE $DB_USER WITH LOGIN SUPERUSER PASSWORD '$DB_PASS';" >/dev/null
fi
ok "role '$DB_USER' ready (dedicated to ActMon)"

# ---- 5. .env ---------------------------------------------------------------
log "Writing backend .env"
JWT_SECRET="$(openssl rand -hex 32)"
cat > "$APP_DIR/backend/database/.env" <<EOF
DB_HOST=localhost
DB_PORT=5432
DB_USER=$DB_USER
DB_PASS=$DB_PASS
DB_NAME=$DB_NAME
ORG_NAME=$ORG_NAME
ADMIN_EMAIL=$ADMIN_EMAIL
JWT_SECRET=$JWT_SECRET
GROQ_API_KEY=
EOF
chmod 600 "$APP_DIR/backend/database/.env"
ok ".env written (DB password + JWT secret auto-generated)"

# ---- 6. database provisioning (schema + masters + access control) ----------
log "Provisioning database '$DB_NAME' (schema, masters, access control, Super Admin role)"
( cd "$APP_DIR/backend/database" && "$APP_DIR/venv/bin/python" install/db_setup.py )
ok "database provisioned"

# ---- 7. ownership -----------------------------------------------------------
chown -R "$SVC_USER:$SVC_USER" "$APP_DIR"

# ---- 8. systemd services ----------------------------------------------------
log "Installing systemd services"
sed "s#__APP_DIR__#$APP_DIR#g; s#__USER__#$SVC_USER#g; s#__PORT__#$API_PORT#g" \
    "$BUNDLE/deploy/actmon-api.service" > /etc/systemd/system/actmon-api.service
if [ -d "$APP_DIR/backend/cloud" ]; then
  sed "s#__APP_DIR__#$APP_DIR#g; s#__USER__#$SVC_USER#g; s#__PORT__#$CLOUD_PORT#g" \
      "$BUNDLE/deploy/actmon-cloud.service" > /etc/systemd/system/actmon-cloud.service
fi
systemctl daemon-reload
systemctl enable --now actmon-api
[ -f /etc/systemd/system/actmon-cloud.service ] && systemctl enable --now actmon-cloud || true
ok "backend services running"

# ---- 9. nginx ---------------------------------------------------------------
log "Configuring nginx site"
sed "s#__APP_DIR__#$APP_DIR#g; s#__HOST__#$APP_HOST#g; s#__WEB_PORT__#$APP_WEB_PORT#g" \
    "$BUNDLE/deploy/nginx-actmon.conf" > /etc/nginx/sites-available/actmon
ln -sf /etc/nginx/sites-available/actmon /etc/nginx/sites-enabled/actmon
nginx -t && systemctl reload nginx
ok "nginx serving the ActMon UI"

# ---- done -------------------------------------------------------------------
if [ "$APP_WEB_PORT" = "80" ]; then URL="http://$APP_HOST/"; else URL="http://$APP_HOST:$APP_WEB_PORT/"; fi
echo ""
echo "============================================================"
echo " ActMon installed successfully."
echo ""
echo "   URL            : $URL"
echo "   API (internal) : 127.0.0.1:$API_PORT   (proxied via nginx /api)"
echo "   Database       : $DB_NAME  (role '$DB_USER', localhost)"
echo "   App directory  : $APP_DIR"
echo "   Services       : systemctl status actmon-api  [actmon-cloud]"
echo ""
echo " NEXT STEP - create the Super Admin login:"
echo "   Open  $URL  in a browser. The first-run wizard"
echo "   will prompt you to create the initial Super Administrator account."
echo ""
echo " NOTE (Azure): ensure inbound TCP $APP_WEB_PORT is allowed in the VM's Network"
echo " Security Group. ClickHouse (Logs metrics store) is optional and is"
echo " not installed by this script."
echo "============================================================"
