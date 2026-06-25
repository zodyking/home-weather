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
