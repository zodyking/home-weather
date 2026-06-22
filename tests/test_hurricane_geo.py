"""Unit tests for hurricane geospatial helpers."""
from __future__ import annotations

from custom_components.home_weather.hurricane_geo import (
    format_movement,
    get_nearest_forecast_point,
    get_storm_threat_status,
    haversine_distance_miles,
    is_point_inside_polygon,
    knots_to_mph,
)

SAMPLE_CONE = {
    "type": "Polygon",
    "coordinates": [
        [
            [-75.0, 24.8],
            [-76.2, 26.5],
            [-77.0, 28.1],
            [-75.5, 29.0],
            [-74.0, 27.5],
            [-75.0, 24.8],
        ]
    ],
}


def test_haversine_nyc_to_miami_approximate():
    # NYC ~ 40.7128, -74.0060; Miami ~ 25.7617, -80.1918
    dist = haversine_distance_miles(40.7128, -74.0060, 25.7617, -80.1918)
    assert 1050 < dist < 1150


def test_haversine_same_point_is_zero():
    assert haversine_distance_miles(25.0, -80.0, 25.0, -80.0) == 0.0


def test_point_inside_cone():
    home = {"lat": 26.0, "lon": -75.5}
    assert is_point_inside_polygon(home, SAMPLE_CONE) is True


def test_point_outside_cone():
    home = {"lat": 40.0, "lon": -74.0}
    assert is_point_inside_polygon(home, SAMPLE_CONE) is False


def test_geojson_coordinate_order_lon_lat():
    """Polygon ring uses [lon, lat]; home lat/lon must not be reversed."""
    # Point at lon=-75.5, lat=26.0 is inside the sample cone
    inside = is_point_inside_polygon({"lat": 26.0, "lon": -75.5}, SAMPLE_CONE)
    # Swapped interpretation would put point in wrong place
    assert inside is True
    outside = is_point_inside_polygon({"lat": -75.5, "lon": 26.0}, SAMPLE_CONE)
    assert outside is False


def test_get_nearest_forecast_point():
    home = {"lat": 28.0, "lon": -76.0}
    points = [
        {"hour": 0, "lat": 25.3, "lon": -74.2},
        {"hour": 12, "lat": 26.4, "lon": -75.1},
        {"hour": 24, "lat": 27.8, "lon": -76.5},
    ]
    nearest = get_nearest_forecast_point(home, points)
    assert nearest is not None
    assert nearest["hour"] == 24
    assert nearest["distanceMiles"] < 100


def test_threat_level_none_when_far_outside():
    home = {"lat": 40.0, "lon": -74.0}
    storm = {
        "cone": SAMPLE_CONE,
        "forecastPoints": [{"hour": 12, "lat": 20.0, "lon": -60.0}],
        "currentPosition": {"lat": 20.0, "lon": -60.0},
    }
    status = get_storm_threat_status(home, storm)
    assert status["threatLevel"] == "none"
    assert status["insideCone"] is False


def test_threat_level_watch_inside_cone():
    home = {"lat": 26.0, "lon": -75.5}
    storm = {
        "cone": SAMPLE_CONE,
        "forecastPoints": [{"hour": 12, "lat": 26.4, "lon": -75.1}],
        "currentPosition": {"lat": 26.4, "lon": -75.1},
    }
    status = get_storm_threat_status(home, storm)
    assert status["insideCone"] is True
    assert status["threatLevel"] in ("watch", "high")


def test_threat_level_monitor_within_250_miles():
    home = {"lat": 28.0, "lon": -76.0}
    storm = {
        "cone": {
            "type": "Polygon",
            "coordinates": [[[-80, 20], [-79, 21], [-78, 20], [-80, 20]]],
        },
        "forecastPoints": [{"hour": 12, "lat": 28.5, "lon": -76.2}],
        "currentPosition": {"lat": 28.5, "lon": -76.2},
    }
    status = get_storm_threat_status(home, storm)
    assert status["threatLevel"] in ("monitor", "watch", "high")
    assert status["nearestTrackDistanceMiles"] is not None
    assert status["nearestTrackDistanceMiles"] <= 250


def test_knots_to_mph_conversion():
    assert knots_to_mph(74) == 85


def test_format_movement():
    assert format_movement(315, 12) == "NW at 14 mph"
