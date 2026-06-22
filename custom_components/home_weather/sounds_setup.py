"""Setup helpers for NWS alert sound files in Home Assistant www."""
from __future__ import annotations

import logging
import shutil
from pathlib import Path

from homeassistant.core import HomeAssistant

from .const import NWS_SOUNDS_WWW_SUBPATH

_LOGGER = logging.getLogger(__name__)

_AUDIO_SUFFIXES = frozenset({".wav", ".mp3", ".ogg", ".flac"})


def get_nws_sounds_dir(hass: HomeAssistant) -> Path:
    """Return config/www/home_weather/sounds path."""
    return Path(hass.config.path("www")) / Path(NWS_SOUNDS_WWW_SUBPATH)


def ensure_nws_sounds_dir(hass: HomeAssistant) -> Path:
    """Create the NWS sounds directory and copy bundled defaults if missing."""
    target = get_nws_sounds_dir(hass)
    target.mkdir(parents=True, exist_ok=True)

    bundle = Path(__file__).parent / "www" / "sounds"
    if not bundle.is_dir():
        return target

    for src in bundle.iterdir():
        if not src.is_file() or src.suffix.lower() not in _AUDIO_SUFFIXES:
            continue
        dest = target / src.name
        if dest.exists():
            continue
        try:
            shutil.copy2(src, dest)
            _LOGGER.info("Copied default NWS alert sound to %s", dest)
        except OSError as err:
            _LOGGER.warning("Could not copy default sound %s: %s", src.name, err)

    return target


def list_nws_sound_files(sounds_dir: Path) -> list[str]:
    """List audio files in the NWS sounds directory (.wav first)."""
    if not sounds_dir.is_dir():
        return []
    files = [
        f.name
        for f in sounds_dir.iterdir()
        if f.is_file() and f.suffix.lower() in _AUDIO_SUFFIXES
    ]
    return sorted(files, key=lambda name: (0 if name.lower().endswith(".wav") else 1, name.lower()))
