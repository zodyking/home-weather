"""Unit tests for zone_mode bypass ("all") across hazard geofields."""
from __future__ import annotations

from datetime import timedelta

from homeassistant.util import dt as dt_util

from custom_components.home_weather.earthquake_data import (
    get_earthquake_config,
    passes_earthquake_filters,
)
from custom_components.home_weather.hurricane_data import (
    get_hurricane_geofield_config,
    storm_in_geofield,
)
from custom_components.home_weather.lightning_data import (
    build_lightning_payload,
    get_lightning_config,
)
from custom_components.home_weather.tornado_data import (
    build_coordinator_payload,
    filter_alerts_for_geofield,
    get_tornado_geofield_config,
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


# ---------------------------------------------------------------------------
# Tornado
# ---------------------------------------------------------------------------

def test_tornado_zone_mode_defaults_to_zone():
    cfg = get_tornado_geofield_config({"tornado_monitoring": {"enabled": True}})
    assert cfg["zone_mode"] == "zone"


def test_tornado_bypass_includes_all_alerts():
    alerts = parse_tornado_features(
        [_tornado_feature("near", NEAR_POLYGON), _tornado_feature("far", FAR_POLYGON)],
        HOME,
    )
    config = {
        "tornado_monitoring": {
            "zone_mode": "all",
            "only_affecting_home": True,
            "max_distance_miles": 25,
        }
    }
    geofield = filter_alerts_for_geofield(alerts, config)
    assert len(geofield) == 2

    payload = build_coordinator_payload(alerts, config)
    assert payload["active_count"] == 2
    assert payload["in_geofield"] is True


def test_tornado_zone_mode_zone_still_filters():
    alerts = parse_tornado_features(
        [_tornado_feature("near", NEAR_POLYGON), _tornado_feature("far", FAR_POLYGON)],
        HOME,
    )
    config = {
        "tornado_monitoring": {
            "zone_mode": "zone",
            "only_affecting_home": True,
            "max_distance_miles": 25,
        }
    }
    geofield = filter_alerts_for_geofield(alerts, config)
    assert len(geofield) == 1
    assert geofield[0]["alert_id"] == "near"


# ---------------------------------------------------------------------------
# Hurricane
# ---------------------------------------------------------------------------

def _storm(distance: float | None, threat_level: str = "watch") -> dict:
    return {
        "id": "al012026",
        "name": "Test Storm",
        "threat": {"threatLevel": threat_level, "distanceToCenterMiles": distance},
    }


def test_hurricane_zone_mode_defaults_to_zone():
    cfg = get_hurricane_geofield_config({"hurricane_monitoring": {"enabled": True}})
    assert cfg["zone_mode"] == "zone"


def test_hurricane_bypass_ignores_distance_but_keeps_threat_filter():
    config = {
        "hurricane_monitoring": {
            "enabled": True,
            "zone_mode": "all",
            "max_distance_miles": 500,
            "min_threat_level": "watch",
        }
    }
    geofield_config = get_hurricane_geofield_config(config)
    assert storm_in_geofield(_storm(2500.0), geofield_config)
    assert storm_in_geofield(_storm(None), geofield_config)
    # min threat still applies in bypass mode
    assert not storm_in_geofield(_storm(100.0, threat_level="none"), geofield_config)


def test_hurricane_zone_mode_zone_filters_distance():
    config = {
        "hurricane_monitoring": {
            "enabled": True,
            "zone_mode": "zone",
            "max_distance_miles": 500,
            "min_threat_level": "watch",
        }
    }
    geofield_config = get_hurricane_geofield_config(config)
    assert storm_in_geofield(_storm(300.0), geofield_config)
    assert not storm_in_geofield(_storm(2500.0), geofield_config)


# ---------------------------------------------------------------------------
# Earthquake
# ---------------------------------------------------------------------------

def test_earthquake_zone_mode_defaults_to_zone():
    cfg = get_earthquake_config({"earthquake_monitoring": {"enabled": True}})
    assert cfg["zone_mode"] == "zone"


def test_earthquake_bypass_ignores_radius_but_keeps_magnitude():
    far_event = {"magnitude": 5.0, "distance_miles": 8000.0, "tsunami": 0}
    weak_event = {"magnitude": 1.0, "distance_miles": 8000.0, "tsunami": 0}
    config = get_earthquake_config(
        {
            "earthquake_monitoring": {
                "zone_mode": "all",
                "min_magnitude": 2.5,
                "radius_miles": 500,
            }
        }
    )
    assert passes_earthquake_filters(far_event, config)
    assert not passes_earthquake_filters(weak_event, config)


def test_earthquake_zone_mode_zone_filters_radius():
    far_event = {"magnitude": 5.0, "distance_miles": 8000.0, "tsunami": 0}
    config = get_earthquake_config(
        {
            "earthquake_monitoring": {
                "zone_mode": "zone",
                "min_magnitude": 2.5,
                "radius_miles": 500,
            }
        }
    )
    assert not passes_earthquake_filters(far_event, config)


# ---------------------------------------------------------------------------
# Lightning
# ---------------------------------------------------------------------------

def _strikes(now_ms: int) -> list[dict]:
    near = {
        "id": "near",
        "lat": 35.15,
        "lon": -96.05,
        "time_ms": now_ms - 60_000,
        "time_ns": (now_ms - 60_000) * 1_000_000,
    }
    far = {
        "id": "far",
        "lat": 40.0,
        "lon": -100.0,
        "time_ms": now_ms - 120_000,
        "time_ns": (now_ms - 120_000) * 1_000_000,
    }
    return [near, far]


def test_lightning_zone_mode_defaults_to_zone():
    cfg = get_lightning_config({"lightning_monitoring": {"enabled": True}})
    assert cfg["zone_mode"] == "zone"


def test_lightning_bypass_includes_all_strikes(monkeypatch):
    now_ms = 1_700_000_000_000
    monkeypatch.setattr(
        "custom_components.home_weather.lightning_data.dt_util.utcnow",
        lambda: dt_util.utc_from_timestamp(now_ms / 1000),
    )
    config = {
        "lightning_monitoring": {
            "zone_mode": "all",
            "max_age_minutes": 60,
            "geofield_radius_miles": 50,
        }
    }
    payload = build_lightning_payload(_strikes(now_ms), HOME, config)
    assert payload["geofield_count"] == 2
    assert payload["in_geofield"] is True


def test_lightning_zone_mode_zone_filters_radius(monkeypatch):
    now_ms = 1_700_000_000_000
    monkeypatch.setattr(
        "custom_components.home_weather.lightning_data.dt_util.utcnow",
        lambda: dt_util.utc_from_timestamp(now_ms / 1000),
    )
    config = {
        "lightning_monitoring": {
            "zone_mode": "zone",
            "max_age_minutes": 60,
            "geofield_radius_miles": 50,
        }
    }
    payload = build_lightning_payload(_strikes(now_ms), HOME, config)
    assert payload["geofield_count"] == 1
