"""Earthquake binary and detail sensors."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from homeassistant.components.binary_sensor import BinarySensorEntity
from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.helpers.entity import EntityCategory
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from ..earthquake_coordinator import EarthquakeCoordinator
from .base import hazard_device_info, primary_geofield


def create_earthquake_entities(
    coordinator: EarthquakeCoordinator,
    entry: ConfigEntry,
) -> list[Any]:
    """Return earthquake detail sensor entities."""
    return [
        EarthquakeDistanceSensor(coordinator, entry),
        EarthquakeMagnitudeSensor(coordinator, entry),
        EarthquakeDepthSensor(coordinator, entry),
        EarthquakePlaceSensor(coordinator, entry),
        EarthquakeLatitudeSensor(coordinator, entry),
        EarthquakeLongitudeSensor(coordinator, entry),
        EarthquakeTimeSensor(coordinator, entry),
        EarthquakeCountSensor(coordinator, entry),
    ]


class _EarthquakeEntity(CoordinatorEntity, SensorEntity):
    _attr_has_entity_name = True

    def __init__(self, coordinator: EarthquakeCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator)
        self._entry = entry
        self._attr_device_info = hazard_device_info(entry, "earthquake")

    def _primary(self) -> dict[str, Any] | None:
        return primary_geofield(self.coordinator.data)


class _EarthquakeBinaryEntity(CoordinatorEntity, BinarySensorEntity):
    _attr_has_entity_name = True

    def __init__(self, coordinator: EarthquakeCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator)
        self._entry = entry
        self._attr_device_info = hazard_device_info(entry, "earthquake")


class EarthquakeInGeofieldBinarySensor(_EarthquakeBinaryEntity):
    _attr_icon = "mdi:earth"
    _attr_name = "In Geofield"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_earthquake_in_geofield"

    @property
    def is_on(self) -> bool:
        data = self.coordinator.data or {}
        return bool(data.get("in_geofield"))


class EarthquakeTsunamiInGeofieldBinarySensor(_EarthquakeBinaryEntity):
    _attr_icon = "mdi:waves"
    _attr_name = "Tsunami In Geofield"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_earthquake_tsunami_in_geofield"

    @property
    def is_on(self) -> bool:
        data = self.coordinator.data or {}
        return bool(data.get("tsunami_in_geofield"))


class EarthquakeDistanceSensor(_EarthquakeEntity):
    _attr_icon = "mdi:map-marker-distance"
    _attr_name = "Distance"
    _attr_native_unit_of_measurement = "mi"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_earthquake_distance"

    @property
    def native_value(self) -> float | None:
        primary = self._primary()
        return primary.get("distance_miles") if primary else None


class EarthquakeMagnitudeSensor(_EarthquakeEntity):
    _attr_icon = "mdi:chart-bell-curve"
    _attr_name = "Magnitude"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_earthquake_magnitude"

    @property
    def native_value(self) -> float | None:
        primary = self._primary()
        return primary.get("magnitude") if primary else None


class EarthquakeDepthSensor(_EarthquakeEntity):
    _attr_icon = "mdi:arrow-down-bold"
    _attr_name = "Depth"
    _attr_native_unit_of_measurement = "km"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_earthquake_depth"

    @property
    def native_value(self) -> float | None:
        primary = self._primary()
        return primary.get("depth_km") if primary else None


class EarthquakePlaceSensor(_EarthquakeEntity):
    _attr_icon = "mdi:map-marker"
    _attr_name = "Place"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_earthquake_place"

    @property
    def native_value(self) -> str | None:
        primary = self._primary()
        if not primary:
            return None
        place = primary.get("place")
        return place if place else None


class EarthquakeLatitudeSensor(_EarthquakeEntity):
    _attr_icon = "mdi:latitude"
    _attr_name = "Latitude"
    _attr_native_unit_of_measurement = "°"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_earthquake_latitude"

    @property
    def native_value(self) -> float | None:
        primary = self._primary()
        return primary.get("latitude") if primary else None


class EarthquakeLongitudeSensor(_EarthquakeEntity):
    _attr_icon = "mdi:longitude"
    _attr_name = "Longitude"
    _attr_native_unit_of_measurement = "°"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_earthquake_longitude"

    @property
    def native_value(self) -> float | None:
        primary = self._primary()
        return primary.get("longitude") if primary else None


class EarthquakeTimeSensor(_EarthquakeEntity):
    _attr_icon = "mdi:clock-outline"
    _attr_name = "Time"
    _attr_device_class = "timestamp"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_earthquake_time"

    @property
    def native_value(self) -> datetime | None:
        primary = self._primary()
        if not primary or primary.get("time") is None:
            return None
        return datetime.fromtimestamp(primary["time"] / 1000, tz=timezone.utc)


class EarthquakeCountSensor(_EarthquakeEntity):
    _attr_icon = "mdi:counter"
    _attr_name = "Count In Geofield"
    _attr_entity_category = EntityCategory.DIAGNOSTIC

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_earthquake_count_in_geofield"

    @property
    def native_value(self) -> int:
        data = self.coordinator.data or {}
        return int(data.get("geofield_count") or data.get("active_count") or 0)
