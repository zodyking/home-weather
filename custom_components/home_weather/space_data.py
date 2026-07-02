"""NASA JPL Horizons + NOAA SWPC space map data for Home Weather (no API key).

Sources:
- JPL Horizons API — heliocentric positions for planets, moons, spacecraft
- JPL Scout / Sentry / SB Close Approach — NEOs and comets
- NOAA SWPC JSON — solar weather (sunspots, K-index, flux, events)
"""
from __future__ import annotations

import asyncio
import logging
import math
import re
from datetime import datetime, timedelta, timezone
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.util import dt as dt_util

from .hurricane_data import get_home_coordinates

_LOGGER = logging.getLogger(__name__)

HORIZONS_API = "https://ssd.jpl.nasa.gov/api/horizons.api"
HORIZONS_LOOKUP_API = "https://ssd-api.jpl.nasa.gov/horizons_lookup.api"
SCOUT_API = "https://ssd-api.jpl.nasa.gov/scout.api"
SENTRY_API = "https://ssd-api.jpl.nasa.gov/sentry.api"
CAD_API = "https://ssd-api.jpl.nasa.gov/cad.api"
SWPC_JSON_BASE = "https://services.swpc.noaa.gov/json"

# Horizons major-body IDs (planet centers + Sun + Pluto)
PLANET_BODIES: list[tuple[str, str, str]] = [
    ("10", "Sun", "sun"),
    ("199", "Mercury", "planet"),
    ("299", "Venus", "planet"),
    ("399", "Earth", "planet"),
    ("499", "Mars", "planet"),
    ("599", "Jupiter", "planet"),
    ("699", "Saturn", "planet"),
    ("799", "Uranus", "planet"),
    ("899", "Neptune", "planet"),
    ("999", "Pluto", "dwarf_planet"),
]

# Mean orbital radius (AU) for fallback map positions when Horizons is unavailable.
MEAN_ORBIT_AU: dict[str, float] = {
    "10": 0.0,
    "199": 0.39,
    "299": 0.72,
    "399": 1.0,
    "499": 1.52,
    "599": 5.2,
    "699": 9.54,
    "799": 19.2,
    "899": 30.07,
    "999": 39.48,
}

# Fixed phase offsets so fallback planets do not stack on one line.
PLANET_PHASE: dict[str, float] = {
    "199": 0.0,
    "299": 0.9,
    "399": 1.8,
    "499": 2.6,
    "599": 0.6,
    "699": 1.4,
    "799": 2.2,
    "899": 3.0,
    "999": 3.8,
}

# Default ISS Horizons ID
DEFAULT_ISS_ID = "-255544"

# Module-level catalog cache (refreshed periodically)
_catalog_cache: dict[str, list[dict[str, str]]] = {}
_catalog_cache_time: datetime | None = None
_CATALOG_TTL = timedelta(hours=24)

_VECTOR_RE = re.compile(
    r"^\s*(\d{4}-[A-Za-z]{3}-\d{2}\s+\d{2}:\d{2})\s+"
    r"([+-]?\d+\.\d+E[+-]\d+)\s+"
    r"([+-]?\d+\.\d+E[+-]\d+)\s+"
    r"([+-]?\d+\.\d+E[+-]\d+)\s+"
    r"([+-]?\d+\.\d+E[+-]\d+)\s+"
    r"([+-]?\d+\.\d+E[+-]\d+)\s+"
    r"([+-]?\d+\.\d+E[+-]\d+)",
    re.MULTILINE,
)

_LABELED_VECTOR_RE = re.compile(
    r"X\s*=\s*([+-]?\d+(?:\.\d+)?E[+-]?\d+)\s+"
    r"Y\s*=\s*([+-]?\d+(?:\.\d+)?E[+-]?\d+)\s+"
    r"Z\s*=\s*([+-]?\d+(?:\.\d+)?E[+-]?\d+)",
    re.IGNORECASE,
)

_LABELED_VELOCITY_RE = re.compile(
    r"VX\s*=\s*([+-]?\d+(?:\.\d+)?E[+-]?\d+)\s+"
    r"VY\s*=\s*([+-]?\d+(?:\.\d+)?E[+-]?\d+)\s+"
    r"VZ\s*=\s*([+-]?\d+(?:\.\d+)?E[+-]?\d+)",
    re.IGNORECASE,
)

_HORIZONS_MONTHS = (
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
)

_OBS_ALT_RE = re.compile(
    r"^\s*(\d{4}-[A-Za-z]{3}-\d{2}\s+\d{2}:\d{2})\s+.*?(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*$",
    re.MULTILINE,
)


def get_space_config(config: dict[str, Any] | None) -> dict[str, Any]:
    """Return merged space monitoring settings."""
    defaults = {
        "enabled": True,
        "show_planets": True,
        "show_dwarf_planets": True,
        "show_moons": True,
        "show_spacecraft": True,
        "show_asteroids": True,
        "show_comets": True,
        "small_body_min_diameter_km": 0,
        "log_scale_orbits": True,
    }
    monitoring = (config or {}).get("space_monitoring") or {}
    merged = {**defaults, **monitoring}
    return merged


def get_solar_weather_config(config: dict[str, Any] | None) -> dict[str, Any]:
    """Return merged solar weather monitoring settings."""
    defaults = {
        "enabled": True,
        "show_sunspot_regions": True,
        "show_flare_events": True,
    }
    monitoring = (config or {}).get("solar_weather_monitoring") or {}
    return {**defaults, **monitoring}


def get_spacecraft_alerts_config(config: dict[str, Any] | None) -> dict[str, Any]:
    """Return merged spacecraft alert settings."""
    defaults = {
        "enabled": False,
        "min_elevation_deg": 10,
        "craft_ids": [DEFAULT_ISS_ID],
        "announce_pass_start": True,
        "announce_pass_peak": False,
    }
    alerts = (config or {}).get("spacecraft_alerts") or {}
    merged = {**defaults, **alerts}
    craft_ids = merged.get("craft_ids")
    if not isinstance(craft_ids, list) or not craft_ids:
        merged["craft_ids"] = [DEFAULT_ISS_ID]
    else:
        merged["craft_ids"] = [str(c) for c in craft_ids if c]
    try:
        merged["min_elevation_deg"] = max(0.0, float(merged.get("min_elevation_deg") or 10))
    except (TypeError, ValueError):
        merged["min_elevation_deg"] = 10.0
    return merged


def get_solar_weather_alerts_config(config: dict[str, Any] | None) -> dict[str, Any]:
    """Return merged solar weather alert settings."""
    defaults = {
        "enabled": False,
        "min_k_index": 5,
        "min_g_scale": 1,
        "min_xray_class": "M",
        "announce_flare_events": True,
        "announce_geomagnetic_storm": True,
    }
    alerts = (config or {}).get("solar_weather_alerts") or {}
    return {**defaults, **alerts}


def get_neo_alerts_config(config: dict[str, Any] | None) -> dict[str, Any]:
    """Return merged NEO alert settings."""
    defaults = {
        "enabled": False,
        "max_lunar_distances": 5,
        "min_diameter_m": 100,
    }
    alerts = (config or {}).get("neo_alerts") or {}
    merged = {**defaults, **alerts}
    try:
        merged["max_lunar_distances"] = max(0.1, float(merged.get("max_lunar_distances") or 5))
    except (TypeError, ValueError):
        merged["max_lunar_distances"] = 5.0
    return merged


def empty_payload() -> dict[str, Any]:
    """Return empty coordinator payload."""
    return {
        "bodies": [],
        "small_bodies": [],
        "catalog_counts": {
            "total": 0,
            "planets": 0,
            "moons": 0,
            "spacecraft": 0,
            "asteroids": 0,
            "comets": 0,
        },
        "primary_close_approach": None,
        "overhead_passes": [],
        "spacecraft_overhead": False,
        "neo_close_approach_soon": False,
        "solar_weather": {},
        "alert_events": [],
        "updated": None,
        "spacecraft_catalog": [],
    }


def _to_float(value: Any) -> float | None:
    try:
        if value is None or value == "":
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _horizons_time(value: datetime) -> str:
    """Format UTC datetime for Horizons API (English month abbreviations)."""
    return (
        f"{value.year}-{_HORIZONS_MONTHS[value.month - 1]}-"
        f"{value.day:02d} {value.hour:02d}:{value.minute:02d}"
    )


def _parse_horizons_vectors(text: str) -> dict[str, float] | None:
    """Parse heliocentric vector line from Horizons text output."""
    if "$$SOE" not in text or "$$EOE" not in text:
        return None
    block = text.split("$$SOE", 1)[1].split("$$EOE", 1)[0]
    match = _VECTOR_RE.search(block)
    if match:
        x = _to_float(match.group(2))
        y = _to_float(match.group(3))
        z = _to_float(match.group(4))
        vx = _to_float(match.group(5))
        vy = _to_float(match.group(6))
        vz = _to_float(match.group(7))
    else:
        xyz = _LABELED_VECTOR_RE.search(block)
        if not xyz:
            return None
        x = _to_float(xyz.group(1))
        y = _to_float(xyz.group(2))
        z = _to_float(xyz.group(3))
        vx = vy = vz = None
        velocity = _LABELED_VELOCITY_RE.search(block)
        if velocity:
            vx = _to_float(velocity.group(1))
            vy = _to_float(velocity.group(2))
            vz = _to_float(velocity.group(3))
    if x is None or y is None or z is None:
        return None
    dist = math.sqrt(x * x + y * y + z * z)
    vel = None
    if vx is not None and vy is not None and vz is not None:
        vel = math.sqrt(vx * vx + vy * vy + vz * vz)
    return {
        "x_au": x,
        "y_au": y,
        "z_au": z,
        "distance_au": dist,
        "velocity_kms": vel,
    }


def _parse_observer_alt_az(text: str) -> list[dict[str, Any]]:
    """Parse observer ephemeris alt/az samples from Horizons text output."""
    if "$$SOE" not in text or "$$EOE" not in text:
        return []
    block = text.split("$$SOE", 1)[1].split("$$EOE", 1)[0]
    samples: list[dict[str, Any]] = []
    for line in block.splitlines():
        line = line.strip()
        if not line or line.startswith("*"):
            continue
        parts = line.split()
        if len(parts) < 5:
            continue
        try:
            time_str = " ".join(parts[0:2])
            alt = _to_float(parts[-2])
            az = _to_float(parts[-1])
            if alt is None:
                continue
            samples.append({"time": time_str, "altitude_deg": alt, "azimuth_deg": az})
        except (IndexError, ValueError):
            continue
    return samples


def _xray_class_rank(class_char: str) -> int:
    order = {"A": 0, "B": 1, "C": 2, "M": 3, "X": 4}
    return order.get((class_char or "A").upper()[:1], 0)


def _first_float(record: dict[str, Any], *keys: str) -> float | None:
    """Return the first parseable float for any key (0 is a valid value)."""
    for key in keys:
        val = _to_float(record.get(key))
        if val is not None:
            return val
    return None


def _parse_xray_class(value: Any) -> str | None:
    """Extract GOES X-ray class letter from values like M2.8 or C4.3."""
    if value is None:
        return None
    text = str(value).strip().upper()
    if not text:
        return None
    letter = text[0]
    if letter in "AXBMC":
        return letter
    return None


def _k_index_to_g_scale(k: float) -> int:
    if k >= 9:
        return 5
    if k >= 8:
        return 4
    if k >= 7:
        return 3
    if k >= 6:
        return 2
    if k >= 5:
        return 1
    return 0


async def _fetch_json(session: Any, url: str, timeout: int = 30) -> Any:
    async with session.get(url, timeout=timeout) as resp:
        resp.raise_for_status()
        return await resp.json(content_type=None)


async def _fetch_text(session: Any, url: str, params: dict[str, str], timeout: int = 60) -> str:
    async with session.get(url, params=params, timeout=timeout) as resp:
        resp.raise_for_status()
        return await resp.text()


async def _fetch_horizons_vector(
    session: Any,
    body_id: str,
    semaphore: asyncio.Semaphore,
) -> dict[str, float] | None:
    async with semaphore:
        start = dt_util.utcnow()
        stop = start + timedelta(minutes=1)
        params = {
            "format": "text",
            "COMMAND": f"'{body_id}'",
            "OBJ_DATA": "NO",
            "MAKE_EPHEM": "YES",
            "EPHEM_TYPE": "VECTORS",
            "CENTER": "'@sun'",
            "START_TIME": f"'{_horizons_time(start)}'",
            "STOP_TIME": f"'{_horizons_time(stop)}'",
            "STEP_SIZE": "'1 m'",
            "REF_PLANE": "ECLIPTIC",
            "REF_SYSTEM": "J2000",
            "VEC_TABLE": "2",
            "OUT_UNITS": "'AU-D'",
        }
        try:
            text = await _fetch_text(session, HORIZONS_API, params, timeout=90)
            return _parse_horizons_vectors(text)
        except Exception as err:
            _LOGGER.debug("Horizons vector fetch failed for %s: %s", body_id, err)
            return None


async def _fetch_horizons_observer(
    session: Any,
    body_id: str,
    lat: float,
    lon: float,
    hours: int = 2,
) -> list[dict[str, Any]]:
    """Fetch topocentric alt/az samples for overhead pass detection."""
    start = dt_util.utcnow()
    stop = start + timedelta(hours=hours)
    params = {
        "format": "text",
        "COMMAND": f"'{body_id}'",
        "OBJ_DATA": "NO",
        "MAKE_EPHEM": "YES",
        "EPHEM_TYPE": "OBSERVER",
        "CENTER": "'coord@399'",
        "COORD_TYPE": "GEODETIC",
        "SITE_COORD": f"'{lat},{lon},0'",
        "START_TIME": f"'{start.strftime('%Y-%m-%d %H:%M')}'",
        "STOP_TIME": f"'{stop.strftime('%Y-%m-%d %H:%M')}'",
        "STEP_SIZE": "'2 m'",
        "QUANTITIES": "'2,4,20'",
    }
    try:
        text = await _fetch_text(session, HORIZONS_API, params, timeout=90)
        return _parse_observer_alt_az(text)
    except Exception as err:
        _LOGGER.debug("Horizons observer fetch failed for %s: %s", body_id, err)
        return []


async def _fetch_horizons_catalog(
    session: Any,
    group: str,
) -> list[dict[str, str]]:
    """Fetch Horizons lookup catalog for moons or spacecraft."""
    global _catalog_cache, _catalog_cache_time
    cache_key = group
    now = dt_util.utcnow()
    if (
        _catalog_cache_time
        and now - _catalog_cache_time < _CATALOG_TTL
        and cache_key in _catalog_cache
    ):
        return _catalog_cache[cache_key]

    url = f"{HORIZONS_LOOKUP_API}?group={group}&format=json"
    try:
        data = await _fetch_json(session, url)
        records = data.get("records") or data.get("result") or []
        items: list[dict[str, str]] = []
        if isinstance(records, list):
            for rec in records:
                if not isinstance(rec, dict):
                    continue
                spkid = rec.get("spkid") or rec.get("id") or rec.get("pdes")
                name = rec.get("name") or rec.get("des") or str(spkid)
                if spkid:
                    items.append({"id": str(spkid), "name": str(name)})
        _catalog_cache[cache_key] = items
        _catalog_cache_time = now
        return items
    except Exception as err:
        _LOGGER.debug("Horizons catalog fetch failed for group=%s: %s", group, err)
        return _catalog_cache.get(cache_key, [])


async def _fetch_small_body_candidates(session: Any) -> list[dict[str, Any]]:
    """Collect NEO/comet candidates from Scout, Sentry, and CAD."""
    candidates: dict[str, dict[str, Any]] = {}

    async def _load_scout() -> None:
        try:
            data = await _fetch_json(session, SCOUT_API)
            for obj in data.get("data") or []:
                des = obj.get("des") or obj.get("object")
                if not des:
                    continue
                candidates[str(des)] = {
                    "id": str(obj.get("spkid") or des),
                    "name": str(des),
                    "type": "asteroid",
                    "diameter_km": _to_float(obj.get("diameter")),
                    "source": "scout",
                }
        except Exception as err:
            _LOGGER.debug("Scout fetch failed: %s", err)

    async def _load_sentry() -> None:
        try:
            data = await _fetch_json(session, f"{SENTRY_API}?all=Y")
            for obj in data.get("data") or []:
                des = obj.get("des")
                if not des:
                    continue
                candidates[str(des)] = {
                    "id": str(obj.get("spkid") or des),
                    "name": str(des),
                    "type": "asteroid",
                    "diameter_km": _to_float(obj.get("diameter")),
                    "source": "sentry",
                }
        except Exception as err:
            _LOGGER.debug("Sentry fetch failed: %s", err)

    async def _load_cad() -> None:
        try:
            today = dt_util.utcnow().strftime("%Y-%m-%d")
            url = (
                f"{CAD_API}?body=Earth&date-min={today}&sort=date"
                f"&dist-max=50&limit=500"
            )
            data = await _fetch_json(session, url)
            fields = data.get("fields") or []
            rows = data.get("data") or []
            for row in rows:
                if not isinstance(row, list) or len(row) < 4:
                    continue
                record = dict(zip(fields, row)) if fields else {}
                des = record.get("des") or record.get("fullname")
                if not des:
                    continue
                body_type = "comet" if str(des).startswith("C/") or str(des).startswith("P/") else "asteroid"
                candidates[str(des)] = {
                    "id": str(record.get("des") or des),
                    "name": str(record.get("fullname") or des),
                    "type": body_type,
                    "diameter_km": _to_float(record.get("diameter")),
                    "lunar_distance": _to_float(record.get("dist")),
                    "close_approach_date": record.get("cd"),
                    "velocity_kms": _to_float(record.get("v_inf")),
                    "source": "cad",
                }
        except Exception as err:
            _LOGGER.debug("CAD fetch failed: %s", err)

    await asyncio.gather(_load_scout(), _load_sentry(), _load_cad())
    return list(candidates.values())


async def _fetch_swpc_solar_weather(session: Any) -> dict[str, Any]:
    """Fetch NOAA SWPC JSON bundle for solar weather view and sensors."""
    endpoints = {
        "observed_indices": f"{SWPC_JSON_BASE}/solar-cycle/observed-solar-cycle-indices.json",
        "solar_regions": f"{SWPC_JSON_BASE}/solar_regions.json",
        "planetary_k_index": f"{SWPC_JSON_BASE}/planetary_k_index_1m.json",
        "solar_probabilities": f"{SWPC_JSON_BASE}/solar_probabilities.json",
        "f107_cm_flux": f"{SWPC_JSON_BASE}/f107_cm_flux.json",
        "xray_latest": f"{SWPC_JSON_BASE}/goes/primary/xray-flares-latest.json",
        "edited_events": f"{SWPC_JSON_BASE}/edited_events.json",
    }
    result: dict[str, Any] = {
        "sunspot_number": None,
        "k_index": None,
        "g_scale": 0,
        "f107_flux": None,
        "xray_class": None,
        "flare_active": False,
        "geomagnetic_storm_active": False,
        "regions": [],
        "events": [],
        "probabilities": {},
        "images": {
            "goes_xray": "https://services.swpc.noaa.gov/images/geospace/geospace_3_day.png",
            "sdo_hmi": "https://services.swpc.noaa.gov/images/animations/sdo-hmii/latest.jpg",
        },
        "attribution": "NOAA Space Weather Prediction Center",
    }

    async def _load(name: str, url: str) -> tuple[str, Any]:
        try:
            return name, await _fetch_json(session, url)
        except Exception as err:
            _LOGGER.debug("SWPC fetch failed for %s: %s", name, err)
            return name, None

    loaded = dict(await asyncio.gather(*[_load(n, u) for n, u in endpoints.items()]))

    observed = loaded.get("observed_indices")
    if isinstance(observed, list) and observed:
        latest = observed[-1]
        if isinstance(latest, dict):
            result["sunspot_number"] = _first_float(
                latest,
                "ssn",
                "observed_swpc_ssn",
                "smoothed_ssn",
                "sunspot_number",
                "SmoothedSSN",
            )

    k_data = loaded.get("planetary_k_index")
    if isinstance(k_data, list) and k_data:
        latest = k_data[-1]
        if isinstance(latest, dict):
            k_val = _first_float(latest, "kp_index", "k_index", "estimated_kp")
            result["k_index"] = k_val
            if k_val is not None:
                result["g_scale"] = _k_index_to_g_scale(k_val)

    flux = loaded.get("f107_cm_flux")
    if isinstance(flux, list) and flux:
        latest = flux[-1]
        if isinstance(latest, dict):
            result["f107_flux"] = _to_float(
                latest.get("flux") or latest.get("f107") or latest.get("observed_flux")
            )

    regions = loaded.get("solar_regions")
    if isinstance(regions, list):
        result["regions"] = regions[-20:]

    xray_latest = loaded.get("xray_latest")
    if isinstance(xray_latest, list) and xray_latest:
        latest = xray_latest[-1]
        if isinstance(latest, dict):
            current_class = _parse_xray_class(latest.get("current_class"))
            max_class = _parse_xray_class(latest.get("max_class"))
            result["xray_class"] = max_class or current_class
            if max_class and _xray_class_rank(max_class) >= _xray_class_rank("C"):
                result["flare_active"] = True
            elif current_class and _xray_class_rank(current_class) >= _xray_class_rank("C"):
                result["flare_active"] = True

    events = loaded.get("edited_events")
    if isinstance(events, list):
        result["events"] = events[-10:]
        if not result["flare_active"]:
            for ev in reversed(events):
                if not isinstance(ev, dict):
                    continue
                cls = str(ev.get("type") or ev.get("event_type") or "")
                if "FLA" in cls.upper() or "flare" in cls.lower():
                    result["flare_active"] = True
                    parsed = _parse_xray_class(cls.split()[-1] if cls.split() else cls)
                    if parsed:
                        result["xray_class"] = parsed
                    break

    probs = loaded.get("solar_probabilities")
    if isinstance(probs, list) and probs:
        result["probabilities"] = probs[-1] if isinstance(probs[-1], dict) else {}

    if result["k_index"] is not None and result["k_index"] >= 5:
        result["geomagnetic_storm_active"] = True

    return result


def _fallback_heliocentric_vector(body_id: str) -> dict[str, float] | None:
    """Approximate heliocentric position on the ecliptic plane."""
    if body_id == "10":
        return {
            "x_au": 0.0,
            "y_au": 0.0,
            "z_au": 0.0,
            "distance_au": 0.0,
            "velocity_kms": None,
        }
    mean_au = MEAN_ORBIT_AU.get(body_id)
    if mean_au is None:
        return None
    day = dt_util.utcnow().timetuple().tm_yday
    angle = (day / 365.25) * (2 * math.pi) + PLANET_PHASE.get(body_id, 0.0)
    return {
        "x_au": mean_au * math.cos(angle),
        "y_au": mean_au * math.sin(angle),
        "z_au": 0.0,
        "distance_au": mean_au,
        "velocity_kms": None,
    }


def _build_body_record(
    body_id: str,
    name: str,
    body_type: str,
    vector: dict[str, float] | None,
    *,
    allow_fallback: bool = False,
) -> dict[str, Any] | None:
    if not vector and allow_fallback:
        vector = _fallback_heliocentric_vector(body_id)
    if not vector:
        return None
    return {
        "id": body_id,
        "name": name,
        "type": body_type,
        "x_au": vector["x_au"],
        "y_au": vector["y_au"],
        "z_au": vector["z_au"],
        "distance_au": vector["distance_au"],
        "velocity_kms": vector.get("velocity_kms"),
    }


def _detect_overhead_passes(
    craft_id: str,
    craft_name: str,
    samples: list[dict[str, Any]],
    min_elevation: float,
) -> list[dict[str, Any]]:
    """Detect overhead pass windows from alt/az samples."""
    passes: list[dict[str, Any]] = []
    in_pass = False
    pass_start: str | None = None
    max_alt = 0.0
    max_alt_time: str | None = None

    for sample in samples:
        alt = float(sample.get("altitude_deg") or 0)
        if alt >= min_elevation:
            if not in_pass:
                in_pass = True
                pass_start = sample.get("time")
                max_alt = alt
                max_alt_time = sample.get("time")
            elif alt > max_alt:
                max_alt = alt
                max_alt_time = sample.get("time")
        elif in_pass:
            passes.append({
                "craft_id": craft_id,
                "craft_name": craft_name,
                "pass_start": pass_start,
                "peak_time": max_alt_time,
                "max_elevation_deg": round(max_alt, 1),
                "altitude_deg": alt,
                "azimuth_deg": sample.get("azimuth_deg"),
            })
            in_pass = False
            pass_start = None
            max_alt = 0.0

    if in_pass and pass_start:
        last = samples[-1] if samples else {}
        passes.append({
            "craft_id": craft_id,
            "craft_name": craft_name,
            "pass_start": pass_start,
            "peak_time": max_alt_time,
            "max_elevation_deg": round(max_alt, 1),
            "altitude_deg": last.get("altitude_deg"),
            "azimuth_deg": last.get("azimuth_deg"),
            "ongoing": True,
        })
    return passes


def build_coordinator_payload(
    bodies: list[dict[str, Any]],
    small_bodies: list[dict[str, Any]],
    primary_close_approach: dict[str, Any] | None,
    overhead_passes: list[dict[str, Any]],
    solar_weather: dict[str, Any],
    spacecraft_catalog: list[dict[str, str]],
    neo_alerts_cfg: dict[str, Any],
    spacecraft_alerts_cfg: dict[str, Any],
) -> dict[str, Any]:
    """Build unified coordinator payload."""
    counts = {
        "planets": sum(1 for b in bodies if b.get("type") == "planet"),
        "moons": sum(1 for b in bodies if b.get("type") == "moon"),
        "spacecraft": sum(1 for b in bodies if b.get("type") == "spacecraft"),
        "asteroids": sum(1 for b in small_bodies if b.get("type") == "asteroid"),
        "comets": sum(1 for b in small_bodies if b.get("type") == "comet"),
    }
    counts["total"] = (
        counts["planets"] + counts["moons"] + counts["spacecraft"]
        + counts["asteroids"] + counts["comets"]
    )

    min_elev = float(spacecraft_alerts_cfg.get("min_elevation_deg") or 10)
    spacecraft_overhead = any(
        (p.get("max_elevation_deg") or 0) >= min_elev or (p.get("ongoing") and (p.get("altitude_deg") or 0) >= min_elev)
        for p in overhead_passes
    )

    neo_close = False
    if primary_close_approach:
        ld = _to_float(primary_close_approach.get("lunar_distance"))
        diam_m = _to_float(primary_close_approach.get("diameter_m"))
        max_ld = float(neo_alerts_cfg.get("max_lunar_distances") or 5)
        min_diam = float(neo_alerts_cfg.get("min_diameter_m") or 100)
        if ld is not None and ld <= max_ld:
            if diam_m is None or diam_m >= min_diam:
                neo_close = True

    alert_events: list[dict[str, Any]] = []
    for p in overhead_passes:
        if (p.get("max_elevation_deg") or 0) >= min_elev:
            alert_events.append({
                "id": f"pass_{p.get('craft_id')}_{p.get('pass_start')}",
                "type": "spacecraft_pass",
                "craft_id": p.get("craft_id"),
                "name": p.get("craft_name"),
                "max_elevation_deg": p.get("max_elevation_deg"),
                "pass_start": p.get("pass_start"),
            })

    sw = solar_weather or {}
    if sw.get("geomagnetic_storm_active"):
        alert_events.append({
            "id": f"storm_k{sw.get('k_index')}",
            "type": "geomagnetic_storm",
            "k_index": sw.get("k_index"),
            "g_scale": sw.get("g_scale"),
        })
    if sw.get("flare_active"):
        alert_events.append({
            "id": f"flare_{sw.get('xray_class') or 'C'}",
            "type": "solar_flare",
            "xray_class": sw.get("xray_class"),
        })
    if neo_close and primary_close_approach:
        alert_events.append({
            "id": f"neo_{primary_close_approach.get('name')}",
            "type": "neo_close_approach",
            **primary_close_approach,
        })

    return {
        "bodies": bodies,
        "small_bodies": small_bodies,
        "catalog_counts": counts,
        "primary_close_approach": primary_close_approach,
        "overhead_passes": overhead_passes,
        "spacecraft_overhead": spacecraft_overhead,
        "neo_close_approach_soon": neo_close,
        "solar_weather": solar_weather,
        "spacecraft_catalog": spacecraft_catalog,
        "alert_events": alert_events,
        "updated": dt_util.utcnow().isoformat(),
    }


def detect_space_events(
    tracked: dict[str, dict[str, Any]],
    events: list[dict[str, Any]],
) -> list[tuple[str, dict[str, Any]]]:
    """Detect new/changed space alert events for HA bus."""
    bus_events: list[tuple[str, dict[str, Any]]] = []
    current_by_id = {str(e["id"]): e for e in events if e.get("id")}

    for event_id, event in current_by_id.items():
        prev = tracked.get(event_id)
        event_type = event.get("type", "space")
        if event_type == "spacecraft_pass":
            bus_name = "home_weather_spacecraft_overhead"
        elif event_type == "geomagnetic_storm":
            bus_name = "home_weather_solar_storm"
        elif event_type == "solar_flare":
            bus_name = "home_weather_solar_flare"
        elif event_type == "neo_close_approach":
            bus_name = "home_weather_neo_close_approach"
        else:
            bus_name = "home_weather_space_event"

        if not prev:
            bus_events.append((bus_name, dict(event)))
        elif prev != event:
            bus_events.append((f"{bus_name}_updated", dict(event)))

    for event_id in tracked:
        if event_id not in current_by_id:
            prev = tracked[event_id]
            event_type = prev.get("type", "space")
            if event_type == "spacecraft_pass":
                bus_events.append(("home_weather_spacecraft_overhead_cleared", dict(prev)))
            elif event_type == "geomagnetic_storm":
                bus_events.append(("home_weather_solar_storm_cleared", dict(prev)))

    return bus_events


async def async_fetch_space(hass: HomeAssistant, config: dict[str, Any]) -> dict[str, Any]:
    """Fetch space map and solar weather data."""
    space_cfg = get_space_config(config)
    solar_cfg = get_solar_weather_config(config)
    spacecraft_alerts_cfg = get_spacecraft_alerts_config(config)
    neo_alerts_cfg = get_neo_alerts_config(config)

    if not space_cfg.get("enabled") and not solar_cfg.get("enabled"):
        return empty_payload()

    session = async_get_clientsession(hass)
    semaphore = asyncio.Semaphore(8)
    bodies: list[dict[str, Any]] = []
    small_bodies: list[dict[str, Any]] = []
    overhead_passes: list[dict[str, Any]] = []
    spacecraft_catalog: list[dict[str, str]] = []
    primary_close_approach: dict[str, Any] | None = None
    solar_weather: dict[str, Any] = {}

    fetch_tasks: list[Any] = []

    if space_cfg.get("enabled"):
        # Planets + Sun
        planet_targets: list[tuple[str, str, str]] = []
        for body_id, name, body_type in PLANET_BODIES:
            if body_type == "dwarf_planet" and not space_cfg.get("show_dwarf_planets", True):
                continue
            if body_type in ("planet", "sun") and not space_cfg.get("show_planets", True) and body_type != "sun":
                continue
            planet_targets.append((body_id, name, body_type))

        async def _load_planets() -> None:
            async def _one(bid: str, bname: str, btype: str) -> None:
                if bid == "10" or btype == "sun":
                    rec = _build_body_record(
                        bid, bname, "sun", _fallback_heliocentric_vector("10")
                    )
                    if rec:
                        bodies.append(rec)
                    return
                vec = await _fetch_horizons_vector(session, bid, semaphore)
                rec = _build_body_record(
                    bid,
                    bname,
                    btype if btype != "sun" else "sun",
                    vec,
                    allow_fallback=True,
                )
                if rec:
                    bodies.append(rec)

            await asyncio.gather(*[_one(b, n, t) for b, n, t in planet_targets])

        await _load_planets()

        async def _load_moons() -> None:
            if not space_cfg.get("show_moons", True):
                return
            catalog = await _fetch_horizons_catalog(session, "sat")
            async def _one(entry: dict[str, str]) -> None:
                vec = await _fetch_horizons_vector(session, entry["id"], semaphore)
                rec = _build_body_record(entry["id"], entry["name"], "moon", vec)
                if rec:
                    bodies.append(rec)

            await asyncio.gather(*[_one(e) for e in catalog])

        async def _load_spacecraft() -> None:
            if not space_cfg.get("show_spacecraft", True):
                return
            nonlocal spacecraft_catalog
            catalog = await _fetch_horizons_catalog(session, "sct")
            spacecraft_catalog = catalog
            async def _one(entry: dict[str, str]) -> None:
                vec = await _fetch_horizons_vector(session, entry["id"], semaphore)
                rec = _build_body_record(entry["id"], entry["name"], "spacecraft", vec)
                if rec:
                    bodies.append(rec)

            await asyncio.gather(*[_one(e) for e in catalog])

        async def _load_small_bodies() -> None:
            if not space_cfg.get("show_asteroids", True) and not space_cfg.get("show_comets", True):
                return
            candidates = await _fetch_small_body_candidates(session)
            min_diam = float(space_cfg.get("small_body_min_diameter_km") or 0)
            filtered = []
            for cand in candidates:
                if cand.get("type") == "asteroid" and not space_cfg.get("show_asteroids", True):
                    continue
                if cand.get("type") == "comet" and not space_cfg.get("show_comets", True):
                    continue
                diam = _to_float(cand.get("diameter_km"))
                if min_diam > 0 and diam is not None and diam < min_diam:
                    continue
                filtered.append(cand)

            async def _one(cand: dict[str, Any]) -> None:
                body_id = str(cand.get("id") or cand.get("name"))
                vec = await _fetch_horizons_vector(session, body_id, semaphore)
                if not vec:
                    small_bodies.append({**cand, "position_available": False})
                    return
                small_bodies.append({
                    **cand,
                    "x_au": vec["x_au"],
                    "y_au": vec["y_au"],
                    "z_au": vec["z_au"],
                    "distance_au": vec["distance_au"],
                    "velocity_kms": vec.get("velocity_kms"),
                    "position_available": True,
                })

            await asyncio.gather(*[_one(c) for c in filtered])

            nonlocal primary_close_approach
            cad_sorted = sorted(
                [c for c in filtered if c.get("lunar_distance") is not None],
                key=lambda c: float(c.get("lunar_distance") or 999),
            )
            if cad_sorted:
                best = cad_sorted[0]
                primary_close_approach = {
                    "name": best.get("name"),
                    "lunar_distance": best.get("lunar_distance"),
                    "diameter_m": (_to_float(best.get("diameter_km")) or 0) * 1000,
                    "close_approach_date": best.get("close_approach_date"),
                    "velocity_kms": best.get("velocity_kms"),
                }

        async def _load_passes() -> None:
            home = get_home_coordinates(hass, config)
            if not home or home.get("lat") is None or home.get("lon") is None:
                return
            lat = float(home["lat"])
            lon = float(home["lon"])
            min_elev = float(spacecraft_alerts_cfg.get("min_elevation_deg") or 10)
            craft_ids = spacecraft_alerts_cfg.get("craft_ids") or [DEFAULT_ISS_ID]
            catalog = await _fetch_horizons_catalog(session, "sct")
            name_by_id = {c["id"]: c["name"] for c in catalog}
            name_by_id[DEFAULT_ISS_ID] = "ISS"

            for craft_id in craft_ids[:5]:
                samples = await _fetch_horizons_observer(session, str(craft_id), lat, lon)
                craft_name = name_by_id.get(str(craft_id), str(craft_id))
                overhead_passes.extend(
                    _detect_overhead_passes(str(craft_id), craft_name, samples, min_elev)
                )

        fetch_tasks.extend([_load_moons(), _load_spacecraft(), _load_small_bodies(), _load_passes()])

    if solar_cfg.get("enabled"):
        async def _load_solar() -> None:
            nonlocal solar_weather
            solar_weather = await _fetch_swpc_solar_weather(session)

        fetch_tasks.append(_load_solar())

    if fetch_tasks:
        await asyncio.gather(*fetch_tasks)

    if not spacecraft_catalog and space_cfg.get("show_spacecraft", True):
        spacecraft_catalog = await _fetch_horizons_catalog(session, "sct")

    return build_coordinator_payload(
        bodies,
        small_bodies,
        primary_close_approach,
        overhead_passes,
        solar_weather,
        spacecraft_catalog,
        neo_alerts_cfg,
        spacecraft_alerts_cfg,
    )
