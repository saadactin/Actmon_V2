#!/bin/sh
# Runs the idempotent schema/seed setup on every container start (safe to
# repeat — matches how Backend/deploy/update.sh already re-runs this on every
# production deploy), then starts the API. create_all() alone (which main.py
# also runs on import) only creates tables — no views/procs/triggers/seed
# data, so login and permissions would be broken without this step.
set -e

echo "[entrypoint] running install/db_setup.py ..."
python install/db_setup.py

echo "[entrypoint] replaying install/../migrations/*.sql (fault-isolated) ..."
python install/apply_migrations.py

echo "[entrypoint] starting uvicorn (workers=1, required — see Dockerfile) ..."
exec uvicorn main:app --host 0.0.0.0 --port 8000 --workers 1
