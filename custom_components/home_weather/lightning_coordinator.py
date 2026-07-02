"""Lightning strike coordinator for Home Weather sensors."""
from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator

from homeassistant.util import dt as dt_util

from .const import DOMAIN
from .hurricane_data import get_home_coordinates
from .lightning_data import (
    BlitzortungListener,
    LightningHourlyCounter,
    LightningStrikeBuffer,
    build_lightning_payload,
    empty_lightning_payload,
    get_lightning_config,
    strike_in_monitoring_zone,
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
        self._hourly_counter = LightningHourlyCounter()
        self._cached_home: dict[str, float] | None = None
        self._cached_config: dict[str, Any] | None = None
        self._hourly_seeded = False
        self._listener = BlitzortungListener(
            hass,
            self._buffer,
            on_strike=self._on_strike,
            on_status=self._on_listener_status,
        )
        self._listener_started = False
        self._feed_status = "off"

    def _on_listener_status(self, status: str) -> None:
        self._feed_status = status
        self.hass.async_create_task(self.async_request_refresh())

    def _on_strike(self, strike: dict[str, Any]) -> None:
        home = self._cached_home
        config = self._cached_config
        if home and strike_in_monitoring_zone(strike, home, config):
            self.hass.async_create_task(self._hourly_counter.record(strike["time_ms"]))
        self.hass.async_create_task(self.async_request_refresh())

    async def _sync_listener(self, enabled: bool) -> None:
        if enabled and not self._listener_started:
            self._listener.start()
            self._listener_started = True
            self._feed_status = "connecting"
        elif not enabled and self._listener_started:
            await self._listener.async_stop()
            self._listener_started = False
            self._feed_status = "disabled"

    async def async_config_entry_first_refresh(self) -> None:
        config = await self.storage.async_get()
        lightning_config = get_lightning_config(config)
        await self._sync_listener(lightning_config.get("enabled", True))
        await super().async_config_entry_first_refresh()

    async def async_shutdown(self) -> None:
        await self._listener.async_stop()
        self._listener_started = False

    async def _async_update_data(self) -> dict[str, Any]:
        try:
            config = await self.storage.async_get()
            lightning_config = get_lightning_config(config)
            enabled = lightning_config.get("enabled", True)
            await self._sync_listener(enabled)
            if not enabled:
                return empty_lightning_payload(feed_status="disabled")

            self._buffer.set_max_strikes(int(lightning_config.get("max_strikes", 500)))
            home = get_home_coordinates(self.hass, config)
            self._cached_home = home
            self._cached_config = config
            strikes = await self._buffer.get_strikes()
            if not self._hourly_seeded and strikes:
                one_hour_ms = int(dt_util.utcnow().timestamp() * 1000) - 3600 * 1000
                for strike in strikes:
                    time_ms = strike.get("time_ms") or 0
                    if time_ms >= one_hour_ms and strike_in_monitoring_zone(strike, home, config):
                        await self._hourly_counter.record(time_ms)
                self._hourly_seeded = True
            hourly_count = await self._hourly_counter.count()
            payload = build_lightning_payload(
                strikes,
                home,
                config,
                strikes_last_hour=hourly_count,
            )
            if self._feed_status in ("connecting", "reconnecting", "error"):
                payload["feed_status"] = self._feed_status
            elif payload.get("feed_status") == "live" and self._listener_started:
                payload["feed_status"] = "live"
            return payload
        except Exception as err:
            _LOGGER.warning("Error updating lightning data: %s", err)
            return empty_lightning_payload(feed_status="error")
