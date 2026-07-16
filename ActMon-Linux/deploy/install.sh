#!/usr/bin/env bash
# ============================================================================
# ActMon fresh INSTALL for Oracle Linux 8.10 (x86_64) — RHEL8-family compatible
# (Rocky/Alma/RHEL 8 also work; this has NOT been tuned for OL9/RHEL9).
#
# Installs: Python 3.11 venv, PostgreSQL 16 (PGDG; reuses an already-installed/
# initialized version if one is found — see the pre-check below), Redis, nginx, the two
# ActMon FastAPI services (actmon-api on :8000, actmon-cloud on :8001) behind
# nginx on port 80, with firewalld + SELinux configured.
#
# Run as root from inside the unzipped ActMon-Linux bundle:
#     sudo bash deploy/install.sh
#
# Re-running is safe (idempotent) — it skips steps already done. For updating
# an existing install to new code, use deploy/update.sh instead.
#
# Override any of these via environment before running, e.g.:
#     sudo APP_DIR=/opt/actmon WEB_PORT=8080 HOST=actmon.mycorp.com bash deploy/install.sh
# ============================================================================
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/actmon}"
SVC_USER="${SVC_USER:-actmon}"
WEB_PORT="${WEB_PORT:-80}"
HOST="${HOST:-_}"
PY_VER="${PY_VER:-3.11}"
INSTALL_CLICKHOUSE="${INSTALL_CLICKHOUSE:-false}"   # optional metrics-log tier; skipped by default
BUNDLE="$(cd "$(dirname "$0")/.." && pwd)"

log(){ echo -e "\n==> $*"; }
need_root(){ [ "$(id -u)" = "0" ] || { echo "Run as root (sudo)."; exit 1; }; }

need_root
[ -f "$BUNDLE/frontend/index.html" ] && [ -d "$BUNDLE/backend/database" ] || {
  echo "Run from inside the ActMon bundle (expected frontend/ and backend/database/ next to deploy/)."
  exit 1
}

# ----------------------------------------------------------------------------
log "Checking OS"
# ----------------------------------------------------------------------------
if [ -f /etc/oracle-release ]; then
  cat /etc/oracle-release
elif [ -f /etc/redhat-release ]; then
  echo "Not Oracle Linux, but RHEL-family: $(cat /etc/redhat-release) — continuing."
else
  echo "WARNING: this script targets Oracle Linux / RHEL 8. Unrecognized OS — continuing anyway."
fi

# ----------------------------------------------------------------------------
log "Installing base OS packages (dnf)"
# ----------------------------------------------------------------------------
dnf install -y epel-release || dnf install -y oracle-epel-release-el8 || true
dnf install -y dnf-utils policycoreutils-python-utils firewalld nginx git \
               gcc gcc-c++ make openssl-devel libffi-devel unixODBC unixODBC-devel \
               redis || true

# Python 3.11 (Oracle Linux 8 base repos ship 3.6 — the app requires 3.11; installing
# under the default python3 would silently build every C-extension dependency from
# source against an ancient interpreter, e.g. `groq`/newer `cryptography` have no
# wheels at all for 3.6). Try the plain AppStream package first (present on OL8.8+
# without any module dance), then the module stream as a fallback for older images.
if ! command -v "python${PY_VER}" >/dev/null 2>&1; then
  dnf install -y "python${PY_VER}" "python${PY_VER}-devel" "python${PY_VER}-pip" 2>/dev/null || {
    dnf module reset -y python3 2>/dev/null || true
    dnf module install -y "python${PY_VER}:${PY_VER}" || true
    dnf install -y "python${PY_VER}" "python${PY_VER}-devel" "python${PY_VER}-pip"
  }
fi
command -v "python${PY_VER}" >/dev/null 2>&1 || {
  echo "ERROR: python${PY_VER} not available from repos (checked plain AppStream package + module stream)."
  echo "       Check 'dnf module list python3' and 'dnf search python3.11' on this host."
  exit 1
}

# ----------------------------------------------------------------------------
log "PostgreSQL: pre-check"
# ----------------------------------------------------------------------------
# Earlier versions of this script only checked "is some `psql` binary on PATH" and
# assumed that meant a working server — on a box that already had an unrelated/
# uninitialized PostgreSQL lying around (AppStream's default module, or a different
# PGDG version someone installed by hand), that let the script skip straight past
# install/init/start and walk into `psql` against a dead socket. Precheck properly:
# detect what's ALREADY installed and initialized → install only what's missing →
# start only if not already active → VERIFY active before moving on to provisioning.
PG_VER="${PG_VER:-16}"   # 16 is PGDG's current default-enabled repo stream (see below)

# Prefer an already-initialized data directory over forcing a fresh version — this
# box, for instance, already has 16 (and a partial 17) from earlier troubleshooting.
for v in 17 16 15 14 13; do
  if [ -f "/var/lib/pgsql/$v/data/PG_VERSION" ]; then
    PG_VER="$v"
    log "Found an already-initialized PostgreSQL $PG_VER data directory — using it."
    break
  fi
done

PSQL_BIN="/usr/pgsql-${PG_VER}/bin/psql"
PG_SVC="postgresql-${PG_VER}"

if [ ! -x "$PSQL_BIN" ]; then
  log "PostgreSQL $PG_VER not installed — installing (PGDG)"
  dnf install -y https://download.postgresql.org/pub/repos/yum/reporpms/EL-8-x86_64/pgdg-redhat-repo-latest.noarch.rpm || true
  # The PGDG repo RPM enables ONLY its current default stream (today: 16) — every
  # other version's repo ships disabled, so `dnf install postgresqlNN-server` fails
  # with "No match for argument" even though the package genuinely exists upstream.
  dnf config-manager --set-enabled "pgdg${PG_VER}" 2>/dev/null || true
  dnf -qy module disable postgresql 2>/dev/null || true
  dnf install -y "postgresql${PG_VER}-server" "postgresql${PG_VER}" \
                 "postgresql${PG_VER}-devel" "postgresql${PG_VER}-contrib"
else
  log "PostgreSQL $PG_VER already installed."
fi

[ -f "/var/lib/pgsql/${PG_VER}/data/PG_VERSION" ] || \
  sudo -u postgres "/usr/pgsql-${PG_VER}/bin/postgresql-${PG_VER}-setup" initdb

if systemctl is-active --quiet "$PG_SVC"; then
  log "$PG_SVC already active."
else
  log "$PG_SVC installed but not running — starting it."
  systemctl enable --now "$PG_SVC"
fi

# Verify, don't assume: this exact check is what was missing last time — the
# service can fail to come up (bad data dir, port conflict, SELinux) and
# `enable --now` alone won't tell you; give it a few seconds then confirm.
for _ in 1 2 3 4 5; do
  systemctl is-active --quiet "$PG_SVC" && break
  sleep 2
done
systemctl is-active --quiet "$PG_SVC" || {
  echo "ERROR: $PG_SVC did not become active. Check:"
  echo "         systemctl status $PG_SVC"
  echo "         journalctl -u $PG_SVC -n 50 --no-pager"
  exit 1
}
log "$PG_SVC verified active."

# ----------------------------------------------------------------------------
log "Redis: pre-check"
# ----------------------------------------------------------------------------
# Optional (the app degrades to a no-op hot-metrics tier without it) — so failure
# here is non-fatal, but stay LOUD about it instead of silently swallowing it, so
# an admin isn't left guessing why the metrics pipeline looks idle.
if systemctl is-active --quiet redis 2>/dev/null || systemctl is-active --quiet redis6 2>/dev/null; then
  log "Redis already active."
elif systemctl enable --now redis 2>/dev/null || systemctl enable --now redis6 2>/dev/null; then
  log "Redis started."
else
  echo "  WARNING: could not start redis/redis6 — the hot metrics tier will run in no-op mode."
fi

systemctl enable --now firewalld

if [ "$INSTALL_CLICKHOUSE" = "true" ]; then
  log "Installing ClickHouse (INSTALL_CLICKHOUSE=true)"
  dnf install -y https://packages.clickhouse.com/rpm/clickhouse.repo 2>/dev/null || \
    curl -fsSL https://packages.clickhouse.com/rpm/lts/clickhouse.repo -o /etc/yum.repos.d/clickhouse.repo
  dnf install -y clickhouse-server clickhouse-client
  systemctl enable --now clickhouse-server
else
  log "Skipping ClickHouse (set INSTALL_CLICKHOUSE=true to enable log/metrics history tier)"
fi

# ----------------------------------------------------------------------------
log "Creating service user '$SVC_USER'"
# ----------------------------------------------------------------------------
id -u "$SVC_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /sbin/nologin "$SVC_USER"

# ----------------------------------------------------------------------------
log "Copying application to $APP_DIR"
# ----------------------------------------------------------------------------
mkdir -p "$APP_DIR"
cp -r "$BUNDLE/frontend" "$APP_DIR/frontend"
mkdir -p "$APP_DIR/backend"
cp -r "$BUNDLE/backend/database" "$APP_DIR/backend/database"
[ -d "$BUNDLE/backend/cloud" ] && cp -r "$BUNDLE/backend/cloud" "$APP_DIR/backend/cloud"
[ -d "$BUNDLE/backend/actmon_logs" ] && cp -r "$BUNDLE/backend/actmon_logs" "$APP_DIR/backend/actmon_logs"
[ -d "$BUNDLE/backend/agent" ] && cp -r "$BUNDLE/backend/agent" "$APP_DIR/backend/agent"

# ----------------------------------------------------------------------------
log "Creating Python venv ($PY_VER) and installing dependencies"
# ----------------------------------------------------------------------------
[ -d "$APP_DIR/venv" ] || "python${PY_VER}" -m venv "$APP_DIR/venv"

# Hard check, not a warning: a venv left over from an earlier failed/partial run
# (created against whatever "python3" pointed to that day, e.g. the OS-default 3.6)
# would otherwise install silently — every C-extension dep then either fails outright
# (groq/newer cryptography have zero 3.6 wheels) or quietly compiles a years-old
# fallback version from source. Fail loudly with the exact fix instead.
VENV_PY_VER="$("$APP_DIR/venv/bin/python" -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
if [ "$VENV_PY_VER" != "$PY_VER" ]; then
  echo "ERROR: $APP_DIR/venv is Python $VENV_PY_VER, but this app requires $PY_VER."
  echo "       Remove the stale venv and re-run:"
  echo "         sudo rm -rf $APP_DIR/venv && sudo bash deploy/install.sh"
  exit 1
fi

# Belt-and-suspenders for psycopg2-binary: it ships prebuilt wheels for every
# CPython version we actually support, so this should never trigger — but if PyPI
# ever lacks a matching wheel it falls back to compiling from source, which needs
# pg_config on PATH (PGDG installs it under /usr/pgsql-${PG_VER}/bin, not on PATH by default).
export PATH="/usr/pgsql-${PG_VER}/bin:$PATH"

"$APP_DIR/venv/bin/pip" install --upgrade pip wheel
"$APP_DIR/venv/bin/pip" install -r "$APP_DIR/backend/database/requirements.txt"
[ -f "$APP_DIR/backend/cloud/requirements.txt" ] && \
  "$APP_DIR/venv/bin/pip" install -r "$APP_DIR/backend/cloud/requirements.txt"

# groq (chatbot, optional) needs Python >=3.8 and isn't in requirements.txt for that
# reason (see comment there) — install it as a best-effort extra so its absence never
# blocks the rest of the app from installing.
if "$APP_DIR/venv/bin/python" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)'; then
  "$APP_DIR/venv/bin/pip" install groq || echo "  NOTE: groq install failed — chatbot feature will be unavailable."
else
  echo "  Skipping groq (requires Python >=3.8, this venv is $VENV_PY_VER) — chatbot feature will be unavailable."
fi

# ----------------------------------------------------------------------------
log "Writing $APP_DIR/backend/database/.env (generating secrets on first install)"
# ----------------------------------------------------------------------------
ENV_FILE="$APP_DIR/backend/database/.env"
if [ ! -f "$ENV_FILE" ]; then
  cp "$BUNDLE/deploy/.env.example" "$ENV_FILE"
  DB_PASS_GEN="$(openssl rand -hex 16)"
  JWT_SECRET_GEN="$(openssl rand -hex 32)"
  FERNET_KEY_GEN="$("$APP_DIR/venv/bin/python" -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())')"
  ADMIN_PASS_GEN="$(openssl rand -base64 12)"
  sed -i \
    -e "s#^DB_PASS=.*#DB_PASS=${DB_PASS_GEN}#" \
    -e "s#^JWT_SECRET=.*#JWT_SECRET=${JWT_SECRET_GEN}#" \
    -e "s#^FERNET_KEY=.*#FERNET_KEY=${FERNET_KEY_GEN}#" \
    -e "s#^ADMIN_PASSWORD=.*#ADMIN_PASSWORD=${ADMIN_PASS_GEN}#" \
    "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "  Generated DB_PASS / JWT_SECRET / FERNET_KEY / ADMIN_PASSWORD — see $ENV_FILE"
else
  echo "  $ENV_FILE already exists — leaving it untouched."
fi
# Pull out just the handful of values this script itself needs — NOT a blind `source`
# of the whole file. .env values are free-form (e.g. ORG_NAME="Default Organization"
# contains a space); sourcing that as shell would try to run `Organization` as a
# command and abort the entire install under `set -e`, well past the point of no
# return (venv/requirements already done, but before Postgres/systemd/nginx ever run).
_env_get() { grep -m1 "^$1=" "$ENV_FILE" | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'; }
DB_USER="$(_env_get DB_USER)"
DB_PASS="$(_env_get DB_PASS)"
DB_NAME="$(_env_get DB_NAME)"
ADMIN_USERNAME="$(_env_get ADMIN_USERNAME)"

# ----------------------------------------------------------------------------
log "Provisioning PostgreSQL role + database"
# ----------------------------------------------------------------------------
# `systemctl is-active` (checked above) only means the service didn't fail to
# start — it can still be a few moments from actually accepting connections.
# Confirm the socket really answers before handing psql commands to it, instead
# of surfacing "No such file or directory" from inside the provisioning step.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  sudo -u postgres "$PSQL_BIN" -tAc "SELECT 1" >/dev/null 2>&1 && break
  sleep 1
done
sudo -u postgres "$PSQL_BIN" -tAc "SELECT 1" >/dev/null 2>&1 || {
  echo "ERROR: $PG_SVC is active but not yet accepting connections on its socket."
  echo "       Check: sudo -u postgres $PSQL_BIN -c 'SELECT 1'"
  exit 1
}

sudo -u postgres "$PSQL_BIN" -tAc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" | grep -q 1 || \
  sudo -u postgres "$PSQL_BIN" -c "CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASS}';"
sudo -u postgres "$PSQL_BIN" -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1 || \
  sudo -u postgres "$PSQL_BIN" -c "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};"
# Allow password auth for local TCP connections (PGDG default pg_hba is peer/ident for local).
HBA_FILE="$(sudo -u postgres "$PSQL_BIN" -tAc 'SHOW hba_file;')"
if ! grep -q "^host.*${DB_NAME}.*${DB_USER}" "$HBA_FILE" 2>/dev/null; then
  echo "host    ${DB_NAME}    ${DB_USER}    127.0.0.1/32    scram-sha-256" >> "$HBA_FILE"
  systemctl reload "$PG_SVC" || systemctl restart "$PG_SVC"
fi

log "Applying schema + seed data (idempotent)"
( cd "$APP_DIR/backend/database" && "$APP_DIR/venv/bin/python" install/db_setup.py )

# ----------------------------------------------------------------------------
log "Installing systemd services"
# ----------------------------------------------------------------------------
sed "s#__USER__#$SVC_USER#g; s#__APP_DIR__#$APP_DIR#g; s#__PORT__#8000#g" \
    "$BUNDLE/deploy/actmon-api.service" > /etc/systemd/system/actmon-api.service
sed "s#__USER__#$SVC_USER#g; s#__APP_DIR__#$APP_DIR#g; s#__PORT__#8001#g" \
    "$BUNDLE/deploy/actmon-cloud.service" > /etc/systemd/system/actmon-cloud.service

chown -R "$SVC_USER:$SVC_USER" "$APP_DIR"
systemctl daemon-reload
systemctl enable --now actmon-api
[ -d "$APP_DIR/backend/cloud" ] && systemctl enable --now actmon-cloud

# ----------------------------------------------------------------------------
log "Installing nginx site (/etc/nginx/conf.d/actmon.conf)"
# ----------------------------------------------------------------------------
# Oracle Linux's nginx package has no sites-available convention — nginx.conf's
# http{} block already `include`s /etc/nginx/conf.d/*.conf, so drop the site there.
[ -f /etc/nginx/conf.d/default.conf ] && mv /etc/nginx/conf.d/default.conf /etc/nginx/conf.d/default.conf.disabled
sed "s#__APP_DIR__#$APP_DIR#g; s#__HOST__#$HOST#g; s#__WEB_PORT__#$WEB_PORT#g" \
    "$BUNDLE/deploy/nginx-actmon.conf" > /etc/nginx/conf.d/actmon.conf
nginx -t
systemctl enable --now nginx
systemctl restart nginx

# ----------------------------------------------------------------------------
log "SELinux (targeted policy)"
# ----------------------------------------------------------------------------
if command -v semanage >/dev/null 2>&1; then
  setsebool -P httpd_can_network_connect 1
  semanage fcontext -a -t httpd_sys_content_t "${APP_DIR}/frontend(/.*)?" 2>/dev/null || \
    semanage fcontext -m -t httpd_sys_content_t "${APP_DIR}/frontend(/.*)?"
  restorecon -Rv "$APP_DIR/frontend" >/dev/null
else
  echo "  semanage not found — SELinux context step skipped (install policycoreutils-python-utils)."
fi

# ----------------------------------------------------------------------------
log "firewalld"
# ----------------------------------------------------------------------------
if [ "$WEB_PORT" = "80" ]; then
  firewall-cmd --permanent --add-service=http
elif [ "$WEB_PORT" = "443" ]; then
  firewall-cmd --permanent --add-service=https
else
  firewall-cmd --permanent --add-port="${WEB_PORT}/tcp"
fi
firewall-cmd --reload

# ----------------------------------------------------------------------------
echo ""
echo "============================================================"
echo " ActMon installed."
echo "   URL:      http://$( [ "$HOST" = "_" ] && hostname -I | awk '{print $1}' || echo "$HOST" ):${WEB_PORT}"
echo "   Admin:    ${ADMIN_USERNAME:-admin} / see ADMIN_PASSWORD in $ENV_FILE"
echo "   Env file: $ENV_FILE  (chmod 600, owned by $SVC_USER)"
echo "   Services: systemctl status actmon-api actmon-cloud nginx"
echo "   Logs:     journalctl -u actmon-api -f"
echo "   Health:   curl -s http://127.0.0.1:8000/api/v1/download/actmon/status"
echo ""
echo " NOTE: rotate ADMIN_PASSWORD after first login. GROQ_API_KEY (chatbot) and"
echo " ClickHouse (log history) are optional — set them in $ENV_FILE if needed."
echo "============================================================"
