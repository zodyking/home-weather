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
    _migrate_alert_thresholds_into_monitoring(merged, data)
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


def _migrate_alert_thresholds_into_monitoring(
    merged: dict[str, Any], raw: dict[str, Any]
) -> None:
    """Move per-hazard thresholds from the alert blocks into monitoring blocks.

    Thresholds (min magnitude, min threat level, min activity level, outlook
    probability) now live solely in the monitoring blocks (Alert Zones tab).
    For existing installs, seed each monitoring value from the legacy alert
    block when the monitoring block does not already define it, so users keep
    their customizations. ``alert_zone_mode`` defaults to the sensor
    ``zone_mode`` so upgrade behavior is unchanged.
    """

    def _seed(block_key: str, alert_key: str, field: str) -> None:
        block = merged.get(block_key)
        if not isinstance(block, dict):
            return
        raw_block = raw.get(block_key) if isinstance(raw.get(block_key), dict) else {}
        # Respect an explicitly stored monitoring value; otherwise adopt the
        # legacy alert value when present.
        if field in raw_block:
            return
        alert_block = raw.get(alert_key) or {}
        if field in alert_block:
            block[field] = alert_block[field]

    def _default_alert_mode(block_key: str) -> None:
        block = merged.get(block_key)
        if not isinstance(block, dict):
            return
        raw_block = raw.get(block_key) if isinstance(raw.get(block_key), dict) else {}
        if "alert_zone_mode" not in raw_block:
            block["alert_zone_mode"] = raw_block.get("zone_mode", block.get("zone_mode", "zone"))

    _seed("hurricane_monitoring", "tropical_alerts", "min_threat_level")
    _seed("hurricane_monitoring", "tropical_alerts", "outlook_min_probability")
    _seed("earthquake_monitoring", "earthquake_alerts", "min_magnitude")
    _seed("volcano_monitoring", "volcano_alerts", "min_alert_level")

    for block_key in (
        "hurricane_monitoring",
        "tornado_monitoring",
        "earthquake_monitoring",
        "volcano_monitoring",
        "wildfire_monitoring",
        "air_quality_monitoring",
    ):
        _default_alert_mode(block_key)
