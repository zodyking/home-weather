"""Lightning binary and detail sensors."""
from __future__ import annotations

from datetime import datetime
from typing import Any

from homeassistant.components.binary_sensor import BinarySensorEntity
from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.helpers.entity import EntityCategory
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from ..lightning_coordinator import LightningCoordinator
from .base import hazard_device_info, primary_geofield


def create_lightning_entities(
    coordinator: LightningCoordinator,
    entry: ConfigEntry,
) -> list[Any]:
    """Return lightning detail sensor entities."""
    return [
        LightningDistanceSensor(coordinator, entry),
        LightningLatitudeSensor(coordinator, entry),
        LightningLongitudeSensor(coordinator, entry),
        LightningLastStrikeTimeSensor(coordinator, entry),
        LightningStrikesLastHourSensor(coordinator, entry),
    ]


class _LightningEntity(CoordinatorEntity, SensorEntity):
    _attr_has_entity_name = True

    def __init__(self, coordinator: LightningCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator)
        self._entry = entry
        self._attr_device_info = hazard_device_info(entry, "lightning")

    def _primary(self) -> dict[str, Any] | None:
        return primary_geofield(self.coordinator.data)


class _LightningBinaryEntity(CoordinatorEntity, BinarySensorEntity):
    _attr_has_entity_name = True

    def __init__(self, coordinator: LightningCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator)
        self._entry = entry
        self._attr_device_info = hazard_device_info(entry, "lightning")


class LightningInGeofieldBinarySensor(_LightningBinaryEntity):
    _attr_icon = "mdi:lightning-bolt"
    _attr_name = "In Geofield"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_lightning_in_geofield"

    @property
    def is_on(self) -> bool:
        data = self.coordinator.data or {}
        return bool(data.get("in_geofield"))


class LightningDistanceSensor(_LightningEntity):
    _attr_icon = "mdi:map-marker-distance"
    _attr_name = "Distance"
    _attr_native_unit_of_measurement = "mi"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_lightning_distance"

    @property
    def native_value(self) -> float | None:
        data = self.coordinator.data or {}
        if not data.get("in_geofield"):
            return None
        return data.get("nearest_distance_miles")


class LightningLatitudeSensor(_LightningEntity):
    _attr_icon = "mdi:latitude"
    _attr_name = "Latitude"
    _attr_native_unit_of_measurement = "°"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_lightning_latitude"

    @property
    def native_value(self) -> float | None:
        data = self.coordinator.data or {}
        if not data.get("in_geofield"):
            return None
        return data.get("nearest_latitude")


class LightningLongitudeSensor(_LightningEntity):
    _attr_icon = "mdi:longitude"
    _attr_name = "Longitude"
    _attr_native_unit_of_measurement = "°"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_lightning_longitude"

    @property
    def native_value(self) -> float | None:
        data = self.coordinator.data or {}
        if not data.get("in_geofield"):
            return None
        return data.get("nearest_longitude")


class LightningLastStrikeTimeSensor(_LightningEntity):
    _attr_icon = "mdi:clock-outline"
    _attr_name = "Last Strike Time"
    _attr_device_class = "timestamp"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_lightning_last_strike_time"

    @property
    def native_value(self) -> datetime | None:
        data = self.coordinator.data or {}
        if not data.get("in_geofield"):
            return None
        value = data.get("last_strike_time")
        return value if isinstance(value, datetime) else None


class LightningStrikesLastHourSensor(_LightningEntity):
    _attr_icon = "mdi:counter"
    _attr_name = "Strikes Last Hour"
    _attr_entity_category = EntityCategory.DIAGNOSTIC

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_lightning_strikes_last_hour"

    @property
    def native_value(self) -> int:
        data = self.coordinator.data or {}
        return int(data.get("strikes_last_hour") or 0)
