"""Home Assistant service actions for Home Weather."""
from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.exceptions import ServiceValidationError
from homeassistant.helpers import config_validation as cv

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

SERVICE_SPEAK_SCHEDULED_FORECAST = "speak_scheduled_forecast"

SPEAK_SCHEDULED_FORECAST_SCHEMA = vol.Schema(
    {
        vol.Optional("config_entry_id"): cv.config_entry_id(DOMAIN),
        vol.Optional("media_player"): cv.entity_id,
        vol.Optional("refresh_weather", default=True): cv.boolean,
    }
)


def _get_loaded_entry_data(
    hass: HomeAssistant, config_entry_id: str | None = None
) -> dict[str, Any]:
    """Return loaded entry data for the requested or first Home Weather config entry."""
    domain_data = hass.data.get(DOMAIN)
    if not domain_data:
        raise ServiceValidationError("Home Weather is not loaded")

    if config_entry_id:
        entry_data = domain_data.get(config_entry_id)
        if not isinstance(entry_data, dict) or not entry_data.get("trigger_manager"):
            raise ServiceValidationError(
                translation_domain=DOMAIN,
                translation_key="service_entry_not_loaded",
                translation_placeholders={"entry_id": config_entry_id},
            )
        return entry_data

    for entry_id, entry_data in domain_data.items():
        if isinstance(entry_data, dict) and entry_data.get("trigger_manager"):
            return entry_data

    raise ServiceValidationError(
        translation_domain=DOMAIN,
        translation_key="service_not_loaded",
    )


async def _handle_speak_scheduled_forecast(hass: HomeAssistant, call: ServiceCall) -> None:
    """Speak a scheduled forecast on demand from an automation or script."""
    entry_data = _get_loaded_entry_data(hass, call.data.get("config_entry_id"))
    trigger_manager = entry_data.get("trigger_manager")
    if not trigger_manager:
        raise ServiceValidationError(
            translation_domain=DOMAIN,
            translation_key="service_not_loaded",
        )

    target_media_player = call.data.get("media_player") or ""
    refresh_weather = call.data.get("refresh_weather", True)

    _LOGGER.info(
        "Manual scheduled forecast requested (media_player=%s, refresh_weather=%s)",
        target_media_player or "all",
        refresh_weather,
    )
    await trigger_manager.speak_scheduled_forecast(
        target_media_player=target_media_player,
        refresh_weather=refresh_weather,
    )


def async_setup_services(hass: HomeAssistant) -> None:
    """Register Home Weather service actions (once per Home Assistant instance)."""
    if hass.services.has_service(DOMAIN, SERVICE_SPEAK_SCHEDULED_FORECAST):
        return

    hass.services.async_register(
        DOMAIN,
        SERVICE_SPEAK_SCHEDULED_FORECAST,
        _handle_speak_scheduled_forecast,
        schema=SPEAK_SCHEDULED_FORECAST_SCHEMA,
    )
