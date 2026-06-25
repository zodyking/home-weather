"""Tornado binary and detail sensors."""
from __future__ import annotations

from datetime import datetime
from typing import Any

from homeassistant.components.binary_sensor import BinarySensorEntity
from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.helpers.update_coordinator import CoordinatorEntity
from homeassistant.util import dt as dt_util

from ..tornado_coordinator import TornadoCoordinator
from .base import hazard_device_info, primary_geofield


def create_tornado_entities(
    coordinator: TornadoCoordinator,
    entry: ConfigEntry,
) -> list[Any]:
    """Return tornado detail sensor entities."""
    return [
        TornadoDistanceSensor(coordinator, entry),
        TornadoAreaSensor(coordinator, entry),
        TornadoSeveritySensor(coordinator, entry),
        TornadoExpiresSensor(coordinator, entry),
        TornadoUrgencySensor(coordinator, entry),
        TornadoCertaintySensor(coordinator, entry),
    ]


class _TornadoEntity(CoordinatorEntity, SensorEntity):
    _attr_has_entity_name = True

    def __init__(self, coordinator: TornadoCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator)
        self._entry = entry
        self._attr_device_info = hazard_device_info(entry, "tornado")

    def _primary(self) -> dict[str, Any] | None:
        return primary_geofield(self.coordinator.data, "primary_geofield")


class _TornadoBinaryEntity(CoordinatorEntity, BinarySensorEntity):
    _attr_has_entity_name = True

    def __init__(self, coordinator: TornadoCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator)
        self._entry = entry
        self._attr_device_info = hazard_device_info(entry, "tornado")


class TornadoInGeofieldBinarySensor(_TornadoBinaryEntity):
    _attr_icon = "mdi:weather-tornado"
    _attr_name = "In Geofield"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_tornado_in_geofield"

    @property
    def is_on(self) -> bool:
        data = self.coordinator.data or {}
        return bool(data.get("in_geofield"))


class TornadoAffectingHomeBinarySensor(_TornadoBinaryEntity):
    _attr_icon = "mdi:home-alert"
    _attr_name = "Affecting Home"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_tornado_affecting_home"

    @property
    def is_on(self) -> bool:
        data = self.coordinator.data or {}
        return bool(data.get("affecting_home"))


class TornadoDistanceSensor(_TornadoEntity):
    _attr_icon = "mdi:map-marker-distance"
    _attr_name = "Distance"
    _attr_native_unit_of_measurement = "mi"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_tornado_distance"

    @property
    def native_value(self) -> float | None:
        data = self.coordinator.data or {}
        if not data.get("in_geofield"):
            return None
        return data.get("nearest_distance_miles")


class TornadoAreaSensor(_TornadoEntity):
    _attr_icon = "mdi:map-marker-radius"
    _attr_name = "Area"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_tornado_area"

    @property
    def native_value(self) -> str | None:
        primary = self._primary()
        if not primary:
            return None
        area = primary.get("areaDesc")
        return area if area else None


class TornadoSeveritySensor(_TornadoEntity):
    _attr_icon = "mdi:alert"
    _attr_name = "Severity"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_tornado_severity"

    @property
    def native_value(self) -> str | None:
        primary = self._primary()
        return primary.get("severity") if primary else None


class TornadoExpiresSensor(_TornadoEntity):
    _attr_icon = "mdi:clock-alert"
    _attr_name = "Expires"
    _attr_device_class = "timestamp"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_tornado_expires"

    @property
    def native_value(self) -> datetime | None:
        primary = self._primary()
        if not primary or not primary.get("expires"):
            return None
        return dt_util.parse_datetime(str(primary["expires"]).replace("Z", "+00:00"))


class TornadoUrgencySensor(_TornadoEntity):
    _attr_icon = "mdi:timer-alert"
    _attr_name = "Urgency"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_tornado_urgency"

    @property
    def native_value(self) -> str | None:
        primary = self._primary()
        return primary.get("urgency") if primary else None


class TornadoCertaintySensor(_TornadoEntity):
    _attr_icon = "mdi:check-decagram"
    _attr_name = "Certainty"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_tornado_certainty"

    @property
    def native_value(self) -> str | None:
        primary = self._primary()
        return primary.get("certainty") if primary else None
