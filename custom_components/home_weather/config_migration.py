"""Config schema migration for Home Weather storage."""
from __future__ import annotations

from typing import Any

from .const import DEFAULT_CONFIG


def migrate_config(data: dict[str, Any]) -> dict[str, Any]:
    """Deep-merge stored config with defaults and apply version migrations."""
    merged: dict[str, Any] = {}
    for key, default_val in DEFAULT_CONFIG.items():
        if isinstance(default_val, dict):
            stored = data.get(key)
            if isinstance(stored, dict):
                merged[key] = {**default_val, **stored}
            else:
                merged[key] = {**default_val}
        else:
            merged[key] = data.get(key, default_val)

    for key, val in data.items():
        if key not in DEFAULT_CONFIG:
            merged[key] = val

    _migrate_monitoring_blocks(merged, data)
    return merged


def _migrate_monitoring_blocks(merged: dict[str, Any], raw: dict[str, Any]) -> None:
    """Seed monitoring blocks from legacy keys when upgrading pre-v3 storage."""
    if "hurricane_monitoring" not in raw:
        tropical = raw.get("tropical_alerts") or {}
        merged["hurricane_monitoring"] = {
            **DEFAULT_CONFIG["hurricane_monitoring"],
            "max_distance_miles": tropical.get(
                "max_distance_miles",
                DEFAULT_CONFIG["hurricane_monitoring"]["max_distance_miles"],
            ),
            "min_threat_level": tropical.get(
                "min_threat_level",
                DEFAULT_CONFIG["hurricane_monitoring"]["min_threat_level"],
            ),
        }

    if "tornado_monitoring" not in raw:
        tornado = raw.get("tornado_alerts") or {}
        merged["tornado_monitoring"] = {
            **DEFAULT_CONFIG["tornado_monitoring"],
            "only_affecting_home": tornado.get(
                "only_affecting_home",
                DEFAULT_CONFIG["tornado_monitoring"]["only_affecting_home"],
            ),
            "max_distance_miles": tornado.get(
                "max_distance_miles",
                DEFAULT_CONFIG["tornado_monitoring"]["max_distance_miles"],
            ),
        }

    if "earthquake_monitoring" not in raw:
        earthquakes = raw.get("earthquakes") or {}
        merged["earthquake_monitoring"] = {
            **DEFAULT_CONFIG["earthquake_monitoring"],
            **earthquakes,
        }

    if "lightning_monitoring" not in raw:
        lightning = raw.get("lightning") or {}
        merged["lightning_monitoring"] = {
            **DEFAULT_CONFIG["lightning_monitoring"],
            **lightning,
        }
