#!/usr/bin/env bash
# ============================================================================
# ActMon in-place UPDATE — refresh an existing /opt/actmon install to this
# bundle's code, WITHOUT reinstalling. Keeps the database, .env, venv, and
# systemd/nginx config. Run as root from inside the unzipped new bundle:
#     sudo bash deploy/update.sh
# ============================================================================
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/actmon}"
SVC_USER="${SVC_USER:-actmon}"
BUNDLE="$(cd "$(dirname "$0")/.." && pwd)"
ts="$(date +%Y%m%d-%H%M%S)"

log(){ echo -e "\n==> $*"; }

[ -f "$BUNDLE/frontend/index.html" ] && [ -d "$BUNDLE/backend/database" ] || { echo "Run from inside the new ActMon bundle."; exit 1; }
[ -f "$APP_DIR/backend/database/.env" ] || { echo "No existing install at $APP_DIR (.env missing) — use install.sh instead."; exit 1; }

log "Backing up current app (frontend + backend/app) with suffix .bak-$ts"
cp -a "$APP_DIR/frontend" "$APP_DIR/frontend.bak-$ts" 2>/dev/null || true
cp -a "$APP_DIR/backend/database/app" "$APP_DIR/backend/database/app.bak-$ts" 2>/dev/null || true

log "Updating frontend (prebuilt UI)"
rm -rf "$APP_DIR/frontend"
cp -r "$BUNDLE/frontend" "$APP_DIR/frontend"

log "Updating backend code (preserving .env / venv / agent binaries)"
cp -a "$APP_DIR/backend/database/.env" /tmp/actmon.env.keep
rm -rf "$APP_DIR/backend/database/app"
cp -r "$BUNDLE/backend/database/app"        "$APP_DIR/backend/database/app"
cp -f "$BUNDLE/backend/database/main.py"    "$APP_DIR/backend/database/main.py"
[ -d "$APP_DIR/backend/database/install/downloads" ] && mv "$APP_DIR/backend/database/install/downloads" /tmp/actmon_downloads.keep
rm -rf "$APP_DIR/backend/database/install"
cp -r "$BUNDLE/backend/database/install"    "$APP_DIR/backend/database/install"
if [ -d /tmp/actmon_downloads.keep ]; then
  rm -rf "$APP_DIR/backend/database/install/downloads"
  mv /tmp/actmon_downloads.keep "$APP_DIR/backend/database/install/downloads"
fi
cp -f "$BUNDLE/backend/database/requirements.txt" "$APP_DIR/backend/database/requirements.txt"
cp -a /tmp/actmon.env.keep "$APP_DIR/backend/database/.env"; rm -f /tmp/actmon.env.keep
# cloud + logs adapter + agent installers/scripts (agent .exe/.msi kept if bundle omits them)
[ -d "$BUNDLE/backend/cloud/app" ]     && { rm -rf "$APP_DIR/backend/cloud/app";  cp -r "$BUNDLE/backend/cloud/app" "$APP_DIR/backend/cloud/app"; cp -f "$BUNDLE/backend/cloud/requirements.txt" "$APP_DIR/backend/cloud/" 2>/dev/null || true; }
[ -d "$BUNDLE/backend/actmon_logs" ]   && { rm -rf "$APP_DIR/backend/actmon_logs"; cp -r "$BUNDLE/backend/actmon_logs" "$APP_DIR/backend/actmon_logs"; }
[ -d "$BUNDLE/backend/agent" ]         && cp -rf "$BUNDLE/backend/agent" "$APP_DIR/backend/"

log "Installing any new Python dependencies"
"$APP_DIR/venv/bin/pip" install -q -r "$APP_DIR/backend/database/requirements.txt" || true

log "Fixing ownership + restarting services (frees old pooled DB connections FIRST)"
chown -R "$SVC_USER:$SVC_USER" "$APP_DIR"
# The agent job-channel (dbquery) is in-process — MUST run a single uvicorn worker,
# or agent poll vs. job land on different workers and every dbquery times out.
if grep -q -- '--workers 2' /etc/systemd/system/actmon-api.service 2>/dev/null; then
  sed -i 's/--workers 2/--workers 1/' /etc/systemd/system/actmon-api.service
  systemctl daemon-reload
fi
systemctl restart actmon-api
systemctl restart actmon-cloud 2>/dev/null || true
sleep 3   # let the fresh workers settle before the standalone seed scripts connect

log "Applying DB migrations / seed (idempotent)"
MIGRATION_FAILED=0
( cd "$APP_DIR/backend/database" && "$APP_DIR/venv/bin/python" install/db_setup.py ) || MIGRATION_FAILED=1
if [ "$MIGRATION_FAILED" = "1" ]; then
  echo ""
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  echo "!! DB MIGRATION FAILED — the app is now running against an OUTDATED schema. !!"
  echo "!! Every route touching a table this bundle added columns to WILL error.     !!"
  echo "!! Fix, then re-run:                                                         !!"
  echo "!!   cd $APP_DIR/backend/database && sudo $APP_DIR/venv/bin/python install/db_setup.py !!"
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  echo ""
fi

log "Registering extra menu entries (Sales, etc. — idempotent)"
"$APP_DIR/venv/bin/python" "$BUNDLE/deploy/register_extras.py" || true
if [ -f "$BUNDLE/deploy/nginx-actmon.conf" ]; then
  # Regenerate the site from the bundled template (has Host $http_host + relative
  # redirects), preserving the port/host already in use. Then force sites-enabled
  # to be a SYMLINK — a stale standalone copy there silently shadows every edit.
  CUR="/etc/nginx/sites-enabled/actmon"; [ -f "$CUR" ] || CUR="/etc/nginx/sites-available/actmon"
  WEB_PORT="$(grep -m1 -oE 'listen +[0-9]+' "$CUR" 2>/dev/null | grep -oE '[0-9]+')"; WEB_PORT="${WEB_PORT:-80}"
  HOST="$(grep -m1 -E '^[[:space:]]*server_name' "$CUR" 2>/dev/null | sed -E 's/.*server_name[[:space:]]+([^;]+);.*/\1/')"; HOST="${HOST:-_}"
  sed "s#__APP_DIR__#$APP_DIR#g; s#__HOST__#$HOST#g; s#__WEB_PORT__#$WEB_PORT#g" \
      "$BUNDLE/deploy/nginx-actmon.conf" > /etc/nginx/sites-available/actmon
  ln -sf /etc/nginx/sites-available/actmon /etc/nginx/sites-enabled/actmon
  nginx -t && systemctl restart nginx || true
fi

echo ""
echo "============================================================"
echo " ActMon updated to the latest build."
echo "   Backups: $APP_DIR/frontend.bak-$ts , app.bak-$ts"
echo "   Verify:  systemctl status actmon-api"
echo "            curl -s http://127.0.0.1:8000/api/v1/download/actmon/status"
echo " Then hard-refresh the browser (Ctrl+Shift+R) and re-login."
echo "============================================================"
if [ "$MIGRATION_FAILED" = "1" ]; then
  echo ""
  echo "!! REMINDER: the DB migration step above FAILED — re-run it manually before !!"
  echo "!! trusting anything in the UI:                                            !!"
  echo "!!   cd $APP_DIR/backend/database && sudo $APP_DIR/venv/bin/python install/db_setup.py !!"
  echo ""
fi
