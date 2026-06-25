"""Unit tests for tornado geofield filtering."""
from __future__ import annotations

from datetime import timedelta

from homeassistant.util import dt as dt_util

from custom_components.home_weather.tornado_data import (
    build_coordinator_payload,
    filter_alerts_for_geofield,
    parse_tornado_features,
)

HOME = {"lat": 35.1, "lon": -96.1}


def _future_expires(hours: int = 2) -> str:
    return (dt_util.now() + timedelta(hours=hours)).isoformat()


def _tornado_feature(alert_id: str, coords: list[list[list[float]]]) -> dict:
    return {
        "type": "Feature",
        "properties": {
            "id": alert_id,
            "event": "Tornado Warning",
            "headline": f"Tornado Warning {alert_id}",
            "severity": "Extreme",
            "expires": _future_expires(),
            "areaDesc": "Test County",
        },
        "geometry": {"type": "Polygon", "coordinates": coords},
    }


NEAR_POLYGON = [
    [
        [-96.5, 35.0],
        [-96.0, 35.5],
        [-95.5, 35.0],
        [-96.0, 34.5],
        [-96.5, 35.0],
    ]
]

FAR_POLYGON = [
    [
        [-90.0, 30.0],
        [-89.5, 30.5],
        [-89.0, 30.0],
        [-90.0, 30.0],
    ]
]

TORNADO_FEATURE = _tornado_feature("urn:oid:1.1", NEAR_POLYGON)
FAR_TORNADO_FEATURE = _tornado_feature("urn:oid:2.2", FAR_POLYGON)


def test_geofield_only_includes_home_polygon_when_home_only():
    alerts = parse_tornado_features([TORNADO_FEATURE, FAR_TORNADO_FEATURE], HOME)
    config = {"tornado_alerts": {"only_affecting_home": True, "max_distance_miles": 25}}
    geofield = filter_alerts_for_geofield(alerts, config)
    assert len(geofield) == 1
    assert geofield[0]["alert_id"] == "urn:oid:1.1"


def test_geofield_respects_max_distance_when_not_home_only():
    alerts = parse_tornado_features([TORNADO_FEATURE, FAR_TORNADO_FEATURE], HOME)
    config = {"tornado_alerts": {"only_affecting_home": False, "max_distance_miles": 5000}}
    geofield = filter_alerts_for_geofield(alerts, config)
    assert len(geofield) == 2


def test_coordinator_payload_uses_geofield_not_all_us_alerts():
    alerts = parse_tornado_features([TORNADO_FEATURE, FAR_TORNADO_FEATURE], HOME)
    config = {"tornado_alerts": {"only_affecting_home": True, "max_distance_miles": 25}}
    payload = build_coordinator_payload(alerts, config)
    assert payload["map_count"] == 2
    assert payload["active_count"] == 1
    assert payload["in_geofield"] is True
    assert payload["primary_geofield"]["alert_id"] == "urn:oid:1.1"
    assert payload["nearest_distance_miles"] is not None
    assert payload["nearest_distance_miles"] < 500
