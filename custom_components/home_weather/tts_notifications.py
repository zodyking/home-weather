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
import re
from datetime import datetime, timedelta
from typing import Any
from urllib.parse import quote

from homeassistant.core import HomeAssistant
from homeassistant.helpers.network import get_url
from homeassistant.util import dt as dt_util

from .const import NUMBER_WORDS

_LOGGER = logging.getLogger(__name__)

TTS_STATUS_EVENT = "home_weather_tts_status"


def _fire_tts_status(
    hass: HomeAssistant,
    status: str,
    *,
    request_id: str | None = None,
    entity_id: str = "",
    message_preview: str = "",
    reason: str = "",
    alert_kind: str = "",
) -> None:
    """Fire a TTS status event the frontend can subscribe to.

    status: "playing" | "failed" | "skipped" | "sent"
    reason: short human-readable explanation for failed/skipped.
    """
    try:
        hass.bus.async_fire(
            TTS_STATUS_EVENT,
            {
                "status": status,
                "request_id": request_id or "",
                "entity_id": entity_id,
                "message_preview": (message_preview or "")[:160],
                "reason": reason,
                "alert_kind": alert_kind,
            },
        )
    except Exception as err:  # never let event-firing break TTS
        _LOGGER.warning("Failed to fire TTS status event: %s", err)


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
    hour = dt_util.now().hour
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


def _get_upcoming_high_winds(hourly: list[dict], speed_threshold: int = 15, gust_threshold: int = 20) -> list[dict]:
    """Find upcoming high wind events in the next 12 hours (future only)."""
    now = dt_util.now()
    upcoming = []
    
    for h in hourly[:12]:
        h_time = _parse_datetime(h.get("datetime"))
        if h_time is None or h_time <= now:
            continue
        
        wind_speed = h.get("wind_speed", 0) or 0
        wind_gust = h.get("wind_gust_speed", 0) or h.get("wind_gust", 0) or 0
        
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
    current = weather_data.get("current") or {}
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
    
    # Fallback when no weather content was added (e.g. empty/missing data)
    if len(parts) <= 1:
        parts.append("Weather data is temporarily unavailable.")
    
    msg = " ".join(parts)
    _LOGGER.debug(
        "build_scheduled_forecast: %d parts, current=%s, hourly=%d, daily=%d",
        len(parts),
        "empty" if not current else "ok",
        len(hourly),
        len(daily),
    )
    return msg


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
    current = weather_data.get("current") or {}
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
    
    # Fallback when no weather content was added (e.g. empty/missing data)
    if len(parts) <= 1:
        parts.append("Weather data is temporarily unavailable.")
    
    return " ".join(parts)


def build_current_change_message(
    old_condition: str,
    new_condition: str,
    weather_data: dict[str, Any],
) -> str:
    """Build a message for when current weather conditions change."""
    old_cond = _normalize_condition(old_condition)
    new_cond = _normalize_condition(new_condition)
    
    current = weather_data.get("current") or {}
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


# ============================================================================
# Sunrise/Sunset TTS Messages
# ============================================================================

def build_sunrise_upcoming_message(minutes_until: int) -> str:
    """Build TTS message for upcoming sunrise.

    Format: 'Good morning, the time is currently {time}. The sun is going to
    rise in {minutes} minutes.'
    """
    greeting = "Good morning"
    time_spoken = _spell_time(dt_util.now())
    mins = _spell_number(minutes_until)
    mins_phrase = "1 minute" if minutes_until == 1 else f"{mins} minutes"
    return f"{greeting}, the time is currently {time_spoken}. The sun is going to rise in {mins_phrase}."


def build_sunrise_final_message(automation_triggered: bool) -> str:
    """Build TTS message when sunrise has occurred.

    Format: 'Good morning, the time is currently {time}. The sun has risen.'
    + if automation: 'Your sun rise automation has been triggered.'
    """
    greeting = "Good morning"
    time_spoken = _spell_time(dt_util.now())
    msg = f"{greeting}, the time is currently {time_spoken}. The sun has risen."
    if automation_triggered:
        msg += " Your sun rise automation has been triggered."
    return msg


def build_sunset_upcoming_message(minutes_until: int) -> str:
    """Build TTS message for upcoming sunset.

    Format: 'Good evening, the time is currently {time}. The sun is going to
    set in {minutes} minutes.'
    """
    hour = dt_util.now().hour
    greeting = "Good evening" if hour < 21 else "Good night"
    time_spoken = _spell_time(dt_util.now())
    mins = _spell_number(minutes_until)
    mins_phrase = "1 minute" if minutes_until == 1 else f"{mins} minutes"
    return f"{greeting}, the time is currently {time_spoken}. The sun is going to set in {mins_phrase}."


def build_sunset_final_message(automation_triggered: bool) -> str:
    """Build TTS message when sunset has occurred.

    Format: 'Good evening, the time is currently {time}. The sun has set.'
    + if automation: 'Your sun set automation has been triggered.'
    """
    hour = dt_util.now().hour
    greeting = "Good evening" if hour < 21 else "Good night"
    time_spoken = _spell_time(dt_util.now())
    msg = f"{greeting}, the time is currently {time_spoken}. The sun has set."
    if automation_triggered:
        msg += " Your sun set automation has been triggered."
    return msg


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
    *,
    request_id: str | None = None,
    alert_kind: str = "",
) -> None:
    """Send TTS to all configured media players.
    
    Each media player has its own TTS settings:
    - tts_entity_id (required)
    - volume
    - preroll_ms  
    - cache
    - language (optional, only included if non-empty)
    - options (optional dict, only included if non-empty)

    Fires home_weather_tts_status events so the UI can show real playback
    status instead of a blind "Queued" label.
    """
    if not media_players_config:
        _LOGGER.warning("No media players configured for TTS")
        _fire_tts_status(
            hass, "skipped",
            request_id=request_id, reason="No media players configured",
            alert_kind=alert_kind,
        )
        return
    
    if not message or not message.strip():
        _LOGGER.warning("Empty TTS message, skipping")
        _fire_tts_status(
            hass, "skipped",
            request_id=request_id, reason="Empty TTS message",
            alert_kind=alert_kind,
        )
        return
    
    for i, mp in enumerate(media_players_config):
        entity_id = mp.get("entity_id")
        if not entity_id:
            continue
        
        tts_entity = mp.get("tts_entity_id")
        if not tts_entity:
            _LOGGER.warning("No TTS entity configured for %s, skipping", entity_id)
            _fire_tts_status(
                hass, "skipped",
                request_id=request_id, entity_id=entity_id,
                reason=f"No TTS entity configured for {entity_id}",
                alert_kind=alert_kind,
            )
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
                    blocking=False,
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
                blocking=False,
            )
            
            _LOGGER.info("TTS sent successfully to %s", entity_id)
            _fire_tts_status(
                hass, "sent",
                request_id=request_id, entity_id=entity_id,
                message_preview=message, alert_kind=alert_kind,
            )
            
            # Delay between players
            if i < len(media_players_config) - 1:
                await asyncio.sleep(0.5)
            
        except Exception as e:
            _LOGGER.error("Error sending TTS to %s: %s", entity_id, e, exc_info=True)
            _fire_tts_status(
                hass, "failed",
                request_id=request_id, entity_id=entity_id,
                reason=str(e), alert_kind=alert_kind,
            )


def _build_ai_rewrite_instructions(prompt: str, message: str) -> str:
    """Build instructions for ai_task.generate_data."""
    system = (prompt or "").strip() or (
        "You are a friendly meteorologist. Rewrite this weather message in a "
        "natural, conversational way for spoken text-to-speech."
    )
    return (
        f"{system}\n\n"
        "Return only the rewritten spoken message with no markdown, quotes, "
        "or extra commentary.\n\n"
        f"Original message:\n{message}"
    )


def _extract_ai_task_text(result: Any) -> str | None:
    """Parse text from ai_task.generate_data response."""
    if not result:
        return None
    if isinstance(result, str):
        text = result.strip()
        return text or None
    if not isinstance(result, dict):
        return None

    data = result.get("data")
    if isinstance(data, str):
        text = data.strip()
        return text or None
    if isinstance(data, dict):
        for key in ("text", "message", "output", "result"):
            val = data.get(key)
            if isinstance(val, str) and val.strip():
                return val.strip()

    for key in ("output", "text", "result"):
        val = result.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    return None


async def apply_ai_rewrite(
    hass: HomeAssistant,
    tts_config: dict[str, Any],
    message: str,
    *,
    request_id: str | None = None,
    alert_kind: str = "",
) -> str:
    """Rewrite a TTS message via ai_task when enabled; return original on skip/failure."""
    use_ai = tts_config.get("use_ai_rewrite", False)
    ai_entity = (tts_config.get("ai_task_entity") or "").strip()
    ai_prompt = tts_config.get("ai_rewrite_prompt", "")

    if not use_ai:
        return message
    if not ai_entity:
        _LOGGER.warning(
            "AI rewrite enabled but no ai_task_entity configured, using original message"
        )
        return message

    try:
        result = await asyncio.wait_for(
            hass.services.async_call(
                "ai_task",
                "generate_data",
                {
                    "entity_id": ai_entity,
                    "task_name": "home_weather_tts_rewrite",
                    "instructions": _build_ai_rewrite_instructions(ai_prompt, message),
                },
                blocking=True,
                return_response=True,
            ),
            timeout=30.0,
        )
        rewritten = _extract_ai_task_text(result)
        if rewritten:
            preview = rewritten[:80] + ("..." if len(rewritten) > 80 else "")
            _LOGGER.info("AI rewrote TTS message: %s", preview)
            _fire_tts_status(
                hass, "ai_rewrite",
                request_id=request_id,
                message_preview=rewritten,
                alert_kind=alert_kind,
            )
            return rewritten
        _LOGGER.warning(
            "AI rewrite returned no usable text, using original message"
        )
    except asyncio.TimeoutError:
        _LOGGER.warning("AI rewrite timed out, using original message")
    except Exception as exc:
        _LOGGER.warning("AI rewrite failed, using original message: %s", exc)

    return message


async def dispatch_tts(
    hass: HomeAssistant,
    media_players_config: list[dict[str, Any]],
    tts_config: dict[str, Any],
    message: str,
    volume_override: float | None = None,
    *,
    request_id: str | None = None,
    alert_kind: str = "",
) -> None:
    """Apply optional AI rewrite, then send TTS to configured media players."""
    final_message = await apply_ai_rewrite(
        hass, tts_config, message,
        request_id=request_id, alert_kind=alert_kind,
    )
    await send_tts(
        hass, media_players_config, final_message, volume_override,
        request_id=request_id, alert_kind=alert_kind,
    )


async def send_tts_with_ai_rewrite(
    hass: HomeAssistant,
    media_players_config: list[dict[str, Any]],
    tts_config: dict[str, Any],
    message: str,
    volume_override: float | None = None,
    *,
    request_id: str | None = None,
    alert_kind: str = "",
) -> None:
    """Send TTS with optional AI rewrite of the message."""
    await dispatch_tts(
        hass, media_players_config, tts_config, message, volume_override,
        request_id=request_id, alert_kind=alert_kind,
    )


def format_nws_alert_description(raw: str) -> str:
    """Convert NWS bullet-style descriptions into readable prose."""
    if not raw or not raw.strip():
        return ""

    text = raw.strip()
    sections: list[str] = []

    for chunk in re.split(r"\n\s*\*\s*", "\n" + text):
        chunk = chunk.strip()
        if not chunk:
            continue
        if "..." in chunk:
            head, _, tail = chunk.partition("...")
            label = head.strip().rstrip(".").title()
            body = " ".join(tail.split())
            if label and body:
                sentence = body if body.endswith(".") else f"{body}."
                sections.append(f"{label}: {sentence}")
            elif body:
                sections.append(body if body.endswith(".") else f"{body}.")
        else:
            clean = re.sub(r"\*+\s*", "", chunk)
            clean = " ".join(clean.split())
            if clean:
                sections.append(clean if clean.endswith(".") else f"{clean}.")

    if sections:
        return " ".join(sections)

    fallback = re.sub(r"\*+\s*", "", text).replace("...", ". ")
    return " ".join(fallback.split())


def format_nws_alert_for_tts(
    alert_properties: dict[str, Any],
    *,
    max_length: int = 800,
) -> str:
    """Build a spoken NWS alert message without bullet markers or ellipses."""
    event = (alert_properties.get("event") or "Weather Alert").strip()
    desc = format_nws_alert_description(alert_properties.get("description") or "")
    if desc:
        msg = f"National Weather Service {event}. {desc}"
    else:
        msg = f"National Weather Service {event}."
    if len(msg) <= max_length:
        return msg
    trimmed = msg[: max_length - 1].rsplit(".", 1)[0]
    return f"{trimmed}." if trimmed else msg[:max_length]


def _get_hass_base_url(hass: HomeAssistant) -> str:
    """Resolve a URL media players can reach for /local/ assets."""
    try:
        return get_url(
            hass,
            prefer_external=False,
            allow_internal=True,
            allow_external=True,
        ).rstrip("/")
    except Exception:
        pass
    try:
        for candidate in (
            hass.config.internal_url,
            hass.config.external_url,
            hass.config.api.base_url,
        ):
            if candidate:
                return str(candidate).rstrip("/")
    except Exception:
        pass
    return ""


async def _wait_for_media_player_idle(
    hass: HomeAssistant,
    entity_id: str,
    *,
    timeout: float = 120.0,
    poll_interval: float = 0.5,
) -> bool:
    """Wait until a media player finishes playing alert audio."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    await asyncio.sleep(0.3)

    while loop.time() < deadline:
        state = hass.states.get(entity_id)
        if state is None:
            return False
        if state.state not in ("playing", "buffering"):
            return True
        await asyncio.sleep(poll_interval)

    _LOGGER.warning("Timed out waiting for %s to finish playback", entity_id)
    return False


async def play_nws_alert_notification(
    hass: HomeAssistant,
    config: dict[str, Any],
    alert_properties: dict[str, Any],
    media_players_config: list[dict[str, Any]],
    *,
    request_id: str | None = None,
) -> None:
    """Play siren sound (if configured) then TTS for an NWS weather alert."""
    nws = config.get("nws_alerts", {})
    sound_file = (nws.get("sound_file") or "").strip()
    sound_vol = max(0, min(1, float(nws.get("sound_volume", 0.8))))
    tts_vol = max(0, min(1, float(nws.get("tts_volume", 0.9))))
    msg = format_nws_alert_for_tts(alert_properties)
    tts_config = config.get("tts", {})
    msg = await apply_ai_rewrite(
        hass, tts_config, msg,
        request_id=request_id, alert_kind="nws_alert",
    )
    if not media_players_config:
        _fire_tts_status(
            hass, "skipped",
            request_id=request_id, reason="No media players configured",
            alert_kind="nws_alert",
        )
        return

    base_url = _get_hass_base_url(hass)
    if sound_file and not base_url:
        _LOGGER.warning(
            "NWS alert sound configured but no Home Assistant URL is available"
        )

    for mp in media_players_config:
        eid = mp.get("entity_id")
        if not eid:
            continue
        try:
            await hass.services.async_call(
                "media_player", "volume_set",
                {"entity_id": eid, "volume_level": sound_vol},
                blocking=True,
            )
            if sound_file and base_url:
                sound_url = (
                    f"{base_url}/local/home_weather/sounds/{quote(sound_file)}"
                )
                _LOGGER.debug("Playing NWS alert sound on %s: %s", eid, sound_url)
                await hass.services.async_call(
                    "media_player", "play_media",
                    {
                        "entity_id": eid,
                        "media_content_type": "music",
                        "media_content_id": sound_url,
                    },
                    blocking=True,
                )
                await _wait_for_media_player_idle(hass, eid)

            await hass.services.async_call(
                "media_player", "volume_set",
                {"entity_id": eid, "volume_level": tts_vol},
                blocking=True,
            )
            await send_tts(
                hass, [mp], msg, volume_override=tts_vol,
                request_id=request_id, alert_kind="nws_alert",
            )
        except Exception as exc:
            _LOGGER.warning("NWS alert playback failed for %s: %s", eid, exc)
            _fire_tts_status(
                hass, "failed",
                request_id=request_id, entity_id=eid,
                reason=str(exc), alert_kind="nws_alert",
            )
