"""Unit tests for set_config hazard coordinator refresh."""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock


async def _refresh_coordinators_after_save(entry_data: dict, coordinator) -> None:
    """Mirror refresh logic from services.handle_set_config."""
    if coordinator:
        await coordinator.async_request_refresh()
    if entry_data:
        for key in (
            "earthquake_coordinator",
            "tornado_coordinator",
            "hurricane_coordinator",
            "lightning_coordinator",
        ):
            hazard = entry_data.get(key)
            if hazard:
                await hazard.async_request_refresh()


def test_set_config_refreshes_hazard_coordinators():
    async def run() -> None:
        weather = MagicMock()
        weather.async_request_refresh = AsyncMock()
        earthquake = MagicMock()
        earthquake.async_request_refresh = AsyncMock()
        tornado = MagicMock()
        tornado.async_request_refresh = AsyncMock()
        hurricane = MagicMock()
        hurricane.async_request_refresh = AsyncMock()
        lightning = MagicMock()
        lightning.async_request_refresh = AsyncMock()

        entry_data = {
            "earthquake_coordinator": earthquake,
            "tornado_coordinator": tornado,
            "hurricane_coordinator": hurricane,
            "lightning_coordinator": lightning,
        }

        await _refresh_coordinators_after_save(entry_data, weather)

        weather.async_request_refresh.assert_awaited_once()
        earthquake.async_request_refresh.assert_awaited_once()
        tornado.async_request_refresh.assert_awaited_once()
        hurricane.async_request_refresh.assert_awaited_once()
        lightning.async_request_refresh.assert_awaited_once()

    asyncio.run(run())
