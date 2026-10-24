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
    from .ha_services import async_setup_services

    async_setup_services(hass)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Home Weather from a config entry."""
    from .storage import HomeWeatherStorage
    from .coordinator import WeatherCoordinator
    from .services import async_setup_websocket_api
    from .tts_triggers import TTSTriggerManager
    from .tornado_coordinator import TornadoCoordinator
    from .earthquake_coordinator import EarthquakeCoordinator
    from .hurricane_coordinator import HurricaneCoordinator
    from .lightning_coordinator import LightningCoordinator
    from .volcano_coordinator import VolcanoCoordinator
    from .travel_coordinator import TravelCoordinator
    from .wildfire_coordinator import WildfireCoordinator
    from .air_quality_coordinator import AirQualityCoordinator
    from .space_coordinator import SpaceCoordinator

    storage = HomeWeatherStorage(hass)
    await storage.async_load()

    coordinator = WeatherCoordinator(hass, storage)
    tornado_coordinator = TornadoCoordinator(hass, storage)
    earthquake_coordinator = EarthquakeCoordinator(hass, storage)
    hurricane_coordinator = HurricaneCoordinator(hass, storage)
    lightning_coordinator = LightningCoordinator(hass, storage)
    volcano_coordinator = VolcanoCoordinator(hass, storage)
    travel_coordinator = TravelCoordinator(hass, storage)
    wildfire_coordinator = WildfireCoordinator(hass, storage)
    air_quality_coordinator = AirQualityCoordinator(hass, storage)
    space_coordinator = SpaceCoordinator(hass, storage)

    async def _refresh_in_background(label: str, refresh) -> None:
        """Load one feed without holding up config-entry setup."""
        try:
            await refresh()
        except Exception as err:
            _LOGGER.warning(
                "Home Weather %s data is not ready yet and will retry on its "
                "update interval: %s",
                label,
                err,
            )

    def _schedule_refresh(label: str, refresh) -> None:
        task = _refresh_in_background(label, refresh)
        name = f"{DOMAIN} {label} initial refresh"
        creator = getattr(entry, "async_create_background_task", None)
        if creator is not None:
            creator(hass, task, name)
            return
        hass.async_create_task(task, name=name)

    # These feeds hit the network. Awaiting them in series, especially the
    # serial Horizons pass, runs past Home Assistant's bootstrap stage 2
    # timeout and the entry is cancelled before platforms load.
    _schedule_refresh("weather", coordinator.async_request_refresh)
    _schedule_refresh("tornado", tornado_coordinator.async_config_entry_first_refresh)
    _schedule_refresh("earthquake", earthquake_coordinator.async_config_entry_first_refresh)
    _schedule_refresh("hurricane", hurricane_coordinator.async_config_entry_first_refresh)
    _schedule_refresh("lightning", lightning_coordinator.async_config_entry_first_refresh)
    _schedule_refresh("volcano", volcano_coordinator.async_config_entry_first_refresh)
    _schedule_refresh("travel", travel_coordinator.async_config_entry_first_refresh)
    _schedule_refresh("wildfire", wildfire_coordinator.async_config_entry_first_refresh)
    _schedule_refresh("air quality", air_quality_coordinator.async_config_entry_first_refresh)
    _schedule_refresh("space", space_coordinator.async_config_entry_first_refresh)

    # Set up TTS trigger manager
    def get_config():
        return storage._data or {}
    
    def get_weather_data():
        return coordinator.data or {}

    async def refresh_weather_data():
        await coordinator.async_request_refresh()

    trigger_manager = TTSTriggerManager(
        hass,
        get_config,
        get_weather_data,
        refresh_weather_data=refresh_weather_data,
    )

    hass.data.setdefault(DOMAIN, {})
    hass.data[DOMAIN][entry.entry_id] = {
        "storage": storage,
        "coordinator": coordinator,
        "tornado_coordinator": tornado_coordinator,
        "earthquake_coordinator": earthquake_coordinator,
        "hurricane_coordinator": hurricane_coordinator,
        "lightning_coordinator": lightning_coordinator,
        "volcano_coordinator": volcano_coordinator,
        "travel_coordinator": travel_coordinator,
        "wildfire_coordinator": wildfire_coordinator,
        "air_quality_coordinator": air_quality_coordinator,
        "space_coordinator": space_coordinator,
        "trigger_manager": trigger_manager,
    }

    await hass.config_entries.async_forward_entry_setups(entry, ["binary_sensor", "sensor"])

    from .entity_cleanup import async_remove_legacy_entities

    await async_remove_legacy_entities(hass, entry)

    async_setup_websocket_api(hass)
    await _ensure_nws_sounds(hass)
    await _ensure_panel_www_assets(hass)
    await _register_panel(hass)
    
    # Set up TTS triggers after everything else is ready
    try:
        await trigger_manager.async_setup()
    except Exception as e:
        _LOGGER.error("Failed to set up TTS triggers: %s", e)

    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    unload_ok = await hass.config_entries.async_unload_platforms(
        entry, ["binary_sensor", "sensor"]
    )
    if not unload_ok:
        return False

    if entry.entry_id in hass.data.get(DOMAIN, {}):
        entry_data = hass.data[DOMAIN][entry.entry_id]
        
        # Unload TTS triggers
        trigger_manager = entry_data.get("trigger_manager")
        if trigger_manager:
            try:
                await trigger_manager.async_unload()
            except Exception as e:
                _LOGGER.warning("Error unloading TTS triggers: %s", e)

        lightning_coordinator = entry_data.get("lightning_coordinator")
        if lightning_coordinator:
            try:
                await lightning_coordinator.async_shutdown()
            except Exception as e:
                _LOGGER.warning("Error shutting down lightning coordinator: %s", e)
        
        del hass.data[DOMAIN][entry.entry_id]
    return True


async def _ensure_nws_sounds(hass: HomeAssistant) -> None:
    """Create config/www/home_weather/sounds and copy bundled defaults."""
    from .sounds_setup import ensure_nws_sounds_dir

    await hass.async_add_executor_job(ensure_nws_sounds_dir, hass)


async def _ensure_panel_www_assets(hass: HomeAssistant) -> None:
    """Sync panel JS and icons into config/www when the integration version changes."""
    import json
    from pathlib import Path

    from .panel_www_setup import ensure_panel_www_assets

    manifest_path = Path(__file__).parent / "manifest.json"
    version = "0.0.0"
    try:
        manifest_text = await hass.async_add_executor_job(
            manifest_path.read_text, "utf-8"
        )
        version = str(json.loads(manifest_text).get("version", "0.0.0"))
    except (OSError, json.JSONDecodeError, TypeError) as err:
        _LOGGER.warning("Could not read version for panel www sync: %s", err)

    await hass.async_add_executor_job(ensure_panel_www_assets, hass, version)


async def _register_panel(hass: HomeAssistant) -> None:
    """Register the custom panel with Home Assistant (same pattern as Home Energy)."""
    try:
        import json
        import os
        from pathlib import Path

        from homeassistant.components.http import StaticPathConfig

        www_path = os.path.join(os.path.dirname(__file__), "www")
        panel_url = f"/local/home_weather"

        manifest_path = Path(__file__).parent / "manifest.json"
        panel_version = "0.0.0"
        try:
            # Manifest read is disk I/O — run off the event loop to avoid
            # blocking-call warnings.
            manifest_text = await hass.async_add_executor_job(
                manifest_path.read_text, "utf-8"
            )
            panel_version = str(json.loads(manifest_text).get("version", "0.0.0"))
        except (OSError, json.JSONDecodeError, TypeError) as e:
            _LOGGER.warning("Could not read version from manifest.json: %s", e)

        # Register static path for www files (same as Home Energy)
        await hass.http.async_register_static_paths([
            StaticPathConfig(panel_url, www_path, cache_headers=False)
        ])
        _LOGGER.info("Registered static path for panel files at %s", panel_url)

        # Register panel using panel_custom (same API as Home Energy)
        from homeassistant.components import panel_custom
        from homeassistant.components.frontend import DATA_PANELS, async_remove_panel

        module_url = f"{panel_url}/weather-panel.js?v={panel_version}"
        if PANEL_URL_PATH in hass.data.get(DATA_PANELS, {}):
            async_remove_panel(hass, PANEL_URL_PATH)

        await panel_custom.async_register_panel(
            hass,
            webcomponent_name="home-weather-panel",
            frontend_url_path=PANEL_URL_PATH,
            sidebar_title=PANEL_TITLE,
            sidebar_icon=PANEL_ICON,
            module_url=module_url,
            embed_iframe=False,
            require_admin=False,
        )
        _LOGGER.info(
            "Registered Home Weather panel at /%s (v%s)",
            PANEL_URL_PATH,
            panel_version,
        )

    except Exception as e:
        _LOGGER.error("Failed to register panel: %s", e)
