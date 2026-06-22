"""Unit tests for tornado warning parsing and priority logic."""
from __future__ import annotations

from datetime import timedelta
from unittest.mock import AsyncMock, MagicMock, patch

from homeassistant.util import dt as dt_util

from custom_components.home_weather.tornado_data import (
    build_coordinator_payload,
    build_geojson_feature_collection,
    detect_tornado_events,
    is_alert_expired,
    is_binary_warning_on,
    parse_tornado_feature,
    parse_tornado_features,
    sort_tornado_alerts_by_priority,
)

HOME = {"lat": 35.1, "lon": -96.1}

TORNADO_FEATURE = {
    "type": "Feature",
    "properties": {
        "id": "urn:oid:1.1",
        "event": "Tornado Warning",
        "headline": "Tornado Warning for Test County",
        "description": "A tornado was observed.",
        "instruction": "Take shelter now.",
        "severity": "Extreme",
        "urgency": "Immediate",
        "certainty": "Observed",
        "onset": "2026-06-22T18:00:00-05:00",
        "effective": "2026-06-22T18:00:00-05:00",
        "expires": "2026-06-22T19:00:00-05:00",
        "senderName": "NWS Norman OK",
        "areaDesc": "Test County",
        "affectedZones": ["https://api.weather.gov/zones/county/OKC027"],
    },
    "geometry": {
        "type": "Polygon",
        "coordinates": [
            [
                [-96.5, 35.0],
                [-96.0, 35.5],
                [-95.5, 35.0],
                [-96.0, 34.5],
                [-96.5, 35.0],
            ]
        ],
    },
}

FAR_TORNADO_FEATURE = {
    **TORNADO_FEATURE,
    "properties": {
        **TORNADO_FEATURE["properties"],
        "id": "urn:oid:2.2",
        "headline": "Distant Tornado Warning",
        "severity": "Severe",
        "expires": "2026-06-22T20:00:00-05:00",
    },
    "geometry": {
        "type": "Polygon",
        "coordinates": [
            [
                [-90.0, 30.0],
                [-89.5, 30.5],
                [-89.0, 30.0],
                [-90.0, 30.0],
            ]
        ],
    },
}


def test_parse_tornado_feature_extracts_fields():
    alert = parse_tornado_feature(TORNADO_FEATURE, HOME)
    assert alert is not None
    assert alert["alert_id"] == "urn:oid:1.1"
    assert alert["event"] == "Tornado Warning"
    assert alert["headline"] == "Tornado Warning for Test County"
    assert alert["severity"] == "Extreme"
    assert alert["affecting_home"] is True
    assert alert["distance_miles"] == 0.0
    assert alert["geometry"]["type"] == "Polygon"


def test_parse_tornado_feature_ignores_non_tornado_event():
    feature = {
        "properties": {"event": "Severe Thunderstorm Warning", "id": "x"},
        "geometry": TORNADO_FEATURE["geometry"],
    }
    assert parse_tornado_feature(feature, HOME) is None


def test_expired_alert_ignored():
    expired = {
        **TORNADO_FEATURE,
        "properties": {
            **TORNADO_FEATURE["properties"],
            "expires": (dt_util.now() - timedelta(hours=1)).isoformat(),
        },
    }
    assert parse_tornado_feature(expired, HOME) is None
    assert is_alert_expired(expired["properties"]) is True


def test_missing_geometry_still_parses():
    feature = {
        "properties": TORNADO_FEATURE["properties"],
        "geometry": None,
    }
    alert = parse_tornado_feature(feature, HOME)
    assert alert is not None
    assert alert["geometry"] is None
    assert alert["affecting_home"] is False


def test_empty_api_response():
    payload = build_coordinator_payload([])
    assert payload["active_count"] == 0
    assert payload["primary_alert"] is None
    assert payload["geojson"]["features"] == []


def test_multiple_alerts_sorted_by_priority():
    alerts = parse_tornado_features([FAR_TORNADO_FEATURE, TORNADO_FEATURE], HOME)
    assert len(alerts) == 2
    assert alerts[0]["alert_id"] == "urn:oid:1.1"
    assert alerts[0]["affecting_home"] is True


def test_sort_alerts_prefers_home_then_distance_then_severity():
    near = parse_tornado_feature(TORNADO_FEATURE, HOME)
    far = parse_tornado_feature(FAR_TORNADO_FEATURE, HOME)
    assert near and far
    sorted_alerts = sort_tornado_alerts_by_priority([far, near])
    assert sorted_alerts[0]["alert_id"] == near["alert_id"]


def test_build_geojson_feature_collection():
    alerts = parse_tornado_features([TORNADO_FEATURE], HOME)
    fc = build_geojson_feature_collection(alerts)
    assert fc["type"] == "FeatureCollection"
    assert len(fc["features"]) == 1
    assert fc["features"][0]["properties"]["event"] == "Tornado Warning"


def test_binary_warning_on_without_zone_requires_home_intersection():
    alerts = parse_tornado_features([FAR_TORNADO_FEATURE], HOME)
    assert is_binary_warning_on(alerts, {}) is False
    home_alerts = parse_tornado_features([TORNADO_FEATURE], HOME)
    assert is_binary_warning_on(home_alerts, {}) is True


def test_binary_warning_on_with_zone_any_alert():
    alerts = parse_tornado_features([FAR_TORNADO_FEATURE], HOME)
    assert is_binary_warning_on(alerts, {"nws_zone": "OKZ040"}) is True


def test_detect_tornado_events_issued_updated_cleared():
    alert = parse_tornado_feature(TORNADO_FEATURE, HOME)
    assert alert
    previous = {}

    issued = detect_tornado_events(previous, [alert])
    assert issued[0][0] == "home_weather_tornado_warning_issued"

    tracked = {alert["alert_id"]: alert}
    updated_alert = {**alert, "severity": "Severe"}
    updated = detect_tornado_events(tracked, [updated_alert])
    assert updated[0][0] == "home_weather_tornado_warning_updated"

    cleared = detect_tornado_events(tracked, [])
    assert cleared[0][0] == "home_weather_tornado_warning_cleared"


def test_async_fetch_handles_api_error():
    import asyncio
    from custom_components.home_weather.tornado_data import async_fetch_tornado_alerts

    hass = MagicMock()
    session = MagicMock()
    response = MagicMock()
    response.status = 500
    response.__aenter__ = AsyncMock(return_value=response)
    response.__aexit__ = AsyncMock(return_value=None)

    session.get = MagicMock(return_value=response)
    with patch(
        "custom_components.home_weather.tornado_data.async_get_clientsession",
        return_value=session,
    ), patch(
        "custom_components.home_weather.tornado_data.get_home_coordinates",
        return_value=HOME,
    ):
        payload = asyncio.run(async_fetch_tornado_alerts(hass, {}))
    assert payload["active_count"] == 0
