"""Air quality binary and detail sensors."""
from __future__ import annotations

from typing import Any

from homeassistant.components.binary_sensor import BinarySensorEntity
from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.helpers.entity import EntityCategory
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from ..air_quality_coordinator import AirQualityCoordinator
from .base import hazard_device_info, primary_geofield


def create_air_quality_entities(
    coordinator: AirQualityCoordinator,
    entry: ConfigEntry,
) -> list[Any]:
    """Return air quality detail sensor entities."""
    return [
        AirQualityDistanceSensor(coordinator, entry),
        AirQualityAreaSensor(coordinator, entry),
        AirQualityAqiSensor(coordinator, entry),
        AirQualityCategorySensor(coordinator, entry),
        AirQualityCountSensor(coordinator, entry),
        AirQualityUnhealthyCountSensor(coordinator, entry),
    ]


class _AirQualityEntity(CoordinatorEntity, SensorEntity):
    _attr_has_entity_name = True

    def __init__(self, coordinator: AirQualityCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator)
        self._entry = entry
        self._attr_device_info = hazard_device_info(entry, "air_quality")

    def _primary(self) -> dict[str, Any] | None:
        return primary_geofield(self.coordinator.data)


class _AirQualityBinaryEntity(CoordinatorEntity, BinarySensorEntity):
    _attr_has_entity_name = True

    def __init__(self, coordinator: AirQualityCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator)
        self._entry = entry
        self._attr_device_info = hazard_device_info(entry, "air_quality")


class AirQualityInGeofieldBinarySensor(_AirQualityBinaryEntity):
    _attr_icon = "mdi:air-filter"
    _attr_name = "In Geofield"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_air_quality_in_geofield"

    @property
    def is_on(self) -> bool:
        data = self.coordinator.data or {}
        if not data.get("in_geofield"):
            return False
        primary = primary_geofield(data)
        if not primary:
            return False
        return int(primary.get("category_level") or 1) >= 3


class AirQualityUnhealthyDetectedBinarySensor(_AirQualityBinaryEntity):
    _attr_icon = "mdi:weather-hazy"
    _attr_name = "Unhealthy Air Detected"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_air_quality_unhealthy_detected"

    @property
    def is_on(self) -> bool:
        data = self.coordinator.data or {}
        return int(data.get("unhealthy_count") or 0) > 0


class AirQualityDistanceSensor(_AirQualityEntity):
    _attr_icon = "mdi:map-marker-distance"
    _attr_name = "Distance"
    _attr_native_unit_of_measurement = "mi"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_air_quality_distance"

    @property
    def native_value(self) -> float | None:
        primary = self._primary()
        return primary.get("distance_miles") if primary else None


class AirQualityAreaSensor(_AirQualityEntity):
    _attr_icon = "mdi:map-marker"
    _attr_name = "Area"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_air_quality_area"

    @property
    def native_value(self) -> str | None:
        primary = self._primary()
        if not primary:
            return None
        name = primary.get("name") or ""
        state = primary.get("state") or ""
        return f"{name}, {state}".strip(", ") or None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        primary = self._primary() or {}
        return {
            "name": primary.get("name"),
            "state": primary.get("state"),
            "pollutant": primary.get("pollutant"),
        }


class AirQualityAqiSensor(_AirQualityEntity):
    _attr_icon = "mdi:gauge"
    _attr_name = "AQI"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_air_quality_aqi"

    @property
    def native_value(self) -> int | None:
        primary = self._primary()
        return primary.get("aqi") if primary else None


class AirQualityCategorySensor(_AirQualityEntity):
    _attr_icon = "mdi:air-filter"
    _attr_name = "Category"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_air_quality_category"

    @property
    def native_value(self) -> str | None:
        primary = self._primary()
        return primary.get("category") if primary else None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        primary = self._primary() or {}
        return {"category_level": primary.get("category_level")}


class AirQualityCountSensor(_AirQualityEntity):
    _attr_icon = "mdi:counter"
    _attr_name = "Count In Geofield"
    _attr_entity_category = EntityCategory.DIAGNOSTIC

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_air_quality_count_in_geofield"

    @property
    def native_value(self) -> int:
        data = self.coordinator.data or {}
        return int(data.get("geofield_count") or 0)


class AirQualityUnhealthyCountSensor(_AirQualityEntity):
    _attr_icon = "mdi:weather-hazy"
    _attr_name = "Unhealthy Count"
    _attr_entity_category = EntityCategory.DIAGNOSTIC

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_air_quality_unhealthy_count"

    @property
    def native_value(self) -> int:
        data = self.coordinator.data or {}
        return int(data.get("unhealthy_count") or 0)
