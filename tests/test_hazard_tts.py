"""Tests for hazard-specific TTS message formatting and filters."""
from __future__ import annotations

from custom_components.home_weather.hurricane_data import (
    build_tropical_tts_snapshot,
    detect_tropical_tts_events,
)
from custom_components.home_weather.tts_notifications import (
    format_earthquake_alert_for_tts,
    format_tornado_warning_for_tts,
    format_tropical_alert_for_tts,
    passes_earthquake_tts_filter,
    passes_tornado_tts_filter,
)


def _tropical_config() -> dict:
    return {
        "min_threat_level": "watch",
        "max_distance_miles": 500,
        "announce_inside_cone": True,
        "announce_threat_escalation": True,
        "announce_new_storm": True,
        "announce_outlook_development": True,
        "outlook_min_probability": 40,
    }


def test_format_tropical_inside_cone_message():
    msg = format_tropical_alert_for_tts({
        "event_kind": "inside_cone",
        "closestStormName": "Milton",
        "distanceToCenterMiles": 120,
        "estimatedClosestApproachHour": 36,
    })
    assert "Milton" in msg
    assert "forecast cone" in msg
    assert "36 hours" in msg


def test_detect_tropical_cone_entry():
    previous = build_tropical_tts_snapshot({
        "summary": {"threatLevel": "watch", "insideCone": False, "closestStormName": "Milton"},
        "storms": [{"id": "al012024", "name": "Milton", "threat": {"distanceToCenterMiles": 120}}],
    })
    current_payload = {
        "summary": {
            "threatLevel": "watch",
            "insideCone": True,
            "closestStormName": "Milton",
            "distanceToCenterMiles": 120,
            "estimatedClosestApproachHour": 36,
        },
        "storms": [{"id": "al012024", "name": "Milton", "threat": {"distanceToCenterMiles": 120}}],
    }
    events = detect_tropical_tts_events(previous, current_payload, _tropical_config())
    kinds = [k for k, _ in events]
    assert "inside_cone" in kinds


def test_detect_tropical_threat_escalation():
    previous = build_tropical_tts_snapshot({
        "summary": {"threatLevel": "monitor", "insideCone": False},
        "storms": [],
    })
    current_payload = {
        "summary": {"threatLevel": "watch", "insideCone": False, "closestStormName": "Test"},
        "storms": [],
    }
    events = detect_tropical_tts_events(previous, current_payload, _tropical_config())
    assert any(k == "threat_escalation" for k, _ in events)


def test_detect_tropical_bootstrap_skips():
    payload = {
        "summary": {"threatLevel": "high", "insideCone": True},
        "storms": [],
    }
    events = detect_tropical_tts_events(None, payload, _tropical_config(), bootstrap=True)
    assert events == []


def test_tornado_filter_affecting_home():
    cfg = {"only_affecting_home": True, "announce_cleared": False}
    assert passes_tornado_tts_filter({"affecting_home": True}, cfg)
    assert not passes_tornado_tts_filter({"affecting_home": False, "distance_miles": 5}, cfg)


def test_tornado_filter_distance():
    cfg = {"only_affecting_home": False, "max_distance_miles": 25, "announce_cleared": False}
    assert passes_tornado_tts_filter({"distance_miles": 10}, cfg)
    assert not passes_tornado_tts_filter({"distance_miles": 50}, cfg)


def test_tornado_cleared_message():
    msg = format_tornado_warning_for_tts({}, cleared=True)
    assert "all clear" in msg.lower()


def test_earthquake_filter_magnitude_and_distance():
    cfg = {
        "min_magnitude": 4.0,
        "max_distance_miles": 100,
        "tsunami_priority": True,
        "announce_updated": False,
        "announce_cleared": False,
    }
    assert passes_earthquake_tts_filter(
        {"magnitude": 4.5, "distance_miles": 50},
        cfg,
        "home_weather_earthquake_detected",
    )
    assert not passes_earthquake_tts_filter(
        {"magnitude": 3.0, "distance_miles": 50, "tsunami": 0},
        cfg,
        "home_weather_earthquake_detected",
    )


def test_earthquake_tsunami_priority_bypasses_magnitude():
    cfg = {
        "min_magnitude": 4.0,
        "max_distance_miles": 100,
        "tsunami_priority": True,
        "announce_updated": False,
        "announce_cleared": False,
    }
    assert passes_earthquake_tts_filter(
        {"magnitude": 3.0, "distance_miles": 50, "tsunami": 1},
        cfg,
        "home_weather_earthquake_detected",
    )


def test_format_earthquake_alert_message():
    msg = format_earthquake_alert_for_tts({
        "magnitude": 4.2,
        "place": "near San Jose",
        "distance_miles": 45,
        "depth_km": 8,
        "tsunami": 0,
    })
    assert "4.2" in msg or "Magnitude 4.2" in msg
    assert "San Jose" in msg
    assert "45" in msg
