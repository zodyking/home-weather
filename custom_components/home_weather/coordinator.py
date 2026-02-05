"""Weather data coordinator for Home Weather integration."""
from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Any

from homeassistant.components.weather import (
    ATTR_FORECAST,
    ATTR_FORECAST_CONDITION,
    ATTR_FORECAST_PRECIPITATION,
    ATTR_FORECAST_PRECIPITATION_PROBABILITY,
    ATTR_FORECAST_TEMP,
    ATTR_FORECAST_TEMP_LOW,
    ATTR_FORECAST_TIME,
    ATTR_WEATHER_TEMPERATURE,
    ATTR_WEATHER_CONDITION,
    DOMAIN as WEATHER_DOMAIN,
)
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

            # Get current conditions
            current = {
                "temperature": state.attributes.get(ATTR_WEATHER_TEMPERATURE),
                "condition": state.attributes.get(ATTR_WEATHER_CONDITION),
                "state": state.state,
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
                    # Filter to next 24 hours
                    now = dt_util.now()
                    for item in forecast_data[:24]:
                        forecast_time = item.get(ATTR_FORECAST_TIME)
                        if isinstance(forecast_time, str):
                            forecast_time = dt_util.parse_datetime(forecast_time)
                        if forecast_time and forecast_time >= now:
                            hourly_forecast.append({
                                "datetime": forecast_time.isoformat() if isinstance(forecast_time, datetime) else forecast_time,
                                "temperature": item.get(ATTR_FORECAST_TEMP),
                                "condition": item.get(ATTR_FORECAST_CONDITION),
                                "precipitation": item.get(ATTR_FORECAST_PRECIPITATION, 0),
                                "precipitation_probability": item.get(ATTR_FORECAST_PRECIPITATION_PROBABILITY, 0),
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
                    # Get next 7 days
                    for item in forecast_data[:7]:
                        forecast_time = item.get(ATTR_FORECAST_TIME)
                        if isinstance(forecast_time, str):
                            forecast_time = dt_util.parse_datetime(forecast_time)
                        daily_forecast.append({
                            "datetime": forecast_time.isoformat() if isinstance(forecast_time, datetime) else forecast_time,
                            "temperature": item.get(ATTR_FORECAST_TEMP),
                            "templow": item.get(ATTR_FORECAST_TEMP_LOW),
                            "condition": item.get(ATTR_FORECAST_CONDITION),
                            "precipitation": item.get(ATTR_FORECAST_PRECIPITATION, 0),
                            "precipitation_probability": item.get(ATTR_FORECAST_PRECIPITATION_PROBABILITY, 0),
                        })

            except Exception as e:
                _LOGGER.warning("Error fetching forecasts: %s", e)
                # Fallback to attributes if service call fails
                hourly_forecast = []
                daily_forecast = []
                if ATTR_FORECAST in state.attributes:
                    forecasts = state.attributes[ATTR_FORECAST]
                    for item in forecasts[:24]:
                        hourly_forecast.append({
                            "datetime": item.get(ATTR_FORECAST_TIME),
                            "temperature": item.get(ATTR_FORECAST_TEMP),
                            "condition": item.get(ATTR_FORECAST_CONDITION),
                            "precipitation": item.get(ATTR_FORECAST_PRECIPITATION, 0),
                            "precipitation_probability": item.get(ATTR_FORECAST_PRECIPITATION_PROBABILITY, 0),
                        })
                    for item in forecasts[:7]:
                        daily_forecast.append({
                            "datetime": item.get(ATTR_FORECAST_TIME),
                            "temperature": item.get(ATTR_FORECAST_TEMP),
                            "templow": item.get(ATTR_FORECAST_TEMP_LOW),
                            "condition": item.get(ATTR_FORECAST_CONDITION),
                            "precipitation": item.get(ATTR_FORECAST_PRECIPITATION, 0),
                            "precipitation_probability": item.get(ATTR_FORECAST_PRECIPITATION_PROBABILITY, 0),
                        })

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
