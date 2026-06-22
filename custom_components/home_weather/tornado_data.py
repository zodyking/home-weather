"""Fetch and parse NWS tornado warning data."""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.util import dt as dt_util

from .hurricane_data import get_home_coordinates
from .tornado_geo import (
    SEVERITY_RANK,
    distance_to_polygon,
    normalize_geojson_geometry,
    point_in_polygon,
    polygon_centroid,
)

_LOGGER = logging.getLogger(__name__)

NWS_TORNADO_EVENT_URL = "https://api.weather.gov/alerts/active?event=Tornado%20Warning"
NWS_ZONE_URL = "https://api.weather.gov/alerts/active/zone/{zone_id}"
TORNADO_EVENT = "Tornado Warning"


def _parse_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return dt_util.parse_datetime(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None


def is_alert_expired(props: dict[str, Any], now: datetime | None = None) -> bool:
    """Return True if alert expires/end is in the past."""
    now = now or dt_util.now()
    exp = props.get("expires") or props.get("ends")
    exp_dt = _parse_datetime(str(exp) if exp else None)
    return bool(exp_dt and now > exp_dt)


def parse_tornado_feature(
    feature: dict[str, Any],
    home: dict[str, float],
) -> dict[str, Any] | None:
    """Parse a GeoJSON feature into a normalized tornado alert dict."""
    props = feature.get("properties") or {}
    if props.get("event") != TORNADO_EVENT:
        return None

    if is_alert_expired(props):
        return None

    raw_geometry = feature.get("geometry")
    geometry = normalize_geojson_geometry(raw_geometry)
    if not geometry and raw_geometry:
        _LOGGER.debug(
            "Skipping tornado alert %s: malformed geometry type=%s",
            props.get("id"),
            raw_geometry.get("type") if isinstance(raw_geometry, dict) else None,
        )

    home_lat = float(home["lat"])
    home_lon = float(home["lon"])
    affecting_home = (
        point_in_polygon(home_lat, home_lon, geometry) if geometry else False
    )
    dist = distance_to_polygon(home_lat, home_lon, geometry) if geometry else None
    centroid = polygon_centroid(geometry) if geometry else None

    alert_id = props.get("id") or feature.get("id") or ""
    affected_zones = props.get("affectedZones") or props.get("geocode", {}).get("UGC") or []

    return {
        "alert_id": alert_id,
        "event": props.get("event"),
        "headline": props.get("headline") or "",
        "description": props.get("description") or "",
        "instruction": props.get("instruction") or "",
        "severity": props.get("severity") or "Unknown",
        "urgency": props.get("urgency") or "Unknown",
        "certainty": props.get("certainty") or "Unknown",
        "onset": props.get("onset"),
        "effective": props.get("effective"),
        "expires": props.get("expires") or props.get("ends"),
        "senderName": props.get("senderName") or "",
        "affected_zones": affected_zones,
        "geometry": geometry,
        "coordinates": geometry.get("coordinates") if geometry else None,
        "geometry_type": geometry.get("type") if geometry else None,
        "areaDesc": props.get("areaDesc") or "",
        "affecting_home": affecting_home,
        "distance_miles": dist,
        "centroid": centroid,
    }


def parse_tornado_features(
    features: list[dict[str, Any]],
    home: dict[str, float],
) -> list[dict[str, Any]]:
    """Parse and filter tornado warning features."""
    alerts: list[dict[str, Any]] = []
    for feature in features:
        if not isinstance(feature, dict):
            continue
        parsed = parse_tornado_feature(feature, home)
        if parsed:
            alerts.append(parsed)
    return sort_tornado_alerts_by_priority(alerts)


def sort_tornado_alerts_by_priority(alerts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Sort alerts: home first, then distance, severity, soonest expiration."""
    def sort_key(alert: dict[str, Any]) -> tuple:
        exp_dt = _parse_datetime(str(alert.get("expires") or ""))
        exp_ts = exp_dt.timestamp() if exp_dt else float("inf")
        severity = SEVERITY_RANK.get(str(alert.get("severity") or "Unknown"), 0)
        distance = alert.get("distance_miles")
        if distance is None:
            distance = float("inf")
        return (
            0 if alert.get("affecting_home") else 1,
            float(distance),
            -severity,
            exp_ts,
        )

    return sorted(alerts, key=sort_key)


def build_geojson_feature_collection(alerts: list[dict[str, Any]]) -> dict[str, Any]:
    """Build a map-ready GeoJSON FeatureCollection from active alerts."""
    features: list[dict[str, Any]] = []
    for alert in alerts:
        geometry = alert.get("geometry")
        if not geometry:
            continue
        features.append(
            {
                "type": "Feature",
                "properties": {
                    "alert_id": alert.get("alert_id"),
                    "event": alert.get("event"),
                    "headline": alert.get("headline"),
                    "severity": alert.get("severity"),
                    "urgency": alert.get("urgency"),
                    "certainty": alert.get("certainty"),
                    "expires": alert.get("expires"),
                    "areaDesc": alert.get("areaDesc"),
                    "affecting_home": alert.get("affecting_home"),
                    "distance_miles": alert.get("distance_miles"),
                },
                "geometry": geometry,
            }
        )
    return {"type": "FeatureCollection", "features": features}


def build_coordinator_payload(
    alerts: list[dict[str, Any]],
    config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build normalized coordinator data payload."""
    primary = alerts[0] if alerts else None
    affecting_home = any(a.get("affecting_home") for a in alerts)
    distances = [a["distance_miles"] for a in alerts if a.get("distance_miles") is not None]
    nearest_distance = min(distances) if distances else None
    geojson = build_geojson_feature_collection(alerts)

    polygons = []
    for alert in alerts:
        if alert.get("geometry"):
            polygons.append(
                {
                    "alert_id": alert.get("alert_id"),
                    "geometry": alert.get("geometry"),
                    "centroid": alert.get("centroid"),
                    "geometry_type": alert.get("geometry_type"),
                }
            )

    return {
        "alerts": alerts,
        "active_count": len(alerts),
        "affecting_home": affecting_home,
        "warning_active": is_binary_warning_on(alerts, config),
        "nearest_distance_miles": nearest_distance,
        "primary_alert": primary,
        "geojson": geojson,
        "polygons": polygons,
        "last_updated": dt_util.utcnow().isoformat(),
    }


def _alert_tracking_signature(alert: dict[str, Any]) -> dict[str, Any]:
    """Fields used to detect meaningful alert updates."""
    return {
        "geometry": alert.get("geometry"),
        "severity": alert.get("severity"),
        "urgency": alert.get("urgency"),
        "expires": alert.get("expires"),
    }


def detect_tornado_events(
    previous: dict[str, dict[str, Any]],
    current_alerts: list[dict[str, Any]],
) -> list[tuple[str, dict[str, Any]]]:
    """Return bus events to fire: (event_type, payload)."""
    events: list[tuple[str, dict[str, Any]]] = []
    current_by_id = {a["alert_id"]: a for a in current_alerts if a.get("alert_id")}
    current_ids = set(current_by_id)

    for alert_id, alert in current_by_id.items():
        payload = _event_payload(alert)
        prev = previous.get(alert_id)
        if prev is None:
            events.append(("home_weather_tornado_warning_issued", payload))
            continue

        if _alert_tracking_signature(prev) != _alert_tracking_signature(alert):
            events.append(("home_weather_tornado_warning_updated", payload))

    for alert_id in set(previous) - current_ids:
        prev = previous[alert_id]
        events.append(
            (
                "home_weather_tornado_warning_cleared",
                _event_payload(prev),
            )
        )

    return events


def _event_payload(alert: dict[str, Any]) -> dict[str, Any]:
    geometry = alert.get("geometry")
    return {
        "alert_id": alert.get("alert_id"),
        "headline": alert.get("headline"),
        "severity": alert.get("severity"),
        "urgency": alert.get("urgency"),
        "expires": alert.get("expires"),
        "affecting_home": alert.get("affecting_home"),
        "distance_miles": alert.get("distance_miles"),
        "geojson": (
            build_geojson_feature_collection([alert])
            if geometry
            else {"type": "FeatureCollection", "features": []}
        ),
    }


def is_binary_warning_on(
    alerts: list[dict[str, Any]],
    config: dict[str, Any] | None = None,
) -> bool:
    """Return True when a tornado warning affects home or configured zone."""
    if not alerts:
        return False
    if (config or {}).get("nws_zone"):
        return True
    return any(a.get("affecting_home") for a in alerts)


async def async_fetch_tornado_alerts(
    hass: HomeAssistant,
    config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Fetch active tornado warnings from the NWS Alerts API."""
    config = config or {}
    home = get_home_coordinates(hass, config)
    zone = (config.get("nws_zone") or "").strip()

    if zone:
        url = NWS_ZONE_URL.format(zone_id=zone)
    else:
        url = NWS_TORNADO_EVENT_URL

    headers = {"Accept": "application/geo+json", "User-Agent": "Home-Weather/1.0"}

    try:
        session = async_get_clientsession(hass)
        async with session.get(url, headers=headers, timeout=30) as resp:
            if resp.status != 200:
                _LOGGER.warning("NWS tornado alerts API returned %s for %s", resp.status, url)
                return build_coordinator_payload([], config)
            data = await resp.json()
    except Exception as err:
        _LOGGER.warning("NWS tornado alerts fetch failed: %s", err)
        return build_coordinator_payload([], config)

    features = data.get("features") if isinstance(data, dict) else None
    if not features:
        return build_coordinator_payload([], config)

    alerts = parse_tornado_features(features, home)
    return build_coordinator_payload(alerts, config)
