import os
import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel
import jwt

router = APIRouter(prefix="/api/v1/auth", tags=["Auth"])

SECRET_KEY = os.getenv("JWT_SECRET", "actmon-secret-key-change-in-production")
ALGORITHM = "HS256"
TOKEN_EXPIRE_HOURS = 24

# Default credentials — override via env
ADMIN_USERNAME = os.getenv("ADMIN_USERNAME", "admin")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "admin123")

USERS = {
    ADMIN_USERNAME: {"password": ADMIN_PASSWORD, "role": "Admin", "email": f"{ADMIN_USERNAME}@actmon.local"},
    "user":  {"password": "user123",  "role": "Viewer", "email": "user@actmon.local"},
}

bearer_scheme = HTTPBearer(auto_error=False)


class LoginRequest(BaseModel):
    username: str
    password: str


def _make_token(username: str, role: str) -> str:
    exp = datetime.datetime.utcnow() + datetime.timedelta(hours=TOKEN_EXPIRE_HOURS)
    payload = {"sub": username, "role": role, "exp": exp}
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def _decode_token(token: str) -> dict:
    try:
        return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")


@router.post("/login")
def login(req: LoginRequest):
    user = USERS.get(req.username)
    if not user or user["password"] != req.password:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password",
        )
    token = _make_token(req.username, user["role"])
    return {
        "access_token": token,
        "token_type": "bearer",
        "username": req.username,
        "role": user["role"],
        "email": user["email"],
    }


@router.get("/me")
def get_me(credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme)):
    # BYPASS AUTH in development mode
    if os.getenv("BYPASS_AUTH") == "true":
        return {
            "id": 1,
            "username": "admin",
            "email": "admin@actmon.local",
            "role": "Admin",
            "is_active": True,
            "is_superuser": True,
        }

    if not credentials:
        raise HTTPException(status_code=401, detail="Not authenticated")
    payload = _decode_token(credentials.credentials)
    username = payload.get("sub", "user")
    role = payload.get("role", "Viewer")
    user = USERS.get(username, {})
    return {
        "id": 1,
        "username": username,
        "email": user.get("email", f"{username}@actmon.local"),
        "role": role,
        "is_active": True,
        "is_superuser": role == "Admin",
    }
