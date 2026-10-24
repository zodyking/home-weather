"""Unit tests for volcano data parsing, activity merge, and payload build."""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone

from custom_components.home_weather import volcano_data
from custom_components.home_weather.volcano_data import (
    GDACS_EVENTS_URL,
    GDACS_TIMEOUT_SECONDS,
    RING_RADIUS_MILES,
    _fetch_gdacs_activity,
    build_coordinator_payload,
    build_volcano_geojson,
    detect_volcano_events,
    empty_coordinator_payload,
    gdacs_volcano_search_params,
    get_volcano_config,
    merge_activity,
    normalize_activity_level,
    parse_gdacs_events,
    parse_gvp_catalog,
    parse_hans_records,
    passes_volcano_filters,
    pick_nearest_volcano,
    select_volcano_map_features,
)

HOME = {"lat": 46.2, "lon": -122.2}  # near Mount St. Helens


def _gvp_feature(vnum: str, name: str, lat: float, lon: float) -> dict:
    return {
        "type": "Feature",
        "properties": {
            "Volcano_Number": vnum,
            "Volcano_Name": name,
            "Country": "United States",
            "Region": "Canada and Western USA",
            "Primary_Volcano_Type": "Stratovolcano",
            "Elevation": 2549,
            "Last_Eruption_Year": 2008,
            "Latitude": lat,
            "Longitude": lon,
        },
        "geometry": {"type": "Point", "coordinates": [lon, lat]},
    }


GVP_FEATURES = [
    _gvp_feature("321050", "St. Helens", 46.2, -122.18),
    _gvp_feature("321080", "Rainier", 46.853, -121.76),
    _gvp_feature("263250", "Merapi", -7.54, 110.446),
]


def _hans_record(vnum: str, name: str, lat: float, lon: float, level: str, color: str) -> dict:
    return {
        "vnum": vnum,
        "vName": name,
        "lat": lat,
        "long": lon,
        "alertLevel": level,
        "colorCode": color,
        "noticeSynopsis": f"{name} is exhibiting elevated activity.",
    }


def _gdacs_feature(event_id: int, name: str, lat: float, lon: float, alertlevel: str) -> dict:
    return {
        "type": "Feature",
        "properties": {
            "eventtype": "VO",
            "eventid": event_id,
            "name": name,
            "alertlevel": alertlevel,
            "iscurrent": "true",
            "description": f"Volcanic activity at {name}",
        },
        "geometry": {"type": "Point", "coordinates": [lon, lat]},
    }


# ---------------------------------------------------------------------------
# Config + level mapping
# ---------------------------------------------------------------------------

def test_get_volcano_config_defaults():
    cfg = get_volcano_config(None)
    assert cfg["enabled"] is True
    assert cfg["zone_mode"] == "zone"
    assert cfg["radius_miles"] == 500
    assert cfg["min_alert_level"] == "advisory"
    assert cfg["map_show_all_volcanoes"] is True


def test_get_volcano_config_invalid_level_falls_back():
    cfg = get_volcano_config({"volcano_monitoring": {"min_alert_level": "extreme"}})
    assert cfg["min_alert_level"] == "advisory"


def test_normalize_activity_level_mapping():
    assert normalize_activity_level("Advisory") == "advisory"
    assert normalize_activity_level("WATCH") == "watch"
    assert normalize_activity_level("Warning") == "warning"
    # GDACS colors
    assert normalize_activity_level("Green") == "advisory"
    assert normalize_activity_level("Orange") == "watch"
    assert normalize_activity_level("Red") == "warning"
    assert normalize_activity_level("Normal") is None
    assert normalize_activity_level(None) is None


# ---------------------------------------------------------------------------
# Parsers
# ---------------------------------------------------------------------------

def test_parse_gvp_catalog():
    catalog = parse_gvp_catalog(GVP_FEATURES, HOME)
    assert len(catalog) == 3
    sthelens = next(v for v in catalog if v["name"] == "St. Helens")
    assert sthelens["vnum"] == "321050"
    assert sthelens["country"] == "United States"
    assert sthelens["distance_miles"] < 10
    merapi = next(v for v in catalog if v["name"] == "Merapi")
    assert merapi["distance_miles"] > 5000


def test_parse_gvp_catalog_skips_invalid():
    catalog = parse_gvp_catalog(
        [{"properties": {"Volcano_Name": "NoCoords"}}, {"not": "a feature"}, None],
        HOME,
    )
    assert catalog == []


def test_parse_hans_records():
    records = parse_hans_records(
        [
            _hans_record("321050", "St. Helens", 46.2, -122.18, "WATCH", "ORANGE"),
            {"vnum": "999", "vName": "NormalOne", "alertLevel": "NORMAL"},
        ]
    )
    assert len(records) == 1
    assert records[0]["source"] == "usgs"
    assert records[0]["activity_level"] == "watch"
    assert records[0]["color_code"] == "ORANGE"
    assert "elevated activity" in records[0]["synopsis"]


def test_parse_gdacs_events():
    records = parse_gdacs_events(
        [
            _gdacs_feature(1001, "Merapi", -7.54, 110.446, "Red"),
            _gdacs_feature(1002, "SomethingGreen", 10.0, 10.0, "Green"),
        ]
    )
    assert len(records) == 2
    merapi = next(r for r in records if r["name"] == "Merapi")
    assert merapi["source"] == "gdacs"
    assert merapi["activity_level"] == "warning"
    green = next(r for r in records if r["name"] == "SomethingGreen")
    assert green["activity_level"] == "advisory"


def test_parse_gdacs_skips_stale_noncurrent():
    stale = _gdacs_feature(1003, "OldOne", 5.0, 5.0, "Orange")
    stale["properties"]["iscurrent"] = "false"
    stale["properties"]["todate"] = "2020-01-01T00:00:00"
    records = parse_gdacs_events([stale])
    assert records == []


# ---------------------------------------------------------------------------
# Activity merge
# ---------------------------------------------------------------------------

def test_merge_activity_matches_by_vnum_and_name():
    catalog = parse_gvp_catalog(GVP_FEATURES, HOME)
    hans = parse_hans_records(
        [_hans_record("321050", "St. Helens", 46.2, -122.18, "WATCH", "ORANGE")]
    )
    gdacs = parse_gdacs_events([_gdacs_feature(1001, "Merapi", -7.54, 110.446, "Red")])

    events = merge_activity(catalog, hans + gdacs, HOME)
    assert len(events) == 2
    by_name = {e["name"]: e for e in events}
    assert by_name["St. Helens"]["activity_level"] == "watch"
    assert by_name["St. Helens"]["id"] == "321050"
    assert by_name["Merapi"]["activity_level"] == "warning"
    assert by_name["Merapi"]["id"] == "263250"
    # Warning sorts before watch
    assert events[0]["name"] == "Merapi"


def test_merge_activity_higher_level_wins_and_usgs_detail_preferred():
    catalog = parse_gvp_catalog(GVP_FEATURES, HOME)
    hans = parse_hans_records(
        [_hans_record("321050", "St. Helens", 46.2, -122.18, "WARNING", "RED")]
    )
    gdacs = parse_gdacs_events(
        [_gdacs_feature(1001, "St. Helens", 46.2, -122.18, "Orange")]
    )
    events = merge_activity(catalog, gdacs + hans, HOME)
    assert len(events) == 1
    event = events[0]
    assert event["activity_level"] == "warning"
    assert event["color_code"] == "RED"
    assert "elevated activity" in event["synopsis"]
    assert set(event["sources"]) == {"gdacs", "usgs"}


def test_merge_activity_unmatched_alert_becomes_standalone():
    catalog = parse_gvp_catalog(GVP_FEATURES, HOME)
    gdacs = parse_gdacs_events(
        [_gdacs_feature(1004, "Unknown Seamount", -40.0, -140.0, "Orange")]
    )
    events = merge_activity(catalog, gdacs, HOME)
    assert len(events) == 1
    assert events[0]["name"] == "Unknown Seamount"
    assert events[0]["distance_miles"] is not None


def test_merge_activity_ring_radii():
    catalog = parse_gvp_catalog(GVP_FEATURES, HOME)
    records = [
        parse_hans_records([_hans_record("321050", "St. Helens", 46.2, -122.18, level.upper(), "X")])[0]
        for level in ("advisory", "watch", "warning")
    ]
    for record, expected in zip(records, (10, 30, 60)):
        events = merge_activity(catalog, [record], HOME)
        assert events[0]["ring_radius_miles"] == expected
        assert RING_RADIUS_MILES[record["activity_level"]] == expected


# ---------------------------------------------------------------------------
# Filters + payload
# ---------------------------------------------------------------------------

def _active_event(level: str = "watch", distance: float = 50.0) -> dict:
    return {
        "id": "321050",
        "name": "St. Helens",
        "activity_level": level,
        "distance_miles": distance,
        "latitude": 46.2,
        "longitude": -122.18,
        "ring_radius_miles": RING_RADIUS_MILES[level],
    }


def test_passes_volcano_filters_level_threshold():
    cfg = get_volcano_config({"volcano_monitoring": {"min_alert_level": "watch"}})
    assert passes_volcano_filters(_active_event("watch"), cfg)
    assert passes_volcano_filters(_active_event("warning"), cfg)
    assert not passes_volcano_filters(_active_event("advisory"), cfg)


def test_pick_nearest_volcano():
    near = _active_event("advisory", 30.0)
    far = _active_event("warning", 400.0)
    far["id"] = "other"
    nearest = pick_nearest_volcano([far, near])
    assert nearest is near


def test_build_coordinator_payload():
    catalog = parse_gvp_catalog(GVP_FEATURES, HOME)
    hans = parse_hans_records(
        [_hans_record("321050", "St. Helens", 46.2, -122.18, "WATCH", "ORANGE")]
    )
    active = merge_activity(catalog, hans, HOME)
    cfg = get_volcano_config({"volcano_monitoring": {"radius_miles": 500}})
    payload = build_coordinator_payload(catalog, active, cfg)

    assert payload["catalog_count"] == 3
    assert payload["active_count"] == 1
    assert payload["geofield_count"] == 1
    assert payload["in_geofield"] is True
    assert payload["nearest_name"] == "St. Helens"
    assert payload["nearest_activity_level"] == "watch"
    assert payload["primary_geofield"]["id"] == "321050"

    features = payload["geojson"]["features"]
    assert len(features) == 3
    active_features = [f for f in features if f["properties"]["active"]]
    assert len(active_features) == 1
    props = active_features[0]["properties"]
    assert props["activity_level"] == "watch"
    assert props["ring_radius_miles"] == 30
    assert props["in_zone"] is True


def test_build_coordinator_payload_always_plots_catalog():
    """The full worldwide catalog is always plotted, even if the legacy
    ``map_show_all_volcanoes`` flag is set to False."""
    catalog = parse_gvp_catalog(GVP_FEATURES, HOME)
    hans = parse_hans_records(
        [_hans_record("321050", "St. Helens", 46.2, -122.18, "WATCH", "ORANGE")]
    )
    active = merge_activity(catalog, hans, HOME)
    cfg = get_volcano_config(
        {"volcano_monitoring": {"map_show_all_volcanoes": False}}
    )
    payload = build_coordinator_payload(catalog, active, cfg)
    features = payload["geojson"]["features"]
    # Every catalog volcano stays on the map; inactive ones are just not glowing.
    assert len(features) == 3
    active_features = [f for f in features if f["properties"]["active"]]
    assert len(active_features) == 1


def test_build_volcano_geojson_active_replaces_catalog_point():
    catalog = parse_gvp_catalog(GVP_FEATURES, HOME)
    active = [_active_event("warning")]
    geojson = build_volcano_geojson(catalog, active, geofield_ids={"321050"})
    ids = [f["id"] for f in geojson["features"]]
    assert ids.count("321050") == 1


def test_empty_coordinator_payload_shape():
    payload = empty_coordinator_payload()
    assert payload["active_count"] == 0
    assert payload["in_geofield"] is False
    assert payload["geojson"]["features"] == []


# ---------------------------------------------------------------------------
# Bus event detection
# ---------------------------------------------------------------------------

def test_detect_volcano_events_detected_updated_cleared():
    first = _active_event("watch")
    events = detect_volcano_events({}, [first])
    assert events == [("home_weather_volcano_activity_detected", events[0][1])]
    assert events[0][1]["name"] == "St. Helens"

    previous = {"321050": first}
    escalated = _active_event("warning")
    events = detect_volcano_events(previous, [escalated])
    assert [e[0] for e in events] == ["home_weather_volcano_activity_updated"]
    assert events[0][1]["activity_level"] == "warning"

    events = detect_volcano_events(previous, [])
    assert [e[0] for e in events] == ["home_weather_volcano_activity_cleared"]


def test_detect_volcano_events_no_change_is_silent():
    event = _active_event("watch")
    previous = {"321050": event}
    assert detect_volcano_events(previous, [dict(event)]) == []


# ---------------------------------------------------------------------------
# GDACS fetch + map feature filter
# ---------------------------------------------------------------------------

def _reset_gdacs_state() -> None:
    volcano_data._gdacs_backoff_until = None
    volcano_data._gdacs_last_warning_at = None


class _GdacsResponse:
    def __init__(self, status: int, body: str = "", content_type: str = "application/json"):
        self.status = status
        self._body = body
        self.headers = {"Content-Type": content_type}

    async def text(self) -> str:
        return self._body

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False


class _GdacsSession:
    """Records SEARCH calls and replays scripted responses. No network."""

    def __init__(self, responses: list):
        self._responses = list(responses)
        self.calls: list[dict] = []

    def get(self, url, *, params=None, headers=None, timeout=None):
        self.calls.append(
            {
                "url": url,
                "params": dict(params or {}),
                "headers": dict(headers or {}),
                "timeout": timeout,
            }
        )
        item = self._responses.pop(0)
        if isinstance(item, BaseException):
            raise item
        status, body = item
        return _GdacsResponse(status, body)


def _warning_messages(caplog) -> list[str]:
    return [r.getMessage() for r in caplog.records if r.levelno >= logging.WARNING]


def test_gdacs_volcano_search_params_match_documented_contract():
    """Corrected SEARCH shape. Does not touch the network."""
    now = datetime(2026, 10, 24, 15, 0, tzinfo=timezone.utc)
    params = gdacs_volcano_search_params(now)
    assert params == {
        "eventlist": "VO",
        "fromdate": "2026-10-17",
        "todate": "2026-10-24",
        "alertlevel": "green;orange;red",
    }
    assert "eventtypes" not in params
    assert "fromDate" not in params
    assert GDACS_EVENTS_URL.endswith("/events/geteventlist/SEARCH")
    assert not GDACS_EVENTS_URL.rstrip("/").endswith("/MAP")


def test_gdacs_http_204_is_empty_alerts_without_error_log(caplog):
    _reset_gdacs_state()
    caplog.set_level(logging.DEBUG, logger="custom_components.home_weather.volcano_data")
    session = _GdacsSession([(204, "")])
    records = asyncio.run(_fetch_gdacs_activity(session))
    assert records == []
    assert _warning_messages(caplog) == []
    assert len(session.calls) == 1
    call = session.calls[0]
    assert call["url"] == GDACS_EVENTS_URL
    assert call["params"]["eventlist"] == "VO"
    assert call["params"]["alertlevel"] == "green;orange;red"
    assert call["params"]["fromdate"] <= call["params"]["todate"]
    assert call["headers"]["Accept"].startswith("application/json")
    assert call["timeout"].total == GDACS_TIMEOUT_SECONDS
    assert volcano_data._gdacs_backoff_until is None


def test_gdacs_http_400_is_not_retried_and_warns_once(caplog):
    """A malformed response is not hammered, and a dead pair backs off quietly."""
    _reset_gdacs_state()
    caplog.set_level(logging.DEBUG, logger="custom_components.home_weather.volcano_data")
    session = _GdacsSession(
        [
            (400, "Bad date format"),
            (400, "Bad date format"),
        ]
    )
    records = asyncio.run(_fetch_gdacs_activity(session))
    assert records == []
    assert len(session.calls) == 2
    assert "fromdate" in session.calls[0]["params"]
    assert "fromDate" in session.calls[1]["params"]
    warnings = _warning_messages(caplog)
    assert len(warnings) == 1
    assert "400" in warnings[0]
    assert "Bad date format" in warnings[0]
    # Quiet during backoff: the next poll does not call GDACS again.
    again = asyncio.run(_fetch_gdacs_activity(session))
    assert again == []
    assert len(session.calls) == 2


def test_gdacs_timeout_tries_smaller_query_instead_of_long_outage(caplog):
    _reset_gdacs_state()
    caplog.set_level(logging.DEBUG, logger="custom_components.home_weather.volcano_data")
    feature = _gdacs_feature(1000152, "Kanlaon", 10.412, 123.132, "Orange")
    body = json.dumps({"type": "FeatureCollection", "features": [feature]})
    session = _GdacsSession([TimeoutError(), (200, body)])
    records = asyncio.run(_fetch_gdacs_activity(session))
    assert len(records) == 1
    assert records[0]["name"] == "Kanlaon"
    assert len(session.calls) == 2
    assert session.calls[1]["params"] == {"eventlist": "VO", "alertlevel": "orange;red"}
    warnings = _warning_messages(caplog)
    assert len(warnings) == 1
    assert "TimeoutError" not in warnings[0]
    assert "smaller" in warnings[0]
    # Compact success must not park the feed for hours.
    assert volcano_data._gdacs_backoff_until is None


def test_select_volcano_map_features_active_only_versus_show_all():
    catalog = parse_gvp_catalog(GVP_FEATURES, HOME)
    hans = parse_hans_records(
        [_hans_record("321050", "St. Helens", 46.2, -122.18, "WATCH", "ORANGE")]
    )
    active = merge_activity(catalog, hans, HOME)
    features = build_volcano_geojson(catalog, active)["features"]
    assert len(features) == 3

    active_only = select_volcano_map_features(features)
    show_all = select_volcano_map_features(features, show_all=True)
    assert len(active_only) == 1
    assert active_only[0]["properties"]["active"] is True
    assert active_only[0]["properties"]["activity_level"] == "watch"
    assert {f["properties"]["name"] for f in active_only} == {"St. Helens"}
    assert len(show_all) == 3
    assert {f["properties"]["name"] for f in show_all} == {"St. Helens", "Rainier", "Merapi"}
