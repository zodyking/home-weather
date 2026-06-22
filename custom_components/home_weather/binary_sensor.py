"""Binary sensor platform for Home Weather tornado warnings."""
from __future__ import annotations

from homeassistant.components.binary_sensor import BinarySensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .tornado_coordinator import TornadoCoordinator
from .earthquake_coordinator import EarthquakeCoordinator


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up tornado and earthquake binary sensors."""
    entry_data = hass.data[DOMAIN][entry.entry_id]
    tornado_coordinator: TornadoCoordinator = entry_data["tornado_coordinator"]
    earthquake_coordinator: EarthquakeCoordinator = entry_data["earthquake_coordinator"]
    async_add_entities(
        [
            HomeWeatherTornadoWarningBinarySensor(tornado_coordinator, entry),
            HomeWeatherEarthquakeNearbyBinarySensor(earthquake_coordinator, entry),
        ]
    )


class HomeWeatherTornadoWarningBinarySensor(CoordinatorEntity, BinarySensorEntity):
    """Binary sensor indicating an active tornado warning affecting home or zone."""

    _attr_has_entity_name = True
    _attr_icon = "mdi:weather-tornado"
    _attr_name = "Tornado Warning"
    _attr_unique_id = f"{DOMAIN}_tornado_warning"

    def __init__(
        self,
        coordinator: TornadoCoordinator,
        entry: ConfigEntry,
    ) -> None:
        super().__init__(coordinator)
        self._entry = entry
        self.entity_id = "binary_sensor.home_weather_tornado_warning"
        self._attr_device_info = {
            "identifiers": {(DOMAIN, entry.entry_id)},
            "name": "Home Weather",
            "manufacturer": "Home Weather",
        }

    @property
    def is_on(self) -> bool:
        data = self.coordinator.data or {}
        return bool(data.get("warning_active"))

    @property
    def extra_state_attributes(self) -> dict:
        data = self.coordinator.data or {}
        alerts = data.get("alerts") or []
        return {
            "active_count": data.get("active_count", 0),
            "nearest_distance_miles": data.get("nearest_distance_miles"),
            "affecting_home": data.get("affecting_home", False),
            "active_alerts": [
                {
                    "alert_id": a.get("alert_id"),
                    "headline": a.get("headline"),
                    "severity": a.get("severity"),
                    "expires": a.get("expires"),
                    "affecting_home": a.get("affecting_home"),
                    "distance_miles": a.get("distance_miles"),
                }
                for a in alerts
            ],
            "last_updated": data.get("last_updated"),
        }


class HomeWeatherEarthquakeNearbyBinarySensor(CoordinatorEntity, BinarySensorEntity):
    """Binary sensor indicating a qualifying earthquake is within configured radius."""

    _attr_has_entity_name = True
    _attr_icon = "mdi:earth"
    _attr_name = "Earthquake Nearby"
    _attr_unique_id = f"{DOMAIN}_earthquake_nearby"

    def __init__(
        self,
        coordinator: EarthquakeCoordinator,
        entry: ConfigEntry,
    ) -> None:
        super().__init__(coordinator)
        self._entry = entry
        self.entity_id = "binary_sensor.home_weather_earthquake_nearby"
        self._attr_device_info = {
            "identifiers": {(DOMAIN, entry.entry_id)},
            "name": "Home Weather",
            "manufacturer": "Home Weather",
        }

    @property
    def is_on(self) -> bool:
        data = self.coordinator.data or {}
        return bool(data.get("nearby_active"))

    @property
    def extra_state_attributes(self) -> dict:
        data = self.coordinator.data or {}
        primary = data.get("primary_event") or {}
        return {
            "active_count": data.get("active_count", 0),
            "nearest_distance_miles": data.get("nearest_distance_miles"),
            "nearest_magnitude": data.get("nearest_magnitude"),
            "nearest_place": data.get("nearest_place"),
            "nearest_depth_km": data.get("nearest_depth_km"),
            "tsunami": primary.get("tsunami"),
            "primary_id": primary.get("id"),
            "last_updated": data.get("last_updated"),
        }
