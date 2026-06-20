"""Unit tests for WebSocket service helpers."""
from __future__ import annotations

from custom_components.home_weather.services import media_players_with_tts


def test_media_players_with_tts_filters_incomplete_entries():
    players = [
        {"entity_id": "media_player.kitchen", "tts_entity_id": "tts.google"},
        {"entity_id": "media_player.bedroom", "tts_entity_id": ""},
        {"entity_id": "", "tts_entity_id": "tts.google"},
    ]
    result = media_players_with_tts(players)
    assert result == [{"entity_id": "media_player.kitchen", "tts_entity_id": "tts.google"}]


def test_media_players_with_tts_imported_from_tts_triggers():
    """The helper lives in tts_triggers; services re-exports it under the
    public (no-underscore) name so callers share one implementation."""
    from custom_components.home_weather import services, tts_triggers

    assert services.media_players_with_tts is tts_triggers.media_players_with_tts
