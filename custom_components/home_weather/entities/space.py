"""Space map binary and detail sensors."""
from __future__ import annotations

from typing import Any

from homeassistant.components.binary_sensor import BinarySensorEntity
from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from ..space_coordinator import SpaceCoordinator
from .base import hazard_device_info


def _active_overhead_pass(data: dict[str, Any] | None) -> dict[str, Any] | None:
    passes = (data or {}).get("overhead_passes") or []
    if not passes:
        return None
    ongoing = [p for p in passes if p.get("ongoing")]
    return ongoing[0] if ongoing else passes[0]


def create_space_entities(
    coordinator: SpaceCoordinator,
    entry: ConfigEntry,
) -> list[Any]:
    """Return space map detail sensor entities."""
    return [
        SpaceOverheadCraftSensor(coordinator, entry),
        SpaceCraftElevationSensor(coordinator, entry),
        SpaceCraftAzimuthSensor(coordinator, entry),
        SpaceCraftMaxElevationSensor(coordinator, entry),
        SpaceClosestNeoDistanceSensor(coordinator, entry),
        SpaceClosestNeoDiameterSensor(coordinator, entry),
        SpaceClosestNeoApproachDateSensor(coordinator, entry),
    ]


class _SpaceEntity(CoordinatorEntity, SensorEntity):
    _attr_has_entity_name = True

    def __init__(self, coordinator: SpaceCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator)
        self._entry = entry
        self._attr_device_info = hazard_device_info(entry, "space")

    def _active_pass(self) -> dict[str, Any] | None:
        return _active_overhead_pass(self.coordinator.data)

    def _primary_neo(self) -> dict[str, Any] | None:
        return (self.coordinator.data or {}).get("primary_close_approach")


class _SpaceBinaryEntity(CoordinatorEntity, BinarySensorEntity):
    _attr_has_entity_name = True

    def __init__(self, coordinator: SpaceCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator)
        self._entry = entry
        self._attr_device_info = hazard_device_info(entry, "space")


class SpaceOverheadBinarySensor(_SpaceBinaryEntity):
    _attr_icon = "mdi:satellite-variant"
    _attr_name = "Spacecraft Overhead"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_space_spacecraft_overhead"

    @property
    def is_on(self) -> bool:
        data = self.coordinator.data or {}
        return bool(data.get("spacecraft_overhead"))

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        active = _active_overhead_pass(self.coordinator.data)
        if not active:
            return {}
        return {
            "craft_name": active.get("craft_name"),
            "craft_id": active.get("craft_id"),
            "max_elevation_deg": active.get("max_elevation_deg"),
            "pass_start": active.get("pass_start"),
            "peak_time": active.get("peak_time"),
        }


class SpaceNeoCloseApproachBinarySensor(_SpaceBinaryEntity):
    _attr_icon = "mdi:asteroid"
    _attr_name = "NEO Close Approach Soon"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_space_neo_close_approach_soon"

    @property
    def is_on(self) -> bool:
        data = self.coordinator.data or {}
        return bool(data.get("neo_close_approach_soon"))

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        primary = (self.coordinator.data or {}).get("primary_close_approach") or {}
        if not primary:
            return {}
        return {
            "name": primary.get("name"),
            "lunar_distance": primary.get("lunar_distance"),
            "diameter_m": primary.get("diameter_m"),
            "close_approach_date": primary.get("close_approach_date"),
        }


class SpaceOverheadCraftSensor(_SpaceEntity):
    _attr_icon = "mdi:satellite-variant"
    _attr_name = "Overhead Spacecraft"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_space_overhead_craft"

    @property
    def native_value(self) -> str:
        active = self._active_pass()
        if not active:
            return "none"
        return str(active.get("craft_name") or active.get("craft_id") or "none")


class SpaceCraftElevationSensor(_SpaceEntity):
    _attr_icon = "mdi:angle-acute"
    _attr_name = "Spacecraft Elevation"
    _attr_native_unit_of_measurement = "°"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_space_craft_elevation"

    @property
    def native_value(self) -> float:
        active = self._active_pass()
        if not active:
            return 0.0
        alt = active.get("altitude_deg")
        if alt is None:
            alt = active.get("max_elevation_deg")
        return float(alt or 0.0)


class SpaceCraftAzimuthSensor(_SpaceEntity):
    _attr_icon = "mdi:compass"
    _attr_name = "Spacecraft Azimuth"
    _attr_native_unit_of_measurement = "°"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_space_craft_azimuth"

    @property
    def native_value(self) -> float:
        active = self._active_pass()
        if not active:
            return 0.0
        az = active.get("azimuth_deg")
        return float(az or 0.0)


class SpaceCraftMaxElevationSensor(_SpaceEntity):
    _attr_icon = "mdi:arrow-up-bold"
    _attr_name = "Spacecraft Pass Peak Elevation"
    _attr_native_unit_of_measurement = "°"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_space_craft_max_elevation"

    @property
    def native_value(self) -> float:
        active = self._active_pass()
        if not active:
            return 0.0
        peak = active.get("max_elevation_deg")
        return float(peak or 0.0)


class SpaceClosestNeoDistanceSensor(_SpaceEntity):
    _attr_icon = "mdi:moon-first-quarter"
    _attr_name = "Closest NEO Distance"
    _attr_native_unit_of_measurement = "LD"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_space_closest_neo_distance"

    @property
    def native_value(self) -> float | None:
        primary = self._primary_neo()
        if not primary:
            return None
        ld = primary.get("lunar_distance")
        return float(ld) if ld is not None else None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        primary = self._primary_neo() or {}
        attrs: dict[str, Any] = {}
        if primary.get("name"):
            attrs["name"] = primary.get("name")
        if primary.get("velocity_kms") is not None:
            attrs["velocity_kms"] = primary.get("velocity_kms")
        return attrs


class SpaceClosestNeoDiameterSensor(_SpaceEntity):
    _attr_icon = "mdi:diameter-variant"
    _attr_name = "Closest NEO Diameter"
    _attr_native_unit_of_measurement = "m"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_space_closest_neo_diameter_m"

    @property
    def native_value(self) -> float | None:
        primary = self._primary_neo()
        if not primary:
            return None
        diam = primary.get("diameter_m")
        return float(diam) if diam is not None else None


class SpaceClosestNeoApproachDateSensor(_SpaceEntity):
    _attr_icon = "mdi:calendar-clock"
    _attr_name = "Closest NEO Approach Date"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_space_closest_neo_approach_date"

    @property
    def native_value(self) -> str | None:
        primary = self._primary_neo()
        if not primary:
            return None
        return primary.get("close_approach_date")
