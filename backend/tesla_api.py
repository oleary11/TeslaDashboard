import os
import json
import secrets
import hashlib
import base64
import time
import logging
import requests
from pathlib import Path
from urllib.parse import urlencode

from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import serialization
from cryptography.fernet import Fernet

log = logging.getLogger(__name__)

PRIVKEY_PATH = Path("/data/tesla_partner_key.pem")
AUTH_BASE = "https://auth.tesla.com"
FLEET_BASE = "https://fleet-api.prd.na.vn.cloud.tesla.com"
SCOPES = "openid offline_access vehicle_device_data vehicle_location vehicle_cmds"

_pkce_store: dict = {}


def _client_id() -> str:
    return os.environ.get("TESLA_CLIENT_ID", "").strip()


def _client_secret() -> str:
    return os.environ.get("TESLA_CLIENT_SECRET", "").strip()


def _fernet() -> Fernet:
    from auth import SECRET_KEY
    raw = SECRET_KEY.encode()
    key = base64.urlsafe_b64encode(hashlib.sha256(raw).digest())
    return Fernet(key)


def _encrypt(value: str) -> str:
    return _fernet().encrypt(value.encode()).decode()


def _decrypt(value: str) -> str:
    try:
        return _fernet().decrypt(value.encode()).decode()
    except Exception:
        return value


def _creds_for(user_id: int) -> tuple[str, str]:
    tok = _load_token(user_id)
    raw_cid = (tok.get("client_id") or "").strip()
    raw_csec = (tok.get("client_secret") or "").strip()
    if raw_cid:
        return _decrypt(raw_cid), (_decrypt(raw_csec) if raw_csec else "")
    # only the server owner (user 1) falls back to env-level credentials
    if user_id == 1:
        return _client_id(), _client_secret()
    return "", ""


# ── Token DB helpers ─────────────────────────────────────────────────────────

def _load_token(user_id: int) -> dict:
    from db import get_db
    db = get_db()
    row = db.execute("SELECT * FROM tesla_tokens WHERE user_id=?", (user_id,)).fetchone()
    db.close()
    return dict(row) if row else {}


def _save_token(user_id: int, email: str, access_token: str, refresh_token: str, expires_at: float):
    from db import get_db
    db = get_db()
    existing = db.execute("SELECT client_id, client_secret FROM tesla_tokens WHERE user_id=?", (user_id,)).fetchone()
    cid = existing["client_id"] if existing else None
    csec = existing["client_secret"] if existing else None
    db.execute(
        "INSERT OR REPLACE INTO tesla_tokens (user_id, email, access_token, refresh_token, expires_at, client_id, client_secret) VALUES (?,?,?,?,?,?,?)",
        (user_id, email, access_token, refresh_token, expires_at, cid, csec),
    )
    db.commit()
    db.close()


def save_credentials(user_id: int, client_id: str, client_secret: str):
    from db import get_db
    db = get_db()
    enc_id = _encrypt(client_id) if client_id else None
    enc_sec = _encrypt(client_secret) if client_secret else None
    existing = db.execute("SELECT * FROM tesla_tokens WHERE user_id=?", (user_id,)).fetchone()
    if existing:
        db.execute(
            "UPDATE tesla_tokens SET client_id=?, client_secret=? WHERE user_id=?",
            (enc_id, enc_sec, user_id),
        )
    else:
        db.execute(
            "INSERT INTO tesla_tokens (user_id, client_id, client_secret) VALUES (?,?,?)",
            (user_id, enc_id, enc_sec),
        )
    db.commit()
    db.close()


# ── Per-user subdomain + key helpers ─────────────────────────────────────────

def get_user_redirect_uri(user_id: int) -> str:
    if user_id == 1:
        return os.environ.get("TESLA_REDIRECT_URI", "")
    from db import get_db
    db = get_db()
    row = db.execute("SELECT subdomain FROM users WHERE id=?", (user_id,)).fetchone()
    db.close()
    subdomain = row["subdomain"] if row and row["subdomain"] else None
    if not subdomain:
        return ""
    return f"https://{subdomain}/api/auth/callback"


def get_or_create_user_public_key(user_id: int) -> str:
    if user_id == 1:
        return get_or_create_public_key_pem()
    from db import get_db
    db = get_db()
    row = db.execute("SELECT public_key, private_key FROM users WHERE id=?", (user_id,)).fetchone()
    if row and row["public_key"]:
        db.close()
        return row["public_key"]
    private_key = ec.generate_private_key(ec.SECP256R1())
    priv_pem = private_key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    ).decode()
    pub_pem = private_key.public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
    ).decode()
    db.execute("UPDATE users SET private_key=?, public_key=? WHERE id=?", (priv_pem, pub_pem, user_id))
    db.commit()
    db.close()
    log.info(f"Generated EC key pair for user {user_id}")
    return pub_pem


def set_user_subdomain(user_id: int, subdomain: str):
    from db import get_db
    db = get_db()
    db.execute("UPDATE users SET subdomain=? WHERE id=?", (subdomain or None, user_id))
    db.commit()
    db.close()
    if subdomain:
        get_or_create_user_public_key(user_id)


def register_partner_for_user(user_id: int) -> dict:
    if user_id == 1:
        return register_partner()
    client_id, client_secret = _creds_for(user_id)
    if not client_id or not client_secret:
        raise ValueError("User has no Fleet API credentials configured")
    redirect_uri = get_user_redirect_uri(user_id)
    domain = redirect_uri.replace("https://", "").replace("http://", "").split("/")[0]
    if not domain:
        raise ValueError("No subdomain configured for user")
    resp = requests.post(f"{AUTH_BASE}/oauth2/v3/token", json={
        "grant_type": "client_credentials",
        "client_id": client_id,
        "client_secret": client_secret,
        "scope": SCOPES,
        "audience": FLEET_BASE,
    }, timeout=30)
    resp.raise_for_status()
    token = resp.json()["access_token"]
    r = requests.post(
        f"{FLEET_BASE}/api/1/partner_accounts",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json={"domain": domain},
        timeout=30,
    )
    body = r.json()
    log.info(f"Partner registration for user {user_id} ({domain}): {r.status_code} {body}")
    if r.ok or "already" in str(body).lower() or "taken" in str(body).lower():
        return {"ok": True, "detail": body}
    raise RuntimeError(f"Registration failed {r.status_code}: {body}")


# ── OAuth ────────────────────────────────────────────────────────────────────

def get_auth_url(user_id: int = 1) -> dict:
    client_id, _ = _creds_for(user_id)
    if not client_id:
        raise ValueError("No Tesla client_id configured — set your own credentials first")

    redirect_uri = get_user_redirect_uri(user_id)
    if not redirect_uri:
        raise ValueError("No subdomain configured — ask the admin to set your subdomain first")

    code_verifier = secrets.token_urlsafe(64)
    digest = hashlib.sha256(code_verifier.encode()).digest()
    code_challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode()
    nonce = secrets.token_urlsafe(32)
    state = f"{user_id}:{nonce}"

    _pkce_store[state] = {"verifier": code_verifier, "user_id": user_id, "redirect_uri": redirect_uri}

    params = urlencode({
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": SCOPES,
        "state": state,
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
        "prompt_missing_scopes": "true",
    })
    return {"url": f"{AUTH_BASE}/oauth2/v3/authorize?{params}"}


def handle_callback(code: str, state: str) -> bool:
    pkce = _pkce_store.pop(state, None)
    if pkce is None:
        log.warning("OAuth state mismatch or expired")
        return False

    user_id = pkce["user_id"]
    client_id, client_secret = _creds_for(user_id)
    redirect_uri = pkce["redirect_uri"]
    body = {
        "grant_type": "authorization_code",
        "client_id": client_id,
        "code": code,
        "redirect_uri": redirect_uri,
        "code_verifier": pkce["verifier"],
    }
    if client_secret:
        body["client_secret"] = client_secret
    resp = requests.post(f"{AUTH_BASE}/oauth2/v3/token", json=body, timeout=30)

    if not resp.ok:
        log.error(f"Token exchange failed {resp.status_code}: {resp.text[:300]}")
        return False

    data = resp.json()
    email = os.environ.get("TESLA_EMAIL", f"user_{user_id}")
    _save_token(
        user_id,
        email,
        data["access_token"],
        data.get("refresh_token", ""),
        time.time() + data.get("expires_in", 3600),
    )
    log.info(f"Tesla Fleet API authenticated for user {user_id}")
    return True


# ── Token management ─────────────────────────────────────────────────────────

def is_authenticated(user_id: int = 1) -> bool:
    try:
        cid, _ = _creds_for(user_id)
        if not cid:
            return False
        tok = _load_token(user_id)
        return bool(tok.get("access_token") or tok.get("refresh_token"))
    except Exception:
        return False


def _get_access_token(user_id: int = 1) -> str:
    tok = _load_token(user_id)

    if tok.get("access_token") and time.time() < (tok.get("expires_at") or 0) - 60:
        return tok["access_token"]

    if not tok.get("refresh_token"):
        raise ValueError(f"User {user_id} not authenticated — no refresh token")

    client_id, client_secret = _creds_for(user_id)
    body = {
        "grant_type": "refresh_token",
        "client_id": client_id,
        "refresh_token": tok["refresh_token"],
    }
    if client_secret:
        body["client_secret"] = client_secret
    resp = requests.post(f"{AUTH_BASE}/oauth2/v3/token", json=body, timeout=30)
    resp.raise_for_status()
    data = resp.json()

    _save_token(
        user_id,
        tok.get("email", f"user_{user_id}"),
        data["access_token"],
        data.get("refresh_token", tok["refresh_token"]),
        time.time() + data.get("expires_in", 3600),
    )
    return data["access_token"]


# ── Fleet API calls ───────────────────────────────────────────────────────────

def _fleet_get(path: str, user_id: int = 1, **kwargs) -> dict:
    token = _get_access_token(user_id)
    resp = requests.get(
        f"{FLEET_BASE}{path}",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30, **kwargs,
    )
    resp.raise_for_status()
    return resp.json()


def get_vehicle(vin: str | None = None, user_id: int = 1) -> dict:
    data = _fleet_get("/api/1/vehicles", user_id=user_id)
    vehicles = data.get("response", [])
    if not vehicles:
        raise RuntimeError("No vehicles found on account")
    if vin:
        for v in vehicles:
            if v.get("vin") == vin:
                return v
        raise RuntimeError(f"VIN {vin} not found")
    return vehicles[0]


def get_vehicle_data(vehicle_id: int | str, user_id: int = 1) -> dict:
    data = _fleet_get(
        f"/api/1/vehicles/{vehicle_id}/vehicle_data",
        user_id=user_id,
        params={"endpoints": "drive_state;location_data;charge_state;climate_state;vehicle_state;vehicle_config"},
    )
    return data.get("response", {})


def get_charge_history(vehicle_id: int | str, user_id: int = 1) -> list:
    try:
        data = _fleet_get(f"/api/1/vehicles/{vehicle_id}/charginghistory", user_id=user_id)
        return data.get("response", [])
    except Exception as e:
        log.warning(f"Charge history unavailable: {e}")
        return []


# ── Partner registration ──────────────────────────────────────────────────────

def get_or_create_public_key_pem() -> str:
    if not PRIVKEY_PATH.exists():
        private_key = ec.generate_private_key(ec.SECP256R1())
        PRIVKEY_PATH.write_bytes(
            private_key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            )
        )
        log.info("Generated new EC key pair for Tesla partner registration")

    private_key = serialization.load_pem_private_key(PRIVKEY_PATH.read_bytes(), password=None)
    pub = private_key.public_key().public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    return pub.decode()


def _get_partner_token() -> str:
    resp = requests.post(f"{AUTH_BASE}/oauth2/v3/token", json={
        "grant_type": "client_credentials",
        "client_id": _client_id(),
        "client_secret": _client_secret(),
        "scope": SCOPES,
        "audience": FLEET_BASE,
    }, timeout=30)
    resp.raise_for_status()
    return resp.json()["access_token"]


def register_partner() -> dict:
    redirect_uri = os.environ.get("TESLA_REDIRECT_URI", "")
    domain = redirect_uri.split("/api/")[0].replace("https://", "").replace("http://", "")
    if not domain:
        raise ValueError("TESLA_REDIRECT_URI not configured")

    token = _get_partner_token()
    resp = requests.post(
        f"{FLEET_BASE}/api/1/partner_accounts",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json={"domain": domain},
        timeout=30,
    )
    body = resp.json()
    log.info(f"Partner registration response {resp.status_code}: {body}")
    if resp.ok or "already" in str(body).lower():
        return {"ok": True, "detail": body}
    raise RuntimeError(f"Registration failed {resp.status_code}: {body}")


def configure_telemetry(vin: str, user_id: int = 1) -> dict:
    token = _get_access_token(user_id)
    hostname = os.environ.get("TELEMETRY_HOST", "").strip()
    if not hostname:
        raise ValueError("TELEMETRY_HOST is not configured")
    port = int(os.environ.get("TELEMETRY_PORT", "4443"))
    proxy_base = os.environ.get("VEHICLE_COMMAND_PROXY", "https://vehicle-command:8080")
    payload = {
        "vins": [vin],
        "config": {
            "hostname": hostname,
            "port": port,
            "ca": "-----BEGIN CERTIFICATE-----\nMIICjDCCAhGgAwIBAgIQTfOxXdbAeExQfNN7WObxFTAKBggqhkjOPQQDAzAuMQsw\nCQYDVQQGEwJVUzENMAsGA1UEChMESVNSRzEQMA4GA1UEAxMHUm9vdCBZRTAeFw0y\nNTA5MDMwMDAwMDBaFw0yODA5MDIyMzU5NTlaMDMxCzAJBgNVBAYTAlVTMRYwFAYD\nVQQKEw1MZXQncyBFbmNyeXB0MQwwCgYDVQQDEwNZRTIwdjAQBgcqhkjOPQIBBgUr\ngQQAIgNiAARxmrQzkdbEEL3MqXt3dJQttYc47axkdDTHud5TPqM2z5uSD5cmk0Wr\nHlWXvnlvqBLqiB34kluxIbmMyAiq3/YD6e80/vV259K8XQIdjFXloYOa0mIU71f7\nHQ09PvYDlw+jge4wgeswDgYDVR0PAQH/BAQDAgGGMBMGA1UdJQQMMAoGCCsGAQUF\nBwMBMBIGA1UdEwEB/wQIMAYBAf8CAQAwHQYDVR0OBBYEFLlZ8o7PIvCG0zdI/3YU\nGLqC2FWHMB8GA1UdIwQYMBaAFKPIJlqOoUzQNWP8myPIOq5W809WMDIGCCsGAQUF\nBwEBBCYwJDAiBggrBgEFBQcwAoYWaHR0cDovL3llLmkubGVuY3Iub3JnLzATBgNV\nHSAEDDAKMAgGBmeBDAECATAnBgNVHR8EIDAeMBygGqAYhhZodHRwOi8veWUuYy5s\nZW5jci5vcmcvMAoGCCqGSM49BAMDA2kAMGYCMQDIcnw5dcZLN9ffynXnnkLD/itS\nJEycJPb3sRkzeqBowup7vOsAwaqoCnNn/jh9wycCMQCJM6CPlaOC4pQYYbJtVPYb\nDKrIb2EKk5NpOpE6/XttQYZV/3gilB9l+Cc/DOVwmyg=\n-----END CERTIFICATE-----",
            "fields": {
                "VehicleSpeed":   {"interval_seconds": 1},
                "BrakePedalPos":  {"interval_seconds": 1},
                "Location":       {"interval_seconds": 1},
                "Gear":           {"interval_seconds": 1},
                "BatteryLevel":   {"interval_seconds": 1},
                "EstBatteryRange":{"interval_seconds": 5},
                "Odometer":       {"interval_seconds": 30},
                "Soc":            {"interval_seconds": 5},
            },
            "alert_types": [],
        },
    }
    resp = requests.post(
        f"{proxy_base}/api/1/vehicles/fleet_telemetry_config",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json=payload,
        timeout=30,
        verify=False,
    )
    body = resp.json()
    log.info(f"Telemetry config response {resp.status_code}: {body}")
    if not resp.ok:
        raise RuntimeError(f"Telemetry config failed {resp.status_code}: {body}")
    return body
