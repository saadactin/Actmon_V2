#!/usr/bin/env bash
# ============================================================================
# ActMon-Linux-b1 — fresh production installer (Ubuntu 24.04 / x86_64)
#
# Ships inside the ActMon-Linux-b1.tgz package next to this script's own
# application source, and builds/deploys ONLY that source:
#   frontend/              (React 19 / Vite 6 / Tailwind 4 — built from source)
#   Backend/database/      (FastAPI database backend  -> port 8003)
#   Backend/cloud/         (FastAPI cloud backend      -> port 8004)
#   Backend/actmon_logs/   (sibling ClickHouse metrics-log store)
#
# Never reads from / writes to Actmon_V1, actmon_v1, any old ActMon-Linux-b*
# package, any prebuilt frontend bundle, or any previous ActMon
# virtualenv/.env/systemd unit. This package's own source is the only
# source of truth.
#
# Installs under a fixed, distinct identity (actmon-b1 / /opt/actmon-b1)
# so it can run alongside ANY other ActMon installation already on this
# box (e.g. the actmon-api.service / /opt/actmon layout documented in
# Backend/deploy/DEPLOY.md) without collision. It never stops, deletes, or
# reconfigures a pre-existing deployment's services, files, or database.
#
# Ports (fixed, not overridable — these are ActMon's own application ports,
# never to be confused with a monitored database's own port):
#   9182 = nginx (frontend + API proxy)
#   8003 = ActMon Database Backend API (uvicorn, 127.0.0.1 only)
#   8004 = ActMon Cloud Backend API   (uvicorn, 127.0.0.1 only)
#
# Safe to re-run: detects what is already installed/configured and reuses
# it (secrets are never rotated out from under a running install; databases
# are never dropped; nothing already correct is redone).
#
# Run as root from the extracted package root:   sudo ./install.sh
# ============================================================================
set -Eeuo pipefail

# ---------------------------------------------------------------------------
# 0. logging (redacted — secrets are simply never written anywhere, ever)
# ---------------------------------------------------------------------------
LOGFILE="/var/log/actmon-b1-install.log"
touch "$LOGFILE" 2>/dev/null && chmod 600 "$LOGFILE" 2>/dev/null || LOGFILE="/dev/null"

CUR_STEP="startup"
_ts(){ date '+%Y-%m-%d %H:%M:%S'; }
logf(){ echo "[$(_ts)] $*" >>"$LOGFILE" 2>/dev/null || true; }

step(){ CUR_STEP="$1"; echo -e "\n\033[1;36m[$1/$TOTAL_STEPS] $2\033[0m"; logf "STEP $1/$TOTAL_STEPS: $2"; }
log(){  echo -e "  $*"; logf "$*"; }
ok(){   echo -e "  \033[1;32m[OK]\033[0m $*";      logf "[OK] $*"; }
inst(){ echo -e "  \033[1;34m[INSTALL]\033[0m $*"; logf "[INSTALL] $*"; }
skip(){ echo -e "  \033[1;90m[SKIP]\033[0m $*";    logf "[SKIP] $*"; }
warn(){ echo -e "  \033[1;33m[WARNING]\033[0m $*"; logf "[WARNING] $*"; }
err(){  echo -e "  \033[1;31m[ERROR]\033[0m $*";   logf "[ERROR] $*"; }

on_error(){
  local line=$1
  err "Installation failed at step '$CUR_STEP' (install.sh line $line)."
  err "See $LOGFILE for the install log (secrets are never written to it)."
  exit 1
}
trap 'on_error $LINENO' ERR

TOTAL_STEPS=15

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
have(){ command -v "$1" >/dev/null 2>&1; }

ask(){ # ask VAR "Prompt" "default"
  # Force the prompt out explicitly (printf, not read -p's built-in prompt)
  # and on its own line — read -p only shows its prompt under certain isatty
  # conditions, which some web-based/proxied terminals (e.g. Webmin's) don't
  # satisfy even though input still works, leaving the user typing blind.
  local __var="$1" __prompt="$2" __default="${3:-}" __ans
  if [ -n "$__default" ]; then
    printf '\n  %s [%s]: ' "$__prompt" "$__default" >&2
  else
    printf '\n  %s: ' "$__prompt" >&2
  fi
  read -r __ans </dev/tty
  __ans="${__ans:-$__default}"
  printf '      -> got: %s\n' "$__ans" >&2
  printf -v "$__var" '%s' "$__ans"
}

ask_secret(){ # ask_secret VAR "Prompt"
  local __var="$1" __prompt="$2" __ans
  printf '\n  %s: ' "$__prompt" >&2
  read -r -s __ans </dev/tty; echo >&2
  if [ -n "$__ans" ]; then
    printf '      -> got: (%d characters entered, not shown)\n' "${#__ans}" >&2
  else
    printf '      -> got: (EMPTY — nothing was entered)\n' >&2
  fi
  printf -v "$__var" '%s' "$__ans"
}

require_tty(){
  if [ ! -t 0 ] && [ ! -r /dev/tty ]; then
    err "This step requires interactive input (credentials) but no TTY is available."
    err "Re-run in an interactive shell, or pre-set the corresponding env vars documented at the top of install.sh."
    exit 1
  fi
}

port_owner(){ # prints "pid comm" for a listening TCP port, or nothing
  ss -ltnp 2>/dev/null | awk -v p=":$1" '$4 ~ p"$"{print $NF}' | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1
}

check_port(){ # check_port PORT LABEL -> sets PORT_STATUS=AVAILABLE|OWN|CONFLICT
  local port="$1" label="$2" pid comm
  pid="$(port_owner "$port")"
  if [ -z "$pid" ]; then
    PORT_STATUS=AVAILABLE
    ok "Port $port ($label): AVAILABLE"
  else
    comm="$(ps -p "$pid" -o comm= 2>/dev/null || echo unknown)"
    if echo "$comm" | grep -qE 'uvicorn|nginx' && [ "$IS_RERUN" = "1" ]; then
      PORT_STATUS=OWN
      ok "Port $port ($label): in use by this install's own service (pid $pid, $comm) — will be restarted"
    else
      PORT_STATUS=CONFLICT
      err "Port $port ($label) is already in use by another process:"
      err "    PID $pid   process: $comm"
      FAILED_PRECHECK=1
    fi
  fi
}

# ===========================================================================
if [ "$(id -u)" -ne 0 ]; then echo "Please run as root:  sudo ./install.sh"; exit 1; fi

REPO="$(cd "$(dirname "$0")" && pwd)"
[ -f "$REPO/Backend/database/main.py" ] && [ -f "$REPO/Backend/cloud/app/main.py" ] && [ -f "$REPO/frontend/package.json" ] \
  || { err "Run this from the repo root — Backend/database/main.py, Backend/cloud/app/main.py and frontend/package.json must sit next to install.sh."; exit 1; }

readonly WEB_PORT=9182
readonly API_PORT=8003
readonly CLOUD_PORT=8004

echo "========================================"
echo "     ACTMON-LINUX-B1 INSTALLER"
echo "========================================"
logf "==== install run started (repo: $REPO) ===="

# ---------------------------------------------------------------------------
# fixed identity — always "actmon-b1", regardless of what else is on this
# box, so this install can never collide with any other ActMon deployment.
# ---------------------------------------------------------------------------
OLD_DEPLOY_DETECTED=0
[ -f /etc/systemd/system/actmon-api.service ] && OLD_DEPLOY_DETECTED=1

ACTMON_ID="${ACTMON_ID:-actmon-b1}"
ID_PLAIN="${ACTMON_ID//-/_}"                # actmon_b1 — usernames/dbnames can't contain '-' safely everywhere
APP_DIR="${APP_DIR:-/opt/$ACTMON_ID}"
SVC_USER="${SVC_USER:-$ID_PLAIN}"
DB_NAME="${DB_NAME:-$ID_PLAIN}"
API_SVC="$ACTMON_ID-api"
CLOUD_SVC="$ACTMON_ID-cloud"
NGINX_SITE="$ACTMON_ID"

ORG_NAME="${ORG_NAME:-Your Company}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@yourcompany.com}"
NODE_MAJOR="${NODE_MAJOR:-20}"
APP_HOST="${APP_HOST:-$(hostname -I 2>/dev/null | awk '{print $1}')}"
APP_HOST="${APP_HOST:-_}"

IS_RERUN=0
[ -f "$APP_DIR/Backend/database/.env" ] && IS_RERUN=1

log "Install identity : $ACTMON_ID  (app dir: $APP_DIR)"
if [ "$OLD_DEPLOY_DETECTED" = "1" ]; then
  warn "An OLDER ActMon deployment (actmon-api.service) was detected — installing as '$ACTMON_ID' alongside it, untouched."
fi
[ "$IS_RERUN" = "1" ] && log "Existing '$ACTMON_ID' install found at $APP_DIR — this run will update it in place."

# ===========================================================================
step 1 "System pre-check"
# ===========================================================================
FAILED_PRECHECK=0

OS_NAME="unknown"; OS_VER="unknown"
if [ -r /etc/os-release ]; then . /etc/os-release; OS_NAME="${NAME:-unknown}"; OS_VER="${VERSION_ID:-unknown}"; fi
ARCH="$(uname -m)"
CPU_CORES="$(nproc 2>/dev/null || echo '?')"
RAM_MB="$(awk '/MemTotal/{printf "%.0f", $2/1024}' /proc/meminfo 2>/dev/null || echo '?')"
DISK_AVAIL="$(df -h / --output=avail 2>/dev/null | tail -1 | tr -d ' ' || echo '?')"
HOSTNAME_="$(hostname 2>/dev/null || echo '?')"

INTERNET_OK=0
if have curl; then
  curl -fsS -m 5 -o /dev/null https://deb.nodesource.com 2>/dev/null && INTERNET_OK=1
else
  timeout 5 bash -c 'exec 3<>/dev/tcp/1.1.1.1/443' 2>/dev/null && INTERNET_OK=1
fi

echo ""
echo "  OS            : $OS_NAME $OS_VER"
echo "  Architecture  : $ARCH"
echo "  CPU           : $CPU_CORES cores"
echo "  RAM           : ${RAM_MB} MB"
echo "  Disk (/)      : $DISK_AVAIL available"
echo "  Hostname      : $HOSTNAME_"
echo "  Internet      : $([ "$INTERNET_OK" = "1" ] && echo OK || echo "UNREACHABLE")"
echo "  Privileges    : ROOT"
echo ""

if ! have apt-get; then
  err "apt-get not found — this installer targets Ubuntu/Debian. Aborting."
  exit 1
fi
ok "Package manager: apt"

if [ -d /run/systemd/system ]; then
  ok "systemd: present"
else
  err "systemd not detected — this installer requires systemd on Ubuntu 24.04."
  exit 1
fi

if [ "$INTERNET_OK" != "1" ]; then
  warn "Internet connectivity check failed — package installs below may fail."
fi

echo "  Ports:"
check_port "$WEB_PORT" "nginx/frontend"
check_port "$API_PORT" "database backend"
check_port "$CLOUD_PORT" "cloud backend"
echo ""

for d in /opt /etc/systemd/system /etc/nginx; do
  [ -d "$d" ] || warn "$d does not exist yet — will be created if needed."
done

if [ "$FAILED_PRECHECK" = "1" ]; then
  err "One or more required ports are occupied by a process unrelated to this install."
  err "Resolve the conflict (stop that process or free the port) and re-run install.sh."
  exit 1
fi
ok "System pre-check passed"

# ===========================================================================
step 2 "Dependency pre-check"
# ===========================================================================
declare -A NEED_APT=()   # apt-package -> human label, only for missing ones

check_dep(){ # check_dep "human label" "command to test" "apt package(s) if missing"
  local label="$1" testcmd="$2" pkg="$3"
  if eval "$testcmd" >/dev/null 2>&1; then
    ok "$label already present"
  else
    inst "$label not found — will install ($pkg)"
    NEED_APT["$pkg"]="$label"
  fi
}

check_dep "Python 3"                  "have python3"                 "python3 python3-venv python3-dev python3-pip"
check_dep "build tools (gcc/make)"    "have gcc"                      "build-essential"
check_dep "libpq-dev (PostgreSQL headers)" "dpkg -s libpq-dev"        "libpq-dev"
check_dep "unixODBC headers"          "dpkg -s unixodbc-dev"          "unixodbc unixodbc-dev"
check_dep "OpenSSL/FFI headers"       "dpkg -s libssl-dev libffi-dev" "libssl-dev libffi-dev"
check_dep "curl"                      "have curl"                     "curl"
check_dep "rsync"                     "have rsync"                    "rsync"
check_dep "openssl CLI"               "have openssl"                  "openssl"
check_dep "nginx"                     "have nginx"                    "nginx"
check_dep "gnupg"                     "have gpg"                       "gnupg"

# --- Node.js (frontend build) ------------------------------------------------
NODE_OK=0
if have node; then
  NV="$(node -v | sed 's/^v//; s/\..*//')"
  if [ "$NV" -ge "$NODE_MAJOR" ] 2>/dev/null; then NODE_OK=1; fi
fi
if [ "$NODE_OK" = "1" ]; then
  ok "Node.js already present ($(node -v))"
else
  inst "Node.js ${NODE_MAJOR}.x not found — required to build frontend/ (Vite 6 / React 19)"
fi

# A systemd unit-file check alone can miss a server that's genuinely running
# (started manually, via a different init mechanism, or under a differently
# named unit) — check for an actual listening port / process too, so we never
# mistake a live, in-use service for "not installed" and try to install over it.
service_live(){ # service_live PORT PROCESS_NAME
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && { exec 3<&- 3>&- 2>/dev/null; return 0; }
  pgrep -x "$2" >/dev/null 2>&1
}

# --- PostgreSQL --------------------------------------------------------------
PG_SERVER_PRESENT=0
systemctl list-unit-files 2>/dev/null | grep -q '^postgresql\.service' && PG_SERVER_PRESENT=1
service_live 5432 postgres && PG_SERVER_PRESENT=1
if have psql; then
  PG_VER="$(psql --version 2>/dev/null | awk '{print $NF}')"
  ok "PostgreSQL client already present (psql $PG_VER)"
else
  inst "PostgreSQL client (psql) not found"
  NEED_APT["postgresql-client"]="PostgreSQL client"
fi
if [ "$PG_SERVER_PRESENT" = "1" ]; then
  ok "PostgreSQL server already installed"
else
  inst "PostgreSQL server not found — will install (used unless you point install.sh at an external server)"
fi

# --- Redis (optional hot tier for the 15s metrics pipeline) -----------------
REDIS_SERVER_PRESENT=0
systemctl list-unit-files 2>/dev/null | grep -qE '^redis-server\.service' && REDIS_SERVER_PRESENT=1
service_live 6379 redis-server && REDIS_SERVER_PRESENT=1
if have redis-cli; then
  ok "Redis client already present"
else
  inst "Redis client (redis-cli) not found"
  NEED_APT["redis-tools"]="Redis client"
fi
if [ "$REDIS_SERVER_PRESENT" = "1" ]; then
  ok "Redis server already installed"
else
  inst "Redis server not found — will install (optional hot tier; ActMon degrades gracefully without it)"
fi

# --- ClickHouse (per-tech metrics history / Logs store) ---------------------
CH_SERVER_PRESENT=0
systemctl list-unit-files 2>/dev/null | grep -q '^clickhouse-server\.service' && CH_SERVER_PRESENT=1
service_live 8123 clickhouse-server && CH_SERVER_PRESENT=1
if have clickhouse-client; then
  ok "ClickHouse client already present"
else
  inst "ClickHouse client not found (will install if a ClickHouse server is set up)"
fi
if [ "$CH_SERVER_PRESENT" = "1" ]; then
  ok "ClickHouse server already installed"
else
  inst "ClickHouse server not found — will offer to install (optional: metrics history / Logs store)"
fi

if [ "${#NEED_APT[@]}" -eq 0 ]; then
  skip "All required apt packages already present"
fi

# ===========================================================================
step 3 "Install missing dependencies"
# ===========================================================================
export DEBIAN_FRONTEND=noninteractive
if [ "${#NEED_APT[@]}" -gt 0 ]; then
  log "Running apt-get update"
  # A single misbehaving third-party repo (e.g. a stale packages.clickhouse.com
  # entry left over from something else on this box) makes apt-get update exit
  # non-zero even though every repo we actually need for this step succeeded.
  # Don't abort the whole install over that — apt still uses whatever indices
  # it did fetch, and the apt-get install calls below fail loudly on their own
  # if a genuinely-needed package's repo is the one that's actually broken.
  apt-get update -y >>"$LOGFILE" 2>&1 || warn "apt-get update reported errors from one or more repos (see $LOGFILE) — continuing with the indices that did fetch"
  PKGS=(); for p in "${!NEED_APT[@]}"; do PKGS+=($p); done
  log "Installing: ${PKGS[*]}"
  apt-get install -y "${PKGS[@]}" >>"$LOGFILE" 2>&1
  ok "apt packages installed"
else
  skip "apt-get install (nothing missing)"
fi

if [ "$NODE_OK" != "1" ]; then
  log "Installing Node.js ${NODE_MAJOR}.x (NodeSource)"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >>"$LOGFILE" 2>&1
  apt-get install -y nodejs >>"$LOGFILE" 2>&1
  ok "node $(node -v) installed"
fi

REDIS_INSTALLED_NOW=0
if [ "$REDIS_SERVER_PRESENT" != "1" ]; then
  log "Installing Redis server"
  if apt-get install -y redis-server >>"$LOGFILE" 2>&1; then
    REDIS_INSTALLED_NOW=1
    ok "redis-server installed"
  else
    warn "redis-server install failed — continuing without it (optional dependency)"
  fi
fi

CH_INSTALLED_NOW=0
CH_INSTALL_ATTEMPTED=0
if [ "$CH_SERVER_PRESENT" != "1" ] && [ "$INTERNET_OK" = "1" ]; then
  CH_INSTALL_ATTEMPTED=1
  log "Installing ClickHouse server (official ClickHouse apt repo)"
  {
    ARCH_CH="$(dpkg --print-architecture)"
    curl -fsSL https://packages.clickhouse.com/deb/pubkey.gpg | gpg --yes --batch --dearmor -o /usr/share/keyrings/clickhouse-keyring.gpg
    echo "deb [signed-by=/usr/share/keyrings/clickhouse-keyring.gpg arch=${ARCH_CH}] https://packages.clickhouse.com/deb stable main" \
      > /etc/apt/sources.list.d/clickhouse.list
    apt-get update -y
    apt-get install -y clickhouse-server clickhouse-client
  } >>"$LOGFILE" 2>&1 && { CH_INSTALLED_NOW=1; ok "clickhouse-server installed"; } \
    || warn "ClickHouse install failed — continuing without it (optional dependency; Logs/metrics-history store will show offline)"
elif [ "$CH_SERVER_PRESENT" != "1" ]; then
  warn "No internet access — skipping ClickHouse install (optional dependency)"
fi

# ===========================================================================
step 4 "Configure application source + service account"
# ===========================================================================
id -u "$SVC_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$SVC_USER"
mkdir -p "$APP_DIR/Backend"
log "Copying current source into $APP_DIR (frontend/, Backend/database/, Backend/cloud/ — this checkout only)"
rsync -a --delete \
  --exclude 'venv' --exclude '__pycache__' --exclude '.env' \
  "$REPO/Backend/database/" "$APP_DIR/Backend/database/"
rsync -a --delete \
  --exclude 'venv' --exclude '__pycache__' --exclude '.env' \
  "$REPO/Backend/cloud/" "$APP_DIR/Backend/cloud/"
# actmon_logs is a sibling package the database backend imports by walking up
# from Backend/database/app/services/logs/ to Backend/ — it must be deployed
# at that same sibling depth or `import actmon_logs` fails at runtime.
rsync -a --delete \
  --exclude '__pycache__' \
  "$REPO/Backend/actmon_logs/" "$APP_DIR/Backend/actmon_logs/"
rsync -a --delete \
  --exclude 'node_modules' --exclude 'dist' \
  "$REPO/frontend/" "$APP_DIR/frontend/"
# Only the pre-built installer artifacts (dist/) — agent_install_service.py
# serves these directly. NOT wix/ (candle.exe/light.exe are Windows-only;
# this server has no way to run them without Wine) and not .venv-build/
# (a local PyInstaller build venv, irrelevant at runtime).
if [ -d "$REPO/Backend/agent/dist" ]; then
  mkdir -p "$APP_DIR/Backend/agent"
  rsync -a --delete "$REPO/Backend/agent/dist/" "$APP_DIR/Backend/agent/dist/"
  ok "agent installer artifacts copied (Backend/agent/dist/)"
else
  warn "Backend/agent/dist/ not found in this package — agent .msi/.exe/.deb/.rpm downloads will be unavailable"
fi
ok "source copied from this checkout"

# ===========================================================================
step 5 "Configure PostgreSQL"
# ===========================================================================
systemctl enable --now postgresql >>"$LOGFILE" 2>&1 || true

pg_test(){ # pg_test HOST PORT USER PASS DB -> 0 if reachable
  PGPASSWORD="$4" psql -h "$1" -p "$2" -U "$3" -d "${5:-postgres}" -tAc "SELECT 1" >/dev/null 2>&1
}

if [ "$IS_RERUN" = "1" ] && [ -f "$APP_DIR/Backend/database/.env" ]; then
  PG_HOST="$(grep -m1 '^DB_HOST=' "$APP_DIR/Backend/database/.env" | cut -d= -f2-)"
  PG_PORT="$(grep -m1 '^DB_PORT=' "$APP_DIR/Backend/database/.env" | cut -d= -f2-)"
  PG_USER="$(grep -m1 '^DB_USER=' "$APP_DIR/Backend/database/.env" | cut -d= -f2-)"
  PG_PASS="$(grep -m1 '^DB_PASS=' "$APP_DIR/Backend/database/.env" | cut -d= -f2-)"
  PG_DB="$(grep -m1 '^DB_NAME=' "$APP_DIR/Backend/database/.env" | cut -d= -f2-)"
  if pg_test "$PG_HOST" "$PG_PORT" "$PG_USER" "$PG_PASS" postgres; then
    ok "Re-run detected — reusing existing PostgreSQL connection ($PG_HOST:$PG_PORT/$PG_DB)"
  else
    warn "Stored PostgreSQL credentials no longer connect — reconfiguring the database connection only"
    warn "(JWT secret / encryption key are preserved regardless — rotating those would invalidate every session and every already-encrypted stored credential)"
    PG_NEEDS_RECONFIG=1
  fi
fi

if [ "$IS_RERUN" != "1" ] || [ "${PG_NEEDS_RECONFIG:-0}" = "1" ] || [ -z "${PG_HOST:-}" ]; then
  # A server not present before this run == CASE A (we just installed it locally).
  # A server that was already there == CASE B (never reset its password / touch its data).
  if [ "$PG_SERVER_PRESENT" = "1" ]; then
    ok "PostgreSQL detected (pre-existing installation)"
    if [ -n "${PGUSER:-}" ] && [ -n "${PGPASSWORD:-}" ]; then
      # Non-interactive path: if the standard libpq env vars are already set
      # (e.g. `sudo PGUSER=actmon_b1 PGPASSWORD=... PGDATABASE=... ./install.sh`),
      # use them directly instead of prompting — this also sidesteps terminals
      # that don't render interactive prompts/stderr correctly (some web
      # consoles, e.g. Webmin's, echo typed input but never show the prompt).
      PG_HOST="${PGHOST:-127.0.0.1}"; PG_PORT="${PGPORT:-5432}"
      PG_USER="$PGUSER"; PG_PASS="$PGPASSWORD"; PG_DB="${PGDATABASE:-$DB_NAME}"
      log "Using PostgreSQL credentials from environment (PGUSER/PGPASSWORD/...) — no prompt needed"
      pg_test "$PG_HOST" "$PG_PORT" "$PG_USER" "$PG_PASS" postgres \
        && ok "PostgreSQL connection successful" \
        || { err "PostgreSQL authentication/connection failed with the supplied PGUSER/PGPASSWORD/PGHOST/PGPORT."; exit 1; }
    else
      require_tty
      log "Provide a PostgreSQL role with rights to create a new database (a superuser role, e.g. 'postgres')."
      log "Tip: if prompts below don't display properly in this terminal, re-run instead as:"
      log "  sudo PGUSER=youruser PGPASSWORD=yourpass PGDATABASE=yourdb ./install.sh"
      RETRY=1
      while [ "$RETRY" = "1" ]; do
        ask     PG_HOST "PostgreSQL Host" "${PGHOST:-127.0.0.1}"
        ask     PG_PORT "PostgreSQL Port" "${PGPORT:-5432}"
        ask     PG_USER "PostgreSQL Username" "${PGUSER:-postgres}"
        ask_secret PG_PASS "PostgreSQL Password"
        ask     PG_DB   "PostgreSQL Database (created if it doesn't exist)" "${PGDATABASE:-$DB_NAME}"
        if pg_test "$PG_HOST" "$PG_PORT" "$PG_USER" "$PG_PASS" postgres; then
          ok "PostgreSQL connection successful"
          RETRY=0
        else
          err "PostgreSQL authentication/connection failed"
          ask RETRY_ANS "Retry? [Y/n]" "Y"
          [[ "$RETRY_ANS" =~ ^[Nn] ]] && { err "Aborting — cannot proceed without a working PostgreSQL connection."; exit 1; }
        fi
      done
    fi
  else
    log "Installing a local PostgreSQL role '$DB_NAME' for this install"
    PG_HOST=127.0.0.1; PG_PORT=5432; PG_USER="$DB_NAME"; PG_DB="$DB_NAME"
    PG_PASS="$(openssl rand -hex 16)"
    ROLE_EXISTS="$(sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$PG_USER'" || true)"
    if [ "$ROLE_EXISTS" = "1" ]; then
      sudo -u postgres psql -c "ALTER ROLE $PG_USER WITH LOGIN SUPERUSER PASSWORD '$PG_PASS';" >>"$LOGFILE" 2>&1
    else
      sudo -u postgres psql -c "CREATE ROLE $PG_USER WITH LOGIN SUPERUSER PASSWORD '$PG_PASS';" >>"$LOGFILE" 2>&1
    fi
    ok "role '$PG_USER' ready"
  fi
fi

# ===========================================================================
step 6 "Configure Redis"
# ===========================================================================
REDIS_URL=""
ask_redis_creds() {
  ask R_HOST "Redis Host (blank = disable Redis hot tier)" "127.0.0.1"
  if [ -n "$R_HOST" ]; then
    ask R_PORT "Redis Port" "6379"
    ask_secret R_PASS "Redis Password (blank if none)"
    if [ -n "$R_PASS" ]; then
      redis-cli -h "$R_HOST" -p "$R_PORT" -a "$R_PASS" --no-auth-warning ping >/dev/null 2>&1 \
        && { REDIS_URL="redis://:$R_PASS@$R_HOST:$R_PORT/0"; ok "Redis connection successful"; } \
        || warn "Redis connection failed — continuing without Redis (optional)"
    else
      redis-cli -h "$R_HOST" -p "$R_PORT" ping >/dev/null 2>&1 \
        && { REDIS_URL="redis://$R_HOST:$R_PORT/0"; ok "Redis connection successful"; } \
        || warn "Redis connection failed — continuing without Redis (optional)"
    fi
  else
    skip "Redis disabled by user"
  fi
}

if ! have redis-cli; then
  skip "Redis not available — ActMon will run without the metrics hot tier"
elif [ "$REDIS_INSTALLED_NOW" = "1" ]; then
  # We just installed this Redis ourselves in this same run — nothing
  # pre-existing to collide with, so local defaults are safe without asking.
  systemctl enable --now redis-server >>"$LOGFILE" 2>&1 || true
  for _i in 1 2 3 4 5; do redis-cli -h 127.0.0.1 -p 6379 ping >/dev/null 2>&1 && break; sleep 1; done
  if redis-cli -h 127.0.0.1 -p 6379 ping >/dev/null 2>&1; then
    REDIS_URL="redis://127.0.0.1:6379/0"
    ok "Redis reachable at 127.0.0.1:6379"
  else
    warn "Redis installed but not answering yet — continuing without it (optional)"
  fi
elif [ "$REDIS_SERVER_PRESENT" = "1" ]; then
  # A pre-existing Redis — it may be shared with other projects/deployments.
  # Never auto-assume the default local connection just because it answers:
  # always ask for connection details (or read them from env vars below).
  warn "An existing Redis server was detected — it may be shared with other projects/deployments."
  if [ -n "${REDIS_HOST:-}" ] || [ -n "${REDIS_SKIP:-}" ]; then
    log "Using Redis connection from environment (REDIS_HOST/REDIS_PORT/REDIS_PASSWORD) — no prompt needed"
    R_HOST="${REDIS_HOST:-}"; R_PORT="${REDIS_PORT:-6379}"; R_PASS="${REDIS_PASSWORD:-}"
    if [ -n "$R_HOST" ]; then
      if [ -n "$R_PASS" ]; then
        redis-cli -h "$R_HOST" -p "$R_PORT" -a "$R_PASS" --no-auth-warning ping >/dev/null 2>&1 \
          && { REDIS_URL="redis://:$R_PASS@$R_HOST:$R_PORT/0"; ok "Redis connection successful"; } \
          || warn "Redis connection failed — continuing without Redis (optional)"
      else
        redis-cli -h "$R_HOST" -p "$R_PORT" ping >/dev/null 2>&1 \
          && { REDIS_URL="redis://$R_HOST:$R_PORT/0"; ok "Redis connection successful"; } \
          || warn "Redis connection failed — continuing without Redis (optional)"
      fi
    else
      skip "Redis disabled via REDIS_SKIP"
    fi
  else
    require_tty
    log "Tip: if prompts below don't display properly in this terminal, re-run instead as:"
    log "  sudo REDIS_HOST=127.0.0.1 REDIS_PASSWORD=yourpass ./install.sh   (or REDIS_SKIP=1 to disable)"
    ask_redis_creds
  fi
else
  skip "No Redis server available — ActMon will run without the metrics hot tier"
fi

# ===========================================================================
step 7 "Configure ClickHouse"
# ===========================================================================
CH_HOST=""; CH_PORT=8123; CH_USER=default; CH_PASS=""; CH_DB=actmon_b1
ch_test(){ curl -fsS -m 3 "http://$1:$2/ping" 2>/dev/null | grep -q "Ok"; }

if [ "$CH_INSTALLED_NOW" = "1" ]; then
  # We just installed this ClickHouse ourselves in this same run — nothing
  # pre-existing to collide with, so local defaults are safe without asking.
  systemctl enable --now clickhouse-server >>"$LOGFILE" 2>&1 || true
  for _i in 1 2 3 4 5 6 7 8 9 10; do ch_test 127.0.0.1 8123 && break; sleep 1; done
  if ch_test 127.0.0.1 8123; then
    CH_HOST=127.0.0.1
    ok "ClickHouse reachable at 127.0.0.1:8123"
  else
    warn "ClickHouse installed but not answering yet — will retry automatically at app startup"
  fi
elif have clickhouse-client || [ "$CH_SERVER_PRESENT" = "1" ]; then
  # A pre-existing ClickHouse — it may be shared with other projects or an
  # older ActMon deployment. NEVER auto-assume default credentials/database
  # just because the default port answers: always ask, and default the
  # database name to a dedicated one (never the generic "actmon" some other
  # install may already be using) so this can't silently collide with data
  # that's already there.
  warn "An existing ClickHouse server was detected — it may be shared with other projects/deployments."
  if [ -n "${CLICKHOUSE_HOST:-}" ] || [ -n "${CLICKHOUSE_SKIP:-}" ]; then
    log "Using ClickHouse connection from environment (CLICKHOUSE_HOST/...) — no prompt needed"
    CH_HOST="${CLICKHOUSE_HOST:-}"; CH_PORT="${CLICKHOUSE_PORT:-8123}"
    CH_USER="${CLICKHOUSE_USER:-default}"; CH_PASS="${CLICKHOUSE_PASSWORD:-}"; CH_DB="${CLICKHOUSE_DB:-actmon_b1}"
    if [ -n "$CH_HOST" ]; then
      ch_test "$CH_HOST" "$CH_PORT" && ok "ClickHouse connection successful" \
        || { warn "ClickHouse connection failed — continuing without it (optional)"; CH_HOST=""; }
    else
      skip "ClickHouse disabled via CLICKHOUSE_SKIP"
    fi
  else
    require_tty
    log "Tip: if prompts below don't display properly in this terminal, re-run instead as:"
    log "  sudo CLICKHOUSE_HOST=127.0.0.1 CLICKHOUSE_USER=default CLICKHOUSE_PASSWORD=yourpass CLICKHOUSE_DB=actmon_b1 ./install.sh   (or CLICKHOUSE_SKIP=1 to disable)"
    ask CH_HOST "ClickHouse Host (blank = disable ClickHouse store)" "127.0.0.1"
    if [ -n "$CH_HOST" ]; then
      ask CH_PORT "ClickHouse HTTP Port" "8123"
      ask CH_USER "ClickHouse Username" "default"
      ask_secret CH_PASS "ClickHouse Password (blank if none)"
      ask CH_DB "ClickHouse Database (dedicated to this install — do not reuse another project's)" "actmon_b1"
      ch_test "$CH_HOST" "$CH_PORT" && ok "ClickHouse connection successful" \
        || { warn "ClickHouse connection failed — continuing without it (optional)"; CH_HOST=""; }
    else
      skip "ClickHouse disabled by user"
    fi
  fi
else
  skip "No ClickHouse server available — metrics-history/Logs store will show offline"
fi

# ===========================================================================
step 8 "Write application configuration"
# ===========================================================================
if [ "$IS_RERUN" = "1" ] && [ -f "$APP_DIR/Backend/database/.env" ]; then
  JWT_SECRET="$(grep -m1 '^JWT_SECRET=' "$APP_DIR/Backend/database/.env" | cut -d= -f2-)"
  ACTMON_ENCRYPTION_KEY="$(grep -m1 '^ACTMON_ENCRYPTION_KEY=' "$APP_DIR/Backend/database/.env" | cut -d= -f2-)"
  skip "Reusing existing JWT secret / encryption key (rotating these would invalidate every session and every already-encrypted stored credential)"
else
  JWT_SECRET="$(openssl rand -hex 32)"
fi

if [ -z "${ACTMON_ENCRYPTION_KEY:-}" ]; then
  ACTMON_ENCRYPTION_KEY="$(python3 -c "import base64,os;print(base64.b64encode(os.urandom(32)).decode())")"
fi

cat > "$APP_DIR/Backend/database/.env" <<EOF
DB_HOST=$PG_HOST
DB_PORT=$PG_PORT
DB_USER=$PG_USER
DB_PASS=$PG_PASS
DB_NAME=$PG_DB
ORG_NAME=$ORG_NAME
ADMIN_EMAIL=$ADMIN_EMAIL
JWT_SECRET=$JWT_SECRET
ACTMON_ENCRYPTION_KEY=$ACTMON_ENCRYPTION_KEY
GROQ_API_KEY=
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM=
ACTMON_MYSQL_SSH_USERNAME=
ACTMON_MYSQL_SSH_PASSWORD=
ACTMON_LOGS_ENABLED=$([ -n "$CH_HOST" ] && echo true || echo false)
ACTMON_LOGS_CH_HOST=$CH_HOST
ACTMON_LOGS_CH_PORT=$CH_PORT
ACTMON_LOGS_CH_USER=$CH_USER
ACTMON_LOGS_CH_PASSWORD=$CH_PASS
ACTMON_LOGS_CH_DB=$CH_DB
EOF
# Only written when Redis is actually configured — leaving REDIS_URL unset
# (rather than set-but-empty) lets redis_store_service.py's own
# os.getenv("REDIS_URL", "redis://127.0.0.1:6379/0") default apply, which
# degrades to a safe no-op if nothing is there.
[ -n "$REDIS_URL" ] && echo "REDIS_URL=$REDIS_URL" >> "$APP_DIR/Backend/database/.env"
chmod 600 "$APP_DIR/Backend/database/.env"

cat > "$APP_DIR/Backend/cloud/.env" <<EOF
DATABASE_URL=
DB_USER=$PG_USER
DB_PASS=$PG_PASS
DB_HOST=$PG_HOST
DB_PORT=$PG_PORT
DB_NAME=$PG_DB
JWT_SECRET=$JWT_SECRET
ACTMON_ENCRYPTION_KEY=$ACTMON_ENCRYPTION_KEY
CLOUD_SERVICE_PORT=$CLOUD_PORT
DEBUG=false
EOF
chmod 600 "$APP_DIR/Backend/cloud/.env"
ok ".env files written (mode 600, no secrets printed to console or log)"

# ===========================================================================
step 9 "Build frontend"
# ===========================================================================
log "npm install && vite build (from $APP_DIR/frontend)"
( cd "$APP_DIR/frontend" && (npm ci --no-audit --no-fund || npm install --no-audit --no-fund) && npm run build ) >>"$LOGFILE" 2>&1
[ -f "$APP_DIR/frontend/dist/index.html" ] || { err "Frontend build did not produce dist/index.html."; exit 1; }
ok "frontend built -> $APP_DIR/frontend/dist"

# ===========================================================================
step 10 "Set up Python backend"
# ===========================================================================
# Skip a venv's (re)install only if it already exists AND requirements.txt
# hasn't changed since the last successful install — tracked via a hash file
# inside the venv itself. A genuine requirements.txt change always
# reinstalls; nothing changing skips a slow pip install on every re-run.
setup_venv(){ # setup_venv APP_SUBDIR (e.g. "Backend/database")
  local dir="$APP_DIR/$1" reqfile="$APP_DIR/$1/requirements.txt"
  local want_hash have_hash
  want_hash="$(sha256sum "$reqfile" | awk '{print $1}')"
  have_hash="$(cat "$dir/venv/.req_hash" 2>/dev/null || true)"
  if [ -x "$dir/venv/bin/python" ] && [ "$want_hash" = "$have_hash" ]; then
    skip "$1: venv already up to date with requirements.txt"
    return
  fi
  python3 -m venv "$dir/venv"
  "$dir/venv/bin/pip" install --upgrade pip wheel -q
  "$dir/venv/bin/pip" install -r "$reqfile" >>"$LOGFILE" 2>&1
  echo "$want_hash" > "$dir/venv/.req_hash"
  ok "$1: python deps installed"
}

log "Setting up Python venvs (database + cloud)"
setup_venv "Backend/database"
setup_venv "Backend/cloud"
"$APP_DIR/Backend/database/venv/bin/python" -c "import fastapi, sqlalchemy, psycopg2" \
  || { err "Database backend dependency import check failed."; exit 1; }
"$APP_DIR/Backend/cloud/venv/bin/python" -c "import fastapi, sqlalchemy, asyncpg" \
  || { err "Cloud backend dependency import check failed."; exit 1; }
ok "python deps installed and import-verified (database + cloud)"

# ===========================================================================
step 11 "Database initialization"
# ===========================================================================
log "Provisioning database '$PG_DB' (schema, masters, access control, Super Admin role)"
( cd "$APP_DIR/Backend/database" && "$APP_DIR/Backend/database/venv/bin/python" install/db_setup.py ) >>"$LOGFILE" 2>&1 \
  || { err "install/db_setup.py failed — see $LOGFILE. The required schema is not in place; not proceeding."; exit 1; }
ok "db_setup.py complete"

log "Replaying migrations/*.sql (fault-isolated — one bad file cannot abort the install)"
FAILED_MIGRATIONS=()
shopt -s nullglob
for f in "$APP_DIR"/Backend/database/migrations/*.sql; do
  name="$(basename "$f")"
  if PGPASSWORD="$PG_PASS" psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1 -f "$f" >"/tmp/actmon-b1-mig-$name.log" 2>&1; then
    ok "migration $name"
  else
    warn "migration $name FAILED — see /tmp/actmon-b1-mig-$name.log"
    FAILED_MIGRATIONS+=("$name")
  fi
done
shopt -u nullglob
chown -R "$SVC_USER:$SVC_USER" "$APP_DIR"

# ===========================================================================
step 12 "Configure backend systemd services"
# ===========================================================================
cat > "/etc/systemd/system/$API_SVC.service" <<EOF
[Unit]
Description=ActMon-Linux-b1 Database Backend API (FastAPI / uvicorn, port $API_PORT)
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=$SVC_USER
WorkingDirectory=$APP_DIR/Backend/database
EnvironmentFile=$APP_DIR/Backend/database/.env
# Single worker is REQUIRED: the agent job-channel (fs-poll / dbquery) is
# in-process, so multiple workers would split poll vs. job across processes
# and every dbquery would time out.
ExecStart=$APP_DIR/Backend/database/venv/bin/uvicorn main:app --host 127.0.0.1 --port $API_PORT --workers 1
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

cat > "/etc/systemd/system/$CLOUD_SVC.service" <<EOF
[Unit]
Description=ActMon-Linux-b1 Cloud Backend API (FastAPI / uvicorn, port $CLOUD_PORT)
After=network.target
PartOf=$API_SVC.service

[Service]
Type=simple
User=$SVC_USER
WorkingDirectory=$APP_DIR/Backend/cloud
EnvironmentFile=$APP_DIR/Backend/cloud/.env
ExecStart=$APP_DIR/Backend/cloud/venv/bin/uvicorn app.main:app --host 127.0.0.1 --port $CLOUD_PORT
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
ok "systemd units written ($API_SVC, $CLOUD_SVC)"

# ===========================================================================
step 13 "Configure nginx"
# ===========================================================================
cat > "/etc/nginx/sites-available/$NGINX_SITE" <<EOF
server {
    listen $WEB_PORT;
    server_name $APP_HOST;

    root $APP_DIR/frontend/dist;
    index index.html;
    client_max_body_size 25m;

    gzip on;
    gzip_comp_level 5;
    gzip_min_length 1024;
    gzip_proxied any;
    gzip_vary on;
    gzip_types text/plain text/css application/json application/javascript
               text/javascript image/svg+xml application/xml font/woff2;

    location /assets/ {
        expires 30d;
        add_header Cache-Control "public, immutable";
        try_files \$uri =404;
    }

    proxy_redirect http://127.0.0.1/ /;
    proxy_redirect http://127.0.0.1:$WEB_PORT/ /;
    proxy_redirect http://$APP_HOST/ /;
    proxy_redirect http://$APP_HOST:$WEB_PORT/ /;

    # Cloud backend (must precede the generic /api rule)
    location /api/v1/cloud/ {
        proxy_pass http://127.0.0.1:$CLOUD_PORT;
        proxy_set_header Host \$http_host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_read_timeout 300s;
    }

    # Terminal websocket
    location /api/v1/terminal/ws {
        proxy_pass http://127.0.0.1:$API_PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$http_host;
        proxy_read_timeout 3600s;
    }

    # Database backend API
    location /api/ {
        proxy_pass http://127.0.0.1:$API_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$http_host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 300s;
    }

    # SPA fallback
    location / {
        try_files \$uri \$uri/ /index.html;
    }
}
EOF
ln -sf "/etc/nginx/sites-available/$NGINX_SITE" "/etc/nginx/sites-enabled/$NGINX_SITE"
nginx -t >>"$LOGFILE" 2>&1 || { err "nginx configuration test failed — see $LOGFILE. Not reloading nginx."; exit 1; }
ok "nginx site '$NGINX_SITE' validated"

# ===========================================================================
step 14 "Start ActMon"
# ===========================================================================
systemctl enable --now "$API_SVC" >>"$LOGFILE" 2>&1
systemctl enable --now "$CLOUD_SVC" >>"$LOGFILE" 2>&1

# nginx is a single shared process — it may already be serving an older
# ActMon deployment's site alongside ours. A `restart` would briefly drop
# ALL sites it serves, not just this one, so only ever `reload` (zero
# downtime, applies new/changed sites-enabled configs in place) once nginx
# is confirmed running; only fall back to starting it if it wasn't running
# at all yet (nothing else could have been relying on it in that case).
if systemctl is-active --quiet nginx; then
  systemctl reload nginx >>"$LOGFILE" 2>&1 \
    || { err "nginx reload failed — see $LOGFILE. Not restarting nginx, since that would disrupt any other site(s) it's already serving."; exit 1; }
else
  systemctl enable --now nginx >>"$LOGFILE" 2>&1
fi
sleep 2
for svc in "$API_SVC" "$CLOUD_SVC" nginx; do
  systemctl is-active --quiet "$svc" && ok "$svc: RUNNING" || { err "$svc failed to start — see: journalctl -u $svc"; exit 1; }
done

# ===========================================================================
step 15 "Final health check"
# ===========================================================================
http_ok(){ [ "$(curl -fsS -o /dev/null -m 5 -w '%{http_code}' "$1" 2>/dev/null)" = "200" ]; }

HC_FAIL=0
http_ok "http://127.0.0.1:$WEB_PORT/" && ok "Frontend (nginx :$WEB_PORT): OK" || { err "Frontend health check failed"; HC_FAIL=1; }
http_ok "http://127.0.0.1:$API_PORT/openapi.json" && ok "Database Backend (:$API_PORT): OK" || { err "Database Backend health check failed"; HC_FAIL=1; }
http_ok "http://127.0.0.1:$CLOUD_PORT/api/v1/cloud/openapi.json" && ok "Cloud Backend (:$CLOUD_PORT): OK" || { err "Cloud Backend health check failed"; HC_FAIL=1; }

PG_STATUS="NOT CONFIGURED"
pg_test "$PG_HOST" "$PG_PORT" "$PG_USER" "$PG_PASS" "$PG_DB" && { ok "PostgreSQL: CONNECTED"; PG_STATUS="CONNECTED"; } \
  || { err "PostgreSQL connection check failed"; PG_STATUS="FAILED"; HC_FAIL=1; }

REDIS_STATUS="not configured"
if [ -n "$REDIS_URL" ]; then
  RURL_HOST="$(echo "$REDIS_URL" | sed -E 's#redis://(.*@)?([^:/]+).*#\2#')"
  RURL_PORT="$(echo "$REDIS_URL" | sed -E 's#.*:([0-9]+)/.*#\1#')"
  redis-cli -h "$RURL_HOST" -p "$RURL_PORT" ping >/dev/null 2>&1 && { ok "Redis: CONNECTED"; REDIS_STATUS="CONNECTED"; } \
    || { warn "Redis check failed (non-fatal)"; REDIS_STATUS="unreachable"; }
fi

CH_STATUS="not configured"
if [ -n "$CH_HOST" ]; then
  ch_test "$CH_HOST" "$CH_PORT" && { ok "ClickHouse: CONNECTED"; CH_STATUS="CONNECTED"; } \
    || { warn "ClickHouse check failed (non-fatal)"; CH_STATUS="unreachable"; }
fi

if [ "$HC_FAIL" = "1" ]; then
  err "One or more critical health checks failed. Installation did NOT complete cleanly."
  err "Check: journalctl -u $API_SVC -u $CLOUD_SVC --no-pager | tail -100    and    $LOGFILE"
  exit 1
fi

# ===========================================================================
echo ""
echo "========================================"
echo "   ACTMON-LINUX-B1 INSTALLATION COMPLETE"
echo "========================================"
echo ""
echo "Frontend:"
echo "    http://$APP_HOST:$WEB_PORT"
echo ""
echo "Database Backend:"
echo "    http://$APP_HOST:$API_PORT   (proxied via nginx /api)"
echo ""
echo "Cloud Backend:"
echo "    http://$APP_HOST:$CLOUD_PORT  (proxied via nginx /api/v1/cloud)"
echo ""
echo "Services:"
echo "    Nginx              : RUNNING"
echo "    Database Backend   : RUNNING  ($API_SVC)"
echo "    Cloud Backend       : RUNNING  ($CLOUD_SVC)"
echo ""
echo "Dependencies:"
echo "    PostgreSQL         : $PG_STATUS  ($PG_HOST:$PG_PORT/$PG_DB)"
[ -n "$REDIS_URL" ] && echo "    Redis              : $REDIS_STATUS"
[ -n "$CH_HOST" ] && echo "    ClickHouse         : $CH_STATUS"
echo ""
echo "App directory       : $APP_DIR"
echo "Install log         : $LOGFILE"
if [ "${#FAILED_MIGRATIONS[@]}" -gt 0 ]; then
  echo ""
  echo "!! ${#FAILED_MIGRATIONS[@]} migration(s) did not apply cleanly — review before trusting the schema:"
  for m in "${FAILED_MIGRATIONS[@]}"; do echo "     - $m   (log: /tmp/actmon-b1-mig-$m.log)"; done
fi
if [ "$OLD_DEPLOY_DETECTED" = "1" ]; then
  echo ""
  echo "An older ActMon deployment (actmon-api.service) was left completely"
  echo "untouched — both installs are now running side by side."
fi
echo ""
echo "NEXT STEP: open the URL above. Since no admin exists yet, the first-run"
echo "wizard will prompt you to create the Super Admin account."
echo ""
echo "Re-running this script updates the code/build/config in place without"
echo "rotating secrets or touching existing data."
echo "========================================"
logf "==== install run completed successfully ===="
