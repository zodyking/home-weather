"""Tests for legacy entity registry cleanup."""
from __future__ import annotations

import asyncio
from unittest.mock import MagicMock, patch

from custom_components.home_weather.const import DOMAIN
from custom_components.home_weather.entity_cleanup import (
    LEGACY_ENTITY_IDS,
    LEGACY_UNIQUE_IDS,
    async_remove_legacy_entities,
)


def test_remove_legacy_entities_by_unique_id():
    hass = MagicMock()
    entry = MagicMock()
    entry.entry_id = "abc123"

    registry = MagicMock()
    registry.async_get_entity_id.side_effect = lambda platform, domain, uid: (
        "sensor.home_weather_tornado_alert"
        if uid == f"{DOMAIN}_tornado_alert" and platform == "sensor"
        else None
    )
    registry.async_get.return_value = None
    registry.async_entries_for_device.return_value = []

    device_registry = MagicMock()
    device_registry.async_get_device.return_value = None

    with patch(
        "custom_components.home_weather.entity_cleanup.er.async_get",
        return_value=registry,
    ), patch(
        "custom_components.home_weather.entity_cleanup.dr.async_get",
        return_value=device_registry,
    ):
        async def run():
            await async_remove_legacy_entities(hass, entry)

        asyncio.run(run())

    registry.async_remove.assert_called_with("sensor.home_weather_tornado_alert")


def test_legacy_id_lists_cover_screenshot_entities():
    """Ensure all pre-redesign entity IDs from the old sensor platform are listed."""
    expected = {
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
    }
    assert expected == set(LEGACY_ENTITY_IDS)
    assert len(LEGACY_UNIQUE_IDS) == len(LEGACY_ENTITY_IDS)
