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
    _migrate_announcement_players(merged, data)
    _migrate_media_player_cache(merged, data)
    _migrate_iss_horizons_id(merged)
    return merged


# Old (invalid) ISS Horizons ID that returns "No such record", so no overhead
# passes were ever detected. Replace with the valid spacecraft ID.
_OLD_ISS_HORIZONS_ID = "-255544"
_NEW_ISS_HORIZONS_ID = "-125544"


def _migrate_iss_horizons_id(merged: dict[str, Any]) -> None:
    """Repair the ISS Horizons craft ID stored by older versions.

    The default ISS ID was ``-255544``, which is not a valid JPL Horizons
    record, so the observer ephemeris (and therefore every overhead pass) came
    back empty. Rewrite any stored occurrence to the correct ``-125544``.
    """
    alerts = merged.get("spacecraft_alerts")
    if not isinstance(alerts, dict):
        return
    craft_ids = alerts.get("craft_ids")
    if not isinstance(craft_ids, list):
        return
    alerts["craft_ids"] = [
        _NEW_ISS_HORIZONS_ID if str(cid) == _OLD_ISS_HORIZONS_ID else cid
        for cid in craft_ids
    ]


# Sentinel key marking that the one-time media-player cache correction ran.
_CACHE_MIGRATION_FLAG = "_media_player_cache_default_migrated"


def _migrate_media_player_cache(merged: dict[str, Any], raw: dict[str, Any]) -> None:
    """One-time flip of media-player ``cache`` from the old ``false`` default.

    Older versions defaulted every media player to ``cache: false``. For
    AirPlay/Apple TV/HomePod targets (pyatv) that causes the TTS proxy audio to
    be generated lazily during a fetch with a hardcoded 10s timeout, so
    announcements fail with "Connection ... timed out". Caching pre-generates
    the file so playback is reliable.

    This runs exactly once (gated by ``_CACHE_MIGRATION_FLAG``) so a user who
    later deliberately disables caching keeps that choice.
    """
    if raw.get(_CACHE_MIGRATION_FLAG):
        merged[_CACHE_MIGRATION_FLAG] = True
        return

    media_players = merged.get("media_players")
    if isinstance(media_players, list):
        for mp in media_players:
            if isinstance(mp, dict) and mp.get("cache") is not True:
                mp["cache"] = True

    merged[_CACHE_MIGRATION_FLAG] = True


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


# All announcement type IDs for per-speaker volume/bypass settings
_HAZARD_ALERT_TYPES = (
    "nws_alerts",
    "tropical_alerts",
    "tornado_alerts",
    "earthquake_alerts",
    "volcano_alerts",
    "wildfire_alerts",
    "air_quality_alerts",
    "travel_alerts",
    "spacecraft_alerts",
    "solar_weather_alerts",
    "neo_alerts",
)
_WEATHER_ALERT_TYPES = (
    "current_change",
    "upcoming_change",
    "scheduled_forecast",
    "sun_alerts",
)


def _migrate_announcement_players(
    merged: dict[str, Any], raw: dict[str, Any]
) -> None:
    """Seed announcement_players from legacy per-type volumes for existing installs.

    When upgrading from a config without announcement_players, set each player's
    volume per alert type from the legacy tts_volume (hazards) or the player's
    default volume (weather types), with bypass=false so behavior is unchanged.
    """
    raw_ap = raw.get("announcement_players")
    # Only seed if announcement_players was absent or empty in stored config
    if raw_ap and isinstance(raw_ap, dict) and any(raw_ap.values()):
        return

    media_players = merged.get("media_players") or []
    if not media_players:
        return

    announcement_players: dict[str, dict[str, dict[str, Any]]] = {}

    # Hazard alert types: use the legacy tts_volume from each alert block
    for type_id in _HAZARD_ALERT_TYPES:
        alert_block = merged.get(type_id) or {}
        tts_vol = alert_block.get("tts_volume", 0.9)
        type_map: dict[str, dict[str, Any]] = {}
        for mp in media_players:
            entity_id = mp.get("entity_id")
            if entity_id:
                type_map[entity_id] = {"volume": tts_vol, "bypass": False}
        if type_map:
            announcement_players[type_id] = type_map

    # Weather/sun alert types: use each player's own default volume
    for type_id in _WEATHER_ALERT_TYPES:
        type_map = {}
        for mp in media_players:
            entity_id = mp.get("entity_id")
            if entity_id:
                vol = mp.get("volume", 0.6)
                type_map[entity_id] = {"volume": vol, "bypass": False}
        if type_map:
            announcement_players[type_id] = type_map

    merged["announcement_players"] = announcement_players
