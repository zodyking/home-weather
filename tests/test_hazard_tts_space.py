"""Tests for space alert TTS formatting."""
from __future__ import annotations

from custom_components.home_weather.tts_notifications import (
    format_neo_alert_for_tts,
    format_spacecraft_alert_for_tts,
    format_solar_weather_alert_for_tts,
)


def test_format_spacecraft_alert():
    msg = format_spacecraft_alert_for_tts({"name": "ISS", "max_elevation_deg": 62})
    assert "ISS" in msg
    assert "62" in msg


def test_format_solar_weather_alert_storm():
    msg = format_solar_weather_alert_for_tts({"type": "geomagnetic_storm", "k_index": 6, "g_scale": 2})
    assert "K-index" in msg
    assert "6" in msg


def test_format_neo_alert():
    msg = format_neo_alert_for_tts({"name": "2024 AA", "lunar_distance": 3.2, "close_approach_date": "2026-08-01"})
    assert "2024 AA" in msg
    assert "3.2" in msg
