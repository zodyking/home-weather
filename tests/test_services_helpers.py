"""Unit tests for WebSocket service helpers."""
from __future__ import annotations

from custom_components.home_weather.services import (
    _ensure_tts_enabled_for_triggers,
    _media_players_with_tts,
)


def test_ensure_tts_enabled_for_triggers_auto_enables():
    config = {
        "tts": {
            "enabled": False,
            "enable_time_based": True,
        }
    }
    updated = _ensure_tts_enabled_for_triggers(config)
    assert updated["tts"]["enabled"] is True


def test_ensure_tts_enabled_for_triggers_leaves_disabled_when_nothing_on():
    config = {"tts": {"enabled": False}}
    updated = _ensure_tts_enabled_for_triggers(config)
    assert updated["tts"]["enabled"] is False


def test_media_players_with_tts_filters_incomplete_entries():
    players = [
        {"entity_id": "media_player.kitchen", "tts_entity_id": "tts.google"},
        {"entity_id": "media_player.bedroom", "tts_entity_id": ""},
        {"entity_id": "", "tts_entity_id": "tts.google"},
    ]
    result = _media_players_with_tts(players)
    assert result == [{"entity_id": "media_player.kitchen", "tts_entity_id": "tts.google"}]
