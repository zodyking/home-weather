"""Air quality coordinator for Home Weather."""
from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .const import DOMAIN, UPDATE_INTERVAL
from .storage import HomeWeatherStorage
from .air_quality_data import async_fetch_air_quality, detect_air_quality_events

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
        self._tracked_events: dict[str, dict[str, Any]] = {}
        self._last_good_payload: dict[str, Any] | None = None

    async def _async_update_data(self) -> dict[str, Any]:
        try:
            config = await self.storage.async_get()
            payload = await async_fetch_air_quality(self.hass, config)
            await self._fire_change_events(payload.get("alert_events") or [])
            self._last_good_payload = payload
            return payload
        except Exception as err:
            _LOGGER.error("Error updating air quality data: %s", err)
            if self._last_good_payload is not None:
                _LOGGER.warning("Using cached air quality data due to fetch failure")
                return self._last_good_payload
            raise UpdateFailed(f"Error updating air quality data: {err}") from err

    async def _fire_change_events(self, events: list[dict[str, Any]]) -> None:
        """Fire HA bus events when unhealthy air is detected, updated, or cleared."""
        bus_events = detect_air_quality_events(self._tracked_events, events)
        current_by_id = {str(e["id"]): e for e in events if e.get("id")}

        for event_type, event_data in bus_events:
            self.hass.bus.async_fire(event_type, event_data)
            _LOGGER.info(
                "Fired %s for air quality %s", event_type, event_data.get("name")
            )

        self._tracked_events = dict(current_by_id)
