# ActMon — Quick Start (pre-built images)

This package runs the full ActMon application (frontend, main API, cloud
discovery service, Postgres, Redis, ClickHouse) via Docker — no build step,
no source code required.

## Requirements

- Docker Desktop (or Docker Engine + Compose) installed and running.
- ~3GB free disk space.

## Setup (one time)

1. **Load the images:**
   ```
   docker load -i actmon-images.tar.gz
   ```
   This registers `actmonv1-backend`, `actmonv1-cloud`, and `actmonv1-nginx`
   locally — takes a minute or two.

2. **Set your database password:**
   Copy `.env.docker.example` to `.env` (same folder as
   `docker-compose.stakeholder.yml`) and set `POSTGRES_PASSWORD` to something
   real — this is the one required value.

3. **Set the app's own secrets:**
   - Copy `Backend/database/.env.example` to `Backend/database/.env`.
     `ACTMON_ENCRYPTION_KEY` and `JWT_SECRET` are required — the file
     explains how to generate them (one Python one-liner each). Leave
     `GROQ_API_KEY`/`SMTP_*` blank to disable those optional features.
   - Copy `Backend/cloud/.env.example` to `Backend/cloud/.env` and fill in
     `JWT_SECRET`/`FERNET_KEY`/`ACTMON_ENCRYPTION_KEY` the same way — this
     service has its own secrets, independent from the main backend's.

## Run it

```
docker compose -f docker-compose.stakeholder.yml up -d
```

Open **http://localhost:9182** — first run shows a setup wizard to create
the Super Admin account, since no admin exists yet.

## Stopping / restarting

```
docker compose -f docker-compose.stakeholder.yml down      # stop (data kept)
docker compose -f docker-compose.stakeholder.yml up -d     # start again
docker compose -f docker-compose.stakeholder.yml down -v   # stop AND wipe all data
```

## What's in this package

- `actmon-images.tar.gz` — the three application images, pre-built.
- `docker-compose.stakeholder.yml` — orchestrates everything (Postgres,
  Redis, ClickHouse are pulled from Docker Hub automatically on first run;
  only the three ActMon images come from the tar).
- `.env.docker.example`, `Backend/database/.env.example`,
  `Backend/cloud/.env.example` — configuration templates. None of these
  contain real secrets — you generate your own per the instructions inside
  each file.
