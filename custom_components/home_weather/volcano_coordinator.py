"""Volcano data coordinator for Home Weather."""
from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .const import DOMAIN, UPDATE_INTERVAL
from .storage import HomeWeatherStorage
from .volcano_data import async_fetch_volcanoes, detect_volcano_events

_LOGGER = logging.getLogger(__name__)


class VolcanoCoordinator(DataUpdateCoordinator[dict[str, Any]]):
    """Coordinator that polls GVP/GDACS/USGS for worldwide volcano activity.

    The GVP catalog is cached in ``_catalog_cache`` with a 24 h TTL (managed by
    ``async_fetch_volcanoes``) so only the live activity feeds are hit each cycle.
    """

    def __init__(
        self,
        hass: HomeAssistant,
        storage: HomeWeatherStorage,
    ) -> None:
        super().__init__(
            hass,
            _LOGGER,
            name=f"{DOMAIN}_volcano",
            update_interval=timedelta(seconds=UPDATE_INTERVAL),
        )
        self.storage = storage
        self._tracked_events: dict[str, dict[str, Any]] = {}
        self._catalog_cache: dict[str, Any] = {}

    async def _async_update_data(self) -> dict[str, Any]:
        try:
            config = await self.storage.async_get()
            payload = await async_fetch_volcanoes(
                self.hass, config, catalog_cache=self._catalog_cache
            )
            await self._fire_change_events(payload.get("alert_events") or [])
            return payload
        except Exception as err:
            _LOGGER.error("Error updating volcano data: %s", err)
            raise UpdateFailed(f"Error updating volcano data: {err}") from err

    async def _fire_change_events(self, events: list[dict[str, Any]]) -> None:
        """Fire HA bus events when volcano activity is detected, updated, or cleared."""
        bus_events = detect_volcano_events(self._tracked_events, events)
        current_by_id = {str(e["id"]): e for e in events if e.get("id")}

        for event_type, event_data in bus_events:
            self.hass.bus.async_fire(event_type, event_data)
            _LOGGER.info("Fired %s for volcano %s", event_type, event_data.get("name"))

        self._tracked_events = dict(current_by_id)
