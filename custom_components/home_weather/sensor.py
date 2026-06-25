"""Sensor platform for Home Weather hazard monitoring."""
from __future__ import annotations

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN
from .entities.earthquake import create_earthquake_entities
from .entities.hurricane import create_hurricane_entities
from .entities.lightning import create_lightning_entities
from .entities.tornado import create_tornado_entities


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up hazard detail sensors."""
    entry_data = hass.data[DOMAIN][entry.entry_id]
    entities = []
    entities.extend(
        create_earthquake_entities(entry_data["earthquake_coordinator"], entry)
    )
    entities.extend(create_tornado_entities(entry_data["tornado_coordinator"], entry))
    entities.extend(
        create_hurricane_entities(entry_data["hurricane_coordinator"], entry)
    )
    entities.extend(
        create_lightning_entities(entry_data["lightning_coordinator"], entry)
    )
    async_add_entities(entities)
