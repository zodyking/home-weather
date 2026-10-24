"""Unit tests for NASA JPL / NOAA space map data."""
from __future__ import annotations

import asyncio
import inspect
from datetime import timedelta
from unittest.mock import AsyncMock, MagicMock, patch

from custom_components.home_weather.const import SPACE_UPDATE_INTERVAL, UPDATE_INTERVAL
from custom_components.home_weather.space_coordinator import SpaceCoordinator
from custom_components.home_weather.space_data import (
    _HORIZONS_VECTOR_CONCURRENCY,
    _detect_overhead_passes,
    _fallback_heliocentric_vector,
    _fetch_small_body_candidates,
    _first_float,
    _horizons_small_body_command,
    _k_index_to_g_scale,
    _parse_horizons_vectors,
    _parse_observer_alt_az,
    _parse_xray_class,
    async_fetch_space,
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
    assert cfg["show_asteroids"] is True
    assert cfg["show_comets"] is True


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


def test_small_body_candidates_come_from_cad_only():
    async def run() -> None:
        payload = {
            "fields": ["des", "fullname", "dist", "cd", "diameter", "v_inf"],
            "data": [
                ["2024 YR4", "2024 YR4", "1.2", "2026-Dec-22 00:00", "0.05", "10.0"],
                ["C/2023 A3", "C/2023 A3 (Tsuchinshan-ATLAS)", "0.5", "2026-Oct-01", None, "20"],
                ["not a body", "not a body", "3.0", "2026-Jan-01", None, "1"],
            ],
        }
        urls: list[str] = []

        class _Resp:
            def raise_for_status(self) -> None:
                return None

            async def json(self, content_type: str | None = None) -> dict:
                return payload

        class _CM:
            async def __aenter__(self) -> _Resp:
                return _Resp()

            async def __aexit__(self, *args: object) -> None:
                return None

        def _get(url: str, timeout: int = 30, params: dict | None = None) -> _CM:
            urls.append(url)
            return _CM()

        session = MagicMock()
        session.get = _get
        found = await _fetch_small_body_candidates(session)

        assert len(urls) == 1
        url = urls[0]
        assert "cad.api" in url
        assert "body=Earth" in url
        assert "dist-max=50" in url
        assert "limit=500" in url
        assert "sort=date" in url
        assert "date-min=" in url
        assert "scout" not in url.lower()
        assert "sentry" not in url.lower()
        assert {item["source"] for item in found} == {"cad"}
        assert {item["id"] for item in found} == {"2024 YR4", "C/2023 A3", "not a body"}

    asyncio.run(run())


def test_horizons_command_rejects_non_designations():
    assert _horizons_small_body_command("2024 YR4") == "DES=2024 YR4;"
    assert _horizons_small_body_command("99942") == "DES=99942;"
    assert _horizons_small_body_command("(433)") == "DES=433;"
    assert _horizons_small_body_command("C/2023 A3") == "DES=C/2023 A3;"
    assert _horizons_small_body_command("67P") == "DES=67P;"
    assert _horizons_small_body_command("3I/ATLAS") == "DES=3I/ATLAS;"
    assert _horizons_small_body_command("A/2017 U1") == "DES=A/2017 U1;"
    assert _horizons_small_body_command("Apophis") is None
    assert _horizons_small_body_command("") is None
    assert _horizons_small_body_command("99942 Apophis (1999 VF22)") is None
    assert _horizons_small_body_command("1I/'Oumuamua") is None


def test_space_interval_and_horizons_concurrency():
    import custom_components.home_weather.space_data as space_data

    assert UPDATE_INTERVAL == 300
    assert SPACE_UPDATE_INTERVAL == timedelta(hours=6)
    assert SPACE_UPDATE_INTERVAL != timedelta(seconds=UPDATE_INTERVAL)
    assert _HORIZONS_VECTOR_CONCURRENCY == 1
    assert not hasattr(space_data, "SCOUT_API")
    assert not hasattr(space_data, "SENTRY_API")
    assert "cad.api" in space_data.CAD_API

    source = inspect.getsource(space_data.async_fetch_space)
    assert "Semaphore(_HORIZONS_VECTOR_CONCURRENCY)" in source
    assert "Semaphore(8)" not in source
    assert "scout" not in source.lower()
    assert "sentry" not in source.lower()

    hass = MagicMock()
    coordinator = SpaceCoordinator(hass, MagicMock())
    assert coordinator.update_interval == timedelta(seconds=UPDATE_INTERVAL)
    assert coordinator.update_interval != SPACE_UPDATE_INTERVAL


def test_horizons_cache_keeps_solar_on_the_short_poll():
    async def run() -> None:
        import custom_components.home_weather.space_data as space_data

        space_data._horizons_cache = None
        space_data._horizons_cache_at = None
        space_data._horizons_cache_key = None

        hass = MagicMock()
        base_space = {
            "enabled": True,
            "show_planets": False,
            "show_dwarf_planets": False,
            "show_moons": False,
            "show_spacecraft": False,
            "show_asteroids": True,
            "show_comets": True,
        }
        config = {
            "space_monitoring": dict(base_space),
            "solar_weather_monitoring": {"enabled": True, "show_sunspot_regions": True},
        }
        vector = AsyncMock(return_value={
            "x_au": 1.0,
            "y_au": 0.0,
            "z_au": 0.0,
            "distance_au": 1.0,
            "velocity_kms": 1.0,
        })
        candidates = AsyncMock(return_value=[
            {
                "id": "2024 YR4",
                "name": "2024 YR4",
                "type": "asteroid",
                "source": "cad",
                "lunar_distance": 1.2,
            },
            {
                "id": "99942 Apophis (1999 VF22)",
                "name": "Apophis",
                "type": "asteroid",
                "source": "cad",
                "lunar_distance": 2.0,
            },
        ])
        catalog = AsyncMock(return_value=[])
        observer = AsyncMock(return_value=[])
        solar = AsyncMock(return_value={"k_index": 3})

        def _reset() -> None:
            space_data._horizons_cache = None
            space_data._horizons_cache_at = None
            space_data._horizons_cache_key = None

        try:
            with (
                patch(
                    "custom_components.home_weather.space_data.async_get_clientsession",
                    return_value=MagicMock(),
                ),
                patch(
                    "custom_components.home_weather.space_data._fetch_horizons_vector",
                    vector,
                ),
                patch(
                    "custom_components.home_weather.space_data._fetch_small_body_candidates",
                    candidates,
                ),
                patch(
                    "custom_components.home_weather.space_data._fetch_horizons_catalog",
                    catalog,
                ),
                patch(
                    "custom_components.home_weather.space_data._fetch_horizons_observer",
                    observer,
                ),
                patch(
                    "custom_components.home_weather.space_data._fetch_swpc_solar_weather",
                    solar,
                ),
                patch(
                    "custom_components.home_weather.space_data.get_home_coordinates",
                    return_value={"lat": 0.0, "lon": 0.0, "label": "Home"},
                ),
            ):
                payload = await async_fetch_space(hass, config)
                by_name = {body["name"]: body for body in payload["small_bodies"]}
                assert by_name["2024 YR4"]["position_available"] is True
                assert by_name["Apophis"]["position_available"] is False
                assert vector.await_count == 1
                assert vector.await_args.args[1] == "DES=2024 YR4;"
                assert candidates.await_count == 1
                assert catalog.await_count == 0
                assert observer.await_count == 0
                assert solar.await_count == 1
                assert payload["solar_weather"]["k_index"] == 3

                await async_fetch_space(hass, config)
                assert candidates.await_count == 1
                assert vector.await_count == 1
                assert solar.await_count == 2

                solar_only = {
                    **config,
                    "solar_weather_monitoring": {
                        "enabled": True,
                        "show_sunspot_regions": False,
                    },
                }
                await async_fetch_space(hass, solar_only)
                assert candidates.await_count == 1
                assert vector.await_count == 1
                assert solar.await_count == 3

                neo_only = {
                    **config,
                    "neo_alerts": {"enabled": True, "max_lunar_distances": 1},
                }
                await async_fetch_space(hass, neo_only)
                assert candidates.await_count == 1
                assert vector.await_count == 1
                assert solar.await_count == 4

                space_data._horizons_cache_at = (
                    space_data.dt_util.utcnow() - timedelta(hours=6, seconds=1)
                )
                await async_fetch_space(hass, config)
                assert candidates.await_count == 2
                assert vector.await_count == 2
                assert solar.await_count == 5

                changed = {
                    **config,
                    "space_monitoring": {**base_space, "show_planets": True},
                }
                await async_fetch_space(hass, changed)
                assert candidates.await_count == 3
                assert vector.await_count > 2
                assert solar.await_count == 6
        finally:
            _reset()

    asyncio.run(run())

