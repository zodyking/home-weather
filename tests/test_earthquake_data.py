"""Unit tests for USGS earthquake parsing and event detection."""
from __future__ import annotations

from custom_components.home_weather.earthquake_data import (
    build_coordinator_payload,
    detect_earthquake_events,
    parse_earthquake_feature,
    parse_earthquake_features,
    parse_earthquake_features_for_map,
    passes_earthquake_filters,
    passes_map_filters,
)

HOME = {"lat": 35.1, "lon": -96.1}

NEAR_EQ = {
    "type": "Feature",
    "id": "us7000abc1",
    "properties": {
        "id": "us7000abc1",
        "mag": 3.2,
        "place": "12 km NE of Test City, Oklahoma",
        "time": 1719000000000,
        "updated": 1719001000000,
        "url": "https://earthquake.usgs.gov/earthquakes/eventpage/us7000abc1",
        "felt": 12,
        "tsunami": 0,
        "type": "earthquake",
    },
    "geometry": {
        "type": "Point",
        "coordinates": [-96.0, 35.2, 8.5],
    },
}

LOW_MAG_EQ = {
    **NEAR_EQ,
    "id": "us7000abc2",
    "properties": {
        **NEAR_EQ["properties"],
        "id": "us7000abc2",
        "mag": 2.0,
    },
}

FAR_EQ = {
    **NEAR_EQ,
    "id": "us7000abc3",
    "properties": {
        **NEAR_EQ["properties"],
        "id": "us7000abc3",
        "mag": 4.8,
        "place": "Off coast of Alaska",
    },
    "geometry": {
        "type": "Point",
        "coordinates": [-150.0, 60.0, 10.0],
    },
}

TSUNAMI_EQ = {
    **NEAR_EQ,
    "id": "us7000abc4",
    "properties": {
        **NEAR_EQ["properties"],
        "id": "us7000abc4",
        "mag": 5.5,
        "tsunami": 1,
    },
}

NO_GEOMETRY_EQ = {
    "type": "Feature",
    "properties": {
        "id": "us7000abc5",
        "mag": 3.0,
        "place": "Unknown",
    },
}

DEFAULT_EQ_CONFIG = {
    "enabled": True,
    "min_magnitude": 2.5,
    "radius_miles": 500,
    "feed_type": "all_hour",
    "tsunami_alert_enabled": True,
    "map_show_worldwide": True,
    "map_min_magnitude": 4.5,
    "map_feed_type": "all_day",
}


def test_valid_earthquake_parsed():
    event = parse_earthquake_feature(NEAR_EQ, HOME)
    assert event is not None
    assert event["id"] == "us7000abc1"
    assert event["magnitude"] == 3.2
    assert event["place"] == "12 km NE of Test City, Oklahoma"
    assert event["time"] == 1719000000000
    assert event["updated"] == 1719001000000
    assert event["url"].endswith("us7000abc1")
    assert event["felt"] == 12
    assert event["tsunami"] == 0
    assert event["type"] == "earthquake"
    assert event["longitude"] == -96.0
    assert event["latitude"] == 35.2
    assert event["depth_km"] == 8.5
    assert event["distance_miles"] is not None
    assert event["distance_miles"] < 100


def test_below_magnitude_ignored():
    event = parse_earthquake_feature(LOW_MAG_EQ, HOME)
    assert event is not None
    assert not passes_earthquake_filters(event, DEFAULT_EQ_CONFIG)

    events = parse_earthquake_features([LOW_MAG_EQ, NEAR_EQ], HOME, DEFAULT_EQ_CONFIG)
    assert len(events) == 1
    assert events[0]["id"] == "us7000abc1"


def test_outside_radius_ignored():
    event = parse_earthquake_feature(FAR_EQ, HOME)
    assert event is not None
    assert not passes_earthquake_filters(event, DEFAULT_EQ_CONFIG)

    events = parse_earthquake_features([FAR_EQ, NEAR_EQ], HOME, DEFAULT_EQ_CONFIG)
    assert len(events) == 1
    assert events[0]["id"] == "us7000abc1"


def test_tsunami_flag_detected_and_filtered_when_disabled():
    event = parse_earthquake_feature(TSUNAMI_EQ, HOME)
    assert event is not None
    assert event["tsunami"] == 1
    assert passes_earthquake_filters(event, DEFAULT_EQ_CONFIG)

    disabled_config = {**DEFAULT_EQ_CONFIG, "tsunami_alert_enabled": False}
    assert not passes_earthquake_filters(event, disabled_config)


def test_duplicate_id_ignored_on_second_detect():
    events = parse_earthquake_features([NEAR_EQ], HOME, DEFAULT_EQ_CONFIG)
    tracked: dict[str, dict] = {}

    first = detect_earthquake_events(tracked, events)
    assert len(first) == 1
    assert first[0][0] == "home_weather_earthquake_detected"

    tracked = {e["id"]: e for e in events}
    second = detect_earthquake_events(tracked, events)
    assert second == []


def test_missing_geometry_handled_safely():
    event = parse_earthquake_feature(NO_GEOMETRY_EQ, HOME)
    assert event is None

    events = parse_earthquake_features([NO_GEOMETRY_EQ, NEAR_EQ], HOME, DEFAULT_EQ_CONFIG)
    assert len(events) == 1
    assert events[0]["id"] == "us7000abc1"


def test_build_coordinator_payload_nearest_first(monkeypatch):
    events = parse_earthquake_features([NEAR_EQ], HOME, DEFAULT_EQ_CONFIG)
    map_events = parse_earthquake_features_for_map([FAR_EQ, LOW_MAG_EQ], HOME, DEFAULT_EQ_CONFIG)
    payload = build_coordinator_payload(events, map_events)
    assert payload["active_count"] == 1
    assert payload["map_count"] == 2
    assert payload["nearby_active"] is True
    assert payload["primary_event"]["id"] == "us7000abc1"
    assert payload["geojson"]["type"] == "FeatureCollection"
    assert len(payload["geojson"]["features"]) == 2
    nearby_flags = {f["properties"]["id"]: f["properties"]["nearby"] for f in payload["geojson"]["features"]}
    assert nearby_flags["us7000abc1"] is True
    assert nearby_flags["us7000abc3"] is False


def test_build_coordinator_payload_merges_nearby_live_events(monkeypatch):
    events = parse_earthquake_features([NEAR_EQ], HOME, DEFAULT_EQ_CONFIG)
    map_events = parse_earthquake_features_for_map([FAR_EQ], HOME, DEFAULT_EQ_CONFIG)
    payload = build_coordinator_payload(events, map_events)
    assert payload["active_count"] == 1
    assert payload["map_count"] == 2
    ids = {f["properties"]["id"] for f in payload["geojson"]["features"]}
    assert ids == {"us7000abc1", "us7000abc3"}


def test_map_filters_ignore_radius(monkeypatch):
    event = parse_earthquake_feature(FAR_EQ, HOME)
    assert event is not None
    assert not passes_earthquake_filters(event, DEFAULT_EQ_CONFIG)
    assert passes_map_filters(event, DEFAULT_EQ_CONFIG)

    map_events = parse_earthquake_features_for_map([FAR_EQ, LOW_MAG_EQ, NEAR_EQ], HOME, DEFAULT_EQ_CONFIG)
    assert len(map_events) == 1
    assert map_events[0]["id"] == "us7000abc3"


def test_build_coordinator_payload_no_worldwide_fallback(monkeypatch):
    events = parse_earthquake_features([], HOME, DEFAULT_EQ_CONFIG)
    map_events = parse_earthquake_features_for_map([FAR_EQ], HOME, DEFAULT_EQ_CONFIG)
    payload = build_coordinator_payload(events, map_events)
    assert payload["active_count"] == 0
    assert payload["nearby_active"] is False
    assert payload["in_geofield"] is False
    assert payload["primary_event"] is None
    assert payload["nearest_place"] is None


def test_build_coordinator_payload_alert_events_default_to_events(monkeypatch):
    events = parse_earthquake_features([NEAR_EQ], HOME, DEFAULT_EQ_CONFIG)
    payload = build_coordinator_payload(events)
    assert payload["alert_events"] == events


def test_build_coordinator_payload_alert_events_override(monkeypatch):
    """When the alert scope bypasses the zone, alert_events carries the wider feed."""
    events = parse_earthquake_features([NEAR_EQ], HOME, DEFAULT_EQ_CONFIG)
    alert_events = [parse_earthquake_feature(NEAR_EQ, HOME), parse_earthquake_feature(FAR_EQ, HOME)]
    payload = build_coordinator_payload(events, None, alert_events)
    assert len(payload["events"]) == 1
    assert len(payload["alert_events"]) == 2
