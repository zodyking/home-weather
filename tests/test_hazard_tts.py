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
    format_volcano_alert_for_tts,
    format_wildfire_alert_for_tts,
    format_air_quality_alert_for_tts,
    passes_earthquake_tts_filter,
    passes_tornado_tts_filter,
    passes_volcano_tts_filter,
    passes_wildfire_tts_filter,
    passes_air_quality_tts_filter,
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
    cfg = {"announce_cleared": False}
    mon = {"only_affecting_home": True}
    assert passes_tornado_tts_filter({"affecting_home": True}, cfg, mon)
    assert not passes_tornado_tts_filter({"affecting_home": False, "distance_miles": 5}, cfg, mon)


def test_tornado_filter_distance():
    cfg = {"announce_cleared": False}
    mon = {"only_affecting_home": False, "max_distance_miles": 25}
    assert passes_tornado_tts_filter({"distance_miles": 10}, cfg, mon)
    assert not passes_tornado_tts_filter({"distance_miles": 50}, cfg, mon)


def test_tornado_filter_alert_bypass():
    """Alert scope 'all' announces regardless of distance / affecting-home."""
    cfg = {"announce_cleared": False}
    mon = {"only_affecting_home": True, "max_distance_miles": 25, "alert_zone_mode": "all"}
    assert passes_tornado_tts_filter({"affecting_home": False, "distance_miles": 500}, cfg, mon)


def test_tornado_cleared_message():
    msg = format_tornado_warning_for_tts({}, cleared=True)
    assert "all clear" in msg.lower()


def test_earthquake_filter_magnitude_and_distance():
    cfg = {
        "tsunami_priority": True,
        "announce_updated": False,
        "announce_cleared": False,
    }
    mon = {"min_magnitude": 4.0, "radius_miles": 100}
    assert passes_earthquake_tts_filter(
        {"magnitude": 4.5, "distance_miles": 50},
        cfg,
        "home_weather_earthquake_detected",
        mon,
    )
    assert not passes_earthquake_tts_filter(
        {"magnitude": 3.0, "distance_miles": 50, "tsunami": 0},
        cfg,
        "home_weather_earthquake_detected",
        mon,
    )


def test_earthquake_tsunami_priority_bypasses_magnitude():
    cfg = {
        "tsunami_priority": True,
        "announce_updated": False,
        "announce_cleared": False,
    }
    mon = {"min_magnitude": 4.0, "radius_miles": 100}
    assert passes_earthquake_tts_filter(
        {"magnitude": 3.0, "distance_miles": 50, "tsunami": 1},
        cfg,
        "home_weather_earthquake_detected",
        mon,
    )


def test_earthquake_filter_alert_bypass():
    """Alert scope 'all' announces regardless of magnitude / distance."""
    cfg = {"tsunami_priority": True, "announce_updated": False, "announce_cleared": False}
    mon = {"min_magnitude": 4.0, "radius_miles": 100, "alert_zone_mode": "all"}
    assert passes_earthquake_tts_filter(
        {"magnitude": 1.2, "distance_miles": 4000, "tsunami": 0},
        cfg,
        "home_weather_earthquake_detected",
        mon,
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


def test_volcano_filter_min_level():
    cfg = {"announce_cleared": False}
    mon = {"min_alert_level": "watch"}
    assert passes_volcano_tts_filter(
        {"activity_level": "watch"}, cfg, "home_weather_volcano_activity_detected", mon
    )
    assert passes_volcano_tts_filter(
        {"activity_level": "warning"}, cfg, "home_weather_volcano_activity_updated", mon
    )
    assert not passes_volcano_tts_filter(
        {"activity_level": "advisory"}, cfg, "home_weather_volcano_activity_detected", mon
    )


def test_volcano_filter_alert_bypass():
    """Alert scope 'all' announces regardless of activity level / distance."""
    cfg = {"announce_cleared": False}
    mon = {"min_alert_level": "warning", "radius_miles": 100, "alert_zone_mode": "all"}
    assert passes_volcano_tts_filter(
        {"activity_level": "advisory", "distance_miles": 5000}, cfg,
        "home_weather_volcano_activity_detected", mon,
    )


def test_volcano_filter_cleared_toggle():
    payload = {"activity_level": "warning", "name": "Test"}
    mon = {"min_alert_level": "watch"}
    assert not passes_volcano_tts_filter(
        payload, {"announce_cleared": False},
        "home_weather_volcano_activity_cleared", mon,
    )
    assert passes_volcano_tts_filter(
        payload, {"announce_cleared": True},
        "home_weather_volcano_activity_cleared", mon,
    )


def test_format_volcano_alert_message():
    msg = format_volcano_alert_for_tts({
        "name": "Mount St. Helens",
        "activity_level": "watch",
        "distance_miles": 52,
        "synopsis": "Elevated seismicity detected.",
    })
    assert "Mount St. Helens" in msg
    assert "watch" in msg
    assert "52" in msg
    assert "Elevated seismicity" in msg


def test_format_volcano_cleared_message():
    msg = format_volcano_alert_for_tts({"name": "Mount Test"}, cleared=True)
    assert "Mount Test" in msg
    assert "cleared" in msg.lower()


def test_wildfire_tts_filter_respects_zone_and_acres():
    cfg = {"announce_cleared": False}
    mon = {"radius_miles": 100, "min_acres": 500, "alert_zone_mode": "zone"}
    assert passes_wildfire_tts_filter(
        {"distance_miles": 50, "acres": 1500}, cfg, "home_weather_wildfire_detected", mon
    )
    assert not passes_wildfire_tts_filter(
        {"distance_miles": 150, "acres": 1500}, cfg, "home_weather_wildfire_detected", mon
    )


def test_format_wildfire_alert_message():
    msg = format_wildfire_alert_for_tts({
        "name": "Ridge Fire",
        "location": "Placer County, CA",
        "distance_miles": 42,
        "acres": 2500,
        "percent_contained": 15,
    })
    assert "Ridge Fire" in msg
    assert "2500" in msg


def test_air_quality_tts_filter_respects_zone_and_category():
    cfg = {"announce_cleared": False}
    mon = {"radius_miles": 50, "min_category_level": 3, "alert_zone_mode": "zone"}
    assert passes_air_quality_tts_filter(
        {"distance_miles": 10, "category_level": 4}, cfg,
        "home_weather_air_quality_unhealthy", mon,
    )
    assert not passes_air_quality_tts_filter(
        {"distance_miles": 10, "category_level": 2}, cfg,
        "home_weather_air_quality_unhealthy", mon,
    )


def test_format_air_quality_alert_message():
    msg = format_air_quality_alert_for_tts({
        "name": "Sample City",
        "state": "NY",
        "aqi": 156,
        "category": "Unhealthy",
        "distance_miles": 8,
    })
    assert "Sample City" in msg
    assert "Unhealthy" in msg
    assert "156" in msg
