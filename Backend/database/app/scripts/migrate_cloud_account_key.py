"""
One-shot, idempotent re-key migration for `cloud_accounts.credentials_enc`
(Backend/cloud's AWS/Azure/OCI account credentials).

Backend/cloud is a separately-deployed FastAPI service with its own venv and
its own top-level `app` package (name-collides with Backend/database's `app`,
so it can't directly import `credential_encryption_service` — same reason it
carries its own small `app/utils/encryption.py`). Before this change, that
module derived its Fernet key from a SEPARATE `FERNET_KEY` env var that it
would silently auto-generate AND PRINT TO STDOUT if missing — the exact
ephemeral-key-with-no-recovery anti-pattern this whole task forbids. Going
forward it derives its key from THIS APP'S `ACTMON_ENCRYPTION_KEY` (same value,
same derivation `Fernet(base64.urlsafe_b64encode(raw_32_byte_key))` this
service's own legacy-Fernet bridge already uses) — ONE master key for the
whole application, not two.

That cutover only works if every EXISTING `cloud_accounts` row is re-encrypted
under the new key first — otherwise every stored AWS/Azure/OCI account
becomes permanently undecryptable the moment the code switches key source.
This script does that: for each row, if it already decrypts under the NEW
key, skip (idempotent); otherwise decrypt under the OLD `FERNET_KEY` and
re-encrypt under the NEW one.

Run once, BEFORE deploying the updated Backend/cloud/app/utils/encryption.py:

    python -m app.scripts.migrate_cloud_account_key

Never logs a credential value — only counts and row identifiers.
"""
import base64
import json
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from cryptography.fernet import Fernet, InvalidToken
from dotenv import dotenv_values
from sqlalchemy import text

from app.database.connection import SessionLocal

_DB_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
_CLOUD_ENV_PATH = os.path.abspath(os.path.join(_DB_ROOT, "..", "cloud", ".env"))


def _new_key_fernet() -> Fernet:
    raw = os.environ.get("ACTMON_ENCRYPTION_KEY")
    if not raw:
        raise RuntimeError("ACTMON_ENCRYPTION_KEY is not set — cannot re-key cloud_accounts.")
    key = base64.urlsafe_b64decode(raw)
    if len(key) != 32:
        raise RuntimeError("ACTMON_ENCRYPTION_KEY must decode to exactly 32 bytes.")
    return Fernet(base64.urlsafe_b64encode(key))


def _old_key_fernet() -> Fernet | None:
    cloud_env = dotenv_values(_CLOUD_ENV_PATH)
    old_key = cloud_env.get("FERNET_KEY")
    if not old_key:
        return None
    return Fernet(old_key.encode())


def main():
    new_fernet = _new_key_fernet()
    old_fernet = _old_key_fernet()

    db = SessionLocal()
    try:
        rows = db.execute(text("SELECT id, account_name, credentials_enc FROM cloud_accounts")).fetchall()
        touched, already, failed = 0, 0, 0
        for row_id, name, ciphertext in rows:
            try:
                new_fernet.decrypt(ciphertext.encode())
                already += 1
                continue  # already under the new key — idempotent no-op
            except InvalidToken:
                pass

            if old_fernet is None:
                print(f"  SKIP '{name}' ({row_id}): no old FERNET_KEY found in cloud/.env to decrypt it with.")
                failed += 1
                continue
            try:
                plaintext = old_fernet.decrypt(ciphertext.encode())
                json.loads(plaintext)  # sanity: must be the expected JSON blob shape
            except Exception as e:  # noqa: BLE001
                print(f"  SKIP '{name}' ({row_id}): could not decrypt under the old key either ({type(e).__name__}).")
                failed += 1
                continue

            new_ciphertext = new_fernet.encrypt(plaintext).decode()
            db.execute(
                text("UPDATE cloud_accounts SET credentials_enc = :v WHERE id = :id"),
                {"v": new_ciphertext, "id": row_id},
            )
            touched += 1
        db.commit()
        print(f"cloud_accounts: {touched} re-keyed, {already} already on the new key, "
              f"{failed} could not be migrated, {len(rows)} total.")
        if failed:
            print("  Rows that failed to migrate will NOT decrypt once the code cuts over — "
                  "investigate before deploying the new app/utils/encryption.py.")
    finally:
        db.close()


if __name__ == "__main__":
    main()
