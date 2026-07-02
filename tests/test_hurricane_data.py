"""Unit tests for hurricane data normalization."""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

from custom_components.home_weather.hurricane_data import (
    HurricaneDataCache,
    _group_features_by_storm_key,
    _merge_storm_lists,
    _normalize_arcgis_storm,
    _parse_kml_coordinates,
    get_home_coordinates,
)

FIXTURES = Path(__file__).parent / "fixtures"


def _load_fixture(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def test_normalize_arcgis_storm_shape():
    points = _load_fixture("hurricane_forecast_points.json")
    track = _load_fixture("hurricane_forecast_track.json")
    cone = _load_fixture("hurricane_forecast_cone.json")
    empty = {"type": "FeatureCollection", "features": []}

    storm = _normalize_arcgis_storm("AT1", points, track, cone, empty)
    assert storm is not None
    assert storm["name"] == "Example Storm"
    assert storm["basin"] == "AL"
    assert storm["id"].startswith("AL")
    assert storm["currentPosition"]["lat"] == 25.3
    assert storm["currentPosition"]["lon"] == -74.2
    assert storm["maxWindMph"] == 85
    assert storm["pressureMb"] == 980
    assert storm["movement"] == "NW at 14 mph"
    assert storm["category"] == 1
    assert storm["track"]["type"] == "LineString"
    assert storm["track"]["coordinates"][0] == [-74.2, 25.3]
    assert storm["cone"]["type"] == "Polygon"
    assert len(storm["forecastPoints"]) == 2
    assert storm["forecastPoints"][0]["hour"] == 0


def test_forecast_points_use_lon_lat_order():
    points = _load_fixture("hurricane_forecast_points.json")
    track = _load_fixture("hurricane_forecast_track.json")
    cone = _load_fixture("hurricane_forecast_cone.json")
    empty = {"type": "FeatureCollection", "features": []}

    storm = _normalize_arcgis_storm("AT1", points, track, cone, empty)
    current = storm["currentPosition"]
    # GeoJSON geometry is [-74.2, 25.3] => lon=-74.2, lat=25.3
    assert current["lon"] == -74.2
    assert current["lat"] == 25.3


def test_parse_kml_coordinates_lon_lat():
    coords = _parse_kml_coordinates("-74.2,25.3,0 -75.1,26.4,0", line=True)
    assert coords == [[-74.2, 25.3], [-75.1, 26.4]]


def test_hurricane_cache_ttl():
    cache = HurricaneDataCache()
    payload = {"storms": [], "outlook": {}, "summary": {"activeCount": 0}}
    cache.set(payload)
    assert cache.get_if_fresh() is not None
    cache._fetched_at = datetime.now(timezone.utc) - timedelta(minutes=16)
    assert cache.get_if_fresh() is None
    assert cache.get_stale() is not None


def test_merge_storm_lists_dedupes_by_id():
    primary = [{"id": "AL012026", "name": "Alpha"}]
    secondary = [
        {"id": "AL012026", "name": "Alpha duplicate"},
        {"id": "EP022026", "name": "Beta"},
    ]
    merged = _merge_storm_lists(primary, secondary)
    assert len(merged) == 2
    assert merged[1]["name"] == "Beta"


def test_group_features_by_storm_key():
    features = [
        {"properties": {"idp_source": "AL012026", "stormname": "Alpha"}},
        {"properties": {"idp_source": "AL012026", "stormname": "Alpha"}},
        {"properties": {"idp_source": "EP022026", "stormname": "Beta"}},
    ]
    grouped = _group_features_by_storm_key(features)
    assert len(grouped["AL012026"]) == 2
    assert len(grouped["EP022026"]) == 1


def test_get_home_coordinates_prefers_zone_home():
    hass = MagicMock()
    hass.config.latitude = 40.0
    hass.config.longitude = -74.0
    hass.states.get.return_value = SimpleNamespace(
        attributes={"latitude": 40.6782, "longitude": -73.9442},
    )
    home = get_home_coordinates(hass, {"weather_entity": "weather.home"})
    assert home["lat"] == 40.6782
    assert home["lon"] == -73.9442


def test_get_home_coordinates_ignores_weather_entity_grid_point():
    """Regression: weather entity lat/lon is a forecast grid point, not home."""
    hass = MagicMock()
    hass.config.latitude = 40.6782
    hass.config.longitude = -73.9442
    hass.states.get.side_effect = lambda eid: {
        "zone.home": SimpleNamespace(
            attributes={"latitude": 40.6782, "longitude": -73.9442},
        ),
        "weather.home": SimpleNamespace(
            attributes={"latitude": 40.2009, "longitude": -74.0271},
        ),
    }.get(eid)
    home = get_home_coordinates(hass, {"weather_entity": "weather.home"})
    assert home["lat"] == 40.6782
    assert home["lon"] == -73.9442
