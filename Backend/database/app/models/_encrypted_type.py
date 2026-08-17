"""
`EncryptedString` — a SQLAlchemy `TypeDecorator` that makes a column
transparently encrypted at rest, via the ONE centralized
`CredentialEncryptionService` (never a second encryption implementation).

Every existing read site (`conn.password`, `rec.ssh_password`, ...) keeps
working completely unchanged: `process_bind_param` encrypts on the way into
the database, `process_result_value` decrypts on the way out. A row that
hasn't been migrated yet (still holds the old plaintext value) degrades
gracefully — `process_result_value` returns it as-is rather than raising —
so the cutover doesn't require a hard, all-at-once data migration before the
column type change ships; the migration script (see
`app/scripts/migrate_credentials_to_encrypted.py`) then re-saves every row
through the ORM to actually encrypt it.

Bypasses this doesn't cover: raw `text()` SQL that selects the column
directly (confirmed only one such site in this app,
`service_state_service._ssh_host_for_conn`, fixed separately to go through
the ORM instead) gets the raw stored bytes back with no Python-side
conversion — this is a SQLAlchemy-wide limitation of `TypeDecorator`, not
specific to this implementation.

    password = Column(EncryptedString)
"""
from sqlalchemy.types import TypeDecorator, Text

from app.services.common.credential_encryption_service import credential_encryption


class EncryptedString(TypeDecorator):
    impl = Text
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if not value:
            return value
        if credential_encryption.is_encrypted(value):
            # Already ciphertext (e.g. a value round-tripped from a read
            # without modification) — never double-encrypt.
            return value
        return credential_encryption.encrypt(value)

    def process_result_value(self, value, dialect):
        if not value:
            return value
        if not credential_encryption.is_encrypted(value):
            # Not yet migrated — a legacy plaintext row. Return as-is so
            # existing connections keep working until the migration script
            # (or the next save) encrypts it, rather than raising here.
            return value
        return credential_encryption.decrypt(value)
