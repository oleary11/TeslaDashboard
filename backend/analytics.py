"""Trip analysis, degradation, commute detection, stop clustering."""
import math
import time
from collections import defaultdict
from datetime import datetime, timezone


HOME = (float("nan"), float("nan"))   # set via env / API
WORK = (float("nan"), float("nan"))
GEOFENCE_RADIUS_MILES = 0.15


def haversine(lat1, lon1, lat2, lon2) -> float:
    """Distance in miles between two GPS points."""
    R = 3958.8
    lat1, lon1, lat2, lon2 = map(math.radians, [lat1, lon1, lat2, lon2])
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    a = math.sin(dlat/2)**2 + math.cos(lat1)*math.cos(lat2)*math.sin(dlon/2)**2
    return R * 2 * math.asin(math.sqrt(a))


def near(lat, lon, target_lat, target_lon, radius=GEOFENCE_RADIUS_MILES) -> bool:
    if math.isnan(target_lat) or math.isnan(target_lon):
        return False
    return haversine(lat, lon, target_lat, target_lon) <= radius


def tag_commutes(drives: list[dict], home_lat: float, home_lon: float,
                 work_lat: float, work_lon: float) -> list[dict]:
    for d in drives:
        slat, slon = d.get("start_lat") or 0, d.get("start_lon") or 0
        elat, elon = d.get("end_lat") or 0, d.get("end_lon") or 0
        d["is_commute_to_work"] = int(
            near(slat, slon, home_lat, home_lon) and near(elat, elon, work_lat, work_lon)
        )
        d["is_commute_to_home"] = int(
            near(slat, slon, work_lat, work_lon) and near(elat, elon, home_lat, home_lon)
        )
    return drives


# kWh/mi fallback by trim_badging → (usable_kwh, epa_miles)
# Source: Tesla specs for 2018 Model 3
TRIM_SPECS = {
    "74":   (74.0, 310),   # Long Range RWD
    "74d":  (74.0, 334),   # Long Range AWD (Dual Motor)
    "p74d": (74.0, 310),   # Performance
    "62":   (62.0, 264),   # Mid Range
    "50":   (50.0, 220),   # Standard Range
}
DEFAULT_TRIM = "74"


def specs_for_trim(trim: str) -> tuple[float, float]:
    """Return (usable_kwh, epa_range_miles) for a given trim badge."""
    return TRIM_SPECS.get(trim, TRIM_SPECS[DEFAULT_TRIM])


def default_consumption_for_trim(trim: str) -> float:
    """EPA-derived consumption in kWh/mi for a trim badge."""
    kwh, miles = specs_for_trim(trim)
    return kwh / miles


def capacity_from_snapshot(snapshot: dict, consumption_kwh_per_mi: float) -> float | None:
    """
    Estimate usable battery capacity (kWh) from a single snapshot.
    Formula: (projected_range / SOC_fraction) × avg_consumption_kWh_per_mi
    Accurate to ~±3% per Tesla community research.
    """
    soc = snapshot.get("battery_level")
    rng = snapshot.get("battery_range")
    if not soc or not rng or soc <= 0:
        return None
    projected_full_range = rng / (soc / 100.0)
    return round(projected_full_range * consumption_kwh_per_mi, 2)


def avg_consumption_from_drives(drives: list[dict], trim: str = DEFAULT_TRIM) -> float:
    """Compute average energy consumption from recorded drives. Falls back to EPA spec."""
    total_kwh = sum(d.get("energy_used_kwh") or 0 for d in drives)
    total_mi = sum(d.get("distance_miles") or 0 for d in drives)
    if total_mi < 50:
        return default_consumption_for_trim(trim)
    return total_kwh / total_mi


def degradation_series(snapshots: list[dict], consumption_kwh_per_mi: float | None = None,
                       trim: str = DEFAULT_TRIM) -> list[dict]:
    """
    Estimate battery capacity (kWh) over time using the community formula:
      capacity = (projected_range / SOC%) × consumption_kWh_per_mi

    Falls back to rated_range method if no consumption data available.
    Samples one point per day (median of that day's estimates).
    """
    if consumption_kwh_per_mi is None:
        consumption_kwh_per_mi = default_consumption_for_trim(trim)

    by_date: dict[str, list] = defaultdict(list)
    for s in snapshots:
        soc = s.get("battery_level") or 0
        rng = s.get("battery_range")
        if not rng or soc < 10 or soc > 95:
            # Skip extremes: SOC <10% and >95% can skew range estimates
            continue
        cap = capacity_from_snapshot(s, consumption_kwh_per_mi)
        if cap and 20 < cap < 120:  # sanity bounds for a Model 3
            date = (s["ts"] or "")[:10]
            if date:
                by_date[date].append(cap)

    result = []
    for date in sorted(by_date):
        vals = sorted(by_date[date])
        median = vals[len(vals) // 2]
        result.append({
            "date": date,
            "estimated_capacity_kwh": median,
            "samples": len(vals),
        })
    return result


def cluster_stops(stops: list[dict], radius_miles: float = 0.03) -> list[dict]:
    """
    Group nearby stops into clusters (intersections).
    Returns clusters sorted by total visit count.
    """
    clusters: list[dict] = []
    for stop in stops:
        lat, lon = stop["latitude"], stop["longitude"]
        matched = None
        for c in clusters:
            if haversine(lat, lon, c["lat"], c["lon"]) <= radius_miles:
                matched = c
                break
        ts = stop.get("ts") or ""
        if matched:
            n = matched["count"]
            matched["count"] += 1
            matched["total_duration"] += stop.get("duration_seconds", 0)
            matched["lat"] = (matched["lat"] * n + lat) / matched["count"]
            matched["lon"] = (matched["lon"] * n + lon) / matched["count"]
            if ts > matched.get("last_seen", ""):
                matched["last_seen"] = ts
        else:
            clusters.append({
                "lat": lat,
                "lon": lon,
                "count": 1,
                "total_duration": stop.get("duration_seconds", 0),
                "last_seen": ts,
            })
    for c in clusters:
        c["avg_wait_seconds"] = round(c["total_duration"] / c["count"])
    clusters.sort(key=lambda x: x["count"], reverse=True)
    return clusters


def heading_to_axis(heading: float | None) -> str | None:
    """
    Quantize a compass heading to the two-axis scheme used by signalized intersections.
    N/S traffic (heading near 0° or 180°) shares a signal phase; E/W shares the other.
    Returns 'NS', 'EW', or None when heading is unavailable.
    """
    if heading is None:
        return None
    h = heading % 360
    # NS: within 45° of due-north (0/360) or due-south (180)
    if h <= 45 or h >= 315 or (135 <= h <= 225):
        return "NS"
    return "EW"


def cluster_stops_with_cycles(stops: list[dict], radius_miles: float = 0.03) -> list[dict]:
    """
    Like cluster_stops but runs direction-aware cycle detection on each cluster.

    Stops headed N/S and E/W at the same intersection are independent signal phases
    and must not be mixed — doing so would corrupt the circular-statistics estimate.
    Cycle detection runs separately per axis; the cluster reports the best-confidence
    result (most data wins when both axes lack enough samples).
    """
    clusters = cluster_stops(stops, radius_miles)
    for c in clusters:
        nearby = [s for s in stops if haversine(c["lat"], c["lon"], s["latitude"], s["longitude"]) <= radius_miles]

        # Separate stops by travel axis
        by_axis: dict[str, dict] = {}
        for s in nearby:
            axis = heading_to_axis(s.get("heading"))
            if axis not in by_axis:
                by_axis[axis] = {"times": [], "durations": []}
            try:
                dt = datetime.fromisoformat(s["ts"].replace("Z", "+00:00"))
                by_axis[axis]["times"].append(dt.hour * 3600 + dt.minute * 60 + dt.second)
                by_axis[axis]["durations"].append(s.get("duration_seconds", 0))
            except Exception:
                pass

        # Run cycle detection per axis; pick best-confidence result for top-level 'cycle'
        cycles_by_axis = {}
        for axis, data in by_axis.items():
            cycles_by_axis[axis] = detect_light_cycle(data["times"], data["durations"])

        # Best = detected first, then building (most samples), then no_pattern
        def _rank(res):
            if res is None: return 3
            s = res.get("status")
            if s == "detected": return 0
            if s == "building": return 1
            return 2

        best = min(cycles_by_axis.values(), key=_rank, default=None)
        c["cycle"] = best
        c["cycles_by_axis"] = cycles_by_axis
        c["raw_count"] = len(nearby)
    return clusters


def detect_light_cycle(times_of_day: list[int], durations: list[int]) -> dict | None:
    """
    Attempt to detect a traffic light cycle from historical stop arrival times.

    Uses circular statistics: for a candidate cycle length C, if stops truly arrive
    at the same phase of the cycle, their (arrival_time % C) values will cluster
    tightly. Mean resultant length (MRL) measures that clustering: 1 = perfect,
    0 = uniform. We scan 60–180s and report if the best MRL exceeds a threshold.

    Requires at least 8 stops. Returns None if no pattern is strong enough.
    """
    MIN_STOPS = 8
    MIN_MRL   = 0.45   # below this = indistinguishable from noise

    if len(times_of_day) < MIN_STOPS:
        return {"status": "building", "have": len(times_of_day), "need": MIN_STOPS}

    best_cycle, best_mrl, best_sin, best_cos = None, 0.0, 0.0, 0.0
    for cycle in range(60, 181, 5):
        phases = [(t % cycle) / cycle * 2 * math.pi for t in times_of_day]
        s = sum(math.sin(p) for p in phases) / len(phases)
        c = sum(math.cos(p) for p in phases) / len(phases)
        mrl = math.sqrt(s * s + c * c)
        if mrl > best_mrl:
            best_mrl, best_cycle, best_sin, best_cos = mrl, cycle, s, c

    if best_mrl < MIN_MRL:
        return {"status": "no_pattern", "have": len(times_of_day), "mrl": round(best_mrl, 2)}

    red_phase = int(round(sum(durations) / len(durations)))
    phase_offset = int((math.atan2(best_sin, best_cos) / (2 * math.pi) * best_cycle) % best_cycle)
    confidence = min(int(best_mrl * 100), 99)

    return {
        "status": "detected",
        "cycle_seconds": best_cycle,
        "red_phase_seconds": red_phase,
        "phase_offset_seconds": phase_offset,
        "confidence": confidence,
        "sample_count": len(times_of_day),
    }


def compute_optimal_departure(commute_stops: list[dict], departure_times_tod: list[int]) -> dict:
    """
    Given stops that occurred during commute drives (each with elapsed_seconds from
    drive start, heading, lat/lon, ts, duration_seconds), compute which departure
    time minimizes expected red-light wait.

    departure_times_tod: observed departure times-of-day in seconds (for window sizing).
    """
    if not commute_stops:
        return {"has_data": False, "reason": "no_stops_on_commutes"}

    # Cluster commute stops by location+axis, tracking average elapsed time
    class _Slot:
        def __init__(self):
            self.lat = self.lon = 0.0
            self.count = 0
            self.by_axis: dict[str, dict] = {}

        def add(self, lat, lon, axis, tod, duration, elapsed):
            if self.count == 0:
                self.lat, self.lon = lat, lon
            else:
                n = self.count
                self.lat = (self.lat * n + lat) / (n + 1)
                self.lon = (self.lon * n + lon) / (n + 1)
            self.count += 1
            if axis not in self.by_axis:
                self.by_axis[axis] = {"times": [], "durations": [], "elapsed": []}
            self.by_axis[axis]["times"].append(tod)
            self.by_axis[axis]["durations"].append(duration)
            self.by_axis[axis]["elapsed"].append(elapsed)

    slots: list[_Slot] = []
    for s in commute_stops:
        lat, lon = s.get("latitude"), s.get("longitude")
        if not lat or not lon:
            continue
        axis = heading_to_axis(s.get("heading"))
        elapsed = int(s.get("elapsed_seconds") or 0)
        duration = int(s.get("duration_seconds") or 0)
        try:
            dt = datetime.fromisoformat(s["ts"].replace("Z", "+00:00"))
            tod = dt.hour * 3600 + dt.minute * 60 + dt.second
        except Exception:
            continue

        matched = next((sl for sl in slots if haversine(lat, lon, sl.lat, sl.lon) <= 0.03), None)
        if matched:
            matched.add(lat, lon, axis, tod, duration, elapsed)
        else:
            sl = _Slot()
            sl.add(lat, lon, axis, tod, duration, elapsed)
            slots.append(sl)

    # Build lights: one entry per (cluster, axis) with a detected or building cycle
    lights = []
    building = []
    for sl in slots:
        for axis, data in sl.by_axis.items():
            cycle = detect_light_cycle(data["times"], data["durations"])
            avg_elapsed = int(round(sum(data["elapsed"]) / len(data["elapsed"]))) if data["elapsed"] else 0
            entry = {
                "lat": sl.lat, "lon": sl.lon, "axis": axis,
                "cycle": cycle, "avg_elapsed_seconds": avg_elapsed,
                "sample_count": len(data["times"]),
            }
            if cycle and cycle.get("status") == "detected":
                lights.append(entry)
            elif cycle and cycle.get("status") == "building":
                building.append(entry)

    if not lights:
        stops_needed = sum((l["cycle"]["need"] - l["cycle"]["have"]) for l in building) if building else None
        return {
            "has_data": False,
            "total_lights": len(slots),
            "building_lights": len(building),
            "stops_still_needed": stops_needed,
            "reason": "building_data",
        }

    # Sort lights by route position so cascading waits flow forward correctly.
    # Waiting at light 1 delays your arrival at light 2, which changes whether
    # light 2 is red or green — independent per-light math ignores this.
    ordered_lights = sorted(lights, key=lambda l: l["avg_elapsed_seconds"])

    def _wait_at(arrival_tod: int, cy: dict) -> int:
        C, R, offset = cy["cycle_seconds"], cy["red_phase_seconds"], cy["phase_offset_seconds"]
        relative = (arrival_tod % C - offset) % C
        return max(0, R - relative) if relative < R else 0

    def _simulate(dep_s: int) -> tuple[int, int]:
        carry = 0  # accumulated wait from earlier lights shifts later arrivals
        total, hit = 0, 0
        for light in ordered_lights:
            arrival = dep_s + light["avg_elapsed_seconds"] + carry
            w = _wait_at(arrival, light["cycle"])
            if w > 0:
                total += w
                hit += 1
                carry += w
        return total, hit

    # Scan window: observed departure range ± 30 min, clamped 0–86400
    if departure_times_tod:
        scan_start = max(0, min(departure_times_tod) - 1800)
        scan_end   = min(86400, max(departure_times_tod) + 1800)
    else:
        scan_start, scan_end = 6 * 3600, 9 * 3600

    scan = []
    for dep_s in range(int(scan_start), int(scan_end), 60):
        total_wait, lights_hit = _simulate(dep_s)
        dep_min = dep_s // 60
        scan.append({
            "depart_time": f"{dep_min // 60:02d}:{dep_min % 60:02d}",
            "depart_seconds": dep_s,
            "expected_wait_seconds": total_wait,
            "lights_hit": lights_hit,
        })

    scan.sort(key=lambda x: x["expected_wait_seconds"])
    return {
        "has_data": True,
        "total_lights_on_route": len(slots),
        "lights_with_cycles": len(lights),
        "building_lights": len(building),
        "best_windows": scan[:5],
        "worst_windows": list(reversed(scan[-5:])),
        "scan_window_start": f"{int(scan_start)//3600:02d}:{(int(scan_start)%3600)//60:02d}",
        "scan_window_end":   f"{int(scan_end)//3600:02d}:{(int(scan_end)%3600)//60:02d}",
    }


def destination_clusters(drives: list[dict], radius_miles: float = 0.1) -> list[dict]:
    """Cluster drive endpoints by proximity. Returns top destinations by visit count."""
    clusters: list[dict] = []
    for d in drives:
        lat, lon = d.get("end_lat"), d.get("end_lon")
        if not lat or not lon:
            continue
        matched = None
        for c in clusters:
            if haversine(lat, lon, c["lat"], c["lon"]) <= radius_miles:
                matched = c
                break
        ts = d.get("start_time") or ""
        if matched:
            n = matched["count"]
            matched["count"] += 1
            matched["lat"] = (matched["lat"] * n + lat) / matched["count"]
            matched["lon"] = (matched["lon"] * n + lon) / matched["count"]
            if ts > matched.get("last_visit", ""):
                matched["last_visit"] = ts
        else:
            clusters.append({"lat": lat, "lon": lon, "count": 1, "last_visit": ts})
    clusters.sort(key=lambda x: x["count"], reverse=True)
    return clusters


def speed_histogram_bands(snapshots: list[dict]) -> list[dict]:
    """Return % of driving-time snapshots in each speed band."""
    bands = [
        {"label": "0–15",  "min": 0,   "max": 15},
        {"label": "15–35", "min": 15,  "max": 35},
        {"label": "35–55", "min": 35,  "max": 55},
        {"label": "55–75", "min": 55,  "max": 75},
        {"label": "75+",   "min": 75,  "max": 9999},
    ]
    counts = [0] * len(bands)
    total = 0
    for s in snapshots:
        speed = s.get("speed")
        if speed is None:
            continue
        total += 1
        for i, b in enumerate(bands):
            if b["min"] <= speed < b["max"]:
                counts[i] += 1
                break
    return [
        {**b, "count": counts[i], "pct": round(counts[i] / total * 100, 1) if total else 0}
        for i, b in enumerate(bands)
    ]


def efficiency_by_drive(drives: list[dict]) -> list[dict]:
    result = []
    for d in drives:
        dist = d.get("distance_miles") or 0
        energy = d.get("energy_used_kwh") or 0
        if dist > 0.5 and energy > 0:
            result.append({
                "start_time": d.get("start_time"),
                "distance": round(dist, 1),
                "wh_per_mile": round((energy * 1000) / dist, 0),
                "miles_per_kwh": round(dist / energy, 2),
            })
    return sorted(result, key=lambda x: x["start_time"] or "")


class RunDetector:
    """
    Detects 0-60 and 0-100 mph acceleration runs from 1 Hz telemetry.
    Accuracy is ±0.5s due to 1 Hz sampling rate.
    """

    def __init__(self):
        self._state: dict = {}

    def process(self, vin: str, speed_mph: float, gear: str | None = None) -> dict | None:
        """
        Feed each telemetry update. Returns a completed run dict when a run
        finishes (car returns below 5 mph after reaching ≥60 mph), else None.
        """
        s = self._state.setdefault(vin, {
            'launch_ts': None,
            'in_run': False,
            't60': None,
            't100': None,
            'max_speed': 0.0,
        })

        if gear and gear not in ('D', ''):
            if s['in_run']:
                result = self._finalize(vin, s)
                self._reset(s)
                return result
            self._reset(s)
            return None

        now = time.monotonic()

        if speed_mph < 5:
            if s['in_run']:
                result = self._finalize(vin, s)
                self._reset(s)
                return result
            s['launch_ts'] = now
        else:
            if s['launch_ts'] and not s['in_run']:
                s['in_run'] = True

            if s['in_run']:
                elapsed = now - s['launch_ts']
                s['max_speed'] = max(s['max_speed'], speed_mph)
                if s['t60'] is None and speed_mph >= 60:
                    s['t60'] = elapsed
                if s['t100'] is None and speed_mph >= 100:
                    s['t100'] = elapsed
                # Abandon run if it's dragged on for >45s without ending naturally
                if elapsed > 45 and s['t60'] is not None:
                    result = self._finalize(vin, s)
                    self._reset(s)
                    return result

        return None

    def _finalize(self, vin: str, s: dict) -> dict | None:
        if s['t60'] is None or s['t60'] < 2.0 or s['t60'] > 15.0:
            return None
        return {
            'vin': vin,
            'ts': datetime.now(timezone.utc).isoformat(),
            'time_0_to_60': round(s['t60'], 2),
            'time_0_to_100': round(s['t100'], 2) if s['t100'] else None,
            'max_speed': round(s['max_speed'], 1),
            'launch_speed': 0.0,
        }

    def _reset(self, s: dict):
        s['in_run'] = False
        s['launch_ts'] = None
        s['t60'] = None
        s['t100'] = None
        s['max_speed'] = 0.0
