"""Helpers for sensor-scope selection (zone vs bypass / all data)."""
from __future__ import annotations

from typing import Any


def is_sensor_bypass(
    config: dict[str, Any] | None,
    *,
    zone_mode_key: str = "zone_mode",
) -> bool:
    """Return True when sensor scope bypasses the geofield."""
    if not config:
        return False
    return str(config.get(zone_mode_key, "zone")).lower() == "all"


def pick_nearest_by_distance(
    records: list[dict[str, Any]],
    *,
    distance_key: str = "distance_miles",
) -> dict[str, Any] | None:
    """Return the record with the smallest distance value."""
    if not records:
        return None
    return min(
        records,
        key=lambda item: (
            item.get(distance_key)
            if item.get(distance_key) is not None
            else float("inf")
        ),
    )
