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
    _extract_tts_platform_from_entity,
    format_active_nws_alerts_for_tts,
    is_chime_tts_available,
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


def _sequenced_hass(states):
    """MagicMock hass whose media player state walks through ``states``."""
    hass = MagicMock()
    counter = {"i": 0}

    def _get(_entity_id):
        i = min(counter["i"], len(states) - 1)
        counter["i"] += 1
        st = MagicMock()
        st.state = states[i]
        return st

    hass.states.get.side_effect = _get
    return hass, counter


def test_wait_for_media_player_idle_waits_for_playback_to_start():
    """Regression: siren wait must not return before the siren actually plays.

    ``media_player.play_media`` returns while the device is still ``idle``, so
    ``wait_for_start`` must hold until playback begins, then until it finishes,
    before the following TTS is sent. Otherwise the TTS races the siren and is
    dropped.
    """
    from unittest.mock import AsyncMock, patch
    import asyncio

    from custom_components.home_weather.tts_notifications import (
        _wait_for_media_player_idle,
    )

    # Just-dispatched idle frames, then the siren plays, then it finishes.
    hass, counter = _sequenced_hass(
        ["idle", "idle", "playing", "playing", "idle"]
    )

    with patch(
        "custom_components.home_weather.tts_notifications.asyncio.sleep",
        new=AsyncMock(),
    ):
        result = asyncio.run(
            _wait_for_media_player_idle(
                hass, "media_player.kitchen", wait_for_start=True, poll_interval=0
            )
        )

    assert result is True
    # Observed the two idle frames, the playing frames, and the final idle.
    assert counter["i"] >= 5


def test_wait_for_media_player_idle_without_start_returns_on_idle():
    """Legacy behaviour (post-TTS waiter) still returns immediately when idle."""
    from unittest.mock import AsyncMock, patch
    import asyncio

    from custom_components.home_weather.tts_notifications import (
        _wait_for_media_player_idle,
    )

    hass, counter = _sequenced_hass(["idle"])

    with patch(
        "custom_components.home_weather.tts_notifications.asyncio.sleep",
        new=AsyncMock(),
    ):
        result = asyncio.run(
            _wait_for_media_player_idle(
                hass, "media_player.kitchen", poll_interval=0
            )
        )

    assert result is True
    assert counter["i"] == 1


def test_is_chime_tts_available_returns_false_when_not_installed():
    """Chime TTS availability check returns False when integration is missing."""
    hass = MagicMock()
    hass.config.components = {"homeassistant", "media_player", "tts"}
    assert is_chime_tts_available(hass) is False


def test_is_chime_tts_available_returns_true_when_installed():
    """Chime TTS availability check returns True when integration is loaded."""
    hass = MagicMock()
    hass.config.components = {"homeassistant", "media_player", "tts", "chime_tts"}
    assert is_chime_tts_available(hass) is True


def test_extract_tts_platform_from_entity():
    """TTS platform extraction handles various entity ID formats."""
    assert _extract_tts_platform_from_entity("tts.google_translate_say") == "google_translate"
    assert _extract_tts_platform_from_entity("tts.piper") == "piper"
    assert _extract_tts_platform_from_entity("tts.cloud_say") == "cloud"
    assert _extract_tts_platform_from_entity("") == ""
    assert _extract_tts_platform_from_entity("custom_platform") == "custom_platform"


def test_dispatch_chime_tts_returns_false_when_not_available():
    """dispatch_chime_tts falls back gracefully when Chime TTS not installed."""
    from unittest.mock import AsyncMock
    import asyncio

    from custom_components.home_weather.tts_notifications import dispatch_chime_tts

    hass = MagicMock()
    hass.config.components = {"homeassistant", "media_player", "tts"}

    result = asyncio.run(
        dispatch_chime_tts(
            hass,
            "media_player.kitchen",
            "tts.google_translate_say",
            "Test message",
            "/local/home_weather/sounds/siren.mp3",
        )
    )

    assert result is False


def test_play_hazard_alert_uses_legacy_when_chime_not_installed():
    """Hazard alert uses legacy siren + TTS when Chime TTS is not installed."""
    from unittest.mock import AsyncMock, patch
    import asyncio

    from custom_components.home_weather.tts_notifications import play_hazard_alert_notification

    hass = MagicMock()
    hass.config.components = {"homeassistant", "media_player", "tts"}  # No chime_tts
    players = [{"entity_id": "media_player.kitchen", "tts_entity_id": "tts.google"}]
    config = {
        "tropical_alerts": {"tts_volume": 0.9, "sound_file": "siren.mp3"},
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


def test_play_hazard_alert_auto_uses_chime_tts_when_installed():
    """Hazard alert automatically uses Chime TTS when installed."""
    from unittest.mock import AsyncMock, patch
    import asyncio

    from custom_components.home_weather.tts_notifications import play_hazard_alert_notification

    hass = MagicMock()
    hass.config.components = {"homeassistant", "media_player", "tts", "chime_tts"}
    players = [{"entity_id": "media_player.kitchen", "tts_entity_id": "tts.google_translate_say"}]
    config = {
        "tropical_alerts": {"tts_volume": 0.9, "sound_file": "siren.mp3"},
        "tts": {},
    }
    chime_called = []

    async def _chime(*args, **kwargs):
        chime_called.append(True)
        return True

    async def _siren(*_args, **_kwargs):
        raise AssertionError("Legacy siren should not be called")

    with patch(
        "custom_components.home_weather.tts_notifications.dispatch_chime_tts",
        new=AsyncMock(side_effect=_chime),
    ), patch(
        "custom_components.home_weather.tts_notifications.play_hazard_siren",
        new=AsyncMock(side_effect=_siren),
    ), patch(
        "custom_components.home_weather.tts_notifications.apply_ai_rewrite",
        new=AsyncMock(side_effect=lambda _h, _c, msg, **_kw: msg),
    ):
        asyncio.run(
            play_hazard_alert_notification(
                hass, config, "tropical_alerts", "Storm alert.", players,
            )
        )

    assert chime_called == [True]


def test_play_hazard_alert_falls_back_on_chime_failure():
    """Hazard alert falls back to legacy when Chime TTS fails."""
    from unittest.mock import AsyncMock, patch
    import asyncio

    from custom_components.home_weather.tts_notifications import play_hazard_alert_notification

    hass = MagicMock()
    hass.config.components = {"homeassistant", "media_player", "tts", "chime_tts"}
    hass.services = MagicMock()
    hass.services.async_call = AsyncMock()
    players = [{"entity_id": "media_player.kitchen", "tts_entity_id": "tts.google_translate_say"}]
    config = {
        "tropical_alerts": {"tts_volume": 0.9, "sound_file": "siren.mp3"},
        "tts": {},
    }
    fallback_order: list[str] = []

    async def _chime_fails(*args, **kwargs):
        return False

    async def _legacy_fallback(*args, **kwargs):
        fallback_order.append("legacy_fallback")

    with patch(
        "custom_components.home_weather.tts_notifications.dispatch_chime_tts",
        new=AsyncMock(side_effect=_chime_fails),
    ), patch(
        "custom_components.home_weather.tts_notifications._legacy_hazard_alert_single_player",
        new=AsyncMock(side_effect=_legacy_fallback),
    ), patch(
        "custom_components.home_weather.tts_notifications.apply_ai_rewrite",
        new=AsyncMock(side_effect=lambda _h, _c, msg, **_kw: msg),
    ):
        asyncio.run(
            play_hazard_alert_notification(
                hass, config, "tropical_alerts", "Storm alert.", players,
            )
        )

    assert fallback_order == ["legacy_fallback"]
