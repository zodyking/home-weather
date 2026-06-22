"""Setup helpers for NWS alert sound files in Home Assistant media storage."""
from __future__ import annotations

import logging
import shutil
from pathlib import Path

from homeassistant.core import HomeAssistant

from .const import NWS_SOUNDS_SUBPATH

_LOGGER = logging.getLogger(__name__)

_AUDIO_SUFFIXES = frozenset({".wav", ".mp3", ".ogg", ".flac"})


def get_bundle_sounds_dir() -> Path:
    """Return integration www/sounds bundle path."""
    return Path(__file__).parent / "www" / "sounds"


def get_nws_media_dir(hass: HomeAssistant) -> Path:
    """Return config/media/home_weather/sounds path (media_source local)."""
    return Path(hass.config.path("media")) / Path(NWS_SOUNDS_SUBPATH)


def get_nws_sounds_dir(hass: HomeAssistant) -> Path:
    """Return legacy config/www/home_weather/sounds path."""
    return Path(hass.config.path("www")) / Path(NWS_SOUNDS_SUBPATH)


def normalize_nws_sound_filename(sound_file: str) -> str:
    """Return basename only, stripping legacy path prefixes from stored config."""
    value = (sound_file or "").strip()
    if not value:
        return ""
    prefixes = (
        "media-source://media_source/local/home_weather/sounds/",
        "media-source://media_source/local/",
        "/local/home_weather/sounds/",
        "/media/local/home_weather/sounds/",
        "/media/home_weather/sounds/",
        "home_weather/sounds/",
    )
    lowered = value.replace("\\", "/")
    changed = True
    while changed:
        changed = False
        for prefix in prefixes:
            if lowered.lower().startswith(prefix.lower()):
                lowered = lowered[len(prefix):]
                changed = True
    return Path(lowered).name


def _iter_sound_files(sounds_dir: Path) -> list[str]:
    if not sounds_dir.is_dir():
        return []
    return [
        f.name
        for f in sounds_dir.iterdir()
        if f.is_file() and f.suffix.lower() in _AUDIO_SUFFIXES
    ]


def _sort_sound_files(files: list[str]) -> list[str]:
    return sorted(files, key=lambda name: (0 if name.lower().endswith(".wav") else 1, name.lower()))


def _filter_listed_sounds(files: list[str]) -> list[str]:
    """Prefer .wav over other formats that share the same stem."""
    stems_with_wav = {Path(name).stem.lower() for name in files if name.lower().endswith(".wav")}
    return [
        name
        for name in files
        if name.lower().endswith(".wav") or Path(name).stem.lower() not in stems_with_wav
    ]


def list_nws_sound_files(sounds_dir: Path) -> list[str]:
    """List audio files in a single sounds directory (.wav first)."""
    return _sort_sound_files(_filter_listed_sounds(_iter_sound_files(sounds_dir)))


def list_nws_sounds_merged(hass: HomeAssistant) -> list[str]:
    """List audio files present in config/media/home_weather/sounds/."""
    return list_nws_sound_files(get_nws_media_dir(hass))


def resolve_nws_sound_path(hass: HomeAssistant, sound_file: str) -> Path | None:
    """Resolve a sound filename to disk path (media dir, legacy www, then bundle)."""
    filename = normalize_nws_sound_filename(sound_file)
    if not filename:
        return None
    media_path = get_nws_media_dir(hass) / filename
    if media_path.is_file():
        return media_path
    legacy_path = get_nws_sounds_dir(hass) / filename
    if legacy_path.is_file():
        return legacy_path
    bundle_path = get_bundle_sounds_dir() / filename
    if bundle_path.is_file():
        return bundle_path
    return None


def sound_file_exists(hass: HomeAssistant, sound_file: str) -> bool:
    """Return True if the sound file exists on disk."""
    return resolve_nws_sound_path(hass, sound_file) is not None


def _copy_sound_if_missing(src: Path, dest: Path) -> None:
    if dest.exists():
        return
    try:
        shutil.copy2(src, dest)
        _LOGGER.info("Copied NWS alert sound to %s", dest)
    except OSError as err:
        _LOGGER.warning("Could not copy sound %s: %s", src.name, err)


def _migrate_legacy_www_sounds(hass: HomeAssistant, target: Path) -> None:
    legacy = get_nws_sounds_dir(hass)
    if not legacy.is_dir():
        return
    for name in _iter_sound_files(legacy):
        src = legacy / name
        if src.is_file():
            _copy_sound_if_missing(src, target / name)


def _seed_bundle_sounds(target: Path) -> None:
    bundle = get_bundle_sounds_dir()
    if not bundle.is_dir():
        return

    copied_stems: set[str] = set()
    for src in sorted(bundle.iterdir(), key=lambda p: p.name.lower()):
        if not src.is_file() or src.suffix.lower() not in _AUDIO_SUFFIXES:
            continue
        stem = src.stem.lower()
        if src.suffix.lower() == ".wav":
            copied_stems.add(stem)
        elif stem in copied_stems:
            continue
        if src.suffix.lower() != ".wav" and (bundle / f"{src.stem}.wav").is_file():
            continue
        _copy_sound_if_missing(src, target / src.name)


def ensure_nws_sounds_dir(hass: HomeAssistant) -> Path:
    """Create config/media sounds dir, migrate legacy www files, seed bundled defaults."""
    target = get_nws_media_dir(hass)
    target.mkdir(parents=True, exist_ok=True)
    _migrate_legacy_www_sounds(hass, target)
    _seed_bundle_sounds(target)
    return target
