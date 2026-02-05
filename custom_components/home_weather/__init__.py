"""Home Weather Integration."""
from __future__ import annotations

import logging
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.typing import ConfigType

from .const import DOMAIN, PANEL_ICON, PANEL_TITLE, PANEL_URL_PATH
from .coordinator import WeatherCoordinator
from .storage import HomeWeatherStorage
from .automation import HomeWeatherAutomation
from .services import async_setup_websocket_api

_LOGGER = logging.getLogger(__name__)

PLATFORMS: list[Platform] = []


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Set up the Home Weather integration."""
    hass.data.setdefault(DOMAIN, {})
    
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
    hass.data[DOMAIN] = {
        "storage": storage,
        "coordinator": coordinator,
        "automation": automation,
    }
    
    # Set up WebSocket API
    async_setup_websocket_api(hass)
    
    # Register the panel
    await _register_panel(hass)
    
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Home Weather from a config entry."""
    # This integration doesn't use config entries, but we keep this for compatibility
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    return True


async def _register_panel(hass: HomeAssistant) -> None:
    """Register the custom panel with Home Assistant."""
    try:
        import os
        www_path = os.path.join(os.path.dirname(__file__), "www")
        
        # Register static path for www files
        if os.path.exists(www_path):
            hass.http.register_static_path(
                f"/local/home_weather",
                www_path,
                cache_headers=False,
            )
            _LOGGER.info("Registered static path for panel files at /local/home_weather")
        
        # Register panel programmatically using frontend API
        try:
            # Try to register via frontend component
            if hasattr(hass.components, "frontend"):
                # Register custom panel
                hass.components.frontend.async_register_built_in_panel(
                    component_name="custom",
                    sidebar_title=PANEL_TITLE,
                    sidebar_icon=PANEL_ICON,
                    frontend_url_path=PANEL_URL_PATH,
                    config={
                        "name": "home-weather-panel",
                        "module_url": f"/local/home_weather/weather-panel.js",
                        "embed_iframe": False,
                        "trust_external": False,
                    },
                    require_admin=False,
                )
                _LOGGER.info("Registered Home Weather panel at /%s", PANEL_URL_PATH)
            else:
                # Fallback: use panel_custom via YAML (user will need to add this)
                _LOGGER.info(
                    "Frontend component not available. Add to configuration.yaml:\n"
                    "panel_custom:\n"
                    f"  - name: {PANEL_URL_PATH}\n"
                    f"    sidebar_title: {PANEL_TITLE}\n"
                    f"    sidebar_icon: {PANEL_ICON}\n"
                    f"    url_path: {PANEL_URL_PATH}\n"
                    f"    module_url: /local/home_weather/weather-panel.js\n"
                    "    embed_iframe: false"
                )
        except AttributeError:
            # Alternative registration method
            _LOGGER.warning(
                "Could not register panel automatically. "
                "Please add panel_custom entry to configuration.yaml"
            )
        
    except Exception as e:
        _LOGGER.error("Failed to register panel: %s", e)
