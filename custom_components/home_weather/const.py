"""Constants for Home Weather integration."""
from typing import Final

DOMAIN: Final = "home_weather"
STORAGE_KEY: Final = "home_weather_config"
STORAGE_VERSION: Final = 1

# Default configuration
DEFAULT_CONFIG: Final = {
    "weather_entity": None,
    "tts_engine": None,
    "media_players": [],
    "volume_level": 0.7,
    "voice": None,
    "preroll_ms": 200,
    "enable_time_based": False,
    "hour_pattern": "*/1",
    "minute_offset": 0,
    "start_time": "06:00:00",
    "end_time": "22:00:00",
    "days_of_week": ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
    "enable_sensor_triggered": False,
    "presence_sensors": [],
    "enable_alarm_announce": False,
    "webhook_id": None,
    "personal_name": None,
    "alarm_volume_level": 0.8,
    "enable_current_change_announce": False,
    "current_change_volume_level": 0.7,
    "enable_upcoming_change_announce": False,
    "upcoming_change_volume_level": 0.7,
    "minutes_before_announce": 30,
    "precip_threshold": 30,
    "hours_ahead": 24,
    "enable_voice_satellite": False,
    "conversation_command": None,
    "use_ai_rewrite": False,
    "ai_task_entity": None,
    "ai_rewrite_prompt": None,
}

# Update interval for weather coordinator (5 minutes)
UPDATE_INTERVAL: Final = 300

# Panel configuration
PANEL_URL_PATH: Final = "home-weather"
PANEL_TITLE: Final = "Home Weather"
PANEL_ICON: Final = "mdi:weather-cloudy"
