"""Setup helpers for NWS alert sound files in Home Assistant www storage."""
from __future__ import annotations

import logging
import shutil
from pathlib import Path

from homeassistant.core import HomeAssistant

from .const import NWS_SOUNDS_SUBPATH

_LOGGER = logging.getLogger(__name__)

_SOUND_SUFFIXES = (".mp3", ".wav")


def get_bundle_sounds_dir() -> Path:
    """Return integration www/sounds bundle path."""
    return Path(__file__).parent / "www" / "sounds"


def get_nws_sounds_dir(hass: HomeAssistant) -> Path:
    """Return config/www/home_weather/sounds path (served at /local/)."""
    return Path(hass.config.path("www")) / Path(NWS_SOUNDS_SUBPATH)


def _get_legacy_media_dir(hass: HomeAssistant) -> Path:
    """Return old config/media/home_weather/sounds path for one-time migration."""
    return Path(hass.config.path("media")) / Path(NWS_SOUNDS_SUBPATH)


def normalize_nws_sound_filename(sound_file: str) -> str:
    """Return basename only, stripping legacy path prefixes from stored config."""
    value = (sound_file or "").strip()
    if not value:
        return ""
    prefixes = (
        "media-source://media_source/local/home_weather/sounds/",
        "media-source://media_source/home_weather/sounds/",
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


def _is_sound_file(path: Path) -> bool:
    return path.is_file() and path.suffix.lower() in _SOUND_SUFFIXES


def _iter_sound_files(sounds_dir: Path) -> list[str]:
    if not sounds_dir.is_dir():
        return []
    return [f.name for f in sounds_dir.iterdir() if _is_sound_file(f)]


def _collect_stem_matches(stem: str, *dirs: Path) -> list[Path]:
    """Collect all sound files matching stem across directories."""
    stem_lower = stem.lower()
    matches: list[Path] = []
    for sounds_dir in dirs:
        if not sounds_dir.is_dir():
            continue
        for name in _iter_sound_files(sounds_dir):
            if Path(name).stem.lower() == stem_lower:
                matches.append(sounds_dir / name)
    return matches


def _pick_preferred_sound(matches: list[Path]) -> Path | None:
    """Pick best sound path, preferring .mp3 over .wav."""
    if not matches:
        return None

    def suffix_rank(path: Path) -> int:
        try:
            return _SOUND_SUFFIXES.index(path.suffix.lower())
        except ValueError:
            return len(_SOUND_SUFFIXES)

    return min(matches, key=suffix_rank)


def _find_sound_by_stem(sounds_dir: Path, stem: str) -> Path | None:
    """Return best match for stem in one directory, preferring .mp3 over .wav."""
    return _pick_preferred_sound(_collect_stem_matches(stem, sounds_dir))


def list_nws_wav_files(sounds_dir: Path) -> list[str]:
    """List playable sound files (.mp3 and .wav) in a single sounds directory."""
    return sorted(_iter_sound_files(sounds_dir), key=str.lower)


def list_nws_sounds_merged(hass: HomeAssistant) -> list[str]:
    """List sound files present in config/www/home_weather/sounds/."""
    return list_nws_wav_files(get_nws_sounds_dir(hass))


def resolve_nws_sound_path(hass: HomeAssistant, sound_file: str) -> Path | None:
    """Resolve a sound filename to disk path (www dir, then bundle). Prefers .mp3."""
    filename = normalize_nws_sound_filename(sound_file)
    if not filename:
        return None

    www_dir = get_nws_sounds_dir(hass)
    bundle_dir = get_bundle_sounds_dir()
    stem = Path(filename).stem
    match = _pick_preferred_sound(_collect_stem_matches(stem, www_dir, bundle_dir))
    if match:
        return match

    direct = bundle_dir / filename
    if direct.is_file():
        return direct
    return None


def resolve_nws_playable_sound(hass: HomeAssistant, sound_file: str) -> Path | None:
    """Return a sound file ready for /local/ playback under config/www. Prefers .mp3."""
    ensure_nws_sounds_dir(hass)
    filename = normalize_nws_sound_filename(sound_file)
    if not filename:
        return None

    www_dir = get_nws_sounds_dir(hass)
    bundle_dir = get_bundle_sounds_dir()
    stem = Path(filename).stem
    match = _pick_preferred_sound(_collect_stem_matches(stem, www_dir, bundle_dir))
    if match and match.parent.resolve() == www_dir.resolve():
        return match

    source = resolve_nws_sound_path(hass, filename)
    if not source or not source.is_file():
        return None

    dest = www_dir / source.name
    if source.resolve() != dest.resolve():
        try:
            shutil.copy2(source, dest)
            _LOGGER.info("Copied NWS alert sound to %s", dest)
        except OSError as err:
            _LOGGER.warning("Could not copy sound %s: %s", source.name, err)
            return None
    return dest if dest.is_file() else None


def build_nws_local_media_id(filename: str) -> str:
    """Return /local/ media_content_id for an NWS siren file."""
    return f"/local/{NWS_SOUNDS_SUBPATH}/{filename}"


def sound_file_exists(hass: HomeAssistant, sound_file: str) -> bool:
    """Return True if the sound can be played from config/www."""
    return resolve_nws_playable_sound(hass, sound_file) is not None


def _copy_sound_if_missing(src: Path, dest: Path) -> None:
    if dest.exists():
        return
    try:
        shutil.copy2(src, dest)
        _LOGGER.info("Copied NWS alert sound to %s", dest)
    except OSError as err:
        _LOGGER.warning("Could not copy sound %s: %s", src.name, err)


def _seed_bundle_sounds(target: Path) -> None:
    bundle = get_bundle_sounds_dir()
    if not bundle.is_dir():
        return
    for src in sorted(bundle.iterdir(), key=lambda p: p.name.lower()):
        if _is_sound_file(src):
            _copy_sound_if_missing(src, target / src.name)


def _migrate_legacy_media_sounds(hass: HomeAssistant, target: Path) -> None:
    legacy_media = _get_legacy_media_dir(hass)
    if not legacy_media.is_dir():
        return
    for name in _iter_sound_files(legacy_media):
        _copy_sound_if_missing(legacy_media / name, target / name)


def ensure_nws_sounds_dir(hass: HomeAssistant) -> Path:
    """Create config/www sounds dir and copy bundled default sound files."""
    target = get_nws_sounds_dir(hass)
    target.mkdir(parents=True, exist_ok=True)
    _migrate_legacy_media_sounds(hass, target)
    _seed_bundle_sounds(target)
    return target
