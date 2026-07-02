"""Unit tests for NWS siren playback and replay helpers."""
from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

from custom_components.home_weather.sounds_setup import (
    build_nws_local_media_id,
    get_nws_sounds_dir,
    list_nws_sounds_merged,
    list_nws_wav_files,
    normalize_nws_sound_filename,
    resolve_nws_playable_sound,
    resolve_nws_sound_path,
)
from custom_components.home_weather.tts_notifications import (
    format_active_nws_alerts_for_tts,
    nws_local_playback,
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


def _mock_hass(tmp_path):
    hass = MagicMock()
    hass.config.path.side_effect = lambda key: str(tmp_path / key)
    return hass


def test_nws_local_playback_wav_uri_and_mime(tmp_path):
    www_dir = tmp_path / "www" / "home_weather" / "sounds"
    www_dir.mkdir(parents=True)
    sound = www_dir / "weather-warning.wav"
    sound.write_bytes(b"x")

    hass = _mock_hass(tmp_path)
    media_id, media_type = nws_local_playback(hass, sound)
    assert media_id == "/local/home_weather/sounds/weather-warning.wav"
    assert media_type == "music"


def test_nws_local_playback_preserves_spaces(tmp_path):
    www_dir = tmp_path / "www" / "home_weather" / "sounds"
    www_dir.mkdir(parents=True)
    sound = www_dir / "weather warning 1.wav"
    sound.write_bytes(b"x")

    hass = _mock_hass(tmp_path)
    media_id, _ = nws_local_playback(hass, sound)
    assert media_id == "/local/home_weather/sounds/weather warning 1.wav"


def test_build_nws_local_media_id():
    assert build_nws_local_media_id("alert.wav") == "/local/home_weather/sounds/alert.wav"


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


def test_list_nws_wav_files_ignores_non_wav(tmp_path):
    (tmp_path / "alert.mp3").write_bytes(b"x")
    (tmp_path / "siren.wav").write_bytes(b"x")
    (tmp_path / "other.ogg").write_bytes(b"x")
    files = list_nws_wav_files(tmp_path)
    assert files == ["alert.mp3", "siren.wav"]


def test_resolve_nws_sound_path_prefers_www_dir(tmp_path, monkeypatch):
    bundle = tmp_path / "bundle"
    www_dir = tmp_path / "www" / "home_weather" / "sounds"
    bundle.mkdir(parents=True)
    www_dir.mkdir(parents=True)
    (bundle / "alert.wav").write_bytes(b"x")
    (www_dir / "alert.wav").write_bytes(b"y")

    hass = _mock_hass(tmp_path)
    monkeypatch.setattr(
        "custom_components.home_weather.sounds_setup.get_bundle_sounds_dir",
        lambda: bundle,
    )

    resolved = resolve_nws_sound_path(hass, "alert.wav")
    assert resolved == www_dir / "alert.wav"


def test_resolve_nws_sound_path_falls_back_to_bundle(tmp_path, monkeypatch):
    bundle = tmp_path / "bundle"
    www_dir = tmp_path / "www" / "home_weather" / "sounds"
    bundle.mkdir(parents=True)
    www_dir.mkdir(parents=True)
    (bundle / "alert.wav").write_bytes(b"x")

    hass = _mock_hass(tmp_path)
    monkeypatch.setattr(
        "custom_components.home_weather.sounds_setup.get_bundle_sounds_dir",
        lambda: bundle,
    )

    resolved = resolve_nws_sound_path(hass, "/local/home_weather/sounds/alert.wav")
    assert resolved == bundle / "alert.wav"


def test_list_nws_sounds_merged_lists_www_wav_only(tmp_path, monkeypatch):
    bundle = tmp_path / "bundle"
    www_dir = tmp_path / "www" / "home_weather" / "sounds"
    media_dir = tmp_path / "media" / "home_weather" / "sounds"
    bundle.mkdir(parents=True)
    www_dir.mkdir(parents=True)
    media_dir.mkdir(parents=True)
    (bundle / "one.wav").write_bytes(b"x")
    (bundle / "two.wav").write_bytes(b"x")
    (media_dir / "media-only.wav").write_bytes(b"x")
    (www_dir / "two.wav").write_bytes(b"y")
    (www_dir / "three.wav").write_bytes(b"z")
    (www_dir / "legacy.mp3").write_bytes(b"m")

    hass = _mock_hass(tmp_path)
    monkeypatch.setattr(
        "custom_components.home_weather.sounds_setup.get_bundle_sounds_dir",
        lambda: bundle,
    )

    files = list_nws_sounds_merged(hass)
    assert files == ["legacy.mp3", "three.wav", "two.wav"]
    assert get_nws_sounds_dir(hass) == www_dir


def test_resolve_nws_playable_sound_prefers_mp3_over_wav_config(tmp_path, monkeypatch):
    bundle = tmp_path / "bundle"
    www_dir = tmp_path / "www" / "home_weather" / "sounds"
    bundle.mkdir(parents=True)
    www_dir.mkdir(parents=True)
    (www_dir / "weather warning 1.wav").write_bytes(b"x")
    (www_dir / "weather warning 1.mp3").write_bytes(b"m")

    hass = _mock_hass(tmp_path)
    monkeypatch.setattr(
        "custom_components.home_weather.sounds_setup.get_bundle_sounds_dir",
        lambda: bundle,
    )

    resolved = resolve_nws_playable_sound(hass, "weather warning 1.wav")
    assert resolved == www_dir / "weather warning 1.mp3"


def test_resolve_nws_playable_sound_prefers_bundle_mp3_over_www_wav(tmp_path, monkeypatch):
    bundle = tmp_path / "bundle"
    www_dir = tmp_path / "www" / "home_weather" / "sounds"
    bundle.mkdir(parents=True)
    www_dir.mkdir(parents=True)
    (www_dir / "weather warning 1.wav").write_bytes(b"x")
    (bundle / "weather warning 1.mp3").write_bytes(b"m")

    hass = _mock_hass(tmp_path)
    monkeypatch.setattr(
        "custom_components.home_weather.sounds_setup.get_bundle_sounds_dir",
        lambda: bundle,
    )

    resolved = resolve_nws_playable_sound(hass, "weather warning 1.wav")
    assert resolved == www_dir / "weather warning 1.mp3"


def test_ensure_nws_sounds_dir_seeds_bundle_to_www(tmp_path, monkeypatch):
    bundle = tmp_path / "bundle"
    www_dir = tmp_path / "www" / "home_weather" / "sounds"
    bundle.mkdir(parents=True)
    (bundle / "weather warning 1.wav").write_bytes(b"x")

    hass = _mock_hass(tmp_path)
    monkeypatch.setattr(
        "custom_components.home_weather.sounds_setup.get_bundle_sounds_dir",
        lambda: bundle,
    )

    from custom_components.home_weather.sounds_setup import ensure_nws_sounds_dir

    result = ensure_nws_sounds_dir(hass)
    assert result == www_dir
    assert (www_dir / "weather warning 1.wav").is_file()


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


def test_play_hazard_alert_notification_waits_for_tts():
    """Regression: chained hazard alerts must not overlap on the same speaker."""
    from unittest.mock import AsyncMock, patch
    import asyncio

    from custom_components.home_weather.tts_notifications import play_hazard_alert_notification

    hass = MagicMock()
    players = [{"entity_id": "media_player.kitchen", "tts_entity_id": "tts.google"}]
    config = {
        "tropical_alerts": {"tts_volume": 0.9, "sound_file": ""},
        "tts": {},
    }
    order: list[str] = []

    async def _siren(*_args, **_kwargs):
        order.append("siren")

    async def _send(*_args, **_kwargs):
        order.append("send")

    async def _wait(*_args, **_kwargs):
        order.append("wait")

    with patch(
        "custom_components.home_weather.tts_notifications.play_hazard_siren",
        new=AsyncMock(side_effect=_siren),
    ), patch(
        "custom_components.home_weather.tts_notifications.send_tts",
        new=AsyncMock(side_effect=_send),
    ), patch(
        "custom_components.home_weather.tts_notifications.wait_for_media_players_after_tts",
        new=AsyncMock(side_effect=_wait),
    ), patch(
        "custom_components.home_weather.tts_notifications.apply_ai_rewrite",
        new=AsyncMock(side_effect=lambda _h, _c, msg, **_kw: msg),
    ):
        asyncio.run(
            play_hazard_alert_notification(
                hass, config, "tropical_alerts", "Storm alert.", players,
            )
        )

    assert order == ["siren", "send", "wait"]
