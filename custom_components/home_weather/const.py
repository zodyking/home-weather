"""Constants for Home Weather integration."""
from typing import Final

DOMAIN: Final = "home_weather"
STORAGE_KEY: Final = "home_weather_config"
WEBHOOK_LAST_TRIGGERED_KEY: Final = "home_weather_webhook_last_triggered"
STORAGE_VERSION: Final = 3

# External integration domain for seamless siren + TTS audio combining
CHIME_TTS_DOMAIN: Final = "chime_tts"

DEFAULT_CONFIG: Final = {
    "weather_entity": None,
    "tts": {
        "enabled": False,
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
        "wind_speed_threshold": 15,
        "wind_gust_threshold": 20,
        # Optional zodiac add-ons for scheduled forecasts
        "include_western_zodiac": False,
        "include_chinese_zodiac": False,
        # AI rewrite
        "use_ai_rewrite": False,
        "ai_task_entity": "",
        "ai_rewrite_prompt": "You are a friendly meteorologist. Rewrite this weather forecast in a natural, conversational way. Keep it concise but informative. Maintain all factual information.",
    },
    # Panel appearance / theme. "mode" selects the base palette (dark|light);
    # "overrides" maps individual theme tokens (accent, bg, surface, text, muted,
    # border, danger, warning, success) to user-chosen hex colors.
    "appearance": {
        "mode": "dark",
        "overrides": {},
    },
    # Each media player has its own complete TTS config
    "media_players": [],  # list of { entity_id, tts_entity_id, volume, preroll_ms, cache, language, options }
    "message_prefix": "Here's your weather forecast",
    # Per-announcement-type per-media-player volume/bypass overrides.
    # Shape: { "<type_id>": { "<entity_id>": { "volume": 0.0-1.0, "bypass": false } } }
    # Type IDs: nws_alerts, tropical_alerts, tornado_alerts, earthquake_alerts, volcano_alerts,
    # wildfire_alerts, air_quality_alerts, travel_alerts, spacecraft_alerts, solar_weather_alerts,
    # neo_alerts, current_change, upcoming_change, scheduled_forecast, sun_alerts
    "announcement_players": {},
    "sun_alerts": {
        "enabled": False,
        "sunrise_tts": {"enabled": False, "minutes_before": 15, "interval_minutes": 5},
        "sunset_tts": {"enabled": False, "minutes_before": 15, "interval_minutes": 5},
        "sunrise_automation": {"enabled": False, "entity_id": ""},
        "sunset_automation": {"enabled": False, "entity_id": ""},
    },
    "nws_alerts": {
        "enabled": False,
        "sound_file": "",
        "sound_volume": 0.8,
        "tts_volume": 0.9,
        "replay_on_time_based_forecast": True,
    },
    "tropical_alerts": {
        "enabled": False,
        "sound_file": "",
        "sound_volume": 0.8,
        "tts_volume": 0.9,
        "min_threat_level": "watch",
        "max_distance_miles": 500,
        "announce_inside_cone": True,
        "announce_threat_escalation": True,
        "announce_new_storm": True,
        "announce_outlook_development": True,
        "outlook_min_probability": 40,
    },
    "tornado_alerts": {
        "enabled": False,
        "sound_file": "",
        "sound_volume": 0.8,
        "tts_volume": 0.9,
        "only_affecting_home": True,
        "max_distance_miles": 25,
        "announce_cleared": False,
    },
    "earthquake_alerts": {
        "enabled": False,
        "sound_file": "",
        "sound_volume": 0.8,
        "tts_volume": 0.9,
        "min_magnitude": 4.0,
        "max_distance_miles": 100,
        "tsunami_priority": True,
        "announce_updated": False,
        "announce_cleared": False,
    },
    "volcano_alerts": {
        "enabled": False,
        "sound_file": "",
        "sound_volume": 0.8,
        "tts_volume": 0.9,
        # Minimum unified activity level to announce: advisory | watch | warning
        "min_alert_level": "watch",
        "announce_cleared": False,
    },
    "wildfire_alerts": {
        "enabled": False,
        "sound_file": "",
        "sound_volume": 0.8,
        "tts_volume": 0.9,
        "announce_cleared": False,
    },
    "air_quality_alerts": {
        "enabled": False,
        "sound_file": "",
        "sound_volume": 0.8,
        "tts_volume": 0.9,
        "announce_cleared": False,
    },
    # Optional NWS forecast zone (e.g. NYZ072) for tornado alert filtering
    "nws_zone": "",
    "hurricane_monitoring": {
        "enabled": True,
        # "zone": filter by radius around home; "all": bypass zone, report all data
        "zone_mode": "zone",
        # Alert scope: "zone" uses the same radius/thresholds as sensors;
        # "all" bypasses the zone so TTS alerts fire for all data.
        "alert_zone_mode": "zone",
        "max_distance_miles": 500,
        "min_threat_level": "monitor",
        # Tropical outlook probability threshold (single source of truth for alerts).
        "outlook_min_probability": 40,
    },
    "tornado_monitoring": {
        "enabled": True,
        "zone_mode": "zone",
        "alert_zone_mode": "zone",
        "only_affecting_home": True,
        "max_distance_miles": 25,
    },
    "earthquake_monitoring": {
        "enabled": True,
        "zone_mode": "zone",
        "alert_zone_mode": "zone",
        "min_magnitude": 2.5,
        "radius_miles": 500,
        "feed_type": "all_hour",
        "tsunami_alert_enabled": True,
        "map_show_worldwide": True,
        "map_min_magnitude": 4.5,
        "map_feed_type": "all_day",
    },
    "lightning_monitoring": {
        "enabled": True,
        "zone_mode": "zone",
        "show_on_map": True,
        "max_age_minutes": 60,
        "max_strikes": 500,
        "geofield_radius_miles": 100,
    },
    "volcano_monitoring": {
        "enabled": True,
        "zone_mode": "zone",
        "alert_zone_mode": "zone",
        "radius_miles": 500,
        # Minimum unified activity level tracked by sensors: advisory | watch | warning
        "min_alert_level": "advisory",
        # Plot the full worldwide catalog (subtle markers) on the hazard map
        "map_show_all_volcanoes": True,
    },
    "wildfire_monitoring": {
        "enabled": True,
        "zone_mode": "zone",
        "alert_zone_mode": "zone",
        "radius_miles": 100,
        "show_on_map": True,
        "show_perimeters": True,
        "min_acres": 100,
        "exclude_prescribed": True,
    },
    "air_quality_monitoring": {
        "enabled": True,
        "zone_mode": "zone",
        "alert_zone_mode": "zone",
        "radius_miles": 50,
        "show_on_map": True,
        # Minimum EPA AQI category level (1=Good … 6=Hazardous) shown on map
        "min_category_level": 1,
    },
    "travel_monitoring": {
        "enabled": True,
        "show_on_map": True,
        # Minimum advisory level (1-4) to color countries on the hazard map
        "min_level": 1,
    },
    "travel_alerts": {
        "enabled": False,
        "sound_file": "",
        "sound_volume": 0.8,
        "tts_volume": 0.9,
        # Minimum level (1-4) to announce via TTS
        "min_level": 3,
        "announce_level_changes": True,
        "announce_new_advisories": True,
        # Empty list = all countries; otherwise State Dept category codes or country names
        "watched_countries": [],
    },
    "space_monitoring": {
        "enabled": True,
        "show_planets": True,
        "show_dwarf_planets": True,
        "show_moons": True,
        "show_spacecraft": True,
        "show_asteroids": True,
        "show_comets": True,
        "small_body_min_diameter_km": 0,
        "log_scale_orbits": True,
        "pass_lookahead_hours": 48,
        "pass_lookback_hours": 2,
    },
    "solar_weather_monitoring": {
        "enabled": True,
        "show_sunspot_regions": True,
        "show_flare_events": True,
    },
    "spacecraft_alerts": {
        "enabled": False,
        "sound_file": "",
        "sound_volume": 0.8,
        "tts_volume": 0.9,
        "min_elevation_deg": 10,
        "craft_ids": ["-125544"],
        "announce_pass_start": True,
        "announce_pass_peak": False,
    },
    "solar_weather_alerts": {
        "enabled": False,
        "sound_file": "",
        "sound_volume": 0.8,
        "tts_volume": 0.9,
        "min_k_index": 5,
        "min_g_scale": 1,
        "min_xray_class": "M",
        "announce_flare_events": True,
        "announce_geomagnetic_storm": True,
    },
    "neo_alerts": {
        "enabled": False,
        "sound_file": "",
        "sound_volume": 0.8,
        "tts_volume": 0.9,
        "max_lunar_distances": 5,
        "min_diameter_m": 100,
    },
    # Legacy keys kept for backward compatibility during transition
    "earthquakes": {
        "enabled": True,
        "min_magnitude": 2.5,
        "radius_miles": 500,
        "feed_type": "all_hour",
        "tsunami_alert_enabled": True,
        "map_show_worldwide": True,
        "map_min_magnitude": 4.5,
        "map_feed_type": "all_day",
    },
    "lightning": {
        "show_on_map": True,
        "max_age_minutes": 60,
        "max_strikes": 500,
        "geofield_radius_miles": 100,
    },
}

# Relative path under config/www for NWS alert siren files (served at /local/)
NWS_SOUNDS_SUBPATH: Final = "home_weather/sounds"

# Update interval for weather coordinator (5 minutes)
UPDATE_INTERVAL: Final = 300

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
