"""EPA AirNow reporting-area air quality data for Home Weather (no API key).

Source: https://files.airnowtech.org/airnow/today/reportingarea.dat
"""
from __future__ import annotations

import logging
import re
from html import unescape
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .hurricane_data import get_home_coordinates
from .hurricane_geo import haversine_distance_miles

_LOGGER = logging.getLogger(__name__)

AIRNOW_REPORTING_AREA_URL = "https://files.airnowtech.org/airnow/today/reportingarea.dat"

AQI_CATEGORIES = (
    "Good",
    "Moderate",
    "Unhealthy for Sensitive Groups",
    "Unhealthy",
    "Very Unhealthy",
    "Hazardous",
)

CATEGORY_LEVELS = {
    "good": 1,
    "moderate": 2,
    "unhealthy for sensitive groups": 3,
    "unhealthy": 4,
    "very unhealthy": 5,
    "hazardous": 6,
}

CATEGORY_COLORS = {
    1: "#00e400",
    2: "#ffff00",
    3: "#ff7e00",
    4: "#ff0000",
    5: "#8f3f97",
    6: "#7e0023",
}

CATEGORY_LABELS = {
    1: "Good",
    2: "Moderate",
    3: "Unhealthy for Sensitive Groups",
    4: "Unhealthy",
    5: "Very Unhealthy",
    6: "Hazardous",
}

EMPTY_GEOJSON: dict[str, Any] = {"type": "FeatureCollection", "features": []}
_TAG_RE = re.compile(r"<[^>]+>")


def get_air_quality_config(config: dict[str, Any] | None) -> dict[str, Any]:
    """Return merged air quality monitoring settings."""
    defaults = {
        "enabled": True,
        "zone_mode": "zone",
        "alert_zone_mode": "zone",
        "radius_miles": 50,
        "show_on_map": True,
        "min_category_level": 1,
    }
    monitoring = (config or {}).get("air_quality_monitoring") or {}
    merged = {**defaults, **monitoring}
    try:
        merged["min_category_level"] = max(
            1, min(6, int(merged.get("min_category_level") or 1))
        )
    except (TypeError, ValueError):
        merged["min_category_level"] = 1
    return merged


def normalize_category(value: Any) -> tuple[int, str]:
    """Map an AirNow category label to level (1-6) and canonical label."""
    text = str(value or "").strip()
    lowered = text.lower()
    if lowered.startswith("unhealthy for sensitive"):
        return 3, CATEGORY_LABELS[3]
    for key, level in CATEGORY_LEVELS.items():
        if lowered == key:
            return level, CATEGORY_LABELS[level]
    return 1, text or CATEGORY_LABELS[1]


def _strip_html(value: str) -> str:
    return unescape(_TAG_RE.sub(" ", value or "")).strip()


def _to_float(value: Any) -> float | None:
    try:
        if value is None or value == "":
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _to_int(value: Any) -> int | None:
    try:
        if value is None or value == "":
            return None
        return int(float(value))
    except (TypeError, ValueError):
        return None


def parse_reporting_area_line(line: str) -> dict[str, Any] | None:
    """Parse one pipe-delimited row from reportingarea.dat."""
    line = line.strip()
    if not line or line.startswith("#"):
        return None
    parts = line.split("|")
    if len(parts) < 14:
        return None

    name = parts[7].strip()
    state = parts[8].strip()
    lat = _to_float(parts[9])
    lon = _to_float(parts[10])
    pollutant = parts[11].strip().upper()
    aqi = _to_int(parts[12])
    category_text = parts[13].strip()
    if lat is None or lon is None or aqi is None:
        return None

    level, category = normalize_category(category_text)
    agency = parts[16].strip() if len(parts) > 16 else ""
    discussing = _strip_html(parts[15]) if len(parts) > 15 else ""

    return {
        "name": name,
        "state": state,
        "lat": lat,
        "lon": lon,
        "pollutant": pollutant,
        "aqi": aqi,
        "category": category,
        "category_level": level,
        "color": CATEGORY_COLORS.get(level, CATEGORY_COLORS[1]),
        "agency": agency,
        "discussing": discussing[:500] if discussing else "",
        "issue_date": parts[0].strip(),
        "report_date": parts[1].strip(),
        "is_observation": parts[5].strip().upper() == "O",
    }


def parse_reporting_area_dat(text: str) -> list[dict[str, Any]]:
    """Parse reportingarea.dat and return deduplicated reporting areas."""
    by_key: dict[str, dict[str, Any]] = {}
    pollutants: dict[str, set[str]] = {}

    for line in (text or "").splitlines():
        row = parse_reporting_area_line(line)
        if not row:
            continue
        key = f"{row['name']}|{row['state']}|{row['lat']:.4f}|{row['lon']:.4f}"
        pollutants.setdefault(key, set()).add(row["pollutant"])

        existing = by_key.get(key)
        if not existing:
            by_key[key] = row
            continue
        if row["aqi"] > existing["aqi"]:
            by_key[key] = row
        elif row["aqi"] == existing["aqi"] and row["is_observation"] and not existing["is_observation"]:
            by_key[key] = row

    areas = []
    for key, row in by_key.items():
        row = dict(row)
        row["id"] = key
        row["pollutants"] = sorted(pollutants.get(key, {row["pollutant"]}))
        areas.append(row)
    return areas


def passes_air_quality_filter(
    area: dict[str, Any],
    air_quality_config: dict[str, Any],
) -> bool:
    """Return True when a reporting area meets map filters."""
    if not air_quality_config.get("enabled", True):
        return False
    min_level = int(air_quality_config.get("min_category_level") or 1)
    return int(area.get("category_level") or 1) >= min_level


def passes_air_quality_geofield_filter(
    area: dict[str, Any],
    air_quality_config: dict[str, Any],
) -> bool:
    """Return True when a reporting area is inside the configured radius (ignores sensor bypass)."""
    if not passes_air_quality_filter(area, air_quality_config):
        return False
    radius = float(air_quality_config.get("radius_miles") or 50)
    distance = area.get("distance_miles")
    if distance is None or distance > radius:
        return False
    return True


def passes_air_quality_sensor_scope_filter(
    area: dict[str, Any],
    air_quality_config: dict[str, Any],
) -> bool:
    """Return True when a reporting area meets sensor-scope filters (may bypass radius)."""
    if not passes_air_quality_filter(area, air_quality_config):
        return False
    if air_quality_config.get("zone_mode", "zone") == "all":
        return True
    return passes_air_quality_geofield_filter(area, air_quality_config)


def pick_primary_air_quality(areas: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Return the primary air quality area (highest AQI, then nearest)."""
    if not areas:
        return None
    return min(
        areas,
        key=lambda item: (
            -(item.get("aqi") or 0),
            item.get("distance_miles")
            if item.get("distance_miles") is not None
            else float("inf"),
        ),
    )


def _air_quality_event_tracking_signature(area: dict[str, Any]) -> dict[str, Any]:
    return {
        "aqi": area.get("aqi"),
        "category_level": area.get("category_level"),
        "category": area.get("category"),
    }


def _air_quality_event_payload(area: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": area.get("id"),
        "name": area.get("name"),
        "state": area.get("state"),
        "aqi": area.get("aqi"),
        "category": area.get("category"),
        "category_level": area.get("category_level"),
        "pollutant": area.get("pollutant"),
        "distance_miles": area.get("distance_miles"),
        "lat": area.get("lat"),
        "lon": area.get("lon"),
    }


def detect_air_quality_events(
    previous: dict[str, dict[str, Any]],
    current_events: list[dict[str, Any]],
) -> list[tuple[str, dict[str, Any]]]:
    """Return bus events to fire: (event_type, payload)."""
    events_out: list[tuple[str, dict[str, Any]]] = []
    current_by_id = {str(e["id"]): e for e in current_events if e.get("id")}
    current_ids = set(current_by_id)

    for area_id, area in current_by_id.items():
        payload = _air_quality_event_payload(area)
        prev = previous.get(area_id)
        if prev is None:
            events_out.append(("home_weather_air_quality_unhealthy", payload))
            continue
        if _air_quality_event_tracking_signature(prev) != _air_quality_event_tracking_signature(
            area
        ):
            events_out.append(("home_weather_air_quality_updated", payload))

    for area_id in set(previous) - current_ids:
        events_out.append(
            (
                "home_weather_air_quality_cleared",
                _air_quality_event_payload(previous[area_id]),
            )
        )

    return events_out


def build_air_quality_geojson(
    areas: list[dict[str, Any]],
    air_quality_config: dict[str, Any],
    *,
    home: dict[str, float],
) -> dict[str, Any]:
    """Build point GeoJSON for air quality reporting areas."""
    if not air_quality_config.get("show_on_map", True):
        return EMPTY_GEOJSON

    features: list[dict[str, Any]] = []
    for area in areas:
        if not passes_air_quality_filter(area, air_quality_config):
            continue
        lat = float(area["lat"])
        lon = float(area["lon"])
        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [lon, lat]},
                "properties": {
                    **area,
                    "distance_miles": round(
                        haversine_distance_miles(home["lat"], home["lon"], lat, lon), 1
                    ),
                },
            }
        )
    return {"type": "FeatureCollection", "features": features}


def build_coordinator_payload(
    areas: list[dict[str, Any]],
    air_quality_config: dict[str, Any],
    *,
    home: dict[str, float],
) -> dict[str, Any]:
    """Build coordinator payload for air quality monitoring."""
    filtered = [a for a in areas if passes_air_quality_filter(a, air_quality_config)]
    for area in filtered:
        lat = float(area["lat"])
        lon = float(area["lon"])
        area["distance_miles"] = round(
            haversine_distance_miles(home["lat"], home["lon"], lat, lon), 1
        )

    geofield_events = [
        a for a in filtered if passes_air_quality_geofield_filter(a, air_quality_config)
    ]
    sensor_events = [
        a for a in filtered if passes_air_quality_sensor_scope_filter(a, air_quality_config)
    ]
    alert_mode = str(
        air_quality_config.get("alert_zone_mode", air_quality_config.get("zone_mode", "zone"))
    ).lower()
    alert_events = filtered if alert_mode == "all" else geofield_events
    primary = pick_primary_air_quality(sensor_events)

    geojson = build_air_quality_geojson(areas, air_quality_config, home=home)

    level_counts = {level: 0 for level in range(1, 7)}
    for area in areas:
        level = int(area.get("category_level") or 1)
        level_counts[level] = level_counts.get(level, 0) + 1

    unhealthy_count = sum(
        level_counts.get(level, 0) for level in (3, 4, 5, 6)
    )
    sorted_areas = sorted(
        filtered,
        key=lambda item: (-(item.get("aqi") or 0), item.get("distance_miles") or 99999),
    )

    worst = sorted_areas[0] if sorted_areas else None
    nearest_unhealthy = next(
        (
            a
            for a in sorted(filtered, key=lambda item: item.get("distance_miles") or 99999)
            if int(a.get("category_level") or 1) >= 3
        ),
        None,
    )

    return {
        "areas": sorted_areas,
        "geofield_events": geofield_events,
        "sensor_events": sensor_events,
        "alert_events": alert_events,
        "area_count": len(areas),
        "filtered_count": len(filtered),
        "geofield_count": len(geofield_events),
        "in_geofield": len(geofield_events) > 0,
        "map_count": len(geojson.get("features") or []),
        "level_counts": level_counts,
        "unhealthy_count": unhealthy_count,
        "worst_area": worst,
        "nearest_unhealthy": nearest_unhealthy,
        "primary_geofield": primary,
        "geojson": geojson,
        "source": "EPA AirNow",
    }


def empty_payload() -> dict[str, Any]:
    """Return an empty air quality payload."""
    return build_coordinator_payload([], get_air_quality_config({}), home={"lat": 0, "lon": 0})


async def async_fetch_air_quality(
    hass: HomeAssistant,
    config: dict[str, Any] | None,
) -> dict[str, Any]:
    """Fetch EPA AirNow reporting-area data."""
    air_quality_config = get_air_quality_config(config)
    if not air_quality_config.get("enabled", True):
        return empty_payload()

    home = get_home_coordinates(hass, config)
    session = async_get_clientsession(hass)

    async with session.get(AIRNOW_REPORTING_AREA_URL, timeout=60) as resp:
        resp.raise_for_status()
        text = await resp.text()

    areas = parse_reporting_area_dat(text)
    _LOGGER.debug("Parsed %d EPA AirNow reporting areas", len(areas))
    return build_coordinator_payload(areas, air_quality_config, home=home)
