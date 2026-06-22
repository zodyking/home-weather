"""Unit tests for NWS siren playback and replay helpers."""
from __future__ import annotations

from custom_components.home_weather.sounds_setup import list_nws_sound_files
from custom_components.home_weather.tts_notifications import (
    format_active_nws_alerts_for_tts,
    nws_media_playback,
)

RIP_CURRENT = {
    "event": "Rip Current Statement",
    "description": (
        "* WHAT...Dangerous rip currents expected.\n\n"
        "* WHERE...Kings (Brooklyn), Southwest Suffolk.\n\n"
        "* WHEN...From Monday afternoon through Monday evening."
    ),
}

FLOOD = {
    "event": "Flood Watch",
    "description": "* WHAT...Flooding caused by excessive rainfall is possible.",
}


def test_nws_media_playback_wav_uri_and_mime():
    media_id, media_type = nws_media_playback("weather-warning.wav")
    assert media_id == "media-source://media_source/local/home_weather/sounds/weather-warning.wav"
    assert media_type == "audio/x-wav"


def test_nws_media_playback_mp3_mime():
    _, media_type = nws_media_playback("alert.mp3")
    assert media_type == "audio/mpeg"


def test_nws_media_playback_strips_leading_slash():
    media_id, _ = nws_media_playback("/weather-warning.wav")
    assert media_id.endswith("home_weather/sounds/weather-warning.wav")


def test_format_active_nws_alerts_single_delegates():
    result = format_active_nws_alerts_for_tts([RIP_CURRENT])
    assert "Rip Current Statement" in result
    assert "Dangerous rip currents expected" in result


def test_format_active_nws_alerts_combined_summary():
    result = format_active_nws_alerts_for_tts([RIP_CURRENT, FLOOD])
    assert "2 active weather alerts" in result
    assert "Rip Current Statement" in result
    assert "Flood Watch" in result
    assert "What:" not in result


def test_list_nws_sound_files_prefers_wav(tmp_path):
    (tmp_path / "alert.mp3").write_bytes(b"x")
    (tmp_path / "siren.wav").write_bytes(b"x")
    (tmp_path / "other.ogg").write_bytes(b"x")
    files = list_nws_sound_files(tmp_path)
    assert files[0] == "siren.wav"
    assert set(files) == {"siren.wav", "alert.mp3", "other.ogg"}


def test_bootstrap_logic_documentation():
    """Bootstrap should seed known IDs without firing on first poll."""
    known: set[str] = set()
    active_ids = {"a1", "a2"}
    bootstrap = True
    fired: list[str] = []

    for aid in active_ids:
        if not bootstrap and aid not in known:
            fired.append(aid)
            known.add(aid)

    if bootstrap:
        known.update(active_ids)

    assert fired == []
    assert known == active_ids

    bootstrap = False
    active_ids.add("a3")
    for aid in active_ids:
        if not bootstrap and aid not in known:
            fired.append(aid)
            known.add(aid)

    assert fired == ["a3"]
