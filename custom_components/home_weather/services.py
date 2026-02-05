"""WebSocket API handlers for Home Weather integration."""
from __future__ import annotations

import logging
from typing import Any

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)


@callback
def async_setup_websocket_api(hass: HomeAssistant) -> None:
    """Set up WebSocket API handlers."""

    @websocket_api.websocket_command(
        {
            "type": "home_weather/get_config",
        }
    )
    @websocket_api.async_response
    async def handle_get_config(
        hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
    ) -> None:
        """Handle get_config WebSocket command."""
        # Find the first entry's storage
        storage = None
        if DOMAIN in hass.data:
            for entry_id, data in hass.data[DOMAIN].items():
                if isinstance(data, dict) and "storage" in data:
                    storage = data["storage"]
                    break
        
        if not storage:
            connection.send_error(msg["id"], "no_storage", "Storage not available")
            return

        config = await storage.async_get()
        connection.send_result(msg["id"], {"config": config})

    @websocket_api.websocket_command(
        {
            "type": "home_weather/set_config",
            "config": dict,
        }
    )
    @websocket_api.async_response
    async def handle_set_config(
        hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
    ) -> None:
        """Handle set_config WebSocket command."""
        if DOMAIN not in hass.data:
            connection.send_error(msg["id"], "not_loaded", "Integration not loaded")
            return

        # Find the first entry's data
        storage = None
        automation = None
        coordinator = None
        if DOMAIN in hass.data:
            for entry_id, data in hass.data[DOMAIN].items():
                if isinstance(data, dict):
                    storage = data.get("storage")
                    automation = data.get("automation")
                    coordinator = data.get("coordinator")
                    if storage:
                        break

        if not storage:
            connection.send_error(msg["id"], "no_storage", "Storage not available")
            return

        try:
            config = msg.get("config", {})
            await storage.async_save(config)

            # Restart automation with new config
            if automation:
                await automation.async_stop()
                await automation.async_start()

            # Refresh coordinator
            if coordinator:
                await coordinator.async_request_refresh()

            connection.send_result(msg["id"], {"success": True})
        except Exception as e:
            _LOGGER.error("Error saving config: %s", e)
            connection.send_error(msg["id"], "save_failed", str(e))

    @websocket_api.websocket_command(
        {
            "type": "home_weather/get_weather",
        }
    )
    @websocket_api.async_response
    async def handle_get_weather(
        hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
    ) -> None:
        """Handle get_weather WebSocket command."""
        if DOMAIN not in hass.data:
            connection.send_error(msg["id"], "not_loaded", "Integration not loaded")
            return

        # Find the first entry's coordinator
        coordinator = None
        if DOMAIN in hass.data:
            for entry_id, data in hass.data[DOMAIN].items():
                if isinstance(data, dict) and "coordinator" in data:
                    coordinator = data["coordinator"]
                    break
        
        if not coordinator:
            connection.send_error(msg["id"], "no_coordinator", "Coordinator not available")
            return

        # Refresh data
        await coordinator.async_request_refresh()
        data = coordinator.data

        connection.send_result(msg["id"], {"data": data})

    @websocket_api.websocket_command(
        {
            "type": "home_weather/trigger_announcement",
        }
    )
    @websocket_api.async_response
    async def handle_trigger_announcement(
        hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
    ) -> None:
        """Handle trigger_announcement WebSocket command."""
        if DOMAIN not in hass.data:
            connection.send_error(msg["id"], "not_loaded", "Integration not loaded")
            return

        # Find the first entry's automation
        automation = None
        if DOMAIN in hass.data:
            for entry_id, data in hass.data[DOMAIN].items():
                if isinstance(data, dict) and "automation" in data:
                    automation = data["automation"]
                    break
        
        if not automation:
            connection.send_error(msg["id"], "no_automation", "Automation not available")
            return

        try:
            await automation.trigger_announcement()
            connection.send_result(msg["id"], {"success": True})
        except Exception as e:
            _LOGGER.error("Error triggering announcement: %s", e)
            connection.send_error(msg["id"], "trigger_failed", str(e))
