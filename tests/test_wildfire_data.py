"""Unit tests for NIFC WFIGS wildfire parsing."""
from __future__ import annotations

from custom_components.home_weather.wildfire_data import (
    US_WILDFIRE_ENVELOPE,
    _arcgis_bbox_envelope,
    _wildfire_query_envelope,
    arcgis_point_feature,
    arcgis_polygon_feature,
    build_coordinator_payload,
    detect_wildfire_events,
    passes_wildfire_filter,
    passes_wildfire_geofield_filter,
    wildfire_color,
)

SAMPLE_POINT = {
    "attributes": {
        "IncidentName": "Test Fire",
        "FireDiscoveryDateTime": 1764784140000,
        "PercentContained": 25,
        "IncidentSize": 1500,
        "IncidentTypeCategory": "WF",
        "POOState": "US-CA",
        "POOCounty": "Placer",
        "FireCause": "Lightning",
    },
    "geometry": {"x": -120.5, "y": 39.2},
}

SAMPLE_RX = {
    "attributes": {
        "IncidentName": "Prescribed Burn",
        "IncidentSize": 900,
        "IncidentTypeCategory": "RX",
        "POOState": "US-SD",
        "POOCounty": "Lawrence",
    },
    "geometry": {"x": -103.8, "y": 44.2},
}

SAMPLE_PERIMETER = {
    "attributes": {
        "attr_IncidentName": "Porcupine Creek",
        "attr_IncidentSize": 2490.23,
        "attr_PercentContained": 60,
        "attr_POOState": "US-WY",
        "poly_GISAcres": 2542.69,
    },
    "geometry": {
        "rings": [[[-110.0, 44.0], [-109.9, 44.0], [-109.9, 44.1], [-110.0, 44.1], [-110.0, 44.0]]]
    },
}

HOME = {"lat": 40.0, "lon": -100.0}


def test_wildfire_query_envelope_uses_local_radius():
    envelope = _wildfire_query_envelope(
        HOME,
        {"zone_mode": "zone", "radius_miles": 100},
    )
    local = _arcgis_bbox_envelope(HOME, 300)
    assert envelope == local


def test_wildfire_query_envelope_all_mode_uses_us_bounds():
    envelope = _wildfire_query_envelope(HOME, {"zone_mode": "all", "radius_miles": 100})
    assert envelope == US_WILDFIRE_ENVELOPE


def test_arcgis_point_feature():
    feature = arcgis_point_feature(
        SAMPLE_POINT["attributes"], SAMPLE_POINT["geometry"], home=HOME, layer="incident"
    )
    assert feature is not None
    props = feature["properties"]
    assert props["name"] == "Test Fire"
    assert props["acres"] == 1500
    assert props["category"] == "WF"
    assert props["state"] == "CA"
    assert props["distance_miles"] is not None


def test_exclude_prescribed_filter():
    rx = arcgis_point_feature(
        SAMPLE_RX["attributes"], SAMPLE_RX["geometry"], home=HOME, layer="incident"
    )
    assert rx is not None
    cfg = {"enabled": True, "exclude_prescribed": True, "min_acres": 0, "show_perimeters": True}
    assert not passes_wildfire_filter(rx["properties"], cfg)


def test_wildfire_color_by_size():
    assert wildfire_color(50, None, "WF") == "#ffa726"
    assert wildfire_color(1500, None, "WF") == "#e53935"
    assert wildfire_color(15000, None, "WF") == "#b71c1c"
    assert wildfire_color(500, 100, "WF") == "#ffb74d"


def test_build_coordinator_payload():
    point = arcgis_point_feature(
        SAMPLE_POINT["attributes"], SAMPLE_POINT["geometry"], home=HOME, layer="incident"
    )
    perimeter = arcgis_polygon_feature(
        SAMPLE_PERIMETER["attributes"], SAMPLE_PERIMETER["geometry"], home=HOME, layer="perimeter"
    )
    payload = build_coordinator_payload(
        [point],
        [perimeter],
        {
            "enabled": True,
            "show_on_map": True,
            "show_perimeters": True,
            "min_acres": 100,
            "exclude_prescribed": True,
        },
    )
    assert payload["incident_count"] == 1
    assert payload["perimeter_count"] == 1
    assert payload["map_count"] == 2
    assert payload["nearest_incident"]["name"] == "Test Fire"


def test_geofield_filters_by_radius():
    point = arcgis_point_feature(
        SAMPLE_POINT["attributes"], SAMPLE_POINT["geometry"], home=HOME, layer="incident"
    )
    props = point["properties"]
    cfg = {
        "enabled": True,
        "zone_mode": "zone",
        "radius_miles": 50,
        "min_acres": 100,
        "exclude_prescribed": True,
    }
    assert passes_wildfire_geofield_filter({**props, "distance_miles": 40}, cfg)
    assert not passes_wildfire_geofield_filter({**props, "distance_miles": 120}, cfg)


def test_build_coordinator_payload_geofield_and_alerts():
    point = arcgis_point_feature(
        SAMPLE_POINT["attributes"], SAMPLE_POINT["geometry"], home=HOME, layer="incident"
    )
    cfg = {
        "enabled": True,
        "zone_mode": "zone",
        "alert_zone_mode": "zone",
        "radius_miles": 5000,
        "show_on_map": True,
        "show_perimeters": True,
        "min_acres": 100,
        "exclude_prescribed": True,
    }
    payload = build_coordinator_payload([point], [], cfg)
    assert payload["in_geofield"] is True
    assert payload["geofield_count"] == 1
    assert payload["primary_geofield"]["name"] == "Test Fire"
    assert len(payload["alert_events"]) == 1


def test_detect_wildfire_events_new_and_cleared():
    incident = {
        "id": "wf-1",
        "name": "Test Fire",
        "acres": 1500,
        "percent_contained": 25,
        "category": "WF",
        "distance_miles": 40,
    }
    events = detect_wildfire_events({}, [incident])
    assert events[0][0] == "home_weather_wildfire_detected"
    cleared = detect_wildfire_events({"wf-1": incident}, [])
    assert cleared[0][0] == "home_weather_wildfire_cleared"
