# ActMon-Linux-b1

A fresh, self-contained ActMon production package, built entirely from this
repository's current source (`frontend/`, `Backend/database/`,
`Backend/cloud/`, `Backend/actmon_logs/`). It installs as an independent
deployment (identity `actmon-b1`) that can safely run alongside any other
ActMon installation already on the same server.

## What's in this package

```
ActMon-Linux-b1/
    install.sh              installer (run this)
    README.md               this file
    Backend/
        database/            FastAPI database backend + migrations
        cloud/                FastAPI cloud discovery backend
        actmon_logs/          ClickHouse metrics-log store (sibling package)
    frontend/                 React 19 / Vite 6 source (built during install)
```

No prebuilt frontend bundle, Python virtualenv, `.env` file, or secrets are
included — `install.sh` builds/generates all of that fresh, on the target
machine, at install time.

## Requirements

- Ubuntu (or another `apt`/`systemd`-based Debian derivative), x86_64
- Root access (`sudo`)
- Internet access, for installing missing dependencies

Everything else — Python, Node.js, PostgreSQL, nginx, and (optionally)
Redis/ClickHouse — is detected and installed automatically if missing.

## Install

```bash
tar -xzf ActMon-Linux-b1.tgz
cd ActMon-Linux-b1
sudo ./install.sh
```

The installer:

1. **Prechecks** the system (OS, CPU, RAM, disk, internet, ports 9182/8003/8004)
   and every dependency, printing `[OK]` / `[INSTALL]` / `[SKIP]` / `[WARNING]`
   / `[ERROR]` for each — before changing anything.
2. Installs only what's actually missing (Python, Node.js, nginx, PostgreSQL,
   and optionally Redis/ClickHouse). Anything already installed is left alone.
3. If PostgreSQL/Redis/ClickHouse are already present on the box, you'll be
   asked for connection credentials (password entry is hidden) instead of the
   installer reinstalling or resetting them. The connection is tested before
   proceeding, with a retry prompt on failure.
4. Builds the frontend from `frontend/` (`npm ci && npm run build`).
5. Creates fresh Python virtual environments for both backends and installs
   their dependencies.
6. Generates configuration (`.env` files, `chmod 600`) with freshly generated
   secrets — a JWT secret and the credential-encryption master key. These are
   never printed, logged, or reused from any other install.
7. Provisions the database schema and replays `migrations/*.sql`
   (fault-isolated — one bad migration is logged and skipped, never aborts
   the install).
8. Installs and starts systemd services `actmon-b1-api` (:8003) and
   `actmon-b1-cloud` (:8004), and an nginx site (`actmon-b1`) on :9182.
9. Runs a final health check: HTTP checks on all three ports, plus
   PostgreSQL/Redis/ClickHouse connectivity and `systemctl`/`nginx -t` status.

## Non-interactive credentials (skip the prompts)

If PostgreSQL/Redis/ClickHouse are already installed, the script normally
prompts for connection details. Some terminals (certain web-based consoles,
e.g. Webmin's) don't reliably display interactive prompts even though input
still works — if prompts aren't showing up, pass credentials as environment
variables instead and the script skips straight past them:

```bash
sudo PGUSER=actmon_b1 PGPASSWORD=yourpass PGDATABASE=actmon_b1 \
     REDIS_HOST=127.0.0.1 REDIS_PASSWORD=yourpass \
     CLICKHOUSE_HOST=127.0.0.1 CLICKHOUSE_USER=default CLICKHOUSE_PASSWORD=yourpass CLICKHOUSE_DB=actmon_b1 \
     ./install.sh
```

- PostgreSQL: `PGHOST` (default `localhost`), `PGPORT` (default `5432`),
  `PGUSER`, `PGPASSWORD` — required together to skip the prompt,
  `PGDATABASE` (default `actmon_b1`).
- Redis: `REDIS_HOST`, `REDIS_PORT` (default `6379`), `REDIS_PASSWORD` — or
  `REDIS_SKIP=1` to disable it without prompting.
- ClickHouse: `CLICKHOUSE_HOST`, `CLICKHOUSE_PORT` (default `8123`),
  `CLICKHOUSE_USER` (default `default`), `CLICKHOUSE_PASSWORD`,
  `CLICKHOUSE_DB` (default `actmon_b1`) — or `CLICKHOUSE_SKIP=1` to disable.

These only apply when that service is already installed on the server — a
fresh PostgreSQL/Redis/ClickHouse install (nothing there before) is always
configured automatically with generated credentials, no prompt either way.

When it finishes, open `http://<server>:9182/` — since no admin account
exists yet, the first-run wizard will prompt you to create the Super
Administrator login.

## Re-running

`sudo ./install.sh` is safe to run again — it detects the existing `actmon-b1`
install, reuses its working database connection and secrets (never rotating
them out from under a running install), and just refreshes the code, frontend
build, and systemd/nginx configuration in place.

## Ports

| Service              | Port | Bind address    |
|----------------------|------|-----------------|
| nginx (frontend/API) | 9182 | all interfaces  |
| Database backend     | 8003 | 127.0.0.1 only  |
| Cloud backend        | 8004 | 127.0.0.1 only  |

These are fixed and not meant to be changed — they're ActMon's own
application ports, distinct from any monitored database's port (PostgreSQL
5432, MySQL 3306, Redis 6379, etc.). The installer refuses to start if one of
them is already held by an unrelated process — it will never kill that
process or silently pick a different port.

## Coexisting with an existing ActMon deployment

This package never touches another installation's files, systemd units,
nginx site, or database. It uses an entirely separate app directory
(`/opt/actmon-b1`), service user, PostgreSQL role/database, systemd unit
names (`actmon-b1-api`/`actmon-b1-cloud`), and nginx site (`actmon-b1`). If
an older deployment (e.g. `actmon-api.service` / `/opt/actmon`) is detected,
the installer prints a notice and proceeds without modifying it.

## Logs & troubleshooting

- Install log: `/var/log/actmon-b1-install.log` (secrets are never written
  to it).
- Service logs: `journalctl -u actmon-b1-api -f` / `journalctl -u actmon-b1-cloud -f`
- Migration failures (if any) are logged individually under
  `/tmp/actmon-b1-mig-<filename>.log` and listed at the end of the install.
- Service status: `systemctl status actmon-b1-api actmon-b1-cloud nginx`

## Security notes

- All credentials (database, Redis, ClickHouse, the JWT secret, the
  credential-encryption key) are generated or collected interactively — none
  are hardcoded in this package or written to any log.
- `Backend/database/.env` and `Backend/cloud/.env` are created with `600`
  permissions (owner-only, owned by the `actmon_b1` service user).
- The credential-encryption key (`ACTMON_ENCRYPTION_KEY`) encrypts every
  credential ActMon stores at rest. Back it up somewhere safe outside the
  database — losing it makes every already-encrypted stored credential
  permanently unrecoverable.
