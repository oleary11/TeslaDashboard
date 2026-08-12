"""
Background data collector with adaptive polling.

Drive lifecycle is owned by the MQTT stream (Gear=D / Gear=P events from fleet
telemetry) so drive start/end times are exact to the second without any polling.
The REST API poller is used only when the car is parked or charging — never during
an active drive — which eliminates Data API calls while driving.

Polling strategy (avoids unnecessary wake-ups):
  - State check runs every 30s but only hits the lightweight /vehicles list
  - vehicle_data is only fetched when car is already awake AND no MQTT drive active
  - Fetch interval scales with activity:
      charging  → every 2min (charge curve resolution)
      idle      → every 5min (minimal drain)
  - After 15 min of consecutive idle snapshots → skip data fetch until state changes
    (car will go to sleep on its own; next state change wakes us back up)
"""
import os
import json
import logging
import threading
from datetime import datetime, timezone, timedelta

from db import get_db
from tesla_api import get_vehicle, get_vehicle_data, get_charge_history
from analytics import tag_commutes


def _run_map_match(drive_id: int, user_id: int):
    try:
        from map_match import match_drive
        match_drive(drive_id, user_id)
    except Exception as e:
        log.error(f"Map match error drive {drive_id}: {e}")

log = logging.getLogger(__name__)

def _coord(key): return float(os.environ.get(key) or "nan")
HOME_LAT = _coord("HOME_LAT")
HOME_LON = _coord("HOME_LON")
WORK_LAT = _coord("WORK_LAT")
WORK_LON = _coord("WORK_LON")

IDLE_BACKOFF_MINUTES  = 15
DRIVING_INTERVAL_S    = 60
CHARGING_INTERVAL_S   = 120
IDLE_INTERVAL_S       = 300   # 5 min once car has been idle for IDLE_BACKOFF_MINUTES
WAKE_ALERT_SECONDS    = 60    # poll at driving rate for this long after car wakes from sleep
STATE_CHECK_INTERVAL_S = 30   # how often to call /vehicles when not driving

_user_states: dict = {}
_vin_drive_start_hint: dict[str, str] = {}  # vin → ISO timestamp from Gear=D MQTT event
_vin_mqtt_drive: dict[str, dict | None] = {}  # vin → active drive state managed by MQTT stream


def hint_drive_start(vin: str, ts: str):
    """Store the exact timestamp of a Gear=D MQTT event for use as drive start_time."""
    _vin_drive_start_hint[vin] = ts


# ── MQTT-driven drive lifecycle ───────────────────────────────────────────────

def start_mqtt_drive(vin: str, ts: str, lat, lon, odometer, soc, user_id: int):
    """Called by the MQTT Gear=D handler. Captures drive start with exact timestamp."""
    _vin_mqtt_drive[vin] = {
        "ts": ts, "lat": lat, "lon": lon,
        "odometer": odometer, "soc": soc,
        "max_speed": 0.0, "user_id": user_id,
    }
    hint_drive_start(vin, ts)  # keep for poller-fallback path
    log.info(f"MQTT drive start {vin}: ts={ts} odo={odometer} soc={soc}%")


def end_mqtt_drive(vin: str, end_ts: str, end_lat, end_lon, end_odo, end_soc):
    """Called by the MQTT Gear=P handler. Finalizes and writes the drive record."""
    drive = _vin_mqtt_drive.pop(vin, None)
    if not drive:
        return

    user_id = drive["user_id"]
    start_dt = datetime.fromisoformat(drive["ts"].replace("Z", "+00:00"))
    end_dt   = datetime.fromisoformat(end_ts.replace("Z", "+00:00"))
    duration = int((end_dt - start_dt).total_seconds())

    distance = None
    if drive["odometer"] is not None and end_odo is not None:
        distance = round(end_odo - drive["odometer"], 2)
    if not distance or distance < 0.1:
        log.info(f"MQTT drive end {vin}: skipped (dist={distance}, duration={duration}s)")
        _sync_poller_state_after_drive(user_id)
        return

    db = get_db()
    rows = db.execute(
        "SELECT power, ts FROM snapshots WHERE vin=? AND user_id=? AND ts>=? AND ts<=? "
        "AND is_driving=1 AND power IS NOT NULL ORDER BY ts ASC",
        (vin, user_id, drive["ts"], end_ts)
    ).fetchall()
    energy_kwh = None
    if len(rows) > 1:
        total = 0.0
        for i in range(1, len(rows)):
            dt_sec = (datetime.fromisoformat(rows[i]["ts"].replace("Z", "+00:00")) -
                      datetime.fromisoformat(rows[i-1]["ts"].replace("Z", "+00:00"))).total_seconds()
            if dt_sec > 300:
                continue
            pwr = rows[i-1]["power"] or 0
            total += pwr * dt_sec / 3600
        energy_kwh = round(total, 3) if total > 0 else None

    try:
        db.execute("""
            INSERT OR IGNORE INTO drives
            (vin, start_time, end_time, start_lat, start_lon, end_lat, end_lon,
             start_odometer, end_odometer, distance_miles, duration_seconds, max_speed,
             energy_used_kwh, start_soc, end_soc, user_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """, (
            vin, drive["ts"], end_ts,
            drive["lat"], drive["lon"], end_lat, end_lon,
            drive["odometer"], end_odo, distance, duration,
            drive["max_speed"], energy_kwh,
            drive["soc"], end_soc,
            user_id,
        ))
        if db.execute("SELECT changes()").fetchone()[0]:
            home_lat, home_lon, work_lat, work_lon = _get_user_coords(user_id)
            drive_row = db.execute("SELECT * FROM drives WHERE vin=? AND start_time=?",
                                   (vin, drive["ts"])).fetchone()
            if drive_row:
                tagged = tag_commutes([dict(drive_row)], home_lat, home_lon, work_lat, work_lon)
                d = tagged[0]
                db.execute(
                    "UPDATE drives SET is_commute_to_work=?, is_commute_to_home=? WHERE vin=? AND start_time=?",
                    (d["is_commute_to_work"], d["is_commute_to_home"], vin, drive["ts"])
                )
            log.info(f"MQTT drive recorded: {distance:.1f}mi {duration//60}min (user {user_id})")
            if drive_row:
                drive_id = drive_row["id"]
                db.commit()
                threading.Thread(target=_run_map_match, args=(drive_id, user_id), daemon=True).start()
    except Exception as e:
        log.error(f"MQTT drive insert error (user {user_id}): {e}")

    db.commit()
    db.close()
    _sync_poller_state_after_drive(user_id)


def _sync_poller_state_after_drive(user_id: int):
    """Reset poller drive state so it doesn't try to re-start or re-finalize the drive."""
    s = _user_states.get(user_id)
    if s:
        s["drive_start"] = None
        s["drive_max_speed"] = 0
        s["is_driving"] = False
        s["was_driving"] = False


def is_mqtt_drive_active(vin: str) -> bool:
    return bool(_vin_mqtt_drive.get(vin))


def has_active_mqtt_drive_for_user(user_id: int) -> bool:
    return any(d and d.get("user_id") == user_id for d in _vin_mqtt_drive.values())


def update_mqtt_drive_speed(vin: str, speed: float):
    d = _vin_mqtt_drive.get(vin)
    if d is not None:
        d["max_speed"] = max(d["max_speed"], speed)


def _get_user_state(user_id: int) -> dict:
    if user_id not in _user_states:
        state = {

            "last_activity": None,
            "last_fetch": None,
            "last_state": "",
            "is_driving": False,
            "was_driving": False,
            "drive_start": None,
            "drive_max_speed": 0,
            "drive_energy_start": None,
            "charge_start": None,
            "wake_alert_until": None,
        }
        _recover_drive_state(user_id, state)
        _user_states[user_id] = state
    return _user_states[user_id]


def _recover_drive_state(user_id: int, state: dict):
    """Restore in-progress drive from DB after a restart."""
    try:
        db = get_db()
        # Check if the latest snapshot is actively driving
        latest = db.execute(
            "SELECT ts, is_driving, latitude, longitude, odometer, speed FROM snapshots "
            "WHERE user_id=? ORDER BY ts DESC LIMIT 1", (user_id,)
        ).fetchone()
        if not latest or not latest["is_driving"]:
            db.close()
            return
        latest_ts = datetime.fromisoformat(latest["ts"].replace("Z", "+00:00"))
        if (_now() - latest_ts).total_seconds() > 1800:
            db.close()
            return

        # Walk back to find the beginning of the continuous driving sequence
        candidates = db.execute(
            "SELECT ts, latitude, longitude, odometer, speed, battery_level FROM snapshots "
            "WHERE user_id=? AND is_driving=1 AND battery_level IS NOT NULL "
            "ORDER BY ts DESC LIMIT 100", (user_id,)
        ).fetchall()
        db.close()

        if not candidates:
            return

        # Find the first row in the uninterrupted driving block
        start_row = candidates[-1]
        for i in range(len(candidates) - 2, -1, -1):
            cur_ts = datetime.fromisoformat(candidates[i]["ts"].replace("Z", "+00:00"))
            prev_ts = datetime.fromisoformat(candidates[i + 1]["ts"].replace("Z", "+00:00"))
            if (cur_ts - prev_ts).total_seconds() > 300:
                start_row = candidates[i]
                break

        state["drive_start"] = {
            "ts": start_row["ts"],
            "lat": start_row["latitude"],
            "lon": start_row["longitude"],
            "odometer": start_row["odometer"],
            "soc": start_row["battery_level"],
        }
        state["drive_max_speed"] = max((r["speed"] or 0) for r in candidates)
        state["is_driving"] = True
        state["was_driving"] = True
        state["last_activity"] = _now()
        log.info(f"Recovered in-progress drive for user {user_id} from {start_row['ts']}")
    except Exception as e:
        log.error(f"Drive state recovery error (user {user_id}): {e}")


def _get_user_coords(user_id: int) -> tuple:
    db = get_db()
    row = db.execute("SELECT home_lat, home_lon, work_lat, work_lon FROM users WHERE id=?", (user_id,)).fetchone()
    db.close()
    if row:
        return row["home_lat"], row["home_lon"], row["work_lat"], row["work_lon"]
    return HOME_LAT, HOME_LON, WORK_LAT, WORK_LON


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ── History import ────────────────────────────────────────────────────────────

def import_history(vin: str | None = None, user_id: int = 1):
    try:
        vehicle = get_vehicle(vin, user_id=user_id)
        vehicle_id = vehicle["id"]
        actual_vin = vehicle["vin"]
        log.info(f"Importing history for {actual_vin} (user {user_id})")

        _upsert_vehicle(vehicle, user_id=user_id)
        _import_charges(vehicle_id, actual_vin, user_id=user_id)
        log.info("History import complete")
    except Exception as e:
        log.error(f"History import error (user {user_id}): {e}")


def import_history_all():
    db = get_db()
    rows = db.execute("SELECT DISTINCT user_id FROM tesla_tokens").fetchall()
    db.close()
    for row in rows:
        import_history(user_id=row["user_id"])


def _upsert_vehicle(vehicle: dict, vehicle_config: dict | None = None, user_id: int = 1):
    merged = dict(vehicle)
    if vehicle_config:
        merged["vehicle_config"] = vehicle_config
    elif not merged.get("vehicle_config"):
        # Preserve existing vehicle_config from DB so a basic poll doesn't wipe it
        db = get_db()
        existing = db.execute("SELECT data FROM vehicles WHERE vin=?", (merged.get("vin", ""),)).fetchone()
        db.close()
        if existing:
            try:
                prev_cfg = json.loads(existing["data"]).get("vehicle_config")
                if prev_cfg:
                    merged["vehicle_config"] = prev_cfg
            except Exception:
                pass
    db = get_db()
    db.execute("""
        INSERT INTO vehicles (vin, display_name, model, year, color, data, updated_at, user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(vin) DO UPDATE SET
            display_name=excluded.display_name,
            data=excluded.data,
            updated_at=excluded.updated_at,
            user_id=excluded.user_id
    """, (
        merged.get("vin", ""),
        merged.get("display_name", "My Tesla"),
        merged.get("model_name", "Model 3"),
        merged.get("year", ""),
        merged.get("exterior_color") or merged.get("color", ""),
        json.dumps(merged),
        now_iso(),
        user_id,
    ))
    db.commit()
    db.close()


def _import_charges(vehicle_id: int | str, vin: str, user_id: int = 1):
    history = get_charge_history(vehicle_id, user_id=user_id)
    if not history:
        return

    db = get_db()
    inserted = 0
    for ch in history:
        try:
            db.execute("""
                INSERT OR IGNORE INTO charges
                (vin, start_time, end_time, start_soc, end_soc, energy_added_kwh,
                 max_charger_power, charger_voltage, charge_miles_added, fast_charger, user_id)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)
            """, (
                vin,
                ch.get("chargeStartDateTime") or ch.get("timestamp"),
                ch.get("chargeStopDateTime"),
                ch.get("batteryLevelStart") or ch.get("soc_start"),
                ch.get("batteryLevelEnd") or ch.get("soc_end"),
                ch.get("energyAdded") or ch.get("charge_energy_added"),
                ch.get("maxPower") or ch.get("charger_power"),
                ch.get("chargerVoltage") or ch.get("charger_voltage"),
                ch.get("milesAdded") or ch.get("charge_miles_added_rated"),
                int(bool(ch.get("fastCharger") or ch.get("fast_charger_present"))),
                user_id,
            ))
            inserted += db.execute("SELECT changes()").fetchone()[0]
        except Exception as e:
            log.debug(f"Charge insert skip: {e}")
    db.commit()
    db.close()
    if inserted:
        log.info(f"Charges: inserted {inserted} new records (user {user_id})")


# ── Adaptive live poller ──────────────────────────────────────────────────────

def adaptive_tick(vin: str | None = None, user_id: int = 1):
    s = _get_user_state(user_id)

    # MQTT stream owns drive tracking — no Data API calls needed while driving.
    # All telemetry (location, speed, power, battery) arrives via fleet telemetry.
    if has_active_mqtt_drive_for_user(user_id):
        return

    # Poller-fallback: if MQTT missed the drive (stream offline/reconnecting), keep
    # polling so the drive is still tracked.
    if s.get("is_driving") and s.get("_cached_vehicle"):
        if _should_fetch_data(s):
            _fetch_and_store(s["_cached_vehicle"], s, user_id=user_id)
        return

    # Throttle state check when not driving — car state changes on the order of
    # minutes, not seconds. Bypass when last_state_check is None (force fetch requested).
    now = _now()
    last_sc = s.get("last_state_check")
    if last_sc and (now - last_sc).total_seconds() < STATE_CHECK_INTERVAL_S:
        return
    s["last_state_check"] = now

    try:
        vehicle = get_vehicle(vin, user_id=user_id)
    except Exception as e:
        log.debug(f"State check failed (user {user_id}): {e}")
        return

    s["_cached_vehicle"] = vehicle
    state = vehicle.get("state", "")

    if state != s["last_state"]:
        log.info(f"Vehicle state (user {user_id}): {s['last_state']!r} → {state!r}")
        was_inactive = s["last_state"] in ("asleep", "offline", "")
        s["last_state"] = state
        if was_inactive and state not in ("asleep", "offline"):
            # Car just woke from sleep — poll immediately to capture parked location,
            # then stay in fast-poll mode for WAKE_ALERT_SECONDS so drive start is
            # detected within one 10s interval of the user shifting to Drive.
            s["last_fetch"] = None
            s["last_activity"] = _now()
            s["wake_alert_until"] = _now() + timedelta(seconds=WAKE_ALERT_SECONDS)
            log.info(f"Wake alert active for user {user_id} — fast polling for {WAKE_ALERT_SECONDS}s")

    if state in ("asleep", "offline"):
        return

    if _should_fetch_data(s):
        _fetch_and_store(vehicle, s, user_id=user_id)


def adaptive_tick_all():
    db = get_db()
    rows = db.execute("SELECT DISTINCT user_id FROM tesla_tokens").fetchall()
    db.close()
    for row in rows:
        adaptive_tick(user_id=row["user_id"])


def _should_fetch_data(s: dict) -> bool:
    now = _now()

    if s["last_fetch"] is None:
        return True

    elapsed = (now - s["last_fetch"]).total_seconds()

    if s.get("is_driving"):
        return elapsed >= DRIVING_INTERVAL_S

    # Right after waking from sleep, poll fast so drive start is detected within one interval.
    if s.get("wake_alert_until") and now < s["wake_alert_until"]:
        return elapsed >= DRIVING_INTERVAL_S

    if s["last_activity"] and (now - s["last_activity"]) < timedelta(minutes=IDLE_BACKOFF_MINUTES):
        return elapsed >= CHARGING_INTERVAL_S

    return elapsed >= IDLE_INTERVAL_S


def _finalize_drive(s, end_ts, end_lat, end_lon, vehicle_state, charge, vin, db, user_id):
    start = s["drive_start"]
    start_odo = start["odometer"]
    end_odo = vehicle_state.get("odometer")
    distance = round(end_odo - start_odo, 2) if (end_odo and start_odo) else None
    if not distance or distance < 0.1:
        s["drive_start"] = None
        s["drive_max_speed"] = 0
        return

    start_dt = datetime.fromisoformat(start["ts"].replace("Z", "+00:00"))
    end_dt = datetime.fromisoformat(end_ts.replace("Z", "+00:00"))
    duration = int((end_dt - start_dt).total_seconds())

    energy_kwh = None
    # Only use snapshots with power data — GPS-only MQTT pings have power=NULL and
    # would compress polling intervals down to 1s, grossly underestimating energy.
    rows = db.execute(
        "SELECT power, ts FROM snapshots WHERE vin=? AND user_id=? AND ts>=? AND ts<=? AND is_driving=1 AND power IS NOT NULL ORDER BY ts ASC",
        (vin, user_id, start["ts"], end_ts)
    ).fetchall()
    if len(rows) > 1:
        total = 0.0
        for i in range(1, len(rows)):
            dt_sec = (datetime.fromisoformat(rows[i]["ts"].replace("Z","+00:00")) -
                      datetime.fromisoformat(rows[i-1]["ts"].replace("Z","+00:00"))).total_seconds()
            if dt_sec > 300:
                continue  # skip gaps (parked intervals between polling windows)
            pwr = rows[i-1]["power"] or 0
            total += pwr * dt_sec / 3600
        energy_kwh = round(total, 3) if total > 0 else None

    try:
        db.execute("""
            INSERT OR IGNORE INTO drives
            (vin, start_time, end_time, start_lat, start_lon, end_lat, end_lon,
             start_odometer, end_odometer, distance_miles, duration_seconds, max_speed,
             energy_used_kwh, start_soc, end_soc, user_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """, (
            vin, start["ts"], end_ts,
            start["lat"], start["lon"], end_lat, end_lon,
            start_odo, end_odo, distance, duration,
            s["drive_max_speed"],
            energy_kwh,
            start["soc"], charge.get("battery_level"),
            user_id,
        ))
        if db.execute("SELECT changes()").fetchone()[0]:
            home_lat, home_lon, work_lat, work_lon = _get_user_coords(user_id)
            drive_row = db.execute("SELECT * FROM drives WHERE vin=? AND start_time=?", (vin, start["ts"])).fetchone()
            if drive_row:
                tagged = tag_commutes([dict(drive_row)], home_lat, home_lon, work_lat, work_lon)
                d = tagged[0]
                db.execute(
                    "UPDATE drives SET is_commute_to_work=?, is_commute_to_home=? WHERE vin=? AND start_time=?",
                    (d["is_commute_to_work"], d["is_commute_to_home"], vin, start["ts"])
                )
            log.info(f"Drive recorded: {distance:.1f}mi {duration//60}min (user {user_id})")
            if drive_row:
                drive_id = drive_row["id"]
                db.commit()  # commit before thread so match_drive can read the row
                threading.Thread(
                    target=_run_map_match, args=(drive_id, user_id), daemon=True
                ).start()
    except Exception as e:
        log.error(f"Drive insert error (user {user_id}): {e}")

    s["drive_start"] = None
    s["drive_max_speed"] = 0


def _fetch_and_store(vehicle: dict, s: dict, user_id: int = 1):
    vehicle_id = vehicle["id"]
    try:
        data = get_vehicle_data(vehicle_id, user_id=user_id)
    except Exception as e:
        if "408" in str(e) or "timeout" in str(e).lower() or "unavailable" in str(e).lower():
            return
        log.error(f"vehicle_data error (user {user_id}): {e}")
        return

    if not data:
        return

    s["last_fetch"] = _now()

    cfg = data.get("vehicle_config")
    if cfg:
        _upsert_vehicle(vehicle, cfg, user_id=user_id)

    drive = data.get("drive_state", {})
    charge = data.get("charge_state", {})
    climate = data.get("climate_state", {})
    vehicle_state = data.get("vehicle_state", {})

    speed = drive.get("speed") or 0
    lat = drive.get("latitude")
    lon = drive.get("longitude")
    ts = now_iso()
    vin_actual = data.get("vin") or vehicle.get("vin", "")
    charging_state = charge.get("charging_state", "")
    is_driving = drive.get("shift_state") in ("D", "R", "N")

    was_driving = s["was_driving"]
    was_charging = s["charge_start"] is not None
    is_charging = charging_state == "Charging"

    if is_driving or is_charging:
        s["last_activity"] = _now()

    s["is_driving"] = is_driving

    # Charge session start
    if is_charging and not was_charging:
        s["charge_start"] = {
            "ts": ts, "lat": lat, "lon": lon,
            "soc": charge.get("battery_level"),
        }

    # Charge session end
    if not is_charging and was_charging:
        cs = s["charge_start"]
        energy = charge.get("charge_energy_added")
        start_soc = cs["soc"]
        end_soc = charge.get("battery_level")
        miles_added = charge.get("charge_miles_added_rated")
        if energy and energy > 0.05:
            try:
                db = get_db()
                db.execute("""
                    INSERT OR IGNORE INTO charges
                    (vin, start_time, end_time, start_soc, end_soc, energy_added_kwh,
                     max_charger_power, charger_voltage, charge_miles_added, fast_charger,
                     location_lat, location_lon, user_id)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
                """, (
                    vin_actual, cs["ts"], ts,
                    start_soc, end_soc, round(energy, 2),
                    charge.get("charger_power"), charge.get("charger_voltage"),
                    miles_added,
                    int(bool(charge.get("fast_charger_present"))),
                    cs["lat"], cs["lon"],
                    user_id,
                ))
                db.commit()
                db.close()
                log.info(f"Charge recorded: {energy:.1f}kWh {start_soc}%→{end_soc}% (user {user_id})")
            except Exception as e:
                log.error(f"Charge insert error: {e}")
        s["charge_start"] = None

    if is_driving and not was_driving:
        if is_mqtt_drive_active(vin_actual):
            # MQTT already recorded the exact drive start — sync poller state and skip.
            s["is_driving"] = True
            s["was_driving"] = True
            _vin_drive_start_hint.pop(vin_actual, None)
        else:
            # Poller fallback: MQTT stream was offline when Gear=D happened.
            # Use hint timestamp if available; only backdate to parked snapshot when
            # the gap is within one poll interval (≤90s) — genuine polling lag.
            start_ts = _vin_drive_start_hint.pop(vin_actual, None) or ts
            start_lat, start_lon = lat, lon
            try:
                db_look = get_db()
                cutoff = (datetime.fromisoformat(start_ts.replace("Z", "+00:00")) - timedelta(minutes=5)).isoformat()
                recent_parked = db_look.execute(
                    "SELECT latitude, longitude, ts FROM snapshots "
                    "WHERE user_id=? AND is_driving=0 AND latitude IS NOT NULL AND ts >= ? "
                    "ORDER BY ts DESC LIMIT 1",
                    (user_id, cutoff)
                ).fetchone()
                db_look.close()
                if recent_parked:
                    start_lat = recent_parked["latitude"]
                    start_lon = recent_parked["longitude"]
                    parked_ts = recent_parked["ts"]
                    gap_s = (datetime.fromisoformat(start_ts.replace("Z", "+00:00")) -
                             datetime.fromisoformat(parked_ts.replace("Z", "+00:00"))).total_seconds()
                    if 0 < gap_s <= 90:
                        start_ts = parked_ts
                        log.info(f"Drive start (poll fallback): backdated {gap_s:.0f}s to parked snapshot (user {user_id})")
                    else:
                        log.info(f"Drive start (poll fallback): hint/poll ts used, gap={gap_s:.0f}s (user {user_id})")
            except Exception as e:
                log.error(f"Drive start location lookup error: {e}")

            s["drive_start"] = {
                "ts": start_ts, "lat": start_lat, "lon": start_lon,
                "odometer": vehicle_state.get("odometer"),
                "soc": charge.get("battery_level"),
                "energy": vehicle_state.get("odometer"),
            }
            s["drive_max_speed"] = speed or 0
            s["_pending_start_snapshot"] = (start_ts, start_lat, start_lon) if (start_lat != lat or start_lon != lon) else None

    if is_driving:
        s["drive_max_speed"] = max(s["drive_max_speed"], speed or 0)

    db = get_db()

    # Insert a synthetic driving snapshot at the true start location so map tracks
    # begin there rather than wherever the first poll found the car.
    pending = s.pop("_pending_start_snapshot", None)
    if pending:
        p_ts, p_lat, p_lon = pending
        db.execute(
            "INSERT OR IGNORE INTO snapshots (vin, ts, latitude, longitude, is_driving, speed, user_id) VALUES (?,?,?,?,1,0,?)",
            (vin_actual, p_ts, p_lat, p_lon, user_id),
        )
    db.execute("""
        INSERT INTO snapshots
        (vin, ts, battery_level, battery_range, rated_range, odometer,
         speed, power, latitude, longitude, heading, charging_state,
         charge_rate, outside_temp, inside_temp, is_driving, user_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    """, (
        vin_actual, ts,
        charge.get("battery_level"),
        charge.get("battery_range"),
        charge.get("ideal_battery_range"),
        vehicle_state.get("odometer"),
        speed,
        drive.get("power"),
        lat, lon,
        drive.get("heading"),
        charging_state,
        charge.get("charge_rate"),
        climate.get("outside_temp"),
        climate.get("inside_temp"),
        int(is_driving),
        user_id,
    ))

    if not is_driving and was_driving:
        if is_mqtt_drive_active(vin_actual):
            # MQTT will finalize via Gear=P; clear poller drive state
            s["drive_start"] = None
            s["drive_max_speed"] = 0
        elif s["drive_start"]:
            # Poller fallback finalization (MQTT stream was offline)
            _finalize_drive(s, ts, lat, lon, vehicle_state, charge, vin_actual, db, user_id)

    s["was_driving"] = is_driving

    db.commit()
    db.close()


def poll_live(vin: str | None = None):
    adaptive_tick(vin)


def force_fetch_soon(vin: str):
    """Reset last_fetch for the owner of this VIN so the next scheduler tick fires immediately."""
    try:
        db = get_db()
        row = db.execute("SELECT user_id FROM vehicles WHERE vin=?", (vin,)).fetchone()
        db.close()
        if row:
            s = _get_user_state(row["user_id"])
            s["last_fetch"] = None
            s["last_state_check"] = None
            log.info(f"Immediate fetch queued for {vin} (gear-to-drive)")
    except Exception as e:
        log.error(f"force_fetch_soon error: {e}")
