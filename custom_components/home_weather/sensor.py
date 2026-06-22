"""Sensor platform for Home Weather tornado warnings."""
from __future__ import annotations

from homeassistant.components.sensor import SensorEntity
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
    """Set up tornado and earthquake sensors."""
    entry_data = hass.data[DOMAIN][entry.entry_id]
    tornado_coordinator: TornadoCoordinator = entry_data["tornado_coordinator"]
    earthquake_coordinator: EarthquakeCoordinator = entry_data["earthquake_coordinator"]
    async_add_entities(
        [
            HomeWeatherTornadoAlertSensor(tornado_coordinator, entry),
            HomeWeatherTornadoPolygonSensor(tornado_coordinator, entry),
            HomeWeatherTornadoDistanceSensor(tornado_coordinator, entry),
            HomeWeatherNearestEarthquakeSensor(earthquake_coordinator, entry),
            HomeWeatherEarthquakeMagnitudeSensor(earthquake_coordinator, entry),
            HomeWeatherEarthquakeDistanceSensor(earthquake_coordinator, entry),
            HomeWeatherEarthquakeDepthSensor(earthquake_coordinator, entry),
            HomeWeatherEarthquakeGeojsonSensor(earthquake_coordinator, entry),
        ]
    )


class HomeWeatherTornadoAlertSensor(CoordinatorEntity, SensorEntity):
    """Sensor for the highest-priority active tornado alert headline."""

    _attr_has_entity_name = True
    _attr_icon = "mdi:message-alert"
    _attr_name = "Tornado Alert"
    _attr_unique_id = f"{DOMAIN}_tornado_alert"

    def __init__(
        self,
        coordinator: TornadoCoordinator,
        entry: ConfigEntry,
    ) -> None:
        super().__init__(coordinator)
        self.entity_id = "sensor.home_weather_tornado_alert"
        self._attr_device_info = {
            "identifiers": {(DOMAIN, entry.entry_id)},
            "name": "Home Weather",
            "manufacturer": "Home Weather",
        }

    @property
    def native_value(self) -> str:
        primary = (self.coordinator.data or {}).get("primary_alert")
        if not primary:
            return "No active tornado warning"
        return primary.get("headline") or "Tornado Warning"

    @property
    def extra_state_attributes(self) -> dict:
        primary = (self.coordinator.data or {}).get("primary_alert") or {}
        return {
            "severity": primary.get("severity"),
            "urgency": primary.get("urgency"),
            "certainty": primary.get("certainty"),
            "expires": primary.get("expires"),
            "area": primary.get("areaDesc"),
            "instruction": primary.get("instruction"),
            "description": primary.get("description"),
            "alert_id": primary.get("alert_id"),
        }


class HomeWeatherTornadoPolygonSensor(CoordinatorEntity, SensorEntity):
    """Sensor exposing map-ready tornado warning polygon GeoJSON."""

    _attr_has_entity_name = True
    _attr_icon = "mdi:vector-polygon"
    _attr_name = "Tornado Polygon"
    _attr_unique_id = f"{DOMAIN}_tornado_polygon"

    def __init__(
        self,
        coordinator: TornadoCoordinator,
        entry: ConfigEntry,
    ) -> None:
        super().__init__(coordinator)
        self.entity_id = "sensor.home_weather_tornado_polygon"
        self._attr_device_info = {
            "identifiers": {(DOMAIN, entry.entry_id)},
            "name": "Home Weather",
            "manufacturer": "Home Weather",
        }

    @property
    def native_value(self) -> str:
        count = (self.coordinator.data or {}).get("active_count", 0)
        return "active" if count > 0 else "clear"

    @property
    def extra_state_attributes(self) -> dict:
        data = self.coordinator.data or {}
        primary = data.get("primary_alert") or {}
        return {
            "geojson": data.get("geojson") or {"type": "FeatureCollection", "features": []},
            "polygons": data.get("polygons") or [],
            "centroid": primary.get("centroid"),
            "geometry_type": primary.get("geometry_type"),
            "map_ready": True,
        }


class HomeWeatherTornadoDistanceSensor(CoordinatorEntity, SensorEntity):
    """Sensor for nearest active tornado warning distance."""

    _attr_has_entity_name = True
    _attr_icon = "mdi:map-marker-distance"
    _attr_name = "Tornado Distance"
    _attr_native_unit_of_measurement = "mi"
    _attr_unique_id = f"{DOMAIN}_tornado_distance"

    def __init__(
        self,
        coordinator: TornadoCoordinator,
        entry: ConfigEntry,
    ) -> None:
        super().__init__(coordinator)
        self.entity_id = "sensor.home_weather_tornado_distance"
        self._attr_device_info = {
            "identifiers": {(DOMAIN, entry.entry_id)},
            "name": "Home Weather",
            "manufacturer": "Home Weather",
        }

    @property
    def native_value(self) -> float | None:
        return (self.coordinator.data or {}).get("nearest_distance_miles")

    @property
    def extra_state_attributes(self) -> dict:
        data = self.coordinator.data or {}
        primary = data.get("primary_alert") or {}
        return {
            "nearest_alert_id": primary.get("alert_id"),
            "nearest_headline": primary.get("headline"),
            "affecting_home": data.get("affecting_home", False),
        }


class HomeWeatherNearestEarthquakeSensor(CoordinatorEntity, SensorEntity):
    """Sensor for the nearest qualifying earthquake place description."""

    _attr_has_entity_name = True
    _attr_icon = "mdi:earth"
    _attr_name = "Nearest Earthquake"
    _attr_unique_id = f"{DOMAIN}_nearest_earthquake"

    def __init__(
        self,
        coordinator: EarthquakeCoordinator,
        entry: ConfigEntry,
    ) -> None:
        super().__init__(coordinator)
        self.entity_id = "sensor.home_weather_nearest_earthquake"
        self._attr_device_info = {
            "identifiers": {(DOMAIN, entry.entry_id)},
            "name": "Home Weather",
            "manufacturer": "Home Weather",
        }

    @property
    def native_value(self) -> str:
        primary = (self.coordinator.data or {}).get("primary_event")
        if not primary:
            return "None nearby"
        return primary.get("place") or "Unknown location"

    @property
    def extra_state_attributes(self) -> dict:
        primary = (self.coordinator.data or {}).get("primary_event") or {}
        return {
            "id": primary.get("id"),
            "time": primary.get("time"),
            "updated": primary.get("updated"),
            "url": primary.get("url"),
            "tsunami": primary.get("tsunami"),
        }


class HomeWeatherEarthquakeMagnitudeSensor(CoordinatorEntity, SensorEntity):
    """Sensor for nearest earthquake magnitude."""

    _attr_has_entity_name = True
    _attr_icon = "mdi:chart-bell-curve"
    _attr_name = "Earthquake Magnitude"
    _attr_unique_id = f"{DOMAIN}_earthquake_magnitude"

    def __init__(
        self,
        coordinator: EarthquakeCoordinator,
        entry: ConfigEntry,
    ) -> None:
        super().__init__(coordinator)
        self.entity_id = "sensor.home_weather_earthquake_magnitude"
        self._attr_device_info = {
            "identifiers": {(DOMAIN, entry.entry_id)},
            "name": "Home Weather",
            "manufacturer": "Home Weather",
        }

    @property
    def native_value(self) -> float | None:
        return (self.coordinator.data or {}).get("nearest_magnitude")


class HomeWeatherEarthquakeDistanceSensor(CoordinatorEntity, SensorEntity):
    """Sensor for nearest earthquake distance."""

    _attr_has_entity_name = True
    _attr_icon = "mdi:map-marker-distance"
    _attr_name = "Earthquake Distance"
    _attr_native_unit_of_measurement = "mi"
    _attr_unique_id = f"{DOMAIN}_earthquake_distance"

    def __init__(
        self,
        coordinator: EarthquakeCoordinator,
        entry: ConfigEntry,
    ) -> None:
        super().__init__(coordinator)
        self.entity_id = "sensor.home_weather_earthquake_distance"
        self._attr_device_info = {
            "identifiers": {(DOMAIN, entry.entry_id)},
            "name": "Home Weather",
            "manufacturer": "Home Weather",
        }

    @property
    def native_value(self) -> float | None:
        return (self.coordinator.data or {}).get("nearest_distance_miles")


class HomeWeatherEarthquakeDepthSensor(CoordinatorEntity, SensorEntity):
    """Sensor for nearest earthquake depth."""

    _attr_has_entity_name = True
    _attr_icon = "mdi:arrow-down-bold"
    _attr_name = "Earthquake Depth"
    _attr_native_unit_of_measurement = "km"
    _attr_unique_id = f"{DOMAIN}_earthquake_depth"

    def __init__(
        self,
        coordinator: EarthquakeCoordinator,
        entry: ConfigEntry,
    ) -> None:
        super().__init__(coordinator)
        self.entity_id = "sensor.home_weather_earthquake_depth"
        self._attr_device_info = {
            "identifiers": {(DOMAIN, entry.entry_id)},
            "name": "Home Weather",
            "manufacturer": "Home Weather",
        }

    @property
    def native_value(self) -> float | None:
        return (self.coordinator.data or {}).get("nearest_depth_km")


class HomeWeatherEarthquakeGeojsonSensor(CoordinatorEntity, SensorEntity):
    """Sensor exposing map-ready earthquake GeoJSON."""

    _attr_has_entity_name = True
    _attr_icon = "mdi:map-marker-multiple"
    _attr_name = "Earthquake GeoJSON"
    _attr_unique_id = f"{DOMAIN}_earthquake_geojson"

    def __init__(
        self,
        coordinator: EarthquakeCoordinator,
        entry: ConfigEntry,
    ) -> None:
        super().__init__(coordinator)
        self.entity_id = "sensor.home_weather_earthquake_geojson"
        self._attr_device_info = {
            "identifiers": {(DOMAIN, entry.entry_id)},
            "name": "Home Weather",
            "manufacturer": "Home Weather",
        }

    @property
    def native_value(self) -> str:
        count = (self.coordinator.data or {}).get("active_count", 0)
        return "active" if count > 0 else "clear"

    @property
    def extra_state_attributes(self) -> dict:
        data = self.coordinator.data or {}
        return {
            "geojson": data.get("geojson") or {"type": "FeatureCollection", "features": []},
            "active_count": data.get("active_count", 0),
            "map_ready": True,
        }
