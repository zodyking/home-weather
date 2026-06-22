"""Weather data coordinator for Home Weather integration."""
from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.sun import is_up
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed
from homeassistant.util import dt as dt_util

from .const import DOMAIN, UPDATE_INTERVAL
from .condition_labels import enrich_condition
from .storage import HomeWeatherStorage

_LOGGER = logging.getLogger(__name__)


def _parse_forecast_dt(value: str | datetime | None) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value
    return dt_util.parse_datetime(str(value))


def _is_night(hass: HomeAssistant, when: datetime | None) -> bool:
    if when is None:
        utc_when = dt_util.utcnow()
    else:
        utc_when = dt_util.as_utc(when)
    try:
        return not is_up(hass, utc_when)
    except Exception:
        return False


def _apply_condition(raw: str | None, *, hass: HomeAssistant, when: datetime | None) -> tuple[str, str]:
    slug, label = enrich_condition(raw, is_night=_is_night(hass, when))
    return slug, label


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
                _LOGGER.warning(
                    "Weather entity %s not found. Please select a valid entity in Settings.",
                    weather_entity,
                )
                return {
                    "current": None,
                    "hourly_forecast": [],
                    "daily_forecast": [],
                    "configured": False,
                }

            # Get current conditions (use string keys - weather attr names vary by HA version)
            # Some entities expose native_* when using custom unit systems
            raw_condition = state.attributes.get("condition") or state.state
            now = dt_util.now()
            condition_slug, condition_label = _apply_condition(
                raw_condition, hass=self.hass, when=now
            )
            current = {
                "temperature": state.attributes.get("temperature")
                or state.attributes.get("native_temperature"),
                "apparent_temperature": state.attributes.get("apparent_temperature")
                or state.attributes.get("native_apparent_temperature"),
                "condition": condition_slug,
                "condition_label": condition_label,
                "state": condition_slug,
                "humidity": state.attributes.get("humidity"),
                "wind_speed": state.attributes.get("wind_speed")
                or state.attributes.get("native_wind_speed"),
                "wind_speed_unit": state.attributes.get("wind_speed_unit")
                or state.attributes.get("native_wind_speed_unit", "mph"),
                "wind_gust_speed": state.attributes.get("wind_gust_speed")
                or state.attributes.get("native_wind_gust_speed"),
                "precipitation": state.attributes.get("precipitation")
                or state.attributes.get("native_precipitation"),
                "precipitation_unit": state.attributes.get("precipitation_unit")
                or state.attributes.get("native_precipitation_unit", "in"),
                "pressure": state.attributes.get("pressure")
                or state.attributes.get("native_pressure"),
                "pressure_unit": state.attributes.get("pressure_unit")
                or state.attributes.get("native_pressure_unit", "inHg"),
                "dew_point": state.attributes.get("dew_point"),
                "cloud_coverage": state.attributes.get("cloud_coverage"),
                "uv_index": state.attributes.get("uv_index"),
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
                        parsed_time = _parse_forecast_dt(forecast_time)
                        slug, label = _apply_condition(
                            item.get("condition"), hass=self.hass, when=parsed_time
                        )
                        entry = {
                            "datetime": parsed_time.isoformat() if parsed_time else str(forecast_time or ""),
                            "temperature": item.get("temperature") or item.get("native_temperature"),
                            "condition": slug,
                            "condition_label": label,
                            "precipitation": item.get("precipitation", 0) or item.get("native_precipitation", 0),
                            "precipitation_probability": item.get("precipitation_probability", 0)
                            or item.get("native_precipitation_probability", 0),
                            "precipitation_kind": item.get("precipitation_kind"),
                            "wind_speed": item.get("wind_speed") or item.get("native_wind_speed"),
                            "apparent_temperature": item.get("apparent_temperature")
                            or item.get("native_apparent_temperature"),
                            "dew_point": item.get("dew_point") or item.get("native_dew_point"),
                            "pressure": item.get("pressure") or item.get("native_pressure"),
                            "wind_gust_speed": item.get("wind_gust_speed")
                            or item.get("native_wind_gust_speed"),
                            "cloud_coverage": item.get("cloud_coverage"),
                            "uv_index": item.get("uv_index"),
                            "humidity": item.get("humidity"),
                        }
                        hourly_forecast.append(entry)

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
                        parsed_time = _parse_forecast_dt(forecast_time)
                        slug, label = _apply_condition(
                            item.get("condition"), hass=self.hass, when=parsed_time
                        )
                        daily_forecast.append({
                            "datetime": parsed_time.isoformat() if parsed_time else str(forecast_time or ""),
                            "temperature": item.get("temperature") or item.get("native_temperature"),
                            "templow": item.get("templow") or item.get("native_templow"),
                            "condition": slug,
                            "condition_label": label,
                            "precipitation": item.get("precipitation", 0) or item.get("native_precipitation", 0),
                            "precipitation_probability": item.get("precipitation_probability", 0)
                            or item.get("native_precipitation_probability", 0),
                            "precipitation_kind": item.get("precipitation_kind"),
                            "wind_speed": item.get("wind_speed") or item.get("native_wind_speed"),
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
