"""TTS notification message builders and dispatch for Home Weather integration."""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime
from typing import Any

from homeassistant.core import HomeAssistant

from .const import NUMBER_WORDS

_LOGGER = logging.getLogger(__name__)


def _spell_number(n: int | float) -> str:
    """Convert a number to spelled-out words for clean TTS pronunciation.
    
    Examples:
        72 -> "seventy two"
        100 -> "one hundred"
        5 -> "five"
        -3 -> "negative three"
    """
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
    
    # For larger numbers, just return the string representation
    return str(n)


def _spell_time(dt: datetime) -> str:
    """Format a datetime as spoken time for clean TTS pronunciation.
    
    Examples:
        7:00 AM -> "seven AM"
        7:03 AM -> "seven oh three AM"
        12:00 PM -> "twelve PM"
        12:15 PM -> "twelve fifteen PM"
    """
    if dt is None:
        return ""
    
    hour = dt.hour
    minute = dt.minute
    
    # Convert to 12-hour format
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


def _normalize_condition(condition: str) -> str:
    """Normalize weather condition for TTS pronunciation.
    
    Examples:
        "partly_cloudy" -> "partly cloudy"
        "partlycloudy" -> "partly cloudy"
        "clear-night" -> "clear"
    """
    if not condition:
        return "unknown"
    
    c = condition.lower().strip()
    
    # Remove day/night suffixes
    c = c.replace("-night", "").replace("-day", "")
    c = c.replace("_night", "").replace("_day", "")
    
    # Replace separators with spaces
    c = c.replace("_", " ").replace("-", " ")
    
    # Handle common compound words
    c = c.replace("partlycloudy", "partly cloudy")
    c = c.replace("mostlycloudy", "mostly cloudy")
    c = c.replace("clearsky", "clear sky")
    c = c.replace("thunderstorm", "thunder storm")
    
    return c.strip()


def _format_temperature(temp: int | float, spell: bool = True) -> str:
    """Format temperature for TTS."""
    if temp is None:
        return ""
    t = int(round(temp))
    if spell:
        return f"{_spell_number(t)} degrees"
    return f"{t} degrees"


def _format_percentage(val: int | float, spell: bool = True) -> str:
    """Format percentage for TTS."""
    if val is None:
        return ""
    v = int(round(val))
    if spell:
        return f"{_spell_number(v)} percent"
    return f"{v} percent"


def _format_wind(speed: int | float, unit: str = "mph", spell: bool = True) -> str:
    """Format wind speed for TTS."""
    if speed is None:
        return ""
    s = int(round(speed))
    unit_spoken = "miles per hour" if unit.lower() in ("mph", "mi/h") else unit
    if spell:
        return f"{_spell_number(s)} {unit_spoken}"
    return f"{s} {unit_spoken}"


def build_scheduled_forecast(
    weather_data: dict[str, Any],
    config: dict[str, Any],
    name: str = "",
) -> str:
    """Build a full scheduled forecast message.
    
    Format: Greeting + current conditions + hourly segments + daily outlook.
    """
    current = weather_data.get("current", {})
    hourly = weather_data.get("hourly_forecast", [])
    daily = weather_data.get("daily_forecast", [])
    tts_config = config.get("tts", {})
    
    greeting = _get_greeting()
    prefix = config.get("message_prefix", "Weather update")
    
    parts = []
    
    # Greeting and intro
    if name:
        parts.append(f"{greeting} {name}.")
    else:
        parts.append(f"{greeting}.")
    
    parts.append(f"{prefix}.")
    
    # Current conditions
    condition = _normalize_condition(current.get("condition") or current.get("state", ""))
    temp = current.get("temperature")
    humidity = current.get("humidity")
    wind_speed = current.get("wind_speed")
    wind_unit = current.get("wind_speed_unit", "mph")
    
    if temp is not None:
        parts.append(f"Currently, it's {_format_temperature(temp)} and {condition}.")
    else:
        parts.append(f"Currently, the conditions are {condition}.")
    
    if humidity is not None:
        parts.append(f"Humidity is at {_format_percentage(humidity)}.")
    
    if wind_speed is not None and wind_speed > 5:
        parts.append(f"Winds are {_format_wind(wind_speed, wind_unit)}.")
    
    # Hourly segments (next few hours)
    hourly_segments = tts_config.get("hourly_segments_count", 3)
    if hourly and hourly_segments > 0:
        precip_threshold = tts_config.get("precip_threshold", 30)
        upcoming_precip = []
        
        for i, h in enumerate(hourly[:12]):
            precip_prob = h.get("precipitation_probability", 0) or 0
            if precip_prob >= precip_threshold:
                h_time = h.get("datetime")
                if isinstance(h_time, str):
                    try:
                        h_time = datetime.fromisoformat(h_time.replace("Z", "+00:00"))
                    except:
                        continue
                if h_time:
                    upcoming_precip.append({
                        "time": h_time,
                        "prob": precip_prob,
                        "condition": h.get("condition", ""),
                    })
        
        if upcoming_precip:
            first = upcoming_precip[0]
            parts.append(
                f"Expect {_normalize_condition(first['condition'])} around {_spell_time(first['time'])} "
                f"with a {_format_percentage(first['prob'])} chance of precipitation."
            )
    
    # Daily outlook
    daily_days = tts_config.get("daily_forecast_days", 3)
    if daily and daily_days > 0:
        for i, d in enumerate(daily[:daily_days]):
            if i == 0:
                day_name = "Today"
            elif i == 1:
                day_name = "Tomorrow"
            else:
                try:
                    dt_str = d.get("datetime")
                    if isinstance(dt_str, str):
                        dt = datetime.fromisoformat(dt_str.replace("Z", "+00:00"))
                        day_name = dt.strftime("%A")
                    else:
                        day_name = f"Day {i + 1}"
                except:
                    day_name = f"Day {i + 1}"
            
            hi = d.get("temperature")
            lo = d.get("templow")
            cond = _normalize_condition(d.get("condition", ""))
            
            if hi is not None and lo is not None:
                parts.append(
                    f"{day_name}: {cond} with a high of {_format_temperature(hi)} "
                    f"and a low of {_format_temperature(lo)}."
                )
            elif hi is not None:
                parts.append(f"{day_name}: {cond} with a high of {_format_temperature(hi)}.")
    
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
    
    if temp is not None:
        return (
            f"Weather alert. Conditions have changed from {old_cond} to {new_cond}. "
            f"Current temperature is {_format_temperature(temp)}."
        )
    else:
        return f"Weather alert. Conditions have changed from {old_cond} to {new_cond}."


def build_upcoming_change_message(
    precip_kind: str,
    minutes_until: int,
    probability: int,
) -> str:
    """Build a message for upcoming precipitation."""
    kind = precip_kind.lower() if precip_kind else "precipitation"
    
    if minutes_until < 5:
        time_phrase = "very soon"
    elif minutes_until < 15:
        time_phrase = "in about {_spell_number(minutes_until)} minutes"
    elif minutes_until < 60:
        mins = int(round(minutes_until / 5) * 5)  # Round to nearest 5
        time_phrase = f"in about {_spell_number(mins)} minutes"
    else:
        hours = minutes_until // 60
        time_phrase = f"in about {_spell_number(hours)} {'hour' if hours == 1 else 'hours'}"
    
    return (
        f"Weather alert. {kind.capitalize()} expected {time_phrase} "
        f"with a {_format_percentage(probability)} chance."
    )


def build_webhook_message(
    name: str,
    weather_data: dict[str, Any],
    config: dict[str, Any],
) -> str:
    """Build a personalized forecast message triggered by webhook."""
    return build_scheduled_forecast(weather_data, config, name=name)


async def send_tts(
    hass: HomeAssistant,
    media_players_config: list[dict[str, Any]],
    global_tts_config: dict[str, Any],
    message: str,
    volume_override: float | None = None,
) -> None:
    """Send TTS to all configured media players.
    
    Per uber-eats-order-tracker pattern:
    1. Set volume on each media player
    2. Wait for preroll delay
    3. Send TTS speak command
    """
    if not media_players_config:
        _LOGGER.warning("No media players configured for TTS")
        return
    
    preroll_ms = global_tts_config.get("preroll_ms", 150)
    
    for mp in media_players_config:
        entity_id = mp.get("entity_id")
        if not entity_id:
            continue
        
        # Per-player TTS entity override
        tts_entity = mp.get("tts_entity_id") or global_tts_config.get("engine")
        if not tts_entity:
            _LOGGER.warning("No TTS entity configured for %s", entity_id)
            continue
        
        volume = volume_override or mp.get("volume") or global_tts_config.get("volume_level", 0.6)
        cache = mp.get("cache", global_tts_config.get("cache", True))
        language = mp.get("language") or global_tts_config.get("language", "")
        
        try:
            # Step 1: Set volume
            await hass.services.async_call(
                "media_player",
                "volume_set",
                {
                    "entity_id": entity_id,
                    "volume_level": volume,
                },
                blocking=True,
            )
            
            # Step 2: Preroll delay
            if preroll_ms > 0:
                await asyncio.sleep(preroll_ms / 1000)
            
            # Step 3: TTS speak
            service_data: dict[str, Any] = {
                "media_player_entity_id": entity_id,
                "message": message,
                "cache": cache,
            }
            if language:
                service_data["language"] = language
            
            await hass.services.async_call(
                "tts",
                "speak",
                service_data,
                target={"entity_id": tts_entity},
                blocking=False,
            )
            
            _LOGGER.debug("TTS sent to %s via %s", entity_id, tts_entity)
            
        except Exception as e:
            _LOGGER.error("Error sending TTS to %s: %s", entity_id, e)


async def send_tts_with_ai_rewrite(
    hass: HomeAssistant,
    media_players_config: list[dict[str, Any]],
    global_tts_config: dict[str, Any],
    message: str,
    volume_override: float | None = None,
) -> None:
    """Send TTS with optional AI rewrite of the message."""
    use_ai = global_tts_config.get("use_ai_rewrite", False)
    ai_entity = global_tts_config.get("ai_task_entity", "")
    ai_prompt = global_tts_config.get("ai_rewrite_prompt", "")
    
    final_message = message
    
    if use_ai and ai_entity:
        try:
            # Call ai_task.generate_data to rewrite the message
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
    
    await send_tts(hass, media_players_config, global_tts_config, final_message, volume_override)
