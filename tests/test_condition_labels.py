"""Tests for weather condition normalization."""
from __future__ import annotations

from custom_components.home_weather.condition_labels import (
    condition_label_for_display,
    condition_label_for_tts,
    enrich_condition,
    find_upcoming_precip_alert,
    is_precipitation_active,
    is_significant_condition_change,
    normalize_weather_condition,
)


def test_ha_slugs_pass_through():
    assert normalize_weather_condition("pouring") == "pouring"
    assert normalize_weather_condition("partlycloudy") == "partlycloudy"
    assert normalize_weather_condition("clear-night") == "clear-night"


def test_apple_weatherkit_aliases():
    assert normalize_weather_condition("HeavyRain") == "pouring"
    assert normalize_weather_condition("MostlyClear") == "partlycloudy"
    assert normalize_weather_condition("PartlyCloudy") == "partlycloudy"
    assert normalize_weather_condition("Thunderstorms") == "thunderstorm"
    assert normalize_weather_condition("MixedRainAndSnow") == "snowy-rainy"
    # Full Apple WeatherKit coverage
    apple_cases = {
        "BlowingDust": "exceptional",
        "Clear": "sunny",
        "Cloudy": "cloudy",
        "Foggy": "fog",
        "Haze": "fog",
        "MostlyCloudy": "cloudy",
        "Smoky": "fog",
        "Breezy": "windy",
        "Windy": "windy",
        "Drizzle": "rainy",
        "Rain": "rainy",
        "SunShowers": "rainy",
        "IsolatedThunderstorms": "thunderstorm",
        "ScatteredThunderstorms": "thunderstorm",
        "StrongStorms": "thunderstorm",
        "SevereThunderstorm": "thunderstorm",
        "Frigid": "exceptional",
        "Hail": "hail",
        "Hot": "exceptional",
        "Flurries": "snowy",
        "Sleet": "snowy-rainy",
        "Snow": "snowy",
        "SunFlurries": "snowy",
        "WintryMix": "snowy-rainy",
        "Blizzard": "snowy",
        "BlowingSnow": "snowy",
        "FreezingDrizzle": "snowy-rainy",
        "FreezingRain": "snowy-rainy",
        "HeavySnow": "snowy",
        "Hurricane": "hurricane",
        "TropicalStorm": "tropical-storm",
        "Dust": "exceptional",
        "Showers": "rainy",
        "ScatteredShowers": "rainy",
        "SnowShowers": "snowy",
        "ScatteredSnowShowers": "snowy",
        "Tornado": "tornado",
    }
    for raw, expected in apple_cases.items():
        assert normalize_weather_condition(raw) == expected, raw


def test_ha_lightning_maps_to_thunderstorm():
    assert normalize_weather_condition("lightning") == "thunderstorm"
    assert normalize_weather_condition("lightning-rainy") == "thunderstorm"


def test_freeform_text():
    assert normalize_weather_condition("Light rain") == "rainy"
    assert normalize_weather_condition("Wintry Mix") == "snowy-rainy"


def test_night_clear_becomes_clear_night():
    assert normalize_weather_condition("sunny", is_night=True) == "clear-night"
    assert normalize_weather_condition("Clear", is_night=True) == "clear-night"


def test_display_labels_match_ha_style():
    assert condition_label_for_display("pouring") == "Pouring Rain"
    assert condition_label_for_display("partlycloudy") == "Partly Cloudy"
    assert condition_label_for_display("lightning-rainy") == "Thunderstorm"
    assert condition_label_for_display("lightning") == "Thunderstorm"
    assert condition_label_for_display("thunderstorm") == "Thunderstorm"
    assert condition_label_for_display("hurricane") == "Hurricane"
    assert condition_label_for_display("tropical-storm") == "Tropical Storm"
    assert condition_label_for_display("tornado") == "Tornado"
    assert condition_label_for_display("clear-night") == "Clear Night"


def test_tts_labels_are_lowercase():
    assert condition_label_for_tts("pouring") == "pouring rain"
    assert condition_label_for_tts("partlycloudy") == "partly cloudy"


def test_enrich_condition():
    slug, label = enrich_condition("HeavyRain")
    assert slug == "pouring"
    assert label == "Pouring Rain"


def test_is_precipitation_active_for_pouring():
    assert is_precipitation_active({"condition": "pouring"}) is True
    assert is_precipitation_active({"condition": "cloudy"}) is False
    assert is_precipitation_active({"condition": "cloudy", "precipitation": 0.02}) is True


def test_is_significant_condition_change_skips_rain_intensity():
    assert is_significant_condition_change("rainy", "pouring") is False
    assert is_significant_condition_change("cloudy", "rainy") is True
    assert is_significant_condition_change("cloudy", "partlycloudy") is False


def test_find_upcoming_precip_alert_skips_when_already_raining():
    from datetime import timedelta

    from homeassistant.util import dt as dt_util

    now = dt_util.now()
    current = {"condition": "pouring"}
    hourly = [
        {
            "datetime": (now + timedelta(minutes=15)).isoformat(),
            "precipitation_probability": 80,
            "condition": "rainy",
        }
    ]
    assert find_upcoming_precip_alert(current, hourly, minutes_before=30, threshold=30, now=now) is None


def test_find_upcoming_precip_alert_finds_dry_to_rain():
    from datetime import timedelta

    from homeassistant.util import dt as dt_util

    now = dt_util.now()
    current = {"condition": "cloudy"}
    hourly = [
        {
            "datetime": (now + timedelta(minutes=20)).isoformat(),
            "precipitation_probability": 70,
            "condition": "rainy",
        }
    ]
    match = find_upcoming_precip_alert(current, hourly, minutes_before=30, threshold=30, now=now)
    assert match is not None
    assert match["minutes_until"] == 20
