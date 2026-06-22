"""Normalize weather conditions to unified slugs and display labels.

Canonical slugs unify Home Assistant weather entity states and Apple WeatherKit
conditionCode values into one consistent vocabulary for the panel and TTS.
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta
from typing import Any

from homeassistant.util import dt as dt_util

# Unified condition slugs (HA + Apple WeatherKit mapped into one set).
CANONICAL_CONDITIONS: frozenset[str] = frozenset({
    "sunny",
    "clear-night",
    "partlycloudy",
    "cloudy",
    "rainy",
    "pouring",
    "snowy",
    "snowy-rainy",
    "thunderstorm",
    "fog",
    "hail",
    "windy",
    "windy-variant",
    "hurricane",
    "tropical-storm",
    "tornado",
    "exceptional",
})

# Legacy HA entity slugs that normalize into canonical slugs.
_HA_LEGACY_SLUGS: frozenset[str] = frozenset({
    "lightning",
    "lightning-rainy",
})

CONDITION_LABELS: dict[str, str] = {
    "sunny": "Sunny",
    "clear-night": "Clear Night",
    "partlycloudy": "Partly Cloudy",
    "cloudy": "Cloudy",
    "rainy": "Rain",
    "pouring": "Pouring Rain",
    "snowy": "Snow",
    "snowy-rainy": "Snow & Rain",
    "thunderstorm": "Thunderstorm",
    "fog": "Fog",
    "hail": "Hail",
    "windy": "Windy",
    "windy-variant": "Windy & Cloudy",
    "hurricane": "Hurricane",
    "tropical-storm": "Tropical Storm",
    "tornado": "Tornado",
    "exceptional": "Exceptional",
}

PRECIPITATING_CONDITIONS: frozenset[str] = frozenset({
    "rainy",
    "pouring",
    "snowy",
    "snowy-rainy",
    "hail",
    "thunderstorm",
})

_CLOUD_COVER_SLUGS: frozenset[str] = frozenset({"cloudy", "partlycloudy", "windy-variant"})
_CLEAR_SKY_SLUGS: frozenset[str] = frozenset({"sunny", "partlycloudy", "clear-night"})

# Home Assistant weather entity slugs (developer docs) + Apple WeatherKit conditionCode.
_CONDITION_ALIASES: dict[str, str] = {
    # --- Home Assistant (all documented states) ---
    "sunny": "sunny",
    "clearnight": "clear-night",
    "partlycloudy": "partlycloudy",
    "cloudy": "cloudy",
    "fog": "fog",
    "hail": "hail",
    "lightning": "thunderstorm",
    "lightningrainy": "thunderstorm",
    "pouring": "pouring",
    "rainy": "rainy",
    "snowy": "snowy",
    "snowyrainy": "snowy-rainy",
    "windy": "windy",
    "windyvariant": "windy-variant",
    "exceptional": "exceptional",
    # --- Apple WeatherKit: visibility ---
    "clear": "sunny",
    "mostlyclear": "partlycloudy",
    "partlycloudy": "partlycloudy",
    "mostlycloudy": "cloudy",
    "cloudy": "cloudy",
    "foggy": "fog",
    "haze": "fog",
    "smoky": "fog",
    "blowingdust": "exceptional",
    "dust": "exceptional",
    # --- Apple WeatherKit: wind ---
    "breezy": "windy",
    "windy": "windy",
    # --- Apple WeatherKit: precipitation ---
    "drizzle": "rainy",
    "rain": "rainy",
    "heavyrain": "pouring",
    "showers": "rainy",
    "scatteredshowers": "rainy",
    "sunshowers": "rainy",
    "freezingdrizzle": "snowy-rainy",
    "isolatedthunderstorms": "thunderstorm",
    "scatteredthunderstorms": "thunderstorm",
    "thunderstorms": "thunderstorm",
    "thunderstorm": "thunderstorm",
    "strongstorms": "thunderstorm",
    "severethunderstorm": "thunderstorm",
    # --- Apple WeatherKit: winter / mix ---
    "flurries": "snowy",
    "sunflurries": "snowy",
    "snow": "snowy",
    "heavysnow": "snowy",
    "snowshowers": "snowy",
    "scatteredsnowshowers": "snowy",
    "blowingsnow": "snowy",
    "blizzard": "snowy",
    "sleet": "snowy-rainy",
    "freezingrain": "snowy-rainy",
    "wintrymix": "snowy-rainy",
    "mixedrainandsnow": "snowy-rainy",
    "mixedrainfall": "snowy-rainy",
    "mixedrainandsleet": "snowy-rainy",
    "mixedsnowandsleet": "snowy-rainy",
    # --- Apple WeatherKit: hazardous / tropical ---
    "frigid": "exceptional",
    "hot": "exceptional",
    "hurricane": "hurricane",
    "tornado": "tornado",
    "tropicalstorm": "tropical-storm",
    # --- Common provider / spoken variants ---
    "clearsky": "sunny",
    "clearskies": "sunny",
    "fair": "sunny",
    "sun": "sunny",
    "overcast": "cloudy",
    "overcastclouds": "cloudy",
    "mist": "fog",
    "hazy": "fog",
    "smoke": "fog",
    "shower": "rainy",
    "pour": "pouring",
    "flurr": "snowy",
    "wintry": "snowy-rainy",
    "storm": "thunderstorm",
    "storms": "thunderstorm",
    "thunder": "thunderstorm",
}


def _condition_key(raw: str) -> str:
    """Normalize raw provider text to a lookup key."""
    return re.sub(r"[\s_\-]+", "", raw.strip().lower())


def _canonicalize_slug(slug: str) -> str:
    """Map legacy HA slugs and unknown values into canonical slugs."""
    if slug in {"lightning", "lightning-rainy"}:
        return "thunderstorm"
    if slug in CANONICAL_CONDITIONS:
        return slug
    return slug


def normalize_weather_condition(raw: str | None, *, is_night: bool = False) -> str:
    """Map any provider condition string to a canonical slug."""
    if not raw or not str(raw).strip():
        return "cloudy"

    text = str(raw).strip()
    key = _condition_key(text)

    if key in CANONICAL_CONDITIONS:
        slug = key
    elif text in CANONICAL_CONDITIONS:
        slug = text
    elif key in _HA_LEGACY_SLUGS or text in _HA_LEGACY_SLUGS:
        slug = "thunderstorm"
    else:
        slug = _CONDITION_ALIASES.get(key, "")
        if not slug:
            if "thunder" in key or "lightning" in key or key == "storm":
                slug = "thunderstorm"
            elif "hail" in key:
                slug = "hail"
            elif "hurricane" in key:
                slug = "hurricane"
            elif "tornado" in key:
                slug = "tornado"
            elif "tropical" in key:
                slug = "tropical-storm"
            elif "snow" in key and "rain" in key:
                slug = "snowy-rainy"
            elif "sleet" in key or "freezing" in key or "wintry" in key:
                slug = "snowy-rainy"
            elif "snow" in key or "blizzard" in key or "flurr" in key:
                slug = "snowy"
            elif "pour" in key or "heavyrain" in key:
                slug = "pouring"
            elif "rain" in key or "drizzle" in key or "shower" in key:
                slug = "rainy"
            elif "fog" in key or "mist" in key or "haze" in key or "smoke" in key or "dust" in key:
                slug = "fog"
            elif "wind" in key and "cloud" in key:
                slug = "windy-variant"
            elif "wind" in key or "breezy" in key:
                slug = "windy"
            elif "partly" in key or "mostlyclear" in key:
                slug = "partlycloudy"
            elif "mostlycloudy" in key or "cloud" in key or "overcast" in key:
                slug = "cloudy"
            elif "clear" in key or "sun" in key or "fair" in key:
                slug = "sunny"
            elif "hot" in key or "frigid" in key or "extreme" in key:
                slug = "exceptional"
            else:
                slug = "cloudy"

    slug = _canonicalize_slug(slug)

    if is_night and slug == "sunny":
        slug = "clear-night"

    return slug


def condition_label_for_display(slug: str | None) -> str:
    """Return a consistent UI label for a canonical condition slug."""
    if not slug:
        return "—"
    canonical = normalize_weather_condition(slug)
    return CONDITION_LABELS.get(canonical, canonical.replace("-", " ").title())


def condition_label_for_tts(slug: str | None) -> str:
    """Return a natural spoken label for TTS."""
    label = condition_label_for_display(slug)
    if label == "—":
        return "current conditions"
    return label.lower()


def enrich_condition(raw: str | None, *, is_night: bool = False) -> tuple[str, str]:
    """Return canonical slug and display label for a raw provider condition."""
    slug = normalize_weather_condition(raw, is_night=is_night)
    return slug, condition_label_for_display(slug)


def is_precipitating_condition(slug: str | None) -> bool:
    """Return True when the condition slug means precipitation is active."""
    if not slug:
        return False
    return normalize_weather_condition(slug) in PRECIPITATING_CONDITIONS


def precip_family(slug: str | None) -> str | None:
    """Return a coarse precip family: rain, snow, mix, hail, or None."""
    normalized = normalize_weather_condition(slug or "")
    if normalized in {"rainy", "pouring", "thunderstorm"}:
        return "rain"
    if normalized == "snowy":
        return "snow"
    if normalized == "snowy-rainy":
        return "mix"
    if normalized == "hail":
        return "hail"
    return None


def precip_family_from_kind(kind: str | None) -> str | None:
    """Map precipitation_kind / free text to a precip family."""
    if not kind:
        return None
    key = _condition_key(str(kind))
    if any(token in key for token in ("wintry", "sleet", "mix", "freezing")) or (
        "snow" in key and "rain" in key
    ):
        return "mix"
    if "snow" in key or "flurr" in key or "blizzard" in key:
        return "snow"
    if "hail" in key:
        return "hail"
    if any(token in key for token in ("rain", "drizzle", "shower", "pour", "thunder", "storm")):
        return "rain"
    return precip_family(kind)


def is_precipitation_active(current: dict[str, Any] | None) -> bool:
    """Return True when current conditions indicate precipitation is already happening."""
    if not current:
        return False
    slug = normalize_weather_condition(current.get("condition") or current.get("state") or "")
    if is_precipitating_condition(slug):
        return True
    precip = current.get("precipitation")
    try:
        if precip is not None and float(precip) > 0:
            return True
    except (TypeError, ValueError):
        pass
    return False


def precip_already_matches_upcoming(
    current_slug: str | None,
    upcoming_slug: str | None,
    upcoming_kind: str | None,
) -> bool:
    """Return True when an upcoming precip alert would duplicate current weather."""
    current_family = precip_family(current_slug)
    if not current_family:
        return False
    upcoming_family = precip_family(upcoming_slug) or precip_family_from_kind(upcoming_kind)
    if not upcoming_family:
        return False
    if current_family == upcoming_family:
        return True
    rain_like = {"rain", "mix"}
    snow_like = {"snow", "mix"}
    if current_family in rain_like and upcoming_family in rain_like:
        return True
    if current_family in snow_like and upcoming_family in snow_like:
        return True
    return False


def is_significant_condition_change(old_slug: str | None, new_slug: str | None) -> bool:
    """Return True when a condition change is worth announcing."""
    old_norm = normalize_weather_condition(old_slug or "")
    new_norm = normalize_weather_condition(new_slug or "")
    if old_norm == new_norm:
        return False
    if is_precipitating_condition(old_norm) and is_precipitating_condition(new_norm):
        if precip_already_matches_upcoming(old_norm, new_norm, None):
            return False
    if old_norm in _CLOUD_COVER_SLUGS and new_norm in _CLOUD_COVER_SLUGS:
        return False
    if old_norm in _CLEAR_SKY_SLUGS and new_norm in _CLEAR_SKY_SLUGS:
        return False
    return True


def _parse_forecast_datetime(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        parsed = value
    else:
        parsed = dt_util.parse_datetime(str(value).replace("Z", "+00:00"))
    if parsed is None:
        return None
    if parsed.tzinfo is None:
        parsed = dt_util.as_local(parsed)
    return parsed


def find_upcoming_precip_alert(
    current: dict[str, Any] | None,
    hourly: list[dict[str, Any]],
    *,
    minutes_before: int,
    threshold: int,
    now: datetime | None = None,
) -> dict[str, Any] | None:
    """Find the next precip alert slot, skipping periods already underway."""
    if is_precipitation_active(current):
        return None

    current_slug = normalize_weather_condition(
        (current or {}).get("condition") or (current or {}).get("state") or ""
    )
    now = now or dt_util.now()
    alert_window = now + timedelta(minutes=minutes_before)

    for hour in hourly:
        precip_prob = hour.get("precipitation_probability", 0) or 0
        if precip_prob < threshold:
            continue

        h_time = _parse_forecast_datetime(hour.get("datetime"))
        if h_time is None or h_time <= now or h_time > alert_window:
            continue

        hour_slug = normalize_weather_condition(hour.get("condition") or "")
        precip_kind = hour.get("precipitation_kind") or hour.get("condition") or "precipitation"

        if is_precipitating_condition(hour_slug) and h_time <= now + timedelta(minutes=15):
            continue
        if precip_already_matches_upcoming(current_slug, hour_slug, precip_kind):
            continue

        minutes_until = max(1, int((h_time - now).total_seconds() / 60))
        return {
            "time": h_time,
            "minutes_until": minutes_until,
            "probability": int(precip_prob),
            "precip_kind": precip_kind,
            "alert_key": h_time.strftime("%Y-%m-%d-%H"),
        }

    return None
