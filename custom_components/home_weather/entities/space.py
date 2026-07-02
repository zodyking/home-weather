"""Space map binary and detail sensors."""
from __future__ import annotations

from typing import Any

from homeassistant.components.binary_sensor import BinarySensorEntity
from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from ..space_coordinator import SpaceCoordinator
from .base import hazard_device_info


def create_space_entities(
    coordinator: SpaceCoordinator,
    entry: ConfigEntry,
) -> list[Any]:
    """Return space map detail sensor entities."""
    return [
        SpaceTrackedBodiesSensor(coordinator, entry),
        SpaceMoonsTrackedSensor(coordinator, entry),
        SpaceSpacecraftTrackedSensor(coordinator, entry),
        SpaceNeosTrackedSensor(coordinator, entry),
        SpaceCometsTrackedSensor(coordinator, entry),
        SpaceClosestNeoDistanceSensor(coordinator, entry),
        SpaceClosestNeoNameSensor(coordinator, entry),
        SpaceCraftElevationSensor(coordinator, entry),
        SpaceCraftAzimuthSensor(coordinator, entry),
    ]


class _SpaceEntity(CoordinatorEntity, SensorEntity):
    _attr_has_entity_name = True

    def __init__(self, coordinator: SpaceCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator)
        self._entry = entry
        self._attr_device_info = hazard_device_info(entry, "space")


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


class SpaceTrackedBodiesSensor(_SpaceEntity):
    _attr_icon = "mdi:orbit"
    _attr_name = "Tracked Bodies"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_space_tracked_bodies"

    @property
    def native_value(self) -> int | None:
        counts = (self.coordinator.data or {}).get("catalog_counts") or {}
        total = counts.get("total")
        return int(total) if total is not None else 0


class SpaceMoonsTrackedSensor(_SpaceEntity):
    _attr_icon = "mdi:moon-waning-crescent"
    _attr_name = "Moons Tracked"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_space_moons_tracked"

    @property
    def native_value(self) -> int | None:
        counts = (self.coordinator.data or {}).get("catalog_counts") or {}
        return int(counts.get("moons") or 0)


class SpaceSpacecraftTrackedSensor(_SpaceEntity):
    _attr_icon = "mdi:rocket-launch"
    _attr_name = "Spacecraft Tracked"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_space_spacecraft_tracked"

    @property
    def native_value(self) -> int | None:
        counts = (self.coordinator.data or {}).get("catalog_counts") or {}
        return int(counts.get("spacecraft") or 0)


class SpaceNeosTrackedSensor(_SpaceEntity):
    _attr_icon = "mdi:asteroid"
    _attr_name = "NEOs Tracked"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_space_neos_tracked"

    @property
    def native_value(self) -> int | None:
        counts = (self.coordinator.data or {}).get("catalog_counts") or {}
        return int(counts.get("asteroids") or 0)


class SpaceCometsTrackedSensor(_SpaceEntity):
    _attr_icon = "mdi:comet"
    _attr_name = "Comets Tracked"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_space_comets_tracked"

    @property
    def native_value(self) -> int | None:
        counts = (self.coordinator.data or {}).get("catalog_counts") or {}
        return int(counts.get("comets") or 0)


class SpaceClosestNeoDistanceSensor(_SpaceEntity):
    _attr_icon = "mdi:moon-first-quarter"
    _attr_name = "Closest NEO Distance"
    _attr_native_unit_of_measurement = "LD"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_space_closest_neo_distance"

    @property
    def native_value(self) -> float | None:
        primary = (self.coordinator.data or {}).get("primary_close_approach")
        if not primary:
            return None
        return primary.get("lunar_distance")


class SpaceClosestNeoNameSensor(_SpaceEntity):
    _attr_icon = "mdi:label"
    _attr_name = "Closest NEO Name"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_space_closest_neo_name"

    @property
    def native_value(self) -> str | None:
        primary = (self.coordinator.data or {}).get("primary_close_approach")
        if not primary:
            return None
        return primary.get("name")


class SpaceCraftElevationSensor(_SpaceEntity):
    _attr_icon = "mdi:angle-acute"
    _attr_name = "Spacecraft Elevation"
    _attr_native_unit_of_measurement = "°"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_space_craft_elevation"

    @property
    def native_value(self) -> float | None:
        passes = (self.coordinator.data or {}).get("overhead_passes") or []
        if not passes:
            return None
        ongoing = [p for p in passes if p.get("ongoing")]
        target = ongoing[0] if ongoing else passes[0]
        alt = target.get("altitude_deg")
        if alt is None:
            return target.get("max_elevation_deg")
        return alt


class SpaceCraftAzimuthSensor(_SpaceEntity):
    _attr_icon = "mdi:compass"
    _attr_name = "Spacecraft Azimuth"
    _attr_native_unit_of_measurement = "°"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_space_craft_azimuth"

    @property
    def native_value(self) -> float | None:
        passes = (self.coordinator.data or {}).get("overhead_passes") or []
        if not passes:
            return None
        ongoing = [p for p in passes if p.get("ongoing")]
        target = ongoing[0] if ongoing else passes[0]
        return target.get("azimuth_deg")
