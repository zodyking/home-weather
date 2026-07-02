"""Solar weather binary and detail sensors."""
from __future__ import annotations

from typing import Any

from homeassistant.components.binary_sensor import BinarySensorEntity
from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from ..space_coordinator import SpaceCoordinator
from .base import hazard_device_info


def create_solar_weather_entities(
    coordinator: SpaceCoordinator,
    entry: ConfigEntry,
) -> list[Any]:
    """Return solar weather detail sensor entities."""
    return [
        SolarWeatherSunspotNumberSensor(coordinator, entry),
        SolarWeatherKIndexSensor(coordinator, entry),
        SolarWeatherF107FluxSensor(coordinator, entry),
        SolarWeatherXrayClassSensor(coordinator, entry),
    ]


class _SolarWeatherEntity(CoordinatorEntity, SensorEntity):
    _attr_has_entity_name = True

    def __init__(self, coordinator: SpaceCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator)
        self._entry = entry
        self._attr_device_info = hazard_device_info(entry, "solar_weather")

    def _solar(self) -> dict[str, Any]:
        return (self.coordinator.data or {}).get("solar_weather") or {}


class _SolarWeatherBinaryEntity(CoordinatorEntity, BinarySensorEntity):
    _attr_has_entity_name = True

    def __init__(self, coordinator: SpaceCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator)
        self._entry = entry
        self._attr_device_info = hazard_device_info(entry, "solar_weather")


class SolarWeatherGeomagneticStormBinarySensor(_SolarWeatherBinaryEntity):
    _attr_icon = "mdi:weather-lightning"
    _attr_name = "Geomagnetic Storm Active"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_solar_weather_geomagnetic_storm_active"

    @property
    def is_on(self) -> bool:
        return bool(self._solar().get("geomagnetic_storm_active"))


class SolarWeatherFlareActiveBinarySensor(_SolarWeatherBinaryEntity):
    _attr_icon = "mdi:white-balance-sunny"
    _attr_name = "Solar Flare Active"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_solar_weather_solar_flare_active"

    @property
    def is_on(self) -> bool:
        return bool(self._solar().get("flare_active"))


class SolarWeatherSunspotNumberSensor(_SolarWeatherEntity):
    _attr_icon = "mdi:sun-wireless"
    _attr_name = "Sunspot Number"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_solar_weather_sunspot_number"

    @property
    def native_value(self) -> float | None:
        val = self._solar().get("sunspot_number")
        return float(val) if val is not None else None


class SolarWeatherKIndexSensor(_SolarWeatherEntity):
    _attr_icon = "mdi:flash"
    _attr_name = "Planetary K-index"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_solar_weather_k_index"

    @property
    def native_value(self) -> float | None:
        val = self._solar().get("k_index")
        return float(val) if val is not None else None


class SolarWeatherF107FluxSensor(_SolarWeatherEntity):
    _attr_icon = "mdi:waveform"
    _attr_name = "F10.7 Flux"
    _attr_native_unit_of_measurement = "sfu"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_solar_weather_f107_flux"

    @property
    def native_value(self) -> float | None:
        val = self._solar().get("f107_flux")
        return float(val) if val is not None else None


class SolarWeatherXrayClassSensor(_SolarWeatherEntity):
    _attr_icon = "mdi:radioactive"
    _attr_name = "X-ray Class"

    @property
    def unique_id(self) -> str:
        return f"{self._entry.entry_id}_solar_weather_xray_class"

    @property
    def native_value(self) -> str | None:
        return self._solar().get("xray_class")
