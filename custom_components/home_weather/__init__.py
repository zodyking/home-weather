"""Home Weather Integration."""
from __future__ import annotations

import logging

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.typing import ConfigType

from .const import DOMAIN, PANEL_ICON, PANEL_TITLE, PANEL_URL_PATH

_LOGGER = logging.getLogger(__name__)


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Set up the Home Weather integration."""
    hass.data.setdefault(DOMAIN, {})
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Home Weather from a config entry."""
    from .storage import HomeWeatherStorage
    from .coordinator import WeatherCoordinator
    from .automation import HomeWeatherAutomation
    from .services import async_setup_websocket_api

    # Initialize storage
    storage = HomeWeatherStorage(hass)
    await storage.async_load()
    
    # Initialize coordinator
    coordinator = WeatherCoordinator(hass, storage)
    await coordinator.async_request_refresh()
    
    # Initialize automation
    automation = HomeWeatherAutomation(hass, storage, coordinator)
    await automation.async_start()
    
    # Store in hass.data
    hass.data.setdefault(DOMAIN, {})
    hass.data[DOMAIN][entry.entry_id] = {
        "storage": storage,
        "coordinator": coordinator,
        "automation": automation,
    }
    
    # Set up WebSocket API
    async_setup_websocket_api(hass)
    
    # Register the panel
    await _register_panel(hass)
    
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    if entry.entry_id in hass.data.get(DOMAIN, {}):
        data = hass.data[DOMAIN][entry.entry_id]
        if "automation" in data:
            await data["automation"].async_stop()
        del hass.data[DOMAIN][entry.entry_id]
    return True


async def _register_panel(hass: HomeAssistant) -> None:
    """Register the custom panel with Home Assistant (same pattern as Home Energy)."""
    try:
        import os
        from homeassistant.components.http import StaticPathConfig

        www_path = os.path.join(os.path.dirname(__file__), "www")
        panel_url = f"/local/home_weather"

        # Register static path for www files (same as Home Energy)
        await hass.http.async_register_static_paths([
            StaticPathConfig(panel_url, www_path, cache_headers=False)
        ])
        _LOGGER.info("Registered static path for panel files at %s", panel_url)

        # Register panel using panel_custom (same API as Home Energy)
        from homeassistant.components import panel_custom

        await panel_custom.async_register_panel(
            hass,
            webcomponent_name="home-weather-panel",
            frontend_url_path=PANEL_URL_PATH,
            sidebar_title=PANEL_TITLE,
            sidebar_icon=PANEL_ICON,
            module_url=f"{panel_url}/weather-panel.js",
            embed_iframe=False,
            require_admin=False,
        )
        _LOGGER.info("Registered Home Weather panel at /%s", PANEL_URL_PATH)

    except Exception as e:
        _LOGGER.error("Failed to register panel: %s", e)
