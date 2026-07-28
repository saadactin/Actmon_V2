"""
Symmetric encryption for cloud database secrets (Azure Cosmos DB primary/secondary
keys and future cloud provider credentials) — these are master account keys, far
more sensitive than a scoped DB user/password, so unlike the rest of this app's
plaintext connection passwords, they're encrypted at rest.

Configure via ACTMON_ENCRYPTION_KEY in .env (generate with:
`python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`).
If absent, an ephemeral key is generated and a warning logged — fine for local dev,
but anything encrypted with it becomes unreadable after a restart, so production
deployments must set a persistent key.
"""
import os
from cryptography.fernet import Fernet

_fernet = None


def _get_or_create_key() -> bytes:
    key = os.environ.get("ACTMON_ENCRYPTION_KEY")
    if key:
        return key.encode()
    generated = Fernet.generate_key()
    print(
        "[actmon] WARNING: ACTMON_ENCRYPTION_KEY not set — generated an ephemeral key. "
        "Cloud database secrets encrypted with it will be unreadable after this process restarts. "
        f"Add to .env: ACTMON_ENCRYPTION_KEY={generated.decode()}"
    )
    os.environ["ACTMON_ENCRYPTION_KEY"] = generated.decode()
    return generated


def _cipher() -> Fernet:
    global _fernet
    if _fernet is None:
        _fernet = Fernet(_get_or_create_key())
    return _fernet


def encrypt_secret(plaintext: str) -> str | None:
    if not plaintext:
        return None
    return _cipher().encrypt(plaintext.encode()).decode()


def decrypt_secret(ciphertext: str) -> str | None:
    if not ciphertext:
        return None
    return _cipher().decrypt(ciphertext.encode()).decode()
