"""Wildfire binary and detail sensors."""
from __future__ import annotations

from typing import Any

from homeassistant.components.binary_sensor import BinarySensorEntity
from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.helpers.entity import EntityCategory
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from ..wildfire_coordinator import WildfireCoordinator
from .base import detail_sensor_record, hazard_device_info, primary_geofield


def create_wildfire_entities(
    coordinator: WildfireCoordinator,
    entry: ConfigEntry,
) -> list[Any]:
    """Return wildfire detail sensor entities."""
    return [
        WildfireDistanceSensor(coordinator, entry),
        WildfireNameSensor(coordinator, entry),
        WildfireAcresSensor(coordinator, entry),
        WildfirePercentContainedSensor(coordinator, entry),
        WildfireCountSensor(coordinator, entry),
        WildfireActiveUncontainedCountSensor(coordinator, entry),
    ]


class _WildfireEntity(CoordinatorEntity, SensorEntity):
    _attr_has_entity_name = True

    def __init__(self, coordinator: WildfireCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator)
        self._entry = entry
        self._attr_device_info = hazard_device_info(entry, "wildfire")

    def _primary(self) -> dict[str, Any] | None:
        return detail_sensor_record(
            self.coordinator.data,
            fallback_keys=("nearest_incident",),
        )


class _WildfireBinaryEntity(CoordinatorEntity, BinarySensorEntity):
    _attr_has_entity_name = True

    def __init__(self, coordinator: WildfireCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator)
        self._entry = entry
        self._attr_device_info = hazard_device_info(entry, "wildfire")


class WildfireInGeofieldBinarySensor(_WildfireBinaryEntity):
    _attr_icon = "mdi:fire"
    _attr_name = "In Geofield"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_wildfire_in_geofield"

    @property
    def is_on(self) -> bool:
        data = self.coordinator.data or {}
        return bool(data.get("in_geofield"))


class WildfireActiveIncidentsBinarySensor(_WildfireBinaryEntity):
    _attr_icon = "mdi:fire-alert"
    _attr_name = "Active Incidents"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_wildfire_active_incidents"

    @property
    def is_on(self) -> bool:
        data = self.coordinator.data or {}
        return int(data.get("active_uncontained_count") or 0) > 0


class WildfireDistanceSensor(_WildfireEntity):
    _attr_icon = "mdi:map-marker-distance"
    _attr_name = "Distance"
    _attr_native_unit_of_measurement = "mi"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_wildfire_distance"

    @property
    def native_value(self) -> float | None:
        primary = self._primary()
        return primary.get("distance_miles") if primary else None


class WildfireNameSensor(_WildfireEntity):
    _attr_icon = "mdi:fire"
    _attr_name = "Name"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_wildfire_name"

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
            "location": primary.get("location"),
            "state": primary.get("state"),
            "category": primary.get("category"),
        }


class WildfireAcresSensor(_WildfireEntity):
    _attr_icon = "mdi:terrain"
    _attr_name = "Acres"
    _attr_native_unit_of_measurement = "ac"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_wildfire_acres"

    @property
    def native_value(self) -> float | None:
        primary = self._primary()
        return primary.get("acres") if primary else None


class WildfirePercentContainedSensor(_WildfireEntity):
    _attr_icon = "mdi:percent"
    _attr_name = "Percent Contained"
    _attr_native_unit_of_measurement = "%"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_wildfire_percent_contained"

    @property
    def native_value(self) -> float | None:
        primary = self._primary()
        return primary.get("percent_contained") if primary else None


class WildfireCountSensor(_WildfireEntity):
    _attr_icon = "mdi:counter"
    _attr_name = "Count In Geofield"
    _attr_entity_category = EntityCategory.DIAGNOSTIC

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_wildfire_count_in_geofield"

    @property
    def native_value(self) -> int:
        data = self.coordinator.data or {}
        return int(data.get("geofield_count") or 0)


class WildfireActiveUncontainedCountSensor(_WildfireEntity):
    _attr_icon = "mdi:fire-alert"
    _attr_name = "Active Uncontained Count"
    _attr_entity_category = EntityCategory.DIAGNOSTIC

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_wildfire_active_uncontained_count"

    @property
    def native_value(self) -> int:
        data = self.coordinator.data or {}
        return int(data.get("active_uncontained_count") or 0)
