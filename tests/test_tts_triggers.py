"""Unit tests for TTS trigger helpers."""
from __future__ import annotations

from datetime import datetime
from types import SimpleNamespace

from custom_components.home_weather.tts_triggers import (
    _is_alerts_active,
    _is_tts_active,
    build_weather_data_from_state,
    compute_trigger_hours,
    extract_weather_condition,
    media_players_with_tts,
    normalize_days_of_week,
    should_fire_scheduled_forecast,
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


def test_compute_trigger_hours_supports_overnight_window():
    assert compute_trigger_hours(22, 6, 2) == [0, 2, 4, 6, 22]


def test_normalize_days_of_week_accepts_numeric_values():
    assert normalize_days_of_week([0, 2, 4]) == {0, 2, 4}


def test_should_fire_scheduled_forecast_matches_configured_slot():
    now = datetime(2026, 7, 30, 11, 3)
    config = {
        "enable_time_based": True,
        "hour_pattern": 3,
        "minute_offset": 3,
        "start_time": "08:00",
        "end_time": "21:00",
        "days_of_week": ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
    }
    assert should_fire_scheduled_forecast(now, config) is True


def test_should_fire_scheduled_forecast_skips_wrong_minute():
    now = datetime(2026, 7, 30, 11, 4)
    config = {
        "enable_time_based": True,
        "hour_pattern": 3,
        "minute_offset": 3,
        "start_time": "08:00",
        "end_time": "21:00",
        "days_of_week": ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
    }
    assert should_fire_scheduled_forecast(now, config) is False


def test_should_fire_scheduled_forecast_skips_when_disabled():
    now = datetime(2026, 7, 30, 11, 3)
    config = {
        "enable_time_based": False,
        "hour_pattern": 3,
        "minute_offset": 3,
        "start_time": "08:00",
        "end_time": "21:00",
        "days_of_week": ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
    }
    assert should_fire_scheduled_forecast(now, config) is False


def test_should_fire_scheduled_forecast_tolerates_null_offsets():
    now = datetime(2026, 7, 30, 8, 3)
    config = {
        "enable_time_based": True,
        "hour_pattern": None,
        "minute_offset": None,
        "start_time": "08:00",
        "end_time": "21:00",
        "days_of_week": ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
    }
    assert should_fire_scheduled_forecast(now, config) is True


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


def test_scheduled_forecast_tick_fires_once_per_minute():
    """Regression: minute polling should fire exactly once per matched slot."""
    from unittest.mock import AsyncMock, patch
    import asyncio

    from custom_components.home_weather.tts_triggers import TTSTriggerManager

    config = {
        "weather_entity": "weather.home",
        "tts": {
            "enable_time_based": True,
            "hour_pattern": 3,
            "minute_offset": 3,
            "start_time": "08:00",
            "end_time": "21:00",
            "days_of_week": ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
        },
        "media_players": [
            {"entity_id": "media_player.kitchen", "tts_entity_id": "tts.google"},
        ],
    }
    manager = TTSTriggerManager(
        hass=SimpleNamespace(),
        get_config=lambda: config,
        get_weather_data=lambda: {"configured": True, "current": {"condition": "sunny"}},
        refresh_weather_data=None,
    )
    now = datetime(2026, 7, 30, 11, 3)

    with patch.object(manager, "_fire_scheduled_forecast", new=AsyncMock()) as mock_fire:
        asyncio.run(manager._check_scheduled_forecast_tick(now))
        asyncio.run(manager._check_scheduled_forecast_tick(now))

    mock_fire.assert_awaited_once()


def test_scheduled_forecast_waits_for_tts_before_nws_replay():
    """Regression: replay must not start until forecast TTS finishes."""
    from unittest.mock import AsyncMock, patch
    import asyncio

    from custom_components.home_weather.tts_triggers import TTSTriggerManager

    config = {
        "weather_entity": "weather.home",
        "tts": {},
        "nws_alerts": {"enabled": True, "replay_on_time_based_forecast": True},
        "media_players": [
            {"entity_id": "media_player.kitchen", "tts_entity_id": "tts.google"},
        ],
    }
    weather = {"configured": True, "current": {"condition": "sunny"}}
    manager = TTSTriggerManager(
        hass=SimpleNamespace(),
        get_config=lambda: config,
        get_weather_data=lambda: weather,
        refresh_weather_data=AsyncMock(return_value=weather),
    )
    order: list[str] = []

    async def _dispatch(*_args, **_kwargs):
        order.append("dispatch")

    async def _replay(*_args, **_kwargs):
        order.append("replay")

    with patch(
        "custom_components.home_weather.tts_triggers.build_scheduled_forecast",
        return_value="Forecast message",
    ), patch(
        "custom_components.home_weather.tts_triggers.dispatch_tts_and_wait",
        new=AsyncMock(side_effect=_dispatch),
    ), patch.object(
        manager, "_maybe_replay_nws_alerts_after_forecast", new=AsyncMock(side_effect=_replay),
    ):
        asyncio.run(manager._fire_scheduled_forecast(refresh_weather=False))

    assert order == ["dispatch", "replay"]


def test_maybe_replay_refreshes_active_alerts_before_replay():
    """Regression: replay should fetch current alerts, not rely on stale cache."""
    from unittest.mock import AsyncMock, patch
    import asyncio

    from custom_components.home_weather.tts_triggers import TTSTriggerManager

    config = {
        "nws_alerts": {"enabled": True, "replay_on_time_based_forecast": True},
        "media_players": [
            {"entity_id": "media_player.kitchen", "tts_entity_id": "tts.google"},
        ],
    }
    manager = TTSTriggerManager(
        hass=SimpleNamespace(),
        get_config=lambda: config,
        get_weather_data=lambda: {"configured": True},
        refresh_weather_data=None,
    )
    manager._nws_active_alerts = []
    refreshed = [{"event": "Flood Watch", "description": "* WHAT...Flooding possible."}]

    async def _refresh(*, notify_new=True):
        assert notify_new is False
        manager._nws_active_alerts = refreshed

    with patch.object(
        manager, "_check_nws_alerts_async", new=AsyncMock(side_effect=_refresh),
    ) as mock_refresh, patch(
        "custom_components.home_weather.tts_triggers.replay_active_nws_alerts",
        new=AsyncMock(),
    ) as mock_replay:
        asyncio.run(
            manager._maybe_replay_nws_alerts_after_forecast(
                config,
                config["media_players"],
            )
        )

    mock_refresh.assert_awaited_once()
    mock_replay.assert_awaited_once()
    replay_alerts = mock_replay.await_args.args[3]
    assert replay_alerts == refreshed

