"""Earthquake data coordinator for Home Weather."""
from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .const import DOMAIN, UPDATE_INTERVAL
from .earthquake_data import async_fetch_earthquakes, detect_earthquake_events
from .storage import HomeWeatherStorage

_LOGGER = logging.getLogger(__name__)


class EarthquakeCoordinator(DataUpdateCoordinator[dict[str, Any]]):
    """Coordinator that polls USGS for nearby earthquakes."""

    def __init__(
        self,
        hass: HomeAssistant,
        storage: HomeWeatherStorage,
    ) -> None:
        super().__init__(
            hass,
            _LOGGER,
            name=f"{DOMAIN}_earthquake",
            update_interval=timedelta(seconds=UPDATE_INTERVAL),
        )
        self.storage = storage
        self._tracked_events: dict[str, dict[str, Any]] = {}

    async def _async_update_data(self) -> dict[str, Any]:
        try:
            config = await self.storage.async_get()
            payload = await async_fetch_earthquakes(self.hass, config)
            await self._fire_change_events(payload.get("events") or [])
            return payload
        except Exception as err:
            _LOGGER.error("Error updating earthquake data: %s", err)
            raise UpdateFailed(f"Error updating earthquake data: {err}") from err

    async def _fire_change_events(self, events: list[dict[str, Any]]) -> None:
        """Fire HA bus events when earthquakes are detected, updated, or cleared."""
        bus_events = detect_earthquake_events(self._tracked_events, events)
        current_by_id = {e["id"]: e for e in events if e.get("id")}

        for event_type, event_data in bus_events:
            self.hass.bus.async_fire(event_type, event_data)
            _LOGGER.info("Fired %s for earthquake %s", event_type, event_data.get("id"))

        self._tracked_events = dict(current_by_id)
