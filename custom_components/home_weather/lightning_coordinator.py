"""Lightning strike coordinator for Home Weather sensors."""
from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator

from .const import DOMAIN, UPDATE_INTERVAL
from .hurricane_data import get_home_coordinates
from .lightning_data import (
    BlitzortungListener,
    LightningStrikeBuffer,
    build_lightning_payload,
    empty_lightning_payload,
    get_lightning_config,
)
from .storage import HomeWeatherStorage

_LOGGER = logging.getLogger(__name__)


class LightningCoordinator(DataUpdateCoordinator[dict[str, Any]]):
    """Coordinator that tracks live Blitzortung strikes within the geofield."""

    def __init__(
        self,
        hass: HomeAssistant,
        storage: HomeWeatherStorage,
    ) -> None:
        super().__init__(
            hass,
            _LOGGER,
            name=f"{DOMAIN}_lightning",
            update_interval=timedelta(seconds=60),
        )
        self.storage = storage
        self._buffer = LightningStrikeBuffer(max_strikes=500)
        self._listener = BlitzortungListener(
            hass,
            self._buffer,
            on_strike=lambda: hass.async_create_task(self.async_request_refresh()),
        )
        self._listener_started = False

    async def async_config_entry_first_refresh(self) -> None:
        if not self._listener_started:
            self._listener.start()
            self._listener_started = True
        await super().async_config_entry_first_refresh()

    async def async_shutdown(self) -> None:
        await self._listener.async_stop()

    async def _async_update_data(self) -> dict[str, Any]:
        try:
            config = await self.storage.async_get()
            lightning_config = get_lightning_config(config)
            self._buffer.set_max_strikes(int(lightning_config.get("max_strikes", 500)))
            home = get_home_coordinates(self.hass, config)
            strikes = await self._buffer.get_strikes()
            return build_lightning_payload(strikes, home, config)
        except Exception as err:
            _LOGGER.warning("Error updating lightning data: %s", err)
            return empty_lightning_payload()
