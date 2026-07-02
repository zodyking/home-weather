"""Hurricane binary and detail sensors."""
from __future__ import annotations

from typing import Any

from homeassistant.components.binary_sensor import BinarySensorEntity
from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.helpers.entity import EntityCategory
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from ..hurricane_coordinator import HurricaneCoordinator
from .base import hazard_device_info, has_sensor_data


def create_hurricane_entities(
    coordinator: HurricaneCoordinator,
    entry: ConfigEntry,
) -> list[Any]:
    """Return hurricane detail sensor entities."""
    return [
        HurricaneThreatLevelSensor(coordinator, entry),
        HurricaneClosestStormNameSensor(coordinator, entry),
        HurricaneDistanceSensor(coordinator, entry),
        HurricaneClosestApproachHourSensor(coordinator, entry),
        HurricaneFormationProbabilitySensor(coordinator, entry),
        HurricaneActiveStormCountSensor(coordinator, entry),
        HurricaneDisturbanceCountSensor(coordinator, entry),
    ]


class _HurricaneEntity(CoordinatorEntity, SensorEntity):
    _attr_has_entity_name = True

    def __init__(self, coordinator: HurricaneCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator)
        self._entry = entry
        self._attr_device_info = hazard_device_info(entry, "hurricane")

    def _summary(self) -> dict[str, Any]:
        data = self.coordinator.data or {}
        return data.get("sensor_summary") or {}


class _HurricaneBinaryEntity(CoordinatorEntity, BinarySensorEntity):
    _attr_has_entity_name = True

    def __init__(self, coordinator: HurricaneCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator)
        self._entry = entry
        self._attr_device_info = hazard_device_info(entry, "hurricane")


class HurricaneInGeofieldBinarySensor(_HurricaneBinaryEntity):
    _attr_icon = "mdi:hurricane"
    _attr_name = "In Geofield"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_hurricane_in_geofield"

    @property
    def is_on(self) -> bool:
        data = self.coordinator.data or {}
        return bool(data.get("in_geofield"))


class HurricaneInsideConeBinarySensor(_HurricaneBinaryEntity):
    _attr_icon = "mdi:cone"
    _attr_name = "Inside Cone"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_hurricane_inside_cone"

    @property
    def is_on(self) -> bool:
        data = self.coordinator.data or {}
        return bool(data.get("inside_cone_geofield"))


class HurricaneThreatElevatedBinarySensor(_HurricaneBinaryEntity):
    _attr_icon = "mdi:alert-circle"
    _attr_name = "Threat Elevated"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_hurricane_threat_elevated"

    @property
    def is_on(self) -> bool:
        data = self.coordinator.data or {}
        return bool(data.get("threat_elevated_geofield"))


class HurricaneThreatLevelSensor(_HurricaneEntity):
    _attr_icon = "mdi:traffic-light"
    _attr_name = "Threat Level"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_hurricane_threat_level"

    @property
    def native_value(self) -> str:
        return self._summary().get("threat_level") or "none"


class HurricaneClosestStormNameSensor(_HurricaneEntity):
    _attr_icon = "mdi:weather-hurricane"
    _attr_name = "Closest Storm Name"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_hurricane_closest_storm_name"

    @property
    def native_value(self) -> str | None:
        data = self.coordinator.data or {}
        if not has_sensor_data(data):
            return None
        return self._summary().get("closest_storm_name")


class HurricaneDistanceSensor(_HurricaneEntity):
    _attr_icon = "mdi:map-marker-distance"
    _attr_name = "Distance"
    _attr_native_unit_of_measurement = "mi"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_hurricane_distance"

    @property
    def native_value(self) -> float | None:
        data = self.coordinator.data or {}
        if not has_sensor_data(data):
            return None
        dist = self._summary().get("distance_miles")
        return float(dist) if dist is not None else None


class HurricaneClosestApproachHourSensor(_HurricaneEntity):
    _attr_icon = "mdi:clock-fast"
    _attr_name = "Closest Approach Hour"
    _attr_native_unit_of_measurement = "h"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_hurricane_closest_approach_hour"

    @property
    def native_value(self) -> int | None:
        data = self.coordinator.data or {}
        if not has_sensor_data(data):
            return None
        hour = self._summary().get("closest_approach_hour")
        return int(hour) if hour is not None else None


class HurricaneFormationProbabilitySensor(_HurricaneEntity):
    _attr_icon = "mdi:percent"
    _attr_name = "Formation Probability"
    _attr_native_unit_of_measurement = "%"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_hurricane_formation_probability"

    @property
    def native_value(self) -> int | None:
        prob = self._summary().get("formation_probability")
        return int(prob) if prob is not None else None


class HurricaneActiveStormCountSensor(_HurricaneEntity):
    _attr_icon = "mdi:counter"
    _attr_name = "Active Storm Count"
    _attr_entity_category = EntityCategory.DIAGNOSTIC

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_hurricane_active_storm_count"

    @property
    def native_value(self) -> int:
        return int(self._summary().get("active_storm_count") or 0)


class HurricaneDisturbanceCountSensor(_HurricaneEntity):
    _attr_icon = "mdi:counter"
    _attr_name = "Disturbance Count"
    _attr_entity_category = EntityCategory.DIAGNOSTIC

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_hurricane_disturbance_count"

    @property
    def native_value(self) -> int:
        return int(self._summary().get("disturbance_count") or 0)
