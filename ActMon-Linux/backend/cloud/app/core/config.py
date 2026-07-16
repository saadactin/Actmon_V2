from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv

# Load .env from this service's directory
_ENV_PATH = Path(__file__).resolve().parent.parent.parent / ".env"
load_dotenv(dotenv_path=_ENV_PATH, override=True)


class Settings:
    """All configuration loaded from environment variables."""

    # ── Database ──────────────────────────────────────────────
    DATABASE_URL: str = os.getenv("DATABASE_URL", "")
    DB_USER: str = os.getenv("DB_USER", "migration_user")
    DB_PASS: str = os.getenv("DB_PASS", "StrongPassword123")
    DB_HOST: str = os.getenv("DB_HOST", "localhost")
    DB_PORT: str = os.getenv("DB_PORT", "5432")
    DB_NAME: str = os.getenv("DB_NAME", "actmon")

    # ── JWT ───────────────────────────────────────────────────
    JWT_SECRET: str = os.getenv("JWT_SECRET", "actmon-secret-key-change-in-production")
    JWT_ALGORITHM: str = "HS256"
    JWT_EXPIRE_MINUTES: int = 60 * 24  # 24 h

    # ── Admin ─────────────────────────────────────────────────
    ADMIN_USERNAME: str = os.getenv("ADMIN_USERNAME", "admin")
    ADMIN_PASSWORD: str = os.getenv("ADMIN_PASSWORD", "admin123")

    # ── Encryption ───────────────────────────────────────────────────────────
    FERNET_KEY: str = os.getenv("FERNET_KEY", "")

    # ── Service ───────────────────────────────────────────────
    CLOUD_SERVICE_PORT: int = int(os.getenv("CLOUD_SERVICE_PORT", "8001"))
    DEBUG: bool = os.getenv("DEBUG", "false").lower() == "true"

    @property
    def async_database_url(self) -> str:
        """Return an asyncpg-compatible URL, constructing it from parts if needed."""
        if self.DATABASE_URL:
            url = self.DATABASE_URL
            # Ensure asyncpg driver
            if url.startswith("postgresql://"):
                url = url.replace("postgresql://", "postgresql+asyncpg://", 1)
            elif url.startswith("postgres://"):
                url = url.replace("postgres://", "postgresql+asyncpg://", 1)
            return url
        return (
            f"postgresql+asyncpg://{self.DB_USER}:{self.DB_PASS}"
            f"@{self.DB_HOST}:{self.DB_PORT}/{self.DB_NAME}"
        )

    @property
    def sync_database_url(self) -> str:
        """Return a psycopg2-compatible URL for Alembic / sync ops."""
        if self.DATABASE_URL:
            url = self.DATABASE_URL
            if "asyncpg" in url:
                url = url.replace("+asyncpg", "")
            return url
        return (
            f"postgresql+psycopg2://{self.DB_USER}:{self.DB_PASS}"
            f"@{self.DB_HOST}:{self.DB_PORT}/{self.DB_NAME}"
        )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
