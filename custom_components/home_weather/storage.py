"""Storage handler for Home Weather configuration."""
from __future__ import annotations

import logging
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store

from .const import DEFAULT_CONFIG, DOMAIN, STORAGE_KEY, STORAGE_VERSION

_LOGGER = logging.getLogger(__name__)


class HomeWeatherStorage:
    """Handle storage of Home Weather configuration."""

    def __init__(self, hass: HomeAssistant) -> None:
        """Initialize storage."""
        self.hass = hass
        self._store = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self._data: dict[str, Any] = {}

    async def async_load(self) -> dict[str, Any]:
        """Load configuration from storage."""
        try:
            data = await self._store.async_load()
            if data:
                self._data = data
                # Merge with defaults to ensure all keys exist
                config = {**DEFAULT_CONFIG, **self._data}
                return config
            else:
                # No stored data, return defaults
                self._data = DEFAULT_CONFIG.copy()
                return self._data
        except Exception as e:
            _LOGGER.error("Error loading configuration: %s", e)
            self._data = DEFAULT_CONFIG.copy()
            return self._data

    async def async_save(self, data: dict[str, Any]) -> None:
        """Save configuration to storage."""
        try:
            # Validate required fields
            if not data.get("weather_entity"):
                raise ValueError("weather_entity is required")
            if not data.get("tts_engine"):
                raise ValueError("tts_engine is required")
            if not data.get("media_players") or len(data.get("media_players", [])) == 0:
                raise ValueError("At least one media_player is required")

            self._data = data
            await self._store.async_save(self._data)
            _LOGGER.info("Configuration saved successfully")
        except Exception as e:
            _LOGGER.error("Error saving configuration: %s", e)
            raise

    async def async_get(self) -> dict[str, Any]:
        """Get current configuration."""
        if not self._data:
            await self.async_load()
        return self._data.copy()

    async def async_delete(self) -> None:
        """Delete stored configuration."""
        try:
            self._data = DEFAULT_CONFIG.copy()
            await self._store.async_remove()
            _LOGGER.info("Configuration deleted")
        except Exception as e:
            _LOGGER.error("Error deleting configuration: %s", e)
            raise

    def is_configured(self) -> bool:
        """Check if integration is configured."""
        return (
            self._data.get("weather_entity") is not None
            and self._data.get("tts_engine") is not None
            and len(self._data.get("media_players", [])) > 0
        )
