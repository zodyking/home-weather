"""Wildfire coordinator for Home Weather."""
from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .const import DOMAIN, UPDATE_INTERVAL
from .storage import HomeWeatherStorage
from .wildfire_data import async_fetch_wildfires

_LOGGER = logging.getLogger(__name__)


class WildfireCoordinator(DataUpdateCoordinator[dict[str, Any]]):
    """Coordinator that polls NIFC WFIGS for active wildfires."""

    def __init__(
        self,
        hass: HomeAssistant,
        storage: HomeWeatherStorage,
    ) -> None:
        super().__init__(
            hass,
            _LOGGER,
            name=f"{DOMAIN}_wildfire",
            update_interval=timedelta(seconds=UPDATE_INTERVAL),
        )
        self.storage = storage

    async def _async_update_data(self) -> dict[str, Any]:
        try:
            config = await self.storage.async_get()
            return await async_fetch_wildfires(self.hass, config)
        except Exception as err:
            _LOGGER.error("Error updating wildfire data: %s", err)
            raise UpdateFailed(f"Error updating wildfire data: {err}") from err
