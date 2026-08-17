"""
One-shot, idempotent migration: encrypts every plaintext credential column
this task retrofitted, and backfills the new bearer-token hash columns.

Run once, after applying migrations/2026-08-16_credential_encryption_columns.sql:

    python -m app.scripts.migrate_credentials_to_encrypted

Uses raw SQL (not the ORM) deliberately — reading through `EncryptedString`
would transparently decrypt an already-migrated row back to plaintext,
making an `is_encrypted()` check against the ORM value always look
"unmigrated" and re-encrypt (with a fresh nonce) on every run. Reading the
column's TRUE stored value directly is what makes a second run genuinely a
no-op — the idempotency this script (and requirement 3) requires.

Never logs a credential value — only counts and row identifiers.
"""
import os
import re
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from sqlalchemy import text

from app.database.connection import SessionLocal
from app.services.common.credential_encryption_service import credential_encryption

_HEX64_RE = re.compile(r"^[0-9a-f]{64}$")


def _encrypt_column(db, table: str, id_col: str, value_col: str, label: str):
    rows = db.execute(text(f"SELECT {id_col}, {value_col} FROM {table}")).fetchall()
    touched = 0
    for row_id, value in rows:
        if value and not credential_encryption.is_encrypted(value):
            db.execute(
                text(f"UPDATE {table} SET {value_col} = :v WHERE {id_col} = :id"),
                {"v": credential_encryption.encrypt(value), "id": row_id},
            )
            touched += 1
    db.commit()
    print(f"  {label}: {touched}/{len(rows)} row(s) encrypted (rest already encrypted or empty)")


def _hash_in_place(db, table: str, id_col: str, col: str, label: str):
    """For a column that stores its OWN hash (no separate *_hash column) —
    `user_session.session_token` — hash any value that isn't already a
    64-hex-char SHA-256 digest in place. `secrets.token_urlsafe(32)` always
    produces a 43-char value, never 64 hex chars, so length+charset alone is
    an unambiguous "already migrated" gate — same idempotency guarantee as
    `is_encrypted()` gives the encrypted columns above."""
    rows = db.execute(text(f"SELECT {id_col}, {col} FROM {table}")).fetchall()
    touched = 0
    for row_id, value in rows:
        if value and not _HEX64_RE.match(value):
            db.execute(
                text(f"UPDATE {table} SET {col} = :h WHERE {id_col} = :id"),
                {"h": credential_encryption.hash_token(value), "id": row_id},
            )
            touched += 1
    db.commit()
    print(f"  {label}: {touched}/{len(rows)} row(s) hashed (rest already hashed or empty)")


def _hash_column(db, table: str, id_col: str, plain_col: str, hash_col: str, label: str):
    rows = db.execute(text(f"SELECT {id_col}, {plain_col}, {hash_col} FROM {table}")).fetchall()
    touched = 0
    for row_id, token, existing_hash in rows:
        if token and not existing_hash:
            db.execute(
                text(f"UPDATE {table} SET {hash_col} = :h WHERE {id_col} = :id"),
                {"h": credential_encryption.hash_token(token), "id": row_id},
            )
            touched += 1
    db.commit()
    print(f"  {label}: {touched}/{len(rows)} row(s) hashed (rest already hashed or empty)")


def _consolidate_smtp_password_enc(db):
    """`smtp_configs` has two password columns from two different eras:
    `smtp_password` (this app's original column, retrofitted to
    `EncryptedString` — still holds real ciphertext for any row saved before
    `smtp_password_enc` existed) and `smtp_password_enc` (what
    `smtp_config_routes.py` has written exclusively since, via the same
    centralized service through `crypto_service.encrypt_secret`). A row with
    only the legacy column populated is NOT obsolete data — `resolve_password`
    (`email_channel_service.py`/`smtp_config_routes.py`) falls back to it —
    so this migrates it FORWARD onto the column the app actually writes to,
    rather than leaving it stranded on a column new code no longer touches."""
    rows = db.execute(text(
        "SELECT id, smtp_password FROM smtp_configs "
        "WHERE smtp_password IS NOT NULL AND smtp_password_enc IS NULL"
    )).fetchall()
    touched = 0
    for row_id, ciphertext in rows:
        plaintext = credential_encryption.decrypt(ciphertext) if credential_encryption.is_encrypted(ciphertext) else ciphertext
        db.execute(
            text("UPDATE smtp_configs SET smtp_password_enc = :enc, smtp_password = NULL WHERE id = :id"),
            {"enc": credential_encryption.encrypt(plaintext), "id": row_id},
        )
        touched += 1
    db.commit()
    print(f"  smtp_configs: {touched}/{len(rows)} row(s) consolidated onto smtp_password_enc (rest already consolidated or empty)")


def main():
    db = SessionLocal()
    try:
        print("Encrypting plaintext credential columns...")
        _encrypt_column(db, "connection_master", "id", "password", "connection_master.password")
        _encrypt_column(db, "connection_master", "id", "ssh_password", "connection_master.ssh_password")
        _encrypt_column(db, "os_servers", "id", "ssh_password", "os_servers.ssh_password")
        _encrypt_column(db, "agent_db_targets", "id", "password", "agent_db_targets.password")
        _encrypt_column(db, "connection_master", "id", "tns_descriptor", "connection_master.tns_descriptor")
        _encrypt_column(db, "connection_master", "id", "oracle_connect_string", "connection_master.oracle_connect_string")
        _encrypt_column(db, "connection_master", "id", "connection_uri", "connection_master.connection_uri")
        _encrypt_column(db, "smtp_configs", "id", "smtp_password", "smtp_configs.smtp_password")
        _encrypt_column(db, "postgres_report_schedules", "id", "smtp_password", "postgres_report_schedules.smtp_password")
        _encrypt_column(db, "mysql_report_schedules", "id", "smtp_password", "mysql_report_schedules.smtp_password")
        _encrypt_column(db, "mssql_report_schedules", "id", "smtp_password", "mssql_report_schedules.smtp_password")
        _encrypt_column(db, "oracle_report_schedules", "id", "smtp_password", "oracle_report_schedules.smtp_password")

        print("Backfilling bearer-token hash columns...")
        _hash_column(db, "agent_tokens", "id", "token", "token_hash", "agent_tokens")
        _hash_column(db, "os_servers", "id", "agent_token", "agent_token_hash", "os_servers")
        _hash_column(db, "agent_db_targets", "id", "token", "token_hash", "agent_db_targets")

        print("Hashing session tokens in place...")
        _hash_in_place(db, "user_session", "session_id", "session_token", "user_session.session_token")

        print("Consolidating legacy SMTP password column...")
        _consolidate_smtp_password_enc(db)

        print("Done.")
    finally:
        db.close()


if __name__ == "__main__":
    main()
