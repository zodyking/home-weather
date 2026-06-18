"""Unit tests for TTS trigger helpers."""
from __future__ import annotations

from types import SimpleNamespace

from custom_components.home_weather.tts_triggers import (
    _is_tts_active,
    build_weather_data_from_state,
    compute_trigger_hours,
    extract_weather_condition,
    media_players_with_tts,
)


def test_is_tts_active_master_switch():
    assert _is_tts_active({"enabled": True}) is True


def test_is_tts_active_sub_toggle_without_master():
    assert _is_tts_active({"enabled": False, "enable_time_based": True}) is True
    assert _is_tts_active({"enabled": False, "enable_current_change": True}) is True


def test_is_tts_active_all_off():
    assert _is_tts_active({"enabled": False}) is False


def test_compute_trigger_hours_anchors_to_start():
    assert compute_trigger_hours(8, 21, 3) == [8, 11, 14, 17, 20]


def test_compute_trigger_hours_every_hour():
    assert compute_trigger_hours(8, 10, 1) == [8, 9, 10]


def test_extract_weather_condition_prefers_attribute():
    state = SimpleNamespace(
        state="sunny",
        attributes={"condition": "partlycloudy"},
    )
    assert extract_weather_condition(state) == "partlycloudy"


def test_extract_weather_condition_falls_back_to_state():
    state = SimpleNamespace(state="rainy", attributes={})
    assert extract_weather_condition(state) == "rainy"


def test_media_players_with_tts_filters_incomplete_entries():
    players = [
        {"entity_id": "media_player.kitchen", "tts_entity_id": "tts.google"},
        {"entity_id": "media_player.bedroom", "tts_entity_id": ""},
    ]
    assert media_players_with_tts(players) == [
        {"entity_id": "media_player.kitchen", "tts_entity_id": "tts.google"}
    ]


def test_build_weather_data_from_state_missing_entity():
    class _Hass:
        class states:
            @staticmethod
            def get(_entity_id):
                return None

    assert build_weather_data_from_state(_Hass(), "weather.home") == {"configured": False}

