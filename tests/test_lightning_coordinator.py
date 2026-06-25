"""Unit tests for lightning coordinator enable/disable behavior."""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

from custom_components.home_weather.lightning_coordinator import LightningCoordinator
from custom_components.home_weather.lightning_data import empty_lightning_payload, get_lightning_config


def test_get_lightning_config_prefers_monitoring_block():
    config = {
        "lightning": {"geofield_radius_miles": 50},
        "lightning_monitoring": {"enabled": False, "geofield_radius_miles": 120},
    }
    merged = get_lightning_config(config)
    assert merged["enabled"] is False
    assert merged["geofield_radius_miles"] == 120


def test_lightning_coordinator_returns_disabled_when_monitoring_off():
    async def run() -> None:
        hass = MagicMock()
        hass.async_create_task = MagicMock()

        storage = MagicMock()
        storage.async_get = AsyncMock(
            return_value={"lightning_monitoring": {"enabled": False}}
        )

        coordinator = LightningCoordinator(hass, storage)
        coordinator._listener.start = MagicMock()
        coordinator._listener.async_stop = AsyncMock()

        with patch.object(
            LightningCoordinator,
            "_sync_listener",
            new=AsyncMock(),
        ) as sync_listener:
            result = await coordinator._async_update_data()

        sync_listener.assert_awaited_once_with(False)
        assert result["feed_status"] == "disabled"
        assert result["geofield_count"] == 0

    asyncio.run(run())


def test_empty_lightning_payload_disabled_status():
    payload = empty_lightning_payload(feed_status="disabled")
    assert payload["feed_status"] == "disabled"
    assert payload["strikes_last_hour"] == 0
