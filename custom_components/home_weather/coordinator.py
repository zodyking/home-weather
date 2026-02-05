"""Weather data coordinator for Home Weather integration."""
from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed
from homeassistant.util import dt as dt_util

from .const import DOMAIN, UPDATE_INTERVAL
from .storage import HomeWeatherStorage

_LOGGER = logging.getLogger(__name__)


class WeatherCoordinator(DataUpdateCoordinator):
    """Coordinator for weather forecast data."""

    def __init__(
        self,
        hass: HomeAssistant,
        storage: HomeWeatherStorage,
    ) -> None:
        """Initialize the coordinator."""
        super().__init__(
            hass,
            _LOGGER,
            name=DOMAIN,
            update_interval=timedelta(seconds=UPDATE_INTERVAL),
        )
        self.storage = storage
        self._weather_entity: str | None = None

    async def _async_update_data(self) -> dict[str, Any]:
        """Fetch weather data."""
        try:
            # Get current configuration
            config = await self.storage.async_get()
            weather_entity = config.get("weather_entity")

            if not weather_entity:
                _LOGGER.debug("No weather entity configured")
                return {
                    "current": None,
                    "hourly_forecast": [],
                    "daily_forecast": [],
                    "configured": False,
                }

            self._weather_entity = weather_entity

            # Get weather entity state
            state = self.hass.states.get(weather_entity)
            if not state:
                raise UpdateFailed(f"Weather entity {weather_entity} not found")

            # Get current conditions (use string keys - weather attr names vary by HA version)
            current = {
                "temperature": state.attributes.get("temperature"),
                "condition": state.attributes.get("condition"),
                "state": state.state,
                "humidity": state.attributes.get("humidity"),
                "wind_speed": state.attributes.get("wind_speed")
                or state.attributes.get("native_wind_speed"),
                "wind_speed_unit": state.attributes.get("wind_speed_unit")
                or state.attributes.get("native_wind_speed_unit", "mph"),
                "precipitation": state.attributes.get("precipitation")
                or state.attributes.get("native_precipitation"),
                "precipitation_unit": state.attributes.get("precipitation_unit")
                or state.attributes.get("native_precipitation_unit", "in"),
            }

            # Get forecasts using weather.get_forecasts service
            try:
                result = await self.hass.services.async_call(
                    "weather",
                    "get_forecasts",
                    {
                        "entity_id": weather_entity,
                        "type": "hourly",
                    },
                    blocking=True,
                    return_response=True,
                )

                hourly_forecast = []
                if result and weather_entity in result:
                    forecast_data = result[weather_entity].get("forecast", [])
                    for item in forecast_data[:24]:
                        forecast_time = item.get("datetime") or item.get("forecast_time")
                        if isinstance(forecast_time, str):
                            forecast_time = dt_util.parse_datetime(forecast_time)
                        hourly_forecast.append({
                            "datetime": forecast_time.isoformat() if isinstance(forecast_time, datetime) else str(forecast_time) if forecast_time else "",
                            "temperature": item.get("temperature"),
                            "condition": item.get("condition"),
                            "precipitation": item.get("precipitation", 0),
                            "precipitation_probability": item.get("precipitation_probability", 0),
                            "precipitation_kind": item.get("precipitation_kind"),
                            "wind_speed": item.get("wind_speed"),
                        })

                # Get daily forecast
                result_daily = await self.hass.services.async_call(
                    "weather",
                    "get_forecasts",
                    {
                        "entity_id": weather_entity,
                        "type": "daily",
                    },
                    blocking=True,
                    return_response=True,
                )

                daily_forecast = []
                if result_daily and weather_entity in result_daily:
                    forecast_data = result_daily[weather_entity].get("forecast", [])
                    for item in forecast_data[:7]:
                        forecast_time = item.get("datetime") or item.get("forecast_time")
                        if isinstance(forecast_time, str):
                            forecast_time = dt_util.parse_datetime(forecast_time)
                        daily_forecast.append({
                            "datetime": forecast_time.isoformat() if isinstance(forecast_time, datetime) else str(forecast_time) if forecast_time else "",
                            "temperature": item.get("temperature"),
                            "templow": item.get("templow"),
                            "condition": item.get("condition"),
                            "precipitation": item.get("precipitation", 0),
                            "precipitation_probability": item.get("precipitation_probability", 0),
                            "precipitation_kind": item.get("precipitation_kind"),
                            "wind_speed": item.get("wind_speed"),
                        })

            except Exception as e:
                _LOGGER.warning("Error fetching forecasts: %s", e)
                hourly_forecast = []
                daily_forecast = []

            return {
                "current": current,
                "hourly_forecast": hourly_forecast,
                "daily_forecast": daily_forecast,
                "configured": True,
                "weather_entity": weather_entity,
            }

        except Exception as err:
            _LOGGER.error("Error updating weather data: %s", err)
            raise UpdateFailed(f"Error updating weather data: {err}") from err
