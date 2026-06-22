"""Unit tests for NWS siren playback and replay helpers."""
from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

from custom_components.home_weather.sounds_setup import (
    get_nws_media_dir,
    list_nws_sound_files,
    list_nws_sounds_merged,
    normalize_nws_sound_filename,
    resolve_nws_sound_path,
)
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
    assert media_type == "music"


def test_nws_media_playback_mp3_mime():
    media_id, media_type = nws_media_playback("alert.mp3")
    assert media_id == "media-source://media_source/local/home_weather/sounds/alert.mp3"
    assert media_type == "music"


def test_nws_media_playback_encodes_spaces():
    media_id, _ = nws_media_playback("weather warning 1.wav")
    assert media_id == "media-source://media_source/local/home_weather/sounds/weather%20warning%201.wav"


def test_normalize_nws_sound_filename_strips_media_prefix():
    assert normalize_nws_sound_filename("/media/home_weather/sounds/foo.wav") == "foo.wav"


def test_normalize_nws_sound_filename_strips_local_prefix():
    assert normalize_nws_sound_filename("/local/home_weather/sounds/foo.wav") == "foo.wav"


def test_normalize_nws_sound_filename_strips_media_source_uri():
    value = "media-source://media_source/local/home_weather/sounds/foo.wav"
    assert normalize_nws_sound_filename(value) == "foo.wav"


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


def test_list_nws_sound_files_hides_mp3_when_wav_exists(tmp_path):
    (tmp_path / "alert.mp3").write_bytes(b"x")
    (tmp_path / "alert.wav").write_bytes(b"y")
    files = list_nws_sound_files(tmp_path)
    assert files == ["alert.wav"]


def test_resolve_nws_sound_path_prefers_media_dir(tmp_path, monkeypatch):
    bundle = tmp_path / "bundle"
    media_dir = tmp_path / "media" / "home_weather" / "sounds"
    legacy_www = tmp_path / "www" / "home_weather" / "sounds"
    bundle.mkdir(parents=True)
    media_dir.mkdir(parents=True)
    legacy_www.mkdir(parents=True)
    (bundle / "alert.wav").write_bytes(b"x")
    (media_dir / "alert.wav").write_bytes(b"y")
    (legacy_www / "alert.wav").write_bytes(b"z")

    hass = MagicMock()
    hass.config.path.side_effect = lambda key: str(tmp_path / key)

    monkeypatch.setattr(
        "custom_components.home_weather.sounds_setup.get_bundle_sounds_dir",
        lambda: bundle,
    )

    resolved = resolve_nws_sound_path(hass, "alert.wav")
    assert resolved == media_dir / "alert.wav"


def test_resolve_nws_sound_path_falls_back_to_legacy_www(tmp_path, monkeypatch):
    bundle = tmp_path / "bundle"
    legacy_www = tmp_path / "www" / "home_weather" / "sounds"
    bundle.mkdir(parents=True)
    legacy_www.mkdir(parents=True)
    (legacy_www / "alert.wav").write_bytes(b"x")

    hass = MagicMock()
    hass.config.path.side_effect = lambda key: str(tmp_path / key)

    monkeypatch.setattr(
        "custom_components.home_weather.sounds_setup.get_bundle_sounds_dir",
        lambda: bundle,
    )

    resolved = resolve_nws_sound_path(hass, "/local/home_weather/sounds/alert.wav")
    assert resolved == legacy_www / "alert.wav"


def test_resolve_nws_sound_path_falls_back_to_bundle(tmp_path, monkeypatch):
    bundle = tmp_path / "bundle"
    media_dir = tmp_path / "media" / "home_weather" / "sounds"
    bundle.mkdir(parents=True)
    media_dir.mkdir(parents=True)
    (bundle / "alert.wav").write_bytes(b"x")

    hass = MagicMock()
    hass.config.path.side_effect = lambda key: str(tmp_path / key)

    monkeypatch.setattr(
        "custom_components.home_weather.sounds_setup.get_bundle_sounds_dir",
        lambda: bundle,
    )

    resolved = resolve_nws_sound_path(hass, "/media/home_weather/sounds/alert.wav")
    assert resolved == bundle / "alert.wav"


def test_list_nws_sounds_merged_lists_media_dir_only(tmp_path, monkeypatch):
    bundle = tmp_path / "bundle"
    media_dir = tmp_path / "media" / "home_weather" / "sounds"
    legacy_www = tmp_path / "www" / "home_weather" / "sounds"
    bundle.mkdir(parents=True)
    media_dir.mkdir(parents=True)
    legacy_www.mkdir(parents=True)
    (bundle / "one.wav").write_bytes(b"x")
    (bundle / "two.wav").write_bytes(b"x")
    (legacy_www / "legacy-only.wav").write_bytes(b"x")
    (media_dir / "two.wav").write_bytes(b"y")
    (media_dir / "three.wav").write_bytes(b"z")

    hass = MagicMock()
    hass.config.path.side_effect = lambda key: str(tmp_path / key)

    monkeypatch.setattr(
        "custom_components.home_weather.sounds_setup.get_bundle_sounds_dir",
        lambda: bundle,
    )

    files = list_nws_sounds_merged(hass)
    assert files == ["three.wav", "two.wav"]
    assert get_nws_media_dir(hass) == media_dir


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
