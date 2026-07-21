import os
from urllib.parse import quote_plus
from dotenv import load_dotenv
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

load_dotenv()

_raw_url = os.getenv("DATABASE_URL", "")

if not _raw_url:
    _user = os.getenv("DB_USER", "sa")
    _pass = quote_plus(os.getenv("DB_PASS", "Actin@#2931"))
    _host = os.getenv("DB_HOST", "localhost")
    _port = os.getenv("DB_PORT", "5432")
    _name = os.getenv("DB_NAME", "actmon")
    DATABASE_URL = f"postgresql://{_user}:{_pass}@{_host}:{_port}/{_name}"
else:
    DATABASE_URL = _raw_url

# Pool sized to stay well under PostgreSQL's default max_connections (100):
# each worker process holds at most pool_size + max_overflow connections, so with
# 2 uvicorn workers + the cloud service this caps total usage safely. Tunable via env.
# pool_recycle drops connections idle >30 min so stale/leaked ones don't accumulate.
engine = create_engine(
    DATABASE_URL,
    pool_pre_ping=True,
    pool_size=int(os.getenv("DB_POOL_SIZE", "5")),
    max_overflow=int(os.getenv("DB_MAX_OVERFLOW", "10")),
    pool_recycle=int(os.getenv("DB_POOL_RECYCLE", "1800")),
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
