import os
import json
import logging
import sqlite3
from pathlib import Path

DB_PATH = Path("/data/tesla.db")
log = logging.getLogger(__name__)


def get_db():
    db = sqlite3.connect(DB_PATH, detect_types=sqlite3.PARSE_DECLTYPES)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    return db


def init_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    db = get_db()
    db.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            is_admin INTEGER DEFAULT 0,
            visible_in_garage INTEGER DEFAULT 1,
            created_at TEXT
        );

        CREATE TABLE IF NOT EXISTS tesla_tokens (
            user_id INTEGER PRIMARY KEY,
            email TEXT,
            access_token TEXT,
            refresh_token TEXT,
            expires_at REAL
        );

        CREATE TABLE IF NOT EXISTS vehicles (
            vin TEXT PRIMARY KEY,
            display_name TEXT,
            model TEXT,
            year INTEGER,
            color TEXT,
            data TEXT,
            updated_at TEXT
        );

        CREATE TABLE IF NOT EXISTS charges (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            vin TEXT,
            start_time TEXT,
            end_time TEXT,
            start_soc INTEGER,
            end_soc INTEGER,
            energy_added_kwh REAL,
            max_charger_power INTEGER,
            charger_voltage INTEGER,
            location_lat REAL,
            location_lon REAL,
            charge_miles_added REAL,
            fast_charger INTEGER DEFAULT 0,
            UNIQUE(vin, start_time)
        );

        CREATE TABLE IF NOT EXISTS drives (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            vin TEXT,
            start_time TEXT,
            end_time TEXT,
            start_lat REAL,
            start_lon REAL,
            end_lat REAL,
            end_lon REAL,
            start_odometer REAL,
            end_odometer REAL,
            distance_miles REAL,
            duration_seconds INTEGER,
            max_speed INTEGER,
            energy_used_kwh REAL,
            start_soc INTEGER,
            end_soc INTEGER,
            is_commute_to_work INTEGER DEFAULT 0,
            is_commute_to_home INTEGER DEFAULT 0,
            UNIQUE(vin, start_time)
        );

        CREATE TABLE IF NOT EXISTS snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            vin TEXT,
            ts TEXT,
            battery_level INTEGER,
            battery_range REAL,
            rated_range REAL,
            odometer REAL,
            speed INTEGER,
            power INTEGER,
            latitude REAL,
            longitude REAL,
            heading INTEGER,
            charging_state TEXT,
            charge_rate REAL,
            outside_temp REAL,
            inside_temp REAL,
            is_driving INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS stops (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            vin TEXT,
            ts TEXT,
            latitude REAL,
            longitude REAL,
            duration_seconds INTEGER,
            cluster_id INTEGER
        );

        CREATE INDEX IF NOT EXISTS idx_snapshots_ts ON snapshots(vin, ts);
        CREATE INDEX IF NOT EXISTS idx_drives_time ON drives(vin, start_time);
        CREATE INDEX IF NOT EXISTS idx_charges_time ON charges(vin, start_time);
        CREATE INDEX IF NOT EXISTS idx_stops_loc ON stops(latitude, longitude);

        CREATE TABLE IF NOT EXISTS acceleration_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            vin TEXT NOT NULL,
            ts TEXT NOT NULL,
            time_0_to_60 REAL NOT NULL,
            time_0_to_100 REAL,
            max_speed REAL,
            launch_speed REAL DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_runs_time ON acceleration_runs(vin, ts);

        CREATE TABLE IF NOT EXISTS telemetry_stats (
            vin TEXT PRIMARY KEY,
            top_speed REAL DEFAULT 0,
            updated_at TEXT
        );
    """)
    db.commit()

    for table, col in [
        ("vehicles", "user_id"),
        ("charges", "user_id"),
        ("drives", "user_id"),
        ("snapshots", "user_id"),
        ("stops", "user_id"),
        ("acceleration_runs", "user_id"),
        ("telemetry_stats", "user_id"),
        ("tesla_tokens", "client_id"),
        ("tesla_tokens", "client_secret"),
        ("users", "subdomain"),
        ("users", "private_key"),
        ("users", "public_key"),
        ("users", "home_lat"),
        ("users", "home_lon"),
        ("users", "work_lat"),
        ("users", "work_lon"),
        ("drives", "matched_route"),
        ("stops", "heading"),
        ("snapshots", "brake_pedal"),
    ]:
        try:
            real_cols = {"home_lat", "home_lon", "work_lat", "work_lon", "heading"}
            col_def = "INTEGER DEFAULT 1" if col == "user_id" else ("REAL" if col in real_cols else "TEXT")
            db.execute(f"ALTER TABLE {table} ADD COLUMN {col} {col_def}")
            db.commit()
        except Exception:
            pass

    db.close()
    _setup_admin()


def _setup_admin():
    db = get_db()
    count = db.execute("SELECT COUNT(*) FROM users").fetchone()[0]
    if count == 0:
        from auth import hash_password
        from datetime import datetime, timezone
        username = os.environ.get("ADMIN_USERNAME", "admin").strip()
        password = os.environ.get("ADMIN_PASSWORD", "")
        if len(password) < 12:
            db.close()
            raise RuntimeError("ADMIN_PASSWORD must be at least 12 characters for initial setup")
        db.execute(
            "INSERT INTO users (username, password_hash, is_admin, visible_in_garage, created_at) VALUES (?,?,1,1,?)",
            (username, hash_password(password), datetime.now(timezone.utc).isoformat()),
        )
        db.commit()
        log.info(f"Created admin user: {username}")

        cache_path = Path("/data/tesla_cache.json")
        if cache_path.exists():
            try:
                cache = json.loads(cache_path.read_text())
                email = os.environ.get("TESLA_EMAIL", "default")
                tok = cache.get(email, {})
                if tok.get("access_token") or tok.get("refresh_token"):
                    db.execute(
                        "INSERT OR REPLACE INTO tesla_tokens (user_id, email, access_token, refresh_token, expires_at) VALUES (?,?,?,?,?)",
                        (1, email, tok.get("access_token", ""), tok.get("refresh_token", ""), tok.get("expires_at", 0)),
                    )
                    db.commit()
                    log.info("Migrated Tesla tokens from cache file to DB for user 1")
            except Exception as e:
                log.warning(f"Token migration failed: {e}")

    db.close()
