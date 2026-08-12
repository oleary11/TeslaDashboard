import os
import secrets
from pathlib import Path
from datetime import datetime, timezone, timedelta
from jose import jwt, JWTError
from passlib.context import CryptContext

def _load_secret() -> str:
    configured = os.environ.get("JWT_SECRET", "").strip()
    if configured:
        if len(configured) < 32:
            raise RuntimeError("JWT_SECRET must be at least 32 characters")
        return configured
    secret_path = Path("/data/jwt_secret")
    if secret_path.exists():
        return secret_path.read_text().strip()
    secret_path.parent.mkdir(parents=True, exist_ok=True)
    generated = secrets.token_urlsafe(48)
    secret_path.write_text(generated)
    secret_path.chmod(0o600)
    return generated


SECRET_KEY = _load_secret()
ALGORITHM = "HS256"
EXPIRE_DAYS = 30

_pwd = CryptContext(schemes=["bcrypt"], deprecated="auto", bcrypt__rounds=12)


def hash_password(password: str) -> str:
    return _pwd.hash(password)


def verify_password(password: str, hashed: str) -> bool:
    return _pwd.verify(password, hashed)


def create_token(user_id: int) -> str:
    exp = datetime.now(timezone.utc) + timedelta(days=EXPIRE_DAYS)
    return jwt.encode({"sub": str(user_id), "exp": exp}, SECRET_KEY, algorithm=ALGORITHM)


def decode_token(token: str) -> int | None:
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        sub = payload.get("sub")
        return int(sub) if sub is not None else None
    except (JWTError, ValueError):
        return None
