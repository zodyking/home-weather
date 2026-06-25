"""Hurricane data coordinator for Home Weather sensors."""
from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .const import DOMAIN, UPDATE_INTERVAL
from .hurricane_data import async_get_hurricane_data, build_hurricane_sensor_payload
from .storage import HomeWeatherStorage

_LOGGER = logging.getLogger(__name__)


class HurricaneCoordinator(DataUpdateCoordinator[dict[str, Any]]):
    """Coordinator that polls NOAA/NHC for hurricane data."""

    def __init__(
        self,
        hass: HomeAssistant,
        storage: HomeWeatherStorage,
    ) -> None:
        super().__init__(
            hass,
            _LOGGER,
            name=f"{DOMAIN}_hurricane",
            update_interval=timedelta(seconds=UPDATE_INTERVAL),
        )
        self.storage = storage

    async def _async_update_data(self) -> dict[str, Any]:
        try:
            config = await self.storage.async_get()
            raw = await async_get_hurricane_data(self.hass, config)
            return build_hurricane_sensor_payload(raw, config)
        except Exception as err:
            _LOGGER.error("Error updating hurricane data: %s", err)
            raise UpdateFailed(f"Error updating hurricane data: {err}") from err
