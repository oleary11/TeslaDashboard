import json
import logging
import math
import requests
from datetime import datetime, timezone

from db import get_db

log = logging.getLogger(__name__)

OSRM_BASE = "http://osrm:5000"
CHUNK_SIZE = 90
SAMPLE_INTERVAL_S = 5


def _haversine_miles(lat1, lon1, lat2, lon2) -> float:
    R = 3958.8
    lat1, lon1, lat2, lon2 = map(math.radians, [lat1, lon1, lat2, lon2])
    a = math.sin((lat2-lat1)/2)**2 + math.cos(lat1)*math.cos(lat2)*math.sin((lon2-lon1)/2)**2
    return R * 2 * math.asin(math.sqrt(a))


def _sample_points(drive: dict, db) -> list[tuple[float, float]]:
    pts = db.execute(
        """SELECT latitude, longitude, ts FROM snapshots
           WHERE vin=? AND user_id=? AND ts>=? AND ts<=?
             AND is_driving=1 AND latitude IS NOT NULL AND longitude IS NOT NULL
           ORDER BY ts ASC""",
        (drive["vin"], drive["user_id"], drive["start_time"], drive["end_time"])
    ).fetchall()

    if not pts:
        # No driving snapshots at all — use start coords if available
        slat, slon = drive.get("start_lat"), drive.get("start_lon")
        return [(slat, slon)] if slat and slon else []

    sampled = [pts[0]]
    last_ts = datetime.fromisoformat(pts[0]["ts"].replace("Z", "+00:00"))
    for p in pts[1:]:
        ts = datetime.fromisoformat(p["ts"].replace("Z", "+00:00"))
        if (ts - last_ts).total_seconds() >= SAMPLE_INTERVAL_S:
            sampled.append(p)
            last_ts = ts
    if pts[-1]["ts"] != sampled[-1]["ts"]:
        sampled.append(pts[-1])

    coords = [(r["latitude"], r["longitude"]) for r in sampled]

    # Prepend the recorded drive start location when polling lag caused the first
    # driving snapshot to be captured well into the trip (car already moved).
    slat, slon = drive.get("start_lat"), drive.get("start_lon")
    if slat and slon and _haversine_miles(slat, slon, coords[0][0], coords[0][1]) > 0.05:
        coords.insert(0, (slat, slon))

    return coords


def _match_chunk(coords: list[tuple[float, float]]) -> list[list[float]] | None:
    coord_str = ";".join(f"{lon},{lat}" for lat, lon in coords)
    try:
        resp = requests.get(
            f"{OSRM_BASE}/match/v1/driving/{coord_str}",
            params={"overview": "full", "geometries": "geojson", "gaps": "ignore"},
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()
        if data.get("code") != "Ok" or not data.get("matchings"):
            log.warning(f"OSRM non-OK: {data.get('code')} {data.get('message', '')}")
            return None
        result = []
        for matching in data["matchings"]:
            for lon, lat in matching["geometry"]["coordinates"]:
                result.append([lat, lon])
        return result
    except Exception as e:
        log.warning(f"OSRM chunk failed: {e}")
        return None


def match_drive(drive_id: int, user_id: int) -> bool:
    db = get_db()
    drive = db.execute(
        "SELECT id, vin, user_id, start_time, end_time, start_lat, start_lon FROM drives WHERE id=? AND user_id=?",
        (drive_id, user_id)
    ).fetchone()
    if not drive:
        db.close()
        return False

    points = _sample_points(dict(drive), db)
    db.close()

    if len(points) < 2:
        return False

    matched = []
    for i in range(0, len(points), CHUNK_SIZE):
        chunk = points[i:i + CHUNK_SIZE]
        if len(chunk) < 2:
            break
        result = _match_chunk(chunk)
        if result is None:
            return False
        matched.extend(result)

    if not matched:
        return False

    db = get_db()
    db.execute(
        "UPDATE drives SET matched_route=? WHERE id=? AND user_id=?",
        (json.dumps(matched), drive_id, user_id)
    )
    db.commit()
    db.close()
    log.info(f"Map matched drive {drive_id}: {len(matched)} road points from {len(points)} GPS samples")
    return True


def match_all_unmatched():
    db = get_db()
    rows = db.execute(
        """SELECT id, user_id FROM drives
           WHERE matched_route IS NULL AND end_time IS NOT NULL AND distance_miles > 0.1
           ORDER BY start_time DESC"""
    ).fetchall()
    db.close()
    for row in rows:
        try:
            match_drive(row["id"], row["user_id"])
        except Exception as e:
            log.error(f"match_all_unmatched error drive {row['id']}: {e}")
