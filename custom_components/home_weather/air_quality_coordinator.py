"""Air quality coordinator for Home Weather."""
from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .const import DOMAIN, UPDATE_INTERVAL
from .storage import HomeWeatherStorage
from .air_quality_data import async_fetch_air_quality

_LOGGER = logging.getLogger(__name__)


class AirQualityCoordinator(DataUpdateCoordinator[dict[str, Any]]):
    """Coordinator that polls EPA AirNow reporting-area data."""

    def __init__(
        self,
        hass: HomeAssistant,
        storage: HomeWeatherStorage,
    ) -> None:
        super().__init__(
            hass,
            _LOGGER,
            name=f"{DOMAIN}_air_quality",
            update_interval=timedelta(seconds=UPDATE_INTERVAL),
        )
        self.storage = storage

    async def _async_update_data(self) -> dict[str, Any]:
        try:
            config = await self.storage.async_get()
            return await async_fetch_air_quality(self.hass, config)
        except Exception as err:
            _LOGGER.error("Error updating air quality data: %s", err)
            raise UpdateFailed(f"Error updating air quality data: {err}") from err
