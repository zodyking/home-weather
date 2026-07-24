"""Unit tests for NASA JPL / NOAA space map data."""
from __future__ import annotations

from custom_components.home_weather.space_data import (
    _detect_overhead_passes,
    _fallback_heliocentric_vector,
    _first_float,
    _k_index_to_g_scale,
    _parse_horizons_vectors,
    _parse_observer_alt_az,
    _parse_xray_class,
    build_coordinator_payload,
    detect_space_events,
    empty_payload,
    get_neo_alerts_config,
    get_space_config,
    get_spacecraft_alerts_config,
)
from custom_components.home_weather.tts_notifications import (
    passes_neo_tts_filter,
    passes_spacecraft_tts_filter,
    passes_solar_weather_tts_filter,
)

SAMPLE_HORIZONS_TEXT = """
$$SOE
2025-Jul-02 12:00     1.234567E+00  2.345678E+00  3.456789E-01  1.100000E+01  2.200000E+00  3.300000E+00
$$EOE
"""

SAMPLE_HORIZONS_TEXT_LABELED = """
$$SOE
2461224.407638889 = A.D. 2026-Jul-02 21:47:00.0000 TDB
 X = 1.879416337620361E-01 Y =-9.990904625815881E-01 Z = 5.970525522922741E-05
 VX= 1.662388502748638E-02 VY= 3.111644942666292E-03 VZ=-8.795146916431986E-07
$$EOE
"""


def test_parse_horizons_vectors():
    parsed = _parse_horizons_vectors(SAMPLE_HORIZONS_TEXT)
    assert parsed is not None
    assert parsed["x_au"] == 1.234567
    assert parsed["y_au"] == 2.345678
    assert parsed["velocity_kms"] is not None


def test_parse_horizons_vectors_labeled_format():
    parsed = _parse_horizons_vectors(SAMPLE_HORIZONS_TEXT_LABELED)
    assert parsed is not None
    assert abs(parsed["x_au"] - 0.1879416337620361) < 1e-6
    assert abs(parsed["y_au"] - (-0.9990904625815881)) < 1e-6
    assert parsed["velocity_kms"] is not None


def test_fallback_heliocentric_vector():
    sun = _fallback_heliocentric_vector("10")
    assert sun is not None
    assert sun["distance_au"] == 0.0
    earth = _fallback_heliocentric_vector("399")
    assert earth is not None
    assert abs(earth["distance_au"] - 1.0) < 0.01


def test_k_index_to_g_scale():
    assert _k_index_to_g_scale(4) == 0
    assert _k_index_to_g_scale(5) == 1
    assert _k_index_to_g_scale(7) == 3


def test_first_float_treats_zero_as_valid():
    assert _first_float({"kp_index": 0, "estimated_kp": 3.0}, "kp_index", "estimated_kp") == 0.0
    assert _first_float({"ssn": 94.4}, "ssn", "observed_swpc_ssn") == 94.4


def test_parse_xray_class():
    assert _parse_xray_class("M2.8") == "M"
    assert _parse_xray_class("C4.3") == "C"
    assert _parse_xray_class("X1.0") == "X"
    assert _parse_xray_class("") is None


def test_detect_overhead_passes():
    samples = [
        {"time": "2025-Jul-02 12:00", "altitude_deg": 5, "azimuth_deg": 90},
        {"time": "2025-Jul-02 12:02", "altitude_deg": 25, "azimuth_deg": 120},
        {"time": "2025-Jul-02 12:04", "altitude_deg": 45, "azimuth_deg": 180},
        {"time": "2025-Jul-02 12:06", "altitude_deg": 8, "azimuth_deg": 240},
    ]
    passes = _detect_overhead_passes("-125544", "ISS", samples, 10)
    assert len(passes) == 1
    assert passes[0]["max_elevation_deg"] == 45.0


def test_parse_observer_alt_az_quantity_four():
    text = """
$$SOE
2026-Jul-24 02:14     145.123456   12.345678
2026-Jul-24 02:19     180.000000   45.000000
$$EOE
"""
    samples = _parse_observer_alt_az(text)
    assert len(samples) == 2
    assert samples[1]["altitude_deg"] == 45.0
    assert samples[1]["azimuth_deg"] == 180.0


def test_get_space_config_pass_window_defaults():
    cfg = get_space_config({})
    assert cfg["pass_lookahead_hours"] == 48
    assert cfg["pass_lookback_hours"] == 2


def test_build_coordinator_payload_counts():
    bodies = [
        {"type": "planet", "name": "Earth"},
        {"type": "moon", "name": "Moon"},
        {"type": "spacecraft", "name": "ISS"},
    ]
    small_bodies = [{"type": "asteroid", "name": "Apophis"}]
    payload = build_coordinator_payload(
        bodies,
        small_bodies,
        {"name": "Apophis", "lunar_distance": 2.0, "diameter_m": 300},
        [{"craft_id": "-125544", "craft_name": "ISS", "max_elevation_deg": 55}],
        {"k_index": 6, "g_scale": 2, "geomagnetic_storm_active": True},
        [],
        get_neo_alerts_config({"neo_alerts": {"max_lunar_distances": 5}}),
        get_spacecraft_alerts_config({}),
    )
    assert payload["catalog_counts"]["planets"] == 1
    assert payload["catalog_counts"]["moons"] == 1
    assert payload["catalog_counts"]["spacecraft"] == 1
    assert payload["catalog_counts"]["asteroids"] == 1
    assert payload["spacecraft_overhead"] is True
    assert payload["neo_close_approach_soon"] is True
    assert any(e["type"] == "geomagnetic_storm" for e in payload["alert_events"])


def test_detect_space_events_new_and_cleared():
    tracked = {"pass_1": {"id": "pass_1", "type": "spacecraft_pass", "name": "ISS"}}
    events = [{"id": "storm_1", "type": "geomagnetic_storm", "k_index": 6}]
    bus = detect_space_events(tracked, events)
    types = [t for t, _ in bus]
    assert "home_weather_solar_storm" in types
    assert "home_weather_spacecraft_overhead_cleared" in types


def test_disabled_space_config_empty_shape():
    cfg = get_space_config({"space_monitoring": {"enabled": False}})
    assert cfg["enabled"] is False
    empty = empty_payload()
    assert empty["bodies"] == []
    assert empty["catalog_counts"]["total"] == 0


def test_tts_filters():
    spacecraft_cfg = get_spacecraft_alerts_config({"spacecraft_alerts": {"min_elevation_deg": 20}})
    assert passes_spacecraft_tts_filter(
        {"craft_id": "-125544", "max_elevation_deg": 55},
        spacecraft_cfg,
        "home_weather_spacecraft_overhead",
    )
    assert not passes_spacecraft_tts_filter(
        {"craft_id": "-125544", "max_elevation_deg": 5},
        spacecraft_cfg,
        "home_weather_spacecraft_overhead",
    )
    assert passes_solar_weather_tts_filter(
        {"type": "geomagnetic_storm", "k_index": 6, "g_scale": 2},
        {"min_k_index": 5, "announce_geomagnetic_storm": True},
        "home_weather_solar_storm",
    )
    assert passes_neo_tts_filter(
        {"lunar_distance": 2.0, "diameter_m": 200},
        {"max_lunar_distances": 5, "min_diameter_m": 100},
        "home_weather_neo_close_approach",
    )

