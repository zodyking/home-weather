"""Unit tests for TTS trigger helpers."""
from __future__ import annotations

from types import SimpleNamespace

from custom_components.home_weather.tts_triggers import (
    _is_alerts_active,
    _is_tts_active,
    build_weather_data_from_state,
    compute_trigger_hours,
    extract_weather_condition,
    media_players_with_tts,
)


def test_is_tts_active_sub_toggle_time_based():
    """Master TTS switch no longer exists; any per-type flag enables TTS."""
    assert _is_tts_active({"enable_time_based": True}) is True


def test_is_tts_active_sub_toggle_current_change():
    assert _is_tts_active({"enable_current_change": True}) is True


def test_is_tts_active_master_switch_ignored():
    """The `enabled` key is no longer consulted; setting it True with no
    per-type flag does NOT activate TTS."""
    assert _is_tts_active({"enabled": True}) is False


def test_is_tts_active_all_off():
    assert _is_tts_active({}) is False


def test_is_alerts_active_picks_up_sun_alerts():
    assert _is_alerts_active({
        "tts": {},
        "sun_alerts": {"enabled": True},
    }) is True


def test_is_alerts_active_picks_up_nws_alerts():
    assert _is_alerts_active({
        "tts": {},
        "nws_alerts": {"enabled": True},
    }) is True


def test_is_alerts_active_picks_up_tts_sub_toggle():
    """A per-type TTS flag (with no master switch) activates alerts."""
    assert _is_alerts_active({
        "tts": {"enable_time_based": True},
        "sun_alerts": {"enabled": False},
        "nws_alerts": {"enabled": False},
    }) is True


def test_is_alerts_active_returns_false_when_nothing_on():
    assert _is_alerts_active({
        "tts": {},
        "sun_alerts": {"enabled": False},
        "nws_alerts": {"enabled": False},
    }) is False


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


# ---------------------------------------------------------------------------
# Regression tests for the master-gate removal + unified player filtering.
# ---------------------------------------------------------------------------

def test_setup_registers_time_based_trigger_without_master_switch():
    """Regression: with `tts.enabled` absent but `enable_time_based=True`,
    async_setup must still register the time-based trigger."""
    from unittest.mock import AsyncMock, patch

    from custom_components.home_weather.tts_triggers import TTSTriggerManager

    config = {
        "weather_entity": "weather.home",
        "tts": {"enable_time_based": True, "enabled": False},
        "media_players": [{"entity_id": "media_player.kitchen", "tts_entity_id": "tts.google"}],
    }
    manager = TTSTriggerManager(
        hass=SimpleNamespace(),
        get_config=lambda: config,
        get_weather_data=lambda: {"configured": True},
        refresh_weather_data=None,
    )

    with patch.object(
        manager, "_setup_time_based_trigger", new=AsyncMock()
    ) as mock_setup:
        import asyncio

        asyncio.run(manager.async_setup())

    mock_setup.assert_awaited_once()


def test_setup_skips_time_based_when_no_sub_toggle_even_if_enabled_true():
    """Regression: the legacy `enabled: True` master flag alone must NOT
    cause time-based setup (no per-type flag is on)."""
    from unittest.mock import AsyncMock, patch

    from custom_components.home_weather.tts_triggers import TTSTriggerManager

    config = {
        "weather_entity": "weather.home",
        "tts": {"enabled": True},  # master flag, but no per-type flag
        "media_players": [{"entity_id": "media_player.kitchen", "tts_entity_id": "tts.google"}],
    }
    manager = TTSTriggerManager(
        hass=SimpleNamespace(),
        get_config=lambda: config,
        get_weather_data=lambda: {"configured": True},
        refresh_weather_data=None,
    )

    with patch.object(
        manager, "_setup_time_based_trigger", new=AsyncMock()
    ) as mock_setup:
        import asyncio

        asyncio.run(manager.async_setup())

    mock_setup.assert_not_awaited()


def test_sun_alerts_setup_uses_filtered_player_list():
    """Regression: sun alerts must use media_players_with_tts() (same as the
    scheduled forecast path), not the raw media_players list. A player
    missing tts_entity_id should cause setup to skip, not silently attempt
    a broken call."""
    from unittest.mock import AsyncMock, patch

    from custom_components.home_weather.tts_triggers import TTSTriggerManager

    # One player without a tts_entity_id (would be dropped by the filter).
    config = {
        "sun_alerts": {"enabled": True},
        "media_players": [{"entity_id": "media_player.kitchen", "tts_entity_id": ""}],
    }
    manager = TTSTriggerManager(
        hass=SimpleNamespace(),
        get_config=lambda: config,
        get_weather_data=lambda: {"configured": True},
        refresh_weather_data=None,
    )

    with patch(
        "custom_components.home_weather.tts_triggers.async_track_time_interval",
        new=AsyncMock(),
    ) as mock_track:
        import asyncio

        asyncio.run(manager._setup_sun_alerts_trigger(config))

    # No time interval registered because no player has TTS configured.
    mock_track.assert_not_called()


