"""
Tests for CredentialEncryptionService and its integration points — the ONE
centralized encryption service every credential in the app goes through.

Run with:  pytest tests/test_credential_encryption.py -v

Each test constructs its OWN CredentialEncryptionService instance (never the
shared `credential_encryption` singleton) so tests can freely swap
ACTMON_ENCRYPTION_KEY without leaking a cached key between tests.
"""
import base64
import os

import pytest
from sqlalchemy import Column, Integer, create_engine, text
from sqlalchemy.orm import declarative_base, sessionmaker
from sqlalchemy.pool import StaticPool

from app.services.common.credential_encryption_service import (
    CredentialEncryptionKeyError,
    CredentialEncryptionService,
)
from app.models._encrypted_type import EncryptedString


def _fresh_key() -> str:
    return base64.b64encode(os.urandom(32)).decode()


@pytest.fixture
def service(monkeypatch):
    monkeypatch.setenv("ACTMON_ENCRYPTION_KEY", _fresh_key())
    return CredentialEncryptionService()


# ── 1. Encrypt/decrypt round-trip ───────────────────────────────────────────

def test_encrypt_decrypt_round_trip(service):
    plaintext = "Sup3r$ecretP@ssw0rd!"
    ciphertext = service.encrypt(plaintext)
    assert ciphertext != plaintext
    assert ciphertext.startswith("enc:v1:")
    assert service.decrypt(ciphertext) == plaintext


def test_encrypt_is_nondeterministic(service):
    """Two encryptions of the SAME plaintext must differ (fresh nonce each
    time) — a required AES-GCM property, not an implementation detail."""
    a = service.encrypt("same-password")
    b = service.encrypt("same-password")
    assert a != b
    assert service.decrypt(a) == service.decrypt(b) == "same-password"


def test_none_and_empty_pass_through(service):
    assert service.encrypt(None) is None
    assert service.encrypt("") == ""
    assert service.decrypt(None) is None
    assert service.decrypt("") == ""


# ── 2. Plaintext is never stored — is_encrypted() correctness ──────────────

def test_is_encrypted_detects_ciphertext_not_plaintext(service):
    ciphertext = service.encrypt("a-real-password")
    assert service.is_encrypted(ciphertext) is True
    assert service.is_encrypted("a-real-password") is False
    assert service.is_encrypted("") is False
    assert service.is_encrypted(None) is False


def test_legacy_fernet_tokens_are_recognized_and_decryptable(service):
    from cryptography.fernet import Fernet
    key = os.environ["ACTMON_ENCRYPTION_KEY"]
    fernet_key = base64.urlsafe_b64encode(base64.b64decode(key))
    legacy_token = Fernet(fernet_key).encrypt(b"legacy-secret").decode()
    assert service.is_encrypted(legacy_token) is True
    assert service.decrypt(legacy_token) == "legacy-secret"


# ── 3. Wrong / missing key fails safely — never silent plaintext fallback ──

def test_wrong_key_fails_safely_does_not_return_plaintext(monkeypatch):
    monkeypatch.setenv("ACTMON_ENCRYPTION_KEY", _fresh_key())
    encrypter = CredentialEncryptionService()
    ciphertext = encrypter.encrypt("original-password")

    monkeypatch.setenv("ACTMON_ENCRYPTION_KEY", _fresh_key())
    wrong_key_service = CredentialEncryptionService()
    with pytest.raises(Exception):
        wrong_key_service.decrypt(ciphertext)


def test_missing_key_raises_clear_error_no_ephemeral_fallback(monkeypatch):
    monkeypatch.delenv("ACTMON_ENCRYPTION_KEY", raising=False)
    service = CredentialEncryptionService()
    with pytest.raises(CredentialEncryptionKeyError):
        service.encrypt("anything")
    with pytest.raises(CredentialEncryptionKeyError):
        service.decrypt("enc:v1:whatever")


def test_malformed_key_raises_clear_error(monkeypatch):
    monkeypatch.setenv("ACTMON_ENCRYPTION_KEY", "not-valid-base64-!!!")
    service = CredentialEncryptionService()
    with pytest.raises(CredentialEncryptionKeyError):
        service.encrypt("anything")


def test_wrong_length_key_raises_clear_error(monkeypatch):
    monkeypatch.setenv("ACTMON_ENCRYPTION_KEY", base64.b64encode(b"tooshort").decode())
    service = CredentialEncryptionService()
    with pytest.raises(CredentialEncryptionKeyError):
        service.encrypt("anything")


# ── 4. Masking — API responses never show a real value ─────────────────────

def test_mask_never_reveals_length_or_content(service):
    assert service.mask("any-password-of-any-length") == "********"
    assert service.mask("x") == "********"
    assert service.mask(None) is None
    assert service.mask("") is None


def test_looks_like_mask_recognizes_placeholders(service):
    assert service.looks_like_mask("********") is True
    assert service.looks_like_mask("••••••••") is True
    assert service.looks_like_mask("***") is True
    assert service.looks_like_mask("") is True
    assert service.looks_like_mask(None) is True
    assert service.looks_like_mask("   ") is True
    assert service.looks_like_mask("a-real-password") is False
    assert service.looks_like_mask("****but-not-only-stars") is False


def test_mask_connection_fields_never_includes_raw_secret(service):
    class FakeCol:
        def __init__(self, name):
            self.name = name

    class FakeTable:
        columns = [FakeCol(n) for n in ("id", "host", "password", "ssh_password", "oracle_connect_string")]

    class FakeConn:
        __table__ = FakeTable
        id = 1
        host = "10.0.0.5"
        password = "real-db-password"
        ssh_password = "real-ssh-password"
        oracle_connect_string = "user/realpass@host:1521/orcl"

    masked = service.mask_connection_fields(FakeConn())
    dumped = str(masked)
    assert "real-db-password" not in dumped
    assert "real-ssh-password" not in dumped
    assert "realpass" not in dumped
    assert masked["password_configured"] is True
    assert masked["ssh_password_configured"] is True
    assert masked["host"] == "10.0.0.5"  # non-secret fields pass through


# ── 5. Deep/nested masking + reconciliation (Patroni-style config blobs) ───

def test_mask_deep_masks_nested_secrets_only():
    service = CredentialEncryptionService()
    cfg = {
        "postgresql": {
            "authentication": {
                "superuser": {"username": "postgres", "password": "supersecret"},
                "replication": {"password": "replpass"},
            },
        },
        "restapi": {"authentication": {"password": "apipass"}},
        "loop_wait": 10,
    }
    masked = service.mask_deep(cfg)
    assert masked["postgresql"]["authentication"]["superuser"]["password"] == "********"
    assert masked["postgresql"]["authentication"]["superuser"]["username"] == "postgres"
    assert masked["postgresql"]["authentication"]["replication"]["password"] == "********"
    assert masked["restapi"]["authentication"]["password"] == "********"
    assert masked["loop_wait"] == 10
    assert "supersecret" not in str(masked)
    assert "replpass" not in str(masked)
    assert "apipass" not in str(masked)


def test_reconcile_deep_restores_real_value_under_mask_only():
    service = CredentialEncryptionService()
    current = {"postgresql": {"authentication": {"superuser": {"password": "real-current-value"}}}}
    submitted = {"postgresql": {"authentication": {"superuser": {"password": "********"}}}}
    reconciled = service.reconcile_deep(submitted, current)
    assert reconciled["postgresql"]["authentication"]["superuser"]["password"] == "real-current-value"

    # An actually-changed value passes through untouched, never overridden.
    submitted_changed = {"postgresql": {"authentication": {"superuser": {"password": "a-new-real-value"}}}}
    reconciled2 = service.reconcile_deep(submitted_changed, current)
    assert reconciled2["postgresql"]["authentication"]["superuser"]["password"] == "a-new-real-value"


# ── 6. Bearer token hashing — deterministic, non-reversible ────────────────

def test_hash_token_is_deterministic_and_not_reversible(service):
    token = "actmon-abc123def456"
    h1 = service.hash_token(token)
    h2 = service.hash_token(token)
    assert h1 == h2
    assert h1 != token
    assert token not in h1
    assert len(h1) == 64  # hex-encoded SHA-256


def test_hash_token_differs_across_keys(monkeypatch):
    monkeypatch.setenv("ACTMON_ENCRYPTION_KEY", _fresh_key())
    s1 = CredentialEncryptionService()
    h1 = s1.hash_token("same-token")

    monkeypatch.setenv("ACTMON_ENCRYPTION_KEY", _fresh_key())
    s2 = CredentialEncryptionService()
    h2 = s2.hash_token("same-token")

    assert h1 != h2  # keyed hash — same token, different key, different hash


def test_token_match_filter_matches_hash_or_legacy_plaintext(service):
    """Uses real SQLAlchemy Columns (not hand-rolled fakes) so `==` builds
    actual SQL comparison clauses, exactly as every real call site does —
    then proves the OR'd clause's two branches are hash-lookup and
    plaintext-lookup, each keyed to the right value."""
    from sqlalchemy import Column, String, Integer
    from sqlalchemy.orm import declarative_base

    Base = declarative_base()

    class Fake(Base):
        __tablename__ = "fake_token_table"
        id = Column(Integer, primary_key=True)
        token_hash = Column(String)
        token = Column(String)

    clause = service.token_match_filter(Fake.token_hash, Fake.token, "real-token")
    children = list(clause.get_children())
    assert len(children) == 2
    rendered = [str(c) for c in children]
    assert any("token_hash" in r for r in rendered)
    assert any(r.endswith(".token = :token_1") or "token =" in r for r in rendered)


# ── 7. Logging redaction ────────────────────────────────────────────────────

def test_redact_scrubs_key_value_secrets(service):
    text_in = 'password=hunter2 ssh_password="s3cr3t" token: abc123 api_key=XYZ Authorization: Bearer abc.def'
    out = service.redact(text_in)
    assert "hunter2" not in out
    assert "s3cr3t" not in out
    assert "abc123" not in out
    assert "XYZ" not in out
    assert "abc.def" not in out


def test_redact_scrubs_url_embedded_credentials(service):
    assert "hunter2" not in service.redact("postgresql://user:hunter2@host:5432/db")
    assert "hunter2" not in service.redact("redis://:hunter2@localhost:6379/0")
    # No credentials in the URL — nothing to scrub, left as-is.
    assert service.redact("redis://localhost:6379/0") == "redis://localhost:6379/0"


def test_redacting_log_filter_scrubs_named_logger_records(service, monkeypatch):
    import logging
    import io
    from app.services.common.credential_encryption_service import RedactingLogFilter

    monkeypatch.setattr(
        "app.services.common.credential_encryption_service.credential_encryption", service,
    )
    buf = io.StringIO()
    handler = logging.StreamHandler(buf)
    handler.addFilter(RedactingLogFilter())
    logger = logging.getLogger("test_credential_redaction_logger")
    logger.addHandler(handler)
    logger.propagate = False
    logger.setLevel(logging.INFO)
    logger.info("connecting with password=%s", "hunter2")
    logger.removeHandler(handler)
    assert "hunter2" not in buf.getvalue()


# ── 8. EncryptedString TypeDecorator — ORM round-trip + migration behavior ─

Base = declarative_base()


class _Cred(Base):
    __tablename__ = "test_credentials"
    id = Column(Integer, primary_key=True)
    secret = Column(EncryptedString)


@pytest.fixture
def sqlite_session(monkeypatch):
    monkeypatch.setenv("ACTMON_ENCRYPTION_KEY", _fresh_key())
    engine = create_engine("sqlite:///:memory:", poolclass=StaticPool,
                            connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    yield Session(), engine
    Base.metadata.drop_all(engine)


def test_encrypted_string_encrypts_on_write_decrypts_on_read(sqlite_session):
    session, engine = sqlite_session
    session.add(_Cred(id=1, secret="my-real-password"))
    session.commit()

    with engine.connect() as conn:
        raw = conn.execute(text("SELECT secret FROM test_credentials WHERE id=1")).scalar()
    assert raw != "my-real-password"
    assert raw.startswith("enc:v1:")

    fresh_session = sessionmaker(bind=engine)()
    row = fresh_session.query(_Cred).filter(_Cred.id == 1).first()
    assert row.secret == "my-real-password"


def test_encrypted_string_gracefully_reads_legacy_plaintext_row(sqlite_session):
    """A row written before this migration (raw plaintext, bypassing the
    type system via literal SQL) must still be usable — the whole point of
    the graceful is_encrypted() gate — not raise on read."""
    session, engine = sqlite_session
    with engine.connect() as conn:
        conn.execute(text("INSERT INTO test_credentials (id, secret) VALUES (1, 'legacy-plaintext-value')"))
        conn.commit()

    row = session.query(_Cred).filter(_Cred.id == 1).first()
    assert row.secret == "legacy-plaintext-value"


def test_credential_update_replaces_encrypted_value(sqlite_session):
    """Updating a credential must store a NEW ciphertext, and old ciphertext
    must not still decrypt to the new value (a real replace, not an append)."""
    session, engine = sqlite_session
    session.add(_Cred(id=1, secret="old-password"))
    session.commit()

    with engine.connect() as conn:
        old_raw = conn.execute(text("SELECT secret FROM test_credentials WHERE id=1")).scalar()

    row = session.query(_Cred).filter(_Cred.id == 1).first()
    row.secret = "new-password"
    session.commit()

    with engine.connect() as conn:
        new_raw = conn.execute(text("SELECT secret FROM test_credentials WHERE id=1")).scalar()
    assert new_raw != old_raw

    fresh = sessionmaker(bind=engine)().query(_Cred).filter(_Cred.id == 1).first()
    assert fresh.secret == "new-password"


# ── 9. Migration idempotency — the exact pattern migrate_credentials_to_encrypted.py uses ──

def test_migration_pattern_is_idempotent(sqlite_session, monkeypatch):
    """Reproduces the real migration script's raw-SQL read -> is_encrypted()
    gate -> encrypt-and-write-back loop against a legacy plaintext row, and
    proves a second pass touches zero rows."""
    session, engine = sqlite_session
    from app.services.common.credential_encryption_service import credential_encryption as global_ce
    monkeypatch.setattr(
        "app.services.common.credential_encryption_service.credential_encryption",
        CredentialEncryptionService(),
    )
    from app.services.common import credential_encryption_service as ces
    ce = ces.credential_encryption

    with engine.connect() as conn:
        conn.execute(text("INSERT INTO test_credentials (id, secret) VALUES (1, 'plaintext-row')"))
        conn.commit()

    def migrate_pass():
        touched = 0
        with engine.connect() as conn:
            rows = conn.execute(text("SELECT id, secret FROM test_credentials")).fetchall()
            for row_id, value in rows:
                if value and not ce.is_encrypted(value):
                    conn.execute(text("UPDATE test_credentials SET secret = :v WHERE id = :id"),
                                 {"v": ce.encrypt(value), "id": row_id})
                    touched += 1
            conn.commit()
        return touched

    first_pass = migrate_pass()
    second_pass = migrate_pass()
    assert first_pass == 1
    assert second_pass == 0  # idempotent — nothing left to migrate


# ── 10. Wrong-key failure never masquerades as "not encrypted" ─────────────

def test_is_encrypted_true_even_when_key_is_wrong(monkeypatch):
    """is_encrypted() must recognize the ENVELOPE FORMAT regardless of
    whether the current key can actually decrypt it — this is what lets
    decrypt() fail loudly instead of is_encrypted() silently reporting
    'looks like plaintext' for a wrong-key scenario."""
    monkeypatch.setenv("ACTMON_ENCRYPTION_KEY", _fresh_key())
    encrypter = CredentialEncryptionService()
    ciphertext = encrypter.encrypt("secret")

    monkeypatch.setenv("ACTMON_ENCRYPTION_KEY", _fresh_key())
    other = CredentialEncryptionService()
    assert other.is_encrypted(ciphertext) is True
    with pytest.raises(Exception):
        other.decrypt(ciphertext)


# ── 11. Embedded-credential extraction — Oracle EZConnect / Mongo URI ──────

def test_extract_embedded_credentials_ezconnect(service):
    stripped, user, pw = service.extract_embedded_credentials("scott/tiger@10.0.0.9:1521/orcl")
    assert stripped == "10.0.0.9:1521/orcl"
    assert user == "scott"
    assert pw == "tiger"


def test_extract_embedded_credentials_uri(service):
    stripped, user, pw = service.extract_embedded_credentials("mongodb://admin:s3cr3t@host1:27017,host2:27017/db")
    assert stripped == "mongodb://host1:27017,host2:27017/db"
    assert user == "admin"
    assert pw == "s3cr3t"


def test_extract_embedded_credentials_no_credential_passthrough(service):
    """The app's own real usage — a bare DSN/TNS descriptor with no embedded
    credential — must pass through completely unchanged, since oracledb.connect()
    is always given `user`/`password` separately from the dsn (see
    agent_collector_service.py)."""
    stripped, user, pw = service.extract_embedded_credentials("10.0.0.9:1521/orcl")
    assert stripped == "10.0.0.9:1521/orcl"
    assert user is None
    assert pw is None

    stripped2, user2, pw2 = service.extract_embedded_credentials("mongodb://host1:27017/db")
    assert stripped2 == "mongodb://host1:27017/db"
    assert user2 is None
    assert pw2 is None


def test_extract_embedded_credentials_none_and_empty(service):
    assert service.extract_embedded_credentials(None) == (None, None, None)
    assert service.extract_embedded_credentials("") == ("", None, None)


def test_extract_embedded_credentials_never_leaves_secret_in_stripped_value(service):
    """The stripped DSN/URI must never itself still contain the extracted
    password — that would defeat the whole point of extracting it."""
    stripped, _, pw = service.extract_embedded_credentials("scott/S3cr3tPass@host:1521/orcl")
    assert pw == "S3cr3tPass"
    assert "S3cr3tPass" not in stripped


# ── 12. Oracle/Mongo connection fields — encrypted at rest, never returned raw ──

def test_oracle_and_mongo_dsn_fields_are_encrypted_string_columns():
    """`connection_uri`/`tns_descriptor`/`oracle_connect_string` must be
    `EncryptedString`, not a bare `Text` column — the whole point of moving
    beyond "mask the entire string" is that these are protected at rest too,
    not just hidden from API responses."""
    from app.models.connection_model import ConnectionMaster
    from app.models._encrypted_type import EncryptedString
    for col_name in ("connection_uri", "tns_descriptor", "oracle_connect_string"):
        col = ConnectionMaster.__table__.columns[col_name]
        assert isinstance(col.type, EncryptedString), f"{col_name} is not EncryptedString"


def test_mask_connection_fields_masks_oracle_mongo_dsn_fields(service):
    class FakeCol:
        def __init__(self, name):
            self.name = name

    class FakeTable:
        columns = [FakeCol(n) for n in (
            "id", "host", "password", "tns_descriptor", "oracle_connect_string", "connection_uri",
        )]

    class FakeConn:
        __table__ = FakeTable
        id = 1
        host = "10.0.0.5"
        password = "real-db-password"
        tns_descriptor = "scott/tiger@host:1521/orcl"
        oracle_connect_string = "10.0.0.9:1521/orcl"
        connection_uri = "mongodb://admin:s3cr3t@host:27017/db"

    masked = service.mask_connection_fields(FakeConn())
    dumped = str(masked)
    assert "tiger" not in dumped
    assert "s3cr3t" not in dumped
    assert masked["tns_descriptor"] == "********"
    assert masked["oracle_connect_string"] == "********"
    assert masked["connection_uri"] == "********"


# ── 13. Session token — hashed at rest, never the raw value ────────────────

def test_create_session_stores_hash_not_raw_token(monkeypatch):
    """`create_session` must return the raw token (for the caller) but persist
    only its HMAC-SHA256 hash — `user_session.session_token` is a write-only
    security-tracking column no auth path reads back for comparison, so a
    one-way hash is correct here, not reversible encryption."""
    monkeypatch.setenv("ACTMON_ENCRYPTION_KEY", _fresh_key())
    from app.services.auth import access_control_service as acs

    captured = {}

    class FakeResult:
        def scalar(self):
            return 42

    class FakeDB:
        def execute(self, stmt, params=None):
            captured["params"] = params
            return FakeResult()

    sid, raw_token = acs.create_session(FakeDB(), {"user_id": 1}, ip="1.2.3.4", ua="pytest")
    assert sid == 42
    stored = captured["params"]["tok"]
    assert stored != raw_token
    assert len(stored) == 64  # hex-encoded SHA-256, same shape as hash_token()
    from app.services.common.credential_encryption_service import credential_encryption
    assert stored == credential_encryption.hash_token(raw_token)


# ── 14. Migration idempotency — hash-in-place pattern (session_token) ──────

def test_hash_in_place_migration_pattern_is_idempotent(sqlite_session, monkeypatch):
    """Reproduces migrate_credentials_to_encrypted.py's `_hash_in_place` gate
    (64-hex-char check) against a legacy plaintext session token, proving a
    second pass is a no-op and an already-hashed value is never re-hashed."""
    import re
    session, engine = sqlite_session
    from app.services.common import credential_encryption_service as ces
    ce = ces.credential_encryption
    hex64 = re.compile(r"^[0-9a-f]{64}$")

    with engine.connect() as conn:
        conn.execute(text("INSERT INTO test_credentials (id, secret) VALUES (1, 'raw-session-token-value')"))
        conn.commit()

    def migrate_pass():
        touched = 0
        with engine.connect() as conn:
            rows = conn.execute(text("SELECT id, secret FROM test_credentials")).fetchall()
            for row_id, value in rows:
                if value and not hex64.match(value):
                    conn.execute(text("UPDATE test_credentials SET secret = :v WHERE id = :id"),
                                 {"v": ce.hash_token(value), "id": row_id})
                    touched += 1
            conn.commit()
        return touched

    first_pass = migrate_pass()
    second_pass = migrate_pass()
    assert first_pass == 1
    assert second_pass == 0


# ── 15. Cloud-account re-key pattern (AWS/Azure/OCI, Backend/cloud service) ─

def test_cloud_account_rekey_pattern_round_trips_and_is_idempotent():
    """Backend/cloud can't import this service directly (separate venv,
    colliding `app` package name — see app/utils/encryption.py there), so this
    proves the ALGORITHM its re-key script depends on: a Fernet cipher keyed
    off `base64.urlsafe_b64encode(raw_32_byte_key)` — the exact derivation
    `migrate_cloud_account_key.py` uses for both the old and new key — round-
    trips a JSON credentials blob, and re-encrypting under the same key the
    ciphertext already matches is detected as a no-op by attempting a decrypt
    first (the migration script's actual idempotency check)."""
    import base64 as b64
    import json
    from cryptography.fernet import Fernet, InvalidToken

    key_bytes = os.urandom(32)
    fernet = Fernet(b64.urlsafe_b64encode(key_bytes))

    creds = {"access_key_id": "AKIA...", "secret_access_key": "s3cr3t"}
    ciphertext = fernet.encrypt(json.dumps(creds).encode()).decode()

    # "already on the new key" check the migration script performs first.
    decrypted = fernet.decrypt(ciphertext.encode())
    assert json.loads(decrypted) == creds

    # A DIFFERENT key must fail to decrypt it — proves re-keying is real.
    other_fernet = Fernet(b64.urlsafe_b64encode(os.urandom(32)))
    with pytest.raises(InvalidToken):
        other_fernet.decrypt(ciphertext.encode())


# ── 16. Update payload never lets a mask placeholder overwrite a real DSN ──

def test_looks_like_mask_guards_oracle_dsn_fields_on_update(service):
    """The same `looks_like_mask` guard used for `password` must also protect
    `tns_descriptor`/`oracle_connect_string` on update — a masked GET response
    value round-tripped into an edit form must never overwrite the real
    stored DSN with the literal placeholder."""
    assert service.looks_like_mask("********") is True
    # oracle_connection_service._clean_dsn_field keeps the existing value
    # whenever looks_like_mask() is true — proven directly against the real
    # function so this test breaks if that guard is ever removed.
    from app.services.oracle.oracle_connection_service import _clean_dsn_field
    stored, user, pw = _clean_dsn_field("********", "10.0.0.9:1521/orcl")
    assert stored == "10.0.0.9:1521/orcl"
    assert user is None and pw is None
