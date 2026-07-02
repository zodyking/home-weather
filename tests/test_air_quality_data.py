"""Unit tests for EPA AirNow air quality parsing."""
from __future__ import annotations

from custom_components.home_weather.air_quality_data import (
    CATEGORY_COLORS,
    build_coordinator_payload,
    detect_air_quality_events,
    normalize_category,
    parse_reporting_area_dat,
    parse_reporting_area_line,
    passes_air_quality_geofield_filter,
)

SAMPLE_LINE = (
    "07/02/26|07/02/26|12:00|CDT|0|O|Y|Aberdeen|SD|45.4680|-98.4940|"
    "PM2.5|55|Moderate|No||South Dakota Department of Agriculture and Natural Resources"
)
SAMPLE_LINE_2 = (
    "07/02/26|07/02/26|12:00|CDT|0|O|Y|Aberdeen|SD|45.4680|-98.4940|"
    "OZONE|102|Unhealthy for Sensitive Groups|No||South Dakota Department of Agriculture and Natural Resources"
)


def test_parse_reporting_area_line():
    row = parse_reporting_area_line(SAMPLE_LINE)
    assert row is not None
    assert row["name"] == "Aberdeen"
    assert row["state"] == "SD"
    assert row["aqi"] == 55
    assert row["category_level"] == 2
    assert row["pollutant"] == "PM2.5"


def test_normalize_category_sensitive_groups():
    level, label = normalize_category("Unhealthy for Sensitive Groups")
    assert level == 3
    assert "Sensitive" in label


def test_parse_reporting_area_dat_dedupes_by_max_aqi():
    text = SAMPLE_LINE + "\n" + SAMPLE_LINE_2
    areas = parse_reporting_area_dat(text)
    assert len(areas) == 1
    assert areas[0]["aqi"] == 102
    assert areas[0]["category_level"] == 3
    assert set(areas[0]["pollutants"]) == {"PM2.5", "OZONE"}


def test_build_coordinator_payload_level_counts():
    areas = parse_reporting_area_dat(SAMPLE_LINE + "\n" + SAMPLE_LINE_2)
    payload = build_coordinator_payload(
        areas,
        {"enabled": True, "show_on_map": True, "min_category_level": 1},
        home={"lat": 40.0, "lon": -100.0},
    )
    assert payload["area_count"] == 1
    assert payload["filtered_count"] == 1
    assert payload["level_counts"][2] == 0
    assert payload["level_counts"][3] == 1
    assert payload["worst_area"]["color"] == CATEGORY_COLORS[3]


def test_parse_reporting_area_dat_assigns_id():
    areas = parse_reporting_area_dat(SAMPLE_LINE)
    assert areas[0]["id"] == "Aberdeen|SD|45.4680|-98.4940"


def test_geofield_and_alert_payload():
    areas = parse_reporting_area_dat(SAMPLE_LINE + "\n" + SAMPLE_LINE_2)
    payload = build_coordinator_payload(
        areas,
        {
            "enabled": True,
            "zone_mode": "zone",
            "alert_zone_mode": "zone",
            "radius_miles": 25,
            "show_on_map": True,
            "min_category_level": 1,
        },
        home={"lat": 45.4680, "lon": -98.4940},
    )
    assert payload["in_geofield"] is True
    assert payload["geofield_count"] == 1
    assert payload["primary_geofield"]["aqi"] == 102


def test_passes_air_quality_geofield_filter_respects_radius():
    area = {"category_level": 3, "distance_miles": 10}
    cfg = {"enabled": True, "zone_mode": "zone", "radius_miles": 25, "min_category_level": 1}
    assert passes_air_quality_geofield_filter(area, cfg)
    area_far = {"category_level": 3, "distance_miles": 100}
    assert not passes_air_quality_geofield_filter(area_far, cfg)


def test_detect_air_quality_events():
    area = {
        "id": "area-1",
        "name": "Aberdeen",
        "state": "SD",
        "aqi": 102,
        "category_level": 3,
        "category": "Unhealthy for Sensitive Groups",
    }
    events = detect_air_quality_events({}, [area])
    assert events[0][0] == "home_weather_air_quality_unhealthy"
