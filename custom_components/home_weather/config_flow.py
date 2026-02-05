"""Config flow for Home Weather integration."""
from __future__ import annotations

from homeassistant import config_entries

from .const import DOMAIN


class HomeWeatherConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a config flow for Home Weather."""

    VERSION = 1

    async def async_step_user(self, user_input=None):
        """Handle the initial step."""
        # Check if already configured
        await self.async_set_unique_id(DOMAIN)
        self._abort_if_unique_id_configured()

        # Create entry without any user input
        return self.async_create_entry(title="Home Weather", data={})
