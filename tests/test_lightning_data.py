"""Unit tests for lightning geofield payload."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

from custom_components.home_weather.lightning_data import (
    LightningHourlyCounter,
    build_lightning_payload,
    decode_blitzortung_message,
    parse_strike,
    strike_in_geofield,
    strike_in_monitoring_zone,
)

HOME = {"lat": 35.1, "lon": -96.1}
FIXTURES = Path(__file__).resolve().parent / "fixtures"


def test_decode_blitzortung_message_matches_fixture():
    obfuscated = (FIXTURES / "blitzortung_obfuscated_sample.txt").read_text(encoding="utf-8")
    expected = (FIXTURES / "blitzortung_decoded_sample.json").read_text(encoding="utf-8")
    decoded = decode_blitzortung_message(obfuscated)
    assert decoded == expected
    payload = json.loads(decoded)
    assert payload["lat"] is not None
    assert payload["lon"] is not None
    assert parse_strike(payload) is not None


def test_parse_strike_normalizes_fields():
    strike = parse_strike({"time": 1_700_000_000_000_000_000, "lat": 35.2, "lon": -96.0, "pol": 1})
    assert strike is not None
    assert strike["lat"] == 35.2
    assert strike["lon"] == -96.0
    assert strike["polarity"] == "positive"


def test_build_lightning_payload_filters_by_geofield(monkeypatch):
    from homeassistant.util import dt as dt_util

    now_ms = 1_700_000_000_000
    monkeypatch.setattr(
        "custom_components.home_weather.lightning_data.dt_util.utcnow",
        lambda: dt_util.utc_from_timestamp(now_ms / 1000),
    )
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
    config = {"lightning": {"max_age_minutes": 60, "geofield_radius_miles": 50}}
    payload = build_lightning_payload([near, far], HOME, config)
    assert payload["in_geofield"] is True
    assert payload["geofield_count"] == 1
    assert payload["nearest_distance_miles"] is not None
    assert payload["nearest_distance_miles"] < 50


def test_build_lightning_payload_accepts_hourly_override():
    payload = build_lightning_payload([], HOME, strikes_last_hour=842)
    assert payload["strikes_last_hour"] == 842


def test_strike_in_geofield_respects_radius():
    near = {"lat": 35.15, "lon": -96.05}
    far = {"lat": 40.0, "lon": -100.0}
    config = {"lightning": {"geofield_radius_miles": 50, "zone_mode": "all"}}
    assert strike_in_geofield(near, HOME, config) is True
    assert strike_in_geofield(far, HOME, config) is False
    assert strike_in_monitoring_zone(far, HOME, config) is True


def test_strike_in_monitoring_zone_respects_radius():
    near = {"lat": 35.15, "lon": -96.05}
    far = {"lat": 40.0, "lon": -100.0}
    config = {"lightning": {"geofield_radius_miles": 50, "zone_mode": "zone"}}
    assert strike_in_monitoring_zone(near, HOME, config) is True
    assert strike_in_monitoring_zone(far, HOME, config) is False


def test_lightning_hourly_counter_prunes_old_strikes(monkeypatch):
    from homeassistant.util import dt as dt_util

    now_ms = 1_700_000_000_000
    monkeypatch.setattr(
        "custom_components.home_weather.lightning_data.dt_util.utcnow",
        lambda: dt_util.utc_from_timestamp(now_ms / 1000),
    )

    async def run() -> None:
        counter = LightningHourlyCounter()
        await counter.record(now_ms - 30 * 60 * 1000)
        await counter.record(now_ms - 90 * 60 * 1000)
        assert await counter.count() == 1

    asyncio.run(run())
