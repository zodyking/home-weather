"""Tornado warning data coordinator for Home Weather."""
from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .const import DOMAIN, UPDATE_INTERVAL
from .storage import HomeWeatherStorage
from .tornado_data import (
    async_fetch_tornado_alerts,
    detect_tornado_events,
)

_LOGGER = logging.getLogger(__name__)


class TornadoCoordinator(DataUpdateCoordinator[dict[str, Any]]):
    """Coordinator that polls NWS for active tornado warnings."""

    def __init__(
        self,
        hass: HomeAssistant,
        storage: HomeWeatherStorage,
    ) -> None:
        super().__init__(
            hass,
            _LOGGER,
            name=f"{DOMAIN}_tornado",
            update_interval=timedelta(seconds=UPDATE_INTERVAL),
        )
        self.storage = storage
        self._tracked_alerts: dict[str, dict[str, Any]] = {}

    async def _async_update_data(self) -> dict[str, Any]:
        try:
            config = await self.storage.async_get()
            payload = await async_fetch_tornado_alerts(self.hass, config)
            await self._fire_change_events(payload.get("alert_alerts") or [])
            return payload
        except Exception as err:
            _LOGGER.error("Error updating tornado data: %s", err)
            raise UpdateFailed(f"Error updating tornado data: {err}") from err

    async def _fire_change_events(self, alerts: list[dict[str, Any]]) -> None:
        """Fire HA bus events when alerts are issued, updated, or cleared."""
        events = detect_tornado_events(self._tracked_alerts, alerts)
        current_by_id = {a["alert_id"]: a for a in alerts if a.get("alert_id")}

        for event_type, event_data in events:
            self.hass.bus.async_fire(event_type, event_data)
            _LOGGER.info("Fired %s for alert %s", event_type, event_data.get("alert_id"))

        self._tracked_alerts = dict(current_by_id)
