"""WebSocket API handlers for Home Weather integration."""
from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.components.webhook import async_generate_url
from homeassistant.core import HomeAssistant, callback

from .const import DOMAIN, WEBHOOK_LAST_TRIGGERED_KEY

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

        storage = None
        coordinator = None
        trigger_manager = None
        if DOMAIN in hass.data:
            for entry_id, data in hass.data[DOMAIN].items():
                if isinstance(data, dict):
                    storage = data.get("storage")
                    coordinator = data.get("coordinator")
                    trigger_manager = data.get("trigger_manager")
                    if storage:
                        break

        if not storage:
            connection.send_error(msg["id"], "no_storage", "Storage not available")
            return

        try:
            config = msg.get("config", {})
            await storage.async_save(config)
            if coordinator:
                await coordinator.async_request_refresh()
            
            # Reload triggers when config changes
            if trigger_manager:
                await trigger_manager.async_unload()
                await trigger_manager.async_setup()
            
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
            "type": "home_weather/get_tts_entities",
        }
    )
    @websocket_api.async_response
    async def handle_get_tts_entities(
        hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
    ) -> None:
        """Handle get_tts_entities WebSocket command.
        
        Returns all TTS, media player, binary sensor, and AI task entities.
        """
        entities = {
            "tts": [],
            "media_players": [],
            "binary_sensors": [],
            "ai_task": [],
        }
        
        for entity_id, state in hass.states.async_all():
            if entity_id.startswith("tts."):
                entities["tts"].append({
                    "entity_id": entity_id,
                    "name": state.attributes.get("friendly_name", entity_id),
                })
            elif entity_id.startswith("media_player."):
                entities["media_players"].append({
                    "entity_id": entity_id,
                    "name": state.attributes.get("friendly_name", entity_id),
                    "state": state.state,
                })
            elif entity_id.startswith("binary_sensor."):
                entities["binary_sensors"].append({
                    "entity_id": entity_id,
                    "name": state.attributes.get("friendly_name", entity_id),
                    "device_class": state.attributes.get("device_class"),
                })
            elif entity_id.startswith("ai_task."):
                entities["ai_task"].append({
                    "entity_id": entity_id,
                    "name": state.attributes.get("friendly_name", entity_id),
                })
        
        connection.send_result(msg["id"], entities)

    @websocket_api.websocket_command(
        {
            vol.Required("type"): "home_weather/test_tts",
            vol.Required("media_player_entity_id"): str,
            vol.Required("tts_entity_id"): str,
            vol.Required("message"): str,
            vol.Optional("volume", default=0.5): vol.Coerce(float),
            vol.Optional("cache", default=True): bool,
            vol.Optional("language", default=""): str,
            vol.Optional("options", default={}): dict,
        }
    )
    @websocket_api.async_response
    async def handle_test_tts(
        hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
    ) -> None:
        """Handle test_tts WebSocket command.
        
        Fires a one-shot TTS test with specific entity/player/message/volume.
        """
        media_player = msg["media_player_entity_id"]
        tts_entity = msg["tts_entity_id"]
        message = msg["message"]
        volume = msg.get("volume", 0.5)
        cache = msg.get("cache", True)
        language = msg.get("language", "")
        options = msg.get("options", {})
        
        try:
            # Set volume
            await hass.services.async_call(
                "media_player",
                "volume_set",
                {
                    "entity_id": media_player,
                    "volume_level": volume,
                },
                blocking=True,
            )
            
            # Build TTS service data - only include non-empty optional fields
            service_data: dict[str, Any] = {
                "media_player_entity_id": media_player,
                "message": message,
                "cache": cache,
            }
            
            # Only add language if non-empty
            if language and isinstance(language, str) and language.strip():
                service_data["language"] = language.strip()
            
            # Only add options if non-empty dict
            if options and isinstance(options, dict) and len(options) > 0:
                service_data["options"] = options
            
            _LOGGER.debug("Test TTS service data: %s", service_data)
            
            await hass.services.async_call(
                "tts",
                "speak",
                service_data,
                target={"entity_id": tts_entity},
                blocking=True,
            )
            
            connection.send_result(msg["id"], {"success": True})
        except Exception as e:
            _LOGGER.error("Test TTS failed: %s", e)
            connection.send_error(msg["id"], "tts_failed", str(e))

    @websocket_api.websocket_command(
        {
            "type": "home_weather/get_automations",
        }
    )
    @websocket_api.async_response
    async def handle_get_automations(
        hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
    ) -> None:
        """Handle get_automations WebSocket command.
        
        Returns list of automation entities for reference.
        """
        automations = []
        for entity_id, state in hass.states.async_all():
            if entity_id.startswith("automation."):
                automations.append({
                    "entity_id": entity_id,
                    "name": state.attributes.get("friendly_name", entity_id),
                    "state": state.state,
                })
        
        connection.send_result(msg["id"], {"automations": automations})

    @websocket_api.websocket_command(
        {
            "type": "home_weather/get_webhook_info",
        }
    )
    @websocket_api.async_response
    async def handle_get_webhook_info(
        hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
    ) -> None:
        """Return full webhook URLs and last trigger timestamps for configured webhooks."""
        config = {}
        if DOMAIN in hass.data:
            for entry_id, data in hass.data[DOMAIN].items():
                if isinstance(data, dict) and "storage" in data:
                    storage = data.get("storage")
                    if storage and hasattr(storage, "async_get"):
                        config = await storage.async_get()
                    break
        
        tts_config = config.get("tts", {})
        webhooks_config = tts_config.get("webhooks", [])
        if not webhooks_config and tts_config.get("webhook_id"):
            webhooks_config = [{
                "webhook_id": tts_config.get("webhook_id"),
                "personal_name": tts_config.get("personal_name", ""),
                "enabled": True,
            }]
        
        last_triggered = hass.data.get(WEBHOOK_LAST_TRIGGERED_KEY, {})
        
        result = []
        for wh in webhooks_config:
            webhook_id = wh.get("webhook_id")
            if not webhook_id:
                continue
            url_internal = ""
            url_external = ""
            try:
                url_internal = async_generate_url(
                    hass,
                    webhook_id,
                    allow_internal=True,
                    allow_external=False,
                    prefer_external=False,
                )
            except Exception:
                pass
            try:
                url_external = async_generate_url(
                    hass,
                    webhook_id,
                    allow_internal=False,
                    allow_external=True,
                    prefer_external=True,
                )
            except Exception:
                pass
            result.append({
                "webhook_id": webhook_id,
                "url": url_external or url_internal,
                "url_internal": url_internal,
                "url_external": url_external,
                "last_triggered": last_triggered.get(webhook_id),
            })
        
        connection.send_result(msg["id"], {"webhooks": result})

    websocket_api.async_register_command(hass, handle_get_config)
    websocket_api.async_register_command(hass, handle_set_config)
    websocket_api.async_register_command(hass, handle_get_weather)
    websocket_api.async_register_command(hass, handle_get_tts_entities)
    websocket_api.async_register_command(hass, handle_test_tts)
    websocket_api.async_register_command(hass, handle_get_automations)
    websocket_api.async_register_command(hass, handle_get_webhook_info)

