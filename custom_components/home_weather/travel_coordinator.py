"""Travel advisory coordinator for Home Weather."""
from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .const import DOMAIN, UPDATE_INTERVAL
from .storage import HomeWeatherStorage
from .travel_advisory_data import async_fetch_travel_advisories, detect_travel_advisory_changes

_LOGGER = logging.getLogger(__name__)


class TravelCoordinator(DataUpdateCoordinator[dict[str, Any]]):
    """Coordinator that polls State Dept travel advisories."""

    def __init__(
        self,
        hass: HomeAssistant,
        storage: HomeWeatherStorage,
    ) -> None:
        super().__init__(
            hass,
            _LOGGER,
            name=f"{DOMAIN}_travel",
            update_interval=timedelta(seconds=UPDATE_INTERVAL),
        )
        self.storage = storage
        self._tracked_advisories: dict[str, dict[str, Any]] = {}
        self._last_good_payload: dict[str, Any] | None = None

    async def _async_update_data(self) -> dict[str, Any]:
        try:
            config = await self.storage.async_get()
            payload = await async_fetch_travel_advisories(self.hass, config)
            await self._fire_change_events(payload.get("advisories") or [], config)
            self._last_good_payload = payload
            return payload
        except Exception as err:
            _LOGGER.error("Error updating travel advisories: %s", err)
            if self._last_good_payload is not None:
                _LOGGER.warning("Using cached travel advisories due to fetch failure")
                return self._last_good_payload
            raise UpdateFailed(f"Error updating travel advisories: {err}") from err

    async def _fire_change_events(
        self,
        advisories: list[dict[str, Any]],
        config: dict[str, Any],
    ) -> None:
        """Fire HA bus events when travel advisories change."""
        from .travel_advisory_data import get_travel_alerts_config

        alerts_config = get_travel_alerts_config(config)
        bootstrap = not getattr(self, "_travel_bootstrapped", False)

        if bootstrap:
            self._tracked_advisories = {
                str(a["id"]): a for a in advisories if a.get("id")
            }
            self._travel_bootstrapped = True
            _LOGGER.debug(
                "Travel advisories bootstrap: seeded %d advisories without announcing",
                len(self._tracked_advisories),
            )
            return

        if not alerts_config.get("enabled"):
            self._tracked_advisories = {
                str(a["id"]): a for a in advisories if a.get("id")
            }
            return

        events = detect_travel_advisory_changes(
            self._tracked_advisories, advisories, alerts_config
        )
        for event_type, advisory in events:
            self.hass.bus.async_fire(event_type, advisory)
            _LOGGER.info(
                "Fired %s for travel advisory %s (level %s)",
                event_type,
                advisory.get("country"),
                advisory.get("level"),
            )

        self._tracked_advisories = {
            str(a["id"]): a for a in advisories if a.get("id")
        }
