"""Volcano binary and detail sensors."""
from __future__ import annotations

from typing import Any

from homeassistant.components.binary_sensor import BinarySensorEntity
from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.helpers.entity import EntityCategory
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from ..volcano_coordinator import VolcanoCoordinator
from .base import hazard_device_info, primary_geofield


def create_volcano_entities(
    coordinator: VolcanoCoordinator,
    entry: ConfigEntry,
) -> list[Any]:
    """Return volcano detail sensor entities."""
    return [
        VolcanoDistanceSensor(coordinator, entry),
        VolcanoNameSensor(coordinator, entry),
        VolcanoAlertLevelSensor(coordinator, entry),
        VolcanoColorCodeSensor(coordinator, entry),
        VolcanoLatitudeSensor(coordinator, entry),
        VolcanoLongitudeSensor(coordinator, entry),
        VolcanoCountSensor(coordinator, entry),
        VolcanoWorldwideCountSensor(coordinator, entry),
    ]


class _VolcanoEntity(CoordinatorEntity, SensorEntity):
    _attr_has_entity_name = True

    def __init__(self, coordinator: VolcanoCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator)
        self._entry = entry
        self._attr_device_info = hazard_device_info(entry, "volcano")

    def _primary(self) -> dict[str, Any] | None:
        return primary_geofield(self.coordinator.data)


class _VolcanoBinaryEntity(CoordinatorEntity, BinarySensorEntity):
    _attr_has_entity_name = True

    def __init__(self, coordinator: VolcanoCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator)
        self._entry = entry
        self._attr_device_info = hazard_device_info(entry, "volcano")


class VolcanoInGeofieldBinarySensor(_VolcanoBinaryEntity):
    _attr_icon = "mdi:volcano"
    _attr_name = "In Geofield"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_volcano_in_geofield"

    @property
    def is_on(self) -> bool:
        data = self.coordinator.data or {}
        return bool(data.get("in_geofield"))


class VolcanoActivityBinarySensor(_VolcanoBinaryEntity):
    _attr_icon = "mdi:volcano-outline"
    _attr_name = "Activity Worldwide"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_volcano_activity_worldwide"

    @property
    def is_on(self) -> bool:
        data = self.coordinator.data or {}
        return int(data.get("active_count") or 0) > 0


class VolcanoDistanceSensor(_VolcanoEntity):
    _attr_icon = "mdi:map-marker-distance"
    _attr_name = "Distance"
    _attr_native_unit_of_measurement = "mi"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_volcano_distance"

    @property
    def native_value(self) -> float | None:
        primary = self._primary()
        return primary.get("distance_miles") if primary else None


class VolcanoNameSensor(_VolcanoEntity):
    _attr_icon = "mdi:volcano"
    _attr_name = "Name"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_volcano_name"

    @property
    def native_value(self) -> str | None:
        primary = self._primary()
        if not primary:
            return None
        return primary.get("name") or None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        primary = self._primary() or {}
        return {
            "country": primary.get("country"),
            "type": primary.get("type"),
            "elevation_m": primary.get("elevation_m"),
            "synopsis": primary.get("synopsis"),
            "url": primary.get("url"),
        }


class VolcanoAlertLevelSensor(_VolcanoEntity):
    _attr_icon = "mdi:alert-decagram"
    _attr_name = "Alert Level"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_volcano_alert_level"

    @property
    def native_value(self) -> str | None:
        primary = self._primary()
        return primary.get("activity_level") if primary else None


class VolcanoColorCodeSensor(_VolcanoEntity):
    _attr_icon = "mdi:palette"
    _attr_name = "Aviation Color Code"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_volcano_color_code"

    @property
    def native_value(self) -> str | None:
        primary = self._primary()
        return primary.get("color_code") if primary else None


class VolcanoLatitudeSensor(_VolcanoEntity):
    _attr_icon = "mdi:latitude"
    _attr_name = "Latitude"
    _attr_native_unit_of_measurement = "°"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_volcano_latitude"

    @property
    def native_value(self) -> float | None:
        primary = self._primary()
        return primary.get("latitude") if primary else None


class VolcanoLongitudeSensor(_VolcanoEntity):
    _attr_icon = "mdi:longitude"
    _attr_name = "Longitude"
    _attr_native_unit_of_measurement = "°"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_volcano_longitude"

    @property
    def native_value(self) -> float | None:
        primary = self._primary()
        return primary.get("longitude") if primary else None


class VolcanoCountSensor(_VolcanoEntity):
    _attr_icon = "mdi:counter"
    _attr_name = "Count In Geofield"
    _attr_entity_category = EntityCategory.DIAGNOSTIC

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_volcano_count_in_geofield"

    @property
    def native_value(self) -> int:
        data = self.coordinator.data or {}
        return int(data.get("geofield_count") or 0)


class VolcanoWorldwideCountSensor(_VolcanoEntity):
    _attr_icon = "mdi:earth"
    _attr_name = "Active Worldwide"
    _attr_entity_category = EntityCategory.DIAGNOSTIC

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_volcano_active_worldwide"

    @property
    def native_value(self) -> int:
        data = self.coordinator.data or {}
        return int(data.get("active_count") or 0)
