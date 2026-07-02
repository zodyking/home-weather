"""Unit tests for U.S. State Department travel advisory parsing."""
from __future__ import annotations

from custom_components.home_weather.travel_advisory_data import (
    LEVEL_COLORS,
    build_coordinator_payload,
    build_travel_advisory_geojson,
    parse_advisory_title,
    parse_travel_advisories,
    passes_travel_alert_filter,
    resolve_geo_country_name,
)

SAMPLE_RAW = [
    {
        "Title": "Kuwait - Level 3: Reconsider Travel",
        "Link": "https://travel.state.gov/content/travel/en/traveladvisories/traveladvisories/kuwait-travel-advisory.html",
        "Category": ["KU"],
        "Summary": "<p><b>Reconsider Travel</b> to <b>Kuwait</b> due to armed conflict.</p>",
    },
    {
        "Title": "Germany - Level 2: Exercise Increased Caution",
        "Link": "https://travel.state.gov/content/travel/en/traveladvisories/traveladvisories/germany-travel-advisory.html",
        "Category": ["GM"],
        "Summary": "<p>Exercise increased caution in Germany.</p>",
    },
]

MINI_GEOJSON = {
    "type": "FeatureCollection",
    "features": [
        {
            "type": "Feature",
            "properties": {"name": "Kuwait"},
            "geometry": {"type": "Polygon", "coordinates": [[[46, 28], [48, 28], [48, 30], [46, 30], [46, 28]]]},
        },
        {
            "type": "Feature",
            "properties": {"name": "Germany"},
            "geometry": {"type": "Polygon", "coordinates": [[[8, 50], [12, 50], [12, 54], [8, 54], [8, 50]]]},
        },
    ],
}


def test_parse_advisory_title():
    country, level, label = parse_advisory_title("Kuwait - Level 3: Reconsider Travel")
    assert country == "Kuwait"
    assert level == 3
    assert "Reconsider" in label


def test_parse_travel_advisories_strips_html():
    advisories = parse_travel_advisories(SAMPLE_RAW)
    assert len(advisories) == 2
    kuwait = next(a for a in advisories if a["country"] == "Kuwait")
    assert kuwait["level"] == 3
    assert kuwait["color"] == LEVEL_COLORS[3]
    assert "armed conflict" in kuwait["summary_text"].lower()
    assert "<p>" not in kuwait["summary_text"]


def test_build_travel_advisory_geojson_matches_countries():
    advisories = parse_travel_advisories(SAMPLE_RAW)
    geo_index = {"kuwait": "Kuwait", "germany": "Germany"}
    assert resolve_geo_country_name("Kuwait", ["KU"], geo_index) == "Kuwait"
    geojson = build_travel_advisory_geojson(advisories, MINI_GEOJSON, min_level=1)
    assert len(geojson["features"]) == 2
    levels = {f["properties"]["name"]: f["properties"]["level"] for f in geojson["features"]}
    assert levels["Kuwait"] == 3
    assert levels["Germany"] == 2


def test_build_coordinator_payload_level_counts():
    advisories = parse_travel_advisories(SAMPLE_RAW)
    payload = build_coordinator_payload(
        advisories,
        {"enabled": True, "show_on_map": True, "min_level": 1},
        MINI_GEOJSON,
    )
    assert payload["advisory_count"] == 2
    assert payload["level_counts"][2] == 1
    assert payload["level_counts"][3] == 1
    assert payload["map_count"] == 2


def test_passes_travel_alert_filter_watched_countries():
    advisory = parse_travel_advisories(SAMPLE_RAW)[0]
    assert passes_travel_alert_filter(advisory, {"min_level": 3, "watched_countries": []})
    assert passes_travel_alert_filter(advisory, {"min_level": 3, "watched_countries": ["KU"]})
    assert not passes_travel_alert_filter(advisory, {"min_level": 4, "watched_countries": []})
    assert not passes_travel_alert_filter(advisory, {"min_level": 3, "watched_countries": ["GM"]})
