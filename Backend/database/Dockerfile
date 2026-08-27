# Build context is the REPO ROOT (see docker-compose.yml's `context: .`), not
# this directory — the app imports a sibling package, `actmon_logs`
# (Backend/actmon_logs), exactly the way the real systemd deployment lays out
# Backend/database and Backend/actmon_logs side by side under the same parent.
# Building from Backend/database alone would leave that import unresolved and
# ClickHouse history would silently never connect (it degrades gracefully
# instead of crashing, so this kind of gap doesn't show up as an error).
FROM python:3.11-slim

WORKDIR /app/Backend/database

# System deps: gcc/libpq-dev for building any package without a prebuilt
# wheel, unixodbc-dev for pyodbc (MSSQL) — Backend/cloud's Dockerfile omits
# this because it doesn't need pyodbc, but this service does.
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc libpq-dev unixodbc-dev curl && \
    rm -rf /var/lib/apt/lists/*

# Python deps first, for layer caching.
COPY Backend/database/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# App source, plus the sibling actmon_logs package it imports at runtime.
COPY Backend/database/ .
COPY Backend/actmon_logs/ /app/Backend/actmon_logs/

RUN chmod +x docker-entrypoint.sh

EXPOSE 8000

# --workers 1 is NOT a tunable default — the in-process agent job-channel
# (fs-poll/dbquery long-polling) is per-process state; more than one worker
# splits a poll and its matching job across processes and every agent
# request times out. See Backend/deploy/actmon-api.service for the same
# constraint in the non-Docker deployment path.
ENTRYPOINT ["./docker-entrypoint.sh"]
