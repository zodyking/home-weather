"""Remove legacy Home Weather entities superseded by geofield hazard devices."""
from __future__ import annotations

import logging

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr, entity_registry as er

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

# Pre-redesign entities (unique_id = f"{DOMAIN}_…", fixed entity_id).
LEGACY_UNIQUE_IDS: tuple[str, ...] = (
    f"{DOMAIN}_tornado_alert",
    f"{DOMAIN}_tornado_polygon",
    f"{DOMAIN}_tornado_distance",
    f"{DOMAIN}_tornado_warning",
    f"{DOMAIN}_nearest_earthquake",
    f"{DOMAIN}_earthquake_magnitude",
    f"{DOMAIN}_earthquake_distance",
    f"{DOMAIN}_earthquake_depth",
    f"{DOMAIN}_earthquake_geojson",
    f"{DOMAIN}_earthquake_nearby",
)

LEGACY_ENTITY_IDS: tuple[str, ...] = (
    "sensor.home_weather_tornado_alert",
    "sensor.home_weather_tornado_polygon",
    "sensor.home_weather_tornado_distance",
    "binary_sensor.home_weather_tornado_warning",
    "sensor.home_weather_nearest_earthquake",
    "sensor.home_weather_earthquake_magnitude",
    "sensor.home_weather_earthquake_distance",
    "sensor.home_weather_earthquake_depth",
    "sensor.home_weather_earthquake_geojson",
    "binary_sensor.home_weather_earthquake_nearby",
)


async def async_remove_legacy_entities(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Delete orphaned legacy entities and the old monolithic device."""
    entity_registry = er.async_get(hass)
    removed: list[str] = []

    superseded_space_suffixes = (
        "_space_tracked_bodies",
        "_space_moons_tracked",
        "_space_spacecraft_tracked",
        "_space_neos_tracked",
        "_space_comets_tracked",
        "_space_closest_neo_name",
    )
    for entity in er.async_entries_for_config_entry(entity_registry, entry.entry_id):
        if entity.platform != DOMAIN:
            continue
        uid = entity.unique_id or ""
        if any(uid.endswith(suffix) for suffix in superseded_space_suffixes):
            entity_registry.async_remove(entity.entity_id)
            removed.append(entity.entity_id)

    for unique_id in LEGACY_UNIQUE_IDS:
        entity_id = entity_registry.async_get_entity_id(
            "sensor", DOMAIN, unique_id
        ) or entity_registry.async_get_entity_id(
            "binary_sensor", DOMAIN, unique_id
        )
        if entity_id:
            entity_registry.async_remove(entity_id)
            removed.append(entity_id)

    for entity_id in LEGACY_ENTITY_IDS:
        entry_row = entity_registry.async_get(entity_id)
        if entry_row and entry_row.platform == DOMAIN:
            entity_registry.async_remove(entity_id)
            if entity_id not in removed:
                removed.append(entity_id)

    if removed:
        _LOGGER.info(
            "Removed %d legacy Home Weather entities: %s",
            len(removed),
            ", ".join(sorted(removed)),
        )

    device_registry = dr.async_get(hass)
    legacy_device = device_registry.async_get_device(
        identifiers={(DOMAIN, entry.entry_id)}
    )
    if not legacy_device:
        return

    if er.async_entries_for_device(entity_registry, legacy_device.id):
        return

    device_registry.async_remove_device(legacy_device.id)
    _LOGGER.info("Removed legacy Home Weather device %s", legacy_device.name)
