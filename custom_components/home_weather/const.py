"""Constants for Home Weather integration."""
from typing import Final

DOMAIN: Final = "home_weather"
STORAGE_KEY: Final = "home_weather_config"
STORAGE_VERSION: Final = 1

DEFAULT_CONFIG: Final = {
    "weather_entity": None,
}

# Update interval for weather coordinator (5 minutes)
UPDATE_INTERVAL: Final = 300

# Version for cache busting
VERSION: Final = "1.0.7"

# Panel configuration
PANEL_URL_PATH: Final = "home-weather"
PANEL_TITLE: Final = "Home Weather"
PANEL_ICON: Final = "mdi:weather-cloudy"
