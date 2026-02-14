"""TTS notification message builders and dispatch for Home Weather integration.

Intelligent weatherman-style announcements with:
- Time announcements
- Current day focus for webhook/alarm triggers
- Future-focused (never mentions past hours)
- Notable conditions highlighted (precipitation times, high winds, etc.)
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from .const import NUMBER_WORDS

_LOGGER = logging.getLogger(__name__)


# ============================================================================
# Number and Time Formatting
# ============================================================================

def _spell_number(n: int | float) -> str:
    """Convert a number to spelled-out words for clean TTS pronunciation."""
    if n is None:
        return ""
    
    n = int(round(n))
    
    if n < 0:
        return f"negative {_spell_number(abs(n))}"
    
    if n in NUMBER_WORDS:
        return NUMBER_WORDS[n]
    
    if n < 100:
        tens = (n // 10) * 10
        ones = n % 10
        if ones == 0:
            return NUMBER_WORDS.get(tens, str(n))
        return f"{NUMBER_WORDS.get(tens, str(tens))} {NUMBER_WORDS.get(ones, str(ones))}"
    
    if n == 100:
        return "one hundred"
    
    if n < 1000:
        hundreds = n // 100
        remainder = n % 100
        if remainder == 0:
            return f"{NUMBER_WORDS.get(hundreds, str(hundreds))} hundred"
        return f"{NUMBER_WORDS.get(hundreds, str(hundreds))} hundred {_spell_number(remainder)}"
    
    return str(n)


def _spell_time(dt: datetime | None) -> str:
    """Format a datetime as spoken time (e.g., 'seven oh three AM')."""
    if dt is None:
        return ""
    
    hour = dt.hour
    minute = dt.minute
    
    period = "AM" if hour < 12 else "PM"
    hour_12 = hour % 12
    if hour_12 == 0:
        hour_12 = 12
    
    hour_word = _spell_number(hour_12)
    
    if minute == 0:
        return f"{hour_word} {period}"
    elif minute < 10:
        return f"{hour_word} oh {_spell_number(minute)} {period}"
    else:
        return f"{hour_word} {_spell_number(minute)} {period}"


def _get_greeting_with_time() -> str:
    """Get greeting with time in natural format.
    
    Format: "Good morning, the time is eight oh seven AM"
    """
    now = dt_util.now()
    greeting = _get_greeting()
    time_spoken = _spell_time(now)
    return f"{greeting}, the time is {time_spoken}"


def _get_greeting() -> str:
    """Get time-appropriate greeting."""
    hour = datetime.now().hour
    if 5 <= hour < 12:
        return "Good morning"
    elif 12 <= hour < 17:
        return "Good afternoon"
    elif 17 <= hour < 21:
        return "Good evening"
    else:
        return "Good night"


# ============================================================================
# Weather Data Formatting
# ============================================================================

def _normalize_condition(condition: str) -> str:
    """Normalize weather condition for TTS pronunciation."""
    if not condition:
        return "current conditions"
    
    c = condition.lower().strip()
    c = c.replace("-night", "").replace("-day", "")
    c = c.replace("_night", "").replace("_day", "")
    c = c.replace("_", " ").replace("-", " ")
    c = c.replace("partlycloudy", "partly cloudy")
    c = c.replace("mostlycloudy", "mostly cloudy")
    c = c.replace("clearsky", "clear skies")
    c = c.replace("thunderstorm", "thunderstorms")
    
    return c.strip()


def _format_temperature(temp: int | float | None) -> str:
    """Format temperature for TTS."""
    if temp is None:
        return ""
    return f"{_spell_number(int(round(temp)))} degrees"


def _format_percentage(val: int | float | None) -> str:
    """Format percentage for TTS."""
    if val is None:
        return ""
    return f"{_spell_number(int(round(val)))} percent"


def _format_wind(speed: int | float | None, unit: str = "mph") -> str:
    """Format wind speed for TTS."""
    if speed is None:
        return ""
    s = int(round(speed))
    unit_spoken = "miles per hour" if unit.lower() in ("mph", "mi/h") else unit
    return f"{_spell_number(s)} {unit_spoken}"


def _parse_datetime(dt_val: str | datetime | None) -> datetime | None:
    """Parse a datetime value from string or datetime object."""
    if dt_val is None:
        return None
    if isinstance(dt_val, datetime):
        return dt_val
    try:
        return datetime.fromisoformat(dt_val.replace("Z", "+00:00"))
    except Exception:
        return None


def _get_time_description(dt: datetime) -> str:
    """Get a human-readable time description relative to now."""
    now = dt_util.now()
    diff = dt - now
    hours = diff.total_seconds() / 3600
    
    if hours < 1:
        return "within the hour"
    elif hours < 2:
        return "in about an hour"
    elif hours < 3:
        return "in a couple hours"
    else:
        return f"around {_spell_time(dt)}"


# ============================================================================
# Intelligent Message Builders
# ============================================================================

def _get_today_forecast(daily: list[dict]) -> dict | None:
    """Get today's forecast from daily data."""
    if not daily:
        return None
    return daily[0] if daily else None


def _get_upcoming_precipitation(hourly: list[dict], threshold: int = 30) -> list[dict]:
    """Find upcoming precipitation events in the next 12 hours (future only)."""
    now = dt_util.now()
    upcoming = []
    
    for h in hourly[:12]:
        h_time = _parse_datetime(h.get("datetime"))
        if h_time is None or h_time <= now:
            continue  # Skip past hours
        
        precip_prob = h.get("precipitation_probability", 0) or 0
        if precip_prob >= threshold:
            upcoming.append({
                "time": h_time,
                "prob": precip_prob,
                "condition": h.get("condition", "precipitation"),
            })
    
    return upcoming


def _get_upcoming_high_winds(hourly: list[dict], speed_threshold: int = 15, gust_threshold: int = 25) -> list[dict]:
    """Find upcoming high wind events in the next 12 hours (future only)."""
    now = dt_util.now()
    upcoming = []
    
    for h in hourly[:12]:
        h_time = _parse_datetime(h.get("datetime"))
        if h_time is None or h_time <= now:
            continue
        
        wind_speed = h.get("wind_speed", 0) or 0
        wind_gust = h.get("wind_gust", 0) or 0
        
        if wind_speed >= speed_threshold or wind_gust >= gust_threshold:
            upcoming.append({
                "time": h_time,
                "speed": wind_speed,
                "gust": wind_gust,
            })
            break  # Only mention the first high wind event
    
    return upcoming


def build_scheduled_forecast(
    weather_data: dict[str, Any],
    config: dict[str, Any],
    name: str = "",
) -> str:
    """Build a full scheduled forecast message - weatherman style.
    
    Format: Greeting with time + intro + current + today's outlook + notable events
    """
    current = weather_data.get("current", {})
    hourly = weather_data.get("hourly_forecast", [])
    daily = weather_data.get("daily_forecast", [])
    tts_config = config.get("tts", {})
    prefix = config.get("message_prefix", "")
    
    parts = []
    
    # Greeting with time: "Good morning, the time is eight oh seven AM"
    greeting_time = _get_greeting_with_time()
    
    if name:
        parts.append(f"{greeting_time} {name}, and here's your weather forecast.")
    elif prefix and prefix.strip():
        parts.append(f"{greeting_time}, and {prefix.lower()}.")
    else:
        parts.append(f"{greeting_time}, and here's your weather forecast.")
    
    # Current conditions
    condition = _normalize_condition(current.get("condition") or current.get("state", ""))
    temp = current.get("temperature")
    humidity = current.get("humidity")
    wind_speed = current.get("wind_speed")
    wind_unit = current.get("wind_speed_unit", "mph")
    
    if temp is not None:
        parts.append(f"Right now it's {_format_temperature(temp)} with {condition}.")
    
    # Today's high and low
    today = _get_today_forecast(daily)
    if today:
        hi = today.get("temperature")
        lo = today.get("templow")
        today_cond = _normalize_condition(today.get("condition", ""))
        
        if hi is not None and lo is not None:
            parts.append(f"Today expect {today_cond} with a high of {_format_temperature(hi)} and a low of {_format_temperature(lo)}.")
        elif hi is not None:
            parts.append(f"Today's high will be {_format_temperature(hi)}.")
    
    # Upcoming precipitation
    precip_threshold = tts_config.get("precip_threshold", 30)
    upcoming_precip = _get_upcoming_precipitation(hourly, precip_threshold)
    if upcoming_precip:
        first = upcoming_precip[0]
        time_desc = _get_time_description(first["time"])
        cond = _normalize_condition(first["condition"])
        parts.append(f"Expect {cond} {time_desc} with a {_format_percentage(first['prob'])} chance.")
    
    # Upcoming high winds
    wind_threshold = tts_config.get("wind_speed_threshold", 15)
    gust_threshold = tts_config.get("wind_gust_threshold", 25)
    upcoming_winds = _get_upcoming_high_winds(hourly, wind_threshold, gust_threshold)
    if upcoming_winds:
        wind_event = upcoming_winds[0]
        time_desc = _get_time_description(wind_event["time"])
        if wind_event["gust"] > wind_event["speed"]:
            parts.append(f"Watch for wind gusts up to {_format_wind(wind_event['gust'], wind_unit)} {time_desc}.")
        else:
            parts.append(f"Winds picking up to {_format_wind(wind_event['speed'], wind_unit)} {time_desc}.")
    
    # Tomorrow preview (brief)
    if len(daily) > 1:
        tomorrow = daily[1]
        tom_hi = tomorrow.get("temperature")
        tom_cond = _normalize_condition(tomorrow.get("condition", ""))
        if tom_hi is not None:
            parts.append(f"Tomorrow looks like {tom_cond} with a high near {_format_temperature(tom_hi)}.")
    
    return " ".join(parts)


def build_webhook_message(
    name: str,
    weather_data: dict[str, Any],
    config: dict[str, Any],
) -> str:
    """Build a SHORT, focused wake-up alarm forecast.
    
    This is triggered when a user's phone alarm goes off.
    Focus on TODAY only - current conditions and what to expect for the day.
    Keep it brief and actionable.
    """
    current = weather_data.get("current", {})
    hourly = weather_data.get("hourly_forecast", [])
    daily = weather_data.get("daily_forecast", [])
    tts_config = config.get("tts", {})
    
    parts = []
    
    # Greeting with time: "Good morning, the time is seven oh five AM"
    greeting_time = _get_greeting_with_time()
    
    if name:
        parts.append(f"{greeting_time} {name}.")
    else:
        parts.append(f"{greeting_time}.")
    
    # Current temp and condition (brief)
    condition = _normalize_condition(current.get("condition") or current.get("state", ""))
    temp = current.get("temperature")
    
    if temp is not None:
        parts.append(f"Currently {_format_temperature(temp)} and {condition}.")
    
    # Today's high/low
    today = _get_today_forecast(daily)
    if today:
        hi = today.get("temperature")
        lo = today.get("templow")
        if hi is not None and lo is not None:
            parts.append(f"High of {_format_temperature(hi)}, low of {_format_temperature(lo)}.")
        elif hi is not None:
            parts.append(f"High of {_format_temperature(hi)} today.")
    
    # Most important: precipitation timing
    precip_threshold = tts_config.get("precip_threshold", 30)
    upcoming_precip = _get_upcoming_precipitation(hourly, precip_threshold)
    if upcoming_precip:
        first = upcoming_precip[0]
        time_desc = _get_time_description(first["time"])
        cond = _normalize_condition(first["condition"])
        parts.append(f"{cond.capitalize()} expected {time_desc}.")
    else:
        # No precipitation expected
        parts.append("No precipitation expected today.")
    
    # High winds warning (only if significant)
    wind_threshold = tts_config.get("wind_speed_threshold", 15)
    gust_threshold = tts_config.get("wind_gust_threshold", 25)
    upcoming_winds = _get_upcoming_high_winds(hourly, wind_threshold, gust_threshold)
    if upcoming_winds:
        wind_event = upcoming_winds[0]
        time_desc = _get_time_description(wind_event["time"])
        parts.append(f"Gusty winds {time_desc}.")
    
    return " ".join(parts)


def build_current_change_message(
    old_condition: str,
    new_condition: str,
    weather_data: dict[str, Any],
) -> str:
    """Build a message for when current weather conditions change."""
    old_cond = _normalize_condition(old_condition)
    new_cond = _normalize_condition(new_condition)
    
    current = weather_data.get("current", {})
    temp = current.get("temperature")
    
    greeting_time = _get_greeting_with_time()
    
    if temp is not None:
        return (
            f"{greeting_time}, weather alert. "
            f"Conditions have changed to {new_cond}, "
            f"and it's currently {_format_temperature(temp)}."
        )
    else:
        return f"{greeting_time}, weather alert. Conditions have changed to {new_cond}."


def build_upcoming_change_message(
    precip_kind: str,
    minutes_until: int,
    probability: int,
) -> str:
    """Build a message for upcoming precipitation."""
    kind = _normalize_condition(precip_kind) if precip_kind else "precipitation"
    
    if minutes_until < 5:
        time_phrase = "very soon"
    elif minutes_until < 15:
        time_phrase = f"in about {_spell_number(minutes_until)} minutes"
    elif minutes_until < 60:
        mins = int(round(minutes_until / 5) * 5)
        time_phrase = f"in about {_spell_number(mins)} minutes"
    else:
        hours = minutes_until // 60
        time_phrase = f"in about {_spell_number(hours)} {'hour' if hours == 1 else 'hours'}"
    
    greeting_time = _get_greeting_with_time()
    
    return (
        f"{greeting_time}, weather alert. "
        f"{kind.capitalize()} expected {time_phrase} "
        f"with a {_format_percentage(probability)} chance."
    )


# ============================================================================
# TTS Dispatch
# ============================================================================

async def send_tts(
    hass: HomeAssistant,
    media_players_config: list[dict[str, Any]],
    message: str,
    volume_override: float | None = None,
) -> None:
    """Send TTS to all configured media players.
    
    Each media player has its own TTS settings:
    - tts_entity_id (required)
    - volume
    - preroll_ms  
    - cache
    - language (optional, only included if non-empty)
    - options (optional dict, only included if non-empty)
    """
    if not media_players_config:
        _LOGGER.warning("No media players configured for TTS")
        return
    
    if not message or not message.strip():
        _LOGGER.warning("Empty TTS message, skipping")
        return
    
    for i, mp in enumerate(media_players_config):
        entity_id = mp.get("entity_id")
        if not entity_id:
            continue
        
        tts_entity = mp.get("tts_entity_id")
        if not tts_entity:
            _LOGGER.warning("No TTS entity configured for %s, skipping", entity_id)
            continue
        
        # Per-player settings
        volume = volume_override if volume_override is not None else mp.get("volume", 0.6)
        preroll_ms = mp.get("preroll_ms", 150)
        cache = mp.get("cache", False)
        language = mp.get("language", "")
        options = mp.get("options", {})
        
        _LOGGER.info("Sending TTS to %s via %s", entity_id, tts_entity)
        
        try:
            # Step 1: Set volume
            try:
                await hass.services.async_call(
                    "media_player",
                    "volume_set",
                    {"entity_id": entity_id, "volume_level": volume},
                    blocking=True,
                )
            except Exception as vol_e:
                _LOGGER.warning("Failed to set volume on %s: %s", entity_id, vol_e)
            
            # Step 2: Preroll delay
            if preroll_ms > 0:
                await asyncio.sleep(preroll_ms / 1000)
            
            # Step 3: Build service data - only include non-empty optional fields
            service_data: dict[str, Any] = {
                "media_player_entity_id": entity_id,
                "message": message,
                "cache": cache,
            }
            
            # Only add language if it's a non-empty string
            if language and isinstance(language, str) and language.strip():
                service_data["language"] = language.strip()
            
            # Only add options if it's a non-empty dict
            if options and isinstance(options, dict) and len(options) > 0:
                service_data["options"] = options
            
            _LOGGER.debug("TTS service data: %s", service_data)
            
            await hass.services.async_call(
                "tts",
                "speak",
                service_data,
                target={"entity_id": tts_entity},
                blocking=True,
            )
            
            _LOGGER.info("TTS sent successfully to %s", entity_id)
            
            # Delay between players
            if i < len(media_players_config) - 1:
                await asyncio.sleep(0.5)
            
        except Exception as e:
            _LOGGER.error("Error sending TTS to %s: %s", entity_id, e, exc_info=True)


async def send_tts_with_ai_rewrite(
    hass: HomeAssistant,
    media_players_config: list[dict[str, Any]],
    tts_config: dict[str, Any],
    message: str,
    volume_override: float | None = None,
) -> None:
    """Send TTS with optional AI rewrite of the message."""
    use_ai = tts_config.get("use_ai_rewrite", False)
    ai_entity = tts_config.get("ai_task_entity", "")
    ai_prompt = tts_config.get("ai_rewrite_prompt", "")
    
    final_message = message
    
    if use_ai and ai_entity:
        try:
            result = await hass.services.async_call(
                "ai_task",
                "generate_data",
                {
                    "entity_id": ai_entity,
                    "task_type": "text",
                    "input_data": {
                        "original_message": message,
                        "prompt": ai_prompt,
                    },
                },
                blocking=True,
                return_response=True,
            )
            
            if result and isinstance(result, dict):
                rewritten = result.get("output") or result.get("text") or result.get("result")
                if rewritten and isinstance(rewritten, str):
                    final_message = rewritten
                    _LOGGER.debug("AI rewrote TTS message")
        except Exception as e:
            _LOGGER.warning("AI rewrite failed, using original message: %s", e)
    
    await send_tts(hass, media_players_config, final_message, volume_override)
