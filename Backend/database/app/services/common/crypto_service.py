"""
DEPRECATED — kept only so `cosmosdb_service.py`, `smtp_config_routes.py`, and
`channel_config_service.py` keep working unchanged. New code must use
`app.services.common.credential_encryption_service.credential_encryption`
directly; this module is a thin delegator to that ONE centralized service,
not a second encryption implementation.

`encrypt_secret`/`decrypt_secret` used to be Fernet-backed with a
silently-generated ephemeral key when `ACTMON_ENCRYPTION_KEY` was unset — that
fallback is gone. A missing/malformed key now fails fast (see
`credential_encryption_service.CredentialEncryptionKeyError`) instead of
encrypting with a throwaway key that makes data unrecoverable after a
restart. Values already encrypted with the old Fernet path keep decrypting
transparently (`credential_encryption.decrypt()` recognizes both formats).
"""
from app.services.common.credential_encryption_service import credential_encryption


def encrypt_secret(plaintext: str | None) -> str | None:
    return credential_encryption.encrypt(plaintext)


def decrypt_secret(ciphertext: str | None) -> str | None:
    return credential_encryption.decrypt(ciphertext)
