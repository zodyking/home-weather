"""Binary sensor platform for Home Weather hazard monitoring."""
from __future__ import annotations

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN

from .entities.earthquake import (
    EarthquakeInGeofieldBinarySensor,
    EarthquakeTsunamiInGeofieldBinarySensor,
)
from .entities.hurricane import (
    HurricaneInGeofieldBinarySensor,
    HurricaneInsideConeBinarySensor,
    HurricaneThreatElevatedBinarySensor,
)
from .entities.lightning import LightningInGeofieldBinarySensor
from .entities.tornado import (
    TornadoAffectingHomeBinarySensor,
    TornadoInGeofieldBinarySensor,
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up hazard binary sensors."""
    entry_data = hass.data[DOMAIN][entry.entry_id]
    async_add_entities(
        [
            EarthquakeInGeofieldBinarySensor(
                entry_data["earthquake_coordinator"], entry
            ),
            EarthquakeTsunamiInGeofieldBinarySensor(
                entry_data["earthquake_coordinator"], entry
            ),
            TornadoInGeofieldBinarySensor(entry_data["tornado_coordinator"], entry),
            TornadoAffectingHomeBinarySensor(
                entry_data["tornado_coordinator"], entry
            ),
            HurricaneInGeofieldBinarySensor(
                entry_data["hurricane_coordinator"], entry
            ),
            HurricaneInsideConeBinarySensor(
                entry_data["hurricane_coordinator"], entry
            ),
            HurricaneThreatElevatedBinarySensor(
                entry_data["hurricane_coordinator"], entry
            ),
            LightningInGeofieldBinarySensor(
                entry_data["lightning_coordinator"], entry
            ),
        ]
    )
