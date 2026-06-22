"""Fetch and parse USGS earthquake GeoJSON feeds."""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.util import dt as dt_util

from .hurricane_data import get_home_coordinates
from .hurricane_geo import haversine_distance_miles

_LOGGER = logging.getLogger(__name__)

USGS_FEED_BASE = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary"
USGS_FEED_TYPES = {
    "all_hour": "all_hour.geojson",
    "all_day": "all_day.geojson",
    "2.5_day": "2.5_day.geojson",
    "4.5_week": "4.5_week.geojson",
}

EMPTY_GEOJSON: dict[str, Any] = {"type": "FeatureCollection", "features": []}


def get_earthquake_config(config: dict[str, Any] | None) -> dict[str, Any]:
    """Return merged earthquake config with defaults."""
    defaults = {
        "enabled": True,
        "min_magnitude": 2.5,
        "radius_miles": 500,
        "feed_type": "2.5_day",
        "tsunami_alert_enabled": True,
    }
    merged = {**defaults, **((config or {}).get("earthquakes") or {})}
    if merged["feed_type"] not in USGS_FEED_TYPES:
        merged["feed_type"] = "2.5_day"
    return merged


def build_feed_url(feed_type: str) -> str:
    """Build USGS summary feed URL for the configured feed type."""
    suffix = USGS_FEED_TYPES.get(feed_type, USGS_FEED_TYPES["2.5_day"])
    return f"{USGS_FEED_BASE}/{suffix}"


def _parse_timestamp(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def parse_earthquake_feature(
    feature: dict[str, Any],
    home: dict[str, float],
) -> dict[str, Any] | None:
    """Parse a USGS GeoJSON feature into a normalized earthquake dict."""
    if not isinstance(feature, dict):
        return None

    props = feature.get("properties") or {}
    geometry = feature.get("geometry")
    if not isinstance(geometry, dict):
        _LOGGER.debug("Skipping earthquake %s: missing geometry", props.get("id"))
        return None

    coords = geometry.get("coordinates")
    if not isinstance(coords, list) or len(coords) < 2:
        _LOGGER.debug("Skipping earthquake %s: invalid coordinates", props.get("id"))
        return None

    try:
        lon = float(coords[0])
        lat = float(coords[1])
        depth_km = float(coords[2]) if len(coords) > 2 and coords[2] is not None else None
    except (TypeError, ValueError):
        _LOGGER.debug("Skipping earthquake %s: non-numeric coordinates", props.get("id"))
        return None

    home_lat = float(home["lat"])
    home_lon = float(home["lon"])
    distance_miles = round(
        haversine_distance_miles(home_lat, home_lon, lat, lon),
        1,
    )

    mag_raw = props.get("mag")
    try:
        magnitude = float(mag_raw) if mag_raw is not None else None
    except (TypeError, ValueError):
        magnitude = None

    eq_id = str(props.get("id") or feature.get("id") or "")
    if not eq_id:
        return None

    tsunami_raw = props.get("tsunami")
    try:
        tsunami = int(tsunami_raw) if tsunami_raw is not None else 0
    except (TypeError, ValueError):
        tsunami = 0

    felt_raw = props.get("felt")
    try:
        felt = int(felt_raw) if felt_raw is not None else None
    except (TypeError, ValueError):
        felt = None

    return {
        "id": eq_id,
        "magnitude": magnitude,
        "place": props.get("place") or "",
        "time": _parse_timestamp(props.get("time")),
        "updated": _parse_timestamp(props.get("updated")),
        "url": props.get("url") or "",
        "felt": felt,
        "tsunami": tsunami,
        "type": props.get("type") or "",
        "longitude": lon,
        "latitude": lat,
        "depth_km": depth_km,
        "distance_miles": distance_miles,
    }


def passes_earthquake_filters(
    event: dict[str, Any],
    eq_config: dict[str, Any],
) -> bool:
    """Return True when an event meets magnitude, radius, and tsunami filters."""
    magnitude = event.get("magnitude")
    min_mag = float(eq_config.get("min_magnitude", 2.5))
    if magnitude is None or magnitude < min_mag:
        return False

    radius = float(eq_config.get("radius_miles", 500))
    distance = event.get("distance_miles")
    if distance is None or distance > radius:
        return False

    if not eq_config.get("tsunami_alert_enabled", True) and event.get("tsunami") == 1:
        return False

    return True


def parse_earthquake_features(
    features: list[dict[str, Any]],
    home: dict[str, float],
    eq_config: dict[str, Any],
) -> list[dict[str, Any]]:
    """Parse and filter USGS earthquake features."""
    events: list[dict[str, Any]] = []
    for feature in features:
        parsed = parse_earthquake_feature(feature, home)
        if parsed and passes_earthquake_filters(parsed, eq_config):
            events.append(parsed)
    return sort_earthquakes_by_newest(events)


def sort_earthquakes_by_newest(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Sort earthquakes newest first by USGS time (ms epoch)."""
    return sorted(
        events,
        key=lambda e: e.get("time") or 0,
        reverse=True,
    )


def pick_nearest_earthquake(events: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Return nearest qualifying earthquake."""
    if not events:
        return None
    return min(
        events,
        key=lambda e: (
            e.get("distance_miles") if e.get("distance_miles") is not None else float("inf"),
            -(e.get("time") or 0),
        ),
    )


def build_earthquake_geojson(events: list[dict[str, Any]]) -> dict[str, Any]:
    """Build map-ready FeatureCollection from normalized events."""
    features: list[dict[str, Any]] = []
    for event in events:
        lat = event.get("latitude")
        lon = event.get("longitude")
        if lat is None or lon is None:
            continue
        depth = event.get("depth_km")
        coordinates = [lon, lat, depth if depth is not None else 0.0]
        features.append(
            {
                "type": "Feature",
                "id": event.get("id"),
                "properties": {
                    "id": event.get("id"),
                    "mag": event.get("magnitude"),
                    "place": event.get("place"),
                    "time": event.get("time"),
                    "updated": event.get("updated"),
                    "url": event.get("url"),
                    "felt": event.get("felt"),
                    "tsunami": event.get("tsunami"),
                    "type": event.get("type"),
                    "distance_miles": event.get("distance_miles"),
                    "depth_km": event.get("depth_km"),
                },
                "geometry": {
                    "type": "Point",
                    "coordinates": coordinates,
                },
            }
        )
    return {"type": "FeatureCollection", "features": features}


def build_coordinator_payload(
    events: list[dict[str, Any]],
) -> dict[str, Any]:
    """Build coordinator payload from qualifying earthquakes."""
    nearest = pick_nearest_earthquake(events)
    return {
        "events": events,
        "active_count": len(events),
        "nearby_active": len(events) > 0,
        "nearest_distance_miles": nearest.get("distance_miles") if nearest else None,
        "nearest_magnitude": nearest.get("magnitude") if nearest else None,
        "nearest_depth_km": nearest.get("depth_km") if nearest else None,
        "nearest_place": nearest.get("place") if nearest else None,
        "primary_event": nearest,
        "geojson": build_earthquake_geojson(events),
        "last_updated": dt_util.utcnow().isoformat(),
    }


def empty_coordinator_payload() -> dict[str, Any]:
    """Return empty payload when monitoring is disabled."""
    return {
        "events": [],
        "active_count": 0,
        "nearby_active": False,
        "nearest_distance_miles": None,
        "nearest_magnitude": None,
        "nearest_depth_km": None,
        "nearest_place": None,
        "primary_event": None,
        "geojson": dict(EMPTY_GEOJSON),
        "last_updated": dt_util.utcnow().isoformat(),
    }


def _event_tracking_signature(event: dict[str, Any]) -> dict[str, Any]:
    return {
        "magnitude": event.get("magnitude"),
        "updated": event.get("updated"),
        "place": event.get("place"),
        "tsunami": event.get("tsunami"),
    }


def _event_payload(event: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": event.get("id"),
        "magnitude": event.get("magnitude"),
        "place": event.get("place"),
        "time": event.get("time"),
        "updated": event.get("updated"),
        "url": event.get("url"),
        "distance_miles": event.get("distance_miles"),
        "depth_km": event.get("depth_km"),
        "tsunami": event.get("tsunami"),
        "latitude": event.get("latitude"),
        "longitude": event.get("longitude"),
    }


def detect_earthquake_events(
    previous: dict[str, dict[str, Any]],
    current_events: list[dict[str, Any]],
) -> list[tuple[str, dict[str, Any]]]:
    """Return bus events to fire: (event_type, payload)."""
    events_out: list[tuple[str, dict[str, Any]]] = []
    current_by_id = {e["id"]: e for e in current_events if e.get("id")}
    current_ids = set(current_by_id)

    for eq_id, event in current_by_id.items():
        payload = _event_payload(event)
        prev = previous.get(eq_id)
        if prev is None:
            events_out.append(("home_weather_earthquake_detected", payload))
            continue
        if _event_tracking_signature(prev) != _event_tracking_signature(event):
            events_out.append(("home_weather_earthquake_updated", payload))

    for eq_id in set(previous) - current_ids:
        events_out.append(
            (
                "home_weather_earthquake_cleared",
                _event_payload(previous[eq_id]),
            )
        )

    return events_out


async def async_fetch_earthquakes(
    hass: HomeAssistant,
    config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Fetch and normalize USGS earthquake data."""
    eq_config = get_earthquake_config(config)
    if not eq_config.get("enabled", True):
        return empty_coordinator_payload()

    home = get_home_coordinates(hass, config)
    url = build_feed_url(eq_config["feed_type"])
    session = async_get_clientsession(hass)

    try:
        async with session.get(url, timeout=30) as resp:
            if resp.status != 200:
                _LOGGER.warning("USGS earthquake feed returned %s for %s", resp.status, url)
                return empty_coordinator_payload()
            data = await resp.json()
    except Exception as err:
        _LOGGER.warning("USGS earthquake fetch failed: %s", err)
        return empty_coordinator_payload()

    features = data.get("features") if isinstance(data, dict) else []
    if not isinstance(features, list):
        features = []

    events = parse_earthquake_features(features, home, eq_config)
    return build_coordinator_payload(events)
