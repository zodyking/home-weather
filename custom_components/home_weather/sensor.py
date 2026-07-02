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
from .entities.volcano import create_volcano_entities
from .entities.wildfire import create_wildfire_entities
from .entities.air_quality import create_air_quality_entities
from .entities.space import create_space_entities
from .entities.solar_weather import create_solar_weather_entities


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
    entities.extend(
        create_volcano_entities(entry_data["volcano_coordinator"], entry)
    )
    entities.extend(
        create_wildfire_entities(entry_data["wildfire_coordinator"], entry)
    )
    entities.extend(
        create_air_quality_entities(entry_data["air_quality_coordinator"], entry)
    )
    entities.extend(
        create_space_entities(entry_data["space_coordinator"], entry)
    )
    entities.extend(
        create_solar_weather_entities(entry_data["space_coordinator"], entry)
    )
    async_add_entities(entities)
