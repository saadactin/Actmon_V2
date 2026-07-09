# Installing ActMon

One command provisions everything: dependencies, database, schema, the full page/
permission registry, a **Super Admin** role, and a browser wizard to create your
admin account. Works on **Windows, Linux, Ubuntu and macOS**.

## Prerequisites
- **Python 3.10+**
- **Node.js 18+** (with npm) — for the web UI
- **PostgreSQL 14+**, running, with a **superuser** role (the installer creates the
  database, extensions and triggers)

## 1. Configure `.env`
Copy the template and fill in your PostgreSQL details:

```bash
cd Backend/database
cp .env.example .env        # Windows: copy .env.example .env
```

Edit `Backend/database/.env`:

```
DB_HOST=localhost
DB_PORT=5432
DB_USER=postgres            # a superuser role
DB_PASS=your-postgres-password
DB_NAME=actmon
ORG_NAME=Your Company
ADMIN_EMAIL=admin@yourcompany.com
SMTP_HOST=...               # needed so login OTP emails can be sent (see note)
```

## 2. Run the installer (from the repo root)

```bash
python install.py           # Linux/macOS/Ubuntu may use: python3 install.py
```

It runs five phases with a live log (also saved to `install.log`):

1. **Preflight** — checks OS, Python, Node/npm, and `.env`.
2. **Backend** — creates the Python venv and installs `requirements.txt`.
3. **Frontend** — `npm install` in `Actmon_V1`.
4. **Database** — creates the DB, applies the schema, seeds the app config
   (permissions, modules, all pages), creates **organization #1** and the
   **Super Admin** role, and grants that role full access to every page.
5. **Summary** — prints everything created.

Re-running is safe — every phase is idempotent.

Useful flags: `--db-only`, `--skip-deps`, `--skip-frontend`, `--skip-db`.

## 3. Start the app

```bash
# backend  (from Backend/database)
venv/bin/python -m uvicorn main:app --host 0.0.0.0 --port 8000        # Windows: venv\Scripts\python ...
# frontend (from Actmon_V1)
npm run dev
```

## 4. First-run wizard
Open **http://localhost:3000**. Because no admin exists yet, you're taken to the
**setup wizard**: enter the administrator's details (name + **email are required** —
you can't advance without them), choose a username + password, and click
**Create Super Admin**. That creates the employee **and** the user, assigns the
Super Admin role, and unlocks the app. From then on the wizard never appears again.

## Note on login OTP
Sign-in uses a one-time code emailed to the user, so **SMTP must be configured** in
`.env` (`SMTP_*`) for the admin to receive their code. If you can't set up SMTP yet,
ask for the console-OTP / first-login option to be enabled.
