"""Unit tests for sensor-scope nearest selection helpers."""
from __future__ import annotations

from custom_components.home_weather.air_quality_data import (
    build_coordinator_payload,
    pick_nearest_air_quality,
    pick_primary_air_quality,
)
from custom_components.home_weather.hurricane_data import (
    build_hurricane_sensor_payload,
    pick_nearest_storm,
)
from custom_components.home_weather.sensor_scope import pick_nearest_by_distance
from custom_components.home_weather.tornado_data import build_coordinator_payload as build_tornado_payload


def test_pick_nearest_by_distance_ignores_recency():
    records = [
        {"id": "recent", "distance_miles": 120.0, "time": 999},
        {"id": "near", "distance_miles": 12.0, "time": 1},
    ]
    nearest = pick_nearest_by_distance(records)
    assert nearest["id"] == "near"


def test_air_quality_bypass_uses_nearest_not_highest_aqi():
    areas = [
        {
            "id": "far-bad",
            "name": "Far City",
            "state": "TX",
            "aqi": 180,
            "category_level": 4,
            "lat": 40.0,
            "lon": -100.0,
        },
        {
            "id": "near-good",
            "name": "Near Town",
            "state": "OK",
            "aqi": 55,
            "category_level": 2,
            "lat": 35.1,
            "lon": -96.1,
        },
    ]
    config = {
        "enabled": True,
        "zone_mode": "all",
        "min_category_level": 1,
        "show_on_map": True,
    }
    payload = build_coordinator_payload(areas, config, home={"lat": 35.1, "lon": -96.1})
    assert payload["primary_geofield"]["id"] == "near-good"
    assert pick_nearest_air_quality(payload["sensor_events"])["id"] == "near-good"
    assert pick_primary_air_quality(payload["sensor_events"])["id"] == "far-bad"


def test_tornado_bypass_primary_is_nearest_alert():
    alerts = [
        {
            "alert_id": "far",
            "distance_miles": 900.0,
            "severity": "Extreme",
            "affecting_home": False,
        },
        {
            "alert_id": "near",
            "distance_miles": 40.0,
            "severity": "Moderate",
            "affecting_home": False,
        },
    ]
    payload = build_tornado_payload(
        alerts,
        {"tornado_monitoring": {"zone_mode": "all", "enabled": True}},
    )
    assert payload["primary_geofield"]["alert_id"] == "near"


def test_hurricane_bypass_picks_nearest_track_when_center_missing():
    home = {"lat": 35.1, "lon": -96.1}
    storms = [
        {
            "id": "far",
            "name": "Far Storm",
            "threat": {
                "threatLevel": "watch",
                "distanceToCenterMiles": None,
                "nearestTrackDistanceMiles": 800.0,
                "nearestForecastHour": 72,
            },
            "forecastPoints": [{"lat": 30.0, "lon": -80.0, "hour": 72}],
        },
        {
            "id": "near",
            "name": "Near Storm",
            "threat": {
                "threatLevel": "watch",
                "distanceToCenterMiles": None,
                "nearestTrackDistanceMiles": 120.0,
                "nearestForecastHour": 24,
            },
            "forecastPoints": [{"lat": 36.0, "lon": -95.0, "hour": 24}],
        },
    ]
    closest, dist, hour = pick_nearest_storm(storms, home)
    assert closest["id"] == "near"
    assert dist == 120.0
    assert hour == 24

    payload = build_hurricane_sensor_payload(
        {"storms": storms, "summary": {"threatLevel": "watch"}, "home": home},
        {"hurricane_monitoring": {"enabled": True, "zone_mode": "all", "min_threat_level": "watch"}},
    )
    assert payload["primary_geofield"]["id"] == "near"
    assert payload["sensor_summary"]["closest_storm_name"] == "Near Storm"
    assert payload["sensor_summary"]["distance_miles"] == 120.0
