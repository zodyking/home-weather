"""Shared helpers for Home Weather hazard entities."""
from __future__ import annotations

from typing import Any

from homeassistant.config_entries import ConfigEntry

from ..const import DOMAIN


def hazard_device_info(entry: ConfigEntry, hazard: str) -> dict[str, Any]:
    """Return device_info for a hazard device group."""
    labels = {
        "earthquake": "Earthquake",
        "tornado": "Tornado",
        "hurricane": "Hurricane",
        "lightning": "Lightning",
        "volcano": "Volcano",
        "wildfire": "Wildfire",
        "air_quality": "Air Quality",
        "space": "Space",
        "solar_weather": "Solar Weather",
    }
    return {
        "identifiers": {(DOMAIN, entry.entry_id, hazard)},
        "name": f"Home Weather {labels.get(hazard, hazard.title())}",
        "manufacturer": "Home Weather",
    }


def primary_geofield(data: dict[str, Any] | None, key: str = "primary_geofield") -> dict[str, Any] | None:
    """Return primary geofield record from coordinator data."""
    if not data:
        return None
    return data.get(key) or data.get("primary_event") or data.get("primary_alert")


def has_sensor_data(data: dict[str, Any] | None, key: str = "primary_geofield") -> bool:
    """Return True when coordinator payload has a primary record for detail sensors."""
    if primary_geofield(data, key):
        return True
    if not data:
        return False
    summary = data.get("sensor_summary") or {}
    if summary.get("closest_storm_name") or summary.get("distance_miles") is not None:
        return True
    for count_key in ("active_count", "warning_active", "nearby_active"):
        if int(data.get(count_key) or 0) > 0:
            return True
    for list_key in ("alerts", "events", "sensor_events"):
        items = data.get(list_key)
        if isinstance(items, list) and items:
            return True
    return False
