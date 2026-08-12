import os
import json
import asyncio
import logging
import hashlib
import re
import shutil
import subprocess
import tempfile
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone, timedelta
from pathlib import Path

from fastapi import FastAPI, HTTPException, BackgroundTasks, Depends, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse, PlainTextResponse, FileResponse, StreamingResponse
from starlette.background import BackgroundTask
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from dotenv import load_dotenv
import aiomqtt

load_dotenv()
logging.basicConfig(level=logging.INFO)

from db import get_db, init_db
from auth import hash_password, verify_password, create_token, decode_token
from tesla_api import get_vehicle, is_authenticated, get_auth_url, handle_callback, get_or_create_public_key_pem, get_or_create_user_public_key, register_partner, register_partner_for_user, save_credentials, set_user_subdomain, configure_telemetry
from collector import (import_history, import_history_all, poll_live, adaptive_tick,
                        adaptive_tick_all, force_fetch_soon, hint_drive_start,
                        start_mqtt_drive, end_mqtt_drive, update_mqtt_drive_speed)
from map_match import match_all_unmatched
from analytics import (
    degradation_series, cluster_stops, cluster_stops_with_cycles,
    efficiency_by_drive, tag_commutes, avg_consumption_from_drives,
    specs_for_trim, RunDetector, destination_clusters, speed_histogram_bands,
    haversine, compute_optimal_departure,
)

VIN = os.environ.get("TESLA_VIN")
def _coord(key): return float(os.environ.get(key) or "nan")
HOME_LAT = _coord("HOME_LAT")
HOME_LON = _coord("HOME_LON")
WORK_LAT = _coord("WORK_LAT")
WORK_LON = _coord("WORK_LON")

scheduler = AsyncIOScheduler()
run_detector = RunDetector()
log = logging.getLogger(__name__)

DASHCAM_ROOT = Path(os.environ.get("DASHCAM_ROOT", "/data/dashcam"))
DASHCAM_DIRECT_USER_ID = int(os.environ.get("DASHCAM_DIRECT_USER_ID", "1"))
DASHCAM_DIRECT_FOLDERS = ("SavedClips", "RecentClips", "SentryClips")
DASHCAM_ROOT.mkdir(parents=True, exist_ok=True)
_dashcam_media_tokens: dict[str, int] = {}
_dashcam_clip_re = re.compile(
    r"^(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})-(front|back|left_repeater|right_repeater|left_pillar|right_pillar)\.mp4$",
    re.IGNORECASE,
)

_mqtt_task: asyncio.Task | None = None
_vin_driving: dict[str, bool] = {}  # updated live from Gear MQTT messages
_vin_last_location_fetch: dict[str, datetime] = {}  # throttle force_fetch on Location
_vin_last_location: dict[str, tuple[float, float]] = {}  # latest lat/lon from streamed Location
_vin_current_stop: dict[str, dict | None] = {}  # open stop per VIN for streaming stop detection
_vin_last_heading: dict[str, float] = {}        # last known compass heading per VIN
_vin_last_odometer: dict[str, float] = {}       # latest odometer from stream
_vin_last_soc: dict[str, int] = {}              # latest battery % from stream
_vin_user_id: dict[str, int] = {}              # VIN → user_id cache


def _get_user_id_for_vin(vin: str) -> int | None:
    if vin in _vin_user_id:
        return _vin_user_id[vin]
    try:
        db = get_db()
        row = db.execute("SELECT user_id FROM vehicles WHERE vin=?", (vin,)).fetchone()
        db.close()
        if row:
            _vin_user_id[vin] = row["user_id"]
            return row["user_id"]
    except Exception:
        pass
    return None

_bearer = HTTPBearer(auto_error=False)


async def get_current_user(creds: HTTPAuthorizationCredentials | None = Depends(_bearer)):
    if not creds:
        raise HTTPException(401, "Not authenticated")
    user_id = decode_token(creds.credentials)
    if user_id is None:
        raise HTTPException(401, "Invalid or expired token")
    db = get_db()
    row = db.execute("SELECT id, username, is_admin, visible_in_garage FROM users WHERE id=?", (user_id,)).fetchone()
    db.close()
    if not row:
        raise HTTPException(401, "User not found")
    return dict(row)


async def require_admin(user=Depends(get_current_user)):
    if not user["is_admin"]:
        raise HTTPException(403, "Admin required")
    return user


async def _mqtt_subscriber():
    while True:
        try:
            async with aiomqtt.Client("mosquitto") as client:
                await client.subscribe("tesla/+/v/VehicleSpeed")
                await client.subscribe("tesla/+/v/Gear")
                await client.subscribe("tesla/+/v/Location")
                await client.subscribe("tesla/+/v/Heading")
                await client.subscribe("tesla/+/v/Power")
                await client.subscribe("tesla/+/v/BatteryLevel")
                await client.subscribe("tesla/+/v/EstBatteryRange")
                await client.subscribe("tesla/+/v/Odometer")
                await client.subscribe("tesla/+/v/ChargingState")
                await client.subscribe("tesla/+/v/ChargeEnergyAdded")
                log.info("MQTT subscriber connected")
                async for message in client.messages:
                    parts = str(message.topic).split('/')
                    if len(parts) < 4:
                        continue
                    vin, field = parts[1], parts[3]
                    try:
                        value = json.loads(message.payload)
                    except Exception:
                        continue
                    if field == 'VehicleSpeed':
                        try:
                            speed = float(value)
                        except (TypeError, ValueError):
                            continue
                        run = run_detector.process(vin, speed)
                        if run:
                            log.info(f"Run detected: 0-60 in {run['time_0_to_60']}s max {run['max_speed']}mph")
                            _save_run(run)
                        _update_top_speed(vin, speed)
                        update_mqtt_drive_speed(vin, speed)
                        now_ts = datetime.now(timezone.utc).isoformat()
                        if _vin_driving.get(vin):
                            loc = _vin_last_location.get(vin)
                            if speed == 0 and loc:
                                _open_stop(vin, now_ts, loc[0], loc[1])
                            elif speed > 0:
                                _close_stop(vin, now_ts)
                    elif field == 'Gear':
                        gear = str(value)
                        log.info(f"Gear: {gear}")
                        run_detector.process(vin, 0, gear=gear)
                        was_driving = _vin_driving.get(vin, False)
                        _vin_driving[vin] = gear in ('D', 'R', 'N')
                        now_ts = datetime.now(timezone.utc).isoformat()
                        if _vin_driving[vin] and not was_driving:
                            loc = _vin_last_location.get(vin)
                            user_id = _get_user_id_for_vin(vin)
                            if user_id:
                                start_mqtt_drive(
                                    vin, now_ts,
                                    loc[0] if loc else None,
                                    loc[1] if loc else None,
                                    _vin_last_odometer.get(vin),
                                    _vin_last_soc.get(vin),
                                    user_id,
                                )
                            _backfill_driving_snapshots(vin)
                        elif gear == 'P' and was_driving:
                            loc = _vin_last_location.get(vin)
                            end_mqtt_drive(
                                vin, now_ts,
                                loc[0] if loc else None,
                                loc[1] if loc else None,
                                _vin_last_odometer.get(vin),
                                _vin_last_soc.get(vin),
                            )
                            _close_stop(vin, now_ts)
                            force_fetch_soon(vin)  # sync charge state after parking
                    elif field == 'Power':
                        try:
                            _store_power(vin, float(value))
                        except (TypeError, ValueError):
                            pass
                    elif field == 'BatteryLevel':
                        try:
                            v = int(float(value))
                            _vin_last_soc[vin] = v
                            _store_telemetry(vin, battery_level=v)
                        except (TypeError, ValueError):
                            pass
                    elif field == 'EstBatteryRange':
                        try:
                            _store_telemetry(vin, battery_range=float(value))
                        except (TypeError, ValueError):
                            pass
                    elif field == 'Odometer':
                        try:
                            v = float(value)
                            _vin_last_odometer[vin] = v
                            _store_telemetry(vin, odometer=v)
                        except (TypeError, ValueError):
                            pass
                    elif field == 'Heading':
                        try:
                            _vin_last_heading[vin] = float(value)
                        except (TypeError, ValueError):
                            pass
                    elif field == 'Location':
                        if isinstance(value, dict):
                            lat_v, lon_v = value.get('latitude'), value.get('longitude')
                            if lat_v is not None and lon_v is not None:
                                _vin_last_location[vin] = (float(lat_v), float(lon_v))
                            # Fleet telemetry sometimes bundles heading in Location
                            hdg_v = value.get('heading') or value.get('Heading')
                            if hdg_v is not None:
                                try:
                                    _vin_last_heading[vin] = float(hdg_v)
                                except (TypeError, ValueError):
                                    pass
                            _store_location(vin, lat_v, lon_v)
                            # Trigger an API poll to catch drive starts that happen before
                            # a Gear=D message arrives. Throttle depends on what we know:
                            #   None  = never seen a Gear message → might be mid-drive, poll fast
                            #   False = Gear=P confirmed → car is parked, back way off
                            #   True  = Gear=D/R/N → actively driving, handled by Gear handler
                            gear_known = _vin_driving.get(vin)  # None | False | True
                            if gear_known is not True:
                                throttle = 20 if gear_known is None else 300
                                last = _vin_last_location_fetch.get(vin)
                                if last is None or (datetime.now(timezone.utc) - last).total_seconds() > throttle:
                                    _vin_last_location_fetch[vin] = datetime.now(timezone.utc)
                                    force_fetch_soon(vin)
        except Exception as e:
            log.warning(f"MQTT subscriber error: {e}, retrying in 15s")
            await asyncio.sleep(15)


def _store_power(vin: str, power: float):
    try:
        db = get_db()
        row = db.execute("SELECT user_id FROM vehicles WHERE vin=?", (vin,)).fetchone()
        if not row:
            db.close()
            return
        is_drv = 1 if _vin_driving.get(vin, False) else 0
        db.execute(
            "INSERT INTO snapshots (vin, ts, power, is_driving, user_id) VALUES (?,?,?,?,?)",
            (vin, datetime.now(timezone.utc).isoformat(), power, is_drv, row["user_id"])
        )
        db.commit()
        db.close()
    except Exception as e:
        log.error(f"Failed to store power: {e}")


def _store_telemetry(vin: str, **fields):
    try:
        db = get_db()
        row = db.execute("SELECT user_id FROM vehicles WHERE vin=?", (vin,)).fetchone()
        if not row:
            db.close()
            return
        is_drv = 1 if _vin_driving.get(vin, False) else 0
        cols = ", ".join(fields.keys())
        placeholders = ", ".join("?" * len(fields))
        db.execute(
            f"INSERT INTO snapshots (vin, ts, is_driving, user_id, {cols}) VALUES (?,?,?,?,{placeholders})",
            (vin, datetime.now(timezone.utc).isoformat(), is_drv, row["user_id"], *fields.values())
        )
        db.commit()
        db.close()
    except Exception as e:
        log.error(f"Failed to store telemetry {list(fields.keys())}: {e}")


def _store_location(vin: str, lat, lon):
    if lat is None or lon is None:
        return
    try:
        db = get_db()
        row = db.execute("SELECT user_id FROM vehicles WHERE vin=?", (vin,)).fetchone()
        if not row:
            db.close()
            return
        is_drv = 1 if _vin_driving.get(vin, False) else 0
        db.execute(
            "INSERT INTO snapshots (vin, ts, latitude, longitude, is_driving, user_id) VALUES (?,?,?,?,?,?)",
            (vin, datetime.now(timezone.utc).isoformat(), lat, lon, is_drv, row["user_id"])
        )
        db.commit()
        db.close()
    except Exception as e:
        log.error(f"Failed to store location: {e}")


def _open_stop(vin: str, ts: str, lat: float, lon: float):
    """Start tracking a stop for this VIN if one isn't already open."""
    if _vin_current_stop.get(vin) is None:
        # Capture the approach heading BEFORE the car stopped — direction of travel
        # matters for signal-phase grouping (N/S ≠ E/W at the same intersection).
        heading = _vin_last_heading.get(vin)
        if heading is None:
            try:
                db = get_db()
                row = db.execute(
                    "SELECT heading FROM snapshots WHERE vin=? AND heading IS NOT NULL ORDER BY ts DESC LIMIT 1",
                    (vin,)
                ).fetchone()
                db.close()
                if row:
                    heading = row["heading"]
            except Exception:
                pass
        _vin_current_stop[vin] = {"ts": ts, "lat": lat, "lon": lon, "heading": heading}


def _close_stop(vin: str, end_ts: str):
    """Close any open stop for this VIN and persist it if duration is in range."""
    stop = _vin_current_stop.get(vin)
    if not stop:
        return
    _vin_current_stop[vin] = None
    try:
        start_dt = datetime.fromisoformat(stop["ts"].replace("Z", "+00:00"))
        end_dt = datetime.fromisoformat(end_ts.replace("Z", "+00:00"))
        duration = int((end_dt - start_dt).total_seconds())
        if not (8 <= duration <= 180):
            return
        db = get_db()
        row = db.execute("SELECT user_id FROM vehicles WHERE vin=?", (vin,)).fetchone()
        if row:
            db.execute(
                "INSERT INTO stops (vin, ts, latitude, longitude, duration_seconds, user_id, heading) VALUES (?,?,?,?,?,?,?)",
                (vin, stop["ts"], stop["lat"], stop["lon"], duration, row["user_id"], stop.get("heading")),
            )
            db.commit()
            log.info(f"Stop recorded: {duration}s at ({stop['lat']:.4f}, {stop['lon']:.4f}) for {vin}")
        db.close()
    except Exception as e:
        log.error(f"Failed to save stop for {vin}: {e}")


def _backfill_driving_snapshots(vin: str):
    """When Gear→D, retroactively mark recent MQTT location-only snapshots as driving.

    Handles the case where fleet-telemetry delivers Location messages before the Gear
    message arrives (common during the telemetry connection startup delay).
    """
    cutoff = (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat()
    try:
        db = get_db()
        db.execute(
            "UPDATE snapshots SET is_driving=1 WHERE vin=? AND ts >= ? AND is_driving=0 "
            "AND latitude IS NOT NULL AND battery_level IS NULL",
            (vin, cutoff)
        )
        n = db.execute("SELECT changes()").fetchone()[0]
        if n:
            log.info(f"Backfilled {n} location snapshots as driving for {vin}")
        db.commit()
        db.close()
    except Exception as e:
        log.error(f"Backfill driving snapshots error: {e}")


def _update_top_speed(vin: str, speed: float):
    try:
        db = get_db()
        db.execute("""
            INSERT INTO telemetry_stats (vin, top_speed, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(vin) DO UPDATE SET
                top_speed = MAX(top_speed, excluded.top_speed),
                updated_at = excluded.updated_at
            WHERE excluded.top_speed > top_speed
        """, (vin, speed, datetime.now(timezone.utc).isoformat()))
        db.commit()
        db.close()
    except Exception as e:
        log.error(f"Failed to update top speed: {e}")


def _save_run(run: dict):
    try:
        db = get_db()
        db.execute("""
            INSERT INTO acceleration_runs (vin, ts, time_0_to_60, time_0_to_100, max_speed, launch_speed)
            VALUES (?, ?, ?, ?, ?, ?)
        """, (run['vin'], run['ts'], run['time_0_to_60'], run.get('time_0_to_100'),
              run.get('max_speed'), run.get('launch_speed', 0)))
        db.commit()
        db.close()
        log.info(f"Run saved: 0-60 in {run['time_0_to_60']}s")
    except Exception as e:
        log.error(f"Failed to save run: {e}")


def _configure_telemetry_all():
    db = get_db()
    rows = db.execute("SELECT DISTINCT user_id FROM tesla_tokens").fetchall()
    db.close()
    for row in rows:
        try:
            vehicle = get_vehicle(user_id=row["user_id"])
            configure_telemetry(vehicle["vin"], user_id=row["user_id"])
            log.info(f"Telemetry configured for user {row['user_id']}")
        except Exception as e:
            log.warning(f"Telemetry config failed for user {row['user_id']}: {e}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _mqtt_task
    init_db()
    asyncio.get_event_loop().run_in_executor(None, import_history_all)
    asyncio.get_event_loop().run_in_executor(None, _configure_telemetry_all)
    asyncio.get_event_loop().run_in_executor(None, match_all_unmatched)
    scheduler.add_job(import_history_all, "interval", hours=6, id="history")
    scheduler.add_job(adaptive_tick_all, "interval", seconds=2, id="live")
    scheduler.start()
    _mqtt_task = asyncio.create_task(_mqtt_subscriber())
    yield
    if _mqtt_task:
        _mqtt_task.cancel()
    scheduler.shutdown()


app = FastAPI(lifespan=lifespan)
cors_origins = [origin.strip() for origin in os.environ.get("CORS_ORIGINS", "").split(",") if origin.strip()]
if cors_origins:
    app.add_middleware(CORSMiddleware, allow_origins=cors_origins, allow_methods=["*"], allow_headers=["*"])


# ── Tesla well-known public key ───────────────────────────────────────────────

@app.get("/.well-known/appspecific/com.tesla.3p.public-key.pem")
def tesla_public_key(request: Request):
    host = request.headers.get("host", "").split(":")[0]
    db = get_db()
    row = db.execute("SELECT id FROM users WHERE subdomain=?", (host,)).fetchone()
    db.close()
    if row:
        pem = get_or_create_user_public_key(row["id"])
    else:
        pem = get_or_create_public_key_pem()
    return PlainTextResponse(pem, media_type="application/x-pem-file")


# ── App Auth ──────────────────────────────────────────────────────────────────

@app.post("/api/auth/login")
def auth_login(body: dict):
    username = body.get("username", "").strip()
    password = body.get("password", "")
    if not username or not password:
        raise HTTPException(400, "Username and password required")
    db = get_db()
    row = db.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
    db.close()
    if not row or not verify_password(password, row["password_hash"]):
        raise HTTPException(401, "Invalid credentials")
    token = create_token(row["id"])
    return {
        "token": token,
        "user": {
            "id": row["id"],
            "username": row["username"],
            "is_admin": bool(row["is_admin"]),
            "visible_in_garage": bool(row["visible_in_garage"]),
        }
    }


@app.get("/api/auth/me")
def auth_me(user=Depends(get_current_user)):
    db = get_db()
    row = db.execute("SELECT id, username, is_admin, visible_in_garage, home_lat, home_lon, work_lat, work_lon FROM users WHERE id=?", (user["id"],)).fetchone()
    db.close()
    return dict(row) if row else user


@app.patch("/api/users/me/location")
def update_my_location(body: dict, user=Depends(get_current_user)):
    db = get_db()
    db.execute(
        "UPDATE users SET home_lat=?, home_lon=?, work_lat=?, work_lon=? WHERE id=?",
        (body.get("home_lat"), body.get("home_lon"), body.get("work_lat"), body.get("work_lon"), user["id"])
    )
    db.commit()
    db.close()
    return {"ok": True}


# ── Tesla Auth ────────────────────────────────────────────────────────────────

@app.get("/api/auth/status")
def auth_status(user=Depends(get_current_user)):
    return {"authenticated": is_authenticated(user["id"])}


@app.post("/api/auth/credentials")
def set_credentials(body: dict, user=Depends(get_current_user)):
    save_credentials(user["id"], body.get("client_id", ""), body.get("client_secret", ""))
    return {"ok": True}


@app.get("/api/auth/credentials")
def get_credentials(user=Depends(get_current_user)):
    from db import get_db
    db = get_db()
    row = db.execute("SELECT client_id FROM tesla_tokens WHERE user_id=?", (user["id"],)).fetchone()
    db.close()
    return {"has_own_credentials": bool(row and row["client_id"])}


@app.get("/api/auth/url")
def auth_url(user=Depends(get_current_user)):
    try:
        return get_auth_url(user["id"])
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.get("/api/auth/callback")
def auth_callback(code: str = "", state: str = "", error: str = ""):
    if error or not code:
        return RedirectResponse("/?auth_error=1")

    ok = handle_callback(code, state)
    if ok:
        user_id = 1
        try:
            user_id = int(state.split(":")[0])
        except Exception:
            pass
        import threading
        def _post_auth(uid):
            try:
                register_partner_for_user(uid)
            except Exception as e:
                log.warning(f"Partner registration for user {uid} failed: {e}")
            import_history(user_id=uid)
        threading.Thread(target=lambda: _post_auth(user_id), daemon=True).start()
        return RedirectResponse("/")
    return RedirectResponse("/?auth_error=1")


@app.post("/api/auth/register")
def auth_register(admin=Depends(require_admin)):
    try:
        result = register_partner()
        return result
    except Exception as e:
        raise HTTPException(500, str(e))


@app.post("/api/telemetry/configure")
def telemetry_configure(user=Depends(get_current_user)):
    try:
        vehicle = get_vehicle(user_id=user["id"])
        result = configure_telemetry(vehicle["vin"], user_id=user["id"])
        return result
    except Exception as e:
        raise HTTPException(500, str(e))


# ── User management ───────────────────────────────────────────────────────────

@app.get("/api/users")
def list_users(admin=Depends(require_admin)):
    db = get_db()
    rows = db.execute("SELECT id, username, is_admin, visible_in_garage, created_at, subdomain FROM users").fetchall()
    db.close()
    return [dict(r) for r in rows]


@app.post("/api/users")
def create_user(body: dict, admin=Depends(require_admin)):
    username = body.get("username", "").strip()
    password = body.get("password", "")
    if not username or not password:
        raise HTTPException(400, "Username and password required")
    db = get_db()
    try:
        db.execute(
            "INSERT INTO users (username, password_hash, is_admin, visible_in_garage, created_at) VALUES (?,?,0,1,?)",
            (username, hash_password(password), datetime.now(timezone.utc).isoformat()),
        )
        db.commit()
        row = db.execute("SELECT id, username, is_admin, visible_in_garage FROM users WHERE username=?", (username,)).fetchone()
        db.close()
        return dict(row)
    except Exception as e:
        db.close()
        raise HTTPException(409, f"Username already exists: {e}")


@app.delete("/api/users/{user_id}")
def delete_user(user_id: int, admin=Depends(require_admin)):
    if user_id == admin["id"]:
        raise HTTPException(400, "Cannot delete yourself")
    db = get_db()
    db.execute("DELETE FROM users WHERE id=?", (user_id,))
    db.commit()
    db.close()
    return {"ok": True}


@app.patch("/api/users/{user_id}/subdomain")
def update_subdomain(user_id: int, body: dict, admin=Depends(require_admin)):
    subdomain = body.get("subdomain", "").strip().lower()
    set_user_subdomain(user_id, subdomain)
    return {"ok": True}


@app.patch("/api/users/me")
def update_my_visibility(body: dict, user=Depends(get_current_user)):
    visible = body.get("visible_in_garage")
    if visible is None:
        raise HTTPException(400, "visible_in_garage required")
    db = get_db()
    db.execute("UPDATE users SET visible_in_garage=? WHERE id=?", (int(bool(visible)), user["id"]))
    db.commit()
    db.close()
    return {"ok": True}


# ── Garage ────────────────────────────────────────────────────────────────────

@app.get("/api/garage")
def garage(user=Depends(get_current_user)):
    db = get_db()
    users = db.execute(
        "SELECT id, username FROM users WHERE visible_in_garage=1"
    ).fetchall()

    result = []
    for u in users:
        uid = u["id"]

        vehicle_row = db.execute(
            "SELECT display_name, model, year, data FROM vehicles WHERE user_id=? ORDER BY updated_at DESC LIMIT 1", (uid,)
        ).fetchone()

        snap = db.execute(
            "SELECT odometer, battery_level, battery_range FROM snapshots WHERE user_id=? ORDER BY ts DESC LIMIT 1", (uid,)
        ).fetchone()

        top_speed_row = db.execute(
            "SELECT top_speed FROM telemetry_stats WHERE user_id=? ORDER BY top_speed DESC LIMIT 1", (uid,)
        ).fetchone()
        if not top_speed_row:
            top_speed_row = db.execute(
                "SELECT MAX(max_speed) as top_speed FROM drives WHERE user_id=?", (uid,)
            ).fetchone()

        best_0_60_row = db.execute(
            "SELECT MIN(time_0_to_60) as best_0_60 FROM acceleration_runs WHERE user_id=?", (uid,)
        ).fetchone()

        drives_rows = db.execute(
            "SELECT energy_used_kwh, distance_miles FROM drives WHERE user_id=? AND energy_used_kwh > 0 AND distance_miles > 0.5",
            (uid,)
        ).fetchall()
        drives_list = [dict(r) for r in drives_rows]
        total_kwh = sum(d["energy_used_kwh"] or 0 for d in drives_list)
        total_mi = sum(d["distance_miles"] or 0 for d in drives_list)
        avg_wh_per_mile = round((total_kwh * 1000) / total_mi, 0) if total_mi > 0 else None

        battery_health = None
        if snap and snap["battery_level"] and snap["battery_range"]:
            soc = snap["battery_level"]
            rng = snap["battery_range"]
            if 10 < soc < 95:
                trim = "74"
                vrow = db.execute("SELECT data FROM vehicles WHERE user_id=? ORDER BY updated_at DESC LIMIT 1", (uid,)).fetchone()
                if vrow:
                    try:
                        trim = json.loads(vrow["data"]).get("vehicle_config", {}).get("trim_badging") or trim
                    except Exception:
                        pass
                original_kwh, epa_miles = specs_for_trim(trim)
                epa_consumption = original_kwh / epa_miles
                projected = (rng / (soc / 100.0)) * epa_consumption
                battery_health = round((projected / original_kwh) * 100, 1)

        img_url = None
        if vehicle_row and vehicle_row["data"]:
            try:
                vcfg = json.loads(vehicle_row["data"]).get("vehicle_config", {})
                img_url = _compositor_url(vcfg)["url"]
            except Exception:
                pass

        result.append({
            "user_id": uid,
            "username": u["username"],
            "model": vehicle_row["model"] if vehicle_row else None,
            "year": vehicle_row["year"] if vehicle_row else None,
            "display_name": vehicle_row["display_name"] if vehicle_row else None,
            "odometer": round(snap["odometer"], 0) if snap and snap["odometer"] else None,
            "top_speed": top_speed_row["top_speed"] if top_speed_row else None,
            "best_0_to_60": best_0_60_row["best_0_60"] if best_0_60_row else None,
            "battery_health_pct": battery_health,
            "avg_wh_per_mile": avg_wh_per_mile,
            "compositor_url": img_url,
        })

    db.close()
    return result


# ── Vehicle ───────────────────────────────────────────────────────────────────

@app.get("/api/vehicle")
def vehicle(user=Depends(get_current_user)):
    db = get_db()
    row = db.execute("SELECT * FROM vehicles WHERE user_id=? LIMIT 1", (user["id"],)).fetchone()
    db.close()
    if not row:
        raise HTTPException(404, "No vehicle data yet")
    return dict(row)


_COLOR_MAP = {
    "RedMulticoat":          "PPMR",
    "DeepBlue":              "PPSB",
    "DeepBluePearlcoat":     "PPSB",
    "ObsidianBlack":         "PBSB",
    "PearlWhite":            "PPSW",
    "PearlWhiteMultiCoat":   "PPSW",
    "MidnightSilver":        "PMNG",
    "SteelGrey":             "PMNG",
    "SolidBlack":            "PPBK",
    "MidnightCherryRed":     "PPMR",
    "QuicksilverMetallic":   "PMNG",
    "UltraRed":              "PPMR",
    "SapphireBlue":          "PPSB",
    "SandstoneMetallic":     "PMSS",
}
_WHEEL_MAP = {
    "Pinwheel18CapKit":  "W39B",  # overridden: user has 19" TSF Flow Forged (closest match)
    "Pinwheel18":        "W38B",
    "Stiletto19":        "W39B",
    "Sport19":           "W39B",
    "Stiletto20":        "W40B",
    "AeroTurbine20":     "W40B",
    "Sport20":           "W40B",
}
_MODEL_MAP = {
    "model3": "m3",
    "modely": "my",
    "models": "ms",
    "modelx": "mx",
    "modelsp": "msp",
}

def _compositor_url(cfg: dict) -> dict:
    color = _COLOR_MAP.get(cfg.get("exterior_color", ""), "PPSW")
    wheel = _WHEEL_MAP.get(cfg.get("wheel_type", ""), "W38B")
    model = _MODEL_MAP.get(cfg.get("car_type", ""), "m3")
    roof  = "RF3G" if cfg.get("roof_color") == "RoofColorGlass" else ""
    options = ",".join(f"${c}" for c in [color, wheel, roof] if c)
    url = f"https://static-assets.tesla.com/v1/compositor/?model={model}&view=STUD_3QTR&options={options}&size=1440&bkba_opt=1"
    return {"url": url, "model": model, "color": color, "wheel": wheel}


@app.get("/api/vehicle/image")
def vehicle_image(user=Depends(get_current_user)):
    db = get_db()
    row = db.execute("SELECT data FROM vehicles WHERE user_id=? ORDER BY updated_at DESC LIMIT 1", (user["id"],)).fetchone()
    db.close()
    if not row:
        raise HTTPException(404, "No vehicle data")
    try:
        cfg = json.loads(row["data"]).get("vehicle_config", {})
    except Exception:
        cfg = {}
    return _compositor_url(cfg)


@app.get("/api/vehicle/live")
def vehicle_live(user=Depends(get_current_user)):
    db = get_db()
    row = db.execute("SELECT * FROM snapshots WHERE user_id=? ORDER BY ts DESC LIMIT 1", (user["id"],)).fetchone()
    db.close()
    if not row:
        raise HTTPException(404, "No live data yet — car hasn't been polled")
    return dict(row)


# ── Charging ──────────────────────────────────────────────────────────────────

@app.get("/api/charges")
def charges(limit: int = 100, user=Depends(get_current_user)):
    db = get_db()
    rows = db.execute(
        "SELECT * FROM charges WHERE user_id=? ORDER BY start_time DESC LIMIT ?", (user["id"], limit)
    ).fetchall()
    db.close()
    return [dict(r) for r in rows]


@app.get("/api/charges/summary")
def charges_summary(user=Depends(get_current_user)):
    db = get_db()
    row = db.execute("""
        SELECT
            COUNT(*) as total_sessions,
            ROUND(SUM(energy_added_kwh), 1) as total_kwh,
            ROUND(AVG(energy_added_kwh), 2) as avg_kwh,
            SUM(CASE WHEN fast_charger=1 THEN 1 ELSE 0 END) as supercharger_sessions,
            ROUND(SUM(charge_miles_added), 0) as total_miles_added
        FROM charges WHERE user_id=?
    """, (user["id"],)).fetchone()
    db.close()
    return dict(row)


# ── Drives ────────────────────────────────────────────────────────────────────

@app.get("/api/drives")
def drives(limit: int = 200, commute_only: bool = False, user=Depends(get_current_user)):
    db = get_db()
    where = "WHERE user_id=?" + (" AND (is_commute_to_work=1 OR is_commute_to_home=1)" if commute_only else "")
    rows = db.execute(
        f"SELECT * FROM drives {where} ORDER BY start_time DESC LIMIT ?", (user["id"], limit)
    ).fetchall()
    db.close()
    return [dict(r) for r in rows]


def _stoplight_from_snapshots(db, vin: str, start_time: str, end_time: str) -> int:
    """Derive stoplight wait time from polled speed snapshots when MQTT stops aren't available."""
    rows = db.execute(
        """SELECT ts, speed FROM snapshots
           WHERE vin=? AND ts >= ? AND ts <= ? AND is_driving=1 AND speed IS NOT NULL
           ORDER BY ts ASC""",
        (vin, start_time, end_time)
    ).fetchall()
    total = 0
    zero_start = None
    for row in rows:
        ts, speed = row["ts"], row["speed"]
        if speed == 0:
            if zero_start is None:
                zero_start = ts
        else:
            if zero_start is not None:
                try:
                    t0 = datetime.fromisoformat(zero_start.replace("Z", "+00:00"))
                    t1 = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                    dur = int((t1 - t0).total_seconds())
                    if 8 <= dur <= 300:
                        total += dur
                except Exception:
                    pass
                zero_start = None
    return total


@app.get("/api/drives/commutes")
def commutes(user=Depends(get_current_user)):
    db = get_db()
    to_work = db.execute("""
        SELECT *, 'to_work' as direction FROM drives
        WHERE user_id=? AND is_commute_to_work=1
        ORDER BY duration_seconds ASC
    """, (user["id"],)).fetchall()
    to_home = db.execute("""
        SELECT *, 'to_home' as direction FROM drives
        WHERE user_id=? AND is_commute_to_home=1
        ORDER BY duration_seconds ASC
    """, (user["id"],)).fetchall()

    def add_stoplight_seconds(rows):
        result = []
        for i, r in enumerate(rows):
            d = dict(r)
            d["rank"] = i + 1
            stop_row = db.execute(
                "SELECT COALESCE(SUM(duration_seconds), 0) as total FROM stops "
                "WHERE user_id=? AND ts >= ? AND ts <= ?",
                (user["id"], d["start_time"], d["end_time"])
            ).fetchone()
            secs = int(stop_row["total"])
            if secs == 0:
                secs = _stoplight_from_snapshots(db, d["vin"], d["start_time"], d["end_time"])
            d["stoplight_seconds"] = secs
            result.append(d)
        return result

    result = {
        "to_work": add_stoplight_seconds(to_work),
        "to_home": add_stoplight_seconds(to_home),
    }
    db.close()
    return result


@app.get("/api/drives/{drive_id}/track")
def drive_track_by_id(drive_id: int, user=Depends(get_current_user)):
    db = get_db()
    drive = db.execute(
        "SELECT vin, start_time, end_time, matched_route, start_lat, start_lon FROM drives WHERE id=? AND user_id=?",
        (drive_id, user["id"])
    ).fetchone()
    if not drive:
        raise HTTPException(404, "Drive not found")

    if drive["matched_route"]:
        # Use map-matched route for accurate road geometry.
        # Map-matched routes don't carry per-point speed, so we join snapshot speeds
        # by nearest timestamp to colorize the segments.
        matched_pts = json.loads(drive["matched_route"])
        # Include all location snapshots, not just is_driving=1 polled rows.
        # Fleet telemetry delivers GPS at ~1 Hz with speed=NULL; we derive speed
        # from consecutive GPS points so highway segments aren't colored as stopped.
        snaps = db.execute(
            """SELECT ts, latitude, longitude, speed FROM snapshots
               WHERE vin=? AND ts >= ? AND ts <= ?
                 AND latitude IS NOT NULL AND longitude IS NOT NULL
               ORDER BY ts ASC""",
            (drive["vin"], drive["start_time"], drive["end_time"])
        ).fetchall()
        snap_list = [dict(s) for s in snaps]

        # Assign speeds by temporal interpolation rather than geographic nearest.
        # Geographic nearest breaks when two parts of the route pass close to each
        # other at different speeds. Instead, we distribute matched points evenly
        # across the drive's time window and pick the snapshot nearest in time.
        n = len(matched_pts)
        if snap_list and n > 0:
            from datetime import datetime, timezone as _tz
            def _parse(ts: str):
                return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
            t0 = _parse(drive["start_time"])
            t1 = _parse(drive["end_time"])
            span = max(t1 - t0, 1)
            snap_times = [_parse(s["ts"]) for s in snap_list]
            # Derive speed from consecutive GPS points where API speed is absent.
            # Only use pairs within 5 s of each other to avoid gap artifacts.
            for i in range(1, len(snap_list)):
                if snap_list[i]["speed"] is None:
                    dt = snap_times[i] - snap_times[i - 1]
                    if 0 < dt <= 5:
                        dist = haversine(
                            snap_list[i - 1]["latitude"], snap_list[i - 1]["longitude"],
                            snap_list[i]["latitude"], snap_list[i]["longitude"],
                        )
                        snap_list[i]["speed"] = min((dist / dt) * 3600, 150)
            def speed_at_index(i: int):
                t = t0 + (i / max(n - 1, 1)) * span
                best_idx = min(range(len(snap_times)), key=lambda j: abs(snap_times[j] - t))
                return snap_list[best_idx]["speed"]
            points = [{"lat": p[0], "lon": p[1], "speed": speed_at_index(i)} for i, p in enumerate(matched_pts)]
        else:
            points = [{"lat": p[0], "lon": p[1], "speed": None} for p in matched_pts]
    else:
        snaps = db.execute(
            """SELECT latitude, longitude, speed FROM snapshots
               WHERE vin=? AND ts >= ? AND ts <= ?
                 AND is_driving=1 AND latitude IS NOT NULL AND longitude IS NOT NULL
               ORDER BY ts ASC""",
            (drive["vin"], drive["start_time"], drive["end_time"])
        ).fetchall()
        points = [{"lat": s["latitude"], "lon": s["longitude"], "speed": s["speed"]} for s in snaps]
        slat, slon = drive["start_lat"], drive["start_lon"]
        if slat and slon and points and haversine(slat, slon, points[0]["lat"], points[0]["lon"]) > 0.05:
            points.insert(0, {"lat": slat, "lon": slon, "speed": 0})

    db.close()
    return {"drive_id": drive_id, "points": points}


@app.get("/api/drives/commutes/optimal-departure")
def commutes_optimal_departure(direction: str = "to_work", user=Depends(get_current_user)):
    db = get_db()
    col = "is_commute_to_work" if direction == "to_work" else "is_commute_to_home"
    drives = db.execute(
        f"SELECT id, vin, start_time, end_time FROM drives WHERE user_id=? AND {col}=1",
        (user["id"],)
    ).fetchall()

    if not drives:
        db.close()
        return {"has_data": False, "reason": "no_commutes"}

    commute_stops = []
    for d in drives:
        rows = db.execute("""
            SELECT s.*,
                CAST((julianday(s.ts) - julianday(?)) * 86400 AS INTEGER) AS elapsed_seconds
            FROM stops s
            WHERE s.user_id=? AND s.ts >= ? AND s.ts <= ?
        """, (d["start_time"], user["id"], d["start_time"], d["end_time"])).fetchall()
        commute_stops.extend([dict(r) for r in rows])

    # Collect observed departure times-of-day for scan window sizing
    dep_times = []
    for d in drives:
        try:
            dt = datetime.fromisoformat(d["start_time"].replace("Z", "+00:00"))
            dep_times.append(dt.hour * 3600 + dt.minute * 60 + dt.second)
        except Exception:
            pass

    db.close()
    return compute_optimal_departure(commute_stops, dep_times)


@app.get("/api/drives/efficiency")
def efficiency(user=Depends(get_current_user)):
    db = get_db()
    rows = db.execute("SELECT * FROM drives WHERE user_id=? ORDER BY start_time ASC", (user["id"],)).fetchall()
    db.close()
    return efficiency_by_drive([dict(r) for r in rows])


@app.get("/api/drives/tracks")
def drive_tracks(start: str = "", end: str = "", limit: int = 500, user=Depends(get_current_user)):
    db = get_db()
    where_parts = ["distance_miles > 0.1", "end_time IS NOT NULL", "d.user_id=?"]
    params: list = [user["id"]]
    if start:
        where_parts.append("start_time >= ?")
        params.append(start)
    if end:
        where_parts.append("start_time <= ?")
        params.append(end + "T23:59:59")
    where = "WHERE " + " AND ".join(where_parts)
    drive_rows = db.execute(
        f"SELECT id, vin, start_time, end_time, matched_route, start_lat, start_lon FROM drives d {where} ORDER BY start_time DESC LIMIT ?",
        params + [limit],
    ).fetchall()

    result = []
    for d in drive_rows:
        if d["matched_route"]:
            points = json.loads(d["matched_route"])
        else:
            pts = db.execute(
                """SELECT latitude, longitude FROM snapshots
                   WHERE vin=? AND ts>=? AND ts<=?
                     AND is_driving=1 AND latitude IS NOT NULL AND longitude IS NOT NULL
                   ORDER BY ts ASC""",
                (d["vin"], d["start_time"], d["end_time"]),
            ).fetchall()
            points = [[r["latitude"], r["longitude"]] for r in pts]
            slat, slon = d["start_lat"], d["start_lon"]
            if slat and slon and points and haversine(slat, slon, points[0][0], points[0][1]) > 0.05:
                points.insert(0, [slat, slon])
        if len(points) >= 2:
            result.append({
                "id": d["id"],
                "date": d["start_time"][:10],
                "points": points,
            })

    db.close()
    return result


# ── Acceleration ─────────────────────────────────────────────────────────────

@app.get("/api/acceleration/runs")
def acceleration_runs(limit: int = 10, user=Depends(get_current_user)):
    db = get_db()
    rows = db.execute(
        "SELECT * FROM acceleration_runs WHERE user_id=? ORDER BY time_0_to_60 ASC LIMIT ?", (user["id"], limit)
    ).fetchall()
    db.close()
    return [dict(r) for r in rows]


@app.get("/api/acceleration/top-speed")
def telemetry_top_speed(user=Depends(get_current_user)):
    db = get_db()
    row = db.execute("SELECT top_speed, updated_at FROM telemetry_stats WHERE user_id=? LIMIT 1", (user["id"],)).fetchone()
    db.close()
    return dict(row) if row else {"top_speed": None, "updated_at": None}


# ── Battery ───────────────────────────────────────────────────────────────────

@app.get("/api/battery/degradation")
def degradation(user=Depends(get_current_user)):
    db = get_db()
    snapshots = [dict(r) for r in db.execute(
        "SELECT ts, battery_level, battery_range FROM snapshots WHERE user_id=? ORDER BY ts ASC", (user["id"],)
    ).fetchall()]
    drives = [dict(r) for r in db.execute(
        "SELECT energy_used_kwh, distance_miles FROM drives WHERE user_id=? AND energy_used_kwh > 0 AND distance_miles > 0.5",
        (user["id"],)
    ).fetchall()]
    vehicle_row = db.execute("SELECT data FROM vehicles WHERE user_id=? LIMIT 1", (user["id"],)).fetchone()
    db.close()

    trim = "74"
    if vehicle_row:
        try:
            trim = json.loads(vehicle_row["data"]).get("vehicle_config", {}).get("trim_badging") or trim
        except Exception:
            pass

    original_kwh, epa_miles = specs_for_trim(trim)
    consumption = avg_consumption_from_drives(drives, trim)
    # Tesla's battery_range is EPA-normalized, so capacity back-calculation must
    # use EPA efficiency — not actual driving consumption, which would inflate results.
    epa_consumption = original_kwh / epa_miles
    return {
        "series": degradation_series(snapshots, epa_consumption, trim),
        "consumption_kwh_per_mi": round(consumption, 4),
        "consumption_source": "drives" if sum(d.get("distance_miles", 0) for d in drives) >= 50 else "epa_spec",
        "trim_badging": trim,
        "original_kwh": original_kwh,
        "epa_miles": epa_miles,
    }


@app.get("/api/battery/history")
def battery_history(days: int = 30, user=Depends(get_current_user)):
    since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    db = get_db()
    rows = db.execute("""
        SELECT ts, battery_level, battery_range, charging_state
        FROM snapshots WHERE user_id=? AND ts > ? ORDER BY ts ASC
    """, (user["id"], since)).fetchall()
    db.close()
    points, last_ts = [], None
    for r in rows:
        ts = r["ts"]
        if last_ts is None or (ts[:15] != last_ts[:15]):
            points.append(dict(r))
            last_ts = ts
    return points


# ── Stops ─────────────────────────────────────────────────────────────────────

@app.get("/api/stops")
def stops(limit: int = 50, user=Depends(get_current_user)):
    db = get_db()
    rows = db.execute("SELECT * FROM stops WHERE user_id=? ORDER BY ts DESC", (user["id"],)).fetchall()
    db.close()
    return cluster_stops_with_cycles([dict(r) for r in rows])[:limit]


@app.get("/api/drives/monthly")
def drives_monthly(user=Depends(get_current_user)):
    db = get_db()
    rows = db.execute("""
        SELECT SUBSTR(start_time, 1, 7) as month,
               COUNT(*) as drives,
               ROUND(SUM(distance_miles), 1) as miles,
               ROUND(SUM(COALESCE(energy_used_kwh, 0)), 1) as kwh
        FROM drives
        WHERE user_id=? AND start_time IS NOT NULL
        GROUP BY month ORDER BY month ASC
    """, (user["id"],)).fetchall()
    db.close()
    return [dict(r) for r in rows]


@app.get("/api/drives/destinations")
def drives_destinations(limit: int = 20, user=Depends(get_current_user)):
    db = get_db()
    rows = db.execute(
        "SELECT end_lat, end_lon, start_time FROM drives WHERE user_id=? AND end_lat IS NOT NULL",
        (user["id"],)
    ).fetchall()
    db.close()
    return destination_clusters([dict(r) for r in rows])[:limit]


@app.get("/api/drives/speed-histogram")
def drives_speed_histogram(user=Depends(get_current_user)):
    db = get_db()
    rows = db.execute(
        "SELECT speed FROM snapshots WHERE user_id=? AND is_driving=1 AND speed IS NOT NULL",
        (user["id"],)
    ).fetchall()
    db.close()
    return speed_histogram_bands([dict(r) for r in rows])


@app.delete("/api/stops")
def delete_stop_cluster(body: dict, user=Depends(get_current_user)):
    from analytics import haversine
    lat, lon = body.get("lat"), body.get("lon")
    if lat is None or lon is None:
        raise HTTPException(400, "lat and lon required")
    db = get_db()
    rows = db.execute("SELECT id, latitude, longitude FROM stops WHERE user_id=?", (user["id"],)).fetchall()
    ids = [r["id"] for r in rows if haversine(lat, lon, r["latitude"], r["longitude"]) <= 0.03]
    if ids:
        db.execute(f"DELETE FROM stops WHERE id IN ({','.join('?'*len(ids))})", ids)
        db.commit()
    db.close()
    return {"deleted": len(ids)}


# ── Config ────────────────────────────────────────────────────────────────────

@app.get("/api/config")
def config():
    return {
        "home_set": not (HOME_LAT != HOME_LAT),
        "work_set": not (WORK_LAT != WORK_LAT),
        "home_lat": HOME_LAT if HOME_LAT == HOME_LAT else None,
        "home_lon": HOME_LON if HOME_LON == HOME_LON else None,
        "work_lat": WORK_LAT if WORK_LAT == WORK_LAT else None,
        "work_lon": WORK_LON if WORK_LON == WORK_LON else None,
        "client_id_set": bool(os.environ.get("TESLA_CLIENT_ID", "").strip()),
        "redirect_uri": os.environ.get("TESLA_REDIRECT_URI", ""),
    }


_gas_price_history_cache: dict = {"data": None, "fetched_at": None}

def _fetch_gas_price_history(api_key: str) -> list[dict]:
    """Fetch full weekly PADD 4 gas price history from EIA. Sorted ascending. Cached 24h."""
    global _gas_price_history_cache
    now = datetime.now(timezone.utc)
    cached = _gas_price_history_cache
    if (cached["data"] is not None and cached["fetched_at"] is not None and
            (now - cached["fetched_at"]).total_seconds() < 86400):
        return cached["data"]
    try:
        import requests as _req
        resp = _req.get(
            "https://api.eia.gov/v2/petroleum/pri/gnd/data/",
            params={
                "api_key": api_key, "frequency": "weekly",
                "data[0]": "value", "facets[product][]": "EPMR",
                "facets[duoarea][]": "R40",
                "sort[0][column]": "period", "sort[0][direction]": "desc",
                "length": "500",
            }, timeout=10,
        )
        if resp.ok:
            pts = resp.json().get("response", {}).get("data", [])
            history = sorted(
                [{"period": p["period"], "price": float(p["value"])}
                 for p in pts if p.get("value")],
                key=lambda x: x["period"]
            )
            _gas_price_history_cache["data"] = history
            _gas_price_history_cache["fetched_at"] = now
            return history
    except Exception as e:
        log.warning(f"EIA history fetch failed: {e}")
    return cached["data"] or []


def _price_for_date(history: list[dict], date_str: str) -> float | None:
    """Return the most recent weekly price on or before date_str. history must be asc-sorted."""
    best = None
    for item in history:
        if item["period"] <= date_str[:10]:
            best = item["price"]
        else:
            break
    return best


@app.get("/api/charges/gas-savings")
def gas_savings(mpg: float = 22.0, user=Depends(get_current_user)):
    db = get_db()
    # Use actual miles driven per month from drives table — charge_miles_added
    # overstates miles because partial top-ups are counted multiple times.
    monthly_rows = db.execute("""
        SELECT SUBSTR(start_time,1,7) as month,
               ROUND(SUM(distance_miles),1) as miles
        FROM drives WHERE user_id=? AND start_time IS NOT NULL
        GROUP BY month ORDER BY month ASC
    """, (user["id"],)).fetchall()

    total_miles_row = db.execute(
        "SELECT COALESCE(SUM(distance_miles),0) as total FROM drives WHERE user_id=?",
        (user["id"],)
    ).fetchone()
    db.close()

    eia_key = os.environ.get("EIA_API_KEY", "").strip()
    history = _fetch_gas_price_history(eia_key) if eia_key else []
    has_history = bool(history)
    fallback_price = 3.40

    total_cost_avoided = 0.0
    total_gallons = 0.0

    for row in monthly_rows:
        miles = float(row["miles"] or 0)
        if miles <= 0:
            continue
        # Use the gas price from the middle of that month as representative
        mid_month = row["month"] + "-15"
        price = (_price_for_date(history, mid_month) if has_history else None) or fallback_price
        gallons = miles / mpg
        total_gallons += gallons
        total_cost_avoided += gallons * price

    current_price = history[-1]["price"] if history else fallback_price
    current_price_date = history[-1]["period"] if history else None

    return {
        "total_miles": round(float(total_miles_row["total"]), 1),
        "gas_equivalent_gallons": round(total_gallons, 1),
        "gas_price_per_gallon": current_price,
        "gas_price_date": current_price_date or "estimate",
        "gas_cost_avoided": round(total_cost_avoided, 2),
        "assumed_mpg": mpg,
        "monthly_miles": [dict(r) for r in monthly_rows],
        "has_eia_key": bool(eia_key),
        "price_is_live": has_history,
    }


@app.post("/api/refresh")
async def refresh(background_tasks: BackgroundTasks, user=Depends(get_current_user)):
    background_tasks.add_task(import_history, user_id=user["id"])
    return {"status": "refreshing"}


# ── Dashcam ──────────────────────────────────────────────────────────────────

def _dashcam_user_root(user_id: int) -> Path:
    root = DASHCAM_ROOT / str(user_id)
    root.mkdir(parents=True, exist_ok=True)
    return root


def _safe_dashcam_path(user_id: int, relative_path: str) -> Path:
    if relative_path.startswith("@direct/"):
        if user_id != DASHCAM_DIRECT_USER_ID:
            raise HTTPException(403, "Direct dashcam library is unavailable")
        direct_relative = relative_path[len("@direct/"):].lstrip("/")
        if direct_relative.split("/", 1)[0] not in DASHCAM_DIRECT_FOLDERS:
            raise HTTPException(400, "Invalid direct dashcam path")
        root = DASHCAM_ROOT.resolve()
        candidate = (root / direct_relative).resolve()
        if root not in candidate.parents:
            raise HTTPException(400, "Invalid dashcam path")
        return candidate
    root = _dashcam_user_root(user_id).resolve()
    candidate = (root / relative_path.lstrip("/")).resolve()
    if candidate != root and root not in candidate.parents:
        raise HTTPException(400, "Invalid dashcam path")
    return candidate


def _dashcam_type(path: str) -> str:
    lowered = path.lower()
    if "sentryclips" in lowered:
        return "Sentry"
    if "savedclips" in lowered:
        return "Saved"
    if "recentclips" in lowered:
        return "Recent"
    return "Clip"


def _dashcam_event_metadata(directory: Path) -> dict | None:
    event_file = directory / "event.json"
    if not event_file.is_file():
        return None
    try:
        data = json.loads(event_file.read_text())
        timestamp = datetime.fromisoformat(str(data.get("timestamp", "")))
        reason = str(data.get("reason", "event"))
        labels = {
            "user_interaction_honk": "Honk",
            "user_interaction_dashcam_icon_tapped": "Manual save",
            "sentry_aware_object_detection": "Sentry",
            "sentry_aware_accel": "Sentry impact",
            "sentry_aware_acceleration": "Sentry impact",
            "hard_braking": "Hard braking",
        }
        camera_id = str(data.get("camera", ""))
        # Tesla encodes the triggering camera numerically in event.json.
        # Tesla DAS camera IDs used by event.json (validated against the
        # corresponding event thumbnail and camera frames).
        camera_names = {"0": "front", "5": "left_repeater", "6": "right_repeater", "7": "back"}
        return {
            "timestamp": timestamp,
            "reason": reason,
            "label": labels.get(reason, reason.replace("_", " ").title()),
            "camera": camera_names.get(camera_id),
        }
    except Exception as exc:
        log.warning("Invalid TeslaCam event metadata %s: %s", event_file, exc)
        return None


def _media_user(media_token: str) -> int:
    user_id = _dashcam_media_tokens.get(media_token)
    if not user_id:
        raise HTTPException(401, "Invalid media token")
    return user_id


@app.get("/api/dashcam/events")
def dashcam_events(user=Depends(get_current_user)):
    root = _dashcam_user_root(user["id"])
    groups: dict[str, dict] = {}
    total_bytes = 0
    scan_roots = [(root, "")]
    if user["id"] == DASHCAM_DIRECT_USER_ID:
        scan_roots.extend(
            (DASHCAM_ROOT / folder, f"@direct/{folder}")
            for folder in DASHCAM_DIRECT_FOLDERS
            if (DASHCAM_ROOT / folder).is_dir()
        )
    metadata_cache: dict[Path, dict | None] = {}
    for scan_root, prefix in scan_roots:
      for path in scan_root.rglob("*.mp4"):
        if not path.is_file() or path.name.startswith("."):
            continue
        match = _dashcam_clip_re.match(path.name)
        if not match:
            continue
        scanned_relative = path.relative_to(scan_root).as_posix()
        relative = f"{prefix}/{scanned_relative}" if prefix else scanned_relative
        parent_relative = path.parent.relative_to(scan_root).as_posix()
        group_key = f"{prefix}/{parent_relative}/{match.group(1)}" if prefix else f"{parent_relative}/{match.group(1)}"
        item = groups.setdefault(group_key, {
            "id": group_key,
            "timestamp": match.group(1),
            "type": _dashcam_type(relative),
            "cameras": {},
            "bytes": 0,
            "is_event": False,
            "event_offset": None,
            "event_reason": None,
            "event_label": None,
            "event_camera": None,
            "thumbnail": None,
        })
        if path.parent not in metadata_cache:
            metadata_cache[path.parent] = _dashcam_event_metadata(path.parent)
        metadata = metadata_cache[path.parent]
        if metadata:
            thumb = path.parent / "thumb.png"
            if thumb.is_file():
                thumb_relative = thumb.relative_to(scan_root).as_posix()
                item["thumbnail"] = f"{prefix}/{thumb_relative}" if prefix else thumb_relative
            clip_start = datetime.strptime(match.group(1), "%Y-%m-%d_%H-%M-%S")
            offset = (metadata["timestamp"] - clip_start).total_seconds()
            # Tesla's individual camera files are approximately one minute long.
            if 0 <= offset < 90:
                item.update({
                    "is_event": True,
                    "event_offset": round(offset, 2),
                    "event_reason": metadata["reason"],
                    "event_label": metadata["label"],
                    "event_camera": metadata["camera"],
                })
        size = path.stat().st_size
        item["cameras"][match.group(2).lower()] = {"path": relative, "bytes": size}
        item["bytes"] += size
        total_bytes += size

    media_token = uuid.uuid4().hex
    _dashcam_media_tokens[media_token] = user["id"]
    if len(_dashcam_media_tokens) > 1000:
        for key in list(_dashcam_media_tokens)[:500]:
            _dashcam_media_tokens.pop(key, None)
    events = sorted(groups.values(), key=lambda item: item["timestamp"], reverse=True)
    return {"events": events, "total_bytes": total_bytes, "media_token": media_token}


@app.put("/api/dashcam/files")
async def upload_dashcam_file(request: Request, path: str, user=Depends(get_current_user)):
    if not _dashcam_clip_re.match(Path(path).name):
        raise HTTPException(400, "Only TeslaCam MP4 files are supported")
    destination = _safe_dashcam_path(user["id"], path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_name(f".{destination.name}.{uuid.uuid4().hex}.part")
    try:
        with partial.open("wb") as output:
            async for chunk in request.stream():
                output.write(chunk)
        partial.replace(destination)
    except Exception:
        partial.unlink(missing_ok=True)
        raise
    return {"path": path, "bytes": destination.stat().st_size}


@app.get("/api/dashcam/media")
def dashcam_media(request: Request, path: str, media_token: str):
    user_id = _media_user(media_token)
    source = _safe_dashcam_path(user_id, path)
    if not source.is_file():
        raise HTTPException(404, "Clip not found")
    size = source.stat().st_size
    media_type = "image/png" if source.suffix.lower() == ".png" else "video/mp4"
    if media_type == "image/png":
        return FileResponse(source, media_type=media_type, headers={"Cache-Control": "private, max-age=3600"})
    range_header = request.headers.get("range", "")
    start, end = 0, size - 1
    status_code = 200
    if range_header.startswith("bytes="):
        try:
            requested_start, requested_end = range_header[6:].split("-", 1)
            if requested_start:
                start = int(requested_start)
                end = int(requested_end) if requested_end else size - 1
            elif requested_end:
                start = max(0, size - int(requested_end))
            end = min(end, size - 1)
            if start < 0 or start > end:
                raise ValueError
            status_code = 206
        except ValueError:
            raise HTTPException(416, "Invalid byte range")

    length = end - start + 1
    def chunks():
        remaining = length
        with source.open("rb") as video:
            video.seek(start)
            while remaining:
                chunk = video.read(min(1024 * 1024, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

    headers = {
        "Accept-Ranges": "bytes",
        "Content-Length": str(length),
        "Cache-Control": "private, max-age=3600",
    }
    if status_code == 206:
        headers["Content-Range"] = f"bytes {start}-{end}/{size}"
    return StreamingResponse(chunks(), status_code=status_code, media_type=media_type, headers=headers)


@app.get("/api/dashcam/preview")
def dashcam_preview(path: str, at: float, media_token: str):
    user_id = _media_user(media_token)
    source = _safe_dashcam_path(user_id, path)
    if not source.is_file() or source.suffix.lower() != ".mp4":
        raise HTTPException(404, "Clip not found")
    at = max(0.0, min(float(at), 90.0))
    cache_root = DASHCAM_ROOT / ".preview-cache"
    cache_root.mkdir(parents=True, exist_ok=True)
    fingerprint = hashlib.sha256(f"{source}:{source.stat().st_mtime_ns}:{at:.2f}".encode()).hexdigest()
    preview = cache_root / f"{fingerprint}.jpg"
    if not preview.is_file():
        if not shutil.which("ffmpeg"):
            raise HTTPException(503, "Preview generator is unavailable")
        partial = preview.with_suffix(".part.jpg")
        result = subprocess.run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-ss", str(at),
            "-i", str(source), "-frames:v", "1", "-vf", "scale=320:-2", "-q:v", "4", str(partial),
        ], capture_output=True, timeout=30)
        if result.returncode != 0:
            partial.unlink(missing_ok=True)
            # Some Tesla event timestamps land in a recording gap or beyond a
            # short final segment. Use the last decodable frame rather than a
            # broken image while keeping it tied to the same playable MP4.
            result = subprocess.run([
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-sseof", "-0.25",
                "-i", str(source), "-frames:v", "1", "-vf", "scale=320:-2", "-q:v", "4", str(partial),
            ], capture_output=True, timeout=30)
            if result.returncode != 0:
                partial.unlink(missing_ok=True)
                raise HTTPException(500, "Could not generate preview")
        partial.replace(preview)
    return FileResponse(preview, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=86400"})


@app.delete("/api/dashcam/events")
def delete_dashcam_event(body: dict, user=Depends(get_current_user)):
    camera_paths = [str(path) for path in body.get("camera_paths", [])]
    if not camera_paths:
        raise HTTPException(400, "Camera paths are required")
    sources = [_safe_dashcam_path(user["id"], path) for path in camera_paths]
    existing = [path for path in sources if path.is_file()]
    if not existing:
        raise HTTPException(404, "Clip not found")
    parent = existing[0].parent
    # Tesla Saved/Sentry folders contain event.json and represent one complete event.
    if (parent / "event.json").is_file():
        root = DASHCAM_ROOT.resolve()
        if parent.resolve() == root or root not in parent.resolve().parents:
            raise HTTPException(400, "Unsafe event path")
        reclaimed = sum(path.stat().st_size for path in parent.rglob("*") if path.is_file())
        shutil.rmtree(parent)
        return {"deleted": "event", "bytes": reclaimed}
    reclaimed = sum(path.stat().st_size for path in existing)
    for path in existing:
        path.unlink(missing_ok=True)
    return {"deleted": "clip", "bytes": reclaimed}


@app.post("/api/dashcam/edit")
def edit_dashcam_clip(body: dict, background_tasks: BackgroundTasks, user=Depends(get_current_user)):
    requested = body.get("segments") or []
    if not requested or len(requested) > 50:
        raise HTTPException(400, "One to 50 edit segments are required")
    if not shutil.which("ffmpeg"):
        raise HTTPException(503, "Video editor is unavailable")
    segments = []
    for segment in requested:
        source = _safe_dashcam_path(user["id"], str(segment.get("path", "")))
        start = max(0.0, float(segment.get("start", 0)))
        end = float(segment.get("end", 0))
        if not source.is_file() or end <= start or end - start > 600:
            raise HTTPException(400, "Invalid edit segment")
        segments.append((source, start, end))

    crop = str(body.get("crop", "original"))
    crop_filters = {
        "original": "",
        "16:9": "crop='min(iw,ih*16/9)':'min(ih,iw*9/16)',",
        "1:1": "crop='min(iw,ih)':'min(iw,ih)',",
        "9:16": "crop='min(iw,ih*9/16)':'min(ih,iw*16/9)',",
    }
    if crop not in crop_filters:
        raise HTTPException(400, "Invalid crop preset")

    handle, output_name = tempfile.mkstemp(prefix="teslacam-", suffix=".mp4")
    os.close(handle)
    try:
        command = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"]
        for source, start, end in segments:
            command.extend(["-ss", str(start), "-t", str(end - start), "-i", str(source)])
        filters = []
        for index in range(len(segments)):
            filters.append(f"[{index}:v]{crop_filters[crop]}setpts=PTS-STARTPTS[v{index}]")
        joined = "".join(f"[v{index}]" for index in range(len(segments)))
        filters.append(f"{joined}concat=n={len(segments)}:v=1:a=0[outv]")
        command.extend([
            "-filter_complex", ";".join(filters), "-map", "[outv]",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
            "-pix_fmt", "yuv420p", "-movflags", "+faststart", output_name,
        ])
        result = subprocess.run(command, capture_output=True, timeout=600)
        if result.returncode != 0:
            log.error("Dashcam edit failed: %s", result.stderr.decode(errors="replace")[-2000:])
            raise HTTPException(500, "Could not render edited clip")
    except Exception:
        Path(output_name).unlink(missing_ok=True)
        raise
    camera = _dashcam_clip_re.match(segments[0][0].name).group(2)
    download_name = f"teslacam-{camera}-edit.mp4"
    return FileResponse(
        output_name,
        media_type="video/mp4",
        filename=download_name,
        background=BackgroundTask(lambda: Path(output_name).unlink(missing_ok=True)),
    )
