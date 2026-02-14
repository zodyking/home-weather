"""Constants for Home Weather integration."""
from typing import Final

DOMAIN: Final = "home_weather"
STORAGE_KEY: Final = "home_weather_config"
WEBHOOK_LAST_TRIGGERED_KEY: Final = "home_weather_webhook_last_triggered"
STORAGE_VERSION: Final = 2

DEFAULT_CONFIG: Final = {
    "weather_entity": None,
    "tts": {
        "enabled": False,
        "engine": "",  # tts.* entity_id
        "voice": "",
        "preroll_ms": 150,
        "cache": True,
        "language": "",
        "options": {},
        # Trigger toggles
        "enable_time_based": True,
        "hour_pattern": 3,  # every N hours
        "minute_offset": 3,
        "start_time": "08:00",
        "end_time": "21:00",
        "days_of_week": ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
        "enable_sensor_triggered": False,
        "sensor_triggers": [],  # list of { entity_id, trigger_state }
        "enable_current_change": True,
        "enable_upcoming_change": True,
        "minutes_before_announce": 30,
        "enable_webhook": False,
        "webhooks": [],  # list of { webhook_id, personal_name, enabled }
        "enable_voice_satellite": False,
        "conversation_commands": "What is the weather\nWhats the weather",
        # Precip/forecast settings
        "precip_threshold": 30,
        "hours_ahead": 24,
        "hourly_segments_count": 3,
        "wind_speed_threshold": 15,
        "wind_gust_threshold": 20,
        "daily_forecast_days": 3,
        # AI rewrite
        "use_ai_rewrite": False,
        "ai_task_entity": "",
        "ai_rewrite_prompt": "You are a friendly meteorologist. Rewrite this weather forecast in a natural, conversational way. Keep it concise but informative. Maintain all factual information.",
    },
    "media_players": [],  # list of { entity_id, tts_entity_id, volume, cache, language, options }
    "message_prefix": "Weather update",
}

# Update interval for weather coordinator (5 minutes)
UPDATE_INTERVAL: Final = 300

# Version for cache busting
VERSION: Final = "1.2.14"

# Panel configuration
PANEL_URL_PATH: Final = "home-weather"
PANEL_TITLE: Final = "Home Weather"
PANEL_ICON: Final = "mdi:weather-cloudy"

# Number words for TTS (0-100 for common use)
NUMBER_WORDS: Final = {
    0: "zero", 1: "one", 2: "two", 3: "three", 4: "four", 5: "five",
    6: "six", 7: "seven", 8: "eight", 9: "nine", 10: "ten",
    11: "eleven", 12: "twelve", 13: "thirteen", 14: "fourteen", 15: "fifteen",
    16: "sixteen", 17: "seventeen", 18: "eighteen", 19: "nineteen",
    20: "twenty", 30: "thirty", 40: "forty", 50: "fifty",
    60: "sixty", 70: "seventy", 80: "eighty", 90: "ninety",
    100: "one hundred",
}
