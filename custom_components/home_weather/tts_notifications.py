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
from pathlib import Path
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.components.media_player.browse_media import (
    async_process_play_media_url,
)
try:  # MediaPlayerEntityFeature moved around across HA versions; degrade gracefully.
    from homeassistant.components.media_player.const import MediaPlayerEntityFeature

    _VOLUME_SET_FEATURE = int(MediaPlayerEntityFeature.VOLUME_SET)
except Exception:  # pragma: no cover - defensive fallback
    _VOLUME_SET_FEATURE = 4  # SUPPORT_VOLUME_SET bit
from homeassistant.util import dt as dt_util

from .condition_labels import (
    condition_outlook_phrase,
    is_precipitation_active,
    normalize_weather_condition,
    precip_already_matches_upcoming,
)
from .const import CHIME_TTS_DOMAIN, NUMBER_WORDS, NWS_SOUNDS_SUBPATH
from .sounds_setup import (
    build_nws_local_media_id,
    normalize_nws_sound_filename,
    resolve_nws_playable_sound,
)
from .zodiac_data import build_zodiac_forecast_section

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
    """Return a natural spoken noun phrase for a weather condition.

    Produces grammatical forecast sentences for every condition type, e.g.
    "expect clear skies", "with sunshine", "looks like a wintry mix of rain
    and snow" — rather than the bare UI label ("clear night", "sunny").
    """
    return condition_outlook_phrase(condition)


def _spoken(text: str | None) -> str:
    """Clean raw text for natural spoken TTS output.
    
    - Trims whitespace
    - Replaces underscores, hyphens, and camelCase slugs with spaces
    - Collapses multiple whitespace
    - Applies sentence case (first char uppercase, rest lowercase)
    - Expands common abbreviations
    """
    if not text:
        return ""
    
    import re
    
    s = str(text).strip()
    
    # Convert camelCase/PascalCase to spaces
    s = re.sub(r"([a-z])([A-Z])", r"\1 \2", s)
    
    # Replace underscores and hyphens with spaces
    s = s.replace("_", " ").replace("-", " ")
    
    # Collapse multiple whitespace
    s = re.sub(r"\s+", " ", s).strip()
    
    # Sentence case: first letter uppercase, rest lowercase
    # (preserve all-uppercase abbreviations by checking if entire word is uppercase)
    words = s.split()
    result = []
    for i, word in enumerate(words):
        if word.isupper() and len(word) > 1:
            # Preserve abbreviations like "NWS", "EPA", etc.
            result.append(word)
        elif i == 0:
            result.append(word.capitalize())
        else:
            result.append(word.lower())
    
    return " ".join(result)


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


def _get_upcoming_precipitation(
    hourly: list[dict],
    threshold: int = 30,
    current: dict[str, Any] | None = None,
) -> list[dict]:
    """Find upcoming precipitation events in the next 12 hours (future only)."""
    if is_precipitation_active(current):
        return []

    now = dt_util.now()
    upcoming = []
    current_slug = normalize_weather_condition(
        (current or {}).get("condition") or (current or {}).get("state") or ""
    )

    for h in hourly[:12]:
        h_time = _parse_datetime(h.get("datetime"))
        if h_time is None or h_time <= now:
            continue

        precip_prob = h.get("precipitation_probability", 0) or 0
        if precip_prob < threshold:
            continue

        hour_slug = normalize_weather_condition(h.get("condition") or "")
        precip_kind = h.get("precipitation_kind") or h.get("condition")

        if precip_already_matches_upcoming(current_slug, hour_slug, precip_kind):
            continue

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
    upcoming_precip = _get_upcoming_precipitation(hourly, precip_threshold, current)
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

    zodiac_section = build_zodiac_forecast_section(tts_config)
    if zodiac_section:
        parts.append(zodiac_section)
    
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
        parts.append(f"Currently {_format_temperature(temp)} with {condition}.")
    
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
    upcoming_precip = _get_upcoming_precipitation(hourly, precip_threshold, current)
    if upcoming_precip:
        first = upcoming_precip[0]
        time_desc = _get_time_description(first["time"])
        cond = _normalize_condition(first["condition"])
        parts.append(f"Expect {cond} {time_desc}.")
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
            f"Conditions have shifted from {old_cond} to {new_cond}, "
            f"and it's currently {_format_temperature(temp)}."
        )
    else:
        return (
            f"{greeting_time}, weather alert. "
            f"Conditions have shifted from {old_cond} to {new_cond}."
        )


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
        f"Expect {kind} {time_phrase} "
        f"with a {_format_percentage(probability)} chance."
    )


# ============================================================================
# Media player volume: capture / apply / restore
# ============================================================================

def _clamp_volume(value: float) -> float:
    """Clamp a volume level into the 0.0 - 1.0 range."""
    try:
        return max(0.0, min(1.0, float(value)))
    except (TypeError, ValueError):
        return 0.6


def _supports_volume_set(hass: HomeAssistant, entity_id: str) -> bool:
    """Return True if the media player advertises the volume_set feature.

    Players that don't report ``supported_features`` are assumed to support it
    (the volume_set call is a no-op harmless for those that truly don't).
    """
    state = hass.states.get(entity_id)
    if state is None:
        return False
    features = state.attributes.get("supported_features")
    if features is None:
        return True
    try:
        return bool(int(features) & _VOLUME_SET_FEATURE)
    except (TypeError, ValueError):
        return True


def _current_volume_level(hass: HomeAssistant, entity_id: str) -> float | None:
    """Return the player's current volume_level, or None if not reported."""
    state = hass.states.get(entity_id)
    if state is None:
        return None
    level = state.attributes.get("volume_level")
    if level is None:
        return None
    try:
        return float(level)
    except (TypeError, ValueError):
        return None


async def apply_announcement_volume(
    hass: HomeAssistant, entity_id: str, volume: float
) -> float | None:
    """Set a media player to the announcement volume, returning the prior level.

    Captures the current ``volume_level`` first so the caller can restore it
    once the announcement finishes. Returns ``None`` when the player doesn't
    report/support volume, in which case no volume change is attempted and there
    is nothing to restore.
    """
    if not entity_id or not _supports_volume_set(hass, entity_id):
        return None
    previous = _current_volume_level(hass, entity_id)
    target = _clamp_volume(volume)
    try:
        await hass.services.async_call(
            "media_player",
            "volume_set",
            {"entity_id": entity_id, "volume_level": target},
            blocking=True,
        )
    except Exception as exc:  # noqa: BLE001 - best effort volume control
        _LOGGER.warning("Failed to set announcement volume on %s: %s", entity_id, exc)
        return None
    return previous


async def restore_volume_when_idle(
    hass: HomeAssistant,
    entity_id: str,
    previous_volume: float | None,
    *,
    wait_for_start: bool = True,
) -> None:
    """Wait for playback to finish on ``entity_id`` then restore its volume.

    Safe to schedule as a background task. Does nothing when there is no
    captured previous volume (player didn't report one before the announcement).
    """
    if previous_volume is None or not entity_id:
        return
    try:
        await _wait_for_media_player_idle(
            hass, entity_id, wait_for_start=wait_for_start
        )
        await hass.services.async_call(
            "media_player",
            "volume_set",
            {"entity_id": entity_id, "volume_level": _clamp_volume(previous_volume)},
            blocking=False,
        )
        _LOGGER.debug(
            "Restored volume on %s to %.2f after announcement",
            entity_id, previous_volume,
        )
    except Exception as exc:  # noqa: BLE001 - best effort restore
        _LOGGER.warning("Failed to restore volume on %s: %s", entity_id, exc)


def _schedule_volume_restore(
    hass: HomeAssistant, entity_id: str, previous_volume: float | None
) -> None:
    """Fire-and-forget background restore of a player's pre-announcement volume."""
    if previous_volume is None or not entity_id:
        return
    hass.async_create_task(
        restore_volume_when_idle(hass, entity_id, previous_volume)
    )


# ============================================================================
# Per-announcement player resolution
# ============================================================================


def resolve_announcement_players(
    config: dict[str, Any],
    type_id: str,
    media_players: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Resolve media players for a specific announcement type with per-player settings.
    
    Returns a list of media player configs with:
    - Bypassed players removed
    - Each player's volume set from announcement_players[type_id][entity_id].volume
      (falls back to the player's default volume if no override)
    
    Type IDs include hazard alert keys (nws_alerts, tropical_alerts, etc.) and
    weather types (current_change, upcoming_change, scheduled_forecast, sun_alerts).
    """
    announcement_players = config.get("announcement_players") or {}
    type_overrides = announcement_players.get(type_id) or {}
    
    resolved: list[dict[str, Any]] = []
    for mp in media_players:
        entity_id = mp.get("entity_id")
        if not entity_id:
            continue
        if not mp.get("tts_entity_id"):
            continue
        
        override = type_overrides.get(entity_id) or {}
        
        # Skip bypassed players
        if override.get("bypass", False):
            continue
        
        # Copy player config and apply volume override
        player_copy = dict(mp)
        if "volume" in override:
            player_copy["volume"] = max(0, min(1, float(override["volume"])))
        
        resolved.append(player_copy)
    
    return resolved


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
        # Cache defaults to True: AirPlay/Apple TV/HomePod players (pyatv) fetch
        # the /api/tts_proxy/ URL with a hardcoded 10s timeout and make repeated
        # requests. With cache disabled the audio is generated lazily during that
        # fetch, so anything but a very short message times out ("Connection to
        # <ha-ip>:8123 timed out"). Caching pre-generates the file so the fetch
        # is a fast static serve.
        cache = mp.get("cache", True)
        language = mp.get("language", "")
        options = mp.get("options", {})
        
        _LOGGER.info("Sending TTS to %s via %s", entity_id, tts_entity)

        previous_volume: float | None = None
        try:
            # Step 1: Capture the player's current volume, then set the
            # configured announcement volume (blocking so it applies before the
            # TTS starts). The previous level is restored once playback ends.
            previous_volume = await apply_announcement_volume(hass, entity_id, volume)

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

            # Step 4: Restore the pre-announcement volume once playback ends.
            # Runs in the background so multiple players are not serialized on
            # each other's playback duration.
            _schedule_volume_restore(hass, entity_id, previous_volume)

            # Delay between players
            if i < len(media_players_config) - 1:
                await asyncio.sleep(0.5)
            
        except Exception as e:
            _LOGGER.error("Error sending TTS to %s: %s", entity_id, e, exc_info=True)
            # Best-effort: if we changed the volume before failing, put it back.
            if previous_volume is not None:
                _schedule_volume_restore(hass, entity_id, previous_volume)
            _fire_tts_status(
                hass, "failed",
                request_id=request_id, entity_id=entity_id,
                reason=str(e), alert_kind=alert_kind,
            )


def is_chime_tts_available(hass: HomeAssistant) -> bool:
    """Check if Chime TTS integration is installed and loaded."""
    return CHIME_TTS_DOMAIN in hass.config.components


def _extract_tts_platform_from_entity(tts_entity_id: str) -> str:
    """Extract TTS platform name from entity ID for Chime TTS.

    Chime TTS expects just the platform name (e.g., "google_translate")
    not the full entity ID. The tts_entity_id is typically like
    "tts.google_translate_say" or "tts.piper".
    """
    if not tts_entity_id:
        return ""
    if tts_entity_id.startswith("tts."):
        platform = tts_entity_id[4:]
        if platform.endswith("_say"):
            platform = platform[:-4]
        return platform
    return tts_entity_id


async def dispatch_chime_tts(
    hass: HomeAssistant,
    media_player_entity_id: str,
    tts_entity_id: str,
    message: str,
    chime_path: str,
    *,
    volume: float = 0.8,
    request_id: str | None = None,
    alert_kind: str = "",
) -> bool:
    """Use chime_tts.say for seamless siren + TTS playback.

    Automatically used when Chime TTS is installed. Files are not cached
    (deleted after playing) to avoid storage buildup.

    Returns True if Chime TTS handled the playback, False if it's not
    available and the caller should fall back to the legacy method.
    """
    if not is_chime_tts_available(hass):
        _LOGGER.debug("Chime TTS not available, falling back to legacy method")
        return False

    if not media_player_entity_id or not message:
        return False

    tts_platform = _extract_tts_platform_from_entity(tts_entity_id)
    if not tts_platform:
        _LOGGER.warning(
            "Could not extract TTS platform from %s for Chime TTS", tts_entity_id
        )
        return False

    try:
        _LOGGER.info(
            "Using Chime TTS for %s: chime=%s, platform=%s",
            media_player_entity_id, chime_path, tts_platform,
        )

        service_data: dict[str, Any] = {
            "entity_id": media_player_entity_id,
            "message": message,
            "tts_platform": tts_platform,
            "volume_level": volume,
            "cache": False,  # Don't cache - delete after playing
        }

        if chime_path:
            service_data["chime_path"] = chime_path

        await hass.services.async_call(
            CHIME_TTS_DOMAIN,
            "say",
            service_data,
            blocking=True,
        )

        _LOGGER.info("Chime TTS playback completed for %s", media_player_entity_id)
        _fire_tts_status(
            hass, "sent",
            request_id=request_id,
            entity_id=media_player_entity_id,
            message_preview=message,
            alert_kind=alert_kind,
        )
        return True

    except Exception as exc:
        _LOGGER.error(
            "Chime TTS failed for %s: %s", media_player_entity_id, exc, exc_info=True
        )
        _fire_tts_status(
            hass, "failed",
            request_id=request_id,
            entity_id=media_player_entity_id,
            reason=f"Chime TTS error: {exc}",
            alert_kind=alert_kind,
        )
        return False


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
    config: dict[str, Any] | None = None,
    type_id: str | None = None,
) -> None:
    """Apply optional AI rewrite, then send TTS to configured media players.
    
    When config and type_id are provided, resolves per-player volumes and
    filters out bypassed players via resolve_announcement_players.
    """
    final_message = await apply_ai_rewrite(
        hass, tts_config, message,
        request_id=request_id, alert_kind=alert_kind,
    )
    
    # Resolve per-player volumes if config/type_id provided
    players = media_players_config
    if config is not None and type_id:
        players = resolve_announcement_players(config, type_id, media_players_config)
        if not players:
            _fire_tts_status(
                hass, "skipped",
                request_id=request_id,
                reason=f"All players bypassed for {type_id}",
                alert_kind=alert_kind,
            )
            return
        # Per-player volumes are set in resolved list; don't override
        volume_override = None
    
    await send_tts(
        hass, players, final_message, volume_override,
        request_id=request_id, alert_kind=alert_kind,
    )


def media_player_entity_ids(media_players_config: list[dict[str, Any]]) -> list[str]:
    """Return configured media player entity IDs in order."""
    return [eid for mp in media_players_config if (eid := mp.get("entity_id"))]


async def dispatch_tts_and_wait(
    hass: HomeAssistant,
    media_players_config: list[dict[str, Any]],
    tts_config: dict[str, Any],
    message: str,
    volume_override: float | None = None,
    *,
    request_id: str | None = None,
    alert_kind: str = "",
    config: dict[str, Any] | None = None,
    type_id: str | None = None,
) -> None:
    """Send TTS and wait for playback to finish on all target speakers.
    
    When config and type_id are provided, resolves per-player volumes and
    filters out bypassed players via resolve_announcement_players.
    """
    # When resolving, use resolved list for both dispatch and waiting
    players = media_players_config
    if config is not None and type_id:
        players = resolve_announcement_players(config, type_id, media_players_config)

    await dispatch_tts(
        hass,
        players,
        tts_config,
        message,
        volume_override,
        request_id=request_id,
        alert_kind=alert_kind,
        config=config,
        type_id=type_id,
    )
    await wait_for_media_players_after_tts(
        hass, media_player_entity_ids(players),
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


def _is_nws_preamble(text: str) -> bool:
    """Return True for VTEC lead-in blocks that are not useful alert content."""
    s = text.strip()
    if not s:
        return True
    if re.match(r"^[A-Z0-9]{4,8}\s", s):
        return True
    if re.search(r"\bhas issued an?\s*$", s, re.IGNORECASE):
        return True
    if (
        re.search(r"National Weather Service", s, re.IGNORECASE)
        and len(s) < 120
        and not re.search(r"\b(at|until|hazard|warning for)\b", s, re.IGNORECASE)
    ):
        return True
    return False


def parse_nws_alert_description(raw: str) -> dict[str, str | None]:
    """Parse NWS bullet-style descriptions into structured fields."""
    result: dict[str, str | None] = {
        "what": None,
        "where": None,
        "when": None,
        "impacts": None,
        "additional": None,
    }
    known_keys = frozenset(
        {"what", "where", "when", "impacts", "additional", "additional details", "hazard", "source"}
    )
    other: list[str] = []

    def assign_field(key: str, body: str) -> None:
        if key == "what":
            result["what"] = body
        elif key == "where":
            result["where"] = body
        elif key == "when":
            result["when"] = body
        elif key in ("impacts", "hazard"):
            prev = result.get("impacts")
            result["impacts"] = f"{prev} {body}".strip() if prev else body
        elif key in ("additional", "additional details"):
            result["additional"] = body
        else:
            other.append(body)

    def push_bullet(body: str) -> None:
        if not body or body == "&&" or _is_nws_preamble(body):
            return
        if not result["what"]:
            result["what"] = body
        else:
            other.append(body)

    def process_line(line: str) -> None:
        trimmed = line.strip()
        if not trimmed or trimmed == "&&":
            return
        if "..." in trimmed:
            head, _, tail = trimmed.partition("...")
            key = head.strip().rstrip(".").lower()
            body = " ".join(tail.split())
            if key in known_keys and body:
                assign_field(key, body)
                return
        clean = re.sub(r"\*+\s*", "", trimmed)
        clean = " ".join(clean.split())
        push_bullet(clean)

    if not raw or not raw.strip():
        return result

    text = re.sub(r"\s*&&\s*$", "", raw.strip())
    for chunk in re.split(r"\n\s*\*\s*", "\n" + text):
        chunk = chunk.strip()
        if not chunk or chunk == "&&" or _is_nws_preamble(chunk):
            continue
        for line in chunk.splitlines():
            process_line(line)

    if result["what"] and _is_nws_preamble(result["what"]):
        result["what"] = None

    if not any(result.values()) and not other:
        fallback = re.sub(r"\*+\s*", "", text).replace("...", ". ")
        fallback = " ".join(fallback.split())
        if fallback and not _is_nws_preamble(fallback):
            result["what"] = fallback

    if other:
        extra = " ".join(other)
        result["additional"] = (
            f"{result['additional']} {extra}".strip()
            if result.get("additional")
            else extra
        ) or None

    return result


def _nws_sentence(text: str) -> str:
    """Ensure text ends with a period for TTS pacing."""
    text = text.strip()
    if not text:
        return ""
    return text if text.endswith(".") else f"{text}."


def _nws_spoken_where(where: str) -> str:
    where = where.strip()
    if not where:
        return ""
    lower = where.lower()
    if lower.startswith(("the ", "portions of ", "areas of ")):
        return _nws_sentence(f"This affects {where}")
    return _nws_sentence(f"Affecting {where}")


def _nws_spoken_when(when: str) -> str:
    when = when.strip()
    if not when:
        return ""
    lower = when.lower()
    if lower.startswith(("from ", "through ", "until ", "between ")):
        return _nws_sentence(f"In effect {when}")
    return _nws_sentence(when)


def format_nws_alert_description(raw: str) -> str:
    """Convert NWS bullet-style descriptions into readable prose (legacy flat string)."""
    parsed = parse_nws_alert_description(raw)
    parts: list[str] = []
    for key in ("what", "where", "when", "impacts", "additional"):
        value = parsed.get(key)
        if value:
            parts.append(_nws_sentence(value))
    return " ".join(parts)


def format_nws_alert_for_tts(
    alert_properties: dict[str, Any],
    *,
    max_length: int = 800,
) -> str:
    """Build a naturally spoken NWS alert message without What/Where/When labels."""
    event = (alert_properties.get("event") or "Weather Alert").strip()
    parsed = parse_nws_alert_description(alert_properties.get("description") or "")
    spoken: list[str] = [f"National Weather Service {event}."]

    if parsed.get("what"):
        spoken.append(_nws_sentence(parsed["what"]))
    if parsed.get("where"):
        spoken.append(_nws_spoken_where(parsed["where"]))
    if parsed.get("when"):
        spoken.append(_nws_spoken_when(parsed["when"]))
    if parsed.get("impacts") and parsed["impacts"] != parsed.get("what"):
        spoken.append(_nws_sentence(parsed["impacts"]))
    if parsed.get("additional"):
        spoken.append(_nws_sentence(parsed["additional"]))

    msg = " ".join(spoken)
    if len(msg) <= max_length:
        return msg
    trimmed = msg[: max_length - 1].rsplit(".", 1)[0]
    return f"{trimmed}." if trimmed else msg[:max_length]


def format_active_nws_alerts_for_tts(
    alerts: list[dict[str, Any]],
    *,
    max_length: int = 800,
) -> str:
    """Build one combined spoken summary for multiple active NWS alerts."""
    if not alerts:
        return ""
    if len(alerts) == 1:
        return format_nws_alert_for_tts(alerts[0], max_length=max_length)

    count = len(alerts)
    noun = "alert" if count == 1 else "alerts"
    parts: list[str] = [f"You have {count} active weather {noun}."]
    for alert in alerts:
        event = (alert.get("event") or "Weather Alert").strip()
        parsed = parse_nws_alert_description(alert.get("description") or "")
        summary = (parsed.get("what") or parsed.get("impacts") or event).strip().rstrip(".")
        parts.append(_nws_sentence(f"{event}: {summary}"))

    msg = " ".join(parts)
    if len(msg) <= max_length:
        return msg
    trimmed = msg[: max_length - 1].rsplit(".", 1)[0]
    return f"{trimmed}." if trimmed else msg[:max_length]


def nws_local_playback(hass: HomeAssistant, media_path: Path) -> tuple[str, str]:
    """Return absolute playback URL and media type for an NWS siren file."""
    media_id = build_nws_local_media_id(media_path.name)
    try:
        play_url = async_process_play_media_url(hass, media_id)
    except Exception as err:  # NoURLAvailableError, etc.
        _LOGGER.warning("Falling back to relative siren URL: %s", err)
        play_url = media_id
    return play_url, "music"


async def play_nws_siren(
    hass: HomeAssistant,
    config: dict[str, Any],
    media_players_config: list[dict[str, Any]],
    *,
    request_id: str | None = None,
) -> None:
    """Play the configured NWS siren on all media players via /local/ www path.
    
    Uses per-player volume from media_players_config (resolved via
    resolve_announcement_players) rather than global sound_volume.
    """
    nws = config.get("nws_alerts", {})
    sound_file_raw = nws.get("sound_file") or ""
    if not normalize_nws_sound_filename(sound_file_raw) or not media_players_config:
        return

    media_path = await hass.async_add_executor_job(
        resolve_nws_playable_sound, hass, sound_file_raw
    )
    if not media_path:
        reason = f"Sound file not found in config/www/{NWS_SOUNDS_SUBPATH}/"
        _LOGGER.warning("NWS siren file missing: %s", normalize_nws_sound_filename(sound_file_raw))
        _fire_tts_status(
            hass,
            "failed",
            request_id=request_id,
            reason=reason,
            alert_kind="nws_siren",
        )
        return

    media_id, media_type = nws_local_playback(hass, media_path)
    # Fallback to legacy global sound_volume only if per-player volume not set
    default_vol = max(0, min(1, float(nws.get("sound_volume", 0.8))))

    for mp in media_players_config:
        eid = mp.get("entity_id")
        if not eid:
            continue
        # Use per-player volume (already set by resolve_announcement_players)
        vol = mp.get("volume", default_vol)
        try:
            await hass.services.async_call(
                "media_player",
                "volume_set",
                {"entity_id": eid, "volume_level": vol},
                blocking=True,
            )
            _LOGGER.debug("Playing NWS siren on %s: %s", eid, media_id)
            await hass.services.async_call(
                "media_player",
                "play_media",
                {
                    "entity_id": eid,
                    "media_content_id": media_id,
                    "media_content_type": media_type,
                },
                blocking=True,
            )
            await _wait_for_media_player_idle(hass, eid, wait_for_start=True)
        except Exception as exc:
            _LOGGER.warning("NWS siren playback failed for %s: %s", eid, exc)
            _fire_tts_status(
                hass,
                "failed",
                request_id=request_id,
                entity_id=eid,
                reason=str(exc),
                alert_kind="nws_siren",
            )


async def replay_active_nws_alerts(
    hass: HomeAssistant,
    config: dict[str, Any],
    media_players_config: list[dict[str, Any]],
    alerts: list[dict[str, Any]],
    *,
    request_id: str | None = None,
) -> None:
    """Replay active alerts: siren once, then combined TTS summary.

    Uses per-player volumes from announcement_players config. When
    use_chime_tts is enabled and Chime TTS is installed, combines the
    siren audio and TTS into a single seamless playback.
    """
    nws = config.get("nws_alerts", {})
    if not nws.get("enabled") or not alerts or not media_players_config:
        return
    if not nws.get("replay_on_time_based_forecast", True):
        return

    msg = format_active_nws_alerts_for_tts(alerts)
    tts_config = config.get("tts", {})
    msg = await apply_ai_rewrite(
        hass,
        tts_config,
        msg,
        request_id=request_id,
        alert_kind="nws_alert_replay",
    )
    if not msg.strip():
        return

    # Fallback volume for legacy configs
    default_vol = max(0, min(1, float(nws.get("tts_volume", 0.9))))
    
    # Resolve per-player volumes and remove bypassed players
    resolved_players = resolve_announcement_players(config, "nws_alerts", media_players_config)
    if not resolved_players:
        return

    sound_file_raw = nws.get("sound_file") or ""

    # Auto-use Chime TTS when available for seamless siren + TTS playback
    if sound_file_raw and is_chime_tts_available(hass):
        chime_path = build_nws_local_media_id(normalize_nws_sound_filename(sound_file_raw))

        for mp in resolved_players:
            eid = mp.get("entity_id")
            tts_entity = mp.get("tts_entity_id")
            if not eid or not tts_entity:
                continue

            vol = mp.get("volume", default_vol)
            success = await dispatch_chime_tts(
                hass,
                eid,
                tts_entity,
                msg,
                chime_path,
                volume=vol,
                request_id=request_id,
                alert_kind="nws_alert_replay",
            )
            if not success:
                _LOGGER.warning(
                    "Chime TTS failed for %s in replay, using legacy method", eid
                )
                await _legacy_nws_replay_single_player(
                    hass, config, mp, msg, vol, request_id=request_id,
                )

        _LOGGER.info("Chime TTS NWS replay completed")
        return

    await play_nws_siren(hass, config, resolved_players, request_id=request_id)

    for mp in resolved_players:
        eid = mp.get("entity_id")
        if not eid:
            continue
        vol = mp.get("volume", default_vol)
        try:
            await hass.services.async_call(
                "media_player",
                "volume_set",
                {"entity_id": eid, "volume_level": vol},
                blocking=True,
            )
        except Exception as exc:
            _LOGGER.warning("NWS replay volume_set failed for %s: %s", eid, exc)

    await send_tts(
        hass,
        resolved_players,
        msg,
        volume_override=None,
        request_id=request_id,
        alert_kind="nws_alert_replay",
    )
    await wait_for_media_players_after_tts(
        hass, media_player_entity_ids(resolved_players),
    )


async def _legacy_nws_replay_single_player(
    hass: HomeAssistant,
    config: dict[str, Any],
    mp: dict[str, Any],
    message: str,
    tts_vol: float,
    *,
    request_id: str | None = None,
) -> None:
    """Fallback for a single player when Chime TTS fails for NWS replay."""
    eid = mp.get("entity_id")
    if not eid:
        return

    await play_nws_siren(hass, config, [mp], request_id=request_id)

    try:
        await hass.services.async_call(
            "media_player", "volume_set",
            {"entity_id": eid, "volume_level": tts_vol},
            blocking=True,
        )
    except Exception as exc:
        _LOGGER.warning("NWS replay volume_set failed for %s: %s", eid, exc)

    await send_tts(
        hass, [mp], message, volume_override=tts_vol,
        request_id=request_id, alert_kind="nws_alert_replay",
    )
    await wait_for_media_players_after_tts(hass, [eid])



async def _wait_for_media_player_idle(
    hass: HomeAssistant,
    entity_id: str,
    *,
    timeout: float = 120.0,
    poll_interval: float = 0.5,
    wait_for_start: bool = False,
    start_timeout: float = 10.0,
) -> bool:
    """Wait until a media player finishes playing alert audio.

    ``media_player.play_media`` returns as soon as the command is dispatched to
    the device (even with ``blocking=True``), so the player state is frequently
    still ``idle``/``paused`` immediately afterwards. When ``wait_for_start`` is
    set, first wait (up to ``start_timeout``) for playback to actually begin
    before waiting for it to finish. Without this, a following TTS announcement
    is fired while the siren is only just starting, and the siren drops the TTS.
    """
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    await asyncio.sleep(0.3)

    if wait_for_start:
        start_deadline = min(deadline, loop.time() + start_timeout)
        while loop.time() < start_deadline:
            state = hass.states.get(entity_id)
            if state is None:
                return False
            if state.state in ("playing", "buffering"):
                break
            await asyncio.sleep(poll_interval)
        else:
            # Playback never observed to start; nothing to wait for.
            return True

    while loop.time() < deadline:
        state = hass.states.get(entity_id)
        if state is None:
            return False
        if state.state not in ("playing", "buffering"):
            return True
        await asyncio.sleep(poll_interval)

    _LOGGER.warning("Timed out waiting for %s to finish playback", entity_id)
    return False


async def wait_for_media_players_after_tts(
    hass: HomeAssistant,
    entity_ids: list[str],
    *,
    timeout: float = 180.0,
    start_timeout: float = 45.0,
    poll_interval: float = 0.5,
) -> None:
    """Wait for non-blocking TTS playback to finish on each media player.

    ``send_tts`` uses ``blocking=False``, so callers must wait for playback
    before starting another announcement on the same speaker.
    """
    unique_ids = [eid for eid in dict.fromkeys(entity_ids) if eid]
    if not unique_ids:
        return

    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout

    for entity_id in unique_ids:
        remaining = max(0.0, deadline - loop.time())
        if remaining <= 0:
            _LOGGER.warning("Timed out before waiting for %s TTS playback", entity_id)
            return

        start_deadline = min(deadline, loop.time() + start_timeout)
        started = False
        while loop.time() < start_deadline:
            state = hass.states.get(entity_id)
            if state and state.state in ("playing", "buffering"):
                started = True
                break
            await asyncio.sleep(poll_interval)

        if not started:
            # TTS may have finished instantly or never started; nothing to wait for.
            continue

        remaining = max(0.0, deadline - loop.time())
        if remaining <= 0:
            _LOGGER.warning("Timed out waiting for %s TTS playback to finish", entity_id)
            return
        await _wait_for_media_player_idle(
            hass,
            entity_id,
            timeout=remaining,
            poll_interval=poll_interval,
        )


async def play_nws_alert_notification(
    hass: HomeAssistant,
    config: dict[str, Any],
    alert_properties: dict[str, Any],
    media_players_config: list[dict[str, Any]],
    *,
    request_id: str | None = None,
) -> None:
    """Play siren sound (if configured) then TTS for an NWS weather alert.

    Uses per-player volumes from announcement_players config. When
    use_chime_tts is enabled and Chime TTS is installed, combines the
    siren audio and TTS into a single seamless playback.
    """
    nws = config.get("nws_alerts", {})
    # Fallback volume for legacy configs
    default_vol = max(0, min(1, float(nws.get("tts_volume", 0.9))))
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

    # Resolve per-player volumes and remove bypassed players
    resolved_players = resolve_announcement_players(config, "nws_alerts", media_players_config)
    if not resolved_players:
        _fire_tts_status(
            hass, "skipped",
            request_id=request_id, reason="All players bypassed for NWS alerts",
            alert_kind="nws_alert",
        )
        return

    sound_file_raw = nws.get("sound_file") or ""

    # Auto-use Chime TTS when available for seamless siren + TTS playback
    if sound_file_raw and is_chime_tts_available(hass):
        chime_path = build_nws_local_media_id(normalize_nws_sound_filename(sound_file_raw))

        for mp in resolved_players:
            eid = mp.get("entity_id")
            tts_entity = mp.get("tts_entity_id")
            if not eid or not tts_entity:
                continue

            vol = mp.get("volume", default_vol)
            success = await dispatch_chime_tts(
                hass,
                eid,
                tts_entity,
                msg,
                chime_path,
                volume=vol,
                request_id=request_id,
                alert_kind="nws_alert",
            )
            if not success:
                _LOGGER.warning(
                    "Chime TTS failed for %s, using legacy NWS method", eid
                )
                await _legacy_nws_alert_single_player(
                    hass, config, mp, msg, vol, request_id=request_id,
                )

        _LOGGER.info("Chime TTS NWS alert completed")
        return

    await play_nws_siren(hass, config, resolved_players, request_id=request_id)

    for mp in resolved_players:
        eid = mp.get("entity_id")
        if not eid:
            continue
        vol = mp.get("volume", default_vol)
        try:
            await hass.services.async_call(
                "media_player", "volume_set",
                {"entity_id": eid, "volume_level": vol},
                blocking=True,
            )
        except Exception as exc:
            _LOGGER.warning("NWS alert volume_set failed for %s: %s", eid, exc)

    await send_tts(
        hass, resolved_players, msg, volume_override=None,
        request_id=request_id, alert_kind="nws_alert",
    )
    await wait_for_media_players_after_tts(
        hass, media_player_entity_ids(resolved_players),
    )


async def _legacy_nws_alert_single_player(
    hass: HomeAssistant,
    config: dict[str, Any],
    mp: dict[str, Any],
    message: str,
    tts_vol: float,
    *,
    request_id: str | None = None,
) -> None:
    """Fallback for a single player when Chime TTS fails for NWS alerts."""
    eid = mp.get("entity_id")
    if not eid:
        return

    await play_nws_siren(hass, config, [mp], request_id=request_id)

    try:
        await hass.services.async_call(
            "media_player", "volume_set",
            {"entity_id": eid, "volume_level": tts_vol},
            blocking=True,
        )
    except Exception as exc:
        _LOGGER.warning("NWS alert volume_set failed for %s: %s", eid, exc)

    await send_tts(
        hass, [mp], message, volume_override=tts_vol,
        request_id=request_id, alert_kind="nws_alert",
    )
    await wait_for_media_players_after_tts(hass, [eid])


def _round_miles(value: float | None) -> str:
    if value is None:
        return "an unknown distance"
    rounded = int(round(value))
    return f"{rounded} mile{'s' if rounded != 1 else ''}"


def format_tropical_alert_for_tts(context: dict[str, Any]) -> str:
    """Build spoken hurricane alert from detection context."""
    kind = context.get("event_kind") or "update"
    name = context.get("stormName") or context.get("closestStormName") or "an active hurricane"
    dist = context.get("distanceMiles") or context.get("distanceToCenterMiles")
    hour = context.get("estimatedClosestApproachHour")
    prob = context.get("formationProbability")

    if kind == "inside_cone":
        parts = [f"Hurricane update. {name} is now within the forecast cone for your area."]
        if hour is not None:
            parts.append(f"Closest approach estimated in {hour} hours")
        if dist is not None:
            parts.append(f"about {_round_miles(dist)} from home")
        return ". ".join(parts) + "."

    if kind == "threat_escalation":
        current = context.get("currentThreat") or "elevated"
        return (
            f"Hurricane threat update. The combined hurricane threat level for your area "
            f"has risen to {current}. Monitor {name} closely."
        )

    if kind == "new_storm":
        return (
            f"Hurricane update. New active hurricane {name} detected within "
            f"{_round_miles(dist)} of your area."
        )

    if kind == "outlook_development":
        if context.get("reason") == "inside_region":
            msg = "Hurricane outlook update. Your area is now inside a hurricane development region."
        else:
            msg = "Hurricane outlook update. Formation probability has increased for a nearby disturbance."
        if prob is not None:
            msg += f" Probability is now {prob} percent."
        return msg

    return "Hurricane weather update. Monitor conditions in your area."


def format_tornado_warning_for_tts(
    payload: dict[str, Any],
    *,
    cleared: bool = False,
) -> str:
    """Build spoken tornado warning alert."""
    if cleared:
        return "Tornado all clear. The tornado warning affecting your area has ended."
    headline = _spoken(payload.get("headline") or "")
    if payload.get("affecting_home"):
        base = "Tornado warning for your area. A tornado warning polygon now includes your location. Take shelter immediately."
    else:
        dist = payload.get("distance_miles")
        base = f"Tornado warning nearby, {_round_miles(dist)} from home."
    if headline:
        return f"{base} {headline}"
    return base


def format_earthquake_alert_for_tts(
    payload: dict[str, Any],
    *,
    cleared: bool = False,
    updated: bool = False,
) -> str:
    """Build spoken earthquake alert."""
    if cleared:
        return "Earthquake update. The previously reported nearby earthquake is no longer within your alert range."
    mag = payload.get("magnitude")
    place = _spoken(payload.get("place")) or "unknown location"
    dist = payload.get("distance_miles")
    depth = payload.get("depth_km")
    mag_text = f"Magnitude {mag}" if mag is not None else "An earthquake"
    prefix = "Earthquake update." if updated else "Earthquake alert."
    parts = [prefix, f"{mag_text} earthquake, {_round_miles(dist)} away, near {place}."]
    if depth is not None:
        parts.append(f"Depth {int(round(depth))} kilometers.")
    if payload.get("tsunami") == 1:
        parts.append("Tsunami information is available. Check official sources.")
    return " ".join(parts)


def _alert_zone_mode(monitoring_config: dict[str, Any] | None) -> str:
    """Resolve the alert scope for a hazard.

    Falls back to the sensor ``zone_mode`` and finally ``zone`` when the
    monitoring block predates the ``alert_zone_mode`` field.
    """
    monitoring = monitoring_config or {}
    return str(
        monitoring.get("alert_zone_mode", monitoring.get("zone_mode", "zone"))
    ).lower()


def passes_tornado_tts_filter(
    payload: dict[str, Any],
    tornado_config: dict[str, Any],
    monitoring_config: dict[str, Any] | None = None,
    *,
    cleared: bool = False,
) -> bool:
    """Return True when tornado payload meets TTS announce criteria.

    Distance / polygon thresholds come from ``tornado_monitoring`` (Alert
    Zones); ``tornado_config`` (the TTS block) only supplies announce toggles.
    When the alert scope is ``all`` the zone is bypassed entirely.
    """
    if cleared:
        return bool(tornado_config.get("announce_cleared", False))
    monitoring = monitoring_config or {}
    if _alert_zone_mode(monitoring) == "all":
        return True
    if monitoring.get("only_affecting_home", True):
        return bool(payload.get("affecting_home"))
    dist = payload.get("distance_miles")
    max_dist = float(monitoring.get("max_distance_miles", 25))
    return dist is not None and dist <= max_dist


def passes_earthquake_tts_filter(
    payload: dict[str, Any],
    earthquake_config: dict[str, Any],
    event_type: str,
    monitoring_config: dict[str, Any] | None = None,
) -> bool:
    """Return True when earthquake payload meets TTS announce criteria.

    Magnitude / distance thresholds come from ``earthquake_monitoring`` (Alert
    Zones); ``earthquake_config`` (the TTS block) supplies announce toggles and
    the tsunami-priority override. Alert scope ``all`` bypasses the zone and
    magnitude thresholds entirely.
    """
    if event_type == "home_weather_earthquake_cleared":
        return bool(earthquake_config.get("announce_cleared", False))
    if event_type == "home_weather_earthquake_updated":
        if not earthquake_config.get("announce_updated", False):
            return False
    monitoring = monitoring_config or {}
    if _alert_zone_mode(monitoring) == "all":
        return True
    dist = payload.get("distance_miles")
    max_dist = float(monitoring.get("radius_miles", 500))
    if dist is None or dist > max_dist:
        return False
    if payload.get("tsunami") == 1 and earthquake_config.get("tsunami_priority", True):
        return True
    min_mag = float(monitoring.get("min_magnitude", 2.5))
    mag = payload.get("magnitude")
    return mag is not None and mag >= min_mag


_VOLCANO_LEVEL_RANK = {"advisory": 1, "watch": 2, "warning": 3}


def format_volcano_alert_for_tts(
    payload: dict[str, Any],
    *,
    cleared: bool = False,
    updated: bool = False,
) -> str:
    """Build spoken volcano activity alert."""
    name = _spoken(payload.get("name")) or "A volcano"
    if cleared:
        return (
            f"Volcano update. Activity at {name} has cleared and it is "
            "no longer at an elevated alert level."
        )
    level = _spoken(payload.get("activity_level") or "advisory")
    dist = payload.get("distance_miles")
    prefix = "Volcano update." if updated else "Volcano alert."
    parts = [prefix, f"{name} is now at {level} level"]
    if dist is not None:
        parts[-1] += f", {_round_miles(dist)} from home"
    parts[-1] += "."
    synopsis = _spoken(payload.get("synopsis") or "")
    if synopsis:
        parts.append(synopsis[:200])
    return " ".join(parts)


def passes_volcano_tts_filter(
    payload: dict[str, Any],
    volcano_config: dict[str, Any],
    event_type: str,
    monitoring_config: dict[str, Any] | None = None,
) -> bool:
    """Return True when volcano payload meets TTS announce criteria.

    Minimum activity level and distance come from ``volcano_monitoring`` (Alert
    Zones); ``volcano_config`` (the TTS block) supplies the cleared toggle.
    Alert scope ``all`` bypasses the zone and level thresholds entirely.
    """
    if event_type == "home_weather_volcano_activity_cleared":
        return bool(volcano_config.get("announce_cleared", False))
    monitoring = monitoring_config or {}
    if _alert_zone_mode(monitoring) == "all":
        return True
    level = str(payload.get("activity_level") or "").lower()
    min_level = str(monitoring.get("min_alert_level", "advisory")).lower()
    rank = _VOLCANO_LEVEL_RANK.get(level)
    min_rank = _VOLCANO_LEVEL_RANK.get(min_level, 1)
    if rank is None or rank < min_rank:
        return False
    dist = payload.get("distance_miles")
    max_dist = float(monitoring.get("radius_miles", 500))
    return dist is None or dist <= max_dist


def format_wildfire_alert_for_tts(
    payload: dict[str, Any],
    *,
    cleared: bool = False,
    updated: bool = False,
) -> str:
    """Build spoken wildfire alert."""
    name = _spoken(payload.get("name")) or "A wildfire"
    if cleared:
        return (
            f"Wildfire update. {name} is no longer within your wildfire alert zone."
        )
    dist = payload.get("distance_miles")
    acres = payload.get("acres")
    location = _spoken(payload.get("location") or payload.get("state")) or "unknown location"
    prefix = "Wildfire update." if updated else "Wildfire alert."
    parts = [prefix, f"{name} near {location}"]
    if dist is not None:
        parts.append(f"is {_round_miles(dist)} from home")
    if acres is not None:
        parts.append(f"covering about {int(round(acres))} acres")
    contained = payload.get("percent_contained")
    if contained is not None:
        parts.append(f"and is {int(round(contained))} percent contained")
    return ", ".join(parts) + "."


def passes_wildfire_tts_filter(
    payload: dict[str, Any],
    wildfire_config: dict[str, Any],
    event_type: str,
    monitoring_config: dict[str, Any] | None = None,
) -> bool:
    """Return True when wildfire payload meets TTS announce criteria."""
    if event_type == "home_weather_wildfire_cleared":
        return bool(wildfire_config.get("announce_cleared", False))
    monitoring = monitoring_config or {}
    if _alert_zone_mode(monitoring) == "all":
        return True
    dist = payload.get("distance_miles")
    max_dist = float(monitoring.get("radius_miles", 100))
    if dist is None or dist > max_dist:
        return False
    min_acres = float(monitoring.get("min_acres", 100))
    acres = payload.get("acres")
    return acres is not None and acres >= min_acres


def format_air_quality_alert_for_tts(
    payload: dict[str, Any],
    *,
    cleared: bool = False,
    updated: bool = False,
) -> str:
    """Build spoken air quality alert."""
    name = _spoken(payload.get("name")) or "Your area"
    state = _spoken(payload.get("state") or "")
    area_label = f"{name}, {state}".strip(", ")
    if cleared:
        return (
            f"Air quality update. Conditions in {area_label} are no longer "
            "within your air quality alert range."
        )
    aqi = payload.get("aqi")
    category = _spoken(payload.get("category") or "elevated")
    dist = payload.get("distance_miles")
    prefix = "Air quality update." if updated else "Air quality alert."
    parts = [prefix, f"Air quality in {area_label} is {category}"]
    if aqi is not None:
        parts[-1] += f" with an A Q I of {aqi}"
    if dist is not None:
        parts.append(f"about {_round_miles(dist)} from home")
    return ", ".join(parts) + "."


def passes_air_quality_tts_filter(
    payload: dict[str, Any],
    air_quality_config: dict[str, Any],
    event_type: str,
    monitoring_config: dict[str, Any] | None = None,
) -> bool:
    """Return True when air quality payload meets TTS announce criteria."""
    if event_type == "home_weather_air_quality_cleared":
        return bool(air_quality_config.get("announce_cleared", False))
    monitoring = monitoring_config or {}
    if _alert_zone_mode(monitoring) == "all":
        return True
    dist = payload.get("distance_miles")
    max_dist = float(monitoring.get("radius_miles", 50))
    if dist is None or dist > max_dist:
        return False
    min_level = int(monitoring.get("min_category_level") or 1)
    level = int(payload.get("category_level") or 1)
    return level >= min_level


async def play_hazard_siren(
    hass: HomeAssistant,
    section: dict[str, Any],
    media_players_config: list[dict[str, Any]],
    *,
    request_id: str | None = None,
    alert_kind: str = "hazard_siren",
) -> None:
    """Play optional siren from a hazard alert config section.
    
    Uses per-player volume from media_players_config (resolved via
    resolve_announcement_players) rather than global sound_volume.
    """
    sound_file_raw = section.get("sound_file") or ""
    if not normalize_nws_sound_filename(sound_file_raw) or not media_players_config:
        return

    media_path = await hass.async_add_executor_job(
        resolve_nws_playable_sound, hass, sound_file_raw
    )
    if not media_path:
        _LOGGER.warning("Hazard siren file missing: %s", normalize_nws_sound_filename(sound_file_raw))
        _fire_tts_status(
            hass, "failed", request_id=request_id,
            reason=f"Sound file not found in config/www/{NWS_SOUNDS_SUBPATH}/",
            alert_kind=alert_kind,
        )
        return

    media_id, media_type = nws_local_playback(hass, media_path)
    # Fallback to legacy global sound_volume only if per-player volume not set
    default_vol = max(0, min(1, float(section.get("sound_volume", 0.8))))

    for mp in media_players_config:
        eid = mp.get("entity_id")
        if not eid:
            continue
        # Use per-player volume (already set by resolve_announcement_players)
        vol = mp.get("volume", default_vol)
        try:
            await hass.services.async_call(
                "media_player", "volume_set",
                {"entity_id": eid, "volume_level": vol},
                blocking=True,
            )
            await hass.services.async_call(
                "media_player", "play_media",
                {
                    "entity_id": eid,
                    "media_content_id": media_id,
                    "media_content_type": media_type,
                },
                blocking=True,
            )
            await _wait_for_media_player_idle(hass, eid, wait_for_start=True)
        except Exception as exc:
            _LOGGER.warning("Hazard siren playback failed for %s: %s", eid, exc)
            _fire_tts_status(
                hass, "failed", request_id=request_id, entity_id=eid,
                reason=str(exc), alert_kind=alert_kind,
            )


async def play_hazard_alert_notification(
    hass: HomeAssistant,
    config: dict[str, Any],
    section_key: str,
    message: str,
    media_players_config: list[dict[str, Any]],
    *,
    request_id: str | None = None,
    alert_kind: str = "",
) -> None:
    """Play optional siren then TTS for a hazard alert section.

    Uses per-player volumes from announcement_players config. When
    use_chime_tts is enabled and Chime TTS is installed, combines the
    siren audio and TTS into a single seamless playback. Otherwise
    falls back to the legacy two-call method.
    """
    section = config.get(section_key) or {}
    # Fallback tts_volume for legacy configs without announcement_players
    default_vol = max(0, min(1, float(section.get("tts_volume", 0.9))))
    tts_config = config.get("tts", {})
    msg = await apply_ai_rewrite(
        hass, tts_config, message,
        request_id=request_id, alert_kind=alert_kind,
    )
    if not media_players_config:
        _fire_tts_status(
            hass, "skipped", request_id=request_id,
            reason="No media players configured", alert_kind=alert_kind,
        )
        return
    if not msg.strip():
        return

    # Resolve per-player volumes and remove bypassed players
    resolved_players = resolve_announcement_players(config, section_key, media_players_config)
    if not resolved_players:
        _fire_tts_status(
            hass, "skipped", request_id=request_id,
            reason="All players bypassed for this alert type", alert_kind=alert_kind,
        )
        return

    sound_file_raw = section.get("sound_file") or ""

    # Auto-use Chime TTS when available for seamless siren + TTS playback
    if sound_file_raw and is_chime_tts_available(hass):
        chime_path = build_nws_local_media_id(normalize_nws_sound_filename(sound_file_raw))
        all_succeeded = True

        for mp in resolved_players:
            eid = mp.get("entity_id")
            tts_entity = mp.get("tts_entity_id")
            if not eid or not tts_entity:
                continue

            # Use per-player volume
            vol = mp.get("volume", default_vol)
            success = await dispatch_chime_tts(
                hass,
                eid,
                tts_entity,
                msg,
                chime_path,
                volume=vol,
                request_id=request_id,
                alert_kind=alert_kind,
            )
            if not success:
                all_succeeded = False
                _LOGGER.warning(
                    "Chime TTS failed for %s, using legacy method", eid
                )
                await _legacy_hazard_alert_single_player(
                    hass, section, mp, msg, vol,
                    request_id=request_id, alert_kind=alert_kind,
                )

        if all_succeeded:
            _LOGGER.info("Chime TTS hazard alert completed for all players")
        return

    await play_hazard_siren(
        hass, section, resolved_players,
        request_id=request_id, alert_kind=f"{alert_kind}_siren",
    )

    # Per-player volume is already set in resolved_players
    for mp in resolved_players:
        eid = mp.get("entity_id")
        if not eid:
            continue
        vol = mp.get("volume", default_vol)
        try:
            await hass.services.async_call(
                "media_player", "volume_set",
                {"entity_id": eid, "volume_level": vol},
                blocking=True,
            )
        except Exception as exc:
            _LOGGER.warning("Hazard alert volume_set failed for %s: %s", eid, exc)

    # volume_override=None -> each player uses its own volume from the config
    await send_tts(
        hass, resolved_players, msg, volume_override=None,
        request_id=request_id, alert_kind=alert_kind,
    )
    await wait_for_media_players_after_tts(
        hass, media_player_entity_ids(resolved_players),
    )


async def _legacy_hazard_alert_single_player(
    hass: HomeAssistant,
    section: dict[str, Any],
    mp: dict[str, Any],
    message: str,
    tts_vol: float,
    *,
    request_id: str | None = None,
    alert_kind: str = "",
) -> None:
    """Fallback for a single player when Chime TTS fails."""
    eid = mp.get("entity_id")
    if not eid:
        return

    await play_hazard_siren(
        hass, section, [mp],
        request_id=request_id, alert_kind=f"{alert_kind}_siren",
    )

    try:
        await hass.services.async_call(
            "media_player", "volume_set",
            {"entity_id": eid, "volume_level": tts_vol},
            blocking=True,
        )
    except Exception as exc:
        _LOGGER.warning("Hazard alert volume_set failed for %s: %s", eid, exc)

    await send_tts(
        hass, [mp], message, volume_override=tts_vol,
        request_id=request_id, alert_kind=alert_kind,
    )
    await wait_for_media_players_after_tts(hass, [eid])


def format_travel_advisory_for_tts(
    payload: dict[str, Any],
    *,
    changed: bool = False,
) -> str:
    """Build spoken U.S. State Department travel advisory alert."""
    country = _spoken(payload.get("country")) or "A destination"
    level = int(payload.get("level") or 0)
    level_name = _spoken(payload.get("level_name") or payload.get("level_label")) or f"Level {level}"
    prefix = "Travel advisory update." if changed else "Travel advisory."
    parts = [prefix, f"{country} is now at {level_name}, level {level}."]
    summary = _spoken(payload.get("summary_text") or "")
    if summary:
        snippet = summary[:320].rsplit(" ", 1)[0] if len(summary) > 320 else summary
        parts.append(snippet)
    return " ".join(parts)


def _xray_class_rank(class_char: str) -> int:
    order = {"A": 0, "B": 1, "C": 2, "M": 3, "X": 4}
    return order.get((class_char or "A").upper()[:1], 0)


def format_spacecraft_alert_for_tts(payload: dict[str, Any]) -> str:
    """Build spoken spacecraft overhead alert."""
    name = _spoken(payload.get("name") or payload.get("craft_name")) or "A spacecraft"
    elev = payload.get("max_elevation_deg")
    if elev is not None:
        return f"Space alert. {name} is passing overhead at about {int(round(elev))} degrees elevation."
    return f"Space alert. {name} is passing overhead."


def format_solar_weather_alert_for_tts(payload: dict[str, Any]) -> str:
    """Build spoken solar weather alert."""
    event_type = payload.get("type") or ""
    if event_type == "geomagnetic_storm" or payload.get("k_index") is not None:
        k_index = payload.get("k_index")
        g_scale = payload.get("g_scale")
        if g_scale:
            return (
                f"Solar weather alert. Geomagnetic storm conditions detected. "
                f"Planetary K-index is {k_index}, G-scale {g_scale}."
            )
        return f"Solar weather alert. Elevated geomagnetic activity. Planetary K-index is {k_index}."
    xray = payload.get("xray_class") or "M"
    return f"Solar weather alert. A class {xray} solar flare event has been reported."


def format_neo_alert_for_tts(payload: dict[str, Any]) -> str:
    """Build spoken NEO close approach alert."""
    name = payload.get("name") or "A near-Earth object"
    ld = payload.get("lunar_distance")
    date = payload.get("close_approach_date") or ""
    parts = [f"Space alert. {name} will make a close approach to Earth"]
    if ld is not None:
        parts.append(f"within {ld:.1f} lunar distances")
    if date:
        parts.append(f"on {date}")
    return ", ".join(parts) + "."


def passes_spacecraft_tts_filter(
    payload: dict[str, Any],
    spacecraft_config: dict[str, Any],
    event_type: str,
) -> bool:
    """Return True when spacecraft pass meets TTS criteria."""
    if event_type.endswith("_cleared"):
        return False
    min_elev = float(spacecraft_config.get("min_elevation_deg") or 10)
    elev = payload.get("max_elevation_deg")
    if elev is not None and elev < min_elev:
        return False
    craft_ids = spacecraft_config.get("craft_ids") or []
    if craft_ids and payload.get("craft_id") not in [str(c) for c in craft_ids]:
        return False
    if event_type.endswith("_updated") and not spacecraft_config.get("announce_pass_peak"):
        return False
    return bool(spacecraft_config.get("announce_pass_start", True))


def passes_solar_weather_tts_filter(
    payload: dict[str, Any],
    solar_config: dict[str, Any],
    event_type: str,
) -> bool:
    """Return True when solar weather event meets TTS criteria."""
    if event_type.endswith("_cleared"):
        return False
    event_kind = payload.get("type") or ""
    if event_kind == "geomagnetic_storm" or payload.get("k_index") is not None:
        if not solar_config.get("announce_geomagnetic_storm", True):
            return False
        min_k = float(solar_config.get("min_k_index") or 5)
        k_val = float(payload.get("k_index") or 0)
        min_g = int(solar_config.get("min_g_scale") or 1)
        g_val = int(payload.get("g_scale") or 0)
        return k_val >= min_k or g_val >= min_g
    if event_kind == "solar_flare" or payload.get("xray_class"):
        if not solar_config.get("announce_flare_events", True):
            return False
        min_class = str(solar_config.get("min_xray_class") or "M").upper()[:1]
        event_class = str(payload.get("xray_class") or "C").upper()[:1]
        return _xray_class_rank(event_class) >= _xray_class_rank(min_class)
    return True


def passes_neo_tts_filter(
    payload: dict[str, Any],
    neo_config: dict[str, Any],
    event_type: str,
) -> bool:
    """Return True when NEO close approach meets TTS criteria."""
    if event_type.endswith("_cleared"):
        return False
    max_ld = float(neo_config.get("max_lunar_distances") or 5)
    ld = payload.get("lunar_distance")
    if ld is None or float(ld) > max_ld:
        return False
    min_diam = float(neo_config.get("min_diameter_m") or 100)
    diam = payload.get("diameter_m")
    if diam is not None and float(diam) < min_diam:
        return False
    return True
