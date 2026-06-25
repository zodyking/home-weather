"""Fetch and parse USGS earthquake GeoJSON feeds."""
from __future__ import annotations

import asyncio
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
        "feed_type": "all_hour",
        "tsunami_alert_enabled": True,
        "map_show_worldwide": True,
        "map_min_magnitude": 4.5,
        "map_feed_type": "all_day",
    }
    merged = {**defaults, **((config or {}).get("earthquakes") or {})}
    if merged["feed_type"] not in USGS_FEED_TYPES:
        merged["feed_type"] = "all_hour"
    if merged["map_feed_type"] not in USGS_FEED_TYPES:
        merged["map_feed_type"] = "4.5_week"
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


def passes_map_filters(
    event: dict[str, Any],
    eq_config: dict[str, Any],
) -> bool:
    """Return True when an event should appear on the worldwide map."""
    magnitude = event.get("magnitude")
    min_mag = float(eq_config.get("map_min_magnitude", 4.5))
    if magnitude is None or magnitude < min_mag:
        return False

    if not eq_config.get("tsunami_alert_enabled", True) and event.get("tsunami") == 1:
        return False

    return True


def _start_of_today_ms() -> int:
    """Return local-midnight today as USGS epoch milliseconds."""
    now = dt_util.now()
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    return int(start.timestamp() * 1000)


def is_event_today(event: dict[str, Any], start_ms: int) -> bool:
    """Return True when event time is on or after local midnight today."""
    event_time = event.get("time")
    return event_time is not None and event_time >= start_ms


def parse_earthquake_features(
    features: list[dict[str, Any]],
    home: dict[str, float],
    eq_config: dict[str, Any],
) -> list[dict[str, Any]]:
    """Parse and filter USGS earthquake features for nearby alerts/monitoring."""
    events: list[dict[str, Any]] = []
    for feature in features:
        parsed = parse_earthquake_feature(feature, home)
        if parsed and passes_earthquake_filters(parsed, eq_config):
            events.append(parsed)
    return sort_earthquakes_by_newest(events)


def parse_earthquake_features_for_map(
    features: list[dict[str, Any]],
    home: dict[str, float],
    eq_config: dict[str, Any],
) -> list[dict[str, Any]]:
    """Parse USGS features for worldwide map display (magnitude only, no radius)."""
    start_ms = _start_of_today_ms()
    events: list[dict[str, Any]] = []
    for feature in features:
        parsed = parse_earthquake_feature(feature, home)
        if (
            parsed
            and passes_map_filters(parsed, eq_config)
            and is_event_today(parsed, start_ms)
        ):
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


def build_earthquake_geojson(
    events: list[dict[str, Any]],
    *,
    nearby_ids: set[str] | None = None,
) -> dict[str, Any]:
    """Build map-ready FeatureCollection from normalized events."""
    nearby = nearby_ids or set()
    features: list[dict[str, Any]] = []
    for event in events:
        lat = event.get("latitude")
        lon = event.get("longitude")
        if lat is None or lon is None:
            continue
        eq_id = str(event.get("id") or "")
        depth = event.get("depth_km")
        coordinates = [lon, lat, depth if depth is not None else 0.0]
        features.append(
            {
                "type": "Feature",
                "id": eq_id,
                "properties": {
                    "id": eq_id,
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
                    "nearby": eq_id in nearby,
                },
                "geometry": {
                    "type": "Point",
                    "coordinates": coordinates,
                },
            }
        )
    return {"type": "FeatureCollection", "features": features}


def merge_map_display_events(
    nearby_events: list[dict[str, Any]],
    map_events: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Combine worldwide map events with nearby live events (nearby wins on id clash)."""
    merged: dict[str, dict[str, Any]] = {}
    for event in map_events:
        eq_id = str(event.get("id") or "")
        if eq_id:
            merged[eq_id] = event
    for event in nearby_events:
        eq_id = str(event.get("id") or "")
        if eq_id:
            merged[eq_id] = event
    return list(merged.values())


def build_coordinator_payload(
    events: list[dict[str, Any]],
    map_events: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Build coordinator payload from nearby and worldwide map earthquakes."""
    nearby_ids = {str(e["id"]) for e in events if e.get("id")}
    if map_events is None:
        display_events = events
    else:
        display_events = merge_map_display_events(events, map_events)
    nearest = pick_nearest_earthquake(events)
    tsunami_in_geofield = any(e.get("tsunami") == 1 for e in events)
    return {
        "events": events,
        "geofield_events": events,
        "map_events": display_events,
        "active_count": len(events),
        "geofield_count": len(events),
        "map_count": len(display_events),
        "nearby_active": len(events) > 0,
        "in_geofield": len(events) > 0,
        "tsunami_in_geofield": tsunami_in_geofield,
        "nearest_distance_miles": nearest.get("distance_miles") if nearest else None,
        "nearest_magnitude": nearest.get("magnitude") if nearest else None,
        "nearest_depth_km": nearest.get("depth_km") if nearest else None,
        "nearest_place": nearest.get("place") if nearest else None,
        "primary_event": nearest,
        "primary_geofield": nearest,
        "geojson": build_earthquake_geojson(display_events, nearby_ids=nearby_ids),
        "last_updated": dt_util.utcnow().isoformat(),
    }


def empty_coordinator_payload() -> dict[str, Any]:
    """Return empty payload when monitoring is disabled."""
    return {
        "events": [],
        "geofield_events": [],
        "map_events": [],
        "active_count": 0,
        "geofield_count": 0,
        "map_count": 0,
        "nearby_active": False,
        "in_geofield": False,
        "tsunami_in_geofield": False,
        "nearest_distance_miles": None,
        "nearest_magnitude": None,
        "nearest_depth_km": None,
        "nearest_place": None,
        "primary_event": None,
        "primary_geofield": None,
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


async def _fetch_usgs_feed(session: Any, feed_type: str) -> list[dict[str, Any]]:
    """Fetch a USGS summary GeoJSON feed and return feature list."""
    url = build_feed_url(feed_type)
    async with session.get(url, timeout=30) as resp:
        if resp.status != 200:
            _LOGGER.warning("USGS earthquake feed returned %s for %s", resp.status, url)
            return []
        data = await resp.json()
    features = data.get("features") if isinstance(data, dict) else []
    if not isinstance(features, list):
        return []
    return features


async def async_fetch_earthquakes(
    hass: HomeAssistant,
    config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Fetch and normalize USGS earthquake data.

    Nearby alerts use the configured real-time feed with a home-radius filter.
    The hazard map uses a separate worldwide feed filtered by map magnitude only.
    """
    eq_config = get_earthquake_config(config)
    if not eq_config.get("enabled", True):
        return empty_coordinator_payload()

    home = get_home_coordinates(hass, config)
    session = async_get_clientsession(hass)
    alert_feed = eq_config["feed_type"]
    map_show_worldwide = bool(eq_config.get("map_show_worldwide", True))
    map_feed = eq_config.get("map_feed_type", alert_feed)

    try:
        if map_show_worldwide and map_feed != alert_feed:
            alert_features, map_features = await asyncio.gather(
                _fetch_usgs_feed(session, alert_feed),
                _fetch_usgs_feed(session, map_feed),
            )
        else:
            alert_features = await _fetch_usgs_feed(session, alert_feed)
            map_features = alert_features if map_show_worldwide else []
    except Exception as err:
        _LOGGER.warning("USGS earthquake fetch failed: %s", err)
        return empty_coordinator_payload()

    events = parse_earthquake_features(alert_features, home, eq_config)
    if map_show_worldwide:
        map_events = parse_earthquake_features_for_map(map_features, home, eq_config)
    else:
        map_events = events
    return build_coordinator_payload(events, map_events)
